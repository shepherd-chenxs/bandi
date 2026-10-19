/**
 * 任务卡「评论区 = 议题讨论」的验收（2026-10-18 用户口径）。
 *
 * 用户原话的流程：卡在「想法」→ 发一条评论问技术方案 → 数字员工回复 → 在评论区聊；
 * 再发一条评论问功能 → 又聊一波；过几天回到第一条议题下补一句 → 接着聊；
 * 想法成熟 → 把状态改成「待办」并指定执行人 → **自动流转下去**（不再点「开始工作」）。
 *
 * 所以这里钉住四件事：
 *   ① **评论不改卡状态**（想法还是想法），也不登记 runId —— 评论是讨论，不是开工；
 *   ② 一条顶层评论 = 一个议题；他的回话挂到**触发它的那条评论**的议题下（不是"最后一条"）；
 *   ③ 隔了别的议题再回旧议题，回复也挂旧的（parentId 认议题，不认时序）；
 *   ④ **「待办」+ 已指定执行人 = 自动开工**；想法阶段/没指定人都不跑；跑完照样收成「待确认」。
 *
 * 用 fixtures/fake-agent.js 当运行时（不烧 token、不依赖真 CLI）。
 * 隔离：临时数据目录、临时端口、临时项目目录。
 * 跑法：node apps/server/src/smoke-task-comments.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeSandbox } from './sandbox.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const FAKE = path.join(here, 'fixtures', 'fake-agent.js');
const PORT = Number(process.env.SMOKE_PORT ?? 8808);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-task-comments-'));
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

const getTask = async (id) => (await req('GET', `/api/projects/tasks/${id}`)).body.task;
const getConv = async (id) => (await req('GET', `/api/conversations/${id}`)).body;

/** 等这次 run 跑完（fake-agent 很快；上限 20 秒），返回 run 行 */
async function waitRunDone(convId, runId, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const d = await getConv(convId);
    const r = (d.runs ?? []).find((x) => x.id === runId);
    if (r && r.status !== '跑中') return r;
    await sleep(150);
  }
  return null;
}

/** 发一条评论并等他那次回复跑完 */
async function comment(taskId, text, extra = {}) {
  const r = await req('POST', `/api/projects/tasks/${taskId}/comments`, { text, ...extra });
  if (!r.body.runId) return { res: r, run: null, conv: null };
  const conv = await getConv(r.body.conversationId);
  const run = await waitRunDone(r.body.conversationId, r.body.runId);
  return { res: r, run, convId: r.body.conversationId, conv: await getConv(r.body.conversationId), messages: (await getConv(r.body.conversationId)).messages ?? [] };
}

