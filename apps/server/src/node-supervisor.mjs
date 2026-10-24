/**
 * 节点子进程的起停与单实例锁（2026-10-20，设计 §4.5 / §6.6；T03-2）。
 *
 * 为什么需要锁：这台机器上可能同时存在两个"想跑节点"的入口 —— autostart 装的常驻、
 * 瘦客户端要 spawn 的那份。没有锁就是两个进程对着同一枚令牌心跳，总机上看着一切
 * 正常，领活却会被两边抢。锁是**每数据目录一把**（`<数据目录>/node.lock`），
 * `node.mjs` 自己也拿同一把 —— 谁后到谁退，与谁拉起的无关。
 *
 * 本模块只碰 `node.lock` 与子进程句柄，不 import store —— `node.mjs` 要 import 它。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { dataDir, repoRoot } from './config.mjs';
import { killPid, processInfo } from './lifecycle.mjs';

const LOCK_FILE = path.join(dataDir, 'node.lock');
const NODE_ENTRY = path.join(repoRoot, 'apps', 'server', 'src', 'node.mjs');

/** 锁文件路径（`<数据目录>/node.lock`，与设计 §4.5 一致） */
export function lockPath() {
  return LOCK_FILE;
}

/** pid 活着吗。`EPERM` 也算活（别的用户/权限下的进程，kill 探测会被拒） */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

