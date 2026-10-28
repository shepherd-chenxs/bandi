/* mobile.mjs —— 响应式壳（2026-11 手机端增量）。
 *
 * 职责（设计 §2 / §5 T03+T04）：纯行为，样式全在 mobile.css。
 *   ① 断点监听：≤900px 置 body.mb-narrow、≤600px 置 body.mb-tiny（双轨：纯样式走
 *      mobile.css 的 @media，行为相关折叠走这两个状态类）；
 *   ② 主从折叠：窄屏下"左栏列表 + 右栏详情"变两级导航 —— 点列表行进详情
 *      （body.mb-detail-open），顶部「← 返回」栏回列表，滚动位置保留；
 *   ③ 底部导航（P1-1）：≤900px 四 tab「工作台 / 通讯录 / 会话 / 我的」，详情页自动隐藏；
 *   ④ 键盘适配：visualViewport 高度喂给 --mb-vh，对话页输入栏不挡；
 *   ⑤ 401 引导（PRD P0-3）：手机形态下收到 E4010/E4012 → 全屏"重新扫码"提示，
 *      不做裸登录页；
 *   ⑥ 下拉刷新（P1-1）：列表一级页顶部下拉重拉 load()，节流。
 *
 * 骨架既有规矩的遵守：列表/详情 DOM 常驻，这里只切 body 状态类，不改任何渲染函数
 * 的输出结构；不动 #listBody 的 innerHTML；搜索/筛选照旧只重画结果块。
 */
import { load, setNav } from './state.mjs';
import { $ } from './core.mjs';

/* ---------------------------------------------------------------- ① 断点 */

const mqNarrow = window.matchMedia('(max-width: 900px)');
const mqTiny = window.matchMedia('(max-width: 600px)');

const isNarrow = () => mqNarrow.matches;
const isTiny = () => mqTiny.matches;

function applyBreakpoints() {
  document.body.classList.toggle('mb-narrow', mqNarrow.matches);
  document.body.classList.toggle('mb-tiny', mqTiny.matches);
  // 折出窄屏时把详情展开态一并清掉：回宽屏后 main 是常驻的，不该还被折叠逻辑压着
  if (!mqNarrow.matches) document.body.classList.remove('mb-detail-open');
}
mqNarrow.addEventListener('change', applyBreakpoints);
mqTiny.addEventListener('change', applyBreakpoints);
applyBreakpoints();

/* ---------------------------------------------------------------- ② 主从折叠 */

let listScroll = 0;

/** 进详情：记下列表滚动位置（返回时恢复 —— PRD P0-1"列表滚动位置在返回时保留"） */
function enterDetail() {
  if (!isNarrow()) return;
  const body = document.body;
  if (body.classList.contains('mb-detail-open')) return;
  listScroll = $('listBody')?.scrollTop ?? 0;
  body.classList.add('mb-detail-open');
}

/** 返回列表：摘掉展开态，把滚动位置还给列表 */
function leaveDetail() {
  if (!document.body.classList.contains('mb-detail-open')) return;
  document.body.classList.remove('mb-detail-open');
  requestAnimationFrame(() => {
    if ($('listBody')) $('listBody').scrollTop = listScroll;
  });
}

/*
 * 点列表行 → 下一拍进详情。走**事件委托 + rAF**：行点击的 onclick（openConversation /
 * openDetail / openSettings…）会先跑完并重画主区，rAF 之后再上状态类，避免把"点了但
 * 渲染还没画完"的中间态截下来。选择器覆盖四类行：会话 / 员工 / 群 / 设置分节（.item
 * 是左栏行的公共类，兜住工作流、看板入口这些次级行）。
 */
$('listBody').addEventListener('click', (e) => {
  if (!isNarrow()) return;
  const row = e.target.closest('[data-conv], [data-persona], [data-group], [data-set], .item');
  if (!row) return;
  // 点「＋」菜单或分组折叠标题这类不换页的行不动：折叠标题带 data-sec，排除
  if (e.target.closest('[data-sec]')) return;
  requestAnimationFrame(enterDetail);
});

/* 「← 返回」栏：单例 DOM 挂 body 上（grid 里占一行，见 mobile.css 的行模板） */
const backbar = document.createElement('div');
backbar.className = 'mb-backbar';
backbar.innerHTML = '<button type="button" class="mb-back" aria-label="返回列表">← 返回</button>';
backbar.querySelector('button').addEventListener('click', leaveDetail);
document.body.append(backbar);

