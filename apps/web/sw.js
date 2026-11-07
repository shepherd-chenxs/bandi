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
   —— pairing.mjs。

   v57（2026-11-04 用户："手机端，输入框的提示词去掉"）：手机端对话输入框占位提示
   整个不显示（屏幕小，胶囊里垫一句提示词难看；忙态「他还在说…」一并去掉）——
   chat.mjs（主会话）+ projects.mjs（议题讨论区）+ flowpages.mjs（节点聊天）共用
   chat.mjs 导出的 isNarrowPh 一把尺；桌面文案原样。顺手补登记两个漏清单的模块
   （run-progress-card.mjs / thinking-live.mjs：在线时 fetch 兜底看不出问题，
   离线就是 504 白块）。

   v58（2026-11-05 用户："去掉输入框下面的那个：一次只跑一条xxxx"）：手机端忙态
   输入框下面那行「一次只跑一条。要打断就点「停止生成」」不再显示 —— 打断入口本来
   就在按钮上，屏幕小不再挂说明；桌面保留 —— chat.mjs（主会话 #hint）+
   projects.mjs（议题 tcHint2）。
   v59（2026-11-05 手机端 iOS 风试点）：「我的」页手机形态重画 —— settings.mjs 注释
   更新 + mobile.css 新增 §15b（渐变 hero / 卡片上浮 / iOS 退场行），样式全在
   mobile.css，无新模块，清单不动。
   v60（2026-11-05 用户："字体是不是比主流 APP 小啊"）：§15b 字阶上调 —— 属性行
   15/14→16/15、mono 地址 13→14、说明行 13→14、退场行 16→17，仍只动 mobile.css。
   v61（2026-11-05 用户："字体粗细呢"）：身份章 400→500（badge 中黑档），
   名字 600 / 行文字 400 是 iOS 档不动。
   v62（2026-11-05 用户："手机语音输入的时候，弹窗有点难看"）：语音浮层 iOS 化 ——
   毛玻璃卡 / 状态字 12.5→15 / 取消改胶囊钮 / 波形加宽加高，只动 mobile.css。
   v63（2026-11-05 用户三报"点返回退到登录页"）：历史栈卫生 —— mobile.mjs 回收详情压的
   历史格（幽灵格）、开机截断启动页 forward 残留、跨文档退回旧文档自动续连（/pair?resume=1）。
   返回键从此只关详情 / 在根页交还系统，摸不到登录页。
   v64（2026-11-05 用户要的临时测试标志）：「我的 → 这台设备」多一行"手机端版本"，
   读 SW 实际激活的缓存版本（settings.mjs）。验收完连标志一起删。
   v65（2026-11-05 用户四报"两次返回退到扫码页"）：根页井 —— 返回键在根页原地不动
   （⑦c），App 不再被返回键退出、重开不再落启动页；扫码页只剩断开连接/配对失效能到
   （mobile.mjs ⑦b 去掉 length 门槛，根页标记改成无条件预留）。
   v66（2026-11-05）：进度卡命令块样式收编 —— .rp .rp-act code 提一档优先级，
   不再吃 .bubble code 的边框（用户问"这框是模型给的还是我们的"，实为样式漏进）。
   v67（2026-11-05）：命令块选型「深底亮字」—— --active 底 + --text 字，
   两套主题下都恰好比气泡暗一档（候选预览页里用户点的）。
   v68（2026-11-05）：进度卡"步数/用时"钉死不缩 —— 此前窄泡里被 flex 压成竖排
   （"2 步""00:21"断成四行，用户实拍）；折叠行的"· N 步 · 用时 ▾"同步成块不拆行。
   v69（2026-11-05）：命令块规则从 .rp 根挪到 .rp-step 层 —— 收尾的过程收起行
   （根 .rp-note）此前没被罩住，静态回话里的命令块还带 .bubble code 的边框（用户报）。
   v70（2026-11-05）：聊天气泡的行内码（.bubble code）统一深底亮字、撤边框 ——
   正文里的 `code` 也是胶囊，跟进度卡命令块同一套语言（用户拿 8787 那颗报的）。

   v71（2026-11-05 用户："整个机制去掉，不要有残留"）：手机壳语音输入整个拆除 ——
   voice.mjs 删文件、app.mjs 撤挂载、mobile.css 撤 §15；壳侧 SpeechPlugin.kt /
   lib.rs 注册 / Manifest 录音权限同步拆（见 apps/mobile/README.md）。清单少一个
   文件，升版本让老客户端丢掉缓存的 voice.mjs。
   v72（2026-11-05）：v70 的行内码改色被 .bubble :not(pre) > code（2026-10-19 的
   行内码特异规则，0-1-2 压过 0-1-1）盖住只生效了一半 —— 该规则随旧设计一并撤掉，
   行内码底色真正落到 --active 深底亮字。
   v73（2026-11-05）：用户在候选页改选「纯等宽」—— 行内码/命令块全部无底无框，
   区分只靠等宽字（.bubble code 与 .rp-step .rp-act code 同步换）。

   v74（2026-11-05 用户："点击+号不要弹出卡片，改成打开底部抽屉"）：＋ 菜单手机端
   重做成贴底 action sheet —— #attachMenu 在 900 档改 fixed 贴底（蒙层 = 自身 ::before，
   抓手 = ::after，大行 16px 居中，滑入动 bottom 不动 transform —— 带变换会把 fixed
   蒙层的包含块劫走）；点蒙层 target 落回 #attachMenu 本体，app.mjs 收起判定补一条。
   桌面 popover 原样 —— app.mjs + mobile.css。

   v75（2026-11-05 用户："阶段字体小一些"）：进度卡的段标题原来继承气泡正文 14px，
   比它下面 12px 的命令行还大。`.rp-ph` 钉 12px、段头计数 11.5→11px，
   层次靠 600 字重 + 正文色 —— style.css（实时卡与历史收起行共用）。

   v76（2026-11-05 用户："箭头不要用实心箭头"+"向右折叠、向下展开"）：进度卡折叠行末尾
   的实心 ▾/▴ 换成 mask 描边 chevron（跟分支弹窗同一套），收起转 -90° 朝右、展开 0° 朝下，
   JS 只切 .is-open 类不再改文字 —— style.css + chat.mjs + run-progress-card.mjs。

   v77（2026-11-05）：① 手机建群 E4033（用户报"E4003"）—— group.create / group.sessions
   没打 device 标（conv.create 同一个坑），route-policy 补上，只开建群 + 落新段；
   ② 群「续 @」—— @ 过谁后续的话自动续 @ 谁（localStorage 按群存，WorkBuddy 选专家
   同款）：发送时话里 @ 了人 → 记住他原话照发；没 @ → 把记住那位续到句首；输入条上方
   一颗可摘的「@名字」胶囊 —— index.html + chat.mjs + style.css + mobile.css。

   v78（2026-11-05 用户："群输入框下面的文案去掉"）：群聊空闲时 #hint 那句
   「在输入框里打 @ 就会弹出群成员；不 @ 就找群助手。」不再写（chat.mjs setBusy）。
   #hint 元素保留 —— 还兼职临时提示和输入框被锁的原因行。

   v79（2026-11-05 用户："手机端 APP 风格跟主流 APP 不太一致"→ 消息页 iOS 化）：
   mobile.css 追加 §16.0–16.12 —— token 修订（灰底白面双层 / 文字三档 / --mb-tint
   系统蓝 / 气泡 #0071E3）/ 四条栏玻璃化 / 会话行 / 未读红点样式 / 贴底 action
   sheet。mobile.mjs 新增 ⑧ 长按会话行合成 contextmenu（出 sheet 用）。清单不动。

   v80（2026-11-05 承 v79，补齐遗留三件）：① 聊天页日期分隔 —— chat.mjs drawMessages
   按天插 `.mb-day`（今天/昨天/M月D日，样式 §16.10）；② 聊天头单聊状态字
   「正在干活/现在闲着」（persona.busy，桌面 display:none §16.13）；③ 未读红点数据 ——
   chat.mjs localStorage 账本（SEEN_KEY，进会话记 updatedAt，上限 200），contacts.mjs
   会话行画 `.unread.dot-only`（§16.5）。chat.mjs + contacts.mjs + mobile.css。

   v81（2026-11-05 承 v80，iOS 化推广到其余三个 tab）：mobile.css 追加 §17 ——
   分组页 token 校准（--mb-cvbg → #F2F2F7/#000、--dim/--line 在手机上等于
   iOS 次色/hairline、新增 --mb-card-edge 深色卡边浅色不画）+ 工作台（页底/组头
   13px/磁贴名 17/卡内 hairline）+ 通讯录（A-Z 组头/索引条 tint/忙点 systemGreen/
   子页返回 tint）+ 我的（hero 辉光 tint、退场红 systemRed、卡内线 0.5px）。
   只改 mobile.css，换值不换名。

   v82（2026-11-05 承 v81，桌面 rail 加回版本号）：index.html 品牌块包 .rail-brand +
   `<button id="railVer">`，style.css 补样式，misc.mjs 新增 initRailVersion()（/api/hello）——
   首页骨架与 js/*.mjs 都变了，必须逼客户端整包重建。

   v83（2026-11-05 承 v82，通讯录两处小修，用户点名）：① 入口卡「群聊 / 部门」
   去掉右侧数量字（contacts.mjs 行模板删 .mb-cv-n，成员行保留）；② ＋ 钮去边框
   （mobile.css §16.1 #listAction 补 border:0 —— §17.0 把 --line 换成 hairline 色后，
   桌面按钮底子的 1px 描边在透明钮上显形成了一个方框）。contacts.mjs + mobile.css。

   v84（2026-11-05 承 v83，聊天页消息流降噪，用户：「聊天页 UI 重新设计」）：
   ① 时间戳只在每组第一条下挂 —— chat.mjs drawMessages 给 3 分钟内的后续消息打
   .nt（mobile.css §18.0 手机档藏掉并收回占位高度；桌面共用 HTML、显示规则不动）；
   ② 同人连发打 .tight 行距收紧（6→2px），换人才松开；③ 聊天页头像 6px→10px
   squircle（32px 面上 6px 接近纯方）；④ 代码块 overflow-x 防长行被硬裁。
   chat.mjs + mobile.css。

   v85（2026-11-05 承 v84，聊天页导航栏改版，用户：「导航栏重新设计一下，现在看着有点挤」）：
   ① 手机端撤掉聊天头左上角头像（窄屏 display:none，桌面保留）；
   ② 名字成为详情入口 —— 单聊点名字进员工详情，群聊点名字进群设置，群设置的齿轮钮删除；
   ③ 右侧「正在干活 / 现在闲着」整句去掉（§16.13 段落作废，只留说明）；
   ④ 新会话 / 聊天记录两颗钮去掉桌面按钮底子的 1px 描边，44×44 纯图标热区。
   chat.mjs + mobile.css + style.css。

   v86（2026-11-05 承 v85，聊天头顶栏配色，用户：「顶部导航栏颜色统一改成跟内容区一致」）：
   body.mb-chat .chat-head 的 --mb-nav-glass 玻璃底换成 --mb-chatbg（浅 #FFF / 深 #000，
   与 .chat 同源），backdrop-filter 取消（底不透明后无意义）；分界只剩 0.5px hairline。
   mobile.css。

   v87（2026-11-05 承 v86，手机「我的」页加外观选择，用户：「我的页面加一个主题选择的功能」）：
   ① settings.mjs openMe 手机形态渲染「外观」卡（浅色/深色/跟随系统三行单选，
      hero 渐变下第一张上浮卡；桌面不加 —— 偏好设置里已有同一入口）；
   ② shell.mjs setTheme 加 { keepPage } 参数：手机点完留在「我的」页原地换肤，
      不再重绘设置 › 偏好（那页在手机上不存在）；值仍是 bandi.theme，两处入口同一口径。
   settings.mjs + shell.mjs + mobile.css（§15b 外观卡）。

   v88（2026-11-05 承 v87，导航栏加高，用户：「导航栏高度增加」）：
   --mb-nav 44 → 52。这一个 token 同时喂 .list-head（§3/§16.2）与 .chat-head（§16.8）
   的 min-height/height，还有 #listAction 的垂直居中 top —— 44 是 iOS 基准值，
   但这里 17px 粗体标题 + 44×44 图标热区，上下零余量显贴边；52 各留 4px，
   热区仍居中。mobile.css §16.0。

   v89（2026-11-05 承 v88，群人数并回群名行，用户：「群人数显示在群名后面，不要折行」）：
   上一版人数是第二行副标题，群聊头比单聊高一截。现在一行四样：群名 + 人数 + 徽章 + 钮；
   不折行靠"只有群名可收缩"（.head-name flex:0 1 auto + 省略号），.sub flex:none + nowrap，
   徽章 flex:none —— 名字不够放截自己，人数/徽章/动作钮永不挪窝。
   解散群同名同行（"已解散"），群名改 .head-name-static（可截断、无点击热区）。
   顺手删掉群聊模板尾部一个多余的 </button>（上一轮编辑遗留，浏览器容忍但脏）。
   chat.mjs + mobile.css §16.8。

   v90（2026-11-05 承 v89，三 tab 顶栏统一，用户：「工作台、通讯录、消息的导航栏风格怎么不一致」）：
   工作台/专家库等整页视图的 .detail-head 原来还是桌面那套（50 高白底左对齐无线），
   跟列表页的"52 玻璃栏 + 居中标题 + hairline"不是一回事。现在 body.no-list .detail-head
   手机档对齐列表页：高度走 --mb-nav、--mb-nav-glass 玻璃底、0.5px hairline（::after）、
   标题居中 17/600（head-title 转居中，带 actions 的页标题在剩余空间居中，同列表页结构）。
   mobile.css §3。

   v91（2026-11-05 承 v90，详情页返回栏同高，用户：「也拉到 52 同高」）：
   ① body.mb-detail-open 首行 44px → calc(--mb-nav + 安全区)：返回栏高度与首页导航栏
      同一个 token，刘海机上也不再出现"44 高却带 safe padding"的挤压；
   ② .mb-backbar 手机档底色 --mb-surface → --mb-nav-glass 玻璃 + blur，底边 1px → 0.5px
      hairline（::after），与三 tab 顶栏同一套视觉。聊天页让位规则（body.mb-chat 单行）不受影响。
   mobile.css §2/§10。

   v92（2026-11-05 承 v91，**取文件策略改了**，用户：「手机端没变化」）：
   根因不是样式没写对，是 SW 的 stale-while-revalidate —— index/css/js 全部缓存优先，
   改完代码第一下必然拿旧文件（缓存靠后台悄悄换新），手机上就是"改了跟没改一样"。
   现在分成两类：代码类（导航 + .css/.js/.mjs/.html/.webmanifest）**网络优先**，断网回退缓存；
   图片类（图标/头像）仍缓存优先。内网往返毫秒级，换来"刷新即最新"。
   · 光改 SW 不够：浏览器 HTTP 缓存层仍会用 304 把旧文件喂回来 → 取代码类时加 cache:'no-store'
     （实测：不加，改完 CSS 首次刷新还是旧的；加了才真生效）。
   · 版本升级（activate 时检测到旧缓存被删）→ 给所有窗口 postMessage 'bandi:sw-updated'，
     页面侧（index.html）收到就 location.reload() 一次 —— 手机上 App 挂着不关也能换掉旧画面。
     用 postMessage 而非 clients.navigate：后者在部分 WebView/无头环境会卡死（实测 3 分钟不回）。
   · index.html 的注册改成 register().then(r => r.update())：每次打开都主动查一次版本，
     不指望浏览器"导航时顺便检查"的时机（实测重开一次都未必触发）。
   sw.js + index.html + mobile.css（#verBanner 手机位置）。

   v93（2026-11-05 承 v92，「我的」外观卡改分段选项卡，用户：「也改成这种选项卡的方式」，
   指桌面偏好设置「主题 + 分段选项卡」那张截图）：三行单选（对勾式）→ 一行布局，
   左「主题」标签 + 右 .seg 分段（浅色/深色/跟随系统，选中白格浮起）。
   结构与桌面 .set-row + .seg 完全同构；右对齐分段总宽 ~240px，390/320 都放得下，
   没有当初担心的「跟随系统挤两行」。事件绑定不变（#meThemeBox [data-theme-opt] 委托）。
   settings.mjs + mobile.css §15b。

   v94（2026-11-05 承 v93，底部 tab 栏加高，用户：「手机端底部 tab 栏增高」）：
   --mb-tab 50 → 56。深色主题原来单独覆写成 49（比浅色矮 1px），一并删掉 ——
   基数抬高后那 1px 的差只剩"切换主题时栏高跳动"这一个副作用。
   mobile.css §16 / §16.7。

   v95（2026-11-05 修「断开连接点了没反应」）：openMe 里那段**临时**的「手机端版本」
   探针用了裸 `caches?.keys?.()` —— 局域网 http 是非安全上下文，`caches` 这个标识符
   根本不存在，可选链拦不住 ReferenceError → 渲染后立刻抛错，后面所有按钮绑定
   （#meDisconnect / #meLogout / 主题分段）全部没执行 = 看着能点、其实无处理器。
   那段探针本来就写着"验收完删"，删掉即可。settings.mjs。

   v96（2026-11-05 重排数字员工详情页，用户：「手机端数字员工详情页UI有点丑」）：
   chat.mjs renderDetailMobile（删重复的运行时章、发消息挪到正文末尾通栏）+
   mobile.css §20（身份卡 / iOS 分组行 / 通栏主按钮）。

   v97（2026-11-05 运行时/模型换全屏选择页，用户：「不要使用下拉框」）：
   chat.mjs（mbPicker 模块级选择页 + renderDetailMobile 两行改导航行、collect 补 model）+
   mobile.mjs（popstate/Esc 各一行守卫）+ mobile.css §20.5。

   v98（2026-11-05 选择页视觉二版，用户：「选择模型页有点丑」）：
   chat.mjs mbPaintPicker（header 开新卡、卡外小节标签、行副标题 sub、字符 ✓ 换 SVG）+
   模型页调用（「跟随默认」带真实默认名副标题、顶部说明行）+ mobile.css §20.5 列表重排。
   v99（2026-11-05 选择页卡片左右间隙不一致，用户实测反馈）：
   mobile.css §20.5 —— 选择页滚动条隐藏（占 11px 宽导致卡片左 16/右 27）；
   说明行/组标题缩进 4→16 对齐卡内文字列。
   v100（2026-11-05 返回键四刀：Cookie 判据换 URL 标记）：
   state.mjs markAppUrl（认证通过后网址打 #bandi-app，壳层分流用）——
   Cookie 登录过就一直在，停在登录页也被误判已登录、返回键被吞（用户实报）。
   v101（2026-11-05 手机端任务看板二版 + 独立新建任务页，视觉规格 v2 → v2.1）：
   projects.mjs（窄屏错误态改走窄屏、renderBoardMobile 重写成三槽导航栏 + 胶囊筛选条 +
   单张分组卡连续行 + 刷新转圈、kbMobileRow 新语汇、新增 .kb-new 全屏创建页 +
   提交/历史/popstate、主按钮 aria-disabled）+
   chat.mjs（mbOpenPicker export + 可选 search（固定搜索行/场景占位/「没有匹配的」）+
   行首 dot）+ mobile.mjs（popstate/Esc 各加一行 kb-new-open 守卫）+
   mobile.css §21/§21.1（kb-l-* / kb-new-* / #kbList 滚动宿主 / 选择页搜索行）+
   style.css（退役的 kb-m-* 一整段删除）。
   v102（2026-11-05 任务卡手机版）：projects.mjs paintTaskCardPage 窄屏分支（三槽导航栏 +
   状态胶囊 + tc-m-* 属性卡 + 状态/执行人走 mbOpenPicker + 回复不搬家 + {tcCard:true} 一格历史）+
   mobile.css §22（tc-m-*）。
   v103（2026-11-05 收口）：手机默认档改「便签」（DEFAULT_MODE，发完回默认档）+ saveNow 守卫
   认手机精简 payload（只 {status}，别再 .trim() 炸掉状态保存）+ 自己的便签把「便签」标记
   落到落款行（无作者行时原本整枚标记丢失）。
   v104（2026-11-05 讨论抽屉）：手机任务卡的讨论整体收进导航栏气泡按钮 —— 点开是抖音评论区
   那套底部抽屉（projects.mjs 的 .tc-sheet + mobile.css §22b）。卡页因此只剩状态/标题/描述/
   属性卡；讨论流 + 输入条搬进抽屉，开抽屉压一格 {tcSheet:true} 历史（mobile.mjs popstate/Esc
   各加一行 tc-sheet-open 守卫），900px 断点跨越时重画当前卡（mbTC 画的时候才定）。
   v105（2026-11-05 讨论抽屉「最大化」）：抽屉头部加一颗铺满整屏 / 还原的圆钮
   （projects.mjs TC_ICON_CHEVRONS_* + tcSheetMax 模块级偏好 + mobile.css .tc-sheet.max：
   高度 78%↔100%、圆角收掉、顶部让出安全区、grip 收起）。
   v106（2026-11-05 评论三档放开 + 默认改「讨论」）：服务端撤掉设备令牌只许便签的档位闸
   （project.mjs，E3702 退役），手机讨论/执行与桌面同链路；DEFAULT_MODE 归一 'discuss'
   （同日先定的手机默认便签作废），发完回默认档的注释跟着改。
   v107（2026-11-06 新建任务再设计·方案 A）：创建页从「执行配置」一张长表改成三段卡 ——
   怎么干（执行方式两张独立大卡，选中描边染 tint）→ 派给谁（chips 横滑直选，真人描边
   分家，>6 人给「全部 ›」进原搜索选择页）/ 选流程 → 更多设置（状态/项目/立即开始收进
   一行摘要 + 内联展开，摘要替勾选框说话；缺项目提交时自动撑开）。勾选意愿记进
   kbNewState.startNow（收起时框不在 DOM）；chips 重画保留 scrollLeft。
   v108（2026-11-06 大卡尾 › 箭头）：「派给他 / 由流程执行」两张卡右侧各加一枚 ›，
   点击先把模式切过去再跳对应选择页（执行人带搜索 / 流程）；preventDefault 挡住
   label 对 radio 的默认激活，模式由委托显式设。无已发布流程时流程卡不画箭头。
   v109（2026-11-06 二次收敛）：「派给谁」chips 行与「选流程」行撤掉 —— 卡上 › 箭头
   成为进选择页的唯一入口，选中的人/流程回显在大卡第三行（.kb-new-rpick：有选择染
   主题色，不派活/未选择保持灰）；chips 的委托分支、scrollLeft 搬运与样式一并退役。
   v110（2026-11-06 三改）：「更多设置」不再折叠 —— 摘要行与展开态撤掉，状态/项目/
   立即开始（勾选框 + 动态说明）直接铺开成一段卡；st.more 与 data-kb-more 退役。
   v111（2026-11-06 新建任务页二版·视觉/交互规格落地）：projects.mjs（模板三处：
   撤 radio 圆点、回显值上移到标题正下方、勾选框换开关皮 .kb-new-sw 且退役
   .kb-new-check-in/.kb-new-box；节头「更多设置」→「建好之后」；主按钮文案随模式
   （创建并发起流程/创建并派活/创建任务）；被挡提交焦点落到缺的那格（项目行/流程卡），
   失败焦点回主按钮；成功 toast 带结果「已创建，{名}这就开始」；aria 补全：
   radiogroup/aria-label/describedby）+ mobile.css §21.1（.kb-new 高度改 --mb-vh、
   导航栏收口 .kb-new-bar 自带高度、草稿区卡化、hairline 左缩进 16、选中态
   1.5px tint 环 + 标题染 tint、开关 46×28、提交中保持蓝色只灰 aria-disabled）。
   桌面端零变化（DOM 只在窄屏渲染）。 */
