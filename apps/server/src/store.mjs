import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { dataDir, dbPath } from './config.mjs';

fs.mkdirSync(dataDir, { recursive: true });

/*
 * ⚠️ **不导出 `db`**（2026-10-15）。以前导出过，于是 quota.mjs 自己攒了一整套 SQL、
 * server.mjs 也直接伸进来查一句 —— 想换库的时候要改的地方就散成了三处。
 * 规矩：**SQL 只出现在这个文件里**（见 docs/形态决策.md §十二 第 2 条）；
 * 外面要什么，就在这儿加一个函数。
 */
const db = new DatabaseSync(dbPath);

db.exec(`PRAGMA journal_mode = WAL;`);

db.exec(`
  CREATE TABLE IF NOT EXISTS personas (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    instructions  TEXT NOT NULL DEFAULT '',
    runtime       TEXT NOT NULL DEFAULT 'codex',
    sandbox       TEXT NOT NULL DEFAULT 'workspace-write',
    cwd           TEXT,
    model         TEXT,
    createdAt     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    personaId     TEXT NOT NULL,
    sessionId     TEXT,
    status        TEXT NOT NULL DEFAULT '待跑',
    createdAt     TEXT NOT NULL,
    updatedAt     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    conversationId  TEXT NOT NULL,
    runId           TEXT,
    role            TEXT NOT NULL,
    text            TEXT NOT NULL,
    createdAt       TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS runs (
    id              TEXT PRIMARY KEY,
    conversationId  TEXT NOT NULL,
    runtime         TEXT NOT NULL,
    status          TEXT NOT NULL,
    exitCode        INTEGER,
    error           TEXT,
    usage           TEXT,
    startedAt       TEXT NOT NULL,
    endedAt         TEXT
  );

  -- 群成员（1:1 会话不登记：它的成员就是 conversations.personaId）
  CREATE TABLE IF NOT EXISTS thread_members (
    threadId    TEXT NOT NULL,
    personaId   TEXT NOT NULL,
    joinedAt    TEXT NOT NULL,
    PRIMARY KEY (threadId, personaId)
  );

  -- 每个成员在每个会话里各有一条自己的 runtime 会话 + 一条"读到哪儿了"的水位线。
  -- 群聊必须这样：否则两个成员会共用一条上下文，互相污染。
  --
  -- scope：这条 session 是**哪个作用域**的。空串 = 普通会话（手动聊天）。
  -- 'wf:<流程实例id>' = 某一条流程。为什么必须分作用域：经办人只有一个 1:1 会话，
  -- 而那个会话被**多条流程共用**，sessionId 又恰恰是"上下文"本身 —— 不隔离的话，
  -- 新起一条流程会直接续接上一条流程的会话，带着旧记忆开跑。
  -- 隔离之后：**发起一条新流程 = 这个员工那边开一条全新会话**（等于 dsh 新开一个 session）。
  CREATE TABLE IF NOT EXISTS member_sessions (
    threadId       TEXT NOT NULL,
    personaId      TEXT NOT NULL,
    scope          TEXT NOT NULL DEFAULT '',
    sessionId      TEXT,
    lastSeenRowid  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (threadId, personaId, scope)
  );

  -- skill 挂载关系。skill 正文是文件（平台根下 skills/），这里只记「谁挂了哪些」
  CREATE TABLE IF NOT EXISTS persona_skills (
    personaId  TEXT NOT NULL,
    skillName  TEXT NOT NULL,
    addedAt    TEXT NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 1,   -- 0 = 留着但暂停（不注入 prompt）
    PRIMARY KEY (personaId, skillName)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages (conversationId, createdAt);
  CREATE INDEX IF NOT EXISTS idx_runs_conv ON runs (conversationId, startedAt);

  /*
   * 运行的**事件流落库**（2026-10-15）。
   *
   * 事件原来只活在进程内存里（runs.mjs 那个 run.events 数组），三个后果：
   *   ① 服务一重启，那次运行的中间过程**永久丢失** —— 只剩最后那段回复；
   *   ② 界面重连只能靠内存数组**全量重放**，而 EventSource 每次重连都要重发一次请求，
   *      于是回话被**重复追加**一遍（真 bug，不是猜的）；
   *   ③ 节点在远端、「看它干」要跨进程甚至跨机器时，内存里那份根本到不了。
   *
   * seq 从 1 起、按**每次运行**单调递增，它就是 SSE 的 id 字段。
   * 浏览器重连时自动把它放进 Last-Event-ID，服务端据此只补发缺的那一段。
   *
   * ⚠️ 本段在模板字符串里：注释中一律不许出现反引号，否则会把模板提前闭合。
   */
  CREATE TABLE IF NOT EXISTS run_events (
    runId  TEXT    NOT NULL,
    seq    INTEGER NOT NULL,
    evt    TEXT    NOT NULL,
    at     TEXT    NOT NULL,
    PRIMARY KEY (runId, seq)
  );
`);

// 轻量迁移：老库补列
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

// 轻量迁移：更早的库里这一列叫 dshSessionId
{
  const cols = db.prepare('PRAGMA table_info(conversations)').all().map((c) => c.name);
  if (cols.includes('dshSessionId') && !cols.includes('sessionId')) {
    db.exec('ALTER TABLE conversations RENAME COLUMN dshSessionId TO sessionId');
  }
}

/*
 * 轻量迁移：member_sessions 加 session 作用域（scope）——
 * 「发起一条新流程 = 该员工的一条全新会话」靠它落地（见 dispatch.sessionScopeOf）。
 *
 * SQLite 改不了主键，只能**重建表**。老数据一律归入 scope=''（普通会话），
 * 语义与改前完全一致：老流程下次派活时拿不到 scoped 行，于是从零开一条新会话 ——
 * 正是要的效果，不需要额外回填。
 */
{
  const cols = db.prepare('PRAGMA table_info(member_sessions)').all().map((c) => c.name);
  if (cols.length && !cols.includes('scope')) {
    db.exec(`
      CREATE TABLE member_sessions_scoped (
        threadId       TEXT NOT NULL,
        personaId      TEXT NOT NULL,
        scope          TEXT NOT NULL DEFAULT '',
        sessionId      TEXT,
        lastSeenRowid  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (threadId, personaId, scope)
      );
      INSERT OR IGNORE INTO member_sessions_scoped (threadId, personaId, scope, sessionId, lastSeenRowid)
        SELECT threadId, personaId, '', sessionId, lastSeenRowid FROM member_sessions;
      DROP TABLE member_sessions;
      ALTER TABLE member_sessions_scoped RENAME TO member_sessions;
    `);
    console.log('[迁移] member_sessions 加上 scope：一条流程实例 = 一条独立会话');
  }
}

// 「显示思考过程」：Codex 的 reasoning 事件关不掉（实测 summary=none / hide_agent_reasoning
// / effort=minimal 都无效），所以这只能是平台层的显示开关。默认关：对话里只留他的回话。
ensureColumn('personas', 'showThinking', 'showThinking INTEGER NOT NULL DEFAULT 0');
// 技能"暂停"状态：老库里挂上就是启用，补列即可
ensureColumn('persona_skills', 'enabled', 'enabled INTEGER NOT NULL DEFAULT 1');

// 附加目录（JSON 数组）。主工作目录仍是 cwd；平台根由服务端自动附加，不用存这儿。
ensureColumn('personas', 'rootDirs', 'rootDirs TEXT');

/*
 * **岗位**（2026-10-17）：这人在团队里**是什么**，跟"他会干什么"（技能）是两件事。
 *   · 岗位：一个值、可空、自由文本（界面给建议列表）；技能可以有很多、能挂能摘。
 *   · 用途：看人时一眼分清、人工指派时辨认。**引擎不读它** —— 派活仍只认节点上点的名
 *     （见 workflows.assigneeFor；冒烟 smoke-personas.mjs 钉着这条）。
 */
