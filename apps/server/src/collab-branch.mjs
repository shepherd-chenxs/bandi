/* collab-branch.mjs —— 分公司侧（2026-10-31 协作中心 MVP）。
 *
 * 这台机器的身份：**一台完整的班底**，只是额外属于某个协作中心。所以这个模块只做四件事：
 *   ① `collab.json`（中心地址 + 分公司令牌 + 本地协作项目）的读写；
 *   ② 加入 / 退出（探地址 → 换令牌 → 建本地项目 → 起同步循环）；
 *   ③ 5 秒一拍的同步循环（poll → 应用中心的改动 → 把本地改动报回去）；
 *   ④ 状态读数（设置页「协作」分节用它）。
 *
 * **不碰的东西**（任务书 §三）：不改 `config.json`、不动 `netmode`、不重启、不起 `node.mjs`。
 * 加入协作 ≠ 变成算力节点 —— 工作台、通讯录、项目、看板照常。
 *
 * ⚠️ 与 `local-mode.mjs` 的分工：那一个是「加入总机（算力节点）」，两个是**互斥的两种关系**
 *    （接口层双向下拦 E4047）。这里只借用它的 `LocalError`，两边的配置文件也是各写各的。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir } from './config.mjs';
import * as store from './store.mjs';
import * as localMode from './local-mode.mjs';

const COLLAB_FILE = path.join(dataDir, 'collab.json');

/** 探地址 / 换令牌 / 退出通知的超时（毫秒）：本机操作，不该让人盯着转圈 */
const PROBE_TIMEOUT_MS = 4000;
const JOIN_TIMEOUT_MS = 10000;
const POLL_TIMEOUT_MS = 8000;
const LEAVE_TIMEOUT_MS = 2000;

/** 节拍：正常 5 秒一拍，失败退避 15 秒（任务书 §七） */
const TICK_MS = 5000;
const BACKOFF_MS = 15000;

const ONLINE_MS = 15000;

/* ------------------------------------------------------------ collab.json */

/**
 * 读配置（没有 / 坏了 → 空对象，绝不抛给调用方）。
 * 「加入了吗」的判据是 `branchId + token + centerUrl` 三件齐全 —— 只有一个字段的半截文件
 * 等于没加入，让「加入」按钮照常能点（而不是把用户锁在一个坏状态里）。
 */
