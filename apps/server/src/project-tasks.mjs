/**
 * 任务看板的数据：把「有哪些活、都什么状态」汇成一张平表 + 一套看板列。
 *
 * 为什么要有它：流程的状态只在「实例页」一条条点得开，按项目横向看"哪些活卡住了"没地方看；
 * 而聊天派出去的活连个列表都没有。
 *
 * ── 两张面板，一套机制（2026-10-15） ─────────────────────────────
 *   · **项目看板**（`projectTasks`）：一个项目里的活 —— 项目 → 点一行进去；
 *   · **全局面板**（`allTasks`）：所有项目的活铺在同一张看板上 —— 工作台 → 任务看板。
 * 两张面板**同源、同列、同卡片**：行怎么算、列怎么分、概览怎么数，都走这里的 `board()`；
 * 界面那边也共用 `kbColumn` / `kbCard` / `wireBoard`。全局只是多两件事：
 * 每行标出属于哪个项目，以及**没挂项目的活也收**（`NO_PROJECT`，「未归属」）——
 * 那种活在项目看板里根本看不见，而全局面板说的是"所有的活"。
 *
 * 三个来源，一套行（2026-10-14 用户定：**聊天派活也算任务**）：
 *
 *   · **流程**：`workflow_runs.projectId = 本项目` → 展开它的 `workflow_tasks`，
 *     **每一次办理一行**（驳回打回会产生第 2、3 次，它们各自是一行）。
 *   · **聊天派活**：会话属于本项目（`conversations.projectId`）；没挂项目的会话，
 *     按**执行人的工作目录**归属（员工的工作目录正好落在本项目根下就算）——
 *     平台里聊天没有"选项目"这一步，所以这是唯一的兜底；一旦会话挂了项目，以会话为准。
 *     一行 = 一个会话的**最近一轮聊天**（谁在办、什么状态、最后一句说了什么）。
 *     ⚠️ 流程的活也派进经办人的 1:1 会话里，所以这里必须**把流程轮次剔掉**
 *     （`store.runBelongsToWorkflow`），否则同一件活会被算两遍、还标错来源。
 *     ⚠️ 聊天行**按会话算，不按项目算**（`chatRows` 遍历会话，归属只是它的一个字段）——
 *     所以全局面板里同一场对话永远不会出现两张卡。
 *   · **手工任务**：看板上直接建的卡（`project_tasks`），一行 = 一张卡。
 *
 * 三张表都只读（除了下面那两个建/改手工卡的口子）。排序按「要不要人管」：
 * 已阻塞 → 失败 → 待人确认 → 进行中/没开跑 → 已完成。
 *
 * ── 历史数据的一处已知不准 ───────────────────────────────────────
 * "这次执行是不是流程的一步"靠五条线索判（见 `store.runBelongsToWorkflow`）。
 * **2026-10-13 之前**的少数轮次，平台当时既没在触发消息上留标记、也没记 agentRunId，
 * 那几个轮次会被算成「聊天派活」。新数据不用愁：派活时就把 workflowTaskId 写在 runs 上了。
 */
import path from 'node:path';
import * as store from './store.mjs';
import { dispatchToThread, projectConstitutionBlock } from './dispatch.mjs';

/** 排序权重：越小越"要人管"（平表用它；看板按列站队，不看这个） */
const FLOW_RANK = { 已阻塞: 0, 失败: 1, 待确认: 2, 进行中: 3, 待办: 4, 待开始: 4, 已完成: 5, 想法: 6 };

/**
 * 看板上**不要**把「流程的一步」开出来的那张卡再算一行（2026-10-19）。
 *
 * 为什么：流程页那枚「任务」会在第一次点时给这一步建一张 `project_tasks` 的卡
 * （见 `ensureTaskCardForStep`）。那张卡带 `sourceKey = flow:...`。
 * 而看板的流程行本来就是**按 `workflow_tasks` 一行一次办理**算的 ——
 * 两张表都数一遍，同一件事就会在看板上出现两行（实测过：`flow` 一行 + `manual` 一行，
 * 标题一模一样，人看了只会以为"重复建了两张卡"）。
 *
 * 所以：带 `sourceKey` 的卡**不进看板**，它的身份永远由流程那一行代表；
 * 卡本身照常能用（能拖能改、能派活），只是不在看板上再占一格。
 * ⚠️ 只认 `sourceKey`，**不按标题猜** —— 人手建一张正好重名的卡是合法的，不能吞掉。
 */
const notFlowCard = (t) => !t.sourceKey;
const CHAT_RANK = { 失败: 1, 已停止: 2, 跑中: 3, 完成: 5 };
const RANK_OTHER = 8;

/**
 * 看板列：**从左到右按生命周期**（用户 2026-10-14 参照 Multica 的看板定的形状）。
 * 「停下等人」一格收两种状态：流程的 `已阻塞` 与聊天的 `已停止` ——
 * 平台语义上它们同类（都停下来等人处理，见契约「三、进度与状态」），
 * 但**卡片上显示各自的原话**，不把状态名洗掉。
 *
 * 最左边那列「想法」是**还没成形的念头**（2026-10-15 加）：它排在「待办」之前，
 * 因为生命周期上它更早——想法是"还没决定要不要做"，待办是"决定要做了"。
 * 这一列**只手工建卡**，不会有流程/聊天自动落进来（那两者跑起来时早过了"想法"这个阶段）。
 */