ensureColumn('personas', 'role', 'role TEXT');

/*
 * 这次运行**实际用的模型**。
 *
 * 为什么非要落库：额度是**按模型**算的（限额挂在模型上，因为贵/便宜分在模型 id 上，
 * 不在供应商上 —— 本机所有模型都挂在同一个 magpie 网关下）。没有这一列，
 * "某个模型今天花了多少"就永远算不出来，按模型限额就是一句空话。
 *
 * 存的是**生效的那个模型**（员工绑的，或员工没绑时 CLI 自己的默认），不是员工表上的原始字段 ——
 * 后者为空时用量会掉进"认不出"的黑洞。解析见 models.effectiveModelOf。
 * 老记录这一列是 NULL：它们确实归不了因，界面上要当成一个单独的"认不出"桶摆出来，别装作没有。
 */
ensureColumn('runs', 'model', 'model TEXT');

/*
 * 群聊带来的模型改动，全部是「加列/加表」，不动老数据：
 * - conversations 泛化成 thread：kind 区分 1:1 与群
 * - 消息要知道「是谁说的」：1:1 里 assistant 恒等于对方，群里必须记 personaId
 * - 运行要知道「谁跑的」
 */
ensureColumn('conversations', 'kind', "kind TEXT NOT NULL DEFAULT 'direct'");
ensureColumn('conversations', 'ownerPersonaId', 'ownerPersonaId TEXT');
ensureColumn('messages', 'personaId', 'personaId TEXT');
ensureColumn('runs', 'personaId', 'personaId TEXT');
/*
 * 这次执行是**哪一步流程**办的 —— 派活时就知道（dispatch 收到的 `taskId`），
 * 就顺手记下来，别等以后靠"回复里带没带标记"去反推：
 * 跑挂了、被中止、压根没产出回复的那些轮次，反推不出来，任务面板会把它们
 * 当成"聊天派活"（2026-10-14 踩过）。空 = 手动聊天的活。
 */
ensureColumn('runs', 'taskId', 'taskId TEXT');

/*
 * 群主的语义改过一次：
 *  - 老：ownerPersonaId 指一个 agent，没 @ 就找它
 *  - 新：ownerUserId 是**创建人**（人），assistantPersonaId 是**群助手**（agent），没 @ 找群助手
 * ownerPersonaId 保留作历史列，不再读。
 */
ensureColumn('conversations', 'ownerUserId', 'ownerUserId TEXT');
ensureColumn('conversations', 'assistantPersonaId', 'assistantPersonaId TEXT');

// 「从消息列表移除」用：只影响列表显示，不碰消息本身
ensureColumn('conversations', 'hiddenAt', 'hiddenAt TEXT');
// 「解散」用：群被解散的时间。跟 hiddenAt 的区别是**语义**——
// hiddenAt 是"先收起来，还能恢复"，dissolvedAt 是"这个群结束了"。
ensureColumn('conversations', 'dissolvedAt', 'dissolvedAt TEXT');

// 迁移老群：原来的 agent 群主 → 群助手；群主置为创建人
db.exec(`UPDATE conversations SET assistantPersonaId = ownerPersonaId
          WHERE kind = 'group' AND assistantPersonaId IS NULL AND ownerPersonaId IS NOT NULL`);
db.exec(`UPDATE conversations SET ownerUserId = 'local-user'
          WHERE kind = 'group' AND ownerUserId IS NULL`);

// 群不该带 personaId。曾经写成群助手，导致「点员工开对话」把群查了出来。
db.exec(`UPDATE conversations SET personaId = '' WHERE kind = 'group' AND personaId <> ''`);

// 回填：老数据里 assistant 的消息与运行都归属该会话的员工
db.exec(`UPDATE messages SET personaId = (SELECT c.personaId FROM conversations c WHERE c.id = messages.conversationId)
          WHERE personaId IS NULL AND role = 'assistant'`);
db.exec(`UPDATE runs SET personaId = (SELECT c.personaId FROM conversations c WHERE c.id = runs.conversationId)
          WHERE personaId IS NULL`);

// 回填：把老的 conversations.sessionId 搬进 member_sessions，水位线设到「已读到最新」
db.exec(`INSERT OR IGNORE INTO member_sessions (threadId, personaId, sessionId, lastSeenRowid)
         SELECT c.id, c.personaId, c.sessionId,
                (SELECT COALESCE(MAX(m.rowid), 0) FROM messages m WHERE m.conversationId = c.id)
           FROM conversations c
          WHERE c.sessionId IS NOT NULL AND c.kind = 'direct' AND c.personaId IS NOT NULL`);

export const newId = (prefix) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
export const nowIso = () => new Date().toISOString();

/* --------------------------------------------------------------- 工作流 */

/*
 * OA 那套：**模板 → 实例 → 逐步执行**。
 * 三张表分开，是因为它们的生命周期完全不同：
 *   模板   —— 设计好的流程定义，改版时不动历史实例（实例的步骤是**开跑时拷下来的**）
 *   实例   —— 从模板起的一条流程（一次交付 / 一个需求）
 *   步骤   —— 每步的实时状态：谁在做、做到哪、多久没动
 *
 * ⚠️ 注意 `workflow_runs`（流程实例）和 `runs`（一次 agent 执行）是两个东西：
 *    步骤上的 `agentRunId` 指的是后者。别混。
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS workflow_templates (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    steps       TEXT NOT NULL,
    builtIn     INTEGER NOT NULL DEFAULT 0,
    createdAt   TEXT NOT NULL,
    updatedAt   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS workflow_runs (
    id          TEXT PRIMARY KEY,
    templateId  TEXT NOT NULL,
    title       TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT '进行中',
    currentStep INTEGER NOT NULL DEFAULT 0,
    note        TEXT,
    createdAt   TEXT NOT NULL,
    updatedAt   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS workflow_steps (
    id                 TEXT PRIMARY KEY,
    runId              TEXT NOT NULL,
    idx                INTEGER NOT NULL,
    name               TEXT NOT NULL,
    detail             TEXT NOT NULL DEFAULT '',
    assigneePersonaId  TEXT,
    mode               TEXT NOT NULL DEFAULT 'confirm',
    status             TEXT NOT NULL DEFAULT '待开始',
    note               TEXT,
    conversationId     TEXT,
    agentRunId         TEXT,
    startedAt          TEXT,
    endedAt            TEXT,
    UNIQUE (runId, idx)
  );
`);

/*
 * 流程**任务**（v2）：引擎从"线性下一步"改成"按边跳转"之后，同一个节点会被**访问多次**
 * —— 测试不通过打回开发，就是第二次到「写代码」。所以：
 *
 *   · 实例只记**当前在哪个节点**（currentNodeId）
 *   · 每访问一次节点 = 一条任务（visit 从 1 开始）
 *   · 办理痕迹全在任务表上：谁办的、什么时候、通过了还是驳回了、产出是什么
 *
 * 旧表 workflow_steps 不再写入，只在迁移时读一次（见下面的 migrateWorkflowV1）。
 */
db.exec(`
  -- 一次性迁移的标记位（"这个迁移跑过了没有"）
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS workflow_tasks (
    id                 TEXT PRIMARY KEY,
    runId              TEXT NOT NULL,
    nodeId             TEXT NOT NULL,
    nodeName           TEXT NOT NULL,
    visit              INTEGER NOT NULL DEFAULT 1,
    detail             TEXT NOT NULL DEFAULT '',
    assigneePersonaId  TEXT,
    status             TEXT NOT NULL DEFAULT '待开始',
    decision           TEXT,
    note               TEXT,
    conversationId     TEXT,
    agentRunId         TEXT,
    startedAt          TEXT,
    endedAt            TEXT,
    UNIQUE (runId, nodeId, visit)
  );
`);