export function readConfig() {
  try {
    const j = JSON.parse(fs.readFileSync(COLLAB_FILE, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

/**
 * 原子写（临时文件 + rename）+ 0600：令牌在里面。
 * 与 `local-mode.writeClientConfig` 同一套做法，区别只是这里**整份覆盖**
 * （这份文件整个属于协作关系，没有"别的模块的键"要保留）。
 */
function writeConfig(next) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${COLLAB_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, COLLAB_FILE);
  try {
    fs.chmodSync(COLLAB_FILE, 0o600);
  } catch {
    /* Windows 上 chmod 基本是空操作，失败也不该把"加入"卡掉 */
  }
  return next;
}

function patchConfig(patch) {
  return writeConfig({ ...readConfig(), ...(patch ?? {}) });
}

function clearConfig() {
  try {
    fs.rmSync(COLLAB_FILE, { force: true });
  } catch {
    /* 删不掉就留着：下次启动还会按"已加入"跑，状态页上有「退出协作」可以再来一次 */
  }
}

/** 这台机器加入过协作中心吗（与 `local-mode.isJoined()` 同一个判据风格） */
export function isJoined() {
  const c = readConfig();
  return !!(String(c.centerUrl ?? '').trim() && String(c.branchId ?? '').trim() && String(c.token ?? '').trim());
}

export const configFile = () => COLLAB_FILE;

/* -------------------------------------------------------------- 进程内状态 */

const rt = {
  timer: null,
  inFlight: false,
  nextAt: 0,
  lastSyncAt: null,
  lastError: null,
  revoked: false,
  version: null,
};

/** 中心地址归一化：去尾斜杠、补协议（用户可能只填 `192.168.1.9:18787`） */
function normalizeBase(input) {
  const raw = String(input ?? '').trim();
  if (!raw) {
    throw new localMode.LocalError(400, 'E4041', '先填中心的地址，比如 http://192.168.1.9:18787');
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let u;
  try {
    u = new URL(withScheme);
  } catch {
    throw new localMode.LocalError(400, 'E4041', `这个地址看不懂：${raw}。照 http://192.168.1.9:18787 这样填`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new localMode.LocalError(400, 'E4041', '只支持 http:// 或 https://');
  }
  return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`;
}

const pretty = (base) => String(base ?? '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');

/* -------------------------------------------------------------- 本地项目 */

/**
 * 「协作 · <中心名>」这个项目（加入成功时自动建，**幂等**）。
 *
 * 项目被删了怎么办 —— **按 root 重新找/重建**，不要静默丢任务：卡是挂在这个项目上的，
 * 没有项目它们就没有归属（`project_tasks.projectId` 是硬约束）。重建之后下一拍
 * 会把中心的任务按 `collabTaskId` 复用/新建回来（任务书 §十六「本地删项目」那一行）。
 */
function ensureProject(cfg) {
  const root = path.join(dataDir, 'collab', String(cfg.branchId));
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (e) {
    console.warn(`[协作] 本地项目目录建不出来（${root}）：${e?.message ?? e}`);
  }
  let p = cfg.projectId ? store.getProject(cfg.projectId) : null;
  if (!p) p = store.listProjects().find((x) => String(x.root ?? '') === root) ?? null;
  if (!p) {
    p = store.createProject({ name: `协作 · ${cfg.centerLabel || pretty(cfg.centerUrl)}`, root });
    console.log(`[协作] 建了本地项目「${p.name}」（${root}）`);
  }
  if (p.id !== cfg.projectId) patchConfig({ projectId: p.id });
  return p;
}

/* ---------------------------------------------------------------- 加入 */

/**
 * 加入一个协作中心。
 *
 * 失败码按任务书 §6.3 区分（顺序就是语义）：
 *   E4042 已加入 → E4047 已是算力节点 → E4041 连不上/不是班底 → E4043 对面太旧 → E4040 码不对。
 * 成功之后：写配置 → 建/找本地项目 → 起同步循环。**不重启、不动 netmode、不动 config.json。**
 */
export async function join({ url, code } = {}) {
  if (isJoined()) {
    throw new localMode.LocalError(409, 'E4042', '这台机器已经加入了某个协作中心，先退出再换');
  }
  if (localMode.isJoined()) {
    throw new localMode.LocalError(
      409,
      'E4047',
      '这台机器已经加入了总机（算力节点），先退出才能加入协作中心',
    );
  }
  const base = normalizeBase(url);
  const rawCode = String(code ?? '').trim();
  if (!rawCode) {
    throw new localMode.LocalError(400, 'E4040', '接入码不对、已经用过、或者过期了 —— 让中心重新生成一个');
  }

  // ① 探一眼：是班底、版本够（前面那步不通就不用发码了，码也别白烧）
  let hello;
  try {
    const r = await fetch(`${base}/api/hello`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    hello = await r.json().catch(() => null);
    if (r.status !== 200 || hello?.platform !== 'bandi') {
      throw new localMode.LocalError(
        400,
        'E4041',
        `连不上中心。核对地址与端口；如果中心开着，多半是防火墙挡住了这个端口（${pretty(base)} 回的不是班底）`,
      );
    }
  } catch (e) {
    if (e instanceof localMode.LocalError) throw e;
    throw new localMode.LocalError(
      400,
      'E4041',
      `连不上中心（${pretty(base)}）。核对地址与端口；如果中心开着，多半是防火墙挡住了这个端口`,
      e?.message ?? String(e),
    );
  }
  const caps = Array.isArray(hello.caps) ? hello.caps.map(String) : [];
  if (!caps.includes('collab')) {
    throw new localMode.LocalError(409, 'E4043', '那台班底版本太旧（不认识协作中心），先升级它再加入');
  }

  // ② 换令牌
  let body = null;
  let status = 0;
  try {
    const r = await fetch(`${base}/api/collab/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: rawCode, hostname: os.hostname() || null }),
      signal: AbortSignal.timeout(JOIN_TIMEOUT_MS),
    });
    status = r.status;
    body = await r.json().catch(() => null);
  } catch (e) {
    throw new localMode.LocalError(
      400,
      'E4041',
      `连不上中心（${pretty(base)}）。核对地址与端口；如果中心开着，多半是防火墙挡住了这个端口`,
      e?.message ?? String(e),
    );
  }
  if (status === 401) {
    throw new localMode.LocalError(401, 'E4040', '接入码不对、已经用过、或者过期了 —— 让中心重新生成一个');
  }
  if (status === 404 || status === 405) {
    throw new localMode.LocalError(409, 'E4043', '那台班底版本太旧（不认识协作中心），先升级它再加入');
  }
  if (status !== 201 || !body?.token || !body?.branchId) {
    throw new localMode.LocalError(400, 'E4041', `加入没走完（中心回了 ${status}）`, body?.error ?? null);
  }

  // ③ 落盘 → 建项目 → 起循环
  const cfg = writeConfig({
    centerUrl: base,
    branchId: String(body.branchId),
    token: String(body.token),
    centerLabel: body.center?.label ? String(body.center.label) : pretty(base),
    centerHostname: body.center?.hostname ? String(body.center.hostname) : null,
    joinedAt: new Date().toISOString(),
    projectId: null,
  });
  const project = ensureProject(cfg);
  rt.lastSyncAt = null;
  rt.lastError = null;
  rt.revoked = false;
  rt.nextAt = 0;
  startLoop();
  // 立刻拍一次：别让用户等 5 秒才看到第一张卡
  tick();
  console.log(`[协作] 加入了「${cfg.centerLabel}」（${base}）· 本地项目「${project.name}」`);
  return { centerLabel: cfg.centerLabel, branchId: cfg.branchId, projectId: project.id };
}

