/**
 * 项目档案（干什么 / 项目经理 / 成员 / 起止时间）的离线验收（2026-10-23）。
 *
 * 验的是用户口述的那几件事，以及两条口径：
 *   · **读不到就明说「未填写」**，不猜、不装成有数（PRD S1.2）；
 *   · **开始时间有出处**：手动填的标「填写」，没填退回建档时间并标「建档时间」——
 *     两者可能差很远，混成一个数字等于骗人（PRD 五.3）。
 *
 * 2026-10-23 PRD **v0.2**：档案 UI 回到**四项**，迭代版本数归研发面板、不再进档案。
 * 但 `version_count` / `version_count_text` 两个**后端字段留着**（那是研发面板的数据源），
 * 所以下面的用例继续断言它们 —— 只是口径变成"字段还在且算得对"，不再是"档案要展示它"。
 *
 * 隔离：临时数据库、临时端口、临时项目目录 —— 不碰 data/ 里的真账。
 * 跑法：node apps/server/src/smoke-project-profile.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-profile-'));
const PORT = Number(process.env.SMOKE_PORT ?? 8797);
const BASE = `http://127.0.0.1:${PORT}`;

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

const req = async (p, opt = {}) => {
  const r = await fetch(BASE + p, { ...opt, headers: { 'Content-Type': 'application/json', ...(opt.headers ?? {}) } });
  const text = await r.text();
  let b = null;
  try {
    b = JSON.parse(text);
  } catch {
    /* 非 JSON 原样带着 */
  }
  return { status: r.status, b };
};
const put = (p, body) => req(p, { method: 'PUT', body: JSON.stringify(body) });
const post = (p, body) => req(p, { method: 'POST', body: JSON.stringify(body ?? {}) });

/* 一个"已纳管"的项目根：两份版本记录，版本数应为 2 */
const projRoot = path.join(tmp, 'proj');
fs.mkdirSync(path.join(projRoot, '.bandi'), { recursive: true });
fs.writeFileSync(
  path.join(projRoot, '.bandi', 'status.yaml'),
  `updated: 2026-10-23 10:00
project: 档案项目
versions:
  - version: 1.0.0
    title: 第一版
  - version: 1.1.0
    title: 第二版
`,
  'utf8',
);

const logPath = path.join(tmp, 'server.log');
const logFd = fs.openSync(logPath, 'a');
const child = spawn(process.execPath, [path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs')], {
  cwd: repoRoot,
  env: { ...process.env, BANDI_PORT: String(PORT), BANDI_DATA: tmp, BANDI_DB: path.join(tmp, 'bandi.db') },
  windowsHide: true,
  stdio: ['ignore', logFd, logFd],
});
fs.closeSync(logFd);

const serverLog = () => {
  try {
    return fs.readFileSync(logPath, 'utf8');
  } catch {
    return '';
  }
};

let up = false;
for (let i = 0; i < 40; i++) {
  try {
    if ((await fetch(BASE + '/api/projects')).ok) {
      up = true;
      break;
    }
  } catch {
    /* 还没起 */
  }
  await new Promise((r) => setTimeout(r, 250));
}
check('控制面起来了', up);
if (!up) {
  console.log(serverLog().split('\n').slice(-15).join('\n'));
  child.kill();
  process.exit(1);
}

