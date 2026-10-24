/**
 * 内置员工（系统管家「崔老三」，2026-10-23 前是秘书「喜儿」）的离线验收（2026-10-18 建，2026-10-23 随名额换人更新）。
 *
 * 分两段：
 *   ① 直接 import —— seed 幂等、内置不可删、`auto` 运行时、首轮注入那段「机器现状」、
 *      `syncSecretary` 把存量身份拉回出厂（2026-10-22 收编 + 2026-10-23 换人都靠它迁移）；
 *   ② 真起一个控制面（临时数据目录）—— 接口层：出厂就在、删他 403、身份锁死（E2055）但部署配置可改。
 *
 * 为什么 ② 非跑不可：①验的是函数，而人踩的是**接口**。删不掉这条曾经靠前端藏按钮，
 * 接口照删 —— 现在两道都得有，那就两道都得测。
 *
 * 跑法：node apps/server/src/smoke-secretary.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-xier-'));
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-xier-http-'));

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

/* ⚠️ 环境变量必须在 import 之前设好（store 一加载就开库） */
process.env.BANDI_DATA = tmp;
process.env.BANDI_DB = path.join(tmp, 'bandi.db');

const store = await import('./store.mjs');
const secretary = await import('./secretary.mjs');
const skills = await import('./skills.mjs');
const runtimes = await import('./runtimes.mjs');
const dispatch = await import('./dispatch.mjs');

/* ------------------------------------------------- ① seed：出厂就在，且只建一次 */
console.log('① seed：建一次、幂等、不改用户后来的修改');
const first = secretary.ensureSecretary();
check('第一次 → 建出来了', first.created === true);
check('固定 id（幂等靠它）', first.persona.id === secretary.SECRETARY_ID, first.persona.id);
check('打上了内置标记', first.persona.builtin === 1);
check('运行时是 auto（换机器不用改她）', first.persona.runtime === 'auto', first.persona.runtime);
check('工作目录 = 平台根（她要读 skills/ 与日志）', first.persona.cwd === repoRoot, first.persona.cwd);
check('有岗位指令（不是个空壳）', String(first.persona.instructions).length > 100);

const n1 = store.listPersonas().length;
const second = secretary.ensureSecretary();
check('再调一次 → 不新建', second.created === false);
check('人数没变（幂等）', store.listPersonas().length === n1, `${n1} → ${store.listPersonas().length}`);

/* 用户改名/改职责之后，ensureSecretary 不动它（seed 只管建；刷回出厂是 syncSecretary 的事） */
store.updatePersona(secretary.SECRETARY_ID, { name: '小秘', instructions: '我自己的设定' });
secretary.ensureSecretary();
const after = store.getPersona(secretary.SECRETARY_ID);
check('ensureSecretary 不刷用户改动（职责分离：刷回是 sync 的活）', after.name === '小秘', after.name);
check('改指令后再启动 → 指令保住', after.instructions === '我自己的设定');
check('内置标记也还在', after.builtin === 1);

/* syncSecretary：不管库里什么样，跑完 = 出厂 —— 2026-10-23 喜儿→崔老三的存量迁移就走的这条路 */
const synced = secretary.syncSecretary();
const back = store.getPersona(secretary.SECRETARY_ID);
check('syncSecretary 把改过的名字刷回出厂', back.name === secretary.SECRETARY_NAME && back.name === '崔老三', back.name);
check('指令也回到出厂', back.instructions === secretary.SECRETARY_INSTRUCTIONS);
check('返回了动过的字段清单（给启动日志用）', Array.isArray(synced) && synced.includes('name') && synced.includes('instructions'), JSON.stringify(synced));
const synced2 = secretary.syncSecretary();
check('再跑一遍 → 幂等（空数组）', Array.isArray(synced2) && synced2.length === 0, JSON.stringify(synced2));
store.updatePersona(secretary.SECRETARY_ID, { name: secretary.SECRETARY_NAME, instructions: secretary.SECRETARY_INSTRUCTIONS });

