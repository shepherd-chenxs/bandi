/**
 * 「完全自主交付」的验收（2026-11-13 用户定：人不逐步拍板）。
 *
 * 钉住七件事：
 *   ① 内建模板播种后已发布、autonomous=1、七个节点全不带 manual、按岗位点名；
 *   ② 按岗位指派（roleKey → 该岗位员工），没这个岗位的人 → 到站即「已阻塞」且不重复写信箱；
 *   ③ 非 manual 节点跑完自动流转，走到 end 时流程收尾并写信箱「自主交付完成」，
 *      完成报告带最后一个节点的交付汇报正文与 PR 链接；
 *   ④ 任务 [受阻] / 失败 / 人工终止 → 各写一条汇报（severity/code 区分）；
 *   ⑤ 平台自己卡住也汇报：未知动作、动作抛错 / 自报失败、派活失败、额度闸都不静默且只报一条；
 *   ⑥ 普通人工流程（autonomous=0）的行为不变：manual 仍停在「待验收」、不写任何汇报；
 *   ⑦ PM 经运行钥匙走批量建卡口带 flowTemplateId → 卡真起了一条自主流程实例。
 *
 * 隔离：临时数据目录 + 临时库 + 同进程临时端口；不联网、不烧模型（不起真 CLI）。
 * 跑法：node apps/server/src/smoke-self-delivery.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-self-delivery-'));
const PORT = Number(process.env.SMOKE_PORT ?? 8851);
process.env.BANDI_DATA = tmp;
process.env.BANDI_DB = path.join(tmp, 'bandi.db');
process.env.BANDI_HOST = '127.0.0.1';
process.env.BANDI_PORT = String(PORT);

// ⚠️ 必须在设好 BANDI_DATA / BANDI_DB 之后再 import —— config 在模块加载时读环境变量
const store = await import('./store.mjs');
const workflows = await import('./workflows.mjs');
const selfDelivery = await import('./self-delivery.mjs');
const quota = await import('./quota.mjs');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};
const noticesOf = (runId) => store.listNotices().filter((n) => n.kind === 'workflow.delivery.report' && (n.detail ?? '').includes(runId));
const nodesOfSelf = () => workflows.nodesOf(store.getWorkflowTemplate(selfDelivery.SELF_DELIVERY_TEMPLATE_ID));

console.log('① 内建模板：播种、发布、自主标记、无人工闸');
const seed = selfDelivery.ensureSelfDeliveryTemplate();
check('模板建出来了', !!seed, String(seed?.id));
check('已发布（工作台能起单）', !!seed?.publishedAt, String(seed?.publishedAt));
check('autonomous = 1', Number(seed?.autonomous) === 1, String(seed?.autonomous));
const seededNodes = nodesOfSelf();
check('七个节点', seededNodes.length === 7, String(seededNodes.length));
check('全部不设人工闸（manual 全为假）', seededNodes.every((n) => !n.manual), JSON.stringify(seededNodes.map((n) => [n.id, n.manual])));
check('全部按岗位点名（roleKey）', seededNodes.every((n) => n.action || !!n.roleKey), JSON.stringify(seededNodes.map((n) => [n.id, n.roleKey ?? n.action])));
check('含 pr-create 动作节点、不含 pr-merge / 部署', seededNodes.some((n) => n.action === 'pr-create') && !seededNodes.some((n) => /merge|部署/i.test(String(n.action ?? '') + n.name)), '');
const nodeIdx = (target) => seededNodes.findIndex((n) => n.id === target);
check('通过出口连成 n1 → … → n7 → end 的一条链', seededNodes.every((n, i) => n.approve === (i === 6 ? 'end' : `n${i + 2}`)), JSON.stringify(seededNodes.map((n) => n.approve)));
check('驳回一律回到前面的节点或直接结束（不往前跳、不指向自己）', seededNodes.every((n, i) => n.reject === 'end' || (nodeIdx(n.reject) >= 0 && nodeIdx(n.reject) < i)), JSON.stringify(seededNodes.map((n) => [n.id, n.reject])));
const again = selfDelivery.ensureSelfDeliveryTemplate();
check('幂等：再播种一次不丢 autonomous / 发布态', Number(again?.autonomous) === 1 && !!again?.publishedAt, `${again?.autonomous}/${again?.publishedAt}`);
check('幂等：节点没有被重复写坏', workflows.nodesOf(again).length === 7, String(workflows.nodesOf(again).length));

// 按岗位指派需要库里真有这几个岗位的员工；不 hire 专家（那会带一堆内建会话），直接建最小人
const people = {};
for (const [key, name] of [['pm', '验收PM'], ['architect', '验收架构'], ['dev', '验收研发'], ['test', '验收测试']]) {
  people[key] = store.createPersona({ name, roleKey: key, runtime: 'codex', cwd: tmp, instructions: '' });
}

console.log('\n② 按岗位自动指派 / 没岗位 → 已阻塞');
const autoTpl = (id, nodes = [{ id: 'n1', name: '第一步', roleKey: 'dev', approve: 'end', reject: 'end' }]) => store.upsertWorkflowTemplate({
  id, name: id, start: 'n1', autonomous: true, nodes,
});
const plainTpl = (id, manual) => store.upsertWorkflowTemplate({
  id, name: id, start: 'n1',
  nodes: [{ id: 'n1', name: '人工步', personaId: people.dev.id, manual, approve: 'end', reject: 'end' }],
});
autoTpl('t-self-assign');
const a = workflows.startWorkflow({ templateId: 't-self-assign', title: '岗位指派用例', autoStart: false });
check('roleKey=dev 指派到研发岗那位', store.listWorkflowTasks(a.id)[0]?.assigneePersonaId === people.dev.id, String(store.listWorkflowTasks(a.id)[0]?.assigneePersonaId));
store.upsertWorkflowTemplate({
  id: 't-self-nobody', name: '没岗位', start: 'n1', autonomous: true,
  nodes: [{ id: 'n1', name: '第一步', roleKey: 'role-does-not-exist', approve: 'end', reject: 'end' }],
});
const nobody = workflows.startWorkflow({ templateId: 't-self-nobody', title: '没这个岗', autoStart: false });
check('没这个岗位 → 到站即已阻塞（不偷偷挑人顶上）', store.listWorkflowTasks(nobody.id)[0]?.status === 'blocked', String(store.listWorkflowTasks(nobody.id)[0]?.status));
const nobodyNotices = noticesOf(nobody.id);
check('没岗位也自动写信箱（不是静默卡住）', nobodyNotices.length === 1 && nobodyNotices[0]?.code === 'WF_BLOCKED', JSON.stringify(nobodyNotices.map((n) => n.code)));
try {
  workflows.startCurrentStep(nobody.id);
} catch { /* 已阻塞：不该再派，也不该再报一次 */ }
check('再点派活不重复刷屏', noticesOf(nobody.id).length === 1 && noticesOf(nobody.id)[0]?.count === 1, JSON.stringify(noticesOf(nobody.id).map((n) => n.count)));

