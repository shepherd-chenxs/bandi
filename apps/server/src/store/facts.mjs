/* store/facts.mjs —— 长期记忆的事实层（2026-11-23，缺口①补完）。
 *
 * 与经验簿（store/notes.mjs）的分工：那条存"人给的规矩 / 被核出来的错"，这条存
 * **平台从跑通的轮次里抽出来的事实** —— 验证命令、重启方式、常改文件。
 *
 * 三条边界：
 *   · 只收三类（command / restart / path），且每一类都能指回一条 run_events 里的 tool 事件；
 *   · 按 `scope`（仓库根）隔离：'npm test' 只在这个仓成立，别带到另一个仓；
 *   · 与经验簿同一套去重/淘汰：同一件事在 N 轮里出现 = 一条 hits=N，不是 N 行。
 */
import { db, newId, nowIso } from './db.mjs';
import { shortHash } from './notes.mjs';

/** 三类，别再加。加之前先问：它能不能从 run_events 里确定性地抽出来？ */
export const FACT_KINDS = Object.freeze(['command', 'restart', 'path']);

export const FACT_SOURCES = Object.freeze(['audit', 'manual']);

/** 每人上限。事实比口径更容易攒，但也只是"提醒"，200 条足够。 */
export const MAX_FACTS_PER_PERSONA = 200;

/** 正文上限：一条一句话；超过就不是事实，而是文档。 */
const MAX_TEXT = 200;

/** 仓库根归一化：小写、正斜杠、去尾斜杠。'' = 不区分仓库。 */
export function normalizeScope(root) {
  return String(root ?? '').replace(/\\/g, '/').trim().replace(/\/+$/, '').toLowerCase();
}

function normalizeFactText(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT - 1)}…` : t;
}

/**
 * 记一条事实。返回 `{ fact, merged }`（merged=true 表示同一件事又出现一次，hits+1）。
 */
export function addPersonaFact({
  personaId,
  scope = '',
  kind = 'command',
  text,
  source = 'audit',
  evidence = null,
  dedupe = null,
  max = MAX_FACTS_PER_PERSONA,
} = {}) {
  const pid = String(personaId ?? '').trim();
  if (!pid) throw Object.assign(new Error('personaId 不能为空'), { code: 'bad' });
  if (!FACT_KINDS.includes(kind)) {
    throw Object.assign(new Error(`事实层只有三类：${FACT_KINDS.join(' / ')}`), { code: 'bad' });
  }
  const body = normalizeFactText(text);
  if (!body) throw Object.assign(new Error('正文不能为空'), { code: 'bad' });
  const src = FACT_SOURCES.includes(source) ? source : 'manual';
  const sc = normalizeScope(scope);
  const key = String(dedupe ?? shortHash(`${sc}|${body}`));
  const ts = nowIso();
  const ev = evidence ? JSON.stringify(evidence).slice(0, 800) : null;

  const hit = db.prepare('SELECT * FROM persona_facts WHERE personaId = ? AND dedupe = ?').get(pid, key);
  if (hit) {
    db.prepare(
      'UPDATE persona_facts SET hits = hits + 1, updatedAt = ?, evidence = COALESCE(?, evidence) WHERE id = ?',
    ).run(ts, ev, hit.id);
    prunePersonaFacts(pid, max);
    return { fact: getPersonaFact(hit.id), merged: true };
  }

  const id = newId('pf');
  db.prepare(
    `INSERT INTO persona_facts (id, personaId, scope, kind, text, source, hits, evidence, dedupe, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
  ).run(id, pid, sc, kind, body, src, ev, key, ts, ts);
  prunePersonaFacts(pid, max);
  return { fact: getPersonaFact(id), merged: false };
}

export function getPersonaFact(id) {
  return db.prepare('SELECT * FROM persona_facts WHERE id = ?').get(String(id)) ?? null;
}

/**
 * 按人取。`scope` 给了就只取"该仓库 + 全局"那批（不给 = 全取）；`kind` 可选。
 * 新的在前 —— 召回排序由 experience.mjs 负责，这里只保证候选集是对的。
 */
export function listPersonaFacts(personaId, { scope = null, kind = null, limit = 50 } = {}) {
  const pid = String(personaId ?? '').trim();
  if (!pid) return [];
  const n = Math.min(Math.max(Number(limit) || 50, 1), MAX_FACTS_PER_PERSONA);
  const where = ['personaId = ?'];
  const args = [pid];
  if (scope !== null) {
    where.push("(scope = ? OR scope = '')");
    args.push(normalizeScope(scope));
  }
  if (kind) {
    where.push('kind = ?');
    args.push(String(kind));
  }
  args.push(n);
  return db
    .prepare(`SELECT * FROM persona_facts WHERE ${where.join(' AND ')} ORDER BY updatedAt DESC LIMIT ?`)
    .all(...args);
}

/** 删除一条；返回删掉的行数（0 = 没有这条） */
export function deletePersonaFact(id) {
  return db.prepare('DELETE FROM persona_facts WHERE id = ?').run(String(id)).changes;
}

/** 忘掉一个人的全部事实（换人 / 重来） */
export function deletePersonaFacts(personaId) {
  return db.prepare('DELETE FROM persona_facts WHERE personaId = ?').run(String(personaId)).changes;
}

/** 淘汰：超上限就删 hits 低、最久没动的。返回删掉几条。 */
export function prunePersonaFacts(personaId, max = MAX_FACTS_PER_PERSONA) {
  const pid = String(personaId ?? '').trim();
  const cap = Math.max(Number(max) || MAX_FACTS_PER_PERSONA, 1);
  const total = Number(db.prepare('SELECT COUNT(*) AS n FROM persona_facts WHERE personaId = ?').get(pid)?.n ?? 0);
  if (total <= cap) return 0;
  return db
    .prepare(
      `DELETE FROM persona_facts WHERE id IN (
         SELECT id FROM persona_facts WHERE personaId = ? ORDER BY hits ASC, updatedAt ASC LIMIT ?
       )`,
    )
    .run(pid, total - cap).changes;
}