/*
 * 订正一句**落在库里的**界面指引。
 *
 * 「没人可派」的 note 是**写的时候**拼好存下来的（见 workflows.mjs），不是读时算的，
 * 所以操作从流程底部搬进右侧「任务卡」之后，老步骤上那句"在下面的「指派给谁」里选"
 * 就指向了一个已经不存在的地方。这里就地订正，下次派人时本来就会写新的。
 * 幂等：改过之后 LIKE 匹配不到，重复启动不会再动。
 *
 * ⚠️ 必须放在 workflow_tasks 建表**之后** —— 放前面的话全新库上这张表还不存在，
 *    整个模块直接加载失败。
 */
db.exec(`UPDATE workflow_tasks
            SET note = REPLACE(note, '在下面的「指派给谁」里选一个人就能接着办', '点这一步的「任务卡」选一个人就能接着办')
          WHERE note LIKE '%在下面的「指派给谁」%'`);
/*
 * 上面那条订正的是**更早**的说法（「指派给谁」）。后来「任务卡」也撤了 ——
 * 它的内容全搬进了时间轴那一步的行里：改状态/改指派就是点「状态」「经办人」那两行本身。
 * 所以再串一条，把备注里那句"点「任务卡」"改成新的去处。
 *
 * 两条**都要留着**：旧库可能停在任意一代说法上，串起来才都能到最新。
 * 同样幂等（改过之后 LIKE 匹配不到，重复启动不再动）。
 */
db.exec(`UPDATE workflow_tasks
            SET note = REPLACE(note, '点这一步的「任务卡」选一个人就能接着办', '点上面「经办人」那儿选一个人就能接着办')
          WHERE note LIKE '%任务卡%'`);

ensureColumn('workflow_templates', 'nodes', 'nodes TEXT');
ensureColumn('workflow_templates', 'startNode', 'startNode TEXT');
// 发布：null = 草稿（只在工作流模块里编）；有值 = 已发布（工作台里能点开起流程）
ensureColumn('workflow_templates', 'publishedAt', 'publishedAt TEXT');
// 场地：这个单子挂在哪个会话里跑（项目群 / 某个数字员工的会话）
ensureColumn('workflow_runs', 'threadId', 'threadId TEXT');
// 发起时填的「想法」：这段话就是发给第一个执行人的第一句，也是以后回头看的起因
ensureColumn('workflow_runs', 'intent', 'intent TEXT');
ensureColumn('workflow_runs', 'currentNodeId', 'currentNodeId TEXT');

/**
 * 补「开始节点」这个显式概念。
 *
 * 原来"谁是第一步"是靠 nodes 数组顺序**隐式**决定的，画布上也看不出来。
 * 现在模板单独记 startNode。老模板：
 *   · 把它第一个节点定为开始
 *   · 所有节点**右移 180**，给画布左边的「开始」腾位置
 * 只动坐标，名字/说明/连线一律不碰。
 */
function migrateAddStartNode() {
  const done = db.prepare("SELECT value FROM meta WHERE key = 'flow_start'").get();
  if (done) return;
  let n = 0;
  for (const t of db.prepare('SELECT * FROM workflow_templates').all()) {
    if (t.startNode) continue;
    let nodes;
    try {
      nodes = JSON.parse(t.nodes || t.steps || '[]');
    } catch {
      continue;
    }
    if (!Array.isArray(nodes) || !nodes.length) continue;
    const shifted = nodes.map((x) => ({ ...x, x: (Number.isFinite(x.x) ? x.x : 40) + 180 }));
    db.prepare('UPDATE workflow_templates SET nodes = ?, startNode = ? WHERE id = ?').run(
      JSON.stringify(shifted),
      nodes[0].id,
      t.id,
    );
    n++;
  }
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('flow_start', ?)").run(nowIso());
  if (n) console.log(`工作流：${n} 个模板补上了开始节点`);
}

/**
 * v1 → v2 迁移：把老的 steps 实例搬成 tasks。
 * 班底是单机产品，用户的流程实例可能只有几条 —— **宁可迁移也不删**。
 * 节点 id 用 `n{序号}`，和新内建模板的 id 对齐，所以迁移后还能继续往下走。
 */
