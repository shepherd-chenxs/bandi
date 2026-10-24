/* store/groups.mjs —— 2026-10-22 由 store.mjs 按域拆出。SQL 只在 store/ 目录内。 */

import { db, newId, nowIso } from './db.mjs';
import { LOCAL_USER, getConversation, hideConversation, listConversations, purgeConversation } from './conversations.mjs';
import { activeRun } from './runs.mjs';
import { deletePersona, getPersona } from './personas.mjs';

export function groupsWhereAssistant(personaId) {
  // 群助手是**群级**属性（2026-10-20 起 groups 表）—— 别再按 conversations 查，
  // 一个群现在有多段会话，按会话查会返回一排重复的"群"。
  return db
    .prepare("SELECT id, title FROM groups WHERE assistantPersonaId = ? AND dissolvedAt IS NULL")
    .all(personaId);
}

/**
 * 把某个员工钉成「内置」（不可删）。
 *
 * 只有 seed 用（`secretary.mjs`），**没有对应的 HTTP 接口** —— 内置与否是出厂属性，
 * 不是用户在界面上能拨的开关。
 */

export function createGroup({ title, assistantPersonaId, memberIds = [] }) {
  const ts = nowIso();
  const groupId = newId('g');
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO groups (id, title, assistantPersonaId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)')
      .run(groupId, title, assistantPersonaId, ts, ts);
    const ins = db.prepare('INSERT OR IGNORE INTO group_members (groupId, personaId, joinedAt) VALUES (?, ?, ?)');
    for (const pid of new Set([assistantPersonaId, ...memberIds].filter(Boolean))) ins.run(groupId, pid, ts);
    const conv = insertGroupSession(groupId, { title, assistantPersonaId });
    db.exec('COMMIT');
    // 返回第一段会话：前端拿到它直接打开（跟以前"建群就进群会话"的体感一致）
    return conv;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 群的身份行（groups）+ 成员名单。群名/群助手都在这一行上，不属于任何一段会话。 */

export function getGroup(id) {
  const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(id) ?? null;
  if (!g) return null;
  g.members = listGroupMembers(id);
  return g;
}

/** 群成员（群级真源；会话里的 thread_members 是建会话那一刻的快照） */

export function listGroupMembers(groupId) {
  return db
    .prepare(
      `SELECT gm.personaId, gm.joinedAt, p.name, p.runtime, p.sandbox, p.cwd, p.model, p.instructions, p.rootDirs,
              p.builtin
         FROM group_members gm JOIN personas p ON p.id = gm.personaId
        WHERE gm.groupId = ? ORDER BY gm.joinedAt, p.name`,
    )
    .all(groupId);
}

/** 这个群下的所有会话（新的在前）—— 聊天记录抽屉用它 */

export function listGroupSessions(groupId) {
  return db
    .prepare('SELECT * FROM conversations WHERE groupId = ? ORDER BY updatedAt DESC')
    .all(groupId);
}

/**
 * 通讯录的群列表：**读 `groups` 表本身**，不从会话推（2026-10-20 用户报「通讯录里群也没了」）。
 *
 * 以前通讯录是按 `conversations` 里 `kind='group'` 的行去重出来的，于是
 * 「这个群的会话被删光」= 群在通讯录里凭空消失 —— 而群是**容器**（有名字、成员、群助手），
 * 容器不该因为片段删光就没了。现在零段的群照样在通讯录里，点进去「发消息」就开新的一段。
 *
 * `memberCount` 取 `group_members`（群级真源），不是某段会话的 `thread_members` 快照 ——
 * 快照可能停在当时的成员名单，跟群详情对不上。
 * `lastActiveAt` 给前端排序用：有会话就看最近一段，没会话（零段）就看群自己的 updatedAt。
 */

export function listGroups() {
  return db
    .prepare(
      `SELECT g.id, g.title, g.assistantPersonaId, g.createdAt, g.updatedAt,
              (SELECT COUNT(*) FROM group_members m WHERE m.groupId = g.id) AS memberCount,
              (SELECT MAX(c.updatedAt) FROM conversations c WHERE c.groupId = g.id) AS lastActiveAt
         FROM groups g
        WHERE g.dissolvedAt IS NULL
        ORDER BY COALESCE((SELECT MAX(c.updatedAt) FROM conversations c WHERE c.groupId = g.id), g.updatedAt) DESC`,
    )
    .all();
}

/**
 * 落一段群会话：标题/群助手从群上取，成员从 group_members **拷一份快照**进 thread_members。
 *
 * 快照是必须的：`dispatch` 的「@ 谁 / 没 @ 找群助手」读的是**会话的** thread_members，
 * 而群成员以后可能变 —— 老会话该保持它当时的成员，新会话才拿新名单。
 */

function insertGroupSession(groupId, { title, assistantPersonaId }) {
  const ts = nowIso();
  const id = newId('c');
  /*
   * 参数顺序必须与列顺序逐位对齐，这里最容易错位：
   *   id, title, personaId=''(字面量，群不带 personaId), ownerPersonaId, ownerUserId,
   *   assistantPersonaId, kind='group'(字面量), sessionId=NULL, status='待跑', createdAt, updatedAt, groupId
   * 曾经把 ownerUserId 和 assistantPersonaId 写反过一次 —— 后果是每段群会话的群助手
   * 变成 `local-user`，一发言就报「群里没有群助手」，而且建群那一刻看不出来。
   */
  db.prepare(
    `INSERT INTO conversations
       (id, title, personaId, ownerPersonaId, ownerUserId, assistantPersonaId, kind, sessionId, status, createdAt, updatedAt, groupId)
     VALUES (?, ?, '', ?, ?, ?, 'group', NULL, '待跑', ?, ?, ?)`,
  ).run(id, title, assistantPersonaId, LOCAL_USER.id, assistantPersonaId, ts, ts, groupId);
  const members = db.prepare('SELECT personaId FROM group_members WHERE groupId = ? ORDER BY joinedAt').all(groupId);
  for (const m of members) addMember(id, m.personaId);
  return getConversation(id);
}

/**
 * 给群开一段新会话（群详情页「发消息」走这里）。群不存在或已解散 → null。
 *
 * **发起新会话 = 明确要用这个群**，所以顺手把整群的「不显示」撤掉
 * （2026-10-20 用户实报：群被不显示后再点「发消息」，列表里一直不出现）。
 * 与 hideConversation 的群级隐藏对称：藏是一起藏，回是一起回；
 * 新会话本身 hiddenAt 本来就是 NULL，但只回一段的话，万一列表收敛取到的
 * 是另一段被藏的，看上去还是"发起没反应"。
 */

export function createGroupSession(groupId) {
  const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  if (!g || g.dissolvedAt) return null;
  const conv = insertGroupSession(groupId, { title: g.title, assistantPersonaId: g.assistantPersonaId });
  db.prepare('UPDATE conversations SET hiddenAt = NULL WHERE groupId = ? AND kind = ?').run(groupId, 'group');
  return getConversation(conv.id);
}

/**
 * 改群名 / 换群助手。**群级改完再同步到每一段会话**：
 * 消息列表、聊天头部、抽屉读的都是会话上的镜像字段，不同步就会出现"群里叫 A、列表还叫 B"。
 */

export function updateGroup(groupId, { title, assistantPersonaId } = {}) {
  const ts = nowIso();
  db.exec('BEGIN');
  try {
    if (title) db.prepare('UPDATE groups SET title = ?, updatedAt = ? WHERE id = ?').run(title, ts, groupId);
    if (assistantPersonaId) {
      db.prepare('UPDATE groups SET assistantPersonaId = ?, updatedAt = ? WHERE id = ?')
        .run(assistantPersonaId, ts, groupId);
    }
    if (title) {
      db.prepare('UPDATE conversations SET title = ?, updatedAt = ? WHERE groupId = ?').run(title, ts, groupId);
    }
    if (assistantPersonaId) {
      db.prepare('UPDATE conversations SET assistantPersonaId = ?, updatedAt = ? WHERE groupId = ?')
        .run(assistantPersonaId, ts, groupId);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return getGroup(groupId);
}

/** 群级加人：先落群名单，再给**每一段会话**补 thread_members（各自按自己的历史算水位线） */

export function addGroupMembers(groupId, personaIds = []) {
  const ts = nowIso();
  const sessions = db.prepare('SELECT id FROM conversations WHERE groupId = ?').all(groupId);
  db.exec('BEGIN');
  try {
    const ins = db.prepare('INSERT OR IGNORE INTO group_members (groupId, personaId, joinedAt) VALUES (?, ?, ?)');
    for (const pid of personaIds) ins.run(groupId, pid, ts);
    for (const s of sessions) for (const pid of personaIds) addMember(s.id, pid);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return listGroupMembers(groupId);
}

/** 群级踢人：群名单 + 每段会话的成员/会话状态一起清（再拉回来是干净的开始） */

export function removeGroupMember(groupId, personaId) {
  const sessions = db.prepare('SELECT id FROM conversations WHERE groupId = ?').all(groupId);
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM group_members WHERE groupId = ? AND personaId = ?').run(groupId, personaId);
    for (const s of sessions) removeMember(s.id, personaId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/* --------------------------------------- 会话成员（每段会话的成员快照） */

/**
 * 往**一段会话**里加人（thread_members = 这段会话的成员快照）。
 *
 * ⚠️ 这是会话级的底层动作：群的成员真源在 `group_members`（见 addGroupMembers），
 * 两者分工是「群管名单、会话管当时是谁」—— dispatch 的 @ 人 / 没 @ 找群助手
 * 读的是**会话的** thread_members，这样老会话保持它当时的成员，新会话才拿新名单。
 *
 * 水位线不是从 0 开始：让新人能读到"最近 backfill 条"作为背景，
 * 但不会把整段历史灌进他的 prompt。刚建的会话没有消息，自然就是 0。
 */

export function addMember(threadId, personaId, { backfill = 20 } = {}) {
  db.prepare('INSERT OR IGNORE INTO thread_members (threadId, personaId, joinedAt) VALUES (?, ?, ?)').run(
    threadId,
    personaId,
    nowIso(),
  );
  const row = db
    .prepare(
      `SELECT COALESCE(MIN(rowid), 0) AS rid FROM (
         SELECT rowid FROM messages WHERE conversationId = ? ORDER BY rowid DESC LIMIT ?
       )`,
    )
    .get(threadId, backfill);
  setMemberWatermark(threadId, personaId, row?.rid ?? 0);
  return true;
}

/** 从**一段会话**里踢人。顺手删掉他的会话与水位线：再拉回来就是干净的开始，不会带着旧记忆。 */

export function removeMember(threadId, personaId) {
  db.prepare('DELETE FROM thread_members WHERE threadId = ? AND personaId = ?').run(threadId, personaId);
  db.prepare('DELETE FROM member_sessions WHERE threadId = ? AND personaId = ?').run(threadId, personaId);
}

/** 一段会话的成员（含 persona 配置：dispatch 要用 runtime / 沙箱 / 技能）。 */

export function listMembers(threadId) {
  return db
    .prepare(
      `SELECT tm.personaId, tm.joinedAt, p.name, p.role, p.runtime, p.sandbox, p.cwd, p.model, p.instructions, p.rootDirs,
              p.builtin
         FROM thread_members tm JOIN personas p ON p.id = tm.personaId
        WHERE tm.threadId = ? ORDER BY tm.joinedAt, p.name`,
    )
    .all(threadId);
}

/** 群助手的 persona 行（跑群助手时要它的 runtime/沙箱等配置） */

export function getAssistantPersona(threadId) {
  const t = db.prepare('SELECT assistantPersonaId FROM conversations WHERE id = ?').get(threadId);
  if (!t?.assistantPersonaId) return null;
  return getPersona(t.assistantPersonaId);
}

/**
 * 换群助手。
 *
 * 群有自己的 `groups.assistantPersonaId`（2026-10-20 拆表之后），所以**群会话要往群上写**，
 * 再让 updateGroup 把镜像字段同步到每一段会话 —— 只改这一段的话，
 * 下一段新会话又拿回老助手。会话级的调用（历史遗留）保持原样。
 */

export function setAssistantPersona(threadId, personaId) {
  const conv = db.prepare('SELECT id, kind, groupId FROM conversations WHERE id = ?').get(threadId) ?? null;
  if (conv?.kind === 'group') {
    const gid = conv.groupId || conv.id;
    updateGroup(gid, { assistantPersonaId: personaId });
    return;
  }
  db.prepare('UPDATE conversations SET assistantPersonaId = ?, personaId = ?, updatedAt = ? WHERE id = ?').run(
    personaId,
    personaId,
    nowIso(),
    threadId,
  );
}


export function purgeDissolvedGroup(groupId) {
  const g = db.prepare('SELECT id, dissolvedAt FROM groups WHERE id = ?').get(groupId) ?? null;
  if (!g) return { ok: false, why: 'not-found', runId: null, changes: 0 };
  if (!g.dissolvedAt) return { ok: false, why: 'not-dissolved', runId: null, changes: 0 };

  const sessions = db.prepare('SELECT id FROM conversations WHERE groupId = ?').all(groupId);
  for (const s of sessions) {
    const running = activeRun(s.id);
    if (running) return { ok: false, why: 'running', runId: running.id, changes: 0 };
  }

  let changes = 0;
  db.exec('BEGIN');
  try {
    for (const s of sessions) changes += purgeConversation(s.id);
    db.prepare('DELETE FROM group_members WHERE groupId = ?').run(groupId);
    db.prepare('DELETE FROM groups WHERE id = ?').run(groupId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { ok: true, why: null, runId: null, changes };
}

/**
 * 清掉一个**已删除员工**的全部单聊历史：他名下每一段 direct 会话连消息、运行记录一起抹。
 *
 * 2026-10-20 用户定的第二档"清档"（第一档是 `purgeDissolvedGroup`）。
 * 场景：`deletePersona` **不删会话**（记录可能有用），那些行留在消息列表里，点进去只读。
 * 于是列表里那行「和 张三」代表的是**这个人的全部历史** —— 他可能有好几段会话
 * （换过 runtime、被「不显示」过又翻出来…）。只删一段的话，剩下的段还在「已归档」里躺着，
 * 可那个人的入口已经彻底没了，没人会想起来去点它 —— 这就是"看不见的冗余数据"。
 * 所以员工已删的单聊，删除 = **全清**（用户原话：改成「删除并清空聊天记录」）。
 *
 * 只接受"人已经不在 `personas` 里"的 personaId：人还在就是正常单聊，走"删这一段"。
 * 判据放在 store 这层（不止路由）—— 接口能被直接调，同 `deletePersona` 的两道关。
 */

export function dissolveGroup(groupId) {
  const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  if (!g) return null;
  const ts = nowIso();
  const sessions = db.prepare('SELECT id FROM conversations WHERE groupId = ?').all(groupId);
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM group_members WHERE groupId = ?').run(groupId);
    for (const s of sessions) {
      db.prepare('DELETE FROM thread_members WHERE threadId = ?').run(s.id);
      db.prepare('DELETE FROM member_sessions WHERE threadId = ?').run(s.id);
      // 只打 dissolvedAt；hiddenAt **不动**（原来被「不显示」的保持隐藏，可见的保持可见）
      db.prepare(
        `UPDATE conversations
            SET dissolvedAt = ?, assistantPersonaId = NULL, status = '待跑', updatedAt = ?
          WHERE id = ?`,
      ).run(ts, ts, s.id);
    }
    db.prepare('UPDATE groups SET dissolvedAt = ?, assistantPersonaId = NULL, updatedAt = ? WHERE id = ?')
      .run(ts, ts, groupId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return getGroup(groupId);
}

/** 已归档的会话（给「已归档」入口用） */
/**
 * 被「不显示」收走的会话 —— **只给「聊天记录」用**（2026-10-20 去掉会话归档之后）。
 *
 * 为什么不并进 `listConversations`：那是 `/api/state` 的热路径，还喂着工作台、
 * 通讯录、任务看板；把隐藏的混进去，别的地方会凭空多出"看不见的会话"。
 * 这里单独给一份、带 `hidden: true`，前端只在聊天记录抽屉里用。
 */

export function getMemberSession(threadId, personaId, scope = '') {
  return (
    db
      .prepare('SELECT * FROM member_sessions WHERE threadId = ? AND personaId = ? AND scope = ?')
      .get(threadId, personaId, scope) ?? null
  );
}

/**
 * 写回某个成员在某个作用域里的 runtime 会话 id。
 *
 * `family` 记账这个 id 是**哪个运行时族**给的：换族之后这个 id 在对面那个 CLI 里
 * 根本不存在（两家的会话存储互不相通），所以必须记下来（见 runs.mjs 的 resumeId）。
 * 不传 family 时**保留原来的值** —— 别把已有记录降级成"不知道"。
 */

export function setMemberSession(threadId, personaId, sessionId, scope = '', family = '') {
  db.prepare(
    `INSERT INTO member_sessions (threadId, personaId, scope, sessionId, lastSeenRowid, family) VALUES (?, ?, ?, ?, 0, ?)
     ON CONFLICT(threadId, personaId, scope) DO UPDATE SET
       sessionId = excluded.sessionId,
       family    = COALESCE(NULLIF(excluded.family, ''), member_sessions.family)`,
  ).run(threadId, personaId, scope, sessionId, family ?? '');
}


export function setMemberWatermark(threadId, personaId, rowid, scope = '') {
  db.prepare(
    `INSERT INTO member_sessions (threadId, personaId, scope, sessionId, lastSeenRowid) VALUES (?, ?, ?, NULL, ?)
     ON CONFLICT(threadId, personaId, scope) DO UPDATE
       SET lastSeenRowid = MAX(member_sessions.lastSeenRowid, excluded.lastSeenRowid)`,
  ).run(threadId, personaId, scope, rowid);
}

/* ----------------------------------------------------------------- skills */

/**
 * 技能库换血时，把员工身上挂的老名字落到当前技能上（一次性、幂等）。
 * 表里没有的名字原样留着 —— 那是人自己挂的，不替人改。
 */
