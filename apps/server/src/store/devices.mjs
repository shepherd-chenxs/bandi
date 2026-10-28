/*
 * store/devices.mjs —— 手机配对与设备域（2026-11 手机端增量）。
 *
 * 三张表：
 *   mobile_devices        已配对的手机设备（PRD P0-3：设备名、配对时间、最近活跃）；
 *   mobile_device_tokens  设备长期令牌 —— **只存 sha256 哈希**（对齐 node_tokens；
 *                         库文件被拿走也拿不到能用的凭据），expiresAt 留 NULL = 永久有效，
 *                         列先建好，将来要加"30 天需重新配对"就是一行默认值的事；
 *   mobile_pair_tokens    一次性配对令牌（5 分钟、单次使用，对齐 node_invites 的范式）。
 *
 * 铁律（见 docs/mobile/pwa-design.md §1.2）：
 *   · SQL 只出现在 store/ 目录里 —— 本文件是配对域的唯一 SQL 持有点；
 *   · 表里只存哈希，不存明文 —— 明文只在颁发那一刻回给请求方一次；
 *   · 一次性核销靠 `UPDATE … WHERE usedAt IS NULL AND expiresAt > ?` 的 changes ——
 *     同一个码被两台手机同时用，只有一个能成。
 */

import crypto from 'node:crypto';
import { db, ensureColumn, newId, nowIso } from './db.mjs';

db.exec(`
  CREATE TABLE IF NOT EXISTS mobile_devices (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    pairedAt    TEXT NOT NULL,
    lastSeenAt  TEXT NOT NULL,
    lastIp      TEXT
  );

  CREATE TABLE IF NOT EXISTS mobile_device_tokens (
    tokenHash  TEXT PRIMARY KEY,
    deviceId   TEXT NOT NULL,
    createdAt  TEXT NOT NULL,
    expiresAt  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_mobile_dev_tokens ON mobile_device_tokens (deviceId);

  CREATE TABLE IF NOT EXISTS mobile_pair_tokens (
    tokenHash      TEXT PRIMARY KEY,
    createdAt      TEXT NOT NULL,
    expiresAt      TEXT NOT NULL,
    usedAt         TEXT,
    usedByDeviceId TEXT
  );
`);

const hashOf = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/* ------------------------------------------------- 面板角色（2026-10-28 第四刀） */

/*
 * `mobile_devices.roleId`：总机给这部手机指定的面板角色（`roles.id`），空 = 默认（`mobile`）。
 * `ensureColumn` 让老库平滑升级；这一列只影响**手机端的菜单显示**（底部 tab 与页面），
 * 不参与 `deviceMayReach` 那套白名单判定。
 */
ensureColumn('mobile_devices', 'roleId', 'roleId TEXT');

/** 给一部手机指定面板角色（`null` = 恢复默认）。设备不存在返回 null */
export function setDeviceRole(deviceId, roleId) {
  const d = getDevice(deviceId);
  if (!d) return null;
  const next = String(roleId ?? '').trim() || null;
  db.prepare('UPDATE mobile_devices SET roleId = ? WHERE id = ?').run(next, deviceId);
  return getDevice(deviceId);
}

/**
 * 有多少部**还在用**的手机绑着这个角色（删角色前要问，见 routes/roles.mjs 的 E2071）。
 *
 * 只数名下有**有效令牌**的设备：被踢出的设备行留着当记录（`tokenCount=0`），
 * 它已经拿不到任何菜单了。把它也算"在用"会让那个角色**永远删不掉** ——
 * 而界面上被踢设备的下拉是禁用的，连"解绑"都做不了（2026-10-28 修）。
 */
