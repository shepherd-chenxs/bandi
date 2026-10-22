/* listmenu.mjs —— 列表项右键菜单、会话域的错误人话。
 * 2026-10-22 由 app.js（15537 行单文件）拆出，原生 ESM、无打包器；逻辑逐字搬运。 */
import { esc, toast } from './shell.mjs';
import { api, avatarStyle, hhmm, initial, post } from './ui.mjs';
import { load, setNav } from './state.mjs';
import { confirmDo } from './machine.mjs';
import { renderList } from './contacts.mjs';
import { setListTitle } from './flowpages.mjs';
import { openConversation, setComposer } from './chat.mjs';
import { gidOf } from './groups.mjs';
import { closeDrawer } from './experts.mjs';
import { $, S } from './core.mjs';



/* -------------------------------------------------------- 列表项右键菜单 */

/**
 * 打开右键菜单（单例 `#ctxMenu`，挂在 body 下、`position:fixed` 跟光标走）。
 *
 * 为什么只有这一个单例：每次右键只换内容与位置，**节点本身不动** ——
 * 挂在它上面的监听在 boot 时注册一次就永远有效。列表是每次 `innerHTML` 重建的，
 * 逐个绑事件在这个仓库里踩过多轮（见 `renderList` 那段注释），所以
 * `contextmenu` 走 `#listBody` 上的**委托**，绝不写进 `renderList`。
 *
 * @param {number} x 视口坐标（事件里的 clientX）
 * @param {number} y 视口坐标（事件里的 clientY）
 * @param {Array<{label: string, danger?: boolean, disabled?: boolean, why?: string, run: Function}>} items
 */
export function openCtxMenu(x, y, items) {
  const menu = $('ctxMenu');
  if (!menu || !items?.length) return;
  menu.innerHTML = items
    .map(
      (it, i) =>
        `<button class="ctx-item${it.danger ? ' danger' : ''}" role="menuitem" data-idx="${i}"` +
        `${it.disabled ? ' disabled' : ''}${it.why ? ` title="${esc(it.why)}"` : ''}>${esc(it.label)}</button>`,
    )
    .join('');

  // 项自己的点击：**先关菜单再做事** —— 反过来的话，await 期间菜单还挂在屏幕上，
  // 用户会以为没点着，再点一下就又执行一遍。
  // 兜底也用 toastConvErr：菜单里的项都是会话域动作（删除 / 不显示），三码要能说人话
  menu.querySelectorAll('.ctx-item').forEach((btn) => {
    btn.onclick = async () => {
      const it = items[Number(btn.dataset.idx)];
      if (!it || it.disabled) return;
      closeCtxMenu();
      try { await it.run(); } catch (err) { toastConvErr(err); }
    };
  });

  menu.hidden = false;
  // 先按光标摆，再量**真实尺寸**：菜单高度取决于有几项，不能预先算
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const r = menu.getBoundingClientRect();
  // 右/下越界就翻转（贴边留 8px，别正好压在屏幕边上）
  if (x + r.width > window.innerWidth - 8) menu.style.left = `${Math.max(8, x - r.width)}px`;
  if (y + r.height > window.innerHeight - 8) menu.style.top = `${Math.max(8, y - r.height)}px`;
  // 焦点落到第一个**可用**项：键盘能直接上下选（P1-4），Enter/Space 由 <button> 原生负责
  menu.querySelector('.ctx-item:not([disabled])')?.focus();
}



/** 收起右键菜单。可以随便多调 —— 已经收起时直接返回（滚动/失焦/重画都会调到它） */
export function closeCtxMenu() {
  const menu = $('ctxMenu');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  menu.innerHTML = '';
}



/* --------------------------------------------------- 会话域的错误人话 */

