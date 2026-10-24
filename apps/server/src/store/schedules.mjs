/* store/schedules.mjs —— 2026-10-22 由 store.mjs 按域拆出。SQL 只在 store/ 目录内。 */

import { db, newId, nowIso } from './db.mjs';

export function listSchedules() {
  return db.prepare('SELECT * FROM schedule_jobs ORDER BY createdAt ASC').all();
}


export function getSchedule(id) {
  return db.prepare('SELECT * FROM schedule_jobs WHERE id = ?').get(id) ?? null;
}


export function createSchedule({ name, action, everyMinutes, repeat = 'interval', atTime = null, weekday = null, dayOfMonth = null, month = null, runAt = null, enabled = 1, config = null }) {
  const ts = nowIso();
  const row = {
    id: newId('sj'),
    name,
    action,
    // 时间类的重复方式不用间隔字段，但列是 NOT NULL —— 填个无害的 30
    everyMinutes: Number.isFinite(Number(everyMinutes)) ? Math.round(Number(everyMinutes)) : 30,
    repeat,
    atTime,
    weekday,
    dayOfMonth,
    month,
    runAt,
    enabled: enabled ? 1 : 0,
    config: config ? JSON.stringify(config) : null,
    createdAt: ts,
    updatedAt: ts,
  };
  db.prepare(
    `INSERT INTO schedule_jobs (id, name, action, everyMinutes, repeat, atTime, weekday, dayOfMonth, month, runAt, enabled, config, lastRunAt, lastStatus, lastError, lastSummary, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
  ).run(row.id, row.name, row.action, row.everyMinutes, row.repeat, row.atTime, row.weekday, row.dayOfMonth, row.month, row.runAt, row.enabled, row.config, row.createdAt, row.updatedAt);
  return getSchedule(row.id);
}

/** 只覆盖传进来的字段（undefined 不覆盖）。config 传 null = 清空。 */

export function updateSchedule(id, fields = {}) {
  const cur = getSchedule(id);
  if (!cur) return null;
  const next = { ...cur };
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    next[k] = k === 'config' ? (v ? JSON.stringify(v) : null) : v;
  }
  db.prepare(
    `UPDATE schedule_jobs SET name = ?, action = ?, everyMinutes = ?, repeat = ?, atTime = ?, weekday = ?, dayOfMonth = ?, month = ?, runAt = ?, enabled = ?, config = ?, updatedAt = ? WHERE id = ?`,
  ).run(next.name, next.action, next.everyMinutes, next.repeat ?? 'interval', next.atTime ?? null, next.weekday ?? null, next.dayOfMonth ?? null, next.month ?? null, next.runAt ?? null, next.enabled ? 1 : 0, next.config ?? null, nowIso(), id);
  return getSchedule(id);
}


export function deleteSchedule(id) {
  return db.prepare('DELETE FROM schedule_jobs WHERE id = ?').run(id).changes > 0;
}

/**
 * 记一次执行结果。**成功也写 `lastRunAt`** —— 它是"下次该不该跑"的唯一依据，
 * 只记失败的话，一个一直失败的任务会永远到点（每 tick 都重试、把日志刷满）。
 */

export function touchScheduleRun(id, { status, error = null, summary = null, at = null }) {
  db.prepare('UPDATE schedule_jobs SET lastRunAt = ?, lastStatus = ?, lastError = ?, lastSummary = ?, updatedAt = ? WHERE id = ?').run(
    at ?? nowIso(),
    status,
    error,
    summary,
    nowIso(),
    id,
  );
  return getSchedule(id);
}

/* ---------------------------------------------------------------- PR 联动（2026-10-17） */
/*
 * 一张卡可以关联一个 GitHub PR。状态由**平台去 GitHub 查**后存这儿（看板/详情页直接读，
 * 不在渲染时调 API）。合并后**不自动"已完成"** —— 转「待验收」，等经办人验收。
 */
