/* mobile.mjs —— 响应式壳（2026-11 手机端增量）。
 *
 * 职责（设计 §2 / §5 T03+T04）：纯行为，样式全在 mobile.css。
 *   ① 断点监听：≤900px 置 body.mb-narrow、≤600px 置 body.mb-tiny（双轨：纯样式走
 *      mobile.css 的 @media，行为相关折叠走这两个状态类）；
 *   ② 主从折叠：窄屏下"左栏列表 + 右栏详情"变两级导航 —— 点列表行进详情
 *      （body.mb-detail-open），顶部「← 返回」栏回列表，滚动位置保留；
 *   ③ 底部导航（P1-1）：≤900px 四 tab「工作台 / 通讯录 / 会话 / 我的」，详情页自动隐藏；
 *   ④ 键盘适配：visualViewport 高度喂给 --mb-vh，对话页输入栏不挡；
 *   ⑤ 401 引导（PRD P0-3）：会话失效（E4010/E4012）→ **壳里交给壳**静默重签票
 *      （`BandiShell.sessionExpired`），浏览器才重载一次拿中枢登录页。
 *      本机会话只有 12 小时绝对 / 30 分钟空闲（`store/users.mjs`），而壳的中枢会话是
 *      30 天 —— 两者不同步，所以过期是常态；以前一律 reload，人就天天撞登录页。
 *      扫码/设备令牌那套 2026-11-07 已整体退场，与这里无关；
 *   ⑥ 下拉刷新（P1-1）：列表一级页顶部下拉重拉 load()，节流；
 *   ⑦ 历史栈卫生（2026-11-05）：返回键永远摸不到登录页 —— 开机截断启动页残留的
 *      forward 层；跨文档退回旧文档时自动续连，不复活旧会话。
 *
 * 骨架既有规矩的遵守：列表/详情 DOM 常驻，这里只切 body 状态类，不改任何渲染函数
 * 的输出结构；不动 #listBody 的 innerHTML；搜索/筛选照旧只重画结果块。
 */
import { load, setNav } from './state.mjs';
import { $, S } from './core.mjs';
import { closeDrawer } from './experts.mjs';

/* ---------------------------------------------------------------- ① 断点 */

const mqNarrow = window.matchMedia('(max-width: 900px)');
const mqTiny = window.matchMedia('(max-width: 600px)');

const isNarrow = () => mqNarrow.matches;
const isTiny = () => mqTiny.matches;

function applyBreakpoints() {
  document.body.classList.toggle('mb-narrow', mqNarrow.matches);
  document.body.classList.toggle('mb-tiny', mqTiny.matches);
  // 折出窄屏时把详情展开态一并清掉：回宽屏后 main 是常驻的，不该还被折叠逻辑压着
  if (!mqNarrow.matches) document.body.classList.remove('mb-detail-open', 'flow-direct-open');
}
mqNarrow.addEventListener('change', applyBreakpoints);
mqTiny.addEventListener('change', applyBreakpoints);
applyBreakpoints();

/* ---------------------------------------------------------------- ② 主从折叠 */

let listScroll = 0;

/** 从被点的列表行里取标题（会话/员工/群的行结构都是 `.who > .line1 > b`） */
function rowTitle(row) {
  return row?.querySelector('.line1 b')?.textContent?.trim() ?? '';
}

/** 进详情：记下列表滚动位置（返回时恢复 —— PRD P0-1"列表滚动位置在返回时保留"） */
function enterDetail(title) {
  if (!isNarrow()) return;
  const body = document.body;
  if (body.classList.contains('mb-detail-open')) return;
  listScroll = $('listBody')?.scrollTop ?? 0;
  // 返回栏右侧显示当前这一页是谁（2026-11 用户要求：人名放返回按钮右边）
  const t = backbar.querySelector('.mb-back-title');
  if (t) t.textContent = title || '';
  body.classList.add('mb-detail-open');
}

/**
 * 返回列表：摘掉展开态，把滚动位置还给列表。
 *
 * `alreadyPopped` = 这次收起是手势/返回键的 popstate 带来的 —— 那格历史系统已经替我们
 * 退掉了，别再 history.back() 多退一格。按钮/Esc 进来的（默认）要自己退：进详情时压的
 * 那格必须跟着收起一起回收，否则它成"幽灵格"—— 画面在列表，栈里还停在详情，用户按
 * 返回先无声吞掉一格，再按就跨文档退出工作台（见文件尾 ⑦ 历史栈卫生）。
 */
