/**
 * 任务卡「运行结束」后状态怎么收（2026-10-17）。
 *
 * 用户定的口径（别改）：
 *   · 跑完了            → **待确认**（等经办人确认结果）
 *   · 人停的 / 跑挂了    → **已阻塞**（进「停下等人」，管理员看到再处理）
 *   · **绝不回「待办」** —— 有些待办会被自动重新派活，失败一次再派一次 → 死循环
 *   · 人已经手动改过状态（比如直接拖到「已完成」）→ **不覆盖**（卡的状态是人的指令）
 *
 * 这个收尾挂在 `runs.onRunFinish` 上（finish() 是所有运行的唯一终点），本用例直接调那个函数。
 * 跑法：node apps/server/src/smoke-task-run-sync.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-task-run-'));
process.env.BANDI_DATA = tmp;
process.env.BANDI_DB = path.join(tmp, 'bandi.db');

// ⚠️ 必须在设好环境变量之后再 import（config 在模块加载时读）
const store = await import('./store.mjs');
const pt = await import('./project-tasks.mjs');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

const project = store.listProjects()[0];

/** 造一张"正在跑"的卡，并把它和某个 runId 绑上 */
function makeRunningCard(title, runId) {
  const row = store.createProjectTask({ projectId: project.id, title, status: '进行中' });
  store.updateProjectTask(row.id, { runId });
  return store.getProjectTask(row.id);
}

console.log('① 人把运行停掉 → 卡进「已阻塞」（不是待办）');
const a = makeRunningCard('人停的活', 'r-stopped');
pt.onTaskRunFinished({ id: 'r-stopped', status: '已停止' });
const a2 = store.getProjectTask(a.id);
check('状态 = 已阻塞', a2.status === '已阻塞', a2.status);
check('描述里留了收尾说明', /\n\[运行结束\]/.test(a2.description) && a2.description.includes('停'), JSON.stringify(a2.description));
check('没有回「待办」（那会被自动重新派活 → 死循环）', a2.status !== '待办');

console.log('\n② 跑挂了 → 也已阻塞，并带上失败原因');
const b = makeRunningCard('跑挂的活', 'r-failed');
pt.onTaskRunFinished({ id: 'r-failed', status: '失败', error: '起不来：spawn ENOENT\nmore lines' });
const b2 = store.getProjectTask(b.id);
check('状态 = 已阻塞', b2.status === '已阻塞', b2.status);
check('原因只取第一行（不把整段 stderr 灌进卡片）', b2.description.includes('spawn ENOENT') && !b2.description.includes('more lines'));

console.log('\n③ 跑完了 → 待确认');
const c = makeRunningCard('跑完的活', 'r-done');
pt.onTaskRunFinished({ id: 'r-done', status: '完成' });
const c2 = store.getProjectTask(c.id);
check('状态 = 待确认', c2.status === '待确认', c2.status);

console.log('\n④ 人已经手动改过 → 不许覆盖（卡的状态是人的指令）');
const d = makeRunningCard('人已经拖走的活', 'r-moved');
store.updateProjectTask(d.id, { status: '已完成' });
pt.onTaskRunFinished({ id: 'r-moved', status: '已停止' });
check('还是「已完成」', store.getProjectTask(d.id).status === '已完成', store.getProjectTask(d.id).status);

console.log('\n⑤ 对不上的 runId / 已经收过尾的卡 → 什么都不做');
pt.onTaskRunFinished({ id: 'r-不存在', status: '已停止' });
pt.onTaskRunFinished({ id: 'r-done', status: '完成' }); // 第二次
check('未知 run 不炸', true);
check('重复收尾不会把描述越堆越长', (store.getProjectTask(c.id).description.match(/\[运行结束\]/g) ?? []).length === 1, String((store.getProjectTask(c.id).description.match(/\[运行结束\]/g) ?? []).length));

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* 删不掉就算了 */
}
console.log(`\n结论：${failed ? `有 ${failed} 项没通过` : '全通过'}`);
process.exit(failed ? 1 : 0);
