/*
 * store/users.mjs —— 账号与会话。
 *
 * 两张表，SQL 全在本文件（仓库规矩：SQL 只出现在 store/ 里）：
 *   · `users`         —— 账号本体（名字 / 内置 / 禁用）
 *   · `user_sessions` —— 登录会话（**只存 token 的 sha256**，明文只在发会话时回一次）
 *
 * **2026-11-07 起账号只是「中枢账号在本机的影子」**：认证全在中枢（本机登录页
 * `POST /hub/login` → `hub/login.mjs`），主机不存密码、不建凭据 —— 这边剩下的只有
 * 「这个人是谁」（名字）和「给他发过哪些会话」。登录 = hub 绑定（store/hubLinks.mjs）
 * + 在这里发一张本机会话。
 *
 * 表结构里的 salt/hash/roleId 等历史列**留着不读**（老库不做列重建）；新写入一律存空串。
 *
 * **第一个账号 = 内置账号**（`builtin=1`）：不可删、不可禁用 —— 防锁死的锁：
 * hub 绑定（hub_links）都指向它，删光了下一个中枢账号就只能凭空重建。
 *
 * ⚠️ `listUsers()` 只返回上表字段 —— 存量死列（salt/hash 等）连字段都不出现。
 */

import crypto from 'node:crypto';
import { db, ensureColumn, newId, nowIso } from './db.mjs';

/** 会话有效期：30 天（与 Cookie 的 Max-Age 一致，两处必须同步改）。
 *  ⚠️ 服务端另有更短的两道闸：空闲 30 分钟、绝对 12 小时，到期即 401 ——
 *  Cookie 的 30 天只是浏览器侧的保存期，登录态以服务端为准。 */
export const SESSION_DAYS = 30;

/** 空闲超时：30 分钟无请求即失效 */
export const IDLE_MINUTES = 30;
/** 绝对超时：12 小时后必须重新登录 */
export const ABSOLUTE_HOURS = 12;

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
    salt      TEXT NOT NULL DEFAULT '',
    hash      TEXT NOT NULL DEFAULT '',
    roleId    TEXT NOT NULL DEFAULT '',
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

// user_sessions 扩列：kind 只有 'hub'（本机登录页与中枢票进门都发这一种）；
// idle/absolute 两道闸；ip/ua 给"会话列表"页用
ensureColumn('user_sessions', 'kind', "kind TEXT NOT NULL DEFAULT 'hub'");
ensureColumn('user_sessions', 'idleExpiresAt', 'idleExpiresAt TEXT');
ensureColumn('user_sessions', 'absoluteExpiresAt', 'absoluteExpiresAt TEXT');
ensureColumn('user_sessions', 'ip', 'ip TEXT');
ensureColumn('user_sessions', 'ua', 'ua TEXT');

/*
 * 「昵称」（2026-11-08 用户："加一个昵称，'中枢账号 · 手机号登录'这个去掉"）。
 *
 * 跟 `name` **分开存**，不能合成一个：`name` 是中枢账号在本机的影子名（登录时按中枢
 * 登录名建出来，手机号全局唯一；身份匹配、消息署名存储用它）。昵称是"我想让人看见的名字"，
 * **全端显示名**（2026-11-09 用户："昵称不能只在我的页面里生效"）——通讯录成员、聊天里
 * 别人的署名、派活选人、任务指派人都先看它，没设再退回账号名。合成一个字段的话，改昵称
 * 就等于改账号名，署名匹配跟着乱，改错了还找不回来。空 = 没设（各处退回账号名）。
 */
ensureColumn('users', 'nickname', 'nickname TEXT');

/* ------------------------------------------------------------------ 读 */

const PUBLIC_FIELDS = 'id, name, nickname, builtin, disabled, createdAt, updatedAt';

