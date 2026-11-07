/**
 * 身份中枢进门的验收（2026-11-06）。
 *
 * 钉住的是 bandi-hub/contract.md §五、§六 那两条：
 *   · 验票：逐字节认 header（不做 alg 协商）、内置公钥验签、aud/iss、过期、dev 是不是自己、jti 一次性；
 *   · 进门：验过 ≠ 能进 —— 还要过本地授权表（hub_links）；首次认领只对**空表**成立一次。
 *
 * 五类负样本各有对应的错误码，改坏了要看得出来是哪一条松了：
 *   E7001 签名/格式（篡改、alg=none）、E7003 过期、E7004 换了机器、E7005 重放、
 *   E7003 页面（本地没认过这个账号）。
 *
 * 隔离：临时数据目录 + 临时端口（对齐 smoke-pair.mjs 的 spawn 模式）。
 * 跑法：node apps/server/src/smoke-hub.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { repoRoot } from './config.mjs';
import { sleep } from './lifecycle.mjs';
import { verifyTicket } from './hub/verify.mjs';
import { startHubStub, hubLogin } from './hub-stub.mjs';

const PORT = Number(process.env.SMOKE_PORT ?? 8866);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-hub-'));
const SERVER = path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

/* --------------------------------------------------------------- 票据工具 */

const HEADER = Buffer.from(JSON.stringify({ alg: 'Ed25519', typ: 'JWT' }), 'utf8').toString('base64url');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PUB = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');

/** 按中枢的格式签一张票 */
function sign({ sub = 'acc_me', dev = 'dev_self', exp = 300, jti = crypto.randomBytes(9).toString('base64url'), key = privateKey, header = HEADER } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: 'bandi-hub', aud: 'bandi', sub, dev, jti, iat: now, exp: now + exp };
  const body = `${header}.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
  const sig = crypto.sign(null, Buffer.from(body, 'utf8'), key).toString('base64url');
  return `${body}.${sig}`;
}

/* ------------------------------------------------------------------ ① 验票 */

console.log('\n[1] 验票');
{
  const t = sign();
  const ok = verifyTicket(t, PUB, { deviceId: 'dev_self' });
  check('正常票通过', ok.ok === true, ok.ok ? '' : ok.reason);

  const tampered = (() => {
    const [h, b, s] = t.split('.');
    const p = JSON.parse(Buffer.from(b, 'base64url').toString('utf8'));
    p.sub = 'acc_attacker';
    return `${h}.${Buffer.from(JSON.stringify(p)).toString('base64url')}.${s}`;
  })();
  check('改了 sub 就验不过（签名对不上）', verifyTicket(tampered, PUB, { deviceId: 'dev_self' }).reason === 'bad_signature');

  const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  check('alg=none 一律拒（不解析算法）', verifyTicket(sign({ header: noneHeader }), PUB, { deviceId: 'dev_self' }).reason === 'bad_header');

  const other = crypto.generateKeyPairSync('ed25519');
  check('换一把私钥签的票拒', verifyTicket(sign({ key: other.privateKey }), PUB, { deviceId: 'dev_self' }).reason === 'bad_signature');
  check('换一把公钥验也拒', verifyTicket(sign(), other.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'), { deviceId: 'dev_self' }).reason === 'bad_signature');

  check('给 A 的票拿到 B 上用 → wrong_device', verifyTicket(sign(), PUB, { deviceId: 'dev_other' }).reason === 'wrong_device');
  check('过期票 → expired', verifyTicket(sign({ exp: -600 }), PUB, { deviceId: 'dev_self' }).reason === 'expired');

  const once = sign();
  check('第一次用通过', verifyTicket(once, PUB, { deviceId: 'dev_self' }).ok === true);
  check('同一张票第二次用 → replayed', verifyTicket(once, PUB, { deviceId: 'dev_self' }).reason === 'replayed');
}

/* ------------------------------------------------------------ ② 进门（真服务） */

const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir, { recursive: true });
// claimPending=true 模拟"中枢没回 accountId"的老版本握手：第一次进门时认领给本机第一个用户
fs.writeFileSync(
  path.join(dataDir, 'hub.json'),
  JSON.stringify({ baseUrl: 'https://hub.test', deviceId: 'dev_self', deviceToken: 'dt_test', publicKey: PUB, accountId: null, claimPending: true }, null, 2),
  { mode: 0o600 },
);

const child = spawn(process.execPath, [SERVER], {
  cwd: repoRoot,
  // 回环形态：本机脚本免令牌（任务书 §三 的硬约束），于是这一段只验"票 + 本地授权表"
  env: { ...process.env, BANDI_PORT: String(PORT), BANDI_HOST: '127.0.0.1', BANDI_DATA: dataDir, BANDI_DB: path.join(dataDir, 'bandi.db') },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));

const base = `http://127.0.0.1:${PORT}`;
const get = async (p, headers = {}) => fetch(base + p, { headers, redirect: 'manual' });

