/**
 * 「节点领活」的验收（2026-10-15）—— 多台电脑一起干活的那一步。
 *
 * 链路是真的：**真起一个控制面 + 真起一个节点 + 一个确定的假 CLI**。
 * 假 CLI 只吐 codex 事件词汇的那几行 JSON，所以这条用例不烧 token、结果也不飘。
 *
 * 验五件事：
 *   ① 节点的运行时**可被派活**（员工能绑到 `node-xxx:codex` 上）；
 *   ② 活被节点**领走 → 在那台机器上跑完 → 消息与事件回到控制面**（界面看到的就是这套）；
 *   ③ **离线排队**：节点不在线时活就躺在队列里，它一回来自己领走 —— 这就是"离线排队"的全部实现；
 *   ④ 还没被领走就点停止 → **直接撤掉**，不让它上线后再跑一遍；
 *   ⑤ 正在跑、而且**一声不吭**时点停止 → 靠空批次心跳把"停"送到，节点掐掉子进程。
 *
 * 隔离：临时数据目录（控制面 / 节点各一个）+ 临时端口。
 * 跑法：node apps/server/src/smoke-node-jobs.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { repoRoot } from './config.mjs';
import { stopRunning, sleep } from './lifecycle.mjs';

const PORT = Number(process.env.SMOKE_PORT ?? 8870);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-jobs-'));
const CP_DATA = path.join(tmp, 'cp-data');
const NODE_DATA = path.join(tmp, 'node-data');
const SERVER = path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs');
const NODE = path.join(repoRoot, 'apps', 'server', 'src', 'node.mjs');
const FAKE = path.join(repoRoot, 'apps', 'server', 'src', 'fixtures', 'fake-agent.js');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

/* 节点那台机器上"装了什么"：写它自己的 runtimes.json，指向假 CLI */
fs.mkdirSync(NODE_DATA, { recursive: true });
fs.writeFileSync(
  path.join(NODE_DATA, 'runtimes.json'),
  JSON.stringify(
    { devices: { local: { runtimes: { fake: { family: 'codex', label: '假 CLI', enabled: true, path: FAKE } } } } },
    null,
    2,
  ),
  'utf8',
);

const kids = [];
function spawnBg(file, env, args = []) {
  const c = spawn(process.execPath, [file, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  kids.push(c);
  const st = { child: c, out: '' };
  c.stdout.on('data', (d) => (st.out += d));
  c.stderr.on('data', (d) => (st.out += d));
  return st;
}
const startCp = () => spawnBg(SERVER, { BANDI_PORT: String(PORT), BANDI_DATA: CP_DATA, BANDI_DB: path.join(CP_DATA, 'bandi.db'), BANDI_HOST: '127.0.0.1' });
const startNode = (extra = {}) =>
  spawnBg(NODE, {
    BANDI_CONTROL_PLANE: BASE,
    BANDI_DATA: NODE_DATA,
    BANDI_NODE_STATE: path.join(NODE_DATA, 'node.json'),
    ...extra,
  });

async function stopKid(st) {
  if (!st?.child || st.child.exitCode !== null) return;
  const done = new Promise((r) => st.child.once('exit', r));
  st.child.kill();
  await Promise.race([done, sleep(3000)]);
}

const api = async (p, opts) => {
  const r = await fetch(BASE + p, opts);
  return { status: r.status, body: await r.json().catch(() => null) };
};
const post = (p, body) =>
  api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

const waitFor = async (fn, ms = 45000, every = 300) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // 服务还没起来时 fetch 会直接抛（连接被拒）—— 那是"再等等"，不是失败
    try {
      if (await fn()) return true;
    } catch { /* 接着等 */ }
    await sleep(every);
  }
  return false;
};

const conversationOf = async (id) => (await api(`/api/conversations/${encodeURIComponent(id)}`)).body;

/** 发一句话，返回 runId */
async function sayHello(convId, text) {
  const r = await post(`/api/conversations/${encodeURIComponent(convId)}/messages`, { text });
  return { status: r.status, runId: r.body?.runId ?? null };
}

