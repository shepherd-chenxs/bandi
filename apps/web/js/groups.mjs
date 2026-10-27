/* groups.mjs —— 群成员宫格、群设置抽屉、聊天记录抽屉、群详情页、群加人。
 * 2026-10-22 由 app.js（15537 行单文件）拆出，原生 ESM、无打包器；逻辑逐字搬运。 */
import { esc, setRoute, toast } from './shell.mjs';
import { api, cut, hhmm, initial, plain, post, AVATAR_FILE } from './ui.mjs';
import { load, setNav } from './state.mjs';
import { confirmDo } from './machine.mjs';
import { openConversationSafe, resetChatPane, toastConvErr, wipeScopeOf } from './listmenu.mjs';
import { renderList, showView } from './contacts.mjs';
import { setListTitle } from './flowpages.mjs';
import { closeDrawer, dissolveGroup, kickMember, renameGroup } from './experts.mjs';
import { $, S } from './core.mjs';
import { openAssistantDialog } from './misc.mjs';



/* ---------------------------------------------------------- 群成员宫格 */

export function memberGridHTML(thread) {
  const q = S.memberQuery.trim().toLowerCase();
  const list = q ? thread.members.filter((m) => m.name.toLowerCase().includes(q)) : thread.members;

  const overflow = list.length > MEMBER_TILE_LIMIT;
  // 有溢出且没展开时，留两个位置给「添加 / 移除」磁贴
  const shown = overflow && !S.membersExpanded ? list.slice(0, MEMBER_TILE_LIMIT - 2) : list;

  /*
   * 成员头像（2026-10-23 用户实报「群里面还没有头像」）：按 personaId 从 S.personas
   * 查头像文件，有图就把图铺在字母上面（personaAvatar 同一套哲学：图盖字母、
   * 加载失败 onerror 自删露字母，永远不破相）。找不到人/没配头像走纯字母。
   */
  const pById = new Map((S.personas ?? []).map((p) => [p.id, p]));
  const tiles = shown
    .map((m) => {
      const isAssistant = m.personaId === thread.assistantPersonaId;
      const removable = S.removeMode && !isAssistant;
      const p = pById.get(m.personaId);
      const img =
        p?.avatar && AVATAR_FILE.test(String(p.avatar))
          ? `<img class="av-img" src="/avatars/${encodeURIComponent(String(p.avatar))}" alt="" onerror="this.remove()">`
          : '';
      return `<div class="mtile${removable ? ' removable' : ''}"
                   title="${esc(m.name)}${p?.role ? ` · ${esc(String(p.role).split(' · ')[0])}` : ''}"
                   ${removable ? `data-kick="${esc(m.personaId)}" data-name="${esc(m.name)}"` : ''}>
        <div class="mavatar">
          ${esc(initial(m.name))}
          ${img}
          ${isAssistant ? '<span class="mbadge">群助手</span>' : ''}
          ${removable ? '<span class="mx">×</span>' : ''}
        </div>
        <div class="mname">${esc(m.name)}</div>
      </div>`;
    })
    .join('');

  const tiles2 = `
    <div class="mtile action" id="drawerAdd"><div class="mavatar">＋</div><div class="mname">添加</div></div>
    <div class="mtile action${S.removeMode ? ' on' : ''}" id="drawerRemove">
      <div class="mavatar">−</div><div class="mname">${S.removeMode ? '完成' : '移除'}</div>
    </div>`;

  const noHit = q && !list.length ? '<div class="mgrid-empty">没找到这个人</div>' : '';
  return noHit + `<div class="mgrid" id="mgrid">${tiles}${tiles2}</div>`;
}



/** root：在哪个容器里找成员宫格（抽屉 或 群详情页）；repaint：改完重画哪一块 */
export function wireMemberGrid(thread, repaint = paintDrawer, root = null) {
  // 这份 HTML 抽屉/详情页各一份，id 全文档重复 —— 一律在 root 里找（见 wireGroupSettings 注释）
  const scope = root ?? document;
  const add = scope.querySelector('#drawerAdd');
  if (add) add.onclick = () => openMemberDialog(thread);
  const rm = scope.querySelector('#drawerRemove');
  if (rm) rm.onclick = () => { S.removeMode = !S.removeMode; repaint(); };
  (root ?? document).querySelectorAll('[data-kick]').forEach((el) => {
    el.onclick = () => kickMember(thread, el.dataset.kick, el.dataset.name);
  });
}



