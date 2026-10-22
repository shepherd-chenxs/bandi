/* store/workflows.mjs —— 2026-10-22 由 store.mjs 按域拆出。SQL 只在 store/ 目录内。 */

import { db, newId, nowIso } from './db.mjs';

export function listWorkflowTemplates() {
  return db.prepare('SELECT * FROM workflow_templates ORDER BY builtIn DESC, createdAt').all();
}

export function getWorkflowTemplate(id) {
  return db.prepare('SELECT * FROM workflow_templates WHERE id = ?').get(id) ?? null;
}

export function upsertWorkflowTemplate({ id, name, nodes, steps, start, builtIn = false }) {
  const now = nowIso();
  const sid = id || newId('wt');
  // v2 用 nodes（节点+连线）；steps 是 v1 的线性步骤，这里同步写一份纯粹为了兼容旧读法
  const payload = JSON.stringify(nodes ?? steps ?? []);
  const nodesPayload = nodes ? payload : null;
  const startNode = start ?? (nodes?.length ? nodes[0].id : null);
  db.prepare(
    `INSERT INTO workflow_templates (id, name, steps, nodes, startNode, builtIn, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, steps = excluded.steps,
       nodes = COALESCE(excluded.nodes, workflow_templates.nodes),
       startNode = COALESCE(excluded.startNode, workflow_templates.startNode),
       updatedAt = excluded.updatedAt`,
  ).run(sid, name, payload, nodesPayload, startNode, builtIn ? 1 : 0, now, now);
  return getWorkflowTemplate(sid);
}

/**
 * 把一条模板**换个 id**（连同引用它的实例一起）。
 *
 * 只为内建模板那一次改名存在：它原来叫 `bandi-flow`，跟技能名撞了（2026-10-16 起叫
 * `bandi-delivery`）。**实例存的是 templateId 这个字符串**，不一起改的话老实例就指向
 * 一个不存在的模板 —— 节点查不出来，当前那一步会显示成"悬空"。
 *
 * 旧 id 不在、或新 id 已存在 → 返回 null，什么都不做（别猜，交给人处理）。
 * 故意**不动 `updatedAt`**：那是"多久没动了"的依据，改名不该让所有实例看着刚被动过。
 */

