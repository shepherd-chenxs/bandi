#!/usr/bin/env node
/**
 * 节点：一台机器上的常驻进程 —— **主动连出**到控制面，报自己有什么、领活、干活、把过程报回去。
 *
 * 为什么是"连出"而不是"被连"：这样不要公网 IP、不用开端口、不用配 SSH，
 * 也就不用碰 NAT 打洞 —— 多机最难的那一块直接消失了（见 docs/形态决策.md）。
 *
 * 三条并行的循环：
 *   · **心跳**：告诉控制面"我还在"（三个周期收不到就算掉线）；
 *   · **领活**：长轮询挂着等（不是控制面推 —— 推要求能连到节点，而连不到才需要它）；
 *   · **干活**：领到了就在**本机**起 agent CLI（复用控制面同一套适配器），
 *     事件批量回传，最后报回执。
 *
 * 跑法：
 *   node apps/server/src/node.mjs
 *   BANDI_CONTROL_PLANE=http://192.168.1.9:8787 node apps/server/src/node.mjs
 *   BANDI_NODE_TOKEN=<控制面令牌> node apps/server/src/node.mjs   # 控制面监听非回环时必需
 *   node apps/server/src/node.mjs --once                          # 报到 + 心跳一次就退（验收用）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { dataDir } from './config.mjs';
import * as runtimes from './runtimes.mjs';
import * as externals from './externals.mjs';
import { adapterFor } from './adapters.mjs';

const STATE = process.env.BANDI_NODE_STATE ?? path.join(dataDir, 'node.json');
const CONFIG = path.join(dataDir, 'config.json');
const ONCE = process.argv.includes('--once');
/** 每次长轮询挂多久。太长会让"停止"这类反向指令送得慢，太短就是空转 */
const CLAIM_WAIT_MS = 20000;
const say = (s) => console.log(`[节点] ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 节点自己的配置 —— **总机在哪、我用哪枚令牌**（`<数据目录>/config.json`）。
 *
 * 为什么要有这个文件（2026-10-16）：原来地址走环境变量，而这个环境变量是写在
 * systemd 单元 / Startup 脚本里的 ✗ —— 换一回总机地址，就得在**每台机器**上重跑一遍"常驻安装" ✗。
 * 放进数据目录之后：改地址 = 改一个文件 + 重启 ✓。
 * 而且这里的令牌是**它自己的**（邀请码换来的 ✓），不是总机那枚 master ✓。
 *
 * 优先级：**环境变量 > 配置文件 > 默认**（脚本和用例仍能用环境变量压过去 ✓）。
 */
function readConfig() {
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    return typeof j === 'object' && j ? j : {};
  } catch {
    return {};
  }
}

function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  // 令牌在里面：权限收紧到只有自己能读
  fs.writeFileSync(CONFIG, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
  return next;
}

/**
 * 控制面令牌。优先级：`BANDI_NODE_TOKEN` > 配置文件里的 > 自己数据目录里的 `token` 文件。
 *
 * 为什么要留文件这条路：开机自启的脚本里**不该出现密钥** —— 脚本会被同步、被备份、
 * 被顺手看到。把令牌放进数据目录（权限收紧），自启脚本就只剩一句"起它"。
 */
function readToken(cfg = readConfig()) {
  const fromEnv = String(process.env.BANDI_NODE_TOKEN ?? process.env.BANDI_TOKEN ?? '').trim();
  if (fromEnv) return fromEnv;
  if (cfg.token) return String(cfg.token).trim();
  try {
    return fs.readFileSync(path.join(dataDir, 'token'), 'utf8').trim();
  } catch {
    return '';
  }
}

// `let`：`--join` 那一步会把它们换成"刚拿到的那套"
let CONTROL = (process.env.BANDI_CONTROL_PLANE ?? readConfig().controlPlane ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
let TOKEN = readToken();

/**
 * 自己的身份。**认文件、不认主机名** —— 主机名会被改、也可能两台重名，
 * 而"这台机器还是那台机器"必须跨重启稳定，否则控制面上会攒出一排僵尸设备。
 */
function ensureId() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    if (j?.id) return j.id;
  } catch { /* 没有或坏了：重新生成一个 */ }
  const id = 'node-' + crypto.randomUUID().slice(0, 8);
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify({ id, createdAt: new Date().toISOString() }, null, 2), 'utf8');
  return id;
}

/**
 * 这台机器上有什么 agent CLI —— 交给控制面。
 * 只报**探测到的**（detectAll 是纯 stat，不起进程）：一个都没探到就报空，
 * 省得控制面上出现一排"装了空气"的条目。
 */
function declared() {
  const out = [];
  for (const fam of runtimes.detectAll()) {
    const best = fam.candidates?.[0];
    if (!best) continue;
    out.push({ family: fam.id, label: fam.label, path: best.path, usable: !!best.usable });
  }
  return out;
}

const id = ensureId();
const label = os.hostname() || '未命名机器';
const platform = `${os.platform()} ${os.arch()}`;
/*
 * **主机名单独报一份**：控制面上「机器名」（人起的，如"我的笔记本"）与「主机名」
 * （这台机器的事实，如 `DESKTOP-XXXXXXX`）是两个字段。只报 label 的话，
 * 用户改完名字，下一次报到又会被主机名顶回去（见 store.upsertNode 那条 CASE）。
 */
const hostname = os.hostname() || label;
/**
 * 报到要带的东西。`externals` 是"这台机器上**班底之外**还要有的东西"的现状（装没装、网关通不通）——
 * 跟 runtimes 一样是**这台机器的事实**，控制面判不了，只能我们来报。
 * 探测里有一步是探端口，所以整体是异步的。
 */
async function payload() {
  return {
    id,
    label,
    hostname,
    platform,
    runtimes: declared(),
    externals: await declaredExternals(),
  };
}

async function post(p, body) {
  const r = await fetch(CONTROL + p, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(TOKEN ? { 'X-Bandi-Token': TOKEN } : {}),
    },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(CLAIM_WAIT_MS + 15000),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

/**
 * 心跳：只告诉控制面"我还在"。
 * 控制面没在跑**也不退出** —— 它回来之后，下一次心跳自己就接上了。
 */
async function heartbeatLoop(everySec) {
  for (;;) {
    await sleep(everySec * 1000);
    try {
      // 心跳**捎带**运行时清单：装了新 CLI 之后控制面不用等我重启就能看到（纯 stat，几毫秒）
      // 外部件现状同理（装了 magpie、网关起没起）
      const hb = await post(`/api/nodes/${encodeURIComponent(id)}/heartbeat`, {
        runtimes: declared(),
        externals: await declaredExternals(),
      });
      if (hb.status === 404) {
        say('控制面上已经没有我了，重新报到');
        await post('/api/nodes/register', await payload());
      } else if (hb.status === 401) {
        say('心跳被拒：控制面要求访问令牌 —— 设 BANDI_NODE_TOKEN 再起');
      } else if (hb.status !== 200) {
        say(`心跳异常（${hb.status}）：${hb.body?.error ?? ''}`);
      }
    } catch (e) {
      say(`心跳没送到：${e?.message ?? e}`);
    }
  }
}

/* ------------------------------------------------------------------ 干活 */

/**
 * 事件攒一攒再回传。为什么要攒：适配器吐的是**分块**事件，一次运行可能几十上百条，
 * 一条一个 HTTP 往返太浪费；但也不能攒太久，否则界面上"看着它干"就不实时了。
 */
function makeEventFlusher(runId, onStop) {
  let buf = [];
  let timer = null;
  let stopSeen = false;

  const send = async (force = false) => {
    if (!buf.length && !force) return;
    const events = buf;
    buf = [];
    try {
      const r = await post(`/api/runs/${encodeURIComponent(runId)}/events`, { events });
      // 响应里带回 stop = 人在控制面上点了停止（反向控制通道，不用另开连接）
      if (r.body?.stop) {
        stopSeen = true;
        onStop?.();
      }
    } catch { /* 送不回去就算了 —— 不能因为控制面抖一下就把本机正在干的活掐了 */ }
  };

  /*
   * **空批次心跳**（每 2 秒一次）不是多余的：停止指令是搭事件批次的响应回去的，
   * 而有的 CLI 可能长时间一声不吭（模型在想）。没有这个心跳，"点了停止"就得等它
   * 下一次开口才生效 —— 那可能是几分钟后。它同时还是个"我还在干"的信号。
   */
  const ping = setInterval(() => void send(true), 2000);

  return {
    push(evt) {
      buf.push(evt);
      if (buf.length >= 20) {
        void send();
        return;
      }
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          void send();
        }, 200);
      }
    },
    async flush() {
      clearInterval(ping);
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await send(true);
    },
    get stopSeen() {
      return stopSeen;
    },
  };
}

/**
 * 在这台机器上决定"用哪个可执行文件跑这个协议族"：
 * 先看**本机自己的运行时配置**（runtimes.json —— 那是这台机器的事实），再看自动探测。
 * 控制面只告诉我们"用哪个族"，**路径绝不由它指定**（它那台的路径在这儿多半不存在）。
 */
function resolveLocal(family) {
  const adapter = adapterFor(family);
  if (!adapter) return { adapter: null, cliPath: null, why: `没有「${family}」这个族的适配器` };
  const configured = runtimes
    .publicList()
    .find((r) => r.family === family && r.enabled && r.path && r.launchable !== false);
  if (configured) return { adapter, cliPath: configured.path };
  const found = runtimes.detectFamily(family).find((c) => c.usable);
  if (found) return { adapter, cliPath: found.path };
  return { adapter, cliPath: null, why: `这台机器上没有可用的「${family}」` };
}

/** 工作目录是**那台机器上的事实**：控制面给的是它那台的路径，这边可能压根没有 */
function cwdOf(want) {
  if (!want) throw new Error('控制面没给工作目录');
  if (!fs.existsSync(want)) {
    throw new Error(
      `这台机器上没有这个目录：${want}\n` +
        '  控制面传的是**它那台机器**的路径。同一个项目在两台机器上路径不同时该配什么，还没做 —— ' +
        '现在要么把两边路径弄成一样，要么换一台机器干这个活。',
    );
  }
  return want;
}

async function runJob(job) {
  say(`领到活：${job.family}（运行 ${job.runId}）`);
  const ctl = new AbortController();
  const flusher = makeEventFlusher(job.runId, () => {
    say('控制面说停 —— 掐掉这个子进程');
    ctl.abort();
  });

  let status = '失败';
  let exitCode = null;
  let error = null;
  let usage = null;
  let sessionId = job.sessionId ?? null;
  let finalText = '';

  try {
    const { adapter, cliPath, why } = resolveLocal(job.family);
    if (!adapter || !cliPath) throw new Error(why ?? `这台机器上跑不了「${job.family}」`);
    const cwd = cwdOf(job.cwd);
    say(`在 ${cwd} 里干活，用 ${cliPath}`);

    const res = await adapter({
      task: job.task,
      sessionId: job.sessionId,
      cwd,
      sandbox: job.sandbox ?? 'danger-full-access',
      model: job.model,
      cliPath,
      // 连接器（MCP 之类）是**控制面那台机器上的配置**：远端不注入，
      // 免得把别人家的地址和凭据带过来。要做的话得先有"每台机器各配一份"的机制。
      connectorArgs: [],
      onEvent: (evt) => flusher.push(evt),
      signal: ctl.signal,
    });

    await flusher.flush();
    const stopped = ctl.signal.aborted || flusher.stopSeen;
    const ok = !res.isError && (res.exitCode == null || res.exitCode === 0);
    status = stopped ? '已停止' : ok ? '完成' : '失败';
    exitCode = res.exitCode ?? null;
    error = stopped
      ? null
      : ok
        ? null
        : res.error?.message || res.error || res.stderr?.trim() || res.turnReason?.error?.message || `退出码 ${res.exitCode}`;
    usage = res.usage ?? null;
    sessionId = res.sessionId ?? sessionId;
    finalText = res.finalText ?? '';
    say(`干完了：${status}（退出码 ${exitCode}）`);
  } catch (e) {
    await flusher.flush();
    status = ctl.signal.aborted ? '已停止' : '失败';
    error = ctl.signal.aborted ? null : String(e?.message ?? e);
    say(`这个活没干成：${error}`);
  }

  try {
    // 失败本身也要**作为事件**回到控制面：不然界面上只有一句"结束"、看不到为什么
    if (error) await post(`/api/runs/${encodeURIComponent(job.runId)}/events`, { events: [{ type: 'error', message: error }] });
    const r = await post(`/api/runs/${encodeURIComponent(job.runId)}/finish`, {
      status,
      exitCode,
      error,
      usage,
      sessionId,
      finalText,
    });
    if (r.status !== 200) say(`回执没送到（${r.status}）：${r.body?.error ?? ''}`);
  } catch (e) {
    say(`回执没送到：${e?.message ?? e}`);
  }
}

/** 挂着等活。长轮询：有活立刻回，没活就挂到超时再来一次 */
async function claimLoop() {
  for (;;) {
    let r;
    try {
      r = await post(`/api/nodes/${encodeURIComponent(id)}/claim`, { waitMs: CLAIM_WAIT_MS });
    } catch (e) {
      say(`领活没送到：${e?.message ?? e}`);
      await sleep(3000);
      continue;
    }
    if (r.status === 404) {
      say('控制面上已经没有我了，重新报到');
      await post('/api/nodes/register', await payload());
      continue;
    }
    if (r.status === 401) {
      say('领活被拒：控制面要求访问令牌 —— 设 BANDI_NODE_TOKEN 再起');
      await sleep(10000);
      continue;
    }
    if (r.status !== 200) {
      say(`领活异常（${r.status}）：${r.body?.error ?? ''}`);
      await sleep(5000);
      continue;
    }
    const task = r.body?.task;
    if (task) {
      await runTask(task);
      continue; // 干完接着等活
    }
    const job = r.body?.job;
    if (!job) continue; // 挂到超时、空手回来 —— 再挂一次
    await runJob(job);
  }
}

/**
 * 找到那个命令**真正的路径**，并给出子进程该带的 PATH。
 *
 * ⚠️ **别指望 PATH**（2026-10-16 又栽了一次）：节点在 Linux 上多是 systemd 起的，
 * PATH 是 systemd 的默认值 —— 里头**没有** `~/.local/bin`，而 magpie 的安装脚本
 * **正是把命令放进 `~/.local/bin`** 的 ✗。症状很别扭：magpie 明明装上了
 * （`installed=true`），紧接着"装成常驻服务"却报 `spawn magpie ENOENT`。
 *
 * 同一个坑在**探测**那一侧踩过一次（npm 全局包），那次只修了探测、没修执行 —— **这次两边一起**：
 * 探测认"我自己这个 node 住的那个 prefix"，执行也照同一套思路找。
 */
const EXTRA_BIN_DIRS = [
  () => path.dirname(process.execPath), // node 自己旁边（npm 就在这儿，node_modules 也在）
  () => path.join(os.homedir(), '.local', 'bin'), // 用户态安装的落点（magpie 的脚本就放这儿）
  () => path.join(os.homedir(), 'bin'),
  () => '/usr/local/bin',
  () => '/usr/bin',
];

function binSearchDirs() {
  const out = [];
  for (const f of EXTRA_BIN_DIRS) {
    try {
      const d = f();
      if (d) out.push(d);
    } catch { /* 推不出来就跳过 */ }
  }
  // PATH 放最后：前面那些是"用户态装的东西会落在这儿"，比 PATH 更该信
  for (const d of String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) out.push(d);
  return [...new Set(out)];
}

/** 命令名 → 真实路径。找不到就原样返回（让系统去报它自己的错，信息更原生） */
function resolveBin(name) {
  if (!name || name.includes('/') || name.includes('\\')) return name; // 已经是路径
  for (const d of binSearchDirs()) {
    const p = path.join(d, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* 这个目录里没有，接着找 */ }
  }
  return name;
}

/**
 * 外部件现状 + **带密钥的面板链接**（一次报全，三处调用都走它）。
 *
 * 面板为什么要密钥：magpie 的页面**不带密钥就是 401**（2026-10-16 实测：
 * 我以为 `http://192.168.5.19:3430` 能直接开，结果"未经授权" ✗）。
 * 密钥不由我们编 —— 问它自己要（`magpie daemon web` 会打印带密钥的链接），
 * 而且**缓存 10 分钟**：密钥跨重启不变，没必要每次心跳都 spawn 一个进程。
 */
const panelCache = new Map();
async function panelUrlFor(id, port) {
  const hit = panelCache.get(id);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.url;
  const want = externals.lanAddrs();
  const url = await new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(resolveBin('magpie'), ['daemon', 'web'], {
        env: { ...process.env, PATH: binSearchDirs().join(path.delimiter) },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已经退了 */ }
      resolve(null);
    }, 4000);
    const onData = (c) => { out += String(c); };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      // 它会把每个网卡都列一遍（docker 的 172.x 也在里头）—— 挑"我自己那张局域网卡"那条
      const urls = [...out.matchAll(/https?:\/\/[^\s"']*\/\?k=[A-Za-z0-9._-]+/g)].map((m) => m[0]);
      const mine = urls.find((u) => want.some((ip) => u.includes(`//${ip}:${port}`)));
      resolve(mine ?? urls.find((u) => u.includes(`:${port}/`)) ?? null);
    });
  });
  panelCache.set(id, { url, at: Date.now() });
  return url;
}

