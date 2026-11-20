/**
 * 项目档案（简介 / 项目经理 / 成员 / 起止时间）的离线验收（2026-10-23）。
 *
 * 2026-11-19 研发面板下线后，档案的读写只走平台自己的 `/api/projects`
 * （`/api/status/*` 那一套随插件一起删了）。这里验的是用户口述的那几件事：
 *   · **PATCH 语义**：只改一项，别的原样留着；
 *   · **说错的当场拒**，而且不写半截；
 *   · **传空 = 真的清掉**（空串 / 空数组）。
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

const projRoot = path.join(tmp, 'proj');
fs.mkdirSync(projRoot, { recursive: true });

const logPath = path.join(tmp, 'server.log');
const logFd = fs.openSync(logPath, 'a');
const child = spawn(process.execPath, [path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs')], {
  cwd: repoRoot,
  env: { ...process.env, BANDI_HOST: '127.0.0.1', BANDI_PORT: String(PORT), BANDI_DATA: tmp, BANDI_DB: path.join(tmp, 'bandi.db') },
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

/** 从项目列表里取那一条（GET /api/projects 回原始字段） */
const fetchProject = async (id) => {
  const list = (await req('/api/projects')).b?.projects ?? [];
  return list.find((p) => p.id === id) ?? {};
};

try {
  const proj = (await post('/api/projects', { name: '档案项目', root: projRoot })).b?.project;
  const pm = (await post('/api/personas', { name: '贺韬', role: '项目经理' })).b?.persona;
  const dev = (await post('/api/personas', { name: '嘉辉', role: '研发' })).b?.persona;
  const qa = (await post('/api/personas', { name: '杜衡', role: '测试' })).b?.persona;
  check('造数：项目 + 三个人', !!proj && !!pm && !!dev && !!qa);

  console.log('\n① 新建时：可空字段都还没填');
  const blank = await fetchProject(proj.id);
  check('简介 → null', blank.summary == null, String(blank.summary));
  check('项目经理 → null', blank.pmPersonaId == null, String(blank.pmPersonaId));
  check('成员 → 空', !blank.memberPersonaIds || blank.memberPersonaIds === '[]', String(blank.memberPersonaIds));

  console.log('\n② 填齐之后：接口与列表都拿得到');
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
  check('成员存成 JSON 数组（按填的顺序）', saved.memberPersonaIds === JSON.stringify([dev.id, qa.id]), String(saved.memberPersonaIds));

  const after = await fetchProject(proj.id);
  check('列表里也有简介', after.summary === '把平台做成一个能自己干活的班底', String(after.summary));
  check('列表里也有起止日期', after.startedAt === '2026-10-10' && after.endedAt === '2026-12-31', `${after.startedAt} / ${after.endedAt}`);

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
  const still = await fetchProject(proj.id);
  check('被拒的三次都没动数据', still.pmPersonaId === pm.id && still.summary === '改了一句话', `${still.pmPersonaId} / ${still.summary}`);

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
