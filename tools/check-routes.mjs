/**
 * 前端路由的**静态自检**（2026-10-17 统一路由时加的）。
 *
 * 为什么要有：路由这件事最容易犯的错就是"新加了一个页面，忘了登记"——
 * 以前是两处（savePlace 逐字段 + restorePlace 逐页 if/else），忘了就刷新记不住位置。
 * 现在收成"一处表 + 每个入口一行 setRoute"，但仍然可能漏。这个脚本把两条不变量钉住：
 *
 *   ① 每个 `setRoute('xxx')` 里出现的 view，都必须在 ROUTES 表里登记过（否则恢复时打不开）；
 *   ② ROUTES 表里的每个 view，都能被某个 `setRoute` 产生（否则它就是死条目）。
 *      —— 只有一级栏（messages / contacts）不需要，它们由 setNav 兜底。
 *
 * 纯静态、不需要浏览器。跑法：node tools/check-routes.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 2026-10-22 前端拆 ESM：ROUTES / openRoute 在 js/shell.mjs，setRoute 的调用方散在各模块 —— 全量拼接后再扫
const jsDir = path.join(repo, 'apps', 'web', 'js');
const raw = fs.readdirSync(jsDir).filter((f) => f.endsWith('.mjs'))
  .map((f) => fs.readFileSync(path.join(jsDir, f), 'utf8')).join('\n');
// **先去掉注释再扫** —— 否则文档里写的示例（setRoute('xxx')）会被当成真调用（第一次就误报了）
const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const ROUTES_BEGIN = 'const ROUTES = {';
const begin = src.indexOf(ROUTES_BEGIN);
if (begin < 0) {
  console.error('✗ 找不到 ROUTES 表（app.js 里的路由注册表）');
  process.exit(1);
}
// 取到配对的 `};`（表里没有嵌套的对象字面量到顶层，按首个 "\n};" 收尾就够）
const end = src.indexOf('\n};', begin);
if (end < 0) {
  console.error('✗ ROUTES 表没有闭合的 };');
  process.exit(1);
}
const table = src.slice(begin + ROUTES_BEGIN.length, end);
const registered = [...table.matchAll(/^\s{2}([A-Za-z][\w]*)\s*:/gm)].map((m) => m[1]);

const used = [...src.matchAll(/setRoute\('([^']+)'/g)].map((m) => m[1]);
const produced = new Set(used);

// 一级栏：由 setNav 兜底，不需要入口函数里 setRoute
const NAV_ONLY = new Set(['messages', 'contacts']);

let failed = 0;
const bad = (msg) => {
  console.log('  ✗ ' + msg);
  failed += 1;
};

if (!src.includes('function openRoute(')) bad('app.js 里没有 openRoute() 分发器');
/*
 * 启动链路的三件套必须**在且只有一份**（2026-10-17 真踩过：重构脚本误删了 restorePlace 的整个函数体，
 * 只剩调用 → 启动时 ReferenceError 被 catch 住、位置恢复永远失效，而 node --check 照样通过）。
 */
for (const [sig, label] of [
  ['async function restorePlace(', '启动恢复函数 restorePlace'],
  ['function openRoute(', '路由分发器 openRoute'],
  ['function setRoute(', '记录当前位置 setRoute'],
  ['const ROUTES = {', '路由表 ROUTES'],
]) {
  const n = src.split(sig).length - 1;
  if (n !== 1) bad(`${label} 应该正好 1 份，实际 ${n} 份（${sig}）`);
}
if (!src.includes('.then(() => restorePlace())')) bad('启动处没有调 restorePlace()');
if (!registered.length) bad('ROUTES 表是空的');

for (const v of produced) {
  if (!registered.includes(v)) bad(`setRoute('${v}') —— ROUTES 里没有登记，刷新恢复时打不开`);
}
for (const v of registered) {
  if (NAV_ONLY.has(v)) continue;
  if (!produced.has(v)) bad(`ROUTES 里有 '${v}'，但没有任何 setRoute('${v}') —— 这个条目永远不会被记录`);
}

console.log(`  路由表 ${registered.length} 项：${registered.join(', ')}`);
console.log(`  setRoute 产生 ${produced.size} 个 view：${[...produced].join(', ')}`);
if (failed) {
  console.error(`\n✗ 路由自检没过（${failed} 项）`);
  process.exit(1);
}
console.log('\n✓ 路由自检通过（每个登记的都能被记录，每个记录的都登记过）');
