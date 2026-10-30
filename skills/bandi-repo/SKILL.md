---
name: bandi-repo
description: 本仓库（bandi）的门禁地图 —— PR 红了该跑哪条命令、红在哪一行，以及"该改代码还是改断言"怎么判。被派去修 gate 的人先读这一份，别再从头摸一遍。
---

# bandi 仓库门禁地图

这份不是方法论（那是 `bandi-expert-dev` 的事），是**这个仓库的现场图**：
门禁有哪几段、每段跑什么命令、红了第一步做什么、哪些坑踩过。

装这份技能的理由很实在：2026-10-30 复盘"合并 PR 出问题、派人去修往往很久"，
发现一半时间花在**重新认识仓库**上 —— 找 workflow、全量重跑看日志、797 行的用例里靠肉眼找失败的那条。

## 一、门禁只有三段

| 段 | 命令 | 本机耗时 | 管什么 | 不管什么 |
|---|---|---|---|---|
| ① 策略检查 | `node tools/check-pr.mjs` | **0.2s** | 零依赖铁律 / 地址白名单 / 断言完整性（净删 `check(` 才算放松） | 逻辑对不对 |
| ② 语法与形状 | `node --check` 逐个文件 + JSON 解析 + NSIS 钩子带 BOM | 几秒 | 机器能一句话判死的 | 同上 |
| ③ 冒烟 | `node tools/run-smokes.mjs` | **3 分 26 秒**（49 条，串行） | 49 条验收契约 | 串到真 CLI / 模型的那 4 条（见文末） |

CI 就是这三段，跑在 `windows-latest`（[.github/workflows/pr.yml](.github/workflows/pr.yml)）。
**第 ③ 段是唯一慢的**，也是最常红的那段。

分得清才省时间：① 红了（0.2 秒就有结论）跟 ③ 红了（3 分半）处理方式完全不一样。

## 二、红了以后，两分钟内做的三件事

```bash
# 1. 只跑红的那一条 —— 别全量重跑。多数用例 1 秒级，最慢的也就 48 秒
node tools/run-smokes.mjs --only=smoke-pr-create

# 2. 失败断言会直接标位置，打开那十行就够
#    @apps/server/src/smoke-pr-create.mjs:766  ✗ 卡挂在选的人名下、还在「待办」…
#    完整输出落在 tmp/smoke-fail-*.log（不用再跑一遍去翻日志头尾）

# 3. 问一句：这条断言是哪天、为哪个决定定的？行号用 1 里标出来的那个
git log -L <行号>,<行号+3>:<用例文件>   # 例：git log -L 766,769:apps/server/src/smoke-pr-create.mjs
```

然后只有两个结论，二选一：

- **决定没变** → 代码错了，改代码。
- **决定变了**（产品侧已经按新决定改了，代码注释里通常带着日期和用户原话）→ **同一个提交里改断言**，
  注释写清"某年某月某日决定改成什么，断言跟着改，语义没松"。改完在交付里明说"动的是断言不是产品"。

判据只有一个：**断言是别人某天的验收依据，不是障碍物**。为了绿去删断言、放宽正则、改 workflow，都不算修好。

## 三、绝对不许做的三件事

1. 删 `check(...)` 或整条用例 —— `check-pr.mjs` 会拦（净删除），人也会看。
2. **放宽正则不给日期理由** —— 这条机器拦不住（只查净删），所以靠自觉：改了哪条断言、为什么、哪天定的，写在注释里。
3. 改 `.github/workflows/**` 绕过去 —— 那等于把门拆了，`check-pr` 只提示不拦，但合并的人会拒。

## 四、49 条用例对照表（红了先看这张表找对文件）

前缀都在 `apps/server/src/`，`--only` 直接用文件名。

**账号 / 权限 / 登录**：`smoke-auth` 访问令牌 · `smoke-roles` 角色与菜单 · `smoke-device-roles` 设备角色下发 · `smoke-users` 账号登录与角色分配 · `smoke-personas` 岗位字段

**会话 / 聊天 / 运行态**：`smoke-conversation-delete` 永久删会话 · `smoke-chat-to-board` 聊天派活与看板 · `smoke-run-progress` 运行进度（进到哪一步了）· `smoke-run-events` 运行事件流断线补缺口 · `smoke-stop-keep` 停止生成不许丢已说出口的话 · `smoke-stop-watchdog` 停止看门狗 · `smoke-events` 全局 SSE

**任务 / 看板 / 流程**：`smoke-project-tasks` 看板接口 · `smoke-project-profile` 项目档案 · `smoke-task-flow` 任务卡由流程执行 · `smoke-task-run-sync` 运行结束状态怎么收 · `smoke-task-comments` 卡评论区 · `smoke-agent-cards` 建卡通道（只有项目经理能建）· `smoke-workflows` 流程派活规则（只认点名）· `smoke-schedules` 定时任务

