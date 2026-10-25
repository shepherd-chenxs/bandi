/* store/personas.mjs —— 2026-10-22 由 store.mjs 按域拆出。SQL 只在 store/ 目录内。 */

import { db, newId, nowIso } from './db.mjs';
import { purgeConversation } from './conversations.mjs';
import { activeRun } from './runs.mjs';
import { dissolveGroup, listMembers, purgeDissolvedGroup } from './groups.mjs';

/**
 * 并发数的**默认值 / 最高值**（2026-10-24 用户定，对标 Multica 的"每个虚拟员工可配并行数"）：
 * 默认 6、最高 20。派活闸（dispatch.ensureDispatchable）和保存钳位都用这两个常量，
 * 别处再写一个 6/20 就是第二份真相。
 */
export const PERSONA_DEFAULT_MAX_PARALLEL = 6;
export const PERSONA_MAX_PARALLEL = 20;

/** 这个人此刻生效的并发上限：没配/配坏了退默认（派活闸用，别自己再判一遍） */
export function effectiveMaxParallel(persona) {
  const n = Number(persona?.maxParallel);
  return Number.isFinite(n) && n >= 1 ? Math.min(PERSONA_MAX_PARALLEL, Math.floor(n)) : PERSONA_DEFAULT_MAX_PARALLEL;
}

export function listPersonas() {
  return db
    .prepare(
      `SELECT p.*,
              (SELECT c.id        FROM conversations c WHERE c.personaId = p.id AND c.kind = 'direct'
                ORDER BY c.updatedAt DESC LIMIT 1) AS lastConversationId,
              (SELECT c.status    FROM conversations c WHERE c.personaId = p.id AND c.kind = 'direct'
                ORDER BY c.updatedAt DESC LIMIT 1) AS lastStatus,
              (SELECT c.updatedAt FROM conversations c WHERE c.personaId = p.id AND c.kind = 'direct'
                ORDER BY c.updatedAt DESC LIMIT 1) AS lastAt,
              (SELECT m.text      FROM messages m
                 JOIN conversations c2 ON c2.id = m.conversationId
                WHERE c2.personaId = p.id AND c2.kind = 'direct'
                ORDER BY m.createdAt DESC, m.rowid DESC LIMIT 1) AS lastMessage
         FROM personas p
        ORDER BY COALESCE((SELECT c3.updatedAt FROM conversations c3
                            WHERE c3.personaId = p.id AND c3.kind = 'direct'
                            ORDER BY c3.updatedAt DESC LIMIT 1), p.createdAt) DESC`,
    )
    .all();
}

/**
 * 点一个数字员工就要能直接说话：有对话就复用最近那段，没有就现开一段。
 *
 * **必须限定 kind='direct'**：群也会带 personaId（群助手），不过滤的话
 * 点人会打开群。这个坑踩过一次。
 */

export function getPersona(id) {
  return db.prepare('SELECT * FROM personas WHERE id = ?').get(id) ?? null;
}


