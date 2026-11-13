/**
 * **信箱**的验收（2026-11-11 用户拍板：左栏一级「信箱」，只收平台事实）。
 *
 * 钉住四件事：
 *   ① 建卡失败会落一条通知（错误码 / 员工 / runId 都在），写入失败不影响建卡响应；
 *   ② 同一轮 + 同一个错误码重试多次 → **一条、次数累加**（不刷屏）；不同错误码各自一条；
 *   ③ 已读语义：点一条 → 只这条已读；同一件事再失败 → 重新点亮未读；全部已读 → 0；
 *   ④ `/api/state` 的 `noticesUnread` 与 `GET /api/notices/unread` 同一口径（左栏角标）；
 *   ⑤ 删除：单条 / 批量（ids）/ 清空（all），removed 与 unread 口径一致（2026-11-12）。
 *
 * 隔离：临时数据目录 + 临时库 + 临时端口；同进程起服务（运行钥匙是进程内 Map）。
 * 跑法：node apps/server/src/smoke-inbox.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const here = import.meta.dirname;
const repo = path.resolve(here, '..', '..', '..');
const url = (rel) => pathToFileURL(path.join(repo, 'apps', 'server', 'src', rel)).href;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-inbox-smoke-'));
const DATA = path.join(tmp, 'data');
fs.mkdirSync(DATA, { recursive: true });
const PORT = Number(process.env.SMOKE_PORT ?? 8842);
const BASE = `http://127.0.0.1:${PORT}`;
process.env.BANDI_DATA = DATA;
process.env.BANDI_DB = path.join(DATA, 'bandi.db');
process.env.BANDI_HOST = '127.0.0.1';
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

let db = null;
try {
  experts.hireExpert('hetao');
  const pm = store.getPersona('p-expert-hetao');
  const projRoot = path.join(tmp, 'proj');
  fs.mkdirSync(projRoot, { recursive: true });
  const project = store.createProject({ name: '信箱验收项目', root: projRoot });
  const groupConv = store.createGroup({ title: '信箱验收群', assistantPersonaId: pm.id, memberIds: [] });
  store.updateGroup(groupConv.groupId, { projectId: project.id });
  const run = store.createRun({ conversationId: groupConv.id, runtime: 'codex', personaId: pm.id });
  const token = auth.issueRunCredential(run.id, pm.id).token;

  await import(url('server.mjs'));
  let up = false;
  for (let i = 0; i < 100 && !up; i += 1) {
    try { up = (await fetch(BASE + '/api/ping', { signal: AbortSignal.timeout(600) })).ok; } catch { await sleep(150); }
  }
  if (!up) throw new Error('控制面没起来');

  const req = async (method, p, body, headers = {}) => {
    const r = await fetch(BASE + p, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Bandi': '1', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const badCards = () => req('POST', '/api/agent/cards/batch', { cards: [{ title: '信箱测试', status: '乱来' }] }, { 'X-Bandi-Run-Token': token });

  console.log('① 建卡失败 → 落库：同轮同码去重、次数累加');
  await badCards();
  await badCards();
  const empty = await req('POST', '/api/agent/cards/batch', { cards: [] }, { 'X-Bandi-Run-Token': token });
  check('空批量也失败（E2059）', empty.status === 400 && empty.body.code === 'E2059', `${empty.status} ${empty.body.code}`);
  let list = await req('GET', '/api/notices');
  check('两条通知（E2058 去重成一条、E2059 一条）', (list.body.notices ?? []).length === 2, JSON.stringify((list.body.notices ?? []).map((n) => [n.code, n.count])));
  const dedup = (list.body.notices ?? []).find((n) => n.code === 'E2058');
  check('同轮同码重试两次 → 一条、次数 2', dedup?.count === 2, String(dedup?.count));
  check('通知带错误码 / 员工 / runId', dedup?.code === 'E2058' && dedup?.personaId === 'p-expert-hetao' && dedup?.runId === run.id, JSON.stringify({ code: dedup?.code, p: dedup?.personaId }));
  check('未读数 = 2', list.body.unread === 2, String(list.body.unread));
  check('通知带员工名（personaName）', dedup?.personaName === '贺韬', String(dedup?.personaName));

  console.log('\n② 已读语义：点一条只标这条；再失败重新点亮');
  const one = await req('POST', '/api/notices/read', { id: dedup.id });
  check('标一条已读 → 未读 1', one.status === 200 && one.body.unread === 1, `${one.status} ${one.body.unread}`);
  await badCards();
  list = await req('GET', '/api/notices');
  const again = (list.body.notices ?? []).find((n) => n.code === 'E2058');
  check('同一件事再失败 → 重新点亮未读、次数 3', !again?.readAt && again?.count === 3, `${again?.count} readAt=${again?.readAt}`);
  const all = await req('POST', '/api/notices/read', { all: true });
  check('全部已读 → 未读 0', all.body.unread === 0, String(all.body.unread));

  console.log('\n③ 未读数口径：/api/notices/unread 与 /api/state 一致');
  store.addNotice({ kind: 'card.create.failed', severity: 'warn', code: 'E1044', title: '建卡失败：E1044', detail: '请求体不是合法 JSON', personaId: pm.id, runId: run.id });
  const unreadApi = await req('GET', '/api/notices/unread');
  check('/api/notices/unread → 1', unreadApi.body.unread === 1, String(unreadApi.body.unread));
  const st = await req('GET', '/api/state');
  check('/api/state 的 noticesUnread = 1', st.body.noticesUnread === 1, String(st.body.noticesUnread));

  console.log('\n④ 删除（2026-11-12 批量删除）：单条 / 批量 / 清空');
  const del = await req('POST', '/api/notices/delete', { ids: [again.id] });
  check('删单条 → removed 1、未读不变（那条是已读）', del.body.removed === 1 && del.body.unread === 1, JSON.stringify(del.body));
  list = await req('GET', '/api/notices');
  check('清单里真没了', (list.body.notices ?? []).length === 2, String((list.body.notices ?? []).length));
  const rest = (list.body.notices ?? []).map((n) => n.id);
  const delBatch = await req('POST', '/api/notices/delete', { ids: rest });
  check('批量删剩余两条 → removed 2、未读清零', delBatch.body.removed === 2 && delBatch.body.unread === 0, JSON.stringify(delBatch.body));
  const delEmpty = await req('POST', '/api/notices/delete', { ids: [] });
  check('空 ids → removed 0 不报错', delEmpty.status === 200 && delEmpty.body.removed === 0, JSON.stringify(delEmpty.body));
  store.addNotice({ kind: 'card.create.failed', severity: 'warn', code: 'E2059', title: '建卡失败：E2059', detail: '又失败了', personaId: pm.id, runId: run.id });
  const delAll = await req('POST', '/api/notices/delete', { all: true });
  check('all 清空 → removed 1、未读 0', delAll.body.removed === 1 && delAll.body.unread === 0, JSON.stringify(delAll.body));

  try { db = await import(pathToFileURL(path.join(repo, 'apps/server/src/store/db.mjs')).href); db.db.close(); } catch { /* 关不掉就算了 */ }
} catch (e) {
  console.log('\n跑挂了：' + String(e?.message ?? e));
  failed += 1;
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
}

console.log(failed ? `\n✗ ${failed} 项没过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
