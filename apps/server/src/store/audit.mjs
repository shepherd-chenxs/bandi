/*
 * store/audit.mjs —— 安全审计（IAM §11.2，2026-10-31 Phase 1 收尾）。
 *
 * `security_events` 一张表 + 两条触发器，SQL 全在本文件（仓库规矩）。
 *
 * **append-only 的实现**（v2.3/v2.4 收敛后的口径，别改）：
 *   · 触发器只放行**一次** `pending → ok|fail` 的状态迁移，且只许改
 *     `result / reason / httpStatus / endedAt` 四列 —— 其余任何 UPDATE、任何 DELETE
 *     都 `RAISE(ABORT)`；
 *   · 回填语句固定带 `AND result='pending'`（并发下的幂等保证）；
 *   · 清理走 `archive()`：临时 DROP 删除触发器 → 搬 archive 表 → 删旧行 → 重建触发器，
 *     并往主表留一条 `kind='audit.archive'`。**不支持就地 UPDATE 改写历史。**
 *   · 增长封顶（2026-11-09）：同类拒绝窗口内聚合（`deny()`，默认 60 秒）；
 *     归档表按事件时间留 1 个月（`pruneArchive()`，启动时跑一次，留 `audit.prune` 痕）。
 *
 * 记录责任划分（§11.2）：
 *   · 401 / 403 拒绝 —— 策略层（guard / guardWrite / CSRF 闸）当场 `deny()`，handler 不参与；
 *   · 写操作 —— server.mjs 请求链统一 `begin()` 一条 pending，`res.on('finish')` 回填；
 *   · 业务细节 —— handler 需要 "谁被踢了 / 导出多少行" 这类细节时自己 `note()`（靠自觉，
 *     但只影响细节，不影响"有没有"）。
 */

import { db, newId, nowIso } from './db.mjs';

db.exec(`
  CREATE TABLE IF NOT EXISTS security_events (
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    actorKind TEXT, actorId TEXT,
    action TEXT, resource TEXT,
    result TEXT NOT NULL DEFAULT 'pending',
    reason TEXT,
    httpStatus INTEGER,
    endedAt TEXT,
    ip TEXT, ua TEXT, requestId TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_events_at ON security_events(at);
  CREATE INDEX IF NOT EXISTS ix_events_actor ON security_events(actorId, at);
  CREATE TABLE IF NOT EXISTS security_events_archive AS SELECT * FROM security_events WHERE 0;
`);

// 触发器每次启动重建一次（IF NOT EXISTS 不覆盖旧定义 —— 老库触发器要升级到 v2.4 口径）
db.exec('DROP TRIGGER IF EXISTS trg_events_no_update; DROP TRIGGER IF EXISTS trg_events_no_delete;');
db.exec(`
  CREATE TRIGGER trg_events_no_update BEFORE UPDATE ON security_events
  WHEN COALESCE(OLD.result,'') <> 'pending'
    OR COALESCE(NEW.result,'') NOT IN ('ok','fail')
    OR OLD.id IS NOT NEW.id
    OR OLD.at IS NOT NEW.at
    OR OLD.kind IS NOT NEW.kind
    OR OLD.actorKind IS NOT NEW.actorKind
    OR OLD.actorId IS NOT NEW.actorId
    OR OLD.action IS NOT NEW.action
    OR OLD.resource IS NOT NEW.resource
    OR OLD.ip IS NOT NEW.ip
    OR OLD.ua IS NOT NEW.ua
    OR OLD.requestId IS NOT NEW.requestId
  BEGIN SELECT RAISE(ABORT, 'security_events is append-only'); END;

  CREATE TRIGGER trg_events_no_delete BEFORE DELETE ON security_events
  BEGIN SELECT RAISE(ABORT, 'security_events is append-only'); END;
`);

/**
 * 写一条审计。**任何异常都吞掉** —— 审计写挂不能拖垮业务请求；
 * 但 console.warn 一声，别静默。
 */
