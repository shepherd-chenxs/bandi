/**
 * **本轮方法论内联**的验收（2026-11-22「三个缺口的第一步」）。
 *
 * 要钉的不是"能不能塞文本"，而是四条边界 —— 它们每一条都对应一次踩过的坑：
 *   ① 命中：任务里真提到该用哪份方法 → 正文进上下文（不再给个路径让它自愿去读）；
 *   ② 不误伤：无关的任务一个字都不多（宁可漏，不可误 —— 误注入会劫持任务，见 2026-11-09 李俊那次）；
 *   ③ 有上限：份数与字数都封顶，超出截在段落边界并留全文路径；
 *   ④ 说清边界：内联块明写"这是做法不是任务模式，交什么仍按本轮任务合同"。
 *
 * 另外钉死「我们自己写的那份放得下」：默认预算（6000 字）必须容得下 `bandi-report` 全文，
 * 否则最常见的场景反而被截断 —— 那是预算配错了，不是正文太长。
 *
 * 纯函数 + 读技能文件（不开库、不起服务）：
 *   node apps/server/src/smoke-skill-inline.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planSkillInline, hitsOf, TRIGGERS, SKILL_INLINE_CHARS, SKILL_INLINE_MAX } from './skill-inline.mjs';
import { inlineSkillsBlock, skillsBlock } from './dispatch/contract.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

const DEV_SKILLS = ['bandi-repo', 'test-driven-development', 'systematic-debugging', 'verification-before-completion'];

console.log('① 命中：任务里提到的方法进阶');
{
  const p = planSkillInline('给老板写一份进度汇报，结论先行', ['bandi-report']);
  check('「汇报」命中 bandi-report', p.picked.map((x) => x.name).join() === 'bandi-report');
  check('命中词写进结果（事后可核对为什么注入）', /汇报/.test(p.picked[0]?.hits?.join() ?? ''), JSON.stringify(p.picked[0]?.hits));
  check('正文是全文、不是路径', (p.picked[0]?.body ?? '').length > 500 && !/^---/.test(p.picked[0]?.body ?? ''));
  check('全文没被截断（bandi-report 在默认预算内）', p.picked[0]?.truncated === false, `${p.picked[0]?.chars} 字`);

  const explicit = planSkillInline('按 bandi-repo 这份看一下 PR 为什么红', DEV_SKILLS);
  check('显式点名技能名也算命中', explicit.picked.some((x) => x.name === 'bandi-repo'));

  const en = planSkillInline('用 Playwright 把这个页面点一遍', ['webapp-testing']);
  check('英文触发词大小写无关', en.picked.length === 1 && en.picked[0].name === 'webapp-testing');
}

console.log('\n② 不误伤：无关任务一个字都不多');
{
  const p = planSkillInline('这个群现在有几个人？', DEV_SKILLS);
  check('闲聊 / 问名单 → 一份都不注入', p.picked.length === 0, JSON.stringify(p.skipped.map((x) => x.name)));
  check('空文本不抛错且不注入', planSkillInline('', DEV_SKILLS).picked.length === 0);
  check('null 文本 / 空挂载不抛错', planSkillInline(null, []).picked.length === 0 && planSkillInline('任意', null).picked.length === 0);
  check('泛词不触发（「总结」「设计」不在表里）', !hitsOf('帮我总结一下这个设计', 'bandi-report').length);
}

console.log('\n③ 上限：份数与字数都封顶');
{
  const text = '冒烟红了，先复现这个报错，改好了再做一次回归';
  const capped = planSkillInline(text, DEV_SKILLS, { maxSkills: 2 });
  check('最多 2 份', capped.picked.length === 2, capped.picked.map((x) => x.name).join('、'));
  check('超出的进 skipped 并写明原因', capped.skipped.some((x) => /上限/.test(x.reason)), JSON.stringify(capped.skipped));

  const clipped = planSkillInline(text, ['systematic-debugging'], { maxChars: 200 });
  const c = clipped.picked[0];
  check('超预算被截断且标记 truncated', c?.truncated === true, `${c?.chars}/${c?.totalChars}`);
  check('截断后正文不超预算', (c?.body ?? '').length <= 200, String(c?.chars));
  check('截断保留全文路径（要细则能找回）', /SKILL\.md$/.test(c?.file ?? '') && c.totalChars > c.chars);

  const off = planSkillInline(text, DEV_SKILLS, { maxSkills: 0 });
  check('maxSkills=0 = 关掉（应急开关）', off.picked.length === 0);
}

console.log('\n④ 边界：注入只教"怎么做"，不决定"交什么"');
{
  const p = planSkillInline('写个进度汇报', ['bandi-report']);
  const block = inlineSkillsBlock(p.picked);
  check('块头说明本轮注入了什么', /本轮方法论 · 平台按这轮任务匹配后注入/.test(block));
  check('明写"已经给了全文，不要再按路径去读"', /不要再按路径去读/.test(block));
  check('明写 MUST 只是做法、交什么仍按本轮任务合同', /交什么、多长、什么语气仍按【本轮任务合同】/.test(block));
  check('正文真的在里面（不是只有标题）', /结论先行/.test(block) && block.length > 1000, String(block.length));
  check('没命中就完全不出这一块（任务不长一个字）', inlineSkillsBlock([]) === '' && inlineSkillsBlock(null) === '');
}

console.log('\n⑤ 接线：派活链路真的用上了');
{
  const dispatchSrc = read('apps/server/src/dispatch.mjs');
  const contractSrc = read('apps/server/src/dispatch/contract.mjs');
  check('dispatch 组装前先 planSkillInline', /const skillInline = planSkillInline\(/.test(dispatchSrc));
  const matchTextBlock = dispatchSrc.slice(
    dispatchSrc.indexOf('const matchText'),
    dispatchSrc.indexOf('planSkillInline(matchText'),
  );
  check(
    '判据含雇主原话 + 卡标题/描述',
    /trigger\.text/.test(matchTextBlock) &&
      /opts\.card\?\.title/.test(matchTextBlock) &&
      /opts\.card\?\.description/.test(matchTextBlock),
  );
  check('长期记忆召回与技能内联共用同一份 matchText', /planSkillInline\(matchText, skillNames\)/.test(dispatchSrc));
  check('不含群聊历史（避免"报错"两字把排障塞进问进度）', !/planSkillInline\(\s*context/i.test(dispatchSrc));
  check('fullTask 里内联块排在合同之前', /inlineSkillsBlock\(inlinePicked\), contractBlock/.test(dispatchSrc));
  check('与回复风格内联的那份去重（同一条任务里不出现两遍）', /s\.name !== styleSkill/.test(dispatchSrc));
  check('注入了哪几份落日志（缺口三的最小账）', /\[技能注入\]/.test(dispatchSrc));
  check('清单措辞改成"没给正文的才去读"', /那些不用再去读文件/.test(contractSrc) && /没给正文的，需要时按路径读/.test(contractSrc));
  check('内联块从 contract.mjs 导出、dispatch 再导出（barrel 不变）', /export function inlineSkillsBlock/.test(contractSrc) && /inlineSkillsBlock,/.test(dispatchSrc));
  check('旧清单块仍在（渐进披露没被删掉）', /export function skillsBlock/.test(contractSrc) && /export function inlineSkillsBlock/.test(contractSrc));
}

console.log('\n⑥ 策略表：只收指向明确的词');
{
  const names = Object.keys(TRIGGERS);
  check('表里没有"总结/设计/方案"这类泛词', !names.some((n) => (TRIGGERS[n] ?? []).some((t) => ['总结', '设计', '方案'].includes(t))));
  check('每个触发词都短（中文 ≤6 字、英文 ≤16 字符：长词等于把答案写死）', names.every((n) => (TRIGGERS[n] ?? []).every((t) => (/^[\x00-\x7f]+$/.test(t) ? t.length <= 16 : t.length <= 6))), '');
  check('默认上限配额合理（1~4 份 / 4k~12k 字）', SKILL_INLINE_MAX >= 1 && SKILL_INLINE_MAX <= 4 && SKILL_INLINE_CHARS >= 4000 && SKILL_INLINE_CHARS <= 12000, `${SKILL_INLINE_MAX} 份 / ${SKILL_INLINE_CHARS} 字`);
}

console.log(`\n结论：${failed ? `${failed} 项没过` : '全通过'}`);
process.exit(failed ? 1 : 0);
