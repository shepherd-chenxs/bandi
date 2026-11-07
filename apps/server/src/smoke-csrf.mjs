/*
 * smoke-csrf.mjs —— CSRF 双提交（IAM §10.2，2026-11-07 中枢一刀之后）。
 *
 * 2026-11-07 删掉了本地凭据层与角色/菜单权限体系：「登录 = 全权」，唯一的登录是
 * 中枢账号密码框（POST /hub/login，假中枢 hub-stub.mjs 撑场）。本冒烟只钉
 * 「CSRF 双提交」这道闸在新世界下的口径：
 *
 *   · 带「Cookie 凭据」(bandi_sid / bandi_token) 的写请求，必须 bandi_csrf Cookie
 *     与 X-Bandi-CSRF 头一致，否则 403 E4099；
 *   · 机器令牌 (X-Bandi-Token) 浏览器不会自动带，天然免疫，不校验；
 *   · 回环形态 (BANDI_HOST=127.0.0.1) 下无会话凭据的请求按 operator 算（= 全权），
 *     带 X-Bandi: 1 头的第一方 API 绕过照旧放行；
 *   · 登录页种下 bandi_csrf Cookie，并塞一个同值隐藏域 _csrf 给表单兜底。
 *
 * 隔离：临时数据目录 + 临时端口 + 假中枢，跑完即删，不碰 data/。
 * 跑法：SMOKE_PORT=8902 node apps/server/src/smoke-csrf.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { repoRoot } from './config.mjs';
import { sleep, stopRunning } from './lifecycle.mjs';
import { startHubStub, hubLogin } from './hub-stub.mjs';

const PORT = Number(process.env.SMOKE_PORT ?? 8902);
const SERVER = path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-csrf-'));
const HUB_DIR = path.join(tmp, 'hub');
const TOK_DIR = path.join(tmp, 'token');
fs.mkdirSync(HUB_DIR, { recursive: true });
fs.mkdirSync(TOK_DIR, { recursive: true });

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

/** 从 Set-Cookie 抽 name=value 段（只取这一段，后面是 Path/HttpOnly…） */
const segOf = (sc, name) => {
  const m = new RegExp(`${name}=([^;]*)`).exec(sc ?? '');
  return m ? m[1] : '';
};

