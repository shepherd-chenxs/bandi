/**
 * `run-progress.mjs` 的纯函数验收（2026-11-19 加，起因：长任务里"它还在不在动"）。
 *
 * 这个模块**没有 DOM、没有 import**，所以能直接用 node 跑 —— 不用起服务、不用浏览器。
 *
 * 重点是 `lastEventAt`（重开页面时接上服务端记的最后活动）：
 *   · 以前新建 state 时它恒等于 `now` → 一轮已经卡了 8 分钟，刷新一下 `idleMs` 归零，
 *     界面显示"刚动过"，人一直等下去；
 *   · 现在从 `listRuns` 的 `lastEventAt` 带进来，并夹在 [startedAt, now] 之间。
 *
 * 跑法：node tools/smoke-web-progress.mjs
 */
import { createRunProgress, fmtAgo, progressView, STALL_MS } from '../apps/web/js/run-progress.mjs';

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};
const MIN = 60_000;
const now = Date.parse('2026-11-19T17:00:00.000Z');

/* ---------------------------------------------- ① 重画时认服务端的最后活动 */
console.log('\n① 重画：lastEventAt 来自服务端（8 分钟前），idleMs 不能归零');

const st1 = createRunProgress({
  startedAt: now - 30 * MIN,
  lastEventAt: new Date(now - 8 * MIN).toISOString(),
  now,
});
check('state.lastEventAt 用的是服务端那个时刻', st1.lastEventAt === now - 8 * MIN, String(st1.lastEventAt));
const v1 = progressView(st1, now);
check('idleMs = 8 分钟（不是 0）', v1.idleMs === 8 * MIN, String(v1.idleMs));
check('elapsedMs = 30 分钟（总时长照旧）', v1.elapsedMs === 30 * MIN, String(v1.elapsedMs));
check('判成 stalled', v1.stalled === true, String(v1.stalled));
check('文案说得出"最后动作在多久前"', fmtAgo(v1.idleMs) === '8 分钟前', fmtAgo(v1.idleMs));

/* ---------------------------------------------- ② 边界：数据不对时夹住 */
console.log('\n② 边界：未来时刻 / 早于开始时间，都不许把界面搞错');

const st2 = createRunProgress({ startedAt: now - 10 * MIN, lastEventAt: now + 5 * MIN, now });
check('未来时刻 → 夹到 now（当它刚动过，不凭空报卡住）', st2.lastEventAt === now, String(st2.lastEventAt - now));
check('不被判成 stalled', progressView(st2, now).stalled === false);

const st3 = createRunProgress({ startedAt: now - 10 * MIN, lastEventAt: now - 40 * MIN, now });
check('早于 startedAt → 夹到 startedAt（不可能比开始更早）', st3.lastEventAt === now - 10 * MIN, String(st3.lastEventAt - (now - 10 * MIN)));

const st4 = createRunProgress({ startedAt: now - 10 * MIN, now });
check('没给 lastEventAt → 用 now（老调用方行为不变）', st4.lastEventAt === now, String(st4.lastEventAt));

/* ---------------------------------------------- ③ 三档措辞的判据 */
console.log('\n③ 界面三档：20 秒内报动作 / 20 秒~5 分钟报"最后动作在 N 前" / ≥5 分钟报"可能卡住"');

// state 在 now-idleMs 那一刻建（lastEventAt = 那时），再按 now 去看 → 空闲正好 idleMs
const at = (idleMs) => progressView(createRunProgress({ startedAt: now - 60 * MIN, now: now - idleMs }), now);
check('刚动过 → 不 stalled', at(5_000).stalled === false);
check('4 分钟前 → 还不 stalled（服务端也没到收口线）', at(4 * MIN).stalled === false);
check('正好 5 分钟 → stalled', at(STALL_MS).stalled === true, String(STALL_MS));
check('9 分钟前 → stalled 但未到服务端 10 分钟收口线', at(9 * MIN).stalled === true);

/* ---------------------------------------------- ④ 收尾后时钟冻结 */
console.log('\n④ 收尾后：用时冻结在服务端给的值，不再随每秒重画往上跳');

const st5 = createRunProgress({ startedAt: now - 12 * MIN, lastEventAt: now - 2 * MIN, now });
st5.done = true;
st5.status = 'done';
st5.finalElapsedMs = 12 * MIN + 5_000;
check('用 finalElapsedMs', progressView(st5, now).elapsedMs === 12 * MIN + 5_000, String(progressView(st5, now).elapsedMs));
const st6 = createRunProgress({ startedAt: now - 12 * MIN, lastEventAt: now - 2 * MIN, now });
st6.done = true;
check('没有 finalElapsedMs 就退回"最后事件 - 开始"', progressView(st6, now).elapsedMs === 10 * MIN, String(progressView(st6, now).elapsedMs));

console.log(failed === 0 ? '\n全过' : `\n${failed} 项未过`);
process.exit(failed === 0 ? 0 : 1);
