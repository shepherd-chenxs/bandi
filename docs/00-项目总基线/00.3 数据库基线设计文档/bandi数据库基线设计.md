# bandi 数据库基线设计文档

> 这份是**基线**：描述系统当前最新的库表结构，随代码一起演进。
> 结构以 `apps/server/src/store/db.mjs` 为唯一真源；某个迭代改了什么，记在迭代包并同步更新这份文档。
> 系统整体怎么拼起来的见 [架构设计说明书](../00.2%20总体设计/bandi架构设计说明书.md)。

## 变更历史

| 版本 | 修改日期 | 修改人 | 修改内容 | 对应产品迭代版本 |
| :--- | :--- | :--- | :--- | :--- |
| V1.0 | 2026-11-24 | 施工代理 | 初版基线：按结构版本 17 的建表与迁移实况整理 | V1.7.x |

---

## 1. 总览

### 1.1 引擎与位置

| 项 | 取值 | 说明 |
| :--- | :--- | :--- |
| 引擎 | **better-sqlite3**（原生模块） | 同步 API，单进程持有；2026-10-22 从 `node:sqlite` 换来 |
| 文件 | `<数据目录>/bandi.db`（＋ `-wal` / `-shm`） | 数据目录默认 `%APPDATA%\bandi`（Windows），可用 `BANDI_DATA` 覆盖 |
| 日志模式 | `journal_mode = WAL` | 读写分离，写锁只挡毫秒级 |
| 忙等待 | `busy_timeout = 5000` | 第二个进程偶发开库时不至于立刻 `database is locked` |
| 结构版本 | `PRAGMA user_version`（当前 `SCHEMA_VERSION = 17`） | 库比程序新 → 拒绝启动；库比程序旧 → 跑幂等迁移后盖新号 |

### 1.2 两条硬规矩

1. **SQL 只出现在 `apps/server/src/store/` 里**。其他模块一律从 `store.mjs` 门面拿函数，
   域模块从 `store/db.mjs` 拿 `db`。换库时要改的地方只有一处。
2. **状态只存码，不存中文**（2026-11-12 拍板）。`todo` / `doing` / `review` 这些码是唯一真身，
   中文只是显示用的 label，词表在 `apps/server/src/store/status.mjs`。界面和接口都不许自建第二套。

### 1.3 分域一览

| 域 | 表 | 职责 |
| :--- | :--- | :--- |
| 会话与运行 | `personas`、`conversations`、`messages`、`runs`、`run_events`、`thread_members`、`member_sessions`、`persona_skills` | 数字员工、会话、消息、一次 agent 执行及其事件流 |
| 群 | `groups`、`group_members` | 群是容器，会话是容器里的一段 |
| 流程引擎 | `workflow_templates`、`workflow_runs`、`workflow_tasks`、`workflow_steps`（旧） | 模板 → 实例 → 节点任务 |
| 项目看板 | `projects`、`project_tasks` | 项目、看板卡（含 PR 与 CI 结论） |
| 平台事实 | `notices`、`meta`、`schedule_jobs`、`node_tasks` | 信箱、迁移标记位、定时任务、本机安装任务 |
| 代码托管 | `git_repos` | 仓库身份、值班管理员、合并闸开关 |
| 身份与审计 | `users`、`user_sessions`、`hub_links`、`security_events`、`security_events_archive` | 账号、会话票、中枢绑定、只追加审计 |
| 记忆 | `persona_notes`、`persona_facts` | 经验簿（口径/坑）与事实层（验证命令/重启方式/常改文件） |

---

## 2. 关系图