try {
  if (!(await waitUp())) throw new Error('控制面没起来：' + slog.slice(-600));

  const addRt = await req('POST', '/api/devices/local/runtimes', { family: 'codex', label: '假 CLI', path: FAKE });
  check('接上假运行时', addRt.status === 201 && !!addRt.body.runtime?.id, `${addRt.status} ${addRt.body.runtime?.id ?? JSON.stringify(addRt.body)}`);
  const rtId = addRt.body.runtime?.id;

  const project = (await req('POST', '/api/projects', { name: '测试项目', root: projRoot })).body.project;
  const persona = (await req('POST', '/api/personas', {
    name: '波哥', runtime: rtId, sandbox: 'danger-full-access', cwd: projRoot, instructions: '你是测试员工。',
  })).body.persona;
  const task = (await req('POST', `/api/projects/${project.id}/tasks`, {
    title: '写一个网站', description: '', status: '想法', personaId: persona.id,
  })).body.task;
  check('卡建在「想法」', task.status === '想法', task.status);

  console.log('\n① 想法阶段发评论：他会回复，但卡不动');
  const d1 = await comment(task.id, '用什么技术方案？');
  check('评论发出去了、起了一次 run', d1.res.status === 202 && !!d1.res.body.runId, String(d1.res.status));
  check('他那次真跑完了', d1.run?.status === '完成', String(d1.run?.status));
  let t = await getTask(task.id);
  check('卡还停在「想法」', t.status === '想法', t.status);
  check('没登记 runId（讨论不是"卡片在跑"）', !t.runId, String(t.runId));
  const msg1 = d1.messages.find((m) => m.role === 'user' && m.text === '用什么技术方案？');
  const reply1 = d1.messages.find((m) => m.role === 'assistant' && m.runId === d1.res.body.runId);
  check('顶层评论 = 议题（没有 parentId）', !!msg1 && !msg1.parentId, String(msg1?.parentId));
  check('他的回话挂在这条议题下', !!reply1 && reply1.parentId === msg1.id, `${reply1?.parentId} vs ${msg1?.id}`);
  check('卡描述没被灌"[运行结束]"', !String(t.description || '').includes('[运行结束]'), JSON.stringify(t.description));

  console.log('\n② 再开一个议题：又聊一波');
  const d2 = await comment(task.id, '网站具体功能是什么？');
  check('第二议题起了一次 run 并跑完', d2.res.status === 202 && d2.run?.status === '完成', `${d2.res.status}/${d2.run?.status}`);
  const all2 = d2.messages;
  const topics2 = all2.filter((m) => m.role === 'user' && !m.parentId);
  check('现在有两个顶层议题', topics2.length === 2, String(topics2.length));
  const msg2 = all2.find((m) => m.role === 'user' && m.text === '网站具体功能是什么？');
  const reply2 = all2.find((m) => m.role === 'assistant' && m.runId === d2.res.body.runId);
  check('第二议题的回话挂在第二议题下', !!reply2 && reply2.parentId === msg2.id, `${reply2?.parentId} vs ${msg2?.id}`);

  console.log('\n③ 过几天回到第一个议题补一句（中间已隔了别的议题）');
  const d3 = await comment(task.id, '补充：技术上有个漏洞，发布前要处理', { parentId: msg1.id });
  check('第三轮 run 跑完', d3.res.status === 202 && d3.run?.status === '完成', `${d3.res.status}/${d3.run?.status}`);
  const msg3 = d3.messages.find((m) => m.role === 'user' && m.text === '补充：技术上有个漏洞，发布前要处理');
  const reply3 = d3.messages.find((m) => m.role === 'assistant' && m.runId === d3.res.body.runId);
  check('我的补充挂在第一议题下', !!msg3 && msg3.parentId === msg1.id, `${msg3?.parentId} vs ${msg1?.id}`);
  check('他的回复也挂在第一议题下（不是最新那条）', !!reply3 && reply3.parentId === msg1.id, `${reply3?.parentId} vs ${msg1?.id}`);
  check('卡还是「想法」', (await getTask(task.id)).status === '想法');

  console.log('\n④「只留言，不叫醒他」：只落一条，不起 run');
  const note = await req('POST', `/api/projects/tasks/${task.id}/comments`, { text: '只记一句：周五前别动', note: true, parentId: msg1.id });
  check('留言成功、没起 run', note.status === 201 && note.body.note === true && !note.body.runId, `${note.status}/${note.body.runId}`);
  const afterNote = await getConv(d3.convId);
  check('留言落在议题下', afterNote.messages.some((m) => m.text === '只记一句：周五前别动' && m.parentId === msg1.id));

  console.log('\n⑤ 想法成熟：状态改成「待办」+ 已指定执行人 → 自动开工');
  const toTodo = await req('PATCH', `/api/projects/tasks/${task.id}`, { status: '待办' });
  check('PATCH 200 且真的派活了（started）', toTodo.status === 200 && toTodo.body.started === true, `${toTodo.status} started=${toTodo.body.started}`);
  check(
    '状态自动推进到「进行中」并登记 runId',
    toTodo.body.task?.status === '进行中' && !!toTodo.body.task?.runId,
    JSON.stringify(toTodo.body.task && { s: toTodo.body.task.status, r: toTodo.body.task.runId }),
  );
  const execRun = await waitRunDone(toTodo.body.task.conversationId, toTodo.body.task.runId);
  check('执行 run 跑完', execRun?.status === '完成', String(execRun?.status));
  t = await getTask(task.id);
  check('跑完收成「待确认」', t.status === '待确认', t.status);
  check('执行收尾写进描述（[运行结束]）', String(t.description || '').includes('[运行结束]'), JSON.stringify(t.description));

  console.log('\n⑥ 没指定人时改「待办」：只停车不跑；事后补上执行人 → 自动开工');
  const t2 = (await req('POST', `/api/projects/${project.id}/tasks`, { title: '再写一个站', status: '想法' })).body.task;
  const toTodo2 = await req('PATCH', `/api/projects/tasks/${t2.id}`, { status: '待办' });
  check('「待办」但没人 → 不跑、停在待办', toTodo2.status === 200 && !toTodo2.body.started && toTodo2.body.task?.status === '待办',
    `${toTodo2.status} started=${toTodo2.body.started} status=${toTodo2.body.task?.status}`);
  const assign = await req('PATCH', `/api/projects/tasks/${t2.id}`, { personaId: persona.id });
  check('补上执行人 → 自动开工', assign.status === 200 && assign.body.started === true && assign.body.task?.status === '进行中',
    `${assign.status} ${JSON.stringify(assign.body.task && { s: assign.body.task.status, r: assign.body.task.runId })}`);
  await waitRunDone(assign.body.task.conversationId, assign.body.task.runId);
  check('第二张卡跑完也收成「待确认」', (await getTask(t2.id)).status === '待确认', (await getTask(t2.id)).status);

  console.log('\n⑦ 「想法」+ 指定执行人：不跑（还没决定要不要做）');
  const t3 = (await req('POST', `/api/projects/${project.id}/tasks`, { title: '第三个想法', status: '想法' })).body.task;
  const assignIdea = await req('PATCH', `/api/projects/tasks/${t3.id}`, { personaId: persona.id });
  check('想法阶段指定人 → 还是想法、没起 run', assignIdea.status === 200 && assignIdea.body.task?.status === '想法' && !assignIdea.body.task?.runId,
    JSON.stringify(assignIdea.body.task && { s: assignIdea.body.task.status, r: assignIdea.body.task.runId }));
  console.log('\n⑧ 三档评论：便签给人看 / 讨论只读 / 执行动手（2026-10-19 用户定）');
  const t4 = (await req('POST', `/api/projects/${project.id}/tasks`, { title: '三档评论的卡', status: '想法' })).body.task;
  await req('PATCH', `/api/projects/tasks/${t4.id}`, { personaId: persona.id });

  // 便签：只落一条、不起 run；agent 不读（下一次派活**不**把它带进 prompt）
  const n1 = await req('POST', `/api/projects/tasks/${t4.id}/comments`, { text: '便签一句：按钮用蓝色', mode: 'note' });
  check('便签落下、没起 run', n1.status === 201 && !n1.body.runId, `${n1.status}/${n1.body.runId}`);
  const n2 = await req('POST', `/api/projects/tasks/${t4.id}/comments`, { text: '便签二：标题要短', mode: 'note' });
  check('第二条便签也没起 run', n2.status === 201 && !n2.body.runId, `${n2.status}/${n2.body.runId}`);
  // 兼容旧接口：note:true 等价于 mode:'note'
  const legacy = await req('POST', `/api/projects/tasks/${t4.id}/comments`, { text: '老客户端发的便签', note: true });
  check('旧 note:true 也认作便签', legacy.status === 201 && !legacy.body.runId, `${legacy.status}/${legacy.body.runId}`);

  // 讨论：起 run（假 CLI 回显）。这一轮任务文本里**不该**出现便签内容（便签只给人看）
  const disc = await comment(t4.id, '讨论一句：首页要做什么？', { mode: 'discuss' });
  check('讨论起 run 且跑完', disc.res.status === 202 && disc.run?.status === '完成', `${disc.res.status}/${disc.run?.status}`);
  const discEcho = disc.messages.find((m) => m.role === 'assistant' && m.runId === disc.res.body.runId)?.text ?? '';
  check('讨论这轮**没**把便签塞给他', !/便签一句|便签二|老客户端发的便签/.test(discEcho), discEcho.slice(0, 120));

  // 执行：起 run（同样的默认链路）
  const exec = await comment(t4.id, '执行一句：开写首页', { mode: 'execute' });
  check('执行起 run 且跑完', exec.res.status === 202 && exec.run?.status === '完成', `${exec.res.status}/${exec.run?.status}`);

  // 便签仍留在会话里给**人**看（不是被删）
  const after = (await getConv(disc.convId)).messages ?? [];
  check('便签仍留在会话里给人看', after.filter((m) => m.note === 1 || m.note === true).length >= 3,
    String(after.filter((m) => m.note === 1 || m.note === true).length));

  console.log('\n⑨ 讨论模式的只读沙箱换算（normalizeSandbox）');
  check('讨论 plan → codex read-only', normalizeSandbox('codex', 'plan') === 'read-only', normalizeSandbox('codex', 'plan'));
  check('讨论 plan → claude plan（本族原样）', normalizeSandbox('claude', 'plan') === 'plan', normalizeSandbox('claude', 'plan'));
  check('执行不传 sandbox 不动员工默认', normalizeSandbox('codex', 'danger-full-access') === 'danger-full-access',
    normalizeSandbox('codex', 'danger-full-access'));
} catch (err) {
  console.log('\n跑挂了：' + String(err?.message ?? err) + '\n' + slog.slice(-800));
  failed += 1;
} finally {
  try { server.kill(); } catch { /* 已退 */ }
  await sleep(600);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
}

console.log(failed ? `\n✗ ${failed} 项没过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
