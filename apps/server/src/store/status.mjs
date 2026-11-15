/*
 * store/status.mjs —— 状态词表（2026-11-08 建，2026-11-12 改成「码是唯一真身」）。
 *
 * **为什么单独一个文件**：状态是这套系统里最贵的一处「事实」—— 看板列、流程步骤、
 * 运行结果、聊天回执都要落成同几个状态，而它们原先分散在四处：
 *   · `project-tasks.mjs` 的 COLUMNS / COL_OF_FLOW / COL_OF_CHAT / COL_OF_MANUAL /
 *     STATUS_OF_COL / MANUAL_STATUSES / CHAT_STATUS_TEXT
 *   · `db.mjs` 里各表的 `DEFAULT '待办'`
 *   · `workflows.mjs` 里的三处三元
 *   · 前端 `projects.mjs` / `flowpages.mjs` 里的字面量
 * 改一个词要改六处，漏一处不报错 —— 只是某张卡在某一列上「不见了」。
 *
 * ---------------------------------------------------------------- 码 / 名称（2026-11-12）
 *
 * **系统里永远只有一个状态真身：码（code）。** 中文不是第二个状态，只是这张词表里
 * 给码配的**显示名（label）**，除了渲染界面、拼人话提示，任何地方都不该拿它判等、写库。
 *
 * 为什么（2026-11-12 实报）：数字员工建卡连着两次 400 E2058 —— 一次是中文状态在
 * Windows 的 shell 里被编码打烂成 `??`（重试 9 次全废），一次是模型改写成 `todo`
 * 而接口只认「待办」。两种都是"同一个状态有两种表示"的后果：只要有第二套写法，
 * 就一定有人写第二套。所以现在：
 *   · 入参只收**码**，中文名一律 400（报错里附码表，让他照抄）；
 *   · 库里只存**码**（老库启动时由 `db.mjs` 一次性迁移，见 LEGACY_* 表）；
 *   · 判等/投影/统计只认**码**；
 *   · 中文只出现在 label（本文件 TASK_LABEL / RUN_LABEL / NODE_JOB_LABEL），
 *     前端从 `GET /api/status/dict` 取，**不许在 JS 里另写一份列表**。
 *
 * 码用英文 slug 而不是 1..8：slug 本来就等于看板列的 key（列序改了不会变义），
 * 纯 ASCII 也不会被任何 shell / 编码环节打烂。
 *
 * ---------------------------------------------------------------- 规矩
 *
 *   ① 先加进 TASK_STATUS，再在 TASK_COL_OF 里给它一列 —— 两步都做，冒烟会检查两边对齐；
 *   ② `db.mjs` 的建表默认值只能用这里的码（冒烟按源码文本核对，写错码会红）；
 *   ③ 前端只认服务端下发的码 + label，不要在 JS 里另写一份列表。
 *
 * 历史（别再改回去）：
 *   · 「待开始」→「待办」（2026-10-17）：同一个意思两个词，只会让人问"差在哪"；
 *   · 「待确认」→「待审批」→「待验收」（2026-10-24）：「干完了等你点头」和「出问题等人
 *     拍板」是两类等待，名字必须把"等什么"说出来，否则两列分不开（后者是「已阻塞」）；
 *   · 中文状态值 → 英文码（2026-11-12）：见上面那段，只留一套表示。
 */

/** 任务卡的八态（看板列 = 这八态 + 一个「其他」兜底列，见 project-tasks.mjs 的 COLUMNS） */
export const TASK_STATUS = Object.freeze({
  IDEA: 'idea',
  TODO: 'todo',
  DOING: 'doing',
  REVIEW: 'review',
  BLOCKED: 'blocked',
  FAILED: 'failed',
  DONE: 'done',
  CANCELLED: 'cancelled',
});

/** 码 → 显示名（**全系统唯一一份中文状态名**；只给界面和人话提示用，禁止拿来判等） */
export const TASK_LABEL = Object.freeze({
  [TASK_STATUS.IDEA]: '想法',
  [TASK_STATUS.TODO]: '待办',
  [TASK_STATUS.DOING]: '进行中',
  [TASK_STATUS.REVIEW]: '待验收',
  [TASK_STATUS.BLOCKED]: '已阻塞',
  [TASK_STATUS.FAILED]: '失败',
  [TASK_STATUS.DONE]: '已完成',
  [TASK_STATUS.CANCELLED]: '已取消',
});

/** 状态码 → 看板列 key（码即列 key，映射恒等；保留这层是为了调用方读起来有语义） */
export const TASK_COL_OF = Object.freeze(
  Object.fromEntries(Object.values(TASK_STATUS).map((code) => [code, code])),
);

