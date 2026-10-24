/**
 * PR 审阅与授权合并的离线验收（2026-10-23，docs/PRD-2026-10-23-PR审阅与授权合并.md）。
 *
 * 需要网络的那截（真去 GitHub 拉 PR / 调合并 API）不在这里跑 —— 这里钉的是**判据与接线**：
 * 结论解析、四条闸、敏感文件、模板形状、动作节点在引擎里的语义（不点名不阻塞、拍板钩子）。
 * 这些恰恰是最容易写错、写错了最危险的部分：闸门判错 = 垃圾 PR 被自动合。
 *
 * 跑法：node apps/server/src/smoke-pr-review.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-prreview-'));
process.env.BANDI_DATA = tmp;
process.env.BANDI_DB = path.join(tmp, 'bandi.db');

// ⚠️ 必须在设好环境变量之后再 import
const store = await import('./store.mjs');
const pr = await import('./pr-review.mjs');
const wf = await import('./workflows.mjs');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

console.log('① 结论解析：三档 + 取最后一次 + 没有就按「拿不准」');
check('值得合', pr.parseVerdict('分析了一堆\n结论：值得合') === 'worth');
check('垃圾', pr.parseVerdict('结论：垃圾（广告）') === 'spam');
check('拿不准', pr.parseVerdict('结论：拿不准') === 'unsure');
check('取最后一次（模型爱先说过程）', pr.parseVerdict('结论：拿不准\n再看一遍\n结论：值得合') === 'worth');
check('没写结论 = 拿不准（不许装懂）', pr.parseVerdict('看起来还行吧') === 'unsure');
check('空文本 = 拿不准', pr.parseVerdict('') === 'unsure');

console.log('\n② 敏感文件：CI / 鉴权 / 令牌 / .env 命中，普通文件不命中');
const hits = pr.touchSensitive([
  { filename: '.github/workflows/pr.yml' },
  { filename: 'apps/server/src/auth.mjs' },
  { filename: 'docs/token.md' },
  { filename: 'tools/check-pr.mjs' },
  { filename: '.env.local' },
]);
check('CI 工作流命中', hits.includes('.github/workflows/pr.yml'));
check('auth.mjs 命中', hits.includes('apps/server/src/auth.mjs'));
check('token.md 命中（文档也算，宁可多问一句人）', hits.includes('docs/token.md'));
check('.env 命中', hits.includes('.env.local'));
check('普通代码不命中', !hits.includes('tools/check-pr.mjs'));
check('干净 PR 返回空', pr.touchSensitive([{ filename: 'README.md' }]).length === 0);

console.log('\n③ 四条闸（PRD 第六节）：缺一不过，全过才放行');
const okFiles = [{ filename: 'tools/x.mjs', additions: 10, deletions: 2 }];
const g1 = pr.evaluateGates({ verdict: 'worth', checksState: 'success', files: okFiles, additions: 10, deletions: 2 });
check('全过 → pass', g1.pass === true, JSON.stringify(g1.reasons));
check('结论不是值得合 → 不过', pr.evaluateGates({ verdict: 'unsure', checksState: 'success', files: okFiles }).pass === false);
check('没有 CI 状态 → 不过（没绿不算过）', pr.evaluateGates({ verdict: 'worth', checksState: 'none', files: okFiles }).pass === false);
check('CI 有红的 → 不过', pr.evaluateGates({ verdict: 'worth', checksState: 'failure', files: okFiles }).pass === false);
check('碰敏感文件 → 不过', pr.evaluateGates({ verdict: 'worth', checksState: 'success', files: [{ filename: '.github/workflows/pr.yml' }] }).pass === false);
const big = pr.evaluateGates({ verdict: 'worth', checksState: 'success', files: okFiles, additions: 300, deletions: 200 });
check('改动量超上限 → 不过', big.pass === false && big.reasons[0].includes('超过上限'), JSON.stringify(big.reasons));
check('原因是人话（能直接贴进卡里）', g1.pass || g1.reasons.every((r) => typeof r === 'string' && r.length > 4));

console.log('\n④ 内建模板：两个节点，合并节点是平台动作、不是聊天任务');
pr.ensurePrReviewTemplate();
const tpl = store.getWorkflowTemplate(pr.PR_REVIEW_TEMPLATE_ID);
const nodes = JSON.parse(tpl?.nodes ?? '[]');
check('模板建出来了', !!tpl);
check('审阅 + 合并 两个节点', nodes.length === 2, nodes.map((n) => n.name).join('/'));
check('合并节点是动作节点', nodes.find((n) => n.id === 'n2')?.action === 'pr-merge');
check('审阅节点**不点名**经办人（派给谁是仓库说了算）', nodes.find((n) => n.id === 'n1')?.personaId === undefined);
check('幂等：再 ensure 一次还是两份节点', (pr.ensurePrReviewTemplate(), JSON.parse(store.getWorkflowTemplate(pr.PR_REVIEW_TEMPLATE_ID).nodes).length === 2));

console.log('\n⑤ 引擎：动作节点没经办人**不标阻塞**（与人工节点相反）');
const tplId = 'smoke-action-tpl';
store.upsertWorkflowTemplate({
  id: tplId,
  name: '动作节点测试',
  builtIn: false,
  start: 'a1',
  nodes: [{ id: 'a1', name: '平台动作', action: 'smoke-fake', approve: 'end', reject: 'end' }],
  publishedAt: null,
});
let seenDecide = null;
wf.registerActionNode('smoke-fake', {
  run: async () => {}, // 什么也不做：这条用例只看任务状态，不跑真动作
  // 只接「通过」（跟生产里的 pr-merge 同一个形状）：驳回让引擎走默认出口
  onDecide: ({ decision }) => {
    seenDecide = decision;
    return decision === '通过';
  },
});
const run1 = wf.startWorkflow({ templateId: tplId, title: '动作节点', intent: '', autoStart: false });
let t1 = store.listWorkflowTasks(run1.id)[0];
check('动作节点到站是「待办」而不是「已阻塞」', t1?.status === '待办', t1?.status);

console.log('\n⑥ 引擎：动作节点的「通过」是**授权执行**，不是放行下一步');
store.updateWorkflowTask(t1.id, { status: '待验收' });
wf.decide(run1.id, '通过');
check('拍板钩子被调到（decision=通过）', seenDecide === '通过');
const runAfter = store.getWorkflowRun(run1.id);
check('引擎没有自己收尾（推进权交给了 handler）', runAfter.status === '进行中', runAfter.status);

const run2 = wf.startWorkflow({ templateId: tplId, title: '动作节点 2', intent: '', autoStart: false });
const t2 = store.listWorkflowTasks(run2.id)[0];
seenDecide = null;
store.updateWorkflowTask(t2.id, { status: '待验收' });
wf.decide(run2.id, '驳回');
check('驳回不触发执行（handler 征询了但拒绝接手）', seenDecide === '驳回');
check('驳回走引擎默认出口 → 流程收尾', store.getWorkflowRun(run2.id).status === '已完成', store.getWorkflowRun(run2.id).status);

console.log('\n⑦ 仓库值班设置：绑定 / 解绑 / 授权开关都存得住');
const repo = store.addGitRepo({ fullName: 'a/b', owner: 'a', name: 'b', localPath: tmp });
check('新仓库默认：没管理员、没授权', !repo.keeperPersonaId && !repo.autoMerge);
const bound = store.updateGitRepoSettings(repo.id, { keeperPersonaId: 'p-cuilaosan', autoMerge: true });
check('绑定 + 授权存住了', bound.keeperPersonaId === 'p-cuilaosan' && bound.autoMerge === 1);
const unbound = store.updateGitRepoSettings(repo.id, { keeperPersonaId: '' });
check('解绑只动管理员，授权不动（PATCH 语义）', !unbound.keeperPersonaId && unbound.autoMerge === 1);
const off = store.updateGitRepoSettings(repo.id, { autoMerge: false });
check('收回授权', off.autoMerge === 0);

console.log('\n⑧ 卡片回写用到的两个抓手：meta（判新）与按键查卡（结论落点）');
store.setMetaValue('prseen:a/b#1', 'sha-1');
check('head.sha 记在 meta 里，重启不丢', store.getMetaValue('prseen:a/b#1') === 'sha-1');
check('按 externalKey 查得到卡', typeof store.getProjectTaskByExternalKey === 'function');

console.log(`\n${failed ? `✗ ${failed} 项没过` : '✓ 全部通过'}`);
process.exit(failed ? 1 : 0);
