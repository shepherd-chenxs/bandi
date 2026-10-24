/**
 * 定时任务（调度器 + PR 巡检动作）的离线验收（2026-10-17）。
 *
 * 分两段，都是**不联网**的：
 *   ① 调度核心（`schedules.mjs`）与 PR 巡检（`pr-watch.mjs`）—— 直接 import，GitHub 用假 fetch 喂；
 *   ② HTTP 那一层（`/api/schedules`）—— 真起一个控制面（临时数据目录），验校验、开关、立即跑、失败记录。
 *
 * 为什么 PR 巡检也要在这里跑一遍：它一半的逻辑是"哪些 PR 该变成哪张卡、合并了要不要收状态"，
 * 全是纯判断；真去 GitHub 那半截（`fetch`）换个实现就该照样对。
 *
 * 跑法：node apps/server/src/smoke-schedules.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-sched-'));

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

/* ⚠️ 环境变量必须在 import 之前设好（store 一加载就开库、建默认项目） */
process.env.BANDI_DATA = tmp;
process.env.BANDI_DB = path.join(tmp, 'bandi.db');

const store = await import('./store.mjs');
const git = await import('./git-repos.mjs');
const pt = await import('./project-tasks.mjs');
const schedules = await import('./schedules.mjs');
const prWatch = await import('./pr-watch.mjs');

/* ---------------------------------------------------------------- ① 到点判定 */
console.log('① 到点判定：开关、从没跑过、间隔、下限');
const job = (o = {}) => ({ id: 'sj-x', name: 'x', action: 'pr-scan', everyMinutes: 30, enabled: 1, lastRunAt: null, ...o });
check('关掉的任务永远不到点', schedules.isDue(job({ enabled: 0 })) === false);
check('从没跑过的 → 立刻该跑（人刚建完就该看到结果）', schedules.isDue(job({ lastRunAt: null })) === true);
const now = Date.parse('2026-10-17T12:00:00.000Z');
check('跑了 10 分钟、间隔 30 分钟 → 还不到', schedules.isDue(job({ lastRunAt: '2026-10-17T11:50:00.000Z' }), now) === false);
check('跑了 31 分钟、间隔 30 分钟 → 到点', schedules.isDue(job({ lastRunAt: '2026-10-17T11:29:00.000Z' }), now) === true);
// 间隔 1 分钟要被抬到 5 分钟（接口与界面都会拦，这里是最后一道）
check('间隔小于下限时按 5 分钟算', schedules.isDue(job({ everyMinutes: 1, lastRunAt: '2026-10-17T11:56:00.000Z' }), now) === false);
check('刚过 5 分钟就当真到点', schedules.isDue(job({ everyMinutes: 1, lastRunAt: '2026-10-17T11:54:00.000Z' }), now) === true);
check('lastRunAt 是坏值 → 当从没跑过', schedules.isDue(job({ lastRunAt: '不是时间' })) === true);

/* ------------------------------------------------ ①b 时间类的重复方式（全部本地时间，不联网） */
console.log('\n①b 重复方式：单次 / 每天 / 每周 / 每双周 / 每月 / 每年');
const tjob = (o) => ({ id: 'sj-y', name: 'y', action: 'pr-scan', enabled: 1, lastRunAt: null, ...o });
const L = (s) => new Date(s); // 无时区后缀 → 按本地时间解析，跟界面上填的一致
// 2026-10-17 是周六；用「周六 14:00 建任务」当锚点
const SAT = L('2026-10-17T14:00:00');
check('前提：2026-10-17 是周六', SAT.getDay() === 6);

check('单次：时间没到不该跑', schedules.isDue(tjob({ repeat: 'once', runAt: '2026-10-20T09:00' }), L('2026-10-19T10:00')) === false);
check('单次：到点该跑', schedules.isDue(tjob({ repeat: 'once', runAt: '2026-10-20T09:00' }), L('2026-10-20T09:00')) === true);
check('单次：跑过一次就永远不再跑', schedules.isDue(tjob({ repeat: 'once', runAt: '2026-10-20T09:00', lastRunAt: '2026-10-20T09:00:03' }), L('2026-10-25T10:00')) === false);
check('单次：没填时间 → 不跑（宁可不动也不乱跑）', schedules.isDue(tjob({ repeat: 'once' }), L('2026-10-25T10:00')) === false);

