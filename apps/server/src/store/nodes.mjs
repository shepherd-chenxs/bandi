/* store/nodes.mjs —— 2026-10-22 由 store.mjs 按域拆出。SQL 只在 store/ 目录内。 */

import path from 'node:path';
import crypto from 'node:crypto';
import { db, ensureColumn, newId, nowIso } from './db.mjs';

export function upsertNode({ id, label, platform = null, runtimes = [], externals = null, hostname = null }) {
  const ts = nowIso();
  const host = String(hostname ?? label ?? id).trim() || id;
  db.prepare(
    `INSERT INTO nodes (id, label, hostname, platform, runtimes, externals, registeredAt, lastSeenAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       -- 主机名是那台机器的事实，每次都跟着更新
       hostname   = excluded.hostname,
       -- 名字只认"人起过的"：起过就不许它自己的主机名顶掉
       label      = CASE WHEN nodes.renamed = 1 THEN nodes.label ELSE excluded.label END,
       platform   = excluded.platform,
       runtimes   = excluded.runtimes,
       -- 外部件清单：报到时给就更新，不给就留着（旧节点不认识这个字段，别把已有的抹掉）
       externals  = COALESCE(excluded.externals, nodes.externals),
       lastSeenAt = excluded.lastSeenAt`,
  ).run(id, label || host, host, platform, JSON.stringify(runtimes ?? []), externals ? JSON.stringify(externals) : null, ts, ts);
  return getNode(id);
}

/**
 * 给一台节点起名。**传空字符串 = 恢复默认**（回到它自报的主机名）。
 * 名字记在控制面这边 —— 那台机器下次报到时 `upsertNode` 不会顶掉它（见上面那条 CASE）。
 */

export function renameNode(id, label) {
  const n = getNode(id);
  if (!n) return null;
  const name = String(label ?? '').trim();
  if (name) db.prepare('UPDATE nodes SET label = ?, renamed = 1 WHERE id = ?').run(name, id);
  else db.prepare('UPDATE nodes SET label = ?, renamed = 0 WHERE id = ?').run(n.hostname || n.label, id);
  return getNode(id);
}


export function getNode(id) {
  return db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) ?? null;
}


export function listNodes() {
  return db.prepare('SELECT * FROM nodes ORDER BY registeredAt').all();
}

/**
 * 心跳。**节点没登记过就返回 null** —— 让上层回 404，别悄悄造一台出来。
 *
 * `patch.runtimes` 给了就连运行时清单一起更新。为什么心跳要捎带这份（2026-10-16）：
 * 原来清单**只在报到时**上报，于是在那台机器上装完 CLI，控制面这边一直显示"一个都没探到"，
 * 非要重启节点才更新 —— 用户看到的就是"我明明装了"。纯 stat，几毫秒的事。
 */

