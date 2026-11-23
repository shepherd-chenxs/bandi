/**
 * 回归跑法与「一轮运行」之间的两处约定，抽成纯函数便于单测（2026-11-22 收口）。
 *
 * 这里**不放题面、不放判据**（那是 suite.mjs 的事），只回答一个问题：
 * 库里那一行 run，什么时候才算「真的收尾了、可以拿去判」。
 *
 * 踩过的坑：只看 status 会读到一个**中间态**。
 *   reapStaleRuns() 先写  status='failed', claim='interrupted'（启动清账的暂定结论）
 *   旧实例跑完 finishRun() 再写 status='failed', claim='silent'（真实落款）
 * status 从头到尾都是 failed，只看 status 的「稳定 6 秒」一到就收工，
 * 量具拿到的是 interrupted，把一轮其实走完收尾的题错记成「不作数」。
 * 所以终态指纹必须带上 claim：两次写入指纹不同 → 重新计时 → 等真落款落定。
 */

/** 库里 runs.status 的终态。running / queued 都不是。 */
export const TERMINAL = ['done', 'failed', 'stopped'];

/** 终态要「稳定成立」这么久才算数（同 b0a9b81 的口径）。 */
export const SETTLE_MS = 6000;

/**
 * 一行 run 的终态指纹。返回 null = 还没到终态。
 * claim 一起进指纹 —— 这是 2026-11-22 第四次跑补上的那一半。
 */
export function terminalFingerprint(row) {
  if (!row || !TERMINAL.includes(row.status)) return null;
  return `${row.status}|${row.claim ?? ''}`;
}

/**
 * 稳态状态机推进一步。
 *
 * @param {{key: string|null, since: number}} prev 上一拍的状态
 * @param {{status: string, claim?: string|null}|null} row 这一拍从库里读到的行
 * @param {number} nowMs 这一拍的时间（Date.now()）
 * @returns {{key: string|null, since: number, done: boolean}}
 *   done=true 表示终态已稳定 SETTLE_MS，可以收工去抽事件/判题了。
 */
export function settleStep(prev, row, nowMs) {
  const key = terminalFingerprint(row);
  if (key === null) return { key: null, since: 0, done: false }; // 还在跑，任何已稳定的判断作废
  if (prev.key !== key) return { key, since: nowMs, done: false }; // 指纹变了，重新计时
  return { key, since: prev.since, done: nowMs - prev.since >= SETTLE_MS };
}

/**
 * 启动时要不要跑 reapStaleRuns()（把库里 running 的遗留运行判死）。
 *
 * **回归实例必须跳过**（2026-11-22 第四次跑的根因）：回归用的是一次性的临时库，
 * 本来就没有「上一次进程留下的僵尸 running」。而 `agentEnv()` 把整个 process.env
 * 传给员工 CLI —— 员工照岗位判据跑 `node tools/run-smokes.mjs` 时，冒烟里那些
 * 测「服务启停」的用例会起**新的 server 实例**，继承同一个 BANDI_DATA，
 * 启动时 reapStaleRuns() 就把回归实例**正在跑**的那轮判成 interrupted。
 *
 * 开关沿 env 传染到整棵子进程树，所以整棵树里任何实例都不清账；真实 18787
 * 不设这个变量，行为完全不变（它确实需要启动清账来收拾崩溃遗留）。
 */
export function shouldReapOnBoot(env = process.env) {
  return env.BANDI_SKIP_REAP !== '1';
}