const daily = { repeat: 'daily', atTime: '09:00', createdAt: '2026-10-17T14:00:00' };
check('每天 09:00：周六 14:00 建的，当天不该跑（09:00 在建之前）', schedules.isDue(tjob(daily), L('2026-10-17T15:00')) === false);
check('每天 09:00：周日上午 08:59 还不到', schedules.isDue(tjob(daily), L('2026-10-18T08:59:00')) === false);
check('每天 09:00：周日 09:00 整到点', schedules.isDue(tjob(daily), L('2026-10-18T09:00:00')) === true);
check('每天 09:00：跑过之后要等下一个 09:00（不是满 24 小时）', schedules.isDue(tjob({ ...daily, lastRunAt: '2026-10-18T09:00:30' }), L('2026-10-19T09:00:00')) === true && schedules.isDue(tjob({ ...daily, lastRunAt: '2026-10-18T09:00:30' }), L('2026-10-19T08:00:00')) === false);

const weekly = { repeat: 'weekly', weekday: 1, atTime: '09:00', createdAt: '2026-10-17T14:00:00' }; // 每周一 09:00
check('每周一：周六建的，周六当天不到点', schedules.isDue(tjob(weekly), L('2026-10-17T18:00:00')) === false);
check('每周一：第一个周一 09:00 到点', schedules.isDue(tjob(weekly), L('2026-10-19T09:00:00')) === true);
check('每周一：跑完这个周一，下周一才算数', schedules.isDue(tjob({ ...weekly, lastRunAt: '2026-10-19T09:00:10' }), L('2026-10-25T10:00:00')) === false && schedules.isDue(tjob({ ...weekly, lastRunAt: '2026-10-19T09:00:10' }), L('2026-10-26T09:00:00')) === true);

const biw = { repeat: 'biweekly', weekday: 1, atTime: '09:00', createdAt: '2026-10-17T14:00:00' };
check('每双周：第一次不受"隔一周"约束（还是第一个周一）', schedules.isDue(tjob(biw), L('2026-10-19T09:00:00')) === true);
check('每双周：跑完要再等一整周（一周后不到点）', schedules.isDue(tjob({ ...biw, lastRunAt: '2026-10-19T09:00:10' }), L('2026-10-26T09:00:00')) === false);
check('每双周：两周后的那个周一到点', schedules.isDue(tjob({ ...biw, lastRunAt: '2026-10-19T09:00:10' }), L('2026-11-02T09:00:00')) === true);

const monthly = { repeat: 'monthly', dayOfMonth: 31, atTime: '09:00', createdAt: '2026-10-17T14:00:00' };
check('每月 31 号：10 月就是 10-31（不该被钳成 28）', schedules.isDue(tjob(monthly), L('2026-10-31T09:00:00')) === true && schedules.isDue(tjob(monthly), L('2026-10-30T09:00:00')) === false);
check('每月 31 号：11 月只有 30 天 → 落到 11-30', schedules.isDue(tjob({ ...monthly, lastRunAt: '2026-10-31T09:00:10' }), L('2026-11-30T09:00:00')) === true);

const yearly = { repeat: 'yearly', month: 2, dayOfMonth: 30, atTime: '09:00', createdAt: '2026-10-17T14:00:00' };
check('每年 2 月 30 号 → 落到 2 月 28（2027）', schedules.isDue(tjob(yearly), L('2027-02-28T09:00:00')) === true && schedules.isDue(tjob(yearly), L('2027-02-27T09:00:00')) === false);

