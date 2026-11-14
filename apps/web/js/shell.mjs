/* shell.mjs —— 主题、记住"上次停在哪"、路由。
 * 2026-10-22 由 app.js（15537 行单文件）拆出，原生 ESM、无打包器；逻辑逐字搬运。 */
import { setNav } from './state.mjs';
import { openSettings } from './settings.mjs';
import { openWorkflows } from './workflows.mjs';
import { openProjectDetail, openProjectsPage, openTaskBoard, openTaskCardPage } from './projects.mjs';
import { openDesigner, openFlowRun } from './flowpages.mjs';
import { openSchedules, openSkill, openCodeRepoPage } from './skills.mjs';
import { openConversation, openDetail } from './chat.mjs';
import { openGroupDetail } from './groups.mjs';
import { openExperts, openPlugins, openRemotePage, renderPluginPanel } from './experts.mjs';
import { openInbox } from './inbox.mjs';
import { S } from './core.mjs';



/* ---------------------------------------------------------------- 主题 */

export const THEME_KEY = 'bandi.theme';


/**
 * 通讯录分段的折叠状态（跟主题一样记住）。
 * 默认：**群聊收起、数字员工展开** —— 日常主要是找人说话，群是少数。
 * 键名带 v2：改默认值时要让新默认生效一次，否则老浏览器里存着的旧状态会盖住它。
 */
export const SEC_KEY = 'bandi.contactsCollapsed.v2';


export const SEC_DEFAULT = { group: true, person: false };


export function readCollapsed() {
  try {
    const saved = JSON.parse(localStorage.getItem(SEC_KEY) || 'null');
    if (saved && typeof saved === 'object') return saved;
  } catch { /* 读不了就用默认 */ }
  return { ...SEC_DEFAULT };
}


export function saveCollapsed() {
  try { localStorage.setItem(SEC_KEY, JSON.stringify(S.secCollapsed ?? {})); } catch { /* 写不了就算了 */ }
}


export const prefersLight = () => window.matchMedia('(prefers-color-scheme: light)').matches;



/* ------------------------------------------------------ 记住"上次停在哪" */

/**
 * 刷新后回到原来的位置。
 *
 * 原来启动时写死 `setNav('messages')` —— 在哪个页面按 F5 都会被弹回消息页，
 * 在插件里改一半配置、刷新一下就找不着了。
 * 存的是**能重建位置的标识**（会话 id、技能名、插件 id + 选中行），不是 DOM 快照。
 */
export const PLACE_KEY = 'bandi.place';



/**
 * 记下"我在哪儿"。
 *
 * **只存一个 route**（2026-10-17 统一路由）：以前是逐字段手写（nav / conversation / skill / plugin /
 * project / taskBoard / taskCard / designer / flowMode / flowRun…），每加一个页面都要回来加一行，
 * 忘了就刷新掉回消息页。现在只有一份 —— 加页面不用再动这个函数。
 *
 * 跟页面无关的界面状态（看板筛选）另存：它不是"位置"，但刷新后也该保持。
 */
export function savePlace() {
  try {
    localStorage.setItem(
      PLACE_KEY,
      JSON.stringify({
        version: 2,
        route: S.route ?? { view: S.nav },
        kbStatuses: S.kbFilter?.statuses ?? [],
        // 负责人 / 项目（2026-10-18）/ 来源（2026-10-28）：同样记着，刷新回来还是筛着的
        kbAssignees: S.kbFilter?.assignees ?? [],
        kbProjects: S.kbFilter?.projects ?? [],
        kbSources: S.kbFilter?.sources ?? [],
        // 「列设置」藏掉的列（2026-10-28）：也是刷新后该保持的界面状态
        kbHiddenCols: S.kbHiddenCols ?? [],
        // 「只看我的 / 全量」（2026-11-11）：默认只看我派的卡；切到全量也记着
        kbMine: S.kbMine !== false,
      }),
    );
  } catch { /* 隐私模式下写不了就算了，不影响用 */ }
}



export function readPlace() {
  try {
    const p = JSON.parse(localStorage.getItem(PLACE_KEY) || 'null');
    return p && typeof p === 'object' ? p : null;
  } catch {
    return null;
  }
}