export function touchNode(id, patch = {}) {
  if (Array.isArray(patch.runtimes) || Array.isArray(patch.externals)) {
    const sets = ['lastSeenAt = ?'];
    const args = [nowIso()];
    if (Array.isArray(patch.runtimes)) {
      sets.push('runtimes = ?');
      args.push(JSON.stringify(patch.runtimes));
    }
    if (Array.isArray(patch.externals)) {
      sets.push('externals = ?');
      args.push(JSON.stringify(patch.externals));
    }
    args.push(id);
    const r = db.prepare(`UPDATE nodes SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    return r.changes ? getNode(id) : null;
  }
  const r = db.prepare('UPDATE nodes SET lastSeenAt = ? WHERE id = ?').run(nowIso(), id);
  return r.changes ? getNode(id) : null;
}

/* ------------------------------------------------------ 派给节点的活（队列） */

/*
 * 一次"该在某台机器上跑"的执行 = 一行。控制面**不 spawn 远端的东西** ——
 * 它只把该干什么放在这儿，等那台机器的节点**长轮询**来领（见 nodes 的注释：
 * 出站连接是多机方案里唯一不用开端口、不用打洞的形态）。
 *
 * 为什么这也就是"离线排队"：节点不在线时，行就一直躺在"待领"里 ——
 * 不需要另写一套"排队"逻辑，**排队就是这个队列的默认状态**。
 *
 * task 存的是**整段**要交给 CLI 的话（职责、技能、上下文都已经拼好了）；
 * sessionId 是续接用的（同一台机器上的同一个 CLI 会话）。
 */

export function listNodePaths(nodeId) {
  return db.prepare('SELECT * FROM node_paths WHERE nodeId = ? ORDER BY remotePath').all(nodeId);
}


export function setNodePath(nodeId, remotePath, localPath) {
  db.prepare(
    `INSERT INTO node_paths (nodeId, remotePath, localPath, createdAt) VALUES (?, ?, ?, ?)
     ON CONFLICT (nodeId, remotePath) DO UPDATE SET localPath = excluded.localPath`,
  ).run(nodeId, remotePath, localPath, nowIso());
}


export function deleteNodePath(nodeId, remotePath) {
  return db.prepare('DELETE FROM node_paths WHERE nodeId = ? AND remotePath = ?').run(nodeId, remotePath).changes;
}

/**
 * 查映射：cwd 等于某条 remotePath 或在其下面 → 返回换算后的本机路径。
 * 命中**最深**的一条（映射可以嵌套：整盘映射一层、单个项目再映射一层）。
 *
 * 比较前先**规范化**：`\` 与 `/` 一律折成 `/`（UNC 的开头两个也是，两边同样折，
 * 不影响相等性），Windows 上再忽略大小写 —— `E:\proj`、`E:/proj`、`e:\proj` 是同一个地方。
 * 这不是洁癖：真实库里就见过混着存的（工具各写各的）。
 */

export function lookupNodePath(nodeId, cwd) {
  if (!cwd) return null;
  const canon = (p) => String(p ?? '').trim().replace(/[\\/]+/g, '/');
  if (!canon(cwd)) return null;
  const win = process.platform === 'win32';
  const same = (a, b) => (win ? a.toLowerCase() === b.toLowerCase() : a === b);
  const under = (a, b) => (win ? a.toLowerCase().startsWith(b.toLowerCase() + '/') : a.startsWith(b + '/'));
  let best = null;
  for (const r of listNodePaths(nodeId)) {
    const rp = canon(r.remotePath);
    if (!rp) continue;
    if ((same(canon(cwd), rp) || under(canon(cwd), rp)) && (!best || rp.length > best.len)) {
      best = { ...r, len: rp.length };
    }
  }
  if (!best) return null;
  const rest = canon(cwd).slice(best.len).replace(/^\//, '');
  return { remotePath: best.remotePath, localPath: rest ? path.join(best.localPath, rest) : best.localPath };
}

/*
 * 「让那台机器做一件小事」——目前只有一种：一键安装运行时（2026-10-16）。
 *
 * 为什么不复用 node_jobs：那张表的 `runId` 是**必填**的，它服务的是"一次对话运行"（有会话、
 * 有事件流、有产物）。安装没有 run，硬塞进去会让"什么算一次运行"这件事变得含糊。
 *
 * ⚠️ 表里只存**族名**，不存命令 —— 命令由节点自己查（见 runtimes.installCommandFor）。
 * 这条是安全边界：控制面永远发不出命令，只能发"装这三个里的哪一个"。
 */

export function enqueueNodeTask({ nodeId, kind, family, arg = null }) {
  const id = newId('nt');
  db.prepare(
    `INSERT INTO node_tasks (id, nodeId, kind, family, status, output, arg, createdAt)
     VALUES (?, ?, ?, ?, '待领', '', ?, ?)`,
  ).run(id, nodeId, kind, family, arg ? String(arg) : null, nowIso());
  return getNodeTask(id);
}


export function getNodeTask(id) {
  return db.prepare('SELECT * FROM node_tasks WHERE id = ?').get(id) ?? null;
}

/** 取最老的"待领"并原子地标成"执行中"（同 claimNodeJob 的写法） */

export function claimNodeTask(nodeId) {
  const row = db
    .prepare("SELECT id FROM node_tasks WHERE nodeId = ? AND status = '待领' ORDER BY createdAt LIMIT 1")
    .get(nodeId);
  if (!row) return null;
  const up = db
    .prepare("UPDATE node_tasks SET status = '执行中', claimedAt = ? WHERE id = ? AND status = '待领'")
    .run(nowIso(), row.id);
  if (!up.changes) return null;
  return getNodeTask(row.id);
}

/**
 * **按 id** 原子领一件"待领"（本机安装用：排完就地执行，不走"谁先来领"的队列序）。
 * 已经开跑 / 已结束的返回 null —— 调用方据此不重复执行。
 */

export function claimNodeTaskById(id) {
  const up = db
    .prepare("UPDATE node_tasks SET status = '执行中', claimedAt = ? WHERE id = ? AND status = '待领'")
    .run(nowIso(), id);
  if (!up.changes) return null;
  return getNodeTask(id);
}

/**
 * 追加输出。**留最后 8000 字**：npm 装一次能刷几百行，全留着没意义，
 * 而人真正要看的是**末尾**（错在哪、装完没有）。
 */

export function appendNodeTaskOutput(id, chunk) {
  const t = getNodeTask(id);
  if (!t) return null;
  const next = (t.output + String(chunk ?? '')).slice(-8000);
  db.prepare('UPDATE node_tasks SET output = ? WHERE id = ?').run(next, id);
  return getNodeTask(id);
}


export function finishNodeTask(id, status = '完成') {
  db.prepare('UPDATE node_tasks SET status = ?, endedAt = ? WHERE id = ?').run(status, nowIso(), id);
  return getNodeTask(id);
}

/** 这台机器最近的任务（新的在前）—— 界面拿它显示"装到哪一步了" */

export function listNodeTasks(nodeId, limit = 5) {
  return db.prepare('SELECT * FROM node_tasks WHERE nodeId = ? ORDER BY createdAt DESC LIMIT ?').all(nodeId, limit);
}

/** 界面上要的公开形状：状态就是一句人话，不用前端再翻译一遍 */

export function publicNodeTask(t) {
  if (!t) return null;
  return {
    id: t.id,
    nodeId: t.nodeId,
    kind: t.kind,
    family: t.family,
    // 参数（走镜像装的那个前缀）—— 界面要显示"这次是走镜像装的"
    arg: t.arg ?? null,
    status: t.status,
    output: t.output,
    createdAt: t.createdAt,
    endedAt: t.endedAt,
    running: t.status === '执行中',
    done: t.status === '完成' || t.status === '失败',
  };
}


export function enqueueNodeJob({ runId, nodeId, family, model = null, sandbox = null, cwd = null, repo = null, task, sessionId = null }) {
  const id = newId('nj');
  db.prepare(
    `INSERT INTO node_jobs (id, runId, nodeId, family, model, sandbox, cwd, repo, task, sessionId, status, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '待领', ?)`,
  ).run(id, runId, nodeId, family, model, sandbox, cwd, repo ? JSON.stringify(repo) : null, task, sessionId, nowIso());
  return getNodeJob(id);
}


export function getNodeJob(id) {
  return db.prepare('SELECT * FROM node_jobs WHERE id = ?').get(id) ?? null;
}


export function getNodeJobByRun(runId) {
  return db.prepare('SELECT * FROM node_jobs WHERE runId = ? ORDER BY createdAt DESC LIMIT 1').get(runId) ?? null;
}

/**
 * 领一个活：**取最老的那个"待领"，并原子地标成"执行中"**。
 *
 * 原子性靠 `UPDATE ... WHERE id = ? AND status = '待领'` 的 changes ——
 * 同一个节点不会有两条并发领取（节点是单线程的），但把这条写死，
 * 以后真出并发时不会悄悄发出两份活。
 */

export function claimNodeJob(nodeId) {
  const row = db
    .prepare("SELECT id FROM node_jobs WHERE nodeId = ? AND status = '待领' ORDER BY createdAt LIMIT 1")
    .get(nodeId);
  if (!row) return null;
  const up = db
    .prepare("UPDATE node_jobs SET status = '执行中', claimedAt = ? WHERE id = ? AND status = '待领'")
    .run(nowIso(), row.id);
  if (!up.changes) return null; // 别人抢走了（理论上不会）
  return getNodeJob(row.id);
}


export function finishNodeJob(id, status = '已回执') {
  db.prepare('UPDATE node_jobs SET status = ?, endedAt = ? WHERE id = ?').run(status, nowIso(), id);
  return getNodeJob(id);
}

/**
 * 把领走的活**放回队列**。
 *
 * 什么时候用：领活是**长轮询**，而请求可能在等待期间就断了（节点被杀、网线拔了、
 * 壳崩了）。那时如果把活算成"已领走"，它就落在空气里 —— 节点那边没人跑，
 * 队列里也看不见，界面上永远"跑中"（2026-10-15 实测踩到）。
 * 所以：**发现请求方没了就把活放回去**，等下一个节点来领。
 */

export function releaseNodeJob(id) {
  db.prepare("UPDATE node_jobs SET status = '待领', claimedAt = NULL WHERE id = ?").run(id);
  return getNodeJob(id);
}

/** 记一次"这个活还有动静"（回传了事件、或者只是空批次心跳） */

export function touchNodeJob(id) {
  db.prepare('UPDATE node_jobs SET progressAt = ? WHERE id = ?').run(nowIso(), id);
}

/** 所有"已领走、正在跑"的活 —— 掉线清扫用 */

export function listRunningNodeJobs() {
  return db.prepare("SELECT * FROM node_jobs WHERE status = '执行中'").all();
}

/**
 * 把一台节点从控制面上**忘掉**。
 *
 * 为什么需要：节点身份认的是**它自己那个状态文件**。那台机器换了数据目录、
 * 或者状态文件丢了，就会用新身份重新报到 —— 老的这一行从此永远"离线"躺着，
 * 而它的运行时还挂在员工的下拉里（**一台永远不会回来的机器**）。
 * 2026-10-15 实测就是这么攒出两行的，所以得有个地方删。
 */

export function deleteNode(id) {
  const r = db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
  return r.changes > 0;
}

/**
 * **每节点一枚自己的令牌** ＋ **一次性邀请码**（2026-10-16）。
 *
 * 为什么要动这个：原来节点拿的是**总机那枚 master 令牌** —— 跟浏览器登录、跟所有节点共用同一枚 ✗。
 * 后果两条，都很难受：
 *   · 任何一台节点被翻，等于**整套被翻**（能读所有对话、改员工、删别的机器）；
 *   · 「忘掉」**踢不掉它** —— 删了记录它下次心跳就回来（令牌仍然有效）。
 *
 * 现在：一次性邀请码 → 换回**这枚只属于它的**令牌 → 权限只到"它自己那台的节点接口"（见 auth.mjs）；
 * 「忘掉」= 连它的令牌一起吊销 → 真的踢出去。
 *
 * ⚠️ **表里只存哈希，不存明文**：库文件被拿走（备份、同步、误传）也拿不到能用的凭据。
 * 明文只在颁发那一刻回给那台机器一次，之后谁也看不见（跟密码一样）。
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS node_tokens (
    tokenHash TEXT PRIMARY KEY,
    nodeId    TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_node_tokens_node ON node_tokens (nodeId);
  CREATE TABLE IF NOT EXISTS node_invites (
    codeHash  TEXT PRIMARY KEY,
    createdAt TEXT NOT NULL,
    expiresAt TEXT NOT NULL,
    usedAt    TEXT,
    usedBy    TEXT
  );
`);

/*
 * 令牌 scope（2026-10-20，设计 §4.1）。
 *
 *   · 存在**令牌**上、不存在 `nodes` 上 —— 令牌才是身份载体，吊销/重发都是令牌级操作；
 *     放 nodes 会出现"新令牌继承旧令牌的权限"（旧令牌本该是只能干活的 compute）。
 *   · 老令牌一律 `compute`：老节点只干"报到/心跳/领活/回传/回执"那五条活，
 *     行为与改前**完全一致**（这是 T01 的验收项）。
 *   · 存成"排序后空格分隔"的规范串（`compute` / `panel` / `compute panel`），不用 JSON：
 *     SQL 里能直接 LIKE，人翻库也能一眼读懂。
 *
 * ⚠️ 复用上面那个 `ensureColumn`（`PRAGMA table_info` + `ALTER`）—— SQLite **不支持**
 * `ADD COLUMN IF NOT EXISTS`，别自己写一套。
 */
ensureColumn('node_tokens', 'scope', "scope TEXT NOT NULL DEFAULT 'compute'");

const hashOf = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/*
 * scope 的两个值（设计 §13.1）：
 *   compute —— 接活/心跳/回传自己那次运行；
 *   panel   —— 看面板 + 用（员工/会话/任务/工作流/定时），减五类管理动作（见 auth.mjs 那张表）。
 *
 * ⚠️ 这里与 `local-mode.mjs` **各存一份字面量**，值相同 —— 因为本文件一 import 就开
 * SQLite 跑迁移，节点进程绝不能把它带进来（见设计 §3.1）。
 */

export const SCOPE_COMPUTE = 'compute';

export const SCOPE_PANEL = 'panel';


const SCOPE_KNOWN = [SCOPE_COMPUTE, SCOPE_PANEL];

/**
 * 把"库里那串 / 请求体里那个"拆成 Set。
 *
 * 宽松解析：字符串按空白（和逗号）拆、数组逐项、其余当空。
 * **空结果回退 `compute`** —— 老令牌、缺字段、写了不认识的值，语义都是"只能干活"，
 * 这样老节点一个字节不改也不会被挡在门外。
 */

export function parseScope(input) {
  const out = new Set();
  const items = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(/[\s,]+/)
      : [];
  for (const raw of items) {
    const s = String(raw ?? '').trim().toLowerCase();
    if (SCOPE_KNOWN.includes(s)) out.add(s);
  }
  if (!out.size) out.add(SCOPE_COMPUTE);
  return out;
}

/** 规范串：去重 → 字典序 → 空格分隔（`'compute panel'`） */

export function normScope(input) {
  return [...parseScope(input)].sort().join(' ');
}

/**
 * 请求体里那个 scope **合不合法**（只认 `compute` / `panel` 的组合）。
 *
 * 与 `normScope` 的分工：`normScope` 是**宽松**的（不认识的值丢掉、空则回退 compute），
 * 用在"库里的值 / 已经过审的入参"；这个是**严格**的，用在接口入口 ——
 * 出现别的值就 400 `E1047`（设计 §5.8，与"加入要带 id"同码，别新增）。
 */

export function scopeIsValid(input) {
  if (input === undefined || input === null) return true; // 缺省 = compute
  const items = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(/[\s,]+/)
      : null;
  if (!items) return false;
  return items
    .map((s) => String(s ?? '').trim().toLowerCase())
    .filter(Boolean)
    .every((s) => SCOPE_KNOWN.includes(s));
}

/**
 * 颁发一枚**只属于这个节点**的令牌。明文**只在这里回一次**，库里只留哈希。
 *
 * `scope` 缺省 `compute` —— 老的 `node.mjs --join`（它不带这个字段）行为完全不变。
 */

export function issueNodeToken(nodeId, scope = SCOPE_COMPUTE) {
  const token = `bn_${crypto.randomBytes(24).toString('base64url')}`;
  db.prepare('INSERT INTO node_tokens (tokenHash, nodeId, scope, createdAt) VALUES (?, ?, ?, ?)').run(
    hashOf(token),
    nodeId,
    normScope(scope),
    nowIso(),
  );
  return token;
}

/**
 * 这枚令牌**是谁的、能干什么**（不认识就 null）。给认证层用。
 *
 * 返回 `{ nodeId, scope: Set }` —— 注意 `scope` 是 Set，判定那边只做 `has()`，
 * 不解析字符串（"判定只有一处"那条）。
 */

export function nodeAuthByToken(token) {
  if (!token) return null;
  const row = db.prepare('SELECT nodeId, scope FROM node_tokens WHERE tokenHash = ?').get(hashOf(token));
  if (!row) return null;
  return { nodeId: row.nodeId, scope: parseScope(row.scope) };
}

/**
 * 这枚令牌属于哪个节点（不认识就 null）。
 *
 * ⚠️ 认证层已经改用 `nodeAuthByToken`（它还要 scope）。这个保留是**兼容壳**：
 * 语义与改前逐字相同（只回 nodeId），别再往里加东西。
 */

export function nodeByToken(token) {
  return nodeAuthByToken(token)?.nodeId ?? null;
}

/**
 * 改一台机器的权限（**只有总机侧能做**，设计 §5.9）。
 *
 * 落点是**它名下所有令牌**：同一 nodeId 历史上可能有多枚（重装、重新加入过），
 * 只改最新那枚就会出现"旧令牌还是老权限"—— 而权限边界最怕的就是这种半改状态。
 * 返回改了几行，调用方据此判"这台机器还认不认得出"。
 */

export function setNodeScope(nodeId, scope) {
  const next = normScope(scope);
  const r = db.prepare('UPDATE node_tokens SET scope = ? WHERE nodeId = ?').run(next, nodeId);
  return { nodeId, scope: next, tokens: r.changes };
}

/**
 * 这台机器**现在**能干什么（设备详情页那一行「这台能看到面板」用它）。
 *
 * 多枚令牌取**并集**：只要还有一枚能看面板，这台机器就是能看。
 * 一枚有效令牌都没有（被「忘掉」过）→ `null` —— 那不是 compute，是**没有身份**。
 */

export function scopeOfNode(nodeId) {
  const rows = db.prepare('SELECT scope FROM node_tokens WHERE nodeId = ?').all(nodeId);
  if (!rows.length) return null;
  const set = new Set();
  for (const r of rows) for (const s of parseScope(r.scope)) set.add(s);
  return [...set].sort().join(' ');
}

/**
 * 「最近使用」＝ 这台机器上有人动了面板（`nodes.lastUsedAt`）。
 *
 * **60 秒节流**：一次panel请求写一次库，一个页面刷新就是十几条 —— 那不是"使用记录"，
 * 那是拿库当日志写。节流只影响**写库频率**，不影响判定（判定永远按令牌实时算）。
 * 表是进程内的：重启后第一笔请求会再写一次，无害。
 */
const touchedAt = new Map();

const TOUCH_NODE_USED_MS = 60 * 1000;


export function touchNodeUsed(nodeId) {
  if (!nodeId) return false;
  const now = Date.now();
  if (now - (touchedAt.get(nodeId) ?? 0) < TOUCH_NODE_USED_MS) return false;
  touchedAt.set(nodeId, now);
  const r = db.prepare('UPDATE nodes SET lastUsedAt = ? WHERE id = ?').run(nowIso(), nodeId);
  return r.changes > 0;
}

/** 吊销一台机器的全部令牌 —— 「忘掉」它就是**真的**把它踢出去（而不是删了记录等它回来） */

export function revokeNodeTokens(nodeId) {
  return db.prepare('DELETE FROM node_tokens WHERE nodeId = ?').run(nodeId).changes;
}

/** 这台机器还有几枚有效令牌（界面/诊断用） */

export function countNodeTokens(nodeId) {
  return db.prepare('SELECT COUNT(*) n FROM node_tokens WHERE nodeId = ?').get(nodeId).n;
}

/** 发一个一次性邀请码（10 分钟、只用一次）。同样只存哈希 */

export function createInvite(ttlMs = 10 * 60 * 1000) {
  const code = `bj_${crypto.randomBytes(18).toString('base64url')}`;
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  db.prepare('INSERT INTO node_invites (codeHash, createdAt, expiresAt) VALUES (?, ?, ?)').run(hashOf(code), nowIso(), expiresAt);
  return { code, expiresAt };
}

/**
 * 用掉一个邀请码。**原子**：`UPDATE … WHERE usedAt IS NULL AND expiresAt > ?` 的 changes
 * —— 两个人同时用同一个码，只有一个能成（这是"一次性"的全部意义）。
 */

export function consumeInvite(code, nodeId) {
  const up = db
    .prepare('UPDATE node_invites SET usedAt = ?, usedBy = ? WHERE codeHash = ? AND usedAt IS NULL AND expiresAt > ?')
    .run(nowIso(), nodeId ?? null, hashOf(code), nowIso());
  return up.changes === 1;
}

/** 队列里还压着多少（界面/日志用；也是"离线排队"看得见的那个数） */

export function countNodeJobs(nodeId, status = '待领') {
  return db.prepare('SELECT COUNT(*) n FROM node_jobs WHERE nodeId = ? AND status = ?').get(nodeId, status).n;
}

/** 这个节点上正在跑的活（它掉线了要能看出来"有哪些活卡在它身上"） */

export function listNodeJobs(nodeId, limit = 20) {
  return db
    .prepare('SELECT * FROM node_jobs WHERE nodeId = ? ORDER BY createdAt DESC LIMIT ?')
    .all(nodeId, limit);
}

/* --------------------------------------------------------- 额度（按模型） */

/*
 * DDL 也收在这儿：规矩是 **SQL 只出现在 store 里**（见 docs/形态决策.md §十二 第 2 条）——
 * 将来真要换库（Postgres / better-sqlite3），改动面就只剩这一个文件。
 *
 * v1 的 quotas 是「全站一行」（id=1），跟模型级对不上：一行装不下多个模型，
 * 也没法把一个全站上限摊到某个模型头上。所以直接重建；删之前先看一眼有没有人真配过，
 * 配过就骂一句，别让人以为限额还在。
 */
