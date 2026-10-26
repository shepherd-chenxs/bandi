/**
 * 验收：**任务卡由流程执行**（用户 2026-10-26 定）。
 *
 * 验的是这次改动定的形状：
 *   · 建卡时执行方式可以选「人」也可以选「流程」—— 卡绑一条流程实例；
 *   · 看板**以卡为一行**：这张卡的状态 / 经办人跟着流程**当前步骤**走，
 *     该实例的每一步办理（`workflow_tasks`）**不再单独占一行**（否则同一件事两行重影）；
 *   · 「想法」列建卡先只记模板，之后拖进「进行中」（或调 `startProjectTask`）才发起；
 *   · 已绑实例的卡，状态归流程引擎 —— 手工改状态 / 换执行人一律拒绝；
 *   · 接口层同一套口径：`POST` 带 `flowTemplateId`、未发布模板 400、
 *     未发起的卡 `PATCH` 成「进行中」返回 `started:true`。
 *
 * 不真叫起 agent：测试模板的**第一步节点故意不点名**（`startWorkflow` 会把它标「已阻塞」
 * 并吞掉派活错误），后面几步的办理记录用 `store.createWorkflowTask` 手造。
 *
 * 隔离：临时数据库 + 临时数据目录 + 临时端口 —— 不碰 data/ 里的真账。
 * 跑法：node apps/server/src/smoke-task-flow.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.SMOKE_PORT ?? 8795);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-taskflow-'));
// 数据目录也要指过去：光隔离数据库，runtimes.json / plugins.json / connectors/ 仍会写进真实 data/
process.env.BANDI_DATA = tmp;
process.env.BANDI_DB = path.join(tmp, 'bandi.db');

// ⚠️ 必须在设好 BANDI_DATA / BANDI_DB 之后再 import —— config 在模块加载时读环境变量
const { repoRoot, dbPath } = await import('./config.mjs');
const store = await import('./store.mjs');
const workflows = await import('./workflows.mjs');
const { projectTasks, personaTasks, createProjectTask, updateProjectTask, startProjectTask } = await import('./project-tasks.mjs');

if (!path.resolve(dbPath).toLowerCase().startsWith(path.resolve(tmp).toLowerCase())) {
  console.log(`✗ 临时库没生效：dbPath=${dbPath} 不在 ${tmp} 下 —— 拒绝继续（避免写进真库）`);
  process.exit(1);
}
console.log(`（隔离自检：dbPath=${dbPath}）`);

let failed = 0;
let total = 0;
const check = (label, ok, detail = '') => {
  total += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

/* ---------------------------------------------------------------- 造数据 */
const projRoot = path.join(tmp, 'proj-a');
fs.mkdirSync(projRoot, { recursive: true });

const proj = store.createProject({ name: '流程卡项目', root: projRoot });
const worker = store.createPersona({ name: '接流程的人', runtime: 'codex', cwd: projRoot, instructions: '' });
const other = store.createPersona({ name: '另一个人', runtime: 'codex', cwd: projRoot, instructions: '' });
const projectRow = () => store.getProject(proj.id);

/*
 * 主模板：三步，**第一步故意不点名**（到站即「已阻塞」，不会真叫起 agent）。
 * 后两步点了名只是为了节点形状真实；测试里不会自动流转到它们。
 */
const TPL = 't-card-flow';
store.upsertWorkflowTemplate({
  id: TPL,
  name: '卡执行流程',
  start: 'n1',
  nodes: [
    { id: 'n1', name: '需求', approve: 'n2', reject: 'end' },
    { id: 'n2', name: '实现', personaId: worker.id, approve: 'n3', reject: 'end' },
    { id: 'n3', name: '验收', personaId: worker.id, approve: 'end', reject: 'n1' },
  ],
});
workflows.publishTemplate(TPL, true);
check('模板已经发布（发布了的才能被卡选中）', !!store.getWorkflowTemplate(TPL)?.publishedAt, String(store.getWorkflowTemplate(TPL)?.publishedAt));

/*
 * 单步模板：第 ④ 段验「状态跟着当前步骤走」时用 —— 实例里只有一步，
 * 「当前步骤」没有歧义（多步的当前节点由引擎内部指针决定，用例不去猜指针）。
 */
const ONE = 't-card-one';
store.upsertWorkflowTemplate({
  id: ONE,
  name: '单步流程',
  start: 'n1',
  nodes: [{ id: 'n1', name: '一步办完', approve: 'end', reject: 'end' }],
});
workflows.publishTemplate(ONE, true);

// 有节点、但**没发布**的模板：给 ② 的校验用
store.upsertWorkflowTemplate({
  id: 't-card-draft',
  name: '还没发布的流程',
  start: 'n1',
  nodes: [{ id: 'n1', name: '草稿步骤', approve: 'end', reject: 'end' }],
});

