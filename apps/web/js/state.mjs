/* state.mjs —— 状态。
 * 2026-10-22 由 app.js（15537 行单文件）拆出，原生 ESM、无打包器；逻辑逐字搬运。 */
import { savePlace, toast } from './shell.mjs';
import { api } from './ui.mjs';
import { openSettings, openMe } from './settings.mjs';
import { closeAddMenu, renderList, showContactsHome, showView } from './contacts.mjs';
import { openWorkflows } from './workflows.mjs';
import { closeRunStream, setListTitle } from './flowpages.mjs';
import { openExperts, openPlugins } from './experts.mjs';
import { $, S } from './core.mjs';



/* ------------------------------------------------------------------ 壳层标记 */

/*
 * 给网址打「已进工作台」标记（#bandi-app）—— 手机壳的返回键分流要用（MainActivity）。
 *
 * 为什么不用 Cookie 判：Cookie 只能说明"这台机登录过"——登录成功一次就一直在，
 * 停在登录页/配对页时也会被误判成"已登录在工作台"，返回键被吞（2026-11-05 用户实报）。
 * 标记由**网页自己**在认证通过后打上，壳层读 WebView 当前 URL 就能拿到"此刻"的状态。
 * 应用不用 hash 路由（全项目无 hashchange 监听），这个标记不跟任何东西打架。
 */
export function markAppUrl() {
  if (location.hash.includes('bandi-app')) return;
  try {
    history.replaceState(history.state, '', '#bandi-app');
  } catch { /* file:// 之类打不上就算了：壳层按"没标记"放行 */ }
}



/* ------------------------------------------------------------------ 状态 */

/**
 * 拉一遍全量状态（/api/state + /api/skills）。
 *
 * `opts.dotsOnly` —— **只同步忙/闲的点，不重画列表**。
 * 通讯录的 5 秒轮询本来就是为了那颗绿点，但过去每拍都调 renderList()，
 * 整个 #listBody 的 innerHTML 重建一次，头像 <img> 跟着重建、重新解码 ——
 * 用户看到的就是"头像每 5 秒闪一下"（2026-10-31 实报）。
 * 数据照旧全部更新进 S，只是不动 DOM；切走再回来时 renderList 会画出最新的一份。
 */
export async function load(opts = {}) {
  const [s, sk] = await Promise.all([api('/api/state'), api('/api/skills')]);
  S.runtimes = s.runtimes;
  S.personas = s.personas;
  S.conversations = s.conversations;
  S.repoRoot = s.repoRoot;
  S.me = s.me;
  // 本机安全形态（IAM §10.1.3，2026-10-31）：`localSecret === 'required'` = 服务器形态 ——
  // 前端据此**不渲染**破坏性本机按钮（数据导出/导入、协作加入/退出、算力加入），
  // 换成"请在本机终端执行 bandi …"的提示；`source` 是"当前浏览器是不是本机"。
  // 页面不猜：字段没有（旧服务）就当 not-required，行为与从前一致。
  S.localSecret = s.localSecret ?? 'not-required';
  S.bandiSource = s.source ?? 'loopback';
  // 真人名册（2026-10-31 用户概念落地）：通讯录「成员」段与看板派活选真人用
  S.users = s.users ?? [];
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
   * 我是谁（`/api/me`）。只问一次 —— `load()` 会被通讯录轮询、下拉刷新反复调，
   * 每拍都问一遍没有意义（身份在会话期间不变）。
   *
   * 2026-11-07 起登录即全权：菜单不再按角色收敛（那套体系已退场），
   * 这里只区分 operator / user / device 三种身份给「我的」页和退出按钮用。
   */
  if (S.isDevice === undefined || S.auth === undefined) {
    try {
      const me = await api('/api/me');
      S.auth = me ?? null;   // ⚠️ 不能叫 S.me —— 那个字段是「本机用户」(/api/state 的 me)，groups.mjs 在用
      if (me) markAppUrl();   // 认证通过：给壳层的返回键分流报"此刻在工作台"
      S.isDevice = me?.kind === 'device';
      S.device = me?.device ?? null;
      S.isUser = me?.kind === 'user';
      S.isAdmin = !S.isDevice; // 登录即全权：operator 与登录用户都能看管理设置；手机设备只看设备设置
    } catch {
      S.auth = null;
      S.isDevice = false;
      S.device = null;
      S.isUser = false;
      S.isAdmin = true;
    }
    document.body?.classList.toggle('mb-device', !!S.isDevice);
  }
  if (opts.dotsOnly) syncBusyDots();
  else renderList();
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
 * 只改「忙/闲」那一颗绿的，其余 DOM 一动不动（供 `load({ dotsOnly: true })` 用）。
 *
 * 通讯录行的人头上挂着一颗 `.dot`，行上写死 `data-persona=<id>`；
 * 数据刚从 /api/state 更新进 S.personas，这里只把 class 跟上。
 * 找不到人就跳过 —— 列表可能是别的页面画的（消息列表的行不带 data-persona）。
 */
function syncBusyDots() {
  document.querySelectorAll('#listBody [data-persona]').forEach((row) => {
    const p = S.personas.find((x) => x.id === row.dataset.persona);
    const dot = row.querySelector(':scope > .dot');
    if (p && dot) dot.classList.toggle('busy', !!p.busy);
  });
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
    // 有弹窗开着就跳过这一拍：重画会让背后跳一下，透过遮罩看就是"弹窗在有频率地闪"
    if (document.querySelector('dialog[open]')) return;
    // 只同步那颗绿点：整表重画会让头像 <img> 跟着重建，每 5 秒闪一次（用户实报）
    load({ dotsOnly: true }).catch(() => {});
  }, 5000);
}



