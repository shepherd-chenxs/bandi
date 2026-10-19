/**
 * PR 联动的离线验收（2026-10-17）。
 *
 * 这轮打通的链路：卡片关联 GitHub PR → 平台去 GitHub 查状态 → 存库里 → **合并后转「待确认」**。
 * 需要网络的那半截（真查 GitHub）不在这里跑；这里验的是**解析 / 存 / 状态机**这三件不联网的事，
 * 它们恰恰是最容易写错、也最容易被忽略的。
 *
 * 跑法：node apps/server/src/smoke-pr-link.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-prlink-'));
process.env.BANDI_DATA = tmp;
process.env.BANDI_DB = path.join(tmp, 'bandi.db');

// ⚠️ 必须在设好环境变量之后再 import
const store = await import('./store.mjs');
const git = await import('./git-repos.mjs');
const pt = await import('./project-tasks.mjs');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

const project = store.listProjects()[0];
const mkCard = (title, extra = {}) => {
  const row = store.createProjectTask({ projectId: project.id, title, status: '进行中' });
  store.updateProjectTask(row.id, extra);
  return store.getProjectTask(row.id);
};

console.log('① 解析 PR 引用：链接 / 简写都认，乱七八糟的返回 null');
check('完整链接', JSON.stringify(git.parsePrRef('https://github.com/shepherd-chenxs/bandi/pull/12')) === '{"repo":"shepherd-chenxs/bandi","number":12}', JSON.stringify(git.parsePrRef('https://github.com/shepherd-chenxs/bandi/pull/12')));
check('带尾巴（files/commits）也认', git.parsePrRef('https://github.com/a/b/pull/3/files')?.number === 3);
check('简写 owner/name#123', git.parsePrRef('a/b#7')?.repo === 'a/b' && git.parsePrRef('a/b#7')?.number === 7);
check('乱写的返回 null', git.parsePrRef('hello world') === null && git.parsePrRef('') === null);
// 只认 github.com：别的形状（没有 owner/name#n、也不是 github 链接）一律返回 null
check('别的形状不认（只认 github.com 的 PR 链接）', git.parsePrRef('a/b/c') === null && git.parsePrRef('pull/1') === null);

console.log('\n② 存：PR 信息能落库、能读回来、能批量捞出来');
const a = mkCard('关联了 PR 的卡', { prRepo: 'shepherd-chenxs/bandi', prNumber: 5, prState: 'open', prTitle: '改了点东西', prCheckedAt: '2026-10-17T00:00:00Z' });
const a2 = store.getProjectTask(a.id);
check('prRepo/prNumber 存住了', a2.prRepo === 'shepherd-chenxs/bandi' && a2.prNumber === 5, `${a2.prRepo}#${a2.prNumber}`);
check('prState/prTitle 存住了', a2.prState === 'open' && a2.prTitle === '改了点东西');
check('批量捞得到它', store.listProjectTasksWithPr().some((t) => t.id === a.id));
check('没 PR 的卡不在批量清单里', store.listProjectTasksWithPr().every((t) => t.prRepo), String(store.listProjectTasksWithPr().length));

console.log('\n③ 合并后：**进行中 → 待确认**，别的一律不动（卡的状态是人的指令）');
const b = mkCard('进行中 + PR 已合并', { prState: 'merged' });
check('进行中 → 待确认', pt.afterMerged(b).status === '待确认', pt.afterMerged(b).status);

const c = mkCard('已完成 + PR 已合并', { prState: 'merged' });
store.updateProjectTask(c.id, { status: '已完成' });
check('已完成不被覆盖', pt.afterMerged(store.getProjectTask(c.id)).status === '已完成');

const d = mkCard('进行中 + PR 还开着', { prState: 'open' });
check('PR 还开着 → 不动', pt.afterMerged(d).status === '进行中');

const e = mkCard('进行中 + PR 已关闭（没合并）', { prState: 'closed' });
check('PR 关掉但没合并 → 不动', pt.afterMerged(e).status === '进行中');

const f = mkCard('进行中 + 没有 PR');
check('没有 PR → 不动', pt.afterMerged(f).status === '进行中');

console.log('\n④ 取消关联：四个字段一起清掉（不留半截状态）');
store.updateProjectTask(a.id, { prRepo: null, prNumber: null, prState: null, prTitle: null, prCheckedAt: null });
const a3 = store.getProjectTask(a.id);
check('四个字段全空', !a3.prRepo && !a3.prNumber && !a3.prState && !a3.prTitle && !a3.prCheckedAt, JSON.stringify({ r: a3.prRepo, n: a3.prNumber, s: a3.prState }));

/*
 * ⑤ 巡检报上来的 PR 形状 → 卡片的五个字段（2026-10-17）。
 * 这是「仓库值班的 PR 卡也有标签」那一半的**唯一一道转换**：转错了，卡上就是「PR null」。
 */
