/**
 * refresh 族轮换 + 复用检测（IAM §6.2；Phase 3）。
 *
 * 规则（§6.2 表格下那三行）：
 *   · refresh = `rf_` + 32B，30 天，只存 sha256；
 *   · **每次刷新轮换**：旧票标 usedAt，发新票（同族追加）；
 *   · **复用检测**：已经 usedAt 的票再来换 → 判定泄漏 → 整族撤销 + 审计 `E4092`；
 *   · 刷新时校验：用户未禁用、tokenVersion 未变（tv 在行上）、会话未撤销（若关联了会话）。
 */
import * as store from '../store.mjs';
import { AT_TTL } from './tokens.mjs';

export const RF_PREFIX = 'rf_';
/** 30 天（§6.2） */
export const RF_TTL = 30 * 86400_000;

/**
 * 开一个新族（登录成功 / 首次换票）。
 */
export const start = ({ userId, sessionId = '', tv, ip = '', ua = '' }) =>
  store.createRefreshFamily({ userId, sessionId, tv, ttlMs: RF_TTL, ip, ua });

/**
 * 用一张 refresh 换新 access + 新 refresh（轮换）。
 *
 * 返回 `{ ok, access, refresh, user }` 或 `{ ok:false, code, message }`：
 *   · `E4012` —— 票已撤销 / 族已被撤销（复用检测触发过）；
 *   · `E4092` —— **复用**：这张票之前已经消费过一次（泄漏特征，整族撤销）；
 *   · `E4010` —— 没这票 / 过期 / 用户没了或被禁；
 *   · `E4093` —— tokenVersion 变了（改密码 / 改角色后旧族全部作废）。
 */
export function rotate(rawToken, { ip = '', ua = '' } = {}) {
  const row = store.getRefreshToken(rawToken);
  if (!row) return { ok: false, code: 'E4010', message: '刷新票无效或已过期' };
  if (row.revokedAt) return { ok: false, code: 'E4012', message: '刷新票已被撤销' };
  if (Date.parse(row.expiresAt) <= Date.now()) return { ok: false, code: 'E4010', message: '刷新票无效或已过期' };

  if (row.usedAt) {
    // **复用**：轮换后的旧票又来了。按 §6.2 撤整族 + 审计。
    const n = store.revokeRefreshFamily(row.familyId);
    try {
      store.add({
        at: new Date().toISOString(),
        kind: 'auth.refresh.reuse',
        actorKind: 'user',
        actorId: row.userId,
        action: 'POST /api/auth/refresh',
        resource: `family:${row.familyId}`,
        result: 'fail',
        reason: `E4092 复用检测：整族撤销（${n} 张）`,
        ip,
        ua,
      });
    } catch { /* 审计失败不拖垮判定 */ }
    return { ok: false, code: 'E4092', message: '检测到刷新票复用，整条换票链已撤销' };
  }

  const u = store.getUser(row.userId);
  if (!u || u.disabled) return { ok: false, code: 'E4010', message: '刷新票无效或已过期' };
  if ((u.tokenVersion ?? 1) !== row.tv) return { ok: false, code: 'E4093', message: '凭据已失效（密码或角色变更），请重新登录' };

  // 关联了会话的族：会话被踢 / 过期 → 族跟着死（§6.2 "会话未撤销"）
  if (row.sessionId) {
    const s = store.sessionByHash(row.sessionId);
    if (!s || s.revokedAt) return { ok: false, code: 'E4012', message: '所属会话已撤销' };
    if (s.absoluteExpiresAt && Date.parse(s.absoluteExpiresAt) <= Date.now()) {
      return { ok: false, code: 'E4012', message: '所属会话已到期' };
    }
  }

  store.markRefreshUsed(row.tokenHash);
  const next = store.appendRefreshToken({ familyId: row.familyId, userId: row.userId, sessionId: row.sessionId, tv: row.tv, ttlMs: RF_TTL, ip, ua });
  const access = store.issueAccessToken({
    subjectKind: 'user',
    subjectId: row.userId,
    kind: row.sessionId ? 'api' : 'cli',
    scopes: '',
    sessionId: row.sessionId,
    tv: row.tv,
    ttlMs: AT_TTL,
    ip,
    ua,
  });
  return { ok: true, access, refresh: next };
}
