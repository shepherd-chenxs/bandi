/* events.mjs —— 全局事件流（SSE /api/events）的前端半边（2026-10-24）。
 *
 * 背景：前端全站没有定时刷新，只有「自己派的活」接实时流 —— 卡片回执把项目经理
 * 叫醒、他在后台往群里说话，开着的窗口永远不知道，用户干等半小时看旧画面。
 *
 * 规矩：
 *   · **一条连接管全站**：服务端推「哪个会话动了」，这里分诊 ——
 *     开着的会话 → 重开它（openConversation 会顺手重画左栏；要是那动静是
 *     「后台起了个 run」，重开时会自己接上实时流 attachStream）；
 *     别的会话 → 只刷列表（load() 防抖 1.5s，红点/最后一条/状态就都有了）。
 *   · **自己正盯着的 run 不打扰**：S.running = 已经接着 /api/runs/:id/stream，
 *     它的 onDone 自己会重开会话；这时再来 conv 事件只管列表。
 *     （不拦的话，重开画面的同时会把流式到一半的气泡抹掉 —— 那段文字还没落库。）
 *   · **断线靠重连兜底**：EventSource 自动重连，onopen（首连 + 每次重连成功）
 *     全量刷一次 —— 服务端不回放全局事件，漏掉的靠这一把补齐。
 *   · 弹窗开着就不动画面（跟通讯录轮询同一条纪律），晚一拍再试。
 */

import { load } from './state.mjs';
import { openConversation } from './chat.mjs';
import { S } from './core.mjs';

let es = null;
let openTimer = null;   // 重开当前会话的防抖（600ms：一轮 run 收尾会连发好几条事件）
let listTimer = null;   // 刷列表的防抖

function refreshOpenConv() {
  if (S.running) return;                       // 自己的 run 自己收尾，别插手
  if (document.querySelector('dialog[open]')) return; // 弹窗里不动底层画面
  const id = S.conversation?.id;
  if (!id) return;
  // 会话可能正好被删（另一个窗口）：静默，openConversationSafe 那套报错会打扰人
  openConversation(id).catch(() => {});
}

function refreshList() {
  if (document.querySelector('dialog[open]')) {
    listTimer = setTimeout(refreshList, 2500);  // 弹窗里先别刷，晚一拍再试
    return;
  }
  load().catch(() => {});
}

export function startEvents() {
  if (es) return;
  es = new EventSource('/api/events');
  es.onopen = () => {
    // 首连和每次重连都全量刷一把：断线期间漏的事件不用补账，一把追平
    load().catch(() => {});
    refreshOpenConv();
  };
  es.onmessage = (e) => {
    let evt;
    try {
      evt = JSON.parse(e.data);
    } catch {
      return;
    }
    if (evt?.type !== 'conv' || !evt.id) return;
    if (evt.id === S.conversation?.id) {
      clearTimeout(openTimer);
      openTimer = setTimeout(refreshOpenConv, 600);
    } else {
      clearTimeout(listTimer);
      listTimer = setTimeout(refreshList, 1500);
    }
  };
  // onerror 什么都不做：EventSource 自己会重连，重连成功 onopen 会追平
}