const COLUMNS = [
  { key: 'idea', label: '想法', hint: '还没决定要不要做' },
  { key: 'todo', label: '待办' },
  { key: 'doing', label: '进行中' },
  { key: 'confirm', label: '待人确认' },
  { key: 'blocked', label: '停下等人', hint: '已阻塞 · 已停止' },
  { key: 'failed', label: '失败' },
  { key: 'done', label: '已完成' },
  { key: 'other', label: '其他' },
];
const COL_OF_FLOW = { 待办: 'todo', 待开始: 'todo', 进行中: 'doing', 待确认: 'confirm', 已阻塞: 'blocked', 失败: 'failed', 已完成: 'done' };
const COL_OF_CHAT = { 进行中: 'doing', 已完成: 'done', 失败: 'failed', 已停止: 'blocked' };
/** 手工任务：状态直接用流程那套词，站列一一对应（加「想法」—— 它只可能手工来） */
const COL_OF_MANUAL = { 想法: 'idea', 待办: 'todo', 进行中: 'doing', 待确认: 'confirm', 已阻塞: 'blocked', 已完成: 'done' };

/** 看板列 → 新建任务时的默认状态（点哪一列的「＋」就默认落在哪一列） */
export const STATUS_OF_COL = { idea: '想法', todo: '待办', doing: '进行中', confirm: '待确认', blocked: '已阻塞', done: '已完成' };

/** 聊天运行态 → 人看的说法（流程那套用平台自己的六态，不翻译） */
const CHAT_STATUS_TEXT = { 跑中: '进行中', 完成: '已完成', 失败: '失败', 已停止: '已停止' };

/** 一行备注的长度上限；行数上限（面板是给人看的，不是导出全量） */
const NOTE_LIMIT = 90;
const TASK_LIMIT = 70;
const MAX_ROWS = 200;

/**
 * 没归到任何项目上的活，在全局面板里挂这个名。
 * 前端卡片上那枚项目标签读的就是它（`apps/web/app.js` 里同名常量，改一处要一起改）。
 */
export const NO_PROJECT = '（未归属）';

/**
 * 路径比较：统一解析 + 去尾分隔符 + 小写（Windows 大小写不敏感）。
 *
 * ⚠️ 空/缺失**不能**丢给 `path.resolve`：`path.resolve('')` 返回的是**服务进程的 cwd**，
 * 于是"这个员工查不到、没有工作目录"会被蒙成"他的目录就是平台自己的目录"——
 * 平台恰好跟某个项目同根（班底仓库就是这样）时，幽灵卡就全归到那个项目头上了。
 * 空串返回空串，`under()` 里那句 `if (!c || !r) return false` 才会真的生效。
 */
function norm(p) {
  const s = String(p ?? '').trim();
  if (!s) return '';
  return path.resolve(s).replace(/[\\/]+$/, '').toLowerCase();
}
/** child 是否在 root 里（含相等） */
function under(child, root) {
  const c = norm(child);
  const r = norm(root);
  if (!c || !r) return false;
  return c === r || c.startsWith(r + path.sep) || c.startsWith(r + '/');
}
function clip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}
function stamp(iso) {
  return String(iso ?? '').replace('T', ' ').slice(0, 16);
}

/* ------------------------------------------------------------ 三个来源的行 */

/**
 * 流程：**一条实例的每一次办理 = 一行**（驳回打回会产生第 2、3 次，它们各自是一行）。
 * 项目与全局共用：调用方拿 run 来（全局那边按 run 自己的 `projectId` 贴标签）。
 */
function flowRows(run) {
  return store.listWorkflowTasks(run.id).map((t) => {
    const persona = t.assigneePersonaId ? store.getPersona(t.assigneePersonaId) : null;
    return {
      source: 'flow',
      source_text: '流程',
      task_id: t.id, // 这行的身份：同一次办理不许在别处再算一遍
      task: clip(`${run.title} · ${t.nodeName}${t.visit > 1 ? `（第 ${t.visit} 次办理）` : ''}`, TASK_LIMIT),
      status: String(t.status || ''),
      col: COL_OF_FLOW[t.status] ?? 'other',
      rank: FLOW_RANK[t.status] ?? RANK_OTHER,
      assignee: persona?.name ?? '（没点名）',
      // 执行人的 **id**，不只是名字：员工详情要按人筛（改名不跑、撞名不串，见 personaTasks）
      assignee_id: t.assigneePersonaId ?? null,
      at: stamp(t.endedAt ?? t.startedAt ?? run.updatedAt),
      note: t.note ? clip(t.note, NOTE_LIMIT) : `流程${run.status === '进行中' ? '进行中' : `已${run.status.replace(/^已/, '')}`}`,
      flow_id: run.id,
      flow_title: run.title,
      template_id: run.templateId,
      flow_status: run.status,
      node_id: t.nodeId,
      visit: t.visit,
    };
  });
}

/**
 * 本地卡（存在 `project_tasks` 里的）：人在列头「＋」建的手工卡，与**仓库值班**写进来的卡。
 * 同一族、同一张表 —— 都能拖（**卡的状态就是人给它的指令**）、都能删。
 */
const SOURCE_TEXT = { manual: '手动', repo: '仓库值班' };

function manualRows(t) {
  const persona = t.assigneePersonaId ? store.getPersona(t.assigneePersonaId) : null;
  const source = t.source ?? 'manual';
  return {
    source,
    source_text: SOURCE_TEXT[source] ?? '手动',
    task: clip(t.title, TASK_LIMIT),
    status: t.status,
    col: COL_OF_MANUAL[t.status] ?? 'other',
    rank: FLOW_RANK[t.status] ?? RANK_OTHER,
    assignee: persona?.name ?? '（没派活）',
    assignee_id: t.assigneePersonaId ?? null,
    at: stamp(t.updatedAt),
    note: t.description ? clip(t.description, NOTE_LIMIT) : '手工建的任务',
    // 行 id：拖拽 / 改状态 / 删卡都走它（手工卡与仓库值班卡共用这一套）
    manual_id: t.id,
    external_key: t.externalKey ?? null,
    // PR 联动（2026-10-17）：看板卡片上一眼看到"这个 PR 开着还是合了"
    pr: t.prRepo && t.prNumber ? { repo: t.prRepo, number: t.prNumber, state: t.prState ?? null, title: t.prTitle ?? null } : null,
    conversation_id: t.conversationId,
    run_id: t.runId,
  };
}

