/*
 * store/devices.mjs —— 手机配对与设备域（2026-11 手机端增量）。
 *
 * 三张表：
 *   mobile_devices        已配对的手机设备（PRD P0-3：设备名、配对时间、最近活跃）；
 *   mobile_device_tokens  设备长期令牌 —— **只存 sha256 哈希**（对齐 node_tokens；
 *                         库文件被拿走也拿不到能用的凭据），expiresAt 留 NULL = 永久有效，
 *                         列先建好，将来要加"30 天需重新配对"就是一行默认值的事；
 *   mobile_pair_tokens    一次性配对凭据（5 分钟、单次使用，对齐 node_invites 的范式）。
 *                         2026-11-01 起主路径是 **9 位数字邀请码**（`createPairCode`），
 *                         早先的 `bp_…` 长令牌还能核销（`createPairToken`），同一张表。
 *
 * 铁律（见 docs/mobile/pwa-design.md §1.2）：
 *   · SQL 只出现在 store/ 目录里 —— 本文件是配对域的唯一 SQL 持有点；
 *   · 表里只存哈希，不存明文 —— 明文只在颁发那一刻回给请求方一次；
 *   · 一次性核销靠 `UPDATE … WHERE usedAt IS NULL AND expiresAt > ?` 的 changes ——
 *     同一个码被两台手机同时用，只有一个能成。
 */

import crypto from 'node:crypto';
import { readNetMode } from '../netmode.mjs';
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

/*
 * `mobile_devices.clientKey`（2026-11-01 一机一刀）：手机端自己生成并持久保存的
 * 随机 ID（localStorage），claim 时随 body 上报。服务端拿它认"这台手机之前配过"——
 * **同一台手机再配对复用同一行**，不再长出第二条记录（用户实测：重复扫码 →
 * 设备列表出现两条 "Android · 2211133C"）。只存随机 ID，不含任何设备指纹。
 */
ensureColumn('mobile_devices', 'clientKey', 'clientKey TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_mobile_clientKey ON mobile_devices (clientKey) WHERE clientKey IS NOT NULL');

/*
 * `mobile_devices.disconnectedAt`（2026-11-01 二刀）：**"断开连接" ≠ "取消配对"**
 * （用户定稿的口径）——
 *   · 断开连接 = 这台手机暂时不连了（可能换另一台手机连）：令牌吊销、行**保留**、
 *     clientKey 保留；没有别的手机在用的时候，它自己就能连回来，不用重新扫码；
 *   · 取消配对 = 删行（`forgetDevice`），下次必须重新扫码 / 填邀请码。
 * NULL = 在用（或者从来没连上过）。列表里靠这一列区分「在用 / 已断开」。
 */
ensureColumn('mobile_devices', 'disconnectedAt', 'disconnectedAt TEXT');

/** clientKey 的形状（与 pair-claim.mjs 生成的 32 位 hex 对齐；放这里是为了路由不用重复校验） */
const CLIENT_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;

function cleanClientKey(v) {
  const k = String(v ?? '').trim();
  return CLIENT_KEY_RE.test(k) ? k : null;
}

/** 按 clientKey 找设备（没有就 null）。给"同一台手机再配对"复用行用 */
export function findDeviceByClientKey(clientKey) {
  const k = cleanClientKey(clientKey);
  if (!k) return null;
  return db.prepare('SELECT * FROM mobile_devices WHERE clientKey = ?').get(k) ?? null;
}

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

/** 邀请码时效：故意与配对令牌同档（5 分钟）。两个数分开写迟早会漂 —— 别改成 10 分钟了事 */
export const PAIR_CODE_TTL_MS = PAIR_TOKEN_TTL_MS;

/** 同时最多压着几个没用掉的配对码（设计 §7-6：防设置页反复点刷爆表） */
const MAX_UNUSED_PAIR_TOKENS = 3;

/* ------------------------------------------------------------------ 配对令牌 */

