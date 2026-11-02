/* store/collab.mjs —— 协作中心（总公司 / 分公司）中心侧的三张表（2026-10-31 MVP）。
 *
 * 只装**中心那一侧**的东西：接入码（invites）、分公司名录（branches）、派出去的任务（tasks）。
 * 分公司本机的卡不在这里 —— 那是它自己的 `project_tasks`（见 store/projectTasks.mjs 的三列）。
 *
 * 口径（任务书 §五）：
 *   · 令牌只存 `sha256`，明文只在 join 那一次回给分公司；
 *   · 「移除」只写 `revokedAt`，**不删行**（留痕，列表里标「已移除」）；
 *   · 任务状态沿用统一八态，MVP 出现其中 7 态（「想法」不出现）；
 *   · `rev` 是防回环的水位：中心每改一次 +1，分公司按它判断"要不要把中心的值应用回来"。
 */
import crypto from 'node:crypto';
import { db, nowIso } from './db.mjs';

function ensureCollab() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS collab_invites (
      code       TEXT PRIMARY KEY,
      label      TEXT NOT NULL,
      createdAt  TEXT NOT NULL,
      expiresAt  TEXT NOT NULL,
      usedAt     TEXT,
      branchId   TEXT
    );
    CREATE TABLE IF NOT EXISTS collab_branches (
      id         TEXT PRIMARY KEY,
      label      TEXT NOT NULL,
      hostname   TEXT,
      tokenHash  TEXT NOT NULL,
      createdAt  TEXT NOT NULL,
      lastSeenAt TEXT,
      revokedAt  TEXT
    );
    CREATE TABLE IF NOT EXISTS collab_tasks (
      id              TEXT PRIMARY KEY,
      branchId        TEXT NOT NULL,
      title           TEXT NOT NULL,
      description     TEXT NOT NULL DEFAULT '',
      status          TEXT NOT NULL DEFAULT '待办',
      result          TEXT,
      rev             INTEGER NOT NULL DEFAULT 1,
      createdByUserId TEXT,
      createdAt       TEXT NOT NULL,
      updatedAt       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_collab_tasks_branch ON collab_tasks (branchId, updatedAt);
  `);
  /*
   * 2026-11-01 晚七改：**先建行、后发码** —— 「添加设备」直接落一条「待接入」的分公司，
   * 接入码是那一行按需生成的一次性凭据。两处新列都得补（老库没有，ADD COLUMN 幂等）：
   *   · branches.joinedAt   —— 真正接入的时刻（原来拿 createdAt 顶，待接入和已接入分不开）
   *   · invites.targetBranchId —— 这张码是发给**哪一行**的（join 时认行回填，而不是新建一行）
   * 待接入的行 `tokenHash = ''`（列是 NOT NULL，空串既满足约束又不可能匹配任何令牌：
   * branchByToken 比的是 64 位 hex，空串长度对不上）。
   */
  ensureColumn('collab_branches', 'joinedAt', 'TEXT');
  ensureColumn('collab_invites', 'targetBranchId', 'TEXT');
  // 老数据回填：七改之前接入的行没有 joinedAt（那时拿 createdAt 顶）—— 有真令牌的就是已接入，
  // 不回填会被 publicBranch 误判成「待接入」（tokenHash='' 才是待接入的刻痕）。
  db.prepare("UPDATE collab_branches SET joinedAt = createdAt WHERE joinedAt IS NULL AND tokenHash != ''").run();
}

/** 老库补列（SQLite 没有 ADD COLUMN IF NOT EXISTS —— 先问 PRAGMA） */
function ensureColumn(table, col, ddl) {
  const cols = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}

ensureCollab();

/** 接入码 / 分公司令牌都只以摘要落库；明文只在 join 响应里出现一次 */
const sha256Hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** 时间比较用的「现在」——与写库同一个函数，避免两处时钟口径不同 */
const now = () => nowIso();

/** 终态：到了这两个状态，两边都不能再改（任务书 §2.1） */
export const COLLAB_TERMINAL = Object.freeze(['已完成', '已取消']);

/** 分公司**能报**的状态（「已取消」只能中心写） */
export const COLLAB_REPORTABLE = Object.freeze(['待办', '进行中', '待验收', '已阻塞', '失败', '已完成']);

/* ------------------------------------------------------------------ 接入码 */

/**
 * 发一个接入码：10 分钟、只用一次。
 *
 * 码本身**存明文**（这张表只有中心自己看，`code` 是主键）—— 与节点邀请码存哈希不同，
 * 因为这里要支持"同一个码再 join 一次 → E4040"的判定，且码不带任何权限，
 * 用过就废（`usedAt`）。
 *
 * `targetBranchId`（2026-11-01 晚七改）：这个码是发给**哪一行设备**的。join 时认它回填
 * 那一行（状态 待接入 → 已接入），而不是另建一行。老式不带 target 的码仍能用 ——
 * 那种码 join 时按旧逻辑新建一行（CLI / 老客户端不至于断）。
 */
export function createCollabInvite({ label, ttlMs = 10 * 60 * 1000, targetBranchId = null } = {}) {
  const code = `bi_${crypto.randomBytes(6).toString('base64url').slice(0, 8)}`;
  const createdAt = now();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  db.prepare(
    'INSERT INTO collab_invites (code, label, createdAt, expiresAt, targetBranchId) VALUES (?, ?, ?, ?, ?)',
  ).run(code, String(label ?? '').trim(), createdAt, expiresAt, targetBranchId ?? null);
  return { code, label: String(label ?? '').trim(), createdAt, expiresAt, targetBranchId: targetBranchId ?? null };
}

/**
 * 按码取（join 时先看一眼还能不能用 —— 不能的话不值得建分公司，也别白占一个 br_ id）。
 * 只用/过期判定仍以 `consumeCollabInvite` 那条原子 UPDATE 为准，这里只是预检。
 */
export function getCollabInviteByCode(code) {
  return db.prepare('SELECT * FROM collab_invites WHERE code = ?').get(String(code ?? '').trim()) ?? null;
}

/**
 * 用掉一个接入码。**原子**：`UPDATE … WHERE usedAt IS NULL AND expiresAt > now` 的 changes
 * —— 两台机器同时拿同一个码进来，只有一个能成（"一次性"的全部意义）。
 */
export function consumeCollabInvite(code, branchId = null) {
  const c = String(code ?? '').trim();
  if (!c) return false;
  const up = db
    .prepare('UPDATE collab_invites SET usedAt = ?, branchId = ? WHERE code = ? AND usedAt IS NULL AND expiresAt > ?')
    .run(now(), branchId, c, now());
  return up.changes === 1;
}

/* ------------------------------------------------------------------ 分公司 */

const brId = () => `br_${crypto.randomUUID().slice(0, 8)}`;
const ctId = () => `ct_${crypto.randomUUID().slice(0, 8)}`;

/** 分公司的令牌：`bc_` + 32 字节随机 base64url（明文只回给分公司一次） */
export function newBranchToken() {
  return `bc_${crypto.randomBytes(32).toString('base64url')}`;
}

export function createCollabBranch({ label, hostname = null, tokenHash = null, token = null }) {
  const hash = tokenHash ?? sha256Hex(token ?? newBranchToken());
  const id = brId();
  db.prepare(
    'INSERT INTO collab_branches (id, label, hostname, tokenHash, createdAt) VALUES (?, ?, ?, ?, ?)',
  ).run(id, String(label ?? '').trim(), hostname ? String(hostname) : null, hash, now());
  return getCollabBranch(id);
}

/**
 * **建一条「待接入」的设备记录**（2026-11-01 晚七改：添加设备 = 一行，发码是行上的动作）。
 *
 * `tokenHash = ''` 是刻意的：列 NOT NULL，而空串永远不会被 `branchByToken` 认出来
 * （它比的是 64 位 hex，长度对不上）—— 等于"这行还没有任何令牌"，正是待接入的语义。
 */
export function createPendingCollabBranch({ label }) {
  const id = brId();
  db.prepare(
    'INSERT INTO collab_branches (id, label, hostname, tokenHash, createdAt) VALUES (?, ?, NULL, ?, ?)',
  ).run(id, String(label ?? '').trim(), '', now());
  return getCollabBranch(id);
}

/** 这一行接入了吗（有令牌、没被移除） */
export function isBranchJoined(b) {
  return !!b && !b.revokedAt && !!b.joinedAt;
}

/**
 * 待接入那行**被接入**：挂上令牌与主机名，记下接入时刻，顺手算一次心跳。
 * 只对待接入的行生效（`joinedAt IS NULL`）—— 已经接入过的行不会被第二次 join 覆盖令牌。
 */
export function attachCollabBranchJoin(id, { token, hostname = null }) {
  const ts = now();
  const r = db
    .prepare(
      `UPDATE collab_branches
          SET tokenHash = ?, hostname = ?, joinedAt = ?, lastSeenAt = ?
        WHERE id = ? AND joinedAt IS NULL AND revokedAt IS NULL`,
    )
    .run(sha256Hex(token), hostname ? String(hostname) : null, ts, ts, String(id ?? ''));
  return r.changes > 0 ? getCollabBranch(id) : null;
}

/**
 * **重新接入**（2026-11-01）：已移除的行凭新码复活 —— 撤销移除、换新令牌、刷新加入时间。
 *
 * 为什么不删了重建：行上挂着历史（主机名、旧任务），删了重加这些就对不上了；
 * 用户点「重新接入」的意思就是"还是这台机器"。只对 `revokedAt` 非空的行生效，
 * 活着的行走 `attachCollabBranchJoin`。
 */
export function rejoinCollabBranch(id, { token, hostname = null }) {
  const ts = now();
  const r = db
    .prepare(
      `UPDATE collab_branches
          SET tokenHash = ?, hostname = ?, joinedAt = ?, lastSeenAt = ?, revokedAt = NULL
        WHERE id = ? AND revokedAt IS NOT NULL`,
    )
    .run(sha256Hex(token), hostname ? String(hostname) : null, ts, ts, String(id ?? ''));
  return r.changes > 0 ? getCollabBranch(id) : null;
}

/** 改名（等待接入时最常改：先随便建一行，接之前起个正经名字） */
export function renameCollabBranch(id, label) {
  const r = db
    .prepare('UPDATE collab_branches SET label = ? WHERE id = ? AND revokedAt IS NULL')
    .run(String(label ?? '').trim(), String(id ?? ''));
  return r.changes > 0 ? getCollabBranch(id) : null;
}

export function getCollabBranch(id) {
  return db.prepare('SELECT * FROM collab_branches WHERE id = ?').get(String(id ?? '')) ?? null;
}

/** 分公司列表（带未终态任务数 —— 给列表用，别让前端自己数） */
export function listCollabBranches() {
  const rows = db
    .prepare(
      `SELECT b.*,
              (SELECT COUNT(*) FROM collab_tasks t
                WHERE t.branchId = b.id AND t.status NOT IN ('已完成', '已取消')) AS openTasks
         FROM collab_branches b
        ORDER BY b.createdAt DESC`,
    )
    .all();
  return rows;
}

/** 每次 poll 刷新心跳（列表上的「在线」判据：lastSeenAt 30 秒内） */
export function touchCollabBranch(id) {
  return db.prepare('UPDATE collab_branches SET lastSeenAt = ? WHERE id = ?').run(now(), String(id ?? '')).changes > 0;
}

/**
 * 「移除」（中心）/「退出」（分公司）都写这里 —— 幂等：已经移除过的不改时间戳。
 * **不删行**：那台机器是谁、什么时候进来的、什么时候被踢的，都是要留的痕。
 */
export function revokeCollabBranch(id) {
  const r = db
    .prepare('UPDATE collab_branches SET revokedAt = ? WHERE id = ? AND revokedAt IS NULL')
    .run(now(), String(id ?? ''));
  return r.changes > 0;
}

/**
 * **真删**：把一行分公司连同它名下的任务记录整个抹掉。
 *
 * 只服务「已移除」「待接入」的行 —— 留痕是给**在线历史**用的（谁进来过、谁被踢过），
 * 痕留到没用了（用户主动清），删就删干净：`collab_tasks` 里挂在它名下的行一起走，
 * 不然「我派出去的活」里会剩下一堆查无此设备的孤儿。
 * 指向它的待用接入码一并作废（`targetBranchId` 清空 —— 行没了，码接进来也没处落）。
 */
export function deleteCollabBranch(id) {
  const key = String(id ?? '');
  db.prepare('UPDATE collab_invites SET targetBranchId = NULL WHERE targetBranchId = ?').run(key);
  const tasks = db.prepare('DELETE FROM collab_tasks WHERE branchId = ?').run(key).changes;
  const row = db.prepare('DELETE FROM collab_branches WHERE id = ?').run(key).changes > 0;
  return { ok: row, tasks };
}

/**
 * 凭 `bc_` 令牌认分公司（认不出 → null）。
 *
 * 为什么不直接 `SELECT … WHERE tokenHash = sha256(token)`：那样比较时间会随"前缀相同几个字节"
 * 变化，理论上能撞出来。这里逐行 `timingSafeEqual`，比较时间只跟行数有关。
 * 分公司数量是人手加出来的（十几台顶天），全表扫一遍毫无压力。
 */
export function branchByToken(token) {
  const t = String(token ?? '').trim();
  if (!t) return null;
  const want = Buffer.from(sha256Hex(t), 'hex');
  for (const row of db.prepare('SELECT * FROM collab_branches WHERE revokedAt IS NULL').all()) {
    const got = Buffer.from(String(row.tokenHash ?? ''), 'hex');
    if (got.length === want.length && crypto.timingSafeEqual(got, want)) return row;
  }
  return null;
}

/* -------------------------------------------------------------------- 任务 */

export function createCollabTask({ branchId, title, description = '', createdByUserId = null, status = '待办' }) {
  const id = ctId();
  const ts = now();
  db.prepare(
    `INSERT INTO collab_tasks (id, branchId, title, description, status, rev, createdByUserId, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  ).run(id, String(branchId), String(title), String(description ?? ''), status, createdByUserId ?? null, ts, ts);
  return getCollabTask(id);
}