**PR / 代码托管**：`smoke-git-repos` 仓库接入 · `smoke-pr-create` 建 PR / 列 open PR / 手动合并 / **gate 明细+重跑+让 AI 修** · `smoke-pr-link` PR 联动 · `smoke-pr-review` 审阅与授权合并 · `smoke-repo-cards` 仓库值班写卡 · `smoke-repo-patrol` 仓库巡检

**节点 / 远程 / 局域网**：`smoke-node` 节点报到掉线 · `smoke-node-jobs` 节点领活 · `smoke-node-panel` 节点配置面 · `smoke-node-task` 一键装运行时 · `smoke-lan-join` 加入总机 · `smoke-lan-origin` 局域网来源闸 · `smoke-runtime-heal` 路径自愈 · `smoke-lifecycle` 控制面起停 · `smoke-ssh` 服务器与密钥 · `smoke-pair` 手机配对 · `smoke-data-dir` 数据落点与远程访问

**飞书 / 连接器 / 插件**：`smoke-feishu` 飞书通道 · `smoke-connectors` 连接器接口 · `smoke-plugin-blocks` 插件新版式块 · `smoke-status` 研发面板 · `smoke-quota` 模型额度

**群 / 专家 / 内置员工**：`smoke-group-dissolve` 群解散（消息留只读）· `smoke-group-mentions` 群 @ 排队 · `smoke-experts` 专家库 · `smoke-steward` 系统管家崔老三 · `smoke-autostart` 开机自启

**桌面壳 / 前端静态**：`apps/desktop/smoke-shell.mjs` 壳的 Node 那一半 · `tools/smoke-help-pop.mjs` 标题旁 ? 弹层

不跑（要真实 CLI / 模型，别去动它们）：`smoke-codex` / `smoke-dsh` / `smoke-mcp` / `smoke-plugin-e2e`。

## 五、踩过的坑（都写在这里了，别再踩一遍）

1. **本机绿 ≠ CI 绿**。2026-10-17 实锤：门禁里写了 `.agents/plugins/marketplace.json`，本机有、`.agents/` 在 `.gitignore` 里没被跟踪，CI 的干净 checkout 里没有 → 必红 ENOENT。门禁里出现的每个路径，都得能在干净 checkout 里找到。
2. **端口是固定的，所以只能串行**。每条用例自己有默认端口（`SMOKE_PORT ?? 88xx`），有重复（8796 出现 3 次、8797/8798/8816 各 2 次）。想并发得先改端口，别直接改 runner 的顺序。
3. **断言绑文案和文件位置**。前端把卡片拆成 `run-progress-card.mjs` 后，`smoke-run-progress` 的断言就红了 —— 这是漂移不是 bug，**改断言，别把重构回滚**。
4. **环境变量必须在 import 之前设**：`BANDI_DATA` / `BANDI_DB` / `BANDI_GH_API` 都在 import 时读走（见 `smoke-pr-create.mjs` 顶部）。
5. **NSIS 钩子必须 UTF-8 BOM**：`apps/desktop/installer-hooks.nsh` 不带 BOM，makensis 报 Bad text encoding。
6. **零依赖是硬约束**：不许加 package.json / 锁文件 / node_modules（`check-pr` ① 会拦）。
7. **新外部地址要说明来路**：白名单在 `tools/check-pr.mjs`，加之前先问"这是官方源还是中转站"。
8. **代理会吃回环请求**：本机调 `127.0.0.1` 被判成服务挂了 —— 记得绕代理。

## 六、快慢参考（决定"值不值得等"）

- 单条多数 **0.1–2 秒**；慢的四条：`smoke-pr-create` 47.7s、`smoke-lifecycle` 21.8s、`smoke-shell` 21.4s、`smoke-stop-watchdog` 18.9s（合计占全量 53%）。
- 全量 **3 分 26 秒**，串行。所以：**修的时候只跑一条，交付前再跑一次全量**。

## 七、交活前自查（一句话版）

```bash
node tools/run-smokes.mjs --only=<红的那条>   # 先绿
node tools/run-smokes.mjs                     # 再全量绿
git diff --stat                               # 只改了该改的：无关文件不夹带
```

回报四句：**结论**（修好/卡在哪）· **失败断言原文** · **改了什么**（代码还是断言，断言要带日期理由）· **验证命令与结果**。
修不动就停下来说清卡在哪、要人做什么决定 —— 反复乱试比修不好更糟。
