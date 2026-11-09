/**
 * 任务卡「运行结束」后状态怎么收（2026-10-17 建；2026-10-24 状态重设计；2026-11-09 P4 交付声明）。
 *
 * 落点口径（2026-10-24 定稿 / 2026-11-09 补「交付声明」，与流程步骤同一套）：
 *   · 跑完 + 回话第一行 `[完成]`            → **待验收**（等经办人验收结果）
 *   · 跑完 + 回话第一行 `[受阻] 原因`       → **已阻塞**（等人拍板；员工自己说没干成）
 *   · 跑完 + 没有标记 / 空回话 / 纯空白     → **已阻塞**（没交回可验收的结论）
 *     —— 为什么不再进「待验收」：进程正常退出（exit 0）只说明它跑完了，不说明活干成了。
 *        pt-a6841a5b/r-551f01e3 就是正常退出 + 空回话被自动推进「待验收」，
 *        等于平台替员工宣布交付、替雇主宣布验收通过（用户原话：「这是糊弄用户」）。
 *   · 人停的            → **已阻塞**（等人决定下一步）
 *   · 跑挂了            → **失败**（技术上失败，跟流程跑挂同一落点，可重跑）
 *   · **绝不回「待办」** —— 有些待办会被自动重新派活，失败一次再派一次 → 死循环
 *     （「失败」「已阻塞」都不会被自动重派：重派只认「待办」+ queuedAt）
 *   · 人已经手动改过状态（比如直接拖到「已完成」）→ **不覆盖**（卡的状态是人的指令）
 *
 * 这个收尾挂在 `runs.onRunFinish` 上（finish() 是所有运行的唯一终点），本用例直接调那个函数。
 * `run` 对象从 P4 起带 `finalText`（员工最终回话）—— 判交付声明看它第一个/最后一个非空行。
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

console.log('\n② 跑挂了 → 失败（跟流程跑挂同一落点），并带上失败原因');
const b = makeRunningCard('跑挂的活', 'r-failed');
pt.onTaskRunFinished({ id: 'r-failed', status: '失败', error: '起不来：spawn ENOENT\nmore lines' });
const b2 = store.getProjectTask(b.id);
check('状态 = 失败', b2.status === '失败', b2.status);
check('原因只取第一行（不把整段 stderr 灌进卡片）', b2.description.includes('spawn ENOENT') && !b2.description.includes('more lines'));

console.log('\n③ 跑完 ≠ 干完了：只认回话第一行的 [完成] / [受阻]');
const c = makeRunningCard('跑完的活', 'r-done');
pt.onTaskRunFinished({
  id: 'r-done',
  status: '完成',
  finalText: '[完成] 部署完成：服务已起在 127.0.0.1:3000，healthz 返回 200。',
});
const c2 = store.getProjectTask(c.id);
check('完成 + 第一行 [完成] → 待验收', c2.status === '待验收', c2.status);

// 员工自己说"没干成" → 平台必须按受阻落，不能因为进程正常退出就放行
const cBlocked = makeRunningCard('被安全策略挡住的活', 'r-blocked');
pt.onTaskRunFinished({
  id: 'r-blocked',
  status: '完成',
  finalText: '[受阻] SSH 被安全策略挡住：10.0.0.8 连不上，需要你批密钥或改端口。\n\n部署命令已备好，批了我再跑。',
});
const cBlocked2 = store.getProjectTask(cBlocked.id);
check('完成 + 第一行 [受阻] → 已阻塞（不是待验收）', cBlocked2.status === '已阻塞', cBlocked2.status);
check('描述里写明"员工自报受阻"（平台不替他宣布干完了）',
  /受阻/.test(cBlocked2.description) && !/等你验收/.test(cBlocked2.description), JSON.stringify(cBlocked2.description));
check('受阻原因带进卡描述（看板一眼知道卡在哪，不用翻会话）',
  /\[受阻\]）：/.test(cBlocked2.description) && cBlocked2.description.includes('SSH'), JSON.stringify(cBlocked2.description));

// P5：标记也可以放最后一行（问答题第一行留给答案）—— 原因要取末行那句，不能拿答案首行充数
const cBlockedLast = makeRunningCard('末行报受阻的活', 'r-blocked-last');
pt.onTaskRunFinished({
  id: 'r-blocked-last',
  status: '完成',
  finalText: '现状：服务器能连上，但生产库写权限没批。\n\n[受阻] 需要你批生产库写权限',
});
const cBlockedLast2 = store.getProjectTask(cBlockedLast.id);
check('完成 + 末行 [受阻] → 已阻塞', cBlockedLast2.status === '已阻塞', cBlockedLast2.status);
check('末行受阻：原因取末行那句（不是答案首行）',
  /\[受阻\]）：/.test(cBlockedLast2.description) && cBlockedLast2.description.includes('生产库写权限') &&
    !cBlockedLast2.description.includes('现状：服务器能连上'), JSON.stringify(cBlockedLast2.description));

// 空回话：运行结束但一个字没交回 —— 这正是事故形态，必须如实写清楚
const cEmpty = makeRunningCard('空回话的活', 'r-empty');
pt.onTaskRunFinished({ id: 'r-empty', status: '完成', finalText: '' });
const cEmpty2 = store.getProjectTask(cEmpty.id);
check('完成 + 空回话 → 已阻塞（没交回可验收的结论）', cEmpty2.status === '已阻塞', cEmpty2.status);
check('空回话的描述写明「没有交回可验收的结论」/「没有回话」',
  /(没有|没)交回可验收的结论|(没有|没)回话/.test(cEmpty2.description), JSON.stringify(cEmpty2.description));
check('空回话不再写「跑完了，等你验收」', !cEmpty2.description.includes('跑完了，等你验收'), JSON.stringify(cEmpty2.description));

// 纯空白 = 同样什么都没交回（"\n\n\n" 不是回话）
const cBlank = makeRunningCard('纯空白的活', 'r-blank');
pt.onTaskRunFinished({ id: 'r-blank', status: '完成', finalText: '\n\n\n' });
const cBlank2 = store.getProjectTask(cBlank.id);
check('完成 + 纯空白（\\n\\n\\n）→ 已阻塞', cBlank2.status === '已阻塞', cBlank2.status);
check('纯空白不算 [完成]（没有回话就不进待验收）',
  !cBlank2.description.includes('跑完了，等你验收') && cBlank2.status !== '待验收', JSON.stringify(cBlank2.description));

// 说了"已改好"但没写标记：平台不知道这算不算交回结论 → 不许替员工猜成待验收
const cNoMark = makeRunningCard('没写标记的活', 'r-nomark');
pt.onTaskRunFinished({ id: 'r-nomark', status: '完成', finalText: '已改好，但 Next: 还要等部署审批。' });
const cNoMark2 = store.getProjectTask(cNoMark.id);
check('完成 + 没有标记（哪怕写了「已改好」）→ 已阻塞', cNoMark2.status === '已阻塞', cNoMark2.status);
check('没标记的描述如实写「没有交回可验收的结论」',
  /(没有|没)交回可验收的结论/.test(cNoMark2.description), JSON.stringify(cNoMark2.description));
check('没标记的描述也不再出现「跑完了，等你验收」',
  !cNoMark2.description.includes('跑完了，等你验收'), JSON.stringify(cNoMark2.description));

// P5（2026-11-09）：问答题的第一行要留给答案，交付标记放**最后一行** —— 两处都认。
const cLastLine = makeRunningCard('标记在最后一行的活', 'r-last-line');
pt.onTaskRunFinished({ id: 'r-last-line', status: '完成', finalText: '权限归平台，不归员工。\n\n依据：…\n\n[完成]' });
const cLastLine2 = store.getProjectTask(cLastLine.id);
check('标记放最后一行 → 待验收（问答类交付）', cLastLine2.status === '待验收', cLastLine2.status);

// 正文中间提到 [完成] 不算（只认第一行/最后一行行首）
const cMidLine = makeRunningCard('标记在正文中间的活', 'r-mid-line');
pt.onTaskRunFinished({ id: 'r-mid-line', status: '完成', finalText: '部署做了一半。\n[完成] 这句是正文里顺手写的\n还没做完，等你拍板' });
const cMidLine2 = store.getProjectTask(cMidLine.id);
check('标记只在正文中间 → 不算交付（只认首行/末行）', cMidLine2.status === '已阻塞', cMidLine2.status);

console.log('\n④ 人已经手动改过 → 不许覆盖（卡的状态是人的指令）');
const d = makeRunningCard('人已经拖走的活', 'r-moved');
store.updateProjectTask(d.id, { status: '已完成' });
pt.onTaskRunFinished({ id: 'r-moved', status: '已停止' });
check('还是「已完成」', store.getProjectTask(d.id).status === '已完成', store.getProjectTask(d.id).status);

console.log('\n⑤ 对不上的 runId / 已经收过尾的卡 → 什么都不做');
pt.onTaskRunFinished({ id: 'r-不存在', status: '已停止' });
pt.onTaskRunFinished({ id: 'r-done', status: '完成', finalText: '[完成] 再声明一次' }); // 第二次
check('未知 run 不炸', true);
// 卡已经是「待验收」，第二次收尾必须直接返回 —— 描述里的 [运行结束] 不能被堆成两段
const finishMarks = (store.getProjectTask(c.id).description.match(/\[运行结束\]/g) ?? []).length;
check('重复收尾不会把描述越堆越长', finishMarks === 1, String(finishMarks));

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* 删不掉就算了 */
}
console.log(`\n结论：${failed ? `有 ${failed} 项没通过` : '全通过'}`);
process.exit(failed ? 1 : 0);
