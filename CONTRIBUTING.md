# 参与班底

先谢谢你看这个仓库。下面是这个项目**特有的**几条规矩 —— 都是踩出来的，不是客套。

## 先说三件最要紧的

### 1. 这是个"会在用户机器上执行命令"的软件

所以**执行路径的改动请先开 issue 说一声**，不要直接提 PR。具体是这些地方：

- `apps/server/src/node.mjs` —— `runTask` / `spawn` / `binSearchDirs`（节点在本机起进程）
- `apps/server/src/runtimes.mjs` —— `installCommandFor`（一键安装跑的那条命令）
- `apps/server/src/externals.mjs` —— `commandFor` / `mirrors`（外部件的命令与镜像）
- `apps/web/app.js` —— 任何把字符串拼进 `data-*` 再执行的写法

### 2. 有一条架构红线，别为了"方便"拆掉

**控制面只发「族名 + 哪一步」，命令由那台机器自己查表**（见 `runtimes.installCommandFor` /
`externals.commandFor`）。这条是**安全边界**：它保证了控制面**递不出任意命令**。

所以这些 PR 会被拒：

- "让控制面直接下发命令 / 脚本" ✗
- "加一条便捷通道，把远端命令透传过去" ✗
- "为了方便，在配置里放一段 shell 让节点执行" ✗

### 3. 注释要写**为什么**，中文

这个仓库最大的资产不是代码，是**注释里的理由** —— 你会看到大量"原来这么写，然后为什么改了"。
改代码时请照这个风格补上理由；只写"做了什么"的 PR 会被要求补注释。

## 怎么跑

```sh
# 全套（15 条，几分钟）
node apps/server/src/smoke-auth.mjs     # 认证 / 每节点令牌 / 局域网开关 / 原地重启
node apps/server/src/smoke-node-task.mjs # 节点任务协议 / 安全边界 / 镜像校验
node apps/server/src/smoke-runtime-heal.mjs
node apps/server/src/smoke-autostart.mjs
# …… 其余见 apps/server/src/smoke-*.mjs、apps/desktop/smoke-shell.mjs
```

带着控制面本地跑一遍（默认只听回环、免令牌）：

```sh
node start.mjs          # 然后浏览器开 http://127.0.0.1:8787
```

用例**不许**碰真实数据或真实服务：用临时目录、用 8787–8889 之外的端口、自启那类走 `noSystem`。

## 提交

- 用 `git commit -s` 加一行 `Signed-off-by: 你的名字 <邮箱>` —— 这是在声明"这段代码我有权提交"
  （[DCO](https://developercertificate.org/)，不是转让版权，你仍然拥有自己写的那部分）。
- 一个 PR 只做一件事；顺手重构请单独提。
- 我会**慢回**（一个人维护），但会回。急着要的，先在 issue 里把场景说清楚，比 PR 更快。

## 欢迎什么

- 节点适配：更多 agent CLI、更多操作系统
- 部署：Docker / 群晖 / systemd 模板 / 反代与 TLS 配置
- 文档、报错信息、界面文案（**越少越好**：这个界面刻意不解释原理，原理归官网与 `docs/`）
- 修 bug —— 带上"怎么复现"，最好再补一条用例

## 许可

Apache-2.0（见 `LICENSE`）。名称与 logo **不随**本协议授权（见 `NOTICE`）。
