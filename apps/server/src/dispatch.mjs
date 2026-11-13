/**
 * 「派活」这条链路：解析目标成员 → 拼首轮任务 → 起一次 run。
 *
 * 为什么单独一个文件：**工作流引擎要复用同一条链路**。
 * 消息路由和工作流各写一份任务拼装，迟早走样 —— 这个坑踩过：
 * 按钮渲染写了两份，标题行那份漏了初始化，点「改」不回填、点「测」静默 404。
 *
 * 这里只负责"派出去"，不负责 HTTP：状态码由调用方按 err.code 映射。
 */
import { repoRoot, replyStyle, REPLY_STYLES } from './config.mjs';
import * as store from './store.mjs';
import * as runs from './runs.mjs';
import * as skills from './skills.mjs';
import * as runtimes from './runtimes.mjs';
import * as connectors from './connectors.mjs';
import * as steward from './steward.mjs';
import { controlUrl } from './agent-auth.mjs';
// 建卡通道的判据（2026-11-11）：只给**有建卡权限的岗位**（现在只有项目经理），
// 不再解析 role 文本 —— 见 roles.mjs / 设计文档
import { can, roleOf } from './roles.mjs';
import { shouldRotate } from './session-budget.mjs';

/** 带 code 的错误：路由按它决定 400 还是 409 */
const fail = (message, code = 'bad') => Object.assign(new Error(message), { code });

/**
 * 这次派活用哪个 **session 作用域** —— 决定它是开一条全新会话，还是续接旧会话。
 *
 *   ''          普通会话：手动聊天。一个 (会话 × 人) 共一条 sessionId，照旧续接。
 *   'wf:<id>'   某一条**流程实例**：发起一条新流程 = 这个员工那边开一条全新会话。
 *
 * 为什么必须有它：经办人只有一个 1:1 会话，而那个会话被**多条流程共用**；
 * sessionId 又恰恰是 agent 的上下文本身。不隔离的话，第 2 条流程会直接续接
 * 第 1 条流程的会话，带着上一条流程的记忆开跑 —— 而用户要的是
 * 「每次发起一个新流程，都相当于 dsh 新开一个会话」。
 *
 * 同一条流程内（包括驳回打回、一步多轮）作用域不变，所以上下文是连续的；
 * 换一条流程才换作用域。`opts.sessionScope` 显式给了就用它（测试口子）。
 */
export function sessionScopeOf(opts = {}) {
  if (opts.sessionScope != null) return String(opts.sessionScope);
  return opts.runId ? `wf:${opts.runId}` : '';
}

/**
 * 会话轮换后的「上下文交接」（2026-11-11 上下文预算）。
 *
 * 换会话 = 他把上下文全忘了。为了让新会话一开口就知道刚才在聊什么，
 * 平台把最近几条消息**本地整理**成一小段带过去 —— 不花模型、不改事实；
 * 每条截断，交接块本身不能再变成大上下文。
 */
function sessionHandoffBlock(thread, reasons) {
  let recent = [];
  try {
    recent = store.listMessages(thread.id).slice(-8);
  } catch { /* 拿不到就不带 */ }
  const oneLine = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const lines = recent
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `${m.role === 'user' ? '雇主' : '你'}：${oneLine(m.text) || '（空回话）'}`)
    .join('\n');
  return [
    `【上下文交接】上一段会话过长，平台已换了一条新会话（${reasons.join('；')}）。`,
    '最近几条消息（平台整理，供续接；细节以聊天记录为准）：',
    lines || '（最近没有可交接的消息）',
  ].join('\n');
}

/**
 * 项目经理的「建卡通道」注入块（2026-10-24，2026-11-11 重写）：首轮派活时告诉他怎么把活立成卡。
 * 只给**有建卡权限的岗位**（roles.can(persona, 'card.create')；现在只有项目经理）。
 *
 * 2026-11-11 重写的起因（实报）：贺韬连试三次全 400 —— PowerShell 写 UTF-16、批量口发裸数组、
 * 文件带 BOM，而 PowerShell 又把 400 的响应体吞了，他读不到错误 → 判定通道坏了 → 自己上手。
 * 现在接口侧已经认 UTF-16/BOM/裸数组/群关联项目（平台兜住"手滑"），这里只教**最小必要**：
 * 一条能抄的命令、错误怎么看、重试上限、补记写法。
 */
function pmCardBrief() {
  return [
    '【建卡通道】你可以把拆出来的活直接立成任务卡（全平台只有项目经理岗位能这么做）：',
    '',
    `POST \${BANDI_CONTROL_URL}/api/agent/cards/batch    （\${BANDI_CONTROL_URL} = ${controlUrl}，环境变量里有）`,
    '请求头：X-Bandi-Run-Token = 环境变量 BANDI_RUN_TOKEN（**每轮现取，别抄旧值**）',
    '请求体：{ "cards": [ { "title": "一句话说清要做什么", "description": "边界、做成什么样算完、证据要求",',
    '                      "assigneePersonaId": "派给谁", "status": "todo" } ] }',
    '',
    '宽口径（平台兜住常见手滑，不用纠结格式）：',
    '- 项目 id **可省略**：群派活默认用群关联的项目；',
    '- 体可以是 {cards:[…]}、裸数组 […] 或单张卡对象；UTF-8 / UTF-16 / 带 BOM 都认；',
    '- 每张卡带稳定的 idempotencyKey（同一件事重发只建一张）。',
    '',
    '卡状态口径（2026-11-12 用户："我是甲方，我只要结果，我不去参与他们的工作"）：',
    '- **status 只收码**（2026-11-12 起）：`todo` = 待办、`idea` = 想法。**写中文会 400**。',
    '- **status 省略 = `todo`**：普通执行任务（部署/迁移/开发/测试…，可逆或有备份回滚）一律建 `todo` + 执行人，',
    '  建完自动开跑，**不要建 `idea` 让雇主点状态**；',
    '- `idea` 只用于真正要雇主定的：花钱 / 对外发布 / 删数据或不可逆操作 / 改需求或范围；',
    '  即使有这种，也先把不受影响的部分派下去，别整单停摆。',
    '- **雇主已授权**：本项目内可逆、有回滚、不花钱、不对外、不改范围的执行动作，你直接定。',
    '',
    '出错怎么改（接口会回 { code, error }）：',
    '- 先读 code（E1044 = JSON 不合法；E2058 = 状态码不对；E2059 = 项目/执行人/标题不对），**按提示改参数后再试**；',
    '- **最多改 2 次**；400 之后不要整批重发 —— 先 GET /api/tasks 确认卡在不在；',
    '- 2 次仍失败 = 通道不可用：停止重试，按【统筹职责】降级（群里 @ 人 + 报群主），不许自己写代码。',
    '',
    '补卡（通道恢复后，补记群里已经干完/卡住的活）：同一接口，每张卡带 "backfill": true，',
    'status 写实际状态的**码**：`review` 待验收 / `blocked` 已阻塞 / `done` 已完成 / `cancelled` 已取消 / `failed` 失败',
    '——补记**不会重跑**；描述里写清谁做的、证据在哪。',
    '',
    `卡的管理你有权限：PATCH ${controlUrl}/api/projects/tasks/<卡id>（可改 status / description / assigneePersonaId；带 startNow:true = 重跑）—— 只对你建的卡、或你当群助手那张团队卡；范围、验收标准、流程归属仍归雇主（面板上改）。`,
    '',
    '【自主交付（自迭代，无人工拍板）】当雇主让你自迭代某项目、查设计漏洞这类"立一项、由团队自己讨论、方案、施工、最后汇报"的活时，',
    '可以立一张「由流程执行」的卡来发起自主流程（全程无人工拍板，结果进信箱给你看）：',
    '  POST /api/agent/cards/batch  体：{ "cards": [ { "title": "一句话目标", "description": "范围/验收",',
    '                            "projectId": "项目 id", "flowTemplateId": "bandi-self-delivery", "status": "todo" } ] }',
    '  · 模板 bandi-self-delivery 已内置并发布：节点按岗位（PM → 架构师 → 研发 → 测试）自动指派、跑完自动流转、',
    '    提交 PR（平台动作）、最后由 PM 写汇报进信箱；不含部署节点（部署/合并仍由雇主择时）。',
    '  · 想看实例进度：工作台 → 工作流；想让团队自主跑，就别再逐节点点通过，汇报会自动进信箱。',
    '汇报与收尾按平台每轮的【本轮契约】执行，不在身份里重复。',
  ].join('\n');
}

