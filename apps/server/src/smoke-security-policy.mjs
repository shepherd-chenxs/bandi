/*
 * smoke-security-policy.mjs —— Phase 2 验收（IAM §8.1-§8.4）：
 *   · 词表/清单的**纯逻辑**校验（perm 拼写、登记项唯一、受限会话白名单口径）；
 *   · **覆盖率扫描**：routes/*.mjs + server.mjs 里出现的每个 /api 字面量必须已登记
 *     （"未登记即拒绝"的另一面 = "存在的接口必须登记"，漏登记 = 上线即 404）；
 *   · **身份 × 路由矩阵**（起真服务）：operator / admin / 成员 / panel / compute /
 *     device / revoked 七种身份对基线、管理面、节点自端点的判定；
 *   · **role_permissions 解锁**：给角色授 `user:manage` → 成员能读用户名册；
 *     收回 → 403（权限在库里、PDP 每请求查，§7.1）。
 *
 * 跑法：`node smoke-security-policy.mjs`（自管临时数据目录与端口 8903）。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ROUTES, isRegistered, findRoute } from './security/route-policy.mjs';
import { PERMS, isValidPerm } from './security/permissions.mjs';
import { RESTRICTED_OPEN } from './security/policy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, 'server.mjs');
const PORT = 8903;
const BASE = `http://127.0.0.1:${PORT}`;

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failed += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------- A. 纯逻辑校验 */

console.log('\nA. 词表与清单的纯逻辑校验');
check('RESTRICTED_OPEN 与 §8.6 白名单逐字一致',
  RESTRICTED_OPEN.length === 5
  && RESTRICTED_OPEN.some((r) => r.method === 'GET' && r.path === '/api/me')
  && RESTRICTED_OPEN.some((r) => r.method === 'GET' && r.path === '/api/state')
  && RESTRICTED_OPEN.some((r) => r.method === 'GET' && r.path === '/api/skills')
  && RESTRICTED_OPEN.some((r) => r.method === 'GET' && r.path === '/api/web-version')
  && RESTRICTED_OPEN.some((r) => r.method === 'POST' && r.path === '/api/me/password'),
  JSON.stringify(RESTRICTED_OPEN));

{
  const ids = new Set();
  let dup = null;
  for (const r of ROUTES) {
    if (ids.has(r.id)) { dup = r.id; break; }
    ids.add(r.id);
  }
  check('登记项 id 唯一', !dup, dup ?? '');
}
{
  const bad = ROUTES.filter((r) => r.perm && !isValidPerm(r.perm)).map((r) => `${r.id}:${r.perm}`);
  check('清单里每个 perm 都在词表里（§8.1 拼写闸）', bad.length === 0, bad.join(', '));
  check('词表含管理四权 + 敏感四权',
    ['user:manage', 'role:manage', 'collab:manage', 'machine:manage', 'audit:read', 'data:export', 'data:import', 'security:manage'].every((p) => PERMS.includes(p)));
}
{
  // 节点自端点必须排在通配 :id 条目之前（smoke-auth ⑥ 的教训：register 被 :id 抢走）
  const idx = (id) => ROUTES.findIndex((r) => r.id === id);
  check('nodes.register 登记在 nodes.one（/api/nodes/:id）之前', idx('nodes.register') < idx('nodes.one'), `${idx('nodes.register')} vs ${idx('nodes.one')}`);
  check('/api/nodes/register 解析到 compute 条目', findRoute('/api/nodes/register', 'POST')?.id === 'nodes.register');
  check('/api/local/status 解析到成员条目（分机状态页）', findRoute('/api/local/status', 'GET')?.id === 'local.status.forUser');
  check('POST /api/quota 解析到 noPanel 条目（方法感知）', findRoute('/api/quota', 'POST')?.id === 'quota.write' && findRoute('/api/quota', 'GET')?.id === 'quota.read');
}

/* ------------------------------------------------- B. 覆盖率扫描（静态） */

