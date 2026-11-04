#!/usr/bin/env node
/**
 * `bandi` —— 命令行上的那**一个**入口（2026-10-22）。
 *
 * 定位（别的都不做）：**无人值守那台机器上唯一的界面** + 脚本的手。
 * 页面里能做的事不在这里重做一遍 —— 尤其是「切单机/总机」：那是页面「设置 → 这台机器」
 * 的活，这里有自己的一套写库逻辑就会**双份真相**（谁最后写的算谁的，出问题说不清）。
 *
 * 三条铁律：
 *   ① **只调 lifecycle / node-supervisor 的共享函数**，不自己 taskkill、不自己拼 spawn。
 *      起停逻辑只有一份，壳与命令行共用 —— 这条从 `lifecycle.mjs` 第一版就在，别破。
 *   ② **绝不 import `store.mjs`**：`bandi status` 必须在"库坏了 / 库被占着 / 库还没建"
 *      的时候也能说人话。一 import 就会开库，正好在最需要它的时候炸。
 *   ③ **无参数才进菜单**。菜单只是子命令的目录 —— systemd、自启脚本、CI 答不了"1/2/3"。
 *
 * 跑法：
 *   bandi                      状态一屏；是终端时进菜单
 *   bandi status [--json]      只出状态（脚本用）
 *   bandi start | stop | restart [-y]
 *   bandi url [--open]
 *   bandi logs [-n 40] [-f]
 *   bandi node                 节点状态（只读）
 *   bandi mode                 模式说明（只读，改去页面）
 *   bandi install-cli [--dir D] [--path] [--remove] [--dry-run]
 *
 * 部署即装（2026-10-22）：不用手动跑 install-cli —— 服务起来那一刻 `ensureCliInstalled()`
 * 会自动把命令装上（幂等；逻辑与闸门见 `cli-install.mjs`）。install-cli 留给手动重装 / 卸载。
 *
 * ⚠️ **输出编码**：中文靠 Node 的控制台 Unicode 接口（真终端下没问题）；但输出被重定向
 * 或进 CI 时是 UTF-8 字节流，所以**不画框线**（`─│┌` 在老终端/GBK 日志里是乱码），
 * 分隔线只用半角 `-`。生成给 cmd 的 `.cmd` 一律**纯 ASCII + CRLF**（这项目踩过两次）。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { repoRoot, dataDir, dbPath, port as defaultPort, host as listenHost, clearListenHost } from './config.mjs';
import { ensureRunning, stopRunning, isUp, listeners, urlOf, openUrl, sleep, processInfo } from './lifecycle.mjs';
import { platformVersion } from './local-mode.mjs';
import * as netmode from './netmode.mjs';
import { readLock, lockPath } from './node-supervisor.mjs';

/* ------------------------------------------------------------------ 样式 */

const TTY = !!process.stdout.isTTY;
const PLAIN = !!process.env.NO_COLOR || process.argv.includes('--plain') || !TTY;
const sgr = (code) => (s) => (PLAIN ? String(s) : `\x1b[${code}m${s}\x1b[0m`);
const bold = sgr('1');
const dim = sgr('2');
const red = sgr('31');
const green = sgr('32');
const yellow = sgr('33');
const cyan = sgr('36');

const clearScreen = () => {
  if (TTY && !PLAIN) process.stdout.write('\x1b[2J\x1b[H');
};

/** 终端里中日韩字符占**两列** —— 按字符数 pad 一定歪，所以要算显示宽度 */
const WIDE =
  /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/;
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += WIDE.test(ch) ? 2 : 1;
  return w;
}
function padEndW(s, w) {
  const d = w - dispWidth(s);
  return d > 0 ? String(s) + ' '.repeat(d) : String(s);
}

/* ------------------------------------------------------------- 小工具 */

const readJson = (p) => {
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
};

const readText = (p) => {
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch {
    return '';
  }
};

function pidAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