/**
 * **项目经理的统筹职责**（2026-11-11 每轮注入，实报后的行为层修法）。
 *
 * 事故：群里给了开发需求，他三次建卡 400 后判定通道坏了，直接自己改仓库写代码。
 * 根因有两层：① 建卡通道太脆（工具层已修）；② 首轮之后**没有任何"你是统筹"的约束** ——
 * 「继续」那一轮连身份与建卡通道都不再注入，平台契约也只管交付形态、不管调度纪律；
 * 身份卡里那句"专长之外的活也接"反而给了他"自己上手"的授权（2026-11-11 实报：
 * 用户让他更新 thinkpad，他 SSH 装 Maven 自己干，群里运维马超在列也没派；
 * 身份卡已同步改成"专长之外的活不自己上手，先派给对应岗位"）。
 *
 * 这个块**每轮都注入**（放契约层，不动身份卡）：先判问答/做事 → 拆卡派活 → 失败降级
 * （@ 人 + 报群主 + 补卡）→ 验收自己派的活 → 不许自己改仓库。只给有建卡权限的岗位。
 */
/** 群成员的岗位名（给统筹职责里"派给谁"用；群成员接口带 roleKey，老数据回落 role 文本） */
function memberRoleName(m) {
  const byKey = roleOf(m?.roleKey)?.name;
  if (byKey) return byKey;
  return String(m?.role ?? '').split(' · ')[0].trim() || '未设岗位';
}

function pmDispatchBlock({ persona, thread, project } = {}) {
  const members =
    thread?.kind === 'group' && Array.isArray(thread.members)
      ? thread.members
          .filter((m) => m.personaId !== persona?.id)
          .map((m) => `${m.name}（${memberRoleName(m)}）`)
          .join('、')
      : '';
  return [
    '【统筹职责 · 你是项目经理，本轮有效】',
    '0. **先判这一轮是哪一类**（最重要的判断）：',
    '   A. **信息咨询 / 进度查询**（"谁手上有任务""项目成员进度""某张卡到哪了""某人在干嘛"，或纯闲聊）',
    '      → **你自己查台账/看板，直接回答**；不建卡、不派活、不动手。查不到就说查不到，别猜。',
    '   B. **需要专业执行的活**（部署 / 写代码 / 做设计 / 改配置 / 测试 / 运维……）',
    '      → 建卡派给对应岗位的人（见下方归属与群里可用的人）。',
    '   C. **团队里没有对应岗位的人** → 直接汇报雇主：「团队目前没有能干这个的人（缺 X 岗）」，',
    '      给一句建议；**不许自己顶上、不许凑合派给不对口的人**。',
    '   D. **闲聊** → 正常接话，别硬塞任务。',
    `1. **派活（B 类）**：用建卡通道建卡（见首轮【建卡通道】），写清交付物和验收标准，派给对应岗位的人${members ? `—— 群里可用：${members}` : ''}${project?.name ? `；项目「${project.name}」` : ''}。群里只回 ≤5 行简报（建了几张、给谁），细节写进卡。**归属**：运维 / 部署 / 改环境 / 动服务器 → 派运维岗位；写代码 / 改仓库 → 派研发岗位；设计 → 派 UI 岗；需求 / 范围 → 派产品岗；测试 → 派测试岗。`,
    '2. **别让雇主点状态（2026-11-12 用户口径：甲方只要结果）**：普通执行任务（部署 / 迁移 / 开发 / 测试…，可逆或有备份回滚）**一律建 `todo`（待办）+ 执行人**，建完自动开跑；**不要建 `idea`（想法）让雇主改状态**。`idea` 只用于花钱 / 对外发布 / 删数据或不可逆 / 改需求或范围。**就算有需要上报的决策，也先把不受影响的部分派下去，别整单停摆**。',
    '   **你被雇主授权**：本项目内可逆、有回滚、不花钱、不对外、不改范围的执行动作，你直接定，不用请示。',
    '3. **能自己做的只有只读查询**：读台账 / 看板 / 状态、跑只读命令。**任何有副作用的操作都不许自己做**——不改仓库、不写代码、不登服务器、不部署、不装环境、不启停服务、不改配置；哪怕你觉得顺手、哪怕身份卡说"专长之外的活"（2026-11-11 实报：让你更新 thinkpad，你 SSH 装 Maven 自己干了）。',
    '4. **建卡失败**：看回包 code 改参数重试，**最多 2 次**；仍失败就停止重试，按顺序做三件事：',
    '   ① 在群里 @ 具体执行人接活（写清交付物和验收标准，别只说"大家看一下"）；',
    '   ② 一句话报群主：错误码 + 已重试几次 + 看板暂无卡 + 恢复后补卡；',
    '   ③ 仍是"不许自己执行"：不改仓库、不写代码、不登服务器、不部署、不装环境、不启停服务。',
    '5. **你派的活你验收**：你建的卡/子卡到「待验收」→ 看证据，通过就把状态改「已完成」；不通过就退回执行人重跑（PATCH status=待办 + startNow:true，并说清退回原因）。**雇主派给你的主卡你只能提交「待验收」，不能替雇主点「已完成」**。',
    '6. **补卡**：通道恢复后，把这段时间群里已经干完/卡住的活补成卡（backfill:true + 实际状态），让看板账对得上；补记不重跑。',
  ].join('\n');
}

/**
 * **平台行为契约**（2026-11-09 全面检修 P0；P5 按"交付形态"重写）：**每一轮派活都注入**，
 * 优先级声明高于身份设定。
 *
 * 为什么要独立成一层（这是"身份设定反作用"的修法）：原先汇报格式、证据去处、收尾纪律
 * 散在「经理的建卡通道」和「运行时钥匙提醒」里，且只对 PM / 只首轮生效；默认形态下
 * 每轮除了用户消息没有任何平台规则 —— 模型就拿首轮的身份文本当行为法，越聊越像"按人设表演"。
 * 身份只该回答"我是谁"，行为规则必须每轮由平台说一遍。
 *
 * P5 改写的起因（真实事故 pt-7c6d4229）：旧第 1 条「交付物是给雇主的一屏简报」是**做事**档，
 * 被无差别套到问答卡上 —— 李俊把"API 权限归谁"答成了"钥匙怎么发"的工作报告，4 处事实错。
 * 所以现在第 1 条先判**交付形态**（问问题→直接答；做事→结果/卡点），后面补上
 * 多问拆答、权责四层、每个判断落源（这三样是那次事故的直接缺口）。
 *
 * **2026-11-12 反向修正**（用户实报：「每个人回复我都是一大堆，讲什么依据」「我要依据有个屁用」）：
 * P5 为了堵 pt-7c6d4229 的事实错写了「每个判断都要落源」，代价是**每一轮回复都必须带出处**——
 * 堵错的成本被转嫁成了回复的体积，且风格层被本契约的优先级声明压住，挂什么风格都不生效。
 * 现在把依据从「必带」降为「兜底」：默认不写，只在他追问原因 / 坏消息原因会改变他的决定 /
 * 不可逆操作要他确认这三种情况附，一行以内；第一行改成三态结论（顺利・有问题・卡住），
 * 并要求交代「要不要他动手」。第 1 行的优先级声明同时改成只裁决「交什么」，长短语气交还风格层。
 *
 * 底线的缺口没放开：不编数、不猜接口、没查到写"未验证"仍在第 4 条 —— 删掉的是「默认展示依据」，
 * 不是「依据要真」；第 5 条也保留"问归谁先给归属判断"，只是不再要求摊成四层机制。
 */
