/**
 * 任务看板的验收：`GET /api/projects/{id}/tasks`（项目）与 `GET /api/tasks`（全局）
 *
 * 验的是用户定的两条：
 *   · 一个项目里有哪些任务 = **流程的每一次办理** + **聊天派活** + **手工卡**，各一行；
 *     聊天派活单独注明来源、写清执行人；流程的活也派进经办人的 1:1 会话里，
 *     **不许被当成聊天派活算第二遍**；排序按"要不要人管"（已阻塞 → 失败 → 待人确认 → …）。
 *   · 工作台那个**全局面板**说的是"所有的活"（2026-10-15）：跟项目看板**同一套行与列**，
 *     范围换成所有项目；每行标出属于哪个项目，没归属的收在「（未归属）」，
 *     而且**每行只算一次**（聊天按会话算，不按项目算）。
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
const { projectTasks, allTasks } = await import('./project-tasks.mjs');

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
store.createWorkflowTask({ runId: flowRun.id, nodeId: 'n3', nodeName: '部署', visit: 1, detail: '', assigneePersonaId: dev.id, status: '待确认', note: '做完了，等人放行' });

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
//    顺带验「停下等人」那一列/那枚数字的口径（2026-10-15）
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
console.log('① 聚合：两个来源、一套行');
const data = projectTasks(proj);
check('项目能查到', data?.project_id === proj.id, data?.project_name);
check('流程行 3 条（三次办理）', data.rows.filter((r) => r.source === 'flow').length === 3, String(data.rows.filter((r) => r.source === 'flow').length));
check('聊天派活 1 条', data.rows.filter((r) => r.source === 'chat').length === 1, String(data.rows.filter((r) => r.source === 'chat').length));
check('流程来源标「流程」', data.rows.filter((r) => r.source === 'flow').every((r) => r.source_text === '流程'));
check('聊天来源标「聊天派活」', data.rows.find((r) => r.source === 'chat')?.source_text === '聊天派活', data.rows.find((r) => r.source === 'chat')?.source_text);
check('聊天派活写清执行人', data.rows.find((r) => r.source === 'chat')?.assignee === '波哥', data.rows.find((r) => r.source === 'chat')?.assignee);
check('聊天派活的任务名 = 最后一句用户话', data.rows.find((r) => r.source === 'chat')?.task === '把首页那句文案改掉', data.rows.find((r) => r.source === 'chat')?.task);
check('流程行带流程名与节点', data.rows.some((r) => r.task.startsWith('添加测试 · 测试')), data.rows.map((r) => r.task).join(' | '));
check('没点名的那行执行人写「（没点名）」', data.rows.find((r) => r.status === '已阻塞')?.assignee === '（没点名）', data.rows.find((r) => r.status === '已阻塞')?.assignee);

console.log('\n② 排序：要人管的在最前');
const ranks = data.rows.map((r) => r.rank);
check('rank 单调不减', ranks.every((v, i) => i === 0 || ranks[i - 1] <= v), ranks.join(','));
check('第一条就是「已阻塞」', data.rows[0]?.status === '已阻塞', data.rows[0]?.status);

console.log('\n③ 不能算错的四种会话');
check('全被流程占用的会话不算聊天派活', !data.rows.some((r) => r.conversation_id === flowConv.id));
check('触发消息带 runId 的流程轮次不算聊天派活', !data.rows.some((r) => r.conversation_id === orphanConv.id));
check('别的项目的聊天派活不混进来', !data.rows.some((r) => r.conversation_id === convB.id));

console.log('\n④ 概览数字');
check('流程实例 1 条', data.flow_count === 1, String(data.flow_count));
check('聊天派活 1 条', data.chat_count === 1, String(data.chat_count));
check('已阻塞 1 条', data.blocked_count === 1, String(data.blocked_count));
check('待人确认 1 条', data.waiting_count === 1, String(data.waiting_count));

console.log('\n⑤ 看板列（项目详情页按它画看板）');
const colOf = (key) => data.columns.find((c) => c.key === key);
check('列从左到右按生命周期（「想法」在最左，它比"待办"还早）', data.columns.map((c) => c.key).join('>').startsWith('idea>todo>doing>confirm>blocked>failed>done'), data.columns.map((c) => c.key).join('>'));
check('「停下等人」收已阻塞（并注明含已停止）', colOf('blocked')?.hint.includes('已停止'), colOf('blocked')?.hint);
check('已阻塞那张卡在「停下等人」列里', colOf('blocked')?.cards.some((c) => c.status === '已阻塞'));
check('待确认那张卡在「待人确认」列里', colOf('confirm')?.cards.some((c) => c.status === '待确认'));
check('卡数之和 = 平表行数', data.columns.reduce((n, c) => n + c.count, 0) === data.rows.length, `${data.columns.reduce((n, c) => n + c.count, 0)} vs ${data.rows.length}`);
check('每张卡都带列 key', data.rows.every((r) => !!r.col));
check('流程卡带 template_id（点得进实例）', data.rows.filter((r) => r.source === 'flow').every((r) => !!r.template_id));
check('聊天卡带 conversation_id（点得进会话）', data.rows.filter((r) => r.source === 'chat').every((r) => !!r.conversation_id));

// 「停下等人」这一列收两种状态（流程的已阻塞 / 聊天的已停止），概览那枚数字必须跟列一个口径
const boardB = projectTasks(projB);
const blockedB = boardB.columns.find((c) => c.key === 'blocked');
check('「已停止」的聊天卡站在「停下等人」列里', blockedB?.cards.some((c) => c.status === '已停止'), JSON.stringify(blockedB?.cards.map((c) => c.status)));
check('概览的「停下等人」= 那一列的卡数（同一个口径）', boardB.blocked_count === blockedB?.count,
  `${boardB.blocked_count} vs ${blockedB?.count}`);

/* ------------------------------------------------ ② 全局面板（同一套机制） */
console.log('\n⑥ 全局面板（工作台 → 任务看板）：所有项目的活铺在一张看板上');
const all = allTasks();
check('范围标 all（跟项目看板分得开）', all.scope === 'all', String(all.scope));
check('总量 = 甲 4 + 乙 1 + 未归属 2', all.total === 7, String(all.total));
check('= 两个项目看板的行数之和 + 未归属（没有重复行）',
  all.total === data.rows.length + boardB.rows.length + 2,
  `${all.total} vs ${data.rows.length}+${boardB.rows.length}+2`);
