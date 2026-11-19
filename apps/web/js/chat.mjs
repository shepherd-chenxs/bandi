/* chat.mjs —— 进对话、发消息、输入框里的 @ 选人、员工详情、员工详情 →「任务」、关联技能。
 * 2026-10-22 由 app.js（15537 行单文件）拆出，原生 ESM、无打包器；逻辑逐字搬运。 */
import { esc, mdRender, roleNameOf, savePlace, setRoute, toast } from './shell.mjs';
import { AVATAR_FILE, api, createCombo, cut, dt, failHtml, headerBadgeHtml, initial, personaAvatar, personaByName, post, renderMarkdown, setHeaderBadge, smAvatar } from './ui.mjs';
import { load, setNav } from './state.mjs';
import { confirmDo } from './machine.mjs';
import { convDisplayName, openConversationSafe, toastConvErr } from './listmenu.mjs';
import { detailSave, refreshDeptSuggest, renderList, showView } from './contacts.mjs';
import { COL_STATUS, openProjectDetail, openTaskCardDialog, prPillOf } from './projects.mjs';
import { openFlowRun, setListTitle } from './flowpages.mjs';
import { openChatLogDrawer, openGroupDrawer } from './groups.mjs';
import { closeDrawer, fireExpert } from './experts.mjs';
import { $, S, statusText } from './core.mjs';
import { registerLayer } from './navstack.mjs';
import { SANDBOX_LABEL, sandboxItems } from './misc.mjs';
// 运行进度：纯逻辑在 run-progress.mjs（冒烟在 Node 里测）；画卡片这一层在 run-progress-card.mjs
// （对话页 / 任务卡讨论区共用同一份，2026-10-29 用户："对话里的那一套搬过来用"）
import { fmtElapsed } from './run-progress.mjs';
import { createProgressCard } from './run-progress-card.mjs';
import { createLiveAnswer } from './run-live.mjs';



/* -------------------------------------------------------------- 进对话 */

/**
 * 输入框里的「权限」选择。
 * 注意：班底的权限是**员工级**的字段（跟员工详情里那个是同一个），
 * 不是像 DSH 那样按会话存 —— 所以这里改的是这个员工的所有对话，界面上也说清楚。
 * 群里每个人权限不同，放一个假的没意义，直接不放。
 */
/**
 * 权限下拉的选项：**跟随员工默认** + 运行时支持的那几个权限。
 * 默认项是"收回提权"的入口 —— 提权最怕的就是忘了收回，所以必须有一键还原。
 */

/*
 * 输入框的两颗选择器搬去 composer-pickers.mjs（2026-11-19）：这里 import 一份给本文件用，
 * 再原样导出 —— flowpages.mjs 等 import 的是 './chat.mjs'，路径与名字都不变（barrel）。
 */
import { renderComposerPerm, renderComposerModel, readModelList, modelItems } from './composer-pickers.mjs';
export {
  permItems,
  convPermCombo,
  groupPermCombo,
  renderComposerPerm,
  MODEL_LIST_TTL_MS,
  modelListCache,
  readModelList,
  modelItems,
  convModelCombo,
  renderComposerModel,
} from './composer-pickers.mjs';




/* ------------------------------------------------ 上下文占用环（2026-11-12） */

/*
 * 输入区那颗 20px 圆环：**真实上下文 ÷ 模型窗口**（2026-11-12 改对口径）。
 *
 * 服务端给的 turn 是"最后一调的输入"、window 是模型自报的窗口（如 95 万），
 * 都来自 Codex 自己的会话转录（context-probe.mjs）；探不到时服务端退回旧口径
 * （perTurnTokens ÷ maxTurnTokens），环照样能画，只是数字偏大。
 * 为什么数由服务端给（GET /api/conversations/:id/context）：轮换判据（member_sessions、
 * usage）全在服务端 —— 前端自己从 runs 猜，口径一定跟 dispatch 走样。
 * 刷新点：进会话（openConversation）+ 每轮跑完的整页重画（stop() 里那个 openConversation），
 * 所以环天然跟着每轮更新；轮换发生后环归零，用户能"看见"换过会话。
 * 阈值色：≥70% --warn 黄、≥90% --bad 红（样式在 style.css 的 .cring 段）。
 */
const RING_CIRC = 2 * Math.PI * 8;

/** 33000 → '3.3万'；100000 → '10万' —— 环心与弹层都按"万"说，跟预算模块同一口径 */
const wan = (n) => (n / 10000).toFixed(1).replace(/\.0$/, '') + '万';

function ringHtml() {
  // 环心不放数字（2026-11-12 用户：不要百分比，通过环能看出来）—— 精确值在 hover 弹层里
  return `<svg viewBox="0 0 20 20" aria-hidden="true">
      <circle class="cring-track" cx="10" cy="10" r="8" fill="none" stroke-width="2.5"/>
      <circle class="cring-val" cx="10" cy="10" r="8" fill="none" stroke-width="2.5"/>
    </svg>
    <div class="cring-tip"><div class="t-main"></div><div class="t-sub"></div></div>`;
}

function paintContextRing(d) {
  const el = $('ctxRing');
  if (!el) return;
  el.innerHTML = ringHtml();
  el.classList.remove('is-hidden', 'warn', 'bad');
  const val = el.querySelector('.cring-val');
  val.style.strokeDasharray = RING_CIRC;
  const tip = el.querySelector('.cring-tip');
  const main = tip.querySelector('.t-main');
  const sub = tip.querySelector('.t-sub');
  // 分母优先用模型真实窗口（服务端探测到才有）；探不到退回预算里的 maxTurnTokens
  const max = Number(d.usage?.window) || Number(d.budget?.maxTurnTokens) || 0;
  if (!d.session?.active) {
    // 这段还没有自己的 CLI 会话（没派过活 / 刚轮换清掉了）：环空着，说清"下一轮从零开始"
    val.style.strokeDashoffset = RING_CIRC;
    main.textContent = '还没有在跑的会话';
    sub.textContent = '下一轮会新开一条，上下文从零开始';
    return;
  }
  const turn = Number(d.usage?.turn) || 0;
  const pct = max > 0 ? Math.min(100, Math.round((turn / max) * 100)) : 0;
  val.style.strokeDashoffset = RING_CIRC * (1 - pct / 100);
  const lv = pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : '';
  if (lv) el.classList.add(lv);
  main.textContent = `单轮上下文 ${wan(turn)} / ${wan(max)}`;
  main.style.color = lv === 'bad' ? 'var(--bad)' : lv === 'warn' ? 'var(--warn)' : '';
  sub.textContent =
    pct >= 90 ? '上下文即将满，将自动开新会话'
    : pct >= 70 ? '上下文偏满，重要结论先落到消息里'
    : `满 ${wan(max)} 自动换新会话，交接最近消息`;
}

async function refreshContextRing(conv) {
  const el = $('ctxRing');
  if (!el || !conv?.id) return;
  const convId = conv.id;
  el.classList.add('is-hidden');
  try {
    const d = await api('/api/conversations/' + encodeURIComponent(convId) + '/context');
    // 回来时可能已经换了会话：环是"当前正开着这段"的，别把 A 的画到 B 上
    if (S.conversation?.id !== convId) return;
    if (!d?.target) return; // 没有目标人（解散的群等）：环保持藏
    paintContextRing(d);
  } catch { /* 拿不到就藏着 —— 环是锦上添花，不能因为它报错 */ }
}



/**
 * 输入区的显隐。没选会话时收起来 —— 那时候敲字也发不出去，
 * 摆一个能打字、按了没反应的输入框是误导。
 */
export function setComposer(on) {
  const box = document.querySelector('.composer');
  if (box) box.classList.toggle('is-hidden', !on);
  const h = $('hint');
  if (h) {
    h.classList.toggle('is-hidden', !on);
    if (!on) h.textContent = '';
  }
}



/**
 * 只读输入区（2026-10-20）：**员工已删** 或 **群已解散** 的会话只能看历史、不能再聊。
 *
 * 为什么不是"藏起输入区"：藏了之后用户只会以为界面出问题了，还得自己猜为什么发不了。
 * 置灰 + 一句说明最直接。同时把权限/模型那几个工具收起 —— 人都没了，那些设置没有意义。
 *
 * `reason` 决定那句说明：`'gone'`（默认，员工已删）/ `'dissolved'`（群已解散）。
 * 两句话都只说明"为什么发不出去"，不复述记录还在不在 —— 记录就在上面看得见。
 */
export const READONLY_WHY = {
  gone: '这个员工已删除，只能查看聊天记录',
  dissolved: '这个群已解散，只能查看聊天记录',
};


/*
 * 输入框占位文案：手机上完全不显示 —— 屏幕本来就小，胶囊里还垫着
 * 一句提示词很难看（2026-11-04 用户要求去掉，含忙态的"他还在说…"）；桌面只留「说点什么…」
 * —— 括号里的说明也摘了（2026-11-15 用户实报）：@ 与发送键的用法靠输入框教不完，
 * 真要用的时候自然会发现。isNarrowPh 导出给 projects.mjs（议题聊天）与 flowpages.mjs（节点聊天）用同一把尺子。
 */
export const isNarrowPh = () => window.matchMedia('(max-width: 900px)').matches;

const phChat = () => (isNarrowPh() ? '' : '说点什么…');


export function setComposerReadonly(on, reason = 'gone') {
  const box = document.querySelector('.composer');
  const input = $('input');
  const send = $('send');
  const h = $('hint');
  if (box) box.classList.toggle('is-readonly', on);
  if (input) {
    input.disabled = on;
    input.placeholder = on ? READONLY_WHY[reason] ?? READONLY_WHY.gone : phChat();
  }
  if (send) send.disabled = on;
  if (h) {
    if (on) {
      h.classList.remove('is-hidden');
      h.textContent = READONLY_WHY[reason] ?? READONLY_WHY.gone;
    } else if (Object.values(READONLY_WHY).includes(h.textContent)) {
      // 换到一段能聊的会话：把上一次的只读说明擦掉（不然它会一直挂在那儿）。
      // 只认这两句文案 —— hint 还兼职"几秒后自己消失"的临时提示，别把人家的字擦了
      h.textContent = '';
    }
  }
}



/* ------------------------------------------------ 未读红点（已移除） */

/*
 * 消息列表头像右上角的未读红点已按用户要求去掉（2026-11-17，contacts.mjs 画行处
 * 有说明）。原来养着它的「本设备已读账本」—— localStorage `bandi.seenConvs` 记
 * "这个设备最后看到每个会话的什么时候"，markConvSeen 进会话时记一笔、convUnread
 * 画行时查 —— 只有红点这一个消费者，账本随之拆除。服务端会话本来就没有已读字段，
 * 以后若要重做未读，先想清楚这笔账记在哪。
 */

export async function openConversation(id) {
  setRoute('conversation', { id });
  // 换会话/刷新视图时，先把上一次的事件流停掉
  closeMentionPop();
  if (S.es) { S.es.close(); S.es = null; }
  S.running = false;
  // 换会话清空没发出去的文字草稿 —— 别把 A 会话说了一半的话带到 B 会话（附件同理，见 resetAtts）。
  // 只在**真换了**会话时才清：同一段会话跑完的自动重开（收尾 300ms 后）不能把人正打着的字抹掉。
  if (S.conversation?.id !== id) $('input').value = '';

  // 真换了会话才无条件滚到底（换会话是新语境，人预期看到最新一条）；
  // 同一段会话的重画（run 收尾 300ms / 全局事件）走贴底状态机 —— 翻着历史时不拽（见 drawMessages）。
  const switched = S.conversation?.id !== id;
  const d = await api('/api/conversations/' + encodeURIComponent(id));
  S.conversation = d.conversation;
  // 这段会话是不是**一个字都没说过**（详情页「发消息」连点复用它，见 openDirectChat）。
  // 依据是服务端刚给的 messages，不是本地猜测 —— 零额外请求、刷新后结论一致。
  S.convEmpty = (d.messages || []).length === 0;
  savePlace();         // 记下正在看哪个会话，刷新后回到这儿
  setComposer(true);   // 有会话了，输入区才出来
  resetAtts();         // 换会话清掉没发出去的附件 —— 别把 A 会话的图带到 B 会话
  S.persona = S.personas.find((p) => p.id === d.conversation.personaId) || S.persona;
  /*
   * 员工已删的会话：**只能看、不能聊**（2026-10-20 用户要求）。
   * 这类会话不再归档、就留在消息列表里，点进来是只读的历史记录 —— 人没了，
   * 发出去也没人接，所以输入框置灰 + 一句说明，而不是让人敲完才发现发不出去。
   */
  const personaGone =
    d.conversation.kind !== 'group' && !(S.personas ?? []).some((p) => p.id === d.conversation.personaId);
  /*
   * 群已解散（2026-10-20 用户定）：**历史照旧留在消息列表里，点进来只读**。
   * 解散时成员关系与群助手都清了，发出去也没人能接 —— 跟"员工已删"同一个处理：
   * 输入框置灰 + 一句说明，而不是让人敲完才撞 409（E2049）。
   */
  const dissolved = d.conversation.kind === 'group' && !!d.conversation.dissolvedAt;
  setComposerReadonly(personaGone || dissolved, dissolved ? 'dissolved' : 'gone');
  // 「续 @」胶囊跟着会话走：进群聊看有没有记着的人，进私聊自动藏（见 applyStickyMention）
  renderStickyMention();
  // 换到别的会话时，抽屉里那套群成员设置就不再适用了。
  // 但**同一个群换一段会话**不该关：群设置是群级的，抽屉里看的就是这个群。
  if (S.drawerOpen && S.drawerThreadId !== id && S.drawerThreadId !== d.conversation.groupId) closeDrawer();
  // 进了对话就不算"在看群详情页"了（左侧列表高亮要跟着走）
  S.groupThreadId = null;

  const isGroup = d.conversation.kind === 'group';
  /*
   * 页头徽章只画结果态（完成/停止/失败）：跑中不画（2026-11-11 用户：
   * 「对方正在输入去掉，因为下面有了思考过程」）。同源逻辑在 ui.mjs 的 headerBadgeHtml。
   */
  const badge = headerBadgeHtml(d.conversation.status);
  /*
   * 窄屏下聊天头自己带一个返回按钮（2026-11 用户要求）：
   * 返回、人名、新会话/聊天记录要挤在**同一行**，所以通用返回栏
   * （mobile.mjs 的 .mb-backbar）在聊天页让位 —— 见 mobile.css 的 body.mb-chat。
   */
  const mbBackBtn = document.body.classList.contains('mb-narrow')
    ? '<button type="button" class="mb-back mb-chat-back" aria-label="返回列表">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>' +
      '</button>'
    : '';

  if (isGroup) {
    /*
     * 解散的群：成员名单已经清空（`members` 是空数组），再写 "0 人" 就是噪音；
     * 改标「已解散」，并且**不给群设置入口** —— 成员/群名/助手都没了，点开只能是空抽屉。
     * 「聊天记录」照旧留着：解散后它可能就是唯一能翻历史的入口（列表里只显示这一行）。
     */
    /*
     * 人数跟在群名后面、同一行（2026-11-05 用户：「群人数显示在群名后面，不要折行」）。
     * 上一版把人数另起一行当副标题 —— 群聊头凭空高出一截，跟单聊头（一行名字）不齐。
     * 现在一行四样：群名 + 人数 + 徽章 + 动作钮。不换行靠的是「只有群名可收缩」：
     * .head-name 是 flex:0 1 auto + 省略号截断，人数/徽章 flex:none（见 mobile.css §16.8），
     * 名字再长也只挤自己，把人数和徽章保住；实在窄到放不下时，先截名字。
     */
    const metaSub = dissolved ? '已解散' : `${d.conversation.members.length} 人`;
    // 关联项目不再上群头（2026-11-15 用户实报）：一行里有群名/人数/徽章/动作钮，
    // 名牌是第四样东西挤群名；要看/换项目走群设置的「关联项目」行，入口不变。
    $('chatHead').innerHTML = `
      ${mbBackBtn}
      <div class="meta">
        <div><b class="head-name-static">${esc(d.conversation.title)}</b> <span class="sub">${metaSub}</span> ${badge}</div>
      </div>
      ${dissolved ? '' : `<button class="icon-btn" id="toGroupSet" title="群设置">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
      </button>`}
      <button class="icon-btn" id="toNewConv" title="给这个群开一段新会话（一次任务一段；旧段留在聊天记录里）">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 11.5c0 3.3-3.6 6-8 6-1.2 0-2.3-.2-3.3-.6L4 19l1.2-3.4C4.4 14.6 4 13.1 4 11.5c0-3.3 3.6-6 8-6s8 2.7 8 6z" />
          <path d="M12 9v5M9.5 11.5h5" />
        </svg>
      </button>
      <button class="icon-btn" id="toChatLog" title="聊天记录">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3.6 12a8.4 8.4 0 1 0 2.6-6.1" />
          <path d="M3.6 4.6V10H9" />
          <path d="M12 8v4.4l3 1.8" />
        </svg>
      </button>`;
    /*
     * 群设置入口（2026-11-19 用户：改回**按钮**，群名不再可点）：
     * 之前（2026-11-05）把它挪到群名上，是为了给手机省一颗钮；现在用户点名要独立按钮，
     * 群名恢复成纯标题（head-name-static，无热区、无手型），齿轮放在动作钮最左。
     * 解散的群不开抽屉（点开是空抽屉），所以按钮不输出，名字同样不可点。
     */
    if (!dissolved) $('toGroupSet').onclick = () => openGroupDrawer(d.conversation);
    // 群聊天记录（2026-10-20 用户要求）：抽屉列出这个群的会话（含被「不显示」的那条）
    $('toChatLog').onclick = () => openChatLogDrawer(d.conversation);
    // 新会话（2026-10-24）：解散的群开不了（服务端 E2049），按钮也不给
    if (!dissolved) $('toNewConv').onclick = () => startFreshConversation(d.conversation);
  } else {
    /*
     * 名字取法：员工还在 → 用他现在的名字（可能改过，personaName 来自 JOIN）；
     * 员工已删 → personaName 是 NULL，**不能回落到 S.persona**（那是上一个人的名字，
     * 会张冠李戴），退回这段会话自己的标题（convDisplayName 会剥掉「和 」前缀，
     * 不然页头会出现「和 和贺韬」这种叠字）；连标题都没有才写「员工已删」。
     * 头像同理：员工没了就别给「点进员工详情」的入口（点开是 404）。
     *
     * 群头/单聊头都不再放头像（2026-11-11 用户要求）：
     * 「查看TA的资料」的入口在**名字**上（data-detail 委托），头像只是重复的一颗装饰。
     */
    const name = convDisplayName(d.conversation);
    $('chatHead').innerHTML = `
      ${mbBackBtn}
      <div class="meta">
        <div>${personaGone
          ? `<b>${esc(name)}</b>`
          : `<b class="head-name" data-detail="${esc(d.conversation.personaId)}" title="查看TA的资料">${esc(name)}</b>`} ${badge}</div>
      </div>
      ${/* 右侧本来还有一句「正在干活 / 现在闲着」（2026-11-05 用户要求去掉）：
             它和名字在同一条线右端，名字稍长就被推到换行；忙闲在列表的点里已经能看出来，
             聊天页真正要占这条线的是两颗动作钮。 */ ''}
      ${personaGone ? '' : `<button class="icon-btn" id="toNewConv" title="和TA另起一段全新会话 —— 不带之前的上下文；旧会话留在聊天记录里">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 11.5c0 3.3-3.6 6-8 6-1.2 0-2.3-.2-3.3-.6L4 19l1.2-3.4C4.4 14.6 4 13.1 4 11.5c0-3.3 3.6-6 8-6s8 2.7 8 6z" />
          <path d="M12 9v5M9.5 11.5h5" />
        </svg>
      </button>`}
      <button class="icon-btn" id="toChatLog" title="聊天记录">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3.6 12a8.4 8.4 0 1 0 2.6-6.1" />
          <path d="M3.6 4.6V10H9" />
          <path d="M12 8v4.4l3 1.8" />
        </svg>
      </button>`;
    // 名字是详情的唯一入口（2026-11-11 头像整颗撤掉后）：桌面上点名字也进详情
    $('chatHead').querySelectorAll('[data-detail]').forEach((el) => {
      el.onclick = () => openDetail(d.conversation.personaId);
    });
    // 聊天记录（2026-10-20 落地）：右侧抽屉列出这个人的全部会话，点一条就回看/续聊
    $('toChatLog').onclick = () => openChatLogDrawer(d.conversation);
    // 新会话（2026-10-24）：员工都没了，开了也没人接 —— 不给按钮
    if (!personaGone) $('toNewConv').onclick = () => startFreshConversation(d.conversation);
  }

  /*
   * 窄屏：聊天头自带的返回按钮接上"回列表"（走 mobile.mjs 的自定义事件，
   * 避免 chat.mjs 反向 import mobile.mjs 造成循环依赖），并给 body 打 mb-chat ——
   * mobile.css 靠它把通用返回栏藏掉，一行装下 返回/人名/操作。
   */
  const mbBack = $('chatHead').querySelector('.mb-chat-back');
  if (mbBack) {
    mbBack.onclick = () => document.dispatchEvent(new Event('mb-back'));
    document.body.classList.add('mb-chat');
  }

  renderComposerPerm(d);
  renderComposerModel(d);
  refreshContextRing(d.conversation); // 上下文占用环：进会话刷一次；每轮跑完 stop() 会重开本函数，自动跟更

  // 把 `runs` 一起给它：失败的运行在库里**没有消息**，只画 messages 就会"说了句话然后没了"
  drawMessages(d.messages, d.conversation.personaName || '', isGroup, d.runs, { forceScroll: switched });
  const last = d.runs[0];
  // 把这次运行的**开始时间**一起带过去：刷新/重进会话时，"已跑多久"要按真实起点算，
  // 不能从"我打开这一页"开始算（用户 2026-10-26 要看的就是"跑了多久、到哪一步"）
  if (last && last.status === 'running') attachStream(last.id, last.personaName, last.startedAt, last.lastEventAt);
  renderList();
}

/**
 * 聊天页头「新会话」（2026-10-24）：另起一段全新的，旧段留在聊天记录里不删。
 *   · 单聊 → POST /api/conversations（服务端对单聊**总是新建**，复用是前端「回到聊天」自己的逻辑）；
 *   · 群   → POST /api/groups/:id/sessions（群本来就是"一次任务一段"）。
 * 新段对员工是全新上下文：身份与技能会重新注入，他不记得上一段聊过什么 —— 这正是"新会话"的意义。
 * 口径：点列表/回到聊天 = 续旧；这颗按钮 = 起新。
 */
async function startFreshConversation(c) {
  try {
    const conv = c.kind === 'group'
      ? (await post('/api/groups/' + encodeURIComponent(c.groupId) + '/sessions', {})).conversation
      : (await post('/api/conversations', {
          personaId: c.personaId,
          title: '和 ' + ((S.personas ?? []).find((p) => p.id === c.personaId)?.name ?? convDisplayName(c)),
        })).conversation;
    // openConversationSafe：这段可能刚被另一个窗口删掉（E2047）—— 那边会说人话并收拾界面
    await openConversationSafe(conv.id);
    if (S.conversation?.id !== conv.id) return;
    await load();
    $('input').focus();
  } catch (err) { toastConvErr(err); }
}

