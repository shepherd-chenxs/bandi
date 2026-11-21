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
/*
 * 拆出去的两块（2026-11-19）：合同拼装与 @ 解析各自独立成文件，这里**原样再导出** ——
 * routes/*、workflows、feishu、scheduler 等十来处 import 的是 './dispatch.mjs'，
 * 路径与签名一个都不变（barrel）。内部还要用到的那几个，另外 import 一份给本文件用。
 */
import {
  platformContractBlock,
  repoBriefBlock,
  gitStateBlock,
  taskContractBlock,
  constitutionBlock,
  stylePrefBlock,
  buildDirectTask,
  skillsBlock,
  connectionsBlock,
  taskCardBlock,
  attsBlock,
} from './dispatch/contract.mjs';
import { personaRoots, directMember, resolveTarget, parseMentions } from './dispatch/routing.mjs';

export {
  platformContractBlock,
  repoBriefBlock,
  gitStateBlock,
  guessDeliveryKind,
  taskContractBlock,
  constitutionBlock,
  buildDirectTask,
  attsBlock,
  skillsBlock,
  connectionsBlock,
  taskCardBlock,
  stylePrefBlock,
} from './dispatch/contract.mjs';
export { personaRoots, directMember, parseMentions, resolveTarget } from './dispatch/routing.mjs';

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
    '- 项目 id **可省略**：群派活默认用群关联的项目；',
    '- 每张卡带稳定的 idempotencyKey（同一件事重发只建一张）。',
    '- **assignee 填员工 id**（p- 开头；GET /api/state 的 personas 或 GET /api/personas 能查到），',
    '  **不是名字** —— 填名字会撞 E2059「执行人不存在」（2026-11-15 实报：贺韬为此建了',
    '  一张 test card 试通道，白跑一轮嘉辉）。名字 → id：先查一次花名册再建卡。',
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
    `卡的管理你有权限：PATCH ${controlUrl}/api/projects/tasks/<卡id>（可改 status / description / assigneePersonaId；带 startNow:true = 重跑；note 写一句理由，会追加进卡描述）—— 只对你建的卡、或你当群助手那张团队卡；范围、验收标准、流程归属仍归雇主（面板上改）。`,
    '**你被派的卡**（人建的、执行人是你）：干完 → `PATCH /api/projects/tasks/<id>`，体只放 `{"status":"review"}`，把卡上报成「待验收」。这是比回话标记更硬的一次上报；`[完成]` 那行仍要写（两条腿都要）。`done` 只有派活的人能点。',
    '**开了 PR 就挂到卡上**：`POST /api/projects/tasks/<id>/pr`，体 `{"url":"https://github.com/o/r/pull/12"}` —— 回话里贴链接**平台读不到**，卡上没有 PR 号，验收人和巡检就都看不见证据（实报：执行人两轮说"PR 已开"，卡上一直是空的）。挂上之后 PR 状态与 CI 结论会自动回填。**合并 PR 只能人来点**，你调 `/merge` 会被 403。',
    '**退回卡要带理由**：`{"status":"todo","startNow":true,"note":"缺什么"}` —— 不带 note 的退回等于让人重新猜（`note` 以 `[退回]` 追加进描述，不覆盖原验收标准）。',
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

