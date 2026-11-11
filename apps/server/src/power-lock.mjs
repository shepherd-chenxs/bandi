/* src/power-lock.mjs —— 任务运行期间的系统电源锁（2026-11-11，卡 pt-bfe8e476）。
 *
 * 【为什么要有这个】无人值守时 Windows 按电源计划把机器睡进 S0 现代待机（本机实测：
 * 电池档空闲 180 秒就睡），进程冻结、网络断，正在跑的 run 直接断（Kernel-Power 506
 * 「Idle Timeout」日志可查）。这里替「有活在跑」这件事向系统申报电源请求，活收尾就还。
 *
 * 【实现】起一个 PowerShell 守护子进程，P/Invoke PowerCreateRequest +
 * PowerSetRequest(PowerRequestSystemRequired) 持住"系统别睡"。
 *   · 为什么子进程而不是进程内调 SetThreadExecutionState：服务端刻意零 npm 依赖，
 *     没有 FFI 可用；koffi 这类原生包不在打包链里（stage-runtime 会覆盖 runtime 目录）。
 *   · 为什么子进程更稳：Windows 在进程死亡时**无条件**回收它名下的电源请求 ——
 *     守护进程无论怎么死（服务被杀、崩溃、断电恢复），都不会把"不许睡"泄漏成
 *     "永远不睡"。这正是 Power Request API 比注册表/电源计划改动干净的地方。
 *
 * 【协议】守护进程持锁成功后往 stdout 打一行 READY；然后阻塞读 stdin，EOF 即
 * PowerClearRequest + 退出。服务端这头：acquire = 引用计数 +1（首个就 spawn、等
 * READY）；release = 计数 -1，归零就关 stdin（守护进程自己干净退出），3 秒没走
 * 强杀兜底。服务进程本身死掉时 stdin 管道随之关闭，守护进程照样收摊。
 *
 * 【降级】非 Windows、powershell.exe 起不来、READY 超时 —— 一律降级为"没有锁"，
 * 任务照跑，只记一条 warn。锁是锦上添花，不能变成任务的启动闸。
 *
 * 【挂点】runs.mjs：runOnce 前 acquire，finish() 里 release（finish 是所有运行的
 * 唯一终点，无论正常收尾/停止/看门狗强杀都会路过）。并发多个 run 靠引用计数，
 * 最后一个收尾的负责还锁。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './config.mjs';

/** 守护进程脚本落点：放数据目录（跟着实例走、不被 tmp 清理扫掉），幂等重写 */
const KEEPER_PATH = path.join(dataDir, 'power-keeper.ps1');

/** PowerRequestSystemRequired 的枚举值（winnt.h / powerbase） */
const POWER_REQUEST_SYSTEM_REQUIRED = 1;

const KEEPER_SRC = /* powershell */ `$ErrorActionPreference = 'Stop'
$src = @"
using System;
using System.Runtime.InteropServices;
public static class BandiPwr {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct REASON_CONTEXT {
    public uint Version;      // POWER_REQUEST_CONTEXT_VERSION_SIMPLE = 0
    public uint Flags;        // POWER_REQUEST_CONTEXT_SIMPLE_STRING = 1
    public string SimpleReasonString; // union 的 s 成员，落偏移 8
  }
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr PowerCreateRequest(ref REASON_CONTEXT context);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool PowerSetRequest(IntPtr handle, int request);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool PowerClearRequest(IntPtr handle, int request);
}
"@
Add-Type -TypeDefinition $src | Out-Null
$rc = New-Object BandiPwr+REASON_CONTEXT
$rc.Version = 0
$rc.Flags = 1
$rc.SimpleReasonString = 'bandi: task running (power-lock)'
$h = [BandiPwr]::PowerCreateRequest([ref]$rc)
if ($h -eq [IntPtr]::Zero) { throw "PowerCreateRequest failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
if (-not [BandiPwr]::PowerSetRequest($h, ${POWER_REQUEST_SYSTEM_REQUIRED})) { throw "PowerSetRequest failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
[Console]::Out.WriteLine('READY')
$null = [Console]::In.ReadToEnd()   # 阻塞到 stdin EOF（服务端收锁/进程死亡）
[void][BandiPwr]::PowerClearRequest($h, ${POWER_REQUEST_SYSTEM_REQUIRED})
`;