/* ---------------------------------------------------------------- 路由 */
/**
 * **所有页面的唯一注册表**：view 名字 → 打开它的函数（参数从 route 里取）。
 *
 * 新加一个页面：① 写一个 openXxx(params) ② 在它开头调 setRoute(view, params)
 * ③ 在这里加一行。savePlace / restorePlace 都不用动 —— 这就是这次重构要解决的问题。
 *
 * 注意：具体页面（会话/项目/任务卡…）先 `setNav(..., { skipOpen: true })` 把一级栏摆好，
 * 再调入口函数；不 skipOpen 的话 setNav 会先把默认页画一遍，两边抢着渲染。
 */
export const ROUTES = {
  messages: () => setNav('messages'),
  contacts: () => setNav('contacts'),
  // 信箱（2026-11-11）：一级栏，左栏列表 + 右区详情；`id` 是刷新前选中的那条通知
  inbox: ({ id } = {}) => {
    setNav('inbox', { skipOpen: true });
    return openInbox(id);
  },
  me: () => setNav('me'),
  settings: ({ section } = {}) => {
    // 定时任务已搬去工作台（2026-10-17）：存着的旧位置（settings/schedules）还认，
    // 但直接转过去 —— 设置里已经没这一节了，留着会画出个空白页。
    if (section === 'schedules') return openRoute({ view: 'schedules' });
    /* 代码托管 / 远程连接已搬成工作台研发区的整页（2026-10-26 二改）：老位置直接转发，
       不然会先画一遍设置页再跳（左栏清单闪一下）。 */
    if (section === 'remote') return openRoute({ view: 'remote' });
    if (section === 'code') return openRoute({ view: 'codeRepos' });
    S.settingsSection = section || 'prefs';
    return setNav('settings');
  },
  skill: ({ name } = {}) => {
    S.settingsSection = 'skills';
    setNav('settings', { skipOpen: true });
    return openSkill(name);
  },
  conversation: ({ id }) => {
    setNav('messages', { skipOpen: true });
    return openConversation(id);
  },
  persona: ({ id }) => {
    setNav('contacts', { skipOpen: true });
    return openDetail(id);
  },
  group: ({ id }) => {
    setNav('contacts', { skipOpen: true });
    return openGroupDetail(id);
  },
  // 专家库：一级栏整页（分区卡片墙）
  experts: () => {
    setNav('experts', { skipOpen: true });
    return openExperts();
  },
  // 组织架构（2026-11-11 Phase 3）：一级栏 + 左栏子菜单；右区是岗位权限清单（只读）
  org: ({ section } = {}) => {
    if (section) S.orgSection = section;
    return setNav('org');
  },
  workflows: ({ template } = {}) => {
    setNav('workflows', { skipOpen: true });
    return openWorkflows(template ?? null);
  },
  designer: ({ template } = {}) => {
    setNav('workflows', { skipOpen: true });
    return openDesigner(template ?? null);
  },
  flowRun: ({ template, run } = {}) => {
    setNav('workflows', { skipOpen: true });
    return openFlowRun(template, run);
  },
  plugins: () => {
    setNav('plugins', { skipOpen: true });
    return openPlugins();
  },
  /* 「工作台 → 研发」下的两页（2026-10-26 二改）：它们原来是设置的两个分节，借设置页当宿主，
     点进去整页切到「设置」——左栏一列设置分节、当前页没有对应项，用户看着像点错了。
     现在跟项目/看板一样是工作台子页（左栏收起、页头面包屑「工作台 › X」）。 */
  remote: () => {
    setNav('plugins', { skipOpen: true });
    return openRemotePage();
  },
  codeRepos: () => {
    setNav('plugins', { skipOpen: true });
    return openCodeRepoPage();
  },
  plugin: ({ id, row } = {}) => {
    setNav('plugins', { skipOpen: true });
    S.plugin = id ?? null;
    S.pluginRow = row ?? null;
    return renderPluginPanel();
  },
  projects: () => {
    setNav('plugins', { skipOpen: true });
    return openProjectsPage();
  },
  project: ({ id } = {}) => {
    setNav('plugins', { skipOpen: true });
    return openProjectDetail(id);
  },
  taskBoard: () => {
    setNav('plugins', { skipOpen: true });
    return openTaskBoard();
  },
  taskCard: ({ id, fromAll, fromFlow } = {}) => {
    setNav('plugins', { skipOpen: true });
    // fromFlow：这张卡是从流程的某一步点进来的（`{ runId, taskId, runTitle, nodeName }`）。
    // 只用来在页头写清"你从哪来" —— 卡本身不因为来路不同而长得不一样（见 openTaskCardPage）。
    // 从会话卡票 / 流程步骤点开的是弹窗，不进这条路由（2026-10-26）。
    return openTaskCardPage(id, { fromAll, fromFlow });
  },
  // 定时任务：工作台里的一页（2026-10-17 从设置搬过来）
  schedules: () => {
    setNav('plugins', { skipOpen: true });
    return openSchedules();
  },
  // 协作中心 2026-11-07 随协作子系统整体退场；存过的旧位置 {view:'collab'}
  // 走 openRoute 的"不认识就回消息页"兜底，不用迁移。
};



