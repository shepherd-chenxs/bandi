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
import { dispatchToThread } from './dispatch.mjs';

/** 排序权重：越小越"要人管"（平表用它；看板按列站队，不看这个） */
const FLOW_RANK = { 已阻塞: 0, 失败: 1, 待确认: 2, 进行中: 3, 待开始: 4, 已完成: 5, 想法: 6 };
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
const COL_OF_FLOW = { 待开始: 'todo', 进行中: 'doing', 待确认: 'confirm', 已阻塞: 'blocked', 失败: 'failed', 已完成: 'done' };
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
 * 手工任务：一行 = 一张卡（没派人就只是张卡，派了人并"立即开始"才真的跑起来）。
 * 项目与全局共用；全局那边自己贴 `project_id`（手工卡一定挂在某个项目下）。
 */
function manualRows(t) {
  const persona = t.assigneePersonaId ? store.getPersona(t.assigneePersonaId) : null;
  return {
    source: 'manual',
    source_text: '手动',
    task: clip(t.title, TASK_LIMIT),
    status: t.status,
    col: COL_OF_MANUAL[t.status] ?? 'other',
    rank: FLOW_RANK[t.status] ?? RANK_OTHER,
    assignee: persona?.name ?? '（没派活）',
    at: stamp(t.updatedAt),
    note: t.description ? clip(t.description, NOTE_LIMIT) : '手工建的任务',
    manual_id: t.id,
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
    ...store.listProjectTasks(project.id).map(manualRows),
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
  const tag = (r, p) => ({ ...r, project_id: p?.id ?? null, project_name: p?.name ?? NO_PROJECT });
  const runs = store.listWorkflowRuns({ limit: 500 });

  const rows = [
    ...runs.flatMap((run) => flowRows(run).map((r) => tag(r, byId.get(run.projectId)))),
    ...chatRows(projects, null), // 自己就带好了 project_id / project_name
    ...projects.flatMap((p) => store.listProjectTasks(p.id).map((t) => tag(manualRows(t), p))),
  ];
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

  // 派到他的 1:1 会话（没有就建一个）——跟流程派活用同一条链路
  const conv =
    store.listConversations().find((c) => c.kind === 'direct' && c.personaId === persona.id && !c.hiddenAt)?.id ??
    store.ensureConversationForPersona(persona.id).id;
  const text = [
    `【任务 · ${project.name || project.id}】${name}`,
    row.description ? `\n${row.description}` : '',
    `\n工作目录就是这个项目的目录：${project.root}`,
    '做完直接说明结果即可。',
  ]
    .filter(Boolean)
    .join('\n');
  try {
    const { run } = dispatchToThread(conv, text, { projectId: project.id });
    return store.updateProjectTask(row.id, { status: '进行中', conversationId: conv, runId: run.id });
  } catch (e) {
    // 没派出去也要说清楚：卡建了、状态没动
    throw Object.assign(new Error(`任务建好了，但没派出去：${e.message}`), { taskId: row.id });
  }
}

/** 改一张手工卡（状态 / 执行人 / 标题描述）。只动手工卡，流程与聊天的卡改不了这里。 */
export function updateProjectTask(id, fields = {}) {
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
  return store.updateProjectTask(id, patch);
}