/* ---- 状态（模块级；服务端单进程，无并发竞争面） ------------------------- */
let refs = 0; // 持锁的 run 数
let keeper = null; // ChildProcess | null
let readyPromise = null; // 最近一次 spawn 的 READY 等待

const isWindows = () => process.platform === 'win32';
const log = (...a) => console.log('[power-lock]', ...a);
const warn = (...a) => console.warn('[power-lock]', ...a);

function powershellExe() {
  return path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  );
}

/** 起守护进程并等 READY；readyPromise 供观察/测试，不阻塞调用方 */
function ensureKeeper() {
  if (keeper) return;
  try {
    fs.writeFileSync(KEEPER_PATH, KEEPER_SRC, 'utf8'); // 幂等：内容固定，覆盖无害
  } catch (e) {
    warn('守护脚本写不进去（照样试跑）：', e?.message ?? e);
  }
  const child = spawn(powershellExe(), [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', KEEPER_PATH,
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

  readyPromise = new Promise((resolve) => {
    let buf = '';
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    child.stdout.on('data', (d) => {
      buf += String(d);
      if (buf.includes('READY')) done(true);
    });
    child.stderr.on('data', (d) => warn('keeper stderr:', String(d).trim()));
    child.once('exit', () => {
      done(false); // 没等到 READY 就死 = 这次锁没成
      if (keeper === child) {
        keeper = null;
        // ref>0 时守护进程意外死亡：清掉引用，让下一次 acquire 重新 spawn
        if (refs > 0) warn(`守护进程提前退出（refs=${refs}），下次 acquire 会重起`);
      }
    });
    // READY 兜底超时：8 秒还不到就当起不来，杀掉降级（脚本首跑含 Add-Type 编译，放宽些）
    setTimeout(() => {
      if (!settled) {
        warn('READY 超时，降级为无锁');
        try { child.kill(); } catch { /* 歪了就算了 */ }
      }
    }, 8000).unref();
  });

  keeper = child;
  log(`守护进程已起 pid=${child.pid}（refs=${refs}）`);
}

/** 有活要跑：引用计数 +1，需要的话起守护进程。失败不抛 —— 锁不能挡活。 */
export function acquirePowerLock() {
  if (!isWindows()) return;
  refs++;
  ensureKeeper();
}

/** 一个 run 收尾：计数 -1，归零就还锁。多调无害（幂等归零）。 */
export function releasePowerLock() {
  if (!isWindows()) return;
  if (refs > 0) refs--;
  if (refs > 0 || !keeper) return;
  const child = keeper;
  keeper = null;
  readyPromise = null;
  log(`最后一个 run 收尾，还锁（pid=${child.pid}）`);
  // 优雅路线：关 stdin，守护进程读到 EOF 自己 PowerClearRequest + 退出
  try { child.stdin.end(); } catch { /* 歪了走强杀 */ }
  // 兜底：3 秒还没走就杀 —— 进程死了 Windows 一样回收请求
  const killer = setTimeout(() => {
    try { if (!child.killed) child.kill(); } catch { /* 尽人事 */ }
  }, 3000);
  child.once('exit', () => clearTimeout(killer));
}

/** 观察口：测试和验收用（refs>0 且守护进程活着 = 锁在手） */
export function powerLockState() {
  return { held: refs > 0 && !!keeper, refs, keeperAlive: !!keeper };
}

/** 测试/自检用：等最近一次 spawn 的 READY 结果（true=锁已申报到系统） */
export function powerLockReady() {
  return readyPromise ?? Promise.resolve(!!keeper);
}