console.log('\n③ 跑完自动流转 → end 收尾 + 信箱完成汇报');
const finishWith = (templateId, agentRunId, finalText = '干完了') => {
  const r = workflows.startWorkflow({ templateId, title: templateId, autoStart: false });
  const t = store.listWorkflowTasks(r.id)[0];
  store.updateWorkflowTask(t.id, { status: 'doing', agentRunId });
  workflows.onAgentRunFinished({ id: agentRunId, status: 'done', finalText });
  return { run: store.getWorkflowRun(r.id), task: store.getWorkflowTask(r.id, 'n1', 1) };
};
const doneText = '方案、改动、自测已收敛，PR 已建。\n详见 https://github.com/example/bandi/pull/77\n[完成]';
const done = finishWith('t-self-assign', 'ar-self-done', doneText);
check('非 manual 自动放行，流程到 done', done.run?.status === 'done', String(done.run?.status));
check('任务被标记通过', done.task?.decision === '通过', String(done.task?.decision));
const doneNotices = noticesOf(done.run.id);
check('信箱有且只有一条完成汇报', doneNotices.length === 1, String(doneNotices.length));
check('kind / code / severity 正确', doneNotices[0]?.kind === 'workflow.delivery.report' && doneNotices[0]?.code === 'WF_DONE' && doneNotices[0]?.severity === 'info', JSON.stringify(doneNotices[0] && [doneNotices[0].kind, doneNotices[0].code, doneNotices[0].severity]));
check('汇报里带实例 id 与「无人工拍板」口径', (doneNotices[0]?.detail ?? '').includes(done.run.id) && (doneNotices[0]?.detail ?? '').includes('无人工拍板'), doneNotices[0]?.detail?.slice(0, 120));
check('汇报写了项目/实例，不占「哪一轮执行」字段', !doneNotices[0]?.runId, String(doneNotices[0]?.runId));
check('完成报告带 PM 汇报正文（不只让人翻实例页）', (doneNotices[0]?.detail ?? '').includes('方案、改动、自测已收敛') && (doneNotices[0]?.detail ?? '').includes('交付汇报'), doneNotices[0]?.detail?.slice(0, 240));
check('完成报告带 PR 链接', (doneNotices[0]?.detail ?? '').includes('https://github.com/example/bandi/pull/77'), '');

