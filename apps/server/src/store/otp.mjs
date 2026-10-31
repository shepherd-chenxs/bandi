/*
 * store/otp.mjs —— 动态验证（TOTP）与登录第二段凭据（2026-10-31）。
 *
 * 设计仿 E:\02CodeSpace\gitee\yaojian-ruoyi 的动态验证（YaojianOtpController /
 * UserOtpService / OtpCrypto），逐条对齐它的取舍：
 *
 *   · **独立表 `user_otp`**，不往 users 上挂字段 —— 动态验证是叠加在登录流上的增值层，
 *     表结构演进不跟账号主表纠缠；
 *   · **密钥 AES-GCM 加密后落库**（`BANDI_OTP_KEY` 经 SHA-256 派生 32 字节，iv 12 字节随机，
 *     密文 = base64(iv || ciphertext+tag)）—— 库文件泄露不等于密钥泄露；
 *   · **10 个一次性恢复码**：8 位、剔除 0/O/o/1/l/I 等易混字符，只存 SHA-256，**原文只在绑定成功时
 *     返回一次**；用一次删一个（手机丢了还能登）；
 *   · **两段式登录**：密码过了、账号开了动态验证 → **先不发会话**，发一张一次性 `otp_challenges`
 *     凭据（5 分钟、最多 5 次）→ 第二段交动态码或恢复码，通过才发正式会话；
 *   · **±1 时间片窗口**（时钟差半分钟不该把人锁外面）、**常量时间比较**；
 *   · 解绑要验当前有效动态码（防手机丢失后被别人顺手关掉）。
 *
 * 与参考项目的唯一差别：它用 Redis 存待验证凭据，班底零依赖 → 用 SQLite 表 `otp_challenges`
 * （只存 token 的 sha256，重启不丢，过期启动时清一次）。
 */

import crypto from 'node:crypto';
import { db, nowIso } from './db.mjs';
// TOTP 的算法本体（纯函数、不碰库）：冒烟也要用它算码，算法不许有两份
import { base32Decode, totpAt, STEP_SECONDS } from '../otp-code.mjs';

/* ------------------------------------------------------------------ 表 */

db.exec(`
  CREATE TABLE IF NOT EXISTS user_otp (
    userId    TEXT PRIMARY KEY,
    secret    TEXT NOT NULL,
    recovery  TEXT,
    bindTime  TEXT
  );

  CREATE TABLE IF NOT EXISTS otp_challenges (
    tokenHash TEXT PRIMARY KEY,
    userId    TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    expiresAt TEXT NOT NULL,
    tries     INTEGER NOT NULL DEFAULT 0
  );
`);

/* ------------------------------------------------------------------ 口令派生 */

/**
 * 落库加密口令。生产**必须**用环境变量 `BANDI_OTP_KEY` 覆盖默认值 ——
 * 默认值写在这里是为了"部署完就能用"，不是因为它安全（跟参考项目的 ChangeMe 同口径）。
 */
const KEY_PHRASE = String(process.env.BANDI_OTP_KEY ?? '').trim() || 'bandi-otp-key-change-me-2026';
const KEY = crypto.createHash('sha256').update(KEY_PHRASE).digest();

export function aesEncrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]).toString('base64');
}

export function aesDecrypt(encoded) {
  const all = Buffer.from(String(encoded ?? ''), 'base64');
  const iv = all.subarray(0, 12);
  const tag = all.subarray(all.length - 16);
  const ct = all.subarray(12, all.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/* ------------------------------------------------------------------ TOTP（RFC 6238） */

/*
 * 算法本体（B32 / base32Decode / totpAt / generateSecret）在 `src/otp-code.mjs`。
 * 抽出去的唯一理由：冒烟是黑盒 HTTP 测试，得自己算一个码塞进接口，
 * 而本文件顶层会建表 —— 冒烟进程 import 它等于往真实数据目录写库 ✗。
 */
export { generateSecret } from '../otp-code.mjs';

/** ±1 个时间片：时钟差半分钟不该把人锁在外面 */
const WINDOW = 1;

/** 验 6 位动态码：±WINDOW 个时间片内任一命中即可，常量时间比较 */
export function verifyTotp(base32Secret, code) {
  const want = String(code ?? '').trim();
  if (!/^\d{6}$/.test(want)) return false;
  const key = base32Decode(base32Secret);
  const step = Math.floor(Date.now() / 1000 / STEP_SECONDS);
  for (let i = -WINDOW; i <= WINDOW; i += 1) {
    const got = Buffer.from(totpAt(key, step + i));
    const A = Buffer.from(want);
    if (got.length === A.length && crypto.timingSafeEqual(got, A)) return true;
  }
  return false;
}

/** otpauth:// 扫码串 */
export function otpauthUri(secret, account, issuer = '班底') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/* ------------------------------------------------------------------ 恢复码 */

/** 剔除易混字符（0/O/o、1/l/I）—— 用户手抄恢复码时不该被字形状坑 */
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const RECOVERY_COUNT = 10;

export function generateRecoveryCode() {
  let out = '';
  for (let i = 0; i < 8; i += 1) out += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)];
  return out;
}

const sha256Hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/* ------------------------------------------------------------------ 读 */

export function getOtp(userId) {
  const row = db.prepare('SELECT * FROM user_otp WHERE userId = ?').get(String(userId ?? ''));
  if (!row) return null;
  const left = String(row.recovery ?? '')
    .split(',')
    .filter(Boolean).length;
  return { ...row, recoveryLeft: left };
}

export function isEnabled(userId) {
  return !!db.prepare('SELECT 1 FROM user_otp WHERE userId = ?').get(String(userId ?? ''));
}

