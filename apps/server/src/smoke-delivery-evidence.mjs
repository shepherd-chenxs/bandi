/**
 * **卡到底算没做完** —— 客观证据的验收（2026-11-21）。
 *
 * 起因（用户实报 pt-4b6bf1ec）：活干完了、PR #83 合了、80 项冒烟全过，只因为回话里漏写
 * `[完成]`，卡就一直挂在「已阻塞」，还得人来问"这是完成了吗"。病根是**完成判据全押在
 * 员工记得写字上** —— 那是语义约定，不是事实。
 *
 * 本用例钉住两件东西：
 *   ① `evidenceOf()` 的分型：什么时候算"有硬证据"、什么时候算"反对"、什么时候必须作废；
 *   ② `advanceByEvidence()` 的四道闸：只动「已阻塞」、只认强证据、人压着的不动、员工自报
 *      受阻的不翻案；而且**终点只能是「待验收」**（证据再硬也不越过验收人）。
 *
 * 纯判据 + 临时库，不联网、不起服务：node apps/server/src/smoke-delivery-evidence.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-evidence-'));
process.env.BANDI_DATA = tmp;
process.env.BANDI_DB = path.join(tmp, 'bandi.db');

// ⚠️ 环境变量要在 import 之前设好（store 一加载就开库）
const store = await import('./store.mjs');
const pt = await import('./project-tasks.mjs');
const { evidenceOf, EVIDENCE_MAX_AGE_MS } = await import('./delivery-evidence.mjs');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

const NOW = Date.parse('2026-11-21T12:00:00.000Z');
const at = (msAgo) => new Date(NOW - msAgo).toISOString();
const card = (o = {}) => ({ prState: 'open', prCiState: null, prCiFailed: null, prCiAt: null, ...o });

/* ------------------------------------------------------- ① 分型：什么算证据 */
console.log('① 分型：合并最强、CI 绿次强、CI 红是反对、旧结论作废');

const merged = evidenceOf(card({ prState: 'merged' }), { now: NOW });
check('PR 已合并 → 强证据', merged.verdict === 'strong' && merged.source === 'pr-merged', merged.why);
const mergedRed = evidenceOf(card({ prState: 'merged', prCiState: 'failure', prCiAt: at(0) }), { now: NOW });
check('合并了但 CI 是红的 → 仍算强（人已经放行，代码进主干了）', mergedRed.verdict === 'strong', mergedRed.why);

const green = evidenceOf(card({ prCiState: 'success', prCiAt: at(60 * 1000) }), { now: NOW });
check('开着 + CI 全绿（新鲜）→ 强证据', green.verdict === 'strong' && green.source === 'ci-green', green.why);

const stale = evidenceOf(card({ prCiState: 'success', prCiAt: at(EVIDENCE_MAX_AGE_MS + 60 * 1000) }), { now: NOW });
check('隔夜的全绿不算数（结论会过期）', stale.verdict === 'none' && /过期/.test(stale.why), stale.why);
const noTime = evidenceOf(card({ prCiState: 'success' }), { now: NOW });
check('有结论但没有取数时间 → 当过期（拿不准的旧结论不配当证据）', noTime.verdict === 'none', noTime.why);
const badTime = evidenceOf(card({ prCiState: 'success', prCiAt: '昨天' }), { now: NOW });
check('取数时间是坏值 → 同样当过期', badTime.verdict === 'none', badTime.why);

const red = evidenceOf(card({ prCiState: 'failure', prCiFailed: 'check-pr、run-smokes', prCiAt: at(48 * 3600 * 1000) }), { now: NOW });
check('CI 红 → 反对，且不怕旧（要变绿必然有新提交，会刷新时间）',
  red.verdict === 'contra' && /check-pr/.test(red.why), red.why);

const pend = evidenceOf(card({ prCiState: 'pending', prCiAt: at(1000) }), { now: NOW });
check('CI 还在跑 → 等（不是证据，也不是反对）', pend.verdict === 'pending', pend.why);

const none = evidenceOf(card({ prCiState: 'none', prCiAt: at(1000) }), { now: NOW });
check('仓库没配检查 → 没证据', none.verdict === 'none' && /没配/.test(none.why), none.why);
check('没关联 PR 的卡 → 没证据', evidenceOf(card({ prState: null }), { now: NOW }).verdict === 'none');
check('没卡 → 没证据（不炸）', evidenceOf(null).verdict === 'none');