/**
 * 一个会话归谁 —— **两张面板共用这一处判据**。
 *
 *   · 会话挂了项目：以项目为准，直接认（最权威）；
 *   · 没挂项目：按**执行人的工作目录**兜底 —— 多个项目都包含它时**选最具体的那个**
 *     （项目目录允许嵌套：在「班底」下面再建一个子项目时，两边的根都包含它）；
 *   · **执行人查不到（员工被删、这条执行没记人）或他没有工作目录 → 不归属**
 *     （进全局面板的「未归属」）。绝不拿服务进程的 cwd 去蒙 —— 那是平台的目录，不是他的。
 *
 * 返回 { project, specificity }，specificity 只用来在嵌套时比"谁更具体"。
 */
function chatOwnership(conv, chatRun, projects) {
  if (conv.projectId) {
    const p = projects.find((x) => x.id === conv.projectId);
    return p ? { project: p, specificity: Number.MAX_SAFE_INTEGER } : null;
  }
  const persona = chatRun.personaId ? store.getPersona(chatRun.personaId) : null;
  if (!persona?.cwd) return null; // 没有归属依据 = 谁都不认领（别拿进程 cwd 顶上，见 norm 的注释）
  let best = null;
  for (const p of projects) {
    for (const root of store.projectRoots(p) ?? []) {
      if (!under(persona?.cwd, root)) continue;
      const specificity = norm(root).length;
      if (!best || specificity > best.specificity) best = { project: p, specificity };
    }
  }
  return best;
}

/**
 * 聊天：一个会话的**最近一轮聊天 = 一行**；全被流程占用的会话不算。
 *
 * `scope` = 只看某个项目的 id（项目看板）或 null（全局面板：所有会话都收）。
 * 行上**总是**带 `project_id` / `project_name`（没人认领就是 `NO_PROJECT`）——
 * 项目看板那边调用方会把这两个字段摘掉（它整页就是这一个项目，标了反而乱）。
 */
function chatRows(projects, scope) {
  const rows = [];
  for (const conv of store.listConversations()) {
    // 任务卡的工单会话（kind='exec'）**不算「聊天派活」**：它自己就是那张任务卡，
    // 评论派活 / 开工都归在卡下，再投影一张「聊天派活」卡就是同一件事重复出现（2026-10-19）。
    if (conv.kind === 'exec') continue;
    const runs = store.listRuns(conv.id); // 已按开始时间倒序
    if (!runs.length) continue; // 建了会话没派过活，不算任务
    const chatRun = runs.find((r) => !store.runBelongsToWorkflow(r));
    if (!chatRun) continue; // 这个会话里的活全是流程派进来的

    const own = chatOwnership(conv, chatRun, projects);
    const owner = own?.project ?? null;
    if (scope && owner?.id !== scope) continue; // 项目看板：只要本项目的

    const persona = chatRun.personaId ? store.getPersona(chatRun.personaId) : null;
    const lastUser = store.lastUserMessage(conv.id);
    const statusText = CHAT_STATUS_TEXT[chatRun.status] ?? String(chatRun.status || '');
    const how = conv.projectId ? '' : owner ? ' · 按工作目录归属' : ' · 没挂项目，也没落在任何项目目录下';
    rows.push({
      source: 'chat',
      source_text: '聊天派活',
      task: clip(lastUser || conv.title || '（没说做什么）', TASK_LIMIT),
      status: statusText,
      col: COL_OF_CHAT[statusText] ?? 'other',
      rank: CHAT_RANK[chatRun.status] ?? RANK_OTHER,
      assignee: persona?.name ?? conv.personaName ?? '（不知道是谁）',
      // 聊天行的"执行人"是**真正跑这一轮的人**（群里 @ 谁就是谁），不是会话归属人
      assignee_id: chatRun.personaId ?? null,
      at: stamp(chatRun.endedAt ?? chatRun.startedAt ?? conv.updatedAt),
      note: `会话：${conv.title}${conv.kind === 'group' ? '（群）' : ''}${how}`,
      conversation_id: conv.id,
      conversation_title: conv.title,
      run_id: chatRun.id,
      project_id: owner?.id ?? null,
      project_name: owner?.name ?? NO_PROJECT,
    });
  }
  return rows;
}

/* --------------------------------------------------------- 平表 → 看板 */

/**
 * 平表 → 看板（概览数字 + 看板列 + 行）。**两张面板共用这一处**：
 * 项目看板传这个项目的行，全局面板传所有项目的行 —— 列怎么分、卡怎么排、数字怎么数都一样。
 *
 * `extra` 是各面板自己的字段（项目信息 / 全局的按项目概览），原样带上。
 */