check('每行都标了属于哪个项目', all.rows.every((r) => 'project_id' in r && !!r.project_name),
  all.rows.map((r) => `${r.source}:${r.project_name}`).join(' | '));
check('甲项目的行标「甲项目」', all.rows.filter((r) => r.project_id === proj.id).every((r) => r.project_name === '甲项目'));
check('乙项目的聊天行标「乙项目」', all.rows.find((r) => r.conversation_id === convB.id)?.project_name === '乙项目',
  String(all.rows.find((r) => r.conversation_id === convB.id)?.project_name));
check('没归属的聊天行收在「（未归属）」', all.rows.find((r) => r.conversation_id === strayConv.id)?.project_name === '（未归属）',
  String(all.rows.find((r) => r.conversation_id === strayConv.id)?.project_name));
check('未归属那行不在任何项目看板里',
  !data.rows.some((r) => r.conversation_id === strayConv.id) && !boardB.rows.some((r) => r.conversation_id === strayConv.id));
check('执行人查不到的会话不会因为"进程 cwd 恰好是同根项目"被算进去',
  !projectTasks(ghostProj).rows.some((r) => r.conversation_id === ghostConv.id),
  JSON.stringify(projectTasks(ghostProj).rows.map((r) => r.conversation_id)));
check('它落到「（未归属）」', all.rows.find((r) => r.conversation_id === ghostConv.id)?.project_name === '（未归属）',
  String(all.rows.find((r) => r.conversation_id === ghostConv.id)?.project_name));
check('项目看板的行不带项目标签（卡片上不会多一枚章）',
  data.rows.every((r) => !r.project_name) && boardB.rows.every((r) => !r.project_name));
check('全局跟项目看板是同一套列', all.columns.map((c) => c.key).join('>') === data.columns.map((c) => c.key).join('>'),
  all.columns.map((c) => c.key).join('>'));
check('全局的卡数之和 = 全局行数', all.columns.reduce((n, c) => n + c.count, 0) === all.rows.length,
  `${all.columns.reduce((n, c) => n + c.count, 0)} vs ${all.rows.length}`);
check('概览的「停下等人」= 那一列的卡数（全局面板同一口径）',
  all.blocked_count === all.columns.find((c) => c.key === 'blocked')?.count,
  `${all.blocked_count} vs ${all.columns.find((c) => c.key === 'blocked')?.count}`);
check('聊天卡按会话算：全局里同一场对话只有一张卡',
  new Set(all.rows.filter((r) => r.source === 'chat').map((r) => r.conversation_id)).size ===
    all.rows.filter((r) => r.source === 'chat').length);
check('按项目概览加起来 = 总数', all.by_project.reduce((n, x) => n + x.total, 0) === all.total,
  all.by_project.map((x) => `${x.project_name}:${x.total}`).join(' | '));
check('按项目概览：甲项目 4 件', all.by_project.find((x) => x.project_id === proj.id)?.total === 4, String(all.by_project.find((x) => x.project_id === proj.id)?.total));
check('按项目概览：乙项目 1 件', all.by_project.find((x) => x.project_id === projB.id)?.total === 1);
check('按项目概览：未归属 2 件', all.by_project.find((x) => x.project_id === null)?.total === 2,
  JSON.stringify(all.by_project.map((x) => [x.project_id, x.total])));
check('按项目概览只列有活的项目（空项目不占行）', !all.by_project.some((x) => x.total === 0));
check('按项目概览里「停」的口径 = 概览的「停下等人」',
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
  check('接口也带概览数字', res.body?.flow_count === 1 && res.body?.chat_count === 1, JSON.stringify({ f: res.body?.flow_count, c: res.body?.chat_count }));
  check('聊天派活在接口里也标了来源', res.body?.rows?.some((r) => r.source_text === '聊天派活'));

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
  check('接口带按项目概览', Array.isArray(g.body?.by_project) && g.body.by_project.length >= 3, String(g.body?.by_project?.length));
  check('接口也带同一套看板列', g.body?.columns?.map((c) => c.key).join('>') === data.columns.map((c) => c.key).join('>'));

  console.log('\n⑧ 手工建任务（看板列头的「＋」，参照 Multica）');
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
for (const p of ['plugins/project-panel/manifest.json', 'apps/server/catalog/plugins/project-panel/manifest.json']) {
  const m = JSON.parse(fs.readFileSync(path.join(repoRoot, p), 'utf8'));
  const headings = m.panel.split.detail.blocks.map((b) => b.heading);
  check(`${p} 没有「任务」表`, !m.panel.split.detail.blocks.some((b) => b.type === 'table' && b.heading === '任务'), headings.join(' | '));
  check(`${p} 没有任务接口权限`, !m.permissions.some((x) => x.endsWith('/tasks')), m.permissions.join(', '));
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录 */ }
console.log(`\n结论：${failed ? '有 ' + failed + ' 项没通过' : '全通过'}`);
process.exit(failed ? 1 : 0);
