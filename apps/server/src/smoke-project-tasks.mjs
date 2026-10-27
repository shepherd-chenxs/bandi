/**
 * 任务看板的验收：`GET /api/projects/{id}/tasks`（项目）与 `GET /api/tasks`（全局）
 *
 * 验的是用户定的两条（2026-10-24 改过口径：聊天派活**不进看板**，想进就立成卡）：
 *   · 看板上的任务 = **流程的每一次办理** + **手工卡**（含仓库值班 / PM 建），各一行；
 *     排序按"要不要人管"（已阻塞 → 失败 → 待验收 → …）；
 *     聊天派的活只在**员工详情**（personaTasks）里出现，那页注明来源、写清执行人；
 *     流程的活派进经办人的 1:1 会话，**不许被当成聊天派活算第二遍**。
 *   · 工作台那个**全局面板**说的是"所有的活"（2026-10-15）：跟项目看板**同一套行与列**，
 *     范围换成所有项目；每行标出属于哪个项目，没归属的收在「（未归属）」。
 *
 * 隔离：临时数据库、临时端口、临时项目目录 —— 不碰 data/ 里的真账。
 * 跑法：node apps/server/src/smoke-project-tasks.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.SMOKE_PORT ?? 8794);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-projtasks-'));
// 数据目录也要指过去：光隔离数据库，runtimes.json / plugins.json / connectors/ 仍会写进真实 data/
process.env.BANDI_DATA = tmp;
process.env.BANDI_DB = path.join(tmp, 'bandi.db');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

/*
 * ⚠️ **必须先设 BANDI_DB，再 import 任何会读 config 的模块**。
 * 静态 `import { repoRoot } from './config.mjs'` 会在这个文件的第一行就求值 ——
 * 那时 BANDI_DB 还没设，config 的 dbPath 已经定成 data/bandi.db，
 * 于是本脚本会往**真库**里写测试数据（2026-10-14 踩过，已清干净）。
 * 所以这里全用动态 import，并且下面那道自检不过就直接退出。
 */
const { repoRoot, dbPath } = await import('./config.mjs');
const store = await import('./store.mjs');
const { projectTasks, allTasks, personaTasks } = await import('./project-tasks.mjs');

if (!path.resolve(dbPath).toLowerCase().startsWith(path.resolve(tmp).toLowerCase())) {
  console.log(`✗ 临时库没生效：dbPath=${dbPath} 不在 ${tmp} 下 —— 拒绝继续（避免写进真库）`);
  process.exit(1);
}
console.log(`（隔离自检：dbPath=${dbPath}）`);

/* ---------------------------------------------------------------- 造数据 */
const projRoot = path.join(tmp, 'proj-a');
const otherRoot = path.join(tmp, 'proj-b');
fs.mkdirSync(projRoot, { recursive: true });
fs.mkdirSync(otherRoot, { recursive: true });

const proj = store.createProject({ name: '甲项目', root: projRoot });
const projB = store.createProject({ name: '乙项目', root: otherRoot });

const dev = store.createPersona({ name: '波哥', runtime: 'codex', cwd: projRoot, instructions: '' });
const qa = store.createPersona({ name: '星宇', runtime: 'codex', cwd: otherRoot, instructions: '' });

// ① 一条流程实例（本项目）：三次办理，状态各不同
store.upsertWorkflowTemplate({ id: 't-smoke', name: '交付流程', start: 'n1', nodes: [
  { id: 'n1', name: '写代码', approve: 'n2', reject: 'end' },
  { id: 'n2', name: '测试', approve: 'n3', reject: 'n1' },
  { id: 'n3', name: '部署', approve: 'end', reject: 'n2' },
] });
store.createWorkflowRun({ templateId: 't-smoke', title: '添加测试', intent: '给首页加一句话', projectId: proj.id });
const flowRun = store.listWorkflowRuns().find((r) => r.projectId === proj.id);
store.createWorkflowTask({ runId: flowRun.id, nodeId: 'n1', nodeName: '写代码', visit: 1, detail: '', assigneePersonaId: dev.id, status: '已完成' });
store.createWorkflowTask({ runId: flowRun.id, nodeId: 'n2', nodeName: '测试', visit: 1, detail: '', assigneePersonaId: null, status: '已阻塞', note: '「测试」没点名经办人' });
store.createWorkflowTask({ runId: flowRun.id, nodeId: 'n3', nodeName: '部署', visit: 1, detail: '', assigneePersonaId: dev.id, status: '待验收', note: '做完了，等人放行' });