let log = '';
let child = null;
function startServer(port, dataDir, extraEnv = {}) {
  log = '';
  child = spawn(process.execPath, [SERVER], {
    cwd: repoRoot,
    env: {
      ...process.env,
      BANDI_PORT: String(port),
      BANDI_DATA: dataDir,
      BANDI_DB: path.join(dataDir, 'bandi.db'),
      ...extraEnv,
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  return child;
}

async function waitUp(base, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${base}/api/hello`, { signal: AbortSignal.timeout(800) });
      if (r.status === 200) return true;
    } catch { /* 还没起 */ }
    await sleep(200);
  }
  return false;
}

/** 统一请求：base + 方法 + 路径；cookie / 显式 CSRF 头 / 机器令牌三选 N。 */
const call = async (base, method, p, { body, cookie, csrfHeader, token } = {}) => {
  const headers = { 'Content-Type': 'application/json', 'X-Bandi': '1' };
  if (cookie) headers.Cookie = cookie;
  if (csrfHeader !== undefined) headers['X-Bandi-CSRF'] = csrfHeader;
  if (token) headers['X-Bandi-Token'] = token;
  const r = await fetch(base + p, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });
  const raw = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* HTML / 空 */ }
  return { status: r.status, body: parsed, raw, setCookie: r.headers.get('set-cookie') ?? '' };
};

try {
  /* 假中枢：一个中枢账号。本机把登录表单转给它来造会话。 */
  const stub = await startHubStub({ deviceId: 'dev_self', accounts: { 甲: { password: '甲-pass-123' } } });

  /* ============ ① 回环 + 中枢：登录页、operator 绕过、会话 CSRF ============ */
  const BASE = `http://127.0.0.1:${PORT}`;
  fs.writeFileSync(
    path.join(HUB_DIR, 'hub.json'),
    JSON.stringify({ baseUrl: stub.url, publicKey: stub.publicKey, deviceId: 'dev_self', deviceToken: 'dt_stub' }, null, 2),
    { mode: 0o600 },
  );
  startServer(PORT, HUB_DIR, { BANDI_HOST: '127.0.0.1', BANDI_HUB: stub.url });
  if (!(await waitUp(BASE))) throw new Error('回环实例没起来：' + log.slice(-500));

  /* ④ 登录页种 CSRF 双提交对（mirror smoke-hub.mjs [4b]） */
  console.log('\n④ 登录页：种 bandi_csrf Cookie + 隐藏 _csrf 字段');
  const page = await fetch(`${BASE}/`, { headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(5000) });
  const pageSc = page.headers.get('set-cookie') ?? '';
  const pageHtml = await page.text();
  const csrfRaw = decodeURIComponent(segOf(pageSc, 'bandi_csrf'));
  const csrfField = /name="_csrf" value="([^"]+)"/.exec(pageHtml)?.[1] ?? '';
  check('登录页 200 且种下 bandi_csrf Cookie',
    page.status === 200 && !!csrfRaw, `${page.status} ${pageSc.slice(0, 80)}`);
  check('明文部署：csrf Cookie 不带 Secure / __Host-（带上浏览器不存，登录死循环）',
    !!csrfRaw && !/Secure/i.test(pageSc) && !/__Host-/.test(pageSc), pageSc.slice(0, 120));
  check('表单带同值隐藏域 _csrf（Cookie = 隐藏域）',
    !!csrfRaw && csrfRaw === csrfField, `cookie=${csrfRaw} field=${csrfField}`);

  /* ③ operator 绕过：回环形态下无会话凭据的请求 = operator（= 全权），第一方 API 头照旧放行 */
  console.log('\n③ operator 绕过：回环第一方 API');
  const op = await call(BASE, 'POST', '/api/users', { body: { name: '操作员甲' } });
  check('回环无凭据 + X-Bandi:1 → operator 放行（201）', op.status === 201, `${op.status} ${op.raw?.slice(0, 120)}`);

  /* ② 中枢登录拿 bandi_sid（唯一登录路：POST /hub/login） */
  console.log('\n② 中枢登录：POST /hub/login → 发 bandi_sid');
  const lg = await hubLogin(BASE, { username: '甲', password: '甲-pass-123', origin: BASE });
  check('对的账号密码 → 302 进面板且发 bandi_sid', lg.status === 302 && lg.location === '/' && !!lg.sid, `HTTP ${lg.status}`);
  const sid = `bandi_sid=${lg.sid}`;

  /* ② 双提交闸：带 sid 的写请求三态 */
  console.log('\n② 双提交闸：带 bandi_sid 的写请求');
  const noHdr = await call(BASE, 'POST', '/api/users', { cookie: sid, body: { name: '临时甲' } });
  check('带 sid、不带 X-Bandi-CSRF → 403 E4099',
    noHdr.status === 403 && noHdr.body?.code === 'E4099', `${noHdr.status} ${noHdr.body?.code ?? ''}`);

  // 三态的中间态：带了、但对不上 —— 双提交比的是"成对"，不是"有就行"
  const badHdr = await call(BASE, 'POST', '/api/users', {
    cookie: `${sid}; bandi_csrf=wrong-value-000`,
    csrfHeader: 'also-wrong',
    body: { name: '临时丙' },
  });
  check('头与 cookie 对不上 → 403 E4099',
    badHdr.status === 403 && badHdr.body?.code === 'E4099', `${badHdr.status} ${badHdr.body?.code ?? ''}`);

  const okHdr = await call(BASE, 'POST', '/api/users', {
    cookie: `${sid}; bandi_csrf=${csrfRaw}`,
    csrfHeader: csrfRaw,
    body: { name: '临时乙' },
  });
  check('sid + cookie 与头一致 → 放行（201）', okHdr.status === 201, `${okHdr.status} ${okHdr.raw?.slice(0, 120)}`);

  // 拒绝进审计（IAM §11.2：deny 由策略层记，handler 不参与；同一请求只留一条历史）
  const audit = await call(BASE, 'GET', '/api/security/audit', { cookie: sid });
  const csrfDeny = (audit.body?.events ?? []).find((e) => /E4099/.test(e.reason ?? ''));
  check('E4099 的拒绝进审计且 reason 带码',
    audit.status === 200 && !!csrfDeny, `${audit.status} ${JSON.stringify(audit.body?.events?.slice(0, 2) ?? []).slice(0, 200)}`);

  /* 豁免面：GET 不校验；机器令牌天然免疫 */
  console.log('\n②.5 豁免面');
  const getNoCsrf = await call(BASE, 'GET', '/api/users', { cookie: sid });
  check('GET 不校验（读请求无 CSRF 面）', getNoCsrf.status === 200, String(getNoCsrf.status));

  await stub.close();
  try { child?.kill(); } catch { /* 已退 */ }
  await sleep(500);
  try { stopRunning(PORT); } catch { /* 没在跑 */ }
  await sleep(200);

  /* ============ ③ 非回环形态：机器令牌 (X-Bandi-Token) 天然豁免 CSRF ============ */
  console.log('\n③ 机器令牌：X-Bandi-Token 天然豁免 CSRF');
  const PORT2 = PORT + 1;
  const BASE2 = `http://127.0.0.1:${PORT2}`;
  // 非回环 + 不设 BANDI_TOKEN：启动即生成 <dataDir>/token
  startServer(PORT2, TOK_DIR, { BANDI_HOST: '0.0.0.0' });
  if (!(await waitUp(BASE2))) throw new Error('非回环实例没起来：' + log.slice(-500));
  const token = fs.readFileSync(path.join(TOK_DIR, 'token'), 'utf8').trim();
  check('非回环实例生成 <dataDir>/token', token.length > 20, `len=${token.length}`);
  const tokWrite = await call(BASE2, 'POST', '/api/users', { token, body: { name: '令牌甲' } });
  check('X-Bandi-Token 写请求不校验 CSRF（浏览器不会自动带它）→ 201',
    tokWrite.status === 201, `${tokWrite.status} ${tokWrite.body?.code ?? ''}`);

  console.log(failed ? `\n✗ 有 ${failed} 项没过` : '\n✓ 全部通过');
} catch (err) {
  failed += 1;
  console.error('\n✗ 冒烟跑挂了：', err?.message ?? err);
  if (log) console.error('服务端日志尾部：\n' + log.slice(-1200));
} finally {
  try { child?.kill(); } catch { /* 已退 */ }
  await sleep(400);
  for (const p of [PORT, PORT + 1]) { try { stopRunning(p); } catch { /* 没在跑 */ } }
  await sleep(200);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
}

process.exit(failed ? 1 : 0);
