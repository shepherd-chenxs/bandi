/* inbox.mjs —— 信箱（2026-11-11 用户拍板：左栏最上面的一级栏）。
 *
 * 平台事实的**账本页面**：建卡失败这类"机器侧出了事"由服务端写进 notices 表，这里只读出来。
 * 不做弹框、不往群里播报（用户明确不要）—— 左栏一个未读角标 + 这一页就够了；
 * 以后别的通知（运行失败、定时失败、鉴权失效……）也往同一张表里写，这页不用改结构。
 *
 * 2026-11-11 用户："改成左侧列表，右边详情" —— 这一页改成**主从形态**，跟通讯录、
 * 组织架构同一套语法（不再占掉左栏整列）：
 *   · 左栏二级列表（renderInboxList 画进 #listBody）：全部/未读筛选 + 一行一条通知；
 *     底部固定条（#listFoot）放「全部已读」—— 跟消息/工作流的「已归档」同一个位置，
 *     没有未读时整条不占高度（`.list-foot:empty`）。
 *   · 右区（#inboxView）：选中那条的全文 + 平台事实（类型/严重度/员工/错误码/次数/时间）；
 *     没选时是一句说明的空态 —— 清单和详情之间的分隔线由骨架（.list-panel 的右边框）给。
 *
 * 已读规则（信箱语义，不是通知中心的"一开就清"）：
 *   · 新通知 = 未读（左栏角标数它）；
 *   · 点开一条 = 这条已读；「全部已读」= 一次清掉；
 *   · 同一件事重试多次只记一条、次数累加（服务端去重），不会刷屏。
 *
 * 数据只留一份（`inbox`）：左栏会被 renderList 这个**通用重画入口**调到（切栏、轮询、
 * 输入搜索都会来），不能每次重画都重新拉网络；openInbox / 标记已读后再换新。
 */
import { esc, setRoute } from './shell.mjs';
import { showView } from './contacts.mjs';
import { headRow } from './connectors.mjs';
import { confirmDo } from './machine.mjs';
import { api } from './ui.mjs';
import { $, S } from './core.mjs';

const KIND_LABEL = {
  'card.create.failed': '建卡失败',
};
const SEV_LABEL = { info: '提示', warn: '注意', blocking: '阻塞' };
/** 严重度只用一个符号（跟改版前的圆点一致）：机器事实，不用 emoji 也不分"好消息/坏消息" */
const SEV_ICON = { info: 'i', warn: '!', blocking: '!' };

/**
 * 这一页唯一的一份数据：左栏清单 + 当前选中的那条。
 * `loaded` 用来区分"还没取到"（清单位先画「读取中…」）和"信箱真的是空的"。
 * `selected` 存通知 id；从位置记忆恢复（openInbox(id)）时也认它。
 */
const inbox = { list: [], loaded: false, selected: null, manage: false, sel: new Set() };

/** 左栏角标：未读数（0 时藏起来）。手机「我的」页那一行也显示同一个数 */
export function paintInboxBadge(n = S.noticesUnread ?? 0) {
  S.noticesUnread = Number(n) || 0;
  const el = $('inboxBadge');
  if (el) {
    el.hidden = S.noticesUnread <= 0;
    el.textContent = S.noticesUnread > 99 ? '99+' : String(S.noticesUnread);
  }
  /*
   * 手机端入口（2026-11-11）：hero 右上角那颗信封图标上的未读红点（#meInboxDot）
   * 与左栏角标同源。这一页开着的时候读掉一条，红点也跟着藏/显 —— 不重进
   * 「我的」也能看到（元素不在就跳过，桌面没有）。
   */
  const dot = $('meInboxDot');
  if (dot) {
    dot.hidden = S.noticesUnread <= 0;
    dot.textContent = S.noticesUnread > 99 ? '99+' : String(S.noticesUnread);
  }
}

/** 角标轮询：失败是后台发生的，页面不会自己知道；30 秒一次轻量口（切走页面不刷） */
export async function refreshInboxBadge() {
  if (document.hidden) return;
  try {
    const d = await api('/api/notices/unread');
    paintInboxBadge(d?.unread ?? 0);
  } catch { /* 网络/会话问题下次再说，不打扰人 */ }
}

setInterval(refreshInboxBadge, 30000);

/* 左栏一行放得下"月-日 时:分"；详情页给完整日期 */
const fmtListTime = (iso) => (iso ? String(iso).replace('T', ' ').slice(5, 16) : '');
const fmtFullTime = (iso) => (iso ? String(iso).replace('T', ' ').slice(0, 16) : '');

