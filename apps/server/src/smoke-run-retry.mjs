/**
 * **失败分型 + 自动续跑**的验收（2026-11-21）。
 *
 * 钉住四件事：
 *   ① 环境性失败里**该续的那两类**（上游 5xx、进程无理由地死）→ 判"续"；
 *      通道断反而**不续**（内层已重连，且"修代理回继续"才是可执行的下一步）；
 *   ② 确定性失败（配置 / 登录 / 权限档 / 上下文满 / 4xx / 限流）→ 判"不续"，
 *      而且**理由要能贴到卡上**（`why` 不许为空、不许是技术黑话）；
 *   ③ 交付声明已下（[完成]/[受阻]）的失败不续 —— 那不是"半路死"，是"说完了才死"；
 *   ④ 判据顺序固定：`429` 必须落在限流、不能被"只有退出码"那条抢走；
 *   ⑤ **接线是真的**：接一次真的 startRun，用假适配器演"第一次挂、第二次成"——
 *      断言的不是分类函数，是"它真的又 spawn 了一次、且只收一次尾"。
 *
 * 用例文案全部来自真库样本（`%APPDATA%/bandi/bandi.db`，2026-11-21 查的那 13 条）——
 * 凭想象编的错误串，验不出真实分布。
 *
 * 跑法：node apps/server/src/smoke-run-retry.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * 临时数据目录必须在 import 任何业务模块**之前**设好：config 在模块加载时读环境变量。
 * 续跑间隔压到 10ms —— 判据与接线都验得到，但不必为"人性化的 1.5 秒"在冒烟里等。
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-run-retry-'));
process.env.BANDI_DATA = tmp;
process.env.BANDI_DB = path.join(tmp, 'bandi.db');
process.env.BANDI_RUN_AUTO_RETRY_DELAY_MS = '10';

const { classifyFailure, retryBrief, MAX_AUTO_RETRY, AUTO_RETRY_DELAY_MS } = await import('./run-retry.mjs');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

console.log('① 常量有边界（不能是 0 次、也不能无限重试）');
check('续跑次数默认在 0~5 之间', MAX_AUTO_RETRY >= 0 && MAX_AUTO_RETRY <= 5, String(MAX_AUTO_RETRY));
check('默认是开着的（> 0）', MAX_AUTO_RETRY > 0, String(MAX_AUTO_RETRY));
check('续跑间隔在 0~30s 之间', AUTO_RETRY_DELAY_MS >= 0 && AUTO_RETRY_DELAY_MS <= 30000, String(AUTO_RETRY_DELAY_MS));

console.log('\n② 环境性失败 → 续');
/*
 * 通道断**不**续：CLI 内部已经重连过（Reconnecting 1/5…5/5），外层再跑一遍是重复劳动，
 * 而且那条"去修代理、回来回「继续」"的回话才是人能照做的下一步（smoke-run-channel 钉着它）。
 */
const ch = classifyFailure({ error: 'Reconnecting… 2/5 (ECONNRESET)', channelDown: true, exitCode: 1 });
check('连不上模型 → 不续（有内层重连 + 明确的下一步）', !ch.retry && ch.kind === 'channel', ch.kind);
const up = classifyFailure({ error: 'API Error: 503 Service Unavailable', exitCode: 1 });
check('上游 503 → 续', up.retry && up.kind === 'upstream', up.kind);
const up2 = classifyFailure({ error: '接口报错 502：bad gateway' });
check('接口报错 502 → 续', up2.retry && up2.kind === 'upstream', up2.kind);
const dead = classifyFailure({ error: '退出码 4294967295', exitCode: 4294967295 });
check('真库样本「退出码 4294967295」→ 续（进程被杀，没有原因）', dead.retry && dead.kind === 'process-died', dead.kind);
const dead2 = classifyFailure({ error: '', exitCode: 1 });
check('空原因 + 非零退出码 → 续', dead2.retry && dead2.kind === 'process-died', dead2.kind);
const dead3 = classifyFailure({ error: 'exit code -1', exitCode: -1 });
check('英文兜底文案「exit code -1」→ 续', dead3.retry && dead3.kind === 'process-died', dead3.kind);