```
                    ┌──────────────┐
                    │   personas   │◄──────────────┐
                    └──────┬───────┘               │
        1:N                │                       │ N:M
   ┌───────────────────────┼───────────────────────┴──────────┐
   │                       │                                  │
   ▼                       ▼                                  │
┌────────────────┐   ┌──────────────┐   N:M               ┌────┴───────────┐
│ persona_skills │   │ conversations│◄────────────────────┤ thread_members │
└────────────────┘   └──┬────┬───┬──┘                      └────────────────┘
                        │    │   │                          ┌────────────────┐
            1:N         │    │   │ N:M                      │ member_sessions│
                   ┌────▼─┐  │   └──────────────────────────┤ （每成员每作用域│
                   │messages│ │                              │   一条 CLI 会话）│
                   └────────┘ │                              └────────────────┘
                              │ 1:N
                        ┌─────▼─────┐ 1:N   ┌────────────┐
                        │   runs    ├──────►│ run_events │
                        └─────┬─────┘       └────────────┘
                              │ taskId（弱关联）
                              ▼
┌──────────┐ 1:N ┌────────────────┐      ┌──────────────────┐ 1:N ┌────────────────┐
│ projects ├────►│ project_tasks  │      │ workflow_templates├────►│ workflow_runs  │
└──────────┘     └───────┬────────┘      └──────────────────┘     └───────┬────────┘
                         │ prRepo（弱关联 owner/name）                     │ 1:N
                         ▼                                                ▼
                  ┌────────────┐                                 ┌────────────────┐
                  │ git_repos  │                                 │ workflow_tasks │
                  └────────────┘                                 └────────────────┘

┌──────────┐ 1:N ┌────────────────┐
│  groups  ├────►│ conversations  │（conversations.groupId）
└────┬─────┘     └────────────────┘
     │ N:M
     ▼
┌────────────────┐
│ group_members  │
└────────────────┘
```

关系全部是**逻辑外键**（SQLite 未开 `foreign_keys`），靠 store 层保证一致性；
跨域引用（`runs.taskId`、`project_tasks.prRepo`）是松散关联，删了对方不会级联。

---

## 3. 表结构

> 字段类型只写 SQLite 的亲和类型。「补列」表示该列由 `ensureColumn` 增量添加，
> 老库启动时自动补齐。

### 3.1 personas —— 数字员工

建表：`store/db.mjs`。

| 字段 | 类型 | 约束 | 说明 |
| :--- | :--- | :--- | :--- |
| `id` | TEXT | PK | `p-xxxxxxxx` |
| `name` | TEXT | NOT NULL | 显示名；改名不影响身份 |
| `instructions` | TEXT | NOT NULL DEFAULT `''` | 职责指令 |
| `runtime` | TEXT | NOT NULL DEFAULT `codex` | 绑定的运行时实例 id |
| `sandbox` | TEXT | NOT NULL DEFAULT `workspace-write` | 沙箱模式 |
| `cwd` | TEXT | | 主工作目录 |
| `model` | TEXT | | 绑定的模型（空＝用 CLI 默认） |
| `createdAt` | TEXT | NOT NULL | ISO 时间 |

补列：

| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `rootDirs` | TEXT（JSON 数组） | 附加工作目录；平台根由服务端自动附加，不入库 |
| `role` | TEXT | 岗位自由文本（**历史列**，权限判定已改读 `roleKey`） |
| `roleKey` | TEXT | 内置岗位 key；NULL＝没认出来，无任何权限 |
| `builtin` | INTEGER DEFAULT 0 | 内置员工，**不许删** |
| `avatar` | TEXT | 头像**文件名**（图片在 `apps/web/avatars/`，不入库） |
| `department` | TEXT | 部门自由文本，只用于通讯录分组 |
| `maxParallel` | INTEGER | 并发上限；NULL＝用默认值 |
| `showThinking` | INTEGER DEFAULT 0 | **死列**（2026-11-08 起不读不写），老库不做列重建 |

### 3.2 conversations —— 会话

| 字段 | 类型 | 约束 | 说明 |
| :--- | :--- | :--- | :--- |
| `id` | TEXT | PK | `c-xxxxxxxx` |
| `title` | TEXT | NOT NULL | 标题 |
| `personaId` | TEXT | NOT NULL | 直属员工（群会话为 `''`） |
| `sessionId` | TEXT | | 1:1 的 CLI 会话 id（群/工单走 `member_sessions`） |
| `status` | TEXT | NOT NULL DEFAULT `pending` | 状态码，词表见 `store/status.mjs` |
| `createdAt` / `updatedAt` | TEXT | NOT NULL | ISO 时间 |

补列：

| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `kind` | TEXT DEFAULT `direct` | `direct` 单聊／`group` 群／`exec` 工单 |
| `groupId` | TEXT | 属于哪个群（NULL＝不是群会话） |
| `ownerUserId` | TEXT | 创建人（人） |
| `assistantPersonaId` | TEXT | 群助手（agent），没 @ 时找它 |
| `ownerPersonaId` | TEXT | **历史列**，不再读 |
| `hiddenAt` | TEXT | 「从列表移除」时间（可恢复） |
| `dissolvedAt` | TEXT | 群解散时间（语义上结束） |
| `sandbox` | TEXT | 会话级权限覆盖；NULL＝跟随员工 |
| `model` | TEXT | 会话级模型覆盖 |
| `execScope` | TEXT | 工单归属：`wf:<实例id>` / `task:<卡id>` |
| `projectId` | TEXT | 这条工单在哪个项目里干活（项目互斥靠它判） |

