/* store/projects.mjs —— 2026-10-22 由 store.mjs 按域拆出。SQL 只在 store/ 目录内。 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db, ensureColumn, newId, nowIso } from './db.mjs';
import { getConversation } from './conversations.mjs';
import { getWorkflowRun } from './workflows.mjs';

function ensureProjects() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      root        TEXT NOT NULL,
      extraRoots  TEXT,
      note        TEXT,
      createdAt   TEXT NOT NULL,
      updatedAt   TEXT NOT NULL
    );
  `);
  ensureColumn('conversations', 'projectId', 'projectId TEXT');
  ensureColumn('workflow_runs', 'projectId', 'projectId TEXT');
  ensureColumn('projects', 'builtIn', 'builtIn INTEGER NOT NULL DEFAULT 0');
  // 项目宪法：本项目特有的硬约束，派活时注入首轮 prompt（见 dispatch.projectConstitutionBlock）。
  // 存平台不落项目仓库 —— 可空 = 没写宪法，派活时什么都不注。
  ensureColumn('projects', 'constitution', 'constitution TEXT');
  // 消息归属哪一步：**按标记取，不再靠时间窗口切**
  // （1:1 会话被多条流程共用，按时间切会把别的流程的派活也捞进来，用户实报）
  ensureColumn('messages', 'taskId', 'taskId TEXT');
  /*
   * **评论区的"回复挂在哪个议题下"**（2026-10-18）。
   * 只允许**一层**：`parentId` 永远指向一条顶层评论（议题），回复本身不再被回复。
   * NULL = 顶层议题。嵌套再深在侧栏里缩没了，人也不会那么用。
   */
  ensureColumn('messages', 'parentId', 'parentId TEXT');
  /*
   * **留言**（2026-10-19 用户定）：卡片评论里选了「只留言」的那条 —— 不叫醒执行人，
   * 但**不是丢弃**：派活时由 dispatch 把上次水位线之后的这些便签一并补给他
   * （见 dispatch.backfillBlock）。存成列而不是塞进正文前缀，是为了"再发一次"、
   * 统计和将来"把便签并进派活"这类操作都能按结构取。
   */
  ensureColumn('messages', 'note', 'note INTEGER NOT NULL DEFAULT 0');

  /*
   * **手工任务**（用户 2026-10-14，参照 Multica 的看板）：在项目的某一列点「＋」直接建的任务。
   * 跟流程/聊天那两种来源并列，是"这个项目里有哪些活"的第三种来源。
   *
   *   · status 用流程那套词（待办 / 进行中 / 待确认 / 已阻塞 / 已完成）—— 看板按它站列；
   *   · assigneePersonaId 空 = 还没派人（只挂在看板上，不起进程）；
   *   · conversationId / runId：选了执行人并"立即开始工作"时，派到谁的会话里、跑的是哪一次。
   */
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_tasks (
      id                 TEXT PRIMARY KEY,
      projectId          TEXT NOT NULL,
      title              TEXT NOT NULL,
      description        TEXT NOT NULL DEFAULT '',
      status             TEXT NOT NULL DEFAULT '待办',
      assigneePersonaId  TEXT,
      conversationId     TEXT,
      runId              TEXT,
      createdAt          TEXT NOT NULL,
      updatedAt          TEXT NOT NULL
    );
  `);
}

ensureProjects();

/*
 * 本地卡（`project_tasks`：手工建的、以及**仓库值班写进来的**）—— 同一张表同一族：
 *   · `source`：'manual' = 人在列头「＋」建的；'repo' = 仓库巡检写进来的（看板上标「仓库值班」）；
 *   · `externalKey`：**去重键**（如 `pr:3` / `issue:2` / `note:branch-protection`）——
 *     同一个 PR 巡检十次也只该有一张卡，重复写要更新而不是再建一张。
 * 两者都能拖、都能删（**卡的状态就是人给它的指令**）。
 */

ensureColumn('project_tasks', 'source', "source TEXT NOT NULL DEFAULT 'manual'");

ensureColumn('project_tasks', 'externalKey', 'externalKey TEXT');
// 排队标记：派活撞上"人满了 / 项目正忙"时落一个时间，30 秒节拍重试（见 schedules.mjs）。
// ⚠️ 必须放在 project_tasks 建表**之后**（放前面会在新库上 no such table）

ensureColumn('project_tasks', 'queuedAt', 'queuedAt TEXT');
/*
 * 流程的一步 ↔ 一张卡（2026-10-19）：`sourceKey` = `flow:<runId>:<nodeId>:<visit>`，
 * `sourceRunId` 单独存一份只是为了以后按流程反查不用解字符串。
 *
 * ⚠️ 这两列**只用来认身份**，不改卡的脾气 —— 它照样能拖、能改状态、能派活。
 *    流程自己的状态在 `workflow_tasks`，两处各记各的、不强行同步
 *    （同步了会互相覆盖：流程说"这一步办完了"，卡可能是人后来手动标了新状态）。
 * 老卡这两列是 null —— `ensureTaskCardForStep` 会按标题把它们认下来并补上。
 */

ensureColumn('project_tasks', 'sourceKey', 'sourceKey TEXT');

ensureColumn('project_tasks', 'sourceRunId', 'sourceRunId TEXT');

/**
 * 内置的默认项目：`<文档>\bandi\default-workspace`。
 *
 * 为什么要内置：一个项目都没有时，跟数字员工说"去改 xxx"，它**没有任何地方能干活**。
 * 先给一个真实存在的目录兜住。
 * 目录不存在就**建出来** —— 光有条记录、点进去发现目录不在，比没有更糟。
 *
 * ⚠️ 它以前叫「默认工作区」。词汇统一之后 —— **项目就是那个实体，不再有"工作区"这个别名**
 *    （同一个东西两个名字，用户在发起流程那个下拉里看到的是"工作区"、去工作台却只能"新建项目"）。
 */

export const DEFAULT_PROJECT_NAME = '默认项目';

export function defaultProjectRoot() {
  // 中文系统上"文档"这个 shell 文件夹的真实名仍是 Documents，所以这条路走得通
  return path.join(os.homedir(), 'Documents', 'bandi', 'default-workspace');
}


function ensureDefaultWorkspace() {
  const root = defaultProjectRoot();
  const builtIn = db.prepare('SELECT id, root, name FROM projects WHERE builtIn = 1').get();
  if (builtIn) {
    // 词汇统一的一次性订正：内置那个项目以前叫「默认工作区」。
    // **只改还叫旧名的那条** —— 用户自己改过名字（或改过规则）就别动他的。
    if (builtIn.name === '默认工作区') {
      db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(DEFAULT_PROJECT_NAME, builtIn.id);
    }
    try {
      fs.mkdirSync(builtIn.root, { recursive: true }); // 目录被删了 → 补回来
    } catch { /* 建不出来也不该拦住启动 */ }
    return;
  }
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (e) {
    console.warn(`默认项目目录建不出来（${root}）：${e.message}`);
  }
  // 同路径如果已经有人手建过，就把它转成内置，别多出一条重复的
  const same = db.prepare('SELECT id FROM projects WHERE root = ?').get(root);
  if (same) {
    db.prepare('UPDATE projects SET builtIn = 1, name = ? WHERE id = ?').run(DEFAULT_PROJECT_NAME, same.id);
    return;
  }
  const t = nowIso();
  db.prepare(
    'INSERT INTO projects (id, name, root, extraRoots, note, builtIn, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
  ).run(
    newId('pj'),
    DEFAULT_PROJECT_NAME,
    root,
    '[]',
    '内置：还没建项目时，AI 先在这儿干活',
    t,
    t,
  );
  console.log(`内置默认项目：${root}`);
}

ensureDefaultWorkspace();


export function listProjects() {
  // 「默认项目」(内置) 永远排到最后，其余按 updatedAt 倒序。
  return db
    .prepare('SELECT * FROM projects ORDER BY builtIn ASC, updatedAt DESC')
    .all();
}

export function getProject(id) {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) ?? null;
}

export function createProject({ name, root, extraRoots = [], note = null }) {
  const id = newId('pj');
  const t = nowIso();
  db.prepare(
    'INSERT INTO projects (id, name, root, extraRoots, note, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, name, root, JSON.stringify(extraRoots ?? []), note, t, t);
  return getProject(id);
}

export function updateProject(id, fields) {
  const cur = getProject(id);
  if (!cur) return null;
  const next = {
    name: fields.name ?? cur.name,
    root: fields.root ?? cur.root,
    extraRoots: fields.extraRoots === undefined ? cur.extraRoots : JSON.stringify(fields.extraRoots ?? []),
    note: fields.note === undefined ? cur.note : fields.note,
    // 宪法：空串归一成 NULL（没写就是没写，别存一条 ''）
    constitution:
      fields.constitution === undefined
        ? cur.constitution
        : String(fields.constitution ?? '').trim() || null,
  };
  db.prepare(
    'UPDATE projects SET name = ?, root = ?, extraRoots = ?, note = ?, constitution = ?, updatedAt = ? WHERE id = ?',
  ).run(next.name, next.root, next.extraRoots, next.note, next.constitution, nowIso(), id);
  return getProject(id);
}
/** 删项目**不动会话**：把绑在它上面的会话解绑（回到员工默认工作目录） */

export function deleteProject(id) {
  const cur = getProject(id);
  if (!cur) return false;
  // 内置的不能删：删了就没有兜底的地方了。要换地方就改它的目录，或者另建一个
  if (cur.builtIn) return false;
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE conversations SET projectId = NULL WHERE projectId = ?').run(id);
    db.prepare('UPDATE workflow_runs SET projectId = NULL WHERE projectId = ?').run(id);
    // 手工任务是"这个项目的活"，项目没了它们也没了归属 —— 一起删（跟上面两处"解绑"不同：
    // 会话和流程实例是独立的东西，手工任务不是，它的全部意义就是挂在某个项目上）
    db.prepare('DELETE FROM project_tasks WHERE projectId = ?').run(id);
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return true;
}

/* --------------------------------------------------------- 手工任务（看板上的卡） */


export function projectRoots(p) {
  if (!p) return null;
  let extra = [];
  try {
    extra = JSON.parse(p.extraRoots || '[]');
  } catch {
    extra = [];
  }
  return [p.root, ...extra.filter(Boolean)];
}


export function setConversationProject(id, projectId) {
  db.prepare('UPDATE conversations SET projectId = ? WHERE id = ?').run(projectId || null, id);
  return getConversation(id);
}


export function setWorkflowRunProject(id, projectId) {
  db.prepare('UPDATE workflow_runs SET projectId = ? WHERE id = ?').run(projectId || null, id);
  return getWorkflowRun(id);
}

/* ---------------------------------------------------------------- personas */

/**
 * 员工列表，带"最近一段对话"的摘要 —— 前端要把它当联系人列表渲染。
 */

ensureColumn('project_tasks', 'prRepo', 'prRepo TEXT');

ensureColumn('project_tasks', 'prNumber', 'prNumber INTEGER');

ensureColumn('project_tasks', 'prState', 'prState TEXT');      // open | merged | closed

ensureColumn('project_tasks', 'prTitle', 'prTitle TEXT');

ensureColumn('project_tasks', 'prCheckedAt', 'prCheckedAt TEXT');

/** 所有关联了 PR 的卡（批量刷新用） */
