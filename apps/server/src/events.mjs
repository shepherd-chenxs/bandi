/* events.mjs —— 全局事件总线：SSE `/api/events` 的源（2026-10-24）。
 *
 * 为什么要有它：跑实时流（/api/runs/:id/stream）只覆盖「你自己派的活」；像卡片回执
 * 把项目经理叫醒、他在后台往群里说话，前端**全站没有定时刷新**，开着的聊天窗口
 * 永远不知道 —— 用户在群里干等半小时看着旧画面（2026-10-24 实报）。
 * 现在消息一落库 / 会话状态一变，这里就向所有挂着的浏览器广播「哪个会话动了」。
 *
 * 章法（跟 runs.mjs 那条流学的，但比它简单）：
 *   · **不回放**。漏掉的事件靠客户端兜底：EventSource 断线自动重连，重连成功
 *     （onopen）时前端全量刷一次 —— 比「按 id 补缺口」省一套水位账，效果等价。
 *   · **叶子模块**：不 import 任何兄弟模块。埋点要埋在 store 的必经函数里
 *     （addMessage / setConversationStatus / renameConversation），谁也不许在
 *     自己的链路上另喊一嗓子 —— 漏埋一处 = 那个角落永远静默。
 */

const subs = new Set();
let seq = 0;

/** 哪个会话有动静（新消息 / 状态变了 / 改名）。写失败 = 连接已死，顺手摘掉。 */
export function emitConv(id) {
  if (!id || subs.size === 0) return;
  seq += 1;
  const frame = `id: ${seq}\ndata: ${JSON.stringify({ type: 'conv', id })}\n\n`;
  for (const res of subs) {
    try {
      res.write(frame);
    } catch {
      subs.delete(res);
    }
  }
}

/** 一个浏览器连上来（路由层已写好 SSE 头）。 */
export function addEventsSub(res) {
  subs.add(res);
  res.on('close', () => subs.delete(res));
}
