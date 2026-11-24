# bandi 架构设计说明书

> 这份讲**是什么、怎么拼起来的**：模块表与数据流。现行形态与边界见 [产品设计](bandi产品设计说明书.md)；
> 哪天拍了什么、撤掉过什么 → [产品决策更新日志](../../01-迭代版本包/产品决策.md)；
> 想先跑起来 → [快速开始](../快速开始.md) / [README](../../../README.md)。

## 1. 总览

### 1.1 一张图

```
 桌面壳（Tauri）   手机（Android 原生壳）   浏览器 / PWA
        └──────────── 三种客户端都连同一台 ────────────┘
                     本机控制面（apps/server）
        一个薄 Node 进程：node:http ＋ SSE ＋ better-sqlite3
        ├─ 身份中枢登录（bandi-hub，认证在中枢、授权在本机）
        ├─ 派活链路 dispatch → runs → adapters
        │        ↓ spawn 子进程
        │   codex exec ／ claude -p ／ dsh headless   ← 执行端永远在本机
        ├─ 代码托管（仓库接入 → 克隆 → agent 干活 → PR 巡检/审阅/合并）
        ├─ 存储与记忆（SQLite 库 ＋ 数据目录文件）
        └─ 出站通道（飞书长连接、GitHub API、身份中枢心跳）
```

形态是**单机**：一台机器一个完整实例，干活的是本地控制面拉起的 agent 子进程，
远程访问用隧道把本机接出去。形态与"不做什么"见 [产品设计](bandi产品设计说明书.md)。

### 1.2 主体功能

1. **集成 agent CLI** —— 接 **codex / claude / dsh** 三族 CLI（`apps/server/src/adapters.mjs`）。
   三个适配器输出**同一套事件词汇**，上层不关心底层是哪个 CLI；CLI 自己装、凭据自备，
   班底只识别、只调用，不代装。
2. **创建数字员工** —— 一个数字员工 = 名字 ＋ 职责指令 ＋ **岗位手册（平台内置，随岗位固定，不可见）** ＋
   绑定的运行时 ＋ 权限（沙箱模式）＋ 工作目录。
3. **和数字员工对话** —— 一条消息一次进程调用；从事件流里取回会话 id，下一句带回去就续上了。
   过程实时可见（思考 / 工具 / 回复），可随时停止。
4. **会话即工作项** —— 每个会话有标题、状态（待跑／跑中／完成／失败）和完整事件流。这是产品的骨架。

骨架之外已落地：流程引擎（模板 ＋ 实例）、项目与任务看板、项目群聊派活与成员 @ 接力、
代码托管与建 PR / 审阅 / 合并、插件与连接器、飞书通道、身份中枢登录、开机自启。
一次 run 可以包含 1~N 次尝试（见 5.2），连接抖动、进程被杀、上游报错不再直接落成卡面「失败」。

## 2. 目录地图

```
apps/
  server/     控制面：HTTP ＋ SSE ＋ 调度 ＋ 派活（薄 Node 进程，本进程 spawn CLI）
    src/
      server.mjs        分发入口：精确 key 表在前，动态段交给 routes/chain.mjs
      routes/           按域拆的路由模块（chain.mjs 按数组下标先匹配先赢）
      store/            **唯一持库者** —— SQL 只出现在这个目录里（store/db.mjs）
      adapters.mjs      协议族 → 适配器注册表（codex / claude / dsh）
      runtimes.mjs      运行时族与实例管理（设备 → CLI → 详情，设备现在只有"本机"）
      dispatch.mjs      「派活」链路：解析目标 → 拼首轮任务 → 起一次 run
      runs.mjs          run 台账与收尾编排（settle）
      git-repos.mjs     代码托管（接入、克隆、凭据）；pr-watch / pr-review / pr-create / repo-patrol
      hub/              身份中枢客户端（bandi-hub，HTTP only）
      feishu.mjs        飞书通道（员工级，出站 WebSocket）
      security/         CSP、CSRF、路由策略、IP 白名单、本地密钥
  web/        面板：一张静态页，原生 ES modules，无打包器、无框架
  desktop/    Tauri 薄壳：拉起本地控制面、窗口指过去、退出时收掉自己起的那个
  mobile-native/  Android 原生壳（Kotlin，零第三方依赖），签票进门后 WebView 承载已登录面板
```