console.log('\n④ [受阻] / 失败 / 人工终止 → 各写一条汇报');
autoTpl('t-self-blocked');
const blocked = finishWith('t-self-blocked', 'ar-self-blocked', '能干的都干了。\n[受阻] docs/ 目录没写权限');
check('受阻：流程还停在这一步（不自动往下走）', blocked.run?.status === 'doing' && blocked.task?.status === 'blocked', `${blocked.run?.status}/${blocked.task?.status}`);
const blockedNotices = noticesOf(blocked.run.id);
check('受阻汇报一条，code=WF_BLOCKED、severity=blocking', blockedNotices.length === 1 && blockedNotices[0]?.code === 'WF_BLOCKED' && blockedNotices[0]?.severity === 'blocking', JSON.stringify(blockedNotices.map((n) => [n.code, n.severity])));

autoTpl('t-self-failed');
const rFail = workflows.startWorkflow({ templateId: 't-self-failed', title: '失败用例', autoStart: false });
const tFail = store.listWorkflowTasks(rFail.id)[0];
store.updateWorkflowTask(tFail.id, { status: 'doing', agentRunId: 'ar-self-failed' });
workflows.onAgentRunFinished({ id: 'ar-self-failed', status: 'failed', error: '运行时没装' });
check('失败：任务标 failed，流程仍在 doing', store.getWorkflowTask(rFail.id, 'n1', 1)?.status === 'failed' && store.getWorkflowRun(rFail.id)?.status === 'doing', '');
const failNotices = noticesOf(rFail.id);
check('失败汇报一条，code=WF_FAILED、severity=warn', failNotices.length === 1 && failNotices[0]?.code === 'WF_FAILED' && failNotices[0]?.severity === 'warn', JSON.stringify(failNotices.map((n) => [n.code, n.severity])));

autoTpl('t-self-abort');
const rAbort = workflows.startWorkflow({ templateId: 't-self-abort', title: '终止用例', autoStart: false });
workflows.abortWorkflow(rAbort.id, '雇主喊停');
check('人工终止：流程 terminated', store.getWorkflowRun(rAbort.id)?.status === 'terminated', String(store.getWorkflowRun(rAbort.id)?.status));
const abortNotices = noticesOf(rAbort.id);
check('终止汇报一条，code=WF_STOPPED、severity=blocking', abortNotices.length === 1 && abortNotices[0]?.code === 'WF_STOPPED' && abortNotices[0]?.severity === 'blocking', JSON.stringify(abortNotices.map((n) => [n.code, n.severity])));

