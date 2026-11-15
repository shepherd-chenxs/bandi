/* settings.mjs —— 设置、关于、额度。
 * 2026-10-22 由 app.js（15537 行单文件）拆出，原生 ESM、无打包器；逻辑逐字搬运。 */
import { esc, setRoute, setTheme, toast } from './shell.mjs';
import { api, dt, failHtml, initial, openCtxMenu, post, showFail, wireDialogHead } from './ui.mjs';
import { headRow, renderPlugins, renderRuntimes, rtLoading } from './connectors.mjs';
import { openRemotePage, setPluginRerender } from './experts.mjs';
import { askText, confirmDo } from './machine.mjs';
import { renderList, showView } from './contacts.mjs';
import { setListTitle } from './flowpages.mjs';
import { openCodeRepoPage, renderSkillCards } from './skills.mjs';

// 设置 › 安全（2026-10-31 IAM Phase 1）：我的会话 + 审计日志
import { renderSecurity } from './securityadmin.mjs';
import { $, S } from './core.mjs';
import { registerLayer } from './navstack.mjs';



/* ---------------------------------------------------------------- 我的 */

/**
 * 「我的」（2026-10-31，rail 底部新增的一级栏）：**只管"我是谁"** ——
 * 当前登录的人（头像 / 名字 / 身份）+ 退出登录。
 *
 * 为什么不把偏好/关于搬进来：用户拍板「设置还是放到左边菜单栏」—— 设置一节不动，
 * 这里就只放设置页没有的那件事：登录身份。退出登录与用户管理页共用同一份
 * （logout()，两张票一起清），别处再写就是第二套口径。
 *
 * 整页形态（左栏收掉，与工作台/专家库同款，setNav 里已把 no-list 带上）；
 * 容器借设置页的 #settingsView —— 反正两者不会同时出现，省一个常驻节点。
 *
 * 2026-11-01 手机端改造（用户："手机我的页面改造一下。显示当前登录卡，然后加一个设置入口那种"）：
 *   手机底部「我的」tab 以前**直接进设置页**，等于把"我是谁"这一层吞掉了 —— 打开
 *   个人中心却看到一堆开关。现在按主流 App 的「我的」做：**上面一张登录卡、下面一个
 *   设置入口**，设置页退成它的下一级（见 renderList 里那条返回行）。
 *   桌面照旧：左栏本来就有「设置」，这里再摆一个入口是重复，所以入口只在窄屏画。
 *
 * 2026-11-03 桌面重设计（用户："这个页面重新设计一下"）：三段式个人中心 ——
 *   ① 身份卡（.me-hero-card）：头像 + 名字 + 身份章 + 一行说明，页面唯一的视觉重心；
 *   ② 账号安全双卡（.me-sec-grid）：密码 / 动态验证各一张，图标 + 状态章 + 说明 + 动作，
 *      取代原来"一节一行的两张清单卡"；
 *   ③ 退场整行（.me-out-box）：退出登录/断开连接/去登录，整宽一行、文字染色。
 *   版心收窄到 980px（.me-body）—— 这页只有三块内容，铺满 1400px 只会显得空。
 *
 * 2026-11-03 三改：**账户为主**（用户："以账户为主，设备只是它的一个属性"）——
 *   身份卡的标题永远是**账号**：手机设备绑了归属人，头像和名字就取归属账号；
 *   设备本身（型号 / 配对地址 / 配对时间）从身份卡里退出来，落成「这台设备」
 *   属性卡的三行 label + value（.me-dev-box）。零账号形态的老设备没有账号可
 *   显示，才退回设备名兜底，meta 写明"未绑定账号"。原来那行"以「X」的身份使用"
 *   随之作废 —— 账号就是标题，不用再用一句话解释"这是谁"。
 *
 * 2026-11-05 手机端 iOS 风试点（用户："手机页面太线性化……改成 iOS 风是不是更好？
 *   先改我的页面我看看效果"）：手机形态按 iOS 个人中心的读法重排 —— 通栏渐变
 *   hero（身份居中放大）→ 卡片上浮压住渐变下缘 → 卡外灰组头/内缩分割线/居中退场行。
 *   DOM、类名、功能白名单一概没动（本文件代码零改动）—— 样式全在 mobile.css §15b，
 *   桌面（非 mb-narrow）不受影响。
 */

/*
 * 外观选项（2026-11-05 用户：「我的页面加一个主题选择的功能」）。
 * 键与桌面 设置 › 偏好 › 主题 完全同一套（'light' / 'dark' / 'system'），
 * 存的是 localStorage 的 bandi.theme —— 两处入口改的是同一个值，不存在两套口径。
 */
const THEME_OPTS = [
  ['light', '浅色'],
  ['dark', '深色'],
  ['system', '跟随系统'],
];
/** 主题当前值的中文名（手机「我的」页那行显示"深色"，不显示 dark） */
const themeLabel = (v) => (THEME_OPTS.find(([k]) => k === v) ?? THEME_OPTS[2])[1];

/*
 * 机器信息行渲染（2026-11-11 收拢到模块级）：「我的」页的桌面「这台机器」卡
 * 与手机「我的 › 设置」子页的「这台机器」卡共用同一行写法，别再各抄一份。
 * 「实例标识」给等宽（.me-v-mono）—— 排查用的 id，换行难读。
 */
const machineRowHtml = ([k, v]) =>
  `<div class="me-kv"><span class="me-k">${esc(k)}</span><span class="me-v ${k === '实例标识' ? 'me-v-mono' : ''}">${esc(v)}</span></div>`;

/*
 * 手机端「这台机器」三行（2026-11-07）：系统 / 版本**分开** —— 窄屏一行放不下
 * "Linux 6.8.0-138-generic x64 · 班底 v1.5.x"，`.me-v` 是省略，硬挤会把内核号截掉。
 * 2026-11-11 起这三行搬进「我的 › 设置」子页（openMeSet），「我的」页不再画。
 */
const phoneMachineAll = (hello) =>
  hello
    ? [
        ['设备名', hello.hostname || hello.label || '—'],
        ['系统', hello.os || '未知'],
        ['版本', hello.version ? `班底 v${hello.version}` : '未知'],
      ]
    : [];