console.log('\nB. 覆盖率扫描：handler 里的 /api 字面量必须已登记');
{
  const dir = path.join(here, 'routes');
  const files = [...fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')).map((f) => path.join(dir, f)), path.join(here, 'server.mjs')];
  // 只看**匹配逻辑行**（exec / === / startsWith / match），注释与响应体里的路径不算
  const lineRe = /(exec\(|===\s*'|startsWith\('|\.match\()/;
  const litRe = /\/api\/[A-Za-z0-9_\-/]*/g;
  const misses = [];
  let scanned = 0;
  for (const f of files) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!lineRe.test(line)) continue;
      for (const m of line.matchAll(litRe)) {
        let lit = m[0].replace(/\/+$/, ''); // 前缀字面量（startsWith('/api/ai/')）去尾斜杠
        if (!lit || lit === '/api') continue;
        scanned += 1;
        if (!literalRegistered(lit)) misses.push(`${path.basename(f)}: ${lit}`);
      }
    }
  }
  check(`扫描了 ${scanned} 个字面量，全部已登记（漏登记 = 上线即 404 E4090）`, misses.length === 0, misses.slice(0, 6).join(' | '));
  check('反向：瞎编的路径没登记（默认拒绝的对照组）', !isRegistered('/api/definitely/not/here') && !isRegistered('/api/users/xyz/escalate'));
}
function literalRegistered(lit) {
  const esc = lit.replace(/\//g, '\\/');
  return ROUTES.some((r) => r.path.source.includes(esc));
}

/* ----------------------------------------------------- C. 真服务身份矩阵 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-secpol-'));
let child = null;
const started = [];
function startSrv(extra = {}) {
  const c = spawn(process.execPath, [SERVER], {
    cwd: path.join(here, '..', '..'),
    env: { ...process.env, BANDI_PORT: String(PORT), BANDI_DATA: tmp, BANDI_DB: path.join(tmp, 'bandi.db'), ...extra },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  started.push(c);
  let log = '';
  c.stdout.on('data', (d) => (log += d));
  c.stderr.on('data', (d) => (log += d));
  return { child: c, log: () => log };
}
async function waitUp(ms = 15000) {
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
async function killAll() {
  for (const c of started.splice(0)) { try { c.kill(); } catch { /* 已退 */ } }
  await sleep(600);
}

const call = async (method, p, { body, headers: extra = {}, noProxy } = {}) => {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });
  const raw = await r.text();
  let json = null;
  try { json = JSON.parse(raw); } catch { /* HTML */ }
  return { status: r.status, json, raw, setCookie: r.headers.get('set-cookie') ?? '' };
};
const OP_TOKEN = 'sec-pol-op-token';
const OP = () => ({ 'X-Bandi-Token': OP_TOKEN });
/** 单浏览器 cookie jar：bandi_sid + bandi_csrf 都记住、都回传（CSRF 双提交） */
function jar() {
  const kv = {};
  return {
    async call(method, p, { body } = {}) {
      const headers = { Cookie: Object.entries(kv).map(([k, v]) => `${k}=${v}`).join('; ') };
      if (kv.bandi_csrf) headers['X-Bandi-CSRF'] = kv.bandi_csrf;
      const r = await call(method, p, { body, headers });
      for (const piece of r.setCookie.split(/(?=bandi_[a-z]+=)/)) {
        const mm = /^(bandi_[a-z]+)=([^;]*)/.exec(piece.trim());
        if (mm) kv[mm[1]] = mm[2];
      }
      return r;
    },
  };
}

