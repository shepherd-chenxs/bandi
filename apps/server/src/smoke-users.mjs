/**
 * 账号、登录与角色分配（2026-10-28 第三刀）的验收。
 *
 * 这一刀是**全项目鉴权风险最高的一刀**，所以钉的边界比前两刀细：
 *   ① 没建任何账号时**行为与从前一模一样**（登录页只有令牌表单，令牌照旧可用）；
 *   ② 第一个账号自动成为内置管理员；
 *   ③ 登录：密码错 → 401 且文案不暴露"用户是否存在"；密码对 → Set-Cookie；
 *   ④ 会话 Cookie 能认人（`/api/me` 回 role.menuKeys），管理员能管账号；
 *   ⑤ 非管理员：管理口 403、白名单内的读接口 200；
 *   ⑥ 管理员：管理口 200；
 *   ⑦ 退出后原 Cookie 失效；
 *   ⑧ 内置管理员的删 / 改角色 / 禁用三道保护；
 *   ⑨ 会话**落库**：重启服务后原 Cookie 仍有效；伪造的 Cookie 一律 401；
 *   ⑩ 不回归：回环形态照旧 operator、共享令牌照旧可用。
 *   + 登录限速（同一 IP + 同一用户名 5 次失败 → 429）与"改密码踢下线"。
 *
 * 隔离：临时数据目录 + 临时端口，跑完全删，不碰 data/、不碰真令牌。
 * 跑法：node apps/server/src/smoke-users.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { repoRoot } from './config.mjs';
import { sleep, stopRunning } from './lifecycle.mjs';

const PORT = Number(process.env.SMOKE_PORT ?? 8790);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-users-'));
const SERVER = path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs');
const TOKEN = 'smoke-users-token';

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
    signal: AbortSignal.timeout(5000),
  });
  const raw = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* HTML 或空 */ }
  return { status: r.status, body: parsed, raw, setCookie: r.headers.get('set-cookie') ?? '' };
};

