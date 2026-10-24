/* routes/imageai.mjs —— 生图服务的 HTTP 面（2026-10-23）。
 *
 * 四条：
 *   GET  /api/ai/image-config   读配置（key 只回掩码）
 *   PUT  /api/ai/image-config   存配置（apiKey 留空 = 保留原值）
 *   POST /api/ai/image-test     连通性测试（打 /models，不花生图的钱）
 *   POST /api/ai/image          生成一张图，落 <dataDir>/generated/，回绝对路径
 *
 * 谁在调：设置页（带正常鉴权）+ 数字员工（本机 curl，auth.mjs 对回环的
 * /api/ai/* 免令牌 —— 员工跑在 CLI 里拿不到平台令牌）。
 * 双保险：本 handler 自带回环来源校验（同 routes/local.mjs 的 P0-8），
 * 就算有人 BANDI_HOST=0.0.0.0 强开监听，局域网机器也摸不到这个通道。
 */
import { sendJson, fail, readBody, guardWrite } from '../http.mjs';
import * as imagegen from '../imagegen.mjs';

/* 与 routes/local.mjs 的 isLoopbackRemote 同判据（不跨文件引，避免路由互相依赖） */
function isLoopbackRemote(address) {
  const a = String(address ?? '').trim().toLowerCase();
  if (!a) return false;
  if (a === '::1' || a === '127.0.0.1' || a === 'localhost') return true;
  if (a.startsWith('::ffff:127.')) return true; // IPv4-mapped（Node 在双栈 socket 上会这么报）
  return a.startsWith('127.');
}

export async function handleImageAi(req, res, url) {
  if (!url.pathname.startsWith('/api/ai/')) return false;

  if (!isLoopbackRemote(req.socket?.remoteAddress)) {
    return fail(res, 403, 'E2607', 'AI 生图通道只对本机开放（数字员工与设置页用）'), true;
  }

  // 浏览器来的写请求照过 CSRF 闸；员工 curl 不带 Origin，天然放行
  const denied = guardWrite(req);
  if (denied) return fail(res, 403, 'E3001', denied);

  if (req.method === 'GET' && url.pathname === '/api/ai/image-config') {
    const cfg = imagegen.readConfig();
    return sendJson(res, 200, {
      configured: !!cfg,
      baseUrl: cfg?.baseUrl ?? '',
      model: cfg?.model ?? '',
      keyHint: cfg ? imagegen.keyHint(cfg.apiKey) : '',
    }), true;
  }

  if (req.method === 'PUT' && url.pathname === '/api/ai/image-config') {
    const body = await readBody(req);
    try {
      const next = imagegen.writeConfig(body);
      return sendJson(res, 200, { ok: true, keyHint: imagegen.keyHint(next.apiKey) }), true;
    } catch (e) {
      return fail(res, 400, e.code ?? 'E2602', String(e.message ?? e)), true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/ai/image-test') {
    try {
      return sendJson(res, 200, await imagegen.testConfig()), true;
    } catch (e) {
      return fail(res, 400, e.code ?? 'E2604', String(e.message ?? e)), true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/ai/image') {
    const body = await readBody(req);
    try {
      return sendJson(res, 200, await imagegen.generate(body)), true;
    } catch (e) {
      return fail(res, 400, e.code ?? 'E2605', String(e.message ?? e)), true;
    }
  }

  return fail(res, 404, 'E2608', '没有这个生图接口'), true;
}
