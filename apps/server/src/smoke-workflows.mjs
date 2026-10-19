/**
 * 流程引擎「派活规则」的验收：**只认点名，不按技能找人**（用户 2026-10-14 定）。
 *
 * 规则本身：
 *   · 节点上点了名 → 派给那个人（哪怕他一个技能都没挂）；
 *   · 节点没点名 → 那是**故意留空**：到站即「已阻塞」，等人指派；
 *     **引擎不许按技能挑一个人顶上**，原因里也不提技能（不是每个节点都有对应技能）；
 *   · 技能是"这个人会干什么"，绑在数字员工身上；流程不拿它当路由键。
 *
 * 另外两条钉在这儿（2026-10-16 补）：
 *   · **内建模板改名**：旧 id `bandi-flow` 跟技能名撞了 → `bandi-delivery`，
 *     老库里的模板与**实例的 templateId** 一起迁（见 ⑧）；
 *   · **部署永远要人下令**：内建模板的部署节点必须带 `manual`，且这个开关真的管住
 *     自动流转（见 ⑨⑩）—— 契约上写着不自动流转，代码里就不能自动流转。
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

// 两个人：一个挂着测试的技能，一个什么技能都没挂
const qa = store.createPersona({ name: '星宇', runtime: 'codex', cwd: tmp, instructions: '' });
const noSkills = store.createPersona({ name: '谁也没挂', runtime: 'codex', cwd: tmp, instructions: '' });
store.setPersonaSkills(qa.id, ['webapp-testing']);

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
check('原因里不含技能名（哪怕有人挂着 webapp-testing）', !/webapp-testing|技能/.test(first?.note ?? ''), first?.note);
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

/*
 * ⑧ 内建模板**改名**：老库里的 id 是 `bandi-flow`，跟技能名撞了。
 * 迁移必须把**实例的 templateId 一起改** —— 不改的话老实例指向一个不存在的模板，
 * 界面上那一步会显示成"当前节点悬空"。
 */
console.log('\n⑧ 老库的 bandi-flow 模板 + 实例 → 自动迁到 bandi-delivery');
store.upsertWorkflowTemplate({
  id: 'bandi-flow',
  name: '班底交付流程',
  builtIn: 1, // 真库里的内建模板带着这个标记 —— detail 同步只对它生效
  start: 'n1',
  nodes: [{ id: 'n1', name: '谈需求', x: 220, y: 60, manual: true, approve: 'end', reject: 'end' }],
});
const oldRun = store.createWorkflowRun({ templateId: 'bandi-flow', title: '老库里的实例' });
store.setWorkflowCurrentNode(oldRun.id, 'n1');
workflows.ensureBuiltInTemplate();
check('内建模板 id 是 bandi-delivery', workflows.BUILT_IN_TEMPLATE.id === 'bandi-delivery', workflows.BUILT_IN_TEMPLATE.id);
check('旧 id 的模板没了', !store.getWorkflowTemplate('bandi-flow'));
check('新 id 的模板在', !!store.getWorkflowTemplate('bandi-delivery'));
check('实例的 templateId 跟着改了', store.getWorkflowRun(oldRun.id)?.templateId === 'bandi-delivery', String(store.getWorkflowRun(oldRun.id)?.templateId));
const migrated = workflows.getWorkflowView(oldRun.id);
check('老实例照新 id 仍读得出节点（没悬空）', migrated.nodes.some((n) => n.id === migrated.currentNodeId), `${migrated.currentNodeId} vs ${migrated.nodes.map((n) => n.id).join(',')}`);
check('迁移不改「多久没动」', !!store.getWorkflowRun(oldRun.id)?.updatedAt, String(store.getWorkflowRun(oldRun.id)?.updatedAt));

/*
 * ⑨ 内建模板本身：**部署永远要人下令**（契约「四」的硬规矩）必须有开关兜着。
 * 没有它，onAgentRunFinished 会在跑完后自动 decide('通过') —— 契约写着不自动流转，
 * 代码里却在自动流转。
 */
console.log('\n⑨ 内建模板：部署节点带 manual');
const deployNode = workflows.BUILT_IN_TEMPLATE.nodes.find((n) => n.name === '部署');
check('建模板里有「部署」这一步', !!deployNode, String(deployNode?.id));
check('部署节点 manual = true', deployNode?.manual === true, String(deployNode?.manual));
const seeded = store.upsertWorkflowTemplate(workflows.BUILT_IN_TEMPLATE);
const seededNodes = workflows.nodesOf(seeded);
check('入库之后仍然带 manual', seededNodes.find((n) => n.name === '部署')?.manual === true);
const seededRun = workflows.startWorkflow({ templateId: 'bandi-delivery', title: '内建模板用例', autoStart: false });
const seededView = workflows.getWorkflowView(seededRun.id);
check('实例视图把 manual 带出来（界面据此标「需人工确认」）', seededView.nodes.find((n) => n.name === '部署')?.manual === true);

