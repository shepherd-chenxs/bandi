#!/usr/bin/env node
/*
 * check-ghost-refs.mjs —— **指向不存在东西的引用**（2026-11-08）。
 *
 * 为什么需要这一条：这个仓库里已经退场过好几套机制（手机扫码配对、设备令牌、
 * `mobile_*` 表、Tauri 壳），代码删干净了，**叙述没删干净** —— 注释里写着
 * "见 ../server.mjs 的 CHAIN"，而那个常量从来没存在过；文档里整篇描述扫码配对；
 * 一处注释说"401 → 全屏重新扫码提示"，实现却是 reload 出中枢登录页。
 *
 * 这类残留不会让测试变红（它们只是文字），但会**让人和 AI 判断错**：
 * 2026-11-08 排查手机端登录页时，就是被这些过期叙述带到了"旧壳扫码"的死路上。
 *
 * 所以这里只钉**导航性引用** —— 照着它去能找到东西的那种：
 *   · `from './x.mjs'` / `import('./x')`        找不到 = 代码立刻坏，本该有语法检查
 *   · `见 xxx.mjs`                               找不到 = 注释在指路，路是空的
 *   · `apps/…` `docs/…` `tools/…` 开头的仓库路径   找不到 = 文档/注释写了个不存在的位置
 *
 * **故意不扫**散文里提到的文件名（"pairing.mjs 撤了两处挂载"这类 changelog 必须能说
 * 已删的东西），也不扫 `/api/...` 字面量（三方对账在 check-contracts.mjs）。
 *
 * 纯文本、几十毫秒，挂在 run-smokes 的唯一入口上。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['apps/server/src', 'apps/web', 'apps/mobile-native/app/src', 'tools', 'docs'];
const SKIP_DIR = /(^|\/)(node_modules|build|target|runtime|\.git|dist)(\/|$)/;
const EXTS = ['mjs', 'js', 'css', 'html', 'md', 'kt', 'json', 'kts'];

/*
 * **按时日归档的设计/PRD 文档**（`docs/design/`、`docs/prd/`、`docs/mobile/`）不查：记的是当时的设计，
 * 引用的是当时存在的文件。文件后来删了，文档不该跟着改 —— 那是历史，不是错误。
 * 活文档（架构 / 契约 / 形态决策）照查。
 */
const ARCHIVE_DIR = /^docs\/(design|prd|mobile|模板|changelog)\//;

/*
 * **按文件豁免**，每条都得说清为什么：
 *   · check-ghost-refs.mjs —— 本文件的说明通篇是"空路"的例子；
 *   · check-doc-drift.mjs —— 同一个道理（它用 `apps/server/src/xxx.mjs` 讲检查规则）；
 *   · check-pr.mjs        —— 退场台账：它**必须**能写已删冒烟的文件名
 *                            （"某某冒烟已退场"），那是账本，不是指路。
 */
const EXEMPT = new Set([
  'tools/check-ghost-refs.mjs',
  'tools/check-doc-drift.mjs',
  'tools/check-pr.mjs',
]);

/** 扫哪些文件 */
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = path.relative(repo, p).split(path.sep).join('/');
    if (SKIP_DIR.test(rel) || ARCHIVE_DIR.test(rel)) continue;
    if (EXEMPT.has(rel)) continue;
    if (e.isDirectory()) walk(p, out);
    else if (EXTS.some((x) => e.name.endsWith('.' + x))) out.push(p);
  }
  return out;
}

const files = SCAN_DIRS.flatMap((d) => walk(path.join(repo, d)));

/*
 * 裸文件名（"见 auth.mjs"）的兜底索引：全仓库有同名文件就算存在。
 * 只建一次 —— 判"这个名字还有没有人叫"用，不判路径对不对。
 */
const names = new Set();
(function indexNames(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = path.relative(repo, p).split(path.sep).join('/');
    if (SKIP_DIR.test(rel)) continue;
    if (e.isDirectory()) indexNames(p);
    else names.add(e.name);
  }
})(repo);

/*
 * 扩展名长的排前面：`version.json` 不能被 `\.js` 咬掉 `.js` 那一段（首版就踩了，
 * 一次误报 60 多处）。`(?![\w])` 保证 `x.json` 不会退化成 `x.js`。
 */