/* ---- ①a 存量 id 迁移（2026-10-23）：旧库的 p-xier 整行搬到 p-cuilaosan，引用跟着走 ---- */
console.log('\n①a id 迁移：p-xier → p-cuilaosan，十几张表的引用一次搬齐');
{
  const { db } = await import('./store/db.mjs');
  // 把内置名额撤回旧 id（喜儿时代的样子），再摆两条会被迁移波及的引用
  db.prepare(`DELETE FROM persona_skills WHERE personaId = ?`).run(secretary.SECRETARY_ID);
  db.prepare(`UPDATE personas SET id = 'p-xier', name = '喜儿', avatar = 'p-xier.png' WHERE id = ?`).run(secretary.SECRETARY_ID);
  db.prepare(`INSERT INTO conversations (id, title, personaId, createdAt, updatedAt)
              VALUES ('c-mig-test', '迁移测试会话', 'p-xier', '2026-10-23T00:00:00Z', '2026-10-23T00:00:00Z')`).run();
  db.prepare(`INSERT INTO persona_skills (personaId, skillName, addedAt)
              VALUES ('p-xier', 'bandi-secretary', '2026-10-23T00:00:00Z')`).run();
  db.prepare(`INSERT INTO groups (id, title, assistantPersonaId, createdAt, updatedAt)
              VALUES ('g-mig-test', '迁移测试群', 'p-xier', '2026-10-23T00:00:00Z', '2026-10-23T00:00:00Z')`).run();

  check('迁移跑一次 → 报告真的迁了', secretary.migrateSecretaryId() === true);
  const moved = store.getPersona(secretary.SECRETARY_ID);
  check('旧行整行搬到新 id（名字原样带走）', !!moved && moved.name === '喜儿', moved?.name);
  check('avatar 文件名跟着换（图片文件已同步改名）', moved?.avatar === 'p-cuilaosan.png', moved?.avatar);
  check('旧 id 不再有行', !store.getPersona('p-xier'));
  check('会话归属跟着走', db.prepare(`SELECT personaId FROM conversations WHERE id = 'c-mig-test'`).get()?.personaId === secretary.SECRETARY_ID);
  check('群助手指向跟着走', db.prepare(`SELECT assistantPersonaId FROM groups WHERE id = 'g-mig-test'`).get()?.assistantPersonaId === secretary.SECRETARY_ID);
  check('技能挂载跟着走', db.prepare(`SELECT COUNT(*) AS n FROM persona_skills WHERE personaId = ?`).get(secretary.SECRETARY_ID)?.n >= 1);

  check('再跑一次 → 幂等（无事发生）', secretary.migrateSecretaryId() === false);
  secretary.ensureSecretary(); // 补回 builtin 标记等（迁移不改这些）
  // 清场：别让测试数据留在后面几段的视野里
  db.prepare(`DELETE FROM conversations WHERE id = 'c-mig-test'`).run();
  db.prepare(`DELETE FROM groups WHERE id = 'g-mig-test'`).run();
}

/* 技能：只在新建那次挂，之后用户摘掉就摘掉了 */
const linked = store.listPersonaSkillLinks(secretary.SECRETARY_ID).map((l) => l.name);
check('技能库里有 bandi-secretary', !!skills.getSkill(secretary.SECRETARY_SKILL));
check('她挂上了这个技能', linked.includes(secretary.SECRETARY_SKILL), linked.join(',') || '(空)');
store.unlinkPersonaSkill(secretary.SECRETARY_ID, secretary.SECRETARY_SKILL);
secretary.ensureSecretary();
check('用户把技能摘掉后，启动不会偷偷挂回去', !store.listPersonaSkills(secretary.SECRETARY_ID).includes(secretary.SECRETARY_SKILL));
store.linkPersonaSkill(secretary.SECRETARY_ID, secretary.SECRETARY_SKILL);

/* --------------------------------------------- ①b 不可删（store 是最后一道） */
console.log('\n①b 不可删：store 层拦截，且只拦她一个');
let thrown = '';
try {
  store.deletePersona(secretary.SECRETARY_ID);
} catch (err) {
  thrown = String(err?.message ?? err);
}
check('删她 → 抛错', !!thrown, thrown);
check('错误里说清了"不能删"', thrown.includes('内置') && thrown.includes('不能删'));
check('她还在（没删半截）', !!store.getPersona(secretary.SECRETARY_ID));

const plain = store.createPersona({ name: '临时工', runtime: 'codex' });
check('普通员工没被误标内置', plain.builtin === 0);
check('普通员工照旧能删（拦截没写宽）', (() => {
  try {
    store.deletePersona(plain.id);
    return !store.getPersona(plain.id);
  } catch {
    return false;
  }
})());

/* ------------------------------------------- ①c runtime=auto 能解析出真运行时 */
console.log('\n①c runtime=auto：按"谁现在能用"挑');
check('resolveForRun(auto) 不炸', (() => {
  try {
    runtimes.resolveForRun('auto');
    return true;
  } catch {
    return false;
  }
})());
check('一个可用的都没有时 → null（不是随便糊一个）', (() => {
  const usable = runtimes.publicList().some((r) => r.enabled && !r.blocked && r.pathExists);
  const got = runtimes.resolveForRun('auto');
  return usable ? !!got : got === null;
})(), JSON.stringify(runtimes.resolveForRun('auto')?.id ?? null));

/* ------------------------------------------ ①d 首轮注入：那段「机器现状」 */
console.log('\n①d 首轮注入：机器现状只在首轮、只在有 brief 时出现');
const brief = secretary.secretaryBrief();
check('含服务地址', brief.includes('127.0.0.1') || brief.includes('http://'), brief.split('\n')[1] ?? '');
check('含数据目录（现取的，不是写死的）', brief.includes(process.env.BANDI_DATA));
check('含员工数', /现有数字员工\s*\d+\s*个/.test(brief));
check('提醒了 --noproxy（否则回环会被代理吃成 502）', brief.includes('--noproxy'));
check('提醒了别把这几行背给用户', brief.includes('不要在回复里背'));