function migrateWorkflowV1() {
  const done = db.prepare("SELECT value FROM meta WHERE key = 'workflow_v2'").get();
  if (done) return;
  const runs = db.prepare('SELECT id, currentStep FROM workflow_runs').all();
  for (const r of runs) {
    const steps = db.prepare('SELECT * FROM workflow_steps WHERE runId = ? ORDER BY idx').all(r.id);
    for (const s of steps) {
      db.prepare(
        `INSERT OR IGNORE INTO workflow_tasks
           (id, runId, nodeId, nodeName, visit, detail, assigneePersonaId, status, note, conversationId, agentRunId, startedAt, endedAt)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        s.id, r.id, `n${s.idx + 1}`, s.name, s.detail ?? '', s.assigneePersonaId ?? null,
        s.status, s.note ?? null, s.conversationId ?? null, s.agentRunId ?? null, s.startedAt ?? null, s.endedAt ?? null,
      );
    }
    if (steps.length) {
      db.prepare('UPDATE workflow_runs SET currentNodeId = ? WHERE id = ?').run(`n${r.currentStep + 1}`, r.id);
    }
  }
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('workflow_v2', ?)").run(nowIso());
  if (runs.length) console.log(`工作流 v1→v2：迁移了 ${runs.length} 条流程实例`);
}
migrateWorkflowV1();
migrateAddStartNode();

/**
 * 会话级权限覆盖。
 *
 * 原来权限只挂在员工身上：想"波哥平时只读，这个会话给他完全权限"就表达不了。
 * 加一列 `conversations.sandbox`：**NULL = 跟随员工默认**，有值 = 只在这个会话里覆盖。
 * 派活时取 `会话 ?? 员工`（每次派活都重新读，所以改完下一轮就生效）。
 *
 * **手动收回**：用户明确要这个语义（不是"下一轮自动回落"）。为了防止忘记收回，
 * 前端会把"被覆盖"的会话显眼标出来。
 */
function migrateAddConversationSandbox() {
  ensureColumn('conversations', 'sandbox', 'sandbox TEXT');
}
migrateAddConversationSandbox();

/**
 * 状态名归到「确认族」：`待审批` → `待确认`。
 *
 * 为什么改：同一个东西界面上有四个说法 —— 节点开关（人工干预）、状态（待审批）、
 * 按钮（确认这一步完成）、提示（等你拍板）。节点开关现在统一叫「需要人工确认完成」，
 * 状态就跟着叫「待确认」，按钮和提示本来就是"确认"。
 *
 * ⚠️ 有意思的是：库里**本来就有一条老数据叫「待确认」** —— 更早的版本用的就是这个名，
 *    后来被改成「待审批」。所以这次是**改回去**，那条老数据反而变成合法值了，
 *    不用动它；要订正的是中间那批「待审批」。
 */
function migrateTaskStatusToConfirm() {
  const n = db.prepare("UPDATE workflow_tasks SET status = '待确认' WHERE status = '待审批'").run();
  if (n.changes) console.log(`[迁移] ${n.changes} 条任务状态：待审批 → 待确认`);
}
migrateTaskStatusToConfirm();

/** 把会话的权限覆盖设成某个值；传 null / 空 = 收回，跟随员工默认 */
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
function migrateAddConversationModel() {
  ensureColumn('conversations', 'model', 'model TEXT');
}
migrateAddConversationModel();

/** 把会话的模型覆盖设成某个值；传 null / 空 = 收回，跟随员工默认 */
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
  // 消息归属哪一步：**按标记取，不再靠时间窗口切**
  // （1:1 会话被多条流程共用，按时间切会把别的流程的派活也捞进来，用户实报）
  ensureColumn('messages', 'taskId', 'taskId TEXT');

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
  };
  db.prepare(
    'UPDATE projects SET name = ?, root = ?, extraRoots = ?, note = ?, updatedAt = ? WHERE id = ?',
  ).run(next.name, next.root, next.extraRoots, next.note, nowIso(), id);
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
    createdAt: ts,
    updatedAt: ts,
  };
  db.prepare(
    `INSERT INTO project_tasks
       (id, projectId, title, description, status, assigneePersonaId, conversationId, runId, source, externalKey, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

export function listProjectTasks(projectId) {
  return db
    .prepare('SELECT * FROM project_tasks WHERE projectId = ? ORDER BY createdAt DESC')
    .all(projectId);
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
            conversationId = ?, runId = ?, updatedAt = ?
      WHERE id = ?`,
  ).run(
    next.title,
    next.description,
    next.status,
    next.assigneePersonaId,
    next.conversationId,
    next.runId,
    nowIso(),
    id,
  );
  return getProjectTask(id);
}

export function deleteProjectTask(id) {
  return db.prepare('DELETE FROM project_tasks WHERE id = ?').run(id).changes > 0;
}

/** 项目的工作根：主目录 + 附加根（给沙箱的 writable_roots 用） */
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

export function getPersona(id) {
  return db.prepare('SELECT * FROM personas WHERE id = ?').get(id) ?? null;
}

export function createPersona({ name, role = null, instructions = '', runtime = 'codex', sandbox = 'danger-full-access', cwd = null, model = null, showThinking = 0, rootDirs = [] }) {
  const row = {
    id: newId('p'), name, role, instructions, runtime, sandbox, cwd, model,
    showThinking: showThinking ? 1 : 0,
    rootDirs: Array.isArray(rootDirs) && rootDirs.length ? JSON.stringify(rootDirs) : null,
    createdAt: nowIso(),
  };
  db.prepare(
    `INSERT INTO personas (id, name, role, instructions, runtime, sandbox, cwd, model, showThinking, rootDirs, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id, row.name, row.role, row.instructions, row.runtime, row.sandbox, row.cwd, row.model,
    row.showThinking, row.rootDirs, row.createdAt,
  );
  return row;
}

/** 这个人是不是某些群的群助手 —— 删之前必须查，删了「没 @ 就找群助手」那条规则就断了 */
export function groupsWhereAssistant(personaId) {
  return db
    .prepare("SELECT id, title FROM conversations WHERE kind = 'group' AND assistantPersonaId = ?")
    .all(personaId);
}

/**
 * 删员工：**连带清掉他的关系数据**。
 *
 * 为什么要级联：`listMembers` 是 INNER JOIN personas，关系表里留悬空行不会报错，
 * 只会让群成员**静默消失**；而 `assistantPersonaId` 悬空则更糟 —— 群里没人接话了。
 *
 * 会话**不删**（聊天记录留着），改成**归档**：消息列表保持干净，历史还能从
 * 「已移除的会话」里找回来。留成"（员工已删）"的死条目反而更差：点进去发不了消息。
 */
export function deletePersona(id) {
  // 注意：node:sqlite 的 DatabaseSync **没有** better-sqlite3 那个 db.transaction() 助手，
  // 只能自己 BEGIN/COMMIT。级联删除要么全成、要么全不动，不能删一半。
  db.exec('BEGIN');
  try {
    const persona = db.prepare('SELECT name FROM personas WHERE id = ?').get(id);

    db.prepare('DELETE FROM persona_skills WHERE personaId = ?').run(id);
    db.prepare('DELETE FROM thread_members WHERE personaId = ?').run(id);
    db.prepare('DELETE FROM member_sessions WHERE personaId = ?').run(id);

    const convs = db.prepare("SELECT id, title FROM conversations WHERE kind = 'direct' AND personaId = ?").all(id);
    const ts = nowIso();
    for (const c of convs) {
      // 人一删，**再没有别的地方记得"这段对话是谁的"** —— personaName 的 JOIN 会变 null，
      // 归档列表就会剩一排分不清的「（员工已删）」。所以把名字落到标题里。
      // 标题已有名字（正常是「和 X」）就不动它，别覆盖用户自己起过的名字。
      const named = persona?.name && c.title && c.title.includes(persona.name);
      const title = named ? c.title : `和 ${persona?.name ?? '已删除的员工'}`;
      db.prepare('UPDATE conversations SET hiddenAt = ?, title = ? WHERE id = ?').run(ts, title, c.id);
    }

    const removed = db.prepare('DELETE FROM personas WHERE id = ?').run(id).changes > 0;
    db.exec('COMMIT');
    return { removed, archivedConversations: convs.length };
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
  };
  db.prepare(
    `UPDATE personas SET name = ?, role = ?, instructions = ?, runtime = ?, sandbox = ?, cwd = ?, model = ?, showThinking = ?, rootDirs = ?
      WHERE id = ?`,
  ).run(
    next.name, next.role, next.instructions, next.runtime, next.sandbox, next.cwd, next.model,
    next.showThinking, next.rootDirs, id,
  );
  return { ...current, ...next };
}

/** 某员工名下最近几次运行（详情页展示用） */
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

export function listConversations() {
  return db
    .prepare(
      `SELECT c.*, p.name AS personaName, p.runtime AS runtime,
              (SELECT COUNT(*) FROM thread_members tm WHERE tm.threadId = c.id) AS memberCount,
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
                p.model AS personaModel, p.showThinking AS showThinking, p.rootDirs AS personaRootDirs
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
export function createGroup({ title, assistantPersonaId, memberIds = [], ownerUserId = LOCAL_USER.id }) {
  const ts = nowIso();
  const row = {
    id: newId('g'),
    title,
    personaId: '',
    ownerPersonaId: assistantPersonaId, // 历史列，仅作镜像
    ownerUserId,
    assistantPersonaId,
    kind: 'group',
    status: '待跑',
    createdAt: ts,
    updatedAt: ts,
  };
  db.prepare(
    `INSERT INTO conversations
       (id, title, personaId, ownerPersonaId, ownerUserId, assistantPersonaId, kind, sessionId, status, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, 'group', NULL, ?, ?, ?)`,
  ).run(
    row.id,
    row.title,
    row.personaId,
    row.ownerPersonaId,
    row.ownerUserId,
    row.assistantPersonaId,
    row.status,
    row.createdAt,
    row.updatedAt,
  );

  for (const pid of new Set([assistantPersonaId, ...memberIds].filter(Boolean))) addMember(row.id, pid);
  return row;
}

/**
 * 拉人进群。
 * 水位线不是从 0 开始：让新人能读到"最近 backfill 条"作为背景，
 * 但不会把整段群历史灌进他的 prompt。群刚建时没有消息，自然就是 0。
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

/** 踢人。顺手删掉他的会话与水位线：再拉回来就是干净的开始，不会带着旧记忆。 */
export function removeMember(threadId, personaId) {
  db.prepare('DELETE FROM thread_members WHERE threadId = ? AND personaId = ?').run(threadId, personaId);
  db.prepare('DELETE FROM member_sessions WHERE threadId = ? AND personaId = ?').run(threadId, personaId);
}

export function listMembers(threadId) {
  return db
    .prepare(
      `SELECT tm.personaId, tm.joinedAt, p.name, p.runtime, p.sandbox, p.cwd, p.model, p.instructions, p.rootDirs
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

/** 把群助手换人（必须是群里已有的成员） */
export function setAssistantPersona(threadId, personaId) {
  db.prepare('UPDATE conversations SET assistantPersonaId = ?, personaId = ?, updatedAt = ? WHERE id = ?').run(
    personaId,
    personaId,
    nowIso(),
    threadId,
  );
}

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

export function listMessages(conversationId) {
  return db
    .prepare(
      `SELECT m.*, p.name AS personaName
         FROM messages m LEFT JOIN personas p ON p.id = m.personaId
        WHERE m.conversationId = ? ORDER BY m.createdAt, m.rowid`,
    )
    .all(conversationId);
}

/**
 * 水位线之后的消息 —— 群聊里给某个成员注入上下文用。
 * rowid 是 SQLite 的隐式列，拿来当游标最省事（不受时间戳并列影响）。
 */
export function listMessagesSince(conversationId, afterRowid, excludeMessageId = null) {
  return db
    .prepare(
      `SELECT m.rowid AS rid, m.*, p.name AS personaName
         FROM messages m LEFT JOIN personas p ON p.id = m.personaId
        WHERE m.conversationId = ? AND m.rowid > ? ORDER BY m.rowid`,
    )
    .all(conversationId, afterRowid)
    .filter((m) => m.id !== excludeMessageId);
}

export function addMessage({ conversationId, runId = null, role, text, personaId = null, taskId = null }) {
  const row = { id: newId('m'), conversationId, runId, role, text, personaId, taskId, createdAt: nowIso() };
  db.prepare(
    'INSERT INTO messages (id, conversationId, runId, role, text, personaId, taskId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    row.id,
    row.conversationId,
    row.runId,
    row.role,
    row.text,
    row.personaId,
    row.taskId,
    row.createdAt,
  );
  // 说话就把它从"已从列表移除"里恢复 —— 否则会出现"我发了消息，列表里却没有"
  db.prepare('UPDATE conversations SET updatedAt = ?, hiddenAt = NULL WHERE id = ?').run(row.createdAt, conversationId);
  row.rowid = db.prepare('SELECT rowid AS rid FROM messages WHERE id = ?').get(row.id).rid;
  return row;
}

/**
 * 从消息列表里移除（归档）。
 * **不删消息、不删会话** —— 只是让它不在列表里显示；
 * 之后在这里再说一句话，它会自己回来（见 addMessage）。
 */
export function hideConversation(id) {
  return db.prepare('UPDATE conversations SET hiddenAt = ? WHERE id = ?').run(nowIso(), id).changes > 0;
}

/** 从"已归档"里捞回来 */
export function unhideConversation(id) {
  return (
    db.prepare('UPDATE conversations SET hiddenAt = NULL, updatedAt = ? WHERE id = ?').run(nowIso(), id).changes > 0
  );
}

/**
 * 解散一个群。
 *
 * **不抹聊天记录** —— 跟这个仓库里其它破坏性操作同一个原则（删员工、删流程都不动别人的记录）。
 * 只做三件事：解除成员关系、清掉各成员在这个群里的会话状态、把它归档。
 * 记录留在库里，去「已移除的会话」照样能查到。
 *
 * 为什么成员关系必须清（不是只藏起来）：
 *   · 「没 @ 就找群助手」这条规则靠 thread_members 撑着，人都不在了这规则就该失效；
 *   · 不清的话，从归档点进去还能 @ 人派活 —— 那是个已经解散的群。
 *   · 群助手一并置空：否则删那个数字员工时会被一句"他是群「X」的群助手"挡住，
 *     而那个群已经不存在了（groupsWhereAssistant 是按 assistantPersonaId 查的）。
 */
export function dissolveGroup(id) {
  const t = getConversation(id);
  if (!t || t.kind !== 'group') return null;
  const ts = nowIso();
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM thread_members WHERE threadId = ?').run(id);
    db.prepare('DELETE FROM member_sessions WHERE threadId = ?').run(id);
    db.prepare(
      `UPDATE conversations
          SET dissolvedAt = ?, hiddenAt = ?, assistantPersonaId = NULL, status = '待跑', updatedAt = ?
        WHERE id = ?`,
    ).run(ts, ts, ts, id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return getConversation(id);
}

/** 已归档的会话（给「已归档」入口用） */
export function listArchivedConversations() {
  return db
    .prepare(
      `SELECT c.*, p.name AS personaName,
              (SELECT COUNT(*) FROM messages m WHERE m.conversationId = c.id) AS messageCount,
              (SELECT COUNT(*) FROM thread_members tm WHERE tm.threadId = c.id) AS memberCount
         FROM conversations c LEFT JOIN personas p ON p.id = c.personaId
        WHERE c.hiddenAt IS NOT NULL
        ORDER BY c.hiddenAt DESC`,
    )
    .all();
}

export function countArchived() {
  return db.prepare('SELECT COUNT(*) c FROM conversations WHERE hiddenAt IS NOT NULL').get().c;
}

/* ------------------------------------------------- 每个成员自己的会话状态 */

export function getMemberSession(threadId, personaId, scope = '') {
  return (
    db
      .prepare('SELECT * FROM member_sessions WHERE threadId = ? AND personaId = ? AND scope = ?')
      .get(threadId, personaId, scope) ?? null
  );
}

export function setMemberSession(threadId, personaId, sessionId, scope = '') {
  db.prepare(
    `INSERT INTO member_sessions (threadId, personaId, scope, sessionId, lastSeenRowid) VALUES (?, ?, ?, ?, 0)
     ON CONFLICT(threadId, personaId, scope) DO UPDATE SET sessionId = excluded.sessionId`,
  ).run(threadId, personaId, scope, sessionId);
}

export function setMemberWatermark(threadId, personaId, rowid, scope = '') {
  db.prepare(
    `INSERT INTO member_sessions (threadId, personaId, scope, sessionId, lastSeenRowid) VALUES (?, ?, ?, NULL, ?)
     ON CONFLICT(threadId, personaId, scope) DO UPDATE
       SET lastSeenRowid = MAX(member_sessions.lastSeenRowid, excluded.lastSeenRowid)`,
  ).run(threadId, personaId, scope, rowid);
}

/* ----------------------------------------------------------------- skills */

/** 挂载关系（含启用状态）—— 界面要显示"分配了哪些、哪些暂停了" */
export function listPersonaSkillLinks(personaId) {
  return db
    .prepare('SELECT skillName, enabled FROM persona_skills WHERE personaId = ? ORDER BY addedAt')
    .all(personaId)
    .map((r) => ({ name: r.skillName, enabled: r.enabled !== 0 }));
}

/** 真正会被注入 prompt 的那些：暂停的不算 */
export function listPersonaSkills(personaId) {
  return listPersonaSkillLinks(personaId)
    .filter((l) => l.enabled)
    .map((l) => l.name);
}

/** 暂停/恢复：留着分配关系，只是不生效 */
export function setPersonaSkillEnabled(personaId, skillName, enabled) {
  return db
    .prepare('UPDATE persona_skills SET enabled = ? WHERE personaId = ? AND skillName = ?')
    .run(enabled ? 1 : 0, personaId, skillName).changes;
}

export function setPersonaSkills(personaId, names) {
  const wanted = [...new Set((names ?? []).map(String).filter(Boolean))];
  // 只增删，不做整表替换 —— 整表替换会把"暂停"状态一起抹掉
  const have = new Set(listPersonaSkillLinks(personaId).map((l) => l.name));
  for (const n of wanted) if (!have.has(n)) linkPersonaSkill(personaId, n);
  for (const n of have) if (!wanted.includes(n)) unlinkPersonaSkill(personaId, n);
  return wanted;
}

/** 单个关联/解除：挂载是独立动作，不走"整表替换"，免得和员工表单互相覆盖 */
export function linkPersonaSkill(personaId, skillName) {
  db.prepare('INSERT OR IGNORE INTO persona_skills (personaId, skillName, addedAt) VALUES (?, ?, ?)').run(
    personaId,
    skillName,
    nowIso(),
  );
}

export function unlinkPersonaSkill(personaId, skillName) {
  return db.prepare('DELETE FROM persona_skills WHERE personaId = ? AND skillName = ?').run(personaId, skillName)
    .changes;
}

/** 某个 skill 被哪些员工挂着（删 skill 时用来清账） */
export function forgetSkillEverywhere(skillName) {
  return db.prepare('DELETE FROM persona_skills WHERE skillName = ?').run(skillName).changes;
}

/* ------------------------------------------------------------------- runs */

export function createRun({ conversationId, runtime, personaId = null, model = null, taskId = null }) {
  const row = {
    id: newId('r'),
    conversationId,
    runtime,
    personaId,
    model,
    // 是流程的一步就记下那一步（taskId = workflow_tasks.id）；手动聊天留空
    taskId,
    status: '跑中',
    exitCode: null,
    error: null,
    usage: null,
    startedAt: nowIso(),
    endedAt: null,
  };
  db.prepare(
    `INSERT INTO runs (id, conversationId, runtime, personaId, model, taskId, status, exitCode, error, usage, startedAt, endedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.conversationId,
    row.runtime,
    row.personaId,
    row.model,
    row.taskId,
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

/** 已经用到第几个号（启动清账时接着往下写；新运行是 0） */
export function maxRunSeq(runId) {
  return db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM run_events WHERE runId = ?').get(runId)?.n ?? 0;
}

export function listRuns(conversationId) {
  return db
    .prepare('SELECT * FROM runs WHERE conversationId = ? ORDER BY startedAt DESC')
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
db.exec(`
  CREATE TABLE IF NOT EXISTS nodes (
    id           TEXT PRIMARY KEY,
    label        TEXT NOT NULL,
    platform     TEXT,
    runtimes     TEXT,
    registeredAt TEXT NOT NULL,
    lastSeenAt   TEXT NOT NULL
  );
`);

/*
 * `hostname` ＝ 那台机器**自报的事实**（`os.hostname()`）；`label` ＝ **人给它的称呼**。
 *
 * 为什么要分开（2026-10-16 加"重命名机器"时定的）：合成一个字段的后果是 ——
 * 用户把「DESKTOP-XXXXXXX」改叫「我的笔记本」，那台机器下次报到时又把自己的主机名顶上来，
 * 名字白改了。分开之后：主机名每次报到都更新，名字只在**没人起过名**时才跟着走。
 */
ensureColumn('nodes', 'hostname', 'hostname TEXT');
ensureColumn('nodes', 'renamed', 'renamed INTEGER NOT NULL DEFAULT 0');
/*
 * `externals` ＝ 那台机器上"班底之外还要有的东西"的现状（现在只有 magpie：装了没、网关端口通不通）。
 * 跟 `runtimes` 一样**节点自己报** —— 那台机器上的事实，控制面判不了。
 */
ensureColumn('nodes', 'externals', 'externals TEXT');

export function upsertNode({ id, label, platform = null, runtimes = [], externals = null, hostname = null }) {
  const ts = nowIso();
  const host = String(hostname ?? label ?? id).trim() || id;
  db.prepare(
    `INSERT INTO nodes (id, label, hostname, platform, runtimes, externals, registeredAt, lastSeenAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       -- 主机名是那台机器的事实，每次都跟着更新
       hostname   = excluded.hostname,
       -- 名字只认"人起过的"：起过就不许它自己的主机名顶掉
       label      = CASE WHEN nodes.renamed = 1 THEN nodes.label ELSE excluded.label END,
       platform   = excluded.platform,
       runtimes   = excluded.runtimes,
       -- 外部件清单：报到时给就更新，不给就留着（旧节点不认识这个字段，别把已有的抹掉）
       externals  = COALESCE(excluded.externals, nodes.externals),
       lastSeenAt = excluded.lastSeenAt`,
  ).run(id, label || host, host, platform, JSON.stringify(runtimes ?? []), externals ? JSON.stringify(externals) : null, ts, ts);
  return getNode(id);
}

/**
 * 给一台节点起名。**传空字符串 = 恢复默认**（回到它自报的主机名）。
 * 名字记在控制面这边 —— 那台机器下次报到时 `upsertNode` 不会顶掉它（见上面那条 CASE）。
 */
export function renameNode(id, label) {
  const n = getNode(id);
  if (!n) return null;
  const name = String(label ?? '').trim();
  if (name) db.prepare('UPDATE nodes SET label = ?, renamed = 1 WHERE id = ?').run(name, id);
  else db.prepare('UPDATE nodes SET label = ?, renamed = 0 WHERE id = ?').run(n.hostname || n.label, id);
  return getNode(id);
}

export function getNode(id) {
  return db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) ?? null;
}

export function listNodes() {
  return db.prepare('SELECT * FROM nodes ORDER BY registeredAt').all();
}

/**
 * 心跳。**节点没登记过就返回 null** —— 让上层回 404，别悄悄造一台出来。
 *
 * `patch.runtimes` 给了就连运行时清单一起更新。为什么心跳要捎带这份（2026-10-16）：
 * 原来清单**只在报到时**上报，于是在那台机器上装完 CLI，控制面这边一直显示"一个都没探到"，
 * 非要重启节点才更新 —— 用户看到的就是"我明明装了"。纯 stat，几毫秒的事。
 */
export function touchNode(id, patch = {}) {
  if (Array.isArray(patch.runtimes) || Array.isArray(patch.externals)) {
    const sets = ['lastSeenAt = ?'];
    const args = [nowIso()];
    if (Array.isArray(patch.runtimes)) {
      sets.push('runtimes = ?');
      args.push(JSON.stringify(patch.runtimes));
    }
    if (Array.isArray(patch.externals)) {
      sets.push('externals = ?');
      args.push(JSON.stringify(patch.externals));
    }
    args.push(id);
    const r = db.prepare(`UPDATE nodes SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    return r.changes ? getNode(id) : null;
  }
  const r = db.prepare('UPDATE nodes SET lastSeenAt = ? WHERE id = ?').run(nowIso(), id);
  return r.changes ? getNode(id) : null;
}

/* ------------------------------------------------------ 派给节点的活（队列） */

/*
 * 一次"该在某台机器上跑"的执行 = 一行。控制面**不 spawn 远端的东西** ——
 * 它只把该干什么放在这儿，等那台机器的节点**长轮询**来领（见 nodes 的注释：
 * 出站连接是多机方案里唯一不用开端口、不用打洞的形态）。
 *
 * 为什么这也就是"离线排队"：节点不在线时，行就一直躺在"待领"里 ——
 * 不需要另写一套"排队"逻辑，**排队就是这个队列的默认状态**。
 *
 * task 存的是**整段**要交给 CLI 的话（职责、技能、上下文都已经拼好了）；
 * sessionId 是续接用的（同一台机器上的同一个 CLI 会话）。
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS node_jobs (
    id        TEXT PRIMARY KEY,
    runId     TEXT NOT NULL,
    nodeId    TEXT NOT NULL,
    family    TEXT NOT NULL,
    model     TEXT,
    sandbox   TEXT,
    cwd       TEXT,
    task      TEXT NOT NULL,
    sessionId TEXT,
    status    TEXT NOT NULL DEFAULT '待领',
    createdAt TEXT NOT NULL,
    claimedAt TEXT,
    endedAt   TEXT,
    progressAt TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_node_jobs_queue ON node_jobs (nodeId, status, createdAt);
`);

/*
 * 这个活最后一次**有动静**是什么时候（节点每 2 秒的空批次也会刷新它）。
 * 掉线清扫靠它区分两件差别很大的事：
 *   · 一次都没动静 → 那边根本没开张，**放回队列**重派是安全的；
 *   · 有动静之后才断 → 副作用可能已经发生了一半，**不能**悄悄重跑。
 */
ensureColumn('node_jobs', 'progressAt', 'progressAt TEXT');

/*
 * 「让那台机器做一件小事」——目前只有一种：一键安装运行时（2026-10-16）。
 *
 * 为什么不复用 node_jobs：那张表的 `runId` 是**必填**的，它服务的是"一次对话运行"（有会话、
 * 有事件流、有产物）。安装没有 run，硬塞进去会让"什么算一次运行"这件事变得含糊。
 *
 * ⚠️ 表里只存**族名**，不存命令 —— 命令由节点自己查（见 runtimes.installCommandFor）。
 * 这条是安全边界：控制面永远发不出命令，只能发"装这三个里的哪一个"。
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS node_tasks (
    id        TEXT PRIMARY KEY,
    nodeId    TEXT NOT NULL,
    kind      TEXT NOT NULL,
    family    TEXT NOT NULL,
    status    TEXT NOT NULL DEFAULT '待领',
    output    TEXT NOT NULL DEFAULT '',
    createdAt TEXT NOT NULL,
    claimedAt TEXT,
    endedAt   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_node_tasks_queue ON node_tasks (nodeId, status, createdAt);
`);

/*
 * 这一步的**参数**（现在只有"走镜像装"的那个前缀）。为什么单独一列而不是塞进 family：
 * `family` 是"做哪件事"，这一列是"怎么做" —— 混在一起，以后想加第二种参数就得改语义。
 * ⚠️ 它**不是命令**：节点拿到它之后，仍然只跑自己那张固定命令表里的命令（见 externals.commandFor）。
 */
ensureColumn('node_tasks', 'arg', 'arg TEXT');

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

export function enqueueNodeJob({ runId, nodeId, family, model = null, sandbox = null, cwd = null, task, sessionId = null }) {
  const id = newId('nj');
  db.prepare(
    `INSERT INTO node_jobs (id, runId, nodeId, family, model, sandbox, cwd, task, sessionId, status, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '待领', ?)`,
  ).run(id, runId, nodeId, family, model, sandbox, cwd, task, sessionId, nowIso());
  return getNodeJob(id);
}

export function getNodeJob(id) {
  return db.prepare('SELECT * FROM node_jobs WHERE id = ?').get(id) ?? null;
}

export function getNodeJobByRun(runId) {
  return db.prepare('SELECT * FROM node_jobs WHERE runId = ? ORDER BY createdAt DESC LIMIT 1').get(runId) ?? null;
}

/**
 * 领一个活：**取最老的那个"待领"，并原子地标成"执行中"**。
 *
 * 原子性靠 `UPDATE ... WHERE id = ? AND status = '待领'` 的 changes ——
 * 同一个节点不会有两条并发领取（节点是单线程的），但把这条写死，
 * 以后真出并发时不会悄悄发出两份活。
 */
export function claimNodeJob(nodeId) {
  const row = db
    .prepare("SELECT id FROM node_jobs WHERE nodeId = ? AND status = '待领' ORDER BY createdAt LIMIT 1")
    .get(nodeId);
  if (!row) return null;
  const up = db
    .prepare("UPDATE node_jobs SET status = '执行中', claimedAt = ? WHERE id = ? AND status = '待领'")
    .run(nowIso(), row.id);
  if (!up.changes) return null; // 别人抢走了（理论上不会）
  return getNodeJob(row.id);
}

export function finishNodeJob(id, status = '已回执') {
  db.prepare('UPDATE node_jobs SET status = ?, endedAt = ? WHERE id = ?').run(status, nowIso(), id);
  return getNodeJob(id);
}

/**
 * 把领走的活**放回队列**。
 *
 * 什么时候用：领活是**长轮询**，而请求可能在等待期间就断了（节点被杀、网线拔了、
 * 壳崩了）。那时如果把活算成"已领走"，它就落在空气里 —— 节点那边没人跑，
 * 队列里也看不见，界面上永远"跑中"（2026-10-15 实测踩到）。
 * 所以：**发现请求方没了就把活放回去**，等下一个节点来领。
 */
export function releaseNodeJob(id) {
  db.prepare("UPDATE node_jobs SET status = '待领', claimedAt = NULL WHERE id = ?").run(id);
  return getNodeJob(id);
}

/** 记一次"这个活还有动静"（回传了事件、或者只是空批次心跳） */
export function touchNodeJob(id) {
  db.prepare('UPDATE node_jobs SET progressAt = ? WHERE id = ?').run(nowIso(), id);
}

/** 所有"已领走、正在跑"的活 —— 掉线清扫用 */
export function listRunningNodeJobs() {
  return db.prepare("SELECT * FROM node_jobs WHERE status = '执行中'").all();
}

/**
 * 把一台节点从控制面上**忘掉**。
 *
 * 为什么需要：节点身份认的是**它自己那个状态文件**。那台机器换了数据目录、
 * 或者状态文件丢了，就会用新身份重新报到 —— 老的这一行从此永远"离线"躺着，
 * 而它的运行时还挂在员工的下拉里（**一台永远不会回来的机器**）。
 * 2026-10-15 实测就是这么攒出两行的，所以得有个地方删。
 */
export function deleteNode(id) {
  const r = db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
  return r.changes > 0;
}

/**
 * **每节点一枚自己的令牌** ＋ **一次性邀请码**（2026-10-16）。
 *
 * 为什么要动这个：原来节点拿的是**总机那枚 master 令牌** —— 跟浏览器登录、跟所有节点共用同一枚 ✗。
 * 后果两条，都很难受：
 *   · 任何一台节点被翻，等于**整套被翻**（能读所有对话、改员工、删别的机器）；
 *   · 「忘掉」**踢不掉它** —— 删了记录它下次心跳就回来（令牌仍然有效）。
 *
 * 现在：一次性邀请码 → 换回**这枚只属于它的**令牌 → 权限只到"它自己那台的节点接口"（见 auth.mjs）；
 * 「忘掉」= 连它的令牌一起吊销 → 真的踢出去。
 *
 * ⚠️ **表里只存哈希，不存明文**：库文件被拿走（备份、同步、误传）也拿不到能用的凭据。
 * 明文只在颁发那一刻回给那台机器一次，之后谁也看不见（跟密码一样）。
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS node_tokens (
    tokenHash TEXT PRIMARY KEY,
    nodeId    TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_node_tokens_node ON node_tokens (nodeId);
  CREATE TABLE IF NOT EXISTS node_invites (
    codeHash  TEXT PRIMARY KEY,
    createdAt TEXT NOT NULL,
    expiresAt TEXT NOT NULL,
    usedAt    TEXT,
    usedBy    TEXT
  );
`);

const hashOf = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** 颁发一枚**只属于这个节点**的令牌。明文**只在这里回一次**，库里只留哈希 */
export function issueNodeToken(nodeId) {
  const token = `bn_${crypto.randomBytes(24).toString('base64url')}`;
  db.prepare('INSERT INTO node_tokens (tokenHash, nodeId, createdAt) VALUES (?, ?, ?)').run(hashOf(token), nodeId, nowIso());
  return token;
}

/** 这枚令牌属于哪个节点（不认识就 null）。给认证层用 */
export function nodeByToken(token) {
  if (!token) return null;
  const row = db.prepare('SELECT nodeId FROM node_tokens WHERE tokenHash = ?').get(hashOf(token));
  return row?.nodeId ?? null;
}

/** 吊销一台机器的全部令牌 —— 「忘掉」它就是**真的**把它踢出去（而不是删了记录等它回来） */
export function revokeNodeTokens(nodeId) {
  return db.prepare('DELETE FROM node_tokens WHERE nodeId = ?').run(nodeId).changes;
}

/** 这台机器还有几枚有效令牌（界面/诊断用） */
export function countNodeTokens(nodeId) {
  return db.prepare('SELECT COUNT(*) n FROM node_tokens WHERE nodeId = ?').get(nodeId).n;
}

/** 发一个一次性邀请码（10 分钟、只用一次）。同样只存哈希 */
export function createInvite(ttlMs = 10 * 60 * 1000) {
  const code = `bj_${crypto.randomBytes(18).toString('base64url')}`;
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  db.prepare('INSERT INTO node_invites (codeHash, createdAt, expiresAt) VALUES (?, ?, ?)').run(hashOf(code), nowIso(), expiresAt);
  return { code, expiresAt };
}

/**
 * 用掉一个邀请码。**原子**：`UPDATE … WHERE usedAt IS NULL AND expiresAt > ?` 的 changes
 * —— 两个人同时用同一个码，只有一个能成（这是"一次性"的全部意义）。
 */
export function consumeInvite(code, nodeId) {
  const up = db
    .prepare('UPDATE node_invites SET usedAt = ?, usedBy = ? WHERE codeHash = ? AND usedAt IS NULL AND expiresAt > ?')
    .run(nowIso(), nodeId ?? null, hashOf(code), nowIso());
  return up.changes === 1;
}

/** 队列里还压着多少（界面/日志用；也是"离线排队"看得见的那个数） */
export function countNodeJobs(nodeId, status = '待领') {
  return db.prepare('SELECT COUNT(*) n FROM node_jobs WHERE nodeId = ? AND status = ?').get(nodeId, status).n;
}

/** 这个节点上正在跑的活（它掉线了要能看出来"有哪些活卡在它身上"） */
export function listNodeJobs(nodeId, limit = 20) {
  return db
    .prepare('SELECT * FROM node_jobs WHERE nodeId = ? ORDER BY createdAt DESC LIMIT ?')
    .all(nodeId, limit);
}

/* --------------------------------------------------------- 额度（按模型） */

/*
 * DDL 也收在这儿：规矩是 **SQL 只出现在 store 里**（见 docs/形态决策.md §十二 第 2 条）——
 * 将来真要换库（Postgres / better-sqlite3），改动面就只剩这一个文件。
 *
 * v1 的 quotas 是「全站一行」（id=1），跟模型级对不上：一行装不下多个模型，
 * 也没法把一个全站上限摊到某个模型头上。所以直接重建；删之前先看一眼有没有人真配过，
 * 配过就骂一句，别让人以为限额还在。
 */
{
  const cols = db.prepare('PRAGMA table_info(quotas)').all().map((c) => c.name);
  if (cols.length && !cols.includes('model')) {
    const had = db
      .prepare('SELECT count(*) c FROM quotas WHERE dailyTokens IS NOT NULL OR dailyRuns IS NOT NULL')
      .get().c;
    if (had) {
      console.warn('[迁移] 原来的「全站额度」在模型级里没有对应物，已丢弃 —— 去「设置 → 额度」按模型重设');
    }
    db.exec('DROP TABLE quotas');
  }
}
db.exec(`
  CREATE TABLE IF NOT EXISTS quotas (
    model        TEXT PRIMARY KEY,
    dailyTokens  INTEGER,
    dailyRuns    INTEGER,
    updatedAt    TEXT
  );
`);

/** 全部限额行（给人看的形状由 quota.mjs 拼） */
export function listQuotaRows() {
  return db.prepare('SELECT model, dailyTokens, dailyRuns, updatedAt FROM quotas').all();
}

/** 一个模型的限额行；没有就是 null（= 不限制） */
export function getQuotaRow(model) {
  return (
    db.prepare('SELECT dailyTokens, dailyRuns, updatedAt FROM quotas WHERE model = ?').get(String(model ?? '')) ?? null
  );
}

/**
 * 整表替换：传进来的就是**全部**限额，没提到的模型一律回到"不限制"。
 *
 * 事务放这儿 —— 删完一半崩了会留下一个半空的额度表，那比"没保存"糟得多。
 */
export function replaceQuotas(entries = []) {
  const del = db.prepare('DELETE FROM quotas');
  const ins = db.prepare('INSERT INTO quotas (model, dailyTokens, dailyRuns, updatedAt) VALUES (?, ?, ?, ?)');
  const ts = nowIso();
  db.exec('BEGIN');
  try {
    del.run();
    for (const e of entries) ins.run(e.model, e.dailyTokens ?? null, e.dailyRuns ?? null, ts);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** 从某个时刻起跑过的运行（只要 model 与 usage 两列，给额度算账用） */
export function listRunUsageSince(sinceIso) {
  return db.prepare('SELECT model, usage FROM runs WHERE startedAt >= ?').all(sinceIso);
}

/** 一次运行的状态。以前调用方是直接伸进 db 查的 —— 外面不该有 SQL */
export function getRunStatus(runId) {
  return db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) ?? null;
}

/* ------------------------------------------------- 工作流：模板 */

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
    row.assigneePersonaId ?? null, row.status ?? '待开始',
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
        SET status = ?, decision = ?, note = ?, conversationId = ?, agentRunId = ?,
            assigneePersonaId = ?, startedAt = ?, endedAt = ?
      WHERE id = ?`,
  ).run(
    next.status,
    next.decision,
    next.note,
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
    row.status ?? '待开始',
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
db.exec(`
  CREATE TABLE IF NOT EXISTS git_repos (
    id            TEXT PRIMARY KEY,
    fullName      TEXT NOT NULL UNIQUE,
    owner         TEXT NOT NULL,
    name          TEXT NOT NULL,
    isPrivate     INTEGER NOT NULL DEFAULT 0,
    defaultBranch TEXT,
    localPath     TEXT NOT NULL,
    language      TEXT,
    addedAt       TEXT NOT NULL,
    lastSyncAt    TEXT
  );
`);

export function listGitRepos() {
  return db.prepare('SELECT * FROM git_repos ORDER BY addedAt DESC').all();
}

export function getGitRepo(id) {
  return db.prepare('SELECT * FROM git_repos WHERE id = ?').get(id) ?? null;
}

export function getGitRepoByPath(localPath) {
  return db.prepare('SELECT * FROM git_repos WHERE localPath = ?').get(localPath) ?? null;
}

export function getGitRepoByFullName(fullName) {
  return db.prepare('SELECT * FROM git_repos WHERE fullName = ?').get(fullName) ?? null;
}

export function addGitRepo({ fullName, owner, name, isPrivate = 0, defaultBranch = null, localPath, language = null }) {
  const row = {
    id: newId('gr'),
    fullName,
    owner,
    name,
    isPrivate: isPrivate ? 1 : 0,
    defaultBranch,
    localPath,
    language,
    addedAt: nowIso(),
  };
  db.prepare(
    `INSERT INTO git_repos (id, fullName, owner, name, isPrivate, defaultBranch, localPath, language, addedAt, lastSyncAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(row.id, row.fullName, row.owner, row.name, row.isPrivate, row.defaultBranch, row.localPath, row.language, row.addedAt);
  return getGitRepo(row.id);
}

export function touchGitRepoSync(id) {
  db.prepare('UPDATE git_repos SET lastSyncAt = ? WHERE id = ?').run(nowIso(), id);
  return getGitRepo(id);
}

export function deleteGitRepo(id) {
  return db.prepare('DELETE FROM git_repos WHERE id = ?').run(id).changes > 0;
}