/* ------------------------------------------------ 员工报的产出路径 → 可点 */

/*
 * 员工在聊天里报产出只给相对路径（"你打开 design/v1.0.1/06-project-members.html 看一眼"），
 * 人得自己去目录里翻 —— 主理人 2026-10-24 原话："这个很难受"。
 * 这里把消息里**真实存在**的文件路径点亮成可点：点击用系统浏览器打开（本机模式走
 * /api/open；局域网模式服务在别的机器，直接新标签 —— 见 routes/workspace.mjs）。
 *
 * 侦测规则（宁缺毋滥，代码 pill 满天飞）：行内代码（非代码块）、无空格、以扩展名结尾，
 * 且含 / 或属于常见文档扩展名。存在性由服务端裁决（probe=1 只探不拉），结果按
 * (会话, 路径) 缓存 —— 同一路径不反复探。
 */
const FILE_PILL_CACHE = new Map();   // `${convId}|${path}` → true/false
const FILE_EXT_RE = /\.(html?|png|jpe?g|gif|webp|svg|pdf|md|txt|log|csv|xml|ya?ml|css|mjs|js|json)$/i;

function looksLikeFilePath(t) {
  if (!t || t.length > 200 || /\s/.test(t)) return false;
  if (!/\.[A-Za-z0-9]{1,6}$/.test(t)) return false;
  return t.includes('/') || FILE_EXT_RE.test(t);
}

/** 点亮一个 pill：挂点击 + 可点样式 */
function markFilePill(el) {
  el.dataset.file = '1';
  el.title = '点开看（系统浏览器）';
  el.onclick = () => openFilePath(el.textContent.trim());
}

/** 打开：本机模式让服务端拉系统浏览器；局域网模式自己开新标签 */
async function openFilePath(p) {
  const convId = S.conversation?.id;
  const url = location.origin + '/api/workspace/file?path=' + encodeURIComponent(p)
    + (convId ? '&conv=' + encodeURIComponent(convId) : '');
  const local = location.hostname === '127.0.0.1' || location.hostname === 'localhost';
  try {
    if (local) await post('/api/open', { url });
    else window.open(url, '_blank', 'noopener');
  } catch (e) { toast(e.message, 'error'); }
}

/** 扫一遍聊天里还没检查过的行内代码，把真实文件路径点亮 */
function linkifyFilePaths() {
  const convId = S.conversation?.id;
  if (!convId) return;
  for (const el of document.querySelectorAll('#chat code:not([data-file-checked])')) {
    el.dataset.fileChecked = '1';
    if (el.closest('pre')) continue;                       // 代码块里的不是路径
    const text = el.textContent.trim();
    if (!looksLikeFilePath(text)) continue;
    const key = convId + '|' + text;
    if (FILE_PILL_CACHE.get(key)) { markFilePill(el); continue; }
    if (FILE_PILL_CACHE.has(key)) continue;                // 已探过：不存在
    api(`/api/workspace/file?path=${encodeURIComponent(text)}&conv=${encodeURIComponent(convId)}&probe=1`)
      .then(() => { FILE_PILL_CACHE.set(key, true); markFilePill(el); })
      .catch(() => FILE_PILL_CACHE.set(key, false));
  }
}

// 消息一动就扫一遍：发消息插入、重画、流式收尾全走 #chat 的 childList —— 一个观察者全兜住。
// 只挂 childList（markFilePill 改的是属性），扫描自身不会触发自己。
new MutationObserver(() => linkifyFilePaths())
  .observe(document.getElementById('chat'), { childList: true, subtree: true });



/** 消息时间戳：`2026-10-19 14:42`（带年月日 —— 2026-10-19 用户要求；聊天可能跨天，只有时分看不出哪天） */
export function stampOf(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch {
    return '';
  }
}



/** 真人昵称（2026-11-09 昵称全端生效）：按 senderUserId 从名册（S.users）取昵称；
 *  没带 id / 没设 / 查无此人 → ''。只管显示 —— 「是不是自己」仍按 senderUserName（账号名）认。 */
const senderNickOf = (m) =>
  m?.senderUserId ? String((S.users ?? []).find((u) => u.id === m.senderUserId)?.nickname ?? '') : '';

export function bubble(role, text, name, who, showName = false, at = '', atts = null, meta = null, senderName = null, opts = null) {
  /*
   * 真人署名（2026-10-31 用户概念落地）：消息带 senderUserName 且**不是自己** → 按别人画
   * （靠左、带头像、名字线）。多人一套班底时，群/卡评论区里谁说的话各归各；
   * 没有署名（员工、回执）或就是自己 → 行为与从前一字不差。
   */
  const otherHuman = role === 'user' && senderName && senderName !== (S.me?.name ?? '我');
  const mine = role === 'user' && !otherHuman;
  // 昵称全端生效（2026-11-09 用户："昵称不能只在我的页面里生效"）：别人的署名按昵称画
  // （调用方从名册解析好放 opts.senderNick），认人仍按账号名 —— 上面那行一个字没动。
  const label = mine ? '我' : otherHuman ? (opts?.senderNick || senderName) : (who || name || '数字员工');
  // 头像带图（2026-10-22）：优先按名字找员工；群聊消息有 personaName 直接命中，
  // 1:1 改过名时名字可能对不上，再兜一层会话的 personaId。
  // 2026-11-19：调用方有 personaId 时直接给对象（opts.persona）—— 同名员工不会串人。
  const p = mine ? null
    : (opts?.persona
      ?? personaByName(label)
      ?? (S.conversation?.personaId ? S.personas.find((x) => x.id === S.conversation.personaId) ?? null : null));
  // 时间放在气泡**外面**的下方（2026-10-19 用户要求，别塞在气泡里）：绝对定位，不占布局
  const t = at ? stampOf(at) : '';
  // 群聊显示名字时，名字放气泡**上面**（2026-10-23 用户要求，别挤在气泡里）：
  // 名字行 + 气泡包进一个纵向列，其余消息保持原结构不动。
  // 别的真人的消息在 1:1 里也带名字线 —— 不然他跟数字员工的气泡分不出来。
  const nameLine = (showName && !mine) || otherHuman ? `<div class="who-line">${esc(label)}</div>` : '';
  // 附件（2026-10-23）：图片直接画缩略图，其余文件给一颗可点的 chip（新标签页打开）
  const attsHtml = attsHtmlOf(atts);
  // 卡票（2026-10-24）：PM 建卡 / 卡片回执这类消息带 meta，气泡里画一张可点的票。
  // 2026-11-15 起分两种形态（meta.mentionFirst）：文本在前、卡票在后 ——
  // 派活卡 "@执行人"、回执卡 "@建卡人 请验收"（2026-11-16）；没标的维持票在前、说明在后。
  const ticket = cardTicketHtml(meta, at);
  const ticketAfter = meta?.mentionFirst === true;
  /*
   * 老回执（2026-11-16）：库里以前的可见回执是「【卡片回执】…」开头的一长串机器话，
   * 现在新回执只写 "@建卡人 请验收" + 卡票。历史消息不刷库 —— 这类只画卡票、
   * 不画那串文字，跟新消息一个观感（卡票上标题/状态/执行人都在，信息没丢）。
   * 只认带 card meta 的，避免误伤正文里恰好提到"卡片回执"的普通消息。
   */
  const legacyReceipt = meta?.type === 'card' && /^【(卡片|子卡)回执】/.test(String(text ?? '').trim());
  /*
   * 停止生成（2026-10-29 用户实报「点停止生成，对方的消息完全消失」）：
   * 人停的那一轮，回话是**掐在半句上**的（服务端带 meta.stopped 落库，见 runs.mjs 的 persistReply）。
   * 不标一下，隔天翻记录的人会以为他就说了这么多 —— 标在气泡底部，比在时间线里另起一行轻。
   */
  const stoppedNote = meta?.stopped ? '<div class="bubble-note">已停止生成</div>' : '';
  /*
   * 点头像速改运行时/模型（2026-11-19 用户："群聊里面点击人物头像，要打开一个人物弹窗，
   * 在这个弹窗里可以更改运行时和模型"）—— 模型额度用完了不必退出聊天去通讯录详情。
   * 只有认得出数字员工（p）的头像可点；「我」的头像没有配置项，保持原样。
   */
  const avBase = mine ? smAvatar('我', 'me') : smAvatar(label, '', p);
  /*
   * 手机端不要这枚简卡（2026-11-19 用户：「手机端不需要员工简卡」）。
   * 判据同 mobile.mjs 的 body.mb-narrow（启动即置，渲染时已可靠，见 mobile.mjs:36）。
   * 手机端头像就是头像 —— 不渲染 button：省掉一个按下去什么都不会发生、
   * 读屏还会念「查看运行时与模型」的死入口。点击委托那边另兜一层，
   * 防窗口从宽拖窄 / 旋屏后 DOM 里还留着上一版按钮。
   */
  const phone = document.body.classList.contains('mb-narrow');
  const avHtml = !mine && p && !phone
    ? `<button type="button" class="av-peer" data-peer="${esc(p.id)}" title="换运行时 / 模型"
         aria-label="查看 ${esc(label)} 的运行时与模型">${avBase}</button>`
    : avBase;
  /*
   * 空回话（2026-11-11 实报）：finalText 只剩 `"\n\n\n"` 时以前画出来是一条**空白气泡**，
   * 看着像界面坏了。服务端落库时已换占位文案，这里再兜一层 —— 老库里已存在的空白消息
   * 也照样能看清"这一轮没回话"。
   */
  const bodyHtml = legacyReceipt ? ''
    : String(text ?? '').trim()
      ? renderMarkdown(text)
      : '<span class="bubble-empty">（这一轮没有回话 —— 模型输出为空或运行被中断，可以让他重跑一次）</span>';
  /*
   * 「证据」按钮（2026-11-09 P2）已于 2026-11-10 按用户口径移除：
   * 证据是给**后台/AI 查原因**用的（运行事件、`/api/runs/:id/evidence` 都还在），
   * 不在界面里体现 —— 气泡只放结论，不再挂按钮。
   */
    /* 手机端消息流降噪（2026-11-05 用户：「聊天页 UI 重新设计」）：
       · nt = 3 分钟内不重复挂时间戳（时间只留在每组第一条下面，主流聊天 App 同口径；
         桌面不受影响 —— .nt 的显示规则只写在 mobile.css 的 ≤900px 档里）；
       · tight = 同一人紧接着的下一句，行距收紧（换人才松开，段落感就出来了）。
       时间照常渲染进 DOM，只是被 CSS 藏 —— 桌面/手机共用一份 HTML。 */
    return `<div class="row ${mine ? 'me' : ''}${opts?.tight ? ' tight' : ''}${opts?.hideTime ? ' nt' : ''}">
    ${avHtml}
    ${nameLine
      ? `<div class="msg-main">${nameLine}<div class="bubble">${ticketAfter ? bodyHtml + ticket : ticket + bodyHtml}${attsHtml}${stoppedNote}</div></div>`
      : `<div class="bubble">${ticketAfter ? bodyHtml + ticket : ticket + bodyHtml}${attsHtml}${stoppedNote}</div>`}
    ${t ? `<div class="btime">${esc(t)}</div>` : ''}
  </div>`;
}

/*
 * 卡票（2026-10-24）：`meta = {type:'card', cardId, title, status, assignee}` 的消息，
 * 气泡顶上画一张票 —— 状态色点 + 标题 + 执行人，点它在**弹窗里**看卡（不离开这段对话）；
 * 角落那颗「看板」小按钮去任务看板（次入口，别抢主点击）。
 * 2026-11-16 用户："上面有看板按钮，这个多余了" —— 撤掉标题行右侧的「打开 →」，
 * 整卡依旧可点（弹窗里看卡详情），只是不再多画一颗看着像入口的字样。
 *
 * 票上的字段是**消息时刻的快照**（服务端落 meta 时写死的），不回查实时状态：
 * 聊天一屏可能好几张票，逐张回查太贵；点进详情页看的是实时的。
 * 状态色复用看板那套 --st-* 变量（COL_STATUS 反查列 key，class 同名）。
 *
 * ⚠️ 反查表必须**惰性建**：chat.mjs 和 projects.mjs 互相 import（循环依赖），
 * app.mjs 先加载 projects —— 它回头拉 chat 时 COL_STATUS 还在 TDZ 里，
 * 顶层一取整个模块图就炸（2026-10-24 实测：侧边栏全灭）。别的引用都在函数体内，
 * 求值晚于两个模块初始化完，没事；只有"模块顶层就要值"的写法会踩。
 */
let _colOfStatus = null;
const colOfStatus = () => (_colOfStatus ??= Object.fromEntries(Object.entries(COL_STATUS).map(([k, v]) => [v, k])));

export function cardTicketHtml(meta, at) {
  if (!meta || meta.type !== 'card' || !meta.cardId) return '';
  const col = colOfStatus()[meta.status] ?? 'other';
  // 落款行（2026-11-16 用户："把@去掉，在右下角放时间"）：执行人不带 @，
  // 时间用这条消息自带的时间（气泡下方那条的同一口径），靠右。没有就都不画。
  const stamp = at ? stampOf(at) : '';
  const foot = (meta.assignee || stamp)
    ? `<div class="ct-foot">${meta.assignee ? `<span class="ct-assignee">${esc(meta.assignee)}</span>` : ''}${stamp ? `<span class="ct-time">${esc(stamp)}</span>` : ''}</div>`
    : '';
  const inner = `<div class="card-ticket" data-card-ticket="${esc(meta.cardId)}" title="打开任务卡详情">
    <i class="ct-spine ${esc(col)}"></i>
    <div class="ct-head">
      <span class="ct-ico">📋</span><span class="ct-kind">任务卡</span>
      <span class="ct-status ${esc(col)}">${esc(statusText(meta.status || ''))}</span>
    </div>
    <div class="ct-row">
      <div class="ct-title">${esc(meta.title || '任务卡')}</div>
    </div>
    ${foot}
  </div>`;
  /*
   * 窄屏降级（2026-11 手机端增量，PRD P1-4）：body.mb-narrow（js/mobile.mjs 维护）时
   * 默认只出一行摘要条，点击内联展开 —— "降级而非删减"：卡片在，只是先收着。
   * 这是飞书接入的教训：不能把富工作台硬塞进聊天窗口。展开/收起的接线在 wireCardTickets。
   */
  if (document.body.classList.contains('mb-narrow')) {
    return `<div class="mb-fold" data-mb-fold>📋 任务卡：${esc(meta.title || '任务卡')}<span class="dim" data-mb-fold-hint> · 点击展开</span></div><div class="mb-fold-body" hidden>${inner}</div>`;
  }
  return inner;
}

/** 给画出来的卡票接上点击：整卡点开任务详情弹窗；窄屏摘要条管展开。 */
export function wireCardTickets(root) {
  /*
   * 窄屏折叠摘要条（P1-4）：点摘要 → 内联展开/收起正文（就是下面那张完整的卡票，
   * 展开后卡票自己的点击照常由下面两条委托接管）。只改 hidden 和提示词，不重画消息。
   */
  (root ?? $('chat')).querySelectorAll('[data-mb-fold]').forEach((f) => {
    f.onclick = () => {
      const bodyEl = f.nextElementSibling;
      if (!bodyEl) return;
      bodyEl.hidden = !bodyEl.hidden;
      const hint = f.querySelector('[data-mb-fold-hint]');
      if (hint) hint.textContent = bodyEl.hidden ? ' · 点击展开' : ' · 收起';
    };
  });
  (root ?? $('chat')).querySelectorAll('[data-card-ticket]').forEach((el) => {
    /*
     * 弹窗而不是整页（2026-10-26 用户拍板"不要嵌在这里"）：
     * 人在跟某人聊着，看见气泡顶上这张票，点它是"就手看一眼 / 补一句"。
     * 整页换掉等于把他从这段对话里拽走 —— 跟流程时间轴点「任务」是同一种处境，
     * 那边 2026-10-19 已经定成弹窗了（见 openTaskCardDialog 的说明），这里对齐。
     * 弹窗有全屏按钮（data-max），要看长描述/长讨论可以放大，不算憋。
     */
    el.onclick = () => {
      openTaskCardDialog(el.dataset.cardTicket).catch((e) => toast(e.message, 'error'));
    };
  });
}

