/**
 * 本机身份与配置（2026-10-20，设计 §3.1 / §4.3 / §4.4 / §5.1-§5.7）。
 *
 * 「这台机器是谁的」全部落在这里：`config.json`（加入的是哪台总机、令牌、scope）、
 * `node.json`（本机 deviceId）、`instance.json`（本机实例 id）。加上探测、加入、退出。
 *
 * ⚠️ **绝对不许 import `store.mjs`**（设计 §3.1 那段长注释）：
 *   `node.mjs` 要 import 本文件（拿 `ensureNodeId`），而 `store.mjs` 一 import 就
 *   `new DatabaseSync(dbPath)` 并跑迁移 —— **节点进程因此会去打开控制面库、写迁移**，
 *   直接违反 PRD §七 第 7 条（节点只碰 `config.json` / `node.json` / `runtimes.json`）。
 *   所以本机库的"大小 / 计数 / 导出"放在 `server.mjs` 的 `handleLocal()` 里做（那里才有 store）。
 *
 * 同理**不 import `runtimes.mjs`**（它 import store）：加入时要报的"这台机器有什么 CLI"，
 * 由 `server.mjs` 侧探好再传进来（见 `join()` 的 `runtimes` 参数）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir, repoRoot } from './config.mjs';

/** 三个文件都在数据目录里（与 `node.mjs` 读的是同一份，字段只增不改） */
const CONFIG_FILE = path.join(dataDir, 'config.json');
const INSTANCE_FILE = path.join(dataDir, 'instance.json');

/**
 * 总机下发的**面板角色**缓存（2026-10-28 第四刀）。写它的是 `node.mjs`（心跳响应里带回来），
 * 读它的是本地面板（`status().panelRole` → `misc.mjs` 的 `renderNodeMode`）。
 *
 * 为什么走文件：本文件**不许 import store**（见文件头那段），而这台机器上根本没有
 * 总机那套角色表 —— 它只能记住"总机说我是哪个角色、能看哪几节"。
 */
const PANEL_FILE = path.join(dataDir, 'node-panel.json');

/**
 * scope 的两个值。
 *
 * 与 `store.mjs` 里那份**各存一份字面量**（值相同）：本文件不许 import store，
 * 而 store 那边也不该为了两个字符串去 import 本文件（那会把 config/node 的初始化顺序绕起来）。
 */
export const SCOPE = Object.freeze({
  COMPUTE: 'compute',
  PANEL: 'panel',
  ALL: Object.freeze(['compute', 'panel']),
});

/** `config.json` 里**属于"加入"这件事**的字段 —— 退出总机时删的正是这一组 */
const CLIENT_KEYS = ['controlPlane', 'token', 'scope', 'joinedAt', 'hostLabel', 'hostHostname', 'hostInstanceId'];

/** 探测一个地址的等待上限：向导里点「下一步」不该让人盯着转圈十几秒 */
const PROBE_TIMEOUT_MS = 3000;
const JOIN_TIMEOUT_MS = 15000;

/**
 * 「探 / 加入 / 退出」这三类失败都**带 HTTP 状态 + 错误码**往上抛（设计 §5.10 那张表）。
 *
 * 为什么做一个类而不是直接 `throw new Error`：`handleLocal()` 要把它原样翻成
 * `fail(res, status, code, 中文)`；用 `message` 里塞 JSON 那种做法，下一个人一定会写歪。
 */