export function renameWorkflowTemplate(oldId, newId) {
  const from = getWorkflowTemplate(oldId);
  if (!from || getWorkflowTemplate(newId)) return null;
  const now = nowIso();
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO workflow_templates (id, name, steps, nodes, startNode, publishedAt, builtIn, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(newId, from.name, from.steps, from.nodes, from.startNode, from.publishedAt, from.builtIn, from.createdAt, now);
    db.prepare('DELETE FROM workflow_templates WHERE id = ?').run(oldId);
    db.prepare('UPDATE workflow_runs SET templateId = ? WHERE templateId = ?').run(newId, oldId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return getWorkflowTemplate(newId);
}

/* ------------------------------------------------- 工作流：实例 */


export function createWorkflowRun({
  templateId,
  title,
  note = null,
  threadId = null,
  intent = null,
  projectId = null, // 这条流程在哪个**项目**里干活（派活时用它当 cwd）
}) {
  const now = nowIso();
  const id = newId('wf');
  db.prepare(
    `INSERT INTO workflow_runs (id, templateId, title, status, currentStep, threadId, intent, note, projectId, createdAt, updatedAt)
     VALUES (?, ?, ?, '进行中', 0, ?, ?, ?, ?, ?, ?)`,
  ).run(id, templateId, title, threadId, intent, note, projectId, now, now);
  return getWorkflowRun(id);
}
/** 发布 / 下架。**草稿能编，发布的才能在工作台点开起流程** */

export function setTemplatePublished(id, on = true) {
  db.prepare('UPDATE workflow_templates SET publishedAt = ?, updatedAt = ? WHERE id = ?').run(
    on ? nowIso() : null,
    nowIso(),
    id,
  );
  return getWorkflowTemplate(id);
}
/** 某个会话里挂着的流程（一个项目群可以挂多条） */

export function listWorkflowRunsByThread(threadId) {
  return db
    .prepare("SELECT * FROM workflow_runs WHERE threadId = ? ORDER BY CASE status WHEN '进行中' THEN 0 ELSE 1 END, updatedAt DESC")
    .all(threadId);
}

export function getWorkflowRun(id) {
  return db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id) ?? null;
}

export function listWorkflowRuns({ limit = 100 } = {}) {
  // 进行中的排前面：看板首先要看的是"还在跑的"
  return db
    .prepare(
      `SELECT * FROM workflow_runs
        ORDER BY CASE status WHEN '进行中' THEN 0 ELSE 1 END, updatedAt DESC LIMIT ?`,
    )
    .all(limit);
}
/**
 * 删掉一条流程实例（连同它的步骤记录）。
 *
 * **只删流程自己的东西**：`workflow_runs` + `workflow_tasks`。
 * 各个经办人的会话和消息**一律不动** —— 那是员工自己的 1:1 对话，
 * 删流程不该顺手把人家的聊天记录也抹了。
 */

export function deleteWorkflowRun(id) {
  const run = getWorkflowRun(id);
  if (!run) return false;
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM workflow_tasks WHERE runId = ?').run(id);
    db.prepare('DELETE FROM workflow_runs WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return true;
}


export function setWorkflowRunStatus(id, status, note = null) {
  db.prepare('UPDATE workflow_runs SET status = ?, note = COALESCE(?, note), updatedAt = ? WHERE id = ?').run(
    status,
    note,
    nowIso(),
    id,
  );
  return getWorkflowRun(id);
}
/** 流程走到第几步了。同时把 updatedAt 推一下，列表排序才反映最新动静 */

export function setWorkflowCurrentStep(id, idx) {
  db.prepare('UPDATE workflow_runs SET currentStep = ?, updatedAt = ? WHERE id = ?').run(idx, nowIso(), id);
}
/**
 * 这一步在哪个会话里办。
 * 流程**不建群**：派给谁就发到谁那儿，这里记下当前这一步的会话，
 * 实例页的「去跟他说两句」和会话里的流程卡片都靠它。
 */

export function setWorkflowRunThread(id, threadId) {
  db.prepare('UPDATE workflow_runs SET threadId = ?, updatedAt = ? WHERE id = ?').run(threadId, nowIso(), id);
}

export function touchWorkflowRun(id) {
  db.prepare('UPDATE workflow_runs SET updatedAt = ? WHERE id = ?').run(nowIso(), id);
}

/* ------------------------------------------------- 工作流：任务（v2） */


export function createWorkflowTask(row) {
  const id = row.id || newId('wt2');
  db.prepare(
    `INSERT INTO workflow_tasks
       (id, runId, nodeId, nodeName, visit, detail, assigneePersonaId,
        status, decision, note, conversationId, agentRunId, startedAt, endedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, row.runId, row.nodeId, row.nodeName, row.visit ?? 1, row.detail ?? '',
    row.assigneePersonaId ?? null, row.status ?? '待办',
    row.decision ?? null, row.note ?? null, row.conversationId ?? null,
    row.agentRunId ?? null, row.startedAt ?? null, row.endedAt ?? null,
  );
  return db.prepare('SELECT * FROM workflow_tasks WHERE id = ?').get(id);
}
/** 办理痕迹：**按创建顺序**（rowid）—— 驳回打回后再来一次，靠的就是这个先后 */

export function listWorkflowTasks(runId) {
  return db.prepare('SELECT * FROM workflow_tasks WHERE runId = ? ORDER BY rowid').all(runId);
}

export function getWorkflowTask(runId, nodeId, visit = 1) {
  return db
    .prepare('SELECT * FROM workflow_tasks WHERE runId = ? AND nodeId = ? AND visit = ?')
    .get(runId, nodeId, visit) ?? null;
}

export function getWorkflowTaskByAgentRun(agentRunId) {
  if (!agentRunId) return null;
  return db.prepare('SELECT * FROM workflow_tasks WHERE agentRunId = ?').get(agentRunId) ?? null;
}
/** 这个节点被访问过几次（驳回打回会让它再来一次） */

export function countNodeVisits(runId, nodeId) {
  return db.prepare('SELECT COUNT(*) n FROM workflow_tasks WHERE runId = ? AND nodeId = ?').get(runId, nodeId).n;
}
/** 只覆盖传进来的字段（undefined 不覆盖） */
/**
 * 更新一步。**字段白名单**：不在 SET 里的字段会被**静默丢弃** ——
 * 踩过：`assigneePersonaId` 传进来以为改了，其实 SQL 没写它，改派一直不生效。
 * 以后往这儿加字段，记得同时加到 SET 里。
 */

export function updateWorkflowTask(id, fields) {
  const cur = db.prepare('SELECT * FROM workflow_tasks WHERE id = ?').get(id);
  if (!cur) return null;
  const next = { ...cur };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) next[k] = v;
  db.prepare(
    `UPDATE workflow_tasks
        SET status = ?, decision = ?, note = ?, result = ?, conversationId = ?, agentRunId = ?,
            assigneePersonaId = ?, startedAt = ?, endedAt = ?
      WHERE id = ?`,
  ).run(
    next.status,
    next.decision,
    next.note,
    next.result,
    next.conversationId,
    next.agentRunId,
    next.assigneePersonaId,
    next.startedAt,
    next.endedAt,
    id,
  );
  return db.prepare('SELECT * FROM workflow_tasks WHERE id = ?').get(id);
}

/** 实例当前停在哪个节点（v2 的核心：推进 = 换 currentNodeId） */

export function setWorkflowCurrentNode(id, nodeId) {
  db.prepare('UPDATE workflow_runs SET currentNodeId = ?, updatedAt = ? WHERE id = ?').run(nodeId, nowIso(), id);
}

/* ------------------------------------------------- 工作流：步骤（v1，只读） */


export function createWorkflowStep(row) {
  const id = row.id || newId('ws');
  db.prepare(
    `INSERT INTO workflow_steps
       (id, runId, idx, name, detail, assigneePersonaId, mode, status, note, conversationId, agentRunId, startedAt, endedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    row.runId,
    row.idx,
    row.name,
    row.detail ?? '',
    row.assigneePersonaId ?? null,
    row.mode ?? 'confirm',
    row.status ?? '待办',
    row.note ?? null,
    row.conversationId ?? null,
    row.agentRunId ?? null,
    row.startedAt ?? null,
    row.endedAt ?? null,
  );
  return getWorkflowStep(row.runId, row.idx);
}

export function listWorkflowSteps(runId) {
  return db.prepare('SELECT * FROM workflow_steps WHERE runId = ? ORDER BY idx').all(runId);
}

export function getWorkflowStep(runId, idx) {
  return db.prepare('SELECT * FROM workflow_steps WHERE runId = ? AND idx = ?').get(runId, idx) ?? null;
}
/** 按**这次 agent 执行**反查步骤 —— 执行跑完时靠它认领 */

export function getWorkflowStepByAgentRun(agentRunId) {
  if (!agentRunId) return null;
  return db.prepare('SELECT * FROM workflow_steps WHERE agentRunId = ?').get(agentRunId) ?? null;
}
/** 只覆盖传进来的字段（undefined 不覆盖，null 是"显式清空"） */

export function updateWorkflowStep(id, fields) {
  const cur = db.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(id);
  if (!cur) return null;
  const next = { ...cur };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) next[k] = v;
  db.prepare(
    `UPDATE workflow_steps
        SET status = ?, note = ?, conversationId = ?, agentRunId = ?, startedAt = ?, endedAt = ?
      WHERE id = ?`,
  ).run(next.status, next.note, next.conversationId, next.agentRunId, next.startedAt, next.endedAt, id);
  return db.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(id);
}


/* ---------------------------------------------------------------- 代码托管（GitHub 仓库） */
/*
 * 「一个仓库」是一等资源（2026-10-17 用户：我有很多个 git 仓库）：
 *   · 仓库连接/克隆/同步都记在这张表；项目与任务卡**引用**它（不把每个仓库硬变成项目）。
 *   · 真正的凭据（GitHub token）**不在这张表里**：单独一个文件、只在 git-repos.mjs 里读写。
 */
