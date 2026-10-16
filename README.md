# 班底

**把活派给 AI 数字员工，看它干，随时接管。**

自托管的多 agent 协作平台：控制面 ＋ 出站节点，算力在你自己机器上。
一个**数字员工** = 名字 ＋ 职责指令 ＋ 绑定的 agent CLI（Codex / DeepSeek Harness）＋ 权限 ＋ 工作目录；
派给他的活落在会话里，事件流（思考 / 工具 / 回复）实时可见，随时能掐。
2026-10-14 起还有**流程引擎**：模板（节点 ＋ 连线 ＋ 出口）＋ 实例，谁上场、下一步去哪、干完停不停由引擎管。

| | |
| --- | --- |
| **下载（Windows）** | [GitHub Releases](https://github.com/shepherd-chenxs/bandi/releases/latest) → `bandi_<版本>_x64-setup.exe` |
| **从源码跑** | `node start.mjs`（默认 <http://127.0.0.1:8787/>） |
| **它长什么样** | 见下面的「三步用起来」；设计说明在 [docs/架构.md](docs/架构.md) |

## 30 秒上手

### A. 装桌面版（Windows，推荐）

1. 到 [Releases](https://github.com/shepherd-chenxs/bandi/releases/latest) 下 `bandi_<版本>_x64-setup.exe`，双击安装。
   **自带 Node 运行时**，装完即用。
   ⚠️ 产物**没有代码签名**，Windows 会提示「未知发布者」→ 选「仍要运行」。
   （校验和在同一页的 `SHA256SUMS-v<版本>.txt` 里。）
2. 打开「班底」——窗口里就是平台界面（本机访问**免登录**）。
3. 卸载时可选**完全卸载**：连数据一起删（库、令牌、插件与连接器、机器登记表、开机自启项），
   默认不删、静默卸载不删。

### B. 从源码跑（想改代码 / Linux / macOS）

```sh
node --version        # 需要 Node 22 或更高（用了内置 node:sqlite）
node start.mjs        # 起控制面 + 开浏览器；Windows 也可以直接双击 start.cmd
# 控制面默认只听本机 http://127.0.0.1:8787/，数据落在 <仓库>/data（可用 BANDI_DATA 指到别处）
```

零依赖：没有 `npm install` 这一步，也没有打包器。

### 两条路都要的前置条件

- **agent CLI 自己装、凭据自备**：Codex（`codex`）或 DeepSeek Harness（`dsh`）—— 班底只负责调用，
  **不分发**它们（见 [许可](#许可与署名)）。
- **想多台机器一起干活**：那台机器上装班底节点，见 [deploy/README.md](deploy/README.md)。

## 三步用起来

1. **建一个数字员工** —— 起名、写职责指令、选 runtime（Codex / dsh）、指定它干活的工作目录。
   想给他加能力，就在「设置 → 技能」里挂技能包（[skills/README.md](skills/README.md)）。
2. **跟他说话** —— 在「消息」里发一句：一条消息就是一次真实调用，事件流实时回来，随时可以掐掉。
   会话可以带上**项目**，活就落在那个项目目录里干。
3. **要流程就起一条** —— 工作台 → 「流程编排」配模板（节点 ＋ 连线 ＋ 你在每个节点**点名**的人），
   发布后在工作台点开它、填一句「想法」就起了一条；实例页看得见谁在办、走到哪、
   哪一步在等人放行（**部署那一步固定要人下令**）。

**任务看板**在两处：**项目 → 点一行进详情**（这个项目的活），**工作台 → 任务看板**（所有项目）。
卡片三个来源：流程的每一次办理、聊天派活、手工建的卡。

## 安全默认（先读这条）

**这个软件按设计会在你的机器上执行命令。** 控制面默认只听本机；一旦监听非回环地址（服务器 / 局域网）
就**自动要求访问令牌**（首次生成在数据目录的 `token` 文件里 —— 当**私钥**看待）。
**别把控制面直接挂公网**：公网 / 不可信网络请走 SSH 隧道或 TLS。详见 [SECURITY.md](SECURITY.md)。

## 许可与署名

- [Apache-2.0](LICENSE)：可商用、可闭源再分发，**含显式专利授权**。收 PR 按第 5 条
  inbound = outbound，**不需要 CLA**；提交请带 `git commit -s`（DCO，见 [CONTRIBUTING.md](CONTRIBUTING.md)）。
- Copyright 2026 **牧羊人**（见 [NOTICE](NOTICE)）。**名称与 logo 不随协议授权** ——
  代码随便拿去做别的产品，但**别叫「班底」**。
- **不分发第三方**：Codex CLI / Claude Code / DeepSeek Harness 由使用者自行安装、自备凭据；
  magpie 是**独立项目**，平台只是"认得它、能帮你装它、能看见它跑没跑"。
- 安装包**随包带** `LICENSE`、`NOTICE`、`node-LICENSE.txt`（内嵌 `node.exe`）：二进制分发同样满足
  Apache-2.0 第 4 条。

## 文档在哪

| 想看什么 | 去哪 |
| --- | --- |
| 设计说明：主体功能、统一事件词汇、技术选型、两个适配器的不对称 | [docs/架构.md](docs/架构.md) |
| 现在做到哪了、踩过哪些坑、每条怎么验收（开发台账） | [docs/现状.md](docs/现状.md) |
| 为什么是这个形态（托管控制面 ＋ 出站节点） | [docs/形态决策.md](docs/形态决策.md) |
| 部署、SSH 隧道访问、节点报到、备份与排障 | [deploy/README.md](deploy/README.md) |
| 桌面壳与打包（三步、环境坑、卸载） | [apps/desktop/README.md](apps/desktop/README.md) |
| 技能库：怎么给数字员工加能力 | [skills/README.md](skills/README.md) |
| 安全边界与报告方式 | [SECURITY.md](SECURITY.md) |

## 版本

当前 **0.9.0**，真源唯一：[apps/desktop/version.json](apps/desktop/version.json)
（`build.rs` 读它编译进程序，并同步安装包名 —— **别在别处记第二个号**）。
`0.y.z` = 初始开发期、**不承诺兼容**：插件格式、流程模板、`status.yaml` 契约都还在动。
发版：改 `version.json` → 提交 → 打 `v<版本>` tag 推上去，CI 自动出安装包并挂 Release。
为什么不是 `1.0.0`、插件 / MCP 的另一套号，见 [docs/现状.md](docs/现状.md)「版本与台账」。
