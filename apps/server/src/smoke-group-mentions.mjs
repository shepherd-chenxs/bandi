/**
 * 群里 @ 多人自动排队的验收（2026-10-24）。
 *
 * 用户口径：项目经理在群里 @ 几个人安排活，被 @ 的数字员工就该一个个干起来 ——
 * 不用人在旁边一条条手动派。会话一次只跑一个（同时跑会在同一份代码上打架），
 * 所以是**排队**：第一个当场派，前一个收尾后下一个自动接上。
 *
 * 这里钉住五件事：
 *   ① 一条消息 @ 两人 → 第一个当场起 run，响应里带回排队名单；
 *   ② 第一个跑完，第二个**自动**起 run（收尾钩子补派），不用任何人再发消息；
 *   ③ 触发消息只落一条（不会给每个人复制一份），两个人的回复都在群里；
 *   ④ 排队的人在补派那一刻才算上下文 —— 他能看到前面那个人已经回进群里的东西；
 *   ⑤ 老规则不回退：@ 一个人照旧单人跑；没 @ 照旧归群助手。
 *
 * 用 fixtures/fake-agent.js 当运行时（不烧 token、不依赖真 CLI）。
 * 隔离：临时数据目录 + 临时端口 + 临时工作目录。
 * 跑法：node apps/server/src/smoke-group-mentions.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const FAKE = path.join(here, 'fixtures', 'fake-agent.js');
const PORT = Number(process.env.SMOKE_PORT ?? 8815);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-group-mentions-'));
const workDir = path.join(tmp, 'work');
fs.mkdirSync(workDir, { recursive: true });

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
    BANDI_FAKE_ECHO: 'full', // 假 CLI 回显整个任务 —— 断言排队者的 prompt 上下文要看到全文
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

const getConv = async (id) => (await req('GET', `/api/conversations/${id}`)).body;

/** 等会话里出现第 N 次 run（排队补派就是第 2 次凭空出现）；超时返回 null */
async function waitSecondRun(convId, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const d = await getConv(convId);
    if ((d.runs ?? []).length >= 2) return d;
    await sleep(120);
  }
  return null;
}

/** 等会话里所有 run 都跑完（fake-agent 很快；上限 30 秒） */
async function waitAllDone(convId, ms = 30000) {
  const until = Date.now() + ms;
  let d = await getConv(convId);
  while (Date.now() < until) {
    d = await getConv(convId);
    if ((d.runs ?? []).length > 0 && (d.runs ?? []).every((x) => x.status !== '跑中')) return d;
    await sleep(150);
  }
  return d;
}