function board(rows, extra = {}) {
  const sorted = rows
    .slice()
    // 先按"要不要人管"，同档按时间新→旧
    .sort((a, b) => (a.rank - b.rank) || String(b.at).localeCompare(String(a.at)))
    .slice(0, MAX_ROWS);

  const count = (fn) => sorted.filter(fn).length;
  const byCol = new Map(COLUMNS.map((c) => [c.key, []]));
  for (const r of sorted) (byCol.get(r.col) ?? byCol.get('other')).push(r);
  const columns = COLUMNS.map((c) => {
    const cards = (byCol.get(c.key) ?? []).slice().sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return { key: c.key, label: c.label, hint: c.hint ?? '', count: cards.length, cards };
  }).filter((c) => c.key !== 'other' || c.count); // 「其他」列只在真有东西时才出现

  return {
    ...extra,
    total: sorted.length,
    chat_count: count((r) => r.source === 'chat'),
    manual_count: count((r) => r.source === 'manual'),
    repo_count: count((r) => r.source === 'repo'),
    // 跟看板「停下等人」那一列**同一个口径**：那一列收流程的「已阻塞」和聊天的「已停止」
    // （平台语义上它们同类，见上面 COLUMNS 的注释）。口径不一致的话，
    // 概览写 1、列里站着 1 张却是"已停止"，人就会怀疑哪边错了
    blocked_count: count((r) => r.status === '已阻塞' || r.status === '已停止'),
    failed_count: count((r) => r.status === '失败'),
    waiting_count: count((r) => r.status === '待确认'),
    columns,
    rows: sorted,
  };
}

/**
 * **项目看板**的数据形状（项目详情页直接拿它当数据）。
 * 项目不存在时返回 null，路由据此 404。
 */
export function projectTasks(project) {
  if (!project?.id) return null;
  const runs = store.listWorkflowRuns({ limit: 500 }).filter((r) => r.projectId === project.id);
  const rows = [
    ...runs.flatMap(flowRows),
    // 聊天行天生带 project_id / project_name（全局那边要用）—— 这一页整页就是它，
    // 摘掉再画，卡片上才不会每张都挂一枚"本项目"的标签
    ...chatRows([project], project.id).map(({ project_id, project_name, ...r }) => r),
    ...store.listProjectTasks(project.id).filter(notFlowCard).map(manualRows),
  ];

  return {
    project_id: project.id,
    project_name: project.name ?? '',
    root: project.root ?? '',
    // 概览里的"流程实例"数的是**实例**（rows 里是每一次办理，可能好几行）
    flow_count: runs.length,
    ...board(rows),
  };
}

/**
 * 所有项目的行：三源合流，每行带 `project_id` / `project_name`。
 *
 * 「全部」面板（`allTasks`）与「某个人的任务」（`personaTasks`）**共用这一处** ——
 * 两页说的是同一批事，只是筛的范围不同；各写一遍的话，一边多收一类活、另一页看不见，
 * 就成了"看板上 3 件、他详情里 2 件"这种没人说得清的分歧。
 *
 * `runs` 由调用方传：两个调用方都要拿它数 `flow_count`，别为了这点事再查一遍库。
 */
function allRows(projects, byId, runs) {
  const tag = (r, p) => ({ ...r, project_id: p?.id ?? null, project_name: p?.name ?? NO_PROJECT });
  return [
    ...runs.flatMap((run) => flowRows(run).map((r) => tag(r, byId.get(run.projectId)))),
    ...chatRows(projects, null), // 自己就带好了 project_id / project_name
    ...projects.flatMap((p) => store.listProjectTasks(p.id).filter(notFlowCard).map((t) => tag(manualRows(t), p))),
  ];
}

/**
 * **全局任务看板**（工作台 → 任务看板）：所有项目的活铺在同一张看板上。
 *
 * 跟项目看板同源、同列、同卡片，只多两件事：
 *   · 每行标出它属于哪个项目（`project_id` / `project_name`）；
 *   · **没挂项目、也没落在任何项目目录下的活也收**（`project_name = NO_PROJECT`）——
 *     项目看板看不见它们，而这里是"所有的活"；漏掉反而怪。
 *     流程实例没挂项目的那几个同理（项目删了以后 `projectId` 会被置空）。
 *
 * 每行只算一次：聊天行按会话算（不按项目），流程行按实例算，手工卡按卡算 ——
 * 所以全局的 total 不会因为"归属算了两遍"而虚高。
 */
export function allTasks() {
  const projects = store.listProjects();
  const byId = new Map(projects.map((p) => [p.id, p]));
  const runs = store.listWorkflowRuns({ limit: 500 });

  const rows = allRows(projects, byId, runs);
  const boarded = board(rows, {
    scope: 'all',
    project_count: projects.length,
    // 全局的"流程实例"= **所有**实例（项目看板那边只数本项目；这里没挂项目的实例也收，
    // 跟下面行里的「未归属」流程行对得上）
    flow_count: runs.length,
  });

  // 右侧那栏「按项目」：一行一个项目，一眼看出哪个项目堆着活、哪个卡住了。
  // ⚠️ 按**看板上真正画出来的行**分堆（`board()` 会截断到 MAX_ROWS）——
  // 拿没截断的行去数的话，超过上限时"共 N 件"跟各行之和会互相矛盾
  const mineOf = (id) => boarded.rows.filter((r) => (r.project_id ?? null) === id);
  const brief = (id, name) => {
    const mine = mineOf(id);
    return {
      project_id: id,
      project_name: name,
      total: mine.length,
      // 跟概览的 blocked_count / 看板「停下等人」那一列同一个口径
      blocked: mine.filter((r) => r.status === '已阻塞' || r.status === '已停止').length,
      waiting: mine.filter((r) => r.status === '待确认').length,
      failed: mine.filter((r) => r.status === '失败').length,
    };
  };
  const byProject = [
    ...projects.map((p) => brief(p.id, p.name ?? '')),
    // 没认领的那些也占一行，不然"按项目"加起来对不上总数
    ...(mineOf(null).length ? [brief(null, NO_PROJECT)] : []),
  ].filter((x) => x.total);

  return { ...boarded, by_project: byProject };
}