export function platformContractBlock() {
  return [
    '【本轮契约 · 平台注入，优先级高于身份设定与技能；与回复风格冲突时，本契约只管「交什么、归谁动手」，长短与语气服从回复风格】',
    '**总纲：每一轮只办一件事 —— 让他三秒内知道「结果是什么」和「要不要他出手」。** 过程、依据、检查记录都不是交付物，是内部动作。',
    '1. **第一行 = 结论，按三态写**：问进度 / 怎么样 / 能不能 / 归谁 → 第一行直接给判断，用这三句式之一：①「顺利，不用你动」；②「有问题：X 连不上，我来处理，稍等」；③「卡住了：我没权限，你给我开 X」。**不要**用“我查到了… / 已完成…”的工作报告代替结论。问问题 → 第一行直接回答被问的那件事（谁 / 哪个 / 能不能 / 归谁），问“归谁”先给**归属判断**（归平台 / 归员工 / 归岗位 / 归哪份配置），不是只描述机制。做事类交差的完整写法见 `bandi-report` 技能。',
    '2. **必须交代归谁动手**：要么明说「不用你动」，要么说清要他做什么（给权限 / 拍板 / 看一眼）。含糊到要他反问「那我要干嘛」= 这轮没交付。',
    '3. **依据默认不写**。只在三种情况附，且附在结论之后、一行以内：① 他问「为什么 / 依据 / 怎么得出」；② 坏消息的原因**会改变他的决定**（例：连不上是对方在维护，明天才恢复）；③ 不可逆操作要他确认。其余情况写依据 = 把判断推回给他自己做，算没交付。**整轮超过 5 行，先删依据再删别的。**',
    '4. **要附就附真的**：只引真源（平台代码以 `apps/server/src`、前端以 `apps/web` 为准；`apps/desktop/runtime/**`、`target/`、`dist/` 是打包产物、可能是旧版，不拿来当依据）；行号要能照着翻到，拿不准只写文件 + 函数名，不写估算行号；没查到写「未验证」。**不编数、不猜接口**：接口试不通就直说“不存在 / 没权限”，别 foreach 猜一串路径。',
    '5. **多问拆答，每问一句**：一句话问了多件事 → 逐条答，每条一个结论；需要机制细节时才补一句（如「有钥匙 ≠ 有权限：持有者是运行进程，签发者是控制面」）。**不要**把权责摊成四层讲机制。',
    '6. **跑完 ≠ 完成**：交付标记**单独放回话最后一行** —— 真交付了写一行「[完成]」；没干成 / 要雇主拍板，写「[受阻] 一句话原因」。**第一行留给结论**。平台只按这个标记判**卡**的状态：不写标记 = 卡不会进「待验收」；没做完不许写「[完成]」，不许替雇主宣布验收通过。',
    '7. **问进度只答台账、够答即回**：给状态 + 更新时间 + 在等谁；能答就先回，别为了补细节去翻源码 / 日志 / 历史。**手上的活超过 20 秒没结果，先打一行进度** —— 沉默会被当成卡死，他会来问，那次追问比这一行贵。',
    '8. **不空转**：这一轮能做的先做完再回话，不许以 "Next: …" 收尾。',
    '9. **红线**：删数据 / 无备份覆盖生产 / 对外发布 / 花钱 / 改范围或需求 → 先列清单请雇主拍板，再动手；',
    '   **例行部署 / 迁移 / 迭代（有备份、可回滚）是团队职责，直接做，不用等雇主拍板**（2026-11-12 用户：甲方只要结果）。',
    '10. **群里的 @ 是派活信号，双向生效（2026-11-12）**：人 @ 你就叫醒你；**你的回话里 @ 到谁，平台也会把谁叫起来**。',
    '   所以 @ 只有两种用法 —— 真让某人接活、真让某人看这段话；别在总结里随手 @ 一串人（每一下都是别人的一次真实开销）。',
    '   一条回话只接力**第一个**被 @ 的人，其余排队；同一个人不会被重复叫醒，刚叫你的人你 @ 他也不算数。',
  ].join('\n');
}

/**
 * **这一轮是问答还是做事**（2026-11-09 P5）：给任务合同一个提示，别让模型猜。
 *
 * 事故（pt-7c6d4229）：卡描述明明是一串问题（"能调用哪些 api / 是给特定数字员工的还是
 * 全员平权"），平台却按"做事"给了汇报模板 → 交回一份工作报告。这里用**问句词 vs 动作词**
 * 的粗判只做"提示"：判不准就返回 null，合同写"先判"，由模型自己定；判错也不会锁死行为。
 *
 * 口径：问句词多于动作词 → 'answer'；动作词多于问句词 → 'do'；两者都少/相当 → null。
 */
const QUESTION_RE = /[?？]|为什么|谁|什么|哪些|哪个|怎么|如何|是否|能不能|有没有|多少|归谁|属于|还是|吗|呢|\b(?:who|what|which|why|how|whether|can|could|is|are|do|does)\b/gi;
const ACTION_RE = /实现|改|修|写|做|部署|发布|提交|创建|新建|删除|清理|生成|画|设计|安装|配置|跑|验证|复现|重构|升级|迁移|合并|接入|拆分|上线|调整|替换|补充|换/g;

export function guessDeliveryKind(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  const q = (s.match(QUESTION_RE) ?? []).length;
  const a = (s.match(ACTION_RE) ?? []).length;
  if (!q && !a) return null;
  if (!a) return 'answer'; // 只是提问
  if (!q) return 'do'; // 只是动作
  if (q > a + 1) return 'answer';
  if (a > q + 1) return 'do';
  return null; // 混合：交给合同里的"先判"
}

/** 交付形态提示（任务合同里那一段；answer/do/未知三种写法） */
function deliveryShapeLines(kind) {
  if (kind === 'answer') {
    return [
      '- 交付形态：**问答** —— 用户在问问题：第一行直接给判断（顺利 / 有什么问题 / 卡在谁那儿），**不要交工作简报**。',
      '- 交付：答案本身（覆盖用户原话里每一问）；依据默认不写，命中契约第 3 条那三种情况才附。',
    ];
  }
  if (kind === 'do') {
    return [
      '- 交付形态：**做事** —— 用户要的是改动 / 产物：第一行给结果或卡点。',
      '- 交付：结果 / 卡点 + 这一轮已做的动作（≤3 行）；依据默认不写，命中契约第 3 条那三种情况才附（完整写法见 `bandi-report`）。',
    ];
  }
  return [
    '- 交付形态：先判 —— 问问题 → 直接答；要改动 → 给结果 / 卡点。',
    '- 交付：按【本轮契约】交付（问答先答问题，做事给简报）。',
  ];
}

/** 验收提示：按交付形态给判据；评论卡还要落到"按卡描述逐条验" */
function acceptanceLine(kind, commentCard) {
  const byKind =
    kind === 'answer'
      ? '用户原话里每一问都有直接回答，且第一行就是结论；把依据铺满、结论要人自己总结的，算没交付。'
      : kind === 'do'
        ? '第一行给结果或卡点、并说清要不要他动手；用过程代替结论的，算没交付。'
        : '用户原话里每一件事都有交代，且看完第一行知道要不要他动手。';
  return commentCard
    ? `- 验收：按【你正在办的任务卡】里的任务描述逐条验；${byKind}`
    : `- 验收：${byKind}`;
}

/**
 * **本轮任务合同**（2026-11-09 P1；P5 按交付形态分型）。
 *
 * 身份文本回答"我是谁"，但不该承担"这次做成什么样算完"——那是任务合同的事。
 * 三处来源各带一点信息，拼成这一轮的"合同"：
 *   · `card`（卡评论区派活 project.mjs 传；P5 起看板/群派活也传，带 `source:'board'|'group'`）：
 *     目标=卡标题、项目=卡项目、交付形态=从标题+描述粗判（问答/做事）、验收按形态判；
 *   · `workflow`（流程派活，dispatch 用 opts.taskId 现查 workflow_tasks）：节点名 + 第几次到站 + 本步要求；
 *   · `project`（普通聊天带了项目）：只补一句项目名，其余仍以用户原话为准。
 */
export function taskContractBlock({ card = null, workflow = null, project = null, tasks = [], delivery = null } = {}) {
  const lines = ['【本轮任务合同】'];
  const cardTitle = String(card?.title ?? '').trim();
  lines.push(`- 目标：${cardTitle ? `「${cardTitle}」` : ''}上面这条消息要办的事（用户原话为准，不扩范围）。`);
  const projectName = String(card?.projectName ?? project?.name ?? '').trim();
  if (projectName) lines.push(`- 项目：${projectName}`);
  if (workflow?.nodeName) {
    lines.push(`- 流程节点：${workflow.nodeName}${workflow.visit ? `（第 ${workflow.visit} 次到站）` : ''}`);
    const detail = String(workflow.detail ?? '').trim();
    if (detail) lines.push(`  - 本步要求：${detail.slice(0, 300)}${detail.length > 300 ? '…' : ''}`);
  }
  /*
   * 交付形态（2026-11-09 P5）：**这一轮要交什么**先定下来，别让所有任务都套工作报告。
   * card 带 source='board'/'group' 的是看板/群派活（没有"评论区"锚点块）；其余 card 是评论卡。
   */
  const kind = delivery ?? (card ? guessDeliveryKind(`${card.title ?? ''}\n${card.description ?? ''}`) : null);
  const commentCard = !!card && card.source !== 'board' && card.source !== 'group';
  lines.push(...deliveryShapeLines(kind));
  /*
   * 任务台账（2026-11-09 P3a）：把"他名下还在办的卡"每轮带进合同。
   * 问进度时他不需要任何工具就能答；也堵住"去仓库里 grep 源码找接口"这条错误路径。
   */
  if (tasks.length) {
    lines.push('- 你的任务台账（问进度先看这里，别去仓库里翻源码）：');
    for (const t of tasks) {
      const at = String(t.updatedAt ?? '').slice(0, 16).replace('T', ' ');
      lines.push(`  · ${t.id} · ${t.title} · ${t.status}${at ? ` · 更新于 ${at}` : ''}`);
    }
  } else {
    lines.push('- 你的任务台账：当前没有未完的卡（要查全部卡用运行钥匙调 GET /api/tasks）。');
  }
  lines.push('- 受众：雇主本人（不是同事）；他要看完能拍板。');
  lines.push(acceptanceLine(kind, commentCard));
  return lines.join('\n');
}

