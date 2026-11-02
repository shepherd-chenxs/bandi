/*
 * smoke-audit.mjs —— 安全审计（IAM §11.2，2026-10-31 Phase 1 收尾）。
 *
 * 两个阶段：
 *   阶段 1（服务跑着）：策略层 deny 自动记（handler 不参与）、写操作 pending → finish
 *   回填 ok/fail、审计查询权限（admin only）、kind 筛选、会话列表 / 踢其它；
 *   阶段 2（服务停了，直接开库）：append-only 触发器的六条边界（v2.4 口径）+ 归档。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * ⚠️ 本文件**不 import lifecycle.mjs / config.mjs**：阶段 2 要在父进程里用
 * `BANDI_DB` 指向测试库开连接，而 config.mjs 在模块加载时就固化 dbPath ——
 * 顶部 import 一旦把它拖进来，阶段 2 的任何 store 操作都会打到**真实数据目录**。
 * （第一版就是这么写的，archive(90) 静默搬了 0 条 —— 好在查询先于删除，无实际伤害。）
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const SERVER = path.join(__dirname, 'server.mjs');
const PORT = 18794;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'audit-smoke-token';

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failed += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-audit-'));
const DB = path.join(tmp, 'bandi.db');
let child = null;
let log = '';
const start = () => {
  log = '';
  child = spawn(process.execPath, [SERVER], {
    cwd: repoRoot,
    env: { ...process.env, BANDI_PORT: String(PORT), BANDI_DATA: tmp, BANDI_DB: DB, BANDI_HOST: '0.0.0.0', BANDI_TOKEN: TOKEN },
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

const ADMIN = { name: '老王', password: 'wang-pass-123' };
const segOf = (sc, name) => {
  const m = new RegExp(`${name}=([^;]*)`).exec(sc ?? '');
  return m ? `${name}=${m[1]}` : '';
};

/*
 * CSRF 双提交（同 smoke-users 的做法）：模拟同一个浏览器 —— 响应种下 bandi_csrf 就进
 * jar，后续带 cookie 的请求自动合并 + 带同名 header。
 */
let CSRF = '';

const call = async (method, p, { body, cookie, headers: extra = {} } = {}) => {
  const headers = { 'Content-Type': 'application/json', 'X-Bandi': '1', ...extra };
  if (cookie) headers.Cookie = CSRF ? `${cookie}; bandi_csrf=${CSRF}` : cookie;
  else if (CSRF && method !== 'GET') headers.Cookie = `bandi_csrf=${CSRF}`;
  if (method !== 'GET' && CSRF) headers['X-Bandi-CSRF'] = CSRF;
  const r = await fetch(BASE + p, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
  const raw = await r.text();
  const mCsrf = /bandi_csrf=([^;]*)/.exec(r.headers.get('set-cookie') ?? '');
  if (mCsrf) CSRF = decodeURIComponent(mCsrf[1]);
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* HTML */ }
  return { status: r.status, body: parsed, raw, setCookie: r.headers.get('set-cookie') ?? '' };
};