check('说人话：间隔', schedules.describeRepeat({ repeat: 'interval', everyMinutes: 30 }) === '每 30 分钟');
check('说人话：单次', /单次/.test(schedules.describeRepeat({ repeat: 'once', runAt: '2026-10-20T09:00:00' })));
check('说人话：每天 / 每周一 / 每双周三', schedules.describeRepeat({ repeat: 'daily', atTime: '09:00' }) === '每天 09:00' && schedules.describeRepeat({ repeat: 'weekly', weekday: 1, atTime: '09:00' }) === '每周一 09:00' && schedules.describeRepeat({ repeat: 'biweekly', weekday: 3, atTime: '09:30' }) === '每双周三 09:30');
check('说人话：每月 15 号 / 每年 1 月 1 日', schedules.describeRepeat({ repeat: 'monthly', dayOfMonth: 15, atTime: '08:00' }) === '每月 15 号 08:00' && schedules.describeRepeat({ repeat: 'yearly', month: 1, dayOfMonth: 1, atTime: '09:00' }) === '每年 1 月 1 日 09:00');
check('说人话：字段缺了也不报错（兜到默认值）', schedules.describeRepeat({ repeat: 'weekly' }).startsWith('每周'));

/* ------------------------------------------------------ ② tick：串行、写回结果、失败记原因 */
console.log('\n② tick：到点的跑、关掉的不跑、成功与失败都写回 last*');
const mk = (o) => store.createSchedule({ name: o.name ?? '测试任务', action: o.action ?? 'pr-scan', everyMinutes: o.everyMinutes ?? 30, enabled: o.enabled ?? 1, config: o.config ?? null });
const okJob = mk({ name: '会成功的' });
const failJob = mk({ name: '会失败的' });
const offJob = mk({ name: '关着的', enabled: 0 });
const calls = [];
const fakeActions = {
  'pr-scan': {
    run: async ({ job: j }) => {
      calls.push(j.id);
      if (j.id === failJob.id) throw new Error('假装网络断了');
      return { summary: '新建 2 张' };
    },
  },
};
const ran = await schedules.tick({ actions: fakeActions });
check('这一跳跑了 2 个（关掉的不跑）', ran === 2, String(ran));
check('关着的那个一次都没被调用', !calls.includes(offJob.id));
check('成功的任务记了 lastRunAt / ok / summary', (() => {
  const j = store.getSchedule(okJob.id);
  return !!j.lastRunAt && j.lastStatus === 'ok' && j.lastSummary === '新建 2 张';
})(), JSON.stringify({ s: store.getSchedule(okJob.id).lastStatus, m: store.getSchedule(okJob.id).lastSummary }));
check('失败的任务记了 fail 与原话', (() => {
  const j = store.getSchedule(failJob.id);
  return j.lastStatus === 'fail' && /网络断了/.test(j.lastError ?? '');
})(), store.getSchedule(failJob.id).lastError);
check('失败也写 lastRunAt（不然每 30 秒重试，日志刷满）', !!store.getSchedule(failJob.id).lastRunAt);
// 刚跑完 → 这一跳不该再跑它们
check('紧接着再 tick：一个都不跑', (await schedules.tick({ actions: fakeActions })) === 0);
// 不认识的动作：不抛、记 fail
const weird = mk({ name: '野动作', action: 'nope' });
await schedules.tick({ actions: fakeActions });
check('不认识的动作 → fail 且说清楚', /不认识的动作/.test(store.getSchedule(weird.id).lastError ?? ''), store.getSchedule(weird.id).lastError);
store.deleteSchedule(weird.id);

/* ------------------------------------- ②b 动作是可插拔的：声明式参数 + 一个跟 PR 无关的动作 */
console.log('\n②b 动作注册表：动作自己声明参数；第二个动作（备份）跟 PR 毫无关系');
const cat = schedules.actionCatalogue();
check('清单里有两个动作（PR 巡检 / 备份）', cat.length >= 2 && cat.some((a) => a.id === 'pr-scan') && cat.some((a) => a.id === 'backup-db'), cat.map((a) => a.id).join(','));
check('每个动作都声明了 label / hint / defaultName / fields', cat.every((a) => a.label && a.hint && a.defaultName && Array.isArray(a.fields)));
check('PR 巡检的参数是它自己的（仓库 / 项目），不是调度核心写死的', (cat.find((a) => a.id === 'pr-scan').fields ?? []).map((f) => f.key).join(',') === 'repo,projectId');
check('备份动作只声明一个参数（保留份数）', (cat.find((a) => a.id === 'backup-db').fields ?? []).map((f) => f.key).join(',') === 'keep');
check('动作清单里没有 run（函数不发到浏览器）', cat.every((a) => !('run' in a)));