/** 列 key → 状态码（点某列的「＋」时新建卡的默认状态；同样恒等） */
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
 * 流程 / 聊天派出来的卡只可能落在中间这六态：`idea` 是"还没决定要不要做"、
 * `cancelled` 是"决定不做了" —— 两者都只可能由**人手工**给，引擎不会自己走到那儿。
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

/** 手工卡允许的八态（写卡时用"不认识就落回 todo"） */
export const MANUAL_STATUS = Object.freeze([...Object.keys(TASK_COL_OF)]);

/**
 * 聊天派出来的卡：**卡面状态码 → 列**。
 *
 * 注意这跟下面那张表不是一回事：卡面上写的是 `stopped`（人停的），但**落进 `blocked` 列**
 * —— 人停掉一次运行 = 这活要人决定下一步，语义同类（列 key 和卡面码各说各的，别洗掉）。
 */
export const CHAT_COL_OF = Object.freeze({
  [TASK_STATUS.DOING]: 'doing',
  [TASK_STATUS.DONE]: 'done',
  [TASK_STATUS.FAILED]: 'failed',
  stopped: 'blocked',
});

/**
 * **运行终态码 → 卡面状态码**。流程 / 手工卡用统一八态，只有聊天行需要翻译：
 * 一次运行的 `running` 在卡上叫 `doing` ——同一个东西在两个语境里的习惯叫法。
 */
export const CHAT_RUN_TEXT = Object.freeze({
  running: TASK_STATUS.DOING,
  done: TASK_STATUS.DONE,
  failed: TASK_STATUS.FAILED,
  stopped: 'stopped',
});

/**
 * 一次运行的生命周期（`runs.status` / `conversations.status`）。**七个码，每个都有明确来历**：
 *
 *   · **pending**     = 已建好记录、进程还没起来；
 *   · **running**     = 子进程在跑；
 *   · **done/failed** = 正常收尾 / 技术上跑挂（重跑可能就过）；
 *   · **stopped**     = 人点了停止（`stoppedByUser`）—— **人的决定**；
 *   · **interrupted** = 服务重启 / 进程没了，运行从内存消失后补记的（routes/run.mjs）—— **事故**；
 *   · **blocked**     = agent 主动举手要人拍板（`[受阻] 原因`）或**空回话**，流程把它折成 blocked。
 *
 * `stopped` 和 `interrupted` 必须分开：混成一个码，事后分不清"我停的"和"它自己没的"。
 */
export const RUN_STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  STOPPED: 'stopped',
  INTERRUPTED: 'interrupted',
  BLOCKED: 'blocked',
});

/** 运行态码 → 显示名（唯一一份；会话头部胶囊、流程行、聊天行都用它） */
export const RUN_LABEL = Object.freeze({
  [RUN_STATUS.PENDING]: '待跑',
  [RUN_STATUS.RUNNING]: '跑中',
  [RUN_STATUS.DONE]: '完成',
  [RUN_STATUS.FAILED]: '失败',
  [RUN_STATUS.STOPPED]: '已停止',
  [RUN_STATUS.INTERRUPTED]: '中断',
  [RUN_STATUS.BLOCKED]: '已阻塞',
});

/**
 * **流程实例**（`workflow_runs`）只有三个码：在跑 / 走完 / 被终止。
 * 它跟任务八态不是一套（任务态是"这件事"的，流程态是"这条流程"的），
 * 以前两边都写中文，看着像一套、实际各算各的 —— 现在各自有自己的码。
 */
export const WORKFLOW_RUN_STATUS = Object.freeze({
  DOING: 'doing',
  DONE: 'done',
  TERMINATED: 'terminated',
});

/** 流程实例码 → 显示名 */
export const WORKFLOW_RUN_LABEL = Object.freeze({
  [WORKFLOW_RUN_STATUS.DOING]: '进行中',
  [WORKFLOW_RUN_STATUS.DONE]: '已完成',
  [WORKFLOW_RUN_STATUS.TERMINATED]: '已终止',
});

/**
 * 节点作业的生命周期（`node_tasks`）—— 跟上面几套**不是一回事**，
 * 别为了"统一"把它们并进去：那是**另一台机器上的活**的领取状态，
 * 卡和流程根本看不见它。
 */
export const NODE_JOB_STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  REPORTED: 'reported',
  DONE: 'done',
  FAILED: 'failed',
});

/** 节点作业码 → 显示名 */
export const NODE_JOB_LABEL = Object.freeze({
  [NODE_JOB_STATUS.PENDING]: '待领',
  [NODE_JOB_STATUS.RUNNING]: '执行中',
  [NODE_JOB_STATUS.REPORTED]: '已回执',
  [NODE_JOB_STATUS.DONE]: '完成',
  [NODE_JOB_STATUS.FAILED]: '失败',
});

