/* routes/feishu.mjs —— 飞书通道的 HTTP 面，**员工级**（2026-10-29 用户定稿：
 * 一个数字员工对应一个飞书自建应用，入口在员工详情 › 配置 › 飞书；设置里的飞书分节已删）。
 *
 *   GET  /api/personas/:id/feishu       配置快照（secret 只回掩码）+ 通道状态
 *   PUT  /api/personas/:id/feishu       存配置（appSecret 留空 = 保留原值）；enabled 开着顺手把通道拉起
 *   POST /api/personas/:id/feishu/test  连通性测试（拿一次 tenant_access_token，不动通道状态）
 *   POST /api/personas/:id/feishu/start 启动该员工的通道（可重试的失败转后台重连，返回里带 status）
 *   POST /api/personas/:id/feishu/stop  停该员工的通道
 *
 * 旧的平台级 /api/feishu/* 四条**已删**（2026-10-29），别处打过来会落到通用的 404 E2036。
 * 错误码：本域认领 E2061–E2067（E2060 已被连接器占住，顺位往下；分段规矩见 http.mjs）。
 * 挂载在 handlePersona 同层：handlePersona 的正则只吃到 /api/personas/:id 的**子路径动作**
 * （/open /skills /tasks…），带 /feishu 后缀的路径它不认，这里不会被抢（挂载顺序纪律见 group.mjs）。
 */
import { sendJson, fail, readBody } from '../http.mjs';
import * as store from '../store.mjs';
import * as feishu from '../feishu.mjs';

/** 基路径 + 可选动作；认不得的动作在本域回 E2065，不漏给通用 404 */
const FEISHU_OF = /^\/api\/personas\/([^/]+)\/feishu(?:\/([^/]+))?$/;

export async function handleFeishu(req, res, url) {
  const m = FEISHU_OF.exec(url.pathname);
  if (!m) return false;
  const id = decodeURIComponent(m[1]);
  const action = m[2] ?? '';

  if (!store.getPersona(id)) return fail(res, 404, 'E2008', '员工不存在'), true;

  if (req.method === 'GET' && !action) {
    return sendJson(res, 200, { ...feishu.personaConfigSnapshot(id), status: feishu.personaChannelStatus(id) }), true;
  }

  if (req.method === 'PUT' && !action) {
    const body = await readBody(req);
    try {
      feishu.savePersonaConfig(id, {
        appId: body?.appId,
        appSecret: body?.appSecret,
        enabled: body?.enabled === true,
        allowOpenIds: body?.allowOpenIds,
      });
    } catch (e) {
      return fail(res, 400, e.code ?? 'E2063', String(e.message ?? e)), true;
    }
    // 开机自启开着就顺手拉起；起不起得来进 status（界面轮询看得见），不拖住保存。
    // 凭据换了的话 savePersonaConfig 已把旧通道停了，这里的 start 会用新凭据重连
    if (feishu.personaConfigSnapshot(id).enabled) {
      feishu.startPersona(id).catch(() => { /* 状态里看 */ });
    } else {
      feishu.stopPersona(id);
    }
    return sendJson(res, 200, { ...feishu.personaConfigSnapshot(id), status: feishu.personaChannelStatus(id) }), true;
  }

  if (req.method === 'POST' && action === 'test') {
    try {
      return sendJson(res, 200, await feishu.testPersonaConnection(id)), true;
    } catch (e) {
      return fail(res, 400, e.code ?? 'E2064', String(e.message ?? e)), true;
    }
  }

  if (req.method === 'POST' && action === 'start') {
    try {
      const r = await feishu.startPersona(id);
      return sendJson(res, 200, r), true;
    } catch (e) {
      return fail(res, 400, e.code ?? 'E2066', String(e.message ?? e)), true;
    }
  }

  if (req.method === 'POST' && action === 'stop') {
    feishu.stopPersona(id);
    return sendJson(res, 200, { ok: true, status: feishu.personaChannelStatus(id) }), true;
  }

  return fail(res, 404, 'E2065', '没有这个飞书通道接口'), true;
}