const backupJob = store.createSchedule({ name: '备份', action: 'backup-db', everyMinutes: 30, config: { keep: 2 } });
const bDir = path.join(tmp, 'backups');
const listBak = () => (fs.existsSync(bDir) ? fs.readdirSync(bDir).filter((f) => /^bandi-.*\.db$/.test(f)) : []);
const b1 = await schedules.runNow(backupJob.id);
const files1 = listBak();
check('备份跑成功并说清文件名与份数', b1.ok === true && /已备份/.test(b1.summary ?? ''), b1.summary ?? b1.error);
check('数据目录下真的多了一份 .db', files1.length === 1, files1.join(','));
check(
  '备份是**一致的 SQLite 库**，不是半截拷贝',
  (() => {
    const fd = fs.openSync(path.join(bDir, files1[0]), 'r');
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    fs.closeSync(fd);
    return head.toString() === 'SQLite format 3\u0000';
  })(),
);
await schedules.runNow(backupJob.id);
await new Promise((r) => setTimeout(r, 3));
await schedules.runNow(backupJob.id);
const files3 = listBak();
check('保留份数生效：跑了三次只留 2 份', files3.length === 2, String(files3.length));
check('留下的是最近两份（最旧那份被清掉）', !files3.includes(files1[0]), files3.join(','));

/* ------------------------------------------- ③ PR 巡检：假 fetch 喂 GitHub，验"卡怎么写、状态怎么收" */
console.log('\n③ PR 巡检：新 PR → 值班卡；合并 → 卡片跟着收');
const project = store.listProjects().find((p) => p.builtIn) ?? store.listProjects()[0];
const repoDir = fs.mkdtempSync(path.join(tmp, 'repo-'));
store.addGitRepo({ fullName: 'smoke/demo', owner: 'smoke', name: 'demo', localPath: repoDir });
git.saveToken('ghp_sched_smoke');

const pulls = [
  { number: 11, title: '加一个按钮', html_url: 'https://github.com/smoke/demo/pull/11', user: { login: 'alice' } },
  { number: 12, title: '修个错字', html_url: 'https://github.com/smoke/demo/pull/12', user: { login: 'bob' }, draft: true },
];
const issues = [
  { number: 5, title: '这个能支持吗', html_url: 'https://github.com/smoke/demo/issues/5', user: { login: 'carol' }, labels: [{ name: 'question' }] },
  { number: 6, title: '其实是 PR', pull_request: {} }, // 必须被剔除
];
let merged = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } });
  // 单条 PR 详情：合并后也要能查到（列表里已经没有它了，只靠这条收状态）
  const one = /\/pulls\/(\d+)/.exec(u);
  if (one) {
    const n = Number(one[1]);
    const hit = pulls.find((p) => p.number === n) ?? { number: n, title: '?', html_url: `https://github.com/smoke/demo/pull/${n}` };
    // 只合 #11（#12 留着开着，用来证明"合了一张不会顺手把别的也改成已合并"）
    const isMerged = merged && n === 11;
    return json({ ...hit, state: isMerged ? 'closed' : 'open', merged: isMerged, merged_at: isMerged ? '2026-10-17T00:00:00Z' : null });
  }
  if (u.includes('/pulls?')) return json(merged ? [] : pulls);
  if (u.includes('/issues?')) return json(merged ? [] : issues);
  return json({ message: `假的 GitHub 里没有这个地址：${u}` });
};

