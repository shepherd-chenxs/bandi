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
// 设置 › 协作中心（2026-11-01 从工作台搬来）：页面本体在 collab.mjs，这里只挂分节
import { renderCollabCenter } from './collab.mjs';
import { renderRoles } from './roleadmin.mjs';
import { logout, renderUsers } from './useradmin.mjs';
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
 * （useradmin.logout，两张票一起清），别处再写就是第二套口径。
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

/* 账号安全两卡的线性小图标（跟随 .me-sec-ico 的 accent 色，与 rail 图标同一套笔触） */
const ICO_KEY =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>';
const ICO_SHIELD =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>';

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

export function openMe() {
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
  const name = isUser
    ? (who?.user?.name ?? '')
    : isDevice
      ? (who?.user?.name || dev?.name || '这台设备')
      : '未登录';
  /*
   * 身份卡：名字旁的身份章（登录账号才有角色）+ 一行说明。
   * 设备绑了账号时 meta 与登录账号同款（"班底账号"）—— 账号是标题，不用再解释
   * "以谁的身份"；没绑账号的才需要一句话说清"现在是什么身份在用"。
   */
  const role = isUser ? (who?.role?.name ?? '') : '';
  const meta = isUser
    ? '班底账号'
    : isDevice
      ? (who?.user?.name ? '班底账号' : '未绑定账号 · 以设备身份使用')
      : '这台机器还没有登录账号';
  // 配对时间给「这台设备」卡 —— dt() 按本机时区出「2026/11/03 19:39」
  // （ISO 里存的是 UTC，手切字符串会差 8 小时，2026-11-03 实机踩过）
  const pairedAt = dev?.pairedAt ? dt(dev.pairedAt) : '';
  // 免密 / 已设置：只有登录账号有"自己的密码"可改（操作员没有账号，去设置 → 用户里管）
  const hasPw = isUser ? who?.user?.hasPassword !== false : false;
  // 动态验证：同上，登录账号才有"自己的验证器"
  const hasTotp = isUser ? who?.user?.hasTotp === true : false;
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
  $('settingsView').innerHTML = `
    ${headRow('<b>我的</b>')}
    <div class="detail-body me-body">
      <section class="set-sec me-hero-sec">
        <div class="me-hero-card">
          <span class="me-ava">${esc(initial(name))}</span>
          <div class="me-who">
            <div class="me-name">
              <b>${esc(name)}</b>
              ${role ? `<span class="me-role">${esc(role)}</span>` : ''}
            </div>
            ${meta ? `<span class="me-meta">${esc(meta)}</span>` : ''}
          </div>
        </div>
      </section>
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
        /* 「通用 · 清除缓存」（2026-11-06 用户：「手机端我的页面加一个清除缓存的功能」）：
           只在手机形态画。清的是本机 Service Worker 的 bandi-static-* 静态缓存
           （页面/脚本/样式），治"改了代码手机上看不到"—— 上一轮评论入口改版就靠
           杀 App 重开才换新，有了这个入口在页面里就能自愈。登录态在 Cookie 里、
           业务数据在服务端，都不在缓存里，所以清除不伤账号。
           右侧常态显示缓存体积（异步算），点了走 confirmDo → 清缓存 + 注销 SW → 重载。 */
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
        /* 账号安全双卡（2026-11-03 桌面重设计）：密码 / 动态验证是 PC 端的管理动作，
           手机白名单之外 —— 窄屏不渲染（见上面 onPhone 的注释）。 */
        isUser && !onPhone
          ? `<section class="set-sec">
               <div class="set-head"><b>账号安全</b></div>
               <div class="me-sec-grid">
                 <div class="me-sec-card">
                   <div class="me-sec-head">
                     <span class="me-sec-ico">${ICO_KEY}</span>
                     <b>登录密码</b>
                     <span class="me-state ${hasPw ? 'is-ok' : 'is-warn'}"><i></i>${hasPw ? '已设置' : '免密'}</span>
                   </div>
                   <p class="me-sec-desc">${
                     hasPw
                       ? '用于登录班底。改完密码后，其它已登录的设备会全部下线。'
                       : '免密账号只是本机身份，别的设备登不进来；要远程登录，先在这里补上密码。'
                   }</p>
                   <div class="me-sec-foot"><button class="btn-sm" id="mePwd">修改密码</button></div>
                 </div>
                 <div class="me-sec-card">
                   <div class="me-sec-head">
                     <span class="me-sec-ico">${ICO_SHIELD}</span>
                     <b>动态验证</b>
                     <span class="me-state ${hasTotp ? 'is-ok' : ''}"><i></i>${hasTotp ? '已开启' : '未开启'}</span>
                   </div>
                   <p class="me-sec-desc">${
                     hasTotp
                       ? '登录时除了密码，还要输一个验证器 6 位码。'
                       : '开启后，登录除了密码还要输一个验证器 6 位码；手机丢了，用恢复码也能进。'
                   }</p>
                   <div class="me-sec-meta" id="meTotpMeta" hidden></div>
                   <div class="me-sec-foot"><button class="btn-sm" id="meTotp">${hasTotp ? '解绑' : '开启'}</button></div>
                 </div>
               </div>
             </section>`
          : ''
      }
      ${
        /* 退场动作整宽一行：个人中心的"走人"动作用整行 + 文字染色，比右下角一颗
           小按钮稳。退出登录染 --bad（"走人"的分量）；断开连接/去登录是中性动作，不染。 */
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
  $('mePwd')?.addEventListener('click', () => openMePwdDlg(hasPw));
  $('meTotp')?.addEventListener('click', () => (hasTotp ? openOtpOffDlg() : openOtpOnDlg()));
  // 设置入口：交给 mobile.mjs 转一次 setNav（反向 import 会成环，见上面的注释）
  const goSet = () => document.dispatchEvent(new CustomEvent('mb-nav', { detail: { nav: 'settings' } }));
  $('meSettings')?.addEventListener('click', goSet);
  $('meSettings')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      goSet();
    }
  });
  // 已绑定的：说明下面补一行"绑于何时 / 还剩几个恢复码"（参考项目 security 页的 status 显示）
  if (hasTotp) {
    api('/api/me/otp/status')
      .then((st) => {
        const el = $('meTotpMeta');
        if (!el || !st?.enabled) return;
        const at = String(st.bindTime ?? '').replace('T', ' ').slice(0, 16);
        el.textContent = `绑定于 ${at || '—'} · 恢复码剩 ${st.recoveryLeft ?? 0} 个`;
        el.hidden = false;
      })
      .catch(() => {});
  }
}

/**
 * 「我的」› 动态验证（2026-10-31 二改，仿 yaojian-ruoyi 的绑定流）。
 *
 * 三步，与参考项目的 security 页一致：
 *   ① 扫码（或手动输密钥）→ ② 输动态码确认 → ③ **一次性展示 10 个恢复码**（必须抄走）。
 * 密钥在 confirm 之前不落库；恢复码只在 confirm 的响应里出现这一次。
 */
function openOtpOnDlg() {
  const dlg = document.createElement('dialog');
  dlg.id = 'otpDlg';
  dlg.innerHTML = `
    <form method="dialog">
      <b>开启动态验证</b>
      <div id="otpS1" style="margin-top:10px">
        <div class="otp-step">① 用 Authenticator 扫码；扫不了就手动输入下面这串密钥</div>
        <div id="otpQr"></div>
        <div class="machine-data machine-addr" id="otpSecret" style="text-align:center;margin-top:6px"></div>
        <div class="otp-step" style="margin-top:14px">② 输入 App 里显示的 6 位码</div>
        <input id="otpCode" inputmode="numeric" maxlength="6" placeholder="6 位验证码" autocomplete="one-time-code" style="margin-top:6px" />
      </div>
      <div id="otpS2" hidden>
        <div class="otp-step" style="margin-top:10px">
          ③ 恢复码 —— <b>只显示这一次</b>，每个只能用一次。手机丢了、验证器换了，用它代替动态码登录。请立即抄下来。
        </div>
        <div id="otpRecovery" class="otp-recovery"></div>
      </div>
      <div id="otpErr" style="color:#ff8a80;font-size:12.5px;margin-top:8px" hidden></div>
      <div class="dlg-actions" id="otpActions">
        <button type="button" value="cancel">取消</button>
        <button class="primary" id="otpOk" value="ok">确认开启</button>
      </div>
    </form>`;
  document.body.append(dlg);
  wireDialogHead(dlg.querySelector('form'));
  dlg.addEventListener('close', () => dlg.remove());
  const err = dlg.querySelector('#otpErr');
  const bad = (t) => { err.textContent = t; err.hidden = false; };
  dlg.querySelector('button[value="cancel"]').onclick = () => dlg.close();

  let secret = '';
  void (async () => {
    try {
      const r = await api('/api/me/otp/bind', { method: 'POST' });
      secret = r.secret;
      dlg.querySelector('#otpQr').innerHTML = qrSvg(r.uri);
      dlg.querySelector('#otpSecret').textContent = r.secret;
    } catch (e) {
      bad(e.message);
      dlg.querySelector('#otpS1').hidden = true;
    }
  })();

  dlg.querySelector('#otpOk').onclick = async (e) => {
    e.preventDefault();
    err.hidden = true;
    const code = dlg.querySelector('#otpCode').value.trim();
    if (!code) return bad('先输验证器里的 6 位码');
    const btn = dlg.querySelector('#otpOk');
    btn.disabled = true;
    try {
      const r = await api('/api/me/otp/bind/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret, code }),
      });
      // 第三步：展示恢复码（仅此一次），按钮换成「我已保存」
      dlg.querySelector('#otpS1').hidden = true;
      const s2 = dlg.querySelector('#otpS2');
      s2.hidden = false;
      dlg.querySelector('#otpRecovery').innerHTML = (r.recoveryCodes ?? [])
        .map((c) => `<code>${esc(c)}</code>`)
        .join('');
      if (S.auth?.user) S.auth.user.hasTotp = true;
      const acts = dlg.querySelector('#otpActions');
      acts.innerHTML = `
        <button type="button" id="otpCopy">复制全部</button>
        <button class="primary" id="otpDone">我已保存</button>`;
      acts.querySelector('#otpDone').onclick = () => {
        dlg.close();
        toast('动态验证已开启');
        openMe();
      };
      acts.querySelector('#otpCopy').onclick = () => {
        const text = (r.recoveryCodes ?? []).join('\n');
        navigator.clipboard?.writeText(text).then(
          () => toast('恢复码已复制'),
          () => toast('复制失败，请手动抄写', 'error'),
        );
      };
    } catch (e2) {
      btn.disabled = false;
      bad(e2.message);
    }
  };
  dlg.showModal();
  dlg.querySelector('#otpCode').focus();
}

/** 解绑：要当前有效动态码或一个恢复码（防手机丢失后被别人顺手关掉） */
function openOtpOffDlg() {
  const dlg = document.createElement('dialog');
  dlg.id = 'otpOffDlg';
  dlg.innerHTML = `
    <form method="dialog">
      <b>关闭动态验证</b>
      <div class="otp-step" style="margin-top:10px">
        关闭后登录只需密码。为确认是本人操作，请输入当前验证器的 6 位动态码（或一个恢复码）。
      </div>
      <input id="otpCode" inputmode="numeric" maxlength="8" placeholder="动态验证码或恢复码" autocomplete="one-time-code" style="margin-top:8px" />
      <div id="otpErr" style="color:#ff8a80;font-size:12.5px;margin-top:8px" hidden></div>
      <div class="dlg-actions">
        <button type="button" value="cancel">取消</button>
        <button class="danger" id="otpOff" value="ok">解绑</button>
      </div>
    </form>`;
  document.body.append(dlg);
  wireDialogHead(dlg.querySelector('form'));
  dlg.addEventListener('close', () => dlg.remove());
  const err = dlg.querySelector('#otpErr');
  dlg.querySelector('button[value="cancel"]').onclick = () => dlg.close();
  dlg.querySelector('#otpOff').onclick = async (e) => {
    e.preventDefault();
    err.hidden = true;
    try {
      await api('/api/me/otp/unbind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: dlg.querySelector('#otpCode').value.trim() }),
      });
      dlg.close();
      if (S.auth?.user) S.auth.user.hasTotp = false;
      toast('已解绑动态验证');
      openMe();
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
    }
  };
  dlg.showModal();
  dlg.querySelector('#otpCode').focus();
}

/** 「我的」› 修改密码弹窗（2026-10-31）。免密账号没有"当前密码"格；新密码留空 = 改回免密。 */
function openMePwdDlg(hasPw) {
  const dlg = $('mePwdDlg');
  const cur = $('mePwdCur');
  const n1 = $('mePwdNew');
  const n2 = $('mePwdNew2');
  const err = $('mePwdErr');
  const bad = (t) => { err.textContent = t; err.hidden = false; };
  cur.hidden = !hasPw;
  cur.value = n1.value = n2.value = '';
  err.hidden = true;
  dlg.querySelector('button[value="cancel"]').onclick = () => dlg.close();
  $('mePwdOk').onclick = async (e) => {
    e.preventDefault();
    err.hidden = true;
    if (hasPw && !cur.value) return bad('先填当前密码');
    if (n1.value !== n2.value) return bad('两次输入的新密码不一样');
    if (n1.value && n1.value.length < 8) return bad('新密码要 8 位以上（或留空改回免密）');
    try {
      await api('/api/me/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current: cur.value, password: n1.value }),
      });
      dlg.close();
      // 服务端改完密码会作废全部会话、给这台浏览器补了张新票（Cookie 已换）——
      // 本地把状态跟上，重画"免密 / 已设置"那一行
      if (S.auth?.user) S.auth.user.hasPassword = n1.value !== '';
      toast(n1.value ? '密码已改' : '已改回免密');
      openMe();
    } catch (e2) {
      bad(e2?.message ?? '没改成，再试一次');
    }
  };
  dlg.showModal();
  (hasPw && !cur.hidden ? cur : n1).focus();
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
      /* 「协作中心」（2026-11-01 从工作台搬进设置；同日晚从「协作」组挪到本机与设备
         下面 —— 用户："协作中心放到本机与设备下面"，跟这台机器/手机连接本来就
         是一摊"这台设备怎么接人"的事）。页面本体长在 collab.mjs renderCollabCenter
         （画进 #settingsView），这里只是左栏的一个分节 —— 非管理员
         （settingsSections 的过滤）看不到，与接口层的 mayManage（admin/operator）对齐。 */
      ['collab', '协作中心', '把活派给分公司，看进度'],
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
    /* 「角色与菜单」（2026-10-28 第二刀）：角色 = 名字 + 一组菜单 key，先只存库。
       **设备形态不加进下面的平铺** —— 服务端五个口都要操作员，
       列出来就是"点一下吃一个 403"（那条规矩见 settingsSections 的注释）。 */
    title: '账号与权限',
    icon: '<path d="M7 1.5l4.8 1.9v3.4c0 3-2 4.7-4.8 5.7C4.2 11.5 2.2 9.8 2.2 6.8V3.4z"/>',
    items: [
      ['roles', '角色与菜单', '角色能看见哪些菜单'],
      /* 「用户」（2026-10-28 第三刀）：账号 + 登录 + 角色分配。设备形态同样不加 —— 见上面那条。 */
      ['users', '用户', '账号与角色'],
      /* 「安全」（2026-10-31 IAM Phase 1）：我的会话（人人可用）+ 审计日志（admin）。
         非管理员也放行 —— 会话列表是"自己的"那半页（服务端只认会话里的 userId）。 */
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
 * 桌面管理员 = 分组拍平；设备 / 非管理员 = 各自的小清单。
 */
export function settingsSections() {
  if (S.isDevice) return DEVICE_SETTINGS_SECTIONS;
  /*
   * 非管理员的登录账号（2026-10-28 第三刀）：**只留「偏好设置」与「关于」**。
   *
   * 为什么硬编码两条而不是"按菜单 key 拆设置小节"：设置里的每一节对应的是
   * **这台机器的管理动作**（改模型路由、装卸插件、管账号…），逐节做权限就是
   * 给每节再配一份权限表，本刀明确不做（任务书 §八 非目标）。而"能看设置"这件事
   * 本身对这些账号仍然成立 —— 主题、关于是可以看的。
   */
  if (S.isUser && !S.isAdmin) {
    return SETTINGS_GROUPS.flatMap((g) => g.items).filter(([k]) => k === 'prefs' || k === 'about' || k === 'security');
  }
  return SETTINGS_GROUPS.flatMap((g) => g.items);
}

/**
 * 左栏分组渲染用（2026-10-29 分区）：`[{title, items}]`。
 *
 * **只有桌面管理员画组头** —— 设备形态 3 节、非管理员 2 节，本来就短，
 * 再切一组反而是给短列表加噪音；这两种形态 `title: null` = 渲染时不画组头。
 * 组内顺序即左栏顺序，`settingsSections()` 就是把它拍平的，两份永远同源。
 */
export function settingsGroups() {
  if (S.isDevice) return [{ title: null, items: DEVICE_SETTINGS_SECTIONS }];
  if (S.isUser && !S.isAdmin) return [{ title: null, items: settingsSections() }];
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
  if (S.settingsSection === 'collab') return renderCollabCenter();
  if (S.settingsSection === 'plugins') return renderPlugins();
  if (S.settingsSection === 'quota') return renderQuota();
  if (S.settingsSection === 'skills') return renderSkillCards();
  if (S.settingsSection === 'roles') return renderRoles();
  if (S.settingsSection === 'users') return renderUsers();
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
