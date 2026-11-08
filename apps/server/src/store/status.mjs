/*
 * store/status.mjs —— 状态词表（2026-11-08）。
 *
 * **为什么单独一个文件**：状态是这套系统里最贵的一处「事实」—— 看板列、流程步骤、
 * 运行结果、聊天回执都要落成同几个中文词，而它们原先分散在四处：
 *   · `project-tasks.mjs` 的 COLUMNS / COL_OF_FLOW / COL_OF_CHAT / COL_OF_MANUAL /
 *     STATUS_OF_COL / MANUAL_STATUSES / CHAT_STATUS_TEXT
 *   · `db.mjs` 里各表的 `DEFAULT '待办'`
 *   · `workflows.mjs` 里的三处三元
 *   · 前端 `projects.mjs` / `flowpages.mjs` 里的字面量
 * 改一个词要改六处，漏一处不报错 —— 只是某张卡在某一列上「不见了」。
 *
 * 这里只放**纯词表与映射**：不碰 db、不碰 DOM、不碰任何 IO。所以它既能在 store/ 里被
 * 域模块引用，也能被冒烟用例单独 import（不打开数据库）。
 *
 * 规矩（新增状态时照做）：
 *   ① 先加进 TASK_STATUS，再在 TASK_COL_OF 里给它一列 —— 两步都做，冒烟会检查两边对齐；
 *   ② `db.mjs` 的建表默认值只能用这里的词（冒烟按源码文本核对，写错词会红）；
 *   ③ 前端只认服务端下发的词，不要在 JS 里另写一份列表。
 *
 * 历史（别再改回去）：
 *   · 「待开始」→「待办」（2026-10-17）：同一个意思两个词，只会让人问"差在哪"；
 *   · 「待确认」→「待审批」→「待验收」（2026-10-24）：「干完了等你点头」和「出问题等人
 *     拍板」是两类等待，名字必须把"等什么"说出来，否则两列分不开（后者是「已阻塞」）。
 */

/** 任务卡的八态（看板列 = 这八态 + 一个「其他」兜底列，见 project-tasks.mjs 的 COLUMNS） */
export const TASK_STATUS = Object.freeze({
  IDEA: '想法',
  TODO: '待办',
  DOING: '进行中',
  REVIEW: '待验收',
  BLOCKED: '已阻塞',
  FAILED: '失败',
  DONE: '已完成',
  CANCELLED: '已取消',
});

/** 状态 → 看板列的 key（唯一定义处；反向映射由它推出，别手写第二份） */
export const TASK_COL_OF = Object.freeze({
  [TASK_STATUS.IDEA]: 'idea',
  [TASK_STATUS.TODO]: 'todo',
  [TASK_STATUS.DOING]: 'doing',
  [TASK_STATUS.REVIEW]: 'review',
  [TASK_STATUS.BLOCKED]: 'blocked',
  [TASK_STATUS.FAILED]: 'failed',
  [TASK_STATUS.DONE]: 'done',
  [TASK_STATUS.CANCELLED]: 'cancelled',
});

/** 列 key → 状态（点某列的「＋」时新建卡的默认状态） */
export const TASK_STATUS_OF_COL = Object.freeze(
  Object.fromEntries(Object.entries(TASK_COL_OF).map(([status, col]) => [col, status])),
);

/**
 * 看板列的**从左到右**顺序（生命周期序，2026-10-14 定的形状）。
 * 派生自 TASK_COL_OF 的书写顺序 —— 所以「加一个状态」在 TASK_COL_OF 里插一行，
 * 列顺序自动跟着走，不用再从两个地方对齐。
 */
export const TASK_COL_ORDER = Object.freeze(Object.values(TASK_COL_OF));

/**
 * 流程 / 聊天派出来的卡只可能落在中间这六态：`想法`是"还没决定要不要做"、
 * `已取消`是"决定不做了" —— 两者都只可能由**人手工**给，引擎不会自己走到那儿。
 */
