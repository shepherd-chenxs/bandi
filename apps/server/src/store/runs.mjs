/* store/runs.mjs —— 2026-10-22 由 store.mjs 按域拆出。SQL 只在 store/ 目录内。 */

import { db, newId, nowIso } from './db.mjs';

export function countActiveRunsForPersona(personaId) {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM runs WHERE personaId = ? AND status = '跑中'").get(personaId)?.n ?? 0
  );
}

/** 这个项目里有没有正在跑的活（同一目录同时只许一个 —— 两个进程改同一份代码必出事） */

export function activeRunForProject(projectId) {
  if (!projectId) return null;
  return (
    db.prepare("SELECT * FROM runs WHERE projectId = ? AND status = '跑中' ORDER BY startedAt DESC").get(projectId) ??
    null
  );
}

/**
 * 这个项目里正有几个活在跑（2026-10-24）：项目闸从"只许一件"放开成**安全网**
 *（真正的并发限制在每个人身上，见 personas.maxParallel）—— 这里只挡病态堆积
 *（一群人把同一个目录塞满几十个进程），不做日常限流。
 */
export function countActiveRunsForProject(projectId) {
  if (!projectId) return 0;
  return (
    db.prepare("SELECT COUNT(*) AS n FROM runs WHERE projectId = ? AND status = '跑中'").get(projectId)?.n ?? 0
  );
}


/** 把会话的模型覆盖设成某个值；传 null / 空 = 收回，跟随员工默认 */

export function listRunsForPersona(personaId, limit = 12) {
  return db
    .prepare(
      `SELECT r.* FROM runs r JOIN conversations c ON c.id = r.conversationId
        WHERE c.personaId = ? ORDER BY r.startedAt DESC LIMIT ?`,
    )
    .all(personaId, limit)
    .map((r) => ({ ...r, usage: r.usage ? JSON.parse(r.usage) : null }));
}

/* ----------------------------------------------------------- conversations */


