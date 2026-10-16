/**
 * 流程引擎「派活规则」的验收：**只认点名，不按技能找人**（用户 2026-10-14 定）。
 *
 * 规则本身：
 *   · 节点上点了名 → 派给那个人（哪怕他一个技能都没挂）；
 *   · 节点没点名 → 那是**故意留空**：到站即「已阻塞」，等人指派；
 *     **引擎不许按技能挑一个人顶上**，原因里也不提技能（不是每个节点都有对应技能）；
 *   · 技能是"这个人会干什么"，绑在数字员工身上；流程不拿它当路由键。
 *
 * 隔离：临时数据库 + 临时目录，不碰 data/ 里的真账。
 * 跑法：node apps/server/src/smoke-workflows.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-workflows-'));
/*
 * `BANDI_DATA` 和 `BANDI_DB` 都要指过去。
 * 光隔离数据库不够 —— `runtimes.json` / `plugins.json` / `connectors/` 全是从**数据目录**
 * 派生的，不指的话它们照样写进真实的 `data/`（2026-10-15 起数据目录可指）。
 */
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

// 两个人：一个挂着 bandi-qa，一个什么技能都没挂
const qa = store.createPersona({ name: '星宇', runtime: 'codex', cwd: tmp, instructions: '' });
const noSkills = store.createPersona({ name: '谁也没挂', runtime: 'codex', cwd: tmp, instructions: '' });
store.setPersonaSkills(qa.id, ['bandi-qa']);

store.upsertWorkflowTemplate({
  id: 't-assign',
  name: '派活规则验证',
  start: 'n1',
  nodes: [
    { id: 'n1', name: '测试', approve: 'n2', reject: 'end' },                    // 没点名
    { id: 'n2', name: '汇报', personaId: qa.id, approve: 'n3', reject: 'end' },  // 点名了
    { id: 'n3', name: '收尾', personaId: 'p-不存在', approve: 'end', reject: 'end' },
  ],
});

console.log('① 没点名 → 到站即阻塞，不顶上人');
const run = workflows.startWorkflow({ templateId: 't-assign', title: '用例' });
const first = run.tasks?.[0] ?? null;
check('第一步任务建出来了', !!first, first?.status);
check('状态是「已阻塞」', first?.status === '已阻塞', first?.status);
check('没有指派任何人（技能没被用来顶人）', !first?.assigneePersonaId, String(first?.assigneePersonaId));
check('原因就是「没点名经办人」', first?.note?.startsWith('「测试」没点名经办人'), first?.note);
check('原因里不含技能名（哪怕有人挂着 bandi-qa）', !/bandi-qa|技能/.test(first?.note ?? ''), first?.note);
check('流程照样建出来', run?.status === '进行中', run?.status);

console.log('\n② 没点名的步骤不能直接派活');
let threw = '';
try { workflows.startCurrentStep(run.id); } catch (e) { threw = e.message; }
check('派活被拒且说明原因', /没点名经办人/.test(threw), threw);

console.log('\n③ 点名一个没有任何技能的人 → 照派（技能不是门槛）');
store.upsertWorkflowTemplate({
  id: 't-named',
  name: '点名验证',
  start: 'n1',
  nodes: [{ id: 'n1', name: '干活', personaId: noSkills.id, approve: 'end', reject: 'end' }],
});
// autoStart:false = 只建不派活，避免真的叫起 agent 进程
const run2 = workflows.startWorkflow({ templateId: 't-named', title: '用例2', autoStart: false });
const t2 = run2.tasks?.[0] ?? null;
check('经办人 = 点名的那个', t2?.assigneePersonaId === noSkills.id, String(t2?.assigneePersonaId));
check('没被标成阻塞', t2?.status !== '已阻塞', t2?.status);

console.log('\n④ 解析规则：不认技能，只认人');
const tpl = store.getWorkflowTemplate('t-assign');
const nodeOf = (id) => workflows.nodesOf(tpl).find((n) => n.id === id);
check('点名的人被认出来', workflows.assigneeFor(nodeOf('n2')) === qa.id, String(workflows.assigneeFor(nodeOf('n2'))));
check('点名的人不在了 → 解析不出', workflows.assigneeFor(nodeOf('n3')) === null, String(workflows.assigneeFor(nodeOf('n3'))));
check('内建模板的节点上没有 skill 字段', workflows.BUILT_IN_TEMPLATE.nodes.every((n) => !('skill' in n)));
check('resolveAssignee 已不存在', typeof workflows.resolveAssignee === 'undefined');
check('skillOwners 已不存在', typeof workflows.skillOwners === 'undefined');

