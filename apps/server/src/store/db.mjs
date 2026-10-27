/*
 * store/db.mjs —— 连接、建表、迁移、工具（唯一持库者）。
 *
 * 2026-10-22 由 store.mjs 拆分而来（见 docs/形态决策.md §十二「SQL 收口」）：
 * SQL 只出现在 **store/ 目录**里；store/ 之外的模块一律从 ../store.mjs 门面拿函数。
 * 本文件是 store/ 内唯一的 DatabaseSync 持有点，域模块从这里 import { db }。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { dataDir, dbPath } from '../config.mjs';

fs.mkdirSync(dataDir, { recursive: true });

/*
 * **`db` 只在 store/ 目录内可见**（2026-10-15 立规，2026-10-22 拆分后升级）。
 * 以前导出过，于是 quota.mjs 自己攒了一整套 SQL、server.mjs 也直接伸进来查一句 ——
 * 想换库的时候要改的地方就散成了三处。规矩：**SQL 只出现在 store/ 目录里**
 * （见 docs/形态决策.md §十二 第 2 条）；外面要什么，就往域模块里加一个函数、
 * 再从 ../store.mjs 门面 re-export。
 */
/*
 * 导入的落库时刻（2026-10-22，数据管理）：`/api/local/import` 把快照校验后写成
 * `<dbPath>.importing`，**真正换库在这里做** —— 模块加载、连接还没打开，换文件零并发风险。
 * 现库三件套（.db / -wal / -shm）整体改名进 backups/（保留 wal 配对，原样可回滚），
 * 再把快照扶正。别的进程还占着库时 rename 会失败（Windows 上必如此）—— 不崩，留着下次启动再换。
 */

{
  const pending = `${dbPath}.importing`;
  if (fs.existsSync(pending)) {
    const ok = fs.readFileSync(pending).subarray(0, 16).toString('latin1') === 'SQLite format 3\x00';
    if (!ok) {
      fs.rmSync(pending, { force: true });
      console.log('[数据管理] 待导入的文件不是 SQLite 库，已丢弃（本机数据原样）');
    } else {
      const d = new Date();
      const p = (n, w = 2) => String(n).padStart(w, '0');
      const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
      try {
        const backups = path.join(dataDir, 'backups');
        fs.mkdirSync(backups, { recursive: true });
        for (const suf of ['', '-wal', '-shm']) {
          const src = `${dbPath}${suf}`;
          if (fs.existsSync(src)) {
            fs.renameSync(src, path.join(backups, `导入前-${stamp}${suf ? `${suf}` : '.db'}`));
          }
        }
        fs.renameSync(pending, dbPath);
        console.log(`[数据管理] 已应用导入的数据快照，原库备份在 backups/导入前-${stamp}.db`);
      } catch (e) {
        console.log(`[数据管理] 换库没成功（${e?.message ?? e}），下次启动再试；本次仍用现有数据`);
      }
    }
  }
}

export const db = new DatabaseSync(dbPath);


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
    -- 这个 sessionId 是**哪个运行时族**（codex / claude / dsh）给的。见下面 ensureColumn 的说明
    family         TEXT NOT NULL DEFAULT '',
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

