/**
 * **建卡通道**的验收（2026-11-11，实报"贺韬三次 400 后自己上手"之后补）。
 *
 * 钉住四件事：
 *   ① 平台兜住模型常见手滑：UTF-16（含 BOM）请求体、批量口裸数组、**群派活项目可省略**；
 *   ② **补记**：`backfill:true` + 实际状态一步建成、不自动派活、来源标 `backfill`；
 *   ③ **验收人 = 派活人**：雇主派的主卡，PM 只能提交「待验收」，不能点「已完成」；
 *      他自己派的卡可以自己验收成「已完成」，也能退回执行人重跑；
 *   ④ 看板行带 `created_by / created_by_user_id`（「只看我的」筛选要用）。
 *
 * ⚠️ 必须在**鉴权形态**下跑（BANDI_HOST=0.0.0.0）：只有这时 `req.bandiAuth.kind === 'run'`
 * 才会成立，验收人闸才走得到；回环免鉴权形态下任何请求都是操作员，那条闸不会触发。
 * 隔离：临时数据目录 + 临时库 + 临时端口，跑完关库删目录。
 * 跑法：node apps/server/src/smoke-card-channel.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const here = import.meta.dirname;
const repo = path.resolve(here, '..', '..', '..');
const url = (rel) => pathToFileURL(path.join(repo, 'apps', 'server', 'src', rel)).href;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-card-channel-'));
const DATA = path.join(tmp, 'data');
fs.mkdirSync(DATA, { recursive: true });
const PORT = Number(process.env.SMOKE_PORT ?? 8841);
const BASE = `http://127.0.0.1:${PORT}`;
process.env.BANDI_DATA = DATA;
process.env.BANDI_DB = path.join(DATA, 'bandi.db');
process.env.BANDI_HOST = '0.0.0.0'; // 鉴权形态：运行钥匙分支才会被走到
process.env.BANDI_PORT = String(PORT);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

const store = await import(url('store.mjs'));
const experts = await import(url('experts.mjs'));
const auth = await import(url('agent-auth.mjs'));
const pt = await import(url('project-tasks.mjs'));

let db = null;
try {
  experts.hireExpert('hetao');
  experts.hireExpert('jiahui');
  const pm = store.getPersona('p-expert-hetao');
  const dev = store.getPersona('p-expert-jiahui');
  const projRoot = path.join(tmp, 'proj');
  fs.mkdirSync(projRoot, { recursive: true });
  const project = store.createProject({ name: '通道验收项目', root: projRoot });
  const groupConv = store.createGroup({ title: '通道验收群', assistantPersonaId: pm.id, memberIds: [dev.id] });
  const groupId = groupConv.groupId;
  store.updateGroup(groupId, { projectId: project.id });
  const run = store.createRun({ conversationId: groupConv.id, runtime: 'codex', personaId: pm.id });
  const token = auth.issueRunCredential(run.id, pm.id).token;

  // 同进程起服务（运行钥匙是进程内 Map，spawn 子进程拿不到）
  await import(url('server.mjs'));
  let up = false;
  for (let i = 0; i < 100 && !up; i += 1) {
    try { up = (await fetch(BASE + '/api/ping', { signal: AbortSignal.timeout(600) })).ok; } catch { await sleep(150); }
  }
  if (!up) throw new Error('控制面没起来');
  let panelToken = '';
  for (let i = 0; i < 50 && !panelToken; i += 1) {
    try { panelToken = fs.readFileSync(path.join(DATA, 'token'), 'utf8').trim(); } catch { await sleep(100); }
  }

  const post = async (rel, body) => {
    const r = await fetch(BASE + rel, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bandi-Run-Token': token },
      body,
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const patch = async (rel, body) => {
    const r = await fetch(BASE + rel, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Bandi-Run-Token': token },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const card = (extra = {}) => ({ title: '通道验收卡', description: '做成什么样算完', ...extra });

  console.log('① 请求体编码：UTF-16LE + BOM（PowerShell 重定向写出来的那种）');
  {
    const json = JSON.stringify({ cards: [card({ status: 'idea', assigneePersonaId: dev.id, idempotencyKey: 'p2-utf16' })] });
    const body = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, 'utf16le')]);
    const r = await post('/api/agent/cards/batch', body);
    check('UTF-16LE → 201', r.status === 201 && r.body.tasks?.length === 1, `${r.status} ${r.body.error ?? ''}`);
  }

  console.log('\n② 请求体形状：裸数组；项目省略 → 用群关联项目');
  {
    const r = await post('/api/agent/cards/batch', JSON.stringify([card({ status: 'idea', assigneePersonaId: dev.id, idempotencyKey: 'p2-array' })]));
    check('裸数组 → 201', r.status === 201 && r.body.tasks?.length === 1, `${r.status} ${r.body.error ?? ''}`);
    check('省略项目 → 群关联项目', r.body.tasks?.[0]?.projectId === project.id, `${r.body.tasks?.[0]?.projectId} / ${project.id}`);
  }

  console.log('\n③ 补记：一步写成实际状态、不重跑、来源 backfill');
  {
    const r = await post('/api/agent/cards/batch', JSON.stringify({ cards: [card({ title: '补记：登录页已改完', status: 'done', backfill: true, assigneePersonaId: dev.id, description: '补记：嘉辉在群里改完，证据见群记录', idempotencyKey: 'p2-backfill' })] }));
    const t = r.body.tasks?.[0];
    check('补记 → 201 且状态「已完成」', r.status === 201 && t?.status === 'done', `${r.status} ${t?.status}`);
    check('补记不重跑（runId 为空）', t && !t.runId, String(t?.runId));
    check('补记来源 = backfill', t?.source === 'backfill', String(t?.source));
  }

  console.log('\n④ 补记只写最终状态：带「待办」不是补记 → 400 E2058');
  {
    const r = await post('/api/agent/cards/batch', JSON.stringify({ cards: [card({ title: '假补记', status: 'todo', backfill: true })] }));
    check('补记 + 待办 → 400 E2058', r.status === 400 && r.body.code === 'E2058', `${r.status} ${r.body.code}`);
  }

  console.log('\n⑤ 验收人 = 派活人：雇主的卡 PM 只能提交待验收');
  {
    const ownerCard = pt.createProjectTask(project, { title: '雇主派的主卡', status: 'review', assigneeGroupId: groupId });
    const bad = await patch(`/api/projects/tasks/${ownerCard.id}`, { status: 'done' });
    check('PM 把主卡改「已完成」→ 403 E4034', bad.status === 403 && bad.body.code === 'E4034', `${bad.status} ${bad.body.code}`);
    const ok = await patch(`/api/projects/tasks/${ownerCard.id}`, { status: 'review' });
    check('提交「待验收」不受影响 → 200', ok.status === 200, String(ok.status));
  }

  console.log('\n⑥ PM 自己派的卡：能自己验收，也能退回执行人重跑');
  {
    const own = await post('/api/agent/cards', JSON.stringify(card({ title: 'PM 自己派的卡', status: 'idea', assigneePersonaId: dev.id, idempotencyKey: 'p2-own' })));
    const id = own.body.task?.id;
    const done = await patch(`/api/projects/tasks/${id}`, { status: 'done' });
    check('自己建的卡改「已完成」→ 200', done.status === 200 && done.body.task?.status === 'done', `${done.status} ${done.body.task?.status ?? done.body.error}`);
    // 验收不通过：退回执行人重跑（回待办 → 服务端自动开工）
    const back = await patch(`/api/projects/tasks/${id}`, { status: 'todo' });
    check('退回执行人重跑 → 200（待办/进行中）', back.status === 200 && ['todo', 'doing'].includes(back.body.task?.status), `${back.status} ${back.body.task?.status ?? ''}`);
  }

  console.log('\n⑦ 看板行带派活人字段（「只看我的」筛选用）');
  {
    const r = await fetch(BASE + `/api/projects/${project.id}/tasks`, { headers: { 'X-Bandi-Token': panelToken } });
    const data = await r.json().catch(() => ({}));
    const row = (data.rows ?? []).find((x) => x.manual_id);
    check('看板行有 created_by / created_by_user_id', row && Object.prototype.hasOwnProperty.call(row, 'created_by_user_id') && Object.prototype.hasOwnProperty.call(row, 'created_by'), row ? JSON.stringify({ c: row.created_by, u: row.created_by_user_id }) : '没行');
  }

  // 关库再删目录（Windows 上库还开着删不掉）
  try { db = await import(pathToFileURL(path.join(repo, 'apps/server/src/store/db.mjs')).href); db.db.close(); } catch { /* 关不掉就算了 */ }
} catch (e) {
  console.log('\n跑挂了：' + String(e?.message ?? e));
  failed += 1;
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
}

console.log(failed ? `\n✗ ${failed} 项没过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