/**
 * **一个人的任务**（员工详情 → 任务）：跟全局面板**同一批行**，按执行人筛一遍。
 *
 * 为什么按 `assignee_id` 而不是名字：员工改名后旧卡还在他名下，两个人撞名也不会串。
 * 三种行这版都补了 `assignee_id`（流程行的经办人、手工卡的执行人、聊天行的实际执行人）。
 *
 * ⚠️ 一行 = **一件事的当前状态**，不是"他干过的所有事"：
 *   · 聊天行按会话只留最近一轮（见 `chatRows`）—— 所以他聊过 20 段会话，最多 20 行；
 *   · 流程行是**每次办理**一行（驳回打回会有第 2 次）。
 * 这跟看板的口径一致是有意的：两处数字对不上，人就不知道该信哪个。
 */
export function personaTasks(persona) {
  if (!persona?.id) return null;
  const projects = store.listProjects();
  const byId = new Map(projects.map((p) => [p.id, p]));
  const runs = store.listWorkflowRuns({ limit: 500 });
  const rows = allRows(projects, byId, runs).filter((r) => r.assignee_id === persona.id);

  return board(rows, {
    scope: 'persona',
    persona_id: persona.id,
    persona_name: persona.name,
    // 他的活横跨几个项目（概览那行用它说"分布在 N 个项目"）；没认领的不算
    project_count: new Set(rows.map((r) => r.project_id).filter(Boolean)).size,
    // 流程实例数按**他真办过的那几步**数，不按全局实例数
    flow_count: new Set(rows.filter((r) => r.source === 'flow').map((r) => r.flow_id)).size,
  });
}

/* ------------------------------------------------------------ 建一张手工卡 */

/** 手工卡允许的状态。`想法` 也在内 —— 那一列只能手工建（流程/聊天跑起来时早过了这个阶段） */
const MANUAL_STATUSES = new Set(['想法', '待办', '进行中', '待确认', '已阻塞', '已完成']);

/**
 * 在项目看板上**手工建一个任务**（用户 2026-10-14，参照 Multica 的「＋」）。
 *
 *   · 只填标题 = 一张挂在看板上的卡（不起进程、不派活）；
 *   · 选了执行人 + `startNow` → **立刻派活**（跟 Multica 那句"创建后 X 会立即开始工作"一致）：
 *     发到那个人的 1:1 会话里，工作目录就是这个项目，状态转「进行中」。
 *
 * 派活走的是和聊天完全相同的那条链路（dispatchToThread），不另造执行方式；
 * 失败不吞：卡照建，但状态留在「待办」并把原因抛出去，让人知道没跑起来。
 *
 * ⚠️ 手工卡**必须挂在某个项目下**（表里 projectId 非空、没有它看板也不认）——
 * 全局面板里点某一列的「＋」时，弹窗会让人先选一个项目，就是为这个。
 */
export function createProjectTask(project, { title, description = '', status = '待办', personaId = null, startNow = false } = {}) {
  const name = String(title ?? '').trim();
  if (!name) throw new Error('任务得有标题');
  const st = MANUAL_STATUSES.has(status) ? status : '待办';
  const persona = personaId ? store.getPersona(personaId) : null;
  if (personaId && !persona) throw new Error('选的这个人不在了');

  const row = store.createProjectTask({
    projectId: project.id,
    title: name,
    description: String(description ?? '').trim(),
    status: st,
    assigneePersonaId: persona?.id ?? null,
  });

  // 「想法」不该被立刻派活 —— 它是"还没决定要不要做"，谈不上开始；
  // 真派了的话卡刚建完就被转成「进行中」，那一列等于白建。
  // 前端也会把那个勾选框灰掉，但**判据放服务端**才作数（接口谁都能直接调）。
  if (!persona || !startNow || st === '想法') return store.getProjectTask(row.id);

  try {
    return startProjectTask(row.id);
  } catch (e) {
    // 没派出去也要说清楚：卡建了、状态没动
    throw Object.assign(new Error(`任务建好了，但没派出去：${e.message}`), { taskId: row.id });
  }
}

/**
 * 把一张**已经在看板上的**卡派出去（2026-10-17 从 `createProjectTask` 里抽出来的）。
 *
 * 为什么抽：建卡时那个「立即开始」、卡片详情里点「保存并开始工作」、以及**把卡拖进「进行中」**
 * 必须是**同一条链路** —— 各写一份迟早走样（跟流程引擎复用 `dispatchToThread` 同一个道理）。
 * 派到执行人的 1:1 会话，工作目录就是这个卡挂的项目。
 *
 * `allowIdea`：建卡时「想法」不该被 startNow 带去开工（那列刚建完就被转走，等于白建）；
 * 但人**亲手把卡从「想法」拖进「进行中」**是明确的指令，那时要放行（2026-10-17）。
 */
