/**
 * 工作流引擎（v2）：**节点 + 连线**，不是"下一步"。
 *
 * v1 只会在一条线上往前走，没有分支。v2 按 OA 审批的语义来：
 *   · 每个节点声明**出口**：通过去哪、驳回回哪（终止是内建第三种）
 *   · 驳回可以**回到前面某个节点**，所以一个节点会被**访问多次** ——
 *     这就是为什么实例只记"当前在哪个节点"，而每一次访问单独成一条任务
 *   · 办理痕迹（谁办的、几时、通过还是驳回、产出）全在任务表上
 *
 * 和 Flowable/BPMN 的关系：**抄模型，不抄实现**。
 * 节点 + 连线 + 条件 + 任务分配，这套模型够用；BPMN 2.0 那套事件子流程、
 * 补偿事务、边界定时器，OA 审批一个都用不到，背上去只是负担。
 *
 * ⚠️ 一步的执行走的是和"发消息"完全相同的链路（dispatch.mjs），不另造执行引擎。
 */
import * as store from './store.mjs';
import * as quota from './quota.mjs';
import * as runs from './runs.mjs';
import * as cliModels from './cli-models.mjs';
import * as runtimes from './runtimes.mjs';
import { dispatchToThread } from './dispatch.mjs';

/** 一步跑多久算「卡住」 */
const STUCK_MS = 10 * 60 * 1000;
/** 同一个节点被访问多少次就不再放行 —— 驳回打回是有限度的，别让它无限来回 */
const MAX_VISITS = 20;
/** 连线的终点：走完就结束 */
const END = 'end';
/**
 * 内建模板**改名前**的 id（2026-10-16 之前叫这个）。
 * 它跟技能名 `bandi-flow` 撞了 —— 老库里的模板 id 靠 ensureBuiltInTemplate 迁过来。
 */
const LEGACY_TEMPLATE_ID = 'bandi-flow';

/**
 * 内建模板：班底交付流程。
 * **带真实的分支**：测试不通过退回开发，发布失败退回重测 —— 这才叫流程。
 * x/y 是给画布用的坐标（拖过就存下来）；没有坐标时界面自己排一个。
 *
 * ⚠️ **节点不声明技能**：技能是"这个人会干什么"，绑在数字员工身上；
 * 流程负责把不同的人组合起来，所以每一步**只差点名**（`personaId`）。
 * 没点名 = 故意留空：到站即「已阻塞」，等人指派（见 assigneeFor）。
 *
 * ⚠️ id 原来是 `bandi-flow`，跟**技能名撞了**（技能也叫 `bandi-flow`，是能力包）：
 * 一个是平台的流程图，一个是员工身上的能力，同名让人和模型都分不清。
 * 2026-10-16 起叫 `bandi-delivery`，老库里的旧 id 由 ensureBuiltInTemplate 迁过来。
 */
export const BUILT_IN_TEMPLATE = {
  id: 'bandi-delivery',
  name: '班底交付流程',
  builtIn: true,
  start: 'n1',
  nodes: [
    {
      id: 'n1', name: '谈需求', x: 220, y: 60,
      detail: '把这次要做的东西谈清楚：目标、边界、验收标准、不做什么。产出落进需求文档。',
      approve: 'n2', reject: END, // 需求本身不成立 → 直接结束，不用往后走
    },
    {
      id: 'n2', name: '定计划', x: 480, y: 60,
      detail: '把需求拆成任务卡，给出排期和版本号。产出落进排期文档。',
      approve: 'n3', reject: 'n1', // 计划谈不拢 → 回去把需求重谈清楚
    },
    {
      id: 'n3', name: '写代码', x: 740, y: 60,
      detail: '按任务卡实现，自测通过后报告改了哪些文件、怎么验的。',
      approve: 'n4', reject: 'n2', // 做不出来说明计划有问题 → 回去重排
    },
    {
      id: 'n4', name: '测试', x: 740, y: 210,
      detail: '按验收标准验证，给出通过/不通过，以及证据（跑了什么、看到什么）。',
      approve: 'n5', reject: 'n3', // 测试不过 → 退回开发重修（最典型的那条回路）
    },
    {
      id: 'n5', name: '部署', x: 480, y: 210,
      detail: '把本版本发布出去，记录发布结果和回滚方式。部署永远要人下令。',
      approve: END, reject: 'n4', // 发布失败 → 回去重测
      // ⚠️ **部署永远要人下令**（契约「四」写的硬规矩，这里必须落成开关）：
      // 没有它，onAgentRunFinished 会在这一步跑完后自动 decide('通过') ——
      // 契约上写着"不自动流转"，代码里却在自动流转，是最难发现的那种不一致。
      manual: true,
    },
  ],
};

/* ------------------------------------------------------------------ 模板 */