export async function openMe() {
  /*
   * 「我的 › 设置」子页自愈（2026-11-11）：openMe 是"回到个人中心"的唯一渲染口 ——
   * 换 tab / mb-nav / 子页自己的返回都会落到这里，子页的视觉态必须跟着收干净，
   * 不然画面在「我的」、body 上还挂着子页标记，Esc/返回的判断就会错拍。
   */
  meSetOpen = false;
  document.body.classList.remove('mb-me-set');
  setRoute('me');
  setPluginRerender(null);
  showView('settings');
  setListTitle('我的');
  const who = S.auth ?? null;
  const isUser = who?.kind === 'user';
  // 身份卡显示**中枢账号**（登录用的手机号）：本机名条只是实现细节（2026-11-07）
  const name = isUser ? (who?.user?.hub || who?.user?.name || '') : '未登录';
  /*
   * 昵称（2026-11-08 用户："加一个昵称，'中枢账号 · 手机号登录'这个去掉"）。
   *
   * 身份卡两行现在是：**第一行昵称、第二行手机号**。
   *   · 设了昵称 → 标题用昵称，副行给 3-4-4 分组的手机号；
   *   · 没设昵称 → 标题退回手机号（页面不至于空着），副行给一个「＋ 设置昵称」入口；
   *   · 没登录 → 标题「未登录」，副行保留原来那句说明（这句话只在这种情况才该出现）。
   * 昵称存在 users.nickname（服务端 /api/me 带出），**不是账号名** —— 改它不动署名。
   * 2026-11-09 起昵称是**全端显示名**（通讯录 / 聊天署名 / 派活选人都先看它，见 shell.mjs
   * 的 userLabel）—— 身份卡只是它的入口，不再是它的全部生效范围。
   */
  const nick = isUser ? String(who?.user?.nickname ?? '').trim() : '';
  /*
   * 手机号当名字时的两件小事（2026-11-08 重设计，用户对着截图说"这个页面重新设计一下"）：
   *   · 3-4-4 分组（152 6416 0947）—— 11 位连排没法扫读，运营商 / 银行 App 都这么排；
   *   · 头像不再取首字符 —— "1526…" 的首字符是"1"，大蓝圈里孤零零一个数字既不是名字
   *     也没有含义；换成中性的人形占位图标（iOS 联系人无头像时的同款读法）。
   * 有了昵称之后头像取昵称首字（跟"有名字的人"同款读法）。
   */
  const isPhoneName = /^1\d{10}$/.test(name);
  const phoneText = isPhoneName ? name.replace(/^(\d{3})(\d{4})(\d{4})$/, '$1 $2 $3') : name;
  const displayName = nick || phoneText;
  const avaHtml = nick
    ? `<span class="me-ava">${esc(initial(nick))}</span>`
    : isPhoneName
      ? `<span class="me-ava me-ava-glyph" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="8.2" r="3.6"/><path d="M4.8 19.4c1.5-3.3 4.1-5 7.2-5s5.7 1.7 7.2 5"/></svg></span>`
      : `<span class="me-ava">${esc(initial(name))}</span>`;
  /*
   * 「有没有登录态可退」（2026-11-01 实报：回环形态点退出登录没反应）。
   *   · 登录账号 → 有；
   *   · 操作员 via 'token'（非回环形态的面板令牌）→ 有，退出会清令牌 Cookie；
   *   · 操作员 via 'loopback' → **没有** —— 回环是免登录信任，clear Cookie 重载还是操作员，
   *     摆了按钮就是骗人；手机设备同理（它的凭据是配对令牌，退出=解绑，另有入口）。
   */
  const canLogout = isUser || (who?.kind === 'operator' && who?.via !== 'loopback');
  /*
   * 手机形态功能子集（2026-11-03 用户拍板）：**手机只要一部分功能，甚至是简化版**。
   * 「我的」页在窄屏只留两块：身份卡 + 退场行。设置入口、账号安全双卡都不画 ——
   * 不是藏起来（藏了还能被翻出来），是根本不进 DOM：密码/动态验证/主题这类是
   * PC 独有的管理动作，手机上不渲染就不存在"适配"和"泄漏"两件事。
   * 判据用 body.mb-narrow（mobile.mjs 维护的状态类，import 它会成环）——
   * 与 mobile.css 的 @media 同源同拍：窄屏 = 手机形态，桌面缩窄窗口同样成立。
   */
  const onPhone = document.body.classList.contains('mb-narrow');
  /*
   * 当前机器的信息（2026-11-07）：`/api/hello` 描述**服务着这个页面的机器** ——
   * 桌面 App / 本机浏览器里它就是"这台电脑"；手机浏览器里它是被访问的那台班底机。
   * 拉不到（旧服务 / 网络断）就整卡不画，别画一行全是"—"的空卡。
   *
   * 「系统」也用 `hello.os`（2026-11-07 用户实报）：原来取 `navigator.platform`，
   * 那是**看页面那台电脑**的平台 —— 在 Windows 上远程看 Linux 主机会显示 Win32，
   * 跟这张卡「这台机器」的名头对不上。系统只有服务端自己知道，由它报。
   * 桌面四行里系统与版本并成一行（卡宽够）；手机的三行版式见模块级 phoneMachineAll
   * （2026-11-11 起随「这台机器」卡搬进「我的 › 设置」子页，「我的」页只留桌面版）。
   */
  const hello = await api('/api/hello').catch(() => null);
  /*
   * 壳标记（2026-11-07）：
   *   · 原生壳（Kotlin，apps/mobile-native）—— WebView 启动前挂好 `window.BandiShell`
   *     （addJavascriptInterface，页面第一行起可用），直接调方法回壳；
   *   · 旧 Tauri 壳 —— initialization_script 注入 `window.__BANDI_SHELL__`（带启动页
   *     地址，导航 hash 流），保留作过渡兜底。
   * 浏览器 / PWA 两个都没有 ——「当前设备」行与退出落点只在壳里生效，桌面行为不变。
   */
  const nativeShell = typeof window.BandiShell !== 'undefined' ? window.BandiShell : null;
  const shell = nativeShell ? { native: true } : (window.__BANDI_SHELL__ ?? null);
  /*
   * 机器信息两套行（2026-11-07）：
   *   桌面 —— 四行，系统与版本并成一行（卡宽够，"Linux 6.x x64 · 班底 v1.5.x"一行读得完）；
   *   手机 —— 三行版式（模块级 phoneMachineAll）随「这台机器」卡搬进了「我的 › 设置」
   *   子页，这里不再算手机那一份。
   */
  /*
   * 外网访问（2026-11-08 接入，同日随 frp 内置下线删除）：隧道归外部管之后，
   * 服务端无从知道它通不通，继续画就是猜 —— 状态行整块退场。
   */
  const machineAll = hello
    ? [
        ['设备名', hello.hostname || hello.label || '—'],
        ['系统 / 版本', `${hello.os || '未知'}${hello.version ? ` · 班底 v${hello.version}` : ''}`],
        ['本机地址', location.host || '—'],
        ['实例标识', hello.instanceId || '—'],
      ]
    : [];
  const machineRows = machineAll.map(machineRowHtml).join('');
  /* 信箱未读数：hero 右上角那颗红点（me-inbox-dot）用；与左栏角标同源（S.noticesUnread） */
  const inboxUnread = Number(S.noticesUnread) || 0;
  /*
   * 身份卡的两枚 chip（2026-11-11 方案 B「档案卡」）：**中枢账号** + **这台机器**。
   * 它们回答的是"我是谁 / 我在哪台机器"—— 原来这两件事只靠一层全宽渐变和一行
   * 灰字暗示，收成 chip 才有"档案"的读法。设备名取 hello.label/hostname，
   * 与「当前设备」行同源；没登录 / 拉不到 hello 就不画那一枚。
   */
  const devName = hello ? hello.label || hello.hostname || '' : '';
  const heroChips = [
    isUser
      ? '<span class="me-chip ac"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3.2 19 6v5.4c0 4.2-2.8 7.4-7 9.4-4.2-2-7-5.2-7-9.4V6z"/></svg>中枢账号</span>'
      : '',
    devName ? `<span class="me-chip">${esc(devName)}</span>` : '',
  ].join('');
  $('settingsView').innerHTML = `
    ${headRow('<b>我的</b>')}
    <div class="detail-body me-body">
      <section class="set-sec me-hero-sec">
        <div class="me-hero-card${onPhone ? ' me-hc' : ''}">
          ${avaHtml}
          <div class="me-who">
            <div class="me-name">
              <b>${esc(displayName)}</b>
              ${
                /* 昵称入口（2026-11-08）：常驻小铅笔（55% 透明，不抢身份卡的戏）。
                   不做 hover 才显形 —— 手机上没有 hover，藏了就等于没有。 */
                isUser
                  ? `<button type="button" class="me-edit" id="meNickEdit" title="${nick ? '改昵称' : '设置昵称'}" aria-label="${nick ? '改昵称' : '设置昵称'}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 19.5h4l9.6-9.6a2.1 2.1 0 0 0-3-3L5.5 16.5v3z"/><path d="M13.8 7.2l3 3"/></svg></button>`
                  : ''
              }
            </div>
            ${
              /*
               * 副行（原「中枢账号 · 手机号登录」已删，2026-11-08 用户要求）：
               *   登录 + 有昵称 → 手机号（账号身份还在，只是退到第二行）；
               *   登录 + 没昵称 → 「＋ 设置昵称」，比一行灰字更说明下一步能干什么；
               *   没登录       → 保留原来那句说明。
               */
              !isUser
                ? `<span class="me-meta">这台机器还没有登录账号</span>`
                : nick
                  ? `<span class="me-meta">${esc(phoneText)}</span>`
                  : `<button type="button" class="me-meta me-nick-set" id="meNickSet">＋ 设置昵称</button>`
            }
          </div>
          ${
            /* 信箱图标（2026-11-11 用户："在信息区加一个信箱图标，点击之后跳转到
               信箱页面"）：hero 右缘的一颗图标钮 —— 身份区里放得下、不用钻清单；
             * 行为与下面「平台通知」行同一把 mb-nav（窄屏才画，桌面左栏已有信箱）。
             * 右上角未读红点（me-inbox-dot）与行尾读数同源（S.noticesUnread），
             * inbox.mjs 的 paintInboxBadge 会一并刷新 —— 0 未读时隐藏，>99 折成 99+。
               图形 = 信箱页空态那只信封（rect + 双折线），线宽 1.8 同 hero 铅笔。 */
            onPhone
              ? `<button type="button" class="me-inbox-icon" id="meInboxIcon" aria-label="信箱">
                   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                     <rect x="3" y="5.5" width="18" height="13" rx="2"/>
                     <path d="M3.6 6.6 12 13l8.4-6.4"/>
                     <path d="M3 16.5l5.4-4.2M21 16.5l-5.4-4.2"/>
                   </svg><i class="me-inbox-dot" id="meInboxDot"${inboxUnread ? '' : ' hidden'}>${inboxUnread > 99 ? '99+' : inboxUnread}</i>
                 </button>`
              : ''
          }
          ${onPhone && heroChips ? `<div class="me-chips">${heroChips}</div>` : ''}
        </div>
      </section>
      ${
        /* 当前机器（2026-11-07）：这台电脑的名字 / 系统 / 实例标识 —— 「我的」页原本
           只有账号没有机器，用户问"这台设备呢"。桌面画全四行；手机窄屏的同名三行卡
           2026-11-11 起搬进「我的 › 设置」子页（openMeSet）—— 手机上"这台机器"
           指的是**连过去的那台班底机**，跟"这台设备"（手机自己）不是一回事。 */
        !onPhone && machineRows
          ? `<section class="set-sec me-dev-sec">
               <div class="set-head"><b>这台机器</b></div>
               <div class="me-dev-box">${machineRows}</div>
             </section>`
          : ''
      }
      ${
        /* 修改密码（2026-11-10 二次安家）：桌面「我的」页的独立入口。
           最初放进下面的 me-entry-sec（与「设置」同卡），但「设置进左栏」那轮改版在
           mobile.css 里 `body:not(.mb-narrow) .me-entry-sec { display:none }` 把整卡
           在桌面藏死了 —— 用户两报「入口呢」。这里自立一张卡：类名避开 me-entry-sec，
           绕开那条隐藏规则；行用桌面原生的 .set-row + 按钮（.me-entry 系只有窄屏才有
           样式，桌面裸奔）。手机形态白名单仍不含改密码，故依旧 !onPhone。 */
        !onPhone && isUser
          ? `<section class="set-sec me-pwd-sec">
               <div class="set-box">
                 <div class="set-row">
                   <span class="set-label">登录密码</span>
                   <button type="button" id="mePassword">修改密码</button>
                 </div>
               </div>
             </section>`
          : ''
      }
      ${
        /*
         * 「我的」页的分组清单（2026-11-11 深夜第四版，用户："这个页面可以参考微信
         * 我的页面的布局"）。
         *
         * 微信那边不是"卡"，是**分组块**：一块满宽、无圆角、无描边、无投影的白，
         * 与上一块之间隔 10px 页底灰；块内行与行之间一条内缩 20 的 hairline。
         * 三行完全同构 —— 左边名称 17，右边值 15.5 灰 + ›。
         *
         * 主题行因此从"行内分段选项卡"（2026-11-05 的形态）改成"值 + 箭头"：
         * 分段铺在行里是三个里唯一一个"控件"，跟微信的读法不是一套；点整行弹底部
         * 选择（复用 #ctxMenu 的手机 sheet 形态），与 iOS「设置 › 显示与亮度」同一个
         * 交互 —— 值在行上永远看得见，改一次也只多一次点击。
         *
         * 「当前设备」行条件沿用上一版：只在壳里 + 中枢账号会话画 —— 面板和启动页是
         * 两个 origin，"设备列表"只存在于壳的启动页上；桥 = 导航回启动页带
         * #bandi-devices（原生壳直接调 BandiShell）。
         * 桌面不画这一块：桌面左栏有「设置」，主题在 设置 › 偏好，重复入口没有意义。
         */
        onPhone
          ? `<section class="set-sec me-one-sec">
               <div class="me-one-box" id="meOneBox">
                 <button type="button" class="me-kv me-cache-row" id="meThemeRow">
                   <span class="me-k">主题</span>
                   <span class="me-v" id="meThemeVal">${esc(themeLabel(S.theme))}</span>
                   <i class="me-chevron" aria-hidden="true">›</i>
                 </button>
                 ${
                   shell && hello && isUser
                     ? `<button type="button" class="me-kv me-cache-row" id="meSwitchDevice">
                          <span class="me-k">当前设备</span>
                          <span class="me-v">${esc(devName || '—')}</span>
                          <i class="me-chevron" aria-hidden="true">›</i>
                        </button>`
                     : ''
                 }
                 <button type="button" class="me-kv me-cache-row" id="meSetEntry">
                   <span class="me-k">设置</span>
                   <span class="me-v">机器 · 缓存 · 退出</span>
                   <i class="me-chevron" aria-hidden="true">›</i>
                 </button>
               </div>
             </section>`
          : ''
      }
      <!-- 「设置」入口（2026-11-01）：只在窄屏显示（桌面左栏已经有设置，再摆一个是重复）。
           走事件而不是 import setNav —— settings ← state 是反向依赖，会成环
           （mobile.mjs 里通讯录那个 mb-cv-home 同一套办法）。
           ⚠️ 2026-11-03 反转：手机功能收成白名单子集后，设置页整个是 PC 独有的 ——
           窄屏**不画**这个入口（画了就是把整页设置重新暴露给手机）。 -->
      ${
        onPhone
          ? ''
          : `<section class="set-sec me-entry-sec">
        <div class="set-box">
          <div class="set-row me-entry" id="meSettings" role="button" tabindex="0">
            <span class="me-entry-ico">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.1"/><path d="M19.4 14.5a1.6 1.6 0 0 0 .32 1.77l.06.06a1.94 1.94 0 1 1-2.75 2.75l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-.97 1.47V20a1.94 1.94 0 1 1-3.88 0v-.1a1.6 1.6 0 0 0-1.05-1.47 1.6 1.6 0 0 0-1.77.32l-.06.06a1.94 1.94 0 1 1-2.75-2.75l.06-.06a1.6 1.6 0 0 0 .32-1.77 1.6 1.6 0 0 0-1.47-.97H4a1.94 1.94 0 1 1 0-3.88h.1a1.6 1.6 0 0 0 1.47-1.05 1.6 1.6 0 0 0-.32-1.77l-.06-.06a1.94 1.94 0 1 1 2.75-2.75l.06.06a1.6 1.6 0 0 0 1.77.32h.08A1.6 1.6 0 0 0 11.9 4.1V4a1.94 1.94 0 1 1 3.88 0v.1a1.6 1.6 0 0 0 .97 1.47 1.6 1.6 0 0 0 1.77-.32l.06-.06a1.94 1.94 0 1 1 2.75 2.75l-.06.06a1.6 1.6 0 0 0-.32 1.77v.08a1.6 1.6 0 0 0 1.47.97H20a1.94 1.94 0 1 1 0 3.88h-.1a1.6 1.6 0 0 0-1.47.97z"/></svg>
            </span>
            <span class="set-label">设置</span>
            <span class="me-chevron" aria-hidden="true">›</span>
          </div>
        </div>
      </section>`
      }
      ${
        /* 退场动作整宽一行：个人中心的"走人"动作用整行 + 文字染色，比右下角一颗
           小按钮稳。退出登录染 --bad（"走人"的分量）；断开连接/去登录是中性动作，不染。
           （2026-11-07：账号安全双卡随本地密码/OTP 退场 —— 密码与动态验证都在中枢上管。）
           2026-11-11 用户："退出按钮放到设置页面" —— 手机上这一行搬进「我的 › 设置」
           子页底部（openMeSet 同款模板），「我的」页只留身份/外观/设备/设置入口；
           桌面不动（桌面没有子页，这行仍是「我的」页的收尾）。 */
        onPhone
          ? ''
          : `<section class="set-sec me-out-sec">
           <div class="me-out-box">${
             canLogout
               ? '<button class="me-out me-out-danger" id="meLogout">退出登录</button>'
               : '<button class="me-out" id="meGoLogin">去登录</button>'
           }</div>
         </section>`
      }
      ${/* 版本行收口（2026-11-11 方案 B）：两张卡之后页面原来剩一段空白，看着像"没画完"。
           一行 11.5px 的版本号把它收住 —— 空白变成呼吸，也顺手回答了"我这是哪一版"。
           只在手机形态画；桌面那张「这台机器」卡里已经有版本行。 */ ''}
      ${onPhone && hello?.version ? `<div class="me-foot">班底 v${esc(hello.version)}</div>` : ''}
    </div>`;
  /*
   * 主题（2026-11-11 第四版）：这一行改成「值 + 箭头」，点整行弹底部选择 ——
   * 手机形态下 #ctxMenu 本来就是贴底 sheet（mobile.css §16.12），跟长按会话那个
   * 菜单是同一套语言，用户不用学第二遍；选中项前面点一个 ✓，当前值在行上其实也
   * 一直看得见。
   * setTheme 仍带 keepPage：手机上「设置 › 偏好」那一页根本不存在，不 keepPage
   * 会被踢出「我的」再弹回来（2026-11-05 踩过）。
   */
  const themeRow = $('meThemeRow');
  if (themeRow) {
    themeRow.onclick = () => {
      const r = themeRow.getBoundingClientRect();
      openCtxMenu(
        r.left,
        r.bottom + 6,
        THEME_OPTS.map(([v, label]) => ({
          /* 只有当前项带 ✓（三项都带前缀符号时，居中排版会被那个符号推歪半格，
             看着像每行都"少了一点"）；选中即生效，不需要"确定" */
          label: `${S.theme === v ? '✓ ' : ''}${label}`,
          run: () => {
            setTheme(v, { keepPage: true });
            const val = $('meThemeVal');
            if (val) val.textContent = label;
          },
        })),
      );
    };
  }
  $('meLogout')?.addEventListener('click', () => void logout());
  /*
   * 昵称保存（2026-11-08）：走账号接口既有的 PATCH /api/users/:id，只改 users.nickname。
   * 弹窗用全站统一的那个（askText ← askDialog），不用原生 prompt（浏览器画的框跟班底不是
   * 一个东西）。留空 = 清除，界面退回手机号；保存完就地重画这一页（S.auth 里的值先更新）。
   * 2026-11-09 昵称全端生效：名册（S.users）里自己那条也同步改 —— 派活选人立等可见，
   * 不等下一次 /api/state；通讯录不摆自己，不用管。
   */
  const editNick = async () => {
    if (!isUser) return;
    const v = await askText({
      title: '设置昵称',
      body: '昵称是全端的显示名：通讯录、聊天署名、派活选人都会用它。账号名和署名匹配不受影响。留空 = 清除。',
      value: nick,
      placeholder: '最多 20 个字',
      ok: '保存',
    });
    if (v === null) return; // 取消
    const t = String(v).replace(/\s+/g, ' ').trim();
    if ([...t].length > 20) { toast('昵称最多 20 个字', 'error'); return; }
    try {
      const d = await api(`/api/users/${encodeURIComponent(who.user.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname: t }),
      });
      /*
       * 旧服务端的兜底：它不认识 nickname，会「200 + 原样回 user」—— 不判这一下就会
       * 弹"已保存"却什么都没发生（前端先换了、服务端还没重启的那一小段窗口）。
       * 用 `in` 判而不是判 null：null 是"已清空"的合法值。
       */
      const u = d?.user ?? {};
      if (!('nickname' in u)) { toast('服务端还是旧版本：重启班底后再改昵称', 'error'); return; }
      if (S.auth?.user) S.auth.user.nickname = u.nickname ?? null;
      const mine = (S.users ?? []).find((x) => x.id === u.id);
      if (mine) mine.nickname = u.nickname ?? null;
      toast(t ? '昵称已保存' : '昵称已清除');
      await openMe();
    } catch (e) { toast(e.message, 'error'); }
  };
  $('meNickEdit')?.addEventListener('click', () => void editNick());
  $('meNickSet')?.addEventListener('click', () => void editNick());
  /*
   * 信箱入口（2026-11-11 手机端）：hero 右上角那颗信封图标。走 mb-nav 事件让
   * mobile.mjs 统一 setNav —— 跟下面设置入口（goSet）同一条解环路子，
   * settings 不直接 import state.mjs。（原「平台通知」行入口已删 —— 图标足够，
   * 2026-11-11 用户："这个去掉"。）
   */
  $('meInboxIcon')?.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('mb-nav', { detail: { nav: 'inbox' } }));
  });
  /*
   * 当前设备 → 回壳的设备列表（2026-11-07，2026-11-11 挪回「我的」页）：
   * 只在壳里渲染（见上面 shell）。原生壳直接调 BandiShell.openDeviceList()；
   * 旧 Tauri 壳走启动页意图 hash。
   */
  $('meSwitchDevice')?.addEventListener('click', () => {
    if (nativeShell) { nativeShell.openDeviceList(); return; }
    if (shell?.home) location.href = shell.home + '#bandi-devices';
  });
  /*
   * 「设置」入口（2026-11-11）：打开「我的 › 设置」子页（openMeSet）。
   * 子页不开新的一级栏（S.nav 仍是 'me'，底部 tab 亮「我的」，与信箱同理），
   * 所以不走 mb-nav，直接在本模块内换内容 —— hello 带过去，子页的
   * 「这台机器」三行要用。
   */
  $('meSetEntry')?.addEventListener('click', () => void openMeSet({ hello, canLogout }));
  /*
   * 兜底：正常进不到这个分支（面板门前移到登录页，见 auth.mjs 的 wantsPanelHtml），
   * 万一从令牌通道挤进来，至少给一条出路 —— 别再摆一段讲实现细节的说明。
   */
  $('meGoLogin')?.addEventListener('click', () => location.reload());
  // 修改密码（2026-11-10）：只发起，表单与提交在 openPasswordDialog（模块级，见文件尾）
  const goPwd = () => void openPasswordDialog();
  $('mePassword')?.addEventListener('click', goPwd);
  $('mePassword')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      goPwd();
    }
  });
  // 设置入口：交给 mobile.mjs 转一次 setNav（反向 import 会成环，见上面的注释）
  const goSet = () => document.dispatchEvent(new CustomEvent('mb-nav', { detail: { nav: 'settings' } }));
  $('meSettings')?.addEventListener('click', goSet);
  $('meSettings')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      goSet();
    }
  });
}

/* ---------------------------------------------------------------- 我的 › 设置 */

/*
 * 「我的 › 设置」子页（2026-11-11 用户："做一个设置菜单，把这两个放到设置页面去"）：
 * 「我的」页上的「这台机器」「通用」两张卡整体搬进这一页，「我的」只留一行入口。
 * （「当前设备」行同日晚些时候又挪回「我的」页 —— 切设备是高频动作，用户拍板。）
 *
 * 为什么不开 setNav 的新一级栏：设置页整页是 PC 独有的（2026-11-03 白名单拍板），
 * 手机不该被整页设置重新暴露；这一页是「我的」的下一级，S.nav 仍是 'me'，
 * 底部 tab 亮「我的」（与信箱入口同理）。hello 由入口行带进来 ——
 * 「这台机器」三行要用它，子页自己不再拉一遍接口。
 *
 * 历史栈照"详情压一格"的老规矩（与 kb-new / sch-page 同款：自己收自己那一格）：
 *   · 进来 pushState({mbMeSet:1}) 一格 —— 手势/返回键退这一格回「我的」；
 *   · 行按钮 / Esc 也走同一把 closeMeSet：按钮路径自己退格（alreadyPopped=false），
 *     手势路径历史已退（alreadyPopped=true）只收画面；
 *   · mobile.mjs 对 body.mb-me-set 放行（Esc 派 mb-me-set-leave、popstate 不抢），
 *     渲染模块不反向 import 本文件 —— 走事件，本站既有的解环手法。
 */
let meSetOpen = false;    // 子页视觉态开关（唯一判据；历史格标记只做清理，不判它）
let meSetPopping = false; // 自己 history.back() 触发的 popstate，别当手势再收一次画面

function openMeSet({ hello, canLogout }) {
  meSetOpen = true;
  document.body.classList.add('mb-me-set');
  const phoneRows = phoneMachineAll(hello).map(machineRowHtml).join('');
  $('settingsView').innerHTML = `
    ${
      /* 导航栏（2026-11-11 用户："设置页加一个导航栏。返回按钮放到导航栏左侧，
         使用图标按钮"）：替代旧版那张「‹ 返回」卡。规格照整页头（body.no-list
         .detail-head，mobile.css §3）：--mb-nav 高 + 玻璃底 + 0.5px hairline，
         sticky 吸顶；返回 = 左侧纯图标钮（.mb-back 同款 accent chevron），
         标题「设置」居中（17/600）—— 三列 grid 让图标钮不挤偏标题。 */
      `<header class="me-set-nav">
         <button type="button" class="me-set-back" id="meSetBack" aria-label="返回">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>
         </button>
         <span class="me-set-title">设置</span>
         <span aria-hidden="true"></span>
       </header>`
    }
    <div class="detail-body me-body">
      ${
        /* 「这台机器」（2026-11-07 手机端起的卡）：设备名 / 系统 / 版本 —— 手机上
           "这台机器"指**被连接的那台班底机**（当前这个页面就是它服务的）。
           本机地址与「已配对到」重复、实例标识是排查才用的，窄屏不画。 */
        phoneRows
          ? `<section class="set-sec me-dev-sec">
               <div class="set-head"><b>这台机器</b></div>
               <div class="me-dev-box">${phoneRows}</div>
             </section>`
          : ''
      }
      <section class="set-sec me-cache-sec">
        <div class="set-head"><b>通用</b></div>
        <div class="me-dev-box">
          <button type="button" class="me-kv me-cache-row" id="meClearCache">
            <span class="me-k">清除缓存</span>
            <span class="me-v" id="meCacheHint">计算中…</span>
            <i class="me-chevron" aria-hidden="true">›</i>
          </button>
        </div>
      </section>
      ${
        /* 退场行（2026-11-11 用户："退出按钮放到设置页面"）：与「我的」页桌面版
           同一套 DOM（.me-out-box + .me-out），从主页搬进来 —— 手机上"走人"是
           低频且不可逆的动作，收到设置最底下，别摆在每次都会看的地方。
           canLogout 由入口带进来（回环操作员没有可退的登录态，画「去登录」）。 */
        `<section class="set-sec me-out-sec">
           <div class="me-out-box">${
             canLogout
               ? '<button class="me-out me-out-danger" id="meLogout">退出登录</button>'
               : '<button class="me-out" id="meGoLogin">去登录</button>'
           }</div>
         </section>`
      }
    </div>`;
  /* 历史格：当前格已带标记（reload 直落的场景）就复用，不重压 —— 多压一格，
     返回就得多按一次空的（详情页那条同款教训）。 */
  if (!history.state?.mbMeSet) history.pushState({ mbMeSet: 1 }, '');
  $('meSetBack')?.addEventListener('click', () => void closeMeSet(false));
  $('meLogout')?.addEventListener('click', () => void logout());
  $('meGoLogin')?.addEventListener('click', () => location.reload());
  wireCacheRow();
}

/** 收子页回「我的」：alreadyPopped = 手势/返回键的 popstate 已经替我们退过格 */
async function closeMeSet(alreadyPopped) {
  if (!meSetOpen) return;
  meSetOpen = false;
  document.body.classList.remove('mb-me-set');
  if (!alreadyPopped && history.state?.mbMeSet) {
    meSetPopping = true;
    history.back();
  }
  await openMe();
}

/* 手势 / 浏览器返回：只收画面，不再退格（那格历史系统已经退了）。
   ⚠️ 要同时看类标记：tab / mb-nav 换栏时 mobile.mjs 已把类摘掉、自己退了格 ——
   那条路的 popstate 不该再被当成"手势退子页"把画面拽回「我的」（2026-11-11）。 */
window.addEventListener('popstate', () => {
  if (meSetPopping) { meSetPopping = false; return; }
  if (meSetOpen && document.body.classList.contains('mb-me-set')) void closeMeSet(true);
});
/* Esc：mobile.mjs 的 keydown 对 mb-me-set 放行时派这个事件（弹窗开着时不派） */
document.addEventListener('mb-me-set-leave', () => void closeMeSet(false));

/* 返回键的层级（navstack.mjs，2026-11-11）：「设置」子页在「我的」之上，收它回「我的」。 */
registerLayer({
  name: 'me-set',
  level: 50,
  cell: 'mbMeSet',
  active: () => document.body.classList.contains('mb-me-set'),
  close: () => void closeMeSet(true),
});

/*
 * 清除缓存行（2026-11-06，原在 openMe，随「通用」卡搬进子页）：
 * 进页先异步算一遍 bandi-static-* 缓存体积亮在行尾；
 * 点击 → confirmDo → 清掉全部 Cache Storage + 注销 Service Worker → location.reload()。
 * 注销而不是只删缓存：SW 注销后这次重载直连网络，index.html 会重新注册出
 * 一个"只装新文件"的 SW —— 相当于把"杀 App 重开"压进一个按钮里。
 * 任何一步失败都不拦重载（清不掉就硬刷，网络优先的 SW 本来也会拿新文件）。
 */
function wireCacheRow() {
  const cacheRow = $('meClearCache');
  if (!cacheRow) return;
  const hint = $('meCacheHint');
  const fmtBytes = (n) =>
    n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.ceil(n / 1024))} KB`;
  const hasCaches = 'caches' in window;
  (async () => {
    /*
     * 没有 caches = 非安全上下文（手机走 http://192.168.5.x 明文 HTTP，Cache Storage /
     * Service Worker 这对安全上下文专属 API 浏览器不给）。没有 SW 就没有 SW 缓存，
     * 页面资源每次都从服务器现拉 —— 无东西可清，行尾说"无需清除"，下面也不绑点击
     * （2026-11-06 用户看到"不支持"问为什么：那话听着像坏了，其实是"没有缓存"）。
     */
    if (!hasCaches) { hint.textContent = '无需清除'; return; }
    let bytes = 0;
    for (const key of await caches.keys()) {
      const store = await caches.open(key);
      for (const req of await store.keys()) {
        const res = await store.match(req);
        if (res) bytes += (await res.blob()).size;
      }
    }
    hint.textContent = bytes ? fmtBytes(bytes) : '无缓存';
  })().catch(() => { hint.textContent = ''; });
  if (!hasCaches) return;   // 没有可清的东西，这行不是按钮 —— 点了只会空转重载
  cacheRow.addEventListener('click', async () => {
    const ok = await confirmDo(
      '清掉手机上缓存的页面资源，然后重新拉最新版。登录状态和数据不受影响。',
      { ok: '清除并刷新', danger: false },
    );
    if (!ok) return;
    try {
      if ('caches' in window) {
        for (const key of await caches.keys()) await caches.delete(key);
      }
      if (navigator.serviceWorker?.getRegistrations) {
        for (const reg of await navigator.serviceWorker.getRegistrations()) await reg.unregister();
      }
    } catch { /* 清不掉就直接刷 */ }
    location.reload();
  });
}

/* ---------------------------------------------------------------- 设置 */
/**
 * 修改密码（2026-11-10）：「我的 › 修改密码」的表单弹窗。
 *
 * 密码存在**中枢**上（本机不存，见 hub/config.mjs 那段），这里只把三栏输入交给
 * 本机 `POST /api/me/password`，由它转发中枢 `/v1/auth/password`（设备凭据代账号办事）。
 * 成功后只 toast + 关弹窗：本机会话 / 其它已登录设备都不受影响，下次登录用新密码。
 *
 * 弹窗形态照 GitHub 连接那个（`gr-conn-dlg` + wireDialogHead，动态建、关即删）；
 * ⚠️ form **不设** `method='dialog'`（那是 git 弹窗的写法，submit 直接关窗）——
 * 这里回车要走「提交」，由 submit 监听器自己 preventDefault。
 */
function openPasswordDialog() {
  const dlg = document.createElement('dialog');
  dlg.className = 'gr-conn-dlg pw-dlg'; // pw-dlg：标签列钉宽，三栏输入框对齐（style.css 同名规则）
  const form = document.createElement('form');
  form.innerHTML = `
    <b>修改密码</b>
    <div class="gr-dlg-body">
      <div class="gr-dlg-row">
        <span class="row-label">当前密码</span>
        <input id="pwOld" type="password" autocomplete="current-password" />
      </div>
      <div class="gr-dlg-row">
        <span class="row-label">新密码</span>
        <input id="pwNew" type="password" placeholder="至少 8 位" autocomplete="new-password" />
      </div>
      <div class="gr-dlg-row">
        <span class="row-label">确认新密码</span>
        <input id="pwNew2" type="password" autocomplete="new-password" />
      </div>
      <div class="gr-dlg-help">密码存在中枢账号上：改完之后，所有设备下次登录都用新密码；已经登录的设备不受影响。</div>
      <div class="gr-conn-actions">
        <span class="gr-dlg-status" id="pwMsg"></span>
        <button type="submit" class="primary" id="pwSave">确认修改</button>
      </div>
    </div>`;
  dlg.append(form);
  document.body.append(dlg);
  wireDialogHead(form); // 动态建的弹窗自己包一次吸顶头（标题 + ×）
  dlg.addEventListener('close', () => dlg.remove());

  const say = (text, bad = true) => {
    const el = form.querySelector('#pwMsg');
    el.textContent = text;
    el.style.color = bad ? 'var(--bad)' : 'var(--ok)';
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const oldPassword = form.querySelector('#pwOld').value;
    const newPassword = form.querySelector('#pwNew').value;
    if (!oldPassword) return say('先填当前密码');
    if (newPassword.length < 8) return say('新密码至少 8 位');
    if (newPassword.length > 128) return say('新密码最多 128 位');
    if (newPassword !== form.querySelector('#pwNew2').value) return say('两次输入的新密码不一样');
    const btn = form.querySelector('#pwSave');
    btn.disabled = true;
    btn.textContent = '提交中…';
    try {
      await api('/api/me/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPassword, newPassword }),
      });
      toast('密码已修改，下次登录用新密码');
      dlg.close();
    } catch (err) {
      say(err?.message ?? '改密码没成功');
      btn.disabled = false;
      btn.textContent = '确认修改';
    }
  });

  dlg.showModal();
  setTimeout(() => form.querySelector('#pwOld').focus(), 30);
}

/* ---------------------------------------------------------------- 设置 */

/**
 * 设置左栏那一列分节：**分组版**（2026-10-29 用户定稿："设置页各项乱糟糟的" → 分区）。
 * 十个分节收成五组，顺序 = 左栏顺序；组头在左栏画成灰字分段标题（contacts.mjs 渲染），
 * 每组两件事，扫一眼就知道"哪类东西在哪儿"，不用在一列平铺里从头找到尾。
 *
 * 左栏顶上**只写模块名「设置」**，当前是哪个分节写在**右边**的页头里 ——
 * 跟消息/通讯录同一个主从布局（左列是导航，右面是当前页）。
 */
export const SETTINGS_GROUPS = [
  {
    title: '通用',
    /* 组头小图标（2026-11-02 用户："加上看看"）：只给组头、单色 currentColor（跟随组头灰）、
       14 viewBox 线性 path —— 条目不加，避免 emoji 墙；组是不可点的分隔标签，图标保持安静。 */
    icon: '<circle cx="5" cy="3.5" r="1.6"/><path d="M2 3.5h1.4M6.6 3.5H12M2 10.5h5.9M11.1 10.5H12"/><circle cx="9.5" cy="10.5" r="1.6"/>',
    items: [
      ['prefs', '偏好设置', '主题与外观'],
    ],
  },
  {
    /* 「这台机器」（2026-10-21 用户拍板：与「运行时」合并成一页）——
       2026-11-01 六改：模式卡搬到「手机连接」页（切档不用跨页），这页只剩设备 + 数据管理。
       2026-11-01 八改：模式 = **角色（总机/分机）+ 对外服务**两个维度，分机也对外（手机照连）。 */
    title: '本机与设备',
    icon: '<rect x="2" y="2.5" width="10" height="7" rx="1.5"/><path d="M5.5 12h3M7 9.5V12"/>',
    items: [
      ['runtimes', '这台机器', '运行时 · 数据管理'],
      /* 「协作中心」2026-11-07 随协作子系统整体退场（单兵作战，不再有分公司协作）。 */
    ],
  },
  {
    /* 额度与生图都是"管模型"的事：额度管花销，生图管一条图片通道 —— 放一组。 */
    title: '模型与 AI',
    icon: '<rect x="2" y="2" width="4.2" height="4.2" rx="1"/><rect x="7.8" y="2" width="4.2" height="4.2" rx="1"/><rect x="2" y="7.8" width="4.2" height="4.2" rx="1"/><rect x="7.8" y="7.8" width="4.2" height="4.2" rx="1"/>',
    items: [
      ['quota', '额度', '每个模型每天最多用多少'],
      ['aiimage', '生图服务', '数字员工生成图片的通道'],
    ],
  },
  {
    title: '扩展',
    icon: '<path d="M7 1.8l1.3 3.9L12.2 7 8.3 8.3 7 12.2 5.7 8.3 1.8 7l3.9-1.3z"/>',
    items: [
      ['plugins', '插件', '扩展点'],
      ['skills', '技能', '给数字员工用的能力包'],
    ],
  },
  {
    /* 「账号」（2026-11-07）：中枢账号授权名册 + 会话/审计。 */
    title: '账号',
    icon: '<path d="M7 1.5l4.8 1.9v3.4c0 3-2 4.7-4.8 5.7C4.2 11.5 2.2 9.8 2.2 6.8V3.4z"/>',
    items: [
      /* 「安全」：我的会话 + 审计日志。会话列表是"自己的"那半页（服务端只认会话里的 userId）。 */
      ['security', '安全', '会话与审计'],
    ],
  },
  {
    /* 「关于」拆出「通用」、钉到整列最后（2026-11-04 用户："关于放到最后，加个图标"）——
       版本说明是最低频的入口，不占第一屏。title:null 不画组头，这一行直接落在
       组头的缩进层；行上带一枚 info 小图标（条目级图标的唯一一处，见 contacts.mjs itemIco）。 */
    title: null,
    items: [
      ['about', '关于', '版本与说明', '<circle cx="7" cy="7" r="5.4"/><path d="M7 6.4v2.8"/><path d="M7 4.1v.01"/>'],
    ],
  },
];

/*
 * 「代码托管」「远程连接」**不再列在设置左栏**（2026-10-26 用户："设置里的代码托管和远程连接入口去掉"），
 * 入口统一在「工作台 → 研发」区（见 experts.mjs 的 DEV_TILES）。
 * ⚠️ 同日二改：它们**连渲染也搬走了**（各自成了工作台的整页，`openRemotePage` /
 *    `openCodeRepoPage`），这里只是"不再列出"—— 老位置 `openSettings('code' / 'remote')`
 *    在函数开头一律转发，别在这儿再加渲染分支（会画出第二个宿主）。
 *
 * 已搬走、不再出现在这里的：数据管理（2026-10-29 起 = 「这台机器」页底部的一个区，machine.mjs
 * renderBackupSection）、飞书（2026-10-29 起 = 员工详情 › 配置 tab › 「飞书」子页，chat.mjs
 * mountFeishuPanel）。`openSettings` 里留着对应 section 的旧路由转发，别删。

/**
 * 当前身份能看到的设置分节（**平铺**）：openSettings 的兜底判断用这一份。
 * 登录即全权（2026-11-07），只有这一份清单 —— 手机设备那套受限子集随设备令牌退场。
 */
export function settingsSections() {
  return SETTINGS_GROUPS.flatMap((g) => g.items);
}

/**
 * 左栏分组渲染用：`[{title, items}]`。
 * 组内顺序即左栏顺序，`settingsSections()` 就是把它拍平的，两份永远同源。
 */
export function settingsGroups() {
  return SETTINGS_GROUPS;
}



export function openSettings(section) {
  /* 旧路由兼容：合并前「这台机器」是独立分节 'machine'（保存的位置可能还指着它） */
  if (section === 'machine') section = 'runtimes';
  /* 旧路由兼容：「数据管理」2026-10-29 起是「这台机器」页底部的一个区，不再是分节 */
  if (section === 'backup') section = 'runtimes';
  /*
   * 「代码托管」「远程连接」已经搬成**工作台研发区的独立整页**（2026-10-26 二改）：
   * 它们不再是设置的分节，直接转发过去。
   * 这里必须**在切设置页之前**拦：老位置（历史深链接、刷新恢复存下的 section、
   * 别处残留的 openSettings('remote')）先画一遍设置页再跳，会闪一下、且左栏乱。
   */
  if (section === 'code') return openCodeRepoPage();
  if (section === 'remote') return openRemotePage();
  /*
   * 分节收敛（2026-10-28）：深链接、刷新恢复存下的 `S.settingsSection`、或别处残留的
   * openSettings('skills') 都可能指到**当前身份碰不到**的分节。设备形态不收敛的话，
   * 会画出一个每行都 403 的设置页 —— 所以按 `settingsSections()` 兜到第一个可用分节。
   */
  const allowed = settingsSections();
  const want = section || S.settingsSection || 'prefs';
  section = allowed.some(([k]) => k === want) ? want : allowed[0][0];
  setRoute('settings', { section });
  S.settingsSection = section;
  setPluginRerender(null);   // 换分节 = 换宿主：面板表单提交后的重画别再指回上一页
  showView('settings');
  /* 左栏顶上只写「设置」：这一列本身就是设置的分节列表，当前分节是右边的页面标题。
     2026-10-19 用户截图：「这个二级标题应该放在右边」—— 之前写成「设置 › 偏好设置」，
     等于把右边页面的标题挂在左边的列表头上，切换分节时左栏标题跟着跳，列表反而不像导航了。 */
  setListTitle('设置');
  renderList();
  if (S.settingsSection === 'runtimes') return renderRuntimes();
  if (S.settingsSection === 'plugins') return renderPlugins();
  if (S.settingsSection === 'quota') return renderQuota();
  if (S.settingsSection === 'skills') return renderSkillCards();
  if (S.settingsSection === 'security') return renderSecurity();
  if (S.settingsSection === 'aiimage') return renderImageAi();
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
      <div id="styleSecHost"></div>
    </div>`;

  $('themeSeg').querySelectorAll('[data-theme-opt]').forEach((el) => {
    el.onclick = () => setTheme(el.dataset.themeOpt);
  });
  loadReplyStyle().catch(() => {}); // 偏好里唯一要问服务端的一项（存在 config.json，跟设备走）
}

/*
 * 回复风格（2026-10-24 用户设计）：**雇主的沟通偏好**，一处设置、全体数字员工生效 ——
 * 跟上面那个「仅本设备」的主题是两码事，所以单独一节、标清"全体数字员工"。
 * 「言简意赅」= 派活时全员注入 my-adhd-caveman 技能（每轮都带，切换立即生效）。
 */
async function loadReplyStyle() {
  const host = $('styleSecHost');
  if (!host) return;
  let data = null;
  try {
    data = await api('/api/prefs');
  } catch (e) {
    host.innerHTML = `<section class="set-sec"><div class="set-head"><b>对话</b><span class="set-tag">全体数字员工</span></div>
      <div class="set-box"><div class="empty">${failHtml(e)}</div></div></section>`;
    return;
  }
  const styles = Array.isArray(data?.styles) && data.styles.length ? data.styles : [{ id: 'default', label: '默认' }];
  const cur = data?.replyStyle ?? 'default';
  host.innerHTML = `
    <section class="set-sec">
      <div class="set-head"><b>对话</b><span class="set-tag">全体数字员工</span></div>
      <div class="set-box">
        <div class="set-row">
          <span class="set-label">回复风格</span>
          <div class="seg" id="styleSeg">
            ${styles.map((s) => `<button data-style-opt="${esc(s.id)}" class="${s.id === cur ? 'on' : ''}">${esc(s.label)}</button>`).join('')}
          </div>
        </div>
        <div class="set-row">
          <p class="hint">「言简意赅」：动作先行、最多五步、一次只问一件事 —— 只管对话里的汇报，文档/稿子/结论表这些交付物不受影响。切换后下一轮对话就生效。</p>
        </div>
      </div>
    </section>`;
  $('styleSeg')?.querySelectorAll('[data-style-opt]').forEach((el) => {
    el.onclick = async () => {
      const id = el.dataset.styleOpt;
      try {
        await api('/api/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ replyStyle: id }) });
        $('styleSeg').querySelectorAll('[data-style-opt]').forEach((b) => b.classList.toggle('on', b.dataset.styleOpt === id));
        toast('已对全体数字员工生效');
      } catch (err) {
        toast(err.message, 'error');
      }
    };
  });
}



/* ---------------------------------------------------------------- 生图服务 */

/**
 * 生图服务（2026-10-23）：数字员工生成图片的通道，技能「班底 · 头像生成手册」教员工 curl 它。
 *
 * 形态沿用代码托管的「居中紧凑簇」（.gr-conn）：标签 | 输入框(≤520px) | 按钮位，
 * 状态行压在输入框正下方 —— 这里是三行（地址 / Key / 模型），所以加了 .stack 修饰类拉开行距。
 * Key 的口径与 GitHub 令牌一致：保存后只回显掩码，点「修改」才解锁重填；
 * 保存时 Key 留空 = 保留原值（服务端 writeConfig 的语义），改个模型名不用重贴 Key。
 */
export async function renderImageAi() {
  S.settingsSection = 'aiimage';
  const view = $('settingsView');
  view.innerHTML = rtLoading('生图服务');
  let cfg = null;
  try {
    cfg = await api('/api/ai/image-config');
  } catch (e) {
    view.innerHTML = `${headRow('<b>生图服务</b>')}<div class="empty">${failHtml(e)}</div>`;
    return;
  }
  const configured = !!cfg?.configured;

  view.innerHTML = `
    ${headRow('<b>生图服务</b>')}
    <div class="detail-body">
      <section class="set-sec">
        <div class="set-head"><b>生图通道</b><span class="set-tag">OpenAI 兼容 images API</span></div>
        <div class="set-box">
          <div class="gr-conn stack">
            <div class="gr-conn-row">
              <span class="row-label">接口地址</span>
              <input id="aiBase" value="${esc(cfg?.baseUrl ?? '')}" autocomplete="off" spellcheck="false"
                     placeholder="https://api.example.com/v1（填到 /v1 这级）" />
              <span></span>
            </div>
            <div class="gr-conn-row">
              <span class="row-label">API Key</span>
              ${
                configured
                  ? `<input id="aiKey" class="locked" type="password" value="${esc(cfg?.keyHint ?? '')}" readonly data-locked="1"
                          aria-label="已保存的 Key，只显示掩码" autocomplete="off" />
                     <button id="aiKeyEdit">修改</button>`
                  : `<input id="aiKey" type="password" placeholder="粘贴 API Key（保存后只显示掩码）" autocomplete="off" />
                     <span></span>`
              }
            </div>
            <div class="gr-conn-row">
              <span class="row-label">模型</span>
              <input id="aiModel" value="${esc(cfg?.model ?? '')}" autocomplete="off" spellcheck="false"
                     placeholder="如 Kwai-Kolors/Kolors" />
              <span></span>
            </div>
            <div class="gr-conn-actions">
              <button class="primary" id="aiSave">保存配置</button>
              <button id="aiTest">测试连接</button>
            </div>
            <div class="gr-conn-status" id="aiStatus">${
              configured
                ? `<b style="color:var(--ok)">已配置</b> —— 数字员工可生成图片，点「测试连接」验证`
                : '未配置 —— 数字员工生成图片会失败（技能会提示用户来填）'
            }</div>
          </div>
          <p class="set-hint">填任意 OpenAI 兼容的生图服务（SiliconFlow / 火山方舟 / 混元 / 自建中转）。
          Key 存在本机数据目录，不上传、不进日志；数字员工通过技能「班底 · 头像生成手册」调用它生成头像等图片。</p>
        </div>
      </section>
    </div>`;

  const status = (html) => { $('aiStatus').innerHTML = html; };
  const keyInput = () => $('aiKey');

  /* 「修改」解锁 Key 框：清掉掩码变可编辑，语义是"这次保存会覆盖旧 Key"；
     解锁后按钮变「取消」，点它退回掩码锁定态（飞书 Secret 同款） */
  const aiKeyHint = cfg?.keyHint ?? '';
  $('aiKeyEdit')?.addEventListener('click', () => {
    const k = keyInput();
    if (!k.dataset.locked) {
      k.readOnly = true;
      k.classList.add('locked');
      k.dataset.locked = '1';
      k.value = aiKeyHint;
      k.placeholder = '';
      $('aiKeyEdit').textContent = '修改';
      return;
    }
    k.readOnly = false;
    k.classList.remove('locked');
    k.removeAttribute('data-locked');
    k.value = '';
    k.placeholder = '重新粘贴 API Key（留空则保留原值）';
    k.focus();
    $('aiKeyEdit').textContent = '取消';
  });

  $('aiSave')?.addEventListener('click', async () => {
    const body = { baseUrl: $('aiBase').value.trim(), model: $('aiModel').value.trim() };
    const k = keyInput();
    /* 掩码态（data-locked=1）说明用户没动 Key —— 不传，服务端保留原值 */
    if (!k.dataset.locked) body.apiKey = k.value.trim();
    try {
      await api('/api/ai/image-config', { method: 'PUT', body: JSON.stringify(body) });
      toast('已保存', 'ok');
      renderImageAi();
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  $('aiTest')?.addEventListener('click', async () => {
    status('<span style="color:var(--dim)">测试中…</span>');
    try {
      const r = await api('/api/ai/image-test', { method: 'POST', body: '{}' });
      status(
        `<b style="color:var(--ok)">连接正常</b>` +
          (r.modelListed === null ? '（服务未提供模型清单）' : r.modelListed ? ` —— 模型在服务清单里（共 ${r.models} 个）` : ` —— <b style="color:var(--warn,#c77d2e)">注意：模型「${esc(cfg?.model ?? '')}」不在服务清单（${r.models} 个）里，请核对拼写</b>`),
      );
    } catch (e) {
      status(`<b style="color:var(--bad,#c0504d)">连不上</b> —— ${esc(e.message)}`);
    }
  });
}



/* ---------------------------------------------------------------- 飞书（已迁走） */

/* 2026-10-29 用户定稿：飞书从「设置」搬进员工详情 › 配置 tab › 「飞书」子页，
 * 改成员工级 —— 一个数字员工对应一个飞书自建应用（自己的 App ID / Secret、
 * 自己的长连接通道、自己的白名单）。表单渲染在 chat.mjs 的 mountFeishuPanel。 */

/* ---------------------------------------------------------------- 关于 */

/**
 * 「关于」页（2026-10-22 用户要求加进设置菜单）：只回答"这是什么、什么版本、跑在哪"。
 *
 * 数据口径：版本 / 实例 / 机器名全部来自 `/api/hello` —— 它是服务端自己的答案，
 * 界面不写死版本字面量（写死一份，升级时就出现"页面 1.1.0、服务 1.2.0"这种自相矛盾）。
 */
/**
 * 退出登录（2026-11-07 从 useradmin.mjs 并入 —— 那一页删了）：删掉服务端那张会话票 +
 * **清掉两张 Cookie（登录票与访问令牌）**，然后整页重载。为什么要连令牌一起清：
 * 令牌 Cookie 一年有效，握着它的浏览器被"令牌优先"永远放进面板，只清会话票退了个寂寞。
 * 为什么是 location.reload()：重载走服务端的闸，由它决定给登录页还是面板。
 */
async function logout() {
  /*
   * 文案（2026-11-07 手机实机截图，用户定稿）：「是否确认退出当前账号？」——
   * 一句话问完，不再解释登录票/访问令牌怎么清；`big` 把两颗按钮抬到拇指档。
   */
  const ok = await confirmDo('是否确认退出当前账号？', {
    title: '退出登录',
    ok: '退出',
    big: true,
  });
  if (!ok) return;
  try {
    await api('/api/logout', { method: 'POST' });
  } catch (e) {
    // 401 = 服务端本来就认不出这张票了，等同于退出成功；其它失败要说出来并停在原地
    if (e?.status !== 401) {
      toast(e?.message ?? '退出失败', 'error');
      return;
    }
  }
  /*
   * 壳里退出（2026-11-07 用户：「点击退出按钮，退出到最开始的登录页」）：面板自己的
   * 登录页对壳没有意义 —— 机器会话上面 /api/logout 已清，这里把人交回壳：
   *   · 原生壳 → BandiShell.onLoggedOut()：原生清中枢会话与 Cookie，回登录页；
   *   · 旧 Tauri 壳 → 启动页 #bandi-bye 意图（launcher.js boot 清中枢会话）。
   * 浏览器 / PWA 维持原样：重载走服务端的闸。
   *
   * ⚠️ 壳对象**必须在这里重新取**：`nativeShell` 是 openMe() 里的局部 const（见上），
   * 而 logout() 是从 useradmin.mjs 并进来的**模块级**函数 —— 原先直接引用它，
   * 严格模式下就是 `ReferenceError: nativeShell is not defined`：
   * /api/logout 已经执行（会话真删了）、页面却没跳，用户看到的就是
   * 「点击退出没有反应」（2026-11-07 实报）。桌面浏览器同样会走到这行，一并中。
   */
  const nativeShell = typeof window.BandiShell !== 'undefined' ? window.BandiShell : null;
  if (nativeShell) {
    try {
      nativeShell.onLoggedOut();
      return;
    } catch {
      /* 桥调用失败（壳版本老 / 方法没实现）→ 落到下面的重载，别把人卡在原地 */
    }
  }
  const shellHome = window.__BANDI_SHELL__?.home;
  if (shellHome) {
    location.href = shellHome + '#bandi-bye';
    return;
  }
  location.reload();
}

export async function renderAbout() {
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
export async function renderQuota() {
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



export function paintQuota(st) {
  const today = st.today ?? { tokens: 0, runs: 0, tokensText: '0' };
  const rows = st.models ?? [];
  const un = st.unattributed ?? { tokens: 0, runs: 0 };
  // 上限：null / 0 都是"不限制"。输入框留空就是它 —— 不摆一个"0"在里面，
  // 那看着像"配额 0"，跟"不限制"正好是反的。
  const cap = (v) => (v ? String(v) : '');
  const withLimit = rows.filter((r) => r.limitTokens || r.limitRuns).length;

  /*
   * 分组版式（2026-10-29 用户定稿："左边是组列表，右边是这个组的模型"）：
   * 组 = 模型 id 里第一个「/」前面那段（auto/…、group/…、opencode-zen-free/…），
   * 没有斜杠的是别名 / 独立模型（haiku 这类），收进「未分组」垫底。
   * 组只是**前端看的**：服务端 /api/quota 没有"组"这个概念，额度仍按模型一条条设，
   * 保存也仍是整表提交（每一组一张表，全部留在 DOM 里，qSave 一把全收）。
   * 选中组记在 S.quotaGroupPick（'*' = 全部），保存后重画时不丢。
   */
  const buckets = new Map();
  for (const r of rows) {
    const key = r.id.includes('/') ? r.id.slice(0, r.id.indexOf('/')) : '';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }
  const groups = [...buckets.keys()]
    .sort((a, b) => (a === '') - (b === '') || a.localeCompare(b))
    .map((key) => ({ key, rows: buckets.get(key) }));
  const pick = S.quotaGroupPick === '*' || buckets.has(S.quotaGroupPick) ? S.quotaGroupPick : '*';

  const sideItem = (key, label, n, warn) =>
    `<div class="ms-item${key === pick ? ' on' : ''}" data-qgroup="${esc(key)}">
      <span class="ms-item-name">${esc(label)}</span>
      ${warn ? '<span class="ms-dot-bad" title="这一组里有模型超了上限"></span>' : ''}
      <span class="ms-item-n">${n}</span>
    </div>`;

  const rowHtml = (r) => `<tr data-model="${esc(r.id)}">
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
    </tr>`;

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
        ${
          rows.length
            ? `<div class="ms-split">
                 <div class="ms-side" id="qtSide">
                   <div class="ms-side-title">分组</div>
                   ${sideItem('*', '全部', rows.length, rows.some((r) => r.over))}
                   ${groups
                     .map((g) => sideItem(g.key, g.key || '未分组', g.rows.length, g.rows.some((r) => r.over)))
                     .join('')}
                 </div>
                 <div class="ms-main" id="qtTables">
                   ${groups
                     .map(
                       (g) => `<div class="qt-group-head" ${pick === '*' ? '' : 'hidden'}>${esc(g.key || '未分组')}</div>
                     <table class="quota-table" data-gtable="${esc(g.key)}" ${
                       pick === '*' || pick === g.key ? '' : 'hidden'
                     }>
                       <thead>
                         <tr>
                           <th>模型</th>
                           <th class="qt-r">今天已用</th>
                           <th class="qt-r">上限 token</th>
                           <th class="qt-r">上限次数</th>
                         </tr>
                       </thead>
                       <tbody>
                         ${g.rows.map(rowHtml).join('')}
                       </tbody>
                     </table>`,
                     )
                     .join('')}
                   <div class="qt-save"><button class="primary" id="qSave">保存</button></div>
                 </div>
               </div>`
            : `<div class="set-box"><div class="set-note">没读到任何模型 —— 各运行时的清单可能都没取到（看上面的提示），或者确实一个都没有。</div></div>`
        }
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

  /* 切组：只翻各表的 hidden / 左栏 .on，**不重画** —— 重画会把没保存的输入冲掉。
     「全部」= 每张表都露出来（组名小标题跟着露），选某一组就只留那一组。 */
  document.querySelectorAll('#qtSide .ms-item').forEach((el) => {
    el.onclick = () => {
      const key = el.dataset.qgroup ?? '*';
      S.quotaGroupPick = key;
      document.querySelectorAll('#qtSide .ms-item').forEach((x) => x.classList.toggle('on', x === el));
      document.querySelectorAll('#qtTables [data-gtable]').forEach((t) => {
        t.hidden = key !== '*' && t.dataset.gtable !== key;
      });
      document.querySelectorAll('#qtTables .qt-group-head').forEach((h) => {
        h.hidden = key !== '*';
      });
    };
  });

  $('qSave').onclick = async () => {
    /*
     * **整表提交**：页面上每一行都发出去，留空 = null = 不限制。
     * 只发填了的那些是不行的 —— 那样"把一个上限清空"跟"这次没动它"长得一样，删不掉。
     * 分组版式下当前组之外的表是 hidden 的，但**都还在 DOM 里**，
     * 所以照旧一表不落全收（这也正是"每组一张表都留在 DOM"的原因）。
     */
    const limits = {};
    document.querySelectorAll('.quota-table tr[data-model]').forEach((tr) => {
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