/**
 * 打开"某个位置"。**整站唯一的分发点**。
 *
 * 恢复位置、以后可能的链接直达，都走它 —— 别在各处再写"如果 nav 是 X 就开 Y"的分支。
 */
export function openRoute(route) {
  const r = route && typeof route === 'object' && typeof route.view === 'string' ? route : { view: 'messages' };
  const open = ROUTES[r.view];
  if (!open) {
    setNav('messages');
    return Promise.resolve();
  }
  return Promise.resolve(open(r));
}



/**
 * 记下"现在在看哪个具体页面"：入口函数在摆好界面之后调一次。
 * setNav 也会顺手清掉它、并用 {view: nav} 兜底（见 savePlace）—— 所以最终存下来的永远是最具体的那个。
 */
export function setRoute(view, params = {}) {
  // 页面级组件（比如任务卡的评论输入框）挂在 document 上的监听，在这时候摘：
  // 页面随时重建，不摘就会一层层堆起来。没有登记的就什么都不做。
  for (const fn of window.__pageCleanups ?? []) { try { fn(); } catch { /* 摘不掉也不影响渲染 */ } }
  window.__pageCleanups = [];
  S.route = { view, ...params };
  savePlace();
}



/** 启动时回到上次的位置。**回不去就退回消息页**——
 * 会话可能被移除、技能被删、插件被卸，存着的位置不一定还在。 */
export async function restorePlace() {
  const p = readPlace();
  // 跟页面无关的界面状态先还原（看板筛选）
  if (Array.isArray(p?.kbStatuses)) S.kbFilter.statuses = p.kbStatuses.filter((x) => typeof x === 'string');
  if (Array.isArray(p?.kbAssignees)) S.kbFilter.assignees = p.kbAssignees.filter((x) => typeof x === 'string');
  if (Array.isArray(p?.kbProjects)) S.kbFilter.projects = p.kbProjects.filter((x) => typeof x === 'string');
  if (Array.isArray(p?.kbSources)) S.kbFilter.sources = p.kbSources.filter((x) => typeof x === 'string');
  if (Array.isArray(p?.kbHiddenCols)) S.kbHiddenCols = p.kbHiddenCols.filter((x) => typeof x === 'string');
  // 「只看我的 / 全量」：没存过（老位置记录）就按默认「只看我的」
  if (typeof p?.kbMine === 'boolean') S.kbMine = p.kbMine;
  const route = p?.route && typeof p.route.view === 'string' ? p.route : null;
  if (!route) return setNav('messages');
  try {
    await openRoute(route);
  } catch {
    // 位置重建失败就算了，停在消息页也挺好
    setNav('messages');
  }
}



/**
 * 把 'system' 解析成实际的 light/dark，写到 <html data-theme>；CSS 只认这个属性。
 *
 * 同一时刻还要**通知原生窗口**（2026-10-20 用户报「深色模式顶栏没变化」）：
 * 标题栏是 Rust 那边画的，网页改 data-theme 它听不见 —— 它只认 `setTheme`。
 * 「跟随系统」传 null（原生窗口自己跟系统走），手动档传实际的 light/dark。
 * 只在桌面壳里跑：__TAURI__ 是 withGlobalTauri 注入的，浏览器里没有（capabilities
 * 里给 127.0.0.1:18787 开了 core:window:allow-set-theme + remote urls，见 desktop）。
 */
