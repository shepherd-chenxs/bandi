/**
 * 「仓库值班写卡」的验收（2026-10-17）。
 *
 * 这条链路：巡检脚本 → `POST /api/projects/<id>/repo-cards` → 看板上多一张标着
 * **仓库值班**的卡（能拖、能删）。要钉死三件事：
 *   ① 建得出来、看板认得出（`source: repo` / `repo_count`）；
 *   ② **去重** —— 同一个 key 再来一次只更新，不再建一张；
 *   ③ **不许动状态** —— 人把它拖到「已完成」之后，巡检再写一次仍是「已完成」
 *      （卡的状态是人给的指令；把它弹回「待办」是最招人烦的那种 bug）。
 *
 * 隔离：临时数据库 + 临时端口 + 临时目录。跑法：node apps/server/src/smoke-repo-cards.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-repocards-'));
const PORT = Number(process.env.SMOKE_PORT ?? 8837);
const BASE = `http://127.0.0.1:${PORT}`;

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

const req = async (p, opt = {}) => {
  const r = await fetch(BASE + p, {
    ...opt,
    headers: { 'Content-Type': 'application/json', ...(opt.headers ?? {}) },
  });
  const text = await r.text();
  let b = null;
  try { b = JSON.parse(text); } catch { /* 非 JSON 原样返回 */ }
  return { status: r.status, b, text };
};

/* ------------------------------------------------------------- 起一个控制面 */

const logPath = path.join(tmp, 'server.log');
const logFd = fs.openSync(logPath, 'a');
const child = spawn(process.execPath, [path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs')], {
  cwd: repoRoot,
  env: { ...process.env, BANDI_PORT: String(PORT), BANDI_DATA: tmp, BANDI_DB: path.join(tmp, 'bandi.db') },
  windowsHide: true,
  stdio: ['ignore', logFd, logFd],
});
fs.closeSync(logFd);

let up = false;
for (let i = 0; i < 40; i++) {
  try { if ((await fetch(BASE + '/api/projects')).ok) { up = true; break; } } catch { /* 还没起 */ }
  await new Promise((r) => setTimeout(r, 250));
}
check('控制面起来了', up);
if (!up) {
  console.log(fs.readFileSync(logPath, 'utf8').split('\n').slice(-12).join('\n'));
  child.kill();
  process.exit(1);
}