/* ------------------------------------------------------------------ 写 */

/**
 * 保存绑定（**只在动态码校验通过后调用**，与参考项目一致）：
 * 密钥加密落库 + 生成 10 个恢复码（原文只回给调用方这一次，库里只有哈希）。
 * 返回恢复码原文数组。
 */
export function saveBinding(userId, base32Secret) {
  const plain = [];
  const hashes = [];
  for (let i = 0; i < RECOVERY_COUNT; i += 1) {
    const code = generateRecoveryCode();
    plain.push(code);
    hashes.push(sha256Hex(code));
  }
  db.prepare('INSERT OR REPLACE INTO user_otp (userId, secret, recovery, bindTime) VALUES (?, ?, ?, ?)').run(
    String(userId),
    aesEncrypt(base32Secret),
    hashes.join(','),
    nowIso(),
  );
  return plain;
}

export function removeBinding(userId) {
  return db.prepare('DELETE FROM user_otp WHERE userId = ?').run(String(userId ?? '')).changes > 0;
}

/** 取解密后的密钥（解绑校验 / 登录校验时用） */
export function decryptSecret(userId) {
  const row = getOtp(userId);
  if (!row) return null;
  try {
    return aesDecrypt(row.secret);
  } catch {
    return null; // 口令换过 = 旧密文解不开；当作不可用，让用户重新绑定
  }
}

/**
 * 登录第二段校验：**6 位动态码（±1 窗口）或 8 位恢复码**，一个输入框两种码。
 * 恢复码命中即消费（从逗号串里删掉那一条）。
 */
export function verify(userId, code) {
  const input = String(code ?? '').trim();
  if (!input) return false;
  const row = getOtp(userId);
  if (!row) return false;
  const secret = decryptSecret(userId);
  if (secret && /^\d{6}$/.test(input) && verifyTotp(secret, input)) return true;
  // 恢复码：定长 8 位、字符集外的不必查库
  if (!/^[A-Za-z2-9]{8}$/.test(input)) return false;
  const hashes = String(row.recovery ?? '')
    .split(',')
    .filter(Boolean);
  const hit = sha256Hex(input);
  const idx = hashes.findIndex((h) => h === hit);
  if (idx < 0) return false;
  hashes.splice(idx, 1); // 用一个删一个
  db.prepare('UPDATE user_otp SET recovery = ? WHERE userId = ?').run(hashes.join(','), String(userId));
  return true;
}

/* ------------------------------------------------------------------ 登录第二段凭据 */

const CHALLENGE_TTL_SECONDS = 300;
const MAX_ATTEMPTS = 5;

/**
 * 发一张"待验证"凭据：明文只回给调用方一次，库里只有 sha256。
 * 与 `user_sessions` 同一套口径（只存哈希），但 TTL 只有 5 分钟、带上尝试次数。
 */
export function createChallenge(userId) {
  const token = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO otp_challenges (tokenHash, userId, createdAt, expiresAt, tries) VALUES (?, ?, ?, ?, 0)').run(
    sha256Hex(token),
    String(userId),
    new Date(now).toISOString(),
    new Date(now + CHALLENGE_TTL_SECONDS * 1000).toISOString(),
  );
  return token;
}

/** 取凭据行（过期就顺手删掉）；不存在/过期都返回 null */
export function getChallenge(token) {
  const t = String(token ?? '').trim();
  if (!t) return null;
  const h = sha256Hex(t);
  const row = db.prepare('SELECT * FROM otp_challenges WHERE tokenHash = ?').get(h);
  if (!row) return null;
  if (Date.parse(row.expiresAt) <= Date.now()) {
    db.prepare('DELETE FROM otp_challenges WHERE tokenHash = ?').run(h);
    return null;
  }
  return row;
}

export function bumpChallengeTries(row) {
  db.prepare('UPDATE otp_challenges SET tries = tries + 1 WHERE tokenHash = ?').run(row.tokenHash);
  return row.tries + 1;
}

export function dropChallenge(row) {
  db.prepare('DELETE FROM otp_challenges WHERE tokenHash = ?').run(row.tokenHash);
}

/** 一次待验证凭据最多试几次（参考项目同为 5 次） */
export const CHALLENGE_MAX_ATTEMPTS = MAX_ATTEMPTS;

/** 启动清一次过期凭据（平时取用撞到过期的也会顺手删） */
export function pruneChallenges() {
  return db.prepare('DELETE FROM otp_challenges WHERE expiresAt <= ?').run(new Date().toISOString()).changes;
}

/**
 * 旧列迁移（2026-10-31 本轮改造前把明文密钥存在 users.totpSecret 上）：
 * 有明文密钥就搬进 user_otp（加密）—— pending 的（没验码确认）直接丢，不迁。
 * 迁完把旧列清空，避免两份真相。幂等：清空后匹配不到。
 */
export function migrateLegacyTotp() {
  const rows = db
    .prepare("SELECT id, totpSecret, totpPending FROM users WHERE totpSecret IS NOT NULL AND totpSecret != ''")
    .all();
  let moved = 0;
  for (const r of rows) {
    if (!r.totpPending) {
      db.prepare('INSERT OR REPLACE INTO user_otp (userId, secret, recovery, bindTime) VALUES (?, ?, ?, ?)').run(
        r.id,
        aesEncrypt(r.totpSecret),
        '', // 旧库没有恢复码：留空，用户可在「我的」里重新绑定拿到
        nowIso(),
      );
      moved += 1;
    }
    db.prepare("UPDATE users SET totpSecret = '', totpPending = 0 WHERE id = ?").run(r.id);
  }
  return moved;
}
