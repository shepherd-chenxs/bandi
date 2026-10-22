/* 班底 · 前端。三级结构：图标栏 → 列表 → 内容 */
const $ = (id) => document.getElementById(id);

/*
 * 本机身份（2026-10-21 拍板：**节点只当算力，不做「看总机面板」**）。
 * 旧的反代注入（`__BANDI_CLIENT__`）已随 client-proxy 移除 —— 加入状态不再从 HTML 里来，
 * 统一读 `/api/local/status`（服务端答案， boot 处判一次；「这台机器」分区也读它）。
 */
const LOCAL_BASE = '/api/local';

const S = {
  nav: 'messages',          // messages | contacts | skills | settings
  /*
   * **整站只有一个"我在哪儿"**（2026-10-17 统一路由）。形状：{ view, ...params }。
   * 以前每加一个页面都要在 savePlace（逐字段）和 restorePlace（逐页 if/else）各登记一次，
   * 忘了就"刷新记不住位置"—— 项目页 / 任务看板 / 流程实例 / 任务卡，四次都是这个病。
   * 现在：存位置＝存这个对象；恢复＝openRoute(它)；新页面＝入口里一行 setRoute ＋ ROUTES 表一行。
   */
  route: null,
  filter: '',
  runtimes: [],
  personas: [],
  conversations: [],
  skills: [],
  skill: null,
  skillsRoot: '',
  persona: null,
  conversation: null,
  es: null,
  running: false,
  drawerOpen: false,
  drawerThreadId: null,
  drawerThread: null,
  removeMode: false,
  membersExpanded: false,
  memberQuery: '',
  settingsSection: 'prefs',
  pluginTab: 'installed',   // installed | catalog | personal
  connectors: [],
  catalog: [],
  catalogError: null,
  runtimeFamilies: [],
  theme: 'system',          // light | dark | system
  rtLevel: 'devices',       // devices | device | cli
  rtScan: null,             // 「识别本机运行时」的扫描结果（null = 这轮还没扫过）
  taskPoll: null,           // 「有活在做就自己刷」的定时器（见 scheduleTaskPoll）
  rtDevice: null,
  rtRuntime: null,
  groupThreadId: null,      // 正在看的群详情页（通讯录里点群进来）—— 存的是**群 id**，不是会话 id
  groupThread: null,        // 群身份行（groups 表那条：id/title/assistantPersonaId/members）
  /*
   * 消息模块的「已归档」子视图（2026-10-20）：左栏换成归档列表，右边照常是对话面板。
   * 它不是一级栏、也不是路由 —— 就是个开关：离开消息/正常调 setNav 都会清掉。
   */
  archivedView: false,
  /*
   * 被「不显示」收走的会话（2026-10-20 去掉会话归档后）。
   * `conversations` 是列表用的（不含隐藏的）；这一份**只给聊天记录抽屉**用 ——
   * 「不显示」= 不在消息列表占行，但聊天记录里必须还看得到。
   */
  hiddenConversations: [],
  /*
   * 群的**容器列表**（`groups` 表，2026-10-20）：通讯录的「群聊」分段读它，不再从会话推。
   * 为什么单列一份：群是容器（名字/成员/群助手），会话只是片段 —— 片段删光了群还在，
   * 通讯录里不该凭空消失（用户实报过）。消息列表则继续只看 conversations。
   */
  groups: [],
  /*
   * 专家库（2026-10-23 改版）：左侧一级栏「专家库」，整页分区卡片墙（GET /api/experts）。
   * null = 还没拉过 —— 第一次进专家库时补拉（openExperts 里触发），雇佣/解聘后整体重拉。
   * 目录是服务端常量，本端只缓存不推算：**雇没雇以 hired 字段为准**，别在本地比对 personas
   * （两份数据到达时间不同，比出中间态就闪错标记）。
   */
  experts: null,
  /*
   * 右侧抽屉只有一个 DOM（#drawer），两种内容共用，靠 drawerKind 分流（2026-10-20）：
   *   nil     = 没开
   *   'group' = 群成员设置（openGroupDrawer 写、paintDrawer 走原逻辑）
   *   'log'   = 聊天记录（openChatLogDrawer 写、paintDrawer 首行就转 paintChatLogDrawer）
   * 谁开谁置，closeDrawer 一律清空 —— 不清就会出现"下一次开群设置画出来是聊天记录"。
   */
  drawerKind: null,
  logPersonaId: null,       // 聊天记录抽屉看的是谁（渲染时从 S.conversations 现算，不缓存列表）
  logGroupId: null,         // 群聊天记录：抽屉看的是哪个群（一个群有多段会话，见 openChatLogDrawer）
  logGroupTitle: null,      // 群名（抽屉标题用；不与 rows 耦合，抽屉空着也知道自己在看哪个群）
  logLoading: false,        // 抽屉「正在拉…」瞬时标记，取完 / 关闭都置 false
  /*
   * 当前打开的这段会话**一条消息都没有**（「发消息」连点复用它，别堆空壳）。
   * openConversation 按服务端返回的 messages 写、send 首行清 —— 不落盘、不进路由：
   * 刷新后重新按库里算，结论一致。
   */
  convEmpty: false,
  plugins: [],              // 界面插件（plugins/<id>/manifest.json）
  plugin: null,             // 当前选中的插件 id
  pluginData: {},           // 插件面板按接口缓存的数据
  pluginForm: {},           // 插件表单的当前值 / 正在编辑哪一行
  pluginFormDlg: null,      // 弹窗里正在编辑的表单（{plugin, block, fid}）
  pluginRow: null,          // 主从布局里左栏选中的那一行（按 master.keyField 存）
  // 平台的「项目」页：列表 / 某个项目的任务看板。两个都要能刷新后回来
  //（不记的话刷新就掉回工作台 —— 用户 2026-10-14 实报）
  projectList: false,       // 在看项目列表
  projectId: null,          // 在看哪个项目的看板
  boardAll: false,          // 在看<b>全局任务看板</b>（所有项目的活，工作台那个入口）
  // 看板的筛选：项目看板与全局面板**共用一套**（它们本来就是同一张看板换个范围）。
  // 三个维度，空数组 = 那一维不设限：状态 / 负责人（员工 id）/ 项目（项目 id）。
  // 切页面、刷新重画都不丢 —— 它就存在这儿。
  kbFilter: { statuses: [], assignees: [], projects: [] },
  kbPane: '',               // 筛选弹层停在哪一维（二级）；空串 = 一级（维度清单）。只在这一次开合里有效
  kbSearch: '',             // 二级里的搜索词（只有负责人/项目有搜索框）；换维、返回、重开都清掉
  kbLast: null,             // 最后一次画出来的看板数据 + 重画回调（筛选变了原地重画用）
  flowTemplates: [],        // 工作流模板（这个模块只管模板，不管跑起来的实例）
  designerId: null,         // 流程设计器：正在编辑哪个模板
  designerOpen: null,       // 设计器开着的话记模板 id（重开页面能回这儿）
  designerDraft: [],        // 设计器里的节点草稿（改一处存一处，切走也不丢）
  designerRestored: false,  // 这次打开时是否恢复了本地草稿（界面上要提示）
  designerDraftAt: null,    // 草稿是什么时候存的（提示里说"3 分钟前"）
  dzPanelCollapsed: false,  // 属性面板收起来了（记在本地，下次进来还是收着的）
  designerPublished: false, // 这个模板发布没有（按钮上显示"发布"还是"下架"）
  designerName: '',
  // 流程运行态：工作台可点的已发布流程 / 单子 / 当前回复的是哪条
  flowPublished: [],
  flowMode: 'design',   // 工作流视图的两个模式：design = 编排模板，run = 看发起记录
  flowTemplate: null,   // run 模式看的是哪个模板的发起记录
  flowRuns: [],
  flowRunId: null,
  flowRun: null,
  flowStarting: null,
  // 服务端给的今日用量（GET /api/quota 那一整份）——实例页顶栏那句"今天已用 X"用它。
  // 每次 paintRun 重新取：刚跑完的那一步花的 token 要立刻算进去。
};

/* ---------------------------------------------------------------- 主题 */

const THEME_KEY = 'bandi.theme';
/**
 * 通讯录分段的折叠状态（跟主题一样记住）。
 * 默认：**群聊收起、数字员工展开** —— 日常主要是找人说话，群是少数。
 * 键名带 v2：改默认值时要让新默认生效一次，否则老浏览器里存着的旧状态会盖住它。
 */
const SEC_KEY = 'bandi.contactsCollapsed.v2';
const SEC_DEFAULT = { group: true, person: false };
function readCollapsed() {
  try {
    const saved = JSON.parse(localStorage.getItem(SEC_KEY) || 'null');
    if (saved && typeof saved === 'object') return saved;
  } catch { /* 读不了就用默认 */ }
  return { ...SEC_DEFAULT };
}
function saveCollapsed() {
  try { localStorage.setItem(SEC_KEY, JSON.stringify(S.secCollapsed ?? {})); } catch { /* 写不了就算了 */ }
}
const prefersLight = () => window.matchMedia('(prefers-color-scheme: light)').matches;

/* ------------------------------------------------------ 记住"上次停在哪" */

/**
 * 刷新后回到原来的位置。
 *
 * 原来启动时写死 `setNav('messages')` —— 在哪个页面按 F5 都会被弹回消息页，
 * 在插件里改一半配置、刷新一下就找不着了。
 * 存的是**能重建位置的标识**（会话 id、技能名、插件 id + 选中行），不是 DOM 快照。
 */
const PLACE_KEY = 'bandi.place';

/**
 * 记下"我在哪儿"。
 *
 * **只存一个 route**（2026-10-17 统一路由）：以前是逐字段手写（nav / conversation / skill / plugin /
 * project / taskBoard / taskCard / designer / flowMode / flowRun…），每加一个页面都要回来加一行，
 * 忘了就刷新掉回消息页。现在只有一份 —— 加页面不用再动这个函数。
 *
 * 跟页面无关的界面状态（看板筛选）另存：它不是"位置"，但刷新后也该保持。
 */
function savePlace() {
  try {
    localStorage.setItem(
      PLACE_KEY,
      JSON.stringify({
        version: 2,
        route: S.route ?? { view: S.nav },
        kbStatuses: S.kbFilter?.statuses ?? [],
        // 负责人 / 项目（2026-10-18）：同样记着，刷新回来还是筛着的
        kbAssignees: S.kbFilter?.assignees ?? [],
        kbProjects: S.kbFilter?.projects ?? [],
      }),
    );
  } catch { /* 隐私模式下写不了就算了，不影响用 */ }
}

function readPlace() {
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
const ROUTES = {
  messages: () => setNav('messages'),
  contacts: () => setNav('contacts'),
  settings: ({ section } = {}) => {
    // 定时任务已搬去工作台（2026-10-17）：存着的旧位置（settings/schedules）还认，
    // 但直接转过去 —— 设置里已经没这一节了，留着会画出个空白页。
    if (section === 'schedules') return openRoute({ view: 'schedules' });
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
  // 旧位置兼容：改版前存的是通讯录里的专家详情页（{ view:'expert', key }），
  // 详情视图已拆 —— 拿到旧位置就转去新的一级栏（同 settings/schedules 的先例）
  expert: () => openRoute({ view: 'experts' }),
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
    return openTaskCardPage(id, { fromAll, fromFlow });
  },
  // 定时任务：工作台里的一页（2026-10-17 从设置搬过来）
  schedules: () => {
    setNav('plugins', { skipOpen: true });
    return openSchedules();
  },
};

/**
 * 打开"某个位置"。**整站唯一的分发点**。
 *
 * 恢复位置、以后可能的链接直达，都走它 —— 别在各处再写"如果 nav 是 X 就开 Y"的分支。
 */
function openRoute(route) {
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
function setRoute(view, params = {}) {
  // 页面级组件（比如任务卡的评论输入框）挂在 document 上的监听，在这时候摘：
  // 页面随时重建，不摘就会一层层堆起来。没有登记的就什么都不做。
  for (const fn of window.__pageCleanups ?? []) { try { fn(); } catch { /* 摘不掉也不影响渲染 */ } }
  window.__pageCleanups = [];
  S.route = { view, ...params };
  savePlace();
}

/** 启动时回到上次的位置。**回不去就退回消息页**——
 * 会话可能被移除、技能被删、插件被卸，存着的位置不一定还在。 */
async function restorePlace() {
  const p = readPlace();
  // 跟页面无关的界面状态先还原（看板筛选）
  if (Array.isArray(p?.kbStatuses)) S.kbFilter.statuses = p.kbStatuses.filter((x) => typeof x === 'string');
  if (Array.isArray(p?.kbAssignees)) S.kbFilter.assignees = p.kbAssignees.filter((x) => typeof x === 'string');
  if (Array.isArray(p?.kbProjects)) S.kbFilter.projects = p.kbProjects.filter((x) => typeof x === 'string');
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
 * 里给 127.0.0.1:8787 开了 core:window:allow-set-theme + remote urls，见 desktop）。
 */
function applyTheme() {
  const resolved = S.theme === 'system' ? (prefersLight() ? 'light' : 'dark') : S.theme;
  document.documentElement.dataset.theme = resolved;
  try {
    const win = window.__TAURI__?.window?.getCurrentWindow?.();
    win?.setTheme?.(S.theme === 'system' ? null : resolved);
  } catch { /* 浏览器里没有 __TAURI__；壳被旧版 exe 带着跑时 IPC 可能没开 —— 都不影响网页本身 */ }
}

function setTheme(theme) {
  S.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* 隐私模式下写不了就算了 */ }
  applyTheme();
  openSettings('prefs');
}

// 跟随系统时，系统切了也要跟着切
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (S.theme === 'system') applyTheme();
});

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * 轻量 markdown 渲染（2026-10-21，员工详情「职责与身份设定」预览用，站内可复用）。
 *
 * 防注入口径：**先对原文整体 esc 再解析标记** —— 生成的所有标签都是自己拼的，
 * 原文里夹带的 <script> 之类已变成字面量，不存在绕路的口子。
 * 支持子集：围栏代码块、行内代码、标题（#~####）、无序/有序列表（含**松散列表**：项间空行
 * 仍接着编号；含**缩进续行**：列表项第二行顶格缩进，归上一项）、引用、加粗、斜体。
 * 不认识的东西原样显示：不报错、不吞字（写人设/职责说明够用，不求全）。
 */
const mdRender = (src) => {
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
  for (const raw of lines) {
    if (code !== null) {                       // 围栏内：原样收（已 esc 过），直到闭合
      if (/^```/.test(raw.trim())) { out.push(`<pre><code>${code.join('\n')}</code></pre>`); code = null; }
      else code.push(raw);
      continue;
    }
    const line = raw.trim();
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
const TOAST_KEEP = { error: 5000, ok: 2600, info: 3500 };
function toast(msg, kind = 'info') {
  const text = String(msg ?? '').trim();
  if (!text) return;
  if (kind === 'error') console.error(text);

  let wrap = document.getElementById('toastWrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'toastWrap';
    wrap.className = 'toast-wrap';
    document.body.appendChild(wrap);
  }
  // 多于 4 条：先把最旧的赶走（连着失败十次不该糊一屏）
  while (wrap.children.length >= 4) wrap.firstElementChild?.remove();

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
  start();
}


/*
 * 岗位（2026-10-17）：这人在团队里**是什么**，跟"他会干什么"（技能）是两件事。
 *   · 一个值、可空、自由文本（表单给建议列表，不锁枚举 —— 组织会变）；
 *   · 用在看人、看板、**人工指派时辨认**这几处；
 *   · **引擎不读它** —— 派活仍只认流程节点上点的名（见 workflows.assigneeFor）。
 * 这里只放"怎么显示/怎么拼标签"两件小事，判断逻辑一律在服务端。
 */
const ROLE_SUGGEST = ['产品', '研发', '测试', '运维', '架构', '设计', '项目'];

// 建议列表只此一份：填进 #roleSuggest（新建对话框与员工详情共用一个 datalist）
{
  const dl = document.getElementById('roleSuggest');
  if (dl) dl.innerHTML = ROLE_SUGGEST.map((r) => `<option value="${esc(r)}"></option>`).join('');
}

/** 人员下拉里的标签：有岗位就 `研发 · 波哥`，没岗位就只有名字 */
const personLabel = (p) => (p.role ? `${p.role} · ${p.name}` : p.name);

/** 通讯录那一行的副标题：有岗位显示岗位，没岗位退回运行时（sandbox 是技术细节，只在详情里） */
// auto（内置秘书在用）是人类不该背的词，翻成「自动」；别处的 runtime id 照原样显示
const personSubtitle = (p) => {
  const rt = p.runtime === 'auto' ? '自动' : String(p.runtime ?? '');
  return p.role ? `${p.role} · ${rt}` : rt;
};

/* ------------------------------------------------------------ 对话框通用件 */

/**
 * 对话框的顶部：标题 + 右上角 ×，**吸顶不跟着滚**。
 *
 * 在这儿统一包，而不是在十几个 <dialog> 里各写一遍 —— 以后新加对话框不会再漏。
 * 标题的 <b> 是"搬进"头部的（同一个元素，id 和文案都由原逻辑照旧更新）。
 * × 的 type 必须是 button：submit 会顶掉「在输入框里回车＝点确定」。
 *
 * ⚠️ 抽成函数是因为**动态建出来的对话框吃不到**：原来这几行只在页面加载时对
 * `dialog > form` 跑一遍，而项目 / 任务 / 选目录那三个是 createElement('dialog')
 * 现建的 —— 它们一直没有 ×（用户实报："这个弹窗为什么没有关闭按钮"）。
 * 现在静态的照旧一次跑完，动态的建完调一次这个函数。
 */
function wireDialogHead(form) {
  if (!form || form.querySelector(':scope > .dlg-head')) return; // 别包两遍
  const head = document.createElement('div');
  head.className = 'dlg-head';

  const title = form.querySelector(':scope > b');
  if (title) head.append(title);

  const dlg = form.closest('dialog');

  // 带 data-max 的弹窗加一个全屏按钮（对话面板要长时间看，占满屏舒服）
  if (dlg?.hasAttribute('data-max')) {
    const max = document.createElement('button');
    max.type = 'button';
    max.className = 'dlg-close dlg-max';
    const ICON = {
      on: '<path d="M4 9V4h5M20 15v5h-5M15 4h5v5M9 20H4v-5"/>',
      off: '<path d="M9 4v5H4M15 20v-5h5M20 9h-5V4M4 15h5v5"/>',
    };
    const paint = () => {
      const on = dlg.classList.contains('full');
      max.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linecap="round">${on ? ICON.off : ICON.on}</svg>`;
      max.title = on ? '收起' : '展开成抽屉';
    };
    max.onclick = () => {
      dlg.classList.toggle('full');
      paint();
    };
    paint();
    head.append(max);
  }

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dlg-close';
  btn.textContent = '×';
  btn.title = '关闭';
  btn.setAttribute('aria-label', '关闭');
  btn.onclick = () => form.closest('dialog')?.close();
  head.append(btn);

  form.prepend(head);
}

// 静态那些（index.html 里写死的 12 个）在加载时一次包完
document.querySelectorAll('dialog > form').forEach(wireDialogHead);

/* ------------------------------------------------- 标题旁的「?」说明（2026-10-17） */

/** 帮助图标：一个圈里一个问号（跟 ICON_CHAT 那批同一套画法，只填路径不填色） */
const ICON_HELP =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.6"/><path d="M9.6 9.4a2.4 2.4 0 1 1 3.3 2.2c-.7.3-1 .9-1 1.6v.4"/><path d="M12 16.6h.01"/></svg>';

/**
 * 「＋ 添加仓库」拉出来的两个选项用的图标（2026-10-17）。
 * 一个是**本机已有的目录**（手填路径，不联网），一个是**从 GitHub 上挑**（要令牌）。
 * 画法跟 ICON_CHAT 那批一致：只填路径、描边用 currentColor。
 */
const ICON_FOLDER =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7.5A1.5 1.5 0 0 1 5.5 6h3.2l1.8 2.2h7A1.5 1.5 0 0 1 19 9.7v7.8A1.5 1.5 0 0 1 17.5 19h-12A1.5 1.5 0 0 1 4 17.5z"/></svg>';
const ICON_CLOUD =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17.5a4 4 0 0 1 .5-8 5.5 5.5 0 0 1 10.4 1.2A3.6 3.6 0 0 1 17.5 17.5z"/><path d="M12 13.5v5M9.8 15.7 12 18l2.2-2.3"/></svg>';

/**
 * 定时任务卡片右上角的三颗动作图标（2026-10-20 用户："这三个改成图标按钮"）。
 * 原来「立即执行 / 编辑 / 删除」是三个带边框的文字按钮，一行三块字比任务名还重；
 * 换成图标后卡面安静了，动词靠 `title` + `aria-label` 兜住 —— 所以两个都不能省。
 * 画法跟 ICON_HELP / ICON_FOLDER 同一套：只填路径，描边用 currentColor。
 */
const ICON_PLAY =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8.2 5.7 18.4 12 8.2 18.3z"/></svg>';
const ICON_EDIT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 4.2a2.05 2.05 0 0 1 2.9 2.9l-8.8 8.8-3.9.9.9-3.9z"/><path d="M14.4 6.3l3.3 3.3"/></svg>';
const ICON_TRASH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4.6 7h14.8"/><path d="M9.6 7V5.3A1.3 1.3 0 0 1 10.9 4h2.2a1.3 1.3 0 0 1 1.3 1.3V7"/><path d="M6.7 7l.7 11.2A1.7 1.7 0 0 0 9.1 20h5.8a1.7 1.7 0 0 0 1.7-1.8L17.3 7"/><path d="M10.4 10.8v5.4M13.6 10.8v5.4"/></svg>';

/**
 * 工作台磁贴的图标（2026-10-20 重设计）：原来磁贴上是一个"单字色块"（项/板/时/编/流），
 * 撑不起 40px 的图标位，看着像没画完。换成跟全站一套的线性 SVG。
 * 画法同上：只填路径、描边 currentColor，颜色由 .wb-ico 的渐变底给。
 */
const ICON_WB_BOARD =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9.2 4.5v15M14.8 4.5v15"/></svg>';
const ICON_WB_CLOCK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.2"/><path d="M12 7.5V12l3 2.2"/></svg>';
const ICON_WB_FLOW =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4" width="5.4" height="5.4" rx="1.4"/><rect x="15.1" y="4" width="5.4" height="5.4" rx="1.4"/><rect x="9.3" y="14.6" width="5.4" height="5.4" rx="1.4"/><path d="M6.2 9.4v2.1h11.6V9.4M12 11.5v3.1"/></svg>';

/**
 * 给一颗「?」按钮挂一段说明：点开，再点 / 点别处 / Esc 收起。
 *
 * 为什么不做成 `title` 悬浮（全站小说明都走 title）：这段是**分步骤的操作流**——
 * 三行、带加粗、还带一个外链，鼠标一移开就没了，照着做一半就没得看了。
 * 也不做成 `<dialog>`：那是"要你表态"的分量，读一段说明犯不上盖住整页。
 *
 * 说明的 HTML 由调用方给（已经 `esc()` 过的内容，或带 `<b>` 的常量文案）。
 * 同时只开一个；收起/换页时的清理走 `close()`，所以重绘不会攒下旧监听器。
 */
let helpPop = null; // { btn, pop } —— 现在开着的那一个

function closeHelpPop() {
  if (!helpPop) return;
  const { btn, pop } = helpPop;
  helpPop = null;
  pop.classList.add('is-hidden');
  btn.classList.remove('on');
  btn.setAttribute('aria-expanded', 'false');
}

// 点别处 / Esc 一律收起。只装一次（不是每挂一颗「?」装一遍 —— 那会在重绘时攒下一堆）。
document.addEventListener('click', closeHelpPop);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeHelpPop();
});

function wireHelpPop(btn, html) {
  const wrap = document.createElement('span');
  wrap.className = 'help-wrap';
  btn.after(wrap);
  wrap.append(btn);

  const pop = document.createElement('div');
  pop.className = 'help-pop is-hidden';
  pop.innerHTML = html;
  wrap.append(pop);
  // 点弹出层里面不收（里面可能有可点的链接）
  pop.addEventListener('click', (e) => e.stopPropagation());

  btn.setAttribute('aria-expanded', 'false');
  btn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation(); // 别顺着冒泡把整个设置节再点一遍
    const willOpen = helpPop?.btn !== btn;
    closeHelpPop();
    if (!willOpen) return;
    pop.classList.remove('is-hidden');
    btn.classList.add('on');
    btn.setAttribute('aria-expanded', 'true');
    // 贴右边缘时把弹出层往左拽，别探出视口（跟 .add-menu 同一个顾虑）
    const r = pop.getBoundingClientRect();
    const over = r.right - (window.innerWidth - 12);
    pop.style.left = over > 0 ? `${-over}px` : '';
    helpPop = { btn, pop };
  };
}

/* ------------------------------------------------- 悬浮提示（自建 data-tip） */

/**
 * 为什么不用原生 `title`：那个框是浏览器/系统画的 —— 方角、灰底、悬停一秒才出、样式一概改不了。
 * 用户要圆角只能自己画一个。用法：`data-tip="文案"`，读屏仍走 `aria-label`
 * （**两个别同时写**：留着 title 就会先冒原生框、再冒我们的，等于两个提示）。
 *
 * 单例 `#tipPop`，位置现算：默认在元素**上方**，上面塞不下就翻到下面；左右贴视口边时往回收。
 * 事件用**一个 document 委托**装一次 —— 卡片是整页重绘的，逐个挂监听必漏（见 CRUMB_GO 那条同理）。
 * 悬停等 100ms 再出：一排图标扫过去时不然会闪一片。
 */
let tipTimer = 0;
let tipAnchor = null; // 现在这条提示挂在谁身上（同一个元素重复进入不重算）

function hideTip() {
  clearTimeout(tipTimer);
  tipAnchor = null;
  const p = $('tipPop');
  if (!p) return;
  p.classList.remove('on');
  p.hidden = true;
}

function showTip(el) {
  const p = $('tipPop');
  const text = el?.dataset?.tip;
  if (!p || !text || !el.isConnected) return;
  p.textContent = text;
  p.hidden = false;
  p.classList.add('on'); // 先露出来才量得到尺寸（hidden 时 getBoundingClientRect 全是 0）
  const r = el.getBoundingClientRect();
  const b = p.getBoundingClientRect();
  const gap = 8;
  let top = r.top - b.height - gap;
  if (top < 8) top = r.bottom + gap; // 上方放不下 → 翻到下面
  // 左右贴边就往回收，别探出视口（跟 .help-pop 那个顾虑同一个）
  const left = Math.max(8, Math.min(r.left + r.width / 2 - b.width / 2, window.innerWidth - b.width - 8));
  p.style.top = `${Math.round(top)}px`;
  p.style.left = `${Math.round(left)}px`;
}

document.addEventListener('mouseover', (e) => {
  const el = e.target.closest?.('[data-tip]');
  if (!el || el === tipAnchor) return;
  hideTip();
  tipAnchor = el;
  tipTimer = setTimeout(() => showTip(el), 100);
});
document.addEventListener('mouseout', (e) => {
  const el = e.target.closest?.('[data-tip]');
  if (!el) return;
  if (e.relatedTarget && el.contains(e.relatedTarget)) return; // 在元素内部挪不算离开
  hideTip();
});
// 键盘用户走焦点：立刻出，不等那 100ms
document.addEventListener('focusin', (e) => {
  const el = e.target.closest?.('[data-tip]');
  if (!el) return;
  hideTip();
  tipAnchor = el;
  showTip(el);
});
document.addEventListener('focusout', hideTip);
/* 滚动 / 换页 / 点下去一律立刻收起：提示是 fixed 定位、不会跟着元素走，
   留着它就是一条对不上位置、还指着别处按钮的假信息。 */
window.addEventListener('scroll', hideTip, true);
document.addEventListener('click', hideTip);

/* ------------------------------------------------- 自建下拉（全站公共组件） */

/**
 * 原生 <select> 的弹出层是浏览器画的：高度不可控、也塞不进搜索框。
 * 所以全站统一用这个组件 —— **选项多的传 search: true，选项少的不用传**，两态同源。
 *
 *   const c = createCombo({
 *     mount,                                   挂到哪个元素（会把它的内容清空）
 *     items: [{ id, label }],                  选项
 *     value: '',                               当前值
 *     search: false,                           要不要搜索框
 *     empty: '没有可选项',                     无匹配时的文案
 *     onChange: (id) => {},                    选中时回调
 *   });
 *   c.value() / c.setValue(id) / c.setItems(items) / c.close()
 *
 * 同时只允许开一个（点开第二个会把第一个收起）；点组件外面统一收起。
 */
let openCombo = null;

function createCombo({
  mount,
  items = [],
  value = '',
  search = false,
  empty = '没有可选项',
  placeholder = '搜…',
  // 「没选任何一项」时按钮上写什么。默认空串（跟以前一样：什么都没选就什么都不显示）。
  // 有场景需要一个说法，比如任务卡里"这一步还没人办"要写成「没人」而不是一片空白。
  blank = '',
  // 按钮上显示什么，参数是当前值。给了就**整体接管按钮文案**（清单里还照 label 显示）——
  // 给"按钮要写实际生效的值，清单里另有条目名分"的场景用（如权限下拉：按钮写实际的
  // 权限名，清单里「跟随员工默认」当收回提权的入口）。
  buttonText = null,
  onChange = () => {},
  // 展开下拉时的回调 —— 给"点开才去取清单"用。
  // 比如模型列表要读运行时的配置（dsh 那条是一次 HTTP），不适合在打开页面时就拉。
  onOpen = null,
  // 浮层**右缘**要对齐到哪个元素的右缘（元素或返回元素的函数）。
  // 配合 `.right` 用：`.right` 只把浮层贴到按钮自己的右缘；贴着窗口右边的下拉
  // （输入区那颗模型框，右边还隔着发送按钮）需要的是对齐到**整个输入框**的右缘。
  alignRightTo = null,
  // 浮层改成**右对齐**：贴到按钮自己的右缘、往左边展开。
  // 给"按钮本身就在页面右边"的下拉用（流程实例页那枚状态下拉：原来左对齐展开会顶出视口，
  // 用户 2026-10-17 实报）。等价于手动给根节点加 `.right`，这里做成选项免得每处都记得加。
  right = false,
}) {
  const root = document.createElement('div');
  root.className = 'combo';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'combo-btn';
  const text = document.createElement('span');
  text.className = 'combo-text';
  const chev = document.createElement('i');
  chev.className = 'combo-chev';
  btn.append(text, chev);

  const pop = document.createElement('div');
  pop.className = 'combo-pop is-hidden';
  let input = null;
  if (search) {
    input = document.createElement('input');
    input.className = 'combo-search';
    input.placeholder = placeholder;
    input.spellcheck = false;
    pop.append(input);
  }
  const list = document.createElement('div');
  list.className = 'combo-list';
  list.setAttribute('role', 'listbox');
  pop.append(list);
  root.append(btn, pop);
  if (right) root.classList.add('right');

  mount.innerHTML = '';
  mount.append(root);

  let all = items;
  let current = value;
  let hi = 0;

  const labelOf = (id) => (all.find((it) => it.id === id) ?? {}).label ?? String(id ?? '');
  const shown = () =>
    buttonText ? buttonText(current) : labelOf(current) || String(current ?? '') || blank;

  const pick = (id) => {
    current = id;
    text.textContent = shown();
    close();
    onChange(id);
  };

  const paint = (query = '') => {
    const q = query.trim().toLowerCase();
    // `it.id` 可能是 undefined（小标题那种条目），所以一律 String() 一下再比
    const hit = (it) =>
      !q ||
      String(it.id ?? '').toLowerCase().includes(q) ||
      String(it.label ?? '').toLowerCase().includes(q);
    let hits = all.filter(hit);
    /*
     * 小标题（`{ header: 'xxx' }`：没有 id、不可选）只在**没搜索**时显示。
     * 搜索时留着会把结果切成一堆空标题，反而更难读。
     */
    if (q) hits = hits.filter((it) => it.header === undefined);
    // hi 只数**可选项** —— 键盘上下不能停在标题上（那是死路）
    const pickable = hits.filter((it) => it.header === undefined);
    if (hi >= pickable.length) hi = Math.max(0, pickable.length - 1);

    let pi = -1;
    // 选中项用右侧的 ✓ 表示（不用底色，底色留给"键盘/鼠标当前停在哪一项"）
    list.innerHTML = hits.length
      ? hits
          .map((it) => {
            if (it.header !== undefined) return `<div class="combo-group">${esc(it.header)}</div>`;
            pi += 1;
            return `<div class="combo-item ${pi === hi ? 'hi' : ''}" data-pick="${esc(it.id)}">
                 <span class="combo-item-label">${esc(it.label)}</span>
                 ${it.id === current ? '<span class="combo-check">✓</span>' : ''}
               </div>`;
          })
          .join('')
      : `<div class="combo-empty">${esc(empty)}</div>`;
    list.querySelectorAll('[data-pick]').forEach((el) => { el.onclick = () => pick(el.dataset.pick); });
  };

  const close = () => {
    pop.classList.add('is-hidden');
    if (openCombo === api) openCombo = null;
  };
  const open = () => {
    if (openCombo && openCombo !== api) openCombo.close();
    openCombo = api;
    if (input) input.value = '';
    hi = -1; // 打开时不停靠任何项：底色只留给"鼠标悬停 / 按方向键"，选中由右侧 ✓ 表示
    paint('');
    pop.classList.remove('is-hidden');
    // 右缘对齐到指定元素：在按钮自身右缘（.right）的基础上再往外挪 —— 挪多少每次
    // 打开都现算（发送/停止按钮会换字，宽度不稳）。同时别探出视口。
    if (alignRightTo) {
      const ar = (typeof alignRightTo === 'function' ? alignRightTo() : alignRightTo)?.getBoundingClientRect();
      const rr = root.getBoundingClientRect();
      if (ar && rr) {
        const shift = ar.right - rr.right;
        pop.style.right = `${-Math.max(0, Math.min(shift, window.innerWidth - 14 - rr.right))}px`;
      }
    }
    if (input) input.focus();
    // 放在最后：让回调能直接 setItems（setItems 看到面板已展开会自己重画）
    onOpen?.();
  };

  btn.onclick = () => (pop.classList.contains('is-hidden') ? open() : close());
  if (input) {
    input.addEventListener('input', () => { hi = -1; paint(input.value); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') return close();
      const hits = list.querySelectorAll('[data-pick]');
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!hits.length) return;
        hi = hi < 0
          ? (e.key === 'ArrowDown' ? 0 : hits.length - 1)
          : (hi + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length;
        paint(input.value);
        list.querySelector('.hi')?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const hit = list.querySelector('.hi') ?? hits[0];
        if (hit) pick(hit.dataset.pick);
      }
    });
  }

  const api = {
    el: root,
    value: () => current,
    setValue(id) { current = id; text.textContent = shown(); },
    setItems(next, keepValue = true) {
      all = next;
      if (!keepValue) current = '';
      text.textContent = shown();
      if (!pop.classList.contains('is-hidden')) paint(input ? input.value : '');
    },
    close,
  };
  text.textContent = shown();
  return api;
}

/**
 * 自建日期时间选择（定时任务「单次」那颗）。
 *
 * 为什么不用原生 `datetime-local`：那个日历是**浏览器画的** —— 位置一概改不了，
 * 想右对齐、想让它待在弹窗里都办不到（2026-10-20 用户实报：它跑到了弹窗外面）。
 * 跟原生 title 提示框换自绘是同一个病、同一个治法。
 *
 * 结构照全站 `.combo` 的路数：按钮 + 浮层，根节点也挂 `.combo`
 * （点外面收起那条委托认的就是这个类，`openCombo` 的"同时只开一个"也跟着生效）。
 * 浮层加 `.up.right`：这颗在弹窗右下角，往下开会顶出底边、往左对齐会探出右边。
 *
 * 用法：createDateTimePick({ mount, value, onChange })
 *   value() 返回 `YYYY-MM-DDTHH:MM`（没选就是 ''）—— 跟 datetime-local 的取值同格式。
 */
function createDateTimePick({ mount, value = '', onChange = () => {} }) {
  const root = document.createElement('div');
  root.className = 'combo dt';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'combo-btn';
  const text = document.createElement('span');
  text.className = 'combo-text';
  btn.append(text, Object.assign(document.createElement('i'), { className: 'combo-chev' }));
  const pop = document.createElement('div');
  pop.className = 'combo-pop dt-pop is-hidden';
  root.append(btn, pop);
  mount.innerHTML = '';
  mount.append(root);

  const pad = (n) => String(n).padStart(2, '0');
  // cur = 已选值；null = 还没选（按钮上写「选个时间」）
  let cur = null;
  let view = { y: 0, m: 1 }; // 日历正在看的月份（跟已选值分开：翻页不等于改值）
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    const d = new Date(value);
    cur = { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), hh: d.getHours(), mm: d.getMinutes() };
  }

  const fmt = () => (cur ? `${cur.y}-${pad(cur.m)}-${pad(cur.d)} ${pad(cur.hh)}:${pad(cur.mm)}` : '选个时间');
  const iso = () => (cur ? `${cur.y}-${pad(cur.m)}-${pad(cur.d)}T${pad(cur.hh)}:${pad(cur.mm)}` : '');
  const set = (patch) => {
    cur = { ...(cur ?? { hh: 9, mm: 0 }), ...patch };
    text.textContent = fmt();
    onChange(iso());
  };

  const close = () => {
    pop.classList.add('is-hidden');
    if (openCombo === api) openCombo = null;
  };
  const open = () => {
    if (openCombo && openCombo !== api) openCombo.close();
    openCombo = api;
    const base = cur ?? (() => { const n = new Date(); return { y: n.getFullYear(), m: n.getMonth() + 1 }; })();
    view = { y: base.y, m: base.m };
    paint();
    pop.classList.remove('is-hidden');
    // 浮层高（日历 5~6 行），`.up` 往上开也可能顶出弹窗顶 —— 量一把，超界就整体下移，
    // 宁可盖住按钮也不出弹窗（用户要的底线就是"别跑出去"）。每次打开都重算，弹窗大小会变。
    pop.style.transform = '';
    const dlgR = root.closest('dialog')?.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    if (dlgR && pr.top < dlgR.top + 8) pop.style.transform = `translateY(${Math.round(dlgR.top + 8 - pr.top)}px)`;
  };
  btn.onclick = () => (pop.classList.contains('is-hidden') ? open() : close());

  const paint = () => {
    const first = new Date(view.y, view.m - 1, 1);
    const lead = (first.getDay() + 6) % 7; // 表头周一起头（跟国内习惯一致）
    const days = new Date(view.y, view.m, 0).getDate();
    const prevDays = new Date(view.y, view.m - 1, 0).getDate();
    const now = new Date();
    const isToday = (d) => now.getFullYear() === view.y && now.getMonth() + 1 === view.m && now.getDate() === d;
    let cells = '';
    for (let i = lead - 1; i >= 0; i -= 1) cells += `<span class="dt-day out">${prevDays - i}</span>`;
    for (let d = 1; d <= days; d += 1) {
      const on = cur && cur.y === view.y && cur.m === view.m && cur.d === d;
      cells += `<button type="button" class="dt-day ${on ? 'on' : isToday(d) ? 'today' : ''}" data-d="${d}">${d}</button>`;
    }
    const tail = (7 - ((lead + days) % 7)) % 7; // 尾部补齐整周，日历高度不跳动
    for (let i = 1; i <= tail; i += 1) cells += `<span class="dt-day out">${i}</span>`;

    const opt = (n, sel) => `<option value="${n}" ${n === sel ? 'selected' : ''}>${pad(n)}</option>`;
    const hours = Array.from({ length: 24 }, (_, i) => opt(i, cur?.hh ?? 9)).join('');
    const mins = Array.from({ length: 60 }, (_, i) => opt(i, cur?.mm ?? 0)).join('');

    pop.innerHTML = `
      <div class="dt-head">
        <button type="button" class="dt-nav" data-nav="-1" aria-label="上个月">‹</button>
        <span class="dt-title">${view.y} 年 ${view.m} 月</span>
        <button type="button" class="dt-nav" data-nav="1" aria-label="下个月">›</button>
      </div>
      <div class="dt-week">${'一二三四五六日'.split('').map((c) => `<span>${c}</span>`).join('')}</div>
      <div class="dt-grid">${cells}</div>
      <div class="dt-time">
        <select aria-label="时">${hours}</select>
        <span class="dt-colon">:</span>
        <select aria-label="分">${mins}</select>
      </div>
      <div class="dt-foot">
        <button type="button" class="dt-clear">清除</button>
        <button type="button" class="dt-today">今天</button>
      </div>`;

    pop.querySelectorAll('[data-nav]').forEach((b) => {
      b.onclick = () => {
        const d = new Date(view.y, view.m - 1 + Number(b.dataset.nav), 1); // 越年/越月交给 Date 自己进位
        view = { y: d.getFullYear(), m: d.getMonth() + 1 };
        paint();
      };
    });
    pop.querySelectorAll('[data-d]').forEach((b) => {
      b.onclick = () => set({ y: view.y, m: view.m, d: Number(b.dataset.d) });
    });
    const [hSel, mSel] = pop.querySelectorAll('.dt-time select');
    hSel.onchange = () => set({ hh: Number(hSel.value) });
    mSel.onchange = () => set({ mm: Number(mSel.value) });
    pop.querySelector('.dt-clear').onclick = () => { cur = null; text.textContent = fmt(); onChange(iso()); paint(); };
    pop.querySelector('.dt-today').onclick = () => {
      const n = new Date();
      set({ y: n.getFullYear(), m: n.getMonth() + 1, d: n.getDate() });
      view = { y: cur.y, m: cur.m };
      paint();
    };
  };

  const api = { el: root, value: iso, close };
  text.textContent = fmt();
  return api;
}

/**
 * 「取消」这一类按钮：**只负责关弹窗，不是提交**。
 *
 * 为什么必须显式标 `type="button"`（index.html 里那十几处都标了）：
 * 它排在动作区第一个，而 `<form>` 的"隐式提交"（在输入框里按回车）挑的是
 * **树序第一颗提交按钮** —— 不标 type 它就是那颗，于是粘完 API Key 顺手敲回车
 * 走的是「取消」：弹窗直接关掉、一个请求都不发，看着就是"保存不了"（2026-10-15 实测）。
 * 标了 type="button" 它退出提交按钮的行列，回车才会落到「保存」上。
 *
 * 代价是它不再自动关弹窗（`method="dialog"` 只对提交按钮生效），所以在这里补上。
 * 放在 document 上只挂一次：弹窗是随时重建的，逐个绑定既啰嗦又会漏。
 */
document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[type="button"][value="cancel"]');
  const dlg = btn?.closest('dialog');
  if (!dlg) return;
  e.preventDefault();
  dlg.close('cancel');
});

// 点组件外面收起（只挂一次，组件本身是随时重建的）
document.addEventListener('click', (e) => {
  if (openCombo && !e.target.closest('.combo')) openCombo.close();
});
/** 跑着的时候，顶部不显示枚举值「跑中」，显示成人话 */
const TYPING = '对方正在输入…';

function setHeaderBadge(status, label) {
  const el = $('chatHead').querySelector('.badge');
  if (!el) return;
  el.className = 'badge ' + status;
  el.textContent = label ?? status;
}

/**
 * 极简 Markdown 渲染（零依赖）。
 * 顺序很重要：**先整段转义**，再在已转义文本上做变换 —— 这样注入的 HTML 活不下来。
 * 支持：围栏代码块、标题、粗体/斜体、行内代码、链接（只放 http/https）、
 *       有序/无序列表、引用、分割线。
 */
function renderMarkdown(src) {
  let s = esc(src).replace(/\r\n?/g, '\n');

  // 围栏代码块先摘出来，免得里面的符号被当成 Markdown
  const blocks = [];
  s = s.replace(/```([^\n]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    blocks.push(`<pre><code data-lang="${esc(lang.trim())}">${code.replace(/\n$/, '')}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });

  const inline = (t) => t
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');

  const out = [];
  let list = null;
  let para = [];
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join('<br>'))}</p>`); para = []; } };

  for (const raw of s.split('\n')) {
    const t = raw.trim();

    if (/^\u0000\d+\u0000$/.test(t)) { flushPara(); closeList(); out.push(t); continue; }
    if (!t) { flushPara(); closeList(); continue; }

    const h = /^(#{1,6})\s+(.*)$/.exec(t);
    if (h) { flushPara(); closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flushPara(); closeList(); out.push('<hr>'); continue; }

    const ul = /^[-*+]\s+(.*)$/.exec(t);
    if (ul) {
      flushPara();
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }

    const ol = /^\d+[.)]\s+(.*)$/.exec(t);
    if (ol) {
      flushPara();
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }

    const bq = /^&gt;\s?(.*)$/.exec(t);
    if (bq) { flushPara(); closeList(); out.push(`<blockquote>${inline(bq[1])}</blockquote>`); continue; }

    para.push(t);
  }
  flushPara();
  closeList();

  return out.join('\n').replace(/\u0000(\d+)\u0000/g, (_m, i) => blocks[Number(i)]);
}
const initial = (s) => (String(s || '?').trim()[0] || '?').toUpperCase();

/*
 * 运行时 / 外部件的品牌图标（2026-10-20，用户截图报「图标显示看不清」）。
 *
 * 为什么不再用首字母：Codex CLI 与 Claude Code 都是「C」，两个方块长得一模一样，
 * 图标没起到"一眼认出是哪家"的作用；深蓝渐变上的小字母本身也糊。
 * 现在：认识的牌子给**品牌图形**（Simple Icons 的单色 path，CC0 许可，24×24；
 * magpie 没有公开品牌标，用一枚自绘的喜鹊剪影）。认不出的牌子才退回首字母。
 *
 * **这里只管形状，颜色一律不在这里**（2026-10-20 收口）：底色/字色是 style.css 里
 * `--tile-*` 的一对 token，按 `data-brand` 命中，浅深两套主题各有一组值。
 * 上一版把浅色调内联写在这儿，切到深色主题就成了一排亮块 —— 别再内联颜色。
 */
const CLI_BRANDS = {
  codex:  { svg: '<path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/>' },
  claude: { svg: '<path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/>' },
  dsh:    { svg: '<path d="M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45"/>' },
  magpie: { svg: '<path fill-rule="evenodd" d="M15.7 4.1a3.3 3.3 0 0 0-3.25 2.77c-2.2.55-4.05 2-5.2 4.02-.9 1.58-2.2 2.95-3.8 4.03-.52.35-.95 1-1.15 1.72-.14.53.4 1 .9.79 2.05-.8 3.5-.5 4.75.3 1.45.93 3.02 1.31 4.75.94 3.55-.78 5.95-3.85 5.95-7.55v-1.4l2.05-.92c.58-.26.6-1.08.03-1.37l-2.28-1.1A3.3 3.3 0 0 0 15.7 4.1Zm.85 2.3a1.05 1.05 0 1 1 0 2.1 1.05 1.05 0 0 1 0-2.1Z"/>' },
};

/** 运行时 / 外部件那一行的图标：kind 是协议族 id（runtimes.mjs 的 FAMILIES）或外部件 id（externals.mjs 的 EXTERNALS）；
    认不出的退回首字母块 —— 后面新加 CLI 时先把 id 登记进 CLI_BRANDS，界面就自动带图标。 */
function cliAvatar(kind, label) {
  const b = CLI_BRANDS[kind];
  if (!b) return `<div class="avatar cli">${esc(initial(label))}</div>`;
  return `<div class="avatar cli" data-brand="${esc(kind)}" title="${esc(label ?? '')}"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${b.svg}</svg></div>`;
}

/**
 * 头像的内联配色（Linear 语汇，2026-10-19）。
 *
 * 为什么不再"所有人同一个灰"：Linear 的注释头像会用一小组固定的低饱和色按人分配。
 * 一开始我把它统一成 `--chip` 灰底，截图一看通讯录里 7 行头像**全一样**，
 * 眼睛完全没有落点、认人只能逐行读字 —— 这是把 Linear 的"克制"做成了"无信息"。
 *
 * 做法：一组**低饱和**色相（不是高饱和的彩色圆），按名字哈希稳定分配 ——
 * 同一个人永远同色，换机器/刷新也不变（跟工作台磁贴的"顺序发色"不同：
 * 人是有稳定身份的，颜色跟着人走才对）。
 * 明度取 26%：白字压上去 ≥ 4.5（这批色相里最亮的那个也过线）。
 */
const AV_HUES = [210, 262, 190, 330, 292, 172, 240, 315];
function avatarStyle(name) {
  const s = String(name || '?');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 9973;
  const hue = AV_HUES[h % AV_HUES.length];
  return `style="background:hsl(${hue} 34% 26%);border-color:transparent;color:#fff"`;
}

/**
 * 小头像（对话行 / 群设置 / 任务评论）：三档底色里按名字稳定挑一档。
 *
 * 为什么不再靠 `--av-dim` 那组深靛蓝渐变：字是 `--dim`（灰蓝）压在深靛蓝上，
 * 用户直接截图报「看不清字」—— 字和底色同一色系，本来就糊。
 * 现在三档底色 + 近白字（--av-sm-fg），名字本身已经不承担"区分身份"的职责，
 * 只负责让眼睛有个落点、不同的人不是一模一样。
 * 我自己那行（me）走灰底 + --text 字，靠气泡右侧对齐和位置区分，不额外上色。
 */
const AV_TONES = [1, 2, 3, 4];
function smAvatar(name, extra = '', persona = null) {
  const s = String(name || '?');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 9973;
  const tone = AV_TONES[h % AV_TONES.length];
  const file = persona?.avatar;
  const img = file && AVATAR_FILE.test(String(file))
    ? `<img class="av-img" src="/avatars/${encodeURIComponent(String(file))}" alt="" onerror="this.remove()">`
    : '';
  return `<div class="avatar sm${extra ? ' ' + extra : ''}" data-tone="${tone}">${esc(initial(s))}${img}</div>`;
}

/*
 * 带图片的员工头像（2026-10-22）：personas.avatar 存**文件名**（图片在 apps/web/avatars/，
 * 现成静态路由服务）。图绝对定位铺在字母头像**上面**，加载失败 `this.remove()` 露出底下的
 * 字母 —— 文件丢了/删了永远不破相，也不用在 JS 里绑 onerror（模板里内联，页面随便重建）。
 * 没配头像的人直接走字母，跟以前一模一样。
 */
const AVATAR_FILE = /^[A-Za-z0-9._-]+\.(png|jpe?g|webp)$/i;
/** 按名字找员工（消息气泡/评论这些只有名字的场景）：找不到返回 null，走字母头像 */
function personaByName(n) {
  const s = String(n ?? '');
  return S.personas.find((p) => p.name === s) ?? null;
}
function personaAvatar(p, extra = '', fallbackName = '') {
  const name = p?.name ?? fallbackName ?? '?';
  const file = p?.avatar;
  const core = `<div class="avatar${extra ? ' ' + extra : ''}" ${avatarStyle(name)}>${esc(initial(name))}`;
  if (file && AVATAR_FILE.test(String(file))) {
    return `${core}<img class="av-img" src="/avatars/${encodeURIComponent(String(file))}" alt="" onerror="this.remove()"></div>`;
  }
  return `${core}</div>`;
}
const hhmm = (iso) => { try { return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
const dt = (iso) => { try { return new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
const cut = (s, n = 34) => (String(s ?? '').replace(/\s+/g, ' ').slice(0, n));

/**
 * 服务端说明压成界面上能看的一行：合并空白、超长截断（带省略号）。
 *
 * 为什么不直接用 `cut`：那个按"列表预览"设计的（34 字、不带省略号），
 * 错误原因往往是一整句（「别名要用汉字、字母或数字开头，可以带点…」），34 字会把关键处切掉。
 * 160 字 ≈ toast 里三行的量，再长就该去控制台看了。
 */
const clipLine = (s, n = 160) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/**
 * 纯文本场景（列表预览这类）把 Markdown 标记去掉 —— 那儿不渲染 HTML，
 * 留着 ** 和反引号就是露给用户看的原始符号。
 */
const plain = (s) =>
  String(s ?? '')
    .replace(/```[\s\S]*?```/g, '［代码］')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1$2')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();

async function api(path, opts) {
  const method = opts?.method ?? 'GET';
  // X-Bandi：写请求的来源守卫要它（详见服务端 guardWrite）。
  // 浏览器的"简单请求"不触发预检，所以光靠 CORS 挡不住借刀写操作 —— 必须有一个自定义头。
  let r;
  try {
    r = await fetch(path, { ...opts, headers: { ...(opts?.headers ?? {}), 'X-Bandi': '1' } });
  } catch (e) {
    /*
     * 网络层失败（服务没在跑 / 连接被拒 / 断了）：fetch 自己抛 TypeError('Failed to fetch')，
     * 一句英文、没有编码、也没说清是哪一步 —— 用户看到只能截图来问。
     * 和 HTTP 错误一样收成「编码：人话」（E0001），细节留在 detail 和控制台。
     */
    const err = new Error('E0001：连不上班底服务（它可能没在运行）');
    err.code = 'E0001';
    err.detail = `${method} ${path} 连接失败：${e?.message ?? e}`;
    err.cause = e;
    console.error(`[班底] E0001 · ${method} ${path}\n  ${err.detail}`);
    throw err;
  }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    /*
     * 错误提示的统一规则（2026-10-21 重设计，取代"一律 E码：服务异常"）。
     *
     * 旧规则本来是不想让用户看技术细节，副作用却是**把能看懂的原因一起藏了**：
     * 别名带空格、地址带了端口，界面只给一句「E1001：服务异常」——
     * 人不知道改哪儿，只能截图来问（用户 2026-10-21 的截图就是这个）。
     *
     * 新规则按 HTTP 状态码分两类，判据明确、不靠解析文案：
     *   · **4xx = 用户/调用方能改的**：服务端的 `error` 字段本来就是写给用户看的中文
     *     （「地址不要带端口，端口填在下面那一格。」），直接拼进界面。
     *   · **5xx / 没有说明 = 系统内部出错**：用户改不了，只说「编码：服务异常」，
     *     原文只进 `err.detail` 与控制台。
     * 两类都保留**未截断**的 `err.detail`（console 与悬停用），界面上那份由 `clipLine` 截到 160 字。
     */
    const code = body.code || `E${r.status}`;
    const detail = String(body.error || '').trim();
    const explained = r.status >= 400 && r.status < 500 && !!detail;
    console.error(
      `[班底] ${code}：${explained ? detail : '服务异常'} · ${opts?.method ?? 'GET'} ${path} → HTTP ${r.status}`,
    );
    const err = new Error(explained ? `${code}：${clipLine(detail)}` : `${code}：服务异常`);
    err.code = code;
    err.detail = detail;
    err.status = r.status;
    // 给界面用：这条原因是否已经拼进 message（showFail 据此决定 title 要不要再给一遍）
    err.explained = explained;
    throw err;
  }
  return body;
}
const post = (p, d) => api(p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d ?? {}),
});

/**
 * 把一次失败写进某个**常驻**的元素（提示行、结果框那种，不是弹窗）。
 *
 * `err.message` 现在自带原因（4xx 是服务端原文，5xx 只有「服务异常」），直接印就行。
 * `title` 只在**原因没进正文**（5xx / 网络层）时补一句原文 —— 4xx 已经在正文里，重复给悬停没意义。
 * （弹窗那种一闪而过的提示用 `toast(err.message, 'error')` 就够，控制台里也有全文。）
 */
function showFail(el, err) {
  if (!el) return;
  el.textContent = err?.message ?? '服务异常';
  el.title = err?.explained ? '' : (err?.detail || '');
}

/** 同 `showFail`，但要拼进 HTML 的那种（页面级失败的整块提示） */
const failHtml = (err) =>
  `<span title="${esc(err?.explained ? '' : (err?.detail || ''))}">${esc(err?.message ?? '服务异常')}</span>`;

/* ------------------------------------------------------------------ 状态 */

async function load() {
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
  // 已发布的流程（工作台要显示）。拿不到就当没有，别让整个 load 挂掉
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
let contactsTimer = null;
function syncContactsPoll() {
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

function setNav(nav, opts = {}) {
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
    : nav === 'workflows' ? '流程编排'
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
  else showView('chat');
}

/* ---------------------------------------------------------------- 设置 */

/**
 * 设置左侧那一列分节：左栏列表用这一份（顺序 + 标题 + 副标题）。
 * 左栏顶上**只写模块名「设置」**，当前是哪个分节写在**右边**的页头里 ——
 * 跟消息/通讯录同一个主从布局（左列是导航，右面是当前页）。
 */
const SETTINGS_SECTIONS = [
  ['prefs', '偏好设置', '主题与外观'],
  /* 「这台机器」= 模式页（2026-10-21 用户拍板：与「运行时」合并成一页；同日三改：两档 + 动作按钮）——
     分段控件只有 单机 / 总机；「接入总机…」是动作不是第三档，点了只会展开加入面板。
     「局域网」就是单机⇄总机的切换本体，不再是独立开关；备份独立成「数据管理」分节。 */
  ['runtimes', '这台机器', '模式 · 设备'],
  ['backup', '数据管理', '导入 / 导出本机数据'],
  ['quota', '额度', '每个模型每天最多用多少'],
  ['plugins', '插件', '扩展点'],
  ['skills', '技能', '给数字员工用的能力包'],
  ['code', '代码托管', '连接 GitHub、接入仓库'],
  ['about', '关于', '版本与说明'],
];

function openSettings(section) {
  /* 旧路由兼容：合并前「这台机器」是独立分节 'machine'（保存的位置可能还指着它） */
  if (section === 'machine') section = 'runtimes';
  setRoute('settings', { section: section || S.settingsSection || 'prefs' });
  S.settingsSection = section || 'prefs';
  showView('settings');
  /* 左栏顶上只写「设置」：这一列本身就是设置的分节列表，当前分节是右边的页面标题。
     2026-10-19 用户截图：「这个二级标题应该放在右边」—— 之前写成「设置 › 偏好设置」，
     等于把右边页面的标题挂在左边的列表头上，切换分节时左栏标题跟着跳，列表反而不像导航了。 */
  setListTitle('设置');
  renderList();
  if (S.settingsSection === 'runtimes') return renderRuntimes();
  if (S.settingsSection === 'backup') return renderBackup();
  if (S.settingsSection === 'plugins') return renderPlugins();
  if (S.settingsSection === 'quota') return renderQuota();
  if (S.settingsSection === 'skills') return renderSkillCards();
  if (S.settingsSection === 'code') return renderGitRepos();
  if (S.settingsSection === 'about') return renderAbout();
  if (S.settingsSection !== 'prefs') return;

  const opts = [
    ['light', '浅色'],
    ['dark', '深色'],
    ['system', '跟随系统'],
  ];
  $('settingsView').innerHTML = `
    ${headRow('<b>偏好设置</b>')}
    <div class="detail-body">
      <section class="set-sec">
        <div class="set-head"><b>外观</b><span class="set-tag">仅本设备</span></div>
        <div class="set-box">
          <div class="set-row">
            <span class="set-label">主题</span>
            <div class="seg" id="themeSeg">
              ${opts
                .map(
                  ([v, label]) =>
                    `<button data-theme-opt="${v}" class="${S.theme === v ? 'on' : ''}">${label}</button>`,
                )
                .join('')}
            </div>
          </div>
        </div>
      </section>
    </div>`;

  $('themeSeg').querySelectorAll('[data-theme-opt]').forEach((el) => {
    el.onclick = () => setTheme(el.dataset.themeOpt);
  });
}

/* ---------------------------------------------------------------- 关于 */

/**
 * 「关于」页（2026-10-22 用户要求加进设置菜单）：只回答"这是什么、什么版本、跑在哪"。
 *
 * 数据口径：版本 / 实例 / 机器名全部来自 `/api/hello` —— 它是服务端自己的答案，
 * 界面不写死版本字面量（写死一份，升级时就出现"页面 1.1.0、服务 1.2.0"这种自相矛盾）。
 */
async function renderAbout() {
  $('settingsView').innerHTML = rtLoading('关于');
  let h = null;
  try {
    h = await api('/api/hello');
  } catch { /* 拉不到照常渲染：版本显示 —，别白屏 */ }
  $('settingsView').innerHTML = `
    ${headRow('<b>关于</b>')}
    <div class="detail-body">
      <section class="set-sec">
        <div class="set-box">
          <div class="set-row">
            <span class="set-label">产品</span>
            <div class="machine-data">班底 <span class="sub">自托管的多 agent 协作平台</span></div>
          </div>
          <div class="set-row">
            <span class="set-label">版本</span>
            <div class="machine-data">${h?.version ? esc(`v${h.version}`) : '—'}</div>
          </div>
          <div class="set-row">
            <span class="set-label">这台机器</span>
            <div class="machine-data">${esc(h?.hostname ?? '—')}</div>
          </div>
          <div class="set-row">
            <span class="set-label">实例标识</span>
            <div class="machine-data machine-addr">${esc(h?.instanceId ?? '—')}</div>
          </div>
          <div class="set-row">
            <span class="set-label">服务地址</span>
            <div class="machine-data machine-addr">${esc(location.origin)}</div>
          </div>
        </div>
      </section>
    </div>`;
}

/* ---------------------------------------------------------------- 额度 */

/**
 * 额度：**每个模型**每天最多用多少 token。
 *
 * 为什么按模型不按供应商：贵/便宜的分界线在**模型 id** 上，不在供应商上 ——
 * 本机 codex / dsh 只配了一个供应商（magpie 网关），
 * `group/auto-deepseek-v4-1-flash` 和 `opencode-zen-free/*` 都是它名下的模型。
 * 按供应商设额度 = 给 magpie 设一个数，会把免费的和收费的一起管住。
 *
 * 这一页是**开关**，闸本身在服务端（workflows.startCurrentStep 派活前拦一道）——
 * 所以这里只干三件事：把今天各模型的用量说清楚、让人逐行设上限、把口径写明白。
 *
 * 「已用多少」和「超没超」都来自服务端那一次读数（GET /api/quota），
 * 界面不自己再算一遍 —— 否则会出现"设置页看着没超、派活却被拦下"这种事。
 */
async function renderQuota() {
  S.settingsSection = 'quota';
  $('settingsView').innerHTML = rtLoading('额度');
  let st;
  try {
    st = await api('/api/quota');
  } catch (err) {
    $('settingsView').innerHTML =
      `${headRow('<b>额度</b>')}<div class="empty">${failHtml(err)}</div>`;
    return;
  }
  paintQuota(st);
}

function paintQuota(st) {
  const today = st.today ?? { tokens: 0, runs: 0, tokensText: '0' };
  const rows = st.models ?? [];
  const un = st.unattributed ?? { tokens: 0, runs: 0 };
  // 上限：null / 0 都是"不限制"。输入框留空就是它 —— 不摆一个"0"在里面，
  // 那看着像"配额 0"，跟"不限制"正好是反的。
  const cap = (v) => (v ? String(v) : '');
  const withLimit = rows.filter((r) => r.limitTokens || r.limitRuns).length;

  $('settingsView').innerHTML = `
    ${headRow('<b>额度</b>')}
    <div class="detail-body">
      <section class="set-sec">
        <div class="set-head"><b>今天</b><span class="set-tag">本机时区 00:00 起算</span></div>
        <div class="set-box">
          <div class="set-row">
            <span class="set-label">全部模型合计</span>
            <span>${esc(today.tokensText)}<span class="dim"> · ${today.runs ?? 0} 次运行</span></span>
          </div>
          <div class="set-row">
            <span class="set-label">已经设了上限的模型</span>
            <span>${withLimit} 个<span class="dim"> / 共 ${rows.length} 个</span></span>
          </div>
          ${
            /* 认不出模型的那批**必须单独摆出来**：它们算不进任何模型的额度，
               藏着的话用户会以为"这些用量也在管着"，其实没有。 */
            un.runs
              ? `<div class="set-row">
                   <span class="set-label">认不出模型的</span>
                   <span class="q-warn">${esc(un.tokensText)} · ${un.runs} 次 —— 算不进任何模型的额度</span>
                 </div>`
              : ''
          }
        </div>
        ${
          un.runs
            ? `<div class="hint-line">那 ${un.runs} 次是这次升级之前跑的：那时候还没记"用的是哪个模型"。
                 从现在起新跑的都能认出模型。</div>`
            : ''
        }
      </section>

      <section class="set-sec">
        <div class="set-head"><b>每个模型每天的上限</b><span class="set-tag">留空＝不限制</span></div>
        <div class="set-box">
          <table class="quota-table" id="quotaTable">
            <thead>
              <tr>
                <th>模型</th>
                <th class="qt-r">今天已用</th>
                <th class="qt-r">上限 token</th>
                <th class="qt-r">上限次数</th>
              </tr>
            </thead>
            <tbody>
              ${
                rows.length
                  ? rows
                      .map(
                        (r) => `<tr data-model="${esc(r.id)}">
                          <td class="qt-id">
                            ${esc(r.id)}
                            <div class="qt-sub">${
                              r.over
                                ? `<span class="q-over">${esc(r.over)}</span>`
                                : r.available
                                  ? esc(r.label)
                                  : '<span class="q-warn">现在各运行时里都没有这个模型了（今天还跑过）</span>'
                            }</div>
                          </td>
                          <td class="qt-r ${r.over ? 'q-over' : ''}">${esc(r.usedText)}${
                            r.usedRuns ? `<div class="qt-sub">${r.usedRuns} 次</div>` : ''
                          }</td>
                          <td class="qt-r"><input class="num" data-q="tokens" type="number" min="0"
                            step="1000" placeholder="不限" value="${esc(cap(r.limitTokens))}" /></td>
                          <td class="qt-r"><input class="num" data-q="runs" type="number" min="0"
                            step="1" placeholder="不限" value="${esc(cap(r.limitRuns))}" /></td>
                        </tr>`,
                      )
                      .join('')
                  : '<tr><td colspan="4" class="dim" style="padding:16px">没读到任何模型 —— 各运行时的清单可能都没取到（看上面的提示），或者确实一个都没有。</td></tr>'
              }
            </tbody>
          </table>
          <div class="set-row">
            <span class="set-label"></span>
            <button class="primary" id="qSave">保存</button>
          </div>
        </div>
        <div class="hint-line" id="qMsg"></div>
      </section>

      <section class="set-sec">
        <div class="set-head"><b>这个数字是怎么来的</b></div>
        <div class="set-box">
          <div class="set-note">
            用量 = 每次运行自己报的 <code>totalTokens</code>，按<b>实际用的模型</b>分类加起来
            （员工绑了模型就是它；没绑就是那个 CLI 自己的默认模型）。四条要知道的偏差：<br />
            ① <b>只有约 80% 的运行有用量记录</b>（失败 / 被中途杀的那批没有）——
               所以另配一道<b>次数</b>兜底闸，次数是 100% 准的；<br />
            ② <b>缓存读占大头</b>（一次 12.5 万里，8.5 万是缓存读），按 totalTokens 一刀切会
               <b>高估成本</b> —— 这一版不做分项加权，当趋势看，别当账单；<br />
            ③ <b>归因不到就不拦</b>：认不出模型的运行（上面那一条）算不进任何额度，
               也不会因为额度被拦 —— 拿一个猜出来的模型去拦人比不拦更糟；<br />
            ④ 超了<b>不会静默拒绝派活</b>：那一步会标成「已阻塞」并写清是哪个模型超的，
               在实例页点「继续一次」可以放一步过去。
          </div>
        </div>
      </section>
    </div>`;

  $('qSave').onclick = async () => {
    /*
     * **整表提交**：页面上每一行都发出去，留空 = null = 不限制。
     * 只发填了的那些是不行的 —— 那样"把一个上限清空"跟"这次没动它"长得一样，删不掉。
     */
    const limits = {};
    document.querySelectorAll('#quotaTable tr[data-model]').forEach((tr) => {
      const num = (k) => {
        const raw = tr.querySelector(`[data-q="${k}"]`)?.value.trim() ?? '';
        return raw === '' ? null : Number(raw);
      };
      limits[tr.dataset.model] = { dailyTokens: num('tokens'), dailyRuns: num('runs') };
    });
    $('qSave').disabled = true;
    try {
      const saved = await post('/api/quota', { limits });
      // 存完用服务端返回的那一份重画：顺带把"今天已用"刷成最新的
      paintQuota(saved);
      $('qMsg').textContent = '已保存。';
      $('qMsg').style.color = 'var(--ok)';
    } catch (err) {
      showFail($('qMsg'), err);
      $('qMsg').style.color = 'var(--bad)';
      $('qSave').disabled = false;
    }
  };
}

/* ---------------------------------------------------------------- 插件 */

/**
 * 三个页签：
 * · 公开 —— 随仓库走的推荐清单（apps/server/catalog/connectors.json）。不是市场，是一份"能装什么"的清单；
 * · 已安装 —— 账本（data/connectors.json）：启停、实探、改、卸载；
 * · 个人 —— 本机来源的（source.kind === 'local'）+ 手工粘一条。
 *
 * 装一条 = 把清单条目落成账本里的一行，班底只**接线**：代码在 codex / dsh 自己的进程里跑。
 */
const PLG_TABS = [
  ['installed', '已安装'],
  ['panels', '界面插件'],
  ['catalog', '公开'],
  ['personal', '个人'],
];

const isPersonalCat = (c) => c.category === '个人';
const publicCatalog = () => S.catalog.filter((c) => !isPersonalCat(c));
const personalCatalog = () => S.catalog.filter(isPersonalCat);
const localConnectors = () => S.connectors.filter((c) => c.source?.kind === 'local');
const connectorById = (id) => S.connectors.find((c) => c.id === id) ?? null;

async function renderPlugins() {
  $('settingsView').innerHTML = rtLoading('插件');
  let list;
  let cat;
  let fam;
  let plg;
  try {
    [list, cat, fam, plg] = await Promise.all([
      api('/api/connectors'),
      api('/api/connectors/catalog'),
      api('/api/runtime-families'),
      api('/api/plugins'),
    ]);
  } catch (err) {
    $('settingsView').innerHTML = `${headRow('<b>插件</b>')}<div class="empty">${failHtml(err)}</div>`;
    return;
  }
  S.connectors = list.connectors ?? [];
  S.catalog = cat.catalog ?? [];
  S.plugins = plg.plugins ?? [];
  S.catalogError = cat.error ?? null;
  S.runtimeFamilies = (fam.families ?? []).map((f) => ({ id: f.id, label: f.label }));

  const counts = {
    installed: S.connectors.length,
    catalog: publicCatalog().length,
    personal: personalCatalog().length + localConnectors().length,
  };

  $('settingsView').innerHTML = `
    ${headRow('<b>插件</b>')}
    <div class="detail-body">
      <div class="seg plg-tabs">
        ${PLG_TABS.map(
          ([key, label]) =>
            `<button data-plgtab="${key}" class="${S.pluginTab === key ? 'on' : ''}">${label}${
              counts[key] ? ` ${counts[key]}` : ''
            }</button>`,
        ).join('')}
      </div>
      <div id="plgBody"></div>
    </div>`;

  $('plgBody').innerHTML =
    S.pluginTab === 'catalog' ? plgCatalogHTML()
    : S.pluginTab === 'personal' ? plgPersonalHTML()
    : S.pluginTab === 'panels' ? plgPanelsHTML()
    : plgInstalledHTML();
  wirePlugins();
  wirePanelMarket();
}

/* ------------------------------------------------- 界面插件（市场那部分）*/

/**
 * 市场行：安装 / 停用 / 启用 / 卸载。
 * 和连接器的语义对齐 —— **停用**只是不生效（文件留着），**卸载**是把目录删掉。
 */
function plgPanelRowHTML(p) {
  const tags = [
    p.installed ? '<span class="set-tag">已安装</span>' : '',
    p.installed && p.enabled ? '<span class="set-tag">启用中</span>' : '',
    p.installed && !p.enabled ? '<span class="set-tag">已停用</span>' : '',
    p.connector ? `<span class="set-tag">工具：${esc(p.connector)}</span>` : '',
    p.valid ? '' : '<span class="set-tag" style="color:var(--bad);border-color:var(--bad)">配置有问题</span>',
  ]
    .filter(Boolean)
    .join('');

  let actions;
  if (!p.valid) {
    actions = `<span class="plg-warn">${esc(p.errors[0])}</span>`;
  } else if (!p.installed) {
    actions = `<button class="primary" data-plg-act="install" data-plg-id="${esc(p.id)}">安装</button>`;
  } else {
    actions =
      `<button data-plg-act="${p.enabled ? 'disable' : 'enable'}" data-plg-id="${esc(p.id)}">${p.enabled ? '停用' : '启用'}</button>` +
      `<button class="danger" data-plg-act="uninstall" data-plg-id="${esc(p.id)}">卸载</button>`;
  }

  return `<div class="set-row plg-row">
    <div class="plg-ico">${esc(initial(p.label))}</div>
    <div class="plg-card-main">
      <div class="plg-title"><b>${esc(p.label)}</b>${tags}</div>
      <div class="plg-desc">${esc(p.description || '')}</div>
      <div class="plg-meta">${esc(p.id)} · v${esc(p.version || '—')}</div>
    </div>
    <div class="plg-row-actions">${actions}</div>
  </div>`;
}

function plgPanelsHTML() {
  if (!S.plugins.length) {
    return '<div class="empty">市场里还没有界面插件<br />把插件放进 catalog/plugins/&lt;id&gt;/ 就会出现</div>';
  }
  return `<div class="set-box">${S.plugins.map(plgPanelRowHTML).join('')}</div>
    <div class="hint-line">「安装」把它拷进 plugins/；「停用」只是不生效，文件留着；「卸载」会把那个目录删掉。</div>
    <div class="hint-line">停用或卸载后，左边一级栏的「插件」入口里就不再有它。</div>`;
}

function wirePanelMarket() {
  document.querySelectorAll('[data-plg-act]').forEach((el) => {
    el.onclick = async () => {
      const id = el.dataset.plgId;
      const act = el.dataset.plgAct;
      const p = S.plugins.find((x) => x.id === id);
      if (act === 'uninstall') {
        if (!(await confirmDo(`卸载「${p?.label ?? id}」？\n\n这会删掉 plugins/${id}/ 整个目录（市场源还在，可以再装回来）。`))) return;
      }
      el.disabled = true;
      try {
        if (act === 'uninstall') {
          await api(`/api/plugins/${encodeURIComponent(id)}`, { method: 'DELETE' });
        } else {
          await post(`/api/plugins/${encodeURIComponent(id)}/${act}`, {});
        }
        await renderPlugins();   // 重新拉市场并重画
        renderList();            // rail 的入口也要跟着变
      } catch (err) {
        toast(err.message, 'error');
        el.disabled = false;
      }
    };
  });
}

function plgCredentials(c) {
  const items = [...(c.env ?? []), ...(c.headers ?? [])];
  if (!items.length) return '';
  return `<div class="chips">${items
    .map((it) => `<span class="chip"><span class="chip-label">${esc(it.key)}${it.kind === 'ref' ? '（引用环境变量）' : '（已写死）'}</span></span>`)
    .join('')}</div>`;
}

function plgRowHTML(c) {
  const where = c.command ? `${c.command} ${(c.args ?? []).join(' ')}`.trim() : c.url;
  const warn = (c.warnings ?? []).map((w) => `<div class="plg-warn">${esc(w)}</div>`).join('');
  return `<div class="set-row plg-row">
    <div class="plg-main">
      <div class="plg-title">
        <b>${esc(c.label)}</b>
        <span class="badge">${c.transport === 'stdio' ? '本地进程' : '远端服务'}</span>
        <span class="badge">${esc(c.source?.kind ?? '手工')}</span>
        ${c.enabled ? '' : '<span class="badge">已停用</span>'}
      </div>
      <div class="plg-meta">${esc(where || '（没写启动方式）')}</div>
      <div class="plg-meta">给：${c.runtimes?.length ? c.runtimes.map(esc).join('、') : '全部运行时'}</div>
      ${plgCredentials(c)}
      ${warn}
      <div class="plg-probe" data-probe-out="${esc(c.id)}"></div>
    </div>
    <div class="plg-actions">
      <button class="mini" data-probe="${esc(c.id)}" title="实探：真把它拉起来，看能不能用">测</button>
      <button class="mini" data-edit="${esc(c.id)}" title="改">改</button>
      <button class="mini" data-toggle="${esc(c.id)}" title="${c.enabled ? '停用' : '启用'}">${c.enabled ? '停' : '启'}</button>
      <button class="mini" data-del="${esc(c.id)}" title="卸载">卸</button>
    </div>
  </div>`;
}

function plgInstalledHTML() {
  if (!S.connectors.length) {
    return '<div class="empty">还没装任何东西<br />去「公开」挑一个，或在「个人」里手工粘一条</div>';
  }
  return `<div class="set-box">${S.connectors.map(plgRowHTML).join('')}</div>
    <div class="hint-line">「测」是真的把它拉起来走一遍 MCP 握手：能不能用、有哪些工具，点一下就知道。</div>
    <div class="hint-line">走 npm 的那种第一次会下载包，慢一点；之后就有缓存了。</div>
    <div class="hint-line">Codex 把外部工具放在「工具搜索」后面 —— 要让数字员工用上，提示词里先让它 tool_search 找一下（班底随后会把这句写进首轮注入）。</div>`;
}

function plgCardHTML(c) {
  const req = (c.requires ?? []).length
    ? `<div class="plg-req">需要：${c.requires
        .map((r) => `${esc(r.key)}${r.present ? '' : '（当前环境里没有）'}`)
        .join('、')}</div>`
    : '';
  return `<div class="plg-card">
    <div class="plg-ico">${esc((c.label || c.id).trim().slice(0, 1) || '?')}</div>
    <div class="plg-card-main">
      <div class="plg-title"><b>${esc(c.label)}</b><span class="set-tag">${esc(c.category)}</span></div>
      <div class="plg-desc">${esc(c.description)}</div>
      <div class="plg-meta">${esc(c.source.kind)} · ${esc(c.source.ref)}</div>
      ${req}
      ${c.note ? `<div class="plg-meta">${esc(c.note)}</div>` : ''}
    </div>
    ${c.installed ? '<span class="badge">已安装</span>' : `<button class="primary" data-install="${esc(c.id)}">安装</button>`}
  </div>`;
}

function plgCatalogHTML() {
  const list = publicCatalog();
  const err = S.catalogError ? `<div class="plg-warn">${esc(S.catalogError)}</div>` : '';
  if (!list.length) return `${err}<div class="empty">清单是空的</div>`;
  return `${err}<div class="plg-grid">${list.map(plgCardHTML).join('')}</div>
    <div class="hint-line">这份清单随仓库走（apps/server/catalog/connectors.json），不是市场：一条条写清来源和启动方式，装之前你看得见它要什么。</div>`;
}

function plgPersonalHTML() {
  const mine = localConnectors();
  const sample = personalCatalog();
  return `
    <section class="set-sec">
      <div class="set-head"><b>本机来源</b><span class="set-tag">装的路径在本机</span></div>
      <div class="set-box">
        ${
          mine.length
            ? mine.map(plgRowHTML).join('')
            : '<div class="set-row"><span class="dim">还没有本机来源的连接器</span></div>'
        }
      </div>
    </section>
    ${sample.length ? `<section class="set-sec">
      <div class="set-head"><b>本机示例</b><span class="set-tag">拿来验证链路</span></div>
      <div class="plg-grid">${sample.map(plgCardHTML).join('')}</div>
    </section>` : ''}
    <section class="set-sec">
      <div class="set-head"><b>手工添加</b><span class="set-tag">知道来源就能装</span></div>
      <div class="set-box">
        <div class="set-row">
          <div>
            <div class="set-label">粘一条 MCP 配置</div>
            <div class="dim" style="font-size:12px">本地进程（stdio）或远端服务（http）；装完建议点一次「测」。</div>
          </div>
          <button data-manual="1">添加…</button>
        </div>
      </div>
      <div class="hint-line">技能包（SKILL.md）是另一类个人扩展，在左边「技能」里管。</div>
    </section>`;
}

function wirePlugins() {
  const root = $('settingsView');
  root.querySelectorAll('[data-plgtab]').forEach((el) => {
    el.onclick = () => {
      S.pluginTab = el.dataset.plgtab;
      renderPlugins();
    };
  });

  root.querySelectorAll('[data-install]').forEach((el) => {
    el.onclick = async () => {
      el.disabled = true;
      try {
        const r = await post('/api/connectors', { from: el.dataset.install });
        S.pluginTab = 'installed';
        await renderPlugins();
        const needs = (r.needs ?? []).filter((k) => k);
        if (needs.length) {
          toast(`装好了。它要用环境变量：${needs.join('、')}\n班底进程里没有的话，运行时会明确报出来。`);
        }
      } catch (err) {
        el.disabled = false;
        toast(err.message, 'error');
      }
    };
  });

  root.querySelectorAll('[data-probe]').forEach((el) => {
    el.onclick = async () => {
      const out = root.querySelector(`[data-probe-out="${el.dataset.probe}"]`);
      const show = (text, cls) => {
        if (!out) return;
        out.textContent = text;
        out.className = 'plg-probe' + (cls ? ' ' + cls : '');
      };
      el.disabled = true;
      show('探测中…（真起进程，慢的话十几秒）');
      try {
        const r = await post(`/api/connectors/${encodeURIComponent(el.dataset.probe)}/probe`);
        show(r.ok ? `可以用了。工具：${(r.tools ?? []).join('、') || '（它没报工具）'}` : `用不了：${r.error ?? '未知原因'}`, r.ok ? 'ok' : 'bad');
      } catch (err) {
        show('探测失败：' + err.message, 'bad');
      } finally {
        el.disabled = false;
      }
    };
  });

  root.querySelectorAll('[data-toggle]').forEach((el) => {
    el.onclick = async () => {
      const c = connectorById(el.dataset.toggle);
      if (!c) return;
      try {
        await api(`/api/connectors/${encodeURIComponent(c.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: !c.enabled }),
        });
        await renderPlugins();
      } catch (err) {
        toast(err.message, 'error');
      }
    };
  });

  root.querySelectorAll('[data-edit]').forEach((el) => {
    el.onclick = () => openConnDialog(connectorById(el.dataset.edit));
  });

  root.querySelectorAll('[data-del]').forEach((el) => {
    el.onclick = async () => {
      const c = connectorById(el.dataset.del);
      if (!c) return;
      if (!(await confirmDo(`卸载「${c.label}」？数字员工下次运行就用不到它了。`))) return;
      try {
        await api(`/api/connectors/${encodeURIComponent(c.id)}`, { method: 'DELETE' });
        await renderPlugins();
      } catch (err) {
        toast(err.message, 'error');
      }
    };
  });

  root.querySelectorAll('[data-manual]').forEach((el) => {
    el.onclick = () => openConnDialog(null);
  });
}

/* ------------------------------------------------- 连接器：添加 / 修改 */

let connEditing = null;
let connTransport = 'stdio';

function connSetTransport(t) {
  connTransport = t === 'streamable-http' ? 'streamable-http' : 'stdio';
  $('connTransport')
    .querySelectorAll('[data-tr]')
    .forEach((b) => b.classList.toggle('on', b.dataset.tr === connTransport));
  $('cStdio').classList.toggle('plg-hidden', connTransport !== 'stdio');
  $('cHttp').classList.toggle('plg-hidden', connTransport !== 'streamable-http');
}

/** 一行一条 KEY=值 —— 值写成 env:名字 表示引用环境变量（凭据该走这条） */
function parseKeyValues(text) {
  const out = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i <= 0) continue;
    out[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  }
  return out;
}

function openConnDialog(entry) {
  connEditing = entry ?? null;
  $('connDlgTitle').textContent = entry ? `改连接器：${entry.label}` : '添加连接器';
  $('cId').value = entry?.id ?? '';
  $('cId').disabled = !!entry; // 名字是账本的键，装完不改
  $('cLabel').value = entry?.label ?? '';
  $('cCommand').value = entry?.command ?? '';
  $('cArgs').value = (entry?.args ?? []).join('\n');
  $('cCwd').value = entry?.cwd ?? '';
  $('cUrl').value = entry?.url ?? '';
  $('cBearer').value = entry?.bearerTokenEnv ?? '';
  $('cEnv').value = '';
  $('cHdr').value = '';
  // 凭据值不回吐（账本只给键），所以「改」时不预填 —— 留空=不动
  const envKeys = (entry?.env ?? []).map((e) => e.key);
  const hdrKeys = (entry?.headers ?? []).map((e) => e.key);
  $('cEnvKeys').textContent = envKeys.length ? `现有：${envKeys.join('、')}（留空＝不动）` : '目前没有环境变量';
  $('cHdrKeys').textContent = hdrKeys.length ? `现有：${hdrKeys.join('、')}（留空＝不动）` : '目前没有请求头';
  $('cRuntimes').innerHTML = (S.runtimeFamilies.length ? S.runtimeFamilies : [{ id: 'codex', label: 'codex' }, { id: 'dsh', label: 'dsh' }])
    .map(
      (f) =>
        `<label class="plg-rt"><input type="checkbox" value="${esc(f.id)}" ${
          entry?.runtimes?.includes(f.id) ? 'checked' : ''
        } /> ${esc(f.label)}</label>`,
    )
    .join('');
  connSetTransport(entry?.transport ?? 'stdio');
  $('connDlg').showModal();
  setTimeout(() => $('cLabel').focus(), 30);
}

$('connTransport').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tr]');
  if (b) connSetTransport(b.dataset.tr);
});

$('cOk').onclick = async (e) => {
  e.preventDefault();
  const id = $('cId').value.trim();
  const body = {
    id,
    label: $('cLabel').value.trim() || id,
    transport: connTransport,
    command: connTransport === 'stdio' ? $('cCommand').value.trim() : '',
    args: connTransport === 'stdio' ? $('cArgs').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [],
    cwd: connTransport === 'stdio' ? $('cCwd').value.trim() : '',
    url: connTransport === 'streamable-http' ? $('cUrl').value.trim() : '',
    bearerTokenEnv: connTransport === 'streamable-http' ? $('cBearer').value.trim() : '',
    runtimes: [...$('cRuntimes').querySelectorAll('input:checked')].map((el) => el.value),
  };
  // 凭据留空＝不动（新建时留空就是没有）
  const envText = $('cEnv').value.trim();
  if (envText || !connEditing) body.env = parseKeyValues(envText);
  const hdrText = $('cHdr').value.trim();
  if (hdrText || !connEditing) body.headers = parseKeyValues(hdrText);

  try {
    if (connEditing) {
      await api(`/api/connectors/${encodeURIComponent(connEditing.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } else {
      await post('/api/connectors', body);
    }
    $('connDlg').close();
    S.pluginTab = 'installed';
    await renderPlugins();
  } catch (err) {
    toast(err.message, 'error');
  }
};

/* ----------------------------------------------------- 运行时：设备 → CLI → 详情 */

// 加载态：右页头先写当前页标题（左栏只写「设置」），正文里说一声
const rtLoading = (title) => `${headRow(`<b>${esc(title)}</b>`)}<div class="empty" style="padding:24px 4px">加载中…</div>`;

/**
 * 页头的「← 工作台」—— **2026-10-19 起不再调用**（用户要求统一去掉，见 headRow 的注释）。
 *
 * 当初加它的理由记在这儿，免得以后有人"发现"它没被用就删掉、过了半年又想不明白为什么要加：
 * 这些页的左栏一进来就换成了自己的列表，原来左栏顶上那条「‹ 工作台」就没了，
 * 只能靠页头那段灰面包屑点回去 —— 而面包屑第一段是灰的，一眼看不出能点。
 * 后来验证下来：**左栏那几行本身就够用**，按钮是重复入口。所以撤掉按钮，只留这份实现。
 */
function backToWorkbench(label = '工作台') {
  return `<button class="icon-btn head-back" data-back-wb title="回${esc(label)}">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 6l-6 6 6 6" />
            </svg>
            <span>${esc(label)}</span>
          </button>`;
}

/**
 * 页头统一结构：左边标题（可以是一段 HTML，比如带徽标 / 输入框），右边按钮组。
 *
 * **不要返回按钮**（2026-10-19 用户第二次指着它说「统一去掉这个按钮」）。
 * 理由跟项目页那次一样，只是现在推广到全部子页：**每一页的左栏都已经写着"上一级"**
 *   · 项目 / 看板 —— 左栏是项目清单
 *   · 流程编排 / 流程记录 —— 左栏是流程模板 / 发起记录清单
 *   · 定时任务 / 插件面板 —— 左栏是工具清单
 * 想回哪儿都能直接点那一行，页头再放一枚「← 工作台」就是同一件事的第二个入口，
 * 还白占页头最左边、把标题推得比别处靠右。
 *
 * 因此 `backToWorkbench` / `wireBackWb` 一对**保留但不再调用** ——
 * 留着是因为它们把"哪一页该回哪"这条知识写下来了（任务卡回看板、看板回项目），
 * 哪天要重新加回按钮，接线不用再猜一遍。
 */
function headRow(titleHtml, actionsHtml = '') {
  return `<div class="detail-head head-row"><div class="head-title">${titleHtml || ''}</div>${
    actionsHtml ? `<div class="head-actions">${actionsHtml}</div>` : ''
  }</div>`;
}

/**
 * 接线页头那枚「← 上级」—— **2026-10-19 起不再调用**（按钮已从 headRow 里撤掉）。
 * 留着它是因为它把"哪一页回哪里"这条知识写下来了：任务卡回看板、看板回项目、
 * 其余回工作台。哪天要把按钮加回来，直接接这一根，不用每页重猜一遍。
 */
function wireBackWb(root, back = () => openPlugins()) {
  root.querySelector('[data-back-wb]')?.addEventListener('click', () => {
    Promise.resolve()
      .then(back)
      .catch((e) => toast(e.message, 'error'));
  });
}

/**
 * 「上一级」点下去做什么 —— 面包屑的跳转表。
 *
 * 为什么要一张表 + 一次事件委托，而不是每处 `el.onclick = …`：
 *   · 页面是随时重建的（十几处 innerHTML），逐个绑定既啰嗦又会漏；
 *   · 页面里不该知道"怎么回项目/怎么回工作台"这些路由细节，写在这儿才好一起看。
 *
 * 值收一个 arg（比如「项目清单里选中它」）。指向的必须是**上一层**，不是"往回退一步"。
 *
 * ⚠️ 2026-10-19 设置 / 流程模块的面包屑撤掉之后，`settings` / `skills` / `flows`
 *    三个键没有宿主了，已删。`devices` / `device` 2026-10-20 又加回来了：
 *    运行时是多层页面（运行时 › 设备 › CLI），页头要用面包屑导航。
 *    以后要在别处用，照原样加回来即可：settings→openSettings('prefs')、
 *    skills→openSettings('skills')、flows→openWorkflows()。
 */
const CRUMB_GO = {
  workbench: () => setNav('plugins'),   // 工作台宫格首页（点一级栏那条路，顺带收左栏）
  contacts: () => setNav('contacts'),
  // 消息：从「已归档」子视图的面包屑回主列表（setNav 默认就会清掉 archivedView）
  messages: () => setNav('messages'),
  // 工作台里的几处
  // 带 arg 就是"项目清单里选中它"（面包屑里点某个项目的名字回到它的详情页）
  projects: (id) => openProjectsPage(id ?? undefined),
  board: () => openTaskBoard(),
  // 运行时那两级：不是"分节"而是状态 —— 得先把 S.rtLevel 摆好，renderRuntimes 按它分发
  devices: () => { S.rtLevel = 'devices'; S.rtDevice = null; S.rtRuntime = null; return renderRuntimes(); },
  device: () => { S.rtLevel = 'device'; S.rtRuntime = null; return renderRuntimes(); },
  // 设置子页（技能等）的面包屑回设置首页
  settings: () => openSettings('prefs'),
  // 技能详情的面包屑回技能列表
  skills: () => openSettings('skills'),
};

// 一次委托，管全站所有面包屑。页面重建不用重新绑。
document.addEventListener('click', (e) => {
  const el = e.target.closest?.('[data-crumb-to]');
  if (!el) return;
  const go = CRUMB_GO[el.dataset.crumbTo];
  if (!go) return;
  e.preventDefault();
  Promise.resolve()
    .then(() => go(el.dataset.crumbArg ?? null))
    .catch((err) => toast(err?.message ?? String(err), 'error'));
});

/**
 * 可点的面包屑（2026-10-19 起全站子页页头都用它）。
 *
 * items: `[{ label, to?, arg? }]` —— 最后一段**不传 to**（那是当前位置，不该点）。
 *   · `to` 是 `CRUMB_GO` 里的键，不是 URL；
 *   · `arg` 给需要 id 的那种（比如回某个项目）。
 *
 * 层级只表达"我在哪一层"，不承担"后退"——所以别把上一级的上一级也塞进来凑数，
 * 三层以内最好读；四层以上先想想是不是层级设计本身有问题。
 */
function breadcrumb(items) {
  return `<nav class="crumb">${items
    .map((it, i) => {
      const sep = i ? '<span class="crumb-sep">›</span>' : '';
      if (!it.to) return `${sep}<span class="crumb-cur">${esc(it.label)}</span>`;
      return (
        `${sep}<button type="button" class="crumb-btn" data-crumb-to="${esc(it.to)}"` +
        `${it.arg != null ? ` data-crumb-arg="${esc(it.arg)}"` : ''}>${esc(it.label)}</button>`
      );
    })
    .join('')}</nav>`;
}

/**
 * 「局域网」那一行的状态话术已经不要了（2026-10-20 用户圈掉「已经开着 ✓」）：
 * 开/关由开关本身表达，"改了要点重启"由上面那句说明承担 —— 卡上不再有第三句话。
 */

async function renderRuntimes() {
  if (S.rtLevel === 'cli' && S.rtDevice && S.rtRuntime) return renderCliDetail();
  if (S.rtLevel === 'device' && S.rtDevice) return renderDeviceDetail();
  return renderDeviceList();
}

/* ① 模式页 —— **2026-10-21 五改：模式卡收成一行**（用户："上面那一块可以简化。
   一个开关，一个重启按钮就可以了"）——
   单机/总机分段 + 说明行 + 连接行全部收掉，只剩「总机」开关（开=总机、关=单机）+ 常显重启按钮。
   真加入成功之后整站换成节点页（renderNodeMode），那台机器上这页都进不去了，没有"模式"可切。
   「接入总机」是页面最底一节（只在单机档出现，常开、无标题，面板自己带「可用总机」）；
   备份挪去独立的「数据备份」分节，这页不再摆本机数据和导出。 */

/* 设备行（总机的设备区）：远程节点多一枚「在线/离线」+ 排队数 —— 行的骨架与本地完全一致 */
const deviceRowHtml = (dev) => {
  const isNode = dev.kind === 'node';
  /* 「本机」身份标签（2026-10-21 用户：节标题固定叫「设备」，本机这条用标签标出来 ——
     开关总机不再牵动标题）。颜色中性：它不是状态，只是身份。 */
  const self = dev.kind === 'local' ? '<em class="tag-dim">本机</em>' : '';
  const flag = isNode
    ? `<em class="${dev.online ? 'tag-ok' : 'tag-warn'}">${dev.online ? '在线' : '离线'}</em>`
    : '';
  // 队列里压着几个活 —— 节点离线时这个数会一直涨，那就是"离线排队"看得见的样子
  const queued = isNode && dev.pendingJobs ? ` · 排队 <b>${dev.pendingJobs}</b>` : '';
  const tail = isNode ? '（远程节点）' : '';
  return `<div class="row-item" data-open-device="${esc(dev.id)}">
    <div class="avatar">${esc(initial(dev.label))}</div>
    <div class="who">
      <b>${esc(dev.label)}${self}${flag}</b>
      <div class="sub">${esc(dev.platform)} · ${dev.runtimeCount} 个 agent CLI${queued}${tail}</div>
    </div>
    <span class="chev">›</span>
  </div>`;
};

async function renderDeviceList() {
  S.rtLevel = 'devices';
  S.rtDevice = null;
  S.rtRuntime = null;
  // 左栏只写「设置」（在 openSettings 里），这一页的标题「这台机器」在右页头
  $('settingsView').innerHTML = rtLoading('这台机器');

  let list = [];
  try {
    list = (await api('/api/devices')).devices;
  } catch (err) {
    $('settingsView').innerHTML = `${headRow('<b>这台机器</b>')}<div class="empty">${failHtml(err)}</div>`;
    return;
  }
  // 网络现状（旧后端没这条路由 → 按默认画，页面不能因此白屏 ✗）
  let lan = { allowLan: false, boundLan: false, restartNeeded: false, urls: [], explicit: false };
  try {
    lan = await api('/api/lan');
  } catch { /* 忽略：按默认画 */ }
  // 模式卡附带的预警（如「另一个数据目录里也有节点常驻」）：拉不到不挡模式卡
  let local = null;
  try {
    local = await api(`${LOCAL_BASE}/status`);
  } catch { local = null; }

  /*
   * 模式只有一个事实源：netmode.allowLan（+ 启动参数 explicit）。
   * 「总机」不是又一个开关 —— 允许局域网连入 = 当总机，关掉 = 回单机
   * （用户 2026-10-21：「被局域网探测这个说法不对，开了之后也不是总机，不开是单机模式」）。
   * 收过的设备不算模式：单机也可能留着设备记录（重开总机就回来）。
   * explicit（BANDI_HOST 指定监听）的服务端总机：模式锁死，不给切。
   */
  /* 总机不接入别的总机（2026-10-21 截图反馈）：「接入总机」整条路只在**单机档**存在 ——
     收设备的机器不该同时摆着"去给别人当算力"的面板。分节只在单机档渲染，无需手动收。 */

  /*
   * 只有两档：单机 / 总机，开关就是切换本体（开=总机、关=单机 —— 2026-10-21 五改收成一行）。
   * 「接入总机」不是第三档模式，是页面最底一节（六改：常开不折叠；七改：连节标题也去掉）。
   * 真加入成功后整站换成节点页，那时这台已经没有"模式"可切了。
   */

  /*
   * 设备区**单机/总机都显示**（2026-10-21 用户：单机也要能进本机管运行时），
   * 但只有总机态给「添加设备」—— 单机不收设备，不派活给别人。
   * 单机态只列本机：手上留着的远程节点记录这时候连不上，摆出来反而误导。
   * （节点态走的是另一套整页 renderNodeMode，压根不渲染这页。）
   */

  $('settingsView').innerHTML = `
    ${headRow('<b>这台机器</b>')}
    <div class="detail-body">
      <!-- 模式节走 renderMode() 单独渲染（2026-10-21 十改，用户："切换的时候画面有点闪"）：
           切换只重画这一小块，设备/可用总机列表原地不动，不再整页 innerHTML 重写闪一下。
           （十一改：设备节 + 接入总机节也抽成 renderBody() —— 它们的显隐/过滤跟着模式走，
           切换**成功**后要连着重画，否则页面纹丝不动 —— 十改只顾模式卡，漏了下面。 -->
      <div id="modeMount"></div>
      <div id="devMount"></div>
      <div id="joinSlot"></div>
    </div>`;

  /* 模式节单独渲染：只重画 #modeMount 这一小块（整页重写是切换闪烁的根源）。
     lan 是闭包里的活对象 —— 切换成功后改它再重画，高亮/待重启标记/状态行都跟着走 */
  const modeNow = () => (lan.explicit || lan.allowLan ? 'host' : 'standalone');
  const renderMode = () => {
    const m = modeNow();
    const pd = !!lan.restartNeeded || (m === 'host' && !lan.boundLan);
    const mount = $('modeMount');
    if (!mount) return;
    /* 服务端总机（BANDI_HOST 指定监听，2026-10-21 截图反馈）：没有"模式"可言 ——
       这台锁死当总机，单机/总机切换、待重启标记、重启按钮全是摆设。
       整张模式卡不画，只留预警（如有）。 */
    if (lan.explicit) {
      mount.innerHTML = (local?.warnings ?? []).length
        ? `<section class="set-sec mode-sec">${(local?.warnings ?? []).map((w) => `<div class="machine-warn">${esc(w)}</div>`).join('')}</section>`
        : '';
      return;
    }
    mount.innerHTML = `
      <section class="set-sec mode-sec">
        <div class="set-head">
          <b>模式</b>${pd ? '<span class="set-tag">改了还没生效 —— 点「重启」生效</span>' : ''}
          <div class="mode-ctl">
            <div class="seg" id="modeSeg">
              <button data-mode="standalone" class="${m === 'standalone' ? 'on' : ''}">单机</button>
              <button data-mode="host" class="${m === 'host' ? 'on' : ''}" ${
                lan.explicit ? 'disabled title="监听地址由启动参数指定（BANDI_HOST），这台常驻当总机"' : ''
              }>总机</button>
            </div>
            <button class="btn-sm ${pd ? 'primary' : ''}" id="lanRestart">重启</button>
          </div>
        </div>
        <div class="mode-state">${
          m === 'host'
            ? '总机 —— 同一网络里的设备可以连到这台、领活干'
            : '单机 —— 只在这台电脑上用；切到「总机」，同一网络里的设备就能连进来领活'
        }</div>
        ${(local?.warnings ?? []).map((w) => `<div class="machine-warn">${esc(w)}</div>`).join('')}
      </section>`;
    wireModeCard({ lan, mode: m, refresh });
  };

  /* 模式之下的一切（设备节 + 接入总机节，2026-10-21 十一改）：显隐与过滤都跟着模式走 ——
     切换**成功**后跟着 renderMode 一起重画（十改只重画模式卡，下面纹丝不动是 bug）。
     「接入总机」节不要标题（用户连着两次删）——面板自己带「可用总机 + 发现/添加」。 */
  const renderBody = () => {
    const m = modeNow();
    const rows = m === 'host' ? list : list.filter((d) => d.kind !== 'node');
    const dev = $('devMount');
    const slot = $('joinSlot');
    if (!dev || !slot) return;
    dev.innerHTML = `
      <section class="fx">
        <div class="fx-head">
          <label>设备 <span class="count">${rows.length}</span></label>
          ${m === 'host' ? '<button class="btn-sm primary" id="joinNode">添加设备</button>' : ''}
        </div>
        ${rows.map(deviceRowHtml).join('')}
      </section>`;
    slot.innerHTML = m === 'standalone' ? '<section class="fx"><div id="joinMount"></div></section>' : '';
    const jn = $('joinNode');
    if (jn) jn.onclick = () => openJoinDialog(lan);
    if (m === 'standalone') mountJoinPanel($('joinMount'));
    /* 设备行点进去（本机 / 远程节点同一个入口，详情页自己分叉） */
    dev.querySelectorAll('[data-open-device]').forEach((el) => {
      el.onclick = () => {
        S.rtLevel = 'device';
        S.rtDevice = el.dataset.openDevice;
        renderRuntimes();
      };
    });
  };

  /* refresh(deep)：确认取消/请求失败只回拨模式卡高亮；切换**成功**传 deep=true，
     连着重画设备节与接入总机节（它们的显隐跟模式走） */
  const refresh = (deep) => {
    renderMode();
    if (deep) renderBody();
  };
  renderMode();
  renderBody();
}

/**
 * 模式卡的接线：单机⇄总机 = 改 allowLan + 重启生效（确认框把后果说全）。
 * 「接入总机」那节没有折叠态（面板常挂），这里不再管它；真加入成功后整站变节点页。
 */
function wireModeCard({ lan, mode, refresh }) {
  const restart = $('lanRestart');
  if (restart) {
    restart.onclick = async () => {
      restart.disabled = true;
      restart.textContent = '重启中…';
      try {
        await post('/api/restart', {});
      } catch {
        restart.disabled = false;
        restart.textContent = '重启';
        return; // api() 已经提示过了
      }
      const t0 = Date.now();
      for (;;) {
        await new Promise((r) => setTimeout(r, 400));
        try {
          const r = await fetch('/api/state', { cache: 'no-store' });
          // 401 也算"起来了"（那说明它开始要令牌了 —— 刷新之后会看到登录页 ✓）
          if (r.ok || r.status === 401) break;
        } catch { /* 还没回来 */ }
        if (Date.now() - t0 > 20000) {
          restart.disabled = false;
          restart.textContent = '重启后没连上，刷新看看';
          return;
        }
      }
      location.reload();
    };
  }

  /* 选项卡即模式：点哪档切哪档，**不弹确认**（2026-10-21 用户："切换不要弹窗"）——
     切换本来就可逆（再点一下切回来），后果由状态行 + 「重启」按钮承担，不用对话框拦一道。
     请求失败 refresh() 把高亮拨回真实模式 —— 否则界面说的和库里存的是两回事。
     成功后改闭包里的 lan（allowLan + restartNeeded）再 refresh(true) ——
     deep=true 连着重画设备节/接入总机节（显隐跟模式走），模式卡本身原地重画不闪整页 */
  const modeSeg = $('modeSeg');
  if (modeSeg) {
    modeSeg.querySelectorAll('[data-mode]').forEach((btn) => {
      btn.onclick = async () => {
        const toHost = btn.dataset.mode === 'host';
        if (toHost === (mode === 'host')) return;
        try {
          await post('/api/lan', { allowLan: toHost });
        } catch {
          refresh();
          return; // api() 已经提示过了
        }
        lan.allowLan = toHost;
        lan.restartNeeded = true;
        refresh(true);
      };
    });
  }
}

/**
 * 「让一台新机器加入」：发一个**一次性邀请码**，把能直接粘的整条命令摆出来。
 *
 * 为什么要有这一步（2026-10-16）：节点原来用总机那枚 master 令牌 ✗ —— 一台被翻等于整套被翻，
 * 而且「忘掉」踢不掉它（令牌还有效）。现在换成"邀请码 → 每节点一枚自己的令牌"。
 *
 * ⚠️ 命令里的地址用 `location.origin`（**浏览器眼里**的控制面地址）——
 * 这正是那台新机器要连的地址 ✓；`BANDI_DATA` 必须跟那台机器上服务用的是同一个 ✗
 * （我迁移时就漏了这句，配置写到了别处，节点直接哑了）。
 */
async function openJoinDialog(lan = null) {
  const dlg = $('joinDlg');
  const pre = $('joinCmd');
  const foot = $('joinFoot');
  pre.textContent = '正在生成邀请码…';
  foot.textContent = '';
  dlg.showModal();
  let inv;
  try {
    inv = await api('/api/nodes/invites', { method: 'POST' });
  } catch (err) {
    pre.textContent = '生成失败：' + err.message;
    return;
  }
  /*
   * 命令里的地址得是**那台新机器能连到的**那个 ✗ —— 不能一律用 `location.origin`：
   * 如果控制面已经开在局域网上，用户在**本机**打开这一页时 origin 是 `127.0.0.1` ✗，
   * 拿这条命令去别的机器上粘，那台机器会连到它**自己**的 127.0.0.1 ✗（然后一头雾水）。
   */
  const base =
    lan?.boundLan && lan.urls?.length ? lan.urls[0] : location.origin;
  const cmd = [
    '# 在那台新机器上跑（它得先有 Node 和这份代码 —— 见 deploy/README）',
    'export BANDI_DATA="$HOME/.bandi-node"',
    `node apps/server/src/node.mjs --join ${base} --code ${inv.code}`,
    '',
    '# 它换回自己的令牌之后，把它起成常驻（开机自己起）：',
    'BANDI_DATA="$HOME/.bandi-node" node apps/server/src/autostart.mjs install node',
  ].join('\n');
  pre.textContent = cmd;
  const at = new Date(inv.expiresAt);
  foot.innerHTML = rich(
    `这个码 ${at.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 前有效，**只用一次**。换来的令牌只能干它自己那台的事，随时可以在设备页把它忘掉（= 吊销）。` +
      (lan?.boundLan ? '' : '⚠️ 现在这台机器只听本机 —— 别的机器连不到它，得先在下面把「局域网」打开并重启。'),
  );
  $('joinCopy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      $('joinCopy').textContent = '已复制';
      setTimeout(() => { $('joinCopy').textContent = '复制命令'; }, 1500);
    } catch {
      toast('复制不了，手动选中吧：\n\n' + cmd);
    }
  };
}

/* --------------------------------------------------------------- 这台机器 */

/**
 * 字节数 → 人话。只在展示层用；**大小一律以服务端 `GET /api/local/status` 报的为准**，
 * 前端不自己 stat（避免"看着 42MB、导出 38MB"这种两套数字）。
 */
const fmtMb = (bytes) => {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  const mb = n / 1048576;
  // 太小就别写 "0.0 MB" 了 —— 看着像坏了；刚建的库就一两页
  if (mb < 0.1) return '< 0.1 MB';
  return `${mb >= 100 ? String(Math.round(mb)) : mb.toFixed(1)} MB`;
};

/* 「数据管理」分节（2026-10-21 独立成菜单「数据备份」，2026-10-22 改名「数据管理」并补导入）——
   导出 = VACUUM INTO 出一份完整快照，导出时不用停班底。
   导入 = 选一份班底导出的 .db 快照覆盖本机数据：服务端先校验（头 / 完整性 / 班底的表），
   写成待用文件，**重启班底才换库**（换的时候现库自动备份进 backups/导入前-*.db）。
   恢复从此有两条路：直接导入快照，或照老办法手动覆盖 bandi.db。 */
async function renderBackup() {
  $('settingsView').innerHTML = rtLoading('数据管理');
  let st = null;
  try {
    st = await api(`${LOCAL_BASE}/status`);
  } catch { /* 拉不到也照常渲染：路径/大小显示 —，点导出会拿到真实报错 */ }
  const local = st?.local ?? {};
  const counts = local.counts ?? {};
  const size = fmtMb(local.dbSize);
  const mtime = local.dbMtime ? dt(local.dbMtime) : '';
  $('settingsView').innerHTML = `
    ${headRow('<b>数据管理</b>')}
    <div class="detail-body">
      <section class="set-sec machine-card">
        <div class="set-box">
          <div class="set-row">
            <span class="set-label">本机数据</span>
            <div class="machine-data">
              <div class="machine-path" title="${esc(local.dbPath ?? '')}">${esc(local.dbPath ?? '—')}${size ? ` · ${esc(size)}` : ''}</div>
              <div class="sub">${Number(counts.personas ?? 0)} 个员工 · ${Number(counts.conversations ?? 0)} 段会话 · ${Number(counts.projects ?? 0)} 个项目${mtime ? `　最后修改 ${esc(mtime)}` : ''}</div>
            </div>
          </div>
          <div class="set-row">
            <span class="set-label">怎么用</span>
            <div class="machine-data">
              <div class="sub">「导出」生成这份库的完整快照（一个 .db 文件），导出时班底照常用。「导入」选一份快照覆盖本机数据：会先校验文件，当前数据自动备份进数据目录的 backups/，<b>重启班底后生效</b>。</div>
            </div>
          </div>
        </div>
        <div class="machine-actions">
          <button class="btn-sm" id="backupImport">导入</button>
          <button class="btn-sm primary" id="backupExport">导出</button>
        </div>
      </section>
    </div>
    <input type="file" id="backupImportFile" accept=".db,.sqlite,.sqlite3" hidden />`;
  const btn = $('backupExport');
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      const r = await post(`${LOCAL_BASE}/export`, {});
      toast(`已导出：${r.file}`, 'ok'); // 完整路径 toast 出去，用户去那个目录拿
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  };

  /* 导入：选文件 → 确认（说清"覆盖本机数据 + 重启生效 + 自动备份"）→ 原始字节上传。
     服务端校验失败会回 E1099 的人话；成功也只是"待生效"，别把话说成"已完成"。 */
  const impBtn = $('backupImport');
  const fileInput = $('backupImportFile');
  impBtn.onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const f = fileInput.files?.[0];
    fileInput.value = ''; // 允许同一文件选第二次（onchange 只在变化时触发）
    if (!f) return;
    if (!/\.(db|sqlite|sqlite3)$/i.test(f.name)) {
      toast('请选择班底导出的 .db 快照文件', 'error');
      return;
    }
    const ok = await confirmDo(
      `导入会用「${f.name}」覆盖本机数据（${fmtMb(f.size) || '大小未知'}）。\n` +
        `服务端会先校验文件，并把当前数据自动备份到数据目录的 backups/ 里。\n` +
        `导入完成后需要重启班底才生效。`,
      { title: `导入「${f.name}」？` },
    );
    if (!ok) return;
    impBtn.disabled = true;
    try {
      const buf = await f.arrayBuffer();
      const r = await fetch(`${LOCAL_BASE}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buf,
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `导入失败（HTTP ${r.status}）`);
      toast('已导入，重启班底后生效', 'ok');
      await renderBackup(); // 重画一遍：状态行还是现库的数字，别让人误以为已经换了
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      impBtn.disabled = false;
    }
  };
}

/**
 * 「加入总机」面板（2026-10-20 设计 §9.4，2026-10-21 从弹窗改成**页面内嵌**）：
 * list（主机列表）→ explain（会改变什么 + 邀请码）→ joining → done。
 *
 * 2026-10-21 拍板：**节点只当算力，不做「看总机面板」** —— 原 scope 三选一步骤删除，
 * 加入一律拿 compute 令牌（服务端也写死，不信任前端）。
 *
 * 为什么不再用 dialog：用户实报"弹窗的方式操作有点不舒服"—— 主机列表是这页的主体内容，
 * 塞进 520px 的小弹窗里又要滚动又要等扫描，不如直接长在页面上（跟设置页其它分区同一种列表式）。
 * 与 `openJoinDialog` 语义不同：那个是**总机**发码给别人，这个是**本机**去加入别人。
 *
 * 状态机全部在这个局部对象里（重进设置页 = 整个重来，不往 S 里塞）。
 * 列表页：**不自动扫**（2026-10-21 用户：去掉自动探测，改手动）+ 「发现」按钮扫
 *        + 「添加」（填了就入列）+ 已存的先测试、通过才出「加入」。
 */
function mountJoinPanel(root) {

  /* 状态机的全部状态都在这个局部对象里 —— 切走设置分区就整个忘掉，不往 S 里塞。
     2026-10-21：scan/pick/manual 三步合并成「主机列表」一页（用户拍板的列表模型）；
     探测改成**纯手动**（进页不扫，点「发现」才扫）+ 添加填了就入列。
     同日再改（用户："加入按钮一直显示，点击加入，打开弹窗"）：加入不再换页 ——
     原来那套 explain/joining/done 步骤机（wiz.step）整个撤掉，改成**一个弹窗**装下
     「会改变什么 + 邀请码 + 加入 + 结果」，列表页永远留在原地。 */
  const wiz = {
    hosts: [],            // 通讯录（/status 透传 + add/remove 的返回刷新）
    candidates: [],       // 本次扫描结果（不入列，刷新会重扫）
    tested: new Map(),    // url → {state:'testing'|'ok'|'fail', host?, code?, msg?}
    scanning: false,
    url: '',              // 上一次点「加入」的目标（弹窗默认值）
    code: '',             // 邀请码：弹窗关掉再开还留着上次填的
    err: '',
    status: null,         // 本机读数：本机员工/会话/项目数（status 透传）
    secs: 0,
    tick: null,
  };

  // 本机读数拉一次就够（弹窗里的本机数据 + 通讯录初值）；拉不到不挡路 —— 列表按空画，扫描照常
  api(`${LOCAL_BASE}/status`).then((st) => {
    wiz.status = st;
    wiz.hosts = Array.isArray(st?.hosts) ? st.hosts : [];
    render(); // 通讯录行补上（列表页是唯一的一页，直接重画）
  }).catch(() => {});

  // 离开这页（设置切到别的分区，root 被整个换掉）就停表 —— 定时器别挂在看不见的节点上空转
  const tickGuard = setInterval(() => {
    if (!root.isConnected) {
      clearInterval(wiz.tick);
      clearInterval(tickGuard);
    }
  }, 1000);

  const errLine = () => (wiz.err ? `<div class="joinwiz-err">${esc(wiz.err)}</div>` : '');

  /* ---------------------------------------------------- 步骤 1 · 主机列表 */
  /* 扫描不再切步骤：原地转圈，结果合并进列表。空结果不是错误 —— 通讯录和「添加」仍在。 */
  const runScan = () => {
    if (wiz.scanning) return;
    wiz.scanning = true;
    wiz.secs = 0;
    clearInterval(wiz.tick);
    // 「已经找了 N 秒」：本地计时（服务端最多 4 秒返回）
    wiz.tick = setInterval(() => {
      wiz.secs += 1;
      const el = root.querySelector('[data-sec]');
      if (el) el.textContent = `已经找了 ${wiz.secs} 秒 · 同一网络里的班底会自动应答`;
    }, 1000);
    render();
    post(`${LOCAL_BASE}/discover`, {})
      .then((r) => {
        clearInterval(wiz.tick);
        wiz.candidates = r?.candidates ?? [];
        wiz.scanning = false;
        render();
      })
      .catch((err) => {
        clearInterval(wiz.tick);
        wiz.scanning = false;
        toast(err.message, 'error'); // 扫描这条路废了也不挡路：通讯录与「添加」必须还能走通
        render();
      });
  };

  /* 通讯录在前（用户明确记住的），扫描结果在后；同一台总机（instanceId 或 url 撞上）
     合并成一行 —— 扫描带来的 joinable/caps 是刚出炉的，盖到通讯录行上刷新状态。 */
  const mergeRows = () => {
    const keyOf = (x) => (x.instanceId ? `i:${x.instanceId}` : `u:${x.url}`);
    const rows = [];
    const seen = new Set();
    for (const h of wiz.hosts) {
      const k = keyOf(h);
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push({ ...h, persisted: true });
    }
    for (const c of wiz.candidates) {
      const k = keyOf(c);
      const exist = rows.find((r) => keyOf(r) === k);
      if (exist) {
        exist.joinable = c.joinable;
        exist.caps = c.caps;
        continue;
      }
      seen.add(k);
      rows.push({ ...c, persisted: false });
    }
    return rows;
  };

  const drawList = (box) => {
    const rowsHtml = mergeRows()
      .map((h) => {
        const t = wiz.tested.get(h.url);
        const stale = Array.isArray(h.caps) && !h.caps.includes('scope');
        let tag = '';
        let sub = '';
        let action = '';
        if (t?.state === 'testing') {
          tag = '<em class="tag-ok">（测试中…）</em>';
        } else if (t?.state === 'ok') {
          // 测试通过 → 只把标签说清楚；「加入」本来就一直在，不用等测试
          tag = '<em class="tag-ok">（可加入）</em>';
          action = `<button type="button" class="mini auto dim" data-test="${esc(h.url)}">测试</button>`;
        } else if (t?.state === 'fail') {
          tag = `<em class="tag-warn">（${esc(t.code ?? 'E1092')}）</em>`;
          sub = `<div class="sub">${esc(t.msg ?? '')}</div>`;
          action = `<button type="button" class="mini auto" data-test="${esc(h.url)}">重试</button>`;
        } else if (!h.persisted) {
          // 扫描来的行：UDP 应答本身就是"活着"的证明，直接可选
          if (h.joinable) {
            tag = '<em class="tag-ok">（可加入）</em>';
          } else if (stale) {
            tag = '<em class="tag-warn">（版本太旧）</em>';
            sub = '<div class="sub">那台班底版本太旧，先升级它再加入</div>';
          } else {
            tag = '<em class="tag-warn">（未开放加入）</em>';
            sub = '<div class="sub">这台班底没有对外开放加入（可能只在本机使用）。去那台机器上打开『允许局域网内的机器加入』→ 点重启</div>';
          }
        } else {
          // 通讯录里还没测过的行（刚「添加」的也在这档）：可以点「测试」验连接，
          // 也可以直接点「加入」—— 行上没说"可加入"不代表点不得，弹窗会把真实原因说清楚
          tag = '<em class="tag-warn">（未测试）</em>';
          action = `<button type="button" class="mini auto" data-test="${esc(h.url)}">测试</button>`;
        }
        /* 「加入」**一直显示**（2026-10-21 用户："加入按钮一直显示，点击加入，打开弹窗"）——
           以前它只在"测试通过/可加入"时才冒出来，用户得先猜哪行能点。现在每行都有，
           能不能加由弹窗里的第一次请求回答（连不上/没开放/版本旧都会把原因写回弹窗） */
        const joinBtn = `<button type="button" class="mini auto primary" data-join="${esc(h.url)}" data-label="${esc(h.label ?? '')}">加入</button>`;
        /* 点行仍可加入，但只对"扫描到且开放加入"的行开放 —— 其余行点一下就是加入弹窗，
           容易误触；行上的「加入」按钮已经够显眼 */
        const clickable = !h.persisted && h.joinable;
        return `<div class="row-item joinwiz-cand ${clickable || t?.state === 'ok' ? '' : 'off'}" ${clickable ? `data-pick="${esc(h.url)}" data-label="${esc(h.label ?? '')}" style="cursor:pointer"` : ''}>
          <div class="avatar">${esc(initial(h.label))}</div>
          <div class="who">
            <b>${esc(h.label)}${tag}</b>
            <div class="sub">${esc(h.hostname ?? '')}${h.hostname ? ' · ' : ''}${esc(h.url)}</div>
            ${sub}
          </div>
          <div class="row-acts">
            ${h.persisted ? `<button type="button" class="mini auto dim" data-remove="${esc(h.url)}">移除</button>` : ''}
            ${action}
            ${joinBtn}
            ${clickable ? '<span class="chev">›</span>' : ''}
          </div>
        </div>`;
      })
      .join('');
    box.innerHTML = `
      <div class="machine-join-head">
        <div class="machine-join-title">可用总机</div>
        <div class="machine-join-actions">
          <button type="button" class="btn-sm" data-w="refresh" ${wiz.scanning ? 'disabled' : ''}>发现</button>
          <button type="button" class="btn-sm primary" data-w="add">添加</button>
        </div>
      </div>
      <div class="joinwiz-cands">${
        rowsHtml ||
        '<div class="dim joinwiz-note">列表还是空的 —— 点「发现」找同一网络里的班底，或点「添加」直接填地址（云端也行）。</div>'
      }</div>
      ${
        wiz.scanning
          ? `<div class="joinwiz-scan">
              <div class="joinwiz-spin"></div>
              <div>正在找同一网络里的班底总机…</div>
              <div class="dim" data-sec>已经找了 0 秒 · 同一网络里的班底会自动应答</div>
              <div class="dim">总机在云端、或不在同一个网络时不会出现在这里 —— 点「添加」直接填它的地址</div>
            </div>`
          : ''
      }
      ${errLine()}`;
  };

  /* 列表页是**唯一的一页**：加入的「会改变什么 / 邀请码 / 加入中 / 成功」全都进了弹窗
     （2026-10-21 用户："加入按钮一直显示，点击加入，打开弹窗"），页面不再被步骤机换来换去。 */
  const render = () => {
    const box = document.createElement('div');
    box.className = 'joinwiz page';
    drawList(box);
    // 只重画内容层：面板挂载点（#joinMount）是常驻元素
    root.querySelector('.joinwiz')?.remove();
    root.appendChild(box);

    /* 统一接线：`data-w` 对到列表页自己的动作（发现 / 添加）。
       行内按钮（data-test / data-join / data-remove / data-pick）走各自的直接接线 ——
       「加入」现在只负责开弹窗，加入本体在弹窗里。 */
    const handlers = {
      refresh: () => { wiz.err = ''; runScan(); },
      add: openAddHostDlg,
    };
    box.querySelectorAll('[data-w]').forEach((el) => {
      const fn = handlers[el.dataset.w];
      if (fn) el.onclick = () => fn();
    });
    // 行内按钮：点行 = 加入弹窗（只对扫描到的、开放加入的行）；「加入」按钮每行都有
    box.querySelectorAll('[data-pick]').forEach((el) => {
      el.onclick = () => openJoinDlg(el.dataset.pick, el.dataset.label);
    });
    box.querySelectorAll('[data-join]').forEach((el) => {
      el.onclick = () => openJoinDlg(el.dataset.join, el.dataset.label);
    });
    box.querySelectorAll('[data-test]').forEach((el) => {
      el.onclick = () => doTest(el.dataset.test, el);
    });
    box.querySelectorAll('[data-remove]').forEach((el) => {
      el.onclick = () => doRemove(el.dataset.remove);
    });
  };

  /* 「测试」一行（通讯录里的行）：原地转圈 → 通过标「可加入」/ 失败显示原因 + 重试。
     它只回答"连得上吗"，【不代表】按钮才出现 —— 「加入」每行常显
     （2026-10-21 用户："加入按钮一直显示"）。 */
  async function doTest(url) {
    wiz.tested.set(url, { state: 'testing' });
    render();
    try {
      const r = await post(`${LOCAL_BASE}/hosts/test`, { url });
      wiz.tested.set(url, { state: 'ok', host: r?.host ?? null });
      render();
    } catch (err) {
      wiz.tested.set(url, { state: 'fail', code: err.code ?? 'E1092', msg: err.message });
      toast(err.message, 'error');
      render();
    }
  }

  /**
   * 「添加」= 一个**小弹窗**（2026-10-21 用户："点击添加，打开弹窗，填写之后，完成添加"）。
   * 为什么这里又用弹窗：它不是页面的主体内容，只是"补一条地址"的一次性输入 ——
   * 填地址 + 两个按钮塞进一行会把列表页撑乱；而加入流程（列表/说明/用途）仍留在页面上。
   *
   * 服务端 `hosts/add` 现在**填了就入列**（不拦探测），所以这里成功后不预设"可加入"：
   * 行按「未测试」画，用户点行上的「测试」验连接 —— 这正是用户要的操作顺序。
   */
  function openAddHostDlg() {
    const dlg = document.createElement('dialog');
    dlg.className = 'joinwiz-dlg';
    const form = document.createElement('form');
    form.method = 'dialog';
    form.innerHTML = `
      <b>添加总机</b>
      <div class="joinwiz">
        <label for="joinAddUrl">总机地址</label>
        <input id="joinAddUrl" spellcheck="false" autocomplete="off" placeholder="http://192.168.1.9:8787 或 https://bandi.example.com" />
        <div class="dim joinwiz-note">局域网或云端都行。添加后用它那行的「测试」验连接。</div>
        <div class="joinwiz-err" id="joinAddErr" hidden></div>
        <div class="dlg-actions">
          <button type="button" value="cancel">取消</button>
          <button type="button" class="primary" id="joinAddOk">完成添加</button>
        </div>
      </div>`;
    dlg.append(form);
    document.body.append(dlg);
    wireDialogHead(form); // 动态建的弹窗自己包一次吸顶头（标题 + ×）
    const input = form.querySelector('#joinAddUrl');
    const errEl = form.querySelector('#joinAddErr');
    const okBtn = form.querySelector('#joinAddOk');

    const submit = async () => {
      const url = input.value.trim();
      if (!url) {
        errEl.hidden = false;
        errEl.textContent = '先填一个地址，例如 http://192.168.1.9:8787';
        input.focus();
        return;
      }
      okBtn.disabled = true;
      errEl.hidden = true;
      try {
        const r = await post(`${LOCAL_BASE}/hosts/add`, { url });
        wiz.hosts = Array.isArray(r?.hosts) ? r.hosts : wiz.hosts;
        wiz.tested.delete(r?.host?.url ?? url); // 入列但没测过 → 行上出「测试」
        dlg.close();
        render();
      } catch (err) {
        errEl.hidden = false;
        errEl.textContent = err.message;
        okBtn.disabled = false;
      }
    };
    okBtn.onclick = submit;
    // 回车 = 完成添加（method=dialog 的默认提交会直接关窗丢输入，必须自己拦）
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
    dlg.addEventListener('close', () => dlg.remove());
    dlg.showModal();
    input.focus();
  }

  /* 从通讯录移除一台（扫描来的临时行没有这个按钮 —— 它们本来就不落盘）。 */
  async function doRemove(url) {
    try {
      const r = await post(`${LOCAL_BASE}/hosts/remove`, { url });
      wiz.hosts = Array.isArray(r?.hosts) ? r.hosts : wiz.hosts.filter((h) => h.url !== url);
      wiz.tested.delete(url);
    } catch (err) {
      toast(err.message, 'error');
    }
    render();
  }

  /* 从列表选中一台（扫描行点选 / 通讯录行「加入」）→ 先探再进 explain。
     这次探测就是加入前的最后一道闸：列表状态和真实状态之间有时间差
     （刚关了开关 / 那台刚关机），在这里被拦下比走到一半失败好。 */
  /**
   * 「加入」= 弹窗（2026-10-21 用户："加入按钮一直显示，点击加入，打开弹窗"）。
   * 为什么进弹窗：加入前得先讲清"会改变什么"、再填邀请码，这是**一次性的确认**；
   * 塞在列表里会把"找哪台机器"这件事挤走，所以整块挪进 dialog，列表页永远原地不动。
   *
   * 为什么不先 probe：能不能加由服务端 `/join` 直接回答（连不上 E1092 / 未开放 E1091 /
   * 版本太旧 E2050 / 邀请码不对 E4011），失败原因写在弹窗里、码留着改就行 ——
   * 多探一次只是多等一次，判定标准却是同一个。名字从行上带过来，不必等 probe 才知道是谁。
   */
  function openJoinDlg(url, label) {
    wiz.url = url;
    const host = label || '那台班底';
    const dlg = document.createElement('dialog');
    dlg.className = 'joinwiz-dlg';
    const form = document.createElement('form');
    form.method = 'dialog';
    form.innerHTML = `
      <b>邀请码（10 分钟内有效，只能用一次）</b>
      <div class="joinwiz">
        <input id="joinCode" spellcheck="false" autocomplete="off" aria-label="邀请码" placeholder="bj_" value="${esc(wiz.code)}" />
        <div class="joinwiz-hint">加入后，这台电脑就是「${esc(host)}」的算力节点：总机把活派过来，在这台电脑上跑。</div>
        <div class="joinwiz-err" id="joinErr" hidden></div>
        <div class="dlg-actions">
          <button type="button" value="cancel">取消</button>
          <button type="button" class="primary" id="joinOk">加入</button>
        </div>
      </div>`;
    dlg.append(form);
    document.body.append(dlg);
    wireDialogHead(form); // 动态建的弹窗自己包一次吸顶头（标题 + ×）

    const codeEl = form.querySelector('#joinCode');
    const errEl = form.querySelector('#joinErr');
    const okBtn = form.querySelector('#joinOk');
    const showErr = (msg) => { errEl.hidden = false; errEl.textContent = msg; };

    okBtn.onclick = async () => {
      wiz.code = codeEl.value;
      if (!wiz.code.trim()) {
        showErr(`先填邀请码 —— 在「${host}」上：设置 → 这台机器 → 添加设备`);
        codeEl.focus();
        return;
      }
      errEl.hidden = true;
      okBtn.disabled = true;
      okBtn.textContent = '加入中…';
      try {
        const r = await post(`${LOCAL_BASE}/join`, { url, code: wiz.code.trim() });
        drawJoined(form, r?.hostLabel || host);
      } catch (err) {
        showErr(err.message); // E4011 码不对 → 就地改码再点，不用关弹窗
        okBtn.disabled = false;
        okBtn.textContent = '加入';
      }
    };

    dlg.addEventListener('close', () => dlg.remove());
    dlg.showModal();
    codeEl.focus();
  }

  /* 加入成功：同一个弹窗换成"落地说明 + 完成"（点完成等它重绑完再刷，别撞上白屏断口） */
  function drawJoined(form, host) {
    const n = Number(wiz.status?.local?.counts?.personas ?? 0);
    form.innerHTML = `
      <b>加入成功</b>
      <div class="joinwiz">
        <div class="joinwiz-text joinwiz-ok">✓ 这台电脑现在是「${esc(host)}」的算力节点了</div>
        <ul class="joinwiz-list">
          <li>总机把活派过来，在这台电脑上跑（节点已在后台常驻）</li>
          <li>这台电脑的班底界面从此只显示节点状态，不显示面板</li>
          <li>本机原来的 ${n} 个员工还在本机，没动过</li>
        </ul>
        <div class="dlg-actions">
          <button type="button" class="primary" id="joinDone">完成</button>
        </div>
      </div>`;
    form.querySelector('#joinDone').onclick = async () => {
      /*
       * 加入成功那一刻服务端会把监听**收回环**（见 `/api/local/join`），重绑有几毫秒断口。
       * 点「完成」先等它答话再刷，别让人正好撞上重绑白屏。
       */
      for (let i = 0; i < 40; i++) {
        try {
          if ((await fetch(`${LOCAL_BASE}/status`, { cache: 'no-store' })).ok) break;
        } catch {
          /* 重绑中 */
        }
        await new Promise((done) => setTimeout(done, 100));
      }
      location.reload();
    };
  }

  render(); // 不自动扫（2026-10-21 用户："去掉自动刷新探测，手动探测"）——
  // 进页只画「通讯录 + 空列表提示」，扫描由「发现」按钮触发，用户点一次才发一次 UDP。
}

/**
 * 远程节点的详情页 —— **一颗能按的按钮都不给**。
 *
 * 为什么不让它走下面那套本机交互：那一页上每颗开关干的都是"改**这台机器**上的运行时配置"
 * （写的是控制面进程所在的 `data/runtimes.json`）。对着一个远程节点按下去，
 * 改的其实是控制面这台机器，而界面上写的是那台机器 —— 语义就错了。
 * 所以这一版只回答两件事：它是什么、它自报装了什么。
 */
/**
 * 设备头那块：**大标题是人给它的名字，小字回真实主机名**。
 *
 * 为什么两个都显示：机器名可以是人随口起的（两台都叫「办公机」很正常），主机名不会重。
 * 改完名还能一眼认出是哪台，靠的就是下面那行小字。
 *
 * 为什么要有「重命名机器」：运行时下拉里显示的是**机器名**（`Codex CLI（我的笔记本）`），
 * 就叫 `DESKTOP-XXXXXXX` 的话，两台机器的条目在员工配置里根本分不出来。
 */
function devHeadHtml(dev, { badges = '', sub = '', actions = '' } = {}) {
  const host = dev.hostname ?? '';
  return `<div class="dev-head">
    <div class="dev-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
        <rect x="2.5" y="4" width="19" height="13" rx="2" />
        <path d="M8.5 20.5h7M12 17v3.5" stroke-linecap="round" />
      </svg>
    </div>
    <div class="dev-meta">
      <div class="dev-title">${esc(dev.label)}${badges}</div>
      <div class="dev-sub">${host ? esc(host) + (sub ? ' · ' : '') : ''}${sub}</div>
    </div>
    <div class="dev-actions">
      <button class="btn-sm" id="renameDevice" title="给它起个好认的名字 —— 员工选运行时时显示的就是这个">重命名机器</button>
      ${actions}
    </div>
  </div>`;
}

/**
 * 班的「问一句」/「确认一下」—— 替代原生 `prompt()` / `confirm()`。
 *
 * 为什么不用原生的（2026-10-16 用户指着改名那个框说"改成弹窗组件"）：原生框是**浏览器**画的，
 * 标题栏里印着 `127.0.0.1:8787 显示`，跟班底长得不是一个东西；也没法用班底自己的措辞、
 * 说明文字和"破坏性操作"那种红色按钮。
 *
 * 一个 dialog 管两件事：给了 `field` 就要一段文字（有输入框），不给就只要一个是/否。
 * 返回值刻意跟原生对齐，好替换：**取消 = null**；确定 = 输入框里的字符串（确认类则是空串）。
 */
/**
 * 弹窗正文里的 `**强调**` → 粗体。
 *
 * 为什么要有（2026-10-16 截图时发现的）：我在这些正文里写了 `**一次性**` 这种强调，
 * 而它们是按 `textContent` 渲染的 → **星号原样显示出来** ✗（好几处弹窗都这样）。
 * **先转义再替换** —— 正文里会有用户起的名字、路径，不能直接当 HTML 塞进去。
 */
function rich(s) {
  return esc(String(s ?? '')).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
}

function askDialog({ title, body = '', field = false, value = '', placeholder = '', check = null, ok = '确定', danger = false }) {
  const dlg = $('askDlg');
  $('askTitle').textContent = title;
  const bodyEl = $('askBody');
  bodyEl.innerHTML = rich(body);
  bodyEl.style.display = body ? '' : 'none';
  const wrap = $('askField');
  wrap.style.display = field ? '' : 'none';
  const input = $('askInput');
  input.value = value;
  input.placeholder = placeholder;
  // 勾选框（可选）：让"要不要走镜像"变成一个勾，而不是让用户去填地址
  // ⚠️ 用 `block` + 左对齐：弹窗那个 <form> 本身是居中的，勾选框要是只顾着 flex
  // 就会被摆到文字上面或右边去（这个位置我调了两次才落对）
  const checkWrap = $('askCheckWrap');
  checkWrap.style.display = check ? 'block' : 'none';
  if (check) {
    $('askCheckLabel').textContent = check.label ?? '';
    $('askCheck').checked = !!check.checked;
  }
  const okBtn = $('askOk');
  okBtn.textContent = ok;
  okBtn.className = `primary${danger ? ' danger' : ''}`;
  return new Promise((resolve) => {
    // Esc 关掉时 returnValue 是空串 → 一律算取消（跟原生一致）
    dlg.onclose = () =>
      resolve(
        dlg.returnValue === 'ok'
          ? { ok: true, text: field ? input.value : '', checked: check ? $('askCheck').checked : false }
          : { ok: false, text: '', checked: false },
      );
    dlg.returnValue = '';
    dlg.showModal();
    if (field) setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

/** 要一段文字。取消返回 null —— 跟 `prompt()` 对齐 */
const askText = async (o) => {
  const r = await askDialog({ ...o, field: true });
  return r.ok ? r.text : null;
};

/** 只要一个是/否。返回 true / false —— 跟 `confirm()` 对齐 */
const askConfirm = async (o) => (await askDialog({ ...o, field: false })).ok;

/**
 * `confirm('一句话')` 的**直接替代**（2026-10-18）：原生 confirm 是浏览器自带弹窗，用户要求不用。
 *
 * 跟 `askConfirm` 的分工：想好了标题和正文的用它；这里只要一句话 —— 正文就是那句话，
 * 标题给个中性的「确认一下」。**调用处记得 `await`**（返回 Promise，不是布尔值）。
 */
const confirmDo = async (text, opts = {}) =>
  askConfirm({ title: opts.title ?? '确认一下', body: String(text ?? ''), ok: opts.ok ?? '确定', danger: opts.danger ?? true });

/**
 * 一个勾选框 + 一个是/否。返回 `{ok, checked}`。
 *
 * 专门给"走不走镜像"这类**用户只需要表态、不需要知道细节**的选择用
 * （2026-10-16 用户提的：普通用户不知道镜像地址，就不该让他填地址）。
 */
const askCheckbox = (o) => askDialog({ ...o, field: false });

/**
 * 接上改名。**名字跟主机名是两回事**：这里只改名字，主机名是那台机器自报的事实，动不了。
 * 留空 = 恢复默认（回到主机名）。
 */
function wireRenameDevice(dev) {
  const btn = $('renameDevice');
  if (!btn) return;
  btn.onclick = async () => {
    const next = await askText({
      title: '给这台机器起个名字',
      body: `主机名：${dev.hostname ?? dev.label}\n（留空 = 恢复成主机名）`,
      value: dev.renamed ? dev.label : '',
      placeholder: '留空就用主机名',
    });
    if (next === null) return; // 取消
    try {
      await post(`/api/devices/${encodeURIComponent(dev.id)}/rename`, { label: next });
      renderRuntimes(); // 重渲染：名字、面包屑、运行时的显示名一起跟上
    } catch {
      /* api() 已经提示过了 */
    }
  };
}

/**
 * 「复制」按钮：文案从 `data-copy` 取，复制完显示「已复制」再还原。
 *
 * 抽出来是因为**两页都要用**（本机设备页、远程节点页）—— 同一段逻辑各写一份，
 * 迟早只修其中一份（前端的"两套"就是这么来的）。
 */
function wireCopyButtons() {
  $('settingsView').querySelectorAll('[data-copy]').forEach((el) => {
    const label = el.textContent;
    el.onclick = async () => {
      try {
        await navigator.clipboard.writeText(el.dataset.copy);
        el.textContent = '已复制';
        setTimeout(() => { el.textContent = label; }, 1500);
      } catch {
        toast('复制不了，手动选中吧：\n\n' + el.dataset.copy);
      }
    };
  });
}

/**
 * 一个运行时的**健康度** —— Multica 那张表叫「健康度」，这里按机器诚实分：
 *
 *   · **本机**运行时：健康 = **这个 CLI 现在能不能起**（文件在、班底起得来、已接入）。
 *     标签统一走「在线/离线」一套词（2026-10-21 用户："可用改成在线，不可用改成离线"）——
 *     原先"本机没有在线这回事"的讲究让位给词汇一致：状态列只有一套语言最好读。
 *   · **远程**运行时：健康 = **那台机器在不在线**（心跳新鲜）＋ 它自报这个 CLI 能不能用。
 *     这个才是用户真正要看的：选了一个离线节点的运行时，活不会立刻跑，而是排进队列等它回来。
 *
 * `showPath`：**要不要把那行路径摆出来**。只有"路径本身出问题"才摆（2026-10-16 用户提的：
 * 健康时那行长路径是纯噪音）。「已停用 / 还没接入」也不摆 —— 要不要接看的是右边那个开关，
 * 不是路径。平时想看完整路径：悬停有 title，点进名字是 CLI 详情页（那儿本来就摆着路径 + 检测）。
 *
 * ⚠️ 判据一律 `=== false`，不能写 `!field`：旧后端没有这个字段时，`!undefined` 会把
 * 健康的行全染红（这条真踩过，见 git 历史里 rowOfRuntime 那段注释）。
 *
 * ⚠️ 这两个函数必须放在**模块作用域**（2026-10-16 踩到）：我一度把它们插进了
 * `renderDeviceDetail` 的函数体里 —— 本机页能用，**节点页直接 `runtimeHealth is not defined`**，
 * 而页面只是停在"加载中"，从截图上根本看不出抛了什么（`--dump-dom` 里 `<title>` 才看到）。
 */
function runtimeHealth(r) {
  // 路径本身有问题 —— 这两种**必须**把路径摆出来，否则不知道该改哪个
  if (r.pathExists === false) {
    return { text: '路径失效', cls: 'tag-warn', why: '记的这个位置已经没那个文件了', showPath: true };
  }
  if (r.launchable === false) {
    return {
      text: '班底起不来',
      cls: 'tag-warn',
      why: '文件在，但班底起不动它（.cmd/.bat 那种脚本不能直接启动）',
      showPath: true,
    };
  }
  if (!r.enabled) return { text: '已停用', cls: 'tag-warn', why: '关掉了就不派活给它' };
  if (r.remote) {
    return r.nodeOnline === false
      ? { text: '离线', cls: 'tag-warn', why: '那台机器没有心跳 —— 派给它的活会排队等它回来，不会立刻跑' }
      : { text: '在线', cls: 'tag-ok', why: '那台机器在心跳，派活会立刻被它领走' };
  }
  return { text: '在线', cls: 'tag-ok', why: '文件在、班底起得来 —— 控制面就在这台机器上，本机运行时只有"离线"的反面' };
}

/** 健康度那枚小标（跟在名称后面） */
function healthTag(r) {
  const h = runtimeHealth(r);
  return `<em class="${h.cls}" title="${esc(h.why)}">${esc(h.text)}</em>`;
}

/**
 * 「路径已自动更正」那枚标。
 *
 * 为什么要有：CLI 升级后路径会变（npm 的 `claude.cmd` → 包里的 `bin\claude.exe`），
 * 而班底记的是"接进来那一刻"的路径 —— 那条就失效了。班底会**自己切到探测到的那个**，
 * 但**改了别人的配置就得说一声**，否则用户只会发现路径被悄悄改了。
 */
function healedTag(r) {
  if (!r.healedFrom) return '';
  return `<em class="tag-ok" title="${esc(
    `原来记的「${r.healedFrom}」已经不能用了，班底自动切到了现在这个。你自己手工改一次路径，这枚标就消失。`,
  )}">路径已更正</em>`;
}

/**
 * 那台机器上**正在跑**的那件小事（装运行时 / 装外部件），针对某个目标。
 *
 * 为什么从 `dev.task` 读、而不是靠点击时那个闭包（2026-10-16 用户报的"刷新页面，看不到安装进度了"）：
 * 进度原来是**浏览器里的临时状态** —— 一刷新就没了，可那件事其实还在那台机器上跑着。
 * 按这条架构一贯的原则（**状态在服务端**），它得能从服务端读回来：刷新、换台电脑、明天再看，都还是它。
 */
function runningTaskFor(dev, target) {
  const t = dev.task;
  if (!t || t.done || t.family !== target) return null;
  return t;
}

/** 任务输出的最后一行（界面上就显示这一行，够用又不吵） */
function taskTail(task) {
  return (task?.output ?? '').trim().split('\n').filter(Boolean).slice(-1)[0] ?? '';
}

/**
 * 失败时该显示哪一行。
 *
 * ⚠️ 不能直接用最后一行（2026-10-16 用户报的："（sh 退出码 1）这个报错重装怎么还有"）：
 * 我让节点在收尾时补了一行 `（退出码 N）` —— 那是**我自己加的**，真正的错因在它**上面**几行
 * （比如 `magpie: could not download …`、`起不来：spawn magpie ENOENT`），
 * 结果界面上只显示了那行没用的，有用的被塞进悬停里 ✗。
 * 所以这里跳过"我自己补的那种行"（整行被括号包住的），挑**最后一行像错因的**。
 */
function taskFailLine(task) {
  const lines = (task?.output ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const mine = /^（.*）$/; // 我自己补的：`（sh 退出码 1）`
  const good = lines.filter((l) => !mine.test(l));
  return (good.length ? good[good.length - 1] : lines[lines.length - 1]) ?? '';
}

/** 失败发生在什么时候（本地时分）—— 让"这次刚失败"和"上次的旧失败"分得出来 */
function failAt(task) {
  const t = task?.endedAt ? new Date(task.endedAt) : null;
  if (!t || Number.isNaN(t.getTime())) return '';
  const mins = Math.round((Date.now() - t.getTime()) / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  return t.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

/**
 * 有活在做就**接着盯**，但**只就地改进度那一行** —— 不整页重画。
 *
 * ⚠️ 为什么必须这样（2026-10-16 用户报的"页面在不停刷新"）：第一版我让它在跑的时候每 2 秒
 * 整页重画一次，看着就是"页面不停刷新"，滚动位置、展开状态全被打回去 ✗。
 * 进度是**一小段文字**的事，就只改那一小段文字：`textContent` 换掉，别的一动不动。
 * 只有**做完**那一刻才整页重画一次 —— 因为那一行要从「未安装」挪到「已安装」去。
 */
function scheduleTaskPoll(dev) {
  const t = dev?.task;
  if (!t || t.done) return;
  if (S.rtLevel !== 'device' || S.rtDevice !== dev.id) return;
  clearTimeout(S.taskPoll);
  S.taskPoll = setTimeout(async () => {
    if (S.rtLevel !== 'device' || S.rtDevice !== dev.id) return;
    let next;
    try {
      // 只取这一件活的进度（一条小请求），不重画整页
      next = (await api(`/api/nodes/${encodeURIComponent(dev.id)}/tasks/${encodeURIComponent(t.id)}`)).task;
    } catch {
      return;
    }
    if (!next) return;
    if (next.done) {
      renderRuntimes(); // 做完才整页重画：那一行要挪位置、按钮要换
      return;
    }
    const text = `${next.running ? '进行中… ' : '排队中… '}${taskTail(next) || '（等那台机器来领）'}`;
    for (const el of document.querySelectorAll(`[data-task-line="${t.id}"]`)) el.textContent = text;
    scheduleTaskPoll({ ...dev, task: next }); // 接着盯
  }, 1500);
}

/**
 * 「外部件」那一段 —— 一台机器上**班底之外还要有的东西**（现在只有 magpie）。
 *
 * 为什么要单独摆出来（2026-10-16 用户提的）：它是"这台机器能不能干活"的**前提**，
 * 之前这个前提是隐形的 —— 装好了没人告诉你，没装 / 网关没起也不会提醒，
 * 只会在派活之后看到一串 502。
 *
 * 判定就三条，**不 import、不解析它的配置文件**（这样它怎么更新都不用动我们）：
 * ① 命令在不在（装了没）② 网关端口通不通 ③ 那台机器能不能一键装（命令表在**节点**那侧）。
 */
function externalsHtml(dev) {
  const ex = dev.externals;
  if (!ex?.catalog?.length) return '';
  const probed = new Map((ex.probed ?? []).map((p) => [p.id, p]));
  const rows = ex.catalog
    .map((c) => {
      const p = probed.get(c.id) ?? { installed: false, gateway: null, panel: null };
      // 装了但网关没起，是最坑的状态：被它接管的 agent 会全线 502
      const health = !p.installed
        ? { text: '未安装', cls: 'tag-warn', why: '这台机器上还没装上它' }
        : c.gatewayPort && p.gateway === false
          ? { text: `网关没起（${c.gatewayPort}）`, cls: 'tag-warn', why: '装了但网关没在跑 —— 被它接管的 agent 会连不上，报 502' }
          : c.gatewayPort
            ? { text: '在线', cls: 'tag-ok', why: `网关在 ${c.gatewayPort} 上跑着` }
            : { text: '装了', cls: 'tag-ok', why: '命令在' };
      /*
       * 面板：**界面是它自己的，我们只放入口**（2026-10-16 定的）。
       * 所以这里不给"面板内容"，只给"起没起" ＋ 一条从局域网能打开的链接。
       * 面板自己有访问密钥（magpie 生成、跨重启保留），所以链接可能需要再点一次（或在它那边取带密钥的链接）。
       */
      const panelBadge =
        c.panelPort && p.installed
          ? p.panel
            ? `<em class="tag-ok" title="面板在 ${c.panelPort} 上跑着">面板已开</em>`
            : `<em class="tag-warn" title="装了但面板没跑 —— 在那台机器上跑 magpie daemon install --web --lan 就会常驻，开机自己起">面板没起</em>`
          : '';
      const oneClick = c.installCmd && dev.kind === 'node';
      const serve = c.serveCmd && dev.kind === 'node';
      const busy = runningTaskFor(dev, c.id);
      /*
       * 上一次**没成**的那件事 —— 也摆出来。
       *
       * 为什么要有（2026-10-16 用户停了安装、回来重看时发现的）：失败之后那一行原本什么都不说 ✗
       * （按钮回来了，可你不知道上次为什么没成 —— 只能去翻控制面的日志）。
       * 失败是**做过的事**，就该留在那儿：鼠标悬停还有完整输出。
       */
      const lastFail = !busy && dev.task?.done && dev.task.status !== '完成' && dev.task.family === c.id ? dev.task : null;
      return `<div class="row-item ${health.cls === 'tag-ok' ? '' : 'off'}" data-ext-row="${esc(c.id)}">
        ${cliAvatar(c.id, c.label)}
        <div class="who">
          <b>${esc(c.label)}<em class="${health.cls}" title="${esc(health.why)}">${esc(health.text)}</em>${panelBadge}</b>
          ${
            /*
             * 描述那行直接摆**它自己的官网**（2026-10-16 用户提的）：
             * 免得人误以为 magpie 是班底的产品 —— 它是个独立的开源工具，我们只是"认得它、能帮你装它"。
             * 原来那段"把各 agent 的请求转给你配的供应商…"挪到悬停里（想了解的人还能看）。
             */
            c.home
              ? `<div class="sub"><a href="${esc(c.home)}" target="_blank" rel="noreferrer" title="${esc(c.note ?? '')}" style="font-family:ui-monospace,monospace;font-size:11.5px">${esc(
                  c.home,
                )}</a></div>`
              : `<div class="sub">${esc(c.note ?? '')}</div>`
          }
          ${p.installed && p.where ? `<div class="sub" style="font-family:ui-monospace,monospace;font-size:11.5px">装在 ${esc(p.where)}</div>` : ''}
          <div class="sub install-log" style="display:none;font-family:ui-monospace,monospace;font-size:11.5px"></div>
          ${
            /*
             * 刷新页面之后进度也还在：直接读服务端那件正在跑的活。
             * `data-task-line` 是给"接着盯"用的：只**就地改这一行的文字**，不重画整页
             * （2026-10-16 用户报的"页面在不停刷新"就是整页重画闹的）。
             */
            busy
              ? `<div class="sub install-log" data-task-line="${esc(busy.id)}" style="display:block;font-family:ui-monospace,monospace;font-size:11.5px">${
                  busy.running ? '进行中… ' : '排队中… '
                }${esc(taskTail(busy) || '（等那台机器来领）')}</div>`
              : lastFail
                ? `<div class="sub" title="${esc(lastFail.output)}" style="color:var(--bad);font-size:11.5px">上次没成（${esc(
                    failAt(lastFail),
                  )}）：${esc(taskFailLine(lastFail) || '（没输出）')}（悬停看全部）</div>`
                : ''
          }
        </div>
        ${
          // 入口只在**面板真跑着**、而且我们知道一个能连上的地址时才给（不然点开是空白/401）
          c.panelPort && p.panel && p.panelUrl
            ? `<a class="mini auto" href="${esc(p.panelUrl)}" target="_blank" rel="noreferrer" title="在浏览器里打开它自己的面板（${esc(
                p.panelUrl,
              )}）—— 链接里带着访问密钥，点开就是已登录。⚠️ 这条链接等于那台机器上 magpie 的控制权（能改模型、看到密钥），而且是明文 HTTP：别外传；要更稳就在它那边配 --tls-cert/--tls-key。">打开面板</a>`
            : ''
        }
        ${
          /*
           * 外部件那颗按钮 —— **按状态给，只给一颗**（2026-10-16 用户定的）：
           *   · 没装                     → 「安装」：装了**自动**把服务也设好（用户不需要知道"常驻"是什么）
           *   · 装了但没跑起来            → 「重启」：把它拉起来（比"重装"轻，语义也对）
           *   · 上次失败过               → 「重装」：重走一遍安装 + 服务
           *   · 一切正常（网关或面板应答）→ **不给按钮**（装好了还杵着东西，人会以为还有事没做完 ✗）
           * 具体跑什么命令放悬停里：想知道的人能看，普通用户不用看。
           */
          busy
            ? '<span class="dim" style="font-size:11.5px">进行中…</span>'
            : p.installed && (p.gateway === true || p.panel === true)
              ? ''
              : oneClick || serve
                ? lastFail || !p.installed
                  ? `<button class="mini auto primary" data-ext-do="external-setup" data-ext-id="${esc(c.id)}" title="会在那台机器上依次跑：${esc(
                      [!p.installed ? c.installCmd : null, c.serveCmd].filter(Boolean).join('  →  '),
                    )}">${lastFail ? '重装' : '安装'}</button>`
                  : `<button class="mini auto primary" data-ext-do="external-serve" data-ext-id="${esc(c.id)}" title="它装着，但网关和面板都没在跑 —— 点一下把它拉起来（会在那台机器上跑：${esc(
                      c.serveCmd ?? '',
                    )}）">重启</button>`
                : c.installCmd && !p.installed
                  ? `<button class="mini auto" data-copy="${esc(c.installCmd)}">复制安装命令</button>`
                  : /* 已经装了、这个平台又没有"一条命令"（Windows 桌面安装包）—— 什么都不给 */
                    ''
        }
      </div>`;
    })
    .join('');
  return `<section class="fx" style="margin-top:26px">
      <label>外部件 <span class="count">${rows ? ex.catalog.length : 0}</span></label>
      ${rows}
    </section>`;
}

/**
 * 远程节点的详情页 —— 有几颗按钮，但**都是这台机器自己的事**（改名 / 忘掉），
 * 没有一颗会去改那台机器上的运行时配置（路径是那台机器上的事实，改不了，也不该假装能改）。
 *
 * 2026-10-16 起这里也分**已安装 / 未安装**：原来没探到就一句"一个都没探到"，
 * 等于把"该怎么办"藏起来了 —— 用户看到的是一台空机器，而不是"这三个里你一个都还没装，
 * 装上哪条命令在这"。判断依据是**节点自报的清单**（不是控制面本机的探测：那是两台机器）。
 */
async function renderNodeDetail(dev) {
  // 左栏只写「设置」（在 openSettings 里）；这台机器的名字/状态/动作都在正文的 devHeadHtml 里，
  // 右页头不再重复一遍。
  const rts = dev.runtimes ?? [];
  // 族清单拉不到就不显示"未安装"那一段 —— 但这一页照常渲染，别因为一个附加块白屏
  let families = [];
  try {
    families = (await api('/api/runtime-families')).families ?? [];
  } catch {
    /* 忽略：下面按空处理 */
  }
  const haveFamily = new Set(rts.map((r) => r.family));
  const missing = families.filter((f) => !haveFamily.has(f.id));
  const isWin = /win/i.test(dev.platform ?? '');

  // 工作空间映射清单（2026-10-22）：拉不到就不显示已有条目，表单照常给
  let wsPaths = [];
  try {
    wsPaths = (await api(`/api/nodes/${encodeURIComponent(dev.id)}/paths`)).paths ?? [];
  } catch {
    /* 忽略：老版本服务没有这条路由 */
  }
  /** 映射列表的行（添加/删除后重画用同一份；⚠️ 必须声明在 innerHTML 那句之前 —— 模板串要用它） */
  const wsRowsHtml = (paths) =>
    paths.length
      ? paths
          .map(
            (p) => `<div class="row-item">
              <div class="who">
                <b style="font-family:ui-monospace,monospace;font-size:11.5px">${esc(p.remotePath)}</b>
                <div class="sub" style="font-family:ui-monospace,monospace;font-size:11.5px">→ ${esc(p.localPath)}</div>
              </div>
              <button class="mini auto txt" data-ws-del="${esc(p.remotePath)}">删除</button>
            </div>`,
          )
          .join('')
      : '<div class="empty">还没配映射 —— 需要在这台机器上干非 git 项目时再配</div>';

  const rowOfMissing = (f) => {
    /*
     * dsh 是 Windows 桌面端自带的，Linux/macOS 上根本没有那个形态 ——
     * 摆一条装不了的命令比不摆更糟（他会去试，然后回来问为什么不行）。
     */
    const cmd = f.install?.kind === 'app' && !isWin ? null : (f.install?.cmd ?? null);
    // 只有 npm 那种**能一键装**：dsh 要靠装桌面端，不是一条命令能解决的事，不给按钮
    const oneClick = f.install?.kind === 'npm' && !!cmd;
    const busy = runningTaskFor(dev, f.id);
    // 上次没成的那件（同外部件那行：失败也要留痕，不然用户不知道上次为什么没成）
    const lastFail = !busy && dev.task?.done && dev.task.status !== '完成' && dev.task.family === f.id ? dev.task : null;
    return `<div class="row-item off" data-rt-row="${esc(f.id)}">
      ${cliAvatar(f.id, f.label)}
      <div class="who">
        <b>${esc(f.label)}</b>
        ${
          cmd
            ? `<div class="sub" style="font-family:ui-monospace,monospace;font-size:11.5px">${esc(cmd)}</div>`
            : '<div class="sub">这台机器上装不了（它是 Windows 桌面端自带的）</div>'
        }
        <!-- 安装进度就写在这儿（点击之后才出现），不另开弹窗 -->
        <div class="sub install-log" style="display:none;font-family:ui-monospace,monospace;font-size:11.5px"></div>
        ${
          // 刷新页面之后进度也还在 —— 从服务端那件正在跑的活读回来（见 runningTaskFor）。
          // `data-task-line` 让"接着盯"只需就地改这一行，不用整页重画。
          busy
            ? `<div class="sub" data-task-line="${esc(busy.id)}" style="font-family:ui-monospace,monospace;font-size:11.5px">${
                busy.running ? '进行中… ' : '排队中… '
              }${esc(taskTail(busy) || '（等那台机器来领）')}</div>`
            : lastFail
              ? `<div class="sub" title="${esc(lastFail.output)}" style="color:var(--bad);font-size:11.5px">上次没成（${esc(
                  failAt(lastFail),
                )}）：${esc(taskFailLine(lastFail) || '（没输出）')}（悬停看全部）</div>`
              : ''
        }
      </div>
      ${
        busy
          ? '<span class="dim" style="font-size:11.5px">进行中…</span>'
          : oneClick
            ? `<button class="mini auto primary" data-install-rt="${esc(f.id)}" data-cmd="${esc(cmd)}">在这台机器上安装</button>`
            : ''
      }
      ${cmd ? `<button class="mini auto" data-copy="${esc(cmd)}">复制命令</button>` : ''}
    </div>`;
  };

  $('settingsView').innerHTML = `
    ${headRow(breadcrumb([{ label: '这台机器', to: 'devices' }, { label: dev.label }]))}
    <div class="detail-body">
      ${devHeadHtml(dev, {
        badges: `<span class="${dev.online ? 'pill-ok' : 'pill'}">${dev.online ? '在线' : '离线'}</span><span class="pill">远程节点</span>`,
        sub: `${esc(dev.platform)} · ${dev.runtimeCount} 个 agent CLI`,
        /*
         * 「忘掉这台」放在这儿（跟「重命名机器」并排）——它原来占页面底部一整段 ✗。
         * 说明进悬停：那台机器换过数据目录/身份文件丢了就会用新身份再报到一次，
         * 这一行会永远"离线"躺着，而它的运行时还挂在员工的下拉里。
         */
        actions: `<button class="btn-sm danger" id="forgetNode" title="忘掉这台机器：删掉控制面上这一条记录。那台机器什么都不受影响，而且它下一次心跳（15 秒内）就会自己重新报到 —— 身份、运行时都在，只有你给它起的名字会丢。只有"它永远不会再回来了"（比如你清掉了那台机器的数据目录、或换了一台机器）才需要忘掉它。">忘掉这台机器</button>`,
      })}
      <!--
        ⚠️ 这里原来有一行「上次心跳 …Z —— 每 15 秒一次，超过三个周期没过来就判离线」＋「远程节点（主动连出）」。
        2026-10-16 用户让删掉：**那是开发关心的事，用户不关心** ✓ ——
        用户只需要知道"在线还是离线"（左上角那个标记就是干这个的 ✓），
        心跳间隔、判离线的周期数、连出方向都是实现细节。
        （真要看这些的场合是排查故障 —— 后端日志和 /api/devices 里照样有 ✓。）
      -->
      ${
        /* 权限与「最近使用」（2026-10-20，P1-3 的一半）：两个字段都来自 GET /api/devices
           （runtimes.publicDevice 的节点分支），**没有就不渲染这一行** —— 别给用户看 "undefined"。 */
        dev.scope
          ? `<div class="sub machine-scope-line">${
              String(dev.scope).includes('panel')
                ? '这台能看到面板'
                : '这台看不到面板（总机没给面板权限）'
            }${dev.lastUsedAt ? ` · 最近使用 ${esc(dt(dev.lastUsedAt))}` : ''}</div>`
          : ''
      }

      <section class="fx">
        <!-- 跟本机那页一个词（「已安装」）—— 用户不关心"自报"这套机制 -->
        <label>已安装 <span class="count">${rts.length}</span></label>
        ${
          rts.length
            ? rts
                .map(
                  (r) => {
                    const h = runtimeHealth(r);
                    return `<div class="row-item ${h.cls === 'tag-ok' ? '' : 'off'}">
              ${cliAvatar(r.family ?? r.id, r.label)}
              <div class="who" title="${esc(r.path)}">
                <b>${esc(r.label)}${healthTag(r)}</b>
                ${h.showPath ? `<div class="sub">${esc(r.path)}</div>` : ''}
              </div>
            </div>`;
                  },
                )
                .join('')
            : `<div class="empty">它说本机一个 agent CLI 都没探到${missing.length ? ' —— 看下面「未安装」那段' : ''}</div>`
        }
        <!--
          这里原来还有一段说明（"这些条目能派活…但不能在这儿改：路径是那台机器上的事实…
          控制面也不会在本机起它们 —— 那等于拿着一个只有那台机器才有的路径在这儿 spawn"）。
          2026-10-16 用户让删掉 ✓：那是在解释**我们为什么这么写**，不是在告诉用户**能干什么**。
          用户能看出来的部分（哪些装了什么）已经摆在上面了 ✓。
        -->
      </section>

      ${
        missing.length
          ? `<section class="fx" style="margin-top:26px">
               <label>未安装 <span class="count">${missing.length}</span></label>
               ${missing.map(rowOfMissing).join('')}
               <!--
                 这里原来还有一段说明（"有「在这台机器上安装」的点一下就行……控制面只把族名递过去，
                 所以这条通道递不出任意命令" ＋ "装完不用重启节点：每次心跳都会把清单报上来"）。
                 2026-10-16 用户让删掉 ✓ —— 半句是**我们内部的安全边界**，半句是**实现细节**，
          用户要的只是"这颗按钮能装、那台机器的清单会自己更新"（前者按钮上写着、后者看得见）✓。
                -->
             </section>`
          : ''
      }

      ${
        /* 工作空间（2026-10-22）：派到这台机器的活在它那儿落脚的两条路 ——
           git 仓库自动 clone/pull（不用配）；普通文件夹项目用这张映射表。
           列表拉不到就只显示表单（对面是老版本服务时也不至于白屏）。 */
        `<section class="fx" style="margin-top:26px">
          <label>工作空间${wsPaths.length ? ` <span class="count">${wsPaths.length}</span>` : ''}</label>
          <div class="sub" style="margin-bottom:10px">派到这台机器的活在这儿干活：git 仓库会自动克隆、拉最新（私有仓库在这台机器上 git 登录一次即可）；普通文件夹项目在下面配一条「总机目录 → 这台机器目录」。</div>
          <div id="wsRows">${wsRowsHtml(wsPaths)}</div>
          <div class="row-item" style="gap:8px;align-items:center">
            <input id="wsRemote" placeholder="总机上的目录，如 E:\\02CodeSpace\\proj" style="flex:1;min-width:0" />
            <span style="color:var(--dim)">→</span>
            <input id="wsLocal" placeholder="这台机器上的目录，如 D:\\work\\proj" style="flex:1;min-width:0" />
            <button class="mini auto primary" id="wsAdd">添加映射</button>
          </div>
        </section>`
      }

      ${externalsHtml(dev)}
    </div>`;

  /*
   * 「忘掉这台」挪到**头部**跟「重命名机器」并排（2026-10-16 用户提的：省点空间）。
   * 原来它是页面底部一整段（标题 ＋ 三段说明 ＋ 按钮）✗ —— 一个很少用到的破坏性操作
   * 占了一整块。现在说明挪进**悬停**和**确认框**里（点下去之前照样看得到，包括"身上还压着几个活"）。
   *
   * ⚠️ 这里的话**必须跟代码实际行为对上**（2026-10-16 用户问"能重新连回来吗"时发现的）：
   * 原来写的是"在那台机器上重新起一次节点就行（会得到新身份）" —— 那是**错的** ✗。
   * 实际是：节点下一次心跳/领活会拿到 404，它自己就重新报到了（15 秒内），
   * 而且用的是**同一个 id**（id 存在那台机器的数据目录里）—— 身份、运行时都回来，
   * 只有**名字**会丢（名字存在控制面这一侧）。会"得到新身份"的只有一种情况：
   * 那台机器上的数据目录被清掉/换了（身份文件没了）。
   */
  /* ---- 工作空间映射（2026-10-22）：增删走同一份行渲染，页面随时重画也不怕 ---- */
  const paintWs = (paths) => {
    const box = $('wsRows');
    if (box) box.innerHTML = wsRowsHtml(paths);
  };
  const wsAdd = $('wsAdd');
  if (wsAdd) {
    wsAdd.onclick = async () => {
      const remotePath = $('wsRemote').value.trim();
      const localPath = $('wsLocal').value.trim();
      if (!remotePath || !localPath) return toast('两边路径都要填：总机上的目录 + 这台机器上的目录', 'error');
      try {
        const r = await api(`/api/nodes/${encodeURIComponent(dev.id)}/paths`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ remotePath, localPath }),
        });
        wsPaths = r.paths ?? [];
        $('wsRemote').value = '';
        $('wsLocal').value = '';
        paintWs(wsPaths);
      } catch (err) {
        toast(err.message, 'error');
      }
    };
  }
  const wsRows = $('wsRows');
  if (wsRows) {
    wsRows.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-ws-del]');
      if (!btn) return;
      try {
        const r = await api(`/api/nodes/${encodeURIComponent(dev.id)}/paths`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ remotePath: btn.dataset.wsDel }),
        });
        wsPaths = r.paths ?? [];
        paintWs(wsPaths);
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  $('forgetNode').onclick = async () => {
    const urge = dev.pendingJobs ? `\n\n⚠️ 它身上还压着 ${dev.pendingJobs} 个活，会一并收掉。` : '';
    const ok = await askConfirm({
      title: `忘掉「${dev.label}」？`,
      body: `只删控制面上的这条记录。那台机器不受影响，15 秒内会自己重新报到，只有你给它起的名字会丢。${urge}`,
      ok: '忘掉',
      danger: true,
    });
    if (!ok) return;
    try {
      await api('/api/nodes/' + encodeURIComponent(dev.id), { method: 'DELETE' });
      S.rtLevel = 'devices';
      S.rtDevice = null;
      renderRuntimes();
    } catch { /* api() 已经提示过了 */ }
  };

  wireRenameDevice(dev);
  wireCopyButtons(); // 未安装那段的「复制命令」
  wireInstallRuntime(dev); // 未安装那段的「在这台机器上安装」—— 走节点的领活通道，命令在节点那侧查表
  wireExternalActions(dev); // 外部件那颗按钮：安装 / 重启 / 重装（按状态给，只给一颗）
  // 有活在做就自己刷（进度是服务端的事实，不是点击时记的定时器）
  scheduleTaskPoll(dev);
}

/**
 * 外部件那颗按钮：**安装 / 重启 / 重装**（按状态给，只给一颗）。
 *
 * 跟「在这台机器上安装运行时」是同一条通道（节点的领活），只是命令表不同 ——
 * 控制面照样只发 **id + 哪一步**，命令由那台机器自己查（安全边界一致）。
 */
/**
 * 给那台机器排一件事，然后盯着它做完 —— **「排队 → 轮询 → 出结果」这套只写一遍**。
 *
 * 为什么要有这个函数（2026-10-16）：我先给「装运行时」写了一遍，又给「外部件」抄了一遍，
 * 两处一模一样 —— 正是那种"迟早只改其中一处"的重复。`onLine(text, keep)` 负责写进度。
 * 返回 `{ok, status, tail, reason}`。
 */
async function runNodeTask(dev, { kind, target, mirror = '', onLine = () => {} }) {
  let task;
  try {
    task = (await post(`/api/nodes/${encodeURIComponent(dev.id)}/tasks`, { kind, family: target, mirror })).task;
  } catch {
    return { ok: false, reason: '排不上' }; // api() 已经提示过了
  }
  onLine('排队中 —— 等那台机器来领（它离线时会一直等着，不会丢）');
  // 上限 10 分钟：免得那台机器一直不来领，这个页面就永远转着
  const deadline = Date.now() + 10 * 60 * 1000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));
    let t;
    try {
      t = (await api(`/api/nodes/${encodeURIComponent(dev.id)}/tasks/${encodeURIComponent(task.id)}`)).task;
    } catch {
      return { ok: false, reason: '查不到进度了' };
    }
    if (!t) return { ok: false, reason: '任务不见了' };
    const tail = (t.output ?? '').trim().split('\n').filter(Boolean).slice(-1)[0] ?? '';
    if (t.status === '执行中') onLine(tail || '正在跑…');
    else if (t.done) return { ok: t.status === '完成', status: t.status, tail, output: t.output ?? '' };
    if (Date.now() > deadline) {
      return { ok: false, reason: '等了 10 分钟还没完 —— 那台机器可能没在领活（离线 / 正忙）。进度不会丢，回来刷新能看到。' };
    }
  }
}

/**
 * 外部件的**一颗**按钮（安装 / 重启 / 重装）。
 *
 * 用户不需要知道"常驻服务"是什么（2026-10-16 用户定的）—— 所以：
 *   · 「安装」（没装）：**自动**两步一起做。①`curl … install.sh | sh` 让它**存在**；
 *     ②`magpie daemon install --web --lan` 让它**一直跑**（网关＋面板、开机自己起）。
 *     顺序不能反（②要①的产物），但这是**我们的事**，不是用户的事。
 *   · 「重启」（装了但没跑起来）：只跑②（幂等 —— 服务丢了也能补上）。
 *   · 「重装」（上次失败过）：重走①＋②。
 * 具体命令放悬停里：想知道的人能看，普通用户不用看。
 */
function wireExternalActions(dev) {
  $('settingsView').querySelectorAll('[data-ext-do]').forEach((btn) => {
    btn.onclick = async () => {
      const kind = btn.dataset.extDo; // external-setup（安装/重装）| external-serve（重启）
      const extId = btn.dataset.extId;
      const catalog = (dev.externals?.catalog ?? []).find((x) => x.id === extId) ?? {};
      const probed = (dev.externals?.probed ?? []).find((x) => x.id === extId) ?? {};
      const steps =
        kind === 'external-setup'
          ? [
              // 已经装着就别再下一次 48M 了 —— 那种"重装"要的是把服务重新弄好
              probed.installed ? null : { kind: 'external-install', cmd: catalog.installCmd },
              { kind: 'external-serve', cmd: catalog.serveCmd },
            ].filter((s) => s && s.cmd)
          : [{ kind: 'external-serve', cmd: catalog.serveCmd }];
      const row = btn.closest('.row-item');
      const log = row?.querySelector('.install-log');
      const say = (text, keep = false) => {
        if (!log) return;
        log.style.display = '';
        log.textContent = keep ? (log.textContent + text).slice(-600) : text;
      };

      const extLabel = catalog.label ?? extId; // 目录里的名字（原来这里引用了外层 map 的 c，点击必抛 ReferenceError）
      const needDownload = steps.some((s) => s.kind === 'external-install');
      let mirror = '';
      if (needDownload) {
        /*
         * **走不走镜像** —— 一个勾选框，不是让人填地址（2026-10-16 用户提的：
         * 普通用户不知道镜像地址该填什么）。地址由我们内置（见 externals.mjs 的 mirrors），
         * 勾上就按顺序试，谁先通用谁 —— 这类公共镜像会挂，不能只写死一个。
         */
        const mirrors = catalog.mirrors ?? [];
        const r = await askCheckbox({
          title: kind === 'external-setup' && probed.installed ? '重装？' : '安装？',
          body: `会在「${dev.label}」上安装 ${extLabel}。`,
          check: mirrors.length
            ? { label: '走国内镜像下载', checked: true } // 默认勾上：直连在国内基本是等它超时
            : null,
          ok: '开始',
        });
        if (!r.ok) return;
        mirror = r.checked && mirrors.length ? mirrors : '';
      } else {
        const ok = await askConfirm({
          title: '重启？',
          body: `会把「${dev.label}」上的 ${extLabel} 拉起来。`,
          ok: '重启',
        });
        if (!ok) return;
      }

      const label = btn.textContent;
      btn.disabled = true;
      // 勾了镜像就按顺序试：第一个不行就换下一个（每个都有各自的超时，别把用户钉在一个挂掉的镜像上）
      const tries = Array.isArray(mirror) ? (mirror.length ? mirror : ['']) : [mirror];
      let last = null;
      for (let t = 0; t < tries.length; t++) {
        const useMirror = tries[t];
        if (tries.length > 1) say(`试第 ${t + 1} 个镜像：${useMirror}`);
        let failed = false;
        for (const [i, s] of steps.entries()) {
          btn.textContent = steps.length > 1 ? `${i + 1}/${steps.length} 进行中…` : '进行中…';
          const res = await runNodeTask(dev, { kind: s.kind, target: extId, mirror: useMirror, onLine: say });
          last = res;
          if (!res.ok) {
            failed = true;
            break;
          }
        }
        if (!failed) {
          // 不提"两步"：用户不需要知道底下是几步（2026-10-16）
          say('好了 —— 正在刷新…');
          btn.textContent = '好了';
          setTimeout(() => renderRuntimes(), 700);
          return;
        }
        if (t < tries.length - 1) say(`这个镜像没成（${last?.tail || last?.reason || '没输出'}），换下一个…`, true);
      }
      say(`没成：${last?.tail || last?.reason || '（没输出）'}`, true);
      btn.disabled = false;
      btn.textContent = label;
    };
  });
}

/**
 * 「在这台机器上安装」（远程节点）。
 *
 * 流程：确认（把**要跑的命令原样**摆出来）→ 排个任务 → 节点在它自己的领活循环里领走并跑 →
 * 界面轮询任务状态显示进度 → 装完那台机器**立刻重报清单**，这一页自己刷新。
 *
 * 为什么命令要在确认框里原样显示：这是"在**别人的机器**上装东西"。点下去之前得看清楚是什么。
 * 而命令本身**不是这里拼的** —— 这里只发族名，节点自己查表（安全边界）。
 */
function wireInstallRuntime(dev) {
  $('settingsView').querySelectorAll('[data-install-rt]').forEach((btn) => {
    btn.onclick = async () => {
      const family = btn.dataset.installRt;
      const cmd = btn.dataset.cmd;
      const row = btn.closest('.row-item');
      const log = row?.querySelector('.install-log');
      const say = (text, keep = false) => {
        if (!log) return;
        log.style.display = '';
        log.textContent = keep ? (log.textContent + text).slice(-600) : text;
      };
      const ok = await askConfirm({
        title: '在这台机器上安装？',
        /*
         * 正文只留"会在哪台机器上跑什么" —— 点之前必须看清楚的是**要执行什么** ✓。
         * 原来后面还跟一句"装完不用重启节点 —— 它会自己把新清单报上来"，
         * 2026-10-16 用户让删 ✓（那是实现细节；用户会自己看见清单变了，原理归网站讲）。
         */
        body: `会在「${dev.label}」上跑：\n${cmd}`,
        ok: '开始安装',
      });
      if (!ok) return;

      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = '进行中…';
      // 「排队 → 轮询 → 出结果」那套只用写一遍（见 runNodeTask）
      const r = await runNodeTask(dev, { kind: 'install-runtime', target: family, onLine: say });
      if (r.ok) {
        say('装好了 —— 正在刷新…');
        btn.textContent = '装好了';
        setTimeout(() => renderRuntimes(), 700); // 那台机器已经重报清单了，刷新就能看到
        return;
      }
      say(`装失败了：${r.tail || r.reason || '（没输出）'}`, true);
      btn.disabled = false;
      btn.textContent = label;
    };
  });
}

/* ② 设备详情：这台设备上的 CLI —— 一行一个实例，一个开关决定接不接入 */

/**
 * 这一页是"这台机器上有什么、我要不要用"，**不是"填表加一条"**。
 *
 * 为什么不做成表单：路径是"这台机器上的事实"，不是用户该知道的知识 ——
 * 一个不懂电脑的人不可能知道 `%LOCALAPPDATA%\Programs` 在哪，也不该被要求知道。
 * 所以：
 *   · 分两段：**已安装的在上，没装的在下**（下面每行带一条能直接粘的安装命令）
 *   · 归属看 `publicFamilies().installed`，页面加载就有值（纯 existsSync）
 *   · 已有实例的行：开着的 = 接入中；关掉 = 停用（不删，位置记着）
 *   · 装了但还没接入的族：一行，开关关着，打开就建一条
 *   · 点「识别本机运行时」：只为了补**版本号**（那要 spawn 进程，约 0.5 秒）
 *
 * 「安装」弹窗是唯一还可能出现手填的入口（"我装了、但你没认出来"），正常流程碰不到。
 */
async function renderDeviceDetail() {
  $('settingsView').innerHTML = rtLoading('这台机器');

  let dev;
  let families;
  try {
    // 族列表**每次都拉**：bandi 只支持这三家，所以"未安装"那一段要一直摆在那儿
    // （各自带安装命令），不能等点了「识别」才出现。
    [dev, families] = await Promise.all([
      api('/api/devices/' + encodeURIComponent(S.rtDevice)).then((d) => d.device),
      api('/api/runtime-families').then((f) => f.families),
    ]);
  } catch (err) {
    $('settingsView').innerHTML = `${headRow('<b>这台机器</b>')}<div class="empty">${failHtml(err)}</div>`;
    return;
  }

  /* 运行时是**多层**的（运行时 › 设备 › CLI）：页头用面包屑，上级能直接点回去
     （2026-10-20 用户截图：「运行时这个功能，下面有多层页面，应该改成面包屑模式」）。
     左栏仍是「设置」的分节列表，所以面包屑从「运行时」这一层起 —— 不再写成"设置 › 运行时 › …"。 */

  // 远程节点：这一版只报到，它的运行时是只读的 —— 别让它掉进下面那套"改本机"的交互里
  // 远程节点：交给它自己那页（那边要拉族清单，所以是异步的）
  if (dev.kind === 'node') return await renderNodeDetail(dev);

  const scan = S.rtScan; // null = 这一轮还没点过「识别本机运行时」
  const haveFamily = new Set(dev.runtimes.map((r) => r.family));
  const verOf = new Map((scan ?? []).map((f) => [f.id, f.version]));
  const pathOf = new Map(
    (scan ?? []).map((f) => [f.id, (f.candidates ?? []).find((c) => c.usable)?.path ?? null]),
  );

  /*
   * 放上面还是下面，看**这台机器上装没装** —— 用族列表里现成的 `installed`
   * （服务端渲染这一页时已经探过了，纯 existsSync，约 8ms）。
   *
   * 为什么不靠「识别本机运行时」才分：那等于**明知故等**。这个字段本来就有值，
   * 却让一个装着的 CLI 先蹲在「未安装」里、还挂着一条安装命令，等人点一下才承认。
   * 那颗按钮现在只干一件事：把**版本号**补上（那才需要 spawn 进程，约 0.5 秒）。
   */
  const notYet = families.filter((f) => f.installed && !haveFamily.has(f.id));
  const absent = families.filter((f) => !f.installed && !haveFamily.has(f.id));

  const rowOfRuntime = (r) => {
    // 健康度用**共用的**那个判据（本机＝这个 CLI 现在能不能起；远程＝那台机器在不在线）。
    // 那条"判据必须 === false、不能用 !field"的教训已经收进 runtimeHealth 的注释里。
    const ver = verOf.get(r.family);
    const h = runtimeHealth(r);
    // 路径只在"路径本身有问题"时摆出来 —— 见 runtimeHealth 的 showPath
    const sub = h.showPath ? `<div class="sub">${esc(r.path)}</div>` : '';
    return `<div class="row-item ${h.cls === 'tag-ok' ? '' : 'off'}">
      ${cliAvatar(r.family ?? r.id, r.label)}
      <div class="who" data-open-cli="${esc(r.id)}" style="cursor:pointer" title="${esc(r.path)}">
        <b>${esc(r.label)}${ver ? `<em class="tag-ok">${esc(ver)}</em>` : ''}${healthTag(r)}${healedTag(r)}</b>
        ${sub}
      </div>
      <label class="switch" title="${r.enabled ? '接入中 —— 关掉就不再派活给它' : '已停用 —— 打开就重新接入'}">
        <input type="checkbox" data-rt-toggle="${esc(r.id)}" ${r.enabled ? 'checked' : ''} /><span></span>
      </label>
    </div>`;
  };

  // 探测到、但这台设备上还没有它的实例 —— 开关关着，打开就建一条
  // 探测到、但这台设备上还没有它的实例 —— 开关关着，打开就建一条
  const rowOfNotYet = (f) => {
    const ver = verOf.get(f.id);
    const p = pathOf.get(f.id) ?? f.detectedPath ?? '';
    return `<div class="row-item">
      ${cliAvatar(f.id, f.label)}
      <div class="who">
        <b>${esc(f.label)}${ver ? `<em class="tag-ok">${esc(ver)}</em>` : ''}</b>
        <div class="sub">还没接入 —— 打开右边的开关</div>
      </div>
      <label class="switch" title="接入：用探测到的位置建一条">
        <input type="checkbox" data-rt-add="${esc(f.id)}" data-rt-path="${esc(p)}" /><span></span>
      </label>
    </div>`;
  };

  /*
   * 这台机器上没有 —— **跟远程节点那一行完全一致**（2026-10-21 用户提的）：
   * 一颗「在这台机器上安装」（点了当场装，进度就地写），外加「复制命令」「按路径接入」。
   * 原来这里只给「复制安装命令」—— 可节点页早就能一键装了，本机反而要人开终端，
   * 两台机器两套动作，没有道理（本机就是控制面自己，更没理由绕不开）。
   * 判据逐条对齐节点页的 rowOfMissing：dsh 是 Windows 桌面端自带的，别处不给那条"命令"。
   */
  const isWinLocal = /win/i.test(dev.platform ?? '');
  const rowOfAbsent = (f) => {
    const cmd = f.install?.kind === 'app' && !isWinLocal ? null : (f.install?.cmd ?? null);
    // 只有 npm 那种能一键装（同节点页：dsh 要靠装桌面端，不是一条命令能解决的事，不给按钮）
    const oneClick = f.install?.kind === 'npm' && !!cmd;
    const busy = runningTaskFor(dev, f.id);
    // 上次没成的那件也摆出来（同节点页：失败是做过的事，就该留在那儿，悬停看完整输出）
    const lastFail = !busy && dev.task?.done && dev.task.status !== '完成' && dev.task.family === f.id ? dev.task : null;
    const sub = cmd
      ? `<div class="sub" style="font-family:ui-monospace,monospace;font-size:11.5px">${esc(cmd)}</div>`
      : '<div class="sub">这台机器上装不了（它是 Windows 桌面端自带的）</div>';
    return `<div class="row-item off">
      ${cliAvatar(f.id, f.label)}
      <div class="who">
        <b>${esc(f.label)}</b>
        ${sub}
        <!-- 安装进度就写在这儿（点击之后才出现），不另开弹窗 -->
        <div class="sub install-log" style="display:none;font-family:ui-monospace,monospace;font-size:11.5px"></div>
        ${
          busy
            ? `<div class="sub" data-task-line="${esc(busy.id)}" style="display:block;font-family:ui-monospace,monospace;font-size:11.5px">${
                busy.running ? '进行中… ' : '排队中… '
              }${esc(taskTail(busy) || '（马上开始）')}</div>`
            : lastFail
              ? `<div class="sub" title="${esc(lastFail.output)}" style="color:var(--bad);font-size:11.5px">上次没成（${esc(
                  failAt(lastFail),
                )}）：${esc(taskFailLine(lastFail) || '（没输出）')}（悬停看全部）</div>`
              : ''
        }
      </div>
      ${
        busy
          ? '<span class="dim" style="font-size:11.5px">进行中…</span>'
          : oneClick
            ? `<button class="mini auto primary" data-install-rt="${esc(f.id)}" data-cmd="${esc(cmd)}">在这台机器上安装</button>`
            : ''
      }
      ${cmd ? `<button class="mini auto" data-copy="${esc(cmd)}">复制命令</button>` : ''}
      <button class="mini auto" data-rt-manual="${esc(f.id)}">按路径接入</button>
    </div>`;
  };

  $('settingsView').innerHTML = `
    ${headRow(breadcrumb([{ label: '这台机器', to: 'devices' }, { label: dev.label }]))}
    <div class="detail-body">
      ${devHeadHtml(dev, {
        badges: '<span class="pill-ok">在线</span><span class="pill">本机</span>',
        sub: `${esc(dev.platform)} · 已接入 ${dev.runtimes.filter((r) => r.enabled).length} 个 agent CLI`,
      })}

      <section class="fx">
        <div class="fx-head">
          <label>已安装 <span class="count">${dev.runtimes.length + notYet.length}</span></label>
          <button class="btn-sm" id="detectRuntime" title="再扫一遍这台机器：补上版本号，也确认没装错">识别本机运行时</button>
        </div>
        ${dev.runtimes.map(rowOfRuntime).join('')}
        ${notYet.map(rowOfNotYet).join('')}
        ${
          !dev.runtimes.length && !notYet.length
            ? '<div class="dim" style="padding:14px 16px">这台机器上还没探测到任何一个 agent CLI —— 看下面「未安装」那一段怎么装。</div>'
            : ''
        }
        ${
          scan === null
            ? '<div class="dim" style="padding:10px 2px;font-size:12px">点「识别本机运行时」可以补上版本号。</div>'
            : ''
        }
      </section>

      ${
        absent.length
          ? `<section class="fx" style="margin-top:26px">
               <div class="fx-head">
                 <label>未安装 <span class="count">${absent.length}</span></label>
                 <span class="dim" style="font-size:12px">安装成功之后，点击【识别本机运行时】按钮进行刷新</span>
               </div>
               ${absent.map(rowOfAbsent).join('')}
             </section>`
          : ''
      }

      ${externalsHtml(dev)}
    </div>`;

  wireRenameDevice(dev);
  wireCopyButtons(); // 外部件那段的「复制安装命令」（本机不给一键：控制面直接跑 curl|sh 不合适，用户在终端里粘一下更清楚）
  wireInstallRuntime(dev); // 未安装那段的「在这台机器上安装」—— 本机由控制面当场执行（见 server.mjs 的 local 分支）
  scheduleTaskPoll(dev); // 有装在跑就接着盯（刷新页面之后进度也能从服务端读回来）

  // 扫描：点了才跑（要 spawn 进程拿版本号，约半秒）
  $('detectRuntime').onclick = async () => {
    const btn = $('detectRuntime');
    btn.disabled = true;
    btn.textContent = '识别中…';
    try {
      S.rtScan = (await api('/api/runtimes/detect')).families;
      await renderDeviceDetail();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = '识别本机运行时';
      toast(err.message, 'error');
    }
  };

  // 已有实例：开关 = 停用/启用
  $('settingsView').querySelectorAll('[data-rt-toggle]').forEach((el) => {
    el.onchange = async () => {
      try {
        await api(`/api/devices/${encodeURIComponent(S.rtDevice)}/runtimes/${encodeURIComponent(el.dataset.rtToggle)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: el.checked }),
        });
        await load();
        await renderDeviceDetail();
      } catch (err) {
        toast(err.message, 'error');
        el.checked = !el.checked;
      }
    };
  });

  // 探测到但还没接入：打开开关 = 用探测到的位置建一条
  $('settingsView').querySelectorAll('[data-rt-add]').forEach((el) => {
    el.onchange = async () => {
      el.disabled = true;
      try {
        await post(`/api/devices/${encodeURIComponent(S.rtDevice)}/runtimes`, {
          family: el.dataset.rtAdd,
          path: el.dataset.rtPath,
        });
        await load();
        await renderDeviceDetail();
      } catch (err) {
        toast(err.message, 'error');
        el.disabled = false;
        el.checked = false;
      }
    };
  });

  wireCopyButtons();

  // 名字带 rt 前缀：插件页那条「粘一条 MCP 配置」的按钮也叫 data-manual，
  // 两边虽然同时只有一个渲染、不会真撞，但同名迟早会咬人
  $('settingsView').querySelectorAll('[data-rt-manual]').forEach((el) => {
    el.onclick = () => {
      // 族可能来自扫描结果（带 candidates）也可能来自族列表（带 detectedPath）
      const f = [...(scan ?? []), ...families].find((x) => x.id === el.dataset.rtManual);
      if (f) openAddRuntime(f);
    };
  });

  $('settingsView').querySelectorAll('[data-open-cli]').forEach((el) => {
    el.onclick = () => {
      S.rtLevel = 'cli';
      S.rtRuntime = el.dataset.openCli;
      renderRuntimes();
    };
  });
}

/* 「安装」弹窗 —— 正常流程碰不到它（打开开关就自动建好了） */

let addRtFamily = null;

/**
 * 「安装」弹窗：只干一件事 —— 你说你装了、可班底没认出来，那把位置告诉它。
 *
 * 为什么这儿**不再放安装命令**：列表里「未安装」那一行已经给了命令 + 复制按钮，
 * 弹窗里再来一份是重复的（用户实报）。
 *
 * 输入可以是**安装目录**也可以是可执行文件路径：服务端会往里找到真正的可执行文件
 * （见 runtimes.mjs 的 resolveCliPath）。
 */
function openAddRuntime(family) {
  addRtFamily = family;
  const usable = (family.candidates ?? []).filter((c) => c.usable);
  /*
   * 预填**只认探测结果**。
   *
   * 以前这里还会退回 `family.defaultPath`，而那是各个适配器里**写死的**路径
   * （值来自开发那台机器的布局）。能走到这个弹窗的族，按定义就是"没探测到"的 ——
   * 那个写死的路径极可能根本不存在。预填进去等于递给他一个看着合理、
   * 点下去必然得一个「路径已失效」的值，他还不知道哪儿错了。
   * 空着 + placeholder 才是诚实的。（写死的兜底已经从服务端整条去掉了。）
   */
  const preset = usable[0]?.path || family.detectedPath || '';

  /*
   * 标题跟列表里那颗按钮一致（都叫「按路径接入」）。
   *
   * 为什么**不叫「安装」**（2026-10-16 用户提的）：这个弹窗干的事是
   * "告诉我它装在哪（目录或可执行文件都行）→ 检测 → 接进来"，**它不装任何东西**。
   * 叫「安装」会让人以为点了就会帮他装一个 —— 于是真没装的人点进来、填了个猜的路径、
   * 得到一个「路径已失效」，还不知道问题出在哪。
   * 也不用「路径配置」：那是**名词**（像个设置项），按钮该是动词，而且它确实**当场完成接入**。
   * 同一行那个「复制安装命令」才是真安装（`npm install -g …`），那个词是对的。
   */
  $('addRtTitle').textContent = `按路径接入 ${family.label}`;
  $('addRtPath').value = preset;
  $('addRtPath').placeholder = `它的位置：安装目录或可执行文件，例如 ${EXAMPLE_DIR[family.id] ?? 'D:\\Tools\\xxx'}`;
  // 底部那一行先放常驻提示；点「检测」之后会被结果替换掉（同一块地方，不占两处）
  $('addRtFoot').innerHTML = `如果<b>已经装了、但没被认出来</b>，把它的位置填进来 —— 目录或可执行文件都行（如：${esc(
    EXAMPLE_DIR[family.id] ?? 'D:\\Tools\\xxx',
  )}）。`;
  $('addRtDlg').showModal();
  setTimeout(() => $('addRtPath').focus(), 30);
}

/** 提示里那个"例如"用的目录。**只是举例**，不会被当成默认值填进去 */
const EXAMPLE_DIR = {
  codex: 'D:\\Tools\\codex',
  claude: 'D:\\Tools\\Claude',
  dsh: 'D:\\AppData\\Local\\Programs\\DeepSeek Harness',
};

/**
 * 「检测」：跑一次 `--version`，看这个路径到底行不行。
 *
 * 为什么要有：手填路径最容易出的错是"看着对、其实跑不起来"（填了个目录、
 * 填了个 .cmd shim、版本不对）。让人在**接入之前**就知道结果，比接进去之后
 * 在列表里看到一个「路径已失效」强得多。
 *
 * 服务端会先过 `resolveCliPath`：填目录的话解析成里面的可执行文件，
 * 并把解析结果回给这里 —— 所以解析结果要**写回输入框**，让人看见实际用哪个文件。
 *
 * 结果写进底部的 `addRtFoot`（**和常驻提示共用那一行**），不是另开一块：
 * 另开一块就得为它预留高度，弹窗中间会出现一个空洞。
 */
async function testAddRuntimePath() {
  const btn = $('addRtTest');
  const out = $('addRtFoot');
  const given = $('addRtPath').value.trim();
  if (!given) {
    out.innerHTML = '<em class="tag-warn">先填一个路径</em>';
    return;
  }
  btn.disabled = true;
  btn.textContent = '检测中…';
  out.textContent = '';
  try {
    const r = await post('/api/runtimes/test', { family: addRtFamily.id, path: given });
    if (r.ok) {
      out.innerHTML = `<em class="tag-ok">${esc(r.version || '能跑')}</em> 可以接入`;
      if (r.path && r.path !== given) {
        // 填的是目录 → 服务端解析出了真身，写回去让人看见
        $('addRtPath').value = r.path;
        out.innerHTML += '<span class="dim" style="font-size:11.5px">（已定位到可执行文件）</span>';
      }
    } else {
      let msg = r.error || '';
      /*
       * 最常见的坑：填的是 Windows 的 `.cmd` / `.bat` shim（比如 npm 全局装完留下的那个）。
       * 文件确实在，但 Node 22 起 spawn 一个 .cmd（不挂 shell）直接 EINVAL ——
       * 报出来的原文 "起不来：EINVAL spawn EINVAL" 对用户毫无意义，换成人话。
       */
      if (/EINVAL/i.test(msg) && /\.(cmd|bat)$/i.test(given)) {
        // 短一点：结果区只预留了两行，太长会把弹窗撑高
        msg = '班底不能直接启动 .cmd/.bat —— 请指向它背后的 .exe 或 .js';
      }
      out.innerHTML = `<em class="tag-warn">跑不起来</em> <span class="dim">${esc(msg)}</span>`;
    }
  } catch (err) {
    out.innerHTML = `<em class="tag-warn">${failHtml(err)}</em>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '检测';
  }
}
$('addRtTest').onclick = testAddRuntimePath;

$('addRtOk').onclick = async (e) => {
  e.preventDefault();
  const path = $('addRtPath').value.trim();
  if (!path) {
    return toast('先填一个安装目录或可执行文件路径 —— 还没装的话，回列表看「未安装」那一行给的安装命令。');
  }
  try {
    // 不传 label：服务端会默认用协议族名（「Codex CLI」这种）。这类名字够了，
    // 让人先起个名是多余的一步 —— 真想改，详情页里有。
    await post(`/api/devices/${encodeURIComponent(S.rtDevice)}/runtimes`, {
      family: addRtFamily.id,
      path,
    });
    $('addRtDlg').close();
    await load(); // 员工的 Runtime 下拉要跟着多一项
    S.rtLevel = 'device';
    renderRuntimes();
  } catch (err) { toast(err.message, 'error'); }
};

/* ③ CLI 详情 */
async function renderCliDetail() {
  $('settingsView').innerHTML = rtLoading('这台机器');

  let dev;
  let rt;
  try {
    dev = (await api('/api/devices/' + encodeURIComponent(S.rtDevice))).device;
    rt = dev.runtimes.find((r) => r.id === S.rtRuntime);
    if (!rt) throw new Error('这台设备上没有这个 CLI');
  } catch (err) {
    $('settingsView').innerHTML = `${headRow('<b>这台机器</b>')}<div class="empty">${failHtml(err)}</div>`;
    return;
  }

  /* 运行时是**多层**的（运行时 › 设备 › 这个 CLI）：页头用面包屑，两级上级都能点回去。
     左栏仍是「设置」的分节列表，所以面包屑从「运行时」这一层起。 */
  $('settingsView').innerHTML = `
    ${headRow(breadcrumb([
      { label: '这台机器', to: 'devices' },
      { label: dev.label, to: 'device' },
      { label: rt.label },
    ]))}
    <div class="detail-body">
      <!--
        这里原来有个「启用」勾选框。删掉了 —— 列表页那一行已经有开关（点一下立刻生效），
        同一个状态在两处改是坏事：这页的勾选框还得配合下面的「保存」才生效，
        两边的值还可能不一致。
      -->

      <section class="fx">
        <label>可执行路径</label>
        <div class="row-inline">
          <input id="rtPath" value="${esc(rt.path)}" spellcheck="false" />
          <button id="rtProbe">检测</button>
        </div>
        <div class="hint" id="rtResult" style="margin-top:8px"></div>
      </section>

      <section class="fx">
        <label>沙箱模式</label>
        <input id="rtSandboxes" value="${esc(rt.sandboxes.join(', '))}" spellcheck="false" />
        <label class="sub-label">其中「跑不了命令」的（逗号分隔）</label>
        <input id="rtBlocked" value="${esc(rt.blocked.join(', '))}" spellcheck="false" />
      </section>

      <div class="fx-actions">
        <button class="primary" id="rtSave">保存</button>
        ${rt.builtIn ? '' : '<button class="danger" id="rtDelete">删除这个运行时</button>'}
      </div>
    </div>`;

  const p = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
  const payload = () => ({
    // 不带 enabled：启停归列表页那颗开关管，这一页不该动它。
    // 服务端 `patch.enabled === undefined` 时会保留原值，所以这里不发就安全。
    path: $('rtPath').value.trim(),
    sandboxes: p($('rtSandboxes').value),
    blocked: p($('rtBlocked').value),
  });
  const url = `/api/devices/${encodeURIComponent(S.rtDevice)}/runtimes/${encodeURIComponent(S.rtRuntime)}`;


  const delBtn = $('rtDelete');
  if (delBtn) {
    delBtn.onclick = async () => {
      if (!(await confirmDo(`删掉运行时「${rt.label}」？\n绑了它的员工需要改绑，否则会跑不起来。`))) return;
      try {
        await api(url, { method: 'DELETE' });
        await load();
        S.rtLevel = 'device';
        S.rtRuntime = null;
        renderRuntimes();
      } catch (err) { toast(err.message, 'error'); }
    };
  }

  $('rtSave').onclick = async () => {
    try {
      await api(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload()) });
      $('rtResult').textContent = '已保存。';
      $('rtResult').style.color = 'var(--ok)';
      await load(); // 员工的权限下拉要跟着更新
    } catch (err) {
      showFail($('rtResult'), err);
      $('rtResult').style.color = 'var(--bad)';
    }
  };

  $('rtProbe').onclick = async () => {
    $('rtResult').textContent = '检测中…';
    $('rtResult').style.color = '';
    try {
      // 先存再探：探测走的就是这份路径
      await api(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload()) });
      const r = await post(url + '/probe', {});
      $('rtResult').innerHTML = r.ok
        ? `在线，版本：<code>${esc(r.version || '(没报版本号)')}</code>`
        : `离线 —— ${esc(r.error || '未知原因')}`;
      $('rtResult').style.color = r.ok ? 'var(--ok)' : 'var(--bad)';
      await load();
    } catch (err) {
      showFail($('rtResult'), err);
      $('rtResult').style.color = 'var(--bad)';
    }
  };
}

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
function openCtxMenu(x, y, items) {
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
function closeCtxMenu() {
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
const CONV_ERR_ZH = {
  E2047: '这段会话已经不在了，列表已刷新',
  // E1050 = 工单会话（任务卡 / 流程）。群的删除路子 2026-10-20 起已经放开，别再写成"群请去解散"
  E1050: '这是任务卡 / 流程里的会话，要去那边删任务',
  E4002: '这段还在跑，等它跑完或先终止再删',
  // 群会话：群没了 / 群已解散（E2016、E2017 归技能用，别串）
  E2011: '这个群不存在了，已回到消息列表',
  E2048: '这个群已经不在了，通讯录已刷新',
  E2049: '这个群已经解散了，只能查看聊天记录',
};
function toastConvErr(err) {
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
function archivedConvs() {
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
function archivedEntryHTML() {
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
function enterArchiveView() {
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
function convDisplayName(c) {
  if (c.personaName) return c.personaName;
  return String(c.title || '').replace(/^和\s*/, '') || '（员工已删）';
}

/**
 * 左栏的归档列表。行与消息列表同一套 `.item` 样式（用户要的就是"像张三、李四那样列出来"），
 * 只是副标题换成条数与"员工已删除"，右键菜单只给「删除」。
 */
function renderArchiveList() {
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
async function hideConversationRow(c, mode = 'hide') {
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
function wipeScopeOf(c) {
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
async function removeConversationForever(c) {
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
async function openConversationSafe(id) {
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
function resetChatPane() {
  S.conversation = null;
  S.convEmpty = false;
  $('chat').innerHTML = '<div class="empty">还没有对话</div>';
  $('chatHead').innerHTML = '<span class="dim" style="padding:6px 0">左边选一个人，开始说话</span>';
  setComposer(false);
}

/* -------------------------------------------------------------- 二级列表 */

/* ---------------------------------------------------- 通讯录：A–Z 分组 */

/**
 * 名字首字母（通讯录「数字员工」按 A–Z 分组，2026-10-20 用户要求：像微信通讯录）。
 *
 * 中文不能直接取首字 —— 要转拼音首字母。项目零依赖、不引 pinyin 库，
 * 这里用 `Intl.Collator('zh-Hans-u-co-pinyin')` 的拼音排序能力：
 * 给每个字母一个"该字母拼音区的最小字"当边界，最后一个 ≤ 名字首字的边界就是它的分组。
 *   · 英文名直接取首字母；数字/符号/认不出的 → '#'（排最后，跟微信一样）
 *   · 边界字选的是该声母下拼音最小的常见字（阿 a、八 ba、擦 ca…）；i/u/v 没有拼音音节，跳过
 * 只依赖浏览器 ICU，不写死"姓氏表" —— 生僻姓也能分对（只要 ICU 认识这个字）。
 */
const PINYIN_BOUNDS = [
  ['A', '阿'], ['B', '八'], ['C', '擦'], ['D', '搭'], ['E', '蛾'], ['F', '发'], ['G', '噶'], ['H', '哈'],
  ['J', '击'], ['K', '喀'], ['L', '拉'], ['M', '妈'], ['N', '拿'], ['O', '哦'], ['P', '啪'], ['Q', '七'],
  ['R', '燃'], ['S', '撒'], ['T', '塌'], ['W', '挖'], ['X', '夕'], ['Y', '压'], ['Z', '匝'],
];
const HAN_RE = /^[\u3400-\u9fff\uf900-\ufaff]/;
let pinyinCollator = null;
const zhNameCollator = () => {
  if (!pinyinCollator) {
    try {
      pinyinCollator = new Intl.Collator('zh-Hans-u-co-pinyin');
    } catch {
      // 理论上不会（Chromium/WebView2 都带 ICU）；真不支持就退回中文默认排序，分组仍按边界字试
      pinyinCollator = new Intl.Collator('zh-Hans');
    }
  }
  return pinyinCollator;
};

/** 名字 → 分组字母（A–Z / '#'）。 */
function nameInitial(name) {
  const first = String(name ?? '').trim().charAt(0);
  if (!first) return '#';
  if (/[A-Za-z]/.test(first)) return first.toUpperCase();
  if (!HAN_RE.test(first)) return '#';
  const col = zhNameCollator();
  let letter = '#';
  for (const [L, bound] of PINYIN_BOUNDS) {
    if (col.compare(first, bound) >= 0) letter = L;
    else break;
  }
  return letter;
}

/** 通讯录「数字员工」排序 + 按首字母分组：[{ letter, rows }]，'#' 永远排最后。 */
function groupPeopleByInitial(people) {
  const col = zhNameCollator();
  const sorted = [...people].sort((a, b) => {
    const ia = nameInitial(a.name);
    const ib = nameInitial(b.name);
    if (ia !== ib) {
      if (ia === '#') return 1;
      if (ib === '#') return -1;
      return ia < ib ? -1 : 1;
    }
    return col.compare(a.name ?? '', b.name ?? '');
  });
  const out = [];
  for (const p of sorted) {
    const letter = nameInitial(p.name);
    const last = out.at(-1);
    if (last && last.letter === letter) last.rows.push(p);
    else out.push({ letter, rows: [p] });
  }
  return out;
}

function renderList() {
  // 列表一重画，原来右键的那一行可能已经不在了 —— 菜单留着就是"点了个寂寞"
  closeCtxMenu();
  /*
   * 左栏底部固定条（#listFoot）每次重画都先清空：它挂的是「已归档」这种**跨列表**的入口，
   * 不该跟着某一份数据残留到通讯录/设置页上。哪个分支需要，自己再往里写。
   */
  const foot = $('listFoot');
  if (foot) foot.innerHTML = '';
  const q = S.filter.trim().toLowerCase();
  const match = (name) => !q || String(name || '').toLowerCase().includes(q);

  /* 「已移除的会话」子视图已随归档功能一并删除（2026-10-20，用户要求）：
     「不显示」不再往某个归档列表里放，它的记录只在「聊天记录」抽屉里可见；
     已删员工的会话留在列表里只读，右键「归档」= 从界面收走（数据留库、无入口）。 */

  if (S.nav === 'messages') {
    // 归档子视图：左栏换一份列表（渲染完全走它自己，别在这儿混分支）
    if (S.archivedView) return renderArchiveList();
    /* 工单会话（流程 / 任务卡）**不进消息列表** —— 从工作台 / 任务进去即可。
       所以这里既不平铺也不分组，直接按 kind 过滤掉。 */
    /*
     * **一人一行 / 一群一行**（2026-10-20）：
     *   · 1:1 → 只留这个人的**当前会话**（updatedAt 最大的那条）；
     *   · 群   → 一个群下面可以有多段会话（每次「发消息」一段），列表里只占**一行**，
     *            取这个群最新那段（`groupId` 相同即同一个群）；
     *   · exec → 不进列表。
     * 其余的都在「聊天记录」抽屉里，不占列表行。
     *
     * 收敛放在**前端**：服务端 listConversations 是 /api/state 的热路径，
     * 还喂着工作台、通讯录、任务看板，不能为了这个界面的展示口径去改它的 SQL。
     *
     * 顺序是「先收敛、再按名字过滤」——反过来的话，搜到一个**历史会话的标题**
     * 就会把它单独摆成一行，一个人又出现两行。副作用是搜历史标题搜不到左栏，
     * 可接受：历史归「聊天记录」。
     *
     * 不在这层排序：输入的 S.conversations 已由服务端按 updatedAt DESC 排好，
     * filter 天然保住全局顺序（群与人混在一起按最后活跃时间排，跟以前一样）。
     */
    const currentOf = new Map();  // 人 → 他的代表会话（最新那段；正在看的那段优先，见下）
    const groupOf = new Map();    // 群 id → 这个群的代表会话（同上）
    for (const c of S.conversations ?? []) {
      if (c.kind === 'exec') continue;
      if (c.kind === 'group') {
        const gid = gidOf(c);
        if (!groupOf.has(gid) || S.conversation?.id === c.id) groupOf.set(gid, c);
        continue;
      }
      /*
       * 代表会话 = 最新那段；但你**正在看**的那段优先（2026-10-22 用户实报）：
       * 从「聊天记录」抽屉点开一段老会话，左栏这一行也应该是它 —— 预览、时间
       * 跟着走，高亮才真的对得上行。不然行还停在最新那段上，看着选中了，
       * 其实是按"人"命中的假高亮（预览根本不是你点开的那条）。
       */
      if (!currentOf.has(c.personaId) || S.conversation?.id === c.id) currentOf.set(c.personaId, c);
    }
    const rows = (S.conversations ?? [])
      .filter((c) => {
        if (c.kind === 'exec') return false;
        if (c.kind === 'group') return groupOf.get(gidOf(c))?.id === c.id;
        return currentOf.get(c.personaId)?.id === c.id;
      })
      .filter((c) => match(c.personaName) || match(c.title));
    const pById = new Map((S.personas ?? []).map((p) => [p.id, p]));   // 消息行头像要用
    $('listBody').innerHTML =
      (rows.length
        ? rows.map((c) => {
            const isGroup = c.kind === 'group';
            const title = isGroup ? c.title : convDisplayName(c);
            const avatar = isGroup
              ? `<div class="avatar grp">${esc(initial(c.title))}</div>`
              : personaAvatar(pById.get(c.personaId), '', c.personaName ?? title);
            // 没聊过就**留白**（2026-10-20 用户要求）：不再显示「还没聊过」占位
            const preview = esc(cut(plain(c.lastMessage), 34));
            /*
             * 群已解散（2026-10-20 用户定：解散后消息仍留在列表，只读）：
             * 行上标「已解散」。人数不写 —— 解散时成员快照已经清了，写出来是 "0 人"。
             */
            const sub = isGroup
              ? c.dissolvedAt
                ? (preview ? `已解散 · ${preview}` : '已解散')
                : (preview ? `${c.memberCount} 人 · ${preview}` : `${c.memberCount} 人`)
              : preview;
            /*
             * 高亮按**人 / 群**命中，不只按会话 id：正在看某人的一段历史会话、或某个群的
             * 一段老会话时，列表里那一行已经是"这个人的当前会话 / 这个群的最新一段"了，
             * 不亮会显得左栏什么都没选中（跟通讯录 `S.persona.id === p.id` 一个口径）。
             */
            const active =
              (S.conversation && S.conversation.id === c.id) ||
              (isGroup
                ? S.conversation?.groupId === gidOf(c)
                : S.conversation?.kind === 'direct' && S.conversation.personaId === c.personaId);
            return `<div class="item ${active ? 'active' : ''}" data-conv="${c.id}">
              ${avatar}
              <div class="who">
                <div class="line1"><b>${esc(title)}</b><span>${hhmm(c.updatedAt)}</span></div>
                <div class="line2"><span class="dot ${esc(c.status)}"></span>${sub}</div>
              </div>
            </div>`;
          }).join('')
        : '<div class="empty" style="padding:36px 12px">还没有消息<br />先去<strong>通讯录</strong>发起群聊或找个人聊</div>');

    $('listBody').querySelectorAll('[data-conv]').forEach((el) => {
      // 走 openConversationSafe：这段可能刚被另一个窗口删掉（E2047 → 说人话 + 收拾界面）
      el.onclick = () => openConversationSafe(el.dataset.conv);
    });
    /*
     * 「已归档 N」挂在**底部固定条**上（2026-10-20 用户定：固定在底部）：
     * 它是低频收件箱，不该占列表最贵的第一屏；固定条不跟着列表滚，
     * 会话再多也永远看得见。没有归档时 archivedEntryHTML 返回空串 → 整条不占高度。
     */
    if (foot) {
      foot.innerHTML = archivedEntryHTML();
      const archEntry = foot.querySelector('#archEntry');
      if (archEntry) archEntry.onclick = () => enterArchiveView();
    }

    /*
     * 「不显示 / 删除」不在每一行上绑按钮了 —— 2026-10-20 起是**右键菜单**，
     * 走 `#listBody` 上的 contextmenu 委托（boot 区注册一次，见那儿的长注释）。
     * 原来这里那段 `[data-hide]` 逐个绑定连同行内的 × 一起删掉了。
     */
    return;
  }

  if (S.nav === 'plugins') {
    // 工作台首页是整页宫格（左栏被 CSS 收掉）；
    // 进了**有主从布局**的插件，左栏由 renderPluginMaster 负责画 —— 这里别去清它；
    // 项目页（左栏 = 项目列表）和项目看板同理 —— 左栏归它们自己管，renderList 别抢
    if (S.projectList || S.projectId) return;
    const p = S.plugins.find((x) => x.id === S.plugin);
    if (!p?.panel?.split) $('listBody').innerHTML = '';
    return;
  }

  if (S.nav === 'settings') {
    // 分节清单跟左栏面包屑共用 SETTINGS_SECTIONS（见 openSettings）
    const items = SETTINGS_SECTIONS;
    $('listBody').innerHTML = items
      .map(
        ([key, title, sub]) => `<div class="item ${S.settingsSection === key ? 'active' : ''}" data-set="${key}">
          <div class="who">
            <div class="line1"><b>${title}</b></div>
            <div class="line2">${sub}</div>
          </div>
        </div>`,
      )
      .join('');
    $('listBody').querySelectorAll('[data-set]').forEach((el) => {
      el.onclick = () => openSettings(el.dataset.set);
    });
    return;
  }

  // 工作流页的左栏归工作流自己画：**编排 = 模板列表，实例 = 发起记录**。
  // 以前这里是一句「工作流 / 开发中」的占位（功能刚做时的死代码），
  // 后来删掉了占位 —— 但删了之后它会**落到下面的消息分支**，把左栏画成会话列表 ✗
  // 所以这里要显式接管：谁调 renderList、什么顺序调，左栏都是对的。
  if (S.nav === 'workflows') {
    if (S.flowMode === 'run') renderRunList();
    else renderFlowList();
    return;
  }

  // 专家库是整页卡片墙（左栏被 CSS 收掉）：左栏谁都不画，清空兜底。
  // 不显式接管的话会落到下面的通讯录分支，把会话列表画进一面看不见的栏里（白画还留隐患）。
  if (S.nav === 'experts') {
    $('listBody').innerHTML = '';
    return;
  }

  // 通讯录 = 群聊 + 数字员工 两段（搜的时候空的段不占地方）
  // 群聊**包含被「不显示」的**（2026-10-20 用户要求）：
  // 「不显示」隐藏的是**这行会话消息**，不是群本身 —— 群、成员、群助手都还在，
  // 所以通讯录里照常列出来（不打任何"已隐藏"标记，那会让人以为群被处理过）。
  // 消息列表里它仍然不出现，直到群里再来新消息。
  //
  // ⚠️ 群的**身份**来自 `S.groups`（groups 表），**不是**从会话推（2026-10-20 用户实报：
  // 「在通讯录里，群为什么也没了」）。以前是按 conversations 里 kind='group' 去重出来的，
  // 于是会话一删光（或一段都没留）群就在通讯录消失 —— 但群是容器，容器不该因片段删光而消失。
  // 会话只用来补"最近说了什么 / 状态"，零段的群照样列出来（副标题写「还没聊过」）。
  const latestConvOfGroup = new Map(); // 群 id → 这个群最近一段（可见优先，其次被隐藏的）
  for (const c of [...S.conversations, ...(S.hiddenConversations ?? [])]) {
    if (c.kind !== 'group') continue;
    const gid = gidOf(c);
    if (!latestConvOfGroup.has(gid)) latestConvOfGroup.set(gid, c);
  }
  const groups = (S.groups ?? [])
    .map((g) => ({ ...g, conv: latestConvOfGroup.get(g.id) ?? null }))
    .filter((g) => match(g.title));
  const people = S.personas.filter((p) => match(p.name));
  /**
   * 分段标题。收起时**整段内容不渲染**（不是单纯 display:none）——
   * 收起就没有它的 DOM，点了也不会先闪一下再消失。
   * 搜索时强制展开：不然搜到了却看不见，会以为没搜到。
   */
  const collapsed = S.secCollapsed ?? (S.secCollapsed = {});
  const sec = (key, title, n, body) => {
    const shut = !q && !!collapsed[key];
    return (
      `<div class="list-sec ${shut ? 'shut' : ''}" data-sec="${key}" title="${shut ? '展开' : '收起'}">
         <i class="sec-arrow"></i>${title} <span class="sec-n">${n}</span>
       </div>` + (shut ? '' : `<div class="sec-body">${body}</div>`)
    );
  };

  const groupRows = groups
    .map(
      // data-group 必须是**群 id**：点它进的是群详情页，走的是 /api/groups/:id
      (g) => {
        const c = g.conv;                                  // 零段的群没有 conv，别去读 c.xxx
        const preview = cut(plain(c?.lastMessage), 22);
        return `<div class="item ${S.groupThreadId === g.id || S.conversation?.groupId === g.id ? 'active' : ''}" data-group="${esc(g.id)}">
        <div class="avatar grp">${esc(initial(g.title))}</div>
        <div class="who">
          <div class="line1"><b>${esc(g.title)}</b></div>
          <div class="line2"><span class="dot ${esc(c?.status ?? '待跑')}"></span>${g.memberCount} 人 · ${esc(preview || '还没聊过')}</div>
        </div>
      </div>`;
      },
    )
    .join('');

  const personRow = (p) => `<div class="item ${S.persona && S.persona.id === p.id ? 'active' : ''}" data-persona="${p.id}">
        ${personaAvatar(p)}
        <div class="who">
          <div class="line1"><b>${esc(p.name)}${p.builtin ? '<i class="b-inline" title="出厂就在的员工：名字、职责与技能随平台固定，删不掉">内置</i>' : ''}</b></div>
          <div class="line2">${esc(personSubtitle(p))}</div>
        </div>
        <i class="dot ${p.busy ? 'busy' : ''}" title="${p.busy ? '正在干活' : '现在闲着'}"></i>
      </div>`;
  /* 数字员工按 A–Z 分组（微信通讯录那种，2026-10-20 用户要求）。
     搜索时**不插字母头**：结果已经少而散，再按字母切开反而碎；行本身仍是排好序的。 */
  const personRows = groupPeopleByInitial(people)
    .map((g) => `${q ? '' : `<div class="list-letter" aria-hidden="true">${g.letter}</div>`}${g.rows.map(personRow).join('')}`)
    .join('');

  $('listBody').innerHTML = !groups.length && !people.length
    ? '<div class="empty" style="padding:36px 12px">通讯录还是空的<br />点右上角 ＋ 发起群聊或添加员工</div>'
    : (groups.length || !q ? sec('group', '群聊', groups.length, groups.length ? groupRows : '<div class="list-none">还没有群聊</div>') : '') +
      (people.length || !q ? sec('person', '数字员工', people.length, people.length ? personRows : '<div class="list-none">还没有数字员工</div>') : '');

  $('listBody').querySelectorAll('[data-sec]').forEach((el) => {
    el.onclick = () => {
      S.secCollapsed[el.dataset.sec] = !S.secCollapsed[el.dataset.sec];
      saveCollapsed();
      renderList();
    };
  });

  $('listBody').querySelectorAll('[data-conv]').forEach((el) => {
    el.onclick = () => openConversation(el.dataset.conv).catch((e) => toast(e.message, 'error'));
  });
  // 通讯录点群聊 = **看群详情**（右侧），不跳对话。
  // 要聊，去详情里点「发消息」。
  $('listBody').querySelectorAll('[data-group]').forEach((el) => {
    el.onclick = () => openGroupDetail(el.dataset.group).catch((e) => toast(e.message, 'error'));
  });
  // 通讯录点员工 = **看详情**（右侧），不跳对话。
  // 要聊，去详情里点「发消息」——那条路会切到消息模块并把光标放好。
  $('listBody').querySelectorAll('[data-persona]').forEach((el) => {
    el.onclick = () => openDetail(el.dataset.persona).catch((e) => toast(e.message, 'error'));
  });
}

/* ------------------------------------------------------------ 新建选择器 */

/** 「＋」菜单里的图标（描边风格，跟左侧导航一致） */
const ICON_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11.5c0 3.3-3.6 6-8 6-1.2 0-2.3-.2-3.3-.6L4 19l1.2-3.4C4.4 14.6 4 13.1 4 11.5c0-3.3 3.6-6 8-6s8 2.7 8 6z"/></svg>';
const ICON_PERSON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="8" r="3.2"/><path d="M4 19.5c0-3.4 2.7-5.6 6-5.6"/><path d="M17.5 13.5v7M14 17h7"/></svg>';
const ICON_NOTE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4.5h9l5 5v10H5z"/><path d="M14 4.5v5h5"/><path d="M8.5 13h7M8.5 16h4"/></svg>';
const ICON_IMPORT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v9"/><path d="M8.5 10.5 12 14l3.5-3.5"/><path d="M5 16.5v3h14v-3"/></svg>';
/** 执行结果里的产物图标：文件 / 链接（跟上面同一套描边风格） */
const ICON_FILE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4.5h9l5 5v10H5z"/><path d="M14 4.5v5h5"/></svg>';
const ICON_LINK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 13.5a3.5 3.5 0 0 0 5 0l2.5-2.5a3.5 3.5 0 0 0-5-5L11.8 7"/><path d="M13.5 10.5a3.5 3.5 0 0 0-5 0L6 13a3.5 3.5 0 0 0 5 5l1.2-1.2"/></svg>';

/**
 * 「＋」拉出来的选择菜单：一个入口，几种结果。
 * 菜单项形如 { label, hint, icon, run }。通讯录和技能共用这一套样式。
 */
let addMenu = null;
/** 打开菜单的那颗按钮 —— 定位和"点别处收起"都靠它，别再写死 `#listAction` */
let addMenuAnchor = null;
function closeAddMenu() {
  if (addMenu) { addMenu.remove(); addMenu = null; }
  addMenuAnchor = null;
}
function openAddMenu(items, anchor = null) {
  closeAddMenu();
  const box = document.createElement('div');
  box.className = 'add-menu';
  box.innerHTML = items
    .map(
      (it, i) => `<button data-add="${i}" title="${esc(it.hint)}">
        <i class="ico">${it.icon ?? ''}</i>
        <span class="txt"><b>${esc(it.label)}</b><em>${esc(it.hint)}</em></span>
      </button>`,
    )
    .join('');
  const head = document.querySelector('.list-head');
  head.append(box);
  /*
   * 让「＋」落在菜单的中线上：按**打开它的那颗按钮**算，不写死像素。
   *
   * ⚠️ 以前这里写死 `#listAction`。技能搬进「设置 → 技能」之后，那颗 ＋ 在主区
   * （`#skNew`），而 `#listAction` 在设置页是**隐藏的** —— 隐藏元素的 getBoundingClientRect()
   * 全是 0，菜单会跑到左上角去。
   */
  const anchorEl = anchor ?? document.querySelector('#listAction');
  const btn = anchorEl.getBoundingClientRect();
  const hb = head.getBoundingClientRect();
  const w = box.getBoundingClientRect().width;
  let left = btn.left + btn.width / 2 - w / 2;
  left = Math.min(Math.max(left, 8), window.innerWidth - w - 8); // 别探出视口
  box.style.left = Math.round(left - hb.left) + 'px';
  box.style.right = 'auto';
  /*
   * 竖直位置：**打开菜单的那颗按钮不在左栏头部里**时（主区那颗「＋」，
   * 比如「代码仓库 → ＋ 添加仓库」），菜单得跟着按钮走。
   *
   * CSS 里写的是 `top: calc(100% - 4px)` —— 那是"紧贴左栏页头下面"，
   * 对页头里那颗 ＋ 正好；但主区那颗 ＋ 在页面几十到几百像素以下，
   * 菜单会**浮在按钮上方老远**，看着像从别处冒出来的。
   */
  if (!head.contains(anchorEl)) {
    box.style.top = Math.round(btn.bottom - hb.top + 6) + 'px';
  }
  box.querySelectorAll('[data-add]').forEach((b) => {
    b.onclick = () => { closeAddMenu(); items[Number(b.dataset.add)].run(); };
  });
  addMenuAnchor = anchorEl;
  addMenu = box;
}

/** 通讯录的「＋」：建群还是建员工 */
const contactAddItems = () => [
  { label: '发起群聊', hint: '拉几个人组个项目群，@ 谁谁接话', icon: ICON_CHAT, run: openGroupDialog },
  { label: '添加数字员工', hint: '配一个 agent CLI 当同事', icon: ICON_PERSON, run: openPersonaDialog },
];

/** 技能的「＋」：手写一个还是从本地导入 */
const skillAddItems = () => [
  { label: '新建技能', hint: '从空白 SKILL.md 开始写', icon: ICON_NOTE, run: newSkill },
  { label: '从本地导入', hint: '把本机已有的 SKILL.md 拷进库里', icon: ICON_IMPORT, run: openImportDialog },
];

/**
 * 「代码仓库」的「＋ 添加仓库」：手动接入 还是 从 GitHub 挑。
 *
 * 两条路**一直都在**（不像原来那样：没连 GitHub 时压根没有"从 GitHub 挑"）——
 * 没连就让它点下去，弹窗里会把"拉不到清单"的原因说出来，那比"这个入口不存在"清楚。
 * 顺序上把「从 GitHub 添加」放前面：连了 GitHub 的话它是主路。
 */
const gitAddRepoItems = (onDone) => [
  {
    label: '从 GitHub 添加',
    hint: '从账号里挑一个仓库，克隆进来',
    icon: ICON_CLOUD,
    run: () => openGitPickDialog(onDone),
  },
  {
    label: '手动接入',
    hint: '本地已有克隆 / 私有仓库 / 离线：只记路径，不联网',
    icon: ICON_FOLDER,
    run: () => openGitManualDialog(onDone),
  },
];
document.addEventListener('click', (e) => {
  if (!addMenu) return;
  if (e.target.closest('.add-menu')) return; // 点在菜单里
  // 点在**打开它的那颗按钮**上就不收 —— 那颗按钮的 onclick 自己会处理（以前只认 #listAction，
  // 于是从主区那颗「＋ 新建技能」打开时，同一次点击冒泡到这儿就把它关掉了）
  if (addMenuAnchor?.contains(e.target)) return;
  closeAddMenu();
});

/* ------------------------------------------------------------ 视图切换 */

/**
 * 员工详情的**自动保存**：模块级一个引用，由 renderDetail 挂上。
 *
 * 为什么要有：保存从"点按钮"改成"改了就算"之后，最后那次输入还在防抖队列里，
 * 这时切视图 / 打开别的员工 / 关窗口，不先 flush 就丢了 —— 用户会以为"我明明改了"。
 */
let flushDetailSave = null;
window.addEventListener('pagehide', () => { if (flushDetailSave) flushDetailSave({ keepalive: true }); });

function showView(which) {
  if (which !== 'detail' && flushDetailSave) flushDetailSave(); // 离开详情前先落盘（自动保存的兜底）
  const on = (id, cond) => $(id)?.classList.toggle('shown', cond);
  $('chatView')?.classList.toggle('hidden', which !== 'chat');
  // 2026-10-22：全部改可选链 —— 某个 view 容器万一缺了（expertsView 就漏建过），
  // 只损失那一页，不该把整个 showView 炸掉连累所有页面白屏
  on('detailView', which === 'detail');
  on('settingsView', which === 'settings');
  on('groupView', which === 'group');
  on('expertsView', which === 'experts');
  on('pluginView', which === 'plugin');
  on('flowView', which === 'flow');
  on('placeholderView', which === 'placeholder');
}

/** 还没做的东西：先说好是"开发中"，别做成点不动的空壳 */
function showPlaceholder(title) {  $('placeholderView').innerHTML = `
    <div class="detail-head"><b>${esc(title)}</b></div>
    <div class="detail-body"><div class="wip">开发中</div></div>`;
  showView('placeholder');
}

/* -------------------------------------------------------------- 工作流 */

/**
 * 工作流模块 = **编排模板**。
 *
 * 左栏列模板，点一个直接进设计器。
 * 跑起来的实例**不在这儿** —— "模板怎么编"和"这一单走到哪了"是两件事，
 * 混在一起左栏就成了流水账（试过，不对）。
 */
async function openWorkflows(pickId = null) {
  S.flowMode = 'design'; // 编排模板（run 模式是看发起记录）
  // **先把一级栏落定再画左栏**：左栏的渲染有"只属于当前一级栏"的守卫，
  // 从工作台进来时 S.nav 还是 plugins，不先切过来就会画出一片空白（踩过）。
  setNav('workflows', { skipOpen: true });
  document.body.classList.remove('no-list');
  // 左栏顶上就是"你在哪儿"：工作台 › 流程编排（面包屑从右页头挪过来，见 setListTitle）
  // 二级叫「流程编排」而不是「工作流」：这一页是编排模板的地方，跟工作台那颗
  // 「流程编排」磁贴同名（2026-10-19 用户截图指出）。
  setListTitle([{ label: '工作台', to: 'workbench' }, { label: '流程编排' }]);
  setRoute('workflows', pickId ? { template: pickId } : {});
  $('listAction').classList.remove('hidden');
  $('listAction').title = '新建流程模板';
  $('search').closest('.list-search')?.classList.add('hidden');

  let data = { templates: [] };
  try {
    data = await api('/api/workflows');
  } catch { /* 拿不到就当空的，别白屏 */ }
  S.flowTemplates = data.templates ?? [];

  if (pickId) S.designerId = pickId;
  if (!S.flowTemplates.some((t) => t.id === S.designerId)) S.designerId = S.flowTemplates[0]?.id ?? null;

  renderFlowList();
  if (S.designerId) await openDesigner(S.designerId);
  else renderFlowEmpty();
}

function renderFlowList() {
  // 同 renderRunList：左栏属于当前的一级栏，切走了就不许画
  if (S.nav !== 'workflows') return;
  $('listBody').innerHTML = S.flowTemplates.length
    ? S.flowTemplates
        .map(
          (t) => `<div class="item ${t.id === S.designerId ? 'active' : ''}" data-tpl="${esc(t.id)}">
            <div class="who">
              <div class="line1"><b>${esc(t.name)}</b>${t.builtIn ? '<span>内置</span>' : ''}</div>
              <div class="line2">${(t.nodes ?? []).length} 个节点${t.builtIn ? '' : ' · 自建'}</div>
            </div>
          </div>`,
        )
        .join('')
    : '<div class="empty" style="padding:24px 12px">还没有流程模板<br />点右上角「＋」新建一个</div>';

  $('listBody').querySelectorAll('[data-tpl]').forEach((el) => {
    el.onclick = () => openDesigner(el.dataset.tpl).catch((e) => toast(e.message, 'error'));
  });
}

function renderFlowEmpty() {
  // 没有页头：左栏顶上已经是「工作台 › 流程编排」，右页头再写一遍就是同一件事写两处
  $('flowView').innerHTML = `
    <div class="detail-body"><div class="wip">还没有流程模板 —— 点左栏右上角的「＋」新建一个</div></div>`;
  S.view = 'flow';
  showView('flow');
}

/** 新建模板：先给一个起点节点，进去再改 */
async function newTemplateDialog() {
  const name = await askText({ title: '新流程叫什么名字？', placeholder: '例如：发文流程' });
  if (name === null) return;
  try {
    const t = await api('/api/workflows/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name.trim() || '未命名流程',
        nodes: [{ id: 'n1', name: '第一步', detail: '', approve: 'end', reject: '' }],
      }),
    });
    await openWorkflows(t.id);
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* ---------------------------------------------- 流程：发布 / 发起 / 实例页 */

/**
 * 工作台里的「流程」分组：**只有发布过的才在这儿**。
 * 点进去是**这个流程的发起记录页**，发起是那个页面上的动作（不在工作台直接发起）。
 */
/* 工作台磁贴的卡片结构（2026-10-20 重设计）：图标 + 名字 + **一句说明**。
   说明直接把原来 title 里的那句话亮出来 —— 磁贴光秃秃一个名字，用户得悬停才知道去哪儿；
   一句话摆在卡上，入口页才有"总览"的样子。统一走 wbCard() 拼，三段不各写一遍。 */
const wbCard = (cls, icon, name, desc, attr, icoStyle = '') => `
  <button class="wb-tile" ${attr} title="${esc(desc)}">
    <span class="wb-ico ${cls}" ${icoStyle}>${icon}</span>
    <span class="wb-tx"><span class="wb-name">${esc(name)}</span><span class="wb-desc">${esc(desc)}</span></span>
  </button>`;

function workbenchFlowSection() {
  const list = S.flowPublished ?? [];
  /* ⚠️ 工作台的三段（项目 / 自动化 / 流程）**不再用 `<section class="fx">`**（2026-10-19）：
     `.fx + .fx` 自带一条横分隔线，几段竖着一叠就是几条横带、每带右侧一场空。
     统一用 `.wb-sec`（一行小标题）+ `.wb-grid`，跟插件那几段接在同一条流里。 */
  return `
    <div class="wb-sec">流程</div>
    <div class="wb-grid">
      <!-- 编排入口：原来在左边 rail 的「工作流」那一项，现在收进工作台 -->
      ${wbCard('flow', ICON_WB_FLOW, '流程编排', '画流程：节点、指派、发布', 'data-flow-design')}
      ${list
        .map(
          (f) => wbCard('flow', ICON_WB_FLOW, f.name, '点开看这个流程的发起记录', `data-flow-start="${esc(f.id)}"`),
        )
        .join('')}
    </div>`;
}

/* ---------------------------------------------------------------- 项目 */

/**
 * 工作台里的「自动化」——现在只有**定时任务**这一项。
 *
 * 为什么单开一组、不塞进「项目」：项目是"在哪儿干活"，定时任务是"到点谁去干活"，
 * 两类东西混在一格宫格里，人会以为定时任务是某个项目的附属品（它其实可以不关联项目）。
 * 以后再加触发器、监控之类的，也落这一组。
 */
function workbenchAutoSection() {
  return `
    <div class="wb-sec">自动化</div>
    <div class="wb-grid">
      ${wbCard('cron', ICON_WB_CLOCK, '定时任务', '到点自动做一件事：干什么、交给谁、多久一次', 'data-schedules')}
    </div>`;
}

/**
 * 工作台里的「项目」入口 —— 点进去是项目列表，在那儿增删改查。
 *
 * 为什么要有项目：现在"在哪儿干活"只有 `personas.cwd` 一个字段，
 * 六个员工全指着同一个目录 —— 看着是对的，但一有第二个项目就会**安静地改错地方**。
 * 项目 = 给"在哪儿干活"起个名字、可复用、可写规矩的东西。
 * （以前这里那段话把"工作区"和"项目"当成两个词用 —— 其实是一个东西，现在统一叫项目。）
 *
 * 右边那个「任务看板」（2026-10-15）是**同一张看板，换个范围**：项目里看的是"这个项目的活"，
 * 这里看的是"所有的活"。所以它紧挨着「项目」放 —— 一个是"在哪儿干活"，一个是"都有什么活"。
 */
function workbenchProjectSection() {
  /* 分组名后面**不再挂计数**（2026-10-19 去掉）：`.wb-sec` 是一行小标题，
     上面写"项目 2"会被读成"有 2 个项目"，而它其实说的是"这一格有 2 块磁贴" ——
     两个意思撞在一个数字上。宫格里的东西一眼数得清，不需要计数。 */
  return `
    <div class="wb-sec">项目</div>
    <div class="wb-grid">
      ${wbCard('proj', ICON_FOLDER, '项目', '名字、目录、规矩都在这儿管', 'data-projects')}
      ${wbCard('board', ICON_WB_BOARD, '任务看板', '所有项目的活，铺在同一张看板上', 'data-task-board')}
    </div>`;
}

/**
 * 项目页：**两个区、中间一条分隔线**（2026-10-18，跟「服务器与密钥」那页同一套布局）：
 * 项目列表住**全局左栏**（跟消息/通讯录同一个位置，主区之间是 app 自带的那条竖分隔线），
 * 右侧主区是选中项目的详情（常驻编辑区 + 任务统计 + 三个动作）。
 * 「＋ 新建项目」也在左栏头上那颗 ＋ 上 —— 跟插件主从页一个路数。
 */
async function openProjectsPage(selectId) {
  setRoute('projects');
  S.projects = (await api('/api/projects')).projects ?? [];
  const view = $('pluginView');
  view.classList.remove('kb-page'); // 详情按普通长页面滚，不套看板那套满屏布局
  S.projectList = true;             // 位置记忆：刷新回到项目列表
  S.projectId = null;
  S.boardAll = false;               // 离开全局面板（它跟项目列表/看板是三条路）
  savePlace();
  const sel = S.projects.find((x) => x.id === (selectId ?? S.projSel)) ?? S.projects[0] ?? null;
  S.projSel = sel?.id ?? null;

  // 左栏 = 项目列表（左栏让出来：从目录进项目页时它是收着的）。
  // ⚠️ 原来左栏最上面还有一条「‹ 工作台」（照消息页「‹ 返回消息」那套路数加的），
  // 2026-10-19 统一子页页头后撤掉了：**返回只留在页头最左边**。
  // 留着它等于同一件事两个地方能做，而且只有项目页有，别的子页没有 —— 这就是不统一。
  document.body.classList.remove('no-list');
  /* 左栏顶上**只写到二级**「工作台 › 项目」（2026-10-19 用户：「项目这个只要二级目录就可以了，
     不需要三级目录。因为右边的详情区有了」）：项目名就在右侧详情区的 p-head 里，
     面包屑再写一遍是同一件事说两遍；而且左栏列表里当前项目本来就高亮着。
     ⚠️ 右边再没有这一段了，所以项目改名时**不用**同步标题（名字只在详情里变）。 */
  setListTitle([{ label: '工作台', to: 'workbench' }, { label: '项目' }]);
  $('listAction').classList.remove('hidden');
  $('listAction').title = '新建项目';
  $('listBody').innerHTML =
    (S.projects.length
      ? S.projects
          .map(
            (p) => `<div class="item${p.id === S.projSel ? ' active' : ''}" data-proj-sel="${esc(p.id)}">
              <div class="who">
                <!-- 「内置」角标用通讯录同款 .b-inline 塞进 <b> 里 —— line1 是 space-between，
                     挂在外面会被推到行最右，看着像个时间戳（2026-10-20 收口）。 -->
                <div class="line1"><b>${esc(p.name)}${
                  p.builtIn ? '<i class="b-inline">内置</i>' : ''
                }</b></div>
                <div class="line2" title="AI 会在这个目录里干活">${esc(p.root)}</div>
              </div>
            </div>`,
          )
          .join('')
      : '<div class="empty" style="padding:36px 12px">还没有项目<br />点右上角 ＋ 新建一个</div>');
  // 左栏选谁，右边看谁（就地换详情，不整页跳）
  $('listBody').querySelectorAll('[data-proj-sel]').forEach((el) => {
    el.onclick = () => openProjectsPage(el.dataset.projSel).catch((e) => toast(e.message, 'error'));
  });

  /* 右页头**去掉了**（2026-10-19 用户：「面包屑应该是在左边的列表上，右边的不用」）：
     原来这里只有一段「工作台 › 项目 › 名字」，现在整段挪到了左栏顶上；右侧直接是详情，
     名字/目录/动作都在详情自己的 p-head 里，页头再写一遍纯属重复。
     （左栏顶上那条「‹ 工作台」也不加回来：面包屑的「工作台」段就是回宫格的入口。） */
  view.innerHTML = `
    <div class="detail-body" id="projDetail">${
      sel ? '<div class="dim">加载中…</div>' : '<div class="empty" style="padding:36px 12px">左边选一个项目</div>'
    }</div>`;
  S.view = 'plugin';
  showView('plugin');
  if (sel) await renderProjDetail(sel);
}

/**
 * 右侧详情 = 照**员工详情页**的骨架改（2026-10-18 用户定的）：
 * 顶部 p-head 一行 = 项目概览信息（名字 + 目录 pill）+ 右侧动作按钮；
 * ⚠️ 2026-10-19 用户截图圈掉左侧那枚蓝色「班」字方块（`.avatar.proj`）：去掉，
 *    项目名本身就是页面标题，头像那个色块在这儿只是多一块颜色，没有"这是谁"的信息量
 *    （员工头像不一样——它是"人"，项目是"地方"）。
 * 下面 tabs 两页：**基础信息**（名称/目录/附加目录/说明 + 任务统计）、**项目规章**（＝宪法）。
 * 字段仍是常驻输入区（没有"点编辑"那步）；tabs 一次渲染、切显隐 ——
 * 在基础信息改了一半去规章再回来，改动还在（同员工详情页的做法）。
 */
async function renderProjDetail(p) {
  const box = $('projDetail');
  if (!box) return;
  let data = null;
  let err = '';
  try {
    data = await api(`/api/projects/${encodeURIComponent(p.id)}/tasks`);
  } catch (e) {
    err = e.message;
  }
  const extraText = (() => {
    try { return JSON.parse(p.extraRoots || '[]').join('\n'); } catch { return ''; }
  })();
  const stat = (label, n) => `<span class="kb-stat">${esc(label)} <b>${n ?? 0}</b></span>`;
  box.innerHTML = `
    <div class="p-head">
      <div class="p-head-main">
        <h2>${esc(p.name)}${p.builtIn ? '<span class="pill role">内置</span>' : ''}</h2>
        <div class="p-meta">
          <span class="pill" title="AI 会在这个目录里干活">${esc(p.root ?? '')}</span>
        </div>
      </div>
      <div class="hero-actions">
        <!-- 保存状态：改了就自动存，这里是唯一的回执（跟员工详情同一条 .save-state 样式）。
             原来这儿是一颗「保存」按钮 —— 四个字段都要点一次，忘了点就白改。
             ⚠️ 它**不占位**：宽度 0 + 往左溢出，所以"改成已保存"时不推按钮；
                 靠 text-align:right 让它从按钮左边往回长，永远不会被右边界截掉。
                 （样式在 style.css 的 .pj-save） -->
        <span class="save-state pj-save" id="pjSaveState"></span>
        <button class="primary" id="pjTasks">任务</button>
        ${p.builtIn ? '' : '<button class="danger" id="pjDel">删除</button>'}
      </div>
    </div>

    <div class="tabs">
      <button class="tab on" data-tab="basics">基础信息</button>
      <button class="tab" data-tab="rules">项目规章</button>
    </div>

    <section class="tab-panel" data-panel="basics">
      <div class="group">
        <div class="form-row">
          <div class="row-label">项目名称</div>
          <div>
            <input id="pjName" value="${esc(p.name ?? '')}" placeholder="例如：班底" />
            <!-- （2026-10-20 用户："这些文案去掉"）原「改了自动保存，不用点按钮。」删 -->
          </div>
        </div>
        <div class="form-row">
          <div class="row-label">工作目录</div>
          <div>
            <div class="row-with-btn">
              <input id="pjRoot" value="${esc(p.root ?? '')}" placeholder="例如：E:\\02CodeSpace\\bandi" />
              <button type="button" id="pjPick" title="选一个本机目录（AI 会在这里干活）">选择</button>
            </div>
            <!-- （2026-10-20 用户："这些文案去掉"）原「AI 就在这个目录里干活。」删 -->
          </div>
        </div>
        <div class="form-row top">
          <div class="row-label">附加目录</div>
          <div>
            <textarea id="pjExtra" style="height:56px" placeholder="一行一个路径，例如 E:\\shared\\docs">${esc(extraText)}</textarea>
            <div class="counter">一行一个，可留空 —— AI 还可以读写的其他目录。</div>
          </div>
        </div>
        <div class="form-row top">
          <div class="row-label">项目说明</div>
          <div>
            <textarea id="pjNote" style="height:72px" placeholder="构建命令、备注……">${esc(p.note ?? '')}</textarea>
            <!-- （2026-10-20 用户："这些文案去掉"）原「只给人看，AI 看不到。」删 -->
          </div>
        </div>
      </div>

      ${err
        ? `<div class="dim" style="margin-top:10px">任务统计取不到：${esc(err)}</div>`
        : `<div class="kb-stats" style="margin-top:14px">
            ${stat('任务共', data?.total)}
            ${stat('待人确认', data?.waiting_count)}
            ${stat('停下等人', data?.blocked_count)}
            ${stat('失败', data?.failed_count)}
            ${stat('流程实例', data?.flow_count)}
            ${stat('聊天派活', data?.chat_count)}
          </div>`}
      <div class="kb-tip" style="margin-top:10px">点右上角「任务」进这个项目的看板：流程的每次办理和聊天派活都在那儿，卡片能拖、能点进源头。</div>
    </section>

    <section class="tab-panel" data-panel="rules" hidden>
      <div class="group">
        <div class="form-row top">
          <div class="row-label">宪法（本项目特有的硬约束）</div>
          <div>
            <textarea id="projConstInput" style="height:180px" placeholder="只写本项目特有的（共通规矩契约已经管了）：&#10;例如：零依赖，不许引入 npm 包；端口固定 8787；改 store.mjs 的 SQL 必须先问人">${esc(p.constitution ?? '')}</textarea>
            <div class="counter">派活时会全文带给 AI，并注明「只许加码，与契约冲突以契约为准」。</div>
          </div>
        </div>
      </div>
    </section>`;

  // 标签：一次渲染、切显隐 —— 不重建 DOM，所以在「基础信息」改了一半去「规章」再回来，改动还在
  // （切之前先 flush：刚敲完就切走，防抖那 700ms 不该把改动吞掉）
  const tabs = box.querySelectorAll('[data-tab]');
  const panels = box.querySelectorAll('[data-panel]');
  const showTab = (key) => {
    tabs.forEach((t) => t.classList.toggle('on', t.dataset.tab === key));
    panels.forEach((sec) => { sec.hidden = sec.dataset.panel !== key; });
  };
  tabs.forEach((t) => { t.onclick = () => { pjSaveNow(); showTab(t.dataset.tab); }; });
  showTab('basics');

  $('pjPick').onclick = () => pickProjectDir('pjPick', 'pjRoot');

  /* ---------------- 自动保存（2026-10-19 用户要求：去掉「保存」按钮） ----------------
   * 分寸跟员工详情、任务卡那条一样：
   *   · 输入框防抖 700ms；失焦立刻存；切标签 / 离开页面先 flush。
   *   · **不重画整页**：重画会丢焦点、把标签弹回"基础信息"；
   *     只有名字变了才同步左栏那一行（那是另一个容器，跟焦点无关）。
   *   · 名字 / 目录空着不提交（服务端会拒）：状态直接写清楚，人知道自己少填了什么。
   *   · 保存中又来改动 → 存完补一次（串行；同时打两个 PUT 会互相覆盖）。 */
  const pjState = $('pjSaveState');
  const setPjState = (text, kind = '') => {
    if (!pjState) return;
    pjState.textContent = text;
    pjState.className = 'save-state' + (kind ? ' ' + kind : '');
  };
  const collect = () => ({
    name: $('pjName').value.trim(),
    root: $('pjRoot').value.trim(),
    extraRoots: $('pjExtra').value.split('\n').map((s) => s.trim()).filter(Boolean),
    note: $('pjNote').value.trim(),
    constitution: $('projConstInput').value.trim(),
  });
  let lastSaved = JSON.stringify(collect());
  let pjTimer = null;
  let pjSaving = false;
  let pjQueued = false;

  const pjSaveNow = async ({ keepalive = false } = {}) => {
    if (pjTimer) { clearTimeout(pjTimer); pjTimer = null; }
    if (!box.isConnected) return false; // 页面已经换了，别再往旧项目上写
    const payload = collect();
    if (!payload.name) { setPjState('名字不能空 · 未保存', 'bad'); return false; }
    if (!payload.root) { setPjState('工作目录不能空 · 未保存', 'bad'); return false; }
    const json = JSON.stringify(payload);
    if (json === lastSaved) { setPjState('已保存', 'ok'); return true; }
    if (pjSaving) { pjQueued = true; return false; }
    pjSaving = true;
    setPjState('保存中…', 'wait');
    try {
      const d = await api('/api/projects/' + encodeURIComponent(p.id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: json,
        ...(keepalive ? { keepalive: true } : {}),
      });
      lastSaved = JSON.stringify(payload);
      // 服务端会归一（比如目录去尾斜杠）：把返回值写回内存，左栏和下次进入都用它
      const saved = d?.project;
      if (saved) {
        const i = (S.projects ?? []).findIndex((x) => x.id === saved.id);
        if (i >= 0) S.projects[i] = { ...S.projects[i], ...saved };
      }
      // 名字 / 目录改了才动左栏那一行 —— 那是另一个容器，重画它不影响输入框焦点
      const items = $('listBody')?.querySelectorAll('[data-proj-sel]') ?? [];
      items.forEach((el) => {
        if (el.dataset.projSel !== p.id) return;
        const b = el.querySelector('.line1 b');
        const sub = el.querySelector('.line2');
        if (b) b.textContent = payload.name;
        if (sub) sub.textContent = payload.root;
      });
      /* 改名同步的是**详情区自己**（p-head 的 h2 / 目录 pill），不碰左栏标题 ——
         左栏面包屑只到「工作台 › 项目」二级，项目名不写在里面（见 openProjectsPage）。
         项目头像 2026-10-19 已按用户要求去掉（.avatar.proj 没有宿主了），这里不用再同步它。 */
      const paintName = (name) => {
        const h2 = box.querySelector('.p-head h2');
        if (h2) {
          h2.firstChild.nodeType === 3
            ? (h2.firstChild.nodeValue = name)
            : h2.insertBefore(document.createTextNode(name), h2.firstChild);
        }
        const rootPill = box.querySelector('.p-meta .pill');
        if (rootPill) rootPill.textContent = $('pjRoot').value.trim();
      };
      paintName(payload.name);
      setPjState('已保存', 'ok');
      return true;
    } catch (e) {
      setPjState('保存失败：' + (e?.message ?? '服务异常'), 'bad');
      console.error('[班底] 项目自动保存失败', e?.detail ?? e);
      return false;
    } finally {
      pjSaving = false;
      if (pjQueued) { pjQueued = false; pjSaveNow(); }
    }
  };
  const schedulePjSave = (ms = 700) => {
    setPjState('未保存…', 'wait');
    if (pjTimer) clearTimeout(pjTimer);
    pjTimer = setTimeout(() => { pjTimer = null; pjSaveNow(); }, ms);
  };
  // 离开这一页（切标签页 / 回列表 / 关窗口）前兜底存一次 —— 走的是全局那条 flush 口子
  const stopFlush = () => { flushDetailSave = null; };
  flushDetailSave = (opts) => { pjSaveNow(opts); };

  for (const id of ['pjName', 'pjRoot', 'pjExtra', 'pjNote', 'projConstInput']) {
    $(id)?.addEventListener('input', () => schedulePjSave(700));
    $(id)?.addEventListener('blur', () => pjSaveNow());
  }

  $('pjTasks').addEventListener('click', async () => {
    // 先落盘再走：不然刚改的目录/名字带不进看板（看板是另一个页面）
    await pjSaveNow();
    stopFlush();
    openProjectDetail(p.id).catch((e) => toast(e.message, 'error'));
  });
  $('pjDel')?.addEventListener('click', async () => {
    if (!(await confirmDo(`删掉项目「${p.name}」？\n\n绑在它上面的会话会自动解绑（回到员工默认工作目录），会话本身不删。`))) return;
    stopFlush();
    try {
      await api('/api/projects/' + encodeURIComponent(p.id), { method: 'DELETE' });
      S.projSel = null;
      await openProjectsPage();
    } catch (e) {
      toast(e.message, 'error');
    }
  });
}

/**
 * 项目详情：**平台的一等功能**（项目 → 任务），不是插件。
 *
 * 只负责路由 + 位置记忆 + "项目不在了就回列表"；看板的渲染与接线在
 * `openBoardPage` 里 —— 跟全局任务看板共用同一份（2026-10-19 重构）。
 */
async function openProjectDetail(id) {
  setRoute('project', { id });
  const view = $('pluginView');
  view.classList.add('kb-page'); // 这一页要满屏（见 style.css 的 #pluginView.kb-page）
  // 看板是满屏页，左栏收掉 —— 可能是从项目列表（左栏正放着项目清单）进来的
  document.body.classList.add('no-list');
  S.projectId = id;              // 位置记忆：刷新回到这个项目的看板
  S.projectList = false;
  S.boardAll = false;            // 这一页是"一个项目"的看板，不是全局面板
  S.plugin = null;               // 项目看板不是插件，别让插件那条路抢走位置
  savePlace();
  const p = (S.projects ?? []).find((x) => x.id === id) ?? null;
  if (!p) {
    // 项目列表可能是旧的（别处删了这个项目）—— 回列表，不在这儿瞎猜
    await openProjectsPage();
    return;
  }

  await openBoardPage({ project: p });
}

/**
 * **看板页的共用壳**（2026-10-19 重构）：
 *
 * 项目看板与全局看板本来是两份几乎一样的代码（页头、列、卡片、拖拽、筛选、接线全同），
 * 只差四件事，现在收敛成一个 `project` 参数：
 *   · 数据源：全局 `/api/tasks`（还顺带取项目清单，建卡弹窗要按它列项目）；项目 `/api/projects/:id/tasks`
 *   · 面包屑：全局「工作台 › 任务看板」；项目「项目 › 项目名」
 *   · 刷新回调：各自回自己那一页
 *   · 建卡要不要选项目：`wire.taskProject` 返回当前项目（全局返回 null = 弹窗里选）
 *
 * 两个入口（`openProjectDetail` / `openTaskBoard`）只负责"路由 + 状态标记 + 取到项目行"，
 * 剩下的全在这儿 —— 以后改看板只改一处，不会再出现"改了项目看板忘了全局"。
 */
async function openBoardPage({ project = null } = {}) {
  const view = $('pluginView');
  const isAll = !project;

  let data = null;
  let err = '';
  if (isAll) {
    // 项目清单与看板数据一起取：少一趟来回，也让"刷新后回到看板"更不容易跟宫格渲染抢
    const [projRes, boardRes] = await Promise.allSettled([api('/api/projects'), api('/api/tasks')]);
    if (projRes.status === 'fulfilled') S.projects = projRes.value.projects ?? [];
    if (boardRes.status === 'fulfilled') data = boardRes.value;
    else err = boardRes.reason?.message ?? String(boardRes.reason);
  } else {
    try {
      data = await api(`/api/projects/${encodeURIComponent(project.id)}/tasks`);
    } catch (e) {
      err = e.message;
    }
  }

  view.innerHTML = `
    ${headRow(isAll
      ? breadcrumb([{ label: '工作台', to: 'workbench' }, { label: '任务看板' }])
      : breadcrumb([
          { label: '工作台', to: 'workbench' },
          { label: '项目', to: 'projects' },
          { label: project.name, to: 'projects', arg: project.id },
          { label: '任务看板' },
        ]),
      `${
      err ? '' : kbFilterBar(data) + kbPrRefreshHtml(data)
    }<button data-kb-refresh>刷新</button>`)}
    <div class="detail-body run-wrap">
      ${
        err
          ? `<div class="empty" style="padding:24px 4px">任务取不到：${esc(err)}</div>`
          : `<div class="kb-wrap">
              <div class="kb" id="kbCols">
                ${kbColsHtml(data)}
              </div>
            </div>`
      }
    </div>`;

  S.view = 'plugin';
  showView('plugin');
  // 页头不放开返回按钮（统一去掉）：回到别处靠左栏点那一行
  view.querySelector('[data-kb-refresh]')?.addEventListener('click', () => {
    (isAll ? openTaskBoard() : openProjectDetail(project.id)).catch((e) => toast(e.message, 'error'));
  });
  // 看板那套接线（卡片点进去、手工卡拖动/删除、列头「＋」建卡）两个入口共用
  S.kbLast = {
    data,
    wire: {
      refresh: () => (isAll ? openTaskBoard() : openProjectDetail(project.id)),
      // 项目的看板：建卡不用选项目；全局：null = 弹窗里选
      taskProject: () => project,
    },
  };
  wireBoard(view, S.kbLast.wire);
  wireKbFilter();
}

/** 看板列 → 新建任务时的默认状态（点哪一列的「＋」就默认落在哪一列；拖列也用它换算） */
const COL_STATUS = { idea: '想法', todo: '待办', doing: '进行中', confirm: '待确认', blocked: '已阻塞', done: '已完成' };

/** 全局面板里那张「未归属」的名（服务端 `project-tasks.mjs` 里的 NO_PROJECT，两处同文） */
const NO_PROJECT_LABEL = '（未归属）';

/* kb-filter:pure:start */
/**
 * 看板的**筛选**（2026-10-15 起是"状态"一维，形状参照用户给的 Linear 那张：头上一枚「筛选」+ 弹出的多选层；
 * 2026-10-18 加了"负责人"和"项目"两维，参照 Multica —— 看板一旦有过几十张卡，
 * "只看某人的"和"只看某个项目的"就是最常用的两个动作，比按状态筛还常用）。
 *
 * 下面这一段**不碰 DOM**（只读 `S.kbFilter`、只把传进来的数据算一遍，外加拼一段字符串），
 * 所以能单独抠出来在 node 里跑一遍 —— 见 `tmp/kb-filter-check.mjs`。
 *
 * 选项**从当前这批行现取**，不写死表：平台有两套状态词（流程六态 / 聊天四态），
 * 人和项目更是随数据长，写死了迟早漏。状态的顺序跟着看板从左到右的列走。
 *
 * 三个维度的语义（跟 Multica / Linear 一致，别自创）：
 *   · **同一维里选多个 = 任选其一**（"张三 或 李四"）；
 *   · **不同维之间 = 同时满足**（"张三的 + 这个项目的"）；
 *   · 某一维一个都不勾 = 这一维不设限（不是"什么都不匹配"）。
 */
function kbStatusOptions(data) {
  const seen = new Map();
  for (const c of data?.columns ?? []) {
    for (const card of c.cards) if (card.status) seen.set(card.status, (seen.get(card.status) ?? 0) + 1);
  }
  return [...seen].map(([status, count]) => ({ status, count }));
}

/** 看板的全部行（平的）。老数据没 `rows` 时退回从列里摊平 —— 两处口径必须一样 */
function kbRows(data) {
  return data?.rows ?? (data?.columns ?? []).flatMap((c) => c.cards ?? []);
}

/**
 * 「负责人」的选项：**从行里现数**，一人一行（`id` 是员工 id，不是名字 —— 改名不跑、撞名不串）。
 * 空 id 合并成一行「未指派」：没人认领的活恰恰是最该被筛出来的那一堆。
 */
function kbAssigneeOptions(data) {
  const seen = new Map(); // id -> { id, name, count }
  for (const r of kbRows(data)) {
    const id = r.assignee_id ?? '';
    const cur = seen.get(id) ?? { id, name: id ? String(r.assignee ?? '') : '未指派', count: 0 };
    cur.count += 1;
    if (id && r.assignee) cur.name = String(r.assignee); // 同一个 id 名字总一样，取到就用
    seen.set(id, cur);
  }
  return withGhosts(seen, S.kbFilter?.assignees, (id) => (id ? '（已不在本板）' : '未指派'));
}

/** 「项目」的选项：同上，空 id 合并成「（未归属）」—— 没挂项目、也没落在任何项目目录下的那些活 */
function kbProjectOptions(data) {
  const seen = new Map();
  for (const r of kbRows(data)) {
    const id = r.project_id ?? '';
    const cur = seen.get(id) ?? { id, name: id ? String(r.project_name ?? '') : NO_PROJECT_LABEL, count: 0 };
    cur.count += 1;
    if (id && r.project_name) cur.name = String(r.project_name);
    seen.set(id, cur);
  }
  return withGhosts(seen, S.kbFilter?.projects, () => '（已不在本板）');
}

/**
 * 补上"记着、但这批行里没有"的那些（张数 0）。
 *
 * 少了这一截就会出现：角标写着 1、弹层里一个勾都没有、脚注还说"不勾 = 看全部" ——
 * 看着像筛选坏了，而且找不到地方去掉它（只能靠「清除」）。换看板就会这样：
 * 全局面板勾了某个人，点进一个他没有活的项目看板；人或项目被删了也一样。
 * 补一行让它**看得见、点得掉**，比什么都重要。
 */
function withGhosts(seen, remembered, nameOf, byName = true) {
  for (const id of remembered ?? []) {
    if (!seen.has(id)) seen.set(id, { id, name: nameOf(id), count: 0 });
  }
  if (!byName) return [...seen.values()]; // 不排：状态那一维要跟着看板从左到右走（调用方插好的顺序就是列序）
  // 「未指派 / 未归属」永远排最后，其余按名字排（按张数排会让顺序随卡片状态飘）
  return [...seen.values()].sort((a, b) => {
    if (!a.id !== !b.id) return a.id ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh');
  });
}

/** 三个维度各自勾了几个（角标上的数字；项目那一维只在全局面板算数） */
function kbFilterCount(scope) {
  const f = S.kbFilter ?? {};
  const statuses = f.statuses?.length ?? 0;
  const assignees = f.assignees?.length ?? 0;
  const projects = scope === 'all' ? (f.projects?.length ?? 0) : 0;
  return statuses + assignees + projects;
}

/** 现在有没有在筛（某一维一个都不勾 = 那一维不设限；三维全空 = 看全部） */
function kbFilterActive(scope) {
  return kbFilterCount(scope) > 0;
}

/**
 * 这张卡会被**哪一维**挡在筛外（没挡返回空串）。`kbMatch` 就是它的反面。
 *
 * 单开一条是为了界面上能说**人话**：建卡前的提醒要说清"是状态不对还是人不在这筛里"，
 * 只说"当前筛选看不到它"等于让人自己去猜。
 *
 * `scope`：项目看板整块板就是一个项目，行上也不都带 `project_id`（流程行/手工卡本来就没有）——
 * 所以那一维**只在全局面板生效**。不这么写的话，在全局面板按项目筛完再点进项目看板，
 * 会一张卡都不剩（行没有 project_id，跟"选了某个项目"永远不匹配）。
 */
function kbWhyHidden(card, scope) {
  const f = S.kbFilter ?? {};
  if (f.statuses?.length && !f.statuses.includes(card?.status)) return 'status';
  if (f.assignees?.length && !f.assignees.includes(card?.assignee_id ?? '')) return 'who';
  if (scope === 'all' && f.projects?.length && !f.projects.includes(card?.project_id ?? '')) return 'proj';
  return '';
}

/**
 * 这张卡过不过筛。**同一维里是"或"、不同维之间是"且"**（规则见上面那段总说明）。
 */
function kbMatch(card, scope) {
  return !kbWhyHidden(card, scope);
}

/** 弹层要列的状态：本板有的，加上"记着但本板没有"的那些（张数 0）。顺序跟着列走，**不按名字排** */
function kbFilterOptions(data) {
  const opts = kbStatusOptions(data).map((o) => ({ id: o.status, name: o.status, count: o.count }));
  return withGhosts(new Map(opts.map((o) => [o.id, o])), S.kbFilter?.statuses, () => '（本板没有）', false);
}

/**
 * 按筛选把看板列过一遍：列内卡片只剩匹配的，列头张数跟着卡片走（不然列头写 5、里面只站 2 张）。
 * **整列都不匹配就不显示那一列**（留着 6、7 个空列只是噪声）——
 * 但只在"这一筛真筛掉了东西"时才裁：全勾跟不勾是一回事（都是看全部），
 * 那时候再裁空列，6 列会塌成 1 列 —— 同一个意思两种形状（用户 2026-10-15 的审查提的）。
 */
function kbFilterCols(data) {
  const scope = data?.scope;
  const cols = (data?.columns ?? []).map((c) => {
    const cards = c.cards.filter((x) => kbMatch(x, scope));
    return { ...c, cards, count: cards.length };
  });
  // "真筛掉了东西"：有卡没通过 = 要裁空列。拿**卡**判而不是拿选项判 ——
  // 加了负责人/项目之后，选项里可能全是张数 0 的幽灵，按选项判会误以为筛掉了
  const narrows = kbFilterActive(scope) && kbRows(data).some((x) => !kbMatch(x, scope));
  return narrows ? cols.filter((c) => c.count) : cols;
}

/**
 * 看板工具栏上的「刷新 PR」（2026-10-17）。两块看板共用。
 *
 * 为什么需要这颗按钮：PR 在 GitHub 上被合并，**平台不会自己知道** —— 没人点，
 * 卡片上的「PR #n 开着」就一直开着，也永远不会转「待确认」。
 * 之前只有"点进某张卡的详情 → 刷新状态"这一条路，一次一张；卡一多就没人愿意点。
 *
 * 一张都没关联时按钮留着、禁用：**没有它，人根本不知道有这回事**（"为什么我的卡不动？"）。
 * title 里把话说清楚（"先在某张卡的详情里贴 PR 链接"），比藏起来好。
 */
function kbPrRefreshHtml(data) {
  const rows = data?.rows ?? (data?.columns ?? []).flatMap((c) => c.cards ?? []);
  const n = rows.filter((r) => r?.pr).length;
  return `<button type="button" data-kb-pr-refresh${n ? '' : ' disabled'} title="${
    n ? `${n} 张卡关联了 PR —— 重新查一遍它们的最新状态` : '还没有卡片关联 PR（先在某张卡的详情里贴 PR 链接）'
  }">刷新 PR${n ? `（${n}）` : ''}</button>`;
}

/**
 * 三个维度 = 一级菜单的三行。顺序就是弹层里的顺序（状态最常用，排头）。
 * `field` 是它在 `S.kbFilter` 里对应的那个数组 —— 两处别各写各的。
 */
const KB_DIMS = [
  { key: 'status', field: 'statuses', label: '状态' },
  { key: 'who', field: 'assignees', label: '负责人', search: true },
  { key: 'proj', field: 'projects', label: '项目', search: true },
];

/** 某一维的选项（二级菜单要铺的那些） */
function kbDimOptions(data, key) {
  if (key === 'status') return kbFilterOptions(data);
  if (key === 'who') return kbAssigneeOptions(data);
  return kbProjectOptions(data);
}

/**
 * 二级里按关键词过滤选项（只认名字，不区分大小写；空词 = 不过滤）。
 *
 * 只有负责人和项目带搜索（`KB_DIMS[].search`）：这两维的选项跟着人/项目长，
 * 名单一长滚着找很难受；状态就那几个词，加个搜索框反而要多点一下。
 */
function kbDimFilter(opts, q) {
  const k = String(q ?? '').trim().toLowerCase();
  if (!k) return opts;
  return opts.filter((o) => String(o.name ?? '').toLowerCase().includes(k));
}

/**
 * 二级选项那一堆行（`kbFilterBar` 与「搜索时只重画列表」共用）。
 * 已勾但被搜索滤掉的行**不画，但选择还在** —— 摘要和角标照旧算它，不会因为搜了一下就悄悄取消。
 */
function kbDimRowsHtml(data, dim) {
  const all = kbDimOptions(data, dim.key);
  const list = kbDimFilter(all, S.kbSearch);
  if (!list.length) {
    return `<div class="kbf-row dim">${
      all.length ? `没有匹配「${esc(String(S.kbSearch ?? '').trim())}」的${esc(dim.label)}` : '这一组没有可选项'
    }</div>`;
  }
  const has = (id) => (S.kbFilter?.[dim.field] ?? []).includes(id);
  return list
    .map(
      (o) => `<label class="kbf-row${o.count ? '' : ' zero'}${o.id ? '' : ' muted'}">
        <input type="checkbox" data-kbf-key="${esc(dim.key)}:${esc(o.id)}"${has(o.id) ? ' checked' : ''} />
        <span class="kbf-name">${esc(o.name)}</span>
        <span class="kbf-num">${o.count}</span>
      </label>`,
    )
    .join('');
}

/**
 * 一级菜单的数据：三个维度各一行，带「勾了几项」和已选名字的摘要。
 *
 * 为什么收成两级（用户 2026-10-18 提的，之前的做法是把三组平铺在一层里）：
 * 人和项目一多，单层弹层要滚很久才够得到「项目」那组；而且"我到底按什么在筛"
 * 得自己一行行找勾。分两级之后每行自己就把答案写在脸上（几项 + 选了谁），
 * 点进去才铺选项 —— 层高稳定，多加几维也不挤。
 */
function kbDimList(data) {
  const scope = data?.scope;
  return KB_DIMS.filter((d) => d.key !== 'proj' || scope === 'all').map((d) => {
    const opts = kbDimOptions(data, d.key);
    const chosen = S.kbFilter?.[d.field] ?? [];
    const names = chosen.map((id) => opts.find((o) => o.id === id)?.name ?? id);
    return {
      ...d,
      count: chosen.length,
      total: opts.length,
      // 名字最多摆两个，再多就「+N」：一行摆不下会折成两行，三个维度就不齐了
      summary: names.length > 2 ? `${names.slice(0, 2).join('、')} +${names.length - 2}` : names.join('、'),
    };
  });
}

/**
 * 看板的「筛选」那一块（按钮 + **两级**弹层）。两块看板共用。
 * 里面只有字符串拼接（不碰 DOM），所以也圈进这一段：能跟上面几条一起在 node 里验。
 *
 * 一级 = 维度（状态 / 负责人 / 项目），二级 = 那一维的选项多选。
 * 停在哪一级存在 `S.kbPane`（空串 = 一级），**不进 localStorage** ——
 * 下次点开筛选，人想的是"换一维看看"，不是回到上次那一维。
 *
 * 项目那一维**只在全局面板出现**：项目看板整块板就是一个项目，再按项目筛一遍是废话。
 */
function kbFilterBar(data) {
  const scope = data?.scope;
  const n = kbFilterCount(scope);
  const dims = kbDimList(data);
  const open = dims.find((d) => d.key === S.kbPane) ?? null; // 找不到就是记的那一维在这儿不存在（比如项目看板上的「项目」）

  const head = open
    ? `<div class="kbf-head">
        <button type="button" class="kbf-back" id="kbFilterBack" title="返回上一级（Esc）">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 6.5 9 12l5.5 5.5" /></svg>
        </button>
        <b>${esc(open.label)}</b>
        ${open.count ? '<button type="button" class="kbf-clear" id="kbFilterClearDim">清除本组</button>' : ''}
      </div>`
    : `<div class="kbf-head"><b>筛选</b>${n ? '<button type="button" class="kbf-clear" id="kbFilterClear">清除</button>' : ''}</div>`;

  // ── 二级：这一维的选项（多选，勾着不关层）。负责人 / 项目上面多一个搜索框 ──
  const search = open?.search
    ? `<div class="kbf-search">
        <input type="search" class="kbf-q" id="kbFilterSearch" autocomplete="off" spellcheck="false"
               placeholder="搜索${esc(open.label)}…" value="${esc(S.kbSearch ?? '')}" />
      </div>`
    : '';

  // ── 一级：维度清单（带勾选数与摘要，点一行进二级） ──
  const dimRows = dims.map(
    (d) => `<button type="button" class="kbf-dim${d.count ? ' on' : ''}" data-kbf-dim="${esc(d.key)}"${d.total ? '' : ' disabled'}>
      <span class="kbf-name">${esc(d.label)}</span>
      ${d.count ? `<span class="kbf-tag">${d.count}</span>` : ''}
      ${d.summary ? `<span class="kbf-dim-sum" title="${esc(d.summary)}">${esc(d.summary)}</span>` : ''}
      <svg class="kbf-arrow" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 6l6 6-6 6" /></svg>
    </button>`,
  );

  const body = open
    ? `${search}<div class="kbf-rows" id="kbFilterRows">${kbDimRowsHtml(data, open)}</div>
       <div class="kbf-foot">同一组里选多个 = 任选其一；不勾 = 这一组不设限</div>`
    : `${dims.every((d) => !d.total) ? '<div class="kbf-row dim">这个看板上还没有任务</div>' : dimRows.join('')}
       <div class="kbf-foot">点一行进去选；不同组之间 = 同时满足</div>`;

  return `<div class="kbf" id="kbFilter">
    <span class="kbf-info">${n ? `显示 ${kbFilterCols(data).reduce((a, c) => a + c.count, 0)} / 共 ${data?.total ?? 0}` : ''}</span>
    <button type="button" class="kbf-btn${n ? ' on' : ''}" id="kbFilterBtn" title="按状态 / 负责人 / 项目筛选">
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
        <path d="M4 6.5h16M7 12h10M10 17.5h4" />
      </svg>
      筛选${n ? `<b>${n}</b>` : ''}
    </button>
    <div class="kbf-pop" id="kbFilterPop" hidden>
      ${head}
      ${body}
    </div>
  </div>`;
}
/* kb-filter:pure:end */

/**
 * 看板列那一段（含"筛完什么都不剩"的兜底文案）。
 * 首屏渲染（两块看板）与 `kbRepaint()` 三条路**共用这一份** ——
 * 原来只有 kbRepaint 有兜底，筛到空时首屏会整块空白，同页点一下勾选框却是空的另一种样子。
 */
function kbColsHtml(data) {
  const cols = kbFilterCols(data);
  if (cols.length) return cols.map(kbColumn).join('');
  // 「还没任务」和「筛没了」是两件事：说错了人会以为看板坏了
  return `<div class="kb-none">${kbFilterActive(data?.scope) ? '没有符合筛选的任务' : '还没有任务'}</div>`;
}

/**
 * 二级里那些勾选框的接线（整块重画和「搜索时只换列表」两条路共用）。
 * `data-kbf-key` 形如 `status:待办` / `who:p-xxx` / `proj:prj-xxx`。
 */
function wireKbChecks(root) {
  root.querySelectorAll('input[data-kbf-key]').forEach((box) => {
    box.onchange = () => {
      const key = box.dataset.kbfKey ?? '';
      const at = key.indexOf(':');
      const dim = at < 0 ? key : key.slice(0, at);
      const id = at < 0 ? '' : key.slice(at + 1);
      const field = dim === 'status' ? 'statuses' : dim === 'who' ? 'assignees' : 'projects';
      const set = new Set(S.kbFilter[field] ?? []);
      box.checked ? set.add(id) : set.delete(id);
      S.kbFilter[field] = [...set];
      kbRepaint();
    };
  });
}

/**
 * 只换二级的选项列表（搜索时用）。
 *
 * 为什么不能走 `kbRepaint()`：那条路把整块工具栏重建，**输入框本身也被换掉** ——
 * 打一个字焦点和光标就没了，第二个字打不进去。所以搜索只重画 `#kbFilterRows`，
 * 输入框原地不动，焦点、光标、输入法都还在。
 */
function kbRepaintRows() {
  const el = $('kbFilterRows');
  const data = S.kbLast?.data;
  const dim = KB_DIMS.find((d) => d.key === S.kbPane);
  if (!el || !data || !dim) return;
  el.innerHTML = kbDimRowsHtml(data, dim);
  wireKbChecks(el);
}

/**
 * 筛选按钮 / 两级弹层的接线。
 * 变化后走 `kbRepaint()`：**原地重画列，不重抓数据、不关弹层** ——
 * 勾一个就整页重来一遍的话，多选根本没法连着点（弹层会被重画掉）。
 *
 * 两级导航也走同一条重画：一级点维度 → 二级，二级点返回 → 一级。
 * 状态放在 `S.kbPane` 里，所以重画之后还停在原来那一级。
 */
function wireKbFilter() {
  const btn = $('kbFilterBtn');
  const pop = $('kbFilterPop');
  if (!btn || !pop) return;
  btn.onclick = (e) => {
    e.stopPropagation(); // 别让下面那个"点别处就收起"的全局监听当场把它关掉
    if (pop.hidden) {
      // 每次点开都从一级开始、搜索词也清掉：层的 DOM 可能还停在二级（上次关的时候没收），
      // 先换回一级再露出来
      if (S.kbPane || S.kbSearch) {
        S.kbPane = '';
        S.kbSearch = '';
        kbRepaint();
      }
      $('kbFilterPop').hidden = false;
    } else {
      pop.hidden = true;
    }
  };
  // 一级 → 二级
  pop.querySelectorAll('[data-kbf-dim]').forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      S.kbPane = el.dataset.kbfDim ?? '';
      S.kbSearch = ''; // 换一维就是一份新名单，上一个词的过滤不该跟着过来
      kbRepaint();
      // 能搜的那两维直接把光标放进搜索框（进来就是为了找人/找项目）；
      // 状态没搜索框，焦点落「返回」上，键盘用户不会掉回页面顶上
      ($('kbFilterSearch') ?? $('kbFilterBack'))?.focus();
    };
  });
  // 二级 → 一级（回来时焦点落回刚离开的那一行）
  const back = $('kbFilterBack');
  if (back) {
    back.onclick = (e) => {
      e.stopPropagation();
      const from = S.kbPane;
      S.kbPane = '';
      S.kbSearch = '';
      kbRepaint();
      const el = $('kbFilter')?.querySelector(`[data-kbf-dim="${CSS.escape(from)}"]`);
      (el ?? $('kbFilterBtn'))?.focus();
    };
  }
  wireKbChecks(pop);
  // 搜索框：只重画列表，不动自己（见 kbRepaintRows）
  const q = $('kbFilterSearch');
  if (q) {
    q.oninput = () => {
      S.kbSearch = q.value;
      kbRepaintRows();
    };
    q.onkeydown = (e) => {
      // Esc 在搜索框里先清词，再按一下才退一级 —— 跟"清除"的直觉一致
      if (e.key === 'Escape' && S.kbSearch) {
        e.stopPropagation();
        q.value = '';
        S.kbSearch = '';
        kbRepaintRows();
      }
    };
  }
  // 「清除」= 三个维度一起清（分成三个清除按钮只会让人多点两下）
  $('kbFilterClear')?.addEventListener('click', (e) => {
    e.stopPropagation();
    S.kbFilter.statuses = [];
    S.kbFilter.assignees = [];
    S.kbFilter.projects = [];
    kbRepaint();
  });
  // 「清除本组」= 只清二级这一维（在二级里清完留在二级，方便接着改）
  $('kbFilterClearDim')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const field = KB_DIMS.find((d) => d.key === S.kbPane)?.field;
    if (field) S.kbFilter[field] = [];
    kbRepaint();
  });
}

/**
 * 筛选变了之后重画：只换「列」那一段（`#kbCols`）和筛选那一块（数字、勾选、清除按钮都在里面）。
 * 卡片是新画的，接线得重新绑一遍（`wireBoard` 只认交到它手上的那棵树）。
 * 弹层的开合状态要**跨过重画**留住 —— 否则点第二下就找不着那个层了；
 * 键盘勾选时焦点也得还给同一个勾选框（整块是重建的，不还的话空格只能勾一下）。
 */
function kbRepaint() {
  const st = S.kbLast;
  const colsEl = $('kbCols');
  if (!st?.data || !colsEl) return;
  const wasOpen = !$('kbFilterPop')?.hidden;
  // 焦点有四处落点：二级的勾选框、一级的维度行、二级的「返回」、二级的搜索框。
  // 整块重建之后要还回去，否则键盘勾一个就掉到页面上，空格只能勾一下（这条是 2026-10-15 就踩过的坑）
  const act = document.activeElement;
  const focusKey = act?.dataset?.kbfKey ?? null;
  const focusDim = act?.dataset?.kbfDim ?? null;
  const focusBack = act?.id === 'kbFilterBack';
  const focusQ = act?.id === 'kbFilterSearch';
  colsEl.innerHTML = kbColsHtml(st.data); // 首屏那两处用的是同一个兜底
  wireBoard(colsEl, st.wire);
  const bar = $('kbFilter');
  if (bar) bar.outerHTML = kbFilterBar(st.data); // 数字、勾选、清除按钮都在这一块里，整块重画最省事
  wireKbFilter();
  const pop = $('kbFilterPop');
  if (pop) pop.hidden = !wasOpen;
  if (focusKey && pop) pop.querySelector(`input[data-kbf-key="${CSS.escape(focusKey)}"]`)?.focus();
  else if (focusDim) $('kbFilter')?.querySelector(`[data-kbf-dim="${CSS.escape(focusDim)}"]`)?.focus();
  else if (focusBack) $('kbFilterBack')?.focus();
  else if (focusQ) {
    // 光标还回到末尾：搜索框重新建过，不设的话选区别扭（下一次输入把整个词顶掉）
    const q = $('kbFilterSearch');
    if (q) {
      q.focus();
      q.setSelectionRange?.(q.value.length, q.value.length);
    }
  }
  savePlace(); // 筛选也记进"上次停在哪"：F5 回来还是筛着的（见 savePlace 里的 kbStatuses）
}

/* 点别处就把筛选弹层收起来（点层内不关：多选得能连着点） */
document.addEventListener('click', (e) => {
  if (e.target?.closest?.('.kbf')) return;
  const pop = $('kbFilterPop');
  if (pop && !pop.hidden) pop.hidden = true;
});

/**
 * Esc = 逐级往后退（清搜索词 → 二级退一级 → 收起），跟点「返回」同一条路。
 * 只在弹层开着时接管；层没开就什么都不做，别抢别处对话框的 Esc。
 */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const pop = $('kbFilterPop');
  if (!pop || pop.hidden) return;
  e.stopPropagation();
  if (S.kbSearch) {
    // 搜索词先清（焦点在搜索框时这一下由输入框自己吃掉，走不到这儿）
    S.kbSearch = '';
    kbRepaintRows();
  } else if (S.kbPane) {
    S.kbPane = '';
    kbRepaint();
    $('kbFilterBtn')?.focus();
  } else {
    pop.hidden = true;
  }
});

/**
 * 看板页的接线 —— **项目看板与全局任务看板共用这一份**（2026-10-15）。
 *
 * 两页只有两处不同，都在参数里：
 *   · `refresh()`：干完一件事重画哪一页（项目看板重画这个项目，全局面板重画全局）；
 *   · `taskProject(colKey)`：列头「＋」建的卡挂在哪个项目 —— 项目看板直接给那个项目，
 *     全局面板没有"当前项目"，返回 null，弹窗里让人选一个。
 *
 * 接线内容：卡片点得进去（流程卡 → 实例；聊天/手工卡 → 会话）、手工卡拖到别的列 = 改状态、
 * × = 删卡、列头「＋」= 在那一列建卡。
 */
function wireBoard(view, { refresh, taskProject = () => null }) {
  view.querySelectorAll('[data-kb-flow]').forEach((el) => {
    el.onclick = () => {
      const tpl = el.dataset.kbTpl || null;
      openFlowRun(tpl, el.dataset.kbFlow).catch((e) => toast(e.message, 'error'));
    };
  });
  view.querySelectorAll('[data-kb-conv]').forEach((el) => {
    el.onclick = () => {
      // ⚠️ 必须先切视图：`openConversation()` 只往 #chatHead / #chat 里写，它不切视图。
      // 在看板上直接调它 = 内容写进了隐藏的聊天页，人看着就是"点了没反应"（踩过）。
      // setNav('messages') 里会 showView('chat')，跟其它几个入口的走法一致。
      setNav('messages');
      openConversation(el.dataset.kbConv).catch((e) => toast(e.message, 'error'));
    };
  });
  // 列头「＋」：在那一列新建任务（参照 Multica：建在哪一列就落在哪一列）
  view.querySelectorAll('[data-kb-add]').forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      taskDialog(taskProject(el.dataset.kbAdd), el.dataset.kbAdd);
    };
  });
  // 手工卡：拖到别的列 = 改状态；× = 删掉
  view.querySelectorAll('[data-kb-manual]').forEach((el) => {
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', el.dataset.kbManual);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
  });
  view.querySelectorAll('[data-kb-col]').forEach((colEl) => {
    colEl.addEventListener('dragover', (e) => {
      // 只让手工卡进来：流程/聊天的卡状态归平台管，拖它们没意义
      if (![...(e.dataTransfer?.types ?? [])].includes('text/plain')) return;
      e.preventDefault();
      colEl.classList.add('drop-hot');
    });
    colEl.addEventListener('dragleave', () => colEl.classList.remove('drop-hot'));
    colEl.addEventListener('drop', async (e) => {
      e.preventDefault();
      colEl.classList.remove('drop-hot');
      const taskId = e.dataTransfer.getData('text/plain');
      const card = view.querySelector(`[data-kb-manual="${CSS.escape(taskId)}"]`);
      if (!taskId || !card) return; // 拖的不是手工卡
      const toStatus = COL_STATUS[colEl.dataset.kbCol];
      if (!toStatus || card.dataset.col === colEl.dataset.kbCol) return;
      try {
        const res = await api(`/api/projects/tasks/${encodeURIComponent(taskId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: toStatus }),
        });
        // 拖进「进行中」＝开工（跟 Multica 一样：状态到位 + 有执行人就派活）。
        // 派没派出去要说一声：两种结果在看板上一模一样（卡都在「进行中」列），
        // 不吭声的话人会以为已经在跑了。
        const started = !!res?.started;
        // 拖完这张卡可能就不在当前筛选里了：看板一列混两个状态词
        //（「停下等人」= 已阻塞 · 已停止；「待办」列收流程的「待办」），拖进去落的是**这一列的默认状态**。
        // 不吭声的话卡片会"当场消失"，看着像拖丢了 —— 所以直说一句。
        // 只看**状态**那一维：这张卡原来是看得见的，说明负责人/项目两维它本来就过，
        // 而拖拽只改状态，别把别的维度也算一遍（算错了会误报）。
        const hidden = (S.kbFilter?.statuses?.length ?? 0) > 0 && !S.kbFilter.statuses.includes(toStatus);
        await refresh();
        if (started) {
          const who = (S.personas ?? []).find((p) => p.id === res.task?.assigneePersonaId)?.name;
          hint(`已经派给${who ? `「${who}」` : '执行人'}开跑了 —— 进展在他那条会话里看`);
        } else if (toStatus === '进行中') {
          hint('卡移到「进行中」了；这张卡没有执行人，所以不会自动开跑');
        }
        if (hidden) toast(`卡已经改成「${toStatus}」了，但当前筛选看不到它 —— 点右上角「清除」就能看见。`);
      } catch (err) {
        // 派不出去时服务端会原样说原因（"没开工：他还在跑上一条…"），状态不会被改掉
        toast(err.message, 'error');
        await refresh();
      }
    });
  });
  view.querySelectorAll('[data-kb-del]').forEach((el) => {
    el.onclick = async (e) => {
      e.stopPropagation();
      if (!(await confirmDo('删掉这张任务卡？'))) return;
      try {
        await api(`/api/projects/tasks/${encodeURIComponent(el.dataset.kbDel)}`, { method: 'DELETE' });
        await refresh();
      } catch (err) {
        toast(err.message, 'error');
      }
    };
  });
  /*
   * 本地卡（手工 / 仓库值班）：**点开卡片详情** —— 看全文、改标题描述、**改执行人**、自动开工、删掉。
   * 看板行是**截断过**的（标题 70 字、描述 90 字），仓库值班写进来的证据与命令根本看不全；
   * 而且建卡之后原来没有改执行人的入口（2026-10-17 用户问"怎么给这个任务指定人物"）。
   */
  view.querySelectorAll('[data-kb-open]').forEach((el) => {
    el.onclick = (e) => {
      if (e.target.closest('[data-kb-del]')) return; // × 自己处理，别把弹窗也带出来
      openTaskCardPage(el.dataset.kbOpen);
    };
    el.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openTaskCardPage(el.dataset.kbOpen);
      }
    };
  });
  /*
   * 「刷新 PR」：一次把所有关联了 PR 的卡查一遍（服务端 `POST /api/git/prs/refresh`）。
   * 服务端顺手跑 `afterMerged` —— 合并了的「进行中」会变成「待确认」，所以必须 **await refresh()** 重画，
   * 不能只把按钮改回来：卡片列变了人得当场看见。
   * 失败清单不整段吞掉：第一张的原因写出来（多半是令牌过期 / 令牌没那个仓库的权限），
   * 剩下的只报个数 —— 那种情况十有八九是同一个原因，刷十行同样的字只会把人埋了。
   */
  view.querySelector('[data-kb-pr-refresh]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '查询中…';
    try {
      // 项目看板只查本项目的（按钮上的 n 就是这个数）；全局面板 S.projectId 是空的 → 查全部
      const q = S.projectId ? `?projectId=${encodeURIComponent(S.projectId)}` : '';
      const r = await api(`/api/git/prs/refresh${q}`, { method: 'POST' });
      const bad = r.failed ?? [];
      await refresh();
      toast(`已查 ${r.updated ?? 0} 张 PR 的最新状态${bad.length ? `；${bad.length} 张没查到：${bad[0].error}` : ''}`);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = label;
      toast(err.message, 'error');
    }
  });
}

/**
 * **任务卡详情页**（2026-10-17）：看板点开一张本地卡（手工 / 仓库值班）进这里。
 *
 * 为什么做成"页"而不是弹窗：
 *   · 卡上写的是"这件事的来龙去脉"（仓库值班把结论、证据、链接全写进描述），弹窗那点地方不够；
 *   · 看完往往要**接着办** —— 办的过程就是跟执行人说句话，所以这一页要有**往来**。
 *
 * 聊天完全复用既有那套（不另造）：
 *   取消息 `GET /api/conversations/:id`（messages + runs）→ `bubble()` 画；
 *   发消息 `POST /api/conversations/:id/messages` → 拿 runId → `streamRun()` 接实时流；
 *   实时输出跟主聊天页一个写法：**一个气泡里追加分块**，收尾后从库里重画（别留半截）。
 * 「待办 + 已指定执行人」自动开工，跟建卡时那个「立即开始」同一条服务端链路（`startProjectTask`）。
 */
/**
 * 这张任务卡是从**哪个入口**点进来的（决定面包屑和「返回」去哪）：
 *   'all'     = 全局任务看板（工作台 → 任务看板）
 *   'project' = 某个项目的看板
 * 打开时从 S.boardAll 取一次就定下来 —— 之后 S.boardAll 会被清掉，不能再看它。
 */
let taskCardFromAll = false;

/**
 * 这张卡是**从流程的某一步**点进来的吗（2026-10-19）：`{ runId, taskId, runTitle, nodeName }`，否则 null。
 *
 * 跟上面那个 `taskCardFromAll` 不是一回事，两个都留着：
 *   · `taskCardFromAll` 决定**离开时回哪**（看板 / 项目 / 流程）；
 *   · 这个只决定**页头写不写那行来路**。
 * 合在一起会逼着做二选一 —— 从流程进来的卡，回程本来就该是流程，不冲突。
 */
let taskCardFromFlow = null;

async function openTaskCardPage(taskId, opts = {}) {
  // 来源定死：恢复位置时从 route 里带回来（刷新也还记得），否则看当前的 S.boardAll
  taskCardFromAll = opts.fromAll ?? !!S.boardAll; // 必须在 S.boardAll = false 之前读
  /*
   * 从流程那一步点进来的（2026-10-19）：记下"这条卡是哪条流程、哪个节点"。
   * 只为了在页头写一行来路 —— 人刚在流程页看着「写代码」这一步，点进来要还认得出是它。
   * 传 null 就是"不是从流程来的"（从看板点进来的），页头不写那行。
   * ⚠️ 路由里必须带上它：不带的话刷新一下页头那行就没了，看着像"进错页面"。
   */
  taskCardFromFlow = opts.fromFlow ?? null;
  setRoute('taskCard', { id: taskId, fromAll: taskCardFromAll, fromFlow: taskCardFromFlow });
  const view = $('pluginView');
  view.classList.add('kb-page'); // 这一页要满屏（见 style.css 的 #pluginView.kb-page）
  S.view = 'plugin';
  showView('plugin'); // 看板点进来时它已经 shown；刷新恢复/直达时它还 hide 着 —— 这里统一打开
  S.plugin = null;               // 任务卡不是插件，别让插件那条路抢走位置
  S.projectList = false;
  S.boardAll = false;
  savePlace();
  await paintTaskCardPage(taskId);
}

/** 弹窗里那张卡接着的实时流（关弹窗时要掐掉 —— 见 openTaskCardDialog） */
let tcDlgStream = null;

/** 关掉任务卡弹窗（同一时刻只该有一个；开新的之前先收掉旧的） */
function closeTaskCardDialog() {
  document.getElementById('tcDlg')?.close?.();
}

/**
 * 在**弹窗**里打开一张任务卡（2026-10-19）。
 *
 * 为什么不是整页跳转：人在流程时间轴上看着「写代码」这一步，点「任务」是想看/改这一步的
 * 细节 —— 整页换掉等于把他从那条流程里拽走，改完还得自己找回去（用户原话："操作体验不好"）。
 * 弹窗盖在时间轴上，关掉就还在刚才那一步，顺手把这一页重新拉一遍
 * （这一步刚建出来的卡要认上、经办人/会话跟着刷新）。
 *
 * 形态照定时任务那个两栏大弹窗（`.sch-dlg`）：定高、里面自己滚、右上角有全屏。
 * ⚠️ 不用 `<form>`：任务卡里那些按钮（关联 PR / 刷新 / 取消关联）没标 type，
 *    进 form 就成了提交按钮，一点就把弹窗关了（隐式提交这个坑在别处踩过一次）。
 */
async function openTaskCardDialog(taskId, opts = {}) {
  closeTaskCardDialog(); // 只留一个
  const dlg = document.createElement('dialog');
  dlg.id = 'tcDlg';
  dlg.className = 'tc-dlg';
  dlg.setAttribute('data-max', ''); // 讨论区一长，占满屏舒服（wireDialogHead 认这个属性）
  // 「删除」先放在这儿，建完头部再搬进去（头部是 wireDialogHead 现建的）
  dlg.innerHTML = `
    <div class="tc-dlg-wrap">
      <b>任务卡</b>
      <button type="button" class="tc-dlg-del" id="tcDlgDel" title="删掉这张卡（＝忽略它，以后不再提）">删除</button>
      <div id="tcDlgBody"></div>
    </div>`;
  document.body.append(dlg);
  wireDialogHead(dlg.querySelector('.tc-dlg-wrap'));
  const head = dlg.querySelector('.dlg-head');
  // 「删除」排到 × 左边（头部第一个 button 会被 CSS 推到右边，见 .dlg-head）
  head?.insertBefore($('tcDlgDel'), head.querySelector('.dlg-close:not(.dlg-max)') ?? null);
  // 标题带上节点名：不写的话，一张「测试2 · 写代码」摆在弹窗里，得自己回想是哪一步
  const titleEl = head?.querySelector('b');
  if (titleEl && opts.fromFlow?.nodeName) titleEl.textContent = `任务卡 · ${opts.fromFlow.nodeName}`;

  const cleanups = [];
  dlg.addEventListener('close', () => {
    for (const fn of cleanups) { try { fn(); } catch { /* 摘不掉也不影响 */ } }
    tcDlgStream?.close?.();
    tcDlgStream = null;
    dlg.remove();
    /*
     * 刷回流程时间轴（2026-10-19）。
     *
     * 为什么要刷、为什么"看起来没变化"是正常的：
     *   时间轴那一行显示的是 `workflow_tasks` 自己的状态（已阻塞 / 已完成…），
     *   而卡上那个「状态」是 `project_tasks` 的 —— **两份数据，同一个词的两种含义**
     *   （早先定过：流程那一套状态在 workflow_tasks，卡上不改它，两处各记各的）。
     *   所以改卡的状态不会让那一行变字；这里刷的是**别的**：这一步现在有没有卡
     *   （`projectTaskId` 是刚建出来的话要认上）、经办人、以及刚聊出来的会话。
     *   ⚠️ 别为了"看着有变化"去把卡状态反写进 workflow_tasks —— 那会让流程状态机
     *      跟着人改卡而乱走（卡上点「已完成」＝悄悄把流程那一步也办了）。
     *
     * 只在这条流程还开着的时候刷 —— 人已经切走就别抢他的页面。
     */
    const runId = opts.fromFlow?.runId;
    if (runId && S.view === 'flow' && S.flowRunId === runId) paintRun(runId).catch(() => {});
  });

  taskCardFromFlow = opts.fromFlow ?? null; // 删完卡之后 backTo 用得上
  dlg.showModal();
  await paintTaskCardPage(taskId, { dlg, cleanups });
  return dlg;
}

/**
 * 画一张任务卡。**画在哪**由 `opts.dlg` 决定（2026-10-19）：
 *   · 不传 —— 画进 `#pluginView`（整页，看板 / 项目点进来那条路）；
 *   · 传了 dialog —— 画进弹窗里（**流程的某一步**点进来那条路）。
 *
 * 为什么分两条路而不是统一成一种：从**列表**点进详情，换页是自然的（列表就在左栏，
 * 换页只是把主区占满）；从**流程时间轴**点「任务」是"看一眼这一步的细节"，
 * 整页换掉等于把他从那条流程里拽走 —— 那种该弹窗（见 openTaskCardDialog）。
 *
 * 两条路共用这一份内容与这一套接线（全部按 id 取元素，id 在同一时刻只存在于一处），
 * 差别只有：页头那行（弹窗用自己的头部）、「来自流程」那行（弹窗不写）、离开时去哪。
 */
async function paintTaskCardPage(taskId, opts = {}) {
  const dlg = opts.dlg ?? null;
  const host = dlg ? $('tcDlgBody') : $('pluginView');
  /*
   * 挂在 document 上的那两个"点别处收起"：
   *   · 整页走 `window.__pageCleanups`（换页时统一摘，见 setRoute）；
   *   · 弹窗没有换页这一说，走弹窗自己那一份 —— 关的时候摘。
   *     不分开的话，每开一次弹窗就往 document 上多叠一层监听。
   */
  const cleanups = opts.cleanups ?? (window.__pageCleanups ??= []);
  let task;
  try {
    task = (await api(`/api/projects/tasks/${encodeURIComponent(taskId)}`)).task;
  } catch (e) {
    // 整页那条路还带页头（左栏点别的就走了）；弹窗里就一句话 + 右上角的 ×
    host.innerHTML = `${dlg ? '' : headRow(breadcrumb([
      { label: '工作台', to: 'workbench' },
      { label: '任务看板', to: 'board' },
      { label: '任务卡' },
    ]))}
      <div class="empty" style="padding:24px 4px">任务取不到：${esc(e.message)}</div>`;
    return;
  }
  const proj = (S.projects ?? []).find((p) => p.id === task.projectId) ?? null;
  const isRepo = task.source === 'repo';
  const assignee = S.personas.find((p) => p.id === task.assigneePersonaId) ?? null;

  // 往来：派过活才有会话
  let conv = null;
  if (task.conversationId) {
    try { conv = await api(`/api/conversations/${encodeURIComponent(task.conversationId)}`); } catch { conv = null; }
  }
  const runningRun = (conv?.runs ?? []).find((r) => r.status === '跑中') ?? null;
  let whoName = conv?.conversation?.personaName ?? assignee?.name ?? '执行人';

  /**
   * 评论区（2026-10-18）：**一条顶层评论 = 一个议题**，回复挂在它下面。
   *
   * 归属规则（为什么这么定）：
   *   · 我发的、没有 parentId → 新开一个议题；
   *   · 我发的、带 parentId → 挂回那个议题（这样"过几天回到第一个议题补一句"不会跑到最新那条下面）；
   *   · 他的回话 → 服务端按触发消息补了 parentId（见 runs.mjs；顶层评论的回复挂到评论本身），
   *     直接挂；老数据没这个字段时退化成"挂当前议题"，会话本身是时序的，紧跟着的就是它。
   */
  const cmtTime = (s) => {
    const t = String(s ?? '').replace('T', ' ');
    return t.length >= 16 ? t.slice(5, 16) : t;
  };
  // 开工时那条派活说明（带着项目契约与任务正文）：不是人写的评论，收成一行可展开
  const isStartNote = (m) => m.role === 'user' && String(m.text ?? '').includes('【任务 · ');

  // 我自己的评论不再重复写名字 —— 头像上那个「我」就是名字，写两遍是噪声（他的回话仍然带名字）
  const cmtItem = (m) => {
    const mine = m.role === 'user';
    return `<div class="tc-cmt${mine ? ' mine' : ''}">
      ${mine ? smAvatar('我', 'me') : smAvatar(whoName, '', personaByName(whoName))}
      <div class="tc-cmt-main">
        <div class="tc-cmt-meta">${mine ? '' : `<b>${esc(whoName)}</b>`}<time>${esc(cmtTime(m.createdAt))}</time></div>
        <div class="tc-cmt-text">${renderMarkdown(m.text)}</div>
      </div>
    </div>`;
  };

  const topicsOf = (msgs) => {
    const topics = [];
    const byId = new Map();
    let cur = null;
    for (const m of msgs) {
      if (m.role === 'user' && !m.parentId) {
        cur = { id: m.id, head: m, items: [] };
        topics.push(cur);
        byId.set(m.id, cur);
      } else if (m.parentId && byId.has(m.parentId)) {
        // 我的回复、他的回话都认 parentId（他的回话现在也带着议题 id，见 runs.mjs）
        cur = byId.get(m.parentId);
        cur.items.push(m);
      } else {
        if (!cur) {
          cur = { id: 'pre-' + m.id, head: null, items: [] };
          topics.push(cur);
        }
        cur.items.push(m);
      }
    }
    return topics;
  };

  // 用户手动展开过的议题 id：重画（refreshThread 整块重建 innerHTML）后要还原，
  // 否则一轮 run 结束一重画，正在看的议题又被折回去，很烦。
  const openTopics = new Set();

  const threadsHtml = (d) => {
    const msgs = d?.messages ?? [];
    if (!msgs.length) {
      return `<div class="nc-empty">还没有评论。</div>`;
    }
    return topicsOf(msgs)
      .map((t) => {
        const startNote = t.head && isStartNote(t.head);
        const head = !t.head
          ? ''
          : startNote
            ? `<details class="tc-event"><summary>开工说明 · ${esc(cmtTime(t.head.createdAt))}</summary>
                 <div class="tc-cmt-text">${renderMarkdown(t.head.text)}</div>
               </details>`
            : `<div class="tc-topic-title">${renderMarkdown(t.head.text)}</div>`;
        // 「开工说明」不是人写的评论：不出头像、不出作者行，只留一条可展开的流水
        // 「只留言」的便签给一枚小标记：不然它和普通评论长得一模一样，看不出这条没叫醒他
        const noteTag = t.head?.note
          ? '<span class="tc-tag" title="便签：只给你看，没叫醒他">便签</span>'
          : '';
        const meta = t.head && !startNote
          ? `<div class="tc-topic-meta">
               ${t.head.role === 'user' ? '' : `<b>${esc(whoName)}</b>`}
               ${noteTag}
               <time>${esc(cmtTime(t.head.createdAt))}</time>
               <button type="button" class="tc-reply" data-reply="${esc(t.head.id)}">回复</button>
             </div>`
          : '';
        // 有回复就折叠：默认收起，点开关展开（十几条全铺开会很臃肿）。无回复保持空容器接 live 气泡。
        const replies = t.items.length
          ? `<details class="tc-replies" data-replies="${esc(t.id)}"${openTopics.has(t.id) ? ' open' : ''}>
               <summary class="tc-replies-toggle">${t.items.length} 条回复</summary>
               <div class="tc-replies-body">${t.items.map(cmtItem).join('')}</div>
             </details>`
          : `<div class="tc-replies" data-replies="${esc(t.id)}"></div>`;
        // 作者行在**正文上面**（跟普通评论一致）：头像旁边第一行就是"我 + 时间"，
        // 再往下才是内容 —— 反过来会让人以为下面又开了一条评论（2026-10-18 用户指出）
        return `<article class="tc-topic${t.head ? '' : ' pre'}" data-topic="${esc(t.id)}">
          ${t.head && !startNote ? (t.head.role === 'user' ? smAvatar('我', 'me') : smAvatar(whoName, '', personaByName(whoName))) : ''}
          <div class="tc-topic-body">
            ${meta}${head}
            ${replies}
          </div>
        </article>`;
      })
      .join('');
  };

  // 折叠开关：点击 summary 后 details.open 已被浏览器切换，这里同步记下"用户展开过哪些议题"，
  // 供下一次重画还原。用 click 委托（details 的 toggle 事件不冒泡，得靠 click）。
  $('tcThreads')?.addEventListener('click', (e) => {
    const d = e.target.closest?.('details.tc-replies');
    if (!d) return;
    const id = d.dataset.replies;
    if (d.open) openTopics.add(id); else openTopics.delete(id);
  });

  /**
   * 页面形态照 Multica 的任务详情（2026-10-18 用户要求"简洁一些"）：
   *   · 主区从上到下就是这件事本身：大标题 → 描述 → 讨论，别的一概不摆；
   *   · 属性全收进右栏三段：属性（状态/执行人/项目/来源）、Pull Request、详情（创建/更新时间）；
   *   · 页头只有「任务卡 + 删除」（原来的三级面包屑 `工作台 › 任务看板 › 任务卡`
   *     统一去掉返回后一并撤了；回看板靠左栏点那一行 —— 左栏本来就是看板那一列）。
   */
  /*
   * 页头：**从流程进来的，标题下面补一行来路**（2026-10-19）。
   * 人刚才在流程时间轴上看着「写代码」这一步，点进来要还认得出是它 ——
   * 不然一张「测试2-不指定 · 写代码」的卡摆在眼前，得自己回想"这是哪条流程第几步"。
   * 那行**可以点**：直接回那条流程（跟删完卡之后回的是同一个地方）。
   * 从看板进来的没有这一行 —— 来源本来就在左栏上写着，再写一遍是噪音。
   */
  /*
   * 弹窗里**不写**那行来路：流程时间轴就在弹窗背后露着，弹窗自己的标题也已经写了
   * 「任务卡 · 节点名」——再把"你从哪来"写一遍是噪音。整页那条路照旧要写（那边没有上下文）。
   */
  const fromFlowBar = !dlg && taskCardFromFlow?.runId
    ? `<button type="button" class="tc-from" id="tcFromFlow"
         title="回到这条流程的时间轴">
         <span class="tc-from-k">来自流程</span>
         <b>${esc(taskCardFromFlow.runTitle ?? '')}</b>
         ${taskCardFromFlow.nodeName ? `<span class="tc-from-sep">›</span> <span>${esc(taskCardFromFlow.nodeName)}</span>` : ''}
       </button>`
    : '';
  host.innerHTML = `
    ${dlg ? '' : headRow(
      taskCardFromAll || !proj
        ? breadcrumb([{ label: '工作台', to: 'workbench' }, { label: '任务看板', to: 'board' }, { label: '任务卡' }])
        : breadcrumb([
            { label: '工作台', to: 'workbench' },
            { label: '项目', to: 'projects' },
            { label: proj.name, to: 'projects', arg: proj.id },
            { label: '任务卡' },
          ]),
      '<button class="tc-del" id="tcDel" title="删掉这张卡（＝忽略它）">删除</button>',
    )}
    <div class="detail-body tc-page${dlg ? ' in-dlg' : ''}">
      <div class="tc-main">
        <div class="tc-main-scroll">
          <div class="tc-headblock">
            ${fromFlowBar}
            <h1 class="tc-title" id="tcTitleText" contenteditable="plaintext-only" spellcheck="false">${esc(task.title)}</h1>
            <div class="tc-desc${task.description ? '' : ' empty'}" id="tcDescView">${task.description ? renderMarkdown(task.description) : '<span class="dim">添加描述…</span>'}</div>
          </div>

          <section class="group tc-comments">
            <div class="group-title">讨论</div>
            <div class="tc-threads" id="tcThreads">${threadsHtml(conv)}</div>
          </section>
        </div>

        <div class="tc-composer">
          <div class="tc-reply-pick">
            <button type="button" class="tc-reply-pick-btn" id="tcReplyPick" title="选择要回复哪条议题（不用滚上去点）">回复到：新议题 ▾</button>
            <div class="tc-reply-pick-menu" id="tcReplyPickMenu" hidden></div>
          </div>
          <div class="tc-input-box">
            <textarea id="tcInput" rows="3" placeholder="留下评论…（回车换行）"></textarea>
            <div class="tc-sendbar">
              <div class="tc-mode-wrap">
                <button type="button" class="tc-mode" id="tcMode" data-mode="discuss"
                        title="这条发出去之后他要怎么处理">
                  <span class="tc-mode-dot"></span><span id="tcModeLabel">讨论</span><span class="tc-caret">▾</span>
                </button>
                <div class="tc-mode-menu" id="tcModeMenu" hidden>
                  <button type="button" data-pick="note">
                    <b>便签</b><span>只记在卡上给你看，不叫醒他</span>
                  </button>
                  <button type="button" data-pick="discuss">
                    <b>讨论</b><span>叫醒他聊、看代码、给方案，不动手改文件</span>
                  </button>
                  <button type="button" data-pick="execute">
                    <b>执行</b><span>叫醒他基于讨论真正干活</span>
                  </button>
                </div>
              </div>
              <button class="primary tc-send" id="tcSend" type="button" title="发送">发送</button>
            </div>
          </div>
          <div class="tc-composer-foot">
            <button type="button" class="tc-stop" id="tcStop" hidden
                    title="掐掉这一轮（他已经说出来的话会留着；会话和上下文都还在，随时可以接着说）">■ 停止生成</button>
            <div class="counter left" id="tcHint2"></div>
          </div>
        </div>
      </div>

      <aside class="tc-side">
        <h3>属性</h3>
        <div class="tc-prop"><span class="tc-prop-k">状态</span><div id="tcStatusMount"></div></div>
        <div class="tc-prop"><span class="tc-prop-k">执行人</span><div id="tcWhoMount"></div></div>
        <div class="tc-prop"><span class="tc-prop-k">项目</span><span class="tc-prop-v">${esc(proj?.name ?? '（项目已不在）')}</span></div>
        <div class="tc-prop"><span class="tc-prop-k">来源</span><span class="tc-prop-v">${isRepo ? '仓库值班' : '手动建卡'}</span></div>

        <h3>Pull Request</h3>
        ${
          task.prRepo && task.prNumber
            ? `<div class="tc-prop"><span class="tc-prop-k">关联的 PR</span><div class="tc-prop-v">
                 <a href="https://github.com/${esc(task.prRepo)}/pull/${task.prNumber}" target="_blank" rel="noreferrer"
                    style="color:var(--accent)">${esc(task.prRepo)}#${task.prNumber}</a>
                 <span class="pill">${
                   task.prState === 'merged' ? '已合并' : task.prState === 'closed' ? '已关闭' : task.prState === 'open' ? '开着' : '状态未知'
                 }</span>
                 ${task.prTitle ? `<div class="dim" style="font-size:12px;margin-top:4px">${esc(task.prTitle)}</div>` : ''}
                 ${task.prCheckedAt ? `<div class="dim" style="font-size:11.5px;margin-top:2px">上次查：${esc(String(task.prCheckedAt).replace('T', ' ').slice(0, 16))}</div>` : ''}
               </div></div>
               <div class="dlg-actions">
                 <button id="tcPrRefresh">刷新状态</button>
                 <button id="tcPrUnlink">取消关联</button>
               </div>`
            : `<div class="tc-pr-add">
                 <input id="tcPrUrl" placeholder="PR 链接 或 owner/name#123" />
                 <button class="primary" id="tcPrLink">关联</button>
               </div>
               <div class="counter left">合并后这张卡会转到「待确认」——不自动「已完成」，等你点头。</div>`
        }

        <h3>详情</h3>
        <div class="tc-prop"><span class="tc-prop-k">创建时间</span><span class="tc-prop-v">${esc(String(task.createdAt ?? '').replace('T', ' ').slice(0, 16))}</span></div>
        <div class="tc-prop"><span class="tc-prop-k">更新时间</span><span class="tc-prop-v" id="tcAt">${esc(String(task.updatedAt ?? '').replace('T', ' ').slice(0, 16))}</span></div>
      </aside>
    </div>`;

  /*
   * 从哪来回哪去：**从流程那一步进来的就回那条流程**（2026-10-19）。
   * 这是这轮改造的重点之一 —— 人是在流程时间轴上点「任务」过来的，
   * 删完卡 / 干完事却落回看板，等于把他从上下文里拽走了，还得自己找回去。
   * 其余照旧：全局看板 → 全局看板，项目看板 → 那个项目。
   */
  const backTo = dlg
    ? () => { dlg.close('done'); } // 弹窗这条路：**关掉就是回去**（流程页一直在底下，没走过）
    : taskCardFromFlow?.runId
      ? () => openFlowRun(taskCardFromFlow.templateId ?? null, taskCardFromFlow.runId)
      : taskCardFromAll
        ? () => openTaskBoard()
        : proj ? () => openProjectDetail(proj.id) : () => openProjectsPage();
  // 离开这张卡就把位置记忆清掉：否则下一次刷新又会被拽回这张卡
  const leaveTo = async () => { await backTo(); };
  // （页头不再有返回按钮；backTo 只剩 leaveTo 和下面那行「来自流程」在用）

  // 「来自流程」那行：点一下回那条流程的时间轴（跟删完卡之后回的是同一个地方）
  $('tcFromFlow')?.addEventListener('click', () => { backTo().catch((e) => toast(e.message, 'error')); });

  /* ---------------- 标题 / 描述：就地编辑（2026-10-18 用户要求：没有编辑按钮，点了就改，改完自动存）
     做法跟 Multica 一致：标题、描述平时就是"读"的样子，点上去原地变成输入框；
     敲字防抖自动存，失焦立刻存；Enter 提交，Escape 放弃本次改动。 ---------------- */
  let titleVal = task.title;
  let descVal = task.description || '';

  /* 标题：h1 本身就可写（contenteditable）。**不换元素、不加边框** ——
     换 input 会改字号/行高/盒模型，页面会抖一下（2026-10-18 用户实报）。 */
  const titleEl = $('tcTitleText');
  titleEl.addEventListener('input', () => { titleVal = titleEl.textContent; scheduleSave(700); });
  titleEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); } // 单行标题：回车＝改完
    if (e.key === 'Escape') { titleVal = task.title; titleEl.textContent = task.title; titleEl.blur(); }
  });
  titleEl.addEventListener('blur', () => {
    titleVal = (titleEl.textContent || '').trim();
    if (!titleVal) titleVal = task.title;   // 空标题不收，退回原值
    titleEl.textContent = titleVal;
    scheduleSave(0);                        // 失焦立刻存
  });

  /* 描述：平时是渲染好的 Markdown；点上去就地变成**原文编辑器**（同一块地方、无边框），
     失焦存回原文并重新渲染。这样链接/加粗照旧能看，也不会把 Markdown 弄丢。 */
  const descHost = $('tcDescView');
  const renderDesc = () => {
    descHost.classList.remove('editing');
    descHost.removeAttribute('contenteditable');
    descHost.classList.toggle('empty', !descVal);
    descHost.innerHTML = descVal ? renderMarkdown(descVal) : '<span class="dim">添加描述…</span>';
  };
  const startDescEdit = () => {
    if (descHost.classList.contains('editing')) return;
    descHost.classList.add('editing');
    descHost.setAttribute('contenteditable', 'plaintext-only'); // 不给边框，只给可写
    descHost.textContent = descVal; // 编辑时给的是 Markdown 原文
    descHost.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(descHost);
    range.collapse(false);           // 光标落末尾：接着往下写
    sel.removeAllRanges();
    sel.addRange(range);
  };
  descHost.addEventListener('click', (e) => {
    if (e.target.closest('a') || descHost.classList.contains('editing')) return; // 点链接照旧跳
    startDescEdit();
  });
  descHost.addEventListener('input', () => { descVal = descHost.innerText; scheduleSave(800); });
  descHost.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { descVal = task.description || ''; descHost.blur(); }
  });
  descHost.addEventListener('blur', () => {
    descVal = (descHost.innerText || '').replace(/\u00a0/g, ' ').trim();
    renderDesc();
    scheduleSave(0);
  });

  /* ---------------- 自动保存（2026-10-18 用户要求：没有「保存」「开始工作」） ---------------- */
  const saveStateEl = $('tcSaveState');
  const setSaveState = (text, kind = '') => {
    if (!saveStateEl) return;
    saveStateEl.textContent = text;
    saveStateEl.className = 'save-state' + (kind ? ' ' + kind : '');
  };
  let saveTimer = null;
  let saveNow = null;      // combos 建好后赋值（它要读状态 / 执行人）
  let saveQueued = false;
  const scheduleSave = (ms = 700) => {
    setSaveState('未保存…', 'wait');
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; saveNow?.(); }, ms);
  };

  /**
   * 评论输入区的状态。**输入框始终可写**（原来没指定执行人就 disabled，人以为是页面坏了），
   * 只在发送时要求先选人 —— 选完立刻就能发，不用先点「保存」。
   */
  const syncComposer = () => {
    const hint2 = $('tcHint2');
    if (!hint2) return;
    // 选完人就把常驻提示撤掉（那句"发送＝叫醒他讨论…"是废话，2026-10-19 用户要去掉）；
    // 只有还没选执行人时才留一句必要的引导。
    hint2.textContent = whoCombo.value() ? '' : '先在右边选执行人，再发送。';
  };

  const statusCombo = createCombo({
    mount: $('tcStatusMount'),
    items: ['想法', '待办', '进行中', '待确认', '已阻塞', '已完成'].map((s) => ({ id: s, label: s })),
    value: task.status,
    onChange: () => scheduleSave(0), // 改状态立刻存：待办+人 = 开工（服务端负责）
  });
  const whoCombo = createCombo({
    mount: $('tcWhoMount'),
    items: [{ id: '', label: '（不指定）' }, ...(S.personas ?? []).map((p) => ({ id: p.id, label: personLabel(p) }))],
    value: task.assigneePersonaId || '',
    search: true,
    placeholder: '搜名字或岗位…',
    empty: '没有匹配的人',
    onChange: (id) => {
      // 选人**立刻**反映到评论区与页头（原来要点了「保存」重画才生效，看着就像"输入框点不动"）
      const p = (S.personas ?? []).find((x) => x.id === id) ?? null;
      if (p) whoName = p.name;
      const whoText = $('tcWhoText');
      if (whoText) whoText.textContent = p?.name ?? '（没派活）';
      syncComposer();
      scheduleSave(0); // 指定人立刻存：卡在「待办」时这一下就会自动开工
    },
  });
  syncComposer();

  const snapshot = () => ({
    title: titleVal,
    description: descVal,
    status: statusCombo.value(),
    personaId: whoCombo.value(),
  });
  let lastSaved = JSON.stringify(snapshot());
  let saving = false;

  /** 存完只更新页头/描述，不重画整页（免得丢正在写的评论）。
   *  状态/执行人的实时展示在右栏 combo 上（页头不再摆 pill，照 Multica 收进属性栏）。 */
  const refreshHeader = () => {
    if (document.activeElement !== titleEl) {
      titleVal = task.title;
      titleEl.textContent = task.title;
    }
    const p = (S.personas ?? []).find((x) => x.id === task.assigneePersonaId) ?? null;
    if (p) whoName = p.name;
    statusCombo?.setValue(task.status);
    whoCombo?.setValue(task.assigneePersonaId || '');
    if (document.activeElement !== descHost) {
      descVal = task.description || '';
      renderDesc();
    }
    const at = $('tcAt');
    if (at && task.updatedAt) at.textContent = String(task.updatedAt).replace('T', ' ').slice(0, 16);
  };

  /**
   * 自动开工之后要重画：状态变「进行中」、往来区这时才有会话。
   * 重画会把正在写的评论清掉，所以先把草稿和"回复哪个议题"记下来，画完放回去。
   */
  const repaintKeepingDraft = async () => {
    const draft = $('tcInput')?.value ?? '';
    const topicId = replyTo;
    await paintTaskCardPage(taskId, opts);
    if (draft) {
      const el = $('tcInput');
      if (el) el.value = draft;
    }
    if (topicId) $('tcThreads')?.querySelector(`[data-reply="${CSS.escape(topicId)}"]`)?.click();
  };

  saveNow = async ({ keepalive = false } = {}) => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    const payload = snapshot();
    if (!payload.title.trim()) { setSaveState('标题不能空 · 未保存', 'bad'); return false; }
    const json = JSON.stringify(payload);
    if (json === lastSaved) { setSaveState('已保存', 'ok'); return true; }
    if (saving) { saveQueued = true; return false; }
    saving = true;
    setSaveState('保存中…', 'wait');
    try {
      const res = await api(`/api/projects/tasks/${encodeURIComponent(taskId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: json,
        ...(keepalive ? { keepalive: true } : {}),
      });
      lastSaved = json;
      if (res.task) { task = res.task; refreshHeader(); }
      setSaveState('已保存', 'ok');
      // 真的派活了（待办+人 / 状态改成进行中）→ 重画，把「进行中」和往来区摆出来
      if (res.started) {
        toast('已自动开工：派给他跑这一条去了');
        await repaintKeepingDraft();
      }
      return true;
    } catch (err) {
      // `err.message` 自带「码：原因」（4xx 是服务端原文，5xx 是「服务异常」）。
      // 不能再用 `err.detail || err.message` —— 那会在 5xx 时把内部原文顶到界面上。
      const why = String(err?.message || '服务异常').split('\n')[0];
      setSaveState('没开工：' + why, 'bad');
      // 状态可能已经改成「待办」但没派出去（忙/运行时不可用）：重取一次，让界面说实话
      try {
        const d = await api(`/api/projects/tasks/${encodeURIComponent(taskId)}`);
        if (d.task) { task = d.task; refreshHeader(); }
      } catch { /* 取不到就算了 */ }
      toast(`没存上/没开工：${why}`);
      return false;
    } finally {
      saving = false;
      if (saveQueued) { saveQueued = false; saveNow?.(); }
    }
  };

  /*
   * 关弹窗 / 换页之前，**先把没落库的改动存掉**（2026-10-19）。
   * 原来的排版是"敲完字马上失焦（弹窗里就关掉）"，靠 blur 触发存；现在改完状态可能
   * 直接按 Esc —— 不补这一下，那一下改动就没了，人还以为存上了。
   * 放在这里（PR 那几块上面）：下面所有交互都可能在存完之前关窗。
   */
  cleanups.push(() => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (JSON.stringify(snapshot()) !== lastSaved) saveNow?.({ keepalive: true });
  });

  // 弹窗那条路的「删除」在弹窗自己头上（静态的 #tcDlgDel），整页那条路在页头
  const delEl = dlg ? $('tcDlgDel') : $('tcDel');
  if (delEl) {
    delEl.onclick = async () => {
      if (!(await confirmDo('删掉这张任务卡？（＝忽略它，以后不再提）'))) return;
      try {
        await api(`/api/projects/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
        await leaveTo();
      } catch (e) { toast(e.message, 'error'); }
    };
  }

  /* ---------------- PR 联动（卡片 ↔ GitHub PR） ---------------- */
  const prStateText = (state) => (state === 'merged' ? '已合并' : state === 'closed' ? '已关闭' : state === 'open' ? '开着' : '未知');

  $('tcPrLink')?.addEventListener('click', async (e) => {
    e.preventDefault();
    const url = $('tcPrUrl').value.trim();
    if (!url) return toast('先贴 PR 链接（或 owner/name#123）');
    const btn = $('tcPrLink');
    btn.disabled = true;
    btn.textContent = '查询中…';
    try {
      const r = await api(`/api/projects/tasks/${encodeURIComponent(taskId)}/pr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      await paintTaskCardPage(taskId, opts);
      toast(`已关联：${r.pr.repo}#${r.pr.number} —— ${prStateText(r.pr.state)}`);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = '关联';
      toast(err.message, 'error');
    }
  });
  $('tcPrRefresh')?.addEventListener('click', async (e) => {
    e.preventDefault();
    const btn = $('tcPrRefresh');
    btn.disabled = true;
    btn.textContent = '查询中…';
    try {
      const r = await api(`/api/projects/tasks/${encodeURIComponent(taskId)}/pr/refresh`, { method: 'POST' });
      await paintTaskCardPage(taskId, opts);
      toast(`PR 现在：${prStateText(r.pr.state)}${r.task?.status === '待确认' ? '（卡已转到「待确认」）' : ''}`);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = '刷新状态';
      toast(err.message, 'error');
    }
  });
  $('tcPrUnlink')?.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!(await confirmDo('取消这张卡和 PR 的关联？（不会动 GitHub 上的 PR）'))) return;
    try {
      await api(`/api/projects/tasks/${encodeURIComponent(taskId)}/pr`, { method: 'DELETE' });
      await paintTaskCardPage(taskId, opts);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  /* ---------------- 评论区：发评论 / 回复 / 实时流 ---------------- */

  let convId = task.conversationId ?? null;
  let stream = null;
  let replyTo = null; // 正在回复哪个议题（null = 新开一条）

  /**
   * 这条发出去之后他要怎么处理（2026-10-19 用户定，三档）：
   *   · note    便签 —— 只记在卡上给你看，不叫醒他、agent 不读；
   *   · discuss 讨论 —— 叫醒他聊、看代码、给方案，但只读不动手（服务端沙箱盖成 plan）；
   *   · execute 执行 —— 叫醒他基于讨论真正干活，用员工默认沙箱。
   * 默认「讨论」：用户的痛点是"需求没聊清就动手"，先聊才符合直觉。
   */
  let sendMode = 'discuss';
  const MODE_TIP = {
    note: '便签：只记在卡上给你看，不叫醒他',
    discuss: '讨论：叫醒他聊、看代码、给方案，不动手改文件',
    execute: '执行：叫醒他基于讨论真正干活',
  };
  const MODE_LABEL = { note: '便签', discuss: '讨论', execute: '执行' };
  const placeholderFor = (mode) =>
    mode === 'note' ? '留个便签…（不会叫醒他）'
    : mode === 'discuss' ? '跟他讨论…（只聊不动手）'
    : '让他干活…（回车换行）';
  // 输入框提示语：选了回复目标就说"回复这个议题…"，否则按三档说
  const placeholderText = () => (!replyTo ? placeholderFor(sendMode)
    : sendMode === 'note' ? '回复这个议题…（便签）'
    : sendMode === 'discuss' ? '回复这个议题…（只聊不动手）'
    : '回复这个议题…（回车换行）');

  const paintMode = () => {
    const btn = $('tcMode');
    const label = $('tcModeLabel');
    if (btn) {
      btn.dataset.mode = sendMode;
      btn.title = MODE_TIP[sendMode];
    }
    if (label) label.textContent = MODE_LABEL[sendMode];
    const input = $('tcInput');
    if (input) input.placeholder = placeholderText();
    const menu = $('tcModeMenu');
    if (menu) {
      menu.querySelectorAll('[data-pick]').forEach((b) => {
        b.classList.toggle('on', b.dataset.pick === sendMode);
      });
    }
  };
  const closeModeMenu = () => { const m = $('tcModeMenu'); if (m) m.hidden = true; };
  $('tcMode')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const m = $('tcModeMenu');
    if (m) m.hidden = !m.hidden;
  });
  $('tcModeMenu')?.querySelectorAll('[data-pick]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      sendMode = ['note', 'discuss', 'execute'].includes(b.dataset.pick) ? b.dataset.pick : 'discuss';
      closeModeMenu();
      paintMode();
      $('tcInput')?.focus();
    });
  });
  // 点别处收起（只挂这一次；tcModeMenu 是随页面重建的，用冒泡判断当前节点）
  const onDocClick = (e) => { if (!e.target.closest?.('.tc-mode-wrap')) closeModeMenu(); };
  document.addEventListener('click', onDocClick);
  paintMode();

  /**
   * 「回复到」选择器（2026-10-19）：评论区一长，想回复某条旧议题就得滚上去点它的「回复」，
   * 很别扭。所以把"回给谁"搬到输入框上方：点开下拉直接选，不用滚动。
   */
  const topicTitleOf = (id) => {
    const m = (conv?.messages ?? []).find((x) => x.id === id);
    return String(m?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 28);
  };
  const paintReplyPick = () => {
    const btn = $('tcReplyPick');
    if (!btn) return;
    const t = replyTo ? topicTitleOf(replyTo) : '';
    btn.textContent = replyTo ? `回复：${t || '这个议题'} ▾` : '回复到：新议题 ▾';
    btn.classList.toggle('on', !!replyTo);
  };
  const closeReplyMenu = () => { const m = $('tcReplyPickMenu'); if (m) m.hidden = true; };
  const openReplyMenu = () => {
    const menu = $('tcReplyPickMenu');
    if (!menu) return;
    const topics = topicsOf(conv?.messages ?? []).filter((t) => t.head);
    const items = [{ id: '', title: '新议题（不挂在别的评论下）' }]
      .concat(topics.map((t) => ({ id: t.head.id, title: `${cmtTime(t.head.createdAt)} · ${topicTitleOf(t.head.id).slice(0, 22) || '（空评论）'}` })));
    menu.innerHTML = items
      .map((x) => `<button type="button" data-pick-reply="${esc(x.id)}"${x.id === (replyTo ?? '') ? ' class="on"' : ''}>${esc(x.title)}</button>`)
      .join('');
    menu.querySelectorAll('[data-pick-reply]').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        replyTo = b.dataset.pickReply || null;
        closeReplyMenu();
        paintReplyPick();
        setReplyPlaceholder();
        $('tcInput')?.focus();
      };
    });
    menu.hidden = false;
  };
  const setReplyPlaceholder = () => {
    const input = $('tcInput');
    if (input) input.placeholder = placeholderText();
  };
  $('tcReplyPick')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const m = $('tcReplyPickMenu');
    if (m?.hidden === false) { closeReplyMenu(); return; }
    openReplyMenu();
  });
  // 点别处收起（页面级监听，换页时要摘，走 __pageCleanups）
  const onReplyPickOutside = (e) => {
    if (!e.target.closest?.('.tc-reply-pick')) closeReplyMenu();
  };
  document.addEventListener('click', onReplyPickOutside);
  cleanups.push(() => {
    document.removeEventListener('click', onReplyPickOutside);
  });

  const scrollThreads = () => {
    const box = $('tcThreads');
    if (box) box.scrollTop = box.scrollHeight;
  };

  const wireReplyButtons = () => {
    $('tcThreads')?.querySelectorAll('[data-reply]').forEach((btn) => {
      btn.onclick = () => {
        replyTo = btn.dataset.reply;
        paintReplyPick();
        setReplyPlaceholder();
        $('tcInput')?.focus();
      };
    });
  };

  const clearReply = () => {
    replyTo = null;
    paintReplyPick();
    setReplyPlaceholder();
  };
  paintReplyPick();
  wireReplyButtons(); // 首屏那批「回复」按钮也要接上 —— 漏了这行，点了没反应（2026-10-18 实测踩过）

  const refreshThread = async () => {
    if (!convId) return;
    try {
      const d = await api(`/api/conversations/${encodeURIComponent(convId)}`);
      conv = d;
      const box = $('tcThreads');
      if (!box) return;
      box.innerHTML = threadsHtml(d);
      wireReplyButtons();
    } catch { /* 拉不到就保持原样，别把页面弄炸 */ }
  };

  /**
   * 这一轮运行（停止按钮要用它的 id —— 光知道"忙不忙"是停不掉的，跟主聊天页的 chatRunningId 一个道理）。
   *
   * ⚠️ 是"停止"，不是"暂停"：底层 runtime 都是一次性子进程，没有暂停/续跑这回事。
   *    停掉的是**这一轮**，不是这个人 —— 会话、上下文、卡片都还在，再说一句就能接着办。
   */
  let liveRunId = null;
  const syncStop = () => {
    const btn = $('tcStop');
    if (btn) btn.hidden = !liveRunId;
    const hint = $('tcHint2');
    if (hint && liveRunId) hint.textContent = '随时可以掐掉这一轮 —— 说过的话留着。';
  };
  const abortRun = async () => {
    const rid = liveRunId;
    if (!rid) return;
    // 先让界面立刻停下（点完就见效，不等后端回调）—— 跟主聊天页 stopChatRun 一个做法
    liveRunId = null;
    syncStop();
    if ($('tcHint2')) $('tcHint2').textContent = '已停下（他说过的话留着）。';
    stream?.close?.();
    stream = null;
    try {
      await api(`/api/runs/${encodeURIComponent(rid)}/abort`, { method: 'POST' });
    } catch (e) {
      toast(e.message, 'error');
    }
    await refreshThread();
    // 收尾后卡片状态会落到「停下等人」那一档 —— 右栏和页头跟着刷一次
    api(`/api/projects/tasks/${encodeURIComponent(taskId)}`)
      .then((d) => { if (d?.task) { task = d.task; refreshHeader(); } })
      .catch(() => { /* 取不到就等下次刷新 */ });
  };
  if ($('tcStop')) $('tcStop').onclick = abortRun;

  /**
   * 接实时流：**一个气泡里追加分块**（跟主聊天页 `attachStream` 一个写法），
   * 收尾后从库里重画 —— 流式气泡是临时的，库里那份才是完整的。
   * 落点：正在回复的那个议题的回复区里；不知道是哪个议题（比如改状态开的工、或刷新后接上）就落在
   * **最后一条议题**下面 —— 绝不能落到列表末尾，那样看着像他另开了一条新评论（2026-10-18 用户指出）。
   */
  const attach = (runId, topicId = replyTo) => {
    if (!runId || stream) return;
    liveRunId = runId; // 有这一轮在跑 → 露出「停止生成」
    syncStop();
    const id = 'tcLive-' + runId;
    let host = topicId
      ? $('tcThreads')?.querySelector(`[data-replies="${CSS.escape(topicId)}"]`) ?? null
      : null;
    if (!host) {
      const topics = $('tcThreads')?.querySelectorAll('.tc-topic');
      host = topics?.length ? topics[topics.length - 1].querySelector('[data-replies]') : null;
    }
    // 回复区是折叠的 details 时，先展开 —— 不然 live 气泡塞进折叠区里看不见
    if (host?.matches?.('details.tc-replies') && !host.open) {
      host.open = true;
      if (topicId) openTopics.add(topicId);
    }
    host = host || $('tcThreads');
    host?.insertAdjacentHTML(
      'beforeend',
      `<div class="tc-cmt live" id="${id}">
        ${smAvatar(whoName, '', personaByName(whoName))}
        <div class="tc-cmt-main"><div class="tc-cmt-meta"><b>${esc(whoName)}</b><span class="dim">正在说…</span></div>
        <div class="tc-cmt-text"><div class="typing"><i></i><i></i><i></i></div></div></div></div>`,
    );
    scrollThreads();
    const body = document.querySelector('#' + id + ' .tc-cmt-text');
    const add = (cls, text, asHtml = false) => {
      body?.querySelector('.typing')?.remove();
      const d = document.createElement('div');
      d.className = 'step ' + cls;
      if (asHtml) d.innerHTML = text; else d.textContent = text;
      body?.appendChild(d);
      scrollThreads();
    };
    stream = streamRun(runId, {
      onText: (chunk) => add('text', renderMarkdown(chunk), true),
      onRunError: (msg) => add('bad', '· ' + firstMeaningfulLine(msg)),
      onDone: () => {
        stream?.close?.();
        stream = null;
        liveRunId = null; // 这一轮结束了 → 收起「停止生成」
        syncStop();
        refreshThread();
        // 跑完卡片状态会收成「待确认」—— 页头那颗 pill 跟着刷一下（不重画整页，评论草稿不丢）
        api(`/api/projects/tasks/${encodeURIComponent(taskId)}`)
          .then((d) => { if (d?.task) { task = d.task; refreshHeader(); } })
          .catch(() => { /* 取不到就等下次刷新 */ });
      },
      onReconnect: () => refreshThread(),
    });
    // 弹窗那条路：记到模块级，openTaskCardDialog 关弹窗时掐掉
    // （不掐的话它还在后台收消息，往一个已经从文档里摘掉的 DOM 里写）
    if (dlg) tcDlgStream = stream;
  };
  if (runningRun) attach(runningRun.id, null); // 打开时正好在跑 → 接上，不等刷新

  const sendText = async () => {
    const text = $('tcInput').value.trim();
    if (!text) return;
    if (!whoCombo.value()) { toast('先在右边选一个执行人 —— 评论区是跟他讨论的'); return; }
    const mode = sendMode; // note | discuss | execute
    const parentId = replyTo;
    $('tcInput').disabled = true;
    $('tcSend').disabled = true;
    try {
      // 刚在右边选的人可能还没点「保存」：先落库，否则服务端会说"先指定执行人"。
      if (task.assigneePersonaId !== whoCombo.value()) {
        const saved = await api(`/api/projects/tasks/${encodeURIComponent(taskId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ personaId: whoCombo.value() }),
        });
        task.assigneePersonaId = saved?.task?.assigneePersonaId ?? whoCombo.value();
      }
      const r = await api(`/api/projects/tasks/${encodeURIComponent(taskId)}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, parentId, mode }),
      });
      convId = r.conversationId ?? convId;
      $('tcInput').value = '';
      clearReply();
      await refreshThread();
      // 新开的议题：他这次的回复要落进**我刚发的那条**下面（服务端也是这么挂 parentId 的），
      // 所以气泡的落点用新评论的 id，而不是 null
      if (r.runId) attach(r.runId, parentId ?? r.message?.id ?? null);
      else if ($('tcHint2')) {
        $('tcHint2').textContent = '已记下 —— 便签只给你看，没叫醒他。';
      }
    } catch (e) {
      // 400/409 的原因要原样说出来（比如"他还在跑上一条"）
      toast(`没发出去：${e.message}`);
    } finally {
      $('tcInput').disabled = false;
      $('tcSend').disabled = false;
      // 便签是刻意选的：发完回到默认「讨论」（下一次多半是要跟他聊）
      if (mode === 'note') { sendMode = 'discuss'; paintMode(); }
      $('tcInput').focus();
    }
  };
  $('tcSend').onclick = sendText;

  // 页面要被换掉 / 弹窗要关时，把挂在 document 上的收起监听摘掉（否则会一层层堆起来，见 setRoute）
  cleanups.push(() => document.removeEventListener('click', onDocClick));
}

/**
 * **全局任务看板**：所有项目的活铺在同一张看板上（入口：工作台 → 任务看板）。
 *
 * 它跟项目看板是**同一张看板**（共用 `openBoardPage`），只是 `project = null`：
 * 数据取 `/api/tasks`、卡片上多一枚「哪个项目」的标签、列头「＋」建卡时要选项目。
 * 服务端那边 `allTasks()` 与 `projectTasks()` 也共用 `board()` —— 同一套行、同一套列。
 */
async function openTaskBoard() {
  setRoute('taskBoard');
  const view = $('pluginView');
  view.classList.add('kb-page'); // 跟项目看板一样满屏（同一套 CSS）
  document.body.classList.add('no-list'); // 看板是满屏页，左栏收掉（直接调进来时 setNav 不一定跑过）
  S.boardAll = true;             // 位置记忆：刷新回到全局面板
  S.projectId = null;
  S.projectList = false;
  S.plugin = null;               // 它不是插件，别让插件那条路抢走位置
  savePlace();

  await openBoardPage({ project: null });
}

/** 看板的一列：列头（名字 + 张数 + ＋）+ 卡片；空列也画出来，写「无任务」 */
function kbColumn(col) {
  return `<section class="kb-col ${esc(col.key)}" data-kb-col="${esc(col.key)}">
    <header class="kb-col-head">
      <span class="kb-dot"></span><b>${esc(col.label)}</b>
      <span class="kb-count">${col.count}</span>
      ${col.hint ? `<span class="kb-hint">${esc(col.hint)}</span>` : ''}
      <button class="kb-add" type="button" data-kb-add="${esc(col.key)}" title="在这一列新建任务">＋</button>
    </header>
    <div class="kb-cards">
      ${col.cards.length ? col.cards.map(kbCard).join('') : '<div class="kb-empty">无任务</div>'}
    </div>
  </section>`;
}

/**
 * 一张任务卡：来源标出来、执行人写清楚。
 *   · 流程卡 → 那条实例；聊天卡 → 那个会话；手工卡 → 那个会话（没派活就没地方可去）
 *   · **手工卡可以拖到别的列**（改状态）—— 看板上最自然的手势，跟 Multica 一致
 */
/** PR 联动（2026-10-17）：卡片上那枚「PR #n 开着/已合并」小标签；没关联 PR 就什么都不画 */
function prPillOf(r) {
  if (!r?.pr) return '';
  const text = r.pr.state === 'merged' ? '已合并' : r.pr.state === 'closed' ? '已关闭' : '开着';
  return `<span class="kb-tag pr" title="关联的 Pull Request">PR #${r.pr.number} ${text}</span>`;
}

function kbCard(r) {
  /*
   * 「本地卡」= 存在 project_tasks 里的那些：手工建的（`manual`）与**仓库值班写进来的**（`repo`）。
   * 同一族：都能拖（**拖到哪一列就是人给的指令**）、都能删（＝忽略）。
   * 流程卡与聊天卡的状态归平台管，拖不动。
   */
  const local = r.source === 'manual' || r.source === 'repo';
  const jump = r.source === 'flow'
    ? `data-kb-flow="${esc(r.flow_id)}" data-kb-tpl="${esc(r.template_id || '')}"`
    : r.conversation_id
      ? `data-kb-conv="${esc(r.conversation_id)}"`
      : '';
  const drag = local
    ? `draggable="true" data-kb-manual="${esc(r.manual_id)}"`
    : '';
  // 本地卡多一颗删除（拖错了、建错了、不想管了要能撤）
  const del = local ? `<button class="kb-del" type="button" data-kb-del="${esc(r.manual_id)}" title="删掉这张卡">×</button>` : '';
  // 全局面板的行才带 project_name（项目看板的行服务端已经摘掉了）——
  // 站在全局看，第一眼要知道的就是"这是哪个项目的活"
  const proj = r.project_name
    ? `<span class="kb-tag proj" title="属于哪个项目">${esc(r.project_name)}</span>`
    : '';
  const srcCls = r.source === 'chat' ? ' chat' : r.source === 'repo' ? ' repo' : local ? ' manual' : '';
  return `<article class="kb-card ${local ? 'manual' : ''}" ${jump} ${drag}${local ? ` data-kb-open="${esc(r.manual_id)}" tabindex="0"` : ''} data-col="${esc(r.col)}" title="${esc(r.note || '')}">
    <div class="kb-card-top">
      ${proj}<span class="kb-tag${srcCls}">${esc(r.source_text)}</span>${prPillOf(r)}
      <span class="kb-state">${esc(r.status)}</span>
      ${del}
    </div>
    <div class="kb-card-title">${esc(r.task)}</div>
    <div class="kb-card-foot"><span class="kb-who">${esc(r.assignee)}</span><span>${esc(r.at)}</span></div>
  </article>`;
}

/**
 * 新建手工任务的弹窗（参照 Multica 的「＋」那个框）。
 *
 * 只有标题是必填。选了执行人就能勾「创建后立即开始工作」——那会**真的派活**
 * （发到他的 1:1 会话，工作目录是这个项目），所以框里明写出来，别让人意外。
 *
 * `project` 为 null = **从全局面板点的「＋」**：那一页没有"当前项目"，
 * 手工卡又必须挂在某个项目下（服务端 `createProjectTask` 要 project），
 * 所以弹窗里多一个项目下拉，让人先挑一个。
 */
function taskDialog(project, colKey) {
  const dlg = document.createElement('dialog');
  dlg.id = 'taskDlg';
  const status = COL_STATUS[colKey] ?? '待办';
  const projects = S.projects ?? [];
  /*
   * 项目 / 执行人**都换成可搜索的下拉**（全站公共组件 createCombo）——
   * 项目一多、数字员工一多，原生 select 只能一格一格翻，搜不了。
   * 状态那格只有 6 个固定值，继续用原生 select。
   */
  const pick = !project
    ? `<label>项目（这张卡挂在哪个项目下）</label><div id="tkProjMount"></div>`
    : '';
  dlg.innerHTML = `
    <form method="dialog">
      <b>新建任务</b>
      ${pick}
      <label>标题</label>
      <input id="tkTitle" placeholder="一句话说清要做什么" />
      <label>描述（可留空）</label>
      <textarea id="tkDesc" rows="3" placeholder="边界、验收标准、参照哪个文件…"></textarea>
      <div class="grid2">
        <div>
          <label>放到哪一列</label>
          <div id="tkStatusMount"></div>
        </div>
        <div>
          <label>执行人（可留空 = 先挂着）</label>
          <div id="tkWhoMount"></div>
        </div>
      </div>
      <label class="kb-check"><input type="checkbox" id="tkStart" checked /> 创建后立即开始工作（派到他的会话，工作目录就是这个项目）</label>
      <div class="dim" id="tkFilterHint" style="font-size:12px;margin-top:8px" hidden></div>
      ${project ? `<div class="kb-proj-hint">项目：${esc(project.name)} · ${esc(project.root)}</div>` : ''}
      <div class="dlg-actions">
        <button type="button" value="cancel">取消</button>
        <button class="primary" id="tkOk" value="ok">创建任务</button>
      </div>
    </form>`;
  document.body.append(dlg);
  // 动态建的对话框**得自己包一次头部** —— 页面加载时那一遍它还不存在（见 wireDialogHead）
  wireDialogHead(dlg.querySelector('form'));
  dlg.addEventListener('close', () => dlg.remove());

  // 状态那格：只有 6 个固定值，**不传 search**（组件的约定是选项多的才给搜索）
  const statusCombo = createCombo({
    mount: $('tkStatusMount'),
    items: ['想法', '待办', '进行中', '待确认', '已阻塞', '已完成'].map((s) => ({ id: s, label: s })),
    value: status,
    // 这两件事都定义在下面 —— 点选时才跑，那时它们早就绪了（顺序是有意的）
    onChange: () => {
      syncStart();
      syncFilterHint();
    },
  });
  // 项目下拉：不固定项目时才有（点某一列的「＋」时，项目已经定了）
  const projCombo = project
    ? null
    : createCombo({
        mount: $('tkProjMount'),
        items: projects.map((p) => ({ id: p.id, label: `${p.name} · ${p.root}` })),
        value: projects[0]?.id ?? '',
        search: true,
        placeholder: '搜项目名或目录…',
        empty: '没有匹配的项目',
        // 换项目 = 可能换成"筛选之外的项目"，那句提醒要跟着重算
        onChange: () => syncFilterHint(),
      });
  const whoCombo = createCombo({
    mount: $('tkWhoMount'),
    items: [{ id: '', label: '不派活' }, ...(S.personas ?? []).map((p) => ({ id: p.id, label: personLabel(p) }))],
    value: '',
    search: true,
    placeholder: '搜数字员工…',
    empty: '没有匹配的人',
    // 这个箭头只在**点选时**才跑，那时下面的 syncStart / syncFilterHint 早就定义好了 —— 顺序是有意的
    onChange: () => {
      syncStart();
      syncFilterHint(); // 选了个人 → 可能这个人不在当前筛选里，提醒要跟着变
    },
  });

  /*
   * 「立即开始」什么时候不该给勾：
   *   · 没选执行人 —— 勾了也没人可派
   *   · 状态是「想法」—— 那是"还没决定要不要做"，谈不上开始；勾了的话卡刚建完就
   *     被转到「进行中」，那一列等于白建（服务端也拦了这一条，见 project-tasks.mjs）
   * 这里是让人**别以为勾了个空**：不可用时灰掉、取消勾选、并说明原因。
   */
  const syncStart = () => {
    const has = !!whoCombo.value();
    const idea = statusCombo.value() === '想法';
    const on = has && !idea;
    const box = $('tkStart').closest('.kb-check');
    $('tkStart').disabled = !on;
    if (!on) $('tkStart').checked = false;
    box.style.opacity = on ? '1' : '.5';
    box.title = idea ? '「想法」是还没决定要不要做，先不派活' : has ? '' : '先选一个执行人';
  };
  syncStart();
  /*
   * 看板上有筛选时，先说清楚"这张卡建完会不会被挡住"：
   * 挡在筛外的东西不止状态了（还有负责人、项目），所以要把**是哪一维**说出来 ——
   * 只说"看不到它"，人就得自己去猜是哪一条筛掉的。
   * 这比事后让人怀疑"我是不是没建成"强。
   */
  const syncFilterHint = () => {
    const el = $('tkFilterHint');
    if (!el) return;
    const st = statusCombo.value();
    // 拿一张"将要建出来的卡"去试：状态是选的那个，人是选的那个人，项目是这一页定的那个
    const why = kbWhyHidden(
      { status: st, assignee_id: whoCombo.value() || '', project_id: project?.id ?? projCombo?.value() ?? '' },
      S.boardAll ? 'all' : undefined,
    );
    el.hidden = !why;
    el.textContent = !why
      ? ''
      : why === 'status'
        ? `注意：当前筛选不含「${st}」，建完这张卡会留在看板外面（点「清除」能看到）。`
        : why === 'who'
          ? '注意：当前筛选只看别人 —— 这张卡派给他之后会留在看板外面（点「清除」能看到）。'
          : '注意：当前筛选只看别的项目 —— 这张卡建完会留在看板外面（点「清除」能看到）。';
  };
  // 状态变了这两件事都要跟着算 —— 挂在 statusCombo 的 onChange 上（见上面创建处）
  syncFilterHint();
  $('tkOk').onclick = async (e) => {
    e.preventDefault();
    const title = $('tkTitle').value.trim();
    if (!title) return toast('任务得有标题');
    const chosen = project ?? projects.find((x) => x.id === projCombo?.value());
    if (!chosen) return toast('先建一个项目，任务才有地方挂');
    try {
      await api(`/api/projects/${encodeURIComponent(chosen.id)}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          description: $('tkDesc').value.trim(),
          status: statusCombo.value(),
          personaId: whoCombo.value() || null,
          startNow: !!whoCombo.value() && $('tkStart').checked,
        }),
      });
      dlg.close();
      // 在哪儿建的就在哪儿重画：全局面板回全局面板（刚建的卡会带项目标签出现在那一列）
      await (S.boardAll ? openTaskBoard() : openProjectDetail(chosen.id));
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  dlg.showModal();
  setTimeout(() => $('tkTitle')?.focus(), 50);
}

/**
 * 页内浏览目录（浏览器那条路的兜底）：走**服务端**列子目录。
 *
 * 浏览器出于安全不给绝对路径（`webkitdirectory` 只给假路径），
 * 所以只能这样点着往下走；路径也可以直接粘进来（2026-10-22 加，深目录不用一路点）。
 * 返回选中的绝对路径；取消返回 null。
 */
function browseDirectory(startPath) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.id = 'dirDlg';
    dlg.innerHTML = `
      <form method="dialog">
        <b>选目录</b>
        <div class="row-inline">
          <input id="dirPath" spellcheck="false" placeholder="路径（可以直接粘贴，回车前往）" />
          <button type="button" id="dirGo">前往</button>
        </div>
        <div class="dir-list" id="dirList"></div>
        <div class="dlg-actions">
          <button type="button" value="cancel">取消</button>
          <button class="primary" id="dirOk" value="ok">就选这个目录</button>
        </div>
      </form>`;
    document.body.append(dlg);
    // 动态建的对话框**得自己包一次头部** —— 页面加载时那一遍它还不存在（见 wireDialogHead）
    wireDialogHead(dlg.querySelector('form'));
    let cur = startPath || '';
    let settled = false;
    const settle = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
      dlg.close();
    };
    dlg.addEventListener('close', () => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
      dlg.remove();
    });

    const paint = async () => {
      try {
        const d = await api('/api/fs/dirs' + (cur ? '?path=' + encodeURIComponent(cur) : ''));
        cur = d.path;
        $('dirPath').value = d.path;
        $('dirList').innerHTML =
          (d.parent ? `<div class="dir-row up" data-go="${esc(d.parent)}">↰ 上一层</div>` : '') +
          (d.dirs.length
            ? d.dirs.map((x) => `<div class="dir-row" data-go="${esc(x.path)}">${esc(x.name)}</div>`).join('')
            : '<div class="dir-row none">（没有子目录）</div>');
        $('dirList').querySelectorAll('[data-go]').forEach((el) => {
          el.onclick = () => {
            cur = el.dataset.go;
            paint();
          };
        });
      } catch (e) {
        $('dirList').innerHTML = `<div class="dir-row none">${esc(e.message)}</div>`;
      }
    };
    const go = () => {
      const v = $('dirPath').value.trim();
      if (!v) return;
      cur = v;
      paint();
    };

    $('dirGo').onclick = (e) => {
      e.preventDefault();
      go();
    };
    $('dirPath').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      go();
    });
    $('dirOk').onclick = (e) => {
      e.preventDefault();
      if (!cur) return;
      settle(cur);
    };
    dlg.showModal();
    paint();
  });
}

/**
 * 选**本机**目录的统一入口（项目「工作目录」、仓库本地目录等处共用）。
 *
 * 桌面壳里优先走**壳的原生目录框**：`pick_directory` 命令用 `IFileOpenDialog`，
 * 带主窗口当 owner —— 对话框一定压在这个窗口上、系统标准样式、能一路点到任意盘。
 * 浏览器（`start.cmd` 那条）没有原生框，退回页内浏览（服务端列目录）。
 *
 * ⚠️ 2026-10-22 用户实报「点选择没反应」的根因就是原来那条「服务端弹原生框」：
 * 服务端是没有窗口的后台进程，它 spawn 的 PowerShell 弹的框没有属主，
 * 实测窗口 `IsWindowVisible=false` —— 被最大化的壳窗口整个盖住，按钮一直转「…」。
 * 原生框归壳管，服务端那条已经删掉（见 apps/server/src/server.mjs 的说明）。
 *
 * 返回选中的绝对路径；取消返回 null（不会抛，最差也是页内浏览）。
 */
async function pickLocalDir({ title = '选择本机目录', startPath = '' } = {}) {
  const invoke = window.__TAURI_INTERNALS__?.invoke || window.__TAURI__?.core?.invoke;
  if (typeof invoke === 'function') {
    try {
      const picked = await invoke('pick_directory', { title, defaultPath: startPath || null });
      return picked || null;
    } catch (e) {
      // 壳里命令不在 / 权限没给 / 系统不支持 —— 退回页内浏览，别让人卡在按钮上
      console.warn('[选目录] 原生目录框不可用，退回页内浏览：', e);
    }
  }
  return browseDirectory(startPath);
}

/**
 * 「选择」目录按钮的公共逻辑（新建弹窗和详情就地编辑共用）。
 */
async function pickProjectDir(btnId, inputId) {
  // ⚠️ id 必须成对传入：详情表单和新建弹窗**同时在线**，两边若用同名 id，
  // `$('pjName')` 会取到文档里前一个 —— 踩过：新建弹窗实际创建出了
  // "当前选中项目的复制品"（2026-10-18 实测）。
  const btn = $(btnId);
  const el = $(inputId);
  /* 填值必须补发一次 `input`（2026-10-22 修"选择没生效"）：详情页的自动保存只认
     input/blur 事件，代码直接赋 value 什么都不触发 —— 目录看着填上了，其实从没存过。 */
  const apply = (v) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const picked = await pickLocalDir({
      title: '选择项目目录（AI 会在这里干活）',
      startPath: el.value.trim(),
    });
    if (picked) apply(picked);
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '选择';
  }
}

/**
 * 新建项目的小弹窗（2026-10-18 用户定的分工）：**弹窗只问名字和路径**，
 * 附加根 / 说明 / 宪法这些都在右侧详情里编辑（renderProjDetail 的就地编辑）。
 * 只管新建 —— 编辑走详情页，不再有「编辑弹窗」。
 */
function projectDialog() {
  const dlg = document.createElement('dialog');
  dlg.id = 'projDlg';
  // ⚠️ 这里的 id 全部带 np 前缀（new project）：弹窗打开时详情表单就在背后，
  // 两边同 id 的话 $() 会取到详情那份 —— 实测创建出了"当前项目的复制品"。
  dlg.innerHTML = `
    <form method="dialog">
      <b>新建项目</b>
      <label>名字</label><input id="npName" placeholder="例如：班底" />
      <label>项目目录（AI 就在这儿干活）</label>
      <div class="row-with-btn">
        <input id="npRoot" placeholder="例如：E:\\02CodeSpace\\bandi" />
        <button type="button" id="npPick" title="选一个本机目录（AI 会在这里干活）">选择</button>
      </div>
      <div class="dlg-actions">
        <button type="button" value="cancel">取消</button>
        <button class="primary" id="npOk" value="ok">创建</button>
      </div>
    </form>`;
  document.body.append(dlg);
  // 动态建的对话框**得自己包一次头部** —— 页面加载时那一遍它还不存在（见 wireDialogHead）
  wireDialogHead(dlg.querySelector('form'));
  dlg.addEventListener('close', () => dlg.remove());
  $('npPick').onclick = () => pickProjectDir('npPick', 'npRoot');
  $('npOk').onclick = async (e) => {
    e.preventDefault();
    const name = $('npName').value.trim();
    const root = $('npRoot').value.trim();
    if (!name) return toast('给项目起个名字');
    if (!root) return toast('项目目录不能空 —— AI 要在这儿干活');
    try {
      const saved = await api('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, root, extraRoots: [], note: '' }),
      });
      dlg.close();
      // 存完回项目页并选中刚那个：附加根/说明/宪法都在详情里补
      await openProjectsPage(saved?.project?.id);
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  dlg.showModal();
  setTimeout(() => $('npName').focus(), 50);
}

/* ---------------------------------------------------------------- 起流程 */

/** 点工作台里的流程 → 填写想法 → 发起 */
let fsTitleTouched = false; // 用户自己动过流程名称没有（动过就不再跟着想法预填）

function openFlowStart(flowId) {
  const flow = (S.flowPublished ?? []).find((f) => f.id === flowId);
  if (!flow) return toast('这条流程不在工作台上（可能被下架了）');
  S.flowStarting = flow.id;
  fsTitleTouched = false;
  $('fsTitle').value = '';
  $('fsIntent').value = '';
  // 项目：默认用上次选的；没有就选内置那个「默认项目」
  const projects = S.projects ?? [];
  const last = projects.some((p) => p.id === S.flowProjectId) ? S.flowProjectId : null;
  if (!last) S.flowProjectId = (projects.find((p) => p.builtIn) ?? projects[0])?.id ?? '';
  // ⚠️ **下拉必须在 showModal 之前插好**：先 show 再插的话，弹窗会先以"少一行"
  // 的样子出现，下一帧长高一下 —— 看着就是"弹窗闪了一下"（用户报的）。
  mountFlowProjectPicker();
  $('flowStartDlg').showModal();
  setTimeout(() => $('fsIntent').focus(), 50);
}

/** 发起对话框里的「项目」下拉：这一步（以及整条流程）在哪个目录里干活。
 *  ⚠️ 它跟工作台那个「项目」是**同一个实体**（projects 表）—— 以前这里叫"工作区"，
 *     于是同一个东西两处两个名字，用户在上面看到"工作区"、去工作台却只能"新建项目"。 */
function mountFlowProjectPicker() {
  const mount = $('fsProjectMount');
  if (!mount) return;
  const projects = S.projects ?? [];
  mount.innerHTML = '';
  if (!projects.length) {
    mount.innerHTML = '<span class="dim" style="font-size:12.5px">还没有项目，去工作台建一个</span>';
    return;
  }
  if (!projects.some((p) => p.id === S.flowProjectId)) S.flowProjectId = projects[0].id;
  createCombo({
    mount,
    items: projects.map((p) => ({ id: p.id, label: p.name })),
    value: S.flowProjectId,
    search: false,
    onChange: (id) => {
      S.flowProjectId = id;
      const p = projects.find((x) => x.id === id);
      const hint = $('fsProjectPath');
      if (hint && p) hint.textContent = p.root;
    },
  });
  const p = projects.find((x) => x.id === S.flowProjectId);
  const hint = $('fsProjectPath');
  if (hint && p) hint.textContent = p.root;
}

/**
 * 名字跟着想法走：用户没自己动过名字，就拿想法的第一行预填。
 * 预填而不是留空 —— 大多数时候第一行就是最合适的名字，但**用户可以改**。
 */
function syncFlowTitle() {
  if (fsTitleTouched) return;
  const first = ($('fsIntent').value || '').trim().split('\n')[0].trim();
  $('fsTitle').value = first.slice(0, 40);
}

async function doStartFlow() {
  const flowId = S.flowStarting;
  if (!flowId) return;
  const intent = ($('fsIntent').value || '').trim();
  if (!intent) return toast('先说说要干什么');
  // 名字没填就退回"想法第一行"（服务端也会兜一层）
  const title = ($('fsTitle').value || '').trim();
  // 项目：AI 就在这个目录里干活（整条流程共用）
  const projectId = S.flowProjectId || null;
  try {
    // 没有"在哪儿跑"：流程不建群，派给谁就发到谁那儿
    const r = await api('/api/workflows/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId: flowId, title, intent, projectId }),
    });
    $('flowStartDlg').close();
    S.flowStarting = null;
    await load(); // 会话列表可能要跟上
    // **发起后直接落到实例页**：左边发起记录，右边流转节点记录。
    // skipOpen 是为了别让 setNav 又去开"模板编排"页 —— 两边抢渲染谁后回来谁赢
    setNav('workflows', { skipOpen: true });
    await openFlowRun(flowId, r.id);
  } catch (e) {
    toast(e.message, 'error');
  }
}

/**
 * 左栏顶上的标题：`setListTitle('工作台')` 写名字，
 * `setListTitle([{label:'工作台',to:'workbench'}, {label:'流程编排'}])` 写面包屑。
 *
 * 为什么做成两个入口而不是让调用处拼 HTML（2026-10-19 用户截图：「改成面包屑」）：
 *   · 左栏 `#listTitle` 原来是个 `<b>`，十几处直接写 `textContent`；
 *   · 面包屑是"你在哪儿"，它该长在**左栏列表顶上**（2026-10-19 用户第二次截图：
 *     「面包屑应该是在左边的列表上，右边的不用」）—— 于是右页头那条面包屑全撤了，
 *     统一挪到这儿；页头只留当前这一项的名字 / 操作。
 *
 * 数组的每一段可以是字符串（= 当前这一层，不可点）或 `{label, to, arg?}`：
 *   · 最后一段**永远不可点**（当前位置）；中间段必须给 `to`（`CRUMB_GO` 的键）；
 *   · 点击走全站那一个 document 事件委托（`data-crumb-to`），页面里不写 onclick ——
 *     左栏标题会随页面重画，逐个绑必漏。`to` 用 key 而不是函数，跟页头面包屑同一套。
 *
 * 传数组时全部用 `textContent` 写（流程名/项目名/员工名都来自用户输入，不能进 innerHTML）。
 */
function setListTitle(t) {
  const el = $('listTitle');
  if (!el) return;
  if (!Array.isArray(t)) {
    el.innerHTML = `<b title="${esc(t)}">${esc(t)}</b>`;
    return;
  }
  el.innerHTML = '';
  t.forEach((part, i) => {
    const it = typeof part === 'string' ? { label: part } : part;
    if (i) {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = '›';
      el.append(sep);
    }
    if (i === t.length - 1) {
      const b = document.createElement('b');
      b.textContent = it.label;
      b.title = it.label; // 名字长时会被省略号截掉，悬停能看全
      el.append(b);
      return;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'crumb-btn';
    btn.textContent = it.label;
    btn.title = `回${it.label}`;
    if (it.to) {
      btn.dataset.crumbTo = it.to;
      if (it.arg != null) btn.dataset.crumbArg = String(it.arg);
    }
    el.append(btn);
  });
}

/* -------------------------------------------------- 流程实例页（流转记录） */

/**
 * 一条流程的实例页：**左边是发起记录，右边是流转节点记录**。
 * 要一眼看出三件事：走到哪个节点了、谁在干活、卡在哪了。
 */
async function openFlowRun(templateId, pickRunId) {
  S.flowMode = 'run';
  S.flowTemplate = templateId ?? null;
  if (pickRunId) S.flowRunId = pickRunId;
  // **先把一级栏和"当前位置"落定** —— 从工作台点进来的，不设的话 S.nav 还是"工作台"，
  // 一刷新就被恢复到工作台去了（踩过）
  setNav('workflows', { skipOpen: true });
  document.body.classList.remove('no-list');
  // 左栏这一栏是「发起记录」：面包屑只到**二级**——工作台 › 流程名。
  // 中间不能插「流程编排」（2026-10-19 用户截图：「这个只是个二级标题，没有流程编排」）：
  // 发布过的流程是工作台上的**一级磁贴**，点它直接到这页，并不经过「流程编排」那一层；
  // 而「流程编排」是"画流程"的那一页，两者的上一级都只是工作台。
  setListTitle([{ label: '工作台', to: 'workbench' }, { label: '发起记录' }]);
  setRoute('flowRun', { template: templateId ?? null, run: pickRunId ?? S.flowRunId ?? null });
  // 左栏顶上的「＋」在这儿是**发起一条**（不是新建模板）
  $('listAction').classList.remove('hidden');
  $('listAction').title = '发起一条';
  $('search').closest('.list-search')?.classList.add('hidden');

  let data = { runs: [], templates: [] };
  try {
    data = await api('/api/workflows');
  } catch { /* 拿不到就当空的 */ }
  S.flowTemplates = data.templates ?? [];
  const tpl = (data.templates ?? []).find((t) => t.id === templateId) ?? null;
  if (tpl) setListTitle([{ label: '工作台', to: 'workbench' }, { label: tpl.name }]);

  S.flowRuns = (data.runs ?? []).filter((r) => !templateId || r.templateId === templateId);
  if (pickRunId) S.flowRunId = pickRunId;
  if (!S.flowRuns.some((r) => r.id === S.flowRunId)) S.flowRunId = S.flowRuns[0]?.id ?? null;

  renderRunList();
  if (S.flowRunId) await paintRun(S.flowRunId);
  else renderRunEmpty();
}

function runBadge(r) {
  // **先看流程本身结束了没有**：已终止/已完成的任务可能停在「待确认」，
  // 那不代表在等你 —— 之前顺序反了，终止的流程还写着"等你确认"（误导过）
  //
  // 颜色：完成=绿、阻塞=红、终止=灰（灰就是列表里状态字的默认色，见 .item .line1 span；
  // 这里明写一个 gray 只是让读代码的人知道"这个不是漏了"，CSS 里不必再写一条同色规则）。
  if (r.status === '已终止') return { text: '已终止', cls: 'gray' };
  if (r.status === '已完成') return { text: '已完成', cls: 'ok' };
  // 叫「已阻塞」而不是「卡住」：服务端给的 stuck 理由本来就写着「部署」已阻塞，等人处理，
  // 同一个状态在列表上却叫另一个名字。措辞跟服务端对齐。
  if (r.stuck) return { text: '已阻塞', cls: 'bad' };
  if (r.taskStatus === '待确认') return { text: '等你确认', cls: '' };
  return { text: r.taskStatus ?? r.status, cls: '' };
}

function renderRunList() {
  // **左栏属于当前的一级栏**：人已经切走了就别再画。
  // 流程页有自己的 5 秒轮询（看谁在办、卡没卡），切到通讯录之后它还会醒一次，
  // 于是左栏在「通讯录」和「发起记录」之间来回跳（用户实报）。
  // 与其逐个堵调用方，不如在这儿立规矩：不是工作流页就不许动左栏。
  if (S.nav !== 'workflows') return;
  const runs = S.flowRuns ?? [];
  $('listBody').innerHTML = runs.length
    ? runs
        .map((r) => {
          const b = runBadge(r);
          const sub = [r.nodeName, r.assigneeName, r.stuck].filter(Boolean).join(' · ');
          return `<div class="item ${r.id === S.flowRunId ? 'active' : ''}" data-run="${esc(r.id)}">
            <div class="who">
              <div class="line1"><b>${esc(r.title)}</b><span class="flow-t ${b.cls}">${esc(b.text)}</span></div>
              <div class="line2">${esc(sub || '还没开始')}</div>
            </div>
          </div>`;
        })
        .join('')
    : '<div class="empty" style="padding:24px 12px">还没有发起过<br />去工作台点这个流程</div>';
  $('listBody').querySelectorAll('[data-run]').forEach((el) => {
    el.onclick = () => paintRun(el.dataset.run).catch((e) => toast(e.message, 'error'));
  });
}

function renderRunEmpty() {
  // 还没发起过：说清楚下一步点哪儿，别给个死页。
  // 没有页头：左栏顶上已经是「工作台 › 模板名」，右页头再写一遍就是重复。
  $('flowView').innerHTML = `
    <div class="detail-body run-wrap">
      <div class="wip">这个流程还没有发起过
        <div style="margin-top:14px"><button class="primary" data-run-new>发起一条</button></div>
      </div>
    </div>`;
  S.view = 'flow';
  showView('flow');
  $('flowView').querySelector('[data-run-new]')?.addEventListener('click', () => openFlowStart(S.flowTemplate));
}

async function paintRun(id) {
  // **重画整页会连对话栏一起冲掉**：runHTML 里那栏是 is-hidden 的，
  // 于是"发一条消息"或"5 秒轮询"都会把它变成收起状态（回车后自动关闭，踩过）。
  // 所以先把开合状态和草稿记下来，画完再还原。
  const draft = $('ncInput')?.value ?? '';
  const chatOpen = !!ncCtx && !$('ncCol')?.classList.contains('is-hidden');

  // 顶栏那句「今天已用 X」已经去掉了（2026-10-17 用户要求），额度数据不用再跟着流程一起拉。
  const v = await api('/api/workflows/runs/' + encodeURIComponent(id));
  S.flowRunId = id;
  S.flowRun = v;
  S.flowTemplate = v.templateId ?? S.flowTemplate;
  // 左栏面包屑第二段是**模板名**（这一栏就是模板下的发起记录）；换 run 时也刷一遍，
  // 万一这条 run 属于别的模板（理论上不会，但数据是老的时候可能），标题别停在上一份。
  // 只到二级：工作台 › 模板名（中间没有「流程编排」，见 openFlowRun 的注释）。
  const tplNow = (S.flowTemplates ?? []).find((t) => t.id === S.flowTemplate);
  setListTitle([{ label: '工作台', to: 'workbench' }, { label: tplNow?.name ?? '发起记录' }]);
  /*
   * **左栏那一行也要跟着换成这份新的。**
   *
   * `S.flowRuns` 是**进这一页时**拉的快照，而 `renderRunList` 画的就是它。
   * 详情这份 `v` 是刚拉回来的、新的 —— 只重画列表而不把快照里那一行换掉，
   * 列表就会一直显示旧状态。用户实报："列表里记录的状态和详情里顶部的状态不一致"
   *（列表「已阻塞」、详情「已终止」，服务端数据是「已终止」）。
   *
   * 换掉对应那一行就够：一份数据、两处显示，不该各拉各的。
   * （注意只能换这一行 —— 别人的状态这次没拉，不能顺手刷成同一个值。）
   */
  const at = (S.flowRuns ?? []).findIndex((r) => r.id === v.id);
  if (at >= 0) S.flowRuns[at] = v;
  else S.flowRuns = [v, ...(S.flowRuns ?? [])];
  renderRunList();
  $('flowView').innerHTML = runHTML(v);
  S.view = 'flow';
  showView('flow');
  wireRun(v);
  if (chatOpen) {
    $('ncCol')?.classList.remove('is-hidden');
    const inp = $('ncInput');
    if (inp && draft) inp.value = draft;
    await refreshNodeChat();
  }
  savePlace(); // 记下"在看哪条流程"，刷新回到这儿
  watchRunStep(id, v);
}

/**
 * 盯住**当前这一步在跑的那次运行**，跑完再重画一次。
 *
 * 取代了原来的 5 秒轮询。为什么要换：
 *   · 轮询是"缺推送"的替代品 —— 而推送机制（streamRun）早就有了，流程页只是没用
 *   · 每 5 秒整块 `innerHTML` 重建，会透过遮罩看见 → 弹窗"有频率地闪"（用户报的）
 *   · 顺带把"他正在办 → 办完了"从"最多晚 5 秒"变成**实时**
 *
 * 没有在跑的（等审批、卡住、终态）就什么都不订 —— 那种情况本来就不会自己变。
 */
function watchRunStep(id, v) {
  const cur = (v.tasks ?? [])[v.tasks?.length - 1];
  const runningId = cur?.runningRunId ?? null;
  if (!runningId) {
    // 这一步没在跑 → 收掉连接，别白占着
    if (runStream && runStream.forRun === id) {
      runStream.close();
      runStream = null;
    }
    return;
  }
  if (runStream && runStream.forRun === id && runStream.agentRunId === runningId) return; // 已经订着这条
  runStream?.close();
  runStream = { forRun: id, agentRunId: runningId, close: null };
  const handle = streamRun(runningId, {
    onDone: () => {
      runStream = null;
      // 落库比 __done 稍晚一点：等一小会儿再取，免得拿到半截（跟消息模块一个处理）
      setTimeout(() => {
        if (S.view === 'flow' && S.flowMode === 'run' && S.flowRunId === id) {
          paintRun(id).catch(() => {});
        }
      }, 300);
    },
    // 断线让 EventSource 自己重连；重连后服务端会把这次运行的事件重放一遍（含 __done）
    onReconnect: () => {},
  });
  runStream.close = handle.close;
}
let runStream = null;

/** 收掉实例页那条实时流（离开工作流页时调） */
function closeRunStream() {
  runStream?.close?.();
  runStream = null;
}

function durText(ms) {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} 分 ${s % 60} 秒` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

/**
 * 这一步**该怎么标**：状态 + 要不要再单独说结局。
 *
 * 为什么要这个函数：`decision` 和 `status` 会互相重复 ——
 * 一条办完的步骤是 `已完成 + 通过`，而「通过」就是「已完成」的默认出路，
 * 两个标签并排等于同一句话说两遍（用户指出"重复了"）。
 *
 * 规则：**默认结局不再重复，例外的才露出来**。
 *   · 已完成 + 通过          → 只留「已完成」
 *   · 已完成 + 驳回 / 终止    → 留（办完了，但结局不是正常那个 —— 不矛盾，能并排）
 *   · **没办完 + 终止**       → **合成一句话**，不并排
 *
 * ⚠️ 最后那条是用户实报改的。终止流程时，那一步如果还没开跑，数据就是
 * `status=待办, decision=终止`（见 workflows.decide：终止不受任务状态限制，
 * 原来是"进行中"才降级成已完成，其余原样保留）。界面上并排出现「待办」「终止」，
 * 读起来像**两个互相打架的状态**（用户问："为什么有两个状态"）。
 * 可它其实是同一件事：**这一步还没办完，流程就被终止了**。
 * 所以合成一句 `「待办」时被终止` —— 措辞统一，不维护一张 status→说法 的映射表。
 */
function stepOutcome(t) {
  const decision = t.decision ?? null;
  if (decision === '终止' && t.status !== '已完成') {
    return { status: `${t.status}时被终止`, decision: null, terminal: true };
  }
  const implied = t.status === '已完成' && decision === '通过';
  return { status: t.status, decision: implied ? null : decision, terminal: false };
}

/**
 * 执行结果里的一颗**产物**：改动的文件 或 一条链接。
 *
 * 文件点一下复制路径 —— 平台没有"打开这个文件"的通道（产物可能在经办人的机器上），
 * 复制是最小可用的动作；链接点一下直接开。
 * 文案里只放文件名/标题，完整路径进悬停 —— 一屏要能扫完，而不是读一串目录。
 */
function artChipHtml(a) {
  const isLink = a.kind === 'link';
  const label = a.label || a.target;
  return `<button class="run-art ${isLink ? 'link' : 'file'}" type="button"
    ${isLink ? `data-art-open="${esc(a.target)}"` : `data-art-copy="${esc(a.target)}"`}
    title="${esc(isLink ? a.target : `${a.target}（点击复制路径）`)}">
    ${isLink ? ICON_LINK : ICON_FILE}<span>${esc(label)}</span></button>`;
}

function runHTML(v) {
  const b = runBadge(v);
  const curNode = (v.nodes ?? []).find((n) => n.id === v.currentNodeId) ?? null;
  // **没执行人 = 停在这儿**，这是要一眼看出来的阻塞
  const blocked = v.status === '进行中' && curNode && !curNode.assigneeName;

  const acts = [];
  if (v.status === '进行中') {
    // （顶部只放"对整条流程"的操作 —— 步骤级的动作都在下面时间轴那一步的行里，
    //   混在一起会点错。用户要求去掉顶部这个。）
    //
    // 措辞带上"流程"：步骤行上也有个结局标签写着「终止」（那是**这一步的结局**，不是按钮）。
    // 两颗东西同名同形，用户实报看混过 —— 所以这颗必须说清它管的是**整条流程**。
    acts.push('<button class="danger" data-run-decide="终止">终止流程</button>');
  }
  // 删除放在最后，任何状态都能删（流程自己的记录而已，不碰别人的会话）
  acts.push('<button class="danger" data-run-del title="删掉这条流程记录（不动各经办人的对话）">删除</button>');

  /*
   * 当前这一步的动作**按频率分两处**。以前是整排摆在流程底部那条 `.run-now` 里，
   * 那条的问题不是审美：时间轴最后一行**本来就是"当前这一步"**，底部再摆一遍
   * 等于同一个东西两个家；而且按钮离它作用的那个节点很远。
   *
   *   · 快乐路径（派活 / 通过 / 驳回）→ 直接长在**当前那一步的行内**，还是 1 次点击
   *   · 收拾类（改指派 / 改状态）→ **也长在"当前这一步"那一行里**：
   *     点「状态」那颗字弹状态、点「经办人」弹人选人。
   *     以前这些在右侧栏的「任务卡」标签里，任务卡**已经撤掉** —— 为了改个状态要先开个面板，
   *     而这块信息本来就属于那一步。历史步骤那几行是纯文本（服务端只认当前任务）。
   */
  const inlineActs = [];
  if (v.status === '进行中' && !blocked) {
    // 「派活，开始这一步」这颗按钮去掉了（2026-10-17 对齐 Multica：待办即执行）——
    // 停在待办的步骤会被调度节拍自动派出（他正忙就 30 秒后再试），人没什么可点的。
    // 留一行说明代替按钮：不解释的话，"这步怎么不动"又得靠猜。
    if (v.taskStatus === '待办') inlineActs.push('<span class="dim">待办 —— 马上自动派活，不用点任何东西（他正忙就 30 秒内再试）</span>');
    if (v.taskStatus === '待确认') {
      if (v.outlets?.approve) {
        inlineActs.push(`<button class="primary" data-run-decide="通过">确认这一步完成 → ${esc(v.outlets.approveTo ?? '')}</button>`);
      }
      if (v.outlets?.reject) inlineActs.push(`<button data-run-decide="驳回">驳回 → ${esc(v.outlets.rejectTo ?? '')}</button>`);
    }
    // 「重跑这一步」已删（2026-10-18 用户要求）：把状态改成「待办」就是重跑
    //（setStepStatus 的语义：待办 = 直接派活），同一件事不留两个入口。
    //
    // **额度拦下的只给「继续一次」**：它走的不是"改回待办"（那会又撞一次额度闸、
    // 又写一遍同样的备注），而是带 force 直接派 —— 这颗没别的路能替代，留着。
    if (v.quotaBlocked) {
      inlineActs.push(
        '<button class="primary" data-run-force title="明确知道这一步会超出今天的额度，就放它过去">继续一次</button>',
      );
    }
  }

  const lastTaskId = (v.tasks ?? [])[v.tasks.length - 1]?.id;
  // 哪些节点勾了「需要人工确认完成」——实例页也要在节点上标出来（用户要求），
  // 不然"这一步干完会不会停下来等人"只能靠记。设计器的节点卡上是同一个标签。
  const manualNodes = new Set((v.nodes ?? []).filter((n) => n.manual).map((n) => n.id));
  /*
   * 提示按"它说的东西属于谁"分三层，不都堆在页面顶上：
   *   ① 状态（进行中/已完成/已终止）        → 顶栏那颗胶囊（已有）
   *   ② 现在怎么样（正在跑/等你确认/已阻塞…）→ **那一步的执行结果里第一行**（见下面 state）
   *   ③ 结束了怎么办                       → **时间轴末尾**（见 endedHint）
   *
   * 这么分的原因：② 原来也挂在页面顶部，而这些文案**自带节点名**
   *（「部署」已阻塞，等人处理）—— 它正下方那一行就写着「部署」，
   * 同一个名字上下挨着说两遍。层级放错了，不是位置偏了几像素。
   *
   * ⚠️ 原来还留了一条顶部横幅：「这一步停住了：流程里找不到当前节点」（数据异常）。
   *    用户要求**也收进执行结果**，所以就挂在时间轴最后那一步上 ——
   *    没有当前节点时，最后那一步就是"当前这一步"。
   */
  /*
   * 数据异常：流程在跑、却**找不到当前节点** —— 典型是模板改过（这一步被删了／重排了），
   * 实例的 currentNodeId 就悬空了。
   *
   * 这条必须排在"等你指派"前面：**指派也没用**，那一步在模板里连出口都没有，
   * 派了人也点不到「通过」。原来它被 v.waiting 盖住，页面只说"没人办，等你指派"，
   * 人就会一直卡在那儿点（用户 2026-10-14 那条「部署」就是这么停住的）。
   */
  const curNodeName = v.tasks?.find((t) => t.id === lastTaskId)?.nodeName ?? '当前这一步';
  const orphan =
    v.status === '进行中' && !curNode
      ? `「${curNodeName}」这一步在流程模板里已经没有了 —— 指派也没用。` +
        '把状态改成「已完成」可以直接收尾（流程完成）；要接着往下走，就去「流程编排」把它补回模板。'
      : '';
  // 终态：它是"到此结束"的结论，属于时间轴尾部，不属于开篇。
  const endedHint =
    v.status === '进行中'
      ? ''
      : `<div class="run-end">这条流程已经「${esc(v.status)}」，不能再流转了。
           要再跑一遍，用左栏顶部的「＋」发起一条新的。</div>`;
  /*
   * 「结束」也是时间轴上的一个节点 —— 和流程图对得上。
   *
   * 用户 2026-10-14：最后一步（部署）的出口就是「结束」，可时间轴走到最后一步就没了，
   * 看着像"流程断在这儿"。所以尾部和「开始」对称地画一个终点：
   *   · **到了**（流程已完成）→ 绿点 + 结果，结果用服务端那句 note（形如「通过「部署」」）；
   *   · **没到** → 灰点 + 写清是**哪几步通过之后**会走到这里（出口声明里 approve === 'end' 的那些）。
   * 「已终止」是"没走到终点就散了"：这时不把它画成已到达，灰着就好（上面 endedHint 会说明原因）。
   */
  const endFrom = (v.nodes ?? []).filter((n) => n.approve === 'end').map((n) => n.name);
  const reachedEnd = v.status === '已完成';
  const endStep = `<div class="run-step end ${reachedEnd ? 'done' : 'ahead'}">
        <span class="run-dot"></span>
        <div class="run-step-head"><b>结束</b>${reachedEnd ? '<span class="run-st">已完成</span>' : ''}</div>
        <div class="run-who"><span><i>${reachedEnd ? '结果' : '怎么走到'}</i>${
          reachedEnd
            ? esc(v.note || '流程已完成')
            : orphan
              ? `当前这一步（「${esc(curNodeName)}」）在模板里已经没有了 —— 把它改「已完成」就直接收尾到这儿`
              : endFrom.length
                ? `${esc(endFrom.join('、'))} 通过后走到这里，流程结束`
                : '<span class="dim">模板里没有节点指向结束</span>'
        }</span></div>
      </div>`;
  const history = (v.tasks ?? [])
    .map((t) => {
      const oc = stepOutcome(t);
      // **没办完就被终止**的那一步单独一档颜色：它不是"在跑"（原来的蓝），也不是失败。
      // 蓝点会让它看着像"还在进行中"，而这条流程早就停了。
      const cls = oc.terminal
        ? 'gone'
        : t.status === '已完成' ? 'done'
        : (t.status === '失败' || t.status === '已阻塞') ? 'fail'
        : t.status === '待确认' ? 'wait'
        : 'run';
      const meta = [t.assigneeName ?? '没人', t.visit > 1 ? `第 ${t.visit} 次` : '', durText(t.elapsedMs)]
        .filter(Boolean)
        .join(' · ');
      // 流程页**不铺对话**：只显示有多少条 + 一个「对话」按钮，点开才是面板。
      // 这样对话被锚定在这一个节点上，时间轴也不会被长对话淹掉。
      const n = (t.messages ?? []).length;
      const canTalk = !!t.conversationId && t.status !== '待办';
      // 能不能通到任务卡：服务端给了「已有卡」或「能现开」之一就行（见 viewTask 的说明）
      const canOpenCard = !!t.projectTaskId || t.canOpenTaskCard === true;
      // 这一步的记录（状态 / 经办人 / 第几次 / 时间 / 耗时）现在全在这一行的属性行里，
      // 不用再开一个面板 —— 任务卡就是为此撤掉的。
      const isCur = t.id === lastTaskId;
      // 改状态 / 改指派就是上面那两行本身（点状态、点经办人），这里不再摆第二套。
      // **任务卡入口长在这儿**（2026-10-21 用户拍板）：原来是经办人后面那颗对话气泡，
      // 但它 2026-10-19 起开的已经是任务卡，气泡图标语义错位。现在收进这行字 ——
      // 「已往来 N 条 / 还没聊过」本身就是入口说明，点它开任务卡；
      // 流程没挂项目（开不了卡）时退回对话栏（三条路的接线共用，见下方 data-run-card）。
      const talkable = canOpenCard || canTalk;
      const talkText = canTalk ? (n ? `已往来 ${n} 条` : '还没聊过') : '还没聊过';
      const talk = `<div class="run-talk">${
        talkable
          ? `<button type="button" class="run-card-link" data-run-card data-task="${esc(t.id)}" title="${canOpenCard
              ? (t.projectTaskId ? '打开这一步的任务卡' : '打开任务卡（第一次点会建一张）')
              : '打开对话'}">${talkText}</button>`
          : '<span class="dim">先派活才能对话</span>'
        }</div>`;
      // 行内**只放快乐路径**（派活 / 通过 / 驳回）；重跑已删 —— 改状态成「待办」就是重跑。
      // 「没人可派」那种不在这儿再摆一颗"指派给谁" —— 上一行「经办人」本身就是入口，
      // 摆两颗是同一个动作两个按钮。
      const inline = isCur && inlineActs.length ? `<div class="run-acts">${inlineActs.join('')}</div>` : '';
      /*
       * 「现在怎么样」**写在这一步上**，不往页面顶上喊（见上面分层的说明）。
       * 文案里不含节点名 —— 服务端已经从理由里去掉了，这一行的标题就是那个节点名。
       *   bad   要你动手：已阻塞 / 失败 / 超时 / 找不到当前节点
       *   quiet 只是告知：正在跑 / 等你确认 / 还没派活 / 没人办
       * 服务端对同一个 run 只会给 stuck 或 waiting 之一，不会两个都有。
       */
      const now = isCur ? orphan || v.stuck || v.waiting || '' : '';
      /*
       * 「现在怎么样」（等人处理 / 正在跑 / 等你确认…）原来单开一个框挂在执行结果**上面**。
       * 现在并进执行结果里 —— 它跟"这一步干出来什么"本来是同一件事的两面
       * （干完了什么 + 现在卡在哪），上下两个框并列看着像两条互不相干的提示（用户要求去掉）。
       */
      /*
       * 这一步"谁办的 / 什么时候办的 / 办了多久"。
       *
       * 原来这三样挤在标题行右侧一小串（`.run-meta`：`波哥 · 第 2 次 · 17 秒`），
       * 而「经办时间」**压根没露出来** —— 要看全得点开任务卡。用户要求摊在每步下面，
       * 现在不用开卡就能读全。
       *
       * 缺的字段用「—」而不是整条藏掉：一眼看得出"这三样本来就该有"，
       * 而不是"这一步少了点什么"。
       */
      // **当前这一步能改，历史步骤不能**（服务端只认"当前任务"，见 setStepStatus/assignCurrentStep）。
      // 能改的做成选择器（点一下弹选项）；不能改的退回纯文本 ——
      // 不做成禁用态：既占地方，又让人以为是坏了。
      const alive = v.status === '进行中';
      const canStatus = isCur && alive && (v.statusChoices ?? []).length > 0;
      const canAssign = isCur && alive && (S.personas ?? []).length > 0;
      // 经办人后面**不再摆按钮**（2026-10-21）：那颗气泡 2026-10-19 起开的是任务卡，
      // 气泡图标语义错位 —— 入口挪到了下面「已往来 N 条」那行字上（见 talk）。
      const who = `<div class="run-who">
          <span><i>经办人</i>${
            canAssign ? '<span class="run-pick" id="runAssigneeMount"></span>' : esc(t.assigneeName ?? '没人')
          }${t.visit > 1 ? ` · 第 ${t.visit} 次` : ''}</span>
          <span><i>经办时间</i>${
            t.startedAt ? esc(new Date(t.startedAt).toLocaleString('zh-CN')) : '—'
          }</span>
          <span><i>耗时</i>${esc(durText(t.elapsedMs) || '—')}</span>
        </div>`;
      /*
       * 「执行结果」—— 标题就用**任务卡里那个字段名**（用户当时定的），
       * 别在这一处改口叫"经办信息"：同一个东西两个名字，是前面刚统一过的毛病。
       *
       * 内容**三选一**（2026-10-18 用户要求：简洁明了）：
       *   ① 有产物 → 只列产物（文件 / 链接）；
       *   ② 没产物 → 一句话"做了什么"；
       *   ③ 失败   → 报错原文。
       * 不再整段贴模型的自述 —— 那段开头多是"我先看了一下…"的铺垫，
       * 真正要看的（改了哪个文件 / 报了什么错）在后面，而 note 早就被截断了；
       * 所以拆分在服务端拿**全文**做完，存进 result（见 resultOf）。
       */
      const r = t.result ?? null;
      const arts = (r?.artifacts ?? []).filter((a) => a?.target);
      const err = r?.state === 'error' ? r.error || '执行失败' : '';
      // 有产物就不再补一句话：用户要"有产物展示产物"，两样并排等于又说一遍
      const line = !err && !arts.length ? (r?.summary ?? '') : '';
      const result =
        now || err || arts.length || line
          ? `<div class="run-note-label">执行结果</div><div class="run-note">${
              now
                ? `<div class="run-state ${v.stuck || orphan ? 'bad' : 'quiet'}">${
                    v.stuck || orphan ? '⚠️ ' : ''
                  }${esc(now)}</div>`
                : ''
            }${err ? `<div class="run-err">${esc(err)}</div>` : ''}${
              arts.length ? `<div class="run-arts">${arts.map(artChipHtml).join('')}</div>` : ''
            }${line ? `<div class="run-sum">${esc(line)}</div>` : ''}</div>`
          : '';
      return `<div class="run-step ${cls}${isCur ? ' cur' : ''}">
        <span class="run-dot"></span>
        <div class="run-step-head">
          <b>${esc(t.nodeName)}</b>
          ${/* 勾了「需要人工确认完成」的节点在这儿挂个标签：一眼看出"这步跑完会停下来等人"。
                跟设计器里节点卡上那个是同一个标签、同一套 .tag-inline 药丸。 */ ''}
          ${manualNodes.has(t.nodeId) ? '<em class="tag-inline" title="办完停住，等你确认才往下走">需人工确认</em>' : ''}
          ${
            /* 状态：当前这一步**本身就是选择器**（点它弹选项，选完立刻改）。
               能改哪几个由服务端给（v.statusChoices），前端不自己判断 —— 状态只有一个定义处。
               这原来长在任务卡里，任务卡撤了之后搬回行内。 */
            canStatus
              ? '<span class="run-st run-pick" id="runStatusMount"></span>'
              : `<span class="run-st">${esc(oc.status)}</span>`
          }
          ${oc.decision ? `<span class="run-dec">${esc(oc.decision)}</span>` : ''}
        </div>
        ${who}
        ${result}
        ${talk}
        ${inline}
      </div>`;
    })
    .join('');

  // 还没走到的节点：灰着列出来，好知道后面还有几步
  const done = new Set((v.tasks ?? []).map((t) => t.nodeId));
  const ahead = (v.nodes ?? [])
    .filter((n) => !done.has(n.id))
    .map(
      (n) => `<div class="run-step ahead">
        <span class="run-dot"></span>
        <div class="run-step-head"><b>${esc(n.name)}</b>${
          n.manual ? '<em class="tag-inline" title="办完停住，等你确认才往下走">需人工确认</em>' : ''
        }</div>
        ${/* 还没走到：只有"指定了谁"这一条有内容，时间和耗时留空不写破折号 ——
              这一步还没跑，摆两行「—」是噪音。 */ ''}
        <div class="run-who"><span><i>经办人</i>${esc(n.assigneeName ?? '没人可派')}</span></div>
      </div>`,
    )
    .join('');

  return `
    <div class="run-page">
      <div class="run-left">
        <!-- 顶栏：只属于左边这一栏（右边对话栏自带一条头，两栏等高，见 .run-head 那条规则）。
             左边是推拉列表面板的按钮 + 标题 + 状态徽标，右边是动作。
             返回按钮统一去掉了：回工作台 / 换一条记录都点左栏那一行。 -->
        <div class="detail-head run-head">
          <!-- ⚠️ 顶栏最左边原来有一枚「«」推拉按钮（收起/放出最左侧的列表面板）。
               2026-10-19 用户要求去掉这一页的收缩展开：这一页的左栏是**发起记录**，
               换一条记录全靠点它 —— 收起来等于把自己唯一的路收掉，而省下的那点宽度
               换不来什么（右边还有一整栏对话）。整页统一：**左栏常驻，不推拉**。
               所以这里不再有前置按钮，页头最左边就是标题（跟其它子页一个规矩）。
               面包屑（工作台 › 模板名）在左栏顶上，这里只写**这一条 run 的标题**。 -->
          <div class="head-title"><b>${esc(v.title)}</b>
            <span class="flow-badge ${b.cls}">${esc(b.text)}</span></div>
          <div class="head-actions">${acts.join('')}</div>
        </div>
        <div class="detail-body run-wrap">

      ${/* 「这条流程是什么」：归属项目 / 创建时间 / 想法。
             这三条原来散着、或者根本看不见：
               · 项目：顶栏挂了个小胶囊 —— 就在这块正上方，同一屏里说两遍 → 收到这儿
               · 想法：原来是时间轴「开始」节点里的那段 —— 那块就在这一块正下方，
                 同一句话上下挨着显示两遍 → 也收到这儿
               · 创建时间：以前压根没露出来（viewRun 只给当前任务的 startedAt）
             现在集中成一处；时间轴从「开始」往下就是纯粹的流转记录了。 */ ''}
      <div class="run-facts">
        <div class="rf-row">
          <span class="rf-k">归属项目</span>
          <span class="rf-v">${
            v.projectName
              ? esc(v.projectName)
              : '<span class="dim">没选项目 —— 每一步在各自经办人的工作目录里跑</span>'
          }</span>
        </div>
        <div class="rf-row">
          <span class="rf-k">创建时间</span>
          <span class="rf-v">${v.createdAt ? esc(new Date(v.createdAt).toLocaleString('zh-CN')) : '—'}</span>
        </div>
        <div class="rf-row">
          <span class="rf-k">想法</span>
          <span class="rf-v">${v.intent ? esc(v.intent) : '<span class="dim">（发起时没填）</span>'}</span>
        </div>
      </div>

      <div class="run-steps">
        ${/* 「开始」也是时间轴上的一个节点 —— 和流程图对得上。
              它的内容是"发起时填的想法"，但那段话现在在上面的 .run-facts 里了
              （两块紧挨着，同一句显示两遍是纯重复）—— 所以这里只留节点标记。 */ ''}
        <div class="run-step start">
          <span class="run-dot"></span>
          <div class="run-step-head"><b>开始</b></div>
          ${/* 发起人也走同一套"标签 + 值"，跟下面每一步的「经办人」对齐 */ ''}
          <div class="run-who"><span><i>发起人</i>我</span></div>
        </div>
        ${history || '<div class="wip">还没有流转记录</div>'}
        ${ahead}
        ${endStep}
      </div>
      ${/* 终态提示挂在<b>时间轴末尾</b>：它是"到此结束"的结论，不属于开篇。
             原来在页面最顶上压着流程信息，一眼看去很违和（用户报的）。 */ ''}
      ${endedHint}

      </div>
      </div>
      <!-- 第二栏：点节点上的「对话」才出现（不是浮层，各占各的宽） -->
      <div class="nc-col is-hidden" id="ncCol">
        <div class="nc-head">
          <b id="ncTitle">对话</b>
          ${/* 这里原来是「对话 / 任务卡」两个标签。任务卡撤了（内容全搬进了时间轴各步），
                只剩对话，标签行也就没必要了 —— 留一根一行两个标签的横条只会让人去找另一个。 */ ''}
          <!-- 是"收起这一栏"，不是"关掉弹窗" —— 所以用折叠面板的图标，不用 ✕ -->
          <button class="icon-btn" type="button" data-nc-close title="收起这一栏" aria-label="收起这一栏">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                 stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="2.5" />
              <path d="M15 4v16" />
            </svg>
          </button>
        </div>
        <div class="nc-msgs" id="ncMsgs"></div>
        <div class="nc-say">
          <!-- <b>复用主聊天框那套</b>（.input-wrap + .input-tools）：
               边框、焦点环、textarea 的 padding/字号/resize 全在那儿了。
               自己再写一套 .nc-say-box 的结果是"看着像个裸 textarea"——踩过。 -->
          <div class="input-wrap">
            <textarea id="ncInput" rows="5" placeholder="说点什么…（回车换行）"></textarea>
            <div class="input-tools">
              <div id="ncPermMount"></div>
              <!-- 发送：小圆圈 + 向上箭头 -->
              <button class="primary nc-send" type="button" id="ncSend" title="发送" aria-label="发送">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                     stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 19V6" /><path d="M6 12l6-6 6 6" />
                </svg>
              </button>
            </div>
          </div>
        </div>
        <!-- 任务卡（#ncTask）原来在这儿：当前这一步的状态/经办人/重跑。
             状态和经办人现在全在时间轴那一步的行里（点状态、点经办人），
             重跑也删了（把状态改成「待办」就是重跑），所以这一块连同标签一起撤了。 -->
      </div>
    </div>`;
}

function wireRun(v) {
  const view = $('flowView');
  // ⚠️ 发送必须在这儿接 —— 从弹窗搬进页面时漏过一次，
  //    结果按钮点了毫无反应（连提示都没有），排查了半天。
  // **回车不发送**：这里写的是长文本（需求、意见），回车应该是换行 ——
  // 想发就点那个圆圈按钮。
  //
  // ⚠️ 一律用 `onclick =` 而不是 addEventListener：**这个函数会被重复调用**
  //    （增量更新之后要重新接按钮），addEventListener 会叠加成"点一次发两条"。
  const send = view.querySelector('#ncSend');
  // 他在办的时候，这颗按钮不是"发送"，是"停止生成" —— 跟 DSH 一样
  //（DSH 运行中那颗按钮的文案就是 input.stop = 停止生成，图标是方块）
  // ⚠️ 按**按钮自己的状态**判断走哪条路，别依赖 ncCtx（那是右侧对话栏的东西，
  //    没开栏时它是 null，点击会掉进 sendNodeChat —— 空输入，看着像"点了没反应"）
  if (send) send.onclick = () => (send.classList.contains('stopping') ? stopNodeRun() : sendNodeChat());
  /*
   * 节点上「已往来 N 条」那行字 → **这一步的任务卡**（2026-10-21 起；再往前是经办人后面的
   * 对话气泡图标，气泡语义错位被挪走了）；没有卡、也不能开卡时退回对话栏。
   *
   * 三条路，顺序不能反：
   *   ① 服务端说"已经有卡" → 直接开弹窗（不写库）；
   *   ② 说"能开" → 让服务端现开一张再开（`POST .../card` 是幂等的，点两次不会两张）；
   *   ③ 都没有（流程没挂项目）→ 退回原来的对话栏 —— 那条路还在，只是不再是首选。
   * 一次点击只该发生一件事，所以用 if/else 串起来而不是各挂各的。
   *
   * ⚠️ ①②落在**弹窗**里（`openTaskCardDialog`），不换页（2026-10-19）：
   *    换页会把人从这条流程里带走，改完还得自己找回来 —— 换来的只是一个"整页"的壳。
   */
  view.querySelectorAll('[data-run-card]').forEach((el) => {
    el.onclick = async () => {
      const taskId = el.dataset.task;
      const step = (v.tasks ?? []).find((x) => x.id === taskId) ?? null;
      if (!step) return;
      // 来路：让弹窗标题写得出「任务卡 · 节点名」，关掉之后也知道该刷哪条流程
      const fromFlow = { runId: v.id, templateId: v.templateId ?? null, runTitle: v.title, nodeName: step.nodeName };
      if (step.projectTaskId) {
        return openTaskCardDialog(step.projectTaskId, { fromFlow }).catch((e) => toast(e.message, 'error'));
      }
      if (step.canOpenTaskCard) {
        el.disabled = true;
        try {
          const d = await api(
            `/api/workflows/runs/${encodeURIComponent(v.id)}/tasks/${encodeURIComponent(taskId)}/card`,
            { method: 'POST' },
          );
          if (d?.task?.id) return await openTaskCardDialog(d.task.id, { fromFlow });
          throw new Error('没拿到卡');
        } catch (e) {
          toast(`开不了卡：${e.message}`, 'error');
        } finally {
          el.disabled = false;
        }
        return;
      }
      openNodeChat(v.id, taskId).catch((e) => toast(e.message, 'error'));
    };
  });
  /*
   * 产物：文件 → 复制路径（贴进编辑器或终端就是"打开"）；链接 → 新窗口。
   * 同样用 onclick 覆盖式接线（这个函数会被增量更新重复调用，见上面那条注释）。
   */
  view.querySelectorAll('[data-art-copy]').forEach((el) => {
    el.onclick = async () => {
      try {
        await navigator.clipboard.writeText(el.dataset.artCopy);
        hint('路径已复制');
      } catch {
        hint(`复制不了，手动选中：${el.dataset.artCopy}`);
      }
    };
  });
  view.querySelectorAll('[data-art-open]').forEach((el) => {
    el.onclick = () => window.open(el.dataset.artOpen, '_blank', 'noopener');
  });
  /*
   * 当前这一步的**状态**和**经办人**：两行本身就是入口（点一下弹选项）。
   * 这原来在右侧栏的任务卡里，任务卡撤了之后接线搬到这儿 —— 逻辑没变，变的是位置。
   *
   * 「经办人」选人即执行：服务端的 assign 是"改完直接派活"，所以有人时等于把这一步
   * 打回「待办」重派 —— 二次确认必须说清楚这件事。
   * 取消确认时要把下拉上的文字**拨回去**（createCombo 在回调前就改了按钮文字），
   * 不然界面上会留着一个"看起来改了、其实没改"的值。
   */
  const cur = (v.tasks ?? [])[v.tasks.length - 1] ?? null;
  const alive = v.status === '进行中';
  const assignMount = view.querySelector('#runAssigneeMount');
  if (assignMount && cur) {
    let assignCombo = null;
    const backTo = cur.assigneePersonaId ?? '';
    assignCombo = createCombo({
      mount: assignMount,
      items: (S.personas ?? []).map((p) => ({ id: p.id, label: personLabel(p) })),
      value: backTo,
      blank: '没人',
      // 人多了就得能搜 —— 用词跟流程设计里那个人选下拉（mountAssigneePicker）保持一致
      search: true,
      placeholder: '搜名字…',
      empty: '没有匹配的人',
      onChange: async (id) => {
        if (!id || id === backTo) return; // 点回原来那个人：什么都没变，别白派一次
        const who = (S.personas ?? []).find((p) => p.id === id)?.name ?? '这个人';
        const ask = cur.assigneeName
          ? `把「${cur.nodeName}」从「${cur.assigneeName}」改派给「${who}」？\n\n这一步会回到「待办」并马上派活（他正忙就 30 秒内自动再试）。`
          : `把「${cur.nodeName}」指派给「${who}」？\n\n会立刻派活。`;
        if (!(await confirmDo(ask))) return assignCombo.setValue(backTo);
        try {
          await api(`/api/workflows/runs/${encodeURIComponent(v.id)}/assign`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ personaId: id }),
          });
          await paintRun(v.id);
        } catch (e) {
          toast(e.message, 'error');
          assignCombo.setValue(backTo);
        }
      },
    });
  }
  /*
   * 「状态」那个字**就是**改状态的入口：点它弹出选项，选完立刻改。
   * 能改哪几个由服务端给（v.statusChoices），前端不自己判断 —— 状态只有一个定义处。
   * value 传**当前状态**：它不在选项里，所以按钮显示的是"现在的状态"、列表里也不会出现它，
   * 一眼就知道"点这儿能改"而不是"这里已经选好了"。
   */
  const statusMount = view.querySelector('#runStatusMount');
  if (statusMount && cur) {
    let statusCombo = null;
    statusCombo = createCombo({
      mount: statusMount,
      items: (v.statusChoices ?? []).map((s) => ({ id: s, label: s })),
      value: cur.status,
      search: false,
      placeholder: '选一个',
      // 这枚状态就贴在页面右边：浮层要**往左展开**，否则顶出视口（用户 2026-10-17 实报）
      right: true,
      onChange: async (picked) => {
        if (!picked) return;
        const hint = {
          待办: '回到「待办」：这一步的往来和执行痕迹会清掉，之后可以重新派活。确定吗？',
          已阻塞: '标成「已阻塞」：停下等人处理，不会再派活。确定吗？',
          已完成: '标成「已完成」：等于「通过」，会按通过出口走到下一步。确定吗？',
        }[picked];
        if (hint && !(await confirmDo(hint))) return statusCombo.setValue(cur.status);
        try {
          await api(`/api/workflows/runs/${encodeURIComponent(v.id)}/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: picked }),
          });
          await paintRun(v.id);
        } catch (e) {
          toast(e.message, 'error');
          statusCombo.setValue(cur.status);
        }
      },
    });
  }
  /*
   * 「继续一次」：这一步被**额度**拦下了，你明确知道要超支，放它过去。
   *
   * 走的是同一个派活接口（/start），只多带一个 force —— 闸在服务端，这里不是绕过它，
   * 是跟它说清楚"这次是我拍的板"。注意**不能走 retry**：retry 会先把这一步改回「待办」，
   * 于是派活时又撞一次额度闸、又写一遍同样的备注（那颗按钮在这会儿是空转）。
   */
  const forceBtn = view.querySelector('[data-run-force]');
  if (forceBtn) {
    forceBtn.onclick = async () => {
      forceBtn.disabled = true;
      try {
        await api(`/api/workflows/runs/${encodeURIComponent(v.id)}/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force: true }),
        });
        await paintRun(v.id);
      } catch (e) {
        toast(e.message, 'error');
        forceBtn.disabled = false;
      }
    };
  }
  // 收起这一栏
  const ncClose = view.querySelector('[data-nc-close]');
  if (ncClose) ncClose.onclick = closeNodeChat;
  // （原来这里还有一颗 [data-run-again]「按同一个流程重新发起」—— 已删，
  //   理由见 runHTML 里 endedHint 那段注释：它跟左栏的「＋」是同一个调用。）
  // 删除这条流程记录（**只删流程，不动各经办人的会话**）
  const del = view.querySelector('[data-run-del]');
  if (del) del.onclick = async () => {
    if (!(await confirmDo(`删掉「${v.title}」这条流程记录？\n\n各经办人的对话不会被删。`))) return;
    try {
      await api('/api/workflows/runs/' + encodeURIComponent(v.id), { method: 'DELETE' });
      S.flowRuns = (S.flowRuns ?? []).filter((r) => r.id !== v.id);
      if (S.flowRunId === v.id) S.flowRunId = null;
      if (S.flowRun?.id === v.id) S.flowRun = null;
      closeNodeChat();
      openFlowRun(v.templateId).catch((e) => toast(e.message, 'error')); // 回到发起记录页
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  // （那枚推拉列表面板的按钮 2026-10-19 撤了 —— 接线跟着删，见 runHTML 里的说明）
  // 「指派」「改状态」现在都长在时间轴"当前这一步"那一行里 —— 任务卡已撤；
  // 「重跑」也删了（改状态成「待办」就是重跑）。行内只剩：通过 / 驳回（快乐路径）。
  view.querySelectorAll('[data-run-decide]').forEach((el) => {
    el.onclick = async () => {
      const decision = el.dataset.runDecide;
      if (decision === '驳回' && !(await confirmDo(`驳回「${v.nodeName}」？\n\n会回到「${v.outlets?.rejectTo ?? '—'}」，那一步要重做。`))) return;
      if (decision === '终止' && !(await confirmDo(`终止「${v.title}」这条流程？\n\n已经办完的步骤保留，后面的不再推进。`))) return;
      el.disabled = true;
      try {
        await api(`/api/workflows/runs/${encodeURIComponent(v.id)}/decide`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision }),
        });
        await paintRun(v.id);
      } catch (e) {
        toast(e.message, 'error');
        el.disabled = false;
      }
    };
  });
}

/* ------------------------------------------------- 节点栏（页面里的第二栏） */

/**
 * 点那一步的对话图标 → 右边**多出一栏**（不是浮层）。
 *
 * 为什么是"栏"不是"弹窗/抽屉"：
 *   · 浮层要么盖住时间轴，要么把左边挤窄还空一大块 —— 两栏各占各的才对
 *   · 左边看走到哪了，右边谈事，宽度各得其所
 *   · 范围锚定在这个节点（发起人 ↔ 这一步的经办人）
 *
 * 这一栏**只有对话**了：原来还有个「任务卡」标签（这一步的记录 + 收拾类操作），
 * 那些内容全搬进了时间轴上那一步的行里 —— 状态/经办人点一下就改、时间与耗时在属性行。
 * 为读一份记录专门开个面板，不值当。
 */
let ncTimer = null;
let ncCtx = null; // { runId, taskId }
// 这一步正在跑的那次运行（停止按钮要用）。跟 ncCtx 无关 —— 没开对话栏时也要能停。
let ncRunningId = null;
let ncStream = null; // 这一步正在跑的那次运行的实时流（app.js 里共用的 streamRun）

/** 亮/灭「正在输入中」——**仿微信**：做成左边一个气泡（三个点依次跳），
 *  不是顶栏上的一行字。列表每次重画就被冲掉，所以这里每次重新插。 */
function setTyping(on) {
  // 他在办 → 发送键变成 DSH 那颗「停止生成」（方块）
  const send = $('ncSend');
  if (send) {
    send.innerHTML = on
      ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>'
      : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V6" /><path d="M6 12l6-6 6 6" /></svg>';
    send.title = on ? '停止生成' : '发送';
    send.setAttribute('aria-label', on ? '停止生成' : '发送');
    send.classList.toggle('stopping', !!on);
  }
  const box = $('ncMsgs');
  if (!box) return;
  box.querySelector('.nc-typing-row')?.remove();
  if (!on) return;
  box.insertAdjacentHTML(
    'beforeend',
    '<div class="nc-msg them nc-typing-row"><div class="nc-text"><i></i><i></i><i></i></div></div>',
  );
  box.scrollTop = box.scrollHeight;
}

/** 停止生成：掐掉这一步正在跑的那次运行（跟 DSH 那颗方块按钮一个意思） */
async function stopNodeRun() {
  const id = ncRunningId;
  if (!id) return;
  // **先让界面立刻停下来**（点完就见效，不等后端回调）
  setTyping(false);
  ncRunningId = null;
  try {
    await api(`/api/runs/${encodeURIComponent(id)}/abort`, { method: 'POST' });
  } catch (e) {
    toast(e.message, 'error');
  }
  // 再按真实状态刷新一次（跑完的钩子会把这一步收尾）
  if (ncCtx) await refreshNodeChat().catch(() => {});
}

/** 收流：把流式气泡换成库里那份（落库的是完整消息，避免留半截） */
function closeNodeStream() {
  ncStream?.close();
  ncStream = null;
  setTyping(false);
  if (ncCtx) refreshNodeChat().catch(() => {});
}

/**
 * 订阅这一步的实时输出 —— **复用 app.js 里的 streamRun**，
 * 跟消息模块是同一套（同一个端点、同一份收尾逻辑）。
 *
 * 为什么不能靠轮询：李俊回复时流程里的任务状态还是「待确认」（状态只在推进时变），
 * 按任务状态决定要不要轮询的话根本不会轮询，于是"要刷新页面才看到回复"（踩过）。
 */
function openNodeStream(runId) {
  if (ncStream || !runId) return;
  setTyping(true);
  ncStream = streamRun(runId, {
    onText: (chunk) => {
      const box = $('ncMsgs');
      if (!box) return;
      // 事件是分块推的：每块追加一个气泡（跟消息模块一样），不自己攒
      const el = document.createElement('div');
      el.className = 'nc-msg them';
      el.innerHTML = `<span class="nc-who">…</span><div class="nc-text">${renderMarkdown(chunk)}</div>`;
      box.append(el);
      box.scrollTop = box.scrollHeight;
    },
    onRunError: (msg) => {
      const box = $('ncMsgs');
      if (box) box.insertAdjacentHTML('beforeend', `<div class="nc-msg them"><div class="nc-text">· ${esc(msg)}</div></div>`);
    },
    onDone: () => closeNodeStream(),
    onReconnect: () => {
      if (ncCtx) refreshNodeChat().catch(() => {});
    },
  });
}

async function openNodeChat(runId, taskId) {
  ncCtx = { runId, taskId };
  const col = $('ncCol');
  if (col) col.classList.remove('is-hidden');
  await refreshNodeChat();
}


function closeNodeChat() {
  ncCtx = null;
  clearTimeout(ncTimer);
  $('ncCol')?.classList.add('is-hidden');
  // 关掉之后左边恢复全宽
  if (S.flowRunId) paintRun(S.flowRunId).catch(() => {});
}

async function refreshNodeChat() {
  if (!ncCtx) return;
  const v = await api('/api/workflows/runs/' + encodeURIComponent(ncCtx.runId));
  const last = (v.tasks ?? []).at(-1) ?? null;
  const t = (v.tasks ?? []).find((x) => x.id === ncCtx.taskId) ?? last;
  if (!t) return;
  ncCtx.taskId = t.id;
  const title = $('ncTitle');
  if (title) title.textContent = `${t.nodeName} · ${t.assigneeName ?? '没人'}`;
  const input = $('ncInput');
  if (input) input.placeholder = t.runningRunId ? '他正在办…也可以再补一句' : '说点什么…';
  // 打开时他正好在跑（比如你刚发完就切走了）→ 接上那条实时流，别等刷新
  if (t.runningRunId) openNodeStream(t.runningRunId);

  const box = $('ncMsgs');
  if (box) {
    const msgs = t.messages ?? [];
    box.innerHTML = msgs.length
      ? msgs
          .map(
            (m) => `<div class="nc-msg ${m.role === 'user' ? 'me' : 'them'}">
              <span class="nc-who">${esc(m.who)}</span>
              <div class="nc-text">${renderMarkdown(m.text)}</div>
            </div>`,
          )
          .join('')
      : '<div class="nc-empty">还没聊过。说一句，他就开始办</div>';
    box.scrollTop = box.scrollHeight; // 新消息在下面
  }
  // **必须放在列表重画之后**（重画会把它冲掉）——「正在输入中」看的是
  // 这次会话有没有在跑，不是任务状态
  setTyping(!!t.runningRunId);
  // ⚠️ 记下"在跑的那次运行"：停止按钮要用它。
  //    以前这里判断的是 ncCtx?.runningRunId，而 ncCtx 是右侧对话栏打开时才建的 ——
  //    按钮在没开对话栏时就点不动（掉进 sendNodeChat，输入框空，什么都不发生）。
  ncRunningId = t.runningRunId ?? null;
  renderNcPerm(t);
  // 收尾靠 SSE 的 __done（见 closeNodeStream），不再按任务状态定时轮询 ——
  // 那样的条件在"他正回复"时是假的，等于不刷新（踩过）
}

function renderNcPerm(t) {
  const mount = $('ncPermMount');
  if (!mount) return;
  mount.innerHTML = '';
  if (!t.conversationId) return; // 还没派活，没有会话可设
  const p = S.personas.find((x) => x.id === t.assigneePersonaId);
  const rt = S.runtimes.find((x) => x.id === (p?.runtime ?? t.runtime)) ?? null;
  convPermCombo({
    mount,
    conversationId: t.conversationId,
    runtime: rt,
    value: t.conversationSandbox, // 会话上的覆盖值（null = 跟随员工）
    personaSandbox: p?.sandbox ?? t.runtime,
    onDone: () => refreshNodeChat(),
  });
}

async function sendNodeChat() {
  // **每一步失败都要说出来** —— 之前几处是静默 return，
  // 点了没反应又没有任何提示，只能靠猜（排查了很久）
  if (!ncCtx) return hint('对话栏没打开？关掉重开一次');
  const input = $('ncInput');
  if (!input) return hint('找不到输入框，刷新一下');
  const text = input.value.trim();
  if (!text) return hint('先写点什么');

  const v = await api('/api/workflows/runs/' + encodeURIComponent(ncCtx.runId));
  const t = (v.tasks ?? []).find((x) => x.id === ncCtx.taskId) ?? (v.tasks ?? []).at(-1);
  if (!t?.conversationId) return hint(`「${t?.nodeName ?? '这一步'}」还没有会话，先派活`);

  input.disabled = true;
  try {
    // 走的是发消息那条路：runId 带上，平台就知道这轮属于哪条流程的哪一步（一步多轮）
    const res = await api('/api/conversations/' + encodeURIComponent(t.conversationId) + '/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, runId: ncCtx.runId, taskId: ncCtx.taskId }),
    });
    input.value = '';
    // **马上接上实时流**（跟消息模块一样），不等轮询 —— 他边说你边看
    openNodeStream(res?.runId);
    await refreshNodeChat();
    if (S.flowRunId) paintRun(S.flowRunId).catch(() => {}); // 左边时间轴跟着变
  } catch (e) {
    // 400/409 的原因要原样说出来（比如"他还在跑上一条"）
    hint(`没发出去：${e.message}`);
  } finally {
    input.disabled = false;
    input.focus();
  }
}

/** 一句话提示，几秒后自己消失（沿用现有那条 hint） */
function hint(text) {
  const el = $('hint');
  if (!el) return;
  el.textContent = text;
  el.classList.remove('is-hidden');
  setTimeout(() => {
    if (el.textContent === text) {
      el.textContent = '';
      el.classList.add('is-hidden');
    }
  }, 4000);
}
/* ---------------------------------------------------------- 流程设计器（纵向） */

/**
 * 纵向顺序设计器：**结构就是顺序**，不用拖节点、不用拉线。
 *
 * 上一版做的是自由画布（拖位置 + 从端口拉线），难用：端口小、落点要准、
 * 还得自己想清楚谁连谁。而 OA 审批流的真相是：
 *   · 「通过 → 下一步」**本来就是顺序**，不需要连
 *   · 只有「驳回去哪」是**真正要配**的东西（回某节点 / 结束 / 不驳回）
 *
 * 所以：节点按数组顺序从上到下排，中间一个「＋」插入，每张卡上配驳回目标。
 * 保存时**把顺序翻译成连线**（approve = 下一个节点），引擎那边完全不用改。
 */

async function openDesigner(templateId = null) {
  setRoute('designer', { template: templateId ?? null });
  const id = templateId || S.designerId || S.flowTemplates[0]?.id;
  if (!id) return toast('还没有流程模板');
  let tpl;
  try {
    tpl = await api('/api/workflows/templates/' + encodeURIComponent(id));
  } catch (e) {
    return toast(e.message, 'error');
  }
  S.designerId = id;
  S.designerOpen = id;
  S.designerName = tpl.name;
  S.designerPublished = !!tpl.publishedAt; // 发布状态：按钮上要显示"发布"还是"下架"
  S.designerDraft = tpl.nodes.map((n) => ({ ...n }));
  S.designerSel = S.designerDraft[0]?.id ?? null;
  S.designerRestored = false;
  // 面板收起状态记在本地：收起来专心排流程，下次进来还是收着的
  try { S.dzPanelCollapsed = localStorage.getItem(PANEL_KEY) === '1'; } catch { S.dzPanelCollapsed = false; }

  // 上次没保存的草稿：画到一半手滑关了页面，不该白干。
  // **但只有真和模板不一样才算"没保存的改动"** —— 每次重画都会存草稿，
  // 只打开看一眼就退出的话，草稿和模板一模一样，再提示"已恢复"就是假报警。
  const draft = readDraft();
  if (draft && draft.templateId === id && !sameNodes(draft.nodes, tpl.nodes)) {
    S.designerDraft = draft.nodes;
    S.designerName = draft.name ?? S.designerName;
    S.designerSel = S.designerDraft[0]?.id ?? null;
    S.designerRestored = true;
    S.designerDraftAt = draft.savedAt ?? null;
  } else if (draft) {
    clearDraft(); // 和模板一样 → 留着没意义，还会下次误报
  }

  // 左栏顶上：工作台 › 流程编排（当前流程名在页头那个输入框里，不再往面包屑里塞第三段）
  setListTitle([{ label: '工作台', to: 'workbench' }, { label: '流程编排' }]);
  renderFlowList();
  paintDesigner();
}

/* ------------------------------------------- 设计器草稿（防意外关闭） */

const DRAFT_KEY = 'bandi.designerDraft';
const PANEL_KEY = 'bandi.dzPanelCollapsed'; // 属性面板收起状态
function readDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    return d && Array.isArray(d.nodes) && d.nodes.length ? d : null;
  } catch {
    return null;
  }
}
function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* 写不了就算了 */ }
}
/** 两份节点是不是一回事（顺序也算在内 —— 挪位置就是改动） */
function sameNodes(a, b) {
  const norm = (x) => JSON.stringify((x ?? []).map((n) => ({ ...n })));
  return norm(a) === norm(b);
}

/** 「3 分钟前」这种说法，比一串 ISO 时间好读 */
function whenText(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}
let draftTimer = null;
function scheduleDraftSave() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    if (!S.designerId) return;
    try {
      localStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({ templateId: S.designerId, name: S.designerName, nodes: S.designerDraft, savedAt: new Date().toISOString() }),
      );
    } catch { /* 隐私模式下写不了就算了 */ }
  }, 400);
}

/**
 * 把「顺序」翻译成连线：每个节点 approve = 下一个；最后一个 approve = 结束。
 * **驳回不动** —— 那是人配的。
 *
 * 这么做是为了引擎不用改：它照旧按边跳转，只是边的来源从"手工拉"变成"顺序推导"。
 */
function rewire() {
  const nodes = S.designerDraft ?? [];
  nodes.forEach((n, i) => {
    n.approve = i + 1 < nodes.length ? nodes[i + 1].id : 'end';
  });
}
function nodeOf(id) {
  return (S.designerDraft ?? []).find((n) => n.id === id) ?? null;
}

/**
 * 「谁来办」显示成什么：
 *   · 点名了人 → 人名
 *   · 没点名 → `未指定`（这一步到站就阻塞，等人指派；**不按技能顶人**）
 *
 * 节点上不再有"技能"这一维：技能是员工身上的能力，不是流程的路由键。
 * 而且不是每个节点都有对应技能 —— 所以这里连提示都不显示。
 */
function assigneeLabel(n, bare = false) {
  if (!n) return '';
  if (n.personaId) {
    const p = (S.personas ?? []).find((x) => x.id === n.personaId);
    return p ? p.name : bare ? '' : '（点名的人不在了）';
  }
  return bare ? '' : '未指定';
}

/**
 * 「谁来办」用**现成的 createCombo**（带搜索、键盘上下键、✓ 标记、点外面收起）。
 * 我第一版自己手写了个 input+list —— app 里本来就有这个组件，重复造一个既费代码
 * 又少掉键盘操作。
 *
 * **只选人，不按技能顶人**（用户 2026-10-14 定）：值就是 `personaId`，
 * 既不拿"技能解析出来的人"预填，也不从技能反推候选。
 * 没选 = 这一步故意留空，到站即「已阻塞」，等人来指派。
 */
function mountAssigneePicker(view, sel) {
  const mount = view.querySelector('[data-vd-pick-mount]');
  if (!mount) return;
  createCombo({
    mount,
    search: true,
    placeholder: '搜名字…',
    empty: '没有匹配的人',
    value: sel.personaId || '',
    items: [{ id: '', label: '不指定' }].concat((S.personas ?? []).map((p) => ({ id: p.id, label: personLabel(p) }))),
    onChange: (id) => {
      const n = nodeOf(S.designerSel);
      if (!n) return;
      n.personaId = id || '';
      paintDesigner();
    },
  });
}

function paintDesigner() {
  const nodes = S.designerDraft ?? [];
  const sel = nodeOf(S.designerSel);

  const rejectOpts = (v) =>
    ['<option value="">（不驳回）</option>', `<option value="end"${v === 'end' ? ' selected' : ''}>结束流程</option>`]
      .concat(
        nodes
          .filter((n) => n.id !== sel?.id)
          .map(
            (n) =>
              `<option value="${esc(n.id)}"${v === n.id ? ' selected' : ''}>回到「${esc(n.name || n.id)}」</option>`,
          ),
      )
      .join('');

  // 节点之间那段：**一条竖线 ＋ 骑在线上的「＋」**
  // 原来是"＋ 和线放在节点之前"，结果最后一个节点和「结束」之间是断的。
  const seg = (idx, hint) =>
    `<div class="vd-seg"><button class="vd-plus" data-vd-add="${idx}" title="${hint}">＋</button></div>`;

  const card = (n, i) => {
    const back = n.reject === 'end' ? '驳回到结束' : n.reject ? `驳回 →「${nodeOf(n.reject)?.name ?? n.reject}」` : '不可驳回';
    const bad = n.reject && n.reject !== 'end' && !nodeOf(n.reject);
    return `
      <div class="vd-node${n.id === S.designerSel ? ' sel' : ''}" data-vd-node="${esc(n.id)}">
        <div class="vd-head">
          <span class="vd-n">${i + 1}</span>
          <b>${esc(n.name || '(未命名)')}</b>
          ${/* 勾了「需要人工确认完成」的节点在这里挂个标签 ——
                一眼看出"这一跑完会停下来等人"，不用逐个点开属性面板去看。
                样式用现成的 .tag-inline（跟「已挂载」「群助手」同一套药丸）。 */ ''}
          ${n.manual ? '<em class="tag-inline" title="办完停住，等你确认才往下走">需人工确认</em>' : ''}
          ${bad ? '<span class="vd-bad" title="驳回目标不存在">!</span>' : ''}
          <button class="mini" data-vd-del="${esc(n.id)}" title="删掉这个节点">×</button>
        </div>
        <div class="vd-sub">${esc(assigneeLabel(n))} · ${esc(back)}</div>
      </div>`;
  };

  // 开始 ─⊕─ 节点1 ─⊕─ 节点2 … ─⊕─ 结束：每两个东西之间都有一段
  const chain = [seg(0, '在最前面插一个节点')]
    .concat(nodes.map((n, i) => card(n, i) + seg(i + 1, `插到「${n.name || n.id}」后面`)))
    .join('');

  $('flowView').innerHTML = `
    ${headRow(
      // 面包屑「工作台 › 流程编排」在**左栏顶上**（2026-10-19 用户要求挪过去），页头这边
      // 只留当前这一项：流程名。**看上去是标题、点上去能改**（不要输入框的样子，见 #dzName 的样式），
      // 再写一遍名字等于同一个东西三处各写一次。
      `<input id="dzName" value="${esc(S.designerName ?? '')}" placeholder="流程名字" spellcheck="false" title="点一下改流程名" />`,
      `<button data-vd-publish>${S.designerPublished ? '已发布 · 下架' : '发布到工作台'}</button>
       <button class="primary" data-vd-save>保存</button>`,
    )}
    <div class="detail-body dz-wrap">
      ${
        S.designerRestored
          ? `<div class="flow-alert warn">
               <b>上次改到一半没保存</b>，已恢复到当时的样子${
                 S.designerDraftAt ? `（${esc(whenText(S.designerDraftAt))}）` : ''
               }—— 看一眼对不对，不对就丢弃
               <button class="btn-sm" style="margin-left:auto" data-dz-drop>丢弃，用模板里的</button>
             </div>`
          : ''
      }
      <div class="dz-body${S.dzPanelCollapsed ? ' collapsed' : ''}" id="dzBody">
        <div class="vd-canvas">
          <div class="vd-start">开始</div>
          ${nodes.length ? chain : `${seg(0, '加第一个节点')}<div class="wip" style="padding:8px 0">还没有节点，点上面的「＋」加一个</div>`}
          <div class="vd-end">结束</div>
        </div>
        <button class="dz-toggle" data-vd-toggle
                title="${S.dzPanelCollapsed ? '展开属性面板' : '收起属性面板'}">${S.dzPanelCollapsed ? '«' : '»'}</button>
        <div class="dz-panel">
          ${
            sel
              ? `<div class="dz-panel-head">节点 ${nodes.findIndex((n) => n.id === sel.id) + 1}</div>
                 <label>名字</label><input data-vd-f="name" value="${esc(sel.name ?? '')}" />
                 <label>谁来办</label>
                 <div data-vd-pick-mount></div>
                 <label>这一步要干什么</label>
                 ${/* 高度 80 → 150（2026-10-19 用户截图要求）：这段是**干活的要求**，
                       正常要写五六行（目标/边界/验收/产出），80px 只露三行，写的时候一大半在框外面，
                       得一边写一边滚。150 约八行，一个节点写清楚不用滚。
                       仍然可拖（resize 是 textarea 默认行为，没关掉）。 */ ''}
                 <textarea data-vd-f="detail" style="height:150px">${esc(sel.detail ?? '')}</textarea>
                 <label>不通过时去哪</label>
                 <select data-vd-f="reject">${rejectOpts(sel.reject)}</select>
                 <!-- 流转开关：默认"做完自动往下走"；打开则停在这儿等人表态 -->
                 <label class="vd-switch">
                   <input type="checkbox" id="vdManual" ${sel.manual ? 'checked' : ''} />
                   <span>需要人工确认完成</span>
                 </label>
                 ${/* 描述就一句（用户给的原文）。不再补"当前：…"—— 开关勾没勾本身就说明了状态。 */ ''}
                 <div class="vd-switch-hint">多用于人机多轮交互，由人工控制是否完成该节点任务。</div>
                 <div class="dz-panel-acts">
                   <button class="danger" data-vd-del="${esc(sel.id)}">删掉这个节点</button>
                 </div>`
              : '<div class="wip">点左边一个节点开始改</div>'
          }
        </div>
      </div>
      <div class="hint" style="margin-top:10px">改动只影响以后新起的流程；在跑的实例用的是起跑那一刻拷下来的节点。</div>
    </div>`;
  S.view = 'flow';
  showView('flow');
  wireDesigner();
  scheduleDraftSave();
}

function wireDesigner() {
  const view = $('flowView');

  /* 流程名：**看上去是标题、点上去就能改**（输入框的边框/底色在 #dzName 里抹掉了）。
     宽度跟着字数走 —— 它是个标题，不该有一块固定宽的透明点击区伸到右边空白里。
     汉字约 1em 宽：最短 6em（够放 placeholder），最长 26em（再长就省略/滚动，别把页头顶爆）。 */
  const dz = view.querySelector('#dzName');
  if (dz) {
    const fitDz = () => {
      const n = Math.min(26, Math.max(6, [...(dz.value || dz.placeholder)].length + 1));
      dz.style.width = n + 'em';
    };
    dz.addEventListener('input', () => {
      fitDz();
      S.designerName = dz.value;
      scheduleDraftSave();
    });
    fitDz();
  }

  view.querySelectorAll('[data-vd-add]').forEach((el) => {
    el.onclick = () => {
      collectDesigner();
      addNodeAt(Number(el.dataset.vdAdd));
    };
  });
  view.querySelectorAll('[data-vd-node]').forEach((el) => {
    el.onclick = (e) => {
      if (e.target.closest('[data-vd-del]')) return;
      if (S.designerSel === el.dataset.vdNode) return;
      collectDesigner();
      S.designerSel = el.dataset.vdNode;
      paintDesigner();
    };
  });
  view.querySelectorAll('[data-vd-del]').forEach((el) => {
    el.onclick = async (e) => {
      e.stopPropagation();
      collectDesigner();
      await removeNode(el.dataset.vdDel);
    };
  });
  view.querySelectorAll('[data-vd-f]').forEach((el) => {
    el.addEventListener('input', () => {
      const n = nodeOf(S.designerSel);
      if (!n) return;
      n[el.dataset.vdF] = el.value;
      if (el.dataset.vdF === 'name') {
        const b = view.querySelector(`[data-vd-node="${n.id}"] b`);
        if (b) b.textContent = el.value || '(未命名)';
      }
      scheduleDraftSave();
    });
    el.addEventListener('change', () => {
      if (el.dataset.vdF === 'reject') paintDesigner(); // 卡片上的说明要跟着变
    });
  });
  // 流转开关：默认"做完自动往下走"，打开则停在这儿等人确认
  const manual = view.querySelector('#vdManual');
  if (manual) {
    manual.onchange = () => {
      const n = nodeOf(S.designerSel);
      if (!n) return;
      n.manual = manual.checked;
      scheduleDraftSave();
      paintDesigner(); // 下面那行说明要跟着变
    };
  }
  view.querySelector('[data-vd-toggle]')?.addEventListener('click', togglePanel);
  if (nodeOf(S.designerSel)) mountAssigneePicker(view, nodeOf(S.designerSel));
  view.querySelector('[data-dz-drop]')?.addEventListener('click', () => {
    clearDraft();
    S.designerRestored = false;
    openDesigner(S.designerId);
  });
  view.querySelector('[data-vd-publish]')?.addEventListener('click', async () => {
    collectDesigner();
    rewire();
    S.designerName = $('dzName')?.value ?? S.designerName;
    const on = !S.designerPublished;
    try {
      // 先存再发布 —— 否则发出去的是上一次的内容，最容易骗人
      await api('/api/workflows/templates/' + encodeURIComponent(S.designerId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: S.designerName, nodes: S.designerDraft, start: S.designerDraft[0]?.id ?? null }),
      });
      await api('/api/workflows/templates/' + encodeURIComponent(S.designerId) + '/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ on }),
      });
      clearDraft();
      S.designerRestored = false;
      await load(); // 工作台那批已发布流程要跟着变
      await openDesigner(S.designerId);
      hint(on ? '已发布 —— 去工作台点开就能起一条' : '已下架，工作台不再显示');
    } catch (e) {
      toast(e.message, 'error');
    }
  });
  view.querySelector('[data-vd-save]')?.addEventListener('click', async () => {
    collectDesigner();
    rewire(); // 顺序 → 连线，存之前翻译一次
    S.designerName = $('dzName')?.value ?? S.designerName;
    try {
      await api('/api/workflows/templates/' + encodeURIComponent(S.designerId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: S.designerName,
          nodes: S.designerDraft,
          start: S.designerDraft[0]?.id ?? null, // 起步点就是第一个，纵向顺序里它是自明的
        }),
      });
      clearDraft();
      S.designerRestored = false;
      S.designerOpen = null;
      await openWorkflows();
      toast('存好了。以后新起的流程用这份。');
    } catch (e) {
      toast(e.message, 'error'); // 存失败<b>不清草稿</b> —— 改动还在本地
    }
  });
}

/** 收起 / 展开右边的属性面板。不整块重画 —— 只切一个类，输入到一半也不会被打断 */
function togglePanel() {
  S.dzPanelCollapsed = !S.dzPanelCollapsed;
  try { localStorage.setItem(PANEL_KEY, S.dzPanelCollapsed ? '1' : '0'); } catch { /* 写不了就算了 */ }
  $('dzBody')?.classList.toggle('collapsed', S.dzPanelCollapsed);
  const btn = $('flowView').querySelector('[data-vd-toggle]');
  if (btn) {
    btn.textContent = S.dzPanelCollapsed ? '«' : '»';
    btn.title = S.dzPanelCollapsed ? '展开属性面板' : '收起属性面板';
  }
}

/** 把面板里输入的值收回草稿（切换节点/插入/保存之前都要先收） */
function collectDesigner() {
  const view = $('flowView');
  if (!view) return;
  const n = nodeOf(S.designerSel);
  if (n) {
    // 流转开关不是 data-vd-f：复选框要读 checked，读 value 只会拿到 "on"
    const m = view.querySelector('#vdManual');
    if (m) n.manual = m.checked;
    view.querySelectorAll('[data-vd-f]').forEach((el) => {
      n[el.dataset.vdF] = el.value;
    });
  }  const named = view.querySelector('#dzName');
  if (named) S.designerName = named.value;
}

/** 在第 index 个位置**插入**一个节点（0 = 插到最前面） */
function addNodeAt(index) {
  const used = new Set((S.designerDraft ?? []).map((n) => n.id));
  let i = S.designerDraft.length + 1;
  while (used.has('n' + i)) i++;
  const node = { id: 'n' + i, name: '新节点 ' + i, detail: '', reject: '' };
  S.designerDraft.splice(Math.max(0, Math.min(index, S.designerDraft.length)), 0, node);
  rewire();
  S.designerSel = node.id;
  paintDesigner();
}

// async：确认框走应用内的 `confirmDo`（原生 confirm 是浏览器弹窗，用户要求不用）
async function removeNode(id) {
  const n = nodeOf(id);
  if (!n) return;
  if (!(await confirmDo(`删掉「${n.name || id}」？`))) return;
  S.designerDraft = S.designerDraft.filter((x) => x.id !== id);
  // 别人驳回指向它的要清掉，否则存的时候报"指向不存在的节点"
  for (const x of S.designerDraft) if (x.reject === id) x.reject = '';
  rewire();
  S.designerSel = S.designerDraft[0]?.id ?? null;
  paintDesigner();
}

/* ---------------------------------------------------------------- 技能 */

async function openSkill(name) {
  setRoute('skill', { name });
  const d = await api('/api/skills/' + encodeURIComponent(name));
  S.skill = d.skill;
  showView('settings'); // 技能现在住在「设置 → 技能」里，主区还是 settingsView
  renderList();
  renderSkillEditor(d.skill, false, d.personas ?? []);
  savePlace();
}

/**
 * 「设置 → 技能」的主区：所有技能铺成卡片。
 *
 * 为什么列表画在**主区**而不是左栏：设置页的左栏固定是分节列表。
 * 要是点「技能」之后把左栏换成技能列表，分节列表就没了 ——
 * 想去别的节只能再点一次左下的齿轮，然后又被 `S.settingsSection` 带回技能，来回绕。
 *
 * 「＋」也在这儿（`#listAction` 那个在设置页是隐藏的，见 setNav）。
 */
/**
 * **手动接入**（2026-10-17）：私有仓库 / 令牌没授权的仓库 / 离线时用。
 *
 * 为什么要它：令牌的 Repository access 没勾的私有仓库**根本不出现在列表里**，
 * 而本地可能早就克隆好了 —— 那就手填 owner/name ＋ 本地目录：
 * 平台只记路径、不联网、不复制代码。
 */
function openGitManualDialog(onDone) {
  const dlg = document.createElement('dialog');
  dlg.id = 'gitManualDlg';
  dlg.innerHTML = `
    <form method="dialog">
      <b>手动接入仓库</b>
      <label>仓库（owner/name）</label>
      <input id="gitManualName" placeholder="例如：shepherd-chenxs/yuku" autocomplete="off" />
      <label>本地目录（这个仓库已存在的克隆）</label>
      <div class="row-with-btn">
        <input id="gitManualPath" placeholder="例如：E:\\repos\\yuku" />
        <button type="button" id="gitManualPick">选择</button>
      </div>
      <div class="counter left">
        用于私有仓库、令牌没授权的仓库、离线场景。平台**只记路径**：不复制代码、不联网查元数据；
        私有状态显示为未知，「同步」需要该仓库在令牌的 Repository access 里。
      </div>
      <div class="dlg-actions">
        <button type="button" value="cancel">取消</button>
        <button class="primary" id="gitManualOk">接入</button>
      </div>
    </form>`;
  document.body.append(dlg);
  wireDialogHead(dlg.querySelector('form'));
  dlg.addEventListener('close', () => dlg.remove());

  $('gitManualPick').onclick = async () => {
    const input = $('gitManualPath');
    const btn = $('gitManualPick');
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const picked = await pickLocalDir({
        title: '选择这个仓库的本地目录',
        startPath: input.value.trim(),
      });
      if (picked) input.value = picked;
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '选择';
    }
  };
  $('gitManualOk').onclick = async (e) => {
    e.preventDefault();
    const fullName = $('gitManualName').value.trim();
    const localPath = $('gitManualPath').value.trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) return toast('仓库写成 owner/name');
    if (!localPath) return toast('本地目录不能空（手动接入必须指向已有的克隆）');
    const btn = $('gitManualOk');
    btn.disabled = true;
    btn.textContent = '接入中…';
    try {
      const r = await api('/api/git/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullName, localPath }),
      });
      dlg.close();
      await onDone();
      toast(`${fullName} 已接入\n${r.repo.localPath}${r.warning ? '\n\n⚠️ ' + r.warning : ''}`);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = '接入';
      toast(err.message, 'error');
    }
  };
  dlg.showModal();
}

/**
 * 接入一个仓库：**克隆一份** 还是 **用本地已有目录**（2026-10-17 用户实报：
 * 本地明明已经有克隆了，点接入又在别处克隆一份，白占盘）。
 *
 * 选"用本地已有目录"时会核对 origin 指向是不是这个仓库 —— 不一致只提示、不拦
 * （fork / 镜像 / 自己改了 remote 都是合理情况）。
 */
function openGitAddDialog(fullName, onDone) {
  const dlg = document.createElement('dialog');
  dlg.id = 'gitAddDlg';
  dlg.innerHTML = `
    <form method="dialog">
      <b>接入 ${esc(fullName)}</b>
      <label class="check"><input type="radio" name="gitMode" value="clone" checked />
        <span>克隆到数据目录<em>——平台自己管一份</em></span></label>
      <label class="check"><input type="radio" name="gitMode" value="local" />
        <span>用本地已有目录<em>——不重复克隆、不占第二份盘</em></span></label>
      <div class="row-with-btn">
        <input id="gitLocalPath" placeholder="例如：E:\\02CodeSpace\\github\\bandi" disabled />
        <button type="button" id="gitLocalPick" disabled>选择</button>
      </div>
      <div class="counter left" id="gitAddHint">克隆位置：数据目录 \\ repos \\ &lt;owner&gt;__&lt;name&gt;</div>
      <div class="dlg-actions">
        <button type="button" value="cancel">取消</button>
        <button class="primary" id="gitAddOk">接入</button>
      </div>
    </form>`;
  document.body.append(dlg);
  wireDialogHead(dlg.querySelector('form'));
  dlg.addEventListener('close', () => dlg.remove());

  const syncMode = () => {
    const local = dlg.querySelector('input[name="gitMode"]:checked')?.value === 'local';
    $('gitLocalPath').disabled = !local;
    $('gitLocalPick').disabled = !local;
    $('gitAddHint').textContent = local
      ? '会用这个目录里现成的克隆；平台只记路径，不复制代码。'
      : '克隆位置：数据目录 / repos / <owner>__<name>';
  };
  dlg.querySelectorAll('input[name="gitMode"]').forEach((r) => (r.onchange = syncMode));
  syncMode();

  $('gitLocalPick').onclick = async () => {
    const input = $('gitLocalPath');
    const btn = $('gitLocalPick');
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const picked = await pickLocalDir({
        title: '选择这个仓库已存在的克隆目录',
        startPath: input.value.trim(),
      });
      if (picked) input.value = picked;
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '选择';
    }
  };

  $('gitAddOk').onclick = async (e) => {
    e.preventDefault();
    const local = dlg.querySelector('input[name="gitMode"]:checked')?.value === 'local';
    const localPath = local ? $('gitLocalPath').value.trim() : '';
    if (local && !localPath) return toast('选了"用本地已有目录"，但路径是空的');
    const btn = $('gitAddOk');
    btn.disabled = true;
    btn.textContent = local ? '接入中…' : '克隆中…';
    try {
      const r = await api('/api/git/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullName, ...(localPath ? { localPath } : {}) }),
      });
      dlg.close();
      await onDone();
      const warn = r.warning ? '\n\n⚠️ ' + r.warning : '';
      toast(`${fullName} 已接入（${r.note}）\n${r.repo.localPath}${warn}`);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = '接入';
      toast(err.message, 'error');
    }
  };
  dlg.showModal();
}

/**
 * 「设置 → 代码托管」（2026-10-17）。
 *
 * 用户：我有很多个 git 仓库 —— 所以这里是一张**仓库清单**：
 *   连接 GitHub（fine-grained PAT）→ 从账号里挑仓库接入（克隆到数据目录）→ 数字员工在那个目录里干活。
 * 项目 / 任务卡引用仓库，不把每个仓库硬变成项目。
 *
 * 加仓库只有一个入口：清单标题上的「＋ 添加仓库」→ 选「从 GitHub 添加」或「手动接入」
 * → 各自开弹窗操作（2026-10-17）。
 *
 * 安全：只回显令牌掩码（头 2 + ****** + 尾 4）；克隆/拉取走请求头带令牌
 * （`.git/config` 里不留带令牌的 URL）。
 */
/* --------------------------------------------- 从 GitHub 挑仓库（放进弹窗里） */
/**
 * 「从 GitHub 添加」：列出**令牌能访问的仓库**，挑一个去接入。
 *
 * 这一段以前是**页面上「从 GitHub 添加」那一整块**（2026-10-17 挪进弹窗的）：
 * 它只在"要加仓库"那一刻才用得上，却常驻在页面底部 —— 平时是噪音，
 * 而且跟上面的「代码仓库」清单是**两处列表**，看着像两个东西。
 * 现在收进「＋ 添加仓库」的菜单里，页面只剩一张清单。
 *
 * `mount` 传进来是给弹窗用的（挂到弹窗的 <form> 里）；传 null 就退回页面上的旧位置。
 *
 * 行是**选中**、不是"点了就接"（2026-10-17 改的）：原来每行一颗「接入」按钮，
 * 点下去立刻开始克隆 —— 在一张几十个仓库的清单里，手一抖点错行就得等它克隆完再删。
 * 现在是"先挑、再确认"：选中哪行，弹窗底部那颗「接入」就作用于哪个。
 */
async function mountGitAvailPicker(mount, onDone, onSelect = null) {
  const box = mount ?? $('gitAvail');
  if (!box) return;
  box.innerHTML = '<div class="sk-blank">拉取中…</div>';

  let available = [];
  try {
    available = (await api('/api/git/available')).repos ?? [];
  } catch (e) {
    box.innerHTML = `<div class="empty" style="padding:12px 4px">拉不到仓库清单：${esc(e.message)}</div>`;
    return;
  }

  /*
   * `selected` 是**当前选中的仓库全名**（不是按钮）：清单会因为搜索被重绘，
   * 选中态放在 DOM 的 class 上会被 `innerHTML =` 冲掉 —— 存成字符串再拿它重画。
   */
  let selected = null;

  const draw = (q = '') => {
    const kw = q.trim().toLowerCase();
    const list = available.filter((r) => !kw || r.fullName.toLowerCase().includes(kw));
    // 选中的那个被搜没了就别再留着（否则底部按钮会作用在一个看不见的仓库上）
    if (selected && !list.some((r) => r.fullName === selected)) selected = null;
    box.innerHTML = list.length
      ? list
          .map(
            (r) => `<div class="sk-row pickable${r.connected ? ' done' : ''}${
              r.fullName === selected ? ' on' : ''
            }" data-git-pick="${esc(r.fullName)}" role="button" tabindex="0">
              <div class="sk-main">
                <b>${esc(r.fullName)}</b>
                ${r.isPrivate ? '<span class="pill">私有</span>' : ''}
                ${r.canWrite === false ? '<span class="pill" title="能克隆，推代码会被拒（token 没给它写权限）">只读</span>' : '<span class="pill" title="能克隆、也能推代码">可写</span>'}
                ${r.connected ? '<span class="pill" title="已经接进来了 —— 在「代码仓库」清单里">已接入</span>' : ''}
                <div class="sk-desc">${esc(r.description || r.language || '')}</div>
              </div>
            </div>`,
          )
          .join('')
      : '<div class="sk-blank">没有匹配的仓库</div>';

    // 已接入的行不参与选择：再接一次只会得到"这个仓库已经接入了"
    box.querySelectorAll('.sk-row.pickable:not(.done)').forEach((el) => {
      const pick = () => {
        selected = el.dataset.gitPick;
        box.querySelectorAll('.sk-row.on').forEach((x) => x.classList.remove('on'));
        el.classList.add('on');
        onSelect?.(selected);
      };
      el.onclick = (e) => {
        e.preventDefault();
        pick();
      };
      el.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          pick();
        }
      };
    });
    onSelect?.(selected);
  };
  draw();
  // 搜索框是清单的**兄弟**节点（弹窗里、页面上都是），所以从公共父节点上找，别用 $('gitFilter')
  const filter = box.parentElement?.querySelector('#gitFilter');
  if (filter) filter.oninput = () => draw(filter.value);
}

/**
 * 「从 GitHub 添加」这个弹窗。
 *
 * 宽到 560px（默认 480）是因为里面是**一张带徽标和两行说明的清单**，
 * 480 会把 owner/name 挤到换行。
 */
async function openGitPickDialog(onDone) {
  const dlg = document.createElement('dialog');
  dlg.id = 'gitPickDlg';
  dlg.style.width = '560px';
  dlg.innerHTML = `
    <form method="dialog">
      <b>从 GitHub 添加</b>
      <div class="counter left" style="margin:8px 0 6px">
        这里列的是**令牌能访问的仓库**：公开仓库总是能读；私有仓库要在令牌的
        Repository access 里选中才会出现。标「只读」的能克隆、推代码会被拒（403）。
      </div>
      <input id="gitFilter" placeholder="搜仓库名…（账号下的仓库，按最近更新排）" style="margin:6px 0" />
      <div id="gitAvail" class="git-avail-box"><div class="sk-blank">拉取中…</div></div>
      <div class="dlg-actions">
        <button type="button" value="cancel">取消</button>
        <button class="primary" type="button" id="gitPickOk" disabled>接入</button>
      </div>
    </form>`;
  document.body.append(dlg);
  wireDialogHead(dlg.querySelector('form'));
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();

  /*
   * 从弹窗里接完一个仓库就**把弹窗一起关掉**回到页面看清单 ——
   * 不停在弹窗里：弹窗里那张列表不会自己重绘，留着会显示"还没接入"的旧状态。
   */
  const done = async () => {
    dlg.close();
    await onDone();
  };

  /*
   * 「接入」只在选中了某行时才可点：没选就点，用户不知道自己要接哪个。
   *
   * ⚠️ 这里**不**做"点完置灰、完了再放开"那一套：`openGitAddDialog` 是
   * `showModal()` 完就返回（真正的活在自己那颗按钮里），`await` 等不到结束 ——
   * 那样写会让它刚弹出就把按钮恢复成可点，底下这层还能再被点一次。
   * 所以干脆一层只管一件事：选好 → 开下一层弹窗；这层的事到这儿就完了。
   */
  let picked = null;
  const okBtn = $('gitPickOk');
  okBtn.onclick = (e) => {
    e.preventDefault();
    if (!picked) return;
    openGitAddDialog(picked, done);
  };

  await mountGitAvailPicker(dlg.querySelector('#gitAvail'), done, (fullName) => {
    picked = fullName;
    // 弹窗可能已经关了（接完一个就关）—— 关了就别再去摸按钮
    if (!dlg.isConnected) return;
    okBtn.disabled = !fullName;
    okBtn.textContent = fullName ? `接入 ${fullName}` : '接入';
  });
}

/* 「怎么拿令牌」—— 一段分步骤的说明，就挂在「GitHub 连接」标题旁那颗「?」上。
 *
 * 为什么只在「?」里、不在输入框下面也贴一份（2026-10-17）：原来表单下面确实贴着一份，
 * 但那等于**同一段话在页面上出现两次**（而且连上之后表单没了、只剩「?」，两处还在时才显得多余）。
 * 「?」在**连上与没连上时都在** —— 而"给下一个仓库补授权""令牌 90 天到期要换"
 * 恰恰是**连着的时候**才要照着做，所以放在「?」里是覆盖面更全的那一处。 */
const GIT_TOKEN_HELP = `
  在 GitHub 建：Settings → Developer settings → Personal access tokens → <b>Fine-grained tokens</b>；
  权限勾 <b>Contents: Read and write</b>（要开 PR 再加 <b>Pull requests: Read and write</b>）；
  Repository access 选你要接入的那几个仓库。令牌只存在本机数据目录，不进日志。
  <a class="help-link" href="https://github.com/settings/personal-access-tokens"
     target="_blank" rel="noreferrer">去 GitHub 建一个 →</a>`;

async function renderGitRepos() {
  const view = $('settingsView');
  showView('settings');
  renderList();
  view.innerHTML = '<div class="empty" style="padding:24px 4px">取代码托管状态…</div>';

  let st;
  try {
    st = await api('/api/git/status');
  } catch (e) {
    view.innerHTML = `<div class="empty" style="padding:24px 4px">取不到：${esc(e.message)}</div>`;
    return;
  }
  const repos = st.repos ?? [];

  /*
   * 连上之后的这一块：跟下面 `tokenForm` **同一行、同一个位置**（左「令牌」标签、
   * 右「输入框 + 按钮」），只是输入框变成只读（只回显后 4 位）、按钮换成「断开连接」、
   * 状态写在输入框下面。
   *
   * 为什么不做成"另一套行"：连上 GitHub 是这块最常见的状态切换，原来换成
   * 「状态：已连接 + 断开连接按钮」两行，整块的高度和样子都变了 —— 用户说的是
   * "连接之后这个区域的变化不要太大"。现在前后只差：输入框能不能编辑、按钮写什么。
   */
  const connectedForm = `
    <div class="form-row top">
      <div class="row-label">令牌</div>
      <div>
        <div class="row-with-btn">
          <input class="locked" value="${esc(st.hint || '******')}" readonly
                 aria-label="已保存的令牌，只显示头 2 位和尾 4 位" />
          <button id="gitDisconnect">断开连接</button>
        </div>
        <div class="counter left"><b style="color:var(--ok)">已连接</b><span id="gitWho">${
          st.login ? ` —— @${esc(st.login)}` : ''
        }</span></div>
      </div>
    </div>`;

  const tokenForm = `
    <div class="form-row top">
      <div class="row-label">令牌</div>
      <div>
        <div class="row-with-btn">
          <input id="gitToken" type="password" placeholder="粘贴 fine-grained PAT（只填一次，之后只显示掩码）" autocomplete="off" />
          <button class="primary" id="gitConnect">连接 GitHub</button>
        </div>
      </div>
    </div>`;

  const repoRow = (r) => `
    <div class="sk-row">
      <div class="sk-main">
        <b>${esc(r.fullName)}</b>
        ${r.isPrivate ? '<span class="pill">私有</span>' : ''}
        <div class="sk-desc">${esc(r.localPath)}${r.lastSyncAt ? ` · 上次同步 ${esc(String(r.lastSyncAt).replace('T', ' ').slice(0, 16))}` : ''}</div>
      </div>
      <button class="mini auto" data-git-project="${esc(r.id)}" title="用这个仓库建一个项目（工作目录就是克隆目录）">建成项目</button>
      <button class="mini auto" data-git-sync="${esc(r.id)}" title="git pull --ff-only">同步</button>
      <button class="mini auto" data-git-remove="${esc(r.id)}" title="只移除记录，本地目录保留">移除</button>
    </div>`;

  view.innerHTML = `
    ${headRow('<b>代码托管</b>')}
    <div class="detail-body">
      <div class="group-title">GitHub 连接<button type="button" class="help-btn" id="gitTokenHelp"
              title="怎么拿到这个令牌？">${ICON_HELP}</button></div>
      <div class="group">
        ${st.connected ? connectedForm : tokenForm}
      </div>

      <div class="group-title">代码仓库 <span class="dim" style="font-weight:400">${repos.length} 个</span>
        <button class="mini auto" id="gitAddRepo" style="float:right;margin-top:-2px"
                title="从 GitHub 挑一个，或手动接一个本地已有的克隆">＋ 添加仓库</button>
      </div>
      <div class="group">
        ${repos.length ? repos.map(repoRow).join('') : '<div class="sk-blank">还没有仓库。点右上角「＋ 添加仓库」：连了 GitHub 就从账号里挑，没连就手动接一个本地已有的克隆。</div>'}
      </div>
    </div>`;

  const refresh = () => renderGitRepos();

  /*
   * 身份**等页面画完再去问**（2026-10-17）。
   *
   * 上面整块已经用本机状态画出来了（令牌掩码、仓库清单、上次记住的账号）——
   * 这里只是把「@login」补上，**不挡任何东西**。
   *
   * 为什么不能挪回 `/api/git/status`：那等于"打开页面 = 等一次 GitHub 响应"，
   * 国内网络下就是用户看到的那几秒空白（用户原话："估计是连 github 的原因，但这个是局部的"）。
   * 所以延迟只留在这一小块里：它回来就补字，回不来也只是少一行字。
   *
   * 只改 `#gitWho` 那一小段文本、**不整个重绘**：重绘会把用户正在粘的令牌冲掉。
   */
  if (st.connected) {
    const paintWho = (text) => {
      const el = $('gitWho');
      if (el?.isConnected) el.textContent = text; // 已经离开这个页面就别再摸它
    };
    api('/api/git/whoami')
      .then((w) => {
        if (w?.login) paintWho(` —— @${w.login}`);
        else if (w?.error) paintWho(' · 连接状态没验上（网络没通）');
      })
      .catch(() => paintWho(' · 连接状态没验上（网络没通）'));
  }

  // 标题旁那颗「?」：点开是"怎么拿令牌"。连上 GitHub 之后表单没了，就靠它看。
  const helpBtn = $('gitTokenHelp');
  if (helpBtn) wireHelpPop(helpBtn, GIT_TOKEN_HELP);

  /*
   * 「＋ 添加仓库」：一个入口，两条路。
   *
   * 为什么合成一个（2026-10-17）：原来是「＋ 手动接入」在清单标题上、
   * 「从 GitHub 添加」是页面底部**另一整块**。两条路分在两处，人得先想
   * "我现在该点哪个"；而那条从 GitHub 挑的清单常驻在底部，只在要加仓库那一刻才用得上。
   * 现在：点＋ → 选「手动接入」或「从 GitHub 添加」→ 各自开一个弹窗操作。
   */
  $('gitAddRepo')?.addEventListener('click', (e) => {
    e.preventDefault();
    openAddMenu(gitAddRepoItems(refresh), e.currentTarget);
  });
  $('gitConnect')?.addEventListener('click', async (e) => {
    e.preventDefault();
    const token = $('gitToken').value.trim();
    if (!token) return toast('先把令牌粘进来');
    const btn = $('gitConnect');
    btn.disabled = true;
    btn.textContent = '验证中…';
    try {
      const r = await api('/api/git/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      toast(`已连接：@${r.login}`);
      await refresh();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = '连接 GitHub';
      toast(err.message, 'error');
    }
  });
  $('gitDisconnect')?.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!(await confirmDo('断开 GitHub？已接入的仓库记录和本地克隆都保留。'))) return;
    try {
      await api('/api/git/token', { method: 'DELETE' });
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // 已接入仓库的三个动作
  view.querySelectorAll('[data-git-sync]').forEach((el) => {
    el.onclick = async (e) => {
      e.preventDefault();
      el.disabled = true;
      el.textContent = '同步中…';
      try {
        await api(`/api/git/repos/${encodeURIComponent(el.dataset.gitSync)}/sync`, { method: 'POST' });
        await refresh();
      } catch (err) {
        el.disabled = false;
        el.textContent = '同步';
        toast(err.message, 'error');
      }
    };
  });
  view.querySelectorAll('[data-git-remove]').forEach((el) => {
    el.onclick = async (e) => {
      e.preventDefault();
      if (!(await confirmDo('从清单移除这个仓库？（只删记录，本地克隆目录保留，里面可能有你没推的东西）'))) return;
      try {
        const r = await api(`/api/git/repos/${encodeURIComponent(el.dataset.gitRemove)}`, { method: 'DELETE' });
        toast(`已移除。本地目录还在：${r.keptPath}`);
        await refresh();
      } catch (err) {
        toast(err.message, 'error');
      }
    };
  });
  view.querySelectorAll('[data-git-project]').forEach((el) => {
    el.onclick = async (e) => {
      e.preventDefault();
      const repo = repos.find((r) => r.id === el.dataset.gitProject);
      if (!repo) return;
      // 同一个目录已经有项目了就别再建一个（看板上会出现两个一模一样的项目）
      const exist = (S.projects ?? []).find((p) => p.root === repo.localPath);
      if (exist) return toast(`已经有一个项目用这个目录了：「${exist.name}」`);
      // 项目名用 owner/name，免得两个仓库同名
      try {
        const d = await api('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: repo.fullName, root: repo.localPath }),
        });
        await load();
        toast(`项目已建好：${repo.fullName}`);
        if (d.project?.id) await openProjectDetail(d.project.id);
      } catch (err) {
        toast(err.message, 'error');
      }
    };
  });

  // 「从 GitHub 添加」那张清单已经收进弹窗了（openGitPickDialog），页面上不再常驻一块。
}

/* ---------------------------------------------------------------- 定时任务 */

/**
 * 定时任务页（2026-10-17，入口在**工作台** —— 跟项目/任务看板/流程并列）。
 *
 * 以前挂在「设置」里，但它不是"配置"，是"让谁到点去干活"：跟看板同一类东西。
 * 放在设置里还有个副作用 —— 人得先想到"去设置找"，才找得到。
 */
async function openSchedules() {
  setRoute('schedules');
  // 它是工作台里的页面，不是插件也不是某个项目的看板 —— 清掉那几条路，
  // 否则刷新时会被它们抢走（项目列表 / 全局面板各自都有"恢复位置"的优先级）
  S.plugin = null;
  S.projectList = false;
  S.projectId = null;
  S.boardAll = false;
  savePlace();
  $('pluginView').classList.remove('kb-page'); // 列表页按普通长页面滚
  showView('plugin');
  await renderSchedules();
}

/**
 * 定时任务列表。
 *
 * 一屏只回答三个问题：**有哪些任务、多久跑一次、上次跑成没跑成。**
 * 节拍（间隔）与开关都在这张卡上，不在代码里 —— 所以"什么时候巡检 PR"是配置项，不是发版项。
 *
 * 结果那一行必须显示**原话**（成功是结论，失败是原因）：定时任务最怕的就是"它好像没跑"，
 * 而人无从判断。真话写在行上，比藏在日志里强。
 */
async function renderSchedules() {
  const view = $('pluginView');
  view.innerHTML = '<div class="empty" style="padding:24px 4px">读取中…</div>';
  let data;
  try {
    data = await api('/api/schedules');
  } catch (e) {
    view.innerHTML = `<div class="empty" style="padding:24px 4px">取不到：${esc(e.message)}</div>`;
    return;
  }
  const jobs = data.jobs ?? [];
  // 列表里要写清"在哪个项目里干"，得知道项目名（没加载过就补一次，失败不影响列表）
  const projects = (S.projects ?? []).length
    ? S.projects
    : (S.projects = (await api('/api/projects').catch(() => ({ projects: [] }))).projects ?? []);
  const actionOf = (id) => (data.actions ?? []).find((a) => a.id === id);
  const when = (iso) => (iso ? String(iso).replace('T', ' ').slice(0, 16) : '还没跑过');

  const resultOf = (j) => {
    if (!j.lastStatus) return '<span class="dim">还没跑过</span>';
    if (j.lastStatus === 'ok') return `<span style="color:var(--ok)">✓</span> ${esc(j.lastSummary || '完成')}`;
    return `<span style="color:var(--bad)">✗</span> ${esc(j.lastError || '失败了（没有原因）')}`;
  };

  const card = (j) => {
    // 「交给数字员工」这类任务，卡上最该看到的是**它到底要干什么**，不是动作名 ——
    // 五条任务都写着「交给数字员工」等于没写。所以把那句话（和交给谁、在哪个项目里）提到描述行最前面。
    const instr = String(j.config?.instruction ?? '').replace(/\s+/g, ' ').trim();
    const who = j.config?.personaId ? (S.personas ?? []).find((p) => p.id === j.config.personaId)?.name : null;
    // 项目 = 这次派活的工作空间。没选就不写（那时候他用的是自己的默认目录）
    const proj = j.config?.projectId ? (projects ?? []).find((p) => p.id === j.config.projectId)?.name : null;
    const lead = instr
      ? `交给${who ? `「${who}」` : '员工'}${proj ? `（在「${proj}」）` : ''}：${instr.length > 44 ? instr.slice(0, 43) + '…' : instr}`
      : '';
    /* 卡片形态（2026-10-20 用户要求"做成卡片"）：整行横条改成一格一格的卡。
       结构：第一行 名字+状态 → 第二行 要干什么+节拍 → 第三行 上次结果（原话）→ 底部动作。
       margin-top:auto 把动作压到卡底，多张卡并排时按钮齐平。 */
    return `
    <article class="sch-card">
      <div class="sch-card-top">
        <b>${esc(j.name)}</b>
        <span class="pill">${esc(actionOf(j.action)?.label ?? j.action)}</span>
        ${(j.repeat === 'once' && j.lastStatus === 'ok') ? '<span class="pill" style="color:var(--ok)">已完成</span>' : ''}
        ${j.running ? '<span class="pill" style="color:var(--warn)">在跑</span>' : ''}
        <!-- 动作在**右上角**（2026-10-20 用户照参考截图要求）：启停开关在最右，跟名字同一行。
             三颗动作是**图标按钮**（同日用户："这三个改成图标按钮"）：文字版三块边框比任务名还重，
             图标 + 提示就够；删除那颗常态红，危险操作不用 hover 才认得出。
             提示走自建 data-tip（2026-10-20 用户："提示框改成圆角"）：原生 title 的方角改不了，
             aria-label 留着给读屏 —— 两个一起写会冒双重提示 -->
        <div class="sch-acts">
          <button class="sch-ic" data-sch-run="${esc(j.id)}" data-tip="立即执行" aria-label="立即执行">${ICON_PLAY}</button>
          <button class="sch-ic" data-sch-edit="${esc(j.id)}" data-tip="编辑" aria-label="编辑">${ICON_EDIT}</button>
          <button class="sch-ic danger" data-sch-del="${esc(j.id)}" data-tip="删除" aria-label="删除">${ICON_TRASH}</button>
          <!-- 启停是**开关**不是按钮：开关本身就是状态，卡上不再多挂「已停用」胶囊。
               提示**只说当前状态**（2026-10-20 用户定）：写成「点击后怎样」会被读成现状，
               状态 + 动作混在一起也嫌长。点了会怎样，开关本身就是答案 -->
          <label class="switch sm" data-tip="${j.enabled ? '已启用（到点就跑）' : '已停用（到点也不跑）'}">
            <input type="checkbox" data-sch-toggle="${esc(j.id)}" ${j.enabled ? 'checked' : ''} /><span></span>
          </label>
        </div>
      </div>
      ${lead ? `<div class="sch-desc">${esc(lead)}</div>` : ''}
      ${
        /* 结果原话独占一行（2026-10-20 用户："上次执行时间放右下角"）：
           原来时间和结果拼在底行右侧，结果一长整行被占满、时间就吊在中间。
           拆开后底行只剩「节拍（左）+ 上次时间（右）」，两个都短，一行放得下 */
        j.lastStatus ? `<div class="sch-result">${resultOf(j)}</div>` : ''
      }
      <!-- 底行：定时方式在左下角，上次执行时间在**右下角** -->
      <div class="sch-foot">
        <span class="sch-when">${esc(j.text ?? `每 ${j.everyMinutes} 分钟`)}</span>
        <span class="sch-last">${j.lastRunAt ? `上次 ${esc(when(j.lastRunAt))}` : '还没跑过'}</span>
      </div>
    </article>`;
  };

  view.innerHTML = `
    ${headRow(
      breadcrumb([{ label: '工作台', to: 'workbench' }, { label: '定时任务' }]),
      '<button class="primary" id="schNew">＋ 新建任务</button>',
    )}
    <div class="detail-body">
      <div class="group-title">任务 <span class="dim" style="font-weight:400">${jobs.length} 个</span></div>
      ${
        jobs.length
          ? `<div class="sch-grid">${jobs.map(card).join('')}</div>`
          : `<div class="sk-blank">还没有定时任务。最常用的做法是「交给数字员工」：写一句要它干什么、选一个人，
             到点这句话就发进它自己的一条会话里（标题写着任务名，结果在那儿看）。
             另外两个内置动作：「PR / Issue 巡检」—— 去 GitHub 看有没有人提 PR / issue，写成看板上的卡，
             顺手把已合并的收成「待确认」；「数据库备份」—— 把 bandi.db 导出一份到数据目录的 backups/，
             只留最近 N 份。动作是可插拔的，以后加新动作不用改调度核心。</div>`
      }
    </div>`;

  $('schNew')?.addEventListener('click', () => scheduleDialog(null));
  view.querySelectorAll('[data-sch-run]').forEach((el) => {
    el.onclick = async () => {
      const id = el.dataset.schRun;
      if (el.disabled) return; // 按钮变图标后没有「跑中…」文案了，连点两下要自己挡
      el.disabled = true;
      /* 图标按钮没有字可改：在跑的时候让三角换成一圈转的环（.busy 那条 CSS），
         这是「点了、在跑、别急」的唯一可见反馈 —— 少了它，慢任务点下去像没反应 */
      el.classList.add('busy');
      try {
        const r = await api(`/api/schedules/${encodeURIComponent(id)}/run`, { method: 'POST' });
        await renderSchedules(); // 成功就整页重画，busy 态跟着节点一起没了
        toast(r.ok ? `跑完了：${r.summary ?? '完成'}` : `这次没跑成：${r.error ?? '没有原因'}`);
      } catch (e) {
        el.disabled = false;
        el.classList.remove('busy');
        toast(e.message, 'error');
      }
    };
  });
  view.querySelectorAll('[data-sch-edit]').forEach((el) => {
    el.onclick = () => scheduleDialog(jobs.find((j) => j.id === el.dataset.schEdit) ?? null);
  });
  /* 启停开关：点下去就存（不确认），失败要把开关拨回去 —— 否则界面说的和库里存的是两回事 */
  view.querySelectorAll('[data-sch-toggle]').forEach((el) => {
    el.onchange = async () => {
      const j = jobs.find((x) => x.id === el.dataset.schToggle);
      if (!j) return;
      try {
        await api(`/api/schedules/${encodeURIComponent(j.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: el.checked }),
        });
        await renderSchedules();
      } catch (e) {
        el.checked = !el.checked; // 拨回去
        toast(e.message, 'error');
      }
    };
  });
  view.querySelectorAll('[data-sch-del]').forEach((el) => {
    el.onclick = async () => {
      if (!(await confirmDo('删掉这个定时任务？（已经写在看板上的卡不会删）'))) return;
      try {
        await api(`/api/schedules/${encodeURIComponent(el.dataset.schDel)}`, { method: 'DELETE' });
        await renderSchedules();
      } catch (e) {
        toast(e.message, 'error');
      }
    };
  });
}

/**
 * 「重复」右边那块动态字段（对齐 WorkBuddy 定时任务的弹窗）：
 * 不是竖着堆「标签 + 控件」，而是**横排的框** —— 每个框自带前缀（「时间：」「日期：」），
 * 跟原生控件拼在同一个边框里。间隔 → 间隔分钟；单次 → 日期时间；每天 → 时间；
 * 每周/每双周 → 星期 + 时间；每月 → 日期 + 时间；每年 → 月份 + 日期 + 时间。
 */
function schRepeatBody(mode, job, min) {
  /*
   * ⚠️ 用 `<span>` 而不是 `<label>`：这些框里现在装的是 `.combo` 组件，而 label 会把
   * 「框内任意位置」的点击**转发给框里的第一个控件** —— 点下拉里的某一项时，
   * 转发的那一下会把刚收起的浮层又打开一次（看着像"选了又弹回去"）。span 没有这个行为。
   */
  const box = (k, inner) => `<span class="dlg-box"><span class="dlg-box-k">${k}</span>${inner}</span>`;
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(job?.atTime ?? '') ? job.atTime : '09:00';
  const timeBox = box('时间：', `<input id="schAt" type="time" value="${esc(time)}" />`);
  if (mode === 'interval') {
    return box('间隔：', `<input id="schEvery" type="number" min="${min}" step="1" value="${job?.everyMinutes ?? 30}" /><span class="dlg-box-u">分钟</span>`);
  }
  if (mode === 'once') {
    let v = '';
    const ts = Date.parse(job?.runAt ?? '');
    if (Number.isFinite(ts)) {
      const d = new Date(ts);
      const p = (n) => String(n).padStart(2, '0');
      v = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
    }
    /* 原生 datetime-local 换成自建选择器（2026-10-20 用户："跑到弹窗外面了"）：
       那个日历是浏览器画的、位置改不了。值仍走同名 hidden input ——
       保存那段代码（$('schRunAt').value）一行都不用动，取值格式也一样。 */
    return box('时间：', `<input id="schRunAt" type="hidden" value="${esc(v)}" /><span class="dlg-combo" id="schDtMount"></span>`);
  }
  if (mode === 'daily') return timeBox;
  const wd = Number.isInteger(job?.weekday) ? job.weekday : 1;
  if (mode === 'weekly' || mode === 'biweekly') {
    // 下拉只留挂载点，控件由 mountSchRepeatCombos() 装（全站 .combo 公共组件）
    return box('星期：', '<span class="dlg-combo" id="schWdMount"></span>') + timeBox;
  }
  const dom = Number.isInteger(job?.dayOfMonth) ? job.dayOfMonth : 1;
  const domBox = box('日期：', `<input id="schDom" type="number" min="1" max="31" step="1" value="${dom}" /><span class="dlg-box-u">号</span>`);
  if (mode === 'monthly') return domBox + timeBox;
  const mo = Number.isInteger(job?.month) ? job.month : 1;
  const moBox = box('月份：', '<span class="dlg-combo" id="schMoMount"></span>');
  return moBox + domBox + timeBox;
}

/**
 * 重复那一排里的两个下拉（星期 / 月份）—— 同样是 `.combo` 公共组件。
 * 它们在弹窗**最下面**，一律 `up`（往上弹），否则开出来就被窗口底边切掉。
 * 返回 `{ wd, mo }`，读值走它们；当前模式没有的那颗是 null。
 */
function mountSchRepeatCombos(mode, job) {
  const wdMount = $('schWdMount');
  const moMount = $('schMoMount');
  const dtMount = $('schDtMount'); // 「单次」的日期时间（自建选择器，见 createDateTimePick）
  const out = { wd: null, mo: null };
  if (wdMount) {
    const cur = String(Number.isInteger(job?.weekday) ? job.weekday : 1);
    out.wd = createCombo({
      mount: wdMount,
      items: '日一二三四五六'.split('').map((c, i) => ({ id: String(i), label: `星期${c}` })),
      value: cur,
    });
    out.wd.el.classList.add('up');
  }
  if (moMount) {
    const cur = String(Number.isInteger(job?.month) ? job.month : 1);
    out.mo = createCombo({
      mount: moMount,
      items: Array.from({ length: 12 }, (_, i) => ({ id: String(i + 1), label: `${i + 1} 月` })),
      value: cur,
    });
    out.mo.el.classList.add('up');
  }
  if (dtMount) {
    const dt = createDateTimePick({
      mount: dtMount,
      value: $('schRunAt')?.value ?? '',
      // 值写回同名 hidden input —— 保存那段照旧读 $('schRunAt').value，一行不用改
      onChange: (v) => {
        const h = $('schRunAt');
        if (h) h.value = v;
      },
    });
    // 这颗在弹窗右下角：往下开会顶出底边（.up 往上弹）、往左对齐会探出右边（.right 右缘对齐）
    dt.el.classList.add('up', 'right');
  }
  return out;
}

/** 这三种字段是下拉，值由 .combo 组件持有（不是 DOM 里的原生 <select>） */
const SCH_COMBO_TYPES = ['repo', 'project', 'persona'];

/**
 * 照**动作自己声明的字段**渲染参数区 —— 这里不写死任何动作的字段名。
 * 现在支持的字段类型：repo（已接入仓库）/ project（项目）/ persona（数字员工）/ number / text / textarea。
 * 「留空 = 不传这个参数」，由动作自己兜默认值（PR 巡检留空就是"所有仓库、自动对项目"）。
 *
 * 布局照「元舱的新建自动化」（2026-10-17 用户要求）：**左边输入、右边配置** ——
 *   · 左 = 要写的东西：textarea / 单行 text（做什么、名字这一类）；
 *   · 右 = 要选的东西：下拉 / 数字（交给谁、在哪个项目、保留几份这一类）。
 * 所以这里返回 `{ left, right }` 两段 HTML，弹窗把各自塞进左右两栏。
 *
 * 三个下拉只吐一个**挂载点**（`.sch-cfg`）：全站下拉统一用 `.combo` 公共组件
 * （原生 select 的弹出层不可控、也塞不进搜索框），而组件是 DOM 实例，拼不进 HTML 串。
 * 真正的控件由 mountSchConfigCombos() 在写进 DOM 之后装上去。
 */
function schConfigFields(action, cfg) {
  const left = [];
  const right = [];
  for (const f of action?.fields ?? []) {
    const v = cfg?.[f.key];
    const key = esc(f.key);
    if (SCH_COMBO_TYPES.includes(f.type)) {
      // 选人**不给自动兜底**（写「选一个人」再拦必填）：定时派活悄悄落到某个默认员工身上，
      // 比报错难查得多 —— 半夜跑了、那个人不对、结果也没人看。
      // 提示文案动作自己可以改（`hint`）：仓库/项目那种"可留空"的默认说法不一定贴切。
      const hint =
        f.hint != null
          ? esc(f.hint)
          : f.type === 'persona'
            ? ''
            : `（可留空 = ${esc(f.empty ?? (f.type === 'repo' ? '全部' : '自动'))}）`;
      right.push(`<label>${esc(f.label)}${hint}</label><div class="sch-cfg" data-cfg="${key}"></div>`);
      continue;
    }
    if (f.type === 'number') {
      right.push(`<label>${esc(f.label)}</label>
        <div class="dlg-box" style="max-width:none">
          <input data-cfg="${key}" type="number" ${f.min != null ? `min="${f.min}"` : ''} ${f.max != null ? `max="${f.max}"` : ''} step="1" value="${esc(v ?? f.def ?? '')}" />
          ${f.suffix ? `<span class="dlg-box-u">${esc(f.suffix)}</span>` : ''}
        </div>`);
      continue;
    }
    // 自由文字：定时任务的主输入区，放**左边**。rows 由动作自己声明（4 行起，CSS 会再撑高）。
    if (f.type === 'textarea') {
      left.push(`<label>${esc(f.label)}</label>
        <textarea data-cfg="${key}" rows="${Number(f.rows) || 3}" placeholder="${esc(f.placeholder ?? '')}">${esc(v ?? '')}</textarea>`);
      continue;
    }
    left.push(`<label>${esc(f.label)}</label><input data-cfg="${key}" value="${esc(v ?? '')}" />`);
  }
  return { left: left.join(''), right: right.join('') };
}

/**
 * 把参数区里的下拉装成 `.combo`（全站公共组件）。
 * 返回 `Map<字段key, combo>` —— 读值也走这张表：原生控件没了，DOM 上读不到值。
 */
function mountSchConfigCombos(action, cfg, repos, projects, personas) {
  const map = new Map();
  for (const f of action?.fields ?? []) {
    if (!SCH_COMBO_TYPES.includes(f.type)) continue;
    // ⚠️ 只找挂载点 `.sch-cfg`：`[data-cfg]` 也挂在输入框上，直接选会选错元素
    const mount = document.querySelector(`#schFields .sch-cfg[data-cfg="${f.key}"]`);
    if (!mount) continue;
    const items =
      f.type === 'repo'
        ? [{ id: '', label: f.empty ?? '全部' }, ...(repos ?? []).map((r) => ({ id: r.fullName, label: r.fullName }))]
        : f.type === 'project'
          ? [{ id: '', label: f.empty ?? '自动' }, ...(projects ?? []).map((p) => ({ id: p.id, label: p.name }))]
          : [{ id: '', label: f.empty ?? '选一个人' }, ...(personas ?? []).map((p) => ({ id: p.id, label: p.name }))];
    map.set(
      f.key,
      createCombo({
        mount,
        items,
        value: String(cfg?.[f.key] ?? ''),
        // 仓库可能有几十个，给个搜索框；人和项目一般几个，不用
        search: f.type === 'repo' && items.length > 12,
        placeholder: f.type === 'repo' ? '找仓库…' : '搜…',
      }),
    );
  }
  return map;
}

/**
 * 从参数区收集 config：空值不传（让动作用自己的默认），数字字段转成数字。
 * 下拉读 `combos`（组件持有值），其余读 DOM。
 */
function readSchConfig(fields, combos) {
  const out = {};
  for (const f of fields ?? []) {
    if (combos?.has(f.key)) {
      const v = combos.get(f.key).value();
      if (v !== '' && v != null) out[f.key] = v;
      continue;
    }
    const el = document.querySelector(`#schFields [data-cfg="${f.key}"]`);
    if (!el) continue;
    const raw = el.value;
    if (raw === '' || raw == null) continue;
    out[f.key] = f.type === 'number' ? Math.round(Number(raw)) : raw;
  }
  return out;
}

/**
 * 新建 / 编辑一个定时任务。
 *
 * **这个弹窗不认识任何具体动作**：动作清单、名字默认值、参数区全部来自注册表的声明。
 * 所以 PR 巡检的「仓库 / 项目」只是它自己的两个参数，不是弹窗里写死的下拉；
 * 备份动作只有「保留份数」，换个动作这两行就没了。
 */
async function scheduleDialog(job) {
  let meta;
  try {
    meta = await api('/api/schedules');
  } catch (e) {
    return toast(e.message, 'error');
  }
  const repos = (await api('/api/git/repos').catch(() => ({ repos: [] }))).repos ?? [];
  const projects = (S.projects ?? []).length ? S.projects : (S.projects = (await api('/api/projects').catch(() => ({ projects: [] }))).projects ?? []);
  const cfg = job?.config ?? {};
  const min = meta.minMinutes ?? 5;
  const repeat0 = job?.repeat ?? 'interval';
  let curAction = (meta.actions ?? []).find((a) => a.id === (job?.action ?? meta.actions?.[0]?.id)) ?? null;

  const REPEAT_ITEMS = [
    { id: 'interval', label: '间隔' },
    { id: 'once', label: '单次' },
    { id: 'daily', label: '每天' },
    { id: 'weekly', label: '每周' },
    { id: 'biweekly', label: '每双周' },
    { id: 'monthly', label: '每月' },
    { id: 'yearly', label: '每年' },
  ];

  const dlg = document.createElement('dialog');
  dlg.className = 'sch-dlg';
  /*
   * 布局照「元舱的新建自动化」（2026-10-17 用户截图要求）：**左边输入、右边配置**。
   *   · 左 = 名字 + 动作声明的输入区（textarea/text），textarea 撑满高度；
   *   · 右 = 做法（换动作）+ 动作声明的下拉/数字 + 重复方式 + 启用。
   * 动作没声明输入区（PR 巡检 / 备份）时左边就只有名字，弹窗自然变矮。
   */
  const f0 = schConfigFields(curAction, cfg);
  dlg.innerHTML = `
    <form method="dialog">
      <b>${job ? '编辑定时任务' : '新建定时任务'}</b>
      <div class="dim" id="schActionHint" style="font-size:12px;margin:2px 0 2px">${esc(curAction?.hint ?? '')}</div>
      <div class="sch-cols" id="schFields">
        <div class="sch-left">
          <label>名字</label>
          <input id="schName" value="${esc(job?.name ?? curAction?.defaultName ?? '定时任务')}" placeholder="给它起个名字" />
          <div class="sch-left-fields" id="schLeftFields">${f0.left}</div>
        </div>
        <div class="sch-right" id="schRight">
          <!-- 「做法」是个小开关：绝大多数任务就是「说一句话交给谁」，
               换内置动作（PR 巡检 / 备份）的人才需要碰它。下拉用全站 .combo 组件。 -->
          <label>做法</label>
          <span id="schActionMount" title="换一种做法"></span>
          <div id="schRightFields">${f0.right}</div>
          <div class="dlg-row">
            <span class="dlg-box"><span class="dlg-box-k">重复：</span><span class="dlg-combo" id="schRepeatMount"></span></span>
            <span class="dlg-row-rest" id="schRepeatBody">${schRepeatBody(repeat0, job, min)}</span>
          </div>
          <label class="check sch-enable">
            <input id="schEnabled" type="checkbox" ${job ? (job.enabled ? 'checked' : '') : 'checked'} />
            <span>启用（到点就跑）</span>
          </label>
        </div>
      </div>
      <div class="dlg-actions">
        <span class="dim" style="flex:1;font-size:12px;align-self:center">保存后就生效，到点自动跑；列表里可以随时停用、改时间或改内容。</span>
        <button type="button" value="cancel">取消</button>
        <button class="primary" id="schOk" value="ok">${job ? '保存' : '创建'}</button>
      </div>
    </form>`;
  document.body.append(dlg);
  wireDialogHead(dlg.querySelector('form'));
  dlg.addEventListener('close', () => dlg.remove());

  // 参数区里的下拉（仓库 / 项目 / 选人）—— 公共组件，值存在 combo 里，读值靠这张表
  let cfgCombos = mountSchConfigCombos(curAction, cfg, repos, projects, S.personas ?? []);
  let repeatCombos = mountSchRepeatCombos(repeat0, job);

  // 「方式」：换动作 → 参数跟着换
  const actionCombo = createCombo({
    mount: $('schActionMount'),
    items: (meta.actions ?? []).map((a) => ({ id: a.id, label: a.label })),
    value: curAction?.id ?? '',
    onChange: (id) => {
      const prevDefault = curAction?.defaultName;
      curAction = (meta.actions ?? []).find((a) => a.id === id) ?? null;
      $('schActionHint').textContent = curAction?.hint ?? '';
      // 名字还是上一个动作的默认名（人没改过）→ 跟着换；改过就尊重人
      const nameEl = $('schName');
      if (!nameEl.value.trim() || nameEl.value.trim() === prevDefault) nameEl.value = curAction?.defaultName ?? '';
      const f1 = schConfigFields(curAction, cfg);
      $('schLeftFields').innerHTML = f1.left;
      $('schRightFields').innerHTML = f1.right;
      cfgCombos = mountSchConfigCombos(curAction, cfg, repos, projects, S.personas ?? []);
    },
  });
  actionCombo.el.classList.add('sch-mode');

  // 「重复」：换方式 → 右边那块字段跟着换（间隔给分钟数，单次给日期时间，每天给几点…）
  const repeatCombo = createCombo({
    mount: $('schRepeatMount'),
    items: REPEAT_ITEMS,
    value: repeat0,
    onChange: (mode) => {
      $('schRepeatBody').innerHTML = schRepeatBody(mode, job, min);
      repeatCombos = mountSchRepeatCombos(mode, job);
    },
  });
  // 这一排在弹窗最下面，**往上弹**，否则开出来就被窗口底边切掉
  repeatCombo.el.classList.add('up');

  $('schOk').onclick = async (e) => {
    e.preventDefault();
    const name = $('schName').value.trim();
    if (!name) return toast('给它起个名字');
    const repeat = repeatCombo.value();
    const config = readSchConfig(curAction?.fields, cfgCombos);
    // 动作自己声明了必填（`required`）的，先在这儿拦一道 —— 服务端还会再拦一次，
    // 这里拦是为了"别让人填完时间才发现上面空着"，不用等一次往返。
    for (const f of curAction?.fields ?? []) {
      if (f.required && !String(config[f.key] ?? '').trim()) return toast(f.requiredText ?? `「${f.label}」还没填`);
    }
    const body = {
      name,
      action: actionCombo.value(),
      repeat,
      enabled: $('schEnabled').checked,
      config,
    };
    if (repeat === 'interval') {
      const everyMinutes = Math.round(Number($('schEvery').value));
      if (!Number.isFinite(everyMinutes) || everyMinutes < min) return toast(`间隔至少要 ${min} 分钟`);
      body.everyMinutes = everyMinutes;
    } else if (repeat === 'once') {
      const v = $('schRunAt').value;
      const t = Date.parse(v);
      if (!v || !Number.isFinite(t)) return toast('给一个有效的日期时间');
      body.runAt = new Date(t).toISOString();
    } else {
      body.atTime = $('schAt').value;
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(body.atTime)) return toast('时间要写成 HH:MM（比如 09:00）');
      if (repeat === 'weekly' || repeat === 'biweekly') body.weekday = Number(repeatCombos.wd.value());
      if (repeat === 'monthly' || repeat === 'yearly') body.dayOfMonth = Math.round(Number($('schDom').value));
      if (repeat === 'yearly') body.month = Number(repeatCombos.mo.value());
    }
    try {
      await api(job ? `/api/schedules/${encodeURIComponent(job.id)}` : '/api/schedules', {
        method: job ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      dlg.close();
      await renderSchedules();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  dlg.showModal();
  setTimeout(() => $('schName').focus(), 50);
}

function renderSkillCards() {
  S.skill = null;
  showView('settings');
  const rows = S.skills ?? [];
  $('settingsView').innerHTML = `
    ${headRow('<b>技能</b>')}
    <div class="detail-body">
      <section class="fx">
        <div class="fx-head">
          <label>全部技能 <span class="count">${rows.length}</span></label>
          <button class="btn-sm" id="skNew">＋ 新建技能</button>
        </div>
        ${
          rows.length
            ? `<div class="sk-grid">${rows
                .map(
                  (s) => `<div class="sk-card${s.builtin ? ' builtin' : ''}" data-sk="${esc(s.name)}">
                    <div class="avatar skill">${esc(initial(s.name))}</div>
                    <div class="who">
                      <b>${esc(s.name)}${s.builtin ? '<em class="tag-dim" title="内置技能：只允许用，不许改（不能编辑、不能删、不能覆盖导入）">内置</em>' : ''}</b>
                      <div class="sub">${esc((s.description || '').trim() || '（还没写描述 —— 模型靠这一句决定什么时候用它）')}</div>
                    </div>
                  </div>`,
                )
                .join('')}</div>`
            : '<div class="dim" style="padding:14px 16px">还没有技能 —— 点右上角「＋ 新建技能」，或从本地导入一个 SKILL.md。</div>'
        }
      </section>
    </div>`;
  $('skNew').onclick = (e) => openAddMenu(skillAddItems(), e.currentTarget);
  $('settingsView').querySelectorAll('[data-sk]').forEach((el) => {
    el.onclick = () => openSkill(el.dataset.sk).catch((e) => toast(e.message, 'error'));
  });
}

/* ＋ 的选择改成了浮层菜单（见 openAddMenu / skillAddItems） */

/** 新建：弹窗填三个字段 */
function newSkill() {
  $('nSkillName').value = '';
  $('nSkillDesc').value = '';
  $('nSkillBody').value = '';
  $('skillDlg').showModal();
  setTimeout(() => $('nSkillName').focus(), 30);
}

/* ---------------------------------------------------------- 从本地导入 */

let importFound = [];
const importPicked = new Set();

function renderImportList() {
  if (!importFound.length) {
    $('impList').innerHTML = '<div class="dim" style="padding:12px 2px">没扫到 SKILL.md</div>';
    return;
  }
  $('impList').innerHTML = importFound
    .map(
      (s, i) => `<label class="member">
        <input type="checkbox" value="${i}" ${importPicked.has(s.dir) ? 'checked' : ''} ${s.alreadyInPool ? 'disabled' : ''} />
        <span>${esc(s.name)}${s.alreadyInPool ? '<em class="tag-inline">库里已有</em>' : ''}</span>
        <em title="${esc(s.dir)}">${esc(cut(s.dir, 34))}</em>
      </label>`,
    )
    .join('');
  $('impList').querySelectorAll('input[type=checkbox]').forEach((el) => {
    el.onchange = () => {
      const s = importFound[Number(el.value)];
      if (el.checked) importPicked.add(s.dir);
      else importPicked.delete(s.dir);
    };
  });
}

async function scanImport(root) {
  $('impHint').textContent = '扫描中…';
  try {
    const d = await post('/api/skills/discover', { root });
    importFound = d.found;
    importPicked.clear();
    for (const s of importFound) if (!s.alreadyInPool) importPicked.add(s.dir);
    const fresh = importFound.filter((s) => !s.alreadyInPool).length;
    $('impHint').textContent = `扫到 ${importFound.length} 个，其中 ${fresh} 个还没进库（已默认勾上）。`;
    renderImportList();
  } catch (err) {
    $('impHint').textContent = '';
    $('impList').innerHTML = `<div class="dim" style="padding:12px 2px">${failHtml(err)}</div>`;
  }
}

function openImportDialog() {
  $('impRoot').value = S.repoRoot || '';
  $('impList').innerHTML = '';
  $('importDlg').showModal();
  scanImport($('impRoot').value);
}

$('impScan').onclick = (e) => {
  e.preventDefault();
  const root = $('impRoot').value.trim();
  if (root) scanImport(root);
};

$('impOk').onclick = async (e) => {
  e.preventDefault();
  const dirs = [...importPicked];
  if (!dirs.length) return;
  try {
    const r = await post('/api/skills/import', { dirs });
    $('importDlg').close();
    await load();
    openSettings('skills');
    $('impHint').textContent = '';
    toast(`导入 ${r.imported.length} 个${r.skipped.length ? `，跳过 ${r.skipped.length} 个（${r.skipped.map((s) => s.name + '：' + s.reason).join('；')}）` : ''}`);
  } catch (err) { toast(err.message, 'error'); }
};

$('nSkillOk').onclick = async (e) => {
  e.preventDefault();
  const name = $('nSkillName').value.trim();
  if (!name) return toast('skill 需要个名字');
  try {
    const d = await post('/api/skills', {
      name,
      description: $('nSkillDesc').value,
      body: $('nSkillBody').value,
    });
    $('skillDlg').close();
    await load();
    await openSkill(d.skill.name);
  } catch (err) { toast(err.message, 'error'); }
};

function renderSkillEditor(skill, isNew, linkedPersonas) {
  const filePath = `${S.skillsRoot || 'skills'}\\${skill.name}\\SKILL.md`;
  /* 内置技能 = 只读态（2026-10-22 用户拍板）：字段照常看得全，但改不了、删不了。
     闸真正在服务端（PUT/DELETE/覆盖导入都会 403），这里只是不摆按钮 —— 两边都要有。 */
  const ro = !!skill.builtin;
  // 左栏只写「设置」；页头是面包屑「设置 › 技能 › 名字」（2026-10-20 用户要求：
  // 点进详情页后顶部要面包屑），名字/描述/文件路径都在正文 hero 里，页头不重复。
  // 布局照**员工详情页**：hero（头像 + 名字 + 一句话 + 操作按钮）+ 分组卡片 + 左标签右内容。
  // 保存/删除从底部搬到了 hero 右侧的 .hero-actions —— 跟员工详情同一个位置（用户要求）。
  $('settingsView').innerHTML = `
    ${headRow(breadcrumb([{ label: '技能', to: 'skills' }, { label: skill.name }]))}
    <div class="detail-body">
      <div class="p-head">
        <div class="avatar">${esc(initial(skill.name))}</div>
        <div class="p-head-main">
          <h2>${esc(skill.name)}</h2>
          <div class="p-desc">${esc((skill.description || '').trim() || '（还没写描述 —— 模型靠这一句决定什么时候用它）')}</div>
          <div class="p-meta">
            <span class="pill">${
              linkedPersonas.length ? `${linkedPersonas.length} 个员工在用` : '还没挂给任何人'
            }</span>
            ${ro ? '<span class="pill builtin">内置 · 只读</span>' : ''}
          </div>
          <div class="dim" style="font-size:11.5px;margin-top:2px">${esc(filePath)}</div>
        </div>
        <div class="hero-actions">
          ${
            ro
              ? /* 只读态不摆「保存 / 删除」—— 闸在服务端，这里只是别给按不动的按钮 */ ''
              : '<button id="sSave">保存</button>\n          <button class="danger" id="sDelete">删除</button>'
          }
        </div>
      </div>

      <div class="group-title">内容</div>
      <div class="group">
        <div class="form-row">
          <div class="row-label">名字</div>
          <input value="${esc(skill.name)}" readonly />
        </div>
        <div class="form-row top">
          <div class="row-label" title="决定「什么时候该用它」—— 模型先看这一句">描述</div>
          <div>
            <textarea id="sDesc" style="height:76px" ${ro ? 'readonly' : ''}>${esc(skill.description)}</textarea>
            <div class="dim" style="font-size:11.5px;margin-top:6px">
              只存一行：敲了回车会被并成空格（它要进 SKILL.md 的 description 字段，也要在列表里显示成一行）。
            </div>
          </div>
        </div>
        <div class="form-row top">
          <div class="row-label" title="什么时候用、做什么、做完长什么样。别写长 —— 贵在少而准">正文（Markdown）</div>
          <div>
            <!-- 预览/编辑（2026-10-22 用户实报："这里还是 markdown 格式"）：跟人物详情页
                 「职责与身份设定」同一套框 —— markdown 写少读多，默认预览；编辑才出源码。
                 只读技能（内置）不给切段，只预览（textarea 也 readonly）。 -->
            <div class="instr-wrap">
              <div class="instr-head">
                <div class="counter" id="sBodyCount"></div>
                ${ro ? '' : `<div class="seg seg-sm" id="sBodySeg">
                  <button type="button" data-m="view" class="on">预览</button>
                  <button type="button" data-m="edit">编辑</button>
                </div>`}
              </div>
              <div id="sBodyView" class="md-view"></div>
              <textarea id="sBody" hidden ${ro ? 'readonly' : ''}>${esc(skill.body)}</textarea>
            </div>
          </div>
        </div>
      </div>

      <div class="fx-head" style="margin-top:22px">
        <div class="group-title" style="margin:0">挂载</div>
        <button class="btn-sm" id="sAssign">＋ 添加到数字员工</button>
      </div>
      <div class="group">
        <div class="form-row top">
          <div class="row-label">挂在哪些员工上</div>
          <div>
            <div class="chips">
              ${linkedPersonas.length
                ? linkedPersonas.map((p) => `<span class="chip" style="padding:1px 10px">${esc(p.name)}</span>`).join('')
                : '<span class="dim" style="font-size:12px">还没挂给任何人</span>'}
            </div>
          </div>
        </div>
      </div>
    </div>`;

  /*
   * 正文预览/编辑（2026-10-22）：跟人物详情页「职责与身份设定」同一套做法。
   *   · 预览渲染的是 textarea **现值**（当前草稿）—— 编辑一半切过去看到的就是刚写的，
   *     切回编辑一个字不少；
   *   · 编辑态随内容撑高（fitSBody），内层不出滚动条，滚动只留外层页面一条；
   *   · 只读技能（内置）：没有 #sBodySeg，监听带 ?. 兜底，停在预览。
   */
  const sBodyEl = $('sBody');
  const sBodyViewEl = $('sBodyView');
  const fitSBody = () => {
    if (!sBodyEl || sBodyEl.hidden) return;
    sBodyEl.style.height = 'auto';
    sBodyEl.style.height = `${sBodyEl.scrollHeight}px`;
  };
  const syncSBodyCount = () => {
    const c = $('sBodyCount');
    if (c) c.textContent = (sBodyEl?.value ?? '').trim().length + ' 字';
  };
  const renderSBodyView = () => {
    const val = sBodyEl?.value ?? '';
    sBodyViewEl.innerHTML = val.trim() ? mdRender(val) : '<div class="md-empty">还没写正文。</div>';
  };
  const setSBodyMode = (m) => {
    if (m === 'edit' && ro) return; // 内置技能只读，切不过去
    sBodyViewEl.hidden = m === 'edit';
    sBodyEl.hidden = m !== 'edit';
    if (m === 'edit') {
      fitSBody();
      sBodyEl.focus();
    } else {
      renderSBodyView();
    }
    $('sBodySeg')?.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
  };
  $('sBodySeg')?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-m]');
    if (b) setSBodyMode(b.dataset.m);
  });
  sBodyEl?.addEventListener('input', () => {
    syncSBodyCount();
    fitSBody();
  });
  syncSBodyCount();
  renderSBodyView();

  if ($('sSave')) $('sSave').onclick = async () => {
    try {
      await api('/api/skills/' + encodeURIComponent(skill.name), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: $('sDesc').value, body: $('sBody').value }),
      });
      await load();
      await openSkill(skill.name);
    } catch (err) { toast(err.message, 'error'); }
  };

  if ($('sDelete')) $('sDelete').onclick = async () => {
    if (!(await confirmDo(`删掉技能「${skill.name}」？\n文件会被删除，所有挂载一并解除。`))) return;
    try {
      await api('/api/skills/' + encodeURIComponent(skill.name), { method: 'DELETE' });
      S.skill = null;
      await load();
      openSettings('skills'); // 删完回卡片列表
    } catch (err) { toast(err.message, 'error'); }
  };


  $('sAssign').onclick = () => openSkillAssignDialog(skill.name, linkedPersonas.map((p) => p.id));
}

/* ------------------------------------ 技能 → 发给数字员工（反方向挂载） */

/**
 * 把一个**技能**发给若干个数字员工。
 *
 * 跟员工详情里的「关联技能」是**同一件事的反方向**（那张表的两个视角）：
 *   · 员工详情：给这个人挑几个技能
 *   · 这里：  把这个技能发给几个人
 * 两边落的是同一张表 persona_skills，所以页面上的名单天然一致 ——
 * 别把"方向"当成两套数据去做。
 *
 * 已经挂上的那些**列出来但点不动**（locked + 「已挂载」标签）：看得见现状，
 * 又不会让人重复点一遍；要解除去员工详情（那边才有 × 的入口）。
 */
let skAssignSkill = null;
let skAssignLinked = [];
const skAssignPicked = new Set();

function renderSkAssignList() {
  const q = ($('skAssignSearch').value || '').trim().toLowerCase();
  // 被锁员工不进名单（2026-10-23；2026-10-22 扩到内置员工）：专家包雇来的 + 出厂的喜儿，
  // 技能都随出厂定义固定，这里列出来也点不了（服务端同判据：experts.lockKindOf）
  const rows = (S.personas ?? [])
    .filter((p) => !String(p.id || '').startsWith('p-expert-') && !p.builtin)
    .filter((p) => !q || p.name.toLowerCase().includes(q));
  $('skAssignList').innerHTML = rows.length
    ? rows
        .map((p) => {
          const has = skAssignLinked.includes(p.id);
          return `<label class="member${has ? ' locked' : ''}">
            <input type="checkbox" value="${esc(p.id)}" ${has ? 'checked disabled' : skAssignPicked.has(p.id) ? 'checked' : ''} />
            <span>${esc(p.name)}${has ? '<em class="tag-inline">已挂载</em>' : ''}</span>
          </label>`;
        })
        .join('')
    : '<div class="dim" style="padding:10px 2px">没找到</div>';
  $('skAssignList').querySelectorAll('input:not([disabled])').forEach((el) => {
    el.onchange = () => {
      if (el.checked) skAssignPicked.add(el.value);
      else skAssignPicked.delete(el.value);
      paintSkAssignOk();
    };
  });
}

/** 底栏那颗按钮上的数字就是"这一次要加几个"（已在位的那些不算） */
function paintSkAssignOk() {
  const n = skAssignPicked.size;
  const btn = $('skAssignOk');
  btn.textContent = n ? `添加（${n}）` : '添加';
  btn.disabled = !n;
}

function openSkillAssignDialog(skillName, linkedIds) {
  skAssignSkill = skillName;
  skAssignLinked = linkedIds;
  skAssignPicked.clear();
  $('skAssignName').textContent = skillName;
  $('skAssignSearch').value = '';
  renderSkAssignList();
  paintSkAssignOk();
  $('skAssignDlg').showModal();
  setTimeout(() => $('skAssignSearch').focus(), 30);
}

$('skAssignSearch').oninput = renderSkAssignList;

$('skAssignOk').onclick = async (e) => {
  e.preventDefault();
  const ids = [...skAssignPicked];
  if (!ids.length) return;
  try {
    await post(`/api/skills/${encodeURIComponent(skAssignSkill)}/personas`, { personaIds: ids });
    $('skAssignDlg').close();
    // 重画技能页：上面那排「挂在哪些员工上」的芯片要跟着变
    await openSkill(skAssignSkill);
  } catch (err) { toast(err.message, 'error'); }
};

/* -------------------------------------------------------------- 进对话 */

/**
 * 输入框里的「权限」选择。
 * 注意：班底的权限是**员工级**的字段（跟员工详情里那个是同一个），
 * 不是像 DSH 那样按会话存 —— 所以这里改的是这个员工的所有对话，界面上也说清楚。
 * 群里每个人权限不同，放一个假的没意义，直接不放。
 */
/**
 * 权限下拉的选项：**跟随员工默认** + 运行时支持的那几个权限。
 * 默认项是"收回提权"的入口 —— 提权最怕的就是忘了收回，所以必须有一键还原。
 */
function permItems(rt) {
  return [{ id: '', label: '跟随员工默认' }, ...sandboxItems(rt)];
}

/**
 * **会话级**权限下拉。
 *
 * 语义：默认跟随员工；在这里选一个具体权限 = **只对这个会话生效**（不动员工本身）。
 * 选回「跟随员工默认」= 收回。
 *
 * 被覆盖时组合框会**高亮 + 标题写明**，因为提权最大的风险是"忘了收回"——
 * 那等于长期敞着一个口子。
 */
function convPermCombo({ mount, conversationId, runtime, value, personaSandbox, onDone }) {
  mount.innerHTML = '';
  const items = permItems(runtime);
  if (!items.length) return null;
  const labelOf = (id) => (items.find((it) => it.id === id) ?? {}).label ?? String(id ?? '');
  // 员工默认权限的真实名（personaSandbox 为空 = 员工自己也没设，写「未设置」）。
  // 按钮上直接写它 —— "跟随员工默认"这种说法不写出来，是什么就展示什么（用户 2026-10-18）；
  // 清单里「跟随员工默认」那条照旧留着，当收回提权的入口。
  const realLabel = () => (personaSandbox ? labelOf(personaSandbox) || personaSandbox : '未设置');
  const combo = createCombo({
    mount,
    items,
    value: value ?? '',
    search: false,
    buttonText: (id) => (id ? labelOf(id) : realLabel()),
    onChange: async (id) => {
      try {
        await api('/api/conversations/' + encodeURIComponent(conversationId), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sandbox: id || null }),
        });
        paint(id);
        onDone?.();
      } catch (err) {
        toast(err.message, 'error');
        onDone?.();
      }
    },
  });
  const paint = (id) => {
    combo.el.classList.toggle('elevated', !!id);
    combo.el.title = id
      ? `这个会话单独设成了「${labelOf(id)}」——用完点这里选回「跟随员工默认」收回`
      : `员工默认（${realLabel()}）——想单独设就点开选`;
  };
  paint(combo.value());
  combo.el.classList.add('up'); // 往上弹（在输入区底部，往下弹会被切掉）
  return combo;
}

function renderComposerPerm(d) {
  const mount = $('dPermMount');
  if (!mount) return;
  mount.innerHTML = '';
  if (d.conversation.kind === 'group') return;
  const rt = S.runtimes.find((x) => x.id === d.conversation.runtime) ?? null;
  convPermCombo({
    mount,
    conversationId: d.conversation.id,
    runtime: rt,
    value: d.conversation.sandbox,
    personaSandbox: d.conversation.personaSandbox,
    onDone: () => openConversation(d.conversation.id),
  });
}

/**
 * 把服务端给的模型清单变成下拉项。
 *
 * 显示**显示名**，不是 `id · 显示名`。id 是真正传给 CLI 的那个值没错，但它又长又带
 * 供应商前缀（`opencode-zen-free/longcat-2.5-preview-free` 有 40 个字符），拼上去
 * 浮层里几乎全被它占满 —— 而显示名正是配置里专门给人看的那个。
 *
 * 搜索不受影响：`createCombo` 过滤时**同时匹配 `id` 和 `label`**，按 id 照样搜得到。
 *
 * 唯一要防的是**重名**：不同供应商可能起一样的显示名，那时两条长得一模一样、
 * 选哪个分不出来。所以只在**确实撞名**时，给撞上的那几条补回 id。
 */
/**
 * 取某个运行时的模型清单，**60 秒内复用**。
 *
 * 为什么要缓存：以前只在点开下拉时读一次，现在输入区的按钮上要直接写出
 * "实际跑的是哪个模型"，所以每进一个会话都要读一遍。同一运行时下反复切会话
 * 没必要重复问（服务端那头是读 CLI 的配置文件，快归快，但也没必要每次都读）。
 * 60 秒是为了让"用户在 CLI 那边加了模型"这种事半分钟内能反映到界面上。
 */
const MODEL_LIST_TTL_MS = 60 * 1000;
const modelListCache = new Map(); // runtimeId → { at, data }

async function readModelList(runtimeId, { fresh = false } = {}) {
  const hit = modelListCache.get(runtimeId);
  if (!fresh && hit && Date.now() - hit.at < MODEL_LIST_TTL_MS) return hit.data;
  const data = await api('/api/runtimes/' + encodeURIComponent(runtimeId) + '/models');
  modelListCache.set(runtimeId, { at: Date.now(), data });
  return data;
}

function modelItems(models) {
  const list = models ?? [];
  const seen = new Map();
  for (const m of list) {
    const n = String(m.name ?? '').trim();
    if (n) seen.set(n, (seen.get(n) ?? 0) + 1);
  }
  const itemOf = (m) => {
    const name = String(m.name ?? '').trim();
    if (!name) return { id: m.id, label: m.id }; // 配置里没显示名，只能拿 id 顶
    return { id: m.id, label: seen.get(name) > 1 ? `${name} · ${m.id}` : name };
  };

  /*
   * 按 id 的前缀分组（`供应商/模型名` 里那一段）。实测这台机器上正好两组：
   * workbuddy-ai (3) / opencode-zen-free (10)。
   *
   * 只有**一种**前缀时不加标题 —— 一个标题盖住全部条目，纯粹是噪音。
   * 没有斜杠的 id 归到「其他」。
   */
  const groups = new Map();
  for (const m of list) {
    const id = String(m.id ?? '');
    const at = id.indexOf('/');
    // 服务端可以自己指定分组（claude 的别名就是这样：id 是 `sonnet`，不该混进「其他」）
    const g = m.group != null ? String(m.group) : at > 0 ? id.slice(0, at) : '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(m);
  }
  if (groups.size < 2) return list.map(itemOf);

  const out = [];
  for (const [g, arr] of groups) {
    out.push({ header: g || '其他' });
    for (const m of arr) out.push(itemOf(m));
  }
  return out;
}

/**
 * **会话级**模型切换 —— 跟权限那颗一个模式，位置在发送按钮左边。
 *
 * 清单**直接问运行时**（服务端读 CLI 自己那份配置），不查任何本地账本 —— 见 cli-models.mjs。
 * 所以：
 *   · **只读一次**（这次会话里读过就记住；同一运行时下换会话复用缓存，要重读就重开会话）
 *   · **打开就后台读一次**：按钮上要写出"实际是哪个模型"，不能等点开才知道
 *   · **读不到不清空**：至少留着"跟随员工默认"，并把原因写进按钮的 title
 *
 * 语义和权限一样：默认跟随员工（员工没绑就是 CLI 自己的默认），
 * 在这儿选一个 = 只对这个会话生效；选回第一项 = 收回。
 */
function convModelCombo({ mount, conversationId, runtime, value, personaModel, onDone }) {
  mount.innerHTML = '';
  const FOLLOW = '跟随员工默认';
  let items = [{ id: '', label: FOLLOW }];
  let loaded = false;
  let why = '';
  // CLI 自己的默认模型名（读到才有）：员工没绑模型时，真正跑的就是它
  let cliDefault = null;

  /** id → 人看的名字（清单里有就用它的显示名，没有就拿 id 顶） */
  const labelOfId = (id) => {
    const hit = items.find((it) => it.id === id && it.id);
    return hit && hit.label !== id ? hit.label : id;
  };

  const combo = createCombo({
    mount,
    items,
    value: value ?? '',
    search: true,
    placeholder: '搜模型…（id 或显示名）',
    empty: '没有匹配的模型',
    // 浮层右缘对齐**整个输入框**的右缘：这颗贴着窗口右边（右边只剩发送/停止按钮），
    // 只对齐按钮自己的右缘，和输入框边线之间会空出一截；左对齐更是直接探出窗口被切掉
    // （2026-10-17 用户实报"框被挡住了，右边应该跟框对齐"）。
    alignRightTo: () => mount.closest('.input-wrap'),
    onOpen: () => { void load(); },
    onChange: async (id) => {
      try {
        await api('/api/conversations/' + encodeURIComponent(conversationId), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: id || null }),
        });
        paint(id);
        onDone?.();
      } catch (err) {
        toast(err.message, 'error');
        onDone?.();
      }
    },
  });

  const paint = (id) => {
    /*
     * 按钮上**直接写出实际用哪个模型**（2026-10-17 用户要求）。
     * 以前只写在 title 里（要悬停才看得见），而"我这句话到底是哪个模型答的"
     * 是这个页面最该一眼看清的事。
     * 取值的顺序与实际派活一致：会话覆盖 → 员工绑定 → CLI 默认。
     */
    const effId = id || personaModel || cliDefault || '';
    const followLabel = effId ? `${FOLLOW}：${labelOfId(effId)}` : FOLLOW;
    // 第一项就是"跟随员工默认"，标签换成带模型名的写法（其余项不动）
    if (items[0] && items[0].id === '' && items[0].label !== followLabel) {
      items = [{ id: '', label: followLabel }, ...items.slice(1)];
      combo.setItems(items, true); // 保住当前值，别把人家选的模型冲掉
    }
    combo.el.classList.toggle('elevated', !!id); // 有覆盖时高亮：跟权限那颗一个信号
    combo.el.title = id
      ? `这个会话单独用了「${id}」——点这里可以换，或选回「${FOLLOW}」收回`
      : `${FOLLOW}${effId ? `（现在跑的是 ${effId}）` : '（CLI 自己的默认模型）'}${why ? `。${why}` : ''}`;
  };

  /** 读清单。失败不抛出去 —— 组合框照常能用，只是选项少。 */
  const load = async () => {
    if (loaded || !runtime) return;
    loaded = true;
    try {
      const d = await readModelList(runtime.id);
      const list = d.models ?? [];
      const cur = combo.value();
      const next = [{ id: '', label: FOLLOW }];
      // 当前值不在清单里也要留着 —— 清单可能读不到，不能把人家选着的模型弄丢
      if (cur && !list.some((m) => m.id === cur)) next.push({ id: cur, label: `（清单里没有）${cur}` });
      next.push(...modelItems(list));
      items = next;
      why = list.length ? '' : (d.error ?? '这个运行时的清单是空的');
      cliDefault = d.defaultModel ?? null;
      combo.setItems(items);
    } catch (err) {
      loaded = false; // 失败就当没读过，下次展开再试
      why = `取不到清单（${err.message}）`;
    }
    paint(combo.value());
  };

  paint(combo.value());
  // 不等点开：先把默认模型名读回来，按钮上才写得出来
  void load();
  combo.el.classList.add('up'); // 往上弹（在输入区底部，往下弹会被切掉）
  // 这颗下拉在发送按钮旁边（贴着窗口右边）—— 浮层得**右边缘对齐**，
  // 否则默认的 left:0 会让它在按钮右侧探出窗口
  combo.el.classList.add('right');
  return combo;
}

function renderComposerModel(d) {
  const mount = $('dModelMount');
  if (!mount) return;
  mount.innerHTML = '';
  // 群里每个人的模型可能不同，放一个"这个会话的模型"没意义 —— 跟权限那颗同一个判断
  if (d.conversation.kind === 'group') return;
  convModelCombo({
    mount,
    conversationId: d.conversation.id,
    runtime: S.runtimes.find((x) => x.id === d.conversation.runtime) ?? null,
    value: d.conversation.model,
    personaModel: d.conversation.personaModel,
    onDone: () => openConversation(d.conversation.id),
  });
}

/**
 * 输入区的显隐。没选会话时收起来 —— 那时候敲字也发不出去，
 * 摆一个能打字、按了没反应的输入框是误导。
 */
function setComposer(on) {
  const box = document.querySelector('.composer');
  if (box) box.classList.toggle('is-hidden', !on);
  const h = $('hint');
  if (h) {
    h.classList.toggle('is-hidden', !on);
    if (!on) h.textContent = '';
  }
}

/**
 * 只读输入区（2026-10-20）：**员工已删** 或 **群已解散** 的会话只能看历史、不能再聊。
 *
 * 为什么不是"藏起输入区"：藏了之后用户只会以为界面出问题了，还得自己猜为什么发不了。
 * 置灰 + 一句说明最直接。同时把权限/模型那几个工具收起 —— 人都没了，那些设置没有意义。
 *
 * `reason` 决定那句说明：`'gone'`（默认，员工已删）/ `'dissolved'`（群已解散）。
 * 两句话都只说明"为什么发不出去"，不复述记录还在不在 —— 记录就在上面看得见。
 */
const READONLY_WHY = {
  gone: '这个员工已删除，只能查看聊天记录',
  dissolved: '这个群已解散，只能查看聊天记录',
};
function setComposerReadonly(on, reason = 'gone') {
  const box = document.querySelector('.composer');
  const input = $('input');
  const send = $('send');
  const h = $('hint');
  if (box) box.classList.toggle('is-readonly', on);
  if (input) {
    input.disabled = on;
    input.placeholder = on ? READONLY_WHY[reason] ?? READONLY_WHY.gone : '说点什么…（Enter 发送，Shift+Enter 换行）';
  }
  if (send) send.disabled = on;
  if (h) {
    if (on) {
      h.classList.remove('is-hidden');
      h.textContent = READONLY_WHY[reason] ?? READONLY_WHY.gone;
    } else if (Object.values(READONLY_WHY).includes(h.textContent)) {
      // 换到一段能聊的会话：把上一次的只读说明擦掉（不然它会一直挂在那儿）。
      // 只认这两句文案 —— hint 还兼职"几秒后自己消失"的临时提示，别把人家的字擦了
      h.textContent = '';
    }
  }
}

async function openConversation(id) {
  setRoute('conversation', { id });
  // 换会话/刷新视图时，先把上一次的事件流停掉
  closeMentionPop();
  if (S.es) { S.es.close(); S.es = null; }
  S.running = false;

  const d = await api('/api/conversations/' + encodeURIComponent(id));
  S.conversation = d.conversation;
  // 这段会话是不是**一个字都没说过**（详情页「发消息」连点复用它，见 toMessages）。
  // 依据是服务端刚给的 messages，不是本地猜测 —— 零额外请求、刷新后结论一致。
  S.convEmpty = (d.messages || []).length === 0;
  savePlace();         // 记下正在看哪个会话，刷新后回到这儿
  setComposer(true);   // 有会话了，输入区才出来
  S.persona = S.personas.find((p) => p.id === d.conversation.personaId) || S.persona;
  /*
   * 员工已删的会话：**只能看、不能聊**（2026-10-20 用户要求）。
   * 这类会话不再归档、就留在消息列表里，点进来是只读的历史记录 —— 人没了，
   * 发出去也没人接，所以输入框置灰 + 一句说明，而不是让人敲完才发现发不出去。
   */
  const personaGone =
    d.conversation.kind !== 'group' && !(S.personas ?? []).some((p) => p.id === d.conversation.personaId);
  /*
   * 群已解散（2026-10-20 用户定）：**历史照旧留在消息列表里，点进来只读**。
   * 解散时成员关系与群助手都清了，发出去也没人能接 —— 跟"员工已删"同一个处理：
   * 输入框置灰 + 一句说明，而不是让人敲完才撞 409（E2049）。
   */
  const dissolved = d.conversation.kind === 'group' && !!d.conversation.dissolvedAt;
  setComposerReadonly(personaGone || dissolved, dissolved ? 'dissolved' : 'gone');
  // 换到别的会话时，抽屉里那套群成员设置就不再适用了。
  // 但**同一个群换一段会话**不该关：群设置是群级的，抽屉里看的就是这个群。
  if (S.drawerOpen && S.drawerThreadId !== id && S.drawerThreadId !== d.conversation.groupId) closeDrawer();
  // 进了对话就不算"在看群详情页"了（左侧列表高亮要跟着走）
  S.groupThreadId = null;

  const isGroup = d.conversation.kind === 'group';
  const running = d.conversation.status === '跑中';
  const badge = `<span class="badge ${esc(d.conversation.status)}">${esc(running ? TYPING : d.conversation.status)}</span>`;

  if (isGroup) {
    /*
     * 解散的群：成员名单已经清空（`members` 是空数组），再写 "0 人" 就是噪音；
     * 改标「已解散」，并且**不给群设置入口** —— 成员/群名/助手都没了，点开只能是空抽屉。
     * 「聊天记录」照旧留着：解散后它可能就是唯一能翻历史的入口（列表里只显示这一行）。
     */
    const metaSub = dissolved
      ? '<span class="dim" style="font-size:12px">已解散</span>'
      : `<span class="dim" style="font-size:12px">${d.conversation.members.length} 人</span>`;
    $('chatHead').innerHTML = `
      <div class="avatar grp sm">${esc(initial(d.conversation.title))}</div>
      <div class="meta">
        <div><b>${esc(d.conversation.title)}</b> ${dissolved ? '' : badge} ${metaSub}</div>
      </div>
      <button class="icon-btn" id="toChatLog" title="聊天记录">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3.6 12a8.4 8.4 0 1 0 2.6-6.1" />
          <path d="M3.6 4.6V10H9" />
          <path d="M12 8v4.4l3 1.8" />
        </svg>
      </button>
      ${dissolved ? '' : `<button class="icon-btn" id="toSettings" title="群设置">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2.6v2.1M12 19.3v2.1M2.6 12h2.1M19.3 12h2.1M5.4 5.4l1.5 1.5M17.1 17.1l1.5 1.5M18.6 5.4l-1.5 1.5M6.9 17.1l-1.5 1.5" />
        </svg>
      </button>`}`;
    if (!dissolved) $('toSettings').onclick = () => openGroupDrawer(d.conversation);
    // 群聊天记录（2026-10-20 用户要求）：抽屉列出这个群的会话（含被「不显示」的那条）
    $('toChatLog').onclick = () => openChatLogDrawer(d.conversation);
  } else {
    /*
     * 名字取法：员工还在 → 用他现在的名字（可能改过，personaName 来自 JOIN）；
     * 员工已删 → personaName 是 NULL，**不能回落到 S.persona**（那是上一个人的名字，
     * 会张冠李戴），退回这段会话自己的标题（convDisplayName 会剥掉「和 」前缀，
     * 不然页头会出现「和 和大梁」这种叠字）；连标题都没有才写「员工已删」。
     * 头像同理：员工没了就别给「点进员工详情」的入口（点开是 404）。
     */
    const name = convDisplayName(d.conversation);
    const pHere = personaGone ? null : ((S.personas ?? []).find((x) => x.id === d.conversation.personaId) ?? null);
    $('chatHead').innerHTML = `
      ${smAvatar(name, personaGone ? '' : `clickable" data-detail="${esc(d.conversation.personaId)}" title="配置他的 agent CLI`, pHere)}
      <div class="meta">
        <div><b>${esc(name)}</b> ${badge}</div>
      </div>
      <button class="icon-btn" id="toChatLog" title="聊天记录">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3.6 12a8.4 8.4 0 1 0 2.6-6.1" />
          <path d="M3.6 4.6V10H9" />
          <path d="M12 8v4.4l3 1.8" />
        </svg>
      </button>`;
    // 点头像进员工详情（原来那个「员工详情」按钮去掉了，省地方）
    const detail = $('chatHead').querySelector('[data-detail]');
    if (detail) detail.onclick = () => openDetail(d.conversation.personaId);
    // 聊天记录（2026-10-20 落地）：右侧抽屉列出这个人的全部会话，点一条就回看/续聊
    $('toChatLog').onclick = () => openChatLogDrawer(d.conversation);
  }

  renderComposerPerm(d);
  renderComposerModel(d);

  // 把 `runs` 一起给它：失败的运行在库里**没有消息**，只画 messages 就会"说了句话然后没了"
  drawMessages(d.messages, d.conversation.personaName || '', isGroup, d.runs);
  const last = d.runs[0];
  if (last && last.status === '跑中') attachStream(last.id);
  renderList();
}

/** 消息时间戳：`2026-10-19 14:42`（带年月日 —— 2026-10-19 用户要求；聊天可能跨天，只有时分看不出哪天） */
function stampOf(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch {
    return '';
  }
}

function bubble(role, text, name, who, showName = false, at = '') {
  const mine = role === 'user';
  const label = mine ? '我' : (who || name || '数字员工');
  // 头像带图（2026-10-22）：优先按名字找员工；群聊消息有 personaName 直接命中，
  // 1:1 改过名时名字可能对不上，再兜一层会话的 personaId
  const p = mine ? null
    : (personaByName(label)
      ?? (S.conversation?.personaId ? S.personas.find((x) => x.id === S.conversation.personaId) ?? null : null));
  // 时间放在气泡**外面**的下方（2026-10-19 用户要求，别塞在气泡里）：绝对定位，不占布局
  const t = at ? stampOf(at) : '';
    return `<div class="row ${mine ? 'me' : ''}">
    ${mine ? smAvatar('我', 'me') : smAvatar(label, '', p)}
    <div class="bubble">${showName && !mine ? `<div class="who-line">${esc(label)}</div>` : ''}${renderMarkdown(text)}</div>
    ${t ? `<div class="btime">${esc(t)}</div>` : ''}
  </div>`;
}

/**
 * 把**消息**和**没跑成的那几次运行**按时间合成一条时间线。
 *
 * 为什么要合：**失败的运行在库里没有 assistant 消息** —— 只画 messages 的话，
 * 用户看到的就是"我说了一句话，然后就没了"。失败原因只出现在那个实时气泡上，
 * 而它 300ms 后就被"从库里重画"冲掉了 —— 用户的原话是「报错信息一闪而逝」（2026-10-16 实报）。
 *
 * 为什么按**时间**而不是按 runId 配对：1:1 聊天派活时，**用户那条消息没有 runId**
 * （运行是派活之后才建的，见 dispatch.mjs 的 trigger）。配不上，时间线是这里唯一可靠的依据。
 */
function timelineOf(msgs, runs) {
  const items = [];
  for (const m of msgs) items.push({ at: String(m.createdAt ?? ''), kind: 'msg', m });
  for (const r of runs ?? []) {
    // 只有**不是人主动停的**才值得留一条：点了停止是有意为之，不必在记录里再喊一声
    if (r.status !== '失败' && r.status !== '中断') continue;
    items.push({ at: String(r.endedAt ?? r.startedAt ?? ''), kind: 'fail', r });
  }
  // 同一时刻（同一毫秒落库）时消息排前面：失败是"那条消息之后"发生的事
  items.sort((a, b) => (a.at === b.at ? (a.kind === 'msg' ? -1 : 1) : a.at < b.at ? -1 : 1));
  return items;
}

/**
 * 从一大段报错里挑出**那句人话**。
 *
 * 为什么不能整段倒出来：起不来的那次，`error` 是子进程的 stderr —— 十几行 Node 堆栈，
 * 头三行是 `node:internal/...` / `throw err;` / `^`。整段贴在对话里，
 * 用户看到的是"一堵墙"，而真正有用的那句（`Error: Cannot find module '...'`）淹没在中间。
 * 全量不删，折在「完整报错」里 —— 要排查的人点一下就有。
 */
function firstMeaningfulLine(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const noise = /^(throw err;?|\^|at\s|node:internal\/)/;
  const pick = lines.find((l) => !noise.test(l)) ?? lines[0] ?? '';
  return pick.length > 160 ? pick.slice(0, 160) + '…' : pick;
}

/** 没跑成那一块。复用 `.step.bad` —— 跟实时气泡里那行是同一个样式 */
function failBlock(r) {
  const full = String(r.error ?? '').trim();
  const why = firstMeaningfulLine(full) || '运行失败（这次没留下原因）';
  const code = r.exitCode == null ? '' : `（退出码 ${r.exitCode}）`;
  // 只有"藏着更多东西"时才给折叠入口：短报错摊开就好，别多一颗要点开的东西
  const more =
    full.length > why.length + 20
      ? `<details class="fail-more"><summary>完整报错</summary><pre>${esc(full)}</pre></details>`
      : '';
  return `<div class="row">
    <div class="avatar sm" data-tone="a">!</div>
    <div class="bubble"><div class="step bad">没跑成：${esc(why)}${esc(code)}</div>${more}</div>
  </div>`;
}

function drawMessages(msgs, name, isGroup = false, runs = []) {
  const items = timelineOf(msgs, runs);
  /*
   * 空会话**什么都不画**（2026-10-20 用户要求）：「和 X 还没有对话 / 在下面说第一句吧」
   * 这两行提示去掉了 —— 输入框就在下面，不需要再教一遍。
   */
  $('chat').innerHTML = items.length
    ? items
        .map((it) =>
          it.kind === 'msg'
            ? bubble(it.m.role, it.m.text, name, it.m.personaName, isGroup, it.m.createdAt)
            : failBlock(it.r),
        )
        .join('')
    : '';
  scrollDown();
}
const scrollDown = () => { $('chat').scrollTop = $('chat').scrollHeight; };

/* ---------------------------------------------------------------- 发消息 */

async function send() {
  const text = $('input').value.trim();
  if (!text || !S.conversation || S.running) return;
  // 说出第一句就不再是"空会话"了 —— 详情页「发消息」的连点复用靠它判断
  S.convEmpty = false;
  $('input').value = '';
  closeMentionPop();
  const name = S.conversation.personaName || S.persona?.name || '数字员工';

  $('chat').querySelector('.empty')?.remove();
  $('chat').insertAdjacentHTML('beforeend', bubble('user', text, name, undefined, false, new Date().toISOString()));
  scrollDown();

  try {
    // 流程走的是 issue：在实例页里说话，不在这儿。这里就是普通聊天
    const d = await post('/api/conversations/' + encodeURIComponent(S.conversation.id) + '/messages', { text });
    attachStream(d.runId);
    // 立刻刷一次左侧列表。
    // 服务端在写入这条消息时就会把它从"已从列表移除"里恢复（钉钉也是这个语义：
    // 删掉会话后只要有新消息，会话就回到列表）。但列表数据是前端缓存的，
    // 不主动刷就得等运行结束才更新 —— 那几十秒里会让人以为"消息发出去了却没记录"。
    await load();
  } catch (err) { toast(err.message, 'error'); load(); }
}

// 主对话里"正在跑的那次运行"（停止生成要用它）。
// 跟节点对话栏的 ncRunningId 是一个道理：S.running 只说明"忙不忙"，
// 点不到具体哪一条运行 —— 光有布尔量是停不掉的。
let chatRunningId = null;

/**
 * 停止生成：掐掉这个会话里正在跑的那次运行。
 *
 * 走的是跟节点对话栏那颗方块按钮**同一个后端接口**（POST /api/runs/:id/abort）——
 * 服务端会先把这次标成"人停的"，再杀子进程，所以收尾时**不会记成失败**
 * （这两件事的先后顺序有讲究，见 server.mjs 里 abort 那段注释）。
 *
 * ⚠️ 这是"停止"，不是"暂停"：底层 runtime 都是一次性子进程，没有暂停/续跑这回事。
 *    停掉的是**这一轮运行**，不是这个人 —— 会话和上下文都还在，随时可以再说一句接着办。
 */
async function stopChatRun() {
  const id = chatRunningId;
  if (!id) return;
  // 先让界面立刻停下来（点完就见效，不等后端回调）—— 跟节点对话栏一个做法
  S.running = false;
  chatRunningId = null;
  setBusy(false);
  setHeaderBadge('已停止');
  try {
    await api(`/api/runs/${encodeURIComponent(id)}/abort`, { method: 'POST' });
  } catch (e) {
    toast(e.message, 'error');
  }
  // 再按真实状态刷一次：收尾的钩子会把这次运行的产出/状态落库
  if (S.conversation) await openConversation(S.conversation.id).catch(() => {});
}

function attachStream(runId) {
  if (S.es) S.es.close();
  S.running = true;
  chatRunningId = runId;
  setBusy(true);
  setHeaderBadge('跑中', TYPING);

  const name = S.conversation.personaName || S.persona?.name || '数字员工';
  const convId = S.conversation.id;
  const id = 'live-' + runId;
  $('chat').insertAdjacentHTML('beforeend',
    `<div class="row" id="${id}">
       ${smAvatar(name, '', personaByName(name))}
       <div class="bubble"><div class="typing"><i></i><i></i><i></i></div></div>
     </div>`);
  scrollDown();

  const body = document.querySelector('#' + id + ' .bubble');
  const showThinking = S.conversation?.showThinking === 1;
  const add = (cls, text, asHtml = false) => {
    body.querySelector('.typing')?.remove();
    const d = document.createElement('div');
    d.className = 'step ' + cls;
    if (asHtml) d.innerHTML = text; else d.textContent = text;
    body.appendChild(d);
    scrollDown();
  };

  let stopped = false;
  /**
   * 收尾唯一出口。
   * 状态永远以**服务端**为准，不靠客户端自己猜。
   */
  const stop = (status) => {
    if (stopped) return;
    stopped = true;
    if (S.es) { S.es.close(); S.es = null; }
    S.running = false;
    chatRunningId = null;
    setBusy(false);
    setHeaderBadge(status);
    setTimeout(() => openConversation(convId).then(load).catch(() => {}), 300);
  };

  // 实时输出走**共用**的 streamRun（流程实例页的节点对话也是它）
  S.es = streamRun(runId, {
    onText: (chunk) => add('text', renderMarkdown(chunk), true),
    onRunError: (msg) => add('bad', '· ' + firstMeaningfulLine(msg)),
    onThinking: (t) => showThinking && add('', '· 思考：' + t),
    onTool: (name) => showThinking && add('', '· 工具：' + name),
    onDone: (evt) => {
      // 这一行只是"立刻给你一句"；跑完 300ms 后整页从库里重画，
      // 那时由 failBlock 把它**留在回话里**（见 timelineOf 的注释）
      if (evt.status !== '完成') {
        const why = firstMeaningfulLine(evt.error) || '运行失败';
        add('bad', `${why}（退出码 ${evt.exitCode}）`);
      }
      stop(evt.status);
    },
    // 出错**不关连接**：EventSource 自带断线重连，而服务端 subscribe() 会把这次运行
    // 缓存过的事件重放一遍（含 __done），所以重连本身就能把状态补齐。
    // 这里只补一次状态查询，兜「服务重启 → 运行已不在内存里 → 重连拿到 404」这一种情况。
    onReconnect: async () => {
      if (stopped) return;
      try {
        const d = await api('/api/conversations/' + encodeURIComponent(convId));
        if (d.conversation.status !== '跑中') stop(d.conversation.status);
      } catch { /* 服务不可达：让 EventSource 自己继续重试 */ }
    },
  });
}

/**
 * 订阅一次运行的实时输出 —— **对话场景只写一遍**。
 *
 * 现在有两处对话：消息模块的会话、流程实例页的节点对话。两边都要
 * "边跑边看、跑完收尾"，以前各写一份，于是改一处漏一处
 * （「正在输入中」不亮、要刷新才看到回复，都是这么来的）。
 *
 * 事件是**分块**推的（不是逐 token），所以文本块按顺序追加即可，不用自己攒。
 *
 * @param {string} runId
 * @param {object} h
 *   onText(chunk)        他的回话（追加）
 *   onRunError(message)  运行报错
 *   onThinking(text)     思考（调用方自己决定显不显示）
 *   onTool(name)         工具调用
 *   onDone(evt)          **唯一收尾出口**：{ status, error, exitCode }
 *   onReconnect()        断线（EventSource 自己会重连，这里问一次服务端兜底）
 * @returns {{ close: () => void }}
 */
function streamRun(runId, h = {}) {
  let closed = false;
  const es = new EventSource('/api/runs/' + encodeURIComponent(runId) + '/stream');
  const close = () => {
    if (closed) return;
    closed = true;
    es.close();
  };
  es.onmessage = (e) => {
    let evt;
    try {
      evt = JSON.parse(e.data);
    } catch {
      return;
    }
    if (evt.type === '__done') {
      close();
      return h.onDone?.(evt);
    }
    if (evt.type === 'text') return h.onText?.(evt.text);
    if (evt.type === 'error') return h.onRunError?.(evt.message);
    if (evt.type === 'thinking') return h.onThinking?.(evt.text);
    if (evt.type === 'tool') return h.onTool?.(evt.name);
  };
  es.onerror = () => {
    if (!closed) h.onReconnect?.();
  };
  return { close };
}

function setBusy(busy) {
  const isGroup = S.conversation?.kind === 'group';
  // **忙的时候不是"把发送禁用"，是"换成停止生成"** ——
  // 以前只写 `disabled = true`，于是"他还在说…"的时候除了干等没有任何出路（用户实报）。
  // 跟节点对话栏那颗方块按钮同一个语义，判断方式也一样（看按钮自己的 class，不依赖外部状态）。
  const btn = $('send');
  btn.disabled = false;
  btn.textContent = busy ? '停止生成' : '发送';
  btn.classList.toggle('stopping', !!busy);
  btn.title = busy ? '掐掉这一轮（他已经说出来的话会留着）' : '发送';
  $('input').placeholder = busy
    ? '他还在说…（要打断就点「停止生成」）'
    : isGroup
      ? '说点什么…（@某人 让他干活；不 @ 就找群主）'
      : '说点什么…（Enter 发送，Shift+Enter 换行）';
  $('hint').textContent = busy
    ? '一次只跑一条。要打断就点「停止生成」。'
    : isGroup
      ? '在输入框里打 @ 就会弹出群成员；不 @ 就找群助手。'
      : '';
}

/* ---------------------------------------------------- 输入框里的 @ 选人 */

const mentionPop = { open: false, start: 0, index: 0, matches: [] };

function mentionCandidates() {
  const c = S.conversation;
  return c && c.kind === 'group' ? c.members : [];
}

/** 光标前如果是一个还没写完的 @词，就弹出成员列表 */
function updateMentionPop() {
  const el = $('input');
  const members = mentionCandidates();
  if (!members.length) return closeMentionPop();

  const caret = el.selectionStart ?? el.value.length;
  const before = el.value.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return closeMentionPop();

  const token = before.slice(at + 1);
  if (/\s/.test(token)) return closeMentionPop(); // @ 后面出现空白，说明这句不是在提人

  const q = token.toLowerCase();
  const matches = members.filter((m) => m.name.toLowerCase().includes(q));
  if (!matches.length) return closeMentionPop();

  mentionPop.open = true;
  mentionPop.start = at;
  mentionPop.matches = matches;
  if (mentionPop.index >= matches.length) mentionPop.index = 0;

  $('mentionPop').innerHTML = `
    <div class="mp-head"><span>选择提醒的人</span><span>↑↓ 选择 · Enter 确认</span></div>
    <div class="mp-list">${matches
      .map((m, i) => {
        const isAssistant = S.conversation?.assistantPersonaId === m.personaId;
        return `<div class="mp-item${i === mentionPop.index ? ' active' : ''}" data-i="${i}">
          <div class="mp-avatar">${esc(initial(m.name))}</div>
          <div class="mp-name">${esc(m.name)}</div>
          ${isAssistant ? '<span class="mp-tag">群助手</span>' : ''}
        </div>`;
      })
      .join('')}</div>`;
  $('mentionPop').classList.add('open');
  $('mentionPop').querySelectorAll('[data-i]').forEach((node) => {
    // mousedown 而不是 click：避免 textarea 先失焦把列表关掉
    node.onmousedown = (e) => { e.preventDefault(); insertMention(Number(node.dataset.i)); };
  });
}

function closeMentionPop() {
  mentionPop.open = false;
  mentionPop.matches = [];
  $('mentionPop').classList.remove('open');
}

function insertMention(i) {
  const m = mentionPop.matches[i];
  if (!m) return;
  const el = $('input');
  const caret = el.selectionStart ?? el.value.length;
  const head = el.value.slice(0, mentionPop.start);
  const tail = el.value.slice(caret);
  const inserted = '@' + m.name + ' ';
  el.value = head + inserted + tail;
  const pos = head.length + inserted.length;
  el.setSelectionRange(pos, pos);
  el.focus();
  closeMentionPop();
}

/* -------------------------------------------------------------- 员工详情 */

async function openDetail(personaId) {
  // 上一页可能还有没落盘的改动（自动保存是防抖的）—— 先存完再画新页
  if (flushDetailSave) {
    const f = flushDetailSave;
    flushDetailSave = null;
    try { await f(); } catch { /* 存不上也别挡着开页面 */ }
  }
  setRoute('persona', { id: personaId });
  if (S.es) { S.es.close(); S.es = null; S.running = false; setBusy(false); }
  /*
   * 任务那条路**单独取、并行取**：
   *   · 它要扫全部会话与流程，比"配置"重；
   *   · 取不到（老版本服务端、路子断了）只该让「任务」那一页说一声，
   *     不该把整个员工详情拖黑 —— 配置还得能改。
   */
  const [d, tasks] = await Promise.all([
    api('/api/personas/' + encodeURIComponent(personaId)),
    api('/api/personas/' + encodeURIComponent(personaId) + '/tasks').catch((e) => ({ error: e.message })),
  ]);
  S.persona = d.persona;
  showView('detail');
  renderList();
  renderDetail(d, tasks);
}

/** 技能图标（书本）——两处列表共用 */
const SKILL_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6.6C10.4 5.2 8.4 4.6 5.8 4.6H4.2v13.2h2c2.3 0 4.2.6 5.8 2 1.6-1.4 3.5-2 5.8-2h2V4.6h-1.6C15.6 4.6 13.6 5.2 12 6.6z"/><path d="M12 6.6v13.2"/></svg>';

/* ------------------------------------------------ 员工详情 →「任务」 */

/**
 * 员工详情里的任务页：**只读**，数据跟任务看板**同一批行**（服务端 `personaTasks` 按人筛过）。
 *
 * 为什么不照看板那样横着铺六列：这一页是主区的一栏，宽度放不下；
 * 所以竖着分成几堆，但**堆的顺序照看板的生命周期**（要人管在前、已完成在后）——
 * 人在这页要回答的问题就一句："他现在手上有什么、哪件卡着"。
 */
const PERSONA_TASK_GROUPS = [
  { label: '要人管', hint: '停下等人 · 失败 · 待人确认', cols: ['blocked', 'failed', 'confirm'] },
  { label: '进行中', cols: ['doing'] },
  { label: '还没开跑', hint: '待办 · 想法', cols: ['todo', 'idea'] },
  { label: '已完成', cols: ['done'] },
  { label: '其他', cols: ['other'] },
];

/**
 * 一张卡：长相跟看板那张**一样**（同一套 `.kb-card` 样式），但**不给拖、不给删**。
 * 员工详情回答的是"他手上有什么"，改状态、删卡该回看板去做 —— 两处都能改就会互相打脸。
 *
 * 卡片上不写执行人：这一页里的每一张都是他的。
 */
function personaTaskCard(r) {
  const local = r.source === 'manual' || r.source === 'repo';
  const srcCls = r.source === 'chat' ? ' chat' : r.source === 'repo' ? ' repo' : local ? ' manual' : '';
  // 点卡片去哪儿：流程 → 那条实例；有会话 → 那场对话；手工卡没派活 → 它所在项目的看板
  const attr = r.source === 'flow'
    ? ` data-pt-flow="${esc(r.flow_id)}" data-pt-tpl="${esc(r.template_id || '')}"`
    : r.conversation_id
      ? ` data-pt-conv="${esc(r.conversation_id)}"`
      : r.project_id
        ? ` data-pt-proj="${esc(r.project_id)}"`
        : '';
  // 站在一个人的页面上，"这是哪个项目的活"比"哪来的"更该先看见 —— 所以项目标签在最前
  const proj = r.project_id
    ? `<span class="kb-tag proj" title="属于哪个项目">${esc(r.project_name)}</span>`
    : '<span class="kb-tag" title="没挂项目也没落在任何项目目录下">未归属</span>';
  return `<article class="kb-card${local ? ' manual' : ''}"${attr} title="${esc(r.note || '')}">
    <div class="kb-card-top">${proj}<span class="kb-tag${srcCls}">${esc(r.source_text)}</span>${prPillOf(r)}
      <span class="kb-state">${esc(r.status)}</span></div>
    <div class="kb-card-title">${esc(r.task)}</div>
    <div class="kb-card-foot"><span>${esc(r.at)}</span></div>
  </article>`;
}

/**
 * 任务页的正文（不含合计那行）。`b` = `/api/personas/:id/tasks` 的返回，
 * 形状跟任务看板一模一样（`board()` 的产物），所以这里只做"重新分堆"这一件事。
 */
function personaTasksHtml(b) {
  if (!b) return '<div class="empty" style="padding:26px 4px">任务取不到</div>';
  if (b.error) return `<div class="empty" style="padding:26px 4px">任务取不到：${esc(b.error)}</div>`;
  if (!b.total) {
    return `<div class="empty" style="padding:30px 4px;line-height:1.9">
      ${esc(b.persona_name || '他')}手上还没有任务<br />
      <span class="dim">看板上建的卡指定他做、流程走到点他名的节点、或者他直接在会话里接了活 —— 都会算在这里。</span>
    </div>`;
  }
  const cols = new Map((b.columns ?? []).map((c) => [c.key, c]));
  const blocks = PERSONA_TASK_GROUPS.map((g) => {
    const cards = g.cols.flatMap((k) => cols.get(k)?.cards ?? []);
    if (!cards.length) return '';
    return `<div class="group-title">${esc(g.label)}<span class="pt-num">${cards.length}</span>${
      g.hint ? `<span class="pt-hint">${esc(g.hint)}</span>` : ''
    }</div>
    <div class="group pt-group"><div class="pt-cards">${cards.map(personaTaskCard).join('')}</div></div>`;
  }).join('');
  return `${blocks}
    <div class="pt-note">跟任务看板同源：<b>流程的每次办理</b> + <b>聊天最近一轮</b> + <b>一张手工卡</b>，各算一件。
      点卡片能跳到它本身（流程实例 / 会话 / 项目看板）。</div>`;
}

/** 任务卡片的点击：三种去向，跟看板上那套走的是同一批入口 */
function wirePersonaTaskLinks() {
  const view = $('detailView');
  if (!view) return;
  view.querySelectorAll('[data-pt-flow]').forEach((el) => {
    el.onclick = () => openFlowRun(el.dataset.ptTpl || null, el.dataset.ptFlow).catch((e) => toast(e.message, 'error'));
  });
  view.querySelectorAll('[data-pt-conv]').forEach((el) => {
    el.onclick = () => {
      // 先切视图：openConversation 只往 #chat 里写，不切视图的话内容写进隐藏页（看板上踩过）
      setNav('messages');
      openConversation(el.dataset.ptConv).catch((e) => toast(e.message, 'error'));
    };
  });
  view.querySelectorAll('[data-pt-proj]').forEach((el) => {
    el.onclick = () => openProjectDetail(el.dataset.ptProj).catch((e) => toast(e.message, 'error'));
  });
}


function renderDetail({ persona, runtimes, runs, platformRoot, skills: personaSkills = [], allSkills = [] }, taskBoard = null) {
  // 左栏顶上写「通讯录」（右页头已去掉；名字/岗位/头像/动作都在正文的 p-head 里）。
  // 只在"左栏就是通讯录"时写 —— 从聊天页头点「查看资料」进来时 S.nav 还是 messages，
  // 那一栏里是会话，标题写上「通讯录」会跟下面的列表对不上。
  // 2026-10-20 用户要求：通讯录详情**不做面包屑**，标题就固定「通讯录」。
  if (S.nav === 'contacts') setListTitle('通讯录');
  const rt = runtimes.find((r) => r.id === persona.runtime);
  // 身份/技能锁定（2026-10-23；2026-10-22 用户定：内置员工喜儿按专家团那个模式收编）
  // 两种来源同一套语义，判据与服务端 experts.lockKindOf 对齐：
  //   expert  = 专家库雇来的（固定 id 前缀 p-expert-），随专家包固定，出路是解聘后自建；
  //   builtin = 出厂的（喜儿），随平台固定，出路是另建一个员工。
  // 锁的只是「他是谁 + 他会什么」；运行时/沙箱/工作目录/模型/头像仍旧可改。
  const expertLocked = String(persona.id || '').startsWith('p-expert-');
  const builtinLocked = !expertLocked && !!persona.builtin;
  const identityLocked = expertLocked || builtinLocked;
  const lockHint = expertLocked
    ? '雇佣员工的名字、岗位与职责身份随专家包固定，不能修改 —— 想定制就解聘后自建一个员工。'
    : '喜儿是内置员工，名字、岗位与职责身份随平台固定，不能修改 —— 想按自己的需要定制，就另建一个员工。';
  let extraRoots = [];
  try { extraRoots = JSON.parse(persona.rootDirs || '[]'); } catch { extraRoots = []; }
  const runRows = runs.length
    ? runs.map((r) => `<tr>
        <td>${dt(r.startedAt)}</td>
        <td class="st-${esc(r.status)}">${esc(r.status)}</td>
        <td>${r.exitCode ?? '—'}</td>
        <td>${r.usage ? (r.usage.totalTokens ?? '—') : '—'}</td>
        <td>${r.endedAt ? Math.round((new Date(r.endedAt) - new Date(r.startedAt)) / 1000) + 's' : '—'}</td>
        <td class="dim">${esc(r.error || '')}</td>
      </tr>`).join('')
    : '<tr><td colspan="6" class="dim" style="padding-top:8px">还没有运行记录</td></tr>';

    $('detailView').innerHTML = `
    <div class="detail-body">
      <div class="p-head">
        ${personaAvatar(persona)}
        <div class="p-head-main">
          <h2><span id="dNameText">${esc(persona.name)}</span>${persona.builtin ? '<span class="pill builtin" title="出厂就在的员工：名字、岗位与职责身份随平台固定，不能删">内置</span>' : ''}<span class="pill role" id="dRolePill"${persona.role ? '' : ' style="display:none"'}>${esc(persona.role || '')}</span>${
            persona.busy
              ? `<span class="pill busy" id="dBusy" title="${esc(persona.busyLabel ?? '正在干活')}">${
                  persona.busyLabel ? '工作中·' + esc(persona.busyLabel) : '工作中'
                }</span>`
              : '<span class="pill" id="dBusy">空闲</span>'
          }</h2>
          <!-- 顶部那段职责描述（p-desc）按用户要求去掉了：下面「资料」里本来就有完整的「职责与身份设定」 -->
          <!-- 运行时放第二行（2026-10-17 用户要求）：名字旁边只留岗位和忙闲，引擎属于"配置"不是"身份" -->
          <div class="p-meta">
            <span class="pill">${esc(rt ? rt.label : persona.runtime === 'auto' ? '自动' : persona.runtime)}</span>
            <span class="pill">${esc(SANDBOX_LABEL[persona.sandbox] ?? persona.sandbox)}</span>
            <span class="pill">${personaSkills.length} 个技能</span>
            <span class="pill">最近运行 ${runs[0] ? dt(runs[0].startedAt) : '—'}</span>
          </div>
        </div>
        <div class="hero-actions">
          <button class="primary" id="dMsg">发消息</button>
          <div class="hero-more">
            <button type="button" class="hero-more-btn" id="dMore" title="更多操作">⋯</button>
            <div class="hero-more-menu" id="dMoreMenu" hidden>
              ${persona.builtin
                ? '<button class="danger" id="dDelete" disabled title="内置员工不能删（名字/职责/技能随平台固定）">内置 · 不可删</button>'
                : persona.id.startsWith('p-expert-')
                  ? // 专家库雇来的（固定 id p-expert-<key>）：走「解聘」—— 服务端同一条
                    // fire 路由（群助手占用会给 409 人话），再雇佣同一个 id 接上旧会话
                    '<button class="danger" id="dFire">解聘这个数字员工</button>'
                  : '<button class="danger" id="dDelete">删除这个数字员工</button>'}
            </div>
          </div>
        </div>
      </div>

      <div class="tabs">
        <button class="tab on" data-tab="overview">概览</button>
        <button class="tab" data-tab="tasks">任务<span class="tab-n" id="dTasksN">${taskBoard?.total ?? 0}</span></button>
        <button class="tab" data-tab="capability">能力<span class="tab-n">${personaSkills.length}</span></button>
        <button class="tab" data-tab="runs">运行记录<span class="tab-n">${runs.length}</span></button>
      </div>

      <section class="tab-panel" data-panel="overview">
        <div class="ov-layout">
          <nav class="ov-nav" aria-label="概览分区">
            <button type="button" class="on" data-ov="profile">资料</button>
            <button type="button" data-ov="exec">执行配置</button>
          </nav>
          <div class="ov-body">
            <section class="ov-panel" data-ov-panel="profile">
              <div class="group">
                ${
                  identityLocked
                    ? `<div class="hint-line">${lockHint}</div>`
                    : ''
                }
                <div class="form-row">
                  <div class="row-label">名字</div>
                  <input id="dName" value="${esc(persona.name)}" ${identityLocked ? `readonly title="${expertLocked ? '雇佣员工的名字随专家包固定' : '喜儿的名字随平台固定'}"` : ''} />
                </div>
                <div class="form-row">
                  <div class="row-label">岗位</div>
                  <div>
                    <input id="dRole" list="roleSuggest" placeholder="比如：研发（留空也行）" value="${esc(persona.role || '')}" ${identityLocked ? `readonly title="${expertLocked ? '雇佣员工的岗位随专家包固定' : '喜儿的岗位随平台固定'}"` : ''} />
                  </div>
                </div>
                <div class="form-row top">
                  <div class="row-label">职责与身份设定</div>
                  <div>
                    <!-- 预览/编辑（2026-10-21）：这个字段写少读多，默认预览。
                         预览渲染的是 textarea 现值（当前草稿），不是存库值 —— 编辑一半切过去不丢字 -->
                    <!-- 框头合成（2026-10-22 用户定稿）：字数 + 预览/编辑切段贴在框上沿当"框头"，
                         不再悬空一行 —— 右边不孤零零飘按钮，左边由字数补位不显空 -->
                    <div class="instr-wrap">
                      <div class="instr-head">
                        <div class="counter" id="dInstrCount"></div>
                        ${
                          /* 身份锁定：被锁员工（雇佣专家 / 内置喜儿）不画预览/编辑切换 —— 只读预览，下面的监听都带 ?. 兜底 */
                          identityLocked
                            ? ''
                            : `<div class="seg seg-sm" id="dInstrSeg">
                                <button type="button" data-m="view" class="on">预览</button>
                                <button type="button" data-m="edit">编辑</button>
                              </div>`
                        }
                      </div>
                      <div id="dInstrView" class="md-view"></div>
                      <!-- 高度不写死（2026-10-21）：随内容撑开（fitInstr），滚动只留外层页面 -->
                      <textarea id="dInstr" hidden ${identityLocked ? 'readonly' : ''}>${esc(persona.instructions)}</textarea>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <section class="ov-panel" data-ov-panel="exec" hidden>
              <div class="group">
                <div class="form-row">
                  <div class="row-label">Runtime</div>
                  <div id="dRuntimeMount"></div>
                </div>
                <div class="form-row">
                  <div class="row-label">权限（沙箱）</div>
                  <div id="dSandboxMount"></div>
                </div>
                <div class="form-row">
                  <div class="row-label">模型</div>
                  <div>
                    <div class="row-with-btn">
                      <div id="dModelComboMount" style="flex:1;min-width:0"></div>
                      <button type="button" id="dModelRefresh" title="重新向运行时取一次模型列表（CLI 那边清单变了就点它）">刷新</button>
                    </div>
                    <div class="counter left" id="dModelNote"></div>
                  </div>
                </div>
                <div class="form-row">
                  <div class="row-label">工作目录（主）</div>
                  <input id="dCwd" value="${esc(persona.cwd || '')}" />
                </div>
                <div class="form-row top">
                  <div class="row-label">附加目录</div>
                  <div>
                    <textarea id="dRoots" style="height:56px" placeholder="一行一个路径，例如 E:\\CodeSpace\\myproj">${esc(extraRoots.join('\n'))}</textarea>
                    <div class="counter">平台根自动附加，不用写：<code>${esc(platformRoot || '')}</code>；只有切回沙箱模式后这几行才真的有约束力。</div>
                  </div>
                </div>
                <div class="form-row">
                  <div class="row-label">思考过程</div>
                  <!-- 开关（2026-10-20 用户："改成开关，文案不要"；"鼠标悬停提示去掉"）：
                       开关本身就是状态，卡面与悬停都不留说明文字 -->
                  <label class="switch sm">
                    <input type="checkbox" id="dThink" ${persona.showThinking ? 'checked' : ''} /><span></span>
                  </label>
                </div>
              </div>
            </section>
          </div>
        </div>
      </section>

      <section class="tab-panel" data-panel="tasks" hidden>
        <div class="pt-head">
          <span class="pt-sum" id="dTasksSum"></span>
          <!-- 不用 .mini：那是 26×26 的单字方钮（测/改/停/卸），两个字放进去必折行（2026-10-20 截图） -->
          <button id="dTasksRefresh" title="重新取一次 —— 任务在别处变了（派了活、跑完一步）就点它">刷新</button>
        </div>
        <div id="dTasksBody"></div>
      </section>

      <section class="tab-panel" data-panel="capability" hidden>
        <div class="sk-head">
          <div>
            <b>分配给智能体</b>
            <div class="sk-hint">${
              expertLocked
                ? '雇佣员工的技能随专家包固定，不能添加、解绑或停用；不合适就解聘换人，想定制就自建一个员工。'
                : builtinLocked
                  ? '喜儿的技能随平台固定，不能添加、解绑或停用；想挂别的技能就另建一个员工。'
                  : '关闭＝暂停使用（仍保留分配）；解绑＝取消分配（技能还在库里）。'
            }</div>
          </div>
          ${identityLocked ? '' : '<button class="mini auto" id="linkSkill">＋ 添加技能</button>'}
        </div>
        <div class="sk-list" id="dSkills">
          ${
            personaSkills.length
              ? personaSkills
                  .map(
                    (l) => `<div class="sk-row">
                      <div class="sk-ico">${SKILL_ICON}</div>
                      <div class="sk-main">
                        <b>${esc(l.name)}</b>
                        <div class="sk-desc">${esc(descOf(l.name) || '（技能库里已经没有这个文件了）')}</div>
                      </div>
                      ${
                        /* 2026-10-22 用户要求去掉「随平台固定/随专家包固定」标签：锁定这件事
                           sk-head 的提示语已经说清楚了，每行再挂一个标签是重复 —— 锁定的行
                           什么都不挂（没有开关/解绑按钮，本身就是"动不了"的意思） */
                        identityLocked
                          ? ''
                          : `<label class="switch sm" title="${l.enabled ? '暂停使用（保留分配）' : '恢复使用'}">
                              <input type="checkbox" data-skill-toggle="${esc(l.name)}" ${l.enabled ? 'checked' : ''} /><span></span>
                            </label>
                            <button class="mini sm txt" data-unlink="${esc(l.name)}" title="解绑：只是不再分配给他，技能本身还在库里">解绑</button>`
                      }
                    </div>`,
                  )
                  .join('')
              : `<div class="sk-blank">${SKILL_ICON} ${
                  expertLocked
                    ? '专家包清单里的技能都被删了才会空 —— 解聘再雇佣会重新挂上。'
                    : builtinLocked
                      ? '内置技能目录丢了才会空 —— 技能库恢复后重启服务会重新挂上。'
                      : '还没分配技能。点右上角「＋ 添加技能」从库里挑。'
                }</div>`
          }
        </div>

        <!-- 从运行时继承：可折叠面板（默认折叠）。折叠时不扫描，展开第一次才去要列表，
             省得每个员工详情都白跑一遍 runtime-skills。状态记在 data-open 上，不进持久化 ——
             这种"列表长又低频看"的区块不值得占路由。 -->
        <div class="sk-fold" id="dInheritFold" data-open="0" style="margin-top:26px">
          <div class="sk-fold-head" id="dInheritHead" role="button" tabindex="0">
            <span class="fold-arrow" aria-hidden="true">▸</span>
            <span class="fold-title">
              <b>从运行时继承</b>
              <div class="sk-hint">自动从 <strong>${esc(rt ? rt.label : persona.runtime)}</strong> 发现；只要该智能体在这个运行时执行，就可以直接使用。</div>
            </span>
            <button class="mini auto" id="skRefresh" title="重新扫描运行时的技能目录">刷新</button>
          </div>
          <div class="sk-fold-body" id="dInheritBody" hidden>
            <div class="sk-list" id="dInherit"></div>
          </div>
        </div>
        ${
          personaSkills.length > 8
            ? '<div class="rm-hint">挂了 8 个以上：首轮清单会变长，模型「选得准」也会下降。建议改成"换"而不是"堆"。</div>'
            : ''
        }
      </section>

      <section class="tab-panel" data-panel="runs" hidden>
        <div class="group-title">最近运行</div>
        <div class="group">
          <table class="runs"><thead><tr>
            <th>时间</th><th>状态</th><th>退出码</th><th>tokens</th><th>耗时</th><th>错误</th>
          </tr></thead><tbody>${runRows}</tbody></table>
        </div>
      </section>
    </div>`;
  // 标签：一次渲染、切显隐 —— 不重建 DOM，所以在「概览」改了一半去「能力」再回来，改动还在
  const tabs = $('detailView').querySelectorAll('[data-tab]');
  const panels = $('detailView').querySelectorAll('[data-panel]');
  const showTab = (key) => {
    tabs.forEach((t) => t.classList.toggle('on', t.dataset.tab === key));
    panels.forEach((p) => { p.hidden = p.dataset.panel !== key; });
  };
  tabs.forEach((t) => {
    t.onclick = () => {
      if (t.dataset.tab !== 'overview') saveNow?.(); // 去别的标签前先把概览的改动落盘
      showTab(t.dataset.tab);
    };
  });
  showTab('overview');

  /*
   * 任务页：数据是**打开这一页那一刻**取的快照（跟「运行记录」一样）。
   * 「刷新」只换这一页里的三块（合计 / 列表 / 标签上的数），**不重画整页** ——
   * 重画会把标签弹回「概览」，人刚翻到任务页就被弹走，比不刷新更烦。
   */
  let tasksData = taskBoard;
  const paintTasks = () => {
    const sum = $('dTasksSum');
    if (sum) {
      sum.innerHTML = !tasksData || tasksData.error
        ? `任务取不到${tasksData?.error ? `：${esc(tasksData.error)}` : ''}`
        : `共 <b>${tasksData.total ?? 0}</b> 件${tasksData.project_count ? ` · 分布在 ${tasksData.project_count} 个项目` : ''}`;
    }
    const body = $('dTasksBody');
    if (body) body.innerHTML = personaTasksHtml(tasksData);
    const n = $('dTasksN');
    if (n) n.textContent = String(tasksData?.error ? '—' : (tasksData?.total ?? 0));
    wirePersonaTaskLinks();
  };
  paintTasks();

  $('dTasksRefresh')?.addEventListener('click', async (e) => {
    e.preventDefault();
    const btn = $('dTasksRefresh');
    btn.disabled = true;
    btn.textContent = '刷新中…';
    try {
      tasksData = await api('/api/personas/' + encodeURIComponent(persona.id) + '/tasks');
    } catch (err) {
      tasksData = { error: err.message };
    } finally {
      btn.disabled = false;
      btn.textContent = '刷新';
      paintTasks();
    }
  });

  /* ---------------- 自动保存（2026-10-18 用户要求：不再点「保存」） ----------------
   * 这里只放骨架：真正的 saveNow 在 combos 建好后再赋值（它要读三个下拉的当前值）。
   * 输入框防抖 700ms；下拉选完 300ms；失焦 / 切分区 / 切标签 / 离开页面立刻 flush。 */
  const saveStateEl = $('dSaveState');
  const setSaveState = (text, kind = '') => {
    if (!saveStateEl) return;
    saveStateEl.textContent = text;
    saveStateEl.className = 'save-state' + (kind ? ' ' + kind : '');
  };
  let saveTimer = null;
  let saveNow = null;      // combos 建好后赋值
  let saveQueued = false;  // 保存中又来一次改动 → 存完再补一次（串行，不并发打 PUT）
  const scheduleSave = (ms = 700) => {
    setSaveState('未保存…', 'wait');
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; saveNow?.(); }, ms);
  };

  // 模型：带搜索（23 个起步，不搜找不到）；Runtime / 权限选项少，不带搜索
  const modelCombo = createCombo({
    mount: $('dModelComboMount'),
    items: [{ id: '', label: '（用 CLI 默认）' }],
    value: String(persona.model ?? '').trim(),
    search: true,
    placeholder: '搜模型…（id 或显示名）',
    empty: '没有匹配的模型',
    onChange: () => scheduleSave(300),
  });

  /**
   * 模型下拉的清单 —— **直接问运行时**（服务端去读 CLI 自己那份配置），不再走账本。
   *
   * 为什么按运行时问：模型列表在 CLI 背后的服务端手里，不在班底手里。
   * 每个族问法不同（codex 读本地目录文件、dsh 发一次 HTTP、claude 只有几个别名），
   * 这些差异由服务端的 cli-models 收拾掉。
   *
   * ⚠️ 读不到时**不能把下拉清空**：那样连原来绑着的模型都不见了，人只看到一个空框。
   * 降级成"保留当前值 + 一句说明"，并且允许手工填名字。
   *
   * `align`：**用户主动换运行时**时要"自动对齐"（2026-10-17 用户要求）。
   *   · 新运行时的清单里也有原来那个模型（codex 和 claude 接的是同一台 magpie，
   *     `workbuddy/hy3` 两边都有）→ 留着，什么都没变；
   *   · 没有 → 退回「用 CLI 默认」，**不**沿用原来那条「（清单里没有）xxx」：
   *     那种值一旦被静默保存下去，CLI 收到一个它不认识的模型名，跑起来才报错，
   *     人根本猜不到是"换运行时"留下的。
   * 打开页面时（align=false）仍然一律"不清空" —— 那是保护已在用的绑定，两回事。
   */
  const fillModels = async (runtimeId, { align = false } = {}) => {
    const note = $('dModelNote');
    if (note) note.textContent = ''; // 静默取，不在界面上写"正在取…"（见下方成功分支的注释）
    try {
      // fresh：这里可能是用户按了「刷新」，别吃 60 秒缓存
      const d = await readModelList(runtimeId, { fresh: true });
      const list = d.models ?? [];
      const cur = modelCombo.value();
      const known = list.some((m) => m.id === cur);
      // 换运行时、而新清单里没有它 → 对齐到"用 CLI 默认"
      const dropped = align && !!cur && !known;
      const keep = dropped ? '' : cur;
      // 「用 CLI 默认」后面带上**真实**的默认模型名（2026-10-17）：只写"默认"的话，
      // 人根本不知道它落到哪个模型上 —— 用户就问过"claude code 现在的真实模型是什么"。
      const items = [{ id: '', label: d.defaultModel ? `（用 CLI 默认：${d.defaultModel}）` : '（用 CLI 默认）' }];
      // 当前值不在清单里也要留着 —— 清单可能读不到，不能把人家绑着的模型弄丢
      if (keep && !known) items.push({ id: keep, label: `（清单里没有）${keep}` });
      items.push(...modelItems(list));
      // 第二个参数是 keepValue：对齐时要真的把值换成 ''，所以只在没对齐时才保留
      modelCombo.setItems(items, keep === cur);
      if (note) {
        // 成功时**不留任何说明文字**（2026-10-17 用户要求去掉）：
        // 「N 个可选，点开可以搜 / 原来选的 X 这个运行时没有 / （codex 自己的模型目录（provider：magpie））」
        // 这些都属于解释性描述，下拉自己会说话。只在取不到清单时才提示，那是真需要人知道的事。
        note.textContent = list.length ? '' : (d.error ?? '这个运行时的清单是空的') + ' —— 模型名也可以直接填';
      }
    } catch (err) {
      // 读不到就降级：别清空下拉，让人至少还能看见当前值、还能手工填
      if (note) {
        note.textContent = `取不到模型列表（${err.message}）—— 模型名可以手工填`;
        note.title = err.explained ? '' : (err.detail || '');
      }
    }
  };

  const sbCombo = createCombo({
    mount: $('dSandboxMount'),
    items: sandboxItems(rt),
    value: persona.sandbox,
    search: false,
    onChange: () => scheduleSave(300),
  });
  /*
   * 运行时清单。内置员工多一条「自动」—— 她的 runtime 是 'auto'（换机器、换 CLI 都不用改她），
   * 不给这一条，下拉里就没有当前值，看着像"没配"，一保存还会落到第一个运行时上。
   * 普通员工不给：对他们来说"用哪个引擎"是要自己决定的，不该有个含糊的自动选项。
   */
  const rtItems = runtimes.map((r) => ({ id: r.id, label: r.label }));
  if (persona.builtin) rtItems.unshift({ id: 'auto', label: '自动（挑一个能用的）' });

  const rtCombo = createCombo({
    mount: $('dRuntimeMount'),
    items: rtItems,
    value: persona.runtime,
    search: false,
    onChange: (id) => {
      const r = runtimes.find((x) => x.id === id);
      const items = sandboxItems(r);
      const keep = items.some((it) => it.id === sbCombo.value()) ? sbCombo.value() : items[0]?.id ?? '';
      sbCombo.setItems(items, false);
      sbCombo.setValue(keep);
      // 换了运行时：清单跟着换，对不上的模型顺带对齐；**对齐完再存** —— 否则会把旧模型名存给新运行时
      fillModels(id, { align: true }).finally(() => scheduleSave(300));
    },
  });
  // auto 没有自己的模型清单 —— 问它只会拿到一个 404，在界面上写成"取不到模型列表"纯属误导
  if (persona.runtime === 'auto') {
    const note = $('dModelNote');
    if (note) note.textContent = '运行时是自动挑的，模型跟着它自己的默认走';
  } else {
    fillModels(persona.runtime);
  }

  /*
   * 「刷新」：清单是**打开页面那一刻**取的，运行时那边后来加了模型这边不知道 —— 点一下重新问一次。
   * 复用 `fillModels`（它自己就带着"取不到不清空"的降级），只是把按钮按住防连点。
   */
  $('dModelRefresh')?.addEventListener('click', async (e) => {
    e.preventDefault();
    const btn = $('dModelRefresh');
    btn.disabled = true;
    btn.textContent = '刷新中…';
    try {
      await fillModels(rtCombo.value());
    } finally {
      btn.disabled = false;
      btn.textContent = '刷新';
    }
  });

  const instrCount = $('dInstrCount');
  const dInstrTA = $('dInstr');
  /*
   * 自增高（2026-10-21 用户要求）：textarea 有多高显示多高，不给自己滚 ——
   * 滚动条只留外层页面一条。hidden 时 scrollHeight 是 0，跳过（切进编辑态时会再算）。
   */
  const fitInstr = () => {
    if (dInstrTA.hidden) return;
    dInstrTA.style.height = 'auto';
    dInstrTA.style.height = `${dInstrTA.scrollHeight}px`;
  };
  const syncCount = () => { if (instrCount) instrCount.textContent = dInstrTA.value.trim().length + ' 字'; };
  dInstrTA.addEventListener('input', () => { syncCount(); fitInstr(); });
  syncCount();

  /*
   * 「职责与身份设定」预览/编辑（2026-10-21）：人设这类 markdown **写少读多**，默认预览。
   *   · 预览渲染的是 textarea **现值**（当前草稿）—— 编辑一半切过去看到的就是刚写的，
   *     切回编辑一个字不少；不读存库值，就不存在"预览回滚"的坑。
   *   · 切回预览顺手 saveNow 一次：自动保存靠失焦/防抖，切换这个动作兜个底。
   *   · 空内容给占位 +「写一段」直达编辑，不留一块白板让人猜。
   */
  const dInstrEl = $('dInstr');
  const dInstrViewEl = $('dInstrView');
  let instrMode = 'view';
  const renderInstrView = () => {
    const val = dInstrEl.value;
    dInstrViewEl.innerHTML = val.trim()
      ? mdRender(val)
      : /* 身份锁定：雇佣员工不给「写一段」入口（本来也不该走到空值这一支） */
        expertLocked
        ? '<div class="md-empty">暂无设定。</div>'
        : '<div class="md-empty">暂无设定。<button type="button" class="linkish" data-edit-instr>写一段</button></div>';
  };
  const setInstrMode = (m) => {
    if (m === instrMode) return;
    instrMode = m;
    if (m === 'view') {
      renderInstrView();
      dInstrEl.hidden = true;
      dInstrViewEl.hidden = false;
      saveNow?.();
    } else {
      dInstrViewEl.hidden = true;
      dInstrEl.hidden = false;
      fitInstr();
      dInstrEl.focus();
    }
    $('dInstrSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
  };
  // 身份锁定：雇佣员工没有 #dInstrSeg（上面不画），监听挂不上就跳过
  $('dInstrSeg')?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-m]');
    if (b) setInstrMode(b.dataset.m);
  });
  dInstrViewEl.addEventListener('click', (e) => {
    if (e.target.closest('[data-edit-instr]')) setInstrMode('edit');
  });
  renderInstrView();

  /*
   * 「发消息」= **开一段新的 1:1 会话**（2026-10-20，PRD P0-4）。
   * 一次任务一段，上下文不串味 —— 不再复用这个人最近那段（那是 `POST /api/personas/:id/open`
   * 的语义，服务端实现保留不动，只是详情页不再走它）。
   *
   * 连点保护（P1-2，主理人已拍板"复用"）：当前就停在这个人一段**一条消息都没有**的会话上
   * → 直接复用它，不再堆空壳。判断依据是 openConversation 本来就取到的 `d.messages`
   * （见 S.convEmpty）—— 零额外请求、零新字段。
   */
  const toMessages = async () => {
    try {
      /*
       * 复用判据末尾多一个"这段还在列表里"：被「不显示」收着的空会话**不复用** ——
       * 复用既不新建也不发消息，这段就永远没有回列表的机会（用户实报，
       * 群那侧先踩到：发起会话后列表里一直不出现，见 toGroupMessages）。
       * 不复用就会走下面的新建，新会话不带 hiddenAt，行自然回来。
       */
      const reuse =
        !!S.conversation &&
        S.conversation.kind === 'direct' &&
        S.conversation.personaId === persona.id &&
        S.convEmpty &&
        (S.conversations ?? []).some((c) => c.id === S.conversation.id);
      const convId = reuse
        ? S.conversation.id
        : (await post('/api/conversations', { personaId: persona.id, title: `和 ${persona.name}` })).conversation.id;
      setNav('messages');
      showView('chat');
      /*
       * 走 `openConversationSafe`：复用分支打开的那段，可能刚好被**另一个窗口**删掉了
       * （E2047）—— 那里会关抽屉、清右栏、刷列表，还会说人话。
       * 之后要按"真的打开了没"决定收尾：没打开就别把光标扔进一个已经收起的输入区。
       */
      await openConversationSafe(convId);
      if (S.conversation?.id !== convId) return;
      await load();
      $('input').focus();
    } catch (err) { toastConvErr(err); }   // 建会话（POST）失败也走同一张人话表
  };
  $('dMsg').onclick = async () => { await saveNow?.(); toMessages(); };

  /**
   * 自动保存：**改了就算保存**，不再有「保存」按钮（2026-10-18 用户要求）。
   *
   * 分寸：
   *   · 输入框防抖 700ms；下拉选完 300ms；失焦立刻存；
   *     切分区 / 切标签 / 点「发消息」/ 打开别的员工 / 关页面 都先 flush（见 flushDetailSave）。
   *   · **不重画整页**：重画会丢焦点、把标签弹回概览；只把名字/岗位在页头和左栏同步一下。
   *   · 名字空着不提交（服务端 E1011 会拒），状态直接写"名字不能空"。
   *   · 保存中又来改动 → 存完补一次（串行；同时打两个 PUT 会互相覆盖）。
   */
  const collect = () => ({
    name: $('dName').value,
    role: $('dRole').value,
    instructions: $('dInstr').value,
    runtime: rtCombo.value(),
    sandbox: sbCombo.value(),
    model: modelCombo.value(),
    cwd: $('dCwd').value,
    rootDirs: $('dRoots').value.split('\n').map((s) => s.trim()).filter(Boolean),
    showThinking: $('dThink').checked,
  });
  let lastSaved = JSON.stringify(collect());
  let saving = false;

  saveNow = async ({ keepalive = false } = {}) => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    const payload = collect();
    if (!payload.name.trim()) { setSaveState('名字不能空 · 未保存', 'bad'); return false; }
    const json = JSON.stringify(payload);
    if (json === lastSaved) { setSaveState('已保存', 'ok'); return true; }
    if (saving) { saveQueued = true; return false; }
    saving = true;
    setSaveState('保存中…', 'wait');
    try {
      const d = await api('/api/personas/' + encodeURIComponent(persona.id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: json,
        ...(keepalive ? { keepalive: true } : {}),
      });
      lastSaved = JSON.stringify(payload);
      const p = d?.persona;
      if (p) {
        S.persona = { ...(S.persona || {}), ...p };
        // 页头（名字 / 岗位 / 头像）与左栏名字同步 —— 不重画整页
        const nameEl = $('dNameText');
        if (nameEl) nameEl.textContent = p.name;
        const roleEl = $('dRolePill');
        if (roleEl) { roleEl.textContent = p.role || ''; roleEl.style.display = p.role ? '' : 'none'; }
        const av = $('detailView')?.querySelector('.p-head .avatar');
        if (av) av.textContent = initial(p.name);
        // 左栏 / 会话里的名字也跟着变（只跟内存和左栏打交道，不重画详情页）
        (S.conversations || []).forEach((c) => { if (c.personaId === p.id) c.personaName = p.name; });
        if (S.conversation?.personaId === p.id) S.conversation.personaName = p.name;
        if (S.nav === 'contacts' || S.nav === 'messages') {
          // 左栏标题固定「通讯录」（不做面包屑，2026-10-20）—— 改名不用再同步标题，
          // 只有左栏真是通讯录时才要管；在消息页那一栏是会话（从聊天页头点进资料会停在这条路）。
          renderList();
        }
      }
      setSaveState('已保存', 'ok');
      return true;
    } catch (err) {
      setSaveState('保存失败：' + (err?.message ?? '服务异常'), 'bad');
      console.error('[班底] 员工自动保存失败', err?.detail ?? err);
      return false;
    } finally {
      saving = false;
      if (saveQueued) { saveQueued = false; saveNow?.(); }
    }
  };
  // 离开这一页（切视图 / 打开别的员工 / 关窗口）前兜底存一次
  flushDetailSave = (opts) => saveNow(opts);

  // 输入框：敲字防抖；失焦立刻存（没改动时 saveNow 按 lastSaved 直接跳过）
  for (const id of ['dName', 'dRole', 'dInstr', 'dCwd', 'dRoots']) {
    $(id)?.addEventListener('input', () => scheduleSave(700));
    $(id)?.addEventListener('blur', () => saveNow?.());
  }
  $('dThink')?.addEventListener('change', () => scheduleSave(200));

  // 概览左侧分区：资料 / 执行配置（切之前先 flush —— 藏起来的那一栏也得先落盘）
  const ovBtns = $('detailView').querySelectorAll('[data-ov]');
  const ovPanels = $('detailView').querySelectorAll('[data-ov-panel]');
  const showOv = (key) => {
    ovBtns.forEach((b) => b.classList.toggle('on', b.dataset.ov === key));
    ovPanels.forEach((p) => { p.hidden = p.dataset.ovPanel !== key; });
  };
  ovBtns.forEach((b) => { b.onclick = () => { saveNow?.(); showOv(b.dataset.ov); }; });
  showOv('profile');

  /* 更多操作（⋯）：点开才露删除。删除是破坏性动作，平时收起来，别让它跟「发消息」平起平坐 */
  $('dMore')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const m = $('dMoreMenu');
    if (m) m.hidden = !m.hidden;
  });
  document.addEventListener('click', dMoreOutside);
  (window.__pageCleanups ??= []).push(() => {
    document.removeEventListener('click', dMoreOutside);
  });
  function dMoreOutside(e) {
    if (!e.target.closest?.('.hero-more')) { const m = $('dMoreMenu'); if (m) m.hidden = true; }
  }

  /**
   * 删员工。**破坏性**，所以先把要发生的事说清楚，再问。
   * 服务端还会拦一道：他是某个群的群助手就删不掉（得先换人）。
   *
   * 正文三行是 2026-10-20 用户逐字定稿的（原话「整段改成：…」），别再自己加/减：
   *   · 只说结果，不罗列"他的 N 段对话"—— 段数会变，数字一变文案就显得在哄人；
   *   · 第三行带括号，是"可能删不掉"的前置条件，语气上是备注而不是步骤。
   * 「删掉数字员工「X」？」从正文提到了**标题**：正文被定稿成三行后，
   * 不点明删谁的破坏性弹窗只剩一句「该操作」，用户得自己回想刚才点了什么。
   */
  /**
   * 解聘（专家库雇来的员工，⋯菜单里那项）。走专家域的 fire 路由（群助手占用、
   * 固定 id 再雇佣接旧会话都是它管），收尾跟删除一样：别留指向已解聘员工的面板。
   */
  $('dFire')?.addEventListener('click', async () => {
    const key = String(persona.id).slice('p-expert-'.length);
    const ok = await fireExpert(key, { stayContacts: true, name: persona.name });
    if (ok === false) return;
    setNav('contacts');
  });

  $('dDelete') && ($('dDelete').onclick = async () => {
    const ok = await confirmDo(
      `该操作将清空其配置、技能、群关联。\n` +
        `已有对话仅可读，不能继续聊天；会话可后续删除或归档。\n` +
        `（当其作为群助手时无法直接删除，需先更换群助手。）`,
      { title: `删掉数字员工「${persona.name}」？` },
    );
    if (!ok) return;
    try {
      await api('/api/personas/' + encodeURIComponent(persona.id), { method: 'DELETE' });
      // 别留一个指向已删员工的面板：会话、光标、输入区全部复位
      S.persona = null;
      S.conversation = null;
      await load();
      $('chat').innerHTML = '<div class="empty">还没有对话</div>';
      $('chatHead').innerHTML = '<span class="dim" style="padding:6px 0">左边选一个人，开始说话</span>';
      setComposer(false);
      setNav('contacts');
    } catch (err) { toast(err.message, 'error'); }
  });

  /** 技能说明：从库里查（挂在员工上的可能已经不在库里了）。
   *  写成函数声明：上面的模板就会用到它，const 会有 TDZ 问题 */
  function descOf(name) {
    return (allSkills.find((s) => s.name === name) ?? {}).description ?? '';
  }

  // 技能关联是**独立动作**，点完立刻生效，不跟"保存"混在一起
  // （挂载关系跟群成员一样是张多对多表，用"改完再保存"反而容易互相覆盖）
  $('dSkills').querySelectorAll('[data-unlink]').forEach((el) => {
    el.onclick = async () => {
      try {
        await api(
          `/api/personas/${encodeURIComponent(persona.id)}/skills/${encodeURIComponent(el.dataset.unlink)}`,
          { method: 'DELETE' },
        );
        await openDetail(persona.id);
      } catch (err) { toast(err.message, 'error'); }
    };
  });
  $('dSkills').querySelectorAll('[data-skill-toggle]').forEach((el) => {
    el.onchange = async () => {
      try {
        await api(
          `/api/personas/${encodeURIComponent(persona.id)}/skills/${encodeURIComponent(el.dataset.skillToggle)}`,
          { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: el.checked }) },
        );
        await openDetail(persona.id);
      } catch (err) { toast(err.message, 'error'); el.checked = !el.checked; }
    };
  });
  const linkBtn = $('linkSkill');
  if (linkBtn) linkBtn.onclick = () => openLinkSkillDialog(persona, allSkills, personaSkills.map((l) => l.name));

  // 从运行时继承：只发现、不改 CLI 的文件；"导入"才是把它拷进班底的库。
  // 折叠面板默认收起 —— 展开那一刻才扫描（懒加载），折叠状态下不发请求；
  // 「刷新」只在面板已展开时触发扫描，收起状态点它先展开再扫。
  const fold = $('dInheritFold');
  const body = $('dInheritBody');
  const loadInherited = async () => {
    const box = $('dInherit');
    if (!box) return;
    box.innerHTML = '<div class="sk-empty" style="border-style:solid">正在扫描…</div>';
    try {
      const d = await api('/api/personas/' + encodeURIComponent(persona.id) + '/runtime-skills');
      const found = d.found ?? [];
      box.innerHTML = found.length
        ? found
            .map(
              (s) => `<div class="sk-row">
                <div class="sk-ico">${SKILL_ICON}</div>
                <div class="sk-main">
                  <b>${esc(s.name)}</b>
                  <div class="sk-desc">${esc(cut(s.description, 90) || '（没写描述）')}</div>
                </div>
                <button class="mini auto" data-inherit="${esc(s.name)}" data-dir="${esc(s.dir)}"
                        title="拷进班底的技能库，之后就能分配给员工、也能改">导入</button>
              </div>`,
            )
            .join('')
        : `<div class="sk-empty">${SKILL_ICON} 该运行时中没有发现本地 skill。` +
          (d.dirs?.length ? `（找过 ${esc(d.dirs.join('、'))}）` : '（这个运行时没有已知的技能目录）') +
          '</div>';
      box.querySelectorAll('[data-inherit]').forEach((el) => {
        el.onclick = async () => {
          el.disabled = true;
          el.textContent = '导入中…';
          try {
            await post('/api/skills/import', { dirs: [el.dataset.dir + '\\' + el.dataset.inherit], overwrite: false });
            await load();
            await openDetail(persona.id);
          } catch (err) { el.disabled = false; el.textContent = '导入'; toast(err.message, 'error'); }
        };
      });
    } catch (err) {
      box.innerHTML = '<div class="sk-empty">扫描失败：' + failHtml(err) + '</div>';
    }
  };
  const setFold = (open) => {
    fold.dataset.open = open ? '1' : '0';
    body.hidden = !open;
    $('dInheritHead').querySelector('.fold-arrow').textContent = open ? '▾' : '▸';
    if (open && !body.dataset.loaded) {
      body.dataset.loaded = '1';
      loadInherited();
    }
  };
  $('dInheritHead').onclick = (e) => {
    if (e.target.closest('#skRefresh')) return; // 刷新是独立动作，别顺带折叠
    setFold(fold.dataset.open !== '1');
  };
  $('dInheritHead').onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFold(fold.dataset.open !== '1'); }
  };
  const refresh = $('skRefresh');
  if (refresh)
    refresh.onclick = () => {
      setFold(true); // 收着就点刷新 = 展开并重扫
      loadInherited();
    };
}


/* ------------------------------------------------------------ 关联技能 */

let linkCandidates = [];
const linkPicked = new Set();
let linkPersonaId = null;

function renderLinkList() {
  const q = ($('lkSearch').value || '').trim().toLowerCase();
  const rows = linkCandidates.filter(
    (s) => !q || s.name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q),
  );
  $('lkList').innerHTML = rows.length
    ? rows
        .map(
          (s) => `<label class="member">
            <input type="checkbox" value="${esc(s.name)}" ${linkPicked.has(s.name) ? 'checked' : ''} />
            <span>${esc(s.name)}</span><em>${esc(cut(s.description, 44) || '（未写描述）')}</em>
          </label>`,
        )
        .join('')
    : '<div class="dim" style="padding:10px 2px">没找到</div>';
  $('lkList').querySelectorAll('input').forEach((el) => {
    el.onchange = () => { if (el.checked) linkPicked.add(el.value); else linkPicked.delete(el.value); };
  });
}

function openLinkSkillDialog(persona, allSkills, attached) {
  const have = new Set(attached);
  linkCandidates = allSkills.filter((s) => !have.has(s.name));
  if (!linkCandidates.length) return toast('库里的技能都已经关联了');
  linkPersonaId = persona.id;
  linkPicked.clear();
  $('lkSearch').value = '';
  renderLinkList();
  $('linkSkillDlg').showModal();
  setTimeout(() => $('lkSearch').focus(), 30);
}

$('lkSearch').oninput = renderLinkList;

$('lkOk').onclick = async (e) => {
  e.preventDefault();
  const names = [...linkPicked];
  if (!names.length) return;
  try {
    await post(`/api/personas/${encodeURIComponent(linkPersonaId)}/skills`, { names });
    $('linkSkillDlg').close();
    await searchRefreshDetail();
  } catch (err) { toast(err.message, 'error'); }
};

/** 关联改完：刷新列表 + 重画详情 */
async function searchRefreshDetail() {
  const id = linkPersonaId;
  await load();
  if (id) await openDetail(id);
}

/* ---------------------------------------------------------- 群成员宫格 */

function memberGridHTML(thread) {
  const q = S.memberQuery.trim().toLowerCase();
  const list = q ? thread.members.filter((m) => m.name.toLowerCase().includes(q)) : thread.members;

  const overflow = list.length > MEMBER_TILE_LIMIT;
  // 有溢出且没展开时，留两个位置给「添加 / 移除」磁贴
  const shown = overflow && !S.membersExpanded ? list.slice(0, MEMBER_TILE_LIMIT - 2) : list;

  const tiles = shown
    .map((m) => {
      const isAssistant = m.personaId === thread.assistantPersonaId;
      const removable = S.removeMode && !isAssistant;
      return `<div class="mtile${removable ? ' removable' : ''}"
                   title="${esc(m.name)} · ${esc(m.runtime)} · ${esc(m.sandbox)}"
                   ${removable ? `data-kick="${esc(m.personaId)}" data-name="${esc(m.name)}"` : ''}>
        <div class="mavatar">
          ${esc(initial(m.name))}
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
function wireMemberGrid(thread, repaint = paintDrawer, root = null) {
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

const MEMBER_TILE_LIMIT = 12;

/**
 * 群的身份。
 *
 * 群和群会话是**两张表**（2026-10-20 拆开：一个群可以有多段会话）：
 *   · 群对象（通讯录详情 / 群设置）→ `id` 就是群 id
 *   · 群会话（消息列表右键 / 聊天头部）→ `id` 是会话 id，群 id 在 `groupId` 上
 * 所有 `/api/groups/...` 都是群级接口，一律从这里取，**别直接写 thread.id**。
 */
const gidOf = (t) => t?.groupId || t?.id;

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
function openGroupDrawer(thread) {
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
function groupSettingsHTML(thread, opts = {}) {
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
function wireGroupSettings(thread, repaint, root) {
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

function paintDrawer() {
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
function dayBucket(iso) {
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
function logTime(iso) {
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
async function openChatLogDrawer(conv) {
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
function hasAnyMessage(c) {
  if (typeof c?.messageCount === 'number') return c.messageCount > 0;
  return !!c?.lastMessage;
}

/**
 * 聊天记录抽屉的正文。分流由 `paintDrawer()` 首行负责，这里只管画。
 *
 * 行数据**每次现算**（`S.conversations` 过滤），不缓存副本；**不排序** ——
 * `listConversations` 已经 `ORDER BY updatedAt DESC`。**不显示条数**（PRD v1.1 砍掉了）。
 */
function paintChatLogDrawer() {
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
async function deleteSessionFromLog(c) {
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
function paintGroupDetail(group) {
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
             也别平铺在页面底部 —— 收进菜单，点开才露。样式/交互照抄员工详情那套 hero-more -->
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
async function toGroupMessages(group) {
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

async function openGroupDetail(groupId) {
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

/* -------------------------------------------------------------- 专家库 */

/**
 * 专家库（2026-10-23 改版：左侧一级栏，整页分区卡片墙）：出厂写死的岗位专家（跟随
 * 服务端目录走，当前八位 —— 前端不写死数量和 key），
 * 点「雇佣」就是造一个现成的数字员工（职责、技能、运行时全都配好），解聘即删。
 *
 * 数据口径：
 *   · 目录从 `GET /api/experts` 拉一次缓存进 `S.experts`（null = 没拉过**或上一次没拉到**），
 *     雇佣/解聘后**整体重拉** —— hired 标记是服务端按库里有没有这个人算的，本地不推算；
 *   · 拉不到**不许装成空目录**（2026-10-21 用户截图实报：旧后端没有这个接口时，
 *     页面把错误画成"两段全空"，看着像专家库被清空了）。目录出厂恒有八位，
 *     null 一律按「加载失败」渲染错误卡 + 重试，让用户知道是出错了、不是没人。
 *   · 雇佣后他就是个**普通数字员工**（改名/改指令/摘技能都走员工详情那套既有接口），
 *     专家域只管雇与解，别在专家页重做一套员工编辑。
 */
async function loadExperts() {
  try {
    S.experts = (await api('/api/experts')).experts ?? [];
  } catch {
    S.experts = null; // 拉不到保持 null：paintExperts 按「加载失败」画，不冒充空目录
  }
}

/**
 * 专家库整页（#expertsView）：跟工作台宫格同一个整页形态 —— 左栏收掉（body.no-list），
 * 页头只放标题，无下钻。拉目录这段时间人可能已经点去别的栏了，回来先看 S.nav 再画。
 */
async function openExperts() {
  setRoute('experts');
  if (S.es) { S.es.close(); S.es = null; S.running = false; setBusy(false); }
  setListTitle('专家库');
  // 兜底：从路由直达（刷新恢复）时 setNav 可能没跑过，整页形态自己摆好
  document.body.classList.add('no-list');
  $('listAction').classList.add('hidden');
  $('search').closest('.list-search')?.classList.add('hidden');
  $('listBody').innerHTML = '';
  savePlace();
  if (S.experts === null) await loadExperts();
  if (S.nav !== 'experts') return; // 拉目录时人走了，别抢别人的主区
  paintExperts();
}

/** 一张专家卡：头像（沿用 avatarStyle 配色）+ 名字/岗位 + 一句话 + 技能 chips + 动作 */
function expertCard(x) {
  const hired = !!x.hired;
  const name = x.hiredPersona?.name || x.name;
  // 头像（2026-10-22）：已雇佣 → 员工自己的头像（用户可换）；未雇佣 → 目录头像
  // （apps/web/avatars/expert-<key>.png，跟着专家包走）；图 404 时 onerror 退字母，不破相
  const avatar = hired
    ? personaAvatar(x.hiredPersona, '', x.name)
    : personaAvatar({ name: x.name, avatar: `expert-${x.key}.png` }, '', x.name);
  return `<div class="expert-card">
    <div class="expert-top">
      ${avatar}
      <div class="expert-who">
        <div class="expert-name"><b>${esc(name)}</b></div>
        <div class="expert-role">${esc(x.role || '')}</div>
      </div>
    </div>
    <div class="expert-intro">${esc(x.intro || '')}</div>
    ${x.skills?.length
      ? `<div class="expert-skills">${x.skills
          .map((s) => `<span class="x-chip" title="${esc(s.description || s.name)}">${esc(s.name)}</span>`)
          .join('')}</div>`
      : ''}
    ${hired
      // 已雇佣（2026-10-21 用户要求）：卡上不再摆发消息/解聘 —— 要聊去员工详情，解聘收进
      // 详情的「⋯」菜单；雇佣状态只留右上角一枚胶囊，卡片在墙上的位置不动。
      ? '<span class="pill expert-hired" title="已雇佣 —— 他在通讯录的「数字员工」里">已雇佣</span>'
      // 未雇佣：右上角同一位置的「雇佣」胶囊（2026-10-21 用户要求：跟已雇佣胶囊一样大）
      : '<button type="button" class="pill expert-hired expert-hire" data-expert-hire="' + esc(x.key) + '">雇佣</button>'}
  </div>`;
}

/** 卡片墙本体：读 S.experts 现画。null = 目录没拉到 —— 画错误卡 + 重试，不冒充两段空态 */
/**
 * 卡片墙本体：读 S.experts 现画。
 * **一张完整卡片墙、按目录顺序排，不按雇佣状态分段**（2026-10-21 用户拍板：
 * 「不要单独列出来，只要把雇佣按钮改成已雇佣就可以了」）—— 雇佣状态长在卡片上：
 * 右上角一枚「已雇佣」胶囊（2026-10-21 二改：发消息/解聘两颗按钮撤掉，解聘收进
 * 员工详情的「⋯」菜单），未雇佣的保留「雇佣」按钮，卡片在墙上的位置不动。
 */
function paintExperts() {
  if (S.experts === null) {
    $('expertsView').innerHTML = `
      <div class="detail-head head-row"><div class="head-title"><b>专家库</b></div></div>
      <div class="detail-body">
        <div class="empty" style="padding:36px 12px">
          专家目录没拉到 —— 多半是班底服务还没带上这个接口（旧进程没重启）。<br />
          重启服务或点下面的按钮再试。
        </div>
        <div style="text-align:center"><button class="primary" data-expert-retry="1">重试</button></div>
      </div>`;
    showView('experts');
    $('expertsView').querySelector('[data-expert-retry]').onclick = () => openExperts().catch((e) => toast(e.message, 'error'));
    return;
  }
  const list = S.experts;

  $('expertsView').innerHTML = `
    <div class="detail-head head-row"><div class="head-title"><b>专家库</b></div></div>
    <div class="detail-body">
      <div class="expert-grid">${list.map(expertCard).join('')}</div>
    </div>`;
  showView('experts');

  const view = $('expertsView');
  view.querySelectorAll('[data-expert-hire]').forEach((el) => {
    el.onclick = () => hireExpert(el.dataset.expertHire).catch((e) => toast(e.message, 'error'));
  });
}

/** 雇佣一位专家：成功后目录 + 人员两边重拉，本页重画（卡片原地变「已雇佣」，墙上的位置不动） */
async function hireExpert(key) {
  const x = (S.experts ?? []).find((e) => e.key === key);
  await post(`/api/experts/${encodeURIComponent(key)}/hire`);
  toast(`已雇佣 ${x?.name ?? key}`);
  await afterExpertAction();
}

/**
 * 解聘一位专家：破坏性动作，先走全站统一的确认弹窗（confirmDo）。
 * 入口在员工详情的「⋯」菜单（2026-10-21 用户要求：卡片上不再摆解聘），
 * 专家库页只管雇佣；解聘完回到通讯录空态，目录重拉让卡片退回「雇佣」。
 */
async function fireExpert(key, { stayContacts = false, name = null } = {}) {
  const x = (S.experts ?? []).find((e) => e.key === key);
  const nm = x?.hiredPersona?.name || x?.name || name || key;
  const ok = await confirmDo(
    `解聘「${nm}」？\n他会从通讯录移除，聊天记录保留；再雇佣会接上旧会话。`,
    { title: '解聘专家', ok: '解聘' },
  );
  if (!ok) return false;
  await post(`/api/experts/${encodeURIComponent(key)}/fire`);
  toast(`已解聘 ${nm}`);
  await afterExpertAction();
  if (stayContacts) {
    // 从详情页解聘的：别留一个指向已解聘员工的面板（同 dDelete 的收尾）
    S.persona = null;
    S.conversation = null;
    $('chat').innerHTML = '<div class="empty">还没有对话</div>';
    $('chatHead').innerHTML = '<span class="dim" style="padding:6px 0">左边选一个人，开始说话</span>';
    setComposer(false);
  }
}

/**
 * 雇佣/解聘之后的收尾：目录（hired 标记）与通讯录人员两边都要重拉；
 * 专家库还开着就按新数据重画（卡片在两段之间挪）。
 */
async function afterExpertAction() {
  await Promise.all([loadExperts(), load()]); // load() 刷 personas（通讯录「数字员工」段跟着变）
  if (S.nav === 'experts') paintExperts();
}

/* -------------------------------------------------------------- 界面插件 */

/**
 * 声明式渲染（L1）：**不执行插件一行代码**，宿主按 manifest 里的 blocks 用自己的组件画。
 *
 * 数据源必须在插件的 permissions 白名单里 —— 没声明就取不到。
 * 但要说清：**这是"君子协定"，不是安全边界**。L1 下插件本来就不跑代码，
 * 所以够用；等做 L2（沙箱 iframe）时，真正挡住越权的是 sandbox 的 opaque origin
 * 加上服务端那道 guardWrite。
 */

/** `{字段}` 取值；取不到就渲染成空串（别显示 undefined） */
function tpl(s, ctx) {
  return String(s ?? '').replace(/\{([A-Za-z0-9_.]+)\}/g, (_, key) => {
    const v = key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), ctx);
    return v == null ? '' : String(v);
  });
}

/** URL 里的 `{字段}`：**必须 encode**，否则一个带斜杠的字段值就能改掉请求路径 */
function tplUrl(s, ctx) {
  return String(s ?? '').replace(/\{([A-Za-z0-9_.]+)\}/g, (_, key) => {
    const v = key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), ctx);
    return v == null ? '' : encodeURIComponent(String(v));
  });
}

/**
 * 工作台磁贴左上角那个**插件角标**：插接口（插头 + 插座）。
 *
 * 为什么要标：工作台是混排的 —— 「项目 / 任务看板 / 流程」是平台自带的，
 * 「服务器与密钥 / 项目面板」是装进来的插件。光看磁贴长得一样，分不出哪个是一等功能、
 * 哪个是插件。所以插件磁贴的图标左上角挂这个小图（平台自带的那几块不挂）。
 *
 * 为什么是"插接口"而不是四个方块：平台里"装进来的外部能力"就叫**连接器**（connector），
 * ssh 插件本身就是 `"connector": "ssh"` —— 插件 = 往平台里插一个东西，
 * 插头的形状正好说的是这件事。也不加底框、不加边框：就一个小图骑在图标角上，
 * 不抢图标本身（加框试过，浅色下会变成一圈很重的描边）。
 */
const PLUGIN_BADGE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
  <path d="M15 3v6" />
  <path d="M9 3v6" />
  <path d="M6.5 9h11v3.2a5.5 5.5 0 0 1-11 0z" />
  <path d="M12 17.7V22" />
</svg>`;

/**
 * 插件磁贴的图标配色（v1.0.1 第 3 步）。
 *
 * 为什么是"按分组顺序发色"，而不是按分组名哈希：
 * 哈希看上去更"稳定"（同一个分类永远同色），但**碰撞是随机的** —— 实测哈希把
 * 「研发」和「运维」撞成同一个紫、「开发」和「生产力」撞成同一个青，一眼就看得出。
 * 而实际工作台上同时存在的分组只有 2~4 个（项目面板 / ssh 各自一个分类），
 * 按**首次出现的顺序**发色，同屏的几组必然不同色 —— 这才是这一格要的效果。
 * 代价：新装一个分类可能让后面几组的颜色挪位（分组重排时本来就会重排），可以接受。
 *
 * 色相只在 190°~330° 之间循环（青 → 蓝 → 紫 → 品红）：这一圈里**没有黄**。
 * 白字压在色块上要 ≥ 4.5:1，黄/橙在同样明度上对比度掉得最快（实测 #a86400 只有 4.68，
 * 再亮一点就破线）。绕开这一段，白字就稳。
 * 饱和度 46%、明度 44%/28%：不是没颜色，是"分得开但压得住" ——
 * 主屏上一排高饱和色块会抢注意力，而这些只是入口。
 * ⚠️ **青/绿这一族要单独压暗**：同样的明度下，青绿在 WCAG 的亮度公式里权重大
 * （G 的系数 0.7152），hsl(192 46% 44%) 白字只有 3.70、hsl(172 46% 44%) 只有 3.03 —— 破线。
 * 所以 192 / 172 这两位的起点明度降到 36%（对应 4.9~5.1），其余保持 44%。
 * 改任何一个色位都要重算："相对亮度 → 1.05/(L+0.05)"，白字 ≥ 4.5。
 */
const PLUGIN_HUES = [262, 192, 322, 214, 292, 172];
/** 少数色位需要不同的明度（见上面的注释）。没列出的走默认 44%/28% */
const PLUGIN_LIGHT = { 192: 36, 172: 34 };
/** 一次渲染内：分组名 → 色位（每次重画重新发，顺序稳定则颜色稳定） */
let wbHueTick = 0;
let wbHueMap = new Map();
const resetWbHues = () => { wbHueTick = 0; wbHueMap = new Map(); };
function pluginHue(cat) {
  const key = String(cat || '应用');
  if (!wbHueMap.has(key)) {
    wbHueMap.set(key, PLUGIN_HUES[wbHueTick % PLUGIN_HUES.length]);
    wbHueTick++;
  }
  return wbHueMap.get(key);
}
/** 一个分组一种颜色的内联样式（起点亮、终点暗，同一档的渐变） */
const wbIcoStyle = (cat) => {
  const h = pluginHue(cat);
  const l1 = PLUGIN_LIGHT[h] ?? 44;
  const l2 = l1 - 16; // 终点固定比起点暗 16 个明度：同一色相的两档，渐变不会脏
  return `style="--wb-1:hsl(${h} 46% ${l1}%);--wb-2:hsl(${h} 52% ${l2}%)"`;
};

/** 从接口返回里取数组：可以是数组本身，也可以 pick 某个键 */
function pickItems(body, pick) {
  if (Array.isArray(body)) return body;
  if (pick && Array.isArray(body?.[pick])) return body[pick];
  if (!pick) {
    const arr = Object.values(body ?? {}).find(Array.isArray);
    if (arr) return arr;
  }
  return [];
}

/** rail 里能用的：**已装 ＋ 启用 ＋ 合法 ＋ 有界面**。在设置里卸掉或停用，工作台上就没了 */
const usablePlugins = () =>
  S.plugins.filter((p) => p.installed && p.enabled && p.valid && p.panel?.slot === 'plugins');

/**
 * 渲染时把行数据记在这里，点击行内按钮时按「块:行」回查。
 * 不塞进 DOM 的 data 属性：那样得处理 JSON 转义和引号，很容易出错。
 */
let pluginRows = {};

/**
 * 这一面板里**被引用到的表单**（list.add / 行内 edit / button.edit 指到的）。
 * 被引用 → 作为弹窗用，按钮画在引用它的那张表的标题行右侧；没人引用 → 就内嵌。
 * 这样 manifest 不用额外声明"我是弹窗还是内嵌"，少一个字段。
 */
let pluginDialogForms = new Set();

/** code 块要复制的文本，按块下标存（点击时回查，不把长文本塞进 DOM 属性） */
let pluginCopy = {};

/**
 * button 块的结果（`resultField`）。按「块:选中行」存 ——
 * 结果放在 DOM 里会被下一次重画冲掉，而且换一台机器不该还留着上一台的输出。
 */
let pluginResult = {};

/**
 * 点一级栏的「工作台」＝ 回工作台首页（不记住上次打开的插件，进来就是宫格）。
 *
 * ⚠️ 「回宫格」这件事（清选中、记位置）**必须在拿插件清单之前同步做完**：
 * 刷新恢复时 `setNav('plugins')` 会先调它，紧接着 `restorePlace` 才去开项目看板 / 全局面板。
 * 原来这几行在 `await api('/api/plugins')` 之后 —— 那边一回来就把刚恢复的页面状态抹掉、
 * 再把宫格盖在看板上（"刷新一下又掉回工作台"就是这么来的）。现在：状态同步清、
 * 回来时若发现页面已被别的路径接管（选中了什么、或停在看板上）就不画宫格了。
 */
async function openPlugins() {
  setRoute('plugins');
  S.plugin = null;
  S.projectList = false;   // 回宫格 = 离开项目页
  S.projectId = null;
  S.boardAll = false;      // 也离开全局面板
  savePlace();             // 点一级栏 = 回宫格首页，这个位置也要记
  try {
    S.plugins = (await api('/api/plugins')).plugins;
  } catch {
    S.plugins = [];
  }
  // 拿清单这段时间里页面可能已经被接管了（刷新恢复看板就是这种），或者人已经点去别的栏了
  // —— 那就别抢渲染（`S.nav` 也得看：点了一级栏「消息」就说明宫格不再是当前页面）
  if (S.nav !== 'plugins' || S.plugin || S.projectList || S.projectId || S.boardAll) return;
  renderList();
  renderWorkbench();
  // 显式「回工作台」时把**选择也复位**：否则下次重进工作台，renderList 会把上次那个
  // 插件 / 项目看板的位置又画回去（用户在子页里点了返回，结果一刷新又跳回去过 —— 踩过）
  delete S.plugin;
  delete S.pluginRow;
}

/** 工作台：没选应用就是目录，选了就是那个应用的页面 */
function renderWorkbench() {
  if (S.plugin) return renderPluginPanel();
  renderWorkbenchGrid();
}

/**
 * 工作台首页 = **整页宫格**（2026-10-19 用户明确要求保留：「这个是整体的入口页，不能变」）。
 *
 * ⚠️ 中途我把它改成过"左栏目录 + 右栏空态"，理由是"工作台的子页全是左栏列表 + 右侧内容，
 * 首页也该一样"。那是**从形式倒推**的，回来一看明显不对：
 *   · 首页的职责是**总览**（一屏扫完所有入口、看得见分组），不是"再往里走一层"；
 *   · 换成目录后主区是一大块空白，等于把整个页面浪费掉；
 *   · 入口还被塞进常态收起的左栏 —— 打开 app 第一眼反而什么都看不见。
 * 所以定下来：**首页宫格（左栏收起）、子页才走「标题 + 动作」的页头。**
 * 这是有意的分野：入口页长得像入口，工作页长得像工作页。
 * （页头前面不放按钮 —— 当天加过一枚「← 工作台」，用户说"统一去掉"，见 headRow 的注释。）
 */
function renderWorkbenchGrid() {
  resetWbHues(); // 每次重画从头发色：分组顺序不变 → 颜色不变；顺序变了 → 颜色跟着重排（不追求跨次稳定）
  const list = usablePlugins();
  // 宫格是整页布局：把左栏收掉（进插件后会由 renderPluginMaster 放回来）
  document.body.classList.add('no-list');
  setListTitle('工作台');
  $('listBody').innerHTML = '';
  $('listAction').classList.add('hidden');
  // 装上了但 manifest 有问题的：提示放在宫格最下面，
  // 否则插件作者只会看到"我装的插件不见了"，不知道哪里错了
  const broken = S.plugins.filter((p) => p.panel?.slot === 'plugins' && p.installed && !p.valid);
  const groups = new Map();
  for (const p of list) {
    const key = p.category || '应用';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  /* 所有分组**共用一个宫格容器**，分组名退化成一行小标题（`.wb-sec`）。
     原来每个分组是 `<section class="fx">`，`.fx + .fx` 自带横分隔线 —— 5 个小组竖着叠成
     5 条横带，每条右侧一片空白，分隔线反而比内容显眼。现在一屏铺不下就换行，不会"一带一块"。 */
  const pluginSections = [...groups]
    .map(
      ([cat, items]) => `<div class="wb-sec">${esc(cat)}</div>
        <div class="wb-grid">
          ${items
            .map(
              (p) => wbCard(
                'has-plug',
                `<i class="wb-badge" title="插件" aria-label="插件">${PLUGIN_BADGE_SVG}</i>${esc(initial(p.label))}`,
                p.label,
                p.description || p.label,
                `data-wb-open="${esc(p.id)}"`,
                wbIcoStyle(cat),
              ),
            )
            .join('')}
        </div>`,
    )
    .join('');

  $('pluginView').classList.remove('kb-page'); // 宫格是长页面，按普通滚动
  $('pluginView').innerHTML = `
    <div class="detail-head head-row"><div class="head-title"><b>工作台</b></div></div>
    <div class="detail-body wb-page">${
      list.length ? pluginSections : '' // 没装应用就不渲染这个区：空态横幅没人需要
    }${workbenchProjectSection()}${workbenchAutoSection()}${workbenchFlowSection()}${
      broken.length
        ? `<div class="wb-sec">装不上台面</div>
           ${broken
             .map((p) => `<div class="plg-err">${esc(p.id)}：${esc(p.errors.join('；'))}</div>`)
             .join('')}`
        : ''
    }</div>`;
  showView('plugin');

  const view = $('pluginView');
  view.querySelectorAll('[data-wb-open]').forEach((el) => {
    el.onclick = () => {
      S.plugin = el.dataset.wbOpen;
      setRoute('plugin', { id: S.plugin });
      S.pluginRow = null;      // 换插件了，上一个的选中行不适用
      S.projectList = false;   // 进插件 = 离开项目页（不然刷新会被项目那条路抢走）
      S.projectId = null;
      S.boardAll = false;
      savePlace();
      renderList();
      renderPluginPanel().catch((e) => toast(e.message, 'error'));
    };
  });
  // 流程编排：画节点、指派、发布（入口原来在 rail 的「工作流」，现在收进工作台）
  view.querySelector('[data-flow-design]')?.addEventListener('click', () => {
    openWorkflows().catch((e) => toast(e.message, 'error'));
  });
  // 流程：点一下先看**这个流程的发起记录**；发起是那个页面上的动作（＋）
  view.querySelectorAll('[data-flow-start]').forEach((el) => {
    el.onclick = () => openFlowRun(el.dataset.flowStart);
  });
  // 项目：点一下进项目列表（增删改查都在那儿）
  view.querySelector('[data-projects]')?.addEventListener('click', () => {
    openProjectsPage().catch((e) => toast(e.message, 'error'));
  });
  // 任务看板：同一张看板，范围是**所有项目**（站在全局看）
  view.querySelector('[data-task-board]')?.addEventListener('click', () => {
    openTaskBoard().catch((e) => toast(e.message, 'error'));
  });
  // 定时任务：入口原来在「设置」里，搬到工作台（2026-10-17 用户要求）
  view.querySelector('[data-schedules]')?.addEventListener('click', () => {
    openSchedules().catch((e) => toast(e.message, 'error'));
  });
}

/**
 * 插件能不能调这个接口 —— **每次调用前都查**，不是只在加载时校验一遍。
 *
 * 声明里允许带占位（`DELETE:/api/ssh/servers/{alias}`），占位匹配**一段非斜杠**。
 * 注意不能只把声明串里的 {x} 换成 *：实际路径里没有占位符，两边形状永远对不上
 * （这个坑踩过 —— 删除按钮会一直报"没声明权限"）。
 */
function pathMatches(pattern, path) {
  const rx = String(pattern)
    .split(/(\{[^}]*\})/)
    .map((seg) => (/^\{[^}]*\}$/.test(seg) ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp('^' + rx + '$').test(String(path));
}

function pluginCan(plugin, method, apiPath) {
  const want = String(method || 'GET').toUpperCase();
  return plugin.permissions.some((p) => {
    const i = String(p).indexOf(':');
    if (i < 0) return false;
    return String(p).slice(0, i).toUpperCase() === want && pathMatches(String(p).slice(i + 1), apiPath);
  });
}

function pluginMust(plugin, method, apiPath) {
  if (!pluginCan(plugin, method, apiPath)) {
    throw new Error(`插件没声明这个权限：${String(method).toUpperCase()} ${apiPath}`);
  }
}

/** 按白名单取数据；同一次进面板内缓存，避免 list/table 各拉一遍 */
async function pluginApi(plugin, apiPath) {
  pluginMust(plugin, 'GET', apiPath);
  if (!(apiPath in S.pluginData)) S.pluginData[apiPath] = await api(apiPath);
  return S.pluginData[apiPath];
}

/** 表单字段渲染 —— 内嵌表单和弹窗共用这一份，免得两处走样 */
function pluginFormHTML(b, fid, state = {}) {
  const editing = state.editing ?? null;
  const values = state.values ?? {};
  return `<div class="plg-form" data-form="${esc(fid)}">${(b.fields ?? [])
    .map((f) => {
      const val = values[f.key] ?? f.value ?? '';
      const locked = editing && f.key === 'alias' ? ' readonly' : '';
      const input =
        f.type === 'textarea'
          ? `<textarea data-field="${esc(f.key)}" style="height:56px" placeholder="${esc(f.placeholder || '')}">${esc(val)}</textarea>`
          : `<input data-field="${esc(f.key)}" value="${esc(val)}" placeholder="${esc(f.placeholder || '')}"${locked} />`;
      return `<div class="plg-field">
        <div class="plg-field-label">${esc(f.label)}${f.required ? '<em>*</em>' : ''}</div>
        ${input}
        ${f.hint ? `<div class="plg-field-hint">${esc(f.hint)}</div>` : ''}
      </div>`;
    })
    .join('')}</div>`;
}

const pluginFormId = (b) => b.formId || 'f' + b.__i;

/** 打开插件表单弹窗。新增和"编辑某一行"走的是同一个弹窗，只是初始值不同 */
function openPluginForm(plugin, block, state = {}) {
  S.pluginFormDlg = { plugin, block, fid: pluginFormId(block) };
  $('plgFormTitle').textContent = state.editing
    ? `修改「${state.editing}」`
    : block.heading || '填写';
  $('plgFormBody').innerHTML = pluginFormHTML(block, pluginFormId(block), state);
  $('plgFormOk').textContent = block.submit?.label || '保存';
  $('plgFormDlg').showModal();
  setTimeout(() => $('plgFormBody').querySelector('input, textarea')?.focus(), 30);
}

/** 取单个字段（code 块的 pick 用）；没有 pick 就返回整个对象 */
function pickOne(body, key) {
  if (!key) return body;
  return String(key)
    .split('.')
    .reduce((o, k) => (o == null ? undefined : o[k]), body);
}

/**
 * 按钮的 HTML。**`renderBlock` 和主从布局的标题行都走这里**。
 *
 * 为什么要抽出来：标题行那份原来是手写的，忘了设 `__row` —— 后果不只是"编辑不回填"，
 * 测/删 的 `{alias}` 也会变空，请求打到 `/api/ssh/servers//test` 静默 404。
 * 现在 `__row` 只有这一个赋值点，漏不掉。
 */
function buttonHTML(b, row) {
  b.__row = row ?? {};
  return `<button${b.primary ? ' class="primary"' : ''}${
    b.title ? ` title="${esc(tpl(b.title, b.__row))}"` : ''
  } data-plg-act="${b.__i}">${esc(b.label)}</button>`;
}

/**
 * 一个区块：**标题在卡片外面**，卡片（.fx）里只放内容。
 * `extra` 是标题行右侧的东西（比如列表的「添加」按钮），传进来的已是 HTML。
 *
 * 提到模块级是因为主从布局那边的「测试结果」也要用同款包裹 —— 两处各写一遍迟早不一致。
 */
function pluginSec(title, body, extra = '') {
  const bar =
    title || extra
      ? `<div class="plg-sec-head">${title ? `<label class="plg-sec-title">${esc(title)}</label>` : '<span></span>'}${extra}</div>`
      : '';
  return `<div class="plg-sec">${bar}<section class="fx">${body}</section></div>`;
}

/**
 * 渲染一个块。
 * `row` = 主从布局里**左边选中的那一行**。块里所有 `{字段}`、以及 `source.api` 的占位符，
 * 都拿它当上下文；没有主从布局时就是 `{}`，行为和以前完全一样。
 */
async function renderBlock(plugin, b, row = {}) {
  // 取值优先级：行字段 > 数据源根对象。这样 detail 里既能写 {alias}，也能用接口返回的字段
  const ctx = (body) => ({ ...(body ?? {}), ...row });
  const titleOf = (body) => (b.heading ? tpl(b.heading, ctx(body)) : '');
  const head = titleOf({});
  const apiOf = (src) => tplUrl(src.api, row);

  const sec = pluginSec;

  if (b.type === 'text') {
    return sec(head, `<div class="plg-text">${esc(b.text)}</div>`);
  }

  if (b.type === 'keyvalue') {
    const body = b.source ? await pluginApi(plugin, apiOf(b.source)) : {};
    const rows = (b.rows ?? [])
      .map((r) => `<div class="info-row"><span>${esc(r.label)}</span><b>${esc(tpl(r.value, ctx(body)))}</b></div>`)
      .join('');
    return sec(titleOf(body), rows);
  }

  /**
   * steps 块：把一组 [{title, note, command}] 铺成**编号步骤**，每步的命令能单独复制。
   * 比一整段脚本好读，也正对"用户是一个个复制命令"这件事 —— 整段脚本本来也没法直接执行。
   */
  if (b.type === 'steps') {
    const src = b.source ? await pluginApi(plugin, apiOf(b.source)) : {};
    const list = pickOne(src, b.source?.pick);
    const steps = Array.isArray(list) ? list : [];
    steps.forEach((s, si) => { pluginCopy[`${b.__i}:${si}`] = String(s.command ?? ''); });
    return sec(
      titleOf(src),
      steps.length
        ? `<div class="plg-steps">${steps
            .map(
              (s, si) => `<div class="plg-step">
                <div class="plg-step-head">
                  <span class="plg-step-n">${si + 1}</span>
                  <b>${esc(tpl(s.title, ctx(src)))}</b>
                  ${s.where ? `<span class="plg-step-where">在${esc(tpl(s.where, ctx(src)))}执行</span>` : ''}
                  <button class="btn-sm" style="margin-left:auto" data-plg-copy="${b.__i}:${si}">复制命令</button>
                </div>
                ${s.note ? `<div class="plg-step-note">${esc(tpl(s.note, ctx(src)))}</div>` : ''}
                <pre class="plg-code">${esc(tpl(s.command, ctx(src)))}</pre>
              </div>`,
            )
            .join('')}</div>`
        : `<div class="hint">${esc(b.empty || '没有步骤')}</div>`,
    );
  }

  /**
   * code 块：把一段文本（公钥、命令、测试输出）摊出来，可整段复制。
   * `plain: true` → **不要框、不要滚动条**，直接铺开（长指引塞进小框里要一直滚，很憋屈）；
   * 默认仍然用带框的 .plg-code（公钥那种一行长文本，有框才好选中）。
   */
  if (b.type === 'code') {
    const src = b.source ? await pluginApi(plugin, apiOf(b.source)) : {};
    const text = String(pickOne(src, b.source?.pick) ?? '');
    pluginCopy[b.__i] = text;
    b.__row = row;
    const hint = b.hint ? tpl(b.hint, ctx(src)) : '';
    const empty = !text && b.emptyAction ? b.emptyAction : null;
    const cls = b.plain ? 'plg-plain' : 'plg-code';
    // 复制 / 生成 这类动作放**标题行右侧**（和列表的「＋」同一个位置），不放卡里
    const action = text && b.copy !== false
      ? `<button class="btn-sm" style="margin-left:auto" data-plg-copy="${b.__i}">${esc(b.copyLabel || '复制')}</button>`
      : empty
        ? `<button class="primary btn-sm" style="margin-left:auto" data-plg-empty="${b.__i}">${esc(empty.label)}</button>`
        : '';
    return sec(
      titleOf(src),
      `${hint ? `<div class="plg-field-hint">${esc(hint)}</div>` : ''}
      ${text ? `<pre class="${cls}">${esc(text)}</pre>` : ''}`,
      action,
    );
  }

  // 表单块：被 list 的 add / 行内 edit 引用到就作为弹窗，别人画按钮；没人引用就内嵌
  if (b.type === 'form') {
    const fid = pluginFormId(b);
    if (pluginDialogForms.has(fid)) return '';
    return sec(head, pluginFormHTML(b, fid, S.pluginForm[fid]));
  }

  if (b.type === 'list') {
    const src = await pluginApi(plugin, apiOf(b.source));
    const items = pickItems(src, b.source.pick);
    // 行数据记在内存里，点击时按「块:行」回查 —— 免得把 JSON 塞进 DOM 属性里做转义
    items.forEach((it, ri) => { pluginRows[`${b.__i}:${ri}`] = it; });
    const acts = b.actions ?? [];
    const html = items.length
      ? items
          .map(
            (it, ri) => `<div class="row-item plg-item">
              <div class="who">
                <b>${esc(tpl(b.title, it))}</b>
                <div class="sub">${esc(tpl(b.subtitle, it))}</div>
              </div>
              ${
                acts.length
                  ? `<div class="plg-row-actions">${acts
                      .map(
                        (a, ai) =>
                          `<button class="btn-sm${a.kind === 'delete' ? ' danger' : ''}" data-row-act="${b.__i}:${ri}:${ai}">${esc(a.label)}</button>`,
                      )
                      .join('')}</div>`
                  : ''
              }
            </div>`,
          )
          .join('')
      : `<div class="hint">${esc(b.empty || '没有数据')}</div>`;
    // 标题行右侧可以挂一个「添加」按钮（manifest 里 list.add 声明），
    // 标题行仍然在**卡片外面**，按钮跟着标题走
    const addBtn = b.add
      ? `<button class="primary btn-sm" style="margin-left:auto" data-form-open="${esc(b.add.form)}">${esc(b.add.label)}</button>`
      : '';
    return sec(titleOf(src), html, addBtn);
  }

  if (b.type === 'table') {
    const cols = b.columns ?? [];
    const src = await pluginApi(plugin, apiOf(b.source));
    const items = pickItems(src, b.source.pick);
    const body = items.length
      ? items
          .map(
            (it) => `<tr>${cols.map((c) => `<td>${esc(tpl('{' + c.key + '}', it))}</td>`).join('')}</tr>`,
          )
          .join('')
      : `<tr><td colspan="${cols.length}" class="dim">没有数据</td></tr>`;
    /**
     * 列宽（可选）：任意一列写了 `width` → 整张表切成 `table-layout: fixed`，
     * 写了宽度的按声明，没写的平分剩下的。
     *
     * 为什么非要有这个：`table-layout: auto` 下中文**每个字都能断行**，
     * 于是「要点」「证据」这种长文本列会把「编号」「状态」压到一两个字宽——
     * `T-001` 断成两行、`待部署` 竖排（真踩过）。给插件一个说清列宽的地方，
     * 比让宿主去猜"哪一列看起来短"靠谱。
     */
    const fixed = cols.some((c) => c.width);
    const colgroup = fixed
      ? `<colgroup>${cols.map((c) => `<col${c.width ? ` style="width:${esc(String(c.width))}"` : ''}>`).join('')}</colgroup>`
      : '';
    return sec(titleOf(src), `<table class="plg-table${fixed ? ' fixed' : ''}">${colgroup}
        <thead><tr>${cols.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead>
        <tbody>${body}</tbody>
      </table>`);
  }

  if (b.type === 'button') {
    const res = pluginResult[`${b.__i}:${S.pluginRow ?? ''}`] ?? '';
    return sec(
      head,
      `${buttonHTML(b, row)}${b.resultField ? `<pre class="plg-code"${res ? '' : ' hidden'}>${esc(res)}</pre>` : ''}`,
    );
  }

  return '';
}

/**
 * 主从布局的「主」：把列表画到**全局左栏**（和消息/通讯录同一个位置），
 * 而不是在右侧自己再画一列 —— 这样跟整个 app 的布局一致。
 * 返回选中的那一行。
 */
async function renderPluginMaster(plugin, split) {
  const m = split.master ?? {};
  const keyField = m.keyField || 'id';
  const src = await pluginApi(plugin, m.source.api);
  const rows = pickItems(src, m.source.pick);
  const keyOf = (r) => String(r[keyField] ?? '');

  if (!rows.some((r) => keyOf(r) === String(S.pluginRow))) S.pluginRow = rows.length ? keyOf(rows[0]) : null;
  const sel = rows.find((r) => keyOf(r) === String(S.pluginRow)) ?? null;

  // 左栏顶上：工作台 › 插件名（面包屑从右页头挪过来；页头整条已去掉）
  // 不用 m.heading（「项目」「登记表」）—— 那是"这一列是什么"，面包屑要回答的是"你在哪儿"。
  setListTitle([{ label: '工作台', to: 'workbench' }, { label: plugin.label }]);
  $('listAction').classList.toggle('hidden', !m.add);
  $('listAction').title = m.add?.label || '';
  $('listBody').innerHTML = rows.length
    ? rows
        .map(
          (r) => `<div class="item${sel && keyOf(r) === keyOf(sel) ? ' active' : ''}" data-master="${esc(keyOf(r))}">
            <div class="who">
              <!-- 2026-10-20 收口：原来直接 b + div.sub（没有规则，标题 16px 粗体、副标题全色折行），
                   跟「项目」页的 .line1/.line2 长得不是一套。现在所有主从列表都用标准行结构。 -->
              <div class="line1"><b>${esc(tpl(m.title, r))}</b></div>
              ${m.subtitle ? `<div class="line2" title="${esc(tpl(m.subtitle, r))}">${esc(tpl(m.subtitle, r))}</div>` : ''}
            </div>
          </div>`,
        )
        .join('')
    : `<div class="empty" style="padding:32px 12px">${esc(m.empty || '还没有数据')}</div>`;

  $('listBody').querySelectorAll('[data-master]').forEach((el) => {
    el.onclick = () => {
      S.pluginRow = el.dataset.master;
      S.pluginData = {};   // 换了机器，缓存的数据不能再用
      savePlace();
      renderPluginPanel().catch((e) => toast(e.message, 'error'));
    };
  });

  return sel;
}

/**
 * 主从布局的「详情」：画在主区。
 * 选中项记在 `S.pluginRow`（键取 `master.keyField`，默认 `id`），重画后还在。
 * 详情块拿到选中行当上下文，所以 `{alias}`、`/api/ssh/servers/{alias}/key` 都直接写。
 */
async function renderSplitDetail(plugin, split, m, sel) {
  const detail = [];
  if (sel) {
    for (const b of split.detail?.blocks ?? []) {
      // 逐块兜底：一块取数失败，别把整个详情拖成白屏
      try {
        detail.push(await renderBlock(plugin, b, sel));
      } catch (err) {
        detail.push(`<section class="fx"><div class="plg-err">${esc(b.type)} 块出错：${failHtml(err)}</div></section>`);
      }
    }
  }

  // 动作按钮在标题行右侧（测/改/删这类），结果跟在标题下面 —— 点完当场看得到
  // 走 buttonHTML：它负责把这一行塞进 __row，编辑回填和 URL 取值全靠这个
  const acts = (split.detail?.actions ?? []).map((b) => buttonHTML(b, sel)).join('');
  // 动作按钮的结果（连通性测试这种）用**悬浮提示**：
  // 原来是张卡插在详情顶部，把下面的内容整套往下推 —— 一次性输出不该占版面，而且要能关掉
  const toasts = sel
    ? (split.detail?.actions ?? [])
        .filter((b) => b.resultField)
        .map((b) => {
          const key = `${b.__i}:${S.pluginRow ?? ''}`;
          const out = pluginResult[key] ?? '';
          if (!out) return '';
          return `<div class="plg-toast">
            <div class="plg-toast-head">
              <b>${esc(tpl(b.resultTitle || b.label, sel))}</b>
              <button class="mini sm" data-toast-x="${esc(key)}" title="关闭">×</button>
            </div>
            <pre class="plg-code">${esc(out)}</pre>
          </div>`;
        })
        .join('')
    : '';

  return `<div class="plg-detail">${
    sel
      ? `<div class="plg-detail-head">
           <b>${esc(tpl(split.detail?.title || m.title, sel))}</b>
           ${split.detail?.subtitle ? `<span class="dim">${esc(tpl(split.detail.subtitle, sel))}</span>` : ''}
           ${acts ? `<div class="head-actions">${acts}</div>` : ''}
         </div>${detail.join('')}`
      : `<div class="wip">${esc(split.detail?.empty || '左边选一个')}</div>`
  }</div>${toasts}`;
}

async function renderPluginPanel() {
  const plugin = S.plugins.find((p) => p.id === S.plugin);

  // 没选应用（或选的那个被卸掉了）→ 回工作台首页
  if (!plugin || !usablePlugins().some((p) => p.id === plugin.id)) {
    S.plugin = null;
    renderWorkbenchGrid();
    return;
  }

  // 有主从布局 → 用**全局左栏**放列表（和消息/通讯录同一位置）；
  // 没有 → 整页布局，把左栏收掉（见 CSS 的 body.no-list）。
  // ⚠️ 2026-10-19 用户：「面包屑应该是在左边的列表上，右边的不用」——
  //    有左栏时面包屑画在左栏顶上（renderPluginMaster 里），页头整条不要；
  //    没左栏时（整页插件面板）页头仍是面包屑，否则页面上没有任何"你在哪"。
  const split = plugin.panel.split ?? null;
  $('pluginView').classList.remove('kb-page'); // 插件面板是长页面（块会很长），按普通滚动
  // 进插件面板 = 离开项目页（两条路都写在 pluginView 里，位置记忆得分清是谁）
  S.projectList = false;
  S.projectId = null;
  $('pluginView').innerHTML = `
    ${split ? '' : headRow(breadcrumb([{ label: '工作台', to: 'workbench' }, { label: plugin.label }]))}
    <div class="detail-body" id="plgPanel"><div class="dim">加载中…</div></div>`;
  showView('plugin');

  S.pluginData = {};
  pluginRows = {};
  pluginCopy = {};

  // 顶部块 + 详情动作 + 详情块合成一张表：下标统一，按钮回查才不会串
  const allBlocks = [
    ...(plugin.panel.blocks ?? []),
    ...(split?.detail?.actions ?? []),
    ...(split?.detail?.blocks ?? []),
  ];
  allBlocks.forEach((b, i) => { b.__i = i; });

  // 先扫一遍：哪些表单被 add / 行内 edit 引用了 —— 被引用的走弹窗形态
  pluginDialogForms = new Set();
  for (const b of allBlocks) {
    if (b.type === 'list') {
      if (b.add?.form) pluginDialogForms.add(b.add.form);
      for (const a of b.actions ?? []) if (a.kind === 'edit' && a.form) pluginDialogForms.add(a.form);
    }
    if (b.type === 'button' && b.edit) pluginDialogForms.add(b.edit);
  }

  // 有主从布局 → 用**全局左栏**放列表（和消息/通讯录同一位置）；
  // 没有 → 整页布局，把左栏收掉（见 CSS 的 body.no-list）
  document.body.classList.toggle('no-list', !split);
  let sel = null;
  if (split) sel = await renderPluginMaster(plugin, split);
  else {
    setListTitle(plugin.label);
    $('listBody').innerHTML = '';
  }

  const parts = [];
  for (const b of plugin.panel.blocks ?? []) {
    // 逐块兜底：一块取数失败，别把整个面板拖成白屏
    try {
      parts.push(await renderBlock(plugin, b));
    } catch (err) {
      parts.push(`<section class="fx"><div class="plg-err">${esc(b.type)} 块出错：${failHtml(err)}</div></section>`);
    }
  }

  // 详情画在主区（选中项的字段、公钥、交付指引、连通性结果都在这里）
  if (split) parts.push(await renderSplitDetail(plugin, split, split.master ?? {}, sel));

  $('plgPanel').innerHTML = parts.join('');

  // 标题行右侧的「添加」按钮（以及任何 data-form-open）→ 开表单弹窗
  $('plgPanel').querySelectorAll('[data-form-open]').forEach((el) => {
    const fb = allBlocks.find((x) => x.type === 'form' && pluginFormId(x) === el.dataset.formOpen);
    if (fb) el.onclick = () => openPluginForm(plugin, fb, {});
  });

  // 悬浮提示的关闭：清掉那份结果，并把浮层移掉（不用整页重画）
  $('plgPanel').querySelectorAll('[data-toast-x]').forEach((el) => {
    el.onclick = () => {
      delete pluginResult[el.dataset.toastX];
      el.closest('.plg-toast')?.remove();
    };
  });

  // code / steps 块的复制：按钮在标题行或步骤行、正文在卡里或步骤块里 —— 所以两种容器都找
  $('plgPanel').querySelectorAll('[data-plg-copy]').forEach((el) => {
    el.onclick = () =>
      copyText(
        el,
        pluginCopy[el.dataset.plgCopy] ?? '',
        el.closest('.plg-step, .plg-sec')?.querySelector('.plg-code, .plg-plain'),
      );
  });

  // code 块：内容为空时的那个按钮（「还没生成密钥 → 生成密钥对」）
  $('plgPanel').querySelectorAll('[data-plg-empty]').forEach((el) => {
    const b = allBlocks[Number(el.dataset.plgEmpty)];
    const act = b?.emptyAction;
    if (!act) return;
    el.onclick = async () => {
      const method = (act.method || 'POST').toUpperCase();
      const target = tplUrl(act.api, b.__row ?? {});
      if (act.confirm && !(await confirmDo(tpl(act.confirm, b.__row ?? {})))) return;
      el.disabled = true;
      try {
        pluginMust(plugin, method, target);
        const opts = { method };
        if (method !== 'GET') {
          opts.headers = { 'Content-Type': 'application/json' };
          opts.body = JSON.stringify(act.body ?? {});
        }
        const res = await api(target, opts);
        if (res.warning) toast(res.warning);
        S.pluginData = {};
        await renderPluginPanel();
      } catch (err) {
        toast(err.message, 'error');
        el.disabled = false;
      }
    };
  });

  $('plgPanel').querySelectorAll('[data-plg-act]').forEach((el) => {
    el.onclick = async () => {
      const b = allBlocks[Number(el.dataset.plgAct)];
      if (!b) return;

      // button.edit：打开表单弹窗，先把这一行灌进去
      if (b.edit) {
        const fb = allBlocks.find((x) => x.type === 'form' && pluginFormId(x) === b.edit);
        if (!fb) return toast(`manifest 里找不到表单「${b.edit}」`);
        openPluginForm(plugin, fb, { values: { ...(b.__row ?? {}) }, editing: (b.__row ?? {}).alias ?? '这一行' });
        return;
      }

      if (b.confirm && !(await confirmDo(tpl(b.confirm, b.__row ?? {})))) return;
      el.disabled = true;
      try {
        const a = b.action ?? {};
        const method = (a.method || 'POST').toUpperCase();
        const target = tplUrl(a.api, b.__row ?? {});
        pluginMust(plugin, method, target);           // 每次调用前都查白名单
        const opts = { method };
        if (method !== 'GET') {
          opts.headers = { 'Content-Type': 'application/json' };
          opts.body = JSON.stringify(a.body ?? {});
        }
        const res = await api(target, opts);
        // resultField：结果记在 state 里（不是 DOM），重画后还在；换机器会显示各自的那份
        if (b.resultField) pluginResult[`${b.__i}:${S.pluginRow ?? ''}`] = String(res?.[b.resultField] ?? '');
        S.pluginData = {};
        await renderPluginPanel();   // 重新取数并重画
      } catch (err) {
        toast(err.message, 'error');
        el.disabled = false;
      }
    };
  });

  // 表单提交：读 DOM 里的值 → 校验必填 → 打接口 → 清掉编辑态、重画
  $('plgPanel').querySelectorAll('[data-form-submit]').forEach((el) => {
    el.onclick = async () => {
      const fid = el.dataset.formSubmit;
      const b = allBlocks.find((x) => x.type === 'form' && (x.formId || 'f' + x.__i) === fid);
      const box = el.closest('.plg-form');
      const values = {};
      box.querySelectorAll('[data-field]').forEach((inp) => { values[inp.dataset.field] = inp.value.trim(); });

      const missing = (b.fields ?? []).filter((f) => f.required && !values[f.key]);
      if (missing.length) return toast('这几项得填：' + missing.map((f) => f.label).join('、'));

      el.disabled = true;
      try {
        const sub = b.submit ?? {};
        const method = (sub.method || 'POST').toUpperCase();
        pluginMust(plugin, method, sub.api);          // 每次提交前都查白名单
        const opts = { method };
        if (method !== 'GET') {
          opts.headers = { 'Content-Type': 'application/json' };
          opts.body = JSON.stringify(values);
        }
        await api(sub.api, opts);
        delete S.pluginForm[fid];
        await renderPluginPanel();
      } catch (err) {
        toast(err.message, 'error');
        el.disabled = false;
      }
    };
  });

  $('plgPanel').querySelectorAll('[data-form-cancel]').forEach((el) => {
    el.onclick = () => {
      delete S.pluginForm[el.dataset.formCancel];
      renderPluginPanel().catch((e) => toast(e.message, 'error'));
    };
  });

  // 行内操作：编辑（把这一行灌进表单）/ 调用接口（一般是删除）
  $('plgPanel').querySelectorAll('[data-row-act]').forEach((el) => {
    const [bi, ri, ai] = el.dataset.rowAct.split(':').map(Number);
    const b = plugin.panel.blocks[bi];
    const a = (b.actions ?? [])[ai];
    const row = pluginRows[`${bi}:${ri}`];
    if (!a || !row) return;

    el.onclick = async () => {
      if (a.kind === 'edit') {
        // 编辑走的是"添加"那个弹窗，只是先把这一行灌进去
        const fb = plugin.panel.blocks.find((x) => x.type === 'form' && pluginFormId(x) === (a.form || 'f' + bi));
        if (!fb) return toast(`manifest 里找不到表单「${a.form}」`);
        openPluginForm(plugin, fb, { values: { ...row }, editing: row.alias ?? '这一行' });
        return;
      }
      if (a.confirm && !(await confirmDo(tpl(a.confirm, row)))) return;
      el.disabled = true;
      try {
        const method = (a.method || 'POST').toUpperCase();
        const target = tplUrl(a.api, row);
        pluginMust(plugin, method, target);           // 每次调用前都查白名单
        const opts = { method };
        if (method !== 'GET') {
          opts.headers = { 'Content-Type': 'application/json' };
          opts.body = JSON.stringify(a.body ?? {});
        }
        await api(target, opts);
        await renderPluginPanel();
      } catch (err) {
        toast(err.message, 'error');
        el.disabled = false;
      }
    };
  });
}

/** 复制一段文本；剪贴板不可用就退而求其次：选中它，让用户自己 Ctrl+C */
async function copyText(btn, text, bodyEl) {
  try {
    await navigator.clipboard.writeText(text ?? '');   // http://127.0.0.1 算安全上下文，能用
  } catch {
    if (!bodyEl) return;
    const r = document.createRange();
    r.selectNodeContents(bodyEl);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }
  const was = btn.textContent;
  btn.textContent = '已复制';
  setTimeout(() => { btn.textContent = was; }, 1200);
}

/** 插件表单弹窗的提交 —— 只注册一次，弹窗里换的是 fields 和 block */
$('plgFormOk').onclick = async (e) => {
  e.preventDefault();
  const d = S.pluginFormDlg;
  if (!d) return;

  const values = {};
  $('plgFormBody').querySelectorAll('[data-field]').forEach((inp) => { values[inp.dataset.field] = inp.value.trim(); });
  const missing = (d.block.fields ?? []).filter((f) => f.required && !values[f.key]);
  if (missing.length) return toast('这几项得填：' + missing.map((f) => f.label).join('、'));

  $('plgFormOk').disabled = true;
  try {
    const sub = d.block.submit ?? {};
    const method = (sub.method || 'POST').toUpperCase();
    pluginMust(d.plugin, method, sub.api);          // 提交前照查白名单
    const opts = { method };
    if (method !== 'GET') {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(values);
    }
    await api(sub.api, opts);
    $('plgFormDlg').close();
    S.pluginFormDlg = null;
    await renderPluginPanel();
  } catch (err) {
    /*
     * 直接用 `err.message`：`api()`（2026-10-21 重设计）对 4xx 已经把服务端原文拼进去了
     * （「E1051：地址不要带端口，端口填在下面那一格。」），5xx 才是「E5005：服务异常」。
     * 这里**不再自己拼一遍 detail** —— 拼了会绕开 `clipLine` 的 160 字截断，
     * 一整段 fs 报错能把 toast 撑爆。完整原文在 err.detail 和控制台里。
     */
    toast(err.message, 'error');
  } finally {
    $('plgFormOk').disabled = false;
  }
};

function closeDrawer() {
  S.drawerOpen = false;
  S.drawerThreadId = null;
  S.drawerThread = null;
  S.removeMode = false;
  // 分流状态也要清：不清的话下次开群设置会被当成"上次是聊天记录"，
  // 画出的是别人的会话列表（同一个 DOM 两种内容的代价，必须成对清）
  S.drawerKind = null;
  S.logPersonaId = null;
  S.logGroupId = null;
  S.logGroupTitle = null;
  S.logLoading = false;
  $('drawer').classList.remove('open');
  // 清空：抽屉和群详情页渲染的是同一批 id（drawerSearch/mgrid…），留着旧 DOM 会打架
  $('drawer').innerHTML = '';
  $('scrim').classList.remove('open');
}

/**
 * 群设置改完之后刷新（改名 / 换群助手 / 加人 / 踢人）。
 *
 * 群的数据在**三个地方**同时显示，改一处三处都得跟上，否则会出现
 * "详情里叫 A、聊天头部还叫 B"：
 *   ① 通讯录的群详情页（`S.groupThreadId === groupId`）
 *   ② 群设置抽屉（`S.drawerKind === 'group' && S.drawerThreadId === groupId`）
 *   ③ 正在聊的这段群会话（`S.conversation.groupId === groupId`）—— 标题/群助手在会话上是镜像字段
 *
 * 用 `openConversationSafe` 重开 ③ 而不是就地改字段：头部、成员数、消息区是一起画的，
 * 拼字段迟早漏一处；重开一次的数据来自服务端，天然一致。
 */
async function refreshGroup(groupId) {
  await load();
  const d = await api('/api/groups/' + encodeURIComponent(groupId));
  const group = d.group;

  if (S.groupThreadId === groupId) paintGroupDetail(group);
  if (S.drawerOpen && S.drawerKind === 'group' && S.drawerThreadId === groupId) {
    S.drawerThread = group;
    paintDrawer();
  }
  if (S.groupThreadId === groupId) { renderList(); return; }
  if (S.conversation?.groupId === groupId) { await openConversationSafe(S.conversation.id); return; }
  renderList();
}

async function kickMember(thread, personaId, name) {
  if (!(await confirmDo(`把 ${name || '他'} 移出群？\n他之前说过的话会留着；再拉回来是干净的开始。`))) return;
  try {
    await api(`/api/groups/${encodeURIComponent(gidOf(thread))}/members/${encodeURIComponent(personaId)}`, {
      method: 'DELETE',
    });
    await refreshGroup(gidOf(thread));
  } catch (err) { toast(err.message, 'error'); }
}

/**
 * 解散群聊。
 *
 * **不抹聊天记录** —— 服务端只做三件事：解除成员关系、清掉各成员在这个群里的会话状态、
 * 给群和每段会话打 `dissolvedAt`（见 store.dissolveGroup）。
 *
 * 2026-10-20 用户定：解散后**消息仍留在消息列表里、只读**（以前是整群连着记录一起从界面收走，
 * 记录在库里却没有入口 = 等于删档）。所以解散完不把用户踢回空态：停在原地重画成只读，
 * 列表里那行的副标题变成「已解散」；通讯录里的群则消失（那边只列还能用的群）。
 * 发消息由后端兜底拒绝（E2049）—— 成员关系已清，不拦的话就是"点了没反应"。
 */
async function dissolveGroup(thread) {
  /*
   * 成员数两种来源：群详情 / 群设置抽屉给的是 `members` 数组；
   * **消息列表右键**给的是 `S.conversations` 里那一行（只有 `memberCount`）。
   * 别写成 `thread.members.length` —— 从列表进来时那是 undefined，直接抛错。
   */
  const n = thread.members?.length ?? thread.memberCount ?? 0;
  // 消息列表右键给的是**群会话**（id 是会话 id），群详情/群设置给的是**群**。
  // 解散的永远是群，所以一律换算成 groupId —— 否则会拿着会话 id 去解散，404。
  const groupId = gidOf(thread);
  const ok = await confirmDo(
    `解散「${thread.title}」？\n\n` +
      `· ${n} 位成员的群关系会解除，这个群不能再 @ 人派活\n` +
      `· 群从通讯录移除；**聊天记录仍留在消息列表里**（只读，翻得到）\n\n` +
      `解散后恢复不了，确定吗？`,
  );
  if (!ok) return;
  try {
    const r = await api(`/api/groups/${encodeURIComponent(groupId)}`, { method: 'DELETE' });
    S.conversations = r.conversations;
    if (r.hiddenConversations) S.hiddenConversations = r.hiddenConversations;
    // 通讯录的群行读 S.groups（groups 表）：解散 = dissolvedAt 打上，本地先摘掉再重画
    S.groups = (S.groups ?? []).filter((g) => g.id !== groupId);
    closeDrawer();
    // 抽屉得关（成员都没了，那套设置已经没有意义）；群详情页也不能停在那儿
    if (S.groupThreadId === groupId) {
      S.groupThread = null;
      S.groupThreadId = null;
    }
    /*
     * 2026-10-20 用户定：解散后**消息仍留在列表里、只读**。
     * 所以"正在看这个群的一段会话"不该被踢回空态 —— 留在原地重画一次（输入框会自动置灰），
     * 用户刚才读到哪儿还在哪儿。只有从通讯录群详情页解散、手上没有这段会话时，才回消息列表。
     */
    const stillHere = S.conversation?.groupId === groupId ? S.conversation.id : null;
    setNav('messages'); // 内部会重画左栏列表（群行还在，副标题变成「已解散」）
    if (stillHere) await openConversationSafe(stillHere); // 重画成只读
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function renameGroup(thread) {
  const title = await askText({ title: '新的群名称', value: thread.title });
  if (title === null || !title.trim() || title === thread.title) return;
  try {
    await api('/api/groups/' + encodeURIComponent(gidOf(thread)), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title.trim() }),
    });
    await refreshGroup(gidOf(thread));
  } catch (err) { toast(err.message, 'error'); }
}

/* -------------------------------------------------------------- 群加人 */

const memberPicked = new Set();
let memberCandidates = [];

/** 候选列表：一律不预选；勾选状态记在 memberPicked 里，搜索重画也不会丢 */
function renderMemberCandidates() {
  const q = ($('mSearch').value || '').trim().toLowerCase();
  const rows = memberCandidates.filter((p) => !q || p.name.toLowerCase().includes(q));
  $('mList').innerHTML = rows.length
    ? rows
        .map(
          (p) => `<label class="member">
            <input type="checkbox" value="${p.id}" ${memberPicked.has(p.id) ? 'checked' : ''} />
            <span>${esc(p.name)}</span><em>${esc(p.runtime)} · ${esc(p.sandbox)}</em>
          </label>`,
        )
        .join('')
    : '<div class="dim" style="padding:10px 2px">没找到</div>';
  $('mList').querySelectorAll('input').forEach((el) => {
    el.onchange = () => { if (el.checked) memberPicked.add(el.value); else memberPicked.delete(el.value); };
  });
}

function openMemberDialog(thread) {
  const inGroup = new Set(thread.members.map((m) => m.personaId));
  memberCandidates = S.personas.filter((p) => !inGroup.has(p.id));
  if (!memberCandidates.length) return toast('所有数字员工都已经在群里了');
  memberPicked.clear();
  $('mSearch').value = '';
  renderMemberCandidates();
  $('memberDlg').dataset.thread = gidOf(thread);
  $('memberDlg').showModal();
}

$('mSearch').oninput = renderMemberCandidates;

$('mOk').onclick = async (e) => {
  e.preventDefault();
  const threadId = $('memberDlg').dataset.thread;
  const personaIds = [...memberPicked];
  if (!personaIds.length) return;
  try {
    await post(`/api/groups/${encodeURIComponent(threadId)}/members`, { personaIds });
    $('memberDlg').close();
    await refreshGroup(threadId);
  } catch (err) { toast(err.message, 'error'); }
};

/* -------------------------------------------------------------- 新建员工 */

/** 沙箱选项。带 blocked 的那两档实测在 headless 下跑不了命令，必须在界面上说清楚 */
/**
 * 权限的中文名。**id 是给运行时用的，界面上一律显示中文** ——
 * `read-only` 这种裸英文对用户没意义（DSH 里也是"完全权限"这么写的）。
 */
const SANDBOX_LABEL = {
  // codex / dsh 这套
  'read-only': '仅可查看',
  'workspace-write': '工作区内读写',
  'danger-full-access': '完全权限',
  // claude 那套 id 完全不同，也得给中文名，否则界面上还是裸英文
  default: '默认',
  acceptEdits: '自动接受编辑',
  bypassPermissions: '完全权限',
  plan: '计划模式',
};

function sandboxItems(runtime) {
  // 标签用中文名，**后面不挂解释**（如"（现在跑不了命令）"）——
  // 名字自己说得清，括号里的补充是噪音；全站统一（主聊天框、员工详情、流程对话栏都走这儿）。
  const list = runtime?.sandboxes ?? ['danger-full-access'];
  return list.map((s) => ({ id: s, label: SANDBOX_LABEL[s] ?? s }));
}

// 新建员工对话框里的两个下拉：实例常驻、选项随运行时变（选项少，不带搜索）
const pRuntimeCombo = createCombo({ mount: $('pRuntimeMount'), search: false, onChange: () => syncSandboxes() });
const pSandboxCombo = createCombo({ mount: $('pSandboxMount'), search: false });

function syncSandboxes() {
  const r = S.runtimes.find((x) => x.id === pRuntimeCombo.value());
  const items = sandboxItems(r);
  const keep = items.some((it) => it.id === pSandboxCombo.value()) ? pSandboxCombo.value() : items[0]?.id ?? '';
  pSandboxCombo.setItems(items, false);
  pSandboxCombo.setValue(keep);
}

function openPersonaDialog() {
  pRuntimeCombo.setItems(S.runtimes.map((r) => ({ id: r.id, label: r.label })), false);
  pRuntimeCombo.setValue(S.runtimes[0]?.id ?? '');
  $('pCwd').value = S.repoRoot || '';
  syncSandboxes();
  $('personaDlg').showModal();
}

/* ---------------------------------------------------------------- 新建群 */

// 「群助手」下拉：员工可能很多，带搜索
const gAssistantCombo = createCombo({
  mount: $('gAssistantMount'),
  search: true,
  placeholder: '搜员工…',
  onChange: () => renderGroupMembers(),
});

/** 群成员勾选列表：群助手自动在列（锁住），其他一律不预选 */
function renderGroupMembers() {
  const assistantId = gAssistantCombo.value();
  $('gMembers').innerHTML = S.personas
    .map((p) => {
      const isAssistant = p.id === assistantId;
      return `<label class="member${isAssistant ? ' locked' : ''}">
        <input type="checkbox" value="${p.id}" ${isAssistant ? 'checked disabled' : ''} />
        <span>${esc(p.name)}${isAssistant ? '<em class="tag-inline">群助手</em>' : ''}</span>
        <em>${esc(personSubtitle(p))}</em>
      </label>`;
    })
    .join('');
}

function openGroupDialog() {
  if (!S.personas.length) return toast('先建至少一个数字员工，群里只能放数字员工');
  $('gTitle').value = '';
  gAssistantCombo.setItems(S.personas.map((p) => ({ id: p.id, label: personLabel(p) })), false);
  gAssistantCombo.setValue(S.personas[0]?.id ?? '');
  renderGroupMembers();
  $('groupDlg').showModal();
}

// （群助手换人 → 重画成员格，由 gAssistantCombo 的 onChange 负责）

$('gOk').onclick = async (e) => {
  e.preventDefault();
  const assistantPersonaId = gAssistantCombo.value();
  const memberIds = [...$('gMembers').querySelectorAll('input:checked')].map((i) => i.value);
  /*
   * 群名**本地先拦**（2026-10-20 用户截图：空名点创建，弹「E1006：服务异常」）。
   * 空名根本不用发请求 —— 服务端对空标题回的是通用错误码，界面上就成了
   * "服务异常"，人只会以为系统坏了。这里是单纯的表单没填完。
   */
  const title = $('gTitle').value.trim();
  if (!title) {
    toast('先给群起个名字');
    $('gTitle').focus();
    return;
  }
  try {
    const d = await post('/api/groups', { title, assistantPersonaId, memberIds });
    $('groupDlg').close();
    await load();
    setNav('messages');
    await openConversation(d.conversation.id);
  } catch (err) { toast(err.message, 'error'); }
};

/* ------------------------------------------------------------ 换群助手 */

function openAssistantDialog(thread) {
  $('aList').innerHTML = thread.members
    .map(
      (m) => `<label class="member">
        <input type="radio" name="assistant" value="${m.personaId}"
               ${m.personaId === thread.assistantPersonaId ? 'checked' : ''} />
        <span>${esc(m.name)}</span><em>${esc(m.runtime)} · ${esc(m.sandbox)}</em>
      </label>`,
    )
    .join('');
  $('assistantDlg').dataset.thread = thread.id;
  $('assistantDlg').showModal();
}

$('aOk').onclick = async (e) => {
  e.preventDefault();
  const threadId = $('assistantDlg').dataset.thread;
  const picked = $('aList').querySelector('input[name="assistant"]:checked');
  if (!picked) return;
  try {
    await api('/api/groups/' + encodeURIComponent(threadId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assistantPersonaId: picked.value }),
    });
    $('assistantDlg').close();
    await refreshGroup(threadId);
  } catch (err) { toast(err.message, 'error'); }
};

/* ---------------------------------------------------------------- 绑定 */

document.querySelectorAll('.nav-btn').forEach((b) => { b.onclick = () => setNav(b.dataset.nav); });
$('scrim').onclick = closeDrawer;

/* ------------------------------------------------ 列表项右键菜单（绑定） */
/*
 * ⚠️ 这一段**必须放在 boot 区**，不许写进 `renderList()`：列表每次 `innerHTML` 重建，
 *    写进去就会重复绑一次监听 —— 轻则同一个动作执行两遍，重则"删除"被执行两次。
 *
 * 为什么走**事件委托**：`#listBody` 是 index.html 里的常驻节点，行是每次重画的。
 * 右键只认带 `data-conv` 的行；空白处不命中 → 保留浏览器原生菜单（右键复制文字这类操作还得能用）。
 * 右键某行**不会**打开该会话：`contextmenu` 不触发 `click`，无需额外阻止。
 */
$('listBody').addEventListener('contextmenu', (e) => {
  const row = e.target.closest?.('[data-conv]');
  if (!row) return;
  const c =
    (S.conversations ?? []).find((x) => x.id === row.dataset.conv) ??
    (S.hiddenConversations ?? []).find((x) => x.id === row.dataset.conv);
  if (!c) return; // 列表刚重画、数据还没跟上：宁可弹原生菜单，也不要弹一个空菜单
  /*
   * 群也给菜单（2026-10-20 用户要求，跟单聊同一套）：删除 / 不显示。
   * 但群这两项的含义比 1:1 重（群没有聊天记录入口、历史是所有成员共享的），
   * 所以两个动作都带二次确认，文案单独写 —— 见 `dissolveGroup` / `removeConversationForever`。
   */
  e.preventDefault();
  const running = c.status === '跑中';
  /*
   * 「已归档」列表里的行（只在 hiddenConversations 里）：它本来就被收着，
   * 再给「不显示/归档」是废话，所以只留「删除」。
   */
  const alreadyHidden = !(S.conversations ?? []).some((x) => x.id === c.id);
  if (alreadyHidden) {
    /*
     * 「已归档」里只会有两种行（见 `archivedConvs`）：已解散的群、员工已删的单聊 ——
     * 都代表"一整档历史"，删下去是全清，菜单得说实话（`wipeScopeOf` 统一判）。
     */
    const wipe = wipeScopeOf(c);
    openCtxMenu(e.clientX, e.clientY, [
      {
        label: wipe ? '删除并清空聊天记录' : '删除',
        danger: true,
        disabled: running,
        why: running ? '这段还在跑，等它跑完或先终止再删' : '',
        run: () => removeConversationForever(c),
      },
    ]);
    return;
  }
  if (c.kind === 'group') {
    /*
     * 解散的群（2026-10-20 用户定稿）：这一行代表的是"这个群的**全部历史**"，
     * 所以第一项是「删除并清空聊天记录」—— 整群连记录一起清（后端按 dissolvedAt 分派）；
     * 第二项「归档」= 收进「已归档」留着（群都没了，"不显示"的语义不成立）。
     * 没解散的群照旧：「删除」删的是**最新这一段**（群和别的段不动），「不显示」整群暂收。
     */
    const dissolved = !!c.dissolvedAt;
    openCtxMenu(e.clientX, e.clientY, [
      {
        label: dissolved ? '删除并清空聊天记录' : '删除',
        danger: true,
        disabled: running,
        why: running ? '这个群还有一段在跑，等它跑完或先终止再删' : '',
        run: () => removeConversationForever(c),
      },
      dissolved
        ? { label: '归档', run: () => hideConversationRow(c, 'archive') }
        : // 群的「不显示」与单聊**同一个动作、同一个接口**：只写 hiddenAt，
          // 成员关系、群助手、记录全都不动（用户 2026-10-20 明确：不显示≠解散）。
          { label: '不显示', run: () => hideConversationRow(c) },
    ]);
    return;
  }
  /*
   * 单聊两项：
   *   · 员工还在 → 「删除」（删这一段）+「不显示」（不占行，聊天记录里照样看得到）
   *   · 员工已删 → 「删除并清空聊天记录」（这一行 = 这个人的全部历史，只删一段就会
   *                留下"看不见的冗余"：剩下的段还在「已归档」里，而他已经没有任何入口了）
   *               +「归档」（从界面彻底收走，数据留库）
   * 两个动作走同一个接口（`/api/conversations/:id`），后端按"人还在不在"分派。
   */
  const personaGone = !(S.personas ?? []).some((p) => p.id === c.personaId);
  const wipe = wipeScopeOf(c);
  openCtxMenu(e.clientX, e.clientY, [
    {
      label: wipe ? '删除并清空聊天记录' : '删除',
      danger: true,
      disabled: running,
      why: running
        ? wipe === 'persona' ? '他还有一段在跑，等它跑完或先终止再删' : '这段还在跑，等它跑完或先终止再删'
        : '',
      run: () => removeConversationForever(c),
    },
    personaGone
      ? { label: '归档', run: () => hideConversationRow(c, 'archive') }
      : { label: '不显示', run: () => hideConversationRow(c) },
  ]);
});

/*
 * 聊天记录抽屉里的行也能右键「删除」（2026-10-20 用户要求，单聊与群同一套）。
 *
 * 为什么也走**委托**：抽屉每次 `paintChatLogDrawer` 都会 `innerHTML` 重建，
 * 逐个绑定必然漏（跟左栏同一课）。`#drawer` 是常驻节点，挂在它上面一劳永逸。
 * 只认 `[data-log]` 行、且抽屉此时确实是「聊天记录」（群设置里没有这种行，双保险）。
 */
$('drawer').addEventListener('contextmenu', (e) => {
  const row = e.target.closest?.('[data-log]');
  if (!row || S.drawerKind !== 'log') return;
  const c = [...(S.conversations ?? []), ...(S.hiddenConversations ?? [])]
    .find((x) => x.id === row.dataset.log);
  if (!c) return;                       // 数据还没跟上：宁可弹原生菜单，也别弹空菜单
  e.preventDefault();
  const running = c.status === '跑中';
  // 整档清空（已解散的群 / 员工已删的单聊）：抽屉里删任何一段 = 全档清掉，菜单得说实话
  const wipe = wipeScopeOf(c);
  openCtxMenu(e.clientX, e.clientY, [
    {
      label: wipe ? '删除并清空聊天记录' : '删除',
      danger: true,
      disabled: running,
      why: running
        ? wipe === 'persona' ? '他还有一段在跑，等它跑完或先终止再删' : '这段还在跑，等它跑完或先终止再删'
        : '',
      run: () => deleteSessionFromLog(c),
    },
  ]);
});

// 点菜单外面收起。用 `mousedown` 而不是 `click`：项自己的 click 里已经先关了，
// 用 click 会跟它抢顺序（有时先关、有时后关，表现为"点了一下什么都没发生"）
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest?.('#ctxMenu')) closeCtxMenu();
});
// 滚动必须**capture**：列表在 #listBody 内滚，scroll 不冒泡到 window，
// 不 capture 的话菜单会钉在原地、跟着列表"到处跑"
window.addEventListener('scroll', closeCtxMenu, true);
window.addEventListener('blur', closeCtxMenu);
window.addEventListener('resize', closeCtxMenu);
// 键盘可达（P1-4）：上下键在**可用**项之间轮转；Esc 收起；
// Enter / Space 由 <button> 原生负责，不用自己接
$('ctxMenu').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeCtxMenu(); return; }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const items = [...$('ctxMenu').querySelectorAll('.ctx-item:not([disabled])')];
  if (!items.length) return;
  const at = items.indexOf(document.activeElement);
  const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
  items[at === -1 ? 0 : next]?.focus();
});

/**
 * 发起流程弹窗的确认。
 *
 * ⚠️ **必须在这儿绑（全局），不能放进 renderWorkbenchGrid**：
 * 那个函数只有渲染工作台时才跑，而"进流程页 / 在流程页刷新"根本不经过工作台 ——
 * 于是按钮没绑上，点它只会**提交表单把弹窗关掉**，什么都不发生、也不报错
 * （用户实报：点发起左边一点变化没有）。这是从"编排入口搬进工作台"那次留下的。
 */
$('fsOk').onclick = (e) => {
  e.preventDefault();
  doStartFlow();
};
// 流程名称：想法变了就跟着预填（用户自己动过名字之后就不再覆盖）
$('fsIntent').addEventListener('input', () => syncFlowTitle());
$('fsTitle').addEventListener('input', () => {
  fsTitleTouched = !!$('fsTitle').value.trim();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // 右键菜单优先：它压在最上面，Esc 先收它（抽屉开着时两层一起收也无害）
  closeCtxMenu();
  if (S.drawerOpen) closeDrawer();
});
// （下拉的"点别处收起"由公共组件的 click 监听统一处理）
$('search').addEventListener('input', (e) => { S.filter = e.target.value; renderList(); });
$('listAction').onclick = () =>
  S.nav === 'contacts' ? openAddMenu(contactAddItems())
  // 工作台：项目页的 ＋ = 新建项目；插件页的 ＋ = 插件 manifest 里的添加表单
  : S.nav === 'plugins' ? (S.projectList ? projectDialog() : openPluginAdd())
  // 工作流两种模式：编排模板（＋ = 新建模板）/ 看发起记录（＋ = 发起一条）
  : S.nav === 'workflows' ? (S.flowMode === 'run' ? openFlowStart(S.flowTemplate) : newTemplateDialog())
  : openGroupDialog();

/** 工作台里那个「＋」：打开当前插件的添加表单（manifest 的 split.master.add） */
function openPluginAdd() {
  const plugin = S.plugins.find((p) => p.id === S.plugin);
  const add = plugin?.panel?.split?.master?.add;
  if (!plugin || !add) return;
  const all = [
    ...(plugin.panel.blocks ?? []),
    ...(plugin.panel.split?.detail?.actions ?? []),
    ...(plugin.panel.split?.detail?.blocks ?? []),
  ];
  const fb = all.find((x) => x.type === 'form' && pluginFormId(x) === add.form);
  if (fb) openPluginForm(plugin, fb, {});
  else toast(`manifest 里找不到表单「${add.form}」`);
}
// （Runtime 换值 → 同步沙箱选项，由 pRuntimeCombo 的 onChange 负责）

$('pOk').onclick = async (e) => {
  e.preventDefault();
  try {
    const d = await post('/api/personas', {
      name: $('pName').value, role: $('pRole').value, instructions: $('pInstr').value,
      runtime: pRuntimeCombo.value(), sandbox: pSandboxCombo.value(), cwd: $('pCwd').value,
    });
    $('personaDlg').close();
    $('pName').value = ''; $('pRole').value = ''; $('pInstr').value = '';
    await load();
    // 建完停在详情，好让人接着配他（要聊再点「发消息」）
    await openDetail(d.persona.id);
  } catch (err) { toast(err.message, 'error'); }
};

// ⚠️ 按**按钮自己的状态**判断走哪条路（stopping = 正在跑，点它是"停止生成"）。
//    别去依赖 S.running 那类会滞后于界面的状态：这个仓库里踩过 ——
//    依赖外部状态判断，结果按钮点不动，看着像"点了没反应"。
$('send').onclick = () =>
  ($('send').classList.contains('stopping') ? stopChatRun() : send()).catch((e) => toast(e.message, 'error'));

$('input').addEventListener('input', updateMentionPop);
$('input').addEventListener('click', updateMentionPop);
$('input').addEventListener('blur', () => setTimeout(closeMentionPop, 150));
$('input').addEventListener('keydown', (e) => {
  // 选人列表开着的时候，上下键和回车归它用
  if (mentionPop.open) {
    const n = mentionPop.matches.length;
    if (e.key === 'ArrowDown') { e.preventDefault(); mentionPop.index = (mentionPop.index + 1) % n; updateMentionPop(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); mentionPop.index = (mentionPop.index - 1 + n) % n; updateMentionPop(); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insertMention(mentionPop.index); return; }
    if (e.key === 'Escape') { e.preventDefault(); closeMentionPop(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send().catch((x) => toast(x.message, 'error')); }
});

setBusy(false);
// 主题要在首屏渲染前定下来，否则会闪一下深色再变浅色
try { S.theme = localStorage.getItem(THEME_KEY) || 'system'; } catch { S.theme = 'system'; }
S.secCollapsed = readCollapsed();
setComposer(false);   // 还没选会话，输入区先收起
applyTheme();

/**
 * 节点模式页（2026-10-21 拍板：**加入后这台机器只当算力，不做「看总机面板」**）。
 *
 * 已加入总机的机器打开班底，看到的就是这一页 —— 左栏与正常面板整体收起
 * （`body.node-mode` 的 CSS 负责藏，`#nodeView` 长在 `main` 里）。
 * 为什么不是"看自己的面板"：节点不写本机库，"自己的面板"没有内容；
 * 而派给这台机器的活，记录全在总机 —— 本地面板反而看不到自己正在干的活。
 * 所以这里只回答两件事：连着哪台总机、节点进程在不在跑（本机数据/导出在「数据备份」分节，2026-10-21 用户拍板撤掉这一行）。
 *
 * 弹窗（confirmDo 的 #askDlg）是 body 下的常驻节点，没被藏 —— 「退出总机」的确认照常可用。
 */
function renderNodeMode(st) {
  document.body.classList.add('node-mode');
  const main = document.querySelector('main');
  let view = $('nodeView');
  if (!view) {
    view = document.createElement('div');
    view.id = 'nodeView';
    main.appendChild(view);
  }

  /*
   * 本机叫什么、跑的是哪个版本 —— 从 `/api/hello` 拿（它不带秘密，节点身份/版本就是它的内容）。
   * 不等它：先画，回来再重画一次。拉不到就名字位显示"这台电脑"，页面照常。
   */
  let selfName = '';
  let selfVersion = '';
  let lastSt = null;
  api('/api/hello')
    .then((h) => {
      selfName = String(h?.hostname || h?.label || '');
      selfVersion = String(h?.version ?? '');
      if (lastSt) draw(lastSt);
    })
    .catch(() => { /* 拿不到就不显示机器名，别白屏 */ });

  const draw = (s) => {
    lastSt = s;
    const c = s?.client ?? {};
    const local = s?.local ?? {};
    const counts = local.counts ?? {};
    const host = c.hostLabel || c.hostHostname || c.controlPlane || '总机';
    const since = c.since ? dt(c.since) : '';
    const running = !!c.node?.running;
    const external = !!c.node?.external; // autostart 拉起的常驻（退出时要连自启一起收）
    const warnings = (s?.warnings ?? []).map((w) => `<div class="machine-warn">${esc(w)}</div>`).join('');
    /* 明细行的小图标（14px 线性，颜色随 --dim）：给四行明细一点可扫读的锚点 */
    const ICO = {
      hub: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="7" rx="2"></rect><rect x="3" y="13" width="18" height="7" rx="2"></rect><path d="M7 7.5h.01"></path><path d="M7 16.5h.01"></path></svg>',
      link: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"></path><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"></path></svg>',
      pulse: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 12h-4l-3 9L9 3l-3 9H2"></path></svg>',
      clock: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>',
    };
    view.innerHTML = `
      <div class="nodepage">
        <section class="node-hero">
          <div class="node-hero-head">
            <div class="node-hero-ico">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="3" y="4.5" width="18" height="12" rx="2"></rect>
                <path d="M8.5 20h7"></path><path d="M12 16.5V20"></path>
              </svg>
            </div>
            <div class="node-hero-id">
              <div class="node-hero-name" title="${esc(selfName)}">${esc(selfName || '这台电脑')}</div>
              <div class="node-hero-sub">${selfVersion ? `班底 v${esc(selfVersion)} · ` : ''}算力节点</div>
            </div>
            <span class="node-state${running ? ' on' : ''}">${running ? '在线' : '离线'}</span>
          </div>
          <div class="node-linkviz" data-on="${running ? '1' : '0'}" aria-hidden="true">
            <span class="node-link-end"><span class="node-link-dot"></span>这台电脑</span>
            <span class="node-link-line"></span>
            <span class="node-link-end host"><span class="node-link-dot"></span>${esc(host)}</span>
          </div>
          <div class="node-hero-line">这台电脑是「<b>${esc(host)}</b>」的算力节点 —— 总机把活派过来，在这台电脑上跑。班底的面板（员工、会话、项目）只在总机上。</div>
        </section>
        <section class="set-sec machine-card">
          <div class="set-box">
            <div class="set-row">
              <span class="set-label">${ICO.hub}总机</span>
              <div class="machine-data">${esc(host)}</div>
            </div>
            ${c.controlPlane ? `<div class="set-row"><span class="set-label">${ICO.link}地址</span><div class="machine-data machine-addr">${esc(c.controlPlane)}</div></div>` : ''}
            <div class="set-row">
              <span class="set-label">${ICO.pulse}节点进程</span>
              <div class="machine-data">${
                running
                  ? `<span class="machine-dot"></span><span class="machine-ok">在线，等着接活</span>${
                      external ? '<span class="sub">（开机自启）</span>' : ''
                    }`
                  : '<span class="machine-dot off"></span><span class="sub">没在跑 —— 重启这台电脑上的班底试试</span>'
              }</div>
            </div>
            ${since ? `<div class="set-row"><span class="set-label">${ICO.clock}加入时间</span><div class="machine-data">${esc(since)}</div></div>` : ''}
          </div>
          ${warnings}
          <div class="machine-actions">
            <button class="btn-sm danger" id="nodeLeave">退出总机</button>
          </div>
        </section>
        <footer class="node-foot">${selfVersion ? `班底 v${esc(selfVersion)}` : '班底'} · 节点模式</footer>
      </div>`;

    $('nodeLeave').onclick = async () => {
      /* 三句后果 + 建议（PRD §6.4 原文）：破坏性操作走 confirmDo，不用原生 confirm */
      const n = Number(counts.personas ?? 0);
      const ok = await confirmDo(
        `① 这台电脑不再给「${host}」干活；\n` +
          `② 打开班底看到的是这台电脑原来的数据（${n} 个员工，一个没少）；\n` +
          `③ 退出后回到单机；要再加入需要一个新的邀请码。\n` +
          (external ? '④ 它是开机自启拉起的，退出会一并移除自启并停掉节点进程。\n' : '') +
          `建议先在「${host}」的设备页把它「忘掉」，否则那边会留一行永远离线的设备。`,
        { title: `退出「${host}」？`, ok: '退出', danger: true },
      );
      if (!ok) return;
      $('nodeLeave').disabled = true;
      try {
        const r = await post(`${LOCAL_BASE}/leave`, {});
        /*
         * 自启没移除成功 / 进程没停掉时服务端会回 note —— 别装作成功直接刷新，
         * 先让人看见那句话（刷新会把 toast 冲掉）。
         */
        if (r?.note) {
          toast(r.note, 'error');
          await new Promise((done) => setTimeout(done, 2500));
        }
        location.reload(); // 回到单机：本机库原样（加入期间从没写过它）
      } catch (err) {
        $('nodeLeave').disabled = false;
        toast(err.message, 'error');
      }
    };
  };
  draw(st);

  // 5 秒一刷"节点进程在不在"：autostart 拉起的常驻也是 status 里那个开关说了算。
  // 页面被换掉（退出后 reload）就停表 —— 定时器别挂在看不见的节点上空转。
  const guard = setInterval(() => {
    if (!view.isConnected) { clearInterval(guard); return; }
    api(`${LOCAL_BASE}/status`).then(draw).catch(() => {});
  }, 5000);
}

/**
 * 启动分岔（2026-10-21）：已加入总机 → 节点状态页（不加载面板数据）；
 * 未加入 → 正常面板。判据是 `/api/local/status` —— 服务端的答案，本机答、必然可达。
 */
async function boot() {
  try {
    const st = await api(`${LOCAL_BASE}/status`);
    if (st?.client?.joined) {
      renderNodeMode(st);
      startVersionWatch();
      return;
    }
  } catch {
    /* status 拉不到不当"没加入" —— 往下走，load() 自己会把连不上的错报出来 */
  }
  // 回到上次的位置（以前是写死 setNav('messages')：在哪个页面按 F5 都会被弹回消息页）
  load()
    .then(() => restorePlace())
    .catch((e) => { $('chat').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  startVersionWatch();
}
boot();

/* ---------------------------------------------------------------- 版本提醒 */

/*
 * 前端是**长活 SPA**：磁盘上的 app.js 换了，开着的页面不会自己换 JS ——
 * 2026-10-17 一天里踩了两回「点了没反应 / 看到的还是旧页面」，全是它：
 * 页面是几小时前加载的，点到的入口在新代码里有渲染分支、在旧代码里没有，于是原地不动。
 * 这里每 60 秒对一次 app.js 的指纹（mtime+size），变了就在右下角亮「刷新页面」提示条。
 * 为什么不自动 reload：人可能正打着一半字，自动刷新会把输入清掉 —— 提醒，让人自己挑时机。
 */
function startVersionWatch() {
  let known = null;
  let told = false; // 同一轮变更只提醒一次，别每 60 秒都弹
  const check = async () => {
    let v;
    try {
      v = (await api('/api/web-version')).v;
    } catch {
      return; // 服务没起来 / 正在重启：下轮再说，别报错打扰人
    }
    if (v == null) return;
    if (known === null) {
      known = v; // 首次只记账不比较：页面刚加载，谈不上"变没变"
      return;
    }
    if (v !== known && !told) {
      told = true;
      const bar = document.createElement('div');
      bar.id = 'verBanner';
      bar.style.cssText =
        'position:fixed;right:18px;bottom:18px;z-index:999;display:flex;gap:10px;align-items:center;' +
        'padding:10px 14px;border:1px solid var(--line);border-radius:10px;background:var(--panel);' +
        'box-shadow:0 6px 24px rgba(0,0,0,.14);font-size:13px;color:inherit';
      bar.innerHTML =
        '代码有更新，这个页面还是旧的。<button class="mini auto" id="verReload">刷新页面</button>';
      bar.querySelector('#verReload').onclick = () => location.reload();
      document.body.append(bar);
    }
  };
  check();
  setInterval(check, 60000);
}
startVersionWatch();