export function applyTheme() {
  const resolved = S.theme === 'system' ? (prefersLight() ? 'light' : 'dark') : S.theme;
  document.documentElement.dataset.theme = resolved;
  try {
    const win = window.__TAURI__?.window?.getCurrentWindow?.();
    win?.setTheme?.(S.theme === 'system' ? null : resolved);
  } catch { /* 浏览器里没有 __TAURI__；壳被旧版 exe 带着跑时 IPC 可能没开 —— 都不影响网页本身 */ }
  syncShellBar();
}

/**
 * 把「底部那条栏的颜色」报给 Android 壳（2026-11-11 用户："底部导航栏跟系统导航栏
 * 改成一个颜色"）。
 *
 * 为什么会差一色：Android 15+ 强制 edge-to-edge，WebView 被壳的 padding 抬到系统
 * 导航栏之上，屏幕最底下那条带（导航键区）是**窗口背景**在画 —— 网页管不到，
 * 它只会是主题的纯白/纯黑。而 tab 栏原来是 72% 玻璃，压在页面上合成出 #F5F5F9，
 * 一灰一白，永远一道缝。
 *
 * 口径：颜色只有一份来源 —— CSS 的 `--mb-chrome`（浅 #F2F2F7 / 深 #1C1C1E）。
 * tab 栏用它，这里把同一个值报给壳去画那条带。
 *
 * 只在**有 tab 栏的页面**报 --mb-chrome（工作台/通讯录/会话列表/我的）：进详情、聊天页
 * 时 tab 栏撤了，页面自己铺到底，这时改报页面自己的底色（见 pageBottomColor）——
 * 浅色详情是白、聊天是黑，那条带跟着页面走；实在读不到实色才报空串，让壳收起色块。
 *
 * 桌面 / PWA / 旧 Tauri 壳上没有 BandiShell，函数检测式跳过，行为一个字节不变。
 */
let lastShellBar;   // 上一次报出去的值（'' = 收起）；没变就不重复跨进程调用
let lastShellTop;   // 顶栏那条带（状态栏）上一次报出去的值

/** `rgb()/rgba()` → `#rrggbb`；半透明 / 别的色系一律返回空串（壳只能画实色） */
function toHex(css) {
  const m = /^rgba?\(([^)]+)\)$/.exec(css || '');
  if (!m) return '';
  const p = m[1].split(',').map((s) => parseFloat(s));
  if (p.length > 3 && p[3] < 1) return '';   // 半透明合成不了，别硬报
  return '#' + p.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

/**
 * 页面自己的底色 —— 没有 tab 栏的页面（详情 / 聊天 / 看板）报这一档。
 *
 * 2026-11-12 补：原来"没有 tab 栏就报空串"让壳收起色块、露出**窗口背景**
 * （@color/bandi_page 那一档浅灰）。浅色页面上没问题，可聊天页是纯黑底 ——
 * 页面铺到最底下，屏幕最底那 40dp 却露一条浅灰，等于给聊天页镶了个白边。
 * 现在读 body（再退到 html）的实际底色报过去，页面铺到哪儿、那条带就跟到哪儿。
 * 读不到实色（透明 / 半透明 / 渐变）时仍然报空串，交给壳的窗口背景兜底。
 */
function pageBottomColor() {
  return toHex(getComputedStyle(document.body).backgroundColor)
    || toHex(getComputedStyle(document.documentElement).backgroundColor);
}

/**
 * 页面最上面那条栏的颜色 —— 报给壳去画**状态栏**那条带（2026-11-12 用户截图
 * "这两个统一一下颜色"：状态栏一行是浅灰、紧挨着的「工作台」标题栏是白的）。
 *
 * 跟底部一个病根：WebView 被壳的 top padding 压到状态栏下面，那条带露的是窗口背景
 * （= 页面底色 #F7F8F9），网页的顶栏画不到它。v241 把七条顶部栏统一成 --mb-chrome
 * 之后，页面里是白的、带是灰的，反而更明显。
 *
 * 口径：**谁挨着那条带就报谁** —— 在已知顶栏里挑第一个贴在视口顶上的（top≈0）。
 * 都不在（登录页 / 空态 / 顶栏本身透明）就用 --mb-chrome 兜底，与 v241 同一个来源。
 */
