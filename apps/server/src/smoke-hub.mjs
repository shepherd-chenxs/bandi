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
   * [4] 桌面端登录入口（2026-11-06）：面板不再"只连自己"。
   *
   * 桌面 App 打开就是本机面板，登录页上第一个按钮必须是「用中枢账号登录」；
   * 点下去打 `/hub/login`，它只做一件事：带着自己的 origin 302 到中枢的 enter 端点。
   * `return` 用回环 + 本机端口 —— 中枢只接受设备上报过的地址或 127.0.0.1 同端口。
   */
  console.log('\n[4] 桌面端登录入口');
  const loginHtml = await (await get('/', { accept: 'text/html' })).text();
  check('登录页有「用中枢账号登录」', loginHtml.includes('用中枢账号登录'));
  check('按钮指向 /hub/login', loginHtml.includes('href="/hub/login"'));
  const go = await get('/hub/login');
  const loc = go.headers.get('location') ?? '';
  check('点它 302 到中枢的 enter', go.status === 302 && loc.startsWith('https://hub.test/v1/devices/dev_self/enter?'), `HTTP ${go.status} ${loc.slice(0, 60)}`);
  check('带回环 origin 作 return', loc.includes(`return=${encodeURIComponent(base)}`), loc.slice(-60));

  /*
   * [5] 服务器形态（开局域网）：免密账号的「受限会话」不该把中枢会话也锁住。
   *
   * 那条限制的理由是「免密账号在局域网 = 谁都能点进来」，而中枢会话背后是签过名的票。
   * 不豁免的话，主力场景（主机开局域网 + 本机账号免密）一进面板就 E4098。
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
  check('免密账号的中枢会话不被 E4098 锁住', lanHome.status === 200 && lanHtml.includes('<title>班底</title>'), `HTTP ${lanHome.status}`);
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