try {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await get('/api/hello');
      if (r.status === 200) break;
    } catch { /* 还没起 */ }
    await sleep(200);
  }

  console.log('\n[2] 进门');
  // 先建一个本机账号 —— 会话必须落到一个本地用户上（零账号时 hub 进不来）
  const mk = await fetch(base + '/api/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bandi': '1' },
    body: JSON.stringify({ name: '老板' }),
  });
  check('本机建好第一个账号', mk.status === 201 || mk.status === 200, `HTTP ${mk.status}`);

  const noTicket = await get('/hub/enter');
  const noTicketHtml = await noTicket.text();
  check('没带票 → 400 E7002', noTicket.status === 400 && noTicketHtml.includes('E7002'), `HTTP ${noTicket.status}`);

  // 本地授权表为空 = 首次认领：把 acc_me 绑到「老板」
  const firstTicket = sign({ sub: 'acc_me' });
  const first = await get(`/hub/enter?ticket=${encodeURIComponent(firstTicket)}`);
  const cookie = first.headers.get('set-cookie') ?? '';
  check('有效票 → 302 到 /', first.status === 302 && first.headers.get('location') === '/', `HTTP ${first.status}`);
  check('拿到本机会话 Cookie（bandi_sid）', /bandi_sid=/.test(cookie));
  const sid = /bandi_sid=([^;]+)/.exec(cookie)?.[1] ?? '';
  const page = await get('/', { cookie: `bandi_sid=${sid}`, accept: 'text/html' });
  const pageHtml = await page.text();
  // 面板首页的 title 是「班底」，登录页是「班底 · 登录」—— 用这个分，别用关键词（首页里也有"登录"两个字）
  check('带着这枚会话能进面板（不是登录页）', page.status === 200 && pageHtml.includes('<title>班底</title>'), `HTTP ${page.status}`);

  const cfgAfter = JSON.parse(fs.readFileSync(path.join(dataDir, 'hub.json'), 'utf8'));
  check('首次认领后 claimPending 关掉', cfgAfter.claimPending === false);

  console.log('\n[3] 负样本');
  const expired = await get(`/hub/enter?ticket=${encodeURIComponent(sign({ sub: 'acc_me', exp: -600 }))}`);
  check('过期票 → 410 E7003', expired.status === 410 && (await expired.text()).includes('E7003'), `HTTP ${expired.status}`);

  const wrongDev = await get(`/hub/enter?ticket=${encodeURIComponent(sign({ sub: 'acc_me', dev: 'dev_other' }))}`);
  check('不是给这台机器的票 → 400 E7004', wrongDev.status === 400 && (await wrongDev.text()).includes('E7004'), `HTTP ${wrongDev.status}`);

  const badSig = await get(`/hub/enter?ticket=${encodeURIComponent(sign({ sub: 'acc_me' }).slice(0, -4) + 'AAAA')}`);
  check('签名坏了 → 400 E7001', badSig.status === 400 && (await badSig.text()).includes('E7001'), `HTTP ${badSig.status}`);

  // 有效票但本地没认过这个账号：授权表已经有行了（上面认领过），不会再认领
  const stranger = await get(`/hub/enter?ticket=${encodeURIComponent(sign({ sub: 'acc_stranger' }))}`);
  check('有效票 + 本地没认过 → 403 E7003', stranger.status === 403 && (await stranger.text()).includes('E7003'), `HTTP ${stranger.status}`);

  const replayed = await get(`/hub/enter?ticket=${encodeURIComponent(firstTicket)}`);
  check('同一张票再用一次 → 410 E7005', replayed.status === 410 && (await replayed.text()).includes('E7005'), `HTTP ${replayed.status}`);

  const fresh = await get(`/hub/enter?ticket=${encodeURIComponent(sign({ sub: 'acc_me' }))}`);
  check('换一张新票还能进（一次性只针对同一张）', fresh.status === 302, `HTTP ${fresh.status}`);

  /*
   * [4] 登录页（2026-11-07 定稿）：**手机号 + 密码，一个框一个按钮**，提交给本机 /hub/login。
   *
   * 页面自己长在本机，表单转给中枢，人不跳域；登录即注册（中枢按手机号存不存在
   * 自己决定登录还是创建），所以页面上没有第二个"创建账号"按钮。这里验页面的形状：
   * 手机号输入框、单个提交按钮、没有本机账号磁贴。
   */
  console.log('\n[4] 登录页');
  const loginHtml = await (await get('/', { accept: 'text/html' })).text();
  check('登录页就是中枢账号表单', loginHtml.includes('action="/hub/login"') && loginHtml.includes('name="password"'));
  check('手机号输入框（tel 键盘 + 11 位上限）', loginHtml.includes('name="username"') && loginHtml.includes('inputmode="tel"') && loginHtml.includes('maxlength="11"'));
  check('只有一个提交按钮（登录即注册，没有单独的注册按钮）', !loginHtml.includes('value="register"'));
  check('没有本机账号磁贴', !loginHtml.includes('class="tile"'));
  const loginGet = await get('/hub/login');
  check('GET /hub/login 只是回首页（老书签兼容）', loginGet.status === 302 && (loginGet.headers.get('location') ?? '') === '/', `HTTP ${loginGet.status}`);
  const loginPost = await fetch(`${base}/hub/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
    body: new URLSearchParams({ username: 'no-such-one', password: 'not-the-password' }).toString(),
    redirect: 'manual',
  });
  const loginPostHtml = await loginPost.text();
  check('错的账号原地回登录页并给原因', loginPost.status === 401 && loginPostHtml.includes('action="/hub/login"'), `HTTP ${loginPost.status}`);

  /*
   * [4b] Origin: null 的兜底（2026-11-07 实报 E7006）：桌面壳的 WebView2 表单 POST
   * 有时带 `Origin: null`（从 POST 响应渲染的页面上再提交时尤其如此）。同源闸此刻
   * 退到 CSRF 双提交：没有这对值 → 403 渲染回登录页；带上 → 放行，照旧走到中枢。
   */
  console.log('\n[4b] Origin: null 的兜底');
  const nullPost = await fetch(`${base}/hub/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null' },
    body: new URLSearchParams({ username: 'x', password: 'y' }).toString(),
    redirect: 'manual',
  });
  const nullHtml = await nullPost.text();
  check('Origin: null 且没有双提交对 → 403 回登录页', nullPost.status === 403 && nullHtml.includes('E7006') && nullHtml.includes('action="/hub/login"'), `HTTP ${nullPost.status}`);

  // 取一对真实值：登录页种 `bandi_csrf` Cookie，表单里带同值隐藏域 —— 浏览器提交时天然齐全
  const seeded = await get('/', { accept: 'text/html' });
  const csrfCookie = /bandi_csrf=([^;]+)/.exec(seeded.headers.get('set-cookie') ?? '')?.[1] ?? '';
  const csrfField = /name="_csrf" value="([^"]+)"/.exec(await seeded.text())?.[1] ?? '';
  check('登录页种下 csrf 双提交对（Cookie = 隐藏域）', !!csrfCookie && csrfCookie === csrfField);
  const nullOk = await fetch(`${base}/hub/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'null',
      cookie: `bandi_csrf=${encodeURIComponent(csrfCookie)}`,
    },
    body: new URLSearchParams({ username: 'no-such-one', password: 'not-the-password', _csrf: csrfField }).toString(),
    redirect: 'manual',
  });
  check('Origin: null + 双提交对 → 放行走到中枢（401 回登录页）', nullOk.status === 401 && (await nullOk.text()).includes('action="/hub/login"'), `HTTP ${nullOk.status}`);

  /*
   * [4c] 登录成功路径 + 认领（假中枢，起一台**全新机器**）：
   * 主服务在 [2] 已经被 acc_me 认领过了 —— 2026-11-07 认领只此一次，新账号在这儿
   * 登录必须被拒。所以成功路径（注册 → 登录 → 认领 → 进面板）要一台干净机器来钉：
   * hub.json 都不用预写，BANDI_HUB 环境变量直接指到假中枢。
   */
  console.log('\n[4c] 登录成功 + 认领（假中枢，全新机器）');
  const stub = await startHubStub({
    accounts: { 甲: { password: '甲-pass-123' }, 乙: { password: '乙-pass-456' } },
  });
  const dir2 = path.join(tmp, 'data-fresh');
  fs.mkdirSync(dir2, { recursive: true });
  const PORT2 = PORT + 1;
  const child2 = spawn(process.execPath, [SERVER], {
    cwd: repoRoot,
    env: { ...process.env, BANDI_PORT: String(PORT2), BANDI_HOST: '127.0.0.1', BANDI_DATA: dir2, BANDI_DB: path.join(dir2, 'bandi.db'), BANDI_HUB: stub.url },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child2.stdout.on('data', (d) => (log += d));
  child2.stderr.on('data', (d) => (log += d));
  const base2 = `http://127.0.0.1:${PORT2}`;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${base2}/api/hello`)).status === 200) break; } catch { /* 还没起 */ }
    await sleep(200);
  }

  const okLogin = await hubLogin(base2, { username: '甲', password: '甲-pass-123', origin: base2 });
  check('对的账号密码 → 302 进面板（零账号机器：第一个登录的人认领）',
    okLogin.status === 302 && okLogin.location === '/' && !!okLogin.sid, `HTTP ${okLogin.status}`);
  const cfgAfterLogin = JSON.parse(fs.readFileSync(path.join(dir2, 'hub.json'), 'utf8'));
  check('登录后 hub.json 落了设备身份与账号', !!cfgAfterLogin.deviceId && cfgAfterLogin.accountId === 'acc_甲');
  const stubHome = await fetch(`${base2}/`, { headers: { cookie: `bandi_sid=${okLogin.sid}`, accept: 'text/html' } });
  check('登录会话真的能进面板', stubHome.status === 200 && (await stubHome.text()).includes('<title>班底</title>'), `HTTP ${stubHome.status}`);
  const badLogin = await hubLogin(base2, { username: '甲', password: 'wrong-pass-9', origin: base2 });
  check('错的密码原地回登录页并给原因', badLogin.status === 401 && badLogin.html.includes('action="/hub/login"'), `HTTP ${badLogin.status}`);

  // 认领只此一次：第二个中枢账号凭对的密码也进不来，得机器主人放行
  const secondLogin = await hubLogin(base2, { username: '乙', password: '乙-pass-456', origin: base2 });
  check('第二个中枢账号凭对密码也进不来（认领已关闭）→ 403', secondLogin.status === 403 && secondLogin.html.includes('E7003'),
    `HTTP ${secondLogin.status}`);
  check('拒绝文案指路 bandi hub allow', secondLogin.html.includes('bandi hub allow'));
  // 甲（已认领的账号）再登录 → 照常进门：认领是一次性的，不是每次登录都要重新认
  const reLogin = await hubLogin(base2, { username: '甲', password: '甲-pass-123', origin: base2 });
  check('已认领的账号再登录 → 照常 302', reLogin.status === 302 && !!reLogin.sid, `HTTP ${reLogin.status}`);

  child2.kill();
  await stub.close();

  /*
   * [5] 服务器形态（开局域网）：中枢票进门在 LAN 监听下照常工作。
   */
  console.log('\n[5] 服务器形态');
  child.kill();
  await sleep(500);
  const lan = spawn(process.execPath, [SERVER], {
    cwd: repoRoot,
    env: { ...process.env, BANDI_PORT: String(PORT), BANDI_HOST: '0.0.0.0', BANDI_DATA: dataDir, BANDI_DB: path.join(dataDir, 'bandi.db') },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  lan.stdout.on('data', (d) => (log += d));
  lan.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 60; i++) {
    try {
      if ((await get('/api/hello')).status === 200) break;
    } catch { /* 还没起 */ }
    await sleep(200);
  }
  const lanEnter = await get(`/hub/enter?ticket=${encodeURIComponent(sign({ sub: 'acc_me' }))}`);
  const lanSid = /bandi_sid=([^;]+)/.exec(lanEnter.headers.get('set-cookie') ?? '')?.[1] ?? '';
  check('服务器形态下同样能验票进门', lanEnter.status === 302 && !!lanSid, `HTTP ${lanEnter.status}`);
  const lanHome = await get('/', { cookie: `bandi_sid=${lanSid}`, accept: 'text/html' });
  const lanHtml = await lanHome.text();
  check('中枢会话在服务器形态下能进面板', lanHome.status === 200 && lanHtml.includes('<title>班底</title>'), `HTTP ${lanHome.status}`);
  lan.kill();
} catch (e) {
  check('冒烟过程没抛异常', false, String(e?.stack ?? e));
} finally {
  child.kill();
  await sleep(300);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows 上可能删不掉，无所谓 */ }
}

if (failed) {
  console.log(`\n${failed} 项失败`);
  console.log('--- 服务日志 ---\n' + log.split('\n').slice(-40).join('\n'));
  process.exit(1);
}
console.log('\n全部通过');
