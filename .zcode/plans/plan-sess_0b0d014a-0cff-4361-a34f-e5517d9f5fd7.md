# 运行时识别：不再依赖进程 PATH 快照

## Context（为什么改）

bandi 的「识别本机运行时」目前所有探测（`runtimes.mjs` 的 `findOnPath`/`npmPrefixes`/`appRoots`，`externals.mjs` 的 `onPath`）都只读 `process.env.PATH` —— **bandi 进程启动那一刻继承的环境快照**。导致：

- bandi 先启动、CLI 后安装（或装在启动后才加入 PATH 的目录）→ 识别不到，直到重启 bandi；
- GUI 进程 PATH 不全（如 fnm 用户、Git Bash 装的 CLI）→ 永远识别不到。

用户要求：**只要装了，不管有没有启动、bandi 何时启动，都要识别出来**。

修复思路：探测时**实时**合并三个来源——①进程 PATH（现状，排最前）②注册表里最新的系统+用户 PATH ③各安装器的固定落点（fnm/npm/pnpm/scoop 等）。纯 stat、保持现有「不起 shell、不做定时扫描」的设计。

## 改动清单

### 1. 新增 `apps/server/src/path-env.mjs`（只依赖 node 内置模块）
- `readUserPath()` —— 从 `cli-install.mjs:91-103` **搬过来**（HKCU\Environment\Path，保留 REG_SZ/REG_EXPAND_SZ 类型读取）；`cli-install.mjs` 改为从这里 import（消重，且 path-env 零仓库依赖，不破坏 cli-install「库坏了也能装」的铁律）
- `readMachinePath()` —— `reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path`，同样的解析；reg.exe 优先用 `%SystemRoot%\System32\reg.exe` 绝对路径，防 PATH 不含 System32
- `expandRegValue()` —— `%VAR%` 按 process.env 大小写不敏感展开（REG_EXPAND_SZ 需要）
- `pathDirs()` —— 进程 PATH ∪ 注册表系统 PATH ∪ 注册表用户 PATH（win32）；darwin 再读 `/etc/paths` + `/etc/paths.d/*`（GUI 启动的进程看不到 login shell PATH）；去尾分隔符、win32 大小写不敏感去重、保序；**5 秒 TTL 记忆化**（reg query 是 spawn，别让页面加载每次都跑两遍）；任何失败静默回退进程 PATH
- `wellKnownBins()` —— 不依赖 PATH 的固定落点清单：`%APPDATA%\npm`、`%APPDATA%\fnm\aliases\default`（fnm 稳定别名 junction）、`%LOCALAPPDATA%\Volta\bin`、`%LOCALAPPDATA%\pnpm`、`%APPDATA%\Yarn\bin`、`~\.bun\bin`、`~\scoop\shims`、`~\.cargo\bin`、`~\.local\bin`（claude 原生安装器落点）；POSIX 对应 `~/.local/bin`、`/opt/homebrew/bin`、`~/.cargo/bin` 等。返回纯列表不做 stat 过滤（调用方本来就要 stat）

### 2. `apps/server/src/runtimes.mjs`（三处换数据源 + 一处标签修正）
- `findOnPath`（665 行）：`dirs` 改为 `pathDirs()`
- `npmPrefixes`（682 行）：扫描范围改为 `[...pathDirs(), ...wellKnownBins()]`（形态一「目录自带 node_modules」会自动命中 fnm 别名目录、`%APPDATA%\npm` 等新来源）；「加进去的必须是直接装着 node_modules 的目录」契约不变
- `appRoots`（746 行）：盘符推导那行改用 `pathDirs()`（dsh 桌面端装在注册表 PATH 才有的盘上也能推出来）
- `DETECT.claude`（792 行）：`{ path: shim, source: '…班底起不来' }` 的标签按扩展名区分 —— `.cmd/.bat/.ps1` 才叫「班底起不来」，`.exe`（原生安装，如 `~\.local\bin\claude.exe`）标「原生二进制」

### 3. `apps/server/src/externals.mjs`
- `onPath`（114 行）：PATH 来源换成 `pathDirs()`（magpie 也吃注册表新鲜 PATH；HOMES 固定落点已有，不动）

### 4. 新增 `apps/server/src/smoke-runtime-detect.mjs` + 注册进 `tools/run-smokes.mjs`
RUN 数组是显式清单，不注册会让 runner 直接报错。测试内容（照 `smoke-runtime-heal.mjs` 的结构：临时 BANDI_DATA 起真 server、`check()` 计数、探不到就跳过）：
- win32：`pathDirs()` 包含 HKLM PATH 的每个目录；重复目录去重；`readUserPath` 能读到且类型正确
- e2e：`GET /api/runtimes/detect` → 断言 claude/codex 出现有 usable 候选（本机已装 2.1.317 / 0.166.0；没装的机器按惯例跳过版本断言）

### 5. `docs/现状.md`
按仓库文档漂移门禁惯例补一条带日期的记录（识别机制改为「实时注册表 + 固定落点」，不再依赖进程快照）。

## 明确不做
- **不加定时扫描** —— `routes/runtime.mjs:65` 注释是既有设计决定；页面加载 `publicFamilies()` 本来就会 stat-only 刷新已装/未装状态，扩源后自然变准
- **codex 原生二进制（非 npm 装）** —— codex adapter 只能 `node <js>` 启动（`launchable()` 只认 .js），是既有约束，本次不动
- 桌面端 `apps/desktop/runtime/` 是 stage-runtime.mjs 打包时生成的，无需手动同步

## 验证
1. `node apps/server/src/smoke-runtime-detect.mjs` 全绿
2. `node tools/run-smokes.mjs`（至少 `--only=runtimes`、`--only=codex`、`--only=node-task` 相关套件不回归）
3. 手动端到端：起 server → `GET /api/runtimes/detect` → claude/codex 带版本号出现
4. **新鲜度实证**：`reg add` 往 HKCU\Environment\Path 塞一个假目录、里面放个假 `claude.cmd` → **不重启 server** 点识别 → 能发现 → 清理注册表和假文件

## 需要的权限
跑 smoke 测试（node）、临时起 server、测试期间 `reg add`/`reg delete` HKCU\Environment\Path（用户级 PATH，做完即恢复）