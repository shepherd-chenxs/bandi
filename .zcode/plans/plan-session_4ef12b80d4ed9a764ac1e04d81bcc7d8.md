### 目标

代码托管页向专业 IDE 的 git 集成看齐（这轮三件套）：**分支切换器**（搜索 + 本地/远程分组 + 当前分支✓ + 拉取更新）、**改动管理**（每文件 diff 查看 + 单文件丢弃 + 提交 + 推送）、**最近提交历史**。不做冲突合并编辑器和图形化拓扑图。

### 服务端 apps/server

**`src/git-repos.mjs` 新增**（全本地 git，复用 `gitIn`/`workState`/`assertBranchName`/`findSecretPaths`/`commitIdentityArgs`）：
- `listBranches(row)`：`for-each-ref refs/heads` + `refs/remotes`（滤掉 origin/HEAD）→ `{current, local[], remote[]}`
- `checkoutBranch(row, name)`：分支名校验；脏工作区拒绝（同 settleAfterMerge 话术）；`origin/` 前缀剥掉用 dwim checkout 建跟踪分支；git 失败原话带回
- `commitAll(row, message, allowSecrets?)`：空消息/空改动拒绝；疑似凭据文件拦截（同建 PR，二次确认后 `allowSecrets` 放行）；`git add -A` + `git commit`
- `pushCurrent(row)`：`git push -u origin HEAD`，禁强推，失败原话带回
- `fetchRepo(row)`：`git fetch --prune origin`（供弹窗「拉取更新」刷新远程分支列表）
- `recentLog(row)`：HEAD 最近 50 条 `{sha, author, date, subject}`
- `discardPaths(row, paths)`：path 必须在当前 dirty 列表里（防乱传）；已跟踪 `git restore --`，未跟踪 `git clean -f --`，重命名带 from+to
- `fileDiff(row, path)`：path 必须在 dirty 列表里；已跟踪 `git diff --`，未跟踪先 `git add -N` 再 diff（新文件也能看）

**`src/routes/git.mjs` 新增 8 个端点**，错误码从 E1101 起（E1061–E1100 已占）：
GET `branches`、GET `log`、GET `diff?path=`；POST `checkout`、`commit`、`push`、`fetch`、`discard`。

### 前端 apps/web

**`js/skills.mjs` renderGitRepos**：
- 详情头仓库名旁加**当前分支 pill**（createCombo，search:true，placeholder「搜索分支」）：渲染后异步读 `/changes` 拿当前分支；点开 onOpen 拉 `/branches` → 「本地分支」「远程分支」两组 + 末尾「拉取更新」项
- 点分支：照「回 main」先确认（当前→目标、ahead 提醒、脏工作区说明服务端会拒）→ POST checkout → toast + refresh；「拉取更新」→ POST fetch
- 详情区新增**「改动」卡**：提交行（消息输入 + 提交按钮）+ 未提交文件列表（状态字母 + 路径）；点文件展开只读 diff（+/− 行简单上色）；每行「丢弃」（confirmDo 危险色）。服务端因凭据拒绝时 confirmDo 二次确认重发
- head-actions 在「同步」旁加**「推送」**按钮
- 详情区新增**「历史」卡**：最近 50 条（sha 主题 · 作者 · 日期）

**`style.css`**：`gr-` 前缀少量样式（分支 pill、文件行、diff 着色、历史行），沿用现有变量。

### 配套

- `docs/design/2026-10-27-代码托管-git操作集成-方案.md` 简短设计记录（照仓库惯例）

### 这轮不做（后续小增量）

新建/删除分支、冲突三路合并编辑器、图形化提交拓扑图。

### 验证

起本地 server 用 bandi 仓库本身当样本走查：切分支（含远程分支）、拉取更新、diff 查看、单文件丢弃、提交、推送、历史；两条护栏必须实测——脏工作区拒绝切换、疑似凭据拦截提交。