/* shell.mjs —— 主题、记住"上次停在哪"、路由。
 * 2026-10-22 由 app.js（15537 行单文件）拆出，原生 ESM、无打包器；逻辑逐字搬运。 */
import { setNav } from './state.mjs';
import { openSettings } from './settings.mjs';
import { openWorkflows } from './workflows.mjs';
import { openProjectDetail, openProjectsPage, openTaskBoard, openTaskCardPage } from './projects.mjs';
import { openDesigner, openFlowRun } from './flowpages.mjs';
import { openSchedules, openSkill } from './skills.mjs';
import { openConversation, openDetail } from './chat.mjs';
import { openGroupDetail } from './groups.mjs';
import { openExperts, openPlugins, renderPluginPanel } from './experts.mjs';
import { S } from './core.mjs';



/* ---------------------------------------------------------------- 主题 */

export const THEME_KEY = 'bandi.theme';


/**
 * 通讯录分段的折叠状态（跟主题一样记住）。
 * 默认：**群聊收起、数字员工展开** —— 日常主要是找人说话，群是少数。
 * 键名带 v2：改默认值时要让新默认生效一次，否则老浏览器里存着的旧状态会盖住它。
 */
export const SEC_KEY = 'bandi.contactsCollapsed.v2';


export const SEC_DEFAULT = { group: true, person: false };


export function readCollapsed() {
  try {
    const saved = JSON.parse(localStorage.getItem(SEC_KEY) || 'null');
    if (saved && typeof saved === 'object') return saved;
  } catch { /* 读不了就用默认 */ }
  return { ...SEC_DEFAULT };
}


export function saveCollapsed() {
  try { localStorage.setItem(SEC_KEY, JSON.stringify(S.secCollapsed ?? {})); } catch { /* 写不了就算了 */ }
}


export const prefersLight = () => window.matchMedia('(prefers-color-scheme: light)').matches;



/* ------------------------------------------------------ 记住"上次停在哪" */

/**
 * 刷新后回到原来的位置。
 *
 * 原来启动时写死 `setNav('messages')` —— 在哪个页面按 F5 都会被弹回消息页，
 * 在插件里改一半配置、刷新一下就找不着了。
 * 存的是**能重建位置的标识**（会话 id、技能名、插件 id + 选中行），不是 DOM 快照。
 */
export const PLACE_KEY = 'bandi.place';



/**
 * 记下"我在哪儿"。
 *
 * **只存一个 route**（2026-10-17 统一路由）：以前是逐字段手写（nav / conversation / skill / plugin /
 * project / taskBoard / taskCard / designer / flowMode / flowRun…），每加一个页面都要回来加一行，
 * 忘了就刷新掉回消息页。现在只有一份 —— 加页面不用再动这个函数。
 *
 * 跟页面无关的界面状态（看板筛选）另存：它不是"位置"，但刷新后也该保持。
 */
