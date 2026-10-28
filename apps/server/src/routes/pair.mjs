/*
 * routes/pair.mjs —— 手机配对与设备管理路由（2026-11 手机端增量）。
 *
 * 六个端点（docs/mobile/pwa-design.md §3.2）：
 *   POST /api/pair/tokens              操作员发一次性配对码（5 分钟、单次用）
 *   POST /api/pair/claim               **免令牌**（guard 豁免）：手机扫码后凭码换长期设备令牌
 *   GET  /api/pair/me                  任意已登录：我是操作员还是哪台设备
 *   GET  /api/pair/devices             操作员：已配对设备列表
 *   POST /api/pair/devices/:id/revoke  操作员：踢出一台设备（吊销它名下全部令牌）
 *   POST /api/pair/devices/:id/role    操作员：给一部手机分配面板角色（2026-10-28 第四刀）
 *   （GET /pair 落地页在 server.mjs 的非 /api 分支里，不归本文件管）
 *
 * 错误码用设计分配的 x7xx 子段：E1701/E1702（配对码缺失/无效或过期）、E2701（设备不存在）、
 * E3701（非操作员）、E4701（码已用）。写请求照过 guardWrite（CSRF 闸）——
 * 手机落地页的 fetch 自己带 X-Bandi: 1，别在这条链路上绕过它。
 */

import { sendJson, fail, readBody } from '../http.mjs';
import { port } from '../config.mjs';
import * as netmode from '../netmode.mjs';
import * as store from '../store.mjs';
import * as auth from '../auth.mjs';

