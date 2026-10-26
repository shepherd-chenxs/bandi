/**
 * 端到端验收：装上连接器 → 建一个数字员工 → 发一句**不提 tool_search** 的话。
 *
 * 这条链路的每一段都是真的：
 *   连接器账本 → 首轮注入的"外部能力"那段 → 运行时的 -c 参数 → codex 真去 tool_search → 调到 MCP 工具
 * 所以它验的是"装上了到底能不能用"，不是"参数拼得对不对"。
 *
 * 隔离：临时账本、临时数据库、临时端口，跑完全删 —— 不碰 data/ 里的真东西。
 * 跑法：node apps/server/src/smoke-plugin-e2e.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { repoRoot } from './config.mjs';

const PORT = Number(process.env.SMOKE_PORT ?? 8792);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-e2e-'));
// 本进程也读同一本临时账（connectors 每次调用都重新看 env），别去读 data/ 里的真账
process.env.BANDI_CONNECTORS = path.join(tmp, 'connectors.json');
process.env.BANDI_CONNECTORS_DIR = path.join(tmp, 'generated');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};
const api = async (p, opts) => {
  const res = await fetch(BASE + p, opts);
  return { status: res.status, body: await res.json().catch(() => null) };
};
const post = (p, body) =>
  api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

const child = spawn(process.execPath, [path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs')], {
  cwd: repoRoot,
  env: {
    ...process.env,
    BANDI_PORT: String(PORT),
    BANDI_DATA: tmp,
    BANDI_DB: path.join(tmp, 'bandi.db'),
    BANDI_CONNECTORS: path.join(tmp, 'connectors.json'),
    BANDI_CONNECTORS_DIR: path.join(tmp, 'generated'),
  },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (c) => (serverLog += c));
child.stderr.on('data', (c) => (serverLog += c));

try {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(BASE + '/api/connectors')).ok) break;
    } catch {
      /* 还没起 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log('① 装一个连接器（本机回声）');
  const inst = await post('/api/connectors', { from: 'echo-local' });
  check('装上了', inst.status === 201, JSON.stringify(inst.body?.error ?? ''));

  console.log('\n② 首轮注入里带上了"外部能力"那段');
  const wiring = await import('./connectors.mjs');
  check('列出了刚装的那条', wiring.promptLines('codex').some((l) => l.includes('echo-local')));
  check('codex 的提示词里有 tool_search 的引导', wiring.promptLines('codex').some((l) => l.includes('tool_search')));
  await api('/api/connectors/echo-local', { method: 'DELETE' });
  /* 2026-10-26 起口径变了：SSH 连接器随「设置 → 远程连接」**内置**（ensureBuiltinConnectors
     启动即 seed，卸不掉）—— 卸完用户连接器后，注入里恒有内置那一条，不会再是空段。 */
  check('没有用户连接器时，注入里只剩内置远程连接（不塞第三方噪音）',
    wiring.promptLines('codex').some((l) => l.startsWith('- ssh：'))
    && !wiring.promptLines('codex').some((l) => l.includes('echo-local')));
  await post('/api/connectors', { from: 'echo-local' }); // 装回来，接着跑 ③④

  console.log('\n③ 建员工 + 开一段对话');
  const persona = await post('/api/personas', {
    name: '验收员',
    instructions: '',
    runtime: 'codex',
    sandbox: 'danger-full-access',
  });
  check('员工建好了', persona.status === 201 && !!persona.body?.persona?.id);
  const conv = await post('/api/conversations', { personaId: persona.body.persona.id, title: '连接器验收' });
  check('对话建好了', conv.status === 201 && !!conv.body?.conversation?.id);

  console.log('\n④ 发一句不提 tool_search 的话，看它自己会不会找工具');
  const text = '请调用 echo 工具，text 参数传：班底，然后只回复该工具返回的内容。';
  const sent = await post(`/api/conversations/${conv.body.conversation.id}/messages`, { text });
  check('运行起来了', sent.status === 202 && !!sent.body?.runId);

  const id = conv.body.conversation.id;
  let detail = null;
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    detail = (await api(`/api/conversations/${encodeURIComponent(id)}`)).body;
    if (detail?.conversation?.status !== '跑中') break;
  }
  const run = detail?.runs?.[0] ?? null;
  const answer = [...(detail?.messages ?? [])].reverse().find((m) => m.role === 'assistant')?.text ?? '';
  console.log('  状态 :', detail?.conversation?.status, ' 退出码:', run?.exitCode);
  console.log('  回答 :', JSON.stringify(answer.slice(0, 200)));
  if (run?.error) console.log('  错误 :', JSON.stringify(String(run.error).slice(0, 300)));

  check('这次运行成功了', run?.status === '完成', String(run?.error ?? '').slice(0, 160));
  check('数字员工自己找到了工具并回了正确内容', /echo:\s*班底/.test(answer), JSON.stringify(answer.slice(0, 120)));
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
if (failed) console.log('服务端日志：\n' + serverLog.slice(0, 1200));
process.exit(failed ? 1 : 0);