function fmtSize(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i >= 2 ? 1 : 0)} ${u[i]}`;
}

function fmtWhen(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const LOG_FILE = path.join(dataDir, 'server.log');
const SERVICE_FILE = path.join(dataDir, 'service.json');
const PORT_FILE = path.join(dataDir, 'port');
const CFG_FILE = path.join(dataDir, 'config.json');

/**
 * 记下"这次用的是哪个端口"（`<数据目录>/port`，与桌面壳同一个约定、同一个文件）。
 *
 * 为什么非记不可：`BANDI_PORT` 只活在**当时那个终端**里。在一个窗口里 `set BANDI_PORT=8899`
 * 起过之后，另一个窗口敲 `bandi stop` 会看不到它（按默认端口找，扑空）—— 用户看到的是
 * "明明在跑，命令说没在跑"。记一笔，下次谁来看都能找到。桌面壳也读它来决定"复用自己的实例"，
 * 所以这个文件本来就是"上次在哪个端口"的公共记忆，不是我们另立的。
 */
function recordPort(port) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(PORT_FILE, `${port}\n`, 'utf8');
  } catch { /* 写不了就算了：下次按约定端口找，不影响起停 */ }
}

/* --------------------------------------------------------------- 探测 */

/**
 * 服务在不在跑、在哪个端口。
 *
 * **必须看 `service.json`**：端口虽然已经固定（18787），但 `BANDI_PORT` 可以显式改，桌面壳
 * 也会把它读到的实际端口写进登记 —— "默认端口起没起"不能代表"服务在不在"。
 * 候选端口按「登记过的 → 端口文件 → 默认端口」依次试，第一个应答的就认。
 */
async function detect() {
  const record = readJson(SERVICE_FILE);
  const cands = [];
  if (record && Number(record.port)) cands.push(Number(record.port));
  const pf = Number(readText(PORT_FILE));
  if (pf) cands.push(pf);
  cands.push(defaultPort);
  const ports = [...new Set(cands.filter((p) => Number.isInteger(p) && p > 0 && p < 65536))];

  for (const port of ports) {
    if (await isUp(port)) {
      return {
        running: true,
        port,
        url: urlOf(port),
        pids: listeners(port),
        record: record && Number(record.port) === port ? record : null,
      };
    }
  }
  // 没应答：看看候选端口上是不是坐着**别人的**程序（那种情况不能乱起，也不能乱杀）
  const taken = ports.map((port) => ({ port, pids: listeners(port) })).filter((x) => x.pids.length);
  const first = ports[0] ?? defaultPort;
  return { running: false, port: first, url: urlOf(first), pids: [], record: null, taken };
}

/**
 * 这台机器是什么身份。判据与 `config.mjs` / `netmode.mjs` 同一套（别另立一套）。
 *
 * 2026-11-04 起监听地址是**三层取值**（`BANDI_HOST` 环境变量 > 数据目录 config.json 的
 * `listenHost` > 缺省 `0.0.0.0`）—— 这里必须用 `config.mjs` 算好的那个，别再自己
 * `process.env.BANDI_HOST ?? '0.0.0.0'`（那样界面上改过的地址在这边看不见）。
 * 钉在回环上是调试形态，照实说"只听本机"。
 */
function modeOf() {
  const cp = String(readJson(CFG_FILE)?.controlPlane ?? '').trim();
  if (cp) return { id: 'client', label: '节点（这台机器已加入总机）', detail: cp };
  const nm = netmode.readNetMode(); // 现读：角色是运行期可切的，别用启动快照
  const where = listenHost;
  if (netmode.isLoopback(where)) return { id: 'solo', label: '单机（只听本机）', detail: where };
  if (nm.acceptNodes) return { id: 'host', label: '总机（收别的机器当节点）', detail: where };
  return { id: 'branch', label: '分机（不收节点）', detail: where };
}

/** 执行节点（`node.mjs`）在这台机器上跑没跑 —— 只读锁文件，不碰进程 */
function nodeOf() {
  const lock = readLock();
  const meta = readJson(lockPath()) ?? {};
  return {
    running: !!lock.running,
    pid: lock.pid ?? null,
    stale: !!lock.stale,
    controlPlane: meta.controlPlane ?? null,
    startedAt: meta.startedAt ?? null,
  };
}

async function snapshot() {
  let dbSize = 0;
  let dbMtime = 0;
  try {
    const st = fs.statSync(dbPath);
    dbSize = st.size;
    dbMtime = st.mtimeMs;
  } catch { /* 库还没有 —— 正常，第一次启动才建 */ }
  return {
    version: platformVersion(),
    repoRoot,
    dataDir,
    logFile: LOG_FILE,
    db: { path: dbPath, size: dbSize, mtime: dbMtime },
    service: await detect(),
    mode: modeOf(),
    node: nodeOf(),
  };
}

/* --------------------------------------------------------------- 显示 */

function renderStatus(s) {
  const out = [];
  const L = 10;
  const row = (k, v) => out.push(`  ${dim(padEndW(k, L))}${v}`);

  out.push(`  ${bold('班底')} ${s.version ? `v${s.version}` : dim('（版本未知）')}`);
  out.push('  ' + '-'.repeat(48));

  const svc = s.service;
  if (svc.running) {
    row('状态', `${green('运行中')}  PID ${svc.pids.join(', ') || '?'}  · 端口 ${svc.port}`);
    row('访问', cyan(svc.url));
    if (svc.record?.byPid) {
      const who = Number(svc.record.byPid);
      row('由谁起的', `桌面窗口（PID ${who}）${pidAlive(who) ? '' : dim(' — 那个窗口已经关了')}`);
    }
  } else {
    row('状态', `${yellow('未运行')}`);
    for (const t of svc.taken ?? []) {
      const who = t.pids.map((p) => {
        const i = processInfo(p);
        return `${p}${i.name ? ` ${i.name}` : ''}`;
      });
      row('端口被占', `${t.port} ← ${who.join(', ')} ${dim('（不是班底，没动它）')}`);
    }
    row('访问', dim(svc.url) + dim('（起来之后才能打开）'));
  }

  row('模式', s.mode.label);
  if (s.mode.detail) out.push(`  ${' '.repeat(L)}${dim(s.mode.detail)}`);

  row(
    '节点',
    s.node.running
      ? `${green('在跑')}  PID ${s.node.pid}${s.node.controlPlane ? dim(` → ${s.node.controlPlane}`) : ''}`
      : s.node.stale
        ? `${yellow('未运行')}${dim(`（锁是上次留下的，PID ${s.node.pid} 已经不在了）`)}`
        : dim('未运行 —— 这台机器只当控制面'),
  );

  row('数据目录', s.dataDir);
  const dbNote = s.db.size ? `${fmtSize(s.db.size)} · ${fmtWhen(s.db.mtime)} 最后写入` : dim('库还没建（第一次启动时创建）');
  out.push(`  ${' '.repeat(L)}${dim(dbNote)}`);
  row('日志', s.logFile);
  return out;
}

/* --------------------------------------------------------------- 动作 */

/**
 * 自己收行、自己发问。
 *
 * **为什么不用 `rl.question()`**：它只把"下一行"接给当前这一次提问。而菜单循环里
 * 两句话之间要跑 `snapshot()`（几次 HTTP 探测，几百毫秒起步）—— 那段时间到达的行
 * 没有人在等，readline 直接**丢掉**。管道/脚本喂答案时必然踩到（喂完一句就没了，
 * 菜单停在第一屏；实测过）。自己拿 `line` 事件排个队，谁在等就递过去，没人等就攒着。
 *
 * 输入没了（Ctrl-D / 管道关闭）→ 返回 null，调用方据此收摊，不干挂着。
 */
function makePrompter(rl, out = process.stdout) {
  const queue = [];
  const waiters = [];
  let closed = false;
  rl.on('line', (l) => {
    if (waiters.length) waiters.shift()(l);
    else queue.push(l);
  });
  rl.on('close', () => {
    closed = true;
    while (waiters.length) waiters.shift()(null);
  });
  return async function promptOf(question) {
    if (question) out.write(question);
    if (queue.length) return queue.shift();
    if (closed) return null;
    return new Promise((resolve) => waiters.push(resolve));
  };
}

/**
 * 问一句 y/N。
 * `promptOf` 由菜单传进来（共用同一个行队列）；命令行里没有就自己开一个。
 * 非交互环境下**不给**"等一个永远不会来的回车"，直接当"否"。
 */
async function confirm(question, promptOf = null) {
  const yes = (a) => /^(y|yes|是)$/i.test(String(a ?? '').trim());
  if (promptOf) return yes(await promptOf(question));
  if (!TTY) return false;
  const tmp = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return yes(await makePrompter(tmp)(question));
  } finally {
    tmp.close();
  }
}

/** 桌面壳起的服务，重启/停掉之前要先说清楚后果（不然用户只会看到窗口白屏） */
function shellWarning(svc) {
  const by = Number(svc?.record?.byPid ?? 0);
  if (!by || !pidAlive(by)) return '';
  return `当前这个服务是**桌面窗口**拉起来的（PID ${by}）。动它之后那个窗口会连不上，需要刷新（重启的话）；壳退出时也不会再收掉新起的服务。`;
}

async function doStart() {
  const s = await detect();
  if (s.running) return `已经在跑了（PID ${s.pids.join(', ') || '?'} · 端口 ${s.port}）—— ${s.url}`;
  if (s.taken?.length) {
    const t = s.taken[0];
    const info = t.pids.map((p) => processInfo(p)).map((i) => `${i.pid} ${i.name || ''}`.trim());
    return red(`端口 ${t.port} 被别的程序占着（${info.join(', ')}），我没动它。换个端口：set BANDI_PORT=8899`);
  }
  const r = await ensureRunning({ port: defaultPort, dataDir, logFile: LOG_FILE });
  if (r.action === 'started') {
    recordPort(defaultPort);
    return `${green('已启动')} · 端口 ${defaultPort} · ${r.url}`;
  }
  if (r.action === 'already') return `已经在跑 —— ${r.url}`;
  if (r.action === 'alien') {
    return red(`端口被别的程序占着：${r.alien.map((a) => `${a.pid} ${a.name}`).join(', ')}`);
  }
  const tail = r.logTail ? `\n\n--- 日志尾部 ---\n${r.logTail}` : '';
  return red(`没起来：${r.reason}${tail}`);
}

/** 等它真的不回应了再说话 —— 刚 kill 完那一两秒里探测还是通的，抢着报"已停止"会误导 */
async function waitStopped(ms = 2500) {
  const until = Date.now() + ms;
  for (;;) {
    if (!(await detect()).running) return true;
    if (Date.now() > until) return false;
    await sleep(200);
  }
}

async function doStop(promptOf = null) {
  const s = await detect();
  if (!s.running) return '本来就没在跑。';
  const warn = shellWarning(s);
  if (warn && !(await confirm(`  ${warn}\n  还是要停？[y/N] `, promptOf))) return '没动。';
  const r = stopRunning(s.port);
  if (!r.stopped) {
    return r.alien ? red(`端口 ${s.port} 上不是班底，没动它。`) : '没找到可以收的进程（可能刚自己退出了）。';
  }
  if (!(await waitStopped())) {
    return yellow(`收掉了 ${r.stopped} 个进程，但端口 ${s.port} 还在应答 —— 可能刚被别的东西接手了，看一眼：bandi status`);
  }
  return `${green('已停止')}（收了 ${r.stopped} 个进程）`;
}

async function doRestart(promptOf = null, { assumeYes = false } = {}) {
  const s = await detect();
  const port = s.running ? s.port : defaultPort;
  if (s.running) {
    const warn = shellWarning(s);
    const lines = ['重启会**打断正在跑的活**（被打断的运行会记成失败）。'];
    if (warn) lines.push(warn);
    if (!assumeYes && !(await confirm(`  ${lines.join('\n  ')}\n  确认重启？[y/N] `, promptOf))) return '没动。';
  }
  const r = await ensureRunning({ port, dataDir, logFile: LOG_FILE, force: true });
  if (r.action === 'started') {
    recordPort(port);
    return s.running ? `${green('已重启')} · 端口 ${port} · ${r.url}` : `${green('已启动')} · ${r.url}`;
  }
  if (r.action === 'alien') {
    return red(`端口 ${port} 被别的程序占着：${r.alien.map((a) => `${a.pid} ${a.name}`).join(', ')}`);
  }
  const tail = r.logTail ? `\n\n--- 日志尾部 ---\n${r.logTail}` : '';
  return red(`没起来：${r.reason}${tail}`);
}

/**
 * **重置监听**（2026-11-03，对齐 1Panel 的 `1pctl listen-ip` / `reset` 那条救援路）：
 * 忽略 `BANDI_HOST`、清掉持久化的 `listenHost`、按缺省 `0.0.0.0`（对外）强制重启。
 *
 * 救的是"钉错网卡把自己锁在门外"的现场：`BANDI_HOST=192.168.5.9` 钉下去之后
 * 机器 IP 变了，页面打不开、界面上又没有开关 —— 命令行是唯一的门。
 *
 * 2026-11-04 补：监听地址已经**做进系统**（数据目录 `config.json` 的 `listenHost`，
 * 界面可改）。所以重置必须连那份配置一起清 —— 只忽略环境变量的话，重启后又会照配置
 * 听回去，"重置"等于白做。
 *
 * ⚠️ 环境变量那半没法动（它来自终端 / 自启脚本 / 服务单元），事后必须点名"它还在哪"。
 */
async function doResetHost(promptOf = null, { assumeYes = false } = {}) {
  const s = await detect();
  const pinned = String(process.env.BANDI_HOST ?? '').trim();
  const port = s.running ? s.port : defaultPort;
  if (s.running && !assumeYes) {
    const warn = shellWarning(s);
    const lines = [
      `将忽略 BANDI_HOST、清掉界面里存的监听地址，按缺省监听 0.0.0.0（对外）强制重启 —— 会打断正在跑的活。`,
      warn,
    ].filter(Boolean);
    if (!(await confirm(`  ${lines.join('\n  ')}\n  确认重置？[y/N] `, promptOf))) return '没动。';
  }
  // 持久化那份也清掉，否则重启后按旧配置听回去（2026-11-04）
  let cleared = false;
  try {
    cleared = clearListenHost();
  } catch { /* 写不进去就只救这一次，下面照常重启 */ }
  const r = await ensureRunning({ port, dataDir, logFile: LOG_FILE, force: s.running, stripEnv: ['BANDI_HOST'] });
  if (r.action === 'started') {
    recordPort(port);
    const note = pinned
      ? yellow(`\n\n⚠ 你的环境里仍钉着 BANDI_HOST=${pinned} —— 这次起服务我特意当它不存在；下次正常 start 还会被带进来。要永久生效，去设置它的地方改（终端 profile / 自启脚本 / 服务单元）。`)
      : '';
    return `${green('已重置')} · 监听缺省 0.0.0.0（对外） · ${r.url}${cleared ? ' · 界面里存的地址也清了' : ''}${note}`;
  }
  if (r.action === 'already') return `已经在跑 —— ${r.url}（要重置得先重启：本次没动）`;
  if (r.action === 'alien') {
    return red(`端口 ${port} 被别的程序占着：${r.alien.map((a) => `${a.pid} ${a.name}`).join(', ')}`);
  }
  const tail = r.logTail ? `\n\n--- 日志尾部 ---\n${r.logTail}` : '';
  return red(`没起来：${r.reason}${tail}`);
}

async function doUrl({ open = false } = {}) {
  const s = await detect();
  if (open) {
    if (!openUrl(s.url)) return `${s.url}\n（没能唤起浏览器，手动打开上面这个）`;
    return `已交给浏览器：${s.url}`;
  }
  return s.url;
}

function tailLines(n) {
  const raw = (() => {
    try {
      return fs.readFileSync(LOG_FILE, 'utf8');
    } catch {
      return '';
    }
  })();
  if (!raw) return [];
  return raw.trimEnd().split(/\r?\n/).slice(-n);
}

async function doLogs({ n = 40, follow = false } = {}) {
  if (!fs.existsSync(LOG_FILE)) return `还没有日志：${LOG_FILE}`;
  for (const l of tailLines(n)) console.log(l);
  if (!follow) return '';
  console.log(dim('\n（跟着日志走，Ctrl-C 退出）'));
  let pos = fs.statSync(LOG_FILE).size;
  process.on('SIGINT', () => process.exit(0));
  for (;;) {
    await sleep(500);
    let st;
    try {
      st = fs.statSync(LOG_FILE);
    } catch {
      continue;
    }
    if (st.size < pos) pos = 0; // 日志被轮转/清空了
    if (st.size === pos) continue;
    const fd = fs.openSync(LOG_FILE, 'r');
    const buf = Buffer.alloc(st.size - pos);
    fs.readSync(fd, buf, 0, buf.length, pos);
    fs.closeSync(fd);
    pos = st.size;
    process.stdout.write(buf.toString('utf8'));
  }
}

function doNode() {
  const s = nodeOf();
  if (s.running) {
    return [
      `节点 ${green('在跑')} · PID ${s.pid}`,
      s.controlPlane ? `  连的是 ${s.controlPlane}` : '  （锁里没记控制面地址）',
      s.startedAt ? dim(`  起于 ${s.startedAt}`) : '',
    ].filter(Boolean).join('\n');
  }
  if (s.stale) return `节点未运行${dim(`（锁是上次留下的，PID ${s.pid} 已经不在了；下次启动会自己清掉）`)}`;
  return '节点未运行 —— 这台机器没在给别人当算力。\n' + dim('  要当节点：在控制面页面上「这台机器 → 加入总机」，或跑 autostart 装节点守护。');
}

function doMode() {
  const m = modeOf();
  const out = [`模式：${m.label}`];
  if (m.detail) out.push(dim(`  ${m.detail}`));
  out.push('');
  out.push(dim('  改模式不在这儿 —— 去页面「设置 → 这台机器」，那里会把"要重启才生效"'));
  out.push(dim('  和"切过去之后怎么连"一起说清楚。命令行里切监听地址，一断就没人救得回来。'));
  return out.join('\n');
}

/* ------------------------------------------------------------ 调本机 API */

/*
 * **为什么 CLI 也走 HTTP、不直接写库**（IAM §10.1.3 / §13）：
 *   · 单写者：库只由服务进程写，CLI 直连库会和它抢 WAL、还会绕过所有校验；
 *   · 服务器形态下浏览器根本做不了破坏性动作（要 `X-Bandi-Local`），
 *     "本机终端"就是唯一合法的执行者 —— 而它只能用同一套接口，不能开后门。
 * 三个头各管一件事，缺哪个由服务端说了算：
 *   X-Bandi-Token  身份（root 令牌 = operator）
 *   X-Bandi-Local  "我在这台机器的文件系统上"（值 = 数据目录 local_secret）
 *   X-Bandi-Setup  只有"零账号 + 服务器形态"建第一个管理员时才需要
 */
function apiHeaders(extra = {}) {
  const h = { 'Content-Type': 'application/json', ...extra };
  const t = readText(path.join(dataDir, 'token'));
  if (t) h['X-Bandi-Token'] = t;
  const s = readText(path.join(dataDir, 'local_secret'));
  if (s) h['X-Bandi-Local'] = s;
  const sc = readText(path.join(dataDir, 'setup_code'));
  if (sc) h['X-Bandi-Setup'] = sc;
  return h;
}

/** 一个最小的 HTTP 调用（不引依赖；只打 127.0.0.1） */
function api(port, { method = 'GET', path: p = '/', body = null, timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    const payload = body === null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: p,
        timeout,
        headers: { ...apiHeaders(), ...(payload ? { 'Content-Length': payload.length } : {}) },
      },
      (res) => {
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => {
          let j = null;
          try {
            j = JSON.parse(text);
          } catch { /* 不是 JSON 就把原文给调用方 */ }
          resolve({ status: res.statusCode, json: j, text });
        });
      },
    );
    req.on('error', (e) => resolve({ status: 0, json: null, text: String(e?.message ?? e) }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, json: null, text: '超时' });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/** 服务没在跑就没法调接口 —— 说清楚怎么办，别丢一个 ECONNREFUSED 给人 */
async function needService() {
  const s = await detect();
  if (!s.running) return { error: `班底没在跑（先 ${cyan('bandi start')}，或 ${cyan('bandi status')} 看它在哪个端口）` };
  return { port: s.port };
}

const errText = (r) => (r.json?.code ? `${r.json.code}：${r.json.error}` : r.text || `HTTP ${r.status}`);

/* --------------------------------------------------------------- collab */

async function cmdCollab(argv) {
  const words = argv.filter((a) => !a.startsWith('-'));
  const sub = words[1] ?? 'status';
  const svc = await needService();
  if (svc.error) return svc.error;

  if (sub === 'status') {
    const r = await api(svc.port, { path: '/api/local/collab/status' });
    if (r.status !== 200) return red(errText(r));
    const j = r.json ?? {};
    if (!j.joined) return `未加入任何协作中心${j.centerUrl ? dim(`（上次退出的是 ${j.centerUrl}）`) : ''}`;
    return [
      `已加入协作中心 ${green(j.centerLabel || j.centerUrl || '?')}`,
      `  中心  ${j.centerUrl ?? '?'}`,
      `  分公司 ${j.branchId ?? '?'}${j.online === false ? `  ${yellow('（中心当前不可达）')}` : ''}`,
    ].join('\n');
  }

  if (sub === 'join') {
    const url = words[2];
    const code = words[3];
    if (!url) return '用法：bandi collab join <中心地址> [接入码]';
    const r = await api(svc.port, { method: 'POST', path: '/api/local/collab/join', body: { url, code } });
    if (r.status !== 200) return red(errText(r));
    return `${green('已加入')}「${r.json?.centerLabel ?? url}」（${r.json?.branchId ?? '?'}）`;
  }

  if (sub === 'leave') {
    const r = await api(svc.port, { method: 'POST', path: '/api/local/collab/leave' });
    if (r.status !== 200) return red(errText(r));
    return `${green('已退出协作中心')}（本地项目与卡片都还在）`;
  }

  return `不认识的子命令：collab ${sub}\n（bandi collab status | join <地址> [码] | leave）`;
}

/* ----------------------------------------------------------------- nodes */

/**
 * `bandi nodes …`（IAM Phase 3 补，2026-10-31）：算力节点的终端入口。
 *
 * 为什么必须有它：前端「算力节点管理」的加入向导在**服务器形态**下不再渲染
 * （破坏性动作按 `state.localSecret` 显隐，IAM §10.1.3）—— 藏了按钮就得给终端一条路，
 * 否则服务器形态的算力加入就是死路。走 HTTP 不写库（单写者原则，与 collab 同一套 `api()`，
 * 自动带 `X-Bandi-Token` / `X-Bandi-Local` 头，`/api/local/join` 的文件秘密闸（E4097）自然过）。
 *
 * 两边视角都覆盖：
 *   · **当节点**（这台机器去给别的总机打工）：status / join / leave —— 打本机 `/api/local/*`；
 *   · **当总机**（这台机器收节点）：list / invite —— 打 `/api/nodes*`（operator 待遇）。
 */
