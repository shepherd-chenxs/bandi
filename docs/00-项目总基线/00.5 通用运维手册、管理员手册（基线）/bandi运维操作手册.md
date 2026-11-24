# bandi 运维操作手册（基线）

> 这份是**日常运维**该怎么做：起停、看状态、备份恢复、排障、升级、巡检。
> 在 Linux 服务器上从零装一台完整实例，看 [部署手册](../../../deploy/README.md)；
> 只想先把本机跑起来，看 [快速开始](../快速开始.md)；安全默认见 [SECURITY](../../../SECURITY.md)。
> 库表与接口口径分别见 [数据库基线设计](../00.3%20数据库基线设计文档/bandi数据库基线设计.md) 与 [接口基线文档](../00.4%20全局接口文档（主库）/bandi接口基线文档.md)。

## 变更历史

| 版本 | 修改日期 | 修改人 | 修改内容 | 对应产品迭代版本 |
| :--- | :--- | :--- | :--- | :--- |
| V1.0 | 2026-11-24 | 施工代理 | 初版基线：起停、数据目录、备份恢复、排障、升级、巡检 | V1.7.x |

---

## 1. 形态与适用范围

| 形态 | 进程由谁管 | 数据目录 | 起停方式 |
| :--- | :--- | :--- | :--- |
| 桌面版（Windows） | Tauri 薄壳拉起并收掉自己起的那一个 | `%APPDATA%\bandi` | 开/关窗口；或 `bandi stop/start` |
| 源码 / 本机调试 | 你自己（`node start.mjs`） | 默认用户目录，可 `BANDI_DATA` 指走 | `start.cmd` / `bandi start` |
| Linux 服务器 | systemd（有 root）或 `start-control-plane.sh`（无 root） | `/var/lib/bandi` 或 `~/bandi-data` | `systemctl` / 脚本 / `bandi` |

**单机是唯一形态**：一台机器一个完整实例，有自己的库、项目和员工。跨机器协作走 git 仓库 ＋ PR，
不靠共享库。多机节点子系统已于 2026-11-09 整体删除，别再找"加入总机"的操作。

---

## 2. 日常起停

### 2.1 命令行

装过桌面版或用过 `bandi install-cli` 之后，全局有 `bandi`；源码检出的仓库根目录有 `bandi.cmd`（Windows）。

| 命令 | 作用 | 注意 |
| :--- | :--- | :--- |
| `bandi` | 状态一屏；交互终端还给编号菜单 | 不进菜单就只看 |
| `bandi status [--json]` | 只出状态 | 退出码 **3 = 没在跑**，脚本用它一眼判 |
| `bandi start` | 起来（没在跑才真的起） | 已经在跑不会重启 |
| `bandi restart [-y]` | 强制重启 | **会打断正在跑的活**；非交互环境必须 `-y`，否则退出码 2 |
| `bandi stop` | 停掉班底自己的服务 | 不碰别人的进程 |
| `bandi url [--open]` | 访问地址 | `--open` 顺手开浏览器 |
| `bandi logs [-n 40] [-f]` | 日志 | `-f` 跟着走，Ctrl+C 退出 |
| `bandi mode` | 这台机器的形态 | 只读；监听地址去页面改 |
| `bandi reset-host [-y]` | 忽略 `BANDI_HOST`、清掉界面里存的监听地址，回缺省 `0.0.0.0` | 救"钉错网卡、页面连不上"的现场 |
| `bandi data export [--dir 目录]` | 导出数据快照 | 服务器形态下这是唯一导出入口 |
| `bandi hub [status\|leave]` | 中枢登录状态 / 退出中枢 | `leave` 不动本地数据 |
| `bandi user list` / `bandi user create <名字>` | 账号列表 / 建影子账号 | 影子账号预占名字，中枢账号首次登录自动绑定 |
| `bandi skill ls\|show\|add\|link\|unlink` | 技能库操作 | |
| `bandi note ls\|add\|rm\|forget <员工>` | 经验簿操作 | `add --pit` 记成坑 |
| `bandi install-cli [--path]` | 把 `bandi` 注册成全局命令 | `--dry-run` 先看要做什么 |

通用开关：`--plain` 或 `NO_COLOR=1` 去颜色；`--json` 给脚本读。

### 2.2 停止的边界

`stop` 只停**班底自己起的那个进程**：靠端口上进程的命令行认自己人。端口被别人的程序占着时，
一个都不动 —— 这是刻意的，别改成"谁占就杀谁"。

`restart` 会打断正在跑的 agent 任务，被打断的运行会被标记为失败。挑没有活在跑的时候做。