try {
  const out1 = await prWatch.prScan({ config: {} });
  check('第一次巡检：两张 PR 卡 + 一张 issue 卡', out1.created === 3, JSON.stringify(out1));
  const pr11 = store.getProjectTaskByExternalKey(project.id, 'pr:11');
  const pr12 = store.getProjectTaskByExternalKey(project.id, 'pr:12');
  const is5 = store.getProjectTaskByExternalKey(project.id, 'issue:5');
  check('PR 卡存在且带 pr 字段', !!pr11 && pr11.prRepo === 'smoke/demo' && pr11.prNumber === 11 && pr11.prState === 'open');
  check('卡上标明是值班卡 + 待办', pr11?.source === 'repo' && pr11?.status === '待办');
  check('标题/描述写清是谁提的、该跑什么', /alice/.test(pr11?.description ?? '') && /check-pr/.test(pr11?.description ?? ''));
  check('草稿也标出来', /草稿/.test(pr12?.description ?? ''), pr12?.description?.split('\n')[0]);
  check('issue 卡没有 PR 字段', !!is5 && !is5.prRepo);
  check('PR 藏在 issues 列表里也被剔掉（没有 issue:6）', !store.getProjectTaskByExternalKey(project.id, 'issue:6'));
  check('巡检结论说得清', /新建 3 张/.test(out1.summary), out1.summary);

  const out2 = await prWatch.prScan({ config: {} });
  check('再巡检一次：不重复建卡、也不算更新', out2.created === 0 && out2.updated === 0, out2.summary);

  // 人把卡拖到「进行中」→ PR 被合并 → 巡检应该把它收成「待验收」
  store.updateProjectTask(pr11.id, { status: '进行中' });
  merged = true;
  const out3 = await prWatch.prScan({ config: {} });
  const after = store.getProjectTask(pr11.id);
  check('合并后 prState 变 merged', after.prState === 'merged', String(after.prState));
  check('「进行中」→「待验收」（不直接已完成）', after.status === '待验收', after.status);
  check('结论里报了状态变化', /PR 状态变化 1 张/.test(out3.summary), out3.summary);
  check('已合并的 PR 不会因为不在 open 列表里就被删卡', !!store.getProjectTask(pr11.id));

  // 只查某个仓库 / 仓库不存在 → 说清楚，不当成"成功但没做事"
  let err = '';
  try {
    await prWatch.prScan({ config: { repo: 'nope/none' } });
  } catch (e) {
    err = e.message;
  }
  check('指定了没接入的仓库 → 抛错说清楚', /没有接入仓库/.test(err), err);
} finally {
  globalThis.fetch = realFetch;
}

/* ------------------------------------------------------------- ④ HTTP：校验 / 开关 / 立即跑 */
console.log('\n④ HTTP /api/schedules：校验、开关、立即跑、失败如实记账');
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-sched-http-'));
const PORT = Number(process.env.SMOKE_PORT ?? 8892);
const BASE = `http://127.0.0.1:${PORT}`;
const logPath = path.join(tmp2, 'server.log');
const logFd = fs.openSync(logPath, 'a');
const child = spawn(process.execPath, [path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs')], {
  cwd: repoRoot,
  env: { ...process.env, BANDI_PORT: String(PORT), BANDI_DATA: tmp2, BANDI_DB: path.join(tmp2, 'bandi.db') },
  windowsHide: true,
  stdio: ['ignore', logFd, logFd],
});
fs.closeSync(logFd);

const req = async (p, opt = {}) => {
  const r = await fetch(BASE + p, { ...opt, headers: { 'Content-Type': 'application/json', ...(opt.headers ?? {}) } });
  const text = await r.text();
  let b = null;
  try {
    b = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: r.status, b };
};

