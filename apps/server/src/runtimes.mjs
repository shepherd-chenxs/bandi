import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { dataDir } from './config.mjs';
import { listNodes, countNodeJobs, getNode, renameNode, scopeOfNode } from './store.mjs';
import * as codex from './codex.mjs';
import * as claude from './claude.mjs';
import * as dsh from './dsh.mjs';

/**
 * 运行时（agent CLI）管理。
 *
 * 两层概念：
 * - **协议族（family）**：codex / claude / dsh。写在代码里 —— 每接一个要写它的事件
 *   词汇映射（`claude.mjs` 那套），不是配置能变出来的。
 * - **运行时实例（runtime）**：某台设备上的一个具体配置（哪个可执行文件、什么名字、开不开）。
 *   同一族可以加多个实例（比如两个 Codex，一个带自定义参数）。
 *
 * 层次：**设备 → 该设备上的 agent CLI → 详情**。
 * 现在只有一台"本机"，因为执行端就是本进程 spawn 子进程；
 * 设备记录里已经把将来远程设备要用的字段留出来了（kind/host/port/user/keyPath）。
 */
const FILE = path.join(dataDir, 'runtimes.json');

const FAMILIES = {
  codex: {
    id: 'codex',
    label: 'Codex CLI',
    adapter: 'codex',
    sandboxes: ['danger-full-access', 'workspace-write', 'read-only'],
    // 实测：headless 无人审批时，开了沙箱的命令全被拒。所以这两档等于"禁用工具"。
    blocked: ['workspace-write', 'read-only'],
    note: '只有 danger-full-access 在无人审批下跑得动命令。',
    // 没装的时候给用户一条**能直接粘的命令** —— 别让他去猜自己去哪儿找安装包
    // `bin`/`args` 是给**一键安装**用的（shell-free：直接 spawn，不经过 shell）—— 见 installCommandFor
    install: { kind: 'npm', cmd: 'npm install -g @openai/codex', bin: 'npm', args: ['install', '-g', '@openai/codex'] },
  },
  claude: {
    id: 'claude',
    label: 'Claude Code',
    adapter: 'claude',
    // Claude 没有"沙箱"，对应概念是 --permission-mode
    sandboxes: claude.PERMISSION_MODES,
    blocked: [],
    note: '权限对应 --permission-mode；--resume 能续接会话记忆。',
    install: {
      kind: 'npm',
      cmd: 'npm install -g @anthropic-ai/claude-code',
      bin: 'npm',
      args: ['install', '-g', '@anthropic-ai/claude-code'],
    },
  },
  dsh: {
    id: 'dsh',
    label: 'DeepSeek Harness（headless）',
    adapter: 'dsh',
    sandboxes: ['workspace-write'],
    blocked: [],
    note: 'dsh.cmd 不在 PATH 上，路径必须是绝对路径。',
    // dsh 这个 CLI 是桌面端自带的，npm 上那个班底起不来（spawn .cmd 会 EINVAL）,
    // 所以不能给一条 npm 命令 —— 只能让他装桌面端
    install: { kind: 'app', cmd: '装 DeepSeek Harness 桌面端（这个 CLI 是它自带的）' },
  },
};

const ADAPTERS = { codex, claude, dsh };

/** 族 id → 人看的名字。报错和说明文字里用（别在界面/日志里裸奔一个 `claude`） */
export function familyLabel(id) {
  return FAMILIES[id]?.label ?? String(id ?? '');
}

/** 预置在本机的运行时：id 固定，可改不可删（删了就没有默认执行端了） */
const SEEDED = ['codex', 'dsh'];

const LOCAL_ID = 'local';

/**
 * 本机。
 * host/port/user/keyPath 都是 null —— 给将来的 SSH 设备预留：
 * 届时 kind='ssh'，平台用这些字段在那台机器上起同一个 CLI。
 */
const LOCAL_DEVICE = {
  id: LOCAL_ID,
  kind: 'local', // local | ssh（未实现）
  label: os.hostname() || '本机',
  platform: `${os.platform()} ${os.arch()}`,
  host: null,
  port: null,
  user: null,
  keyPath: null,
  note: '执行端就在这台机器上（平台直接起子进程）。',
};

function readSaved() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeSaved(obj) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(obj, null, 2), 'utf8');
}

/** 老格式（顶层直接是 codex/dsh）也要能读，不然升级会丢配置 */
function savedRuntimesFor(saved, deviceId) {
  const scoped = saved?.devices?.[deviceId]?.runtimes;
  if (scoped && typeof scoped === 'object') return scoped;
  if (deviceId === LOCAL_ID) {
    const legacy = {};
    for (const id of SEEDED) if (saved?.[id]) legacy[id] = saved[id];
    return legacy;
  }
  return {};
}

/**
 * 族默认值 ← 保存的覆盖。id 和族由调用方给。
 *
 * ⚠️ `path` **没有默认值**：以前这里会退回 `f.defaultPath`（一个写死的开发机路径）。
 * 那等于"没探测到也能建出一个运行时"，而它会指向一个不存在的文件。
 * 现在路径只能来自探测（见 detectFamily），或者用户手填。
 */
function makeRuntime(familyId, id, label, savedEntry = {}) {
  const f = FAMILIES[familyId];
  if (!f) return null;
  return {
    id,
    family: familyId,
    adapter: f.adapter,
    label: label || f.label,
    note: savedEntry.note ?? f.note,
    enabled: savedEntry.enabled !== false,
    path: savedEntry.path ?? '',
    sandboxes:
      Array.isArray(savedEntry.sandboxes) && savedEntry.sandboxes.length ? savedEntry.sandboxes : f.sandboxes,
    blocked: Array.isArray(savedEntry.blocked) ? savedEntry.blocked.map(String) : f.blocked,
    builtIn: SEEDED.includes(id),
    deviceId: LOCAL_ID,
  };
}

