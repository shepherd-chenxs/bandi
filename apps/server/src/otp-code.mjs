/*
 * otp-code.mjs —— TOTP 的**纯算法**（2026-10-31 从 store/otp.mjs 里抽出来的）。
 *
 * 为什么单独一个文件：冒烟要用它算码（黑盒 HTTP 测试没法从库里掏出密钥），
 * 而 `store/otp.mjs` 顶层会 `db.exec(CREATE TABLE …)` —— 冒烟进程 import 它
 * 等于往**真实数据目录**建表 ✗。算法搬到这里，两边共用同一份，
 * 也就不存在"测试里自己抄一遍 HMAC、抄错了还以为功能坏了"。
 *
 * 规格：RFC 6238，SHA1 / 6 位 / 30 秒步长（所有验证器 App 的默认档）。
 */

import crypto from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** 一个时间片多少秒（RFC 6238 默认 30） */
export const STEP_SECONDS = 30;

/** 20 字节随机密钥 → base32（所有验证器 App 都吃） */
export function generateSecret() {
  const buf = crypto.randomBytes(20);
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** base32 → key。容错：忽略小写、空格、填充符（用户手抄的密钥常带这些） */
export function base32Decode(s) {
  const out = [];
  let bits = 0;
  let value = 0;
  for (const ch of String(s ?? '').toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 某个时间片上的 6 位码（step = 自 epoch 起的第几个 30 秒） */
export function totpAt(key, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | ((h[off + 1] & 0xff) << 16) | ((h[off + 2] & 0xff) << 8) | (h[off + 3] & 0xff);
  return String(bin % 1_000_000).padStart(6, '0');
}

/**
 * 某一时刻的码（给冒烟/调试用：自己算一个塞给接口，模拟验证器 App）。
 *
 * ⚠️ **这里只有"算码"，没有"验码"**（2026-11-08 核对）：生产校验需要 ±1 窗口 +
 * 常量时间比较，仓库里没有这一层。原文注释指向 `store/otp.mjs` 的 verifyTotp ——
 * 那个文件从来没存在过（动态口令这块 2026-11 前后退场了）。留个记号，别再来这儿找。
 */
export function codeAt(base32Secret, atMs = Date.now()) {
  return totpAt(base32Decode(base32Secret), Math.floor(atMs / 1000 / STEP_SECONDS));
}