/* ---------------------------------------------------------- 群设置抽屉 */

export const MEMBER_TILE_LIMIT = 12;



/**
 * 群的身份。
 *
 * 群和群会话是**两张表**（2026-10-20 拆开：一个群可以有多段会话）：
 *   · 群对象（通讯录详情 / 群设置）→ `id` 就是群 id
 *   · 群会话（消息列表右键 / 聊天头部）→ `id` 是会话 id，群 id 在 `groupId` 上
 * 所有 `/api/groups/...` 都是群级接口，一律从这里取，**别直接写 thread.id**。
 */
export const gidOf = (t) => t?.groupId || t?.id;



/**
 * 开「群设置」抽屉。
 *
 * 入参可以是**群对象**（通讯录群详情）、也可以是**一段群会话**（聊天头部那个齿轮）——
 * 两者形状不同：会话上没有群级真源，只有建会话那一刻的成员快照。
 * 这里统一换成 `groupId` 作为抽屉的身份（`S.drawerThreadId`），再用群级接口取一次真源：
 * 设置改的是**群**，不是某一段会话，身份必须是群 id，否则"改完只影响这一段"。
 *
 * 先用手上有的数据画一版（避免空抽屉闪一下），拉到群详情再重画一次。
 */
export function openGroupDrawer(thread) {
  const groupId = gidOf(thread);
  S.drawerKind = 'group';   // 同一个 #drawer 两种内容，靠它分流（见 paintDrawer 首行）
  S.drawerOpen = true;
  S.drawerThreadId = groupId;
  S.drawerThread = {
    id: groupId,
    title: thread.title,
    assistantPersonaId: thread.assistantPersonaId,
    members: thread.members ?? [],
  };
  S.removeMode = false;
  S.membersExpanded = false;
  S.memberQuery = '';
  paintDrawer();
  $('drawer').classList.add('open');
  $('scrim').classList.add('open');
  // 群级真源（成员名单可能在别处改过：通讯录加的、另一个窗口踢的）
  api('/api/groups/' + encodeURIComponent(groupId))
    .then((d) => {
      if (S.drawerKind !== 'group' || S.drawerThreadId !== groupId) return; // 已经关了/换了
      S.drawerThread = d.group;
      paintDrawer();
    })
    .catch(toastConvErr);
}



/**
 * 群设置的正文（成员宫格 + 信息行）。
 * **抽屉和群详情页共用这一份** —— 写两份迟早走样：改了抽屉忘了页面，两边行为就不一致了。
 *
 * `opts.noDissolve`：群详情页**不画**底部「解散群聊」区（2026-10-20 用户要求：
 * 那边改用页头「⋯」里的解散入口，破坏性动作别平铺在页面上）。抽屉照旧保留 ——
 * 聊天头部齿轮开出来的抽屉没有「⋯」，这儿是它唯一的解散入口。
 */
export function groupSettingsHTML(thread, opts = {}) {
  const assistant = thread.members.find((m) => m.personaId === thread.assistantPersonaId);
  const q = S.memberQuery.trim().toLowerCase();
  const visible = q ? thread.members.filter((m) => m.name.toLowerCase().includes(q)) : thread.members;
  const overflow = visible.length > MEMBER_TILE_LIMIT;

  return `
    <div class="dcard">
      <h4>群成员 <span class="count">${thread.members.length}</span></h4>
      <input id="drawerSearch" class="dcard-search" placeholder="搜索群成员" value="${esc(S.memberQuery)}" />
      ${S.removeMode ? '<div class="rm-hint">点成员头像上的 × 把他移出群</div>' : ''}
      ${memberGridHTML(thread)}
      ${overflow && !S.membersExpanded
        ? `<div class="more-row" id="drawerMore"><span>查看全部群成员（${visible.length}）</span><span>›</span></div>`
        : ''}
      ${overflow && S.membersExpanded
        ? '<div class="more-row" id="drawerLess"><span>收起</span><span>‹</span></div>'
        : ''}
      <div class="hint-line">新成员入群可查看最近 20 条聊天记录</div>
    </div>

    <div class="dcard">
      <div class="info-row clickable" id="rowRename">
        <span>群名称</span><b>${esc(thread.title)}</b><span class="chev">›</span>
      </div>
      <div class="info-row"><span>群主</span><b>${esc(S.me?.name ?? '我')}（创建人）</b></div>
      <div class="info-row clickable" id="rowAssistant">
        <span>群助手</span><b>${esc(assistant?.name ?? '还没选')}</b><span class="chev">›</span>
      </div>
      <div class="info-row"><span>成员数</span><b>${thread.members.length} 人</b></div>
    </div>

    ${opts.noDissolve ? '' : `
    <div class="dcard">
      <div class="info-row clickable danger" id="rowDissolve">
        <span>解散群聊</span><b>聊天记录会保留</b><span class="chev">›</span>
      </div>
    </div>`}`;
}