try {
  let up = false;
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(BASE + '/api/schedules')).ok) {
        up = true;
        break;
      }
    } catch {
      /* 还没起 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  check('控制面起来了', up);
  if (up) {
    const list0 = await req('/api/schedules');
    check('清单空、动作清单里有 PR 巡检', list0.status === 200 && list0.b.jobs.length === 0 && list0.b.actions.some((a) => a.id === 'pr-scan'));
    check('动作清单里没有函数（别把 run 发到浏览器）', !('run' in (list0.b.actions[0] ?? {})));
    check('返回了下限（界面用它做输入框的最小值）', list0.b.minMinutes === 5, String(list0.b.minMinutes));

    check('没有名字 → 400', (await req('/api/schedules', { method: 'POST', body: JSON.stringify({ action: 'pr-scan', everyMinutes: 30 }) })).status === 400);
    check('不认识的动作 → 400', (await req('/api/schedules', { method: 'POST', body: JSON.stringify({ name: 'x', action: 'nope', everyMinutes: 30 }) })).status === 400);
    check('间隔 1 分钟 → 400（下限 5）', (await req('/api/schedules', { method: 'POST', body: JSON.stringify({ name: 'x', action: 'pr-scan', everyMinutes: 1 }) })).status === 400);
    check('间隔大到离谱 → 400', (await req('/api/schedules', { method: 'POST', body: JSON.stringify({ name: 'x', action: 'pr-scan', everyMinutes: 60 * 24 * 30 }) })).status === 400);
    check('不认识的重复方式 → 400', (await req('/api/schedules', { method: 'POST', body: JSON.stringify({ name: 'x', action: 'pr-scan', repeat: '每小时' }) })).status === 400);
    check('每天不给时间 → 400', (await req('/api/schedules', { method: 'POST', body: JSON.stringify({ name: 'x', action: 'pr-scan', repeat: 'daily' }) })).status === 400);
    check('单次时间写成胡话 → 400', (await req('/api/schedules', { method: 'POST', body: JSON.stringify({ name: 'x', action: 'pr-scan', repeat: 'once', runAt: '下周三上午' }) })).status === 400);
    check('每周星期九 → 400', (await req('/api/schedules', { method: 'POST', body: JSON.stringify({ name: 'x', action: 'pr-scan', repeat: 'weekly', weekday: 9, atTime: '09:00' }) })).status === 400);
    check('每月 0 号 → 400', (await req('/api/schedules', { method: 'POST', body: JSON.stringify({ name: 'x', action: 'pr-scan', repeat: 'monthly', dayOfMonth: 0, atTime: '09:00' }) })).status === 400);

    // 时间类的方式建得出来，且下发里带"说人话"的 text
    const madeDaily = await req('/api/schedules', {
      method: 'POST',
      body: JSON.stringify({ name: '每天巡检', action: 'pr-scan', repeat: 'daily', atTime: '09:00', enabled: false }),
    });
    check('每天 09:00 建得出来（201）', madeDaily.status === 201, String(madeDaily.status));
    check('下发的 text 是「每天 09:00」', madeDaily.b?.job?.text === '每天 09:00', madeDaily.b?.job?.text);
    check('时间类不用间隔字段（30 是无害占位）', madeDaily.b?.job?.repeat === 'daily' && Number.isFinite(Number(madeDaily.b?.job?.everyMinutes)));

    // 老形状（不带 repeat）照常建：默认 interval，老任务不受影响
    const madeOld = await req('/api/schedules', { method: 'POST', body: JSON.stringify({ name: '老形状', action: 'pr-scan', everyMinutes: 30, enabled: false }) });
    check('不带 repeat 的老形状 → 默认 interval', madeOld.status === 201 && madeOld.b?.job?.repeat === 'interval' && madeOld.b?.job?.text === '每 30 分钟', madeOld.b?.job?.text);
    const dailyId = madeDaily.b?.job?.id;
    const patchedDaily = await req(`/api/schedules/${encodeURIComponent(dailyId)}`, { method: 'PATCH', body: JSON.stringify({ enabled: true }) });
    check('PATCH 只改开关：时间方式不受影响', patchedDaily.status === 200 && patchedDaily.b.job.repeat === 'daily' && patchedDaily.b.job.atTime === '09:00');
    const toInterval = await req(`/api/schedules/${encodeURIComponent(dailyId)}`, { method: 'PATCH', body: JSON.stringify({ repeat: 'interval', everyMinutes: 15 }) });
    check('从每天改成间隔：只改这一个', toInterval.status === 200 && toInterval.b.job.repeat === 'interval' && toInterval.b.job.everyMinutes === 15);
    await req(`/api/schedules/${encodeURIComponent(dailyId)}`, { method: 'DELETE' });
    await req(`/api/schedules/${encodeURIComponent(madeOld.b?.job?.id)}`, { method: 'DELETE' });

    // 建一个**关着的**（免得 30 秒后自己那一跳跟这里抢）
    const made = await req('/api/schedules', {
      method: 'POST',
      body: JSON.stringify({ name: 'PR 巡检', action: 'pr-scan', everyMinutes: 30, enabled: false, config: { repo: 'smoke/demo' } }),
    });
    check('建得出来（201）', made.status === 201, String(made.status));
    const id = made.b?.job?.id;
    check('config 存的是对象（界面上直接改）', made.b?.job?.config?.repo === 'smoke/demo');
    check('新建任务没有上次运行记录', !made.b?.job?.lastRunAt && !made.b?.job?.lastStatus);

    const patched = await req(`/api/schedules/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ everyMinutes: 15, enabled: true }) });
    check('改间隔与开关 → 200 且值生效', patched.status === 200 && patched.b.job.everyMinutes === 15 && patched.b.job.enabled === 1);
    check('只改一个字段不会把名字抹掉', patched.b.job.name === 'PR 巡检');

    /*
     * 立即跑：这个临时数据目录里**没有 GitHub 令牌**，所以 pr-scan 一定会失败 ——
     * 正好验"失败如实记在任务上、下一跳不会每 30 秒重试"。
     */
    const ran = await req(`/api/schedules/${encodeURIComponent(id)}/run`, { method: 'POST' });
    check('立即跑：请求本身成功（200）', ran.status === 200, String(ran.status));
    check('结果里 ok=false 且说清楚原因', ran.b?.ok === false && /GitHub/.test(ran.b?.error ?? ''), ran.b?.error);
    const afterRun = (await req('/api/schedules')).b.jobs.find((j) => j.id === id);
    check('任务上记了 fail + 原话 + 时间', afterRun.lastStatus === 'fail' && !!afterRun.lastError && !!afterRun.lastRunAt, JSON.stringify({ s: afterRun.lastStatus, e: afterRun.lastError }));
    check('失败的任务不会被立刻再跑一遍（lastRunAt 已写）', schedules.isDue({ ...afterRun, enabled: 1 }) === false);

    // 换一个动作（备份）：参数是动作自己声明的，接口不认识里面有什么，原样存
    const madeBackup = await req('/api/schedules', {
      method: 'POST',
      body: JSON.stringify({ name: '数据库备份', action: 'backup-db', everyMinutes: 30, enabled: false, config: { keep: 3 } }),
    });
    check('备份动作建得出来，config 原样存', madeBackup.status === 201 && madeBackup.b?.job?.config?.keep === 3, JSON.stringify(madeBackup.b?.job?.config));
    const ranBackup = await req(`/api/schedules/${encodeURIComponent(madeBackup.b?.job?.id)}/run`, { method: 'POST' });
    check('备份动作「立即跑」成功并说清结果', ranBackup.status === 200 && ranBackup.b?.ok === true && /已备份/.test(ranBackup.b?.summary ?? ''), ranBackup.b?.summary ?? ranBackup.b?.error);
    await req(`/api/schedules/${encodeURIComponent(madeBackup.b?.job?.id)}`, { method: 'DELETE' });

    /*
     * 「交给数字员工」：这版把「做什么」做成输入区（2026-10-17 用户要求）。
     * 验三件事就够：动作声明里是 textarea + persona / 缺哪个都 400 且说人话 / 填齐了能建。
     * **不真跑** —— 一跑就会起一次真运行（占运行时、烧额度），那是「立即跑」按钮的事。
     */
    const catalogue = (await req('/api/schedules')).b.actions;
    const ptask = catalogue.find((a) => a.id === 'persona-task');
    check('动作清单里有「交给数字员工」', !!ptask, catalogue.map((a) => a.id).join(','));
    check(
      '它的参数就是「输入区 + 选人 + 选填的项目」',
      ptask?.fields?.[0]?.type === 'textarea' &&
        ptask?.fields?.[1]?.type === 'persona' &&
        ptask?.fields?.[2]?.type === 'project',
      JSON.stringify(ptask?.fields?.map((f) => f.type)),
    );
    // 前两个必填（做事 + 人）；**项目选填** —— 有些活得先问清在哪儿做，指派时定不下来
    check(
      '「做什么」「交给谁」必填，项目选填',
      ptask?.fields?.[0]?.required === true && ptask?.fields?.[1]?.required === true && !ptask?.fields?.[2]?.required,
      JSON.stringify(ptask?.fields?.map((f) => !!f.required)),
    );

    const noText = await req('/api/schedules', {
      method: 'POST',
      body: JSON.stringify({ name: '派活', action: 'persona-task', everyMinutes: 30, config: { personaId: 'p-x' } }),
    });
    check('没写「做什么」→ 400 且说清原因', noText.status === 400 && /做什么/.test(noText.b?.error ?? ''), noText.b?.error);
    check(
      '没选人 → 400',
      (await req('/api/schedules', { method: 'POST', body: JSON.stringify({ name: '派活', action: 'persona-task', everyMinutes: 30, config: { instruction: '看看今天的 PR' } }) })).status === 400,
    );
    check(
      '选了一个不存在的人 → 400',
      (await req('/api/schedules', {
        method: 'POST',
        body: JSON.stringify({ name: '派活', action: 'persona-task', everyMinutes: 30, config: { instruction: '看看今天的 PR', personaId: 'p-nope' } }),
      })).status === 400,
    );

    const madePersona = await req('/api/personas', { method: 'POST', body: JSON.stringify({ name: '值班小张' }) });
    const pid = madePersona.b?.persona?.id;
    check('临时建一个员工来派活', !!pid);
    const madePt = await req('/api/schedules', {
      method: 'POST',
      body: JSON.stringify({
        name: '派活',
        action: 'persona-task',
        everyMinutes: 30,
        enabled: false,
        config: { instruction: '  看看今天的 PR，整理成一条  ', personaId: pid },
      }),
    });
    check('写清做什么 + 选好人 → 201', madePt.status === 201, String(madePt.status));
    check('那句话原样存下来（编辑时能回填）', madePt.b?.job?.config?.instruction === '  看看今天的 PR，整理成一条  ', JSON.stringify(madePt.b?.job?.config));

    /*
     * 工作空间（2026-10-17 用户要求）：派活可以指定一个项目，「到点就在那个项目的目录里干」。
     * 选填 —— 不选就照旧用这个人自己的默认目录。
     */
    const madeProj = await req('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: '冒烟项目', root: process.cwd() }),
    });
    const projId = madeProj.b?.project?.id;
    check('建一个项目来当工作空间', !!projId, String(madeProj.status));
    check(
      '选了一个不存在的项目 → 400 且说清原因',
      (await req('/api/schedules', {
        method: 'POST',
        body: JSON.stringify({ name: '派活', action: 'persona-task', everyMinutes: 30, config: { instruction: '看看今天的 PR', personaId: pid, projectId: 'p-nope' } }),
      })).status === 400,
    );
    const withProj = await req('/api/schedules', {
      method: 'POST',
      body: JSON.stringify({
        name: '派活-指定项目',
        action: 'persona-task',
        everyMinutes: 30,
        enabled: false,
        config: { instruction: '整理一下这个项目的 TODO', personaId: pid, projectId: projId },
      }),
    });
    check('选了项目 → 201 且 config 里带着 projectId', withProj.status === 201 && withProj.b?.job?.config?.projectId === projId, JSON.stringify(withProj.b?.job?.config));
    // 别真跑：跑一次会起真运行。只验"不选项目也能建"（默认目录那条路不被这次改动堵死）
    const noProj = await req('/api/schedules', {
      method: 'POST',
      body: JSON.stringify({ name: '派活-不指定项目', action: 'persona-task', everyMinutes: 30, enabled: false, config: { instruction: '随便看看', personaId: pid } }),
    });
    check('不选项目照样能建（用他自己的默认目录）', noProj.status === 201, JSON.stringify(noProj.b?.job?.config));
    await req(`/api/schedules/${encodeURIComponent(noProj.b?.job?.id)}`, { method: 'DELETE' });
    await req(`/api/schedules/${encodeURIComponent(withProj.b?.job?.id)}`, { method: 'DELETE' });
    await req(`/api/projects/${encodeURIComponent(projId)}`, { method: 'DELETE' });
    await req(`/api/schedules/${encodeURIComponent(madePt.b?.job?.id)}`, { method: 'DELETE' });

    check('删掉 → 200', (await req(`/api/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' })).status === 200);
    check('删完再查 → 清单里没有', (await req('/api/schedules')).b.jobs.length === 0);
    check('跑一个不存在的任务 → 404', (await req('/api/schedules/sj-nope/run', { method: 'POST' })).status === 404);
  }
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 300));
  for (const d of [tmp, tmp2]) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* 删不掉就算了 */
    }
  }
}

console.log(`\n结论：${failed ? `有 ${failed} 项没通过` : '全通过'}`);
process.exit(failed ? 1 : 0);
