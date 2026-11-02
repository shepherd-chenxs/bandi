/**
 * `access_tokens` / `refresh_tokens` 两张表（IAM §12 Phase 3）—— SQL 只在 store/。
 *
 * 设计口径（§6.2 / §7.1，已拍板）：
 *   · access token = 不透明 `at_` + 32B，只存 sha256，10–15 分钟，无结构不签名（JWT 不做）；
 *   · refresh token = 不透明 32B，30 天，**每次刷新轮换**；
 *     旧 refresh 再用 = 复用攻击 → 撤销整个 family + 审计（E4092 在 security/refresh.mjs 抛）；
 *   · 权限不入 token：PDP 每请求查库，票上只有"我是谁 + 签发水位 tv"。
 */
import { db, ensureColumn } from './db.mjs';
import crypto from 'node:crypto';

const sha256 = (s) => crypto.createHash('sha256').update(String(s ?? '')).digest('hex');

db.exec(`
  CREATE TABLE IF NOT EXISTS access_tokens (
    tokenHash   TEXT PRIMARY KEY,
    subjectKind TEXT NOT NULL,             -- user | machine
    subjectId   TEXT NOT NULL,             -- userId 或 machineId（root / 节点 / 手机 / 分公司）
    kind        TEXT NOT NULL,             -- cli | api | node | device | branch
    scopes      TEXT NOT NULL DEFAULT '',  -- 机器票必填（逗号分隔，'*' = break-glass 全量）；人类票为空
    sessionId   TEXT NOT NULL DEFAULT '',  -- 人类票可关联会话；机器票为空
    tv          INTEGER NOT NULL DEFAULT 0,-- 签发时的 tokenVersion（人类票必填；machine 恒 0）
    createdAt   TEXT NOT NULL,
    expiresAt   TEXT NOT NULL,
    revokedAt   TEXT,
    ip          TEXT NOT NULL DEFAULT '',
    ua          TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS ix_at_subject ON access_tokens (subjectKind, subjectId);
  CREATE TABLE IF NOT EXISTS refresh_tokens (
    tokenHash  TEXT PRIMARY KEY,
    familyId   TEXT NOT NULL,
    sessionId  TEXT NOT NULL DEFAULT '',
    userId     TEXT NOT NULL,
    tv         INTEGER NOT NULL DEFAULT 0,
    createdAt  TEXT NOT NULL,
    expiresAt  TEXT NOT NULL,
    usedAt     TEXT,                       -- 轮换后留痕：非空 = 这张已消费
    revokedAt  TEXT,
    ip         TEXT NOT NULL DEFAULT '',
    ua         TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS ix_rt_family ON refresh_tokens (familyId);
`);
ensureColumn('access_tokens', 'sessionId', "sessionId TEXT NOT NULL DEFAULT ''");

const iso = (t) => new Date(t).toISOString();

/* ------------------------------------------------ access（at_） */

/**
 * 发一张短票。`scopes` 只有机器票用（`'*'` = break-glass 全量，见 §6.4 根令牌换票）；
 * 人类票传空串 —— 权限永远在 PDP 查，票上不带。
 */