/**
 * 退出协作中心。
 *
 * 先 best-effort 通知中心（2 秒超时，失败不拦 —— 中心没开也得能退），再删配置、停循环。
 * **本地项目与卡片不删**：那是这台机器的数据；中心那边留 `revokedAt` 当痕。
 */
export async function leave() {
  const cfg = readConfig();
  if (!isJoined()) {
    throw new localMode.LocalError(409, 'E4042', '这台机器还没加入任何协作中心');
  }
  try {
    await fetch(`${cfg.centerUrl}/api/collab/leave`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bandi-Token': cfg.token },
      body: '{}',
      signal: AbortSignal.timeout(LEAVE_TIMEOUT_MS),
    });
  } catch {
    /* 中心没开 / 被拔网线 —— 退出照样要成功，本地的事实不依赖它 */
  }
  clearConfig();
  stopLoop();
  rt.lastSyncAt = null;
  rt.lastError = null;
  rt.revoked = false;
  rt.nextAt = 0;
  console.log('[协作] 已退出协作中心 —— 本地项目与卡片原样保留');
  return { ok: true };
}

/* ---------------------------------------------------------------- 状态读数 */

export function status() {
  const cfg = readConfig();
  if (!cfg.centerUrl || !cfg.branchId) {
    return {
      joined: false,
      centerUrl: null,
      centerLabel: null,
      branchId: null,
      online: false,
      lastSyncAt: null,
      lastError: null,
      revoked: false,
      projectId: null,
      joinedAt: null,
      centerHostname: null,
      centerVersion: rt.version,
    };
  }
  const fresh = !!rt.lastSyncAt && Date.now() - Date.parse(rt.lastSyncAt) < ONLINE_MS;
  return {
    joined: true,
    centerUrl: cfg.centerUrl,
    centerLabel: cfg.centerLabel ?? null,
    branchId: cfg.branchId,
    // 「在线」= 最近一次 poll 成功且不早于 15 秒前；被移除之后一律算离线
    online: !rt.revoked && !rt.lastError && fresh,
    lastSyncAt: rt.lastSyncAt,
    lastError: rt.lastError,
    revoked: rt.revoked,
    projectId: cfg.projectId ?? null,
    joinedAt: cfg.joinedAt ?? null,
    centerHostname: cfg.centerHostname ?? null,
    centerVersion: rt.version,
  };
}

/* ------------------------------------------------------------ 同步循环（核心） */

function stopLoop() {
  if (rt.timer) clearInterval(rt.timer);
  rt.timer = null;
  rt.inFlight = false;
}

function startLoop() {
  if (rt.timer) return;
  // unref：这个定时器不该拖住进程退出（跟别的常驻节拍同一个口径）
  rt.timer = setInterval(tick, TICK_MS);
  rt.timer.unref?.();
}

/** 应用中心下发的任务（**只走 store 层**，见下面那段注释） */
function applyCenterTasks(cfg, tasks) {
  for (const t of tasks) {
    if (!t?.id) continue;
    const local = store.getProjectTaskByCollabTaskId(t.id);
    if (!local) {
      const project = ensureProject(cfg);
      store.createProjectTask({
        projectId: project.id,
        title: String(t.title ?? ''),
        description: String(t.description ?? ''),
        status: String(t.status ?? '待办'),
        source: 'collab',
        collabTaskId: String(t.id),
        collabRev: Number(t.rev ?? 1) || 1,
        collabStatus: String(t.status ?? '待办'),
      });
      continue;
    }
    if ((Number(t.rev) || 0) <= (Number(local.collabRev) || 0)) continue;
    /*
     * **本地有还没报出去的改动时，中心那份"旧值"不许盖回去**（2026-10-31 实现时踩到）：
     * 用户在两次 tick 之间把卡改成「待验收」，而下一拍 poll 拿到的是中心上一版（「进行中」，
     * rev 比本地的 collabRev 大）—— 照字面"rev 变大就应用"，本地那一下改动就被静默抹掉了。
     * 所以：本地有挂单（status ≠ collabStatus）且中心这次不是终态 → **只记 rev，不动状态**，
     * 让下面那步 report 把本地的值报上去（报完中心 rev 再 +1，两边对齐）。
     * 终态例外：中心取消/验收是**不可逆**的，本地必须跟着变。
     */
    const pending = String(local.status ?? '') !== String(local.collabStatus ?? '');
    const terminal = String(t.status) === '已完成' || String(t.status) === '已取消';
    if (pending && !terminal) {
      store.updateProjectTask(local.id, { collabRev: Number(t.rev) || 0 });
      continue;
    }
    /*
     * ⚠️ **只动这三列**，而且走 store 层直接写：
     * 走业务层（`project-tasks.updateProjectTask`）会因为"状态变了 + 有执行人"把活**跑起来** ——
     * 中心的取消/验收不该起一个 agent（任务书 §十五 第 13 条）。
     * 同时把 `collabStatus` 写成同一个值：下一拍就不会把中心刚改的值又报回去（防回环）。
     */
    store.updateProjectTask(local.id, {
      status: String(t.status ?? local.status),
      collabRev: Number(t.rev) || 0,
      collabStatus: String(t.status ?? local.status),
    });
  }
}