### 3.3 messages —— 消息

| 字段 | 类型 | 约束 | 说明 |
| :--- | :--- | :--- | :--- |
| `id` | TEXT | PK | |
| `conversationId` | TEXT | NOT NULL | |
| `runId` | TEXT | | 由哪一轮产出 |
| `role` | TEXT | NOT NULL | `user` / `assistant` / `system` |
| `text` | TEXT | NOT NULL | 正文（落库时会剥掉 `[完成]` 标记） |
| `createdAt` | TEXT | NOT NULL | |
| `personaId` | TEXT | 补列 | 谁说的（群里必须记） |
| `atts` | TEXT（JSON） | 补列 | 附件清单 `[{name,size,mime,path,url}]` |
| `meta` | TEXT（JSON） | 补列 | 结构化元数据，目前只有卡票 `{type:'card',cardId}` |

### 3.4 runs —— 一次 agent 执行

| 字段 | 类型 | 约束 | 说明 |
| :--- | :--- | :--- | :--- |
| `id` | TEXT | PK | `r-xxxxxxxx` |
| `conversationId` | TEXT | NOT NULL | |
| `runtime` | TEXT | NOT NULL | 实际使用的运行时实例 |
| `status` | TEXT | NOT NULL | 运行七态之一（码） |
| `exitCode` | INTEGER | | 进程退出码 |
| `error` | TEXT | | 失败原因 |
| `usage` | TEXT（JSON） | | token 用量 |
| `startedAt` / `endedAt` | TEXT | NOT NULL / 可空 | |
| `model` | TEXT | 补列 | **实际生效**的模型（不是员工表原始字段） |
| `personaId` | TEXT | 补列 | 谁跑的 |
| `taskId` | TEXT | 补列 | 哪一步流程办的（空＝聊天派活） |
| `projectId` | TEXT | 补列 | 在哪个项目里干活 |
| `claim` | TEXT | 补列 | 交付落款：`done`/`blocked`/`unclaimed`/`silent`，**落库前从原文判** |

> `workflow_runs`（流程实例）和 `runs`（一次执行）是两个东西：前者是业务单据，后者是进程级执行。

### 3.5 run_events —— 运行事件流

| 字段 | 类型 | 约束 | 说明 |
| :--- | :--- | :--- | :--- |
| `runId` | TEXT | NOT NULL，联合 PK | |
| `seq` | INTEGER | NOT NULL，联合 PK | 按**每次运行**从 1 单调递增，就是 SSE 的 `id` |
| `evt` | TEXT | NOT NULL | 事件 JSON（统一事件词汇：session/status/thinking/text/tool/error/final） |
| `at` | TEXT | NOT NULL | |

### 3.6 thread_members —— 会话成员

| 字段 | 类型 | 约束 |
| :--- | :--- | :--- |
| `threadId` | TEXT | NOT NULL，联合 PK |
| `personaId` | TEXT | NOT NULL，联合 PK |
| `joinedAt` | TEXT | NOT NULL |

1:1 会话不登记（它的成员就是 `conversations.personaId`）。

### 3.7 member_sessions —— 每成员每作用域的 CLI 会话

| 字段 | 类型 | 约束 | 说明 |
| :--- | :--- | :--- | :--- |
| `threadId` | TEXT | NOT NULL，联合 PK | |
| `personaId` | TEXT | NOT NULL，联合 PK | |
| `scope` | TEXT | NOT NULL DEFAULT `''`，联合 PK | `''`＝普通会话；`wf:<实例id>`＝某条流程（隔离上下文） |
| `sessionId` | TEXT | | CLI 给的会话 id |
| `lastSeenRowid` | INTEGER | NOT NULL DEFAULT 0 | 读到哪儿的水位线 |
| `family` | TEXT | 补列 DEFAULT `''` | 这条 sessionId 是哪个运行时族（codex/claude）给的 |
| `startedAt` | TEXT | 补列 | 会话起点，用于上下文预算轮换 |