派活链路与工作流引擎、飞书、群聊共用同一个入口（`dispatch.mjs`），状态码由调用方按
`err.code` 映射；错误码唯一出口在 `apps/server/src/error-codes.mjs`。

## 3. 技术底座

### 3.1 技术选型

| 层 | 选型 | 为什么 |
| --- | --- | --- |
| 执行端 | 子进程拉起 `codex exec --json` / `claude -p --output-format stream-json` / dsh headless，读 stdout 的按行 JSON | 三个 CLI 都自带一次性模式，自行退出 |
| 服务端 | 一个薄 Node 进程：`node:http` ＋ SSE | 仓库零依赖，一个人能维护 |
| 存储 | **better-sqlite3**（原生模块） | 2026-10-22 从 node:sqlite 换来；桌面安装包随附其运行时必需文件。SQL 只出现在 `store/` 目录里；结构代次 `PRAGMA user_version`（`SCHEMA_VERSION` 落后就拒绝启动 —— 老程序打开新库会静默产出半对的数据，那比报错难查得多） |
| 前端 | 一张静态页（不引构建工具） | 原生 ES modules、无打包器、无框架，形态定了之后结论是**不换框架** |
| 数据落点 | `BANDI_DATA`；不设默认**本机用户目录**（Windows `%APPDATA%\bandi`） | 命令行与桌面壳统一到用户目录；仓库 `data/` 只作显式沙盒。刻意**不做**「写不进去就自动换家」的兜底 |
| 远程访问 | 缺省对外监听（`0.0.0.0`）且强制鉴权；隧道接出（tailscale / cloudflared / frp） | 回环只剩 `BANDI_HOST=127.0.0.1` 的调试形态；"对外服务"开关维度已删除 |
| 客户端 | 桌面：Tauri 薄壳（`apps/desktop/src/shell.rs` ＋ `apps/desktop/shell.mjs`）；手机：Android 原生壳（`apps/mobile-native`）；浏览器：同一份 `apps/web` | 桌面安装包自带 Node 运行时与原生模块；三种客户端连同一台本机控制面，UI 单一来源 |
| 身份中枢 | bandi-hub（独立仓库），HTTP only | 认证在中枢、授权在本机；中枢只转发请求，不存状态、不派活 |

### 3.2 身份与鉴权

- **认证在身份中枢，授权在本机**（[产品设计说明书](bandi产品设计说明书.md)）。中枢（bandi-hub，另一个仓库）
  的唯一出口是 `apps/server/src/hub/client.mjs` —— **只准 HTTP 认中枢，不许 import 它的代码**，
  契约版本收在 `HUB_API_VERSION`。两个调用点：`heartbeat`（60 秒报地址，中枢画「在线」）；
  `deviceLogin`（本机登录页的账号密码转中枢，登录即登记机器 —— 2026-11-07 起是机器接入唯一通道）。
- **身份只剩两种**：`user`（人）与 `run`（一轮活；数字员工的运行钥匙，现发、收尾吊销）。
  operator 身份 2026-11-20 下线；本机钥匙、回环、被踢会话票都统一合成机主身份，
  只有 revoke-others 接口需要验证有效会话票。
- **人走账号，机器走凭据**：浏览器与手机一律过登录；脚本 / CLI / 运维用
  `X-Bandi-Token` 头或首次进场时的 `?token=`（当场换成会话票并重定向掉）。
- 控制面缺省对外监听并强制鉴权；端口固定 18787（`BANDI_PORT` 可显式覆盖）。

### 3.3 三处收口：让机制代替纪律（2026-11-08）

这三件事以前都靠"记得改"，现在都有机器判。

**分发顺序是数据，不是书写顺序。** `/api/*` 分两层：`server.mjs` 里一张**精确 key 表**
（字面量路径一次哈希查表）在前；带动态段的路径交给 `routes/chain.mjs`
按数组下标依次问各域模块（先匹配先赢）。漏挂 / 重挂由 `tools/check-dispatch-chain.mjs` 扫
（挂在 `run-smokes` 的唯一入口上，与 `check-routes`、`check-doc-drift` 同级）。

**安全响应头装在请求链最前面。** 全站一份 CSP（`security/csp.mjs`），`script-src` 用
`index.html` 内联脚本的 sha256，而不是 `'unsafe-inline'` —— 界面是 innerHTML 拼字符串，
`esc()` 是纪律，CSP 是机制。哈希按 mtime 现算（含 CRLF 归一，否则 Windows 上 CRLF 检出
会让内联脚本全部失效）。另加 `nosniff`。