export async function handlePair(req, res, url) {
  const method = req.method;
  const p = url.pathname;

  /* -------------------------------------------- 操作员：发配对码 */
  if (method === 'POST' && p === '/api/pair/tokens') {
    if (!auth.mayManage(req)) return fail(res, 403, 'E3701', '只有操作员能发手机配对码');
    let issued;
    try {
      issued = store.createPairToken();
    } catch (err) {
      // 落库失败（库被锁 / 磁盘满）按设计 §3.2 回配对模块自己的 500 码，别落进顶层 catch 的通用 E5004
      console.error('[配对] E5701 · 配对码落库失败', err);
      return fail(res, 500, 'E5701', '配对码生成失败，请重试');
    }
    const { token, expiresAt } = issued;
    /*
     * urls = netmode.lanUrls(port)：本机全部 IPv4 网卡地址（192.168 > 10 > 172 排序）。
     * 前端拿 urls[0] 画码、其余列出来可复制 —— 多网卡 IP 选取是最容易翻车的一步（PRD §5-4）。
     */
    return sendJson(res, 200, { token, expiresAt, urls: netmode.lanUrls(port) });
  }

  /* -------------------------------------------- 手机：扫码换令牌（免令牌端点） */
  if (method === 'POST' && p === '/api/pair/claim') {
    const body = await readBody(req);
    const token = String(body?.token ?? '').trim();
    // 格式不对（缺参/抄错）→ E1701；格式对但库里没有/已过期 → E1702；格式对但已被用 → E4701
    if (!/^bp_[A-Za-z0-9_-]{10,}$/.test(token)) {
      return fail(res, 400, 'E1701', '配对码缺失或格式不对 —— 请扫桌面端最新生成的二维码');
    }
    const row = store.getPairToken(token);
    if (!row) return fail(res, 400, 'E1702', '配对码无效或已过期 —— 请在桌面端重新生成二维码');
    if (row.usedAt) return fail(res, 409, 'E4701', '配对码已被使用 —— 一个码只能配一台设备');
    if (row.expiresAt <= new Date().toISOString()) {
      return fail(res, 400, 'E1702', '配对码已过期（5 分钟）—— 请在桌面端重新生成二维码');
    }
    const name = String(body?.name ?? '').trim().slice(0, 60) || '手机设备';
    /*
     * 时序（设计 §4.1）：先建设备行，再原子核销配对码（usedByDeviceId 记下是谁用的）。
     * 核销失败（并发抢码）就把刚建的设备行删掉 —— 别留一台"没换到令牌"的孤儿设备。
     */
    const device = store.createDevice(name);
    if (!store.consumePairToken(token, device.id)) {
      store.forgetDevice(device.id);
      return fail(res, 409, 'E4701', '配对码已被使用 —— 一个码只能配一台设备');
    }
    const deviceToken = store.issueDeviceToken(device.id);
    // Cookie 名沿用 bandi_token：EventSource 设不了自定义头，设备令牌靠它走 SSE（设计 §1.1）
    res.setHeader(
      'Set-Cookie',
      `bandi_token=${encodeURIComponent(deviceToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
    );
    console.log(`[配对] 手机「${device.name}」已配对（${device.id}）`);
    return sendJson(res, 200, { ok: true, deviceId: device.id, name: device.name });
  }

  /* -------------------------------------------- 任意已登录：我是谁 */
  if (method === 'GET' && p === '/api/pair/me') {
    const a = req.bandiAuth;
    if (a?.kind === 'device') {
      const d = store.getDevice(a.deviceId);
      return sendJson(res, 200, { kind: 'device', device: d ? { id: d.id, name: d.name, pairedAt: d.pairedAt } : null });
    }
    /*
     * 登录用户（2026-10-28 第三刀）：**必须单独认出来**。
     * 这一句原来只有 device / operator 两种结果 —— 一个普通村民登录后问"我是谁"，
     * 会被回成 `operator`（"我是这台机器的操作员"），谁拿它判权限谁就错了。
     * 本刀前端已统一改用 `/api/me`，这里补上是给旧调用方兜底。
     */
    if (a?.kind === 'user') {
      const u = store.getUser(a.userId);
      return sendJson(res, 200, { kind: 'user', user: u ? { id: u.id, name: u.name } : null, roleId: a.roleId });
    }
    // operator（含回环免鉴权形态标出来的 operator）
    return sendJson(res, 200, { kind: 'operator' });
  }

  /* -------------------------------------------- 操作员：设备管理 */
  if (method === 'GET' && p === '/api/pair/devices') {
    if (!auth.mayManage(req)) return fail(res, 403, 'E3701', '只有操作员能看已配对设备');
    return sendJson(res, 200, { devices: store.listDevices() });
  }

  const revoke = /^\/api\/pair\/devices\/([^/]+)\/revoke$/.exec(p);
  if (method === 'POST' && revoke) {
    if (!auth.mayManage(req)) return fail(res, 403, 'E3701', '只有操作员能踢出设备');
    const id = decodeURIComponent(revoke[1]);
    if (!store.getDevice(id)) return fail(res, 404, 'E2701', '没有这台设备');
    const n = store.revokeDeviceTokens(id);
    console.log(`[配对] 踢出设备 ${id}（吊销 ${n} 枚令牌）`);
    return sendJson(res, 200, { ok: true, revoked: n });
  }

  /* -------------------------------------------- 操作员：给手机分配面板角色 */
  /**
   * `POST /api/pair/devices/:id/role {roleId|null}`（2026-10-28 第四刀）。
   *
   * 与节点那条同构：只存总机侧一行，**下发发生在设备的下一次请求**（手机每次打开都问
   * `/api/me`，那里带 `role.menuKeys`）。所以这里同样只说"存好了"。
   * `roleId: null / ''` = 恢复默认（`mobile`：手机底部那四个 tab）。
   */
  const roleOf = /^\/api\/pair\/devices\/([^/]+)\/role$/.exec(p);
  if (method === 'POST' && roleOf) {
    if (!auth.mayManage(req)) return fail(res, 403, 'E3701', '只有操作员能给手机分配面板角色');
    const id = decodeURIComponent(roleOf[1]);
    if (!store.getDevice(id)) return fail(res, 404, 'E2701', '没有这台设备');
    const body = await readBody(req);
    const want = body?.roleId === undefined || body?.roleId === null ? '' : String(body.roleId).trim();
    if (want && !store.getRole(want)) return fail(res, 400, 'E2072', `没有这个角色：${want}`);
    const next = store.setDeviceRole(id, want || null);
    console.log(`[配对] 手机 ${id} 的面板角色改成 ${want || `默认（${store.DEFAULT_PHONE_ROLE}）`}`);
    return sendJson(res, 200, { deviceId: id, roleId: next?.roleId ?? null, role: store.roleOrDefault(next?.roleId, store.DEFAULT_PHONE_ROLE) });
  }

  return false;
}
