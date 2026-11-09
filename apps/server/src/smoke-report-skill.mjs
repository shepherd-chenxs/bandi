/**
 * **汇报技能（bandi-report）** 的验收（2026-11-09 用户：「麦肯锡式汇报约束，最好做成一个 skill」）。
 *
 * 上游不是从零写的：参考/改写了两个 MIT 开源 agent skill（minto-pyramid、
 * pyramid-principle-for-operators），只保留"写汇报"这一面并换成班底语境。
 * 本用例钉四件事：
 *   ① 技能文件在位、frontmatter 合法、正文含「结论先行 / 模板 / 已做 / 在等 / 拍板 / Next 禁令」；
 *   ② NOTICE 里带了上游 MIT 许可与两个仓库链接（不白抄）；
 *   ③ 专家包默认挂上：PM（贺韬）、助理（喜儿）的技能清单里都有 bandi-report；
 *   ④ 平台侧每轮/首轮注入都指向它（PM brief 与 run 提醒里都有「结论先行 / Next」口径）；
 *      PM 技能 §九 也指向它（不重复维护两份长文）。
 *
 * 纯静态检查（不起服务、不开库），跑法：node apps/server/src/smoke-report-skill.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

const skill = read('skills/bandi-report/SKILL.md');
const notice = read('skills/bandi-report/NOTICE.md');
const experts = read('apps/server/src/experts.mjs');
const dispatchSrc = read('apps/server/src/dispatch.mjs');
const runsSrc = read('apps/server/src/runs.mjs');
const pmSkill = read('skills/bandi-expert-pm/SKILL.md');

console.log('① 技能文件：frontmatter + 正文要件');
check('frontmatter 有 name: bandi-report', /^---[\s\S]*?\nname: bandi-report\n/.test(skill));
check('description 说清适用面（结论先行/汇报）', /description:[\s\S]*?结论先行/.test(skill), '');
check('正文给了模板（【结论】/依据/这一轮已做）', /【结论】/.test(skill) && /这[一]轮已做/.test(skill), '');
check('正文有"在等 / 待拍板"收尾口径', /在等/.test(skill) && /需要你拍板/.test(skill), '');
check('正文有「Next: 不是留给自己的待办」禁令', /Next:/.test(skill) && /先做完/.test(skill), '');
check('正文说明了什么时候不该用（时间线/教程/笔记）', /时间线/.test(skill) && /教程/.test(skill), '');

console.log('\n② 出处与许可：不白抄上游');
check('NOTICE 带 MIT License 全文', /MIT License/.test(notice) && /Permission is hereby granted/.test(notice));
check('NOTICE 链接 minto-pyramid 上游', /millwright-labs\/minto-pyramid-skill/.test(notice));
check('NOTICE 链接 pyramid-principle-for-operators 上游', /wilsonwu-ai\/pyramid-principle-for-operators/.test(notice));

console.log('\n③ 专家包默认挂载（不需要人工去技能库点）');
check('PM（贺韬）包里有 bandi-report', /skills: \['bandi-expert-pm'[^\]]*'bandi-report'/.test(experts), '');
check('助理（喜儿）包里有 bandi-report', /skills: \['bandi-expert-secretary'[^\]]*'bandi-report'/.test(experts), '');

console.log('\n④ 平台注入与 PM 技能都指向它（一处维护）');
check('PM 首轮 brief 含结论先行与 Next 禁令', /结论先行/.test(dispatchSrc) && /Next:/.test(dispatchSrc) && /bandi-report/.test(dispatchSrc));
check('每轮提醒含结论先行/已做完/Next 禁令', /结论先行|结论/.test(runsSrc) && /已做完/.test(runsSrc) && /Next:/.test(runsSrc));
check('每轮提醒说了改卡权限（能闭环）', /改卡/.test(runsSrc) && /startNow/.test(runsSrc));
check('PM 技能 §九 指向 bandi-report（不重复长文）', /bandi-report/.test(pmSkill), '');

console.log(failed ? `\n✗ ${failed} 项没过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
