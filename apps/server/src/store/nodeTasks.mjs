/*
 * store/nodeTasks.mjs —— 2026-11-09 由 store/nodes.mjs 拆出的**唯一幸存部分**。
 *
 * 多机节点子系统（nodes / node_jobs / node_paths / node_tokens / node_invites）已在
 * 2026-11-09 **彻底删除**（用户拍板：无存量机）。本机安装任务通道继续沿用 `node_tasks`
 * 表 —— 本机软件商店一键安装，nodeId 恒为 'local'。
 */

import { db, newId, nowIso } from './db.mjs';

/*
 * 本机安装任务 —— 外部件的某一步（装上 / 常驻 / 打开面板）。
 * （2026-10-16 建表时是"一键安装运行时"；2026-11-04 那半随 install-runtime 通路拆除，
 *   队列只剩外部件在用。）
 *
 * 本机软件商店一键安装（nodeId 恒为 'local'）：`runLocalExternal()` 在控制面进程内
 * 直接执行，排完就地领（`claimNodeTaskById`），不走"谁先来领"的队列序。
 *
 * ⚠️ 表里只存**外部件 id 和哪一步**，不存命令 —— 命令由本机自己查
 * （见 externals.commandFor）。这条是安全边界：控制面永远发不出命令。
 */

export function enqueueNodeTask({ nodeId, kind, family, arg = null }) {
  const id = newId('nt');
  db.prepare(
    `INSERT INTO node_tasks (id, nodeId, kind, family, status, output, arg, createdAt)
     VALUES (?, ?, ?, ?, '待领', '', ?, ?)`,
  ).run(id, nodeId, kind, family, arg ? String(arg) : null, nowIso());
  return getNodeTask(id);
}


export function getNodeTask(id) {
  return db.prepare('SELECT * FROM node_tasks WHERE id = ?').get(id) ?? null;
}

/** 取最老的"待领"并原子地标成"执行中"（同 claimNodeJob 的写法） */

export function claimNodeTask(nodeId) {
  const row = db
    .prepare("SELECT id FROM node_tasks WHERE nodeId = ? AND status = '待领' ORDER BY createdAt LIMIT 1")
    .get(nodeId);
  if (!row) return null;
  const up = db
    .prepare("UPDATE node_tasks SET status = '执行中', claimedAt = ? WHERE id = ? AND status = '待领'")
    .run(nowIso(), row.id);
  if (!up.changes) return null;
  return getNodeTask(row.id);
}

/**
 * **按 id** 原子领一件"待领"（本机安装用：排完就地执行，不走"谁先来领"的队列序）。
 * 已经开跑 / 已结束的返回 null —— 调用方据此不重复执行。
 */

export function claimNodeTaskById(id) {
  const up = db
    .prepare("UPDATE node_tasks SET status = '执行中', claimedAt = ? WHERE id = ? AND status = '待领'")
    .run(nowIso(), id);
  if (!up.changes) return null;
  return getNodeTask(id);
}

/**
 * 追加输出。**留最后 8000 字**：npm 装一次能刷几百行，全留着没意义，
 * 而人真正要看的是**末尾**（错在哪、装完没有）。
 */

export function appendNodeTaskOutput(id, chunk) {
  const t = getNodeTask(id);
  if (!t) return null;
  const next = (t.output + String(chunk ?? '')).slice(-8000);
  db.prepare('UPDATE node_tasks SET output = ? WHERE id = ?').run(next, id);
  return getNodeTask(id);
}


export function finishNodeTask(id, status = '完成') {
  db.prepare('UPDATE node_tasks SET status = ?, endedAt = ? WHERE id = ?').run(status, nowIso(), id);
  return getNodeTask(id);
}

/** 这台机器最近的任务（新的在前）—— 界面拿它显示"装到哪一步了" */

export function listNodeTasks(nodeId, limit = 5) {
  return db.prepare('SELECT * FROM node_tasks WHERE nodeId = ? ORDER BY createdAt DESC LIMIT ?').all(nodeId, limit);
}

/**
 * 开机收尸：**本机**的安装任务卡在 待领/执行中 的，一律标失败。
 *
 * 为什么只动本机（nodeId='local'，2026-11-04 用户连点四次安装全是僵尸的教训）：
 * 本机安装任务是 `runLocalExternal()` 在控制面**进程内**跑的 —— 控制面一重启，
 * 那个下载/安装进程必然已经没了，任务却永远停在「执行中」，界面跟着永远"安装中"。
 * 多机节点子系统已删除，这里只收 nodeId='local' 的行，不会再误伤别处。
 */
export function reapOrphanLocalTasks() {
  const rows = db
    .prepare("SELECT id, family, status FROM node_tasks WHERE nodeId = 'local' AND status IN ('待领','执行中')")
    .all();
  for (const t of rows) {
    db.prepare("UPDATE node_tasks SET status = '失败', endedAt = ? WHERE id = ?").run(nowIso(), t.id);
    db.prepare("UPDATE node_tasks SET output = output || ? WHERE id = ?").run(
      '\n班底重启时这件活还在跑 —— 执行进程已经没了，按失败算；要装再点一次。',
      t.id,
    );
  }
  return rows.length;
}


/** 界面上要的公开形状：状态就是一句人话，不用前端再翻译一遍 */

export function publicNodeTask(t) {
  if (!t) return null;
  return {
    id: t.id,
    nodeId: t.nodeId,
    kind: t.kind,
    family: t.family,
    // 参数（走镜像装的那个前缀）—— 界面要显示"这次是走镜像装的"
    arg: t.arg ?? null,
    status: t.status,
    output: t.output,
    createdAt: t.createdAt,
    endedAt: t.endedAt,
    running: t.status === '执行中',
    done: t.status === '完成' || t.status === '失败',
  };
}