/**
 * 项目宪法注入块：给这个项目派活时，首轮 prompt 开头要带的那段。
 *
 * 宪法在**平台**上（projects.constitution，「项目 → 编辑」里维护），不往项目仓库发文件 ——
 * 所以注入也必须是**必然的**：在这儿的拼装点拼进去，两条派活链路（流程 / 任务卡）都从这里拿，
 * 谁也不许自己另写一份。
 *
 * 没写宪法就返回空串（不注水 —— 契约的规矩由节点 detail 与技能引用，不在每条消息里复读）。
 */
export function projectConstitutionBlock(projectId) {
  if (!projectId) return '';
  const p = store.getProject(projectId);
  const text = String(p?.constitution ?? '').trim();
  if (!text) return '';
  return [
    '【项目宪法】下面是本项目特有的硬约束。共通的干法以平台仓库 docs/契约.md 为准；',
    '宪法只许加码、不许减码 —— 与契约冲突时，以契约为准。',
    '',
    text,
  ].join('\n');
}


/**
 * 第一次发言时把员工设定带进去 —— 让会话从此记住这个人是谁。
 * 后续消息就只发用户原话，靠 runtime 自己的会话续接保持上下文。
 */
/**
 * 员工宪法（2026-11-09）：**全体员工通用**的工作基线，首轮注入，排在身份设定**之前**。
 *
 * 为什么必须有这一层（2026-11-09「数据管理 54.2M」事故复盘）：
 *   用户把一个测量问题（"数据管理 54.2M 是什么占的，用数据说话"）派给研发工程师，
 *   嘉辉 22 次工具调用全是 `cat store/*.mjs`，零次查库、零次 du —— 用"代码结构介绍"
 *   顶替了数据证据，最后还被验收栏盖了"活干完了"。复盘结论：**根源是身份设定的措辞
 *   承担了它不该承担的职责**——所有员工 instructions 都写着"别的不要揽/你只管三件事"，
 *   而平台没有任何对冲层，身份文本成了最高法律。
 *
 * 修法分两层（治本，不是修个案）：
 *   ① 这里加通用基线：测量优先、证据交付、缺条件不停摆、专长是顺序不是边界；
 *   ② 各员工出厂指令（experts.mjs / steward.mjs）把"别的不要揽"改写成专长表述。
 *
 * 为什么排第一、且声明"高于身份设定"：身份块接着就说"后续对话请一直保持"，
 * 权重天然拉满；不把宪法放在它前面并写明优先级，四条基线就会被"别的不要揽"压住。
 *
 * 为什么只在首轮注（firstTime）：宪法与身份一样是稳定文本，每轮重注只会白吃 token；
 * 首轮跟着身份走同一条成员会话生命周期（resetPersonaSessions 作废后重注）。
 */
export function constitutionBlock({ roleKey = '' } = {}) {
  const lines = [
    '【工作基线 · 平台注入，优先级高于下面任何身份设定里的"只管 / 不要揽"措辞】',
    '',
    '1. **测量优先**。凡"多少、多大、为什么涨、谁占的"这类问题，先用命令把分布量出来再回答。',
    '   代码结构说明回答的是"有什么"，不是"占了多少"——除非量过，或问题本身就在问结构。',
    '2. **证据兜底，不是默认**。凡"多少、多大、为什么涨、谁占的"这类**量化 / 归因**结论，要带可复现的证据（命令 + 输出）；',
    '   **进度、状态、有没有、能不能、归谁这类问题不必附证据** —— 直接给判断，他追问再给。跑过就是跑过，没跑就是没跑。',
    '3. **缺条件不停摆**。没权限、缺数据、工具被挡时，一次说清三件事：缺什么、你已经试过什么、',
    '   下一步有哪些选项（含"你来操作、我指路"的具体指令）。只回一句"没权限 / 你贴给我"不算完成回复。',
    '4. **专长是顺序，不是边界**。身份设定决定你先做好什么、以什么为常项，不限定你能接什么。',
    '   超出常项的活照接——先一句声明，做完照常给证据。确有**不可逆 / 要雇主担责**的（删数据、无备份覆盖生产、',
    '   对外发布、花钱、改范围或需求）才列清单请雇主确认；**例行部署 / 迁移 / 迭代（有备份、可回滚）是团队职责，直接做**。',
    '',
  ];
  /*
   * **统筹岗（项目经理）的特别约定**（2026-11-12 用户明确需求）：第 4 条是给执行岗的
   * （"专长是顺序不是边界，超常项照接"）；对项目经理，这条会被误读成"自己上手"的授权
   * （2026-11-11 实报：让 PM 更新 thinkpad，他 SSH 装 Maven 自己干，运维就在群）。
   *
   * 所以对管理岗在第 4 条之后**显式覆盖**：先分三类（信息咨询 / 派活 / 无对口岗位），
   * 只读查询可以自己做，有副作用的操作必须派出去。这是首轮注入；每轮还有 pmDispatchBlock 兜一层。
   */
  if (roleKey === 'pm') {
    lines.push(
      '5. **统筹岗的特别约定（项目经理，优先于第 4 条）**：你的交付是"判断 + 派活 + 验收"，不是自己执行。',
      '   · **信息咨询 / 进度查询**（谁手上有任务、项目进度、某张卡到哪了）：自己查台账/看板，直接回答；',
      '     **不建卡、不派活、不动手**；查不到就说查不到，别猜。',
      '   · **需要专业执行的活**（部署 / 写代码 / 做设计 / 测试 / 运维…）：建卡派给对应岗位的人。',
      '   · **团队里没有对应岗位的人**：直接汇报雇主"团队目前没有能干这个的人（缺 X 岗）"，',
      '     给一句建议；**不许自己顶上、不许凑合派给不对口的人**。',
      '   · **只读查询可以自己做**；任何**有副作用的操作**（写文件 / 改配置 / 部署 / 启停服务 /',
      '     登服务器动手）都必须派出去。',
      '   · **任务卡默认建 `todo`（待办）+ 执行人**（建完自动开跑），**不要建 `idea`（想法）让雇主点状态**；',
      '     「想法」只用于不可逆 / 花钱 / 对外 / 改范围。',
      '   · **你被雇主授权**：本项目内可逆、有回滚、不花钱、不对外、不改范围的执行动作，你直接定，不用请示。',
      '',
    );
  }
  return lines.join('\n');
}

export function buildDirectTask(thread, text, firstTime, skillLines = [], connLines = [], brief = '', roleKey = '') {
  if (!firstTime) return text;

  const parts = [];
  // 宪法必须在身份之前（见 constitutionBlock 注释：要压得住"后续对话请一直保持"的身份块）
  parts.push(constitutionBlock({ roleKey }));
  const rules = (thread.personaInstructions ?? '').trim();
  if (rules) parts.push('你在本次会话中的身份与职责设定如下（后续对话请一直保持）：', '', rules, '');
  if (skillLines.length) parts.push(...skillsBlock(skillLines));
  if (connLines.length) parts.push(...connectionsBlock(connLines));
  if (brief) parts.push(brief, '');

  if (!parts.length) return text;
  parts.push('---', '', '用户的第一条消息：', text);
  return parts.join('\n');
}

/** 只给「名字 + 一句话 + 路径」，正文让它按需去读 —— 渐进披露，别把 context 塞满。
 *  P5 补一句"技能是方法不是任务模式"：李俊那次就是被 brainstorming 的 "MUST use before
 *  any creative work" 劫持成创作模式的 —— 技能不能决定这一轮交什么。 */
function skillsBlock(lines) {
  return ['你的技能（是"怎么做"的方法，不是任务模式、不决定这一轮交什么；只在这轮需要时读正文）：', '', ...lines, ''];
}

/**
 * 插件接上的外部能力。
 * 这一段必须进首轮注入：codex 的外部工具在 tool_search 后面，不说一句它就不会去找。
 */
function connectionsBlock(lines) {
  return ['插件给你接上了这些外部能力（它们不在预置工具列表里）：', '', ...lines, ''];
}