try {
  const proj = (await post('/api/projects', { name: '档案项目', root: projRoot })).b?.project;
  const pm = (await post('/api/personas', { name: '大梁', role: '项目经理' })).b?.persona;
  const dev = (await post('/api/personas', { name: '嘉辉', role: '研发' })).b?.persona;
  const qa = (await post('/api/personas', { name: '杜衡', role: '测试' })).b?.persona;
  check('造数：项目 + 三个人', !!proj && !!pm && !!dev && !!qa);

  console.log('\n① 没填时：四项都给出处，不猜');
  const blank = (await req(`/api/status/projects/${encodeURIComponent(proj.id)}`)).b ?? {};
  check('干什么 → 未填写', blank.summary_text === '未填写', String(blank.summary_text));
  check('项目经理 → 未填写', blank.pm_name === '未填写', String(blank.pm_name));
  check('成员 → 未填写', blank.members_text === '未填写', String(blank.members_text));
  const createdDay = String(proj.createdAt ?? '').slice(0, 10);
  check('开始时间退回建档时间，且标了出处', blank.started_text === `${createdDay}（建档时间）`, String(blank.started_text));
  check('结束时间 → 未填写（进行中）', blank.ended_text === '未填写（进行中）', String(blank.ended_text));
  // v0.2：版本数出档案了，但**字段**留着（研发面板的数据源，PRD 改动 2）
  check('后端 version_count 仍按 status.yaml 算（2）', blank.version_count === 2, String(blank.version_count));

  console.log('\n② 填齐之后：接口与看板都拿得到');
  const filled = await put(`/api/projects/${encodeURIComponent(proj.id)}`, {
    summary: '把平台做成一个能自己干活的班底',
    pmPersonaId: pm.id,
    memberPersonaIds: [dev.id, qa.id],
    startedAt: '2026-10-10',
    endedAt: '2026-12-31',
  });
  check('PUT 200', filled.status === 200, String(filled.status));
  const saved = filled.b?.project ?? {};
  check('简介存下来了', saved.summary === '把平台做成一个能自己干活的班底', String(saved.summary));
  check('项目经理存的是员工 id', saved.pmPersonaId === pm.id, String(saved.pmPersonaId));
  check('成员存成 JSON 数组', JSON.parse(saved.memberPersonaIds || '[]').length === 2, String(saved.memberPersonaIds));

  const after = (await req(`/api/status/projects/${encodeURIComponent(proj.id)}`)).b ?? {};
  check('干什么原文出来', after.summary_text === '把平台做成一个能自己干活的班底', String(after.summary_text));
  check('项目经理显示姓名', after.pm_name === '大梁', String(after.pm_name));
  check('成员显示姓名（按填的顺序）', after.members_text === '嘉辉、杜衡', String(after.members_text));
  check('成员明细带 id（界面画头像用）', (after.members ?? []).map((m) => m.id).join() === `${dev.id},${qa.id}`);
  check('开始时间标「填写」', after.started_text === '2026-10-10（填写）', String(after.started_text));
  check('结束时间显示填的那天', after.ended_text === '2026-12-31', String(after.ended_text));
  check('总览卡也带简介', (await req('/api/status/projects')).b?.projects?.find((c) => c.id === proj.id)?.summary_text === '把平台做成一个能自己干活的班底');
  const card = (await req('/api/status/projects')).b?.projects?.find((c) => c.id === proj.id);
  check('总览卡的 version_count 也在（研发面板要用）', card?.version_count === 2, String(card?.version_count));

  console.log('\n③ PATCH 语义：只改一项，别的原样');
  const only = await put(`/api/projects/${encodeURIComponent(proj.id)}`, { summary: '改了一句话' });
  check('只改简介 → 200', only.status === 200);
  check('项目经理没被清掉', only.b?.project?.pmPersonaId === pm.id, String(only.b?.project?.pmPersonaId));
  check('成员没被清掉', JSON.parse(only.b?.project?.memberPersonaIds || '[]').length === 2);
  check('开始时间没被清掉', only.b?.project?.startedAt === '2026-10-10', String(only.b?.project?.startedAt));

  console.log('\n④ 说错的话要当场拒，且不写半截');
  const ghostPm = await put(`/api/projects/${encodeURIComponent(proj.id)}`, { pmPersonaId: 'p-不存在' });
  check('选了个不存在的项目经理 → 400 E1080', ghostPm.status === 400 && ghostPm.b?.code === 'E1080', `${ghostPm.status} ${ghostPm.b?.code}`);
  const ghostMember = await put(`/api/projects/${encodeURIComponent(proj.id)}`, { memberPersonaIds: [dev.id, 'p-不存在'] });
  check('成员里有人不存在 → 400 E1081', ghostMember.status === 400 && ghostMember.b?.code === 'E1081', `${ghostMember.status} ${ghostMember.b?.code}`);
  const badDate = await put(`/api/projects/${encodeURIComponent(proj.id)}`, { startedAt: '2026/10/10' });
  check('日期格式不对 → 400 E1082', badDate.status === 400 && badDate.b?.code === 'E1082', `${badDate.status} ${badDate.b?.code}`);
  const still = (await req(`/api/status/projects/${encodeURIComponent(proj.id)}`)).b ?? {};
  check('被拒的三次都没动数据', still.pm_name === '大梁' && still.summary_text === '改了一句话', `${still.pm_name} / ${still.summary_text}`);

  console.log('\n⑤ 清空：传空串 / 空数组就是真的清掉');
  const cleared = await put(`/api/projects/${encodeURIComponent(proj.id)}`, {
    summary: '',
    pmPersonaId: '',
    memberPersonaIds: [],
    endedAt: '',
  });
  const clearedSaved = cleared.b?.project ?? {};
  check('简介清成 null', clearedSaved.summary === null, String(clearedSaved.summary));
  check('项目经理清成 null', clearedSaved.pmPersonaId === null, String(clearedSaved.pmPersonaId));
  check('成员清成空数组', clearedSaved.memberPersonaIds === '[]', String(clearedSaved.memberPersonaIds));
  check('结束时间清成 null', clearedSaved.endedAt === null, String(clearedSaved.endedAt));
  const clearedView = (await req(`/api/status/projects/${encodeURIComponent(proj.id)}`)).b ?? {};
  check('清完又回到「未填写」', clearedView.pm_name === '未填写' && clearedView.ended_text === '未填写（进行中）', `${clearedView.pm_name} / ${clearedView.ended_text}`);

  console.log('\n⑥ 人已经不在了：说清楚，不装成没配');
  await put(`/api/projects/${encodeURIComponent(proj.id)}`, { pmPersonaId: pm.id, memberPersonaIds: [dev.id] });
  const del = await req(`/api/personas/${encodeURIComponent(pm.id)}`, { method: 'DELETE' });
  check('删掉项目经理这个人 → 200', del.status === 200, String(del.status));
  const gone = (await req(`/api/status/projects/${encodeURIComponent(proj.id)}`)).b ?? {};
  check('项目经理标「那个人已经不在了」', gone.pm_name === '未填写（那个人已经不在了）', String(gone.pm_name));
  check('成员还在（只删了 PM）', gone.members_text === '嘉辉', String(gone.members_text));

  console.log('\n⑦ 未纳管的项目：版本数不装成 0（字段留着给研发面板，档案不展示它）');
  const offlineRoot = path.join(tmp, 'offline');
  fs.mkdirSync(offlineRoot, { recursive: true });
  const offline = (await post('/api/projects', { name: '没进度文件', root: offlineRoot })).b?.project;
  const offlineView = (await req(`/api/status/projects/${encodeURIComponent(offline.id)}`)).b ?? {};
  check('版本数显示「未纳管」而不是 0', offlineView.version_count_text === '未纳管', String(offlineView.version_count_text));
} catch (err) {
  console.log('\n跑挂了：' + String(err?.message ?? err));
  failed += 1;
} finally {
  try {
    child.kill();
  } catch {
    /* 已经退了 */
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 删不掉就算了 */
  }
}

console.log(`\n结论：${failed ? `${failed} 项没通过` : '全通过'}`);
if (failed) console.log('服务端日志：\n' + serverLog().slice(0, 1500));
process.exit(failed ? 1 : 0);
