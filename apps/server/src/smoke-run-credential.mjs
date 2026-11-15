/**
 * **运行钥匙**（数字员工的"工作证"）的验收 —— 强制鉴权模式下的建卡通道 + 只读台账。
 *
 * 背景（2026-11-08 全员群实报）：项目经理贺韬与助理喜儿双双被 401 卡住 —— 服务端默认
 * 监听 `0.0.0.0`（`auth.required = true`），认证层原先把 `X-Bandi-Run-Token` 当"没带
 * 凭据"，请求根本到不了建卡接口与台账。既有 `smoke-agent-cards` 一直在
 * `BANDI_HOST=127.0.0.1`（免鉴权回环）下跑，从没覆盖过真机形态。
 *
 * 钉三件事：
 *   ① **纯策略**：run 身份只放行清单里 `run: true` 的几扇门（建卡 + 只读台账），
 *      其余一律 E4034；operator / 登录用户的放行面不变（抽两条防回归）。
 *   ② **强制鉴权模式端到端**：真起服务（`BANDI_HOST=0.0.0.0`）+ 真跑一轮假 agent
 *      （fixtures/fake-agent.js 的 CREATE_CARD / PROBE 两个开关）——
 *      运行钥匙能建卡（201）、能读 /api/projects /api/state /api/tasks /api/runtimes（200）、
 *      打 /api/users /api/personas 被拒（403 E4034）。
 *   ③ **假钥匙** → 401 E2056，提示写明"每次 run 现发、收尾即作废"——不跟"没带凭据"
 *      混成同一个笼统 401（实报里两个人就是被它带到"重置 token"死路上的）。
 *
 * 隔离：临时数据目录 + 临时端口 + 临时项目目录，跑完全删。
 * 跑法：node apps/server/src/smoke-run-credential.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { authorize } from './security/policy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const FAKE = path.join(here, 'fixtures', 'fake-agent.js');
const PORT = Number(process.env.SMOKE_PORT ?? 8819);
const BASE = `http://127.0.0.1:${PORT}`;
const OP_TOKEN = 'smoke-operator-token-run-cred';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-run-cred-'));
const projRoot = path.join(tmp, 'proj');
fs.mkdirSync(projRoot, { recursive: true });

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------- ① 纯策略（不启服务） */
console.log('① 纯策略：run 身份 = 清单里 run:true 那几扇门，别的一律 E4034');
{
  const run = { kind: 'run', runId: 'r-x', personaId: 'p-x' };
  const allow = [
    ['POST', '/api/agent/cards'],
    ['POST', '/api/agent/cards/batch'],
    ['PATCH', '/api/projects/tasks/pt-x'],
    ['GET', '/api/projects'],
    ['GET', '/api/state'],
    ['GET', '/api/tasks'],
    ['GET', '/api/runtimes'],
    ['GET', '/api/personas/p-x/tasks'],
  ];
  for (const [m, p] of allow) {
    const d = authorize({ who: run, method: m, pathname: p });
    check(`放行 ${m} ${p}`, d === 'allow', d);
  }
  const deny = [
    ['GET', '/api/users'],
    ['POST', '/api/personas'],
    ['PUT', '/api/personas/p-x'],
    ['GET', '/api/security/audit'],
    ['GET', '/api/conversations'],
  ];
  for (const [m, p] of deny) {
    const d = authorize({ who: run, method: m, pathname: p });
    check(`拒绝 ${m} ${p}`, d === 'E4034', d);
  }
  // 防回归：这次只加 run 一档，operator / 登录用户的面不许被收窄
  check('operator 照旧全权', authorize({ who: { kind: 'operator' }, method: 'GET', pathname: '/api/users' }) === 'allow');
  check('登录用户照旧全权', authorize({ who: { kind: 'user', userId: 'u-x' }, method: 'DELETE', pathname: '/api/users/u-y' }) === 'allow');
}

