/**
 * 节点配置面（2026-10-28）的验收：机器角色 + 节点页依赖的接口。
 *
 * 背景：每台机器跑一个完整单机版，多机协同是实验特性；已加入总机的机器打开班底
 * 看到的是**本机配置面**（连接 / 这台机器 / 运行时 / 访问方式 / 数据 / 关于），
 * 不是总机面板。这一页要的输入只有三样：`/api/hello`（含新增的机器角色）、
 * `/api/local/status`、`/api/runtimes` —— **不为它开任何新的业务接口**。
 *
 * 钉住的边界：
 *   ① `config.json` 里有 `controlPlane` ⇒ `/api/hello` 的 `role` 是 `node`，
 *      且版本 / 主机名 / 身份那几项**照旧**（新字段只准加，不准改名、不准挤掉老的）；
 *   ② 节点的本机状态可用：`/api/local/status` 200 且 `client.joined === true`；
 *   ③ 节点页另外两个数据源（`/api/runtimes`、`/api/web-version`）都 200；
 *   ④ 清掉 `controlPlane` 再起 ⇒ `role` 回到 `operator`（**运行期现读**，不是启动快照）；
 *   ⑤ 反向断言：节点页**只**打那四个接口（静态扫 `renderNodeMode` 的函数体）——
 *      谁要是为了它打开 `/api/state` 之类的口子，这条立刻红。
 *
 * 隔离：临时数据目录 + 临时端口，跑完全删，不碰 data/。
 * 跑法：node apps/server/src/smoke-node-panel.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { repoRoot } from './config.mjs';
import { killPid, sleep, stopRunning } from './lifecycle.mjs';

const PORT = Number(process.env.SMOKE_PORT ?? 8789);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-node-panel-'));
const SERVER = path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs');
const CONFIG = path.join(tmp, 'config.json');
const LOCK = path.join(tmp, 'node.lock');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

let child = null;
let log = '';
function start() {
  log = '';
  child = spawn(process.execPath, [SERVER], {
    cwd: repoRoot,
    env: {
      ...process.env,
      BANDI_PORT: String(PORT),
      BANDI_DATA: tmp,
      BANDI_DB: path.join(tmp, 'bandi.db'),
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
}

/** 起没起来：`/api/hello` 免令牌，200 就是活了 */
async function waitUp(ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(BASE + '/api/hello', { signal: AbortSignal.timeout(800) });
      if (r.status === 200) return true;
    } catch { /* 还没起 */ }
    await sleep(200);
  }
  return false;
}