export function savePlace() {
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



export function readPlace() {
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
export const ROUTES = {
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
  taskCard: ({ id, fromAll, fromFlow, fromConv } = {}) => {
    setNav('plugins', { skipOpen: true });
    // fromFlow：这张卡是从流程的某一步点进来的（`{ runId, taskId, runTitle, nodeName }`）。
    // 只用来在页头写清"你从哪来" —— 卡本身不因为来路不同而长得不一样（见 openTaskCardPage）。
    // fromConv（2026-10-24）：从聊天气泡的卡票点进来的那场会话 —— 离开卡页回它。
    return openTaskCardPage(id, { fromAll, fromFlow, fromConv });
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
export function openRoute(route) {
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
export function setRoute(view, params = {}) {
  // 页面级组件（比如任务卡的评论输入框）挂在 document 上的监听，在这时候摘：
  // 页面随时重建，不摘就会一层层堆起来。没有登记的就什么都不做。
  for (const fn of window.__pageCleanups ?? []) { try { fn(); } catch { /* 摘不掉也不影响渲染 */ } }
  window.__pageCleanups = [];
  S.route = { view, ...params };
  savePlace();
}



/** 启动时回到上次的位置。**回不去就退回消息页**——
 * 会话可能被移除、技能被删、插件被卸，存着的位置不一定还在。 */
export async function restorePlace() {
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
export function applyTheme() {
  const resolved = S.theme === 'system' ? (prefersLight() ? 'light' : 'dark') : S.theme;
  document.documentElement.dataset.theme = resolved;
  try {
    const win = window.__TAURI__?.window?.getCurrentWindow?.();
    win?.setTheme?.(S.theme === 'system' ? null : resolved);
  } catch { /* 浏览器里没有 __TAURI__；壳被旧版 exe 带着跑时 IPC 可能没开 —— 都不影响网页本身 */ }
}



export function setTheme(theme) {
  S.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* 隐私模式下写不了就算了 */ }
  applyTheme();
  openSettings('prefs');
}



export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));



/**
 * 轻量 markdown 渲染（2026-10-21，员工详情「职责与身份设定」预览用，站内可复用）。
 *
 * 防注入口径：**先对原文整体 esc 再解析标记** —— 生成的所有标签都是自己拼的，
 * 原文里夹带的 <script> 之类已变成字面量，不存在绕路的口子。
 * 支持子集：围栏代码块、行内代码、标题（#~####）、无序/有序列表（含**松散列表**：项间空行
 * 仍接着编号；含**缩进续行**：列表项第二行顶格缩进，归上一项）、引用、加粗、斜体、
 * **GFM 表格**（2026-10-23：员工回活爱用表格汇报，不渲染就是一屏竖线）。
 * 不认识的东西原样显示：不报错、不吞字（写人设/职责说明够用，不求全）。
 */
export const mdRender = (src) => {
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
  // 表格行：内容里 \| 是转义的竖线（GFM），拆单元格前先换成占位符，拆完换回来
  const splitRow = (l) => l
    .replace(/\\\|/g, '\u0001')
    .replace(/^\|/, '').replace(/\|$/, '')
    .split('|')
    .map((c) => inline(c.trim().replace(/\u0001/g, '|')));
  const isRow = (l) => /^\|.*\|$/.test(l);
  const isSep = (l) => /^\|[\s:|-]+\|$/.test(l) && l.includes('-');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (code !== null) {                       // 围栏内：原样收（已 esc 过），直到闭合
      if (/^```/.test(raw.trim())) { out.push(`<pre><code>${code.join('\n')}</code></pre>`); code = null; }
      else code.push(raw);
      continue;
    }
    const line = raw.trim();
    // 表格（2026-10-23）：当前行是 |…| 且下一行是 |---|---| 分隔行 → 整表收进来。
    // 判定带 lookahead（要看下一行），所以放在最前面；收完把 i 拨到表尾。
    if (isRow(line) && i + 1 < lines.length && isSep(lines[i + 1].trim())) {
      flushAll();
      const ths = splitRow(line);
      i += 2; // 跳过表头行与分隔行
      const rows = [];
      while (i < lines.length && isRow(lines[i].trim())) { rows.push(splitRow(lines[i].trim())); i++; }
      i -= 1; // 外层 for 还会 ++，回退一条
      out.push('<table class="md-t"><thead><tr>' + ths.map((c) => `<th>${c}</th>`).join('') + '</tr></thead><tbody>'
        + rows.map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }
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
export const TOAST_KEEP = { error: 5000, ok: 2600, info: 3500 };


export function toast(msg, kind = 'info') {
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
export const ROLE_SUGGEST = ['产品', '研发', '测试', '运维', '架构', '设计', '项目'];



/** 人员下拉里的标签（2026-10-23 用户拍板）：`李俊（产品经理）` —— 姓名在前，括号里只留岗位。
 *  岗位字段本身是「岗位 · 职责」两段（如「产品经理 · 理需求与写文档」），职责不上标签；
 *  没岗位的人只有名字。 */
export const personLabel = (p) => {
  const role = String(p.role ?? '').split(' · ')[0].trim();
  return role ? `${p.name}（${role}）` : p.name;
};



/** 通讯录那一行的副标题：只显示岗位（sandbox/运行时是技术细节，只在详情页看） */
// 2026-10-23 用户拍板：运行时 id（rt-xxx）对人没有意义，不再上列表；
// 没岗位的人退回「自动」——只保留这一个人类能读懂的运行时值，其余一律不显示
export const personSubtitle = (p) => {
  if (p.role) return String(p.role);
  return p.runtime === 'auto' ? '自动' : '';
};

/** 列表里单独摆一格「运行时」时的文案（项目成员 tab，2026-10-24）：
 *  口径跟 personSubtitle 后半截是同一条 —— **只有 auto 能上列表**，显示「自动」；
 *  其余一律返回空串，调用方就不摆那一格（rt-id / codex / claude 都是技术细节）。 */
export const runtimeLabel = (p) => (p?.runtime === 'auto' ? '自动' : '');