/** 发码前清场：过期的一律删；没用掉的超过 3 个就删最老的（给新码腾位）。两代码共用 */
function prunePairTokens() {
  db.prepare('DELETE FROM mobile_pair_tokens WHERE expiresAt <= ?').run(nowIso());
  const unused = db.prepare('SELECT tokenHash FROM mobile_pair_tokens WHERE usedAt IS NULL ORDER BY createdAt').all();
  for (let i = 0; i + MAX_UNUSED_PAIR_TOKENS <= unused.length; i += 1) {
    db.prepare('DELETE FROM mobile_pair_tokens WHERE tokenHash = ?').run(unused[i].tokenHash);
  }
}

/** 一套「码 → 行」的写入（token 与 code 除了明文怎么来，别的完全一样） */
function insertPairSecret(secret, ttlMs, defaultTtl) {
  prunePairTokens();
  const expiresAt = new Date(Date.now() + Math.max(1000, Number(ttlMs) || defaultTtl)).toISOString();
  db.prepare('INSERT INTO mobile_pair_tokens (tokenHash, createdAt, expiresAt) VALUES (?, ?, ?)').run(hashOf(secret), nowIso(), expiresAt);
  return { expiresAt };
}

/**
 * 发一个一次性配对令牌（**旧版的链接里那串 `bp_…`**）。
 *
 * 2026-11-01 起手机端主路径换成 9 位邀请码（见 `createPairCode`）—— 长令牌仍留着，
 * 因为已经生成的二维码/书签地址可能还在用，核销路径完全一样，多留住一代不花钱。
 * **只存哈希**，明文只在这里回一次。
 */
export function createPairToken(ttlMs = PAIR_TOKEN_TTL_MS) {
  const token = `bp_${crypto.randomBytes(18).toString('base64url')}`;
  return { token, ...insertPairSecret(token, ttlMs, PAIR_TOKEN_TTL_MS) };
}

/** 邀请码位数（对齐向日葵/ToDesk 的"报一串数字"体感；1e9 空间 + 5 分钟 + 单次） */
const PAIR_CODE_DIGITS = 9;

/**
 * 发一个 9 位数字邀请码（2026-11-01）。
 *
 * 为什么是数字而不是再发一串随机字符串：这个码要**人念给人听 / 手打进手机**，
 * 十位以上字母数字串没人打得对。9 位数字配 `inputmode="numeric"` 就是九宫格，
 * 屏幕上按 `xxx xxx xxx` 分组显示。
 *
 * 为什么安全：5 分钟、**单次**、只存 sha256（与长令牌同一张表同一套核销 SQL）。
 * 唯一的算法差异是空间从 2^144 掉到 1e9 —— 所以核销端点必须限速
 * （routes/pair.mjs 的 E1703 闸），否则 5 分钟里 brute force 是有意义的。
 */
export function createPairCode(ttlMs = PAIR_CODE_TTL_MS) {
  /*
   * **发新码 = 旧码立刻失效**（与界面上"点「换一个」，旧码作废"的文案对齐）。
   * 语义上这不是"再发一个"，而是"换一个" —— 同时压着两三枚有效码，会让
   * "我刚才抄的是哪一个"变成一道题，也把暴力破解的空间白白放大几倍。
   */
  db.prepare('DELETE FROM mobile_pair_tokens WHERE usedAt IS NULL').run();
  // 首位非 0：显示成 xxx xxx xxx 时不会被人当成"少了一位"而删掉前导 0
  const code = String(crypto.randomInt(10 ** (PAIR_CODE_DIGITS - 1), 10 ** PAIR_CODE_DIGITS));
  return { code, ...insertPairSecret(code, ttlMs, PAIR_TOKEN_TTL_MS) };
}

/**
 * 把用户敲进来的邀请码收拾成 9 位数字：去空格 / 连字符 / 全角空格（手机输入法爱插）。
 * 不成形返回 `null` —— 路由层拿它区分"格式不对（E1701）"和"码不对（E1702）"。
 */
export function normalizePairCode(input) {
  const s = String(input ?? '').replace(/[\s\u00a0\u3000\-–—_]/g, '');
  return new RegExp(`^\\d{${PAIR_CODE_DIGITS}}$`).test(s) ? s : null;
}

