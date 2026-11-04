/* routes/status.mjs —— 2026-10-22 由 server.mjs 按域拆出，handler 逻辑原样搬运。
 * 主分发顺序（先匹配先赢）见 ../server.mjs 的 CHAIN。 */

import fs from 'node:fs';
import { readBody, sendJson, fail } from '../http.mjs';
import * as store from '../store.mjs';
import * as status from '../status.mjs';

/**
 * 档案里的人名由这里查：`status.mjs` 只读文件、**不碰库**（它的用例会单独 import 它验解析器，
 * 直接引 store 会在那儿把真库打开）。查不到就是"那个人已经不在了"，由 status 那边说清楚。
 */
const nameOf = (id) => store.getPersona(id);

export async function handleStatus(req, res, url) {
  /**
   * **重启控制面**（2026-11-04）：改完「监听地址」让它落地的那一下。
   *
   * 为什么靠"自己退出"而不是原地换监听：`server.listen()` 绑过一次就不能改，
   * 原地解绑再绑会把在跑的请求 / 节点长轮询一起掐断，还不如整进程重启干净。
   *
   * **只给被监护的进程自动重启**：
   *   · systemd（`Restart=always`，且带 `INVOCATION_ID`）/ 部署单元里设了 `BANDI_SUPERVISED=1`；
   *   · 桌面窗口的看门狗（`apps/desktop/shell.mjs`，3 秒探一次）。
   * 命令行裸跑 `node server.mjs` 的没人拉，退出就真下线了 —— 那种情况 409 说清楚，
   * 让人用 `bandi restart`，别把用户的面板弄没了还找不着原因。
   */
  if (req.method === 'POST' && url.pathname === '/api/control-plane/restart') {
    const supervised = process.env.BANDI_SUPERVISED === '1' || !!process.env.INVOCATION_ID;
    if (!supervised) {
      return fail(res, 409, 'E1061', '这个控制面不是被 systemd / 桌面窗口看管的，退出就真下线了 —— 用 `bandi restart`，或者手动重启那个进程。');
    }
    sendJson(res, 202, { ok: true, restarting: true });
    console.log('[控制面] 按请求重启（监听地址等启动配置要生效）');
    setTimeout(() => process.exit(0), 300); // 先把响应发出去，再退
    return true;
  }

  /*
   * 「选择纳管哪些项目」的两个口（2026-10-27）。
   *
   * 为什么不在 `routes['GET /api/status/projects']` 上加 `?scope=all`：
   * 那张表的分发是 `routes[key](req, res)` —— **拿不到 query**，要读只能自己解 `req.url`，
   * 而且插件权限白名单是按 method+path 校验的，一个地址两种语义迟早出岔子。
   * 分开成两条路径，权限也是分开声明的：面板数据源只给「已纳管」，账本全量只给选择弹窗。
   */
  if (req.method === 'GET' && url.pathname === '/api/status/ledger') {
    const projects = store.listProjects().map((p) => {
      const card = status.projectCard(p, nameOf);
      return {
        id: card.id,
        name: card.name,
        root: card.root,
        builtIn: !!card.builtIn,
        ok: card.ok,
        status_text: card.status_text,
        panel_managed: Number(p.panelManaged) === 1,
      };
    });
    return sendJson(res, 200, { projects });
  }

  if (req.method === 'POST' && url.pathname === '/api/status/managed') {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return fail(res, 400, 'E2031', `请求体读不出来：${e?.message ?? e}`);
    }
    if (!body || !Array.isArray(body.ids)) {
      return fail(res, 400, 'E2032', 'ids 必须是项目 id 的数组（整表提交，空数组 = 全部取消纳管）');
    }
    try {
      const kept = store.setManagedProjects(body.ids);
      return sendJson(res, 200, { ids: kept, projects: status.listProjectCards(store.listManagedProjects(), nameOf) });
    } catch (e) {
      return fail(res, 500, 'E2033', `保存失败：${e?.message ?? e}`);
    }
  }

  if (req.method !== 'GET') return false;
  const one = /^\/api\/status\/projects\/([^/]+)$/.exec(url.pathname);
  if (!one) return false;

  const p = store.getProject(decodeURIComponent(one[1]));
  if (!p) return fail(res, 404, 'E2027', '项目不存在');
  return sendJson(res, 200, status.projectDetail(p, nameOf));
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