**状态只有一份词表。** `store/status.mjs`：任务八态 ⇄ 看板列（反向映射由同一张表推出）、
流程态、运行七态。看板、流程、聊天回执全从它派生；建表默认值必须是词表里的词
（`smoke-status-vocab.mjs` 按源码文本核，不开库）。

**活文档对账也是机制**（`tools/check-doc-drift.mjs`）：根目录与 docs 下每份 .md 都要登记成
活文档或快照；活文档里提到的仓库文件必须存在、错误码必须在码表里、旧口径短语命中即报。

## 4. 运行时与执行端

### 4.1 协议族与实例

两层概念（`apps/server/src/runtimes.mjs`）：

- **协议族（family）**：codex / claude / dsh，写在代码里 —— 每接一个要写它的事件
  词汇映射，不是配置能变出来的。
- **运行时实例（runtime）**：某台设备上的一个具体配置（哪个可执行文件、什么名字、开不开）。
  同一族可以加多个实例。

- 设备只有一台 `local`（执行端就是本进程 spawn 子进程）；`kind/host/port/user/keyPath`
  字段是给将来 SSH 设备预留的。
- 预置运行时是 `codex` 和 `dsh`（可改不可删）；**claude 不预置但可识别**，接入走
  「设置 → 运行时」识别，可执行路径无字面量默认值（`BANDI_CLAUDE_EXE` 仅供开发指定）。
- 沙箱语义三家不同：codex 只有 `danger-full-access` 在无人审批下跑得动命令；
  claude 对应概念是 `--permission-mode`（`default` / `plan` 档在 headless 下被禁用，
  `acceptEdits` 保留 —— 它能自动放行编辑）；dsh 只有 `workspace-write`。
- 「生成提交说明」（`apps/server/src/commit-msg.mjs`）是**一次性短跑**：不建 run、不留会话，
  运行时按候选链逐个尝试、单个失败自动切下一个，全部失败退规则兜底 —— 按钮永远给得出东西。

### 4.2 统一事件词汇

三个适配器都产出这套，前端只认这一套：

| 事件 | 含义 |
| --- | --- |
| `session` | 本次运行的会话标识（Codex 的 thread_id／claude 的 session_id／dsh 的 sessionId） |
| `status` | `turn_start` / `step_start` / `step_end` / `turn_end`（带 usage） |
| `thinking` | 推理文本 |
| `text` | 助手正式回复 |
| `tool` | 工具动作（命令执行、文件改动、MCP 调用…） |
| `error` | 失败 |
| `final` | 最终答案 |

### 4.3 怎么算做完了

一条可复现的链路，不靠感觉。三个 runtime 都已实测通过：

```sh
# Codex：新会话 + 续接
codex exec --json -C <项目目录> -s read-only -          # 退出码 0，事件流含 item.completed / turn.completed
codex exec resume <thread_id> --json -                  # 同一 thread，上下文还在

# Claude Code：同样的两件事
claude -p --output-format stream-json --verbose -       # 结算事件 {"type":"result","subtype":"success",...}
claude --resume <session_id> -p --output-format stream-json --verbose -

# dsh：同样的两件事
dsh --profile headless --json -                         # session 事件给出 sessionId
dsh --profile headless --json --session-id <id> -       # turn 变成 2
```

**平台的验收 = 在界面上点出同一件事，落进同一份事件流。**

### 4.4 三家适配器的已知不对称

- **Codex**：`exec` 收 `-C <目录>` 与 `-s <沙箱模式>`；但 `exec resume <id>` **两个都不收**，
  续接靠进程 cwd 与会话记录。`-p <name>` 可叠加 `$CODEX_HOME/<name>.config.toml`。
  `codex queue` 可给运行中的会话递话。会话按 cwd 过滤（`--all` 可关）。
- **Claude Code**（`apps/server/src/claude.mjs`）：任务文本走 **stdin** 配 `-p`（不带 prompt
  参数），与 codex 同一个约定；`--output-format stream-json --verbose` 每行一个 JSON 事件，
  结算事件是 `{"type":"result","subtype":"success",...}`（⚠️ `type` 键排在对象末尾，只扫开头
  会以为它不是 result）。`--resume <session_id>` 能续接记忆。`system/thinking_tokens` 极其
  密集，适配器**直接丢弃**，否则会把 SSE 和界面冲爆；stderr 上混非 JSON 告警行，解析要跳过。
  沙箱对应 `--permission-mode`，超出 `PERMISSION_MODES` 的值不传给 CLI。