export function createPersona({ id = null, name, role = null, department = null, instructions = '', runtime = 'codex', sandbox = 'danger-full-access', cwd = null, model = null, showThinking = 0, rootDirs = [], builtin = 0, avatar = null, maxParallel = null }) {
  const row = {
    // 内置员工要**固定 id**（seed 幂等靠它）；普通员工仍自动生成
    id: id || newId('p'),
    name, role, department, instructions, runtime, sandbox, cwd, model,
    showThinking: showThinking ? 1 : 0,
    rootDirs: Array.isArray(rootDirs) && rootDirs.length ? JSON.stringify(rootDirs) : null,
    builtin: builtin ? 1 : 0,
    avatar: avatar || null,
    maxParallel: maxParallel ?? null,
    createdAt: nowIso(),
  };
  db.prepare(
    `INSERT INTO personas (id, name, role, department, instructions, runtime, sandbox, cwd, model, showThinking, rootDirs, builtin, avatar, maxParallel, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id, row.name, row.role, row.department, row.instructions, row.runtime, row.sandbox, row.cwd, row.model,
    row.showThinking, row.rootDirs, row.builtin, row.avatar, row.maxParallel, row.createdAt,
  );
  return row;
}

/** 这个人是不是某些群的群助手 —— 删之前必须查，删了「没 @ 就找群助手」那条规则就断了 */

export function markPersonaBuiltin(id) {
  return db.prepare('UPDATE personas SET builtin = 1 WHERE id = ?').run(id).changes;
}

/**
 * 删员工：**连带清掉他的关系数据**。
 *
 * 为什么要级联：`listMembers` 是 INNER JOIN personas，关系表里留悬空行不会报错，
 * 只会让群成员**静默消失**；而 `assistantPersonaId` 悬空则更糟 —— 群里没人接话了。
 *
 * 会话**不删**（聊天记录留着），也**不再归档**（2026-10-20 去掉归档功能）：
 * 它们留在消息列表里，点进去**只读**（人没了，不能再聊），名字落到标题里方便分辨。
 * 用户想清走，右键「删除并清空聊天记录」（`purgePersonaHistory`，他的全部历史一起清）
 * 或「归档」（收起来、数据留库）。
 */

export function deletePersona(id) {
  /*
   * **内置员工不删**（2026-10-18）。判据在 store 这一层，不在路由 ——
   * 接口谁都能直接调，前端把按钮藏起来只是提示，不作数。
   * 允许改名、允许改指令、允许改权限，唯独不许丢：她是这台机器上唯一"出厂就在"的人。
   */
  const target = db.prepare('SELECT name, builtin FROM personas WHERE id = ?').get(id);
  if (target?.builtin) {
    throw new Error(`「${target.name}」是内置员工，不能删（可以改名或改她的指令）`);
  }

  // 注意：node:sqlite 的 DatabaseSync **没有** better-sqlite3 那个 db.transaction() 助手，
  // 只能自己 BEGIN/COMMIT。级联删除要么全成、要么全不动，不能删一半。
  db.exec('BEGIN');
  try {
    const persona = db.prepare('SELECT name FROM personas WHERE id = ?').get(id);

    db.prepare('DELETE FROM persona_skills WHERE personaId = ?').run(id);
    db.prepare('DELETE FROM thread_members WHERE personaId = ?').run(id);
    db.prepare('DELETE FROM member_sessions WHERE personaId = ?').run(id);
    // 群成员名单也要清（2026-10-20 起成员真源在 group_members，不清就是一排"查无此人"）
    db.prepare('DELETE FROM group_members WHERE personaId = ?').run(id);

    const convs = db.prepare("SELECT id, title FROM conversations WHERE kind = 'direct' AND personaId = ?").all(id);
    for (const c of convs) {
      /*
       * 人一删，**再没有别的地方记得"这段对话是谁的"** —— personaName 的 JOIN 会变 null，
       * 列表就会剩一排分不清的「（员工已删）」。所以把名字落到标题里。
       * 标题已有名字（正常是「和 X」）就不动它，别覆盖用户自己起过的名字。
       *
       * **不再归档**（2026-10-20 用户要求）：归档功能已去掉，这些会话**留在消息列表里**，
       * 点进去只读（不能继续聊，因为那个人已经没了）。用户可右键「删除」或「归档」自行收走。
       */
      const named = persona?.name && c.title && c.title.includes(persona.name);
      const title = named ? c.title : `和 ${persona?.name ?? '已删除的员工'}`;
      db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, c.id);
    }

    const removed = db.prepare('DELETE FROM personas WHERE id = ?').run(id).changes > 0;
    db.exec('COMMIT');
    return { removed, keptConversations: convs.length };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 改员工配置（详情页保存用）。只覆盖传进来的字段。 */

export function updatePersona(id, fields) {
  const current = getPersona(id);
  if (!current) return null;
  const next = {
    name: fields.name ?? current.name,
    // 岗位：跟 model 一个口径 —— undefined = 没提供；空串/null = 显式清掉
    role: fields.role === undefined ? current.role : (String(fields.role ?? '').trim() || null),
    // 部门：同岗位的口径（undefined = 没提供；空白 = 显式清掉，清掉就落「未分配」）
    department: fields.department === undefined ? current.department : (String(fields.department ?? '').trim() || null),
    instructions: fields.instructions ?? current.instructions,
    runtime: fields.runtime ?? current.runtime,
    sandbox: fields.sandbox ?? current.sandbox,
    cwd: fields.cwd ?? current.cwd,
    // 注意这里不能用 ??：null 是"显式清空"（选回「用 CLI 默认」），undefined 才是"没提供"
    model: fields.model === undefined ? current.model : fields.model,
    showThinking: fields.showThinking === undefined ? current.showThinking : (fields.showThinking ? 1 : 0),
    rootDirs:
      fields.rootDirs === undefined
        ? current.rootDirs
        : (Array.isArray(fields.rootDirs) && fields.rootDirs.length ? JSON.stringify(fields.rootDirs) : null),
    // 头像：undefined = 没提供；null/空串 = 显式清掉（退回字母头像）
    avatar: fields.avatar === undefined ? current.avatar : (fields.avatar ? String(fields.avatar) : null),
    // 并发上限：undefined = 没提供；null = 显式恢复默认；数字就钳到 [1, PERSONA_MAX_PARALLEL]
    //（钳位不报错 —— 界面是个数字框，手滑填 0 或 999 都不该把保存打断）
    maxParallel:
      fields.maxParallel === undefined
        ? current.maxParallel
        : (Number.isFinite(Number(fields.maxParallel)) && Number(fields.maxParallel) > 0
            ? Math.min(PERSONA_MAX_PARALLEL, Math.floor(Number(fields.maxParallel)))
            : null),
  };
  db.prepare(
    `UPDATE personas SET name = ?, role = ?, department = ?, instructions = ?, runtime = ?, sandbox = ?, cwd = ?, model = ?, showThinking = ?, rootDirs = ?, avatar = ?, maxParallel = ?
      WHERE id = ?`,
  ).run(
    next.name, next.role, next.department, next.instructions, next.runtime, next.sandbox, next.cwd, next.model,
    next.showThinking, next.rootDirs, next.avatar, next.maxParallel, id,
  );
  // 指令真的改了 → 作废他的成员会话：身份只在会话第一次建立时注入，
  // 不清的话他带着旧指令继续跑（自建员工走详情页改指令的这条路，专家走 syncHiredExperts）
  if (next.instructions !== current.instructions) resetPersonaSessions(id);
  return { ...current, ...next };
}

/**
 * 作废这个人的**全部成员会话**（2026-10-24）：身份（指令）或技能变了的时候用。
 * 身份只在成员会话第一次建立时注入（dispatch 的 firstTime），不清会话他就带着
 * 旧指令继续干活（见 experts.syncHiredExperts 里的说明）。返回作废了几节。
 */
export function resetPersonaSessions(personaId) {
  return db.prepare('DELETE FROM member_sessions WHERE personaId = ?').run(personaId).changes;
}

export function purgePersonaHistory(personaId) {
  // 人还在 → 不是清档场景（这段只是普通单聊的一段）
  if (db.prepare('SELECT id FROM personas WHERE id = ?').get(personaId)) {
    return { ok: false, why: 'not-deletable', runId: null, changes: 0 };
  }

  const convs = db.prepare("SELECT id FROM conversations WHERE kind = 'direct' AND personaId = ?").all(personaId);
  if (!convs.length) return { ok: true, why: null, runId: null, changes: 0 };

  // 任何一段还在跑就整体拒绝：父级还在干活就先别拆房子（同 purgeDissolvedGroup）
  for (const c of convs) {
    const running = activeRun(c.id);
    if (running) return { ok: false, why: 'running', runId: running.id, changes: 0 };
  }

  let changes = 0;
  db.exec('BEGIN');
  try {
    for (const c of convs) changes += purgeConversation(c.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { ok: true, why: null, runId: null, changes };
}

/**
 * **永久删除会话** —— 不可恢复、不进「已移除的会话」。
 *
 * 按 kind 分派：
 *   · `direct`    → 抹掉这一段（消息、运行记录、成员状态全没）
 *                   例外：**员工已删**的单聊 → 这个人的全部历史一起清（`purgePersonaHistory`，
 *                   同日用户定：那行代表的是"这个人的全部历史"，只删一段会留下看不到的冗余）
 *   · `group`     → **只删这一段会话**（2026-10-20 用户定：「删除不是删除群，是删除这次会话」
 *                   —— 列表里那行虽是"群"，但它代表的是这个群**最新的一段**；
 *                   删它不动群本身、成员名单、这个群的其他段）。
 *                   例外：**已解散的群** → 整群清档（`purgeDissolvedGroup`，同日用户定的
 *                   收尾设计：解散后行代表"全部历史"，删除 = 删除并清空聊天记录；
 *                   群已不在通讯录、也开不出新段，留着零散的段没有意义）。
 *                   整个群不要了（还没解散）走「解散」（`dissolveGroup`）。
 *   · `exec`      → 拒绝（`not-deletable`）：它是流程 / 任务卡的载体，删它等于抽掉办过的痕迹，
 *                   该由卡片自己的流程管。
 *
 * 三重校验（存在 / 可删 / 没在跑）全在事务**外**：拒绝路径零写入，不留半拉状态。
 * store 层再判一遍（不止路由层判），因为接口可以被直接调 —— 同 `deletePersona` 的两道关。
 *
 * @param {string} id 会话 id
 * @returns {{ok: boolean, why: string|null, runId: string|null, changes: number}}
 *          `why`：`not-found` | `not-deletable` | `running`；成功时 `changes` = 删掉的会话行数
 */

/*
 * **换 id（存量迁移）** —— 2026-10-23 起「内置/专家的 id 跟人走」之后需要的能力。
 *
 * personaId 在十几张表里被引用（会话归属、消息、运行、群成员、群助手、成员会话水位线、
 * 技能挂载、流程步骤/任务经办人、项目任务指派、仓库守门人），换 id 不能只改 personas 一行 ——
 * 漏一张就把那部分历史挂成孤儿。这里一次性全搬：
 *
 *   ① 所有引用 personaId 的列：`UPDATE … SET col = 新 WHERE col = 旧`（表查 sqlite_master 再动，
 *      极旧的库可能还没建那张表）；
 *   ② personas 本行：id 换新；avatar 若指着旧头像文件名一并换成新文件名
 *      （`avatarFrom/avatarTo` 不传时按 `<id>.png` 惯例推导）；
 *   ③ 幂等：旧 id 不存在、新 id 已存在、或两个 id 相同 → 不动，返回 null。
 *
 * 返回搬走的引用行数（给启动日志一句话）；没动 → null。
 */
const PERSONA_ID_REFS = [
  ['conversations', 'personaId'],
  ['messages', 'personaId'],
  ['runs', 'personaId'],
  ['thread_members', 'personaId'],
  ['member_sessions', 'personaId'],
  ['persona_skills', 'personaId'],
  ['groups', 'assistantPersonaId'],
  ['group_members', 'personaId'],
  ['workflow_steps', 'assigneePersonaId'],
  ['workflow_tasks', 'assigneePersonaId'],
  ['project_tasks', 'assigneePersonaId'],
  ['git_repos', 'keeperPersonaId'],
];

export function renamePersonaId(oldId, newId, { avatarFrom, avatarTo } = {}) {
  if (oldId === newId) return null;
  if (!getPersona(oldId) || getPersona(newId)) return null;

  const tables = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((r) => r.name));
  let refs = 0;
  for (const [t, c] of PERSONA_ID_REFS) {
    if (!tables.has(t)) continue;
    refs += db.prepare(`UPDATE ${t} SET ${c} = ? WHERE ${c} = ?`).run(newId, oldId).changes;
  }
  const from = avatarFrom ?? `${oldId}.png`;
  const to = avatarTo ?? `${newId}.png`;
  db.prepare(`UPDATE personas SET id = ?, avatar = CASE WHEN avatar = ? THEN ? ELSE avatar END WHERE id = ?`)
    .run(newId, from, to, oldId);
  return refs;
}
