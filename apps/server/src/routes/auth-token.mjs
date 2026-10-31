/**
 * /api/auth/token · /api/auth/refresh · /api/auth/revoke（IAM §6.2，Phase 3）。
 *
 * 换票链：`at_` 短票 15 分钟（Authorization: Bearer），`rf_` 刷新票 30 天、
 * 每次轮换、复用检测整族撤销（E4092）。人类票不带权限 —— PDP 每请求查。
 *
 * 三种凭据都能开链（§6.2 / §6.4）：
 *   ① `{ name, password }` —— CLI / 脚本（开动态验证的账号要带 `otp`；免密账号不发票，
 *      免密 = 本机点一下就进的网页形态，给脚本发 30 天刷新票等于把"免密"放大到全网）；
 *   ② `{ refreshToken }` —— 轮换（同 /api/auth/refresh）；
 *   ③ 根令牌头 `X-Bandi-Token` —— break-glass 短票：subjectKind='machine'、scopes='*'
 *      （§6.4 "根令牌可以换 access token"）。
 */

import { sendJson, readBody, fail } from '../http.mjs';
import * as store from '../store.mjs';
import * as auth from '../auth.mjs';
import * as tokens from '../security/tokens.mjs';
import * as refresh from '../security/refresh.mjs';
import { UserError, tooMany, noteFail, clearFails } from './users.mjs';

const ipUa = (req) => ({
  ip: req.socket?.remoteAddress ?? '',
  ua: String(req.headers['user-agent'] ?? '').slice(0, 200),
});

/** 票响应体（§6.2 表格第一行的形状） */
const ticketBody = (access, rt) => ({
  ok: true,
  tokenType: 'Bearer',
  accessToken: access.token,
  expiresIn: access.expiresIn,
  ...(rt ? { refreshToken: rt.token, refreshExpiresIn: Math.round(refresh.RF_TTL / 1000) } : {}),
});

/**
 * 密码换票：与网页登录同一套校验（内存限速三辅助从 routes/users.mjs 借来用 ——
 * 同一个计数器，脚本炸 `POST /api/auth/token` 和炸网页登录是一个待遇）、
 * scrypt 恒时、统一文案 —— 但**不开会话**。
 */
async function byPassword(req, body) {
  const name = String(body?.name ?? '').trim();
  const password = String(body?.password ?? '');
  if (!name || !password) throw new UserError(400, 'E3804', '要带 name 和 password');
  if (tooMany(req, name) || store.loginLocked(name)) throw new UserError(429, 'E4095', '登录失败次数太多，请几分钟后再试');
  const user = store.userByName(name);
  const ok = !!user && !user.disabled && !!user.hash && store.checkPassword(user, password);
  if (!ok) {
    noteFail(req, name);
    throw new UserError(401, 'E3805', '用户名或密码不对');
  }
  // 动态验证：开了就要带 otp（直验 —— CLI 拿不到网页那次性凭据弹窗）
  if (store.isEnabled(user.id)) {
    const otp = String(body?.otp ?? '').trim();
    if (!otp) throw new UserError(401, 'E3808', '该账号已开动态验证，请带 otp 字段（6 位动态码或恢复码）');
    if (!store.verify(user.id, otp)) {
      noteFail(req, name);
      throw new UserError(401, 'E3808', '动态验证码不对');
    }
  }
  clearFails(req, name);
  store.clearLoginFails(name);
  const { ip, ua } = ipUa(req);
  const tv = user.tokenVersion ?? 1;
  const fam = refresh.start({ userId: user.id, tv, ip, ua });
  const access = tokens.issue({ subjectKind: 'user', subjectId: user.id, kind: 'cli', tv, ip, ua });
  return ticketBody(access, fam);
}

export async function handleAuthToken(req, res, url) {
  try {
    return await route(req, res, url);
  } catch (err) {
    if (err instanceof UserError) return fail(res, err.status, err.code, err.message), true;
    throw err; // 其余交给 server.mjs 顶层 catch（E5004 那一层）
  }
}

async function route(req, res, url) {
  const p = url.pathname;
  const { ip, ua } = ipUa(req);

  /* ------------------------------------- 换票 */
  if (p === '/api/auth/token' && req.method === 'POST') {
    const body = await readBody(req);
    // ③ 根令牌换 break-glass 短票（scopes='*'，PDP 见 '*' 即放行；15 分钟，够一次脚本跑完）
    if (auth.tokenOf(req, url)) {
      const t = tokens.issue({ subjectKind: 'machine', subjectId: 'root', kind: 'cli', scopes: '*', tv: 0, ip, ua });
      return sendJson(res, 200, { ok: true, tokenType: 'Bearer', accessToken: t.token, expiresIn: t.expiresIn, scopes: '*' });
    }
    // ② 带刷新票 = 轮换；① 带账号密码 = 开新链
    if (body?.refreshToken) {
      const r = refresh.rotate(String(body.refreshToken), { ip, ua });
      if (!r.ok) throw new UserError(401, r.code, r.message);
      return sendJson(res, 200, ticketBody(r.access, r.refresh));
    }
    return sendJson(res, 200, await byPassword(req, body));
  }

  /* ------------------------------------- 刷新（轮换） */
  if (p === '/api/auth/refresh' && req.method === 'POST') {
    const body = await readBody(req);
    const rt = String(body?.refreshToken ?? '');
    if (!rt) throw new UserError(400, 'E3804', '要带 refreshToken');
    const r = refresh.rotate(rt, { ip, ua });
    if (!r.ok) throw new UserError(401, r.code, r.message);
    return sendJson(res, 200, ticketBody(r.access, r.refresh));
  }

  /* ------------------------------------- 撤销 */
  if (p === '/api/auth/revoke' && req.method === 'POST') {
    const body = await readBody(req);
    const at = String(body?.accessToken ?? '').replace(/^Bearer\s+/i, '') || (String(req.headers.authorization ?? '').match(/^Bearer\s+(at_\S+)$/)?.[1] ?? '');
    const rt = String(body?.refreshToken ?? '');
    let n = 0;
    if (rt) {
      const row = store.getRefreshToken(rt);
      if (row && !row.revokedAt) n = store.revokeRefreshFamily(row.familyId);
    }
    if (at) n += tokens.revoke(at) ? 1 : 0;
    if (!at && !rt) throw new UserError(400, 'E3804', '要带 accessToken 或 refreshToken（至少一个）');
    return sendJson(res, 200, { ok: true, revoked: n });
  }

  return false; // 不归我
}
