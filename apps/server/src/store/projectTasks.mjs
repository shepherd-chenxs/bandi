/* store/projectTasks.mjs —— 2026-10-22 由 store.mjs 按域拆出。SQL 只在 store/ 目录内。 */

import { db, newId, nowIso } from './db.mjs';

export function createProjectTask({
  projectId,
  title,
  description = '',
  status = '待办',
  assigneePersonaId = null,
  conversationId = null,
  runId = null,
  source = 'manual',
  externalKey = null,
  sourceKey = null,
  sourceRunId = null,
}) {
  const ts = nowIso();
  const row = {
    id: newId('pt'),
    projectId,
    title,
    description,
    status,
    assigneePersonaId,
    conversationId,
    runId,
    source,
    externalKey,
    // 流程的一步开出来的卡：'flow:<runId>:<nodeId>:<visit>'；手建的卡是 null
    sourceKey,
    sourceRunId,
    createdAt: ts,
    updatedAt: ts,
  };
  db.prepare(
    `INSERT INTO project_tasks
       (id, projectId, title, description, status, assigneePersonaId, conversationId, runId, source, externalKey, sourceKey, sourceRunId, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.projectId,
    row.title,
    row.description,
    row.status,
    row.assigneePersonaId,
    row.conversationId,
    row.runId,
    row.source,
    row.externalKey,
    row.sourceKey,
    row.sourceRunId,
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
 * 用途：运行跑完时把卡的状态收一下（完成 → 待确认；人停的/跑挂的 → 已阻塞）。
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


export function listProjectTasks(projectId) {
  return db
    .prepare('SELECT * FROM project_tasks WHERE projectId = ? ORDER BY createdAt DESC')
    .all(projectId);
}

/**
 * 排队中的卡：撞上"人满了 / 项目正忙"被退回「待办」、但标了 queuedAt 的那些。
 * 30 秒节拍按先进先出重试（谁先排谁先试）。
 */

export function listQueuedProjectTasks() {
  return db
    .prepare("SELECT * FROM project_tasks WHERE queuedAt IS NOT NULL AND status = '待办' ORDER BY queuedAt")
    .all();
}


export function getProjectTask(id) {
  return db.prepare('SELECT * FROM project_tasks WHERE id = ?').get(id) ?? null;
}

/** 只覆盖传进来的字段（undefined 不覆盖） */

export function updateProjectTask(id, fields) {
  const cur = getProjectTask(id);
  if (!cur) return null;
  const next = { ...cur };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) next[k] = v;
  db.prepare(
    `UPDATE project_tasks
        SET title = ?, description = ?, status = ?, assigneePersonaId = ?,
            conversationId = ?, runId = ?, prRepo = ?, prNumber = ?, prState = ?, prTitle = ?,
            prCheckedAt = ?, queuedAt = ?, sourceKey = ?, sourceRunId = ?, updatedAt = ?
      WHERE id = ?`,
  ).run(
    next.title,
    next.description,
    next.status,
    next.assigneePersonaId,
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
