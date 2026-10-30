/* ui.mjs —— 对话框通用件、标题旁的「?」说明（2026-10-17）、悬浮提示（自建 data-tip）、自建下拉（全站公共组件）。
 * 2026-10-22 由 app.js（15537 行单文件）拆出，原生 ESM、无打包器；逻辑逐字搬运。 */
import { esc, toast } from './shell.mjs';
import { $, S } from './core.mjs';



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
export function wireDialogHead(form) {
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



/* ------------------------------------------------- 标题旁的「?」说明（2026-10-17） */

/** 帮助图标：一个圈里一个问号（跟 ICON_CHAT 那批同一套画法，只填路径不填色） */
export const ICON_HELP =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.6"/><path d="M9.6 9.4a2.4 2.4 0 1 1 3.3 2.2c-.7.3-1 .9-1 1.6v.4"/><path d="M12 16.6h.01"/></svg>';



/**
 * 「＋ 添加仓库」拉出来的两个选项用的图标（2026-10-17）。
 * 一个是**本机已有的目录**（手填路径，不联网），一个是**从 GitHub 上挑**（要令牌）。
 * 画法跟 ICON_CHAT 那批一致：只填路径、描边用 currentColor。
 */
export const ICON_FOLDER =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7.5A1.5 1.5 0 0 1 5.5 6h3.2l1.8 2.2h7A1.5 1.5 0 0 1 19 9.7v7.8A1.5 1.5 0 0 1 17.5 19h-12A1.5 1.5 0 0 1 4 17.5z"/></svg>';


export const ICON_CLOUD =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17.5a4 4 0 0 1 .5-8 5.5 5.5 0 0 1 10.4 1.2A3.6 3.6 0 0 1 17.5 17.5z"/><path d="M12 13.5v5M9.8 15.7 12 18l2.2-2.3"/></svg>';



/**
 * 定时任务卡片右上角的三颗动作图标（2026-10-20 用户："这三个改成图标按钮"）。
 * 原来「立即执行 / 编辑 / 删除」是三个带边框的文字按钮，一行三块字比任务名还重；
 * 换成图标后卡面安静了，动词靠 `title` + `aria-label` 兜住 —— 所以两个都不能省。
 * 画法跟 ICON_HELP / ICON_FOLDER 同一套：只填路径，描边用 currentColor。
 */
export const ICON_PLAY =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8.2 5.7 18.4 12 8.2 18.3z"/></svg>';


export const ICON_EDIT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 4.2a2.05 2.05 0 0 1 2.9 2.9l-8.8 8.8-3.9.9.9-3.9z"/><path d="M14.4 6.3l3.3 3.3"/></svg>';


export const ICON_TRASH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4.6 7h14.8"/><path d="M9.6 7V5.3A1.3 1.3 0 0 1 10.9 4h2.2a1.3 1.3 0 0 1 1.3 1.3V7"/><path d="M6.7 7l.7 11.2A1.7 1.7 0 0 0 9.1 20h5.8a1.7 1.7 0 0 0 1.7-1.8L17.3 7"/><path d="M10.4 10.8v5.4M13.6 10.8v5.4"/></svg>';


/**
 * git 语义的五个小图标（2026-10-27，用户指着 IDEA 的分支弹窗要"补图标和缩进"）：
 * 更新项目 / 提交 / 推送 / 分支 / 标签。画法跟上面同一套 —— 只填路径、描边 currentColor，
 * 颜色交给 .combo-ic（弱灰），不在这几条里写死。
 */
/* 「更新项目」= 拉取（pull）—— 下载语义：向下箭头 + 底部托盘（IDEA 的更新项目同款方向） */
export const ICON_SYNC =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v10.2"/><path d="M7.6 10.2 12 14.6l4.4-4.4"/><path d="M4.6 19h14.8"/></svg>';


export const ICON_COMMIT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.1"/><path d="M3.5 12h5.4M15.1 12h5.4"/></svg>';


export const ICON_PUSH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15.5V4.5M7.5 9 12 4.5 16.5 9"/><path d="M5 19.5h14"/></svg>';


export const ICON_BRANCH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 8.4v7.2"/><circle cx="6.5" cy="5.7" r="2.4"/><circle cx="6.5" cy="18.3" r="2.4"/><circle cx="17.5" cy="5.7" r="2.4"/><path d="M17.5 8.1c0 4.4-4.4 5.4-8 5.7"/></svg>';


export const ICON_TAG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12.4 3.5H19a1.5 1.5 0 0 1 1.5 1.5v6.6a1.5 1.5 0 0 1-.44 1.06l-7.4 7.4a1.5 1.5 0 0 1-2.12 0l-6.6-6.6a1.5 1.5 0 0 1-.44-1.06V5A1.5 1.5 0 0 1 5 3.5z"/><circle cx="8" cy="8" r="1.3"/></svg>';


export const ICON_GEAR =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.1"/><path d="M19.4 14.2a1.5 1.5 0 0 0 .3 1.65l.05.05a1.8 1.8 0 1 1-2.55 2.55l-.05-.05a1.5 1.5 0 0 0-1.65-.3 1.5 1.5 0 0 0-.9 1.37V20a1.8 1.8 0 1 1-3.6 0v-.1a1.5 1.5 0 0 0-.98-1.37 1.5 1.5 0 0 0-1.65.3l-.05.05A1.8 1.8 0 1 1 4.77 16.3l.05-.05a1.5 1.5 0 0 0 .3-1.65 1.5 1.5 0 0 0-1.37-.9H3.6a1.8 1.8 0 1 1 0-3.6h.1a1.5 1.5 0 0 0 1.37-.98 1.5 1.5 0 0 0-.3-1.65l-.05-.05A1.8 1.8 0 1 1 7.27 4.77l.05.05a1.5 1.5 0 0 0 1.65.3H9a1.5 1.5 0 0 0 .9-1.37V3.6a1.8 1.8 0 1 1 3.6 0v.1a1.5 1.5 0 0 0 .9 1.37 1.5 1.5 0 0 0 1.65-.3l.05-.05a1.8 1.8 0 1 1 2.55 2.55l-.05.05a1.5 1.5 0 0 0-.3 1.65V9a1.5 1.5 0 0 0 1.37.9h.1a1.8 1.8 0 1 1 0 3.6h-.1a1.5 1.5 0 0 0-1.37.9z"/></svg>';



/**
 * 工作台磁贴的图标（2026-10-20 重设计）：原来磁贴上是一个"单字色块"（项/板/时/编/流），
 * 撑不起 40px 的图标位，看着像没画完。换成跟全站一套的线性 SVG。
 * 画法同上：只填路径、描边 currentColor，颜色由 .wb-ico 的渐变底给。
 */
export const ICON_WB_BOARD =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9.2 4.5v15M14.8 4.5v15"/></svg>';


export const ICON_WB_CLOCK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.2"/><path d="M12 7.5V12l3 2.2"/></svg>';


export const ICON_WB_FLOW =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4" width="5.4" height="5.4" rx="1.4"/><rect x="15.1" y="4" width="5.4" height="5.4" rx="1.4"/><rect x="9.3" y="14.6" width="5.4" height="5.4" rx="1.4"/><path d="M6.2 9.4v2.1h11.6V9.4M12 11.5v3.1"/></svg>';


/* 工作台「研发」区的两个内置入口（2026-10-26 用户：远程连接 / 代码托管放这儿更合适）。
   画法跟上面那批一致：线性 SVG，颜色由 .wb-ico 的渐变底给。 */
export const ICON_WB_CODE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m8.6 7.6-4.6 4.4 4.6 4.4M15.4 7.6l4.6 4.4-4.6 4.4M13.4 5.4l-2.8 13.2"/></svg>';


export const ICON_WB_SSH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4" width="17" height="7" rx="1.8"/><rect x="3.5" y="13" width="17" height="7" rx="1.8"/><path d="M6.8 7.5h.01M6.8 16.5h.01"/></svg>';



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
export let helpPop = null;

 // { btn, pop } —— 现在开着的那一个

export function closeHelpPop() {
  if (!helpPop) return;
  const { btn, pop } = helpPop;
  helpPop = null;
  pop.classList.add('is-hidden');
  btn.classList.remove('on');
  btn.setAttribute('aria-expanded', 'false');
}



export function wireHelpPop(btn, html) {
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
export let tipTimer = 0;


export let tipAnchor = null;

 // 现在这条提示挂在谁身上（同一个元素重复进入不重算）

export function hideTip() {
  clearTimeout(tipTimer);
  tipAnchor = null;
  const p = $('tipPop');
  if (!p) return;
  p.classList.remove('on');
  p.hidden = true;
}



export function showTip(el) {
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
 *     defaultFolded: ['本地分支'],             可折叠分组里默认收起的那些（按标题/foldKey）
 *     empty: '没有可选项',                     无匹配时的文案
 *     onChange: (id) => {},                    选中时回调
 *   });
 *   c.value() / c.setValue(id) / c.setItems(items) / c.close()
 *
 * 同时只允许开一个（点开第二个会把第一个收起）；点组件外面统一收起。
 */
export let openCombo = null;



export function createCombo({
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
  // 按钮上跟在文案后面的小角标（2026-10-27 分支 pill："main ↑"，箭头绿、不带数字）。
  // 给函数就按当前值现算（返回空串 = 不显示）；给字符串就是固定的。
  // 单独一个 span 是为了**上色**：buttonText 是纯文本，塞不进颜色。
  buttonBadge = null,
  // 按钮上文案**前面**的图标（SVG 字符串，2026-10-30 分支 pill："左边加图标，像是idea那样"）。
  // 可选；不传 = 跟以前一样没有图标。
  buttonIcon = null,
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
  // 哪些可折叠分组**默认收起**（按 header / folder 的 foldKey 名字，没 foldKey 就用标题文本）。
  // 给"一打开先看操作项，分支清单收着"这种场景用（2026-10-27 用户："本地、远程、标签改成默认折叠"）。
  // 只是**初始值**：用户点开之后就按他点的那份状态记（同一个实例内关了弹层再开还记着）。
  defaultFolded = [],
}) {
  const root = document.createElement('div');
  root.className = 'combo';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'combo-btn';
  const text = document.createElement('span');
  text.className = 'combo-text';
  const badge = document.createElement('span');
  badge.className = 'combo-btn-badge';
  badge.hidden = true;
  const chev = document.createElement('i');
  chev.className = 'combo-chev';
  btn.append(text, badge, chev);
  if (buttonIcon) {
    const ic = document.createElement('span');
    ic.className = 'combo-btn-ic';
    ic.innerHTML = buttonIcon;
    btn.prepend(ic);
  }

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
  // 可折叠分组的收起状态（按标题文本记，实例级：关了弹层再开还记着）。
  // 带 defaultFolded 的从"收起"开始（2026-10-27：分支弹窗的本地/远程/标签默认折叠）。
  const folded = new Set((defaultFolded ?? []).map(String));

  const labelOf = (id) => (all.find((it) => it.id === id) ?? {}).label ?? String(id ?? '');
  const shown = () =>
    buttonText ? buttonText(current) : labelOf(current) || String(current ?? '') || blank;
  /* 按钮文案 + 角标一起画（角标是上色的 span，buttonText 只给纯文本） */
  const paintButton = () => {
    text.textContent = shown();
    const b = String((typeof buttonBadge === 'function' ? buttonBadge(current) : buttonBadge) ?? '');
    badge.textContent = b;
    badge.hidden = !b;
  };

  const pick = (id) => {
    current = id;
    paintButton();
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
     * 搜索时留着会把结果切成一堆空标题，反而更难读。文件夹（`{ folder }`，分支树第二层）同理。
     */
    if (q) {
      hits = hits.filter((it) => it.header === undefined && it.folder === undefined);
    } else {
      /*
       * 可折叠分组（`{ header, foldable: true }`）与前缀文件夹（`{ folder }`，分支弹窗用）：
       * 点标题把该组收到下一个标题/文件夹前。折叠状态按 `foldKey ?? 标题/文件夹名` 记在实例上，
       * 关了弹层再开还记着。**搜索时一律当全展开** —— 搜索本来就把标题藏了，折叠着搜等于"搜到了却看不见"。
       */
      let hiding = false; // 组标题收起中：它管到下一个标题为止
      let folderHiding = false; // 当前文件夹收起中：只管**自己的叶子**（带 sub 的条目）
      hits = hits.filter((it) => {
        if (it.header !== undefined) {
          // 顶层分组标题：重置两层藏匿态 —— 它自己（foldable）决定后面到下一个标题前藏不藏
          hiding = !!it.foldable && folded.has(it.foldKey ?? it.header);
          folderHiding = false;
          return true;
        }
        // 父组收起中：文件夹和它的叶子一起藏（⚠️ 文件夹自己的开合只在父组展开时生效，
        // 不能在这儿用文件夹的状态覆盖父组的藏匿态 —— 2026-10-27 用户实报"本地/远程折不动"：
        // 组标题折了，下面的文件夹又立刻把藏匿态顶回去，看着就像没反应）
        if (hiding) return false;
        if (it.folder !== undefined) {
          // 文件夹行自己永远显示（它是开合开关）；它的藏匿态只管到**下一个文件夹/平级条目**为止
          // —— 2026-10-27 用户实报"点折叠会把下面的都折叠起来"：原来 hiding 一路带下去，
          // 折 bandi 连 feat、fix 和 main 全带走。叶子有 sub 标记，平级分支（main）没有，正好分工。
          folderHiding = folded.has(it.foldKey ?? it.folder);
          return true;
        }
        return it.sub ? !folderHiding : true;
      });
    }
    // hi 只数**可选项** —— 键盘上下不能停在标题/文件夹上（那是死路）
    const pickable = hits.filter((it) => it.header === undefined && it.folder === undefined);
    if (hi >= pickable.length) hi = Math.max(0, pickable.length - 1);

    let pi = -1;
    // 选中项用右侧的 ✓ 表示（不用底色，底色留给"键盘/鼠标当前停在哪一项"）
    list.innerHTML = hits.length
      ? hits
          .map((it) => {
            if (it.header !== undefined) {
              // 不带 foldable 的标题输出跟以前逐字相同（别的下拉不该有任何变化）
              if (!it.foldable) return `<div class="combo-group">${esc(it.header)}</div>`;
              const f = folded.has(it.foldKey ?? it.header);
              return `<div class="combo-group foldable${f ? ' is-folded' : ''}" data-fold="${esc(it.foldKey ?? it.header)}">${esc(it.header)}</div>`;
            }
            if (it.folder !== undefined) {
              const key = it.foldKey ?? it.folder;
              const f = folded.has(key);
              return `<div class="combo-group combo-sub foldable${f ? ' is-folded' : ''}" data-fold="${esc(key)}">${ICON_FOLDER}${esc(it.folder)}</div>`;
            }
            pi += 1;
            /*
             * 条目右侧信息（2026-10-27，IDEA 分支弹窗同款）：
             *   · `badge`（↗1/↙2）跟在名字后面 —— 分支领先/落后上游几个提交；
             *   · `hint`（origin/main）靠右、降灰 —— 这一行分支跟踪的是哪个远程分支；
             *   · `menu`（2026-10-30，IDEA 那种小箭头）—— 行尾一颗 `›`，点开是这条分支的二级菜单。
             * 都是可选的，别的下拉不传 = 跟以前逐字一样。
             */
            return `<div class="combo-item ${it.cls ?? ''} ${it.sub ? 'sub ' : ''}${pi === hi ? 'hi' : ''}" data-pick="${esc(it.id)}"${it.menu ? ' data-menu="1"' : ''}>
                 ${it.icon ? `<span class="combo-ic">${it.icon}</span>` : ''}
                 <span class="combo-item-label">${esc(it.label)}${it.badge ? `<span class="combo-badge">${esc(it.badge)}</span>` : ''}</span>
                 ${it.hint ? `<span class="combo-hint" title="${esc(it.hint)}">${esc(it.hint)}</span>` : ''}
                 ${it.id === current ? '<span class="combo-check">✓</span>' : ''}
                 ${it.menu ? '<button type="button" class="combo-more" aria-label="更多操作" title="这条分支的更多操作">›</button>' : ''}
               </div>`;
          })
          .join('')
      : `<div class="combo-empty">${esc(empty)}</div>`;
    /*
     * 带 menu 的行（分支行，2026-10-30 用户："点击选项就打开，改成二级窗口的一个选项，放在第一位"）：
     * 点**整行**都不再直接选中 —— 跟行尾 `›` 一样只开这条分支的二级菜单（签出收进菜单第一位）。
     * 没带 menu 的行（标签、别的下拉）照旧点行即选。
     */
    const fireItemMenu = (row) =>
      root.dispatchEvent(new CustomEvent('combo-menu', { detail: { id: row.dataset.pick ?? '', el: row } }));
    list.querySelectorAll('[data-pick]').forEach((el) => {
      el.onclick = () => (el.dataset.menu ? fireItemMenu(el) : pick(el.dataset.pick));
    });
    /* 行尾 `›`：开二级菜单（stopPropagation 掉"选中"；现在整行都开菜单，它只是个显眼的抓手） */
    list.querySelectorAll('.combo-more').forEach((b) => {
      b.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const item = b.closest('.combo-item');
        if (item) fireItemMenu(item);
      });
    });
    list.querySelectorAll('[data-fold]').forEach((el) => {
      el.onclick = () => {
        const k = el.dataset.fold;
        folded.has(k) ? folded.delete(k) : folded.add(k);
        paint(input ? input.value : '');
      };
    });
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
    /*
     * 竖向**自动翻转**（2026-10-24 用户报：项目详情那颗负责人下拉在页面下半截，
     * 往下开整个探出视口底）。往下放不下、且上方空间更大 → 根节点挂 `.up`
     * （样式 `.combo.up .combo-pop` 早就有；聊天输入区那几颗是手动挂的 —— 它们钉死在
     * 屏幕底部，挂一次就够。页面中间的下拉跟着滚动变，挂一次管不住，只能每次打开现算）。
     *
     * ⚠️ 量之前先把 `.up` **摘掉**、按默认（向下）摆好 —— 拿着上一次的方向量会来回荡：
     *    第一次向上关掉后 `.up` 还在，第二次打开弹层先摆在了上面，一量"下面空间足够"
     *    又翻回向下，第三次再翻上去（2026-10-24 用户实报"点一下往上再点一下向下"）。
     *    摘类 → 量 → 定方向都在同一次同步布局里完成，画不出来中间帧。
     */
    root.classList.remove('up');
    {
      const pr = pop.getBoundingClientRect();
      const rr = root.getBoundingClientRect();
      root.classList.toggle(
        'up',
        pr.bottom > window.innerHeight - 8 && rr.top > window.innerHeight - rr.bottom,
      );
    }
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
        if (!hit) return;
        // 带菜单的行（分支行）回车同样开二级菜单，跟点行一致
        if (hit.dataset.menu) {
          hit.scrollIntoView({ block: 'nearest' });
          fireItemMenu(hit);
        } else pick(hit.dataset.pick);
      }
    });
  }

  const api = {
    el: root,
    value: () => current,
    setValue(id) { current = id; paintButton(); },
    setItems(next, keepValue = true) {
      all = next;
      if (!keepValue) current = '';
      paintButton();
      if (!pop.classList.contains('is-hidden')) paint(input ? input.value : '');
    },
    close,
  };
  paintButton();
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
/* -------------------------------------------------------- 列表项右键菜单 */

