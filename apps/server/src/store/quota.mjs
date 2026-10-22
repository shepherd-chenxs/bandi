/* store/quota.mjs —— 2026-10-22 由 store.mjs 按域拆出。SQL 只在 store/ 目录内。 */

import { db, nowIso } from './db.mjs';

export function listQuotaRows() {
  return db.prepare('SELECT model, dailyTokens, dailyRuns, updatedAt FROM quotas').all();
}

/** 一个模型的限额行；没有就是 null（= 不限制） */

export function getQuotaRow(model) {
  return (
    db.prepare('SELECT dailyTokens, dailyRuns, updatedAt FROM quotas WHERE model = ?').get(String(model ?? '')) ?? null
  );
}

/**
 * 整表替换：传进来的就是**全部**限额，没提到的模型一律回到"不限制"。
 *
 * 事务放这儿 —— 删完一半崩了会留下一个半空的额度表，那比"没保存"糟得多。
 */

export function replaceQuotas(entries = []) {
  const del = db.prepare('DELETE FROM quotas');
  const ins = db.prepare('INSERT INTO quotas (model, dailyTokens, dailyRuns, updatedAt) VALUES (?, ?, ?, ?)');
  const ts = nowIso();
  db.exec('BEGIN');
  try {
    del.run();
    for (const e of entries) ins.run(e.model, e.dailyTokens ?? null, e.dailyRuns ?? null, ts);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** 从某个时刻起跑过的运行（只要 model 与 usage 两列，给额度算账用） */