/** 这台机器上的外部件现状（节点每次心跳、每次报到、每件活做完都报它） */
async function declaredExternals() {
  const list = await externals.declared();
  for (const e of list) {
    if (!e.panel || !e.panelPort) continue;
    const keyed = await panelUrlFor(e.id, e.panelPort);
    if (keyed) e.panelUrl = keyed; // 用带密钥的那条，盖掉"按局域网地址猜的"那条
  }
  return list;
}

/**
 * 让这台机器做件**小事** —— 目前只有「一键安装运行时」。
 *
 * ⚠️ 命令**不是控制面发过来的**：控制面只发一个族名，这里拿族名查**本机这份代码**里的表
 * （`runtimes.installCommandFor`）。所以这条通道永远变不成"谁拿着令牌谁就能在我机器上跑任意命令" ——
 * 这是这件事能成立的前提，不是顺手的设计。
 *
 * ⚠️ npm 去哪儿找：**别指望 PATH**。Linux 上节点多半是 systemd 起的，PATH 是 systemd 的默认值，
 * 里头**没有**用户态 Node 的 bin 目录（`~/.local/node/bin`）—— 那样"一键安装"会在最后一米失败
 * （跟探测那个坑同源）。我这台 node 的旁边就躺着它自带的 npm：`<dirname(process.execPath)>/npm`。
 */