export function setNav(nav, opts = {}) {
  const prevNav = S.nav;
  S.nav = nav;
  // 一级栏只是兜底：具体页面的入口函数会在摆好后调 setRoute 覆盖成更具体的那个
  S.route = null;
  /*
   * 「已归档」是消息模块里的**子视图**（左栏换一份列表），离开消息、或走任何正常的
   * setNav('messages') 都要退出它 —— 只有 enterArchiveView 自己带 keepArchiveView 进来。
   * 不这样收口的话，从归档视图点去别处再回来，左栏还停在归档列表上。
   */
  if (!opts.keepArchiveView) S.archivedView = false;
  // 工作流的「已归档」也是子视图（消息模块同款）：离开工作流、或正常进来都退回主清单。
  // 归档视图里删完模板要留在原地，走 openWorkflows(id, {keepView:true}) 把旗子带上。
  if (!opts.keepFlowArchiveView) S.flowArchivedView = false;
  // 左栏底部固定条是**跨列表**的（消息/工作流的「已归档 N」都挂这儿）：
  // 切栏先清空，谁的入口谁自己再写 —— 不然从工作流切去代码托管，那行「已归档」还赖在页底。
  const lf = $('listFoot');
  if (lf) lf.innerHTML = '';
  // 离开工作台那一栏 = 离开项目列表 / 项目看板 / 全局面板 —— 顺手清掉。
  // 不清的话它们会一直挂着：位置记里留着一个"在看板"（刷新时那条路会被优先捡起来），
  // 而从看板点会话卡会切到消息页（那时看板状态就该结束）。这些标志只对工作台那一栏有意义。
  if (nav !== 'plugins') {
    S.projectList = false;
    S.projectId = null;
    S.boardAll = false;
    // 也意味着离开了插件主从页（远程连接 / 代码托管）：把「上次给哪个插件画过」忘掉，
    // 下次进来重新清一次搜索词（见 renderPluginMaster / renderGitRepos），
    // 不然上个栏目的关键词会把左边的机器 / 仓库全滤没，看着像"全丢了"。
    S.pluginSearchFor = null;
    // 项目页那个框同理（S.projSearchFor 记「上次是谁在用 #search」）：
    // 不重置的话，下次进项目页会以为框是自己的、不去清旧关键词。
    S.projSearchFor = null;
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
    : nav === 'me' ? '我的'
    : '设置',
  );
  $('listAction').textContent = '＋';
  $('listAction').title =
    nav === 'contacts' ? '发起群聊 / 添加数字员工' : '新建项目群';
  // 消息页没有"新建"：发起群聊的入口在通讯录（那里能一次选"群聊 or 员工"）
  $('listAction').classList.toggle(
    'hidden',
    nav === 'settings' || nav === 'workflows' || nav === 'messages' || nav === 'plugins' || nav === 'experts' || nav === 'me',
  );
  // 工作台：宫格首页左栏整个收掉；进插件后左栏让位给插件自己的列表（搜索框对插件没用）。
  // 专家库是整页卡片墙，搜索框同样没用 —— 一起收掉。我的页同理（整页，见 settings.mjs openMe）。
  $('search').closest('.list-search')?.classList.toggle('hidden', nav === 'plugins' || nav === 'experts' || nav === 'me');
  // 换栏顺手清搜索（2026-10-29）：旧关键词是上一个栏的语境（在代码托管搜仓库名，
  // 切到消息不该还滤着）。只在**真的换了栏**时清 —— 同栏内点行重摆（通讯录点员工详情
  // 也是一遍 setNav('contacts')）不能把用户正打着字的搜索框清掉。
  if (prevNav !== nav && S.filter) {
    S.filter = '';
    const si = $('search');
    if (si) si.value = '';
  }
  closeAddMenu();
  // 工作台是整页宫格，二级列表栏在那儿没用 —— 整列收掉（见 CSS 的 body.no-list）。专家库、我的页同理。
  document.body.classList.toggle('no-list', nav === 'plugins' || nav === 'experts' || nav === 'me');
  /*
   * 占位文案按栏回落（2026-11-02）：各页在自己的 renderList 分支里改 placeholder
   * （搜流程 / 搜项目名 / 搜索设置 …），换栏时先归位默认值，否则从设置切回消息，
   * 框里还写着「搜索设置」。默认值必须在 renderList **之前**写 —— 页面自己的覆盖后到。
   */
  if (prevNav !== nav) {
    const si = $('search');
    if (si) si.placeholder = '搜索';
  }
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
  else if (nav === 'me') openMe();
  else if (nav === 'workflows') openWorkflows().catch((e) => toast(e.message, 'error'));
  else if (nav === 'plugins') openPlugins().catch((e) => toast(e.message, 'error'));
  else if (nav === 'experts') openExperts().catch((e) => toast(e.message, 'error'));
  // 通讯录（2026-10-24 对齐微信）：切过来先落在空态上，不残留上一段聊天 ——
  // 点左栏的群/员工才进详情。聊天归消息页，这两个模块的主区不共用了。
  else if (nav === 'contacts') showContactsHome();
  else showView('chat');
}
