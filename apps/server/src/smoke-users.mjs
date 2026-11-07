/**
 * 账号与登录（2026-11-07 中枢一刀）的验收。
 *
 * 这一刀把**本机凭据层整体退场**了：登录入口只有中枢账号密码框
 * （POST /hub/login，转发给中枢），本文件不再测任何本机密码 / 角色 / 菜单权限。
 * 登录 = 全权，本机账号只是中枢账号的影子。这份冒烟钉的是新世界的形状：
 *
 *   ① 登录页只有一张：中枢账号密码表单（action="/hub/login"），零账号也是它；
 *   ② 首次登录：中枢认人 → 绑本机用户 → 发 bandi_sid（ hub 这条路是**唯一**真路，
 *      用假中枢 hub-stub.mjs 起一个，把 hub.json 指过去）；
 *   ③ /api/me = { kind:'user', user:{id,name} } —— 没有任何角色 / 菜单字段；
 *   ④ 本地账号只是影子：POST /api/users 只收 name，第一个账号自动 builtin；
 *      PATCH 只认 name / disabled；内置账号不可删不可禁（E3808）；
 *   ⑤ 退出登录：会话真删（回环退回 operator，不是还挂着一个 user）；
 *   ⑥ 安全接口只认会话里的身份 —— operator（机器凭据）打 /api/security/* → 401 E3810；
 *   ⑦ 会话落库：重启（顺手换成服务器形态）后原 Cookie 仍有效，死票 / 伪造票一律 401。
 *
 * 纯管理动作（建 / 列 / 删账号）走回环 operator：BANDI_HOST=127.0.0.1、不带会话
 * Cookie 即 operator，跟登录是两条独立的路，互不干扰。
 *
 * 隔离：临时数据目录 + 临时端口 + 假中枢（hub-stub.mjs），跑完全删，不碰 data/。
 * 跑法：SMOKE_PORT=8909 node apps/server/src/smoke-users.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { repoRoot } from './config.mjs';
import { sleep, stopRunning } from './lifecycle.mjs';
// 假中枢 + 登录帮手：造会话只有一条真路 —— 起个假中枢，让本机把登录表单转给它
import { startHubStub, hubLogin } from './hub-stub.mjs';

const PORT = Number(process.env.SMOKE_PORT ?? 8909);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-users-'));
const dataDir = path.join(tmp, 'data');
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
      // 中枢地址永远有值，但测试里必须显式指到假中枢（写 hub.json），
      // 不然就去连真的 hub.yuancang.space 了 —— 空串逼服务器去读 hub.json
      BANDI_HUB: '',
      BANDI_DATA: dataDir,
      BANDI_DB: path.join(dataDir, 'bandi.db'),
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

/*
 * CSRF 双提交（IAM §10.2）：带 Cookie 凭据的写请求要 `bandi_csrf` Cookie 与
 * `X-Bandi-CSRF` 头成对。smoke 模拟**同一个浏览器**：任何 HTML 响应种下 bandi_csrf
 * 就记进 jar，后续带 cookie 的请求自动合并进 Cookie 头并带上同名 header。
 */
let CSRF = '';

/** 统一请求：`cookie` / `token` 二选 N，写请求都带 X-Bandi（来源闸认它） */
const call = async (method, p, { body, cookie, token } = {}) => {
  const headers = { 'Content-Type': 'application/json', 'X-Bandi': '1' };
  if (cookie) headers.Cookie = CSRF ? `${cookie}; bandi_csrf=${CSRF}` : cookie;
  else if (CSRF && method !== 'GET') headers.Cookie = `bandi_csrf=${CSRF}`;
  if (method !== 'GET' && CSRF) headers['X-Bandi-CSRF'] = CSRF;
  if (token) headers['X-Bandi-Token'] = token;
  const r = await fetch(BASE + p, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });
  const raw = await r.text();
  const sc = r.headers.get('set-cookie') ?? '';
  const mCsrf = /bandi_csrf=([^;]*)/.exec(sc);
  if (mCsrf) CSRF = decodeURIComponent(mCsrf[1]); // 浏览器语义：页面响应把 csrf 种进 jar
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* HTML 或空 */ }
  return { status: r.status, body: parsed, raw, setCookie: sc };
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
  try { await HUB.close(); } catch { /* 已经关了 */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
};