// ② 聊天派活（本项目，靠执行人的工作目录归属）：会话没挂项目
const chatConv = store.createConversation({ title: '和 波哥', personaId: dev.id });
store.addMessage({ conversationId: chatConv.id, role: 'user', text: '把首页那句文案改掉' });
const chatRun = store.createRun({ conversationId: chatConv.id, runtime: 'codex', personaId: dev.id });
store.finishRun(chatRun.id, { status: '完成', exitCode: 0 });
store.addMessage({ conversationId: chatConv.id, runId: chatRun.id, role: 'assistant', text: '改好了' });

// ③ 一个"全被流程占用"的会话：它的最近一次执行是流程的一步 → 不算聊天派活
const flowConv = store.createConversation({ title: '和 星宇', personaId: qa.id });
const flowTurn = store.createRun({ conversationId: flowConv.id, runtime: 'codex', personaId: qa.id });
store.addMessage({ conversationId: flowConv.id, runId: flowTurn.id, role: 'assistant', text: '测试报告在这', taskId: 'wt2-flow' });

// ③c 触发消息带 runId、但**没产出回复也没记 agentRunId**的流程轮次（最难认的一类）
const orphanConv = store.createConversation({ title: '和 李俊', personaId: qa.id });
store.addMessage({ conversationId: orphanConv.id, role: 'user', text: '【流程 · 端到端】第 1 次办理：谈需求', runId: 'wf-some-flow', taskId: null });
const orphanTurn = store.createRun({ conversationId: orphanConv.id, runtime: 'codex', personaId: qa.id });
store.finishRun(orphanTurn.id, { status: '失败', exitCode: 1 });

// ④ 别的项目下的聊天派活 → 不该出现在本项目。**停下来等人的那种**（已停止），
//    顺带验「已阻塞」那一列/那枚数字的口径（2026-10-15）
const convB = store.createConversation({ title: '和 星宇', personaId: qa.id });
store.setConversationProject(convB.id, projB.id);
const runB = store.createRun({ conversationId: convB.id, runtime: 'codex', personaId: qa.id });
store.finishRun(runB.id, { status: '已停止', exitCode: 1 });
store.addMessage({ conversationId: convB.id, role: 'user', text: '乙项目的活' });

// ⑤ 谁都不认领的聊天派活：执行人的工作目录不在任何项目根下
//    → 项目看板看不见它，全局面板里收在「（未归属）」（2026-10-15）
const strayPersona = store.createPersona({ name: '崔老三', runtime: 'codex', cwd: tmp, instructions: '' });
const strayConv = store.createConversation({ title: '和 崔老三', personaId: strayPersona.id });
store.addMessage({ conversationId: strayConv.id, role: 'user', text: '顺手看看这个' });
const strayRun = store.createRun({ conversationId: strayConv.id, runtime: 'codex', personaId: strayPersona.id });
store.finishRun(strayRun.id, { status: '完成', exitCode: 0 });

// ⑥ 执行人已经不在的会话：**不能**因为"服务进程的 cwd 恰好等于某个项目根"就被算进那个项目
//    （`path.resolve('')` 返回进程 cwd 的坑；服务端是以 repoRoot 为 cwd 起的，见下面 spawn）
const ghostProj = store.createProject({ name: '同根项目', root: repoRoot });
const ghostConv = store.createConversation({ title: '和 已删除的人', personaId: 'p-不存在' });
store.addMessage({ conversationId: ghostConv.id, role: 'user', text: '这个人的账号已经没了' });
const ghostRun = store.createRun({ conversationId: ghostConv.id, runtime: 'codex', personaId: 'p-不存在' });
store.finishRun(ghostRun.id, { status: '完成', exitCode: 0 });

/* ------------------------------------------------------------ ① 模块层 */
console.log('⓪ 口径（2026-10-24 用户定的）：聊天派活不进看板，员工详情照收');
check('项目看板没有聊天行', projectTasks(proj).rows.filter((r) => r.source === 'chat').length === 0);
check('全局面板没有聊天行', allTasks().rows.filter((r) => r.source === 'chat').length === 0);
const mineDev = personaTasks(store.getPersona(dev.id));
check('员工详情照收聊天行', mineDev.rows.filter((r) => r.source === 'chat').length === 1);

