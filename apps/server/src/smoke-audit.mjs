/*
 * smoke-audit.mjs —— 安全审计（2026-11-07 中枢一刀之后的形状）。
 *
 * 新世界：本地凭据层 + 角色/菜单权限全删了，登录只有中枢账号表单（POST /hub/login），
 * 「登录即全权」。这份冒烟钉的是 IAM §11.2 的核心承诺 —— **每一笔写都有主，每一次拒都有痕**
 * （2026-11-09 起同类拒绝按 60 秒窗口合并：一个窗口只落一行、并记"另有 N 次"，
 *  "痕"仍在，只是不再一行一次——见 ④ 里的两条降噪断言）。
 *
 *   ① 起假中枢（hub-stub.mjs），BANDI_HUB 指过去；服务器形态（0.0.0.0 + BANDI_TOKEN）起服务 ——
 *      匿名请求真的会吃 401（回环形态下没凭据 = operator，造不出拒绝样本）；
 *   ② 匿名 401 → guard 当场记 authz.deny；operator 令牌摸安全口 → 401 E3810（口子只认会话身份）；
 *   ③ 中枢表单登录换 bandi_sid，以登录用户身份做一串写操作；
 *   ④ 读审计：user.change 都有 actorKind='user' + actorId=本人；operator 令牌的写
 *      actorKind='operator'、actorId=null（机器不是人，不冒充任何账号）；
 *   ⑤ kind 筛选、全量导出、清空（2026-11-10 起：主表+归档一起真删、不留痕迹）都对会话开放；
 *   ⑥ 停服务直接开库：append-only 触发器（v2.4 口径）+ 90 天归档。
 *
 * 审计的事件 kind 是 server.mjs `auditKindOf` 写死的：
 *   · /api/users 上的写（建/禁/删）→ kind='user.change'
 *   · POST /api/logout            → kind='session.revoke'
 * 断言钉的是这些真字符串（不是猜的 user.create / user.delete 那套）。
 *
 * 端口口径：全部从 process.env.SMOKE_PORT ?? 8903 派生，避免并行撞车。
 * 跑法：node apps/server/src/smoke-audit.mjs   （或 SMOKE_PORT=<base> node ...）
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repoRoot } from './config.mjs';
import { sleep, stopRunning } from './lifecycle.mjs';
// 假中枢 + 登录帮手：造会话只有一条真路 —— 起个假中枢，让本机把登录表单转给它
import { startHubStub, hubLogin } from './hub-stub.mjs';

const PORT = Number(process.env.SMOKE_PORT ?? 8903);
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER = path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-audit-'));
const DB = path.join(tmp, 'bandi.db');
const TOKEN = 'audit-smoke-token';

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

let child = null;
let log = '';
const start = () => {
  log = '';
  child = spawn(process.execPath, [SERVER], {
    cwd: repoRoot,
    // 中枢地址永远有值：测试里必须显式指到假中枢，不然就去连真的 hub（那不是测试该干的事）。
    // 0.0.0.0 服务器形态：匿名请求真的会吃 401 —— 拒绝样本（authz.deny）只有在鉴权开时才存在。
    env: { ...process.env, BANDI_PORT: String(PORT), BANDI_DATA: tmp, BANDI_DB: DB, BANDI_HOST: '0.0.0.0', BANDI_TOKEN: TOKEN, BANDI_HUB: HUB.url },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
};

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
 * CSRF 双提交（IAM §10.2）：带 Cookie 凭据的写请求要 `bandi_csrf` Cookie 与
 * `X-Bandi-CSRF` 头成对。smoke 模拟**同一个浏览器**：登录页响应种下 bandi_csrf 就记
 * 进 jar（CSRF 全局），后续带 cookie 的写请求自动合并 + 带同名 header。
 */
let CSRF = '';

const call = async (method, p, { body, cookie, headers: extra = {} } = {}) => {
  const headers = { 'Content-Type': 'application/json', 'X-Bandi': '1', ...extra };
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
  const mCsrf = /bandi_csrf=([^;]*)/.exec(r.headers.get('set-cookie') ?? '');
  if (mCsrf) CSRF = decodeURIComponent(mCsrf[1]); // 浏览器语义：页面响应把 csrf 种进 jar
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* HTML 或空 */ }
  return { status: r.status, body: parsed, raw, setCookie: r.headers.get('set-cookie') ?? '' };
};