const TOP_BAR_SEL = '.list-head, .mb-backbar, .mb-picker-bar, .kb-new-bar, .tc-m-head, .detail-head, .me-set-nav';

function topBarColor() {
  /*
   * 首选"视口顶端那 1px 是谁"：直接问 elementFromPoint，再往上找第一个**不透明**的底色。
   * 比枚举选择器准 —— 同一个 .mb-backbar 在 DOM 里可能有好几份（详情层、聊天层各一个，
   * 只有一个在顶上），按选择器取到的是第一个，深色聊天页就报过 #1C1C1E 而头顶其实是纯黑。
   * WebView 的视口从状态栏下面开始（壳给了 top padding），所以 y=1 就是页面第一行像素。
   */
  for (const x of [innerWidth / 2, 8, innerWidth - 8]) {
    let el = document.elementFromPoint(x, 1);
    while (el && el !== document.documentElement) {
      const c = toHex(getComputedStyle(el).backgroundColor);
      if (c) return c;
      el = el.parentElement;
    }
  }
  // 兜底：已知顶栏里挑第一个贴在视口顶上的（顶栏透明 / 背景下在父层的情况）
  for (const el of document.querySelectorAll(TOP_BAR_SEL)) {
    const r = el.getBoundingClientRect();
    if (r.height < 8 || r.top > 4 || r.bottom < 8) continue;   // 没贴在顶上的不算
    const c = toHex(getComputedStyle(el).backgroundColor);
    if (c) return c;
  }
  return getComputedStyle(document.documentElement).getPropertyValue('--mb-chrome').trim();
}

function syncShellBar() {
  const shell = window.BandiShell;
  if (!shell) return;
  if (shell.setTopBarColor) {
    const top = topBarColor();
    if (top && top !== lastShellTop) {
      lastShellTop = top;
      try { shell.setTopBarColor(top); } catch { /* 浏览器里没有这个接口 */ }
    }
  }
  if (!shell.setSystemBarColor) return;
  const bar = document.querySelector('.mb-tabbar');
  const shown = !!bar && getComputedStyle(bar).display !== 'none';
  const css = shown
    ? getComputedStyle(document.documentElement).getPropertyValue('--mb-chrome').trim()
    : pageBottomColor();
  if (css === lastShellBar) return;
  lastShellBar = css;
  try { shell.setSystemBarColor(css); } catch { /* 浏览器里没有这个接口 */ }
}

/*
 * 页面切来切去（mb-detail-open 的加减）会换掉底部那条是谁 —— 盯着 body 的 class
 * 重报一次，别指望每条路由都记得调 syncShellBar。读一次 computedStyle 很便宜，
 * 再用一个微任务合帧，连续几次 class 变更只算一次。
 */
let shellBarQueued = false;
function queueSyncShellBar() {
  if (shellBarQueued) return;
  shellBarQueued = true;
  queueMicrotask(() => { shellBarQueued = false; syncShellBar(); });
}
if (typeof MutationObserver !== 'undefined' && document.body) {
  new MutationObserver(queueSyncShellBar)
    .observe(document.body, { attributes: true, attributeFilter: ['class'] });
}

/*
 * 首次上报要等页面**画完**（2026-11-12 真机踩到）：
 * applyTheme 在 boot 早期就调 syncShellBar，那一刻「我的」页的 .list-head 还没套上样式，
 * elementFromPoint 落到 #settingsView 上，报到的是页面底色 #F2F2F7 —— 而画完其实是白栏。
 * 之后只要 body class 不变就没有第二次机会，状态栏那条带就一直灰着。
 * 所以在 load、以及 0.6s / 1.6s 各补一次（异步渲染、字体回流都在这之后）。
 * 缓存变量先清空，否则会被"颜色没变"短路掉。
 */
function kickShellBar() {
  lastShellTop = undefined;
  lastShellBar = undefined;
  syncShellBar();
}
if (typeof window !== 'undefined') {
  window.addEventListener('load', kickShellBar, { once: true });
  setTimeout(kickShellBar, 600);
  setTimeout(kickShellBar, 1600);
}