export class LocalError extends Error {
  constructor(status, code, message, detail = null) {
    super(message);
    this.name = 'LocalError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/* ------------------------------------------------------------------ 小工具 */

/** 宽松 scope 解析：只留白名单项、空则回退 `compute`（与 `store.parseScope` 同语义） */
export function parseScope(input) {
  const out = new Set();
  const items = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[\s,]+/) : [];
  for (const raw of items) {
    const s = String(raw ?? '').trim().toLowerCase();
    if (SCOPE.ALL.includes(s)) out.add(s);
  }
  if (!out.size) out.add(SCOPE.COMPUTE);
  return out;
}

/** 规范串：去重 → 字典序 → 空格分隔 */
export function normScope(input) {
  return [...parseScope(input)].sort().join(' ');
}

/** 本机主机名（不给就 `未命名机器`，跟 `node.mjs` 一致） */
function hostLabel() {
  return os.hostname() || '未命名机器';
}

/* ------------------------------------------------------- config.json（本机是谁的节点） */

/** 读 `config.json`（没有 / 坏了 → 空对象，绝不抛给调用方） */
export function readClientConfig() {
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

/**
 * 合并写 `config.json`，权限 0600（令牌在里面）。
 *
 * ⚠️ `writeFileSync` 的 `mode` **只在创建时生效** —— 文件已经存在时它不会把权限改回来。
 * 所以补一次 `chmodSync`：这个文件可能被别的东西（老版本、autostart 脚本）建成 0644。
 */
export function writeClientConfig(patch = {}) {
  const next = { ...readClientConfig(), ...(patch ?? {}) };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch {
    /* Windows 上 chmod 基本是空操作，失败也不该拦住"加入" */
  }
  return next;
}

/**
 * **退出总机**：删掉 `controlPlane / token / scope / joinedAt / hostLabel / hostHostname / hostInstanceId`。
 *
 * 保护规则（2026-10-20 T03 验收补充）：
 *   · 删完之后**剩下的全是我们的键**（即没有剩余）→ 整个文件删掉（零安全痕迹）；
 *   · 出现任何**未知键**（有人手工往里加过字段）→ **保留文件**，写回"去掉七个键之后"
 *     的剩余内容 —— 手工加过东西的人不该被静默清掉。
 *
 * ⚠️ 写回**不能走 `writeClientConfig`**：那一个是"读现有文件再合并"的语义，而现有文件里
 * 还躺着我们那七个键 —— 合并完它们就**原样回来了**，退出等于没退（令牌还在盘上！）。
 * 必须原样写。
 *
 * ⚠️ **`node.json` 的 id 保留**（PRD §五 决策 C）：重新加入**同一台**总机时还是那台设备，
 * 不会在总机设备列表里攒出第二行僵尸。这个函数**不碰** `node.json`，也不碰本机库。
 */
export function clearClientConfig() {
  const cfg = readClientConfig();
  let removed = 0;
  for (const k of CLIENT_KEYS) {
    if (k in cfg) {
      delete cfg[k];
      removed += 1;
    }
  }
  if (!removed) return { removed: 0, file: CONFIG_FILE, deleted: false };
  if (!Object.keys(cfg).length) {
    try {
      fs.rmSync(CONFIG_FILE, { force: true });
    } catch {
      /* 删不掉就留着空对象，语义一样 */
    }
    return { removed, file: CONFIG_FILE, deleted: true };
  }
  // 有未知键：**原样**写回剩余内容（绕开 writeClientConfig 的合并），文件保留
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch {
    /* Windows 上 chmod 基本是空操作 */
  }
  return { removed, file: CONFIG_FILE, deleted: false };
}

/** 这台机器加入过总机吗（判据 `controlPlane` —— 与 `node.mjs` / `config.mjs` 同一口径） */
export function isJoined() {
  const j = readClientConfig();
  return typeof j.controlPlane === 'string' && j.controlPlane.trim() !== '';
}

/* -------------------------------------------------- instance.json（本机实例 id） */

let cachedInstanceId = null;

/**
 * 本机实例 id（`inst-<uuid>`），跨重启稳定 —— UDP 应答的去重键、反代注入给前端的标记。
 *
 * 读不到 / 写不进 → **进程内生成一次**并告警（设计 §4.3 最后一条）：
 * 一个身份文件写不进去，不该让整个服务起不来。
 */
export function instanceId() {
  if (cachedInstanceId) return cachedInstanceId;
  try {
    const j = JSON.parse(fs.readFileSync(INSTANCE_FILE, 'utf8'));
    if (j?.instanceId) {
      cachedInstanceId = String(j.instanceId);
      return cachedInstanceId;
    }
  } catch {
    /* 没有 / 坏了：下面生成一个 */
  }
  const id = `inst-${crypto.randomUUID()}`;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(INSTANCE_FILE, `${JSON.stringify({ instanceId: id, createdAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  } catch (e) {
    console.warn(`[本机] 实例 id 写不进 ${INSTANCE_FILE}：${e?.message ?? e} —— 本次运行临时用一个`);
  }
  cachedInstanceId = id;
  return id;
}

/* ------------------------------------------------------- node.json（本机 deviceId） */

/**
 * `node.json` 在哪儿。
 *
 * ⚠️ **要认 `BANDI_NODE_STATE`**：`node.mjs` 就是用它（用例靠它把身份文件放进临时目录）。
 * 不认的话，`ensureNodeId()` 写 `node.json`、`node.mjs` 读 `BANDI_NODE_STATE` 指的那个 ——
 * 同一台机器会攒出两个 deviceId（总机上冒出第二台设备）。
 */
function nodeStateFile() {
  return process.env.BANDI_NODE_STATE ?? path.join(dataDir, 'node.json');
}

/** 只读本机 deviceId（没有就 null）—— 读数的地方不该顺手写文件 */
export function readNodeId() {
  try {
    const j = JSON.parse(fs.readFileSync(nodeStateFile(), 'utf8'));
    return j?.id ? String(j.id) : null;
  } catch {
    return null;
  }
}

/**
 * 本机 deviceId，**没有就生成并写盘**。
 *
 * ⚠️ **必须与 `node.mjs:91` 的 `ensureId()` 完全同一套算法**（读 `node.json` 的 `id`，
 * 没有就 `'node-' + randomUUID().slice(0,8)` 写盘、带 `createdAt`）—— 否则"加入时生成的 id"
 * 与"节点进程报到时报的 id"是两个，总机上会多出一台永远离线的设备。
 * 这也是 `node.mjs` 换成调本函数而不是自己再写一份的理由。
 */
export function ensureNodeId() {
  const had = readNodeId();
  if (had) return had;
  const id = `node-${crypto.randomUUID().slice(0, 8)}`;
  const file = nodeStateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ id, createdAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  return id;
}

/** 本机身份三件套（UDP 应答、`/api/hello`、加入时的 body 都用它） */
export function nodeIdentity() {
  const label = hostLabel();
  return {
    id: readNodeId(),
    label,
    hostname: label,
    platform: `${os.platform()} ${os.arch()}`,
  };
}

/**
 * 平台版本号（读 `apps/desktop/version.json`；读不到给 null —— 不编）。
 *
 * 两个位置都认（2026-10-22）：源码检出在 `apps/desktop/version.json`，**安装版**则被
 * `bundle.resources` 摊在安装目录根上（`version.json`）—— 只认前一个的话，装出来的
 * 那份 `/api/hello` 和 `bandi status` 会一直显示"版本未知"（静默、只在装完才看出来）。
 */
let cachedVersion;
export function platformVersion() {
  if (cachedVersion !== undefined) return cachedVersion;
  for (const p of [path.join(repoRoot, 'apps', 'desktop', 'version.json'), path.join(repoRoot, 'version.json')]) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j?.version) {
        cachedVersion = String(j.version);
        return cachedVersion;
      }
    } catch { /* 换下一个位置 */ }
  }
  cachedVersion = null;
  return cachedVersion;
}

/* ------------------------------------------------------------------- 探测 / 加入 / 退出 */

/** 把用户填的地址归一化成 `http://host:port`（不带尾斜杠） */
function normalizeBase(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new LocalError(400, 'E1092', '先填一个地址，比如 http://192.168.1.9:8787 或 https://bandi.example.com');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let u;
  try {
    u = new URL(withScheme);
  } catch {
    throw new LocalError(400, 'E1092', `这个地址看不懂：${raw}。照 http://192.168.1.9:8787 或 https://bandi.example.com 这样填`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new LocalError(400, 'E1092', '只支持 http:// 或 https://（云端部署用 https:// 开头的地址）');
  }
  if (!u.hostname) throw new LocalError(400, 'E1092', `这个地址没有主机名：${raw}`);
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  return `${u.protocol}//${u.hostname}:${port}`;
}

/** 给人看的那半句（`http://` 去掉，剩下 `192.168.1.9:8787`） */
function pretty(base) {
  return String(base ?? '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

/**
 * 探一个地址是不是**能加入的班底总机**（设计 §5.3；判定顺序 2026-10-20 增量 1 §1.3）。
 *
 * 三级判定，**顺序就是语义**（"太旧"比"不开放"更基本，先于 E1091）：
 *   ① `E1090` 连上了但不是班底（非 200 / `platform !== 'bandi'`）；
 *   ② `E2050` 是班底但版本太旧 —— hello 里**没有** `joinable` 布尔字段，或 `caps` 没有
 *      `scope`（两个是同一个版本信号，归并到一个出口；**显式抛，不静默降级**）；
 *   ③ `E1091` 是班底但**没对外开放加入**（`joinable:false` —— 总机自己的声明，节点侧
 *      不读也不关心 allowLan 开关，增量 1 P0-A2）。
 * 另有 `E1092` 连不上（fetch 抛错）。
 */
export async function probe(input) {
  const base = normalizeBase(input);
  let r;
  try {
    r = await fetch(`${base}/api/hello`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch (e) {
    throw new LocalError(
      400,
      'E1092',
      `连不上 ${pretty(base)}。核对地址与端口；如果总机开着，多半是防火墙挡住了这个端口`,
      e?.message ?? String(e),
    );
  }
  const body = await r.json().catch(() => null);
  // ① 不是班底
  if (r.status !== 200 || body?.platform !== 'bandi') {
    throw new LocalError(
      400,
      'E1090',
      '这个地址上不是班底（可能是别的程序）。检查端口，或去那台机器上确认班底开着',
      `HTTP ${r.status}`,
    );
  }
  // ② 版本太旧（旧总机连 joinable 字段都没有；caps 检查前移合并到这同一个出口）
  const caps = Array.isArray(body.caps) ? body.caps.map(String) : [];
  if (typeof body.joinable !== 'boolean' || !caps.includes('scope')) {
    // **不静默降级**（P1-1）：旧总机不认识 scope，降级成"能看面板"或"完全不能看"两种都坏
    throw new LocalError(409, 'E2050', '那台班底版本太旧，先升级它再加入', `joinable=${String(body?.joinable)},caps=${caps.join(',')}`);
  }
  // ③ 是班底、版本够，但总机自己声明不开放加入（文案中性化：不提"局域网开关"）
  if (body.joinable !== true) {
    throw new LocalError(
      400,
      'E1091',
      '这台班底没有对外开放加入（它可能只在本机使用）。去那台机器上确认，或问总机的主人',
      `joinable=${String(body.joinable)}`,
    );
  }
  const httpPort = Number(body.httpPort) > 0 ? Number(body.httpPort) : Number(new URL(base).port) || null;
  return {
    url: base,
    label: body.label ? String(body.label) : hostLabel(),
    hostname: body.hostname ? String(body.hostname) : body.label ? String(body.label) : hostLabel(),
    instanceId: body.instanceId ? String(body.instanceId) : null,
    version: body.version ?? null,
    caps,
    httpPort,
    joinable: true,
  };
}

/* ---------------------------------------------------- 主机列表（config.json 的 hosts 键） */

/**
 * 本机记住的「总机通讯录」（2026-10-21 增量：向导从线性流程改成主机列表模型，用户拍板三件事：
 * 记住多台 / 添加=填地址先入列 / 行上的「测试」验连接）。
 *
 * 存 `config.json` 的 `hosts` 键：`[{url,label,hostname,instanceId,addedAt,lastTestedAt,lastJoinedAt}]`。
 *   · 入列只有两条路：向导点「添加」（**填了就入列，不拦探测** —— 2026-10-21 用户定：
 *     "点击添加，打开弹窗，填写之后，完成添加。在记录后面加一个测试按钮"；
 *     label 先用地址占位，「测试」通过后 testHost 把真实身份刷进该行）、
 *     `join()` 成功（自动入列，与七键/lastHost 同一次原子写）；
 *   · **leave() 不清** —— 它不是"加入状态"，是通讯录；退出总机后重连/换总机都靠它；
 *     `clearClientConfig` 不认识这个键 → 走"未知键保留"分支天然存活（与 lastHost 同理）；
 *   · 局域网扫描结果**不**入列（刷新就会重新出现），只有测试到在列的才更新 lastTestedAt。
 */

/** 只读列表（没有 / 坏了 → 空数组，绝不抛给调用方） */
export function readHosts() {
  const j = readClientConfig().hosts;
  return Array.isArray(j)
    ? j.filter((h) => h && typeof h === 'object' && typeof h.url === 'string')
    : [];
}

function writeHostsList(list) {
  writeClientConfig({ hosts: list });
  return list;
}

/** 列表 upsert（只算不写）：去重键 = instanceId（有就用它，总机换端口也认得）否则 url。返回新列表。 */
function upsertInto(list, host, { joinedAt = null } = {}) {
  const now = new Date().toISOString();
  const idx = list.findIndex(
    (h) => (host.instanceId && h.instanceId && h.instanceId === host.instanceId) || h.url === host.url,
  );
  const entry = {
    url: host.url,
    label: host.label ?? host.hostname ?? '总机',
    hostname: host.hostname ?? host.label ?? null,
    instanceId: host.instanceId ?? null,
    addedAt: idx >= 0 ? list[idx].addedAt ?? now : now,
    lastTestedAt: now,
    lastJoinedAt: joinedAt ?? (idx >= 0 ? list[idx].lastJoinedAt ?? null : null),
  };
  if (idx >= 0) list[idx] = entry;
  else list.unshift(entry); // 新认识的排前面 —— 最近操作的那台最可能被再用
  return list;
}

/**
 * 「测试」一台主机（向导列表行的「测试 / 重试」按钮）。
 *
 * probe 通过：在列的 → 更新该行（label/hostname/instanceId/lastTestedAt 跟着刷新）；
 * 不在列的（扫描来的临时行）→ 只回结果**不落盘** —— 扫描结果每次刷新都会重新出现，
 * 用户没明确「添加」就不该替他记住。失败 E1090/E1091/E1092/E2050 原样抛，列表一个字节不动。
 */
export async function testHost(input) {
  const host = await probe(input);
  const list = readHosts();
  const inList = list.some(
    (h) => (host.instanceId && h.instanceId === host.instanceId) || h.url === host.url,
  );
  const hosts = inList ? upsertInto(list, host) : list;
  return { ok: true, host, hosts };
}

/**
 * 「添加」一台主机：**填了就入列，不拦探测**（2026-10-21 用户定的流程：
 * "点击添加，打开弹窗，填写之后，完成添加。在记录后面加一个测试按钮，测试连接"）。
 *
 * label 先拿地址里的 host:port 占位；「测试」通过后 testHost 会把探测到的
 * 真实 label/hostname/instanceId 刷进这一行。重复添加同一地址 = 幂等返回已有行
 * （加两次应该等于加一次，不报错）。新行 lastTestedAt 置空 —— 还没测过，别撒谎。
 */
export function addHost(input) {
  const base = normalizeBase(input);
  const list = readHosts();
  const exist = list.find((h) => h.url === base);
  if (exist) return { ok: true, host: exist, hosts: list };
  let label = base;
  try {
    label = new URL(base).host || base;
  } catch { /* normalizeBase 保证能解析，这里只是兜底 */ }
  const next = upsertInto(list, { url: base, label });
  for (const h of next) {
    if (h.url === base && !h.instanceId) h.lastTestedAt = null;
  }
  const hosts = writeHostsList(next);
  return { ok: true, host: hosts.find((h) => h.url === base), hosts };
}

/** 从通讯录移除一台（按归一化后的 url 匹配；不在列 → 404 E1099）。 */
export function removeHost(input) {
  const base = normalizeBase(input);
  const before = readHosts();
  const hosts = before.filter((h) => h.url !== base);
  if (hosts.length === before.length) {
    throw new LocalError(404, 'E1099', '列表里没有这台主机（可能已经被移除）', base);
  }
  writeHostsList(hosts);
  return { ok: true, hosts };
}

/**
 * **加入一台总机**（设计 §5.5 的服务端动作序列，顺序即实现顺序）。
 *
 *   1. 已加入 → `409 E1093`（文案带总机名与地址；只给「退出总机」这条路 —— 决策 C）；
 *   2. `probe()` → 复用它那四个失败码（+ `E2050`）；
 *   3. 用邀请码换**属于这台机器自己**的令牌 → 401 透传 `E4011`、其余非 201 → `400 E1097`；
 *   4. 写 `config.json`（0600）→ 写不进去 `500 E1097`（**此时还没动任何既有状态**，可重试）。
 *
 * ⚠️ **起节点进程不在这里**（设计 §5.5 第 6 步）：那要 `node-supervisor`（另一个模块），
 * 而本文件不许带进 SQLite —— 起停由 `server.mjs` 侧调 supervisor，本函数只负责"换令牌 + 写配置"。
 *
 * @param {object} opts
 * @param {string} opts.url     总机地址（`http://192.168.1.9:8787`）
 * @param {string} opts.code    一次性邀请码
 * @param {string|string[]} opts.scopes `['compute','panel']` 或 `'compute panel'`
 * @param {object[]} [opts.runtimes] 这台机器上探到的 CLI（由 server 侧探好传进来，见文件头）
 * @param {object[]} [opts.externals] 外部件现状（同上）
 */
export async function join({ url, code, scopes, runtimes = [], externals = null } = {}) {
  const cfg = readClientConfig();
  if (typeof cfg.controlPlane === 'string' && cfg.controlPlane.trim()) {
    const who = cfg.hostLabel || cfg.hostHostname || pretty(cfg.controlPlane);
    throw new LocalError(409, 'E1093', `这台机器已经加入了「${who}」（${pretty(cfg.controlPlane)}），先退出才能加入别的`);
  }

  const host = await probe(url); // 2（E1090 / E1091 / E1092 / E2050 都是它抛的）
  const scope = normScope(scopes);
  const id = ensureNodeId();
  const label = hostLabel();

  let r;
  try {
    r = await fetch(`${host.url}/api/nodes/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: String(code ?? '').trim(),
        id,
        label,
        hostname: label,
        platform: `${os.platform()} ${os.arch()}`,
        runtimes: Array.isArray(runtimes) ? runtimes : [],
        externals: Array.isArray(externals) ? externals : null,
        scope,
      }),
      signal: AbortSignal.timeout(JOIN_TIMEOUT_MS),
    });
  } catch (e) {
    throw new LocalError(400, 'E1092', `连不上 ${pretty(host.url)}。核对地址与端口；如果总机开着，多半是防火墙挡住了这个端口`, e?.message ?? String(e));
  }

  const body = await r.json().catch(() => null);
  if (r.status === 401) {
    // 透传（输入框要保留现场，让人改码重试）
    throw new LocalError(401, 'E4011', '邀请码不对、已经用过、或者过期了 —— 让总机上重新生成一个');
  }
  if (r.status !== 201 || !body?.token) {
    throw new LocalError(400, 'E1097', `加入没走完（总机回了 ${r.status}）`, body?.error ?? null);
  }

  // 「记住上次总机」（增量 1 P0-C，设计 §2）：**只在 join 成功这一笔写**（覆盖写语义，
  // "最后一次成功加入的那台"；手动探测成功**不**预写 —— probe ≠ join，试探几个地址
  // 不该污染记录）。与 `joinedAt` 同一时刻戳、同一次原子写。
  const joinedAt = new Date().toISOString();
  // 主机列表（2026-10-21 增量）：join 成功 = 该总机自动入列。与七键 / lastHost **同一次原子写**
  // —— 不存在"加入成功但通讯录没记上"的中间态。
  const hosts = upsertInto(readHosts(), host, { joinedAt });
  const next = writeClientConfig({
    controlPlane: host.url,
    token: String(body.token),
    scope: normScope(body.scope ?? scope), // 以**总机回的**为准（便于节点自检）
    joinedAt,
    hostLabel: host.label,
    hostHostname: host.hostname,
    hostInstanceId: host.instanceId,
    lastHost: {
      instanceId: host.instanceId,
      label: host.label,
      url: host.url,
      joinedAt,
    },
    hosts,
  });
  const scopeOut = [...parseScope(next.scope)].sort();
  return {
    ok: true,
    nodeId: id,
    controlPlane: host.url,
    hostLabel: host.label,
    hostHostname: host.hostname,
    hostInstanceId: host.instanceId,
    version: host.version,
    scope: scopeOut,
  };
}

/**
 * **退出总机**（设计 §5.6）。
 *
 * 只清配置：**不通知总机**（那样会在它那边留一行永远离线的设备 —— PRD 已经写明建议先在总机
 * 「忘掉」），也**不删 `node.json`**（重新加入同一台总机不攒第二台设备）。
 * 停节点进程由 `server.mjs` 侧在调本函数**之前**做（先停，免得它把刚清掉的令牌又用一次）。
 *
 * ⚠️ **`lastHost` 不清**（2026-10-20 增量 1 已裁决，设计 §2）：它不在 `CLIENT_KEYS` 七键里，
 * 走 `clearClientConfig` 的"未知键保留"分支天然存活。这条记录的全部价值就在
 * "退出 / 断线之后重连"（云端没有发现，重连全靠它），退出即清 = 功能自废；
 * 单条覆盖写：下次成功加入别的总机自然覆盖。
 */
export function leave() {
  if (!isJoined()) throw new LocalError(400, 'E1098', '这台机器还没加入任何总机');
  const r = clearClientConfig();
  return { ok: true, removed: r.removed, deleted: !!r.deleted, file: r.file, nodeId: readNodeId() };
}

/**
 * 总机下发的面板角色（`{ id, name, menuKeys }`）；没有 / 坏了 / 老总机没下发过 → `null`。
 *
 * `null` 的语义是**不限制**（本地面板六个分节全显示）—— 这是安全的方向：
 * 一个读不出来的文件不该把管理员关在那台机器外面。
 * 只读不写：唯一写点是 `node.mjs` 的心跳处理（临时文件 + rename 原子替换）。
 */
export function readPanelRole() {
  try {
    const j = JSON.parse(fs.readFileSync(PANEL_FILE, 'utf8'));
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
    const menuKeys = Array.isArray(j.menuKeys) ? j.menuKeys.map(String) : null;
    if (!menuKeys) return null; // 没有菜单清单 = 等于没下发（别拿一个空对象去限制菜单）
    return { id: j.roleId ?? null, name: j.name ?? null, menuKeys };
  } catch {
    return null;
  }
}

/**
 * 本机身份的**唯一读数**（设计 §5.1 的 `client` + `instanceId` + `nodeId` 三块）。
 *
 * 本机库那部分（大小 / mtime / 计数）**不在这里** —— 那需要 `store`，由 `server.mjs`
 * 的 `handleLocal()` 拼上去；`client.node`（节点进程在不在跑）同理，由它用 supervisor 覆盖。
 */
export function status() {
  const cfg = readClientConfig();
  const joined = typeof cfg.controlPlane === 'string' && cfg.controlPlane.trim() !== '';
  return {
    client: {
      joined,
      controlPlane: joined ? String(cfg.controlPlane) : null,
      hostLabel: cfg.hostLabel ?? null,
      hostHostname: cfg.hostHostname ?? null,
      hostInstanceId: cfg.hostInstanceId ?? null,
      scope: joined ? [...parseScope(cfg.scope)].sort() : [],
      since: cfg.joinedAt ?? null,
      // 由 handleLocal 用 node-supervisor 覆盖成真实状态；未加入时永远是"没在跑"
      node: { running: false, pid: null, external: false },
    },
    instanceId: instanceId(),
    nodeId: readNodeId(),
    // 「上次加入过的总机」（增量 1 P0-C，设计 §2）：只读 —— 唯一写点是 join() 成功那一笔；
    // leave() 不清它（覆盖写语义），探测失败也不清（E1092 正常报错，不静默抹记录）
    lastHost:
      cfg.lastHost && typeof cfg.lastHost === 'object' && !Array.isArray(cfg.lastHost)
        ? cfg.lastHost
        : null,
    // 「总机通讯录」（2026-10-21 增量）：向导列表页的数据源，与加入状态无关（未加入也有）
    hosts: readHosts(),
    /*
     * 总机给这台机器指定的**面板角色**（2026-10-28 第四刀）：
     * `{ id, name, menuKeys }` 或 `null`（没下发 / 读不到 = 不限制，六节全显示）。
     * 由 `node.mjs` 的心跳写进 `node-panel.json`，这里只读。
     */
    panelRole: readPanelRole(),
  };
}
