---
name: bandi-doc-templates
description: 交付流程三份产出物的骨架模板 —— spec（需求与验收场景）、plan（方案与排期）、task（任务卡）。按任一模板写文档前先读对应那份，别自己发明结构。
---

# 交付文档骨架模板

- [references/spec.md](references/spec.md)：需求 —— 目标、边界、验收场景（可执行、可复现）、不做什么。
- [references/plan.md](references/plan.md)：方案与排期 —— 改哪些文件、风险点、版本号、回滚。
- [references/task.md](references/task.md)：任务卡 —— 卡描述与验收标准的写法（每张卡绑定验收场景编号）。

它为什么是技能而不是 docs/ 里的模板（2026-11-24 定）：内建流程与自主交付的节点提示词都指名要
「按骨架写产出」，这是**运行时依赖** —— 必须走技能库（有登记表兜底），不能放 docs/（改名就静默 404）。

产物落点不变：写进**被交付项目**的 `docs/模板/`（spec.md → plan.md → 代码 → PR → 汇报），
技能只管骨架长什么样，不管写到哪里。