console.log('\n③ 确定性失败 → 不续，且理由说得出口');
const cfg = classifyFailure({ error: "ERROR codex_core::tools::router: error=unknown MCP server 'filesystem'" });
check('真库样本「unknown MCP server」→ 不续', !cfg.retry && cfg.kind === 'config', cfg.kind);
const auth = classifyFailure({ error: 'Not logged in · Please run /login' });
check('未登录 → 不续', !auth.retry && auth.kind === 'auth', auth.kind);
const req = classifyFailure({ error: '接口报错 400：API Error: 400 WorkBuddy AI: Backend [maas] is not supported' });
check('真库样本「接口报错 400」→ 不续', !req.retry && req.kind === 'request', req.kind);
const ctx = classifyFailure({ error: 'prompt is too long: 1200000 tokens' });
check('上下文超了 → 不续（同一条会话只会更满）', !ctx.retry && ctx.kind === 'context', ctx.kind);
const lim = classifyFailure({ error: '429 rate limit exceeded', exitCode: 429 });
check('限流 429 → 不续（有冷却机制）', !lim.retry && lim.kind === 'rate-limit', lim.kind);
const perm = classifyFailure({ error: '运行出错', sandboxBlocked: true });
check('权限档挡命令 → 不续', !perm.retry && perm.kind === 'permission', perm.kind);
const boot = classifyFailure({ error: '起不来：spawn ENOENT' });
check('进程根本没起来 → 不续', !boot.retry && boot.kind === 'not-started', boot.kind);
const opaque = classifyFailure({ error: 'something odd happened in step 3' });
check('有具体报错的未知失败 → 不续（不许藏着错误重试）', !opaque.retry && opaque.kind === 'opaque', opaque.kind);
check(
  '每条"不续"都给了人话理由（非空、不是英文机器码）',
  [cfg, auth, req, ctx, lim, perm, boot, opaque].every((v) => v.why && /[\u4e00-\u9fa5]/.test(v.why)),
);

console.log('\n④ 交付声明已下的失败不续');
check('[完成] → 不续（说完了才死）', !classifyFailure({ error: '退出码 1', claim: 'done' }).retry);
check('[受阻] → 不续', !classifyFailure({ error: '退出码 1', claim: 'blocked' }).retry);
check('没声明（unclaimed）仍按错误本身判 → 环境性可续', classifyFailure({ error: '退出码 1', claim: 'unclaimed' }).retry);

console.log('\n⑤ 优先级：429 归限流，别被"只有退出码"抢走');
check('"429" 同时像数字也像限流 → 判限流', classifyFailure({ error: '429', exitCode: 429 }).kind === 'rate-limit');
/*
 * 这条是写用例时才想清楚的（第一版断言写反了，跑红）：`退出码 429` 这种**兜底文案**
 * 里的数字不是随便一个数 —— 进程以 429 退出，几乎就是被上游限流。归到限流（不续）
 * 比归到"进程被杀"（续）正确：续跑会在冷却窗口里再撞一次墙。
 * 而 `4294967295`（Windows 的 -1）不会误伤 —— `429\b` 后面紧跟数字，没有词边界。
 */
check('「退出码 429」→ 判限流（进程以 429 退出就是被限流）', classifyFailure({ error: '退出码 429', exitCode: 429 }).kind === 'rate-limit');
check('「退出码 4294967295」不被 429 规则误伤', classifyFailure({ error: '退出码 4294967295', exitCode: 4294967295 }).kind === 'process-died');
check('「退出码 1」是纯数字兜底 → 判进程死', classifyFailure({ error: '退出码 1', exitCode: 1 }).kind === 'process-died');
check('权限档优先于"只有退出码"', classifyFailure({ error: '退出码 1', sandboxBlocked: true }).kind === 'permission');