export function startProjectTask(id, { allowIdea = false } = {}) {
  const row = store.getProjectTask(id);
  if (!row) throw new Error('任务不存在');
  const project = store.getProject(row.projectId);
  if (!project) throw new Error('这张卡挂的项目已经不在了');
  if (!row.assigneePersonaId) throw new Error('先指定执行人，再开始');
  const persona = store.getPersona(row.assigneePersonaId);
  if (!persona) throw new Error('指定的执行人不在了');
  if (!allowIdea && row.status === '想法') throw new Error('「想法」还没决定要不要做，先挪到「待办」再开始');
  if (row.status === '进行中' && row.runId) throw new Error('这张卡已经在跑了');

  /*
   * **这张卡自己的工单会话**（2026-10-18）：一条卡一条，返工续它。
   * 原来派进执行人的 1:1 —— 卡越干越多，聊天上下文被撑爆，而且一个员工同一时刻
   * 只能干一件活。现在卡的往来只落在这条会话里，消息模块归到「手上的活」。
   */
  const conv = store.ensureExecConversation({
    personaId: persona.id,
    scope: `task:${row.id}`,
    title: `任务 · ${row.title}`,
    projectId: project.id,
  })?.id;
  if (!conv) throw new Error('这个执行人已经不在了');
  const constitution = projectConstitutionBlock(project.id);
  const text = [
    constitution,
    `【任务 · ${project.name || project.id}】${row.title}`,
    row.description ? `\n${row.description}` : '',
    `\n工作目录就是这个项目的目录：${project.root}`,
    '做完直接说明结果即可。',
  ]
    .filter(Boolean)
    .join('\n');
  try {
    const { run } = dispatchToThread(conv, text, { projectId: project.id });
    return store.updateProjectTask(row.id, {
      status: '进行中',
      conversationId: conv,
      runId: run.id,
      queuedAt: null,
    });
  } catch (e) {
    /*
     * 「忙」不是失败（2026-10-18）：人满了 / 项目里正有别的一件在跑 ——
     * 卡退回「待办」并落一个排队标记，30 秒节拍会再试（schedules.retryQueuedTasks）。
     * 别的错（运行时不可用之类）才是真失败，交给上层报出去。
     */
    if (e?.code === 'busy') {
      store.updateProjectTask(row.id, { status: '待办', runId: null, queuedAt: store.nowIso() });
      throw Object.assign(new Error(`排上队了：${e.message}（会自动再试，不用管）`), { code: 'busy' });
    }
    throw e;
  }
}

/**
 * 排队中的卡：30 秒节拍试着重派（撞忙时登记的 queuedAt，见 startProjectTask）。
 *
 * 为什么必须有：拆出工单会话之后，并发靠「每人上限 + 项目互斥」封 —— 派活会撞'忙'。
 * 撞上就退回「待办」等人点，等于把人变成了重试按钮；这条让它自己等一会儿再来。
 * 顺序先进先出；还忙就跳过等下一拍，真失败（运行时不可用…）才清掉标记。
 */
export function retryQueuedTasks() {
  const started = [];
  for (const t of store.listQueuedProjectTasks()) {
    if (!t.assigneePersonaId) {
      store.updateProjectTask(t.id, { queuedAt: null });
      continue;
    }
    try {
      startProjectTask(t.id);
      started.push(t.title);
    } catch (e) {
      if (e?.code === 'busy') continue; // 还忙，等下一拍
      store.updateProjectTask(t.id, { queuedAt: null }); // 真失败：别再无限重试
    }
  }
  return started;
}

/**
 * 运行跑完时把**卡片**的状态收一下（2026-10-17）。
 *
 * 为什么必须有这一步：原来卡片派活后状态永远停在「进行中」—— 人把运行停掉了，卡还写着「进行中」，
 * 看板上看不出"这活已经停了、在等人处理"。
 *
 * 落点（用户定的口径，别改）：
 *   · 跑完了（`完成`）        → **待确认**：等经办人确认结果；
 *   · 人停的 / 跑挂了（`已停止` / `失败`） → **已阻塞**：进「停下等人」，管理员看到再处理。
 *     ⚠️ **绝不回「待办」**：有些待办会被自动重新派活，失败一次就再派一次 —— 死循环。
 *
 * 只动"当前还是进行中"的卡：人已经手动改过状态（比如直接拖到已完成）就不覆盖 —— **卡的状态是人的指令**。
 */
export function onTaskRunFinished(run) {
  if (!run?.id) return;
  const task = store.getProjectTaskByRunId(run.id);
  if (!task || task.status !== '进行中') return;
  const next =
    run.status === '完成' ? '待确认' : run.status === '已停止' || run.status === '失败' ? '已阻塞' : null;
  if (!next) return;
  const why =
    run.status === '完成'
      ? '跑完了，等你确认'
      : run.status === '已停止'
        ? '被人停掉了，等你处理'
        : `跑挂了${run.error ? `：${String(run.error).split('\n')[0].slice(0, 200)}` : ''}`;
  const descr = `${task.description ?? ''}`.trim();
  store.updateProjectTask(task.id, {
    status: next,
    description: `${descr}${descr ? '\n\n' : ''}---\n[运行结束] ${why}`,
  });
}

/**
 * PR 合并后把卡收一下（2026-10-17）：**只把「进行中」改成「待确认」**。
 *
 * 为什么不直接「已完成」：卡的状态是**人给的指令**（合并 ≠ 验收通过）。
 * 其他状态一律不动 —— 人已经拖到「已完成」的，别覆盖。
 */
export function afterMerged(task) {
  if (!task) return task;
  if (task.prState === 'merged' && task.status === '进行中') {
    return store.updateProjectTask(task.id, { status: '待确认' });
  }
  return task;
}

/**
 * **仓库值班写卡**（2026-10-17）：巡检（本机脚本，或平台里的定时任务）把"要人管的事"写进看板。
 *
 * 两条规矩，缺一不可：
 *   · **去重** —— 按 `projectId + externalKey` 找同一张卡（`pr:5` / `issue:2` / `note:x`）；
 *   · **保护人的指令** —— 重复巡检只更新标题与描述，**状态一律不动**（拖到「已完成」＝ 批准，删掉 ＝ 忽略）。
 *
 * `pr` 由 `git-repos.prFieldsOf()` 归一；只有真变了才写 —— 每次巡检都报"更新"，
 * 那个 ↻ 符号就没人信了。报上来是 merged 且卡在「进行中」，照样收成「待确认」（`afterMerged`）。
 *
 * 抽成函数是因为**两个调用方**：HTTP 的 `/api/projects/:id/repo-cards`（本机脚本用）
 * 与平台内的「PR 巡检」定时动作（直接调）。两处各写一遍迟早会跑偏。
 */
