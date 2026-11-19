/* routes/status.mjs —— 2026-10-22 由 server.mjs 按域拆出，handler 逻辑原样搬运。
 * 主分发顺序（先匹配先赢）见 ./chain.mjs 的 CHAIN。 */

import { fail, sendJson } from '../http.mjs';

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

  return false;
}
