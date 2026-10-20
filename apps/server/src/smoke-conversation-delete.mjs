/**
 * 会话改造 · 后端验收：**永久删除一段 1:1 会话**
 *
 * 验的是用户拍板的几条（2026-10-20，PRD v1.1）：
 *   · 删除 = 物理删除：会话、消息、运行、运行事件、成员会话状态全部抹掉，**不可恢复**；
 *   · 引用过它的**任务卡 / 流程办理记录必须留着**，只是 `conversationId` 变空
 *     —— 删会话不能顺手删别人的卡；只动四列（workflow_runs.threadId / workflow_steps /
 *     workflow_tasks / project_tasks 的 conversationId），`node_jobs` 与 schedule 配置一概不动；
 *   · `direct` / `group` 都能删；群删的是**这一段会话**（2026-10-20 用户定：
 *     「删除不是删除群，是删除这次会话」），删到零段才连空群一起收掉；
 *     exec 归任务卡/流程；
 *   · 有 `status='跑中'` 的 run 时拒绝（409 + E4002，不是 500），且**库内数据完整**；
 *   · **不新增只读接口**：聊天记录用 `/api/state` 里现成的 conversations 过滤（反向断言住在 ②）。
 *
 * 隔离：临时数据库、临时数据目录、临时端口 —— 不碰 data/ 里的真账。
 * 跑法：node apps/server/src/smoke-conversation-delete.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.SMOKE_PORT ?? 8797);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-convdel-'));
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

if (!path.resolve(dbPath).toLowerCase().startsWith(path.resolve(tmp).toLowerCase())) {
  console.log(`✗ 临时库没生效：dbPath=${dbPath} 不在 ${tmp} 下 —— 拒绝继续（避免写进真库）`);
  process.exit(1);
}
console.log(`（隔离自检：dbPath=${dbPath}）`);

/* ---------------------------------------------------------------- 直查库 */
/**
 * 只读连接：验"库里还有没有残留"必须**绕开 store 的封装**看原始行，
 * 否则验的是 store 的返回值，不是事实（同 smoke-personas 的写法）。
 */
const openDb = async () => {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(process.env.BANDI_DB, { readOnly: true });
};
const countOf = (db, sql, ...args) => db.prepare(sql).get(...args).c;
const rowOf = (db, sql, ...args) => db.prepare(sql).get(...args) ?? null;

/* ---------------------------------------------------------------- 造数据 */
const projRoot = path.join(tmp, 'proj');
fs.mkdirSync(projRoot, { recursive: true });

const dev = store.createPersona({ name: '波哥', runtime: 'codex', cwd: projRoot, instructions: '' });
const proj = store.createProject({ name: '甲项目', root: projRoot });

// ① 要被删的那段 1:1：两条消息 + 一次跑完的运行 + 两条运行事件 + 一个远程节点活
const doomed = store.createConversation({ title: '和 波哥', personaId: dev.id });
store.addMessage({ conversationId: doomed.id, role: 'user', text: '把首页那句文案改掉，顺便把按钮颜色也换一下' });
const doomedRun = store.createRun({ conversationId: doomed.id, runtime: 'codex', personaId: dev.id });
store.appendRunEvent(doomedRun.id, 1, { type: 'text', text: '开始改' });
store.appendRunEvent(doomedRun.id, 2, { type: 'text', text: '改完了' });
store.finishRun(doomedRun.id, { status: '完成', exitCode: 0 });
store.addMessage({ conversationId: doomed.id, runId: doomedRun.id, role: 'assistant', text: '改好了' });
const nodeJob = store.enqueueNodeJob({ runId: doomedRun.id, nodeId: 'nd-smoke', family: 'codex', task: '跑一下' });

// ② 同一段会话被三张卡 / 一条流程实例引用（这些行必须留着）
const card = store.createProjectTask({
  projectId: proj.id,
  title: '手工卡：换首页文案',
  conversationId: doomed.id,
  runId: doomedRun.id,
});
const wfTask = store.createWorkflowTask({
  runId: 'wf-smoke',
  nodeId: 'n1',
  nodeName: '写代码',
  visit: 1,
  conversationId: doomed.id,
  agentRunId: doomedRun.id,
});
const wfStep = store.createWorkflowStep({
  runId: 'wf-smoke',
  idx: 1,
  name: '写代码',
  conversationId: doomed.id,
  agentRunId: doomedRun.id,
});
const wfRun = store.createWorkflowRun({ templateId: 't-smoke', title: '实例甲', threadId: doomed.id });

// ③ 同一个人另外一段 1:1（删前一段不能把它带走）+ 一段被「不显示」的（不出现在列表，但聊天记录里要能看到）
const sibling = store.createConversation({ title: '和 波哥', personaId: dev.id });
store.addMessage({ conversationId: sibling.id, role: 'user', text: '另一段活' });
const hidden = store.createConversation({ title: '和 波哥', personaId: dev.id });
store.addMessage({ conversationId: hidden.id, role: 'user', text: '这段被收起来了' });
store.hideConversation(hidden.id);

