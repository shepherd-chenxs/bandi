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

## 它怎么到达员工

平台的**平台根**（就是这个仓库）会被自动附加为每个员工的目录之一，
所以哪怕某个人的主工作目录是别的项目（比如爻鉴），他也读得到这里的 skill。

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