/**
 * 会话操作的错误人话（PRD v1.1，产品口径）。
 *
 * 这张表**不是**"把原因藏起来"的补丁，而是"把原因说得更像人话"的覆盖层：
 * `api()`（2026-10-21 起）对 4xx 已经会直接显示服务端原文，但服务端那句是**面向操作**的
 * （「这段会话不存在」），而人会卡住的场景需要一句**面向结果**的话
 * （「这段会话已经不在了，列表已刷新」—— 告诉他接下来该怎么办）。
 *
 * 三条纪律：
 *  ① 用 `err.code` 映射，**不解析 `err.message`**（文案随时会改，解析它等于把两个文件焊死）；
 *  ② **不往 `api()` 里塞业务判断** —— 错误码到人话的映射属于各自领域，全局那层只负责"能不能显示原文"；
 *  ③ 表里没有的码**自动回落 `err.message`**（现在已带服务端原因），不会退回"只有服务异常"。
 *
 * **全仓只留这一份**：将来别的功能（比如群删除）要用人话，往这张表里加一行，别再抄一份。
 */
export const CONV_ERR_ZH = {
  E2047: '这段会话已经不在了，列表已刷新',
  // E1050 = 工单会话（任务卡 / 流程）。群的删除路子 2026-10-20 起已经放开，别再写成"群请去解散"
  E1050: '这是任务卡 / 流程里的会话，要去那边删任务',
  E4002: '这段还在跑，等它跑完或先终止再删',
  // 群会话：群没了 / 群已解散（E2016、E2017 归技能用，别串）
  E2011: '这个群不存在了，已回到消息列表',
  E2048: '这个群已经不在了，通讯录已刷新',
  E2049: '这个群已经解散了，只能查看聊天记录',
};


export function toastConvErr(err) {
  const zh = CONV_ERR_ZH[err?.code];
  // 有专属文案 → 「人话（E码）」；没有 → 保持现状（api() 已经 console.error 过完整一行）
  toast(zh ? `${zh}（${err.code}）` : err?.message, 'error');
}



/**
 * 「已归档」的会话 = 被收起来的、**员工已经被删掉**的单聊，以及**已经解散**的群。
 *
 * 为什么只认这两类：
 *   · 正常员工的「不显示」是**临时收起来**（还能从对方聊天头部→聊天记录翻回来），
 *     把它也算进「已归档」的话，用户会以为"不显示=归档"——那正是 2026-10-20 被否掉的语义；
 *   · 员工删掉之后，那段会话没有别的入口了（连聊天头部都进不去），所以必须有个地方能看，
 *     否则右键那个「归档」等于"永久消失"，跟文案说的"记录还在"自相矛盾；
 *   · 解散的群同理（2026-10-20 用户要求右键给「归档」）：成员和助手都清了，
 *     "不显示"的语义不成立 —— 归档视图就是它唯一的容身之处。
 */
export function archivedConvs() {
  const alive = new Set((S.personas ?? []).map((p) => p.id));
  return (S.hiddenConversations ?? [])
    .filter((c) => (c.kind === 'direct' && !alive.has(c.personaId)) || (c.kind === 'group' && c.dissolvedAt))
    .sort((a, b) => String(b.hiddenAt ?? b.updatedAt).localeCompare(String(a.hiddenAt ?? a.updatedAt)));
}



/**
 * 消息列表底部那行「已归档 N」。没有归档就不渲染（返回空串），不占地方。
 *
 * 为什么放在**列表底部**而不是导航里：它是"被收起来的东西"的收件箱，
 * 用得少但需要时得一眼能找到；放导航会把它抬成和「消息」平级的功能。
 */
export function archivedEntryHTML() {
  const n = archivedConvs().length;
  if (!n) return '';
  return `<div class="arch-entry" id="archEntry" title="删掉员工 / 解散群之后收起来的会话，点开能翻看">
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
         stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3.5 7.5h17v11.2a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8z" />
      <path d="M2.6 4.2h18.8v3.3H2.6z" />
      <path d="M9.4 12h5.2" />
    </svg>
    已归档<span class="arch-n">${n}</span>
  </div>`;
}



/**
 * 进入「已归档」子视图：**左栏换成归档列表**（不是抽屉，2026-10-20 用户要求
 * "点击已归档，左侧列表应该改成归档的消息列表，如张三、李四"）。
 *
 * 右侧不动：点左栏那行就在右边打开对话面板（员工已删 → 输入框自动置灰），
 * 头部的「聊天记录」还能把这个人跟自己的全部历史翻出来。
 */