/** 保证内建模板是**最新版**（v1 的线性模板要升级成带分支的 v2） */
export function ensureBuiltInTemplate() {
  // 改名迁移（只做一次）：老库里的内建模板 id 还叫 `bandi-flow`。
  // 新 id 已经存在就不动 —— 那只可能是用户自己建了个同名的，交给人处理，别替他决定。
  if (store.getWorkflowTemplate(LEGACY_TEMPLATE_ID) && !store.getWorkflowTemplate(BUILT_IN_TEMPLATE.id)) {
    const moved = store.renameWorkflowTemplate(LEGACY_TEMPLATE_ID, BUILT_IN_TEMPLATE.id);
    if (moved) console.log(`流程模板改名：${LEGACY_TEMPLATE_ID} → ${BUILT_IN_TEMPLATE.id}（实例的 templateId 一起改）`);
  }

  const cur = store.getWorkflowTemplate(BUILT_IN_TEMPLATE.id);
  if (!cur || !cur.nodes) return store.upsertWorkflowTemplate(BUILT_IN_TEMPLATE);

  // 已经有了：**只补平台后来新增的东西**，用户改过的一律不动 —— 覆盖用户的改动是最糟的。
  //   ① 坐标：老模板没 x/y，画布上会叠在一起；
  //   ② `manual`：契约写着"部署永远要人下令"，可老种子数据里压根没这个字段，
  //      引擎只看 `manual`，没有它部署跑完就会自动流转。
  //      所以只补**从来没设过**的（`undefined`）——设计器一保存就会写 true/false，
  //      那是用户的选择，`false` 也得留住。
  const nodes = nodesOf(cur);
  const needCoords = nodes.length > 0 && nodes.every((n) => !Number.isFinite(n.x));
  const wantManual = new Set(BUILT_IN_TEMPLATE.nodes.filter((n) => n.manual === true).map((n) => n.id));
  const byId = new Map(BUILT_IN_TEMPLATE.nodes.map((n) => [n.id, n]));
  let touched = false;
  const fixed = nodes.map((n, i) => {
    const next = { ...n };
    if (needCoords) {
      const ref = byId.get(n.id);
      next.x = ref?.x ?? 40 + (i % 4) * 260;
      next.y = ref?.y ?? 60 + Math.floor(i / 4) * 150;
      touched = true;
    }
    if (wantManual.has(n.id) && n.manual === undefined) {
      next.manual = true;
      touched = true;
    }
    return next;
  });
  if (touched) store.upsertWorkflowTemplate({ id: cur.id, name: cur.name, nodes: fixed, builtIn: !!cur.builtIn });
  return store.getWorkflowTemplate(BUILT_IN_TEMPLATE.id);
}