try {
  if (!(await waitUp())) throw new Error('控制面没起来：' + slog.slice(-600));

  const addRt = await req('POST', '/api/devices/local/runtimes', { family: 'codex', label: '假 CLI', path: FAKE });
  check('接上假运行时', addRt.status === 201 && !!addRt.body.runtime?.id, `${addRt.status}`);

  const mk = async (name) => (await req('POST', '/api/personas', {
    name, runtime: addRt.body.runtime.id, sandbox: 'danger-full-access', cwd: workDir, instructions: `你是${name}。`,
  })).body.persona;
  const daliang = await mk('大梁');
  const shen = await mk('沈丹青');
  const jia = await mk('嘉辉');

  const g = await req('POST', '/api/groups', {
    title: '派活验收群', assistantPersonaId: daliang.id, memberIds: [daliang.id, shen.id, jia.id],
  });
  check('建群拿到第一段会话', g.status === 201 && !!g.body.conversation?.id, `${g.status}`);
  const convId = g.body.conversation.id;

  console.log('\n① 一条消息 @ 两人：第一个当场派，第二个进队列');
  const send1 = await req('POST', `/api/conversations/${convId}/messages`, { text: '@沈丹青 做A：落一版首页 @嘉辉 做B：修列表样式' });
  check('消息发出 → 202', send1.status === 202, `${send1.status} ${JSON.stringify(send1.body)}`);
  check('第一个开跑的是沈丹青', send1.body.personaName === '沈丹青', send1.body.personaName);
  check('响应带回排队名单（嘉辉）', Array.isArray(send1.body.queued) && send1.body.queued.join() === '嘉辉',
    JSON.stringify(send1.body.queued));
  check('此刻会话里有且只有一次 run', ((await getConv(convId)).runs ?? []).filter((r) => r.status === '跑中').length === 1);

  console.log('\n② 会话一次只跑一个：排队期间再发消息照样 409');
  const busy = await req('POST', `/api/conversations/${convId}/messages`, { text: '插一句' });
  check('排队期间插话 → 409', busy.status === 409, String(busy.status));

  console.log('\n③ 沈丹青跑完，嘉辉自动接上（收尾钩子补派，没人再发消息）');
  // fake-agent 快到两次 run 会在两次轮询之间全跑完 —— 别赌"跑中"窗口，
  // 按"第二次 run 出现得多快"判：节拍兜底是 30 秒一跳，10 秒内出现只可能来自收尾钩子。
  const both = await waitSecondRun(convId, 10000);
  check('收尾钩子立刻补派了下一个（不等 30 秒节拍）', !!both,
    both ? `第二次 run 已出现（${(both.runs ?? []).length} 次）` : '10 秒内没出现第二次 run');
  const done = await waitAllDone(convId);
  const runs = done.runs ?? [];
  check('一共两次 run', runs.length === 2, String(runs.length));
  check('两次都是不同的人、都跑完',
    runs.filter((r) => r.status === '完成').length === 2 &&
    new Set(runs.map((r) => r.personaId)).size === 2,
    JSON.stringify(runs.map((r) => ({ p: r.personaId, s: r.status }))));
  const jiaRun = runs.find((r) => r.personaId === jia.id);
  const shenRun = runs.find((r) => r.personaId === shen.id);
  check('第二个跑的是嘉辉', !!jiaRun, JSON.stringify(runs.map((r) => r.personaId)));
  const gapMs = jiaRun && shenRun ? Date.parse(jiaRun.startedAt) - Date.parse(shenRun.endedAt) : NaN;
  check('嘉辉紧跟沈丹青收尾起跑（间隔 < 10 秒，不是节拍兜底的 30 秒）', Number.isFinite(gapMs) && gapMs >= 0 && gapMs < 10000,
    `间隔 ${gapMs}ms`);

  console.log('\n④ 触发消息只落一条；嘉辉的 prompt 带上了沈丹青已回进群里的东西');
  const msgs = done.messages ?? [];
  check('原话只落一条（没给每个人复制一份）', msgs.filter((m) => m.role === 'user' && m.text.includes('做A')).length === 1);
  const replies = msgs.filter((m) => m.role === 'assistant');
  check('两个人都回了话', replies.length === 2, String(replies.length));
  const jiaReply = replies.find((m) => m.personaId === jia.id)?.text ?? '';
  check('嘉辉是首轮：带身份与群名注入', jiaReply.includes('你在一个项目群里'), jiaReply.slice(0, 80));
  check('嘉辉的 prompt 里有他的那份活', jiaReply.includes('做B'), jiaReply.slice(0, 120));
  check('嘉辉看得到沈丹青的回复（水位线在补派那一刻才算）', jiaReply.includes('做A'), jiaReply.slice(0, 160));

  console.log('\n⑤ 老规则不回退：@ 一个人照旧；没 @ 照旧归群助手');
  const single = await req('POST', `/api/conversations/${convId}/messages`, { text: '@嘉辉 单独补一句文案' });
  check('@ 一个人 → 当场派、没有排队', single.status === 202 && (single.body.queued ?? []).length === 0,
    `${single.status} ${JSON.stringify(single.body.queued)}`);
  await waitAllDone(convId);
  const noAt = await req('POST', `/api/conversations/${convId}/messages`, { text: '在吗' });
  check('没 @ → 群助手（大梁）接', noAt.status === 202 && noAt.body.personaName === '大梁',
    `${noAt.status} ${noAt.body.personaName}`);
  await waitAllDone(convId);
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
