/*
 * smoke-csrf.mjs —— CSRF 双提交（IAM §10.2，2026-10-31 Phase 1 收尾）。
 *
 * 场景：`BANDI_HOST=0.0.0.0`（服务器形态，鉴权开）。三道闸并存的口径：
 *   ① Origin / ② X-Bandi（guardWrite，已有）③ 双提交（本刀，E4099）。
 * 双提交只对"凭据来自 Cookie"的写请求生效 —— CLI / 脚本走 X-Bandi-Token 头，
 * 浏览器不会自动带，天然豁免；登录请求此刻没有任何 Cookie 凭据，同样豁免。
 *
 * 明文部署（本 smoke 即明文）：`bandi_csrf` **不带 Secure / __Host-** ——
 * 带上等于浏览器不存 Cookie，登录死循环（§10.2 表格第二行，别"顺手加固"）。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep, stopRunning } from './lifecycle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const SERVER = path.join(__dirname, 'server.mjs');
const PORT = 18793;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'csrf-smoke-token';

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failed += 1;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-csrf-'));
let child = null;
let log = '';
function start() {
  log = '';
  child = spawn(process.execPath, [SERVER], {
    cwd: repoRoot,
    env: { ...process.env, BANDI_PORT: String(PORT), BANDI_DATA: tmp, BANDI_DB: path.join(tmp, 'bandi.db'), BANDI_HOST: '0.0.0.0', BANDI_TOKEN: TOKEN },
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
      const r = await fetch(`${BASE}/api/hello`, { signal: AbortSignal.timeout(800) });
      if (r.status === 200) return true;
    } catch { /* 还没起 */ }
    await sleep(200);
  }
  return false;
}

const ADMIN = { name: '老王', password: 'wang-pass-123' };

/** 统一请求：cookie 串由调用方拼（模拟浏览器的 cookie jar） */
const call = async (method, p, { body, cookie, headers: extra = {} } = {}) => {
  const headers = { 'Content-Type': 'application/json', 'X-Bandi': '1', ...extra };
  if (cookie) headers.Cookie = cookie;
  const r = await fetch(BASE + p, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
  const raw = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* HTML */ }
  return { status: r.status, body: parsed, raw, setCookie: r.headers.get('set-cookie') ?? '' };
};

/** 从 Set-Cookie 抽 name=value 段 */
const segOf = (sc, name) => {
  const m = new RegExp(`${name}=([^;]*)`).exec(sc ?? '');
  return m ? `${name}=${m[1]}` : '';
};