- **dsh**（`apps/server/src/dsh.mjs`）：CLI 不在 PATH 上，真实做法是 `ELECTRON_RUN_AS_NODE=1`
  起 Electron 可执行文件再跑 `app.asar` 里的 `cli.js`；`.cmd` 过 shell 有引号坑，
  所以直接起 exe ＋ 参数数组。班底只把**模型名**用 `--patch` 传下去；走哪条地址、带谁的 Key
  由 profile 自己的配置决定（凭据由 dsh 从 `$DSH_HOME/.env` 读，班底不注入）。
  ⚠️ 补丁层是**整块替换 `config`**、不是逐字段合并 —— 只写 `model` 会把 profile 里的
  `provider:` 一起冲掉，所以那一行必须原样读回来再写回去。

**中途递话**：Codex 有 `codex queue --thread <id> --message <text>`，能给正在跑的会话递话；
claude / dsh headless 没有对应能力（每次调用只跑一个任务）。这是**排期问题，不是能力问题**，
接口按"排队式"设计，留出递话的位置。

## 5. 派活链路：一轮任务的合同

### 5.1 注入块总表

一轮任务的首轮提示词由多个**注入块**拼成（`apps/server/src/dispatch/contract.mjs` ＋
`apps/server/src/dispatch.mjs`）。每块的来源与取舍：

| 注入块 | 来源 | 说明 |
| --- | --- | --- |
| 平台契约 | `dispatch/contract.mjs` | 平台行为规格（结论先行、交付标记、红线、递话等 14 条），每轮注入 |
| 岗位手册 | `apps/server/src/roles/packs/<key>.md`（经 `roles/pack.mjs` 注入） | 随岗位固定、不可见；15 个岗位一份手册，读缓存、解析 frontmatter |
| 岗位判据 | `apps/server/src/role-criteria.mjs` | 手册里"能被工具事件证明"的那几条，进合同、收尾由 `criteria-audit.mjs` 核 |
| 方法论（技能） | `skills.mjs` ＋ `skill-inline.mjs` | 通用技能放技能库；按任务文本匹配命中的技能正文**内联**进本轮 |
| 长期记忆 | `experience.mjs`（口径 / 事实 / 坑） | 见 6.1 |
| 进度账 | `progress-ledger.mjs` | 见 6.2 |
| 任务卡 / 附件 / 连接器 / 仓库简报 | `dispatch/contract.mjs` 等 | 按本轮任务形状拼装 |

### 5.2 一个 run 的生命周期：一次尝试，还是有限次（2026-11-21）

起因是个直白的问题：「同一个任务，别的 agent 能做到底，bandi 撞一下就报失败停下，为什么」。
根因不在模型，在**外层没有循环**：一次 run = 一次 spawn，进程一退平台只拿到终态，
而成功的判据只有"exitCode 非 0 / isError"这一个布尔 —— 连接抖一下、进程被杀一次、
上游 502 一下，全都落成卡面「失败」，等人来点「重跑一次」。

现在的口径：**一次 run 可以包含 1~N 次尝试**，同一条 CLI 会话、同一个 run id、
同一份事件流，只在最后收一次尾（一次写库、一次吊销钥匙、一次推进流程）。
判据与提示语收在 [`apps/server/src/run-retry.mjs`](../../../apps/server/src/run-retry.mjs)，
编排在 `runs.mjs` 的 `settle()`。

| 失败长什么样 | 续不续 | 为什么 |
| --- | --- | --- |
| 上游 5xx / 超时 | **续** | 通道是通的，换个时刻就好 |
| 只有退出码、没有任何原因（如 `退出码 4294967295` = Windows 的 -1） | **续** | 进程被谁杀了不该算"活做不成"；真库里最常见的一种 |
| 配置错 / CLI 未登录 / 权限档挡命令 / 上下文满 / 4xx / 限流 | 不续 | 再跑一遍是同一个结果，等于拿 token 换一句一样的话 |
| 通道断（连不上模型） | 不续 | CLI 内部已重连过 5 次；那条"去修代理、回来回「继续」"的回话才是人能照做的下一步 |
| 已经下了交付声明（`[完成]` / `[受阻]`）才挂的 | 不续 | 不是"半路死"，是"说完了才死" |
| 有具体报错的未知失败 | 不续 | 被藏起来的错误，第二次还是错的 —— 先让人看见 |

