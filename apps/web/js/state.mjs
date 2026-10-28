/* state.mjs —— 状态。
 * 2026-10-22 由 app.js（15537 行单文件）拆出，原生 ESM、无打包器；逻辑逐字搬运。 */
import { savePlace, toast } from './shell.mjs';
import { api } from './ui.mjs';
import { openSettings } from './settings.mjs';
import { closeAddMenu, renderList, showContactsHome, showView } from './contacts.mjs';
import { openWorkflows } from './workflows.mjs';
import { closeRunStream, setListTitle } from './flowpages.mjs';
import { openExperts, openPlugins } from './experts.mjs';
import { $, S } from './core.mjs';



/* ------------------------------------------------------------------ 菜单收敛 */

/**
 * 一级导航的 `data-nav` → 菜单 key 的对照表（唯一一处）。
 *
 * ⚠️ 两套命名不一样，别想当然：导航按钮叫 `plugins`（工作台），菜单 key 叫 `workbench`
 * （见 roles.mjs 的 MENU_KEYS）。左边的值是 DOM 里的，右边是目录里的，改任何一边都要改这里。
 */
const NAV_KEY = {
  messages: 'messages',
  contacts: 'contacts',
  experts: 'experts',
  plugins: 'workbench',
  settings: 'settings',
};

/** 一级导航的固定顺序（"当前这栏被藏了"时按它挑第一个能看的） */
const NAV_ORDER = ['messages', 'contacts', 'experts', 'plugins', 'settings'];

/** 这个身份能不能看见某个菜单（`S.menuKeys === null` = 不限制：operator，或角色没拿到） */
export function canSeeMenu(key) {
  if (!S.menuKeys) return true;
  return S.menuKeys.includes(key);
}

/** 第一个能看的一级栏 */
export function firstVisibleNav() {
  return NAV_ORDER.find((n) => canSeeMenu(NAV_KEY[n])) ?? 'messages';
}

/**
 * 按角色收敛导航（2026-10-28 第三刀，**本刀唯一的渲染改动**）。
 *
 * 为什么用 `style.display` 而不是 `.hidden`：全站 `.hidden` 只有 `.mini` / `.list-search` /
 * `#chatView` 三条具体的 display 规则，给 `.nav-btn` 加 class 根本不会藏（这是个老坑）。
 * 设空串就回到 CSS 原本的 display，不用猜它是 flex 还是 grid。
 *
 * 手机底部导航（`.mb-tab`）一起处理：任务书 §六 要求"底部导航同上"。
 * 幂等 —— 每次 `load()` 都调，重复调用没有副作用。
 */
export function applyMenuGating() {
  document.querySelectorAll('.nav-btn[data-nav]').forEach((b) => {
    const key = NAV_KEY[b.dataset.nav];
    b.style.display = key && !canSeeMenu(key) ? 'none' : '';
  });
  document.querySelectorAll('.mb-tab[data-tab]').forEach((b) => {
    const key = NAV_KEY[b.dataset.tab];
    b.style.display = key && !canSeeMenu(key) ? 'none' : '';
  });
}

/* ------------------------------------------------------------------ 状态 */

