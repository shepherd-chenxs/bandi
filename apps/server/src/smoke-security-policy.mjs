/*
 * smoke-security-policy.mjs —— 2026-11-07 验收（hub-only 模型，删本地凭据层 + 角色/菜单权限体系）：
 *   · A. 清单纯逻辑校验（登记项 id 唯一、无 perm/member/device 残留、compute/noPanel 标记、
 *        findRoute 优先级）；
 *   · B. 覆盖率扫描：routes/*.mjs + server.mjs 里出现的每个 /api 字面量必须已登记
 *     （"未登记即拒绝"的另一面 = "存在的接口必须登记"，漏登记 = 上线即 404 E4090）；
 *   · C. 身份 × 路由矩阵（调 PDP 纯函数 authorize）：operator / user / node / revoked
 *        四种身份对基线、管理面、节点自端点的判定；
 *   · D. 起真服务（回环形态，免鉴权 operator）冒烟：/api/hello 起得来、operator 全通；
 *   · E. 服务器形态（0.0.0.0）的真会话矩阵：中枢登录的普通用户摸原来 admin 专属的
 *        管理面 / 审计口（登录即全权），compute / panel / revoked 照旧各自有边界。
 *
 * 跑法：`SMOKE_PORT=8908 node apps/server/src/smoke-security-policy.mjs`
 *   （端口从 process.env.SMOKE_PORT 派生，缺省 8908；D / E 先后共用同一端口）。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot } from './config.mjs';
import { ROUTES, isRegistered, findRoute } from './security/route-policy.mjs';
import { authorize } from './security/policy.mjs';
import { startHubStub, hubLogin } from './hub-stub.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs');
const PORT = Number(process.env.SMOKE_PORT ?? 8908);
const BASE = `http://127.0.0.1:${PORT}`;

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failed += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------- A. 纯逻辑校验 */

console.log('\nA. 清单与 PDP 的纯逻辑校验');
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
  // 2026-11-07：perm / member / role 字段随角色体系一道退场 —— 清单里不能再有它们。
  const stray = ROUTES.filter((r) => 'perm' in r || 'member' in r || 'role' in r).map((r) => r.id);
  check('清单无 perm/member/role 字段残留', stray.length === 0, stray.join(', '));
}
{
  // 节点自端点必须排在通配 :id 条目之前（smoke-auth ⑥ 的教训：register 被 :id 抢走）
  const idx = (id) => ROUTES.findIndex((r) => r.id === id);
  check('nodes.register 登记在 nodes.one（/api/nodes/:id）之前', idx('nodes.register') < idx('nodes.one'), `${idx('nodes.register')} vs ${idx('nodes.one')}`);
  check('/api/nodes/register 解析到 compute 条目', findRoute('/api/nodes/register', 'POST')?.id === 'nodes.register');
  check('/api/local/status 解析到 session 条目（分机状态页）', findRoute('/api/local/status', 'GET')?.id === 'local.status.forUser');
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

/* --------------------------------------------- C. 身份 × 路由矩阵（PDP） */

console.log('\nC. 身份 × 路由矩阵（PDP 纯函数 authorize）');
{
  const who = {
    operator: { kind: 'operator' },
    user: { kind: 'user' },
    nodeCompute: { kind: 'node', scope: new Set(['compute']), nodeId: 'sp-node' },
    nodePanel: { kind: 'node', scope: new Set(['panel']), nodeId: 'sp-node' },
    revoked: { kind: 'revoked' },
  };
  // compute 端点要过归属判定（nodeMayReach / runMayReach），这里给"自己能碰自己"的正样本
  const reachRules = { nodeMayReach: () => true, runMayReach: () => true };
  const a = (w, method, pathname, rules = {}) => authorize({ who: w, method, pathname, rules });

  // operator：清单内全通（未登记由 guard 兜 404，PDP 不再二次挡）
  check('operator 读 /api/state → allow', a(who.operator, 'GET', '/api/state') === 'allow');

  // user（登录 = 全权，2026-11-07 起无角色闸）：连管理面 / 安全面都直接放行
  check('user 读 /api/users → allow（登录即全权）', a(who.user, 'GET', '/api/users') === 'allow');
  check('user 读 /api/security/audit → allow（无 roleHasPerm 闸）', a(who.user, 'GET', '/api/security/audit') === 'allow');

  // node（compute scope）：只许"自己的活"
  check('compute 报到 → allow（nodes.register compute + 归属命中）', a(who.nodeCompute, 'POST', '/api/nodes/register', reachRules) === 'allow');
  check('compute 心跳（自己 id）→ allow', a(who.nodeCompute, 'POST', '/api/nodes/sp-node/heartbeat', reachRules) === 'allow');
  check('compute 发邀请码 → E4031（非 compute 且无 panel）', a(who.nodeCompute, 'POST', '/api/nodes/invites', reachRules) === 'E4031');

  // node（panel scope）：看 + 用，管理面 noPanel 一律拒
  check('panel 发邀请码 → E4032（nodes.invites noPanel）', a(who.nodePanel, 'POST', '/api/nodes/invites') === 'E4032');
  check('panel 改模型路由 → E4032（quota.write noPanel）', a(who.nodePanel, 'POST', '/api/quota') === 'E4032');
  check('panel 列目录 → E4032（fs.dirs noPanel，GET 也拒）', a(who.nodePanel, 'GET', '/api/fs/dirs') === 'E4032');
  check('panel 报到 compute 端点 → allow（panel 不丢 compute 归属）', a(who.nodePanel, 'POST', '/api/nodes/register', reachRules) === 'allow');

  // revoked：一律 E4012
  check('revoked 任意接口 → E4012', a(who.revoked, 'GET', '/api/state') === 'E4012');
}

/* ----------------------------------------------------- D. 真服务冒烟 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-secpol-'));
let child = null;
const started = [];
function startSrv(extra = {}) {
  const c = spawn(process.execPath, [SERVER], {
    cwd: repoRoot,
    env: { ...process.env, BANDI_PORT: String(PORT), BANDI_DATA: tmp, BANDI_DB: path.join(tmp, 'bandi.db'), BANDI_HUB: 'off', ...extra },
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
      const r = await fetch(BASE + '/api/hello', { signal: AbortSignal.timeout(800) });
      if (r.status === 200) return true;
    } catch { /* 还没起 */ }
    await sleep(200);
  }
  return false;
}
async function killAll() {
  for (const c of started.splice(0)) { try { c.kill(); } catch { /* 已退 */ } }
  await sleep(600);
}
const call = async (method, p, { body, headers: extra = {} } = {}) => {
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
    /** 先 GET / 种 csrf 值，再走中枢表单登录换 bandi_sid */
    async login(username, password) {
      await this.call('GET', '/');
      const lr = await hubLogin(BASE, { username, password, origin: BASE });
      if (lr.status !== 302 || !lr.sid) return false;
      kv.bandi_sid = lr.sid;
      return true;
    },
  };
}