function leaveDetail(alreadyPopped) {
  // 抽屉（聊天记录 / 群设置）是 fixed 覆盖层，不归详情态的折叠管 —— 不主动关掉，
  // 退回列表后它照样盖在屏幕上，看起来"还是聊天记录"（2026-11 用户实报）。
  closeDrawer();
  /*
   * 流程实例页「从别处点进来的整页」（flowpages.mjs 打 body.flow-direct-open）：
   * 这一页的返回是**原来那一页**（看板 / 任务卡 / 会话），不是它自己左栏的「发起记录」
   * —— 收场交给 flowpages（走事件，渲染模块不反向依赖本文件）。
   * 2026-11-08 用户：「点返回还是能跳转到发起记录」——之前返回直接收折叠态，落到列表上。
   */
  if (document.body.classList.contains('flow-direct-open')) {
    document.dispatchEvent(new CustomEvent('flow-direct-leave'));
    return;
  }
  if (!document.body.classList.contains('mb-detail-open')) return;
  document.body.classList.remove('mb-detail-open');
  // 聊天页自带的返回按钮（chat.mjs 的 .mb-chat-back）随页面一起退场
  document.body.classList.remove('mb-chat');
  /*
   * 从通讯录点人开聊的（chat.mjs 的 openDirectChat 会记下来源栏）：
   * 返回要回**通讯录**，否则落在「会话」列表上 —— 用户是从通讯录进来的，
   * 退出去却看到另一个模块，等于"回来的路不对"。
   */
  const backNav = S.mbBackNav;
  if (backNav) {
    S.mbBackNav = '';
    setNav(backNav);
  }
  requestAnimationFrame(() => {
    if ($('listBody')) $('listBody').scrollTop = listScroll;
  });
  // 视觉态和栈必须一起退：当前这格就是进详情时压的那格（state 带着标记）才退。
  // 从 popstate 进来时历史已经退过（此刻 state 是上一层），守卫保证不会多退。
  if (!alreadyPopped && history.state?.mbDetail) history.back();
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
  // 真人「成员」行没有详情页（管账号去「设置 → 用户」）—— 点了不该摆出一个空详情态
  if (e.target.closest('[data-nodetail]')) return;
  // 手机通讯录的"入口行"（群聊 / 部门）和部门行是**列表内换页**，不是进详情 ——
  // 让它们走折叠的话，列表会被藏起来换成一页空的主区（2026-10-31）。
  // 设置页顶部那条「← 我的」同理（2026-11-01）：它是回上一级，不是进详情。
  if (row.matches('[data-cv], [data-cv-dept], [data-me-back]')) return;
  const title = rowTitle(row);
  requestAnimationFrame(() => enterDetail(title));
});

/* 「← 返回」栏：单例 DOM 挂 body 上（grid 里占一行，见 mobile.css 的行模板）。
 * 左边只有图标，右边是当前详情页的人名/标题（2026-11 用户要求）。 */
const backbar = document.createElement('div');
backbar.className = 'mb-backbar';
backbar.innerHTML =
  '<button type="button" class="mb-back" aria-label="返回列表">' +
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>' +
  '</button><span class="mb-back-title"></span>';
backbar.querySelector('button').addEventListener('click', leaveDetail);
document.body.append(backbar);

// 聊天页自带的返回按钮（chat.mjs 的 .mb-chat-back）派这个事件回来 —— 走事件
// 而不是 import，避免 chat.mjs 反向依赖 mobile.mjs 造成循环
document.addEventListener('mb-back', leaveDetail);

/*
 * 程序化进详情（2026-11-03）：不是点列表行进来的详情 —— 刷新后 restorePlace 直达
 * 人物详情、项目成员行点人 —— 没人打 mb-detail-open，mobile.css 会把整个 main
 * 藏掉：内容画了也看不见，用户看到的就是"详情页空白"（实报的那条）。渲染方派
 * `mb-detail` 事件把标题带过来，这里补上折叠态与历史；已经开着就只把返回栏标题
 * 对齐成当前这个人。走事件而不是 import，同理 —— 渲染模块不反向依赖本文件。
 */