export const FLOW_STATUS = Object.freeze([
  TASK_STATUS.TODO,
  TASK_STATUS.DOING,
  TASK_STATUS.REVIEW,
  TASK_STATUS.BLOCKED,
  TASK_STATUS.FAILED,
  TASK_STATUS.DONE,
]);

/** 流程卡：状态 → 列（FLOW_STATUS 的子集投影） */
export const FLOW_COL_OF = Object.freeze(
  Object.fromEntries(FLOW_STATUS.map((s) => [s, TASK_COL_OF[s]])),
);

/** 手工卡：状态 → 列（八态全覆盖） */
export const MANUAL_COL_OF = TASK_COL_OF;

/** 手工卡允许的八态（写卡时用来"不认识就落回待办"） */
export const MANUAL_STATUS = Object.freeze([...Object.keys(TASK_COL_OF)]);

/**
 * 聊天派出来的卡：**卡面状态 → 列**。
 *
 * 注意这跟下面那张表不是一回事：卡面上写的是「已停止」（人停的），但**落进「已阻塞」列**
 * —— 人停掉一次运行 = 这活要人决定下一步，语义同类（列名和卡面名各说各的，别洗掉）。
 */
export const CHAT_COL_OF = Object.freeze({
  [TASK_STATUS.DOING]: 'doing',
  [TASK_STATUS.DONE]: 'done',
  [TASK_STATUS.FAILED]: 'failed',
  已停止: 'blocked',
});

/**
 * **运行终态 → 卡面状态**（人看的说法）。流程 / 手工卡用统一八态，只有聊天行需要翻译：
 * 一次运行的「跑中」在卡上叫「进行中」——同一个东西在两个语境里的习惯叫法。
 */
export const CHAT_RUN_TEXT = Object.freeze({
  跑中: TASK_STATUS.DOING,
  完成: TASK_STATUS.DONE,
  失败: TASK_STATUS.FAILED,
  已停止: '已停止',
});

/**
 * 一次运行的生命周期（`runs.status`）。**七个词，每个都有明确来历**：
 *
 *   · **待跑**   = 已建好记录、进程还没起来（`DEFAULT '待跑'`）；
 *   · **跑中**   = 子进程在跑；
 *   · **完成/失败** = 正常收尾 / 技术上跑挂（重跑可能就过）；
 *   · **已停止** = 人点了停止（`stoppedByUser`）—— **人的决定**；
 *   · **中断**   = 服务重启 / 进程没了，运行从内存消失后补记的（routes/run.mjs）—— **事故**；
 *   · **受阻**   = agent 主动举手要人拍板（`[受阻] 原因`），流程把它折成 blocked。
 *
 * 「已停止」和「中断」必须分开：混成一个词，事后分不清"我停的"和"它自己没的"。
 */
export const RUN_STATUS = Object.freeze({
  PENDING: '待跑',
  RUNNING: '跑中',
  DONE: '完成',
  FAILED: '失败',
  STOPPED: '已停止',
  INTERRUPTED: '中断',
  BLOCKED: '受阻',
});

/**
 * 节点作业的生命周期（`node_jobs` / `node_tasks`）—— 跟上面两套**不是一回事**，
 * 别为了"统一"把它们并进去：那是**另一台机器上的活**的领取状态，
 * 卡和流程根本看不见它。
 */
export const NODE_JOB_STATUS = Object.freeze({
  PENDING: '待领',
  RUNNING: '执行中',
  REPORTED: '已回执',
  DONE: '完成',
  FAILED: '失败',
});

/** 这个状态认不认识（写库前判"是不是自己人"用） */
export function isTaskStatus(v) {
  return Object.hasOwn(TASK_COL_OF, String(v));
}

/** 这个运行终态认不认识 */
export function isRunStatus(v) {
  return Object.values(RUN_STATUS).includes(String(v));
}