/* ------------------------------------------- ② 四道闸：什么情况下才许推进 */
console.log('\n② 推进的四道闸：只动已阻塞、只认强证据、人压着的和自报受阻的不动');

const project = store.listProjects()[0];
const mk = (title, o = {}) => {
  const row = store.createProjectTask({ projectId: project.id, title, status: 'blocked' });
  const { id: _drop, ...fields } = o;
  return store.updateProjectTask(row.id, fields);
};
const NOTE = '---\n[运行结束] 跑完了，但没有交回可验收的结论（没写 [完成]，也没写 [受阻]）—— 卡停在「已阻塞」';

const c1 = mk('合并了但漏写标记', { prRepo: 'a/b', prNumber: 1, prState: 'merged', description: NOTE });
const r1 = pt.advanceByEvidence(c1);
check('已阻塞 + PR 合并 → 待验收', r1.status === 'review', r1.status);
check('描述里写明**依据**（不是凭空改状态）', /\[证据推进\]/.test(r1.description) && /已合并/.test(r1.description), r1.description.split('\n').at(-1));
check('没有直接「已完成」（验收权还在人手里）', r1.status !== 'done');

const c2 = mk('CI 全绿但漏写标记', {
  prRepo: 'a/b', prNumber: 2, prState: 'open', prCiState: 'success', prCiAt: new Date().toISOString(), description: NOTE,
});
check('已阻塞 + CI 全绿 → 待验收', pt.advanceByEvidence(c2).status === 'review');

const c3 = mk('CI 红着', { prRepo: 'a/b', prNumber: 3, prState: 'open', prCiState: 'failure', prCiFailed: 'gate', prCiAt: new Date().toISOString(), description: NOTE });
check('已阻塞 + CI 红 → 不动（证据不能反过来帮他过关）', pt.advanceByEvidence(c3).status === 'blocked');

const c4 = mk('证据过期', { prRepo: 'a/b', prNumber: 4, prState: 'open', prCiState: 'success', prCiAt: new Date(Date.now() - EVIDENCE_MAX_AGE_MS * 2).toISOString(), description: NOTE });
check('已阻塞 + 旧的全绿 → 不动', pt.advanceByEvidence(c4).status === 'blocked');

const c5 = mk('人压着的账', { prRepo: 'a/b', prNumber: 5, prState: 'merged', description: NOTE, statusByUserId: 'u-boss' });
check('人手动拖到「已阻塞」的 → 不替他翻案', pt.advanceByEvidence(c5).status === 'blocked');

const c6 = mk('员工自报受阻', {
  prRepo: 'a/b', prNumber: 6, prState: 'merged',
  description: '---\n[运行结束] 跑完了，员工自报受阻（[受阻]）：迁移脚本少个环境变量，等你拍板',
});
check('员工自己说做不成/要拍板的 → 不翻案（证据强不代表他的顾虑消失）',
  pt.advanceByEvidence(c6).status === 'blocked');

const c7 = mk('进行中', { prRepo: 'a/b', prNumber: 7, prState: 'merged', status: 'doing', description: NOTE });
check('「进行中」不归它管（那条是 afterMerged）', pt.advanceByEvidence(c7).status === 'doing');
const c8 = mk('跑挂了', { prRepo: 'a/b', prNumber: 8, prState: 'merged', status: 'failed', description: '---\n[运行结束] 跑挂了：退出码 1' });
check('「失败」不归它管（不能因为 PR 合了就把"这轮崩了"抹掉）', pt.advanceByEvidence(c8).status === 'failed');
const c9 = mk('已验收', { prRepo: 'a/b', prNumber: 9, prState: 'merged', status: 'review', description: NOTE });
check('「待验收」不归它管（别把人的进度改回去）', pt.advanceByEvidence(c9).status === 'review');

const again = pt.advanceByEvidence(store.getProjectTask(c1.id));
check('幂等：已推进过的卡再调一次不再动（也不会重复写描述）',
  again.status === 'review' && again.description === r1.description);

console.log(failed ? `\n✗ ${failed} 条没过` : '\n✓ 全过');
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 库还开着，删不掉就算了 */ }
process.exit(failed ? 1 : 0);
