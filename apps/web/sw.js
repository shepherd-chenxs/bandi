/*
 * sw.js —— Service Worker 缓存骨架（2026-11 手机端增量，P1-3）。
 *
 * 策略（设计 §5 T05 / §3.3.1.3）：
 *   · 安装期预缓存核心静态（`/`、CSS、入口 JS、**js/*.mjs 全量**、manifest、图标、配对落地页）；
 *   · 运行期对同源 GET 静态资源一律 **stale-while-revalidate**：先回缓存（弱网局域网
 *     二次加载明显快），后台再拉新版入库 —— 于是"改文件后刷新两次内拿到新版本"
 *     （第一刷：旧缓存先回、新版进库；第二刷：命中新版）；
 *   · **`/api/*` 一律放行不缓存** —— 本地优先产品，数据以服务端为准（PRD P1-3 的硬口径）；
 *   · `/pair`（落地页，地址里带着一次性 token）与 `/sw.js`（SW 自己）也永不缓存。
 *
 * 与 startVersionWatch 共存：SW 更新静态后 /api/web-version 的指纹照常变化，
 * 「刷新页面」提醒条机制不动（设计 §1.1）。缓存名里的 VERSION 是人工旋钮：
 *   静态布局大改（预缓存清单变了）时 +1，逼所有客户端整包重建。
 */

