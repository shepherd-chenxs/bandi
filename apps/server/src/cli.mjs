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
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { repoRoot, dataDir, dbPath, port as defaultPort, lanAllowed } from './config.mjs';
import { ensureRunning, stopRunning, isUp, listeners, urlOf, openUrl, sleep, processInfo } from './lifecycle.mjs';
import { platformVersion } from './local-mode.mjs';
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
 * 起过之后，另一个窗口敲 `bandi stop` 会看不到它（按 8787 找，扑空）—— 用户看到的是
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
 * **必须看 `service.json`**：桌面壳是**自己挑端口**的（8787 起往上找），所以"8787 起没起"
 * 这个判断在壳起的服务上永远是错的（会看到一个在 8788 上好好跑着的服务，却报"未运行"）。
 * 候选端口按「登记过的 → 端口文件 → 约定端口」依次试，第一个应答的就认。
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

/** 这台机器是什么身份。判据与 `config.mjs` / `local-mode.mjs` 同一套（别另立一套） */
function modeOf() {
  const cp = String(readJson(CFG_FILE)?.controlPlane ?? '').trim();
  if (cp) return { id: 'client', label: '节点（这台机器已加入总机）', detail: cp };
  if (process.env.BANDI_HOST) return { id: 'host', label: '总机（显式指定了监听地址）', detail: process.env.BANDI_HOST };
  if (lanAllowed) return { id: 'host', label: '总机（允许局域网内的机器加入）', detail: '' };
  return { id: 'solo', label: '单机（只听本机）', detail: '' };
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
  bandi stop               停掉班底自己的服务（不碰别人的进程）
  bandi url [--open]       访问地址
  bandi logs [-n 40] [-f]  日志（-f 跟着走）
  bandi node               执行节点状态（只读）
  bandi mode               这台机器是什么身份（只读；改模式去页面）
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
