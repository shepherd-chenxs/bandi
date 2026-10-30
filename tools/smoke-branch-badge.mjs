/*
 * 分支角标的离线自检（2026-10-30）。
 *
 * 为什么单开这一条：2026-10-27 用户连调了三次才定下来 ——
 *   · 一调：↑N 绿（本地要推）/ ↓N（要拉）；
 *   · 二调："不要数字，箭头颜色使用绿色"；
 *   · **三调（定稿）："加上数字，更新和提交箭头颜色区分开"** —— IDEA 同款
 *     「↙N 蓝 = 上游有新的要拉；↗N 绿 = 本地有提交要推」，个数照写。
 *
 * 可这版在随后的合并里**被误操作整段退回**了（2026-10-30 复盘才发现，分支 pill 又变成
 * 不带数字的单色箭头）。当时的验收只存在于那一个分支上，没进 49 条冒烟 ——
 * 所以这次把它钉进清单：再有人把 `innerHTML` 改回 `textContent`、或者把双色 span 删掉，
 * 门禁当场变红，不用等用户发现。
 *
 * 前端没有构建步骤，CI 只过 `node --check` —— 这里用**源码级断言**（跟 smoke-help-pop 同一套做法）：
 * 钉住"两处角标都带个数 + 都分色 + 按钮那层能上色"，不依赖真浏览器。
 *
 * 跑：node tools/smoke-branch-badge.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8').replace(/\r\n/g, '\n');
const skillsSrc = read('apps/web/js/skills.mjs');
const uiSrc = read('apps/web/js/ui.mjs');
const cssSrc = read('apps/web/style.css');

let bad = 0;
let n = 0;
const check = (ok, msg, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${msg}${detail ? ' — ' + detail : ''}`);
  n++;
  if (!ok) bad++;
};
const count = (src, needle) => src.split(needle).length - 1;

/* ------------------------------------------------ 两处角标：都带个数、都分色 */

const DOWN = '<span class="down">↙${down}</span>';
const UP = '<span class="up">↗${up}</span>';

check(count(skillsSrc, DOWN) === 2, '↙N（要拉，蓝）在分支 pill 与分支清单两处都画', `出现 ${count(skillsSrc, DOWN)} 次`);
check(count(skillsSrc, UP) === 2, '↗N（要推，绿）在分支 pill 与分支清单两处都画', `出现 ${count(skillsSrc, UP)} 次`);

/*
 * 个数必须来自真实计数，不能是写死的箭头 —— 三调前那一版就是"只有箭头没数字"。
 * `Number(...)` 兜一层是因为上游字段可能缺：undefined 直接拼进字符串会变成 "↗undefined"。
 */
check(/const up = Number\(u\.ahead \?\? 0\)/.test(skillsSrc) && /const down = Number\(u\.behind \?\? 0\)/.test(skillsSrc), '分支清单的个数取自 ahead / behind，不是写死的');
check(/const up = Number\(state\.unpushed \?\? 0\)/.test(skillsSrc) && /const down = Number\(state\.unpulled \?\? 0\)/.test(skillsSrc), '分支 pill 的个数取自 unpushed / unpulled');

/* ------------------------------------------------------ 传递链：badgeHtml 到 DOM */

check(/\.\.\.\(it\.badgeHtml \? \{ badgeHtml: it\.badgeHtml \} : \{\}\)/.test(skillsSrc), '分支清单把 badgeHtml 原样带到 combo 条目（folderize 不丢字段）');
check(/it\.badgeHtml\s*\n?\s*\? `<span class="combo-badge">\$\{it\.badgeHtml\}<\/span>`/.test(uiSrc), 'combo 条目渲染 badgeHtml（带色那一路）');
check(/esc\(it\.badge\)/.test(uiSrc), '纯文本 badge 仍走 esc()（别的下拉不传 badgeHtml = 跟以前逐字一样）');

/*
 * 按钮上的角标必须能用 innerHTML 上色：buttonText 是纯文本，塞不进颜色。
 * 三调就是靠这一行才能画双色；退回 textContent 会把 `<span class="down">` 原样打印出来。
 */
check(/badge\.innerHTML = b/.test(uiSrc), '按钮角标走 innerHTML（双色 span 才画得出来）');
check(!/badge\.textContent = b/.test(uiSrc), '按钮角标没有退回 textContent');

/* ------------------------------------------------------------------- 配色 */

check(/\.combo-badge \.down, \.combo-btn-badge \.down \{[^}]*var\(--accent\)/.test(cssSrc), '↙ 用 --accent（蓝：上游有新的要拉）');
check(/\.combo-badge \.up, \.combo-btn-badge \.up \{[^}]*var\(--ok\)/.test(cssSrc), '↗ 用 --ok（绿：本地有提交要推）');
/*
 * 容器不能再定色：二调时 `.combo-badge { color: var(--ok) }` 把整块染绿，
 * 双色箭头放进去两个方向就一样绿了。这条防的是"只改模板没改样式"。
 */
check(!/\.combo-badge \{[^}]*color:/.test(cssSrc), '容器 .combo-badge 不再整体定色（颜色只由 .up / .down 决定）');

console.log(`\n结论：${bad ? `${bad} 项没过` : '全通过'}`);
process.exit(bad ? 1 : 0);