/* v13（2026-11-01 七改）：设备行加「取消配对」（已踢出行的清理动作，直删不确认）——
   pairing.mjs + mobile.css 变了，逼客户端换缓存。

   v14（2026-11-01 八改）：默认端口 8787 → 18787（高位、固定不漂），
   pair-claim / machine / collab / projects 的示例地址与提示跟着换。

   v16（2026-11-01 十改）：撤掉 v15 的「已连接」区（与下方「已配对的手机」重复，
   用户看过实际效果后不要了）—— 在线状态仍能在设备行的「最近活跃」里看到。
   pairing.mjs + mobile.css 又变了，v15 已可能被客户端缓存，必须再进一版。

   v17（2026-11-01 十一改）：一机一刀 —— pair-claim.mjs 上报 clientKey
   （同一台手机重配复用同一条设备记录），旧缓存的脚本不会带这个字段。

   v18（2026-11-01 十二改）：断开连接 ≠ 取消配对 —— pairing.mjs / mobile.mjs /
   pair-claim.mjs（resume）/ mobile.css / settings.mjs 全动了，必须再进一版。

   v19（2026-11-01 十三改）：401 遮罩加「重新连接 / 再试一次」按钮（mobile.mjs +
   mobile.css）—— 连接页不再靠返回键进入，只有配对失效时从遮罩主动回去。

   v20（2026-11-01 十四改）：手机壳语音输入 —— 输入条多一个麦克风（桌面浏览器里不出现），
   新增 js/voice.mjs + .voice-* 样式；壳侧加了 Kotlin 的 SpeechPlugin（不走 Tauri IPC，
   走 WebView 的 addJavascriptInterface，见 apps/mobile/README.md）。

   v21（2026-11-01 十五改）：内嵌识别起不来时自动降级到系统语音输入面板；
   面板一弹就关（引擎自身没麦克风权限）给出具体提示 —— 只改 js/voice.mjs。

   v22（2026-11-01 十六改）：「这台机器」页的数据管理区头拿到卡片外（跟设备/运行时
   同款 .fx-head），统计 + 快照包进 .dm-card —— machine.mjs + style.css + mobile.css。

   v23（2026-11-01 十七改）：导出/导入快照按钮任何形态都显示（总机/局域网形态
   不再藏按钮换 CLI 指路）—— 只改 js/machine.mjs。

   v24（2026-11-01 十八改）：协作中心搬进设置 —— 工作台撤磁贴（experts.mjs），
   中心页长在设置 →「协作」组（settings.mjs + collab.mjs + shell.mjs），
   旧缓存的入口/页面都对不上，必须再进一版。

   v25（2026-11-01 十九改）：协作中心设备表的空态收成一句「还没有设备。」（原来那句
   指路把「添加设备 + 接入码」两步都念了一遍，表格正上方就是按钮，属于废话）—— 只改 collab.mjs。

   v26（2026-11-01 二十改）：协作中心撤「我派出去的活」表（用户："任务面板已经有了"）——
   看板的只读协作卡上长出「验收/撤销」（projects.mjs + style.css），中心页只剩设备名录
   （collab.mjs 少拉一路 /api/collab/tasks）。

   v27（2026-11-01 二十改续）：「退出协作」按钮任何形态都显示（用户："是不是少一个退出
   协作的按钮"）—— 服务端把 /api/local/collab/leave 改成 secret:'never'（单向门，同
   restart/export），前端不再按 localSecret 藏按钮；未加入时 serverMode 的指路只说 join。

   v28（2026-11-02 二十一改）：模式卡（分机/总机）从「手机连接」页搬到「协作中心」页顶
   （用户："放到协作中心更合适"）—— pairing.mjs 撤两处挂载、回环指路改去协作中心；
   collab.mjs 设备节上面挂 paintModeCard。

   v29（2026-11-02 二十二改）：模式卡 explicit 态的说明句改桌面/部署两用口径（桌面壳
   起 spawn 时会按 netmode.allowLan 显式传 BANDI_HOST=0.0.0.0，见 shell.mjs —— 桌面
   对外机器自此进 explicit，卡上不再有重启/只在本机使用）。

   v30（2026-11-02 二十三改）：「协作」分节从「这台机器」页搬到「协作中心」页
   （用户："把这个协作移到协作中心，通过分机和总机开关控制显示和隐藏"）——
   collab.mjs 的 renderCollabSection 长在 #clBranchMount（模式卡下、设备表上），
   分机给加入入口、总机一行指路、已加入任何角色都显示状态卡；模式卡新增
   onRoleChange（切角色成功只重画那一节）；connectors.mjs 撤挂载与 import。

   v31（2026-11-02 三十一改）：「连接总机」一律真加入（用户截图："这里应该是连接"）
   —— collab/join 放宽成 secret:'never'（local-policy.mjs），joinCommandDialog
   （终端执行变体）删除；CLI 只服务无头机器。

   v32（2026-11-02 三十二改）：「连接总机」弹窗删掉三段说明文案（用户："删掉这个文案"）
   —— 那一坨「还是一台完整的班底 / 多一个协作项目 / 别跟算力节点邀请码混用」不再出现，
   弹窗只剩地址 + 接入码 + 按钮。

   v33（2026-11-02 三十三改）：「手机连接」页顶加「连接」总开关卡（左标签右开关）
   —— 关 = 邀请码 / 已配对两节整个隐藏，服务端断开全部手机、拒绝扫码 / 连回来
   （POST /api/pair/enabled，E1707；状态存 netmode.json 的 pairEnabled）。

   v34（2026-11-03 二十四改）：「对外服务」这一维整个删除（用户拍板：监听永远对外，
   缺省 0.0.0.0）—— connectors.mjs 撤掉 allowLan 开关 /「重启生效」/「只在本机使用」
   整套第三态 UI，角色（总机/分机）切换立刻生效；v29 里"壳按 netmode.allowLan 传
   0.0.0.0"的机制随之作废（壳现在无条件钉 BANDI_HOST=0.0.0.0，见 shell.mjs）。

   v35（2026-11-03 二十五改）：v33 那张页顶「连接」总开关卡撤掉（用户："邀请码改成连接，
   右边加开关，上面的可以去掉了"）—— 分节标题「邀请码」改叫「连接」，开关贴到标题行最右，
   关掉只换卡片体文案；已配对列表不再跟着藏 —— pairing.mjs + style.css。

   v36（2026-11-03 二十六改）：关闭态从「一行灰字套空框」换成引导卡（图标 + 一句话 +
   「打开手机连接」主按钮，按钮扳分节头那颗开关）；设备计数「还没有」改「0 台」；
   关闭态下设备区只说「暂无配对设备」（原来与引导卡重复说一遍"打开开关"）；
   页头加「已开启 / 已关闭」状态标签；开关关闭态轨道加深（对比 < 3:1，WCAG 1.4.11）
   —— pairing.mjs + style.css。

   v37（2026-11-03 二十七改）：「连接」卡开 / 关两态等高（用户："这两个框要一样大"）——
   实测关态 247、开态 223，拨开关整页抖一下。关态内边距 34/30 收成 22/18，
   卡上加 min-height 223 兜底 + 内容垂直居中；pairing.mjs 分节补 .pair-sec 类
   —— pairing.mjs + style.css。

   v38（2026-11-03 二十八改）：设备绑人 + 审批归因上手机（2026-11-03 服务端两项落地的客户端侧）——
   · pair-claim.mjs：配对 / 连回来的成功页亮一下归属人「正在以「小李」的身份进入工作台…」
     （claim / resume 回执都带 owner，换手重配改了归属时第一眼就能看见）；
   · pair-claim.mjs：E3001 文案跟上 11-03（「切到总机并重启」这套已经删了，
     改成"重新扫一次二维码"）；
   · pairing.mjs：设备列表加「使用者」列（服务端 listDevices 带 ownerName）；
   · settings.mjs：「我的」页设备身份加「以「张三」的身份使用」；
   · projects.mjs：卡详情（手机上批卡的同一页）加「状态改动：谁 · 什么时候」行
     （statusByUserId/statusAt，服务端随卡返回，无需新接口）
   —— pair-claim.mjs + pairing.mjs + settings.mjs + projects.mjs。

   v39（2026-11-03 二十九改）：建卡弹窗在手机上重设计为**全屏工作纸**（实机实报
   "建卡没有完成按钮"——按钮被抽屉裁出屏幕外）：mobile.css 600px 档 #taskDlg 满屏
   贴边、高度跟 --mb-vh（键盘弹起动作条贴键盘上方）、「创建任务」满宽独占一行、
   藏 Ctrl↵；form 转列布局描述吃富余高度，动作条钉底 —— mobile.css。

   v40（2026-11-03 三十改）：toast 送进**顶层**（popover API）—— 开着的 dialog 在浏览器
   顶层，普通层的 toast 被连 backdrop 一起盖住，弹窗里的一切报错（校验失败 / 接口 403）
   在手机上都"看不见"，表现成"点了没反应"（建卡 403 这么藏了一下午）—— shell.mjs。

   v43（2026-11-03）：审计日志行收成单行（结果字跟 action 走、时间右对齐）、类型筛选换
   createCombo 挪进分节头且去边框、.sec-scroll 加 scrollbar-gutter 防抖；「接入码」弹窗
   ① 删掉「模式卡在分机一档才出现…」那句括号说明 —— securityadmin.mjs + style.css + collab.mjs。

   v44（2026-11-03 用户："只要地址和接入码两个，其他说明不要"）：接入码弹窗重设计成
   两张可点复制的字段卡（地址 / 接入码），有效期提示、①②步骤、CLI 命令、E4011 警告、
   回环监听警告、「复制整条命令」全撤 —— collab.mjs + style.css（.cl-inv-*）。

   v45（2026-11-03）：接入码弹窗的标签挪到框外（"标签放框外面"）—— collab.mjs 结构改
   .cl-inv-field（label）+ .cl-inv-box（button），style.css 对应改。

   v46（2026-11-03 账户为主，用户："以账户为主，设备只是它的一个属性"）：「我的」页
   身份卡标题改取**账号**（设备绑了归属人就是归属账号的名字）；设备信息（型号 /
   配对地址 / 配对时间）从身份卡退出来，落成「这台设备」属性卡三行 label + value
   —— settings.mjs + style.css（.me-dev-box/.me-kv）+ mobile.css。

   v47（2026-11-03 用户："通讯录点人物，详情页是空白的"）：三处 ——
   · 通讯录窄屏点「数字员工」行改回**先进详情页**（详情里点「发消息」再开聊）—— contacts.mjs；
   · 手机员工详情补「模型」行（只读，显示名异步问运行时）—— chat.mjs renderDetailMobile；
   · 非列表路径进详情（刷新直达 / 项目成员）没人打 mb-detail-open，main 被 mobile.css
     整个藏掉 → 内容画了也看不见（"空白"根因）：渲染方派 `mb-detail` 事件、mobile.mjs
     补折叠态与历史；真人「成员」行标 `data-nodetail` 不再摆空详情态
     —— chat.mjs + mobile.mjs + contacts.mjs。

   v48（2026-11-03 用户："手机端锁定竖屏"）：壳体钉竖屏（AndroidManifest 的
   screenOrientation=portrait），PWA 那条路补上 MIME —— `.webmanifest` 原来落进
   application/octet-stream，Chrome 直接作废整份 manifest（没有 orientation、没有独立
   窗口）；服务端 http.mjs 加 application/manifest+json。SW 升版本是为了让装过的手机
   重拉那份 manifest（预缓存清单里有它，旧响应的头还是错的）。

   v50（2026-11-04 用户："安装入口去掉，只识别不提供安装"）：「这台机器」页的
   「未安装」段降为「未识别」—— 一键安装 / 复制命令 / 安装命令与进度全撤，只留
   「按路径接入」；wireInstallRuntime / runNodeTask / wireCopyButtons 等一并删除
   —— machine.mjs + app.mjs。

   v51（2026-11-04 用户："只要识别功能，未识别这块不要了"）：「未识别」段连同
   「按路径接入」弹窗整条撤掉（openAddRuntime / testAddRuntimePath / addRtDlg），
   「运行时」区只剩识别 + 已识别列表的接入开关 —— machine.mjs + app.mjs + index.html。

   v52（2026-11-04 用户："重新设计一下这个页面"）：「这台机器」页重设计 —— 运行时
   空态换成虚线引导卡（.rt-empty）；数据管理把点隔统计行改成等宽分格统计块、库路径
   挪出按钮行、快照条目压成单行 —— machine.mjs + style.css + mobile.css。

   v53（2026-11-04 用户："邀请码和地址太大了"）：手机连接页邀请码卡紧凑化 ——
   21px 地址 / 30px 大码收成「标签|值|动作」的紧凑单行，倒计时贴到码后面
   —— pairing.mjs + mobile.css。

   v54（2026-11-04）：协作中心总机模式不再画「协作」分节；两张表的行尾操作列补
   「操作」表头（协作中心 / 手机连接），pair-table 操作列改左对齐；手机连接页
   没配对过就不显示「已配对的手机」整节 —— collab.mjs + pairing.mjs + style.css。

   v55（2026-11-04 用户："关于放到最后，加个图标"）：设置左栏「关于」拆出「通用」组、
   独立一条钉在整列最后，行上加 info 小图标（条目级图标仅此一处）—— settings.mjs +
   contacts.mjs + style.css。

   v56（2026-11-04 用户回退）：撤回 v54 里"没配对过不显示已配对的手机"—— 0 台照旧
   给空状态卡（v54 的其余改动保留：总机藏协作分节、操作表头、pair-table 左对齐）
   —— pairing.mjs。 */
