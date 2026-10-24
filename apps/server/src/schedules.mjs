/**
 * 定时任务：**先有调度器、再有巡检**（2026-10-17）。
 *
 * 为什么不是"在 PR 巡检里塞一个 setInterval"：节拍、开关、上次结果这些东西
 * 一旦写进某个具体动作里，第二个动作（issue、依赖升级、备份）来时只能复制一遍。
 * 这里把它们抽成三样互不粘连的东西：
 *
 *   ① **表** `schedule_jobs`（`store.mjs`）：一个任务卡 = 名称 + 动作 + 间隔 + 开关 + 上次结果；
 *   ② **动作注册表**（下面的 `ACTIONS`）：动作只负责"做事 + 说一句话"，不知道谁在调度它；
 *   ③ **运行器**（`tick`）：一个 30 秒的循环，挑到点的、串行跑、写回结果。
 *
 * 几条刻意的取舍：
 *   · **间隔分钟，不是 cron** —— Windows 上没有 cron，装个解析器又违背零依赖；"每 30 分钟"人也一眼懂。
 *   · **串行** —— 同时跑几个巡检只是把钱和时间烧在同一个速率上限上，还会让日志交错；一个 tick 内按创建顺序排队。
 *   · **不补跑** —— 进程重启后按 `lastRunAt` 算下一次，错过了就等下一个间隔。补跑会在开机时把
 *     积压的任务一次性全放出来（十几个巡检同时冲 GitHub）。
 *   · **从没跑过的任务立刻跑** —— 人刚建完就想看到结果，不该让他等半小时。
 *   · **失败也写 `lastRunAt`** —— 否则一个一直失败的任务会每 30 秒重试一次，把日志刷满。
 */

import * as store from './store.mjs';
import { prScan } from './pr-watch.mjs';
import { backupDb } from './db-backup.mjs';
import { runPersonaTask, validatePersonaTask } from './persona-task.mjs';
import { retryPendingSteps } from './workflows.mjs';
import { retryQueuedTasks } from './project-tasks.mjs';
import { drainAllGroupQueues } from './dispatch.mjs';

/** 间隔下限：再密就是拿 GitHub 的速率上限换"更实时"，而 PR 从来不是秒级的事 */
export const MIN_MINUTES = 5;

/** 七种重复方式（对齐 WorkBuddy 的定时任务弹窗）：间隔 / 单次 / 每天 / 每周 / 每双周 / 每月 / 每年 */
export const REPEATS = ['interval', 'once', 'daily', 'weekly', 'biweekly', 'monthly', 'yearly'];
export const REPEAT_LABELS = { interval: '间隔', once: '单次', daily: '每天', weekly: '每周', biweekly: '每双周', monthly: '每月', yearly: '每年' };

const DAY = 86400000;
const WEEK_CN = '日一二三四五六';
const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/**
 * 动作注册表。加一个动作 = 往这里加一条，**调度核心一行都不用动**。
 * `run({ job, config })` 返回 `{ summary }`（一句话，存进 `lastSummary` 给人看）。
 *
 * 动作**自己声明参数**（`fields`），界面照声明渲染，不认任何具体动作的字段名 ——
 * 所以 PR 巡检的「仓库 / 项目」只是它自己的参数，不是弹窗里写死的两个下拉。
 * 参数类型：`repo`（已接入仓库）/ `project`（项目）/ `persona`（数字员工）/ `number` / `text` / `textarea`。
 */
