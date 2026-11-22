/*
 * smoke-progress-ledger.mjs —— 「这段活干到哪了」的事实账（2026-11-22，缺口①后半）。
 *
 * 钉死五件事（这几条错了，交接就会教新会话做错事）：
 *   ① 只有**改动**类事件算文件改动 —— Read/Glob 带 path 不算（否则"看了一眼"被说成"改过"）；
 *   ② 报错说人话：`退出码 4294967295` / 运行时日志行 不能原样甩给下一轮；
 *   ③ 没历史、没卡 → **空串**（不印空壳）；
 *   ④ 有卡 + 跑过 → 卡状态 / 轮次计数 / 改过的文件（相对路径）/ 失败原因 / 上次落款都在；
 *   ⑤ 上限真的管用（块长 ≤ PROGRESS.maxChars），且明细只列最近 3 轮。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-progress-'));
process.env.BANDI_DATA = tmp;
process.env.BANDI_DB = path.join(tmp, 'bandi.db');

const store = await import('./store.mjs');
const { closeDb } = await import('./store/db.mjs');
const { progressBlock, factsOfRun, readableError, cleanCommand, PROGRESS } = await import('./progress-ledger.mjs');

let failed = 0;
function check(name, ok, extra = '') {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.log(`  ✗ ${name}${extra ? ` —— ${extra}` : ''}`);
  }
}

console.log('① 事实抽取：只认改动、不认"看过"');
{
  const facts = factsOfRun([
    { type: 'tool', name: 'command_execution', detail: { command: 'npm test' } },
    { type: 'tool', name: 'Read', detail: { path: 'E:/repo/apps/a.mjs' } },
    { type: 'tool', name: 'file_change', detail: { changes: [{ path: 'E:/repo/apps/b.mjs', kind: 'update' }] } },
    { type: 'tool', name: 'file_change', detail: { changes: [{ path: 'E:/repo/apps/c.mjs', kind: 'add' }] } },
    { type: 'error', message: '退出码 4294967295' },
    { type: 'thinking', text: '我打算改 d.mjs' },
  ]);
  check('命令进了 commands', facts.commands.includes('npm test'), JSON.stringify(facts.commands));
  check('Read 的 path 不算改动', !facts.files.some((f) => f.includes('a.mjs')), JSON.stringify(facts.files));
  check('file_change 的两个文件都算', facts.files.length === 2, JSON.stringify(facts.files));
  check('thinking 里提到改文件不算', !facts.files.some((f) => f.includes('d.mjs')));
  check('工具动作计数', facts.tools === 4, String(facts.tools));
}

console.log('\n② 报错说人话');
{
  check('退出码 → 人话', readableError('退出码 4294967295') === '进程异常退出（退出码 4294967295）', readableError('退出码 4294967295'));
  const log = readableError('2026-11-20T12:47:59.725638Z ERROR codex_core::tools::router: error=unknown MCP server');
  check('运行时日志去掉时间与级别', log.startsWith('codex_core::tools::router'), log);
  check('空 → 空串', readableError('') === '');
  // 真实样例（2026-11-22 从库里抄的）：命令被包在 powershell 里，交接时必须剥掉外壳
  const wrapped =
    '"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command \'node tools/run-smokes.mjs\'';
  check('剥掉 powershell 外壳', cleanCommand(wrapped) === 'node tools/run-smokes.mjs', cleanCommand(wrapped));
  check('普通命令原样', cleanCommand('npm test') === 'npm test', cleanCommand('npm test'));
}

console.log('\n③ 没历史没卡 → 空串');
{
  const lone = store.createPersona({ name: '空会话员工', role: '研发工程师', roleKey: 'dev' });
  const conv = store.createConversation({ kind: 'direct', title: '空会话', personaId: lone.id });
  check('新会话返回空串', progressBlock({ conversationId: conv.id }) === '', JSON.stringify(progressBlock({ conversationId: conv.id })));
  check('没会话 id 返回空串', progressBlock({ conversationId: '' }) === '');
}

// —— 造一段真实的活：一张卡，5 轮失败 + 2 轮完成 ——
const proj = store.createProject({ name: 'bandi', root: 'E:/repo' });
const me = store.createPersona({ name: '贺韬', role: '研发工程师', roleKey: 'dev' });
const other = store.createPersona({ name: '张坤', role: '研发工程师', roleKey: 'dev' });
const conv = store.createConversation({ kind: 'direct', title: '修 PR #83', personaId: me.id });
const card = store.createProjectTask({
  projectId: proj.id,
  title: '修 PR #83 的自动检查',
  description: 'CI 红了',
  status: 'review',
  assigneePersonaId: me.id,
  conversationId: conv.id,
});
store.updateProjectTask(card.id, { prState: 'merged', prNumber: 83 });

function makeRun({ persona = me, status, error = null, events = [], minutes = 10, ago = 0 }) {
  const run = store.createRun({ conversationId: conv.id, runtime: 'codex', personaId: persona.id });
  let seq = 0;
  for (const e of events) store.appendRunEvent(run.id, ++seq, e);
  store.finishRun(run.id, { status, exitCode: status === 'done' ? 0 : 1, error });
  // 时间往前挪，模拟"这些是过去的轮次"
  return run;
}

for (let i = 0; i < 5; i += 1) {
  makeRun({ status: 'failed', error: i === 4 ? '服务重启，这次运行被中断' : '退出码 4294967295' });
}
makeRun({
  status: 'done',
  events: [
    { type: 'tool', name: 'command_execution', detail: { command: 'node tools/run-smokes.mjs' } },
    { type: 'tool', name: 'file_change', detail: { changes: [{ path: 'E:/repo/apps/server/src/server.mjs', kind: 'update' }] } },
    { type: 'tool', name: 'file_change', detail: { changes: [{ path: 'E:/repo/apps/server/src/runs.mjs', kind: 'update' }] } },
  ],
});
makeRun({
  status: 'done',
  events: [
    { type: 'tool', name: 'command_execution', detail: { command: 'git push -u origin fix/ci' } },
    { type: 'tool', name: 'file_change', detail: { changes: [{ path: 'E:/repo/apps/server/src/server.mjs', kind: 'update' }] } },
  ],
});
store.addMessage({ conversationId: conv.id, role: 'assistant', personaId: me.id, text: 'CI 已经绿了，PR #83 也合了。\n[完成]' });

console.log('\n④ 有卡 + 跑过 → 该有的都在');
{
  const block = progressBlock({ conversationId: conv.id, personaId: me.id, root: 'E:/repo' });
  check('带卡号与标题', block.includes(card.id) && block.includes('修 PR #83 的自动检查'), block.slice(0, 120));
  check('带卡状态', block.includes('待验收'), '');
  check('带证据结论（PR 已合并）', block.includes('PR 已合并'), '');
  check('轮次计数：7 轮、完成 2、失败 5', block.includes('跑了 7 轮') && block.includes('完成 2') && block.includes('失败 5'), '');
  check('失败原因说人话（3 轮明细里那条）', block.includes('服务重启'), block);
  check('反复失败的原因按次数汇总', block.includes('没成的原因') && block.includes('进程异常退出（退出码 4294967295） ×4'), block);
  check('改过的文件是相对路径', block.includes('apps/server/src/server.mjs') && !block.includes('E:/repo/apps'), '');
  check('同一文件只出现一次', block.split('apps/server/src/server.mjs').length === 2, '');
  check('上次落款 [完成]', block.includes('[完成]'), '');
  check('标明"声明 ≠ 已核对"', block.includes('以本轮核对为准'), '');
  check(`块长 ≤ ${PROGRESS.maxChars}`, block.length <= PROGRESS.maxChars, `${block.length}`);
  check('明细最多列 3 轮', block.split('\n').filter((l) => /^ {2}- /.test(l)).length <= PROGRESS.maxRuns, '');
}

console.log('\n⑤ 换人接手：这一位没跑过 → 退回整个会话，并标出是谁干的');
{
  const block = progressBlock({ conversationId: conv.id, personaId: other.id, root: 'E:/repo' });
  check('仍然给出这段活', block.includes('跑了 7 轮'), block.slice(0, 100));
  check('标出是别人干的', block.includes('贺韬'), '');
  check('落款为空不硬编', !block.includes('上一次回话的落款'), '');
}

console.log('\n⑥ 只有卡、没有运行记录 → 只给卡状态（不编轮次）');
{
  const proj2 = store.createProject({ name: 'bandi-2', root: 'E:/repo2' });
  const conv2 = store.createConversation({ kind: 'direct', title: '新卡', personaId: me.id });
  const card2 = store.createProjectTask({ projectId: proj2.id, title: '写个周报', status: 'todo', conversationId: conv2.id });
  const block = progressBlock({ conversationId: conv2.id, personaId: me.id });
  check('有卡行', block.includes(card2.id) && block.includes('待办'), block);
  check('没有轮次行', !block.includes('跑了'), '');
}

console.log('\n⑥b 按卡归集：卡换会话派活，旧会话的轮次看得见（R4-1）');
{
  const projB = store.createProject({ name: 'bandi-b', root: 'E:/repob' });
  const cardB = store.createProjectTask({ projectId: projB.id, title: '跨会话的活', status: 'doing', conversationId: null });
  // 工单会话（execScope = task:<卡id>）里跑过几轮 —— 看板派活 / 卡评论 / 流程步骤落的就是这类会话
  const execConv = store.ensureExecConversation({ personaId: me.id, scope: `task:${cardB.id}`, title: '任务 · 跨会话的活' });
  const run = store.createRun({ conversationId: execConv.id, runtime: 'codex', personaId: me.id });
  let seqB = 0;
  store.appendRunEvent(run.id, ++seqB, { type: 'tool', name: 'file_change', detail: { changes: [{ path: 'E:/repob/apps/x.mjs', kind: 'update' }] } });
  store.finishRun(run.id, { status: 'done', exitCode: 0 });
  // 卡换会话派活：conversationId 更新成新会话（两条派活路径都这么写），旧会话从此不在卡上
  const convNew = store.createConversation({ kind: 'direct', title: '卡的新会话', personaId: me.id });
  store.updateProjectTask(cardB.id, { conversationId: convNew.id });

  const block = progressBlock({ conversationId: convNew.id, personaId: me.id, root: 'E:/repob' });
  check('新会话能看见卡', block.includes(cardB.id) && block.includes('跨会话的活'), block.slice(0, 120));
  check('旧会话（工单会话）的轮次按卡归集进来', block.includes('跑了 1 轮'), block);
  check('标注跨了 2 段会话', block.includes('跨 2 段会话'), '');
  check('旧会话里改过的文件也在', block.includes('apps/x.mjs'), block);
}

console.log('\n⑦ 超长真的截得住（截在行边界、块头不丢）');
{
  const proj3 = store.createProject({ name: 'bandi-3', root: 'E:/repo3' });
  const conv3 = store.createConversation({ kind: 'direct', title: '长活', personaId: me.id });
  store.createProjectTask({ projectId: proj3.id, title: '一个很长的活', status: 'doing', conversationId: conv3.id });
  for (let i = 0; i < 3; i += 1) {
    const run = store.createRun({ conversationId: conv3.id, runtime: 'codex', personaId: me.id });
    const events = [];
    for (let f = 0; f < 12; f += 1) {
      events.push({
        type: 'tool',
        name: 'file_change',
        detail: { changes: [{ path: `E:/repo3/apps/very/deeply/nested/directory/number${f}/file-${f}.mjs`, kind: 'update' }] },
      });
    }
    events.push({ type: 'tool', name: 'command_execution', detail: { command: `node tools/run-smokes.mjs --only=very-long-suite-name-${i}` } });
    let seq = 0;
    for (const e of events) store.appendRunEvent(run.id, ++seq, e);
    store.finishRun(run.id, { status: 'failed', exitCode: 1, error: `${'很长的报错原因'.repeat(12)} ${i}` });
  }
  const block = progressBlock({ conversationId: conv3.id, personaId: me.id, root: 'E:/repo3' });
  check(`块长 ≤ ${PROGRESS.maxChars}`, block.length <= PROGRESS.maxChars, `${block.length}`);
  check('块头还在', block.startsWith('【这段活干到哪了】'), block.slice(0, 30));
  check('不出现半句被切断的痕迹（末尾是行）', block.endsWith('）') || block.endsWith('…'), JSON.stringify(block.slice(-30)));
}

console.log('\n⑧ 接线：只在"会话是空的"时候注入，别每轮都塞');
{
  const src = fs.readFileSync(new URL('./dispatch.mjs', import.meta.url), 'utf8');
  check('dispatch 用了 progressBlock', src.includes('progressBlock({'));
  check('注入条件是 rotated || firstTime', /if \(rotated \|\| firstTime\)/.test(src), '');
  check('轮换时事实账交给 sessionHandoffBlock', /sessionHandoffBlock\(thread, rotated, progress\)/.test(src), '');
  check('交接里的消息改成只取尾部（不再全量读会话）', src.includes('store.tailMessages('), '');
  const messages = fs.readFileSync(new URL('./store/messages.mjs', import.meta.url), 'utf8');
  check('tailMessages 有 LIMIT（真在库里截）', /ORDER BY m\.rowid DESC LIMIT \?/.test(messages), '');
}

try {
  closeDb();
} catch {
  /* 关不掉也走清理 */
}
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* Windows 上句柄可能还没放（EBUSY）→ 留在临时目录，不因此判失败 */
}
console.log(`\n${failed ? `结论：${failed} 条没过` : '结论：全部通过'}`);
process.exit(failed ? 1 : 0);
