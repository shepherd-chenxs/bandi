/**
 * 群解散 · 后端验收（2026-10-20 用户定：解散后消息**仍留在消息列表里**、只读）。
 *
 * 验的几条：
 *   · 解散**不抹记录**：每段会话的消息、runs 都还在；
 *   · 解散**不再把会话设成「不显示」**：它们照旧出现在 listConversations 里（所以消息列表看得到），
 *     原来就被「不显示」的那段保持隐藏（不因为解散被重新翻出来）；
 *   · 群打上 dissolvedAt，通讯录的 `listGroups()` 不再列它（那边只列还能用的群）；
 *   · 成员关系与 thread_members 清空（「没 @ 就找群助手」这条规则必须失效）；
 *   · 前端兜底：发消息接口对已解散的会话回 409 + E2049（否则 dispatcher 找不到人，表现成"点了没反应"）。
 *
 * 隔离：临时数据库 / 临时数据目录 / 临时端口 —— 不碰真账。
 * 跑法：node apps/server/src/smoke-group-dissolve.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.SMOKE_PORT ?? 8796);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-dissolve-'));
process.env.BANDI_DATA = tmp;
process.env.BANDI_DB = path.join(tmp, 'bandi.db');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

// ⚠️ 必须先设 BANDI_DB 再动态 import 读 config 的模块（静态 import 会在第一行就求值）
const { dbPath } = await import('./config.mjs');
const store = await import('./store.mjs');

if (!path.resolve(dbPath).toLowerCase().startsWith(path.resolve(tmp).toLowerCase())) {
  console.log(`✗ 临时库没生效：dbPath=${dbPath} 不在 ${tmp} 下 —— 拒绝继续（避免写进真库）`);
  process.exit(1);
}
console.log(`（隔离自检：dbPath=${dbPath}）`);

const openDb = async () => {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(process.env.BANDI_DB, { readOnly: true });
};
const countOf = (db, sql, ...args) => db.prepare(sql).get(...args).c;

/* ---------------------------------------------------------------- 造数据 */
const projRoot = path.join(tmp, 'proj');
fs.mkdirSync(projRoot, { recursive: true });
const dev = store.createPersona({ name: '群助手甲', runtime: 'codex', cwd: projRoot });
const dev2 = store.createPersona({ name: '群员乙', runtime: 'codex', cwd: projRoot });

const g = store.createGroup({ title: '待解散群', assistantPersonaId: dev.id, memberIds: [dev2.id] });
const gid = g.groupId;
const seg1 = g.id;
store.addMessage({ conversationId: seg1, role: 'user', text: '第一段：说句话' });
const run1 = store.createRun({ conversationId: seg1, runtime: 'codex', personaId: dev.id });
store.finishRun(run1.id, { status: '完成', exitCode: 0 });

const seg2 = store.createGroupSession(gid).id;
store.addMessage({ conversationId: seg2, role: 'user', text: '第二段：也说一句' });

// 一段**本来就「不显示」**的：解散不该把它翻出来。
// ⚠️ 不能调 store.hideConversation：那是**整群一起隐**（2026-10-20 的口径），会把 seg1/seg2 也隐掉。
// 这里直接改库造"单段隐藏"的历史状态（老数据里可能就有），验的是解散时不要顺手清 hiddenAt。
const seg3 = store.createGroupSession(gid).id;
store.addMessage({ conversationId: seg3, role: 'user', text: '这段收起来了' });
{
  const { DatabaseSync: W } = await import('node:sqlite');
  const w = new W(process.env.BANDI_DB);
  w.prepare('UPDATE conversations SET hiddenAt = ? WHERE id = ?').run(new Date().toISOString(), seg3);
  w.close();
}

/* --------------------------------------------------- ① 解散前：三段的可见性 */
console.log('① 解散前：两段可见、一段隐藏');
let list = store.listConversations().filter((c) => c.groupId === gid);
check('可见的是 2 段（seg3 被「不显示」）', list.length === 2 && list.every((c) => c.id !== seg3), String(list.map((c) => c.id).join(',')));
check('解散前没有 dissolvedAt', list.every((c) => !c.dissolvedAt));

/* --------------------------------------------------- ② 解散 */
console.log('\n② 解散：不打 hiddenAt、打 dissolvedAt、清成员关系');
store.dissolveGroup(gid);
list = store.listConversations().filter((c) => c.groupId === gid);
check('**两段照旧在列表里**（解散 ≠ 收走）', list.length === 2 && list.some((c) => c.id === seg1) && list.some((c) => c.id === seg2), String(list.map((c) => c.id).join(',')));
check('每段都带 dissolvedAt（前端据此画只读）', list.every((c) => !!c.dissolvedAt));
check('dissolvedAt 是同一个时间点', new Set(list.map((c) => c.dissolvedAt)).size === 1);