export function createRun({ conversationId, runtime, personaId = null, model = null, taskId = null, projectId = null }) {
  const row = {
    id: newId('r'),
    conversationId,
    runtime,
    personaId,
    model,
    // 是流程的一步就记下那一步（taskId = workflow_tasks.id）；手动聊天留空
    taskId,
    // 这次在哪个项目里干活（项目互斥靠它判：同一目录同时只许一个 run）
    projectId,
    status: '跑中',
    exitCode: null,
    error: null,
    usage: null,
    startedAt: nowIso(),
    endedAt: null,
  };
  db.prepare(
    `INSERT INTO runs (id, conversationId, runtime, personaId, model, taskId, projectId, status, exitCode, error, usage, startedAt, endedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.conversationId,
    row.runtime,
    row.personaId,
    row.model,
    row.taskId,
    row.projectId,
    row.status,
    row.exitCode,
    row.error,
    row.usage,
    row.startedAt,
    row.endedAt,
  );
  return row;
}


export function finishRun(id, { status, exitCode = null, error = null, usage = null }) {
  db.prepare('UPDATE runs SET status = ?, exitCode = ?, error = ?, usage = ?, endedAt = ? WHERE id = ?').run(
    status,
    exitCode,
    error,
    usage ? JSON.stringify(usage) : null,
    nowIso(),
    id,
  );
}

/* ---------------------------------------------------- 运行事件流（落库那份） */

/**
 * 落一条事件。`seq` 由调用方给（runs.mjs 在内存里递增，新运行从 1 起）。
 *
 * 用 `INSERT OR REPLACE` 而不是裸 `INSERT`：这条路径在**热路径**上
 * （适配器每吐一行 JSON 就走一次），抛异常会把整次运行的收尾带崩；
 * 而重复的 seq 在正常流程里不可能出现 —— 它就等于内存里那个计数器。
 */

export function appendRunEvent(runId, seq, evt) {
  db.prepare('INSERT OR REPLACE INTO run_events (runId, seq, evt, at) VALUES (?, ?, ?, ?)').run(
    runId,
    seq,
    JSON.stringify(evt),
    nowIso(),
  );
}

/**
 * 增量取：只要 `seq > afterSeq` 的，按 seq 升序。
 * **SSE 断线重连靠它只补缺口** —— 全量重放会把回话重复追加一遍。
 */

export function listRunEvents(runId, afterSeq = 0) {
  const from = Math.max(0, Number(afterSeq) || 0);
  return db
    .prepare('SELECT seq, evt FROM run_events WHERE runId = ? AND seq > ? ORDER BY seq')
    .all(runId, from);
}

/** 这次运行最后一条事件 —— 「到底了没有」就看它是不是终止事件 */

export function lastRunEvent(runId) {
  return db.prepare('SELECT seq, evt FROM run_events WHERE runId = ? ORDER BY seq DESC LIMIT 1').get(runId) ?? null;
}

/**
 * 这次运行**尾部** n 条事件（seq 倒序）。
 * 给 `errorForDisplay`（apps/server/src/runs.mjs）用：失败原因总在事件流末尾
 * （error / final 都是终止事件），别为了补一句话把整段事件流（可能上千行）读出来再丢掉 99%。
 */
export function tailRunEvents(runId, n = 50) {
  return db
    .prepare('SELECT seq, evt FROM run_events WHERE runId = ? ORDER BY seq DESC LIMIT ?')
    .all(runId, Math.max(1, n));
}

/** 已经用到第几个号（启动清账时接着往下写；新运行是 0） */

export function maxRunSeq(runId) {
  return db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM run_events WHERE runId = ?').get(runId)?.n ?? 0;
}


export function listRuns(conversationId) {
  /* 带上执行者名字（2026-10-23）：群聊"对方正在输入"的气泡要按名字找头像，
     runs 表只有 personaId，前端拿到名字才能命中 personas 的 avatar。 */
  return db
    .prepare(`SELECT r.*, p.name AS personaName
                FROM runs r LEFT JOIN personas p ON p.id = r.personaId
               WHERE r.conversationId = ? ORDER BY r.startedAt DESC`)
    .all(conversationId);
}

/**
 * 这次执行是不是**某条流程的一步**？（任务面板靠它把流程轮次从"聊天派活"里剔出去）
 *
 * 按可靠性从高到低：
 *   ① `runs.taskId` 非空 —— 派活时就记下的**事实**（2026-10-14 起有）。
 *   ② `workflow_tasks.agentRunId` = 本次执行 —— 这一步最近一次执行。
 *   ③ 消息 `runId = 本次执行 AND taskId 非空` —— 一步多轮里更早的轮次。
 *   ④ **时间窗**：这个会话里有一条流程任务，它的办理区间盖住了本次执行的开始时间
 *      —— 历史数据（①还没有的时候）靠它兜底：驳回打回、追问续轮都会落在这个窗口里。
 *
 * 参数收 **run 行**（要 conversationId / startedAt）；传 id 只走 ①②③。
 */

export function runBelongsToWorkflow(runOrId) {
  const run = typeof runOrId === 'string' ? { id: runOrId } : (runOrId ?? {});
  const id = run.id;
  if (!id) return false;
  if (run.taskId) return true; // ①
  if (db.prepare('SELECT 1 FROM workflow_tasks WHERE agentRunId = ? LIMIT 1').get(id)) return true; // ②
  if (db.prepare('SELECT 1 FROM messages WHERE runId = ? AND taskId IS NOT NULL LIMIT 1').get(id)) return true; // ③
  if (run.conversationId && run.startedAt) {
    // ④ 时间窗：这个会话里有一条流程任务，它的办理区间盖住了本次执行的开始时间
    const hit = db
      .prepare(
        `SELECT 1 FROM workflow_tasks
          WHERE conversationId = ?
            AND startedAt IS NOT NULL AND startedAt <= ?
            AND (endedAt IS NULL OR endedAt >= ?)
          LIMIT 1`,
      )
      .get(run.conversationId, run.startedAt, run.startedAt);
    if (hit) return true;

    // ⑤ **触发消息**：本次执行开始前，会话里最后一句用户话。
    //    流程派活的那句带 `runId`（那条流程实例的 id）；手动聊天的是 null。
    //    这一条最经用 —— 失败/中止、连回复都没产出的轮次，①②③④ 都可能漏，它不漏。
    const trigger = db
      .prepare(
        `SELECT taskId, runId FROM messages
          WHERE conversationId = ? AND role = 'user' AND createdAt <= ?
          ORDER BY rowid DESC LIMIT 1`,
      )
      .get(run.conversationId, run.startedAt);
    if (trigger && (trigger.taskId || trigger.runId)) return true;
  }
  return false;
}

/** 这个会话里最后一句**用户**说的话（面板拿它当"聊天派活"的任务名） */

export function lastUserMessage(conversationId) {
  const row = db
    .prepare("SELECT text FROM messages WHERE conversationId = ? AND role = 'user' ORDER BY rowid DESC LIMIT 1")
    .get(conversationId);
  return row?.text ?? '';
}


export function activeRun(conversationId) {
  return (
    db.prepare("SELECT * FROM runs WHERE conversationId = ? AND status = '跑中' ORDER BY startedAt DESC").get(conversationId) ??
    null
  );
}

/**
 * 这个数字员工现在忙不忙（有没有正在跑的活）。
 * 通讯录里要一眼看出"谁能马上接活" —— 挨个进会话看状态太蠢。
 *
 * **直接看运行上记的 personaId**，别去 join 会话反推：
 * 活可能在 1:1 里干，也可能在群里干（群里的活记在 thread_members，不是 owner/助手）——
 * 之前用"会话的 personaId 或 assistantPersonaId"判断，**群里的活会漏**，
 * 于是明明在写代码却显示"闲"（用户实报）。
 */

export function activeRunForPersona(personaId) {
  return (
    db
      .prepare("SELECT * FROM runs WHERE personaId = ? AND status = '跑中' ORDER BY startedAt DESC LIMIT 1")
      .get(personaId) ?? null
  );
}

/**
 * 启动清账。
 *
 * 运行状态在内存里，进程一死（重启、崩溃）就没了，可 DB 里那行还写着「跑中」——
 * 于是这个会话会永远被"他还在跑"挡住。所以每次启动先把残留的「跑中」判死。
 */

export function reapStaleRuns() {
  const stale = db.prepare("SELECT id, conversationId FROM runs WHERE status = '跑中'").all();
  for (const r of stale) {
    const note = '服务重启，这次运行被中断';
    db.prepare("UPDATE runs SET status = '失败', error = ?, endedAt = ? WHERE id = ?").run(note, nowIso(), r.id);
    db.prepare("UPDATE conversations SET status = '失败', updatedAt = ? WHERE id = ?").run(nowIso(), r.conversationId);

    /*
     * 还要给它补一条**终止事件**（2026-10-15）。
     *
     * 不补的话，界面重连时会拿到已有的那半段事件、然后**永远等不到 `__done`** ——
     * 连接挂着、状态停在一半，用户看到的是"还在跑"。
     * 补上，重连就能「重放完 + 收尾」一次走到底。
     */
    appendRunEvent(r.id, maxRunSeq(r.id) + 1, {
      type: '__done',
      runId: r.id,
      status: '失败',
      exitCode: null,
      error: note,
      usage: null,
      sessionId: null,
      finalText: '',
      elapsedMs: null,
      connectors: null,
    });
  }
  return stale.length;
}

/* --------------------------------------------------------- 执行节点注册表 */

/*
 * 节点：一台机器上的常驻进程，**主动连出**到控制面（注册 + 心跳）。
 *
 * 为什么落库、不落文件：心跳是每台机器十几秒一次的高频写 —— 文件每次都要整份重写，
 * 两台以上就容易互相盖掉。而「谁在线」本来就属于**控制面持有的状态**
 * （见 docs/形态决策.md 的权威边界）。
 *
 * runtimes 是节点**自报**的清单（JSON），这一版**只读展示**：远程执行还没做，
 * 所以它不进 runtimes.loadDevices()，也就不会被派活挑中 ——
 * 否则控制面会拿着一个只有那台机器才有的路径，在本机去 spawn。
 */

export function listRunUsageSince(sinceIso) {
  return db.prepare('SELECT model, usage FROM runs WHERE startedAt >= ?').all(sinceIso);
}

/** 一次运行的状态。以前调用方是直接伸进 db 查的 —— 外面不该有 SQL */

export function getRunStatus(runId) {
  return db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) ?? null;
}

/** 单次运行整行（含 conversationId —— 卡片回执要送回建卡那次运行所在的会话） */
export function getRunRow(runId) {
  return db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) ?? null;
}

/* ------------------------------------------------- 工作流：模板 */