// ④ 工单会话 / 群（都不许从这条接口删）
const execConv = store.ensureExecConversation({ personaId: dev.id, scope: 'task:smoke', title: '任务 · A', projectId: proj.id });
const groupConv = store.createGroup({ title: '测试群', assistantPersonaId: dev.id, memberIds: [] });

/* ------------------------------------------------- ① 标题自命名（P1-1） */
console.log('① 首条用户消息顺手把默认标题改成那句话的前 20 字');
check(
  '「和 X」被改成消息前 20 字',
  store.getConversation(doomed.id)?.title === '把首页那句文案改掉，顺便把按钮颜色也换一下'.slice(0, 20),
  String(store.getConversation(doomed.id)?.title),
);
store.addMessage({ conversationId: sibling.id, role: 'user', text: '第二句不该再改标题' });
check('后续消息不再改标题', store.getConversation(sibling.id)?.title === '另一段活', String(store.getConversation(sibling.id)?.title));
store.addMessage({ conversationId: execConv.id, role: 'user', text: '工单会话里说的话' });
check('exec 会话的标题不被覆盖', store.getConversation(execConv.id)?.title === '任务 · A', String(store.getConversation(execConv.id)?.title));

/* ---------------------------------------- ② 没有「聊天记录」专用接口（v1.1） */
console.log('\n② 聊天记录用 /api/state 现成数据（v1.1 已砍掉专用接口）');
/*
 * 这一条是**反向断言**：PRD v1.1 明确不要 `GET /api/personas/:id/conversations`
 * （`listConversations` 是热路径兼工作台数据源，不为一处展示改契约）。
 * 前端改为从 `S.conversations` 按 personaId 过滤。这里钉住"这条路由不该存在"，
 * 免得以后有人"顺手加回来"—— 加了就得有人负责它的回归面。
 */
check('store 里没有 listDirectConversationsOfPersona（不新增只读接口）',
  typeof store.listDirectConversationsOfPersona === 'undefined');

/* ------------------------------------------------------ ③ 删除（store 层） */
console.log('\n③ 物理删除：会话 / 消息 / 运行 / 运行事件一并抹掉');
const before = await openDb();
const runIdsBefore = before
  .prepare('SELECT id FROM runs WHERE conversationId = ?')
  .all(doomed.id)
  .map((r) => r.id);
check('删前有 1 次运行', runIdsBefore.length === 1, runIdsBefore.join(','));
before.close();

const r1 = store.deleteConversation(doomed.id);
check('删除成功', r1.ok === true && r1.changes === 1, JSON.stringify(r1));

const db1 = await openDb();
check('conversations 里没有它了', countOf(db1, 'SELECT COUNT(*) c FROM conversations WHERE id = ?', doomed.id) === 0);
check('messages 清零', countOf(db1, 'SELECT COUNT(*) c FROM messages WHERE conversationId = ?', doomed.id) === 0);
check('runs 清零', countOf(db1, 'SELECT COUNT(*) c FROM runs WHERE conversationId = ?', doomed.id) === 0);
// ⚠️ 按**删前存下的 runId 清单**查，不是按 conversationId 子查询 —— 后者在 runs 没了之后恒为 0，验不出东西
const evtLeft = runIdsBefore.reduce(
  (n, rid) => n + countOf(db1, 'SELECT COUNT(*) c FROM run_events WHERE runId = ?', rid),
  0,
);
check('run_events 清零（按删前的 runId 清单查）', evtLeft === 0, String(evtLeft));
check('member_sessions 无该 threadId', countOf(db1, 'SELECT COUNT(*) c FROM member_sessions WHERE threadId = ?', doomed.id) === 0);
check('thread_members 无该 threadId', countOf(db1, 'SELECT COUNT(*) c FROM thread_members WHERE threadId = ?', doomed.id) === 0);

console.log('\n④ 别人的行必须留着，只是不再指向这段会话');
const cardAfter = rowOf(db1, 'SELECT * FROM project_tasks WHERE id = ?', card.id);
check('项目任务卡还在', !!cardAfter, card.id);
check('任务卡的 conversationId 变 NULL', cardAfter?.conversationId === null, String(cardAfter?.conversationId));
const wtAfter = rowOf(db1, 'SELECT * FROM workflow_tasks WHERE id = ?', wfTask.id);
check('流程办理记录还在', !!wtAfter, wfTask.id);
check('办理记录的 conversationId 变 NULL', wtAfter?.conversationId === null, String(wtAfter?.conversationId));
const wsAfter = rowOf(db1, 'SELECT * FROM workflow_steps WHERE id = ?', wfStep.id);
check('流程步骤还在', !!wsAfter, wfStep.id);
check('步骤的 conversationId 变 NULL', wsAfter?.conversationId === null, String(wsAfter?.conversationId));
const wfRunAfter = rowOf(db1, 'SELECT * FROM workflow_runs WHERE id = ?', wfRun.id);
check('流程实例还在', !!wfRunAfter, wfRun.id);
check('流程实例的 threadId 变 NULL', wfRunAfter?.threadId === null, String(wfRunAfter?.threadId));
check(
  'node_jobs 保持不动（远程执行台账，不连带删）',
  countOf(db1, 'SELECT COUNT(*) c FROM node_jobs WHERE id = ?', nodeJob.id) === 1,
  nodeJob.id,
);
db1.close();