---

## 3. 进程、端口与监听地址

| 项 | 默认 | 覆盖方式 |
| :--- | :--- | :--- |
| 端口 | **18787** | `BANDI_PORT=<n>`（唯一真源是 `apps/server/src/config.mjs`，别在别处写死） |
| 监听地址 | `0.0.0.0`（对外，强制鉴权） | `BANDI_HOST`（临时）／界面「设置 → 安全 → 监听地址」（主路，写进数据目录 `config.json` 的 `listenHost`，重启生效，升级重装不会被改回去） |
| 数据目录 | `%APPDATA%\bandi`（Windows）／`~/bandi-data`（服务器无 root）／`/var/lib/bandi`（有 root） | `BANDI_DATA` |

监听地址的优先级：`BANDI_HOST` 环境变量 ＞ `config.json` 的 `listenHost` ＞ 缺省 `0.0.0.0`。

### 3.1 起来时看到的三类结果

起停逻辑只有一份，在 `apps/server/src/lifecycle.mjs`（命令行 `start.mjs` 与桌面壳共用）：

| 输出 | 含义 | 该怎么办 |
| :--- | :--- | :--- |
| `已经在运行（PID …）` | 端口上是自己人且健康 | 不重启，直接用 |
| `端口被班底自己的服务占着（PID …），强制重启/判定僵死` | 自己在跑但不响应，或你用了 `--restart` | 等它起来；僵死说明上一次没收干净 |
| `✗ 端口 18787 被别的程序占着，我不动它` | 端口被别人占了 | 先自己处理那个进程，或 `BANDI_PORT` 换端口 |
| `✗ <原因>` ＋ 日志尾部 | 自己起不来 | 看第 7 节排障 |

端口排查（Windows）：`netstat -ano | findstr :18787`，再 `tasklist /FI "PID eq <pid>"`；
Linux：`ss -lntp | grep 18787`。

### 3.2 实例锁

`<数据目录>/server.lock` 记着"谁在用这个库"。启动时看它决定**要不要做启动清账**：

- 锁里的 pid 活着且不是自己 → 共库多实例，**跳过**清账与僵尸卡恢复（别动别人正在跑的活）；
- 锁不存在 / 坏了 / pid 已死 → 独占，接过来自己用；
- 锁写不进去（只读目录）→ 按独占处理，只打一行警告。

旧版本进程不写这把锁，所以"新旧混跑"判不出来。排障时要强制接管，用 `BANDI_FORCE_REAP=1`
（回归测试里**不要**设）。

---

## 4. 数据目录

```
<数据目录>/
├─ bandi.db            主库（含 -wal / -shm）
├─ backups/            备份，以及导入前的原库三件套
├─ uploads/<会话id>/   聊天附件
├─ token               访问令牌（0600，当私钥看）
├─ config.json         界面级配置（listenHost 等）
├─ runtimes.json       运行时实例注册表（BANDI_RUNTIMES 可改位置）
├─ plugins.json        插件注册表（BANDI_PLUGINS 可改位置）
├─ server.lock         实例锁
└─ server.log          服务端日志
```

**日志跟着数据目录走**（`BANDI_DATA` 指到哪，日志跟到哪）。启动时的前几行就是自检信息：

```
班底平台：http://0.0.0.0:18787
数据目录：/var/lib/bandi
数据库：/var/lib/bandi/bandi.db
```

### 4.1 迁移数据目录

停服务 → 把整个数据目录搬到新位置 → 用 `BANDI_DATA=<新位置> bandi start`。
**三件套（`.db`/`-wal`/`-shm`）要一起搬**；只拷 `.db` 会丢还在 WAL 里的事务。

不想动环境变量的，也可以走界面或 `bandi data export` 导出快照，到新位置再导入（见 5.3）。

---

## 5. 备份与恢复

### 5.1 自动备份

定时任务里有一条「备份数据库」，动作实现在 `apps/server/src/db-backup.mjs`：

| 项 | 值 |
| :--- | :--- |
| 落点 | `<数据目录>/backups/bandi-YYYYMMDD-HHMMSSmmm.db` |
| 做法 | `VACUUM INTO` —— 库开着 WAL，直接拷 `.db` 会漏掉还在 `-wal` 里的事务 |
| 保留 | 默认 **14** 份，`keep` 可配（夹在 1~90）；名字排序＝时间排序，按名字淘汰最旧的 |
| 名字带毫秒 | 一秒内连跑两次也不会撞名（撞名 `VACUUM INTO` 直接报错） |

也可以直接调 `GET /api/local/backups` 看清单，`POST /api/local/export` 导出一份完整的导出快照。