const kindOf = (n) => KIND_LABEL[n.kind] ?? n.kind ?? '通知';
const sevOf = (n) => SEV_LABEL[n.severity] ?? '注意';

/** 左栏一行（.item 是左栏行的公共类：窄屏的主从折叠、按压态、分割线都认它） */
const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5 11-11"/></svg>';

function rowHTML(n) {
  const unread = !n.readAt;
  const checked = inbox.manage && inbox.sel.has(n.id);
  return `<div class="item inbox-item${unread ? ' unread' : ''}${inbox.selected === n.id ? ' active' : ''}"
      data-notice="${esc(n.id)}" role="button" tabindex="0">
    ${inbox.manage ? `<div class="inbox-check${checked ? ' on' : ''}" aria-hidden="true">${checked ? CHECK_SVG : ''}</div>` : ''}
    <div class="inbox-ico ${esc(n.severity ?? 'warn')}" aria-hidden="true">${SEV_ICON[n.severity] ?? '!'}</div>
    <div class="who">
      <div class="line1"><b>${esc(n.title || kindOf(n))}</b><span>${esc(fmtListTime(n.updatedAt ?? n.createdAt))}</span>${unread ? '<span class="inbox-new">新</span>' : ''}</div>
      <div class="line2">${esc(n.detail || '（这条通知没有更多说明）')}</div>
    </div>
  </div>`;
}

/*
 * 手机列表页头的「返回」图标钮（2026-11-11 用户："加一个返回图标按钮"）：
 * 信箱在手机上是「我的」的下一级（tab 高亮同一条规矩，见 mobile.mjs syncTabs），
 * 页头左侧给一颗实体返回钮 —— 与通讯录子页的「←」同一个类（.mb-head-back，
 * absolute 钉在 .list-head 左缘、accent chevron 22px、44px 触控），回「我的」走
 * mb-nav 事件（本站解环手法，mobile.mjs 统一转 setNav）。
 * 只在窄屏挂（桌面信箱是一级栏，没有"回来"的概念）；renderList 每次重画都先
 * 摘 .mb-head-back（contacts.mjs 的通用清扫），所以每次 paintList 都重挂一遍，
 * 挂前查重防筛选切换（paintListKeepScroll 不走 renderList）时叠两颗。
 */
function paintHeadBack() {
  if (!document.body.classList.contains('mb-narrow')) return;
  const head = document.querySelector('.list-head');
  if (!head || head.querySelector('.mb-head-back')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mb-head-back';
  btn.setAttribute('aria-label', '返回我的');
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>';
  btn.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('mb-nav', { detail: { nav: 'me' } }));
  });
  head.prepend(btn);
}

/**
 * 画左栏（整栏重建）。
 *
 * 只重画 #listBody / #listFoot，不碰右区 —— 搜索、切筛选、标已读都走它；
 * 右区由 paintDetail 单独管，两者互不依赖。
 */
/*
 * 左栏搜索（2026-11-12 用户："加搜索框"）：用骨架里全站共用的 #search（app.mjs 的
 * input 监听把词写进 S.filter 再调 renderList —— 这里不用自己接键盘事件），进页时
 * state.mjs 已把占位文案归位成「搜索」，这里在信箱自己的画法里换成说人话的。
 * 匹配范围：标题 / 正文 / 类型 / 错误码 / 员工 —— 搜 E2058 这种码是主要场景。
 */
function matchFilter(n, q) {
  if (!q) return true;
  return [n.title, n.detail, n.code, n.personaName, kindOf(n)]
    .some((v) => String(v ?? '').toLowerCase().includes(q));
}

