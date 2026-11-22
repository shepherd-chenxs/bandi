/**
 * 回归尺子的「等收尾」与「启动清账开关」（2026-11-22 收口）。
 *
 * 纯函数冒烟：不起服务、不开库、不跑模型 —— 直接喂伪造的 runs 行。
 * 钉的是两次真实事故，都是 2026-11-22 从临时库的 error 字段查出来的：
 *
 *   ① 只看 status 会读到 reapStaleRuns 留下的中间态（failed|interrupted），
 *      而 finishRun 之后真落款是 failed|silent —— status 一样，claim 不同。
 *      旧量具 6 秒一到就收工，把走完收尾的一轮错记成「不作数」。
 *   ② 回归临时库被员工起的共库服务实例 reap 判死 —— 启动时该跳过清账。
 *
 *   node apps/server/src/smoke-regression-settle.mjs
 */
import {
  TERMINAL,
  SETTLE_MS,
  terminalFingerprint,
  settleStep,
  shouldReapOnBoot,
} from './regression/settle.mjs';

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

/** 把一串 [时刻, 行] 喂进状态机，返回最后一拍；用来模拟轮询序列 */
function replay(steps) {
  let state = { key: null, since: 0, done: false };
  for (const [t, row] of steps) state = settleStep(state, row, t);
  return state;
}

console.log('① 终态指纹：status + claim 一起算');
check('running 不是终态', terminalFingerprint({ status: 'running', claim: null }) === null);
check('queued 不是终态', terminalFingerprint({ status: 'queued', claim: null }) === null);
check('null 行不是终态', terminalFingerprint(null) === null);
check('done 是终态', terminalFingerprint({ status: 'done', claim: 'done' }) !== null);
for (const s of TERMINAL) {
  check(`${s} 属于终态`, TERMINAL.includes(s) && terminalFingerprint({ status: s, claim: 'done' }) !== null);
}
check(
  'reap 中间态与真落款指纹不同（这是整条修复的关键）',
  terminalFingerprint({ status: 'failed', claim: 'interrupted' })
    !== terminalFingerprint({ status: 'failed', claim: 'silent' }),
  `${terminalFingerprint({ status: 'failed', claim: 'interrupted' })} vs ${terminalFingerprint({ status: 'failed', claim: 'silent' })}`,
);
check(
  'claim 为空也要能成指纹（老库没这一列）',
  terminalFingerprint({ status: 'failed', claim: null }) === 'failed|',
);

console.log('\n② 稳态状态机：指纹变了就重新计时');
check('还没到终态不算完成', !replay([[0, { status: 'running', claim: null }]]).done);
check(
  '终态刚出现、只过 1 秒 → 不算稳定',
  !replay([[0, { status: 'running' }], [1000, { status: 'failed', claim: 'silent' }]]).done,
);
check(
  '终态稳定满 SETTLE_MS → 完成',
  replay([
    [0, { status: 'failed', claim: 'silent' }],
    [SETTLE_MS, { status: 'failed', claim: 'silent' }],
  ]).done,
);
check(
  '中间态 interrupted → 真落款 silent，指纹变化后必须重新计时（旧量具就栽在这）',
  !replay([
    [0, { status: 'failed', claim: 'interrupted' }],
    [SETTLE_MS, { status: 'failed', claim: 'silent' }], // 此刻刚变，不该立刻收工
  ]).done,
);
check(
  '指纹重新计时后满 SETTLE_MS → 才完成',
  replay([
    [0, { status: 'failed', claim: 'interrupted' }],
    [SETTLE_MS, { status: 'failed', claim: 'silent' }],
    [SETTLE_MS * 2, { status: 'failed', claim: 'silent' }],
  ]).done,
);
check(
  'done → failed → done 抖动（restart 那次）不会提前收工',
  !replay([
    [0, { status: 'done', claim: 'done' }],
    [SETTLE_MS - 1, { status: 'failed', claim: 'interrupted' }],
    [SETTLE_MS, { status: 'done', claim: 'done' }],
  ]).done,
);
check(
  '终态中途退回 running，任何已稳定的判断作废',
  !replay([
    [0, { status: 'done', claim: 'done' }],
    [SETTLE_MS - 1, { status: 'running', claim: null }],
    [SETTLE_MS, { status: 'done', claim: 'done' }],
  ]).done,
);

console.log('\n③ 启动清账开关：只有回归实例跳过');
check('不设变量 → 照常清账（真实 18787 行为不变）', shouldReapOnBoot({}) === true);
check('设了 BANDI_SKIP_REAP=1 → 跳过', shouldReapOnBoot({ BANDI_SKIP_REAP: '1' }) === false);
check('设成别的值不算开关', shouldReapOnBoot({ BANDI_SKIP_REAP: '0' }) === true);
check('大小写敏感，不猜', shouldReapOnBoot({ bandi_skip_reap: '1' }) === true);

console.log(`\n${failed ? `✗ ${failed} 条没过` : '✓ 全过'}`);
process.exit(failed ? 1 : 0);