// 轻量迁移：老库补列（store/ 内共用；门面不转发它，对外不可见）
export function ensureColumn(table, column, ddl) {
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

/*
 * member_sessions.family：**这条 sessionId 是哪个运行时族给的**。
 *
 * 会话 id 是各 CLI 自己发的、也各自存各自的（Codex 的 rollout 在 `~/.codex/sessions`，
 * Claude 的存在 `~/.claude/projects`），**互不相通**。换运行时后拿旧 id 去 resume，
 * CLI 会直接报「no rollout found for thread id …」（2026-10-17 实报）。
 * 记下族名，换族时就知道这个 id 不该再传给新运行时了。
 *
 * 老库补列后是 ''（不知道）—— 仍按老行为先试 resume，失败时由 runs 那边自动降级成新会话。
 */

ensureColumn('member_sessions', 'family', "family TEXT NOT NULL DEFAULT ''");

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
 * **内置员工**（2026-10-18）：出厂自带、删不掉的那种（第一个名额现在是系统管家「崔老三」，
 * 2026-10-23 前是秘书「喜儿」—— 名额换了人，机制没换）。
 *
 * 为什么用标记而不是"按名字认"：名字是给人看的，历史上有段时期用户还能改（"喜儿"改成"小秘"很正常）。
 * 系统要认的是"这一个"，所以认 id + 这个标记；改名不影响身份（跟参考产品的 system_key 同一个道理）。
 * （2026-10-22 收编后名字/岗位/指令也锁死了，路由层 E2055；store 层拦的只有"删"，语义同前：**不许丢**。）
 */

ensureColumn('personas', 'builtin', 'builtin INTEGER NOT NULL DEFAULT 0');

/*
 * **头像**（2026-10-22）：存的是**文件名**，不是图片二进制 —— 图片放 apps/web/avatars/ 里，
 * 由现成的静态路由服务。为什么坚决不存 base64/二进制进库：库和 WAL 会跟着图片膨胀，
 * 备份变慢、读写变毛；文件名（expert-hetao.png 这种）几字节就够。
 * 路由层只放行白名单后缀的纯文件名，防止借这个字段写路径。
 */

ensureColumn('personas', 'avatar', 'avatar TEXT');

/*
 * **部门**（2026-10-25）：组织架构里他属于哪个部门。跟岗位同一个口径：
 * 一个值、可空、自由文本（界面给建议列表），**只用于看人**（通讯录按部门分组），
 * 引擎不读它、派活也不读它。不建部门表、不做层级 —— 用户拍板的口径：
 * 「部门是给人看的，把人按部门分组」。
 */

ensureColumn('personas', 'department', 'department TEXT');

/*
 * 并发数（2026-10-24，参照同类产品的"每个虚拟员工可配并行任务数"）：
 * 这个人名下同时最多几个 run 在跑。null = 没配过，用默认值（见 store/personas.mjs
 * 的 PERSONA_DEFAULT_MAX_PARALLEL）；配了就按它，最高 PERSONA_MAX_PARALLEL。
 * 是**资源属性**不是身份属性 —— 派活那一刻现查员工记录取值，不进会话快照。
 */
ensureColumn('personas', 'maxParallel', 'maxParallel INTEGER');

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

/* 附件清单（2026-10-23）：JSON 数组 [{name,size,mime,path,url}]，null = 没带附件。
   文件本体在 <dataDir>/uploads/<conversationId>/ 下，path 是给员工读的绝对路径，
   url 是界面回显用的 /api/files/... 地址。 */
ensureColumn('messages', 'atts', 'atts TEXT');

/* 结构化元数据（2026-10-24 卡票消息）：JSON 对象，null = 普通文本消息。
   现在只有一种：{type:'card', cardId} —— PM 建卡、卡片回执这类消息带上它，
   界面在气泡里画一张**卡票**（状态点 + 标题 + 执行人），点它直达任务卡详情页。
   text 照常写一句人话兜底：老视图 / 纯文本上下文（喂给 agent 的历史）不认 meta 也不丢信息。 */
ensureColumn('messages', 'meta', 'meta TEXT');

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

/*
 * 群 = **容器**，会话 = 容器里的一段（2026-10-20 用户要求「群也要能每次开新会话」）。
 *
 * 为什么要单独一张表：以前「一个群」就是 `conversations` 里的一行，群名/群助手/成员都挂在那行上；
 * 一旦允许一个群有多段会话，这些**群级**的属性就不能再挂在某一段会话上了（删掉那段，群就没了）。
 * 所以：
 *   · `groups`          —— 群的身份证：名字、群助手、解散时间（**不属于任何一段会话**）
 *   · `group_members`   —— 群的成员名单（群级，改一次对所有会话生效）
 *   · `conversations.groupId` —— 这段会话属于哪个群（NULL = 单聊 / 工单）
 * `thread_members` 仍然保留，作为**每段会话**的成员快照（dispatch 的 @ 人、没 @ 找群助手都读它）——
 * 建会话时从 group_members 拷一份，群改成员时同步到所有未解散的会话。
 */

db.exec(`
  CREATE TABLE IF NOT EXISTS groups (
    id                TEXT PRIMARY KEY,
    title             TEXT NOT NULL,
    assistantPersonaId TEXT,
    createdAt         TEXT NOT NULL,
    updatedAt         TEXT NOT NULL,
    dissolvedAt       TEXT
  );

  CREATE TABLE IF NOT EXISTS group_members (
    groupId   TEXT NOT NULL,
    personaId TEXT NOT NULL,
    joinedAt  TEXT NOT NULL,
    PRIMARY KEY (groupId, personaId)
  );
`);

// `conversations.groupId`：这段会话属于哪个群。空 = 不是群会话。

ensureColumn('conversations', 'groupId', 'groupId TEXT');

/*
 * 迁移老数据（幂等）：以前「群 = 一行 conversations」。
 * 对每个还没有 groupId 的群会话：
 *   ① 用它的 id 建一条 groups（群身份沿用原来的 id，所有已有引用都不变）；
 *   ② 把它的 thread_members 拷成 group_members（那是当时唯一的成员名单）；
 *   ③ 自己成为这个群的第一段会话（groupId = 自己的 id）。
 */

{
  const legacy = db
    .prepare("SELECT id, title, assistantPersonaId, createdAt, updatedAt, dissolvedAt FROM conversations WHERE kind = 'group' AND (groupId IS NULL OR groupId = '')")
    .all();
  if (legacy.length) {
    const insGroup = db.prepare(
      `INSERT OR IGNORE INTO groups (id, title, assistantPersonaId, createdAt, updatedAt, dissolvedAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const copyMembers = db.prepare(
      `INSERT OR IGNORE INTO group_members (groupId, personaId, joinedAt)
       SELECT ?, personaId, joinedAt FROM thread_members WHERE threadId = ?`,
    );
    const setGid = db.prepare('UPDATE conversations SET groupId = ? WHERE id = ?');
    db.exec('BEGIN');
    try {
      for (const c of legacy) {
        insGroup.run(c.id, c.title, c.assistantPersonaId ?? null, c.createdAt, c.updatedAt, c.dissolvedAt ?? null);
        copyMembers.run(c.id, c.id);
        setGid.run(c.id, c.id);
      }
      db.exec('COMMIT');
      console.log(`[迁移] 群改成"群 + 多段会话"：处理了 ${legacy.length} 个老群`);
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

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
    status             TEXT NOT NULL DEFAULT '待办',
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
    status             TEXT NOT NULL DEFAULT '待办',
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

/*
 * 流程步骤的状态更名（2026-10-17）：「待开始」这个叫法去掉了 —— 它和「待办」本来就是
 * 同一个意思（"到站了、还没开跑"），两个词并存只会让人问"差在哪"。
 * 老库里的存量行在这条 UPDATE 里一次性改过来；新库的建表默认值已经是「待办」。
 * 改完之后「待办」不再只是个记号：调度节拍会把停在待办的步骤自动派出去（见 workflows.retryPendingSteps）。
 * ⚠️ 必须放在 workflow_tasks 建表之后 —— 放前面的话全新库上这张表还不存在（前面那条订正踩过同一个坑）。
 */

for (const t of ['workflow_tasks', 'workflow_steps']) {
  db.prepare(`UPDATE ${t} SET status = '待办' WHERE status = '待开始'`).run();
}

/*
 * 任务状态更名（2026-10-24 状态体系重设计）：「待确认」→「待验收」。
 * 为什么改：看板上「待人确认」和「停下等人」两列名字都带"等人"，谁也说不清差在哪。
 * 两者其实是两类等待 —— **干完了等验收**（正向，点个头就完成）和**出问题了等人拍板**
 * （异常，不给输入就永远停着）。名字把"等什么"说出来，两列才分得开：
 * 待验收 / 已阻塞（列名同步改，见 project-tasks.mjs 的 COLUMNS）。
 * 老库存量行一次性改过来；project_tasks 那张表的迁移在 store/projects.mjs（表在那边建）。
 */

for (const t of ['workflow_tasks', 'workflow_steps']) {
  db.prepare(`UPDATE ${t} SET status = '待验收' WHERE status = '待确认'`).run();
}


ensureColumn('workflow_templates', 'nodes', 'nodes TEXT');

ensureColumn('workflow_templates', 'startNode', 'startNode TEXT');
// 发布：null = 草稿（只在工作流模块里编）；有值 = 已发布（工作台里能点开起流程）

ensureColumn('workflow_templates', 'publishedAt', 'publishedAt TEXT');
// 场地：这个单子挂在哪个会话里跑（项目群 / 某个数字员工的会话）

ensureColumn('workflow_runs', 'threadId', 'threadId TEXT');
// 发起时填的「想法」：这段话就是发给第一个执行人的第一句，也是以后回头看的起因

ensureColumn('workflow_runs', 'intent', 'intent TEXT');

ensureColumn('workflow_runs', 'currentNodeId', 'currentNodeId TEXT');
/*
 * 一步的**执行结果**（2026-10-18）：`{ state, summary, artifacts[], error }` 的 JSON。
 *
 * 为什么不复用 `note`：note 是给列表一行用的、**存的时候就截到 160 字**；
 * 而产物（改了哪个文件）经常落在被截掉的后半段里 —— 前端再想拆也拆不出来。
 * 所以结果在 run 结束那一刻、拿**全文**拆好存这儿，界面照着渲染就行。
 */

ensureColumn('workflow_tasks', 'result', 'result TEXT');

/*
 * PR 审阅与授权合并（2026-10-23，docs/PRD-2026-10-23-PR审阅与授权合并.md）：
 *   · workflow_runs 记 prRepo/prNumber —— 实例要拿它写回值班卡、执行合并。
 *     放在 runs 上而不是重新建关联表：一条审阅实例就是一个 PR，1:1 的东西不配多一张表。
 *   · git_repos 的两列（绑定管理员 + 授权开关）在**建表之后**补，见下面 git_repos 那段 ——
 *     建表语句在本文件靠后，提前 ALTER 会「no such table」（第一次就踩了）。
 */
ensureColumn('workflow_runs', 'prRepo', 'prRepo TEXT');
ensureColumn('workflow_runs', 'prNumber', 'prNumber INTEGER');

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
 * 状态名归到「确认族」：`待审批` → `待确认`（2026-10-24 状态重设计后最终名是「待验收」，
 * 这条迁移直接写最终名 —— 中间那句「待确认」在同一个启动里已被更早的更名迁移收走了，
 * 绕一道会在这两条之间留下一批错的「待确认」）。
 *
 * 为什么改：同一个东西界面上有四个说法 —— 节点开关（人工干预）、状态（待审批）、
 * 按钮（确认这一步完成）、提示（等你拍板）。节点开关现在统一叫「需要人工确认完成」，
 * 状态就跟着叫（现名「待验收」），按钮和提示本来就是"确认"。
 *
 * ⚠️ 有意思的是：库里**本来就有一条老数据叫「待确认」** —— 更早的版本用的就是这个名，
 *    后来被改成「待审批」。所以这次是**改回去**，那条老数据反而变成合法值了
 *    （之后又被上面那条更名迁移收成「待验收」）；要订正的是中间那批「待审批」。
 */

function migrateTaskStatusToConfirm() {
  const n = db.prepare("UPDATE workflow_tasks SET status = '待验收' WHERE status = '待审批'").run();
  if (n.changes) console.log(`[迁移] ${n.changes} 条任务状态：待审批 → 待验收`);
}

migrateTaskStatusToConfirm();

/** 把会话的权限覆盖设成某个值；传 null / 空 = 收回，跟随员工默认 */

function migrateAddConversationModel() {
  ensureColumn('conversations', 'model', 'model TEXT');
}
migrateAddConversationModel();

/**
 * **工单会话**（2026-10-18）：流程的每一步、看板上的每张卡，各在自己的会话里跑。
 *
 * 为什么要有：原来流程和任务卡都派进员工唯一那条 1:1，于是
 *   ① 消息模块被自动派活淹没；② 忙判定是按会话算的 → 一个员工同一时刻只能干一件活。
 * 拆开之后：1:1 只做人和他的对话；每条流程 / 每张卡各一条工单会话（kind='exec'），
 * 自己的上下文、自己的执行槽。**并发由项目互斥 + 每人上限兜着**（见 dispatch.mjs）。
 *
 * `execScope` 是"这条工单是谁"：`wf:<流程实例 id>` / `task:<任务卡 id>`。
 * 同一张卡返工复用它 —— 上下文连续，但不会串到别的卡上。
 */

function migrateAddExecConversation() {
  ensureColumn('conversations', 'execScope', 'execScope TEXT');
  ensureColumn('conversations', 'projectId', 'projectId TEXT');
  // 这次执行在哪个项目里干活 —— 项目互斥（同一目录同时只跑一个）靠它判
  ensureColumn('runs', 'projectId', 'projectId TEXT');
}
migrateAddExecConversation();

/** 取（或建）某条工单的会话。kind='exec' + execScope 唯一，标题跟着源头刷新 */

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
/*
 * `lastUsedAt` ＝ 这台机器**最近一次真的用面板**是什么时候（2026-10-20，P1-3「最近使用」）。
 *
 * 为什么不用 `lastSeenAt`：那是**心跳**时间（15 秒一跳，只能说明进程活着）。
 * 「最近使用」问的是"人什么时候在这台机器上动过面板"，所以写点只有一个：
 * 一个 `panel` scope 的请求被放行时，**节流**写一次（`auth.decide` → 本文件 `touchNodeUsed`）。
 */

ensureColumn('nodes', 'lastUsedAt', 'lastUsedAt TEXT');


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
 * 工作空间（2026-10-22）：这个活要用的 git 仓库，JSON `{fullName, branch}`。
 * 控制面发现 cwd 在某个已接入仓库里就把它记上 —— 节点拿到后**自己** clone/pull 到
 * 它数据目录的 repos/ 里干活。只发仓库全名与分支名，**不发总机的令牌、不发路径**：
 * 凭据各机各配（跟"连接器不下发"同一条安全线）。
 */

ensureColumn('node_jobs', 'repo', 'repo TEXT');

/*
 * 「这台机器上，总机的那个目录对应我哪儿的目录」——**非 git 项目**的工作空间映射表。
 * git 项目不用配（节点自动 clone）；普通文件夹项目（D 盘上随手建的一个目录）两边
 * 路径对不上，派活前控制面按这张表把 cwd 换成那台机器上的本地路径。
 * 映射存在**总机的库里**（nodeId 维度）：配置动作发生在控制面面板上，节点是只报事实的。
 */

db.exec(`
  CREATE TABLE IF NOT EXISTS node_paths (
    nodeId     TEXT NOT NULL,
    remotePath TEXT NOT NULL,
    localPath  TEXT NOT NULL,
    createdAt  TEXT NOT NULL,
    PRIMARY KEY (nodeId, remotePath)
  );
`);


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

/*
 * 仓库的**值班设置**（2026-10-23，PR 审阅与授权合并）——绑在仓库上不绑在人身上：
 * 巡检 / 审阅 / 合并都是按仓库发起的，「这个仓库的 PR 找谁看」自然长在仓库这一行上。
 *   · keeperPersonaId：值班管理员（数字员工）。空 = 没绑，行为与 2026-10-17 的巡检完全一致；
 *   · autoMerge：授权自动合并。**默认关** —— 不可逆操作的开头必须是"人来开"。
 */
ensureColumn('git_repos', 'keeperPersonaId', 'keeperPersonaId TEXT');
ensureColumn('git_repos', 'autoMerge', 'autoMerge INTEGER NOT NULL DEFAULT 0');


export function getMetaValue(key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row?.value ?? null;
}


export function setMetaValue(key, value) {
  if (value === null || value === undefined) {
    db.prepare('DELETE FROM meta WHERE key = ?').run(key);
    return;
  }
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, String(value));
}

/* ---------------------------------------------------------------- 定时任务（2026-10-17） */
/*
 * 「隔一段时间自动做一件事」是第一等需求（PR 巡检是第一个用户），所以**先有调度器、再有巡检**：
 * 节拍（多久跑一次）、开关、上次结果都在这一张表里，动作本身在 `schedules.mjs` 的动作注册表里。
 *
 * 为什么存**间隔分钟**而不是 cron 表达式：Windows 上没有 cron，装一个 cron 解析器又违背零依赖；
 * 「间隔」只是七种重复方式（间隔/单次/每天/每周/每双周/每月/每年，对齐 WorkBuddy 自己的定时任务）
 * 里的一种，时间类的方式存「几点 / 星期几 / 几号 / 几月」，比 cron 表达式人一眼就懂。
 *
 * `config` 是 JSON（动作自己解释，比如 PR 巡检的仓库与落哪个项目）—— 调度核心不看它。
 * `lastRunAt` 不只是给人看的：**下次什么时候该跑**由它算（重启后天然接上，不另存 nextRunAt）。
 */

db.exec(`
  CREATE TABLE IF NOT EXISTS schedule_jobs (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    action       TEXT NOT NULL,
    everyMinutes INTEGER NOT NULL,
    enabled      INTEGER NOT NULL DEFAULT 1,
    config       TEXT,
    lastRunAt    TEXT,
    lastStatus   TEXT,
    lastError    TEXT,
    lastSummary  TEXT,
    createdAt    TEXT NOT NULL,
    updatedAt    TEXT NOT NULL
  );
`);

/* 2026-10-17 晚：加「重复方式」。老库一列列 ALTER（列可能已存在），旧行全部归成 interval
 * —— everyMinutes 还在、语义不变，迁移完老任务照常按间隔跑。 */

for (const ddl of [
  "ALTER TABLE schedule_jobs ADD COLUMN repeat TEXT",
  "ALTER TABLE schedule_jobs ADD COLUMN atTime TEXT",
  "ALTER TABLE schedule_jobs ADD COLUMN weekday INTEGER",
  "ALTER TABLE schedule_jobs ADD COLUMN dayOfMonth INTEGER",
  "ALTER TABLE schedule_jobs ADD COLUMN month INTEGER",
  "ALTER TABLE schedule_jobs ADD COLUMN runAt TEXT",
]) {
  try {
    db.exec(ddl);
  } catch {
    /* 已有这列（重复启动），跳过 */
  }
}

db.prepare("UPDATE schedule_jobs SET repeat = 'interval' WHERE repeat IS NULL").run();


export function backupTo(file) {
  db.exec(`VACUUM INTO '${String(file).replace(/'/g, "''")}'`);
  return file;
}

/** 模块加载时跑一次：老技能名落到当前技能上（幂等，表里没有就什么都不做） */