/**
 * 随消息上传的附件（2026-10-23）：给**绝对路径**让员工自己读。
 * 为什么不给内容：文件可能几 MB、可能是二进制，塞 prompt 里既爆 token 又读不了；
 * 而 CLI 在本机跑，读文件是它的本职。图片也一样 —— codex 系能直接读图片文件。
 */
/**
 * 任务卡评论区的锚点（2026-10-23）：告诉员工"你在办哪张卡"。
 * 为什么每条都注：卡的**状态会变**（已阻塞/进行中/待验收…），首轮注一次就过时了；
 * 而且非首轮是原话直传，员工对卡的认知全靠会话记忆。真实事故（2026-10-23）：
 * 用户在卡评论区问"任务执行到什么进度了"，prompt 里没有卡的信息，
 * 员工去仓库里翻，翻到**另一个任务**的 PRD 就照着汇报 —— 问题必须能对上号。
 */
function taskCardBlock(card) {
  const lines = [
    '【你正在办的任务卡】下面这条消息来自这张卡的评论区 —— 用户的问题（包括问进度）问的都是**这张卡**；',
    '仓库里其他文档、其他任务/流程的进展与这张卡无关，不要拿来回答。',
    '',
    `- 卡片标题：${card.title}`,
  ];
  const desc = String(card.description ?? '').trim();
  if (desc) lines.push(`- 任务描述：${desc}`);
  if (card.projectName) lines.push(`- 所属项目：${card.projectName}`);
  if (card.status) lines.push(`- 卡片状态：${card.status}`);
  return lines.join('\n');
}

export function attsBlock(atts) {
  if (!Array.isArray(atts) || !atts.length) return '';
  const human = (n) =>
    n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
  return [
    '【用户随这条消息上传的文件】（已存在本机，直接用工具按路径读取；图片可以直接看）：',
    '',
    ...atts.map((a) => `- ${a.name}（${human(a.size ?? 0)}）：${a.path}`),
  ].join('\n');
}

/**
 * 一个员工实际能看到的工作根。
 * = 主工作目录（cwd，-C 传它） + 自己配的附加根 + **平台根（自动附加）**。
 * 平台根里放 skill，所以哪怕员工在别的项目里干活，也能读到 skill。
 *
 * 注意：只有切回沙箱模式后这串才有约束力；danger-full-access 下它没有效果。
 */