async function cmdNodes(argv) {
  const words = argv.filter((a) => !a.startsWith('-'));
  const sub = words[1] ?? 'status';
  const svc = await needService();
  if (svc.error) return svc.error;

  if (sub === 'status') {
    const r = await api(svc.port, { path: '/api/local/status' });
    if (r.status !== 200) return red(errText(r));
    const c = r.json?.client ?? {};
    if (!c.joined) {
      return [
        '这台机器没加入任何总机（独立运行）',
        c.controlPlane === '' || c.controlPlane == null ? dim('  加入：bandi nodes join <总机地址> <邀请码>') : dim(`  上次加入的是 ${c.controlPlane}`),
      ].join('\n');
    }
    return [
      `已加入总机 ${green(c.hostLabel || c.controlPlane)}`,
      `  总机  ${c.controlPlane ?? '?'}`,
      `  权限  ${(c.scope ?? []).join(' + ') || '?'}`,
      `  节点  ${c.node?.running ? green(`在跑（pid ${c.node.pid}）${c.node.external ? ' · 外部托管' : ''}`) : yellow('没在跑')}${c.node?.why ? dim(`（${c.node.why}）`) : ''}`,
      `  加入于 ${c.since ?? '?'}`,
    ].join('\n');
  }

  if (sub === 'join') {
    const url = words[2];
    const code = words[3];
    if (!url || !code) return '用法：bandi nodes join <总机地址> <邀请码>\n  邀请码在总机上发：bandi nodes invite（10 分钟内有效，只用一次）';
    const r = await api(svc.port, { method: 'POST', path: '/api/local/join', body: { url, code } });
    if (r.status !== 200 && r.status !== 201) return red(errText(r));
    const j = r.json ?? {};
    return [
      `${green('已加入')}「${j.hostLabel ?? url}」· 只当算力（${(j.scope ?? ['compute']).join('+')}）`,
      j.node?.running ? dim('  节点已起') : yellow(`  节点还没起${j.node?.why ? `：${j.node.why}` : '（配置已写，稍后自动起）'}`),
      dim('  监听正在收回环（几秒内生效）'),
    ].join('\n');
  }

  if (sub === 'leave') {
    const r = await api(svc.port, { method: 'POST', path: '/api/local/leave' });
    if (r.status !== 200) return red(errText(r));
    return `${green('已退出总机')}（本地数据都在）`;
  }

  if (sub === 'list') {
    // 总机视角：登记了哪些算力节点
    const r = await api(svc.port, { path: '/api/nodes' });
    if (r.status !== 200) return red(errText(r));
    const list = r.json?.nodes ?? [];
    if (!list.length) return '还没有登记任何算力节点（在那台机器上：bandi nodes join <本机地址> <邀请码>）';
    return [
      dim(`  心跳 ${r.json?.heartbeatSeconds ?? '?'}s · ${r.json?.offlineAfterSeconds ?? '?'}s 无心跳算离线`),
      ...list.map((n) =>
        `  ${n.online ? green('●') : yellow('○')} ${n.label ?? n.id}${n.hostname && n.hostname !== n.label ? dim(`（${n.hostname}）`) : ''} · ${(n.scope ?? '').trim() || dim('无令牌')}${n.pendingJobs ? ` · 队列 ${n.pendingJobs}` : ''}${n.lastSeenAt ? dim(` · 心跳 ${n.lastSeenAt}`) : ''}`,
      ),
    ].join('\n');
  }

  if (sub === 'invite') {
    const r = await api(svc.port, { method: 'POST', path: '/api/nodes/invites' });
    if (r.status !== 200 && r.status !== 201) return red(errText(r));
    const inv = r.json ?? {};
    const code = inv.code ?? inv.token ?? '?';
    return [
      `${green('邀请码已发')}（10 分钟内有效，只用一次）：`,
      `  ${code}`,
      dim('  到那台机器上执行：bandi nodes join <这台机器的地址> <邀请码>'),
    ].join('\n');
  }

  return `不认识的子命令：nodes ${sub}\n（bandi nodes status | join <地址> <邀请码> | leave | list | invite）`;
}

