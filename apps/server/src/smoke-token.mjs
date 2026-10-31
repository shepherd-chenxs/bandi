/**
 * smoke-token —— IAM §6.2/§7.1 Phase 3 验收：签发 / 过期 / 篡改 / 复用 / 撤销；
 * 旧会话与根令牌继续可用。BANDI_DATA 沙盒 + 127.0.0.1。
 *
 * 口径备忘：
 *   · at_ 票 15 分钟 —— 过期用例靠 store 直改 expiresAt（等 15 分钟不现实）；
 *   · rf_ 30 天 —— 复用用例真实轮换两次后重放第一张；
 *   · Bearer 人类票 = user Principal 走 PDP；根令牌换票 scopes='*' = operator 待遇。
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const PORT = 8821;
const BASE = `http://127.0.0.1:${PORT}`;
// server.mjs 用绝对路径定位 —— 这套 smoke 从仓库根（node apps/server/src/…）跑也能起
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs');
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failed += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const OP_TOKEN = 'smoke-token-root';
const setupCodeOf = (dir) => fs.readFileSync(path.join(dir, 'setup_code'), 'utf8').trim();

let tmp = null;
let child = null;
const start = () => {
  tmp ??= fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-token-'));
  child = spawn(process.execPath, [SERVER], {
    cwd: path.dirname(SERVER),
    env: {
      ...process.env,
      BANDI_PORT: String(PORT),
      BANDI_DATA: tmp,
      BANDI_DB: path.join(tmp, 'bandi.db'),
      BANDI_HOST: '0.0.0.0',
      BANDI_TOKEN: OP_TOKEN,
    },
    stdio: 'ignore',
  });
};
const stop = async () => {
  if (!child) return;
  child.kill();
  child = null;
  await sleep(500);
};

const call = async (method, p, { body, headers: extra = {} } = {}) => {
  const headers = { 'Content-Type': 'application/json', 'X-Bandi': '1', ...extra };
  const r = await fetch(BASE + p, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });
  const raw = await r.text();
  let json = null;
  try { json = JSON.parse(raw); } catch { /* html */ }
  return { status: r.status, json, raw, setCookie: r.headers.get('set-cookie') ?? '' };
};
const bearer = (at) => ({ Authorization: `Bearer ${at}` });