/* ------------------------------------------------------- 老库迁移（只在这里出现中文状态值） */
/*
 * **只给 `db.mjs` 的一次性迁移用**，别在业务代码里 import 它们做"兼容" —— 兼容读
 * 等于给第二套写法续命，正是这次要根除的东西（见文件头）。
 */
export const LEGACY_TASK_STATUS = Object.freeze({
  想法: TASK_STATUS.IDEA,
  待办: TASK_STATUS.TODO,
  进行中: TASK_STATUS.DOING,
  待验收: TASK_STATUS.REVIEW,
  已阻塞: TASK_STATUS.BLOCKED,
  失败: TASK_STATUS.FAILED,
  已完成: TASK_STATUS.DONE,
  已取消: TASK_STATUS.CANCELLED,
});

export const LEGACY_RUN_STATUS = Object.freeze({
  待跑: RUN_STATUS.PENDING,
  跑中: RUN_STATUS.RUNNING,
  完成: RUN_STATUS.DONE,
  失败: RUN_STATUS.FAILED,
  已停止: RUN_STATUS.STOPPED,
  中断: RUN_STATUS.INTERRUPTED,
  受阻: RUN_STATUS.BLOCKED,
  已阻塞: RUN_STATUS.BLOCKED, // 空回话兜底以前直接写的是任务词，一并收进来
});

export const LEGACY_NODE_JOB_STATUS = Object.freeze({
  待领: NODE_JOB_STATUS.PENDING,
  执行中: NODE_JOB_STATUS.RUNNING,
  已回执: NODE_JOB_STATUS.REPORTED,
  完成: NODE_JOB_STATUS.DONE,
  失败: NODE_JOB_STATUS.FAILED,
});

/** 流程实例的老值（`已终止` 只存在这一套里，别的词表没有这个词） */
export const LEGACY_WORKFLOW_RUN_STATUS = Object.freeze({
  进行中: WORKFLOW_RUN_STATUS.DOING,
  已完成: WORKFLOW_RUN_STATUS.DONE,
  已终止: WORKFLOW_RUN_STATUS.TERMINATED,
});

/* ------------------------------------------------------------------ 判定与显示 */

/** 这个状态码认不认识（写库前判"是不是自己人"用） */
export function isTaskStatus(v) {
  return Object.hasOwn(TASK_COL_OF, String(v));
}

/** 这个运行终态码认不认识 */
export function isRunStatus(v) {
  return Object.values(RUN_STATUS).includes(String(v));
}

/** 任务码 → 显示名（认不出就原样返回，界面不至于空一格） */
export const taskLabel = (code) => TASK_LABEL[code] ?? String(code ?? '');

/** 运行码 → 显示名 */
export const runLabel = (code) => RUN_LABEL[code] ?? String(code ?? '');

/** 流程实例码 → 显示名 */
export const workflowLabel = (code) => WORKFLOW_RUN_LABEL[code] ?? String(code ?? '');

/**
 * 给前端/agent 的**唯一状态字典**（`GET /api/status/dict`）。
 * 键是码、值是显示名；前端拿它渲染，别在 JS 里再写一份。
 */
export function statusDictionary() {
  return {
    task: { ...TASK_LABEL },
    run: { ...RUN_LABEL },
    workflow: { ...WORKFLOW_RUN_LABEL },
    node: { ...NODE_JOB_LABEL },
  };
}

/* ------------------------------------------------------------ 空回话（2026-11-11 实报） */
/*
 * 实报形态（群「爻鉴」r-f0512961）：模型把工具调用写成 `<dots_function_call><invoke …>` 正文文本，
 * turn 直接 completed，finalText 只剩 `"\n\n\n"` —— 界面是一条**空白气泡**，会话状态还写着「完成」。
 * 两件事一起收口：
 *   · 气泡：正文为空/纯空白时画一句占位（前端 chat.mjs 里用同一句文案）；
 *   · 会话状态：什么都没交回来就不算 `done`，落 `blocked`，让人一眼知道要重跑。
 * 判据只看 `trim()` 后是否为空；**run 自身状态仍是 `done`**（进程正常退出，缺的是回话）。
 */
export const EMPTY_REPLY_TEXT = '（这一轮没有回话 —— 模型输出为空或运行被中断，可以让他重跑一次）';

/** 运行终态 + 回话原文 → 会话该显示的状态（"完成但空回话" → blocked） */
export function conversationStatusFor(runStatus, finalText) {
  return runStatus === RUN_STATUS.DONE && !String(finalText ?? '').trim()
    ? RUN_STATUS.BLOCKED
    : runStatus;
}
