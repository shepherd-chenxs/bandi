/**
 * 「这张卡到底做成了没有」的**客观证据**（2026-11-21）。
 *
 * 起因（用户实报 pt-4b6bf1ec）：活干完了、代码推了、PR #83 合了、80 项冒烟全过，
 * 只因为回话里漏写一行 `[完成]`，卡就被判「已阻塞」等人拍板。用户问："有没有办法让员工
 * 自己去改状态？" —— 有（窄门已开），但**把完成判据全押在员工记得写字上**，本身就是错的：
 * 那是语义约定，不是事实。
 *
 * 所以这里补第二条腿：**看外部事实**。能当证据的只有两样，且都必须来自 GitHub（不是模型说的）：
 *   ① PR 已合并 —— 最强。代码进了主干，这是终态。
 *   ② CI 全绿 —— 次强。改动推上去了、平台自己的 gate 全过，只差人合并。
 *      （合并前这也是"能不能合"的唯一硬门槛，我们的 main 有分支保护。）
 *
 * 反过来，**CI 红了是反对证据**：员工写了 `[完成]`，但检查没过，就不该顺着推到「待验收」
 * 让人白看一遍 —— 这条以前完全没有，卡会带着红 CI 一路滑到待验收。
 *
 * 边界（写死在这里，改之前先想清楚）：
 *   · 证据只**推进到「待验收」**，永不「已完成」—— 验收权在人手里，这一条不因证据强而松动；
 *   · 证据**过期作废**：CI 结论过了 maxAgeMs 就不再算数（隔夜的"全绿"证明不了今天）。
 *     跟"停下来的诊断会过期"是同一条道理；
 *   · 判据只用事实字段（prState / prCiState / 时间），**不解析自然语言** ——
 *     一旦开始猜"这句话像不像做完了"，就又回到了当初那个坑。
 */

/** CI 结论的取值（`git-repos.mjs` 的 summarizeChecks 产出前四种，unknown 是"没查成"） */
export const CI_STATES = ['success', 'failure', 'pending', 'none', 'unknown'];

/** 证据默认保质期：一天。巡检 30 分钟一轮，正常情况下远不会过期；过期只可能是巡检停了 */
export const EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const ageOf = (iso, now) => {
  const t = Date.parse(String(iso ?? ''));
  return Number.isFinite(t) ? now - t : null;
};

/**
 * 判一张卡的客观证据。
 *
 * @returns {{verdict:'strong'|'contra'|'pending'|'none', source:string|null, why:string}}
 *   strong → 可据此把卡推到「待验收」（仍需人点头）
 *   contra → 明确反对（CI 红），不该往上推
 *   pending → 还在跑，等下一轮巡检
 *   none   → 没有可用证据（没关联 PR / 仓库没配检查 / 结论过期 / 查不到）
 */
export function evidenceOf(task, { now = Date.now(), maxAgeMs = EVIDENCE_MAX_AGE_MS } = {}) {
  if (!task) return { verdict: 'none', source: null, why: '没有卡' };
  const prState = String(task.prState ?? '');
  const ciState = String(task.prCiState ?? '');
  const stale = (() => {
    const age = ageOf(task.prCiAt, now);
    // 时间读不出来（NULL / 手改过）当**过期**处理：拿不准的旧结论不配当证据
    return age === null || age > maxAgeMs;
  })();

  // ① PR 已合并：不管 CI 现在什么样（可能分支保护放的、也可能人手动合的），代码已经进主干
  if (prState === 'merged') {
    return { verdict: 'strong', source: 'pr-merged', why: 'PR 已合并（代码进主干）' };
  }

  const failed = String(task.prCiFailed ?? '').trim();

  // ② CI 红：明确反对。**不过期判断放在前面**，因为"红"比"绿"更适合信任老结论 ——
  //    隔夜的红不会自己变绿（要变绿必然有新提交 → 巡检会刷新 prCiAt）
  if (ciState === 'failure') {
    return {
      verdict: 'contra',
      source: 'ci-red',
      why: failed ? `CI 没通过：${failed}` : 'CI 没通过',
    };
  }

  // 以下都要"新鲜"的结论：CI 状态是会变的，旧结论不能拿来当今天的证据
  if (stale) {
    return {
      verdict: 'none',
      source: null,
      why: ciState ? 'CI 结论过期（巡检没跑了？）' : '还没查过 CI',
    };
  }

  // ③ CI 全绿 + PR 还开着：代码推了、门禁过了、等人合并/验收
  if (ciState === 'success' && prState === 'open') {
    return { verdict: 'strong', source: 'ci-green', why: 'CI 全绿（自动检查全过），PR 还没合' };
  }

  if (ciState === 'success' && !prState) {
    // 有 CI 结论却没有 PR 状态：多半是列被手改过 —— 不当证据，但要说得出来
    return { verdict: 'none', source: null, why: '只有 CI 结论，不知道 PR 状态' };
  }

  if (ciState === 'pending') {
    return { verdict: 'pending', source: 'ci-pending', why: 'CI 还在跑' };
  }

  return { verdict: 'none', source: null, why: ciState === 'none' ? '这个仓库没配自动检查' : '没有可用证据' };
}

/** 写进卡描述那一行的人话（`[证据推进] …`）；调用方负责拼前缀 */
export function evidenceNote(ev, { pushed = true } = {}) {
  const head = ev?.why ?? '有客观证据';
  const tail = pushed
    ? '按客观证据转到「待验收」（这一轮没交回 [完成] 声明）；验收还是你说了算'
    : '（验收还是你说了算）';
  return `${head} → ${tail}`;
}
