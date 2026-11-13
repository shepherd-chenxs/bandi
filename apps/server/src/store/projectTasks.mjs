/* store/projectTasks.mjs —— 2026-10-22 由 store.mjs 按域拆出。SQL 只在 store/ 目录内。 */

import { db, newId, nowIso } from './db.mjs';

export function createProjectTask({
  projectId,
  title,
  description = '',
  status = 'todo',
  assigneePersonaId = null,
  // 派给真人（2026-10-31）：与 assigneePersonaId 互斥，真人执行不起会话不派活
  assigneeUserId = null,
  conversationId = null,
  runId = null,
  source = 'manual',
  externalKey = null,
  sourceKey = null,
  sourceRunId = null,
  // **卡由流程执行**（2026-10-26）：选了哪条模板；发起后挂在哪条实例上（见 store/projects.mjs 的注释）
  flowTemplateId = null,
  flowRunId = null,
  createdBy = null,
  // 人手建卡的是哪位真人（2026-10-31；员工经接口建的卡是 null）
  createdByUserId = null,
  creatorConvId = null,
  // 团队协作（2026-11-09）：派给哪个群办（与 assigneePersonaId / assigneeUserId / flow 互斥）；
  // 卡上不记协调人 —— 群助手每次现读 group.assistantPersonaId
  assigneeGroupId = null,
  // 协作子卡：挂在哪个主卡下（只允许一层）
  parentTaskId = null,
}) {
  const ts = nowIso();
  const row = {
    id: newId('pt'),
    projectId,
    title,
    description,
    status,
    assigneePersonaId,
    assigneeUserId,
    conversationId,
    runId,
    source,
    externalKey,
    // 流程的一步开出来的卡：'flow:<runId>:<nodeId>:<visit>'；手建的卡是 null
    sourceKey,
    sourceRunId,
    // 反向的一条边：这张卡自己选了一条流程来执行（见 store/projects.mjs 的 flowTemplateId 注释）
    flowTemplateId,
    flowRunId,
    // 项目经理经"工作证"接口建的卡记他（人手建的卡是 null，见 routes/agent-cards.mjs）
    createdBy,
    createdByUserId,
    // 建卡那次运行所在的会话（PM 在哪个群里建的卡，回执就送回哪儿；人手建是 null）
    creatorConvId,
    // 团队协作 / 协作子卡（2026-11-09，见 store/projects.mjs 的 ensureColumn 注释）
    assigneeGroupId,
    parentTaskId,
    createdAt: ts,
    updatedAt: ts,
  };
  db.prepare(
    `INSERT INTO project_tasks
       (id, projectId, title, description, status, assigneePersonaId, assigneeUserId, conversationId, runId, source, externalKey, sourceKey, sourceRunId, flowTemplateId, flowRunId, createdBy, createdByUserId, creatorConvId, assigneeGroupId, parentTaskId, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.projectId,
    row.title,
    row.description,
    row.status,
    row.assigneePersonaId,
    row.assigneeUserId,
    row.conversationId,
    row.runId,
    row.source,
    row.externalKey,
    row.sourceKey,
    row.sourceRunId,
    row.flowTemplateId,
    row.flowRunId,
    row.createdBy,
    row.createdByUserId,
    row.creatorConvId,
    row.assigneeGroupId,
    row.parentTaskId,
    row.createdAt,
    row.updatedAt,
  );
  return row;
}

/** 按去重键找这张卡（同一个 PR 巡检多次只该有一张） */

export function getProjectTaskByExternalKey(projectId, externalKey) {
  if (!externalKey) return null;
  return db.prepare('SELECT * FROM project_tasks WHERE projectId = ? AND externalKey = ?').get(projectId, externalKey) ?? null;
}

/**
 * 这次运行是哪张卡的（2026-10-17）。
 *
 * 用途：运行跑完时把卡的状态收一下（完成 → 待验收；人停的 → 已阻塞；跑挂的 → 失败）。
 * **回到「待办」是错的** —— 有些待办会被自动重新派活，失败一次就再派一次，等于死循环。
 */

export function getProjectTaskByRunId(runId) {
  if (!runId) return null;
  return db.prepare('SELECT * FROM project_tasks WHERE runId = ? ORDER BY updatedAt DESC LIMIT 1').get(runId) ?? null;
}

/**
 * 按「流程的一步」找它那张卡（`sourceKey = flow:<runId>:<nodeId>:<visit>`，见 ensureTaskCardForStep）。
 * 有索引不需要（这张表最多几百行，走主键扫描也就一瞬）；真要慢了再加。
 */

export function getProjectTaskBySourceKey(sourceKey) {
  if (!sourceKey) return null;
  return db.prepare('SELECT * FROM project_tasks WHERE sourceKey = ? LIMIT 1').get(sourceKey) ?? null;
}

/**
 * 这场会话立过卡没有（2026-10-24「立成卡」用）。
 *
 * 一场会话最多立一张卡：立了卡之后聊天投影就该让位（不然看板上一件事两张卡），
 * 判据就是它 —— chatRows 拿它做去重，「再立一次」也靠它做幂等。
 */
export function getProjectTaskByConversation(conversationId) {
  if (!conversationId) return null;
  return db
    .prepare('SELECT * FROM project_tasks WHERE conversationId = ? ORDER BY createdAt DESC LIMIT 1')
    .get(conversationId) ?? null;
}

/** 这批会话里哪些已经立过卡（chatRows 去重用，一趟查完省得逐会话问） */
export function conversationIdsWithCards() {
  return new Set(
    db
      .prepare('SELECT DISTINCT conversationId FROM project_tasks WHERE conversationId IS NOT NULL')
      .all()
      .map((r) => r.conversationId),
  );
}


export function listProjectTasks(projectId) {
  return db
    .prepare('SELECT * FROM project_tasks WHERE projectId = ? ORDER BY createdAt DESC')
    .all(projectId);
}

/**
 * **某人的未完任务台账**（2026-11-09 检修 P3a）：每轮派活注入，问进度先看这里。
 *
 * 为什么要有（真实事故）：用户在 1:1 里问"我之前派给你的卡进度怎么样了"，员工在
 * 仓库里 `rg` 搜接口定义搜了三分多钟、最后被停掉（"这一轮没有回话"）——卡其实早已
 * 「待验收」。根因之一是**跨会话没有任务上下文**：卡只在卡评论区派活时注入。
 *
 * 口径：
 *   · 执行人 = 本人（`assigneePersonaId`）；
 *   · 或 本人当群助手的那张团队卡（`assigneeGroupId` ∈ 他当助手的群）；
 *   · 排除已完成 / 已取消（"还在办"的才值得每轮注入）；
 *   · 最近更新的在前，最多 N 张 —— 台账是提示，不是把看板搬进 prompt。
 */
export function listMyOpenTasks(personaId, limit = 5) {
  if (!personaId) return [];
  const n = Math.min(Math.max(Number(limit) || 5, 1), 20);
  return db
    .prepare(
      `SELECT id, title, status, projectId, updatedAt FROM project_tasks
        WHERE status NOT IN ('done', 'cancelled')
          AND (assigneePersonaId = ?
               OR assigneeGroupId IN (SELECT id FROM groups WHERE assistantPersonaId = ?))
        ORDER BY updatedAt DESC LIMIT ?`,
    )
    .all(personaId, personaId, n);
}

/**
 * 排队中的卡：撞上"人满了 / 项目正忙"被退回「待办」、但标了 queuedAt 的那些。
 * 30 秒节拍按先进先出重试（谁先排谁先试）。
 */

export function listQueuedProjectTasks() {
  return db
    .prepare("SELECT * FROM project_tasks WHERE queuedAt IS NOT NULL AND status = 'todo' ORDER BY queuedAt")
    .all();
}


export function getProjectTask(id) {
  return db.prepare('SELECT * FROM project_tasks WHERE id = ?').get(id) ?? null;
}

/** 一张主卡下的协作子卡（2026-11-09：团队协作拆出来的活；只一层，子卡不会再拆） */
export function listSubtasks(parentTaskId) {
  if (!parentTaskId) return [];
  return db
    .prepare('SELECT * FROM project_tasks WHERE parentTaskId = ? ORDER BY createdAt')
    .all(parentTaskId);
}

/** 只覆盖传进来的字段（undefined 不覆盖） */

export function updateProjectTask(id, fields) {
  const cur = getProjectTask(id);
  if (!cur) return null;
  const next = { ...cur };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) next[k] = v;
  db.prepare(
    `UPDATE project_tasks
        SET title = ?, description = ?, status = ?, assigneePersonaId = ?, assigneeUserId = ?,
            conversationId = ?, runId = ?, prRepo = ?, prNumber = ?, prState = ?, prTitle = ?,
            prCheckedAt = ?, queuedAt = ?, sourceKey = ?, sourceRunId = ?,
            flowTemplateId = ?, flowRunId = ?,
            creatorConvId = ?, notifiedFor = ?,
            assigneeGroupId = ?, parentTaskId = ?,
            statusByUserId = ?, statusAt = ?, updatedAt = ?
      WHERE id = ?`,
  ).run(
    next.title,
    next.description,
    next.status,
    next.assigneePersonaId ?? null,
    next.assigneeUserId ?? null,
    next.conversationId,
    next.runId,
    next.prRepo ?? null,
    next.prNumber ?? null,
    next.prState ?? null,
    next.prTitle ?? null,
    next.prCheckedAt ?? null,
    next.queuedAt ?? null,
    // `?? null` 而不是直接取：老库里这两列刚 ALTER 出来，历史行是 NULL —— 写回 null 是幂等的
    next.sourceKey ?? null,
    next.sourceRunId ?? null,
    next.flowTemplateId ?? null,
    next.flowRunId ?? null,
    next.creatorConvId ?? null,
    next.notifiedFor ?? null,
    // 团队协作 / 协作子卡（2026-11-09）：同 sourceKey 那两条一样，老行是 NULL，写回 null 幂等
    next.assigneeGroupId ?? null,
    next.parentTaskId ?? null,
    // 「状态改动」归因（2026-11-03）：store 层只透传，谁写进来由 project-tasks.mjs 那层
    // （人走的路）带；系统动作（跑完收状态等）不传这两列 —— `next` 是 cur 的浅拷贝，
    // 不传就原样写回，**不会把上一次人的署名冲掉**。
    next.statusByUserId ?? null,
    next.statusAt ?? null,
    nowIso(),
    id,
  );
  return getProjectTask(id);
}


export function deleteProjectTask(id) {
  return db.prepare('DELETE FROM project_tasks WHERE id = ?').run(id).changes > 0;
}

/** 项目的工作根：主目录 + 附加根（给沙箱的 writable_roots 用） */

export function listProjectTasksWithPr() {
  return db.prepare('SELECT * FROM project_tasks WHERE prRepo IS NOT NULL AND prNumber IS NOT NULL').all();
}

/* ---------------------------------------------------------------- 备份（2026-10-17） */
/**
 * 把当前库**一致地**导出一份到 `file`。
 *
 * 为什么用 `VACUUM INTO` 而不是复制文件：库开着 WAL，直接拷 `bandi.db` 会漏掉还在 `-wal` 里
 * 没落盘的事务，拷出来的是一份"旧库"。`VACUUM INTO` 由 SQLite 自己保证快照一致，
 * 而且顺带压实（备份文件通常比原库小）。
 * 目标文件必须不存在 —— 调用方用时间戳命名，重复了就让 SQLite 报错，别覆盖旧备份。
 */