const stub = await startHubStub({ deviceId: 'dev_self', accounts: { 甲: { password: '甲-pass-123' } } });

try {
  console.log('\nD. 真服务（回环形态 127.0.0.1 + BANDI_HUB=off，免鉴权 operator）');
  startSrv({ BANDI_HOST: '127.0.0.1' });
  if (!(await waitUp())) throw new Error('服务没起来');

  // 回环下无会话 cookie 的请求被标成 operator → 全通（不含只认登录会话的 /api/security/*）
  check('/api/hello → 200（服务起来了）', (await call('GET', '/api/hello')).status === 200);
  check('operator 读 /api/state → 200', (await call('GET', '/api/state')).status === 200);
  check('operator 读 /api/users → 200（回环免登录）', (await call('GET', '/api/users')).status === 200);
  const me = await call('GET', '/api/me');
  check('operator /api/me → 200 且 kind=operator', me.status === 200 && me.json?.kind === 'operator', `${me.status} ${me.json?.kind ?? ''}`);

  console.log('\nE. 真服务（0.0.0.0 服务器形态）：会话身份矩阵');
  await killAll();
  /*
   * 种总机形态（2026-11-02）：显式监听不再自动当总机 —— `acceptNodes` 没显式写过就跟随
   * `allowLan`（默认 false），发邀请码会 409 E1091、后面整条节点链全连锁崩。这里的用例
   * 就是要钉节点令牌的身份矩阵，所以先把 netmode.json 写成「总机 + 收节点」。
   */
  fs.writeFileSync(path.join(tmp, 'netmode.json'), JSON.stringify({ allowLan: true, acceptNodes: true }));
  const OP_TOKEN = 'sec-pol-op-token';
  const OP = () => ({ 'X-Bandi-Token': OP_TOKEN });
  startSrv({ BANDI_HOST: '0.0.0.0', BANDI_TOKEN: OP_TOKEN, BANDI_HUB: stub.url });
  if (!(await waitUp())) throw new Error('服务器形态没起来');

  // ① operator（共享令牌）：清单内全通，未登记 404
  check('operator 读 /api/state → 200', (await call('GET', '/api/state', { headers: OP() })).status === 200);
  const nope = await call('GET', '/api/definitely/not/here', { headers: OP() });
  check('未登记路径 → 404 E4090（连 operator 也不存在"清单外接口"）', nope.status === 404 && nope.json?.code === 'E4090', `${nope.status} ${nope.json?.code}`);

  // ② 登录用户（中枢会话）：登录即全权 —— 原来 admin 专属的管理面与审计口全开
  const uj = jar();
  check('中枢账号登录 → 302 换会话', await uj.login('甲', '甲-pass-123'));
  const meR = await uj.call('GET', '/api/me');
  check('GET /api/me → user 形态 {kind,user:{id,name}}（无 role/menuKeys）',
    meR.status === 200 && meR.json?.kind === 'user' && !!meR.json?.user?.id && !!meR.json?.user?.name && !('role' in (meR.json?.user ?? {})),
    `${meR.status} ${meR.raw?.slice(0, 80)}`);
  check('登录用户读 /api/users → 200（原 admin 专属）', (await uj.call('GET', '/api/users')).status === 200);
  check('登录用户建影子账号 → 201', (await uj.call('POST', '/api/users', { body: { name: '小张' } })).status === 201);
  check('登录用户读审计 → 200（原 audit:read 敏感权）', (await uj.call('GET', '/api/security/audit')).status === 200);
  check('登录用户导出审计 → 200', (await uj.call('GET', '/api/security/audit/export')).status === 200);
  const clearR = await uj.call('POST', '/api/security/audit/clear');
  check('登录用户清空审计 → 200（原 security:manage）', clearR.status === 200 && (clearR.json?.cleared ?? 0) >= 1, `${clearR.status} ${clearR.json?.code ?? ''}`);
  const afterClear = await uj.call('GET', '/api/security/audit');
  check('清空后主表只留 audit.clear 痕迹（append-only 口径）',
    afterClear.status === 200 && (afterClear.json?.events ?? []).length === 1 && afterClear.json.events[0].kind === 'audit.clear',
    JSON.stringify(afterClear.json?.events ?? []).slice(0, 120));
  const anon = await call('GET', '/api/users');
  check('匿名（无凭据）→ 401（全权≠免登录）', anon.status === 401, `${anon.status} ${anon.json?.code ?? ''}`);
  const unregByUser = await uj.call('GET', '/api/users/whatever/none');
  check('登录用户打未登记子路径 → 404 E4090（不是 403）', unregByUser.status === 404 && unregByUser.json?.code === 'E4090', `${unregByUser.status} ${unregByUser.json?.code}`);

  // ③ compute 令牌：自端点可、管理面 E4031
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

  // ④ panel 令牌：开面板 scope 后，看可以、管理动作 E4032
  const scopeR = await call('POST', '/api/nodes/sp-node/scope', { headers: OP(), body: { scope: ['compute', 'panel'] } });
  check('给节点开 panel scope → 2xx', scopeR.status < 300, `${scopeR.status} ${scopeR.json?.code ?? ''}`);
  check('panel 读 /api/state → 200', (await call('GET', '/api/state', { headers: NB })).status === 200);
  const invByPanel = await call('POST', '/api/nodes/invites', { headers: NB });
  check('panel 发邀请码 → 403 E4032（noPanel）', invByPanel.status === 403 && invByPanel.json?.code === 'E4032', `${invByPanel.status} ${invByPanel.json?.code}`);
  const quotaByPanel = await call('POST', '/api/quota', { headers: NB, body: {} });
  check('panel 改模型路由 → 403 E4032', quotaByPanel.status === 403 && quotaByPanel.json?.code === 'E4032', String(quotaByPanel.status));
  const fsByPanel = await call('GET', '/api/fs/dirs', { headers: NB });
  check('panel 列目录 → 403 E4032', fsByPanel.status === 403 && fsByPanel.json?.code === 'E4032', String(fsByPanel.status));

  // ⑤ device 令牌那一段随手机配对体系退场（2026-11-07）：手机现在也是登录用户，
  //    没有"设备白名单"这层要钉了。

  // ⑥ 撤销令牌：忘掉节点 → bn_ 变 revoked（E4012）
  await call('DELETE', '/api/nodes/sp-node', { headers: OP() });
  const hbAfterForget = await call('POST', '/api/nodes/sp-node/heartbeat', { headers: NB });
  check('忘掉后旧 bn_ → 401 E4012', hbAfterForget.status === 401 && hbAfterForget.json?.code === 'E4012', `${hbAfterForget.status} ${hbAfterForget.json?.code}`);
} catch (err) {
  check('流程没抛异常', false, String(err?.message ?? err).slice(0, 300));
} finally {
  await killAll();
  try { await stub?.close(); } catch { /* 已退 */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
}

console.log(failed ? `\n✗ ${failed} 项没过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
