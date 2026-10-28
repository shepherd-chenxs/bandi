/**
 * 设备角色下发（2026-10-28 第四刀）的验收。
 *
 * 这一刀把「角色 → 菜单」这张表从**登录的浏览器**送到**节点机**与**手机**上，钉的边界：
 *   ① 没分配角色时，节点/手机的菜单与今天**完全一致**（默认角色 = node-ops / mobile）；
 *   ② 给节点换角色 → **下一次心跳**的 `panelRole` 就变了；改回 null → 恢复默认；
 *   ③ 节点进程把 `panelRole` 落进 `node-panel.json`（内容没变不重写、写坏了不影响心跳）；
 *   ④ 本地面板读它（`localMode.readPanelRole`）；
 *   ⑤ 手机：`/api/me` 的 `role` 跟着变；null → 恢复默认；
 *   ⑥ 被节点/手机绑着的角色**删不掉**（409 E2071，文案说清数量）。
 *
 * 隔离：临时数据目录 + 临时端口 + 临时节点状态文件，跑完全删，不碰 data/。
 * 跑法：node apps/server/src/smoke-device-roles.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { repoRoot } from './config.mjs';
import { sleep, stopRunning } from './lifecycle.mjs';

const PORT = Number(process.env.SMOKE_PORT ?? 8807);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-devroles-'));
const NODE_DATA = path.join(tmp, 'node-side'); // 模拟"那台被管的机器"的数据目录
const SERVER = path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs');
const NODE = path.join(repoRoot, 'apps', 'server', 'src', 'node.mjs');
const TOKEN = 'smoke-devroles-token';
const NODE_ID = 'node-devrole';

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

let child = null;
let log = '';
function start(extraEnv = {}) {
  log = '';
  child = spawn(process.execPath, [SERVER], {
    cwd: repoRoot,
    env: {
      ...process.env,
      BANDI_PORT: String(PORT),
      BANDI_DATA: tmp,
      BANDI_DB: path.join(tmp, 'bandi.db'),
      ...extraEnv,
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
}

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

/** 统一请求：`cookie` / `token` 二选一，写请求都带 X-Bandi（来源闸认它） */
const call = async (method, p, { body, cookie, token } = {}) => {
  const headers = { 'Content-Type': 'application/json', 'X-Bandi': '1' };
  if (cookie) headers.Cookie = cookie;
  if (token) headers['X-Bandi-Token'] = token;
  const r = await fetch(BASE + p, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(8000),
  });
  const raw = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* HTML / 空 */ }
  return { status: r.status, body: parsed, raw, setCookie: r.headers.get('set-cookie') ?? '' };
};

const cookieOf = (sc, name = 'bandi_token') => {
  const m = new RegExp(`${name}=([^;]*)`).exec(sc ?? '');
  return m ? `${name}=${m[1]}` : '';
};

