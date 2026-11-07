/*
 * hub/tunnel.mjs —— 外网访问的**机器侧那一半**：把中枢下发的 relay 配置变成一条 frpc 隧道。
 *
 * 全貌（设计见 `docs/design/2026-11-07-外网访问-中枢转发.md`）：
 *
 *   手机/浏览器 ──HTTPS──▶ 中枢网关（TLS、鉴权、限流）──▶ frps ──隧道──▶ 本机 frpc ──▶ 127.0.0.1:18787
 *
 * 这一层只做四件事，别的都不做：
 *   ① 读配置（`hub/relay.mjs`），没有就整个空转 —— 本机使用**永远不受影响**；
 *   ② 生成 `frpc.toml`（放在数据目录，0600，里面有设备 token）；
 *   ③ 起 / 停 / 盯 frpc 子进程（崩了退避重连，配置变了重启）；
 *   ④ 收尸：上一次进程被强杀留下的 frpc，下次启动时按 pid 文件收掉。
 *
 * **为什么不把 frp 写进业务代码**：这一层就是那条接缝。将来若换成自写隧道，
 * 只改这一个文件的 start/stop/status 三个动作，server.mjs 与 http.mjs 一行不用动。
 *
 * **为什么失败不抛**：隧道是"加分项"，不是启动前提。frpc 缺失、中枢没配、家里断网，
 * 这台机器依然是一台完整的班底 —— 只是外面连不进来。所以一律降级成状态 + 一行日志。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { repoRoot } from '../config.mjs';
import { killPid, processInfo } from '../lifecycle.mjs';
import { readRelay } from './relay.mjs';

/** 崩了之后等多久再连（毫秒）；用完就一直用最后一档 */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];

/**
 * @type {{
 *   state: 'off'|'unavailable'|'starting'|'up'|'retrying'|'failed',
 *   child: import('node:child_process').ChildProcess|null,
 *   pid: number|null,
 *   dataDir: string|null,
 *   port: number|null,
 *   signature: string,
 *   since: number,
 *   retries: number,
 *   timer: NodeJS.Timeout|null,
 *   lastError: string|null,
 *   bin: string|null,
 *   subdomain: string|null,
 *   publicUrl: string|null,
 *   warned: Set<string>,
 *   hooked: boolean,
 * }}
 */
const S = {
  state: 'off',
  child: null,
  pid: null,
  dataDir: null,
  port: null,
  signature: '',
  subdomain: null,
  publicUrl: null,
  since: 0,
  retries: 0,
  timer: null,
  lastError: null,
  bin: null,
  warned: new Set(),
  hooked: false,
};

export function tunnelDir(dataDir) {
  return path.join(dataDir, 'tunnel');
}

export function confPath(dataDir) {
  return path.join(tunnelDir(dataDir), 'frpc.toml');
}

function pidPath(dataDir) {
  return path.join(tunnelDir(dataDir), 'frpc.pid');
}

function logPath(dataDir) {
  return path.join(dataDir, 'log', 'frpc.log');
}

/* ------------------------------------------------------------------ 二进制 */

/**
 * 找 frpc。顺序：`BANDI_FRPC` → 仓库内 `vendor/frp/` → PATH。
 *
 * **找不到不算错**：安装包里没带 frpc 的开发机上，这个模块就该安静地空转。
 * 只提醒一次（`warnOnce`），别每 60 秒刷一行。
 */
function findBin() {
  const explicit = String(process.env.BANDI_FRPC ?? '').trim();
  const names = process.platform === 'win32' ? ['frpc.exe', 'frpc'] : ['frpc', 'frpc.exe'];
  const candidates = [];
  if (explicit) candidates.push(explicit);
  for (const n of names) candidates.push(path.join(repoRoot, 'vendor', 'frp', n));

  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch { /* 下一个 */ }
  }

  // PATH 里找（不 exec `where`/`which`：那要多起一个进程，而且环境退化时会抛）
  for (const dir of String(process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const p = path.join(dir, n);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch { /* 下一个 */ }
    }
  }
  return null;
}

function warnOnce(key, text) {
  if (S.warned.has(key)) return;
  S.warned.add(key);
  console.warn(text);
}

/* ------------------------------------------------------------------ 配置写盘 */