/** 把本地改动报回中心（只报状态，不报标题/描述 —— 内容以中心为准） */
async function reportLocalChanges(cfg) {
  for (const card of store.listCollabCardsNeedingReport()) {
    let r;
    try {
      r = await fetch(`${cfg.centerUrl}/api/collab/tasks/${encodeURIComponent(card.collabTaskId)}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Bandi-Token': cfg.token },
        body: JSON.stringify({ status: card.status }),
        signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
      });
    } catch {
      return; // 连不上：留着，下一拍重试
    }
    if (r.ok) {
      store.updateProjectTask(card.id, { collabStatus: card.status });
      continue;
    }
    if (r.status === 404 || r.status === 409) {
      /*
       * 中心已经收了尾（409）或这条任务在中心已经不在了（404，比如中心换了库）。
       * **先把 collabStatus 对齐本地**，免得每一拍都去撞同一个错、把日志刷成一片；
       * 终态的情况下一拍 poll 会把中心的值带回来（`rev` 变大 → applyCenterTasks 应用）。
       */
      store.updateProjectTask(card.id, { collabStatus: card.status });
      continue;
    }
    if (r.status === 401) {
      rt.revoked = true;
      rt.lastError = '已被中心移除';
      stopLoop();
      return;
    }
    return; // 其它失败（5xx 等）：留着下一拍
  }
}

async function tick() {
  // 一个 tick 没跑完，不叠下一个
  if (rt.inFlight) return;
  if (Date.now() < rt.nextAt) return;
  const cfg = readConfig();
  if (!cfg.token || !cfg.centerUrl) return;
  if (rt.revoked) return;
  rt.inFlight = true;
  const before = rt.lastError;
  try {
    const r = await fetch(`${cfg.centerUrl}/api/collab/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bandi-Token': cfg.token },
      body: '{}',
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
    });
    if (r.status === 401) {
      // 中心把这台移除了：停循环，**不清配置**（跟 E4012 同口径：给「退出协作」按钮）
      rt.revoked = true;
      rt.lastError = '已被中心移除';
      stopLoop();
      console.warn('[协作] 中心把这台机器移除了 —— 同步已停，可以在设置里「退出协作」');
      return;
    }
    if (!r.ok) throw new Error(`中心回了 ${r.status}`);
    const body = await r.json().catch(() => null);
    if (!body) throw new Error('中心回的不是 JSON');
    rt.version = body.center?.version ?? null;
    ensureProject(cfg);
    applyCenterTasks(cfg, Array.isArray(body.tasks) ? body.tasks : []);
    await reportLocalChanges(cfg);
    rt.lastSyncAt = new Date().toISOString();
    rt.lastError = null;
    rt.nextAt = 0;
  } catch (e) {
    rt.lastError = String(e?.message ?? e);
    rt.nextAt = Date.now() + BACKOFF_MS; // 失败退避 15 秒
    // 失败只打一行、而且只在原因变了的时候打（否则每 5 秒刷一次屏）
    if (rt.lastError !== before) console.warn(`[协作] 同步失败：${rt.lastError}（15 秒后重试）`);
  } finally {
    rt.inFlight = false;
  }
}

/**
 * 进程起来时调一次：已经加入过就接着同步（中心重启过也不用重新加入 —— 表在库里）。
 *
 * ⚠️ 卡在 `server.listen` **之后**（见 server.mjs）：先能把请求答了，再开始往外打；
 *    顺序反过来，第一次 poll 会跟自己的启动抢数据库。
 */
export function startIfJoined() {
  if (!isJoined()) return false;
  const cfg = readConfig();
  try {
    ensureProject(cfg);
  } catch (e) {
    console.warn(`[协作] 本地项目没准备好：${e?.message ?? e}`);
  }
  startLoop();
  tick();
  return true;
}