document.addEventListener('mb-detail', (e) => {
  if (!isNarrow()) return;
  const title = e.detail?.title ?? '';
  if (document.body.classList.contains('mb-detail-open')) {
    const t = backbar.querySelector('.mb-back-title');
    if (t) t.textContent = title;
    return;
  }
  enterDetail(title);
  // 与列表行进详情同一条规矩：一格折叠压一格历史，手势返回才回得来。
  // reload 恢复的详情（当前格 state 里已带着 mbDetail 标记）复用那一格，不再重压 ——
  // 多压一格，返回就得多按一次空的。
  if (!history.state?.mbDetail) history.pushState({ mbDetail: true }, '');
});

// Esc 逐级后退：窄屏且详情开着时接管，别抢弹窗的 Esc（弹窗在 open 时 keydown 冒到 document，
// 这里只在"没有 dialog 开着"的情况下退）
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !isNarrow()) return;
  if (document.querySelector('dialog[open]')) return;
  // 选择页开着时 Esc 归它（chat.mjs 的监听里收的是选择页，不是详情页）
  if (document.body.classList.contains('mb-picker-open')) return;
  // 「新建任务」页（projects.mjs 的 .kb-new）也是详情页的下一级 —— 它自己那一格历史
  // 退回来时画面上还盖着它，这里当详情处理就会把底下的看板一起收掉（按一次返回掉两级）
  if (document.body.classList.contains('kb-new-open')) return;
  // 定时任务的新建/编辑页（skills.mjs 的 .sch-page）同理：它自己收自己那一格
  if (document.body.classList.contains('sch-page-open')) return;
  // 任务卡的「讨论抽屉」（projects.mjs 的 .tc-sheet）同理：它是卡页的下一级，
  // 退回来只该收它自己 —— 这里放行，由 projects.mjs 的 Esc 监听收（2026-11-05）
  if (document.body.classList.contains('tc-sheet-open')) return;
  if (document.body.classList.contains('mb-detail-open')) {
    e.preventDefault();
    // 同上：流程实例页的收场归 flowpages（回上一层，不是翻出列表）
    if (document.body.classList.contains('flow-direct-open')) {
      document.dispatchEvent(new CustomEvent('flow-direct-leave'));
      return;
    }
    leaveDetail();
  }
});