/** 模板里的节点数组（兼容 v1 的 steps：老模板也能读出来，别炸） */
export function nodesOf(tpl) {
  const raw = tpl?.nodes || tpl?.steps || '[]';
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/**
 * 起步点在哪个节点。
 * **显式声明优先**；没有就退回第一个节点（兼容老模板）——
 * 但界面上一定要能把「开始」画出来，不然"从哪起步"要靠数数组顺序猜。
 */
export function startOf(tpl) {
  const nodes = nodesOf(tpl);
  if (!nodes.length) return null;
  const want = tpl?.startNode;
  return nodes.some((n) => n.id === want) ? want : nodes[0].id;
}

export function saveTemplate({ id, name, nodes, start }) {
  if (!Array.isArray(nodes) || !nodes.length) throw new Error('模板至少要有一步');
  const ids = new Set();
  for (const n of nodes) {
    if (!n.id) throw new Error('每个节点都要有 id');
    if (ids.has(n.id)) throw new Error(`节点 id 重复：${n.id}`);
    ids.add(n.id);
    if (!n.name?.trim()) throw new Error(`节点 ${n.id} 缺名字`);
  }
  for (const n of nodes) {
    for (const [k, target] of [['通过', n.approve], ['驳回', n.reject]]) {
      if (target && target !== END && !ids.has(target)) {
        throw new Error(`「${n.name}」的${k}指向了不存在的节点：${target}`);
      }
    }
  }
  // 开始节点必须指向一个真节点。没给就用第一个 —— 但**不能指向不存在的**
  const startId = start && ids.has(start) ? start : nodes[0].id;
  if (start && !ids.has(start)) throw new Error(`开始节点指向了不存在的节点：${start}`);
  return store.upsertWorkflowTemplate({ id, name: name?.trim() || '未命名流程', nodes, start: startId, builtIn: false });
}

/** 从「想法」里取第一行当流程名字（发起时少填一个字段） */
function firstLine(text, max = 24) {
  const s = String(text ?? '').trim().replace(/^#+\s*/, '');
  if (!s) return '';
  const line = s.split('\n').map((x) => x.trim()).find(Boolean) ?? '';
  return line.length > max ? line.slice(0, max) + '…' : line;
}

/**
 * 这一步派给谁：**只认节点上点名的人**（`personaId`）。
 *
 * 没点名不是"等人顶上"，是**故意留空**（用户 2026-10-14 定）：到站即标「已阻塞」，
 * 等人来指派。理由：技能是"这个人会干什么"，不是"这一步该谁办"——
 * 而且**不是每个节点都有对应技能**；引擎自己按技能挑一个顶上，
 * 等于把用户没做的决定替他做了。所以节点上连 skill 都不再声明（见 BUILT_IN_TEMPLATE）。
 */
export function assigneeFor(node) {
  return node?.personaId && store.getPersona(node.personaId) ? node.personaId : null;
}

/* ------------------------------------------------------------------ 发布 */

/** 发布 / 下架：草稿只在工作流模块里编，**发布了的才在工作台里能点开** */
export function publishTemplate(id, on = true) {
  const tpl = store.getWorkflowTemplate(id);
  if (!tpl) throw new Error('模板不存在');
  if (on && !nodesOf(tpl).length) throw new Error('空流程发布不了，先加节点');
  return store.setTemplatePublished(id, on);
}

/** 工作台要的：已发布的流程 */
export function publishedFlows() {
  return store
    .listWorkflowTemplates()
    .filter((t) => t.publishedAt)
    .map((t) => ({
      id: t.id,
      name: t.name,
      nodeCount: nodesOf(t).length,
      publishedAt: t.publishedAt,
    }));
}

/* ------------------------------------------------------------------ 实例 */

/**
 * 发起一条流程。
 *
 * **没有"场地"这回事**：流程不建群，也不挂在某个会话上 ——
 * 派给谁就发到谁那儿（见 startCurrentStep）。谁也不用先选地方。
 */
export function startWorkflow({ templateId, title, intent, projectId = null, autoStart = true }) {
  const tpl = store.getWorkflowTemplate(templateId);
  if (!tpl) throw new Error('模板不存在');
  const nodes = nodesOf(tpl);
  if (!nodes.length) throw new Error('这个模板没有节点');

  const want = String(intent ?? '').trim();
  // 名字不用单独填：**从想法里取第一行**，发起时少一个字段
  const name = (title ?? '').trim() || firstLine(want) || tpl.name;

  const run = store.createWorkflowRun({ templateId, title: name, intent: want || null, projectId });
  const startId = startOf(tpl);
  const first = nodeById(tpl, startId) ?? nodes[0];
  store.setWorkflowCurrentNode(run.id, first.id);
  createTask(run.id, first, 1);

  // **发起即自动开跑第一步** —— 不用再手点一次「派活」。
  // 派活失败**不往上抛**：最常见是**第一步没点名**（那是故意留空，不是缺人）——
  // 流程照样建出来，那一步已经是「已阻塞」并写清原因，去实例页选个人就接着办。
  // 发起这件事本身不该因为派活失败而失败。
  //
  // autoStart=false：只建不派活。给需要"干净世界"的场景用（比如引擎测试）——
  // 否则每次建流程都会真的叫起经办人，几个测试并行时互相撞"他还在跑上一条"。
  if (autoStart) {
    try {
      startCurrentStep(run.id);
    } catch (e) {
      console.warn(`「${name}」自动派活没成功：${e.message}`);
    }
  }
  return viewRun(store.getWorkflowRun(run.id), { withTasks: true });
}

/**
 * "这一步没人可办"的原因 —— **只在这一处拼**。
 * startCurrentStep（点派活时发现）和 createTask（到站即知）都要用它，
 * 两边各写一套的话，用户会看到两种说法（今天已经踩过好几次"同一个事实两处表示"）。
 */
function noAssigneeWhy(node, nodeName) {
  if (node?.personaId) return `「${nodeName}」点名的数字员工已经不在了`;
  // **不提技能**：技能是"这个人会干什么"，不是"这一步该谁办"。
  // 有的节点压根没有对应技能，提它只会让人以为"必须有那个技能的人才行"。
  return `「${nodeName}」没点名经办人`;
}

function createTask(runId, node, visit) {
  const task = store.createWorkflowTask({
    runId,
    nodeId: node.id,
    nodeName: node.name,
    visit,
    detail: node.detail ?? '',
    // 谁办：**只认点名**（见 assigneeFor）。没点名就留空，
    // 紧接着那条 if 会把它标成「已阻塞」——那是**故意留空**，不是缺人。
    assigneePersonaId: assigneeFor(node),
    status: '待开始',
  });
  // **到站即知**：这一步没点名的话，立刻标「已阻塞」，别让它显示成"待开始"等人点一下派活
  // 才发现（用户实报："这种没人的情况应该是阻塞状态"）。
  // 之前只在"点派活"那一步才发现没人，于是节点到站时看着像随时会开跑 —— 但它永远不会自己动。
  if (!task.assigneePersonaId) {
    store.updateWorkflowTask(task.id, {
      status: '已阻塞',
      note: `${noAssigneeWhy(node, node.name)}。点上面「经办人」那儿选一个人就能接着办`,
      endedAt: store.nowIso(),
    });
  }
  return store.getWorkflowTask(runId, node.id, visit) ?? task;
}

function currentTask(run) {
  return run?.currentNodeId ? store.getWorkflowTask(run.id, run.currentNodeId, maxVisit(run.id, run.currentNodeId)) : null;
}
function maxVisit(runId, nodeId) {
  return store.countNodeVisits(runId, nodeId) || 1;
}
function nodeById(tpl, id) {
  return nodesOf(tpl).find((n) => n.id === id) ?? null;
}

/**
 * 这一步**实际会用哪个模型** —— 额度是按模型算的，所以闸开口之前先要问出这个。
 *
 * 跟 runs.mjs 记进 `runs.model` 的是**同一个函数、同一份输入**：
 * 两边各算各的话，闸盯的模型和账上记的模型迟早不是同一个（那限额就成了摆设）。
 * 解析不出来就是 null（比如 claude 没有可读的默认值）—— 那种情况不拦，见 quota.overQuotaFor。
 */
function modelOfTask(task) {
  const persona = task?.assigneePersonaId ? store.getPersona(task.assigneePersonaId) : null;
  if (!persona) return { id: null, from: '还没点名经办人' };
  const rt = runtimes.resolveForRun(persona.runtime);
  return cliModels.effectiveModelOf({ family: rt?.family ?? null, model: persona.model });
}

/** 把当前这一步**派出去**（起流程后得有人按这一下；起流程 ≠ 自动开跑） */
export function startCurrentStep(runId, { force = false } = {}) {
  const run = store.getWorkflowRun(runId);
  if (!run) throw new Error('流程不存在');
  if (run.status !== '进行中') throw new Error(`流程已经「${run.status}」了`);

  const task = currentTask(run);
  if (!task) throw new Error('找不到当前任务');
  if (task.status === '进行中') throw new Error('这一步已经在跑了');
  /*
   * **额度闸**：派活之前拦一道。
   *
   * 为什么拦在这儿：所有派活（手动点 / 到站即派活 / 重跑）都走 startCurrentStep，
   * 一个口子就够，不用到处堵。
   *
   * **按模型算**：闸查的是"这一步要用的那个模型"今天还剩多少，不是全站一个总数 ——
   * 贵和便宜分在模型上（本机所有模型都挂在同一个 magpie 网关下），全站总数会把
   * 免费的和收费的一起管住。要用的模型由 modelOfTask 解析（员工绑的，或 CLI 默认）。
   *
   * 超了怎么办 —— 用户选的方案：**停下来等人**（不是静默拒绝派活）。
   *   · 标「已阻塞」+ 写明原因：跟"没点名""失败等人处理"同一档语义，
   *     界面上那一步立刻红字说清"是额度拦的、怎么接着跑"，不会被误当成故障
   *   · `force: true` 是「继续一次」：明确知道要超支，放这一步过去（不循环拦）
   *   · 不打断**正在跑**的那一次 —— 只在派活前拦
   */
  if (!force && task.status !== '已阻塞') {
    const why = quota.overQuotaFor(modelOfTask(task).id);
    if (why) {
      store.updateWorkflowTask(task.id, {
        status: '已阻塞',
        // 出路那句从 quota 导出：实例页要拿**同一句**来认"这是额度拦的"（quotaBlocked）
        note: `${why}。${quota.CONTINUE_HINT}`,
        endedAt: store.nowIso(),
      });
      store.touchWorkflowRun(runId);
      throw new Error(why);
    }
  }
  if (!task.assigneePersonaId) {
    // **没点名 = 已阻塞**（不是"失败"，也不是单独一个"待指派"状态）：
    //   · 失败是"跑了但挂了"，跟这个完全不同（那个能重跑）
    //   · "等指派"本来就是"等人处理"的一种，不该另立一个状态 ——
    //     状态一多就会出现"没人管的状态"（用户指出：没人的情况应该就是阻塞）
    //   · 没点名是**用户故意留空**，所以这里不是兜底，是照办
    const node = nodeById(store.getWorkflowTemplate(run.templateId), task.nodeId);
    const why = noAssigneeWhy(node, task.nodeName);
    store.updateWorkflowTask(task.id, {
      status: '已阻塞',
      note: `${why}。点上面「经办人」那儿选一个人就能接着办`,
      endedAt: task.endedAt ?? store.nowIso(),
    });
    throw new Error(`${why}。点上面「经办人」那儿选一个人就能接着办`);
  }

  store.updateWorkflowTask(task.id, {
    status: '进行中',
    startedAt: store.nowIso(),
    endedAt: null,
    note: null,
    agentRunId: null,
    decision: null,
  });

  // 派活：发到这条流程的**场地**（项目群 / 某个人的会话）里。
  // 群里必须 @ 到具体的人，否则会跑到群助手那儿去。
  // 派给谁就发到**谁那儿**（不建群、不选场地）。群里才需要 @ 人。
  const conv = ensureDirectConversation(task.assigneePersonaId);
  store.setWorkflowRunThread(runId, conv); // 记下"当前这一步在哪个会话"，实例页和会话卡片要用
  const at = store.getConversation(conv)?.kind === 'group' ? `@${store.getPersona(task.assigneePersonaId)?.name} ` : '';
  // 发起时填的「想法」就是发给第一个人的第一句 —— 后面几步也带上，作为起因的上下文
  const text = [
    `${at}【流程 · ${run.title}】`,
    run.intent ? `\n起因（发起人说的）：${run.intent}` : '',
    `\n这一步（第 ${task.visit} 次办理）：${task.nodeName}`,
    task.detail,
    '',
    '做完直接说明结果即可；流程的推进由平台负责，你不用去开下一步。',
  ]
    .filter((x) => x !== '')
    .join('\n');

  try {
    const { run: agentRun } = dispatchToThread(conv, text, {
      runId: run.id,
      // 这一步的标记：往来按它归属（不再靠时间窗口）
      taskId: task.id,
      // **项目**：发起时选的那个项目，它的目录就是这一步干活的地方。
      // 不传就退回员工自己的 cwd（老流程没选过项目，照旧能跑）。
      projectId: run.projectId ?? null,
    });
    // 记下"这一步最近一次执行"的 id —— 一步多轮，每轮都覆盖它，
    // 这样人追问产生的第 2、3 轮也认得出属于这一步
    store.updateWorkflowTask(task.id, { conversationId: conv, agentRunId: agentRun.id });
    // 有可能它当场就失败了：那次 finish 已经跑完，而那时 agentRunId 还没写上，
    // 钩子找不到这条任务。补一次 —— 不补它会永远停在「进行中」，看起来像卡死。
    if (agentRun.finished) onAgentRunFinished(agentRun);
    return viewRun(store.getWorkflowRun(runId));
  } catch (e) {
    store.updateWorkflowTask(task.id, { status: '失败', note: String(e.message ?? e), endedAt: store.nowIso() });
    throw e;
  }
}

/**
 * 人在流程卡片上「回复」→ 发起新一轮。
 * 把这一轮的 agentRun 挂到**当前任务**上（覆盖上一轮），
 * 于是它跑完时钩子照样找得到这一步 —— 这就是"一步多轮"。
 */
export function attachRound(workflowRunId, agentRunId) {
  const run = store.getWorkflowRun(workflowRunId);
  if (!run || run.status !== '进行中') return null;
  const task = currentTask(run);
  if (!task || task.status === '已完成') return null;
  store.updateWorkflowTask(task.id, {
    agentRunId,
    status: '进行中',
    // ⚠️ **不要重置 startedAt**：它的意思是"这一步什么时候开始办的"，而往来
    // 正是按它切片显示的（见 viewTask）。每轮都重置的话，刚发一句就把这一步
    // 之前的往来整个切出窗口 —— 界面显示"还没聊过"（用户实报）。
    // "这是第几轮"由 agentRunId 表达：一步多轮，每轮覆盖它。
    startedAt: task.startedAt ?? store.nowIso(),
    endedAt: null,
    decision: null,
  });
  store.touchWorkflowRun(run.id);
  return task;
}

/**
 * 在**实例上**给当前这一步改派一个人，然后立刻派活。
 *
 * 为什么必须能在实例上改：改模板**不影响已经起跑的实例**（界面上写着"改动只影响以后新起的流程"）——
 * 所以"这个节点没人"卡住的时候，改模板救不了这一条，只能就地指定 ✓
 * 只改这一条实例的这一步，不动模板、不影响别的流程。
 */
export function assignCurrentStep(runId, personaId) {
  const run = store.getWorkflowRun(runId);
  if (!run) throw new Error('流程不存在');
  if (run.status !== '进行中') throw new Error(`流程已经「${run.status}」了`);
  const task = currentTask(run);
  if (!task) throw new Error('找不到当前任务');
  const p = store.getPersona(personaId);
  if (!p) throw new Error('这个人不在了');
  store.updateWorkflowTask(task.id, {
    assigneePersonaId: p.id,
    status: '待开始', // 指派完回到待开始，接着走正常的派活
    note: null,
    endedAt: null,
  });
  store.touchWorkflowRun(runId);
  return startCurrentStep(runId);
}

/** 某个模板的实例（发起记录） */
export function runsOfTemplate(templateId) {
  return store
    .listWorkflowRuns()
    .filter((r) => r.templateId === templateId)
    .map((r) => viewRun(r));
}

/** 这个会话里挂着的流程（一个项目群可以挂好几条） */
export function runsOfThread(threadId) {
  return store.listWorkflowRunsByThread(threadId).map((r) => viewRun(r));
}

function ensureDirectConversation(personaId) {
  const existing = store
    .listConversations()
    .find((c) => c.kind === 'direct' && c.personaId === personaId && !c.hiddenAt);
  if (existing) return existing.id;
  return store.ensureConversationForPersona(personaId).id;
}

/**
 * 挂在 run 完成点上（runs.onRunFinish 注册）。
 * 数字员工干完了 → 这条任务变成「待确认」，**等人在界面上点通过/驳回**。
 * 推进由平台做，不靠数字员工自觉。
 */
export function onAgentRunFinished(run) {
  const task = store.getWorkflowTaskByAgentRun(run.id);
  if (!task) return;
  const wf = store.getWorkflowRun(task.runId);
  if (!wf || wf.status !== '进行中') return;

  // **人主动"停止生成"**：既不是失败（没出错），也不是办完（不许往下流转）——
  // 停在「已阻塞」等人处理：想接着办就再派活/在对话里补一句，想推倒就改回待办。
  if (run.status === '已停止') {
    store.updateWorkflowTask(task.id, {
      status: '已阻塞',
      note: run.finalText ? summarize(run.finalText) : '已停止生成',
      endedAt: store.nowIso(),
    });
    store.touchWorkflowRun(task.runId);
    return;
  }

  if (run.status === '失败') {
    store.updateWorkflowTask(task.id, {
      status: '失败',
      note: run.error || '执行失败',
      endedAt: store.nowIso(),
    });
  } else {
    // 干完了。**停不停，看节点上的开关**：
    //   · manual = true  → 待确认，等用户拍板（需求那种"聊明白了我才放行"）
    //   · 否则           → 干完自动往下走（默认）
    store.updateWorkflowTask(task.id, { status: '待确认', note: summarize(run.finalText) });
    store.touchWorkflowRun(task.runId);
    const node = nodeById(store.getWorkflowTemplate(wf.templateId), task.nodeId);
    if (!node?.manual) {
      try {
        // 跟人手点「通过」走同一条路：**推进 + 到站即派活**（见 goto 里的说明）。
        // ⚠️ 这句注释原来吹了牛 —— 它写着"含派活"，而那条路当时并不派活，
        //    于是每一步都得人再点一次「派活」。现在才真的含。
        decide(task.runId, '通过');
      } catch (e) {
        // 自动流转失败不该把这一步弄坏：留在「待确认」，用户可以自己点通过
        console.warn(`「${task.nodeName}」自动流转没成功：${e.message}`);
      }
    }
    return;
  }
  store.touchWorkflowRun(task.runId);
}

/**
 * 人拍板：通过 / 驳回 / 终止。
 * 通过和驳回都按节点上声明的**出口**走；出口是 `end` 就收尾。
 */
export function decide(runId, decision) {
  const run = store.getWorkflowRun(runId);
  if (!run) throw new Error('流程不存在');
  if (run.status !== '进行中') throw new Error(`流程已经「${run.status}」了`);

  const task = currentTask(run);
  if (!task) throw new Error('找不到当前任务');
  if (!['通过', '驳回', '终止'].includes(decision)) throw new Error(`不认识的决定：${decision}`);

  // **终止不受任务状态限制**：还没派活、正在跑、已经失败，都要能撤。
  // 「通过/驳回」才受限制（它们是"放行/打回"，没开始就没有可放行的东西）。
  if (decision === '终止') {
    store.updateWorkflowTask(task.id, {
      status: task.status === '进行中' ? '已完成' : task.status,
      decision: '终止',
      endedAt: task.endedAt ?? store.nowIso(),
    });
    // 正在跑的那次执行不去杀它：它跑完时 onAgentRunFinished 会看到流程已终止而直接返回，
    // 不会把流程再推起来。硬杀反而可能留下半个文件。
    return viewRun(store.setWorkflowRunStatus(runId, '已终止', `在「${task.nodeName}」终止`));
  }

  if (task.status === '待开始') throw new Error(`「${task.nodeName}」还没开始，先派活（不能直接跳过）`);
  if (task.status === '进行中') throw new Error(`「${task.nodeName}」还在跑，等它说完`);
  if (task.status === '失败') throw new Error(`「${task.nodeName}」失败了 —— 先重跑，或终止流程`);

  const tpl = store.getWorkflowTemplate(run.templateId);
  const node = nodeById(tpl, task.nodeId);
  const target = decision === '通过' ? node?.approve : node?.reject;

  /*
   * 两种"找不到出口"要分开：
   *
   * ① **节点已经不在模板里**（模板改过：这一步被删了/重排了）。
   *    出口从哪儿都查不到，「通过」是唯一合理的出路 —— 没有下一步可去，就收尾。
   *    这不是静默跳过：任务和流程都写下原因，实例页那一步本来也标着「模板里已经没有了」。
   *    「驳回」不放行：驳回要有去处（回到前面某个节点），节点都没了就无从谈起。
   *    用户 2026-10-14 实报的那条就是这么卡住的：页面弹"去补一条"，但人根本补不动这条实例。
   *
   * ② 节点**还在**、只是没连出口 —— 那是模板没配好，照旧打回去让人在设计器里补。
   */
  if (!target) {
    if (!node && decision === '通过') {
      store.updateWorkflowTask(task.id, {
        status: '已完成',
        decision: '通过',
        endedAt: task.endedAt ?? store.nowIso(),
      });
      return viewRun(
        store.setWorkflowRunStatus(runId, '已完成', `「${task.nodeName}」已不在模板里，人工放行后收尾`),
      );
    }
    throw new Error(
      !node
        ? `「${task.nodeName}」这一步在流程模板里已经没有了 —— 通过可以收尾，驳回没有去处；要么去流程编排补回模板，要么终止这条流程`
        : `「${task.nodeName}」没声明「${decision}」的出口 —— 去流程设计里补一条`,
    );
  }

  store.updateWorkflowTask(task.id, {
    status: '已完成',
    decision,
    endedAt: task.endedAt ?? store.nowIso(),
  });
  return goto(runId, target, `${decision}「${task.nodeName}」`);
}

/** 重跑当前这一步（失败后，或人想重来） */
export function retryCurrentStep(runId) {
  const run = store.getWorkflowRun(runId);
  if (!run) throw new Error('流程不存在');
  if (run.status !== '进行中') throw new Error(`流程已经「${run.status}」了`);
  const task = currentTask(run);
  if (!task) throw new Error('找不到当前任务');
  if (task.status === '进行中') throw new Error('这一步正在跑，别重复派');
  // **「重跑」= 「改成待办」+ 立刻派活**：复用同一段（否则两边迟早不一致 ——
  // 之前这里就自己清 note、又不肯清 agentRunId，和"改状态→待办"对不上）。
  setStepStatus(runId, '待办');
  return startCurrentStep(runId);
}

export function abortWorkflow(runId, note = '人工终止') {
  const run = store.getWorkflowRun(runId);
  if (!run) throw new Error('流程不存在');
  return viewRun(store.setWorkflowRunStatus(runId, '已终止', note));
}

/**
 * 走到某个节点（或终点）。**驳回回到走过的节点**时，那条节点是"第 N 次访问"，
 * 所以这里要新建一条任务，而不是复用旧的那条 —— 旧的办理痕迹不能覆盖。
 */
function goto(runId, target, why) {
  if (target === END) {
    return viewRun(store.setWorkflowRunStatus(runId, '已完成', why));
  }
  const run = store.getWorkflowRun(runId);
  const tpl = store.getWorkflowTemplate(run.templateId);
  const node = nodeById(tpl, target);
  if (!node) throw new Error(`连线的目标节点不存在：${target}`);

  const visit = store.countNodeVisits(runId, target) + 1;
  if (visit > MAX_VISITS) {
    // 来回打回太多轮：**停下来说清楚**，别让它无限转
    return viewRun(
      store.setWorkflowRunStatus(runId, '已终止', `「${node.name}」被打回 ${MAX_VISITS} 次以上，停下来等人处理`),
    );
  }

  store.setWorkflowCurrentNode(runId, target);
  const task = createTask(runId, node, visit);
  /*
   * **到站即派活**，别停在「待开始」等人再点一下。
   *
   * 停不停**只由节点上的 `manual` 开关决定**（那是检查点：干完停住等人放行）。
   * 没勾就该一路跑下去 —— 通过、驳回、非人工节点的自动流转，三条路都走这儿。
   *
   * ⚠️ 以前这里只建任务不派活，于是三条路都停在「待开始」，每一步都要人再点一次
   *    「派活，开始这一步」；可**第一步**却是自动开跑的
   *    （startWorkflow(autoStart) → startCurrentStep）—— 同一个流程两种规矩，
   *    用户实报："目前的实现效果是要在下一步派活，这个不对。"
   *
   * 没人的不在这儿派：createTask 已经把它标成「已阻塞」了（到站即知），
   * 硬调 startCurrentStep 会抛。
   */
  if (task?.assigneePersonaId) {
    try {
      startCurrentStep(runId);
    } catch (e) {
      // 派活失败不该把"已经推进到这一步"弄坏：留在「待开始」，人可以自己点那颗派活按钮
      console.warn(`「${node.name}」到站自动派活没成功：${e.message}`);
    }
  }
  return viewRun(store.getWorkflowRun(runId));
}

/* ------------------------------------------------------------------ 视图 */

/**
 * 卡住判断（和 v1 一样，但这版要按"任务"算）：
 *   · 进行中超过 STUCK_MS      → 真卡住了
 *   · 失败没人管               → 也是卡住
 *   · 待确认 / 待开始          → **不算卡住**，是"在等你"
 */
export function viewRun(run, { withTasks = false } = {}) {
  if (!run) return null;
  const tasks = store.listWorkflowTasks(run.id);
  const cur = currentTask(run);
  const tpl = store.getWorkflowTemplate(run.templateId);
  const node = cur ? nodeById(tpl, cur.nodeId) : null;
  const persona = cur?.assigneePersonaId ? store.getPersona(cur.assigneePersonaId) : null;
  const elapsed = cur?.startedAt ? Date.now() - Date.parse(cur.startedAt) : 0;

  let stuck = null;
  let waiting = null;
  /*
   * ⚠️ 这两段文案里**不带节点名**（原来每条都嵌了 `「${cur.nodeName}」`）。
   *    因为用它们的两个地方，各自都已经写着那个节点名了：
   *      · 实例列表那一行：`[nodeName, assigneeName, stuck]` 拼起来 → 名字会出现两遍
   *      · 实例页当前那一步：行标题就是节点名 → 名字上下挨着说两遍
   *    服务端负责说"怎么了"，"是谁"由界面按它自己的排版权重去标注。
   */
  if (run.status === '进行中') {
    if (!cur) stuck = '找不到当前任务';
    else if (cur.status === '已阻塞' && !cur.assigneePersonaId) {
      waiting = '没人办，等你指派';
    } else if (cur.status === '已阻塞') stuck = '等人处理';
    else if (cur.status === '失败') stuck = '等人处理';
    else if (cur.status === '进行中' && elapsed > STUCK_MS) {
      stuck = `超过 ${Math.round(STUCK_MS / 60000)} 分钟没结果`;
    } else if (cur.status === '待确认') waiting = '等你确认';
    else if (cur.status === '待开始') waiting = '还没派活';
    else if (cur.status === '进行中') waiting = '正在跑';
  }

  return {
    id: run.id,
    templateId: run.templateId,
    title: run.title,
    status: run.status,
    threadId: run.threadId, // 场地：这条单子挂在哪个会话里
    intent: run.intent,     // 发起时填的想法
    // 注意：createdAt 在下面（跟 updatedAt 挨着），别在这儿再加一个 —— 加重复键不报错、后者生效，
    // 但会让人以为两个值不一样（我上一轮就这么干过：只读到半截就断言"没有这个字段"）。
    // 项目：这条流程在哪个目录里干活（发起时选的）
    projectId: run.projectId ?? null,
    projectName: run.projectId ? (store.getProject(run.projectId)?.name ?? null) : null,
    currentNodeId: run.currentNodeId,
    nodeName: cur?.nodeName ?? null,
    visit: cur?.visit ?? null,
    taskStatus: cur?.status ?? null,
    assigneePersonaId: cur?.assigneePersonaId ?? null,
    assigneeName: persona?.name ?? null,
    startedAt: cur?.startedAt ?? null,
    elapsedMs: elapsed || null,
    lastNote: cur?.note ?? null,
    /*
     * 当前这一步**会用哪个模型** —— 实例页顶栏要显示"这个模型今天用掉多少 / 还剩多少"，
     * 额度闸拦的也正好是它。跟闸、跟 runs.model 是同一个解析（modelOfTask）。
     */
    model: cur ? modelOfTask(cur).id : null,
    taskCount: tasks.length,
    // 出口：界面按它决定给哪几个按钮、按钮上写去哪
    outlets: node
      ? {
          approve: node.approve ?? null,
          reject: node.reject ?? null,
          approveTo: labelOf(tpl, node.approve),
          rejectTo: labelOf(tpl, node.reject),
        }
      : null,
    note: run.note,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    stuck,
    waiting,
    /*
     * 这一步是**额度拦下的**吗 —— 界面据此决定给不给「继续一次」。
     *
     * 为什么非要分出来：别的阻塞（比如"没点名"）放行了也没用 ——
     * `startCurrentStep` 会在下一道检查里照样抛，白点一次、白弹一次错。
     * 认法是"备注里有没有那句出路"，而那句话由 quota.CONTINUE_HINT 单点定义，
     * 所以这里不是在匹配一段随手写的文案。
     */
    quotaBlocked:
      cur?.status === '已阻塞' && String(cur.note ?? '').includes(quota.CONTINUE_HINT),
    // 人能把这一步改成哪些状态（待办 / 已阻塞 / 已完成）。
    // **状态只在这一处定义**，界面照着渲染，不再各写一套判断。
    // 终态流程不给；当前已经是某个状态就不重复给那个。
    statusChoices:
      run.status !== '进行中' || !cur
        ? []
        : ['待办', '已阻塞', '已完成'].filter(
            (s) =>
              s !==
              (cur.status === '待开始' ? '待办'
              : cur.status === '已阻塞' ? '已阻塞'
              : cur.status === '已完成' ? '已完成'
              : null),
          ),
    ...(withTasks
      ? {
          // 办理痕迹：**按创建顺序**，驳回打回会多出几条。
          // 带上每一步跟执行人的往来 —— 实例页是 issue，讨论就在页面里看，不跳会话。
          // 最后一步的往来窗口开到"现在"（见 viewTask 里的说明）
          tasks: tasks.map((t, i) => viewTask(t, true, i === tasks.length - 1, run)),
          // 模板里的节点清单（含点名的人）——界面要拿它画"还没走到的步骤"
          nodes: nodesOf(tpl).map((n) => ({
            id: n.id,
            name: n.name,
            detail: n.detail ?? '',
            // 出口也带上：时间轴末尾那个「结束」节点要说清"哪一步通过之后走到这儿"
            approve: n.approve ?? null,
            reject: n.reject ?? null,
            // 实例页要在节点上标出"这一步干完会停下来等人"——所以把开关带出来
            manual: n.manual === true,
            assigneeName: assigneeFor(n) ? (store.getPersona(assigneeFor(n))?.name ?? null) : null,
          })),
        }
      : {}),
  };
}

/** 连线目标显示成人能看懂的名字：终点叫「结束」 */
function labelOf(tpl, target) {
  if (!target) return null;
  if (target === END) return '结束';
  return nodeById(tpl, target)?.name ?? target;
}

function viewTask(t, withMessages = false, isLast = false, run = null) {
  const persona = t.assigneePersonaId ? store.getPersona(t.assigneePersonaId) : null;
  /*
   * **这一步实际在哪个目录里干活** —— 判定必须跟 dispatch.mjs 一字不差，
   * 否则界面上写的和真发生的是两回事：
   *   发起时选了项目 → 就在那个项目的主目录里；
   *   没选             → 退回员工自己配的 cwd。
   * 所以这里不是"展示 run 上那个字段"，而是**把派活时的选择重演一遍**。
   */
  const proj = run?.projectId ? store.getProject(run.projectId) : null;
  const workspace = proj ? (store.projectRoots(proj)?.[0] ?? null) : (persona?.cwd ?? null);
  // 这一步的会话级权限覆盖（null = 跟随员工默认）—— 前端权限下拉要显示它
  const conv = t.conversationId ? store.getConversation(t.conversationId) : null;
  const from = t.startedAt ? Date.parse(t.startedAt) : null;
  // ⚠️ 上界：**最后一步永远到"现在"**。
  //   它可能停在「待确认」，而人是可以继续跟经办人谈的（一步多轮）——
  //   若卡在 endedAt，之后发的消息全落在窗口外，界面上永远不出现，
  //   看着就像"发送不出去"（踩过）。
  const to = isLast ? Date.now() : t.endedAt ? Date.parse(t.endedAt) : Date.now();
  return {
    id: t.id,
    nodeId: t.nodeId,
    nodeName: t.nodeName,
    visit: t.visit,
    status: t.status,
    decision: t.decision,
    assigneePersonaId: t.assigneePersonaId, // 前端要按它取这个人的运行时/权限
    assigneeName: persona?.name ?? null,
    // 这一步的"场子"：在哪个项目、哪个目录里干活（没人指派时项目也可能是"没选"）
    projectId: run?.projectId ?? null,
    projectName: proj?.name ?? null,
    workspace,
    // 权限：会话上的覆盖值 + 这个人用的运行时（前端据此渲染权限下拉）
    conversationSandbox: conv?.sandbox ?? null,
    runtime: conv?.runtime ?? persona?.runtime ?? null,
    // 这一步的会话**此刻有没有在跑**（以及是哪次）——
    // 前端据此亮"正在输入中"、并订阅那条实时流。
    // ⚠️ 不能用任务状态判断：李俊回复时任务还是「待确认」，状态不会变（踩过）。
    runningRunId: conv ? (store.activeRun(conv.id)?.id ?? null) : null,
    note: t.note,
    startedAt: t.startedAt,
    endedAt: t.endedAt,
    conversationId: t.conversationId,
    elapsedMs: t.startedAt ? Date.parse(t.endedAt ?? store.nowIso()) - Date.parse(t.startedAt) : null,
    // 这一步跟执行人的往来：**按 taskId 归属**。
    // ⚠️ 以前是按时间窗口从 1:1 会话里切 —— 而 1:1 会被多条流程共用，
    //    于是别的流程的派活也混进这一步的往来里（用户实报：看着像重复发了一遍）。
    //    现在派活和从面板发出的话都带上 taskId，取的时候直接筛，不再靠时间猜。
    //    注：加这一列之前的旧消息没有标记，不会显示（不做回填，宁可少显示也不能混）。
    ...(withMessages && t.conversationId
      ? {
          messages: store
            .listMessages(t.conversationId)
            .filter((m) => m.taskId === t.id)
            .map((m) => ({
              role: m.role,
              who: m.role === 'user' ? '我' : (m.personaName ?? persona?.name ?? '他'),
              text: m.text,
              createdAt: m.createdAt,
            })),
        }
      : {}),
  };
}

export function getWorkflowView(id) {
  return viewRun(store.getWorkflowRun(id), { withTasks: true });
}

export function listWorkflowViews() {
  return store.listWorkflowRuns().map((r) => viewRun(r));
}

/** 一步的产出摘要：取第一段有内容的话，别把整篇报告塞进列表 */
function summarize(text, max = 160) {
  const s = String(text ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return null;
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * 人手动改这一步的状态：待办 / 已阻塞 / 已完成。
 *
 * 为什么要有：今天两次卡住都只能改数据库 ——
 *   ① 服务重启把步骤留在「进行中」（进程没了，它永远不会自己动）
 *   ② 测试污染出来的怪状态
 * 界面上没有任何入口能收拾。这个函数就是那个入口。
 *
 * 语义（这是唯一的定义处，界面只按它渲染）：
 *   待办   → 回到「待开始」，可以再派活；把上一轮的执行痕迹清干净
 *   已阻塞 → 停下等人处理，不派活
 *   已完成 → **就是"通过"**，走 decide 那条路，不另写一套推进逻辑
 *
 * ⚠️ 调用方（路由）**必须先把在跑的那次运行掐掉**再做这里的事 ——
 *    否则状态改了、agent 还在跑，跑完又把它写回去，两边打架
 *    （这正是"状态进行中、备注却写着被中断"的成因）。
 */
export function setStepStatus(runId, wanted) {
  const run = store.getWorkflowRun(runId);
  if (!run) throw new Error('流程不存在');
  if (run.status !== '进行中') throw new Error(`流程已经「${run.status}」了，改不了状态`);
  const task = currentTask(run);
  if (!task) throw new Error('找不到当前任务');

  if (wanted === '待办') {
    store.updateWorkflowTask(task.id, {
      status: '待开始',
      agentRunId: null,
      decision: null,
      // ⚠️ **不清 note**：它记的是"这一步上次干出来什么"，是**历史事实**。
      //    改回待办是"再办一次"，不等于"上次什么都没干" ——
      //    清掉的话时间轴上那一步变空白，可往来里还留着，两边自相矛盾。
      //    新一轮跑完会由 onAgentRunFinished 覆盖它。
      endedAt: null,
    });
    store.touchWorkflowRun(runId);
    return viewRun(store.getWorkflowRun(runId), { withTasks: true });
  }

  if (wanted === '已阻塞') {
    store.updateWorkflowTask(task.id, {
      status: '已阻塞',
      note: '人工标为已阻塞',
      endedAt: store.nowIso(),
    });
    store.touchWorkflowRun(runId);
    return viewRun(store.getWorkflowRun(runId), { withTasks: true });
  }

  if (wanted === '已完成') {
    store.updateWorkflowTask(task.id, {
      status: '待确认',
      endedAt: task.endedAt ?? store.nowIso(),
      note: task.note ?? '人工标为已完成',
    });
    return decide(runId, '通过');
  }

  throw new Error(`不认识的状态「${wanted}」（只有 待办 / 已阻塞 / 已完成）`);
}

/** 这一步允许被改成哪些状态（前端据此决定给不给那个下拉）—— 状态只在这一处定义 */
export function stepStatusChoices(runId) {
  const run = store.getWorkflowRun(runId);
  if (!run || run.status !== '进行中') return [];
  const task = currentTask(run);
  if (!task) return [];
  const cur =
    task.status === '待开始' ? '待办'
    : task.status === '已阻塞' ? '已阻塞'
    : task.status === '已完成' ? '已完成'
    : null;
  return ['待办', '已阻塞', '已完成'].filter((s) => s !== cur);
}
