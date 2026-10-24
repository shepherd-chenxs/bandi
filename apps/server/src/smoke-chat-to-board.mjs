/*
 * 聊天派活与看板关系的验收（2026-10-24 用户定的口径，先做过会话级「上板」开关后否掉）：
 *   · 聊天派活**不进看板**（项目看板 / 全局面板都收不到）—— 看板收正式的活：
 *     流程、手工卡、仓库值班、PM 建的卡；PUT 也不再认 onBoard（开关已删）；
 *   · 员工详情的「任务」**照收**聊天行（那页按人筛过，"他手上有什么"要连聊天接的活一起看见）；
 *   · 「立成卡」（POST /api/conversations/:id/card）是聊天活进看板的**唯一**通道：
 *     状态照最近一轮折算（完成→待验收）、挂对项目、指向这场会话；
 *     员工详情里聊天投影让位（不出现同一件事两行）；再立一次幂等（created:false）；
 *   · 没归属的会话立卡 → 400 说清楚为什么（手工卡必须挂项目，硬规矩不开口子）。
 *
 * 用 fixtures/fake-agent.js 当运行时；隔离：临时数据目录 + 临时端口 + 临时项目目录。
 * 跑法：node apps/server/src/smoke-chat-to-board.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const FAKE = path.join(here, 'fixtures', 'fake-agent.js');
const PORT = Number(process.env.SMOKE_PORT ?? 8818);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-chat-board-'));
const projRoot = path.join(tmp, 'proj');
fs.mkdirSync(projRoot, { recursive: true });

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, [path.join(here, 'server.mjs')], {
  cwd: repoRoot,
  env: {
    ...process.env,
    BANDI_DATA: tmp,
    BANDI_DB: path.join(tmp, 'bandi.db'),
    BANDI_PORT: String(PORT),
    BANDI_HOST: '127.0.0.1',
    BANDI_FAKE_ECHO: 'full',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let slog = '';
server.stdout.on('data', (c) => (slog += c));
server.stderr.on('data', (c) => (slog += c));

async function waitUp(ms = 30000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(BASE + '/api/state', { signal: AbortSignal.timeout(800) });
      if (r.ok) return true;
    } catch { /* 还没起 */ }
    await sleep(200);
  }
  return false;
}

async function req(method, p, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Bandi': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

/** 等会话里所有 run 跑完（fake-agent 很快；上限 30 秒） */
async function waitAllDone(convId, ms = 30000) {
  const until = Date.now() + ms;
  let d = (await req('GET', `/api/conversations/${convId}`)).body;
  while (Date.now() < until) {
    d = (await req('GET', `/api/conversations/${convId}`)).body;
    if ((d.runs ?? []).length > 0 && (d.runs ?? []).every((x) => x.status !== '跑中')) return d;
    await sleep(150);
  }
  return d;
}

async function talk(convId, text) {
  const r = await req('POST', `/api/conversations/${convId}/messages`, { text });
  if (r.status !== 202) return r;
  await waitAllDone(convId);
  return r;
}

/** 看板（项目 / 全局）里聊天行 / 手工卡各几条 */
const boardSources = async (p) => {
  const b = (await req('GET', p)).body;
  const rows = b?.rows ?? [];
  return { chat: rows.filter((r) => r.source === 'chat').length, manual: rows.filter((r) => r.source === 'manual').length };
};

try {
  if (!(await waitUp())) throw new Error('控制面没起来：' + slog.slice(-600));

  const addRt = await req('POST', '/api/devices/local/runtimes', { family: 'codex', label: '假 CLI', path: FAKE });
  check('接上假运行时', addRt.status === 201 && !!addRt.body.runtime?.id, `${addRt.status}`);
  const rtId = addRt.body.runtime?.id;

  const project = (await req('POST', '/api/projects', { name: '上板验收项目', root: projRoot })).body.project;
  const dev = (await req('POST', '/api/personas', {
    name: '嘉辉', runtime: rtId, sandbox: 'danger-full-access', cwd: projRoot, instructions: '你是嘉辉。',
  })).body.persona;

  const conv = (await req('POST', '/api/conversations', { personaId: dev.id })).body.conversation.id;
  await talk(conv, '把首页那句文案改掉');

  console.log('\n① 聊天派活不进看板（没有开关可开），员工详情照收');
  check('项目看板没有聊天行', (await boardSources(`/api/projects/${project.id}/tasks`)).chat === 0);
  check('全局面板没有聊天行', (await boardSources('/api/tasks')).chat === 0);
  const mine = (await req('GET', `/api/personas/${dev.id}/tasks`)).body;
  check('员工详情有聊天行（照收）', (mine.rows ?? []).filter((r) => r.source === 'chat').length === 1);
  const put = await req('PUT', `/api/conversations/${conv}`, { onBoard: true });
  check('onBoard 开关已删（PUT 不认它 → E1037）', put.status === 400 && put.body.code === 'E1037', `${put.status} ${put.body.code}`);
  check('空改体同样被拒（E1037）', (await req('PUT', `/api/conversations/${conv}`, {})).body.code === 'E1037');

  console.log('\n② 立成卡：真卡进看板，员工详情里聊天投影让位');
  const card = await req('POST', `/api/conversations/${conv}/card`);
  check('立卡收下（201）', card.status === 201 && card.body.created === true, `${card.status}`);
  const t = card.body.task ?? {};
  check('卡指向这场会话', t.conversationId === conv, String(t.conversationId));
  check('标题取最近一句用户话', t.title === '把首页那句文案改掉', String(t.title));
  check('状态折成「待验收」（跑完等人验收）', t.status === '待验收', String(t.status));
  check('执行人是跑这轮的人', t.assigneePersonaId === dev.id, String(t.assigneePersonaId));
  check('挂在项目上', t.projectId === project.id, String(t.projectId));
  const afterCard = await boardSources(`/api/projects/${project.id}/tasks`);
  check('看板上是卡、不是聊天投影', afterCard.chat === 0 && afterCard.manual === 1, JSON.stringify(afterCard));
  const mine2 = (await req('GET', `/api/personas/${dev.id}/tasks`)).body;
  check('员工详情改由卡代表（不重复出两行）',
    (mine2.rows ?? []).filter((r) => r.source === 'chat').length === 0 &&
    (mine2.rows ?? []).filter((r) => r.source === 'manual').length === 1);

  console.log('\n③ 幂等：再立一次不建第二张');
  const again = await req('POST', `/api/conversations/${conv}/card`);
  check('返回 200 + created:false', again.status === 200 && again.body.created === false, `${again.status}`);
  check('还是原来那张卡', again.body.task?.id === t.id, `${again.body.task?.id} vs ${t.id}`);

  console.log('\n④ 没归属的会话立卡 → 400 说清楚');
  const stray = (await req('POST', '/api/personas', {
    name: '崔老三', runtime: rtId, sandbox: 'danger-full-access', cwd: tmp, instructions: '你是崔老三。',
  })).body.persona;
  const strayConv = (await req('POST', '/api/conversations', { personaId: stray.id })).body.conversation.id;
  await talk(strayConv, '顺手看看这个');
  const bad = await req('POST', `/api/conversations/${strayConv}/card`);
  check('400 + 文案说清要先配项目', bad.status === 400 && /项目/.test(bad.body.error ?? ''), `${bad.status} ${bad.body.error ?? ''}`);
} catch (e) {
  check('冒烟跑完', false, String(e?.stack ?? e));
} finally {
  server.kill();
}

console.log(failed ? `\n✗ ${failed} 处没过` : '\n✓ 全过');
process.exit(failed ? 1 : 0);
