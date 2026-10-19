/**
 * 「派活」这条链路：解析目标成员 → 拼首轮任务 → 起一次 run。
 *
 * 为什么单独一个文件：**工作流引擎要复用同一条链路**。
 * 消息路由和工作流各写一份任务拼装，迟早走样 —— 这个坑踩过：
 * 按钮渲染写了两份，标题行那份漏了初始化，点「改」不回填、点「测」静默 404。
 *
 * 这里只负责"派出去"，不负责 HTTP：状态码由调用方按 err.code 映射。
 */
import { repoRoot } from './config.mjs';
import * as store from './store.mjs';
import * as runs from './runs.mjs';
import * as skills from './skills.mjs';
import * as runtimes from './runtimes.mjs';
import * as connectors from './connectors.mjs';
import * as secretary from './secretary.mjs';

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
 * 规则：@ 谁谁干活；没 @ 就跟**群助手**说话（群主是创建人，不接话）。
 * 一次只跑一个 —— 同时跑会在同一个仓库改代码上打架。
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
 * 往某个会话派一次活。
 * 返回 `{ run, member, mentions }`；派不出去抛错（err.code: busy / bad）。
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

  // 群成员是从 thread_members 来的，形状与 directMember 一致；这里统一补上工作根与技能清单
  member.roots = personaRoots(member.cwd, member.rootDirs);

  /*
   * 并发闸（2026-10-18）：工单会话拆开之后"一个员工只能干一件事"不再由会话天然保证，
   * 所以在这儿显式封两道：
   *   ① 每人最多 2 件同时在跑 —— 每条并发都烧一份 token、开一个 CLI 进程，
   *      不封顶的话一次批量派活能把机器和账都打穿；
   *   ② 同一个项目同一时刻只许一件 —— 两个进程改同一份代码，冲突起来比串行难查得多。
   * 撞上了抛 'busy'：流程会退回「待办」由 30 秒节拍重派，任务卡会落排队标记同样等节拍。
   */
  const RUNNING_CAP = 2;
  const running = store.countActiveRunsForPersona(member.personaId);
  if (running >= RUNNING_CAP) throw fail(`他手上已经有 ${running} 件活在跑，这件先排队`, 'busy');
  if (opts.projectId && store.activeRunForProject(opts.projectId)) {
    throw fail('这个项目同时只能跑一件，先等它做完', 'busy');
  }

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
   * 内置秘书多一段「机器现状」。**只给内置的**：普通员工不该被塞平台的端口和路径，
   * 那是噪音。现取不缓存 —— 端口/数据目录一变，这句话就得跟着变。
   */
  const brief = store.getPersona(member.personaId)?.builtin ? secretary.secretaryBrief() : '';

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
  });

  // **讨论模式 = 只读沙箱**（2026-10-19 用户定）：卡片评论分三档，其中「讨论」只聊不动手。
  // 这里把员工的沙箱临时盖成 `plan`（统一语义），runs 里 `normalizeSandbox` 会按运行时族
  // 换算成各族自己的只读写法（codex `read-only` / claude `plan`）。不传 = 员工默认（可写）。
  if (opts.sandbox) member.sandbox = opts.sandbox;

  const task = isGroup
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
    : buildDirectTask(thread, text, firstTime, skillLines, connLines, brief);

  const run = runs.startRun({
    thread,
    member,
    task,
    watermark: trigger.rowid,
    workflowTaskId: opts.taskId ?? null,
    // 把作用域带进执行层：sessionId 按 (会话 × 人 × 作用域) 存取
    sessionScope,
    // 项目互斥要记在 run 上（谁在这个目录里跑着）
    projectId: opts.projectId ?? null,
  });
  return { run, member, mentions };
}