/**
 * 抽屉和群详情页共用的接线。repaint 决定"改完之后重画哪一块"。
 *
 * ⚠️ `root` 必传：这段 HTML **抽屉和群详情页各画一份**，id（rowRename / drawerAdd / …）在
 * 文档里是重复的 —— 用全局 `$('id')` 永远绑到 DOM 顺序靠前的那份（`<main>` 里的群详情页
 * 排在 `#drawer` 前面）。2026-10-20 用户实报：开过一次群详情后，群设置**抽屉**里点
 * 「群名称」没反应 —— 行的 onclick 绑在隐藏的详情页那份上了。所以一切查找都限定在
 * 自己的容器里（id 在各自容器内仍然唯一）。
 */
export function wireGroupSettings(thread, repaint, root) {
  const q = (sel) => root.querySelector(sel);
  const rn = q('#rowRename');
  if (rn) rn.onclick = () => renameGroup(thread);
  const ra = q('#rowAssistant');
  if (ra) ra.onclick = () => openAssistantDialog(thread);
  const rd = q('#rowDissolve');
  if (rd) rd.onclick = () => dissolveGroup(thread);
  wireMemberGrid(thread, repaint, root);

  // 搜索只重画宫格 —— 整块重画会把光标从搜索框里踢出去
  const search = q('#drawerSearch');
  if (search) {
    search.oninput = (e) => {
      S.memberQuery = e.target.value;
      const grid = q('#mgrid');
      if (grid) grid.outerHTML = memberGridHTML(thread);
      wireMemberGrid(thread, repaint, root);
    };
  }

  const more = q('#drawerMore');
  if (more) more.onclick = () => { S.membersExpanded = true; repaint(); };
  const less = q('#drawerLess');
  if (less) less.onclick = () => { S.membersExpanded = false; repaint(); };
}



export function paintDrawer() {
  // 「聊天记录」和「群设置」共用这一个抽屉容器 —— 分流只在这一行。
  // 群那套（membersExpanded / memberQuery / removeMode）一个字都没动，
  // 所以从群设置里进来的路径跟以前完全一样。
  if (S.drawerKind === 'log') return paintChatLogDrawer();
  const thread = S.drawerThread;
  if (!thread) return;

  const assistant = thread.members.find((m) => m.personaId === thread.assistantPersonaId);

  $('drawer').innerHTML = `
    <div class="drawer-head">
      <b>群设置</b>
      <button class="mini" id="drawerClose" title="关闭">×</button>
    </div>
    <div class="drawer-body">
      <div class="dcard group-card">
        <div class="avatar grp big">${esc(initial(thread.title))}</div>
        <div class="who">
          <h3>${esc(thread.title)}</h3>
          <div class="sub">群助手：${esc(assistant?.name ?? '—')} · ${thread.members.length} 人</div>
        </div>
      </div>
      ${groupSettingsHTML(thread)}
    </div>`;

  $('drawerClose').onclick = closeDrawer;
  wireGroupSettings(thread, paintDrawer, $('drawer'));
}



/* ---------------------------------------------------------- 聊天记录抽屉 */

/**
 * 一条会话落在哪个日期桶（今天 / 昨天 / 更早）。
 *
 * 按**本地日期**算，不是按时差算：昨天 23:50 和今天 00:10 只差 20 分钟，
 * 但它们是两天的事，硬按 24 小时分桶会把"昨天"的东西说成今天。
 */
