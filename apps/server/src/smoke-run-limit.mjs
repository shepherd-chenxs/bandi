/**
 * **单轮看护**的验收（2026-11-19，第七版：只认"没动静"，不认"跑多久"）。
 *
 * 这份用例的前身叫 `smoke-run-tool-budget`，验的是"工具次数到上限就掐"。那套设计改过
 * 六版、三次误杀正常任务（r-17cedccf / r-9dbf64af / r-065508b4），最后一版按墙钟 15 分钟
 * 掐 —— 被用户一句话点破："复杂功能跑几个小时都是正常的"。教训全写在 `runs.mjs` 的
 * RUN_IDLE_MS 注释里。现在的口径：
 *
 *   · 工具**只计数、不中止**（③ 是这条的回归：刷 30 次工具必须正常跑完）；
 *   · **跑得久不算病**（④ 是这条的回归：连续活动时长是空闲阈值的 4 倍，一次都不许掐）；
 *   · 只有**连续无事件**超时才收口（①②），且收尾是 done 不是 stopped，说明写"没动静"；
 *   · 收口前落库的 sessionId 保证下一句「继续」能接着原会话（⑤）；
 *   · 卡片侧读 usage.idleMs 写"N 分钟没有任何进展"，不是"没交回结论"。
 *
 * 用**伪造适配器**直接驱动 runs.mjs：不碰 data/、不起真 CLI、不烧 token。
 * 跑法：node apps/server/src/smoke-run-limit.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-runlimit-'));
process.env.BANDI_DATA = tmp;
process.env.BANDI_DB = path.join(tmp, 'bandi.db');
// 压到 900ms：真跑时 10 分钟，测起来没必要等
process.env.BANDI_RUN_IDLE_MS = '900';

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.writeFileSync(
  path.join(tmp, 'runtimes.json'),
  JSON.stringify({
    devices: {
      local: {
        runtimes: { fake: { family: 'codex', label: 'Fake', path: 'X:\\none', enabled: true } },
      },
    },
  }),
  'utf8',
);

const { ADAPTERS } = await import('./adapters.mjs');
const runs = await import('./runs.mjs');
const store = await import('./store.mjs');

const IDLE_MS = Number(process.env.BANDI_RUN_IDLE_MS);
const thread = { id: 'c-limit' };
const member = { personaId: 'p-limit', runtime: 'fake' };

const eventsOf = (runId) =>
  store.listRunEvents(runId, 0).map((r) => {
    try {
      return JSON.parse(r.evt);
    } catch {
      return null;
    }
  });
const repliesOf = (runId) =>
  store.listMessages(thread.id).filter((m) => m.role === 'assistant' && m.runId === runId);

/* ---------------------------------------------- ① 真的挂死：一条事件都不发 */
console.log('\n① 进程起来后一条事件都不发：判挂死，收口，状态 done');

ADAPTERS.codex = () =>
  new Promise(() => {
    /* 什么都不做，也不认 abort —— 模拟 CLI 卡死在启动/网络里 */
  });

const r1 = runs.startRun({ thread, member, task: '卡死的活', watermark: 0 });
await sleep(IDLE_MS + runs.STOP_WATCHDOG_MS + 1200);

const st1 = store.getRunStatus(r1.id);
check('状态是 done，不是 stopped', st1?.status === 'done', String(st1?.status));
const m1 = repliesOf(r1.id);
const text1 = String(m1[0]?.text ?? '');
check('回话落了一条', m1.length === 1, `${m1.length} 条`);
check(
  '说明写的是「没有进展 / 进程没动静」，不是「跑了太久」',
  /没有进展/.test(text1) && !/跑了 \d+ 分钟/.test(text1),
  JSON.stringify(text1.slice(-60)),
);
check(
  '给了出口：回一句继续、接着原来的会话',
  text1.includes('继续') && text1.includes('不用重来'),
  JSON.stringify(text1.slice(-40)),
);
const u1 = JSON.parse(store.getRunRow(r1.id)?.usage ?? '{}');
check('usage 记了 limitHit=idle', u1.limitHit === 'idle', String(u1.limitHit));
check('usage 记了空了多久', u1.idleMs >= IDLE_MS, String(u1.idleMs));

