/**
 * 状态词表的一致性（2026-11-08 加）。
 *
 * 钉的是**一件事只有一份定义**：任务八态、运行六态、列怎么分、聊天怎么翻译。
 * 这些原先分散在 `project-tasks.mjs`（五张映射）、`db.mjs`（建表默认值）、
 * `workflows.mjs`（三处三元）、前端（字面量）—— 改一个词要改六处，
 * 漏一处**不报错**，只是某张卡在某一列上"不见了"，或者库里多出一个没人认识的状态。
 *
 * 这里的断言都靠**纯数据与源码文本**判，不起服务、不开库 —— 所以它跑得比谁都快，
 * 可以每次改完状态相关代码就跑一遍：
 *
 *   node apps/server/src/smoke-status-vocab.mjs
 *
 * 真有一处对不上时，先看是哪条 ✗：
 *   · 双向映射不对 —— `TASK_COL_OF` 里某个状态没给列，或者两态共用一列；
 *   · 建表默认值不认识 —— `db.mjs` 里新表的 `DEFAULT '…'` 用了词表外的词；
 *   · 聊天卡面越界 —— `CHAT_RUN_TEXT` 翻出来的词既不是八态、也不是声明的「已停止」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TASK_STATUS,
  TASK_COL_OF,
  TASK_STATUS_OF_COL,
  TASK_COL_ORDER,
  FLOW_STATUS,
  FLOW_COL_OF,
  CHAT_COL_OF,
  CHAT_RUN_TEXT,
  MANUAL_STATUS,
  RUN_STATUS,
  NODE_JOB_STATUS,
  TASK_LABEL,
  WORKFLOW_RUN_STATUS,
  LEGACY_TASK_STATUS,
  LEGACY_RUN_STATUS,
  LEGACY_WORKFLOW_RUN_STATUS,
} from './store/status.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

/** 聊天行的卡面可以写 stopped（人停的）—— 它不是任务八态之一，但确实是卡面上会出现的一个码 */
const CARD_FACE_ONLY = ['stopped'];
const cardFaces = new Set([...Object.values(TASK_STATUS), ...CARD_FACE_ONLY]);
const runFaces = new Set(Object.values(RUN_STATUS));

console.log('状态词表：');

/* ---------------------------------------------------------------- 任务八态 */

const taskValues = Object.values(TASK_STATUS);
check('八态值互不重复', new Set(taskValues).size === taskValues.length, taskValues.join(' / '));
check('八态恰好八个', taskValues.length === 8, `实际 ${taskValues.length}`);
/*
 * **状态只有码**（2026-11-12 用户拍板）：值必须是纯 ASCII slug —— 中文是 label，
 * 一旦有人把中文写回状态值，这条立刻红（它正是 `??` 乱码与 "todo vs 待办" 两套并存的源头）。
 */
check(
  '八态全是 ASCII 码（中文只是 label）',
  taskValues.every((v) => /^[a-z][a-z-]*$/.test(v)),
  taskValues.join(' / '),
);
check(
  '每个码都有中文 label，且不多不少',
  Object.keys(TASK_LABEL).length === taskValues.length && taskValues.every((v) => !!TASK_LABEL[v]),
  Object.keys(TASK_LABEL).join(' / '),
);
check(
  'label 互不重复',
  new Set(Object.values(TASK_LABEL)).size === taskValues.length,
  Object.values(TASK_LABEL).join(' / '),
);
check(
  '老值迁移表只指向认识的码',
  Object.values(LEGACY_TASK_STATUS).every((v) => taskValues.includes(v)) &&
    Object.values(LEGACY_RUN_STATUS).every((v) => Object.values(RUN_STATUS).includes(v)) &&
    Object.values(LEGACY_WORKFLOW_RUN_STATUS).every((v) => Object.values(WORKFLOW_RUN_STATUS).includes(v)),
);

/* ------------------------------------------------------------ 状态 ⇄ 看板列 */

const cols = Object.values(TASK_COL_OF);
check('每个状态都有列', Object.keys(TASK_COL_OF).length === taskValues.length);
check('没有两态共用一列', new Set(cols).size === cols.length, cols.join(' / '));
check(
  '列 → 状态是它的逆映射',
  Object.entries(TASK_STATUS_OF_COL).every(([col, status]) => TASK_COL_OF[status] === col),
);
check(
  '列顺序 = 状态表的书写顺序',
  TASK_COL_ORDER.length === cols.length && TASK_COL_ORDER.every((c, i) => c === cols[i]),
  TASK_COL_ORDER.join(' → '),
);

/* -------------------------------------------------------- 流程态 ⊂ 手工态 */

check('流程态全是八态的子集', FLOW_STATUS.every((s) => MANUAL_STATUS.includes(s)));
check(
  '流程卡不落「想法」「已取消」',
  !FLOW_STATUS.includes(TASK_STATUS.IDEA) && !FLOW_STATUS.includes(TASK_STATUS.CANCELLED),
);
check('FLOW_COL_OF 每列都合法', Object.values(FLOW_COL_OF).every((c) => TASK_COL_ORDER.includes(c)));

/* ------------------------------------------------------------- 聊天行翻译 */

check('CHAT_COL_OF 每列都合法', Object.values(CHAT_COL_OF).every((c) => TASK_COL_ORDER.includes(c)));
check(
  'CHAT_COL_OF 的键都有来源（八态或声明的卡面词）',
  Object.keys(CHAT_COL_OF).every((k) => cardFaces.has(k)),
  Object.keys(CHAT_COL_OF).join(' / '),
);
check(
  'CHAT_RUN_TEXT 翻出来的是认识的卡面',
  Object.values(CHAT_RUN_TEXT).every((v) => cardFaces.has(v)),
  Object.values(CHAT_RUN_TEXT).join(' / '),
);
check(
  'CHAT_RUN_TEXT 的键都是真的运行状态',
  Object.keys(CHAT_RUN_TEXT).every((k) => runFaces.has(k)),
  Object.keys(CHAT_RUN_TEXT).join(' / '),
);

/* ------------------------------------------- 建表默认值必须是认识的词（源码文本） */

const dbSrc = fs.readFileSync(path.join(here, 'store', 'db.mjs'), 'utf8');
const defaults = [...dbSrc.matchAll(/status\s+TEXT\s+NOT NULL\s+DEFAULT\s+'([^']+)'/g)].map((m) => m[1]);
check('db.mjs 里能认出建表默认值', defaults.length > 0, `${defaults.length} 处：${defaults.join(' / ')}`);
/*
 * 三套词表的并集：任务卡（看板）、运行（runs）、节点作业（另一台机器上的活）。
 * 三套都往里塞会出事（卡上出现「待领」这种没人看得懂的状态），所以这里**只认各家的词**，
 * 但建表默认值可以来自任何一套 —— 它知道自己那张表属于哪套。
 */
const vocabulary = new Set([...cardFaces, ...runFaces, ...Object.values(NODE_JOB_STATUS)]);
const strangers = defaults.filter((v) => !vocabulary.has(v));
check('没有词表外的默认值', strangers.length === 0, strangers.join(' / '));

console.log(failed ? `\n✗ ${failed} 项没过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