三件容易漏的事：

- **续跑第一句是"先复核你上一轮的判断"**，不是"接着干"。停下来的诊断会过期：
  实报里某轮 15:54 判"钩子路径有问题"，次日那条残留早没了，重跑直接 101 项烟测全过 ——
  它抱着一张过期的诊断在等人回话。
- **不续也要写明为什么没续**（`（未自动续跑：…）` 会进卡面）。否则人只看到
  "跑挂了：unknown MCP server"，永远不知道平台试过没有。
- 次数上限 `BANDI_RUN_AUTO_RETRY`（默认 2，0 = 关）、间隔
  `BANDI_RUN_AUTO_RETRY_DELAY_MS`（默认 1.5 秒）。人工停止、挂死收口一律不续。

### 5.3 停之前的最后一个动作：环境类断言先实测（2026-11-21，契约第 13 条）

同一场复盘里最便宜的一处浪费：**凭代码推断宣布机器状态**。「钩子不在 / 端口被占 / 进程残留 /
依赖没装 / 连不上」—— 一条 `ls`、`netstat`、`where`、`curl` 就能证伪，却直接拿来当停下的理由。
而且环境是流动的：停下那一刻的结论，第二天多半已经不成立（上一节"诊断会过期"是同一个病）。

规则（`apps/server/src/dispatch/contract.mjs` 第 13 条，**每轮注入**，因为它管的是任意一轮的"停"）：

| 场景 | 该做什么 |
| --- | --- |
| 要说「不存在 / 没装 / 被占了 / 没启动 / 连不上 / 已失效」 | 先跑**一条**能验它的命令 |
| 因为环境不行要写 `[受阻]` | 必须至少留一条实测输出；一条没跑 = 不算结论 |
| 真跑不了（没有可用的命令） | 写「未验证」，不许写成事实 |
| 验完发现能过 | 别停，干完再回话 |

**平台侧有一道可证伪的核对**（`apps/server/src/task-claim-audit.mjs` 的 `unverifiedEnvClaim`）：
`[受阻]` + 本轮 **0 条 `tool` 事件** + 理由是环境事实 = 这个判断在数学上不可能验证过。
处置是**只记信箱（info）、不唤醒任何人**，跟"虚构派卡"那种打回重做不同：

- 它不是谎 —— 模型没声称做了动作，只是"该验没验"；
- 自动唤醒要花一次真跑，而且在"每轮都收尾"的链路上容易滚成循环（一次错判 = 一直重跑）。

三种情况明确不管：不是 `[受阻]`（还在干活）、理由含**权限 / 授权 / 审批 / 沙箱**
（entitlement，报了是对的）、调过任何工具（分不清验的是哪一条 —— 宁可漏报不误报）。

### 5.4 岗位判据：专业度里能被核对的那一半（2026-11-22）

岗位手册里写着"验证过再交""不许按进程名清杀"，但平台**不认识这些话** ——
它只认 `[完成]` 和卡状态。于是手册里的红线只是建议：说了不一定做，做了没人核。
所以把"能被工具事件证明的动作"从手册里抽出来，变成判据（`apps/server/src/role-criteria.mjs`）：

| kind | 判据 | 核的方式 | 什么时候核 |
| --- | --- | --- | --- |
| `must-run` | 必须跑过 | 本轮有一条**命令**包含给定候选之一（OR） | 只在**声称完成**那一轮 |
| `must-read` | 必须读过 | 本轮有一次读文件命中给定路径之一 | 同上 |
| `never` | 不许（红线） | 本轮**任何**工具动作出现该串（正则更稳） | 任何时候 |

来源两层：`BASE_CRITERIA`（全体员工，目前只有一条 —— 不许按进程名全量清杀，契约第 12 条的执行侧）
＋ 手册 `## 判据` 段（现在只有研发 / 测试）。**宁少不滥**：判据一多，合同变长、误判变多，
最后没人看。两条防诬告的规矩：本轮**一条命令事件都没有** → `must-run` 记「判不了」不记失败；
没声称完成 → 不核（干活中途当然可以没跑）。处置（`criteria-audit.mjs`，挂在 `onRunFinish`、
注册在台账核对之后）：**只记信箱**，不改卡、不 @ 人、不自动重跑。

