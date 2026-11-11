/**
 * **团队协作（派给群）** 的验收（2026-11-09 用户定稿）。
 *
 * 定稿规则：
 *   · 卡只记**执行群**（`assigneeGroupId`），**不记协调人** —— 派发/子卡授权/回执都
 *     **现读**群上的 `assistantPersonaId`（群助手），换人自动跟随；
 *   · **群助手必须是项目经理岗**（用户："拆卡人自己也是执行者，很容易自己等自己把任务卡死"）；
 *   · 群助手可以拆**子卡**（挂 parentTaskId、只一层、派本群成员、不能派给自己）；
 *   · 子卡回执唤醒**当前群助手**；主卡回执仍回建卡人。
 *
 * 钉住这些：
 *   ① 建卡派给群 → 派活票进群、群助手起跑、卡转「进行中」；
 *   ② 群助手不是 PM 的群 → 建卡直接 400（建不出来注定派不出去的卡）；
 *   ③ 群助手拆子卡 → 允许；子卡派给群成员、跑完回执唤醒群助手；
 *   ④ 别的 PM（不是本群群助手）拆子卡 → 403 E2057；
 *   ⑤ 群助手把子卡派给自己 → 400 E2059（自拆自接会把任务卡死）；
 *   ⑥ 群助手换人后派**已建的卡** → 跟着**新**群助手走（动态取，不是建卡时快照）。
 *
 * 隔离：临时数据目录 + 临时端口 + 临时项目目录。
 * 跑法：node apps/server/src/smoke-group-tasks.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const FAKE = path.join(here, 'fixtures', 'fake-agent.js');
const PORT = Number(process.env.SMOKE_PORT ?? 8820);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-group-tasks-'));
const OP_TOKEN = 'smoke-group-tasks-op-token';
const projRoot = path.join(tmp, 'proj');
fs.mkdirSync(projRoot, { recursive: true });

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, [path.join(here, 'server.mjs')], {
  cwd: repoRoot,
  env: {
    ...process.env,
    BANDI_DATA: tmp,
    BANDI_DB: path.join(tmp, 'bandi.db'),
    BANDI_PORT: String(PORT),
    // 强制鉴权：改卡权限要验**运行钥匙**（回环免鉴权形态下所有请求都是 operator，验不出来）
    BANDI_HOST: '0.0.0.0',
    BANDI_TOKEN: OP_TOKEN,
    BANDI_FAKE_ECHO: 'full',
    BANDI_FAKE_CREATE_CARD: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let slog = '';
server.stdout.on('data', (c) => (slog += c));
server.stderr.on('data', (c) => (slog += c));

async function req(method, p, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Bandi': '1', 'X-Bandi-Token': OP_TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function waitUp(ms = 30000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      // 强制鉴权形态下 /api/state 要令牌；用公开的 /api/hello 判活
      const r = await fetch(BASE + '/api/hello', { signal: AbortSignal.timeout(800) });
      if (r.ok) return true;
    } catch { /* 还没起 */ }
    await sleep(200);
  }
  return false;
}

const getConv = async (id) => (await req('GET', `/api/conversations/${id}`)).body;
async function waitAllDone(convId, ms = 30000) {
  const until = Date.now() + ms;
  let d = await getConv(convId);
  while (Date.now() < until) {
    d = await getConv(convId);
    const runs = d.runs ?? [];
    if (runs.length && runs.every((x) => x.status !== '跑中')) return d;
    await sleep(150);
  }
  return d;
}
const boardText = async (pid) => JSON.stringify((await req('GET', `/api/projects/${pid}/tasks`)).body);
const getTask = async (id) => (await req('GET', `/api/projects/tasks/${id}`)).body.task;

/** 往群里说一句（会按 @ 派给对应成员），等跑完返回这次的回复 */
async function sayInGroup(convId, text) {
  const r = await req('POST', `/api/conversations/${convId}/messages`, { text });
  if (r.status !== 202) throw new Error(`群里发消息失败：${r.status} ${JSON.stringify(r.body)}`);
  const d = await waitAllDone(convId);
  const msg = (d.messages ?? []).find((m) => m.role === 'assistant' && m.runId === r.body.runId);
  return msg?.text ?? '';
}