function paintList() {
  // 左栏属于当前的一级栏：切走了就不许画（同 renderFlowList / renderOrgList 的守卫）
  if (S.nav !== 'inbox') return;
  const body = $('listBody');
  if (!body) return;
  const si = $('search');
  if (si) si.placeholder = '搜标题 / 内容 / 错误码';
  paintHeadBack();
  const foot = $('listFoot');
  if (foot) foot.innerHTML = '';
  if (!inbox.loaded) {
    body.innerHTML = '<div class="empty" style="padding:24px 12px">读取中…</div>';
    return;
  }
  const q = String(S.filter ?? '').trim().toLowerCase();
  const unread = inbox.list.filter((n) => !n.readAt).length;
  const shown = (S.inboxFilter === 'unread' ? inbox.list.filter((n) => !n.readAt) : inbox.list)
    .filter((n) => matchFilter(n, q));
  const emptyText = q
    ? `没有匹配「${q}」的通知`
    : S.inboxFilter === 'unread' ? '没有未读通知' : '信箱是空的';
  const rows = shown.length
    ? shown.map(rowHTML).join('')
    : `<div class="empty" style="padding:24px 12px">${esc(emptyText)}</div>`;
  body.innerHTML = `<div class="inbox-tabs">
      <button type="button" class="inbox-tab${S.inboxFilter === 'all' ? ' on' : ''}" data-inbox-filter="all">全部<span class="inbox-n">${inbox.list.length}</span></button>
      <button type="button" class="inbox-tab${S.inboxFilter === 'unread' ? ' on' : ''}" data-inbox-filter="unread">未读<span class="inbox-n">${unread}</span></button>
    </div>${rows}`;
  // 切「全部 / 未读」：只重画左栏；右区不跟着清 —— 选中那条不在筛选结果里也照样能读
  body.querySelectorAll('[data-inbox-filter]').forEach((el) => {
    el.onclick = () => {
      S.inboxFilter = el.dataset.inboxFilter;
      paintListKeepScroll();
    };
  });
  // 点一条 = 选中（看详情）+ 这条已读（信箱语义；不是整页一开就清）。
  // 管理模式下点行 = 勾选 / 取消勾选（2026-11-12 批量删除），不开详情、不标已读。
  body.querySelectorAll('[data-notice]').forEach((el) => {
    el.onclick = () => {
      if (inbox.manage) {
        const id = el.dataset.notice;
        if (inbox.sel.has(id)) inbox.sel.delete(id);
        else inbox.sel.add(id);
        paintListKeepScroll();
        return;
      }
      selectNotice(el.dataset.notice);
    };
    el.onkeydown = (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      el.click();
    };
  });
  // 底部固定条：普通态 = 管理 + 全部已读；管理模式 = 全选 / 删除所选 / 完成。
  // 信箱里一条都没有时不渲染（.list-foot:empty 不占高度）。
  if (foot && inbox.list.length) {
    if (inbox.manage) {
      const shownIds = shown.map((n) => n.id);
      const allSel = shownIds.length > 0 && shownIds.every((id) => inbox.sel.has(id));
      const n = inbox.sel.size;
      foot.innerHTML = `<div class="inbox-foot-row">
        <button type="button" class="inbox-foot-btn" id="inboxSelAll">${allSel ? '取消全选' : '全选'}</button>
        <button type="button" class="inbox-foot-btn danger" id="inboxDelSel"${n ? '' : ' disabled'}>删除所选${n ? `（${n}）` : ''}</button>
        <button type="button" class="inbox-foot-btn" id="inboxManageExit">完成</button>
      </div>`;
      foot.querySelector('#inboxSelAll').onclick = () => {
        if (allSel) shownIds.forEach((id) => inbox.sel.delete(id));
        else shownIds.forEach((id) => inbox.sel.add(id));
        paintListKeepScroll();
      };
      foot.querySelector('#inboxDelSel').onclick = async () => {
        const ok = await confirmDo(`删除所选的 ${n} 条通知？删了就找不回来了。`, { ok: '删除', title: '删除通知' });
        if (ok) removeNotices([...inbox.sel]);
      };
      foot.querySelector('#inboxManageExit').onclick = () => setManage(false);
    } else {
      foot.innerHTML = `<div class="inbox-foot-row">
        <button type="button" class="inbox-foot-btn" id="inboxManageBtn">管理</button>
        ${unread ? `<button type="button" class="inbox-foot-btn" id="inboxAllRead" title="把这些通知全部标为已读">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
               stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5 11-11"/></svg>
          全部已读<span class="inbox-n">${unread}</span></button>` : ''}
      </div>`;
      foot.querySelector('#inboxManageBtn').onclick = () => setManage(true);
      const readBtn = foot.querySelector('#inboxAllRead');
      if (readBtn) readBtn.onclick = markAllRead;
    }
  }
}

/** 进入 / 退出管理模式（批量删除）；进入时先清空勾选 */
function setManage(on) {
  inbox.manage = on;
  if (on) inbox.sel.clear();
  paintListKeepScroll();
}

/**
 * 删通知（单条 / 批量共用）：先本地摘掉重画（点了要马上有反应），再发请求；
 * 失败就把清单原样还回去，别让人以为删成了 —— 跟 markAllRead 的"先画后请求"同一套手法。
 */