/* ----------------------------------------------------------------- data */

async function cmdData(argv) {
  const words = argv.filter((a) => !a.startsWith('-'));
  if ((words[1] ?? '') !== 'export') return '用法：bandi data export [--dir 目录]';
  const svc = await needService();
  if (svc.error) return svc.error;
  const dir = argOf(argv, '--dir');
  const r = await api(svc.port, { method: 'POST', path: '/api/local/export', body: dir ? { dir } : {} });
  if (r.status !== 200) return red(errText(r));
  return `${green('已导出')} ${r.json?.file}\n  ${dim(fmtSize(r.json?.size) || '')}`;
}

/* ----------------------------------------------------------------- user */

async function cmdUser(argv) {
  const words = argv.filter((a) => !a.startsWith('-'));
  const sub = words[1] ?? 'list';
  const svc = await needService();
  if (svc.error) return svc.error;

  if (sub === 'list') {
    const r = await api(svc.port, { path: '/api/users' });
    if (r.status !== 200) return red(errText(r));
    const list = r.json?.users ?? [];
    if (!list.length) return '还没有任何账号 —— 用 bandi user create <名字> --admin';
    return list.map((u) => `  ${u.name}${u.roleId ? dim(` · ${u.roleId}`) : ''}${u.disabled ? dim(' · 已禁用') : ''}${u.hasPassword ? '' : dim(' · 免密')}`).join('\n');
  }

  if (sub === 'create') {
    const name = words[2];
    if (!name) return '用法：bandi user create <名字> [--admin] [--password 密码]';
    const password = argOf(argv, '--password') ?? '';
    const body = { name, ...(password ? { password } : {}), ...(argv.includes('--admin') ? { roleId: 'admin' } : {}) };
    const r = await api(svc.port, { method: 'POST', path: '/api/users', body });
    if (r.status !== 201 && r.status !== 200) return red(errText(r));
    let out = `${green('已创建')}「${name}」${r.json?.first ? '（第一个账号，自动是管理员）' : ''}`;
    if (!password) {
      out += dim('\n  没设密码 = 免密账号（回环形态下点一下就进）');
      /*
       * 服务器形态建免密账号要告知后果（IAM §8.6 受限会话）：从别的机器登录
       * 这个号只能先设密码，其余操作一律 E4098 —— 不阻断（本机回环用免密依然合理），
       * 但得让运维在创建的那一刻就知道，而不是登录之后撞了墙再回来问。
       */
      const st = await api(svc.port, { path: '/api/state' });
      if (st.status === 200 && st.json?.localSecret === 'required') {
        out += dim('\n  ⚠ 这个服务开着局域网访问：这个号从其它机器登录时是受限会话（只能先设密码，其余操作一律拒绝）。\n    建议直接带上密码：bandi user create <名字> --password <密码>');
      }
    }
    return out;
  }

  return `不认识的子命令：user ${sub}\n（bandi user list | create <名字> [--admin] [--password 密码]）`;
}