export function issueAccessToken({ subjectKind, subjectId, kind, scopes = '', sessionId = '', tv = 0, ttlMs, ip = '', ua = '' }) {
  const token = `at_${crypto.randomBytes(32).toString('base64url')}`;
  const now = Date.now();
  db.prepare(
    'INSERT INTO access_tokens (tokenHash, subjectKind, subjectId, kind, scopes, sessionId, tv, createdAt, expiresAt, ip, ua) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(sha256(token), subjectKind, String(subjectId), String(kind), scopes, sessionId, tv | 0, iso(now), iso(now + ttlMs), ip, ua);
  return { token, expiresAt: iso(now + ttlMs), expiresIn: Math.round(ttlMs / 1000) };
}

/**
 * 验一张短票。**只判票自身**（存在 / 没撤 / 没过期 / tv 没变）；
 * "这个身份能不能干这件事"是 PDP 的事（§7.1 表格第三行）。
 * 返回行或 null；撤销即删语义用 revokedAt（保留行可审计）。
 */
export function verifyAccessToken(token) {
  const t = String(token ?? '');
  if (!t.startsWith('at_')) return null;
  const row = db.prepare('SELECT * FROM access_tokens WHERE tokenHash = ?').get(sha256(t));
  if (!row || row.revokedAt || Date.parse(row.expiresAt) <= Date.now()) return null;
  // 人类票对撤销水位：改密码 / 改角色之后，手里这张短票立即作废（§12 tv 口径）
  if (row.subjectKind === 'user') {
    const u = db.prepare('SELECT tokenVersion, disabled FROM users WHERE id = ?').get(row.subjectId);
    if (!u || u.disabled) return null;
    if ((u.tokenVersion ?? 1) !== row.tv) return null;
  }
  return row;
}

/** 撤一张短票（幂等）。返回是否真撤了一张活票。 */
export function revokeAccessToken(token) {
  if (!String(token ?? '').startsWith('at_')) return false;
  const r = db.prepare('UPDATE access_tokens SET revokedAt = ? WHERE tokenHash = ? AND revokedAt IS NULL').run(new Date().toISOString(), sha256(token));
  return r.changes > 0;
}

/** 按主体撤全部（改密码时用会话全踢即可；这里给机器凭据吊销留口）。 */
export function revokeAccessTokensOf(subjectKind, subjectId) {
  return db.prepare('UPDATE access_tokens SET revokedAt = ? WHERE subjectKind = ? AND subjectId = ? AND revokedAt IS NULL')
    .run(new Date().toISOString(), subjectKind, String(subjectId)).changes;
}

/** 过期/撤销满 1 天的行清掉（启动时跑一次；表本来就是短命的） */
export function pruneAccessTokens() {
  const cutoff = iso(Date.now() - 86400_000);
  return db.prepare('DELETE FROM access_tokens WHERE expiresAt <= ? OR (revokedAt IS NOT NULL AND revokedAt <= ?)').run(cutoff, cutoff).changes;
}

/* ------------------------------------------------ refresh（rf_） */

/**
 * 开一个刷新族。一个"族" = 一次换票链（登录 / refresh 都可能开新族）；
 * 族里任何一张旧票被复用 → 整族撤销（refresh.mjs 的 rotate 负责）。
 */
export function createRefreshFamily({ userId, sessionId = '', tv = 0, ttlMs, ip = '', ua = '' }) {
  const familyId = crypto.randomUUID();
  const token = `rf_${crypto.randomBytes(32).toString('base64url')}`;
  const now = Date.now();
  db.prepare('INSERT INTO refresh_tokens (tokenHash, familyId, sessionId, userId, tv, createdAt, expiresAt, ip, ua) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(sha256(token), familyId, sessionId, String(userId), tv | 0, iso(now), iso(now + ttlMs), ip, ua);
  return { familyId, token, expiresAt: iso(now + ttlMs) };
}

/** 族里追加一张新 refresh（轮换用）。 */
export function appendRefreshToken({ familyId, userId, sessionId = '', tv = 0, ttlMs, ip = '', ua = '' }) {
  const token = `rf_${crypto.randomBytes(32).toString('base64url')}`;
  const now = Date.now();
  db.prepare('INSERT INTO refresh_tokens (tokenHash, familyId, sessionId, userId, tv, createdAt, expiresAt, ip, ua) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(sha256(token), String(familyId), sessionId, String(userId), tv | 0, iso(now), iso(now + ttlMs), ip, ua);
  return { token, expiresAt: iso(now + ttlMs) };
}

/**
 * 取一张 refresh 的行。`getByHash` 不判状态 —— 判状态是 security/refresh.mjs 的事
 * （复用检测要把"已消费""已撤销"分开处理，store 只管取）。
 */
export function getRefreshToken(token) {
  const t = String(token ?? '');
  if (!t.startsWith('rf_')) return null;
  return db.prepare('SELECT * FROM refresh_tokens WHERE tokenHash = ?').get(sha256(t)) ?? null;
}

/** 标记已消费（轮换）。 */
export function markRefreshUsed(tokenHash) {
  db.prepare('UPDATE refresh_tokens SET usedAt = ? WHERE tokenHash = ?').run(new Date().toISOString(), tokenHash);
}

/** 撤整族（复用检测 / revoke 接口）。返回撤掉的行数。 */
export function revokeRefreshFamily(familyId) {
  return db.prepare('UPDATE refresh_tokens SET revokedAt = ? WHERE familyId = ? AND revokedAt IS NULL')
    .run(new Date().toISOString(), String(familyId)).changes;
}

/** 撤一个用户的全部刷新族（改密码 / 全踢）。 */
export function revokeRefreshFamiliesOfUser(userId) {
  return db.prepare('UPDATE refresh_tokens SET revokedAt = ? WHERE userId = ? AND revokedAt IS NULL')
    .run(new Date().toISOString(), String(userId)).changes;
}

export function pruneRefreshTokens() {
  const cutoff = iso(Date.now() - 86400_000);
  return db.prepare('DELETE FROM refresh_tokens WHERE expiresAt <= ? OR (revokedAt IS NOT NULL AND revokedAt <= ?)').run(cutoff, cutoff).changes;
}

/** 测试用：拿哈希（smoke 直接开库也行，这里省得各处重复 sha256） */
export const hashOf = sha256;
