/**
 * 外网访问（机器侧）的验收 —— 2026-11-07 首次落地。
 *
 * 钉住的四件事（改坏了要知道是哪一条松了）：
 *   ① 没有 relay 配置 → 完全空转（不 spawn、不写文件、不报错）；
 *   ② 有配置 → 生成 frpc.toml 并拉起 frpc；frpc 崩了自动退避重连；
 *   ③ 子域名变了 → 换配置重启（不是"再起一个"）；stop() 之后进程真的没了；
 *   ④ 隧道域名自动进两道闸（Host 守卫 / 写来源白名单）—— 用户不用碰 BANDI_ORIGINS。
 *
 * 不联网、不装 frp：用 `frpc.mjs` 这个假二进制（BANDI_FRPC 指过去），它只做两件事 ——
 * 把收到的 `-c` 配置抄一份到 FAKE_CAPTURE，然后赖着不走（或按 FAKE_MODE 崩一次）。
 *
 * 跑法：node apps/server/src/smoke-tunnel.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-tunnel-'));
const CAP = path.join(tmp, 'capture.jsonl');
const FAKE = path.join(tmp, 'frpc.mjs');

// ⚠️ 必须在 import 被测模块**之前**设：config.mjs 在求值那一刻就把 dataDir 定死了
process.env.BANDI_DATA = tmp;
process.env.BANDI_FRPC = FAKE;
process.env.FAKE_CAPTURE = CAP;
process.env.FAKE_MODE = 'crash-once';

fs.writeFileSync(FAKE, `import fs from 'node:fs';
const i = process.argv.indexOf('-c');
const conf = fs.readFileSync(process.argv[i + 1], 'utf8');
fs.appendFileSync(process.env.FAKE_CAPTURE, JSON.stringify({ pid: process.pid, conf }) + '\\n');
const once = process.env.FAKE_CAPTURE + '.crashed';
if (process.env.FAKE_MODE === 'crash-once' && !fs.existsSync(once)) {
  fs.writeFileSync(once, '1');
  setTimeout(() => process.exit(3), 120);
} else {
  setInterval(() => {}, 1000);
}
`);

const { apply, stop, status } = await import('./hub/tunnel.mjs');
const { relayOrigins, relayHosts } = await import('./hub/relay.mjs');
const { allowedOrigins } = await import('./http.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

const capture = () => {
  try {
    return fs.readFileSync(CAP, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

async function waitFor(fn, ms = 4000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return true;
    await sleep(50);
  }
  return false;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const relayCfg = (sub) => ({
  enabled: true,
  deviceId: `dev-${sub}`,
  serverAddr: 'relay.test',
  serverPort: 7000,
  subdomain: sub,
  token: `tk_${sub}`,
  publicUrl: `https://${sub}.d.test`,
});

const writeRelay = (obj) => fs.writeFileSync(path.join(tmp, 'tunnel.json'), JSON.stringify(obj, null, 2));

const PORT = 18787;

/* ---------------------------------------------------------------- ① 空转 */

console.log('\n[1] 没有配置时完全空转');
{
  const st = apply({ dataDir: tmp, port: PORT });
  check('状态 off', st.state === 'off', st.state);
  await sleep(250);
  check('没有拉起任何进程', capture().length === 0);
  check('没写 frpc.toml', !fs.existsSync(path.join(tmp, 'tunnel', 'frpc.toml')));
}

/* ---------------------------------------------------- ② 起隧道 + 崩了重连 */

console.log('\n[2] 有配置 → 起隧道；frpc 崩一次 → 自动重连');
{
  writeRelay(relayCfg('dev-a1'));
  const st = apply({ dataDir: tmp, port: PORT });
  check('状态进入启动中', st.state === 'starting' || st.state === 'up', st.state);

  // 宽限期 6 秒才判 up（spawn ≠ 登录成功，见 tunnel.mjs 的 UP_GRACE_MS）：窗口要盖过它
  const ok = await waitFor(() => capture().length >= 2 && status().state === 'up', 12_000);
  const lines = capture();
  check('崩过一次后自己连回来了', ok, `尝试次数 ${lines.length}`);
  check('子域名/服务器写进了 toml', /subdomain = "dev-a1"/.test(lines.at(-1)?.conf ?? '') && /serverAddr = "relay.test"/.test(lines.at(-1)?.conf ?? ''));
  check('本机端口指向控制面', /localPort = 18787/.test(lines.at(-1)?.conf ?? ''));
  check('设备凭据写进 metadatas（frps 转给 Login 回调，中枢据它认设备）', /metadatas\.token = "tk_dev-a1"/.test(lines.at(-1)?.conf ?? ''));
  check('设备号写进 user（Login 回调里的 `user` 字段）', /user = "dev-dev-a1"/.test(lines.at(-1)?.conf ?? ''));
  check('toml 落在数据目录', fs.existsSync(path.join(tmp, 'tunnel', 'frpc.toml')));
  check('pid 文件记下了', fs.existsSync(path.join(tmp, 'tunnel', 'frpc.pid')));
}