export function enterArchiveView() {
  S.archivedView = true;
  setNav('messages', { keepArchiveView: true }); // 先置位再 setNav：它内部就 renderList
  // 右边还是上一次的会话也无所谓（归档视图只是"换了份左栏"）；没有任何会话时给句提示
  if (!S.conversation) {
    $('chat').innerHTML = '<div class="empty">左边选一段已归档的会话</div>';
    $('chatHead').innerHTML = '<span class="dim" style="padding:6px 0">已归档</span>';
    setComposer(false);
  }
}



/**
 * 会话的**显示名**（2026-10-21 修"解聘后头像变 ? / 名字变「和 大梁」"）：
 *   · 员工还在 → personaName（他现在可能改过名，JOIN 现值）；
 *   · 员工没了（解聘/删除）→ personaName 是 NULL，回落到会话自己的标题，
 *     但 1:1 会话的 title 存的是「和 张三」（见 toMessages 的 `和 ${persona.name}`），
 *     直接当名字用会带出「和」前缀 —— 这里剥掉；连标题都没有才写「员工已删」。
 * 头像的首字与底色也用这同一个返回值，别一处用 personaName 一处用 title
 * （之前列表头像只认 personaName，人一没了就画出「?」—— 用户实报）。
 */
export function convDisplayName(c) {
  if (c.personaName) return c.personaName;
  return String(c.title || '').replace(/^和\s*/, '') || '（员工已删）';
}



/**
 * 左栏的归档列表。行与消息列表同一套 `.item` 样式（用户要的就是"像张三、李四那样列出来"），
 * 只是副标题换成条数与"员工已删除"，右键菜单只给「删除」。
 */
export function renderArchiveList() {
  // 搜索框在左栏顶上，用户一定会往里打字 —— 归档视图也得认它，否则像坏了
  const q = S.filter.trim().toLowerCase();
  const rows0 = archivedConvs().filter((c) => !q || String(c.title || '').toLowerCase().includes(q));
  setListTitle([{ label: '消息', to: 'messages' }, { label: '已归档' }]);
  $('listAction').classList.add('hidden'); // 这里没有"新建"

  const items = rows0
    .map((c) => {
      // 归档里 direct 会话的员工都已经没了：convDisplayName 剥「和 」前缀（跟消息列表同一来源）
      const title = c.kind === 'group' ? (c.title || '（没有标题）') : convDisplayName(c);
      const active = S.conversation?.id === c.id;
      return `<div class="item ${active ? 'active' : ''}" data-conv="${esc(c.id)}">
        <div class="avatar" ${avatarStyle(title)}>${esc(initial(title))}</div>
        <div class="who">
          <div class="line1"><b>${esc(title)}</b><span>${hhmm(c.hiddenAt || c.updatedAt)}</span></div>
          <div class="line2">${Number(c.messageCount) || 0} 条消息 · ${c.kind === 'group' ? '群已解散' : '员工已删除'}</div>
        </div>
      </div>`;
    })
    .join('');

  $('listBody').innerHTML =
    rows0.length
      ? items
      : '<div class="empty" style="padding:32px 12px">还没有归档的会话<br />' +
        '<span class="dim" style="font-size:12px">删掉数字员工、或解散群之后，右键「归档」可以收进来</span></div>';

  $('listBody').querySelectorAll('[data-conv]').forEach((el) => {
    el.onclick = () => openConversationSafe(el.dataset.conv);
  });
  // 「← 返回消息」跟入口在同一个位置（底部固定条）：进出一眼都看得见，不用滚回顶部
  const foot = $('listFoot');
  if (foot) {
    foot.innerHTML = `<div class="arch-entry" id="archBack" title="回到消息列表">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
           stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 6l-6 6 6 6" />
      </svg>
      返回消息
    </div>`;
    foot.querySelector('#archBack').onclick = () => setNav('messages'); // setNav 默认会清掉 archivedView
  }
}



