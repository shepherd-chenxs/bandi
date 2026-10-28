/*
 * store/users.mjs —— 账号与会话（2026-10-28 第三刀：账号、登录与角色分配）。
 *
 * 两张表，SQL 全在本文件（仓库规矩：SQL 只出现在 store/ 里）：
 *   · `users`         —— 账号本体（名字 / salt / hash / 角色 / 内置 / 禁用）
 *   · `user_sessions` —— 登录会话（**只存 token 的 sha256**，明文只在登录响应里回一次）
 *
 * **密码口径**（任务书 §二 拍板，别改）：
 *   · `scryptSync(password, salt, 64)`，每人独立 16 字节 salt；库里只有 salt + hash，**没有明文**；
 *   · 零依赖 —— 只用 `node:crypto`，不引 bcrypt/argon2（红线上不许有 node_modules）；
 *   · 定长比较走 `timingSafeEqual`，"比到第几个字符不同"不泄漏出去。
 *
 * **第一个用户 = 内置管理员**（`builtin=1` + `roleId='admin'`）：
 * 只有本机（回环）能建，建完**不可删、不可改角色、不可禁用** —— 这是防锁死的锁。
 * 和 roles 那边的 `admin` 角色是同一个思路：系统里必须永远有一条能进门的钥匙。
 *
 * ⚠️ `listUsers()` **绝不返回 salt / hash**（任务书 §三 硬约束）：连字段都不出现，
 * 免得哪天有人顺手把整个对象丢进接口响应里。
 */

import crypto from 'node:crypto';
import { db, newId, nowIso } from './db.mjs';

/** 会话有效期：30 天（与 Cookie 的 Max-Age 一致，两处必须同步改） */
export const SESSION_DAYS = 30;

