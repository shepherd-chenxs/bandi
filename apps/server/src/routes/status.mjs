/* routes/status.mjs —— 2026-10-22 由 server.mjs 按域拆出，handler 逻辑原样搬运。
 * 主分发顺序（先匹配先赢）见 ../server.mjs 的 CHAIN。 */

import fs from 'node:fs';
import { sendJson, fail } from '../http.mjs';
import * as store from '../store.mjs';
import * as status from '../status.mjs';

export async function handleStatus(req, res, url) {
  if (req.method !== 'GET') return false;
  const one = /^\/api\/status\/projects\/([^/]+)$/.exec(url.pathname);
  if (!one) return false;

  const p = store.getProject(decodeURIComponent(one[1]));
  if (!p) return fail(res, 404, 'E2027', '项目不存在');
  return sendJson(res, 200, status.projectDetail(p));
}

/**
 * 列子目录，给"选目录"用。
 *
 * 浏览器出于安全**不给绝对路径**（`webkitdirectory` 只给假路径），
 * 所以目录选择只能走服务端：这里只做**只读列目录**，不读文件内容、不写任何东西。
 *
 * ⚠️ **只做"列目录"，不弹原生框**（2026-10-22 改）：原来的 `/api/fs/pick-dir` 由服务端
 * spawn PowerShell 弹 `Shell.Application.BrowseForFolder` —— 但服务端是没有窗口的后台进程，
 * 弹出来的框没有属主窗口，实测 `IsWindowVisible=false`（被最大化的桌面壳窗口整个盖住），
 * 用户只看到按钮一直转「…」。原生目录框现在归**桌面壳**：页面走 Tauri IPC 的
 * `pick_directory`（`apps/desktop/src/lib.rs`，带 owner 窗口的 IFileOpenDialog）；
 * 纯浏览器环境（`start.cmd`）退回页内浏览，也就是本接口。
 */