const get = async (p) => {
  const r = await fetch(BASE + p, { signal: AbortSignal.timeout(5000) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

/**
 * 停干净。**节点子进程要单独收**：已加入的实例起来时会 spawn `node.mjs`
 * （设计 §4.5），杀掉父进程不保证它跟着退 —— 留着它就是留一个对着 127.0.0.1:1
 * 无限重试的孤儿。锁文件里的 pid 是最可靠的凭据（supervisor 自己写的）。
 */
async function stopAll() {
  try { child?.kill(); } catch { /* 已退 */ }
  await sleep(500);
  try {
    const pid = Number(JSON.parse(fs.readFileSync(LOCK, 'utf8'))?.pid);
    if (Number.isInteger(pid) && pid > 1) killPid(pid);
  } catch { /* 没锁文件 = 没起过节点进程 */ }
  try { stopRunning(PORT); } catch { /* 没在跑 */ }
  await sleep(300);
}

const cleanup = async () => {
  await stopAll();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
};

try {
  /* ============ ① 已加入：机器角色是 node，其余字段照旧 ============ */
  console.log('① 预写 controlPlane（= 这台机器是节点）—— /api/hello 要报 node');
  fs.writeFileSync(
    CONFIG,
    `${JSON.stringify({ controlPlane: 'http://127.0.0.1:1', token: 'x', scope: 'compute' }, null, 2)}\n`,
    'utf8',
  );
  start();
  if (!(await waitUp())) throw new Error('实例没起来：' + log.slice(-500));

  const hello = await get('/api/hello');
  check('GET /api/hello → 200', hello.status === 200, String(hello.status));
  check('role === "node"（已加入总机）', hello.body?.role === 'node', String(hello.body?.role));
  // 新字段只准**加**：老的几个必须原样还在（前端与加入向导都靠它们）
  check(
    '版本 / 主机名 / 实例标识 / 能力声明照旧',
    hello.body?.platform === 'bandi' &&
      'version' in (hello.body ?? {}) &&
      typeof hello.body?.hostname === 'string' &&
      hello.body.hostname.length > 0 &&
      typeof hello.body?.instanceId === 'string' &&
      Array.isArray(hello.body?.caps),
    `platform=${hello.body?.platform} hostname=${hello.body?.hostname} version=${hello.body?.version}`,
  );
  check('hello 里不带令牌 / controlPlane 之类秘密', !('token' in (hello.body ?? {})) && !('controlPlane' in (hello.body ?? {})), Object.keys(hello.body ?? {}).join(','));

  /* ============ ② 本机状态可用 ============ */
  console.log('\n② /api/local/status —— 节点页第一节的数据源');
  const st = await get('/api/local/status');
  check('GET /api/local/status → 200', st.status === 200, String(st.status));
  check('client.joined === true', st.body?.client?.joined === true, String(st.body?.client?.joined));
  check(
    '带 dataDir 与条数（数据分节要用，且**没有新增接口**）',
    typeof st.body?.local?.dataDir === 'string' && typeof st.body?.local?.counts === 'object',
    st.body?.local?.dataDir ?? '',
  );

  /* ============ ③ 另外两个数据源 ============ */
  console.log('\n③ /api/runtimes、/api/web-version —— 运行时 / 版本提醒的数据源');
  const rts = await get('/api/runtimes');
  check('GET /api/runtimes → 200 且 runtimes 是数组', rts.status === 200 && Array.isArray(rts.body?.runtimes), String(rts.status));
  const ver = await get('/api/web-version');
  check('GET /api/web-version → 200', ver.status === 200, String(ver.status));

  /* ============ ④ **运行期**改 config.json：不重开进程，role 要跟着变 ============ */
  /*
   * 这一条钉的是「现读」而不是「启动快照」：服务**不重启**，只改磁盘上的 config.json，
   * 再打同一个 `/api/hello`。如果实现里用了 `config.clientJoined`（模块求值时拍下的快照），
   * 这里会一直是 node —— 那就该红。这也正是 `lanOrigins()` 那次的坑。
   */
  console.log('\n④ 运行期改 config.json（不重开进程）—— role 必须跟着变');
  await sleep(100);
  fs.writeFileSync(CONFIG, '{}\n', 'utf8');
  const helloLive = await get('/api/hello');
  check('同一进程里清掉 controlPlane → role=operator（现读，不是启动快照）', helloLive.body?.role === 'operator', String(helloLive.body?.role));
  const stLive = await get('/api/local/status');
  check('同一进程里 client.joined 变 false', stLive.body?.client?.joined === false, String(stLive.body?.client?.joined));

  // 再写回去：同一个进程要能回到 node（两个方向都验，免得"只认第一次"的缓存假通过）
  fs.writeFileSync(
    CONFIG,
    `${JSON.stringify({ controlPlane: 'http://127.0.0.1:1', token: 'x', scope: 'compute' }, null, 2)}\n`,
    'utf8',
  );
  const helloBack = await get('/api/hello');
  check('同一进程里写回 controlPlane → role=node', helloBack.body?.role === 'node', String(helloBack.body?.role));

  /* ============ ⑤ 反向断言：节点页不许"为它开新接口" ============ */
  /*
   * 静态扫 `renderNodeMode` 的函数体：它打的接口必须**只有**下面四个。
   * 这一条是有牙齿的 —— 页面要多一个数据源时，得先来这里加白名单，
   * 也就是必须先回答"为什么现有接口答不了"。
   */
  console.log('\n⑤ 反向断言：节点页只打 hello / local-status / runtimes / local-leave');
  const misc = fs.readFileSync(path.join(repoRoot, 'apps', 'web', 'js', 'misc.mjs'), 'utf8');
  const from = misc.indexOf('export function renderNodeMode(');
  const to = misc.indexOf('export async function boot(', from);
  const body = from >= 0 && to > from ? misc.slice(from, to) : '';
  check('找得到 renderNodeMode 的函数体', body.length > 0, `${from} → ${to}`);
  const hits = [...body.matchAll(/(?:\/api\/[\w/-]+)|(?:\$\{LOCAL_BASE\}\/[\w/-]+)/g)]
    .map((m) => m[0].replace('${LOCAL_BASE}', '/api/local'))
    .filter((p) => p.startsWith('/api/'));
  const used = [...new Set(hits)].sort();
  const ALLOWED = ['/api/hello', '/api/local/leave', '/api/local/status', '/api/runtimes'];
  const extra = used.filter((p) => !ALLOWED.includes(p));
  check(`节点页用到的接口都在白名单里（实际：${used.join(' ') || '无'}）`, extra.length === 0, extra.join(' '));
  check('没有为节点页打开 /api/state 之类的数据面', !used.includes('/api/state'));
} catch (err) {
  console.log('\n跑挂了：' + String(err?.message ?? err));
  failed += 1;
} finally {
  await cleanup();
}

console.log(failed ? `\n✗ ${failed} 项没过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
