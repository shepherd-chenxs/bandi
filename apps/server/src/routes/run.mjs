/* routes/run.mjs —— 2026-10-22 由 server.mjs 按域拆出，handler 逻辑原样搬运。
 * 主分发顺序（先匹配先赢）见 ../server.mjs 的 CHAIN。 */

import { sendJson, fail } from '../http.mjs';
import * as store from '../store.mjs';
import * as runs from '../runs.mjs';
import * as status from '../status.mjs';

export async function handleRun(req, res, url) {
  const stream = /^\/api\/runs\/([^/]+)\/stream$/.exec(url.pathname);
  const abort = /^\/api\/runs\/([^/]+)\/abort$/.exec(url.pathname);

  if (req.method === 'GET' && stream) {
    /*
     * 断线重连：浏览器**自动**带上 `Last-Event-ID`（= 它收到的最后一个 `id:`），
     * 原样交给 subscribe，只补发缺的那一段。
     * 改前是**全量重放** —— 每次重连都把那半段回话再追加一遍（用户看到重复）。
     */
    const ok = runs.subscribe(decodeURIComponent(stream[1]), res, req.headers['last-event-id']);
    if (!ok) fail(res, 404, 'E2035', '这次运行认不出来（不存在，或它那次进程已经没了）');
    return true;
  }

  if (req.method === 'POST' && abort) {
    const runId = decodeURIComponent(abort[1]);
    // **先记下"是人停的"**（要在 abort 之前写，子进程被掐时 promise 会立刻以异常收尾）
    const live = runs.getRun(runId);
    if (live) live.stoppedByUser = true;

    const run = runs.getRun(runId);
    if (!run) {
      // 内存里没有 = 那次进程已经不在了（重启过、或进程异常退出）。
      // ⚠️ **只收拾"库里还写着跑中"的**：正常跑完的运行会从内存里移除，
      //    但它状态已经是 完成/已停止 —— 再盖成「中断」就是篡改事实（踩过：
      //    人点了停止，结果状态显示"中断"，还把这一步永远留在「进行中」）。
      const row = store.getRunStatus(runId);
      if (row?.status === '跑中') {
        store.finishRun(runId, { status: '中断', error: '运行已不在（服务重启或进程退出）' });
        return sendJson(res, 200, { ok: true, note: '那次运行已经不在内存里了，已标记为中断' });
      }
      return sendJson(res, 200, { ok: true, note: '这次运行已经结束了' });
    }
    // 远端那次跑在**别的机器**上：这边没有子进程可掐 —— 走"下一个事件批次把话带过去"那条路
    if (run.remote) {
      runs.abortRemote(runId);
      return sendJson(res, 200, { ok: true, note: '这次跑在远端节点上，已告诉它停下' });
    }
    // requestStop = 掐子进程 + **上看门狗**：退出通知等不来（孙进程占着管道、kill 失效）
    // 就 5 秒后强制收尾，别让会话被"他还在跑上一条"永远闸死（2026-10-23 实报）
    runs.requestStop(runId);
    return sendJson(res, 200, { ok: true });
  }

  return false;
}