## 6. 记忆与会话

### 6.1 长期记忆：经验簿 + 事实层（2026-11-22 / 2026-11-23）

员工的"记忆"其实一直在库里（聊天、卡、返工、交付证据都持久化），丢的只有**他自己那条 CLI 会话**。
会话一换（上下文预算、换流程、换卡），他就重新做人 —— 同一个坑踩第二遍，团队口径要重新讲一遍。

`persona_notes`（`store/notes.mjs` ＋ `experience.mjs`）**只收两类**：

| kind | 是什么 | 谁写进来 | 例子 |
| --- | --- | --- | --- |
| `repo` | 这个团队的口径 | **只收显式写入**（接口 / `bandi note add`） | 「服务端改完必须重启，静态资源直读不用」 |
| `pitfall` | 这个人踩过的坑 | **平台从核对结论里自动记**（kind='audit' 的通知） | 「声称完成，但没做：完成前跑过测试」 |

事实层（`persona_facts`，`store/facts.mjs`）补的是另一半：
"这个仓里怎么跑、常改哪儿"也会随会话丢掉，但它不该由人或模型写，而是从**跑通那一轮**
的 `run_events` 里抽。只认三类，且每一类都能指回一条真实的 tool 事件：

| kind | 是什么 | 抽取条件 | 例子 |
| --- | --- | --- | --- |
| `command` | 验证命令 | 命令文本命中 `run-smokes` / `npm test` / `pytest` … | 「冒烟验证：node tools/run-smokes.mjs」 |
| `restart` | 重启方式 | 真的执行过 `bandi restart` | 「重启：bandi restart」 |
| `path` | 常改文件 | 同一文件在 **≥2 轮**里被改过 | 「常改：apps/server/src/dispatch.mjs」 |

事实按 `scope`（仓库根）隔离；摘不出来就一条都不记 —— **宁可少，不要猜**。三条刻意的边界：

- **不记「聊过什么」。** 聊天摘要是模型生成的，会漏会编、没人能核，还占上下文。
- **反复犯的并成一条。** 去重键抹掉日期 / 卡号 / 这一轮的命令清单，同一个坑犯五次是 `hits=5`。
- **不记"这人行不行"。** 经验簿存事实与口径，不存评价；评价是人做的事。

注入（`dispatch.mjs`，位置在"这轮要干什么"之后、"方法论"之前）：**口径 ≤4 + 事实 ≤3 + 坑 ≤3**，
用与本轮任务同一份 `matchText` 做**相关度召回**（英文/路径词 + 中文二元组重叠，确定性、不猜同义）；
整块 ≤1200 字；**一条都没有就返回空串**（不印空壳）。每人上限 200 条。

入口：`bandi note ls/add/rm/forget <员工>`、`GET|POST|DELETE /api/personas/:id/notes`、
`GET|DELETE /api/personas/:id/facts` ＋ 员工简卡里的「长期记忆」栏（事实**没有 POST** ——
手写的东西属于口径，事实只能由平台抽）；运行钥匙对两边都**只读**。

### 6.2 会话轮换：上下文预算 + 进度账（2026-11-22）

**什么时候换**（`apps/server/src/session-budget.mjs`）：成员 CLI 会话不是无上限的 ——
轮数、年龄、累计 input、单轮上下文四个平台侧可观测的量任一超限 → `shouldRotate()` 换会话。
（起因实报：一段会话从 13:54 跑到 22:19，累计 3000 万 input，模型把工具调用写成正文、空回话。）

**换的时候带什么**（`apps/server/src/progress-ledger.mjs`）：经验簿管**长期口径**，
换会话那一刻还差另一半 —— **眼前这件事现在什么状态**。从库里抽**平台能证明的事实**
（不生成摘要、不猜意图）：

| 事实 | 从哪来 |
| --- | --- |
| 卡号 / 标题 / 现在状态 / PR·CI 结论 | `project_tasks`（证据口径复用 `delivery-evidence.mjs`） |
| 一共几轮、完成 / 失败 / 被停各几次 | `runs` |
| 每轮什么时候、多久、改了哪些文件、最后一条命令、为什么挂 | `run_events` 尾部 80 条 + `runs.error` |
| 反复失败的原因（按次数） | `runs.error`，归一后计数 |
| 上次回话的落款（`[完成]` / `[受阻]` / 没写） | `messages` 最后一条 + `delivery-claim.mjs` |

