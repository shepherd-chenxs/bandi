/**
 * 「加入总机」端到端冒烟（2026-10-20，设计 §11 T05 / 增量 1 T03；2026-10-21 重写）。
 *
 * 2026-10-21 拍板：**节点只当算力，不做「看总机面板」** —— 反代（client-proxy）已删，
 * 加入一律 compute（服务端写死，不信任前端）。本文件验证六件事
 * （两个数据目录 + 一台缺省对照机 + 一个 mock 旧总机）：
 *   ① **总机可加入**：总机角色 `acceptNodes:true` → `/api/hello` 照样 `joinable:true`
 *      （监听缺省对外，2026-11-03 起"对外服务"维度已删，不用也没法再"开开关"）；
 *   ①b **分机形态**（2026-11-01 晚新增）：同一台切成 `acceptNodes:false` → 监听没动、
 *      对外照样服务，但 `joinable:false` + `POST /api/nodes/invites` 409 E1091
 *      （用户定稿："把 thinkpad-p15 开分机模式……不提供邀请码，其他的机器也加不上去"）；
 *   ② probe 三级判定顺序：E1090/E2050/E1091 各走各的出口，`E1091` 文案中性（不提「局域网」）；
 *   ③ 真加入（故意带旧拼写的 `scopes:['compute','panel']`）→ 服务端强制 compute：
 *      `config.json` 七键 + `lastHost`、总机库 `node_tokens.scope` 落库 `compute`、
 *      本机 UI 还是自己的（无注入标记、`/api/state` 答本机库）、
 *      节点令牌摸总机面板 → 403 `E4031`（那道闸还在）。
 *      ⚠️ 节点侧实例缺省对外监听 → 鉴权自动开：本文件对它的调用都带**它自己的**
 *      令牌（数据目录里首次启动生成的 `token` 文件）。
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
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { 'X-Bandi-Token': opts.token } : {}),
      ...(opts.local ? { 'X-Bandi-Local': opts.local } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeout ?? 15000),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const kids = [];
const startServer = (dataDir, port, extra = {}) => {
  /*
   * ⚠️ **剥掉继承来的 BANDI_HOST**（2026-11-03）：run-smokes 给所有子进程钉
   * `BANDI_HOST=127.0.0.1` 当免鉴权底座，而这台用例里"节点侧缺省对外监听 → 鉴权自动开"
   * 恰恰是被测前提（节点令牌/local_secret 都从这来）—— 不剥就跑到回环免鉴权上去，
   * token 文件根本不会生成。三台要什么监听，用例自己显式给。
   */
  const { BANDI_HOST: _inheritedHost, ...baseEnv } = process.env;
  const c = spawn(process.execPath, [SERVER], {
    cwd: repoRoot,
    env: { ...baseEnv, BANDI_DATA: dataDir, BANDI_PORT: String(port), ...extra },
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

/*
 * 角色位（2026-11-01 晚）：**收节点**要靠 `acceptNodes` 声明 —— 监听（缺省 0.0.0.0）
 * 跟角色再无关联，2026-11-03 起"对外服务"这一维整个删了。
 */
fs.writeFileSync(path.join(DATA_HOST, 'netmode.json'), JSON.stringify({ acceptNodes: true }, null, 2), 'utf8');

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
  loop = startServer(path.join(tmp, 'loop'), PORT_LOOP, { BANDI_HOST: '127.0.0.1' }); // 回环对照：显式钉，别吃缺省
  if (!(await waitReady(BASE_HOST))) throw new Error('总机没起来：' + (kids[0]?.log() ?? '').slice(-300));
  if (!(await waitReady(BASE_NODE))) throw new Error('节点侧服务没起来');
  if (!(await waitReady(BASE_LOOP))) throw new Error('回环对照机没起来');

  /*
   * 节点侧实例缺省对外监听 → 鉴权自动开、来源判 `network`（2026-11-03）：下面对它的
   * probe / join / leave 调用都带 **它自己的** 令牌 ＋ `X-Bandi-Local`（数据目录
   * `local_secret`）—— 这正是 `node.mjs --join` / CLI 那条路的真实形态（IAM §8.5）。
   */
  const nodeTok = fs.readFileSync(path.join(DATA_NODE, 'token'), 'utf8').trim();
  const nodeLocal = fs.readFileSync(path.join(DATA_NODE, 'local_secret'), 'utf8').trim();
  check('节点侧实例鉴权已开（令牌 + local_secret 落盘）', nodeTok.length > 20 && nodeLocal.length > 10, `${nodeTok.slice(0, 6)}…`);

  console.log('① 总机（acceptNodes:true）自己声明可加入（监听缺省对外，没有开关可开）');
  const hello = await json(BASE_HOST, '/api/hello');
  check('hello joinable=true 且 acceptNodes=true（角色说了算）',
    hello.body?.joinable === true && hello.body?.acceptNodes === true,
    JSON.stringify({ joinable: hello.body?.joinable, acceptNodes: hello.body?.acceptNodes }));
  const helloLoop = await json(BASE_LOOP, '/api/hello');
  check('缺省对照机（没写 acceptNodes）joinable=false（角色说了算，跟监听无关）',
    helloLoop.body?.joinable === false, `joinable=${helloLoop.body?.joinable}`);

  console.log('\n①b 同一台切成「分机」：监听不动、但不再收节点（无需重启）');
  const toBranch = await json(BASE_HOST, '/api/lan', { method: 'POST', token: OP_TOKEN, body: { acceptNodes: false } });
  check('POST /api/lan {acceptNodes:false} → 200，role=branch（角色不碰监听）',
    toBranch.status === 200 && toBranch.body?.acceptNodes === false && toBranch.body?.role === 'branch'
      && toBranch.body?.boundLan === true,
    JSON.stringify({ acceptNodes: toBranch.body?.acceptNodes, role: toBranch.body?.role, boundLan: toBranch.body?.boundLan }));
  const helloBranch = await json(BASE_HOST, '/api/hello');
  check('分机仍对外服务（监听不动）但 joinable=false',
    helloBranch.body?.acceptNodes === false && helloBranch.body?.joinable === false,
    JSON.stringify({ acceptNodes: helloBranch.body?.acceptNodes, joinable: helloBranch.body?.joinable }));
  const inviteBranch = await json(BASE_HOST, '/api/nodes/invites', { method: 'POST', token: OP_TOKEN });
  check('分机发邀请码 → 409 E1091（其他机器加不上去）',
    inviteBranch.status === 409 && inviteBranch.body?.code === 'E1091',
    `${inviteBranch.status} ${inviteBranch.body?.code ?? ''}`);
  const backHub = await json(BASE_HOST, '/api/lan', { method: 'POST', token: OP_TOKEN, body: { acceptNodes: true } });
  check('切回总机 → 200 且 joinable 恢复 true（同一进程，没重启）',
    backHub.status === 200 && backHub.body?.acceptNodes === true
      && (await json(BASE_HOST, '/api/hello')).body?.joinable === true,
    JSON.stringify({ acceptNodes: backHub.body?.acceptNodes }));

  console.log('\n② probe 三级判定（顺序即语义）');
  const pUp = await json(BASE_NODE, '/api/local/probe', { method: 'POST', token: nodeTok, local: nodeLocal, body: { url: BASE_HOST } });
  check('probe 云端总机 → 200（旧行为这里会误报 E1091）',
    pUp.status === 200 && pUp.body?.host?.joinable === true,
    `${pUp.status} host.joinable=${pUp.body?.host?.joinable}`);
  const pLoop = await json(BASE_NODE, '/api/local/probe', { method: 'POST', token: nodeTok, local: nodeLocal, body: { url: BASE_LOOP } });
  check('probe 回环总机 → 400 E1091，文案中性（不提「局域网」）',
    pLoop.status === 400 && pLoop.body?.code === 'E1091' && !String(pLoop.body?.error ?? '').includes('局域网'),
    `${pLoop.status} ${JSON.stringify(pLoop.body?.error)}`);
  const pOld = await json(BASE_NODE, '/api/local/probe', { method: 'POST', token: nodeTok, local: nodeLocal, body: { url: BASE_MOCK } });
  check('probe 旧总机（hello 无 joinable 字段）→ 409 E2050，不静默降级',
    pOld.status === 409 && pOld.body?.code === 'E2050', `${pOld.status} ${pOld.body?.code ?? ''}`);
  const pDead = await json(BASE_NODE, '/api/local/probe', { method: 'POST', token: nodeTok, local: nodeLocal, body: { url: `http://127.0.0.1:${PORT_DEAD}` } });
  check('probe 没人听的地址 → 400 E1092', pDead.status === 400 && pDead.body?.code === 'E1092',
    `${pDead.status} ${pDead.body?.code ?? ''}`);

  console.log('\n③ 真加入（故意带旧拼写的 scopes —— 服务端必须强制成 compute）');
  const j1 = await json(BASE_NODE, '/api/local/join', {
    method: 'POST', token: nodeTok, local: nodeLocal, body: { url: BASE_HOST, code: await invite(), scopes: ['compute', 'panel'] } });
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
  const st = await json(BASE_NODE, '/api/local/status', { token: nodeTok });
  check('status() 顶层带出 lastHost', st.body?.lastHost?.url === BASE_HOST && st.body?.client?.joined === true,
    JSON.stringify(st.body?.lastHost ?? null).slice(0, 100));
  const html = await (await fetch(BASE_NODE + '/')).text();
  const state = await json(BASE_NODE, '/api/state', { token: nodeTok });
  /*
   * 判据（2026-11-01 改）：新数据目录首次启动出的是「班底 · 创建账号」引导页，
   * 里面没有 app.mjs —— 原来找 app.mjs 的写法在这条产品流程下必然红（不是节点注入）。
   * 这里要验的其实是两件事：**没有被反代注入壳标记** + **出的仍是班底自己的页面**。
   */
  check('本机 UI 还是自己的（无反代注入标记，出的是班底自己的页面）',
    !html.includes('__BANDI_CLIENT__') && (html.includes('app.mjs') || html.includes('班底')),
    `注入=${html.includes('__BANDI_CLIENT__')}`);
  check('加入后 /api/state 照常答（本机库，未被动过）', state.status === 200, `status=${state.status}`);
  // v2.8：裸 /api/personas 是幽灵路由（未登记、无 handler）→ 404 E4090；
  // 节点令牌的 E4031 闸改打真实登记的面板路由 /api/experts
  const forbidden = await json(BASE_HOST, '/api/experts', { token: cfg?.token });
  check('节点令牌摸总机面板 → 403 E4031（闸还在，没面板可看）',
    forbidden.status === 403 && forbidden.body?.code === 'E4031',
    `${forbidden.status} ${forbidden.body?.code ?? ''}`);

  console.log('\n④ 退出总机：lastHost 保留');
  const leave = await json(BASE_NODE, '/api/local/leave', { method: 'POST', token: nodeTok, local: nodeLocal });
  const after = readJson(cfgPath);
  check('leave → 200；七键清但 lastHost **仍在**（文件保留，退出不清）',
    leave.status === 200 && fs.existsSync(cfgPath)
      && KEYS.every((k) => !(k in (after ?? {}))) && after?.lastHost?.url === BASE_HOST,
    `leave=${leave.status} 剩余键=${JSON.stringify(Object.keys(after ?? {}))}`);
  await sleep(600);

  console.log('\n⑤ 重加（旧拼写 scope 字符串）→ 照样强制 compute');
  const j2 = await json(BASE_NODE, '/api/local/join', {
    method: 'POST', token: nodeTok, local: nodeLocal, body: { url: BASE_HOST, code: await invite(), scope: 'compute panel' } });
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
  const leave2 = await json(BASE_NODE, '/api/local/leave', { method: 'POST', token: nodeTok, local: nodeLocal });
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