/** 气泡里的附件区：图片铺缩略图，文件给 chip。空 = 什么也不画。 */
export function attsHtmlOf(atts) {
  if (!Array.isArray(atts) || !atts.length) return '';
  const isImg = (a) => (a.mime || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(a.name || '');
  const imgs = atts.filter(isImg);
  const files = atts.filter((a) => !isImg(a));
  const imgHtml = imgs.length
    ? `<div class="att-imgs">${imgs
        .map((a) => `<a href="${esc(a.url)}" target="_blank" rel="noopener"><img class="att-img" src="${esc(a.url)}" alt="${esc(a.name)}" title="${esc(a.name)}" loading="lazy"></a>`)
        .join('')}</div>`
    : '';
  const fileHtml = files.length
    ? `<div class="att-files">${files
        .map((a) => `<a class="att-file" href="${esc(a.url)}" target="_blank" rel="noopener" title="${esc(a.name)}">📄 ${esc(a.name)}</a>`)
        .join('')}</div>`
    : '';
  return imgHtml + fileHtml;
}



/**
 * 把**消息**和**没跑成的那几次运行**按时间合成一条时间线。
 *
 * 为什么要合：**失败的运行在库里没有 assistant 消息** —— 只画 messages 的话，
 * 用户看到的就是"我说了一句话，然后就没了"。失败原因只出现在那个实时气泡上，
 * 而它 300ms 后就被"从库里重画"冲掉了 —— 用户的原话是「报错信息一闪而逝」（2026-10-16 实报）。
 *
 * 为什么按**时间**而不是按 runId 配对：1:1 聊天派活时，**用户那条消息没有 runId**
 * （运行是派活之后才建的，见 dispatch.mjs 的 trigger）。配不上，时间线是这里唯一可靠的依据。
 */
export function timelineOf(msgs, runs) {
  const items = [];
  // 哪些运行**已经有回话**落库（停止的那一轮服务端会把掐在半句上的话留下，见 runs.mjs）。
  // 有回话就不再另画一条状态行 —— 同一件事说两遍是噪音。
  const repliedRuns = new Set(
    (msgs ?? []).filter((m) => m.role === 'assistant' && m.runId).map((m) => m.runId),
  );
  for (const m of msgs) items.push({ at: String(m.createdAt ?? ''), kind: 'msg', m });
  for (const r of runs ?? []) {
    /* 失败/中断也认「已有回话」：有的运行时会把报错本身当成回话落库（带 runId）——
       这时占位行就是同一件事说第二遍（2026-10-30 用户实报"为啥会有两条失败"）。 */
    if ((r.status === 'failed' || r.status === 'interrupted') && !repliedRuns.has(r.id)) {
      items.push({ at: String(r.endedAt ?? r.startedAt ?? ''), kind: 'fail', r });
      continue;
    }
    /*
     * 停止生成（2026-10-29）：以前"人停的"一条都不留 —— 理由是"点了停止是有意为之，
     * 不必在记录里再喊一声"。但它连带把**正在说的那条**也一起抹掉了：停止时若一个字都没
     * 流出来（常见：跑了十几分钟只调了工具），界面上就只剩我那句问话，对方的活像没发生过。
     * 现在：有回话的靠气泡上的「已停止生成」标记；一个字都没有的，留一条安静的状态行说明
     * 「这一轮确实跑了 N 分钟、是被掐掉的」，别让人对着空白猜。
     */
    if (r.status === 'stopped' && !repliedRuns.has(r.id)) {
      items.push({ at: String(r.endedAt ?? r.startedAt ?? ''), kind: 'stop', r });
    }
  }
  // 同一时刻（同一毫秒落库）时消息排前面：失败是"那条消息之后"发生的事
  items.sort((a, b) => (a.at === b.at ? (a.kind === 'msg' ? -1 : 1) : a.at < b.at ? -1 : 1));
  return items;
}



/**
 * 从一大段报错里挑出**那句人话**。
 *
 * 为什么不能整段倒出来：起不来的那次，`error` 是子进程的 stderr —— 十几行 Node 堆栈，
 * 头三行是 `node:internal/...` / `throw err;` / `^`。整段贴在对话里，
 * 用户看到的是"一堵墙"，而真正有用的那句（`Error: Cannot find module '...'`）淹没在中间。
 * 全量不删，折在「完整报错」里 —— 要排查的人点一下就有。
 */
export function firstMeaningfulLine(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const noise = /^(throw err;?|\^|at\s|node:internal\/)/;
  const pick = lines.find((l) => !noise.test(l)) ?? lines[0] ?? '';
  return pick.length > 160 ? pick.slice(0, 160) + '…' : pick;
}



/**
 * 没跑成那一块。复用 `.step.bad` —— 跟实时气泡里那行是同一个样式。
 *
 * 头像（2026-10-26 修）：原来这里写死一个「!」方块，用户截图报「失败的时候员工头像没了」。
 * 一屏里全是同一个人的头像，突然换成符号，看着像另起一个系统号在说话，认不出是谁的活失败了。
 * 现在跟正常气泡走**同一个** `smAvatar` —— 头像图/配色都跟着人走；
 * 谁是执行者用 `r.personaName`（`listRuns` 已经 JOIN 出名字），1:1 老库兜会话那个人。
 * 「失败」这件事由气泡里的红字和页头徽标说，不需要头像再喊一遍。
 */
export function failBlock(r, showName = false) {
  const full = String(r.error ?? '').trim();
  const why = firstMeaningfulLine(full) || '运行失败（这次没留下原因）';
  // 原因本身就是退出码时**别再补一句**「（退出码 1）」—— 2026-10-26 用户截图里看到的是
  // 「没跑成：退出码 1（退出码 1）」，同一件事说了两遍，还是最没信息量的那件事。
  const code = r.exitCode == null || /退出码/.test(why) ? '' : `（退出码 ${r.exitCode}）`;
  // 只有"藏着更多东西"时才给折叠入口：短报错摊开就好，别多一颗要点开的东西
  const more =
    full.length > why.length + 20
      ? `<details class="fail-more"><summary>完整报错</summary><pre>${esc(full)}</pre></details>`
      : '';
  // 干活的那个人：群聊靠 run 自己的 personaName（一场里可能有几个人先后跑），1:1 兜会话的人
  const label = r?.personaName || S.conversation?.personaName || '数字员工';
  const p =
    personaByName(r?.personaName) ??
    (S.conversation?.personaId ? S.personas.find((x) => x.id === S.conversation.personaId) ?? null : null);
  // 群聊里的失败也要认得出是谁（跟气泡的 who-line 同一个位置、同一套样式）
  const nameLine = showName ? `<div class="who-line">${esc(label)}</div>` : '';
  return `<div class="row">
    ${smAvatar(label, '', p)}
    ${nameLine
      ? `<div class="msg-main">${nameLine}<div class="bubble"><div class="step bad">没跑成：${esc(why)}${esc(code)}</div>${more}</div></div>`
      : `<div class="bubble"><div class="step bad">没跑成：${esc(why)}${esc(code)}</div>${more}</div>`}
  </div>`;
}



/**
 * 「已停止」那一块（2026-10-29，用户实报「点停止生成，对方的消息完全消失」）。
 *
 * 跟 failBlock 同一个骨架、同一套头像 —— 只是**不红**：停止不是失败，是人自己掐的，
 * 别用报错的颜色吓人。但也不能像以前那样一个字都不留：那一轮跑了多久得写出来，
 * 否则点完停止，屏幕上"对方的活"就像凭空没发生过。
 *
 * 只画"一个字都没说过"的那种。已经流出来的回话服务端会落成消息、由气泡上的
 * 「已停止生成」标记说明（见 bubble 的 stoppedNote）；两样都画就是同一件事说两遍。
 */
export function stopBlock(r, showName = false) {
  // 跑了多久：以服务端记的起止时间为准（刷新/重进会话也是同一个数，不是"我打开这页以来"）
  const began = Date.parse(String(r?.startedAt ?? ''));
  const ended = Date.parse(String(r?.endedAt ?? ''));
  const ran = Number.isFinite(began) && Number.isFinite(ended) && ended >= began ? ended - began : null;
  // 几秒钟就停掉的别写"跑了 00:00"—— 那不是信息，是噪音；上了 5 秒才值得说
  const dur = ran == null || ran < 5000 ? '' : ` · 跑了 ${fmtElapsed(ran)}`;
  const label = r?.personaName || S.conversation?.personaName || '数字员工';
  const p =
    personaByName(r?.personaName) ??
    (S.conversation?.personaId ? S.personas.find((x) => x.id === S.conversation.personaId) ?? null : null);
  const nameLine = showName ? `<div class="who-line">${esc(label)}</div>` : '';
  const body = `<div class="step stop">已停止生成${esc(dur)}（这一轮没有回话）</div>`;
  return `<div class="row">
    ${smAvatar(label, '', p)}
    ${nameLine
      ? `<div class="msg-main">${nameLine}<div class="bubble">${body}</div></div>`
      : `<div class="bubble">${body}</div>`}
  </div>`;
}



export function drawMessages(msgs, name, isGroup = false, runs = [], opts = {}) {
  /*
   * `meta.silent` 的消息**不画**（2026-10-24）：那是平台给 agent 的唤醒指令
   * （卡片回执里 @建卡人"去跟进"那条）—— 它是 run 的触发器，得落库、agent 得读到，
   * 但它不是人说的话，摊在对话里就成了右边一条"我"没说过的系统话。
   * 给人看的回执是另一条：执行人名义的汇报，带卡票（见 notifyCardOwner 的注释）。
   */
  const items = timelineOf(msgs, runs).filter((it) => it.kind !== 'msg' || !it.m.meta?.silent);
  /*
   * 日期分隔（2026-11-05，手机端 iOS 化配套）：**当天第一条前面**插一行居中的
   * 「今天 / 昨天 / M月D日」—— 插在中间会让时间线倒挂。样式在 mobile.css §16.10
   * （.mb-day，手机 ≤900px 生效）；桌面这条 div 无样式，就是一行空档，无害。
   * 取时间：消息用 createdAt；运行块（stop/fail）也带 createdAt，取不到就跳过不分组。
   */
  const DAY = 86400000;
  const dayLabel = (t) => {
    const d = new Date(t);
    const startToday = new Date();
    startToday.setHours(0, 0, 0, 0);
    if (t >= startToday.getTime()) return '今天';
    if (t >= startToday.getTime() - DAY) return '昨天';
    return (d.getFullYear() === startToday.getFullYear() ? '' : d.getFullYear() + '年')
      + (d.getMonth() + 1) + '月' + d.getDate() + '日';
  };
  let lastDay = '';
  /*
   * 消息流降噪（2026-11-05，手机端重设计配套）：
   *   · 3 分钟内不再重复挂时间戳（.nt，CSS 在手机档藏掉）—— 每条下面都挂一个时间
   *     是把"仪表"当"内容"画，一屏下来全是灰字；主流聊天 App 都只在组头挂一次。
   *   · 同一人紧接着的下一句（.tight）行距收紧 —— 换人才松开，段落感就出来了。
   * 发送者口径与 bubble() 一致：自己（user 且无他人署名）记 'me'，
   * 其余按署名 > 群昵称 > 角色；运行块（stop/fail）单独算，永远不跟消息合并。
   */
  const GAP = 3 * 60000;
  let prevT = NaN;
  let prevKey = '';
  /* 空会话**什么都不画**（2026-10-20 用户要求）：输入框就在下面，不需要再教一遍。 */
  $('chat').innerHTML = items.length
    ? items
        .map((it) => {
          const ts = it.kind === 'msg' ? it.m.createdAt : (it.r?.createdAt ?? null);
          let sep = '';
          const t = ts ? Date.parse(ts) : NaN;
          if (!Number.isNaN(t)) {
            const d = new Date(t);
            const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
            if (key !== lastDay) { lastDay = key; sep = `<div class="mb-day"><span>${esc(dayLabel(t))}</span></div>`; }
          }
          const keyOf = it.kind === 'msg'
            ? (it.m.role === 'user' && !(it.m.senderUserName && it.m.senderUserName !== (S.me?.name ?? '我'))
              ? 'me'
              : (it.m.senderUserName || it.m.personaName || it.m.role))
            : `#${it.kind}`;
          /* 跨了天（sep 非空）就重新开组：日期头下面第一条永远带时间、不收紧 */
          const soon = !sep && !Number.isNaN(t) && !Number.isNaN(prevT) && t - prevT < GAP;
          const opts = it.kind === 'msg'
            ? { hideTime: soon, tight: soon && keyOf === prevKey }
            : null;
          prevT = t;
          prevKey = keyOf;
          /*
           * 会话轮换（2026-11-11 上下文预算）：同一段聊天里他内部的 CLI 会话被换掉了。
           * 用户要求只在聊天里留一行灰字（不走信箱）：不占气泡、不算回话，居中一行说明。
           */
          if (it.kind === 'msg' && it.m.meta?.type === 'session-rotated') {
            return sep + `<div class="sys-line">${esc(it.m.text || '（上下文过长，已开新会话）')}</div>`;
          }
          return sep + (it.kind === 'msg'
            ? bubble(it.m.role, it.m.text, name, it.m.personaName, isGroup, it.m.createdAt, it.m.atts, it.m.meta, it.m.senderUserName, { ...(opts ?? {}), runId: it.m.runId, senderNick: senderNickOf(it.m), persona: (S.personas ?? []).find((x) => x.id === it.m.personaId) ?? null })
            : it.kind === 'stop' ? stopBlock(it.r, isGroup) : failBlock(it.r, isGroup));
        })
        .join('')
    : '';
  wireCardTickets(); // 画完顺手接上卡票的点击（票是 innerHTML 画出来的，得逐张绑）
  /* innerHTML 一换，上一颗「有新回复」胶囊就被连根拔了（它是 #chat 的子节点），
   * 引用还指着游离节点的话 showNewMsgPill 会以为还在、永远不再画 —— 先松手。 */
  newMsgPill = null;
  /* 整页重画后的滚动口径（2026-11-12 实报「回答被遮挡」）：
   * 换会话（forceScroll）或用户本来贴着底 → 滚到底；用户正翻着历史 → 不拽，弹胶囊。
   * 图片加载完的长高由下面 capture 委托补滚，这里不用管。 */
  if (opts.forceScroll || chatPinned) scrollDown();
  else showNewMsgPill();
}


/*
 * 贴底滚动状态机（2026-11-12 实报「嘉辉回答之后聊天没滚动，回答被遮挡」收口）。
 *
 * 查下来 scrollDown 一直都在调，漏滚的是**时序**：repaint 后 scrollDown 跑在
 * 图片加载前 —— 头像/消息截图一加载完内容长高，回答就被顶出屏外。所以贴底
 * 不能是"画完滚一把"的一次性动作，得跟着内容长高走：
 *   · chatPinned：用户没主动往上翻（最后一次 scroll 事件时离底 ≤ PIN_GAP）就记着贴底；
 *     内容再长高（图片加载、markdown 渲染、胶囊变化）都跟到底。
 *     内容长高**不触发 scroll 事件**，所以这个标志只能在 scroll 事件里刷新 ——
 *     正是靠它，图片加载完才知道"该不该跟"。
 *   · 图片 load 不冒泡，委托只能走 capture（祖先上的 capture 监听抓得到）。
 *   · 用户真翻上去了（离底 > PIN_GAP）：不再硬拽，弹「有新回复 ↓」胶囊，
 *     点一下回底。读历史不被打断，新回复也不至于无声无息。
 */
const PIN_GAP = 60;
let chatPinned = true;
let newMsgPill = null;

function chatNearBottom(gap = PIN_GAP) {
  const el = $('chat');
  return el.scrollHeight - el.scrollTop - el.clientHeight <= gap;
}

function hideNewMsgPill() {
  newMsgPill?.remove();
  newMsgPill = null;
}

function showNewMsgPill() {
  if (newMsgPill) return;
  newMsgPill = document.createElement('button');
  newMsgPill.type = 'button';
  newMsgPill.className = 'new-msg-pill';
  newMsgPill.textContent = '有新回复 ↓';
  newMsgPill.onclick = () => scrollDown();
  $('chat').appendChild(newMsgPill);
}

// #chat 是 index.html 里的常驻节点，模块加载时就挂好，整页重画（innerHTML）也不受影响
$('chat').addEventListener('scroll', () => {
  if (chatNearBottom()) {
    chatPinned = true;
    hideNewMsgPill();
  } else {
    chatPinned = false;
  }
}, { passive: true });

$('chat').addEventListener('load', (e) => {
  if (e.target instanceof HTMLImageElement && chatPinned) scrollDown();
}, true);

export const scrollDown = () => {
  $('chat').scrollTop = $('chat').scrollHeight;
  chatPinned = true;
  hideNewMsgPill();
};



/* ---------------------------------------------------------------- 发消息 */

/* ------------------------------------------------------- 附件（2026-10-23） */

/** 还没发出去的附件：{file, name, size, mime}。换会话就清空 —— 别把 A 会话的图带到 B 会话 */
let pendingAtts = [];
let attSending = false;

const MAX_ATTS = 8;

export function addAtts(fileList) {
  const files = [...fileList ?? []];
  if (!files.length) return;
  for (const f of files) {
    if (pendingAtts.length >= MAX_ATTS) { toast(`一次最多带 ${MAX_ATTS} 个附件`, 'error'); break; }
    pendingAtts.push({ file: f, name: f.name || '图片.png', size: f.size, mime: f.type || '', localUrl: URL.createObjectURL(f) });
  }
  paintAtts();
}

export function clearAtts() {
  for (const a of pendingAtts) { try { URL.revokeObjectURL(a.localUrl); } catch { /* 已失效 */ } }
  pendingAtts = [];
  paintAtts();
}

/** 输入框上方的附件条：文件名 + 大小 + ✕。图片顺便给个小缩略图，让人知道贴了哪张 */
export function paintAtts() {
  const strip = $('attStrip');
  if (!strip) return;
  strip.classList.toggle('is-hidden', !pendingAtts.length);
  strip.innerHTML = pendingAtts
    .map((a, i) => {
      const kb = a.size >= 1048576 ? `${(a.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(a.size / 1024))} KB`;
      const img = (a.mime || '').startsWith('image/')
        ? `<img class="att-thumb" src="${esc(a.localUrl)}" alt="">`
        : '';
      return `<span class="att-chip" title="${esc(a.name)}">${img}<span class="att-name">${esc(a.name)}</span><span class="att-size">${kb}</span><button type="button" class="att-x" data-att-x="${i}" title="移除">×</button></span>`;
    })
    .join('');
  strip.querySelectorAll('[data-att-x]').forEach((b) => {
    b.onclick = () => {
      const [gone] = pendingAtts.splice(Number(b.dataset.attX), 1);
      try { URL.revokeObjectURL(gone?.localUrl); } catch { /* 已失效 */ }
      paintAtts();
    };
  });
}

/** 选文件 / 粘贴的公共入口。换会话时清空（openConversation 里调） */
export function resetAtts() {
  clearAtts();
}

export async function send() {
  const raw = $('input').value.trim();
  // 光贴图不说话也能发（IM 的常识）；两者都没有才不动作
  if ((!raw && !pendingAtts.length) || !S.conversation || S.running) return;
  // 附件还在上传中就别重复触发（上传是 send 里顺序做的，SENDING 只是防抖）
  if (attSending) return;
  // 说出第一句就不再是"空会话"了 —— 详情页「发消息」的连点复用靠它判断
  S.convEmpty = false;
  $('input').value = '';
  closeMentionPop();
  // 群里的「续 @」（2026-11-05）：话里 @ 了谁就记住谁；没 @ 就把上回那位续到句首。
  // 光发图也一样 —— 附件也要落到同一个人头上。
  const text = applyStickyMention(raw);
  renderStickyMention();
  const name = S.conversation.personaName || S.persona?.name || '数字员工';
  const convId = S.conversation.id;

  // 附件先传（2026-10-23）：一次一个文件 POST 原始二进制，全成清单才发消息。
  // 失败就把原话放回输入框 —— 别让人打了半天字因为一张图传挂了全丢。
  let atts = null;
  const pending = pendingAtts;
  if (pending.length) {
    attSending = true;
    try {
      atts = [];
      for (const a of pending) {
        const d = await api(`/api/conversations/${encodeURIComponent(convId)}/files?name=${encodeURIComponent(a.name)}`, {
          method: 'POST',
          headers: { 'Content-Type': a.mime || 'application/octet-stream' },
          body: a.file,
        });
        atts.push({ name: d.file.name, stored: d.file.stored, size: d.file.size, mime: d.file.mime, url: d.file.url });
      }
    } catch (err) {
      toast(`附件没传上去：${err.message}`, 'error');
      $('input').value = text;
      return;
    } finally {
      attSending = false;
    }
  }

  $('chat').querySelector('.empty')?.remove();
  $('chat').insertAdjacentHTML('beforeend', bubble('user', text, name, undefined, false, new Date().toISOString(), atts));
  scrollDown();
  clearAtts();

  try {
    // 流程走的是 issue：在实例页里说话，不在这儿。这里就是普通聊天
    const d = await post('/api/conversations/' + encodeURIComponent(convId) + '/messages', { text, atts });
    attachStream(d.runId, d.personaName);
    // 群里 @ 多人（2026-10-24）：只有第一个当场开跑，其余排队 —— 说一声，别让人以为漏派了。
    // 前一个跑完服务端自动补派下一个，聊天页重开会话时会自己接上那条 run 的实时流。
    if (Array.isArray(d.queued) && d.queued.length) {
      toast(`已派给 ${d.personaName}；排队中：${d.queued.join('、')}（前一个跑完自动接上）`);
    }
    // 立刻刷一次左侧列表。
    // 服务端在写入这条消息时就会把它从"已从列表移除"里恢复（删掉会话后只要有新消息，
    // 会话就回到列表，这是通行语义）。但列表数据是前端缓存的，
    // 不主动刷就得等运行结束才更新 —— 那几十秒里会让人以为"消息发出去了却没记录"。
    await load();
  } catch (err) { toast(err.message, 'error'); load(); }
}



// 主对话里"正在跑的那次运行"（停止生成要用它）。
// 跟节点对话栏的 ncRunningId 是一个道理：S.running 只说明"忙不忙"，
// 点不到具体哪一条运行 —— 光有布尔量是停不掉的。
export let chatRunningId = null;

// 「这一轮实时流已经收尾」的信号。停止生成点完要**等它**再重画（见 stopChatRun 里那段说明）：
// 每接一次流换一个新 Promise；这一轮收尾（attachStream 的 stop）或下一轮接上时把它放掉。
let chatSettle = null;
let chatSettleResolve = null;



/**
 * 停止生成：掐掉这个会话里正在跑的那次运行。
 *
 * 走的是跟节点对话栏那颗方块按钮**同一个后端接口**（POST /api/runs/:id/abort）——
 * 服务端会先把这次标成"人停的"，再杀子进程，所以收尾时**不会记成失败**
 * （这两件事的先后顺序有讲究，见 server.mjs 里 abort 那段注释）。
 *
 * ⚠️ 这是"停止"，不是"暂停"：底层 runtime 都是一次性子进程，没有暂停/续跑这回事。
 *    停掉的是**这一轮运行**，不是这个人 —— 会话和上下文都还在，随时可以再说一句接着办。
 */
export async function stopChatRun() {
  const id = chatRunningId;
  if (!id) return;
  const convId = S.conversation?.id ?? null;
  const settled = chatSettle;
  // 先让界面立刻停下来（点完就见效，不等后端回调）—— 跟节点对话栏一个做法
  S.running = false;
  chatRunningId = null;
  setBusy(false);
  setHeaderBadge('stopped');
  try {
    await api(`/api/runs/${encodeURIComponent(id)}/abort`, { method: 'POST' });
  } catch (e) {
    toast(e.message, 'error');
  }
  /*
   * ⚠️ **别在这里立刻从库里重画**（2026-10-29 用户实报「点停止生成，对方的消息完全消失」）。
   *
   * abort 接口只负责"发停止信号"：子进程被杀、收尾钩子把这一轮的话与状态落库，都在它之后。
   * 抢在那个瞬间 openConversation，画出来的是"库里还没有"的那一版 ——
   * 实时气泡被抹掉、库里又空着，屏幕上就空了一块（等收尾钩子晚一点落库，也不会自己再画回来）。
   *
   * 所以改成**等这次运行真的收尾**（SSE 的 __done → attachStream 的 stop()，那边 300ms 后重画）；
   * 兜底等 6 秒（看门狗 5 秒 + 余量）还没收到就自己补画一次，且只在**还停在这个会话**时补
   * （等待期间人可能已经点去别的会话了，别把人拽回来）。
   */
  const done = await Promise.race([
    Promise.resolve(settled).then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 6500)),
  ]);
  if (!done && convId && S.conversation?.id === convId) {
    await openConversation(convId).catch(() => {});
  }
}



export function attachStream(runId, whoName = '', startedAt = null, lastEventAt = null) {
  if (S.es) S.es.close();
  // 这一轮的「收尾了」信号（停止生成会等它再重画，见 stopChatRun）。
  // 先把上一轮还在等的放掉，再挂新的一轮 —— 否则换会话/重连时旧 Promise 会一直吊着。
  chatSettleResolve?.();
  chatSettleResolve = null;
  let settleMe = null;
  chatSettle = new Promise((resolve) => { settleMe = resolve; });
  chatSettleResolve = () => settleMe();
  S.running = true;
  chatRunningId = runId;
  setBusy(true);
  setHeaderBadge('running'); // 跑中不挂徽章（下面有「思考中」进度卡，见 ui.mjs headerBadgeHtml）

  // 打字气泡的头像按名字找人（2026-10-23 修正）：群聊会话上没有 personaName，
  // 得用这次运行自己的执行者（POST 回体 / 运行记录 join 出来的 personaName），
  // 否则兜底成「数字员工」→ 头像显示成「数」字块
  const name = whoName || S.conversation.personaName || S.persona?.name || '数字员工';
  const convId = S.conversation.id;
  const id = 'live-' + runId;
  const begun = typeof startedAt === 'string' ? Date.parse(startedAt) : startedAt;
  /*
   * **一颗气泡**（2026-11-08 三版）：跑着的时候这颗泡里只有一行日志（run-progress-card 的
   * 单行胶囊），真正的回复一到就原地顶掉它 —— 不再像二版那样"日志一颗粒 + 正文一颗泡"。
   * 用户口径：「单行气泡刷日志，显示什么不重要，重要的是在动；真正的回复出来后代替它」。
   * 做法：气泡先挂 .live-line（自己无框无底色，里面只放那颗胶囊）；正文进来时摘掉这个类、
   * 移除胶囊，同一个 .bubble 就成了回话泡 —— 日志泡和回话泡是同一个元素，不并排出现。
   */
  $('chat').insertAdjacentHTML('beforeend',
    `<div class="row" id="${id}">
       ${smAvatar(name, '', personaByName(name))}
       <div class="bubble live-line"></div>
     </div>`);
  // 日志行只是"在动"，不算新回复：贴底才跟（重画后 attachStream 重接时 drawMessages 已滚过），
  // 翻着历史时不拽 —— 见贴底状态机（scrollDown 上面那段）。
  if (chatPinned) scrollDown();

  const body = document.querySelector('#' + id + ' .bubble');
  /*
   * 画卡片这一层 2026-10-29 拆成共用组件（run-progress-card.mjs）—— 任务卡讨论区用的是
   * 同一套，别处再要"看得见他在干嘛"也接这一个；形状是那颗 30px 的单行胶囊（见 style.css
   * 的 .rp 段）。数据全部来自事件流（跟 `run_events` 同一份），刷新/重连时服务端会重放。
   * 思考片段固定也刷在这一行里（2026-11-08 晚：「思考过程」开关退场 —— 这一行显示什么
   * 不重要，在动就行，所以不再给人留一个"内容显不显示"的配置）。
   */
  const card = createProgressCard({
    startedAt: Number.isFinite(begun) ? begun : Date.now(),
    // 重开页面接上跑中的一轮：空闲时长按服务端记的最后活动算，别按"刚连上"算
    lastEventAt,
    onStop: () => stopChatRun().catch(() => {}),
  });
  body.appendChild(card.el); // 胶囊就住在这颗泡里（泡此时是 .live-line，自己不画框）
  /*
   * 直播回话状态机（2026-11-08 起共用 run-live.mjs）：跑着时只留这一行日志；text 先攒着，
   * 后面又来了工具事件就说明那段是"中间话"、丢掉；收尾时才是真正的回复 —— 由它顶掉日志行、
   * 落进同一颗泡。任务卡讨论区接的是**同一份**（别再各写一套，2026-11-09 英文运行实报收口）。
   */
  const live = createLiveAnswer({
    card,
    host: body,
    render: renderMarkdown,
    // 回答正文落泡：贴底就跟到底；用户翻上去读历史就不拽、弹「有新回复 ↓」——
    // 这是"回答被遮挡"实报的正面修复（2026-11-12）。
    onScroll: () => { if (chatPinned) scrollDown(); else showNewMsgPill(); },
    onEnterAnswer: () => body.classList.remove('live-line'),
  });
  const add = (cls, text, asHtml = false) => {
    const d = document.createElement('div');
    d.className = 'step ' + cls;
    if (asHtml) d.innerHTML = text; else d.textContent = text;
    body.appendChild(d);
    if (chatPinned) scrollDown();
  };

  let stopped = false;
  const tick = setInterval(() => { if (!stopped) card.paint(); }, 1000);

  /**
   * 收尾唯一出口。
   * 状态永远以**服务端**为准，不靠客户端自己猜。
   */
  const stop = (status) => {
    if (stopped) return;
    stopped = true;
    clearInterval(tick);
    if (S.es) { S.es.close(); S.es = null; }
    S.running = false;
    chatRunningId = null;
    setBusy(false);
    setHeaderBadge(status);
    // 先把"完成/停止/失败 + 总用时 + N 步"留一帧，再由 300ms 后的整页重画接手
    card.finish(status);
    setTimeout(() => openConversation(convId).then(load).catch(() => {}), 300);
    // 告诉「停止生成」：这一轮真的收尾了（它会等这个信号再决定要不要自己补画）
    settleMe();
  };

  // 实时输出走**共用**的 streamRun（流程实例页的节点对话也是它）
  S.es = streamRun(runId, {
    // 每个原始事件都喂给进度卡：dsh 的 tool_call/tool_result、codex 的 tool、
    // claude 的 status 都靠它 —— 旧的 onText/onTool 只覆盖了其中一部分。
    onEvent: (evt) => { live.applyEvent(evt); card.applyEvent(evt); },
    onText: (chunk) => live.pushText(chunk),
    onRunError: (msg) => {
      live.enterAnswer(); // 报错也要露在明面上，不能藏在日志泡里
      add('bad', '· ' + firstMeaningfulLine(msg));
      card.paint();
    },
    onDone: (evt) => {
      live.flushPending();
      // 这一行只是"立刻给你一句"；跑完 300ms 后整页从库里重画，
      // 那时由 failBlock 把它**留在回话里**（见 timelineOf 的注释）
      if (evt.status !== 'done') {
        const why = firstMeaningfulLine(evt.error) || '运行失败';
        if (!live.answerMode) live.enterAnswer();
        add('bad', `${why}（退出码 ${evt.exitCode}）`);
      }
      stop(evt.status);
    },
    // 出错**不关连接**：EventSource 自带断线重连，而服务端 subscribe() 会把这次运行
    // 缓存过的事件重放一遍（含 __done），所以重连本身就能把状态补齐。
    // 这里只补一次状态查询，兜「服务重启 → 运行已不在内存里 → 重连拿到 404」这一种情况。
    onReconnect: async () => {
      if (stopped) return;
      try {
        const d = await api('/api/conversations/' + encodeURIComponent(convId));
        if (d.conversation.status !== 'running') stop(d.conversation.status);
      } catch { /* 服务不可达：让 EventSource 自己继续重试 */ }
    },
  });
}



