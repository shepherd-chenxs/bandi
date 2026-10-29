/**
 * 仓库级巡检（2026-10-29）的离线验收：**代码托管 › 仓库设置 › 巡检**。
 *
 * 验的不是"再写一套调度"—— 恰恰相反，验的是它**没有**第二套调度：
 *   · 每个仓库最多认领一条 `pr-scan` 任务（`config.repo`），改节拍是 update 不是新增；
 *   · 「关闭」= 任务停用、不删（上次结果与「立即巡检」都还留着）；
 *   · 人手工建过的怪节拍（每周一）显示成「自定义」而不是「关闭」；
 *   · 全局任务（`config.repo` 留空 = 扫所有仓库）不归任何仓库、也不会被仓库移除顺手删掉；
 *   · 「立即巡检」：有任务走调度器那条（结果记在 last* 上），没任务直接扫一次、**不为了跑一次建任务**。
 *
 * 全离线：GitHub 那半截在 `prScan` 第一行就因为没有令牌而抛 —— 正好验"失败如实回"。
 *
 * 跑法：node apps/server/src/smoke-repo-patrol.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-patrol-'));

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

/* ⚠️ 环境变量必须在 import 之前设好（store 一加载就开库、建默认项目） */
process.env.BANDI_DATA = tmp;
process.env.BANDI_DB = path.join(tmp, 'bandi.db');

const store = await import('./store.mjs');
const patrol = await import('./repo-patrol.mjs');
const schedules = await import('./schedules.mjs');

const mkRepo = (name) =>
  store.addGitRepo({
    fullName: `smoke/${name}`,
    owner: 'smoke',
    name,
    isPrivate: 0,
    defaultBranch: 'main',
    localPath: path.join(tmp, 'repos', name),
  });

const A = mkRepo('a');
const B = mkRepo('b');
const jobsOf = (repo) => patrol.jobsOfRepo(repo.fullName);

/* ------------------------------------------------------------ ① 初始：关闭、没有任务 */
console.log('① 初始：仓库没配过巡检 = 关闭，且不凭空建任务');
check('初始 preset 是 off', patrol.viewOf(A).preset === 'off', patrol.viewOf(A).preset);
check('初始没有任务', patrol.viewOf(A).jobId === null && jobsOf(A).length === 0);
check('初始没有「上次结果」', !patrol.viewOf(A).lastStatus);

/* ------------------------------------------------------ ② 选节拍：建一条，不是两条 */
console.log('\n② 选「每 30 分钟」：建一条 pr-scan，仓库名记在 config.repo');
const v30 = patrol.setPreset(A, '30m');
const jobA = patrol.jobOf(A);
check('建出来了', !!jobA, jobA?.id);
check('动作是 pr-scan', jobA?.action === 'pr-scan', jobA?.action);
check('config.repo 记住了是哪个仓库', JSON.parse(jobA?.config || '{}').repo === A.fullName);
check('节拍是间隔 30 分钟', jobA?.repeat === 'interval' && jobA?.everyMinutes === 30, `${jobA?.repeat}/${jobA?.everyMinutes}`);
check('默认启用', jobA?.enabled === 1);
check('视图回的是 30m', v30.preset === '30m' && v30.text === '每 30 分钟', `${v30.preset}/${v30.text}`);
check('任务名带仓库名（定时任务页里认得出）', jobA?.name === `PR 巡检 · ${A.fullName}`, jobA?.name);

/* ------------------------------------------------------ ③ 再改：同一条任务，不新增 */
console.log('\n③ 改成「每天 09:00」：还是那一条，不新增');
const vDaily = patrol.setPreset(A, 'daily-09');
const jobA2 = patrol.jobOf(A);
check('任务 id 没变', jobA2?.id === jobA.id, `${jobA.id} → ${jobA2?.id}`);
check('任务条数仍是 1', jobsOf(A).length === 1, String(jobsOf(A).length));
check('节拍变成每天 09:00', jobA2?.repeat === 'daily' && jobA2?.atTime === '09:00', `${jobA2?.repeat}/${jobA2?.atTime}`);
check('视图与说人话文案跟着变', vDaily.preset === 'daily-09' && vDaily.text === '每天 09:00', `${vDaily.preset}/${vDaily.text}`);

console.log('\n③b 「每 12 小时」= 一天两次（间隔 720）');
patrol.setPreset(A, '12h');
check('间隔 720 分钟', patrol.jobOf(A)?.everyMinutes === 720 && patrol.jobOf(A)?.repeat === 'interval', String(patrol.jobOf(A)?.everyMinutes));

