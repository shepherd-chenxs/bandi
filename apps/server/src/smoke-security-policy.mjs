/*
 * smoke-security-policy.mjs —— 2026-11-07 验收（hub-only 模型，删本地凭据层 + 角色/菜单权限体系）：
 *   · A. 清单纯逻辑校验（登记项 id 唯一、无 perm/member/device 残留、compute/noPanel 标记、
 *        findRoute 优先级）；
 *   · B. 覆盖率扫描：routes/*.mjs + server.mjs 里出现的每个 /api 字面量必须已登记
 *     （"未登记即拒绝"的另一面 = "存在的接口必须登记"，漏登记 = 上线即 404 E4090）；
 *   · C. 身份 × 路由矩阵（调 PDP 纯函数 authorize）：operator / user / run 三种身份
 *        对基线、管理面、运行钥匙专用口的判定；
 *   · D. 起真服务（回环形态，免鉴权 operator）冒烟：/api/hello 起得来、operator 全通；
 *   · E. 服务器形态（0.0.0.0）的真会话矩阵：中枢登录的普通用户摸原来 admin 专属的
 *        管理面 / 审计口（登录即全权），未登记路径照旧 404；本机安装任务通道可用。
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
  // 同一路径多方法/多登记时的优先级（smoke-auth ⑥ 的教训：方法感知别丢）
  check('/api/local/status 解析到 session 条目（分机状态页）', findRoute('/api/local/status', 'GET')?.id === 'local.status.forUser');
  check('POST /api/quota 解析到 noPanel 条目（方法感知）', findRoute('/api/quota', 'POST')?.id === 'quota.write' && findRoute('/api/quota', 'GET')?.id === 'quota.read');
  check('本机安装任务三条都登记（原 nodes.dispatch 改挂 /api/install/tasks）',
    findRoute('/api/install/tasks', 'POST')?.id === 'localTasks.dispatch'
    && findRoute('/api/install/tasks', 'GET')?.id === 'localTasks.list'
    && !!findRoute('/api/install/tasks/sp-t1', 'GET'));
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
    run: { kind: 'run' },
  };
  const a = (w, method, pathname) => authorize({ who: w, method, pathname });

  // operator：清单内全通（未登记由 guard 兜 404，PDP 不再二次挡）
  check('operator 读 /api/state → allow', a(who.operator, 'GET', '/api/state') === 'allow');

  // user（登录 = 全权，2026-11-07 起无角色闸）：连管理面 / 安全面都直接放行
  check('user 读 /api/users → allow（登录即全权）', a(who.user, 'GET', '/api/users') === 'allow');
  check('user 读 /api/security/audit → allow（无 roleHasPerm 闸）', a(who.user, 'GET', '/api/security/audit') === 'allow');

  // run（运行钥匙）：只许清单标 run:true 的那几扇门
  check('run 建卡 → allow（agent.cards run:true）', a(who.run, 'POST', '/api/agent/cards') === 'allow');
  check('run 读台账 → allow（tasks.list run:true）', a(who.run, 'GET', '/api/tasks') === 'allow');
  check('run 读用户 → E4034（users.list 没标 run）', a(who.run, 'GET', '/api/users') === 'E4034');

  // 节点 / revoked 身份随多机子系统整体删除（2026-11-09）：identify 不会再吐出来，
  // 真有人伪造 → 落兜底 E4031。
  check('伪造 node 身份 → 兜底 E4031', authorize({ who: { kind: 'node' }, method: 'GET', pathname: '/api/state' }) === 'E4031');
  check('伪造 revoked 身份 → 兜底 E4031', authorize({ who: { kind: 'revoked' }, method: 'GET', pathname: '/api/state' }) === 'E4031');
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

  // ③ 本机软件商店安装任务通道（原 /api/nodes/local/tasks 改挂，nodeId 恒 'local'）：
  //    operator 的请求能进 handler（鉴权接缝钉住）。不真排任务 —— 用不认识的
  //    外部件 id 打到 E1045 这一步（命令表查无此物，在入队之前就拒），零副作用。
  const dispatch = await call('POST', '/api/install/tasks', { headers: OP(), body: { kind: 'external-install', family: 'smoke-不存在的部件' } });
  check('operator 打安装任务通道 → 400 E1045（进到 handler、命令表查无此物）',
    dispatch.status === 400 && dispatch.json?.code === 'E1045', `${dispatch.status} ${dispatch.json?.code ?? ''}`);
  const badKind = await call('POST', '/api/install/tasks', { headers: OP(), body: { kind: '瞎写的', family: 'x' } });
  check('不认识的 kind → 400 E1043', badKind.status === 400 && badKind.json?.code === 'E1043', String(badKind.json?.code));
  const taskList = await call('GET', '/api/install/tasks', { headers: OP() });
  check('安装任务列表可查 → 200', taskList.status === 200 && Array.isArray(taskList.json?.tasks), `${taskList.status}`);

  // ④ 节点令牌体系整体删除（2026-11-09）：bn_ 令牌与任何错令牌同罪（401 E4010），
  //    节点端点整条 404 E4090（默认拒绝 —— 接口不存在，不是权限不够）。
  const bnCall = await call('GET', '/api/state', { headers: { 'X-Bandi-Token': 'bn_dead-prefix-token' } });
  check('bn_ 假令牌 → 401 E4010', bnCall.status === 401 && bnCall.json?.code === 'E4010', `${bnCall.status} ${bnCall.json?.code ?? ''}`);
  const deadJoin = await call('POST', '/api/nodes/join', { body: { code: 'bj_x', id: 'x' } });
  check('POST /api/nodes/join → 404 E4090（端点已删）', deadJoin.status === 404 && deadJoin.json?.code === 'E4090', `${deadJoin.status} ${deadJoin.json?.code ?? ''}`);

  // ⑤ device 令牌那一段随手机配对体系退场（2026-11-07）：手机现在也是登录用户，
  //    没有"设备白名单"这层要钉了。
} catch (err) {
  check('流程没抛异常', false, String(err?.message ?? err).slice(0, 300));
} finally {
  await killAll();
  try { await stub?.close(); } catch { /* 已退 */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
}

console.log(failed ? `\n✗ ${failed} 项没过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
