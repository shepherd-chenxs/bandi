/**
 * **"连不上模型"要实时看得见**（2026-11-19 用户实报）。
 *
 * 原话："连不上模型，要让我直接能看到你在重连，我看到会处理的。"
 *
 * 那次故障的真实经过：模型请求 TLS 握手就断，CLI 吐 `Reconnecting... 1/5 … ECONNRESET`，
 * 重试 5 次、7 分钟、零输出。而用户屏幕上**什么都没有** —— 因为 error 事件在"续会话"这一档
 * 是被 `held` 扣住的（初衷是"会话不存在"那个必然失败别闪一下），一扣就扣到进程结束。
 * 于是人只能干看着一片死，不知道该去查代理。
 *
 * 这份用例钉住三件事：
 *   ① 通道类 error **必须当场进事件流**（进程还在跑时库里就能查到）；
 *   ② 收尾空回话要按原因分档 —— 通道断了写"查代理、好了回继续"，不是"模型输出为空"；
 *   ③ 非通道错误照旧（扣住再补发、文案不变），别为了修 ① 把老行为弄坏。
 *
 * 用伪造适配器直接驱动 runs.mjs：不碰 data/、不起真 CLI、不烧 token。
 * 跑法：node apps/server/src/smoke-run-channel.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-chan-'));
process.env.BANDI_DATA = tmp;
process.env.BANDI_DB = path.join(tmp, 'bandi.db');

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

const thread = { id: 'c-chan' };
const member = { personaId: 'p-chan', runtime: 'fake' };
const RELINK = 'Reconnecting... 1/5  model request failed: fetch failed — socket disconnected before secure TLS (ECONNRESET)';

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

/* ------------------------------------- ① 通道错误：进程还在跑，事件就得到前台 */
console.log('\n① 续会话时模型重连：error 必须当场进事件流（旧版扣到进程结束才补发）');

// 造一条已有 session，让这一轮走 resume 分支（held 只在 sid 非空时生效，也就是真实场景）
store.setMemberSession(thread.id, member.personaId, 'sess-old', '', 'codex');

ADAPTERS.codex = ({ onEvent }) =>
  new Promise((resolve) => {
    onEvent({ type: 'status', phase: 'turn_start' });
    onEvent({ type: 'error', message: RELINK });
    setTimeout(() => {
      onEvent({ type: 'text', text: '连上了，接着干。' });
      resolve({ sessionId: 'sess-old', finalText: '连上了，接着干。', exitCode: 0, events: [], usage: null, stderr: '' });
    }, 600);
  });

const r1 = runs.startRun({ thread, member, task: '续一轮活', watermark: 0 });
await sleep(300); // 进程还在跑

const mid = eventsOf(r1.id);
check(
  '运行中就能查到「Reconnecting」那条 error',
  mid.some((e) => e?.type === 'error' && /Reconnecting/.test(String(e.message))),
  `${mid.length} 条事件：${mid.map((e) => e?.type).join(',')}`,
);
check('运行中状态还是 running', store.getRunStatus(r1.id)?.status === 'running', String(store.getRunStatus(r1.id)?.status));

await sleep(900);
const end1 = eventsOf(r1.id);
check(
  '收尾后这条 error 只出现一次（不因补发重复）',
  end1.filter((e) => e?.type === 'error' && /Reconnecting/.test(String(e.message))).length === 1,
  String(end1.filter((e) => e?.type === 'error').length),
);
check('这一轮正常收尾成 done', store.getRunStatus(r1.id)?.status === 'done', String(store.getRunStatus(r1.id)?.status));
check('回话是模型自己那句，不是占位', String(repliesOf(r1.id)[0]?.text ?? '').includes('连上了'), '');

/* ------------------------------------- ② 一直没连上：空回话要写"查代理、回继续" */
console.log('\n② 重连五次全失败、一个字没产出：占位要说得清原因和下一步');

ADAPTERS.codex = ({ onEvent }) =>
  new Promise((resolve) => {
    onEvent({ type: 'status', phase: 'turn_start' });
    for (let i = 1; i <= 5; i += 1) onEvent({ type: 'error', message: `Reconnecting... ${i}/5  WorkBuddy AI: ECONNRESET (502)` });
    setTimeout(
      () => resolve({ sessionId: 'sess-old', finalText: '', exitCode: 1, events: [], usage: null, stderr: '' }),
      120,
    );
  });

const r2 = runs.startRun({ thread, member, task: '连不上的活', watermark: 0 });
await sleep(700);

const msg2 = repliesOf(r2.id)[0];
const text2 = String(msg2?.text ?? '');
check('落了一条回话（不是空气泡）', !!msg2, text2.slice(0, 20));
check('说的是"没连上模型"', /没连上模型/.test(text2), text2.slice(0, 40));
check('带上真因（ECONNRESET / 502 这类原文）', /(ECONNRESET|502)/.test(text2), text2.slice(0, 120));
check('给了下一步：查代理 + 回「继续」', /代理/.test(text2) && text2.includes('继续'), text2.slice(-60));
check('没有落老那句"模型输出为空"', !/模型输出为空/.test(text2), '');
const meta2 = typeof msg2?.meta === 'string' ? JSON.parse(msg2.meta || '{}') : (msg2?.meta ?? {});
check('meta 记了 channelDown', meta2.channelDown === true, JSON.stringify(meta2));
const ev2 = eventsOf(r2.id).filter((e) => e?.type === 'error');
check('5 条重连错误全在事件流里（直播能看到全程）', ev2.length === 5, String(ev2.length));

/* ------------------------------------- ③ 非通道错误：老行为不许变 */
console.log('\n③ 非通道错误（真·任务失败）：照旧扣住再补发，占位仍是老口径');

ADAPTERS.codex = ({ onEvent }) =>
  new Promise((resolve) => {
    onEvent({ type: 'status', phase: 'turn_start' });
    onEvent({ type: 'error', message: 'WorkBuddy refused this account\'s sign-in (401)' });
    // 收尾留 500ms：下面要趁"进程还在跑"的时候断言这条**没**闪出来
    setTimeout(() => resolve({ sessionId: 'sess-old', finalText: '', exitCode: 1, events: [], usage: null, stderr: '' }), 500);
  });

const r3 = runs.startRun({ thread, member, task: '账号不对的活', watermark: 0 });
await sleep(120);
check(
  '运行中**不**闪这条（扣住，别让人以为会话丢了）',
  !eventsOf(r3.id).some((e) => e?.type === 'error'),
  eventsOf(r3.id).map((e) => e?.type).join(','),
);
await sleep(700);
const text3 = String(repliesOf(r3.id)[0]?.text ?? '');
check('收尾后照样补发出来', eventsOf(r3.id).some((e) => e?.type === 'error'), '');
check('占位还是老口径（不是"没连上模型"）', /模型输出为空/.test(text3), text3.slice(0, 40));
const meta3 = repliesOf(r3.id)[0]?.meta;
check('meta 没有 channelDown', (typeof meta3 === 'string' ? JSON.parse(meta3 || '{}') : (meta3 ?? {})).channelDown !== true, '');

console.log(failed === 0 ? '\n全过' : `\n${failed} 项未过`);
process.exit(failed === 0 ? 0 : 1);