export async function load() {
  const [s, sk] = await Promise.all([api('/api/state'), api('/api/skills')]);
  S.runtimes = s.runtimes;
  S.personas = s.personas;
  S.conversations = s.conversations;
  S.repoRoot = s.repoRoot;
  S.me = s.me;
  S.skills = sk.skills;
  S.skillsRoot = sk.skillsRoot;
  S.hiddenConversations = s.hiddenConversations ?? [];
  S.groups = s.groups ?? [];
  // 已发布的流程（建任务时「执行方式 = 由流程执行」的下拉要用；工作台不再摆它们的磁贴）。
  // 拿不到就当没有，别让整个 load 挂掉
  try {
    S.flowPublished = (await api('/api/workflows')).published ?? [];
  } catch {
    S.flowPublished = [];
  }
  // 项目（工作台入口要显示个数）
  try {
    S.projects = (await api('/api/projects')).projects ?? [];
  } catch {
    S.projects = [];
  }
  /*
   * 我是谁（2026-10-28 第三刀改成 `/api/me`）。只问一次 —— `load()` 会被通讯录轮询、
   * 下拉刷新反复调，每拍都问一遍没有意义（身份在会话期间不变）。
   *
   * 三种答案一次拿全，前端不用再猜：
   *   · `operator` —— 回环 / 共享令牌 / 回环桌面壳：**全部菜单**（`menuKeys = null` 表示不限制）；
   *   · `user`     —— 登录的浏览器：`role.menuKeys` 决定看得见哪些菜单；
   *   · `device`   —— 手机：**也吃总机分配的 `role.menuKeys`**（2026-10-28 第四刀，
   *                   未分配时是默认的「手机」角色 = 底部那四个 tab，与从前一致）。
   *
   * 为什么不用 `/api/pair/me` 了：那条路对登录用户会回 `kind:'operator'`（历史口径），
   * 一个普通村民会被判成"操作员"，菜单收敛就全失效了。
   */
  if (S.isDevice === undefined || S.auth === undefined) {
    try {
      const me = await api('/api/me');
      S.auth = me ?? null;   // ⚠️ 不能叫 S.me —— 那个字段是「本机用户」(/api/state 的 me)，groups.mjs 在用
      S.isDevice = me?.kind === 'device';
      S.device = me?.device ?? null;
      S.isUser = me?.kind === 'user';
      S.isAdmin = S.isDevice ? true : me?.kind === 'operator' ? true : me?.role?.id === 'admin';
      /*
       * null = 不限制（只有 operator，以及"角色没拿到"这种异常）；数组 = 看得见的菜单 key。
       * **只有真拿到一份数组才收敛** —— 设备那条路万一没回 role，宁可全显示，也别把界面清空。
       */
      const keys = me?.role?.menuKeys;
      S.menuKeys = (me?.kind === 'user' || me?.kind === 'device') && Array.isArray(keys) ? keys : null;
    } catch {
      S.auth = null;
      S.isDevice = false;
      S.device = null;
      S.isUser = false;
      S.isAdmin = true;
      S.menuKeys = null;
    }
    document.body?.classList.toggle('mb-device', !!S.isDevice);
    applyMenuGating();
    /*
     * 落在了一个这个账号看不见的栏上（比如刷新前停在「设置」，但账号只有会话权限）——
     * 挪到第一个能看的。不挪的话右栏会画出设置页，左边却没有对应按钮，看着像"点了没反应"。
     */
    if (S.nav && !canSeeMenu(NAV_KEY[S.nav] ?? 'messages')) {
      try {
        setNav(firstVisibleNav());
      } catch { /* 启动很早的时候 DOM 还没齐：下一拍 load() 会再走一遍 */ }
    }
  }
  renderList();
  // 详情页开着时，那枚忙/闲徽标也要跟着变（轮询只重画了列表，没重画详情）
  const open = S.persona ? S.personas.find((x) => x.id === S.persona.id) : null;
  const el = $('dBusy');
  if (open && el) {
    // 徽标要跟通讯录的绿点**同一个来源**（都看 /api/state 的 busy），
    // 否则会出现"绿点 + 详情写空闲"这种自相矛盾（用户实报）
    el.textContent = open.busy ? (open.busyLabel ? '工作中·' + open.busyLabel : '工作中') : '空闲';
    el.title = open.busyLabel ?? '';
    el.classList.toggle('busy', !!open.busy);
  }
}



/**
 * 通讯录开着的时候，轻量轮询一下忙/闲。
 *
 * 忙闲是**服务端算的**（看有没有正在跑的活），而全站没有定时刷新 ——
 * 不轮询的话，波哥在群里写代码，通讯录还显示"闲"（用户实报）。
 * 5 秒一次、只在通讯录这一页开着时跑，离开就停。
 */
export let contactsTimer = null;


export function syncContactsPoll() {
  clearInterval(contactsTimer);
  contactsTimer = null;
  if (S.nav !== 'contacts') return;
  contactsTimer = setInterval(() => {
    if (S.nav !== 'contacts') {
      clearInterval(contactsTimer);
      contactsTimer = null;
      return;
    }
    // 有弹窗开着就跳过这一拍：`load()` 会重画左栏和详情，背后跳一下，
    // 透过遮罩看就是"弹窗在有频率地闪"（跟流程页那个定时重画同一个毛病）
    if (document.querySelector('dialog[open]')) return;
    load().catch(() => {});
  }, 5000);
}



