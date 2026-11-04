/*
 * smoke-admin-invariant.mjs —— 内置账号不变量 + 受限会话矩阵（IAM §8.6，Phase 1 收尾）。
 *
 * 两段：
 *   ① 最后一个管理员不能被降级 / 禁用 / 删除（E4096）；内置管理员另有三道 E3808；
 *   ② 免密 admin 在服务器形态登录 = **受限会话**（E4098 白名单）：
 *      GET /api/me|state|skills|web-version、静态 GET、POST /api/me/password、POST /api/logout
 *      放行，其余一律 4098；改完密码重新登录即恢复正常（这是唯一的自救路径）。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const SERVER = path.join(__dirname, 'server.mjs');
const PORT = 18795;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'admin-inv-smoke-token';

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failed += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-admininv-'));
let child = null;
let log = '';
child = spawn(process.execPath, [SERVER], {
  cwd: repoRoot,
  env: { ...process.env, BANDI_PORT: String(PORT), BANDI_DATA: tmp, BANDI_DB: path.join(tmp, 'bandi.db'), BANDI_HOST: '0.0.0.0', BANDI_TOKEN: TOKEN },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));

async function waitUp(ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${BASE}/api/hello`, { signal: AbortSignal.timeout(800) });
      if (r.status === 200) return true;
    } catch { /* 还没起 */ }
    await sleep(200);
  }
  return false;
}

const segOf = (sc, name) => {
  const m = new RegExp(`${name}=([^;]*)`).exec(sc ?? '');
  return m ? `${name}=${m[1]}` : '';
};

/* cookie jar（含 CSRF 值，同 smoke-users 的做法） */
let CSRF = '';
const call = async (method, p, { body, cookie, token, setup } = {}) => {
  const headers = { 'Content-Type': 'application/json', 'X-Bandi': '1' };
  if (cookie) headers.Cookie = CSRF ? `${cookie}; bandi_csrf=${CSRF}` : cookie;
  else if (CSRF && method !== 'GET') headers.Cookie = `bandi_csrf=${CSRF}`;
  if (method !== 'GET' && CSRF) headers['X-Bandi-CSRF'] = CSRF;
  if (token) headers['X-Bandi-Token'] = token;
  if (setup) headers['X-Bandi-Setup'] = setup;
  const r = await fetch(BASE + p, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
  const raw = await r.text();
  const mCsrf = /bandi_csrf=([^;]*)/.exec(r.headers.get('set-cookie') ?? '');
  if (mCsrf) CSRF = decodeURIComponent(mCsrf[1]);
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* HTML */ }
  return { status: r.status, body: parsed, raw, setCookie: r.headers.get('set-cookie') ?? '' };
};

