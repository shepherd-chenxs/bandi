/**
 * 停止看门狗验收（2026-10-23）。
 *
 * 背景（用户实报）：任务卡点了「停止」，界面显示已停下，但发消息被
 * 「E409 他还在跑上一条」永远闸死 —— 因为 CLI 子进程退出后 'close' 事件没来
 * （孙进程继承 stdout 管道 / kill 失效都可能），promise 永不结算，
 * 运行永远停在「跑中」，只能重启服务解围。
 *
 * 修法：requestStop = 置标记 + abort + **5 秒看门狗**（超时强制收尾成「已停止」，
 * finish 加防重入，迟到的正常收尾不再两头写）。适配器 abort 时在 Windows 上
 * taskkill /T 拔进程树（治根因，真进程上冒烟没法安全验，靠上面的兜底保命）。
 *
 * 用**伪造适配器**（永不结算的 promise = 模拟 close 丢失）直接驱动 runs.mjs，
 * 全程不碰真实 data/、不起真 CLI。
 * 跑法：node apps/server/src/smoke-stop-watchdog.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-stopdog-'));
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

/* ===== 场景一：close 永远不来 → 看门狗强制收尾 ===== */
let aborted1 = 0;
ADAPTERS.codex = ({ signal }) =>
  new Promise(() => {
    signal?.addEventListener('abort', () => aborted1++, { once: true });
  }); // 永不 resolve

const r1 = runs.startRun({ thread, member, task: '一', watermark: 0 });
check('运行起步是「跑中」', store.getRunStatus(r1.id)?.status === '跑中', store.getRunStatus(r1.id)?.status);

const stopRes = runs.requestStop(r1.id);
check('requestStop 认得这笔运行并置了"人停的"标记', !!stopRes && stopRes.stoppedByUser === true);
check('abort 信号发出去了', aborted1 === 1);

await sleep(runs.STOP_WATCHDOG_MS + 1200);
check(`看门狗 ${runs.STOP_WATCHDOG_MS}ms 后强制收尾成「已停止」`, store.getRunStatus(r1.id)?.status === '已停止', store.getRunStatus(r1.id)?.status);
check('库里终止事件恰好一条（防重入，没两头写）', store.listRunEvents(r1.id, 0).filter((e) => JSON.parse(e.evt)?.type === '__done').length === 1);
check('会话状态不再挂着「跑中」', store.listConversations().find((c) => c.id === thread.id)?.status !== '跑中');

/* ===== 场景二：收尾在超时前来得及 → 正常收尾赢，看门狗不补刀 ===== */
let aborted2 = 0;
ADAPTERS.codex = ({ signal }) =>
  new Promise((resolve) => {
    signal?.addEventListener('abort', () => {
      aborted2++;
      setTimeout(() => resolve({ sessionId: null, finalText: '', exitCode: 0, events: [], usage: null, stderr: '' }), 300);
    }, { once: true });
  });

const r2 = runs.startRun({ thread, member, task: '二', watermark: 0 });
runs.requestStop(r2.id);
await sleep(runs.STOP_WATCHDOG_MS + 1200);
check('子进程 300ms 后正常退 → 状态同样落「已停止」', store.getRunStatus(r2.id)?.status === '已停止', store.getRunStatus(r2.id)?.status);
check('这次也只有一条终止事件（看门狗没有重复收尾）', store.listRunEvents(r2.id, 0).filter((e) => JSON.parse(e.evt)?.type === '__done').length === 1);

/* ===== 场景三：远端运行，节点不回执 → 看门狗同样兜底 ===== */
ADAPTERS.codex = () => new Promise(() => {});
const r3 = runs.startRun({ thread, member, task: '三', watermark: 0 });
// 手工摆成远端形态：活已发出去、没有子进程可掐
r3.remote = true;
r3.abortController = null;
runs.abortRemote(r3.id);
await sleep(runs.STOP_WATCHDOG_MS + 1200);
check('远端节点不回执也被看门狗收尾', store.getRunStatus(r3.id)?.status === '已停止', store.getRunStatus(r3.id)?.status);

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录，删不掉就算了 */ }
console.log(failed ? `\n${failed} 项没过` : '\n全过');
process.exit(failed ? 1 : 0);