export function setNav(nav, opts = {}) {
  S.nav = nav;
  // 一级栏只是兜底：具体页面的入口函数会在摆好后调 setRoute 覆盖成更具体的那个
  S.route = null;
  /*
   * 「已归档」是消息模块里的**子视图**（左栏换一份列表），离开消息、或走任何正常的
   * setNav('messages') 都要退出它 —— 只有 enterArchiveView 自己带 keepArchiveView 进来。
   * 不这样收口的话，从归档视图点去别处再回来，左栏还停在归档列表上。
   */
  if (!opts.keepArchiveView) S.archivedView = false;
  // 离开工作台那一栏 = 离开项目列表 / 项目看板 / 全局面板 —— 顺手清掉。
  // 不清的话它们会一直挂着：位置记里留着一个"在看板"（刷新时那条路会被优先捡起来），
  // 而从看板点会话卡会切到消息页（那时看板状态就该结束）。这些标志只对工作台那一栏有意义。
  if (nav !== 'plugins') {
    S.projectList = false;
    S.projectId = null;
    S.boardAll = false;
  }
  // 工作流编排的入口搬到**工作台**里了（rail 上不再单列一项）。
  // 它仍是一级栏的一种状态（左栏归属、位置记忆都靠它），所以高亮落在「工作台」上 ——
  // 否则看着像"哪儿都没选中"。
  const hl = nav === 'workflows' ? 'plugins' : nav;
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.nav === hl));
  setListTitle(
    nav === 'messages' ? '消息'
    : nav === 'contacts' ? '通讯录'
    : nav === 'workflows' ? '工作流'
    : nav === 'plugins' ? '工作台'
    : nav === 'experts' ? '专家库'
    : '设置',
  );
  $('listAction').textContent = '＋';
  $('listAction').title =
    nav === 'contacts' ? '发起群聊 / 添加数字员工' : '新建项目群';
  // 消息页没有"新建"：发起群聊的入口在通讯录（那里能一次选"群聊 or 员工"）
  $('listAction').classList.toggle(
    'hidden',
    nav === 'settings' || nav === 'workflows' || nav === 'messages' || nav === 'plugins' || nav === 'experts',
  );
  // 工作台：宫格首页左栏整个收掉；进插件后左栏让位给插件自己的列表（搜索框对插件没用）。
  // 专家库是整页卡片墙，搜索框同样没用 —— 一起收掉。
  $('search').closest('.list-search')?.classList.toggle('hidden', nav === 'plugins' || nav === 'experts');
  closeAddMenu();
  // 工作台是整页宫格，二级列表栏在那儿没用 —— 整列收掉（见 CSS 的 body.no-list）。专家库同理。
  document.body.classList.toggle('no-list', nav === 'plugins' || nav === 'experts');
  renderList();
  savePlace();   // 换了位置就记下来，刷新后能回来
  // 通讯录要看实时忙/闲 → 开着这一页时轮询；离开自动停
  syncContactsPoll();
  // 离开工作流页就把它那条实时流收掉：留着的话跑完会去重画左栏，
  // 而左栏此刻属于别人（通讯录）—— 两个页面抢着画（踩过）
  if (nav !== 'workflows') closeRunStream();

  // 主区要跟着一级栏走，否则会出现「点了技能，右边还停在聊天」这种错位
  // skipOpen：调用方自己会打开具体内容（比如"发起流程后直接落到实例页"），
  // 这里就别再开一次默认页 —— 否则两边抢着渲染，谁后回来谁赢
  if (opts.skipOpen) return;
  if (nav === 'settings') openSettings(S.settingsSection);
  else if (nav === 'workflows') openWorkflows().catch((e) => toast(e.message, 'error'));
  else if (nav === 'plugins') openPlugins().catch((e) => toast(e.message, 'error'));
  else if (nav === 'experts') openExperts().catch((e) => toast(e.message, 'error'));
  // 通讯录（2026-10-24 对齐微信）：切过来先落在空态上，不残留上一段聊天 ——
  // 点左栏的群/员工才进详情。聊天归消息页，这两个模块的主区不共用了。
  else if (nav === 'contacts') showContactsHome();
  else showView('chat');
}
