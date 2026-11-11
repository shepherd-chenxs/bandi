/* inbox.mjs —— 信箱（2026-11-11 用户拍板：左栏最上面的一级栏）。
 *
 * 平台事实的**账本页面**：建卡失败这类"机器侧出了事"由服务端写进 notices 表，这里只读出来。
 * 不做弹框、不往群里播报（用户明确不要）—— 左栏一个未读角标 + 这一页就够了；
 * 以后别的通知（运行失败、定时失败、鉴权失效……）也往同一张表里写，这页不用改结构。
 *
 * 已读规则（信箱语义，不是通知中心的"一开就清"）：
 *   · 新通知 = 未读（左栏角标数它）；
 *   · 点开一条 = 这条已读；「全部已读」= 一次清掉；
 *   · 同一件事重试多次只记一条、次数累加（服务端去重），不会刷屏。
 */
import { esc, setRoute } from './shell.mjs';
import { showView } from './contacts.mjs';
import { api } from './ui.mjs';
import { $, S } from './core.mjs';

const KIND_LABEL = {
  'card.create.failed': '建卡失败',
};
const SEV_LABEL = { info: '提示', warn: '注意', blocking: '阻塞' };

/** 左栏角标：未读数（0 时藏起来） */
export function paintInboxBadge(n = S.noticesUnread ?? 0) {
  S.noticesUnread = Number(n) || 0;
  const el = $('inboxBadge');
  if (!el) return;
  el.hidden = S.noticesUnread <= 0;
  el.textContent = S.noticesUnread > 99 ? '99+' : String(S.noticesUnread);
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

const fmtTime = (iso) => (iso ? String(iso).replace('T', ' ').slice(5, 16) : '');

function rowsHTML(list) {
  const shown = S.inboxFilter === 'unread' ? list.filter((n) => !n.readAt) : list;
  if (!shown.length) {
    return `<div class="empty" style="padding:40px 16px">${S.inboxFilter === 'unread' ? '没有未读通知' : '信箱是空的'}</div>`;
  }
  return shown
    .map((n) => {
      const kind = KIND_LABEL[n.kind] ?? n.kind ?? '通知';
      const sev = SEV_LABEL[n.severity] ?? '注意';
      const unread = !n.readAt;
      const meta = [
        n.personaId ? `${esc(n.personaName ?? n.personaId)}` : '',
        n.count > 1 ? `×${n.count}` : '',
        fmtTime(n.updatedAt ?? n.createdAt),
      ].filter(Boolean).join(' · ');
      return `<article class="inbox-row${unread ? ' unread' : ''}" data-notice="${esc(n.id)}" role="button" tabindex="0">
        <div class="inbox-ico ${esc(n.severity ?? 'warn')}" aria-hidden="true">${
          n.severity === 'blocking' ? '!' : n.severity === 'info' ? 'i' : '!'
        }</div>
        <div class="inbox-main">
          <div class="inbox-title"><b>${esc(n.title || kind)}</b>${n.code ? `<span class="inbox-code">${esc(n.code)}</span>` : ''}${unread ? '<span class="inbox-new">新</span>' : ''}</div>
          <div class="inbox-detail">${esc(n.detail || '')}</div>
          <div class="inbox-meta">${esc(kind)} · ${esc(sev)}${meta ? ' · ' + meta : ''}</div>
        </div>
      </article>`;
    })
    .join('');
}

/** 画列表（整页重建；数据由 renderInbox 现取） */
function paintInbox(list) {
  const view = $('inboxView');
  const unread = list.filter((n) => !n.readAt).length;
  view.innerHTML = `
    <div class="detail-head">
      <div class="head-title"><b>信箱</b></div>
      <div class="head-actions">
        <div class="inbox-tabs">
          <button type="button" class="inbox-tab${S.inboxFilter === 'all' ? ' on' : ''}" data-inbox-filter="all">全部<span class="inbox-n">${list.length}</span></button>
          <button type="button" class="inbox-tab${S.inboxFilter === 'unread' ? ' on' : ''}" data-inbox-filter="unread">未读<span class="inbox-n">${unread}</span></button>
        </div>
        <button type="button" class="primary" id="inboxAllRead"${unread ? '' : ' disabled'}>全部已读</button>
      </div>
    </div>
    <div class="detail-body">
      <div class="hint-line">这里放需要你知道、但不该打断你的事（比如建卡通道失败）。数字员工不会在这里说话，只有平台事实。</div>
      <div class="inbox-list" id="inboxList">${rowsHTML(list)}</div>
    </div>`;
  // 切「全部 / 未读」
  view.querySelectorAll('[data-inbox-filter]').forEach((el) => {
    el.onclick = () => { S.inboxFilter = el.dataset.inboxFilter; paintInbox(list); };
  });
  // 全部已读
  const allBtn = $('inboxAllRead');
  if (allBtn) {
    allBtn.onclick = async () => {
      try {
        const d = await api('/api/notices/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all: true }) });
        paintInboxBadge(d?.unread ?? 0);
        await renderInbox();
      } catch (e) { /* 失败就保持原样，下次再看 */ }
    };
  }
  // 点一条 = 这条已读（信箱语义；不是整页一开就清）
  view.querySelectorAll('[data-notice]').forEach((el) => {
    el.onclick = async () => {
      const id = el.dataset.notice;
      const hit = list.find((n) => n.id === id);
      if (!hit || hit.readAt) return;
      try {
        const d = await api('/api/notices/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
        hit.readAt = new Date().toISOString();
        paintInboxBadge(d?.unread ?? 0);
        paintInbox(list);
      } catch { /* 标已读失败不碍事 */ }
    };
    el.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); el.click(); } };
  });
}

/** 拉数据 + 画页（打开信箱 / 标记已读后都走它） */
export async function renderInbox() {
  const view = $('inboxView');
  if (!view) return;
  view.innerHTML = '<div class="empty" style="padding:40px 16px">读取中…</div>';
  try {
    const d = await api('/api/notices');
    paintInboxBadge(d?.unread ?? 0);
    paintInbox(d?.notices ?? []);
  } catch (e) {
    view.innerHTML = `<div class="empty" style="padding:40px 16px">取不到信箱：${esc(e.message)}</div>`;
  }
}

/** 打开信箱（一级栏入口 / 路由恢复都用它） */
export function openInbox() {
  setRoute('inbox');
  showView('inbox');
  $('inboxView').innerHTML = '<div class="empty" style="padding:40px 16px">读取中…</div>';
  return renderInbox();
}