/** 名字归一：去首尾空白 + 折叠内部空白 + 忽略大小写 —— "张三"和" 张三 "是同一个人 */
export function normName(name) {
  return String(name ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/* ------------------------------------------------------------------ 建表 */

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    salt      TEXT NOT NULL,
    hash      TEXT NOT NULL,
    roleId    TEXT NOT NULL,
    builtin   INTEGER NOT NULL DEFAULT 0,
    disabled  INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT,
    updatedAt TEXT
  );

  CREATE TABLE IF NOT EXISTS user_sessions (
    tokenHash  TEXT PRIMARY KEY,
    userId     TEXT NOT NULL,
    createdAt  TEXT NOT NULL,
    expiresAt  TEXT NOT NULL,
    lastSeenAt TEXT
  );
`);

/* ------------------------------------------------------------------ 密码 */

function hashPassword(password, saltHex) {
  return crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), 64).toString('hex');
}

/**
 * 密码对不对（**不区分"用户不存在"**：调用方一律回同一句话，见路由层）。
 *
 * `user` 为 null 时也走一遍 scrypt（对一个固定假 salt），让"存在的用户名 / 不存在的用户名"
 * 在响应时间上尽量一致 —— 时间侧信道比文案泄漏更难防，能做的就做。
 */
const DUMMY_SALT = '00'.repeat(16);
export function checkPassword(user, password) {
  const salt = user?.salt || DUMMY_SALT;
  const want = user?.hash || crypto.scryptSync('x', Buffer.from(DUMMY_SALT, 'hex'), 64).toString('hex');
  const got = hashPassword(password, salt);
  const A = Buffer.from(got, 'hex');
  const B = Buffer.from(want, 'hex');
  return A.length === B.length && crypto.timingSafeEqual(A, B) && !!user;
}

/* ------------------------------------------------------------------ 读 */

const PUBLIC_FIELDS = 'id, name, roleId, builtin, disabled, createdAt, updatedAt';

function shape(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    roleId: row.roleId,
    builtin: !!row.builtin,
    disabled: !!row.disabled,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

/** 全部账号（**不含 salt/hash**；内置在前，其余按创建顺序） */
export function listUsers() {
  return db
    .prepare(`SELECT ${PUBLIC_FIELDS} FROM users ORDER BY builtin DESC, createdAt ASC, id ASC`)
    .all()
    .map(shape);
}

export function getUser(id) {
  return shape(db.prepare(`SELECT ${PUBLIC_FIELDS} FROM users WHERE id = ?`).get(String(id ?? '')));
}

/** 按名字取（归一后比较；登录与"重名"检查共用这一份口径） */
export function userByName(name) {
  const target = normName(name);
  if (!target) return null;
  const row = db
    .prepare(`SELECT ${PUBLIC_FIELDS}, salt, hash FROM users`)
    .all()
    .find((r) => normName(r.name) === target);
  return row ? { ...shape(row), salt: row.salt, hash: row.hash } : null;
}

export function nameTaken(name, exceptId = null) {
  const target = normName(name);
  if (!target) return false;
  return db
    .prepare('SELECT id, name FROM users')
    .all()
    .some((r) => normName(r.name) === target && r.id !== exceptId);
}

/** 有没有任何账号（登录页据此决定"显不显示用户名密码表单"） */
export function hasUsers() {
  return !!db.prepare('SELECT 1 FROM users LIMIT 1').get();
}

/** 还活着的管理员有几个（= `admin` 角色 + 未禁用）—— 删/降级前必须问它 */
export function countAdmins(exceptId = null) {
  return db
    .prepare("SELECT id FROM users WHERE roleId = 'admin' AND disabled = 0")
    .all()
    .filter((r) => r.id !== exceptId).length;
}

/** 第一个用户是谁（null = 还没人建过） */
export function firstUser() {
  return shape(db.prepare('SELECT ' + PUBLIC_FIELDS + ' FROM users ORDER BY createdAt ASC, id ASC LIMIT 1').get());
}

/* ------------------------------------------------------------------ 写 */

/**
 * 建账号。**第一个账号自动成为内置管理员**（`roleId='admin'`、`builtin=1`）——
 * 调用方不必传 roleId，传了也会被覆盖：规则只在这里判一次，别在路由层再写一遍。
 */
export function createUser({ name, password, roleId = null } = {}) {
  const first = !hasUsers();
  const salt = crypto.randomBytes(16).toString('hex');
  const id = newId('u');
  const ts = nowIso();
  const finalRole = first ? 'admin' : String(roleId ?? '').trim();
  db.prepare(
    'INSERT INTO users (id, name, salt, hash, roleId, builtin, disabled, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)',
  ).run(id, String(name ?? '').trim(), salt, hashPassword(password, salt), finalRole, first ? 1 : 0, ts, ts);
  return getUser(id);
}

/** 改名（唯一性由路由层判，见 E1113/E3804） */
export function renameUser(id, name) {
  const cur = getUser(id);
  if (!cur) return null;
  db.prepare('UPDATE users SET name = ?, updatedAt = ? WHERE id = ?').run(String(name).trim(), nowIso(), id);
  return getUser(id);
}

/** 改密码：换 salt 重算 hash，并**作废该用户全部会话**（改密码 = 别处登过的都下线） */
export function setPassword(id, password) {
  const cur = getUser(id);
  if (!cur) return null;
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE users SET salt = ?, hash = ?, updatedAt = ? WHERE id = ?').run(
    salt,
    hashPassword(password, salt),
    nowIso(),
    id,
  );
  deleteSessionsOf(id);
  return getUser(id);
}

/** 改角色 */
export function setRole(id, roleId) {
  const cur = getUser(id);
  if (!cur) return null;
  db.prepare('UPDATE users SET roleId = ?, updatedAt = ? WHERE id = ?').run(String(roleId).trim(), nowIso(), id);
  return getUser(id);
}

/** 启用 / 禁用（禁用 = 踢下线 + 登不进来） */
export function setDisabled(id, disabled) {
  const cur = getUser(id);
  if (!cur) return null;
  db.prepare('UPDATE users SET disabled = ?, updatedAt = ? WHERE id = ?').run(disabled ? 1 : 0, nowIso(), id);
  if (disabled) deleteSessionsOf(id);
  return getUser(id);
}

/** 删账号（连会话一起清）—— 内置与"最后一个管理员"的保护在路由层，那是产品规则 */
export function deleteUser(id) {
  const cur = db.prepare('SELECT id FROM users WHERE id = ?').get(String(id ?? ''));
  if (!cur) return { ok: false, reason: 'missing' };
  db.prepare('DELETE FROM user_sessions WHERE userId = ?').run(cur.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(cur.id);
  return { ok: true, id: cur.id };
}

/* ------------------------------------------------------------------ 会话 */

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/**
 * 开一次登录会话：**明文只回给调用方一次**，库里只有 sha256。
 * 32 字节随机 base64url（43 字符）—— 足够长，猜不出来。
 */
export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const ts = Date.now();
  const created = new Date(ts).toISOString();
  const expires = new Date(ts + SESSION_DAYS * 86400_000).toISOString();
  db.prepare('INSERT INTO user_sessions (tokenHash, userId, createdAt, expiresAt, lastSeenAt) VALUES (?, ?, ?, ?, ?)').run(
    sha256(token),
    String(userId),
    created,
    expires,
    created,
  );
  return { token, expiresAt: expires };
}

/**
 * 这枚会话 token 是谁的（过期 / 被删 / 用户被禁 都返回 null）。
 *
 * `lastSeenAt` **60 秒节流**写一次：每个请求都写库会让 SSE 那种长连接把磁盘写满，
 * 而这个字段只是"最近活跃"的参考值，差一分钟没有意义（与 `store.touchDevice` 同一口径）。
 */
export function userBySession(token) {
  const t = String(token ?? '').trim();
  if (!t) return null;
  const row = db.prepare('SELECT * FROM user_sessions WHERE tokenHash = ?').get(sha256(t));
  if (!row) return null;
  if (Date.parse(row.expiresAt) <= Date.now()) {
    deleteSession(t); // 过期就顺手清掉，别让表越长越大
    return null;
  }
  const u = getUser(row.userId);
  if (!u || u.disabled) return null;
  const now = Date.now();
  if (!row.lastSeenAt || now - Date.parse(row.lastSeenAt) > 60_000) {
    db.prepare('UPDATE user_sessions SET lastSeenAt = ? WHERE tokenHash = ?').run(new Date(now).toISOString(), row.tokenHash);
  }
  return { tokenHash: row.tokenHash, user: u };
}

/** 退出登录：删这一条会话 */
export function deleteSession(token) {
  const t = String(token ?? '').trim();
  if (!t) return false;
  const r = db.prepare('DELETE FROM user_sessions WHERE tokenHash = ?').run(sha256(t));
  return r.changes > 0;
}

/** 踢掉某个用户的全部会话（改密码 / 禁用 / 删除时用） */
export function deleteSessionsOf(userId) {
  return db.prepare('DELETE FROM user_sessions WHERE userId = ?').run(String(userId)).changes;
}

/** 清过期会话（启动时跑一次就够，不需要定时器） */
export function pruneSessions() {
  return db.prepare('DELETE FROM user_sessions WHERE expiresAt <= ?').run(new Date().toISOString()).changes;
}
