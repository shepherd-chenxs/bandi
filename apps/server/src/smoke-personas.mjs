/**
 * 「岗位」字段的验收（2026-10-17）。
 *
 * 它回答的是「这人在团队里**是什么**」，跟「他会干什么」（技能）是两件事：
 *   · 一个值、可空、自由文本（界面给建议列表，不锁枚举 —— 组织会变）；
 *   · 用途：看人、看板、**人工指派时辨认**；
 *   · **引擎不读它** —— 派活仍只认流程节点上点的名（`workflows.assigneeFor`）。
 *     最后那一条是这个用例的重点：防止以后有人图省事，拿岗位去自动挑人。
 *
 * 隔离：临时数据库 + 临时目录，不碰 data/ 里的真账。
 * 跑法：node apps/server/src/smoke-personas.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-personas-'));
process.env.BANDI_DATA = tmp;
process.env.BANDI_DB = path.join(tmp, 'bandi.db');

// ⚠️ 必须在设好 BANDI_DATA / BANDI_DB 之后再 import —— config 在模块加载时读环境变量
const store = await import('./store.mjs');
const workflows = await import('./workflows.mjs');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

console.log('① 建员工：岗位随人一起存下来');
const dev = store.createPersona({ name: '波哥', role: '研发', runtime: 'codex', cwd: tmp, instructions: '' });
check('role 存下来了', dev.role === '研发', String(dev.role));
check('读回来还在', store.getPersona(dev.id)?.role === '研发', String(store.getPersona(dev.id)?.role));

const nobody = store.createPersona({ name: '没填岗位的', runtime: 'codex', cwd: tmp, instructions: '' });
check('不填岗位 = null（可空）', nobody.role === null, String(nobody.role));

console.log('\n② 改岗位：能改、能清');
store.updatePersona(dev.id, { role: '架构' });
check('改成「架构」', store.getPersona(dev.id)?.role === '架构', String(store.getPersona(dev.id)?.role));
store.updatePersona(dev.id, { role: '  ' });
check('传空白 = 清掉', store.getPersona(dev.id)?.role === null, String(store.getPersona(dev.id)?.role));
store.updatePersona(dev.id, { role: '研发' });
check('只传 name 时岗位不动', (store.updatePersona(dev.id, { name: '波哥2' }).role) === '研发', String(store.getPersona(dev.id)?.role));

console.log('\n②′ 部门：跟岗位同一套口径（存、改、清、可空）');
// 部门（2026-10-25）：组织架构里他属于哪儿 —— 自由文本、只用于通讯录按部门分组，
// 引擎不读它（派活只认节点上点的名，同岗位那条铁律）。
const bai = store.createPersona({ name: '老白', role: '运维', department: '技术部', runtime: 'codex', cwd: tmp, instructions: '' });
check('department 存下来了', bai.department === '技术部', String(bai.department));
store.updatePersona(bai.id, { department: '运维部' });
check('能改', store.getPersona(bai.id)?.department === '运维部', String(store.getPersona(bai.id)?.department));
store.updatePersona(bai.id, { department: '  ' });
check('传空白 = 清掉（界面落「未分配」）', store.getPersona(bai.id)?.department === null, String(store.getPersona(bai.id)?.department));
store.updatePersona(bai.id, { department: '技术部' });
check('只传 name 时部门不动', (store.updatePersona(bai.id, { name: '老白2' }).department) === '技术部', String(store.getPersona(bai.id)?.department));

console.log('\n③ 老库也能补上这一列');
const db = new (await import('node:sqlite')).DatabaseSync(process.env.BANDI_DB, { readOnly: true });
const cols = db.prepare("PRAGMA table_info('personas')").all().map((c) => c.name);
db.close();
check('personas 有 role 列', cols.includes('role'), cols.join(','));
check('personas 有 department 列', cols.includes('department'), cols.join(','));

console.log('\n④ 重点：**岗位不参与派活** —— 引擎只认节点上点的名');
const qa = store.createPersona({ name: '星宇', role: '测试', runtime: 'codex', cwd: tmp, instructions: '' });
store.upsertWorkflowTemplate({
  id: 't-role',
  name: '岗位不参与派活',
  start: 'n1',
  nodes: [
    { id: 'n1', name: '测试', personaId: qa.id, approve: 'end', reject: 'end' }, // 点名了"测试"那个
    { id: 'n2', name: '没人', approve: 'end', reject: 'end' }, // 故意留空
    { id: 'n3', name: '技术部', approve: 'end', reject: 'end' }, // 名字像部门 —— 部门也不许参与派活
  ],
});
const tpl = store.getWorkflowTemplate('t-role');
const nodeOf = (id) => workflows.nodesOf(tpl).find((n) => n.id === id);
check('点名谁就是谁（哪怕岗位不对口）', workflows.assigneeFor(nodeOf('n1')) === qa.id, String(workflows.assigneeFor(nodeOf('n1'))));
check('没点名 → 解析不出人（不会按岗位顶一个人上来）', workflows.assigneeFor(nodeOf('n2')) === null, String(workflows.assigneeFor(nodeOf('n2'))));
check('节点叫「技术部」也不会按部门顶人上来', workflows.assigneeFor(nodeOf('n3')) === null, String(workflows.assigneeFor(nodeOf('n3'))));

const run = workflows.startWorkflow({ templateId: 't-role', title: '岗位用例', autoStart: false });
const task = store.listWorkflowTasks(run.id)[0];
check('落库的经办人 = 点名那个', task.assigneePersonaId === qa.id, String(task.assigneePersonaId));

console.log('\n⑤ 拒绝里也不提岗位（口径与技能一致：不是每个节点都有对应岗位）');
store.upsertWorkflowTemplate({
  id: 't-role2',
  name: '留空',
  start: 'n1',
  nodes: [{ id: 'n1', name: '写代码', approve: 'end', reject: 'end' }],
});
workflows.ensureBuiltInTemplate(); // 顺带保证内建模板也不会因为岗位而变
const run2 = workflows.startWorkflow({ templateId: 't-role2', title: '留空用例', autoStart: false });
const t2 = store.listWorkflowTasks(run2.id)[0];
check('留空 → 已阻塞，原因是「没点名经办人」', t2.status === '已阻塞' && /没点名经办人/.test(t2.note ?? ''), t2.note);
check('原因里不含任何岗位名', !/研发|测试|架构/.test(t2.note ?? ''), t2.note);

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* 临时目录，删不掉就算了 */
}
console.log(`\n结论：${failed ? `有 ${failed} 项没通过` : '全通过'}`);
process.exit(failed ? 1 : 0);