/* ------------------------------------------------------------ ③ 幂等/改派 */

console.log('\n[3] 幂等与改派');
{
  const before = capture().length;
  const pid1 = status().pid;
  apply({ dataDir: tmp, port: PORT });
  await sleep(300);
  check('同样的配置再 apply 不重启', capture().length === before, `${before} → ${capture().length}`);

  writeRelay(relayCfg('dev-a2'));
  apply({ dataDir: tmp, port: PORT });
  const ok = await waitFor(() => capture().length > before, 4000);
  check('子域名变了就重启', ok, `尝试次数 ${capture().length}`);
  check('新配置用的是新子域名', /subdomain = "dev-a2"/.test(capture().at(-1)?.conf ?? ''));
  check('换了进程（不是并存两条隧道）', status().pid && status().pid !== pid1, `${pid1} → ${status().pid}`);
  check('旧进程已退出', !alive(Number(pid1)), `pid ${pid1}`);
}

/* ------------------------------------------------------------ ④ 两道闸 */

console.log('\n[4] 隧道域名自动进 Host 守卫 / 来源白名单');
{
  const origins = relayOrigins(tmp);
  const hosts = relayHosts(tmp);
  check('读得出隧道来源', origins.includes('https://dev-a2.d.test'), origins.join(','));
  check('Host 守卫认得这个域名', hosts.includes('dev-a2.d.test'), hosts.join(','));
  check('写来源白名单已放行（不用设 BANDI_ORIGINS）', allowedOrigins().has('https://dev-a2.d.test'));
}

/* ------------------------------------------------------------ ⑤ 收尸 */

console.log('\n[5] 上次没退干净的 frpc 会被收掉');
{
  stop();
  await sleep(200);
  check('stop 之后状态 off', status().state === 'off');

  const stale = spawn(process.execPath, [FAKE, '-c', path.join(tmp, 'tunnel', 'frpc.toml')], {
    stdio: 'ignore',
    env: { ...process.env, FAKE_MODE: 'hold' },
  });
  await sleep(200);
  check('假 frpc 已经在跑', alive(stale.pid), `pid ${stale.pid}`);

  fs.mkdirSync(path.join(tmp, 'tunnel'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'tunnel', 'frpc.pid'), JSON.stringify({ pid: stale.pid, at: new Date().toISOString() }));

  apply({ dataDir: tmp, port: PORT });
  const gone = await waitFor(() => !alive(stale.pid), 6000);
  check('残留进程被收掉', gone, `pid ${stale.pid}`);
  check('新隧道起来了', status().state === 'up' || status().state === 'starting', status().state);
  stop();
}

/* ------------------------------------------------------------ ⑥ 没有 frpc */

console.log('\n[6] 没装 frpc 时降级，不报错也不拦启动');
{
  const keep = process.env.BANDI_FRPC;
  const keepPath = process.env.PATH;
  process.env.BANDI_FRPC = path.join(tmp, 'no-such-frpc');
  process.env.PATH = '';
  const st = apply({ dataDir: tmp, port: PORT });
  check('状态 unavailable', st.state === 'unavailable', st.state);
  check('没有 pid 文件残留', !fs.existsSync(path.join(tmp, 'tunnel', 'frpc.pid')));
  process.env.BANDI_FRPC = keep;
  process.env.PATH = keepPath;
  stop();
}

/* ------------------------------------------------------------------ 收尾 */

try { stop(); } catch { /* 已停 */ }
await sleep(400);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows 上子进程刚退时目录可能还被占着，留在临时目录里无妨 */ }

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 条没过`);
process.exit(failed === 0 ? 0 : 1);
