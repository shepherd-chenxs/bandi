/**
 * 进程树清理（2026-11-20）。
 *
 * 为什么需要这一层：
 *   · 数字员工跑起来的是一个 CLI 子进程，CLI 自己又会起命令子进程（node / cmd / 构建脚本）。
 *   · CLI 失败退出时，平台只看到 CLI 的退出码，**不会自动带走它起的进程** ——
 *     Windows 上父进程结束不等于子进程结束，孙进程可能继续占着端口、文件锁和 stdout 管道。
 *   · 结果就是用户实报的那一幕：**子进程还在跑，任务已经报失败**，重跑还会和残留进程打架。
 *
 * 所以失败收尾时按 root PID 把整棵树收掉。Windows 先走 taskkill /T（父子关系还完整时最快），
 * 不行再用 PowerShell 按 ParentProcessId 递归找（父已退出、树关系还在时兜底）；Unix 走 ps 构树。
 *
 * 只做"尽力清理"：查不到就如实返回空列表，绝不让清理失败影响 run 收尾。
 */
import { execFile } from 'node:child_process';

const WIN = process.platform === 'win32';
const PS_TIMEOUT_MS = 5000;

function runFile(file, args, timeout = PS_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/** PowerShell 传参：把整数塞进脚本，避免再拼一层引号 */
function winPidList(rootPid) {
  return runFile('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    [
      '$ErrorActionPreference="SilentlyContinue"',
      '$all=Get-CimInstance Win32_Process',
      `$root=[int]${rootPid}`,
      '$seen=@()',
      '$q=@($root)',
      'while($q.Count -gt 0){',
      '  $p=$q[0]',
      '  if($q.Count -eq 1){$q=@()}else{$q=$q[1..($q.Count-1)]}',
      '  foreach($c in $all){',
      '    $cid=[int]$c.ProcessId',
      '    if([int]$c.ParentProcessId -eq $p -and ($seen -notcontains $cid)){$seen+=$cid;$q+=$cid}',
      '  }',
      '}',
      '$ids=@($root)+$seen',
      '$live=@()',
      'foreach($x in $ids){',
      '  if(Get-Process -Id $x -ErrorAction SilentlyContinue){$live+=$x;Stop-Process -Id $x -Force -ErrorAction SilentlyContinue}',
      '}',
      '$live -join ","',
    ].join(';'),
  ]);
}

function parsePidList(s) {
  return String(s)
    .split(/[,\s]+/)
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isInteger(x) && x > 0);
}

async function killWindows(rootPid) {
  /*
   * 先按 PPID 构树（父子关系还在、父已退出都能用），PID 列表也最准 ——
   * 日志里写"清理了哪几个进程"必须是真的被停掉的，不能把 taskkill 输出里的
   * 容器 PID 也当成本次清理对象（实测那会把调用方自己记进去）。
   */
  const ps = await winPidList(rootPid);
  if (!ps.err) return { ok: true, killed: parsePidList(ps.stdout), method: 'powershell' };

  // PowerShell 不可用（执行策略/被裁掉）时的兜底：父进程还活着，taskkill /T 能连树拔
  const tk = await runFile('taskkill', ['/PID', String(rootPid), '/T', '/F']);
  if (!tk.err) return { ok: true, killed: [rootPid], method: 'taskkill' };
  return { ok: false, killed: [], method: 'none', error: String(tk.err.message ?? tk.err) };
}

async function killUnix(rootPid) {
  const ps = await runFile('ps', ['-A', '-o', 'pid=,ppid=']);
  if (ps.err) return { ok: false, killed: [], method: 'none', error: String(ps.err.message ?? ps.err) };
  const parent = new Map();
  for (const line of ps.stdout.split(/\r?\n/)) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) parent.set(pid, ppid);
  }
  const kids = new Map();
  for (const [pid, ppid] of parent) {
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  const tree = [];
  const queue = [...(kids.get(rootPid) ?? [])];
  while (queue.length) {
    const pid = queue.shift();
    tree.push(pid);
    queue.push(...(kids.get(pid) ?? []));
  }
  const killed = [];
  for (const pid of [...tree.reverse(), rootPid]) {
    try {
      process.kill(pid, 'SIGTERM');
      killed.push(pid);
    } catch {
      /* 已经退了 */
    }
  }
  return { ok: true, killed, method: 'ps' };
}

/**
 * 把 rootPid 及其后代全部收掉。
 * @param {number} rootPid CLI 进程的 PID（spawn 那一刻拿到的）
 * @returns {Promise<{ok:boolean, killed:number[], method:string, error?:string}>}
 */
export async function killProcessTree(rootPid) {
  const pid = Number(rootPid);
  if (!Number.isInteger(pid) || pid <= 0) return { ok: true, killed: [], method: 'none' };
  try {
    return WIN ? await killWindows(pid) : await killUnix(pid);
  } catch (e) {
    return { ok: false, killed: [], method: 'none', error: String(e?.message ?? e) };
  }
}
/** 收尾日志：三个适配器共用一处格式，别各写一句（2026-11-20） */
export function logCleanup(tag, result) {
  if (!result) return;
  if (result.killed?.length) {
    console.warn(`[${tag}] 失败收尾：清理残留进程 ${result.killed.join(', ')}（${result.method}）`);
  } else if (result.ok === false) {
    console.warn(`[${tag}] 失败收尾：清理进程树失败 —— ${result.error ?? '没有原因'}`);
  }
}