/* --------------------------------------------------------- install-cli */

/*
 * 装全局命令的逻辑在 `cli-install.mjs`（单一事实源）：`server.mjs` 启动段与
 * `lifecycle.ensureRunning` 的"部署即装"也用它 —— 三类调用方共用一份，防止两边跑偏。
 */
import { doInstallCli } from './cli-install.mjs';

/* --------------------------------------------------------------- 菜单 */

const ITEMS = [
  {
    k: '1',
    label: '打开页面',
    run: async () => doUrl({ open: true }),
  },
  { k: '2', label: '刷新状态', run: async () => '' },
  { k: '3', label: '启动', run: async () => doStart() },
  { k: '4', label: '重启（会打断正在跑的活）', run: async (promptOf) => doRestart(promptOf) },
  { k: '5', label: '停止', run: async (promptOf) => doStop(promptOf) },
  {
    k: '6',
    label: '看日志尾部',
    run: async () => {
      const lines = tailLines(12);
      return lines.length ? lines.join('\n') : '还没有日志。';
    },
  },
  { k: '7', label: '节点状态', run: async () => doNode() },
  { k: '8', label: '模式说明（怎么切总机）', run: async () => doMode() },
  { k: '9', label: '重置监听（忽略 BANDI_HOST，回到对外 0.0.0.0）', run: async (promptOf) => doResetHost(promptOf) },
  { k: '0', label: '退出', run: async () => '', exit: true },
];

