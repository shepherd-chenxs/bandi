/**
 * 群关联项目 · 后端验收（2026-11-11 用户拍板「一项目一群 + 可空可换」）。
 *
 * 验的几条：
 *   · `groups.projectId` 可空；设/清都走 `updateGroup`，**空串是"解除"不是"没改"**（最易错的一处）；
 *   · `listGroups()`（喂 `/api/state` 的通讯录与群头）带上 projectId；`getGroupByProject()` 能查占用者；
 *   · **一项目一群**：第二个群抢同一个项目 → 409 + E2069，且不给"顶掉"（原群一个字没动）；
 *   · 项目不存在 → 404 + E2068；已解散的群改设置 → 400 + E2050；空 body → 400 + E1039；
 *   · 派活解析：群关联了项目 → 群会话派活自动带上那个 projectId；调用方显式传了 → 显式赢。
 *
 * 隔离：临时数据库 / 临时数据目录 / 临时端口 —— 不碰真账。
 * 跑法：node apps/server/src/smoke-group-project.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.SMOKE_PORT ?? 8797);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-groupproj-'));
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
const { withGroupProject } = await import('./dispatch.mjs');

if (!path.resolve(dbPath).toLowerCase().startsWith(path.resolve(tmp).toLowerCase())) {
  console.log(`✗ 临时库没生效：dbPath=${dbPath} 不在 ${tmp} 下 —— 拒绝继续（避免写进真库）`);
  process.exit(1);
}
console.log(`（隔离自检：dbPath=${dbPath}）`);

/* ---------------------------------------------------------------- 造数据 */
const projRoot = path.join(tmp, 'proj');
fs.mkdirSync(projRoot, { recursive: true });
const projA = store.createProject({ name: '甲项目', root: projRoot });
const projB = store.createProject({ name: '乙项目', root: path.join(tmp, 'proj-b') });

const dev = store.createPersona({ name: '群助手甲', runtime: 'codex', cwd: projRoot });
const dev2 = store.createPersona({ name: '群员乙', runtime: 'codex', cwd: projRoot });

const g1 = store.createGroup({ title: '甲群', assistantPersonaId: dev.id, memberIds: [dev2.id] });
const gid1 = g1.groupId;
const g2 = store.createGroup({ title: '乙群', assistantPersonaId: dev.id, memberIds: [dev2.id] });
const gid2 = g2.groupId;

/* --------------------------------------------------- ① 默认空 */
console.log('① 新建的群默认不关联');
check('getGroup().projectId 是空', !store.getGroup(gid1).projectId);
check('listGroups() 里也带 projectId 这一项', 'projectId' in (store.listGroups().find((x) => x.id === gid1) ?? {}));
check('getGroupByProject(空) 不找人', store.getGroupByProject('') === null);

/* --------------------------------------------------- ② 关联 + 清空 */
console.log('\n② 关联 / 解除（空串是"解除"，不是"没改"）');
store.updateGroup(gid1, { projectId: projA.id });
check('关联后 getGroup 带上了', store.getGroup(gid1).projectId === projA.id);
check('listGroups 同步带上', store.listGroups().find((x) => x.id === gid1)?.projectId === projA.id);
check('getGroupByProject 找到占用群', store.getGroupByProject(projA.id)?.id === gid1);

store.updateGroup(gid1, { title: '甲群改个名' });
check('**没提 projectId 的改动不碰它**（title 改完项目还在）',
  store.getGroup(gid1).projectId === projA.id, String(store.getGroup(gid1).projectId));

store.updateGroup(gid1, { projectId: '' });
check('空串 → 解除，库里是 NULL', !store.getGroup(gid1).projectId);
check('解除后 getGroupByProject 不再找到', store.getGroupByProject(projA.id) === null);

