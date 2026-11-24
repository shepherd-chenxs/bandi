# bandi 接口基线文档（主库）

> 这份是**基线**：描述本机控制面当前对外提供的全部 HTTP 接口口径。
> 接口真源是 `apps/server/src/server.mjs`（精确路径表）与 `apps/server/src/routes/`（正则链）。
> 库表结构与字段语义见 [数据库基线设计文档](../00.3%20数据库基线设计文档/bandi数据库基线设计.md)。

## 变更历史

| 版本 | 修改日期 | 修改人 | 修改内容 | 对应产品迭代版本 |
| :--- | :--- | :--- | :--- | :--- |
| V1.0 | 2026-11-24 | 施工代理 | 初版基线：按现有路由分发实况整理全量接口 | V1.7.x |

---

## 1. 总览

### 1.1 基地址与协议

| 项 | 取值 |
| :--- | :--- |
| 基地址 | `http://<本机>:18787`（端口由 `BANDI_PORT` 覆盖） |
| 协议 | 纯 HTTP/1.1 ＋ SSE；没有 gRPC、没有 GraphQL |
| 请求体 | JSON（`Content-Type: application/json`），附件上传走原始二进制 |
| 响应体 | JSON；附件回显是文件流；SSE 是 `text/event-stream` |
| 字符集 | UTF-8 |

控制面默认监听 `0.0.0.0` 并**强制鉴权**；`BANDI_HOST=127.0.0.1` 是只剩回环的调试形态。

### 1.2 分发是两层的

```
请求
 │
 ├─ GET /api/ping ────────────────► 免鉴权直接应答（健康探测）
 │
 ├─ auth.guard（令牌 / 来源闸）
 ├─ 写操作审计落 pending
 ├─ /api/local/* ─────────────────► 本机专属接口（自己那道回环校验）
 ├─ /hub/enter ───────────────────► 身份中枢验票换会话
 │
 ├─ 非 /api/ ─────────────────────► 静态资源（缺文件 404 文本）
 │
 └─ /api/* ──► CSRF 守卫
                │
                ├─ routes[key]  精确表（字面量路径，一次哈希查表）
                └─ runChain()   正则链（带动态段的路径，顺序＝数组下标，先匹配先赢）
                     └─ 都没命中 → 404 E2036
```

两条规矩：

1. **精确表排在链之前**（`server.mjs` 的 `routes` 对象）。能在精确表里写死的路径不要放进链里 —— 哈希查表更快。
2. **链的顺序是契约**，收在 `apps/server/src/routes/chain.mjs` 的 `CHAIN` 数组里。每个 `routes/*.mjs` 导出的
   handler 必须出现**恰好一次**；漏挂 / 重挂由 `tools/check-dispatch-chain.mjs` 在 PR 门禁里扫。
   加模块＝在数组里插一行并写清"为什么排在这儿"，不要只写"新模块"。

### 1.3 链的顺序

| # | 模块 | 覆盖域 |
| :--- | :--- | :--- |
| 1 | `events` | 全局 SSE（长命连接，链头） |
| 2 | `conversation` | 会话详情、发消息、附件 |
| 3 | `persona` | 数字员工、技能挂载、经验簿、事实层、飞书 |
| 4 | `agent-cards` | 建卡通道（run token） |
| 5 | `agent-deliver` | 交付与闸门动作（run token） |
| 6 | `agent-files` | 产物入库（run token） |
| 7 | `expert` | 专家库 |
| 8 | `users` | 账号、登录、安全（含 `/api/me`） |
| 9 | `project` | 项目、看板卡、评论、附件 |
| 10 | `workspace` | 工作区文件读取、系统打开 |
| 11 | `status` | 控制面重启 |
| 12 | `fs` | 目录列举（选工作目录） |
| 13 | `group` | 群聊 |
| 14 | `skill` | 技能包 |
| 15 | `connector` | 连接器（MCP 之类） |
| 16 | `runtime` | 运行时 / 模型清单 / 设备 |
| 17 | `localTasks` | 本机安装任务 |
| 18 | `plugin` | 插件动作 |
| 19 | `ssh` | SSH 服务器与密钥 |
| 20 | `workflow` | 流程模板与实例 |
| 21 | `run` | 单次运行的流与收尾 |
| 22 | `git` | 代码托管全链路 |
| 23 | `schedules` | 定时任务 |
| 24 | `prefs` | 界面偏好 |
| 25 | `feishu` | 飞书（挂在 persona 路径下，单独成链） |