console.log('\n⑤ 同一人的其它会话不受影响');
check('兄弟会话还在', !!store.getConversation(sibling.id));
check('被隐藏的那段还在（删除不等于清归档）', !!store.getConversation(hidden.id));

/* --------------------------------------- ⑥ 事务边界（会真的回滚一次） */
console.log('\n⑥ 事务边界：中途失败必须**整体回滚**（不是"顺序写对了就行"）');
/*
 * 怎么证：给 `conversations` 挂一个 BEFORE DELETE 触发器，让它 RAISE(ABORT) ——
 * 于是事务里最后那条 `DELETE FROM conversations` 必然失败。此时**前面几条 DELETE
 * （run_events / runs / messages…）都已经执行过了**，如果事务边界有洞，它们就留在库里成了半删。
 * 所以断言"消息 / 运行 / 运行事件一条没少"就是 ROLLBACK 的直接证据。
 *
 * 触发器建在**另一个写连接**上（store 不导出 db，这里也不该为了测试去改它）。
 */
const rw = await (async () => {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(process.env.BANDI_DB);
})();
const rollbackConv = store.createConversation({ title: '和 波哥', personaId: dev.id });
store.addMessage({ conversationId: rollbackConv.id, role: 'user', text: '这段要验回滚' });
const rollbackRun = store.createRun({ conversationId: rollbackConv.id, runtime: 'codex', personaId: dev.id });
store.appendRunEvent(rollbackRun.id, 1, { type: 'text', text: '会留下的一条事件' });
store.finishRun(rollbackRun.id, { status: '完成', exitCode: 0 });

let boom = null;
try {
  rw.exec("CREATE TRIGGER smoke_block_del BEFORE DELETE ON conversations BEGIN SELECT RAISE(ABORT, 'smoke: 故意失败'); END");
  try {
    store.deleteConversation(rollbackConv.id);
  } catch (e) {
    boom = e;
  }
} finally {
  try { rw.exec('DROP TRIGGER IF EXISTS smoke_block_del'); } catch { /* 没建成 */ }
  rw.close();
}
check('删除确实失败并抛了出来（不是静默成功）', !!boom, String(boom?.message ?? ''));
const dbRb = await openDb();
check('会话还在', countOf(dbRb, 'SELECT COUNT(*) c FROM conversations WHERE id = ?', rollbackConv.id) === 1);
check('消息还在（回滚了，没半删）',
  countOf(dbRb, 'SELECT COUNT(*) c FROM messages WHERE conversationId = ?', rollbackConv.id) === 1);
check('运行还在（回滚了）',
  countOf(dbRb, 'SELECT COUNT(*) c FROM runs WHERE conversationId = ?', rollbackConv.id) === 1);
check('运行事件还在（回滚了）',
  countOf(dbRb, 'SELECT COUNT(*) c FROM run_events WHERE runId = ?', rollbackRun.id) === 1);
dbRb.close();
// 触发器摘掉之后再删一次：应该干净成功（证明上一轮的失败只是触发器造成的，不是别的毛病）
const retry = store.deleteConversation(rollbackConv.id);
check('摘掉触发器后同一段能正常删掉', retry.ok === true && retry.changes === 1, JSON.stringify(retry));

/* -------------------------------------------------------- ⑦ 拒绝的两条路 */
console.log('\n⑦ 拒绝：不存在 / 工单会话 / 还在跑 —— 且**零写入**');
const miss = store.deleteConversation('c-不存在');
check('不存在的会话 → why=not-found', miss.ok === false && miss.why === 'not-found', JSON.stringify(miss));

const db2 = await openDb();
const execRows = countOf(db2, 'SELECT COUNT(*) c FROM conversations WHERE id = ?', execConv.id);
db2.close();

const rExec = store.deleteConversation(execConv.id);
check(
  '工单会话不能这样删 → why=not-deletable（群现在可以删了）',
  rExec.ok === false && rExec.why === 'not-deletable',
  JSON.stringify(rExec),
);

const busyConv = store.createConversation({ title: '和 波哥', personaId: dev.id });
store.addMessage({ conversationId: busyConv.id, role: 'user', text: '这段一直在跑' });
const busyRun = store.createRun({ conversationId: busyConv.id, runtime: 'codex', personaId: dev.id });
const db3 = await openDb();
const busyMsgs = countOf(db3, 'SELECT COUNT(*) c FROM messages WHERE conversationId = ?', busyConv.id);
const busyRuns = countOf(db3, 'SELECT COUNT(*) c FROM runs WHERE conversationId = ?', busyConv.id);
db3.close();
const rBusy = store.deleteConversation(busyConv.id);
check('跑中 → why=running，并带上 runId', rBusy.ok === false && rBusy.why === 'running' && rBusy.runId === busyRun.id, JSON.stringify(rBusy));