/* ---------------------------------------------- ② 说了一半然后没动静 */
console.log('\n② 说了半句话然后没动静：同样判挂死，已说的话保留');

ADAPTERS.codex = ({ onEvent }) =>
  new Promise(() => {
    onEvent({ type: 'text', text: '我先看一下目录结构。' });
    /* 之后再无事件 */
  });

const r2 = runs.startRun({ thread, member, task: '说一半卡住的活', watermark: 0 });
await sleep(IDLE_MS + runs.STOP_WATCHDOG_MS + 1200);

const text2 = String(repliesOf(r2.id)[0]?.text ?? '');
check('已说出口的那句没丢', text2.startsWith('我先看一下目录结构。'), JSON.stringify(text2.slice(0, 24)));
check('后面接了挂死说明', text2.includes('没有进展'), JSON.stringify(text2.slice(-40)));
check('状态仍是 done', store.getRunStatus(r2.id)?.status === 'done', String(store.getRunStatus(r2.id)?.status));

/* ---------------------------------------------- ③ 刷 30 次工具不掐（老回归） */
console.log('\n③ 30 次工具 + 三段过渡语：一次都不许掐（旧版就是在这儿砍掉正常任务）');

const FINAL3 = '查完了：pipeline 在 dispatch.mjs，持久化在 store/runs.mjs。';
ADAPTERS.codex = ({ onEvent }) =>
  new Promise((resolve) => {
    onEvent({ type: 'text', text: '我先拍定调子：这是改代码的活，我自己动手。\n\n' });
    let i = 0;
    const timer = setInterval(() => {
      if (i === 10) onEvent({ type: 'text', text: '环境变量没取到，换一种取法：\n' });
      if (i === 20) onEvent({ type: 'text', text: '钥匙已取到。接下来看 store 层：\n' });
      onEvent({ type: 'tool', name: 'command_execution', detail: { id: `item_n_${i}` } });
      i += 1;
      if (i >= 30) {
        clearInterval(timer);
        onEvent({ type: 'text', text: FINAL3 });
        resolve({
          sessionId: 'sess-3',
          finalText: FINAL3,
          exitCode: 0,
          events: [],
          usage: null,
          stderr: '',
        });
      }
    }, 5);
  });

const r3 = runs.startRun({ thread, member, task: '你来安排处理一下', watermark: 0 });
await sleep(1200);

const st3 = store.getRunStatus(r3.id);
const u3 = JSON.parse(store.getRunRow(r3.id)?.usage ?? '{}');
const text3 = String(repliesOf(r3.id)[0]?.text ?? '');
check('没被掐：状态 done', st3?.status === 'done', String(st3?.status));
check(
  '30 次工具全落在事件流里',
  eventsOf(r3.id).filter((e) => e?.type === 'tool').length === 30,
  String(eventsOf(r3.id).filter((e) => e?.type === 'tool').length),
);
check('usage 里记了工具次数（只记不掐）', u3.toolCalls === 30, String(u3.toolCalls));
check('usage 没有 limitHit', !u3.limitHit, String(u3.limitHit));
check('回话是完整结论，没有收口说明', text3 === FINAL3, JSON.stringify(text3));

/* ---------------------------------------------- ④ 核心回归：跑得久不掐 */
console.log('\n④ **核心**：连续活动 4 倍于空闲阈值 —— 跑得久是正常的，一次都不许掐');

const ACTIVE_MS = IDLE_MS * 4;
const t4 = Date.now();
ADAPTERS.codex = ({ onEvent }) =>
  new Promise((resolve) => {
    const started = Date.now();
    let n = 0;
    /* 每 1/6 个空闲阈值吐一条事件：模拟"活很重、一直在动"的长任务 */
    const timer = setInterval(() => {
      n += 1;
      onEvent({ type: 'thinking', text: `第 ${n} 步：还在读代码` });
      onEvent({ type: 'tool', name: 'command_execution', detail: { id: `item_long_${n}` } });
      if (Date.now() - started >= ACTIVE_MS) {
        clearInterval(timer);
        resolve({ sessionId: 'sess-4', finalText: '长任务做完了。', exitCode: 0, events: [], usage: null, stderr: '' });
      }
    }, Math.floor(IDLE_MS / 6));
  });