> 越宽的通配越要往后放。历史上 `/api/nodes/register` 被 `/api/nodes/:id` 抢走过，端点已删、教训保留。

---

## 2. 鉴权与安全

### 2.1 三种进门方式

| 方式 | 凭据 | 适用 |
| :--- | :--- | :--- |
| 浏览器 / 手机 | 身份中枢登录 → 会话票 Cookie（`bandi_sid`） | 人 |
| 脚本 / CLI / 运维 | `X-Bandi-Token: <数据目录 token 文件内容>` | 机 |
| 一次性进场 | `?token=<令牌>` → 当场换成会话票并 302 重定向掉 | 壳 / 首次打开 |
| agent 回写 | `X-Bandi-Run-Token: <本轮运行钥匙>` | 数字员工（现发、收尾吊销） |

**认证在身份中枢，授权在本机**。身份只剩两种：`user`（人）与 `run`（一轮活）。
本机钥匙、回环信任、被踢会话票都合成机主身份 —— 它们在权限上就是机主本人，
只是审计里记成 `local-key` / `loopback`，不冒充"我登录了"。

### 2.2 三道闸

| 闸 | 位置 | 作用 |
| :--- | :--- | :--- |
| 来源闸 | `auth.guard` 之前 | Host / IP 周界 |
| 令牌闸 | `auth.guard` | 回环免鉴权、非回环全要；401/403 自己写好响应 |
| CSRF | `/api/*` 写请求 | ①来源守卫（拦跨站写）②`bandi_csrf` Cookie 与 `X-Bandi-CSRF` 头双提交比对（E4099） |

- `GET /api/ping` 与 `GET /api/hello` **免鉴权**：前者给桌面壳健康巡检（`{ok, platform, authRequired}`），
  后者给加入向导探地址（机器名/主机名/端口/版本，不含任何秘密）。
- `/api/local/*` 在令牌闸**之后**再自己校验一次回环 —— 双保险。
- 被令牌闸拒绝的请求**只给 `/api/` 口记审计**；静态资源 401 不记（否则审计被刷成噪音）。

### 2.3 审计

整个 `/api/*` 的写请求（非 GET/HEAD/OPTIONS）在授权后立刻落一条 `pending`，
响应收尾时把**同一行**回填成 `ok` / `fail`，handler 根本不参与、漏不掉。
审计表 `security_events` **只追加**：触发器只允许 `pending → ok|fail`，删除一律拒绝。

---

## 3. 通用约定

| 项 | 约定 |
| :--- | :--- |
| 成功响应 | 直接给业务对象或 `{ ok: true }`；列表接口给数组 |
| 失败响应 | `{ error: '<人话>', code: 'E####' }`，HTTP 状态码同步 |
| 400 | 请求本身有问题，原文就是写给调用方的（`E1044` 兜底） |
| 403 | 来源/CSRF/权限（`E3001` 来源守卫、`E4099` CSRF 双提交不匹配） |
| 404 | 没有这个接口（`E2036`）/ 没有这个文件 |
| 405 | 方法不对（如建卡通道只收 POST，`E2057`） |
| 500 | `E5004`，**不回内部原文**（可能是 SQL / 文件路径 / 栈片段），完整信息进服务端日志 |
| 领域错 | 带 `E12xx` 码（git 域），文案自带 `[码]` 前缀；码表在 `apps/server/src/error-codes.mjs` |
| 时间 | 一律 ISO 8601 字符串 |
| 状态 | 一律传**码**（`todo`/`doing`/`review`…），不传中文 label；码表随 `GET /api/state` 下发 |
| 分页 | 聊天记录按游标/时间窗取，不提供全量导出接口 |

---

## 4. 接口清单

> 下表按域给出**路径 ＋ 支持的方法 ＋ 用途**。`:id` 表示动态段。
> 「鉴权」列只标特殊要求，未标的走统一令牌闸。

### 4.1 平台与启动态

