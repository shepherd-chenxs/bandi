/*
 * 「标题旁的 ?」弹出层的离线自检（2026-10-17）。
 *
 * 前端是没有构建步骤的原生 JS（apps/web/app.js 一个文件），CI 只过 node --check。
 * 这个脚本用最小 DOM 替身把 wireHelpPop 跑一遍，钉住"点开 / 再点收 / 点别处收 / Esc 收"
 * 这四条 —— 全是靠 document 上的监听实现的，很容易在重绘或改监听器时悄悄坏掉。
 *
 * 跑：node tools/smoke-help-pop.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webJs = path.join(repo, 'apps', 'web', 'js');
const src = ['../app.mjs', 'ui.mjs', 'skills.mjs', ...fs.readdirSync(webJs).filter((f) => f.endsWith('.mjs') && f !== 'ui.mjs' && f !== 'skills.mjs')]
  .map((f) => fs.readFileSync(path.join(webJs, f), 'utf8')).join('\n'); // 2026-10-22 拆 ESM：扫全部前端模块 + 入口（boot 语句都在入口）

let bad = 0;
let n = 0;
const check = (ok, msg) => {
  console.log(`${ok ? '✓' : '✗'} ${msg}`);
  n++;
  if (!ok) bad++;
};

/* ---------------------------------------------------- 源码层面：公共件得存在 */
check(/const ICON_HELP\s*=/.test(src), '有 ICON_HELP 图标常量');
check(/function wireHelpPop\(/.test(src), '有 wireHelpPop() 公共件');
check(/function closeHelpPop\(\)/.test(src), '有 closeHelpPop() 收起函数');
check(/const GIT_TOKEN_HELP\s*=/.test(src), '「怎么拿令牌」抽成了 GIT_TOKEN_HELP 常量');
// 同一份措辞**只挂一处**（2026-10-17 定的）：只在「?」里，不在输入框下面再贴一份。
// 两处都贴过 —— 等于同一段话在页面上出现两次，而且连上之后表单没了、只剩「?」，
// 反而显得那份多余。这里钉住"表单下面不再有它"。
const usesInTpl = (src.match(/class="counter left">\$\{GIT_TOKEN_HELP\}/g) ?? []).length;
const usesAsArg = (src.match(/wireHelpPop\([^)]*GIT_TOKEN_HELP/g) ?? []).length;
check(usesInTpl === 0, '令牌输入框下面不再贴同一段说明');
check(usesAsArg === 1, '「?」弹出层用的是这份 GIT_TOKEN_HELP');
// 这一条原来用 `class="row-with-btn">…id="gitConnect"…` 整段正则匹配 —— 2026-10-23 令牌表单
// 换成 .gr-conn 后那段 row-with-btn 最先出现在**手动接入弹窗**里，正则从那儿一路吃到 gitConnect，
// 跨了 4 万多字符，等于什么都没钉住。改到下面 tokenForm 块内按"输入框 + 按钮各一个"来数。
// 「?」要挂在 GitHub 连接那个标题上，不是别的分组
check(
  /class="group-title">GitHub 连接<button[^>]*id="gitTokenHelp"/.test(src),
  '帮助图标挂在「GitHub 连接」标题上',
);
// 连上之后表单没了，标题还在 —— 所以「?」的挂载不能在 if (st.connected) 分支里
check(/if \(helpBtn\) wireHelpPop\(helpBtn, GIT_TOKEN_HELP\);/.test(src), 'renderGitRepos 里挂上了「?」');
check(/document\.addEventListener\('click', closeHelpPop\)/.test(src), 'document 上装了"点别处收起"');

/* ------------------------------- 连上之后：同一行、只换"能不能编辑"和按钮文案 */
// 用户说的是"连接之后这个区域的变化不要太大" —— 所以两个状态必须是**同一个骨架**，
// 不许再换成「状态：已连接 + 断开连接」那种另一套行。
// 2026-10-23 改居中紧凑簇：骨架从「form-row top + row-label 块」换成
// `.gr-conn > .gr-conn-row > [标签 | 输入框 | 按钮]`，两个状态仍然共用同一套。
const formRe = /const (tokenForm|connectedForm) = `\s*<div class="gr-conn">\s*<div class="gr-conn-row">\s*<span class="row-label">令牌<\/span>/g;
const sameShape = [...src.matchAll(formRe)].map((m) => m[1]);
check(sameShape.length === 2, `两个状态都是「令牌」那一行（实际 ${sameShape.join('、') || '没有'}）`);

const block = (name) => {
  const i = src.indexOf(`const ${name} = \``);
  return src.slice(i, src.indexOf('`;', i));
};
const conn = block('connectedForm');
check(/<input[^>]*readonly/.test(conn), '连上后输入框是只读的');
check(/<input[^>]*class="locked"/.test(conn), '只读框带 .locked（看得见、点得出来不能改）');
check(/id="gitDisconnect"/.test(conn), '按钮换成「断开连接」');
// 状态行是同一条 .gr-conn-row 的第 2 列（grid-column: 2），压着输入框正下方居中。
check(
  /<div class="gr-conn-status"><b style="color:var\(--ok\)">已连接<\/b>/.test(conn),
  '「已连接」状态写在输入框下面',
);
// 只读框里放的是后 4 位，不是令牌本身
check(/value="\$\{esc\(st\.hint/.test(conn), '只读框里只回显后 4 位（st.hint）');
check(!/type="password"/.test(conn), '连上后不再是密码框（已存的那个不靠它藏）');

const unconn = block('tokenForm');
check(/id="gitToken"[^>]*type="password"/.test(unconn), '没连上时还是可填的密码框');
// 输入框的提示语别再写"只显示后 4 位" —— 现在是头 2 + ****** + 尾 4
check(/placeholder="[^"]*掩码/.test(unconn), '输入框提示语跟着改成"只显示掩码"');
check(!/后 4 位/.test(unconn), '输入框提示里不再写"后 4 位"（已过时）');
check(/id="gitConnect"/.test(unconn), '没连上时按钮是「连接 GitHub」');
check(!/class="counter/.test(unconn), '没连上时输入框下面没有多余说明（那段在「?」里）');
// 令牌表单只剩「令牌标签 + 输入框 + 连接按钮」（原先在页面级靠 row-with-btn 正则钉住，
// 拆成 .gr-conn 后那条正则实际会跨块误匹配，挪到这里按块内计数）。
check((unconn.match(/<input/g) ?? []).length === 1 && (unconn.match(/<button/g) ?? []).length === 1,
  '令牌表单只有输入框 + 连接按钮（各一个，没有多余控件）');
check((conn.match(/<input/g) ?? []).length === 1 && (conn.match(/<button/g) ?? []).length === 1,
  '已连接态同样只有输入框 + 按钮（各一个）');

/* ---------------------------------- 加仓库：一个入口「＋ 添加仓库」→ 菜单 → 弹窗 */
// 2026-10-17：原来是「＋ 手动接入」在标题上 + 页面底部常驻一整块「从 GitHub 添加」。
// 现在两条路都收进一个菜单，页面只剩一张清单。
check(/id="gitAddRepo"[^>]*>\s*＋ 添加仓库/.test(src), '清单标题上的按钮是「＋ 添加仓库」');
check(!/id="gitManualAdd"/.test(src), '不再有单独的「手动接入」按钮');
check(/const gitAddRepoItems = /.test(src), '有「从 GitHub 添加 / 手动接入」两个菜单项');
// 菜单两项都要开弹窗，不能还是直接跳页面上的某一块
const menuBlock = (() => {
  const i = src.indexOf('const gitAddRepoItems =');
  return src.slice(i, src.indexOf('];', i));
})();
check(/label: '从 GitHub 添加'/.test(menuBlock), '菜单里有「从 GitHub 添加」');
check(/label: '手动接入'/.test(menuBlock), '菜单里有「手动接入」');
check(/run: \(\) => openGitPickDialog\(/.test(menuBlock), '「从 GitHub 添加」→ 开弹窗');
check(/run: \(\) => openGitManualDialog\(/.test(menuBlock), '「手动接入」→ 开弹窗');
check(/function openGitPickDialog\(/.test(src), '有 openGitPickDialog（从 GitHub 挑）');
check(/async function mountGitAvailPicker\(/.test(src), '挑仓库那段抽成了可复用的 mountGitAvailPicker');
// 底部那整块要真的没了（不再挂在 st.connected 上常驻）
check(
  !/\$\{[\s\S]{0,80}st\.connected[\s\S]{0,400}?group-title">从 GitHub 添加/.test(src),
  '页面底部不再常驻「从 GitHub 添加」那一块',
);
// 徽标顺序：私有 → 只读/可写 → 已接入（2026-10-17「已接入」从右侧挪到「可写」后面）。
// 三个状态徽标排在一起才读得出来是同一类信息；放右边那颗「接入」按钮的位置上，
// 会被当成"一个动作的结果"，而且跟按钮互斥地占同一个格子。
const pickBlock = (() => {
  const i = src.indexOf('async function mountGitAvailPicker(');
  return src.slice(i, src.indexOf('\n}', i));
})();
const at = (s, re) => s.search(re);
const pPrivate = at(pickBlock, /私有<\/span>/);
const pWrite = at(pickBlock, /只读<\/span>|可写<\/span>/);
const pAdded = at(pickBlock, /已接入<\/span>/);
check(pPrivate >= 0 && pPrivate < pWrite, '「私有」排在「只读/可写」前面');
check(pWrite >= 0 && pWrite < pAdded, '「已接入」排在「只读/可写」后面');
check(!/sk-desc[\s\S]{0,120}已接入/.test(pickBlock), '「已接入」不再混在描述那一行里');
// 行是**选中**、不是"点了就接"：不再有每行一颗的 data-git-add 按钮
check(!/data-git-add=/.test(pickBlock), '每行不再有「接入」按钮（改成选中了）');
check(/data-git-pick=/.test(pickBlock), '行变成可选中的（data-git-pick）');
check(/class="sk-row pickable/.test(pickBlock), '选中态带 .pickable（有 hover / 选中样式）');
check(/' on'/.test(pickBlock), '选中的那行带 .on');
check(/:not\(\.done\)/.test(pickBlock), '已接入的行不参与选择');
// 选中态要能活过搜索重绘（innerHTML= 会冲掉 class），所以存在变量里
check(/let selected = null;/.test(pickBlock), '选中态存在变量里（不靠 DOM class 硬扛重绘）');

// 「接入」挪到底部动作栏，跟「取消」并排
const dlgBlock = (() => {
  const i = src.indexOf('async function openGitPickDialog(');
  return src.slice(i, src.indexOf('\n}', i));
})();
check(/class="dlg-actions">\s*<button type="button" value="cancel">取消<\/button>\s*<button class="primary" type="button" id="gitPickOk" disabled>接入<\/button>/.test(dlgBlock), '「接入」在「取消」旁边（同一个动作栏）');
check(/id="gitPickOk" disabled/.test(dlgBlock), '没选中时「接入」是禁用的');
check(/okBtn\.disabled = !fullName/.test(dlgBlock), '选中后才放开「接入」');

check(!/drawAvail/.test(src), '旧的那份 drawAvail 已经删掉（没有第二份清单逻辑）');

/* -------------------------------------------------------- 最小 DOM 替身 */
function makeEl(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(),
    children: [],
    parent: null,
    className: '',
    innerHTML: '',
    style: {},
    attrs: {},
    classes: new Set(),
    listeners: {},
    get className() { return [...this.classes].join(' '); },
    set className(v) { this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
    get classList() {
      return {
        add: (c) => this.classes.add(c),
        remove: (c) => this.classes.delete(c),
        contains: (c) => this.classes.has(c),
        toggle: (c, on) => (on ? this.classes.add(c) : this.classes.delete(c)),
      };
    },
    setAttribute: (k, v) => { el.attrs[k] = v; },
    getAttribute: (k) => el.attrs[k],
    addEventListener: (t, fn) => { (el.listeners[t] ??= []).push(fn); },
    // 只实现 wireHelpPop 用到的两个：插在后面、把子节点挪进来
    after: (node) => {
      const i = el.parent.children.indexOf(el);
      el.parent.children.splice(i + 1, 0, node);
      node.parent = el.parent;
    },
    append: (...nodes) => {
      for (const n of nodes) {
        n.parent = el;
        el.children.push(n);
      }
    },
    getBoundingClientRect: () => ({ left: 0, right: 200, top: 0, width: 200 }),
  };
  Object.defineProperty(el, 'onclick', {
    set: (fn) => { (el.listeners.click ??= []).push(fn); },
    get: () => null,
  });
  return el;
}

const root = makeEl('div');
const btn = makeEl('button');
root.append(btn);

const docListeners = { click: [], keydown: [] };
const sandbox = {
  document: {
    addEventListener: (t, fn) => { (docListeners[t] ??= []).push(fn); },
    createElement: makeEl,
  },
  window: { innerWidth: 1200 },
};

/* 从 app.js 里抠出这三个函数来跑 —— 不整文件加载（它顶部就要真 DOM 和 fetch） */
function grab(re) {
  const m = src.match(re);
  if (!m) throw new Error(`没抠到：${re}`);
  return m[0].replace(/^export /gm, ''); // 拆 ESM 后模块里的声明带 export，函数替身执行时剥掉
}
const code = [
  /* 抠到 `wireHelpPop` 结尾为止；后面的段落标记 2026-10-20 从「自建下拉」换成了「悬浮提示（自建 data-tip）」
     —— 这里只是"截到哪儿"的界标，别把它当成被测功能的断言。 */
  grab(/let helpPop = null;[\s\S]*?\n}\n+(?=\s*\/\* -+ 悬浮提示)/),
  // 2026-10-22 拆 ESM：「点别处 / Esc 收起」的注册从 help 区的顶层语句挪进了入口 app.mjs —— 这里按入口原文补上
  `document.addEventListener('click', closeHelpPop);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeHelpPop(); });`,
].join('\n');
const run = new Function('document', 'window', `${code}\nreturn { wireHelpPop, closeHelpPop };`);
const { wireHelpPop, closeHelpPop } = run(sandbox.document, sandbox.window);

wireHelpPop(btn, '怎么拿令牌');
const wrap = root.children.find((c) => c.className === 'help-wrap');
check(!!wrap, '按钮被 .help-wrap 包住（弹出层的定位基准）');
const pop = wrap?.children.find((c) => c.className.startsWith('help-pop'));
check(!!pop, '弹出层挂在 .help-wrap 里');
check(pop.classList.contains('is-hidden'), '初始是收起的');

const click = (el) => {
  const e = { preventDefault() {}, stopPropagation() {} };
  for (const fn of el.listeners.click ?? []) fn.call(el, e);
};

/* ------------------------------------------------------------ 四条行为 */
click(btn);
check(!pop.classList.contains('is-hidden'), '点「?」→ 展开');
check(btn.classList.contains('on'), '点开后按钮带 on（图标提亮）');
check(btn.getAttribute('aria-expanded') === 'true', 'aria-expanded=true');

click(btn);
check(pop.classList.contains('is-hidden'), '再点同一颗「?」→ 收起');

click(btn); // 先展开
for (const fn of docListeners.click) fn({}); // 点页面别处
check(pop.classList.contains('is-hidden'), '点别处 → 收起');

click(btn);
for (const fn of docListeners.keydown) fn({ key: 'Escape' });
check(pop.classList.contains('is-hidden'), 'Esc → 收起');

// 弹出层里面（那条外链）点了不该收
click(btn);
for (const fn of pop.listeners.click ?? []) fn({ stopPropagation() {} });
check(!pop.classList.contains('is-hidden'), '点弹出层里面 → 不收（链接点得到）');
closeHelpPop();

console.log(bad ? `\n✗ ${bad} 项没过` : `\n✓ 帮助图标 ${n} 项全过`);
process.exit(bad ? 1 : 0);
