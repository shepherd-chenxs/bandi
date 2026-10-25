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
import * as secretary from './secretary.mjs';
import { controlUrl, isPmRole } from './agent-auth.mjs';

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
 * 项目经理的「建卡通道」注入块（2026-10-24）：首轮派活时告诉他怎么把活立成卡。
 * 只给项目经理岗位（isPmRole）；钥匙在环境变量里，这里只教用法 —— 远端节点跑的活
 * 没有这两个环境变量，让他见了空值就别用（钥匙不发就是不发，不是丢了）。
 */
function pmCardBrief() {
  return [
    '【建卡通道】你可以把拆出来的活直接立成任务卡（全平台只有项目经理岗位能这么做）：',
    '',
    `POST \${BANDI_CONTROL_URL}/api/agent/cards   （\${BANDI_CONTROL_URL} = ${controlUrl}，你的环境变量里有）`,
    '请求头：X-Bandi-Run-Token: 你环境变量里的 BANDI_RUN_TOKEN',
    '请求体：{ "projectId": "…", "title": "一句话说清要做什么", "description": "边界、做成什么样算完",',
    '          "assigneePersonaId": "…或省略", "status": "待办" 或 "想法" }',
    '',
    '**请求体必须走文件**：先用写文件工具把 JSON 存成 UTF-8 文件（系统临时目录，发完删），再',
    '`curl -s -X POST "$BANDI_CONTROL_URL/api/agent/cards" -H "X-Bandi-Run-Token: …" \\',
    '  -H "Content-Type: application/json" --data-binary @card.json`',
    '别把中文直接写进命令行参数 —— Windows 的 cmd/PowerShell 按本地代码页转码，中文全变「?」，',
    '卡面就花了。发完看回包里的 title：出现「?」就是被转码了，确认走的是文件方式再重发。',
    '项目清单：GET /api/projects（拿 id 和目录）。',
    '',
    '口径：可逆的活建「待办」+ 执行人 —— 建完自动派活，不用请示；要雇主拍板的（花钱/对外/改范围）',
    '建「想法」挂着等他，或只在群里说。干完的卡会回到雇主那里验收。',
    '环境变量里没有 BANDI_RUN_TOKEN，就说明这条通道这次没开，别硬造一个。',
  ].join('\n');
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
export function buildDirectTask(thread, text, firstTime, skillLines = [], connLines = [], brief = '') {
  if (!firstTime) return text;

  const parts = [];
  const rules = (thread.personaInstructions ?? '').trim();
  if (rules) parts.push('你在本次会话中的身份与职责设定如下（后续对话请一直保持）：', '', rules, '');
  if (skillLines.length) parts.push(...skillsBlock(skillLines));
  if (connLines.length) parts.push(...connectionsBlock(connLines));
  if (brief) parts.push(brief, '');

  if (!parts.length) return text;
  parts.push('---', '', '用户的第一条消息：', text);
  return parts.join('\n');
}

/** 只给「名字 + 一句话 + 路径」，正文让它按需去读 —— 渐进披露，别把 context 塞满 */
function skillsBlock(lines) {
  return ['你的技能（相关时先读这些文件，不要凭印象猜）：', '', ...lines, ''];
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
export function buildGroupTask({ thread, member, trigger, contextMessages, firstTime, skillLines = [], connLines = [], brief = '' }) {
  const lines = [];

  if (firstTime) {
    lines.push(`你在一个项目群里。群名：${thread.title}`, '');
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
 *     同目录并行改代码的冲突风险由人承担（用户拿 ZCode 同项目多任务并行做的类比，2026-10-24）。
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
  const brief = [
    p?.builtin ? secretary.secretaryBrief() : '',
    p && isPmRole(p.role) ? pmCardBrief() : '',
  ].filter(Boolean).join('\n\n');

  // **这次派活属于哪个 session 作用域**：带流程 runId → 这条流程实例自己的一条
  // 全新会话；手动聊天 → 普通作用域，照旧续接。
  const sessionScope = sessionScopeOf(opts);

  // 这个作用域下他有没有自己的会话 + 他读到哪儿了
  const ms = store.getMemberSession(threadId, member.personaId, sessionScope);
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
        contextMessages: store
          .listMessagesSince(threadId, watermark, trigger.id)
          .filter((m) => m.personaId !== member.personaId),
      })
    : buildDirectTask(thread, trigger.text, firstTime, skillLines, connLines, brief);

  // 附件（2026-10-23）：文件已落在本机 uploads/ 下 —— 告诉员工绝对路径让它自己读。
  // CLI 的沙箱只限**写**，读全盘不受限，给路径就够了。
  const attBlock = attsBlock(opts.atts);
  // 任务卡锚点（2026-10-23）：卡评论区派活必须带上"你在办哪张卡"，问进度才不会答偏。
  const cardBlock = opts.card ? taskCardBlock(opts.card) : '';
  const fullTask = [cardBlock, task, attBlock, stylePrefBlock()].filter(Boolean).join('\n\n');

  return runs.startRun({
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
