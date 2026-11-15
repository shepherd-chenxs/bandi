# v2.0 · 自主迭代班底并排查设计漏洞（plan）

> 「定计划」这一步的产出，放 `<项目根>/docs/项目文档-by班底/20-排期/10-版本/`。
> 方案是给没见过这份需求的人执行的：把**你决定了的**写下来（哪些文件、什么接口、哪个测试证明），
> 留白的地方执行人会自己选 —— 那些地方要明确说"这里可以自选"。

## 版本

- 上一版：无（首版）
- 本版：v2.0
- 本版相对上一版的变化：根据 spec v1（bandi-self-delivery 第 1 节点产出）拆成可施工卡片，给出排期、改动文件、设计漏洞高发点与回退路径。

## 技术选型与理由

- 语言/运行时：Node.js（仓库原生，无需 `npm install`），以 `.mjs` 为主。
- 看板/任务：平台 `project-tasks.mjs`，REST 接口 `POST /api/projects/{id}/tasks`（`X-Bandi-Run-Token` 鉴权），状态限 `idea/todo/doing/review/blocked/failed/done/cancelled`。
- 流程模板：`bandi-self-delivery`（n1 PM 谈需求 → n2 架构师方案 → n3 研发实施 → n4 测试验收 → n6 提交 PR → n7 PM 汇报）。
- 证据要求：每条设计漏洞按 spec 场景 S1.1 要求带 `文件路径 + 函数名/行号`；严禁依据 `apps/desktop/runtime/**`、`dist/`、`target/` 等打包产物。
- 版本号：沿用平台版本 `apps/desktop/version.json`（当前 `1.5.21`），本轮迭代定为 `1.5.21` 的自迭代分支，不打 tag、不发版。

## 改动面