console.log('\n⑤ 巡检报的 PR（html_url / state / merged_at）→ 卡片的五个字段');
const g1 = git.prFieldsOf({ url: 'https://github.com/smoke/demo/pull/42', title: '改了点东西', state: 'merged' });
check('url → repo + number', g1?.prRepo === 'smoke/demo' && g1?.prNumber === 42, JSON.stringify({ r: g1?.prRepo, n: g1?.prNumber }));
check('state 原样（merged）', g1?.prState === 'merged');
check('title 带上，且盖了查询时间', g1?.prTitle === '改了点东西' && !!g1?.prCheckedAt);
check('不认识的 state → 归一成 open', git.prFieldsOf({ url: 'https://github.com/a/b/pull/1', state: 'whatever' })?.prState === 'open');
check('没 title → null（别留空串，界面上会画出空白标签）', git.prFieldsOf({ url: 'https://github.com/a/b/pull/1' })?.prTitle === null);
// 解析不出就整个不要：宁可这张卡没有 PR 字段，也不要写半截进库
check('没带 url → null', git.prFieldsOf({ title: 'x' }) === null);
check('不是 github 的 PR 链接 → null', git.prFieldsOf({ url: 'https://gitlab.com/a/b/merge_requests/1' }) === null);
check('不带 pr 整个入参 → null', git.prFieldsOf(undefined) === null);
const g2 = git.prFieldsOf({ url: 'https://github.com/smoke/demo/pull/43/files', title: 't', state: 'open' });
check('带 /files 尾巴也认', g2?.prNumber === 43 && g2?.prState === 'open', JSON.stringify(g2?.prNumber));

console.log('\n⑥ 值班卡（source=repo）落库后：进得了「刷新 PR」的批量清单、看板行上带得出 pr');
const repoCard = store.createProjectTask({ projectId: project.id, title: 'PR #42 待审：x', status: '待办', source: 'repo', externalKey: 'pr:42' });
store.updateProjectTask(repoCard.id, g1);
const rc = store.getProjectTask(repoCard.id);
check('值班卡带上了 PR 字段', rc.prNumber === 42 && rc.prState === 'merged', `${rc.prRepo}#${rc.prNumber} ${rc.prState}`);
check('批量清单收得到值班卡（=「刷新 PR」能刷到它）', store.listProjectTasksWithPr().some((t) => t.id === repoCard.id));
const board = pt.projectTasks(project);
const boardRow = (board?.columns ?? []).flatMap((c) => c.cards ?? []).find((r) => r.source === 'repo' && r.pr);
check('看板行里带 pr（卡片标签吃这个字段）', !!boardRow && boardRow.pr.number === 42, JSON.stringify(boardRow?.pr));
check('合并了，但卡在「待办」→ afterMerged 也不动（人还没看）', pt.afterMerged(store.getProjectTask(repoCard.id)).status === '待办');

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* 删不掉就算了 */
}
console.log(`\n结论：${failed ? `有 ${failed} 项没通过` : '全通过'}`);
process.exit(failed ? 1 : 0);