async function runTask(task) {
  const tid = encodeURIComponent(task.id);
  const report = (body) =>
    post(`/api/nodes/${encodeURIComponent(id)}/tasks/${tid}/report`, body).catch(() => {});
  /*
   * 命令**从本机这张表里查**：装运行时查 runtimes 那张，外部件的某一步查 externals 那张。
   * 控制面只发了 id 与步骤 —— 这条边界就是"一键安装"能成立的前提。
   */
  const spec =
    task.kind === 'install-runtime'
      ? runtimes.installCommandFor(task.family)
      : task.kind === 'external-install' || task.kind === 'external-serve'
        ? // `task.arg` 是这个任务的参数（走镜像装的那个前缀）—— 照样只是**参数**：
          // 命令还是本机这张表里的固定命令，而且前缀会再过一次 mirrorOk（防注入，见那张表）
          externals.commandFor(task.kind === 'external-install' ? 'install' : 'serve', task.family, process.platform, {
            mirror: task.arg ?? '',
          })
        : null;
  if (!spec) {
    say(`控制面让我做「${task.kind} ${task.family}」，可本机这份代码里没有对应的命令`);
    return report({ status: '失败', output: `这台机器上的班底不认识「${task.kind} ${task.family}」，或者这一步在这里没法一键做\n` });
  }

  // 命令名 → 真实路径（`~/.local/bin` 那些也算，见 resolveBin 的注释）；子进程的 PATH 也一起补上
  const binPath = resolveBin(spec.bin);
  const childPath = binSearchDirs().join(path.delimiter);
  say(`开始做 ${task.kind} ${task.family}：${spec.cmd}`);

  // 输出节流：npm 刷得很快，攒 400ms 报一次（也让界面上的进度是"滚动的"而不是一行行跳）
  let buf = '';
  let lastAt = 0;
  const flush = async (force = false) => {
    if (!buf) return;
    const now = Date.now();
    if (!force && now - lastAt < 400) return;
    lastAt = now;
    const chunk = buf;
    buf = '';
    await report({ output: chunk });
  };

  const code = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(binPath, spec.args, {
        cwd: os.homedir(),
        env: { ...process.env, PATH: childPath },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      buf += `起不来：${e?.message ?? e}\n`;
      return resolve(-1);
    }
    const onData = (c) => {
      buf += String(c);
      flush().catch(() => {});
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (e) => {
      buf += `起不来：${e?.message ?? e}\n`;
      resolve(-1);
    });
    child.on('close', (c) => resolve(c ?? -1));
  });

  await flush(true);
  const ok = code === 0;
  await report({
    status: ok ? '完成' : '失败',
    output: ok ? '\n装完了。\n' : `\n（${spec.bin} 退出码 ${code}）\n`,
  });
  say(ok ? `${task.family} 装好了` : `${task.family} 装失败了（退出码 ${code}）`);

  /*
   * 装完**立刻把新清单报上去**，不等下一次心跳（最多 15 秒）——
   * 用户正盯着界面上那一行，等它从「未安装」跳到「已安装」。
   * 外部件也一样（装完 magpie 之后，"网关起没起"这一栏要马上变）。
   */
  try {
    await post(`/api/nodes/${encodeURIComponent(id)}/heartbeat`, {
      runtimes: declared(),
      externals: await declaredExternals(),
    });
  } catch {
    /* 下次心跳还会报 */
  }
}