/**
 * 设备清单。
 * 目前只会产出本机一条：其他设备要等**远程执行**做出来才有意义，
 * 现在凭空列出来只会是点不动的假象。
 *
 * ⚠️ **不再预置 codex / dsh 两条空壳。** 以前无论有没有配置，都会拿
 * `f.defaultPath`（写死的开发机路径）造出这两条 —— 换台机器就是两个指向空气的运行时。
 * 现在"有什么"完全由 `runtimes.json` 说了算：要么是探测到之后接进来的，
 * 要么是用户手填的。新机器一开始列表是空的，点「识别本机运行时」就有了。
 */
export function loadDevices() {
  const saved = readSaved();
  const perDevice = savedRuntimesFor(saved, LOCAL_ID);

  const runtimes = [];
  for (const [id, entry] of Object.entries(perDevice)) {
    // 老格式里 `codex` / `dsh` 这两条的 id 本身就是族名，entry 里没有 family 字段
    const fam = entry?.family ?? (FAMILIES[id] ? id : null);
    const r = makeRuntime(fam, id, entry?.label, entry ?? {});
    // 上一次自动更正过的痕迹，从配置里带回来（界面据此标出来，见 healLocalRuntimes）
    if (r && entry?.healedFrom) r.healedFrom = entry.healedFrom;
    if (r) runtimes.push(r);
  }

  /*
   * 记录里的路径可能已经过时了 —— 修一下再发出去（见 healLocalRuntimes）。
   * 必须在 publicRuntime 之前：那一层才算出 pathExists / launchable。
   */
  healLocalRuntimes(runtimes);

  /*
   * 已报到的节点也进这个列表 —— 它们的运行时**可以被派活**（2026-10-15 起领活做了）。
   *
   * ⚠️ 但它们是 `remote: true` 的：`runs.startRun` 见到这个标记就**不会在本机 spawn**，
   * 而是把活放进队列等那台机器来领。这条分支就是当初那个"远程运行时不许进 loadDevices()"
   * 的守卫的正式替代 —— 守卫是为了"别拿着别人的路径在本机起进程"，现在由分支保证同一件事，
   * 而且不必再把节点挡在门外。
   */
  return [{ ...localDevice(saved), runtimes }, ...listNodes().map(nodeAsDevice)];
}

/** 心跳节奏与掉线判据：15 秒一次，三个周期收不到就算掉线。**只在这里定义一次** */
export const NODE_HEARTBEAT_SEC = 15;
export const NODE_OFFLINE_AFTER_MS = NODE_HEARTBEAT_SEC * 3 * 1000;

/**
 * **路径自愈**：控制面记的是"接进来那一刻的路径"，探测却每次重算。
 * CLI 一升级，路径就可能变（npm 的 `node_global\claude.cmd` → 包里的 `bin\claude.exe`），
 * 于是记录里那条成了旧的 —— 而它**恰恰是不能用的那种**（`.cmd` shim 班底起不动）。
 *
 * 症状（2026-10-16 用户报的"本地和服务端状态对不上"）：桌面版看**本机**说「班底起不来」，
 * 云端看**同一个节点的同一台机器**说「在线」—— 因为节点每次心跳都现探、永远新鲜，
 * 控制面记的那条却是旧的。同一台机器两个说法，人当然懵。
 *
 * 只在**两条同时成立**时才动手：① 记的那条确实不能用了（文件没了 / 班底起不来）；
 * ② 同一族现在探得到一个能用的。这时切过去只会更好不会更差 ——
 * 旧值留在 `healedFrom` 里、界面也标出来，**不静默**。
 *
 * 只治**启用的**那些：停用是用户明确关掉的，不该顺手改它的配置。
 */
function healLocalRuntimes(runtimes) {
  /*
   * ⚠️ **必须在 loadDevices() 的调用栈里安全**（2026-10-16 踩了个狠的）：
   * 第一版这里调的是 `saveRuntime(...)`，而它内部走 `getRuntime` → `getDevice` → **`loadDevices()`**，
   * 于是又回到这个函数 —— 无限递归，控制面进程活着、CPU 一直涨、端口不响应，
   * 日志里还**什么都不报**（看着像"起不来"，实际是自己套自己）。
   * 所以这里**直接读写那份配置**，一个函数都不碰会回到 loadDevices 的入口。
   */
  if (healing) return;
  healing = true;
  try {
    let saved = null;
    let changed = false;
    for (const r of runtimes) {
      if (!r.enabled || r.remote) continue;
      if (exists(r.path) && launchable(r.family, r.path)) continue;
      const ok = detectFamily(r.family).find((c) => c.usable);
      if (!ok || ok.path === r.path) continue;
      if (!saved) saved = readSaved();
      const entry = ensureScoped(saved, LOCAL_ID)[r.id];
      if (!entry) continue;
      const old = r.path;
      entry.path = resolveCliPath(r.family, ok.path);
      // 旧值也**存进去**：不存的话，界面只在"那次请求"上标一下，之后就查无此账 ——
      // 用户只会发现路径被悄悄改了。存下来界面才能一直说清"改成什么、原来是什么"。
      // 用户自己手工改一次路径，saveRuntime 会写一份没有 healedFrom 的新对象，这条痕迹自然就消了。
      entry.healedFrom = old;
      r.healedFrom = old;
      r.path = entry.path;
      changed = true;
      console.log(`[运行时] 「${r.label}」记的路径不能用了（${old}），已自动切到探测到的 ${entry.path}`);
    }
    if (changed && saved) writeSaved(saved);
  } finally {
    healing = false;
  }
}

/** 防重入：见 healLocalRuntimes 里那个递归的注释 */
let healing = false;

/** 节点在不在线：三个心跳周期收不到就算掉线 */
function nodeOnline(n, now = Date.now()) {
  return now - Date.parse(n.lastSeenAt) < NODE_OFFLINE_AFTER_MS;
}

