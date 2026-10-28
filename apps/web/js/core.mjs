/* core.mjs —— prelude（$、S、esc 等全站基础件）。
 * 2026-10-22 由 app.js（15537 行单文件）拆出，原生 ESM、无打包器；逻辑逐字搬运。 */
/* 班底 · 前端。三级结构：图标栏 → 列表 → 内容 */
export const $ = (id) => document.getElementById(id);



/*
 * 本机身份（2026-10-21 拍板：**节点只当算力，不做「看总机面板」**）。
 * 旧的反代注入（`__BANDI_CLIENT__`）已随 client-proxy 移除 —— 加入状态不再从 HTML 里来，
 * 统一读 `/api/local/status`（服务端答案， boot 处判一次；「这台机器」分区也读它）。
 */
export const LOCAL_BASE = '/api/local';



export const S = {
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
  // 四个维度，空数组 = 那一维不设限：状态 / 负责人（员工 id）/ 项目（项目 id）/ 来源（manual|repo|flow|chat）。
  // 切页面、刷新重画都不丢 —— 它就存在这儿。
  kbFilter: { statuses: [], assignees: [], projects: [], sources: [] },
  kbHiddenCols: [],         // 「列设置」里整列藏掉的状态列（列 key）。跟筛选一样两块看板共用一套
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
  designerRunCount: 0,      // 这个模板跑过多少次（页头「历史记录」按钮上的数字）
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
