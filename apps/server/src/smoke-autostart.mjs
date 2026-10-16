/**
 * 「开机自启」的验收（2026-10-16）。
 *
 * **跨平台的契约**：装了什么、能不能删、幂等、不认的目标要报错、节点用**它自己的**数据目录、
 * 没令牌要警告、status 报的是**已装的那份**而不是按环境变量现算。
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
const NDATA = path.join(tmp, 'ndata');
fs.mkdirSync(HOME, { recursive: true });
// 节点的数据目录不跟着 home 走（它属于"这台机器"），要指进临时目录就用官方开关
process.env.BANDI_NODE_DATA = NDATA;
const CP = 'http://10.0.0.9:8787';
/*
 * ⚠️ `noSystem: true` 是**必须的**（2026-10-16 踩到）：单元名是固定的 `bandi-node.service`，
 * 用例里一跑 `systemctl --user disable --now bandi-node`，就会把**这台机器上真正在跑的服务停掉** ——
 * 验证代码顺手把生产环境改了。开了这个开关，用例只生成文件，不碰系统。
 */
const opt = { home: HOME, dataDir: DATA, repoRoot: process.cwd(), nodeBin: process.execPath, controlPlane: CP, noSystem: true };

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

  console.log('\n② 装两个目标');
  const done = autostart.install('all', opt);
  check('两个都装了', done.length === 2, done.map((d) => d.id).join(','));
  st = autostart.status(opt);
  check('status 也认（两个都 installed）', st.targets.every((t) => t.installed), st.targets.map((t) => `${t.id}=${t.installed}`).join(' '));
  check('给出了装在哪', st.targets.every((t) => t.where && t.where.length > 5), st.targets[0].where);
  // 文件层面的存在性：按后端分支
  if (WIN) {
    check('两份 .cmd 都在', ['node', 'control-plane'].every((id) => fs.existsSync(winCmd(id))));
    check('两个 .vbs 进了 Startup', ['node', 'control-plane'].every((id) => fs.existsSync(winVbs(id))));
  } else if (MAC) {
    check('plist 都在', ['node', 'control-plane'].every((id) => fs.existsSync(macPlist(id))));
  } else if (st.backend === 'systemd-user') {
    check('两个 systemd 单元都在', ['node', 'control-plane'].every((id) => fs.existsSync(unitPath(id))));
  } else {
    check('两个 crontab 兜底脚本都在', ['node', 'control-plane'].every((id) => fs.existsSync(cronScript(id))));
    check('crontab 里两条都在', ['node', 'control-plane'].every((id) => crontabHas(id)));
  }

  console.log('\n③ 内容：路径、环境、重启策略');
  const nodeText = contentOf('node', st.backend);
  check('指向这台机器的 node', nodeText.includes(process.execPath));
  check('指向本仓的 node.mjs', nodeText.includes(path.join('apps', 'server', 'src', 'node.mjs')));
  check('带上了控制面地址', nodeText.includes(CP));
  /*
   * ⚠️ 节点用的是**它自己的**数据目录，不是控制面那个 —— 2026-10-16 实测：
   * 一开始两者共用一个目录，节点在仓库 data/ 里找不到令牌，一起来就被 401 挡回去。
   */
  const dataLine = (nodeText.match(/BANDI_DATA=.*/) ?? [''])[0];
  check('节点用**自己的**数据目录（不是控制面那个）', !nodeText.includes(`BANDI_DATA=${DATA}`), dataLine.trim());
  check('走的是 BANDI_NODE_DATA 指的那个目录', nodeText.includes(`BANDI_DATA=${NDATA}`), dataLine.trim());
  if (WIN) {
    check('有重启循环（cmd 里 :again / goto）', /:again/.test(nodeText) && /goto again/.test(nodeText));
    check('控制面那条带 BANDI_NO_BROWSER=1（开机别弹浏览器）', contentOf('control-plane', st.backend).includes('BANDI_NO_BROWSER=1'));
  } else if (st.backend === 'systemd-user') {
    check('systemd 单元有 Restart=always（崩了自己回来）', /Restart=always/.test(nodeText));
    check('systemd 单元有 RestartSec', /RestartSec=\d+/.test(nodeText));
    check('控制面那条带 BANDI_NO_BROWSER=1', contentOf('control-plane', st.backend).includes('BANDI_NO_BROWSER=1'));
  }

  /*
   * ⚠️ **纯 ASCII 只有 Windows 需要**（wscript / cmd 按系统 ANSI 页读脚本，中文注释会把换行吃掉，
   * `Set sh = ...` 变成注释 → 自启静默失效）。Linux/macOS 的单元与 plist 是 UTF-8，别乱套。
   */
  if (WIN) {
    console.log('\n④ 生成物必须**纯 ASCII**（不然 wscript 会吃掉换行、自启静默失效）');
    for (const id of ['node', 'control-plane']) {
      check(`${id}.cmd 无非 ASCII 字节`, nonAscii(winCmd(id)) === 0, String(nonAscii(winCmd(id))));
      check(`${id}.vbs 无非 ASCII 字节`, nonAscii(winVbs(id)) === 0, String(nonAscii(winVbs(id))));
      check(`${id}.vbs 指向对应的 cmd`, read(winVbs(id)).includes(winCmd(id)));
      check(`${id}.vbs 是隐藏窗口、不等它`, /, 0, False/.test(read(winVbs(id))));
    }
  } else {
    console.log('\n④ ASCII 那条只在 Windows 上有意义（这里是 UTF-8，跳过）');
    check('非 Windows 平台不做 ASCII 限制', true, `平台 ${process.platform}`);
  }

  /*
   * 没令牌就得先说 —— 否则节点一起来被 401 挡回去，人只能对着日志猜。
   * 放上令牌后这条警告要消失，否则就成了"狼来了"。
   */
  const warnOf = () => autostart.install('node', opt).find((d) => d.id === 'node')?.warn ?? '';
  check('没令牌时明确警告', /还没有令牌/.test(warnOf()), warnOf().slice(0, 40));
  fs.mkdirSync(NDATA, { recursive: true });
  fs.writeFileSync(path.join(NDATA, 'token'), 'x'.repeat(32) + '\n', 'utf8');
  check('放了令牌之后不再警告', warnOf() === '', warnOf().slice(0, 40));
  fs.rmSync(path.join(NDATA, 'token'), { force: true });

  console.log('\n⑤ 幂等：再装一遍，内容一模一样');
  const before = ['node', 'control-plane'].map((id) => contentOf(id, st.backend));
  autostart.install('all', opt);
  const after = ['node', 'control-plane'].map((id) => contentOf(id, st.backend));
  check('第二次装不会改内容', before.every((b, i) => b === after[i]));

  console.log('\n⑥ status 报的是**已装的那份**，不是按当前环境现算');
  const stOther = autostart.status({ ...opt, controlPlane: 'http://别的地址:1' });
  check(
    '不受当前环境变量影响',
    /10\.0\.0\.9/.test(stOther.targets.find((t) => t.id === 'node')?.note ?? ''),
    stOther.targets.find((t) => t.id === 'node')?.note,
  );
  check('换了台机器（另一个 home）就报未装', autostart.status({ ...opt, home: path.join(tmp, 'other') }).targets.every((t) => !t.installed));

  console.log('\n⑦ 只装一个 / 删干净');
  autostart.remove('node', opt);
  check('node 那份删了', !autostart.status(opt).targets.find((t) => t.id === 'node').installed);
  check('control-plane 的还在（没被误删）', autostart.status(opt).targets.find((t) => t.id === 'control-plane').installed);
  autostart.remove('all', opt);
  check('两个都删干净', autostart.status(opt).targets.every((t) => !t.installed));
  if (!WIN && st.backend === 'crontab') check('crontab 里也清掉了', !crontabHas('node') && !crontabHas('control-plane'));

  console.log('\n⑧ 不认的目标要报错，不能默默什么都不做');
  let threw = '';
  try {
    autostart.install('随便什么', opt);
  } catch (e) {
    threw = String(e?.message ?? e);
  }
  check('报错并说清可选值', /不认识的目标/.test(threw) && /node/.test(threw), threw);
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