// 浏览器返回键（手机上的手势返回）也走同一条路：history 里推进一格，popstate 时收起。
// alreadyPopped=true：这格历史手势已经替我们退了，leaveDetail 只收画面不再退格。
window.addEventListener('popstate', (e) => {
  // 全屏选择页（chat.mjs 的 mbPicker）自己那一格：它自己会收，这里放行 ——
  // 否则它压的那格历史退回来时，详情页会被跟着一起收掉（按一次返回掉回列表）
  if (document.body.classList.contains('mb-picker-open')) return;
  // 同上：「新建任务」页（.kb-new）也自己收自己那一格。漏了这一行，它退回来时会被当成
  // "退到根页"，⑦c 的根页井再压一格回去 —— 用户要按两次返回才出得来看板。
  if (document.body.classList.contains('kb-new-open')) return;
  // 同上：定时任务的新建/编辑页（.sch-page）也自己收自己那一格（skills.mjs 的 popstate）
  if (document.body.classList.contains('sch-page-open')) return;
  // 同上：任务卡的讨论抽屉（.tc-sheet）也自己收自己那一格（projects.mjs 的 popstate）。
  // 漏了这行，返回键会把底下的卡页一起收掉 —— 一次返回从抽屉直接掉回看板（2026-11-05）
  if (document.body.classList.contains('tc-sheet-open')) return;
  if (isNarrow() && document.body.classList.contains('mb-detail-open')) {
    // 流程实例页（从别处点进来的整页）：收场归 flowpages —— 退回去该是看板/任务卡/会话，
    // 不是这页左栏的「发起记录」（2026-11-08 用户：「点返回还是能跳转到发起记录」）
    if (document.body.classList.contains('flow-direct-open')) return;
    leaveDetail(true);
    return;
  }
  // 详情没开却退到一格带 mbDetail 标记的 = 上一场会话 / reload 前攒下的幽灵格：
  // 标记就地清掉，免得下次 leaveDetail 把它错当成"自己压的格"又多退一格
  if (e.state?.mbDetail) {
    history.replaceState(null, '');
    return;
  }
  /*
   * ⑦c 根页井（2026-11-05 用户四报"两次返回退到扫码页"的收口）：退到底了 ——
   * 落回文档首格（state 不是我们的标记），立刻补一格标记回去。画面不动、栈不再
   * 往下走：返回键在根页就是原地不动，Android 永远收不到"退无可退"的信号，
   * App 不会被返回键退出 —— 重开自然也不会落启动页（扫码页）。
   * 退出靠 Home 手势；回连接页只剩「断开连接」和配对失效两条正路。
   * （浏览器里没有壳，不拦 —— 标签页的返回交还浏览器。）
   */
  if (inShell() && !e.state?.mbBoot) history.pushState({ mbBoot: 1 }, '');
});
$('listBody').addEventListener(
  'click',
  (e) => {
    if (!isNarrow()) return;
    const row = e.target.closest('[data-conv], [data-persona], [data-group], [data-set], .item');
    if (!row || e.target.closest('[data-sec]')) return;
    // 真人「成员」行不进详情（同上）：不该压历史，也不该让手势返回落到空详情上
    if (e.target.closest('[data-nodetail]')) return;
    // 列表内换页的行（通讯录入口 / 部门 / 设置页的「← 我的」）不压历史：
    // 它们不是"进详情"，没有可返回的上一层
    if (row.matches('[data-cv], [data-cv-dept], [data-me-back]')) return;
    // 从聊天页跳到别的详情页：先摘掉 mb-chat，聊天头那个返回按钮不该继续占着
    document.body.classList.remove('mb-chat');
    // 详情已经开着就别再压历史（2026-10-28）：连点几次行会攒出多层"返回"，
    // 手机上要按好几次手势才退得出去 —— 一次折叠只对应一格历史。
    if (document.body.classList.contains('mb-detail-open')) return;
    // 详情页压一格历史：手机手势返回 = 回列表（与 Esc / 「← 返回」同一条路）。
    // 当前格已带 mbDetail 标记（reload 恢复的场景）就复用，不重压
    if (!history.state?.mbDetail) history.pushState({ mbDetail: true }, '');
  },
  true,
);

/* ---------------------------------------------------------------- ③ 底部导航 */

