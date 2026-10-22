/**
 * 「加入总机」端到端冒烟（2026-10-20，设计 §11 T05 / 增量 1 T03；2026-10-21 重写）。
 *
 * 2026-10-21 拍板：**节点只当算力，不做「看总机面板」** —— 反代（client-proxy）已删，
 * 加入一律 compute（服务端写死，不信任前端）。本文件验证六件事
 * （两个数据目录 + 一台回环对照机 + 一个 mock 旧总机）：
 *   ① **云端总机可加入**：总机用 `BANDI_HOST=0.0.0.0` 显式监听（**不开**「允许局域网」开关）
 *      → `/api/hello` 照样 `joinable:true`，节点 probe → 200（增量 1 修的 E1091 误报，核心回归）；
 *   ② probe 三级判定顺序：E1090/E2050/E1091 各走各的出口，`E1091` 文案中性（不提「局域网」）；
 *   ③ 真加入（故意带旧拼写的 `scopes:['compute','panel']`）→ 服务端强制 compute：
 *      `config.json` 七键 + `lastHost`、总机库 `node_tokens.scope` 落库 `compute`、
 *      本机 UI 还是自己的（无注入标记、`/api/state` 答本机库）、
 *      节点令牌摸总机面板 → 403 `E4031`（那道闸还在）；
 *   ④ 退出总机：七键清、**`lastHost` 保留**（退出不清，覆盖写语义）；
 *   ⑤ 重加（旧拼写 scope 字符串 `'compute panel'`）→ 一样被强制成 `compute`；
 *   ⑥ 总机侧直连接口（node.mjs --join 那一路）仍收 scope 并归一化（总机侧机制保留）。
 *
 * 隔离：临时数据目录 + 8874/8875/8876 三个临时端口 + 独立 UDP 端口，跑完全删，不碰 data/。
 * 跑法：node apps/server/src/smoke-lan-join.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { repoRoot } from './config.mjs';

const PORT_HOST = Number(process.env.SMOKE_PORT ?? 8874); // 总机（云端形态）
const PORT_NODE = PORT_HOST + 1;                          // 待加入机（8875）
const PORT_LOOP = PORT_HOST + 2;                          // 回环对照机（8876）
const DISC_PORT = 18774;                                  // 独立 UDP 端口，别撞真服务的 8788
const PORT_DEAD = PORT_HOST + 125;                        // 一个没人听的端口（E1092）
const BASE_HOST = `http://127.0.0.1:${PORT_HOST}`;
const BASE_NODE = `http://127.0.0.1:${PORT_NODE}`;
const BASE_LOOP = `http://127.0.0.1:${PORT_LOOP}`;
const SERVER = path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs');
const OP_TOKEN = 'smoke-lan-op-' + Math.random().toString(36).slice(2, 8);

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

const json = async (base, p, opts = {}) => {
  const r = await fetch(base + p, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { 'X-Bandi-Token': opts.token } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeout ?? 15000),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const kids = [];
const startServer = (dataDir, port, extra = {}) => {
  const c = spawn(process.execPath, [SERVER], {
    cwd: repoRoot,
    env: { ...process.env, BANDI_DATA: dataDir, BANDI_PORT: String(port), BANDI_DISCOVERY_PORT: String(DISC_PORT), ...extra },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  c.stdout.on('data', (d) => (log += d));
  c.stderr.on('data', (d) => (log += d));
  kids.push({ child: c, log: () => log });
  return c;
};
async function waitReady(base, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await fetch(base + '/api/hello', { signal: AbortSignal.timeout(1500) }); if (r.status === 200) return true; } catch { /* 还没起 */ }
    await sleep(200);
  }
  return false;
}
const invite = async () => {
  const r = await json(BASE_HOST, '/api/nodes/invites', { method: 'POST', token: OP_TOKEN });
  if (r.status !== 201 || !r.body?.code) throw new Error('发邀请码失败：' + JSON.stringify(r.body));
  return r.body.code;
};
const hubScopes = (dbPath, nodeId) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare('SELECT scope FROM node_tokens WHERE nodeId = ?').all(nodeId);
  db.close();
  return rows.map((r) => r.scope);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-lanjoin-'));
const DATA_HOST = path.join(tmp, 'host');
const DATA_NODE = path.join(tmp, 'node');
for (const d of [DATA_HOST, DATA_NODE]) fs.mkdirSync(d, { recursive: true });

