/**
 * 「停止生成」不许把**已经说出口的话**弄丢（2026-10-29 用户实报）。
 *
 * 实报原话：「我点击停止生成，对方的消息完全消失，这个体验不太友好」。
 * 病根有两层，各修一处，都得钉住：
 *   ① 服务端：停止 = 掐子进程，适配器多半**等不到 final**（dsh 的 finalText 只来自 final 事件；
 *      看门狗强制收尾那条路更根本走不到 `.then`）→ 他说到哪儿，库里一个字都没有 → 重画后整段消失。
 *      修法 = `pushEvent` 把 text 事件攒一份，`finish()`（所有运行的唯一终点）给「已停止」兜底落库，
 *      消息带 `meta.stopped`（界面据此标「已停止生成」）。
 *   ② 前端（另见 tmp/stop-keep-cdp.mjs 的真浏览器验收）：abort 一返回就重画，抢在落库之前把实时气泡抹掉。
 *
 * 用**伪造适配器**（跟 smoke-stop-watchdog 同一套）直接驱动 runs.mjs ——
 * 不碰真实 data/、不起真 CLI、不烧 token。
 * 跑法：node apps/server/src/smoke-stop-keep.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-stopkeep-'));
process.env.BANDI_DATA = tmp;
process.env.BANDI_DB = path.join(tmp, 'bandi.db');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- 先写好运行时配置（startRun 要经 resolveForRun 挑一个能用的运行时） ---- */
fs.writeFileSync(
  path.join(tmp, 'runtimes.json'),
  JSON.stringify({
    devices: {
      local: {
        runtimes: {
          fake: { family: 'codex', label: 'Fake', path: 'X:\\none', enabled: true },
        },
      },
    },
  }),
  'utf8',
);

const { ADAPTERS } = await import('./adapters.mjs');
const runs = await import('./runs.mjs');
const store = await import('./store.mjs');

const thread = { id: 'c-fake' };
const member = { personaId: 'p-fake', runtime: 'fake' };

/** 这一轮落库的回话（assistant，按 runId 认） */
const repliesOf = (runId) =>
  store.listMessages(thread.id).filter((m) => m.role === 'assistant' && m.runId === runId);
const doneEventOf = (runId) =>
  store
    .listRunEvents(runId, 0)
    .map((r) => {
      try { return JSON.parse(r.evt); } catch { return null; }
    })
    .find((e) => e?.type === '__done');

/* ===== 场景一：看门狗强制收尾（promise 永不结算 —— 孙进程占着管道那种） ===== */
console.log('\n① 看门狗兜底：流出来的话照样落库');
ADAPTERS.codex = ({ onEvent }) =>
  new Promise(() => {
    // 模拟 dsh 一路吐 text 分块，随后人点了停止，子进程被掐、promise 永远不结算
    onEvent({ type: 'text', text: '我先看了仓库，' });
    onEvent({ type: 'text', text: '接着准备提交。' });
  });

const r1 = runs.startRun({ thread, member, task: '一', watermark: 0 });
runs.requestStop(r1.id);
await sleep(runs.STOP_WATCHDOG_MS + 1200);

check('这一轮收在「已停止」', store.getRunStatus(r1.id)?.status === '已停止', store.getRunStatus(r1.id)?.status);
const m1 = repliesOf(r1.id);
check('已经说出口的话落成了一条 assistant 消息', m1.length === 1, `${m1.length} 条`);
check(
  '正文就是流出来的那两段（原样拼起来，不重不漏）',
  m1[0]?.text === '我先看了仓库，接着准备提交。',
  JSON.stringify(m1[0]?.text ?? null),
);
check('带 meta.stopped（界面据此标「已停止生成」）', m1[0]?.meta?.stopped === true, JSON.stringify(m1[0]?.meta ?? null));
check(
  '终止事件也带着这段文本（流程收尾 / 飞书进度卡拿的就是 finalText）',
  doneEventOf(r1.id)?.finalText === '我先看了仓库，接着准备提交。',
  JSON.stringify(doneEventOf(r1.id)?.finalText ?? null),
);

/* ===== 场景二：收尾在超时前来得及，且适配器自己给了 finalText ===== */
console.log('\n② 正常收尾（适配器给了 finalText）：只落一条，不重复');
ADAPTERS.codex = ({ signal, onEvent }) =>
  new Promise((resolve) => {
    onEvent({ type: 'text', text: '一半' });
    signal?.addEventListener(
      'abort',
      () => setTimeout(() => resolve({ sessionId: null, finalText: '一半', exitCode: 0, events: [], usage: null, stderr: '' }), 200),
      { once: true },
    );
  });

const r2 = runs.startRun({ thread, member, task: '二', watermark: 0 });
runs.requestStop(r2.id);
await sleep(1200);

const m2 = repliesOf(r2.id);
check('只落一条消息（`.then` 落过之后收尾不再补一条）', m2.length === 1, `${m2.length} 条`);
check('正文是 finalText，没有被拼成两遍', m2[0]?.text === '一半', JSON.stringify(m2[0]?.text ?? null));
check('同样带 meta.stopped', m2[0]?.meta?.stopped === true, JSON.stringify(m2[0]?.meta ?? null));

/* ===== 场景三：一个字都还没说 —— 不硬造消息 ===== */
console.log('\n③ 一个字都没说：不造消息（界面另画一条安静的「已停止」状态行）');
ADAPTERS.codex = ({ signal }) =>
  new Promise((resolve) => {
    signal?.addEventListener(
      'abort',
      () => setTimeout(() => resolve({ sessionId: null, finalText: '', exitCode: 0, events: [], usage: null, stderr: '' }), 100),
      { once: true },
    );
  });

const r3 = runs.startRun({ thread, member, task: '三', watermark: 0 });
runs.requestStop(r3.id);
await sleep(900);

check('没有回话就一条消息都不落（"没说过"不等于"说了空话"）', repliesOf(r3.id).length === 0, String(repliesOf(r3.id).length));
check('状态仍是「已停止」（界面靠 run 行画状态行）', store.getRunStatus(r3.id)?.status === '已停止', store.getRunStatus(r3.id)?.status);

/* ===== 场景四：跑挂的那一轮不受影响 —— 半截话不冒充"回话" ===== */
console.log('\n④ 跑挂的那一轮：仍走「没跑成」，半截话不落成回话');
ADAPTERS.codex = ({ onEvent }) => {
  onEvent({ type: 'text', text: '说到一半' });
  return Promise.reject(new Error('假 CLI 跑挂了'));
};

const r4 = runs.startRun({ thread, member, task: '四', watermark: 0 });
await sleep(600);

check('状态是「失败」而不是「已停止」', store.getRunStatus(r4.id)?.status === '失败', store.getRunStatus(r4.id)?.status);
check('没有落半截回话（失败那一路由「没跑成」气泡说明原因）', repliesOf(r4.id).length === 0, String(repliesOf(r4.id).length));

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录，删不掉就算了 */ }
console.log(failed ? `\n${failed} 项没过` : '\n全过');
process.exit(failed ? 1 : 0);
