/* run-live.mjs —— 一轮运行的**直播回话状态机**（2026-11-08 起，聊天页 / 任务卡讨论区共用）。
 *
 * 用户口径（两次实报收口）：
 *   · 「单行气泡刷日志，显示什么不重要，重要的是在动」—— 跑着的时候界面上只该有一行在刷
 *     （进度胶囊：思考片段 / 正在跑的工具 / 阶段词），不该把中间过程一段段铺出来；
 *   · 「真正的回复出来后代替这个单行日志气泡」—— 正文是**替换**那一行，不是并排/堆叠。
 *
 * 关键取舍（2026-11-09 英文运行实报后定）：
 *   模型（尤其英文工作流）会在每次工具调用之间"解说"一句，这些 text 事件在事件流里
 *   跟真正的回复**长得一模一样**，没法提前区分。所以：**text 一律不直播**，先攒着；
 *   一旦后面又来个工具事件，说明刚才那段是中间话 → 直接丢掉；到这一轮收尾
 *   （turn_end / onDone）还没被工具事件顶掉的，才是真正的回复 —— 这时才顶掉日志行、
 *   把正文落进同一颗泡里。代价是回复不逐字流出来（收尾时整段落），换来的是"整轮只有
 *   一行在动"，这是用户明确选的那一侧。
 *
 * 用法（两处对话场景都这么接，别再各写一套）：
 *   const live = createLiveAnswer({ card, host, render: renderMarkdown, onScroll, onEnterAnswer });
 *   onEvent:  (evt) => { live.applyEvent(evt); card.applyEvent(evt); }
 *   onText:   (chunk) => live.pushText(chunk)
 *   onDone:   () => { live.flushPending(); card.finish(status); ... }
 *   onRunError: () => { live.enterAnswer(); ... }
 */
export function createLiveAnswer({ card = null, host = null, render = (s) => s, onScroll = () => {}, onEnterAnswer = null } = {}) {
  let answerMode = false; // 真正的回复已经开始：日志行已被正文顶掉
  let pending = ''; // 工具之后的正文（可能是中间话，也可能是回复）：先攒，收尾才算数

  const appendText = (chunk) => {
    if (!host) return;
    const d = document.createElement('div');
    d.className = 'step text';
    d.innerHTML = render(chunk);
    host.appendChild(d);
    onScroll();
  };

  /** 真正的回复开始：日志行（进度胶囊）消失，正文落回同一颗泡 */
  const enterAnswer = () => {
    if (answerMode) return;
    answerMode = true;
    card?.el?.remove?.();
    onEnterAnswer?.();
  };

  /** 收尾时把攒下的正文当回复画出来（纯聊天 / 最后一个工具之后的正文） */
  const flushPending = () => {
    if (!pending) return;
    const t = pending;
    pending = '';
    enterAnswer();
    appendText(t);
  };

  return {
    get answerMode() {
      return answerMode;
    },
    enterAnswer,
    flushPending,
    /** 每段正文：先攒着，不直播（见文件头"关键取舍"） */
    pushText(chunk) {
      if (answerMode) {
        appendText(chunk); // 已经进入回复态（不会再回退）：后续分块继续追加
        return;
      }
      pending += chunk;
    },
    /** 每个原始事件：中间话在"又来了工具"时作废；turn_end 到了才把攒的落成回复 */
    applyEvent(evt) {
      if (!evt) return;
      if (evt.type === 'tool' || evt.type === 'tool_call') {
        pending = ''; // 工具之前的正文是"中间话"，不是回复
        return;
      }
      if (!answerMode && evt.type === 'status' && evt.phase === 'turn_end') flushPending();
    },
  };
}