/**
 * 「不显示」/「归档」：只把这一行从消息列表收走，**一条消息都不删**。
 *
 * 2026-10-20 起两种叫法走同一个接口，区别只在语义与文案：
 *   · 正常员工 → **不显示**：还能在「聊天记录」里找到（hiddenConversations 里有它）；
 *   · 已删除员工 → **归档**：进消息列表底部的「已归档」，在那儿能翻到、也能彻底删。
 * 没有「恢复」入口（恢复 = 归档的意义就没了）；想让它回到列表，只能在里面再说一句话。
 * 所以不做二次确认（不删数据，零风险）。
 */
export async function hideConversationRow(c, mode = 'hide') {
  try {
    const r = await post(`/api/conversations/${encodeURIComponent(c.id)}/hide`, {});
    // 服务端已把它从 listConversations 里剔除 → 下面的收敛会自动把上一条顶成「当前会话」
    S.conversations = r.conversations;
    if (r.hiddenConversations) S.hiddenConversations = r.hiddenConversations;
    // 正在看的就是它：这段人还在（不显示），右栏留着无妨；人已删（归档）就回空态
    if (mode === 'archive') {
      if (S.conversation?.id === c.id) resetChatPane();
      if (S.drawerKind === 'log') closeDrawer();
    }
    renderList();
  } catch (err) { toastConvErr(err); }   // E2001 不在映射表里 → 自动回落，行为与今天一致
}



/**
 * 这一行删下去，删的是"这一段"还是"一整档历史"？
 *
 * 两种「整档」（2026-10-20 用户分两轮定下的，后端各有一条专用 SQL）：
 *   · `'group'`   —— **已解散的群**：行 = 这个群的全部历史（`purgeDissolvedGroup`）
 *   · `'persona'` —— **员工已删的单聊**：行 = 这个人的全部历史（`purgePersonaHistory`）
 *
 * 为什么要抽成函数：菜单标签、确认框正文、删完复位哪儿，三处都要这个判断，
 * 而菜单有两个入口（左栏 / 聊天记录抽屉）。复制三份的下场是迟早只改其中一处。
 */
export function wipeScopeOf(c) {
  if (!c) return null;
  if (c.kind === 'group') return c.dissolvedAt ? 'group' : null;
  if (c.kind !== 'direct') return null;
  // 通讯录里已经没有这个人了（`deletePersona` 只删人、保留会话，见 store.mjs）
  return (S.personas ?? []).some((p) => p.id === c.personaId) ? null : 'persona';
}



/**
 * 「删除」= **物理删除**：会话连同消息一并抹掉，不可恢复。
 *
 * 二次确认只留**一句话**（2026-10-20 用户定稿）：
 * 「本次会话删除后，消息内容不可恢复。请确认是否操作？」
 *
 * 这是对 PRD P0-3 / P1-5（"文案要讲清 ①找不回来 ②跟不显示的差别"）的一次**收敛**：
 * 用户看过那版三点罗列后要求改成一句。理由站得住 —— 确认框的作用是让人停下来想一秒，
 * 不是讲设计；「不显示」的差别在右键菜单里看得见，正文复述只会稀释"不可恢复"这个重点。
 * 条数仍然不写：消息列表接口没有 messageCount，不为一句文案再加一次请求（v1.1 已明确）。
 */