/** 等这次运行收尾（会话不再是"跑中"） */
async function waitSettled(convId, ms = 60000) {
  let detail = null;
  const ok = await waitFor(async () => {
    detail = await conversationOf(convId);
    return detail?.conversation?.status !== '跑中';
  }, ms);
  return { ok, detail };
}

const streamOf = async (runId) => {
  const r = await fetch(`${BASE}/api/runs/${encodeURIComponent(runId)}/stream`, { signal: AbortSignal.timeout(8000) });
  const body = await r.text();
  return {
    status: r.status,
    ids: [...body.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1])),
    events: [...body.matchAll(/^data: (.*)$/gm)].map((m) => { try { return JSON.parse(m[1]); } catch { return null; } }),
  };
};

let cp = null;
let nd = null;
try {
  console.log('① 起控制面 + 起节点：节点的运行时**可被派活**');
  cp = startCp();
  if (!(await waitFor(async () => (await api('/api/state')).status === 200, 20000))) {
    throw new Error('控制面没起来：' + cp.out.slice(-400));
  }
  nd = startNode();
  if (!(await waitFor(async () => ((await api('/api/devices')).body?.devices ?? []).some((d) => d.kind === 'node'), 25000))) {
    throw new Error('节点没报到：' + nd.out.slice(-500));
  }
  const devs = (await api('/api/devices')).body.devices;
  const nodeDev = devs.find((d) => d.kind === 'node');
  check('设备列表里出现了节点', !!nodeDev, nodeDev?.label);
  const detail = (await api(`/api/devices/${encodeURIComponent(nodeDev.id)}`)).body.device;
  const remoteRt = (detail.runtimes ?? []).find((r) => r.family === 'codex');
  check('它自报的 codex 运行时在列表里', !!remoteRt, (detail.runtimes ?? []).map((r) => r.id).join(','));
  check('而且标着 remote（控制面不会在本机 spawn 它）', remoteRt?.remote === true);
  const listed = (await api('/api/runtimes')).body.runtimes;
  check('它进了「员工运行时」下拉（员工绑上去就能派到那台机器）', listed.some((r) => r.id === remoteRt.id));

  console.log('\n② 派活 → 节点领走 → 在那台机器上跑完 → 消息与事件回到控制面');
  const persona = await post('/api/personas', {
    name: '远端干活的人',
    instructions: '',
    runtime: remoteRt.id,
    sandbox: 'danger-full-access',
    cwd: repoRoot,
  });
  check('员工建好了（绑的是远端运行时）', persona.status === 201, JSON.stringify(persona.body?.error ?? ''));
  check('员工的 runtime 就是那个远端 id', persona.body?.persona?.runtime === remoteRt.id, String(persona.body?.persona?.runtime));
  const conv = await post('/api/conversations', { personaId: persona.body.persona.id, title: '领活验收' });
  const convId = conv.body?.conversation?.id;

  const sent = await sayHello(convId, '远端跑一次');
  check('派活返回 202 + runId', sent.status === 202 && !!sent.runId, String(sent.runId));
  const settled = await waitSettled(convId);
  check('这次运行收尾了', settled.ok, settled.detail?.conversation?.status);
  const assistant = [...(settled.detail?.messages ?? [])].reverse().find((m) => m.role === 'assistant');
  check('回话回来了，而且是**那台机器上**的假 CLI 产出的', /FAKE-OK/.test(assistant?.text ?? ''), JSON.stringify((assistant?.text ?? '').slice(0, 60)));
  const run = (settled.detail?.runs ?? [])[0];
  check('运行记成「完成」', run?.status === '完成', `${run?.status} / exit=${run?.exitCode}`);
  const st = await streamOf(sent.runId);
  const types = st.events.map((e) => e?.type);
  check('事件流带回"排进队列"那一步', types.includes('status') && st.events.some((e) => e?.phase === 'queued'));
  check('思考 / 工具 / 文本三种事件都回来了', ['thinking', 'tool', 'text'].every((t) => types.includes(t)), [...new Set(types)].join(','));
  check('最后是终止事件，且序号连续', st.events.at(-1)?.type === '__done' && st.ids.join(',') === st.ids.map((_, i) => i + 1).join(','), `ids=${st.ids.join(',')}`);

  console.log('\n③ 离线排队：节点不在线，活就在队列里等着；它一回来自己领走');
  await stopKid(nd);
  nd = null;
  await sleep(600);
  const sent2 = await sayHello(convId, '趁它不在派一个');
  await sleep(1200);
  const queuedDev = ((await api('/api/devices')).body.devices ?? []).find((d) => d.kind === 'node');
  check('活排进了队列（pendingJobs=1）', queuedDev?.pendingJobs === 1, String(queuedDev?.pendingJobs));
  const midState = await conversationOf(convId);
  check('这次运行还在"跑中"（等那台机器）', midState?.conversation?.status === '跑中', midState?.conversation?.status);
  check('接口层的运行号有了（回执还没回来）', !!(await api(`/api/conversations/${encodeURIComponent(convId)}`)).body, '');

  nd = startNode();
  const picked = await waitSettled(convId, 60000);
  check('节点一回来就领走了，并跑完', picked.ok, picked.detail?.conversation?.status);
  check('这一次也回来了内容', /FAKE-OK/.test([...(picked.detail?.messages ?? [])].reverse().find((m) => m.role === 'assistant')?.text ?? ''));
  const drained = ((await api('/api/devices')).body.devices ?? []).find((d) => d.kind === 'node');
  check('队列清空了', drained?.pendingJobs === 0, String(drained?.pendingJobs));

  console.log('\n④ 还没被领走就点停止 → 直接撤掉（不让它上线后再跑一遍）');
  await stopKid(nd);
  nd = null;
  await sleep(600);
  const sent3 = await sayHello(convId, '趁它不在派、然后立刻停');
  await sleep(800);
  const ab = await post(`/api/runs/${encodeURIComponent(sent3.runId)}/abort`);
  check('停止请求被接受', ab.status === 200, JSON.stringify(ab.body ?? {}));
  await sleep(600);
  const q3 = ((await api('/api/devices')).body.devices ?? []).find((d) => d.kind === 'node');
  check('队列里的那个活被撤掉了', q3?.pendingJobs === 0, String(q3?.pendingJobs));
  const s3 = await conversationOf(convId);
  check('这次运行记成「已停止」', s3?.conversation?.status === '已停止', s3?.conversation?.status);

  console.log('\n⑤ 正在跑、而且一声不吭时点停止 → 靠空批次心跳把"停"送到');
  // 假 CLI 先睡 8 秒、期间一个字都不吐 —— 这是停止指令最容易送不到的情形
  nd = startNode({ BANDI_FAKE_SLEEP_MS: '8000' });
  await waitFor(async () => ((await api('/api/devices')).body?.devices ?? []).some((d) => d.kind === 'node'), 25000);
  const sent4 = await sayHello(convId, '跑一个慢的然后掐掉');
  const claimed = await waitFor(async () => (await api('/api/nodes')).body?.nodes?.length >= 0 && ((await api('/api/devices')).body.devices.find((d) => d.kind === 'node')?.pendingJobs === 0), 20000);
  check('活被领走了（队列空了）', claimed);
  await post(`/api/runs/${encodeURIComponent(sent4.runId)}/abort`);
  const killed = await waitSettled(convId, 30000);
  check('一声不吭也能被掐掉，运行收尾', killed.ok, killed.detail?.conversation?.status);
  check('记成「已停止」而不是「失败」', killed.detail?.conversation?.status === '已停止', killed.detail?.conversation?.status);
  check('节点日志里能看到"控制面说停"', /控制面说停/.test(nd.out), (nd.out.match(/.*控制面说停.*/) ?? ['(没看到)'])[0]);
} catch (err) {
  console.log('\n跑挂了：' + String(err?.message ?? err));
  failed += 1;
} finally {
  for (const c of kids) { try { c.kill(); } catch { /* 已退 */ } }
  await sleep(500);
  try { stopRunning(PORT); } catch { /* 没在跑 */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
}

console.log(failed ? `\n✗ ${failed} 项没过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
