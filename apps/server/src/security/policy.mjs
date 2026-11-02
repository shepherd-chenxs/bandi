/*
 * security/policy.mjs —— **PDP 单入口**（IAM §8.4）。
 *
 *   authorize({ who, method, pathname, rules, roleHasPerm }) → 'allow' | 错误码
 *
 * 判定顺序（顺序本身就是口径，别混）：
 *   1. 路由是否存在 —— guard 已在认证前用 isRegistered() 挡掉（404 E4090），
 *      这里对"没登记"只兜底拒绝；
 *   2. `revoked` → E4012；
 *   3. 身份种类（operator / device / user / compute / panel）各自的边界；
 *   4. 非 admin 登录用户 = **成员基线（member）∪ role_permissions（perm）**；
 *   5. 免密 admin 的受限会话（E4098 白名单，§8.6）。
 *
 * 为什么不 import auth.mjs：auth 要 import 本模块（decide 变成 PDP 包装），
 * 反向引一次就是环。kind 级的归属判定（节点只认自己的端点等）由 auth.mjs
 * 通过 `rules` 注入 —— 纯函数传参，没有模块状态。
 *
 * `decide()` / `mayManage()` 保留为兼容包装（§8.4）；Phase 2 之后路由层
 * 不再新增对它们的直接依赖。
 */

import { findRoute } from './route-policy.mjs';

/**
 * 受限会话白名单（§8.6）：免密 admin 在服务器形态能走的全部接口。
 * 独立成常量 —— smoke 直接对着它断言，别在两个地方各写一份字面量。
 */
export const RESTRICTED_OPEN = Object.freeze([
  { method: 'GET', path: '/api/me' },
  { method: 'GET', path: '/api/state' },
  { method: 'GET', path: '/api/skills' },
  { method: 'GET', path: '/api/web-version' },
  { method: 'POST', path: '/api/me/password' },
]);

export function authorize({ who, method, pathname, rules = {}, roleHasPerm }) {
  if (!who) return 'allow'; // 不该发生：guard 只在 identify 到身份之后才问
  const m = String(method ?? '').toUpperCase();
  const p = String(pathname ?? '');
  const api = p.startsWith('/api/');
  const route = api ? findRoute(p, m) : null;

  // 免密 admin 的受限会话（§8.6）：放最前面 —— 它连管理员接口都摸不到，
  // 别让后面的 admin 直通把这条旁路掉。
  if (who.kind === 'user' && who.restricted) {
    const open =
      (!api && (m === 'GET' || m === 'HEAD')) // 静态资源：不然页面根本起不来
      || RESTRICTED_OPEN.some((r) => r.method === m && r.path === p);
    return open ? 'allow' : 'E4098';
  }

  if (who.kind === 'revoked') return 'E4012';

  // operator（回环 / 共享令牌）：清单内全通。清单本身在 guard 兜底（未登记 404）。
  if (who.kind === 'operator') return 'allow';

  // 手机设备：白名单制（device 标记 ⊆ 成员基线，但语义上设备只认 device 那批）
  if (who.kind === 'device') {
    if (!api) return m === 'GET' || m === 'HEAD' ? 'allow' : 'E4033';
    return route?.device ? 'allow' : 'E4033';
  }

  /*
   * 登录用户（2026-10-28 第三刀 + Phase 2 收编）：
   *   · admin → 全放行（管理员没有"做不了"这回事）；
   *   · 其余 → **成员基线 ∪ role_permissions**。基线 = `member: true` 的路由
   *     （行为与 v2.5 的 deviceMayReach 白名单完全一致）；`perm` 权限由
   *     role_permissions 表解锁（§8.2），admin 隐式 `*` 不查表。
   */
  if (who.kind === 'user') {
    if (who.admin) return 'allow';
    if (!api) return m === 'GET' || m === 'HEAD' ? 'allow' : 'E4033';
    if (route?.member) return 'allow';
    if (route?.perm && typeof roleHasPerm === 'function' && roleHasPerm(who.roleId, route.perm)) return 'allow';
    return 'E4033';
  }

  /*
   * 节点令牌（kind:'node'，scope ∈ {compute, panel}）：compute 只许"自己的活"
   * （归属判定在 auth.mjs 的 rules 里 —— 那两条要查库对 nodeId，不是纯路径判断）。
   * scope 常量值 = 'compute' / 'panel'（store/nodes.mjs），这里用字面量避免 import
   * store 把数据库拖进纯逻辑模块（与 local-policy 同一口径）。
   */
  if (who.kind === 'node') {
    const scope = who.scope instanceof Set ? who.scope : new Set(['compute']);
    if (scope.has('compute')) {
      const reach =
        !!route?.compute
        && (typeof rules.nodeMayReach === 'function' && rules.nodeMayReach(who.nodeId, m, p)
          || typeof rules.runMayReach === 'function' && rules.runMayReach(who.nodeId, m, p));
      if (reach) return 'allow';
    }
    if (scope.has('panel')) {
      if (route?.noPanel) return 'E4032';
      if (typeof rules.touchNodeUsed === 'function') rules.touchNodeUsed(who.nodeId); // 「最近使用」60 秒节流
      return 'allow';
    }
    return 'E4031';
  }

  return 'E4031';
}
