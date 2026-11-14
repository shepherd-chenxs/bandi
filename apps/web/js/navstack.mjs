/* navstack.mjs —— 「现在这一屏，上一层是谁、怎么上去」的唯一真源（2026-11-11）。
 *
 * 为什么要有它（用户实报「定时任务页按返回直接退出 APP」）：
 *   壳的返回键原先问 WebView `canGoBack()` —— 那是**浏览器的历史**，不是 App 的层级。
 *   换机器时壳会 `clearHistory()`（把网页开机在 boot 时种的那格「井」一起抹掉），
 *   从此 canGoBack 恒 false，任何页面按返回都退后台；反过来，有些页面压根不压格，
 *   按返回就是"没反应"。历史还是**共享状态**：reload / 重定向 / SW 换版都会让它跟
 *   画面对不上，为此已经打了七八处"幽灵格"补丁（mbDetail / kbNew / schPage /
 *   tcCard / mbMeSet / picker…），每加一个新页面都得记得再打一处。
 *
 * 现在壳不猜了，直接问网页：`bandiCanGoUp()` / `bandiBack()`（mobile.mjs 挂到 window）。
 * 每一层由**它的主人**登记（谁的状态谁报，不复制第二份真相）：
 *
 *   registerLayer({ name, level, cell, active, close })
 *     level 越大越靠内（先被收）；cell = 它压在自己那格历史里的标记 —— 当前这格正是
 *     它压的就先退历史（各模块的 popstate 会跟着收画面，视觉态与历史一起收，不留幽灵格），
 *     没有格（换机器清过历史）就直接调 close 收画面。
 *   registerUp(view, fn)
 *     下钻页的上一层 —— 必须**与页内那颗 ‹ 是同一个动作**（同一个函数引用，别抄一遍）。
 *   一级栏的非首页 tab（通讯录 / 会话 / 我的…）按返回先回「工作台」，不是退 App：
 *     registerHomeUp('plugins', () => setNav('plugins'))
 *
 * 判断顺序：栈顶浮层 → 下钻页的上一层 → 非首页 tab 回家 → 交还壳（退后台）。
 * 最后一档是 Android 的标准语义：根页按返回 = 退到桌面，而不是被吞掉做成"按了没反应"。
 */
import { S } from './core.mjs';

const layers = [];
const ups = new Map();
let homeNav = '';
let homeUp = null;

/** 登记一层浮层 / 子页。level 越大越靠内；cell 是它在历史里的标记（可省）。 */
export function registerLayer(def) {
  if (!def?.active) return;
  layers.push(def);
  layers.sort((a, b) => (b.level ?? 0) - (a.level ?? 0));
}

/** 登记下钻页的上一层（与页内 ‹ 同一个函数）。 */
export function registerUp(view, fn) {
  if (view && typeof fn === 'function') ups.set(view, fn);
}

/** 一级栏的「家」：非首页 tab 按返回先回它。 */
export function registerHomeUp(nav, fn) {
  if (nav && typeof fn === 'function') { homeNav = nav; homeUp = fn; }
}

/** 当前在哪个页面（route 比 nav 具体；两者都没有时按 nav 兜底）。 */
function curView() {
  return S.route?.view ?? S.nav;
}

/** 栈顶那一层（没有浮层 / 子页开着就是 null）。 */
export function topLayer() {
  for (const l of layers) {
    try {
      if (l.active()) return l;
    } catch { /* 状态坏了就当它没开 —— 别让一层抛错卡死整条返回链 */ }
  }
  return null;
}

/** 还有上一层吗（壳问的就是这一句）。 */
export function canGoUp() {
  if (topLayer()) return true;
  if (ups.has(curView())) return true;
  return !!(homeUp && S.nav !== homeNav);
}

/** 上一层的名字（日志 / 排查用）。 */
export function upName() {
  const l = topLayer();
  if (l) return l.name || 'layer';
  if (ups.has(curView())) return curView();
  if (homeUp && S.nav !== homeNav) return homeNav;
  return '';
}

/** 退一层。返回 true = 退成功了；false = 已经在根页（交还壳）。 */
export function back() {
  const l = topLayer();
  if (l) {
    if (l.cell && history.length > 1 && history.state?.[l.cell]) {
      history.back();
      return true;
    }
    try { l.close?.(); } catch { /* 收不掉也别把人卡在这儿 */ }
    return true;
  }
  const up = ups.get(curView());
  if (up) { up(); return true; }
  if (homeUp && S.nav !== homeNav) { homeUp(); return true; }
  return false;
}
