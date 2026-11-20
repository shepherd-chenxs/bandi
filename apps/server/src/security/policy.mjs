/*
 * security/policy.mjs —— **PDP 单入口**。
 *
 *   authorize({ who, method, pathname }) → 'allow' | 错误码
 *
 * 判定顺序（顺序本身就是口径，别混）：
 *   1. 路由是否存在 —— guard 已在认证前用 isRegistered() 挡掉（404 E4090），
 *      这里对"没登记"只兜底拒绝；
 *   2. 身份种类各自的边界。
 *
 * **登录用户 = 全权**（2026-11-07）：账号全在身份中枢，能过中枢登录这一关，
 * 本机就不再有第二道分级 —— 角色/菜单权限那套已整体退场。
 *
 * **身份只剩两种**（2026-11-20）：`user`（人，含"本机钥匙 → 机主"）与 `run`（一轮活）。
 * `operator` 已下线 —— 它不是权限边界，只是"机器凭据"的另一个名字；能做的事登录用户
 * 都能做，留着它只会让人以为存在一道事实上不存在的闸。
 * （`device` 手机配对令牌 2026-11-07 退场；`node` 节点令牌 2026-11-09 随多机子系统删除。）
 *
 * 为什么不 import auth.mjs：auth 要 import 本模块（decide 是 PDP 包装），
 * 反向引一次就是环。
 */

import { findRoute } from './route-policy.mjs';

export function authorize({ who, method, pathname }) {
  if (!who) return 'allow'; // 不该发生：guard 只在认出身份之后才问
  const m = String(method ?? '').toUpperCase();
  const p = String(pathname ?? '');
  const api = p.startsWith('/api/');
  const route = api ? findRoute(p, m) : null;

  // 人：全放行（能过中枢登录这一关，本机不再有第二道分级）。
  if (who.kind === 'user') return 'allow';

  /*
   * 运行钥匙（kind:'run'，2026-11-08 补）：数字员工进程拿"工作证"调平台专用口。
   * 它不是人、也不是机器主人 —— 只许清单里标了 `run: true` 的那几扇门（建卡通道 +
   * 只读台账）；其余一律 E4034。边界刻意收在**清单标记**上：要开新口子就去
   * route-policy 显式标 `run: true`，而不是来这里写 if。
   */
  if (who.kind === 'run') {
    if (route?.run) return 'allow';
    return 'E4034';
  }

  // 兜底拒绝：identify()/会话兜底之外不该有别的身份，落到这里一律不许过。
  return 'E4031';
}