### 3.8 persona_skills —— 技能挂载

| 字段 | 类型 | 约束 | 说明 |
| :--- | :--- | :--- | :--- |
| `personaId` | TEXT | NOT NULL，联合 PK | |
| `skillName` | TEXT | NOT NULL，联合 PK | 技能正文是文件（`skills/`），表里只记挂载关系 |
| `addedAt` | TEXT | NOT NULL | |
| `enabled` | INTEGER | NOT NULL DEFAULT 1 | 0＝留着但暂停（不注入 prompt） |

### 3.9 notices —— 信箱

| 字段 | 类型 | 约束 | 说明 |
| :--- | :--- | :--- | :--- |
| `id` | TEXT | PK | |
| `kind` | TEXT | NOT NULL | 通知类型 |
| `severity` | TEXT | NOT NULL DEFAULT `warn` | |
| `code` | TEXT | | 错误码 |
| `title` | TEXT | NOT NULL | |
| `detail` | TEXT | | |
| `personaId` / `conversationId` / `projectId` / `runId` | TEXT | | 点进去能回到出事那一轮 |
| `dedupeKey` | TEXT | | 去重键（同轮同码重试 3 次只记 1 条，`count` 累加） |
| `count` | INTEGER | NOT NULL DEFAULT 1 | |
| `readAt` | TEXT | | NULL＝未读，左栏徽标数它 |
| `createdAt` / `updatedAt` | TEXT | NOT NULL | |

### 3.10 groups / group_members —— 群

`groups`：

| 字段 | 类型 | 约束 | 说明 |
| :--- | :--- | :--- | :--- |
| `id` | TEXT | PK | 群 id 沿用历史上那条会话 id |
| `title` | TEXT | NOT NULL | |
| `assistantPersonaId` | TEXT | | 群助手 |
| `projectId` | TEXT | 补列 | 挂在哪个项目上（可空；一项目最多一群，唯一性在路由层挡） |
| `createdAt` / `updatedAt` | TEXT | NOT NULL | |
| `dissolvedAt` | TEXT | | 解散时间 |

`group_members`：`(groupId, personaId)` 联合 PK ＋ `joinedAt`。

### 3.11 流程引擎四张表

**workflow_templates**

| 字段 | 类型 | 约束 | 说明 |
| :--- | :--- | :--- | :--- |
| `id` | TEXT | PK | |
| `name` | TEXT | NOT NULL | |
| `steps` | TEXT | NOT NULL | **v1 遗留**，新代码读写 `nodes` |
| `builtIn` | INTEGER | NOT NULL DEFAULT 0 | 内建模板删不掉 |
| `createdAt` / `updatedAt` | TEXT | NOT NULL | |
| `nodes` | TEXT（JSON） | 补列 | 节点与连线 |
| `startNode` | TEXT | 补列 | 显式开始节点 |
| `publishedAt` | TEXT | 补列 | NULL＝草稿 |
| `archivedAt` | TEXT | 补列 | 有值＝已归档（模板不删、历史实例保留） |
| `autonomous` | INTEGER DEFAULT 0 | 补列 | 1＝自主交付（无人工闸，终态自动汇报信箱） |

**workflow_runs**（流程实例）

| 字段 | 类型 | 约束 | 说明 |
| :--- | :--- | :--- | :--- |
| `id` | TEXT | PK | |
| `templateId` | TEXT | NOT NULL | |
| `title` | TEXT | NOT NULL | 发起那一刻的快照 |
| `status` | TEXT | NOT NULL DEFAULT `doing` | 流程态码 |
| `currentStep` | INTEGER | NOT NULL DEFAULT 0 | **v1 遗留** |
| `note` | TEXT | | |
| `createdAt` / `updatedAt` | TEXT | NOT NULL | |
| `threadId` | TEXT | 补列 | 挂在哪个会话里跑 |
| `intent` | TEXT | 补列 | 发起时的「想法」，即第一个执行人的第一句 |
| `currentNodeId` | TEXT | 补列 | v2 引擎只记当前节点 |
| `prRepo` / `prNumber` | TEXT / INTEGER | 补列 | PR 审阅实例一个 PR，1:1 直接落这两列 |

**workflow_tasks**（v2：每访问一次节点＝一条任务）