export function add({ kind, actorKind = null, actorId = null, action = null, resource = null, result = 'pending', reason = null, httpStatus = null, ip = null, ua = null, requestId = null } = {}) {
  const id = newId('se');
  try {
    db.prepare(
      'INSERT INTO security_events (id, at, kind, actorKind, actorId, action, resource, result, reason, httpStatus, ip, ua, requestId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, nowIso(), String(kind ?? 'unknown'), actorKind, actorId, action, resource, String(result ?? 'pending'), reason, httpStatus, ip, String(ua ?? '').slice(0, 200), requestId);
  } catch (e) {
    console.warn('[审计] 写入失败（不影响业务）:', e?.message ?? e);
  }
  return id;
}

/**
 * 同类拒绝聚合（2026-11-09，降噪）。
 *
 * 为什么要有：401/403 是**按请求**记的，一个客户端只要在鉴权失效后还不停轮询
 * （2026-11-08 前桌面壳探活打 `/api/state` 那种），5 天就能刷出 22 万行、占 25 MB。
 * 真实的安全信号不是"同一件事重复了多少次"，而是"谁在打哪个口"——同一 (ip, 动作, 原因)
 * 在窗口内只落**一行**，窗口过后再落一行并带上"期间还有 N 次"。
 *
 * 窗口内被压掉的次数记在内存里，进程重启归零 —— 审计是"请求级证据"，
 * 不承诺跨重启的精确计数（要精确计数得给表加列，而主表是 append-only，改列不值当）。
 * `BANDI_AUDIT_DENY_WINDOW_MS` 只给冒烟用（默认 60 秒）；设 0 = 关闭聚合。
 */
const DENY_WINDOW_MS = (() => {
  const raw = Number(process.env.BANDI_AUDIT_DENY_WINDOW_MS);
  if (!Number.isFinite(raw) || raw < 0) return 60_000;
  return raw;
})();
/** 防内存无界：最多记这么多组 key，超了丢最老的（丢了顶多下一行不被合并，不会丢审计） */
const DENY_SEEN_MAX = 2000;
const denySeen = new Map();

/** 拒绝类：当场写死 result='deny'（401/403/429 这类策略层拒绝） */
export function deny(info) {
  if (!DENY_WINDOW_MS) return add({ ...info, result: 'deny' });
  const key = [info?.kind ?? '', info?.ip ?? '', info?.action ?? '', info?.reason ?? ''].join('\u0001');
  const now = Date.now();
  const hit = denySeen.get(key);
  if (hit) {
    if (now - hit.at < DENY_WINDOW_MS) {
      hit.skipped += 1;
      return null; // 窗口内：只计数，不落库
    }
    denySeen.delete(key);
    const merged = hit.skipped ? `（窗口内另有 ${hit.skipped} 次同类拒绝）` : '';
    return add({ ...info, result: 'deny', reason: info?.reason ? `${info.reason}${merged}` : merged || null });
  }
  denySeen.set(key, { at: now, skipped: 0 });
  if (denySeen.size > DENY_SEEN_MAX) denySeen.delete(denySeen.keys().next().value);
  return add({ ...info, result: 'deny' });
}

/**
 * 把一条 pending 回填成结果。触发器 + `AND result='pending'` 双保险：
 * 只有一次 `pending → ok|fail`；第二次调用静默无效（幂等）。
 */
export function resolve(id, { result, reason = null, httpStatus = null } = {}) {
  try {
    db.prepare(
      "UPDATE security_events SET result = ?, reason = ?, httpStatus = ?, endedAt = ? WHERE id = ? AND result = 'pending'",
    ).run(result === 'ok' ? 'ok' : 'fail', reason, httpStatus ?? null, nowIso(), String(id ?? ''));
  } catch (e) {
    console.warn('[审计] 回填失败（不影响业务）:', e?.message ?? e);
  }
}

/**
 * 查询（审计页，admin）。`before` 传上一页最后一行的 at 做游标；limit 上限 200。
 * 只回展示字段 —— reason 可能带错误码，没有敏感值（令牌/密码从不入审计，§11.2）。
 */
export function list({ kind = '', actorId = '', before = '', limit = 50 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const where = [];
  const args = [];
  if (kind) { where.push('kind = ?'); args.push(String(kind)); }
  if (actorId) { where.push('actorId = ?'); args.push(String(actorId)); }
  if (before) { where.push('at < ?'); args.push(String(before)); }
  const sql = `SELECT id, at, kind, actorKind, actorId, action, resource, result, reason, httpStatus, endedAt, ip
    FROM security_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY at DESC, id DESC LIMIT ${n}`;
  return db.prepare(sql).all(...args);
}

/**
 * 导出用（2026-11-03）：同一套筛选，但**不吃 list() 的 200 上限** —— 导出要的是全量。
 * 上限 5000 只是防一次把几万行塞进内存；再多就该分批导，而不是拉爆浏览器。
 */
export function listForExport({ kind = '', limit = 5000 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 5000, 1), 20000);
  const where = [];
  const args = [];
  if (kind) { where.push('kind = ?'); args.push(String(kind)); }
  const sql = `SELECT id, at, kind, actorKind, actorId, action, resource, result, reason, httpStatus, endedAt, ip
    FROM security_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY at DESC, id DESC LIMIT ${n}`;
  return db.prepare(sql).all(...args);
}

/** 删除触发器：archive() / clearAll() 期间要临时摘掉，之后必须原样装回 */
const restoreDeleteTrigger = () =>
  db.exec(`CREATE TRIGGER trg_events_no_delete BEFORE DELETE ON security_events
    BEGIN SELECT RAISE(ABORT, 'security_events is append-only'); END;`);

/** 归档：搬走 N 天前的行（临时摘掉删除触发器，搬完装回），往主表留一条 archive 痕迹 */
export function archive(days = 90) {
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  const n = db.prepare('SELECT COUNT(*) AS n FROM security_events WHERE at < ?').get(cutoff).n;
  if (!n) return 0;
  db.exec('DROP TRIGGER IF EXISTS trg_events_no_delete;');
  try {
    db.prepare('INSERT INTO security_events_archive SELECT * FROM security_events WHERE at < ?').run(cutoff);
    db.prepare('DELETE FROM security_events WHERE at < ?').run(cutoff);
  } finally {
    restoreDeleteTrigger();
  }
  add({ kind: 'audit.archive', action: `archived ${n} events older than ${days}d`, result: 'ok' });
  return n;
}

/**
 * 归档表保留期（2026-11-09，给增长封顶）：搬进 archive 的行原先**永远不删** ——
 * 主表有 90 天这条线，归档没有，于是它只增不减（本机 25.7 MB 里 94% 是 401 噪音）。
 * 现在按事件时间留 **1 个月**（用户 2026-11-09 定）超了直接删；删完往主表留一条
 * `audit.prune` 痕迹，跟 archive()/clearAll() 一样：**清理本身要可追溯**。
 *
 * 为什么 30 天：主表本身就留 90 天，所以归档主要服务的是「清空审计时的留档」——
 * 90 天归档搬过去的老行会在同一次启动的 prune 里被删掉（>90 天必然 >30 天），符合预期：
 * **超过 3 个月的数据不再保存**，别让归档变成第二份永久的库。
 *
 * 为什么 archive 表可以直接 DELETE：append-only 的两条触发器只装在**主表**
 * （security_events）上；归档表本来就是"留档区"，没有触发器挡着（见文件头）。
 */
export const ARCHIVE_KEEP_DAYS = 30;

export function pruneArchive(days = ARCHIVE_KEEP_DAYS) {
  const keep = Math.max(1, Number(days) || ARCHIVE_KEEP_DAYS);
  const cutoff = new Date(Date.now() - keep * 86400_000).toISOString();
  // 老库第一次跑时 archive 表由建表语句建出来，这里不用再兜底
  const n = db.prepare('SELECT COUNT(*) AS n FROM security_events_archive WHERE at < ?').get(cutoff).n;
  if (!n) return 0;
  db.prepare('DELETE FROM security_events_archive WHERE at < ?').run(cutoff);
  add({ kind: 'audit.prune', action: `pruned ${n} archived events older than ${keep}d`, result: 'ok' });
  return n;
}

/**
 * 清空（2026-11-03，审计页「清空」按钮）：**先归档再删** —— 行不能在主表里凭空消失
 * （append-only 的口径），搬进 security_events_archive 仍可事后查；搬完往主表留一条
 * `kind='audit.clear'` 的痕迹，说清楚"是谁在什么时候清了 N 条"。
 * 所以清空之后列表里还剩这一条 —— 这是**故意**的。
 */
export function clearAll({ actorKind = null, actorId = null, ip = null } = {}) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM security_events').get().n;
  if (!n) return 0;
  db.exec('DROP TRIGGER IF EXISTS trg_events_no_delete;');
  try {
    db.prepare('INSERT INTO security_events_archive SELECT * FROM security_events').run();
    db.prepare('DELETE FROM security_events').run();
  } finally {
    restoreDeleteTrigger();
  }
  add({ kind: 'audit.clear', actorKind, actorId, ip, action: `cleared ${n} events`, result: 'ok' });
  return n;
}