/**
 * 订阅一次运行的实时输出 —— **对话场景只写一遍**。
 *
 * 现在有两处对话：消息模块的会话、流程实例页的节点对话。两边都要
 * "边跑边看、跑完收尾"，以前各写一份，于是改一处漏一处
 * （「正在输入中」不亮、要刷新才看到回复，都是这么来的）。
 *
 * 事件是**分块**推的（不是逐 token），所以文本块按顺序追加即可，不用自己攒。
 *
 * @param {string} runId
 * @param {object} h
 *   onEvent(evt)         **每一个原始事件**（dsh 的 tool_call/tool_result/status 也走这儿；
 *                        运行进度归约器用它，别的调用方可以不理）
 *   onText(chunk)        他的回话（追加）
 *   onRunError(message)  运行报错
 *   onThinking(text)     思考（调用方自己决定显不显示）
 *   onTool(name)         工具调用
 *   onDone(evt)          **唯一收尾出口**：{ status, error, exitCode }
 *   onReconnect()        断线（EventSource 自己会重连，这里问一次服务端兜底）
 * @returns {{ close: () => void }}
 */
export function streamRun(runId, h = {}) {
  let closed = false;
  const es = new EventSource('/api/runs/' + encodeURIComponent(runId) + '/stream');
  const close = () => {
    if (closed) return;
    closed = true;
    es.close();
  };
  es.onmessage = (e) => {
    let evt;
    try {
      evt = JSON.parse(e.data);
    } catch {
      return;
    }
    /*
     * 先把**原始事件**交给 onEvent（运行进度用它）。归约器出错不该拖垮整条流 ——
     * 它只负责"画进度"，画不出来也得让回话继续显示。
     */
    try { h.onEvent?.(evt); } catch { /* ignore */ }
    if (evt.type === '__done') {
      close();
      return h.onDone?.(evt);
    }
    if (evt.type === 'text') return h.onText?.(evt.text);
    // claude 的 error 事件字段是 `text`，dsh/codex 是 `message` —— 两个都认
    if (evt.type === 'error') return h.onRunError?.(evt.message ?? evt.text);
    if (evt.type === 'thinking') return h.onThinking?.(evt.text);
    if (evt.type === 'tool') return h.onTool?.(evt.name);
  };
  es.onerror = () => {
    if (!closed) h.onReconnect?.();
  };
  return { close };
}



export function setBusy(busy) {
  const isGroup = S.conversation?.kind === 'group';
  // **忙的时候不是"把发送禁用"，是"换成停止生成"** ——
  // 以前只写 `disabled = true`，于是"他还在说…"的时候除了干等没有任何出路（用户实报）。
  // 跟节点对话栏那颗方块按钮同一个语义，判断方式也一样（看按钮自己的 class，不依赖外部状态）。
  const btn = $('send');
  btn.disabled = false;
  btn.textContent = busy ? '停止生成' : '发送';
  btn.classList.toggle('stopping', !!busy);
  btn.title = busy ? '掐掉这一轮（他已经说出来的话会留着）' : '发送';
  $('input').placeholder = busy
    // 2026-11-05 评鉴：原来是"他还在说…"—— 跑工具的时候他不是在说，是在干活
    ? (isNarrowPh() ? '' : '他还在干活…（要打断就点「停止生成」）')
    : phChat();
  $('hint').textContent = busy
    ? (isNarrowPh() ? '' : '一次只跑一条。要打断就点「停止生成」。')
    : '';
}



/* ---------------------------------------------------- 输入框里的 @ 选人 */

export const mentionPop = { open: false, start: 0, index: 0, matches: [] };



export function mentionCandidates() {
  const c = S.conversation;
  return c && c.kind === 'group' ? c.members : [];
}



/** 光标前如果是一个还没写完的 @词，就弹出成员列表 */
export function updateMentionPop() {
  const el = $('input');
  const members = mentionCandidates();
  if (!members.length) return closeMentionPop();

  const caret = el.selectionStart ?? el.value.length;
  const before = el.value.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return closeMentionPop();

  const token = before.slice(at + 1);
  if (/\s/.test(token)) return closeMentionPop(); // @ 后面出现空白，说明这句不是在提人

  const q = token.toLowerCase();
  const matches = members.filter((m) => m.name.toLowerCase().includes(q));
  if (!matches.length) return closeMentionPop();

  mentionPop.open = true;
  mentionPop.start = at;
  mentionPop.matches = matches;
  if (mentionPop.index >= matches.length) mentionPop.index = 0;

  $('mentionPop').innerHTML = `
    <div class="mp-head"><span>选择提醒的人</span><span>↑↓ 选择 · Enter 确认</span></div>
    <div class="mp-list">${matches
      .map((m, i) => {
        const isAssistant = S.conversation?.assistantPersonaId === m.personaId;
        /*
         * 头像（2026-10-23 用户实报「@ 选人弹层还是字母头像」）：按 personaId 从
         * S.personas 查头像文件，有图就把图铺在字母上面 —— 跟群成员磁贴（groups.mjs）
         * 同一套哲学：图盖字母、加载失败 onerror 自删露字母，永远不破相。
         * mp-avatar 需要相对定位才能铺 img，CSS 里单独补了这条。
         */
        const p = (S.personas ?? []).find((x) => x.id === m.personaId);
        const img =
          p?.avatar && AVATAR_FILE.test(String(p.avatar))
            ? `<img class="av-img" src="/avatars/${encodeURIComponent(String(p.avatar))}" alt="" loading="lazy" decoding="async" onerror="this.remove()">`
            : '';
        return `<div class="mp-item${i === mentionPop.index ? ' active' : ''}" data-i="${i}">
          <div class="mp-avatar">${esc(initial(m.name))}${img}</div>
          <div class="mp-name">${esc(m.name)}${roleNameOf(p) ? `<span class="mp-role">${esc(roleNameOf(p))}</span>` : ''}</div>
          ${isAssistant ? '<span class="mp-tag">群助手</span>' : ''}
        </div>`;
      })
      .join('')}</div>`;
  $('mentionPop').classList.add('open');
  $('mentionPop').querySelectorAll('[data-i]').forEach((node) => {
    // mousedown 而不是 click：避免 textarea 先失焦把列表关掉
    node.onmousedown = (e) => { e.preventDefault(); insertMention(Number(node.dataset.i)); };
  });
}



export function closeMentionPop() {
  mentionPop.open = false;
  mentionPop.matches = [];
  $('mentionPop').classList.remove('open');
}



export function insertMention(i) {
  const m = mentionPop.matches[i];
  if (!m) return;
  const el = $('input');
  const caret = el.selectionStart ?? el.value.length;
  const head = el.value.slice(0, mentionPop.start);
  const tail = el.value.slice(caret);
  const inserted = '@' + m.name + ' ';
  el.value = head + inserted + tail;
  const pos = head.length + inserted.length;
  el.setSelectionRange(pos, pos);
  el.focus();
  closeMentionPop();
}



/* ---------------------------------------------------- 群里的「续 @」（2026-11-05）

   用户："@一个人，下次聊天自动继续@他，就像 workbuddy 里选了专家一样。"

   以前每句话都要重新打 @ 选人；现在 @ 过一次之后，这条群里后续的话**默认都找他**
   —— 输入条上方挂一颗可摘的「@名字」胶囊（WorkBuddy 选专家的那颗同款）：

   · 记忆按**群会话**存（localStorage），关页面 / 重开都在 —— "下次聊天"是真下次；
   · 发送时话里已经 @ 了人 → 以话为准，顺便把记忆换成 @ 的那位（多 @ 记第一个，
     长名优先，跟服务端 parseMentions 同一把尺，别让「@李」吃掉「@李俊」）；
   · 点胶囊上的 ✕ 摘掉 → 回到"不 @ 找群助手"的老规矩；
   · 只在群里生效，私聊没有"找谁"的分岔；成员被移出群后记忆自动失效（每次现校名单）。 */

const STICKY_KEY = 'bandi-sticky-mention';

const stickyMentions = readStickyMentions();
function readStickyMentions() {
  try { return JSON.parse(localStorage.getItem(STICKY_KEY) ?? '{}') ?? {}; }
  catch { return {}; }
}
function saveStickyMentions() {
  try { localStorage.setItem(STICKY_KEY, JSON.stringify(stickyMentions)); } catch { /* 存不上就算了，功能降级成"本次会话内有效" */ }
}

/** 当前群被记住的那位（没有 / 已不在群里 → null） */
function stickyMember() {
  const c = S.conversation;
  if (!c || c.kind !== 'group') return null;
  const id = stickyMentions[c.id];
  if (!id) return null;
  return (c.members ?? []).find((m) => m.personaId === id) ?? null;
}

/** 输入条上方那颗「@名字 ✕」胶囊：有记忆就亮出来（进会话 / 发送后都刷一遍） */
export function renderStickyMention() {
  const el = $('stickyMention');
  if (!el) return;
  const m = stickyMember();
  el.hidden = !m;
  if (!m) return;
  el.innerHTML = `<span class="sm-at">@${esc(m.name)}</span>` +
    '<button type="button" class="sm-x" title="不再自动 @ 他" aria-label="不再自动 @ 他">✕</button>';
  el.querySelector('.sm-x').onclick = () => {
    if (!S.conversation) return;
    delete stickyMentions[S.conversation.id];
    saveStickyMentions();
    renderStickyMention();
  };
}

/** 发送前调用：话里 @ 了人 → 记住他、原话照发；没 @ → 把记忆的那位续到句首 */
function applyStickyMention(raw) {
  const c = S.conversation;
  if (!c || c.kind !== 'group') return raw;
  const hit = (c.members ?? [])
    .filter((m) => raw.includes('@' + m.name))
    .sort((a, b) => b.name.length - a.name.length)[0] ?? null;
  if (hit) {
    if (stickyMentions[c.id] !== hit.personaId) {
      stickyMentions[c.id] = hit.personaId;
      saveStickyMentions();
    }
    return raw;
  }
  const sticky = stickyMember();
  return sticky ? `@${sticky.name} ${raw}` : raw;
}



/* -------------------------------------------------------------- 员工详情 */

export async function openDetail(personaId) {
  // 上一页可能还有没落盘的改动（自动保存是防抖的）—— 先存完再画新页
  if (detailSave.flush) {
    const f = detailSave.flush;
    detailSave.flush = null;
    try { await f(); } catch { /* 存不上也别挡着开页面 */ }
  }
  // 从哪儿进的详情（2026-10-24）：消息页进来按钮叫「回到聊天」，通讯录进来叫「发消息」——
  // 行为相同（都接着最近那段聊），文案按用户的心智分开说。
  S.detailFrom = S.nav;
  setRoute('persona', { id: personaId });
  if (S.es) { S.es.close(); S.es = null; S.running = false; setBusy(false); }
  /*
   * 任务那条路**单独取、并行取**：
   *   · 它要扫全部会话与流程，比"配置"重；
   *   · 取不到（老版本服务端、路子断了）只该让「任务」那一页说一声，
   *     不该把整个员工详情拖黑 —— 配置还得能改。
   */
  const [d, tasks] = await Promise.all([
    api('/api/personas/' + encodeURIComponent(personaId)),
    api('/api/personas/' + encodeURIComponent(personaId) + '/tasks').catch((e) => ({ error: e.message })),
  ]);
  S.persona = d.persona;
  showView('detail');
  renderList();
  renderDetail(d, tasks);
}



/** 技能图标（书本）——两处列表共用 */
export const SKILL_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6.6C10.4 5.2 8.4 4.6 5.8 4.6H4.2v13.2h2c2.3 0 4.2.6 5.8 2 1.6-1.4 3.5-2 5.8-2h2V4.6h-1.6C15.6 4.6 13.6 5.2 12 6.6z"/><path d="M12 6.6v13.2"/></svg>';



/* ------------------------------------------------ 员工详情 →「任务」 */

/**
 * 员工详情里的任务页：**只读**，数据跟任务看板**同一批行**（服务端 `personaTasks` 按人筛过）。
 *
 * 形状是三次拍板定下来的（2026-11-09）：
 *   ① 用户「任务做成表格」—— 不再是竖着摞的 `.kb-card`。卡片在看板上是对的（列里能拖、
 *      一眼看成一叠），到了这一页就不合适：主区一栏宽、又不给拖，"面"只是白占纵向空间。
 *   ② 用户「任务记录参考浏览器这种方式，按照日期来」—— 分堆从"生命周期"换成**按天分组**：
 *      「今天 · 2026年11月9日 星期一」「昨天 · …」「2026年11月7日 星期六」……
 *      日期进了标题，行里就只留 HH:mm（浏览器历史那一套）。
 *   ③ 用户「不要单独列出来。而是在上方加状态筛选」—— 上一版的「要人管」是钉在表头的
 *      一个跨天段，既占掉小半屏，又和日期段抢同一批行的位置。现在它是一个**筛选档**：
 *      表只按天分组（严格照 ②），"现在有哪几件卡着"改成顶上点一下 —— 想全看、想看某一档，
 *      都只有一套排序。筛选是**纯前端**的事，不重新请求。
 */

/**
 * 状态筛选档。`cols` = 归进这一档的看板列（一个列**只归一档**，所以各档相加正好等于总数）。
 * 不认识的列 key 只出现在「全部」里 —— 宁可这一档漏筛，不能把行丢了。
 */
const TASK_FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'urgent', label: '要人管', cols: ['blocked', 'failed', 'review'] },
  { key: 'doing', label: '进行中', cols: ['doing'] },
  { key: 'wait', label: '待办', cols: ['todo', 'idea'] },
  { key: 'done', label: '已完成', cols: ['done'] },
  { key: 'cancelled', label: '已取消', cols: ['cancelled'] },
  { key: 'other', label: '其他', cols: ['other'] },
];

const TASK_FILTER_OF_COL = new Map(TASK_FILTERS.flatMap((f) => (f.cols ?? []).map((c) => [c, f.key])));

/** 看板列 → 筛选档 key（不认识的列给 ''，只进「全部」） */
const filterOfCol = (colKey) => TASK_FILTER_OF_COL.get(colKey) || '';

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