console.log('\n⑤ 平台自己卡住也不静默：动作节点 / 派活准备 / 额度闸');
const onlyReport = (r) => {
  const list = noticesOf(r.id);
  return { list, one: list.length === 1 ? list[0] : null };
};
const actionTpl = (id, action) => autoTpl(id, [{ id: 'n1', name: '平台动作', action, approve: 'end', reject: 'end' }]);
actionTpl('t-self-action-unknown', 'action-not-installed');
const unknownAction = workflows.startWorkflow({ templateId: 't-self-action-unknown', title: '未知动作', autoStart: false });
workflows.startCurrentStep(unknownAction.id);
check('不认识的动作节点 → 任务 failed', store.getWorkflowTask(unknownAction.id, 'n1', 1)?.status === 'failed', String(store.getWorkflowTask(unknownAction.id, 'n1', 1)?.status));
const unknownNotice = onlyReport(unknownAction);
check('不认识的动作节点 → 一条 WF_FAILED 汇报', unknownNotice.list.length === 1 && unknownNotice.one?.code === 'WF_FAILED', JSON.stringify(unknownNotice.list.map((n) => n.code)));

// 平台动作是异步 Promise：等微任务队列结算完再看信箱
actionTpl('t-self-action-throw', 'self-delivery-throw');
workflows.registerActionNode('self-delivery-throw', { run: () => { throw new Error('建 PR 的凭据掉了'); } });
const throwing = workflows.startWorkflow({ templateId: 't-self-action-throw', title: '动作抛错', autoStart: false });
workflows.startCurrentStep(throwing.id);
await new Promise((r) => setImmediate(r));
check('动作节点抛错 → 任务 failed', store.getWorkflowTask(throwing.id, 'n1', 1)?.status === 'failed', String(store.getWorkflowTask(throwing.id, 'n1', 1)?.status));
const throwNotice = onlyReport(throwing);
check('动作节点抛错 → 一条 WF_FAILED 汇报', throwNotice.list.length === 1 && throwNotice.one?.code === 'WF_FAILED' && (throwNotice.one?.detail ?? '').includes('建 PR 的凭据掉了'), JSON.stringify(throwNotice.list.map((n) => n.code)));

// handler 自己 catch 住异常、调 finishActionTask(ok:false) 的路径也要汇报且不刷两条
actionTpl('t-self-action-self-fail', 'self-delivery-self-fail');
workflows.registerActionNode('self-delivery-self-fail', {
  run: ({ runId, task }) => workflows.finishActionTask(runId, task, {
    ok: false,
    result: workflows.resultOf({ status: 'failed', error: 'GitHub 返回 403' }),
    note: 'GitHub 返回 403',
  }),
});
const selfFail = workflows.startWorkflow({ templateId: 't-self-action-self-fail', title: '动作自报失败', autoStart: false });
workflows.startCurrentStep(selfFail.id);
await new Promise((r) => setImmediate(r));
const selfFailNotice = onlyReport(selfFail);
check('动作节点自报失败 → 一条 WF_FAILED 汇报（不重复）', selfFailNotice.list.length === 1 && selfFailNotice.one?.code === 'WF_FAILED' && selfFailNotice.one?.count === 1 && (selfFailNotice.one?.detail ?? '').includes('GitHub 返回 403'), JSON.stringify(selfFailNotice.list.map((n) => [n.code, n.count])));

