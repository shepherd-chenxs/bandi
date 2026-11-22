/**
 * **岗位判据**的验收（2026-11-22，缺口②：把"专业度"从文字变成账）。
 *
 * 钉五件事，每条都对应一次"这条要是松了会怎样"：
 *   ① 解析只吃 `## 判据` 段、只认带反引号的具体动作 —— 手册其他段落（常见坑、边界）不许被误吃；
 *   ② 核对的判据是**动作**不是措辞：声称完成 + 没跑过那条命令 = 未过；跑过别的命令也算未过；
 *   ③ **能判才判**：本轮一条命令都没有 → 记"判不了"，绝不记失败（有的运行时不吐 tool 事件，
 *      凭空判失败就是诬告）；没声称完成 → 不核"必须跑过"；
 *   ④ 红线（不许按进程名清杀）任何时候都核，且**按 PID 的清理不算**（那是允许的做法）；
 *   ⑤ 接线：判据进本轮契约、收尾挂在台账核对之后、手册里真有判据段。
 *
 * 纯静态 + 纯函数（不起服务、不开库）：node apps/server/src/smoke-role-criteria.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BASE_CRITERIA,
  parseCriteria,
  criteriaFor,
  actionsOf,
  checkCriteria,
  criteriaLines,
} from './role-criteria.mjs';
import { taskContractBlock } from './dispatch/contract.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

const ev = {
  bash: (command) => ({ type: 'tool', name: 'Bash', input: { command } }),
  codex: (command) => ({ type: 'tool', name: 'command_execution', detail: { command } }),
  read: (file_path) => ({ type: 'tool', name: 'Read', input: { file_path } }),
  thinking: (text) => ({ type: 'thinking', text }),
};

console.log('① 解析：只吃 `## 判据` 段，只认带反引号的动作');
{
  const dev = read('apps/server/src/roles/packs/dev.md');
  const parsed = parseCriteria(dev);
  check('dev 手册解析出 1 条判据、零警告', parsed.criteria.length === 1 && !parsed.warnings.length, JSON.stringify(parsed.warnings));
  check('kind/args 对得上（must-run + 5 个候选）', parsed.criteria[0]?.kind === 'must-run' && parsed.criteria[0].args.length === 5);
  check('标签保留动词（契约里读得懂是哪种判据）', /必须跑过/.test(parsed.criteria[0]?.label ?? ''), parsed.criteria[0]?.label);
  check('when=done（只在声称完成那轮核）', parsed.criteria[0]?.when === 'done');

  const prose = parseCriteria('# 标题\n\n- 必须跑过：`npm test`\n\n## 常见坑\n\n- 必须跑过：`npm test`\n');
  check('段外的条目不会被吃进来', prose.criteria.length === 0, JSON.stringify(prose.criteria));

  const loose = parseCriteria('## 判据\n- 必须跑过测试\n- 必须跑过：`npm test`\n');
  check('缺具体动作的行进 warnings 且不入判据', loose.criteria.length === 1 && loose.warnings.length === 1);

  const bogus = parseCriteria('## 判据\n- 要认真一点：`x`\n');
  check('认不出动词的行既不吞也不报成判据', bogus.criteria.length === 0 && bogus.warnings.length === 1);

  const test = parseCriteria(read('apps/server/src/roles/packs/test.md'));
  check('test 手册也有判据（真跑不脑补那条）', test.criteria.length === 1 && test.criteria[0].args.includes('playwright'), test.criteria[0]?.args.join('/'));
  const pm = parseCriteria(read('apps/server/src/roles/packs/pm.md'));
  check('pm 手册没有判据段（宁少不滥，不为了凑数写判不了的条目）', pm.criteria.length === 0);
}

console.log('\n② 引擎：核的是动作，不是措辞');
{
  const dev = criteriaFor('dev');
  const must = dev.find((c) => c.kind === 'must-run');

  const ok = checkCriteria({ criteria: dev, actions: actionsOf([ev.bash('npm test')]), claimed: 'done' });
  check('跑过 npm test → 全过', ok.failed.length === 0, JSON.stringify(ok.failed.map((f) => f.why)));
  check('codex 形状的事件也认（command_execution）', checkCriteria({ criteria: dev, actions: actionsOf([ev.codex('node tools/run-smokes.mjs')]), claimed: 'done' }).failed.length === 0);

  const bad = checkCriteria({ criteria: dev, actions: actionsOf([ev.bash('git status'), ev.read('README.md')]), claimed: 'done' });
  check('声称完成但只跑了 git status → 未过', bad.failed.some((f) => f.id === must.id), JSON.stringify(bad.failed.map((f) => f.id)));
  check('未过里说清"跑过的命令里没有"（给雇主看得懂）', /跑过的命令里没有/.test(bad.failed[0]?.why ?? ''), bad.failed[0]?.why);

  const thinkingOnly = checkCriteria({ criteria: dev, actions: actionsOf([ev.thinking('我打算跑 npm test')]), claimed: 'done' });
  check('thinking 里"打算跑"不算动作（只认 tool 事件）', thinkingOnly.failed.length === 0 && /判不了/.test(thinkingOnly.skipped[0]?.why ?? ''), JSON.stringify(thinkingOnly.skipped));
}

console.log('\n③ 能判才判：不判的时候记"判不了"，不记失败');
{
  const dev = criteriaFor('dev');
  const none = checkCriteria({ criteria: dev, actions: [], claimed: 'done' });
  check('一条命令事件都没有 → 不记失败', none.failed.length === 0, JSON.stringify(none.failed));
  check('而是记 skipped 并说明原因', /判不了/.test(none.skipped[0]?.why ?? ''), none.skipped[0]?.why);

  const mid = checkCriteria({ criteria: dev, actions: actionsOf([ev.bash('git status')]), claimed: 'silent' });
  check('没声称完成 → 「必须跑过」不核（还在干活）', mid.failed.length === 0);
  check('skipped 写明原因', /没声称完成/.test(mid.skipped[0]?.why ?? ''));
}

console.log('\n④ 红线：任何时候都核，且只抓"按进程名"的写法');
{
  const dev = criteriaFor('dev');
  const hit = checkCriteria({ criteria: dev, actions: actionsOf([ev.bash('Get-Process node | Stop-Process -Force')]), claimed: 'silent' });
  check('Get-Process node | Stop-Process 被抓住', hit.failed.some((f) => /按进程名清杀/.test(f.id)), JSON.stringify(hit.failed.map((f) => f.id)));
  check('抓到时把原命令贴出来（可对账）', /Get-Process/.test(hit.failed[0]?.why ?? ''), hit.failed[0]?.why);

  const pidKill = checkCriteria({ criteria: dev, actions: actionsOf([ev.bash('taskkill /PID 1234 /F')]), claimed: 'silent' });
  check('taskkill /PID（按 PID 清理）不算违规', pidKill.failed.length === 0, JSON.stringify(pidKill.failed));

  const imKill = checkCriteria({ criteria: dev, actions: actionsOf([ev.bash('taskkill /F /IM node.exe')]), claimed: 'silent' });
  check('taskkill /IM node.exe 被抓住', imKill.failed.some((f) => /按进程名清杀/.test(f.id)));
}

console.log('\n⑤ 接线：判据进契约、收尾核对挂在台账核对之后');
{
  const dev = criteriaFor('dev');
  const lines = criteriaLines(dev);
  check('契约行有"平台收尾会核"的硬口径', lines.some((l) => /平台收尾会核/.test(l)), lines[0]);
  check('每个动作都在反引号里（照抄就能跑）', lines.some((l) => /`npm test`/.test(l)));
  check('没有判据 → 契约不长一个字', criteriaLines([]).length === 0);

  const contract = taskContractBlock({ criteria: dev });
  check('taskContractBlock 接得住 criteria', /本岗判据/.test(contract) && /npm test/.test(contract));
  check('判据排在验收之前（比验收更硬）', contract.indexOf('本岗判据') < contract.indexOf('- 验收：'));

  const dispatchSrc = read('apps/server/src/dispatch.mjs');
  const serverSrc = read('apps/server/src/server.mjs');
  const metricsSrc = read('tools/persona-metrics.mjs');
  check('dispatch 每轮取判据并传进契约', /criteriaFor\(p\?\.roleKey \?\? member\.roleKey/.test(dispatchSrc) && /tasks: myTasks, criteria \}/.test(dispatchSrc));
  check('收尾核对注册在台账核对之后', serverSrc.indexOf('criteriaAudit.reconcile') > serverSrc.indexOf('taskClaimAudit.reconcile'));
  check('体检脚本能量到判据（这才是"专业度"的可比数）', /判据核对/.test(metricsSrc) && /dedupeKey LIKE 'criteria:%'/.test(metricsSrc));
  check('平台级红线只有一条（扩张要单独推演误判）', BASE_CRITERIA.length === 1, String(BASE_CRITERIA.length));
  check('判据 id 不重复（红线 + 手册去重）', new Set(dev.map((c) => c.id)).size === dev.length);
}

console.log(`\n结论：${failed ? `${failed} 项没过` : '全通过'}`);
process.exit(failed ? 1 : 0);