const VERSION = 'v56';
const CACHE = `bandi-static-${VERSION}`;

/*
 * 预缓存清单（SW 不能 glob，手工列 —— 设计 §3.3.1.3 第 1 条）：
 * **新增 js 模块时同步这份清单，并把 VERSION +1**，否则老客户端拿不到新模块（整页白）。
 * js/*.mjs 全部在局域网一次拉完，二十来个文件代价很小；vendor/ 也进（二维码是配对必需件）。
 */
const JS_MODULES = [
  '/js/chat.mjs',
  '/js/collab.mjs',
  '/js/connectors.mjs',
  '/js/contacts.mjs',
  '/js/core.mjs',
  '/js/events.mjs',
  '/js/experts.mjs',
  '/js/flowpages.mjs',
  '/js/groups.mjs',
  '/js/listmenu.mjs',
  '/js/machine.mjs',
  '/js/misc.mjs',
  '/js/mobile.mjs',
  '/js/pair-claim.mjs',
  '/js/pairing.mjs',
  '/js/plugin-data.mjs',
  '/js/projects.mjs',
  '/js/run-progress.mjs',
  '/js/useradmin.mjs',
  '/js/roleadmin.mjs',
  '/js/roles.mjs',
  '/js/voice.mjs',
  '/js/settings.mjs',
  '/js/securityadmin.mjs',
  '/js/shell.mjs',
  '/js/skills.mjs',
  '/js/state.mjs',
  '/js/ui.mjs',
  '/js/workflows.mjs',
  '/js/vendor/qrcode.mjs',
];

