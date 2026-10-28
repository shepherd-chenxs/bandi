/* routes/feishu.mjs —— 飞书通道的 HTTP 面（2026-10-27）。
 *
 *   GET  /api/feishu/config   配置快照（secret 只回掩码）+ 通道状态
 *   PUT  /api/feishu/config   存配置（appSecret 留空 = 保留原值）；enabled 开着就顺手把通道拉起
 *   POST /api/feishu/test     连通性测试（拿一次 tenant_access_token，不动通道状态）
 *   POST /api/feishu/start    启动通道（可重试的失败转后台重连，返回里带 status）
 *   POST /api/feishu/stop     停通道
 *
 * 错误码：本域认领 E2061–E2067（E2060 已被连接器占住，顺位往下；分段规矩见 http.mjs）。
 * 只有设置页在调，正常鉴权 + CSRF 闸就够了，不另设回环校验。
 */
import { sendJson, fail, readBody } from '../http.mjs';
import * as feishu from '../feishu.mjs';

export async function handleFeishu(req, res, url) {
  if (!url.pathname.startsWith('/api/feishu/')) return false;

  if (req.method === 'GET' && url.pathname === '/api/feishu/config') {
    return sendJson(res, 200, { ...feishu.configSnapshot(), status: feishu.channelStatus() }), true;
  }

  if (req.method === 'PUT' && url.pathname === '/api/feishu/config') {
    const body = await readBody(req);
    try {
      feishu.saveConfig({
        appId: body?.appId,
        appSecret: body?.appSecret,
        enabled: body?.enabled === true,
        allowOpenIds: body?.allowOpenIds,
        p2pPersonaId: body?.p2pPersonaId,
      });
    } catch (e) {
      return fail(res, 400, e.code ?? 'E2063', String(e.message ?? e)), true;
    }
    // 开机自启开着就顺手拉起；起不起得来进 status（界面轮询看得见），不拖住保存
    if (feishu.configSnapshot().enabled) {
      feishu.start().catch(() => { /* 状态里看 */ });
    } else {
      feishu.stop();
    }
    return sendJson(res, 200, { ...feishu.configSnapshot(), status: feishu.channelStatus() }), true;
  }

  if (req.method === 'POST' && url.pathname === '/api/feishu/test') {
    try {
      return sendJson(res, 200, await feishu.testConnection()), true;
    } catch (e) {
      return fail(res, 400, e.code ?? 'E2064', String(e.message ?? e)), true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/feishu/start') {
    try {
      const r = await feishu.start();
      return sendJson(res, 200, r), true;
    } catch (e) {
      return fail(res, 400, e.code ?? 'E2066', String(e.message ?? e)), true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/feishu/stop') {
    feishu.stop();
    return sendJson(res, 200, { ok: true, status: feishu.channelStatus() }), true;
  }

  return fail(res, 404, 'E2065', '没有这个飞书通道接口'), true;
}