/** 节点 → 设备形状（内部用，带 runtimes；对外由 publicDevice 抹平） */
function nodeAsDevice(n) {
  const online = nodeOnline(n);
  const declared = declaredRuntimesOf(n);
  const runtimes = declared.map((r, i) => {
    const fam = FAMILIES[r.family];
    return {
      id: `${n.id}:${r.family}${i ? `-${i}` : ''}`,
      family: r.family,
      adapter: fam?.adapter ?? r.family,
      /*
       * ⚠️ 名字里**必须带机器名**：不然两台机器都叫「Codex CLI」，
       * 员工那个下拉里根本分不出活会落在哪台机器上（2026-10-14 实测踩到）。
       */
      label: `${r.label ?? fam?.label ?? r.family}（${n.label}）`,
      // 节点不在线也**照样可派** —— 活排队等它回来，这就是"离线排队"
      enabled: true,
      remote: true,
      deviceId: n.id,
      deviceLabel: n.label,
      nodeOnline: online,
      // 路径是**那台机器上的事实**，本机判不了：用节点自报的，别在这儿 existsSync
      path: r.path ?? '',
      pathExists: r.usable !== false,
      launchable: r.usable !== false,
      sandboxes: fam?.sandboxes ?? [],
      blocked: fam?.blocked ?? [],
      note: '远程节点自报',
      builtIn: false,
    };
  });
  return {
    id: n.id,
    kind: 'node',
    label: n.label,
    // 主机名单独留着：标题给人起的名字，小字回真实主机名 —— 两台机器重名时才分得清谁是谁
    hostname: n.hostname ?? n.label,
    // 这个名字是不是人起的（决定那台机器下次报到时会不会被它自己的主机名顶掉）
    renamed: !!n.renamed,
    platform: n.platform,
    host: null,
    port: null,
    user: null,
    keyPath: null,
    note: '远程节点（主动连出）',
    online,
    lastSeenAt: n.lastSeenAt,
    /*
     * **权限 scope**（2026-10-20，决策 A / P1-3）：设备详情那一行「这台能看到面板」用它。
     * 来源是**令牌**（`node_tokens.scope`），不是 nodes 表 —— 多枚令牌取并集；
     * `null` = 一枚有效令牌都没有（被「忘掉」过），那时它什么也做不了。
     */
    scope: scopeOfNode(n.id),
    // 「最近使用」= 真的用面板的时间（心跳是 lastSeenAt，两件事别混）
    lastUsedAt: n.lastUsedAt ?? null,
    heartbeatSeconds: NODE_HEARTBEAT_SEC,
    // 队列里还压着多少活 —— 节点离线时这个数会一直涨，那就是"离线排队"看得见的样子
    pendingJobs: countNodeJobs(n.id),
    runtimes,
    // 那台机器上"班底之外还要有的东西"的现状（它自己报的）—— 说明表与判定在 server 层配
    externalsProbed: declaredExternalsOf(n),
  };
}

/**
 * 节点清单（带运行时与队列深度）—— `/api/nodes` 用它。
 * 与 `/api/devices` 是**同一份映射**：节点出现在哪都长一个样，别各写一套。
 */
export function publicNodes() {
  return listNodes().map((n) => publicDevice(nodeAsDevice(n)));
}