/** 假中枢：一个中枢账号。带 name（本机影子账号用它，而不是登录名） */
const HUB = await startHubStub({
  deviceId: 'dev_self',
  accounts: { 甲: { password: '甲-pass-123', name: '老王' } },
});

try {
  start();
  if (!(await waitUp())) throw new Error('实例没起来：' + log.slice(-500));

  /* ============ ① 匿名与机器身份：拒绝都有痕 ============ */
  console.log('① 匿名 401（guard 当场记 deny）；operator 令牌摸安全口 → 401 E3810');
  const denied0 = await call('GET', '/api/users'); // 无凭据 → 401，guard 当场记
  check('匿名（无凭据）→ 401 E4010', denied0.status === 401 && denied0.body?.code === 'E4010', `${denied0.status} ${denied0.body?.code ?? ''}`);
  const opSec = await call('GET', '/api/security/audit', { headers: { 'X-Bandi-Token': TOKEN } });
  check('operator 令牌摸审计 → 401 E3810（口子只认会话里的身份，机器不是人）',
    opSec.status === 401 && opSec.body?.code === 'E3810', `${opSec.status} ${opSec.body?.code ?? ''}`);

  /* ============ ② 中枢表单登录换会话，拿登录用户的 id ============ */
  console.log('\n② 中枢登录（POST /hub/login 全链）');
  const page = await fetch(BASE + '/', { headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(5000) });
  const pageSc = page.headers.get('set-cookie') ?? '';
  check('登录页种下 bandi_csrf（写请求要双提交对）', /bandi_csrf=/.test(pageSc), pageSc.slice(0, 80));
  if (/bandi_csrf=([^;]+)/.test(pageSc)) CSRF = decodeURIComponent(pageSc.match(/bandi_csrf=([^;]+)/)[1]);

  const first = await hubLogin(BASE, { username: '甲', password: '甲-pass-123', origin: BASE });
  check('对的账号密码 → 302 回首页', first.status === 302 && first.location === '/', `HTTP ${first.status}`);
  check('Set-Cookie 发了 bandi_sid', !!first.sid);
  const sidA = `bandi_sid=${first.sid}`;

  const meA = await call('GET', '/api/me', { cookie: sidA });
  check('/api/me → kind=user', meA.body?.kind === 'user', `${meA.status} ${JSON.stringify(meA.body ?? {})}`);
  const actorId = meA.body?.user?.id;
  check('拿到登录用户的 id（审计的 actorId 就该是它）', typeof actorId === 'string' && actorId.length > 0, String(actorId));

  /* ============ ③ 两种身份各做一串写操作 ============ */
  console.log('\n③ 写操作：登录用户（会话）与 operator（令牌）各来几笔');
  const mk = await call('POST', '/api/users', { cookie: sidA, body: { name: '小李' } });
  check('建影子账号 → 201', mk.status === 201, `${mk.status} ${mk.raw?.slice(0, 80)}`);
  const pid = mk.body?.user?.id;
  const dis = await call('PATCH', `/api/users/${encodeURIComponent(pid)}`, { cookie: sidA, body: { disabled: true } });
  check('禁用影子账号 → 200', dis.status === 200 && dis.body?.user?.disabled === true, `${dis.status}`);
  const del = await call('DELETE', `/api/users/${encodeURIComponent(pid)}`, { cookie: sidA });
  check('删影子账号 → 200', del.status === 200 && del.body?.ok === true, String(del.status));
  const opMk = await call('POST', '/api/users', { headers: { 'X-Bandi-Token': TOKEN }, body: { name: '令牌建' } });
  check('operator 令牌建号 → 201（机器身份照旧能干活）', opMk.status === 201, `${opMk.status} ${opMk.raw?.slice(0, 80)}`);

  /* ============ ④ 读审计：谁干的、干了什么，两种身份分开记 ============ */
  console.log('\n④ 读审计（以登录用户身份）：署名按身份分清楚');
  const audBefore = await call('GET', '/api/security/audit', { cookie: sidA });
  check('登录用户读审计 → 200 且 events 是数组', audBefore.status === 200 && Array.isArray(audBefore.body?.events), String(audBefore.status));
  const evBefore = audBefore.body?.events ?? [];
  check('审计非空', evBefore.length > 0, `len=${evBefore.length}`);
  const mine = (kind) => evBefore.filter((e) => e.kind === kind && e.actorId === actorId);
  check("会话的建/禁/删 都记成 kind='user.change' 且 actorId=本人（≥3 条）",
    mine('user.change').length >= 3, `user.change=${mine('user.change').length}`);
  check("user.change 含 POST/PATCH/DELETE 三条动作",
    ['POST /api/users', `PATCH /api/users/${pid}`, `DELETE /api/users/${pid}`].every((a) =>
      mine('user.change').some((e) => e.action === a && e.result === 'ok')),
    JSON.stringify(mine('user.change').map((e) => e.action)));
  const opRow = evBefore.find((e) => e.kind === 'user.change' && e.action === 'POST /api/users' && e.actorKind === 'operator');
  check('operator 令牌的写 actorKind=operator、actorId=null（机器不冒充任何账号）',
    !!opRow && opRow.actorId === null && opRow.result === 'ok', JSON.stringify(opRow ?? null).slice(0, 160));
  check('登录用户的行都署名本人（没有别人的 actorId 混进来）',
    evBefore.filter((e) => e.actorKind === 'user').every((e) => e.actorId === actorId),
    JSON.stringify([...new Set(evBefore.filter((e) => e.actorKind === 'user').map((e) => e.actorId))]));
  // 按 kind 精确圈定（server.mjs auditKindOf 的真值）：避免把 authz.deny 等也算进来
  const byKind = await call('GET', '/api/security/audit?kind=user.change', { cookie: sidA });
  check("kind 筛选有效：?kind=user.change 只回 user.change",
    (byKind.body?.events ?? []).length > 0 && (byKind.body?.events ?? []).every((e) => e.kind === 'user.change'),
    JSON.stringify((byKind.body?.events ?? []).slice(0, 2)));
  const denyRows = await call('GET', '/api/security/audit?kind=authz.deny', { cookie: sidA });
  check("① 里那笔匿名 401 进了审计（kind=authz.deny，reason 带 HTTP 401）",
    (denyRows.body?.events ?? []).length >= 1
    && denyRows.body.events.every((e) => e.kind === 'authz.deny')
    && denyRows.body.events.some((e) => /HTTP 401/.test(e.reason ?? '')),
    JSON.stringify(denyRows.body?.events?.slice(0, 2) ?? []).slice(0, 160));

  /*
   * 降噪两条（2026-11-09）：
   *   · 静态资源被 401 挡下**不算安全事件**（/style.css、/js/*.mjs、/favicon… 以前每条都记，
   *     本机归档里 94% 就是这么来的）——闸照旧挡，只是不落审计；
   *   · 同一个 (IP, 动作, 原因) 的拒绝在 60 秒窗口内只落一行 —— ① 那笔已经落过了，
   *     这里再打两次同一个口，应该**看不到新行**。
   */
  const staticDenied = await call('GET', '/style.css');
  check('匿名取静态资源 → 仍被闸挡下（401）', staticDenied.status === 401, String(staticDenied.status));
  const dup1 = await call('GET', '/api/users');
  const dup2 = await call('GET', '/api/users');
  check('匿名重复打同一个 API 口 → 仍 401', dup1.status === 401 && dup2.status === 401, `${dup1.status}/${dup2.status}`);
  /* 版本指纹（2026-11-09 从 session 改 public）：旧页面会话失效后还在每 60 秒轮询它，
     以前每次都吃 401、往审计里刷一条「拒绝访问」（用户截图问"这是什么"）；现在匿名也 200。 */
  const wv = await call('GET', '/api/web-version');
  const denyRows2 = await call('GET', '/api/security/audit?kind=authz.deny', { cookie: sidA });
  const evDeny = denyRows2.body?.events ?? [];
  check('匿名 GET /api/web-version → 200（版本探针免鉴权）',
    wv.status === 200 && typeof wv.body?.v === 'string', `${wv.status} ${JSON.stringify(wv.body ?? {}).slice(0, 80)}`);
  check('版本探针不进审计', !evDeny.some((e) => e.action === 'GET /api/web-version'),
    JSON.stringify(evDeny.map((e) => e.action).slice(0, 6)));
  check('同类拒绝在窗口内只落一行（① 1 次 + 这里 2 次 = 1 行）',
    evDeny.filter((e) => e.action === 'GET /api/users' && /HTTP 401/.test(e.reason ?? '')).length === 1,
    `rows=${evDeny.filter((e) => e.action === 'GET /api/users').length}`);
  check('静态资源 401 不进审计', !evDeny.some((e) => /\.(css|js|ico|webmanifest)$/.test(e.action ?? '')),
    JSON.stringify(evDeny.map((e) => e.action).slice(0, 6)));

  /* ============ ⑤ 退出登录：会话真删；痕迹仍是本人的 ============ */
  console.log('\n⑤ 退出登录：会话真删（服务器形态下死票吃 401）');
  const lo = await call('POST', '/api/logout', { cookie: sidA });
  check('POST /api/logout → 200 且清掉会话票', lo.status === 200 && /bandi_sid=;/.test(lo.setCookie ?? '') && /Max-Age=0/i.test(lo.setCookie ?? ''),
    String(lo.setCookie ?? '').slice(0, 90));
  const meDead = await call('GET', '/api/me', { cookie: sidA });
  check('退出后旧会话票失效 → 401', meDead.status === 401, `${meDead.status} ${meDead.body?.code ?? ''}`);

  // 再登录一次（同一个本机用户，换一张票），用这张活票去读审计，验证 logout 的 session.revoke 痕迹
  const again = await hubLogin(BASE, { username: '甲', password: '甲-pass-123', origin: BASE });
  const sidB = `bandi_sid=${again.sid}`;
  const audAfter = await call('GET', '/api/security/audit', { cookie: sidB });
  const evAfter = audAfter.body?.events ?? [];
  // `POST /api/logout` 在 auth.mjs 里是**免令牌**的（凭据就是那张会话票本身），
  // guard 放行时不设 req.bandiAuth，所以这条审计的 actorId 是 null —— 行为如此，不是 bug。
  const revoke = evAfter.filter((e) => e.kind === 'session.revoke' && e.actorId === null);
  check("退出登录记成 kind='session.revoke'（actorId=null，logout 本身免令牌）", revoke.length >= 1,
    `session.revoke(null actorId)=${revoke.length} / total=${evAfter.length}`);

  /* ============ ⑥ 导出与清空：同一套筛选、全量；清空=彻底删除（主表+归档，不留痕迹） ============ */
  console.log('\n⑥ 导出（不吃 200 上限）与清空（彻底删除主表+归档，不留痕）');
  const exp = await call('GET', '/api/security/audit/export?kind=user.change', { cookie: sidB });
  check('导出 → 200 且全量（≥ 列表里看到的 user.change 数）',
    exp.status === 200 && (exp.body?.events ?? []).length >= (byKind.body?.events ?? []).length
    && exp.body.events.every((e) => e.kind === 'user.change'),
    `export=${exp.body?.events?.length}`);
  const clear = await call('POST', '/api/security/audit/clear', { cookie: sidB });
  check('清空 → 200 且回执带删除数', clear.status === 200 && (clear.body?.cleared ?? 0) >= 1, `${clear.status} ${clear.raw?.slice(0, 120)}`);
  const afterClear = await call('GET', '/api/security/audit', { cookie: sidB });
  check('清空后主表为空（不再留 audit.clear 痕迹）',
    afterClear.status === 200 && (afterClear.body?.events ?? []).length === 0,
    `${(afterClear.body?.events ?? []).length} 条`);
  {
    // 归档表也必须空 —— 读只读连接看库（服务还活着，WAL 允许读）
    const { DatabaseSync } = await import('node:sqlite');
    const dbr = new DatabaseSync(DB, { readOnly: true });
    const arc = dbr.prepare('SELECT COUNT(*) AS n FROM security_events_archive').get().n;
    dbr.close();
    check('清空后归档表也为空（不留备份）', arc === 0, `${arc} 条`);
  }
  // 清空之后审计照常工作：一次成功的写操作应该重新落一条 ok（⑦ 的触发器用例要用）
  const writeAfter = await call('POST', '/api/security/sessions/revoke-others', { cookie: sidB });
  check('清空后写操作照常落审计', writeAfter.status === 200, `${writeAfter.status}`);

  /* ---- 阶段 2：停服务，直接开库测触发器与归档 ---- */
  console.log('\n⑦ append-only 触发器（v2.4 口径，直接开库验证）');
  child.kill();
  await sleep(800);
  child = null;

  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(DB);
  const row = raw.prepare("SELECT id FROM security_events WHERE result='ok' LIMIT 1").get();
  check('库里确有 ok 行', !!row, String(row?.id));
  const expectAbort = (name, fn) => {
    try { fn(); check(name, false, '竟然没 ABORT'); } catch (e) { check(name, /append-only/.test(String(e?.message)), String(e?.message).slice(0, 80)); }
  };
  expectAbort('UPDATE 一条 ok 行 → ABORT', () => raw.prepare("UPDATE security_events SET reason='x' WHERE id=?").run(row.id));
  expectAbort('DELETE 任何行 → ABORT', () => raw.prepare('DELETE FROM security_events WHERE id=?').run(row.id));
  raw.prepare(
    "INSERT INTO security_events (id, at, kind, result) VALUES (?, ?, 'test.kind', 'pending')",
  ).run('se-pending-x', new Date().toISOString());
  expectAbort('pending 行改 kind（身份/时间/动作不许动）→ ABORT', () => raw.prepare("UPDATE security_events SET kind='evil' WHERE id='se-pending-x'").run());
  const up = raw.prepare("UPDATE security_events SET result='ok', reason='回填', httpStatus=200, endedAt=? WHERE id='se-pending-x'").run(new Date().toISOString());
  check('pending → ok（只改四列）放行', up.changes === 1, String(up.changes));
  expectAbort('ok → fail（第二次迁移）→ ABORT', () => raw.prepare("UPDATE security_events SET result='fail' WHERE id='se-pending-x'").run());
  const again2 = raw.prepare("UPDATE security_events SET result='fail', reason='x', httpStatus=1, endedAt=? WHERE id='se-pending-x' AND result='pending'").run(new Date().toISOString());
  check('回填语句带 AND result=pending：第二次 changes=0（幂等）', again2.changes === 0, String(again2.changes));

  console.log('\n⑧ 归档：90 天前的行搬走，主表留痕，触发器装回（手跑 archive 的三条语句）');
  raw.prepare("INSERT INTO security_events (id, at, kind, result) VALUES (?, ?, 'old.event', 'ok')").run('se-old-1', new Date(Date.now() - 91 * 86400_000).toISOString());
  const cutoff = new Date(Date.now() - 90 * 86400_000).toISOString();
  // 与 store/audit.mjs 的 archive() 相同的三步：摘删除触发器 → 搬 + 删 → 装回
  raw.exec('DROP TRIGGER IF EXISTS trg_events_no_delete;');
  raw.prepare('INSERT INTO security_events_archive SELECT * FROM security_events WHERE at < ?').run(cutoff);
  raw.prepare('DELETE FROM security_events WHERE at < ?').run(cutoff);
  raw.exec(`CREATE TRIGGER trg_events_no_delete BEFORE DELETE ON security_events
    BEGIN SELECT RAISE(ABORT, 'security_events is append-only'); END;`);
  const left = raw.prepare("SELECT COUNT(*) AS n FROM security_events WHERE id='se-old-1'").get().n;
  const inArc = raw.prepare("SELECT COUNT(*) AS n FROM security_events_archive WHERE id='se-old-1'").get().n;
  check('旧行进了 archive 表、主表没了', inArc === 1 && left === 0, `主表 ${left} · archive ${inArc}`);
  expectAbort('归档后删除触发器已装回 → DELETE 仍 ABORT', () => raw.prepare("DELETE FROM security_events WHERE id='se-pending-x'").run());
  raw.close();
  console.log(failed ? `\n✗ 有 ${failed} 项没过` : '\n✓ 全部通过');
} catch (err) {
  failed += 1;
  console.error('\n✗ 冒烟跑挂了：', err?.message ?? err);
  if (log) console.error('服务端日志尾部：\n' + log.slice(-1200));
} finally {
  try { child?.kill(); } catch { /* 已退 */ }
  await sleep(300);
  try { stopRunning(PORT); } catch { /* 没在跑 */ }
  try { await HUB.close(); } catch { /* 已退 */ }
  await sleep(200);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
}

process.exit(failed ? 1 : 0);