/* --------------------------------------------------- ③ 派活解析 */
console.log('\n③ 派活时"群默认项目、显式优先"');
const conv1 = store.getConversation(g1.id); // 建群时那段会话（kind='group'，带 groupId）
store.updateGroup(gid1, { projectId: projA.id });
check('群会话派活 → 自动带上群的项目', withGroupProject(conv1, {}).projectId === projA.id);
check('调用方显式传了 → 显式赢（流程选的项目不被群覆盖）',
  withGroupProject(conv1, { projectId: projB.id }).projectId === projB.id);
store.updateGroup(gid1, { projectId: '' });
check('群没关联 → 不传（行为与从前一致）', withGroupProject(conv1, {}).projectId === undefined);
check('单聊会话不受影响（判 kind）',
  withGroupProject({ kind: 'direct', groupId: null }, {}).projectId === undefined);

/* --------------------------------------------------- ④ HTTP 接口 */
console.log('\n④ 接口：一项目一群、错误码');
let portBusy = false;
try { await fetch(BASE + '/api/state', { signal: AbortSignal.timeout(800) }); portBusy = true; } catch { /* 连不上才是对的 */ }
if (portBusy) {
  console.log(`✗ 端口 ${PORT} 上已经有一个班底实例在跑 —— 先关掉再跑（否则测的是别人家的库）`);
  process.exit(1);
}
const logFd = fs.openSync(path.join(tmp, 'server.log'), 'a');
const srv = spawn(process.execPath, [path.join(process.cwd(), 'apps/server/src/server.mjs')], {
  env: { ...process.env, BANDI_HOST: '127.0.0.1', BANDI_DATA: tmp, BANDI_PORT: String(PORT) },
  stdio: ['ignore', logFd, logFd],
});
let up = false;
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(BASE + '/api/state')).ok) { up = true; break; } } catch {}
  await new Promise((r) => setTimeout(r, 250));
}
check('服务端起来了', up);

const patch = async (gid, body) => {
  const r = await fetch(`${BASE}/api/groups/${encodeURIComponent(gid)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

if (up) {
  let r = await patch(gid1, { projectId: projA.id });
  check('PATCH 关联项目 → 200 且回带 projectId', r.status === 200 && r.body.group?.projectId === projA.id,
    `${r.status} ${JSON.stringify(r.body.group?.projectId)}`);

  r = await patch(gid2, { projectId: projA.id });
  check('乙群抢同一项目 → 409', r.status === 409, String(r.status));
  check('错误码 E2069 且点出占用群', r.body.code === 'E2069' && /甲群/.test(String(r.body.error ?? '')),
    `${r.body.code} ${r.body.error}`);
  check('原群一个字没动（没被"顶掉"）', store.getGroup(gid1).projectId === projA.id);

  r = await patch(gid2, { projectId: 'pj-不存在' });
  check('项目不存在 → 404 + E2068', r.status === 404 && r.body.code === 'E2068', `${r.status} ${r.body.code}`);

  r = await patch(gid2, { projectId: '' });
  check('解除关联 → 200（空串是合法指令）', r.status === 200 && !r.body.group?.projectId, String(r.status));

  r = await patch(gid2, {});
  check('什么都没说 → 400 + E1039', r.status === 400 && r.body.code === 'E1039', `${r.status} ${r.body.code}`);

  r = await patch(gid2, { projectId: projB.id });
  check('换到另一个空项目 → 200（可换）', r.status === 200 && r.body.group?.projectId === projB.id);

  // 解散后的群：只读（改设置没意义）
  store.dissolveGroup(gid2);
  r = await patch(gid2, { projectId: projA.id });
  check('已解散的群改设置 → 400 + E2050', r.status === 400 && r.body.code === 'E2050', `${r.status} ${r.body.code}`);
  check('解散群手里的项目已释放（不算占用）', store.getGroupByProject(projB.id) === null);
}

srv.kill();
try { fs.closeSync(logFd); } catch {}
console.log(`\n结论：${failed ? `有 ${failed} 项没通过` : '全通过'}`);
process.exit(failed ? 1 : 0);
