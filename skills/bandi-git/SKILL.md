---
name: bandi-git
description: 本仓库分支怎么起名、提交怎么写。建分支或写提交说明前照这个来 —— 服务端按同一条规则校验。
---

# 分支与提交：两条规则

## 一、分支名：`<type>/<短描述>`

`type` 只能是这七个：`feat` `fix` `chore` `docs` `refactor` `test` `perf`

`短描述`：小写英文、数字、`.`、`-`，最长 64。全是中文写不出短描述时，用时间戳 `YYYYMMDD-HHmmss`。

```
fix/pr-gate-smoke
feat/branch-badge
docs/gitlab-rule
chore/20261030-125019
```

不许：`bandi/…`（老前缀）、`feature/x`、`test`、`123`、带大写字母。**短描述不许就是仓库名**。

## 二、提交信息：`<type>(<scope>): <subject>`

- `type`：`feat` `fix` `chore` `docs` `refactor` `test` `perf`（另可用 `style` `revert`）
- `scope`：影响范围，例如 `apps/web`、`server`、`pr`
- `subject`：50 字符以内，说清改了什么；不写"更新 N 个文件"这种话

```
fix(server): 「建 PR」两处入口补回 push:true
feat(apps/web): 分支角标改双色箭头带个数
```

改了什么不够说明白时，空一行写正文：为什么必须改、怎么解决的、有没有风险。

## 三、合并前自查

```bash
git branch --show-current     # <type>/<短描述>？
git log --oneline -3          # 提交都是 <type>(<scope>): <subject>？
```
