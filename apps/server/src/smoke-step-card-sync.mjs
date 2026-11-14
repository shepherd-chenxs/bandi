/**
 * 步骤档案卡 ↔ 流程节点 状态一致（2026-11-13，实报"卡改成进行中、实例页还是 failed"）。
 *
 * 背景：流程某一步的档案卡（流程页点「任务」建的那张，`sourceKey = flow:<runId>:<nodeId>:<visit>`）
 * 以前只在**建卡那一刻拍张照** —— 之后节点跑了/挂了/被人重跑，卡不知道；而卡的属性面板又
 * 允许人手改状态，改完跟流程实例页各说各话（卡「进行中」、节点「failed」）。
 *
 * 钉住三件事：
 *   ① 节点状态一变，已建的卡跟着变（doing / failed / done）；
 *   ② 卡还没建（人没点过「任务」）就什么都不发生 —— 不崩，也不许顺手替人建卡；
 *   ③ 人手改档案卡的状态/执行人被拒 —— 卡是档案，状态归引擎；标题/描述照常能改。
 *
 * 隔离：临时数据目录 + 临时库。
 * 跑法：node apps/server/src/smoke-step-card-sync.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-step-card-'));
process.env.BANDI_DATA = tmp;
process.env.BANDI_DB = path.join(tmp, 'bandi.db');

// ⚠️ 必须在设好 BANDI_DATA / BANDI_DB 之后再 import —— config 在模块加载时读环境变量
const store = await import('./store.mjs');
const workflows = await import('./workflows.mjs');
const pt = await import('./project-tasks.mjs'); // 节点→卡的同步监听在这一步注册，必须先 import 再改状态

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

const proj = store.createProject({ name: '步骤卡验收', root: tmp });

store.upsertWorkflowTemplate({
  id: 't-step-card',
  name: '步骤卡验证',
  start: 'n1',
  nodes: [{ id: 'n1', name: '干活', approve: 'end', reject: 'end' }], // 没点名 → 到站即阻塞，不会真派活
});
const run = workflows.startWorkflow({ templateId: 't-step-card', title: '步骤卡用例', projectId: proj.id });
const task = run.tasks?.[0] ?? store.listWorkflowTasks(run.id)[0];

console.log('① 建卡后：节点状态一变，卡跟着变');
const card = pt.ensureTaskCardForStep(store.getWorkflowRun(run.id), task);
check('卡建出来了，sourceKey 是这一步的身份', card?.sourceKey === `flow:${run.id}:n1:1`, String(card?.sourceKey));
check('建卡时的状态 = 节点当下状态（已阻塞）', card?.status === 'blocked', String(card?.status));

const cardStatus = () => store.getProjectTaskBySourceKey(`flow:${run.id}:n1:1`)?.status;
store.updateWorkflowTask(task.id, { status: 'doing' });
check('节点 → 进行中，卡跟着「进行中」', cardStatus() === 'doing', String(cardStatus()));
store.updateWorkflowTask(task.id, { status: 'failed', note: '还没连接 GitHub —— 建 PR 要用令牌' });
check('节点 → 失败，卡跟着「失败」（实报的那一幕）', cardStatus() === 'failed', String(cardStatus()));
store.updateWorkflowTask(task.id, { status: 'done' });
check('节点 → 已完成，卡跟着「已完成」', cardStatus() === 'done', String(cardStatus()));

console.log('\n② 人手改档案卡：被拒（状态归引擎，两本账不许打架）');
let e1 = '';
try { pt.updateProjectTask(card.id, { status: 'doing' }); } catch (e) { e1 = e.message; }
check('手改状态被拒，并指向流程实例', /流程/.test(e1), e1);
let e2 = '';
const someone = store.createPersona({ name: '随便谁', runtime: 'codex', cwd: tmp, instructions: '' });
try { pt.updateProjectTask(card.id, { personaId: someone.id }); } catch (e) { e2 = e.message; }
check('换执行人也被拒', /流程/.test(e2), e2);
check('被拒之后卡状态没被写坏', cardStatus() === 'done', String(cardStatus()));
const descChanged = pt.updateProjectTask(card.id, { description: '档案说明照常能改' });
check('描述不在拦截范围（档案说明归人）', !!descChanged, '');

console.log('\n③ 卡还没建：节点随便变，不崩、也不替人建卡');
store.upsertWorkflowTemplate({
  id: 't-step-card-2',
  name: '步骤卡验证·无卡',
  start: 'n1',
  nodes: [{ id: 'n1', name: '干活', approve: 'end', reject: 'end' }],
});
const run2 = workflows.startWorkflow({ templateId: 't-step-card-2', title: '无卡用例', projectId: proj.id });
const task2 = run2.tasks?.[0] ?? store.listWorkflowTasks(run2.id)[0];
let crashed = '';
try { store.updateWorkflowTask(task2.id, { status: 'failed' }); } catch (e) { crashed = e.message; }
check('没建卡也照常改节点状态', !crashed, crashed);
check('没有顺手替人建卡', store.listProjectTasks(proj.id).every((t) => t.sourceKey !== `flow:${run2.id}:n1:1`), '');

console.log(failed ? `\n✗ ${failed} 项没过` : '\n✓ 全过');
process.exit(failed ? 1 : 0);