const r4 = runs.startRun({ thread, member, task: '一个持续很久的大活', watermark: 0 });
await sleep(ACTIVE_MS + 900);

const st4 = store.getRunStatus(r4.id);
const u4 = JSON.parse(store.getRunRow(r4.id)?.usage ?? '{}');
check(
  `跑了 ${(Math.round((Date.now() - t4) / 100) / 10).toFixed(1)}s（空闲阈值的 4 倍）仍是 done`,
  st4?.status === 'done',
  String(st4?.status),
);
check('没有 limitHit —— 一直在动就不算挂死', !u4.limitHit, String(u4.limitHit));
check(
  '回话是它自己给的结论，没被平台插话',
  String(repliesOf(r4.id)[0]?.text ?? '') === '长任务做完了。',
  JSON.stringify(repliesOf(r4.id)[0]?.text),
);
check(
  '事件没被收口逻辑拦掉（工具都进库了）',
  eventsOf(r4.id).filter((e) => e?.type === 'tool').length >= 20,
  String(eventsOf(r4.id).filter((e) => e?.type === 'tool').length),
);

/* ---------------------------------------------- ⑤ session 事件当场落库 */
console.log('\n⑤ session 事件：当场落库（中断也不丢会话，下一句「继续」接着原会话）');

ADAPTERS.codex = ({ onEvent }) =>
  new Promise(() => {
    onEvent({ type: 'session', sessionId: 'sess-early' });
    onEvent({ type: 'text', text: '开工。' });
    /* 之后卡死 */
  });

const r5 = runs.startRun({ thread, member, task: '中断也要能续', watermark: 0 });
await sleep(IDLE_MS + runs.STOP_WATCHDOG_MS + 1200);

check(
  '被中断的这轮也把 sessionId 写进了会话状态',
  store.getMemberSession(thread.id, 'p-limit', '')?.sessionId === 'sess-early',
  String(store.getMemberSession(thread.id, 'p-limit', '')?.sessionId),
);
check('session 事件不进 seq（续接失败仍能安全重开）', eventsOf(r5.id).every((e) => e?.type !== 'session'));

/* ---------------------------------------------- ⑥ 摘要口径 */
console.log('\n⑥ 摘要：时间花在哪 / 是不是挂了');

const sm = store.summarizeRun(r1.id);
check('摘要标了 limitHit=idle', sm?.limitHit === 'idle', String(sm?.limitHit));
check('摘要给得出 idleMs', sm?.idleMs >= IDLE_MS, String(sm?.idleMs));
check('摘要说得出总时长', sm?.durationMs != null && sm.durationMs > 0, String(sm?.durationMs));
check('没挂的那次不标 limitHit', store.summarizeRun(r4.id)?.limitHit == null, String(store.summarizeRun(r4.id)?.limitHit));

/* ---------------------------------------------- ⑦ 普通轮照旧 */
console.log('\n⑦ 普通轮：行为照旧');

ADAPTERS.codex = ({ onEvent }) =>
  new Promise((resolve) => {
    onEvent({ type: 'text', text: '在，说。' });
    onEvent({ type: 'tool', name: 'command_execution', detail: { id: 'only_one' } });
    setTimeout(
      () => resolve({ sessionId: null, finalText: '在，说。', exitCode: 0, events: [], usage: null, stderr: '' }),
      30,
    );
  });

const r6 = runs.startRun({ thread, member, task: '在吗', watermark: 0 });
await sleep(700);
const text6 = String(repliesOf(r6.id)[0]?.text ?? '');
check('状态 done', store.getRunStatus(r6.id)?.status === 'done', String(store.getRunStatus(r6.id)?.status));
check('回话原样，没有被追加收口说明', text6 === '在，说。', JSON.stringify(text6));

console.log(failed === 0 ? '\n全过' : `\n${failed} 项未过`);
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {}
process.exit(failed === 0 ? 0 : 1);