try {
  console.log('\nC. 真服务身份矩阵（0.0.0.0 服务器形态）');
  startSrv({ BANDI_HOST: '0.0.0.0', BANDI_TOKEN: OP_TOKEN });
  if (!(await waitUp())) throw new Error('服务没起来');

  // ① operator（共享令牌）：清单内全通，未登记 404
  check('operator 读 /api/state → 200', (await call('GET', '/api/state', { headers: OP() })).status === 200);
  const nope = await call('GET', '/api/definitely/not/here', { headers: OP() });
  check('未登记路径 → 404 E4090（连 operator 也不存在"清单外接口"）', nope.status === 404 && nope.json?.code === 'E4090', `${nope.status} ${nope.json?.code}`);

  // ② 建两个账号：admin 与成员（都带密码，登录换会话）。
  // 服务器形态首账号要引导码（§8.6）：setup_code 在数据目录里，建成即删 —— 只对第一个账号带上。
  const setupCode = () => { try { return fs.readFileSync(path.join(tmp, 'setup_code'), 'utf8').trim(); } catch { return ''; } };
  const mk = async (name, admin) => call('POST', '/api/users', {
    headers: { ...OP(), ...(setupCode() ? { 'X-Bandi-Setup': setupCode() } : {}) },
    body: { name, password: `${name}-pass-123`, roleId: admin ? 'admin' : 'operator' },
  });
  check('建 admin 账号 → 201', (await mk('甲', true)).status === 201);
  check('建成员账号 → 201', (await mk('乙', false)).status === 201);
  const login = async (name) => {
    const j = jar();
    const r = await j.call('POST', '/api/login', { body: { name, password: `${name}-pass-123` } });
    return r.status === 200 ? j : null;
  };
  const adminJ = await login('甲');
  const memberJ = await login('乙');
  check('两个账号都能登录', !!adminJ && !!memberJ);

  // ③ 成员基线：能读总览，摸不到管理面
  check('成员读 /api/state → 200（基线）', (await memberJ.call('GET', '/api/state')).status === 200);
  const usersByMember = await memberJ.call('GET', '/api/users');
  check('成员读 /api/users → 403 E4033（user:manage 不在基线）', usersByMember.status === 403 && usersByMember.json?.code === 'E4033', `${usersByMember.status} ${usersByMember.json?.code}`);
  const rolesByMember = await memberJ.call('GET', '/api/roles');
  check('成员读 /api/roles → 403 E4033', rolesByMember.status === 403 && rolesByMember.json?.code === 'E4033', String(rolesByMember.status));
  const auditByMember = await memberJ.call('GET', '/api/security/audit');
  check('成员读审计 → 403 E4033（audit:read 敏感权）', auditByMember.status === 403, String(auditByMember.status));
  const mePw = await memberJ.call('POST', '/api/me/password', { body: { currentPassword: 'nope-wrong', newPassword: 'x-pass-123' } });
  check('成员改自己密码不被 PDP 拦（业务层拒错密码即可）', mePw.status !== 403 && mePw.status !== 404, `${mePw.status} ${mePw.json?.code ?? ''}`);  const convByMember = await memberJ.call('GET', '/api/users/whatever/none');
  check('成员打未登记子路径 → 404 E4090（不是 403）', convByMember.status === 404 && convByMember.json?.code === 'E4090', `${convByMember.status} ${convByMember.json?.code}`);

  // ④ admin 直通
  check('admin 读 /api/users → 200', (await adminJ.call('GET', '/api/users')).status === 200);
  check('admin 读审计 → 200', (await adminJ.call('GET', '/api/security/audit')).status === 200);

  // ⑤ compute 令牌：自端点可、管理面 E4031
  const inv = await call('POST', '/api/nodes/invites', { headers: OP() });
  check('发节点邀请码 → 201', inv.status === 201, String(inv.status));
  const joined = await call('POST', '/api/nodes/join', { body: { code: inv.json?.code, id: 'sp-node', label: 'x', hostname: 'x', platform: 'linux', runtimes: [] } });
  const bn = joined.json?.token ?? '';
  check('节点加入 → 201 bn_ 令牌', joined.status === 201 && bn.startsWith('bn_'), String(joined.status));
  const NB = { 'X-Bandi-Token': bn };
  check('compute 报到 → 201', (await call('POST', '/api/nodes/register', { headers: NB, body: { id: 'sp-node', label: 'x', hostname: 'x', platform: 'linux', runtimes: [] } })).status === 201);
  check('compute 心跳（自己的 id）→ 200', (await call('POST', '/api/nodes/sp-node/heartbeat', { headers: NB })).status === 200);
  const devByNode = await call('GET', '/api/devices', { headers: NB });
  check('compute 读设备 → 403 E4031', devByNode.status === 403 && devByNode.json?.code === 'E4031', `${devByNode.status} ${devByNode.json?.code}`);
  const invByNode = await call('POST', '/api/nodes/invites', { headers: NB });
  check('compute 发邀请码 → 403 E4031（compute: true 之外一律拒）', invByNode.status === 403 && invByNode.json?.code === 'E4031', String(invByNode.status));

  // ⑥ panel 令牌：开面板 scope 后，看可以、管理动作 E4032
  const scopeR = await call('POST', '/api/nodes/sp-node/scope', { headers: OP(), body: { scope: ['compute', 'panel'] } });
  check('给节点开 panel scope → 2xx', scopeR.status < 300, `${scopeR.status} ${scopeR.json?.code ?? ''}`);
  check('panel 读 /api/state → 200', (await call('GET', '/api/state', { headers: NB })).status === 200);
  const invByPanel = await call('POST', '/api/nodes/invites', { headers: NB });
  check('panel 发邀请码 → 403 E4032（noPanel）', invByPanel.status === 403 && invByPanel.json?.code === 'E4032', `${invByPanel.status} ${invByPanel.json?.code}`);
  const quotaByPanel = await call('POST', '/api/quota', { headers: NB, body: {} });
  check('panel 改模型路由 → 403 E4032', quotaByPanel.status === 403 && quotaByPanel.json?.code === 'E4032', String(quotaByPanel.status));
  const fsByPanel = await call('GET', '/api/fs/dirs', { headers: NB });
  check('panel 列目录 → 403 E4032', fsByPanel.status === 403 && fsByPanel.json?.code === 'E4032', String(fsByPanel.status));

  // ⑦ device 令牌：配对 → 白名单基线（配对码字段是 token，bp_ 开头）
  const pairCode = await call('POST', '/api/pair/tokens', { headers: OP() });
  const claim = await call('POST', '/api/pair/claim', { body: { token: pairCode.json?.token ?? '', name: '测试手机' } });
  const devTok = /bandi_token=([^;]+)/.exec(claim.setCookie)?.[1] ?? '';
  check('手机配对换设备令牌 → 200', claim.status === 200 && !!devTok, `${claim.status} ${claim.raw.slice(0, 80)}`);
  const DB = { 'X-Bandi-Token': devTok };
  if (devTok) {
    check('device 读 /api/state → 200（白名单）', (await call('GET', '/api/state', { headers: DB })).status === 200);
    const usersByDev = await call('GET', '/api/users', { headers: DB });
    check('device 读 /api/users → 403 E4033', usersByDev.status === 403 && usersByDev.json?.code === 'E4033', String(usersByDev.status));
    const pwByDev = await call('POST', '/api/me/password', { headers: DB, body: { currentPassword: 'x', newPassword: 'y-pass-123' } });
    check('device 改密码 → 403 E4033（member 不含 device）', pwByDev.status === 403 && pwByDev.json?.code === 'E4033', `${pwByDev.status} ${pwByDev.json?.code}`);
  }

  // ⑧ role_permissions 解锁：授 machine:read → 成员可读状态台账；再授 user:manage
  //    → 成员可读账号列表（Phase 3 收编后 handler 不再自带 mayManage，词表解锁端到端生效）
  await killAll();
  const db = new DatabaseSync(path.join(tmp, 'bandi.db'));
  const memberRole = db.prepare("SELECT roleId FROM users WHERE name = '乙'").get()?.roleId;
  check('成员乙的角色是 operator（内置）', memberRole === 'operator', String(memberRole));
  db.prepare("INSERT OR IGNORE INTO role_permissions (roleId, permission) VALUES ('operator', 'machine:read')").run();
  db.close();
  startSrv({ BANDI_HOST: '0.0.0.0', BANDI_TOKEN: OP_TOKEN });
  if (!(await waitUp())) throw new Error('二次没起来');
  const j2 = await login('乙');
  const ledgerR = await j2.call('GET', '/api/status/ledger');
  check('授 machine:read 后成员读 /api/status/ledger → 200（roleHasPerm 生效）', ledgerR.status === 200, `${ledgerR.status} ${ledgerR.json?.code ?? ''}`);
  const usersByPerm = await j2.call('GET', '/api/users');
  check('user:manage 没授，/api/users 依旧 403 E4033（按权判定，不是整站放行）', usersByPerm.status === 403 && usersByPerm.json?.code === 'E4033', `${usersByPerm.status} ${usersByPerm.json?.code}`);

  // ⑧b 收编验证：授 user:manage → 成员可读账号列表（handler 闸已摘，PDP 单门）
  await killAll();
  const db2 = new DatabaseSync(path.join(tmp, 'bandi.db'));
  db2.prepare("INSERT OR IGNORE INTO role_permissions (roleId, permission) VALUES ('operator', 'user:manage')").run();
  db2.close();
  startSrv({ BANDI_HOST: '0.0.0.0', BANDI_TOKEN: OP_TOKEN });
  if (!(await waitUp())) throw new Error('三次没起来');
  const j3 = await login('乙');
  const usersR = await j3.call('GET', '/api/users');
  check('授 user:manage 后成员读 /api/users → 200（收编后词表解锁真正生效）', usersR.status === 200, `${usersR.status} ${usersR.json?.code ?? ''}`);
  const delUser = await j3.call('DELETE', '/api/users/no-such-user');
  check('成员删不存在的用户 → 404（过了 PDP，业务层照旧）', delUser.status === 404, `${delUser.status} ${delUser.json?.code ?? ''}`);

  // ⑨ 撤销令牌：忘掉节点 → bn_ 变 revoked（E4012）
  await call('DELETE', '/api/nodes/sp-node', { headers: OP() });
  const hbAfterForget = await call('POST', '/api/nodes/sp-node/heartbeat', { headers: NB });
  check('忘掉后旧 bn_ → 401 E4012', hbAfterForget.status === 401 && hbAfterForget.json?.code === 'E4012', `${hbAfterForget.status} ${hbAfterForget.json?.code}`);
} catch (err) {
  check('流程没抛异常', false, String(err?.message ?? err).slice(0, 300));
} finally {
  await killAll();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
}

console.log(failed ? `\n✗ ${failed} 项没过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