| 文件 | 操作 | 负责 |
| --- | --- | --- |
| docs/模板/plan.md | 新增（本文档） | 架构师 |
| docs/模板/task.md × N | 新增 N 张任务卡（按 spec S2.1 拆卡） | 架构师 |
| docs/design/2026-11-13-设计漏洞清单.md | 新增（S1 输出） | 架构师 |
| apps/server/src/*.mjs | 按卡实施的代码改动（S3 施工阶段，本步不改） | 研发 |
| apps/web/、apps/desktop/、apps/mobile-native/、plugins/ | 按卡实施的前端/桌面改动（S3 施工阶段，本步不改） | 研发 |

本步（方案设计）只改 `docs/模板/plan.md` + 新增 N 张看板卡；不触碰任何源码。

## 风险与回退

- 风险 1（设计漏洞证据找不到）：spec S1.1 要求"文件路径 + 函数名/行号"，若某条问题在当前代码中找不到对应位置，按 spec 不允许带模糊条款进排期 —— 退回 S1 重审，不强行排入本版。
- 风险 2（不可逆/花钱/对外/改范围）：按 spec 与 S2.2，此类卡统一以 `idea` 形态上报雇主，绝不直接施工；本版所有卡均为可逆、有回滚、不花钱、不对外、不改范围。
- 风险 3（卡创建失败/403）：平台接口 `POST /api/projects/{id}/tasks` 需 `X-Bandi-Run-Token`，403 `E4034` 表示该接口不归运行钥匙管，此时改为手工写卡文档，由雇主补充权限后补建。
- 回退路径：plan.md 与 task.md 均为可编辑文档，删掉即可回退；不涉及代码、不涉及部署、不涉及合并，雇主择时合并/上线。

## 拆卡

每张卡 = 看板上的一张任务卡（格式见 docs/模板/task.md），标出它覆盖的场景编号。卡的粒度：一张卡做完能独立验证。

| 卡 | 标题 | 覆盖场景 | 依赖 | 归属 |
| --- | --- | --- | --- | --- |
| T-001 | 设计漏洞审计：架构/模块边界/数据流/接口契约四维度扫描并产出清单 | S1.1、S1.2 | 无 | 架构师 |
| T-002 | 技术方案与排期：把漏洞清单转成可派活卡片，写入 plan.md | S2.1、S2.2 | T-001 | 架构师（PM 协同） |
| T-003 | 施工样板卡：按 plan.md 改动一处源码并提交 PR（示例，覆盖 S3 流程） | S3.1、S3.2 | T-002 | 研发 |
| T-004 | 验收样板卡：按 S1 复现路径回归一处漏洞并产出通过/不通过结论 | S4.1、S4.2 | T-003 | 测试 |
| T-005 | 验收汇报进信箱：汇总漏洞清单 + 方案 + PR + 测试结论 | S5.1、S5.2 | T-004 | PM |

排期：T-001 → T-002 → T-003 → T-004 → T-005，预计 4 个工作日；其中 T-001/T-002 为本步（方案设计）交付，T-003～T-005 归后续节点。

## 评审意见（n3 设计评审 · 找设计漏洞）

结论：需修改。自主交付模板的流程连线与节点岗位可跑通，但存在 8 条设计漏洞，建议在施工前修改模板或补充兜底，否则自主运行时会出现静默卡死、自评自查、汇报缺失等问题。

| # | 漏洞 | 风险 | 建议 | 可行 |
|---|------|------|------|------|
| L-01 | 评审与施工同岗位（n3/n4 均 roleKey 'dev'，`assigneeFor` 可能派给同一人），自评自查（apps/server/src/self-delivery.mjs 节点 n3/n4） | 设计漏洞被施工者本人评审，容易放过，缺乏评审独立性 | n3 改按架构师岗位评审（roleKey 'architect'），或强制 n3 与 n4 不是同一人 | 高 |
| L-02 | 按岗位指派的单点卡死：岗位唯一人正忙或无人时，流程永久阻塞，仅 30 秒节拍无限重试，无降级/超时/自动换人（apps/server/src/workflows.mjs `assigneeFor`、`createTask`、`retryPendingSteps`） | 自主交付中途静默停住，雇主只在信箱见一条 WF_BLOCKED，需人工 `assignCurrentStep` 换人，与"无人工拍板"冲突 | 岗位满载时排队到下一位同岗位人员；设最大阻塞时长后升级通知雇主 | 中 |
| L-03 | 跨步骤无结构化交接管道：上游产出靠文档落盘，下游"读目录拿产出"，引擎不校验产出存在性与正确性（docs/design/2026-11-13-完全自主交付-设计.md 第九节；self-delivery.mjs 节点 detail） | 下游按空/错信息施工，引擎绿灯放行，漏洞流入 PR | 在 plan.md 为每步强制产出清单；下游开始前先做产出存在性检查；后续阶段引入 step 输出/输入字段 | 中 |
| L-04 | `pr-create` 动作节点一次失败即停，无自动重试/回退（apps/server/src/workflows.mjs `finishActionTask`） | GitHub 网络或凭据抖动等可恢复失败变成人工干预点，削弱自主性 | n6 增加有限次自动重试（如 3 次），耗尽后再 failed + 信箱 | 高 |
| L-05 | 任务级受阻/失败的信箱汇报不带该步产出上下文（apps/server/src/workflows.mjs `notifyDeliveryReport`，非 done 状态 reportBody 为空） | 雇主收到"受阻"只知原因，不知该步已完成什么，仍需翻实例页，与"直接收到结果"目标打折 | 受阻/失败时也带该步最近产出摘要（result.summary/artifacts）进 detail | 中 |
| L-06 | 信箱汇报写失败被 catch 静默吞掉（apps/server/src/workflows.mjs `notifyDeliveryReport` 尾部 catch） | 自主交付的核心承诺（跑完/卡住必汇报）可能静默失效，雇主毫无感知 | 汇报写失败时至少记日志或入本地重试队列，不完全静默吞掉 | 中 |
| L-07 | 模板版本升级时新增节点不会补入已有模板（apps/server/src/self-delivery.mjs `ensureSelfDeliveryTemplate` 只遍历旧库节点，只补 detail/坐标） | 升级后旧模板结构残缺，运行时节点悬空，`decide` 驳回无去处报错 | 版本升级时把缺失节点补入（只加不改，保留用户已改节点） | 中 |
| L-08 | 人工把自主模板任务标 done 时，`setStepStatus` 直接 `decide('通过')`，不经过 `onAgentRunFinished`，`result.report` 不写（apps/server/src/workflows.mjs `setStepStatus`） | 人工干预时信箱 done 报告缺 PM 汇报正文，雇主收不到交付内容 | setStepStatus 改 done 时补写 result.report，或决策时把当前任务 result 当 reportBody 兜底 | 低 |

需要修改的地方：self-delivery.mjs（n3 岗位、n6 重试）、workflows.mjs（汇报兜底、受阻带产出、setStepStatus 写 report）、plan.md（产出清单）。

### 复核记录（设计评审第 1 次 · 2026-11-13）

- 8 条漏洞逐条按证据位置翻代码复核，全部命中（代码位置见各条【风险】列，行号对照 HEAD 可翻）。
- 新增确认的「缺失验收场景」：grep spec.md 对 `超时 / 升级 / 重试 / catch / 静默` 零匹配 —— L-02（指派饱和无升级）与 L-06（汇报信道失败无兜底）属于 spec 未覆盖的验收场景，已单列。
- 结论维持：**需修改**。施工前建议先改 self-delivery.mjs（n3 岗位独立性、n6 重试）与 workflows.mjs（汇报兜底、受阻带产出、setStepStatus 写 report），否则自主运行时会出现静默卡死、自评自查、汇报缺失。