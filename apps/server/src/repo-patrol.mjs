/**
 * **仓库级巡检**（2026-10-29）：把「这个仓库要不要巡检、多久一次」放回仓库自己的设置里。
 *
 * 起因是用户那句话：「PR 巡检是通过流程实现的吧？」「那这个功能放到代码托管是不是更好呢？」
 * 结论是：巡检本来**按仓库**发起（谁审、多久看一次、卡片落哪个项目），
 * 那时这些却要去另一个页面先选仓库 —— 仓库一多，配置与对象就分家了。
 *
 * 但**调度器不动**：节拍、开关、上次结果、立即跑还是「定时任务」那套（`schedules.mjs` +
 * `schedule_jobs` 表），这里只做一层映射 —— 每个仓库最多一条 `pr-scan` 任务，
 * 用 `config.repo` 认领。为什么不是仓库表上再加几列：那样就得把 `isDue`/`tick`/失败记账
 * 复制一遍，第二份调度核心是所有不一致里最难查的那种。
 *
 * 边界（都是刻意的）：
 *   · **一个仓库一条任务**（`config.repo` = `owner/name`）。留空 `config.repo` 的老任务是
 *     「扫所有仓库」的全局任务，不属于任何仓库，仍留在「定时任务」页；
 *   · 节拍只给**预设**（关 / 30 分钟 / 2 小时 / 12 小时 / 每天 09:00 / 每天 21:00）——
 *     仓库行是个窄弹窗，摆不下「单次 / 每周 / 每月」那套完整表单；要那种去定时任务页；
 *   · 关掉 = `enabled = 0`，**任务不删**：上次巡检结果和「立即巡检」都还留着；
 *   · 仓库从清单移除 → 它的任务一起删（否则会一直失败「没有接入仓库 X」）。
 */
import * as store from './store.mjs';
import * as schedules from './schedules.mjs';
import { prScan } from './pr-watch.mjs';

/**
 * 仓库行上可选的那几档。`repeat` / `everyMinutes` / `atTime` 直接是定时任务表的字段，
 * 这里不发明第二套时间表示 —— 界面上选什么，库里就是调度器认识的那一份。
 *
 * 「每 12 小时」就是一天两次（首次跑完起算），比"每天 09:00 + 21:00"少一条任务。
 */
export const PRESETS = [
  { id: 'off', label: '关闭' },
  { id: '30m', label: '每 30 分钟', repeat: 'interval', everyMinutes: 30 },
  { id: '2h', label: '每 2 小时', repeat: 'interval', everyMinutes: 120 },
  { id: '12h', label: '每 12 小时（一天两次）', repeat: 'interval', everyMinutes: 720 },
  { id: 'daily-09', label: '每天 09:00', repeat: 'daily', atTime: '09:00' },
  { id: 'daily-21', label: '每天 21:00', repeat: 'daily', atTime: '21:00' },
];

const PRESET = new Map(PRESETS.map((p) => [p.id, p]));

/** 任务名：一眼认出是哪个仓库的巡检（定时任务页仍会列出来，名字不能只写「PR 巡检」） */
export function jobNameOf(repo) {
  return `PR 巡检 · ${repo.fullName}`;
}

function configOf(job) {
  try {
    const v = JSON.parse(job?.config || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** 这个仓库名下的巡检任务（正常最多一条；人手工建重了也不在这里去重，只认最早那条） */
export function jobsOfRepo(fullName) {
  return store.listSchedules().filter((j) => j.action === 'pr-scan' && String(configOf(j).repo ?? '') === String(fullName));
}

export function jobOf(repo) {
  return jobsOfRepo(repo.fullName)[0] ?? null;
}

/**
 * 任务当前的节拍 → 预设 id。
 * 对不上任何预设（人手工建过「每周一」这种）→ `custom`：界面照实显示"自定义"，
 * 但不能显示成「关闭」—— 那是在撒谎，它还跑着。
 */
export function presetOf(job) {
  if (!job || !job.enabled) return 'off';
  const hit = PRESETS.find(
    (p) =>
      p.id !== 'off' &&
      (job.repeat || 'interval') === p.repeat &&
      (p.repeat === 'interval' ? Number(job.everyMinutes) === p.everyMinutes : String(job.atTime ?? '') === p.atTime),
  );
  return hit?.id ?? 'custom';
}

/** 代码托管页要的：节拍 + 上次结果 + 在不在跑（给弹窗画那一行） */
export function viewOf(repo) {
  const job = jobOf(repo);
  return {
    jobId: job?.id ?? null,
    preset: presetOf(job),
    text: job ? schedules.describeRepeat(job) : '关闭',
    enabled: job ? !!job.enabled : false,
    running: job ? schedules.runningIds().includes(job.id) : false,
    lastRunAt: job?.lastRunAt ?? null,
    lastStatus: job?.lastStatus ?? null,
    lastError: job?.lastError ?? null,
    lastSummary: job?.lastSummary ?? null,
  };
}

/**
 * 改这个仓库的巡检节拍（`off` = 停用但不删任务）。
 * 未知预设直接抛 —— 接口把它翻成 400，别让人以为存上了、结果到点不跑。
 */
export function setPreset(repo, presetId) {
  const p = PRESET.get(String(presetId ?? ''));
  if (!p) throw new Error(`不认识的巡检节拍：${presetId || '（空）'}（可选：${PRESETS.map((x) => x.id).join(' / ')}）`);

  const job = jobOf(repo);
  if (p.id === 'off') {
    if (job) store.updateSchedule(job.id, { enabled: 0 });
    return viewOf(repo);
  }

  const fields = {
    name: jobNameOf(repo),
    action: 'pr-scan',
    repeat: p.repeat,
    // 列上 everyMinutes 是 NOT NULL；时间类的重复方式不用它，填无害占位（同 store.createSchedule）
    everyMinutes: p.everyMinutes ?? 30,
    atTime: p.repeat === 'interval' ? null : p.atTime,
    // 从「每周一」这种自定义节拍改回预设时，把别的重复方式字段清掉 ——
    // 留着就是脏数据（界面上看不到、下次改别的档时又冒出来）
    weekday: null,
    dayOfMonth: null,
    month: null,
    runAt: null,
    enabled: 1,
    config: { repo: repo.fullName },
  };
  if (job) store.updateSchedule(job.id, fields);
  else store.createSchedule(fields);
  return viewOf(repo);
}

/**
 * 立即巡检一次（不看开关：人点它就是要现在跑）。
 *
 * 有任务 → 走 `schedules.runNow`：结果记在 last* 上，弹窗下次打开能看到；
 * 还没配过节拍 → 直接调一次 `prScan`，**不为了跑一次就建一条任务**
 * （那样「关闭」的仓库会凭空多出一条停用的任务）。返回值形状与 `/api/schedules/:id/run` 一致。
 */
export async function runNow(repo) {
  const job = jobOf(repo);
  if (job) return schedules.runNow(job.id);
  try {
    const out = await prScan({ config: { repo: repo.fullName } });
    return { ok: true, summary: out.summary };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 300) };
  }
}

/** 仓库从清单移除时跟着删任务（返回删了几条，给日志/用例看） */
export function forgetRepo(fullName) {
  let n = 0;
  for (const job of jobsOfRepo(fullName)) {
    if (store.deleteSchedule(job.id)) n += 1;
  }
  return n;
}