export const ACTIONS = {
  /*
   * 排第一位 = 默认动作：定时任务最常见的样子是「到点把一句话交给某个人」，
   * 而不是「跑某条写死的巡检」。PR 巡检、备份是内置动作，只是其中两种。
   * 两个字段都来自声明（textarea / persona），弹窗本身不认识它们。
   */
  'persona-task': {
    id: 'persona-task',
    label: '交给数字员工',
    hint: '到点把你说的话发给他，他照自己的权限去做；每个任务有自己的一条会话，结果在那儿看',
    defaultName: '定时派活',
    fields: [
      {
        key: 'instruction',
        label: '做什么',
        type: 'textarea',
        rows: 4,
        required: true,
        requiredText: '「做什么」还没写 —— 到点了得知道让它干什么',
        placeholder: '到点让它干什么？说清楚一点，例如：看一下今天的 PR，把需要我审的整理成一条消息发我',
      },
      { key: 'personaId', label: '交给谁', type: 'persona', empty: '选一个人', required: true, requiredText: '还没选「交给谁」' },
      /*
       * 关联项目 = 这次派活的工作空间（用户的叫法照截图：「关联项目」）。
       * 不给这个参数时，他会落到**自己那个默认目录**（六个员工常常指着同一个目录），
       * 一有第二个项目就乱套 —— 所以这里让任务自己指定。留空也允许：
       * 有些活得先问清"在哪儿做"，指派时定不下来。
       */
      {
        key: 'projectId',
        label: '关联项目',
        type: 'project',
        empty: '不关联项目',
        hint: '',
      },
    ],
    validate: (config) => validatePersonaTask(config),
    run: ({ job, config }) => runPersonaTask({ job, config }),
  },
  'pr-scan': {
    id: 'pr-scan',
    label: 'PR / Issue 巡检',
    hint: '拉已接入仓库的 open PR / issue 写成值班卡，并刷新已关联卡上的 PR 状态（合并 → 待验收）',
    defaultName: 'PR 巡检',
    fields: [
      { key: 'repo', label: '管哪些仓库', type: 'repo', empty: '所有已接入的仓库' },
      { key: 'projectId', label: '卡片落到哪个项目', type: 'project', empty: '自动（项目根 == 克隆目录）' },
    ],
    run: ({ config }) => prScan({ config }),
  },
  'backup-db': {
    id: 'backup-db',
    label: '备份数据库',
    hint: '把 bandi.db 导出一份到数据目录的 backups/，只留最近 N 份（跟 PR 无关，纯粹是数据安全）',
    defaultName: '数据库备份',
    fields: [{ key: 'keep', label: '保留份数', type: 'number', min: 1, max: 90, def: 14, suffix: '份' }],
    run: ({ config }) => backupDb({ config }),
  },
};

/** 给界面用的动作清单（不带 run，别把函数发到浏览器；fields 是渲染弹窗的唯一依据） */
export function actionCatalogue() {
  return Object.values(ACTIONS).map(({ id, label, hint, defaultName, fields }) => ({ id, label, hint, defaultName, fields: fields ?? [] }));
}

