/* routes/workspace.mjs —— 工作区文件的两个小口子（2026-10-24）。
 *
 * 起因（主理人原话）："员工有产出，要我去目录里找，这个很难受。" 员工在聊天里报的
 * 是**相对路径**（如 design/v1.0.1/06-project-members.html），人得自己去目录里翻。
 * 这里把两件事补上：
 *
 *   ① GET /api/workspace/file —— 把员工报的路径解析成真文件、按扩展名回内容。
 *      会话本身不挂项目（群聊/单聊没有 projectId），员工报的路径相对的是**他干活的
 *      目录**，所以候选根按"谁在这个会话里干活"来猜：会话成员的工作目录 → 全部
 *      项目根 → 全部员工的工作目录，第一个命中的为准。路径闸死在候选根内（防穿越）。
 *      `probe=1` 时只探存在性不回内容（前端把消息里的路径 pill 点亮用，别为扫一遍
 *      消息把文件全拉一遍）。
 *
 *   ② POST /api/open —— 服务端拉起**系统默认浏览器**打开班底自己的地址。
 *      为什么是服务端开而不是 window.open：桌面壳的 webview 对新窗口/外链的拦截
 *      各有一套，服务端 `start/open/xdg-open` 一条路全平台通吃 —— 前提是**服务就在
 *      本机**（回环）。服务在别的机器（局域网形态）时这个口子直接拒绝：那台机器
 *      开浏览器没有意义，客户端自己 window.open 即可（此时它本来就是普通网页）。
 *
 * 错误码顺位：E2060（open 相关）/ E2061（参数缺）/ E2062（文件没找到）。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { sendJson, fail, readBody, mimeOf } from '../http.mjs';
import { host, port } from '../config.mjs';
import * as store from '../store.mjs';

/** 候选根：这段会话里谁在干活（他们的工作目录）→ 全部项目根 → 全部员工的工作目录 */
function candidateRoots(convId) {
  const roots = [];
  const push = (r) => {
    const dir = String(r ?? '').trim();
    if (!dir) return;
    const norm = path.resolve(dir).toLowerCase();
    if (roots.some((x) => x.norm === norm)) return;
    roots.push({ norm, abs: path.resolve(dir) });
  };
  const conv = convId ? store.getConversation(convId) : null;
  for (const m of conv?.members ?? []) push(m.cwd);
  push(conv?.personaCwd);
  for (const p of store.listProjects()) for (const r of store.projectRoots(p)) push(r);
  for (const p of store.listPersonas()) push(p.cwd);
  return roots;
}

/** 在候选根里解析员工报的相对路径：命中（且是真文件、没穿出根）返回绝对路径 */
function resolveInRoots(rel, roots) {
  for (const r of roots) {
    const abs = path.resolve(r.abs, rel);
    if (!abs.startsWith(r.abs + path.sep)) continue; // 路径闸：不许穿出候选根
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (st.isFile()) return abs;
  }
  return null;
}

export async function handleWorkspace(req, res, url) {
  /* ------------------------------------------------ ① 工作区文件读取 */
  if (req.method === 'GET' && url.pathname === '/api/workspace/file') {
    const rel = String(url.searchParams.get('path') ?? '').trim();
    if (!rel) return fail(res, 400, 'E2061', '要说 path —— 员工报的那个相对路径');
    const convId = url.searchParams.get('conv');
    const probe = url.searchParams.get('probe') === '1';

    const abs = resolveInRoots(rel, candidateRoots(convId));
    if (!abs) return fail(res, 404, 'E2062', `工作区里没有这个文件：${rel} —— 员工报的路径可能相对别的目录，或文件还没落地`);

    // 只探存在性（前端点亮路径 pill 用，不为扫一遍消息把文件全拉一遍）
    if (probe) return sendJson(res, 200, { found: true });

    const buf = fs.readFileSync(abs);
    const headers = { 'Content-Type': mimeOf(abs), 'Cache-Control': 'no-store' };
    // HTML/SVG 是能跑脚本的文档：关进不透明源（与 /api/files 的 uploads 同一个口径），
    // 员工产出的设计稿照样渲染，但碰不到班底本体的接口
    if (/\.(html?|svg)$/i.test(abs)) headers['Content-Security-Policy'] = 'sandbox allow-scripts';
    res.writeHead(200, headers);
    res.end(buf);
    return true;
  }

  /* ------------------------------------------------ ② 系统浏览器打开 */
  if (req.method === 'POST' && url.pathname === '/api/open') {
    // 仅本机模式：服务在别的机器上时，"替你打开"发生在那台机器，没有意义
    if (host !== '127.0.0.1' && host !== 'localhost') {
      return fail(res, 403, 'E2060', '服务不在本机 —— 请直接新标签打开文件地址（界面上点路径就是）');
    }
    const body = await readBody(req);
    let u;
    try { u = new URL(String(body.url ?? '')); } catch { return fail(res, 400, 'E2060', 'URL 不合法'); }
    // 只许打开指向班底自己的地址 —— 这个口子不该被借去拉任意网页/程序
    if (u.origin !== `http://127.0.0.1:${port}` && u.origin !== `http://localhost:${port}`) {
      return fail(res, 400, 'E2060', '只允许打开班底自己的地址');
    }
    const cmd = process.platform === 'win32' ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', u.href] : [u.href];
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return sendJson(res, 200, { opened: true });
  }

  return false;
}