| 方法 | 路径 | 用途 | 鉴权 |
| :--- | :--- | :--- | :--- |
| GET / HEAD | `/api/ping` | 健康探测，返回 `{ok, platform, authRequired}` | 免鉴权 |
| GET | `/api/hello` | 加入向导探测地址与版本 | 免令牌 |
| GET | `/api/web-version` | 前端各模块 mtime+size 指纹，变了页面提示刷新 | |
| GET | `/api/state` | 全站启动态：运行时、我是谁、员工（含忙闲）、会话、群、岗位、权限、状态字典、未读通知数 | |
| GET / PUT | `/api/prefs` | 界面偏好读写 | |
| POST | `/api/control-plane/restart` | 重启控制面（会打断正在跑的活） | |

### 4.2 会话与消息

| 方法 | 路径 | 用途 |
| :--- | :--- | :--- |
| POST | `/api/conversations` | 新建会话（1:1 或工单） |
| GET | `/api/conversations/:id` | 会话详情：`{conversation, messages, runs}` 一次给全（含成员、上下文占用） |
| PUT | `/api/conversations/:id` | 改标题 / 模型 / 沙箱覆盖等 |
| DELETE | `/api/conversations/:id` | 删会话 |
| POST | `/api/conversations/:id/hide` | 从列表移除（可恢复） |

| POST | `/api/conversations/:id/messages` | 发消息，触发一次派活 |
| GET | `/api/conversations/:id/context` | 上下文占用（输入区那颗环） |
| POST | `/api/conversations/:id/files` | 上传附件（原始二进制，一次一个，单个上限 50MB） |
| GET | `/api/files/:convId/:name` | 回显附件；HTML/SVG 加 `CSP sandbox`，防同源 XSS |
| GET | `/api/events` | 全局 SSE 长连接 |

### 4.3 数字员工

| 方法 | 路径 | 用途 |
| :--- | :--- | :--- |
| POST | `/api/personas` | 新建员工（员工列表随 `GET /api/state` 下发，不单开列表接口） |
| GET / PUT / PATCH | `/api/personas/:id` | 详情 / 改资料 |
| DELETE | `/api/personas/:id` | 删除（内置员工拦下） |
| POST | `/api/personas/:id/open` | 在系统里打开其工作目录 |
| GET / POST | `/api/personas/:id/skills` | 查挂载 / 挂技能 |
| DELETE | `/api/personas/:id/skills/:name` | 摘技能 |
| GET | `/api/personas/:id/runtime-skills` | 运行时侧技能清单（对照用） |
| GET | `/api/personas/:id/tasks` | 该员工名下的活 |
| GET / POST | `/api/personas/:id/notes` | 经验簿（口径 / 坑）读写 |
| DELETE | `/api/personas/:id/notes/:nid` | 删一条经验 |
| GET / POST | `/api/personas/:id/facts` | 事实层（验证命令 / 重启方式 / 常改文件） |
| DELETE | `/api/personas/:id/facts/:fid` | 删一条事实 |
| GET / PUT | `/api/personas/:id/feishu` | 飞书绑定读写 |
| POST | `/api/personas/:id/feishu/test\|start\|stop` | 飞书连通性测试 / 起停长连接 |

> 技能正文是文件（`skills/`），接口只处理**挂载关系**与正文的读写；内置技能正文不下发给前端。

### 4.4 群

| 方法 | 路径 | 用途 |
| :--- | :--- | :--- |
| POST | `/api/groups` | 建群 |
| GET / PATCH / PUT | `/api/groups/:id` | 群详情 / 改名换助手挂项目 |
| DELETE | `/api/groups/:id` | 解散群 |
| POST | `/api/groups/:id/sessions` | 在这个群里开一段新会话 |
| POST | `/api/groups/:id/members` | 加成员 |
| DELETE | `/api/groups/:id/members/:pid` | 移成员 |

### 4.5 技能与专家

| 方法 | 路径 | 用途 |
| :--- | :--- | :--- |
| GET | `/api/skills` | 技能清单（内置＋自建） |
| POST | `/api/skills` | 新建技能 |
| POST | `/api/skills/discover` | 扫描可导入的目录 |
| POST | `/api/skills/import` | 导入技能包 |
| GET / PUT / PATCH | `/api/skills/:name` | 技能详情 / 改正文 |
| DELETE | `/api/skills/:name` | 删技能 |
| POST | `/api/skills/:name/personas` | 批量设置挂载 |
| GET | `/api/experts` | 专家库清单 |
| POST | `/api/experts/:key/hire` | 聘用专家（生成员工） |
| POST | `/api/experts/:key/fire` | 解聘 |