export function getCollabTask(id) {
  return db.prepare('SELECT * FROM collab_tasks WHERE id = ?').get(String(id ?? '')) ?? null;
}

/** 中心列表 / 分公司 poll 共用：updatedAt 倒序，上限 200 条（MVP 不分页） */
export function listCollabTasks({ branchId = null, limit = 200 } = {}) {
  if (branchId) {
    return db
      .prepare('SELECT * FROM collab_tasks WHERE branchId = ? ORDER BY updatedAt DESC LIMIT ?')
      .all(String(branchId), limit);
  }
  return db.prepare('SELECT * FROM collab_tasks ORDER BY updatedAt DESC LIMIT ?').all(limit);
}

/**
 * 改状态 = 中心改一次（`rev += 1`）。**这是防回环的水位**：
 * 分公司下一拍看到 rev 变大，就把同一个状态"应用"回本地 —— 等于空操作。
 */
export function setCollabTaskStatus(id, status) {
  const r = db
    .prepare('UPDATE collab_tasks SET status = ?, rev = rev + 1, updatedAt = ? WHERE id = ?')
    .run(String(status), now(), String(id ?? ''));
  return r.changes > 0 ? getCollabTask(id) : null;
}

/**
 * 分公司报回来的状态。跟中心自己改的区别只有一个：**中心改的 rev +1，分公司报的也 +1**
 * —— 两边都得让"对方下一拍看到变化"，不然本地改完中心不变、或者中心改完本地又改回去。
 */
export function reportCollabTaskStatus(id, status) {
  return setCollabTaskStatus(id, status);
}

/** 中心页/分公司 poll 给出去的字段（不带 tokenHash，也不带 createdByUserId） */
export function publicCollabTask(t) {
  if (!t) return null;
  return {
    id: t.id,
    branchId: t.branchId,
    title: t.title,
    description: t.description ?? '',
    status: t.status,
    result: t.result ?? null,
    rev: t.rev ?? 1,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}
