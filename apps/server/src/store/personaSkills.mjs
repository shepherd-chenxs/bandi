/* store/personaSkills.mjs —— 2026-10-22 由 store.mjs 按域拆出。SQL 只在 store/ 目录内。 */

import { db, nowIso } from './db.mjs';

const SKILL_REMAP = {
  'bandi-pm': ['doc-coauthoring', 'brainstorming'],
  'bandi-dev': ['test-driven-development', 'systematic-debugging', 'requesting-code-review', 'receiving-code-review'],
  'bandi-qa': ['webapp-testing', 'verification-before-completion'],
  'bandi-flow': [],
  'bandi-ops': [],
  'bandi-panel': [],
  'bandi-repo': [],
};


export function remapPersonaSkills() {
  let moved = 0;
  for (const [from, to] of Object.entries(SKILL_REMAP)) {
    const rows = db.prepare('SELECT personaId, enabled FROM persona_skills WHERE skillName = ?').all(from);
    for (const r of rows) {
      db.prepare('DELETE FROM persona_skills WHERE personaId = ? AND skillName = ?').run(r.personaId, from);
      for (const name of to) {
        db.prepare('INSERT OR IGNORE INTO persona_skills (personaId, skillName, addedAt, enabled) VALUES (?, ?, ?, ?)')
          .run(r.personaId, name, nowIso(), r.enabled ?? 1);
      }
      moved += 1;
    }
  }
  return moved;
}

/** 挂载关系（含启用状态）—— 界面要显示"分配了哪些、哪些暂停了" */

export function listPersonaSkillLinks(personaId) {
  return db
    .prepare('SELECT skillName, enabled FROM persona_skills WHERE personaId = ? ORDER BY addedAt')
    .all(personaId)
    .map((r) => ({ name: r.skillName, enabled: r.enabled !== 0 }));
}

/** 真正会被注入 prompt 的那些：暂停的不算 */

export function listPersonaSkills(personaId) {
  return listPersonaSkillLinks(personaId)
    .filter((l) => l.enabled)
    .map((l) => l.name);
}

/** 暂停/恢复：留着分配关系，只是不生效 */

export function setPersonaSkillEnabled(personaId, skillName, enabled) {
  return db
    .prepare('UPDATE persona_skills SET enabled = ? WHERE personaId = ? AND skillName = ?')
    .run(enabled ? 1 : 0, personaId, skillName).changes;
}


export function setPersonaSkills(personaId, names) {
  const wanted = [...new Set((names ?? []).map(String).filter(Boolean))];
  // 只增删，不做整表替换 —— 整表替换会把"暂停"状态一起抹掉
  const have = new Set(listPersonaSkillLinks(personaId).map((l) => l.name));
  for (const n of wanted) if (!have.has(n)) linkPersonaSkill(personaId, n);
  for (const n of have) if (!wanted.includes(n)) unlinkPersonaSkill(personaId, n);
  return wanted;
}

/** 单个关联/解除：挂载是独立动作，不走"整表替换"，免得和员工表单互相覆盖 */

export function linkPersonaSkill(personaId, skillName) {
  db.prepare('INSERT OR IGNORE INTO persona_skills (personaId, skillName, addedAt) VALUES (?, ?, ?)').run(
    personaId,
    skillName,
    nowIso(),
  );
}


export function unlinkPersonaSkill(personaId, skillName) {
  return db.prepare('DELETE FROM persona_skills WHERE personaId = ? AND skillName = ?').run(personaId, skillName)
    .changes;
}

/** 某个 skill 被哪些员工挂着（删 skill 时用来清账） */

export function forgetSkillEverywhere(skillName) {
  return db.prepare('DELETE FROM persona_skills WHERE skillName = ?').run(skillName).changes;
}

/* ------------------------------------------------------------------- runs */


remapPersonaSkills();

