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
   * 我是谁（2026-10-28）：设备令牌 → **受限视图**。只问一次 —— `load()` 会被
   * 通讯录轮询、下拉刷新反复调，每拍都问一遍没有意义（身份在配对期间不变）。
   * `/api/pair/me` 对操作员/回环形态回 `{kind:'operator'}`，所以桌面端也是同一条路。
   */
  if (S.isDevice === undefined) {
    try {
      const me = await api('/api/pair/me');
      S.isDevice = me?.kind === 'device';
      S.device = me?.device ?? null;
    } catch {
      S.isDevice = false;
      S.device = null;
    }
    document.body?.classList.toggle('mb-device', !!S.isDevice);
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