function renderMenu() {
  const out = [''];
  for (const it of ITEMS) out.push(`  ${bold(it.k)}  ${it.label}`);
  return out.join('\n');
}

async function interactive() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const promptOf = makePrompter(rl);
  // Ctrl-C 直接收摊：关掉 rl 之后，正在等的那一句会以 null 落地（见 `makePrompter`）
  rl.on('SIGINT', () => rl.close());
  try {
    for (;;) {
      const s = await snapshot();
      clearScreen();
      console.log(renderStatus(s).join('\n'));
      console.log(renderMenu());
      const raw = await promptOf(`\n  ${dim('选择编号（回车退出）：')}`);
      if (raw === null) break; // 输入没了（Ctrl-D / 管道关闭）
      const ans = raw.trim();
      if (!ans || ans === '0' || /^q(uit)?$/i.test(ans)) break;
      const item = ITEMS.find((i) => i.k === ans);
      if (!item) {
        console.log(red(`\n  没有「${ans}」这一项`));
      } else {
        let msg = '';
        try {
          msg = (await item.run(promptOf)) ?? '';
        } catch (e) {
          msg = red(`出错了：${e?.message ?? e}`);
        }
        if (msg) console.log(`\n  ${msg.replace(/\n/g, '\n  ')}`);
        if (item.exit) break;
      }
      if ((await promptOf(dim('\n  回车继续 '))) === null) break;
    }
  } finally {
    rl.close();
  }
}

