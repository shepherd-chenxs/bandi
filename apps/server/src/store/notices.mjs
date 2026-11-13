/* store/notices.mjs —— 信箱（2026-11-11 用户拍板：左栏一级「信箱」）。
 *
 * 它是**平台事实的账本**，不是某个数字员工的聊天记录：建卡失败这类机器侧事件先原样落库
 * （错误码 / runId / 员工 / 会话 / 项目都在），人点开信箱能看到"哪一轮、什么错、重试了几次"。
 * 不让崔老三之类转述，就是因为转述会改写错误码和数字；他以后想做摘要，也只能读这张表。
 *
 * 去重：同一轮 + 同一个错误码重试多次只记一条、`count` 累加、未读重新点亮
 * （否则 3 次重试 = 3 条红点，很快就没人看了）。
 */
import { db, newId, nowIso } from './db.mjs';

const SEVERITIES = new Set(['info', 'warn', 'blocking']);

/** 记一条通知。`dedupeKey` 有值时命中已有条目（次数+1、重新标未读） */
export function addNotice({
  kind,
  severity = 'warn',
  code = null,
  title,
  detail = '',
  personaId = null,
  conversationId = null,
  projectId = null,
  runId = null,
  dedupeKey = null,
}) {
  const ts = nowIso();
  const sev = SEVERITIES.has(severity) ? severity : 'warn';
  const key = dedupeKey ? String(dedupeKey) : null;
  if (key) {
    const hit = db.prepare('SELECT id FROM notices WHERE dedupeKey = ? ORDER BY createdAt DESC LIMIT 1').get(key);
    if (hit) {
      db.prepare(
        `UPDATE notices SET count = count + 1, updatedAt = ?, readAt = NULL, severity = ?, code = ?, title = ?, detail = ?,
            personaId = COALESCE(?, personaId), conversationId = COALESCE(?, conversationId),
            projectId = COALESCE(?, projectId), runId = COALESCE(?, runId)
          WHERE id = ?`,
      ).run(ts, sev, code, String(title ?? ''), String(detail ?? ''), personaId, conversationId, projectId, runId, hit.id);
      return getNotice(hit.id);
    }
  }
  const id = newId('nt');
  db.prepare(
    `INSERT INTO notices (id, kind, severity, code, title, detail, personaId, conversationId, projectId, runId, dedupeKey, count, readAt, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
  ).run(id, String(kind ?? 'notice'), sev, code, String(title ?? ''), String(detail ?? ''), personaId, conversationId, projectId, runId, key, ts, ts);
  return getNotice(id);
}

export function getNotice(id) {
  return db
    .prepare('SELECT n.*, p.name AS personaName FROM notices n LEFT JOIN personas p ON p.id = n.personaId WHERE n.id = ?')
    .get(id) ?? null;
}

/** 信箱列表：新的在前（按更新时间 —— 同一件事重试了，会冒到最上面）；带上员工名给人看 */
export function listNotices({ limit = 100 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
  return db
    .prepare('SELECT n.*, p.name AS personaName FROM notices n LEFT JOIN personas p ON p.id = n.personaId ORDER BY n.updatedAt DESC LIMIT ?')
    .all(n);
}

/** 未读数（左栏徽标） */
export function countUnreadNotices() {
  return Number(db.prepare('SELECT COUNT(*) AS c FROM notices WHERE readAt IS NULL').get()?.c ?? 0);
}

/** 标记一条已读；返回剩余未读数 */
export function markNoticeRead(id) {
  db.prepare('UPDATE notices SET readAt = ?, updatedAt = updatedAt WHERE id = ? AND readAt IS NULL').run(nowIso(), id);
  return countUnreadNotices();
}

/** 全部已读；返回剩余未读数（应为 0） */
export function markAllNoticesRead() {
  db.prepare('UPDATE notices SET readAt = ? WHERE readAt IS NULL').run(nowIso());
  return countUnreadNotices();
}

/**
 * 删除通知（2026-11-12 用户："加删除功能，支持批量删除"）。
 * `ids` 数组一条也行多条也行；`all: true` 清空整箱。返回 { removed, unread }。
 * 删了就是删了（账本条目，不进回收站）—— 确认动作在前端做，这里不拦。
 */
export function deleteNotices({ ids = null, all = false } = {}) {
  if (all === true) {
    const removed = db.prepare('DELETE FROM notices').run().changes;
    return { removed, unread: countUnreadNotices() };
  }
  const list = (Array.isArray(ids) ? ids : []).map((v) => String(v ?? '')).filter(Boolean);
  if (!list.length) return { removed: 0, unread: countUnreadNotices() };
  const del = db.prepare('DELETE FROM notices WHERE id = ?');
  let removed = 0;
  for (const id of list) removed += del.run(id).changes;
  return { removed, unread: countUnreadNotices() };
}
