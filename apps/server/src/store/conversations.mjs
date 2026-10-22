/* store/conversations.mjs —— 2026-10-22 由 store.mjs 按域拆出。SQL 只在 store/ 目录内。 */

import { db, newId, nowIso } from './db.mjs';
import { activeRun } from './runs.mjs';
import { getPersona, purgePersonaHistory } from './personas.mjs';
import { listGroups, listMembers, purgeDissolvedGroup } from './groups.mjs';
import { addMessage } from './messages.mjs';
import { createWorkflowRun } from './workflows.mjs';

export function setConversationSandbox(id, sandbox) {
  db.prepare('UPDATE conversations SET sandbox = ? WHERE id = ?').run(sandbox || null, id);
  return getConversation(id);
}

/**
 * 会话级模型覆盖 —— 和上面的 sandbox 是同一个模式。
 *
 * 场景：这个会话想临时换个模型试试，不想动员工的默认绑定（也不想改完忘了改回来）。
 * 有值 = 只在这个会话里生效，null = 跟随员工默认（或 CLI 自己的默认模型）。
 *
 * 为什么不用"员工详情页那一个绑定"解决：绑定是**长期**的，改它等于把这个人的默认改了。
 * 而"这一轮换个模型看看"是个**临时**决定，绑定表达不了。
 * 派活时取 `会话 ?? 员工`（每次派活重新读，所以改完下一轮就生效）。
 */

export function ensureExecConversation({ personaId, scope, title, projectId = null }) {
  const persona = getPersona(personaId);
  if (!persona) return null;
  const existing =
    db
      .prepare("SELECT * FROM conversations WHERE kind = 'exec' AND personaId = ? AND execScope = ?")
      .get(personaId, scope) ?? null;
  if (existing) {
    const t = title || existing.title;
    if (t !== existing.title || (projectId && projectId !== existing.projectId)) {
      db.prepare('UPDATE conversations SET title = ?, projectId = ?, updatedAt = ? WHERE id = ?')
        .run(t, projectId ?? existing.projectId, nowIso(), existing.id);
    }
    return getConversation(existing.id);
  }
  const ts = nowIso();
  const row = {
    id: newId('c'),
    title: title || '（工单）',
    personaId,
    projectId,
    execScope: scope,
  };
  db.prepare(
    `INSERT INTO conversations (id, title, personaId, sessionId, status, kind, projectId, execScope, createdAt, updatedAt)
     VALUES (?, ?, ?, NULL, '待跑', 'exec', ?, ?, ?, ?)`,
  ).run(row.id, row.title, row.personaId, row.projectId, row.execScope, ts, ts);
  return getConversation(row.id);
}

/** 这个员工手上正在跑几件（每人并发上限靠它） */

export function setConversationModel(id, model) {
  db.prepare('UPDATE conversations SET model = ? WHERE id = ?').run(model || null, id);
  return getConversation(id);
}


/**
 * 项目：**"在哪儿干活"的载体**。
 *
 * 原来只有 `personas.cwd` 一个字段 —— 六个员工全指着同一个目录，看着是对的，
 * 但一有第二个项目就会**安静地改错地方**。项目把"在哪儿干活"变成一个可命名、
 * 可复用、可写约定的实体：会话和流程都挂在项目上，派活时用项目的目录。
 *
 * extraRoots: JSON 数组，额外可读/可写的根目录（配合沙箱的 writable_roots）。
 * note: 这个项目的规矩（构建命令、不许动什么…），以后作为约定注入指令。
 */

export function ensureConversationForPersona(personaId) {
  const persona = getPersona(personaId);
  if (!persona) return null;

  const existing =
    db
      .prepare("SELECT * FROM conversations WHERE personaId = ? AND kind = 'direct' ORDER BY updatedAt DESC LIMIT 1")
      .get(personaId) ?? null;
  if (existing) return existing;

  return createConversation({ title: `和 ${persona.name}`, personaId });
}