/** 本地日期 → 'YYYY-MM-DD'。**不能用 toISOString**：那是 UTC，东八区晚 8 点以后会差一天 */
function ymdOf(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 'YYYY-MM-DD' →「今天 · 2026年11月9日 星期一」/「昨天 · …」/「2026年11月7日 星期六」 */
function taskDayLabel(day, today, yesterday) {
  if (!day) return '没记时间';
  const [y, m, d] = day.split('-').map(Number);
  const full = `${y}年${m}月${d}日 ${WEEKDAYS[new Date(y, m - 1, d).getDay()]}`;
  if (day === today) return `今天 · ${full}`;
  if (day === yesterday) return `昨天 · ${full}`;
  return full;
}



/**
 * 一行：任务（标题 + 项目/来源/PR 小标签）、状态、时间。
 *
 * 标签留在标题下面、不各占一列：这一页最窄的时候（手机整页）五列会把标题挤成
 * 两三个字一行 —— 标签本来就是补充说明，贴着它那件事走才对。
 *
 * 一样**不给拖、不给删**：员工详情回答的是"他手上有什么"，改状态、删卡该回看板去做 ——
 * 两处都能改就会互相打脸。
 *
 * `colKey` = 这张卡所在的看板列（`blocked` / `review` / …）：状态那格的颜色按**列**上色
 * （`--st-*`，跟看板列头同一套），不按中文词面自己猜 —— 「已停止」落在 `blocked` 列，
 * 词面里压根没有"阻塞"两个字。
 *
 * 时间只画 HH:mm：日期在分组标题里（浏览器历史也是这么排的），完整时间留在 `title` 上，
 * 鼠标停一下还能看见年月日。
 */
export function personaTaskRow(r, colKey = '') {
  const srcCls = r.source === 'chat' ? ' chat' : r.source === 'repo' ? ' repo' : r.source === 'manual' ? ' manual' : '';
  // 点这行去哪儿：流程 → 那条实例；有会话 → 那场对话；手工卡没派活 → 它所在项目的看板
  const attr = r.source === 'flow'
    ? ` data-pt-flow="${esc(r.flow_id)}" data-pt-tpl="${esc(r.template_id || '')}"`
    : r.conversation_id
      ? ` data-pt-conv="${esc(r.conversation_id)}"`
      : r.project_id
        ? ` data-pt-proj="${esc(r.project_id)}"`
        : '';
  // 站在一个人的页面上，"这是哪个项目的活"比"哪来的"更该先看见 —— 所以项目标签在最前
  const proj = r.project_id
    ? `<span class="kb-tag proj" title="属于哪个项目">${esc(r.project_name)}</span>`
    : '<span class="kb-tag" title="没挂项目也没落在任何项目目录下">未归属</span>';
  const at = String(r.at ?? '');
  const hhmm = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(at) ? at.slice(11, 16) : '—';
  // 行上不再挂 `manual` class（2026-11-09 用户去掉左侧蓝竖条）：来源由标题下那颗标签说，
  // 连续几行手工卡各画一条竖条会连成一条贯穿整段的装饰线，反倒看不出"这一行是人加的"。
  return `<tr class="pt-row"${attr} title="${esc(r.note || '')}">
    <td class="pt-td-task">
      <div class="pt-title">${esc(r.task)}</div>
      <div class="pt-tags">${proj}<span class="kb-tag${srcCls}">${esc(r.source_text)}</span>${prPillOf(r)}</div>
    </td>
    <td class="pt-td-state"><span class="pt-state ${esc(colKey)}">${esc(statusText(r.status))}</span></td>
    <td class="pt-td-at" title="${esc(at)}">${esc(hhmm)}</td>
  </tr>`;
}



/**
 * 任务页的正文（不含合计那行）。`b` = `/api/personas/:id/tasks` 的返回，
 * 形状跟任务看板一模一样（`board()` 的产物），所以这里只做三件事：
 * 按状态筛选 → 按天分组 → 铺成表。
 *
 * `filter` = 选中的筛选档 key（见 TASK_FILTERS）。认不出来的值一律当「全部」——
 * 刷新后某一档空了、或者旧链接带了个退役的 key，都不该整页空白。
 *
 * 每个日期是一个 `<tbody>`：表头只画一次，段名做成跨三列的段行 ——
 * 这样各段的任务/状态/时间仍然对齐在同一组列宽上（各段各开一张表就会各自算宽）。
 */
export function personaTasksHtml(b, filter = 'all') {
  if (!b) return '<div class="empty" style="padding:26px 4px">任务取不到</div>';
  if (b.error) return `<div class="empty" style="padding:26px 4px">任务取不到：${esc(b.error)}</div>`;
  if (!b.total) {
    return `<div class="empty" style="padding:30px 4px;line-height:1.9">
      ${esc(b.persona_name || '他')}手上还没有任务<br />
      <span class="dim">看板上建的卡指定他做、流程走到点他名的节点、或者他直接在会话里接了活 —— 都会算在这里。</span>
    </div>`;
  }

  // 一行 = 一张卡 + 它所在的看板列（状态色按列走，见 personaTaskRow）。新→旧排一次，
  // 后面的筛选和按天分组都沿用这个次序（浏览器历史也是时间倒序）。
  const all = (b.columns ?? [])
    .flatMap((c) => (c.cards ?? []).map((r) => ({ r, colKey: c.key })))
    .sort((x, y) => String(y.r.at || '').localeCompare(String(x.r.at || '')));

  // 各档件数：筛选条上既是"有没有这一档"，也是"这一档几件"。
  const nOf = new Map(TASK_FILTERS.map((f) => [f.key, 0]));
  for (const x of all) {
    nOf.set('all', nOf.get('all') + 1);
    const k = filterOfCol(x.colKey);
    if (k) nOf.set(k, (nOf.get(k) || 0) + 1);
  }

  const active = TASK_FILTERS.some((f) => f.key === filter) ? filter : 'all';
  const rows = active === 'all' ? all : all.filter((x) => filterOfCol(x.colKey) === active);

  // 筛选条：件数为 0 的档不画（点进去是空的，白占位置）；但**当前选中的那档永远画**，
  // 否则刷新后它变空了，人连"自己在看哪一档"都看不出来，也没法点回「全部」。
  const bar = `<div class="pt-filters">${TASK_FILTERS
    .filter((f) => f.key === 'all' || nOf.get(f.key) || f.key === active)
    .map((f) => `<button type="button" class="pt-filter${f.key === active ? ' on' : ''}"
      data-pt-filter="${f.key}">${esc(f.label)}<span class="pt-fnum">${nOf.get(f.key) || 0}</span></button>`)
    .join('')}</div>`;

  // 按天分堆。Map 保留插入顺序 = 时间倒序，所以日期段天然是新的在前。
  // `at` 是服务端 `stamp()` 格式化过的本地时间「YYYY-MM-DD HH:mm」，前 10 位就是日期。
  const byDay = new Map();
  for (const x of rows) {
    const day = /^\d{4}-\d{2}-\d{2}/.test(String(x.r.at ?? '')) ? String(x.r.at).slice(0, 10) : '';
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(x);
  }

  const now = new Date();
  const today = ymdOf(now);
  const yesterday = ymdOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const sections = [...byDay].map(([day, list]) => `<tbody>
      <tr class="pt-sec"><td colspan="3"><span class="pt-sec-name">${esc(taskDayLabel(day, today, yesterday))}</span><span class="pt-num">${list.length}</span></td></tr>
      ${list.map((x) => personaTaskRow(x.r, x.colKey)).join('')}
    </tbody>`).join('');

  // 筛空了：说清"是筛的，不是没有"，并给一颗回全部的按钮（省得人去找顶上那条）
  const body = sections
    ? `<table class="pt-tbl">
      <colgroup><col /><col class="pt-col-state" /><col class="pt-col-at" /></colgroup>
      <thead><tr><th>任务</th><th>状态</th><th class="pt-th-at">时间</th></tr></thead>
      ${sections}
    </table>`
    : `<div class="empty" style="padding:28px 4px;line-height:1.9">
        这一档现在没有任务
        <div style="margin-top:8px"><button type="button" class="pt-reset" data-pt-filter="all">看全部 ${nOf.get('all') || 0} 件</button></div>
      </div>`;

  // 2026-11-14 用户口径：底下的口径说明（"跟任务看板同源…"）撤了 —— 说明是给设计者看的，
  // 不是给用户的；这页的交互自解释（点行跳转、筛空了有回全部的按钮）。
  return `${bar}${body}`;
}



/** 任务卡片的点击：三种去向，跟看板上那套走的是同一批入口 */
export function wirePersonaTaskLinks() {
  const view = $('detailView');
  if (!view) return;
  view.querySelectorAll('[data-pt-flow]').forEach((el) => {
    el.onclick = () => openFlowRun(el.dataset.ptTpl || null, el.dataset.ptFlow).catch((e) => toast(e.message, 'error'));
  });
  view.querySelectorAll('[data-pt-conv]').forEach((el) => {
    el.onclick = () => {
      // 先切视图：openConversation 只往 #chat 里写，不切视图的话内容写进隐藏页（看板上踩过）
      setNav('messages');
      openConversation(el.dataset.ptConv).catch((e) => toast(e.message, 'error'));
    };
  });
  view.querySelectorAll('[data-pt-proj]').forEach((el) => {
    el.onclick = () => openProjectDetail(el.dataset.ptProj).catch((e) => toast(e.message, 'error'));
  });
}



/**
 * 「接着最近那段继续聊」——详情页「发消息 / 回到聊天」共用的那一条路。
 *
 * 2026-11 移动端增量从 renderDetail 里提出来成了**模块级导出**：详情页没有 renderDetail
 * 的闭包（persona、toastConvErr 都是闭包里的东西），函数化后从入参拿，桌面行为一个字没变。
 * （曾供"通讯录窄屏点行直接开聊"调用 —— 那条路 2026-11-03 用户拍板改回先看详情，见 contacts.mjs。）
 *
 * 口径（2026-10-24 用户拍板，改掉"每次新开一段"的旧口径 —— 想另起一段去聊天页头的
 * 「新会话」按钮，主流做法：名片「发消息」进的就是现有聊天）：
 *   ① 你**正在聊的那段**最优先 —— "回到"就是回到刚才那儿；
 *   ② 否则最近**真聊过**的一段（空壳让位，和左栏代表会话同一个口径）；
 *   ③ 一段都没有（第一次找TA，或只剩被「不显示」收着的）→ 新建第一段。
 */
/**
 * 在途守卫：同一个人正在"开聊"时再点一次直接忽略（2026-11-28 QA P2）。
 *
 * 为什么必须挡：手机上连点是高频手势，两次调用都发生在 `S.conversations` 刷新前，
 * 会**各自**命中下面的 `post('/api/conversations')` 新建分支 —— 给同一个从未聊过的
 * 员工建出两段空会话，「会话」列表多出空壳行。只对**同一个**人挡（换个人点该放行），
 * 整个函数（含建段 + 打开 + 刷新）走完才清，`finally` 保证报错也不漏。
 */
let directChatOpening = null;

export async function openDirectChat(persona) {
  if (directChatOpening === persona.id) return;   // 双击第二下：第一次还在路上，直接吞掉
  directChatOpening = persona.id;
  try {
    const mine = (S.conversations ?? []).filter((c) => c.kind === 'direct' && c.personaId === persona.id);
    const current = S.conversation?.kind === 'direct' && S.conversation.personaId === persona.id ? S.conversation : null;
    const target = current
      ?? [...mine].sort((a, b) => {
        const ae = !(a.messageCount > 0);
        const be = !(b.messageCount > 0);
        if (ae !== be) return ae ? 1 : -1;
        return String(b.updatedAt).localeCompare(String(a.updatedAt));
      })[0];
    const convId = target
      ? target.id
      : (await post('/api/conversations', { personaId: persona.id, title: `和 ${persona.name}` })).conversation.id;
    /*
     * 从通讯录点人开聊的，记下来源栏：手机上按返回要回**通讯录**，
     * 不是被扔进「会话」列表（主流做法）。桌面窄屏之外没人读这个标记。
     */
    if (S.nav === 'contacts') S.mbBackNav = 'contacts';
    setNav('messages');
    showView('chat');
    /*
     * 走 `openConversationSafe`：复用分支打开的那段，可能刚好被**另一个窗口**删掉了
     * （E2047）—— 那里会关抽屉、清右栏、刷列表，还会说人话。
     * 之后要按"真的打开了没"决定收尾：没打开就别把光标扔进一个已经收起的输入区。
     */
    await openConversationSafe(convId);
    if (S.conversation?.id !== convId) return;
    await load();
    $('input').focus();
  } catch (err) {
    toastConvErr(err);   // 建会话（POST）失败也走同一张人话表
  } finally {
    // 守卫只罩"这一次开聊"：成功 / 失败 / 中途早退都放开，别把这个人锁死在「点不动」的状态
    directChatOpening = null;
  }
}

/* ------------------------------------------ 手机端全屏选择页（mbPicker） */

/*
 * 2026-11-05 用户口径：手机详情页的「运行时 / 模型」不要下拉框，点整行推开一整页
 * iOS 风格的选择页（头部返回栏 + 分组列表 + 选中行打勾）。
 *
 * DOM 由本文件自己建（不进 index.html）：两处入口共用同一张页，每次开页重画列表，
 * 没点过就不存在成本；样式在 mobile.css §20.5。历史口径与详情页折叠同一套 ——
 * 开页压一格、返回手势只退这一格，所以 mobile.mjs 的 popstate / Esc 里各有一行守卫。
 */
let mbPickerEl = null;
let mbPickerOnPick = null;
let mbPickerClosing = false;
// 这次开页铺的原始选项与当前值：搜索框输入时按它们重画（行是每次输入整体重画的，
// 不存一份原文的话，只能对着已被滤掉的 DOM 再滤一次，滤完就回不来了）
let mbPickerItems = [];
let mbPickerValue = '';

/** 首次开页才建 DOM（懒到真用的时候；桌面端永远走不到这里） */
function mbEnsurePicker() {
  if (mbPickerEl) return mbPickerEl;
  const el = document.createElement('div');
  el.id = 'mbPicker';
  el.hidden = true;
  el.innerHTML = `
    <div class="mb-picker-bar">
      <button type="button" class="mb-picker-back" aria-label="返回">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>
      </button>
      <div class="mb-picker-title" id="mbPickerTitle"></div>
    </div>
    <!--
      搜索行（视觉 v2.1）：在**滚动区之外**的固定行 —— 列表滑到哪儿框都在。
      只在调用方传 search:true 时露出来（运行时/模型那两处不传，行为一字不变）。
    -->
    <div class="mb-picker-search" id="mbPickerSearchWrap" hidden>
      <svg class="mb-picker-search-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/></svg>
      <input type="search" id="mbPickerSearch" placeholder="搜索" aria-label="搜索"
             autocomplete="off" spellcheck="false" />
    </div>
    <div class="mb-picker-body">
      <div class="mb-picker-note" id="mbPickerNote" hidden></div>
      <div id="mbPickerList"></div>
    </div>`;
  document.body.appendChild(el);
  el.querySelector('.mb-picker-back').addEventListener('click', () => mbClosePicker());
  /*
   * 输入即过滤：整段列表重画（选项最多几十行，重画比逐行改 display 简单且不会漏恢复）。
   * 重画只碰 #mbPickerList，搜索框在外面 —— 输入焦点不会因为重画被踢掉。
   */
  el.querySelector('#mbPickerSearch').addEventListener('input', (e) => {
    const q = e.target.value;
    mbPaintPicker(
      el.querySelector('#mbPickerList'),
      mbFilterItems(mbPickerItems, q),
      mbPickerValue,
      q.trim() ? '没有匹配的' : '',   // 只有真搜过才说"没有匹配的"（空清单是另一回事）
    );
  });
  /*
   * 行用事件委托：列表每次开页整体重画（运行时 3~5 行、模型 20+ 行），
   * 逐行 addEventListener 只会把旧闭包留在 detached 节点上。
   */
  const list = el.querySelector('#mbPickerList');
  list.addEventListener('click', (e) => {
    const row = e.target.closest('[data-mb-pick]');
    if (!row) return;
    const onPick = mbPickerOnPick;
    mbClosePicker();          // 先收页：回调里的 toast / 文本刷新不能被全屏页盖住
    onPick?.(row.dataset.mbPick);
  });
  // role=button 的 div 不会自己把 Enter/Space 变成 click —— 外接键盘 / 读屏走这条
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('[data-mb-pick]');
    if (!row) return;
    e.preventDefault();
    row.click();
  });
  mbPickerEl = el;
  return el;
}

/** 选中勾用 SVG：字符 ✓ 的粗细/基线各机型不稳，跟返回箭头同一套描边语汇 */
const MB_CHECK_SVG =
  '<svg class="mb-picker-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

/*
 * 画列表（2026-11-05 二版，用户嫌一版丑）：iOS inset grouped 的正确分层 ——
 *   · 每个 header 开一张**新卡**，header 是卡**外**的小节标签（不再挤在卡里当行）；
 *   · header 前的散行（「跟随默认」「清单里没有」）自成第一张卡 —— 推荐项不跟供应商混居；
 *   · 行支持 sub 副标题（「跟随默认」下面写真实默认模型名）。
 */
function mbPaintPicker(host, items, value, emptyText = '') {
  if (!host) return;
  let html = '';
  let rows = '';
  let sec = '';
  const flush = () => {
    if (!rows) return;
    html +=
      (sec ? `<div class="mb-picker-sec">${sec}</div>` : '') +
      `<div class="mb-picker-group">${rows}</div>`;
    rows = '';
    sec = '';
  };
  for (const it of items ?? []) {
    if (it.header) {
      flush();
      sec = esc(it.header);
      continue;
    }
    const on = it.id === value;
    // `disabled`：不可选的行（如"已被别的群关联"的项目）。渲染成灰行、不带 data-mb-pick ——
    // 点击处理器靠 closest('[data-mb-pick]') 找行，没有这个属性就天然点不动（2026-11-17 群详情页用）。
    const off = !!it.disabled;
    // `dot` = 行首那颗 6px 圆点（任务看板的 8 个状态用它带出 --st-* 色）。
    // 写在 label 里面而不是行首的 flex 子项：行首会和文字差出一整个 gap，点多宽就偏多少。
    // label/id 都可能是用户自己起的名字（模型显示名、运行时别名）→ 一律 esc
    rows += `<div class="mb-picker-row${on ? ' on' : ''}${off ? ' off' : ''}" role="button" tabindex="0"${
      off ? ' aria-disabled="true"' : ` data-mb-pick="${esc(it.id)}"`
    }>
        <span class="mb-picker-main">
          <span class="mb-picker-label">${it.dot ? `<i class="mb-picker-dot" style="background:${esc(it.dot)}"></i>` : ''}${esc(it.label)}</span>
          ${it.sub ? `<span class="mb-picker-sub">${esc(it.sub)}</span>` : ''}
        </span>
        ${on ? MB_CHECK_SVG : ''}
      </div>`;
  }
  flush();
  // 搜不到时也要有话说（一行 13px 弱色），不能只留一张空白页
  host.innerHTML = html || (emptyText ? `<div class="mb-picker-empty">${esc(emptyText)}</div>` : '');
}

/*
 * 搜索过滤：按 label 子串（不区分大小写），**组标题跟着它的组一起决定去留** ——
 * header 全空的组留着就是一排空小节标签（"数字员工"下面什么都没有），比不过滤还乱。
 * 返回的是**新的 items 数组**，形状与入参一致，直接可以喂回 mbPaintPicker。
 */
function mbFilterItems(items, q) {
  const kw = String(q ?? '').trim().toLowerCase();
  if (!kw) return items ?? [];
  const out = [];
  let head = null;   // 当前组的 header（散行那一段没有 header）
  let rows = [];
  const flush = () => {
    if (!rows.length) return;
    if (head) out.push(head);
    out.push(...rows);
    rows = [];
    head = null;
  };
  for (const it of items ?? []) {
    if (it.header) { flush(); head = it; continue; }
    if (String(it.label ?? '').toLowerCase().includes(kw)) rows.push(it);
  }
  flush();
  return out;
}

/**
 * 全屏选择页。（2026-11-05 从本文件私有改成 export：手机端「新建任务」页复用同一张页，
 * 四个选择项都走它 —— 再抄一份等于把"开页压一格历史、返回收画面"这套时序搬两遍。）
 *
 * `search`：可选。传 true 才出现搜索行（执行人 / 流程 / 项目这种可能 20+ 项的）；
 * 不传时与从前完全一致（运行时、模型那两处调用一个字都不用改）。
 * `searchPlaceholder`：占位文案按场景分（「搜名字或岗位…」/「搜项目名…」/「搜流程名…」）——
 * 一个通用的「搜索」看不出这一页在搜什么。
 * `host`：把选择页挂到哪个容器里，默认 document.body。**模态弹窗里调用必须传那个 dialog**：
 * `showModal()` 会把弹窗提到浏览器 top layer，body 下无论多高的 z-index 都压不上去 ——
 * 选择页会整页藏在弹窗背后，用户看到的是"点了没反应"（定时任务弹窗 2026-11-06 踩到）。
 */
export function mbOpenPicker({ title = '', note = '', items = [], value = '', search = false, searchPlaceholder = '搜索', host = null, onPick } = {}) {
  const el = mbEnsurePicker();
  /*
   * 挂载点：每次开页都 appendChild 一次。既是"换宿主"（body ↔ dialog），也在宿主被移除后
   * 把节点捞回来 —— 弹窗一关，挂在它里面的选择页跟着被删，mbPickerEl 就成了脱离文档的孤儿，
   * 下一次开页不重新挂就是"什么都不显示"。
   */
  const mountTo = host ?? document.body;
  if (el.parentElement !== mountTo) mountTo.appendChild(el);
  mbPickerClosing = false;
  mbPickerOnPick = typeof onPick === 'function' ? onPick : null;
  const titleEl = el.querySelector('#mbPickerTitle');
  if (titleEl) titleEl.textContent = title;
  const noteEl = el.querySelector('#mbPickerNote');
  if (noteEl) {
    noteEl.textContent = note;
    noteEl.hidden = !note;
  }
  mbPickerItems = items ?? [];
  mbPickerValue = value;
  const searchWrap = el.querySelector('#mbPickerSearchWrap');
  const searchInput = el.querySelector('#mbPickerSearch');
  // 每次开页清空搜索词：上一次搜过的词留在框里，新一页会"莫名少一半选项"
  if (searchInput) {
    searchInput.value = '';
    searchInput.placeholder = searchPlaceholder || '搜索';
  }
  if (searchWrap) searchWrap.hidden = !search;
  mbPaintPicker(el.querySelector('#mbPickerList'), mbPickerItems, value);
  document.body.classList.add('mb-picker-open');
  el.hidden = false;
  /*
   * 滑入分两帧：display:none → 可见那一帧浏览器会跳过 transition，
   * 拆到下一帧再加 class，iOS 那种"从右沿推进来"才跑得出来
   * （prefers-reduced-motion 时 CSS 里 transition:none，等于直接显隐）。
   */
  el.classList.remove('mb-picker-in');
  requestAnimationFrame(() => {
    if (el.hidden) return;   // 这一帧里又被收起来了（连点两下返回）—— 别把它滑回来
    el.classList.add('mb-picker-in');
  });
  if (!history.state?.mbPicker) history.pushState({ mbPicker: true }, '');
}

/**
 * `alreadyPopped` = 这格历史已经被浏览器退掉了（popstate 进来的），只收画面不再退格。
 *
 * ⚠️ 顺序不能反：**先** history.back()、画面留到 popstate 再收。若先摘掉
 * `mb-picker-open` 再 back()，那条 popstate 到时 class 已经没了，mobile.mjs 会当成
 * "详情页该收" —— 用户按一次返回，从选择页直接掉回列表。
 * mbPickerClosing 防连点：「返回」按两下时第二下不能再退一格（否则连详情一起退掉）。
 */
export function mbClosePicker(alreadyPopped = false) {
  if (!document.body.classList.contains('mb-picker-open')) return;
  if (!alreadyPopped && history.state?.mbPicker) {
    if (mbPickerClosing) return;
    mbPickerClosing = true;
    history.back();
    return;
  }
  mbPickerClosing = false;
  document.body.classList.remove('mb-picker-open');
  if (mbPickerEl) {
    mbPickerEl.classList.remove('mb-picker-in');
    mbPickerEl.hidden = true;
  }
  mbPickerOnPick = null;
}

/*
 * 手势返回 / 返回键：这格是选择页自己压的，退回来只收画面。
 * ⚠️ 收画面推到下一拍（setTimeout 0）：本文件与 mobile.mjs 的 popstate 谁先注册不确定，
 * 若本回调当场摘掉 class，排在后面的 mobile.mjs 就把这次返回当成"收详情页"了。
 */
window.addEventListener('popstate', () => {
  if (!document.body.classList.contains('mb-picker-open')) return;
  setTimeout(() => mbClosePicker(true), 0);
});

/* 返回键的层级（navstack.mjs）：选择页在弹窗之上（level 100 > mobile.mjs 的 dialog 90）
   —— 全屏选择页可以挂在弹窗里，先收它才是"退一层"。 */
registerLayer({
  name: 'picker',
  level: 100,
  cell: 'mbPicker',
  active: () => document.body.classList.contains('mb-picker-open'),
  close: () => mbClosePicker(true),
});

// Esc：选择页是详情页的下一级，先收它；弹窗开着时让人家自己吃（同 mobile.mjs 的规矩）
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!document.body.classList.contains('mb-picker-open')) return;
  if (document.querySelector('dialog[open]')) return;
  e.preventDefault();
  mbClosePicker();
});

/**
 * 手机窄屏的员工详情（2026-11 移动端增量；2026-11-03 二改）：「执行配置」四件 +
 * 页头身份（姓名 / 岗位 / 忙闲）+「发消息」。模型是这次按用户口径补上的 ——
 * 只读展示，不做成下拉（换模型是低频配置动作，留给桌面员工详情）。
 *
 * 复用桌面的类名（.detail-body/.p-head/.group/.form-row/.row-label/.switch.sm），
 * 样式天然继承，mobile.css 不用为这页新写规则；监听也只挂精简版用得上的那几个。
 * 保存走自己的 collect —— 桌面版 collect 会读 #dName 等手机上不存在的输入框，直接照搬会炸。
 */
