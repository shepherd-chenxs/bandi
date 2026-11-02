/**
 * 不透明访问票 `at_`（IAM §6.2 / §7.1，Phase 3；**JWT 已拍板不做**，附录 A）。
 *
 * 形态：`at_` + 32B base64url，无结构、不签名；服务端只存 sha256；TTL 15 分钟
 * （文档口径 10–15 分钟，取上限 —— 单机形态下撤销本来就是即时的，取长些省得 CLI 频繁换票）。
 * 携带：`Authorization: Bearer at_...`；不放 Cookie、不放 URL（§7.1）。
 *
 * 权限不入票：票只回答"我是谁 + 签发水位 tv"，"能不能干"是 PDP（policy.authorize）的事。
 */
import * as store from '../store.mjs';

export const AT_PREFIX = 'at_';
/** 15 分钟（§6.2 口径 10–15 分钟，取上限，理由见文件头） */
export const AT_TTL = 15 * 60_000;

export const issue = ({ subjectKind, subjectId, kind, scopes = '', sessionId = '', tv = 0, ttlMs = AT_TTL, ip = '', ua = '' }) =>
  store.issueAccessToken({ subjectKind, subjectId, kind, scopes, sessionId, tv, ttlMs, ip, ua });

/** 验票（只判票自身 + tv 水位 + 账号状态；PDP 的活它不掺和）。返回行或 null。 */
export const verify = (token) => store.verifyAccessToken(token);

export const revoke = (token) => store.revokeAccessToken(token);
export const revokeOf = (subjectKind, subjectId) => store.revokeAccessTokensOf(subjectKind, subjectId);

/** 人类票：把行升级成 PDP 认识的"登录用户"Principal（与 Cookie 会话同一形状）。 */
export function principalFrom(row, users) {
  const u = users.getUser(row.subjectId);
  if (!u) return null;
  return {
    kind: 'user',
    userId: u.id,
    roleId: u.roleId,
    admin: u.roleId === 'admin',
    restricted: false, // 短票只在有密码换票链里发（免密账号不发票），见 routes/auth-token
    via: 'bearer',
    sessionRow: null,
  };
}
