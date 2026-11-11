/**
 * 本机壳子自动进门（2026-11-10）的验收。
 *
 * 病根：控制面默认对外监听（0.0.0.0）→ **本机请求也要鉴权**；桌面壳把窗口开到
 * `/` 时拿到登录页，用户离开一晚回来发消息收到 E4010「不是从本机直接发起的」
 * （2026-11-10 用户实拍）。修法：桌面壳把窗口开到 `/shell/enter?secret=…`
 * （secret = 数据目录 `local_secret`），服务端核"本机直连 + 文件秘密"后发一张
 * 本机会话（kind='shell'，7 天空闲 / 180 天绝对），302 回面板。
 *
 * 这条用例钉七件事：
 *   ① 本机直连 + 对 secret → 302 + `bandi_sid`，带 Cookie 能打开面板；
 *   ② 会话是 shell 档（空闲闸按天，不是 30 分钟）——"过一晚回来还能用"；
 *   ③ 错 secret 不进（401 E4010，且文案不再说"不是从本机直接发起的"）；
 *   ④ 反代形态（带 X-Forwarded-For）即使知道 secret 也不认；
 *   ⑤ 老路径不受影响：令牌照旧能过 API；
 *   ⑥ `/api/ping` 带 `authRequired`（壳据此决定要不要进门）且**不记审计**；
 *   ⑦ 真桌面壳启动：窗口开到 `/shell/enter`，审计里**一条「拒绝访问」都不多**
 *      （2026-11-10 晚补：以前壳每次启动裸打 `/api/state` 吃 401，审计里一行/次）。
 *
 * 隔离：临时数据目录 + 临时端口；自己造一个用户（firstUser 就是机主）。
 * 跑法：node apps/server/src/smoke-shell-enter.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.SMOKE_PORT ?? 8862);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-shell-enter-'));
/*
 * ⚠️ 必须在 import 任何读环境变量的模块**之前**钉数据目录：config/store 在模块加载时读
 * `BANDI_DATA`（默认是真数据目录）。忘了这句，`store.createUser` 会往开发者**真实库**里写
 * 一个用户（2026-11-10 写这条用例时踩过：真库里多了"烟测机主"）。
 */
process.env.BANDI_DATA = tmp;
process.env.BANDI_DB = path.join(tmp, 'bandi.db');

const { repoRoot } = await import('./config.mjs');
const { stopRunning, sleep } = await import('./lifecycle.mjs');
const store = await import('./store.mjs');
const { DatabaseSync } = await import('node:sqlite');

const SECRET = 'smoke-local-secret-0123456789';
const BASE = `http://127.0.0.1:${PORT}`;

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failed += 1;
};

/**
 * 数一下审计里的「拒绝访问」。壳的探活**不该让它涨** —— 这是 ⑦ 的判据
 * （2026-11-10 晚：壳改问 /api/ping，不再裸打 /api/state 吃 401）。
 * 只读打开（服务端正拿这个库跑着 WAL），与下面读会话表同一个写法。
 */
const auditDenies = () => {
  const db = new DatabaseSync(path.join(tmp, 'bandi.db'), { readOnly: true });
  try {
    return {
      all: db.prepare("SELECT COUNT(*) AS n FROM security_events WHERE kind = 'authz.deny'").get().n,
      state: db.prepare("SELECT COUNT(*) AS n FROM security_events WHERE kind = 'authz.deny' AND action = 'GET /api/state'").get().n,
    };
  } finally {
    db.close();
  }
};

const get = async (p, headers = {}) => {
  const r = await fetch(BASE + p, { headers, redirect: 'manual', signal: AbortSignal.timeout(8000) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, headers: r.headers, text, json };
};

async function waitUp(ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(BASE + '/api/state', { signal: AbortSignal.timeout(800) });
      if (r.status === 200 || r.status === 401) return true;
    } catch { /* 还没起 */ }
    await sleep(200);
  }
  return false;
}