/* 假中枢：两个中枢账号。甲带 name（本机影子账号该用它，而不是登录名） */
const HUB = await startHubStub({
  deviceId: 'dev_self',
  accounts: {
    甲: { password: '甲-pass-123', name: '老板' },
    乙: { password: '乙-pass-456' },
  },
});

// 把本机 hub 配置指到假中枢：baseUrl + 公钥，deviceId/deviceToken 一并落盘（mirror smoke-hub.mjs [4c]）
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(
  path.join(dataDir, 'hub.json'),
  JSON.stringify({
    baseUrl: HUB.url,
    publicKey: HUB.publicKey,
    deviceId: 'dev_self',
    deviceToken: 'dt_stub',
  }, null, 2),
  { mode: 0o600 },
);

try {
  /* 回环形态：API 免登录（operator），面板要会话 —— 任务书的确定性底座 */
  start({ BANDI_HOST: '127.0.0.1' });
  if (!(await waitUp())) throw new Error('实例没起来：' + log.slice(-500));

  // 登录页种下 CSRF 双提交对（无会话 → 回登录页，顺手 set-cookie bandi_csrf）
  const seed = await fetch(BASE + '/', { headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(5000) });
  const seedSc = seed.headers.get('set-cookie') ?? '';
  const seedCsrf = /bandi_csrf=([^;]*)/.exec(seedSc);
  if (seedCsrf) CSRF = decodeURIComponent(seedCsrf[1]);

  /* ============ ① 登录页：中枢账号表单是唯一一张 ============ */
  console.log('① 登录页：只有中枢账号密码框（零账号也是它）');
  const page0 = await fetch(BASE + '/', { headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(5000) });
  const html0 = await page0.text();
  check('零账号 GET / → 200 登录页', page0.status === 200, String(page0.status));
  check('表单提交到本机 /hub/login（人不跳域）', html0.includes('action="/hub/login"'));
  check('用户名 / 密码字段在', html0.includes('name="username"') && html0.includes('name="password"'));
  check('登录即注册：没有单独的注册按钮', !html0.includes('value="register"') && (html0.match(/<button/g) ?? []).length === 1);
  const me0 = await call('GET', '/api/me');
  check('回环 /api/me 照旧 operator（机器侧的闸没变）', me0.status === 200 && me0.body?.kind === 'operator',
    `${me0.status} ${me0.body?.kind ?? me0.body?.code}`);

  /* ============ ② 建阴影账号（预占名字），回环 operator 免登录 ============ */
  console.log('\n② POST /api/users 只收 name：第一个=内置，重名/空名/超长拦下');
  const cBoss = await call('POST', '/api/users', { body: { name: '老板' } });
  check('POST {name} → 201（预占影子账号）', cBoss.status === 201, `${cBoss.status} ${cBoss.raw?.slice(0, 80)}`);
  check('第一个账号 first:true 且自动 builtin（防锁死）',
    cBoss.body?.first === true && cBoss.body?.user?.builtin === true, JSON.stringify(cBoss.body?.user ?? {}));
  const cBing = await call('POST', '/api/users', { body: { name: '丙' } });
  check('第二个 POST {name} → 201，first:false 且 builtin:false',
    cBing.status === 201 && cBing.body?.first === false && cBing.body?.user?.builtin === false,
    JSON.stringify(cBing.body?.user ?? {}));

  /* ============ ③ GET /api/users 列表形状 ============ */
  console.log('\n③ GET /api/users：列表形状，零凭据字段');
  const users0 = await call('GET', '/api/users');
  check('GET /api/users → 200（回环 operator 免登录）', users0.status === 200, String(users0.status));
  check('hasUsers:true，正好两个账号', users0.body?.hasUsers === true && users0.body?.users?.length === 2,
    JSON.stringify(users0.body?.users?.map((u) => u.name)));
  const ALLOWED = new Set(['id', 'name', 'builtin', 'disabled', 'createdAt', 'updatedAt']);
  check('列表字段只有 id/name/builtin/disabled/createdAt/updatedAt（无凭据字段）',
    (users0.body?.users ?? []).every((u) => Object.keys(u).every((k) => ALLOWED.has(k))),
    JSON.stringify(Object.keys(users0.body?.users?.[0] ?? {})));

  const dup = await call('POST', '/api/users', { body: { name: ' 丙 ' } });
  check('重名（首尾空白归一）→ 409 E3802', dup.status === 409 && dup.body?.code === 'E3802',
    `${dup.status} ${dup.body?.code ?? ''}`);
  const blank = await call('POST', '/api/users', { body: { name: '   ' } });
  check('空名字 → 400 E3801', blank.status === 400 && blank.body?.code === 'E3801', `${blank.status} ${blank.body?.code ?? ''}`);
  const long = await call('POST', '/api/users', { body: { name: '一'.repeat(21) } });
  check('超过 20 个字 → 400 E3801', long.status === 400 && long.body?.code === 'E3801', `${long.status} ${long.body?.code ?? ''}`);

  /* ============ ④ PATCH 改名 / 内置保护 / DELETE ============ */
  console.log('\n④ PATCH 只认 name / disabled；内置账号不可删不可禁');
  const pid = cBing.body?.user?.id;
  const bossId = cBoss.body?.user?.id;
  const rn = await call('PATCH', `/api/users/${encodeURIComponent(pid)}`, { body: { name: '丙二' } });
  check('改名 → 200', rn.status === 200 && rn.body?.user?.name === '丙二', `${rn.status} ${rn.body?.user?.name}`);
  const disBuiltin = await call('PATCH', `/api/users/${encodeURIComponent(bossId)}`, { body: { disabled: true } });
  check('禁用内置账号 → 403 E3808', disBuiltin.status === 403 && disBuiltin.body?.code === 'E3808',
    `${disBuiltin.status} ${disBuiltin.body?.code ?? ''}`);
  const delBuiltin = await call('DELETE', `/api/users/${encodeURIComponent(bossId)}`);
  check('删内置账号 → 403 E3808（防锁死锚）', delBuiltin.status === 403 && delBuiltin.body?.code === 'E3808',
    `${delBuiltin.status} ${delBuiltin.body?.code ?? ''}`);
  const delC = await call('DELETE', `/api/users/${encodeURIComponent(pid)}`);
  check('删影子账号 → 200', delC.status === 200 && delC.body?.ok === true, String(delC.status));
  const ghost = await call('DELETE', '/api/users/u_nosuch');
  check('删不存在的 → 404 E3807', ghost.status === 404 && ghost.body?.code === 'E3807', `${ghost.status} ${ghost.body?.code ?? ''}`);

  /* ============ ⑤ 中枢登录（唯一真路）= 认人 → 绑本机用户 → 发会话 ============ */
  console.log('\n⑤ 中枢登录（假中枢）全链：绑本机用户 + 发 bandi_sid');
  const first = await hubLogin(BASE, { username: '甲', password: '甲-pass-123', origin: BASE });
  check('对的账号密码 → 302 回首页', first.status === 302 && first.location === '/', `HTTP ${first.status}`);
  check('Set-Cookie 发了 bandi_sid', !!first.sid);
  // 会话票的浏览器侧约定（与 store.SESSION_DAYS 同步的 30 天）单独钉一次
  const raw1 = await fetch(`${BASE}/hub/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE },
    body: new URLSearchParams({ username: '甲', password: '甲-pass-123' }).toString(),
    redirect: 'manual',
  });
  const sc1 = raw1.headers.get('set-cookie') ?? '';
  check('会话 Cookie：HttpOnly / SameSite=Lax / 30 天',
    /HttpOnly/i.test(sc1) && /SameSite=Lax/i.test(sc1) && /Max-Age=2592000/.test(sc1), sc1.slice(0, 80));

  const sidA = `bandi_sid=${first.sid}`;
  const meA = await call('GET', '/api/me', { cookie: sidA });
  check('/api/me → kind:user', meA.body?.kind === 'user', `${meA.status} ${JSON.stringify(meA.body ?? {})}`);
  // 本机名条的名字**随中枢对齐**（登录时自动改名）：老板 → 甲；hub = 绑着的中枢账号
  check('user = id + name + hub（名字已对齐中枢，无角色 / 凭据字段）', (() => {
    const u = meA.body?.user;
    if (!u) return false;
    const ks = Object.keys(u);
    return ks.length === 3 && ks.includes('id') && ks.includes('name') && ks.includes('hub')
      && u.name === '甲' && u.hub === '甲';
  })(), JSON.stringify(meA.body?.user ?? {}));
  const meAId = meA.body?.user?.id;

  /* ============ ⑤b hubAccounts：这台机器认下的中枢账号名单 ============ */
  console.log('\n⑤b GET /api/users 带出 hubAccounts（中枢账号 ↔ 影子账号绑定）');
  const users1 = await call('GET', '/api/users');
  const hub0 = users1.body?.hubAccounts;
  check('hubAccounts 是数组且正好一行（甲登录时自动认下的那个）',
    Array.isArray(hub0) && hub0.length === 1, JSON.stringify(hub0));
  check('行里带 login / userName / lastEnterAt（页面「中枢账号」节的数据源）',
    hub0?.[0]?.login === '甲' && hub0?.[0]?.userName === '甲' && typeof hub0?.[0]?.lastEnterAt === 'string',
    JSON.stringify(hub0?.[0] ?? null));
  check('不回中枢侧凭据（无 deviceToken / publicKey 之类）',
    !!hub0?.[0] && !Object.keys(hub0[0]).some((k) => /token|secret|key/i.test(k)),
    JSON.stringify(Object.keys(hub0?.[0] ?? {})));

  /* ============ ⑥ 退出登录 ============ */
  console.log('\n⑥ 退出登录：会话真删（回环退回 operator）');
  const lo = await call('POST', '/api/logout', { cookie: sidA });
  check('POST /api/logout → 200 且种下 Max-Age=0 的清场 Cookie',
    lo.status === 200 && /bandi_sid=;/.test(lo.setCookie ?? '') && /Max-Age=0/.test(lo.setCookie ?? ''),
    String(lo.setCookie ?? '').slice(0, 90));
  const meAfter = await call('GET', '/api/me', { cookie: sidA });
  check('退出后原票失效：回环退回 operator（不是还挂着一个 user）',
    meAfter.status === 200 && meAfter.body?.kind === 'operator', `${meAfter.status} ${meAfter.body?.kind}`);

  /* ============ ⑦ 第二个中枢账号：登录即放行，自动建自己的影子账号 ============ */
  console.log('\n⑦ 登录即放行：乙凭对密码直接进门（自动建影子账号「乙」）');
  const second = await hubLogin(BASE, { username: '乙', password: '乙-pass-456', origin: BASE });
  check('乙凭对密码 → 302 进门（不再有 bandi hub allow 那道闸）', second.status === 302 && !!second.sid,
    `HTTP ${second.status}`);
  const listAfter = await call('GET', '/api/users');
  check('本机名册长出乙的影子（非内置；此时共老板/甲/乙三个）',
    listAfter.status === 200 && listAfter.body?.users?.length === 3
      && listAfter.body.users.some((u) => u.name === '乙' && !u.builtin),
    JSON.stringify(listAfter.body?.users ?? []).slice(0, 140));

  /* ============ ⑧ 安全接口：只认会话里的身份 ============ */
  console.log('\n⑧ /api/security/* 只认会话身份（operator 是机器凭据，不是"我"）');
  // ⑥ 把甲登出了（绑定还在 —— 绑定表与登录会话是两回事），再登一次拿活会话
  const again = await hubLogin(BASE, { username: '甲', password: '甲-pass-123', origin: BASE });
  check('绑过的账号再登录 → 照常 302', again.status === 302 && !!again.sid,
    `HTTP ${again.status}`);
  const sess = await call('GET', '/api/security/sessions', { cookie: `bandi_sid=${again.sid}` });
  check('登录用户 GET /api/security/sessions → 200 列表',
    sess.status === 200 && Array.isArray(sess.body?.sessions) && sess.body.sessions.length >= 1,
    `${sess.status} ${sess.body?.sessions?.length ?? sess.body?.code}`);
  check('会话列表只给 8 位指纹，不给 tokenHash 全量',
    (sess.body?.sessions ?? []).every((s) => typeof s.id === 'string' && s.id.length === 8 && !('tokenHash' in s)),
    JSON.stringify(Object.keys(sess.body?.sessions?.[0] ?? {})));
  const audit = await call('GET', '/api/security/audit', { cookie: `bandi_sid=${again.sid}` });
  check('登录用户读审计日志 → 200', audit.status === 200 && Array.isArray(audit.body?.events), String(audit.status));
  const opSec = await call('GET', '/api/security/sessions');
  check('operator（免登录的机器身份）→ 401 E3810', opSec.status === 401 && opSec.body?.code === 'E3810',
    `${opSec.status} ${opSec.body?.code ?? ''}`);

  /* ============ ⑨ 登录失败：原地回登录页 ============ */
  console.log('\n⑨ 登录失败：原地回登录页（中枢的拒绝，本机不遮不掩）');
  const bad = await hubLogin(BASE, { username: '甲', password: 'not-the-password', origin: BASE });
  check('错密码 → 401 回登录页（表单还在，能重输）', bad.status === 401 && bad.html.includes('action="/hub/login"'),
    `HTTP ${bad.status}`);
  // 登录即注册 + 登录即放行：没见过的手机号在中枢注册成功，进门自动建自己的影子账号
  const ghostLogin = await hubLogin(BASE, { username: '13900139000', password: 'whatever-123', origin: BASE });
  check('没注册过的手机号 → 中枢自动注册，进门自动建影子账号 → 302',
    ghostLogin.status === 302 && !!ghostLogin.sid, `HTTP ${ghostLogin.status}`);

  /* ============ ⑩ 会话落库 + 服务器形态 ============ */
  console.log('\n⑩ 会话落库：重启后仍有效；服务器形态下死票 / 伪造票一律 401');
  await stopAll();
  start({ BANDI_HOST: '0.0.0.0', BANDI_TOKEN: TOKEN }); // 同一份数据目录，换成对外监听
  if (!(await waitUp())) throw new Error('重启后没起来：' + log.slice(-500));
  const meR = await call('GET', '/api/me', { cookie: `bandi_sid=${again.sid}` });
  check('重启后甲的会话仍有效（会话在库里，不是内存）',
    meR.status === 200 && meR.body?.kind === 'user' && meR.body?.user?.id === meAId,
    `${meR.status} ${meR.body?.kind ?? meR.body?.code}`);
  const meDead = await call('GET', '/api/me', { cookie: sidA });
  check('⑥ 里退出那张票重启后也是死的 → 401（删除是持久的）', meDead.status === 401,
    `${meDead.status} ${meDead.body?.code ?? ''}`);
  const fake = await call('GET', '/api/me', { cookie: `bandi_sid=${'A'.repeat(43)}` });
  check('伪造 Cookie → 401', fake.status === 401, `${fake.status} ${fake.body?.code ?? ''}`);
  const meNoCred = await call('GET', '/api/me');
  check('服务器形态：不带凭据 → 401 E4010（机器侧的闸没跟着放宽）',
    meNoCred.status === 401 && meNoCred.body?.code === 'E4010', `${meNoCred.status} ${meNoCred.body?.code ?? ''}`);
  const stTok = await call('GET', '/api/state', { token: TOKEN });
  check('共享令牌照旧能读 /api/state（⑨ 的兜底：root 没被关在门外）', stTok.status === 200, String(stTok.status));

  console.log(`\n${failed ? '✗ 有 ' + failed + ' 项没过' : '✓ 全部通过'}`);
} catch (err) {
  failed += 1;
  console.error('\n✗ 冒烟跑挂了：', err?.message ?? err);
  if (log) console.error('服务端日志尾部：\n' + log.slice(-1200));
} finally {
  await cleanup();
}

process.exit(failed ? 1 : 0);