// 点名的人中途离职：建流程时人还在，派活时才撞「这个经办人已经不在了」
const devId = people.dev.id;
autoTpl('t-self-dispatch-fail', [{ id: 'n1', name: '第一步', personaId: devId, approve: 'end', reject: 'end' }]);
const orphan = workflows.startWorkflow({ templateId: 't-self-dispatch-fail', title: '派活失败', autoStart: false });
check('删人前已点名研发', store.getWorkflowTask(orphan.id, 'n1', 1)?.assigneePersonaId === devId, String(store.getWorkflowTask(orphan.id, 'n1', 1)?.assigneePersonaId));
store.deletePersona(devId);
try {
  workflows.startCurrentStep(orphan.id);
} catch { /* 派活失败该被引擎记成 failed，异常不往测试外抛 */ }
check('派活失败 → 任务 failed', store.getWorkflowTask(orphan.id, 'n1', 1)?.status === 'failed', String(store.getWorkflowTask(orphan.id, 'n1', 1)?.status));
const orphanNotice = onlyReport(orphan);
check('派活失败 → 一条 WF_FAILED 汇报', orphanNotice.list.length === 1 && orphanNotice.one?.code === 'WF_FAILED', JSON.stringify(orphanNotice.list.map((n) => n.code)));
// 后续用例还要用研发岗，补回同一 id 的最小员工
store.createPersona({ id: devId, name: '验收研发', roleKey: 'dev', runtime: 'codex', cwd: tmp, instructions: '' });
check('补回研发岗后按岗位仍能指派', !!store.getPersona(devId), String(store.getPersona(devId)?.id));

// 额度闸：给一个绑了固定模型的研发岗员工设「今天 1 次」；已有运行记录把额度占满
const quotaPersona = store.createPersona({ name: '额度验收研发', roleKey: 'dev', runtime: 'codex', cwd: tmp, instructions: '', model: 'smoke/self-delivery' });
autoTpl('t-self-quota', [{ id: 'n1', name: '第一步', personaId: quotaPersona.id, approve: 'end', reject: 'end' }]);
const quotaConv = store.createConversation({ title: '额度账本', personaId: quotaPersona.id });
const used = store.createRun({ conversationId: quotaConv.id, runtime: 'codex', personaId: quotaPersona.id, model: 'smoke/self-delivery' });
store.finishRun(used.id, { status: 'done', usage: JSON.stringify({ totalTokens: 1 }) });
quota.setQuotas({ 'smoke/self-delivery': { dailyRuns: 1 } });
const capped = workflows.startWorkflow({ templateId: 't-self-quota', title: '额度卡住', autoStart: false });
try {
  workflows.startCurrentStep(capped.id);
} catch (e) {
  check('额度闸拦下并以错误抛出（不是静默改状态）', /次数用完|额度用完/.test(String(e?.message ?? e)), String(e?.message ?? e));
}
check('额度闸 → 任务 blocked', store.getWorkflowTask(capped.id, 'n1', 1)?.status === 'blocked', String(store.getWorkflowTask(capped.id, 'n1', 1)?.status));
const quotaNotice = onlyReport(capped);
check('额度闸 → 一条 WF_BLOCKED 汇报', quotaNotice.list.length === 1 && quotaNotice.one?.code === 'WF_BLOCKED' && (quotaNotice.one?.detail ?? '').includes('继续一次'), JSON.stringify(quotaNotice.list.map((n) => n.code)));
quota.setQuotas({});

console.log('\n⑥ 普通流程完全不受影响');
plainTpl('t-plain-manual', true);
const paused = finishWith('t-plain-manual', 'ar-plain-manual');
check('manual：仍停在「待验收」不自动流转', paused.task?.status === 'review' && paused.run?.status === 'doing', `${paused.task?.status}/${paused.run?.status}`);
check('普通流程不写任何自主汇报', noticesOf(paused.run.id).length === 0, String(noticesOf(paused.run.id).length));
plainTpl('t-plain-auto', false);
const plainDone = finishWith('t-plain-auto', 'ar-plain-auto');
check('普通非 manual 流程照样自动收尾', plainDone.run?.status === 'done', String(plainDone.run?.status));
check('普通流程收尾也不写自主汇报', noticesOf(plainDone.run.id).length === 0, String(noticesOf(plainDone.run.id).length));
check('内建交付模板的部署节点仍是 manual', workflows.BUILT_IN_TEMPLATE.nodes.find((n) => n.name === '部署')?.manual === true, '');

