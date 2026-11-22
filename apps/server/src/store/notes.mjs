/* store/notes.mjs —— 经验簿（2026-11-22，缺口①的最小版）。
 *
 * 一句话：**让"干得越久越懂这个团队"有两行字可查**，而不是靠会话没被轮换掉。
 *
 * 为什么只收两类（口径 / 踩过的坑），不收聊天摘要：
 *   · 前者下次能直接用（"这个仓库改完必须重启"），后者只是"上次聊到哪儿了"，还占上下文；
 *   · 更要紧的是**来源**：这两类都能指回一件真发生过的事（一次驳回 / 一次核对没过 / 人明说），
 *     而"总结一下刚才聊了什么"是模型生成的，会漏、会编，且没人能核。
 *
 * 这张表**只存事实与口径，不存判断**。谁该被表扬、这人行不行 —— 不在这里，也不该由平台写。
 *
 * 淘汰：每人最多 200 条（`MAX_NOTES_PER_PERSONA`），超了先删**hits 低、最久没动**的。
 * 去重：`(personaId, dedupe)` 唯一 —— 同一件事被核出 5 次不该是 5 条，是 1 条 hits=5。
 */
import { db, newId, nowIso } from './db.mjs';

/** 两类，别再加。加第三类之前先问：它能不能指回一件真发生过的事？ */
export const NOTE_KINDS = Object.freeze(['repo', 'pitfall']);

export const NOTE_SOURCES = Object.freeze(['audit', 'manual']);

/** 每人上限。200 条 ≈ 一次注入也只用得上前十条，剩下的只是账。 */
export const MAX_NOTES_PER_PERSONA = 200;

/** 正文上限：一条一句话，超过就不是"口径"而是文档了（文档该落 docs/）。 */
const MAX_TEXT = 300;

/** 稳定短哈希（djb2 → base36）：只用来做去重键，不做安全用途。 */
export function shortHash(s) {
  let h = 5381;
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i += 1) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** 压空白 + 去首尾 + 截断。**不做同义改写、不猜** —— 口径是原文才有价值。 */
export function normalizeNoteText(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT - 1)}…` : t;
}

/**
 * 记一条。返回 `{ note, merged }`：merged=true 表示命中已有的那条（hits+1）。
 *
 * `dedupe` 由调用方给（experience.mjs 会把数字/日期抹掉再算，好让"同一种错反复犯"并成一条）；
 * 不给就按归一化正文算。
 */
export function addPersonaNote({
  personaId,
  kind = 'pitfall',
  text,
  source = 'manual',
  evidence = null,
  dedupe = null,
  max = MAX_NOTES_PER_PERSONA,
} = {}) {
  const pid = String(personaId ?? '').trim();
  if (!pid) throw Object.assign(new Error('personaId 不能为空'), { code: 'bad' });
  if (!NOTE_KINDS.includes(kind)) {
    throw Object.assign(new Error(`经验簿只有两类：${NOTE_KINDS.join(' / ')}`), { code: 'bad' });
  }
  const body = normalizeNoteText(text);
  if (!body) throw Object.assign(new Error('正文不能为空'), { code: 'bad' });
  const src = NOTE_SOURCES.includes(source) ? source : 'manual';
  const key = String(dedupe ?? shortHash(body));
  const ts = nowIso();
  const ev = evidence ? JSON.stringify(evidence).slice(0, 800) : null;

  const hit = db.prepare('SELECT * FROM persona_notes WHERE personaId = ? AND dedupe = ?').get(pid, key);
  if (hit) {
    db.prepare(
      `UPDATE persona_notes SET hits = hits + 1, updatedAt = ?, evidence = COALESCE(?, evidence) WHERE id = ?`,
    ).run(ts, ev, hit.id);
    prunePersonaNotes(pid, max);
    return { note: getPersonaNote(hit.id), merged: true };
  }

  const id = newId('pn');
  db.prepare(
    `INSERT INTO persona_notes (id, personaId, kind, text, source, hits, evidence, dedupe, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
  ).run(id, pid, kind, body, src, ev, key, ts, ts);
  prunePersonaNotes(pid, max);
  return { note: getPersonaNote(id), merged: false };
}

export function getPersonaNote(id) {
  return db.prepare('SELECT * FROM persona_notes WHERE id = ?').get(String(id)) ?? null;
}

/** 按人取。`kind` 不给就是两类一起，**新的在前**。 */
export function listPersonaNotes(personaId, { kind = null, limit = 50 } = {}) {
  const pid = String(personaId ?? '').trim();
  if (!pid) return [];
  const n = Math.min(Math.max(Number(limit) || 50, 1), MAX_NOTES_PER_PERSONA);
  if (kind) {
    return db
      .prepare('SELECT * FROM persona_notes WHERE personaId = ? AND kind = ? ORDER BY updatedAt DESC LIMIT ?')
      .all(pid, String(kind), n);
  }
  return db
    .prepare('SELECT * FROM persona_notes WHERE personaId = ? ORDER BY updatedAt DESC LIMIT ?')
    .all(pid, n);
}

/** 删除一条；返回删掉的行数（0 = 没有这条） */
export function deletePersonaNote(id) {
  return db.prepare('DELETE FROM persona_notes WHERE id = ?').run(String(id)).changes;
}

/** 忘掉一个人（换人/重来）：返回删掉的条数 */
export function deletePersonaNotes(personaId) {
  return db.prepare('DELETE FROM persona_notes WHERE personaId = ?').run(String(personaId)).changes;
}

/** 淘汰：超上限就删 hits 最低、最久没动的。返回删掉几条。 */
export function prunePersonaNotes(personaId, max = MAX_NOTES_PER_PERSONA) {
  const pid = String(personaId ?? '').trim();
  const cap = Math.max(Number(max) || MAX_NOTES_PER_PERSONA, 1);
  const total = Number(db.prepare('SELECT COUNT(*) AS n FROM persona_notes WHERE personaId = ?').get(pid)?.n ?? 0);
  if (total <= cap) return 0;
  return db
    .prepare(
      `DELETE FROM persona_notes WHERE id IN (
         SELECT id FROM persona_notes WHERE personaId = ? ORDER BY hits ASC, updatedAt ASC LIMIT ?
       )`,
    )
    .run(pid, total - cap).changes;
}

/** 体检用：两类各多少条、多少人有过经验 */
export function noteStats() {
  const byKind = db
    .prepare(
      `SELECT kind, COUNT(*) AS n,
              SUM(hits) AS hits,
              COUNT(DISTINCT personaId) AS people
         FROM persona_notes GROUP BY kind`,
    )
    .all();
  const top = db
    .prepare(
      `SELECT n.personaId, COALESCE(p.name, n.personaId) AS who, n.kind, n.text, n.hits
         FROM persona_notes n LEFT JOIN personas p ON p.id = n.personaId
        ORDER BY n.hits DESC, n.updatedAt DESC LIMIT 8`,
    )
    .all();
  return { byKind, top };
}