export function dayBucket(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (diff <= 0) return '今天';
  if (diff === 1) return '昨天';
  return '更早';
}



/** 今天的会话显示 `hh:mm`（跟左栏一个口径），更早的显示 `MM-DD` */
export function logTime(iso) {
  if (dayBucket(iso) === '今天') return hhmm(iso);
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}



/**
 * 打开「聊天记录」抽屉：这个人的**全部未隐藏 1:1 会话**（含当前这条），新的在前。
 *
 * 入口在聊天头部（右侧），打开**不打断当前对话**；
 * 而 `#drawer` + `#scrim` 已经把动画、Esc、点遮罩关闭都做好了，白拿。
 *
 * 数据**不新增接口**（PRD v1.1）：直接过滤 `/api/state` 的 `S.conversations` +
 * `S.hiddenConversations` —— 后者是被「不显示」收走的（2026-10-20 去掉归档后，
 * 「不显示」只是不在列表占行，聊天记录里必须还看得到）。
 * （`listConversations` 是热路径兼工作台数据源，不为一处展示改它的契约）。
 * 但打开前**先 `load()` 一次** —— 否则看到的是轮询间隔内的旧快照，用户刚在别的窗口
 * 删掉的会话还会挂在这儿。也不缓存列表副本（缓存就是"看到旧数据"的病根）。
 *
 * @param {{id: string, kind?: string, personaId?: string, personaName?: string}} conv 当前正在看的会话
 */
export async function openChatLogDrawer(conv) {
  /*
   * 群也能开这个抽屉（2026-10-20 用户要求：「群聊天记录」）—— 群与单聊的差别只在**取数口径**：
   *   · 单聊 → 这个人的全部 direct 会话（含被「不显示」的）
   *   · 群   → 这个群自己的全部会话（一个群可以有多段，新的在前；含被「不显示」的那几段）
   * 群的这条链路顺便补上"藏起来之后还能找回来"：抽屉里点它就能重新打开。
   *
   * ⚠️ 群 id ≠ 会话 id（2026-10-20 拆表之后）。传进来的可能是**某一段群会话**，
   * 所以要拿 `groupId` 去筛；老群（迁移时把会话 id 复用成了群 id）两者相同，也照样成立。
   */
  const isGroup = conv?.kind === 'group';
  if (!conv?.id || (!isGroup && !conv.personaId)) return;
  S.drawerKind = 'log';       // 先分流，再画 —— paintDrawer 首行就看它
  S.drawerOpen = true;
  S.drawerThreadId = conv.id; // 沿用"换会话就关抽屉"的判断，同时用来标「当前」
  S.logPersonaId = isGroup ? null : conv.personaId;
  S.logGroupId = isGroup ? conv.groupId || conv.id : null;
  S.logGroupTitle = isGroup ? conv.title ?? null : null;
  S.logLoading = true;
  paintDrawer();              // 先画「正在拉…」
  $('drawer').classList.add('open');
  $('scrim').classList.add('open');
  try {
    await load();             // 只刷 /api/state（含 conversations），成本远低于一条新接口
    S.logLoading = false;
    // 拉的过程里用户可能已经关了抽屉 / 换成群设置 —— 只在这条路上重画
    if (S.drawerKind === 'log') paintDrawer();
  } catch (err) {
    S.logLoading = false;
    // 严格说这不是「会话域」错误（是 /api/state 失败）：映射表里查不到 → 原样回落
    toastConvErr(err);
    closeDrawer();
  }
}



/**
 * 这段会话里**有没有过一条消息**。
 *
 * 用途：只点开、一个字没发的会话**不进聊天记录**（2026-10-20 用户要求）——
 * 「发消息」建出来的空壳、点错又退出的空壳，都不该占历史列表的位置。
 *
 * 判据优先级：`messageCount`（服务端现算，准确）→ 回落到 `lastMessage`
 * （老版本服务端没有这个字段时不能让抽屉整片空掉）。`0` 与缺失要区分开：
 * `0` 是"确实没有消息"，不能用 `?? lastMessage` 那套把 0 当缺失。
 */
export function hasAnyMessage(c) {
  if (typeof c?.messageCount === 'number') return c.messageCount > 0;
  return !!c?.lastMessage;
}



