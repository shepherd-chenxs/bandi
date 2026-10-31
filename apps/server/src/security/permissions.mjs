/*
 * security/permissions.mjs —— 权限词表（IAM §8.1，`domain:action` 两段式）。
 *
 * 纯数据模块：**不 import store、不写 SQL**（角色→权限的落库在 store/roles.mjs，
 * 查询走 store.roleHasPerm；这里只定义"世界上有哪些权限"与"粒度取舍"）。
 *
 * 粒度口径（v2 明确，别扩张）：停在「域:动作」两段，**不做按钮级** ——
 * `persona:write` 一权含"改所有员工的所有字段"，"只能动自己那摊"是 Phase 4
 * 资源 scope 的事，别指望词表承担。按钮级 perms（几百个字符串）在这个规模
 * 纯粹是维护负担，不学。
 */

/** 词表全集（smoke 用来校验 route-policy 里的 perm 拼写没打错） */
export const PERMS = Object.freeze([
  // 读
  'state:read',
  'conversation:read',
  'persona:read',
  'project:read',
  'task:read',
  'machine:read',
  'device:read',
  'collab:read',
  // 写
  'message:send',
  'persona:write',
  'project:write',
  'task:write',
  'workflow:write',
  'schedule:manage',
  'connector:manage',
  'skill:manage',
  'plugin:manage',
  'git:manage',
  'ssh:manage',
  'quota:manage',
  // 管理
  'user:manage',
  'role:manage',
  'machine:manage',
  'device:manage',
  'collab:manage',
  // 敏感（默认只有 admin，admin 隐式 * 不落库）
  'audit:read',
  'data:export',
  'data:import',
  'security:manage',
]);

const PERM_SET = new Set(PERMS);

/** 词表校验（route-policy 的 smoke 用）：拼错的 perm 一律算 bug */
export function isValidPerm(p) {
  return PERM_SET.has(String(p ?? ''));
}

/*
 * 内置角色 → 权限的**出厂预置**（IAM §8.2）。
 *
 * ⚠️ v2.6 施工口径：这一版**故意留空** —— 现有的非 admin 登录用户走的是
 * 「成员基线」（route-policy 里 `member: true` 那批路由，行为与手机白名单完全
 * 一致），如果在这里给 operator 预置一堆权限，等于一夜之间给所有"操作员"角色
 * 的账号扩权，12 个 smoke 里"普通用户摸管理接口 403"的断言会全变味。
 *
 * 所以机制先行：`role_permissions` 表 + PDP 查询已就位（`store.roleHasPerm`，
 * `POST/PATCH /api/roles/:id` 以后加 `perms` 字段就能用），预置内容等角色 UI
 * 真正管权限时再定 —— 那是一次产品决策，不是一次安全施工。
 */
export const BUILTIN_ROLE_PERMS = Object.freeze({
  operator: [],
  'node-ops': [],
  mobile: [],
});
