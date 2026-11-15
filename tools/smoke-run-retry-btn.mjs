/*
 * 「重跑这一步」按钮的离线自检（2026-11-13）。
 *
 * 为什么单开这一条：这颗按钮 2026-10-18 被删过（"改状态成待办就是重跑"），2026-11-13 实报后
 * 又加回来 —— 这种"删了加、加了删"最容易在下一次收拾界面时**又一次被顺手删掉**，
 * 而且删了不报错，只是失败那一步没有入口、人又得去猜。所以用源码级断言把三件事钉住：
 *   ① 按钮在（data-run-retry），且只在 失败 / 已阻塞 时出现（待办/进行中不出现，避免重复派活）；
 *   ② 点击走 `/retry` —— 跟"把状态改成待办"同一条路，不许另写一套派活；
 *   ③ 状态下拉**没被动**（这次只加入口，状态那套牵扯"想法拖进待办就自动开工"，要统一规划）。
 *
 * 前端没有构建步骤，CI 只过 `node --check` —— 跟 smoke-branch-menu / smoke-help-pop 同一套做法。
 * 跑：node tools/smoke-run-retry-btn.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8').replace(/\r\n/g, '\n');
const src = read('apps/web/js/flowpages.mjs');
const wf = read('apps/server/src/workflows.mjs');

let bad = 0;
const check = (ok, msg, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${msg}${detail ? ' — ' + detail : ''}`);
  if (!ok) bad += 1;
};

console.log('① 按钮在，且只在需要它的时候出现');
check(src.includes('data-run-retry'), '当前这一步那一行画出了「重跑这一步」（data-run-retry）');
check(
  /!v\.quotaBlocked && \(v\.taskStatus === 'failed' \|\| v\.taskStatus === 'blocked'\)/.test(src),
  '只给「失败 / 已阻塞」（待办和进行中不出现 —— 那两个态点了只会重复派活）',
);
check(
  /额度拦下的那一步不摆这颗/.test(src),
  '额度拦下的不摆（那颗有自己的「继续一次」，重跑只会再撞一次闸）',
);
check(
  /data-run-retry[^>]*title="\$\{why\}/.test(src) || /title="\$\{why\}[^>]*data-run-retry/.test(src),
  '按钮带 title，说清"会重新派给经办人再办一次"',
);
// 2026-11-13 二次实报：按钮代码在，但页面上看不见 —— `blocked`（"没人办"）原先看模板节点
// `curNode.assigneeName`，而按岗位自动指派的节点模板里不写人名，于是恒判"没人"，
// 行内动作整块不渲染（连带通过/驳回）。判据必须是**当前任务实际的经办人**。
check(
  /const blocked = v\.status === 'doing' && !v\.assigneePersonaId;/.test(src),
  '"没人办"按当前任务的实际经办人判（v.assigneePersonaId），不看模板节点有没有点名',
);
check(
  !/const blocked = v\.status === 'doing' && curNode && !curNode\.assigneeName/.test(src),
  '退回旧判据（curNode.assigneeName）会再次把自动指派的那一步吞掉',
);

console.log('\n② 走的是同一条路，不是第二套实现');
check(
  /runs\/\$\{encodeURIComponent\(v\.id\)\}\/retry/.test(src),
  '点击调 `/api/workflows/runs/:id/retry`',
);
check(
  /act\[2\] === 'retry' \? workflows\.retryCurrentStep\(id\)/.test(read('apps/server/src/routes/workflow.mjs')),
  '路由侧确实接到 workflows.retryCurrentStep',
);
check(
  /export function retryCurrentStep[\s\S]{0,1500}?setStepStatus\(runId, 'todo'\)/.test(wf),
  'retryCurrentStep = setStepStatus(todo)，与「改状态成待办」同一语义',
);
check(
  src.includes('retryBtn.disabled = true'),
  '点下去先禁用（重跑会真派活 / action 节点会真去建 PR，防连点）',
);

console.log('\n③ 状态字只显示、不可改（2026-11-13 晚用户拍板：这里不要修改状态了）');
check(
  !/id="runStatusMount"|querySelector\('#runStatusMount'\)/.test(src),
  '行内状态选择器（runStatusMount）已整段撤掉（挂载点和接线都不许留）',
);
check(
  !/runs\/\$\{encodeURIComponent\(v\.id\)\}\/status/.test(src),
  '前端不再调 /status 改这一步的状态（接口本身保留，等状态那套统一规划）',
);
check(
  /状态\*\*只显示、不改\*\*|状态只显示、不可改/.test(src),
  '原地留了注释，说明为什么状态归流程引擎管、别再摆编辑入口',
);
check(!src.includes('「重跑这一步」已删'), '旧的"已删"注释没留下 —— 它会把人带错路');

console.log(bad ? `\n✗ ${bad} 项没过` : '\n✓ 全过');
process.exit(bad ? 1 : 0);