/**
 * 聊天记录抽屉的正文。分流由 `paintDrawer()` 首行负责，这里只管画。
 *
 * 行数据**每次现算**（`S.conversations` 过滤），不缓存副本；**不排序** ——
 * `listConversations` 已经 `ORDER BY updatedAt DESC`。**不显示条数**（PRD v1.1 砍掉了）。
 */
export function paintChatLogDrawer() {
  /*
   * 数据来源两处（2026-10-20 去掉会话归档之后）：
   *   · `S.conversations`        —— 列表里的（含当前这段）
   *   · `S.hiddenConversations`  —— 被「不显示」收走的
   * 两者都是"这个人的历史"，所以合并后按 updatedAt 倒序；不合并的话，
   * 「不显示」就等于永久消失，与用户要的"列表不显示、聊天记录还能看到"相反。
   *
   * 群走另一套口径（`S.logGroupId`）：取**这个群自己**的全部会话（含被「不显示」的），
   * 一个群可以有多段（每次「发消息」一段）。只取一条的话，群藏起来之后剩下的入口
   * 就只能看到"最近那一段"，更早的全看不见了。
   *
   * **零消息的会话两边都不进抽屉**（2026-10-20 用户要求：群跟单聊同一条业务口径）——
   * 只点开、一个字没发的空壳（每次「发消息」都会建一段）不该占历史列表的位置。
   * 判据统一走 `hasAnyMessage()`，群不再有例外。
   */
  const isGroupTarget = !!S.logGroupId;
  const rows0 = [...(S.conversations ?? []), ...(S.hiddenConversations ?? [])]
    .filter((c) =>
      (isGroupTarget
        ? (c.groupId || c.id) === S.logGroupId && c.kind === 'group'
        : c.kind === 'direct' && c.personaId === S.logPersonaId) && hasAnyMessage(c),
    )
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  /*
   * 抽屉标题里那个人/群的名字：
   *   · 群 → `S.logGroupTitle`（不依赖 rows，空抽屉也知道在看哪个群）
   *   · 单聊 → 员工现在的名字（可能改过）
   *   · 员工已删的归档会话 → S.personas 里查不到，退回这段会话自己的标题，
   *     否则标题只剩「聊天记录」四个字，看不出是谁的
   */
  const name = isGroupTarget
    ? S.logGroupTitle || rows0[0]?.title || ''
    : S.personas.find((p) => p.id === S.logPersonaId)?.name ||
      (S.conversation?.personaId === S.logPersonaId ? S.conversation.title : '') ||
      '';
  /*
   * 标题里那个「和 X」只用在**员工还在**的时候；员工已删的归档会话用的是会话标题
   * （「王鹏，你结婚了吗」），再拼个「和」就成了「和 王鹏，你结婚了吗」——不像话。
   */
  const personaAlive = !isGroupTarget && (S.personas ?? []).some((p) => p.id === S.logPersonaId);
  const nameLabel = name ? (isGroupTarget || !personaAlive ? esc(name) : '和 ' + esc(name)) : '';

  let lastSec = '';
  const rows = [];
  for (const c of rows0) {
    const sec = dayBucket(c.updatedAt);
    // 分组标题只在**跨桶**时画一次（同一桶连着几条不重复）
    if (sec && sec !== lastSec) {
      rows.push(`<div class="chatlog-sec">${esc(sec)}</div>`);
      lastSec = sec;
    }
    /*
     * 预览粗体；空会话在单聊里**回落标题**（列表里要靠标题才认得出是跟谁的）。
     * 群的空会话进不了抽屉（上面已按 `hasAnyMessage` 滤掉），这里只是防御性兜底
     * —— 万一将来放开，也不会让几行群会话长得一模一样（每段 title 都是群名）。
     */
    const preview = isGroupTarget
      ? cut(plain(c.lastMessage), 28) || '（这段还没说话）'
      : cut(plain(c.lastMessage), 28) || c.title || '还没聊过';
    // 「当前」标的是"你正在看的那一段"：抽屉从聊天头部打开时它就是当前会话；
    // 从历史会话再打开一次，标记跟着你走（比固定标最新那条更符合直觉）
    const cur = c.id === S.drawerThreadId ? '<i class="chatlog-cur">当前</i>' : '';
    rows.push(`<div class="chatlog-row" data-log="${esc(c.id)}">
      <div class="t"><b>${esc(preview)}${cur}</b><span>${esc(logTime(c.updatedAt))}</span></div>
    </div>`);
  }

  let body;
  if (S.logLoading) {
    body = '<div class="empty" style="padding:32px 12px">正在拉…</div>';
  } else {
    /*
     * 只有当前这一段时**不画任何提示**（2026-10-20 用户要求去掉
     * 「还没有更早的会话 / 每次点『发消息』都会开一段新的」两行文案）：
     * 抽屉里只有一条就是事实本身，画一句解释反而像在说"功能只有这些"。
     * 一条都没有（会话一个字都没说）时也只留空白 —— 空就是空。
     */
    body = rows.join('');
  }

  $('drawer').innerHTML = `
    <div class="drawer-head">
      <b>聊天记录${nameLabel ? ` <span class="dim" style="font-weight:400;font-size:12px">${nameLabel}</span>` : ''}</b>
      <button class="mini" id="drawerClose" title="关闭">×</button>
    </div>
    <div class="drawer-body">${body}</div>`;

  $('drawerClose').onclick = closeDrawer;
  $('drawer').querySelectorAll('[data-log]').forEach((el) => {
    el.onclick = () => {
      // **先关抽屉再开会话**：openConversation 里有"换了会话就关抽屉"的判断，
      // 顺序反过来两边会抢状态（设计 §5.4）。用 openConversationSafe 是因为
      // 这段可能刚被另一个窗口删掉（E2047 → 说人话 + 关抽屉 + 刷列表）
      closeDrawer();
      openConversationSafe(el.dataset.log);
    };
  });
}