### 4.6 项目与看板

| 方法 | 路径 | 用途 |
| :--- | :--- | :--- |
| GET | `/api/projects` | 项目列表 |
| POST | `/api/projects` | 新建项目 |
| PUT / DELETE | `/api/projects/:id` | 改 / 删项目 |
| GET | `/api/tasks` | 全量看板卡（跨项目） |
| GET / POST | `/api/projects/:id/tasks` | 项目下的卡 / 建卡 |
| GET | `/api/projects/tasks/:id` | 卡详情 |
| DELETE | `/api/projects/tasks/:id` | 删卡 |
| POST | `/api/projects/tasks/:id/comments` | 加评论 |
| POST | `/api/projects/tasks/:id/files` | 上传卡附件 |
| POST | `/api/projects/:id/repo-cards` | 按仓库生成卡（巡检用） |
| GET | `/api/roles` | 内置岗位与权限清单 |

### 4.7 流程引擎

| 方法 | 路径 | 用途 |
| :--- | :--- | :--- |
| GET | `/api/workflows` | 流程总览 |
| GET / POST | `/api/workflows/templates` | 模板列表 / 新建 |
| GET / PUT / DELETE | `/api/workflows/templates/:id` | 模板详情 / 保存 / 删除 |
| POST | `/api/workflows/templates/:id/publish` | 发布（发布后工作台才能起流程） |
| POST | `/api/workflows/templates/:id/archive` | 归档 |
| GET | `/api/workflows/templates/:id/runs` | 由该模板发起过的实例 |
| POST | `/api/workflows/runs` | 发起一条实例 |
| GET / DELETE | `/api/workflows/runs/:id` | 实例详情 / 删 |
| POST | `/api/workflows/runs/:id/start\|decide\|retry\|assign\|status\|abort` | 推进动作（开始 / 拍板 / 重跑 / 改派人 / 改状态 / 中止） |
| POST | `/api/workflows/runs/:id/tasks/:nodeId/card` | 为该节点任务建/关联看板卡 |

> 流程实例（`workflow_runs`）与一次 agent 执行（`runs`）是两层东西：节点任务上的 `agentRunId` 指向后者。

### 4.8 运行（run）

| 方法 | 路径 | 用途 |
| :--- | :--- | :--- |
| GET | `/api/runs/:id/stream` | 单轮运行的 SSE 流（`Last-Event-ID` 断点补发） |
| POST | `/api/runs/:id/abort` | 停止这一轮 |
| GET | `/api/runs/:id/summary` | 收尾摘要 |
| GET | `/api/runs/:id/evidence` | 交付证据（判据核对用） |

### 4.9 代码托管（git）

