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
const src = fs.readFileSync(path.join(repo, 'apps', 'web', 'app.js'), 'utf8');

let bad = 0;
const check = (ok, msg) => {
  console.log(`${ok ? '✓' : '✗'} ${msg}`);
  if (!ok) bad++;
};

/* ---------------------------------------------------- 源码层面：公共件得存在 */
check(/const ICON_HELP\s*=/.test(src), '有 ICON_HELP 图标常量');
check(/function wireHelpPop\(/.test(src), '有 wireHelpPop() 公共件');
check(/function closeHelpPop\(\)/.test(src), '有 closeHelpPop() 收起函数');
check(/const GIT_TOKEN_HELP\s*=/.test(src), '「怎么拿令牌」抽成了 GIT_TOKEN_HELP 常量');
// 同一份措辞：表单下面和「?」弹出层必须都用它，不能各写一套。
// 两种写法都算：模板串里的 ${GIT_TOKEN_HELP} 和直接传标识符的 wireHelpPop(btn, GIT_TOKEN_HELP)
const usesInTpl = (src.match(/\$\{GIT_TOKEN_HELP\}/g) ?? []).length;
const usesAsArg = (src.match(/wireHelpPop\([^)]*GIT_TOKEN_HELP/g) ?? []).length;
check(
  usesInTpl + usesAsArg === 2,
  `GIT_TOKEN_HELP 被两处引用（模板 ${usesInTpl} + 传参 ${usesAsArg}）`,
);
// 「?」要挂在 GitHub 连接那个标题上，不是别的分组
check(
  /class="group-title">GitHub 连接<button[^>]*id="gitTokenHelp"/.test(src),
  '帮助图标挂在「GitHub 连接」标题上',
);
// 连上之后表单没了，标题还在 —— 所以「?」的挂载不能在 if (st.connected) 分支里
check(/if \(helpBtn\) wireHelpPop\(helpBtn, GIT_TOKEN_HELP\);/.test(src), 'renderGitRepos 里挂上了「?」');
check(/document\.addEventListener\('click', closeHelpPop\)/.test(src), 'document 上装了"点别处收起"');

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
  return m[0];
}
const code = [
  grab(/let helpPop = null;[\s\S]*?\n}\n(?=\n\/\* -+ 自建下拉)/),
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

console.log(bad ? `\n✗ ${bad} 项没过` : '\n✓ 帮助图标 5 项全过');
process.exit(bad ? 1 : 0);