const db = await openDb();
check('群本身打了 dissolvedAt', !!db.prepare('SELECT dissolvedAt FROM groups WHERE id = ?').get(gid)?.dissolvedAt);
check('成员名单清空（group_members）', countOf(db, 'SELECT COUNT(*) c FROM group_members WHERE groupId = ?', gid) === 0);
check('会话成员快照清空（thread_members）', countOf(db, 'SELECT COUNT(*) c FROM thread_members WHERE threadId IN (?,?,?)', seg1, seg2, seg3) === 0);
check('群助手置空', db.prepare('SELECT assistantPersonaId FROM groups WHERE id = ?').get(gid)?.assistantPersonaId == null);

console.log('\n③ 记录一条没少、隐藏的那段保持隐藏');
check('三段的消息都在', countOf(db, 'SELECT COUNT(*) c FROM messages WHERE conversationId IN (?,?,?)', seg1, seg2, seg3) === 3);
check('运行记录还在', countOf(db, 'SELECT COUNT(*) c FROM runs WHERE id = ?', run1.id) === 1);
check('seg3 仍然 hiddenAt 非空（不因为解散被翻出来）',
  !!db.prepare('SELECT hiddenAt FROM conversations WHERE id = ?').get(seg3)?.hiddenAt);
check('seg1/seg2 的 hiddenAt 仍是空', !db.prepare('SELECT hiddenAt FROM conversations WHERE id = ?').get(seg1)?.hiddenAt);
db.close();

console.log('\n④ 通讯录只列"还能用"的群（listGroups 不含已解散）');
check('listGroups 里没有它', !store.listGroups().some((x) => x.id === gid));

/* --------------------------------------------------- ④b 清档：解散后的群删除 = 整群清掉 */
console.log('\n④b 解散后的群「删除并清空聊天记录」：所有段 + 群行 + 成员名单一起没');
// 另造一个已解散的群做靶子（上面的 gid 马上要在接口段当对照组）
const g2 = store.createGroup({ title: '清档靶群', assistantPersonaId: dev.id, memberIds: [dev2.id] });
const gid2 = g2.groupId;
store.addMessage({ conversationId: g2.id, role: 'user', text: '要被清掉的话' });
store.dissolveGroup(gid2);
const rWipe = store.deleteConversation(g2.id);   // 对已解散群的任一段调"删除" → 整群清档
check('清档 → ok，changes = 段数（1）', rWipe.ok === true && rWipe.changes === 1, JSON.stringify(rWipe));
const db2 = await openDb();
check('靶群：会话清零', countOf(db2, 'SELECT COUNT(*) c FROM conversations WHERE groupId = ?', gid2) === 0);
check('靶群：消息清零', countOf(db2, 'SELECT COUNT(*) c FROM messages WHERE conversationId = ?', g2.id) === 0);
check('靶群：群行没了', countOf(db2, 'SELECT COUNT(*) c FROM groups WHERE id = ?', gid2) === 0);
check('靶群：成员名单没了', countOf(db2, 'SELECT COUNT(*) c FROM group_members WHERE groupId = ?', gid2) === 0);
check('对照组（只解散未清档的 gid）没被误伤', countOf(db2, 'SELECT COUNT(*) c FROM groups WHERE id = ?', gid) === 1);
db2.close();

/* --------------------------------------------------- ⑤ 接口：发消息被拒 */
console.log('\n⑤ 接口：给已解散的会话发消息 → 409 + E2049（不是"点了没反应"）');
let portBusy = false;
try { await fetch(BASE + '/api/state', { signal: AbortSignal.timeout(800) }); portBusy = true; } catch { /* 连不上才是对的 */ }
if (portBusy) {
  console.log(`✗ 端口 ${PORT} 上已经有一个班底实例在跑 —— 先关掉再跑（否则测的是别人家的库）`);
  process.exit(1);
}
const logFd = fs.openSync(path.join(tmp, 'server.log'), 'a');
const srv = spawn(process.execPath, [path.join(process.cwd(), 'apps/server/src/server.mjs')], {
  env: { ...process.env, BANDI_DATA: tmp, BANDI_PORT: String(PORT) },
  stdio: ['ignore', logFd, logFd],
});
let up = false;
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(BASE + '/api/state')).ok) { up = true; break; } } catch {}
  await new Promise((r) => setTimeout(r, 250));
}
check('服务端起来了', up);

if (up) {
  const r = await fetch(`${BASE}/api/conversations/${encodeURIComponent(seg1)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '解散之后还能说话吗' }),
  });
  const b = await r.json().catch(() => ({}));
  check('发消息 → 409', r.status === 409, String(r.status));
  check('错误码 E2049 + 中文说清"只能查看聊天记录"',
    b.code === 'E2049' && /解散/.test(String(b.error ?? '')) && /只能查看/.test(String(b.error ?? '')),
    `${b.code} ${b.error}`);

  // 未解散的群对照组：接口不该被这条拦截误伤（群里有人 → 会真派活，所以只造一段"空群助手的"
  // 也不行；这里只验 GET 详情仍能读）
  const g2 = await fetch(`${BASE}/api/groups/${encodeURIComponent(gid)}`);
  check('群详情仍可读（记录在，只是解散了）', g2.status === 200, String(g2.status));
}

srv.kill();
try { fs.closeSync(logFd); } catch {}
console.log(`\n结论：${failed ? `有 ${failed} 项没通过` : '全通过'}`);
process.exit(failed ? 1 : 0);