| 方法 | 路径 | 用途 |
| :--- | :--- | :--- |
| GET | `/api/git/status` | 连接状态、仓库清单、PR 汇总 |
| GET | `/api/git/whoami` | 当前令牌对应账号 |
| POST / DELETE | `/api/git/token` | 存 / 删 GitHub PAT |
| GET | `/api/git/available` | 账号下可接入的仓库 |
| GET / POST | `/api/git/repos` | 已接入仓库 / 接入一个仓库 |
| GET | `/api/git/repos-dir` | 选本地克隆目录 |
| DELETE | `/api/git/repos/:id` | 取消托管 |
| POST | `/api/git/repos/:id/settings` | 值班管理员 / 自动合并 / 合并闸开关 |
| POST | `/api/git/repos/:id/relocate` | 本地目录改名后重新指位置（身份不变） |
| POST | `/api/git/repos/:id/patrol` | 配置巡检节拍 |
| POST | `/api/git/repos/:id/patrol/run` | 立即巡检一次 |
| GET | `/api/git/repos/:id/changes` | 工作区改动（分支、dirty、ahead） |
| GET | `/api/git/repos/:id/branches` | 分支清单（本地/远程/标签 + 上游 + ↑↓） |
| POST | `/api/git/repos/:id/checkout` | 切分支 |
| POST | `/api/git/repos/:id/branch` | 新建分支 |
| POST | `/api/git/repos/:id/branch-delete` | 删分支 |
| POST | `/api/git/repos/:id/commit` | 提交 |
| POST | `/api/git/repos/:id/suggest-commit` | 生成提交说明（一次性短跑，不建 run） |
| POST | `/api/git/repos/:id/suggest-pr` | 生成 PR 说明 |
| POST | `/api/git/repos/:id/push` | 推送（保护规则挡下时返回 `E12xx`） |
| POST | `/api/git/repos/:id/fetch` | 取远端 |
| POST | `/api/git/repos/:id/sync` | 更新项目（pull） |
| POST | `/api/git/repos/:id/back` | 回 base / 回 main（在网页上合完 PR 的兜底：切回默认分支 → pull --ff-only → 删本地分支） |
| GET | `/api/git/repos/:id/log` | 提交图（分页 + 泳道） |
| GET | `/api/git/repos/:id/diff` | 单文件/工作区 diff |
| POST | `/api/git/repos/:id/discard` | 丢弃改动 |
| GET | `/api/git/repos/:id/branch-diff` | 分支对比 |
| GET | `/api/git/repos/:id/branch-diff/file` | 分支对比里的单文件 diff |
| GET | `/api/git/repos/:id/prs` | 该仓库的 PR 列表 |
| POST | `/api/git/repos/:id/prs/:num/merge` | 合并 PR（过闸才允许） |
| GET | `/api/git/repos/:id/prs/:num/checks` | PR 上的检查结论（CI 绿没绿） |
| POST | `/api/git/repos/:id/prs/:num/checks/rerun` | 重跑检查 |
| POST | `/api/git/repos/:id/prs/:num/fix` | 派活修 PR 上的问题 |
| POST | `/api/git/prs/refresh` | 全量刷新 PR |
| GET / POST / DELETE | `/api/projects/tasks/:id/pr` | 看板卡关联的 PR（查 / 建 / 合） |

### 4.10 运行时与设备

| 方法 | 路径 | 用途 |
| :--- | :--- | :--- |
| GET | `/api/runtimes` | 运行时实例清单 |
| GET | `/api/runtime-families` | 协议族与能力矩阵 |
| POST | `/api/runtimes/test` | 试跑一个运行时 |
| GET | `/api/runtimes/detect` | 识别本机可用的 CLI |
| GET | `/api/runtimes/:id/models` | 该运行时的模型清单 |
| GET | `/api/devices` | 设备清单（现在只有 `local`） |
| GET | `/api/devices/:id` | 设备详情 |
| POST | `/api/devices/:id/rename` | 改名 |
| POST | `/api/devices/:id/runtimes` | 在设备上加运行时 |
| GET / POST | `/api/lan` | 局域网可达性信息 |

### 4.11 定时任务

| 方法 | 路径 | 用途 |
| :--- | :--- | :--- |
| GET / POST | `/api/schedules` | 定时任务列表 / 新建 |
| DELETE | `/api/schedules/:id` | 删除 |
| POST | `/api/schedules/:id/run` | 立即跑一次 |

### 4.12 连接器、插件、SSH

| 方法 | 路径 | 用途 |
| :--- | :--- | :--- |
| GET | `/api/connectors` | 连接器清单 |
| GET | `/api/connectors/catalog` | 可安装目录 |
| POST | `/api/connectors` | 新建连接器 |
| PUT / PATCH | `/api/connectors/:id` | 改配置 |
| POST | `/api/connectors/:id/probe` | 连通性探测 |
| DELETE | `/api/connectors/:id` | 删除 |
| GET | `/api/plugins` | 插件清单 |
| POST | `/api/plugins/:id/install\|enable\|disable` | 插件动作 |
| DELETE | `/api/plugins/:id` | 卸载 |
| GET / POST | `/api/ssh/servers` | SSH 服务器列表 / 新增 |
| DELETE | `/api/ssh/servers/:id` | 删除 |
| GET / POST | `/api/ssh/servers/:id/key` | 读 / 设置密钥 |
| POST | `/api/ssh/servers/:id/test` | 连通性测试 |
| POST | `/api/ssh/servers/:id/hostkey` | 接受主机指纹 |

### 4.13 账号与安全