const CORE = [
  '/',
  '/style.css',
  '/mobile.css',
  '/app.mjs',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/pair.html',
  ...JS_MODULES,
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // addAll 一颗失败就全废 —— 核心静态逐个来，缺哪张图标不该拖垮整个安装
      await Promise.allSettled(CORE.map((u) => cache.add(u)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      // 清掉旧版本的缓存：名字里带 VERSION，留下来的都是上一代
      for (const name of await caches.keys()) {
        if (name.startsWith('bandi-static-') && name !== CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

/** 这个请求走不走缓存（true = 原样放行网络） */
function bypass(url, request) {
  if (request.method !== 'GET') return true;
  if (url.origin !== self.location.origin) return true; // 只管自己家的静态
  if (url.pathname.startsWith('/api/')) return true; // API 一律不缓存（数据以服务端为准）
  if (url.pathname === '/pair' || url.pathname === '/pair.html') return true; // 落地页带一次性 token
  if (url.pathname === '/sw.js') return true; // SW 自己永远走网络，否则更新不动
  return false;
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (bypass(url, e.request)) return; // 不拦 = 浏览器直连网络

  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(e.request);
      // 后台更新：fetch 失败（离线/服务重启中）静默吞掉，缓存里还有旧的就先用旧的
      const refresh = fetch(e.request)
        .then((r) => {
          if (r && r.ok) cache.put(e.request, r.clone());
          return r;
        })
        .catch(() => null);
      return hit ?? (await refresh) ?? new Response('', { status: 504, statusText: 'offline' });
    })(),
  );
});