export function upsertRepoCard({ projectId, key, title, description = '', pr = null }) {
  // `pr` 必须是 `git-repos.prFieldsOf()` 归一过的五个字段；少一个就当没带（宁可不写，也别写半截）
  const patchPr = pr?.prRepo && pr?.prNumber ? pr : null;
  const existing = store.getProjectTaskByExternalKey(projectId, key);
  if (existing) {
    const patch = {};
    if (existing.title !== title) patch.title = title;
    if (existing.description !== description) patch.description = description;
    if (
      patchPr &&
      (existing.prRepo !== patchPr.prRepo ||
        existing.prNumber !== patchPr.prNumber ||
        existing.prState !== patchPr.prState ||
        existing.prTitle !== patchPr.prTitle)
    ) {
      Object.assign(patch, patchPr);
    }
    const changed = Object.keys(patch).length > 0;
    const next = changed ? store.updateProjectTask(existing.id, patch) : existing;
    return { task: changed ? afterMerged(next) : next, created: false, changed };
  }
  const task = store.createProjectTask({ projectId, title, description, status: '待办', source: 'repo', externalKey: key });
  const withPr = patchPr ? store.updateProjectTask(task.id, patchPr) : task;
  return { task: patchPr ? afterMerged(withPr) : withPr, created: true, changed: true };
}

/**
 * 改一张手工卡（状态 / 执行人 / 标题描述）。只动手工卡，流程与聊天的卡改不了这里。
 *
 * ── **拖到「进行中」＝开工**（2026-10-17 用户要求对齐 Multica）──────────────
 * Multica 的口径是：状态本身不是触发器，**「已指派 + 状态到位」**才是 ——
 * backlog 是停车场（分配了也不跑），移到 todo 那一刻已指派的 agent 立即开工。
 *
 * 我们的列与它一一对应：想法 ↔ backlog、待办 ↔ todo、进行中 ↔ in_progress。
 * 所以这里的规则是：**卡从别的列被拖进「进行中」/ 状态改成「进行中」，而它已经有执行人
 * → 走和「开始工作」按钮完全相同的那条链路派活**（`startProjectTask`），不是另造一套。
 *
 * 两个刻意的选择：
 *   · **没执行人的卡拖进来只改状态，不报错** —— Multica 也是这样（人的活不需要 agent）。
 *     硬拦的话，"我自己干"这种用法就没了。
 *   · **派不出去就退回原状态**：卡要是留在「进行中」却没跑，看板上就成了一句假话。
 *     所以我们**先不写状态**，让 `startProjectTask` 一起写「进行中 + runId」；
 *     它抛错就什么都不动，把原因原样带出去（"没开工：他还在跑上一条…"）。
 */
export function updateProjectTask(id, fields = {}, { autoStart = true } = {}) {
  const cur = store.getProjectTask(id);
  if (!cur) throw new Error('任务不存在');
  const patch = {};
  if (fields.title !== undefined) {
    const t = String(fields.title).trim();
    if (!t) throw new Error('任务得有标题');
    patch.title = t;
  }
  if (fields.description !== undefined) patch.description = String(fields.description).trim();
  if (fields.status !== undefined) {
    if (!MANUAL_STATUSES.has(fields.status)) throw new Error(`不认识的状态：${fields.status}`);
    patch.status = fields.status;
  }
  if (fields.personaId !== undefined) {
    if (fields.personaId && !store.getPersona(fields.personaId)) throw new Error('选的这个人不在了');
    patch.assigneePersonaId = fields.personaId || null;
  }

  // 「拖进进行中」这一下要不要顺便开工 —— 看**改完之后**有没有执行人（本次改的优先）
  const toDoing = autoStart && patch.status === '进行中' && cur.status !== '进行中';
  const whoId = patch.assigneePersonaId !== undefined ? patch.assigneePersonaId : cur.assigneePersonaId;
  if (toDoing && whoId) {
    delete patch.status; // 状态交给 startProjectTask 一起落（进行中 + runId）
    const saved = store.updateProjectTask(id, patch);
    try {
      return startProjectTask(saved.id, { allowIdea: true });
    } catch (e) {
      // 状态还是原来那个（我们压根没写），字段改动留着 —— 别让人重填一遍
      throw Object.assign(new Error(`没开工：${e.message}`), { taskId: id, statusUnchanged: true });
    }
  }

  /*
   * **「待办」+ 已指定执行人 = 自动开工**（2026-10-18 用户定的口径）：
   * 想法阶段在评论区聊熟 → 状态改成「待办」→ 指定了人 → 自动流转下去，不用再点「开始工作」。
   *
   * 只在这两种变化上触发（顺手改个描述不该开跑）：
   *   · 状态从别的列改成「待办」。**「进行中」除外** —— 从跑着拖回「待办」是"停"，
   *     反手再派一次等于停不下来；
   *   · 卡本来就在「待办」，这次新指定/换了执行人（先改待办、后点人，顺序反过来也认）。
   * 「想法」阶段不跑（还没决定要不要做）；没指定人也不跑（那只是停车场）。
   */
  const nextStatus = patch.status !== undefined ? patch.status : cur.status;
  const becameTodo = autoStart && nextStatus === '待办' && !!whoId && (
    (patch.status === '待办' && cur.status !== '待办' && cur.status !== '进行中') ||
    (cur.status === '待办' && patch.assigneePersonaId !== undefined && !!patch.assigneePersonaId && patch.assigneePersonaId !== cur.assigneePersonaId)
  );
  if (becameTodo) {
    const saved = store.updateProjectTask(id, patch); // 先落「待办」：startProjectTask 会把它推进「进行中」
    try {
      return startProjectTask(saved.id);
    } catch (e) {
      // 忙 → startProjectTask 已经把它留在「待办」+ 落了排队标记（节拍会自己再试）；别的错也停在待办
      throw Object.assign(new Error(`已改成「待办」，但没派出去：${e.message}`), { taskId: id, autoStartFailed: true });
    }
  }
  return store.updateProjectTask(id, patch);
}

