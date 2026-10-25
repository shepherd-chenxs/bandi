/* routes/prefs.mjs —— 平台偏好（2026-10-24）。
 *
 * 目前只有一项：回复风格（设置 → 偏好 → 回复风格）。这是**雇主的沟通偏好**，
 * 不是哪个员工的能力：选了非默认风格，派活时全员注入对应技能（见 dispatch.stylePrefBlock）。
 *
 *   GET /api/prefs          { replyStyle, styles: [{id, label}] }
 *   PUT /api/prefs          body { replyStyle } → 存进 config.json，下一轮派活就生效
 */

import { sendJson, fail, readBody } from '../http.mjs';
import { REPLY_STYLES, replyStyle, writeReplyStyle } from '../config.mjs';

export async function handlePrefs(req, res, url) {
  if (url.pathname !== '/api/prefs') return false;

  if (req.method === 'GET') {
    return sendJson(res, 200, {
      replyStyle: replyStyle(),
      styles: REPLY_STYLES.map(({ id, label }) => ({ id, label })),
    });
  }

  if (req.method === 'PUT') {
    const body = await readBody(req);
    const id = String(body?.replyStyle ?? '').trim();
    if (!REPLY_STYLES.some((x) => x.id === id)) {
      return fail(res, 400, 'E1060', `回复风格只能是：${REPLY_STYLES.map((x) => `「${x.label}」`).join(' / ')}`);
    }
    return sendJson(res, 200, { ok: true, replyStyle: writeReplyStyle(id) });
  }

  return false;
}