// Esc 逐级后退：窄屏且详情开着时接管，别抢弹窗的 Esc（弹窗在 open 时 keydown 冒到 document，
// 这里只在"没有 dialog 开着"的情况下退）
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !isNarrow()) return;
  if (document.querySelector('dialog[open]')) return;
  if (document.body.classList.contains('mb-detail-open')) {
    e.preventDefault();
    leaveDetail();
  }
});

// 浏览器返回键（手机上的手势返回）也走同一条路：history 里推进一格，popstate 时收起
window.addEventListener('popstate', () => {
  if (isNarrow() && document.body.classList.contains('mb-detail-open')) leaveDetail();
});
$('listBody').addEventListener(
  'click',
  (e) => {
    if (!isNarrow()) return;
    const row = e.target.closest('[data-conv], [data-persona], [data-group], [data-set], .item');
    if (!row || e.target.closest('[data-sec]')) return;
    // 详情已经开着就别再压历史（2026-10-28）：连点几次行会攒出多层"返回"，
    // 手机上要按好几次手势才退得出去 —— 一次折叠只对应一格历史。
    if (document.body.classList.contains('mb-detail-open')) return;
    // 详情页压一格历史：手机手势返回 = 回列表（与 Esc / 「← 返回」同一条路）
    history.pushState({ mbDetail: true }, '');
  },
  true,
);

/* ---------------------------------------------------------------- ③ 底部导航 */

/*
 * 四 tab：工作台 / 通讯录 / 会话 / 我的 —— 映射 setNav('plugins' | 'contacts' | 'messages' | 'settings')。
 * 「通讯录」是 2026-11 移动端增量加的第 4 个 tab（手机上找人聊天，跟微信一致）：
 * 高亮同步机制不用改 —— 桌面左栏本就有 data-nav="contacts" 的导航按钮，
 * setNav('contacts') 会把它点亮，syncTabs 按 .nav-btn.active 对齐自然命中新 tab。
 * 「我的」= 设置页（设备管理在 设置 → 手机配对；P1 口径的只读视图本期不单开一页，
 * 复用整页设置，窄屏下它本来就是主从折叠里的"详情"）。
 * 高亮同步：nav 还会从面包屑/深链接进来，靠 1s 轮询对齐（改 setNav 本体违反"最小改动"，
 * 轮询只是读 S.nav 一个字段，代价为零）。
 */
const tabbar = document.createElement('nav');
tabbar.className = 'mb-tabbar';
tabbar.innerHTML = `
  <button type="button" class="mb-tab" data-tab="plugins">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3" y="3" width="7.6" height="7.6" rx="2"/><rect x="13.4" y="3" width="7.6" height="7.6" rx="2"/><rect x="3" y="13.4" width="7.6" height="7.6" rx="2"/><rect x="13.4" y="13.4" width="7.6" height="7.6" rx="2"/></svg>
    <span>工作台</span>
  </button>
  <button type="button" class="mb-tab" data-tab="contacts">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19.5c.9-3.2 3-5 5.5-5s4.6 1.8 5.5 5"/><circle cx="16.8" cy="9.4" r="2.5"/><path d="M15.7 14.9c2.4.3 4.2 1.9 4.9 4.6"/></svg>
    <span>通讯录</span>
  </button>
  <button type="button" class="mb-tab" data-tab="messages">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 5.5h16v10H9l-5 4z"/></svg>
    <span>会话</span>
  </button>
  <button type="button" class="mb-tab" data-tab="settings">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6"/></svg>
    <span>我的</span>
  </button>`;
tabbar.querySelectorAll('.mb-tab').forEach((b) => {
  b.addEventListener('click', () => {
    // 点 tab 先退出详情折叠态：换一级页是回到"一级页"
    document.body.classList.remove('mb-detail-open');
    setNav(b.dataset.tab);
    syncTabs();
  });
});
document.body.append(tabbar);

function syncTabs() {
  // 高亮以左栏 .nav-btn.active 为准（state.mjs setNav 维护的那份，含"工作流 → 工作台"映射）
  const activeNav = document.querySelector('.nav-btn.active')?.dataset.nav ?? '';
  tabbar.querySelectorAll('.mb-tab').forEach((b) => {
    const hit = activeNav === b.dataset.tab || (b.dataset.tab === 'plugins' && activeNav === 'workflows');
    b.classList.toggle('active', hit);
  });
}
setInterval(syncTabs, 1000);
syncTabs();

/* ---------------------------------------------------------------- ④ 键盘适配 */