try {
  start();
  if (!(await waitUp())) throw new Error('实例没起来：' + log.slice(-500));

  console.log('\n① 策略层 deny 自动记（handler 不参与）');
  const denied0 = await call('GET', '/api/users'); // 无凭据 → 401，guard 当场记
  check('无凭据 → 401', denied0.status === 401, String(denied0.status));

  /* 建号登录 */
  const setupCode = fs.readFileSync(path.join(tmp, 'setup_code'), 'utf8').trim();
  await call('POST', '/api/users', { headers: { 'X-Bandi-Token': TOKEN, 'X-Bandi-Setup': setupCode }, body: ADMIN });
  const lg = await call('POST', '/api/login', { body: ADMIN });
  const sid = segOf(lg.setCookie, 'bandi_sid');
  const csrf = segOf(lg.setCookie, 'bandi_csrf');
  const jar = `${sid}; ${csrf}`;

  const audit0 = await call('GET', '/api/security/audit', { cookie: jar });
  check('admin 查审计 → 200', audit0.status === 200 && Array.isArray(audit0.body?.events), `${audit0.status} ${audit0.body?.code}`);
  const denyRow = audit0.body?.events?.find((e) => e.kind === 'authz.deny' && /HTTP 401/.test(e.reason ?? ''));
  check('401 拒绝在审计里（kind=authz.deny，reason=HTTP 401）', !!denyRow, JSON.stringify(audit0.body?.events?.slice(0, 2) ?? []).slice(0, 200));

  console.log('\n② 写操作：pending → finish 回填（handler 漏不掉）');
  const mk = await call('POST', '/api/users', { cookie: jar, body: { name: '小李', password: 'li-pass-1234', roleId: 'operator' } });
  check('建号 → 201', mk.status === 201, `${mk.status} ${mk.raw?.slice(0, 100)}`);
  const evOk = audit0.status === 200 && (await call('GET', '/api/security/audit?kind=user.change', { cookie: jar })).body?.events?.find((e) => e.action === 'POST /api/users' && e.result === 'ok' && e.actorKind === 'user');
  check('成功建号回填 ok（含 httpStatus=201 / endedAt）', !!evOk && evOk.httpStatus === 201 && !!evOk.endedAt, JSON.stringify(evOk ?? null).slice(0, 200));
  const bad = await call('POST', '/api/users', { cookie: jar, body: { password: 'x-pass-123', roleId: 'operator' } });
  check('坏 body → 400', bad.status === 400, String(bad.status));
  const evFail = (await call('GET', '/api/security/audit?kind=user.change', { cookie: jar })).body?.events?.find((e) => e.action === 'POST /api/users' && e.result === 'fail' && e.actorKind === 'user');
  check('失败建号回填 fail（reason 带状态）', !!evFail && evFail.httpStatus === 400, JSON.stringify(evFail ?? null).slice(0, 200));

  console.log('\n③ 查询权限与筛选');
  const vlg = await call('POST', '/api/login', { body: { name: '小李', password: 'li-pass-1234' } });
  const vjar = `${segOf(vlg.setCookie, 'bandi_sid')}; ${segOf(vlg.setCookie, 'bandi_csrf')}`;
  const vAudit = await call('GET', '/api/security/audit', { cookie: vjar });
  // 两层拦，谁先都行：guard 的 decide()（E4033 越权）先挡；绕过它（比如未来路由表放行）
  // 还有 handler 的 mayManage（E3811）。断言只认"403 + 码是两者之一"。
  check('非 admin → 403（decide 的 E4033 或 handler 的 E3811，两层都该拦）',
    vAudit.status === 403 && ['E4033', 'E3811'].includes(vAudit.body?.code), `${vAudit.status} ${vAudit.body?.code}`);
  const onlyLogin = await call('GET', '/api/security/audit?kind=login', { cookie: jar });
  check('kind=login 只回登录事件', onlyLogin.status === 200
    && (onlyLogin.body?.events ?? []).every((e) => e.kind === 'login')
    && (onlyLogin.body?.events?.length ?? 0) > 0, JSON.stringify(onlyLogin.body?.events?.slice(0, 2) ?? []).slice(0, 160));

  console.log('\n④ 会话列表与踢其它（IAM §9：设置 → 安全）');
  const sess = await call('GET', '/api/security/sessions', { cookie: jar });
  check('会话列表 → 200 且含当前会话（无 tokenHash 全量）', sess.status === 200
    && (sess.body?.sessions?.length ?? 0) >= 1
    && (sess.body?.sessions ?? []).every((s) => typeof s.id === 'string' && s.id.length === 8), JSON.stringify(sess.body ?? {}).slice(0, 200));
  // 再登录一个"别的设备"，然后踢其它
  await call('POST', '/api/login', { body: ADMIN });
  const kick = await call('POST', '/api/security/sessions/revoke-others', { cookie: jar });
  check('踢其它 → 200 且踢掉 ≥1 条', kick.status === 200 && (kick.body?.kicked ?? 0) >= 1, `${kick.status} ${kick.raw?.slice(0, 100)}`);
  const sessAfter = await call('GET', '/api/security/sessions', { cookie: jar });
  check('踢完后只剩当前这张票', sessAfter.status === 200 && (sessAfter.body?.sessions?.length ?? 0) === 1, JSON.stringify(sessAfter.body ?? {}).slice(0, 120));

  /* ---- 阶段 2：停服务，直接开库测触发器与归档 ---- */
  console.log('\n⑤ append-only 触发器（v2.4 口径，直接开库验证）');
  await child.kill();
  await sleep(800);
  child = null;

  process.env.BANDI_DATA = tmp;
  process.env.BANDI_DB = DB;
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(DB);
  const row = raw.prepare("SELECT id FROM security_events WHERE result='ok' LIMIT 1").get();
  check('库里确有 ok 行', !!row, String(row?.id));
  const expectAbort = (name, fn) => {
    try { fn(); check(name, false, '竟然没 ABORT'); } catch (e) { check(name, /append-only/.test(String(e?.message)), String(e?.message).slice(0, 80)); }
  };
  expectAbort('UPDATE 一条 ok 行 → ABORT', () => raw.prepare("UPDATE security_events SET reason='x' WHERE id=?").run(row.id));
  expectAbort('DELETE 任何行 → ABORT', () => raw.prepare('DELETE FROM security_events WHERE id=?').run(row.id));
  const p = raw.prepare(
    "INSERT INTO security_events (id, at, kind, result) VALUES (?, ?, 'test.kind', 'pending')",
  ).run('se-pending-x', new Date().toISOString());
  expectAbort('pending 行改 kind（身份/时间/动作不许动）→ ABORT', () => raw.prepare("UPDATE security_events SET kind='evil' WHERE id='se-pending-x'").run());
  const up = raw.prepare("UPDATE security_events SET result='ok', reason='回填', httpStatus=200, endedAt=? WHERE id='se-pending-x'").run(new Date().toISOString());
  check('pending → ok（只改四列）放行', up.changes === 1, String(up.changes));
  expectAbort('ok → fail（第二次迁移）→ ABORT', () => raw.prepare("UPDATE security_events SET result='fail' WHERE id='se-pending-x'").run());
  const again = raw.prepare("UPDATE security_events SET result='fail', reason='x', httpStatus=1, endedAt=? WHERE id='se-pending-x' AND result='pending'").run(new Date().toISOString());
  check('回填语句带 AND result=pending：第二次 changes=0（幂等）', again.changes === 0, String(again.changes));

  console.log('\n⑥ 归档：90 天前的行搬走，主表留痕，触发器装回（手跑 archive 的三条语句）');
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
} catch (err) {
  failed += 1;
  console.error('\n✗ 冒烟跑挂了：', err?.message ?? err);
  if (log) console.error('服务端日志尾部：\n' + log.slice(-1200));
} finally {
  try { child?.kill(); } catch { /* 已退 */ }
  await sleep(300);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
}

console.log(failed ? `\n✗ 有 ${failed} 项没过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