/*    v112（2026-11-06）：任务卡手机端评论入口改版（抖音评论区那套）——
   projects.mjs（卡页底部新增常驻单行评论条 .tc-m-cmtbar，点它升起讨论抽屉；
   导航栏「讨论」气泡按钮撤掉，议题数挪到评论条右侧，KB_ICON_CHAT 随之删除）+
   mobile.css（§22b 新增 .tc-m-cmtbar 玻璃吸底条样式；.tc-main-scroll 底部留白
   24→80px 让开评论条；删除气泡按钮的死样式 .kb-l-navbtn.cmt / .tc-cmt-n）。

   v113（2026-11-06 手机端开放定时任务）：工作台宫格窄屏放开「定时任务」磁贴 ——
   experts.mjs（phoneSchedules = 手机 && 非设备 && 非受限角色，渲染
   workbenchAutoSection({schedulesOnly:true})）+ projects.mjs（workbenchAutoSection
   加 schedulesOnly 参数，工作流设计器仍 PC 独有）+ mobile.css §23（列表单列、
   动作按钮触屏常显 34×34、弹窗两栏转竖排、≤600 全屏工作纸）。清单没加新模块，
   但 experts/projects/mobile.css 都变了，照例进一版逼客户端整包重建。

   v114（2026-11-06 手机端「我的」加清除缓存）：settings.mjs（mb-narrow 渲染
   「通用 · 清除缓存」行，行尾异步显示 bandi-static-* 缓存体积；点击 confirmDo
   后清空 Cache Storage + 注销 Service Worker + 重载 —— 自愈"手机端没变化"）+
   mobile.css §15b（.me-cache-row 按钮行样式，52 高、--mb-press 反馈）。

   v115（2026-11-06 用户「把气泡加回来」）：任务卡讨论入口两个并存 —— 导航栏
   💬气泡（projects.mjs 恢复 KB_ICON_CHAT + #tcCmtBtn/#tcCmtN，mobile.css 恢复
   .kb-l-navbtn.cmt / .tc-cmt-n）+ 底部评论条 .tc-m-cmtbar 照旧；两颗点开同一张
   讨论抽屉，paintCmtBadge 三处数字同刷。

   v116（2026-11-06 用户发抖音截图拍板）：抽屉输入条两态 —— 键盘没起来时抽屉底部
   是一条 42px 单行评论条（工具栏/回复横幅/附件条藏掉，placeholder「留下你的友善评论吧」；
   手机 placeholder 平时是空串由 tcCompact 单独填），点它聚焦展开成完整输入区
   （projects.mjs tcCompact/tcExpand：聚焦展开、失焦 120ms 收回给"点发送"让路）；
   mobile.css §22b 加 .tc-sheet:not(.expanded) 系列规则。

   v117（2026-11-06 用户二报「手机端没有显示定时任务」的根因）：App 从后台**恢复**
   不触发 load，index.html 那条"每次打开查一次 SW 版本"就永远不跑 —— 页面挂着
   多旧就多旧（设备 API 显示手机一直在线 = 页面从没重载过）。现在回前台
   （visibilitychange → visible）也 update() 一次，再挂 10 分钟兜底间隔；
   新版本 activate 的 postMessage 自动重载链路不动 —— index.html。

   v118（2026-11-06 用户发抖音截图：唤起键盘后"后面灰了一些"）—— 抽屉展开态
   （.expanded = 键盘起来的唯一信号）给输入区后面的内容盖一层暗 scrim：
   mobile.css §22b 的 .tc-sheet-panel::after（z:1、rgba(0,0,0,.30)、0.2s 淡入）+
   .tc-sheet .tc-composer 抬 z:2 浮在 scrim 上；pointer-events:none 不挡 ✕/放大。

   v119（2026-11-06 用户「键盘唤起的抽屉顶部加圆角」）：铺满整屏（.max）会归零
   面板圆角，一打字抽屉顶就成直角 —— mobile.css §22b 加
   .tc-sheet.expanded .tc-sheet-panel { border-radius:16px 16px 0 0 }（同特异性
   写在 .max 之后，靠先后赢）。

   v120（2026-11-06 用户报"评论输入框上滑动出现了这个"）：卡页底部那条常驻评论条
   （.tc-m-cmtbar）是设计残留 —— 键盘唤起时它被顶到键盘上方，跟抽屉的输入区同屏
   打架。入口当天已定稿在导航栏💬气泡（#tcCmtBtn），这条整块删掉：projects.mjs
   去 DOM/接线/角标刷新（paintCmtBadge 回到两处数字），mobile.css 删样式并把
   .tc-main-scroll 底部留白 80→24px（当初就是给评论条让的位）。

   v121（2026-11-06 用户「评论框为什么没贴键盘、还能往上滑」的根因）：壳侧
   edge-to-edge 开了之后 Android 不再 adjustResize，键盘是盖在 WebView 上的 ——
   窗口不缩、visualViewport 不缩，web 侧再怎么调都贴不住。修在 MainActivity.kt：
   根内容视图的底部 padding 取 max(导航栏, ime())，键盘弹多少 WebView 就矮多少；
   web 侧配套 mobile.css —— .tc-sheet.expanded 高度改吃 100%（布局视口）而不是
   可能滞后的 --mb-vh，body.tc-sheet-open 锁住整页滚动。

   v122（2026-11-06 用户「键盘唤起后抽屉会往上去，期望是它不要动」）：面板高度是
   78%、而 sheet 高度 = 可见视口 —— 键盘弹起视口变矮，78% 跟着变矮、顶边往上跳
   ≈0.22×键盘高。改为展开态顶边钉死：projects.mjs 新增 pinSheetTop（键盘没起来时
   记下顶边位置喂 --tc-panel-top），mobile.css 的 .tc-sheet.expanded .tc-sheet-panel
   改 absolute + top:var(--tc-panel-top) + bottom:0 —— 键盘只吃掉抽屉下半截，
   抽屉本体原地不动；.expanded.max 顶边归 0。

   v123（2026-11-06 用户红框「加上圆角」）：展开态输入条玻璃底的上缘两角圆 16
   （与面板顶角同档），顶上 hairline 分隔线收掉 —— 玻璃底浮在 scrim 上成一
   张"输入卡"。mobile.css §22b。

   v124（2026-11-06 用户「键盘唤起后把便签/讨论/执行三颗放到输入框下面」）：
   projects.mjs composerBlock 在 att-strip 与 sendbar 之间加 #tcModeChips（三颗
   chip，data-chip），paintMode 同步选中态（.on + data-mode），点击切档位后焦点
   留在输入框；mobile.css §22b 只在 .tc-sheet.expanded 显示这一行，同时把那颗
   「讨论 ▾」下拉（.tc-mode-wrap）收掉。桌面与单行态零变化。

   v125（2026-11-06 用户改口径：「按钮放到输入框外面，在键盘和输入框之间」）：
   #tcModeChips 从 .tc-input-box 里搬出来，挂到 .tc-composer 的卡片之后 ——
   三颗落在输入卡底边与键盘之间那条区域（composer 底部 padding 托着）；
   mobile.css 里去掉左右内边距、加 margin-top:6px。

   v126（2026-11-06 用户「把发送按钮也拿出来，放到输入框下面靠右」）：展开态
   .tc-send 绝对定位到 .tc-composer 右下（right:10px、bottom 与 composer padding
   同档、高 30 与三颗齐平），卡片内的 ＋ 行保留；三颗加 padding-right:96px 让位。
   用绝对定位而非改 DOM —— 桌面/单行态还要吃卡内那颗，同一节点两套位置。
   mobile.css §22b。

   v127（2026-11-06 用户「发送评论之后，要收起键盘恢复到单行输入的状态」）：
   sendText 的收尾按成败分岔 —— 发出去（sent）就 blur + tcCompact 回单行态；
   没发出去仍 focus 留输入框，改完能直接再发。projects.mjs。

   v128（2026-11-06 用户「输入卡要和键盘一个颜色」）：新增 --mb-kb 键盘面板色
   （深 #1C1C1E / 浅 #FFFFFF），展开态把 composer 与 .tc-input-box 都染成它、
   关掉玻璃模糊 —— 输入区连成一张"键盘延长面"，接缝不分你我。mobile.css。

   v129（2026-11-06 用户发抖音截图「折叠评论做成这种方式」）：回复折叠条照抖音
   重做 —— 左短灰线 + 「展开N条回复 ⌄」/展开态「收起N条回复 ⌃」（chevron 翻面），
   撤掉"作者：摘要"预览（replySnippet 下岗）；新回复自动展开的兜底逻辑不动。
   projects.mjs threadsHtml + style.css 折叠条区 + mobile.css 手机端 13px。

   v130（2026-11-06 用户「评论区没有抖音好看」→ 向抖音精修一轮）：① 展开态输入卡
   从白底描边改回 --mb-fill 灰药丸（白区+灰药丸才是抖音质感，描边框在纯白上生硬）、
   focus 边框压掉、textarea 单行时垂直居中（padding 12/14/6）；② 用户名改灰
   （--mb-text-2 13px/500，黑色只留给正文）；③ 头像 32→36；④ 列表 gap 16→20；
   ⑤ 「回复」从描边小药丸改纯灰字。mobile.css 手机档，桌面不动。

   v131（2026-11-06 用户「输入框里的滚动条去掉」）：.tc-input-box textarea 隐藏
   webkit 滚动条（width/height 0 + display:none）并加 scrollbar-width:none ——
   手机上那条暗线会贴着灰药丸的圆角竖着画出来；滚动能力保留。style.css。

   v132（2026-11-06 用户「加号拿出来放到按钮区。按钮区高度增加」）：展开态
   sendbar 高度归零（卡内不再留空条），＋ 绝对定位到卡外那行最左（36 圆、
   hairline 描边），三颗/发送同档 36 高、基线对齐，chips 行左让 54 / 右让 100，
   composer 底部 padding 8→10 —— 按钮区从 44 抬到 54。mobile.css §22b。

   v133（2026-11-06 用户「键盘唤起后输入框还是多行模式，不要改成一行」）：
   展开态 textarea 从 §7 的 44px 单行档改回多行 —— height:auto + min-height:72
   + max-height:140（再多在框里滚），padding 12/14/10。mobile.css §22b。

   v134（2026-11-06 用户「手机端工作台显示定时任务入口」——这条是**二报后**的真根因）：
   上一轮把宫格那一格按「管理员真人账号」放开（判据里的 !devMode），可手机走的是
   **配对设备**令牌（/api/me 回 kind:'device'），正好被 devMode 那一支挡住 ——
   所以无论怎么刷缓存都刷不出来。这回两头一起改：
     · experts.mjs：phoneSchedules 判据改成「窄屏 + 不是被角色砍过的账号」，
       设备形态也放；工作流设计器仍不给（窄屏画不了画布）。
     · 服务端 route-policy：schedule.list/create/one/run 四条 + wf.tpl.list（只读
       清单，建任务时选流程要用）打上 device 标 —— 不打就是"格子点得进去、
       点一下 E4033"。smoke-device-routes 把这几条钉进 MUST_DEVICE。
   ⚠️ 服务端白名单改动要**重启服务**才生效（前端刷新只换静态资源）。

   v135（2026-11-06 用户两连报：「新建定时任务看着有点混乱」+「做法改成选项按钮、
   交给谁做成一行菜单跳新页面选（参考任务面板的新建任务）」）：
     · 根因之一是真 bug：≤900 竖排后内容一高，flex 把两段压扁，段里的标签/输入框
       溢出画到下一段身上 —— 「做什么/交给谁叠在一起、名字框切一半」。sch-cols 开
       滚动 + 两段 flex-shrink:0（mobile.css §23）。
     · ≤600 形态重做（skills.mjs + mobile.css §23）：做法 4 种全排成一排选项按钮
       （.sch-seg，不再藏进下拉）；选人/项目/仓库/流程全换成「一行菜单 + ›」，
       点开推任务面板那张全屏选择页（chat.mjs mbOpenPicker 新增 host 参数 ——
       **必须挂进 modal dialog 本体**，top layer 之下任何 z-index 都压不上去）；
       选完回填行尾。值仍走 Map<key,{value()}>，readSchConfig 一字未改。
       手机上不再自动聚焦名字框（一进来就顶键盘会把做法那排挤没）。
     · 桌面（>600）两栏 + 下拉一字未动（CDP 1280×800 复核过）。
   动了 skills.mjs / chat.mjs / mobile.css，必须进一版逼客户端换缓存。

   v136（2026-11-06 用户：「定时任务顶部导航栏对标任务面板的」）：窄屏列表页换三槽
   导航栏（‹ 返回工作台 / 居中标题 / ＋ 新建），撤面包屑 —— 与看板定稿同一规矩。
   复用 .kb-l-head / .kb-l-navbtn / .kb-l-navtitle（mobile.css §21 原样生效，零新 CSS）；
   看板的两颗内联 SVG（KB_ICON_BACK / KB_ICON_PLUS）从 projects.mjs export 共用，
   不许各画一份漂移。桌面（>900）headRow + 面包屑一行不动。
   动了 skills.mjs / projects.mjs。

   v137（2026-11-06 用户：「定时任务点击添加按钮，现在是打开抽屉操作的，改成跳转到一个
   新的页面。对标任务面板的做法」）：手机（≤600）新建/编辑定时任务从满屏 dialog 换成
   整页 .sch-page（借 .kb-new 那套外框：滑入、玻璃底顶栏、页脚贴键盘、压一格历史、
   有草稿返回先问放弃）。skills.mjs 新增 schEnsurePage/schOpenPage/schTryClose/schClosePage，
   mobile.mjs 的 Esc/popstate 给 .sch-page-open 放行；mobile.css §23 重写（弹窗规则换页规则）。
   桌面（>600）仍是两栏 dialog，一字未动。

   v138（2026-11-06 用户：「新建定时任务的定时器，不要使用下拉，改成使用抽屉」）：手机
   （≤600）重复区去掉 .combo 下拉 —— 「重复」变一行菜单点开**底部抽屉**（.sch-sheet，
   整组选项摊开 + 当前值打勾 + 取消，压一格历史），「星期 / 月份」同款抽屉；间隔 / 日期 /
   时间仍是输入框但排成同一行语汇（.sch-pick-static）。skills.mjs 新增 schSheet 四件套 +
   schRepeatBodyPhone / mountSchRepeatPicks；mobile.css §23 加抽屉与行样式。
   桌面（>600）重复区仍是下拉，一字未动。

   v139（2026-11-06 用户：「重复方式为每天时，时间的选择方式是系统自带的，不好看」）：
   「时间」那一行不再用原生 <input type="time">（Android 弹系统时钟盘，另一套皮还压页脚）
   —— 换成一行菜单点开**抽屉里的时:分转轮**（两列 scroll-snap 滚轮 + 中线高亮槽 +
   上下渐隐 + 取消/完成，同一张 .sch-sheet 面板按需换内容）。skills.mjs 的抽屉从写死
   清单改成 schShowSheet（清单 / 转轮两种内容），新增 schOpenTimeSheet / schWheelCol；
   值仍落在 hidden #schAt，保存那段一字未改。mobile.css §23 加 .sch-time / .sch-wheel-i。
   桌面（>600）时间仍是原生 input，一字未动。

   v140（2026-11-06 用户：「重复方式为单次时，时间也不好看，你重新设计一下，跟其他的统一」）：
   「单次」原来是一个自建日历浮层（.combo + .dt-pop，日历格 + 两个原生 <select> 选时分 ——
   手机上又弹回系统滚轮）。拆成**两行**与「每月」同构：「日期」= 一行菜单点开抽屉里的
   月历（点某一天即收，schOpenDateSheet + .sch-date-* 样式），「时间」= 上一轮那颗转轮。
   两行各自改动都拼回 hidden #schRunAt（YYYY-MM-DDTHH:MM），保存段一字未改；
   mountSchRepeatPicks 里手机那颗 .sch-dt 挂载点随之删掉。坑：月历格子用 repeat(7,1fr)
   会被固定 38px 圆点把每列顶到 62px，周日整列被裁出面板 —— 必须 minmax(0,1fr)。
   桌面（>600）「单次」仍是那颗日历浮层，一字未动。

   v148（2026-11-07）：协作子系统整体退场 —— 预缓存清单删 /js/collab.mjs（模块本体
   已删，清单项还留着会把整张模块图 404 掉：app.mjs 那行 import 就是「侧边栏点不动」
   的元凶）。同批下线的还有 /js/roleadmin.mjs、/js/roles.mjs（角色/菜单体系退场）。

   v149（2026-11-07 用户：「这个系统版本从哪里来的」）：「我的 › 这台机器 › 系统 / 版本」
   那行的左边（原 `navigator.platform`）报的是**看页面那台电脑**的平台 —— Windows 上远程
   看 Linux 主机会写 Win32。改由服务端 `/api/hello` 新增的 `os` 字段回答（README 契约
   加字段不动既有键）。settings.mjs 变了，进一版逼客户端换。

   v150（2026-11-07 用户：「修改手机端」）：手机「我的」页也有了「这台机器」卡 ——
   原来这张卡只在桌面画（手机窄屏当成"语义不对"整段跳过），可手机用户恰恰想知道
   自己连的是哪台机、跑的哪版。窄屏拆三行（设备名 / 系统 / 版本），不合并成一行：
   `.me-v` 是 break-all，内核号会被拦腰断字。顺带把「通用 · 清除缓存」挪到它后面，
   两张设备卡读在一起。settings.mjs 变了，进一版。

   v151（2026-11-07 用户：「当前设备菜单 + 退出回登录页」）：手机「我的」页壳里多一行
   「当前设备」（显示这台面板是哪台机器），点了导航回启动页的设备列表换一台；
   「退出登录」在壳里不再落在面板的登录页，而是回启动页最开始的登录页（意图经
   #bandi-devices / #bandi-bye 传给 launcher.js boot）。两行只在壳里渲染
   （window.__BANDI_SHELL__ 由壳注入），浏览器 / PWA 行为不变。settings.mjs 变了，进一版。

   v152（2026-11-07 原生壳）：壳换成 Kotlin 原生 App（apps/mobile-native），桥升级成
   addJavascriptInterface 的 `window.BandiShell`（页面第一行起可用）：「当前设备」
   与「退出登录」优先调方法（openDeviceList / onLoggedOut），旧 Tauri 壳的
   __BANDI_SHELL__ hash 流保留作兜底，浏览器 / PWA 照旧走各自路径。settings.mjs 变了，进一版。

   v153（2026-11-07 实机截图）：退出登录的确认弹窗写着「这台浏览器上的登录票」——
   同一个弹窗在手机壳里也出现，手机上叫"浏览器"是错的，改成「这台设备」。进一版逼客户端换。

   v154（2026-11-07 用户：「点击退出不要使用抽屉，要使用弹窗」）：移动端的确认弹窗
   （#askDlg，confirmDo 共用）从底部抽屉改成居中小卡片 —— 确认框是"一句话 + 两个
   按钮"的小东西，抽屉又矮又贴底，按钮正好怼在导航栏上。内容型弹窗仍是抽屉，
   只有确认框改居中。mobile.css 变了，进一版。 */