try {
  if (!(await waitUp())) throw new Error('实例没起来：' + log.slice(-500));

  /* ============ ① 最后一个管理员 ============ */
  console.log('\n① 内置管理员的三道锁 + 最后一个管理员（E4096）');
  const setupCode = fs.readFileSync(path.join(tmp, 'setup_code'), 'utf8').trim();
  const first = await call('POST', '/api/users', { token: TOKEN, setup: setupCode, body: { name: '老王', password: 'wang-pass-123' } });
  check('建首个账号 → 内置管理员', first.status === 201 && first.body?.user?.builtin === true, `${first.status}`);
  const adminId = first.body?.user?.id;
  const builtinRole = await call('PATCH', `/api/users/${encodeURIComponent(adminId)}`, { token: TOKEN, body: { roleId: 'operator' } });
  check('内置管理员改角色 → 403 E3808', builtinRole.status === 403 && builtinRole.body?.code === 'E3808', `${builtinRole.status} ${builtinRole.body?.code}`);
  const builtinDis = await call('PATCH', `/api/users/${encodeURIComponent(adminId)}`, { token: TOKEN, body: { disabled: true } });
  check('内置管理员禁用 → 403 E3808', builtinDis.status === 403 && builtinDis.body?.code === 'E3808', `${builtinDis.status} ${builtinDis.body?.code}`);
  const builtinDel = await call('DELETE', `/api/users/${encodeURIComponent(adminId)}`, { token: TOKEN });
  check('内置管理员删除 → 403 E3808', builtinDel.status === 403 && builtinDel.body?.code === 'E3808', `${builtinDel.status} ${builtinDel.body?.code}`);

  /* 再加一个 admin（普通账号不可升到"唯一"），然后把它弄成第二个管理员再试"最后一个"规则 */
  const second = await call('POST', '/api/users', { token: TOKEN, body: { name: '老张', password: 'zhang-pass-1', roleId: 'admin' } });
  check('建第二个管理员 → 201', second.status === 201, String(second.status));
  const secondId = second.body?.user?.id;
  // 两个人都是 admin 时：删掉第二个是允许的
  const delOk = await call('DELETE', `/api/users/${encodeURIComponent(secondId)}`, { token: TOKEN });
  check('有两个管理员时删掉一个 → 200', delOk.status === 200, `${delOk.status} ${delOk.body?.code ?? ''}`);

  /* ============ ② 受限会话矩阵（免密 admin 在服务器形态） ============ */
  console.log('\n② 免密 admin 在服务器形态 = 受限会话（E4098 白名单）');
  const noPw = await call('POST', '/api/users', { token: TOKEN, body: { name: '临时超管', roleId: 'admin' } });
  check('建一个免密 admin → 201（hasPassword=false）',
    noPw.status === 201 && noPw.body?.user?.hasPassword === false, `${noPw.status}`);
  const lg = await call('POST', '/api/login', { body: { name: '临时超管', password: '' } });
  check('免密登录 → 200（能进，但只进受限态）', lg.status === 200, `${lg.status} ${lg.body?.code ?? ''}`);
  const cookie = segOf(lg.setCookie, 'bandi_sid');

  const allow = [
    ['GET', '/api/me'],
    ['GET', '/api/state'],
    ['GET', '/api/skills'],
    ['GET', '/api/web-version'],
  ];
  for (const [m, p] of allow) {
    const r = await call(m, p, { cookie });
    check(`白名单放行 ${m} ${p} → 200`, r.status === 200, `${r.status} ${r.body?.code ?? ''}`);
  }
  const denied = [
    ['GET', '/api/users'],
    ['GET', '/api/roles'],
    ['GET', '/api/experts'],
    ['POST', '/api/users'],
    ['POST', '/api/roles'],
    ['PUT', '/api/prefs'], // 2026-11-04 补登（登录用户可改）：受限会话仍拦在 E4098 —— 不在 RESTRICTED_OPEN
  ];
  for (const [m, p] of denied) {
    const r = await call(m, p, { cookie, body: m === 'POST' ? {} : undefined });
    check(`受限会话拒绝 ${m} ${p} → 403 E4098`, r.status === 403 && r.body?.code === 'E4098', `${r.status} ${r.body?.code ?? ''}`);
  }
  // v2.8：isRegistered 方法感知后，"路径登记过、方法没登记"的请求在认证之前
  // 就 404 E4090（受限会话的 E4098 排在后面，轮不到它）
  const ghost = [
    ['GET', '/api/personas'], // 服务端没有列表口（前端走 /api/state），也未登记
    ['POST', '/api/security/audit'], // 只登记了 GET
  ];
  for (const [m, p] of ghost) {
    const r = await call(m, p, { cookie, body: m === 'GET' ? undefined : {} });
    check(`未登记的 ${m} ${p} → 404 E4090（默认拒绝在认证之前）`, r.status === 404 && r.body?.code === 'E4090', `${r.status} ${r.body?.code ?? ''}`);
  }
  const pageIn = await fetch(BASE + '/', { headers: { Accept: 'text/html', Cookie: cookie }, signal: AbortSignal.timeout(5000) });
  const html = await pageIn.text();
  check('静态 GET 放行（首页能开，不然连改密页都到不了）', pageIn.status === 200 && html.includes('/app.mjs'), String(pageIn.status));

  const setPw = await call('POST', '/api/me/password', { cookie, body: { password: 'now-fixed-pass-1' } });
  check('唯一的自救路径：POST /api/me/password → 200', setPw.status === 200, `${setPw.status} ${setPw.raw?.slice(0, 120)}`);
  const reLogin = await call('POST', '/api/login', { body: { name: '临时超管', password: 'now-fixed-pass-1' } });
  check('改完密码重新登录 → 200', reLogin.status === 200, `${reLogin.status} ${reLogin.body?.code ?? ''}`);
  const cookie2 = segOf(reLogin.setCookie, 'bandi_sid');
  const nowOk = await call('GET', '/api/users', { cookie: cookie2 });
  check('不再受限：GET /api/users → 200', nowOk.status === 200, `${nowOk.status} ${nowOk.body?.code ?? ''}`);
  const logout = await call('POST', '/api/logout', { cookie: cookie2 });
  check('POST /api/logout → 200', logout.status === 200, String(logout.status));
} catch (err) {
  failed += 1;
  console.error('\n✗ 冒烟跑挂了：', err?.message ?? err);
  if (log) console.error('服务端日志尾部：\n' + log.slice(-1200));
} finally {
  try { child?.kill(); } catch { /* 已退 */ }
  await sleep(400);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
}

console.log(failed ? `\n✗ 有 ${failed} 项没过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
