/**
 * **成员回复接力**的验收（2026-11-12 用户报障后定）。
 *
 * 报障原话：「群里面为啥没人理他」—— 贺韬在群里 @马超 派活，马超一动不动。
 * 查实：派活只认「**人**发的消息」和卡票回执，成员自己的回复落库之后根本没人扫 @
 * （库里 0 run、0 通知，不是跑挂）。而给统筹岗的合同写着「在群里 @ 具体执行人接活」——
 * 合同让人 @，引擎不认 @，那句合同就是在教人喊空气。
 *
 * 这里钉住三件事：
 *   ① 群成员的回话里 @ 到谁，谁就被唤醒（不用人再发一条消息）；
 *   ② **不回打**：被叫醒的人回话里 @ 叫他的人，不再把对方叫起来（乒乓会聊到天亮）；
 *   ③ 老规矩不回退：**人**发的 @ 照旧当场派（接力只补成员之间那一档）。
 *
 * 用 fixtures/fake-agent.js 当运行时（它把整段任务回声出来，天然带 `@名字`，
 * 正好演"回复里提到另一个人"）。隔离：临时数据目录 + 临时端口 + 临时工作目录。
 * 跑法：node apps/server/src/smoke-reply-chain.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const FAKE = path.join(here, 'fixtures', 'fake-agent.js');
const PORT = Number(process.env.SMOKE_PORT ?? 8827);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-reply-chain-'));
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
    BANDI_FAKE_ECHO: 'full',
    // 回话末尾固定追一句：**回复本身**提到马超与贺韬（验接力与'不回打'，
    // 且不让用户原话里的 @ 混进来 —— 那是另一条派活路）
    BANDI_FAKE_SAY: '@马超 你接手 @贺韬 一起对一下',
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

/** 等会话里出现第 n 次 run（接力就是"凭空"多出来的那一次） */
async function waitRuns(convId, n, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const d = await getConv(convId);
    if ((d.runs ?? []).length >= n) return d;
    await sleep(120);
  }
  return null;
}

/** 等会话里所有 run 都跑完 */
async function waitAllDone(convId, ms = 30000) {
  const until = Date.now() + ms;
  let d = await getConv(convId);
  while (Date.now() < until) {
    d = await getConv(convId);
    if ((d.runs ?? []).length > 0 && (d.runs ?? []).every((x) => x.status !== 'running')) return d;
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
  const hetao = await mk('贺韬');
  const machao = await mk('马超');
  const jiahui = await mk('嘉辉');

  const g = await req('POST', '/api/groups', {
    title: '接力验收群', assistantPersonaId: hetao.id, memberIds: [hetao.id, machao.id, jiahui.id],
  });
  check('建群拿到第一段会话', g.status === 201 && !!g.body.conversation?.id, `${g.status}`);
  const convId = g.body.conversation.id;

  console.log('\n① 成员回话里 @ 人 = 接力唤醒（这是这次报障的正题）');
  // 人只 @ 了贺韬；马超的名字只出现在**贺韬的回话**里（假 CLI 回声），
  // 以前到这儿就断了 —— 马超永远不会被叫起来。
  // ⚠️ 人这条消息**只 @ 贺韬**：马超的名字只能出现在贺韬的回话里，
  // 否则马超是被'人 @ 多人'排进队列的，验的就不是接力（这条踩过）。
  const send = await req('POST', `/api/conversations/${convId}/messages`, { text: '@贺韬 马超那边卡在凭证，你去跟进' });
  check('人发的消息当场派给贺韬', send.status === 202 && send.body.personaName === '贺韬',
    `${send.status} ${send.body.personaName}`);

  const second = await waitRuns(convId, 2, 15000);
  check('贺韬回话 @马超 → 马超被唤醒（凭空多出第二次 run）', !!second,
    second ? `已出现 ${(second.runs ?? []).length} 次 run` : '15 秒内没有第二次 run');
  const done1 = await waitAllDone(convId);
  const runs1 = done1.runs ?? [];
  check('第二次跑的是马超', runs1.some((r) => r.personaId === machao.id),
    JSON.stringify(runs1.map((r) => r.personaId)));
  check('接力没有伪造用户消息（user 消息仍只有一条）',
    (done1.messages ?? []).filter((m) => m.role === 'user').length === 1,
    String((done1.messages ?? []).filter((m) => m.role === 'user').length));
  check('马超拿到了上下文（他的 prompt 里能看到贺韬的回话）',
    String((done1.messages ?? []).find((m) => m.role === 'assistant' && m.personaId === machao.id)?.text ?? '')
      .includes('跟进'),
    '');

  console.log('\n② 不回打：马超回话里 @ 贺韬，不再把贺韬叫起来');
  // 马超的回声里必然带 "@贺韬"（来自人发的原话）—— 正是最容易引发乒乓的场景。
  await sleep(1200);
  const after = await waitAllDone(convId);
  const runs2 = after.runs ?? [];
  check('贺韬仍然只跑过 1 次（没有被 ping-pong 叫回来）',
    runs2.filter((r) => r.personaId === hetao.id).length === 1,
    JSON.stringify(runs2.map((r) => r.personaId)));
  check('总共就两次 run（没有第三跳）', runs2.length === 2, String(runs2.length));

  console.log('\n③ 老规矩不回退：人发的 @ 照旧当场派（且不受接力跳数影响）');
  const again = await req('POST', `/api/conversations/${convId}/messages`, { text: '@嘉辉 说一句' });
  check('人 @ 嘉辉 → 当场派', again.status === 202 && again.body.personaName === '嘉辉',
    `${again.status} ${again.body.personaName}`);
  const done3 = await waitAllDone(convId);
  check('嘉辉跑起来了', (done3.runs ?? []).some((r) => r.personaId === jiahui.id),
    JSON.stringify((done3.runs ?? []).map((r) => r.personaId)));
} catch (err) {
  console.log('\n跑挂了：' + String(err?.message ?? err) + '\n' + slog.slice(-800));
  failed += 1;
} finally {
  // 失败时把接力的判据摊开（第几跳 / 被谁叫醒），省得下次又要靠猜
  if (failed) {
    const lines = slog.split('\n').filter((l) => l.includes('[接力]'));
    if (lines.length) console.log('\n服务端接力日志：\n' + lines.join('\n'));
  }
  try { server.kill(); } catch { /* 已退 */ }
  await sleep(600);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
}

console.log(failed ? `\n✗ ${failed} 项没过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