| 字段 | 类型 | 约束 | 说明 |
| :--- | :--- | :--- | :--- |
| `id` | TEXT | PK | |
| `runId` | TEXT | NOT NULL | |
| `nodeId` | TEXT | NOT NULL | |
| `nodeName` | TEXT | NOT NULL | |
| `visit` | INTEGER | NOT NULL DEFAULT 1 | 第几次到访（测试不通过打回＝第二次） |
| `detail` | TEXT | NOT NULL DEFAULT `''` | |
| `assigneePersonaId` | TEXT | | 经办人 |
| `status` | TEXT | NOT NULL DEFAULT `todo` | 任务八态码 |
| `decision` | TEXT | | 通过/驳回 |
| `note` | TEXT | | 一句话说明（存时截到 160 字） |
| `conversationId` / `agentRunId` | TEXT | | |
| `startedAt` / `endedAt` | TEXT | | |
| `result` | TEXT（JSON） | 补列 | `{state,summary,artifacts[],error}`，**全文**拆好存 |
| 唯一键 | | `UNIQUE(runId, nodeId, visit)` | |

**workflow_steps**（v1 旧表）：`(id, runId, idx, name, detail, assigneePersonaId, mode, status, note, conversationId, agentRunId, startedAt, endedAt)`，
`UNIQUE(runId, idx)`。**不再写入**，只在 `migrateWorkflowV1` 里被读一次。

### 3.12 projects / project_tasks —— 项目与看板

**projects**：`id`、`name`、`root`、`extraRoots`（JSON）、`createdAt`、`updatedAt`。

**project_tasks** 基础列：`id`、`projectId`、`title`、`description`、`status`、`assigneePersonaId`、
`conversationId`、`runId`、`createdAt`、`updatedAt`。

补列（24 个）：

| 分组 | 字段 |
| :--- | :--- |
| 来源 | `source`（`manual`/…）、`sourceKey`、`sourceRunId`、`externalKey` |
| 协作 | `assigneeGroupId`、`parentTaskId`（协作子卡挂主卡）、`creatorConvId`、`notifiedFor` |
| 人 | `createdBy`（历史）、`createdByUserId`、`assigneeUserId`、`statusByUserId`、`statusAt` |
| 队列 | `queuedAt` |
| 流程联动 | `flowTemplateId`、`flowRunId` |
| PR | `prRepo`、`prNumber`、`prState`（open/merged/closed）、`prTitle`、`prCheckedAt` |
| CI | `prCiState`、`prCiFailed`、`prCiAt` |

### 3.13 git_repos —— 代码托管

| 字段 | 类型 | 约束 | 说明 |
| :--- | :--- | :--- | :--- |
| `id` | TEXT | PK | |
| `fullName` | TEXT | NOT NULL **UNIQUE** | 显示名 |
| `owner` / `name` | TEXT | NOT NULL | 服务端解析出的 owner/仓库名 |
| `isPrivate` | INTEGER | NOT NULL DEFAULT 0 | |
| `defaultBranch` | TEXT | | |
| `localPath` | TEXT | NOT NULL | 本地克隆位置（只是指针，改名不影响身份） |
| `language` | TEXT | | |
| `addedAt` / `lastSyncAt` | TEXT | NOT NULL / 可空 | |
| `ghRef` | TEXT | 补列 | GitHub API 认的 `owner/name`，接入时解析一次写死 |
| `remoteUrl` | TEXT | 补列 | 接入时的远端地址，重定位时核对"是不是同一个仓库" |
| `keeperPersonaId` | TEXT | 补列 | 值班管理员（数字员工） |
| `autoMerge` | INTEGER | 补列 DEFAULT 0 | 授权自动合并，**默认关** |
| `requireGate` | INTEGER | 补列 DEFAULT 1 | 合并前是否等检查；1＝拦，没配 CI 的仓库可关 |

### 3.14 schedule_jobs —— 定时任务

基础列：`id`、`name`、`action`、`everyMinutes`、`enabled`、`config`（JSON，动作自己解释）、
`lastRunAt`、`lastStatus`、`lastError`、`lastSummary`、`createdAt`、`updatedAt`。

补列：`repeat`（七种重复方式，老行归 `interval`）、`atTime`、`weekday`、`dayOfMonth`、`month`、`runAt`。

> 「下次什么时候该跑」由 `lastRunAt` 现算，不另存 `nextRunAt` —— 重启后天然接上。

### 3.15 node_tasks / meta