if (window.visualViewport) {
  const vv = window.visualViewport;
  const onVv = () => {
    // 高度喂给 CSS：tiny 档的 html/body 用 --mb-vh 当高度 —— 键盘弹起时布局视口不缩，
    // 不顶这一下的话输入栏会被键盘盖住（PRD P0-1"键盘弹起不遮挡"）
    document.documentElement.style.setProperty('--mb-vh', `${Math.round(vv.height)}px`);
    // 输入框聚焦时把消息区滚到底，保证"正在说的这句"贴着键盘上方
    const el = document.activeElement;
    if (el && (el.id === 'input' || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) {
      const chat = $('chat');
      if (chat && chat.scrollHeight > chat.clientHeight) chat.scrollTop = chat.scrollHeight;
    }
  };
  vv.addEventListener('resize', onVv);
  vv.addEventListener('scroll', onVv);
  onVv();
}

/* ---------------------------------------------------------------- ⑤ 401 引导 */

/*
 * 手机形态（mb-tiny）下拦 401：E4010（无令牌/令牌失效）与 E4012（授权被撤销）都意味着
 * "这台手机的配对没了" —— 引导重新扫码，不甩裸登录页（PRD P0-3 用户已确认的口径）。
 * 拦在 fetch 上：ui.mjs 的 api() 底下就是 fetch，一处包装全站生效（含 EventSource 之外的
 * 所有口）；SSE 断流不走这条路 —— 那条是静默重连，401 时页面刷新自然会落到这里。
 */
let relpairShown = false;

function showRelpair() {
  if (relpairShown) return;
  relpairShown = true;
  const mask = document.createElement('div');
  mask.className = 'mb-relpair';
  mask.innerHTML = `
    <div class="mb-relpair-card">
      <div class="mb-relpair-logo">B</div>
      <h2>登录已失效</h2>
      <p>这台手机的配对已被移除或已过期。请在电脑上打开「设置 → 手机配对」重新生成二维码，扫码即可恢复。</p>
    </div>`;
  document.body.append(mask);
}

const origFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const r = await origFetch(...args);
  if (r.status === 401 && document.body.classList.contains('mb-tiny') && !relpairShown) {
    try {
      const body = await r.clone().json();
      if (body?.code === 'E4010' || body?.code === 'E4012') showRelpair();
    } catch { /* 非 JSON 响应（登录页 HTML）不算 —— 那是桌面浏览器的事 */ }
  }
  return r;
};

/* ---------------------------------------------------------------- ⑥ 下拉刷新 */

/*
 * 列表一级页顶部下拉 → 重拉 load()（P1-1）。只挂 #listBody：列表一级页才刷，
 * 详情/主区不劫持手势。节流 3 秒；scrollTop > 0 时不触发（正在看列表中段）。
 */
const ptrBar = document.createElement('div');
ptrBar.className = 'mb-ptr';
ptrBar.textContent = '下拉刷新';
document.body.append(ptrBar);

let ptrStartY = null;
let ptrLastAt = 0;

$('listBody').addEventListener(
  'touchstart',
  (e) => {
    const body = document.body;
    if (!isTiny() || body.classList.contains('mb-detail-open')) return;
    ptrStartY = $('listBody').scrollTop <= 0 ? e.touches[0].clientY : null;
  },
  { passive: true },
);

$('listBody').addEventListener(
  'touchmove',
  (e) => {
    if (ptrStartY === null) return;
    const dy = e.touches[0].clientY - ptrStartY;
    // 阻尼：最多拉出 60px，跟手的距离按 1/3 折算
    const pull = Math.min(60, Math.max(0, dy / 3));
    ptrBar.style.transform = `translateY(${pull}px)`;
    ptrBar.style.opacity = String(Math.min(1, pull / 40));
  },
  { passive: true },
);

$('listBody').addEventListener(
  'touchend',
  () => {
    if (ptrStartY === null) return;
    ptrStartY = null;
    const fired = ptrBar.style.opacity === '1';
    ptrBar.style.transform = '';
    ptrBar.style.opacity = '';
    if (!fired) return;
    const now = Date.now();
    if (now - ptrLastAt < 3000) return; // 节流：连拉不连刷
    ptrLastAt = now;
    load()
      .then(() => {
        ptrBar.textContent = '已刷新';
        setTimeout(() => { ptrBar.textContent = '下拉刷新'; }, 1200);
      })
      .catch(() => {}); // 刷不了静默：load 自己会把连接错误报到别处
  },
  { passive: true },
);