console.log('① 聚合：流程 + 手工卡一套行（聊天派活只在员工详情）');
const data = projectTasks(proj);
check('项目能查到', data?.project_id === proj.id, data?.project_name);
check('流程行 3 条（三次办理）', data.rows.filter((r) => r.source === 'flow').length === 3, String(data.rows.filter((r) => r.source === 'flow').length));
check('看板上没有聊天派活', data.rows.filter((r) => r.source === 'chat').length === 0);
check('流程来源标「流程」', data.rows.filter((r) => r.source === 'flow').every((r) => r.source_text === '流程'));
check('员工详情里聊天行标「聊天派活」', mineDev.rows.find((r) => r.source === 'chat')?.source_text === '聊天派活', mineDev.rows.find((r) => r.source === 'chat')?.source_text);
check('员工详情里聊天行写清执行人', mineDev.rows.find((r) => r.source === 'chat')?.assignee === '波哥', mineDev.rows.find((r) => r.source === 'chat')?.assignee);
check('员工详情里聊天行的任务名 = 最后一句用户话', mineDev.rows.find((r) => r.source === 'chat')?.task === '把首页那句文案改掉', mineDev.rows.find((r) => r.source === 'chat')?.task);
check('流程行带流程名与节点', data.rows.some((r) => r.task.startsWith('添加测试 · 测试')), data.rows.map((r) => r.task).join(' | '));
check('没点名的那行执行人写「（没点名）」', data.rows.find((r) => r.status === '已阻塞')?.assignee === '（没点名）', data.rows.find((r) => r.status === '已阻塞')?.assignee);

console.log('\n② 排序：要人管的在最前');
const ranks = data.rows.map((r) => r.rank);
check('rank 单调不减', ranks.every((v, i) => i === 0 || ranks[i - 1] <= v), ranks.join(','));
check('第一条就是「已阻塞」', data.rows[0]?.status === '已阻塞', data.rows[0]?.status);

console.log('\n③ 不能算错的会话（聊天行看员工详情那一页）');
const mineQa = personaTasks(store.getPersona(qa.id));
check('全被流程占用的会话不算聊天派活', !mineQa.rows.some((r) => r.conversation_id === flowConv.id));
check('别的项目的聊天派活不混到别的执行人头上', !mineDev.rows.some((r) => r.conversation_id === convB.id));

console.log('\n④ 概览数字');
check('流程实例 1 条', data.flow_count === 1, String(data.flow_count));
check('聊天派活不进看板（chat_count 0）', data.chat_count === 0, String(data.chat_count));
check('已阻塞 1 条', data.blocked_count === 1, String(data.blocked_count));
check('待验收 1 条', data.waiting_count === 1, String(data.waiting_count));

console.log('\n⑤ 看板列（项目详情页按它画看板）');
const colOf = (key) => data.columns.find((c) => c.key === key);
check('列从左到右按生命周期（「想法」在最左，它比"待办"还早）', data.columns.map((c) => c.key).join('>').startsWith('idea>todo>doing>review>blocked>failed>done>cancelled'), data.columns.map((c) => c.key).join('>'));
check('阻塞那列的列名就是状态名（不再叫「停下等人」）', colOf('blocked')?.label === '已阻塞', colOf('blocked')?.label);
check('已阻塞那张卡在「已阻塞」列里', colOf('blocked')?.cards.some((c) => c.status === '已阻塞'));
check('待验收那张卡在「待验收」列里', colOf('review')?.cards.some((c) => c.status === '待验收'));
check('卡数之和 = 平表行数', data.columns.reduce((n, c) => n + c.count, 0) === data.rows.length, `${data.columns.reduce((n, c) => n + c.count, 0)} vs ${data.rows.length}`);
check('每张卡都带列 key', data.rows.every((r) => !!r.col));
check('流程卡带 template_id（点得进实例）', data.rows.filter((r) => r.source === 'flow').every((r) => !!r.template_id));
check('员工详情的聊天行带 conversation_id（点得进会话）', mineDev.rows.filter((r) => r.source === 'chat').every((r) => !!r.conversation_id));

// 「已阻塞」这一列收两种状态（流程的已阻塞 / 聊天的已停止）。聊天行不进看板了，
// 但列的归堆口径还在：员工详情里已停止的聊天行落「blocked」列（2026-10-24）
const boardB = projectTasks(projB);
const blockedB = boardB.columns.find((c) => c.key === 'blocked');
const mineQaRows = mineQa.rows;
check('员工详情里「已停止」的聊天行落「已阻塞」列', mineQaRows.some((r) => r.conversation_id === convB.id && r.col === 'blocked'),
  JSON.stringify(mineQaRows.find((r) => r.conversation_id === convB.id)?.col));
check('概览的「已阻塞」= 那一列的卡数（同一个口径）', boardB.blocked_count === blockedB?.count,
  `${boardB.blocked_count} vs ${blockedB?.count}`);

/* ------------------------------------------------ ② 全局面板（同一套机制） */
console.log('\n⑥ 全局面板（工作台 → 任务看板）：所有项目的活铺在一张看板上');
const all = allTasks();
check('范围标 all（跟项目看板分得开）', all.scope === 'all', String(all.scope));
check('总量 = 甲 3（乙、未归属没有活就不占）', all.total === 3, String(all.total));
check('= 两个项目看板的行数之和（没有重复行）',
  all.total === data.rows.length + boardB.rows.length,
  `${all.total} vs ${data.rows.length}+${boardB.rows.length}`);