const child = (() => {
  const env = { ...process.env, BANDI_PORT: String(PORT), BANDI_DATA: tmp, BANDI_DB: path.join(tmp, 'bandi.db') };
  // 默认对外监听（缺省 0.0.0.0）才是被测形态：run-smokes 会给所有子进程钉 BANDI_HOST=127.0.0.1
  delete env.BANDI_HOST;
  return spawn(process.execPath, [path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs')], {
    cwd: repoRoot,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
})();
let childLog = '';
child.stdout.on('data', (d) => (childLog += d));
child.stderr.on('data', (d) => (childLog += d));

/** ⑦ 的桌面壳子进程（用例中途起、退出时收） */
let shellKid = null;

const cleanup = async () => {
  try { shellKid?.kill(); } catch { /* 已退 */ }
  try { child.kill(); } catch { /* 已退 */ }
  await sleep(300);
  try { stopRunning(PORT); } catch { /* 没在跑 */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
};

try {
  // 先造机主账号 + 固定 local_secret：服务端起来前落盘，免得等它自己生成
  fs.writeFileSync(path.join(tmp, 'local_secret'), `${SECRET}\n`, { encoding: 'utf8', mode: 0o600 });
  store.createUser({ name: '烟测机主' });

  if (!(await waitUp())) throw new Error('控制面没起来：' + childLog.slice(-500));
  check('控制面默认对外监听（/api/state 无凭据 → 401）', (await get('/api/state')).status === 401);

  /*
   * ① 本机直连 + 对 secret → 302 + 本机会话
   */
  console.log('\n① 本机壳子进门：/shell/enter?secret=… → 302 + bandi_sid');
  const enter = await get(`/shell/enter?secret=${encodeURIComponent(SECRET)}`);
  const sid = String(enter.headers.get('set-cookie') ?? '').match(/bandi_sid=([^;]+)/)?.[1] ?? '';
  check('302 回面板', enter.status === 302 && enter.headers.get('location') === '/', `${enter.status} ${enter.headers.get('location')}`);
  check('发了一张 bandi_sid（HttpOnly）', !!sid && /HttpOnly/i.test(String(enter.headers.get('set-cookie'))), sid ? 'ok' : '(无)');

  const panel = await get('/', { Cookie: `bandi_sid=${sid}` });
  check('带这张会话能打开面板（不是登录页）',
    panel.status === 200 && panel.text.includes('/app.mjs') && !panel.text.includes('action="/hub/login"'),
    `${panel.status} ${panel.text.includes('/app.mjs') ? 'app' : 'login?'}`);

  /*
   * ② 会话是 shell 档：空闲闸按天（不是 30 分钟）—— 用户"过一晚回来"还能用
   *   顺带钉住 hub 档没被 shell 档带偏（2026-11-10 复审抓过：hub 绝对闸被写成 12 天）。
   */
  const db = new DatabaseSync(path.join(tmp, 'bandi.db'), { readOnly: true });
  const shellRow = db.prepare("SELECT kind, idleExpiresAt, absoluteExpiresAt FROM user_sessions WHERE kind = 'shell' ORDER BY createdAt DESC LIMIT 1").get();
  const hubSession = store.createSession(store.firstUser().id, { kind: 'hub' });
  const hubRow = db.prepare("SELECT kind, idleExpiresAt, absoluteExpiresAt FROM user_sessions WHERE kind = 'hub' ORDER BY createdAt DESC LIMIT 1").get();
  db.close();
  const days = (iso) => (Date.parse(iso) - Date.now()) / 86400_000;
  check('会话 kind=shell', shellRow?.kind === 'shell', JSON.stringify(shellRow));
  check('shell：空闲闸按天（> 6 天，不是 30 分钟）', days(shellRow?.idleExpiresAt) > 6, days(shellRow?.idleExpiresAt).toFixed(1) + ' 天');
  check('shell：绝对闸 180 天', Math.abs(days(shellRow?.absoluteExpiresAt) - 180) < 1, days(shellRow?.absoluteExpiresAt).toFixed(1) + ' 天');
  check('hub 会话绝对闸仍是 12 小时（没被 shell 档带偏）',
    !!hubSession.token && Math.abs(days(hubRow?.absoluteExpiresAt) * 24 - 12) < 0.2,
    (days(hubRow?.absoluteExpiresAt) * 24).toFixed(1) + ' 小时');
  check('hub 会话空闲闸仍是 30 分钟', Math.abs(days(hubRow?.idleExpiresAt) * 24 * 60 - 30) < 2,
    (days(hubRow?.idleExpiresAt) * 24 * 60).toFixed(0) + ' 分钟');

  /*
   * ③ 错 secret 不进；且文案不再说"不是从本机直接发起的"（本机 peer 的实情是"要登录"）
   */
  console.log('\n③ 错 secret / 空 secret / 非 GET：都不进；本机请求的 E4010 文案不撒谎');
  const bad = await get('/shell/enter?secret=wrong-secret');
  check('错 secret → 401 E4010（不发会话）', bad.status === 401 && bad.json?.code === 'E4010' && !/bandi_sid=/.test(String(bad.headers.get('set-cookie'))), `${bad.status} ${bad.json?.code ?? ''}`);
  check('本机请求的文案不再说"不是从本机直接发起的"',
    /需要登录/.test(String(bad.json?.error)) && !/不是从本机直接发起的/.test(String(bad.json?.error)), String(bad.json?.error));
  const empty = await get('/shell/enter?secret=');
  check('空 secret → 不进', empty.status === 401 && !/bandi_sid=/.test(String(empty.headers.get('set-cookie'))), `${empty.status}`);
  const noParam = await get('/shell/enter');
  check('缺参数 → 不进', noParam.status === 401 && !/bandi_sid=/.test(String(noParam.headers.get('set-cookie'))), `${noParam.status}`);
  // POST 单独打一枪，确认只开 GET（get() 固定 GET）
  const postRes = await fetch(BASE + `/shell/enter?secret=${encodeURIComponent(SECRET)}`, { method: 'POST', redirect: 'manual' });
  check('POST 不进门（只开 GET）', postRes.status !== 302, `${postRes.status}`);

  /*
   * ④ 反代形态（X-Forwarded-For / X-Real-IP / Forwarded）即使知道 secret 也不认
   */
  console.log('\n④ 反代进来的请求：有 secret 也不认');
  for (const header of ['X-Forwarded-For', 'X-Real-IP', 'Forwarded']) {
    const proxied = await get(`/shell/enter?secret=${encodeURIComponent(SECRET)}`, { [header]: header === 'Forwarded' ? 'for=203.0.113.9' : '203.0.113.9' });
    check(`${header} + 对 secret → 不 302、不发会话`,
      proxied.status !== 302 && !/bandi_sid=/.test(String(proxied.headers.get('set-cookie'))), `${proxied.status}`);
  }

  /*
   * ⑤ 老路径不受影响：令牌照旧能过 API
   */
  const token = fs.readFileSync(path.join(tmp, 'token'), 'utf8').trim();
  check('operator 令牌照旧能读 /api/state', (await get('/api/state', { 'X-Bandi-Token': token })).status === 200);

  /*
   * ⑥ 壳的探活口（2026-11-10 晚）：`/api/ping` 免鉴权、带 `authRequired`、**不记审计**。
   *    壳靠它决定要不要自动进门，从而不再裸打 `/api/state` 吃 401。
   */
  console.log('\n⑥ 壳的探活口：/api/ping 带 authRequired，且不进审计');
  const deniesBeforePing = auditDenies();
  const ping = await get('/api/ping');
  check('/api/ping 免鉴权 + platform=bandi + authRequired=true',
    ping.status === 200 && ping.json?.platform === 'bandi' && ping.json?.authRequired === true,
    `${ping.status} ${JSON.stringify(ping.json)}`);
  await get('/api/ping');
  await get('/api/ping');
  const deniesAfterPing = auditDenies();
  check('/api/ping 不记审计（探活不该出现在「拒绝访问」里）',
    deniesAfterPing.all === deniesBeforePing.all && deniesAfterPing.state === deniesBeforePing.state,
    `全部 ${deniesBeforePing.all} → ${deniesAfterPing.all}`);

  /*
   * ⑦ 真桌面壳启动（端到端）：它问 `/api/ping` 拿到 authRequired=true → 窗口直接开到
   *    `/shell/enter?secret=…`；审计里**一条新的「拒绝访问」都不该出现**
   *    （以前是裸打 `/api/state` 401，每开一次壳多一行 —— 用户 2026-11-10 就是看到那一串问的）。
   *
   * 壳复用一个已经在跑的控制面（我们这个测试进程起的），所以 READY 末尾标记是 0；
   * 它不会收掉这个服务（service.json 里没有"壳起的"记录）。
   */
  console.log('\n⑦ 桌面壳启动：靠 /api/ping 决定进门，审计里不再多出「拒绝访问」');
  const deniesBeforeShell = auditDenies();
  shellKid = spawn(process.execPath, [path.join(repoRoot, 'apps', 'desktop', 'shell.mjs')], {
    cwd: repoRoot,
    env: { ...process.env, BANDI_DATA: tmp, BANDI_DB: path.join(tmp, 'bandi.db'), BANDI_PORT: String(PORT) },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let shellOut = '';
  shellKid.stdout.setEncoding('utf8');
  shellKid.stdout.on('data', (d) => (shellOut += d));
  const readyLine = await (async () => {
    const until = Date.now() + 20000;
    while (Date.now() < until) {
      const line = shellOut.split('\n').find((l) => l.startsWith('BANDI_SHELL READY '));
      if (line) return line.trim();
      await sleep(150);
    }
    return null;
  })();
  check('壳报 READY，窗口直接开到 /shell/enter?secret=…',
    !!readyLine && /\/shell\/enter\?secret=/.test(readyLine) && readyLine.endsWith(' 0'),
    String(readyLine));
  try { shellKid.stdin.write('STOP\n'); } catch { /* 已退 */ }
  await Promise.race([new Promise((r) => shellKid.on('exit', r)), sleep(6000)]);
  const deniesAfterShell = auditDenies();
  check('壳启动没有在审计里留「拒绝访问」（不再裸打 /api/state）',
    deniesAfterShell.all === deniesBeforeShell.all && deniesAfterShell.state === deniesBeforeShell.state,
    `全部 ${deniesBeforeShell.all} → ${deniesAfterShell.all}，其中 /api/state ${deniesBeforeShell.state} → ${deniesAfterShell.state}`);
} catch (err) {
  console.log('\n跑挂了：' + String(err?.message ?? err));
  if (childLog) console.log('--- 服务端日志尾部 ---\n' + childLog.slice(-800));
  failed += 1;
} finally {
  await cleanup();
}

console.log(failed ? `\n✗ ${failed} 项没过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