/*
 * 四 tab：工作台 / 通讯录 / 会话 / 我的 —— 映射 setNav('plugins' | 'contacts' | 'messages' | 'me')。
 * 「通讯录」是 2026-11 移动端增量加的第 4 个 tab（手机上找人聊天，跟微信一致）：
 * 高亮同步机制不用改 —— 桌面左栏本就有 data-nav="contacts" 的导航按钮，
 * setNav('contacts') 会把它点亮，syncTabs 按 .nav-btn.active 对齐自然命中新 tab。
 *
 * 「我的」（2026-11-01 改）：以前这个 tab 直接 `setNav('settings')` 进设置页，
 * 手机上点"我的"看到的是一串开关，没有"我是谁"。现在进的是 openMe 的个人中心
 * （登录卡 + 设置入口），设置页成为它的下一级 —— 见 settings.mjs 的 openMe
 * 与 contacts.mjs 里那条「← 我的」返回行。
 *
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
  <!-- 「我的」= 人形轮廓（2026-11 第二版）：原来是"圆 + 八条放射线"，那是**亮度/太阳**
       的图形语言，图标下面还写着「我的」—— 第一眼会被读成"切换主题"。
       这一栏进的是账号与权限，人形才是主流 App 里这个 tab 的固定符号。 -->
  <button type="button" class="mb-tab" data-tab="me">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.6"/><path d="M4.9 20.2c.7-3.6 3.6-5.5 7.1-5.5s6.4 1.9 7.1 5.5"/></svg>
    <span>我的</span>
  </button>`;
tabbar.querySelectorAll('.mb-tab').forEach((b) => {
  b.addEventListener('click', () => {
    // 点 tab 先退出详情折叠态：换一级页是回到"一级页"。
    // 历史格要跟折叠态一起回收（2026-11-05）：只摘类不退格，那格成幽灵 ——
    // 手势返回先无声吞掉一格，再按就跨文档退出去。tab 明确换栏，不走 leaveDetail
    // 的"来源栏回跳"（S.mbBackNav），只做格子回收。
    const wasOpen = document.body.classList.contains('mb-detail-open');
    document.body.classList.remove('mb-detail-open');
    document.body.classList.remove('mb-chat');
    // 流程实例页那套「整页」标记也一起收（flowpages.mjs）：换栏就是走了，别再让返回键往看板拽
    document.body.classList.remove('flow-direct-open');
    if (wasOpen && history.state?.mbDetail) history.back();
    // 抽屉是 fixed 覆盖层，换一级页时必须一起关，否则新页面被旧抽屉盖住
    closeDrawer();
    // 手动换栏就不再是"从通讯录进来又返回"那条路了，来源标记作废
    S.mbBackNav = '';
    // 点「通讯录」= 明确要回一级页：通知通讯录把手机端的子页（部门/群聊）退掉。
    // 走事件而不是 import，避免 contacts.mjs 反向依赖本文件。
    if (b.dataset.tab === 'contacts') document.dispatchEvent(new CustomEvent('mb-cv-home'));
    setNav(b.dataset.tab);
    syncTabs();
  });
});
document.body.append(tabbar);

/*
 * 「我的」↔「设置」互跳（2026-11-01）：settings.mjs / contacts.mjs 派 `mb-nav` 事件过来，
 * 这里统一转成 setNav。
 * 为什么不让他们直接 `import { setNav } from './state.mjs'` —— state.mjs 自己 import 了
 * settings.mjs（setNav 的 settings 分支调 openSettings），反向再 import 就成环了。
 * 事件是本站既有的解环手法（通讯录的 mb-cv-home 同款）。
 */
document.addEventListener('mb-nav', (e) => {
  const nav = e.detail?.nav;
  if (!nav) return;
  // 互跳是换一级页：详情折叠态要先收掉，否则新页面被压在折叠态后面。
  // 历史格同 tab 那条规矩一起回收（见 tabbar click 的注释）
  const wasOpen = document.body.classList.contains('mb-detail-open');
  document.body.classList.remove('mb-detail-open');
  document.body.classList.remove('flow-direct-open');
  if (wasOpen && history.state?.mbDetail) history.back();
  setNav(nav);
  syncTabs();
});