// 老库里的种子数据（五个节点、没坐标、没 manual）——启动时该补上，但**用户明确关掉的要留住**
const seed5 = (n5) => store.upsertWorkflowTemplate({
  id: 'bandi-delivery', name: '班底交付流程', builtIn: true, start: 'n1',
  nodes: [
    { id: 'n1', name: '谈需求', approve: 'n2', reject: 'end' },
    { id: 'n2', name: '定计划', approve: 'n3', reject: 'n1' },
    { id: 'n3', name: '写代码', approve: 'n4', reject: 'n2' },
    { id: 'n4', name: '测试', approve: 'n5', reject: 'n3' },
    { id: 'n5', name: '部署', approve: 'end', reject: 'n4', ...n5 },
  ],
});
seed5({});
workflows.ensureBuiltInTemplate();
const upgraded = workflows.nodesOf(store.getWorkflowTemplate('bandi-delivery'));
check('老种子：部署节点补上了 manual', upgraded.find((n) => n.id === 'n5')?.manual === true);
check('老种子：坐标也一并补上', upgraded.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)));
seed5({ x: 1, y: 1, manual: false });
workflows.ensureBuiltInTemplate();
check('用户明确关掉（manual: false）→ 不被覆盖', workflows.nodesOf(store.getWorkflowTemplate('bandi-delivery')).find((n) => n.id === 'n5')?.manual === false);

/*
 * ⑩ manual 开关真的管住自动流转 —— ⑨ 只证明开关在，这里证明它起作用。
 * 两个节点只差 manual，喂同一条"干完了"的假运行，看流程走不走。
 */
console.log('\n⑩ manual 开关真的管住自动流转');
const worker = store.createPersona({ name: '干活的', runtime: 'codex', cwd: tmp, instructions: '' });
const oneNode = (id, manual) => store.upsertWorkflowTemplate({
  id, name: id, start: 'n1',
  nodes: [{ id: 'n1', name: '部署', personaId: worker.id, manual, approve: 'end', reject: 'end' }],
});
const finishWith = (templateId, agentRunId) => {
  const r = workflows.startWorkflow({ templateId, title: templateId, autoStart: false });
  const t = store.listWorkflowTasks(r.id)[0];
  store.updateWorkflowTask(t.id, { status: '进行中', agentRunId });
  workflows.onAgentRunFinished({ id: agentRunId, status: '已完成', finalText: '干完了' });
  return { run: store.getWorkflowRun(r.id), task: store.getWorkflowTask(t.runId, 'n1', 1) };
};
oneNode('t-pause', true);
const paused = finishWith('t-pause', 'ar-pause');
check('manual：停在「待确认」，流程还卡在这一步', paused.task?.status === '待确认' && paused.run?.status === '进行中', `${paused.task?.status} / ${paused.run?.status}`);
oneNode('t-auto', false);
const auto = finishWith('t-auto', 'ar-auto');
check('非 manual：自动往下走，approve=end → 流程收尾', auto.run?.status === '已完成', `${auto.task?.status} / ${auto.run?.status}`);

/*
 * ⑪ 内建模板的 detail 随平台更新（产物模板 / 收敛检查写进节点提示词）＋ 项目宪法的注入块。
 */
console.log('\n⑪ 模板 detail 同步与项目宪法注入');
workflows.ensureBuiltInTemplate();
const details = new Map(workflows.nodesOf(store.getWorkflowTemplate('bandi-delivery')).map((n) => [n.id, n.detail]));
check('谈需求指向 spec 模板', (details.get('n1') ?? '').includes('docs/模板/spec.md'), details.get('n1'));
check('定计划指向 plan/task 模板且不写卡文件', (details.get('n2') ?? '').includes('docs/模板/plan.md') && (details.get('n2') ?? '').includes('docs/模板/task.md'));
check('测试带收敛检查', (details.get('n4') ?? '').includes('收敛'), details.get('n4'));
const dispatch = await import('./dispatch.mjs');
const pj = store.createProject({ name: '宪法项目', root: tmp });
check('没写宪法 → 什么都不注', dispatch.projectConstitutionBlock(pj.id) === '', JSON.stringify(dispatch.projectConstitutionBlock(pj.id)));
store.updateProject(pj.id, { constitution: '零依赖，不许引入 npm 包' });
const blk = dispatch.projectConstitutionBlock(pj.id);
check('写了宪法 → 全文注入', blk.includes('零依赖，不许引入 npm 包'), blk);
check('注入块带优先级规则（契约赢）', blk.includes('以契约为准'), blk.split('\n')[1]);
store.updateProject(pj.id, { constitution: '   ' });
check('清空宪法 → 回到不注入', dispatch.projectConstitutionBlock(pj.id) === '');
check('updateProject 把空串归一成 NULL', store.getProject(pj.id).constitution === null, String(store.getProject(pj.id).constitution));

