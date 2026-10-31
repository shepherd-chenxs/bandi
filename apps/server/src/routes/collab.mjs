/* routes/collab.mjs —— 协作中心（总公司 / 分公司）的接口（2026-10-31 MVP）。
 *
 * 两条路，两种凭据，别搞混：
 *   · **中心管理接口**（`/api/collab/invites|branches|tasks` 的增删改查）—— PDP：collab:manage（perm ⇒ noPanel）
 *     （operator 或 admin 登录用户），跟别的管理动作一个口径；
 *   · **分公司 ↔ 中心的机器接口**（`join / poll / report / leave`）—— 免操作员令牌，
 *     凭据是接入码（join）或 `bc_` 分公司令牌（其余三条）。**校验在 handler 里**，
 *     因为 `auth.identify()` 不认识 `bc_`（任务书 §十五 第 3 条：别去改它）。
 *
 * ⚠️ 这四条免令牌路径必须在 `auth.guard()` 顶部放行，否则中心一开局域网（鉴权开）
 *    分公司就永远进不来。CSRF 闸照常走 —— 分公司请求不带 Origin，天然放行。
 *
 * ── 错误码（2026-10-31 认领，一码只表达一件事；全仓 E404x 此前未被占用）──────────
 *   E4040  400/401  接入码不对、已经用过、或者过期了 —— 让中心重新生成一个
 *   E4041  400      连不上中心。核对地址与端口；如果中心开着，多半是防火墙挡住了这个端口
 *   E4042  409      这台机器已经加入了某个协作中心，先退出再换
 *   E4043  409      那台班底版本太旧（不认识协作中心），先升级它再加入
 *   E4044  401      分公司的授权已被中心移除，退出协作后重新加入
 *   E4045  404      分公司或任务不存在（可能已被移除）
 *   E4046  400/409  这个动作在协作任务上不允许（标题描述由中心改、取消由中心定、不能删）
 *   E4047  409      这台机器已经加入了总机（算力节点）/ 协作中心，先退出才能加入另一种
 *   E4048  429      试得太频繁，过一分钟再试
 */
import { sendJson, fail, readBody } from '../http.mjs';
import * as store from '../store.mjs';
import * as auth from '../auth.mjs';
import * as localMode from '../local-mode.mjs';

/** 字段上限（任务书 §6.1） */
const LABEL_MAX = 200;
const TITLE_MAX = 200;
const DESC_MAX = 10000;

const ONLINE_MS = 30 * 1000;

/** 接入码的失败文案：三种失败（不对 / 用过 / 过期）对分公司是同一件事，一句话说清 */
const MSG_CODE = '接入码不对、已经用过、或者过期了 —— 让中心重新生成一个';
/** 分公司令牌失效的统一出口（不要回 E4010 —— 那是操作员令牌的文案，分公司看不懂） */
const MSG_TOKEN = '分公司的授权已被中心移除，退出协作后重新加入';

/* --------------------------------------------------------------- 小工具 */

const str = (v, max) => String(v ?? '').trim().slice(0, max);

/** 分公司自报的令牌（`X-Bandi-Token: bc_…`；也认 `?token=`，方便 curl 排查） */
function branchTokenOf(req, url) {
  const h = req.headers['x-bandi-token'];
  if (h) return String(h).trim();
  return String(url.searchParams.get('token') ?? '').trim();
}

/** 认令牌：认不出就回 401 E4044（**不回 E4010**），返回 null 让调用方 return */
function requireBranch(req, res, url) {
  const b = store.branchByToken(branchTokenOf(req, url));
  if (!b) {
    fail(res, 401, 'E4044', MSG_TOKEN);
    return null;
  }
  return b;
}

/**
 * 同一个 IP 每分钟最多 10 次 join（任务书 §6.2）。
 *
 * 进程内计数即可：接入码本身 10 分钟就过期，暴力猜 8 位 base64url 也猜不出来，
 * 这道闸只是别让人把日志刷爆。重启即清零 —— 没必要落库。
 */