check('每行都标了属于哪个项目', all.rows.every((r) => 'project_id' in r && !!r.project_name),
  all.rows.map((r) => `${r.source}:${r.project_name}`).join(' | '));
check('甲项目的行标「甲项目」', all.rows.filter((r) => r.project_id === proj.id).every((r) => r.project_name === '甲项目'));
check('员工详情里：乙项目的聊天行标「乙项目」', mineQa.rows.find((r) => r.conversation_id === convB.id)?.project_name === '乙项目',
  String(mineQa.rows.find((r) => r.conversation_id === convB.id)?.project_name));
check('员工详情里：没归属的聊天行收在「（未归属）」',
  personaTasks(store.getPersona(strayPersona.id)).rows.find((r) => r.conversation_id === strayConv.id)?.project_name === '（未归属）');
check('项目看板的行不带项目标签（卡片上不会多一枚章）',
  data.rows.every((r) => !r.project_name) && boardB.rows.every((r) => !r.project_name));
check('全局跟项目看板是同一套列', all.columns.map((c) => c.key).join('>') === data.columns.map((c) => c.key).join('>'),
  all.columns.map((c) => c.key).join('>'));
check('全局的卡数之和 = 全局行数', all.columns.reduce((n, c) => n + c.count, 0) === all.rows.length,
  `${all.columns.reduce((n, c) => n + c.count, 0)} vs ${all.rows.length}`);
check('概览的「已阻塞」= 那一列的卡数（全局面板同一口径）',
  all.blocked_count === all.columns.find((c) => c.key === 'blocked')?.count,
  `${all.blocked_count} vs ${all.columns.find((c) => c.key === 'blocked')?.count}`);
check('按项目概览加起来 = 总数', all.by_project.reduce((n, x) => n + x.total, 0) === all.total,
  all.by_project.map((x) => `${x.project_name}:${x.total}`).join(' | '));
check('按项目概览：甲项目 3 件', all.by_project.find((x) => x.project_id === proj.id)?.total === 3, String(all.by_project.find((x) => x.project_id === proj.id)?.total));
check('按项目概览：没有活的乙项目不占行', !all.by_project.some((x) => x.project_id === projB.id));
check('按项目概览只列有活的项目（空项目不占行）', !all.by_project.some((x) => x.total === 0));
check('按项目概览里「停」的口径 = 概览的「已阻塞」',
  all.by_project.reduce((n, x) => n + x.blocked, 0) === all.blocked_count,
  `${all.by_project.reduce((n, x) => n + x.blocked, 0)} vs ${all.blocked_count}`);

/* ------------------------------------------------------------- ③ 走接口 */
console.log('\n⑦ 接口（真起一次服务端）');
const logPath = path.join(tmp, 'server.log');
const logFd = fs.openSync(logPath, 'a');
const child = spawn(process.execPath, [path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs')], {
  cwd: repoRoot,
  env: { ...process.env, BANDI_PORT: String(PORT), BANDI_DB: process.env.BANDI_DB },
  windowsHide: true,
  stdio: ['ignore', logFd, logFd],
});
fs.closeSync(logFd);
const api = async (p, opts) => {
  const res = await fetch(BASE + p, opts);
  return { status: res.status, body: await res.json().catch(() => null) };
};

