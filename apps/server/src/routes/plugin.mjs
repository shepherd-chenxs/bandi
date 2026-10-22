/* routes/plugin.mjs —— 2026-10-22 由 server.mjs 按域拆出，handler 逻辑原样搬运。
 * 主分发顺序（先匹配先赢）见 ../server.mjs 的 CHAIN。 */

import path from 'node:path';
import { sendJson, fail } from '../http.mjs';
import * as plugins from '../plugins.mjs';

export async function handlePluginAction(req, res, url) {
  const act = /^\/api\/plugins\/([^/]+)\/(install|enable|disable)$/.exec(url.pathname);

  if (req.method === 'POST' && act) {
    const id = decodeURIComponent(act[1]);
    const what = act[2];
    const r =
      what === 'install' ? plugins.install(id) : plugins.setEnabled(id, what === 'enable');
    if (r.error) return fail(res, 400, 'E1023', r.error);
    return sendJson(res, 200, { ok: true, plugins: plugins.marketList() });
  }

  // 卸载：**真删目录**（和连接器的"卸载＝删条目"对齐语义，但这里删的是文件）
  const one = /^\/api\/plugins\/([^/]+)$/.exec(url.pathname);
  if (req.method === 'DELETE' && one) {
    const r = plugins.uninstall(decodeURIComponent(one[1]));
    if (r.error) return fail(res, 400, 'E1024', r.error);
    return sendJson(res, 200, { ok: true, removed: r.path, plugins: plugins.marketList() });
  }

  return false;
}

/** 工作流：模板 → 实例 → 逐步执行 */
/**
 * 项目：**"在哪儿干活"的载体**（名字 / 主目录 / 附加根 / 项目规矩）。
 *
 * 现在只有"名字 + 目录 + 附加根 + 说明"这几件事 —— 还没跟会话/流程挂钩，
 * 那一步（让派活真的用项目目录）单独做。
 */