function renderDetailMobile(persona, runtimes) {
  // 按钮文案跟着入口走（与桌面同一口径）：消息页点进详情 = 「回到聊天」，其余 = 「发消息」
  const backToChat =
    S.detailFrom === 'messages' &&
    (S.conversations ?? []).some((c) => c.kind === 'direct' && c.personaId === persona.id);

  /*
   * 详情页重画（换了个人 / 从别处进详情）时把可能开着的选择页收掉：它的 items 与
   * onPick 闭包指着上一个人的值，留着就是一排"点下去改错人"的行。
   */
  mbClosePicker();

  $('detailView').innerHTML = `
    <div class="detail-body mb-emp">
      <!-- 身份卡（mobile.css §20.1）：头像 + 名字 + 岗位/忙闲章。
           桌面 .p-meta 那行「运行时」小章删掉 —— 与下面执行配置卡的「运行时」行
           完全重复，手机上少一行碎章。 -->
      <div class="p-head">
        ${personaAvatar(persona)}
        <div class="p-head-main">
          <h2><span id="dNameText">${esc(persona.name)}</span>${persona.builtin ? '<span class="pill builtin" title="出厂就在的员工：名字、岗位与职责身份随平台固定，不能删">内置</span>' : ''}<span class="pill role" id="dRolePill"${roleNameOf(persona) ? '' : ' style="display:none"'}>${esc(roleNameOf(persona))}</span>${
            persona.busy
              ? `<span class="pill busy" id="dBusy" title="${esc(persona.busyLabel ?? '正在干活')}">${
                  persona.busyLabel ? '工作中·' + esc(persona.busyLabel) : '工作中'
                }</span>`
              : '<span class="pill" id="dBusy">空闲</span>'
          }</h2>
        </div>
      </div>

      <!-- 精简正文：执行配置四件。类名照搬桌面执行配置分区，mobile.css §20.2 重排成
           iOS 分组行（去外框控件、值右对齐） -->
      <div class="group">
        <!-- 运行时 / 模型：iOS 设置那种 value cell（整行可点 + ›），点开是 §20.5 的全屏选择页。
             2026-11-05 用户口径：这两项不要下拉框。 -->
        <div class="form-row mb-nav" id="dRuntimeRow" role="button" tabindex="0">
          <div class="row-label">运行时</div>
          <div class="mb-nav-val"><span id="dRuntimeText"></span><i class="mb-chev" aria-hidden="true"></i></div>
        </div>
        <div class="form-row mb-nav" id="dModelRow" role="button" tabindex="0">
          <div class="row-label">模型</div>
          <!-- 值文本的 id 还是 dModelText（异步补名那段照旧写它），外面多包一层只为放 › -->
          <div class="mb-nav-val"><span id="dModelText">${esc(persona.model || '跟随默认')}</span><i class="mb-chev" aria-hidden="true"></i></div>
        </div>
        <!-- 并发数（2026-11-19 用户拍板）：改为系统固定默认（store/personas.mjs 的
             PERSONA_DEFAULT_MAX_PARALLEL），不再暴露给用户配置 —— 手机、桌面两处同步摘掉。 -->
      </div>

      <!-- 主动作通栏（§20.3）：桌面那颗挤在头右上角的小蓝钮在手机上又重又挤，
           落到正文末尾做整宽主按钮（主流资料页「发消息」同款位）。 -->
      <button class="primary mb-msg-btn" id="dMsg" title="打开和TA的聊天 —— 有会话就接着最近那段聊，不会另开新会话">${backToChat ? '回到聊天' : '发消息'}</button>
    </div>`;

  /*
   * 手机折叠态（2026-11-03）：从**非列表路径**进来的详情（刷新恢复直达 / 项目成员行）
   * 没人打 mb-detail-open，mobile.css 会把整个 main 藏掉 —— 内容画了也看不见，
   * 用户看到的就是"详情页空白"。派事件让 mobile.mjs 补折叠态；从列表行进来的
   * （折叠态已开）它只会把返回栏标题对齐成这个人，不会重复压历史。
   */
  document.dispatchEvent(new CustomEvent('mb-detail', { detail: { title: persona.name } }));

  /* 防抖节奏与桌面版一致：输入 700ms / 下拉 300ms / 开关 200ms / 失焦立刻；串行保存不并发打 PUT */
  let saveTimer = null;
  let saving = false;
  let saveQueued = false;
  const scheduleSave = (ms = 700) => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, ms);
  };

  /*
   * 运行时清单（口径同桌面）：内置员工与专家库雇来的员工（p-expert-*）多一条「自动」——
   * 他们出厂 runtime 就是 'auto'，清单里没有当前值那行会退化成裸 id，而且改成具体
   * 运行时之后再也选不回「自动」（桌面踩过的坑，口径照搬）。
   */
  const rtItems = runtimes.map((r) => ({ id: r.id, label: r.label }));
  if (persona.builtin || String(persona.id ?? '').startsWith('p-expert-'))
    rtItems.unshift({ id: 'auto', label: '自动' });

  /*
   * 两行都改成「点开全屏选择页」（2026-11-05 用户口径：不要下拉框）。
   * 选中的值只活在这两个变量里，页面上那两行是纯展示文本，collect() 从这里取值。
   * curModel 的 '' = 跟随默认（服务端就这么存，与桌面 modelCombo 的 '' 同义）。
   */
  let curRuntime = persona.runtime ?? '';
  let curModel = String(persona.model ?? '').trim();

  const paintRuntime = () => {
    // 清单里找不到就退回原值：宁可显示一个裸 id，也别把那行写成空白
    const hit = rtItems.find((r) => r.id === curRuntime);
    const el = $('dRuntimeText');
    if (el) el.textContent = hit ? hit.label : String(curRuntime ?? '');
  };
  const paintModel = (text) => {
    const el = $('dModelText');
    if (el) el.textContent = text;
  };
  paintRuntime();

  /*
   * 「模型」那行的显示名（2026-11-03 起）：页面上先写现值，清单问到了再换成显示名 ——
   * 清单直接问运行时（readModelList 自带 60s 缓存，与桌面同一份）。
   * 拉不到就算了：这一行的小展示不该因为一次取数失败闹脾气。
   *
   * 注意这里**只补名、不动值**：手机这页没有「刷新」按钮，也没有下拉要喂，
   * 静默把人家绑着的模型改成默认属于"没打招呼就改配置"——对齐只在用户主动换运行时时做。
   */
  const paintModelFromList = async () => {
    if (!curRuntime || curRuntime === 'auto') { paintModel('跟随默认'); return; }
    try {
      const d = await readModelList(curRuntime);
      if (curModel) {
        const hit = (d.models ?? []).find((m) => m.id === curModel);
        // 清单里没有也要留着现值 —— 他配的模型可能只是这台 CLI 这会儿报不出来
        paintModel(hit ? (String(hit.name ?? '').trim() || hit.id) : curModel);
      } else {
        paintModel(d.defaultModel ? '跟随默认 · ' + d.defaultModel : '跟随默认');
      }
    } catch { /* 取不到清单：留着现值 / 「跟随默认」，不为一次取数失败打断这一页 */ }
  };
  paintModelFromList();

  /*
   * 换运行时（选择页选中之后）—— 桌面 fillModels 的手机精简版：
   *   · auto 没有自己的模型清单（问它只会 404）→ 模型只能是「跟随默认」；
   *   · 其余：清单**读到了**才对齐（跨运行时沿用旧模型名本来就不对，桌面同口径），
   *     读不到保留现值（读不到可能只是暂时取不到，盲切会弄丢活绑定）。
   * 改的是人家绑着的模型，切了必须报一声 —— 不说人根本不知道为什么变成默认了。
   */
  const pickRuntime = async (id) => {
    if (id === curRuntime) return;
    curRuntime = id;
    paintRuntime();
    if (id === 'auto') {
      curModel = '';
      paintModel('跟随默认');
      scheduleSave(300);
      return;
    }
    paintModel(curModel || '跟随默认');   // 先显示旧值，别让那行在取数期间空着
    try {
      const d = await readModelList(id);
      const list = d.models ?? [];
      if (curModel && !list.some((m) => m.id === curModel)) {
        toast(`原来绑的 ${curModel} 已不在这台 CLI 的清单里，已切回跟随默认`);
        curModel = '';
      }
      const hit = list.find((m) => m.id === curModel);
      paintModel(
        curModel
          ? (String(hit?.name ?? '').trim() || curModel)
          : (d.defaultModel ? '跟随默认 · ' + d.defaultModel : '跟随默认'),
      );
    } catch {
      paintModel(curModel || '跟随默认');
    }
    // 对齐完再存：否则会把旧模型名存给新运行时
    scheduleSave(300);
  };

  $('dRuntimeRow').onclick = () =>
    mbOpenPicker({ title: '选择运行时', items: rtItems, value: curRuntime, onPick: pickRuntime });

  $('dModelRow').onclick = async () => {
    if (curRuntime === 'auto') { toast('运行时是自动挑的，模型跟着默认走'); return; }
    let d;
    try {
      d = await readModelList(curRuntime);
    } catch (err) {
      toast('取不到模型清单：' + (err?.message ?? '服务异常'), 'error');
      return;   // 打不开选择页就别开：一页「没有匹配」比不开更让人糊涂
    }
    const list = d.models ?? [];
    // 第一项固定「跟随默认」，sub 写**真实**默认模型名 —— 只写"默认"人不知道落到哪个模型
    const items = [{
      id: '',
      label: '跟随默认',
      sub: d.defaultModel ? '默认走 ' + d.defaultModel : '交给 CLI 自己的默认',
    }];
    // 清单里没有也留着现值：宁可显示「清单里没有」，也别当成没配（可能只是这会儿报不出来）
    if (curModel && !list.some((m) => m.id === curModel))
      items.push({ id: curModel, label: '（清单里没有）' + curModel });
    items.push(...modelItems(list));   // 供应商分组 / 撞名补 id，与桌面下拉同一份口径
    // 顶部说明行：有几条、来自哪个运行时 —— 空清单时这里交代原因，页面不至于莫名其妙
    const rtLabel = rtItems.find((r) => r.id === curRuntime)?.label ?? curRuntime;
    const note = list.length
      ? `${list.length} 个模型 · ${rtLabel}`
      : `这台 CLI 没报出模型清单 · ${rtLabel}`;
    mbOpenPicker({
      title: '选择模型',
      note,
      items,
      value: curModel,
      onPick: (id) => {
        curModel = id;
        // 显示名从清单补（真实名 / 撞名 / 默认名），与进页时的补名同一份口径
        paintModelFromList();
        scheduleSave(300);
      },
    });
  };

  /*
   * 两行是 role=button 的 div（不是 <button>）：整行可点、又能吃 .form-row 的栅格重排。
   * 代价是键盘 Enter/Space 不会自动变 click —— 补这一下，读屏 / 外接键盘才点得动。
   */
  for (const rid of ['dRuntimeRow', 'dModelRow']) {
    $(rid)?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      $(rid).click();
    });
  }

  /**
   * 精简版收集器。服务端 PUT /api/personas/:id 是**字段级更新**（store.updatePersona
   * 只覆盖传入的字段），但有两个例外不能省：
   *   · name 必填（缺了直接 E1011 拒掉）；
   *   · instructions 在路由里是无条件 `String(body.instructions ?? '')` —— 缺省会被兜成
   *     空串**清空职责设定**。
   * 所以身份资料必须从现值原样带回；runtime / model 两个才是
   * 精简表单真正能改的字段（model 与桌面同一字段名：'' = 交给 CLI 自己的默认）。
   * 并发数 2026-11-19 摘掉，不传 = 服务端不动库里原值、统一走系统默认。
   */
  const collect = () => ({
    name: persona.name,
    // 岗位不可改（2026-11-11 用户拍板）：不往回送 role —— 服务端对"岗位变了"直接 E2055 拒
    department: persona.department ?? null,
    instructions: persona.instructions ?? '',
    runtime: curRuntime,
    model: curModel,
  });
  let lastSaved = JSON.stringify(collect());

  const saveNow = async ({ keepalive = false } = {}) => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    const payload = collect();
    const json = JSON.stringify(payload);
    if (json === lastSaved) return true;
    if (saving) { saveQueued = true; return false; }
    saving = true;
    try {
      const d = await api('/api/personas/' + encodeURIComponent(persona.id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: json,
        ...(keepalive ? { keepalive: true } : {}),
      });
      lastSaved = json;
      const p = d?.persona;
      if (p) {
        // 与桌面版同一套内存同步：S.persona / 左栏那份 / 页头头像都合回服务端返回值
        //（头像整体重建是因为里面有 <img> 图片层，textContent 会剥掉 —— 见桌面版注释）
        S.persona = { ...(S.persona || {}), ...p };
        const row = (S.personas || []).find((x) => x.id === p.id);
        if (row) Object.assign(row, p);
        const av = $('detailView')?.querySelector('.p-head .avatar');
        if (av) av.outerHTML = personaAvatar(p);
        if (S.nav === 'contacts' || S.nav === 'messages') renderList();
      }
      return true;
    } catch (err) {
      toast('保存失败：' + (err?.message ?? '服务异常'), 'error');
      console.error('[班底] 员工自动保存失败', err?.detail ?? err);
      return false;
    } finally {
      saving = false;
      if (saveQueued) { saveQueued = false; saveNow(); }
    }
  };
  // 离开这一页（切视图 / 打开别的员工 / 关窗口）前兜底存一次 —— showView / openDetail 依赖它 flush
  detailSave.flush = (opts) => saveNow(opts);


  // 「发消息 / 回到聊天」：先落盘再跳（通讯录进来没有未保存表单，saveNow 按 lastSaved 直接跳过）
  $('dMsg').onclick = async () => { await saveNow(); openDirectChat(persona); };
}




/* -------------------------------------------- 飞书子页（员工级，2026-10-29） */

/* 状态词 —— 从设置页搬过来的（设置里的飞书分节已删，员工详情是唯一入口） */
const FEISHU_STATE_TEXT = {
  connected: '已连接',
  connecting: '连接中…',
  reconnecting: '重连中…',
  stopped: '已停止',
  failed: '失败',
};

/* 渲染序号：renderDetail 重建 DOM 会让旧轮询失锚（$ 拿到的是新 DOM 或 null）——
 * 序号守卫 + document.contains 双保险，对不上立刻停轮，别让旧轮询追着新面板写状态 */
let feishuPanelSeq = 0;

/** 第一次点到「飞书」子页才调：拉配置并画面板（懒加载） */
async function mountFeishuPanel(personaId) {
  const seq = ++feishuPanelSeq;
  const host = $('dFeishuHost');
  if (!host) return;
  let cfg = null;
  try {
    cfg = await api('/api/personas/' + encodeURIComponent(personaId) + '/feishu');
  } catch (e) {
    if (seq === feishuPanelSeq) host.innerHTML = `<div class="empty">${esc(e?.message ?? String(e))}</div>`;
    return;
  }
  if (seq !== feishuPanelSeq || !document.contains(host)) return;
  paintFeishuPanel(personaId, cfg, seq);
}

/** 面板结构（2026-10-29 重排）：
 *  ① 通道卡打头 —— 顶部一条状态横幅（色点 + 状态词 + 一句话说明 + 启停按钮），
 *     下面接表单（标签左列 / 输入居中 / 行尾动作），动作条右对齐收底；
 *  ② 「第一次接」四步指引收进 <details>：没配过凭据默认展开，配过默认收起，
 *     想再看随时点开 —— 不再让一段四行小字常驻占半屏。
 *  去掉了「私聊绑定」—— 员工级后每个应用就绑定在那一个员工身上，没有再挑一层的概念 */
function paintFeishuPanel(personaId, cfg, seq) {
  const host = $('dFeishuHost');
  if (!host) return;
  const configured = !!cfg?.configured;
  const running = ['connected', 'connecting', 'reconnecting'].includes(cfg?.status?.state);
  const apiBase = '/api/personas/' + encodeURIComponent(personaId) + '/feishu';

  host.innerHTML = `
    <section class="fs-sec">
      <div class="fs-hero" id="fsHero" data-st="stopped">
        <span class="fs-dot" aria-hidden="true"></span>
        <div class="fs-hero-main">
          <div class="fs-hero-title"><b>飞书通道</b><span class="fs-state" id="fsStateTag">…</span></div>
          <div class="fs-hero-sub" id="fsStatus"></div>
        </div>
        <div class="fs-hero-side">
          <!-- 开机自启（2026-10-29 用户要求：做成开关放右上角）—— 拨一下立刻存，
               不跟着「保存配置」走：它是个"常驻策略"，跟改凭据不是一类动作 -->
          <label class="fs-auto" title="开机自启：应用启动时自动拉起这个通道（拨动即刻保存）">
            <span>开机自启</span>
            <span class="switch sm"><input type="checkbox" id="fsEnabled" ${cfg?.enabled ? 'checked' : ''} /><span></span></span>
          </label>
          <button id="fsToggle">${running ? '停止通道' : '启动通道'}</button>
        </div>
      </div>
      <div class="fs-card">
        <div class="fs-row">
          <span class="row-label">App ID</span>
          <input id="fsAppId" value="${esc(cfg?.appId ?? '')}" autocomplete="off" spellcheck="false"
                 placeholder="cli_…" />
          <span></span>
        </div>
        <div class="fs-row">
          <span class="row-label">App Secret</span>
          ${
            configured
              ? `<input id="fsSecret" class="locked" type="password" value="${esc(cfg?.appSecretHint ?? '')}" readonly data-locked="1"
                      aria-label="已保存的 Secret，只显示掩码" autocomplete="off" />
                 <button id="fsSecretEdit">修改</button>`
              : `<input id="fsSecret" type="password" placeholder="粘贴 App Secret（保存后只显示掩码）" autocomplete="off" />
                 <span></span>`
          }
        </div>
        <div class="fs-row">
          <span class="row-label">允许的人</span>
          <input id="fsAllow" value="${esc((cfg?.allowOpenIds ?? []).join(', '))}" autocomplete="off" spellcheck="false"
                 placeholder="open_id，逗号分隔；留空不限制" />
          <span></span>
        </div>
        <div class="fs-actions">
          <!-- 自动保存（2026-10-29 用户要求）：「保存配置」按钮已去掉，这一行左边只留状态
               —— 改动即存，人不用再惦记"有没有保存" -->
          <span class="fs-save" id="fsSaveHint" data-st="idle">${configured ? '改动自动保存' : '填好凭据后自动保存'}</span>
          <button id="fsTest">测试连接</button>
        </div>
      </div>
    </section>
    <details class="fs-sec fs-guide" ${configured ? '' : 'open'}>
      <summary>
        <b>第一次接？四步接上</b>
        <span class="set-tag">一次性 · 约 10 分钟</span>
        <span class="fs-guide-chev" aria-hidden="true">▾</span>
      </summary>
      <ol class="fs-steps">
        <li><span class="fs-step-n">1</span>
          <div>这个应用就是这个员工的<b>专属机器人</b> —— 私聊它 = 直接找他；群里 @它 才响应。</div></li>
        <li><span class="fs-step-n">2</span>
          <div><a href="https://open.feishu.cn/app" target="_blank" rel="noreferrer">去飞书开放平台建一个「企业自建应用」</a>。</div></li>
        <li><span class="fs-step-n">3</span>
          <div>「事件与回调」：订阅方式选<b>长连接</b>（选成请求地址会永远收不到消息），添加事件 <code>im.message.receive_v1</code>。</div></li>
        <li><span class="fs-step-n">4</span>
          <div>「权限管理」：开「获取与发送单聊、群组消息」和「更新应用发送的消息卡片」，发布应用版本。</div></li>
        <li><span class="fs-step-n">5</span>
          <div>回来把 App ID / App Secret 填在上面，点<b>「启动通道」</b>。</div></li>
      </ol>
    </details>`;

  const status = (html) => {
    const el = $('fsStatus');
    if (el) el.innerHTML = html;
  };
  /* 各状态的横幅副标题：色点与状态词只说"什么状态"，这句话说"意味着什么 / 下一步干嘛" */
  const FS_STATE_SUB = {
    connected: '长连接已建立 —— 私聊它、或在群里 @它 都能叫到这个员工',
    connecting: '正在与飞书建立长连接…',
    reconnecting: '连接断开了，正在自动重连…',
    stopped: '通道未运行 —— 凭据填好后点「启动通道」',
    failed: '',
  };
  const paintStatus = (st) => {
    const s = st?.status ?? {};
    const state = s.state ?? 'stopped';
    const word = FEISHU_STATE_TEXT[state] ?? '已停止';
    const tag = $('fsStateTag');
    if (tag) tag.textContent = word;
    const hero = $('fsHero');
    if (hero) hero.dataset.st = state;
    const sub = $('fsStatus');
    if (!sub) return;
    sub.innerHTML =
      state === 'failed'
        ? esc(s.lastError || '启动失败，看看服务日志里飞书那几行')
        : (FS_STATE_SUB[state] ?? FS_STATE_SUB.stopped);
  };
  paintStatus(cfg);

  /* 「修改」解锁 Secret 框：清掉掩码变可编辑，语义是"这次保存会覆盖旧 Secret"；
     解锁后按钮变「取消」，点它退回掩码锁定态（输入了一半的值直接丢弃，保存仍走"保留原值"） */
  const fsSecretHint = cfg?.appSecretHint ?? '';
  $('fsSecretEdit')?.addEventListener('click', () => {
    const k = $('fsSecret');
    if (!k.dataset.locked) {
      k.readOnly = true;
      k.classList.add('locked');
      k.dataset.locked = '1';
      k.value = fsSecretHint;
      k.placeholder = '';
      $('fsSecretEdit').textContent = '修改';
      return;
    }
    k.readOnly = false;
    k.classList.remove('locked');
    k.removeAttribute('data-locked');
    k.value = '';
    k.placeholder = '重新粘贴 App Secret（留空则保留原值）';
    k.focus();
    $('fsSecretEdit').textContent = '取消';
  });

  /* 开机自启开关（2026-10-29）：拨动即刻 PUT —— 它是个常驻策略，不该等人再点一次
     「保存配置」。服务端 PUT 里 enabled 为真会顺手拉起通道、为假会停掉，语义正好。
     保存失败（比如凭据还没填齐 → E2061）就把开关拨回去，别让界面显示一个没存下的状态。 */
  $('fsEnabled')?.addEventListener('change', async (ev) => {
    const cb = ev.target;
    const want = cb.checked;
    const k = $('fsSecret');
    const body = {
      appId: $('fsAppId').value.trim(),
      allowOpenIds: $('fsAllow').value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean),
      enabled: want,
    };
    // 只把"这次真的改过"的 secret 带上；锁着的掩码绝不能当新值提交
    if (k && !k.dataset.locked && k.value) body.appSecret = k.value;
    cb.disabled = true;
    try {
      await api(apiBase, { method: 'PUT', body: JSON.stringify(body) });
      toast(want ? '开机自启已开 —— 应用启动时自动拉起通道' : '开机自启已关 —— 启动时不再拉起通道', 'ok');
      mountFeishuPanel(personaId);
    } catch (e) {
      cb.checked = !want;
      cb.disabled = false;
      toast(e.message, 'error');
    }
  });

  /* 自动保存（2026-10-29 用户要求：去掉「保存配置」按钮）——
     三个输入框改动即存：打字时 900ms 防抖，失焦（change）立刻存。
     本地先按服务端同一套规矩预检（App ID 形状 / 凭据齐不齐），不合格只提示不发请求 ——
     自动保存绝不能出现"边打字边弹报错"。 */
  const APP_ID_RE = /^cli_[0-9a-f]{16}$/i;
  const saveHint = (text, st = 'idle') => {
    const el = $('fsSaveHint');
    if (!el) return;
    el.textContent = text;
    el.dataset.st = st;
  };
  const savedAt = () => new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
  let saveTimer = 0;
  let saving = false;
  let saveQueued = false;

  const collectConfig = () => {
    const k = $('fsSecret');
    return {
      body: {
        appId: ($('fsAppId')?.value ?? '').trim(),
        allowOpenIds: ($('fsAllow')?.value ?? '').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean),
        enabled: !!$('fsEnabled')?.checked,
      },
      newSecret: k && !k.dataset.locked ? k.value.trim() : '',
    };
  };

  const saveNow = async () => {
    clearTimeout(saveTimer);
    if (saving) { saveQueued = true; return; }
    const { body, newSecret } = collectConfig();
    if (!body.appId) return saveHint('填上 App ID 和 App Secret 就会自动保存');
    if (!APP_ID_RE.test(body.appId)) return saveHint('App ID 还没填完 —— 它长这样：cli_ 加 16 位十六进制');
    if (!newSecret && !configured) return saveHint('再填上 App Secret 就会自动保存');
    if (newSecret) body.appSecret = newSecret;
    saving = true;
    saveHint('保存中…', 'busy');
    try {
      await api(apiBase, { method: 'PUT', body: JSON.stringify(body) });
      saving = false;
      if (newSecret) {
        // 新 Secret 存下了：换回掩码锁定态。整页重画最省事 —— 此刻焦点本来也不在框里；
        // 重画会把这行状态复位，所以等它画完再补一次"已保存"，别让人以为没存
        toast('App Secret 已保存', 'ok');
        await mountFeishuPanel(personaId);
        // 不复用外层 seq 判等 —— mountFeishuPanel 自己会 ++feishuPanelSeq，比完永远不等
        saveHint('已保存 · ' + savedAt(), 'ok');
        return;
      }
      saveHint('已保存 · ' + savedAt(), 'ok');
      if (saveQueued) { saveQueued = false; saveNow(); }
    } catch (e) {
      saving = false;
      saveQueued = false;
      saveHint(e.message, 'err');
    }
  };

  for (const id of ['fsAppId', 'fsAllow']) {
    const el = $(id);
    if (!el) continue;
    el.addEventListener('input', () => { saveHint('未保存…', 'busy'); clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 900); });
    el.addEventListener('change', saveNow);
  }
  // Secret 只在失焦/回车时存：边打字边存会在 900ms 的停顿处把输入框换成掩码，太打断
  $('fsSecret')?.addEventListener('change', () => {
    const k = $('fsSecret');
    if (!k || k.dataset.locked) return;
    if (!k.value.trim()) {
      saveHint(configured ? '留空 = 保留原来的 Secret' : '再填上 App Secret 就会自动保存');
      return;
    }
    saveNow();
  });

  $('fsTest')?.addEventListener('click', async () => {
    status('<span style="color:var(--dim)">测试中…</span>');
    try {
      await api(apiBase + '/test', { method: 'POST', body: '{}' });
      status('<b style="color:var(--ok)">凭据有效</b> —— 飞书认这套 App ID / App Secret');
    } catch (e) {
      status(`<b style="color:var(--bad,#c0504d)">凭据不对</b> —— ${esc(e.message)}`);
    }
  });

  $('fsToggle')?.addEventListener('click', async () => {
    const btn = $('fsToggle');
    btn.disabled = true;
    try {
      await api(apiBase + (btn.textContent === '停止通道' ? '/stop' : '/start'), { method: 'POST', body: '{}' });
      mountFeishuPanel(personaId);
    } catch (e) {
      toast(e.message, 'error');
      btn.disabled = false;
    }
  });

  /* 状态轮询：只在面板可见且详情页还开着时轮 ——
     面板藏了（切了子页/标签）不发请求，详情页关了（DOM 换了）整轮停掉 */
  const guard = setInterval(async () => {
    if (seq !== feishuPanelSeq || !document.contains(host)) {
      clearInterval(guard);
      return;
    }
    const panel = host.closest('[data-ov-panel]');
    if (!panel || panel.hidden) return;
    try {
      const st = await api(apiBase);
      if (seq !== feishuPanelSeq || !document.contains(host)) {
        clearInterval(guard);
        return;
      }
      paintStatus(st);
      const nowRunning = ['connected', 'connecting', 'reconnecting'].includes(st?.status?.state);
      const btn = $('fsToggle');
      if (btn && !btn.disabled) btn.textContent = nowRunning ? '停止通道' : '启动通道';
    } catch { /* 拉不到就等下一拍 */ }
  }, 5000);
}