console.log('\n⑥ 续跑提示：要求"先复核上一轮诊断"，不是"接着干"');
const brief = retryBrief({ attempt: 2, max: 3, why: '进程异常退出（没给出原因）' });
check('带第几次 / 共几次', brief.includes('第 2 次') && brief.includes('共 3 次'), brief.split('\n')[0]);
check('带上一轮失败原因', brief.includes('进程异常退出'), '');
check('第一条指令是复核，不是继续', /先复核你上一轮的判断/.test(brief), '');
check('提醒"结论会过期"', /过期/.test(brief), '');
check('要求从做完的地方接着做、别重复命令', /不要重复执行同一条命令/.test(brief), '');
check('不含未替换的占位符', !/\$\{/.test(brief), '');

console.log('\n⑦ 接线：真 startRun 跑一遍（假适配器，不起 CLI、不烧模型）');
const store = await import('./store.mjs');
const runsMod = await import('./runs.mjs');
const runtimes = await import('./runtimes.mjs');
const { ADAPTERS } = await import('./adapters.mjs');

const rt = runtimes.addRuntime('local', { family: 'codex', label: '假运行时（冒烟）', path: process.execPath }).runtime;
const persona = store.createPersona({ name: '冒烟员工', runtime: rt.id, sandbox: 'danger-full-access' });

/** 造一个假适配器：第 n 次调用返回第 n 个结果，并记下每次收到的任务原文 */
function fakeAdapter(results) {
  const calls = [];
  const fn = (opts) =>
    new Promise((resolve) => {
      calls.push(opts.task);
      const r = results[Math.min(calls.length - 1, results.length - 1)];
      opts.onEvent?.({ type: 'session', sessionId: 'sess-smoke' });
      setTimeout(() => resolve({ sessionId: 'sess-smoke', ...r }), 5);
    });
  fn.calls = calls;
  return fn;
}

const waitDone = async (run, ms = 8000) => {
  const until = Date.now() + ms;
  while (Date.now() < until && !run.finished) await new Promise((r) => setTimeout(r, 20));
  return run;
};
const usageOf = (runId) => {
  try {
    return JSON.parse(store.getRunRow(runId)?.usage ?? 'null') ?? {};
  } catch {
    return {};
  }
};
const dispatch = (task) => {
  const conv = store.createConversation({ title: '续跑冒烟', personaId: persona.id });
  return runsMod.startRun({
    thread: conv,
    member: { personaId: persona.id, runtime: rt.id, sandbox: 'danger-full-access' },
    task,
  });
};

/*
 * A. 第一次"进程无理由地死"（真库最常见的 `退出码 4294967295`），第二次做成了。
 *    这一条是整个改动的目的：用户不该看到一张红卡，他该看到活被接着做完了。
 */
{
  ADAPTERS.codex = fakeAdapter([
    { text: '先看过工作区了', isError: true, exitCode: 4294967295, error: '退出码 4294967295' },
    { text: '[完成] 做完了', isError: false, exitCode: 0 },
  ]);
  const run = await waitDone(dispatch('把这件活做完'));
  check('失败了会自己再跑一次（没有等人工点重跑）', run.status === 'done', `${run.status} / calls=${ADAPTERS.codex.calls.length}`);
  check('真的起了两次进程', ADAPTERS.codex.calls.length === 2, String(ADAPTERS.codex.calls.length));
  check('第二次的任务里带着「先复核上一轮诊断」', /先复核你上一轮的判断/.test(ADAPTERS.codex.calls[1] ?? ''), '');
  check('第一次不带（只在续跑时注入）', !/先复核你上一轮的判断/.test(ADAPTERS.codex.calls[0] ?? ''), '');
  check('回话里交代了"中途断过"', /中途断了 1 次/.test(run.finalText ?? ''), String(run.finalText ?? '').slice(0, 40));
  check('usage 记下续跑次数（排障要看得到）', usageOf(run.id).autoRetries === 1, JSON.stringify(usageOf(run.id)));
  check('成功收尾时不留失败原因', !run.error, String(run.error ?? ''));
}

/*
 * B. 配置错 → 一次都不续。再跑一遍只是把同一句报错再说一次，白烧 token。
 */
{
  ADAPTERS.codex = fakeAdapter([
    { text: '', isError: true, exitCode: 1, error: "unknown MCP server 'filesystem'" },
  ]);
  const run = await waitDone(dispatch('再试一次配置'));
  check('配置错不续跑', ADAPTERS.codex.calls.length === 1, String(ADAPTERS.codex.calls.length));
  check('卡在失败态', run.status === 'failed', String(run.status));
  check('失败原因里说明了"为什么没再试"', /未自动续跑/.test(run.error ?? ''), String(run.error ?? '').slice(0, 60));
}

/*
 * C. 一直"进程被杀" → 续到上限就停，不能无限重试。
 *    上限本身可配（BANDI_RUN_AUTO_RETRY），这里按当前值算期望次数。
 */
{
  ADAPTERS.codex = fakeAdapter([{ text: '', isError: true, exitCode: 4294967295, error: '退出码 4294967295' }]);
  const run = await waitDone(dispatch('永远挂的活'));
  check('一直失败时按上限停下（不无限重试）', ADAPTERS.codex.calls.length === 1 + MAX_AUTO_RETRY, `${ADAPTERS.codex.calls.length} / 上限 ${MAX_AUTO_RETRY}`);
  check('失败原因写清试过几次', new RegExp(`已自动续跑 ${MAX_AUTO_RETRY} 次`).test(run.error ?? ''), String(run.error ?? '').slice(0, 80));
  check('状态仍是失败（不假装成功）', run.status === 'failed', String(run.status));
}

/*
 * D. 已经把结论说完了（[受阻]）才挂的 → 不续。
 *    这不是"半路死"，是"说完了才死"；续跑会推翻它自己刚下的判断，界面上还会说两遍。
 */
{
  ADAPTERS.codex = fakeAdapter([
    { text: '[受阻] 需要你确认要不要动生产库', isError: true, exitCode: 1, error: '退出码 1' },
  ]);
  const run = await waitDone(dispatch('需要拍板的活'));
  check('已声明 [受阻] 的失败不续跑', ADAPTERS.codex.calls.length === 1, String(ADAPTERS.codex.calls.length));
  check('[受阻] 照旧落成回话（人看得见卡在哪）', /需要你确认/.test(run.finalText ?? ''), '');
}

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch { /* Windows 上库句柄可能还没放，删不掉就留给系统清 */ }

console.log(failed ? `\n✗ ${failed} 条没过` : '\n✓ 全过');
process.exit(failed ? 1 : 0);