export async function removeConversationForever(c) {
  /*
   * 标题别写成 `和 ${c.title}` —— 老会话的 title 本身可能已经是「和 张三」
   * （P1-1 之前建的都长这样），拼出来就是「和 和 张三」。
   */
  const isGroup = c.kind === 'group';
  /*
   * 「整档清空」的两种（见 `wipeScopeOf`）：确认框要说的是"全部聊天记录"，
   * 不能沿用"这一段"的话术 —— 用户会以为只删了一段。
   * 正文沿用一句话口径（2026-10-20 定稿），只把句子本身换成清档版的。
   */
  const wipe = wipeScopeOf(c);
  const ok = await confirmDo(
    wipe === 'group'
      ? '这个群已解散。删除后会清空它的全部聊天记录，不可恢复。请确认是否操作？'
      : wipe === 'persona'
        ? '这个员工已删除。删除后会清空他的全部聊天记录，不可恢复。请确认是否操作？'
        : '本次会话删除后，消息内容不可恢复。请确认是否操作？',
    {
      title: wipe ? '删除并清空聊天记录' : isGroup ? '永久删除这段群会话' : '永久删除这段会话',
      ok: '永久删除',
      danger: true,
    },
  );
  if (!ok) return;
  try {
    const r = await api(`/api/conversations/${encodeURIComponent(c.id)}`, { method: 'DELETE' });
    S.conversations = r.conversations ?? (S.conversations ?? []).filter((x) => x.id !== c.id);
    if (r.hiddenConversations) S.hiddenConversations = r.hiddenConversations;
    if (S.drawerKind === 'log') closeDrawer();                       // 抽屉里可能正列着它
    // 群还有第二处状态：群设置抽屉 / 通讯录的群详情
    if (S.groupThreadId === c.id) {
      S.groupThread = null;
      S.groupThreadId = null;
      closeDrawer();
    }
    /*
     * 清档：右边停在**这一档里的任何一段**都得复位 —— 它们全没了，
     * 只认 `id === c.id` 会漏掉"正在看另一段"的情况（群和已删员工一个道理）。
     */
    const gid = gidOf(c);
    const hitting =
      wipe === 'group'
        ? S.conversation?.groupId === gid
        : wipe === 'persona'
          ? S.conversation?.kind === 'direct' && S.conversation?.personaId === c.personaId
          : S.conversation?.id === c.id;
    if (hitting) resetChatPane();
    renderList();
    toast(
      wipe === 'group'
        ? '已删除。这个群的聊天记录都清掉了'
        : wipe === 'persona'
          ? '已删除。他的聊天记录都清掉了'
          : isGroup
            ? '已删除这段会话'
            : '已删除。这段已经彻底没了',
    );
  } catch (err) {
    /*
     * E2047 = 另一个窗口刚把它删了。**列表要刷、"眼前这段"也要收拾**：
     * 只刷列表的话，左栏没这行了、右边聊天区还开着，用户一打字又撞第二个错。
     */
    if (err?.code === 'E2047') {
      if (S.conversation?.id === c.id) resetChatPane();   // 正在看的就是它 → 回空态、收输入区
      if (S.drawerKind === 'log') closeDrawer();          // 抽屉里那行已经不存在了
      await load().catch(() => {});
      renderList();
    }
    toastConvErr(err);
  }
}



/**
 * 打开会话的统一入口（消息列表行 / 聊天记录行）。
 *
 * 为什么要包一层：`E2047`（这段已经被别人删了）在**两个窗口同时开**时最容易撞上。
 * 不处理的话用户看到的是通用"服务异常"，左栏还高亮、右边空着，一刷新又撞一次。
 * 这里必须把"眼前这段"一起收拾干净 —— 只刷列表，人就会对着一具尸体打字。
 *
 * ⚠️ **只给这两处列表入口用**，不接管全站 `openConversation` 的其它调用点
 *    （工作台卡片 / 任务卡 / 流程实例），那样就是超范围改动。
 */
export async function openConversationSafe(id) {
  try {
    await openConversation(id);
  } catch (err) {
    if (err?.code !== 'E2047') return toastConvErr(err);
    closeDrawer();                 // 抽屉里那行已经不存在了（没开就是空操作）
    resetChatPane();               // 右边回空态、收输入区
    await load().catch(() => {});  // 列表刷成**真的**（文案说"已刷新"，界面就得真是新的）
    // 回列表；顺带把 S.route 清掉（setNav 会置 null），否则刷新时 restorePlace
    // 还会照着这个死 id 再撞一次 —— 用户会以为"刷新都修不好"
    setNav('messages');
    toastConvErr(err);
  }
}



/**
 * 把主聊天区复位成"还没选会话"的样子。
 *
 * 逐字照 `dissolveGroup`（app.js 里群解散那段）的复位抄 —— 那是本项目已有的
 * "会话没了"处理，别写第二套（同一件事两份实现，迟早只修其中一份）。
 */
export function resetChatPane() {
  S.conversation = null;
  S.convEmpty = false;
  $('chat').innerHTML = '<div class="empty">还没有对话</div>';
  $('chatHead').innerHTML = '<span class="dim" style="padding:6px 0">左边选一个人，开始说话</span>';
  setComposer(false);
}