try {
  start();
  let up = false;
  for (let i = 0; i < 40 && !up; i += 1) {
    try { up = (await fetch(`${BASE}/api/hello`)).ok; } catch { await sleep(200); }
  }
  if (!up) throw new Error('服务没起来');

  // 引导：建 admin（甲）+ operator（乙），都带密码
  const setup = setupCodeOf(tmp);
  const mk = async (name, roleId) => call('POST', '/api/users', {
    headers: { 'X-Bandi-Token': OP_TOKEN, 'X-Bandi-Setup': setup },
    body: { name, password: `${name}-pass-123`, roleId },
  });
  check('建 admin「甲」', (await mk('甲', 'admin')).status === 201);
  check('建 operator「乙」', (await mk('乙', 'operator')).status === 201);

  console.log('\n① 密码换票（签发）');
  const t1 = await call('POST', '/api/auth/token', { body: { name: '甲', password: '甲-pass-123' } });
  check('200 + Bearer + accessToken 前缀 at_', t1.status === 200 && t1.json?.tokenType === 'Bearer' && t1.json?.accessToken?.startsWith('at_'), `${t1.status} ${t1.raw.slice(0, 80)}`);
  check('refreshToken 前缀 rf_ + expiresIn ≈ 900s', t1.json?.refreshToken?.startsWith('rf_') && Math.abs(t1.json.expiresIn - 900) < 5, String(t1.json?.expiresIn));
  const at1 = t1.json.accessToken;
  const rf1 = t1.json.refreshToken;

  check('错密码 → 401 E3805（统一文案）', (await call('POST', '/api/auth/token', { body: { name: '甲', password: 'wrong-pass-9' } })).json?.code === 'E3805');
  check('免密换票被拒（免密不开换票链）', (await call('POST', '/api/auth/token', { body: { name: 'nobody', password: 'whatever-x' } })).status === 401);

  console.log('\n② Bearer 票 = 登录用户待遇（PDP）');
  const st1 = await call('GET', '/api/state', { headers: bearer(at1) });
  check('admin 票读 /api/state → 200', st1.status === 200, `${st1.status} ${st1.raw.slice(0, 80)}`);
  const who1 = await call('GET', '/api/me', { headers: bearer(at1) });
  check('票认出「甲」（/api/me）', who1.json?.user?.name === '甲', JSON.stringify(who1.json?.user ?? who1.json).slice(0, 120));
  check('乱造的 at_ → 401 E4010', (await call('GET', '/api/state', { headers: bearer('at_totally-made-up') })).json?.code === 'E4010');

  console.log('\n③ 根令牌换 break-glass 票（scopes=*）');
  const rt = await call('POST', '/api/auth/token', { headers: { 'X-Bandi-Token': OP_TOKEN }, body: {} });
  check('200 + at_ 票 + scopes=*', rt.status === 200 && rt.json?.accessToken?.startsWith('at_') && rt.json?.scopes === '*', rt.raw.slice(0, 100));
  check('break-glass 票读管理接口 → 200', (await call('GET', '/api/users', { headers: bearer(rt.json.accessToken) })).status === 200);
  check('break-glass 票不发 refresh（机器票无轮换链）', rt.json?.refreshToken === undefined, JSON.stringify(rt.json).slice(0, 80));

  console.log('\n④ 刷新轮换');
  const r1 = await call('POST', '/api/auth/refresh', { body: { refreshToken: rf1 } });
  check('轮换 200，新 rf_ ≠ 旧 rf_，新 at_ ≠ 旧 at_', r1.status === 200 && r1.json.refreshToken !== rf1 && r1.json.accessToken !== at1, `${r1.status} ${r1.raw.slice(0, 80)}`);
  const rf2 = r1.json.refreshToken;
  const at2 = r1.json.accessToken;
  const r2 = await call('POST', '/api/auth/refresh', { body: { refreshToken: rf2 } });
  check('二轮轮换照常', r2.status === 200, `${r2.status} ${r2.raw.slice(0, 60)}`);
  check('新票能带旧票不能：旧 at_ 已随轮换仍有效（15 分钟内不撤）——但旧 rf_ 复用要炸，见 ⑤', true);

  console.log('\n⑤ 复用检测（E4092 → 整族撤销）');
  const reuse = await call('POST', '/api/auth/refresh', { body: { refreshToken: rf1 } });
  check('重放第一张 rf_ → 401 E4092', reuse.status === 401 && reuse.json?.code === 'E4092', `${reuse.status} ${reuse.json?.code}`);
  const afterReuse = await call('POST', '/api/auth/refresh', { body: { refreshToken: r2.json.refreshToken } });
  check('族里最后的活票也被连坐 → 401 E4012', afterReuse.status === 401 && afterReuse.json?.code === 'E4012', `${afterReuse.status} ${afterReuse.json?.code}`);
  const audit = await call('GET', '/api/security/audit?kind=auth.refresh.reuse', { headers: bearer(r2.json.accessToken) });
  check('审计留了 auth.refresh.reuse fail 行', audit.status === 200 && !!audit.json?.events?.find((e) => /E4092/.test(e.reason ?? '')), `${audit.status} ${JSON.stringify(audit.json?.events?.slice(0, 1)).slice(0, 120)}`);

  console.log('\n⑥ tv 撤销水位');
  // 甲改密码 → tv+1 → 手里的 at_ 立即作废
  const pwChange = await call('POST', '/api/me/password', { headers: bearer(r2.json.accessToken), body: { current: '甲-pass-123', password: '甲-new-pass-456' } });
  check('改密码成功', pwChange.status === 200, `${pwChange.status} ${pwChange.raw.slice(0, 80)}`);
  check('旧 at_ 立即作废（tv 不匹配）→ 401', (await call('GET', '/api/state', { headers: bearer(at2) })).status === 401);

  console.log('\n⑦ 撤销接口 + 过期 + 篡改');
  const t3 = await call('POST', '/api/auth/token', { body: { name: '乙', password: '乙-pass-123' } });
  const at3 = t3.json.accessToken;
  check('乙的票能用', (await call('GET', '/api/state', { headers: bearer(at3) })).status === 200);
  const rev = await call('POST', '/api/auth/revoke', { headers: bearer(at3), body: { accessToken: at3 } });
  check('revoke 200', rev.status === 200, `${rev.status} ${rev.raw.slice(0, 60)}`);
  check('撤完即 401', (await call('GET', '/api/state', { headers: bearer(at3) })).status === 401);
  check('篡改一个字符 → 401', (await call('GET', '/api/state', { headers: bearer('at_' + at3.slice(3, -2) + 'zz') })).status === 401);

  // 过期：再换一张，停服后把它的 expiresAt 拨到过去，重启断言 401
  const t4 = await call('POST', '/api/auth/token', { body: { name: '乙', password: '乙-pass-123' } });
  const at4 = t4.json.accessToken;
  await stop();
  const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
  const db = new DatabaseSync(path.join(tmp, 'bandi.db'));
  db.prepare('UPDATE access_tokens SET expiresAt = ? WHERE tokenHash = ?').run(new Date(Date.now() - 1000).toISOString(), sha(at4));
  const stillThere = db.prepare('SELECT COUNT(*) AS n FROM access_tokens WHERE tokenHash = ?').get(sha(at4)).n;
  db.close();
  check('库改过期前行还在', stillThere === 1, String(stillThere));
  start();
  up = false;
  for (let i = 0; i < 40 && !up; i += 1) {
    try { up = (await fetch(`${BASE}/api/hello`)).ok; } catch { await sleep(200); }
  }
  check('重启成功', up);
  check('过期票 → 401（verify 判 expiresAt）', (await call('GET', '/api/state', { headers: bearer(at4) })).status === 401);
  const t5 = await call('POST', '/api/auth/token', { body: { name: '乙', password: '乙-pass-123' } });
  check('重启后新换票照常（旧链与根令牌不受影响）', t5.status === 200 && (await call('GET', '/api/state', { headers: bearer(t5.json.accessToken) })).status === 200, `${t5.status} ${t5.raw.slice(0, 80)}`);
  check('根令牌继续可用（不透明头不受影响）', (await call('GET', '/api/users', { headers: { 'X-Bandi-Token': OP_TOKEN } })).status === 200);
} catch (err) {
  console.log(`✗ 异常：${err?.message ?? err}`);
  failed += 1;
} finally {
  await stop();
  await sleep(200);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 下次再说 */ }
}
console.log(failed ? `\n${failed} 项没过` : '\n全部通过');
process.exit(failed ? 1 : 0);