export function countPhonesByRole(roleId) {
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM mobile_devices d
        WHERE d.roleId = ?
          AND EXISTS (
            SELECT 1 FROM mobile_device_tokens t
             WHERE t.deviceId = d.id AND (t.expiresAt IS NULL OR t.expiresAt > ?)
          )`,
    )
    .get(String(roleId ?? ''), nowIso()).n;
}

/** 配对令牌默认时效（PRD P0-2：短时效，5 分钟、单次使用） */
export const PAIR_TOKEN_TTL_MS = 5 * 60 * 1000;

/** 同时最多压着几个没用掉的配对码（设计 §7-6：防设置页反复点刷爆表） */
const MAX_UNUSED_PAIR_TOKENS = 3;

/* ------------------------------------------------------------------ 配对令牌 */

/**
 * 发一个一次性配对令牌。**只存哈希**，明文只在这里回一次。
 * 发码前顺手清场：过期的一律删；没用掉的超过 3 个就删掉最老的（给新码腾位）。
 */
export function createPairToken(ttlMs = PAIR_TOKEN_TTL_MS) {
  db.prepare('DELETE FROM mobile_pair_tokens WHERE expiresAt <= ?').run(nowIso());
  const unused = db.prepare('SELECT tokenHash FROM mobile_pair_tokens WHERE usedAt IS NULL ORDER BY createdAt').all();
  for (let i = 0; i + MAX_UNUSED_PAIR_TOKENS <= unused.length; i += 1) {
    db.prepare('DELETE FROM mobile_pair_tokens WHERE tokenHash = ?').run(unused[i].tokenHash);
  }
  const token = `bp_${crypto.randomBytes(18).toString('base64url')}`;
  const expiresAt = new Date(Date.now() + Math.max(1000, Number(ttlMs) || PAIR_TOKEN_TTL_MS)).toISOString();
  db.prepare('INSERT INTO mobile_pair_tokens (tokenHash, createdAt, expiresAt) VALUES (?, ?, ?)').run(hashOf(token), nowIso(), expiresAt);
  return { token, expiresAt };
}

/** 这枚配对码**现在**是什么状态（不认识就 null）。给路由层分类错误码用：未知 / 已用 / 已过期 */
export function getPairToken(token) {
  if (!token) return null;
  return db.prepare('SELECT * FROM mobile_pair_tokens WHERE tokenHash = ?').get(hashOf(token)) ?? null;
}

/**
 * 用掉一个配对码。**原子**：`UPDATE … WHERE usedAt IS NULL AND expiresAt > ?` 的 changes
 * —— 两个人同时用同一个码，只有一个能成（这是"一次性"的全部意义）。
 */
export function consumePairToken(token, deviceId) {
  const up = db
    .prepare('UPDATE mobile_pair_tokens SET usedAt = ?, usedByDeviceId = ? WHERE tokenHash = ? AND usedAt IS NULL AND expiresAt > ?')
    .run(nowIso(), deviceId ?? null, hashOf(token), nowIso());
  return up.changes === 1;
}

/* ------------------------------------------------------------------ 设备 */

/** 配对成功 = 建一行设备。名字是手机自报的（UA 猜的），只截到 60 字防灌垃圾 */
export function createDevice(name) {
  const id = newId('md');
  const ts = nowIso();
  db.prepare('INSERT INTO mobile_devices (id, name, pairedAt, lastSeenAt, lastIp) VALUES (?, ?, ?, ?, NULL)').run(
    id,
    String(name ?? '').trim().slice(0, 60) || '手机设备',
    ts,
    ts,
  );
  return getDevice(id);
}

export function getDevice(id) {
  return db.prepare('SELECT * FROM mobile_devices WHERE id = ?').get(id) ?? null;
}

/** 删一行设备（只给"抢码失败"的回滚用 —— 正常的踢出走 revokeDeviceTokens，行留着给人看记录） */
export function forgetDevice(id) {
  return db.prepare('DELETE FROM mobile_devices WHERE id = ?').run(id).changes > 0;
}

export function listDevices() {
  /*
   * 带上**有效令牌数**（2026-10-28）：踢出只删令牌、设备行留着当记录（见上面 forgetDevice
   * 的注释）。界面要是只看行，踢完那台手机原样还在列表里 —— 用户会以为没踢掉。
   * 数 = 0 就是「已踢出/已失效」，由前端渲染成那个状态。
   */
  return db
    .prepare(
      `SELECT d.*, (SELECT COUNT(*) FROM mobile_device_tokens t WHERE t.deviceId = d.id) AS tokenCount
         FROM mobile_devices d ORDER BY d.pairedAt`,
    )
    .all();
}

/**
 * 颁发一枚**只属于这台设备**的长期令牌。明文**只在这里回一次**，库里只留哈希。
 *
 * `ttlMs` 给 null（默认）= 永久有效 —— 用户已确认的决策（设计 §7-3）：
 * 设备令牌默认永久 + 手动踢出；`expiresAt` 列留着做旋钮，要加"30 天上限"就是传个毫秒数。
 */
export function issueDeviceToken(deviceId, ttlMs = null) {
  const token = `bd_${crypto.randomBytes(24).toString('base64url')}`;
  const expiresAt = ttlMs ? new Date(Date.now() + Number(ttlMs)).toISOString() : null;
  db.prepare('INSERT INTO mobile_device_tokens (tokenHash, deviceId, createdAt, expiresAt) VALUES (?, ?, ?, ?)').run(
    hashOf(token),
    deviceId,
    nowIso(),
    expiresAt,
  );
  return token;
}

/**
 * 这枚令牌是谁的（不认识就 null）。给认证层（auth.identify）用。
 * 过期令牌视同不存在 —— 认证层拿到的就是 null，走 401，与"被踢出"同一条路。
 */
export function deviceAuthByToken(token) {
  if (!token) return null;
  const row = db.prepare('SELECT deviceId, expiresAt FROM mobile_device_tokens WHERE tokenHash = ?').get(hashOf(token));
  if (!row) return null;
  if (row.expiresAt && row.expiresAt <= nowIso()) return null;
  return { deviceId: row.deviceId };
}

/** 吊销一台设备的全部令牌 —— 「踢出」就是**真的**把它踢出去（下次请求 401，引导重新扫码） */
export function revokeDeviceTokens(deviceId) {
  return db.prepare('DELETE FROM mobile_device_tokens WHERE deviceId = ?').run(deviceId).changes;
}

/** 这台设备还有几枚有效令牌（界面/诊断用） */
export function countDeviceTokens(deviceId) {
  return db.prepare('SELECT COUNT(*) n FROM mobile_device_tokens WHERE deviceId = ?').get(deviceId).n;
}

/**
 * 「最近活跃」＝ 这台手机真的在用（`mobile_devices.lastSeenAt` + 来源 IP）。
 *
 * **60 秒节流**（仿 nodes.mjs 的 touchNodeUsed）：一次页面刷新就是十几条请求，
 * 每条都写库是拿库当日志写。节流只影响写库频率，不影响判定（判定永远按令牌实时算）。
 * 进程内的 Map 重启即清，重启后第一笔请求会再写一次，无害。
 */
const touchedAt = new Map();

const TOUCH_DEVICE_MS = 60 * 1000;

export function touchDevice(deviceId, ip = null) {
  if (!deviceId) return false;
  const now = Date.now();
  if (now - (touchedAt.get(deviceId) ?? 0) < TOUCH_DEVICE_MS) return false;
  touchedAt.set(deviceId, now);
  const r = db.prepare('UPDATE mobile_devices SET lastSeenAt = ?, lastIp = ? WHERE id = ?').run(nowIso(), ip ?? null, deviceId);
  return r.changes > 0;
}
