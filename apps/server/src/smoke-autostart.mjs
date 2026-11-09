/**
 * 「开机自启」的验收（2026-10-16；2026-11-09 多机子系统删除后只剩 control-plane 一个目标）。
 *
 * **跨平台的契约**：装了什么、能不能删、幂等、不认的目标要报错、数据目录写死进脚本、
 * status 报的是**已装的那份**而不是按环境变量现算。
 * 平台特有的部分（Windows 的 .vbs/.cmd 与 ASCII 坑、Linux 的 systemd 单元）各按分支验。
 *
 * 为什么强调跨平台：第一版只写了 Windows 分支，拿到 ThinkPad（Linux）上一跑 5 项红 ——
 * 不是代码坏了，是**用例假设了平台**。用例只在一个平台成立，就等于没验另一个平台。
 *
 * 隔离：全部写进临时目录（`home` / `dataDir` 指过去）。Linux 上它仍会调 `systemctl --user`
 * —— 但单元写在**临时 home** 里，systemd 扫不到，于是 `enable` 会失败、并作为 `warn` 报出来：
 * 这正是我们要的行为（**不假装成功**），所以用例照跑，真机上的 enable/linger 另外手工验
 * （见 deploy/README 第五之二节）。
 * 跑法：node apps/server/src/smoke-autostart.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as autostart from './autostart.mjs';

const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-autostart-'));
const HOME = path.join(tmp, 'home');
const DATA = path.join(tmp, 'data');
fs.mkdirSync(HOME, { recursive: true });
/*
 * ⚠️ `noSystem: true` 是**必须的**（2026-10-16 踩到）：单元名是固定的 `bandi-control-plane.service`，
 * 用例里一跑 `systemctl --user disable --now bandi-control-plane`，就会把**这台机器上真正在跑的服务停掉** ——
 * 验证代码顺手把生产环境改了。开了这个开关，用例只生成文件，不碰系统。
 */
const opt = { home: HOME, dataDir: DATA, repoRoot: process.cwd(), nodeBin: process.execPath, noSystem: true };

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
const nonAscii = (p) => [...fs.readFileSync(p)].filter((b) => b > 127).length;

/* 各平台"装完之后东西在哪" —— 验的地方不一样，判据也不一样 */
const unitPath = (id) => path.join(HOME, '.config', 'systemd', 'user', `bandi-${id}.service`);
const cronScript = (id) => path.join(DATA, 'autostart', `${id}.sh`);
const winCmd = (id) => path.join(DATA, 'autostart', `${id}.cmd`);
const winVbs = (id) =>
  path.join(HOME, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `bandi-${id}.vbs`);
const macPlist = (id) => path.join(HOME, 'Library', 'LaunchAgents', `app.local.bandi.${id}.plist`);

/** 带环境变量的那份文件（各平台不同）—— 内容断言都从它读 */
function contentOf(id, backend) {
  if (WIN) return read(winCmd(id));
  if (MAC) return read(macPlist(id));
  return backend === 'systemd-user' ? read(unitPath(id)) : read(cronScript(id));
}

const crontabHas = (id) => {
  try {
    return String(execFileSync('crontab', ['-l'], { encoding: 'utf8' })).includes(`bandi-autostart ${id}`);
  } catch {
    return false;
  }
};