/**
 * 聊天记录抽屉里右键「删除」的那一段（2026-10-20 用户要求：单聊与群的聊天记录都能删）。
 *
 * 跟左栏右键「删除」是**同一件事、同一个接口**：物理删、不可恢复、确认框同一句话
 * （文案口径见 `removeConversationForever`）。差别只在删完重画哪儿：
 *   · 左栏 → 重画列表；
 *   · 这里 → 还要把抽屉自己刷新一次（删的正是抽屉里的那一行），
 *     一条都不剩就直接关掉（空抽屉只剩个标题，看着像出错了）；
 *   · 删的正好是**正在看的那段** → 右边复位（不留一具尸体让人继续打字）。
 *
 * 跑的中的段不删：服务端回 409 + E4002，`toastConvErr` 会说清"等它跑完或先终止"。
 */
export async function deleteSessionFromLog(c) {
  // 整档清空（已解散的群 / 员工已删的单聊）：确认框必须说"全部聊天记录"（与后端分派一致）
  const wipe = wipeScopeOf(c);
  const ok = await confirmDo(
    wipe === 'group'
      ? '这个群已解散。删除后会清空它的全部聊天记录，不可恢复。请确认是否操作？'
      : wipe === 'persona'
        ? '这个员工已删除。删除后会清空他的全部聊天记录，不可恢复。请确认是否操作？'
        : '本次会话删除后，消息内容不可恢复。请确认是否操作？',
    {
      title: wipe ? '删除并清空聊天记录' : '永久删除这段会话',
      ok: '永久删除',
      danger: true,
    },
  );
  if (!ok) return;
  try {
    const r = await api(`/api/conversations/${encodeURIComponent(c.id)}`, { method: 'DELETE' });
    S.conversations = r.conversations ?? (S.conversations ?? []).filter((x) => x.id !== c.id);
    if (r.hiddenConversations) S.hiddenConversations = r.hiddenConversations;
    // 清档：右边停在**这一档里的任何一段**都得复位（全没了）
    const hitting =
      wipe === 'group'
        ? S.conversation?.groupId === gidOf(c)
        : wipe === 'persona'
          ? S.conversation?.kind === 'direct' && S.conversation?.personaId === c.personaId
          : S.conversation?.id === c.id;
    if (hitting) resetChatPane();
    if (S.drawerKind === 'log') {
      // 抽屉当前盯着谁（人 / 群），看它还剩不剩段 —— 剩就重画，不剩就关
      const all = [...(S.conversations ?? []), ...(S.hiddenConversations ?? [])].filter(hasAnyMessage);
      const left = S.logGroupId
        ? all.filter((x) => x.kind === 'group' && (x.groupId || x.id) === S.logGroupId)
        : all.filter((x) => x.kind === 'direct' && x.personaId === S.logPersonaId);
      if (left.length) paintDrawer();
      else closeDrawer();
    }
    renderList();
    toast(
      wipe === 'group'
        ? '已删除。这个群的聊天记录都清掉了'
        : wipe === 'persona'
          ? '已删除。他的聊天记录都清掉了'
          : '已删除这段会话',
    );
  } catch (err) {
    /*
     * E2047 = 另一个窗口刚把它删了：抽屉里那行已经不存在，**列表和抽屉都得刷**，
     * 否则用户对着死行再点一次又撞同一个错（跟 openConversationSafe 一个套路）。
     */
    if (err?.code === 'E2047') {
      if (S.conversation?.id === c.id) resetChatPane();
      await load().catch(() => {});
      if (S.drawerKind === 'log') paintDrawer();
      renderList();
    }
    toastConvErr(err);
  }
}



