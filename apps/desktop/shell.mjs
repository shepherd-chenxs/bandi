#!/usr/bin/env node
/**
 * 桌面薄壳的 **Node 那一半**。
 *
 * 分工：Rust 那半只管窗口与进程；"控制面起没起、要不要起、退出收不收"全在这儿 ——
 * 用的是 `apps/server/src/lifecycle.mjs`，**与 `start.cmd` 同一条实现**（不写第二份）。
 *
 * 与 `start.mjs` 的本质差别只剩**端口**（下面 `pickPort` 有长注释）：命令行的 8787 是
 * 给人用的约定，桌面版没人关心端口 —— 它只该**别撞上别人的程序、也别粘上别人的实例**。
 *
 * 数据目录两边**同一个默认**：本机用户目录（`apps/server/src/data-dir.mjs`）。桌面版不能
 * 塞安装目录 —— 否则用户机器上要么要管理员权限、要么升级被覆盖（docs/形态决策.md §十二 第 1 条）；
 * 要沙盒/临时/真实库，显式 `BANDI_DATA`。
 *
 * 与 Rust 那半的协议（stdout 只出协议行，人看的话都走 stderr，免得解析被搅）：
 *   `BANDI_SHELL READY <url> <0|1>`   1 = 是我们起的（退出要收），0 = 本来就在跑
 *   `BANDI_SHELL ALIEN <说明>`        端口被别的程序占着，我们没动它
 *   `BANDI_SHELL FAILED <说明>`       起不来
 *
 * 退出信号：stdin 收到一行 `STOP`，或 stdin 被关闭（壳没了），或 SIGTERM/SIGINT。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  ensureRunning,
  stopPid,
  isUp,
  isOurs,
  listeners,
  processInfo,
  urlOf,
} from '../server/src/lifecycle.mjs';
import { userDataDir } from '../server/src/data-dir.mjs';

/** 探测起点。桌面版**没有**"端口"这个概念要给人看，这里只是个起点。 */
const BASE_PORT = Number(process.env.BANDI_PORT_BASE ?? 8787);
/** 往上找多少个。20 个够用了；全被占着才报错。 */
const PROBE_RANGE = 20;

const emit = (line) => process.stdout.write(line + '\n');

/* 数据目录默认与命令行**同一份**（`userDataDir()`）；要沙盒/临时/真实库显式 `BANDI_DATA`。 */
const DATA = process.env.BANDI_DATA ? path.resolve(process.env.BANDI_DATA) : userDataDir();
const LOG = path.join(DATA, 'server.log');
const PORT_FILE = path.join(DATA, 'port');
const SHELL_LOG = path.join(DATA, 'shell.log');

/**
 * 人看的话一律走 stderr —— 但**正式安装包没有控制台**
 * （release 下 `windows_subsystem = "windows"`，stderr 等于扔进虚空）。
 * 所以同时落一份到数据目录的 `shell.log`：出问题时，这是唯一能看到"壳当时说了什么"的地方。
 */
const log = (s) => {
  const line = `[壳] ${s}\n`;
  process.stderr.write(line);
  try {
    fs.appendFileSync(SHELL_LOG, `${new Date().toISOString()} ${line}`);
  } catch { /* 写不了就算了，不能因为日志把启动搞挂 */ }
};

/**
 * 上次用的是哪个端口。记它不是为了"固定"，是为了**复用自己那一个实例**：
 * 第二次双击时应该聚焦到已经跑着的那个，而不是在隔壁端子上再起一个控制面
 * （两个控制面共用一个数据目录，是给自己找麻烦）。
 */
function readRecordedPort() {
  try {
    const n = Number(fs.readFileSync(PORT_FILE, 'utf8').trim());
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
  } catch {
    return null;
  }
}

function recordPort(port) {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(PORT_FILE, `${port}\n`, 'utf8');
  } catch { /* 写不了就算了：下次重新挑一个，不影响能不能跑 */ }
}

/**
 * 挑端口。**这是桌面版与命令行版的一处本质差别。**
 *
 * 命令行的 8787 是"人的约定" —— 你要知道去哪儿开浏览器、去连谁。桌面版没有这个约定：
 * 窗口是它自己开的，端口只是个内部细节。所以它可以、也应该自己挑。
 *
 * 对每个候选端口：
 *   · 上面是**我们自己的**实例而且在响应 → 用它（复用，`mode: 'reuse'`）；
 *   · 谁都没在听，或者听的是我们自己但已经僵死 → 用它（起，或让 lifecycle 重启）；
 *   · 听的是**别人的**程序 → **跳过**（不碰、不报错，看下一个）。
 *
 * 最后一条是关键：硬编码 8787 的桌面版，在"用户机器上恰好有别的程序占着 8787"时
 * 只剩一张错误页 —— 对不懂电脑的人是死路。自己挑就不会。
 */
async function pickPort() {
  const candidates = [];
  const recorded = readRecordedPort();
  if (recorded) candidates.push(recorded);
  for (let p = BASE_PORT; p < BASE_PORT + PROBE_RANGE; p++) {
    if (!candidates.includes(p)) candidates.push(p);
  }

  for (const port of candidates) {
    const pids = listeners(port);
    if (!pids.length) return { port, mode: 'fresh' }; // 空着 → 就在这儿起
    const infos = pids.map(processInfo);
    // 认不出来（读不到命令行等）也按"别人的"处理 —— 宁可换一个端口，也不误判成自己人
    if (!infos.every(isOurs)) continue;
    if (await isUp(port)) return { port, mode: 'reuse' };
    return { port, mode: 'fresh' }; // 自己的但僵死 → 交给 ensureRunning 收掉重起
  }
  return { port: 0, mode: 'none', error: `从 ${BASE_PORT} 往上找了 ${PROBE_RANGE} 个端口，全被别人占着` };
}