/**
 * 打开右键菜单（单例 `#ctxMenu`，挂在 body 下、`position:fixed` 跟光标走）。
 *
 * 2026-10-30 从 listmenu.mjs 挪到这儿：分支下拉也要用它，而 skills ↔ listmenu
 * 走的是同一个模块环（skills → contacts → listmenu → skills），环路里再挂一次导入不值得 ——
 * 这个组件本来就不认"会话域"，它只认"给我一组 items"。listmenu 继续 re-export，老调用点不动。
 *
 * @param {number} x 视口坐标（事件里的 clientX）
 * @param {number} y 视口坐标（事件里的 clientY）
 * @param {Array<{label: string, danger?: boolean, disabled?: boolean, why?: string, run: Function}>} items
 */
export function openCtxMenu(x, y, items) {
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
  menu.querySelectorAll('.ctx-item').forEach((btn) => {
    btn.onclick = async () => {
      const it = items[Number(btn.dataset.idx)];
      if (!it || it.disabled) return;
      closeCtxMenu();
      try {
        await it.run();
      } catch (err) {
        toast(String(err?.message ?? err), 'error');
      }
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
  // 焦点落到第一个**可用**项：键盘能直接上下选，Enter/Space 由 <button> 原生负责
  menu.querySelector('.ctx-item:not([disabled])')?.focus();
}

/** 收起右键菜单。可以随便多调 —— 已经收起时直接返回（滚动/失焦/重画都会调到它） */
export function closeCtxMenu() {
  const menu = $('ctxMenu');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  menu.innerHTML = '';
}

export function createDateTimePick({ mount, value = '', onChange = () => {} }) {
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


/** 跑着的时候，顶部不显示枚举值「跑中」，显示成人话 */
export const TYPING = '对方正在输入…';



export function setHeaderBadge(status, label) {
  const el = $('chatHead').querySelector('.badge');
  if (!el) return;
  el.className = 'badge ' + status;
  el.textContent = label ?? status;
}



/**
 * 极简 Markdown 渲染（零依赖）。
 * 顺序很重要：**先整段转义**，再在已转义文本上做变换 —— 这样注入的 HTML 活不下来。
 * 支持：围栏代码块、标题、粗体/斜体、行内代码、链接（只放 http/https）、
 *       有序/无序列表、引用、分割线、GFM 表格。
 */
export function renderMarkdown(src) {
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

  /*
   * GFM 表格（2026-10-23）：员工回活爱用表格汇报（| a | b | 加一行 |---| 分隔行），
   * 不渲染就是一屏竖线。判定要 lookahead 下一行是不是分隔行，所以表格分支放在最前；
   * 行内 \| 是转义竖线，拆单元格前先换成占位符，拆完换回来。
   */
  const ls = s.split('\n');
  const isRow = (l) => /^\|.*\|$/.test(l);
  const isSep = (l) => /^\|[\s:|-]+\|$/.test(l) && l.includes('-');
  const splitRow = (l) => l
    .replace(/\\\|/g, '\u0001')
    .replace(/^\|/, '').replace(/\|$/, '')
    .split('|')
    .map((c) => inline(c.trim().replace(/\u0001/g, '|')));

  const out = [];
  let list = null;
  let para = [];
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join('<br>'))}</p>`); para = []; } };

  for (let i = 0; i < ls.length; i++) {
    const t = ls[i].trim();

    if (/^\u0000\d+\u0000$/.test(t)) { flushPara(); closeList(); out.push(t); continue; }
    if (!t) {
      flushPara();
      /* 松散列表（条目间夹空行，GFM 合法）：往下找到下一条非空行，还是同类列表项就
         别把列表合上 —— 合上就成了每项一个 <ol>/<ul>，有序列表序号全从 1 起
         （专家岗位说明实测三条要点全渲染成 "1."）。非同类（段落/别的块）才正常收口。 */
      let j = i + 1;
      while (j < ls.length && !ls[j].trim()) j++;
      const nx = ls[j]?.trim() ?? '';
      const nxKind = /^[-*+]\s+/.test(nx) ? 'ul' : /^\d+[.)]\s+/.test(nx) ? 'ol' : null;
      if (!list || nxKind !== list) closeList();
      continue;
    }

    if (isRow(t) && i + 1 < ls.length && isSep(ls[i + 1].trim())) {
      flushPara(); closeList();
      const ths = splitRow(t);
      i += 2; // 跳过表头行与分隔行
      const rows = [];
      while (i < ls.length && isRow(ls[i].trim())) { rows.push(splitRow(ls[i].trim())); i++; }
      i -= 1; // 外层 for 还会 ++，回退一条
      out.push('<table class="md-t"><thead><tr>' + ths.map((c) => `<th>${c}</th>`).join('') + '</tr></thead><tbody>'
        + rows.map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }

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


export const initial = (s) => (String(s || '?').trim()[0] || '?').toUpperCase();



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
export const CLI_BRANDS = {
  codex:  { svg: '<path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/>' },
  claude: { svg: '<path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/>' },
  dsh:    { svg: '<path d="M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45"/>' },
  magpie: { svg: '<path fill-rule="evenodd" d="M15.7 4.1a3.3 3.3 0 0 0-3.25 2.77c-2.2.55-4.05 2-5.2 4.02-.9 1.58-2.2 2.95-3.8 4.03-.52.35-.95 1-1.15 1.72-.14.53.4 1 .9.79 2.05-.8 3.5-.5 4.75.3 1.45.93 3.02 1.31 4.75.94 3.55-.78 5.95-3.85 5.95-7.55v-1.4l2.05-.92c.58-.26.6-1.08.03-1.37l-2.28-1.1A3.3 3.3 0 0 0 15.7 4.1Zm.85 2.3a1.05 1.05 0 1 1 0 2.1 1.05 1.05 0 0 1 0-2.1Z"/>' },
};



/** 运行时 / 外部件那一行的图标：kind 是协议族 id（runtimes.mjs 的 FAMILIES）或外部件 id（externals.mjs 的 EXTERNALS）；
    认不出的退回首字母块 —— 后面新加 CLI 时先把 id 登记进 CLI_BRANDS，界面就自动带图标。 */
export function cliAvatar(kind, label) {
  const b = CLI_BRANDS[kind];
  if (!b) return `<div class="avatar cli">${esc(initial(label))}</div>`;
  return `<div class="avatar cli" data-brand="${esc(kind)}" title="${esc(label ?? '')}"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${b.svg}</svg></div>`;
}



/**
 * 头像的内联配色（2026-10-19）。
 *
 * 为什么不再"所有人同一个灰"：同类产品的注释头像会用一小组固定的低饱和色按人分配。
 * 一开始我把它统一成 `--chip` 灰底，截图一看通讯录里 7 行头像**全一样**，
 * 眼睛完全没有落点、认人只能逐行读字 —— 这是把克制做成了"无信息"。
 *
 * 做法：一组**低饱和**色相（不是高饱和的彩色圆），按名字哈希稳定分配 ——
 * 同一个人永远同色，换机器/刷新也不变（跟工作台磁贴的"顺序发色"不同：
 * 人是有稳定身份的，颜色跟着人走才对）。
 * 明度取 26%：白字压上去 ≥ 4.5（这批色相里最亮的那个也过线）。
 */
export const AV_HUES = [210, 262, 190, 330, 292, 172, 240, 315];


export function avatarStyle(name) {
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
export const AV_TONES = [1, 2, 3, 4];


export function smAvatar(name, extra = '', persona = null) {
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
export const AVATAR_FILE = /^[A-Za-z0-9._-]+\.(png|jpe?g|webp)$/i;


/** 按名字找员工（消息气泡/评论这些只有名字的场景）：找不到返回 null，走字母头像 */
export function personaByName(n) {
  const s = String(n ?? '');
  return S.personas.find((p) => p.name === s) ?? null;
}


export function personaAvatar(p, extra = '', fallbackName = '') {
  const name = p?.name ?? fallbackName ?? '?';
  const file = p?.avatar;
  const core = `<div class="avatar${extra ? ' ' + extra : ''}" ${avatarStyle(name)}>${esc(initial(name))}`;
  if (file && AVATAR_FILE.test(String(file))) {
    return `${core}<img class="av-img" src="/avatars/${encodeURIComponent(String(file))}" alt="" onerror="this.remove()"></div>`;
  }
  return `${core}</div>`;
}


export const hhmm = (iso) => { try { return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };


export const dt = (iso) => { try { return new Date(iso).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } }; // 带年（2026-10-24 用户：运行记录只有月日看不出跨年）


export const cut = (s, n = 34) => (String(s ?? '').replace(/\s+/g, ' ').slice(0, n));



/**
 * 服务端说明压成界面上能看的一行：合并空白、超长截断（带省略号）。
 *
 * 为什么不直接用 `cut`：那个按"列表预览"设计的（34 字、不带省略号），
 * 错误原因往往是一整句（「别名要用汉字、字母或数字开头，可以带点…」），34 字会把关键处切掉。
 * 160 字 ≈ toast 里三行的量，再长就该去控制台看了。
 */
export const clipLine = (s, n = 160) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};



/**
 * 纯文本场景（列表预览这类）把 Markdown 标记去掉 —— 那儿不渲染 HTML，
 * 留着 ** 和反引号就是露给用户看的原始符号。
 */
export const plain = (s) =>
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



export async function api(path, opts) {
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


export const post = (p, d) => api(p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d ?? {}),
});



/**
 * 把文本复制进剪贴板：优先用异步 Clipboard API，不行就退回隐藏 textarea + execCommand。
 * 只返回 true/false —— 成功之后怎么回执是调用方的事。
 */
export async function copyPlainText(text) {
  const s = String(text ?? '');
  if (!s) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch { /* 权限被拒 / 非安全上下文 —— 走下面的兜底 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, s.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * 把页面里的 `[data-path]` 接上「整颗可点复制」。
 * 为什么抽到这里：项目详情现在要用，以后员工、仓库大概率也要（都是"这串路径拿去用"）——
 * 各写一遍必然跑偏。用 `data-path` 不用 class：class 是长相，data 是行为。
 *
 * 回执直接换按钮上的字（设计稿 v1.0.1：成功显示「已复制」，2 秒后还原），
 * 同时置 `aria-pressed` —— 读屏和样式（成功态变绿）都认它。
 * ⚠️ 原文案从 `data-label` 取，取不到才用 textContent：重进详情页时按钮可能还停在
 *    「已复制」上（DOM 留着的），用 data-label 记一次原文就不会把「已复制」当原文存下来。
 */
export function handleCopyPaths(root = document) {
  root.querySelectorAll('[data-path]').forEach((el) => {
    if (el.dataset.copyWired) return; // 同一颗按钮别包两遍（会叠加 setTimeout）
    el.dataset.copyWired = '1';
    const path = el.dataset.path || '';
    const label = el.dataset.label || el.textContent;
    let timer = 0;
    const done = (ok) => {
      if (!ok) { toast('复制不了，手动选中吧：\n\n' + path); return; }
      el.textContent = '已复制';
      el.setAttribute('aria-pressed', 'true');
      clearTimeout(timer);
      timer = setTimeout(() => {
        el.textContent = label;
        el.removeAttribute('aria-pressed');
      }, 2000);
    };
    el.addEventListener('click', async () => { done(await copyPlainText(path)); });
  });
}

/**
 * 把一次失败写进某个**常驻**的元素（提示行、结果框那种，不是弹窗）。
 *
 * `err.message` 现在自带原因（4xx 是服务端原文，5xx 只有「服务异常」），直接印就行。
 * `title` 只在**原因没进正文**（5xx / 网络层）时补一句原文 —— 4xx 已经在正文里，重复给悬停没意义。
 * （弹窗那种一闪而过的提示用 `toast(err.message, 'error')` 就够，控制台里也有全文。）
 */
export function showFail(el, err) {
  if (!el) return;
  el.textContent = err?.message ?? '服务异常';
  el.title = err?.explained ? '' : (err?.detail || '');
}



/** 同 `showFail`，但要拼进 HTML 的那种（页面级失败的整块提示） */
export const failHtml = (err) =>
  `<span title="${esc(err?.explained ? '' : (err?.detail || ''))}">${esc(err?.message ?? '服务异常')}</span>`;