async function removeNotices(ids) {
  const set = new Set(ids.map(String));
  const snapshot = inbox.list;
  const prevSel = inbox.selected;
  inbox.list = inbox.list.filter((n) => !set.has(n.id));
  if (inbox.selected && set.has(inbox.selected)) inbox.selected = null;
  inbox.sel.clear();
  inbox.manage = false;
  paintListKeepScroll();
  paintDetail();
  try {
    const d = await api('/api/notices/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [...set] }),
    });
    paintInboxBadge(d?.unread ?? 0);
  } catch (e) {
    // 失败回滚：清单、选中、管理模式都退回删除前的样子
    inbox.list = snapshot;
    inbox.selected = prevSel && !set.has(prevSel) ? prevSel : null;
    paintListKeepScroll();
    paintDetail();
  }
}

/** 重建左栏但把滚动位置还回去（点一条/标已读后重画，清单别跳回顶部） */
function paintListKeepScroll() {
  const body = $('listBody');
  const top = body?.scrollTop ?? 0;
  paintList();
  if (body) body.scrollTop = top;
}

/**
 * 选中一条：右区立刻画（全文本来就在手里），再把它标成已读。
 *
 * 顺序是"先画后请求"：网络慢的时候点一下要马上有反应；标已读失败也不影响看内容
 * （本地先按已读画，下次打开信箱以服务端为准）。
 */
function selectNotice(id) {
  const hit = inbox.list.find((n) => n.id === id);
  if (!hit) return;
  inbox.selected = id;
  setRoute('inbox', { id });
  if (!hit.readAt) {
    hit.readAt = new Date().toISOString();
    paintInboxBadge(Math.max(0, (S.noticesUnread ?? 1) - 1));
    paintListKeepScroll();
    api('/api/notices/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
      .then((d) => paintInboxBadge(d?.unread ?? 0))
      .catch(() => { /* 标已读失败不打扰人：角标下次轮询/重开信箱会自己对齐 */ });
  } else {
    paintListKeepScroll(); // 换高亮
  }
  paintDetail();
}

/** 「全部已读」：一次清掉；清完左栏、右区和角标一起对齐 */
async function markAllRead() {
  const now = new Date().toISOString();
  inbox.list.forEach((n) => { if (!n.readAt) n.readAt = now; });
  paintListKeepScroll();
  paintDetail();
  try {
    const d = await api('/api/notices/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true }),
    });
    paintInboxBadge(d?.unread ?? 0);
  } catch (e) {
    // 失败就退回未读样子，别让人以为真清了
    inbox.list.forEach((n) => { if (n.readAt === now) n.readAt = null; });
    paintListKeepScroll();
    paintDetail();
  }
}

/** 右区空态：清单里没东西 vs 有东西但没选，各说各的 */
function emptyHTML() {
  const hasRows = inbox.loaded && inbox.list.length > 0;
  return `${headRow('<b>信箱</b>')}
    <div class="detail-body">
      <div class="inbox-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="5.5" width="18" height="13" rx="2" />
          <path d="M3.6 6.6 12 13l8.4-6.4" />
          <path d="M3 16.5l5.4-4.2M21 16.5l-5.4-4.2" />
        </svg>
        <div class="inbox-empty-title">${hasRows ? '在左侧选一条通知，查看详情' : '信箱是空的'}</div>
        ${hasRows ? '<div class="inbox-empty-sub">左侧是平台记下的事实清单，点一条只看这条的全文和上下文。</div>' : ''}
      </div>
    </div>`;
}

/** 右区：选中那条的详情（标题、全文、平台事实） */
function detailHTML(n) {
  const unread = !n.readAt;
  const fact = (k, v) => `<div class="inbox-fact"><dt>${esc(k)}</dt><dd>${v}</dd></div>`;
  const facts = [
    fact('类型', esc(kindOf(n))),
    fact('严重度', esc(sevOf(n))),
    n.code ? fact('错误码', `<code class="inbox-code">${esc(n.code)}</code>`) : '',
    n.personaName || n.personaId ? fact('员工', esc(n.personaName ?? n.personaId)) : '',
    n.count > 1 ? fact('次数', esc(`×${n.count}（同一件事重试会累加）`)) : '',
    fact('最近发生', esc(fmtFullTime(n.updatedAt ?? n.createdAt))),
    fact('状态', unread ? '未读' : '已读'),
  ]
    .filter(Boolean)
    .join('');
  return `${headRow('<b>信箱</b>')}
    <div class="detail-body">
      <article class="inbox-detail">
        <header class="inbox-d-head">
          <div class="inbox-ico ${esc(n.severity ?? 'warn')} big" aria-hidden="true">${SEV_ICON[n.severity] ?? '!'}</div>
          <div class="inbox-d-head-main">
            <h2 class="inbox-d-title">${esc(n.title || kindOf(n))}</h2>
            <div class="inbox-d-meta">${esc(kindOf(n))} · ${esc(sevOf(n))} · ${esc(fmtFullTime(n.updatedAt ?? n.createdAt))}${
              unread ? ' · <span class="inbox-new">未读</span>' : ''
            }</div>
          </div>
          <button type="button" class="inbox-del" id="inboxDelOne" title="删除这条通知">删除</button>
        </header>
        <p class="inbox-d-text">${esc(n.detail || '（这条通知没有更多说明）')}</p>
        <dl class="inbox-facts">${facts}</dl>
      </article>
    </div>`;
}

