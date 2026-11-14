/**
 * **会话上下文预算**的验收（2026-11-11 实报：群「爻鉴」会话跑 8 小时、3000 万 input，
 * 最后一轮模型把工具调用写成正文、空回话）。
 *
 * 钉住四件事：
 *   ① 阈值（轮数 / 年龄 / 累计 tokens / 单轮上下文 / 真实上下文比例）任一超限 → 该轮换；
 *   ② dsh 的 usage 是会话累计，相邻两轮差值才是"这一轮的上下文"（非单调时退回累计值）；
 *   ③ **有真实上下文信号时以它为准**（2026-11-12 实报：整轮求和 234 万其实最后一调才 6 万、
 *      窗口 95 万 —— 旧口径把"活得重"判成"上下文满"，一天八次轮换）；
 *   ④ 阈值可用环境变量覆盖，默认值有边界、不为 0。
 *
 * 纯函数冒烟，不碰库、不起服务：node apps/server/src/smoke-session-budget.mjs
 */
import { SESSION_BUDGET, perTurnTokens, shouldRotate } from './session-budget.mjs';

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};
const HOUR = 3600000;

console.log('① 默认阈值合理（都 > 0，且不是无限大）');
check('轮数上限在 10~200 之间', SESSION_BUDGET.maxRounds >= 10 && SESSION_BUDGET.maxRounds <= 200, String(SESSION_BUDGET.maxRounds));
check('年龄上限在 1~24h 之间', SESSION_BUDGET.maxHours >= 1 && SESSION_BUDGET.maxHours <= 24, String(SESSION_BUDGET.maxHours));
check('累计 tokens 上限 ≥ 100 万', SESSION_BUDGET.maxTotalTokens >= 1_000_000, String(SESSION_BUDGET.maxTotalTokens));
check('单轮上下文上限在 32k~200k 之间', SESSION_BUDGET.maxTurnTokens >= 32_000 && SESSION_BUDGET.maxTurnTokens <= 200_000, String(SESSION_BUDGET.maxTurnTokens));
check('真实上下文轮换线在 50%~95% 之间', SESSION_BUDGET.maxContextRatio >= 0.5 && SESSION_BUDGET.maxContextRatio <= 0.95, String(SESSION_BUDGET.maxContextRatio));

console.log('\n② 四个阈值：各自超限都要轮换');
const B = SESSION_BUDGET;
check('轮数差一轮不换', shouldRotate({ rounds: B.maxRounds - 1 }).rotate === false);
const byRounds = shouldRotate({ rounds: B.maxRounds });
check('轮数到上限 → 换，并给出原因', byRounds.rotate && byRounds.reasons.some((r) => r.includes('轮')), byRounds.reasons.join('；'));
check('年龄差一点不换', shouldRotate({ ageMs: B.maxHours * HOUR - 60000 }).rotate === false);
const byAge = shouldRotate({ ageMs: B.maxHours * HOUR });
check('年龄到上限 → 换', byAge.rotate && byAge.reasons.some((r) => r.includes('h')), byAge.reasons.join('；'));
// 累计判据：让相邻两轮差值很小，只有"累计"会触发
const total = B.maxTotalTokens;
const byTotal = shouldRotate({ usage: { inputTokens: total }, prevUsage: { inputTokens: total - 1000 } });
check('累计 tokens 到上限 → 换（单轮很小也算）', byTotal.rotate && byTotal.reasons.some((r) => r.includes('累计')), byTotal.reasons.join('；'));
const byTurn = shouldRotate({ usage: { inputTokens: 10_200_000 }, prevUsage: { inputTokens: 10_000_000 } });
check('单轮上下文 = 相邻两轮差值，到上限 → 换', byTurn.rotate && byTurn.reasons.some((r) => r.includes('单轮')), byTurn.reasons.join('；'));
check('两项都超 → 原因都列出来', shouldRotate({ rounds: B.maxRounds, ageMs: B.maxHours * HOUR }).reasons.length === 2);

console.log('\n③ 差值口径：dsh 累计 / 单轮型运行时 / 非单调');
check('两轮累计 10.2M / 10M → 单轮 200k', perTurnTokens({ inputTokens: 10_200_000 }, { inputTokens: 10_000_000 }) === 200_000);
check('只有一轮 → 直接拿累计（首轮=单轮）', perTurnTokens({ inputTokens: 80_000 }, null) === 80_000);
check('非单调（换运行时/重置）→ 退回累计值', perTurnTokens({ inputTokens: 50_000 }, { inputTokens: 80_000 }) === 50_000);
check('没有 usage → 0，不误判', perTurnTokens(null, null) === 0);
check('单轮型运行时 120k → 判超限', shouldRotate({ usage: { inputTokens: 120_000 } }).rotate === true);

