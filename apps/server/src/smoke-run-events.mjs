/**
 * 运行事件流的落库与「断线只补缺口」验收（2026-10-15）。
 *
 * 验五件事：
 *   ① 事件真落库，且流里带 `id:`（SSE 的 Last-Event-ID 靠它）；
 *   ② 按 `Last-Event-ID` **只补缺口**，不再全量重放 —— 改前每次重连都会把回话重复追加一遍；
 *   ③ 序号是**每次运行各自**从 1 起，不是全局计数器；
 *   ④ 库里没有终止事件、内存里也没有 → 仍然 404（与改前一致，客户端会去查会话状态）；
 *   ⑤ **服务重启后**：已结束的运行照样整段回放；被中断的运行由清账**补上终止事件**，不再永远挂着。
 *
 * 为什么不用真跑一次 agent：`POST /api/personas` 会把不认识的 runtime 强转成 codex，
 * 所以"指一个不存在的运行时让它当场失败"这条路走不通（2026-10-15 实测踩到）。
 * 这里直接**往临时库里种运行与事件**，不依赖任何 agent CLI，结果完全确定。
 * （"边跑边推"那条实时路径由 smoke-plugin-e2e 等真跑用例覆盖。）
 *
 * 隔离：临时库 + 临时端口，跑完全删，不碰 data/。
 * 跑法：node apps/server/src/smoke-run-events.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { repoRoot } from './config.mjs';

const PORT = Number(process.env.SMOKE_PORT ?? 8796);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-runev-'));
const DB = path.join(tmp, 'bandi.db');
const SERVER = path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs');

const DONE_RUN = 'r-seed-done'; // 已经正常结束
const NOEND_RUN = 'r-seed-noend'; // 有事件但没有终止事件
const STALE_RUN = 'r-seed-stale'; // 跑中，等清账

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

function startServer(port) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: repoRoot,
    env: { ...process.env, BANDI_PORT: String(port), BANDI_DATA: tmp, BANDI_DB: DB },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (c) => (log += c));
  child.stderr.on('data', (c) => (log += c));
  return { child, log: () => log };
}

async function waitUp(base, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if ((await fetch(base + '/api/state', { signal: AbortSignal.timeout(800) })).ok) return true;
    } catch { /* 还没起 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function stop(ctx) {
  if (!ctx || ctx.child.exitCode !== null) return;
  const done = new Promise((r) => ctx.child.once('exit', r));
  ctx.child.kill();
  await Promise.race([done, new Promise((r) => setTimeout(r, 3000))]);
}

async function readStream(base, runId, lastEventId) {
  const headers = lastEventId == null ? {} : { 'Last-Event-ID': String(lastEventId) };
  const res = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}/stream`, {
    headers,
    signal: AbortSignal.timeout(6000),
  });
  return { status: res.status, body: await res.text() };
}

const idsOf = (body) => [...body.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
const evtsOf = (body) =>
  [...body.matchAll(/^data: (.*)$/gm)].map((m) => {
    try { return JSON.parse(m[1]); } catch { return null; }
  });

const seedRun = (db, id, status) =>
  db
    .prepare("INSERT INTO runs (id, conversationId, runtime, status, startedAt) VALUES (?, 'c-seed', 'codex', ?, ?)")
    .run(id, status, new Date().toISOString());
const seedEvent = (db, id, seq, evt) =>
  db
    .prepare('INSERT INTO run_events (runId, seq, evt, at) VALUES (?, ?, ?, ?)')
    .run(id, seq, JSON.stringify(evt), new Date().toISOString());

const doneEvt = (runId, status = '完成', error = null) => ({
  type: '__done', runId, status, exitCode: 0, error, usage: null,
  sessionId: 's-1', finalText: '好了', elapsedMs: 12, connectors: null,
});

let ctx = null;
try {
  /* ---------------- 第一段：先起一次只为把库表建出来，然后种数据 ---------------- */
  console.log('① 起一次服务把表建出来，然后种三条运行进临时库');
  ctx = startServer(PORT);
  const base = `http://127.0.0.1:${PORT}`;
  if (!(await waitUp(base))) throw new Error('服务没起来：' + ctx.log().slice(-500));
  await stop(ctx);
  ctx = null;

  const db = new DatabaseSync(DB);
  // A：好好跑完的一次（3 条事件，最后一条是终止事件）
  seedRun(db, DONE_RUN, '完成');
  seedEvent(db, DONE_RUN, 1, { type: 'text', text: '第一段' });
  seedEvent(db, DONE_RUN, 2, { type: 'tool', name: 'shell' });
  seedEvent(db, DONE_RUN, 3, doneEvt(DONE_RUN));
  // B：有事件但没终止事件（老数据的样子）
  seedRun(db, NOEND_RUN, '失败');
  seedEvent(db, NOEND_RUN, 1, { type: 'text', text: '半句' });
  // C：还写着「跑中」的残留，等启动清账收拾
  seedRun(db, STALE_RUN, '跑中');
  seedEvent(db, STALE_RUN, 1, { type: 'text', text: '断在这儿' });
  db.close();
  check('种好了三条运行', true);

  /* ---------------- 第二段：重启（顺带清账），验回放 ---------------- */
  const PORT2 = PORT + 1;
  ctx = startServer(PORT2);
  const base2 = `http://127.0.0.1:${PORT2}`;
  if (!(await waitUp(base2))) throw new Error('第二次没起来：' + ctx.log().slice(-500));
  check('重启时清账报出了被中断的运行', /清理了 1 条被中断的运行/.test(ctx.log()), ctx.log().match(/清理了.*/)?.[0] ?? '(日志里没这句)');

  console.log('\n② 已结束的运行：整段回放，带 id，最后一条是终止事件');
  const a0 = await readStream(base2, DONE_RUN, null);
  check('流是 200', a0.status === 200, String(a0.status));
  check('序号是 1,2,3', idsOf(a0.body).join(',') === '1,2,3', '实际 ' + idsOf(a0.body).join(','));
  check('最后一条是 __done', evtsOf(a0.body).at(-1)?.type === '__done');

  console.log('\n③ 断线重连只补缺口（改前是全量重放，回话会重复）');
  const a1 = await readStream(base2, DONE_RUN, 3);
  check('Last-Event-ID=3 → 一条都不补', idsOf(a1.body).length === 0, '实际 ' + idsOf(a1.body).join(','));
  const a2 = await readStream(base2, DONE_RUN, 2);
  check('Last-Event-ID=2 → 只补 id 3', idsOf(a2.body).join(',') === '3', '实际 ' + idsOf(a2.body).join(','));
  const a3 = await readStream(base2, DONE_RUN, 0);
  check('Last-Event-ID=0 → 从头补', idsOf(a3.body).join(',') === '1,2,3', '实际 ' + idsOf(a3.body).join(','));

  console.log('\n④ 认不出来的运行仍然 404（没有终止事件、内存里也没有）');
  const b0 = await readStream(base2, NOEND_RUN, null);
  check('没终止事件 → 404', b0.status === 404, String(b0.status));
  check('404 是 JSON 错误体，不是流', b0.body.trim().startsWith('{'), b0.body.slice(0, 80));
  const x0 = await readStream(base2, 'r-根本没有这个', null);
  check('不存在的运行 → 404', x0.status === 404, String(x0.status));

  console.log('\n⑤ 重启清账给断掉的运行补上终止事件，而且序号接着原来的往下写');
  const c0 = await readStream(base2, STALE_RUN, null);
  const ce = evtsOf(c0.body);
  check('补到 1,2 两条', idsOf(c0.body).join(',') === '1,2', '实际 ' + idsOf(c0.body).join(','));
  check('第一条是原来那半句（没被动过）', ce[0]?.type === 'text' && ce[0]?.text === '断在这儿', JSON.stringify(ce[0] ?? null));
  check('第二条是终止事件', ce[1]?.type === '__done', JSON.stringify(ce[1] ?? null).slice(0, 120));
  check('终止原因写明是重启中断', String(ce[1]?.error ?? '').includes('重启'), String(ce[1]?.error ?? ''));

  console.log('\n⑥ 序号是每次运行各自的，不是全局的');
  check('三条运行都从 1 起', idsOf(a0.body)[0] === 1 && idsOf(c0.body)[0] === 1);

  /* ------------------------------------------------------------------ ⑦ 真派一次活 */
  console.log('\n⑦ 真派一次活：走真实 HTTP 链路，覆盖"还在内存里 + 已结束"这条分支');
  const jpost = async (p, body) => {
    const r = await fetch(base2 + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const rtList = (await (await fetch(base2 + '/api/runtimes')).json()).runtimes ?? [];
  // 挑一个**班底自己说它起不来**的运行时：`launchable:false` 是它如实报的（比如 .cmd shim）。
  // 用它派活，必然在启动那一步失败 —— 于是不依赖任何 agent CLI，也不会真去跑模型。
  const doomed = rtList.find((r) => r.enabled && r.launchable === false);
  if (!doomed) {
    console.log('  · 跳过：本机每个运行时班底都起得来，没有"必然起不来"的可挑');
  } else {
    console.log(`  · 挑中「${doomed.label}」：${doomed.path}`);
    const p = await jpost('/api/personas', {
      name: '起不来的验收员',
      instructions: '',
      runtime: doomed.id,
    });
    // ⚠️ 必须确认运行时没被换成别的 —— 被换了就说明会真去跑一个能跑的 CLI，
    //    那这个用例既没验到东西、又白跑一次模型，宁可跳过。
    if (p.body?.persona?.runtime !== doomed.id) {
      check('员工的运行时没被悄悄换掉', false, `期望 ${doomed.id}，实际 ${p.body?.persona?.runtime}`);
    } else {
      check('员工的运行时按填的存了（没被强转）', true);
      const conv2 = await jpost('/api/conversations', { personaId: p.body.persona.id, title: '起不来验收' });
      const sent = await jpost(`/api/conversations/${conv2.body.conversation.id}/messages`, { text: '随便说一句' });
      check('派活返回 202 + runId', sent.status === 202 && !!sent.body?.runId, String(sent.body?.runId));
      const d0 = await readStream(base2, sent.body.runId, null);
      const de = evtsOf(d0.body);
      check('流是 200', d0.status === 200, String(d0.status));
      check('带 `id: 1`', idsOf(d0.body).join(',') === '1', '实际 ' + idsOf(d0.body).join(','));
      check('最后一条是终止事件', de.at(-1)?.type === '__done');
      check('判成失败（起不来）', de.at(-1)?.status === '失败', String(de.at(-1)?.status));
      check('原因写清了是起不来', String(de.at(-1)?.error ?? '').includes('起不来'), String(de.at(-1)?.error ?? '').slice(0, 80));
      check('重连只补缺口在真派活上也成立', idsOf((await readStream(base2, sent.body.runId, 1)).body).length === 0);
    }
  }
} catch (err) {
  console.log('\n跑挂了：' + String(err?.message ?? err));
  failed += 1;
} finally {
  await stop(ctx);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch { /* 删不掉就算了 */ }
}

console.log(failed ? `\n✗ ${failed} 项没过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