export function listConversations() {
  return db
    .prepare(
      `SELECT c.*, p.name AS personaName, p.runtime AS runtime,
              (SELECT COUNT(*) FROM thread_members tm WHERE tm.threadId = c.id) AS memberCount,
              (SELECT COUNT(*) FROM messages m WHERE m.conversationId = c.id) AS messageCount,
              (SELECT m.text FROM messages m WHERE m.conversationId = c.id
                ORDER BY m.createdAt DESC, m.rowid DESC LIMIT 1) AS lastMessage
         FROM conversations c LEFT JOIN personas p ON p.id = c.personaId
        WHERE c.hiddenAt IS NULL
        ORDER BY c.updatedAt DESC`,
    )
    .all();
}


export function getConversation(id) {
  const row =
    db
      .prepare(
        `SELECT c.*, p.name AS personaName, p.instructions AS personaInstructions,
                p.runtime AS runtime, p.sandbox AS personaSandbox, p.cwd AS personaCwd,
                p.model AS personaModel, p.showThinking AS showThinking, p.rootDirs AS personaRootDirs,
                p.builtin AS personaBuiltin
           FROM conversations c LEFT JOIN personas p ON p.id = c.personaId
          WHERE c.id = ?`,
      )
      .get(id) ?? null;
  if (!row) return null;
  // 群才有成员表；1:1 的"成员"就是对面那个人（personaId/personaName 已经带出来了）
  row.members = row.kind === 'group' ? listMembers(id) : [];
  return row;
}

/* ------------------------------------------------------------------ 群聊 */

/** 当前用户（还没有账号体系，先当成一个固定的人） */

export const LOCAL_USER = { id: 'local-user', name: '我' };

/**
 * 建群。
 * - ownerUserId：创建人（人）。解散群、改名这类事将来归他。
 * - assistantPersonaId：群助手（agent）。没人被 @ 时由他接话。
 * - personaId 写空串：**群不该带 personaId**。以前写成群助手，导致
 *   「点员工开对话」把群查了出来（已修，见 ensureConversationForPersona）。
 */

