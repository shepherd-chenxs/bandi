/**
 * **岗位与权限模型**的验收（2026-11-11，设计见 docs/design/2026-11-11-岗位固定与权限模型.md）。
 *
 * 验的是「岗位系统内置、权限挂在岗位上」这条改动的骨架：
 *   ① 岗位表本身：key 唯一、权限都在 PERMISSIONS 里、内置岗位只有助理/系统管家、
 *      项目经理的权限集合固定（多一条/少一条都红 —— 权限是产品口径，不是实现细节）；
 *   ② `can()` 是唯一判据：按 roleKey 判，不认 role 文本；未知/空岗位一律没有权限；
 *   ③ 旧文本映射：15 个出厂岗位名（含「岗位 · 职责」两段写法和常见简写）都能对上，
 *      认不出来的返回 null（不猜）；
 *   ④ 数据库迁移：老库（只有 role 文本）打开一次就补 roleKey 并回填，再开一次幂等；
 *      认不出来的文本留 NULL；
 *   ⑤ store 层：建人/改人时 roleKey 跟着走；显式改 roleKey 权限立即生效；
 *   ⑥ 源码守卫：`apps/server/src` 里不许再出现 `isPmRole(` / `roleHeadOf(` 的调用
 *      （roles.mjs 的说明性注释除外）—— 防止哪天又按文本判权限。
 *
 * 隔离：临时数据目录 + 临时库，跑完全删；不联网、不起服务。
 * 跑法：node apps/server/src/smoke-roles.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { PERMISSIONS, ROLES, can, isRoleKey, legacyRoleKey, roleCan, roleOf, roleSkills } from './roles.mjs';

const repo = path.resolve(import.meta.dirname, '..', '..', '..');
const SRC = path.join(repo, 'apps', 'server', 'src');
const DB_MODULE = pathToFileURL(path.join(SRC, 'store', 'db.mjs')).href;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-roles-'));
const DB = path.join(tmp, 'bandi.db');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

/** 在子进程里打开一次库（= 一次启动），返回 { code, out, err } */
function bootOnce(dbPath, dataDir) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(DB_MODULE)});`], {
    cwd: repo,
    env: { ...process.env, BANDI_DATA: dataDir, BANDI_DB: dbPath, BANDI_HOST: '127.0.0.1' },
    encoding: 'utf8',
  });
  return { code: r.status, out: String(r.stdout ?? ''), err: String(r.stderr ?? '') };
}

try {
  console.log('① 岗位表口径');
  const keys = ROLES.map((r) => r.key);
  check('岗位 key 不重复', new Set(keys).size === keys.length, keys.join(','));
  check('内置岗位只有助理 / 系统管家', ROLES.filter((r) => r.kind === 'builtin').map((r) => r.key).sort().join(',') === 'assistant,steward',
    ROLES.filter((r) => r.kind === 'builtin').map((r) => r.key).join(','));
  const badPerm = ROLES.flatMap((r) => r.permissions.filter((p) => !Object.hasOwn(PERMISSIONS, p)));
  check('每个岗位的权限都在 PERMISSIONS 清单里', !badPerm.length, badPerm.join(','));
  check('项目经理 = 建卡 / 拆子卡 / 改卡 / 承接团队卡（四条，不多不少）',
    [...roleOf('pm').permissions].sort().join(',') === 'card.advance,card.create,card.split,team.coordinate',
    roleOf('pm').permissions.join(','));
  check('除项目经理外没有岗位带权限（本期：验收权不下放，task.review 全员为空）',
    ROLES.filter((r) => r.key !== 'pm').every((r) => r.permissions.length === 0),
    ROLES.filter((r) => r.permissions.length).map((r) => r.key).join(','));
  /*
   * 岗位技能包（2026-11-11 Phase 3）：技能挂在岗位上，雇佣/同步按它自动挂载。
   * 每个岗位都要有包 —— 空包 = 雇回来一个"什么方法论都没有"的人。
   */
  check('每个岗位都有技能包（≥1 个）', ROLES.every((r) => (r.skills ?? []).length > 0),
    ROLES.filter((r) => !(r.skills ?? []).length).map((r) => r.key).join(',') || '(全有)');
  check('项目经理的技能包 = 岗位方法论 + 汇报口径',
    ['bandi-expert-pm', 'bandi-report'].every((s) => roleSkills('pm').includes(s)), roleSkills('pm').join(','));
  check('系统管家的技能包 = bandi-secretary', roleSkills('steward').join(',') === 'bandi-secretary', roleSkills('steward').join(','));
  check('未知岗位没有技能包（不猜）', roleSkills('ceo').length === 0);
  check('专家包不再各写一份技能清单（单一来源在 roles.mjs）',
    !/^\s*skills: \[/m.test(fs.readFileSync(path.join(SRC, 'experts.mjs'), 'utf8')), '');

  console.log('\n② can() / roleCan()：只认 roleKey');
  check('pm → 可建卡', can({ roleKey: 'pm' }, 'card.create') === true);
  check('dev → 不可建卡', can({ roleKey: 'dev' }, 'card.create') === false);
  check('roleKey 为空 → 没有任何权限', can({}, 'card.create') === false && can({ roleKey: null }, 'team.coordinate') === false);
  check('未知 roleKey → 没有权限（不猜）', can({ roleKey: 'ceo' }, 'card.create') === false);
  check('roleCan 与 can 同口径', roleCan('pm', 'task.review') === false && roleCan('qa', 'card.create') === false);
  check('roleOf 未知 key 返回 null', roleOf('nope') === null && roleOf(undefined) === null);

  console.log('\n③ 旧 role 文本 → 岗位 key');
  const legacy = [
    ['项目经理', 'pm'],
    ['项目经理 · 拆活盯落实', 'pm'],
    ['产品经理 · 理需求与写文档', 'product'],
    ['架构师', 'architect'],
    ['UI 设计师', 'ui'],
    ['研发工程师 · 写代码与修 Bug', 'dev'],
    ['测试工程师', 'test'],
    ['QA 工程师', 'qa'],
    ['运维工程师', 'ops'],
    ['内容主编', 'editor'],
    ['数据运营', 'analyst'],
    ['文案策划', 'copywriter'],
    ['短视频编导', 'director'],
    ['仓库管家', 'repo-keeper'],
    ['助理', 'assistant'],
    ['系统管家', 'steward'],
    // 简写（存量自由文本里出现过）
    ['研发', 'dev'],
    ['架构', 'architect'],
  ];
  const missed = legacy.filter(([text, key]) => legacyRoleKey(text) !== key);
  check('15 个出厂岗位名（含「岗位 · 职责」写法）都能映射', !missed.length, missed.map(([t]) => t).join('、'));
  check('认不出来的文本 → null（不猜）', legacyRoleKey('神秘岗位') === null && legacyRoleKey('') === null && legacyRoleKey(undefined) === null);

  console.log('\n④ 数据库迁移：老库只有 role 文本');
  const pre = new DatabaseSync(DB);
  pre.exec(`
    CREATE TABLE personas (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT '',
      runtime TEXT NOT NULL DEFAULT 'codex', sandbox TEXT NOT NULL DEFAULT 'workspace-write',
      cwd TEXT, model TEXT, createdAt TEXT NOT NULL,
      role TEXT, department TEXT, builtin INTEGER NOT NULL DEFAULT 0
    );
  `);
  const ins = pre.prepare('INSERT INTO personas (id, name, role, createdAt) VALUES (?, ?, ?, ?)');
  ins.run('p-pm', '贺韬', '项目经理', '2026-11-11T00:00:00.000Z');
  ins.run('p-dev', '嘉辉', '研发工程师 · 写代码与修 Bug', '2026-11-11T00:00:00.000Z');
  ins.run('p-unknown', '神秘人', '神秘岗位', '2026-11-11T00:00:00.000Z');
  ins.run('p-empty', '空岗位', null, '2026-11-11T00:00:00.000Z');
  pre.close();

  /* 第一遍：本地 import 一次（等于启动），把迁移日志抓下来断言 */
  process.env.BANDI_DATA = tmp;
  process.env.BANDI_DB = DB;
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.map(String).join(' '));
  const dbMod = await import(DB_MODULE);
  console.log = origLog;
  const keyOf = (id) => dbMod.db.prepare('SELECT roleKey FROM personas WHERE id = ?').get(id)?.roleKey ?? null;
  check('项目经理 → pm', keyOf('p-pm') === 'pm', String(keyOf('p-pm')));
  check('「岗位 · 职责」两段写法取前段 → dev', keyOf('p-dev') === 'dev', String(keyOf('p-dev')));
  check('认不出来的文本留 NULL（不猜）', keyOf('p-unknown') === null, String(keyOf('p-unknown')));
  check('空岗位留 NULL', keyOf('p-empty') === null, String(keyOf('p-empty')));
  check('日志报出回填条数（2 位）', logs.some((l) => /\[迁移\] 2 位员工的岗位文本映射成内置岗位 key/.test(l)),
    logs.filter((l) => /迁移/.test(l)).join(' | '));
  check('结构版本推到 SCHEMA_VERSION', Number(dbMod.db.prepare('PRAGMA user_version').get().user_version) === dbMod.SCHEMA_VERSION,
    `${dbMod.db.prepare('PRAGMA user_version').get().user_version} / ${dbMod.SCHEMA_VERSION}`);

  console.log('\n⑤ store 层：建人 / 改人时 roleKey 跟着走');
  const store = await import(pathToFileURL(path.join(SRC, 'store', 'personas.mjs')).href);
  const dev = store.createPersona({ name: '自建研发', role: '研发工程师' });
  check('建人：role 文本映射出 roleKey', dev.roleKey === 'dev' && store.getPersona(dev.id).roleKey === 'dev', String(dev.roleKey));
  check('建人：研发岗没有建卡权限', can(store.getPersona(dev.id), 'card.create') === false);
  const explicit = store.createPersona({ name: '显式岗位', role: '研发工程师', roleKey: 'pm' });
  check('建人：显式 roleKey 优先于文本', explicit.roleKey === 'pm' && can(explicit, 'card.create') === true, String(explicit.roleKey));
  store.updatePersona(dev.id, { roleKey: 'pm' });
  check('改 roleKey 为 pm → 建卡权立即生效', can(store.getPersona(dev.id), 'card.create') === true);
  store.updatePersona(dev.id, { role: '研发工程师' });
  check('改 role 文本回研发 → 权限跟着收回（过渡期文本兜底）', can(store.getPersona(dev.id), 'card.create') === false && store.getPersona(dev.id).roleKey === 'dev');
  check('isRoleKey：清单内 true / 清单外 false', isRoleKey('pm') === true && isRoleKey('ceo') === false);

  console.log('\n⑥ 迁移幂等：再启动一次什么都不变');
  const second = bootOnce(DB, tmp);
  check('第二次启动成功', second.code === 0, `code=${second.code} ${(second.err || second.out).slice(-300)}`);
  check('第二次不再打印回填（幂等）', !/岗位文本映射成内置岗位 key/.test(second.out), second.out.slice(-300));
  const ro = new DatabaseSync(DB, { readOnly: true });
  const again = Object.fromEntries(ro.prepare('SELECT id, roleKey FROM personas').all().map((r) => [r.id, r.roleKey]));
  ro.close();
  check('roleKey 与第一次一致', again['p-pm'] === 'pm' && again['p-dev'] === 'dev' && again['p-unknown'] === null, JSON.stringify(again));

  console.log('\n⑦ 源码守卫：权限判定不再解析 role 文本');
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.mjs')) files.push(p);
    }
  };
  walk(SRC);
  const offenders = files
    .filter((f) => !['roles.mjs', 'smoke-roles.mjs'].includes(path.basename(f)))
    .filter((f) => /isPmRole\(|roleHeadOf\(/.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(repo, f).split(path.sep).join('/'));
  check('apps/server/src 里没有 isPmRole( / roleHeadOf( 的调用', !offenders.length, offenders.join(','));

  console.log('\n⑧ 源码守卫：项目经理不许自己执行（2026-11-11 实报：SSH 装 Maven）');
  const expertsSrc = fs.readFileSync(path.join(SRC, 'experts.mjs'), 'utf8');
  const dispatchSrc = fs.readFileSync(path.join(SRC, 'dispatch.mjs'), 'utf8');
  /*
   * 身份卡那句「专长之外的活也接，先声明再照常做完」是"PM 自己上手"的直接授权：
   * 用户让他更新 thinkpad，他 SSH 装 Maven，运维（马超）在群也没派。改成"先建卡派给对应岗位"。
   */
  const hetaoLine = expertsSrc.split(/\r?\n/).find((l) => l.includes('你是「贺韬」')) ?? '';
  check('贺韬身份卡不再写「专长之外的活也接」', !hetaoLine.includes('专长之外的活也接'), hetaoLine.slice(0, 120));
  check('贺韬身份卡写明「派给对应岗位」', /派给对应岗位/.test(hetaoLine), hetaoLine.slice(0, 120));
  check('贺韬身份卡写明「信息咨询直接答」', /信息咨询/.test(hetaoLine) && /不建卡/.test(hetaoLine), hetaoLine.slice(0, 160));
  check('贺韬身份卡写明「没有能干这个的人」就报雇主', /没有能干这个的人|没有人能干/.test(hetaoLine), hetaoLine.slice(0, 160));
  /*
   * 每轮「统筹职责」：2026-11-12 用户口径——先分三类（咨询 / 派活 / 无对口岗位），
   * 并给"只读查询可自己做、有副作用必须派"的边界。
   */
  const pmBlock = dispatchSrc.slice(dispatchSrc.indexOf('function pmDispatchBlock'));
  check('统筹合同写明运维 / 部署 → 派运维岗位', /派运维岗位/.test(pmBlock), pmBlock.slice(0, 120));
  check('统筹合同禁止登服务器 / 部署 / 装环境', /不登服务器/.test(pmBlock) && /不部署/.test(pmBlock) && /不装环境/.test(pmBlock));
  check('统筹合同先分三类（信息咨询 → 查台账直接答）', /信息咨询/.test(pmBlock) && /不建卡、不派活/.test(pmBlock));
  check('统筹合同写明「团队没有对应岗位的人」就报雇主', /没有能干这个的人/.test(pmBlock));
  check('统筹合同写明「只读查询可自己做、有副作用必须派」', /只读查询/.test(pmBlock) && /有副作用的操作/.test(pmBlock));
  check('统筹合同：普通执行任务默认 todo，不许用 idea 让雇主点状态', /一律建 `todo`（待办）/.test(pmBlock) && /不要建 `idea`/.test(pmBlock));
  check('统筹合同：雇主已授权可逆执行动作', /被雇主授权/.test(pmBlock));
  check('建卡通道：只收码、省略 = todo、idea 只用于真拍板', /status 只收码/.test(dispatchSrc) && /省略 = `todo`/.test(dispatchSrc) && /`idea` 只用于真正要雇主定的/.test(dispatchSrc));
  check('平台契约：例行部署/迁移不用等雇主拍板', /例行部署 \/ 迁移/.test(dispatchSrc));
  check('员工宪法对 PM 有统筹岗特别约定（覆盖"超常项照接"）', /统筹岗的特别约定/.test(dispatchSrc) && /constitutionBlock\(\{ roleKey/.test(dispatchSrc));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
}

console.log(`\n结论：${failed ? `${failed} 项没过` : '全通过'}`);
process.exit(failed ? 1 : 0);