/** 任务卡上的 `config` 是 JSON 字符串（动作自己解释），这里只负责安全地解析 */
export function parseConfig(job) {
  try {
    const v = JSON.parse(job?.config || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/**
 * 「anchor 之后下一次是什么时候」—— **纯函数**（冒烟直接钉它）。
 *
 * `afterMs` 是锚点：跑过的任务用 `lastRunAt`，从没跑过的用 `createdAt`。
 * 时间类的方式（每天/每周…）算"锚点之后第一个满足的时刻"，所以：
 *   · 每天 09:00、昨天 15:00 跑过 → 今天 09:00 已经在锚点之前 → 明天 09:00；
 *   · 从没跑过、昨天 15:00 建的、每天 09:00 → 今天 09:00（建完之后的第一个整点，人等得着）。
 * 双周的「隔一周」只约束**跑过的两次之间**（`minGapMs`），第一次该哪天就哪天。
 * 算不出来（字段缺/坏）返回 null，让调用方自己决定兜底。
 */
export function nextRunAt(job, afterMs, { minGapMs = 0 } = {}) {
  const repeat = job?.repeat || 'interval';
  const hm = /^([01]\d|2[0-3]):[0-5]\d$/.test(job?.atTime ?? '') ? job.atTime : '09:00';
  const at = (y, m, d) => {
    const [hh, mm] = hm.split(':').map(Number);
    return new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
  };
  const daysIn = (y, m) => new Date(y, m, 0).getDate();

  if (repeat === 'once') {
    const t = Date.parse(job?.runAt ?? '');
    return Number.isFinite(t) ? t : null;
  }
  if (repeat === 'interval') {
    const every = Math.max(MIN_MINUTES, Math.round(Number(job?.everyMinutes) || MIN_MINUTES)) * 60000;
    return afterMs + every;
  }
  if (repeat === 'daily') {
    const a = new Date(afterMs);
    let t = at(a.getFullYear(), a.getMonth() + 1, a.getDate());
    if (t <= afterMs) t += DAY;
    return t;
  }
  if (repeat === 'weekly' || repeat === 'biweekly') {
    const w = Math.min(6, Math.max(0, Math.round(Number(job?.weekday) || 1)));
    let t;
    let cand = afterMs;
    for (let i = 0; i < 14; i++) {
      const a = new Date(cand);
      const shift = (w - a.getDay() + 7) % 7 || 7; // 同一天也算过（要严格在锚点之后）
      cand = cand + shift * DAY;
      const b = new Date(cand);
      t = at(b.getFullYear(), b.getMonth() + 1, b.getDate());
      if (t > afterMs) break;
    }
    if (t == null || t <= afterMs) return null;
    // 双周：两次之间至少隔一周再跳一周（容忍夏令时的一小时抖动）
    if (repeat === 'biweekly' && minGapMs > 0) {
      while (t - afterMs < minGapMs) t += 7 * DAY;
    }
    return t;
  }
  if (repeat === 'monthly' || repeat === 'yearly') {
    // 1..31 原样收着，**用的时候**才按当月天数收（10 月的 31 号就是 31 号，2 月自然落到 28）
    const dom = Math.max(1, Math.min(31, Math.round(Number(job?.dayOfMonth) || 1)));
    const a = new Date(afterMs);
    if (repeat === 'monthly') {
      let y = a.getFullYear();
      let m = a.getMonth() + 1;
      for (let i = 0; i < 48; i++) {
        const t = at(y, m, Math.min(dom, daysIn(y, m)));
        if (t > afterMs) return t;
        if (++m > 12) { m = 1; y++; }
      }
      return null;
    }
    const mo = Math.min(12, Math.max(1, Math.round(Number(job?.month) || 1)));
    let y = a.getFullYear();
    for (let i = 0; i < 8; i++) {
      const t = at(y, mo, Math.min(dom, daysIn(y, mo)));
      if (t > afterMs) return t;
      y++;
    }
    return null;
  }
  return null;
}

/** 一句话说清这个任务什么时候跑（清单那一行、服务端下发，前端不重复实现） */
export function describeRepeat(job) {
  const repeat = job?.repeat || 'interval';
  const hm = /^([01]\d|2[0-3]):[0-5]\d$/.test(job?.atTime ?? '') ? job.atTime : '09:00';
  if (repeat === 'interval') return `每 ${Math.max(MIN_MINUTES, Math.round(Number(job?.everyMinutes) || MIN_MINUTES))} 分钟`;
  if (repeat === 'once') {
    const t = Date.parse(job?.runAt ?? '');
    return Number.isFinite(t) ? `单次 · ${new Date(t).toLocaleString('zh-CN', { hour12: false })}` : '单次 · 时间没填';
  }
  if (repeat === 'daily') return `每天 ${hm}`;
  if (repeat === 'weekly' || repeat === 'biweekly') {
    const w = Math.min(6, Math.max(0, Math.round(Number(job?.weekday) || 1)));
    return `${REPEAT_LABELS[repeat]}${WEEK_CN[w]} ${hm}`;
  }
  if (repeat === 'monthly') return `每月 ${Math.max(1, Math.round(Number(job?.dayOfMonth) || 1))} 号 ${hm}`;
  if (repeat === 'yearly') return `每年 ${Math.max(1, Math.round(Number(job?.month) || 1))} 月 ${Math.max(1, Math.round(Number(job?.dayOfMonth) || 1))} 日 ${hm}`;
  return '什么时候跑没说清';
}

/**
 * 到点没有 —— **纯函数**（冒烟直接钉它）。
 *
 * 间隔：`lastRunAt` 空（从没跑过）→ 该跑，人刚建完就该看到结果；间隔小于 5 分钟按 5 分钟算。
 * 单次：从没跑过且时间已过 → 该跑；**跑过一次就永远不再跑**（不然每 30 秒重演一遍）。
 * 时间类：锚点之后第一个整点到了才算 —— 每天 09:00 就是 09:00，不是"距上次满 24 小时"。
 * 双周：两次之间至少隔 13 天 23 小时（容忍夏令时），第一次不受这个约束。
 * 算不出来（字段坏）→ 只有 interval 兜底为"该跑"，别的宁可不跑也别乱跑。
 */
export function isDue(job, now = Date.now()) {
  if (!job || !job.enabled) return false;
  const repeat = job.repeat || 'interval';
  const last = job.lastRunAt ? Date.parse(job.lastRunAt) : NaN;

  if (repeat === 'once') {
    if (Number.isFinite(last)) return false; // 跑过就是跑过了
    const t = Date.parse(job.runAt ?? '');
    return Number.isFinite(t) && now >= t;
  }
  if (repeat === 'interval') {
    const every = Math.max(MIN_MINUTES, Math.round(Number(job.everyMinutes) || MIN_MINUTES)) * 60000;
    if (!Number.isFinite(last)) return true;
    return now - last >= every;
  }
  const anchor = Number.isFinite(last) ? last : Date.parse(job.createdAt ?? '');
  // 「隔一周」只约束跑过的两次之间；从没跑过的第一次该哪天就哪天
  const opts = Number.isFinite(last) && repeat === 'biweekly' ? { minGapMs: 14 * DAY - 36e5 } : {};
  const nr = nextRunAt(job, Number.isFinite(anchor) ? anchor : 0, opts);
  return nr != null && now >= nr;
}

/** 正在跑的任务 id：防止一次执行没结束、下一个 tick 又把它拉起来 */
const inFlight = new Set();

/**
 * 跑一个任务，把结果写回表里。
 * 失败**不往外抛**（一个任务挂了不该带崩整个 tick），但要如实记 `lastStatus/lastError`，
 * 界面上那一行就是红的 —— 静默失败等于没有这个功能。
 */
export async function runJob(job, { actions = ACTIONS } = {}) {
  const action = actions[job.action];
  if (!action) {
    const error = `不认识的动作：${job.action}`;
    store.touchScheduleRun(job.id, { status: 'fail', error });
    return { ok: false, error };
  }
  try {
    const out = (await action.run({ job, config: parseConfig(job) })) ?? {};
    const summary = clip(out.summary ?? '完成', 200);
    store.touchScheduleRun(job.id, { status: 'ok', summary });
    console.log(`[定时] ${job.name} ✓ ${summary}`);
    return { ok: true, summary };
  } catch (e) {
    const error = clip(e?.message ?? e, 300);
    store.touchScheduleRun(job.id, { status: 'fail', error });
    console.error(`[定时] ${job.name} ✗ ${error}`);
    return { ok: false, error };
  }
}

/** 跑一次"到点的那些"。返回这次跑了几个（给冒烟看，也给日志）。 */
export async function tick({ now = Date.now(), actions = ACTIONS } = {}) {
  let ran = 0;
  for (const job of store.listSchedules()) {
    if (inFlight.has(job.id) || !isDue(job, now)) continue;
    inFlight.add(job.id);
    try {
      await runJob(job, { actions });
      ran += 1;
    } finally {
      inFlight.delete(job.id);
    }
  }
  // 顺手把流程里停在「待办」的步骤再派一遍（2026-10-17 对齐 Multica：待办即执行，
  // 不需要人点「派活」）。最常见的原因是经办人上一条还在跑 —— 挂了 busy 就等下个节拍，
  // 30 秒一次的粒度人完全无感。出错不外抛：定时任务那几个不能被它连累。
  try {
    retryPendingSteps();
  } catch (e) {
    console.warn('[流程] 待办步骤自动派活没跑成：', e?.message ?? e);
  }
  // 卡也一样：撞忙退回「待办」的，节拍到了再试（2026-10-18）
  try {
    retryQueuedTasks();
  } catch (e) {
    console.warn('[看板] 排队中的卡没能重派：', e?.message ?? e);
  }
  // 群里 @ 多人的排队（2026-10-24）：run 收尾钩子是主流，这里兜住撞了
  // 项目互斥/个人并发而退回的 —— 跟上面两条一个待遇，出错不外抛。
  try {
    drainAllGroupQueues();
  } catch (e) {
    console.warn('[群聊] 排队补派没跑成：', e?.message ?? e);
  }
  return ran;
}

/** 界面上的「立即跑」用：不看间隔，也不管开关（人点它就是要它现在跑一次） */
export async function runNow(id) {
  const job = store.getSchedule(id);
  if (!job) throw new Error('任务不存在');
  if (inFlight.has(id)) throw new Error('这个任务正在跑，等它跑完');
  inFlight.add(id);
  try {
    return await runJob(job);
  } finally {
    inFlight.delete(id);
  }
}

/** 当前正在跑的任务（界面用来画"运行中"） */
export function runningIds() {
  return [...inFlight];
}

let timer = null;

/**
 * 起心跳。30 秒一跳：任务的最小间隔是 5 分钟，30 秒的粒度意味着「每 5 分钟」最多晚 30 秒，
 * 又不会让空闲进程每秒醒一次。`unref()` —— 别让这个定时器拖着进程不退出。
 */
export function start({ everyMs = 30000 } = {}) {
  if (timer) return timer;
  timer = setInterval(() => {
    tick().catch((e) => console.error('[定时] tick 出错：', e?.message ?? e));
  }, everyMs);
  timer.unref?.();
  return timer;
}

export function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}