**node_tasks**：`id`、`nodeId`（本机恒 `local`）、`kind`、`family`、`status`、`output`、
`createdAt`、`claimedAt`、`endedAt`、`arg`（补列，"怎么做"的参数，**不是命令**）。

**meta**：`key` PK ＋ `value`。现存标记位：`flow_start`、`workflow_v2`。

### 3.16 记忆两张表

**persona_notes**（经验簿）：`id`、`personaId`、`kind`（`repo` 团队口径／`pitfall` 踩过的坑）、
`text`、`source`（`audit`/`manual`）、`hits`、`evidence`、`dedupe`、`createdAt`、`updatedAt`，
`UNIQUE(personaId, dedupe)`。

**persona_facts**（事实层）：同上结构 ＋ `scope`（仓库根，小写正斜杠；`''`＝不分仓库），
`kind` 为验证命令／重启方式／常改文件。来源是 `run_events` 里真的发生过的 tool 事件。

### 3.17 身份与审计

**users**：`id`、`name`、`builtin`、`disabled`、`createdAt`、`updatedAt`，补列 `nickname`。
`salt` / `hash` / `roleId` 是**死列**（账号已挪到身份中枢，本地密码体系退场），老库不做重建。

**user_sessions**：`tokenHash` PK、`userId`、`createdAt`、`expiresAt`、`lastSeenAt`。

**hub_links**：`accountId` PK、`userId`、`login`、`createdAt`、`lastEnterAt` —— 中枢账号与本机用户的绑定。

**security_events**（只追加）：

| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `id` / `at` / `kind` | TEXT NOT NULL | |
| `actorKind` / `actorId` | TEXT | `user` / `run` / `local-key` / `loopback` |
| `action` / `resource` | TEXT | |
| `result` | TEXT NOT NULL DEFAULT `pending` | 收尾由 `ok` / `fail` 回填 |
| `reason` / `httpStatus` / `endedAt` | | |
| `ip` / `ua` / `requestId` | TEXT | |

两个触发器保证**不可改不可删**：`trg_events_no_update` 只允许 `pending → ok|fail`，
`trg_events_no_delete` 一律 `RAISE(ABORT)`。`security_events_archive` 是同构归档表
（`CREATE TABLE … AS SELECT * FROM … WHERE 0`）。

---

## 4. 索引

| 索引 | 表 | 列 | 用途 |
| :--- | :--- | :--- | :--- |
| `idx_messages_conv` | messages | (conversationId, createdAt) | 会话消息时间序 |
| `idx_messages_run` | messages | (runId) | 按 run 反查消息 |
| `idx_runs_conv` | runs | (conversationId, startedAt) | 会话下的运行 |
| `idx_runs_started` | runs | (startedAt) | 按时间查运行 |
| `idx_notices_unread` | notices | (readAt, updatedAt) | 未读徽标 |
| `idx_notices_dedupe` | notices | (dedupeKey) | 去重命中 |
| `idx_workflow_tasks_agentrun` | workflow_tasks | (agentRunId) | run 收尾时反查任务 |
| `idx_node_tasks_queue` | node_tasks | (nodeId, status, createdAt) | 取待办安装任务 |
| `idx_persona_notes_persona` | persona_notes | (personaId, kind, updatedAt DESC) | 注入前取最近 |
| `idx_persona_facts_persona` | persona_facts | (personaId, scope, kind, updatedAt DESC) | 按仓库取事实 |
| `ix_events_at` | security_events | (at) | 审计按时间翻页 |
| `ix_events_actor` | security_events | (actorId, at) | 按操作人翻页 |

---

## 5. 结构版本沿革（`PRAGMA user_version`）

版本号是**单调递增的整数**，只回答"迁移走到第几代"，不是程序版本号。
加一次迁移就把 `SCHEMA_VERSION` ＋1。