function shape(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    nickname: row.nickname ?? null,
    builtin: !!row.builtin,
    disabled: !!row.disabled,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

/** 全部账号（内置在前，其余按创建顺序） */
export function listUsers() {
  return db
    .prepare(`SELECT ${PUBLIC_FIELDS} FROM users ORDER BY builtin DESC, createdAt ASC, id ASC`)
    .all()
    .map(shape);
}

/**
 * 账号名册：**所有能进面板的身份都能看**的极简版 —— 只有 id / 名字 / 昵称 / 是不是内置。
 * 给通讯录的「成员」段与看板派活选真人用。昵称（2026-11-09）跟着名册走：显示名是
 * "团队里有谁"的一部分，跟名字一样不算秘密；改/清昵称仍只在 mayManage 后面（PATCH）。
 */
export function listUserBriefs() {
  return db
    .prepare('SELECT id, name, nickname, builtin FROM users ORDER BY builtin DESC, createdAt ASC, id ASC')
    .all()
    .map((r) => ({ id: r.id, name: r.name, nickname: r.nickname ?? null, builtin: !!r.builtin }));
}

export function getUser(id) {
  return shape(db.prepare(`SELECT ${PUBLIC_FIELDS} FROM users WHERE id = ?`).get(String(id ?? '')));
}

export function nameTaken(name, exceptId = null) {
  const target = normName(name);
  if (!target) return false;
  return db
    .prepare('SELECT id, name FROM users')
    .all()
    .some((r) => normName(r.name) === target && r.id !== exceptId);
}

/** 有没有任何账号（hub 绑定据此决定「认领第一个用户」还是「新建」） */
export function hasUsers() {
  return !!db.prepare('SELECT 1 FROM users LIMIT 1').get();
}

/** 第一个用户是谁（null = 还没人建过） */
export function firstUser() {
  return shape(db.prepare(`SELECT ${PUBLIC_FIELDS} FROM users ORDER BY createdAt ASC, id ASC LIMIT 1`).get());
}

/* ------------------------------------------------------------------ 写 */

/**
 * 建账号。**第一个账号自动成为内置账号**（`builtin=1`）—— 调用方不必管，
 * 规则只在这里判一次，别在路由层再写一遍。
 */
export function createUser({ name } = {}) {
  const first = !hasUsers();
  const id = newId('u');
  const ts = nowIso();
  db.prepare(
    'INSERT INTO users (id, name, salt, hash, roleId, builtin, disabled, createdAt, updatedAt) VALUES (?, ?, \'\', \'\', \'\', ?, 0, ?, ?)',
  ).run(id, String(name ?? '').trim(), first ? 1 : 0, ts, ts);
  return getUser(id);
}

/** 改名（唯一性由路由层判） */
export function renameUser(id, name) {
  const cur = getUser(id);
  if (!cur) return null;
  db.prepare('UPDATE users SET name = ?, updatedAt = ? WHERE id = ?').run(String(name).trim(), nowIso(), id);
  return getUser(id);
}

/**
 * 改昵称（2026-11-08）—— **只动展示名，不碰账号名**（见上面 nickname 列的说明）。
 * 传空 / 全空白 = 清除（存 NULL，界面退回手机号）。长度校验在路由层。
 */
export function setNickname(id, nickname) {
  const cur = getUser(id);
  if (!cur) return null;
  const v = String(nickname ?? '').replace(/\s+/g, ' ').trim() || null;
  db.prepare('UPDATE users SET nickname = ?, updatedAt = ? WHERE id = ?').run(v, nowIso(), id);
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

/** 删账号（连会话一起清）—— 内置账号的保护在路由层，那是产品规则 */
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
 *
 * 签发即带两道服务端闸 —— 空闲 30 分钟（每次请求顺延）、绝对 12 小时（顺延不了）。
 * `expiresAt`（30 天）保留：它是浏览器 Cookie 的同步值，也是两道闸的总兜底。
 * `ip` / `ua` 给"安全 → 会话列表"页展示用。
 */
export function createSession(userId, { ip = null, ua = null, kind = 'hub' } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const ts = Date.now();
  const created = new Date(ts).toISOString();
  const expires = new Date(ts + SESSION_DAYS * 86400_000).toISOString();
  const idle = new Date(ts + IDLE_MINUTES * 60_000).toISOString();
  const absolute = new Date(ts + ABSOLUTE_HOURS * 3600_000).toISOString();
  db.prepare(
    'INSERT INTO user_sessions (tokenHash, userId, createdAt, expiresAt, lastSeenAt, kind, idleExpiresAt, absoluteExpiresAt, ip, ua) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(sha256(token), String(userId), created, expires, created, String(kind), idle, absolute, ip, String(ua ?? '').slice(0, 200));
  return { token, expiresAt: expires };
}

/**
 * 这枚会话 token 是谁的（过期 / 被删 / 用户被禁 都返回 null）。
 *
 * 三道失效闸：
 *   · `absoluteExpiresAt` —— 签发 + 12 小时，**不可顺延**（"每天重新登一次"是刻意的）；
 *   · `idleExpiresAt` —— 最后一次**过闸请求** + 30 分钟（下面 lastSeenAt 更新在判定之后，
 *     所以"最后一次请求"就是它自己这次，语义正确）。
 * `expiresAt`（30 天）仍是总兜底。
 *
 * `lastSeenAt` **60 秒节流**写一次：每个请求都写库会让 SSE 那种长连接把磁盘写满，
 * 而这个字段只是"最近活跃"的参考值，差一分钟没有意义（与 `store.touchDevice` 同一口径）。
 */
export function userBySession(token) {
  const t = String(token ?? '').trim();
  if (!t) return null;
  const row = db.prepare('SELECT * FROM user_sessions WHERE tokenHash = ?').get(sha256(t));
  if (!row) return null;
  const now = Date.now();
  if (Date.parse(row.expiresAt) <= now) {
    deleteSession(t); // 过期就顺手清掉，别让表越长越大
    return null;
  }
  if (row.absoluteExpiresAt && Date.parse(row.absoluteExpiresAt) <= now) {
    deleteSession(t);
    return null;
  }
  if (row.idleExpiresAt && Date.parse(row.idleExpiresAt) <= now) {
    deleteSession(t); // 空闲太久 —— 删掉而不是放它睡死在表里
    return null;
  }
  const u = getUser(row.userId);
  if (!u || u.disabled) return null;
  if (!row.lastSeenAt || now - Date.parse(row.lastSeenAt) > 60_000) {
    const ts = new Date(now).toISOString();
    const idle = new Date(now + IDLE_MINUTES * 60_000).toISOString();
    db.prepare('UPDATE user_sessions SET lastSeenAt = ?, idleExpiresAt = ? WHERE tokenHash = ?').run(ts, idle, row.tokenHash);
  }
  return { tokenHash: row.tokenHash, user: u, kind: row.kind ?? 'hub' };
}

/** 退出登录：删这一条会话 */
export function deleteSession(token) {
  const t = String(token ?? '').trim();
  if (!t) return false;
  const r = db.prepare('DELETE FROM user_sessions WHERE tokenHash = ?').run(sha256(t));
  return r.changes > 0;
}

/** 踢掉某个用户的全部会话（禁用 / 删除时用） */
export function deleteSessionsOf(userId) {
  return db.prepare('DELETE FROM user_sessions WHERE userId = ?').run(String(userId)).changes;
}

/** 清过期会话（启动时跑一次就够，不需要定时器）—— 三道口径一起清 */
export function pruneSessions() {
  const now = new Date().toISOString();
  return db
    .prepare('DELETE FROM user_sessions WHERE expiresAt <= ? OR (absoluteExpiresAt IS NOT NULL AND absoluteExpiresAt <= ?) OR (idleExpiresAt IS NOT NULL AND idleExpiresAt <= ?)')
    .run(now, now, now).changes;
}

/**
 * 存量会话迁移（启动时跑一次，幂等）。
 *
 * 老库的会话只有 `expiresAt`（30 天）—— 直接按"创建 + 12h"回推会把所有人一次踢掉。
 * 口径（照文档抄）：
 *   · `absoluteExpiresAt = max(now+1h, min(原 expiresAt, now+12h))` —— 12 小时内自然过期，
 *     不追溯、不踢人；
 *   · `idleExpiresAt = now + 30min`（从现在起算）。
 * 返回迁移条数，启动日志打一行"N 条存量会话已按新规则迁移"。
 */
export function migrateLegacySessions() {
  const rows = db
    .prepare('SELECT tokenHash, userId, expiresAt FROM user_sessions WHERE absoluteExpiresAt IS NULL')
    .all();
  if (!rows.length) return 0;
  const now = Date.now();
  const absFloor = now + 3600_000; // now+1h
  const absCeil = now + ABSOLUTE_HOURS * 3600_000; // now+12h
  const idle = new Date(now + IDLE_MINUTES * 60_000).toISOString();
  const stmt = db.prepare(
    'UPDATE user_sessions SET idleExpiresAt = ?, absoluteExpiresAt = ? WHERE tokenHash = ?',
  );
  for (const r of rows) {
    const exp = Date.parse(r.expiresAt) || now;
    const abs = new Date(Math.min(Math.max(exp, absFloor), absCeil)).toISOString();
    stmt.run(idle, abs, r.tokenHash);
  }
  return rows.length;
}

/* -------------------------------------------- 会话列表（设置 → 安全） */

/**
 * 某个用户的活会话列表（"安全"分节的设备列表）。**绝不返回 tokenHash 全量** ——
 * 那是 sha256 没错，但没必要给；前 8 位只当展示用的"设备指纹"。
 */
export function listSessionsOf(userId) {
  const now = new Date().toISOString();
  return db
    .prepare(
      "SELECT tokenHash, createdAt, lastSeenAt, ip, ua, kind FROM user_sessions WHERE userId = ? AND expiresAt > ? AND (absoluteExpiresAt IS NULL OR absoluteExpiresAt > ?) AND (idleExpiresAt IS NULL OR idleExpiresAt > ?) ORDER BY lastSeenAt DESC",
    )
    .all(String(userId), now, now, now)
    .map((r) => ({
      id: r.tokenHash.slice(0, 8),
      kind: r.kind ?? 'hub',
      createdAt: r.createdAt,
      lastSeenAt: r.lastSeenAt,
      ip: r.ip ?? '',
      ua: r.ua ?? '',
    }));
}

/** 踢掉某用户除 keepTokenHash 之外的**全部**会话（"踢掉其它设备"按钮），返回条数 */
export function deleteOtherSessions(userId, keepTokenHash) {
  return db
    .prepare('DELETE FROM user_sessions WHERE userId = ? AND tokenHash != ?')
    .run(String(userId), String(keepTokenHash ?? '')).changes;
}
