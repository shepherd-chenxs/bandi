/**
 * 实例锁：判断「这个数据目录此刻是不是只有我一个服务实例在用」。
 *
 * 为什么要有它（2026-11-22 回归实踩）：启动清账 `reapStaleRuns()` 扫的是**全库**的
 * `running` 并一律判死。回归集用一次性临时库，但 `agentEnv()` 会把 `BANDI_DATA` 传给
 * 员工 CLI；员工照岗位判据跑 `run-smokes` 时，冒烟里测「服务启停」的用例会另起一个
 * server、继承同一个库 —— 它一启动就把回归实例**正在跑**的那轮判成 interrupted。
 * 以前靠 `BANDI_SKIP_REAP=1` 让调用方自觉，这里把「能不能清账」变成可判的事实。
 *
 * 口径：
 *   · 锁里记着的 pid 活着、又不是自己 → 共库多实例，调用方跳过清账与僵尸卡恢复；
 *   · 锁不存在 / 内容坏了 / pid 已死 → 独占（崩溃残留的锁会被自己接管）；
 *   · 写不了锁（只读目录）→ 按独占处理（保持旧行为），只打一行警告。
 *
 * 边界：旧版本进程不写这个锁，所以「新旧混跑」判不出来 —— 同版本多实例才受保护。
 * 逃生口：`BANDI_FORCE_REAP=1` 强制接管（运维排障用；回归里不要设）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './config.mjs';

const FILE = path.join(dataDir, 'server.lock');

/** pid 还活着吗（signal 0 跨平台可用）。EPERM 说明进程在、只是不归我们管 → 视为活着。 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

function readLock() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return null; // 没有 / 坏了：两种都当「没有持有者」
  }
}

/**
 * 用 `wx` 独占创建：两个实例同时启动时也只有一个拿到锁（普通 write 会互相覆盖）。
 * 返回 true（拿到）/ 'busy'（有人持有）/ false（写不进去，如只读目录）。
 */
function claim(mine) {
  try {
    fs.writeFileSync(FILE, JSON.stringify(mine), { flag: 'wx' });
    return true;
  } catch (e) {
    if (e?.code !== 'EEXIST') return false;
    const other = readLock();
    if (other && other.pid !== process.pid && pidAlive(other.pid)) return 'busy';
    try {
      fs.unlinkSync(FILE);
    } catch { /* 竞态里被对手拿走 → 下面那次 wx 会落空 */ }
    try {
      fs.writeFileSync(FILE, JSON.stringify(mine), { flag: 'wx' });
      return true;
    } catch {
      return 'busy';
    }
  }
}

/**
 * 拿这个数据目录的实例锁。
 * @returns {{sole: boolean, holder: object|null, writable?: boolean}}
 *   `sole:true` 才允许跑启动清账；`sole:false` 时 `holder` 是占用者的锁内容。
 */
export function acquireInstanceLock() {
  const mine = { pid: process.pid, startedAt: new Date().toISOString() };
  const existing = readLock();
  const forced = process.env.BANDI_FORCE_REAP === '1';

  if (!forced && existing && existing.pid !== process.pid && pidAlive(existing.pid)) {
    return { sole: false, holder: existing };
  }
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch { /* 下面写锁会再报一次，不在这里重复刷屏 */ }
  if (forced && existing) {
    try {
      fs.unlinkSync(FILE);
    } catch { /* 已经被清掉了 */ }
  }

  const ok = claim(mine);
  if (ok === 'busy') return { sole: false, holder: readLock() };
  if (ok === false) {
    // 写不了锁 = 判不出有没有别人 → 退回旧行为（照常清账），但要让人看见。
    console.warn(`[实例锁] 写不了锁文件 ${FILE}（按独占处理，启动清账照旧）；排查多实例时注意这一行`);
    return { sole: true, holder: mine, writable: false };
  }
  process.once('exit', () => {
    try {
      const cur = readLock();
      if (cur && cur.pid === process.pid) fs.unlinkSync(FILE);
    } catch { /* 已经没了 / 被别人接管 */ }
  });
  return { sole: true, holder: mine };
}