/* --------------------------------------------------------------- 分发 */

const HELP = `班底 · 命令行

  bandi                    状态一屏（终端里还给菜单）
  bandi status [--json]    只出状态
  bandi start              起来（没在跑才真的起）
  bandi restart [-y]       强制重启（**会打断正在跑的活**，-y 跳过确认）
  bandi reset-host [-y]    忽略 BANDI_HOST、清掉界面里存的地址，重启回缺省 0.0.0.0；
                           救"钉错网卡连不上页面"的现场（页面：设置 → 安全 → 监听地址）
  bandi stop               停掉班底自己的服务（不碰别人的进程）
  bandi url [--open]       访问地址
  bandi logs [-n 40] [-f]  日志（-f 跟着走）
  bandi node               执行节点状态（只读）
  bandi mode               这台机器是什么身份（只读；改模式去页面）
  bandi collab [status]    协作中心：我加入了谁
  bandi collab join <地址> [接入码]
  bandi collab leave       退出协作中心（本地项目与卡片都还在）
  bandi nodes [status]     算力节点：这台机器给哪台总机打工
  bandi nodes join <总机地址> <邀请码>
                           加入总机（只当算力；邀请码在总机上 bandi nodes invite 发）
  bandi nodes leave        退出总机
  bandi nodes list         （总机视角）登记了哪些算力节点、在不在线
  bandi nodes invite       （总机视角）发一个一次性加入邀请码
  bandi data export [--dir 目录]
                           导出数据快照（服务器形态下这是唯一入口）
  bandi user list          账号列表
  bandi user create <名字> [--admin] [--password 密码]
                           建账号（服务器形态下建第一个管理员用它）
  bandi install-cli        把 bandi 装成一个全局命令
                           [--dir 目录] [--path] [--remove] [--dry-run]
  bandi version | help

  通用：--plain 去掉颜色   NO_COLOR=1 同上   BANDI_DATA 指定数据目录`;

