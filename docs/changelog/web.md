# Web 静态缓存的版本沿革（sw.js 的 VERSION）

> 从 `apps/web/sw.js` 头部搬出来的（2026-11-08）。那份 changelog 当时占了 837 行里的
> 600 多行 —— 文件 86% 是注释，改缓存策略前要先翻过 160 个版本。
>
> **`VERSION` 仍是唯一旋钮**：预缓存清单变了（新增 js 模块、改了静态布局）就 +1，
> 逼所有客户端整包重建；同时在这里补一条记录，写清"为什么进这一版"。
>
> 这份记录**允许**提到已删除的文件（`pairing.mjs`、`pair.html` 之类）—— 它记的是历史，
> 不是指路。`tools/check-ghost-refs.mjs` 也按这个口径把 `docs/changelog/` 划进归档区。

```
v13（2026-11-01 七改）：设备行加「取消配对」（已踢出行的清理动作，直删不确认）——
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
   走 WebView 的 addJavascriptInterface（Tauri 壳 README，已随 apps/mobile 删除）。

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
   lib.rs 注册 / Manifest 录音权限同步拆（同上，壳 README 已删）。清单少一个
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
   只有确认框改居中。mobile.css 变了，进一版。

   v155（2026-11-07 用户：「文案改成：是否确认退出当前账号？取消和退出按钮做大一些」）：
   退出登录的确认框正文收成一句问句（撤掉登录票/访问令牌那段解释），两颗按钮升到
   44px 高的拇指档 —— 新开关 askDialog/confirmDo 的 `big`，挂 `#askDlg.ask-big`，
   只有这个弹窗开。settings.mjs / machine.mjs / style.css 都变了，进一版。

   v156（2026-11-07 用户发微信「账号设置 › 退出登录」截图：「参考这个改」）：`ask-big`
   从"右对齐的两颗大按钮"改成参考图那张卡片 —— 标题 18px 居中、说明 15px 居中灰字、
   两颗按钮**等宽铺满**、高 46px / 圆角 10px、弹窗 400px 窄卡片 + 20px 圆角 + 投影。
   顺带把 #askBody 的字号行高从 index.html 的内联 style 搬进 style.css（内联压过
   `.ask-big`，改不动），焦点环从浏览器默认的黑描边换成主题色。index.html /
   style.css / sw.js 变了，进一版。

   v157（2026-11-07 用户实机截图：「怎么跟你的展示图不一样」）：v156 的预览是静态
   HTML，而真身里 `<b id="askTitle">` 会被 ui.mjs 的 wireDialogHead() 搬进 `.dlg-head`
   （flex + 左对齐 + 左右 -20px 负边距 + 右上角 ×）—— 于是标题贴左、× 露出来，跟
   参考图/展示图都不一样。补两条：`.dlg-head` 归零并居中（确认框没有长内容，不用吸顶）、
   `.dlg-close` 藏掉（参考图没有关闭按钮）。style.css 变了，进一版。

   v158（2026-11-07 用户：「点击退出没有反应」）：**真根因不是样式** —— logout() 从
   useradmin.mjs 并进来后是模块级函数，却引用了 openMe() 里的局部 `const nativeShell`，
   严格模式走到那行直接 `ReferenceError: nativeShell is not defined`：/api/logout 已经
   执行（会话真删了）、页面却没跳 = 看着"没反应"。改成在 logout() 里按 `window.BandiShell`
   现取一次，桥调用失败再兜底重载。settings.mjs 变了，进一版。

   v159（2026-11-07 用户：「去掉下面的说明文案」）：手机工作台磁贴只留图标 + 名字 ——
   `.wb-page .wb-desc { display: none }`（≤900 档），桌面 >900 那版照旧带说明；
   17.1 段那条 .wb-desc 的 color 规则随之撤掉。mobile.css 变了，进一版。

   v160（2026-11-07 用户：「老体系去掉」）：手机配对体系整体退场 —— 桌面端「手机连接」
   分节（二维码 / 9 位邀请码 / 连接开关 / 已配对设备表）、扫码落地页 pair.html 与
   pairing / pair-claim 两个模块、vendor/qrcode 一起删；「我的」页的「这台手机」卡与
   「断开连接」按钮随之消失（手机就是登录进来的账号，退出走「退出登录」）。
   手机端只剩一条路：中枢账号登录（App 里 WebView 带会话进门）。sw.js / settings /
   state / mobile / experts 都变了，进一版。

   v161（2026-11-08 用户：「导航栏统一一下。+号去掉。」）：手机端项目页导航栏不再放
   「＋ 新建项目」那颗钮（#listAction 窄屏隐藏，桌面端原样保留）—— 消息 / 工作台 /
   我的这些手机页导航栏都是干净的，就项目页多一颗，看着不统一。空态文案随之收掉
   「点右上角 ＋ 新建一个」的引导（手机上没有那颗钮）。projects.mjs 变了，进一版。

   v162（2026-11-08 用户：「标题直接使用项目就可以」）：手机端项目页导航栏标题不再写
   「工作台 › 项目」面包屑，只写「项目」—— 回宫格走底部导航（工作台 tab），面包屑
   不用兼任入口；桌面端保留完整两级。projects.mjs 变了，进一版。

   v163（2026-11-08 用户：「手机端的基础信息、项目规章去掉」）：手机端项目详情页只留
   「项目成员」一个页签（默认激活），基础信息 / 项目规章两个页签不输出 —— 大表单与
   低频编辑适合电脑上做。面板 DOM 仍渲染（hidden 不删）：自动保存 collect() 照常取值，
   服务端字段不缺。projects.mjs 变了，进一版。

   v164（2026-11-08 用户：「这一行去掉」）：手机端项目详情页整行页头（名称 / 目录 pill /
   任务 / 删除）不输出 —— 名称顶部导航栏（‹ 项目名）已有，任务 / 删除是低频操作留给
   电脑。#pjTasks 绑定补了可选链（元素可能不存在）。projects.mjs 变了，进一版。

   v165（2026-11-08 用户：「目录去掉」）：手机端项目列表行不再显示目录路径（.line2）——
   路径太长挤占一行；搜索仍按目录命中，只是不展示。桌面端原样。projects.mjs 变了，进一版。

   v166（2026-11-08 用户：「这个怎么点不开」）：修任务看板**卡片点不开** —— 任务卡整页
   渲染里还留着一处 `isCollab` 引用（协作中心 2026-11-07 整体退场时删了变量、漏了这一处），
   openTaskCardPage 抛 ReferenceError，表现就是点了卡片毫无反应、页面停在看板。
   删掉「总公司」那一支（来源只剩 流程 / 仓库值班 / 手动建卡）。projects.mjs 变了，进一版。

   v167（2026-11-08 用户圈了执行人问「这是一个流程项目。不应该是这个卡吧」）：**还没发起的
   流程卡改成「发起台」形态** —— ① 执行人从"只有一个选项的假下拉"改成纯文本「由流程执行」
   （执行人由流程当前节点决定，服务端本来就拒绝改派，摆下拉只会让人以为能选）；② 讨论
   区 / 输入条 / PR 区不渲染（发起前没有经办人、没开工，这两块只会是空的）；③ 说明行旁
   加「发起流程」按钮（确认后等价于状态改「进行中」，走同一条保存管道，发起后自动带去
   流程实例页）。已发起的流程卡照旧直达实例页，普通手工卡一律不变。projects.mjs 变了，进一版。

   v168（2026-11-08 用户：「右边加一块固定面板。用来展示各种状态的数量，当前是全部项目
   还是某个项目」）：任务看板右侧加**固定统计面板** —— 标题写当前范围（全局面板「全部项目」
   / 项目看板写项目名），下面按状态列数量（跟列头同一套状态色），底部合计。数字取筛选前的
   真实分布（列头上的才是筛后），拖卡/建卡删卡后随 kbRepaint 一起刷新；面板钉在右边，
   不随列横向滚。两块看板（全局 / 项目）共用。projects.mjs + style.css 变了，进一版。

   v169（2026-11-08 用户：「点击应该直接进度到任务卡，不应该有中间那个」）：手机上看板点
   **流程卡**不再经过「发起记录」列表页 —— 带着具体实例跳进 openFlowRun 时（pickRunId 有值）
   窄屏直接派 mb-detail 铺开实例页 + 顶上返回栏；返回落在发起记录列表（它就是上一级）。
   从「发起记录」入口浏览着进的仍先看列表。flowpages.mjs 变了，进一版。

   v170（2026-11-08 用户：「点返回还是能跳转到发起记录」）：手机直达实例页（上一条）返回时
   不再落到这页左栏的「发起记录」，改成画回**点进来的那一页**（看板 / 项目 / 任务卡 / 会话）；
   来路存进当前那格历史（flowDirect），刷新后还认得回去，拿不到来路就回看板。界面态
   body.flow-direct-open：mobile.mjs 的「‹ 返回」/ Esc / 手势返回看到它就把收场交给
   flowpages（leaveDetail 走 flow-direct-leave 事件）。flowpages.mjs + mobile.mjs 变了，进一版。
