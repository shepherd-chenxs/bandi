/**
 * 项目经理「建卡通道」的验收（2026-10-24 主理人拍板：只有项目经理岗位能建卡）。
 *
 * 钉住五件事：
 *   ① 没钥匙 / 假钥匙 → 401（E2056）—— 通道不是谁都能敲；
 *   ② 项目经理建「想法」卡 → 建成、记创建人、不派活（等雇主拍板）；
 *   ③ 项目经理建「待办」+ 执行人 → 建成并**自动派活**，跑完收「待验收」；
 *      派活带出来的下一环没有【建卡】标记，不会再建卡（不滚雪球）；
 *   ④ 非项目经理岗位（研发）带钥匙来建 → 403（E2057），卡不存在；
 *   ⑤ 建卡走的是与人手建卡同一条链路（startProjectTask → dispatchToThread），
 *      所以 ③ 的执行痕迹、状态机与人建的卡一模一样；
 *   ⑥ 卡片回执（2026-10-24）：③ 的执行人跑完、卡收「待验收」时，建卡会话收到【卡片回执】
 *      且贺韬被唤醒 —— "有产出我再回你"的承诺有通道兑现。
 *
 * 用 fixtures/fake-agent.js 当运行时（BANDI_FAKE_CREATE_CARD=1 时遇【建卡】标记真调接口）。
 * 隔离：临时数据目录 + 临时端口 + 临时项目目录。
 * 跑法：node apps/server/src/smoke-agent-cards.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const FAKE = path.join(here, 'fixtures', 'fake-agent.js');
const PORT = Number(process.env.SMOKE_PORT ?? 8816);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-agent-cards-'));
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
    BANDI_HOST: '127.0.0.1',
    BANDI_FAKE_ECHO: 'full',
    BANDI_FAKE_CREATE_CARD: '1', // fake-agent 遇【建卡】标记就真调接口（body 从标记行取，每轮可不同）
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let slog = '';
server.stdout.on('data', (c) => (slog += c));
server.stderr.on('data', (c) => (slog += c));

async function waitUp(ms = 30000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(BASE + '/api/state', { signal: AbortSignal.timeout(800) });
      if (r.ok) return true;
    } catch { /* 还没起 */ }
    await sleep(200);
  }
  return false;
}