/** 从 Set-Cookie 里抽出 `name=value`（只取这一段，后面是 Path/HttpOnly…） */
const cookieOf = (sc, name = 'bandi_sid') => {
  const m = new RegExp(`${name}=([^;]*)`).exec(sc ?? '');
  return m ? `${name}=${m[1]}` : '';
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

const ADMIN = { name: '老王', password: 'wang-pass-123' };
const VILLAGER = { name: '小李', password: 'li-pass-1234' };

try {
  /* 非回环形态 = 服务端自己会开令牌闸（auth.setup 看监听地址） */
  start({ BANDI_HOST: '0.0.0.0', BANDI_TOKEN: TOKEN });
  if (!(await waitUp())) throw new Error('实例没起来：' + log.slice(-500));

  /* ============ ① 没账号时 = 与从前一模一样 ============ */
  console.log('① 还没建任何账号：行为与从前一致');
  const me0 = await call('GET', '/api/me', { token: TOKEN });
  check('带令牌 GET /api/me → operator（老路没变）', me0.status === 200 && me0.body?.kind === 'operator',
    `${me0.status} ${me0.body?.kind ?? me0.body?.code}`);
  const meNo = await call('GET', '/api/me');
  check('不带任何凭据 GET /api/me → 401', meNo.status === 401, `${meNo.status} ${meNo.body?.code ?? ''}`);
  const page0 = await fetch(BASE + '/', { headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(5000) });
  const html0 = await page0.text();
  check('登录页 200', page0.status === 200, String(page0.status));
  check('没有账号时**只给令牌表单**（不出现用户名密码表单）', !html0.includes('id="pwForm"') && html0.includes('name="token"'));
  check('并且提示"还没有任何账号"', html0.includes('还没有任何账号'));
  const st0 = await call('GET', '/api/state', { token: TOKEN });
  check('共享令牌照旧能读 /api/state（③ 的兜底：root 没被关在门外）', st0.status === 200, String(st0.status));

  /* ============ ② 第一个账号 = 内置管理员 ============ */
  console.log('\n② root 令牌建第一个账号 → 自动成为内置管理员');
  const first = await call('POST', '/api/users', { token: TOKEN, body: ADMIN });
  check('201', first.status === 201, String(first.status));
  check('builtin = true', first.body?.user?.builtin === true, String(first.body?.user?.builtin));
  check('roleId = admin（不传也强制是它）', first.body?.user?.roleId === 'admin', String(first.body?.user?.roleId));
  check('标记 first（前端据此给"第一个账号"的说明）', first.body?.first === true);
  const page1 = await (await fetch(BASE + '/', { headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(5000) })).text();
  check('有账号之后登录页给出用户名密码表单', page1.includes('id="pwForm"') && page1.includes('id="nm"'));
  // 2026-10-31 用户定：登录页就是登录页，**不再摆令牌入口**（脚本/运维用 X-Bandi-Token 头，不经界面）
  check('登录页不含令牌入口', !page1.includes('用访问令牌登录') && !page1.includes('name="token"'));
  // 建第一个账号 = 首次开机设置：顺手发登录会话票（2026-10-31），同一浏览器以后切非回环地址不用再登
  check('建第一个账号顺手 Set-Cookie bandi_sid（首次引导的自动登录）', /bandi_sid=/.test(first.setCookie ?? ''), String(first.setCookie ?? '').slice(0, 60));

  /* ============ ②.5 免密账号 = 空密码直接登录（2026-10-31 用户拍板） ============ */
  console.log('\n②.5 免密账号：空密码能登录、错密码不行、补密码后空密码关上');
  const nopw = await call('POST', '/api/users', { token: TOKEN, body: { name: '本机的人', roleId: 'operator' } });
  check('不传密码建账号 → 201', nopw.status === 201, String(nopw.status));
  check('hasPassword = false（界面标「未设密码」的依据）', nopw.body?.user?.hasPassword === false,
    String(nopw.body?.user?.hasPassword));
  const nopwLogin = await call('POST', '/api/login', { body: { name: '本机的人', password: '' } });
  check('空密码登录 → 200（免密进入，任何机器都行）', nopwLogin.status === 200,
    `${nopwLogin.status} ${nopwLogin.body?.code ?? ''}`);
  check('免密登录也发会话票', /bandi_sid=/.test(nopwLogin.setCookie ?? ''), String(nopwLogin.setCookie ?? '').slice(0, 60));
  const nopwWrong = await call('POST', '/api/login', { body: { name: '本机的人', password: 'whatever-1' } });
  check('免密账号输了密码 → 401 统一文案', nopwWrong.status === 401 && nopwWrong.body?.code === 'E3805'
    && /用户名或密码不对/.test(nopwWrong.body?.error ?? ''), `${nopwWrong.status} ${nopwWrong.body?.error ?? ''}`);
  const setPw = await call('PATCH', `/api/users/${encodeURIComponent(nopw.body?.user?.id)}`, {
    token: TOKEN, body: { password: 'now-has-pass-1' },
  });
  check('补密码 → 200 且 hasPassword = true', setPw.status === 200 && setPw.body?.user?.hasPassword === true,
    `${setPw.status} ${setPw.body?.user?.hasPassword}`);
  const blankAfter = await call('POST', '/api/login', { body: { name: '本机的人', password: '' } });
  check('补了密码之后空密码登不进 → 401', blankAfter.status === 401 && blankAfter.body?.code === 'E3805',
    `${blankAfter.status} ${blankAfter.body?.code ?? ''}`);
  const withPw = await call('POST', '/api/login', { body: { name: '本机的人', password: 'now-has-pass-1' } });
  check('补完密码用密码能登 → 200', withPw.status === 200, String(withPw.status));
  const st1 = await call('GET', '/api/state', { token: TOKEN });
  check('/api/state 带真人名册（users，只有 id/名字/内置）',
    Array.isArray(st1.body?.users) && st1.body.users.length >= 2
      && st1.body.users.every((u) => 'id' in u && 'name' in u && !('salt' in u) && !('hash' in u)),
    JSON.stringify(st1.body?.users ?? []).slice(0, 120));
  check('/api/state 的 me = 第一个用户（操作员 = 本机自动登录）',
    st1.body?.me?.id === first.body?.user?.id && st1.body?.me?.name === ADMIN.name,
    JSON.stringify(st1.body?.me ?? {}));

  /* ============ ③ 登录 ============ */
  console.log('\n③ POST /api/login');
  const bad = await call('POST', '/api/login', { body: { name: ADMIN.name, password: 'nope-nope' } });
  check('错密码 → 401', bad.status === 401, String(bad.status));
  check('码 E3805', bad.body?.code === 'E3805', String(bad.body?.code));
  check('文案统一「用户名或密码不对」（不暴露用户是否存在）',
    /用户名或密码不对/.test(bad.body?.error ?? '') && !/不存在|没有这个用户/.test(bad.body?.error ?? ''),
    String(bad.body?.error));
  const ghost = await call('POST', '/api/login', { body: { name: '根本没这个人', password: 'whatever-1' } });
  check('不存在的用户名 → **同一条**文案同一个码', ghost.status === 401 && ghost.body?.code === 'E3805'
    && ghost.body?.error === bad.body?.error, `${ghost.status} ${ghost.body?.error}`);

  const good = await call('POST', '/api/login', { body: ADMIN });
  const adminCookie = cookieOf(good.setCookie);
  check('对密码 → 200', good.status === 200, String(good.status));
  check('返回 kind=user + role.menuKeys', good.body?.kind === 'user' && Array.isArray(good.body?.role?.menuKeys),
    JSON.stringify(good.body?.role?.menuKeys ?? null));
  check('Set-Cookie 带 bandi_sid 且 HttpOnly / SameSite=Lax / 30 天', !!adminCookie && /HttpOnly/i.test(good.setCookie)
    && /SameSite=Lax/i.test(good.setCookie) && /Max-Age=2592000/.test(good.setCookie), good.setCookie);
  check('响应里**没有**密码 / salt / hash 字段',
    !/password|salt|hash/i.test(JSON.stringify(good.body ?? {})), JSON.stringify(good.body ?? {}).slice(0, 120));

  /* ============ ④ 会话认人 + 管理员权限 ============ */
  console.log('\n④ 带会话 Cookie：/api/me 认人、管理员能管账号');
  const meA = await call('GET', '/api/me', { cookie: adminCookie });
  check('kind = user', meA.body?.kind === 'user', `${meA.status} ${meA.body?.kind}`);
  check('role.menuKeys 非空且含 messages', Array.isArray(meA.body?.role?.menuKeys)
    && meA.body.role.menuKeys.includes('messages'), JSON.stringify(meA.body?.role?.menuKeys));
  const usersA = await call('GET', '/api/users', { cookie: adminCookie });
  check('GET /api/users → 200', usersA.status === 200, String(usersA.status));
  check('列表**不含** salt / hash（连字段都不出现）',
    Array.isArray(usersA.body?.users) && usersA.body.users.every((u) => !('salt' in u) && !('hash' in u)),
    JSON.stringify(Object.keys(usersA.body?.users?.[0] ?? {})));
  const rolesA = await call('GET', '/api/roles', { cookie: adminCookie });
  check('管理员 GET /api/roles → 200', rolesA.status === 200, String(rolesA.status));

  /* ============ ⑤ 非管理员 ============ */
  console.log('\n⑤ 非管理员账号：管理口 403、看和用照常');
  const mk = await call('POST', '/api/users', { token: TOKEN, body: { ...VILLAGER, roleId: 'operator' } });
  check('建非管理员 → 201', mk.status === 201 && mk.body?.user?.builtin === false, String(mk.status));
  const vg = await call('POST', '/api/login', { body: VILLAGER });
  const vCookie = cookieOf(vg.setCookie);
  check('小李登录 → 200', vg.status === 200, String(vg.status));
  check('他的 role 是 operator', vg.body?.role?.id === 'operator', String(vg.body?.role?.id));
  const meV = await call('GET', '/api/me', { cookie: vCookie });
  check('普通账号也能问 /api/me（前端靠它拿菜单）', meV.status === 200 && meV.body?.kind === 'user', `${meV.status}`);
  const rolesV = await call('GET', '/api/roles', { cookie: vCookie });
  check('GET /api/roles → 403（mayManage 拦）', rolesV.status === 403, `${rolesV.status} ${rolesV.body?.code ?? ''}`);
  const usersV = await call('GET', '/api/users', { cookie: vCookie });
  check('GET /api/users → 403', usersV.status === 403, `${usersV.status} ${usersV.body?.code ?? ''}`);
  const postV = await call('POST', '/api/users', { cookie: vCookie, body: { name: '偷建', password: '123456789', roleId: 'admin' } });
  check('POST /api/users → 403（不能自己给自己升管理员）', postV.status === 403, `${postV.status} ${postV.body?.code ?? ''}`);
  const stV = await call('GET', '/api/state', { cookie: vCookie });
  check('GET /api/state → 200（白名单内的"看"照常）', stV.status === 200, String(stV.status));

  /* ============ ⑥ 内置保护 / 最后一个管理员 ============ */
  console.log('\n⑥ 内置管理员的三道保护（= 最后一个管理员不能被移除）');
  const adminId = first.body?.user?.id;
  const delAdmin = await call('DELETE', `/api/users/${encodeURIComponent(adminId)}`, { cookie: adminCookie });
  check('删内置管理员 → 403 E3808', delAdmin.status === 403 && delAdmin.body?.code === 'E3808',
    `${delAdmin.status} ${delAdmin.body?.code}`);
  const roleAdmin = await call('PATCH', `/api/users/${encodeURIComponent(adminId)}`, {
    cookie: adminCookie, body: { roleId: 'operator' },
  });
  check('改内置管理员的角色 → 403 E3808', roleAdmin.status === 403 && roleAdmin.body?.code === 'E3808',
    `${roleAdmin.status} ${roleAdmin.body?.code}`);
  const disAdmin = await call('PATCH', `/api/users/${encodeURIComponent(adminId)}`, {
    cookie: adminCookie, body: { disabled: true },
  });
  check('禁用内置管理员 → 403 E3808', disAdmin.status === 403 && disAdmin.body?.code === 'E3808',
    `${disAdmin.status} ${disAdmin.body?.code}`);
  // 反证：内置管理员还在，所以**别的** admin 可以被降级（保护不是误伤）
  const mkAdmin2 = await call('POST', '/api/users', { token: TOKEN, body: { name: '老张', password: 'zhang-pass-1', roleId: 'admin' } });
  const demote = await call('PATCH', `/api/users/${encodeURIComponent(mkAdmin2.body?.user?.id)}`, {
    cookie: adminCookie, body: { roleId: 'operator' },
  });
  check('另一个 admin 可以被降级（内置那把钥匙还在，不误伤）', demote.status === 200, `${demote.status} ${demote.body?.code ?? ''}`);

  /* ============ ⑦ 退出登录 ============ */
  console.log('\n⑦ 退出登录：原 Cookie 立刻失效');
  const lo = await call('POST', '/api/logout', { cookie: vCookie });
  check('POST /api/logout → 200 且清 Cookie', lo.status === 200 && /bandi_sid=;/.test(lo.setCookie || ''), lo.setCookie);
  // 两张票一起清（2026-10-31 实报）：令牌 Cookie 一年有效，不清的话令牌浏览器永远走不到登录页
  const loTok = await call('POST', '/api/logout', { token: TOKEN });
  check('退出登录把访问令牌 Cookie 也清掉（令牌浏览器才能走回登录页）',
    /bandi_token=;/.test(loTok.setCookie ?? ''), String(loTok.setCookie ?? '').slice(0, 90));
  const meAfter = await call('GET', '/api/me', { cookie: vCookie });
  check('原 Cookie 再打 /api/me → 401', meAfter.status === 401, `${meAfter.status} ${meAfter.body?.code ?? ''}`);

  /* ============ ⑧ 会话落库 + 伪造 Cookie ============ */
  console.log('\n⑧ 会话落库：重启后仍有效；伪造的一律 401');
  await stopAll();
  start({ BANDI_HOST: '0.0.0.0', BANDI_TOKEN: TOKEN });
  if (!(await waitUp())) throw new Error('重启后没起来：' + log.slice(-500));
  const meR = await call('GET', '/api/me', { cookie: adminCookie });
  check('重启服务后原 Cookie 仍有效（会话在库里，不是内存）', meR.status === 200 && meR.body?.kind === 'user',
    `${meR.status} ${meR.body?.kind ?? meR.body?.code}`);
  const fake = await call('GET', '/api/me', { cookie: 'bandi_sid=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
  check('伪造 Cookie → 401', fake.status === 401, String(fake.status));

  /* ============ ⑨ 改密码踢下线 ============ */
  console.log('\n⑨ 改密码 = 别处登过的全部下线');
  const relogin = await call('POST', '/api/login', { body: ADMIN });
  const c2 = cookieOf(relogin.setCookie);
  check('重新登录拿到新票', relogin.status === 200 && !!c2);
  const chpw = await call('PATCH', `/api/users/${encodeURIComponent(adminId)}`, {
    cookie: c2, body: { password: 'new-wang-pass-9' },
  });
  check('改密码 → 200', chpw.status === 200, `${chpw.status} ${chpw.body?.code ?? ''}`);
  const meCh = await call('GET', '/api/me', { cookie: c2 });
  check('改完密码，刚那张票立刻失效', meCh.status === 401, String(meCh.status));
  const oldpw = await call('POST', '/api/login', { body: ADMIN });
  check('旧密码登不进 → 401', oldpw.status === 401, String(oldpw.status));
  const newpw = await call('POST', '/api/login', { body: { name: ADMIN.name, password: 'new-wang-pass-9' } });
  check('新密码能登 → 200', newpw.status === 200, String(newpw.status));

  /* ============ ⑩ 登录限速 ============ */
  console.log('\n⑩ 登录失败限速：同一 IP + 同一用户名 5 分钟 5 次 → 429');
  const ghostName = '限速测试用';
  let saw429 = false;
  let last = null;
  for (let i = 0; i < 6; i += 1) {
    last = await call('POST', '/api/login', { body: { name: ghostName, password: 'wrong-pass' } });
    if (last.status === 429) { saw429 = true; break; }
  }
  check('连打 6 次至少出现一次 429（E3806）', saw429 && last?.body?.code === 'E3806',
    `${last?.status} ${last?.body?.code ?? ''}`);

  /* ============ ⑩.5 删角色前要问「还有没有账号在用」 ============ */
  /*
   * 悬空 roleId 的后果：`/api/me` 回 role=null → 前端拿不到 menuKeys → 菜单全消失，
   * 人只会觉得"我被降权了"。所以角色被账号绑着时必须拦住，先把账号换走。
   */
  console.log('\n⑩.5 删角色前要问「还有没有账号在用」');
  const tmpRole = await call('POST', '/api/roles', { token: TOKEN, body: { name: '临时角色', menuKeys: ['messages'] } });
  const tmpRoleId = tmpRole.body?.role?.id;
  check('建一个临时角色 → 201', tmpRole.status === 201 && !!tmpRoleId, `${tmpRole.status}`);
  const tmpUser = await call('POST', '/api/users', {
    token: TOKEN,
    body: { name: '临时工', password: 'temp-pass-01', roleId: tmpRoleId },
  });
  check('建一个用它的账号 → 201', tmpUser.status === 201, String(tmpUser.status));
  const delUsed = await call('DELETE', `/api/roles/${encodeURIComponent(tmpRoleId)}`, { token: TOKEN });
  check('删还有账号在用的角色 → 409 E2071', delUsed.status === 409 && delUsed.body?.code === 'E2071',
    `${delUsed.status} ${delUsed.body?.code ?? ''}`);
  await call('DELETE', `/api/users/${encodeURIComponent(tmpUser.body?.user?.id)}`, { token: TOKEN });
  const delFree = await call('DELETE', `/api/roles/${encodeURIComponent(tmpRoleId)}`, { token: TOKEN });
  check('账号删掉后可以删角色 → 200', delFree.status === 200, String(delFree.status));

  /* ============ ⑪ 不回归：回环形态 ============ */
  /*
   * 任务书 §三 第一条硬约束：`operator` / `device` / `node` 的行为**一个字节都不许变**。
   * 最容易踩的就是「回环分支有没有排在会话检查前面」—— 排后面的话，本机打不开自己的面板。
   */
  console.log('\n⑪ 不回归：回环形态照旧免登录 operator（API），但**面板要登录**（2026-10-31）');
  await stopAll();
  start(); // 不设 BANDI_HOST = 只听回环
  if (!(await waitUp())) throw new Error('回环实例没起来：' + log.slice(-500));
  const meLoop = await call('GET', '/api/me');
  check('回环 /api/me → operator（不需要任何凭据）', meLoop.status === 200 && meLoop.body?.kind === 'operator',
    `${meLoop.status} ${meLoop.body?.kind}`);
  const meLoopJunk = await call('GET', '/api/me', { cookie: 'bandi_sid=garbage-value' });
  check('回环下带一张乱码 Cookie 也还是 operator（回环分支在会话之前）',
    meLoopJunk.status === 200 && meLoopJunk.body?.kind === 'operator', `${meLoopJunk.status} ${meLoopJunk.body?.kind}`);
  const stLoop = await call('GET', '/api/state');
  check('回环 /api/state 照旧免登录 200', stLoop.status === 200, String(stLoop.status));
  // 同一个数据目录里已经有用户了（② 里建的）—— 回环操作员的「我」自动落到第一个用户头上
  check('回环 /api/state 的 me = 第一个用户（本机自动登录）',
    stLoop.body?.me?.id === first.body?.user?.id, JSON.stringify(stLoop.body?.me ?? {}));
  /*
   * ⑪.1 面板要登录（2026-10-31）：这台"机器"已经建过账号，回环抓首页没会话 → 登录页
   * （账号磁贴）；免密账号从磁贴那条路（/api/login 空密码）进来后，同一张首页就是面板。
   */
  const pageLoop = await fetch(BASE + '/', { headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(5000) });
  const htmlLoop = await pageLoop.text();
  check('回环抓首页（有账号、无会话）→ 登录页带账号磁贴',
    pageLoop.status === 200 && htmlLoop.includes('id="tiles"') && !htmlLoop.includes('/app.mjs'),
    String(pageLoop.status));
  const tileLogin = await call('POST', '/api/login', { body: { name: ADMIN.name, password: 'new-wang-pass-9' } });
  const loopCookie = cookieOf(tileLogin.setCookie);
  check('磁贴那条路 = /api/login（管理员密码登录）→ 200', tileLogin.status === 200 && !!loopCookie,
    String(tileLogin.status));
  const pageIn = await fetch(BASE + '/', {
    headers: { Accept: 'text/html', Cookie: loopCookie }, signal: AbortSignal.timeout(5000),
  });
  const htmlIn = await pageIn.text();
  check('带着会话票抓首页 → 面板本体（不再挡登录页）',
    pageIn.status === 200 && htmlIn.includes('/app.mjs') && !htmlIn.includes('id="tiles"'), String(pageIn.status));
  const meLoopUser = await call('GET', '/api/me', { cookie: loopCookie });
  check('回环 + 会话：/api/me 按登录人算（不再永远是 operator）',
    meLoopUser.status === 200 && meLoopUser.body?.kind === 'user' && meLoopUser.body?.user?.name === ADMIN.name,
    `${meLoopUser.status} ${JSON.stringify(meLoopUser.body?.user ?? {})}`);

  console.log(`\n${failed ? '✗ 有 ' + failed + ' 项没过' : '✓ 全部通过'}`);
} catch (err) {
  failed += 1;
  console.error('\n✗ 冒烟跑挂了：', err?.message ?? err);
  if (log) console.error('服务端日志尾部：\n' + log.slice(-1200));
} finally {
  await cleanup();
}

process.exit(failed ? 1 : 0);