export function pmDispatchBlock({ persona, thread, project } = {}) {
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
    '   A. **信息咨询 / 进度查询**（"谁手上有任务""项目成员进度""某张卡到哪了""现在什么情况了"，或纯闲聊）',
    '      → **必须先 GET 一次台账再答**（`GET /api/tasks` 看卡状态与最近一轮何时收的）：',
    '      「在跑 / 已完成」是**此刻的事实**，不是你上一句话的记忆 —— 你几分钟前说"已重新开跑"，那一轮可能早就在分钟级结束了。',
    '      **一次接口都没调就报状态 = 编**（2026-11-19 实报：卡明明挂「已阻塞」，你复述 08:28 的旧话"已重新开跑，在等他补交证据"，雇主对着截图问你）。',
    '      不建卡、不派活、不动手；查不到就说查不到，别猜。',
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
    '   **退回重跑后它还会再报一次回执**（回执带「第 N 轮」+ 本轮起跑/收尾时刻 + runId）：那是**新的结果**，不是上一条被重发 —— 别回一句"我上次已处理"就收工（2026-11-19 实报，卡就停在那儿没人管）。',
    '6. **补卡**：通道恢复后，把这段时间群里已经干完/卡住的活补成卡（backfill:true + 实际状态），让看板账对得上；补记不重跑。',
    '7. **派下一张卡不用请示（2026-11-14 甲方口径）**：方案定了 / 评审过了 → 直接建卡派给下游（第 1 条），这是统筹本职；**建卡轮的回话一行即止**——卡票已经把「建了什么 / 派给谁 / 什么状态」说给雇主了，再发一条"已安排 / 设计师正在…"的叙述 = 重复（2026-11-15 实报：建了卡又发一段安排说明，雇主：任务卡我能看到，这些不必再说）。最多补一句卡上没有的关键取舍。设计稿、方案 doc 是给执行人和看板用的，不是给雇主的功课。',
  ].join('\n');
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

  /*
   * 群主（真人雇主）的显示名：每轮都带（2026-11-16 用户："这种要我决策的事情，要@我"）。
   * 续接的会话不会重放 firstTime 的身份块，名字只放那儿会漏；契约第 9/10 条要求拍板时
   * @ 雇主，这里就得让他知道雇主叫什么。群主的 @ 不走叫醒（真人不在群成员表里），
   * 只是让他在群里一眼看到"这条在叫我"。ownerUserId 常是占位 'local-user'，退回"群主"。
   */
  const owner = thread.ownerUserId ? store.getUser(thread.ownerUserId) : null;
  const ownerName = String(owner?.nickname ?? owner?.name ?? '').trim();
  lines.push(ownerName
    ? `群主（你的雇主）是真人「${ownerName}」：需要他拍板 / 决策 / 确认时，回话里写 @${ownerName} 叫他，别只写"你定 / 等你拍板"。`
    : '群主（你的雇主）是真人：需要他拍板 / 决策 / 确认时，回话里 @ 群主叫他，别只写"你定 / 等你拍板"。', '');

  if (contextMessages.length) {
    lines.push('以下是群里在你上次发言之后发生的事情（按时间顺序）：', '');
    for (const m of contextMessages) {
      const who = m.role === 'user' ? (ownerName || '群主') : (m.personaName || '成员');
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
  // **会话级权限覆盖**（2026-11-14 群聊输入框加了权限下拉）：群也存 conversations.sandbox。
  // 群里成员可能跨运行时，存的是**通用三档**（danger-full-access / workspace-write / read-only），
  // runs 里 `normalizeSandbox` 会按每个人自己的运行时族换算（claude 那边对应
  // bypassPermissions / acceptEdits / plan）。程序化的 opts.sandbox（讨论模式）优先级更高 ——
  // 它是安全约束，不该被会话提权顶掉。1:1 那条路 directMember 已带同款覆盖，这里重写一次等值。
  // sandboxFromConv 是给 runs 的记号：提权后要在任务里说一句"权限已更新"——
  // 不然续接的会话里躺着早前的"权限不足"提醒，员工照旧账继续自报跑不动（李俊实报）。
  else if (thread.sandbox) {
    member.sandbox = thread.sandbox;
    member.sandboxFromConv = true;
  }

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
  const workflowTask = opts.taskId ? store.getWorkflowTaskById(opts.taskId) : null;
  const project = !opts.card?.projectName && opts.projectId ? store.getProject(opts.projectId) : null;
  // 他名下未完的卡：问进度时先看这里（2026-11-09 P3a，跨会话也不丢上下文）
  const myTasks = store.listMyOpenTasks(member.personaId, 5);
  // 统筹职责（2026-11-11）：只给有建卡权限的岗位（项目经理）——每轮都注入，见 pmDispatchBlock
  const pmBlock = p && can(p, 'card.create') ? pmDispatchBlock({ persona: p, thread, project }) : '';
  /*
   * **不变量拆分**（2026-11-15，借鉴 Cumora 的 out-of-band standing prompt）：
   * 平台契约 + PM 统筹块是**每轮一模一样**的不变量，却一直混在任务文本里 ——
   * resume 会话下它随历史越积越多，每轮还全价重发。拆出来单独传：
   * claude 族走 `--append-system-prompt-file`（out-of-band，稳定前缀吃得进缓存）；
   * codex / dsh 没有等价 flag，由 runs 按族原样拼回（行为不变）。
   * 动态部分（本轮活 / 台账 / 卡 / 风格）照旧走任务文本。
   */
  // 仓库地图：不给它结构，它每次都要从 0 摸一遍（2026-11-19 两次"只会查、不会答"的实报）
  const repoBrief = repoBriefBlock(member.cwd || repoRoot);
  /*
   * 仓库状态（2026-11-19 六改）：雇主问「本地和仓库一致吗 / 要不要建 PR」，
   * 它拿"工作区干净 + 与同名分支同步 + 没 open PR"答了"一致"，而分支上躺着一个没进 main 的提交。
   * 这三样都回答不了那个问题 —— 所以平台自己算好领先/落后几个提交，直接摆在它眼前（见 gitStateBlock）。
   */
  const gitState = gitStateBlock(member.cwd || repoRoot);
  const standing = [platformContractBlock(), repoBrief, gitState, pmBlock].filter(Boolean).join('\n\n');
  const contractBlock = taskContractBlock({ card: opts.card, workflow: workflowTask, project, tasks: myTasks });
  const fullTask = [cardBlock, task, attBlock, stylePrefBlock(), contractBlock].filter(Boolean).join('\n\n');

  const run = runs.startRun({
    thread,
    member,
    task: fullTask,
    // 不变量单独带（claude 走 out-of-band；codex/dsh 由 runs 拼回任务文本）
    standing,
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
 * `startMemberRun` 的 cwd 覆盖就自动同源。
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