export function personaRoots(cwd, rootDirsJson) {
  let extra = [];
  try {
    const parsed = JSON.parse(rootDirsJson || '[]');
    if (Array.isArray(parsed)) extra = parsed.filter((s) => typeof s === 'string' && s.trim());
  } catch { /* 存坏了就当没有 */ }

  const seen = new Set();
  const out = [];
  for (const dir of [cwd, ...extra, repoRoot].filter(Boolean)) {
    const key = String(dir).replace(/[\\/]+$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out;
}

/** 1:1 会话的"成员"就是对面那个人，从 thread 行上拼出来，形状与群成员一致 */
export function directMember(thread) {
  return {
    personaId: thread.personaId,
    name: thread.personaName,
    runtime: thread.runtime,
    // **会话级覆盖优先**：波哥平时只读，这个会话给了他完全权限，就在这儿生效；
    // 没覆盖（null）→ 跟随员工默认 personaSandbox。
    sandbox: thread.sandbox ?? thread.personaSandbox,
    cwd: thread.personaCwd,
    // 模型同理：会话级覆盖优先（聊天面板那颗切换按钮写的就是它），
    // 没覆盖 → 跟随员工绑的；员工也没绑 → 由 cliModels.effectiveModelOf 回落到 CLI 自己的默认
    model: thread.model ?? thread.personaModel,
    instructions: thread.personaInstructions,
    roots: personaRoots(thread.personaCwd, thread.personaRootDirs),
  };
}

/**
 * 解析 @名字。按名字长度倒序匹配，避免「@李」把「@李俊」吃掉。
 * 返回命中的成员列表。
 */
export function parseMentions(text, members) {
  const hits = [];
  let rest = text;
  for (const m of [...members].sort((a, b) => b.name.length - a.name.length)) {
    const token = '@' + m.name;
    if (rest.includes(token)) {
      hits.push(m);
      rest = rest.split(token).join('');
    }
  }
  return hits;
}

/**
 * 规则：@ 谁谁干活（@ 了几个就按成员表顺序一个个来 —— 第一个当场派，其余排队，
 * 见 dispatchToThread）；没 @ 就跟**群助手**说话（群主是创建人，不接话）。
 * 一个会话同一时刻只跑一个 —— 同时跑会在同一个仓库改代码上打架。
 */
export function resolveTarget(thread, members, text) {
  if (thread.kind !== 'group') {
    return { member: members[0] ?? null, mentions: [] };
  }
  const mentions = parseMentions(text, members);
  if (mentions.length) return { member: mentions[0], mentions };
  const assistant = members.find((m) => m.personaId === thread.assistantPersonaId) ?? null;
  return { member: assistant, mentions: [] };
}

/**
 * 群任务：把「这个成员上次之后群里发生的事」喂进去。
 * 只喂增量（水位线之后），且不喂它自己说过的话（它自己的会话里已经有了）——
 * 否则每轮把整段群聊塞进 prompt，token 会爆。
 */
export function buildGroupTask({ thread, member, trigger, contextMessages, firstTime, skillLines = [], connLines = [], brief = '', roleKey = '' }) {
  const lines = [];

  if (firstTime) {
    lines.push(`你在一个项目群里。群名：${thread.title}`, '');
    // 宪法同样排在身份之前（同 buildDirectTask，见 constitutionBlock 注释）
    lines.push(constitutionBlock({ roleKey }));
    lines.push('你的职责与身份设定如下（后续对话请一直保持）：', (member.instructions ?? '').trim(), '');
    if (skillLines.length) lines.push(...skillsBlock(skillLines));
    if (connLines.length) lines.push(...connectionsBlock(connLines));
    if (brief) lines.push(brief, '');
  }

  if (contextMessages.length) {
    lines.push('以下是群里在你上次发言之后发生的事情（按时间顺序）：', '');
    for (const m of contextMessages) {
      const who = m.role === 'user' ? '用户' : (m.personaName || '成员');
      lines.push(`${who}：${m.text}`, '');
    }
    lines.push('---', '');
  }

  lines.push(trigger.text);
  return lines.join('\n');
}

/**
 * 群里 @ 多人的排队（2026-10-24）：一个会话一次只跑一个 —— 一条消息 @ 了几个人，
 * 第一个当场派，其余按顺序排队，前一个收尾时补派下一个（见 drainGroupQueue）。
 *
 * 队列只活在内存里：触发消息本身已落库（队里只记 rowid），服务重启没派出去的
 * 就随它去，人重发一条 @ 就行 —— 要"必须不丢"的派活走流程/任务卡，不在这儿。
 * 队里的条目不带流程字段（runId/taskId）：流程一轮只有一个经办人，排队的人走普通聊天作用域。
 */
const groupQueues = new Map(); // conversationId -> [{ member, opts, triggerRowid }]

/** 这个会话还排着几个没派的（冒烟测试用） */
export function queuedCountOf(threadId) {
  return groupQueues.get(threadId)?.length ?? 0;
}

/**
 * 派活前的两道并发闸。撞上了抛 'busy'：主派活路径在**落触发消息之前**先过一遍
 * （409 且不留半截消息）；排队补派在出队前再过一遍 —— 排队这段时间里情况可能已经变了。
 *
 *   · **个人闸**（2026-10-24 改）：跟人走 —— `personas.maxParallel`（界面上叫「并发数」），
 *     默认 6、最高 20
 *     （常量在 store/personas.mjs，界面上按员工配）。为什么**现查员工记录**而不是用
 *     会话快照：并发是资源属性不是身份属性，改了就该立刻生效，等下次建会话才生效没人说得清。
 *   · **项目闸**（2026-10-24 改）：从"同时只许一件"放开成安全网（PROJECT_RUN_CAP=20）
 *     —— 真正的限流在每个人身上，这里只挡"一群人把同一个目录塞满几十个进程"的病态堆积。
 *     同目录并行改代码的冲突风险由人承担（用户拿同类工具同项目多任务并行做的类比，2026-10-24）。
 */
const PROJECT_RUN_CAP = 20;

/*
 * 回复风格块（2026-10-24 雇主偏好，设置 → 偏好 → 回复风格）：选了非默认风格，
 * **每轮派活**都把对应技能的正文追加进任务 —— 不走 firstTime（那是会话第一节的事，
 * 走它的话切换要等会话重开才生效）；正文直接内联而不是给指针，省一次读文件、
 * 当轮就生效。默认风格返回空串，任务一个字都不多。
 */
export function stylePrefBlock() {
  const hit = REPLY_STYLES.find((x) => x.id === replyStyle());
  if (!hit?.skill) return '';
  const s = skills.getSkill(hit.skill);
  if (!s) return ''; // 技能文件被删了：宁可没风格，不让派活挂掉
  return `【回复风格 · 雇主设定】按下面的口径说话：\n\n${String(s.body).trim()}`;
}

function ensureDispatchable(member, opts = {}) {
  const cap = store.effectiveMaxParallel(store.getPersona(member.personaId));
  const running = store.countActiveRunsForPersona(member.personaId);
  if (running >= cap) throw fail(`他手上已经有 ${running} 件活在跑（并发数 ${cap}，可在他的资料里调），这件先排队`, 'busy');
  if (opts.projectId && store.countActiveRunsForProject(opts.projectId) >= PROJECT_RUN_CAP) {
    throw fail(`这个项目里同时已有 ${PROJECT_RUN_CAP} 件活在跑，先等一等`, 'busy');
  }
}

/**
 * 从"目标已定、闸已过"到"起跑"的公共段：目录派活与排队补派共用，谁也不许另写一份。
 * `trigger` 是已落库的触发消息（主路径刚 addMessage 的；补派是按 rowid 取回来的原消息）。
 *
 * 注意水位线在**补派那一刻**才算：排队的人能看到他前面那个人已经回进群里的东西。
 */
function startMemberRun(thread, member, opts, trigger) {
  const threadId = thread.id;

  // 群成员是从 thread_members 来的，形状与 directMember 一致；这里统一补上工作根与技能清单
  member.roots = personaRoots(member.cwd, member.rootDirs);

  // **项目覆盖**：流程发起时选了项目，这一步就在那个目录里干活 ——
  // 而不是员工自己那个默认 cwd（六个员工都指着同一个目录，一有第二个项目就乱套）。
  // 放在 personaRoots 之后，让它赢。
  if (opts.projectId) {
    const roots = store.projectRoots(store.getProject(opts.projectId));
    if (roots?.length) {
      member.cwd = roots[0];
      member.roots = roots;
    }
  }
  const skillLines = skills.skillDigest(store.listPersonaSkills(member.personaId));
  // 连接器：按这个成员绑定的运行时所属协议族取，首轮注入里告诉它"你有这些外部能力、怎么找"
  const family = runtimes.resolveForRun(member.runtime ?? 'codex')?.family ?? null;
  const connLines = family ? connectors.promptLines(family) : [];
  /*
   * 首轮注入的两段"brief"：
   *   · 内置秘书多一段「机器现状」。**只给内置的**：普通员工不该被塞平台的端口和路径，
   *     那是噪音。现取不缓存 —— 端口/数据目录一变，这句话就得跟着变。
   *   · 项目经理多一段「建卡通道」（2026-10-24）：他的活就是把活立成卡、派出去、盯到验收，
   *     不告诉他通道在哪，权限就是空话。钥匙在环境变量里（BANDI_RUN_TOKEN），run 收尾作废。
   */
  const p = store.getPersona(member.personaId);
  let brief = [
    p?.builtin ? steward.stewardBrief() : '',
    p && can(p, 'card.create') ? pmCardBrief() : '',
  ].filter(Boolean).join('\n\n');

  // **这次派活属于哪个 session 作用域**：带流程 runId → 这条流程实例自己的一条
  // 全新会话；手动聊天 → 普通作用域，照旧续接。
  const sessionScope = sessionScopeOf(opts);

  // 这个作用域下他有没有自己的会话 + 他读到哪儿了
  let ms = store.getMemberSession(threadId, member.personaId, sessionScope);
  /*
   * **上下文预算 / 会话轮换**（2026-11-11 实报）：同一段 CLI 会话跑太久，上下文越滚越大，
   * 最后模型把工具调用写成正文、空回话（群「爻鉴」r-f0512961：会话 8 小时、累计 3000 万 input）。
   * 超限就作废这条 sessionId → 下一轮按 firstTime 重开，并把最近几条消息作为「交接」带过去。
   * 判据见 session-budget.mjs（轮数 / 年龄 / 累计 tokens / 单轮上下文，四个都可 env 覆盖）。
   */
  let rotated = null;
  if (ms?.sessionId) {
    const startedMs = ms.startedAt ? Date.parse(ms.startedAt) : 0;
    const recent = store.listRecentRunUsage(threadId, member.personaId, 2);
    const verdict = shouldRotate({
      rounds: startedMs ? store.countRunsSince(threadId, member.personaId, ms.startedAt) : 0,
      ageMs: startedMs ? Date.now() - startedMs : 0,
      usage: recent[0]?.usage ?? null,
      prevUsage: recent[1]?.usage ?? null,
    });
    if (verdict.rotate) {
      const why = verdict.reasons.join('；');
      console.log(`[会话预算] 轮换 ${member.name ?? member.personaId}@${threadId}/${sessionScope || '默认'}：${why}`);
      store.setMemberSession(threadId, member.personaId, null, sessionScope, '');
      /*
       * 聊天里留一行灰字（2026-11-11 用户：「这事太小，直接在聊天里加一行灰字就可以，不要通过信箱发我」）：
       * 同一段聊天里换掉了他内部的上下文，人得知道为什么他突然忘了早前的事。
       * 落一条 role=system + meta 的消息，由 chat.mjs 画成居中灰字（不占气泡、不算回话）。
       */
      try {
        store.addMessage({
          conversationId: threadId,
          role: 'system',
          text: '（上下文过长，已开新会话；最近进展已交接）',
          meta: { type: 'session-rotated', reasons: verdict.reasons },
        });
      } catch { /* 记不上也不影响派活 */ }
      rotated = verdict.reasons;
      ms = store.getMemberSession(threadId, member.personaId, sessionScope) ?? null;
    }
  }
  if (rotated) brief = [sessionHandoffBlock(thread, rotated), brief].filter(Boolean).join('\n\n');
  // 水位线（"他读到哪条消息了"）**不跟着 session 作用域走**：它记的是这个人在
  // 这个会话里的阅读位置，跟 runtime 有没有另开一条会话是两件事。流程作用域下
  // 要看主行，否则新流程会以为"他什么都没读过"，把整段群历史灌进 prompt。
  const base = sessionScope ? store.getMemberSession(threadId, member.personaId, '') : ms;
  const watermark = base?.lastSeenRowid ?? 0;
  // 这个作用域下没有 sessionId = 他这儿要开一条**全新会话**（顺带重注入职责与技能）
  const firstTime = !ms?.sessionId;

  // **讨论模式 = 只读沙箱**（2026-10-19 用户定）：卡片评论分三档，其中「讨论」只聊不动手。
  // 这里把员工的沙箱临时盖成 `plan`（统一语义），runs 里 `normalizeSandbox` 会按运行时族
  // 换算成各族自己的只读写法（codex `read-only` / claude `plan`）。不传 = 员工默认（可写）。
  if (opts.sandbox) member.sandbox = opts.sandbox;

  const task = thread.kind === 'group'
    ? buildGroupTask({
        thread,
        member,
        trigger,
        firstTime,
        skillLines,
        connLines,
        brief,
        roleKey: member.roleKey ?? '',
        contextMessages: store
          .listMessagesSince(threadId, watermark, trigger.id)
          .filter((m) => m.personaId !== member.personaId),
      })
    : buildDirectTask(thread, trigger.text, firstTime, skillLines, connLines, brief, p?.roleKey ?? '');

  // 附件（2026-10-23）：文件已落在本机 uploads/ 下 —— 告诉员工绝对路径让它自己读。
  // CLI 的沙箱只限**写**，读全盘不受限，给路径就够了。
  const attBlock = attsBlock(opts.atts);
  // 任务卡锚点（2026-10-23）：卡评论区派活必须带上"你在办哪张卡"，问进度才不会答偏。
  // P5（2026-11-09）：看板/群派活也把卡带进合同（目标/验收更准），但**不加**"来自评论区"
  // 这个锚点块 —— 那是评论场景专用的，加到看板派活上会说错场景。用 source 区分。
  const cardBlock = opts.card && opts.card.source !== 'board' && opts.card.source !== 'group' ? taskCardBlock(opts.card) : '';
  /*
   * **每轮都注入的「平台契约 + 任务合同」**（2026-11-09 检修 P0/P1）。
   *
   * 以前这两样只活在前缀里：汇报口径写在 PM 首轮 brief、证据纪律写在身份文本；
   * 默认形态下每轮只剩用户消息 → 模型拿首轮身份当行为法。现在改成每轮都在，
   * 身份文本只回答"我是谁"。合同带结构化上下文：卡（标题/项目/按描述验收）、
   * 流程（节点名/第几次到站/本步要求）、普通聊天（项目名）。
   * 顺序放在雇主风格之后：风格可以改口吻，但契约是底线。
   */
  const workflowTask = opts.taskId ? store.getWorkflowTask(opts.taskId) : null;
  const project = !opts.card?.projectName && opts.projectId ? store.getProject(opts.projectId) : null;
  // 他名下未完的卡：问进度时先看这里（2026-11-09 P3a，跨会话也不丢上下文）
  const myTasks = store.listMyOpenTasks(member.personaId, 5);
  // 统筹职责（2026-11-11）：只给有建卡权限的岗位（项目经理）——每轮都注入，见 pmDispatchBlock
  const pmBlock = p && can(p, 'card.create') ? pmDispatchBlock({ persona: p, thread, project }) : '';
  const contractBlock = [
    platformContractBlock(),
    pmBlock,
    taskContractBlock({ card: opts.card, workflow: workflowTask, project, tasks: myTasks }),
  ].filter(Boolean).join('\n\n');
  const fullTask = [cardBlock, task, attBlock, stylePrefBlock(), contractBlock].filter(Boolean).join('\n\n');

  const run = runs.startRun({
    thread,
    member,
    task: fullTask,
    watermark: trigger.rowid,
    workflowTaskId: opts.taskId ?? null,
    // 把作用域带进执行层：sessionId 按 (会话 × 人 × 作用域) 存取
    sessionScope,
    // 项目归属要记在 run 上（项目安全网按它数并发，见 ensureDispatchable）
    projectId: opts.projectId ?? null,
  });
  // 接力账本（见 dispatchReplyMentions）：这次跑是第几跳、被谁叫醒的
  runChain.set(run.id, {
    depth: opts.chainDepth ?? 0,
    from: opts.fromPersonaId ?? null,
    triggerRowid: trigger.rowid,
  });
  markBatch(trigger.rowid, [member.personaId]);
  return run;
}

/**
 * 排队补派：会话空出来且队头的人闸也过了，就派下一个。
 * 两个触发点（server.mjs）：run 收尾钩子（主流）+ 30 秒节拍（兜底，接住撞了
 * 项目互斥/个人并发而退回的）。返回刚起的那次 run；没派（队空/在跑/撞闸）返回 null。
 */
export function drainGroupQueue(threadId) {
  const q = groupQueues.get(threadId);
  if (!q?.length || store.activeRun(threadId)) return null;
  const entry = q[0];
  const thread = store.getConversation(threadId);
  if (!thread) {
    groupQueues.delete(threadId);
    return null;
  }
  const shift = () => {
    q.shift();
    if (!q.length) groupQueues.delete(threadId);
  };
  try {
    ensureDispatchable(entry.member, entry.opts);
    const trigger = store.getMessageByRowid(threadId, entry.triggerRowid);
    if (!trigger) throw new Error('触发消息已经不在了');
    const run = startMemberRun(thread, { ...entry.member }, entry.opts, trigger);
    shift();
    console.log(`[群聊] 排队补派：@${entry.member.name} 开跑（还排着 ${q.length} 个）`);
    return run;
  } catch (e) {
    if (e?.code === 'busy') return null; // 还没轮到/闸没过 —— 留在队里等下一拍
    // 真失败（触发消息没了之类）：丢弃这一个并在日志里说清，后面的照常补派
    shift();
    console.error(`[群聊] 排队补派失败，跳过 @${entry.member.name}：${e?.message ?? e}`);
    return null;
  }
}

/** 所有有排队的会话都试一遍（节拍兜底用） */
export function drainAllGroupQueues() {
  let started = 0;
  for (const id of [...groupQueues.keys()]) {
    if (drainGroupQueue(id)) started += 1;
  }
  return started;
}

/* ---------------------------------------------------------------- 成员回复接力（2026-11-12）
 *
 * 实报：贺韬在群里 @马超 派活，马超一动不动 —— 库里 0 run、0 通知。
 * 原因不是谁偷懒：派活只认「**人**发的消息」（POST 那个入口）与卡票回执，
 * 成员自己的回复落库之后根本没人扫 @（runs.mjs 里一条 mentions 处理都没有）。
 * 而合同（下面的 pmDispatchBlock）白纸黑字写着「在群里 @ 具体执行人接活」——
 * 合同让人去 @，引擎不认 @，那句合同就是在教人喊空气。
 *
 * 所以补上接力：**群里成员的回复里 @ 到的成员，会被唤醒**。
 *
 * 三条防环，缺一条就会两个 agent 自己聊到天亮（它们的回复里天然带着对方的名字）：
 *   ① **跳数上限**（默认 2）：人发消息 = 第 0 跳，A 的回话能叫醒 B（1 跳），
 *      B 的回话能叫醒 C（2 跳），到顶就停。`BANDI_CHAIN_DEPTH=0` 可整体关掉；
 *   ② **不回打**：刚叫醒你的那个人，你这轮 @ 他不算数 —— A@B 之后 B@A 这种乒乓，
 *      在真群里就是一句"收到"，没有新信息；
 *   ③ **一条回复只接力一次**，且只认第一个 @ 到的人；其余进群队列（沿用 @ 多人的排队），
 *      不并发、不抢同一段群聊。
 *
 * 唤醒**只入队不直接起跑**：接力发生在上一轮收尾那一刻，会话还占着；
 * 交给 `drainGroupQueue`（run 收尾钩子 + 30 秒节拍）去做并发判定与补派，
 * 与"@ 多人"走完全相同的路 —— 两套并发判定迟早打架。
 */
const CHAIN_MAX_DEPTH = Number.isFinite(Number(process.env.BANDI_CHAIN_DEPTH))
  ? Number(process.env.BANDI_CHAIN_DEPTH)
  : 2;
const runChain = new Map(); // runId -> { depth, from, triggerRowid }（内存级：重启后接力链从 0 重算，这是有意的）

/*
 * **同一批人**（2026-11-12，实跑出来才发现的噪声）：一条消息 @ 了几个人，他们就拿到了
 * 同一份上下文 —— 其中一个人回话时 @ 另一个人（"沈丹青那边做A，我做了B"这种引用），
 * 把刚跑完、已经看过同一份任务的人再叫一遍，纯属浪费。
 * 所以记一笔「这条触发消息派过谁」，接力时跳过同一批的人。
 */
const dispatchBatch = new Map(); // triggerRowid -> Set<personaId>
const BATCH_KEEP = 200;
function markBatch(triggerRowid, personaIds) {
  if (!triggerRowid || !personaIds?.length) return;
  const set = dispatchBatch.get(triggerRowid) ?? new Set();
  for (const id of personaIds) if (id) set.add(id);
  dispatchBatch.set(triggerRowid, set);
  while (dispatchBatch.size > BATCH_KEEP) dispatchBatch.delete(dispatchBatch.keys().next().value);
}

/** 取这次 run 的接力账（取完即焚：一条回话只用一次账） */
export function runChainOf(runId) {
  const v = runChain.get(runId);
  runChain.delete(runId);
  return v ?? { depth: 0, from: null, triggerRowid: null };
}

/**
 * 一条**成员回复**落下之后：看它 @ 了谁，把那个人排进群队列。
 *
 * 返回 `{ queued, personaId }`（进了队列）或 `null`（不是群 / 没 @ 到人 / 到顶）。
 * 不抛错 —— 调用方是"回复已经落库"的收尾路径，接力失败不该把这一轮判成失败。
 */
export function dispatchReplyMentions({ threadId, fromPersonaId, message, text, chain = {} } = {}) {
  const thread = store.getConversation(threadId);
  if (!thread || thread.kind !== 'group') return null;

  const depth = chain.depth ?? 0;
  if (depth >= CHAIN_MAX_DEPTH) {
    console.log(`[接力] 到顶（${depth} 跳 / 上限 ${CHAIN_MAX_DEPTH}），不再喊人（会话 ${threadId}）`);
    return null;
  }

  const members = thread.members ?? [];
  const batch = chain.triggerRowid ? dispatchBatch.get(chain.triggerRowid) : null;
  const hits = parseMentions(String(text ?? ''), members).filter(
    (m) => m.personaId !== fromPersonaId && m.personaId !== chain.from && !batch?.has(m.personaId),
  );
  if (!hits.length) return null;

  const [target, ...rest] = hits;
  // 触发消息就是**刚落下那条回复**：被叫醒的人从它开始读（水位线 = 它的 rowid），
  // 不需要再往群里塞一条"替贺韬说话"的假用户消息 —— 那会让同一句话在界面上出现两遍。
  const triggerRowid = message?.rowid;
  if (!triggerRowid) return null;

  const baseOpts = withGroupProject(thread, { chainDepth: depth + 1, fromPersonaId });
  const q = groupQueues.get(threadId) ?? [];
  // 同一个人已经排着就不再重复排（agent 爱把对方名字连写两遍）
  for (const m of [target, ...rest]) {
    if (m.personaId === fromPersonaId) continue;
    if (q.some((e) => e.member.personaId === m.personaId)) continue;
    q.push({
      member: { ...m },
      opts: { ...baseOpts, runId: null, taskId: null },
      triggerRowid,
    });
  }
  groupQueues.set(threadId, q);
  console.log(
    `[接力] ${fromPersonaId} 的回话 @${target.name} → 进队列（第 ${depth + 1} 跳，会话 ${threadId}，排 ${q.length} 个）`,
  );
  drainGroupQueue(threadId); // 会话要是已经空了就当场起跑，不白等一拍
  return { queued: true, personaId: target.personaId };
}

/*
 * 订阅"回话已落库"。挂在这里而不是 server.mjs：这是派活模块自己的规则，
 * 挂到进程装配处的话，凡是直接 import dispatch 的入口（工作流、冒烟）就漏了。
 */
runs.onReplyPersisted(({ run, message, text }) => {
  const chain = runChainOf(run.id);
  dispatchReplyMentions({
    threadId: run.conversationId,
    fromPersonaId: run.personaId,
    message,
    text,
    chain,
  });
});


/**
 * 群挂了项目 = 这个群的派活默认在那个项目里干（2026-11-11 用户拍板「一项目一群」）。
 *
 * 为什么在这里补、而不是只在前端传：群里派活有**好几条入口**（聊天框 @、流程回复、
 * 卡票回执走 dispatchEventToThread —— 它最后也进 dispatchToThread、队列补派），
 * 每处各写一遍迟早漏一处。补在入口这一层，`ensureDispatchable`（项目并上限）、
 * `startMemberRun` 的 cwd 覆盖、`projectConstitutionBlock` 的宪法注入就自动同源。
 *
 * **显式优先**：调用方已经带了 projectId（流程实例选了项目）就原样返回 ——
 * 流程是比"群默认"更强的意图；群没关联项目也不传，行为与从前一字不差。
 *
 * 导出是给 `smoke-group-project.mjs` 验这条规则用的（起真 agent 派活太慢，规则本身是纯函数）。
 */
export function withGroupProject(thread, opts) {
  if (opts?.projectId || thread?.kind !== 'group' || !thread.groupId) return opts;
  const g = store.getGroup(thread.groupId);
  return g?.projectId ? { ...opts, projectId: g.projectId } : opts;
}

/**
 * 往某个会话派一次活。
 * 返回 `{ run, member, mentions, queued }`；派不出去抛错（err.code: busy / bad）。
 * `queued` = 这条消息 @ 了但**还没派**的人（群里 @ 多人时排队等前一个跑完）。
 *
 * `opts.runId` = 这条消息属于哪条流程（工作流派的活 / 你在流程卡片上回复）。
 * **群里有好几条流程在跑的时候就靠它归属**，不靠"谁在什么时候说了什么"去猜。
 */
export function dispatchToThread(threadId, text, opts = {}) {
  const thread = store.getConversation(threadId);
  if (!thread) throw fail('会话不存在');

  // 群挂了项目 → 这次派活就在那个项目里干（见 withGroupProject）
  opts = withGroupProject(thread, opts);

  if (store.activeRun(threadId)) throw fail('他还在跑上一条，等它说完', 'busy');

  const isGroup = thread.kind === 'group';
  const members = isGroup ? thread.members : [directMember(thread)];
  if (!members.length) throw fail('这个会话没有可干活的成员');

  // 规则：@ 谁谁跑；没 @ 跑群助手
  const { member, mentions } = resolveTarget(thread, members, text);
  if (!member) throw fail(isGroup ? '群里没有群助手' : '这个会话没有绑定员工');

  // @ 多人：只有第一个当场派，其余排队（队里不带流程字段，见 groupQueues 的注释）。
  // 单人/没 @ 时 waiting 为空，行为与从前一字不差。
  const waiting = isGroup ? mentions.slice(1) : [];
  // 闸在**落消息之前**过：撞了 busy 就 409，群里不留一条没人接的消息
  ensureDispatchable(member, opts);

  const trigger = store.addMessage({
    conversationId: threadId,
    role: 'user',
    text,
    runId: opts.runId ?? null,
    // 这一步的标记：显示往来的唯一依据（别再用时间窗口切 1:1 会话，
    // 那会把共用这个会话的别的流程的派活也捞进来）
    taskId: opts.taskId ?? null,
    // 评论区的议题归属（2026-10-18）：回复挂在哪个顶层议题下。
    // 他的回话也会跟着这条（见 runs.mjs 里按 runId 找触发消息那一段）。
    parentId: opts.parentId ?? null,
    // 随消息上传的附件清单（2026-10-23）：文件本体已在 <dataDir>/uploads/<会话>/ 下
    atts: opts.atts ?? null,
    // 结构化元数据（2026-10-24 卡票）：卡片回执这类"说的是某张卡"的消息带上
    // {type:'card', cardId, …快照}，界面在气泡里画一张可点的卡票
    meta: opts.meta ?? null,
    // 说话的是哪个人（2026-10-31）：浏览器派活的带 auth.actorUser；流程/回执链路不传 = null
    senderUserId: opts.senderUserId ?? null,
  });

  const run = startMemberRun(thread, member, opts, trigger);

  if (waiting.length) {
    groupQueues.set(threadId, [
      ...waiting.map((m) => ({ member: { ...m }, opts: { ...opts, runId: null, taskId: null }, triggerRowid: trigger.rowid })),
    ]);
  }
  return {
    run,
    member,
    mentions,
    queued: waiting.map((m) => ({ personaId: m.personaId, name: m.name })),
  };
}

/**
 * 系统事件的派活（2026-10-24）：卡片回执这类"平台替雇主说话"的通知。
 *
 * 跟 dispatchToThread 的两点不同：
 *   · **消息必落库** —— 正常派活撞 busy 时消息根本不落（409 且不留半截），
 *     但回执是给雇主看的事实记录，不能因为建卡人正忙就丢：落库后进群队列，
 *     等会话空出来补派（drainGroupQueue 由 run 收尾钩子与 30 秒节拍驱动）；
 *   · **不抛错** —— 会话没了 / 目标人不在成员里，只记日志返回 null。
 *     回执是尽力而为：卡的状态本身已经落库，不欠这条消息一个 throw。
 *
 * `opts.personaId` 指定唤醒谁；群聊靠文本里的 `@名字` 命中（resolveTarget 的规矩）。
 * 返回 `{ run }`（当场起跑）或 `{ run: null, queuedLater: true }`（进了队列）；派不了返回 null。
 */
export function dispatchEventToThread(threadId, text, opts = {}) {
  const thread = store.getConversation(threadId);
  if (!thread) {
    console.warn(`[回执] 会话已经不在了，跳过（${threadId}）`);
    return null;
  }
  const members = thread.kind === 'group' ? thread.members : [directMember(thread)];
  if (!members.some((m) => m.personaId === opts.personaId)) {
    console.warn(`[回执] 目标人不在会话成员里，跳过（会话 ${threadId}，人 ${opts.personaId}）`);
    return null;
  }
  try {
    return dispatchToThread(threadId, text, opts);
  } catch (e) {
    if (e?.code !== 'busy') {
      console.error(`[回执] 派发失败（会话 ${threadId}）：${e?.message ?? e}`);
      return null;
    }
    // 忙：回执消息照落，唤醒进群队列等补派
    try {
      const trigger = store.addMessage({
        conversationId: threadId,
        role: 'user',
        text,
        runId: null,
        taskId: opts.taskId ?? null,
        parentId: null,
        atts: null,
        meta: opts.meta ?? null, // 卡票元数据走同一条路（见 dispatchToThread 那条 addMessage）
      });
      const member = members.find((m) => m.personaId === opts.personaId);
      const q = groupQueues.get(threadId) ?? [];
      q.push({ member: { ...member }, opts: { ...opts, runId: null, taskId: null }, triggerRowid: trigger.rowid });
      groupQueues.set(threadId, q);
      console.log(`[回执] 建卡人正忙，已进队列等补派（会话 ${threadId}，排 ${q.length} 个）`);
      drainGroupQueue(threadId); // 现在就试一把：很多"忙"是会话层的，这会儿可能已经空了
      return { run: null, queuedLater: true };
    } catch (e2) {
      console.error(`[回执] 落消息失败（会话 ${threadId}）：${e2?.message ?? e2}`);
      return null;
    }
  }
}