function declaredRuntimesOf(n) {
  try {
    const a = JSON.parse(n.runtimes || '[]');
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

/** 那台机器自报的「外部件」现状（装了没、网关通不通）。**跟 runtimes 一样是它自己的事实** */
function declaredExternalsOf(n) {
  try {
    const a = JSON.parse(n.externals || '[]');
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

export function getDevice(id) {
  return loadDevices().find((d) => d.id === id) ?? null;
}

export function getRuntime(deviceId, runtimeId) {
  return getDevice(deviceId)?.runtimes.find((r) => r.id === runtimeId) ?? null;
}

/**
 * 给一次运行找执行端：员工只记 runtime id，哪台设备来跑由这里挑。
 *
 * **`auto` = 用当下能跑的第一个**（2026-10-18）。
 * 只有内置的「喜儿」用它：新装的机器上还没有任何运行时，她不该因为"没绑定"就没法用；
 * 用户接上任意一个 CLI（Claude Code / Codex / dsh…）之后，她下一次派活就自动落过去。
 *
 * 普通员工**不该**用 auto —— 他们干的是具体活，该明确绑一个（否则换机器/换 CLI 时
 * 行为会悄悄变）。这条只是给"出厂就在、但出厂时可能一台 CLI 都没有"的那个人留的。
 */
export function resolveForRun(runtimeId) {
  if (String(runtimeId ?? '') === 'auto') {
    for (const d of loadDevices()) {
      const hit = d.runtimes.find(usableNow);
      if (hit) return hit;
    }
    return null;
  }
  for (const d of loadDevices()) {
    const rt = d.runtimes.find((r) => r.id === runtimeId);
    if (rt) return rt;
  }
  return null;
}

/** 现在就能起活吗：启用的、有路径的、班底起得来的（远端那台能不能起是它自己的事） */
function usableNow(r) {
  if (!r || !r.enabled) return false;
  if (r.remote) return true;
  return !!r.path && launchable(r.family, r.path);
}

function ensureScoped(saved, deviceId) {
  if (!saved.devices) saved.devices = {};
  if (!saved.devices[deviceId]) saved.devices[deviceId] = { runtimes: {} };
  if (!saved.devices[deviceId].runtimes) saved.devices[deviceId].runtimes = {};
  return saved.devices[deviceId].runtimes;
}

/**
 * 给一台机器起名 —— **跟主机名分开**。
 *
 * 主机名（`os.hostname()`）是那台机器的事实；机器名是人给它的称呼（比如「我的笔记本」）。
 * 混成一个字段的后果：改完名，那台机器下次报到又把自己的主机名顶上来，白改。
 * 所以本机那份存在 `runtimes.json` 的 `devices.local.label`；节点那份存在控制面的 `nodes` 表
 * （那台机器下次报到也不会顶掉，见 `store.upsertNode` 里那条 CASE）。
 *
 * **传空 = 恢复默认**（回到主机名）。
 */
export function renameDevice(deviceId, label) {
  const name = String(label ?? '').trim();
  if (deviceId === LOCAL_ID) {
    const saved = readSaved();
    ensureScoped(saved, LOCAL_ID);
    if (name) saved.devices[LOCAL_ID].label = name;
    else delete saved.devices[LOCAL_ID].label;
    writeSaved(saved);
    return publicDeviceById(LOCAL_ID);
  }
  if (!getNode(deviceId)) return null; // 节点才允许这么改
  renameNode(deviceId, name);
  return publicDeviceById(deviceId);
}

/** 本机设备：名字可以是人起过的（`devices.local.label`），主机名永远是 `os.hostname()` */
function localDevice(saved) {
  const host = os.hostname() || '本机';
  const custom = String(saved?.devices?.[LOCAL_ID]?.label ?? '').trim();
  return { ...LOCAL_DEVICE, label: custom || host, hostname: host, renamed: !!custom };
}

/** 只持久化可改的几项；id/family/adapter 属于代码，不允许改 */
export function saveRuntime(deviceId, runtimeId, patch = {}) {
  const current = getRuntime(deviceId, runtimeId);
  if (!current) return null;

  // 路径不能在"没给"的时候被悄悄补上一个写死的默认值 —— 那会造出指向空气的运行时。
  // 空字符串也一样：用户把框清空了就是想清空，不该替他填。
  let nextPath = current.path;
  if (patch.path !== undefined) {
    const given = String(patch.path).trim();
    if (!given) return { error: '可执行路径不能空 —— 去「设置 → 运行时」点「识别本机运行时」拿一个，或手工填' };
    nextPath = resolveCliPath(current.family, given);
  }

  const saved = readSaved();
  const scoped = ensureScoped(saved, deviceId);
  scoped[runtimeId] = {
    family: current.family,
    label: current.label,
    enabled: patch.enabled === undefined ? current.enabled : !!patch.enabled,
    path: nextPath,
    sandboxes:
      Array.isArray(patch.sandboxes) && patch.sandboxes.length ? patch.sandboxes.map(String) : current.sandboxes,
    blocked: Array.isArray(patch.blocked) ? patch.blocked.map(String) : current.blocked,
    note: patch.note === undefined ? current.note : String(patch.note),
  };

  // 老格式的顶层键留着会和新结构打架
  for (const id of SEEDED) delete saved[id];

  writeSaved(saved);
  // 同上：发公开形状（内部对象缺 publicRuntime 补的那些字段）
  return publicRuntime(getRuntime(deviceId, runtimeId));
}

let seq = 0;
function newRuntimeId() {
  seq += 1;
  return `rt-${Date.now().toString(36)}${seq.toString(36)}`;
}

/** 加一个运行时实例。family 必须在代码里支持，否则加了也跑不起来 */
export function addRuntime(deviceId, { family, label, path: cliPath, note } = {}) {
  if (!FAMILIES[family]) {
    return { error: `不支持这个协议族：${family}。目前支持 ${Object.keys(FAMILIES).join(' / ')}` };
  }
  if (!getDevice(deviceId)) return { error: '没有这台设备' };

  // 没路径就不建 —— 以前这里会退回 `FAMILIES[family].defaultPath`（写死的开发机布局），
  // 于是"没探测到"也能建出一个指向不存在文件的运行时，用户还以为接进来了。
  const given = String(cliPath ?? '').trim();
  if (!given) {
    return { error: '没有给可执行路径 —— 点「识别本机运行时」会自己探测；探测不到就手工填一个' };
  }

  const saved = readSaved();
  const scoped = ensureScoped(saved, deviceId);
  const id = newRuntimeId();
  scoped[id] = {
    family,
    label: String(label || '').trim() || FAMILIES[family].label,
    enabled: true,
    // 用户可能填的是安装目录 —— resolveCliPath 会往里找到真正的可执行文件
    path: resolveCliPath(family, given),
    sandboxes: FAMILIES[family].sandboxes,
    blocked: FAMILIES[family].blocked,
    note: String(note || '').trim() || FAMILIES[family].note,
  };
  for (const sid of SEEDED) delete saved[sid];
  writeSaved(saved);
  // ⚠️ 返回**公开形状**，不是内部对象：内部对象没有 pathExists / defaultPath 这些
  // 由 publicRuntime 补上的字段，直接发出去的话，同一个东西在
  // /api/devices/:id 和 POST/PATCH 的响应里形状不一样 —— 迟早坑到调用方。
  return { runtime: publicRuntime(getRuntime(deviceId, id)) };
}

/** 删运行时。预置的不让删 —— 删了就没有默认执行端了 */
export function removeRuntime(deviceId, runtimeId) {
  const rt = getRuntime(deviceId, runtimeId);
  if (!rt) return { error: '没有这个运行时' };
  if (SEEDED.includes(runtimeId)) return { error: '预置运行时不能删，只能停用' };

  const saved = readSaved();
  const scoped = ensureScoped(saved, deviceId);
  delete scoped[runtimeId];
  writeSaved(saved);
  return { removed: true };
}

/** 实探一次：跑 `--version`，验证路径有效并拿版本号 */
/**
 * 探测前先判一次"班底起得来吗"，起不来就直接给一句人话。
 *
 * 为什么不让 spawn 自己去撞：它抛出来的原文是 `起不来：EINVAL spawn EINVAL`，
 * 用户看不懂，也不知道该改哪里（2026-10-15 用户实报："这个填好的可执行路径感觉有问题"）。
 * 这里直接说清**是哪一类问题、该指向什么**。
 */
function unlaunchableReason(familyId, p) {
  if (!p) return '没有可执行路径';
  if (!exists(p)) return `找不到这个文件：${p}`;
  if (launchable(familyId, p)) return null;
  const ext = path.extname(p).toLowerCase();
  const isScript = ext === '.cmd' || ext === '.bat';
  // 按族给"该指向什么"，别一律说"换成 .exe"——dsh 根本没有 .exe 那种形态
  if (familyId === 'codex') {
    return isScript
      ? 'codex 是用 node 起的，PATH 上那个 .cmd 喂不进 node —— 请指向 .js 真身（node_modules\\@openai\\codex\\bin\\codex.js）'
      : 'codex 是用 node 起的，路径要指向 .js';
  }
  if (familyId === 'dsh') {
    return 'dsh 要桌面包布局（Electron + app.asar），npm 装的那个 .cmd shim 起不来 —— 装一个 DeepSeek Harness 桌面端';
  }
  if (isScript) {
    if (familyId === 'claude') {
      return '这是个 .cmd 批处理脚本，班底不能直接启动它 —— 请指向 .exe 真身（node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe）';
    }
    return `这是个 ${ext} 批处理脚本，班底不能直接启动它 —— 请指向它背后的 .exe`;
  }
  return '这个文件班底起不来';
}

export async function probe(deviceId, runtimeId) {
  const rt = getRuntime(deviceId, runtimeId);
  if (!rt) return { ok: false, error: '没有这个运行时' };
  const why = unlaunchableReason(rt.family, rt.path);
  if (why) return { ok: false, error: why, path: rt.path };
  const adapter = ADAPTERS[rt.adapter];
  if (!adapter?.probe) return { ok: false, error: '这个协议族没有实现探测' };
  const r = await adapter.probe(rt.path);
  return { ...r, path: rt.path };
}

function publicRuntime(r) {
  return {
    id: r.id,
    family: r.family,
    label: r.label,
    enabled: r.enabled,
    path: r.path,
    /*
     * 这个实例记的那个文件还在不在。**和族级探测是两件事**：
     * 探测回答"这台机器上装了什么"，这一列回答"我记的这个位置还有效吗" ——
     * 用户手动指过路径、或那个 CLI 后来被卸载了，都会让它是 false。
     *
     * ⚠️ 远端运行时（`remote: true`）的路径在**那台机器**上，本机判不了 ——
     * 那种情况用节点自报的值，绝不在这儿 existsSync。
     *
     * 这一条 2026-10-16 才补上：注释早就这么写着，代码却在下面**照样本机判** ——
     * 于是控制面在火山（Linux）上，看着笔记本报来的 `D:\AppData\...`，
     * `existsSync` 必然 false，三个运行时全被标成「班底起不来」。
     * 本机看是好的（两边路径恰好都存在），一放到云端就露馅。
     */
    pathExists: r.remote ? r.pathExists !== false : exists(r.path),
    /*
     * 文件在，但**班底起不来**（比如指到了 .cmd shim）—— 和 `pathExists` 是两件事：
     * 前者只回答"文件在不在"，这一列回答"点了派活能不能真的跑起来"。
     * 纯扩展名判断，很便宜，所以能跟着列表一起发；界面据此在行上标出来，
     * 不用点进详情页才靠「检测」发现（2026-10-15 用户实报的正是这种：
     * 列表看着正常，点进去一检测就是 EINVAL）。
     *
     * 远端同理：**能不能起来是那台机器的事**，控制面只能信它自报的 `usable`。
     */
    launchable: r.remote ? r.launchable !== false : launchable(r.family, r.path),
    // 这条路径是**自动更正**过来的（旧的不能用了，见 healLocalRuntimes）—— 界面据此标一下
    ...(r.healedFrom ? { healedFrom: r.healedFrom } : {}),
    sandboxes: r.sandboxes,
    blocked: r.blocked,
    note: r.note,
    builtIn: r.builtIn,
    deviceId: r.deviceId,
    // 远端那台机器上的运行时：可派活，但**控制面不 spawn 它**（见 runs.startRun 的分支）
    ...(r.remote ? { remote: true, deviceLabel: r.deviceLabel, nodeOnline: r.nodeOnline } : {}),
  };
}

function publicDevice(d, { withRuntimes = true } = {}) {
  return {
    id: d.id,
    kind: d.kind,
    label: d.label,
    // 主机名（那台机器的事实）。名字是"人给它的称呼"，两者分开 —— 见 renameDevice
    hostname: d.hostname ?? d.label,
    renamed: !!d.renamed,
    platform: d.platform,
    host: d.host,
    port: d.port,
    user: d.user,
    keyPath: d.keyPath,
    note: d.note,
    runtimeCount: d.runtimes.length,
    // 节点才有的几项：在不在线、上次心跳、队列里压着几个活
    ...(d.kind === 'node'
      ? {
          online: d.online,
          lastSeenAt: d.lastSeenAt,
          /*
           * 权限与"最近使用"（2026-10-20）：设备详情那一行「这台能看到面板 · 最近使用 …」。
           * `scope` 是规范串（`'compute panel'` / `'compute'` / `'panel'`），`null` = 没有有效令牌。
           */
          scope: d.scope ?? null,
          lastUsedAt: d.lastUsedAt ?? null,
          heartbeatSeconds: d.heartbeatSeconds,
          pendingJobs: d.pendingJobs,
          // 它自报的「外部件」现状 —— server 层会配上说明表一起发（见 withExternals）
          externalsProbed: d.externalsProbed ?? [],
        }
      : {}),
    ...(withRuntimes ? { runtimes: d.runtimes.map(publicRuntime) } : {}),
  };
}

export function publicDevices() {
  return loadDevices().map((d) => publicDevice(d, { withRuntimes: false }));
}

export function publicDeviceById(id) {
  const d = getDevice(id);
  return d ? publicDevice(d) : null;
}

/**
 * 运行时的扁平清单 —— 员工配置里的「Runtime」下拉用它。
 *
 * 2026-10-15 起**远端节点的运行时也在这里**：于是"把这个人派到那台机器上"就是
 * 在下拉里选一个带节点前缀的 id（如 `node-abc:codex`），不用另造一套"指派机器"的交互 ——
 * 员工本来就绑 runtime，多机只是 runtime 多了一种。
 */
export function publicList() {
  return loadDevices().flatMap((d) => d.runtimes.map(publicRuntime));
}

/* ------------------------------------------------ 探测：这台机器上装了哪个 CLI */

/**
 * 在 PATH 里找可执行文件。**纯 existsSync，不起进程。**
 *
 * 为什么不用 `where` / `which`：那要 spawn 一个子进程（几十毫秒 + 一层 shell 引号坑），
 * 而这里最多 stat 几十次、同量级就完了。24 个 PATH 目录 × 几个扩展名 ≈ 几毫秒。
 */
function findOnPath(names) {
  const dirs = String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', '.ps1', ''] : [''];
  for (const dir of dirs) {
    for (const name of names) {
      for (const ext of exts) {
        const p = path.join(dir, name + ext);
        try {
          if (fs.existsSync(p)) return p;
        } catch { /* 目录不可读就跳过 */ }
      }
    }
  }
  return null;
}

/** PATH 上那些带 node_modules 的目录 —— 就是 npm 全局前缀的候选（不 spawn `npm prefix -g`） */
function npmPrefixes() {
  const dirs = String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const out = new Set();
  for (const d of dirs) {
    try {
      // 形态一：PATH 上那个目录**自己**就带 node_modules（Windows 的 `%APPDATA%\npm` 就是这样）
      if (fs.existsSync(path.join(d, 'node_modules'))) out.add(path.resolve(d));
      /*
       * 形态二：**Linux / macOS 的 npm 全局布局** —— `<prefix>/bin` 在 PATH 上，
       * 包其实在 `<prefix>/lib/node_modules`（`/usr/local/bin` ↔ `/usr/local/lib/node_modules`）。
       *
       * 2026-10-16 补：原来只认形态一，于是 Linux 上这个函数**返回空**，
       * codex / claude 的"真身"候选全落空 —— 探到个 shim，标成"班底起不来"就完事。
       */
      const lib = path.resolve(d, '..', 'lib');
      if (fs.existsSync(path.join(lib, 'node_modules'))) out.add(lib);
    } catch { /* 不可读就跳过 */ }
  }
  /*
   * 形态三：**我自己这个 node 住的那个 prefix**（2026-10-16 补）。
   *
   * 为什么光靠 PATH 不够：执行节点在 Linux 上是用 **systemd** 起的，它的 PATH 是 systemd 的
   * 默认值（`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`）——**没有**
   * `~/.local/node/bin`。于是"用户态装的 Node + 一键 `npm i -g`"这条路会在最后一米断掉：
   * 包确实装进 `~/.local/node/lib/node_modules` 了，节点却**认不出来**。
   *
   * `process.execPath` 恰好回答"我在哪儿跑的"：`<prefix>/bin/node` → 上面就是 prefix ✓。
   * 这条跟 PATH 无关，所以 systemd / 计划任务 / 双击启动都一样准。
   *
   * ⚠️ 约定的形状：**加进去的必须是"直接装着 node_modules 的那个目录"**（调用方一律拼
   * `path.join(d, 'node_modules', …)`）。Linux 的包在 `<prefix>/lib/node_modules`，
   * 所以要加 `<prefix>/lib` 而**不是** `<prefix>` —— 第一版就栽在这儿（加了 prefix，
   * 拼出 `<prefix>/node_modules/…`，Linux 上压根没这个目录，探测全落空）。
   */
  try {
    const own = path.resolve(path.dirname(process.execPath), '..'); // <prefix>
    const lib = path.join(own, 'lib');
    if (fs.existsSync(path.join(lib, 'node_modules'))) out.add(lib);
    // Windows 那种"prefix 自己就带 node_modules"的布局（`%APPDATA%\npm`）也顺手认一下
    if (fs.existsSync(path.join(own, 'node_modules'))) out.add(own);
  } catch { /* 推不出来就算了 */ }
  return [...out];
}

/**
 * "桌面应用可能装在哪儿"的那些根目录。
 *
 * 为什么不能只认 `%LOCALAPPDATA%\Programs`：**这台机器就不是那样装的** ——
 * DSH 桌面端在 `D:\AppData\Local\Programs\`，而 `LOCALAPPDATA` 指的是
 * `C:\Users\admin\AppData\Local`（两套 AppData）。
 *
 * 所以补一条：从 PATH 里那些**本身就住在 `\AppData\` 下面**的条目推盘符
 * （比如 PATH 里有 `D:\AppData\nodejs`，就再试一个 `D:\AppData\Local\Programs`）。
 *
 * 为什么要加"住在 AppData 下面"这个条件：不加的话 `C:\Windows\system32`
 * 也会推出一个 `C:\AppData\Local\Programs` —— 一个根本不存在的假根，
 * 白白多 stat 几次，列出来还让人困惑。
 */
function appRoots() {
  const roots = new Set();
  const push = (p) => { if (p) roots.add(path.resolve(p)); };
  push(process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'));
  push(process.env.ProgramFiles);
  push(process.env['ProgramFiles(x86)']);
  for (const d of String(process.env.PATH ?? '').split(path.delimiter)) {
    const m = /^([A-Za-z]:)[\\/]AppData[\\/]/i.exec(String(d).trim());
    if (m) push(path.join(m[1] + path.sep, 'AppData', 'Local', 'Programs'));
  }
  return [...roots];
}

/**
 * 每个族的"去哪儿找"。返回的候选**不一定存在** —— 存在的排前面，
 * 最后一个永远是 bandi 预设的默认位置（它多半是开发那台机器的布局，换台机器就失效）。
 *
 * ⚠️ codex 要的是 `bin/codex.js` 而不是 PATH 上那个 `codex.cmd`：
 * bandi 是用 `node <js>` 起它的（见 codex.mjs 的 launchCommand），shim 喂不进去。
 */
const DETECT = {
  codex() {
    const out = [];
    const shim = findOnPath(['codex']);
    if (shim) {
      const js = path.join(path.dirname(shim), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      out.push({ path: js, source: `PATH 上的 ${path.basename(shim)}（推出真身）` });
    }
    for (const d of npmPrefixes()) {
      out.push({ path: path.join(d, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), source: 'npm 全局包' });
    }
    return out;
  },
  claude() {
    const out = [];
    const shim = findOnPath(['claude']);
    if (shim) {
      /*
       * 跟 codex 一样"推出真身"：PATH 上那个 `claude` / `claude.cmd` 只是 npm 的转发脚本，
       * 班底**直接 spawn** 它（见 claude.mjs 的 launchCommand）—— Windows 上必 EINVAL。
       *
       * 真身按平台不同（2026-10-16 补）：Windows 是 `bin/claude.exe`（原生二进制）；
       * Linux/macOS 是 `cli.js`（可执行、带 shebang —— 内核会自己按 shebang 跑），
       * 新版也有 `bin/claude` 这个原生二进制。三个都列上，不存在的会被过滤掉。
       */
      const dir = path.dirname(shim);
      for (const rel of ['bin/claude.exe', 'bin/claude', 'cli.js']) {
        out.push({
          path: path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', rel),
          source: `PATH 上的 ${path.basename(shim)}（推出真身）`,
        });
      }
      out.push({ path: shim, source: `PATH 上的 ${path.basename(shim)}（班底起不来）` });
    }
    for (const d of npmPrefixes()) {
      for (const rel of ['bin/claude.exe', 'bin/claude', 'cli.js']) {
        out.push({ path: path.join(d, 'node_modules', '@anthropic-ai', 'claude-code', rel), source: 'npm 全局包' });
      }
    }
    return out;
  },
  dsh() {
    const out = [];
    // 桌面包布局排前面：bandi 的 dsh 启动方式就是照着它写的（Electron + app.asar 里的 cli.js）。
    // npm 装的那个 shim 文件虽然在，但 spawn 一个 .cmd 在 Node 22 上直接 EINVAL（实测），
    // 所以它排后面、并且在 detectFamily 里会被标成"起不来"。
    for (const root of appRoots()) {
      out.push({
        path: path.join(root, 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
        source: 'DSH 桌面端自带',
      });
    }
    const shim = findOnPath(['dsh']);
    if (shim) out.push({ path: shim, source: `PATH 上的 ${path.basename(shim)}（npm 装的，班底起不来）` });
    return out;
  },
};

const exists = (p) => {
  try { return fs.existsSync(p); } catch { return false; }
};

/**
 * 每个族"用户给了一个目录时，往里找一层"要试的相对路径。
 *
 * 为什么要这一层：弹窗上写的是"把**安装目录**填进来"，而真正要的是那个可执行文件。
 * 不解析的话，一个目录路径会被原样存下去，然后永远显示「路径已失效」——
 * 用户还不知道自己哪儿给错了（明明填的是正确的安装目录）。
 *
 * ⚠️ 每一族**只列它真能启动的那种文件**，顺序也是"真身优先"：
 *   · codex 是 `node <xxx.js>` 起的 → 只能给 .js。给 PATH 上那个 codex.cmd
 *     会存进去一个永远起不来的实例（spawn .cmd 在 Node 22 上是 EINVAL）
 *   · claude 是直接 spawn 路径 → 只给 .exe（.cmd 同样 EINVAL）
 *   · dsh 要桌面包布局（Electron + app.asar）→ 认 resources 下那个，
 *     npm 装的 dsh.cmd 会用 dsh.isLaunchable() 挡掉
 */
const UNDER_DIR = {
  codex: ['node_modules/@openai/codex/bin/codex.js', 'bin/codex.js', 'codex.js'],
  claude: [
    'node_modules/@anthropic-ai/claude-code/bin/claude.exe',
    'bin/claude.exe',
    'claude.exe',
  ],
  dsh: ['resources/runtime/cli/bin/dsh.cmd', 'bin/dsh.cmd', 'dsh.cmd'],
};

/**
 * 「这个文件班底**真能起得来**吗」—— 探测和路径解析都用它。
 *
 * 为什么每族的标准不一样：各族启动方式不同（见各自 mjs 的 launchCommand）：
 *   · codex ：`node <xxx.js>` —— 只认 .js。PATH 上那个 codex.cmd 喂不进 node
 *   · claude：**直接 spawn 这个路径** —— .cmd / .bat 在 Node 22 上必 EINVAL
 *   · dsh   ：Electron + app.asar 的桌面包布局 —— 用 dsh.isLaunchable 判
 *
 * ⚠️ 不判的后果（2026-10-15 用户实报）：探测把「文件在、班底起不来」的那个
 * 当成 usable 排在**前面**，而 claude 的 npm shim 恰好是 PATH 上第一个 ——
 * 于是自动接进来的就是它，一点「检测」就是 `起不来：EINVAL`，
 * 而真正能跑的 claude.exe 排在后面、没人选。
 */
function launchable(familyId, p) {
  if (!exists(p)) return false;
  const ext = path.extname(p).toLowerCase();
  const isWin = process.platform === 'win32';
  if (familyId === 'claude') {
    /*
     * 直接 spawn 这个路径，所以**脚本在 Windows 上一律不行**：
     * `.cmd/.bat/.ps1` 要 shell 才跑得起来，`.js` 要 node —— Node 22 的 spawn
     * （默认不挂 shell）碰到它们全是 EINVAL/ENOEXEC。
     *
     * ⚠️ 但这条**只对 Windows 成立**（2026-10-16 修）：POSIX 上 `.js` 只要带 shebang
     * 且可执行，内核自己就按 shebang 跑了 —— npm 装的 Claude Code 在 Linux/macOS 上
     * 真身正是可执行的 `cli.js`。原来的判据把 Windows 的规矩套到所有平台，
     * Linux 上那个唯一能跑的路径会被标成"班底起不来"。
     */
    const bad = isWin ? ['.cmd', '.bat', '.ps1', '.js'] : ['.cmd', '.bat', '.ps1'];
    return !bad.includes(ext);
  }
  if (familyId === 'codex') return ext === '.js';
  if (familyId === 'dsh') return dsh.isLaunchable(p);
  return true;
}

/**
 * 把用户填的东西变成**指向可执行文件**的路径：给文件就原样返回，给目录就往里找一层。
 *
 * 往里找时**只认班底起得来的**（见 `launchable`）—— 找一个起不来的回去，
 * 等于存进去一个永远报 EINVAL 的运行时。
 * 找不到就把原路径返回 —— 让 `pathExists` 如实报 false，不自作主张编一个出来。
 */
export function resolveCliPath(familyId, input) {
  const p = path.resolve(String(input ?? '').trim());
  let isDir = false;
  try {
    isDir = fs.statSync(p).isDirectory();
  } catch {
    return p; // 这个路径不存在：原样返回，交给 pathExists 去如实报 false
  }
  if (!isDir) return p;
  for (const rel of UNDER_DIR[familyId] ?? []) {
    const c = path.join(p, ...rel.split('/'));
    if (!launchable(familyId, c)) continue;
    return c;
  }
  return p;
}

/**
 * 探测某个族在这台机器上的可执行文件。**只返回真实存在的**，按找到的顺序排。
 *
 * 为什么把"没找到的那些猜测"也丢掉：这一趟的意义就是回答"这台机器上有没有"，
 * 列一堆 `[无] C:\Program Files\...` 只会让人以为要自己挑一个。
 * 一个都没有就返回空数组，界面说"没探测到" —— 那才是准确的说法。
 *
 * **靠按钮点，不做定时扫描**：它是"我换机器了 / 我刚装了个 CLI"这类时刻才需要的事，
 * 没必要每次打开页面都跑一遍。
 */
export function detectFamily(familyId) {
  const fam = FAMILIES[familyId];
  if (!fam) return null;
  const seen = new Set();
  const out = [];
  const push = (p, source) => {
    const full = path.resolve(String(p));
    if (seen.has(full) || !exists(full)) return;
    seen.add(full);
    // 文件在 ≠ 班底起得来（各族标准不同，见 launchable）
    const usable = launchable(familyId, full);
    out.push({ path: full, source, usable });
  };
  for (const c of DETECT[familyId]?.() ?? []) push(c.path, c.source);
  // 这里**不再补一个"bandi 预设的默认位置"**：那是写死的开发机布局，
  // 列出来只会让人以为"它也算找到了"。
  // 能用的排前面；一个都不能用时，也把"装了但起不来"的留着 —— 界面才能说清为什么
  return out.sort((a, b) => Number(b.usable) - Number(a.usable));
}

/** 三个族一起探（「添加运行时」那一步用） */
export function detectAll() {
  return Object.values(FAMILIES).map((f) => ({
    id: f.id,
    label: f.label,
    note: f.note,
    install: f.install ?? null,
    sandboxes: f.sandboxes,
    blocked: f.blocked,
    candidates: detectFamily(f.id),
  }));
}

/**
 * 直接探一个**还没建**的路径能不能跑（不经过运行时记录）。
 *
 * 用途：添加运行时那一步，探测到候选之后顺带跑一次 `--version`，
 * 把版本号显示出来 —— 跟 magpie 的 Agent 页一个信息量。
 * 每族约 200–250ms（要 spawn 一个进程），所以只在**用户点按钮**时做。
 */
export async function probePath(familyId, cliPath) {
  const fam = FAMILIES[familyId];
  const adapter = fam && ADAPTERS[fam.adapter];
  if (!adapter?.probe) return { ok: false, error: '这个协议族没有实现探测' };
  // 同 probe：起不来的先给一句人话，别让 spawn 抛 EINVAL
  const why = unlaunchableReason(familyId, cliPath);
  if (why) return { ok: false, error: why };
  return adapter.probe(cliPath);
}

/**
 * 「一键安装」这个族要跑什么 —— **命令表在代码里，不是从控制面传过来的**。
 *
 * 这是这件事的**安全边界**：控制面只能发一个**族名**（`codex` / `claude`），
 * 由**节点自己**拿族名来这里查命令。所以"一键安装"永远不会变成
 * "谁拿着令牌谁就能在别人机器上跑任意命令"。
 *
 * 返回 null = 这个族**一键装不了**（比如 dsh 是 Windows 桌面端自带的），
 * 调用方要如实说清，别装作能装。
 *
 * `bin`/`args` 是 shell-free 的形式（直接 spawn，不经过 shell）—— 少一层引号/注入的面。
 */
export function installCommandFor(familyId) {
  const ins = FAMILIES[familyId]?.install;
  if (!ins || ins.kind !== 'npm' || !ins.bin || !Array.isArray(ins.args)) return null;
  return { bin: ins.bin, args: ins.args, cmd: ins.cmd };
}

/** 可添加的协议族（「添加协议族」里那三个选项） */
export function publicFamilies() {
  return Object.values(FAMILIES).map((f) => {
    const found = detectFamily(f.id);
    const usable = found.filter((c) => c.usable);
    return {
      id: f.id,
      label: f.label,
      sandboxes: f.sandboxes,
      note: f.note,
      // 没装时给他一条能直接粘的命令。页面初次加载就要能显示"未安装"那一段，
      // 所以这个字段不能只在 /detect 里给 —— 那是点按钮才有的
      install: f.install ?? null,
      installed: usable.length > 0,
      detectedPath: usable[0]?.path ?? null,
      detectedBy: usable[0]?.source ?? null,
      count: usable.length,
    };
  });
}

export { LOCAL_ID, FAMILIES, SEEDED };