### 5.2 手工备份

1. 能停就停：`bandi stop`；
2. 停不了就别拷文件，改用 `bandi data export --dir <目录>`（走的是同一套一致性快照）；
3. 备份产物至少留两份，一份放**另一块盘**。`backups/` 和数据在同一个目录，盘坏了一起没了。

### 5.3 恢复

| 场景 | 做法 |
| :--- | :--- |
| 回到某个自动备份 | `bandi stop` → 把 `backups/bandi-*.db` 拷成 `<数据目录>/bandi.db`（先删掉 `-wal`/`-shm`）→ `bandi start` |
| 导入一份导出快照 | 放成 `<数据目录>/bandi.db.importing` → 启动服务，换库在**模块加载时**做（连接还没开，零并发风险）：现库三件套整体改名进 `backups/导入前-<时间戳>.db`，再把快照扶正 |
| 导入文件不合法 | 启动时校验前 16 字节不是 `SQLite format 3` 就丢弃并留一行日志，本机数据原样 |
| 换库被占用 | 别的进程还开着库时 rename 会失败（Windows 上必如此）—— 不崩，下次启动再试 |

恢复之前**先停服务**。库文件被两个进程写是会坏的，不是"可能"。

---

## 6. 鉴权与安全运维

| 项 | 说明 |
| :--- | :--- |
| 浏览器/手机 | 身份中枢登录 → 会话票 Cookie（`bandi_sid`） |
| 脚本 / CLI | `X-Bandi-Token: <数据目录 token 文件内容>` |
| 一次性进场 | `?token=<令牌>`，当场换成会话票并 302 掉 |
| 员工回写 | `X-Bandi-Run-Token`，现发、收尾吊销 |

- **令牌当私钥看**。怀疑泄露就换：删掉 `<数据目录>/token` 再重启（会重新生成），所有脚本要同步更新。
- **审计只追加**：`GET /api/security/audit` 可查，`POST /api/security/audit/clear` 只做归档清理。
  改写/删除 `security_events` 会被数据库触发器直接拒绝。
- **踢会话**：`POST /api/security/sessions/revoke-others` —— 唯一需要有效会话票的接口。
- 默认对外监听 ＋ 强制鉴权。**不要把控制面裸开到公网**：远程访问走 SSH 隧道或 TLS 反代，
  反代后面配 `BANDI_TRUST_PROXY=1` 并显式给 `BANDI_ORIGINS`（逗号分隔的来源白名单）。
- 写请求还要过 CSRF：浏览器带 Cookie 的写请求必须让 `bandi_csrf` Cookie 与 `X-Bandi-CSRF` 头一致。
  页面打不开或按钮"点了没反应"时，先看是不是这一条（见 7.3）。

---

## 7. 排障

### 7.1 通用顺序

1. `bandi status` —— 在不在跑、PID、端口、数据目录；
2. `bandi logs -n 80` —— 先看最后 80 行，尤其是启动那几行"数据目录 / 数据库"；
3. 端口：`netstat -ano | findstr :18787`（Windows）/ `ss -lntp | grep 18787`（Linux）；
4. 库：`sqlite3 <数据目录>/bandi.db "PRAGMA user_version;"` —— 对不上就是版本问题（7.2）；
5. 还不行再动数据：**先备份再动手**。

### 7.2 常见故障

| 现象 | 多半是 | 处理 |
| :--- | :--- | :--- |
| 启动就退出，日志里 `这个数据目录里的库比当前程序新` | 老程序打开了新库（`user_version` 高于 `SCHEMA_VERSION`） | 升级到新版班底再开；或 `BANDI_DATA=<空目录>` 先跑干净的，原数据别碰 |
| `better_sqlite3.node was compiled against a different Node.js version` | 换过 Node 版本（原生模块按 `NODE_MODULE_VERSION` 编译） | 在仓库根跑 `npm rebuild better-sqlite3`，或在当前 Node 下重装依赖 |
| `database is locked` | 两个进程同时写同一库 | 确认没有第二个实例；`busy_timeout` 已是 5 秒，超过说明有长事务或外部工具占着库 |
| 端口被别的程序占着 | 上次的僵死进程 / 别的服务 | `bandi restart -y` 收拾自己的；别人的程序自己处理或换端口 |
| 页面打得开但点了没反应 | 前端模块图加载失败，或 CSRF 没过 | 浏览器控制台看有没有模块报错；`GET /api/web-version` 比一下前端指纹，变了刷新页面；CSRF 见 6 节 |
| 壳/浏览器连不上、`reset-host` 提示会打断任务 | `BANDI_HOST` 或 `config.json` 里钉错了网卡 | `bandi reset-host -y`，回缺省 `0.0.0.0`，再去界面重设 |
| 重启后有条运行"被中断" | 启动清账把上次没收尾的 `running` 判死了 | 正常行为；重启前尽量 `bandi stop` 让活自己收尾 |
| 共库多实例时清账被跳过 | 实例锁判定有别人在用 | 正常保护；确认另一个实例真的死了才用 `BANDI_FORCE_REAP=1` |
| 磁盘涨得快 | 附件 (`uploads/`) 或库 WAL 膨胀 | 清 `uploads/` 里过期的会话目录；库膨胀先备份再做一次 `VACUUM` |

