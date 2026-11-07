/*
 * hub/verify.mjs —— **验票**（中枢签，主机验）。契约见 bandi-hub/contract.md §五。
 *
 * 三条硬规矩，少一条都等于把闸拆了：
 *
 *   1. **不做算法协商**：header 必须逐字节等于中枢那一串 `{"alg":"Ed25519","typ":"JWT"}`。
 *      JWT 历史上最大的洞就是 `alg: none` —— 只要让"票自己说用什么算法"，攻击者
 *      总会找到一个验签库愿意当真的算法。这里直接比字符串，比对不上就拒。
 *   2. **用本地钉住的公钥验**，不联网取钥匙（见 hub/config.mjs 的注释）。
 *   3. **一次性**：`jti` 进本地内存表，5 分钟内重来即拒（票据会进浏览器历史与 Referer，
 *      防的是"同一张票被再打开一次"）。进程重启后表清空 —— 可以接受：票本身只有 5 分钟。
 *
 * 验完票**不等于**能进门 —— 还要过 `store/hubLinks.mjs` 那张本地授权表。
 * 认证与授权分开，中枢被攻破才不会变成全部机器被接管。
 */

import crypto from 'node:crypto';

/** 与 bandi-hub `src/tickets.mjs` 的 HEADER 必须**逐字节**相同 */
const EXPECTED_HEADER = Buffer.from(JSON.stringify({ alg: 'Ed25519', typ: 'JWT' }), 'utf8').toString('base64url');

/** Ed25519 raw 公钥（32 字节）→ SPKI DER 需要的固定前缀（RFC 8410） */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** 容忍多少秒时钟漂移（主机和手机的钟都可能慢几十秒） */
const SKEW_SECONDS = 120;

/** @type {Map<string, number>} jti → 过期秒 */
const usedJti = new Map();
/** 上次清理时间，避免每张票都扫一遍表 */
let lastSweep = 0;

/**
 * 这枚 jti 是不是已经用过了（用过就记下）。
 * @param {string} jti @param {number} expSec
 */
function consumeJti(jti, expSec) {
  const now = Math.floor(Date.now() / 1000);
  if (now - lastSweep > 60) {
    for (const [k, exp] of usedJti) if (exp + SKEW_SECONDS < now) usedJti.delete(k);
    lastSweep = now;
  }
  if (usedJti.has(jti)) return false;
  // 记到票自己的过期时间就够：过了 exp 的票本来就会被拒
  usedJti.set(jti, expSec);
  return true;
}

/**
 * base64url(raw 32B) → KeyObject。形状不对就抛，调用方按 `bad_key` 处理。
 * @param {string} b64u
 */
function publicKeyOf(b64u) {
  const raw = Buffer.from(String(b64u ?? ''), 'base64url');
  if (raw.length !== 32) throw new Error('Ed25519 raw public key must be 32 bytes');
  return crypto.createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

/** 顺便校验配置里的公钥能解析（join 时先试一次，别等第一次进门才发现是坏的） */
export function isValidPublicKey(b64u) {
  try {
    publicKeyOf(b64u);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} ticket
 * @param {string} publicKeyB64u 中枢公钥（raw, base64url）
 * @param {{ deviceId?: string, nowSec?: number }} [opts]
 * @returns {{ ok: true, payload: { iss: string, aud: string, sub: string, dev: string, jti: string, iat: number, exp: number } }
 *          | { ok: false, reason: 'malformed'|'bad_header'|'bad_payload'|'bad_key'|'bad_signature'|'bad_audience'|'bad_issuer'|'expired'|'not_yet'|'wrong_device'|'replayed' }}
 */
export function verifyTicket(ticket, publicKeyB64u, opts = {}) {
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const parts = String(ticket ?? '').split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [header, body, sig] = parts;

  // 1. 只认中枢签的那种头，逐字节比
  if (header !== EXPECTED_HEADER) return { ok: false, reason: 'bad_header' };

  /** @type {any} */
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'bad_payload' };
  }
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'bad_payload' };

  // 2. 验签
  let ok = false;
  try {
    ok = crypto.verify(
      null,
      Buffer.from(`${header}.${body}`, 'utf8'),
      publicKeyOf(publicKeyB64u),
      Buffer.from(sig, 'base64url'),
    );
  } catch {
    return { ok: false, reason: 'bad_key' };
  }
  if (!ok) return { ok: false, reason: 'bad_signature' };

  // 3. 声明
  if (payload.aud !== 'bandi') return { ok: false, reason: 'bad_audience' };
  if (payload.iss !== 'bandi-hub') return { ok: false, reason: 'bad_issuer' };
  if (!payload.exp || payload.exp + SKEW_SECONDS < now) return { ok: false, reason: 'expired' };
  if (payload.iat && payload.iat > now + SKEW_SECONDS) return { ok: false, reason: 'not_yet' };
  if (opts.deviceId && payload.dev !== opts.deviceId) return { ok: false, reason: 'wrong_device' };
  if (!payload.sub || !payload.jti) return { ok: false, reason: 'bad_payload' };

  // 4. 一次性
  if (!consumeJti(String(payload.jti), Number(payload.exp) || now + 300)) {
    return { ok: false, reason: 'replayed' };
  }

  return { ok: true, payload };
}

/** 票据里的失败原因 → 给用户看的错误码 + 一句话（不暴露票内容） */
export const VERIFY_ERRORS = {
  malformed: { code: 'E7001', message: '连接凭据格式不对' },
  bad_header: { code: 'E7001', message: '连接凭据格式不对' },
  bad_payload: { code: 'E7001', message: '连接凭据格式不对' },
  bad_signature: { code: 'E7001', message: '连接凭据验签失败' },
  bad_key: { code: 'E7002', message: '这台机器没配好中枢公钥（在本机登录页重新登录一次）' },
  bad_audience: { code: 'E7001', message: '连接凭据不是发给班底的' },
  bad_issuer: { code: 'E7001', message: '连接凭据不是这台机器信任的中枢签的' },
  expired: { code: 'E7003', message: '连接凭据已过期，请重新点一次' },
  not_yet: { code: 'E7003', message: '这台机器的时钟比中枢快太多，请校准时间' },
  wrong_device: { code: 'E7004', message: '这张连接凭据不是发给这台机器的' },
  replayed: { code: 'E7005', message: '连接凭据已经用过一次了，请重新点一次' },
};