/* --------------------------------------------------- ② 强制鉴权模式端到端 */
const server = spawn(process.execPath, [path.join(here, 'server.mjs')], {
  cwd: repoRoot,
  env: {
    ...process.env,
    BANDI_DATA: tmp,
    BANDI_DB: path.join(tmp, 'bandi.db'),
    BANDI_PORT: String(PORT),
    BANDI_HOST: '0.0.0.0', // 真机默认形态：强制鉴权
    BANDI_TOKEN: OP_TOKEN, // 显式操作员令牌（不用去读 token 文件）
    BANDI_FAKE_ECHO: 'full',
    BANDI_FAKE_CREATE_CARD: '1', // 任务带【建卡】标记就真调建卡接口
    BANDI_FAKE_PROBE: '1', // 用运行钥匙探几扇门，把状态回进回复
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let slog = '';
server.stdout.on('data', (c) => (slog += c));
server.stderr.on('data', (c) => (slog += c));

const opHeaders = () => ({ 'Content-Type': 'application/json', 'X-Bandi': '1', 'X-Bandi-Token': OP_TOKEN });
async function req(method, p, body, headers = opHeaders()) {
  const r = await fetch(BASE + p, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function waitUp(ms = 30000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(BASE + '/api/hello', { signal: AbortSignal.timeout(800) });
      if (r.ok) return true;
    } catch { /* 还没起 */ }
    await sleep(200);
  }
  return false;
}

try {
  if (!(await waitUp())) throw new Error('控制面没起来（强制鉴权形态）：' + slog.slice(-600));

  console.log('\n② 强制鉴权形态：没凭据 / 假钥匙 / 操作员令牌');
  const noTok = await fetch(BASE + '/api/state');
  const noTokBody = await noTok.json().catch(() => ({}));
  check('没凭据 → 401 E4010', noTok.status === 401 && noTokBody.code === 'E4010', `${noTok.status} ${noTokBody.code}`);

  const badRun = await fetch(BASE + '/api/state', { headers: { 'X-Bandi': '1', 'X-Bandi-Run-Token': 'rt-fake' } });
  const badBody = await badRun.json().catch(() => ({}));
  check('假运行钥匙 → 401 E2056（不是笼统 E4010）', badRun.status === 401 && badBody.code === 'E2056',
    `${badRun.status} ${badBody.code}`);
  check('提示写明"每轮现发、现取重试、别抄旧值"',
    /现发/.test(String(badBody.error ?? '')) && /BANDI_RUN_TOKEN/.test(String(badBody.hint ?? '')) &&
      /现取/.test(String(badBody.hint ?? '')) && /历史命令/.test(String(badBody.hint ?? '')),
    `${badBody.error} / ${badBody.hint}`);

  const opState = await req('GET', '/api/state');
  check('操作员令牌照常能读状态', opState.status === 200, String(opState.status));

  /* 建数据：假运行时 + 项目 + PM + 会话 */
  const addRt = await req('POST', '/api/devices/local/runtimes', { family: 'codex', label: '假 CLI', path: FAKE });
  check('接上假运行时', addRt.status === 201 && !!addRt.body.runtime?.id, String(addRt.status));
  const rtId = addRt.body.runtime?.id;
  const project = (await req('POST', '/api/projects', { name: '钥匙验收项目', root: projRoot })).body.project;
  const pm = (await req('POST', '/api/personas', {
    name: '贺韬', runtime: rtId, sandbox: 'danger-full-access', cwd: projRoot,
    role: '项目经理 · 拆活盯落实', instructions: '你是贺韬。',
  })).body.persona;
  const convId = (await req('POST', '/api/conversations', { personaId: pm?.id })).body.conversation?.id;
  check('建出项目 / PM / 会话', !!project?.id && !!pm?.id && !!convId, `${project?.id} / ${pm?.id} / ${convId}`);

  console.log('\n③ 真跑一轮假 agent：运行钥匙建卡 + 探台账');
  /** 发一句、等这一轮跑完，返回这一轮的回话文本 */
  const talk = async (text) => {
    const r = await req('POST', `/api/conversations/${encodeURIComponent(convId)}/messages`, { text });
    check('  （发消息 → 202）', r.status === 202, String(r.status));
    const until = Date.now() + 30000;
    let d = null;
    for (;;) {
      d = (await req('GET', `/api/conversations/${encodeURIComponent(convId)}`)).body;
      const runs = d?.runs ?? [];
      if (runs.length && runs.every((x) => x.status !== 'running')) break;
      if (Date.now() >= until) break;
      await sleep(150);
    }
    return (d?.messages ?? []).filter((m) => m.role === 'assistant').map((m) => m.text).join('\n');
  };

  const reply = await talk(`【建卡】{"title":"验收建卡","description":"验证运行钥匙","status":"idea","projectId":"${project.id}"} 立卡`);
  check('假 agent 的回复拿得到', !!reply, reply.slice(-140));
  check('PM 的每轮提醒带上批量建卡口径', /\/api\/agent\/cards\/batch/.test(reply) && /idempotencyKey/.test(reply), '');
  check('运行钥匙建卡 → 201', /FAKE-CARD:201:pt-/.test(reply), (reply.match(/FAKE-CARD:\S+/) ?? [])[0] ?? reply.slice(-120));

  const probe = (reply.match(/FAKE-PROBE:(\{[^}]*\})/) ?? [])[1];
  check('探针结果带回来了', !!probe, String(probe));
  const got = probe ? JSON.parse(probe) : {};
  for (const k of ['projects', 'state', 'tasks', 'runtimes']) {
    check(`只读台账 ${k} → 200`, got[k] === 200, String(got[k]));
  }
  for (const k of ['users', 'skills']) {
    check(`面板管理口 ${k} → 403`, got[k] === 403, String(got[k]));
  }
  const board = (await req('GET', `/api/projects/${encodeURIComponent(project.id)}/tasks`)).body;
  check('建出来的卡真在看板上', JSON.stringify(board).includes('验收建卡'), String(board?.columns?.length ?? '?'));

  /*
   * 第二轮：同一个员工的会话是**续接**的（真机上员工会把上一轮命令里抄的旧钥匙带回来，
   * 2026-11-08 实报的病根）。所以"钥匙每轮现发、现取别抄"的提醒必须**每轮都在任务末尾** ——
   * 这里钉住它：续接轮的回复里能看到这句提醒。
   */
  console.log('\n④ 续接轮：每轮都要收到"钥匙现取、别抄旧值"的提醒');
  const reply2 = await talk('再确认一下通道。');
  check('续接轮的回复拿得到', !!reply2, reply2.slice(-140));
  check('续接轮再次建卡/探针都正常（钥匙是本轮的新值）',
    /FAKE-PROBE:/.test(reply2) && /FAKE-PROBE:\{"projects":200/.test(reply2), reply2.slice(-160));
  check('任务末尾有「运行钥匙」每轮提醒', /平台接口 · 运行钥匙/.test(reply2), '');
  check('提醒里写明"现取、别抄旧值"', /BANDI_RUN_TOKEN/.test(reply2) && /不要?把值抄进命令|不要?抄历史|别.{0,6}抄/.test(reply2), '');
} catch (err) {
  console.log('\n跑挂了：' + String(err?.message ?? err));
  if (slog) console.log('—— 服务端日志尾部 ——\n' + slog.slice(-1200));
  failed += 1;
} finally {
  server.kill();
  await sleep(400);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
}

console.log(`\n结论：${failed ? `${failed} 项没过` : '全通过'}`);
process.exit(failed ? 1 : 0);