/* -------------------------------------------------------------- 群详情页 */

/**
 * 通讯录里点群聊进来的页面：跟员工详情一个套路，要聊再点「发消息」。
 *
 * 入参是**群**（groups 表那一行：id / title / assistantPersonaId / members），
 * 不是会话 —— 一个群下面有多段会话，群名、群助手、成员都属于群本身。
 */
export function paintGroupDetail(group) {
  S.groupThread = group;
  S.groupThreadId = group.id;
  // 左栏标题固定「通讯录」（不做面包屑，2026-10-20；右页头已去掉，名字/群助手/人数都在正文的 hero 里）
  setListTitle('通讯录');
  const assistant = group.members.find((m) => m.personaId === group.assistantPersonaId);

  $('groupView').innerHTML = `
    <div class="detail-body">
      <div class="hero">
        <div class="avatar grp big">${esc(initial(group.title))}</div>
        <div>
          <h2>${esc(group.title)}</h2>
          <div class="sub">群助手：${esc(assistant?.name ?? '—')} · ${group.members.length} 人</div>
        </div>
        <!-- 「⋯」收解散入口（2026-10-20 用户要求）：破坏性动作别跟「发消息」平起平坐，
             也别平铺在页面底部 —— 收进菜单，点开才露。样式/交互沿用员工详情那套 hero-more -->
        <div class="hero-actions">
          <button class="primary" id="gMsg">发消息</button>
          <div class="hero-more">
            <button type="button" class="hero-more-btn" id="gMore" title="更多操作">⋯</button>
            <div class="hero-more-menu" id="gMoreMenu" hidden>
              <button class="danger" id="gDissolve">解散群聊</button>
            </div>
          </div>
        </div>
      </div>
      ${groupSettingsHTML(group, { noDissolve: true })}
    </div>`;

  $('gMsg').onclick = () => toGroupMessages(group);

  /* 「⋯」开合 + 点外面收。菜单本身在 .hero-more 里，外点收起的判据靠它 */
  const closeMore = () => { const m = $('gMoreMenu'); if (m) m.hidden = true; };
  $('gMore').addEventListener('click', (e) => {
    e.stopPropagation();
    const m = $('gMoreMenu');
    if (m) m.hidden = !m.hidden;
  });
  const gMoreOutside = (e) => {
    if (!e.target.closest?.('.hero-more')) closeMore();
  };
  document.addEventListener('click', gMoreOutside);
  (window.__pageCleanups ??= []).push(() => document.removeEventListener('click', gMoreOutside));
  $('gDissolve').onclick = () => { closeMore(); dissolveGroup(group); };

  wireGroupSettings(group, () => paintGroupDetail(group), $('groupView'));
}



/**
 * 群详情「发消息」= **开一段新的群会话**（2026-10-20 用户要求：群也像单聊那样一次任务一段）。
 *
 * 为什么不能直接 `openConversation(groupId)`：群 id 和会话 id 是两套 id，
 * 拿群 id 去开会话是 404（拆表前它们恰好相同，所以这条错误很隐蔽）。
 * 所以要么复用当前空会话，要么让服务端落一段新的（`POST /api/groups/:id/sessions`）。
 *
 * 连点保护跟单聊（toMessages）同一个口径：当前就停在这个群一段**一条消息都没有**的会话上
 * → 直接复用，别堆空壳。判据是 `S.convEmpty`，由 openConversation 按服务端 messages 写。
 */