export function renderDetail({ persona, runtimes, runs, platformRoot, skills: personaSkills = [], allSkills = [] }, taskBoard = null) {
  // 左栏顶上写「通讯录」（右页头已去掉；名字/岗位/头像/动作都在正文的 p-head 里）。
  // 只在"左栏就是通讯录"时写 —— 从聊天页头点「查看资料」进来时 S.nav 还是 messages，
  // 那一栏里是会话，标题写上「通讯录」会跟下面的列表对不上。
  // 2026-10-20 用户要求：通讯录详情**不做面包屑**，标题就固定「通讯录」。
  if (S.nav === 'contacts') setListTitle('通讯录');
  refreshDeptSuggest(); // 部门建议列表跟着库里已用的部门走（#deptSuggest，下面 dDept 用）

  /*
   * 手机窄屏（2026-11 移动端增量）：详情页精简成「执行配置」三件，走独立的渲染与
   * 保存收集器（renderDetailMobile，见上面）。桌面整页实现（tabs / 资料 / 沙箱 / 模型 /
   * 技能 / 运行记录）原样留在下面，一行不动 —— isMobile 判 body 状态类（mobile.mjs
   * 维护），>900px 恒为假，桌面行为与改动前完全一致。
   */
  if (document.body.classList.contains('mb-narrow')) {
    renderDetailMobile(persona, runtimes);
    return;
  }

  const rt = runtimes.find((r) => r.id === persona.runtime);
  // 身份/技能锁定（2026-10-23；2026-10-22 用户定：内置员工按专家团那个模式收编）
  // 两种来源同一套语义，判据与服务端 experts.lockKindOf 对齐：
  //   expert  = 专家库雇来的（固定 id 前缀 p-expert-），随专家包固定，出路是解聘后自建；
  //   builtin = 出厂的（现在是崔老三），随平台固定，出路是另建一个员工。
  // 锁的只是「他是谁 + 他会什么」；运行时/沙箱/工作目录/模型/头像仍旧可改。
  const expertLocked = String(persona.id || '').startsWith('p-expert-');
  const builtinLocked = !expertLocked && !!persona.builtin;
  const identityLocked = expertLocked || builtinLocked;
  const runRows = runs.length
    ? runs.map((r) => `<tr>
        <td>${dt(r.startedAt)}</td>
        <td class="st-${esc(r.status)}">${esc(r.status)}</td>
        <td>${r.exitCode ?? '—'}</td>
        <td>${r.usage ? (r.usage.totalTokens ?? '—') : '—'}</td>
        <td>${r.endedAt ? Math.round((new Date(r.endedAt) - new Date(r.startedAt)) / 1000) + 's' : '—'}</td>
        <td class="dim">${esc(r.error || '')}</td>
      </tr>`).join('')
    : '<tr><td colspan="6" class="dim" style="padding-top:8px">还没有运行记录</td></tr>';

  // 头上去掉「N 个技能」「最近运行」两个 pill，改成显示工作目录绑定的项目名
  // （2026-11-19 用户）：root 跟 persona.cwd 对上的那个项目；对不上就把自定义路径原样挂上。
  const cwdProject = (S.projects ?? []).find(
    (p) => String(p.root ?? '').trim() === String(persona.cwd ?? '').trim(),
  );

    $('detailView').innerHTML = `
    <div class="detail-body">
      <div class="p-head">
        ${personaAvatar(persona)}
        <div class="p-head-main">
          <h2><span id="dNameText">${esc(persona.name)}</span>${persona.builtin ? '<span class="pill builtin" title="出厂就在的员工：名字、岗位与职责身份随平台固定，不能删">内置</span>' : ''}<span class="pill role" id="dRolePill"${roleNameOf(persona) ? '' : ' style="display:none"'}>${esc(roleNameOf(persona))}</span>${
            persona.busy
              ? `<span class="pill busy" id="dBusy" title="${esc(persona.busyLabel ?? '正在干活')}">${
                  persona.busyLabel ? '工作中·' + esc(persona.busyLabel) : '工作中'
                }</span>`
              : '<span class="pill" id="dBusy">空闲</span>'
          }</h2>
          <!-- 顶部那段职责描述（p-desc）按用户要求去掉了：下面「资料」里本来就有完整的「职责与身份设定」 -->
          <!-- 运行时放第二行（2026-10-17 用户要求）：名字旁边只留岗位和忙闲，引擎属于"配置"不是"身份" -->
          <div class="p-meta">
            <span class="pill">${esc(rt ? rt.label : persona.runtime === 'auto' ? '自动' : persona.runtime)}</span>
            <span class="pill">${esc(SANDBOX_LABEL[persona.sandbox] ?? persona.sandbox)}</span>
            ${
              // 2026-11-19 用户：「N 个技能」「最近运行」两个 pill 去掉，换成工作目录对应的项目名。
              // 对得上项目库 → 显示项目名（悬停看路径）；对不上的自定义路径 → 原样挂路径；没绑 → 不显示。
              cwdProject
                ? `<span class="pill" title="${esc(cwdProject.root)}">${esc(cwdProject.name || cwdProject.root)}</span>`
                : persona.cwd
                  ? `<span class="pill" title="自定义目录，不在项目库">${esc(persona.cwd)}</span>`
                  : ''
            }
          </div>
        </div>
        <div class="hero-actions">
          <button class="primary" id="dMsg" title="打开和TA的聊天 —— 有会话就接着最近那段聊，不会另开新会话">${S.detailFrom === 'messages' && (S.conversations ?? []).some((c) => c.kind === 'direct' && c.personaId === persona.id) ? '回到聊天' : '发消息'}</button>
          <div class="hero-more">
            <button type="button" class="hero-more-btn" id="dMore" title="更多操作">⋯</button>
            <div class="hero-more-menu" id="dMoreMenu" hidden>
              ${persona.builtin
                ? '<button class="danger" id="dDelete" disabled title="内置员工不能删（名字/职责/技能随平台固定）">内置 · 不可删</button>'
                : persona.id.startsWith('p-expert-')
                  ? // 专家库雇来的（固定 id p-expert-<key>）：走「解聘」—— 服务端同一条
                    // fire 路由（群助手占用会给 409 人话），再雇佣同一个 id 接上旧会话
                    '<button class="danger" id="dFire">解聘这个数字员工</button>'
                  : '<button class="danger" id="dDelete">删除这个数字员工</button>'}
            </div>
          </div>
        </div>
      </div>

      <div class="tabs">
        <!-- 2026-11-19 用户连改：去掉「能力」tab；又去掉「资料」子页（身份字段搬进配置的基本信息），
             运行记录直接铺在原概览页；最后把「配置」和「运行记录」（原概览，已改名）交换位置，
             顺序变成 配置 / 任务 / 运行记录。配置放第一，打开人就先看到基本信息。 -->
        <button class="tab on" data-tab="config">配置</button>
        <button class="tab" data-tab="tasks">任务<span class="tab-n" id="dTasksN">${taskBoard?.total ?? 0}</span></button>
        <button class="tab" data-tab="overview">运行记录</button>
      </div>

      <section class="tab-panel" data-panel="overview">
        <!-- 2026-11-19 用户拍板去掉「资料」子页：身份字段（名字/岗位/部门/职责）整体搬进
             「配置」tab 的「基本信息」子页。概览只剩运行记录一页，二级导航（ov-nav）随之取消，
             表格直接铺在这里 —— 一页就不需要再点一层。 -->
        <div class="group">
          <table class="runs"><thead><tr>
            <th>时间</th><th>状态</th><th>退出码</th><th>tokens</th><th>耗时</th><th>错误</th>
          </tr></thead><tbody>${runRows}</tbody></table>
        </div>
      </section>

      <!-- 配置 tab（2026-11-19 起）：基本信息 / 执行配置 / 飞书 三个子页 -->
      <section class="tab-panel" data-panel="config" hidden>
        <div class="ov-layout">
          <nav class="ov-nav" aria-label="配置分区">
            <!-- 2026-11-19 用户拍板：原「概览 → 资料」子页整体搬进来，成为配置的第一页。
                 身份字段（名字/岗位/部门/职责）在这里，默认打开就看到。 -->
            <button type="button" class="on" data-ov="basic">基本信息</button>
            <button type="button" data-ov="exec">执行配置</button>
            <!-- 2026-10-29 用户定稿：飞书从「设置」搬进来，员工级 —— 一个数字员工一个飞书自建应用 -->
            <button type="button" data-ov="feishu">飞书</button>
          </nav>
          <div class="ov-body">
            <!-- 基本信息（原概览「资料」子页，2026-11-19 搬来）：DOM id 全部原样保留，
                 保存 / 同步 / 职责设定编辑逻辑零改动。 -->
            <section class="ov-panel" data-ov-panel="basic">
              <div class="group">
                <!-- 「名字/岗位…随平台固定」提示条摘掉（2026-11-15 用户实报）：
                     锁定这件事输入框的 readonly + 悬停 title 已经说了，横幅纯属重复。
                     内置和专家包雇佣两个分支共用它，一并去掉。 -->
                <div class="form-row">
                  <div class="row-label">名字</div>
                  <input id="dName" value="${esc(persona.name)}" ${identityLocked ? `readonly title="${expertLocked ? '雇佣员工的名字随专家包固定' : '内置员工的名字随平台固定'}"` : ''} />
                </div>
                <div class="form-row">
                  <div class="row-label">岗位</div>
                  <div>
                    <!-- 岗位固定（2026-11-11 用户拍板：不允许调岗）：只读展示。
                         岗位决定权限，换岗 = 解聘后重新雇佣；服务端对"岗位变了"也直接拒（E2055）。 -->
                    <div class="ro" id="dRoleText">${esc(roleNameOf(persona) || '未设岗位')}</div>
                  </div>
                </div>
                <div class="form-row">
                  <div class="row-label">部门</div>
                  <div>
                    <!-- 部门**不进身份锁**（2026-10-25）：锁的是"他是谁/他会什么"，组织归属是用户的权 ——
                         雇佣专家只带出厂默认（技术部/内容部/行政部），之后随便调、也能清空落「未分配」 -->
                    <input id="dDept" list="deptSuggest" placeholder="比如：技术部（留空 = 未分配）" value="${esc(persona.department || '')}" />
                  </div>
                </div>
                <div class="form-row top">
                  <div class="row-label">职责与身份设定</div>
                  <div>
                    <!-- 预览/编辑（2026-10-21）：这个字段写少读多，默认预览。
                         预览渲染的是 textarea 现值（当前草稿），不是存库值 —— 编辑一半切过去不丢字 -->
                    <!-- 框头合成（2026-10-22 用户定稿）：字数 + 预览/编辑切段贴在框上沿当"框头"，
                         不再悬空一行 —— 右边不孤零零飘按钮，左边由字数补位不显空 -->
                    <div class="instr-wrap">
                      <div class="instr-head">
                        <div class="counter" id="dInstrCount"></div>
                        ${
                          /* 身份锁定：被锁员工（雇佣专家 / 内置员工）不画预览/编辑切换 —— 只读预览，下面的监听都带 ?. 兜底 */
                          identityLocked
                            ? ''
                            : `<div class="seg seg-sm" id="dInstrSeg">
                                <button type="button" data-m="view" class="on">预览</button>
                                <button type="button" data-m="edit">编辑</button>
                              </div>`
                        }
                      </div>
                      <div id="dInstrView" class="md-view"></div>
                      <!-- 高度不写死（2026-10-21）：随内容撑开（fitInstr），滚动只留外层页面 -->
                      <textarea id="dInstr" hidden ${identityLocked ? 'readonly' : ''}>${esc(persona.instructions)}</textarea>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <section class="ov-panel" data-ov-panel="exec" hidden>
              <div class="group">
                <div class="form-row">
                  <div class="row-label">Runtime</div>
                  <div id="dRuntimeMount"></div>
                </div>
                <div class="form-row">
                  <div class="row-label">权限（沙箱）</div>
                  <div id="dSandboxMount"></div>
                </div>
                <div class="form-row">
                  <div class="row-label">模型</div>
                  <div>
                    <div class="row-with-btn">
                      <div id="dModelComboMount" style="flex:1;min-width:0"></div>
                      <button type="button" id="dModelRefresh" title="重新向运行时取一次模型列表（CLI 那边清单变了就点它）">刷新</button>
                    </div>
                    <div class="counter left" id="dModelNote"></div>
                  </div>
                </div>
                <div class="form-row">
                  <!-- 工作目录从「手敲路径」改成「选项目」（2026-11-19 用户：项目一多，敲路径
                       容易写错、写错地方还安静地不报错）。选项 = 项目库，见下方 cwdCombo。 -->
                  <div class="row-label">工作目录</div>
                  <div id="dCwdMount"></div>
                </div>
                <!-- 附加目录输入框摘掉（2026-11-15 用户实报「没啥用」）：完全权限模式下
                     这几行本来就没约束力，只有切回沙箱才有意义。已存的 rootDirs **保留在库里**：
                     collect() 不再传这个字段，服务端「不传不动」；将来要恢复沙箱编辑再把这个
                     form-row 加回来即可。 -->
                <!-- 并发数（2026-11-19 用户拍板）：改为系统固定默认（store/personas.mjs 的
                     PERSONA_DEFAULT_MAX_PARALLEL），不再暴露给用户配置。输入框摘掉，
                     已存的 maxParallel 保留在库里、服务端机制不动（smoke 靠它造"忙"场景）。 -->
              </div>
            </section>

            <!-- 飞书（2026-10-29 员工级）：内容懒加载 —— 先给骨架，第一次点到才拉配置
                 （renderDetail 每次重建 DOM，每次都多发一个请求就太吵了），见 mountFeishuPanel -->
            <section class="ov-panel" data-ov-panel="feishu" hidden>
              <div id="dFeishuHost"><div class="empty">加载中…</div></div>
            </section>
          </div>
        </div>
      </section>

      <section class="tab-panel" data-panel="tasks" hidden>
        <div class="pt-head">
          <span class="pt-sum" id="dTasksSum"></span>
          <!-- 不用 .mini：那是 26×26 的单字方钮（测/改/停/卸），两个字放进去必折行（2026-10-20 截图） -->
          <button id="dTasksRefresh" title="重新取一次 —— 任务在别处变了（派了活、跑完一步）就点它">刷新</button>
        </div>
        <div id="dTasksBody"></div>
      </section>

    </div>`;
  // 子页导航（2026-11-19：只剩「配置」一套 —— 基本信息/执行配置/飞书；
  // 概览的「资料/运行记录」子导航已取消，运行记录直接铺在概览页）。
  // 切之前先落盘 —— 藏起来的那栏改动不能丢
  const ovBtns = $('detailView').querySelectorAll('[data-ov]');
  const ovPanels = $('detailView').querySelectorAll('[data-ov-panel]');
  const showOv = (key) => {
    ovBtns.forEach((b) => b.classList.toggle('on', b.dataset.ov === key));
    ovPanels.forEach((p) => { p.hidden = p.dataset.ovPanel !== key; });
  };
  // 「飞书」子页懒加载（2026-10-29 员工级）：面板内容先骨架，第一次点到才拉配置。
  // 只在 renderDetail 建的这份 DOM 上挂一次 —— 重建后 feishuLoaded 归零，新面板重新懒加载
  let feishuLoaded = false;
  ovBtns.forEach((b) => {
    b.onclick = () => {
      saveNow?.();
      showOv(b.dataset.ov);
      if (b.dataset.ov === 'feishu' && !feishuLoaded) {
        feishuLoaded = true;
        mountFeishuPanel(persona.id);
      }
    };
  });

  // 标签：一次渲染、切显隐 —— 不重建 DOM，所以在「概览」改了一半去「能力」再回来，改动还在
  const tabs = $('detailView').querySelectorAll('[data-tab]');
  const panels = $('detailView').querySelectorAll('[data-panel]');
  // 默认子页（2026-11-19）：概览无子页（面板内已无 ov-panel，showOv 传什么都无妨）；
  // 配置 → 基本信息（原「资料」，搬进来后设为默认打开）。
  const OV_DEFAULT = { config: 'basic' };
  const showTab = (key) => {
    tabs.forEach((t) => t.classList.toggle('on', t.dataset.tab === key));
    panels.forEach((p) => { p.hidden = p.dataset.panel !== key; });
    showOv(OV_DEFAULT[key] ?? 'basic');
  };
  tabs.forEach((t) => {
    t.onclick = () => {
      saveNow?.(); // 换页前把表单改动落盘（没改动时 saveNow 按 lastSaved 直接跳过）
      showTab(t.dataset.tab);
    };
  });
  // 默认落在「配置」（2026-11-19 排到第一位后）—— 打开人先看基本信息，而不是常空的运行记录
  showTab('config');

  /*
   * 任务页：数据是**打开这一页那一刻**取的快照（跟「运行记录」一样）。
   * 「刷新」只换这一页里的三块（合计 / 列表 / 标签上的数），**不重画整页** ——
   * 重画会把标签弹回「概览」，人刚翻到任务页就被弹走，比不刷新更烦。
   *
   * 状态筛选也走这条重画路（只重画 #dTasksBody）：数据不动，换的只是"哪些行进表"。
   * 筛选状态留在闭包里，所以「刷新」之后人还在自己看的那一档上。
   */
  let tasksData = taskBoard;
  let tasksFilter = 'all';
  const paintTasks = () => {
    const sum = $('dTasksSum');
    if (sum) {
      sum.innerHTML = !tasksData || tasksData.error
        ? `任务取不到${tasksData?.error ? `：${esc(tasksData.error)}` : ''}`
        : `共 <b>${tasksData.total ?? 0}</b> 件${tasksData.project_count ? ` · 分布在 ${tasksData.project_count} 个项目` : ''}`;
    }
    const body = $('dTasksBody');
    if (body) body.innerHTML = personaTasksHtml(tasksData, tasksFilter);
    const n = $('dTasksN');
    if (n) n.textContent = String(tasksData?.error ? '—' : (tasksData?.total ?? 0));
    wirePersonaTaskLinks();
  };
  paintTasks();

  // 筛选条是**委托**在 #dTasksBody 上的：表格每次重画都会换掉里面的按钮，
  // 一个个 addEventListener 存不住；委托一次，重画多少次都还在。
  $('dTasksBody')?.addEventListener('click', (e) => {
    const chip = e.target?.closest?.('[data-pt-filter]');
    if (!chip) return;
    const next = chip.dataset.ptFilter || 'all';
    if (next === tasksFilter) return;
    tasksFilter = next;
    paintTasks();
  });

  $('dTasksRefresh')?.addEventListener('click', async (e) => {
    e.preventDefault();
    const btn = $('dTasksRefresh');
    btn.disabled = true;
    btn.textContent = '刷新中…';
    try {
      tasksData = await api('/api/personas/' + encodeURIComponent(persona.id) + '/tasks');
    } catch (err) {
      tasksData = { error: err.message };
    } finally {
      btn.disabled = false;
      btn.textContent = '刷新';
      paintTasks();
    }
  });

  /* ---------------- 自动保存（2026-10-18 用户要求：不再点「保存」） ----------------
   * 这里只放骨架：真正的 saveNow 在 combos 建好后再赋值（它要读三个下拉的当前值）。
   * 输入框防抖 700ms；下拉选完 300ms；失焦 / 切分区 / 切标签 / 离开页面立刻 flush。 */
  const saveStateEl = $('dSaveState');
  const setSaveState = (text, kind = '') => {
    if (!saveStateEl) return;
    saveStateEl.textContent = text;
    saveStateEl.className = 'save-state' + (kind ? ' ' + kind : '');
  };
  let saveTimer = null;
  let saveNow = null;      // combos 建好后赋值
  let saveQueued = false;  // 保存中又来一次改动 → 存完再补一次（串行，不并发打 PUT）
  const scheduleSave = (ms = 700) => {
    setSaveState('未保存…', 'wait');
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; saveNow?.(); }, ms);
  };

  // 模型：带搜索（23 个起步，不搜找不到）；Runtime / 权限选项少，不带搜索
  const modelCombo = createCombo({
    mount: $('dModelComboMount'),
    items: [{ id: '', label: '默认' }],
    value: String(persona.model ?? '').trim(),
    search: true,
    placeholder: '搜模型…（id 或显示名）',
    empty: '没有匹配的模型',
    onChange: () => scheduleSave(300),
  });

  /**
   * 模型下拉的清单 —— **直接问运行时**（服务端去读 CLI 自己那份配置），不再走账本。
   *
   * 为什么按运行时问：模型列表在 CLI 背后的服务端手里，不在班底手里。
   * 每个族问法不同（codex 读本地目录文件、dsh 发一次 HTTP、claude 读 settings.json /
   * 网关 /v1/models），这些差异由服务端的 cli-models 收拾掉。
   *
   * ⚠️ 读不到时**不能把下拉清空**：那样连原来绑着的模型都不见了，人只看到一个空框。
   * 降级成"保留当前值 + 一句说明"，并且允许手工填名字。
   *
   * 绑着的模型不在清单里 → 退回「用 CLI 默认」，**不**沿用原来那条「（清单里没有）xxx」：
   * 那种值留着，CLI 收到一个它不认识的模型名，跑起来才报错，人根本猜不到原因
   * （2026-10-17 换运行时时这么定；2026-11-04 用户要求推广到打开页面 —— "模型给删了
   * 就切默认"，实测过 magpie 对死 id 是真 404，留着纯属埋雷）。两种时机有一点不同：
   *   · 换运行时（align）：清单读不到也切 —— 跨运行时沿用旧模型名本来就不对；
   *   · 打开页面 / 刷新：**只在清单成功读到且非空**时才切 —— 读不到可能只是暂时取不到，
   *     盲切会弄丢活绑定（codex 配置缺字段时盲同步差点误删 23 个模型的教训）。
   * 切了要在 note 里说一声 —— 这不是"解释性描述"，是改了人家的值，必须报。
   */
  const fillModels = async (runtimeId, { align = false } = {}) => {
    const note = $('dModelNote');
    if (note) note.textContent = ''; // 静默取，不在界面上写"正在取…"（见下方成功分支的注释）
    try {
      // fresh：这里可能是用户按了「刷新」，别吃 60 秒缓存
      const d = await readModelList(runtimeId, { fresh: true });
      const list = d.models ?? [];
      const cur = modelCombo.value();
      const known = list.some((m) => m.id === cur);
      // 绑的值不在清单里 → 对齐到"用 CLI 默认"。换运行时无条件切；
      // 打开页面/刷新只在清单真读到了才切（读不到 ≠ 被删了，见上方说明）
      const dropped = !!cur && !known && (align || list.length > 0);
      const keep = dropped ? '' : cur;
      // 「用 CLI 默认」后面带上**真实**的默认模型名（2026-10-17）：只写"默认"的话，
      // 人根本不知道它落到哪个模型上 —— 用户就问过"claude code 现在的真实模型是什么"。
      // 文案去掉括号（2026-11-19 用户）：「（用 CLI 默认：xxx）」→「默认：xxx」
      const items = [{ id: '', label: d.defaultModel ? `默认：${d.defaultModel}` : '默认' }];
      // 只剩清单读不到这一种情况会走到这 —— 那也不能把人家绑着的模型弄丢
      if (keep && !known) items.push({ id: keep, label: `（清单里没有）${keep}` });
      items.push(...modelItems(list));
      // 第二个参数是 keepValue：对齐时要真的把值换成 ''，所以只在没对齐时才保留
      modelCombo.setItems(items, keep === cur);
      if (note) {
        // 对齐了值（绑的模型不在清单里 → 切回默认）也不再写那行长说明（2026-11-19 用户：
        // 「这个也去掉」）—— 下拉自己会显示切到了哪个默认模型，不需要再解释一遍。
        // 清单正常 / 为空时同样不留说明（为空时给一句最短提示，见下）。
        note.textContent = dropped || list.length ? '' : (d.error ?? '这个运行时的清单是空的') + ' —— 模型名也可以直接填';
      }
    } catch (err) {
      // 读不到就降级：别清空下拉，让人至少还能看见当前值、还能手工填
      if (note) {
        note.textContent = `取不到模型列表（${err.message}）—— 模型名可以手工填`;
        note.title = err.explained ? '' : (err.detail || '');
      }
    }
  };

  const sbCombo = createCombo({
    mount: $('dSandboxMount'),
    items: sandboxItems(rt),
    value: persona.sandbox,
    search: false,
    onChange: () => scheduleSave(300),
  });
  /*
   * 运行时清单。内置员工与**专家库雇来的员工**（p-expert-*）都多一条「自动」——
   * 他们出厂 runtime 就是 'auto'（换机器、换 CLI 都不用改），下拉里必须有当前值：
   * 缺了它按钮会退化成显示原始 id（用户实报：专家详情里赫然一个 "auto"），清单里也没有 ✓，
   * 而且一旦改成具体运行时就**再也选不回「自动」**。
   * 普通员工仍不给：对他们来说"用哪个引擎"是要自己决定的，不该有个含糊的自动选项。
   */
  const rtItems = runtimes.map((r) => ({ id: r.id, label: r.label }));
  if (persona.builtin || String(persona.id ?? '').startsWith('p-expert-'))
    rtItems.unshift({ id: 'auto', label: '自动' });

  const rtCombo = createCombo({
    mount: $('dRuntimeMount'),
    items: rtItems,
    value: persona.runtime,
    search: false,
    onChange: (id) => {
      const r = runtimes.find((x) => x.id === id);
      const items = sandboxItems(r);
      const keep = items.some((it) => it.id === sbCombo.value()) ? sbCombo.value() : items[0]?.id ?? '';
      sbCombo.setItems(items, false);
      sbCombo.setValue(keep);
      // 换了运行时：清单跟着换，对不上的模型顺带对齐；**对齐完再存** —— 否则会把旧模型名存给新运行时
      fillModels(id, { align: true }).finally(() => scheduleSave(300));
    },
  });
  // auto 没有自己的模型清单 —— 问它只会拿到一个 404，在界面上写成"取不到模型列表"纯属误导。
  // 运行时是自动时下面那行说明也去掉（2026-11-19 用户：「说明去掉」），不显示任何 note。
  if (persona.runtime !== 'auto') fillModels(persona.runtime);

  /*
   * 工作目录：从「手敲路径」改成「选项目」（2026-11-19 用户：项目一多，敲路径容易写错、
   * 写错地方还安静地不报错）。选项 = 项目库（S.projects，load() 时拉好），每项 id 存项目的
   * root，选中谁 = 把这个人的 cwd 设成谁；「不指定」= 空，回落到运行时默认目录。
   *   · 老数据 / 自定义路径对不上任何项目 root → 单独列一项留着（hint 写"自定义目录"），
   *     不擅自抹掉，跟模型下拉「（清单里没有）xxx」同口径；
   *   · 搜项目名或路径都命中（createCombo 按 id + label 过滤，path 正好是 id）。
   */
  const cwdCur = String(persona.cwd ?? '').trim();
  const cwdItems = [{ id: '', label: '不指定（用默认目录）' }];
  for (const p of (S.projects ?? [])) {
    const root = String(p.root ?? '').trim();
    if (!root) continue;
    cwdItems.push({ id: root, label: p.name || root, hint: root });
  }
  if (cwdCur && !cwdItems.some((it) => it.id === cwdCur)) {
    cwdItems.push({ id: cwdCur, label: cwdCur, hint: '自定义目录（不在项目库里）' });
  }
  const cwdCombo = createCombo({
    mount: $('dCwdMount'),
    items: cwdItems,
    value: cwdCur,
    search: true,
    placeholder: '选项目…',
    empty: '没有匹配的项目',
    onChange: () => scheduleSave(300),
  });

  /*
   * 「刷新」：清单是**打开页面那一刻**取的，运行时那边后来加了模型这边不知道 —— 点一下重新问一次。
   * 复用 `fillModels`（它自己就带着"取不到不清空"的降级），只是把按钮按住防连点。
   */
  $('dModelRefresh')?.addEventListener('click', async (e) => {
    e.preventDefault();
    const btn = $('dModelRefresh');
    btn.disabled = true;
    btn.textContent = '刷新中…';
    try {
      await fillModels(rtCombo.value());
    } finally {
      btn.disabled = false;
      btn.textContent = '刷新';
    }
  });

  const instrCount = $('dInstrCount');
  const dInstrTA = $('dInstr');
  /*
   * 自增高（2026-10-21 用户要求）：textarea 有多高显示多高，不给自己滚 ——
   * 滚动条只留外层页面一条。hidden 时 scrollHeight 是 0，跳过（切进编辑态时会再算）。
   */
  const fitInstr = () => {
    if (dInstrTA.hidden) return;
    dInstrTA.style.height = 'auto';
    dInstrTA.style.height = `${dInstrTA.scrollHeight}px`;
  };
  const syncCount = () => { if (instrCount) instrCount.textContent = dInstrTA.value.trim().length + ' 字'; };
  dInstrTA.addEventListener('input', () => { syncCount(); fitInstr(); });
  syncCount();

  /*
   * 「职责与身份设定」预览/编辑（2026-10-21）：人设这类 markdown **写少读多**，默认预览。
   *   · 预览渲染的是 textarea **现值**（当前草稿）—— 编辑一半切过去看到的就是刚写的，
   *     切回编辑一个字不少；不读存库值，就不存在"预览回滚"的坑。
   *   · 切回预览顺手 saveNow 一次：自动保存靠失焦/防抖，切换这个动作兜个底。
   *   · 空内容给占位 +「写一段」直达编辑，不留一块白板让人猜。
   */
  const dInstrEl = $('dInstr');
  const dInstrViewEl = $('dInstrView');
  let instrMode = 'view';
  const renderInstrView = () => {
    const val = dInstrEl.value;
    dInstrViewEl.innerHTML = val.trim()
      ? mdRender(val)
      : /* 身份锁定：雇佣员工不给「写一段」入口（本来也不该走到空值这一支） */
        expertLocked
        ? '<div class="md-empty">暂无设定。</div>'
        : '<div class="md-empty">暂无设定。<button type="button" class="linkish" data-edit-instr>写一段</button></div>';
  };
  const setInstrMode = (m) => {
    if (m === instrMode) return;
    instrMode = m;
    if (m === 'view') {
      renderInstrView();
      dInstrEl.hidden = true;
      dInstrViewEl.hidden = false;
      saveNow?.();
    } else {
      dInstrViewEl.hidden = true;
      dInstrEl.hidden = false;
      fitInstr();
      dInstrEl.focus();
    }
    $('dInstrSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
  };
  // 身份锁定：雇佣员工没有 #dInstrSeg（上面不画），监听挂不上就跳过
  $('dInstrSeg')?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-m]');
    if (b) setInstrMode(b.dataset.m);
  });
  dInstrViewEl.addEventListener('click', (e) => {
    if (e.target.closest('[data-edit-instr]')) setInstrMode('edit');
  });
  renderInstrView();

  /*
   * 「回到聊天 / 发消息」= **接着最近那段继续聊**（2026-10-24 口径，主流做法）。
   * 具体逻辑（当前会话优先 → 最近非空会话 → 新建）已提到模块级 `openDirectChat`
   * （2026-11 移动端增量：通讯录窄屏点员工行也走同一条路，那边没有 renderDetail
   * 的闭包可借）—— 这里只管先落盘再跳。
   */
  $('dMsg').onclick = async () => { await saveNow?.(); openDirectChat(persona); };

  /**
   * 自动保存：**改了就算保存**，不再有「保存」按钮（2026-10-18 用户要求）。
   *
   * 分寸：
   *   · 输入框防抖 700ms；下拉选完 300ms；失焦立刻存；
   *     切分区 / 切标签 / 点「发消息」/ 打开别的员工 / 关页面 都先 flush（见 flushDetailSave）。
   *   · **不重画整页**：重画会丢焦点、把标签弹回概览；只把名字/岗位在页头和左栏同步一下。
   *   · 名字空着不提交（服务端 E1011 会拒），状态直接写"名字不能空"。
   *   · 保存中又来改动 → 存完补一次（串行；同时打两个 PUT 会互相覆盖）。
   */
  const collect = () => ({
    name: $('dName').value,
    // 岗位不可改（2026-11-11 用户拍板）：详情页不再有岗位输入框，PUT 也不带 role/roleKey
    department: $('dDept').value,
    instructions: $('dInstr').value,
    runtime: rtCombo.value(),
    sandbox: sbCombo.value(),
    model: modelCombo.value(),
    // 工作目录改成下拉选项目（2026-11-19）：值从 cwdCombo 取，不再有 #dCwd 输入框
    cwd: cwdCombo.value(),
    // 附加目录不再从 UI 收（2026-11-15 摘掉输入框）：**不传 = 服务端不动库里原值**，
    // 已配置过的 rootDirs 原样保留，不会被这次保存清掉
    // 并发数同理（2026-11-19 摘掉）：不传 = 服务端不动库里原值，统一走系统默认 6
  });
  let lastSaved = JSON.stringify(collect());
  let saving = false;

  saveNow = async ({ keepalive = false } = {}) => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    const payload = collect();
    if (!payload.name.trim()) { setSaveState('名字不能空 · 未保存', 'bad'); return false; }
    const json = JSON.stringify(payload);
    if (json === lastSaved) { setSaveState(''); return true; }
    if (saving) { saveQueued = true; return false; }
    saving = true;
    setSaveState('保存中…', 'wait');
    try {
      const d = await api('/api/personas/' + encodeURIComponent(persona.id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: json,
        ...(keepalive ? { keepalive: true } : {}),
      });
      lastSaved = JSON.stringify(payload);
      const p = d?.persona;
      if (p) {
        S.persona = { ...(S.persona || {}), ...p };
        // 左栏那份也要合回去（S.persona 是独立对象）：改部门后通讯录分组要**立刻**跟着挪，
        // 改名字同理 —— 只重画不合并的话，画出来的还是旧值。
        const row = (S.personas || []).find((x) => x.id === p.id);
        if (row) Object.assign(row, p);
        // 页头（名字 / 岗位 / 头像）与左栏名字同步 —— 不重画整页
        const nameEl = $('dNameText');
        if (nameEl) nameEl.textContent = p.name;
        const roleEl = $('dRolePill');
        if (roleEl) { const rn = roleNameOf(p); roleEl.textContent = rn; roleEl.style.display = rn ? '' : 'none'; }
        const av = $('detailView')?.querySelector('.p-head .avatar');
        // 整体重建而不是改 textContent：头像里除了字母还有**图片层**（<img class="av-img">，
        // 2026-10-22 加），`textContent =` 会把子节点全清掉 —— 切运行时触发自动保存，
        // 保存一下头像图片就没了（2026-10-24 实报）。重建顺带把色系（名字哈希）一起刷新。
        if (av) av.outerHTML = personaAvatar(p);
        // 左栏 / 会话里的名字也跟着变（只跟内存和左栏打交道，不重画详情页）
        (S.conversations || []).forEach((c) => { if (c.personaId === p.id) c.personaName = p.name; });
        if (S.conversation?.personaId === p.id) S.conversation.personaName = p.name;
        if (S.nav === 'contacts' || S.nav === 'messages') {
          // 左栏标题固定「通讯录」（不做面包屑，2026-10-20）—— 改名不用再同步标题，
          // 只有左栏真是通讯录时才要管；在消息页那一栏是会话（从聊天页头点进资料会停在这条路）。
          renderList();
        }
      }
      setSaveState(''); // 存成功不出声（2026-10-24 用户："已保存"提示不要了）—— 保存失败才说话
      return true;
    } catch (err) {
      setSaveState('保存失败：' + (err?.message ?? '服务异常'), 'bad');
      console.error('[班底] 员工自动保存失败', err?.detail ?? err);
      return false;
    } finally {
      saving = false;
      if (saveQueued) { saveQueued = false; saveNow?.(); }
    }
  };
  // 离开这一页（切视图 / 打开别的员工 / 关窗口）前兜底存一次
  detailSave.flush = (opts) => saveNow(opts);

  // 输入框：敲字防抖；失焦立刻存（没改动时 saveNow 按 lastSaved 直接跳过）
  // dRoots 已摘（2026-11-15）、dCwd 改成下拉（2026-11-19，combo 自己 onChange → scheduleSave）、
  // dMaxParallel 已摘（2026-11-19 并发数改系统默认），都不在列表里
  for (const id of ['dName', 'dRole', 'dDept', 'dInstr']) {
    $(id)?.addEventListener('input', () => scheduleSave(700));
    $(id)?.addEventListener('blur', () => saveNow?.());
  }

  /* 更多操作（⋯）：点开才露删除。删除是破坏性动作，平时收起来，别让它跟「发消息」平起平坐 */
  $('dMore')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const m = $('dMoreMenu');
    if (m) m.hidden = !m.hidden;
  });
  document.addEventListener('click', dMoreOutside);
  (window.__pageCleanups ??= []).push(() => {
    document.removeEventListener('click', dMoreOutside);
  });
  function dMoreOutside(e) {
    if (!e.target.closest?.('.hero-more')) { const m = $('dMoreMenu'); if (m) m.hidden = true; }
  }

  /**
   * 删员工。**破坏性**，所以先把要发生的事说清楚，再问。
   * 服务端还会拦一道：他是某个群的群助手就删不掉（得先换人）。
   *
   * 正文三行是 2026-10-20 用户逐字定稿的（原话「整段改成：…」），别再自己加/减：
   *   · 只说结果，不罗列"他的 N 段对话"—— 段数会变，数字一变文案就显得在哄人；
   *   · 第三行带括号，是"可能删不掉"的前置条件，语气上是备注而不是步骤。
   * 「删掉数字员工「X」？」从正文提到了**标题**：正文被定稿成三行后，
   * 不点明删谁的破坏性弹窗只剩一句「该操作」，用户得自己回想刚才点了什么。
   */
  /**
   * 解聘（专家库雇来的员工，⋯菜单里那项）。走专家域的 fire 路由（群助手占用、
   * 固定 id 再雇佣接旧会话都是它管），收尾跟删除一样：别留指向已解聘员工的面板。
   */
  $('dFire')?.addEventListener('click', async () => {
    const key = String(persona.id).slice('p-expert-'.length);
    const ok = await fireExpert(key, { stayContacts: true, name: persona.name });
    if (ok === false) return;
    setNav('contacts');
  });

  $('dDelete') && ($('dDelete').onclick = async () => {
    const ok = await confirmDo(
      `该操作将清空其配置、技能、群关联。\n` +
        `已有对话仅可读，不能继续聊天；会话可后续删除或归档。\n` +
        `（当其作为群助手时无法直接删除，需先更换群助手。）`,
      { title: `删掉数字员工「${persona.name}」？` },
    );
    if (!ok) return;
    try {
      await api('/api/personas/' + encodeURIComponent(persona.id), { method: 'DELETE' });
      // 别留一个指向已删员工的面板：会话、光标、输入区全部复位
      S.persona = null;
      S.conversation = null;
      await load();
      $('chat').innerHTML = '<div class="empty">还没有对话</div>';
      $('chatHead').innerHTML = '<span class="dim" style="padding:6px 0">左边选一个人，开始说话</span>';
      setComposer(false);
      setNav('contacts');
    } catch (err) { toast(err.message, 'error'); }
  });

}



