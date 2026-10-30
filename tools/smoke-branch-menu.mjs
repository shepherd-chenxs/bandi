/*
 * 分支行尾「二级菜单箭头」的离线自检（2026-10-30）。
 *
 * 为什么单开这一条：箭头这条链要过三手 —— 分支条目带 `menu` → `folderize` 分组时别把它丢掉
 * → combo 按 `menu` 画出 `›` → 点它发 `combo-menu` 事件 → 页面开菜单。
 * 任何一手漏了都**不报错，只是箭头不见了**（用户实报："箭头呢"）。
 *
 * 前端没有构建步骤，CI 只过 `node --check` —— 这里用源码级断言把这条链钉死
 * （跟 smoke-help-pop / smoke-branch-badge 同一套做法）。
 *
 * 跑：node tools/smoke-branch-menu.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8').replace(/\r\n/g, '\n');
const skills = read('apps/web/js/skills.mjs');
const ui = read('apps/web/js/ui.mjs');
const css = read('apps/web/style.css');

let bad = 0;
let n = 0;
const check = (ok, msg, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${msg}${detail ? ' — ' + detail : ''}`);
  n++;
  if (!ok) bad++;
};

/* --------------------------------------------- ① 分支条目要带 menu，分组别丢 */

check(/b\.recent\.map\(\(n\) => \(\{ id: n, name: n, menu: true,/.test(skills), '「最近」的条目带 menu');
check(/\(b\.local \?\? \[\]\)\.map\(\(n\) => \(\{ id: n, name: n, menu: true,/.test(skills), '「本地分支」的条目带 menu');
check(/\(b\.remote \?\? \[\]\)\.map\(\(n\) => \(\{ id: n, name: n\.replace\([^)]*\), menu: true \}\)/.test(skills), '「远程分支」的条目带 menu');
check(
  /\.\.\.\(it\.menu \? \{ menu: true \} : \{\}\)/.test(skills),
  'folderize 的叶子把 menu 原样带过去（漏了这一手箭头会静默消失）',
);

/* ------------------------------------------------- ② combo 画出箭头、点了不选分支 */

check(/it\.menu \? '<button type="button" class="combo-more"/.test(ui), 'combo 条目按 menu 画出行尾 `›`');
check(/combo-more[\s\S]{0,200}ev\.stopPropagation\(\)/.test(ui), '点箭头不会顺带选中这条分支（stopPropagation）');
check(/new CustomEvent\('combo-menu'/.test(ui), '箭头把点击抛成 combo-menu 事件（页面才知道开谁的菜单）');

/* ---------------------------------------------------------- ③ 页面接住并开菜单 */

check(/addEventListener\('combo-menu',/.test(skills), 'skills 页监听 combo-menu');
check(/openBranchMenu\(\s*repo,\s*\{ x:/.test(skills), '事件带着"开在哪儿"（贴箭头）');
/*
 * 2026-10-30 决定改了：签出从「点整行」挪进二级菜单第一位（用户原话："点击选项就打开，改成二级
 * 窗口的一个选项，放在第一位"），`openBranchMenu` 因此多了第 4 个**可选**参数 `{ checkout } = {}`
 * （见 apps/web/js/skills.mjs:1524 调用处）。原来这条断言把参数表尾的 `)` 也钉死了，多一个参数就红 ——
 * 断言跟着放宽到"前三手形状不许变"，同时把新增的 checkout 两个落点（声明处 + 调用处）各钉一条，
 * 这一条从 1 个 check 变成 3 个 —— **净断言数只增不减，语义没松**。
 */
check(/function openBranchMenu\(repo, pos, \{ name, remote, cur \}/.test(skills), 'openBranchMenu 收位置对象');
check(
  /function openBranchMenu\(repo, pos, \{ name, remote, cur \}, \{ checkout \} = \{\}\)/.test(skills),
  '签出是可选的第 4 个参数（不传就不摆这一项）',
);
check(
  /checkout: \(\) => onBranchPick\(repo, id, state\.branch \?\? '', combo\)/.test(skills),
  '菜单里那一项接回复用原有的切分支路径（确认框还在）',
);
check(/openCtxMenu\(pos\.x, pos\.y, items\)/.test(skills), '菜单落到全站那一套 #ctxMenu 上');

/* ------------------------------------------------------------------- ④ 样式 */

check(/\.combo-more \{/.test(css), '`.combo-more` 有样式（不然是个裸按钮）');
check(/\.combo-item:hover \.combo-more/.test(css), '悬停/高亮那一行时箭头变实（IDEA 同款）');

console.log(`\n结论：${bad ? `${bad} 项没过` : '全通过'}`);
process.exit(bad ? 1 : 0);