try {
  console.log(`平台 ${process.platform} · 用例按分支验（Windows/Linux/macOS 各是各的判据）\n`);

  console.log('① 装之前：什么都没装');
  let st = autostart.status(opt);
  check('状态报"未装"', st.targets.every((t) => !t.installed), st.targets.map((t) => `${t.id}=${t.installed}`).join(' '));
  check('说清了走哪种方式', !!st.backend, st.backend);
  check('目标清单只剩 control-plane（节点自启随多机子系统删了）',
    autostart.TARGETS.length === 1 && autostart.TARGETS[0] === 'control-plane', autostart.TARGETS.join(','));

  console.log('\n② 装目标（all = control-plane 一份）');
  const done = autostart.install('all', opt);
  check('装了', done.length === 1 && done[0].id === 'control-plane', done.map((d) => d.id).join(','));
  st = autostart.status(opt);
  check('status 也认（installed）', st.targets.every((t) => t.installed), st.targets.map((t) => `${t.id}=${t.installed}`).join(' '));
  check('给出了装在哪', st.targets.every((t) => t.where && t.where.length > 5), st.targets[0].where);
  // 文件层面的存在性：按后端分支
  if (WIN) {
    check('.cmd 在', fs.existsSync(winCmd('control-plane')));
    check('.vbs 进了 Startup', fs.existsSync(winVbs('control-plane')));
  } else if (MAC) {
    check('plist 在', fs.existsSync(macPlist('control-plane')));
  } else if (st.backend === 'systemd-user') {
    check('systemd 单元在', fs.existsSync(unitPath('control-plane')));
  } else {
    check('crontab 兜底脚本在', fs.existsSync(cronScript('control-plane')));
    check('crontab 里有一条', crontabHas('control-plane'));
  }

  console.log('\n③ 内容：路径、环境、重启策略');
  const cpText = contentOf('control-plane', st.backend);
  check('指向这台机器的 node', cpText.includes(process.execPath));
  check('入口是本仓的 start.mjs', cpText.includes('start.mjs'));
  /*
   * ⚠️ **数据目录必须写死进脚本**（2026-10-16 修的真 bug）：不写的话自启那份控制面
   * 会落回仓库默认 data/，与桌面壳的目录分裂成两个实例、两个库。
   */
  const dataLine = (cpText.match(/BANDI_DATA=.*/) ?? [''])[0];
  check('数据目录写死为传入的那份（不是仓库默认）', cpText.includes(`BANDI_DATA=${DATA}`), dataLine.trim());
  if (WIN) {
    check('控制面那条带 BANDI_NO_BROWSER=1（开机别弹浏览器）', cpText.includes('BANDI_NO_BROWSER=1'));
  } else if (st.backend === 'systemd-user') {
    check('systemd 单元有 Restart=always（崩了自己回来）', /Restart=always/.test(cpText));
    check('systemd 单元有 RestartSec', /RestartSec=\d+/.test(cpText));
    check('控制面那条带 BANDI_NO_BROWSER=1', cpText.includes('BANDI_NO_BROWSER=1'));
  }

  /*
   * ⚠️ **纯 ASCII 只有 Windows 需要**（wscript / cmd 按系统 ANSI 页读脚本，中文注释会把换行吃掉，
   * `Set sh = ...` 变成注释 → 自启静默失效）。Linux/macOS 的单元与 plist 是 UTF-8，别乱套。
   */
  if (WIN) {
    console.log('\n④ 生成物必须**纯 ASCII**（不然 wscript 会吃掉换行、自启静默失效）');
    const id = 'control-plane';
    check(`${id}.cmd 无非 ASCII 字节`, nonAscii(winCmd(id)) === 0, String(nonAscii(winCmd(id))));
    check(`${id}.vbs 无非 ASCII 字节`, nonAscii(winVbs(id)) === 0, String(nonAscii(winVbs(id))));
    check(`${id}.vbs 指向对应的 cmd`, read(winVbs(id)).includes(winCmd(id)));
    check(`${id}.vbs 是隐藏窗口、不等它`, /, 0, False/.test(read(winVbs(id))));
  } else {
    console.log('\n④ ASCII 那条只在 Windows 上有意义（这里是 UTF-8，跳过）');
    check('非 Windows 平台不做 ASCII 限制', true, `平台 ${process.platform}`);
  }

  console.log('\n⑤ 幂等：再装一遍，内容一模一样');
  const before = contentOf('control-plane', st.backend);
  autostart.install('all', opt);
  const after = contentOf('control-plane', st.backend);
  check('第二次装不会改内容', before === after);

  console.log('\n⑥ status 报的是**已装的那份**，不是按当前环境现算');
  check(
    '不受当前环境变量影响（换个数据目录问，仍报已装）',
    autostart.status({ ...opt, dataDir: path.join(tmp, 'other-data') }).targets[0].installed === true,
  );
  check('换了台机器（另一个 home）就报未装', autostart.status({ ...opt, home: path.join(tmp, 'other') }).targets.every((t) => !t.installed));

  console.log('\n⑦ 删干净');
  autostart.remove('all', opt);
  check('删干净', autostart.status(opt).targets.every((t) => !t.installed));
  if (!WIN && st.backend === 'crontab') check('crontab 里也清掉了', !crontabHas('control-plane'));

  console.log('\n⑧ 不认的目标要报错，不能默默什么都不做');
  let threw = '';
  try {
    autostart.install('node', opt);
  } catch (e) {
    threw = String(e?.message ?? e);
  }
  check('已删的 node 目标也报错并说清可选值', /不认识的目标/.test(threw) && /control-plane/.test(threw), threw);
} catch (err) {
  console.log('\n跑挂了：' + String(err?.message ?? err));
  failed += 1;
} finally {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch { /* 删不掉就算了 */ }
}

console.log(failed ? `\n✗ ${failed} 项没过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