/** 这枚码**现在**还能用吗（UDP 应答器用它认领「有人要找的就是我」；不做状态细分） */
export function isPairSecretLive(secret) {
  const row = getPairToken(secret);
  return !!row && !row.usedAt && row.expiresAt > nowIso();
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

/**
 * 配对成功 = 落一行设备。名字是手机自报的（UA 猜的），只截到 60 字防灌垃圾。
 *
 * `clientKey`（2026-11-01）命中已有行时**复用不新建**（返回 `reused: true`）——
 * 同一台手机重复扫码/重配，设备列表里永远只有一条。返回 `{ device, reused }`。
 */
export function createDevice(name, clientKey = null) {
  const k = cleanClientKey(clientKey);
  if (k) {
    const hit = findDeviceByClientKey(k);
    if (hit) {
      // 重配 = 这台手机重新连上了（它可能刚从「已断开」回来）
      markConnected(hit.id);
      // 名字以最新一次自报为准（UA 变了说明系统升过级，顺手刷新）
      if (String(name ?? '').trim() && hit.name !== String(name).trim().slice(0, 60)) {
        db.prepare('UPDATE mobile_devices SET name = ? WHERE id = ?').run(String(name).trim().slice(0, 60), hit.id);
        return { device: getDevice(hit.id), reused: true };
      }
      return { device: getDevice(hit.id), reused: true };
    }
  }
  const id = newId('md');
  const ts = nowIso();
  db.prepare('INSERT INTO mobile_devices (id, name, pairedAt, lastSeenAt, lastIp, clientKey) VALUES (?, ?, ?, ?, NULL, ?)').run(
    id,
    String(name ?? '').trim().slice(0, 60) || '手机设备',
    ts,
    ts,
    k,
  );
  return { device: getDevice(id), reused: false };
}

export function getDevice(id) {
  return db.prepare('SELECT * FROM mobile_devices WHERE id = ?').get(id) ?? null;
}

/** 删一行设备（只给"抢码失败"的回滚用 —— 正常的踢出走 revokeDeviceTokens，行留着给人看记录） */
export function forgetDevice(id) {
  return db.prepare('DELETE FROM mobile_devices WHERE id = ?').run(id).changes > 0;
}

/**
 * 取消配对（2026-11-01）：吊销它名下全部令牌 + **删掉设备行** —— 蓝牙式"取消配对"，
 * 列表里不再留记录。踢出（revoke）只收走钥匙、行留着；这个是连人带档案一起清。
 */
export function unpairDevice(id) {
  const revoked = revokeDeviceTokens(id);
  return { revoked, removed: forgetDevice(id) };
}

/**
 * 顶替：**同一时间只允许一台手机在用**（2026-11-01 用户定稿）。
 *
 * 新配对落定时把其它手机全部转成「已断开」（吊销令牌 + 打 disconnectedAt 标记）——
 * **不删行**：断开只是让出"在用"这个位置，那台手机以后还能凭 clientKey 连回来
 * （见 `resumeDevice`）；要连人带档案清掉是操作员点「取消配对」（`unpairDevice`）。
 *
 * 返回 `{ revoked, disconnected }` 给日志和前端提示用。
 */
export function disconnectOtherDevices(keepId) {
  let revoked = 0;
  let disconnected = 0;
  for (const d of db.prepare('SELECT id FROM mobile_devices WHERE id != ?').all(keepId ?? '')) {
    revoked += revokeDeviceTokens(d.id);
    if (markDisconnected(d.id)) disconnected += 1;
  }
  return { revoked, disconnected };
}

/**
 * **全部断开**（2026-11-02 手机连接总开关）：关掉开关那一瞬，把所有在用的手机
 * 一起踢下去 —— 吊销全部设备令牌（下次任何请求 401）+ 全部打「已断开」标记。
 * 设备行和 clientKey 都留着：重新打开开关后，各台手机凭 clientKey 自己连回来
 * （`resumeDevice`），不用重新扫码。返回 `{ revoked, disconnected }` 给日志用。
 */
export function disconnectAllDevices() {
  let revoked = 0;
  let disconnected = 0;
  for (const d of db.prepare('SELECT id FROM mobile_devices').all()) {
    revoked += revokeDeviceTokens(d.id);
    if (markDisconnected(d.id)) disconnected += 1;
  }
  return { revoked, disconnected };
}

/** 作废全部未用掉的邀请码（总开关关闭时调用 —— 关了还留活码等于没关） */
export function invalidateAllPairCodes() {
  return db.prepare('DELETE FROM mobile_pair_tokens WHERE usedAt IS NULL').run().changes;
}

/** 打上「已断开」标记（幂等：已经是断开的返回 false，不重复写库） */
export function markDisconnected(id) {
  if (!id) return false;
  return db.prepare('UPDATE mobile_devices SET disconnectedAt = ? WHERE id = ? AND disconnectedAt IS NULL').run(nowIso(), id).changes > 0;
}

/** 清掉「已断开」标记 = 连上了 */
export function markConnected(id) {
  if (!id) return false;
  return db.prepare('UPDATE mobile_devices SET disconnectedAt = NULL WHERE id = ?').run(id).changes > 0;
}

/**
 * 「断开连接」（操作员，2026-11-01）：吊销令牌 + 打标记，**行和 clientKey 都留着**。
 * 与 `unpairDevice`（取消配对，删行）成对：一个让位，一个清档。
 */
export function disconnectDevice(id) {
  const revoked = revokeDeviceTokens(id);
  return { revoked, disconnected: markDisconnected(id) };
}

/**
 * 有没有**别的**手机正占着"在用"这个位置（有有效令牌、且不是已断开）。
 * 给 `resumeDevice` 判"能不能连回来"用 —— 一台电脑同一时间只允许一台手机在用。
 */
export function findActiveOther(keepId) {
  return (
    db
      .prepare(
        `SELECT d.* FROM mobile_devices d
          WHERE d.id != ?
            AND d.disconnectedAt IS NULL
            AND EXISTS (
              SELECT 1 FROM mobile_device_tokens t
               WHERE t.deviceId = d.id AND (t.expiresAt IS NULL OR t.expiresAt > ?)
            )
          ORDER BY d.lastSeenAt DESC LIMIT 1`,
      )
      .get(keepId ?? '', nowIso()) ?? null
  );
}

/**
 * 手机自己「连回来」（2026-11-01）。凭 clientKey 认人 —— 这不是强凭据，
 * 但它是那台手机 localStorage 里的随机串，等于一张"记住我"的票；
 * 校验点在路由（免令牌端点），这里只管状态：
 *   · 自己在用 → 换新令牌（续期；旧令牌一起吊销，别在库里堆钥匙）；
 *   · 自己已断开 → 没有别的手机在用就恢复（清标记 + 发令牌）；
 *   · 自己已断开但**别的手机在用** → 返回 `{ ok:false, reason:'busy' }`，让上层报 E1705。
 * 返回 `{ ok, device, token? }`，token 明文只在这里出现一次。
 */
export function resumeDevice(deviceId) {
  const d = getDevice(deviceId);
  if (!d) return { ok: false, reason: 'unknown' };
  if (d.disconnectedAt === null && countDeviceTokens(deviceId) > 0) {
    revokeDeviceTokens(deviceId);
    return { ok: true, device: d, token: issueDeviceToken(deviceId) };
  }
  const busy = findActiveOther(deviceId);
  if (busy) return { ok: false, reason: 'busy', busyName: busy.name };
  markConnected(deviceId);
  revokeDeviceTokens(deviceId);
  return { ok: true, device: getDevice(deviceId), token: issueDeviceToken(deviceId) };
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
 *
 * `pairEnabled = false`（2026-11-02 总开关）→ 一律 null：就算有令牌因为并发
 * 之类的原因漏吊了，关着开关的手机也**一条请求都进不来**（真·拒绝所有连接）。
 */
export function deviceAuthByToken(token) {
  if (!token) return null;
  if (!readNetMode().pairEnabled) return null;
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