/* 假「旧总机」：是班底（platform:'bandi'）但 hello 里没有 joinable 字段（E2050 的判据） */
const mockOld = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ platform: 'bandi', proto: 1, version: '0.9.0', label: '旧总机' }));
});
await new Promise((r) => mockOld.listen(0, '127.0.0.1', r));
const BASE_MOCK = `http://127.0.0.1:${mockOld.address().port}`;

let host = null;
let node = null;
let loop = null;
try {
  host = startServer(DATA_HOST, PORT_HOST, { BANDI_HOST: '0.0.0.0', BANDI_TOKEN: OP_TOKEN });
  node = startServer(DATA_NODE, PORT_NODE);
  loop = startServer(path.join(tmp, 'loop'), PORT_LOOP);
  if (!(await waitReady(BASE_HOST))) throw new Error('总机没起来：' + (kids[0]?.log() ?? '').slice(-300));
  if (!(await waitReady(BASE_NODE))) throw new Error('节点侧服务没起来');
  if (!(await waitReady(BASE_LOOP))) throw new Error('回环对照机没起来');

  console.log('① 云端总机（BANDI_HOST=0.0.0.0，不开 allowLan）自己声明可加入');
  const hello = await json(BASE_HOST, '/api/hello');
  check('hello joinable=true 且 allowLan=false（显式监听即开放，开关值照实广播）',
    hello.body?.joinable === true && hello.body?.allowLan === false,
    JSON.stringify({ joinable: hello.body?.joinable, allowLan: hello.body?.allowLan }));
  const helloLoop = await json(BASE_LOOP, '/api/hello');
  check('回环对照机 joinable=false（判定输入是「实际监听」，不是部署方式）',
    helloLoop.body?.joinable === false, `joinable=${helloLoop.body?.joinable}`);

  console.log('\n② probe 三级判定（顺序即语义）');
  const pUp = await json(BASE_NODE, '/api/local/probe', { method: 'POST', body: { url: BASE_HOST } });
  check('probe 云端总机 → 200（旧行为这里会误报 E1091）',
    pUp.status === 200 && pUp.body?.host?.joinable === true,
    `${pUp.status} host.joinable=${pUp.body?.host?.joinable}`);
  const pLoop = await json(BASE_NODE, '/api/local/probe', { method: 'POST', body: { url: BASE_LOOP } });
  check('probe 回环总机 → 400 E1091，文案中性（不提「局域网」）',
    pLoop.status === 400 && pLoop.body?.code === 'E1091' && !String(pLoop.body?.error ?? '').includes('局域网'),
    `${pLoop.status} ${JSON.stringify(pLoop.body?.error)}`);
  const pOld = await json(BASE_NODE, '/api/local/probe', { method: 'POST', body: { url: BASE_MOCK } });
  check('probe 旧总机（hello 无 joinable 字段）→ 409 E2050，不静默降级',
    pOld.status === 409 && pOld.body?.code === 'E2050', `${pOld.status} ${pOld.body?.code ?? ''}`);
  const pDead = await json(BASE_NODE, '/api/local/probe', { method: 'POST', body: { url: `http://127.0.0.1:${PORT_DEAD}` } });
  check('probe 没人听的地址 → 400 E1092', pDead.status === 400 && pDead.body?.code === 'E1092',
    `${pDead.status} ${pDead.body?.code ?? ''}`);

  console.log('\n③ 真加入（故意带旧拼写的 scopes —— 服务端必须强制成 compute）');
  const j1 = await json(BASE_NODE, '/api/local/join', {
    method: 'POST', body: { url: BASE_HOST, code: await invite(), scopes: ['compute', 'panel'] } });
  check('join → 201，回显 scope = compute（旧拼写被写死覆盖）',
    j1.status === 201 && JSON.stringify(j1.body?.scope) === JSON.stringify(['compute']),
    `${j1.status} scope=${JSON.stringify(j1.body?.scope)}`);
  const cfgPath = path.join(DATA_NODE, 'config.json');
  const cfg = readJson(cfgPath);
  const KEYS = ['controlPlane', 'token', 'scope', 'joinedAt', 'hostLabel', 'hostHostname', 'hostInstanceId'];
  check('config.json 七键齐 + scope 落盘 compute',
    KEYS.every((k) => k in (cfg ?? {})) && cfg?.scope === 'compute', `scope=${cfg?.scope}`);
  check('lastHost 四字段齐、url=总机地址（只由 join 成功这一笔写）',
    ['instanceId', 'label', 'url', 'joinedAt'].every((k) => k in (cfg?.lastHost ?? {})) && cfg?.lastHost?.url === BASE_HOST,
    JSON.stringify(cfg?.lastHost ?? null).slice(0, 120));
  const bNodeId = readJson(path.join(DATA_NODE, 'node.json'))?.id ?? null;
  check('总机库 node_tokens.scope 落库 compute',
    JSON.stringify(hubScopes(path.join(DATA_HOST, 'bandi.db'), bNodeId)) === JSON.stringify(['compute']),
    `nodeId=${bNodeId} ${JSON.stringify(hubScopes(path.join(DATA_HOST, 'bandi.db'), bNodeId))}`);
  const st = await json(BASE_NODE, '/api/local/status');
  check('status() 顶层带出 lastHost', st.body?.lastHost?.url === BASE_HOST && st.body?.client?.joined === true,
    JSON.stringify(st.body?.lastHost ?? null).slice(0, 100));
  const html = await (await fetch(BASE_NODE + '/')).text();
  const state = await json(BASE_NODE, '/api/state');
  check('本机 UI 还是自己的（无反代注入标记，静态照常出）',
    !html.includes('__BANDI_CLIENT__') && html.includes('app.mjs'), `注入=${html.includes('__BANDI_CLIENT__')}`);
  check('加入后 /api/state 照常答（本机库，未被动过）', state.status === 200, `status=${state.status}`);
  const forbidden = await json(BASE_HOST, '/api/personas', { token: cfg?.token });
  check('节点令牌摸总机面板 → 403 E4031（闸还在，没面板可看）',
    forbidden.status === 403 && forbidden.body?.code === 'E4031',
    `${forbidden.status} ${forbidden.body?.code ?? ''}`);

  console.log('\n④ 退出总机：lastHost 保留');
  const leave = await json(BASE_NODE, '/api/local/leave', { method: 'POST' });
  const after = readJson(cfgPath);
  check('leave → 200；七键清但 lastHost **仍在**（文件保留，退出不清）',
    leave.status === 200 && fs.existsSync(cfgPath)
      && KEYS.every((k) => !(k in (after ?? {}))) && after?.lastHost?.url === BASE_HOST,
    `leave=${leave.status} 剩余键=${JSON.stringify(Object.keys(after ?? {}))}`);
  await sleep(600);

  console.log('\n⑤ 重加（旧拼写 scope 字符串）→ 照样强制 compute');
  const j2 = await json(BASE_NODE, '/api/local/join', {
    method: 'POST', body: { url: BASE_HOST, code: await invite(), scope: 'compute panel' } });
  check('重加 → 201，scope = compute（字符串拼写也一样被覆盖）',
    j2.status === 201 && JSON.stringify(j2.body?.scope) === JSON.stringify(['compute']),
    `${j2.status} scope=${JSON.stringify(j2.body?.scope)}`);
  const scopes = hubScopes(path.join(DATA_HOST, 'bandi.db'), bNodeId);
  check('总机库两枚令牌（数组那次 + 字符串这次）都是 compute',
    scopes.length === 2 && scopes.every((s) => s === 'compute'), JSON.stringify(scopes));

  console.log('\n⑥ 总机侧直连接口（node.mjs --join 那一路）');
  const jDir = await json(BASE_HOST, '/api/nodes/join', { method: 'POST',
    body: { code: await invite(), id: 'smoke-direct-node', label: '直连', hostname: 'smoke', platform: 'linux x64', scope: 'compute panel' } });
  check('POST /api/nodes/join 收 scope 字符串 → 201，回显规范串',
    jDir.status === 201 && jDir.body?.scope === 'compute panel', `${jDir.status} scope=${JSON.stringify(jDir.body?.scope)}`);

  console.log('\n⑦ 收尾：退出还原');
  const leave2 = await json(BASE_NODE, '/api/local/leave', { method: 'POST' });
  check('退出成功（把 spawn 的节点进程一起停掉）', leave2.status === 200, String(leave2.status));
} catch (err) {
  console.log('\n跑挂了：' + String(err?.message ?? err));
  for (const k of kids) console.log('--- 服务日志末尾 ---\n' + k.log().slice(-400));
  failed += 1;
} finally {
  for (const k of kids) { try { k.child.kill(); } catch { /* 已经退了 */ } }
  try { mockOld.close(); } catch { /* 已关 */ }
  await sleep(400);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
}

console.log(failed ? `\n✗ ${failed} 项没过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