const board = () => projectTasks(projectRow());
const rowsOfRun = (runId) => board().rows.filter((r) => r.flow_id === runId);

/* ---------------------------------------------- ① 建卡选流程（立即发起） */
console.log('\n① 建卡选流程：卡绑定实例，看板只留卡这一行');
const cardA = createProjectTask(projectRow(), {
  title: '把导出功能做出来',
  flowTemplateId: TPL,
  startNow: true,
});
check('卡拿到了 flowRunId（实例真的发起来了）', !!cardA?.flowRunId, String(cardA?.flowRunId));
check('卡记下了选的模板', cardA?.flowTemplateId === TPL, String(cardA?.flowTemplateId));

const runA = store.getWorkflowRun(cardA?.flowRunId ?? '');
check('实例指向选中的模板', runA?.templateId === TPL, String(runA?.templateId));
check('实例挂在卡所在的项目下', runA?.projectId === proj.id, String(runA?.projectId));
const stepsA = store.listWorkflowTasks(runA?.id ?? '');
check('实例建出了第 1 步', stepsA.length === 1, `${stepsA.length} 步`);
check('第 1 步没点名 → 已阻塞（没有真叫起 agent）', stepsA[0]?.status === '已阻塞', String(stepsA[0]?.status));

const board1 = board();
const rowA = board1.rows.filter((r) => r.flow_id === runA.id);
check('看板里这张卡只有一行（该实例的分步行不再单独出现）', rowA.length === 1, `同一实例的行数：${rowA.length}`);
check('这一行来源标「流程」', rowA[0]?.source === 'flow' && rowA[0]?.source_text === '流程', `${rowA[0]?.source} / ${rowA[0]?.source_text}`);
check('行标题就是卡标题（不是「实例名 · 节点名」那种写法）', rowA[0]?.task === '把导出功能做出来', String(rowA[0]?.task));
check('状态 = 流程当前步骤的「已阻塞」', rowA[0]?.status === '已阻塞', String(rowA[0]?.status));
check('备注带「第 1/N 步」', /第 1\/3 步/.test(String(rowA[0]?.note)), String(rowA[0]?.note));
check('备注带当前节点名', String(rowA[0]?.note).includes('需求'), String(rowA[0]?.note));
check(
  '行上带 flow_id / template_id / flow_status（点得进实例）',
  rowA[0]?.flow_id === runA.id && rowA[0]?.template_id === TPL && rowA[0]?.flow_status === '进行中',
  JSON.stringify({ f: rowA[0]?.flow_id, t: rowA[0]?.template_id, s: rowA[0]?.flow_status }),
);
check('看板上没有这张卡的「手动」重影行', board1.rows.filter((r) => r.task === '把导出功能做出来').length === 1, String(board1.rows.filter((r) => r.task === '把导出功能做出来').length));
check('概览的 flow_count 按实例数算 = 1', board1.flow_count === 1, String(board1.flow_count));

/* ------------------------------------------------------------ ② 建卡校验 */
console.log('\n② 校验：未发布 / 不存在 / 跟「派人」互斥');
const mkCard = (opts) => createProjectTask(projectRow(), { title: '不该建出来的卡', ...opts });
let err = '';
try { mkCard({ flowTemplateId: 't-card-draft', startNow: true }); } catch (e) { err = e.message; }
check('未发布的模板 → 抛错，并说清要「发布」', /发布/.test(err), err);
err = '';
try { mkCard({ flowTemplateId: 't-根本没有', startNow: true }); } catch (e) { err = e.message; }
check('不存在的模板 → 抛错', /不在了|不存在/.test(err), err);
err = '';
try { mkCard({ flowTemplateId: TPL, personaId: worker.id, startNow: true }); } catch (e) { err = e.message; }
check('同时给「执行人」与「流程」→ 抛错（互斥）', /只能选一个|互斥|二选一/.test(err), err);
check('校验失败的卡一张都没落库', !store.listProjectTasks(proj.id).some((t) => t.title === '不该建出来的卡'), String(store.listProjectTasks(proj.id).length));

/* ------------------------------------ ③ 未立即发起：先挂着，之后才绑定实例 */
console.log('\n③ 「想法」里建卡：只记模板；发起后才绑定实例');
const cardB = createProjectTask(projectRow(), {
  title: '先挂着的流程卡',
  flowTemplateId: ONE,
  status: '想法',
  startNow: false,
});
check('卡只记了模板，还没有实例', cardB?.flowTemplateId === ONE && !cardB?.flowRunId, `${cardB?.flowTemplateId} / ${cardB?.flowRunId}`);
check('状态还是「想法」', cardB?.status === '想法', String(cardB?.status));