const JOIN_HITS = new Map();
const JOIN_WINDOW_MS = 60 * 1000;
const JOIN_MAX = 10;
function joinTooFast(ip) {
  const now = Date.now();
  const list = (JOIN_HITS.get(ip) ?? []).filter((t) => now - t < JOIN_WINDOW_MS);
  list.push(now);
  JOIN_HITS.set(ip, list);
  // 顺手清一清过期的 key，别让这张表随访问过的 IP 无限长
  if (JOIN_HITS.size > 500) {
    for (const [k, v] of JOIN_HITS) if (!v.some((t) => now - t < JOIN_WINDOW_MS)) JOIN_HITS.delete(k);
  }
  return list.length > JOIN_MAX;
}

const centerInfo = () => {
  const me = localMode.nodeIdentity();
  return { label: me.label, hostname: me.hostname, version: localMode.platformVersion() };
};

/** 中心那台机器自己的身份（分公司拿它显示「协作 · <中心名>」） */
export async function handleCollab(req, res, url) {
  if (!url.pathname.startsWith('/api/collab/')) return false;

  const path = url.pathname;
  const branchesOne = /^\/api\/collab\/branches\/([^/]+)\/revoke$/.exec(path);
  const tasksOne = /^\/api\/collab\/tasks\/([^/]+)$/.exec(path);
  const report = /^\/api\/collab\/tasks\/([^/]+)\/report$/.exec(path);

  /* ============================================================ 分公司 → 中心 */

  /**
   * **加入**：一台完整实例凭一次性接入码换回自己的令牌。
   *
   * 免操作员令牌（新机器还没任何凭据），凭据就是接入码本身；**原子消耗**（并发只成一个）。
   * 回给它的只有：branchId、令牌、中心的身份三件套 —— 不给任何其它数据。
   */
  if (req.method === 'POST' && path === '/api/collab/join') {
    const ip = String(req.socket?.remoteAddress ?? '').trim() || 'unknown';
    if (joinTooFast(ip)) return fail(res, 429, 'E4048', '试得太频繁，过一分钟再试'), true;
    const body = await readBody(req);
    const code = str(body?.code, 64);
    if (!code) return fail(res, 401, 'E4040', MSG_CODE), true;
    // 先看码还能不能用 —— 不能的话不值得建分公司（也别白占一个 br_ id）
    const hit = store.getCollabInviteByCode(code);
    if (!hit) return fail(res, 401, 'E4040', MSG_CODE), true;
    if (hit.usedAt || String(hit.expiresAt) <= new Date().toISOString()) {
      return fail(res, 401, 'E4040', MSG_CODE), true;
    }
    /*
     * 建分公司 → 消耗接入码。顺序是「先建行再消耗」：消耗那一步要写 `branchId` 留痕，
     * 而它是不是真的成了由 `changes === 1` 说了算 —— 输了就没人用这张令牌，删掉即可。
     */
    const token = store.newBranchToken();
    const branch = store.createCollabBranch({
      label: hit.label,
      hostname: str(body?.hostname, 200) || null,
      token,
    });
    if (!store.consumeCollabInvite(code, branch.id)) {
      // 并发里另一个请求先用了这个码：把刚建的空分公司删掉？（不删 —— 没有删除接口，删行就是删痕）
      // 这里只回失败：多出来的一行分公司没有令牌能对上，谁也进不来，列表里点「移除」即可。
      return fail(res, 401, 'E4040', MSG_CODE), true;
    }
    console.log(`[协作] 分公司「${branch.label}」加入（${branch.id}，${branch.hostname ?? '未报名'}）`);
    return sendJson(res, 201, { branchId: branch.id, token, center: centerInfo() }), true;
  }

  /**
   * **轮询**：分公司每 5 秒来一次 —— 拿自己那份任务清单，顺带报个到。
   *
   * 只回**这个分支自己的**任务（跨分支看得见别人的活是事故，不是功能）；
   * 同时刷 `lastSeenAt`（列表上的「在线」全靠它）。
   */
  if (req.method === 'POST' && path === '/api/collab/poll') {
    const branch = requireBranch(req, res, url);
    if (!branch) return true;
    store.touchCollabBranch(branch.id);
    const tasks = store.listCollabTasks({ branchId: branch.id, limit: 200 }).map(store.publicCollabTask);
    return sendJson(res, 200, {
      center: centerInfo(),
      now: new Date().toISOString(),
      tasks,
    }), true;
  }

  /**
   * **报状态**：分公司在本地改了卡 → 报给中心。
   *
   * 只许报 6 个状态（「已取消」只能中心写）；中心已是终态 → 409（终态不可逆）。
   * 成功时 `rev += 1` —— 下次 poll 它会看到 rev 变大，把同一个状态"应用"回本地，等于空操作。
   */
  if (req.method === 'POST' && report) {
    const branch = requireBranch(req, res, url);
    if (!branch) return true;
    const task = store.getCollabTask(decodeURIComponent(report[1]));
    if (!task || task.branchId !== branch.id) return fail(res, 404, 'E4045', '分公司或任务不存在（可能已被移除）'), true;
    if (!store.COLLAB_TERMINAL.includes(task.status)) {
      const body = await readBody(req);
      const status = String(body?.status ?? '').trim();
      if (!store.COLLAB_REPORTABLE.includes(status)) {
        return fail(res, 400, 'E4046', '这个动作在协作任务上不允许（取消由中心定）'), true;
      }
      const next = store.reportCollabTaskStatus(task.id, status);
      store.touchCollabBranch(branch.id);
      return sendJson(res, 200, { task: store.publicCollabTask(next) }), true;
    }
    // 终态：允许"报同一个状态"（分公司本地刚应用完中心的终态会顺手报一次，那是空操作）
    const body = await readBody(req);
    const status = String(body?.status ?? '').trim();
    if (status === task.status) return sendJson(res, 200, { task: store.publicCollabTask(task) }), true;
    return fail(res, 409, 'E4046', '这条任务已经收了尾（已完成或已取消），不能再改'), true;
  }

  /** **退出**：分公司主动退出 —— 写 `revokedAt` 留痕；幂等（重复调也回 ok） */
  if (req.method === 'POST' && path === '/api/collab/leave') {
    const branch = requireBranch(req, res, url);
    if (!branch) return true;
    store.revokeCollabBranch(branch.id);
    console.log(`[协作] 分公司「${branch.label}」退出了（${branch.id}）`);
    return sendJson(res, 200, { ok: true }), true;
  }

  /* ================================================================ 中心管理 */

  // 闸已收编 PDP（IAM §8.3/8.4，Phase 3）：collab 的 invites/branches/tasks 全部
  // perm:'collab:manage|read'（**perm ⇒ noPanel**），未授权身份在 guard 层就被判掉。

  /** 发接入码：名字必填（列表上要认出是谁） */
  if (req.method === 'POST' && path === '/api/collab/invites') {
    const body = await readBody(req);
    const label = str(body?.label, LABEL_MAX + 1);
    if (!label) return fail(res, 400, 'E4046', '先给这台分公司起个名字（列表上要认出是谁）'), true;
    if (label.length > LABEL_MAX) return fail(res, 400, 'E4046', `名字太长（最多 ${LABEL_MAX} 字）`), true;
    const inv = store.createCollabInvite({ label });
    return sendJson(res, 201, { code: inv.code, label: inv.label, expiresAt: inv.expiresAt }), true;
  }

  /** 分公司名录（`openTasks` 由服务端数好 —— 别让前端自己遍历） */
  if (req.method === 'GET' && path === '/api/collab/branches') {
    const now = Date.now();
    const branches = store.listCollabBranches().map((b) => ({
      id: b.id,
      label: b.label,
      hostname: b.hostname ?? null,
      joinedAt: b.createdAt,
      lastSeenAt: b.lastSeenAt ?? null,
      online: !!b.lastSeenAt && now - Date.parse(b.lastSeenAt) < ONLINE_MS && !b.revokedAt,
      revokedAt: b.revokedAt ?? null,
      openTasks: Number(b.openTasks ?? 0),
    }));
    return sendJson(res, 200, { branches }), true;
  }

  /** 移除一台分公司：只写 `revokedAt`，**不删行**（留痕） */
  if (req.method === 'POST' && branchesOne) {
    const id = decodeURIComponent(branchesOne[1]);
    const b = store.getCollabBranch(id);
    if (!b) return fail(res, 404, 'E4045', '分公司或任务不存在（可能已被移除）'), true;
    store.revokeCollabBranch(id);
    console.log(`[协作] 中心移除了分公司「${b.label}」（${id}）`);
    return sendJson(res, 200, { ok: true }), true;
  }

  /** 派活：给某台分公司建一条任务（标题必填，描述可空） */
  if (req.method === 'POST' && path === '/api/collab/tasks') {
    const body = await readBody(req);
    const branchId = str(body?.branchId, 64);
    const b = branchId ? store.getCollabBranch(branchId) : null;
    if (!b || b.revokedAt) return fail(res, 404, 'E4045', '分公司或任务不存在（可能已被移除）'), true;
    const title = str(body?.title, TITLE_MAX + 1);
    if (!title) return fail(res, 400, 'E4046', '任务得有标题'), true;
    if (title.length > TITLE_MAX) return fail(res, 400, 'E4046', `标题太长（最多 ${TITLE_MAX} 字）`), true;
    const description = str(body?.description, DESC_MAX + 1);
    if (description.length > DESC_MAX) return fail(res, 400, 'E4046', `描述太长（最多 ${DESC_MAX} 字）`), true;
    const task = store.createCollabTask({
      branchId,
      title,
      description,
      createdByUserId: req.bandiAuth?.kind === 'user' ? req.bandiAuth.userId : null,
    });
    return sendJson(res, 201, { task: store.publicCollabTask(task) }), true;
  }

  /** 任务清单（`?branchId=` 传了就只看那台，不传就是"我派出去的全部"） */
  if (req.method === 'GET' && path === '/api/collab/tasks') {
    const branchId = String(url.searchParams.get('branchId') ?? '').trim();
    const tasks = store.listCollabTasks({ branchId: branchId || null, limit: 200 }).map((t) => {
      const b = store.getCollabBranch(t.branchId);
      return { ...store.publicCollabTask(t), branchLabel: b?.label ?? null };
    });
    return sendJson(res, 200, { tasks }), true;
  }

  /**
   * 中心收尾：只许 `已完成`（验收）/ `已取消`（取消）。
   *
   * 别的状态一律 E4046 —— 状态的**过程**在分公司（它才知道在干、卡住了、还是等人验收），
   * 中心只握两个终态。终态之后不能再改（这条写在这里，也写在 report 那里）。
   */
  if (req.method === 'PATCH' && tasksOne) {
    const id = decodeURIComponent(tasksOne[1]);
    const task = store.getCollabTask(id);
    if (!task) return fail(res, 404, 'E4045', '分公司或任务不存在（可能已被移除）'), true;
    const body = await readBody(req);
    const status = String(body?.status ?? '').trim();
    if (!store.COLLAB_TERMINAL.includes(status)) {
      return fail(res, 400, 'E4046', '中心只能点「验收」（已完成）或「取消」（已取消）—— 过程状态归分公司'), true;
    }
    if (store.COLLAB_TERMINAL.includes(task.status)) {
      return fail(res, 409, 'E4046', '这条任务已经收了尾（已完成或已取消），不能再改'), true;
    }
    const next = store.setCollabTaskStatus(id, status);
    console.log(`[协作] 中心把任务「${task.title}」收成「${status}」（${id}）`);
    return sendJson(res, 200, { task: store.publicCollabTask(next) }), true;
  }

  fail(res, 404, 'E4045', '分公司或任务不存在（可能已被移除）');
  return true;
}
