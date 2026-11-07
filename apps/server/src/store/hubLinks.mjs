/*
 * store/hubLinks.mjs —— **中枢账号 ↔ 本机用户** 的本地授权表（2026-11-06）。
 *
 * 这张表是「认证在中枢、授权在主机」那条规则的落地物，不要和 `user_sessions` 混：
 *
 *   · 中枢的票据只证明「这个人是谁」（`sub` = 中枢账号 id）；
 *   · 能不能进**这台机器**，由这张表回答 —— 有行、且行指向的本地用户没被禁用，才放行。
 *
 * 为什么必须多这一层：中枢是托管在 Cloudflare 上的第三方。它的签发私钥一旦泄露，
 * 攻击者能伪造任意账号的票据；如果主机只验票不看本地表，那就是「私钥泄露 = 全部机器
 * 被接管」。有了这张表，伪造的票最多撞到一个**这台机器不认识的 sub**，403 挡在门外。
 *
 * 归属口径：一个中枢账号只能绑一个本地用户，一个本地用户可以绑多个中枢账号
 * （GitHub 小号、以后再加 Gitee 之类，都是同一个人）。
 *
 * SQL 只出现在 store/ 目录里（docs/形态决策.md §十二）。
 */

import { db, nowIso } from './db.mjs';

db.exec(`
  CREATE TABLE IF NOT EXISTS hub_links (
    accountId   TEXT PRIMARY KEY,
    userId      TEXT NOT NULL,
    login       TEXT,
    createdAt   TEXT NOT NULL,
    lastEnterAt TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_hub_links_user ON hub_links (userId);
`);

/**
 * 认一个中枢账号（幂等：同一个账号再来一次只更新 login，不改归属）。
 * @param {{ accountId: string, userId: string, login?: string|null }} input
 */
export function linkHubAccount({ accountId, userId, login = null }) {
  const id = String(accountId || '').trim();
  if (!id || !userId) return null;
  db.prepare(
    `INSERT INTO hub_links (accountId, userId, login, createdAt) VALUES (?, ?, ?, ?)
     ON CONFLICT(accountId) DO UPDATE SET login = COALESCE(excluded.login, hub_links.login)`,
  ).run(id, String(userId), login ? String(login) : null, nowIso());
  return hubLinkOf(id);
}

/** @param {string} accountId */
export function hubLinkOf(accountId) {
  return db.prepare('SELECT * FROM hub_links WHERE accountId = ?').get(String(accountId ?? '')) ?? null;
}

/** 这台机器认识的**全部**中枢账号（「设置 → 连接」列表用） */
export function listHubLinks() {
  return db.prepare('SELECT * FROM hub_links ORDER BY createdAt ASC').all();
}

/** @param {string} accountId */
export function removeHubLink(accountId) {
  const r = db.prepare('DELETE FROM hub_links WHERE accountId = ?').run(String(accountId ?? ''));
  return r.changes > 0;
}

/** 进门时顺手记一笔「最近一次从哪儿进来」—— 失败不影响进门 */
export function touchHubLink(accountId) {
  try {
    db.prepare('UPDATE hub_links SET lastEnterAt = ? WHERE accountId = ?').run(nowIso(), String(accountId ?? ''));
  } catch { /* 记不上就算了，这不是安全判定的一部分 */ }
}

/** 这张表里有没有行 —— 「首次认领」那条路只在**空表**时成立 */
export function countHubLinks() {
  return db.prepare('SELECT COUNT(*) AS n FROM hub_links').get()?.n ?? 0;
}