| 版本 | 日期 | 变更 |
| :--- | :--- | :--- |
| 1 | 2026-11-08 | 版本号机制落地（此前全靠幂等函数＋ meta 标记位） |
| 2 | 2026-11-08 | 回话消息清掉 `meta.progress` |
| 3 | 2026-11-08 | `users.nickname` |
| 4 | 2026-11-09 | `project_tasks.assigneeGroupId` / `parentTaskId` |
| 5 | 2026-11-09 | 多机节点子系统删除，DROP `nodes` / `node_tokens` / `node_invites` / `node_jobs` / `node_paths` |
| 6 | 2026-11-11 | `personas.roleKey`（权限挂内置岗位） |
| 7 | 2026-11-11 | 新表 `notices`（信箱） |
| 8 | 2026-11-11 | `member_sessions.startedAt`（上下文预算轮换） |
| 9 | 2026-11-12 | 状态词表统一成码，老库中文值一次性换码 |
| 10 | 2026-11-13 | `workflow_templates.autonomous` |
| 11 | 2026-11-16 | 额度功能退场，DROP `quotas` |
| 12 | 2026-11-20 | `git_repos.ghRef` / `remoteUrl` |
| 13 | 2026-11-21 | `project_tasks.prCiState` / `prCiFailed` / `prCiAt` |
| 14 | 2026-11-22 | 新表 `persona_notes` |
| 15 | 2026-11-22 | `runs.claim`（交付落款） |
| 16 | 2026-11-23 | 新表 `persona_facts` |
| 17 | 2026-11-24 | `git_repos.requireGate`（合并前等检查的仓库级开关） |

### 5.1 已删除的表

| 表 | 时间 | 原因 |
| :--- | :--- | :--- |
| `quotas` | 2026-11-16 | 额度功能退场 |
| `nodes` / `node_tokens` / `node_invites` / `node_jobs` / `node_paths` | 2026-11-09 | 多机节点子系统删除 |
| `roles` / `role_menus` / `role_permissions` / `user_otp` / `otp_challenges` / `access_tokens` / `refresh_tokens` | 2026-11-07 | 本地账号凭据层退场，账号挪到身份中枢 |

`node_tasks` **不删**：本机软件商店一键安装仍走它。

### 5.2 迁移的写法约定

- 加表用 `CREATE TABLE IF NOT EXISTS`，老库启动即补；加表要同步 `SCHEMA_VERSION`。
- 加列用 `ensureColumn(table, column, ddl)`，先 `PRAGMA table_info` 查，没有才 `ALTER TABLE`。
- 改主键只能**重建表**（SQLite 不支持改 PK），见 `member_sessions` 加 `scope` 那一段。
- 所有迁移**必须幂等**：跑第二次 `changes = 0`，不许报错、不许重复改数据。
- 迁移顺序有依赖：涉及某张表的 UPDATE 必须放在**那张表建表之后**（踩过两次：全新库上表还不存在，整个模块加载失败）。

---

## 6. 数据落盘

| 路径 | 内容 |
| :--- | :--- |
| `<数据目录>/bandi.db`（＋`-wal`/`-shm`） | 主库 |
| `<数据目录>/uploads/<会话id>/` | 聊天附件（库里的 `messages.atts` 只存元数据与路径） |
| `<数据目录>/backups/` | 备份与导入前的原库整体改名（`.db`/`-wal`/`-shm` 三件套成组） |
| `<数据目录>/server.log` | 服务端日志（跟着数据目录走） |
| `<数据目录>/token` | 访问令牌（0600） |

**导入换库**在模块加载时做（连接还没打开，零并发风险）：先校验 `<dbPath>.importing` 是合法 SQLite，
再把现库三件套整体 rename 进 `backups/导入前-<时间戳>.db`，最后把快照扶正。失败不崩，下次启动再试。

---

## 7. 约定

| 约定 | 内容 |
| :--- | :--- |
| 主键 | 均为 TEXT，前缀标识域：`p-` 员工、`c-` 会话、`r-` 运行、`pt-` 任务卡、`n-` 通知（`newId(prefix)` 统一生成） |
| 时间 | 一律 ISO 8601 字符串（`nowIso()`），不带时区偏移的本地格式化字符串只在显示层出现 |
| 状态 | 只存码；中文 label 由 `store/status.mjs` 派生 |
| JSON 列 | `usage`、`atts`、`meta`、`config`、`nodes`、`result`、`rootDirs`、`extraRoots`、`evidence` |
| 软删 | 会话用 `hiddenAt` / `dissolvedAt`；模板用 `archivedAt`；信封用 `readAt`。<br>员工、仓库、卡片是**硬删**（由 store 层做级联清理） |
| 布尔 | 用 INTEGER 0/1（`builtin`、`enabled`、`isPrivate`、`autoMerge`、`requireGate`） |
| 内置不可删 | `personas.builtin = 1` 的行 store 层直接拦 |