/** 右区重画：选中那条 → 详情；没选中 → 空态（右区不跟着左栏筛选走） */
function paintDetail() {
  const view = $('inboxView');
  if (!view) return;
  const hit = inbox.selected ? inbox.list.find((n) => n.id === inbox.selected) : null;
  if (!hit) inbox.selected = null;
  view.innerHTML = hit ? detailHTML(hit) : emptyHTML();
  // 详情页的单条删除（2026-11-12）：不进管理模式也能删；确认一次再动手
  const btn = view.querySelector('#inboxDelOne');
  if (btn && hit) {
    btn.onclick = async () => {
      const ok = await confirmDo('删除这条通知？删了就找不回来了。', { ok: '删除', title: '删除通知' });
      if (ok) removeNotices([hit.id]);
    };
  }
}

/** 拉数据 + 画左右两边（打开信箱 / 从位置记忆恢复都走它） */
export async function renderInbox() {
  const view = $('inboxView');
  if (!view) return;
  view.innerHTML = '<div class="empty" style="padding:40px 16px">读取中…</div>';
  try {
    const d = await api('/api/notices');
    paintInboxBadge(d?.unread ?? 0);
    inbox.list = d?.notices ?? [];
    inbox.loaded = true;
    // 重拉数据 = 管理态作废（勾的是上一份清单，认不得）
    inbox.manage = false;
    inbox.sel.clear();
    // 位置记忆里那条可能已经被清掉了（通知会随库清理/换机器消失）：认不出就回空态
    if (inbox.selected && !inbox.list.some((n) => n.id === inbox.selected)) inbox.selected = null;
    paintListKeepScroll();
    paintDetail();
    /*
     * 窄屏从位置记忆直达某条详情（刷新后走 restorePlace → openInbox(id)）：
     * 没人点列表行，mobile.mjs 不会自己折叠出详情态，main 会被 mobile.css 藏掉 ——
     * 内容画了也看不见。照 chat.mjs 的做法派 `mb-detail` 事件补上展开态与历史。
     */
    const hit = inbox.selected ? inbox.list.find((n) => n.id === inbox.selected) : null;
    if (hit) {
      /*
       * 返回栏标题用「详情」而不是通知标题（2026-11-11 用户截图："导航栏标题改成详情"）：
       * 通知标题是整句话（"会话已轮换（上下文过长）"），塞进返回栏会被省略号截断，
       * 紧接着正文里又原样写了一遍 —— 同一句话出现两次，还一次是残的。
       * 这一类页面的返回栏只需要回答"你在哪一层"，不回答"这是哪一条"。
       */
      document.dispatchEvent(new CustomEvent('mb-detail', { detail: { title: '详情' } }));
    }
  } catch (e) {
    inbox.loaded = false;
    inbox.selected = null;
    const body = $('listBody');
    const foot = $('listFoot');
    if (body) body.innerHTML = '<div class="empty" style="padding:24px 12px">读取失败</div>';
    if (foot) foot.innerHTML = '';
    view.innerHTML = `<div class="empty" style="padding:40px 16px">取不到信箱：${esc(e.message)}</div>`;
  }
}

/**
 * 左栏重画（供 contacts.renderList 的统一入口在 nav === 'inbox' 时调）。
 * 名字带 "List" 是为了跟右区（renderInbox）分开：通用重画只该动左栏那一列。
 */
export function renderInboxList() {
  paintList();
}

/** 打开信箱（一级栏入口 / 路由恢复都用它）；id = 刷新前选中的那条，没有就空态 */
export function openInbox(id = null) {
  inbox.selected = id ? String(id) : null;
  setRoute('inbox', inbox.selected ? { id: inbox.selected } : {});
  showView('inbox');
  const view = $('inboxView');
  if (view) view.innerHTML = '<div class="empty" style="padding:40px 16px">读取中…</div>';
  return renderInbox();
}
