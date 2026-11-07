/*
 * smoke-admin-invariant.mjs —— 内置账号不变量（2026-11-07 中枢一刀之后重写）。
 *
 * 旧版测的是「本地凭据层 + 角色体系」那一套（setup_code / X-Bandi-Setup / roleId /
 * 免密 admin / 密码锁定 / 最后一个管理员 E4096 / 受限会话 E4098），那一层已整体退场。
 * 现在账号全在身份中枢，本机只有一个账号密码框（POST /hub/login），**登录即全权**。
 * 这份冒烟钉的是新世界里还活着的两条：
 *
 *   ① 防锁死的锁：第一个登录进来的中枢账号会在本机绑出第一个（= 内置 builtin:true）
 *      影子账号 —— hub 绑定都指着它，删/禁它等于把管理员自己关在门外（E3808 两道）；
 *      名字是它的另一条腿：占用即 E3802；
 *   ② 登录即全权下的账号接口：普通中枢会话就能管影子账号、读审计、看/踢自己的会话
 *      （安全口只认**会话里**的身份 —— 回环 operator 反而不行，机器不是人）。
 *      多个中枢账号绑定的是**同一个**本地首账号 —— 本地没有"第二个有会话的用户"可造。
 *
 * 流程（照 smoke-hub.mjs [4c] 的写法）：起一个假中枢 → 把本机 hub.json 指到它 →
 * 在回环（loopback）形态下 hubLogin 一次 → 中枢认人 → 绑本机第一个用户（builtin）。
 * 之后管理动作走 **回环 operator**（不带会话 Cookie 即 operator、全权），这正是
 * 老版「operator 能管理用户」那条意图在新世界的等价体。
 *
 * 隔离：临时数据目录 + 临时端口 + 假中枢（hub-stub.mjs），跑完全删，不碰 data/。
 * 跑法：SMOKE_PORT=8904 node apps/server/src/smoke-admin-invariant.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { repoRoot } from './config.mjs';
import { sleep } from './lifecycle.mjs';
import { startHubStub, hubLogin } from './hub-stub.mjs';

const PORT = Number(process.env.SMOKE_PORT ?? 8904);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-admininv-'));
const dataDir = tmp;
const SERVER = path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs');
const CLI = path.join(repoRoot, 'apps', 'server', 'src', 'cli.mjs');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

/* 假中枢：一个中枢账号「甲」，登录时本机会绑出第一个（内置）用户 */
const stub = await startHubStub({ deviceId: 'dev_self', accounts: { 甲: { password: '甲-pass-123', name: '老板' } } });
/* 把本机的中枢配置指到假中枢（照 smoke-hub.mjs [4c] 的写法） */
fs.writeFileSync(
  path.join(dataDir, 'hub.json'),
  JSON.stringify({ baseUrl: stub.url, publicKey: stub.publicKey, deviceId: 'dev_self', deviceToken: 'dt_stub' }, null, 2),
  { mode: 0o600 },
);

let child = null;
let log = '';
child = spawn(process.execPath, [SERVER], {
  cwd: repoRoot,
  // 回环形态（BANDI_HOST:127.0.0.1）：API 免登录 operator；不指 BANDI_HUB，留着让 hub.json 生效
  env: { ...process.env, BANDI_PORT: String(PORT), BANDI_HOST: '127.0.0.1', BANDI_DATA: dataDir, BANDI_DB: path.join(dataDir, 'bandi.db') },
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

/*
 * 回环 operator（无会话 Cookie）不需要 CSRF 双提交；写请求统一带 X-Bandi:1 头。
 * cookie 只在「以登录用户身份」发请求时用，GET 不需要 CSRF，所以这里不处理逻辑写。
 */
let CSRF = '';
const call = async (method, p, { body, cookie } = {}) => {
  const headers = { 'Content-Type': 'application/json', 'X-Bandi': '1' };
  if (cookie) headers.Cookie = CSRF ? `${cookie}; bandi_csrf=${CSRF}` : cookie;
  else if (CSRF && method !== 'GET') headers.Cookie = `bandi_csrf=${CSRF}`;
  if (method !== 'GET' && CSRF) headers['X-Bandi-CSRF'] = CSRF;
  const r = await fetch(BASE + p, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });
  const raw = await r.text();
  const sc = r.headers.get('set-cookie') ?? '';
  const mCsrf = /bandi_csrf=([^;]*)/.exec(sc);
  if (mCsrf) CSRF = decodeURIComponent(mCsrf[1]);
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* HTML 或空 */ }
  return { status: r.status, body: parsed, raw, setCookie: sc };
};