/* ------------------------------------------ 点头像：就地换运行时 / 模型（2026-11-19）

   用户："群聊里面点击人物头像，要打开一个人物弹窗，在这个弹窗里可以更改运行时和模型。
        以便模型额度用完之后可以及时更换"

   两个下拉，改完立刻 PUT 落库（跟详情页自动保存同一套字段口径）：
     · 服务端 PUT 要求 name 非空，且 instructions 不传会被写成空串 ——
       所以发之前先取一次完整详情，把 name / instructions 原样带上（只改这两项）；
     · 运行时连「自动」都没有的员工，清单就是 runtimes 全量；内置/雇佣员工多一条「自动」
       （跟详情页 renderDetail 的 rtItems 同一条规则）；
     · 换运行时后模型清单跟着换，对不上的模型自动切回默认 —— 同详情页 fillModels 的口径。
*/
export async function openPeerDialog(personaId) {
  const dlg = $('peerDlg');
  if (!dlg) return;

  let d;
  try {
    d = await api('/api/personas/' + encodeURIComponent(personaId));
  } catch (err) { toast(err.message, 'error'); return; }
  const persona = d?.persona;
  if (!persona) { toast('员工不存在', 'error'); return; }
  const runtimes = d.runtimes ?? S.runtimes ?? [];

  // 头部：头像 + 名字 + 岗位（部门）
  const role = roleNameOf(persona);
  $('peerAvatar').innerHTML = personaAvatar(persona);
  $('peerName').textContent = persona.name;
  $('peerRole').textContent = [role, persona.department].filter(Boolean).join(' · ');

  let modelCombo = null;

  /** 只改运行时/模型：其余字段原样回传，避免被服务端的"不传即清空"误伤 */
  const save = async () => {
    try {
      const r = await api('/api/personas/' + encodeURIComponent(persona.id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: persona.name,
          instructions: persona.instructions ?? '',
          runtime: rtCombo.value(),
          // 模型清单还没画好就动运行时（极小概率）：用原值顶上，别把人家绑的模型抹掉
          model: modelCombo ? modelCombo.value() : String(persona.model ?? '').trim(),
        }),
      });
      const p = r?.persona;
      if (p) {
        Object.assign(persona, p);
        // 名册里那份也合回去：详情页 / 左栏下次打开就是新值
        const row = (S.personas ?? []).find((x) => x.id === p.id);
        if (row) Object.assign(row, p);
      }
      toast('已保存，下一轮用它', 'ok');
    } catch (err) { toast(err.message, 'error'); }
  };

  /** 模型清单：问运行时；换运行时（align）时对不上的模型切回默认，同详情页 fillModels */
  const paintModels = async (runtimeId, { align = false } = {}) => {
    const mount = $('peerModelMount');
    if (!mount) return;
    let keep = String(persona.model ?? '').trim();
    let items = [{ id: '', label: '默认' }];
    if (runtimeId !== 'auto') {
      try {
        const md = await readModelList(runtimeId, { fresh: true });
        const list = md.models ?? [];
        const known = list.some((m) => m.id === keep);
        if (keep && !known && (align || list.length > 0)) keep = '';
        // 「（清单里没有）xxx」排在模型清单前面，同详情页 fillModels
        items = [{ id: '', label: md.defaultModel ? `默认：${md.defaultModel}` : '默认' }];
        if (keep && !known) items.push({ id: keep, label: `（清单里没有）${keep}` });
        items.push(...modelItems(list));
      } catch {
        // 清单取不到就降级：至少把当前值留着，别把人绑的模型弄丢
        if (keep) items.push({ id: keep, label: keep });
      }
    }
    if (!modelCombo) {
      modelCombo = createCombo({
        mount,
        items,
        value: keep,
        search: true,
        placeholder: '搜模型…（id 或显示名）',
        empty: '没有匹配的模型',
        onChange: () => save(),
      });
    } else {
      modelCombo.setItems(items, true);
      modelCombo.setValue(keep);
    }
    persona.model = keep;
  };

  // 运行时
  const rtItems = runtimes.map((r) => ({ id: r.id, label: r.label }));
  if (persona.builtin || String(persona.id ?? '').startsWith('p-expert-')) {
    rtItems.unshift({ id: 'auto', label: '自动' });
  }
  const rtCombo = createCombo({
    mount: $('peerRuntimeMount'),
    items: rtItems,
    value: persona.runtime,
    search: false,
    onChange: async (id) => {
      persona.runtime = id;
      await paintModels(id, { align: true }); // 对齐完再存，避免把旧模型名存给新运行时
      await save();
    },
  });

  await paintModels(persona.runtime); // auto 不发请求（没有自己的模型清单）
  // 连点两下头像：showModal() 对已打开的 dialog 会抛 InvalidStateError，先收掉再开
  if (dlg.open) dlg.close();
  dlg.showModal();
}



/* 头像点击：`#chat` 里画出来的头像按钮（data-peer），一次委托到底 */
document.addEventListener('click', (e) => {
  const hit = e.target.closest?.('#chat .av-peer');
  if (!hit) return;
  // 手机端不弹简卡（判据同 renderBubble 的 phone）；这里再兜一层：
  // 窗口从宽拖窄 / 旋屏之后，DOM 里可能还留着上一版渲染出来的按钮。
  if (document.body.classList.contains('mb-narrow')) return;
  e.preventDefault();
  openPeerDialog(hit.dataset.peer);
});




/* ------------------------------------------------------------ 关联技能 */

export let linkCandidates = [];


export const linkPicked = new Set();


export let linkPersonaId = null;



export function renderLinkList() {
  const q = ($('lkSearch').value || '').trim().toLowerCase();
  const rows = linkCandidates.filter(
    (s) => !q || s.name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q),
  );
  $('lkList').innerHTML = rows.length
    ? rows
        .map(
          (s) => `<label class="member">
            <input type="checkbox" value="${esc(s.name)}" ${linkPicked.has(s.name) ? 'checked' : ''} />
            <span>${esc(s.name)}</span><em>${esc(cut(s.description, 44) || '（未写描述）')}</em>
          </label>`,
        )
        .join('')
    : '<div class="dim" style="padding:10px 2px">没找到</div>';
  $('lkList').querySelectorAll('input').forEach((el) => {
    el.onchange = () => { if (el.checked) linkPicked.add(el.value); else linkPicked.delete(el.value); };
  });
}



export function openLinkSkillDialog(persona, allSkills, attached) {
  const have = new Set(attached);
  linkCandidates = allSkills.filter((s) => !have.has(s.name));
  if (!linkCandidates.length) return toast('库里的技能都已经关联了');
  linkPersonaId = persona.id;
  linkPicked.clear();
  $('lkSearch').value = '';
  renderLinkList();
  $('linkSkillDlg').showModal();
  setTimeout(() => $('lkSearch').focus(), 30);
}



/** 关联改完：刷新列表 + 重画详情 */
export async function searchRefreshDetail() {
  const id = linkPersonaId;
  await load();
  if (id) await openDetail(id);
}