/**
 * 群详情「发消息」= **开一段新的群会话**（2026-10-20 用户要求：群也像单聊那样一次任务一段）。
 *
 * 为什么不能直接 `openConversation(groupId)`：群 id 和会话 id 是两套 id，
 * 拿群 id 去开会话是 404（拆表前它们恰好相同，所以这条错误很隐蔽）。
 * 所以要么复用当前空会话，要么让服务端落一段新的（`POST /api/groups/:id/sessions`，
 * 服务端顺手把整群的「不显示」撤掉 —— 发起 = 明确要用这个群，列表得回来）。
 *
 * 连点保护跟单聊（toMessages）同一个口径：当前就停在这个群一段**一条消息都没有**的会话上
 * → 直接复用，别堆空壳。判据是 `S.convEmpty`，由 openConversation 按服务端 messages 写。
 *
 * ⚠️ 复用有个例外（用户实报「发起群聊会话列表里没有」）：那段空会话**正被「不显示」收着**
 * 的时候不能复用 —— 复用既不建新段也不发消息，群就永远没有回列表的机会。
 * 所以被收着的空会话一律走新建，让服务端的"发起即回列表"接手。
 */
export async function toGroupMessages(group) {
  const cur = S.conversation;
  const reuse =
    !!cur &&
    cur.kind === 'group' &&
    cur.groupId === group.id &&
    S.convEmpty &&
    // 正被「不显示」收着的空会话不复用（visible = 这段还在消息列表的数据源里）
    (S.conversations ?? []).some((c) => c.id === cur.id);
  try {
    const convId = reuse
      ? cur.id
      : (await post(`/api/groups/${encodeURIComponent(group.id)}/sessions`)).conversation.id;
    setNav('messages');
    showView('chat');
    await openConversationSafe(convId);
    if (S.conversation?.id !== convId) return;
    await load();
    $('input').focus();
  } catch (err) { toastConvErr(err); }
}



export async function openGroupDetail(groupId) {
  setRoute('group', { id: groupId });
  let d;
  try {
    d = await api('/api/groups/' + encodeURIComponent(groupId));
  } catch (err) {
    // 刷新后残留的旧路由 / 另一个窗口刚解散的群：别卡在一个空白详情页上
    toastConvErr(err);
    setNav('messages');
    return;
  }
  // 先把抽屉清空：两边都渲染同一批 id（drawerSearch 等），同时存在必然打架
  closeDrawer();
  S.memberQuery = '';
  S.removeMode = false;
  S.membersExpanded = false;
  showView('group');
  renderList();
  paintGroupDetail(d.group);
}



/* -------------------------------------------------------------- 群加人 */

export const memberPicked = new Set();


export let memberCandidates = [];



/** 候选列表：一律不预选；勾选状态记在 memberPicked 里，搜索重画也不会丢 */
export function renderMemberCandidates() {
  const q = ($('mSearch').value || '').trim().toLowerCase();
  const rows = memberCandidates.filter((p) => !q || p.name.toLowerCase().includes(q));
  $('mList').innerHTML = rows.length
    ? rows
        .map(
          (p) => `<label class="member">
            <input type="checkbox" value="${p.id}" ${memberPicked.has(p.id) ? 'checked' : ''} />
            <span>${esc(p.name)}</span><em>${esc(String(p.role ?? '').split(' · ')[0].trim() || '—')}</em>
          </label>`,
        )
        .join('')
    : '<div class="dim" style="padding:10px 2px">没找到</div>';
  $('mList').querySelectorAll('input').forEach((el) => {
    el.onchange = () => { if (el.checked) memberPicked.add(el.value); else memberPicked.delete(el.value); };
  });
}



export function openMemberDialog(thread) {
  const inGroup = new Set(thread.members.map((m) => m.personaId));
  memberCandidates = S.personas.filter((p) => !inGroup.has(p.id));
  if (!memberCandidates.length) return toast('所有数字员工都已经在群里了');
  memberPicked.clear();
  $('mSearch').value = '';
  renderMemberCandidates();
  $('memberDlg').dataset.thread = gidOf(thread);
  $('memberDlg').showModal();
}