try {
  if (!(await waitUp())) throw new Error('控制面没起来：' + slog.slice(-600));

  const addRt = await req('POST', '/api/devices/local/runtimes', { family: 'codex', label: '假 CLI', path: FAKE });
  const rtId = addRt.body.runtime?.id;
  check('接上假运行时', addRt.status === 201 && !!rtId, String(addRt.status));

  const mk = async (name, role) =>
    (await req('POST', '/api/personas', {
      name, runtime: rtId, sandbox: 'danger-full-access', cwd: projRoot, role, instructions: `你是${name}。`,
    })).body.persona;
  const pm = await mk('贺韬', '项目经理 · 拆活盯落实');
  const pm2 = await mk('沈丹青', '项目经理 · 另一条线');
  const dev = await mk('嘉辉', '研发工程师 · 写代码');
  const project = (await req('POST', '/api/projects', { name: '团队协作验收项目', root: projRoot })).body.project;

  const madeGroup = await req('POST', '/api/groups', {
    title: '团队协作验收群',
    assistantPersonaId: pm.id,
    memberIds: [dev.id],
  });
  const group = madeGroup.body.group;
  const groupConv = madeGroup.body.conversation.id;
  check('建群：群助手=项目经理、成员含研发', madeGroup.status === 201 && group?.assistantPersonaId === pm.id, `${madeGroup.status}`);

  console.log('\n① 建卡派给群 → 派活票进群、群助手起跑、卡转「进行中」');
  const c1 = await req('POST', `/api/projects/${project.id}/tasks`, {
    title: '团队卡：拆活给研发', status: '待办', assigneeGroupId: group.id, startNow: true,
  });
  check('建卡成功', c1.status === 201 && c1.body.task?.assigneeGroupId === group.id, `${c1.status} ${c1.body.error ?? ''}`);
  const card1Id = c1.body.task?.id;
  let d1 = await waitAllDone(groupConv);
  check('群助手真的起跑了一轮', (d1.runs ?? []).some((r) => r.personaId === pm.id), String((d1.runs ?? []).length));
  const ticket = (d1.messages ?? []).find((m) => m.meta?.type === 'card' && m.meta?.cardId === card1Id);
  check('群里落了带卡号的派活票', !!ticket, ticket?.text?.slice(0, 60) ?? '没找到');
  const card1 = await getTask(card1Id);
  // 假 agent 秒完成：收尾钩子可能已经把卡收成「待验收」了 —— 钉"派活生效 + 挂到群会话"
  check('卡派活生效并挂到群会话', ['进行中', '待验收'].includes(card1?.status) && card1?.conversationId === groupConv, `${card1?.status}/${card1?.conversationId}`);
  // 跑完收「待验收」：靠 run 收尾钩子认卡（runId 落在卡上）
  const c1After = await getTask(card1Id);
  check('跑完收「待验收」（run 收尾钩子认得出这张卡）', c1After?.status === '待验收', String(c1After?.status));

  console.log('\n② 群助手不是项目经理 → 建卡直接 400（不建注定派不出去的卡）');
  const badGroup = (await req('POST', '/api/groups', { title: '没有PM的群', assistantPersonaId: dev.id, memberIds: [pm.id] })).body.group;
  const bad = await req('POST', `/api/projects/${project.id}/tasks`, {
    title: '不该建出来的团队卡', status: '待办', assigneeGroupId: badGroup.id,
  });
  check('被 400 拒掉且说清原因', bad.status === 400 && /不能承接团队协作卡/.test(String(bad.body.error ?? '')), `${bad.status} ${bad.body.error ?? ''}`);
  check('卡确实没建出来', !(await boardText(project.id)).includes('不该建出来的团队卡'), '');

  console.log('\n③ 群助手拆子卡 → 允许；跑完回执唤醒群助手');
  const parent = (await req('POST', `/api/projects/${project.id}/tasks`, {
    title: '团队卡：要拆给两个人', status: '待办', assigneeGroupId: group.id,
  })).body.task;
  check('主卡建成（待办、先不派）', parent?.status === '待办' && !!parent?.assigneeGroupId, `${parent?.status}`);
  const r3 = await sayInGroup(groupConv,
    `@${pm.name} 【批量建卡】${JSON.stringify({ projectId: project.id, cards: [
      { title: '子卡：研发实现', description: '拆出来的活', status: '待办', assigneePersonaId: dev.id, parentTaskId: parent.id, idempotencyKey: 'team-sub-1' },
    ] })} 拆一下`);
  check('子卡建成（201）', /FAKE-BATCH:201:1:0/.test(r3), r3.match(/FAKE-BATCH:\S+/)?.[0] ?? r3.slice(-120));
  const board1 = await boardText(project.id);
  check('子卡挂上主卡（parent_id）', new RegExp(`"parent_id":"${parent.id}"`).test(board1), '');
  // 子卡派给研发 → 研发跑完 → 子卡待验收 → 回执唤醒群助手（贺韬）
  let receipt = null;
  for (let i = 0; i < 60 && !receipt; i += 1) {
    const dd = await getConv(groupConv);
    receipt = (dd.messages ?? []).find((m) => String(m.text ?? '').includes('【子卡回执】'));
    if (!receipt) await sleep(150);
  }
  check('子卡回执进群了（回执唤醒的是群助手）', !!receipt, receipt?.text?.slice(0, 80) ?? '没等到');
  const dd3 = await getConv(groupConv);
  check('群助手被回执唤醒（又跑了一轮）', (dd3.runs ?? []).filter((r) => r.personaId === pm.id).length >= 3, String((dd3.runs ?? []).filter((r) => r.personaId === pm.id).length));

  console.log('\n④ 别的 PM（不是本群群助手）拆子卡 → 403 E2057');
  await req('POST', `/api/groups/${encodeURIComponent(group.id)}/members`, { personaIds: [pm2.id] });
  // 开一段新群会话再试：老会话里躺着上一轮【批量建卡】的历史，假 CLI 会把它也读进来
  // （真模型也会，所以负面用例必须给它一段干净上下文才测得准）
  const negConv1 = (await req('POST', `/api/groups/${encodeURIComponent(group.id)}/sessions`, {})).body.conversation.id;
  const r4 = await sayInGroup(negConv1,
    `@${pm2.name} 【建卡】${JSON.stringify({ title: '越权子卡', status: '待办', projectId: project.id, assigneePersonaId: dev.id, parentTaskId: parent.id })} 试着拆`);
  check('被拒 403 E2057', /FAKE-CARD:403:E2057/.test(r4), r4.match(/FAKE-CARD:\S+/)?.[0] ?? r4.slice(-120));
  check('越权子卡没建出来', !(await boardText(project.id)).includes('越权子卡'), '');

  console.log('\n⑤ 群助手把子卡派给自己 → 400 E2059（自拆自接会把任务卡死）');
  const negConv2 = (await req('POST', `/api/groups/${encodeURIComponent(group.id)}/sessions`, {})).body.conversation.id;
  const r5 = await sayInGroup(negConv2,
    `@${pm.name} 【建卡】${JSON.stringify({ title: '自己拆给自己', status: '待办', projectId: project.id, assigneePersonaId: pm.id, parentTaskId: parent.id })} 试着拆`);
  check('被拒 400 E2059 且说清原因', /FAKE-CARD:400:E2059/.test(r5) && /派给自己/.test(r5), r5.match(/FAKE-CARD:\S+/)?.[0] ?? r5.slice(-120));

  console.log('\n⑦ 运行钥匙改卡：自己建的卡 / 自己当群助手的卡能改；别人不能（PM 能闭环 "Next"）');
  // 7a. 群助手（当前群助手=贺韬）改一张**团队的卡**：允许
  const manage1 = (await req('POST', `/api/projects/${project.id}/tasks`, {
    title: '待取消卡', status: '想法', assigneeGroupId: group.id,
  })).body.task;
  const convM1 = (await req('POST', `/api/groups/${encodeURIComponent(group.id)}/sessions`, {})).body.conversation.id;
  const r7a = await sayInGroup(convM1, `@${pm.name} 【改卡】${JSON.stringify({ id: manage1.id, body: { status: '已取消' } })} 取消它`);
  check('群助手能改团队的卡（取消）', /FAKE-PATCH:200::已取消/.test(r7a), r7a.match(/FAKE-PATCH:\S+/)?.[0] ?? r7a.slice(-120));
  check('卡真的被取消了', (await getTask(manage1.id))?.status === '已取消', String((await getTask(manage1.id))?.status));

  // 7b. 别的 PM（还不是本群群助手）改团队的卡：403
  const manage2 = (await req('POST', `/api/projects/${project.id}/tasks`, {
    title: '不该被改的卡', status: '想法', assigneeGroupId: group.id,
  })).body.task;
  const convM2 = (await req('POST', `/api/groups/${encodeURIComponent(group.id)}/sessions`, {})).body.conversation.id;
  const r7b = await sayInGroup(convM2, `@${pm2.name} 【改卡】${JSON.stringify({ id: manage2.id, body: { status: '已取消' } })} 取消它`);
  check('别的 PM 改不了（403 E4034）', /FAKE-PATCH:403:E4034/.test(r7b), r7b.match(/FAKE-PATCH:\S+/)?.[0] ?? r7b.slice(-120));
  check('卡没被改动', (await getTask(manage2.id))?.status === '想法', String((await getTask(manage2.id))?.status));

  // 7c. 运行钥匙改卡只开放四样字段（范围 / 验收 / 流程归属仍归人）
  const convM3 = (await req('POST', `/api/groups/${encodeURIComponent(group.id)}/sessions`, {})).body.conversation.id;
  const r7c = await sayInGroup(convM3, `@${pm.name} 【改卡】${JSON.stringify({ id: manage2.id, body: { title: '改个名字' } })} 改名`);
  check('范围外字段被拒（403 E4034）', /FAKE-PATCH:403:E4034/.test(r7c) && /只开放/.test(r7c), r7c.match(/FAKE-PATCH:\S+/)?.[0]?.slice(0, 160) ?? r7c.slice(-120));

  // 7d. PM 改**自己建的**卡（③ 拆出来的子卡，createdBy=贺韬）：允许（退待办 = 返工）
  const board7 = (await req('GET', `/api/projects/${project.id}/tasks`)).body;
  const sub = (board7.columns ?? []).flatMap((c) => c.cards ?? []).find((c) => c.parent_id === parent.id && c.manual_id);
  const subId = sub?.manual_id;
  check('找得到 ③ 拆出来的子卡', !!subId, String(subId ?? ''));
  const convM4 = (await req('POST', `/api/groups/${encodeURIComponent(group.id)}/sessions`, {})).body.conversation.id;
  const r7d = await sayInGroup(convM4, `@${pm.name} 【改卡】${JSON.stringify({ id: subId, body: { status: '待办' } })} 退回去返工`);
  check('建卡人（PM）能把自己建的卡退回待办/重跑', /FAKE-PATCH:200:/.test(r7d), r7d.match(/FAKE-PATCH:\S+/)?.[0] ?? r7d.slice(-120));

  console.log('\n⑥ 动态取群助手：换群助手后，派已建的卡跟着**新**群助手走');
  const card2 = (await req('POST', `/api/projects/${project.id}/tasks`, {
    title: '团队卡：换人后再派', status: '待办', assigneeGroupId: group.id,
  })).body.task;
  check('卡先建着（待办、不派）', card2?.status === '待办', String(card2?.status));
  const swapped = await req('PATCH', `/api/groups/${encodeURIComponent(group.id)}`, { assistantPersonaId: pm2.id });
  check('群助手换成沈丹青', swapped.status === 200, `${swapped.status} ${swapped.body.error ?? ''}`);
  const started = await req('PATCH', `/api/projects/tasks/${card2.id}`, { startNow: true });
  /*
   * 群助手刚被换掉时，新助手可能还在跑上一条（⑦b 的派活）：这时平台按既有口径
   * 「排上队、稍后自动重派」返回 400 —— 那是正确行为，不是"派不出去"。
   * CI 比本机慢，这里改成等它真派出去（最多 8 秒），别把正确的排队判成失败。
   */
  let dispatched = started.status === 200 && !!started.body.task?.runId;
  if (!dispatched && /排上队/.test(started.body?.error ?? '')) {
    const until = Date.now() + 8000;
    while (Date.now() < until) {
      await sleep(250);
      const t = await getTask(card2.id);
      if (t?.runId || t?.status === '进行中') { dispatched = true; break; }
    }
  }
  check('派发出去了（换人后仍能派）', dispatched, `${started.status} ${started.body.error ?? ''}`);
  const d6 = await waitAllDone(groupConv);
  check('跑的是新群助手（沈丹青）', (d6.runs ?? []).some((r) => r.personaId === pm2.id), '');
  const ticket6 = (d6.messages ?? []).find((m) => m.meta?.type === 'card' && m.meta?.cardId === card2.id);
  check('派活票上是新群助手的名字', !!ticket6 && String(ticket6.text ?? '').includes(pm2.name), ticket6?.text?.slice(0, 60) ?? '没找到');
} catch (err) {
  console.log('\n跑挂了：' + String(err?.message ?? err) + '\n' + slog.slice(-1000));
  failed += 1;
} finally {
  try { server.kill(); } catch { /* 已退 */ }
  await sleep(600);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
}

console.log(failed ? `\n✗ ${failed} 项没过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