```
+
+   v171（2026-11-08 用户圈了状态词：「状态放卡片右上角」）：窄屏看板行的状态（点+词）从
+   元信息行挪到**标题行右上角**，与标题首行齐顶（词 12.5px 抬 2px 对齐 16px 标题）——
+   竖列表扫状态视线路径最短。元信息行剩 项目 pill / 执行人 / 时间 三段（收缩优先级注释
+   随之更新：执行人先让、pill 后让）。kbMobileRow + mobile.css 变了，进一版。
+
+   v172（2026-11-08 用户圈了「（没派活）」：「要能选人」）：手机任务卡页的执行人行从只读
+   改成**可点行**（带 chevron）—— 点开全屏选择页（mbOpenPicker，与状态胶囊同一套），选项
+   与桌面 combo 同口径（不指定 / 真人 u: 前缀 / 数字员工，带搜索）；选中立刻刷行上名字并
+   落库（待办+人 = 自动开工，同桌面）。手机 snapshot 随之带上执行人字段；还没发起的流程卡
+   保持只读（服务端本来就拒绝改派）。projects.mjs 变了，进一版。

   v173（2026-11-08 用户圈了看板工具栏的「刷新 PR」：「去掉，放在这里不伦不类的」）：
   任务看板工具栏的「刷新 PR（n）」按钮**整颗移除**（kbPrRefreshHtml + 点击绑定一并删，
   工具栏回到 筛选 / 列设置 / 刷新 三件）。PR 状态更新能力不受影响：单卡详情里的
   「刷新状态」照旧，服务端 `POST /api/git/prs/refresh` 保留。projects.mjs 变了，进一版。

   v174（2026-11-08 修 v168 引入的语法错误）：openBoardPage 收尾的 `}` 在加 wireKbStats()
   那次编辑里被吃掉了 —— 模块整个 parse 失败，SPA 起不来，表现是**全页点不动**（消息页
   空列表、导航无响应）。补回闭合括号。诊断教训：`--input-type=module --check`（stdin）
   是可靠语法闸；报错行只是第一个撞上的 export，真正失衡点在它之前的函数体里。

   v175（2026-11-08 用户圈了页头「筛选 / 列设置 / 刷新」三颗钮：「改成图标，不要文字」）：
   任务看板页头三颗钮改**纯图标**（icon 15px、padding 收成方钮），文字含义挪进
   title / aria-label；筛选的   计数角标保留（有筛选时图标旁仍带数字）。kbFilterBar /
   kbColsSettingHtml + style.css 变了，进一版。

   v176（2026-11-08 用户圈了刷新图标：「这个刷新按钮是不是没有用啊」）：按钮本身**有用**
   （CDP 实测点击确实重抓 /api/tasks 重画整页 —— AI/别的设备改的任务不实时推过来，这是
   唯一入口），但数据没变时画面一动不动、又没有反馈，看起来像死的。点下去加转圈反馈
   （只转图标，尺寸不动，同手机端 .kb-l-refresh 的 spinning）。projects.mjs + style.css
   变了，进一版。

   v177（2026-11-08 用户：「还是慢」）：**代码类资源从网络优先改回缓存优先**
   （sw.js fetch 的 isCode 分支）。11-05 改成网络优先治的是"改完看不到"，理由是
   "局域网里那点往返不算事"——局域网成立，走中枢中转不成立：实测 style.css
   TTFB 5.4s / 总计 8.8s、app.mjs 2.9s，23 个文件按 HTTP/1.1 同域 6 并发算
   ≈ 10 秒起步，每次打开全部重下，SW 缓存等于废掉。
   现在：命中缓存直接回、后台悄悄换新（stale-while-revalidate）；
   **主动刷新（导航 request.cache === 'reload'）仍然全量走网络，并且先清空
   整个静态缓存**——只换 HTML 不换 js 会出现"新结构配旧脚本"，宁慢一次给一整套。
   "改完看不到"由 startVersionWatch 的 /api/web-version 指纹提示条兜底（misc.mjs:505），
   不需要 SW 再当第二道保险。仅 sw.js 变；VERSION v176 → v177 逼客户端换新 SW。

   v178（2026-11-08 头像瘦身 + 懒加载，3M 带宽前置准备）：avatars/ 里 23 张 **256² PNG
   平均 93 KB**，而页面最大只显示 58px —— 照片存 PNG（无损）压不动，是格式选错。
   走中转/3Mbps 时一屏 20 张 ≈ 1.86 MB ≈ 5 秒，比整个应用外壳（brotli 595 KB）还贵，
   且每进一次列表重来一遍（头像不在 SW 预缓存清单）。
   ① `tools/avatar-webp.mjs`（需 `npm i --no-save sharp`）生成同名 .webp：160px/q82，
      合计 2139 KB → **58 KB（-97%）**，3M 下满屏头像 5.7s → 0.2s；原 PNG 一张没删。
   ② `http.mjs serveStatic` 按 `Accept: image/webp` 内容协商换发 webp；**只要 webp 存在
      两种响应都挂 Vary: Accept**（中间缓存把无 Vary 的 PNG 存下来发给所有人，webp 就白做）。
      头像 Cache-Control 放宽为 `public, max-age=86400`（改头像代价 = 明天才看到；
      代码类仍 no-store，语义不同别混）。personas.avatar 存的文件名、onerror 兜底全不动。
   ③ ui.mjs / chat.mjs / groups.mjs 的头像 <img> 加 `loading="lazy" decoding="async"`
      —— 屏幕外的不拉，首屏列表只付可见部分的流量。

   v179（2026-11-08 frp 不再内置，隧道层整块下线）：用户决定「把 frp 从 bandi 里移掉，
   不内置，以后需要我自己装」。所以删的不是一个二进制，而是**这层能力**：
   ① `hub/tunnel.mjs`（生 frpc.toml / 起停 / 重连 / 收尸）、`vendor/frp/`（17 MB exe）、
      `apps/desktop/fetch-frpc.mjs`、`build-frpc.mjs`、`smoke-tunnel.mjs`、`deploy/relay-aliyun/` 全删；
   ② `/api/hello` 的 `relay` 字段、「我的」页桌面/手机两处外网状态行 + `.me-relay/.me-dot` 样式删；
      状态行没有真相可显示了 —— 进程不归我们管，编个状态比不显示更害人；
   ③ 打包链路：`stage-runtime.mjs` 不再拷 `vendor/frp`，`tauri.conf.json` 去掉 `runtime/vendor → vendor`
      映射（不删它，桌面打包会因「资源路径不存在」直接失败 —— 删 `runtime/vendor` 后才暴露，
      所以是**先删映射再删目录**），`pack-linux.mjs` / `install.sh` 的 frpc 取包与 chmod 一并撤；
   ④ **`hub/relay.mjs` 保留，故意的**：它不只喂隧道进程，还给 `http.mjs` 供 Host 守卫与写请求
      Origin 白名单。自己装 frp 后域名照样打进来，这两闸不认它就是「页面能开、改任何设置都 403」。
      自建路径写进 `<数据目录>/tunnel.json`（或等中枢心跳下发）。
   顺带：`run-smokes` 去掉 smoke-tunnel 条目（不删会让整条冒烟因文件不存在而红）；
   `check-pr` 白名单去掉只服务于 frp 编译的 `goproxy.cn`，`ghfast.top` 留着（取 Node 仍在用）；
   smoke-tunnel 的删除登记进 ASSERT_WAIVERS（写明「无替代」，不是放松闸门）。
   **影响**：本机重启后隧道不再自动起 —— 手机/外网这次真的断了，要自己装 frp 才回来。

   v180（2026-11-08 头像外圈"黑边"根修）：那不是 border（avatarStyle 的 inline 早已把
   border-color 设 transparent），是 `overflow:hidden + border-radius` 裁切的**抗锯齿渗边**——
   图片边缘落在非整数设备像素上时，裁切边把图与垫底的 hsl(hue 34% 26%) 深色字母底混出
   1px 暗环；框色随人变（张坤 rgb(89,44,66)=hsl335°、贺韬 rgb(44,44,89)=hsl235°）就是铁证，
   素材 PNG/WebP 四边逐像素扫过均无描边。修法：`.avatar .av-img` 外扩 1px
   （inset:-1px + calc(100%+2px)），裁切边落在图片内部像素上，底色不参与混色；
   cover 多裁 2px 源图，38px 显示尺寸下不可见。`.mavatar`（群磁贴，不裁切、图自身圆角）
   与 `.mp-avatar` 未动，那边没有这个现象。

   v181（2026-11-08 v180 头像改动整体回退，用户要求"回退成原来的样子"）：
   v180 的"外扩 1px"没解决问题（对比渲染证明新旧两格暗环一模一样），真正的成因是
   `background-clip` 默认 `border-box` —— 深色字母底画进了 1px 边框区，而图片只铺
   padding-box，永远盖不住那圈，于是透出一圈随人变色的暗环（控制变量实验：去背景消失、
   去 border 仍在、`background-clip:padding-box` 消失）。但该修法让图片顶到外沿、
   视觉上"贴边了"，用户不接受，故 **`style.css` / `ui.mjs` 与头像有关的改动全部还原为
   HEAD 状态**（`.avatar`、`.avatar.sm`、`avatarStyle()` 行内样式、`.av-img` 均无 diff）。
   头像的 `loading="lazy" decoding="async"`（v178）与 WebP 内容协商不动 —— 那是另一笔账。
   结论留档：外圈暗环 = 深色字母底从透明边框透出，不是素材描边、不是 border、不是裁切。

   v183（2026-11-08 历史"过程收起行"砍掉，用户："运行进度卡是落库了吗？感觉也没啥用"）：
   回话气泡顶上那行「✓ 意图 · N 步 · 用时 ▾」连同展开明细整个删掉，服务端也不再给
   回话消息摘 meta.progress 快照；**实时进度卡（调用工具 N 步 / 停止按钮 / 卡住判定）
   原样保留**。砍的理由：这边跑的 codex 系 runtime 不发工具结果事件，快照里 174/174
   个步骤状态都是「已发起」、耗时全 null，展开只剩一串截断的命令 —— 既不知道成没成、
   也不知道单步多久；真正有用的"走到哪步、卡没卡、能不能停"本来只活在直播里、不进历史。
   run_events 仍全量落库（重连重放 / 排错用），只是不再给回话消息摘快照。
   老消息里已有的 meta.progress 由**数据库迁移**清掉（结构版本 1→2，见 store/db.mjs 的
   migrateDropMessageProgress）：只动有 progress 的行、清完只剩空对象就把 meta 置 NULL、
   坏 JSON 跳过；本机实测清 32 条，`stopped` 等兄弟字段原样保留。
   改动：runs.mjs（progressMeta/replyMeta 收成只记 stopped）、chat.mjs（删
   progressNoteHtml 与 data-rp-note 接线）、run-progress.mjs（删 summarizeEvents）、
   style.css（删 .rp-note* 与 .rp-note-arrow 组合选择器）、smoke-run-progress.mjs
   （断言改成「不再渲染 / 不再落库」）、store/db.mjs（SCHEMA_VERSION 1→2 + 迁移）、
   smoke-db-migration.mjs（新用例，已登记 run-smokes）。仅内容改动，预缓存清单没动，
   但 VERSION 仍 +1：js/css 都变了，逼客户端整包换新。
   v184（2026-11-08 「我的」页恢复定稿版式，用户拍板）：今晚两轮改动整体撤回 ——
   ① 齿轮 + 「我的 › 设置」子页（meSetOpen，把这台机器/通用搬进子页）；
   ② mobile.css §24 的 Airbnb 重排（去渐变 hero、大标题锚点、主题挪页尾、退出改浅红胶囊）。
   两轮都是未提交的工作区改动，定稿版式在 HEAD（6bdd441）里 —— settings.mjs / mobile.css
   的 me 部分整体回到 HEAD，只保留 frp 下线必须删的外网状态行（relayText / relayPhone）。
   mobile.mjs 的两行 me-set popstate/Esc 守卫一并撤。齿轮改动留档在 git stash（stash@{0}），
   哪天要再上齿轮/子页从那里取。教训照旧：**设计定稿之后不要再"顺手"改版式** ——
   每次重排都要过用户。
   v185（2026-11-08 「我的」页加昵称，删掉「中枢账号 · 手机号登录」，用户拍板）：
   身份卡改成两行 —— **第一行昵称、第二行手机号**。没设昵称时标题退回手机号（页面不至于
   空着）、副行给一个「＋ 设置昵称」入口；右侧常驻小铅笔（55% 透明不抢戏，**不做 hover
   才显形**：手机没有 hover）。点开用全站统一的 askText 弹窗改，留空 = 清除。
   昵称存 `users.nickname`（结构版本 2→3），**与账号名分开**：name 是中枢影子名
   （通讯录 / 消息署名用它），改昵称只动展示名、不动署名 —— 合成一个字段的话，改昵称
   就等于改账号名，改错了还找不回来。
   服务端：/api/me 的 user 多一个 nickname（null = 没设）；PATCH /api/users/:id 接受
   nickname（空白 = 清除，超过 20 字 E3813）；smoke-users 加 ⑤c 钉「改 / 清空 / 超长 /
   不动账号名」，③ 的字段集与 ⑤ 的 /api/me 形状断言同步更新。
   改动：settings.mjs（身份卡两行 + 编辑接线）、style.css（.me-edit / .me-nick-set）、
   mobile.css（铅笔触控区 34px）、store/users.mjs（nickname 列 + setNickname）、
   store/db.mjs（SCHEMA_VERSION 2→3）、routes/users.mjs（meOf + PATCH nickname）。
   ⚠️ 服务端要重启一次（加列 + 新接口）才生效；前端刷新即可看到新身份卡。
   v186（2026-11-08 运行进度卡改成「单行气泡刷日志」，用户："这个看着不好看，
   我觉得改成单行气泡刷日志更好看 —— 重要的不是显示的是什么，是在动"）：
   运行中的那块从**多行小卡**压成**一行**：日志写"此刻正在做的那一件事"（跑着的那个
   工具，codex 系没有结果事件时退到最后一步），新动作到了上滑换掉；步数与用时收到右端，
   中间用 1px 竖线隔开（不加的话"搜索 xxx 10 步"会连读成一句）；停止钮缩成同高的小 chip
   （描边压到 line 的 78%，一行的尽头必须有出口，但不该比日志亮）。
   **不给自己加边框和底色**：这块本来就在 .bubble 里，再套一颗胶囊就是框里套框 ——
   用户截图那块丑，一半来自这两层框。所以气泡本身就是那颗单行泡。
   "在动"的三层信号：点的呼吸 + 从点上荡开的细圈（不看事件、一直在走，模型憋 40 秒不
   说话时全靠它）、日志行上滑（只在文字真变时播，每秒重画不重放动画）、秒数在走。
   卡住的判断直接写进日志行（"可能卡住了 · 最后动静 N 分钟前"），不再单独占一行；
   步骤明细保留，收尾后点这一行展开（任务卡页没有整页重画，那里还要能回看）。
   失败时错误原文露在下面一行红字（步骤级 error 也认 —— codex 系多半只有它）。
   改动：run-progress-card.mjs（DOM 一行化 + setLog 的换行动画 + 收尾折叠进日志槽，
   运行中不再每秒重画 8 行步骤）、style.css（.rp 整段重写：去外壳、点扩散圈、
   .rp-roll、竖线、chip 停止钮、窄屏只藏步数）。仅前端改动，VERSION 仍 +1。

   v187（2026-11-08 用户实拍对比："我的是这个效果，跟你的图不太一样"）：单行气泡一版
   在真站里没成立，两个根因都不是配色 ——
   ① **位置**：进度那一行 append 在正文 `.bubble` **里面**，回话一长气泡就被撑成一大块，
      那行只剩"小字标题"的观感，跟预览里那颗独立小泡完全不是一回事；
   ② **内容不动**：日志挂在"最后一步"上，而 codex/claude 的 MCP 调用（`mcp_tool_call` /
      `mcp__server__tool`）以前只能出"调用工具"四个字、没有目标 —— 一跑几分钟同一句，
      看着像死在那儿（下面正文其实早就在流）。
   改法是**换 DOM 而不是换皮**：chat.mjs 的正在跑那行多一层 `.live-col`，进度卡与 `.bubble`
   成了兄弟节点 —— 进度自己一颗 30px 高的胶囊（`.rp-head` 加回描边/底色/999px 圆角，
   宽度上限跟气泡同档 90%；手机 82%、无描边，跟 iMessage 那套一致），回话另起一颗气泡。
   日志同时修正：`toolSummary` 从 `detail.server/tool` 或名字 `mcp__server__tool` 里把工具名
   读出来当目标（"调用工具 aliyun · DescribeInstances"）；且只有**真在跑**或**刚落下去
   20 秒内**的工具才占这一行，其余时间报阶段（写回话 / 思考中），不再挂着旧工具名撒谎。
   步骤明细、收尾折叠、错误原文那一行都不变。
   改动：chat.mjs（.live-col + insertBefore）、style.css（.live-col、.rp-head 胶囊化、
   三态描边）、mobile.css（手机胶囊无描边 + 82%）、run-progress.mjs（mcpLabel + detail 字段）、
   run-progress-card.mjs（日志的 20 秒新鲜度）。smoke-run-progress ⑥ 换新断言、
   ③ 补两条 MCP。仅前端改动，刷新即可（SW v187 逼客户端换缓存）。
   v188（2026-11-08 实时气泡改回**一颗泡**：日志行被正文原地顶掉，用户拍板 A）：
   用户口径：「单行气泡刷日志，显示什么不重要，重要的是在动；真正的回复出来后
   代替这个单行日志气泡」。三版落实：
   · chat.mjs 只建**一颗** .bubble（先挂 .live-line：泡自己不画框），进度胶囊住在里面；
     真正的回复一到 → enterAnswer 移除胶囊、摘掉 .live-line，同一个泡原地变回话泡 ——
     日志泡和回话泡不会并排出现（二版是 .live-col 下两颗兄弟泡，用户实拍还是两块）；
   · 工具之前的正文只是「中间话」：先攒着不画，第一件工具一到就丢；纯聊天（整轮没工具）
     在 turn_end 时画回来，回话不丢；
   · 思考片段也刷在这一行（「思考过程」开着时）：优先级 报错/卡住 > 思考片段 > 正在跑的
     工具 > 阶段词。原来那块"思考直播"灰字块与 .think 样式随之退场；
   · 「真正的回复」判据按用户口径 A：工具之后的正文一开流就顶掉日志行（不是等整轮跑完）。
   改动：chat.mjs（单泡 + enterAnswer/pendingText）、run-progress-card.mjs（showThinking +
   日志行优先级）、style.css（.bubble.live-line，删 .think）、sw.js（预缓存清单去掉
   thinking-live.mjs，VERSION v187 → v188）、smoke-run-progress.mjs（三版断言）。

   v189（2026-11-08 「思考过程」配置退场，用户："上一个改动还有一个小尾巴，把这个配置去掉吧，没啥用了"）：
   员工配置里那个「思考过程」开关整个删掉（桌面 配置 › 执行配置 + 手机员工详情两处），
   showThinking 也从 persona 建/改接口退场（老库 personas.showThinking 列留着不读，
   同 users 的死列惯例；接口收到这个字段会被当未知字段忽略）。
   理由：实时气泡已经收成"一行在动"的日志，显示什么不重要（思考片段/工具/阶段轮着刷就行），
   再留一个"内容显不显示"的配置没有意义。
   行为变化：思考片段**固定**刷在那一行（原来只在开关开着时进），工具/正文一到就换掉。
   改动：chat.mjs（去两处开关与保存字段）、run-progress-card.mjs（去 showThinking，
   思考固定进日志行）、mobile.css（去该开关的 iOS 尺寸规则）、routes/persona.mjs /
   server.mjs / store/personas.mjs / store/conversations.mjs（去 showThinking 读写）、
   route-policy.mjs（设备可改字段 4→3）、smoke-run-progress.mjs（断言改成"思考固定进这一行、
   开关已退场"）。VERSION v188 → v189。
   v190（2026-11-09 单气泡直播收进共用状态机，任务卡讨论区补上；英文中间话不再铺段落）：
   用户实拍（沈丹青任务卡讨论区）：进度胶囊下面堆了十几段英文中间话 —— 讨论区没接
   聊天页那套「单行日志 → 回复顶掉」的设计，把每个 text 事件当正文一段段 add 了。
   另外英文工作流会在**每次工具调用之间**"解说"一句，这些 text 在事件流里跟真回复长得
   一样，按旧规则（工具之后的正文=回复）会提前把日志行顶掉、中间话照样铺开。
   收口成一份共用状态机 `js/run-live.mjs`（chat.mjs / projects.mjs 共用）：
   · 跑着时只留那一行日志（思考片段 / 工具 / 阶段轮着刷）；
   · text 一律不直播，先攒着；后面又来了工具事件 → 那段是中间话，丢弃；
   · turn_end / 收尾时还没被工具顶掉的，才是真正的回复 → 顶掉日志行、落进同一颗泡。
   代价（明确接受）：回复不再逐字流、收尾时整段出现 —— 换来"整轮只有一行在动"。
   改动：新增 run-live.mjs；chat.mjs（去内联状态机改用它）；projects.mjs（讨论区接入）；
   sw.js（预缓存清单 + VERSION v189 → v190）；smoke-run-progress.mjs（断言改钉共用状态机）。   v191（2026-11-09 团队协作：任务卡可派给群，群助手（必须 PM 岗）动态承接）：
  看板建卡弹窗的「执行人」多第三档：团队协作 · 群名（只列群助手是项目经理的群；后端建卡/派发
  还会再校验一次）。卡上不记协调人 —— 派发、子卡授权、回执都现读群上的群助手，换人自动跟随。
  群助手可拆子卡（parentTaskId，一层、派本群成员、不能派给自己），子卡回执唤醒群助手；
  群卡片详情执行人一栏显示「团队协作 · 群名」，可改回派人/真人（改派走同一条 PATCH）。
  改动：projects.mjs（建卡/详情执行人清单接入团队协作、快照发 assigneeGroupId）；
  sw.js（VERSION v190 → v191）。后端改动见 store/db.mjs（结构版本 4）、project-tasks.mjs、
  routes/agent-cards.mjs、routes/project.mjs；新增 smoke-group-tasks.mjs（已登记）。

   v192（2026-11-09 多机协同 / 算力节点子系统彻底删除，用户拍板：无存量机）：
  服务端节点端点全删；本机软件商店安装任务端点从 /api/nodes/local/tasks 改挂
  /api/local/tasks（POST 下发、GET 列表、GET /:tid 查询，响应形状不变）。
  前端跟着清：
  · misc.mjs 删掉节点状态页 renderNodeMode 与 boot 的 client.joined 分岔 —— 所有机器都走正常面板；
  · connectors.mjs 四处安装任务改走 /api/local/tasks，模式页 / 邀请码 / 加入的历史注释块清干净；
  · machine.mjs 去掉 nodeOnline 离线标注，设备详情的任务进度轮询改走 /api/local/tasks/:tid；
  · style.css / mobile.css 删 node-mode、#nodeView、joinwiz、machine-* 等无人使用的死代码；
  · core.mjs 的本机身份注释改成与本机安装任务相符的说法。
  改动：misc.mjs / machine.mjs / connectors.mjs / core.mjs / style.css / mobile.css；
  sw.js（VERSION v191 → v192）。

   v194（2026-11-09 员工详情「任务」页：卡片 → 表格 → **按日期分组** → **顶部状态筛选**，
   用户三连拍板「任务做成表格」「任务记录参考浏览器这种方式，按照日期来」
   「不要单独列出来。而是在上方加状态筛选」）：
   ① 原来是竖着摞一串看板卡（.kb-card）。那形状在看板上是对的（列里能拖、一叠一叠看），
      到了员工详情就不合适 —— 主区一栏宽、又不给拖，卡片的"面"只是白占纵向高度，
      手上十件活要滚三屏。改成表格：一行一件事，**任务（标题 + 项目/来源/PR 标签）/ 状态 / 时间**。
   ② 分堆从"生命周期"换成**按天分组**（照浏览器历史那套）：「今天 · 2026年11月9日 星期一」
      「昨天 · …」「2026年11月7日 星期六」…；日期进了段标题，行里只留 HH:mm（右对齐，
      完整时间在 title 上）。新的在前，日期用行上的 `at`（服务端 stamp() 的本地时间）。
   ③ 「要人管」（已阻塞 / 失败 / 待验收）**不再单独成段**：它曾经钉在表头当跨天收件箱，
      既占掉小半屏又和日期段抢同一批行。现在是一颗**筛选胶囊**（全部 / 要人管 / 进行中 /
      待办 / 已完成 / 已取消，各带件数），表格因此严格按天分组、只有一套排序。
      筛选是纯前端 —— 不重新请求；件数为 0 的档不画（当前选中的那档除外，否则筛空后
      连自己在哪一档都看不出来）；筛空时给一句「看全部 N 件」。
   ④ 顺手去掉手工卡那行左侧的 2px 蓝竖条（用户圈图「这个去掉，不好看」）：它本来是从看板
      卡上抄来的身份标记，可表格里连续几行手工卡一画，竖条首尾相接成了一条贯穿整段的
      装饰线 —— 反倒不像"这一行是人加的"。身份交给标题下面那颗「手动」标签说。
   状态那一格的颜色按**看板列**上色（--st-*，跟列头同一套），不按中文词面猜。
   改动：chat.mjs（personaTaskCard → personaTaskRow、personaTasksHtml 加 filter 入参并铺 <table>、
   新增 TASK_FILTERS / filterOfCol / ymdOf / taskDayLabel，筛选点击委托在 #dTasksBody 上；
   PERSONA_TASK_GROUPS / PERSONA_URGENT_COLS 退场）；
   style.css（.pt-cards / .pt-group / .pt-hint / .pt-at-day 退场，新增 .pt-tbl / .pt-sec / .pt-row /
   .pt-filters / .pt-filter / .pt-fnum / .pt-reset 等，含 ≤560px 的收窄）；sw.js（VERSION v193 → v194）。


   v195（2026-11-09 昵称全端生效，用户："用户的昵称不能只在我的页面里生效"）：
   昵称之前只在「我的」身份卡活着，其它显示真人的地方（通讯录成员、聊天里别人的署名、
   派活选真人、任务指派人）走的还是账号影子名 —— 等于白设。收口成一个口径：
   **昵称 = 全端显示名，账号名 = 身份口径**（「是不是自己」的判断、署名存储一字不动，
   只换"画出来叫什么"）：
   · 服务端 listUserBriefs（/api/state 的 users 名册）带上 nickname —— 通讯录成员段、
     派活选真人、任务执行人的数据源一次喂齐；
   · 别人的真人署名按昵称画：chat.mjs 新增 senderNickOf（按 senderUserId 从名册查昵称，
     走 opts.senderNick 进 bubble）；projects.mjs 的 humanOf 同口径；认人仍按
     senderUserName（账号名）比，检测逻辑一个字没动；
   · contacts.mjs 成员行名字 / 头像首字吃昵称（跟「我的」身份卡同款读法），搜索账号名、
     昵称都命中；
   · shell.mjs 新增 userLabel（昵称优先，没设退账号名，查无此人 → null 好接 ?? 兜底），
     projects.mjs 派活选人、任务执行人、状态改动显示全走它；
   · settings.mjs 弹窗文案改成"全端显示名"，保存后同步名册里自己那条（派活选人立等可见）。
   改动：store/users.mjs（briefs + nickname 列注释改口径）、routes/users.mjs（meOf 注释）、
   shell.mjs、chat.mjs、contacts.mjs、projects.mjs、settings.mjs；smoke-users.mjs（⑤c 加钉：
   /api/state 名册带昵称且不改账号名）；sw.js（VERSION v194 → v195）。