/** 命令行参数取值：`--join http://…` */
function argOf(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? String(process.argv[i + 1] ?? '').trim() : '';
}

/**
 * **加入**：拿一次性邀请码，换回**只属于这台机器**的那枚令牌，然后写进配置。
 *
 * 为什么要这一步（2026-10-16）：原来节点直接用总机那枚 master 令牌 ✗ ——
 * 一台节点被翻等于整套被翻，而且「忘掉」踢不掉它（令牌还有效）。
 * 现在：邀请码（一次性、10 分钟）→ 这枚令牌只能干它自己那台的事 ✓；「忘掉」= 吊销 ✓。
 *
 * 用法：
 *   node apps/server/src/node.mjs --join http://总机:8787 --code bj_xxx
 * 换完接着正常跑（不用再起一次）✓。
 */
async function join(control, code) {
  const url = String(control).replace(/\/+$/, '');
  say(`加入 ${url}`);
  let r;
  try {
    r = await fetch(`${url}/api/nodes/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        id,
        label,
        hostname,
        platform,
        runtimes: declared(),
        externals: await declaredExternals(),
      }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    say(`连不上那台总机：${e?.message ?? e}`);
    process.exitCode = 1;
    return false;
  }
  const body = await r.json().catch(() => null);
  if (r.status !== 201 || !body?.token) {
    say(`加入被拒（${r.status}）：${body?.error ?? ''}`);
    process.exitCode = 1;
    return false;
  }
  writeConfig({ controlPlane: url, token: body.token });
  // 换成正拿到的那套（万一调用方接着用这个进程）
  CONTROL = url;
  TOKEN = body.token;
  say(`加入成功 —— 令牌已经写进 ${CONFIG}（权限 600），以后就用它了`);
  /*
   * ⚠️ **加入完就退出**，别接着当节点跑（2026-10-16 踩到）：第一版让它"换完继续跑"，
   * 于是这条命令**永不返回** ✗（节点本来就是个死循环）—— ssh/脚本会一直挂着，
   * 而用户以为它卡死了。现在它是**一条一次性命令**：写完配置、说清下一步、退出 ✓。
   */
  say('接着起（或重启）它：');
  say('  Linux:  systemctl --user restart bandi-node');
  say('  手动:   node apps/server/src/node.mjs   （或用 autostart 装成常驻）');
  return false; // false = "别接着跑"
}

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  /*
   * `--join <总机> --code <邀请码>`：先加入，把"总机在哪 + 我这枚令牌"写进配置，再照常跑。
   * 加入失败就退出（别用一个没换到的身份去连，那样只会收到一串 401 让人猜）。
   */
  const joinTo = argOf('--join');
  const joinCode = argOf('--code');
  if (joinTo || joinCode) {
    if (!joinTo || !joinCode) {
      say('加入要同时给两个：`--join http://总机:8787 --code bj_xxx`');
      process.exitCode = 2;
      return;
    }
    /*
     * ⚠️ 跑 `--join` 时**必须用跟服务同一个数据目录**（`BANDI_DATA`）——
     * 否则配置会写到别处（我就在真机上这么错过一次：写进了仓库的 `data/`，
     * 服务读的是 `~/.bandi-node`，两边对不上，节点直接哑了）。
     */
    say(`数据目录 ${dataDir}（服务必须用同一个）`);
    if (!(await join(joinTo, joinCode))) return; // 写入成功也**不再接着跑**（它是条一次性命令）
  }

  say(`控制面 ${CONTROL}`);
  say(`我是 ${label}（${id}）· ${platform}`);
  say(
    TOKEN
      ? `带着令牌（${readConfig().token ? '自己的那枚，在 config.json 里' : '来自环境变量或数据目录的 token 文件'}）`
      : '没有令牌 —— 控制面要是要求鉴权，报到会被拒',
  );
  const found = declared();
  say(
    found.length
      ? `探到 ${found.length} 个运行时：${found.map((f) => `${f.label}${f.usable ? '' : '（班底起不来）'}`).join('、')}`
      : '本机一个 agent CLI 都没探到',
  );

  let reg;
  try {
    reg = await post('/api/nodes/register', await payload());
  } catch (e) {
    return say(`连不上控制面：${e?.message ?? e} —— 先把控制面起起来（start.cmd），再起节点`);
  }
  if (reg.status !== 201) {
    if (reg.status === 401) {
      return say(
        '报到被拒：这个控制面**要求访问令牌**（它监听的不是回环地址）。\n' +
          '  · **推荐**：让管理员在控制面上点「添加设备」拿一个邀请码，然后\n' +
          '    `node apps/server/src/node.mjs --join <总机地址> --code <邀请码>` —— 换回这台机器**自己的**令牌 ✓\n' +
          '  · 或者：设 `BANDI_NODE_TOKEN=<操作员令牌>`（在控制面数据目录的 `token` 文件里）。\n' +
          '  ⚠️ 那枚令牌**不会**打进控制面的启动日志（2026-10-16 起）—— 别去日志里找。',
      );
    }
    return say(`报到被拒（${reg.status}）：${reg.body?.error ?? ''}`);
  }

  const every = Number(reg.body?.heartbeatSeconds ?? 15);
  say(`报到成功：心跳每 ${every} 秒一次，同时挂着等活`);

  if (ONCE) {
    const hb = await post(`/api/nodes/${encodeURIComponent(id)}/heartbeat`, { runtimes: declared() });
    say(hb.status === 200 ? '心跳一次，--once 收工' : `心跳失败（${hb.status}）：${hb.body?.error ?? ''}`);
    return;
  }

  // 两条循环并行：心跳报"我还在"，领活挂着等活
  void heartbeatLoop(every);
  await claimLoop();
}

main();