/** 跑一次节点进程（--once：报到 + 心跳一次就退），返回它的输出 */
function runNodeOnce() {
  return new Promise((resolve) => {
    let out = '';
    const c = spawn(process.execPath, [NODE, '--once'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        BANDI_DATA: NODE_DATA,
        BANDI_NODE_STATE: path.join(NODE_DATA, 'node.json'),
        BANDI_CONTROL_PLANE: BASE,
        BANDI_NODE_TOKEN: nodeToken,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('exit', () => resolve(out));
  });
}

const panelFile = () => path.join(NODE_DATA, 'node-panel.json');
const readPanelFile = () => {
  try { return JSON.parse(fs.readFileSync(panelFile(), 'utf8')); } catch { return null; }
};

async function stopAll() {
  try { child?.kill(); } catch { /* 已退 */ }
  await sleep(500);
  try { stopRunning(PORT); } catch { /* 没在跑 */ }
  await sleep(300);
}

const cleanup = async () => {
  await stopAll();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
};

let nodeToken = '';
const NODE_KEYS = ['node.connection', 'node.machine', 'node.runtimes', 'node.access', 'node.data', 'node.about'];

try {
  start({ BANDI_HOST: '0.0.0.0', BANDI_TOKEN: TOKEN });
  if (!(await waitUp())) throw new Error('实例没起来：' + log.slice(-500));

  /* ============ ① 造一台节点（邀请码 → 加入 → 报到） ============ */
  console.log('① 造一台节点：邀请码 → 加入 → 心跳');
  const inv = await call('POST', '/api/nodes/invites', { token: TOKEN });
  check('操作员发邀请码 → 201', inv.status === 201 && /^bj_/.test(inv.body?.code ?? ''), `${inv.status}`);
  const join = await call('POST', '/api/nodes/join', {
    body: {
      code: inv.body?.code,
      id: NODE_ID,
      label: '测试机',
      hostname: 'test-host',
      platform: 'linux x64',
      runtimes: [],
    },
  });
  nodeToken = join.body?.token ?? '';
  check('凭码加入 → 换回自己那枚令牌', join.status === 201 && /^bn_/.test(nodeToken), `${join.status}`);
  // 节点侧要有一份身份文件：node.mjs 的 id 认文件不认主机名
  fs.mkdirSync(NODE_DATA, { recursive: true });
  fs.writeFileSync(
    path.join(NODE_DATA, 'node.json'),
    `${JSON.stringify({ id: NODE_ID, createdAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );

  const hb0 = await call('POST', `/api/nodes/${NODE_ID}/heartbeat`, { token: nodeToken, body: {} });
  check('心跳 → 200', hb0.status === 200, `${hb0.status} ${hb0.body?.code ?? ''}`);
  check('未分配 → panelRole 是默认「节点运维」', hb0.body?.panelRole?.id === 'node-ops',
    String(hb0.body?.panelRole?.id));
  check('默认角色带六个 node.* key（与今天一致）',
    NODE_KEYS.every((k) => (hb0.body?.panelRole?.menuKeys ?? []).includes(k))
      && hb0.body?.panelRole?.menuKeys.length === NODE_KEYS.length,
    JSON.stringify(hb0.body?.panelRole?.menuKeys));
  check('老字段一个没动（node / heartbeatSeconds 还在）',
    !!hb0.body?.node && hb0.body?.heartbeatSeconds > 0,
    `${!!hb0.body?.node} ${hb0.body?.heartbeatSeconds}`);

  /* ============ ② 建自建角色 → 分配给节点 → 下一次心跳生效 ============ */
  console.log('\n② 建自建角色 → 分配给节点');
  const roleNode = await call('POST', '/api/roles', {
    token: TOKEN,
    body: { name: '只看连接和数据', menuKeys: ['node.connection', 'node.data'] },
  });
  const roleNodeId = roleNode.body?.role?.id;
  check('建一个只带两个 node.* key 的角色 → 201', roleNode.status === 201 && !!roleNodeId, `${roleNode.status}`);
  const assign = await call('POST', `/api/nodes/${NODE_ID}/role`, { token: TOKEN, body: { roleId: roleNodeId } });
  check('分配 → 200 且回显 panelRole', assign.status === 200 && assign.body?.panelRole?.id === roleNodeId,
    `${assign.status} ${assign.body?.panelRole?.id ?? ''}`);
  const hb1 = await call('POST', `/api/nodes/${NODE_ID}/heartbeat`, { token: nodeToken, body: {} });
  check('下一次心跳的 panelRole 变成它（只 2 个 key）',
    hb1.body?.panelRole?.id === roleNodeId && hb1.body.panelRole.menuKeys.length === 2,
    JSON.stringify(hb1.body?.panelRole));
  const listed = await call('GET', '/api/nodes', { token: TOKEN });
  check('设备列表带出 roleId（详情页下拉要靠它回显）',
    listed.body?.nodes?.find((n) => n.id === NODE_ID)?.roleId === roleNodeId,
    String(listed.body?.nodes?.find((n) => n.id === NODE_ID)?.roleId));

  /* ============ ③ 节点进程把 panelRole 落进 node-panel.json ============ */
  console.log('\n③ 节点进程落盘：node-panel.json');
  const out1 = await runNodeOnce();
  check('--once 跑完（没有报错）', !/报到被拒|连不上控制面/.test(out1), out1.trim().split('\n').slice(-1)[0] ?? '');
  const f1 = readPanelFile();
  check('node-panel.json 写出来了', !!f1, panelFile());
  check('文件里的角色 = 刚分配的那个', f1?.roleId === roleNodeId, String(f1?.roleId ?? 'null'));
  check('文件里带着菜单清单（2 个）', Array.isArray(f1?.menuKeys) && f1.menuKeys.length === 2,
    JSON.stringify(f1?.menuKeys));
  check('落了时间戳（排查"上次下发是什么时候"用）', typeof f1?.at === 'string', String(f1?.at ?? ''));

  /*
   * 本地面板读的就是这个文件（`local-mode.readPanelRole`）。**在子进程里读**：
   * `local-mode.mjs` 在模块求值时就把 `dataDir` 定下来了，本进程改 env 影响不到它。
   */
  const reader =
    `import { readPanelRole } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, 'apps', 'server', 'src', 'local-mode.mjs')).href)};` +
    `import { status } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, 'apps', 'server', 'src', 'local-mode.mjs')).href)};` +
    'console.log(JSON.stringify({ panelRole: readPanelRole(), inStatus: status().panelRole }));';
  const readBack = await new Promise((resolve) => {
    let out = '';
    const c = spawn(process.execPath, ['--input-type=module', '-e', reader], {
      cwd: repoRoot,
      env: { ...process.env, BANDI_DATA: NODE_DATA },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('exit', () => resolve(out.trim()));
  });
  let parsedRead = null;
  try { parsedRead = JSON.parse(readBack.split('\n').filter(Boolean).pop()); } catch { /* 下面判 */ }
  check('localMode.readPanelRole 读出来是那个角色', parsedRead?.panelRole?.id === roleNodeId,
    readBack.slice(-160));
  check('status().panelRole 也带上了（本地面板的取数口）', parsedRead?.inStatus?.id === roleNodeId,
    JSON.stringify(parsedRead?.inStatus ?? null));

  /* ============ ④ 改回默认 ============ */
  console.log('\n④ roleId:null → 恢复默认（节点）');
  const reset = await call('POST', `/api/nodes/${NODE_ID}/role`, { token: TOKEN, body: { roleId: null } });
  check('改回默认 → 200', reset.status === 200, `${reset.status}`);
  check('回显默认 node-ops', reset.body?.panelRole?.id === 'node-ops', String(reset.body?.panelRole?.id));
  const hb2 = await call('POST', `/api/nodes/${NODE_ID}/heartbeat`, { token: nodeToken, body: {} });
  check('心跳回默认（六个 key 都回来了）',
    hb2.body?.panelRole?.id === 'node-ops' && hb2.body.panelRole.menuKeys.length === 6,
    JSON.stringify(hb2.body?.panelRole));
  await runNodeOnce();
  const f2 = readPanelFile();
  check('node-panel.json 跟着改成默认（内容变了才重写）',
    f2?.roleId === 'node-ops' && f2?.menuKeys?.length === 6, JSON.stringify(f2?.menuKeys ?? null));

  /* ============ ⑤ 手机 ============ */
  console.log('\n⑤ 手机：配对 → /api/me 的 role');
  const pt = await call('POST', '/api/pair/tokens', { token: TOKEN });
  check('发配对码 → 200', pt.status === 200 && /^bp_/.test(pt.body?.token ?? ''), `${pt.status}`);
  const claim = await call('POST', '/api/pair/claim', { body: { token: pt.body?.token, name: '测试手机' } });
  const devCookie = cookieOf(claim.setCookie);
  const deviceId = claim.body?.deviceId;
  check('配对成功且拿到设备令牌', claim.status === 200 && !!devCookie && !!deviceId, `${claim.status} ${deviceId}`);
  const me0 = await call('GET', '/api/me', { cookie: devCookie });
  check('未分配 → role 是默认「手机」', me0.body?.role?.id === 'mobile', String(me0.body?.role?.id ?? me0.body?.code));
  check('默认角色 = 底部那四个 tab（与今天一致）',
    ['messages', 'contacts', 'workbench', 'settings'].every((k) => (me0.body?.role?.menuKeys ?? []).includes(k))
      && me0.body.role.menuKeys.length === 4,
    JSON.stringify(me0.body?.role?.menuKeys));

  const rolePhone = await call('POST', '/api/roles', {
    token: TOKEN,
    body: { name: '只给会话', menuKeys: ['messages'] },
  });
  const rolePhoneId = rolePhone.body?.role?.id;
  check('建一个只带 messages 的角色 → 201', rolePhone.status === 201 && !!rolePhoneId, `${rolePhone.status}`);
  const devs0 = await call('GET', '/api/pair/devices', { token: TOKEN });
  check('设备列表带出 roleId 字段（未分配 = null）',
    devs0.body?.devices?.some((d) => d.id === deviceId && d.roleId === null), JSON.stringify(devs0.body?.devices?.[0] ?? {}));
  const setPhone = await call('POST', `/api/pair/devices/${encodeURIComponent(deviceId)}/role`, {
    token: TOKEN,
    body: { roleId: rolePhoneId },
  });
  check('给手机分配 → 200', setPhone.status === 200, `${setPhone.status} ${setPhone.body?.code ?? ''}`);
  const me1 = await call('GET', '/api/me', { cookie: devCookie });
  check('/api/me 的 role 跟着变（只 1 个 key）',
    me1.body?.role?.id === rolePhoneId && me1.body.role.menuKeys.length === 1,
    JSON.stringify(me1.body?.role ?? null));
  const setPhoneNull = await call('POST', `/api/pair/devices/${encodeURIComponent(deviceId)}/role`, {
    token: TOKEN,
    body: { roleId: null },
  });
  check('改回默认 → 200', setPhoneNull.status === 200, `${setPhoneNull.status}`);
  const me2 = await call('GET', '/api/me', { cookie: devCookie });
  check('/api/me 恢复默认「手机」', me2.body?.role?.id === 'mobile' && me2.body.role.menuKeys.length === 4,
    JSON.stringify(me2.body?.role ?? null));

  /* ============ ⑥ 删角色保护（设备也算引用） ============ */
  console.log('\n⑥ 被节点/手机绑着的角色删不掉（E2071）');
  await call('POST', `/api/nodes/${NODE_ID}/role`, { token: TOKEN, body: { roleId: roleNodeId } });
  const delNodeUse = await call('DELETE', `/api/roles/${encodeURIComponent(roleNodeId)}`, { token: TOKEN });
  check('节点还绑着 → 409 E2071', delNodeUse.status === 409 && delNodeUse.body?.code === 'E2071',
    `${delNodeUse.status} ${delNodeUse.body?.code ?? ''}`);
  check('文案说清了是"节点机"在用', /节点机/.test(delNodeUse.body?.error ?? ''), String(delNodeUse.body?.error ?? ''));
  await call('POST', `/api/nodes/${NODE_ID}/role`, { token: TOKEN, body: { roleId: null } });
  const delFree = await call('DELETE', `/api/roles/${encodeURIComponent(roleNodeId)}`, { token: TOKEN });
  check('解绑后能删 → 200', delFree.status === 200, `${delFree.status} ${delFree.body?.code ?? ''}`);

  await call('POST', `/api/pair/devices/${encodeURIComponent(deviceId)}/role`, { token: TOKEN, body: { roleId: rolePhoneId } });
  const delPhoneUse = await call('DELETE', `/api/roles/${encodeURIComponent(rolePhoneId)}`, { token: TOKEN });
  check('手机还绑着 → 409 E2071', delPhoneUse.status === 409 && delPhoneUse.body?.code === 'E2071',
    `${delPhoneUse.status} ${delPhoneUse.body?.code ?? ''}`);
  check('文案说清了是"手机"在用', /手机/.test(delPhoneUse.body?.error ?? ''), String(delPhoneUse.body?.error ?? ''));
  await call('POST', `/api/pair/devices/${encodeURIComponent(deviceId)}/role`, { token: TOKEN, body: { roleId: null } });
  check('解绑后能删 → 200',
    (await call('DELETE', `/api/roles/${encodeURIComponent(rolePhoneId)}`, { token: TOKEN })).status === 200);

  /*
   * 被踢出的手机**不再算「在用」**（2026-10-28 修）：
   * 设备行留着当记录、下拉又被禁用，要是还占着角色，那个角色就永远删不掉。
   * 判据是"名下有有效令牌"，这条钉住它。
   */
  const roleKicked = await call('POST', '/api/roles', { token: TOKEN, body: { name: '被踢手机的角色', menuKeys: ['messages'] } });
  const roleKickedId = roleKicked.body?.role?.id;
  await call('POST', `/api/pair/devices/${encodeURIComponent(deviceId)}/role`, { token: TOKEN, body: { roleId: roleKickedId } });
  await call('POST', `/api/pair/devices/${encodeURIComponent(deviceId)}/revoke`, { token: TOKEN });
  const delKicked = await call('DELETE', `/api/roles/${encodeURIComponent(roleKickedId)}`, { token: TOKEN });
  check('手机被踢出后不再算「在用」→ 角色能删 → 200', delKicked.status === 200,
    `${delKicked.status} ${delKicked.body?.code ?? ''}`);

  /* ============ ⑦ 边界 ============ */
  console.log('\n⑦ 边界：坏角色 / 不存在的节点 / 没有操作员身份');
  const badRole = await call('POST', `/api/nodes/${NODE_ID}/role`, { token: TOKEN, body: { roleId: 'role-不存在' } });
  check('分配一个不存在的角色 → 400 E2072', badRole.status === 400 && badRole.body?.code === 'E2072',
    `${badRole.status} ${badRole.body?.code ?? ''}`);
  check('不存在的节点 → 404 E2040',
    (await call('POST', '/api/nodes/node-没有这个/role', { token: TOKEN, body: { roleId: null } })).status === 404);
  check('不存在的手机 → 404 E2701',
    (await call('POST', '/api/pair/devices/md-没有这个/role', { token: TOKEN, body: { roleId: null } })).status === 404);
  const anon = await call('POST', `/api/nodes/${NODE_ID}/role`, { body: { roleId: null } });
  check('不带任何凭据 → 401（非回环形态）', anon.status === 401, `${anon.status} ${anon.body?.code ?? ''}`);
  const byNodeToken = await call('POST', `/api/nodes/${NODE_ID}/role`, { token: nodeToken, body: { roleId: null } });
  check('节点自己的令牌改不了自己的角色（能自升级 = 没有边界）',
    byNodeToken.status === 403 || byNodeToken.status === 401,
    `${byNodeToken.status} ${byNodeToken.body?.code ?? ''}`);

  /* ============ ⑧ 老总机 = 不动已有缓存 ============ */
  console.log('\n⑧ 老总机不认这个字段：已有缓存一个字节都不动');
  /*
   * 模拟"总机升级前给过一个角色、升级后又把角色删了"这种夹缝：直接改小盘子里的文件，
   * 再让节点跑一次 --once —— 心跳响应带上默认角色，文件就该被改成默认；
   * 而"响应里没有 panelRole"这条路由老总机走，本用例没法直接造，
   * 所以只验"同一份内容不会重复写"（`at` 保持第一次的值）。
   */
  await runNodeOnce();
  const atBefore = readPanelFile()?.at;
  await sleep(1100); // 让时间戳一定会变（毫秒级，1.1 秒足够）
  await runNodeOnce();
  const atAfter = readPanelFile()?.at;
  check('内容没变 → 不重写（at 没动，心跳不拿磁盘当日志写）', atBefore && atBefore === atAfter,
    `${atBefore} → ${atAfter}`);

  console.log(`\n${failed ? '✗ 有 ' + failed + ' 项没过' : '✓ 全部通过'}`);
} catch (err) {
  failed += 1;
  console.error('\n✗ 冒烟跑挂了：', err?.message ?? err);
  if (log) console.error('服务端日志尾部：\n' + log.slice(-1200));
} finally {
  await cleanup();
}

process.exit(failed ? 1 : 0);