const fakeThread = { personaInstructions: '你是秘书。' };
const t1 = dispatch.buildDirectTask(fakeThread, '在吗', true, [], [], brief);
check('首轮 → 带上了机器现状', t1.includes('这台机器的现状'));
check('首轮 → 岗位指令也在', t1.includes('你是秘书。'));
check('首轮 → 用户原话在最后（模型先看设定再看话）', t1.trimEnd().endsWith('在吗'));
const t2 = dispatch.buildDirectTask(fakeThread, '在吗', false, [], [], brief);
check('后续轮 → 只有原话（brief 不重复灌）', t2 === '在吗');
const t3 = dispatch.buildDirectTask(fakeThread, '在吗', true, [], [], '');
check('普通员工（无 brief）→ 不掺平台信息', !t3.includes('这台机器的现状'));

/* --------------------------------------------------------------- ② 接口层 */
const PORT = Number(process.env.SMOKE_PORT ?? 8894);
const BASE = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, [path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs')], {
  cwd: repoRoot,
  env: { ...process.env, BANDI_PORT: String(PORT), BANDI_DATA: tmp2, BANDI_DB: path.join(tmp2, 'bandi.db') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (b) => { serverLog += b.toString(); });
child.stderr.on('data', (b) => { serverLog += b.toString(); });

const req = async (p, opt = {}) => {
  const r = await fetch(BASE + p, { ...opt, headers: { 'Content-Type': 'application/json', ...(opt.headers ?? {}) } });
  const text = await r.text();
  let b = null;
  try {
    b = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: r.status, b };
};

try {
  let up = false;
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(BASE + '/api/state')).ok) {
        up = true;
        break;
      }
    } catch {
      /* 还没起 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  check('控制面起来了', up);
  if (!up) console.log(serverLog.split('\n').slice(-15).join('\n'));

  if (up) {
    console.log('\n② 接口层：出厂就有、删不掉、身份锁死但部署配置可改');
    const st = await req('/api/state');
    const steward = (st.b?.personas ?? []).find((p) => p.id === secretary.SECRETARY_ID);
    check('全新一套库里，他一装好就在', !!steward, JSON.stringify((st.b?.personas ?? []).map((p) => p.name)));
    check('出厂就是崔老三（2026-10-23 名额换人，seed/sync 负责刷）', steward?.name === '崔老三', steward?.name);
    check('/api/state 带出 builtin（前端徽标靠它）', steward?.builtin === 1);
    check('人的总数就是 1（没多建几个）', (st.b?.personas ?? []).length === 1);

    const del = await req(`/api/personas/${secretary.SECRETARY_ID}`, { method: 'DELETE' });
    check('删他 → 403（不是 500）', del.status === 403, `${del.status} ${del.b?.code ?? ''}`);
    check('给了错误码，界面能照着说人话', del.b?.code === 'E1075', del.b?.code);
    check('提示给了出路（另建员工）', String(del.b?.error ?? '').includes('另建'), del.b?.error);
    check('删完他还在', (await req('/api/state')).b.personas.some((p) => p.id === secretary.SECRETARY_ID));

    /* 身份锁（2026-10-23 E2055）：名字/岗位/指令一律拒改 —— 改身份只能改 secretary.mjs 出厂值 */
    const ren = await req(`/api/personas/${secretary.SECRETARY_ID}`, {
      method: 'PUT',
      body: JSON.stringify({ name: '老崔（改过）', instructions: '自定义' }),
    });
    check('改名/改指令 → 403 E2055（身份锁死，不是 200）', ren.status === 403 && ren.b?.code === 'E2055', `${ren.status} ${ren.b?.code ?? ''}`);
    const ren2 = await req(`/api/personas/${secretary.SECRETARY_ID}`, {
      method: 'PUT',
      body: JSON.stringify({ name: '崔老三', instructions: secretary.SECRETARY_INSTRUCTIONS, runtime: 'auto' }),
    });
    check('身份没变、只顺手带 runtime → 200（锁判的是"值真的变了"）', ren2.status === 200, `${ren2.status} ${ren2.b?.code ?? ''}`);
    check('存完还是 auto', ren2.b?.persona?.runtime === 'auto', ren2.b?.persona?.runtime);

    // 普通员工：照常能建能删，别被内置那套规则带上
    const made = await req('/api/personas', { method: 'POST', body: JSON.stringify({ name: '临时员工' }) });
    check('普通员工能建', made.status === 201, JSON.stringify(made.b?.code));
    check('普通员工不是内置', made.b?.persona?.builtin === 0);
    const delPlain = await req(`/api/personas/${encodeURIComponent(made.b?.persona?.id ?? '')}`, { method: 'DELETE' });
    check('普通员工能删', delPlain.status === 200, String(delPlain.status));
    check('删完只剩内置管家一个人', (await req('/api/state')).b.personas.map((p) => p.id).join(',') === secretary.SECRETARY_ID);
  }
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 300));
  for (const d of [tmp, tmp2]) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* 删不掉就算了 */
    }
  }
}

console.log(`\n结论：${failed ? `有 ${failed} 项没通过` : '全通过'}`);
process.exit(failed ? 1 : 0);