fs.mkdirSync(DATA, { recursive: true });
log(`数据目录 ${DATA}`);

/* ---------------------------------------------------------------- 定端口 */

let PORT = Number(process.env.BANDI_PORT ?? 0);
let mode = 'explicit';
if (!PORT) {
  const picked = await pickPort();
  if (picked.mode === 'none') {
    log(picked.error);
    emit(`BANDI_SHELL FAILED ${picked.error}`);
    process.exit(3);
  }
  PORT = picked.port;
  mode = picked.mode;
  recordPort(PORT);
}

log(
  `端口 ${PORT}（${
    mode === 'explicit' ? '环境变量指定的' : mode === 'reuse' ? '复用已有实例' : '自己挑的'
  }）`,
);
log(`控制面 ${urlOf(PORT)}`);

/* ---------------------------------------------------------------- 起控制面 */

const r = await ensureRunning({
  port: PORT,
  dataDir: DATA,
  logFile: LOG,
  /*
   * ⚠️ **不再写死 `BANDI_HOST: '127.0.0.1'`**（2026-10-16 改）。
   *
   * 原来那句是故意的（"壳只服务本机，别因为外面环境里塞了 BANDI_HOST 就把界面暴露出去" ✓）——
   * 但那让桌面版**永远当不了总机** ✗（别的机器连不进来）。现在这件事交给
   * 数据目录里的 `netmode.json`（设置里那个「允许局域网内的机器加入」开关 ✓）：
   * `config.mjs` 读它 → 桌面壳 / 开机自启 / 命令行**三种起法都按同一个开关走** ✓。
   * 开关默认**关** → 行为跟以前一模一样（只听回环、免鉴权）✓。
   */
  extraEnv: {},
});

/**
 * 窗口该开在哪个地址。
 *
 * ⚠️ 开了「允许局域网内的机器加入」之后，控制面就**要求令牌**了（"只看监听地址"那条规则 ✓）——
 * 于是桌面版自己那个窗口也会撞上登录页 ✗。壳能读到同一台机器上的令牌文件，
 * 所以直接把令牌带上：`?token=…` 会让服务端设好 Cookie 再跳回干净地址 ✓（那正是它的用途 ✓）。
 *
 * 只在**真被要求**时才带（拿 401 试探一下 ✓）：回环模式下带上它，地址栏里会留一串没用的令牌 ✗。
 */
async function windowUrl(url) {
  try {
    const probe = await fetch(`${url}/api/state`, { signal: AbortSignal.timeout(3000) });
    if (probe.status !== 401) return url;
  } catch {
    return url; // 探测不了就按原样开，别把壳卡在这儿
  }
  try {
    const token = fs.readFileSync(path.join(DATA, 'token'), 'utf8').trim();
    if (!token) return url;
    return `${url.replace(/\/$/, '')}/?token=${encodeURIComponent(token)}`;
  } catch {
    return url;
  }
}

const WINDOW_URL = r.url ? await windowUrl(r.url) : '';
if (WINDOW_URL !== r.url) log('这次要令牌（局域网模式）—— 已把令牌带进窗口地址，免登录');

if (r.action === 'already') {
  log(`已经在跑（PID ${(r.pids ?? []).join(', ')}）—— 复用；退出时**不停它**`);
  emit(`BANDI_SHELL READY ${WINDOW_URL} 0`);
} else if (r.action === 'started') {
  log(`起来了（PID ${r.pid}）—— 退出时会收掉`);
  emit(`BANDI_SHELL READY ${WINDOW_URL} 1`);
} else if (r.action === 'alien') {
  const who = (r.alien ?? []).map((a) => `PID ${a.pid} ${a.name ?? ''} ${a.cmd ?? ''}`.trim()).join(' | ');
  log(`端口 ${PORT} 被别的程序占着，我没动它：${who}`);
  emit(`BANDI_SHELL ALIEN 端口 ${PORT} 被别的程序占着：${who}`);
  process.exit(2);
} else {
  log(`没起来：${r.reason}`);
  if (r.logTail) log(r.logTail);
  emit(`BANDI_SHELL FAILED ${r.reason}`);
  process.exit(3);
}

/* ------------------------------------------------------------------ 收摊 */

let stopping = false;
function shutdown(why) {
  if (stopping) return;
  stopping = true;
  if (r.action === 'started' && r.pid) {
    /*
     * 按**记录下来的 PID** 收，而不是再问一遍"端口上是谁"。
     * 后者在 Windows 上要 `powershell` 读命令行，环境一退化就读不到，
     * 于是会把**自己刚起的进程**误判成外人、拒绝清理，留下孤儿（2026-10-15 实测踩到）。
     */
    const s = stopPid(r.pid);
    log(
      `退出（${why}）：停掉自己起的 PID ${r.pid} —— ${
        s.verified === 'match'
          ? '命令行核对过'
          : s.verified === 'unknown'
            ? '读不到命令行，按记录处理'
            : '命令行对不上，没动它'
      }`,
    );
  } else {
    log(`退出（${why}）：控制面不是我起的，留着不动`);
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  if (String(c).trim().split(/\s+/).includes('STOP')) shutdown('STOP');
});
// 壳要是直接没了，stdin 会被关掉 —— 这是最可靠的一个"该收摊了"信号
process.stdin.on('end', () => shutdown('stdin 关闭'));
process.stdin.resume();

log('就绪，等壳的退出信号（STOP / stdin 关闭 / SIGTERM）');