/**
 * 换主题。
 *
 * `keepPage`（2026-11-05 加的）：设置 › 偏好里的分段控件点完要重绘那一页（选中态），
 * 但**手机上「我的」页也放了一组外观选项** —— 那边点完必须留在「我的」，
 * 重绘会把页面翻到设置页（手机根本没有设置页入口）。所以把"重绘去哪儿"
 * 交给调用方决定，本函数只负责存值 + 应用到文档。
 */
export function setTheme(theme, { keepPage = false } = {}) {
  S.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* 隐私模式下写不了就算了 */ }
  applyTheme();
  if (!keepPage) openSettings('prefs');
}



export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));



/**
 * 轻量 markdown 渲染（2026-10-21，员工详情「职责与身份设定」预览用，站内可复用）。
 *
 * 防注入口径：**先对原文整体 esc 再解析标记** —— 生成的所有标签都是自己拼的，
 * 原文里夹带的 <script> 之类已变成字面量，不存在绕路的口子。
 * 支持子集：围栏代码块、行内代码、标题（#~####）、无序/有序列表（含**松散列表**：项间空行
 * 仍接着编号；含**缩进续行**：列表项第二行顶格缩进，归上一项）、引用、加粗、斜体、
 * **GFM 表格**（2026-10-23：员工回活爱用表格汇报，不渲染就是一屏竖线）。
 * 不认识的东西原样显示：不报错、不吞字（写人设/职责说明够用，不求全）。
 */
