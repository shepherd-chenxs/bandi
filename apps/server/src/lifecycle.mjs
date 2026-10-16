/**
 * 控制面的**起停** —— 只写一份。
 *
 * 谁在用：`start.mjs`（命令行双击）与 `shell.mjs`（桌面薄壳）。
 * 为什么抽出来：壳要做的是**同一件事**（看看是不是已经在跑、端口被谁占、是不是我们自己的、
 * 僵死才重启、等健康、退出时收掉）。各写一份必然两边跑偏 —— 就像前端当初那两套。
 *
 * **关键安全约束（从第一版起就没变）**：只结束**我们自己的**服务。
 * 端口被别的程序占着时绝不乱杀，报清楚就停。
 *
 * 2026-10-15 起**跨平台**：以前只有 `netstat` + `taskkill` 那套 Windows 逻辑，
 * 而控制面已经跑在 Linux 上了（见 `deploy/README.md`）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { repoRoot } from './config.mjs';

export const SERVER_ENTRY = path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs');

/**
 * 判"这个进程是不是我们的"：命令行里有没有我们**特有的入口后缀**。
 * 不用"包含仓库绝对路径"：启动方式不同，命令行可能是相对路径（老 start.cmd 就是），
 * 那种会漏判。这个后缀对绝对/相对都成立，又比裸的 server.mjs 精确得多 ——
 * 别的项目也叫 server.mjs 的情况很常见。
 * 判不出来就当成"不是我们的"，**绝不猜着杀**。
 */
const ENTRY_SUFFIX = path.join('apps', 'server', 'src', 'server.mjs').toLowerCase();

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const urlOf = (port) => `http://127.0.0.1:${port}`;

/**
 * 探一个**只有班底才有的接口**，而不是只看首页 200。
 * 只看 200 的话，任何别的 HTTP 服务都会被误判成"平台已经在跑"。
 *
 * ⚠️ 这里问的是"**端口上坐着一个班底控制面吗**"，不是"我们能不能读它的状态"。
 * 所以 **401 也算"是"**：开了鉴权的控制面会把 `/api/state` 挡成 401，但它确实在那儿。
 * 不认这一条，启动器就会把它当成"没起来"（于是再起一个）或"僵死的自己人"（于是杀掉重启）——
 * 那是真会把现场搞乱的。服务端在 401 的正文里带了 `platform: 'bandi'`，就是给这里认的。
 */
export async function isUp(port, timeoutMs = 1500) {
  try {
    const r = await fetch(urlOf(port) + '/api/state', { signal: AbortSignal.timeout(timeoutMs) });
    const j = await r.json().catch(() => null);
    if (r.status === 401) return j?.platform === 'bandi';
    if (!r.ok) return false;
    return Array.isArray(j?.personas);
  } catch {
    return false;
  }
}

/**
 * 谁在监听这个端口（返回 **PID 数字数组**）。Windows 走 netstat，*nix 走 lsof，再退到 ss。
 *
 * ⚠️ 一律返回**数字**：以前这里返回字符串、而 `processInfo().pid` 是数字，
 * 于是"这两个 PID 是不是同一个"这种比较在两边写法不同就会静默判错（实测踩到）。
 */
export function listeners(port) {
  const pids = new Set();
  const add = (s) => {
    const v = String(s).trim();
    if (/^\d+$/.test(v) && v !== '0') pids.add(Number(v));
  };

  if (process.platform === 'win32') {
    let out = '';
    try {
      out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true });
    } catch {
      return [];
    }
    for (const line of out.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      // 必须精确匹配 :8787，别把 :87870 也算进来
      if (!new RegExp(`[:.]${port}\\s`).test(line)) continue;
      add(line.trim().split(/\s+/).pop());
    }
    return [...pids];
  }

  // lsof 最干净：直接给 PID
  try {
    const out = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
    for (const l of out.split('\n')) add(l);
    if (pids.size) return [...pids];
  } catch { /* 没装 lsof / 没结果 */ }

  try {
    const out = execFileSync('ss', ['-ltnp'], { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      if (!new RegExp(`[:.]${port}\\s`).test(line)) continue;
      for (const m of line.matchAll(/pid=(\d+)/g)) add(m[1]);
    }
  } catch { /* 没装 ss */ }

  return [...pids];
}

/** 这个 PID 是什么进程。取不到就返回空 cmd —— 上层会当成"不是我们的" */
export function processInfo(pid) {
  try {
    if (process.platform === 'win32') {
      const q = (cmd) =>
        execFileSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', windowsHide: true }).trim();
      return {
        pid: Number(pid),
        cmd: q(`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`),
        name: q(`(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).ProcessName`),
      };
    }
    // Linux：cmdline 是 NUL 分隔的
    try {
      const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      return { pid: Number(pid), cmd: raw.split('\0').join(' ').trim(), name: '' };
    } catch {
      // macOS / 其它：没有 /proc
      const out = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
      return { pid: Number(pid), cmd: out, name: '' };
    }
  } catch {
    return { pid: Number(pid), cmd: '', name: '' };
  }
}

