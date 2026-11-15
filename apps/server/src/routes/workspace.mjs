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
import { host, port, dataDir, trustProxy } from '../config.mjs';
import * as store from '../store.mjs';
import * as auth from '../auth.mjs';
import * as localSecret from '../security/local-secret.mjs';

/*
 * 会话票要不要（与 server.mjs 启动时**同一套输入、同一个 setup**，判定必然一致）：
 * 账号模式下系统浏览器没有会话，开文件口前要先走 /shell/enter 进门（见 /api/open）。
 * setup 里的 ensureToken 幂等 —— 启动时已经建好，这里只是复读。
 */
const AUTH = auth.setup({ host, dataDir, envToken: process.env.BANDI_TOKEN, trustProxy });

/** 候选根：这段会话里谁在干活（他们的工作目录）→ 全部项目根 → 全部员工的工作目录 */
export function candidateRoots(convId) {
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
export function resolveInRoots(rel, roots) {
  for (const r of roots) {
    const abs = path.resolve(r.abs, rel);
    if (!abs.startsWith(r.abs + path.sep)) continue; // 路径闸：不许穿出候选根
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (st.isFile()) return abs;
  }
  return null;
}

/**
 * 「替你开浏览器」只在服务真的**就在这台机器上**时才有意义。判据是**绑定的监听地址**：
 *   · `0.0.0.0` / `::` —— 所有网卡（**含回环**）：是本机，允许；
 *   · `127.*` / `::1` / `localhost` —— 回环单绑：是本机，允许；
 *   · 其它（明确的局域网/外网地址）—— 服务只长在那块网卡上，客户端多半在别的机器，
 *     替人开浏览器没有意义 → 拒（界面本来就是普通网页，自己 window.open）。
 *
 * ⚠️ 别把 `0.0.0.0` 当成"不在本机"（2026-11-14 实报）：**默认监听就是 0.0.0.0**，
 * 旧守卫只认 127.0.0.1/localhost —— 桌面端点聊天里的文件 pill → `/api/open` 全被
 * 误判成 E2060「服务不在本机」，其实服务就跑在本机。
 */
export function localBind(h) {
  const s = String(h ?? '').toLowerCase();
  return s === '0.0.0.0' || s === '::' || s === 'localhost'
    || s === '::1' || s.startsWith('127.') || s.startsWith('[::1');
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
    // 仅在服务**真的绑在某个局域网地址**上时拒：替人开浏览器发生在另一台机器，没有意义
    if (!localBind(host)) {
      return fail(res, 403, 'E2060', '服务绑在局域网地址上，不在这台机器 —— 请直接新标签打开文件地址（界面上点路径就是）');
    }
    const body = await readBody(req);
    let u;
    try { u = new URL(String(body.url ?? '')); } catch { return fail(res, 400, 'E2060', 'URL 不合法'); }
    // 只许打开指向班底自己的地址 —— 这个口子不该被借去拉任意网页/程序
    if (u.origin !== `http://127.0.0.1:${port}` && u.origin !== `http://localhost:${port}`) {
      return fail(res, 400, 'E2060', '只允许打开班底自己的地址');
    }
    const cmd = process.platform === 'win32' ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    /*
     * 账号模式下（auth.required，监听地址非回环或挂了反代），**系统浏览器没有班底的
     * 会话票** —— 直接开文件口会撞 E4010「需要登录」（2026-11-14 实报：点聊天里的
     * 文件 pill，系统浏览器拿到一坨 401 JSON）。包一层**先进门再看**：目标换成
     * `/shell/enter?secret=…&to=<目标>` —— 进门核 local_secret + 本机直连（桌面壳同一条
     * 通道）签票后 302 直达文件；这张浏览器之后都有票，再点不用再进。
     * 回环免鉴权形态（auth.required=false）不用包：本来就免登录，开了直接看。
     */
    const target = AUTH.required
      ? `http://127.0.0.1:${port}${auth.SHELL_ENTER_PATH}?secret=${encodeURIComponent(localSecret.ensure())}&to=${encodeURIComponent(u.pathname + u.search)}`
      : u.href;
    const args = process.platform === 'win32'
      ? /*
         * Windows 的 start 走 cmd 解析：**裸 `&` 是命令分隔符** —— 目标里的 `&to=…`
         * 在 & 处断掉，浏览器拿到没有 to 的进门链 → 302 回面板，用户看到的是班底
         * 网页而不是文件（2026-11-14 实报）。整段目标**自带引号**交给 start（第一个
         * 引号参数是窗口标题，所以空标题 "" 必须还在），并开 verbatim 让 Node
         * 别二次加工（无空格参数 Node 不引号，手工引号又会被它转义弄坏，实测踩过）。
         */
        ['/c', 'start', '""', `"${target}"`]
      : [target];
    const spawnOpts = { detached: true, stdio: 'ignore', windowsHide: true };
    if (process.platform === 'win32') spawnOpts.windowsVerbatimArguments = true;
    spawn(cmd, args, spawnOpts).unref();
    return sendJson(res, 200, { opened: true });
  }

  return false;
}
