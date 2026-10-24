/**
 * 全局事件流（SSE GET /api/events）的验收（2026-10-24）。
 *
 * 链路要证三件事：
 *   ① /api/events 挂进了路由链，回的是 text/event-stream；
 *   ② 消息落库（addMessage 这个必经点）会向挂着的连接广播 {type:'conv', id}；
 *   ③ 连接关闭后摘得干净（不漏定时器/不留在订阅表里）。
 *
 * 触发器挑了**卡评论区便签**（mode:'note'）：只落消息、不派活 ——
 * 不会真去拉起一个 agent 进程，冒烟就只是冒烟。
 *
 * 隔离：临时库、临时端口 —— 不碰 data/ 里的真账（规矩同 smoke-project-tasks）。
 * 跑法：node apps/server/src/smoke-events.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.SMOKE_PORT ?? 8796);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-events-'));
process.env.BANDI_DATA = tmp;
process.env.BANDI_DB = path.join(tmp, 'bandi.db');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

/* ⚠️ 必须先设 BANDI_DB 再 import 会读 config 的模块（同 smoke-project-tasks 的坑） */
const { repoRoot, dbPath } = await import('./config.mjs');
const store = await import('./store.mjs');

if (!path.resolve(dbPath).toLowerCase().startsWith(path.resolve(tmp).toLowerCase())) {
  console.log(`✗ 临时库没生效：dbPath=${dbPath} 不在 ${tmp} 下 —— 拒绝继续（避免写进真库）`);
  process.exit(1);
}
console.log(`（隔离自检：dbPath=${dbPath}）`);

/* ---------------------------------------------------------------- 造数据 */
const projRoot = path.join(tmp, 'proj-a');
fs.mkdirSync(projRoot, { recursive: true });
const proj = store.createProject({ name: '回执冒烟项目', root: projRoot });
const dev = store.createPersona({ name: '冒烟员', runtime: 'codex', cwd: projRoot, instructions: '' });
const task = store.createProjectTask({
  projectId: proj.id,
  title: '等一条便签的卡',
  status: '想法', // 想法 = 停车场：不会自动派活
  assigneePersonaId: dev.id,
});

/* ------------------------------------------------------------ 真起服务端 */
const logPath = path.join(tmp, 'server.log');
const logFd = fs.openSync(logPath, 'a');
const child = spawn(process.execPath, [path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs')], {
  cwd: repoRoot,
  env: { ...process.env, BANDI_PORT: String(PORT), BANDI_DATA: tmp, BANDI_DB: process.env.BANDI_DB },
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
  if (!up) throw new Error('服务端没起来，看 ' + logPath);

  /* ① 先挂上事件流 */
  const ac = new AbortController();
  const sseRes = await fetch(BASE + '/api/events', { signal: ac.signal });
  check('事件流接口 200', sseRes.status === 200, String(sseRes.status));
  check('回的是 text/event-stream', /text\/event-stream/.test(sseRes.headers.get('content-type') ?? ''), sseRes.headers.get('content-type') ?? '');

  let buf = '';
  const frames = [];
  const reader = sseRes.body.getReader();
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += Buffer.from(value).toString('utf8');
        let at;
        while ((at = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, at);
          buf = buf.slice(at + 2);
          const data = frame.split('\n').find((l) => l.startsWith('data: '));
          if (data) frames.push(JSON.parse(data.slice(6)));
        }
      }
    } catch { /* abort 时走到这，正常 */ }
  })();

  /* ② 落一条便签（只写消息、不派活）→ 必须广播出这条会话的 conv 事件 */
  const note = await api(`/api/projects/tasks/${encodeURIComponent(task.id)}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '回执冒烟：这条便签该推出来', mode: 'note' }),
  });
  check('便签落库 201', note.status === 201, String(note.status));
  const convId = note.body?.conversationId;
  check('便签回体带了会话 id', !!convId);

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !frames.some((f) => f.type === 'conv' && f.id === convId)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  check('事件流推到了 {type:"conv"}（消息落库 → 广播）',
    frames.some((f) => f.type === 'conv' && f.id === convId),
    JSON.stringify(frames));

  /* ③ 摘连接：断开后订阅表该干净（往库里再写一条，不该再有人收到） */
  ac.abort();
  await new Promise((r) => setTimeout(r, 300));
  const framesBefore = frames.length;
  await api(`/api/projects/tasks/${encodeURIComponent(task.id)}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '这条不该再推给已断开的连接', mode: 'note' }),
  });
  await new Promise((r) => setTimeout(r, 800));
  check('断开后不再收事件（订阅摘干净了）', frames.length === framesBefore, `断开前 ${framesBefore} 帧 / 现在 ${frames.length} 帧`);

  await pump.catch(() => {});
} finally {
  child.kill();
}

console.log(failed ? `\n✗ ${failed} 项没过` : '\n全过');
process.exit(failed ? 1 : 0);
