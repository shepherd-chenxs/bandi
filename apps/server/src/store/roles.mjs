/*
 * store/roles.mjs —— 角色与「角色 → 菜单」关系（2026-10-28 第二刀）。
 *
 * 两张表，SQL 全在本文件（仓库规矩：SQL 只出现在 store/ 里）：
 *   · `roles`      —— 角色本体（id / name / builtin / 时间戳）
 *   · `role_menus` —— 角色能看见哪些菜单 key（多对多，主键去重）
 *
 * **内置角色的口径（产品定死的，别在别处再判一遍）**：
 *   · `admin`（管理员）：菜单**不落库**，读取时恒等于目录全集 —— 目录以后加 key，
 *     管理员自动拥有。这是防锁死的锁：谁也不能把管理员自己关在门外。
 *   · `operator`（操作员）：预置「面板」那五个 key。
 *   · `node-ops`（节点运维）：预置「节点配置」那六个 key —— 也是**节点机的默认角色**。
 *   · `mobile`（手机，2026-10-28 第四刀）：预置手机底部那四个 tab —— **手机的默认角色**。
 *   · 四个都 `builtin=1`：**不可删**；`admin` 连名字和菜单都不给改（路由层回 E2070）。
 *
 * seed 是**幂等**的：只在角色不存在时插入（连它的预置菜单一起），存在就一个字节都不动 ——
 * 否则用户改过菜单，下次重启就被刷回出厂值（那是"我的配置白改了"的经典事故）。
 */

import { db, newId, nowIso } from './db.mjs';
import { allMenuKeys, sortMenuKeys } from '../menus.mjs';

/* ------------------------------------------------------------------ 建表 */

/*
 * 建表放在域模块里而不是 db.mjs（跟 schedules 那些不同）：这两张表 2026-10-28 才出现，
 * 且只有本模块碰它们。`IF NOT EXISTS` + 主键，重复启动无害。
 * `createdAt/updatedAt` 给 TEXT（ISO 串），跟全库其它表一个口径。
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS roles (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    builtin   INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT,
    updatedAt TEXT
  );

  CREATE TABLE IF NOT EXISTS role_menus (
    roleId  TEXT NOT NULL,
    menuKey TEXT NOT NULL,
    PRIMARY KEY (roleId, menuKey)
  );
`);

/* ------------------------------------------------------------------ seed */

/**
 * **默认角色**（2026-10-28 第四刀）：设备没被分配角色时用它。
 *
 * 口径只有这一处（`roleOrDefault` 读它），别在路由里再写字面量 ——
 * "未分配 = 默认"与"角色被删了也回落默认"必须是同一个答案。
 *   · 节点机 → `node-ops`（节点运维，六个分节全看）
 *   · 手机   → `mobile`（手机，四个 tab）
 */
export const DEFAULT_NODE_ROLE = 'node-ops';

export const DEFAULT_PHONE_ROLE = 'mobile';

/** 四个内置角色；菜单只在**新建这一行时**写一次（已有角色不覆盖） */
const SEEDS = [
  { id: 'admin', name: '管理员', builtin: 1, menuKeys: null }, // null = 全集，不落库
  { id: 'operator', name: '操作员', builtin: 1, menuKeys: ['messages', 'contacts', 'experts', 'workbench', 'settings'] },
  {
    id: DEFAULT_NODE_ROLE,
    name: '节点运维',
    builtin: 1,
    menuKeys: ['node.connection', 'node.machine', 'node.runtimes', 'node.access', 'node.data', 'node.about'],
  },
  /*
   * 手机（2026-10-28 第四刀）：手机端本来就只有底部四个 tab（工作台 / 通讯录 / 会话 / 我的），
   * 所以默认角色的 key 就是那四个 —— **没分配 = 与今天完全一样**。
   */
  { id: DEFAULT_PHONE_ROLE, name: '手机', builtin: 1, menuKeys: ['messages', 'contacts', 'workbench', 'settings'] },
];

export function seedBuiltinRoles() {
  let created = 0;
  for (const s of SEEDS) {
    const had = db.prepare('SELECT id FROM roles WHERE id = ?').get(s.id);
    if (had) continue; // 已有：名字/菜单都不动（用户可能改过）
    const ts = nowIso();
    db.prepare('INSERT INTO roles (id, name, builtin, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)').run(
      s.id,
      s.name,
      s.builtin,
      ts,
      ts,
    );
    if (Array.isArray(s.menuKeys)) {
      const ins = db.prepare('INSERT OR IGNORE INTO role_menus (roleId, menuKey) VALUES (?, ?)');
      for (const k of sortMenuKeys(s.menuKeys)) ins.run(s.id, k);
    }
    created += 1;
  }
  return created;
}

seedBuiltinRoles();

/* ------------------------------------------------------------------ 读 */

/** 管理员恒等于目录全集（不查库）—— 这条是防锁死的锁，别为了"一致性"把它也落了库 */
const ADMIN_ID = 'admin';

function menuKeysOf(role) {
  if (role.id === ADMIN_ID) return allMenuKeys();
  const rows = db.prepare('SELECT menuKey FROM role_menus WHERE roleId = ?').all(role.id);
  return sortMenuKeys(rows.map((r) => r.menuKey));
}