console.log('\n③b 真实上下文口径（2026-11-12 实报：234 万其实最后一调才 6 万 / 窗口 95 万）');
{
  // 实报原样：codex 的 inputTokens 是整轮求和（含缓存重读），但真实上下文只有 6 万
  const realCase = shouldRotate({
    usage: { inputTokens: 2_344_363, cacheReadTokens: 2_247_325, contextTokens: 59_825, contextWindow: 950_000 },
  });
  check('整轮求和 234 万 + 真实上下文 6 万/95 万 → 不换', realCase.rotate === false, realCase.reasons.join('；'));
  const nearlyFull = shouldRotate({ usage: { inputTokens: 3_000_000, contextTokens: 820_000, contextWindow: 950_000 } });
  check('真实上下文 82 万 / 95 万（86%）→ 换，原因讲上下文', nearlyFull.rotate && nearlyFull.reasons.some((r) => r.includes('上下文')), nearlyFull.reasons.join('；'));
  check('真实上下文 21 万 / 95 万（22%）→ 不换', shouldRotate({ usage: { inputTokens: 900_000, contextTokens: 202_081, contextWindow: 950_000 } }).rotate === false);
  // 只有 contextTokens 没有窗口 → 回退旧口径，不能当"没超"
  check('有真实上下文但没窗口 → 回退旧口径（单轮型 120k 仍判超）',
    shouldRotate({ usage: { inputTokens: 120_000, contextTokens: 60_000 } }).rotate === true);
  check('真实上下文优先于求和口径（求和巨大、真值小 → 不换）',
    shouldRotate({ usage: { inputTokens: 13_087_028, contextTokens: 148_711, contextWindow: 950_000 } }).rotate === false);
  // 探不到真实上下文时：多调用型运行时不能再拿求和当窗口判（否则又回到一天八次轮换）
  check('无真实上下文 + codex 族求和 234 万 → 不用求和判超限',
    shouldRotate({ usage: { inputTokens: 2_344_363, runtimeFamily: 'codex' } }).rotate === false);
  check('无真实上下文 + dsh 族同样不为求和所动',
    shouldRotate({ usage: { inputTokens: 5_000_000, runtimeFamily: 'dsh' } }).rotate === false);
  check('无真实上下文 + 单轮型（claude）120k → 仍判超限',
    shouldRotate({ usage: { inputTokens: 120_000, runtimeFamily: 'claude' } }).rotate === true);
  check('运行时族未知（老数据）+ 120k → 保守判超限',
    shouldRotate({ usage: { inputTokens: 120_000 } }).rotate === true);
}

console.log('\n④ 小上下文不换（常规一轮不该触发轮换）');
const small = shouldRotate({ rounds: 3, ageMs: 20 * 60000, usage: { inputTokens: 60_000 }, prevUsage: { inputTokens: 40_000 } });
check('3 轮 / 20 分钟 / 单轮 20k → 不换', small.rotate === false && small.reasons.length === 0, small.reasons.join('；'));

console.log('\n⑤ 阈值可注入（冒烟/以后设置页的口子）');
const tight = { maxRounds: 2, maxHours: 1, maxTotalTokens: 1000, maxTurnTokens: 1000 };
check('自定义预算：2 轮就换', shouldRotate({ rounds: 2 }, tight).rotate === true);
check('自定义预算：小上下文不换', shouldRotate({ rounds: 1, ageMs: 0, usage: { inputTokens: 500 } }, tight).rotate === false);

console.log(`\n⑥ 落点守卫：轮换只留聊天灰字，不走信箱（用户 2026-11-11 拍板）`);
{
  const fs = await import('node:fs');
  const dispatchSrc = fs.readFileSync(new URL('./dispatch.mjs', import.meta.url), 'utf8');
  const block = dispatchSrc.slice(dispatchSrc.indexOf('上下文预算'), dispatchSrc.indexOf('if (rotated) brief'));
  check('轮换落一条 session-rotated 系统消息', /type:\s*'session-rotated'/.test(block));
  check('轮换不再写信箱（session.rotated notice 已删）', !/session\.rotated/.test(dispatchSrc) && !/addNotice\(\{[\s\S]*?session\.rotated/.test(dispatchSrc));
}

console.log(`\n结论：${failed ? `有 ${failed} 项没通过` : '全通过'}`);
process.exit(failed ? 1 : 0);