/*
 * ⑫ 执行结果（2026-10-18 用户要求：简洁明了）—— 界面只按三种样子渲染：
 *   ① 有产物 → 只列产物（文件 / 链接）；
 *   ② 没产物 → 一句话"做了什么"；
 *   ③ 失败   → 报错原文。
 * 所以在 run 结束那一刻、拿**全文**拆好存进 `workflow_tasks.result`。
 */
console.log('\n⑫ 执行结果：有产物列产物 / 没产物一句话 / 失败给原文');
const doneRes = workflows.resultOf({
  status: '已完成',
  finalText: '已在 `index.html` 的卡片里加上这句话。\n\n改动：`index.html:6`，见 https://github.com/acme/web/pull/12',
});
check('完成 → state = done', doneRes.state === 'done', doneRes.state);
check('产物认出文件（行号不被当成路径）', doneRes.artifacts.some((a) => a.kind === 'file' && a.target === 'index.html'), JSON.stringify(doneRes.artifacts));
check('产物认出链接', doneRes.artifacts.some((a) => a.kind === 'link' && /pull\/12$/.test(a.target)), JSON.stringify(doneRes.artifacts));
check('一句话取第一行有内容的', /已在 index\.html 的卡片里加上这句话/.test(doneRes.summary ?? ''), doneRes.summary);

const plainRes = workflows.resultOf({ status: '已完成', finalText: '好的，我先看了一下项目。\n\n这次只做了检查，没改任何文件。' });
check('没产物 → artifacts 为空', plainRes.artifacts.length === 0, JSON.stringify(plainRes.artifacts));
check('没产物 → 一句话跳过开场白', /只做了检查/.test(plainRes.summary ?? ''), plainRes.summary);

const badRes = workflows.resultOf({ status: '失败', error: '退出码 1：ENOENT 找不到 dist/index.html' });
check('失败 → state = error 且带原文', badRes.state === 'error' && /ENOENT/.test(badRes.error ?? ''), JSON.stringify(badRes));
check('失败 → 不硬凑一句话', badRes.summary === null, String(badRes.summary));

// 落到库里 + 视图带出来：跑完这一步，界面拿到的就是拆好的结构
oneNode('t-result', true);
const resRun = workflows.startWorkflow({ templateId: 't-result', title: '结果', autoStart: false });
const resTask = store.listWorkflowTasks(resRun.id)[0];
store.updateWorkflowTask(resTask.id, { status: '进行中', agentRunId: 'ar-result' });
workflows.onAgentRunFinished({
  id: 'ar-result',
  status: '已完成',
  finalText: '改完了。\n\n- `src/app.js` 新增一个按钮\n- `README.md` 补了用法',
});
const resView = workflows.getWorkflowView(resRun.id);
const resOut = (resView.tasks ?? [])[0]?.result ?? {};
check('落库：result 是 JSON 串', !!store.getWorkflowTask(resRun.id, 'n1', 1)?.result, String(store.getWorkflowTask(resRun.id, 'n1', 1)?.result).slice(0, 40));
check('视图：两个文件产物都带出来', (resOut.artifacts ?? []).filter((a) => a.kind === 'file').length === 2, JSON.stringify(resOut.artifacts));
check('视图：一句话取第一行有内容的（不拼列表）', resOut.summary === 'src/app.js 新增一个按钮', resOut.summary);

// 老数据没有 result 列 → 拿 note 兜底（至少还能显示一句话 / 产物）
store.updateWorkflowTask(resTask.id, { result: null, note: '已把 `docs/需求.md` 写完' });
const legacyRes = (workflows.getWorkflowView(resRun.id).tasks ?? [])[0]?.result ?? {};
check('老数据：用 note 兜底出产物', (legacyRes.artifacts ?? []).some((a) => a.target === 'docs/需求.md'), JSON.stringify(legacyRes));

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录，删不掉就算了 */ }
console.log(`\n结论：${failed ? '有 ' + failed + ' 项没通过' : '全通过'}`);
process.exit(failed ? 1 : 0);