try {
  /* ------------------------------------------------------------ ① 建卡 */

  console.log('\n① 巡检写一张卡');
  const projects = (await req('/api/projects')).b.projects;
  const pid = projects[0].id;

  const body1 = { key: 'pr:3', title: 'PR #3 待审：改了点东西', body: '结论：待审\n链接：https://github.com/x/y/pull/3' };
  const c1 = await req(`/api/projects/${encodeURIComponent(pid)}/repo-cards`, { method: 'POST', body: JSON.stringify(body1) });
  check('建卡 201', c1.status === 201 && c1.b.created === true, `status=${c1.status} created=${c1.b?.created}`);
  check('来源标成 repo', c1.b.task?.source === 'repo', String(c1.b.task?.source));
  check('去重键存下来了', c1.b.task?.externalKey === 'pr:3', String(c1.b.task?.externalKey));
  check('初始状态是「待办」', c1.b.task?.status === '待办', String(c1.b.task?.status));

  const board1 = (await req(`/api/projects/${encodeURIComponent(pid)}/tasks`)).b;
  const card1 = board1.rows.find((r) => r.manual_id === c1.b.task.id);
  check('看板上认得出：标「仓库值班」', card1?.source_text === '仓库值班', String(card1?.source_text));
  check('看板统计里 repo_count = 1', board1.repo_count === 1, String(board1.repo_count));
  check('它和手工卡一样可拖（带 manual_id）', !!card1?.manual_id);

  console.log('\n② 同一个 key 再来一次：只更新，不新建');
  const body2 = {
    ...body1,
    body: '结论：待审（第二次巡检，描述变长了）\n要跑的命令：node tools/check-pr.mjs && node tools/run-smokes.mjs —— 这一行故意写长，用来验「看板行截断」与「详情全文」的区别。',
  };
  const c2 = await req(`/api/projects/${encodeURIComponent(pid)}/repo-cards`, { method: 'POST', body: JSON.stringify(body2) });
  check('200 且 created=false', c2.status === 200 && c2.b.created === false, `status=${c2.status} created=${c2.b?.created}`);
  check('识别出内容变了', c2.b.changed === true, String(c2.b?.changed));
  check('还是同一张卡（id 不变）', c2.b.task?.id === c1.b.task.id, `${c2.b.task?.id} vs ${c1.b.task?.id}`);
  check('描述更新了', String(c2.b.task?.description).includes('第二次巡检'), String(c2.b.task?.description).slice(0, 40));
  const board2 = (await req(`/api/projects/${encodeURIComponent(pid)}/tasks`)).b;
  check('看板上仍然只有一张', board2.rows.filter((r) => r.external_key === 'pr:3').length === 1, String(board2.rows.filter((r) => r.external_key === 'pr:3').length));

  console.log('\n③ 卡详情拿全文 + 改执行人');
  const full = await req(`/api/projects/tasks/${encodeURIComponent(c1.b.task.id)}`);
  check('单张卡能拿到全文（看板行是截断的）', full.status === 200 && String(full.b?.task?.description ?? '').length > 90, `${String(full.b?.task?.description ?? '').length} 字`);
  check('看板行确实被截短了（所以详情必须有入口）', String(card1?.note ?? '').length <= 91, `${String(card1?.note ?? '').length} 字`);
  const persona = await req('/api/personas', {
    method: 'POST',
    body: JSON.stringify({ name: '测试执行人', role: '研发', runtime: 'codex', instructions: '' }),
  });
  const assigned = await req(`/api/projects/tasks/${encodeURIComponent(c1.b.task.id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ personaId: persona.b.persona.id }),
  });
  check('改执行人成功', assigned.status === 200 && assigned.b?.task?.assigneePersonaId === persona.b.persona.id, String(assigned.b?.task?.assigneePersonaId));
  const boardWho = (await req(`/api/projects/${encodeURIComponent(pid)}/tasks`)).b.rows.find((r) => r.manual_id === c1.b.task.id);
  check('看板上执行人跟着变', boardWho?.assignee === '测试执行人', String(boardWho?.assignee));

  console.log('\n④ 人把它拖到「已完成」→ 巡检再写一次，状态不许被弹回去');
  const moved = await req(`/api/projects/tasks/${encodeURIComponent(c1.b.task.id)}`, { method: 'PATCH', body: JSON.stringify({ status: '已完成' }) });
  check('拖到「已完成」', moved.b?.task?.status === '已完成', String(moved.b?.task?.status));
  const body3 = { ...body1, title: 'PR #3 待审：标题又改了', body: '结论：待审（第三次巡检）' };
  const c3 = await req(`/api/projects/${encodeURIComponent(pid)}/repo-cards`, { method: 'POST', body: JSON.stringify(body3) });
  check('状态还是「已完成」（人的指令优先）', c3.b?.task?.status === '已完成', String(c3.b?.task?.status));
  check('标题跟着更新了', c3.b?.task?.title === body3.title, String(c3.b?.task?.title));

  console.log('\n⑤ 必填校验与清理');
  const noKey = await req(`/api/projects/${encodeURIComponent(pid)}/repo-cards`, { method: 'POST', body: JSON.stringify({ title: '没有 key' }) });
  check('缺去重键 → 400（否则每次巡检都会重复建卡）', noKey.status === 400, `${noKey.status} ${noKey.b?.error ?? ''}`);
  const noTitle = await req(`/api/projects/${encodeURIComponent(pid)}/repo-cards`, { method: 'POST', body: JSON.stringify({ key: 'x:1' }) });
  check('缺标题 → 400', noTitle.status === 400, String(noTitle.status));
  const del = await req(`/api/projects/tasks/${encodeURIComponent(c1.b.task.id)}`, { method: 'DELETE' });
  const board3 = (await req(`/api/projects/${encodeURIComponent(pid)}/tasks`)).b;
  check('删掉＝忽略（卡片没了）', del.status === 200 && board3.rows.every((r) => r.manual_id !== c1.b.task.id));
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
}

console.log(`\n结论：${failed ? `有 ${failed} 项没通过` : '全通过'}`);
process.exit(failed ? 1 : 0);