async function req(method, p, body, headers = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Bandi': '1', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

const getConv = async (id) => (await req('GET', `/api/conversations/${id}`)).body;
const getTask = async (id) => (await req('GET', `/api/projects/tasks/${id}`)).body.task;
/** 看板 JSON 里某标题出现几次（断言"卡只建了一张 / 被拒的卡不存在"用） */
const boardText = async (projectId) => JSON.stringify((await req('GET', `/api/projects/${projectId}/tasks`)).body);

/** 等会话里所有 run 跑完（fake-agent 很快；上限 30 秒），返回会话详情 */
async function waitAllDone(convId, ms = 30000) {
  const until = Date.now() + ms;
  if (!convId) return {}; // 卡上没带会话（派活没成）—— 别白等 30 秒
  let d = await getConv(convId);
  while (Date.now() < until) {
    d = await getConv(convId);
    if ((d.runs ?? []).length > 0 && (d.runs ?? []).every((x) => x.status !== '跑中')) return d;
    await sleep(150);
  }
  return d;
}

/** 给某个员工的 1:1 会话发一句话并等他跑完，返回 { res, reply }（reply 是**这一次 run**的回话） */
async function talk(convId, text) {
  const r = await req('POST', `/api/conversations/${convId}/messages`, { text });
  if (r.status !== 202) return { res: r, reply: '' };
  const d = await waitAllDone(convId);
  const msg = (d.messages ?? []).find((m) => m.role === 'assistant' && m.runId === r.body.runId);
  return { res: r, reply: msg?.text ?? '' };
}

try {
  if (!(await waitUp())) throw new Error('控制面没起来：' + slog.slice(-600));

  const addRt = await req('POST', '/api/devices/local/runtimes', { family: 'codex', label: '假 CLI', path: FAKE });
  check('接上假运行时', addRt.status === 201 && !!addRt.body.runtime?.id, `${addRt.status}`);
  const rtId = addRt.body.runtime?.id;

  const project = (await req('POST', '/api/projects', { name: '建卡验收项目', root: projRoot })).body.project;
  const mk = async (name, role) => (await req('POST', '/api/personas', {
    name, runtime: rtId, sandbox: 'danger-full-access', cwd: projRoot, role, instructions: `你是${name}。`,
  })).body.persona;
  const pm = await mk('贺韬', '项目经理 · 拆活盯落实');
  const dev = await mk('嘉辉', '研发工程师 · 写代码与修 Bug');

  const pmConv = (await req('POST', '/api/conversations', { personaId: pm.id })).body.conversation.id;
  const devConv = (await req('POST', '/api/conversations', { personaId: dev.id })).body.conversation.id;

  console.log('\n① 没钥匙 / 假钥匙 → 401（通道不是谁都能敲）');
  const noKey = await req('POST', '/api/agent/cards', { title: '偷建一张' });
  check('无钥匙 → 401 E2056', noKey.status === 401 && noKey.body.code === 'E2056', `${noKey.status} ${noKey.body.code}`);
  const badKey = await req('POST', '/api/agent/cards', { title: '偷建一张' }, { 'X-Bandi-Run-Token': 'rt-fake' });
  check('假钥匙 → 401 E2056', badKey.status === 401 && badKey.body.code === 'E2056', `${badKey.status} ${badKey.body.code}`);

  console.log('\n② 项目经理建「想法」卡：建成、记创建人、不派活');
  const idea = await talk(pmConv, `【建卡】{"title":"重做登录页","description":"先出两版候选","status":"想法","projectId":"${project.id}"} 上面是你今天要立的卡`);
  check('接口收下（201）且是想法态', /FAKE-CARD:201:pt-[a-z0-9]+:想法/.test(idea.reply), idea.reply.match(/FAKE-CARD:\S+/)?.[0] ?? idea.reply.slice(-80));
  const ideaId = idea.reply.match(/FAKE-CARD:201:(pt-[a-z0-9]+)/)?.[1];
  const ideaCard = ideaId ? await getTask(ideaId) : null;
  check('卡真的在看板上', !!ideaCard, ideaId ?? '没拿到卡 id');
  check('创建人记的是贺韬', ideaCard?.createdBy === pm.id, String(ideaCard?.createdBy));
  check('想法不派活（没 run）', !!ideaCard && !ideaCard.runId && ideaCard.status === '想法', `${ideaCard?.status}/${ideaCard?.runId}`);

  console.log('\n③ 项目经理建「待办」+ 执行人：建成并自动派活，跑完收「待验收」');
  const work = await talk(pmConv, `【建卡】{"title":"修列表样式","description":"跑绿 tools/smoke-help-pop.mjs 算完","status":"待办","projectId":"${project.id}","assigneePersonaId":"${dev.id}"} 立这张卡`);
  const workId = work.reply.match(/FAKE-CARD:201:(pt-[a-z0-9]+)/)?.[1];
  check('接口收下（201）', !!workId, work.reply.match(/FAKE-CARD:\S+/)?.[0] ?? work.reply.slice(-80));
  let workCard = workId ? await getTask(workId) : null;
  /*
   * 只断言「派了活」：卡上挂了 runId 就算数。别钉死「进行中」——
   * fake-agent 秒完成，收尾钩子（onTaskRunFinished）可能在你查的时候已经把卡收成「待验收」了，
   * 钉状态就是在跟调度器抢跑（2026-10-24 实测偶发红）。最终落点由下面那条「跑完收待验收」管。
   */
  check(
    '建完自动派活（有 run）',
    !!workCard?.runId && ['进行中', '待验收'].includes(workCard?.status),
    `${workCard?.status}/${workCard?.runId}`,
  );
  const devDone = await waitAllDone(workCard?.conversationId);
  check('执行人（嘉辉）真跑完了', (devDone.runs ?? []).some((r) => r.personaId === dev.id && r.status === '完成'));
  workCard = await getTask(workId);
  check('跑完收「待验收」等雇主', workCard?.status === '待验收', String(workCard?.status));
  // 一张卡在看板 JSON 里出现两次（columns[].cards 与 rows 各一份，同一个对象）—— 4 次才是多建了一张。
  // ⚠️ 不能数裸 id：PM 的会话在看板上本有一张「聊天派活」行，行名跟随最新一条消息 ——
  // 回执消息里带着卡号，裸 id 会被它误伤（2026-10-24 回执上线时踩到）。按 manual_id 数才准。
  const boardJson = await boardText(project.id);
  const cardOccurrences = (boardJson.match(new RegExp(`"manual_id":"${workId}"`, 'g')) ?? []).length;
  check('派活带出来的下一环没有再建卡（不滚雪球）', cardOccurrences === 2, `看板上这张卡出现 ${cardOccurrences} 次（1 张卡 = 2 次）`);

  console.log('\n③+ 卡片回执：执行人跑完 → 建卡人（贺韬）在他的会话里被唤醒');
  // 他答应雇主"有产出我再回你" —— 现在这句承诺有通道兑现了：卡收「待验收」的同时，
  // 平台往建卡会话（pmConv）投一条【卡片回执】并唤醒贺韬。派发发生在收尾钩子里，
  // 比轮询看到"跑完"晚一拍，所以轮着等（上限 6 秒）。
  /*
   * 回执的新口径（2026-10-24 用户定）：**执行者汇报，不是"我"说的话** ——
   * 可见的那条是嘉辉（执行人）名义的 assistant 消息、带卡票；
   * 唤醒贺韬的触发是 meta.silent 的 user 消息，agent 读得到、界面上不画。
   */
  let receipt = null;
  for (let i = 0; i < 40 && !receipt; i++) {
    const d = await getConv(pmConv);
    receipt = (d.messages ?? []).find((m) => m.role === 'assistant' && m.meta?.type === 'card' && m.meta?.cardId === workId && m.meta?.status === '待验收');
    if (!receipt) await sleep(150);
  }
  check('回执是执行人（嘉辉）名义的汇报', receipt?.personaId === dev.id && receipt?.role === 'assistant', `${receipt?.role}/${receipt?.personaId}`);
  check('回执里带卡号与状态', !!receipt?.text?.includes(workId) && !!receipt?.text?.includes('待验收'), '');
  check('回执带卡票 meta 快照', receipt?.meta?.title === '修列表样式' && receipt?.meta?.assignee === '嘉辉', JSON.stringify(receipt?.meta ?? null));
  const pmAfter = await getConv(pmConv);
  const wake = (pmAfter.messages ?? []).find((m) => m.role === 'user' && m.meta?.silent && m.text.includes('【卡片回执】'));
  check('唤醒触发落了（silent，界面不画）', !!wake, wake?.text?.slice(0, 60) ?? '没找到');
  check('贺韬被回执唤醒（他多跑了一轮）', (pmAfter.runs ?? []).length >= 3, `pmConv 共 ${(pmAfter.runs ?? []).length} 轮（②③各一 + 回执）`);
  check('卡记下已回执状态（去重标记）', (await getTask(workId))?.notifiedFor === '待验收', String((await getTask(workId))?.notifiedFor));

  /*
   * 卡票消息（2026-10-24）：建卡那一刻，服务端以 PM 的名义往建卡会话落一条
   * `role:'assistant'` + meta 的票 —— 不派活、不占一轮 run，只是登记"卡在这场对话立的"。
   * ③ 那张卡（待办+执行人）建完就自动派活，票照落；这里验票的三个要件。
   */
  const ticket = (pmAfter.messages ?? []).find((m) => m.meta?.type === 'card' && m.meta?.cardId === workId);
  check('建卡会话里有那张卡的卡票消息', !!ticket, ticket?.text?.slice(0, 60) ?? '没找到');
  check('卡票是 PM 名义、不占 run', ticket?.role === 'assistant' && ticket?.personaId === pm.id, `${ticket?.role}/${ticket?.personaId}`);
  check('卡票 meta 带标题与状态快照', ticket?.meta?.title === '修列表样式' && !!ticket?.meta?.status, JSON.stringify(ticket?.meta ?? null));

  console.log('\n④ 非项目经理岗位带钥匙来建 → 403（干活的岗位不许越权立项）');
  const devTry = await talk(devConv, `【建卡】{"title":"嘉辉想自己立项","status":"待办","projectId":"${project.id}"} 试着立这张卡`);
  check('被拒（403 E2057）', /FAKE-CARD:403:E2057/.test(devTry.reply), devTry.reply.match(/FAKE-CARD:\S+/)?.[0] ?? devTry.reply.slice(-80));
  check('拒绝话里说清了找谁', devTry.reply.includes('只有项目经理岗位能建任务卡'), devTry.reply.match(/FAKE-CARD:\S+/)?.[0] ?? '');
  // 403 是服务端在 createProjectTask 之前就返回的 —— 卡根本没建，无需再查库
} catch (err) {
  console.log('\n跑挂了：' + String(err?.message ?? err) + '\n' + slog.slice(-800));
  failed += 1;
} finally {
  try { server.kill(); } catch { /* 已退 */ }
  await sleep(600);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
}

console.log(failed ? `\n✗ ${failed} 项没过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
