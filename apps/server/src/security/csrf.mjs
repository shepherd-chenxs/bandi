/*
 * security/csrf.mjs —— CSRF 双提交（IAM §10.2，2026-10-31 Phase 1 收尾）。
 *
 * 三道并存（文档 §10.2）：
 *   ① Origin 校验（http.mjs guardWrite，已有）；
 *   ② `X-Bandi: 1` 自定义头（原生表单设不了头，已有）；
 *   ③ **双提交**（本文件）：Cookie `bandi_csrf`（非 HttpOnly，JS 要读它）与请求头
 *      `X-Bandi-CSRF` 必须一致 —— 攻击者站点能"发"请求（借浏览器自动带 Cookie），
 *      但**读不到**别的域的 Cookie，凑不齐这对值 → 403 E4099。
 *
 * 明文 HTTP 部署（§10.2 的第二行）：**不加 `Secure`、不加 `__Host-` 前缀** ——
 * 带上等于浏览器不存这个 Cookie，登录死循环。明文分支的额外损失（子站可覆写
 * Cookie = cookie tossing，双提交剩 Origin + X-Bandi 两道）文档已注明，接受。
 * 将来上 HTTPS 时切 `__Host-bandi_csrf` + `Secure`，一处改这里（COOKIE 常量）。
 *
 * 谁要校验、谁豁免：
 *   · **只校验"凭据来自 Cookie"的写请求** —— bandi_sid / bandi_token 是浏览器自动附带的，
 *     这正是 CSRF 的攻击面；
 *   · 带 `X-Bandi-Token` 头的（CLI / 脚本 / 节点）浏览器不会自动带，天然免疫，不校验；
 *   · 登录请求此刻没有任何 Cookie 凭据，不校验（login CSRF 不在本期范围）。
 */

import crypto from 'node:crypto';

export const COOKIE = 'bandi_csrf';
export const HEADER = 'x-bandi-csrf';

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** 发一枚新 csrf 值（32 字节随机 base64url） */
export function mint() {
  return crypto.randomBytes(32).toString('base64url');
}

/** Set-Cookie 值。⚠️ 明文部署刻意不带 Secure / __Host-（文件头注释，别"顺手加固"） */
export function cookieFor(value) {
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; SameSite=Lax; Max-Age=${86400}`;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * 这枚请求的 csrf 值（cookie 与 header 里各取一份；拿不到就是空串）。
 * 导出来给 smoke 用 —— 测试要模拟"浏览器自己读 cookie 带头"。
 */
export function valuesOf(req) {
  const c = parseCookies(req.headers.cookie)[COOKIE] ?? '';
  const h = String(req.headers[HEADER] ?? '');
  return { cookie: c, header: h };
}

/** 定长比较，别让"比到第几个字符不同"泄漏出去 */
function safeEqual(a, b) {
  const A = Buffer.from(String(a ?? ''));
  const B = Buffer.from(String(b ?? ''));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

/**
 * 写请求的 CSRF 闸。返回 null = 放行；返回字符串 = 403 E4099 的文案。
 *
 * 判据（文件头"谁要校验"）：方法是写 **且** Cookie 里有会话/令牌凭据，就必须
 * cookie 与 header 的 csrf 值一致。没有 Cookie 凭据的写请求（登录、CLI 带头）直接放行。
 */
export function check(req) {
  if (!WRITE.has(req.method)) return null;
  const cookies = parseCookies(req.headers.cookie);
  const hasCred = !!(cookies.bandi_sid || cookies.bandi_token);
  if (!hasCred) return null;
  const { cookie, header } = valuesOf(req);
  if (!cookie || !header || !safeEqual(cookie, header)) {
    return '请求缺少有效的 CSRF 凭据（可能登录已过期）—— 刷新页面重新登录后重试';
  }
  return null;
}