const waitingRow = board().rows.find((r) => r.manual_id === cardB.id);
check('看板上先按手工卡一行（source = manual）', waitingRow?.source === 'manual', String(waitingRow?.source));
check('备注提示「将按流程「单步流程」执行」', /将按流程/.test(String(waitingRow?.note)) && String(waitingRow?.note).includes('单步流程'), String(waitingRow?.note));
check('这一行落在最左那列「想法」', waitingRow?.col === 'idea', String(waitingRow?.col));

// 实际实现：「想法」卡**没被拖出「想法」**之前，直接 startProjectTask 仍被那条守卫拦着（有意的）。
// 真正发起 = 把它拖进「进行中」（updateProjectTask status=进行中，界面上就是拖拽）。
let ideaErr = '';
try { startProjectTask(cardB.id); } catch (e) { ideaErr = e.message; }
check('「想法」里直接 startProjectTask 仍被拦（要先拖出「想法」）', /想法/.test(ideaErr), ideaErr);

const startedB = updateProjectTask(cardB.id, { status: '进行中' });
check('拖进「进行中」= 发起 → 卡绑上实例', !!startedB?.flowRunId, String(startedB?.flowRunId));
check('卡状态跟着流程当前步骤（已阻塞）', startedB?.status === '已阻塞', String(startedB?.status));
const runB = store.getWorkflowRun(startedB?.flowRunId ?? '');
check('实例记下了所属项目', runB?.projectId === proj.id, String(runB?.projectId));

const rowB = rowsOfRun(runB?.id ?? '')[0];
check('看板行改由流程派生（source = flow）', rowB?.source === 'flow', String(rowB?.source));
check('看板行状态 = 已阻塞', rowB?.status === '已阻塞', String(rowB?.status));
check(
  '看板上只剩这一行（原来的「手动」行被流程行替换，不是两行并存）',
  board().rows.filter((r) => r.flow_id === runB.id || r.manual_id === cardB.id).length === 1,
  `共 ${board().rows.filter((r) => r.flow_id === runB.id || r.manual_id === cardB.id).length} 行`,
);

/* ------------------------------------- ④ 状态派生：看板行跟着实例当前步骤走 */
console.log('\n④ 状态派生：改实例当前步骤，看板行跟着变');
const stepB = store.listWorkflowTasks(runB.id)[0];
const statusOfB = () => rowsOfRun(runB.id)[0]?.status;
store.updateWorkflowTask(stepB.id, { status: '待验收' });
check('步骤改成「待验收」→ 卡行也是「待验收」', statusOfB() === '待验收', String(statusOfB()));
store.updateWorkflowTask(stepB.id, { status: '失败' });
check('步骤改成「失败」→ 卡行也是「失败」', statusOfB() === '失败', String(statusOfB()));
store.updateWorkflowTask(stepB.id, { status: '已完成' });
check('步骤改成「已完成」→ 卡行也是「已完成」', statusOfB() === '已完成', String(statusOfB()));

store.updateWorkflowTask(stepB.id, { assigneePersonaId: worker.id });
const rowW = rowsOfRun(runB.id)[0];
check('指派经办人 → 看板行 assignee_id 跟着变', rowW?.assignee_id === worker.id, String(rowW?.assignee_id));
check('指派经办人 → 看板行 assignee_name 跟着变', (rowW?.assignee_name ?? rowW?.assignee) === worker.name, String(rowW?.assignee_name ?? rowW?.assignee));

store.setWorkflowRunStatus(runB.id, '已完成');
check('实例「已完成」→ 卡行「已完成」', statusOfB() === '已完成', String(statusOfB()));
store.setWorkflowRunStatus(runB.id, '已终止');
check('实例「已终止」→ 卡行「已取消」', statusOfB() === '已取消', String(statusOfB()));

/* ------------------------------------- ⑤ 去重：同一实例三步办理 → 看板 1 行 */
console.log('\n⑤ 去重：同一实例三步办理，看板仍只有 1 行');
store.createWorkflowTask({ runId: runA.id, nodeId: 'n2', nodeName: '实现', visit: 1, detail: '', status: '待办' });
store.createWorkflowTask({ runId: runA.id, nodeId: 'n3', nodeName: '验收', visit: 1, detail: '', status: '待办' });
check('实例里现在有 3 步办理记录', store.listWorkflowTasks(runA.id).length === 3, String(store.listWorkflowTasks(runA.id).length));
const boardD = board();
check('看板里同一实例仍然只有 1 行', boardD.rows.filter((r) => r.flow_id === runA.id).length === 1, String(boardD.rows.filter((r) => r.flow_id === runA.id).length));
check('flow_count 仍按实例数算 = 2', boardD.flow_count === 2, String(boardD.flow_count));