function syncTabs() {
  // 高亮以左栏 .nav-btn.active 为准（state.mjs setNav 维护的那份，含"工作流 → 工作台"映射）
  const activeNav = document.querySelector('.nav-btn.active')?.dataset.nav ?? '';
  tabbar.querySelectorAll('.mb-tab').forEach((b) => {
    const hit =
      activeNav === b.dataset.tab ||
      (b.dataset.tab === 'plugins' && activeNav === 'workflows') ||
      // 设置页是「我的」的下一级（2026-11-01）：停在设置上时 tab 仍亮「我的」。
      // 不然手机上从「我的」点进设置后，底部四个 tab 一个都不亮 —— 看着像"哪儿都没选中"。
      (b.dataset.tab === 'me' && activeNav === 'settings');
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

/* ---------------------------------------------------------------- ④b 输入框自适应高度 */

/*
 * 手机输入条是一行胶囊（mobile.css §8），textarea 常态 38px = 一行。写长了必须跟着长，
 * 否则多出来的行被内部滚动条吃掉 —— 自己刚写的上一句看不见了。
 * 桌面那条 min-height: 96px 是固定三行的口径，这里只在窄屏接管，宽屏还原（''）。
 * 上限 96px 跟 CSS 的 max-height 对齐：超过就内部滚动，输入条不再往上顶消息区。
 */
const inputEl = $('input');

function autosizeInput() {
  if (!inputEl) return;
  if (!isNarrow()) { inputEl.style.height = ''; return; }
  // ⚠️ 必须量在 `height: 0` 上，不能用 `height: auto`：textarea 没有 rows 属性时
  //    auto 会回落到浏览器默认的 rows=2（量出来 58px，比一行的 38px 还高），
  //    清空内容之后输入条就再也收不回一行高。0 则是"内容多高就多高"。
  inputEl.style.height = '0px';
  inputEl.style.height = `${Math.min(96, Math.max(38, inputEl.scrollHeight))}px`;
}

if (inputEl) {
  inputEl.addEventListener('input', autosizeInput);
  // 点发送时 chat.mjs 会把 value 清空（不触发 input 事件）—— 高度得手动收回去，
  // 否则一条长消息发完，输入条还挂在 96px 上。
  $('send')?.addEventListener('click', () => setTimeout(autosizeInput, 0));
  mqNarrow.addEventListener('change', autosizeInput);
  autosizeInput();
}

/* ---------------------------------------------------------------- ⑤ 401 引导 */

/** 在原生手机壳里？（壳在 WebView 启动前就挂好了 `window.BandiShell`） */
function inShell() {
  return typeof window.BandiShell !== 'undefined';
}

/*
 * 会话过期（绝对 12 小时 / 空闲 30 分钟两道闸）时，API 回 E4010 / E4012。
 *
 * 以前这里做的是「凭 clientKey 换一张新设备令牌，换不上就弹重新扫码遮罩」——
 * 那套设备令牌 2026-11-07 整体退场了。现在的答案是**重载一次**：服务端发现没有
 * 会话，直接把中枢登录页给过来，人重新输一次手机号密码就回到工作台。
 *
 * 只重载一次（10 秒内不重复）：服务端真出毛病时不至于来回刷屏。
 */
const origFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const r = await origFetch(...args);
  if (r.status !== 401 || !document.body.classList.contains('mb-tiny')) return r;
  let body = null;
  try {
    body = await r.clone().json();
  } catch { /* 非 JSON（登录页 HTML）不算 */ }
  if (body?.code !== 'E4010' && body?.code !== 'E4012') return r;
  let last = 0;
  try {
    last = Number(sessionStorage.getItem('bandi.401reload') || 0);
  } catch { /* 隐私模式：当 0 处理 */ }
  if (Date.now() - last < 10_000) return r;
  try {
    sessionStorage.setItem('bandi.401reload', String(Date.now()));
  } catch { /* 存不了就照刷，最多多刷一次 */ }
  /*
   * **壳里绝不 reload**（2026-11-08）：reload 的唯一结果是服务端把中枢登录页给过来
   * （没有会话 → 登录页），人就被丢进手机号输入框 —— 而壳手里握着 30 天的中枢会话，
   * 随时能重签一张本机票（/hub/enter）。浏览器没有这个能力，才轮到人重新登录。
   */
  if (inShell() && typeof window.BandiShell.sessionExpired === 'function') {
    window.BandiShell.sessionExpired();
    return r;
  }
  location.reload();
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

/* ---------------------------------------------------------------- ⑦ 历史栈卫生 */

/*
 * 2026-11-05 用户三报「点返回直接退到登录页」的根治。病灶是壳的 WebView 历史栈里
 * 残着连接页（=登录页）的条目，工作台按返回会跨文档撞回去。前两次修复各堵了一个口，
 * 但都没堵全：
 *   · 11-01（壳 lib.rs）：navigate → location.replace —— 只保证连接页的**首条**被顶掉；
 *   · 11-03（启动页 launcher.js squashHistory）：history.go(-depth) 退到底再 replace ——
 *     但 go() 只是把启动页自己压的那几层"退到底"，栈里并没删，它们变成 **forward 残留**
 *     （方向朝前）留在栈里，而 replace 只顶当前条目。连接成功后的栈 =
 *     [工作台(当前), 启动页视图层(forward 残留)] —— 开详情之前的任何一次返回，一步就
 *     跨文档撞进残层 = 登录页；
 *   · 本文件（旧 leaveDetail）：按钮关详情只摘 CSS 类不退历史格 —— "幽灵格"让手势返回
 *     先无声吞一格，再按就出文档，同样撞进残层。
 *
 * 三道闸（⑦a/⑦b/⑦c + 上文 leaveDetail 的格子回收）合起来：返回键在详情关详情、
 * 在根页原地不动（⑦c 的井），永远不再落登录页、也不会把 App 退出去重开见启动页。
 * 回登录页只剩「断开连接」和配对失效两条正路。
 */

/**
 * ⑦a 跨文档退回了班底自己的旧文档 —— 原地重载。
 *
 * 以前是 `location.replace('/pair?resume=1')` 去换一张新设备令牌；配对页已随
 * 设备令牌体系退场，这里只重载当前文档：会话还在就照常渲染，没了就落登录页。
 */
function bounceBackArrival() {
  if (!inShell()) return;
  location.reload();
}

const navType =
  performance.getEntriesByType?.('navigation')?.[0]?.type ?? 'navigate';
// 手势返回撞进栈里残留的旧工作台条目时，旧文档会重新起一遍：navigation type 是
// back_forward。bfcache 复活（pageshow.persisted）同理 —— 都不是正常进场，续连接管。
let backBounced = false;
if (navType === 'back_forward') {
  backBounced = true;
  bounceBackArrival();
}
window.addEventListener('pageshow', (e) => {
  if (e.persisted) bounceBackArrival();
});

/*
 * ⑦b 根页预留格：开机（壳里）压一格我们自己的标记 —— pushState 按规范会截掉当前
 * 条目之后的整个 forward 栈，启动页残留的视图层连人带格消失。
 *
 * 这格同时也是 ⑦c 依赖的"井底水囊"：它在，手势返回就永远有得退（WebView 的
 * canGoBack 恒真），Android 永远收不到"退无可退"的信号 —— App 不会被返回键退出，
 * 重开更不会落启动页。reload 后当前格已经是自己的标记/详情格就免压（历史原样保留）。
 */
if (
  inShell() &&
  !backBounced &&
  history.state?.mbBoot !== 1 &&
  !history.state?.mbDetail
) {
  history.pushState({ mbBoot: 1 }, '');
}

/* ---------------------------------------------------------------- ⑧ 长按出菜单（会话行） */

/*
 * 手机上右键不存在，但「不显示 / 删除会话」的菜单（#ctxMenu）是必需的 ——
 * 不新写一份菜单，只把长按**合成为一次 contextmenu**，交给 app.mjs boot 区那条委托
 * （它按 e.target.closest('[data-conv]') 找人、按 clientX/Y 定位）。菜单长什么样
 * 由 mobile.css §16.12 改造成贴底 action sheet，这里一句样式都不碰。
 *
 * 为什么要吞掉随后的 click：长按松手一样会派 click，不拦就直接进会话，菜单白弹。
 * 拦截放 capture 阶段并且只拦一次 —— 否则下一次正常点击也会被吃掉。
 */
if ($('listBody')) {
  const LONG = 500;     // 触发时长：微信/Telegram 都是 0.5s 左右，更短容易和滚动打架
  const SLOP = 10;      // 手指抖动容忍：超过 10px 就认定用户在滚列表，取消长按
  let timer = 0;
  let startX = 0;
  let startY = 0;
  let row = null;
  let fired = false;    // 这一轮触摸已经出过菜单 → 吞掉紧跟着的 click

  const cancel = () => {
    clearTimeout(timer);
    timer = 0;
    row = null;
  };

  $('listBody').addEventListener('touchstart', (e) => {
    if (!isNarrow() || e.touches.length !== 1) return;
    const t = e.target.closest?.('[data-conv]');
    if (!t) return;
    row = t;
    fired = false;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = 0;
      const r = row;
      if (!r || !r.isConnected) return;
      fired = true;
      // 振动是锦上添花：WebView 里可能没有，没有就算了
      try { navigator.vibrate?.(10); } catch { /* 不支持 */ }
      r.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: startX,
        clientY: startY,
      }));
    }, LONG);
  }, { passive: true });

  $('listBody').addEventListener('touchmove', (e) => {
    if (!timer) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - startX) > SLOP || Math.abs(t.clientY - startY) > SLOP) cancel();
  }, { passive: true });

  $('listBody').addEventListener('touchcancel', cancel, { passive: true });

  /*
   * touchend 只清定时器、不取消 fired：菜单已经弹出来的那种情况，click 随后就到。
   * 顺序上 touchend 先于 click，所以这里不能把 fired 归零。
   */
  $('listBody').addEventListener('touchend', () => { clearTimeout(timer); timer = 0; }, { passive: true });

  $('listBody').addEventListener('click', (e) => {
    if (!fired) return;
    fired = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);
}