/*
 * ⑦ 从真实入口走一遍：PM 的运行钥匙 → POST /api/agent/cards/batch → 起实例。
 * 同进程起控制面（运行钥匙是进程内 Map，起子进程签的钥匙验不过）；临时库没有配好 CLI，
 * 第一步派活失败会被引擎吞掉并标 failed/阻塞 —— 这里只钉"实例真起来了、卡绑对了"。
 */
console.log('\n⑦ PM 经建卡通道立「由流程执行」的卡 → 真起一条自主实例');
const { pathToFileURL } = await import('node:url');
const BASE = `http://127.0.0.1:${PORT}`;
const auth = await import('./agent-auth.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pm = people.pm;
const conv = store.createConversation({ title: '自主交付验收会话', personaId: pm.id });
const run = store.createRun({ conversationId: conv.id, runtime: 'codex', personaId: pm.id });
const token = auth.issueRunCredential(run.id, pm.id).token;
await import(pathToFileURL(path.join(process.cwd(), 'apps', 'server', 'src', 'server.mjs')).href);
let up = false;
for (let i = 0; i < 100 && !up; i += 1) {
  try { up = (await fetch(BASE + '/api/ping', { signal: AbortSignal.timeout(600) })).ok; } catch { await sleep(150); }
}
check('同进程控制面起来了', up, up ? '' : '没等到 /api/ping');
if (up) {
  const projRoot = path.join(tmp, 'proj');
  fs.mkdirSync(projRoot, { recursive: true });
  const project = store.createProject({ name: '自主交付验收项目', root: projRoot });
  const res = await fetch(BASE + '/api/agent/cards/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bandi': '1', 'X-Bandi-Run-Token': token },
    body: JSON.stringify({ cards: [{ title: '自迭代班底、查设计漏洞', description: '范围/验收写这儿', projectId: project.id, flowTemplateId: selfDelivery.SELF_DELIVERY_TEMPLATE_ID, status: 'todo' }] }),
    signal: AbortSignal.timeout(10000),
  });
  const body = await res.json().catch(() => ({}));
  check('批量口收下（201）', res.status === 201, `${res.status} ${JSON.stringify(body).slice(0, 160)}`);
  check('没有"没派出去"的错误', (body.errors ?? []).length === 0, JSON.stringify(body.errors ?? []));
  const card = (body.tasks ?? [])[0];
  check('卡上记了模板 id', card?.flowTemplateId === selfDelivery.SELF_DELIVERY_TEMPLATE_ID, String(card?.flowTemplateId));
  check('卡上绑了流程实例（flowRunId 非空）', !!card?.flowRunId, String(card?.flowRunId));
  const flow = card?.flowRunId ? store.getWorkflowRun(card.flowRunId) : null;
  check('实例真存在且挂的是自主模板', flow?.templateId === selfDelivery.SELF_DELIVERY_TEMPLATE_ID, String(flow?.templateId));
  check('实例第一步已按岗位派给 PM', store.listWorkflowTasks(flow.id)[0]?.assigneePersonaId === pm.id, String(store.listWorkflowTasks(flow.id)[0]?.assigneePersonaId));
  check('第一步不是「没点名」阻塞', store.listWorkflowTasks(flow.id)[0]?.status !== 'blocked', String(store.listWorkflowTasks(flow.id)[0]?.status));
}

try { (await import('./store/db.mjs')).db.close(); } catch { /* 关不掉就算了 */ }
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录，删不掉就算了 */ }
console.log(`\n结论：${failed ? '有 ' + failed + ' 项没通过' : '全通过'}`);
process.exit(failed ? 1 : 0);