三条边界：**只认改动类事件**（Read 的 `path` 不算 —— 否则"看了一眼"会被说成"改过"）；
**报错说人话**（`退出码 4294967295` →「进程异常退出」）；**有上限**（明细 3 轮 / 文件 10 个 /
整块 1200 字）。注入时机只有两个：**轮换之后**和**这条会话本来就是空的**；正常续接不注入。

## 7. 交付判定：声明 + 客观证据两条腿（2026-11-21）

老口径是**声明制**：平台只认回话里的 `[完成]` / `[受阻]`（`apps/server/src/delivery-claim.mjs`），
员工漏写一次，活就算白干。病根：**把语义判断压在一条容易漏掉的字符串约定上**。所以补第二条腿：

| 腿 | 判据 | 谁说了算 |
| --- | --- | --- |
| 声明 | 回话里的 `[完成]` / `[受阻]`，或运行钥匙 PATCH 上报 `review` | 员工 |
| 证据 | **PR 已合并** / **CI 全绿**（都来自 GitHub，不是模型说的） | 平台 |

判据单点在 `apps/server/src/delivery-evidence.mjs`（纯函数）：合并最强；CI 全绿次强（只认
PR 还开着时，且结论不超 24 小时）；**CI 红是反对证据**，不许把卡往上推。落地分两处：

- **收尾**（`onTaskRunFinished`）口径不变：`[完成]` → 待验收，无标记 → 已阻塞。
- **巡检**（`pr-watch.mjs`）把 `headSha` 上的 check-runs 抓回卡上，再按证据收：
  「已阻塞」＋ 强证据 → **待验收**（`advanceByEvidence`）。

`advanceByEvidence` 的四道闸，缺一不动：只动「已阻塞」；只认强证据；人手动改成阻塞的不动；
员工自报 `[受阻]` 的不翻案。终点只有「待验收」，**永不「已完成」** —— 验收权在人手里。

## 8. 代码托管与 PR 链路

### 8.1 仓库接入与凭据

**仓库是一等资源**（`apps/server/src/git-repos.mjs`）：连接 → 挑仓库 → 克隆到本地 →
agent 在克隆目录里干活；项目 / 任务卡**引用**仓库。凭据规矩（2026-10-17 事故之后立的）：

- 一个 fine-grained PAT，GitHub 侧只授权要接入的仓库；存数据目录 `github-token` 文件
  （0600 尽力），**不进库、不进日志、不回显**。
- 克隆/拉取用 `http.extraheader` 把令牌带在**请求头**里，`.git/config` 里不留带令牌的 URL。
- `agentEnv()` 给 agent 子进程的环境**删掉一切 GIT_\* / GH_TOKEN / GITHUB_TOKEN** ——
  agent 拿不到本机凭据、也起不了交互式认证。

仓库身份采用**接入时一次性解析 origin 落库**（ghRef / remoteUrl）的模型，不在请求期动态
解析 git origin —— 目录改名不失效；仓库引用一律用落库的 ghRef（owner/name），
身份缺失直接抛内部错误，不伪装成 404；目录失效走重定位，重定位前校验 origin 一致。

### 8.2 PR 管理模块分工

| 模块 | 干什么 |
| --- | --- |
| `pr-watch.mjs` | 平台首个定时动作：发现新 PR / issue、回收 CI 结论、派审阅；CI 状态回填卡面供证据收口 |
| `repo-patrol.mjs` | 仓库级巡检：把「要不要巡检、多久一次」放回仓库设置；**调度器不动**，每个仓库最多映射一条 `pr-scan` 定时任务 |
| `pr-review.mjs` | 审阅与授权合并：**管理员（agent）只有建议权**（产出四段结论，不碰令牌）；**合并是平台动作**（流程引擎的动作节点，服务端持令牌调 GitHub）；授权 = 合并节点前是否等人确认 |
| `pr-create.mjs` | 建链路：领先提交 → 建 PR，平台侧、可审计 |
| `agent-git.mjs` | 给**研发岗**发岗位凭据：能力层（`http.extraheader` 只注入这一次运行）＋ 规则层（`core.hooksPath` 指向固定钩子目录，`pre-push` 挡直推 main / 改写历史 / 推凭据，见 `git-hooks/pre-push.mjs`）＋ 审计层（推送写 `agent-pushes.jsonl`）。**默认只给研发岗**；这不是安全沙箱，与 pr-create 并存 |