/* ------------------------------------------------- ④ 关闭：停用不删，上次结果还留着 */
console.log('\n④ 选「关闭」：停用任务，但任务与上次结果都留着');
const before = patrol.jobOf(A);
const vOff = patrol.setPreset(A, 'off');
const afterOff = patrol.jobOf(A);
check('任务还在（没删）', !!afterOff && afterOff.id === before.id);
check('只是停用', afterOff.enabled === 0);
check('视图是 off', vOff.preset === 'off' && vOff.enabled === false);
check('「立即巡检」还认得这条任务', vOff.jobId === afterOff.id);

/* -------------------------------------------------------- ⑤ 不认识 / 空节拍直接抛 */
console.log('\n⑤ 不认识的节拍：抛错（接口会翻成 400，别存进去了到点不跑）');
const threw = (fn) => {
  try {
    fn();
    return false;
  } catch (e) {
    return String(e?.message ?? e);
  }
};
const bad = threw(() => patrol.setPreset(A, 'every-3-minutes'));
check('不认识的节拍抛错且说清可选值', typeof bad === 'string' && /不认识的巡检节拍/.test(bad) && /30m/.test(bad), String(bad));
check('空值也抛（不是默默存成关闭）', typeof threw(() => patrol.setPreset(A, '')) === 'string');

/* ------------------------------------------------- ⑥ 两个仓库互不影响，移除清任务 */
console.log('\n⑥ 多仓库：各管各的；仓库移除只删它自己的任务');
patrol.setPreset(A, '30m');
patrol.setPreset(B, 'daily-21');
check('两个仓库两条任务', jobsOf(A).length === 1 && jobsOf(B).length === 1);
check('节拍互不串', patrol.jobOf(A)?.everyMinutes === 30 && patrol.jobOf(B)?.atTime === '21:00');

const global = store.createSchedule({ name: '全局巡检（老任务）', action: 'pr-scan', everyMinutes: 30, config: null });
check('全局任务不被任何仓库认领', patrol.jobOf(A)?.id !== global.id && patrol.jobOf(B)?.id !== global.id);

const dropped = patrol.forgetRepo(A.fullName);
check('移除仓库 A：删掉它的 1 条任务', dropped === 1, String(dropped));
check('A 没了、B 还在', jobsOf(A).length === 0 && jobsOf(B).length === 1);
check('全局任务没被顺手删', !!store.getSchedule(global.id));
store.deleteSchedule(global.id);

/* ------------------------------------------------- ⑦ 人手工建的怪节拍 → 自定义 */
console.log('\n⑦ 手工建过的「每周一」：显示自定义，不显示关闭');
const weird = store.createSchedule({ name: '手工巡检', action: 'pr-scan', repeat: 'weekly', weekday: 1, atTime: '09:00', config: { repo: B.fullName } });
check('认领到的是最早那条（B 的 daily-21）', patrol.jobOf(B)?.id !== weird.id);
const weekly = patrol.jobsOfRepo(B.fullName).find((j) => j.id === weird.id);
store.updateSchedule(weekly.id, { name: '手工巡检', repeat: 'weekly', weekday: 1, atTime: '09:00' });
// B 名下现在两条；第一条仍是 daily-21 —— 先清掉它，让「自定义」这条成为被认领的
store.deleteSchedule(patrol.jobOf(B).id);
check('只剩 Weekly 那条即可认领', patrol.jobOf(B)?.id === weird.id);
check('它跑着（enabled），所以不能显示成 off', patrol.viewOf(B).preset === 'custom', patrol.viewOf(B).preset);
patrol.setPreset(B, 'daily-21');
check('从自定义改回预设：还是同一条任务', patrol.jobOf(B)?.id === weird.id && patrol.viewOf(B).preset === 'daily-21');

/* --------------------------------------- ⑧ 立即巡检：没任务不建任务 / 有任务记结果 */
console.log('\n⑧ 立即巡检（这个临时目录没有 GitHub 令牌，一定失败 —— 正好验"失败如实回"）');
const countBefore = store.listSchedules().length;
const runNoJob = await patrol.runNow(mkRepo('c'));
check('没配过节拍的仓库：跑一次不建任务', store.listSchedules().length === countBefore, `${countBefore} → ${store.listSchedules().length}`);
check('失败如实回 ok:false + 原话', runNoJob.ok === false && /GitHub/.test(runNoJob.error ?? ''), String(runNoJob.error));

const runWithJob = await patrol.runNow(B);
check('有任务的仓库：返回 ok:false', runWithJob.ok === false && /GitHub/.test(runWithJob.error ?? ''), String(runWithJob.error));
check('结果记在那条任务上（lastStatus=fail + lastRunAt）', patrol.jobOf(B)?.lastStatus === 'fail' && !!patrol.jobOf(B)?.lastRunAt);
check('视图里能看到上次失败', patrol.viewOf(B).lastStatus === 'fail');

console.log(`\n${failed ? `✗ ${failed} 项没过` : '✓ 全部通过'}`);
process.exit(failed ? 1 : 0);