console.log('\n⑤ 实例视图：节点带出口（时间轴末尾的「结束」靠它说清怎么走到）');
const view = workflows.getWorkflowView(run.id);
check('实例视图不吐 skill 字段', !('skill' in view), Object.keys(view).join(','));
check('节点带 approve/reject', (view.nodes ?? []).every((n) => 'approve' in n && 'reject' in n), JSON.stringify(view.nodes?.map((n) => [n.name, n.approve, n.reject])));
check('最后一个节点确实指向 end（模板里 approve=end）', (view.nodes ?? []).some((n) => n.approve === 'end'), JSON.stringify(view.nodes?.map((n) => n.approve)));

console.log('\n⑥ 老实例跟不跟着模板走？（用户问的：旧流程生效还是新起流程生效）');
/*
 * 语义（读代码 + 这里钉死）：
 *   · **出口（approve/reject）实时读模板** → 改模板，已经起跑的实例**立刻跟着走**；
 *   · **人选是快照**：节点的 personaId 只在建任务时落库，之后改模板不动老任务；
 *   · 节点被从模板里删掉 → 老实例当前节点悬空，通过/驳回被**明确拒绝**（不是静默卡住）。
 */
const tplLive = (nodes) => store.upsertWorkflowTemplate({ id: 't-live', name: '实时读模板', start: 'n1', nodes });
tplLive([
  { id: 'n1', name: '第一步', personaId: noSkills.id, approve: 'end', reject: 'end' },
  { id: 'n2', name: '第二步', approve: 'end', reject: 'end' },
]);
const liveRun = workflows.startWorkflow({ templateId: 't-live', title: '用例3', autoStart: false });
const step1 = store.listWorkflowTasks(liveRun.id)[0];
check('起跑时把人选落进任务（快照）', step1?.assigneePersonaId === noSkills.id, String(step1?.assigneePersonaId));

tplLive([
  { id: 'n1', name: '第一步', personaId: qa.id, approve: 'end', reject: 'end' }, // 换了人
  { id: 'n2', name: '第二步', approve: 'end', reject: 'end' },
]);
check('改模板的人选 → 老任务不动（快照）', store.listWorkflowTasks(liveRun.id)[0]?.assigneePersonaId === noSkills.id);

tplLive([
  { id: 'n1', name: '第一步', personaId: qa.id, approve: 'n2', reject: 'end' }, // 出口 end → n2
  { id: 'n2', name: '第二步', approve: 'end', reject: 'end' },
]);
store.updateWorkflowTask(step1.id, { status: '待确认' });
const after = workflows.decide(liveRun.id, '通过');
check('改模板的出口 → 老实例立刻走到新节点', after?.currentNodeId === 'n2' && after?.status === '进行中', `${after?.currentNodeId} / ${after?.status}`);

tplLive([{ id: 'n1', name: '第一步', personaId: qa.id, approve: 'end', reject: 'end' }]); // n2 被删
let delErr = '';
try { workflows.decide(liveRun.id, '驳回'); } catch (e) { delErr = e.message; }
check('节点被删 → 驳回没有去处，明确拒绝（不是静默卡住）', /模板里已经没有了/.test(delErr), delErr);
const orphanView = workflows.getWorkflowView(liveRun.id);
check('界面据此能认出"当前节点悬空"', !orphanView.nodes.some((n) => n.id === orphanView.currentNodeId), `${orphanView.currentNodeId} vs ${orphanView.nodes.map((n) => n.id).join(',')}`);
// 通过放行 = 收尾：不能让人卡在一个"没有任何出路"的状态里（用户实报过）
const closed = workflows.decide(liveRun.id, '通过');
check('节点被删 → 通过可以收尾（流程已完成）', closed?.status === '已完成', `${closed?.status} / ${closed?.note}`);
check('收尾写明了原因（可追溯，不是静默跳过）', /已不在模板里/.test(closed?.note ?? ''), closed?.note);

console.log('\n⑦ 数据形状：库里不再有 skill 列');
const db = new (await import('node:sqlite')).DatabaseSync(process.env.BANDI_DB, { readOnly: true });
const cols = (t) => db.prepare(`PRAGMA table_info('${t}')`).all().map((c) => c.name);
check('workflow_tasks 没有 skill 列', !cols('workflow_tasks').includes('skill'), cols('workflow_tasks').join(','));
check('workflow_steps 没有 skill 列', !cols('workflow_steps').includes('skill'), cols('workflow_steps').join(','));
db.close();

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录，删不掉就算了 */ }
console.log(`\n结论：${failed ? '有 ' + failed + ' 项没通过' : '全通过'}`);
process.exit(failed ? 1 : 0);