const EXT_ALT = 'json|kts|mjs|css|html|md|kt|js';

const PATTERNS = [
  // 相对 import —— 找不到就是真坏
  { kind: 'import', re: /from\s+['"](\.[^'"\n]+)['"]/g },
  { kind: 'import', re: /import\(\s*['"](\.[^'"\n]+)['"]\s*\)/g },
  // "见 xxx.mjs" / "见 ./xxx.mjs"（本仓库的指路写法）
  { kind: 'comment', re: new RegExp(`见\\s+([\\w./-]+\\.(?:${EXT_ALT}))(?![\\w])`, 'g') },
  // 仓库相对路径
  { kind: 'path', re: new RegExp(`(?:^|[\\s(\`'"[])((?:apps|docs|tools)\\/[\\w./-]+\\.(?:${EXT_ALT}))(?![\\w])`, 'g') },
  // ./ 或 ../ 开头的路径（非 import 语句里也可能出现）
  { kind: 'path', re: new RegExp(`(?:^|[\\s(\`'"[=])(\\.{1,2}\\/[\\w./-]+\\.(?:${EXT_ALT}))(?![\\w])`, 'g') },
];

/**
 * 一个引用是否成立。
 *
 * 解析顺序：相对当前文件 → 仓库根 → server/src → web/js → web。
 * 裸文件名（没有 `/`）只查索引：同级重名太常见，硬绑目录只会制造误报。
 */
function resolveRef(ref, fromFile) {
  const clean = ref.replace(/[),.;:'"]+$/, '');
  if (clean.startsWith('./') || clean.startsWith('../')) {
    return fs.existsSync(path.resolve(path.dirname(fromFile), clean));
  }
  if (!clean.includes('/')) return names.has(clean);
  const cands = [
    path.resolve(repo, clean),
    path.resolve(repo, 'apps/server/src', clean),
    path.resolve(repo, 'apps/web', clean),
    path.resolve(repo, 'apps/web/js', clean),
  ];
  return cands.some((c) => fs.existsSync(c));
}

/*
 * 两类不算：
 *   · 仓外路径（中枢仓库的契约文档、tmp 下的一次性探针）—— 它们本来就不在这里；
 *   · `smoke-*.mjs` 里的**夹具字符串**（`apps/x.mjs`、`docs/token.md` 是给解析器吃的
 *     假路径，不是指路）—— 但这些文件里的 import 照查，那是真依赖。
 */
const EXTERNAL_PREFIX = /^(bandi-hub|tmp)\//;
const isSmokeFile = (rel) => /(^|\/)smoke-[\w-]+\.mjs$/.test(rel);

const ghosts = [];
for (const f of files) {
  const relFile = path.relative(repo, f).split(path.sep).join('/');
  const smoke = isSmokeFile(relFile);
  const src = fs.readFileSync(f, 'utf8');
  const lines = src.split('\n');
  for (const { kind, re } of PATTERNS) {
    if (smoke && kind !== 'import') continue;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) {
      const ref = m[1];
      if (!ref || ref.includes('://') || ref.startsWith('node:')) continue;
      if (EXTERNAL_PREFIX.test(ref)) continue;
      if (resolveRef(ref, f)) continue;
      // 重复命中同一个引用（多条正则）只报一次
      const line = src.slice(0, m.index).split('\n').length;
      const key = `${f}:${line}:${ref}`;
      if (ghosts.some((g) => g.key === key)) continue;
      ghosts.push({
        key,
        file: path.relative(repo, f).split(path.sep).join('/'),
        line,
        ref,
        kind,
        text: (lines[line - 1] ?? '').trim().slice(0, 90),
      });
    }
  }
}

if (ghosts.length === 0) {
  console.log(`✓ 幽灵引用 0 处（扫了 ${files.length} 个文件）`);
  process.exit(0);
}

console.error(`✗ 有 ${ghosts.length} 处引用指向不存在的东西：\n`);
for (const g of ghosts) {
  console.error(`  ${g.file}:${g.line}  [${g.kind}]  ${g.ref}`);
  if (g.text) console.error(`      ${g.text}`);
}
console.error('\n处理办法：删掉这条引用、改正路径，或（若它在讲述已退场机制的 changelog）');
console.error('改成不带路径的写法（"扫码配对那套已删"），别留一个能点进去的空路。');
process.exit(1);
