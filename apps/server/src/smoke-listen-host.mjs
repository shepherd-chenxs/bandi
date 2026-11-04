/**
 * 监听地址的持久化（2026-11-04）——"做进系统"，不再靠部署时传 BANDI_HOST。
 *
 * 钉的是**取值顺序**（错了要么把面板关在门外，要么裸奔）：
 *   ① `BANDI_HOST` 环境变量 —— 显式钉（调试 / 特殊部署），最高优先；
 *   ② 数据目录 `config.json` 的 `listenHost` —— 界面改的，**升级重装不丢**（主路）；
 *   ③ 缺省 `0.0.0.0` —— 对外服务 + 强制鉴权。
 *
 * 外加：脏值当没配、写入保留同一个文件里的其它键、`bandi reset-host` 清得掉。
 *
 * ⚠️ 为什么用子进程问：`config.mjs` 的 `host` 是**模块求值时**算的一次性常量（进程启动即定型），
 * 同一个进程里改环境变量 / 改文件都不会重算 —— 那是设计要求（改完重启才生效）。
 * 所以每种组合起一个 node 子进程去问它。
 *
 * 跑法：node apps/server/src/smoke-listen-host.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CONFIG_URL = new URL('./config.mjs', import.meta.url).href;

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

/** 起个子进程问 config.mjs：给它一个数据目录（可选先种 config.json）和环境变量 */
function ask({ cfg = null, hostEnv = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-host-'));
  if (cfg) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg), 'utf8');
  const env = { ...process.env, BANDI_DATA: dir };
  delete env.BANDI_HOST; // 父进程环境不能漏进来，否则每条用例都被钉住
  if (hostEnv !== null) env.BANDI_HOST = hostEnv;
  const code = `const m = await import(${JSON.stringify(CONFIG_URL)}); console.log(JSON.stringify({ host: m.host, source: m.hostSource }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8' });
  const out = String(r.stdout ?? '').trim().split('\n').pop();
  try {
    return JSON.parse(out);
  } catch {
    return { host: null, source: `解析失败：${r.stderr ?? ''}` };
  }
}

try {
  /* ---------------- ① 合法写法（纯函数，主进程直接问） ----------------
   * 主进程 import 前先钉住 BANDI_DATA —— config.mjs 会按它算 dataDir，
   * 不钉的话写用例会碰用户真实的配置目录。 */
  process.env.BANDI_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-host-main-'));
  const cfg = await import('./config.mjs');

  console.log('① 合法写法（normalizeListenHost）');
  check('0.0.0.0 放行', cfg.normalizeListenHost('0.0.0.0') === '0.0.0.0');
  check('127.0.0.1 放行', cfg.normalizeListenHost(' 127.0.0.1 ') === '127.0.0.1');
  check('localhost 归一成回环', cfg.normalizeListenHost('localhost') === '127.0.0.1');
  check('具体网卡地址放行', cfg.normalizeListenHost('192.168.5.9') === '192.168.5.9');
  check('主机名不收（listen 会去解析，结果随环境漂）', cfg.normalizeListenHost('my-box.local') === null);
  check('越界的 IPv4 不收', cfg.normalizeListenHost('999.1.1.1') === null);
  check('空串 = 没配', cfg.normalizeListenHost('') === null);

  /* ---------------- ② 三层取值（每种组合一个子进程） ---------------- */
  console.log('② 三层取值：env > 数据目录配置 > 缺省');
  const a = ask();
  check('都没有 → 0.0.0.0（对外服务 + 强制鉴权）', a.host === '0.0.0.0' && a.source === 'default', JSON.stringify(a));
  const b = ask({ cfg: { listenHost: '127.0.0.1' } });
  check('界面里存了回环 → 按配置听回环', b.host === '127.0.0.1' && b.source === 'config', JSON.stringify(b));
  const c = ask({ cfg: { listenHost: '127.0.0.1' }, hostEnv: '192.168.5.9' });
  check('环境变量钉着 → 压过配置', c.host === '192.168.5.9' && c.source === 'env', JSON.stringify(c));
  const d = ask({ cfg: { listenHost: 'my-box.local' } });
  check('配置里是脏值 → 当没配，回落 0.0.0.0', d.host === '0.0.0.0' && d.source === 'default', JSON.stringify(d));

  /* ---------------- ③ 写入 / 清除 ---------------- */
  console.log('③ 写入与清除（writeListenHost / clearListenHost）');
  cfg.writeListenHost('192.168.5.9');
  const afterWrite = JSON.parse(fs.readFileSync(path.join(process.env.BANDI_DATA, 'config.json'), 'utf8'));
  check('写进去了', afterWrite.listenHost === '192.168.5.9', JSON.stringify(afterWrite));

  // 同一个文件里还有别的键（controlPlane / replyStyle / 生图…）—— 不许顺手弄丢
  fs.writeFileSync(
    path.join(process.env.BANDI_DATA, 'config.json'),
    JSON.stringify({ controlPlane: 'http://localhost:8787', replyStyle: 'concise' }),
    'utf8',
  );
  cfg.writeListenHost('0.0.0.0');
  const merged = JSON.parse(fs.readFileSync(path.join(process.env.BANDI_DATA, 'config.json'), 'utf8'));
  check('只动 listenHost，别的键原样保留', merged.controlPlane === 'http://localhost:8787' && merged.replyStyle === 'concise' && merged.listenHost === '0.0.0.0', JSON.stringify(merged));

  check('clearListenHost 清掉了', cfg.clearListenHost() === true);
  const cleared = JSON.parse(fs.readFileSync(path.join(process.env.BANDI_DATA, 'config.json'), 'utf8'));
  check('清完别的键还在', cleared.listenHost === undefined && cleared.controlPlane === 'http://localhost:8787', JSON.stringify(cleared));
  check('没得清时返回 false（幂等）', cfg.clearListenHost() === false);

  let threw = false;
  try {
    cfg.writeListenHost('my-box.local');
  } catch {
    threw = true;
  }
  check('写脏值当场报错（别让它落盘）', threw);
} catch (e) {
  console.error('  ✗ 用例炸了：', e?.stack ?? e);
  failed += 1;
}

console.log(failed ? `\n✗ ${failed} 条没过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
