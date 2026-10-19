# skills

平台的 skill 库。每个 skill 一个目录：

```
skills/
  <名字>/
    SKILL.md          ← 必需，开头是 YAML frontmatter：name / description
    references/       ← 选填：长材料放这儿，按需读
    scripts/          ← 选填
```

格式与 Codex 原生一致（`name` + `description` + 正文）。`description` 决定"什么时候该用它"，
所以要写清适用场景，不要把正文塞长——它的价值在少而准。

## 这批技能从哪来

全部来自上游公开仓库，**原样引入、不改正文**（改了就等于分叉，上游更新就没法直接覆盖）：

| 技能 | 上游 | 许可 |
| --- | --- | --- |
| `doc-coauthoring`、`skill-creator`、`webapp-testing` | [anthropics/skills](https://github.com/anthropics/skills) `dbd4588` | Apache-2.0（各目录内附 `LICENSE.txt`） |
| `brainstorming`、`test-driven-development`、`systematic-debugging`、`requesting-code-review`、`receiving-code-review`、`verification-before-completion` | [obra/superpowers](https://github.com/obra/superpowers) `bb92a77` | MIT |

更新办法：拉上游对应目录整个覆盖过来，再改这张表里的 commit。**不要在这里就地改上游文件** ——
要改就在上游提，或者另起一个新技能。

### 平台自有技能（不走上游，可以直接改）

| 技能 | 给谁 | 干什么 |
| --- | --- | --- |
| `bandi-secretary` | 内置秘书「喜儿」 | 值班手册：先看现场（`/api/state`、`server.log`、`/api/runtimes`）、怎么判断连错库、怎么建员工；以及越界清单（不派活、不起流程、不碰代码） |

它**只是操作手册**，不含任何平台约定 —— 约定仍归 `docs/`。
之所以做成技能而不是塞进那个人的 `instructions`：正文几 KB，常驻上下文是浪费，
首轮只注入「名字 + 一句话 + 路径」，她真遇到事才来读。

平台自己的约定（契约、审阅判据、文档目录）**不是技能**，放在 `docs/`：
[契约](../docs/契约.md)、[审阅经验](../docs/审阅经验.md)。

## 它怎么到达员工

平台的**平台根**（就是这个仓库）会被自动附加为每个员工的目录之一，
所以哪怕某个人的主工作目录是别的项目（比如爻鉴），他也读得到这里的 skill。

首轮只注入「名字 + 一句话 + 路径」（`apps/server/src/skills.mjs` 的 `skillDigest`），
正文由模型按需去读——**渐进披露**，不占常驻上下文。

具体做法是给 `codex` 传：

```
-C <主工作目录>
-c sandbox_workspace_write.writable_roots=["<主目录>", "<附加根>", "<平台根>"]
```

用配置键而不是 `--add-dir`：因为 `codex exec resume` **不收** `--add-dir`，
而我们除第一句以外每条消息都是 resume。

## 注意

`writable_roots` 只在**沙箱模式**下才有约束力。当前跑的是 `danger-full-access`（无沙箱），
所以这段参数现在不产生行为差异——它是为"将来切回沙箱"铺的路。