| 方法 | 路径 | 用途 |
| :--- | :--- | :--- |
| POST | `/api/logout` | 退出（吊销会话票） |
| GET | `/api/me` | 我是谁 |
| POST | `/api/me/password` | 改密码（转中枢） |
| GET | `/api/users` | 全量名册（**只给机主**） |
| POST | `/api/users` | 新增用户 |
| DELETE | `/api/users/:id` | 删用户 |
| GET | `/api/security/sessions` | 活跃会话 |
| POST | `/api/security/sessions/revoke-others` | 踢掉其它会话（唯一需要有效会话票的接口） |
| GET | `/api/security/audit` | 审计日志 |
| GET | `/api/security/audit/export` | 导出审计 |
| POST | `/api/security/audit/clear` | 归档清理 |

### 4.14 通知（信箱）

| 方法 | 路径 | 用途 |
| :--- | :--- | :--- |
| GET | `/api/notices` | 信箱列表 |
| GET | `/api/notices/unread` | 未读数（左栏徽标） |
| POST | `/api/notices/read` | 标记已读 |
| POST | `/api/notices/delete` | 删除 |

### 4.15 本机与工作区

| 方法 | 路径 | 用途 | 鉴权 |
| :--- | :--- | :--- | :--- |
| GET | `/api/local/status` | 本机形态与数据目录 | 本机专属 |
| GET | `/api/local/externals` | 外部依赖检测 | 本机专属 |
| GET | `/api/local/backups` | 备份清单 | 本机专属 |
| POST | `/api/local/export` | 导出数据快照 | 本机专属 |
| POST | `/api/local/import` | 导入数据快照（下次启动换库） | 本机专属 |

| POST / GET | `/api/install/tasks` | 本机软件安装任务 | |
| GET | `/api/install/tasks/:id` | 安装任务详情 | |
| GET | `/api/fs/dirs` | 目录列举（选工作目录） | |
| GET | `/api/workspace/file` | 读工作区文件（预览用） | |
| POST | `/api/open` | 用系统默认程序打开路径 | |

### 4.16 身份中枢入口

| 方法 | 路径 | 用途 |
| :--- | :--- | :--- |
| GET | `/hub/enter?ticket=…` | 验票换会话票并重定向（不是文件路由，排在静态之前） |
| GET | `/hub/login` | 登录页 |
| GET | `/hub/expired` | 会话过期兜底页（给壳用） |

---

## 5. 领域通道（run token）

数字员工在跑的过程中回调平台，走的是**同一把运行钥匙** `X-Bandi-Run-Token`（现发、收尾吊销），
不共用人的会话票。四个入口全部只收 `POST`：

| 路径 | 用途 | 备注 |
| :--- | :--- | :--- |
| `/api/agent/cards` | 建卡通道（一次一张） | 方法不对返回 405 `E2057` |
| `/api/agent/cards/batch` | 批量建卡 | |
| `/api/agent/deliver` | 交付与闸门动作（一口气做完一串） | |
| `/api/agent/gate` | 闸门判定 | |
| `/api/agent/files` | 把本地产物登记成会话附件 | 只收 POST（`E1005`） |

这些通道**自成一套身份**，所以排在链的很前面 —— 不能跟在别的鉴权后面。

---

## 6. 错误码

| 范围 | 归属 | 说明 |
| :--- | :--- | :--- |
| `E12xx` | git 域 | 码表唯一一份在 `apps/server/src/error-codes.mjs` 的 `GIT_CODES`，含"意思 + 出路"；文档不另抄表 |
| `E10xx` | 通用/请求 | 如 `E1044` 请求参数不合法 |
| `E20xx` | 业务/路由 | 如 `E2036` 没有这个接口、`E2057` 方法不对 |
| `E30xx` | 安全 | 如 `E3001` 来源守卫拒绝 |
| `E40xx` | 会话/CSRF | 如 `E4099` CSRF 双提交不匹配 |
| `E50xx` | 服务端 | `E5004` 未捕获异常（不外泄原文） |

> 错误码是**唯一一份**，改码只改 `error-codes.mjs`，不许在文档里手抄一张表 ——
> 手抄的表没人校验，两处迟早对不上。`tools/check-doc-drift.mjs` 会核对文档里出现的 `E12xx` 必须在码表里。