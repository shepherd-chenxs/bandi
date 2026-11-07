/* settings.mjs —— 设置、关于、额度。
 * 2026-10-22 由 app.js（15537 行单文件）拆出，原生 ESM、无打包器；逻辑逐字搬运。 */
import { esc, setRoute, setTheme, toast } from './shell.mjs';
import { api, dt, failHtml, initial, post, showFail, wireDialogHead } from './ui.mjs';
import { qrSvg } from './vendor/qrcode.mjs';
import { headRow, renderPlugins, renderRuntimes, rtLoading } from './connectors.mjs';
import { openRemotePage, setPluginRerender } from './experts.mjs';
import { confirmDo } from './machine.mjs';
import { renderList, showView } from './contacts.mjs';
import { setListTitle } from './flowpages.mjs';
import { openCodeRepoPage, renderSkillCards } from './skills.mjs';
import { renderPairing } from './pairing.mjs';

// 设置 › 安全（2026-10-31 IAM Phase 1）：我的会话 + 审计日志
import { renderSecurity } from './securityadmin.mjs';
import { $, S } from './core.mjs';



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

export async function openMe() {
  setRoute('me');
  setPluginRerender(null);
  showView('settings');
  setListTitle('我的');
  const who = S.auth ?? null;
  const isUser = who?.kind === 'user';
  const isDevice = who?.kind === 'device';
  /*
   * 账户为主（2026-11-03 三改）：身份卡的头像/名字取**账号**。设备绑了归属人
   * 就显示归属账号；只有零账号形态的老设备才退回设备名兜底。
   * 设备信息（型号 / 地址 / 时间）不进身份卡 —— 它是属性，在下面的「这台设备」卡。
   */
  const dev = who?.device ?? null;
  // 身份卡显示**中枢账号**（登录用的手机号）：本机名条只是实现细节（2026-11-07）
  const name = isUser
    ? (who?.user?.hub || who?.user?.name || '')
    : isDevice
      ? (who?.user?.hub || who?.user?.name || dev?.name || '这台设备')
      : '未登录';
  /*
   * 身份卡：一行说明。设备绑了账号时 meta 与登录账号同款（"班底账号"）—— 账号是标题，
   * 不用再解释"以谁的身份"；没绑账号的才需要一句话说清"现在是什么身份在用"。
   * （2026-11-07：身份章随角色体系一起退场 —— 登录即全权，没有"角色名"可标。）
   */
  const meta = isUser
    ? '中枢账号 · 手机号登录'
    : isDevice
      ? (who?.user?.hub ? '中枢账号 · 手机号登录' : '未绑定账号 · 以设备身份使用')
      : '这台机器还没有登录账号';
  // 配对时间给「这台设备」卡 —— dt() 按本机时区出「2026/11/03 19:39」
  // （ISO 里存的是 UTC，手切字符串会差 8 小时，2026-11-03 实机踩过）
  const pairedAt = dev?.pairedAt ? dt(dev.pairedAt) : '';
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
   *   手机 —— 三行，系统 / 版本**分开**：窄屏一行放不下"Linux 6.8.0-138-generic x64 ·
   *   班底 v1.5.x"，`.me-v` 是 break-all，硬挤会在内核号中间断字（iOS 设置页也是拆行的）。
   *   本机地址手机上不画：与「已配对到」同一个 location.host；实例标识是排查用的，同上。
   */
  const machineAll = hello
    ? [
        ['设备名', hello.hostname || hello.label || '—'],
        ['系统 / 版本', `${hello.os || '未知'}${hello.version ? ` · 班底 v${hello.version}` : ''}`],
        ['本机地址', location.host || '—'],
        ['实例标识', hello.instanceId || '—'],
      ]
    : [];
  const phoneMachineAll = hello
    ? [
        ['设备名', hello.hostname || hello.label || '—'],
        ['系统', hello.os || '未知'],
        ['版本', hello.version ? `班底 v${hello.version}` : '未知'],
      ]
    : [];
  const machineRowHtml = ([k, v]) =>
    `<div class="me-kv"><span class="me-k">${esc(k)}</span><span class="me-v ${k === '实例标识' ? 'me-v-mono' : ''}">${esc(v)}</span></div>`;
  const machineRows = machineAll.map(machineRowHtml).join('');
  const phoneMachineRows = phoneMachineAll.map(machineRowHtml).join('');
  $('settingsView').innerHTML = `
    ${headRow('<b>我的</b>')}
    <div class="detail-body me-body">
      <section class="set-sec me-hero-sec">
        <div class="me-hero-card">
          <span class="me-ava">${esc(initial(name))}</span>
          <div class="me-who">
            <div class="me-name">
              <b>${esc(name)}</b>
            </div>
            ${meta ? `<span class="me-meta">${esc(meta)}</span>` : ''}
          </div>
        </div>
      </section>
      ${
        /* 当前机器（2026-11-07）：这台电脑的名字 / 系统 / 实例标识 —— 「我的」页原本
           只有账号没有机器，用户问"这台设备呢"。桌面画全四行；手机窄屏另有一张
           同名卡（下面 phoneMachineRows 那段），但只留两行 —— 手机上"这台机器"
           指的是**连过去的那台班底机**，跟"这台设备"（手机自己）不是一回事。 */
        !onPhone && machineRows
          ? `<section class="set-sec me-dev-sec">
               <div class="set-head"><b>这台机器</b></div>
               <div class="me-dev-box">${machineRows}</div>
             </section>`
          : ''
      }
      ${
        /*
         * 外观（2026-11-05 用户：「我的页面加一个主题选择的功能。可以选深色、浅色那种」）。
         * 只在手机形态画：桌面有 设置 › 偏好 › 主题 那一处，再摆一份是重复入口。
         * 位置紧贴 hero —— 它正好吃 §15b 的 `.me-hero-sec + .set-sec { margin-top:-36px }`
         * 上浮规则，成为"渐变头 + 白卡上浮"里的第一张卡。
         * 控件形态（同日晚用户拍板：「也改成这种选项卡的方式」，指桌面偏好设置那张截图）：
         * 一行「主题 + 分段选项卡」，与桌面 .seg 同一结构 —— 不做三行单选了。
         * 右对齐的分段不占整行宽（三格总宽 ~240px），390px 放得下，不会出现
         * 当初担心的"跟随系统挤成两行"。
         */
        onPhone
          ? `<section class="set-sec me-theme-sec">
               <div class="set-head"><b>外观</b></div>
               <div class="me-theme-box" id="meThemeBox">
                 <div class="me-theme-row">
                   <span class="me-theme-label">主题</span>
                   <div class="seg me-theme-seg">
                     ${THEME_OPTS.map(
                       ([v, label]) =>
                         `<button type="button" class="${S.theme === v ? ' on' : ''}" data-theme-opt="${v}">${label}</button>`,
                     ).join('')}
                   </div>
                 </div>
               </div>
             </section>`
          : ''
      }
      ${
        /* 「这台设备」属性卡（2026-11-03 账户为主）：设备是账号的一个属性，
           不再占身份卡 —— 落成 label + value 的属性行。设备记录丢了就不画空卡。 */
        isDevice && dev
          ? `<section class="set-sec me-dev-sec">
               <div class="set-head"><b>这台设备</b></div>
               <div class="me-dev-box">
                 <div class="me-kv"><span class="me-k">设备名</span><span class="me-v">${esc(dev.name || '—')}</span></div>
                 <div class="me-kv"><span class="me-k">已配对到</span><span class="me-v me-v-mono">${esc(location.host)}</span></div>
                 ${pairedAt ? `<div class="me-kv"><span class="me-k">配对时间</span><span class="me-v">${esc(pairedAt)}</span></div>` : ''}
               </div>
             </section>`
          : ''
      }
      ${
        /* 手机窄屏的「这台机器」（2026-11-07 用户：「修改手机端」）：手机上"这台机器"
           指的是**被连接的那台班底机**（当前这个页面就是它服务的），与上面「这台设备」
           （手机自己）是两张卡、两件不同的事实 —— 分开摆，别混成一张。
           只画「设备名 + 系统 / 版本」两行：本机地址与「已配对到」重复，实例标识是
           排查才用的，窄屏一屏放得下两条就够回答"我连的是哪台机、跑的哪版"。 */
        onPhone && phoneMachineRows
          ? `<section class="set-sec me-dev-sec">
               <div class="set-head"><b>这台机器</b></div>
               <div class="me-dev-box">${phoneMachineRows}</div>
             </section>`
          : ''
      }
      ${
        /* 「通用 · 清除缓存」（2026-11-06 用户：「手机端我的页面加一个清除缓存的功能」）：
           只在手机形态画。清的是本机 Service Worker 的 bandi-static-* 静态缓存
           （页面/脚本/样式），治"改了代码手机上看不到"—— 上一轮评论入口改版就靠
           杀 App 重开才换新，有了这个入口在页面里就能自愈。登录态在 Cookie 里、
           业务数据在服务端，都不在缓存里，所以清除不伤账号。
           右侧常态显示缓存体积（异步算），点了走 confirmDo → 清缓存 + 注销 SW → 重载。
           2026-11-07：挪到「这台机器」之后 —— 两张设备卡连在一起读，维护类入口收尾。 */
        onPhone
          ? `<section class="set-sec me-cache-sec">
               <div class="set-head"><b>通用</b></div>
               <div class="me-dev-box">
                 <button type="button" class="me-kv me-cache-row" id="meClearCache">
                   <span class="me-k">清除缓存</span>
                   <span class="me-v" id="meCacheHint">计算中…</span>
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
        /* 「当前设备」（2026-11-07 用户：「我的页面加一个当前设备菜单。点击之后进入
           到设备列表页，选择之后进行切换」）：只在**壳里 + 中枢账号会话**画 ——
           面板和启动页是两个 origin，"设备列表"只存在于壳的启动页上；桥 = 导航回
           启动页并带上 #bandi-devices 意图（会话还活着，启动页开机自动进列表）。
           扫码进来的设备身份没有中枢会话，列表对它无意义（2026-11-07 同日撤掉扫码，
           老设备令牌到过期为止），不画这行。值显示这台面板是哪台机器（/api/hello）。 */
        shell && onPhone && hello && isUser
          ? `<section class="set-sec me-cache-sec">
               <div class="me-dev-box">
                 <button type="button" class="me-kv" id="meSwitchDevice">
                   <span class="me-k">当前设备</span>
                   <span class="me-v">${esc(hello.label || hello.hostname || '—')}</span>
                   <i class="me-chevron" aria-hidden="true">›</i>
                 </button>
               </div>
             </section>`
          : ''
      }
      ${
        /* 退场动作整宽一行：个人中心的"走人"动作用整行 + 文字染色，比右下角一颗
           小按钮稳。退出登录染 --bad（"走人"的分量）；断开连接/去登录是中性动作，不染。
           （2026-11-07：账号安全双卡随本地密码/OTP 退场 —— 密码与动态验证都在中枢上管。） */
        `<section class="set-sec me-out-sec">
           <div class="me-out-box">${
             canLogout
               ? '<button class="me-out me-out-danger" id="meLogout">退出登录</button>'
               : isDevice
                 ? /* 手机设备（2026-11-02 用户："手机端连接之后需要一个入口能够断开连接"）——
                      与「退出登录」同位、同款：这是这台手机的"退出"。断开≠取消配对：
                      记录留着，没有别的手机在用的时候打开 App 点「连接」就能回来。 */
                   '<button class="me-out" id="meDisconnect">断开连接</button>'
                 : '<button class="me-out" id="meGoLogin">去登录</button>'
           }</div>
         </section>`
      }
    </div>`;
  /*
   * 外观选择（2026-11-05）：setTheme 默认会重绘「设置 › 偏好」那一页 ——
   * 手机上那页根本不存在，点一下就被踢出「我的」。keepPage 让它只存值 + 换肤，
   * 选中态就在原地toggle（不整页重绘，也就不会闪一下、不会滚回顶部）。
   */
  const themeBox = $('meThemeBox');
  if (themeBox) {
    themeBox.querySelectorAll('[data-theme-opt]').forEach((b) => {
      b.onclick = () => {
        setTheme(b.dataset.themeOpt, { keepPage: true });
        themeBox.querySelectorAll('[data-theme-opt]').forEach((x) => x.classList.toggle('on', x === b));
      };
    });
  }
  $('meLogout')?.addEventListener('click', () => void logout());
  /*
   * 当前设备 → 回壳的设备列表（2026-11-07）：只在壳里渲染（见上面 shell）。
   * 原生壳直接调 BandiShell.openDeviceList()；旧 Tauri 壳走启动页意图 hash。
   */
  $('meSwitchDevice')?.addEventListener('click', () => {
    if (nativeShell) { nativeShell.openDeviceList(); return; }
    if (shell?.home) location.href = shell.home + '#bandi-devices';
  });
  /*
   * 清除缓存（2026-11-06）：进页先异步算一遍 bandi-static-* 缓存体积亮在行尾；
   * 点击 → confirmDo → 清掉全部 Cache Storage + 注销 Service Worker → location.reload()。
   * 注销而不是只删缓存：SW 注销后这次重载直连网络，index.html 会重新注册出
   * 一个"只装新文件"的 SW —— 相当于把"杀 App 重开"压进一个按钮里。
   * 任何一步失败都不拦重载（清不掉就硬刷，网络优先的 SW 本来也会拿新文件）。
   */
  const cacheRow = $('meClearCache');
  if (cacheRow) {
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
  /*
   * 手机「断开连接」：调 /api/pair/leave（手机身份专属口），成功后派 `mb-left` 让
   * mobile.mjs 决定落到哪儿 —— 壳里回连接页，浏览器里回配对页。
   * 退场导航不在这一页写：SHELL_ORIGIN 是 mobile.mjs 的知识（远程页调不了壳命令那条注释），
   * 这里 import 过去就和 settings → mobile 成环。
   */
  $('meDisconnect')?.addEventListener('click', async () => {
    const ok = await confirmDo(
      '断开后这台手机会立刻退出，但配对记录留着 —— 没有别的手机在用的时候，打开 App 点「连接」就能回来。',
      { ok: '断开连接', danger: false },
    );
    if (!ok) return;
    const b = $('meDisconnect');
    if (b) b.disabled = true;
    try {
      await post('/api/pair/leave', {});
      document.dispatchEvent(new CustomEvent('mb-left'));
    } catch (e) {
      if (b) b.disabled = false;
      toast(e.message, 'error');
    }
  });
  // 兜底：正常进不到这个分支（面板门前移到登录页，见 auth.mjs 的 wantsPanelHtml），
  // 万一从令牌通道挤进来，至少给一条出路 —— 别再摆一段讲实现细节的说明。
  $('meGoLogin')?.addEventListener('click', () => location.reload());
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
      /* 「手机连接」（2026-11 手机端增量）：扫码连接手机 —— 对外服务形态才有意义。
         2026-11-01 起模式卡长在这页顶上：回环时当场切成对外服务 + 重启即可 */
      ['pairing', '手机连接', '模式 · 扫码连接手机'],
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

/*
 * 手机设备（受限视图）的「我的」= 设备信息 + 可用设置（2026-10-28，设计 T04 第 1 条）。
 *
 * 为什么单独一份而不是在渲染里逐条 `if`：服务端白名单已经决定设备碰不到
 * 技能/连接器/插件/飞书/额度/数据管理/这台机器/手机连接 —— 左栏还把它们列出来，
 * 用户点一个吃一个 E4033 toast，等于把「没权限」包装成「这东西坏了」。
 * 设备端只留**真能用**的三节；`/api/pair/me` 就是「这台手机」那节的数据源。
 */
export const DEVICE_SETTINGS_SECTIONS = [
  ['device', '这台手机', '配对与连接'],
  ['prefs', '偏好设置', '主题与外观'],
  ['about', '关于', '版本与说明'],
];

/**
 * 当前身份能看到的设置分节（**平铺**）：openSettings 的兜底判断用这一份。
 * 桌面（登录即全权）= 分组拍平；设备 = 自己的小清单。
 */
export function settingsSections() {
  if (S.isDevice) return DEVICE_SETTINGS_SECTIONS;
  return SETTINGS_GROUPS.flatMap((g) => g.items);
}

/**
 * 左栏分组渲染用：`[{title, items}]`。
 *
 * **只有桌面画组头** —— 设备形态 3 节本来就短，再切一组反而是给短列表加噪音；
 * 这种形态 `title: null` = 渲染时不画组头。
 * 组内顺序即左栏顺序，`settingsSections()` 就是把它拍平的，两份永远同源。
 */
export function settingsGroups() {
  if (S.isDevice) return [{ title: null, items: DEVICE_SETTINGS_SECTIONS }];
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
  if (S.settingsSection === 'device') return renderDeviceInfo();
  if (S.settingsSection === 'runtimes') return renderRuntimes();
  if (S.settingsSection === 'pairing') return renderPairing();
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
  // 回复风格是「全体数字员工」的写设置（PUT 对设备 403）—— 设备形态不渲染那一节
  if (!S.isDevice) loadReplyStyle().catch(() => {}); // 偏好里唯一要问服务端的一项（存在 config.json，跟设备走）
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
/* ---------------------------------------------------------------- 这台手机（设备形态） */

/**
 * 手机设备的「我的」页首节（2026-10-28）：配对信息只读。
 *
 * 数据来自 `/api/pair/me`（`load()` 里取过一次，存在 `S.device`）—— 不再打
 * `/api/pair/devices`：那是**操作员**的设备清单（含别的手机），设备令牌碰它 403。
 * 「断开连接 / 取消配对」只给指路：都是电脑端动作（设备令牌的白名单里没有它们，也不该有）。
 */

/**
 * 退出登录（2026-11-07 从 useradmin.mjs 并入 —— 那一页删了）：删掉服务端那张会话票 +
 * **清掉两张 Cookie（登录票与访问令牌）**，然后整页重载。为什么要连令牌一起清：
 * 令牌 Cookie 一年有效，握着它的浏览器被"令牌优先"永远放进面板，只清会话票退了个寂寞。
 * 为什么是 location.reload()：重载走服务端的闸，由它决定给登录页还是面板。
 */
async function logout() {
  const ok = await confirmDo('退出登录？这台浏览器上的登录票和访问令牌都会清掉，下次进来走登录页。', {
    title: '退出登录',
    ok: '退出',
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
   */
  if (nativeShell) {
    nativeShell.onLoggedOut();
    return;
  }
  const shellHome = window.__BANDI_SHELL__?.home;
  if (shellHome) {
    location.href = shellHome + '#bandi-bye';
    return;
  }
  location.reload();
}

export function renderDeviceInfo() {
  const d = S.device ?? {};
  $('settingsView').innerHTML = `
    ${headRow('<b>这台手机</b>')}
    <div class="detail-body">
      <section class="set-sec">
        <div class="set-head"><b>配对信息</b><span class="set-tag">设备令牌</span></div>
        <div class="set-box">
          <div class="set-row">
            <span class="set-label">名称</span>
            <div class="machine-data">${esc(d.name ?? '手机设备')}</div>
          </div>
          <div class="set-row">
            <span class="set-label">配对于</span>
            <div class="machine-data">${esc(d.pairedAt ? dt(d.pairedAt) : '—')}</div>
          </div>
          <div class="set-row">
            <span class="set-label">断开连接</span>
            <div class="machine-data">在电脑上打开「设置 → 手机连接」，点这台手机的「断开连接」——断开后本机下次操作会掉线，但配对记录还在：没有别的手机在用的时候，本机打开班底会自己连回来，不用重新扫码。要彻底解绑用「取消配对」。</div>
          </div>
        </div>
      </section>
    </div>`;
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