function argOf(args, name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv.find((a) => !a.startsWith('-')) ?? '';
  const rest = argv.filter((a) => a !== cmd);
  const yes = argv.includes('-y') || argv.includes('--yes');

  if (cmd === 'help' || argv.includes('-h') || argv.includes('--help')) {
    console.log(HELP);
    return 0;
  }
  if (cmd === 'version' || argv.includes('-v') || argv.includes('--version')) {
    console.log(platformVersion() ?? '(版本未知)');
    return 0;
  }

  switch (cmd) {
    case '':
      if (TTY && !argv.includes('--json')) {
        await interactive();
      } else {
        const s = await snapshot();
        if (argv.includes('--json')) console.log(JSON.stringify(s, null, 2));
        else console.log(renderStatus(s).join('\n'));
      }
      return 0;

    case 'status': {
      const s = await snapshot();
      if (argv.includes('--json')) console.log(JSON.stringify(s, null, 2));
      else console.log(renderStatus(s).join('\n'));
      return s.service.running ? 0 : 3; // 3 = 没在跑（脚本一眼能判）
    }

    case 'start': {
      console.log(await doStart());
      return (await detect()).running ? 0 : 1;
    }

    case 'stop': {
      console.log(await doStop());
      return (await detect()).running ? 1 : 0;
    }

    case 'restart': {
      if (!TTY && !yes) {
        console.error('非交互环境下要显式确认：bandi restart -y（会打断正在跑的活）');
        return 2;
      }
      console.log(await doRestart(null, { assumeYes: yes }));
      return (await detect()).running ? 0 : 1;
    }

    case 'reset-host': {
      if (!TTY && !yes) {
        console.error('非交互环境下要显式确认：bandi reset-host -y（会打断正在跑的活）');
        return 2;
      }
      console.log(await doResetHost(null, { assumeYes: yes }));
      return (await detect()).running ? 0 : 1;
    }

    case 'url':
      console.log(await doUrl({ open: argv.includes('--open') }));
      return 0;

    case 'logs': {
      const n = Number(argOf(argv, '-n', '40')) || 40;
      const msg = await doLogs({ n, follow: argv.includes('-f') || argv.includes('--follow') });
      if (msg) console.log(msg);
      return 0;
    }

    case 'node':
      console.log(doNode());
      return 0;

    case 'mode':
      console.log(doMode());
      return 0;

    case 'collab': {
      console.log(await cmdCollab(argv));
      return 0;
    }

    case 'nodes': {
      const out = await cmdNodes(argv);
      console.log(out);
      return /^用法|不认识的子命令/.test(out) ? 2 : 0;
    }

    case 'data': {
      const out = await cmdData(argv);
      console.log(out);
      return /^用法/.test(out) ? 2 : 0;
    }

    case 'user':
    case 'users': {
      const out = await cmdUser(argv);
      console.log(out);
      return /^用法|不认识的子命令/.test(out) ? 2 : 0;
    }

    case 'install-cli':
      console.log(
        await doInstallCli({
          dir: argOf(argv, '--dir'),
          withPath: argv.includes('--path'),
          remove: argv.includes('--remove'),
          dryRun: argv.includes('--dry-run'),
        }),
      );
      return 0;

    default:
      console.error(`不认识的命令：${cmd}\n（bandi help 看用法）`);
      return 2;
  }
}

/**
 * 只在**被当命令跑**的时候才进分发。
 *
 * 留这个口子是为了菜单能被测：`interactive()` 要一个能答话的 stdin，自动化里没有 TTY，
 * 只能由用例 import 进来喂（见 `tmp/cli-smoke.mjs`）。菜单是这套东西里唯一"人手点"的
 * 部分，不能因为"没法自动化"就整块不测。
 */
export { interactive, snapshot, renderStatus };

const isEntry = (() => {
  try {
    return !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isEntry) {
  main().then(
    (code) => process.exit(code ?? 0),
    (err) => {
      console.error(red(`出错了：${err?.stack ?? err}`));
      process.exit(1);
    },
  );
}
