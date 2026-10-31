/* store/messages.mjs —— 2026-10-22 由 store.mjs 按域拆出。SQL 只在 store/ 目录内。 */

import { db, ensureColumn, newId, nowIso } from './db.mjs';
import { createConversation, listHiddenConversations } from './conversations.mjs';
import { emitConv } from '../events.mjs';

/*
 * **说话的是哪个人**（2026-10-31 用户概念落地）。真人经浏览器发的消息带 `senderUserId`
 * （登录用户是他自己；回环操作员是第一个用户，见 auth.actorUser）；员工/飞书/回执是 null。
 * null ≠ 删除：用户删号后消息还留着（LEFT JOIN 出来 senderUserName 为空，界面回落"我"）。
 */
ensureColumn('messages', 'senderUserId', 'senderUserId TEXT');

export function getMessageByRowid(conversationId, rowid) {
  if (!rowid) return null;
  return (
    db
      .prepare('SELECT * FROM messages WHERE conversationId = ? AND rowid = ?')
      .get(conversationId, rowid) ?? null
  );
}


/** 真人署名带出来（用户删号后 name 为空 —— 界面回落"我"，不报错） */
const SENDER_JOIN = 'LEFT JOIN users u ON u.id = m.senderUserId';

export function listMessages(conversationId) {  return db
    .prepare(
      `SELECT m.*, p.name AS personaName, u.name AS senderUserName
         FROM messages m LEFT JOIN personas p ON p.id = m.personaId ${SENDER_JOIN}
        WHERE m.conversationId = ? ORDER BY m.createdAt, m.rowid`,
    )
    .all(conversationId)
    .map(parseAtts);
}

/**
 * 某一步流程的往来消息（按 taskId 归属，2026-10-26 起派活都带这个标记）。
 * 给 `viewTask`（apps/server/src/workflows.mjs）用：一个任务一次点查，
 * 别把**整个会话**的消息（含正文大字段）捞出来再在 JS 里筛掉 99%。
 */
export function listMessagesByTask(taskId) {
  return db
    .prepare(
      `SELECT m.*, p.name AS personaName, u.name AS senderUserName
         FROM messages m LEFT JOIN personas p ON p.id = m.personaId ${SENDER_JOIN}
        WHERE m.taskId = ? ORDER BY m.createdAt, m.rowid`,
    )
    .all(taskId)
    .map(parseAtts);
}

/**
 * 水位线之后的消息 —— 群聊里给某个成员注入上下文用。
 * rowid 是 SQLite 的隐式列，拿来当游标最省事（不受时间戳并列影响）。
 */

export function listMessagesSince(conversationId, afterRowid, excludeMessageId = null) {
  return db
    .prepare(
      `SELECT m.rowid AS rid, m.*, p.name AS personaName, u.name AS senderUserName
         FROM messages m LEFT JOIN personas p ON p.id = m.personaId ${SENDER_JOIN}
        WHERE m.conversationId = ? AND m.rowid > ? ORDER BY m.rowid`,
    )
    .all(conversationId, afterRowid)
    .map(parseAtts)
    .filter((m) => m.id !== excludeMessageId);
}

/** 库里的 atts / meta 是 JSON 字符串，出来给调用方的是对象（坏数据当没有，别炸整页） */
function parseAtts(m) {
  if (m.atts) {
    try { m.atts = JSON.parse(m.atts); } catch { m.atts = null; }
  }
  if (m.meta) {
    try { m.meta = JSON.parse(m.meta); } catch { m.meta = null; }
  }
  return m;
}


export function addMessage({ conversationId, runId = null, role, text, personaId = null, taskId = null, parentId = null, note = false, atts = null, meta = null, senderUserId = null }) {
  const row = { id: newId('m'), conversationId, runId, role, text, personaId, taskId, parentId, note: note ? 1 : 0, createdAt: nowIso(), atts: atts?.length ? JSON.stringify(atts) : null, meta: meta ? JSON.stringify(meta) : null, senderUserId };
  db.prepare(
    'INSERT INTO messages (id, conversationId, runId, role, text, personaId, taskId, parentId, note, atts, meta, senderUserId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    row.id,
    row.conversationId,
    row.runId,
    row.role,
    row.text,
    row.personaId,
    row.taskId,
    row.parentId,
    row.note,
    row.atts,
    row.meta,
    row.senderUserId,
    row.createdAt,
  );
  // 说话就把它从"已从列表移除"里恢复 —— 否则会出现"我发了消息，列表里却没有"
  db.prepare('UPDATE conversations SET updatedAt = ?, hiddenAt = NULL WHERE id = ?').run(row.createdAt, conversationId);
  /*
   * 首条用户消息顺手把默认标题「和 XX」换成这句话的前 20 字（2026-10-20）。
   *
   * 为什么要动标题：一段会话就是一段活，而「聊天记录」里如果全是清一色的
   * 「和 张三」，用户根本分不清哪段是哪段（PRD P1-1）。
   *
   * 三个条件缺一不可：
   *   ① role === 'user' —— 助手说的话不能拿来当标题；
   *   ② 这条是该会话的**第一条**用户消息（count === 1，插入已在上方完成）——
   *      否则每说一句标题就变一次，列表会跟着跳；
   *   ③ 现有标题仍以「和 」开头（= 还是 `createConversation` 给的默认值）——
   *      exec / 群 / 定时任务那种**有正经名字**的会话不许被覆盖。
   */
  if (role === 'user') {
    const isFirst = db
      .prepare("SELECT COUNT(*) AS c FROM messages WHERE conversationId = ? AND role = 'user'")
      .get(conversationId).c === 1;
    if (isFirst) {
      const conv = db.prepare('SELECT title FROM conversations WHERE id = ?').get(conversationId);
      const title = String(conv?.title ?? '');
      if (title.startsWith('和 ')) {
        const brief = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 20);
        // 空消息（纯空白）不改：改了就是个空标题，比「和 张三」还糟
        if (brief) db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(brief, conversationId);
      }
    }
  }
  row.rowid = db.prepare('SELECT rowid AS rid FROM messages WHERE id = ?').get(row.id).rid;
  // 消息落库是**必经点**：谁往哪个会话说了话，挂着的浏览器立刻知道（见 events.mjs）
  emitConv(conversationId);
  return row;
}

/**
 * 「不显示」：从消息列表收起来，**但不删任何东西**。
 *
 * 2026-10-20 改了语义（用户要求去掉会话归档）：
 *   · 正常员工的会话 → 只是不在列表占行，**聊天记录里照样看得到**（走 `listHiddenConversations`）；
 *   · 已删除员工的会话 → 右键菜单上叫「归档」，同样只写这个字段，但那个人已经没有聊天记录入口了，
 *     所以界面上等于彻底收走（数据仍留在库里）。
 * 之后在这里再说一句话，它会自己回到列表（见 addMessage 里清 hiddenAt 那一行）。
 */