export const mdRender = (src) => {
  const lines = esc(src).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let para = [], list = null, quote = null, code = null;
  const flushPara = () => { if (para.length) { out.push('<p>' + para.join('<br>') + '</p>'); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>` + list.items.map((i) => `<li>${i}</li>`).join('') + `</${list.tag}>`); list = null; } };
  const flushQuote = () => { if (quote) { out.push('<blockquote>' + quote.map((q) => `<p>${q}</p>`).join('') + '</blockquote>'); quote = null; } };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };
  const inline = (t) => t
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  // 表格行：内容里 \| 是转义的竖线（GFM），拆单元格前先换成占位符，拆完换回来
  const splitRow = (l) => l
    .replace(/\\\|/g, '\u0001')
    .replace(/^\|/, '').replace(/\|$/, '')
    .split('|')
    .map((c) => inline(c.trim().replace(/\u0001/g, '|')));
  const isRow = (l) => /^\|.*\|$/.test(l);
  const isSep = (l) => /^\|[\s:|-]+\|$/.test(l) && l.includes('-');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (code !== null) {                       // 围栏内：原样收（已 esc 过），直到闭合
      if (/^```/.test(raw.trim())) { out.push(`<pre><code>${code.join('\n')}</code></pre>`); code = null; }
      else code.push(raw);
      continue;
    }
    const line = raw.trim();
    // 表格（2026-10-23）：当前行是 |…| 且下一行是 |---|---| 分隔行 → 整表收进来。
    // 判定带 lookahead（要看下一行），所以放在最前面；收完把 i 拨到表尾。
    if (isRow(line) && i + 1 < lines.length && isSep(lines[i + 1].trim())) {
      flushAll();
      const ths = splitRow(line);
      i += 2; // 跳过表头行与分隔行
      const rows = [];
      while (i < lines.length && isRow(lines[i].trim())) { rows.push(splitRow(lines[i].trim())); i++; }
      i -= 1; // 外层 for 还会 ++，回退一条
      out.push('<table class="md-t"><thead><tr>' + ths.map((c) => `<th>${c}</th>`).join('') + '</tr></thead><tbody>'
        + rows.map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }
    const mUl = line.match(/^[-*]\s+(.+)$/);
    const mOl = line.match(/^\d+[.、]\s+(.+)$/);
    const mH = line.match(/^(#{1,4})\s+(.+)$/);
    const mQ = line.match(/^&gt;\s?(.*)$/);   // 行首 ">" 已被 esc 成 &gt;，引用判定跟着用转义后的形态
    if (/^```/.test(line)) { flushAll(); code = []; }
    else if (mH) { flushAll(); out.push(`<h${mH[1].length}>${inline(mH[2])}</h${mH[1].length}>`); }
    else if (mUl || mOl) {
      flushPara(); flushQuote();
      const tag = mUl ? 'ul' : 'ol';
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push(inline((mUl || mOl)[1]));
    }
    else if (mQ) { flushPara(); flushList(); quote ??= []; quote.push(inline(mQ[1])); }
    /*
     * 空行（2026-10-22 改）：**只断段落和引用，不断列表** —— 松散列表（项与项之间空一行，
     * 喜儿的出厂人设就是这么写的）要接着编号，不然 1/2/3 会被切成三个各自从 1 开始的 <ol>。
     */
    else if (!line) { flushPara(); flushQuote(); }
    /*
     * 缩进续行（2026-10-22）：列表项的第二行顶两格写（`   看出问题就直说…`），
     * 属于**上一项的内容**，不是新段落 —— 以前会先 flushList 把它甩成孤零零一段，
     * 顺带把列表切断，编号跟着乱。现在并回上一项，换行用 <br> 保留作者的分行。
     */
    else if (list && /^[ \t]/.test(raw)) {
      list.items[list.items.length - 1] += '<br>' + inline(line);
    }
    else { flushList(); flushQuote(); para.push(inline(line)); }
  }
  if (code !== null) out.push(`<pre><code>${code.join('\n')}</code></pre>`);  // 没闭合的围栏也照画
  flushAll();
  // 松散列表：列表项之间隔了空行的，同类型相邻列表合并回一个（不然 1/2/3 会变成三个"1."）
  return out.join('').replace(/<\/(ol|ul)><\1>/g, '');
};



/**
 * 应用内轻提示，**替代 `alert`**（2026-10-18 用户要求：不要浏览器自带弹窗）。
 *
 * 为什么不是"再造一个遮罩对话框"：`alert` 被用了一百多处，绝大多数是
 * "这一步没成，原因是什么" —— 它**不打断人**才合适。真正需要人点头的
 * 是/否，用 `askConfirm`（原生 `<dialog>`，那里必须打断）。
 *
 * 行为：
 *   · 右下角堆叠，3.5 秒自己走（错误 5 秒，因为要读的字多）；鼠标悬停暂停计时；
 *   · 点一下就关；最多同时 4 条，多的从最旧的挤掉；
 *   · 文本按 `textContent` 塞 —— 里面会有路径、用户起的名，不能当 HTML。
 *
 * `kind`：'error'（红）/ 'ok'（绿）/ 默认中性。错误会同时写一条控制台。
 */
export const TOAST_KEEP = { error: 5000, ok: 2600, info: 3500 };


export function toast(msg, kind = 'info') {
  const text = String(msg ?? '').trim();
  if (!text) return;
  if (kind === 'error') console.error(text);

  let wrap = document.getElementById('toastWrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'toastWrap';
    wrap.className = 'toast-wrap';
    document.body.appendChild(wrap);
    /*
     * 送进**顶层**（popover API，2026-11-03 实机踩坑）：开着的 `<dialog>` 在浏览器
     * 顶层里渲染，普通层的元素 z-index 再高也被它连 backdrop 一起盖住 ——
     * 弹窗里的校验失败、接口报错全都被吞掉，手机上表现成"点了没反应"
     * （建卡 403 就是这么藏了一整天的）。popover="manual" 把 toast 也送进顶层，
     * 后显示的盖先显示的，正好压过 dialog。不支持 popover 的老浏览器回落
     * 原行为（弹窗外看得见、弹窗内看不见）。
     */
    if ('popover' in wrap) {
      try {
        wrap.popover = 'manual';
        wrap.showPopover();
      } catch { /* 已显示 / 不支持 —— 回落普通层 */ }
    }
  }
  // 多于 4 条：先把最旧的赶走（连着失败十次不该糊一屏）
  while (wrap.children.length >= 4) wrap.firstElementChild?.remove();

  /*
   * 同文案去重（2026-11-03 实报：连点「复制地址」，顶层里竖着堆出一列“已复制地址”）。
   * 最新一条**文案相同**（复制成功/网络重试这类高频动作很容易连点）→ 不再加新的，
   * 把旧的那条重播一次出现动画、计时清零 —— 用户得到“刚发生”的反馈，屏幕不糊。
   * kind 一起比：同文案不同级别（info→error）算不同消息，照常加新条。
   */
  const lastEl = wrap.lastElementChild;
  if (
    lastEl &&
    lastEl.querySelector('.toast-text')?.textContent === text &&
    lastEl.classList.contains(kind) &&
    typeof lastEl._refresh === 'function'
  ) {
    lastEl._refresh();
    return;
  }

  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const body = document.createElement('div');
  body.className = 'toast-text';
  body.textContent = text;
  el.appendChild(body);
  wrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));

  let left = TOAST_KEEP[kind] ?? TOAST_KEEP.info;
  let started = Date.now();
  let timer = null;
  const go = () => {
    el.classList.remove('in');
    setTimeout(() => el.remove(), 180);
  };
  const start = () => { started = Date.now(); timer = setTimeout(go, left); };
  const stop = () => { clearTimeout(timer); left -= Date.now() - started; };
  el.onclick = go;
  // 悬停暂停：人多半是在读那句错误，别读一半自己没了
  el.onmouseenter = stop;
  el.onmouseleave = () => { if (left > 400) start(); };
  // 同文案去重的重播口（见上面的去重注释）：动画重播 + 计时清零重来
  el._refresh = () => {
    stop();
    left = TOAST_KEEP[kind] ?? TOAST_KEEP.info;
    el.classList.remove('in');
    requestAnimationFrame(() => el.classList.add('in'));
    start();
  };
  start();
}




/*
 * 岗位（2026-11-11 Phase 2）：岗位是**系统内置的固定岗位**，权限挂在岗位上（见 roles.mjs）。
 * 前端只做两件事：**显示岗位名**、**按权限筛**（团队协作群清单、群助手警告）。
 * 判定口径一律从 /api/state 下发的 `S.roles` 来 —— 不再自己拆 `role` 文本拼名字。
 */
export const roleNameOf = (p) => {
  const key = p?.roleKey ? String(p.roleKey) : '';
  const hit = key ? (S.roles ?? []).find((r) => r.key === key) : null;
  if (hit) return hit.name;
  // 旧数据兜底（迁移前 / 接口没带 roleKey）：`岗位 · 职责` 取第一段
  return String(p?.role ?? '').split(' · ')[0].trim();
};

/** 这个岗位有没有某条权限（`perm` 见 roles.mjs 的 PERMISSIONS） */
export const roleCan = (roleKey, perm) => {
  const role = (S.roles ?? []).find((r) => r.key === roleKey);
  return !!role && (role.permissions ?? []).includes(perm);
};

/** 这个人有没有某条权限（群成员接口可能没带 roleKey → 回落到 role 文本认不出，返回 false） */
export const personaCan = (p, perm) => roleCan(p?.roleKey, perm);

/** 人员下拉里的标签（2026-10-23 用户拍板）：`李俊（产品经理）` —— 姓名在前，括号里只留岗位名；
 *  没岗位的人只有名字。岗位名从 roleKey 取（岗位固定之后不再拼「岗位 · 职责」）。 */
export const personLabel = (p) => {
  const role = roleNameOf(p);
  return role ? `${p.name}（${role}）` : p.name;
};

/** 真人显示名（2026-11-09 用户："昵称不能只在我的页面里生效"）：昵称优先，没设退回账号名，
 *  查无此人 → null（调用方好接 `??` 兜底）。账号名仍是**身份口径** —— 「是不是自己」的
 *  判断、署名匹配都拿它比；这里只管"画出来叫什么"，不管认人。 */
export const userLabel = (u) => u?.nickname || u?.name || null;



/** 通讯录那一行的副标题：只显示岗位名（sandbox/运行时是技术细节，只在详情页看） */
// 2026-10-23 用户拍板：运行时 id（rt-xxx）对人没有意义，不再上列表；
// 没岗位的人退回「自动」——只保留这一个人类能读懂的运行时值，其余一律不显示
export const personSubtitle = (p) => roleNameOf(p) || (p.runtime === 'auto' ? '自动' : '');

/** 列表里单独摆一格「运行时」时的文案（项目成员 tab，2026-10-24）：
 *  口径跟 personSubtitle 后半截是同一条 —— **只有 auto 能上列表**，显示「自动」；
 *  其余一律返回空串，调用方就不摆那一格（rt-id / codex / claude 都是技术细节）。 */
export const runtimeLabel = (p) => (p?.runtime === 'auto' ? '自动' : '');