try {
  let up = false;
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(BASE + '/api/projects')).ok) { up = true; break; } } catch { /* 还没起 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  check('服务端起来了', up);

  // 平台级路径（项目 → 任务），不是插件命名空间
  const res = await api(`/api/projects/${encodeURIComponent(proj.id)}/tasks`);
  check('任务接口 200（/api/projects/{id}/tasks）', res.status === 200, String(res.status));
  check('接口的行数与聚合一致', res.body?.rows?.length === data.rows.length, `${res.body?.rows?.length} vs ${data.rows.length}`);
  check('接口也带看板列', (res.body?.columns?.length ?? 0) >= 6, String(res.body?.columns?.length));
  check('接口也带概览数字（聊天派活不进看板）', res.body?.flow_count === 1 && res.body?.chat_count === 0, JSON.stringify({ f: res.body?.flow_count, c: res.body?.chat_count }));
  check('员工任务接口里聊天行标了来源（GET /api/personas/:id/tasks）',
    (await api(`/api/personas/${encodeURIComponent(dev.id)}/tasks`)).body?.rows?.some((r) => r.source_text === '聊天派活'));
  // 执行人已经不在的会话：立卡必须被拒，且不能因为"进程 cwd 恰好是同根项目"被算进那个项目
  const ghostCard = await api(`/api/conversations/${encodeURIComponent(ghostConv.id)}/card`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bandi': '1' }, body: '{}' });
  check('执行人查不到的会话立卡 → 400（同根项目捡不走它）', ghostCard.status === 400 && /项目/.test(ghostCard.body?.error ?? ''), `${ghostCard.status} ${ghostCard.body?.error ?? ''}`);

  const old = await api(`/api/status/projects/${encodeURIComponent(proj.id)}/tasks`);
  check('旧插件路径已撤（/api/status/... 404）', old.status === 404, String(old.status));

  const missing = await api('/api/projects/pj-不存在/tasks');
  check('项目不存在 → 404', missing.status === 404, String(missing.status));
  const write = await api(`/api/projects/${encodeURIComponent(proj.id)}/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  check('POST 现在会建卡（空标题被拒 400）', write.status === 400, String(write.status));

  // 全局面板（工作台 → 任务看板）：项目看板之外的那条路
  const g = await api('/api/tasks');
  check('全局看板接口 200（/api/tasks）', g.status === 200, String(g.status));
  check('接口的范围标 all', g.body?.scope === 'all', String(g.body?.scope));
  check('接口的行数与聚合一致', (g.body?.rows?.length ?? -1) === all.total, `${g.body?.rows?.length} vs ${all.total}`);
  check('接口每行都带 project_name', g.body?.rows?.every((r) => !!r.project_name));
  check('接口带按项目概览（只有真有活的甲项目）', Array.isArray(g.body?.by_project) && g.body.by_project.length === 1, String(g.body?.by_project?.length));
  check('接口也带同一套看板列', g.body?.columns?.map((c) => c.key).join('>') === data.columns.map((c) => c.key).join('>'));

  console.log('\n⑧ 手工建任务（看板列头的「＋」，参照同类产品）');
  const mk = (body) => api(`/api/projects/${encodeURIComponent(proj.id)}/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const made = await mk({ title: '手工卡：写一版首页文案', description: '三句话以内', status: '待办' });
  check('建卡 201', made.status === 201, `${made.status} ${JSON.stringify(made.body?.error ?? '')}`);
  const tid = made.body?.task?.id ?? '';
  const board1 = (await api(`/api/projects/${encodeURIComponent(proj.id)}/tasks`)).body;
  const card = board1.rows.find((r) => r.manual_id === tid);
  check('卡在平表里，来源标「手动」', card?.source === 'manual' && card?.source_text === '手动', JSON.stringify(card?.source_text));
  check('落在「待办」列', card?.col === 'todo', String(card?.col));
  check('没派人时写「（没派活）」', card?.assignee === '（没派活）', String(card?.assignee));
  check('看板那列里也有它', board1.columns.find((c) => c.key === 'todo')?.cards.some((c) => c.manual_id === tid));
  check('概览数字带 manual_count', board1.manual_count === 1, String(board1.manual_count));
  const gBoard = (await api('/api/tasks')).body;
  check('同一张卡在全局面板里也看得见（带项目标签）', gBoard.rows.find((r) => r.manual_id === tid)?.project_name === '甲项目',
    String(gBoard.rows.find((r) => r.manual_id === tid)?.project_name));

  const badTitle = await mk({ title: '   ' });
  check('空标题 400', badTitle.status === 400, String(badTitle.status));

  // 「想法」列（最左）：只可能手工来，而且**不该被立刻派活**
  const idea = await mk({ title: '手工卡：也许可以做个导出', status: '想法' });
  check('「想法」能建（201）', idea.status === 201, `${idea.status} ${JSON.stringify(idea.body?.error ?? '')}`);
  const ideaBoard = (await api(`/api/projects/${encodeURIComponent(proj.id)}/tasks`)).body;
  const ideaCard = ideaBoard.rows.find((r) => r.manual_id === idea.body?.task?.id);
  check('落在最左那列「想法」', ideaCard?.col === 'idea', String(ideaCard?.col));
  check('列顺序里 idea 在最前', ideaBoard.columns[0]?.key === 'idea', ideaBoard.columns[0]?.key);

  // 「想法」+ 派人 + 立即开始 → 仍然**留在想法**（不派活，否则那列刚建完就被转走）
  const ideaStart = await mk({
    title: '手工卡：想法不该被立刻开始',
    status: '想法',
    personaId: (data.personas ?? [])[0]?.id ?? null,
    startNow: true,
  });
  check('「想法」+ startNow 也不会跳列', ideaStart.body?.task?.status === '想法', String(ideaStart.body?.task?.status));

  const patched = await api(`/api/projects/tasks/${encodeURIComponent(tid)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: '进行中' }),
  });
  check('拖列 = 改状态（PATCH 200）', patched.status === 200 && patched.body?.task?.status === '进行中', JSON.stringify(patched.body));
  const board2 = (await api(`/api/projects/${encodeURIComponent(proj.id)}/tasks`)).body;
  check('改完状态它站到「进行中」列', board2.rows.find((r) => r.manual_id === tid)?.col === 'doing');
  const badStatus = await api(`/api/projects/tasks/${encodeURIComponent(tid)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: '瞎写' }),
  });
  check('乱改状态 400', badStatus.status === 400, String(badStatus.status));

  /*
   * 拖进「进行中」＝开工（2026-10-17 对齐同类产品：状态到位 + 有执行人才触发）。
   *
   * 真派活会去起一次 agent CLI —— 冒烟里绝不能真跑（烧 token、还要连网）。
   * 所以这里造一个**"他手上正有活跑"**的现场，派活就会被并发闸挡住。验的正是最关键的三条：
   *   ① 有执行人的卡进「进行中」**会去派活**（不是默默改个状态）；
   *   ② 派不出去时**状态原地不动** —— 卡要是留在「进行中」却没跑，看板上就成了假话；
   *   ③ 撞忙要落排队标记（30 秒节拍会自己再试，不靠人手动重点）。
   *
   * ⚠️ 2026-10-24 闸的口径变了，这段跟着改：**项目闸从"同时只许一件"放开成安全网 20**
   *    （真正的限流在每个人身上，见 dispatch.mjs 的 PROJECT_RUN_CAP 说明）。所以"插一条
   *    带 projectId 的跑中 run"已经挡不住派活了 —— 想验"忙了就不开工"，只能从**个人闸**下手：
   *    把这个人这一次的并发配成 1，插一条他自己的跑中 run，第二件就必被挡。
   */
  store.updatePersona(dev.id, { maxParallel: 1 });
  const devConv = store.ensureConversationForPersona(dev.id);
  store.createRun({ conversationId: devConv.id, runtime: 'codex', personaId: dev.id, projectId: proj.id });
  const autoCard = await mk({ title: '手工卡：拖进进行中就开工', personaId: dev.id });
  const autoId = autoCard.body?.task?.id ?? '';
  const auto = await api(`/api/projects/tasks/${encodeURIComponent(autoId)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: '进行中' }),
  });
  check(
    '有执行人 + 拖进「进行中」→ 真去派活（他正忙 → 400 并说清原因）',
    auto.status === 400 && /没开工/.test(String(auto.body?.error ?? '')),
    `${auto.status} ${JSON.stringify(auto.body?.error ?? '')}`,
  );
  check('派不出去时状态不动，卡还留在「待办」', store.getProjectTask(autoId)?.status === '待办', String(store.getProjectTask(autoId)?.status));
  check('派不出去也不会留下 runId（看板不会显示"在跑"）', !store.getProjectTask(autoId)?.runId, String(store.getProjectTask(autoId)?.runId));
  check('撞忙要落排队标记（节拍会自己再试）', !!store.getProjectTask(autoId)?.queuedAt, String(store.getProjectTask(autoId)?.queuedAt));
  store.updateProjectTask(autoId, { queuedAt: null }); // 别给后面的用例留下会自动开工的卡

  /*
   * 工单会话（2026-10-18）：一张卡一条，不再复用执行人那条 1:1。
   * 这是"收件箱 / 执行槽拆开"的落点，钉住三条：同卡复用、异卡分开、不混进 1:1。
   */
  const execA = store.ensureExecConversation({ personaId: dev.id, scope: `task:${autoId}`, title: '任务 · A', projectId: proj.id });
  const execA2 = store.ensureExecConversation({ personaId: dev.id, scope: `task:${autoId}`, title: '任务 · A', projectId: proj.id });
  const execB = store.ensureExecConversation({ personaId: dev.id, scope: 'task:another', title: '任务 · B', projectId: proj.id });
  check('同一张卡两次取到同一条工单会话（返工续它）', execA.id === execA2.id, `${execA.id} / ${execA2.id}`);
  check('不同卡是不同会话', execA.id !== execB.id);
  check('工单会话 kind=exec 且带 execScope', execA.kind === 'exec' && execA.execScope === `task:${autoId}`, `${execA.kind} ${execA.execScope}`);
  check('工单会话不是执行人那条 1:1', store.ensureConversationForPersona(dev.id).id !== execA.id);

  /*
   * 个人并发闸（2026-10-18 建，2026-10-24 改成**按人配**）：上限不是写死的 2 了，是
   * `personas.maxParallel`（默认 6）。这条用例要验的仍然是"到顶了就挡住、理由说清是他人满了"，
   * 所以把他的并发**显式配成 2**，再造场面 —— 判的是机制，不是那个数字。
   *
   * 场面：上一段留了一条他自己的跑中 run（进「进行中」那条），再加一条就正好到 2；第三件必挡。
   */
  store.updatePersona(dev.id, { maxParallel: 2 });
  const r1 = store.createRun({ conversationId: devConv.id, runtime: 'codex', personaId: dev.id });
  const dispatch = await import('./dispatch.mjs');
  let capErr = null;
  try {
    dispatch.dispatchToThread(execB.id, '试试第三件', {});
  } catch (e) {
    capErr = e;
  }
  // 判"是不是人满了"只看措辞（人数会随着前面的用例变），不钉死数字
  check('并发到顶：再派一件被挡（busy）', capErr?.code === 'busy' && /件活在跑/.test(String(capErr.message ?? '')), String(capErr?.message ?? '没挡住'));
  store.finishRun(r1.id, { status: '完成' });

  // 任务卡的工单会话（kind=exec）里派活，**不该**投影成「聊天派活」卡 —— 它自己就是那张任务卡（2026-10-19）
  const execRun = store.createRun({ conversationId: execB.id, runtime: 'codex', personaId: dev.id });
  store.finishRun(execRun.id, { status: '完成', exitCode: 0 });
  const afterExec = projectTasks(proj);
  check('任务卡工单会话不投影成聊天派活卡', !afterExec.rows.some((r) => r.conversation_id === execB.id),
    String(afterExec.rows.filter((r) => r.source === 'chat').map((r) => r.conversation_id).join(',')));

  const del = await api(`/api/projects/tasks/${encodeURIComponent(tid)}`, { method: 'DELETE' });
  check('删除 200', del.status === 200, String(del.status));
  const board3 = (await api(`/api/projects/${encodeURIComponent(proj.id)}/tasks`)).body;
  check('删完看板上没了', !board3.rows.some((r) => r.manual_id === tid));
  /*
   * 原来这条是 `board3.rows.length === board1.rows.length - 1` —— 隐含假设
   * "**这段时间只建了一张手工卡**"，多建几张（比如下面测「想法」那两张）就误报。
   * 它要验的是"流程/聊天的卡不受影响"，那就按来源数，别靠总数倒推。
   */
  const flowChat = (b) => b.rows.filter((r) => r.source !== 'manual').length;
  check('流程/聊天的卡不受影响', flowChat(board3) === flowChat(board1), `${flowChat(board1)} → ${flowChat(board3)}`);
} catch (err) {
  check('接口这一段没跑挂', false, String(err?.message ?? err));
} finally {
  try { child.kill(); } catch { /* 已经退了 */ }
}

/* ----------------------------------------------------------- ④ 插件声明 */
console.log('\n⑨ 面板插件里**不该**再有任务（任务归平台的项目看板与全局面板）');
/*
 * 2026-10-24：面板从「左列表 + 右详情」改成**单页概览**（设计稿 design/v1.2.0-dev-panel-overview.html）。
 * 所以下面断言的对象也换了：不再看 split.detail，看的是单页 blocks。
 * 老断言里"不该有的东西"（任务表 / 档案行 / 任务权限）照样成立，只是要在新结构里查。
 */
for (const p of ['plugins/project-panel/manifest.json', 'apps/server/catalog/plugins/project-panel/manifest.json']) {
  const m = JSON.parse(fs.readFileSync(path.join(repoRoot, p), 'utf8'));
  const blocks = m.panel.blocks ?? [];
  const headings = blocks.map((b) => b.heading ?? '');
  check(`${p} 没有 split（改单页概览后不该再有主从布局）`, !m.panel.split, String(!!m.panel.split));
  check(`${p} 没有「任务」表`, !blocks.some((b) => b.type === 'table' && b.heading === '任务'), headings.join(' | '));
  check(`${p} 没有任务接口权限`, !m.permissions.some((x) => x.endsWith('/tasks')), m.permissions.join(', '));
  /*
   * 2026-10-23 PRD v0.2 **改动 3**：项目档案属于平台「项目」模块，**不进插件**。
   * 判据不变，只是改成扫整份 blocks（含 card.lines / rows）。
   */
  check(`${p} 插件里没有「项目档案」块`, !headings.includes('项目档案'), headings.join(' | '));
  const labels = blocks.flatMap((b) => [
    ...(b.rows ?? []).map((r) => r.label),
    ...(b.card?.lines ?? []).map((r) => r.label),
    ...(b.card?.foot ?? []).map((r) => r.label),
    ...(b.items ?? []).map((r) => r.label),
  ]);
  check(`${p} 插件里没有任何档案行（干什么 / 项目经理 / 成员 / 开始时间）`,
    !['干什么', '项目经理', '成员', '开始时间', '迭代版本数'].some((x) => labels.includes(x)), labels.join(' | '));
  /*
   * 版本明细（原来那张 5 列表）**首屏不要**（稿子：下放到详情页）。
   * 改判据：首屏不许再出现版本表；版本数仍要在概览里看得见（KPI 聚合 + 项目卡那一行）。
   */
  check(`${p} 首屏没有版本明细表（下放到详情页）`, !blocks.some((b) => b.type === 'table'), headings.join(' | '));
  check(`${p} 版本数仍在概览里（KPI 有已发布合计、卡片有版本行）`,
    labels.some((x) => String(x).includes('版本')) && blocks.some((b) => b.type === 'stats'));
  /*
   * 改名「研发面板」（PRD v0.2 改动 1）：只改展示名，插件 id / 目录名仍是 project-panel。
   * 旧名在界面上不该再出现 —— 这里连带把前端源码一起扫（声明式面板的标题全来自 label）。
   */
  check(`${p} 展示名是「研发面板」`, m.label === '研发面板', String(m.label));
  check(`${p} 定位写明软件研发专属`, /软件研发/.test(String(m.description)), String(m.description).slice(0, 40));
  check(`${p} 插件 id 没动（还是 project-panel）`, m.id === 'project-panel', String(m.id));
}

{
  const webDir = path.join(repoRoot, 'apps', 'web');
  const files = [
    path.join(webDir, 'index.html'),
    ...fs.readdirSync(path.join(webDir, 'js')).map((f) => path.join(webDir, 'js', f)),
    path.join(webDir, 'app.mjs'),
  ].filter((f) => f.endsWith('.html') || f.endsWith('.mjs'));
  const stale = files.filter((f) => fs.readFileSync(f, 'utf8').includes('项目面板'));
  check('前端源码里不再出现旧名「项目面板」', stale.length === 0, stale.map((f) => path.relative(repoRoot, f)).join(', '));

  /*
   * 项目详情档案区（A1）：**三项**（简介 / 负责人 / 起止），没有「迭代版本数」那一行。
   * 前端是模板字符串画的，这里按行标签认 —— 标签被改名或是被搬走都会红。
   * 起止是一格（"开始 / 结束" + 两个 date 输入），标签不是「开始时间」，单独认它的输入框。
   *
   * 2026-10-24 设计稿 v1.0.1：档案里那排「成员」chip **整块撤掉**，成员单独成 tab
   * （插在基础信息与项目规章之间，data-panel="members"）。负责人仍只在档案里，不进成员 tab。
   *
   * ⚠️ 2026-10-24 标签对 PRD 口径改过名：「干什么」→「项目简介」、「项目经理」→「项目负责人」。
   *    判的还是**这三项在不在**（PRD A1 的本意），不钉死那三个字 —— 通用工作区不该用
   *    研发味的词，措辞归产品定；这里跟的是**行还在、没被搬走**。
   */
  const projSrc = fs.readFileSync(path.join(webDir, 'js', 'projects.mjs'), 'utf8');
  // 注释里可以提这件事（说明"为什么撤"），判的是**有没有那一行**
  check('项目详情档案区不再渲染「迭代版本数」', !projSrc.includes('row-label">迭代版本数<'));
  for (const need of ['项目简介', '项目负责人']) {
    check(`项目详情档案区仍有「${need}」`, projSrc.includes(`row-label">${need}<`));
  }
  check('项目详情档案区不再渲染「成员」那一行', !projSrc.includes('row-label">成员<'));
  check('项目详情档案区仍有开始 / 结束日期', projSrc.includes('id="pjStarted"') && projSrc.includes('id="pjEnded"'));
  check('项目详情不再去取版本数接口', !projSrc.includes('/api/status/projects/'));
  // 成员的落点：tab 与面板都在，且顺序是基础信息 → 项目成员 → 项目规章
  check('项目详情有「项目成员」tab', projSrc.includes('data-tab="members"') && projSrc.includes('data-panel="members"'));
  {
    const atBasics = projSrc.indexOf('data-tab="basics"');
    const atMembers = projSrc.indexOf('data-tab="members"');
    const atRules = projSrc.indexOf('data-tab="rules"');
    check(
      'tabs 顺序是 基础信息 / 项目成员 / 项目规章',
      atBasics >= 0 && atMembers > atBasics && atRules > atMembers,
      `basics=${atBasics} members=${atMembers} rules=${atRules}`,
    );
  }
  // 点成员行 = 进员工详情（复用 openDetail），不做就地展开
  check('点成员行进员工详情（openDetail）', /import \{[^}]*\bopenDetail\b[^}]*\} from '\.\/chat\.mjs'/.test(projSrc));
  // 运行时那格只认 auto（2026-10-23 拍板：运行时 id 不上列表）—— 别照设计稿抄回 rt-id/codex/claude
  check('成员行的运行时走 runtimeLabel（只显示「自动」）', projSrc.includes('runtimeLabel(who)'));
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录 */ }
console.log(`\n结论：${failed ? '有 ' + failed + ' 项没通过' : '全通过'}`);
process.exit(failed ? 1 : 0);
