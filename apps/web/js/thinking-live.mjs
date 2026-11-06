/* thinking-live.mjs —— 思考过程**直播块**（对话气泡里那块弱化的灰字区）。
 *
 * 背景（2026-11-04 用户实报）："开了思考过程，这个看着怎么有点乱" —— 原来
 * chat.mjs 的 onThinking 每段思考就 add 一行「· 思考：…」，模型的原始思维流
 * 一段就是好几句（自我对话、中英夹杂、同一件事想两遍），四五段整段摞在进度卡
 * 下面，把回话正文都顶走了。
 *
 * 现在的形状：
 *   · 明面上只铺**最新一段**（每来一段就换一段，不一块一行地糊）；
 *   · 换下来的段折成一行「已思考 N 段 · 展开」，想查细节再点开；
 *   · 整块小字灰色（样式见 style.css 的 .think），不跟回话抢眼。
 * 思考不落库（timelineOf 不渲染它），这块只活在直播里 —— 跑完 300ms 整页重画
 * 自然就没了，所以不用管收尾定格。
 *
 * 用法：
 *   const think = createThinkingLive();
 *   host.appendChild(think.el);
 *   think.push(text);            // 每个 thinking 事件喂一次（事件即一段完整思考）
 * 谁要接：chat.mjs 在用；流程实例节点对话（flowpages.mjs）也走同一条 streamRun，
 * 想显示思考的照这个样子接一份即可。
 */
export function createThinkingLive() {
  const el = document.createElement('div');
  el.className = 'think';
  el.innerHTML = `
    <button type="button" class="think-toggle" hidden></button>
    <div class="think-blocks" hidden></div>
    <div class="think-now"></div>`;

  const toggleEl = el.querySelector('.think-toggle');
  const blocksEl = el.querySelector('.think-blocks');
  const nowEl = el.querySelector('.think-now');

  let count = 0; // 已收到的段数（含正铺在明面上的这段）
  let open = false;
  let nowText = ''; // 明面上那段的**原文**（不带行头 —— 行头只是渲染时加的）

  toggleEl.addEventListener('click', () => {
    open = !open;
    blocksEl.hidden = !open;
    paintToggle();
  });

  const paintToggle = () => {
    const folded = count - 1; // 折起来的 = 除明面上那段以外的
    toggleEl.hidden = folded < 1;
    toggleEl.textContent = folded < 1 ? '' : `已思考 ${folded} 段 · ${open ? '收起' : '展开'}`;
  };

  /** 一段完整思考进来：明面上那段归档进折叠区，新段顶上来 */
  const push = (text) => {
    const t = String(text ?? '').trim();
    if (!t) return;
    if (nowText) {
      const prev = document.createElement('div');
      prev.className = 'think-block';
      prev.textContent = nowText;
      blocksEl.appendChild(prev);
    }
    nowText = t;
    // 沿用旧的「· 思考：」行头 —— 换的只是正文，人不用重新认这是什么东西
    nowEl.textContent = '· 思考：' + t;
    count++;
    paintToggle();
  };

  return { el, push };
}
