/*
 * security/policy.mjs —— **PDP 单入口**。
 *
 *   authorize({ who, method, pathname, rules }) → 'allow' | 错误码
 *
 * 判定顺序（顺序本身就是口径，别混）：
 *   1. 路由是否存在 —— guard 已在认证前用 isRegistered() 挡掉（404 E4090），
 *      这里对"没登记"只兜底拒绝；
 *   2. `revoked` → E4012；
 *   3. 身份种类各自的边界。
 *
 * **登录用户 = 全权**（2026-11-07）：账号全在身份中枢，能过中枢登录这一关，
 * 本机就不再有第二道分级 —— 角色/菜单权限那套已整体退场。机器身份
 * （operator / node）的边界原样保留：机器不是人，不因为"人可以全权"
 * 就跟着放宽。（`device` —— 手机配对设备令牌 —— 2026-11-07 随配对体系退场。）
 *
 * 为什么不 import auth.mjs：auth 要 import 本模块（decide 是 PDP 包装），
 * 反向引一次就是环。kind 级的归属判定（节点只认自己的端点等）由 auth.mjs
 * 通过 `rules` 注入 —— 纯函数传参，没有模块状态。
 */

import { findRoute } from './route-policy.mjs';

export function authorize({ who, method, pathname, rules = {} }) {
  if (!who) return 'allow'; // 不该发生：guard 只在 identify 到身份之后才问
  const m = String(method ?? '').toUpperCase();
  const p = String(pathname ?? '');
  const api = p.startsWith('/api/');
  const route = api ? findRoute(p, m) : null;

  if (who.kind === 'revoked') return 'E4012';

  // operator（回环 / 共享令牌）：清单内全通。清单本身在 guard 兜底（未登记 404）。
  if (who.kind === 'operator') return 'allow';

  // 登录用户：全放行（能过中枢登录这一关，本机不再有第二道分级）。
  if (who.kind === 'user') return 'allow';

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