/** 读锁文件原始内容；没有 / 坏了 / pid 不可解析 → null */
function readLockFile() {
  try {
    const j = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    const pid = Number(j?.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { pid, startedAt: j.startedAt ?? null, controlPlane: j.controlPlane ?? null };
  } catch {
    return null;
  }
}

/**
 * 锁的现状（supervisor 与 `/api/local/status` 都用它）。
 * `stale:true` = 有锁文件但那个 pid 已经死了（上次没来得及放锁 —— 崩溃 / 断电）。
 */
export function readLock() {
  const lock = readLockFile();
  if (!lock) return { running: false, pid: null, stale: false };
  if (pidAlive(lock.pid)) return { running: true, pid: lock.pid, stale: false };
  return { running: false, pid: lock.pid, stale: true };
}

/**
 * 拿单实例锁。
 *
 * 原子创建（`'wx'`）成功 → 写 `{pid, startedAt, controlPlane}` 返回 `{locked:true}`；
 * 撞上 `EEXIST` → 读旧锁用 `process.kill(pid,0)` 判活：活着返回 `{locked:false, pid}`
 * （**正常情形**，不是错误）；死了（抛 `ESRCH`）删掉重试一次 —— 最多两轮。
 *
 * @param {{ controlPlane?: string|null }} [extra] 顺带记进锁里，排查时一眼看到"在跟谁跑"
 * @returns {{ locked: boolean, pid: number|null }}
 */
export function acquireLock(extra = {}) {
  const record = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    ...(extra?.controlPlane ? { controlPlane: String(extra.controlPlane) } : {}),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd;
    try {
      fd = fs.openSync(LOCK_FILE, 'wx');
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e; // 目录没了之类 —— 真错误，往上抛
      const old = readLockFile();
      if (old && pidAlive(old.pid)) return { locked: false, pid: old.pid };
      // 死锁（或读不出来）：删掉重试一次。第二轮 `wx` 还抢不到就认输。
      try {
        fs.rmSync(LOCK_FILE, { force: true });
      } catch { /* 删不掉就再试一次，让 'wx' 自己说话 */ }
      continue;
    }
    try {
      fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    return { locked: true, pid: process.pid };
  }
  const final = readLockFile();
  return { locked: false, pid: final ? final.pid : null };
}

/**
 * 放锁。**只删自己 pid 的那份** —— 拿着别人的锁删掉，等于替别人放行（双跑就是这么来的）。
 */
export function releaseLock() {
  const lock = readLockFile();
  if (!lock || lock.pid !== process.pid) return false;
  try {
    fs.rmSync(LOCK_FILE, { force: true });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ 起停 */

let child = null; // **我们自己 spawn 的**那个子进程
let childPid = null;

/** 我们 spawn 的孩子还活着吗（`exitCode === null` = 还没退） */
function ownChildAlive() {
  return !!(child && childPid && child.exitCode === null && child.signalCode === null);
}

/**
 * 起节点进程。
 *
 * ⚠️ **锁是唯一的裁判**：`readLock()` 见到活进程就**不 spawn**，返回
 * `{running:true, external:true}` —— 那是"autostart 已经在跑"的**正常情形**，
 * 别当错误、别报红（设计 §4.5 最后一条）。
 *
 * spawn 的环境**原样继承**本进程的（含 `BANDI_DATA` —— 用例的临时目录因此天然传下去）。
 */
export function start() {
  const lock = readLock();
  if (lock.running) {
    return { running: true, pid: lock.pid, external: lock.pid !== childPid };
  }
  if (ownChildAlive()) {
    // spawn 已发出、孩子还没来得及拿锁的窗口期：以孩子为准，绝不双 spawn
    return { running: true, pid: childPid, external: false };
  }
  if (lock.stale) {
    try {
      fs.rmSync(LOCK_FILE, { force: true });
    } catch { /* 孩子手里的 acquireLock 也会清它，这里尽力而为 */ }
  }
  child = spawn(process.execPath, [NODE_ENTRY], {
    env: { ...process.env },
    detached: false, // 跟着本进程走：控制面退出，spawn 的节点也不该留下来用旧令牌
    stdio: 'ignore', // 它的日志没有观众（控制面日志里也看不懂节点的那套），别占管道
    windowsHide: true,
  });
  childPid = child.pid;
  child.on('exit', () => {
    child = null;
    childPid = null;
  });
  child.on('error', () => {
    child = null;
    childPid = null;
  });
  return { running: true, pid: childPid, external: false };
}

/**
 * 停节点。**只杀自己 spawn 的孩子**：
 *   · 是我们的孩子 → SIGTERM，3 秒后还活着补 SIGKILL（给它留出放锁、收尾的时间）；
 *   · 是别人拉起的（autostart 常驻）→ **一律不杀**，返回 `{stopped:false, external:true}`，
 *     让上层提示"要停请用 autostart remove"。
 */
export function stop() {
  if (ownChildAlive()) {
    const pid = childPid;
    try {
      child.kill('SIGTERM');
    } catch { /* 已经退了 */ }
    const killer = setTimeout(() => {
      try {
        process.kill(pid, 'SIGKILL');
      } catch { /* 已经退了 —— 这正是我们想要的 */ }
    }, 3000);
    killer.unref?.();
    child = null;
    childPid = null;
    return { stopped: true, killed: true, pid };
  }
  const lock = readLock();
  if (lock.running) return { stopped: false, external: true, pid: lock.pid };
  return { stopped: false, external: false, pid: lock.pid ?? null };
}

/**
 * 停掉**外部拉起**的节点（autostart 常驻那只）—— 2026-10-21 补。
 *
 * `stop()` 按"绝不乱杀"的纪律拒收外部进程，于是「退出总机」看起来成功、节点却还在跑
 * （拿刚清掉的令牌空转，用户实报）。退出总机是明确的"不再当节点"，调用方已先移除自启登记，
 * 这里按**锁里的 PID** 收尾。
 *
 * 安全：锁文件可能过期。能读到命令行时**必须**确认是 node.mjs；读不到（环境退化）
 * 就按记录处理 —— 这是本机自己的锁，不是猜别人的进程（同 `lifecycle.stopPid` 的纪律）。
 */
export function stopExternal() {
  const lock = readLock();
  if (!lock.running) return { stopped: false, running: false, pid: lock.pid ?? null };
  if (lock.pid === childPid) return { stopped: false, running: false, pid: lock.pid ?? null };
  const info = processInfo(lock.pid);
  if (info.cmd && !/node\.mjs/i.test(info.cmd)) {
    return { stopped: false, running: true, external: true, mismatch: info.cmd, pid: lock.pid };
  }
  return { stopped: killPid(lock.pid), running: true, external: true, pid: lock.pid };
}

/**
 * 现状（`/api/local/status` 的 `client.node` 就用它）。
 * `external:true` = 在跑但不是我们 spawn 的（autostart 常驻）。
 */
export function status() {
  const lock = readLock();
  if (lock.running) {
    return { running: true, pid: lock.pid, external: lock.pid !== childPid, stale: false };
  }
  if (ownChildAlive()) {
    // 孩子还没拿到锁的窗口期：它马上就是"在跑"
    return { running: true, pid: childPid, external: false, stale: false };
  }
  return { running: false, pid: lock.pid ?? null, external: false, stale: lock.stale };
}
