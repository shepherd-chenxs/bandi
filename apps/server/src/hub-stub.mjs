/*
 * hub-stub.mjs —— 冒烟测试的「假中枢」+ 登录帮手（**不是 smoke-\*，run-smokes 是清单制不会跑它**）。
 *
 * 2026-11-07 起本地账号登录退场，中枢账号密码框（POST /hub/login）是**唯一**的登录方式；
 * 冒烟要造一个登录会话，只有一条真路：起一个假中枢，让本机把表单转给它。
 * 这里把 smoke-hub.mjs 里那套 Ed25519 签票工具搬出来共用，再加三样：
 *
 *   · `startHubStub()`   —— 一个只认得几个账号的 HTTP 假中枢：
 *                           `POST /v1/auth/device-login`（契约同 bandi-hub §四）+
 *                           `GET /v1/pubkey` + 心跳（安静地 200，别让 60 秒一次的
 *                           心跳在测试日志里刷屏）。
 *   · `signTicket()`     —— 按中枢的格式签一张 Ed25519 票（/hub/enter 测试用）。
 *   · `hubLogin()`       —— 对本机 `POST /hub/login` 提一次表单，拿回 bandi_sid。
 *
 * 隔离的用法：spawn server 时把 `BANDI_HUB` 指到 stub 的地址 —— 中枢地址永远有值
 * （内置默认），测试里不指就会去连真的 hub.yuancang.space，那不是测试该干的事。
 */

import crypto from 'node:crypto';
import http from 'node:http';

const HEADER = Buffer.from(JSON.stringify({ alg: 'Ed25519', typ: 'JWT' }), 'utf8').toString('base64url');

/** 一对测试用的 Ed25519 钥匙；PUB 的形状 = base64url(raw spki 的最后 32 字节) */
export function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  return { publicKey: pub, privateKey };
}

/** 按中枢的格式签一张票（verifyTicket 的正样本）。`login` = 中枢登录名（手机号），机器端拿它建影子账号 */
export function signTicket(privateKey, { sub = 'acc_me', dev = 'dev_self', login = null, exp = 300, jti = crypto.randomBytes(9).toString('base64url') } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: 'bandi-hub', aud: 'bandi', sub, dev, ...(login ? { login } : {}), jti, iat: now, exp: now + exp };
  const body = `${HEADER}.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
  const sig = crypto.sign(null, Buffer.from(body, 'utf8'), privateKey).toString('base64url');
  return `${body}.${sig}`;
}

/**
 * 起一个假中枢。
 * @param {{
 *   keyPair?: { publicKey: string, privateKey: import('node:crypto').KeyObject },
 *   deviceId?: string, deviceToken?: string,
 *   accounts?: Record<string, { password: string, id?: string, name?: string }>,
 *   relay?: any,
 * }} opts
 * @returns {Promise<{ url: string, publicKey: string, requests: { path: string, body: any }[], close: () => Promise<void> }>}
 */
export function startHubStub({ keyPair = generateKeyPair(), deviceId = 'dev_self', deviceToken = 'dt_stub', accounts = {}, relay = null } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 256 * 1024) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { /* 不是 JSON 就当空 */ }
      requests.push({ path: req.url ?? '', body });

      const reply = (status, json) => {
        const payload = JSON.stringify(json);
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
        res.end(payload);
      };

      if (req.method === 'GET' && req.url === '/v1/pubkey') return reply(200, { publicKey: keyPair.publicKey });

      if (req.method === 'POST' && req.url === '/v1/auth/device-login') {
        const username = String(body?.username ?? '');
        const password = String(body?.password ?? '');
        // 登录即注册（2026-11-07）：存在就验密码，不存在就当场建 —— 与真中枢同语义
        const known = accounts[username];
        if (known && known.password !== password) {
          return reply(401, { error: { code: 'H1004', message: '手机号或密码不对' } });
        }
        if (!known) accounts[username] = { password, id: `acc_${username}`, name: username };
        const acct = accounts[username];
        const id = acct.id ?? `acc_${username}`;
        return reply(200, {
          // 票带 login（与真中枢 2026-11-07 起同语义）：机器端 /hub/enter 据此给影子账号起人话名
          ticket: signTicket(keyPair.privateKey, { sub: id, dev: deviceId, login: username }),
          deviceId,
          deviceToken,
          publicKey: keyPair.publicKey,
          account: { id, login: username, name: acct.name ?? username },
          // 隧道开通（2026-11-07）：真中枢在同一个响应里给出 relay，机器端据此起 frpc
          ...(relay ? { relay } : {}),
        });
      }

      // 心跳 / 名册：测试里不需要它们说什么，但别让连接挂着。
      // 带 relay 时一并下发 —— 覆盖"开通/换子域名/吊销(null)"这一整条改派路径。
      if (req.method === 'POST' && (req.url ?? '').startsWith('/v1/devices/')) {
        return reply(200, { ok: true, ...(relay ? { relay } : {}) });
      }
      return reply(404, { error: { code: 'H3004', message: '假中枢不认识这个口' } });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        publicKey: keyPair.publicKey,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/**
 * 用中枢账号在本机登录页登录一次，拿回会话。
 * @param {string} base 本机服务根地址
 * @param {{ username: string, password: string, mode?: 'login'|'register', origin?: string, cookie?: string }} input
 * @returns {Promise<{ status: number, location: string|null, sid: string, html: string }>}
 */
export async function hubLogin(base, { username, password, mode = 'login', origin, cookie } = {}) {
  const headers = {
    'content-type': 'application/x-www-form-urlencoded',
    ...(origin ? { origin } : {}),
    ...(cookie ? { cookie } : {}),
  };
  const r = await fetch(`${base}/hub/login`, {
    method: 'POST',
    headers,
    body: new URLSearchParams({ username, password, ...(mode === 'register' ? { mode: 'register' } : {}) }).toString(),
    redirect: 'manual',
  });
  const setCookie = r.headers.get('set-cookie') ?? '';
  return {
    status: r.status,
    location: r.headers.get('location'),
    sid: /bandi_sid=([^;]+)/.exec(setCookie)?.[1] ?? '',
    html: await r.text(),
  };
}