**GitHub 与 Git 的边界**（文案与功能都按这条画）：Git 基础推拉不需要配置令牌；
令牌只影响 PR、合并、从账号添加仓库这些走 GitHub API 的功能。

## 9. 插件与连接器

- **插件**（`apps/server/src/plugins.mjs`）：**界面插槽** ＋ 插件市场。
  市场在 `catalog/plugins/<id>/`（随仓库走的插件源），已装在 `plugins/<id>/`，
  账本在数据目录 `plugins.json`；卸载 = 删目录 + 删账本，停用 = 只改账本。
  manifest v1 契约里 `panel.mode: "declarative"` —— **L1 不执行插件代码**，宿主按声明渲染。
- **连接器**（`apps/server/src/connectors.mjs`）：**「外面来的能力」的登记与接线**，
  不叫插件是因为市场来的能力不进班底进程 —— 班底只登记（账本）＋ 接线（翻译成每个 CLI
  能吃的启动参数），代码在它自己的进程里跑，隔离是白捡的。
  现在只有 `mcp` 一种 kind（stdio / streamable-http）；三家接线方式不同：
  codex 走 `-c`、dsh 走 `--patch`、claude 走 `--mcp-config`。
  ⚠️ **接线与提示词必须同进退**：往首轮注入"你有 ssh 连接器"的前提是 `resolve(family)`
  真的生成了启动参数，不然模型会拿提示词去找一个不存在的工具。

## 10. 飞书通道

- **员工级通道**（2026-10-29 用户定稿）：**一个数字员工对应一个飞书自建应用** ——
  每个员工自己的 App ID / App Secret、自己的一条长连接、自己的白名单。
  私聊某个员工的机器人 = 直接找那个员工（没有"绑定"概念）；群里 **@机器人自己** 才响应，
  剔掉 @自己 后的正文派给自己的员工。每条指令回一张**可更新的互动卡片**，随 run 推进
  （思考中 / 调工具 / 收尾）刷新，跑完落最终结果。
- **为什么是出站 WebSocket 长连接**（`apps/server/src/feishu.mjs`）：飞书事件订阅的长连接
  模式是**我们主动连它**，不需要公网回调地址与 HTTPS —— 正好贴合"只听本机端口、自托管无
  HTTPS"的形态。产品决策日志里「不引 WebSocket」说的是**入站**架构；对第三方 SaaS 的
  **出站**客户端是另一回事。
- **零依赖怎么守**：不引官方 SDK（要 npm install），协议手写 —— 帧格式（pbbp2.Frame 的
  protobuf 字段号）照抄 `larksuite/node-sdk` 的 `ws-client/` 源码：
  `POST /callback/ws/endpoint` 拿临时接入点 → WS 收帧（headers 数组、payload 按
  message_id/sum/seq 分片合并）→ 回 ack（不回会被重推）→ ping/pong 心跳 →
  断线重连（间隔/次数由服务端下发，带随机抖动）。WebSocket 客户端用 Node 22 自带的
  全局 `WebSocket`。
- **派活完全复用现成链路**：`persona-task.mjs` 的形状（建/复用会话 → `dispatchToThread`；
  撞 busy → `dispatchEventToThread` 落库进队等补派）；进度归约直接 import 前端纯逻辑模块
  `web/js/run-progress.mjs`（无 DOM），不另写一份"事件 → 阶段"。
- **数据落点**：凭据 `<dataDir>/feishu-apps.json`（0600 尽力，不进库、不进日志、接口只回掩码；
  secret 留空 = 保留原值）；旧的单通道 `feishu.json` 启动时迁移一次、迁完留底。
  HTTP 面在 `routes/feishu.mjs`，错误码认领 E2061–E2066。
- **v1 边界**：只认文字消息；`allowOpenIds` 白名单（空 = 不限制）；服务重启丢进行中的卡跟踪
  （要"必须不丢"的活走任务卡）；只接中国大陆版飞书（国际版 Lark 域名不同）。