const VERSION = 'v154';
const CACHE = `bandi-static-${VERSION}`;

/*
 * 预缓存清单（SW 不能 glob，手工列 —— 设计 §3.3.1.3 第 1 条）：
 * **新增 js 模块时同步这份清单，并把 VERSION +1**，否则老客户端拿不到新模块（整页白）。
 * js/*.mjs 全部在局域网一次拉完，二十来个文件代价很小；vendor/ 也进（二维码是配对必需件）。
 */
const JS_MODULES = [
  '/js/chat.mjs',
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
  '/js/run-progress-card.mjs',
  '/js/settings.mjs',
  '/js/securityadmin.mjs',
  '/js/shell.mjs',
  '/js/skills.mjs',
  '/js/state.mjs',
  '/js/thinking-live.mjs',
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
      /*
       * 清掉旧版本的缓存：名字里带 VERSION，留下来的都是上一代。
       * `replaced` 同时是个信号：**有旧缓存 = 这次是版本升级**（不是首次安装）。
       */
      let replaced = false;
      for (const name of await caches.keys()) {
        if (name.startsWith('bandi-static-') && name !== CACHE) {
          await caches.delete(name);
          replaced = true;
        }
      }
      await self.clients.claim();

      /*
       * 版本升级时，通知已经开着的页面自己重载一次（2026-11-05「手机端没变化」）：
       * 手机上 App 常常一直挂着，旧页面里跑的还是旧 HTML/旧 CSS —— 新 SW 接管了也
       * 换不掉"已经渲染好的那一屏"。
       * 用 postMessage 而不是 clients.navigate：navigate 在部分 WebView/无头环境里会卡住。
       * 首次安装不发（没有旧缓存 → replaced=false），免得打断配对/首屏。
       * 只在这一刻发一次，不会循环（下次 activate 要等下个版本）。
       */
      if (replaced) {
        const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const w of wins) w.postMessage({ type: 'bandi:sw-updated' });
      }
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

  /*
   * 两类资源两套策略（2026-11-05 用户实报「手机端没变化」后改）：
   *
   * ① **代码类 · 网络优先**：页面导航、.css / .js / .mjs / .html / .webmanifest。
   *    原来是"缓存优先 + 后台偷偷更新"（stale-while-revalidate）—— 第一下必然拿旧文件，
   *    缓存虽在后台换新了，用户这屏已经是旧的，得再刷一次才看见。手机上看起来就是
   *    "改了跟没改一样"。局域网里那点往返根本不算事，而"改完看不到"是致命的。
   *    断网 / 服务重启时回退到缓存里那份，离线仍然能用。
   * ② **图片类 · 缓存优先**：图标、头像、截图，体积大、基本不变，先用缓存最快，
   *    后台照旧悄悄刷新。
   */
  const isNav = e.request.mode === 'navigate';
  const isCode = isNav || /\.(?:m?js|css|html|webmanifest)$/i.test(url.pathname);

  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);

      if (isCode) {
        try {
          /*
           * cache: 'no-store' 是必需的（2026-11-05 实测踩到）：只把 SW 改成网络优先还不够，
           * 浏览器自己的 HTTP 缓存层会拿 If-Modified-Since 换来一个 304，把旧文件继续喂回来。
           * 服务端（http.mjs）本来就发 Cache-Control: no-store，这里再钉一次，
           * 免得换个静态服务器（python -m http.server 之类）就退化。
           */
          const r = await fetch(e.request, { cache: 'no-store' });
          if (r && r.ok) cache.put(e.request, r.clone());
          return r;
        } catch {
          const hit = (await cache.match(e.request)) ?? (isNav ? await cache.match('/') : null);
          return hit ?? new Response('', { status: 504, statusText: 'offline' });
        }
      }

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