export function createConversation({ title, personaId }) {
  const ts = nowIso();
  const row = { id: newId('c'), title, personaId, sessionId: null, status: '待跑', createdAt: ts, updatedAt: ts };
  db.prepare(
    `INSERT INTO conversations (id, title, personaId, sessionId, status, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.title, row.personaId, row.sessionId, row.status, row.createdAt, row.updatedAt);
  return row;
}


export function setConversationSession(id, sessionId) {
  db.prepare('UPDATE conversations SET sessionId = ?, updatedAt = ? WHERE id = ?').run(sessionId, nowIso(), id);
}


export function setConversationStatus(id, status) {
  db.prepare('UPDATE conversations SET status = ?, updatedAt = ? WHERE id = ?').run(status, nowIso(), id);
}


export function renameConversation(id, title) {
  db.prepare('UPDATE conversations SET title = ?, updatedAt = ? WHERE id = ?').run(title, nowIso(), id);
}

/* --------------------------------------------------------------- messages */

/**
 * 按 rowid 找一条消息。
 *
 * 用在哪：运行结束时写他的回话，要把回话挂到**触发他的那条评论所在的议题**下。
 * 运行记录里存的就是触发消息的 rowid（`run.watermark`），所以按它反查最省事 ——
 * 不用给 runs 表加列，也不用猜"上一条 user 消息是哪条"。
 */

export function hideConversation(id) {
  const conv = db.prepare('SELECT id, kind, groupId FROM conversations WHERE id = ?').get(id) ?? null;
  if (!conv) return false;
  /*
   * 群会话「不显示」= **把这个群的所有会话一起收起来**（2026-10-20 拆表后必须这样）。
   *
   * 只写这一段的话，消息列表（一个群一行、取这个群最新那段）会立刻把上一段顶上来 ——
   * 用户看到的是"点了不显示，群还在列表里"，像是没生效。
   * 而群的语义本来就是"这个群先别占我的列表位置"，不是"藏掉某一次对话"。
   *
   * 之后群里再来新消息 → addMessage 清掉那一段的 hiddenAt → 整行自己回来。
   */
  const ts = nowIso();
  if (conv.kind === 'group') {
    const gid = conv.groupId || conv.id;
    return db.prepare("UPDATE conversations SET hiddenAt = ? WHERE groupId = ? AND kind = 'group'").run(ts, gid)
      .changes > 0;
  }
  return db.prepare('UPDATE conversations SET hiddenAt = ? WHERE id = ?').run(ts, id).changes > 0;
}

/**
 * 物理抹掉**一段**会话（连同消息、成员快照、运行记录、外部引用）。
 *
 * **不管事务** —— 调用方负责 BEGIN/COMMIT：删群要在一个事务里抹掉好几段，
 * 每次进来各开一个事务的话，中间失败就会留下"删了一半"的群。
 *
 * 为什么先摘引用再删：`workflow_steps` / `workflow_tasks` / `workflow_runs` / `project_tasks`
 * 引了这段会话，但**那些行必须留着**（流程办理的结论、看板上的卡都还要看），
 * 只是不该再指向一段已经不存在的会话。硬删它们就是"删别人的东西"。
 *
 * ⚠️ 顺序陷阱：`run_events` 只能靠 `runId IN (SELECT … FROM runs …)` 定位，
 *    所以**必须排在删 `runs` 之前**。写反了 `run_events` 一行都删不掉，而且**不报错** ——
 *    这是整套 SQL 里最容易漏测的一条。
 */

export function purgeConversation(id) {
  // ① 先摘外部引用：这些行要留着，只是别再指向一段不存在的会话
  db.prepare('UPDATE workflow_steps SET conversationId = NULL WHERE conversationId = ?').run(id);
  db.prepare('UPDATE workflow_tasks SET conversationId = NULL WHERE conversationId = ?').run(id);
  // 实测恒为 NULL（createWorkflowRun 从不传 threadId），仍然写一条防御
  db.prepare('UPDATE workflow_runs SET threadId = NULL WHERE threadId = ?').run(id);
  db.prepare('UPDATE project_tasks SET conversationId = NULL WHERE conversationId = ?').run(id);

  // ② 运行侧：run_events 靠 runId 子查询，**必须在删 runs 之前**
  db.prepare('DELETE FROM run_events WHERE runId IN (SELECT id FROM runs WHERE conversationId = ?)').run(id);
  db.prepare('DELETE FROM runs WHERE conversationId = ?').run(id);

  // ③ 会话自己的从属行
  db.prepare('DELETE FROM messages WHERE conversationId = ?').run(id);
  db.prepare('DELETE FROM member_sessions WHERE threadId = ?').run(id);
  db.prepare('DELETE FROM thread_members WHERE threadId = ?').run(id);

  // ④ 最后删会话本身
  return db.prepare('DELETE FROM conversations WHERE id = ?').run(id).changes;
}

/**
 * 清掉一个**已解散**的群：所有段的消息、群行、成员名单一起抹（不可恢复）。
 *
 * 2026-10-20 用户定的收尾设计：解散后的群行代表的是"这个群的**全部历史**"，
 * 右键「删除并清空聊天记录」删的就是这一坨 —— 一段一段删没有意义（不会再有新段，
 * 群也不在通讯录里，删到最后一段留下的空群没有任何入口）。
 *
 * 只接受 `dissolvedAt` 非空的群（活群从 `deleteConversation` 的"删一段"路子走）；
 * 有任何一段还在跑就拒绝（父级还在干活就先别拆房子）。
 */

export function deleteConversation(id) {
  // ⚠️ dissolvedAt / personaId 必须一起取：它们决定"删这一段"还是"整档清空"（2026-10-20 真踩过：
  //    SELECT 里漏了 dissolvedAt → 分派分支永远不生效，"群行还在"的锅查了好一阵）
  const conv = db.prepare('SELECT id, kind, groupId, personaId, dissolvedAt FROM conversations WHERE id = ?').get(id) ?? null;
  if (!conv) return { ok: false, why: 'not-found', runId: null, changes: 0 };
  /*
   * 2026-10-20 用户要求：**群聊也能删**（和单聊同一套右键菜单）。
   * 仍然拒绝工单会话（`exec`）：那是流程 / 任务卡自动建的记录，
   * 从"消息"里删掉会让流程那头的追溯断线 —— 要清理请去流程/任务卡里删任务。
   */
  if (conv.kind !== 'direct' && conv.kind !== 'group') {
    return { ok: false, why: 'not-deletable', runId: null, changes: 0 };
  }
  // 已解散的群：删的是"这个群的全部历史"（见 purgeDissolvedGroup 的注释）
  if (conv.kind === 'group' && conv.dissolvedAt) {
    return purgeDissolvedGroup(conv.groupId || conv.id);
  }
  // 员工已删的单聊：删的是"这个人的全部历史"（见 purgePersonaHistory 的注释）
  if (conv.kind === 'direct' && conv.personaId && !db.prepare('SELECT id FROM personas WHERE id = ?').get(conv.personaId)) {
    return purgePersonaHistory(conv.personaId);
  }

  // 还在跑的不能删：静默终止一个正在干活的 agent 比让用户多点一步更糟（PRD 规则 7）
  const running = activeRun(id);
  if (running) return { ok: false, why: 'running', runId: running.id, changes: 0 };

  // `node:sqlite` 的 DatabaseSync **没有** db.transaction()，所以手写 BEGIN/COMMIT
  let changes = 0;
  db.exec('BEGIN');
  try {
    changes = purgeConversation(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { ok: true, why: null, runId: null, changes };
}

/**
 * 解散一个群（2026-10-20 起按**群**解散，参数是 groupId）。
 *
 * **不抹聊天记录** —— 跟这个仓库里其它破坏性操作同一个原则（删员工、删流程都不动别人的记录）。
 * 做的事：删群成员名单、给**每一段会话**清掉成员快照与会话状态、群本身打上 dissolvedAt。
 *
 * ⚠️ **不再把会话设成「不显示」**（2026-10-20 用户定：解散后消息仍然留在消息列表里，只读）。
 * 以前这里写 `hiddenAt = ts`，解散即从所有界面消失 —— 记录在库里却没有任何入口，
 * 等于"解散 = 删档"。现在会话留在原处（原本就被「不显示」的也不去动它），
 * 前端按 `dissolvedAt` 画成只读：输入框置灰、头部标「已解散」。
 * 通讯录的群列表（`listGroups`）仍然只看未解散的群 —— 那边是"还能用的群"，解散的不该占位。
 *
 * 为什么成员关系必须清（不是只藏起来）：
 *   · 「没 @ 就找群助手」这条规则靠 thread_members 撑着，人都不在了这规则就该失效；
 *   · 不清的话，点进老会话还能 @ 人派活 —— 那是个已经解散的群。
 *   · 群助手一并置空：否则删那个数字员工时会被一句"他是群「X」的群助手"挡住。
 *   · 后端的发消息接口也据此拒绝（路由层看 `dissolvedAt` 回 E2049）。
 */

export function listHiddenConversations() {
  return db
    .prepare(
      // 跟 listConversations 一样带上最后一句：聊天记录抽屉要靠它做预览，
      // 少了它隐藏会话在抽屉里就只剩"标题 / 还没聊过"，跟列表里的样子对不上
      `SELECT c.*, p.name AS personaName,
              (SELECT COUNT(*) FROM messages m WHERE m.conversationId = c.id) AS messageCount,
              (SELECT COUNT(*) FROM thread_members tm WHERE tm.threadId = c.id) AS memberCount,
              (SELECT m.text FROM messages m WHERE m.conversationId = c.id
                ORDER BY m.createdAt DESC, m.rowid DESC LIMIT 1) AS lastMessage
         FROM conversations c LEFT JOIN personas p ON p.id = c.personaId
        WHERE c.hiddenAt IS NOT NULL
        ORDER BY c.updatedAt DESC`,
    )
    .all()
    .map((c) => ({ ...c, hidden: true }));
}

/* ------------------------------------------------- 每个成员自己的会话状态 */