const db4 = await openDb();
check('拒绝路径不写库：exec 会话还在', countOf(db4, 'SELECT COUNT(*) c FROM conversations WHERE id = ?', execConv.id) === execRows);
check('拒绝路径不写库：跑中那段的消息一条没少',
  countOf(db4, 'SELECT COUNT(*) c FROM messages WHERE conversationId = ?', busyConv.id) === busyMsgs);
check('拒绝路径不写库：跑中那段 runs 一行没少',
  countOf(db4, 'SELECT COUNT(*) c FROM runs WHERE conversationId = ?', busyConv.id) === busyRuns);
db4.close();

// 收尾：把这段跑中的运行结掉，别让后面的接口用例被它挡住
store.finishRun(busyRun.id, { status: '已停止', exitCode: 1 });

/* ------------------------- ⑦b 群会话可以删（2026-10-20 新口径：删**这段**，不是删群） */
console.log('\n⑦b 群会话删除：删一段只没这一段，群/成员/别的段不动；删到零段群才一并收掉');
const dev2 = store.createPersona({ name: '群员甲', runtime: 'codex' });
const delGroup = store.createGroup({ title: '待删群', assistantPersonaId: dev.id, memberIds: [dev2.id] });
store.addMessage({ conversationId: delGroup.id, role: 'user', text: '第一段的话' });
const groupRun = store.createRun({ conversationId: delGroup.id, runtime: 'codex', personaId: dev.id });
store.finishRun(groupRun.id, { status: '完成', exitCode: 0 });
// 这个群的第二段会话（删第一段不能把它带走）
const groupSeg2 = store.createGroupSession(delGroup.groupId ?? delGroup.id);
store.addMessage({ conversationId: groupSeg2.id, role: 'user', text: '第二段的话' });
// 成员会话状态（真实链路由 run 建立；这里直接落一行，测的是删除时清不清）
// 注意 `openDb()` 是**只读**连接（专门用来绕开 store 验事实），写夹具要另开一个可写连接
const { DatabaseSync: DatabaseSyncW } = await import('node:sqlite');
const dbW = new DatabaseSyncW(process.env.BANDI_DB);
dbW
  .prepare('INSERT INTO member_sessions (threadId, personaId, scope, sessionId) VALUES (?, ?, ?, ?)')
  .run(delGroup.id, dev2.id, 'smoke', 's-smoke-group');
dbW.close();
const dbG = await openDb();
const gMsgs = countOf(dbG, 'SELECT COUNT(*) c FROM messages WHERE conversationId = ?', delGroup.id);
const gMembers = countOf(dbG, 'SELECT COUNT(*) c FROM thread_members WHERE threadId = ?', delGroup.id);
const gSessions = countOf(dbG, 'SELECT COUNT(*) c FROM member_sessions WHERE threadId = ?', delGroup.id);
const gRows = countOf(dbG, 'SELECT COUNT(*) c FROM groups WHERE id = ?', delGroup.groupId ?? delGroup.id);
dbG.close();
check('夹具齐了（有消息/成员/成员会话/运行/群行，共两段）', gMsgs > 0 && gMembers > 0 && gSessions > 0 && gRows === 1, `${gMsgs}/${gMembers}/${gSessions}/${gRows}`);

const rDelGroup = store.deleteConversation(delGroup.id);
check('群会话可以删 → ok, changes=1', rDelGroup.ok === true && rDelGroup.changes === 1, JSON.stringify(rDelGroup));

const dbG2 = await openDb();
const gid = delGroup.groupId ?? delGroup.id;
check('被删的那段没了', countOf(dbG2, 'SELECT COUNT(*) c FROM conversations WHERE id = ?', delGroup.id) === 0);
check('那段的消息清零', countOf(dbG2, 'SELECT COUNT(*) c FROM messages WHERE conversationId = ?', delGroup.id) === 0);
check('那段的成员关系清零', countOf(dbG2, 'SELECT COUNT(*) c FROM thread_members WHERE threadId = ?', delGroup.id) === 0);
check('那段的成员会话状态清零', countOf(dbG2, 'SELECT COUNT(*) c FROM member_sessions WHERE threadId = ?', delGroup.id) === 0);
check('那段的运行清零', countOf(dbG2, 'SELECT COUNT(*) c FROM runs WHERE conversationId = ?', delGroup.id) === 0);
check('那段的运行事件清零', countOf(dbG2, 'SELECT COUNT(*) c FROM run_events WHERE runId = ?', groupRun.id) === 0);
check('**群还在**（groups 行没动）', countOf(dbG2, 'SELECT COUNT(*) c FROM groups WHERE id = ?', gid) === 1);
check('**成员名单还在**（group_members 没动：群助手+群员甲 = 2 行）', countOf(dbG2, 'SELECT COUNT(*) c FROM group_members WHERE groupId = ?', gid) === 2);
check('**第二段还在**，消息原样', countOf(dbG2, 'SELECT COUNT(*) c FROM conversations WHERE groupId = ?', gid) === 1 &&
  countOf(dbG2, 'SELECT COUNT(*) c FROM messages WHERE conversationId = ?', groupSeg2.id) === 1);