export function isOurs(info) {
  if (!info?.cmd) return false;
  return info.cmd.toLowerCase().replace(/\//g, '\\').includes(ENTRY_SUFFIX);
}

export function killPid(pid) {
  try {
    if (process.platform === 'win32') {
      // /T 连子进程一起收：控制面会 spawn agent CLI，留孤儿会继续花额度、继续改文件
      execFileSync('taskkill', ['/PID', String(pid), '/F', '/T'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(Number(pid), 'SIGTERM');
    }
    return true;
  } catch {
    return false;
  }
}

export async function waitPortFree(port, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!listeners(port).length) return true;
    await sleep(300);
  }
  return !listeners(port).length;
}

export async function waitHealthy(port, ms = 30000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await isUp(port, 1200)) return true;
    await sleep(400);
  }
  return false;
}

/**
 * 起一个**脱离当前进程**的服务：终端关了、壳关了，它都还在。
 *
 * `dataDir` 只在给了的时候才设 `BANDI_DATA` —— 不设就还是 `<仓库>/data`，
 * 与命令行那条路的行为完全一致（桌面壳会显式指到用户目录，见 docs/形态决策.md §十二）。
 */
export function startDetached({ port, dataDir, logFile, extraEnv = {} }) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, 'a');
  const env = { ...process.env, BANDI_PORT: String(port), ...(dataDir ? { BANDI_DATA: dataDir } : {}), ...extraEnv };
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: repoRoot,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
    env,
  });
  child.unref();
  return child.pid;
}

/**
 * 保证控制面在跑。四种结果，调用方照着自己那套话术去说：
 *
 *   `{ action: 'already' }`  已经在跑（是我们自己的）—— 直接用，不重启
 *   `{ action: 'started' }`  刚起来
 *   `{ action: 'alien' }`    端口被**别的程序**占着 —— 一个都没动它
 *   `{ action: 'failed' }`   没起来（带日志尾部）
 *
 * `force` = 强制重启：即便是我们自己的、正在跑的，也先收掉再起
 * （会打断正在跑的活 —— 见 docs/形态决策.md「重启的代价」）。
 */
export async function ensureRunning({ port, dataDir, logFile, force = false, extraEnv = {} }) {
  const url = urlOf(port);
  const held = listeners(port);
  const up = await isUp(port);

  if (up && !force) return { action: 'already', url, pids: held };

  let replaced = [];
  // 端口上是**我们自己的**、而且它还响应 → 那是"强制重启"；不响应 → 判"僵死"。
  // 这两种说法不一样，调用方要照着说（一个是"你让我重启的"，一个是"它卡死了"）。
  let forced = false;
  if (held.length) {
    const infos = held.map(processInfo);
    const ours = infos.filter(isOurs);
    const alien = infos.filter((i) => !isOurs(i));
    if (alien.length) return { action: 'alien', url, alien, ours };
    replaced = ours.map((o) => o.pid);
    forced = up;
    for (const o of ours) killPid(o.pid);
    if (!(await waitPortFree(port))) {
      return { action: 'failed', url, reason: `端口没释放，占用者：${listeners(port).join(', ') || '(读不到)'}` };
    }
  }

  const pid = startDetached({ port, dataDir, logFile, extraEnv });
  if (!(await waitHealthy(port))) {
    let logTail = '';
    try {
      logTail = fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/).slice(-15).join('\n');
    } catch { /* 没日志就算了 */ }
    return { action: 'failed', url, pid, reason: '30 秒内没起来', logTail };
  }
  return { action: 'started', url, pid, replaced, forced };
}

/**
 * 停掉**我们自己的**控制面。不认识的进程一个都不碰。
 * 返回 `{ stopped, alien }`：`alien > 0` 说明这个端口上还坐着别人的东西。
 */
export function stopRunning(port) {
  const infos = listeners(port).map(processInfo);
  const ours = infos.filter(isOurs);
  for (const o of ours) killPid(o.pid);
  return { stopped: ours.length, alien: infos.filter((i) => !isOurs(i)).length };
}

/**
 * 停掉**一个具体的 PID** —— 用于"我自己刚起的那个"。
 *
 * 为什么不图省事复用 `stopRunning(port)`：那要先问"端口上是谁、是不是我们的"，
 * 而这个判断在 Windows 上依赖 `powershell` 去读命令行。**环境一退化**
 * （PATH 被裁剪、powershell 起不来）就读不到 → 保守判成"外人" →
 * **于是拒绝清理自己刚起的进程，留下一个孤儿控制面**（2026-10-15 实测踩到）。
 *
 * 自己起的进程，**PID 本身就是最可靠的凭据**：记着它，按它收。
 * 命令行核对降级为"能读到就再确认一下"，读不到就按记录处理。
 */
export function stopPid(pid) {
  if (!pid) return { stopped: false, verified: 'no-pid' };
  const info = processInfo(pid);
  if (info.cmd && !isOurs(info)) return { stopped: false, verified: 'mismatch', cmd: info.cmd };
  return { stopped: killPid(pid), verified: info.cmd ? 'match' : 'unknown' };
}