/** TOML 基本字符串：JSON 的转义是它的子集，直接用最省事（值都是主机名/token/路径） */
const tomlStr = (v) => JSON.stringify(String(v));

/**
 * 生成 frpc.toml。只写**必须**的字段：
 * 每多写一个开关，就多一种"换了 frp 版本行为变了"的坑。
 *
 *   · `subdomain` 由 frps 的 `subdomainHost` 兑现成 `<subdomain>.<域名>`；
 *   · `localPort` 是本机控制面的端口（不是隧道端口）；
 *   · 心跳 10s / 超时 30s：宿主进程被强杀时，frps 最多 30 秒后自己把这条连接判死
 *     —— 这是"孤儿 frpc"最后一道保险（第一道是 pid 文件收尸）。
 *
 * @param {NonNullable<ReturnType<typeof readRelay>>} cfg
 * @param {{ port: number, dataDir: string }} local
 */
export function renderToml(cfg, local) {
  return [
    `serverAddr = ${tomlStr(cfg.serverAddr)}`,
    `serverPort = ${cfg.serverPort}`,
    // frps 的 Login 回调靠这个认出"是哪台设备"（token 是按设备派生的，不可反推）
    ...(cfg.deviceId ? [`user = ${tomlStr(cfg.deviceId)}`] : []),
    '',
    'transport.heartbeatInterval = 10',
    'transport.heartbeatTimeout = 30',
    // 藏在 Cloudflare 隧道后面时用 `wss`：先 TLS、再在 TLS 里做 ws 握手。
    // 别写成 `websocket` + `transport.tls.enable`：frp 的实现里那条路径是**先发明文 ws
    // 请求、再套 TLS**（connector.go 的 hook 优先级），Cloudflare 的 443 收到明文直接拒，
    // 表现是 frpc 报 "bad status"、请求连隧道都进不来。
    ...(cfg.protocol ? [`transport.protocol = ${tomlStr(cfg.protocol)}`] : []),
    '',
    // 两把钥匙，别混：
    //   ① `auth.token` 是 **frps 那一层**的共享门槛（所有设备同一个值，只用来挡随机扫描）；
    //      frps 配了它而这里为空 → 登录在插件之前就被拒，报 "token in login doesn't match"。
    //   ② `metadatas.token` 才是**这台设备**的身份，frps 会把它原样转给中枢的 Login 回调，
    //      中枢用 HMAC(密钥, 设备号) 现算比对。
    //      不能指望 privilege_key：那是 md5(token + 时间戳)，从它反推不出设备号，
    //      中枢也不该为了验它就存一份 token 明文。
    'auth.method = "token"',
    `auth.token = ${tomlStr(cfg.serverToken ?? '')}`,
    `metadatas.token = ${tomlStr(cfg.token)}`,
    '',
    'log.level = "warn"',
    `log.to = ${tomlStr(logPath(local.dataDir))}`,
    '',
    '[[proxies]]',
    `name = ${tomlStr(cfg.subdomain)}`,
    'type = "http"',
    'localIP = "127.0.0.1"',
    `localPort = ${local.port}`,
    `subdomain = ${tomlStr(cfg.subdomain)}`,
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ 收尸 */

/** Windows 的路径大小写/分隔符都不稳定，比对前先归一 */
const normPath = (p) => String(p).replace(/\\/g, '/').toLowerCase();

/**
 * 上一次进程被强杀（任务管理器 / `taskkill /F`）留下的 frpc：它仍在跑、仍连着中枢，
 * 外面看这台机器"在线"，而新起来的服务又拉起一个 —— 两条隧道抢同一个子域名，
 * frps 会随心跳来回切，表现是"页面时好时坏"。
 *
 * 只杀**认得出是我们的**：命令行里既有 `frpc`、又有这个数据目录。
 * 读不到命令行（powershell 起不来）就**不杀** —— 与 lifecycle 同一条纪律。
 */
function reapStale(dataDir) {
  const file = pidPath(dataDir);
  let rec = null;
  try {
    rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return;
  }
  const pid = Number(rec?.pid);
  if (Number.isInteger(pid) && pid > 0) {
    const info = processInfo(pid);
    const cmd = normPath(info?.cmd ?? '');
    if (cmd && cmd.includes('frpc') && cmd.includes(normPath(dataDir))) {
      killPid(pid);
      console.warn(`[外网] 收掉上次没退干净的 frpc（pid ${pid}）`);
    }
  }
  try {
    fs.rmSync(file, { force: true });
  } catch { /* 删不掉就算了，下次再收 */ }
}

function writePidFile(dataDir, pid) {
  try {
    fs.mkdirSync(tunnelDir(dataDir), { recursive: true });
    const file = pidPath(dataDir);
    fs.writeFileSync(file, `${JSON.stringify({ pid, at: new Date().toISOString() })}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch { /* 记不下来只影响收尸，不影响隧道 */ }
}

function clearPidFile(dataDir) {
  if (!dataDir) return;
  try {
    fs.rmSync(pidPath(dataDir), { force: true });
  } catch { /* 没有就算清过 */ }
}

/* ------------------------------------------------------------------ 起停 */

function spawnFrpc(bin, conf, dataDir) {
  fs.mkdirSync(path.dirname(logPath(dataDir)), { recursive: true });
  const out = fs.openSync(logPath(dataDir), 'a');

  // 冒烟用假 frpc（`.mjs`）：用当前 node 跑它。真二进制直接执行。
  const isScript = /\.(mjs|cjs|js)$/i.test(bin);
  const cmd = isScript ? process.execPath : bin;
  const args = isScript ? [bin, '-c', conf] : ['-c', conf];

  try {
    /*
     * ⚠️ 不设 `cwd`：Windows 上进程的当前目录会被锁住，父进程想删/换这个目录就会
     * `EBUSY`（冒烟里第一次就踩到了）。frpc 不需要 cwd，用父进程的就好。
     */
    return spawn(cmd, args, {
      windowsHide: true,
      stdio: ['ignore', out, out],
      env: { ...process.env },
    });
  } finally {
    // 句柄已经交给子进程了；父进程这份不关，日志文件会一直被钉住
    try { fs.closeSync(out); } catch { /* 已经关了 */ }
  }
}

/** 子进程死一次就按退避重来；`stop()` 之后不会再重来（state 已经变了） */
function scheduleRetry() {
  if (S.state === 'off' || !S.dataDir) return;
  const delay = BACKOFF_MS[Math.min(S.retries, BACKOFF_MS.length - 1)];
  S.retries += 1;
  S.state = 'retrying';
  if (S.timer) clearTimeout(S.timer);
  S.timer = setTimeout(() => {
    S.timer = null;
    const cfg = readRelay(S.dataDir);
    if (!cfg) return stop();
    startProcess(cfg);
  }, delay);
}

function startProcess(cfg) {
  const dataDir = S.dataDir;
  const port = S.port;
  /*
   * 每次（重）启都重新找一遍，不缓存：`BANDI_FRPC` 可能刚被改（Spike 时换了二进制），
   * 而"上次找到过"不代表这次还在 —— 缓存下来就会一直指着一个被删掉的文件。
   * 代价只是几次 stat，只在起进程时发生。
   */
  const bin = findBin();
  if (!bin) {
    S.state = 'unavailable';
    warnOnce('bin', '[外网] 没找到 frpc（BANDI_FRPC / vendor/frp / PATH 都没有）—— 外网访问不可用，本机使用不受影响');
    return;
  }
  S.bin = bin;

  let conf;
  try {
    fs.mkdirSync(tunnelDir(dataDir), { recursive: true });
    conf = confPath(dataDir);
    fs.writeFileSync(conf, renderToml(cfg, { port, dataDir }), { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(conf, 0o600); } catch { /* Windows 尽力而为 */ }
  } catch (e) {
    S.state = 'failed';
    S.lastError = `写不了 frpc.toml：${e?.message ?? e}`;
    console.warn(`[外网] ${S.lastError}`);
    return;
  }

  S.state = 'starting';
  S.since = Date.now();
  let child;
  try {
    child = spawnFrpc(bin, conf, dataDir);
  } catch (e) {
    S.state = 'failed';
    S.lastError = `frpc 起不来：${e?.message ?? e}`;
    console.warn(`[外网] ${S.lastError}`);
    return;
  }
  S.child = child;
  S.pid = child.pid ?? null;

  child.on('spawn', () => {
    /*
     * **认身份再动状态**：这一个事件可能晚于 stop()，也可能晚于"下一条隧道已经接班"。
     * 不认身份的话，现场会变成"新进程被旧进程的退出事件改成 retrying"，然后多起一条隧道，
     * 两条抢同一个子域名（2026-11-07 冒烟第一次就踩到：pid 被清成 null、日志里多连了一次）。
     */
    if (S.child !== child) return;
    S.state = 'up';
    S.since = Date.now();
    S.retries = 0;
    S.lastError = null;
    if (S.pid) writePidFile(dataDir, S.pid);
    console.log(`[外网] 隧道已连（${cfg.subdomain} → 本机 ${port}）${cfg.publicUrl ? ` ${cfg.publicUrl}` : ''}`);
  });

  child.on('error', (e) => {
    if (S.child !== child) return;
    S.lastError = String(e?.message ?? e);
    S.state = 'failed';
    warnOnce(`spawn:${S.lastError}`, `[外网] frpc 没起来：${S.lastError}`);
  });

  child.on('exit', (code, signal) => {
    if (S.child !== child) return; // 不是当前这条（stop() 收的 / 已换新进程）：状态不归它管
    S.child = null;
    S.pid = null;
    clearPidFile(dataDir);
    if (S.state === 'off') return; // stop() 自己收的，不重连
    S.lastError = `frpc 退出（${signal ?? `code ${code}`}）`;
    // 退得越快，说明配置/凭据越不对；只在第一次和每次翻倍时提一句
    if (S.retries === 0) console.warn(`[外网] ${S.lastError}，稍后重连`);
    scheduleRetry();
  });
}

/** 进程真在跑吗（`child` 有值不代表没死，exit 之后才置空；这里以 pid 为准） */
function alive() {
  return !!(S.child && S.pid);
}

/**
 * 收敛到配置该有的样子（幂等）。三件事同时发生时才动进程：地址变了、子域名变了、本机端口变了。
 *
 * @param {{ dataDir: string, port: number }} input
 */
export function apply({ dataDir, port }) {
  const cfg = readRelay(dataDir);
  if (!cfg) {
    if (S.state !== 'off') stop();
    S.dataDir = dataDir;
    S.port = port;
    S.signature = '';
    return status();
  }

  const signature = `${cfg.serverAddr}:${cfg.serverPort}/${cfg.subdomain}@${port}`;
  S.dataDir = dataDir;
  S.port = port;

  // 配置没变、进程还活着 → 什么都不做（心跳每 60 秒都会调到这里）
  if (signature === S.signature && (S.state === 'unavailable' || alive())) return status();

  if (S.state !== 'off') stop();
  S.signature = signature;
  S.dataDir = dataDir;
  S.port = port;
  S.subdomain = cfg.subdomain;
  S.publicUrl = cfg.publicUrl;

  installExitHook();
  reapStale(dataDir);
  startProcess(cfg);
  return status();
}

export function stop() {
  if (S.timer) {
    clearTimeout(S.timer);
    S.timer = null;
  }
  const was = S.state;
  const child = S.child;
  const pid = S.pid;
  S.state = 'off';
  S.child = null;
  S.pid = null;
  S.retries = 0;
  S.signature = '';
  S.subdomain = null;
  S.publicUrl = null;
  S.since = Date.now();

  if (child) {
    try {
      child.kill();
    } catch { /* 已经死了 */ }
  } else if (pid) {
    killPid(pid);
  }
  clearPidFile(S.dataDir);
  if (was !== 'off') console.log('[外网] 隧道已断开');
  return status();
}

export function status() {
  return {
    state: S.state,
    pid: S.pid,
    subdomain: S.subdomain,
    publicUrl: S.publicUrl,
    since: S.since ? new Date(S.since).toISOString() : null,
    retries: S.retries,
    lastError: S.lastError,
    bin: S.bin,
  };
}

/**
 * 进程退出时收掉子进程（正常退出路径）。
 *
 * ⚠️ 被 `taskkill /F` / 断电时这个钩子**不会跑** —— 那正是 `reapStale()` 存在的理由。
 * 两道保险缺一不可：钩子管"好好退出"，pid 文件管"没来得及退出"。
 */
export function installExitHook() {
  if (S.hooked) return;
  S.hooked = true;
  process.once('exit', () => {
    if (S.child) {
      try { S.child.kill(); } catch { /* 已经死了 */ }
    }
  });
}