check('别的群不受影响', countOf(dbG2, 'SELECT COUNT(*) c FROM conversations WHERE id = ?', groupConv.id) === 1);
dbG2.close();

// 删到**零段** → 群仍然在（2026-10-20 用户报「通讯录里群也没了」：
// 群是容器，通讯录读 groups 表，容器不该因为片段删光就消失）
const rDelLast = store.deleteConversation(groupSeg2.id);
const dbG3 = await openDb();
check('最后一段也能删', rDelLast.ok === true && rDelLast.changes === 1, JSON.stringify(rDelLast));
check('零段后：**群还在**（groups 行不动）', countOf(dbG3, 'SELECT COUNT(*) c FROM groups WHERE id = ?', gid) === 1);
check('零段后：**成员名单还在**', countOf(dbG3, 'SELECT COUNT(*) c FROM group_members WHERE groupId = ?', gid) === 2);
check('零段后：会话清零', countOf(dbG3, 'SELECT COUNT(*) c FROM conversations WHERE groupId = ?', gid) === 0);
dbG3.close();
// 零段的群照样能继续用（通讯录 → 群详情 → 发消息 = 开新的一段）
const reopened = store.createGroupSession(gid);
check('零段群还能开新一段（容器还在就能继续用）', !!reopened && reopened.groupId === gid, String(reopened?.id));

/* ------------------------------------------------------------- ⑦ 走接口 */
console.log("\n⑧ 接口（真起一次服务端）");
// 接口用例各用一段干净数据，别互相踩
const apiDirect = store.createConversation({ title: '和 波哥', personaId: dev.id });
store.addMessage({ conversationId: apiDirect.id, role: 'user', text: '接口要删的这段' });
const apiExec = store.ensureExecConversation({ personaId: dev.id, scope: 'task:api', title: '任务 · B', projectId: proj.id });
const apiBusy = store.createConversation({ title: '和 波哥', personaId: dev.id });
store.addMessage({ conversationId: apiBusy.id, role: 'user', text: '接口要拒的这段' });
/*
 * ⚠️ 「跑中」这条 run **不能在这里造**：server 启动时会跑 `reapStaleRuns()`
 * （运行状态在内存里，进程一死库里那行还写着「跑中」，所以每次启动先把残留判死）。
 * 造在 spawn 之前 → 一启动就被判死 → 接口会照删成功，验不到 409。
 * 所以挪到「服务端起来了」之后再 createRun。
 */
let apiBusyRun = null;

const logPath = path.join(tmp, 'server.log');
const logFd = fs.openSync(logPath, 'a');

/*
 * ⚠️ 起服务**之前**先探一次端口：本机要是有别的班底实例（或上一轮没杀干净的）占着这个端口，
 * 下面的探活会"成功"，但所有请求打的是**别人家的库** —— 于是整段接口用例全绿/全红都是假的
 * （2026-10-20 真踩过：上一轮的后台实例占着 8797，结果是 9 条莫名其妙的 404）。
 */
let portBusy = false;
try {
  await fetch(BASE + '/api/state', { signal: AbortSignal.timeout(800) });
  portBusy = true;
} catch { /* 连不上才是对的 */ }
if (portBusy) {
  console.log(`✗ 端口 ${PORT} 上已经有一个班底实例在跑 —— 先把它关掉再跑本脚本（否则测的是别人家的库）`);
  process.exit(1);
}

const child = spawn(process.execPath, [path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs')], {
  cwd: repoRoot,
  env: { ...process.env, BANDI_PORT: String(PORT), BANDI_DB: process.env.BANDI_DB },
  windowsHide: true,
  stdio: ['ignore', logFd, logFd],
});
fs.closeSync(logFd);
const api = async (p, opts) => {
  // 不带 Origin = 命令行调用方，走源守卫的放行分支（同其它冒烟脚本）
  const res = await fetch(BASE + p, opts);
  return { status: res.status, body: await res.json().catch(() => null) };
};

