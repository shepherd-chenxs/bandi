/**
 * session-budget.mjs —— 成员 CLI 会话的**上下文预算**（2026-11-11 实报后加）。
 *
 * 背景：群里每位员工在自己的一条 CLI 会话里续着跑，平台从不换会话 —— 群「爻鉴」那一轮
 * r-f0512961 的会话从 13:54 一路开到 22:19，usage 累计 3000 万 input，最后一轮模型把
 * 工具调用写成正文、空回话。上下文不是无上限的；到某个点必须**换一条新会话**。
 *
 * 这里的判据是**平台侧可观测的四个量**，不看模型内部：
 *   · 轮数（这段会话跑了几轮）；
 *   · 年龄（这段会话开了多久）；
 *   · 累计 input（会话总消耗，dsh 的 usage 是会话累计）；
 *   · 单轮上下文（dsh 用相邻两轮 usage 差值估算；单轮型运行时直接用最近一轮）。
 *
 * 任一超限 → `shouldRotate()` 返回原因列表；dispatch 据此清掉 member_sessions 的 sessionId，
 * 下一轮按 firstTime 重开，并注入最近几条消息的「上下文交接」。四个阈值都可用环境变量覆盖
 * （默认值见 SESSION_BUDGET；先满足"别再把会话跑到爆"，以后要进设置页再进）。
 *
 * 纯函数、不碰库、不 import 任何东西 —— 所以冒烟能直接测（见 smoke-session-budget.mjs）。
 */

const intEnv = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/** 0~1 之间的比例型环境变量（0 和 1 都算合法，但 0 会让它每轮都轮换 —— 不接） */
const ratioEnv = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : fallback;
};

export const SESSION_BUDGET = Object.freeze({
  /** 轮数上限：超过就换会话（默认 40 轮，按群聊里"一段连续工作"的量级） */
  maxRounds: intEnv('BANDI_SESSION_MAX_ROUNDS', 40),
  /** 年龄上限：超过就换会话（默认 6 小时） */
  maxHours: intEnv('BANDI_SESSION_MAX_HOURS', 6),
  /**
   * 累计 input 上限（默认 6000 万）。
   *
   * 2026-11-12 从 600 万上调：这个数**含 cacheRead** —— 工具活每步都重发上下文、缓存反复命中，
   * 一次重活就能涨两三百万，真实上下文却只有几万。600 万实际把"干得重"判成了"上下文满"，
   * 一天触发八次轮换。它现在只当**成本兜底**（真烧钱才拦），上下文对不对由 maxContextRatio 管。
   */
  maxTotalTokens: intEnv('BANDI_SESSION_MAX_TOTAL_TOKENS', 60_000_000),
  /**
   * 单轮上下文上限（默认 10 万）——**只在拿不到真实上下文信号时兜底**。
   *
   * ⚠️ 对多调用型运行时（codex/dsh）这个口径是错的：它们的 usage 是整轮求和，
   * 不是窗口大小。2026-11-12 实报：234 万的"单轮"其实最后一调才 6 万、窗口 95 万。
   * 现在 codex 族在收尾时会把真实上下文（contextTokens / contextWindow）挂进 usage
   * （见 context-probe.mjs），有它就走 maxContextRatio，没有才退回这个数。
   */
  maxTurnTokens: intEnv('BANDI_SESSION_MAX_TURN_TOKENS', 100_000),
  /**
   * **真实上下文 ÷ 模型窗口**的轮换线（默认 0.8）。
   * 这是唯一"上下文快满了"的正确度量：分子是最后一调的 input，分母是模型自报的窗口。
   * 环境变量 BANDI_SESSION_MAX_CONTEXT_RATIO 可覆盖（0~1 之间的小数）。
   */
  maxContextRatio: ratioEnv('BANDI_SESSION_MAX_CONTEXT_RATIO', 0.8),
});

