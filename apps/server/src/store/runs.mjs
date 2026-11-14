/* store/runs.mjs —— 2026-10-22 由 store.mjs 按域拆出。SQL 只在 store/ 目录内。 */

import { db, newId, nowIso } from './db.mjs';

export function countActiveRunsForPersona(personaId) {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM runs WHERE personaId = ? AND status = 'running'").get(personaId)?.n ?? 0
  );
}

/** 这个项目里有没有正在跑的活（同一目录同时只许一个 —— 两个进程改同一份代码必出事） */

export function activeRunForProject(projectId) {
  if (!projectId) return null;
  return (
    db.prepare("SELECT * FROM runs WHERE projectId = ? AND status = 'running' ORDER BY startedAt DESC").get(projectId) ??
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
    db.prepare("SELECT COUNT(*) AS n FROM runs WHERE projectId = ? AND status = 'running'").get(projectId)?.n ?? 0
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
    status: 'running',
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

/**
 * 这段 CLI 会话里已经跑了几轮（2026-11-11 上下文预算）：runs.startedAt ≥ 会话起点。
 * 轮换后 member_sessions.startedAt 清空，下一轮重开时重新记 —— 计数自然从零开始。
 */
export function countRunsSince(conversationId, personaId, sinceIso) {
  if (!sinceIso) return 0;
  return Number(
    db
      .prepare('SELECT COUNT(*) AS c FROM runs WHERE conversationId = ? AND personaId = ? AND startedAt >= ?')
      .get(conversationId, personaId, sinceIso)?.c ?? 0,
  );
}

/**
 * 这条会话最近几轮的 usage（新的在前；没有 usage 的跳过）。
 * dsh 的 usage 是**会话累计**（inputTokens 单调增）→ 预算模块用相邻两轮的差值估算"这一轮的上下文"；
 * 单轮型运行时（codex/claude）则直接拿最近一轮的 inputTokens。
 */
export function listRecentRunUsage(conversationId, personaId, limit = 2) {
  const n = Math.max(1, Math.min(Number(limit) || 2, 10));
  return db
    .prepare(
      `SELECT usage, startedAt FROM runs
        WHERE conversationId = ? AND personaId = ? AND usage IS NOT NULL
        ORDER BY startedAt DESC LIMIT ?`,
    )
    .all(conversationId, personaId, n)
    .map((r) => ({ usage: r.usage ? JSON.parse(r.usage) : null, startedAt: r.startedAt }));
}

/* ---------------------------------------------------- 运行事件流（落库那份） */

/**
 * 单条运行事件的落库上限（2026-11-09，给增长封顶）。
 *
 * 为什么要有：`run_events` 是**整条工具输出原样落库**的（`detail.aggregated_output`），
 * 一次 `dir /s` / `Get-ChildItem -Recurse` 就能到 1.2 MB；本机 3,925 条事件里前 10 条
 * 就占了 3.6 MB。事件流是用来"看清他在干什么"的，不是归档日志原文的 —— 64 KB 已经
 * 远超界面一屏（前端本来也是折叠展示）。超了就把长字符串截断，**仍是合法 JSON**
 * （重放/SSE 都按 JSON 解析，不能把结构切坏）。
 *
 * 截断策略：先按 8 KB / 2 KB / 256 B 三档逐级压每个字符串字段；还超就退成
 * `{type, truncated, originalBytes, note}` 的壳（至少还能看出"这是什么事件、被截了"）。
 */
export const RUN_EVENT_MAX_BYTES = 64 * 1024;
const RUN_EVENT_TRUNC = '\n…（事件过大，已截断）';

const byteLen = (s) => Buffer.byteLength(s);

/** 深拷贝并把每个字符串压到 maxLen —— 只用于超限事件，正常事件不进来 */
function capStrings(v, maxLen) {
  if (typeof v === 'string') return v.length > maxLen ? v.slice(0, maxLen) + RUN_EVENT_TRUNC : v;
  if (Array.isArray(v)) return v.map((x) => capStrings(x, maxLen));
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = capStrings(v[k], maxLen);
    return out;
  }
  return v;
}

/**
 * 序列化一条事件（超限则截断）。**落库和 SSE 广播共用这一份结果** ——
 * 两边不一样的话，实时看到的是全文、刷新重放却是截断版，用户会以为丢了东西。
 */
export function stringifyRunEvent(evt) {
  const full = JSON.stringify(evt);
  if (byteLen(full) <= RUN_EVENT_MAX_BYTES) return full;
  for (const cap of [8192, 2048, 256]) {
    const json = JSON.stringify(capStrings(evt, cap));
    if (byteLen(json) <= RUN_EVENT_MAX_BYTES) return json;
  }
  const bytes = byteLen(full);
  return JSON.stringify({
    type: String(evt?.type ?? 'raw'),
    truncated: true,
    originalBytes: bytes,
    note: `事件过大（${bytes} 字节），内容已省略`,
  });
}

/**
 * 落一条事件。`seq` 由调用方给（runs.mjs 在内存里递增，新运行从 1 起）。
 *
 * 用 `INSERT OR REPLACE` 而不是裸 `INSERT`：这条路径在**热路径**上
 * （适配器每吐一行 JSON 就走一次），抛异常会把整次运行的收尾带崩；
 * 而重复的 seq 在正常流程里不可能出现 —— 它就等于内存里那个计数器。
 *
 * 返回**真正落库的那份 JSON**（超限已截断）：广播要用同一份，见 stringifyRunEvent。
 */

export function appendRunEvent(runId, seq, evt) {
  const json = stringifyRunEvent(evt);
  db.prepare('INSERT OR REPLACE INTO run_events (runId, seq, evt, at) VALUES (?, ?, ?, ?)').run(
    runId,
    seq,
    json,
    nowIso(),
  );
  return json;
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
 * **一次运行的证据摘要**（2026-11-09 检修 P2：证据与对话分离）。
 *
 * 为什么要在服务端出一份"摘要"：回话正文不该再贴命令/输出（那是运行事件的内容），
 * 前端给一颗「证据」就能展开看"这轮调了什么工具、成没成、错在哪"。
 * 但**不能把完整事件流怼给界面**（一跑上千条、单条能到 64 KB），所以这里只抽：
 * 状态/时长/事件数 + 前 20 条工具（名字 + 目标，目标截 200 字）+ 前 5 条错误。
 * 细节要追溯到原始事件，仍走 `/api/runs/:id/stream`（回放），这里只做"索引"。
 */
export function compactRunEvidence(runId) {
  const run = getRunRow(runId);
  if (!run) return null;
  const rows = db.prepare('SELECT seq, evt FROM run_events WHERE runId = ? ORDER BY seq').all(runId);
  const tools = [];
  const errors = [];
  for (const r of rows) {
    let evt;
    try {
      evt = JSON.parse(r.evt);
    } catch {
      continue; // 坏行跳过，别为一条脏数据把索引弄挂
    }
    if (evt?.type === 'tool') {
      const d = evt.detail ?? {};
      const target =
        d.command ?? d.path ?? d.file ?? d.url ?? (d.server && d.tool ? `${d.server} · ${d.tool}` : '') ?? '';
      tools.push({ seq: r.seq, name: String(evt.name ?? 'tool'), target: String(target).slice(0, 200) });
    } else if (evt?.type === 'error') {
      errors.push(String(evt.message ?? evt.text ?? '').slice(0, 300));
    }
  }
  return {
    runId,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    events: rows.length,
    toolCount: tools.length,
    tools: tools.slice(-20), // 尾部更接近"最后干了什么"；前面的是索引，不是流水账
    errors: errors.slice(0, 5),
  };
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
    db.prepare("SELECT * FROM runs WHERE conversationId = ? AND status = 'running' ORDER BY startedAt DESC").get(conversationId) ??
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
      .prepare("SELECT * FROM runs WHERE personaId = ? AND status = 'running' ORDER BY startedAt DESC LIMIT 1")
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
  const stale = db.prepare("SELECT id, conversationId FROM runs WHERE status = 'running'").all();
  for (const r of stale) {
    const note = '服务重启，这次运行被中断';
    db.prepare("UPDATE runs SET status = 'failed', error = ?, endedAt = ? WHERE id = ?").run(note, nowIso(), r.id);
    db.prepare("UPDATE conversations SET status = 'failed', updatedAt = ? WHERE id = ?").run(nowIso(), r.conversationId);

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
      status: 'failed',
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