try {
  let up = false;
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(BASE + '/api/state')).ok) { up = true; break; } } catch { /* 还没起 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  check('服务端起来了', up);

  // 起来之后再造这条「跑中」的 run（见上面 apiBusyRun 那段注释：造早了会被启动清账判死）
  apiBusyRun = store.createRun({ conversationId: apiBusy.id, runtime: 'codex', personaId: dev.id });

  const del = await api(`/api/conversations/${encodeURIComponent(apiDirect.id)}`, { method: 'DELETE' });
  check('删 1:1 → 200', del.status === 200, `${del.status} ${JSON.stringify(del.body?.code ?? '')}`);
  check('回 deleted:true', del.body?.deleted === true);
  check('回整份 conversations（前端直接换 S.conversations）', Array.isArray(del.body?.conversations));
  check('回里的会话表已剔除它', !(del.body?.conversations ?? []).some((c) => c.id === apiDirect.id));
  check('回 hiddenConversations（聊天记录抽屉要用）', Array.isArray(del.body?.hiddenConversations),
    String(del.body?.hiddenConversations?.length));

  const again = await api(`/api/conversations/${encodeURIComponent(apiDirect.id)}`, { method: 'DELETE' });
  check('再删一次 → 404 + E2047（不是 500）', again.status === 404 && again.body?.code === 'E2047',
    `${again.status} ${again.body?.code}`);

  /*
   * 回看（GET）一段已经没了的会话，必须给**同一个码** E2047：
   * 前端 `openConversationSafe` 就是靠它认出"这段被另一个窗口删了"，
   * 好收拾右栏 + 说人话（设计 §5.6.1 路径 2/3）。GET 与 DELETE 给两个码会让人漏写一条映射。
   */
  const getGone = await api(`/api/conversations/${encodeURIComponent(apiDirect.id)}`);
  check('回看已删的会话 → 404 + E2047（与删除同码）', getGone.status === 404 && getGone.body?.code === 'E2047',
    `${getGone.status} ${getGone.body?.code}`);

  /*
   * 改（PUT）同一个已删的 id，也必须给**同一个码 + 同一句人话**（设计 §4.1.1 三处 404 同码）。
   *
   * 这一条同时守两件事：
   * ① **码没回退** —— 谁哪天把它改回 `E2003`，这里立刻红；
   * ② **文案没回退** —— 产品要求 `PUT` 的 404 与 `GET` 说同一句话（「这段会话已经不在了」），
   *    只断言码挡不住"码对、文案又被改回「会话不存在」"这种半拉子回归。
   *
   * 必须带 body：这个接口在**查会话存在性之前**先校验"有没有说要改哪一项"
   * （没有就 `E1037` 400），空 body 根本走不到 404 —— 不带 `sandbox`/`model` 测到的是 400。
   */
  const putGone = await api(`/api/conversations/${encodeURIComponent(apiDirect.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sandbox: 'read-only' }),
  });
  check('改已删的会话 → 404 + E2047（不是 E2003）', putGone.status === 404 && putGone.body?.code === 'E2047',
    `${putGone.status} ${putGone.body?.code}`);
  check('PUT 的 404 文案与 GET 一致（含「已经不在了」）', /已经不在了/.test(String(putGone.body?.error ?? '')),
    String(putGone.body?.error ?? ''));

  const notDirect = await api(`/api/conversations/${encodeURIComponent(apiExec.id)}`, { method: 'DELETE' });
  check('删 exec → 400 + E1050（不是 500）', notDirect.status === 400 && notDirect.body?.code === 'E1050',
    `${notDirect.status} ${notDirect.body?.code}`);
  check('E1050 的中文说明指向任务卡 / 流程（群里不再出现在这句里）',
    /任务卡|流程/.test(String(notDirect.body?.error ?? '')) && !/群/.test(String(notDirect.body?.error ?? '')),
    String(notDirect.body?.error ?? ''));

  const running = await api(`/api/conversations/${encodeURIComponent(apiBusy.id)}`, { method: 'DELETE' });
  check('删跑中 → 409 + E4002（不是 500）', running.status === 409 && running.body?.code === 'E4002',
    `${running.status} ${running.body?.code}`);
  check('E4002 带回 runId', running.body?.runId === apiBusyRun.id, String(running.body?.runId));

  const db5 = await openDb();
  check('接口拒绝后跑中那段数据完整（消息还在）',
    countOf(db5, 'SELECT COUNT(*) c FROM messages WHERE conversationId = ?', apiBusy.id) === 1);
  check('接口拒绝后跑中那段数据完整（runs 还在）',
    countOf(db5, 'SELECT COUNT(*) c FROM runs WHERE conversationId = ?', apiBusy.id) === 1);
  db5.close();
  store.finishRun(apiBusyRun.id, { status: '已停止', exitCode: 1 });

  /*
   * 反向断言：v1.1 砍掉了「聊天记录」专用接口，前端改从 `/api/state` 的
   * `conversations` 过滤。这里钉住"它没被顺手加回来"，同时确认 `/api/state`
   * 那份数据本身够用（direct 会话的 title/updatedAt/lastMessage 都在）。
   */
  const peopleLog = await api(`/api/personas/${encodeURIComponent(dev.id)}/conversations`);
  check('没有 GET /api/personas/:id/conversations（v1.1 已砍）', peopleLog.status === 404, String(peopleLog.status));

  const state = (await api('/api/state')).body;
  const myDirect = (state?.conversations ?? []).filter((c) => c.kind === 'direct' && c.personaId === dev.id);
  check('/api/state 里有这个人的 direct 会话，可直接过滤出聊天记录', myDirect.length >= 1, String(myDirect.length));
  check('过滤出来的行够画（title / updatedAt / lastMessage 都在）',
    myDirect.every((c) => 'title' in c && 'updatedAt' in c && 'lastMessage' in c));
  check('被隐藏的那段不在 /api/state 里（筛未隐藏天然成立）',
    !(state?.conversations ?? []).some((c) => c.id === hidden.id));
  check('刚删掉的那段也不在 /api/state 里', !(state?.conversations ?? []).some((c) => c.id === apiDirect.id));

  /*
   * 通讯录的群列表**读 /api/state 的 groups**（2026-10-20 用户报「通讯录里群也没了」）。
   * 关键一条：**零段会话的群也在**——群是容器，不该因为片段删光就从通讯录消失。
   */
  const zeroSegGroup = store.createGroup({ title: '零段群', assistantPersonaId: dev.id, memberIds: [] });
  store.deleteConversation(zeroSegGroup.id);
  const state2 = await (await fetch(BASE + '/api/state')).json();
  const g0 = (state2.groups ?? []).find((g) => g.id === zeroSegGroup.groupId);
  check('/api/state 带 groups（通讯录群列表的来源，不再从会话推）', Array.isArray(state2.groups), String((state2.groups ?? []).length));
  check('零段会话的群也在 groups 里（通讯录不会"群消失"）', !!g0, String(g0?.title));
  check('群行的 memberCount 取 group_members（助手 1 人）', g0?.memberCount === 1, String(g0?.memberCount));

  /*
   * ⑨「不显示」的新语义（2026-10-20 去掉会话归档）：
   *   · 收起来的那段不在 conversations 里；
   *   · 但必须出现在 hiddenConversations 里 —— 否则「聊天记录」就看不到它了，
   *     而这正是用户要的："列表不显示，聊天记录列表要可以看到"；
   *   · 归档入口与恢复入口都已删除（/api/archived、/unhide 都得 404）。
   */
  const hid = await api(`/api/conversations/${encodeURIComponent(sibling.id)}/hide`, { method: 'POST' });
  check('不显示 → 200', hid.status === 200, String(hid.status));
  const st2 = (await api('/api/state')).body;
  check('不显示之后：不在 conversations 里',
    !(st2?.conversations ?? []).some((c) => c.id === sibling.id));
  check('不显示之后：仍在 hiddenConversations 里（聊天记录看得到）',
    (st2?.hiddenConversations ?? []).some((c) => c.id === sibling.id));
  check('隐藏的那份带 hidden:true 标记',
    (st2?.hiddenConversations ?? []).find((c) => c.id === sibling.id)?.hidden === true);

  const arch = await api('/api/archived');
  check('没有 GET /api/archived（归档功能已去掉）', arch.status === 404, String(arch.status));
  const un = await api(`/api/conversations/${encodeURIComponent(sibling.id)}/unhide`, { method: 'POST' });
  check('没有 POST /unhide（恢复入口已去掉）', un.status === 404, String(un.status));

  /*
   * ⑩ 删员工**不再归档**：他的会话留在消息列表里（只读），不写 hiddenAt。
   * 用户 2026-10-20 明确要求的边界 —— 写死在这里，防止以后有人"顺手归档"。
   */
  const tmpPersona = store.createPersona({ name: '待删员工', runtime: 'codex' });
  const tmpConv = store.createConversation({ title: '和 待删员工', personaId: tmpPersona.id });
  store.addMessage({ conversationId: tmpConv.id, role: 'user', text: '说一句' });
  const delPersona = await api(`/api/personas/${encodeURIComponent(tmpPersona.id)}`, { method: 'DELETE' });
  check('删员工 → 200', delPersona.status === 200, String(delPersona.status));
  const st3 = (await api('/api/state')).body;
  const kept = (st3?.conversations ?? []).find((c) => c.id === tmpConv.id);
  check('删员工后他的会话仍在消息列表里（不再归档）', !!kept, kept ? 'kept' : 'missing');
  check('删员工后会话没被隐藏', !(st3?.hiddenConversations ?? []).some((c) => c.id === tmpConv.id));
  check('删员工后标题里还认得出是谁', String(kept?.title ?? '').includes('待删员工'), String(kept?.title ?? ''));

  /*
   * ⑪ 员工已删的**单聊**：删除 = **清空这个人的全部历史**（2026-10-20 用户定稿）。
   *
   * 病根：`deletePersona` 保留会话（记录可能有用），于是列表里那行「和 某某」代表的是
   * 这个人的**一整档历史** —— 他可能有好几段（换过 runtime、被「不显示」过又翻出来）。
   * 只删一段的话，剩下的段还躺在「已归档」/ 抽屉里，而他已经没有任何入口了，
   * 没人会想起来去点 —— 那就是"看不见的冗余数据"。
   * 后端按"人还在不在"分派到 `purgePersonaHistory`，一个事务全清。
   */
  console.log('\n⑪ 员工已删 → 删除单聊 = 清空他**全部**聊天记录（不是只删这一段）');
  const goneEmp = store.createPersona({ name: '已走的人', runtime: 'codex' });
  const goneA = store.createConversation({ title: '和 已走的人', personaId: goneEmp.id });
  store.addMessage({ conversationId: goneA.id, role: 'user', text: '第一段' });
  const goneRun = store.createRun({ conversationId: goneA.id, runtime: 'codex', personaId: goneEmp.id });
  store.appendRunEvent(goneRun.id, 1, { type: 'text', text: '干过的活' });
  store.finishRun(goneRun.id, { status: '完成', exitCode: 0 });
  const goneB = store.createConversation({ title: '和 已走的人', personaId: goneEmp.id });
  store.addMessage({ conversationId: goneB.id, role: 'user', text: '第二段' });
  const goneC = store.createConversation({ title: '和 已走的人', personaId: goneEmp.id });
  store.addMessage({ conversationId: goneC.id, role: 'user', text: '第三段（被不显示了）' });
  store.hideConversation(goneC.id);

  await api(`/api/personas/${encodeURIComponent(goneEmp.id)}`, { method: 'DELETE' });
  const stGone = (await api('/api/state')).body;
  const segsGone = (stGone?.conversations ?? []).filter((c) => c.personaId === goneEmp.id).length +
    (stGone?.hiddenConversations ?? []).filter((c) => c.personaId === goneEmp.id).length;
  check('删员工后三段都还在（记录保留，人没了 ≠ 记录没了）', segsGone === 3, String(segsGone));

  // 同事（波哥）的会话数，做完清档要一比一比对
  const devConvsBefore = (stGone?.conversations ?? []).filter((c) => c.kind === 'direct' && c.personaId === dev.id).length +
    (stGone?.hiddenConversations ?? []).filter((c) => c.kind === 'direct' && c.personaId === dev.id).length;

  /*
   * 他名下**还有一段在跑** → 删另一段也得整体拒绝：清档是"这一整档一起没"，
   * 允许一部分先删就会出现"删了一半的历史"，那比不删更让人困惑。
   */
  const goneBusyRun = store.createRun({ conversationId: goneB.id, runtime: 'codex', personaId: dev.id });
  const refused = await api(`/api/conversations/${encodeURIComponent(goneA.id)}`, { method: 'DELETE' });
  check('他还有一段在跑 → 删另一段也被拒（409 + E4002）', refused.status === 409 && refused.body?.code === 'E4002',
    `${refused.status} ${refused.body?.code}`);
  check('E4002 带的是**跑中那一段**的 runId', refused.body?.runId === goneBusyRun.id, String(refused.body?.runId));

  const dbR = await openDb();
  const goneLeft = countOf(dbR, "SELECT COUNT(*) c FROM conversations WHERE kind = 'direct' AND personaId = ?", goneEmp.id);
  dbR.close();
  check('拒绝路径零写入：三段一段没少', goneLeft === 3, String(goneLeft));
  store.finishRun(goneBusyRun.id, { status: '已停止', exitCode: 1 });

  const wipe = await api(`/api/conversations/${encodeURIComponent(goneA.id)}`, { method: 'DELETE' });
  check('跑完之后删任一段 → 200', wipe.status === 200, `${wipe.status} ${JSON.stringify(wipe.body?.code ?? '')}`);
  check('回里的 conversations 一段都不剩',
    !(wipe.body?.conversations ?? []).some((c) => c.personaId === goneEmp.id));
  check('回里的 hiddenConversations 也不剩（"看不见的冗余"必须一起清）',
    !(wipe.body?.hiddenConversations ?? []).some((c) => c.personaId === goneEmp.id));

  const dbW2 = await openDb();
  check('库里三段全没了',
    countOf(dbW2, "SELECT COUNT(*) c FROM conversations WHERE kind = 'direct' AND personaId = ?", goneEmp.id) === 0);
  const msgLeft = [goneA, goneB, goneC].reduce(
    (n, c) => n + countOf(dbW2, 'SELECT COUNT(*) c FROM messages WHERE conversationId = ?', c.id),
    0,
  );
  check('三段的消息全清零', msgLeft === 0, String(msgLeft));
  check('运行清零', countOf(dbW2, 'SELECT COUNT(*) c FROM runs WHERE conversationId = ?', goneA.id) === 0);
  // ⚠️ 运行事件按**删前存下的 runId** 查（子查询在 runs 没了之后恒为 0，验不出东西）
  check('运行事件清零', countOf(dbW2, 'SELECT COUNT(*) c FROM run_events WHERE runId = ?', goneRun.id) === 0);
  dbW2.close();

  const stAfter = (await api('/api/state')).body;
  const devConvsAfter = (stAfter?.conversations ?? []).filter((c) => c.kind === 'direct' && c.personaId === dev.id).length +
    (stAfter?.hiddenConversations ?? []).filter((c) => c.kind === 'direct' && c.personaId === dev.id).length;
  check('别人的单聊一段没动（清档只针对这一个人）', devConvsAfter === devConvsBefore, `${devConvsBefore} → ${devConvsAfter}`);
} catch (err) {
  check('接口这一段没跑挂', false, String(err?.message ?? err));
} finally {
  try { child.kill(); } catch { /* 已经退了 */ }
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录 */ }
console.log(`\n结论：${failed ? '有 ' + failed + ' 项没通过' : '全通过'}`);
process.exit(failed ? 1 : 0);