/* ------------------------------------------- ⑥ 员工详情收这张流程卡 */
console.log('\n⑥ 员工详情：流程卡落在当前步骤的经办人名下');
const mine = personaTasks(store.getPersona(worker.id));
const mineRow = mine.rows.find((r) => r.flow_id === runB.id);
check('员工详情收这张卡（source = flow）', mineRow?.source === 'flow', String(mineRow?.source));
check('标题就是卡标题', mineRow?.task === '先挂着的流程卡', String(mineRow?.task));
check('概览里这个人的流程实例数按他真办的实例算 = 1', mine.flow_count === 1, String(mine.flow_count));

/* --------------------------- ⑦ 已绑实例的卡：手工改状态 / 换人 / 二次发起都被拒 */
console.log('\n⑦ 已绑实例的卡：状态归流程，手工改一律拒绝');
let e1 = '';
try { updateProjectTask(cardB.id, { status: '已完成' }); } catch (e) { e1 = e.message; }
check('手工改状态被拒，并说清状态归流程', /流程/.test(e1), e1);
let e2 = '';
try { updateProjectTask(cardB.id, { personaId: other.id }); } catch (e) { e2 = e.message; }
check('换执行人被拒，并说清状态归流程', /流程/.test(e2), e2);
let e3 = '';
try { startProjectTask(cardB.id); } catch (e) { e3 = e.message; }
check('二次「开始」报「由流程执行」', /由流程执行/.test(e3), e3);

/* ------------------------------------------------------------ ⑧ 接口层 */
console.log('\n⑧ 接口（真起一次服务端）');
const api = async (p, opts) => {
  const res = await fetch(BASE + p, opts);
  return { status: res.status, body: await res.json().catch(() => null) };
};
const postTask = (body) =>
  api(`/api/projects/${encodeURIComponent(proj.id)}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const patchTask = (id, body) =>
  api(`/api/projects/tasks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const logPath = path.join(tmp, 'server.log');
const logFd = fs.openSync(logPath, 'a');
const child = spawn(process.execPath, [path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs')], {
  cwd: repoRoot,
  env: { ...process.env, BANDI_PORT: String(PORT), BANDI_DB: process.env.BANDI_DB },
  windowsHide: true,
  stdio: ['ignore', logFd, logFd],
});
fs.closeSync(logFd);

try {
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + '/api/projects')).ok) { up = true; break; } } catch { /* 还没起 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  check('服务端起来了', up);

  const made = await postTask({ title: '接口建的流程卡', flowTemplateId: TPL, startNow: true });
  check('POST 带 flowTemplateId 建卡 201', made.status === 201, `${made.status} ${JSON.stringify(made.body?.error ?? '')}`);
  check('响应里的卡带 flowRunId', !!made.body?.task?.flowRunId, String(made.body?.task?.flowRunId));
  check('响应里的卡记了 flowTemplateId', made.body?.task?.flowTemplateId === TPL, String(made.body?.task?.flowTemplateId));
  const madeRun = store.getWorkflowRun(made.body?.task?.flowRunId ?? '');
  check('实例真的建出来了（模板对得上）', !!madeRun && madeRun.templateId === TPL, String(madeRun?.templateId));

  const draftApi = await postTask({ title: '接口：未发布模板', flowTemplateId: 't-card-draft', startNow: true });
  check('未发布模板建卡 → 400', draftApi.status === 400, `${draftApi.status} ${JSON.stringify(draftApi.body?.error ?? '')}`);

  const wait = await postTask({ title: '接口：先挂着的流程卡', flowTemplateId: ONE, status: '想法' });
  check('先挂着的流程卡 201 且还没实例', wait.status === 201 && !wait.body?.task?.flowRunId, `${wait.status} / ${wait.body?.task?.flowRunId}`);

  const go = await patchTask(wait.body?.task?.id ?? '', { status: '进行中' });
  check('PATCH 状态 → 进行中：200 且 started:true', go.status === 200 && go.body?.started === true, `${go.status} / ${JSON.stringify(go.body?.started ?? go.body?.error ?? '')}`);
  check('发起后卡上绑了 flowRunId', !!go.body?.task?.flowRunId, String(go.body?.task?.flowRunId));

  const bound = await patchTask(go.body?.task?.id ?? '', { status: '已完成' });
  check('已绑实例的卡走接口改状态 → 400', bound.status === 400, `${bound.status} ${JSON.stringify(bound.body?.error ?? '')}`);
} catch (err) {
  check('接口这一段没跑挂', false, String(err?.message ?? err));
} finally {
  try { child.kill(); } catch { /* 已经退了 */ }
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录，删不掉就算了 */ }
console.log(`\n结论：${failed ? '有 ' + failed + ' 项没通过' : '全通过'}（共 ${total} 项检查）`);
process.exit(failed ? 1 : 0);