function shape(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    builtin: !!row.builtin,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
    menuKeys: menuKeysOf(row),
  };
}

/** 全部角色（内置在前、按 seed 顺序；自建在后、按创建顺序） */
export function listRoles() {
  /*
   * 排序口径：`builtin DESC`（内置永远排前面，用户新建的接在后面）+ `createdAt ASC`
   * （= seed / 创建顺序；按名字排会让"管理员"跑到第二行去，看着像列表乱序）。
   */
  const rows = db.prepare('SELECT * FROM roles ORDER BY builtin DESC, createdAt ASC, id ASC').all();
  return rows.map(shape);
}

export function getRole(id) {
  return shape(db.prepare('SELECT * FROM roles WHERE id = ?').get(String(id ?? '')));
}

/**
 * 「这个设备该用哪个角色」的**唯一答案**（2026-10-28 第四刀）。
 *
 *   · 没分配（`roleId` 空）→ 默认角色（节点 → `node-ops`；手机 → `mobile`）；
 *   · 分配了但角色被删了 → **也回落默认**（删角色有 E2071 拦着，但那是产品规则，
 *     不能指望它兜住"历史数据 / 手工改库"—— 回落到默认至少设备还能用）；
 *   · 连默认角色都不在（库被人清过）→ `null`，前端据此"不限制"（宁可多显示，别白屏）。
 *
 * 回的形状就是心跳与 `/api/me` 里那个 `panelRole` / `role`：`{ id, name, menuKeys }`。
 */
export function roleOrDefault(roleId, fallbackId) {
  const want = String(roleId ?? '').trim();
  const role = (want ? getRole(want) : null) ?? getRole(fallbackId);
  if (!role) return null;
  return { id: role.id, name: role.name, menuKeys: Array.isArray(role.menuKeys) ? role.menuKeys : [] };
}

/** 名字是否已被别人占用（`exceptId` = 改名时排除自己；大小写与首尾空白都算同一个名字） */
export function roleNameTaken(name, exceptId = null) {
  const target = String(name ?? '').trim().toLowerCase();
  if (!target) return false;
  return db
    .prepare('SELECT id, name FROM roles')
    .all()
    .some((r) => String(r.name).trim().toLowerCase() === target && r.id !== exceptId);
}

/* ------------------------------------------------------------------ 写 */

function writeMenus(roleId, keys) {
  db.prepare('DELETE FROM role_menus WHERE roleId = ?').run(roleId);
  const ins = db.prepare('INSERT OR IGNORE INTO role_menus (roleId, menuKey) VALUES (?, ?)');
  for (const k of sortMenuKeys(keys)) ins.run(roleId, k);
}

/** 建一个自建角色（`builtin` 恒 0；menuKeys 传空数组 = 什么都看不到，合法） */
export function createRole({ name, menuKeys = [] } = {}) {
  const id = newId('role');
  const ts = nowIso();
  db.prepare('INSERT INTO roles (id, name, builtin, createdAt, updatedAt) VALUES (?, ?, 0, ?, ?)').run(
    id,
    String(name ?? '').trim(),
    ts,
    ts,
  );
  writeMenus(id, menuKeys);
  return getRole(id);
}

/**
 * 改角色。`name` / `menuKeys` 任选（不传就不动）。
 *
 * **内置保护不在这里**：admin 不可改由路由层回 E2070（那是产品规则，不是数据完整性）。
 * 本函数只保证"传了 menuKeys 就整份替换"，不做部分合并 —— 勾选界面本来就是整份提交。
 */
export function updateRole(id, fields = {}) {
  const cur = db.prepare('SELECT * FROM roles WHERE id = ?').get(String(id ?? ''));
  if (!cur) return null;
  const hasName = fields.name !== undefined;
  const hasMenus = fields.menuKeys !== undefined;
  if (hasName) {
    db.prepare('UPDATE roles SET name = ?, updatedAt = ? WHERE id = ?').run(String(fields.name).trim(), nowIso(), cur.id);
  }
  if (hasMenus) {
    if (cur.id === ADMIN_ID) return getRole(cur.id); // 兜底：管理员菜单不落库，传了也当没传
    writeMenus(cur.id, fields.menuKeys);
    db.prepare('UPDATE roles SET updatedAt = ? WHERE id = ?').run(nowIso(), cur.id);
  }
  return getRole(cur.id);
}

/**
 * 删角色。`{ ok, reason }`：`missing`（没有这个 id）/ `builtin`（内置不许删）/ 成功 `{ok:true}`。
 *
 * 为什么内置保护在这里而不是只在路由层：删除是不可逆的，**两条入口都别指望对方记得**。
 */
export function deleteRole(id) {
  const row = db.prepare('SELECT id, builtin FROM roles WHERE id = ?').get(String(id ?? ''));
  if (!row) return { ok: false, reason: 'missing' };
  if (row.builtin) return { ok: false, reason: 'builtin' };
  db.prepare('DELETE FROM role_menus WHERE roleId = ?').run(row.id);
  db.prepare('DELETE FROM roles WHERE id = ?').run(row.id);
  return { ok: true, id: row.id };
}