/* ------------------------------------------ 流程的一步 → 一张任务卡（2026-10-19） */

/**
 * 这一步**对应的那张卡**：有就返回它，没有就**现开一张**并把它认下来。
 *
 * 为什么要这个口子：
 *   流程页那枚「对话」原来只弹一条窄栏，人想看的却是"这一步的活干成什么样、能不能改状态"。
 *   那正好是任务卡的形状 —— 但两边**在库里是两张表**：
 *     · 流程步骤 `workflow_tasks`（`wt2-xxx`，一笔办理一条）
 *     · 任务卡 `project_tasks`（`pt-xxx`，能拖能改能派活）
 *   拿 `wt2-` 去查任务卡直接 404。所以这里是那座桥：拿"某条流程的某一步"换一张卡。
 *
 * 怎么避免重复开卡（返回的时候进来两次就会开两张）——两道:
 *   ① `sourceKey = 'flow:<runId>:<nodeId>:<visit>'`，跟着卡一起存；
 *      **靠它找回已有的那张**（老卡没有这个字段，也能按标题兜一次，见 ②）；
 *   ② 老卡兜底：项目里已有一张「标题 = `<流程名> · <节点名>`」的卡就是它 ——
 *      那正是看板上流程行的写法（见 flowRows），人看着就是同一件事，不该再开一张。
 *
 * 卡上记 `sourceKey` / `sourceRunId`：**只用来认身份，不改它的脾气** ——
 * 它照样能拖、能改状态、能派活（跟手建的卡一样）。流程自己那套状态（`workflow_tasks`）
 * 不受这张卡影响：一个说"流程走到哪一步了"，一个说"这件事我知道不知道、
 * 要不要人盯着" —— 两件事，两个地方记，不强行同步（同步了反而会互相覆盖）。
 */
export function ensureTaskCardForStep(run, task) {
  if (!run || !task) throw new Error('找不到这一步');
  if (!run.projectId) throw new Error('这条流程没挂项目 —— 卡必须有地方放');
  const project = store.getProject(run.projectId);
  if (!project) throw new Error('这条流程挂的项目已经不在了');

  const sourceKey = `flow:${run.id}:${task.nodeId}:${task.visit ?? 1}`;
  const existing = store.listProjectTasks(project.id).find((t) => t.sourceKey === sourceKey)
    // 老卡（这一步之前被当成手工卡建过）：标题对得上就算 —— 只在没有 sourceKey 的记录里找
    ?? store.listProjectTasks(project.id).find(
      (t) => !t.sourceKey && String(t.title ?? '') === stepCardTitle(run, task),
    );
  if (existing) {
    // 认下来，下次就走 ① 那条快路
    if (!existing.sourceKey || !existing.sourceRunId) {
      return store.updateProjectTask(existing.id, { sourceKey, sourceRunId: run.id });
    }
    return existing;
  }

  /**
   * 状态**照这一步当下的状态**起（看板上就落在原来那列），不一律写成「待办」——
   * 写「待办」会让一张"其实已经办完了"的卡在看板上跑到最前面去，还平白多一件待办。
   * 「待办」+ 已指派人会自动开工（见 updateProjectTask 的口径），所以这里**不走那条路**：
   * 用 `createProjectTask` 建完直接补字段，不触发派活 —— 卡是"这一笔办理的档案"，
   * 不是新派出去的活。
   */
  return store.createProjectTask({
    projectId: project.id,
    title: stepCardTitle(run, task),
    description: stepCardDescription(run, task),
    status: MANUAL_STATUSES.has(task.status) ? task.status : '待办',
    assigneePersonaId: task.assigneePersonaId ?? null,
    // ⚠️ sourceKey 必须**跟建卡同一条 INSERT**，不能建完再 update：
    //    中间崩一下就会留一张没有身份的卡，下次点进来又建一张（node:sqlite 没有
    //    better-sqlite3 的 db.transaction() 助手，两句话不在一个事务里）
    sourceKey,
    sourceRunId: run.id,
  });
}

/** 卡标题：跟看板流程行同一个写法（`流程名 · 节点名`），带第几次办理 */
function stepCardTitle(run, task) {
  const visit = task.visit > 1 ? `（第 ${task.visit} 次办理）` : '';
  return clip(`${run.title} · ${task.nodeName}${visit}`, TASK_LIMIT);
}

/** 卡描述：把这一步的起因写清楚 —— 打开卡的人（哪怕是几天后的自己）得知道它在哪条流程上 */
function stepCardDescription(run, task) {
  return [
    `流程：${run.title}（${run.status}）`,
    `这一步：${task.nodeName}${task.visit > 1 ? `（第 ${task.visit} 次办理）` : ''}`,
    run.intent ? `\n起因：${run.intent}` : '',
  ].join('\n').trim();
}