try {
  start();
  if (!(await waitUp())) throw new Error('实例没起来：' + log.slice(-500));

  /* 建第一个账号（引导码），拿到登录态 */
  const setupCode = fs.readFileSync(path.join(tmp, 'setup_code'), 'utf8').trim();
  const first = await call('POST', '/api/users', { headers: { 'X-Bandi-Token': TOKEN, 'X-Bandi-Setup': setupCode }, body: ADMIN });
  check('引导码建号 → 201', first.status === 201, `${first.status} ${first.raw?.slice(0, 120)}`);
  /*
   * 建第一个账号会**顺手发一张会话票**（首次开机设置）—— 这张票也必须配 CSRF 值。
   * 2026-11-01 实报：只发 sid 没发 csrf，建完账号第一次写操作（「退出登录」）直接吃 E4099，
   * 用户看到的是"点了没反应"。
   */
  check('建号响应：会话票与 CSRF 值一起发', /bandi_sid=/.test(first.setCookie) && /bandi_csrf=/.test(first.setCookie), first.setCookie.slice(0, 120));

  console.log('\n① 登录响应：会话票与 CSRF 值一起发');
  const lg = await call('POST', '/api/login', { body: ADMIN });
  const sid = segOf(lg.setCookie, 'bandi_sid');
  const csrf = segOf(lg.setCookie, 'bandi_csrf');
  check('登录 200 且两张 Cookie 都在', lg.status === 200 && !!sid && !!csrf, `${lg.status} ${lg.setCookie}`);
  check('明文部署：csrf Cookie **不带** Secure / __Host-（带上浏览器不存，登录死循环）',
    /bandi_csrf=/.test(lg.setCookie) && !/Secure/i.test(lg.setCookie) && !/__Host-/.test(lg.setCookie), lg.setCookie.slice(0, 120));
  const csrfValue = csrf.split('=')[1];

  console.log('\n② 双提交闸：带 Cookie 的写请求三态');
  const noHdr = await call('POST', '/api/roles', { cookie: sid, body: { name: '闸闸', menuKeys: [] } });
  check('带 sid、不带 X-Bandi-CSRF → 403 E4099', noHdr.status === 403 && noHdr.body?.code === 'E4099', `${noHdr.status} ${noHdr.body?.code}`);
  const badHdr = await call('POST', '/api/roles', { cookie: `${sid}; bandi_csrf=wrong-value-000`, headers: { 'X-Bandi-CSRF': 'also-wrong' }, body: { name: '闸闸', menuKeys: [] } });
  check('头与 cookie 对不上 → 403 E4099', badHdr.status === 403 && badHdr.body?.code === 'E4099', `${badHdr.status} ${badHdr.body?.code}`);
  const okHdr = await call('POST', '/api/roles', { cookie: `${sid}; bandi_csrf=${csrfValue}`, headers: { 'X-Bandi-CSRF': csrfValue }, body: { name: '闸闸', menuKeys: [] } });
  check('头与 cookie 一致 → 放行（201）', okHdr.status === 201, `${okHdr.status} ${okHdr.raw?.slice(0, 120)}`);

  console.log('\n③ 豁免面');
  const getNoCsrf = await call('GET', '/api/users', { cookie: sid });
  check('GET 不校验（读请求无 CSRF 面）', getNoCsrf.status === 200, String(getNoCsrf.status));
  const tokWrite = await call('POST', '/api/roles', { headers: { 'X-Bandi-Token': TOKEN }, body: { name: '令牌路', menuKeys: [] } });
  check('X-Bandi-Token 头的写请求不校验（浏览器不会自动带它）', tokWrite.status === 201, `${tokWrite.status} ${tokWrite.body?.code ?? ''}`);
  const loginAgain = await call('POST', '/api/login', { body: { name: '根本没这人', password: 'x-pass-123' } });
  check('登录请求豁免（此刻没有任何 Cookie 凭据）', loginAgain.status === 401, `${loginAgain.status} ${loginAgain.body?.code}`);

  console.log('\n④ 登录页种 CSRF 值');
  const page = await fetch(BASE + '/', { headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(5000) });
  const pageSc = page.headers.get('set-cookie') ?? '';
  check('登录页响应种 bandi_csrf（登录前就得有）', page.status === 200 && /bandi_csrf=/.test(pageSc), `${page.status} ${pageSc.slice(0, 80)}`);

  /*
   * ④b 面板页也自愈补种（2026-11-01）：老浏览器可能只有 sid 没有 csrf，
   * 打开一次页面就该补上 —— 否则所有写请求永远 E4099（"点了没反应"那一类）。
   */
  const panel = await fetch(BASE + '/', {
    headers: { Accept: 'text/html', Cookie: sid },
    signal: AbortSignal.timeout(5000),
  });
  const panelSc = panel.headers.get('set-cookie') ?? '';
  check('面板页（无 csrf）打开即补种 bandi_csrf', panel.status === 200 && /bandi_csrf=/.test(panelSc), `${panel.status} ${panelSc.slice(0, 80)}`);

  console.log('\n⑤ E4099 进审计（deny 由策略层记，handler 不参与）');
  const audit = await call('GET', '/api/security/audit', { cookie: `${sid}; bandi_csrf=${csrfValue}` });
  check('admin 能查审计', audit.status === 200 && Array.isArray(audit.body?.events), `${audit.status} ${audit.body?.code ?? ''}`);
  const csrfDeny = audit.body?.events?.find((e) => /E4099/.test(e.reason ?? ''));
  check('E4099 的拒绝进审计且 reason 带码（同请求只留一条历史）', !!csrfDeny, JSON.stringify(audit.body?.events?.slice(0, 3) ?? []).slice(0, 240));

  /*
   * ⑥ 退出登录（2026-11-01 实报：点了没反应）
   * 走完整的浏览器口径：sid + csrf cookie + X-Bandi-CSRF 头 → 200，
   * 响应清掉两张票，旧会话票立刻失效（/api/me 401）。
   */
  console.log('\n⑥ 退出登录：清两张票 + 会话立刻失效');
  const lg2 = await call('POST', '/api/login', { body: ADMIN });
  const sid2 = segOf(lg2.setCookie, 'bandi_sid');
  const csrf2 = segOf(lg2.setCookie, 'bandi_csrf').split('=')[1];
  const lo = await call('POST', '/api/logout', {
    cookie: `${sid2}; bandi_csrf=${csrf2}`,
    headers: { 'X-Bandi-CSRF': csrf2 },
  });
  check('退出 → 200', lo.status === 200, `${lo.status} ${lo.body?.code ?? ''}`);
  check('退出响应清掉会话票与令牌票（两张都带 Max-Age=0 / 空值）',
    /bandi_sid=/.test(lo.setCookie) && /bandi_token=/.test(lo.setCookie) && (lo.setCookie.match(/Max-Age=0/gi) ?? []).length >= 2,
    lo.setCookie.slice(0, 160));
  const afterLo = await call('GET', '/api/me', { cookie: sid2 });
  check('退出后旧会话票不可用 → 401', afterLo.status === 401, `${afterLo.status} ${afterLo.body?.code ?? ''}`);
} catch (err) {
  failed += 1;
  console.error('\n✗ 冒烟跑挂了：', err?.message ?? err);
  if (log) console.error('服务端日志尾部：\n' + log.slice(-1200));
} finally {
  try { child?.kill(); } catch { /* 已退 */ }
  await sleep(400);
  try { stopRunning(PORT); } catch { /* 没在跑 */ }
  await sleep(200);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
}

console.log(failed ? `\n✗ 有 ${failed} 项没过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