try {
  if (!(await waitUp())) throw new Error('实例没起来：' + log.slice(-500));

  /* ============ ① 中枢登录建出第一个（内置）账号 ============ */
  console.log('\n① 中枢账号登录 → 绑本机第一个用户（builtin）');
  const first = await hubLogin(BASE, { username: '甲', password: '甲-pass-123', origin: BASE });
  check('对的账号密码 → 302 进面板', first.status === 302 && first.location === '/' && !!first.sid, `HTTP ${first.status}`);
  const sid = `bandi_sid=${first.sid}`;

  /* ============ ② 回环 operator 看用户列表：第一个账号是 builtin ============ */
  console.log('\n② 回环 operator（免登录）看用户列表');
  const list0 = await call('GET', '/api/users');
  check('GET /api/users → 200（回环 operator 免登录）', list0.status === 200, String(list0.status));
  check('正好一个账号，hasUsers=true', list0.body?.hasUsers === true && list0.body?.users?.length === 1, JSON.stringify(list0.body?.users ?? []));
  const builtin = list0.body?.users?.[0];
  check('第一个账号 builtin=true（防锁死的锁）', builtin?.builtin === true && builtin?.id, JSON.stringify(builtin ?? {}));
  check('列表不含任何凭据字段', !['salt', 'hash', 'password', 'roleId'].some((k) => k in (builtin ?? {})), JSON.stringify(Object.keys(builtin ?? {})));

  /* ============ ③ 内置账号不可删 / 不可禁（E3808） ============ */
  console.log('\n③ 内置账号不可删不可禁（E3808）');
  const delBuiltin = await call('DELETE', `/api/users/${encodeURIComponent(builtin.id)}`);
  check('删内置账号 → 403 E3808', delBuiltin.status === 403 && delBuiltin.body?.code === 'E3808', `${delBuiltin.status} ${delBuiltin.body?.code ?? ''}`);
  const disBuiltin = await call('PATCH', `/api/users/${encodeURIComponent(builtin.id)}`, { body: { disabled: true } });
  check('禁内置账号 → 403 E3808', disBuiltin.status === 403 && disBuiltin.body?.code === 'E3808', `${disBuiltin.status} ${disBuiltin.body?.code ?? ''}`);

  /* ============ ④ 第二个影子账号：不是 builtin，可自由禁用 / 删除 ============ */
  console.log('\n④ 第二个影子账号：非内置，可禁可删');
  const second = await call('POST', '/api/users', { body: { name: '老张' } });
  check('POST {name} → 201（预占影子账号）', second.status === 201, `${second.status} ${second.raw?.slice(0, 80)}`);
  check('非第一个：builtin=false 且 first=false', second.body?.user?.builtin === false && second.body?.first === false, JSON.stringify(second.body?.user ?? {}));
  const secondId = second.body?.user?.id;
  const disSecond = await call('PATCH', `/api/users/${encodeURIComponent(secondId)}`, { body: { disabled: true } });
  check('禁用第二个账号 → 200', disSecond.status === 200, `${disSecond.status} ${disSecond.body?.code ?? ''}`);
  const delSecond = await call('DELETE', `/api/users/${encodeURIComponent(secondId)}`);
  check('删第二个账号 → 200', delSecond.status === 200 && delSecond.body?.ok === true, String(delSecond.status));

  /* ============ ⑤ 内置账号确实没被动到 ============ */
  console.log('\n⑤ 删/禁都没动到内置账号');
  const list1 = await call('GET', '/api/users');
  check('内置账号仍在且仍是 builtin',
    list1.body?.users?.length === 1 && list1.body?.users?.[0]?.id === builtin.id && list1.body?.users?.[0]?.builtin === true,
    JSON.stringify(list1.body?.users ?? []));

  /* ============ ⑥ 登录用户（那枚会话）也能看到内置账号 ============ */
  console.log('\n⑥ 以登录用户身份看：内置账号 builtin=true，且身份是 user');
  const listMe = await call('GET', '/api/users', { cookie: sid });
  check('带会话 GET /api/users → 200 且内置账号 builtin=true', listMe.status === 200 && listMe.body?.users?.[0]?.builtin === true, `${listMe.status} ${JSON.stringify(listMe.body?.users?.[0] ?? {})}`);
  const me = await call('GET', '/api/me', { cookie: sid });
  check('/api/me → kind=user（不是 role 那套了）', me.body?.kind === 'user', `${me.status} ${JSON.stringify(me.body ?? {})}`);

  /* ============ ⑦ 名字唯一性（E3802）：占用与改名都挡 ============ */
  console.log('\n⑦ 用户名唯一（E3802）');
  const dup = await call('POST', '/api/users', { body: { name: builtin.name } });
  check('建与内置账号同名的影子 → 409 E3802', dup.status === 409 && dup.body?.code === 'E3802', `${dup.status} ${dup.body?.code ?? ''}`);
  const third = await call('POST', '/api/users', { body: { name: '老李' } });
  check('建第三个账号 → 201', third.status === 201, `${third.status} ${third.raw?.slice(0, 80)}`);
  const renameDup = await call('PATCH', `/api/users/${encodeURIComponent(third.body?.user?.id)}`, { body: { name: builtin.name } });
  check('改名撞上已占用 → 409 E3802', renameDup.status === 409 && renameDup.body?.code === 'E3802', `${renameDup.status} ${renameDup.body?.code ?? ''}`);
  const delThird = await call('DELETE', `/api/users/${encodeURIComponent(third.body?.user?.id)}`);
  check('删第三个账号 → 200', delThird.status === 200, String(delThird.status));

  /* ============ ⑧ 登录即全权：安全口对普通会话开放 ============ */
  console.log('\n⑧ 安全接口（审计 / 会话）对登录会话开放，且只认会话里的身份');
  const opAudit = await call('GET', '/api/security/audit');
  check('回环 operator 摸审计 → 401 E3810（口子只认会话里的身份，机器不是人）',
    opAudit.status === 401 && opAudit.body?.code === 'E3810', `${opAudit.status} ${opAudit.body?.code ?? ''}`);
  const audit = await call('GET', '/api/security/audit', { cookie: sid });
  check('登录会话读审计 → 200（原 admin 专属）', audit.status === 200 && Array.isArray(audit.body?.events), `${audit.status} ${audit.body?.code ?? ''}`);
  const sess = await call('GET', '/api/security/sessions', { cookie: sid });
  check('会话列表 → 200 且 id 是 8 位短哈希', sess.status === 200
    && (sess.body?.sessions?.length ?? 0) >= 1
    && (sess.body?.sessions ?? []).every((s) => typeof s.id === 'string' && s.id.length === 8), `${sess.status} ${sess.raw?.slice(0, 120)}`);

  // 第二个中枢账号：认领已关闭，凭对的密码也进不来（E7003，smoke-hub [4] 同款）；
  // 机器主人 `bandi hub allow` 放行后才进得来 —— 进来绑的还是**同一个**本地首账号
  // （本地不会冒出第二个有会话的用户）。
  const deny = await hubLogin(BASE, { username: '乙', password: '乙-pass-456', origin: BASE });
  check('第二个中枢账号凭对密码也进不来（认领已关闭）→ 403 E7003',
    deny.status === 403 && deny.html.includes('E7003'), `HTTP ${deny.status}`);
  const allowCli = spawnSync(process.execPath, [CLI, 'hub', 'allow', 'acc_乙'], {
    cwd: repoRoot,
    env: { ...process.env, BANDI_DATA: dataDir, BANDI_DB: path.join(dataDir, 'bandi.db'), NO_COLOR: '1' },
    encoding: 'utf8',
    windowsHide: true,
  });
  const allowOut = String(allowCli.stdout ?? '') + String(allowCli.stderr ?? '');
  check('bandi hub allow 放行成功', allowCli.status === 0 && allowOut.includes('已放行'), allowOut.trim().split('\n')[0]?.slice(0, 120));
  const reg = await hubLogin(BASE, { username: '乙', password: '乙-pass-456', origin: BASE });
  check('放行后的第二个中枢账号 → 302 进来', reg.status === 302 && !!reg.sid, `HTTP ${reg.status}`);
  const me2 = await call('GET', '/api/me', { cookie: `bandi_sid=${reg.sid}` });
  check('两个中枢账号 → 同一个本地用户（绑定收敛到首账号）',
    me2.body?.kind === 'user' && me2.body?.user?.id === me.body?.user?.id, `${me2.status} ${JSON.stringify(me2.body ?? {})}`);
  const list2 = await call('GET', '/api/users');
  check('本地名册仍然只有内置一个账号', list2.body?.users?.length === 1, JSON.stringify(list2.body?.users ?? []));

  /* 先补种 csrf（面板页自愈），再以第一枚会话踢掉其它会话 */
  await call('GET', '/', { cookie: sid });
  const kick = await call('POST', '/api/security/sessions/revoke-others', { cookie: sid });
  check('踢其它会话 → 200 且踢掉 ≥1 条（乙那枚）', kick.status === 200 && (kick.body?.kicked ?? 0) >= 1, `${kick.status} ${kick.raw?.slice(0, 100)}`);
  const sessAfter = await call('GET', '/api/security/sessions', { cookie: sid });
  check('踢完后只剩当前这张票', sessAfter.status === 200 && (sessAfter.body?.sessions?.length ?? 0) === 1, JSON.stringify(sessAfter.body ?? {}).slice(0, 120));
  const meKicked = await call('GET', '/api/security/audit', { cookie: `bandi_sid=${reg.sid}` });
  // ⚠️ 回环形态下死票在 /api/me 上会被 loopback operator 兜住（200），看不出死活 ——
  // 安全口只认会话里的身份，才是死票的照妖镜。
  check('被踢的那枚会话票摸安全口 → 401 E3810（会话真被删了）', meKicked.status === 401 && meKicked.body?.code === 'E3810', `${meKicked.status} ${meKicked.body?.code ?? ''}`);
} catch (err) {
  failed += 1;
  console.error('\n✗ 冒烟跑挂了：', err?.message ?? err);
  if (log) console.error('服务端日志尾部：\n' + log.slice(-1200));
} finally {
  try { child?.kill(); } catch { /* 已退 */ }
  await sleep(400);
  try { await stub.close(); } catch { /* 已经关了 */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
}

console.log(failed ? `\n✗ 有 ${failed} 项没过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