/**
 * 这一轮实际吃进去的上下文量。
 *
 * dsh 的 usage 是**会话累计**（inputTokens 单调增），所以相邻两轮的差值 ≈ 这一轮的上下文；
 * 只有一轮时没法做差，直接拿累计值（第一轮累计 = 单轮）。如果出现非单调（换运行时/重置），
 * 退回累计值 —— 宁可误判一次轮换，也别把大上下文放过去。
 */
export function perTurnTokens(usage, prevUsage) {
  const cur = Number(usage?.inputTokens ?? usage?.totalTokens ?? 0) || 0;
  if (!cur) return 0;
  const prev = Number(prevUsage?.inputTokens ?? 0) || 0;
  if (!prev) return cur;
  return cur >= prev ? cur - prev : cur;
}

/**
 * 该不该换会话。返回 `{ rotate, reasons }`：reasons 是给人看的原因（也会进信箱/日志）。
 * `budget` 参数只为冒烟能改阈值，生产走默认 SESSION_BUDGET。
 */
export function shouldRotate({ rounds = 0, ageMs = 0, usage = null, prevUsage = null } = {}, budget = SESSION_BUDGET) {
  const reasons = [];
  if (rounds >= budget.maxRounds) reasons.push(`${rounds} 轮 ≥ ${budget.maxRounds} 轮`);
  if (ageMs >= budget.maxHours * 3600000) reasons.push(`已开 ${(ageMs / 3600000).toFixed(1)}h ≥ ${budget.maxHours}h`);
  const total = Number(usage?.inputTokens ?? 0) || 0;
  if (total >= budget.maxTotalTokens) reasons.push(`累计 ${total} tokens ≥ ${budget.maxTotalTokens}`);
  /*
   * 上下文这条分两种口径（2026-11-12）：
   *   · **有真实信号**（codex 族的 usage 带 contextTokens / contextWindow，见 context-probe.mjs）：
   *     按"最后一调 ÷ 模型窗口"判 —— 这才是上下文有没有真满，阈值默认 80%。
   *   · **没有**：回退旧的 perTurnTokens（单轮型运行时它≈真实窗口，判据成立；多调用型运行时
   *     它≈整轮求和，会误判，但总比不判安全 —— 老口径下最坏是换早了，至少不会撞窗口）。
   */
  const ctxTokens = Number(usage?.contextTokens ?? 0) || 0;
  const ctxWindow = Number(usage?.contextWindow ?? 0) || 0;
  if (ctxTokens > 0 && ctxWindow > 0) {
    const ratio = ctxTokens / ctxWindow;
    if (ratio >= budget.maxContextRatio) {
      reasons.push(`上下文 ${ctxTokens} / 窗口 ${ctxWindow}（${Math.round(ratio * 100)}% ≥ ${Math.round(budget.maxContextRatio * 100)}%）`);
    }
  } else {
    /*
     * 没有真实上下文信号时的兜底：**只有单轮型运行时**的 inputTokens 才≈窗口。
     * codex / dsh 是多调用型 —— usage 是整轮所有 API 调用的求和（2026-11-12 实测：
     * 求和 234 万、真实最后一调 6 万、窗口 95 万），拿它当窗口判就是"一天八次轮换"的元凶，
     * 所以这两族**不在这一条上判**，交给 累计 / 轮数 / 年龄 三条兜底（探到真实值就走比例口径）。
     * 运行时族未知（本字段是 2026-11-12 才加的，老数据没有）→ 保守保留旧判据。
     */
    const multiCall = usage?.runtimeFamily === 'codex' || usage?.runtimeFamily === 'dsh';
    const turn = perTurnTokens(usage, prevUsage);
    if (!multiCall && turn >= budget.maxTurnTokens) reasons.push(`单轮上下文 ≈ ${turn} tokens ≥ ${budget.maxTurnTokens}`);
  }
  return { rotate: reasons.length > 0, reasons };
}