### 7.3 判断"到底是不是前端问题"

`GET /api/web-version` 给的是前端各模块 `mtime + size` 的指纹。页面每 60 秒对一次，变了会亮「刷新」提示条。
接口能通、指纹变了 → 刷新；接口 401/403 → 是凭据问题，不是前端。

---

## 8. 升级与回滚

### 8.1 升级顺序（任何形态都一样）

1. `bandi stop`（别在活跑着的时候升级）；
2. **先备份**：`bandi data export --dir <备份目录>`；
3. 换代码/换安装包；
4. `bandi start`，看启动日志里结构版本那一行：`[数据库] 结构版本 N → M` 表示迁移跑过了；
5. 抽查：`bandi status`、页面能开、信箱没有新的失败。

### 8.2 回滚

- **代码回滚**：换回旧版即可，但**只有库结构没被升级过**才安全 —— 新库比旧程序新时旧程序会拒绝启动
  （这是护栏，不是 bug）。
- **数据回滚**：见 5.3，用升级前那份备份。
- 因此升级前的备份不是可选项。结构版本是单向的，没有自动降级迁移。

### 8.3 开机自启

| 形态 | 做法 |
| :--- | :--- |
| Linux 有 root | `sudo systemctl enable --now bandi`，单元文件见 `deploy/bandi.service` |
| Linux 无 root | crontab 里加 `@reboot <仓库>/deploy/start-control-plane.sh start` |
| Windows 桌面版 | 由安装包/桌面壳管；相关逻辑在 `apps/server/src/autostart.mjs` |

---

## 9. 巡检清单

### 9.1 每天

- [ ] `bandi status` 正常，端口对得上
- [ ] 信箱（`GET /api/notices/unread`）没有新增未读失败
- [ ] `bandi logs -n 100` 没有反复出现的报错
- [ ] 备份目录有今天的新文件

### 9.2 每周

- [ ] 备份产物拷一份到另一块盘（同盘备份不算备份）
- [ ] 审计里看一遍被拒的请求（`GET /api/security/audit`），异常 IP/来源要处理
- [ ] 磁盘占用：`uploads/`、库文件、日志各多大
- [ ] 运行时能正常识别（`GET /api/runtimes/detect`），CLI 凭据没过期

### 9.3 发版前后

- [ ] 升级前备份（8.1 第 2 步）
- [ ] 升级后结构版本行确认
- [ ] 一个完整闭环跑一遍：建会话 → 派活 → 看事件流 → 收尾
- [ ] git 链路抽查：接入仓库 → 提交 → 推送 → 建 PR

---

## 10. 环境变量速查

| 变量 | 作用 | 缺省 |
| :--- | :--- | :--- |
| `BANDI_PORT` | 服务端口 | `18787` |
| `BANDI_HOST` | 监听地址（临时覆盖） | 取 `config.json` 的 `listenHost`，再缺省 `0.0.0.0` |
| `BANDI_DATA` | 数据目录 | 本机用户目录 |
| `BANDI_DB` | 库文件路径 | `<数据目录>/bandi.db` |
| `BANDI_RUNTIMES` / `BANDI_PLUGINS` | 运行时/插件注册表位置 | 数据目录下的 `*.json` |
| `BANDI_RUN_CWD` | 派活时的工作根 | 仓库根 |
| `BANDI_ORIGINS` | 来源白名单（逗号分隔） | 空 |
| `BANDI_TRUST_PROXY` | 信任反代头 | 关 |
| `BANDI_LOCAL_SECRET` | `off` 关掉本机专属密钥（**逃生口**，反代已 deny 破坏性本机路径时才用） | 开 |
| `BANDI_SKIP_REAP` | 跳过启动清账 | 不跳 |
| `BANDI_FORCE_REAP` | 强制接管实例锁做清账（排障用） | 不接管 |
| `BANDI_NO_BROWSER` | `1`＝启动时不开浏览器 | 开 |