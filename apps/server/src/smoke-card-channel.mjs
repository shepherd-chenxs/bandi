/**
 * **建卡通道**的验收（2026-11-11，实报"贺韬三次 400 后自己上手"之后补）。
 *
 * 钉住四件事：
 *   ① 平台兜住模型常见手滑：UTF-16（含 BOM）请求体、批量口裸数组、**群派活项目可省略**；
 *   ② **补记**：`backfill:true` + 实际状态一步建成、不自动派活、来源标 `backfill`；
 *   ③ **验收人 = 派活人**：雇主派的主卡，PM 只能提交「待验收」，不能点「已完成」；
 *      他自己派的卡可以自己验收成「已完成」，也能退回执行人重跑；
 *   ④ 看板行带 `created_by / created_by_user_id`（「只看我的」筛选要用）。
 *
 * ⚠️ 必须在**鉴权形态**下跑（BANDI_HOST=0.0.0.0）：只有这时 `req.bandiAuth.kind === 'run'`
 * 才会成立，验收人闸才走得到；回环免鉴权形态下任何请求都是操作员，那条闸不会触发。
 * 隔离：临时数据目录 + 临时库 + 临时端口，跑完关库删目录。
 * 跑法：node apps/server/src/smoke-card-channel.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const here = import.meta.dirname;
const repo = path.resolve(here, '..', '..', '..');
const url = (rel) => pathToFileURL(path.join(repo, 'apps', 'server', 'src', rel)).href;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-card-channel-'));
const DATA = path.join(tmp, 'data');
fs.mkdirSync(DATA, { recursive: true });
const PORT = Number(process.env.SMOKE_PORT ?? 8841);
const BASE = `http://127.0.0.1:${PORT}`;
process.env.BANDI_DATA = DATA;
process.env.BANDI_DB = path.join(DATA, 'bandi.db');
process.env.BANDI_HOST = '0.0.0.0'; // 鉴权形态：运行钥匙分支才会被走到
process.env.BANDI_PORT = String(PORT);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

const store = await import(url('store.mjs'));
const experts = await import(url('experts.mjs'));
const auth = await import(url('agent-auth.mjs'));
const pt = await import(url('project-tasks.mjs'));

let db = null;
try {
  experts.hireExpert('hetao');
  experts.hireExpert('jiahui');
  const pm = store.getPersona('p-expert-hetao');
  const dev = store.getPersona('p-expert-jiahui');
  const projRoot = path.join(tmp, 'proj');
  fs.mkdirSync(projRoot, { recursive: true });
  const project = store.createProject({ name: '通道验收项目', root: projRoot });
  const groupConv = store.createGroup({ title: '通道验收群', assistantPersonaId: pm.id, memberIds: [dev.id] });
  const groupId = groupConv.groupId;
  store.updateGroup(groupId, { projectId: project.id });
  const run = store.createRun({ conversationId: groupConv.id, runtime: 'codex', personaId: pm.id });
  const token = auth.issueRunCredential(run.id, pm.id).token;

  // 同进程起服务（运行钥匙是进程内 Map，spawn 子进程拿不到）
  await import(url('server.mjs'));
  let up = false;
  for (let i = 0; i < 100 && !up; i += 1) {
    try { up = (await fetch(BASE + '/api/ping', { signal: AbortSignal.timeout(600) })).ok; } catch { await sleep(150); }
  }
  if (!up) throw new Error('控制面没起来');
  let panelToken = '';
  for (let i = 0; i < 50 && !panelToken; i += 1) {
    try { panelToken = fs.readFileSync(path.join(DATA, 'token'), 'utf8').trim(); } catch { await sleep(100); }
  }

  const post = async (rel, body) => {
    const r = await fetch(BASE + rel, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bandi-Run-Token': token },
      body,
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const patch = async (rel, body) => {
    const r = await fetch(BASE + rel, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Bandi-Run-Token': token },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const card = (extra = {}) => ({ title: '通道验收卡', description: '做成什么样算完', ...extra });

  console.log('① 请求体编码：UTF-16LE + BOM（PowerShell 重定向写出来的那种）');
  {
    const json = JSON.stringify({ cards: [card({ status: 'idea', assigneePersonaId: dev.id, idempotencyKey: 'p2-utf16' })] });
    const body = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, 'utf16le')]);
    const r = await post('/api/agent/cards/batch', body);
    check('UTF-16LE → 201', r.status === 201 && r.body.tasks?.length === 1, `${r.status} ${r.body.error ?? ''}`);
  }

  console.log('\n② 请求体形状：裸数组；项目省略 → 用群关联项目');
  {
    const r = await post('/api/agent/cards/batch', JSON.stringify([card({ status: 'idea', assigneePersonaId: dev.id, idempotencyKey: 'p2-array' })]));
    check('裸数组 → 201', r.status === 201 && r.body.tasks?.length === 1, `${r.status} ${r.body.error ?? ''}`);
    check('省略项目 → 群关联项目', r.body.tasks?.[0]?.projectId === project.id, `${r.body.tasks?.[0]?.projectId} / ${project.id}`);
  }

  console.log('\n③ 补记：一步写成实际状态、不重跑、来源 backfill');
  {
    const r = await post('/api/agent/cards/batch', JSON.stringify({ cards: [card({ title: '补记：登录页已改完', status: 'done', backfill: true, assigneePersonaId: dev.id, description: '补记：嘉辉在群里改完，证据见群记录', idempotencyKey: 'p2-backfill' })] }));
    const t = r.body.tasks?.[0];
    check('补记 → 201 且状态「已完成」', r.status === 201 && t?.status === 'done', `${r.status} ${t?.status}`);
    check('补记不重跑（runId 为空）', t && !t.runId, String(t?.runId));
    check('补记来源 = backfill', t?.source === 'backfill', String(t?.source));
  }

  console.log('\n④ 补记只写最终状态：带「待办」不是补记 → 400 E2058');
  {
    const r = await post('/api/agent/cards/batch', JSON.stringify({ cards: [card({ title: '假补记', status: 'todo', backfill: true })] }));
    check('补记 + 待办 → 400 E2058', r.status === 400 && r.body.code === 'E2058', `${r.status} ${r.body.code}`);
  }

  console.log('\n⑤ 验收人 = 派活人：雇主的卡 PM 只能提交待验收');
  {
    const ownerCard = pt.createProjectTask(project, { title: '雇主派的主卡', status: 'review', assigneeGroupId: groupId });
    const bad = await patch(`/api/projects/tasks/${ownerCard.id}`, { status: 'done' });
    check('PM 把主卡改「已完成」→ 403 E4034', bad.status === 403 && bad.body.code === 'E4034', `${bad.status} ${bad.body.code}`);
    const ok = await patch(`/api/projects/tasks/${ownerCard.id}`, { status: 'review' });
    check('提交「待验收」不受影响 → 200', ok.status === 200, String(ok.status));
  }

  console.log('\n⑥ PM 自己派的卡：能自己验收，也能退回执行人重跑');
  {
    const own = await post('/api/agent/cards', JSON.stringify(card({ title: 'PM 自己派的卡', status: 'idea', assigneePersonaId: dev.id, idempotencyKey: 'p2-own' })));
    const id = own.body.task?.id;
    const done = await patch(`/api/projects/tasks/${id}`, { status: 'done' });
    check('自己建的卡改「已完成」→ 200', done.status === 200 && done.body.task?.status === 'done', `${done.status} ${done.body.task?.status ?? done.body.error}`);
    // 验收不通过：退回执行人重跑（回待办 → 服务端自动开工）
    const back = await patch(`/api/projects/tasks/${id}`, { status: 'todo' });
    check('退回执行人重跑 → 200（待办/进行中）', back.status === 200 && ['todo', 'doing'].includes(back.body.task?.status), `${back.status} ${back.body.task?.status ?? ''}`);
  }

  console.log('\n⑦ 看板行带派活人字段（「只看我的」筛选用）');
  {
    const r = await fetch(BASE + `/api/projects/${project.id}/tasks`, { headers: { 'X-Bandi-Token': panelToken } });
    const data = await r.json().catch(() => ({}));
    const row = (data.rows ?? []).find((x) => x.manual_id);
    check('看板行有 created_by / created_by_user_id', row && Object.prototype.hasOwnProperty.call(row, 'created_by_user_id') && Object.prototype.hasOwnProperty.call(row, 'created_by'), row ? JSON.stringify({ c: row.created_by, u: row.created_by_user_id }) : '没行');
  }

  console.log('\n⑧ 执行人「报状态」：人派的卡只能自己上报到「待验收」');
  {
    /*
     * 实报 pt-4b6bf1ec（2026-11-21）：活干完了、推了、冒烟全过，就漏了回话里那行 `[完成]`，
     * 卡白落「已阻塞」。根因不是模型忘性，是**人派的卡没有任何接口通道**能报状态 ——
     * 执行人手里只剩一条"贴字符串"的路。这里钉住新开的那扇最窄的门。
     */
    const devRun = store.createRun({ conversationId: groupConv.id, runtime: 'codex', personaId: dev.id });
    const devToken = auth.issueRunCredential(devRun.id, dev.id).token;
    const patchAsDev = async (rel, body) => {
      const r = await fetch(BASE + rel, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-Bandi-Run-Token': devToken },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    // 人建的卡（createdBy 为空）+ 执行人 = 嘉辉，正是实报里那种卡
    const assigned = pt.createProjectTask(project, { title: '人派给嘉辉的卡', status: 'blocked', personaId: dev.id });
    const reported = await patchAsDev(`/api/projects/tasks/${assigned.id}`, { status: 'review' });
    check('执行人上报「待验收」→ 200', reported.status === 200 && reported.body.task?.status === 'review',
      `${reported.status} ${reported.body.task?.status ?? reported.body.error}`);
    const noDone = await patchAsDev(`/api/projects/tasks/${assigned.id}`, { status: 'done' });
    check('自己点「已完成」→ 403 E4034（验收权不下放）', noDone.status === 403 && noDone.body.code === 'E4034',
      `${noDone.status} ${noDone.body.code}`);
    const extra = await patchAsDev(`/api/projects/tasks/${assigned.id}`, { status: 'review', description: '顺手改描述' });
    check('夹带别的字段 → 403（只许报状态，不许改卡）', extra.status === 403 && extra.body.code === 'E4034',
      `${extra.status} ${extra.body.code}`);
    const notMine = await patch(`/api/projects/tasks/${assigned.id}`, { status: 'review' }); // PM 的钥匙
    check('别人的执行人可以看不能改 → 403', notMine.status === 403, `${notMine.status} ${notMine.body.code ?? ''}`);

    /*
     * 收尾这一步是关键：卡已经不在「进行中」，旧的 `onTaskRunFinished` 会直接 return ——
     * 于是"执行人用接口报的状态"既不会补 `[运行结束]`，也不会给派活人发回执。
     * 新口径：只要状态是这一轮内上报的 review，就补交代 + 发回执，但**不改状态**。
     */
    store.updateProjectTask(assigned.id, { runId: devRun.id });
    /*
     * ⚠️ **这里传的对象必须是 finishHooks 真实拿到的那种形态**（2026-11-21 血的教训）。
     *
     * 第一版这条冒烟传的是 `{ id, status, startedAt, finalText }` —— 比真实内存 run **多一个**
     * `startedAt`。于是判据在测试里成立、在线上恒不成立：runs.mjs 的内存 run 当时根本没有这个
     * 字段（只有 DB 行有），`!!run.startedAt` 永远 false，员工用接口报的「待验收」既不补
     * `[运行结束]`、也不发回执，**全程无声**（实报 pt-b82d3193：张坤把卡报成待验收，
     * 群里一条「请验收」都没有，人得自己去翻看板）。
     *
     * 所以这里故意**只传真实的三个字段**：造一个比真对象更完整的假对象，等于把 bug 藏起来。
     * `notify:false` 是有意的：这套冒烟会真起服务，notify 会去唤醒建卡人（一次真派活）。
     * 回执与补描述在同一条分支上（判据过了两个都执行），判据由「补了 [运行结束]」证伪。
     */
    const memoryRun = { id: devRun.id, status: 'done', finalText: '' };
    check('（前提）真实内存 run 形态里没有 startedAt', !('startedAt' in memoryRun), '带了 startedAt 就等于又造了个假对象，测不出这次的问题');
    pt.onTaskRunFinished(memoryRun, { notify: false });
    const after = store.getProjectTask(assigned.id);
    check('收尾不把上报过的卡写回「已阻塞」', after.status === 'review', after.status);
    check('run 不带 startedAt 也补上「[运行结束]」（从库里兜底，不许静默失效）',
      /\[运行结束\]/.test(after.description ?? ''), (after.description ?? '').slice(-46));

    /*
     * 兜底之外还要钉**正本**：`finishHooks` 只拿得到 runs.mjs 那个内存对象，
     * 它要是又漏了 startedAt，这里靠 DB 兜住的每一天都是"侥幸没坏"。
     */
    const runsSrc = fs.readFileSync(new URL('./runs.mjs', import.meta.url), 'utf8');
    check('runs.mjs 的内存 run 自带 startedAt（收尾判据的正本）',
      /startedAt:\s*row\.startedAt/.test(runsSrc));

    /*
     * **验收人退回卡**（2026-11-21 实报 pt-b82d3193，同一天第二个 403）。
     *
     * 贺韬是这张卡的建卡人、pm 岗、有 `card.advance` —— 权限全对，退回却被 403 挡住。
     * 原因不是权限，是**他多带了一个 `note`**（想把"为什么退回"写清楚），而运行钥匙的字段
     * 白名单里没这一项。于是他只能在群里口头说"未验收通过"，卡上干干净净，
     * 执行人下一轮还得猜"到底缺什么"。
     *
     * 这里钉两件事：带 note 要放行；理由要**追加**进描述（不是覆盖原有验收标准）。
     */
    const pmId = store.listPersonas().find((p) => p.roleKey === 'pm')?.id ?? null;
    if (pmId) {
      const pmRun = store.createRun({ conversationId: groupConv.id, runtime: 'codex', personaId: pmId });
      const pmToken = auth.issueRunCredential(pmRun.id, pmId).token;
      const patchAsPm = async (rel, body) => {
        const r = await fetch(BASE + rel, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'X-Bandi-Run-Token': pmToken },
          body: JSON.stringify(body),
        });
        return { status: r.status, body: await r.json().catch(() => ({})) };
      };
      const own = pt.createProjectTask(project, {
        title: '验收人退回测试卡',
        description: '验收标准：PR 链接 + 工作区干净',
        status: 'review',
        personaId: dev.id,
        createdBy: pmId,
        creatorConvId: groupConv.id,
      });
      // 用 blocked（不触发自动派活，冒烟里不能真起 run）
      const back = await patchAsPm(`/api/projects/tasks/${own.id}`, { status: 'blocked', note: '证据不全：缺 PR 链接' });
      check('验收人带回退理由（note）→ 200（以前 403 全挡）', back.status === 200,
        `${back.status} ${back.body.code ?? ''} ${back.body.error ?? ''}`);
      const ownAfter = store.getProjectTask(own.id);
      check('退回理由追加进描述，原验收标准没被覆盖',
        ownAfter.status === 'blocked' && /\[退回\] 证据不全：缺 PR 链接/.test(ownAfter.description ?? '') &&
          /验收标准：PR 链接/.test(ownAfter.description ?? ''),
        (ownAfter.description ?? '').slice(-60));
    } else {
      check('库里有 pm 岗员工（否则这条测不了）', false, '找不到 roleKey=pm');
    }
  }

  console.log('\n⑨ 群会话建卡：执行人必须是群成员（2026-11-21 实报：贺韬把活派给了不在群里的嘉辉，卡成了黑箱）');
  {
    /*
     * 雇主在群里问「这个群能为我干嘛」，贺韬建卡 @ 了**不在群里**的嘉辉 —— 卡票进了群，
     * 被派的人却看不见这场对话。以前只有**子卡**校验"执行人不在主卡群里"，普通卡没有 ——
     * 这里钉住补上的闸：发起会话是群 → 执行人必须在群；1:1 建卡不受这条管。
     */
    experts.hireExpert('lijun');                       // 群外人：李俊没进「通道验收群」
    const outsider = store.getPersona('p-expert-lijun');
    const rejected = await post('/api/agent/cards', JSON.stringify(card({
      title: '派给群外人的卡', status: 'todo', assigneePersonaId: outsider.id, idempotencyKey: 'p2-outsider',
    })));
    check('执行人不在群里 → 400 E2059', rejected.status === 400 && rejected.body.code === 'E2059',
      `${rejected.status} ${rejected.body.code ?? ''} ${String(rejected.body.error ?? '').slice(0, 60)}`);
    check('错误话术点破「不在群里」并给出群成员名单', /不在发起这场派活的群里/.test(rejected.body.error ?? '') && /嘉辉/.test(rejected.body.error ?? ''),
      String(rejected.body.error ?? '').slice(0, 90));
    // 正向对照：同一条通道、执行人在群里 → 照常建（idea 不派活，冒烟里不起 run）
    const insider = await post('/api/agent/cards', JSON.stringify(card({
      title: '派给群内人的卡', status: 'idea', assigneePersonaId: dev.id, idempotencyKey: 'p2-insider',
    })));
    check('执行人在群里 → 照常 201', insider.status === 201 && !!insider.body.task?.id,
      `${insider.status} ${String(insider.body.error ?? '').slice(0, 60)}`);
  }

  // 关库再删目录（Windows 上库还开着删不掉）
  try { db = await import(pathToFileURL(path.join(repo, 'apps/server/src/store/db.mjs')).href); db.db.close(); } catch { /* 关不掉就算了 */ }
} catch (e) {
  console.log('\n跑挂了：' + String(e?.message ?? e));
  failed += 1;
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
}

console.log(failed ? `\n✗ ${failed} 项没过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
