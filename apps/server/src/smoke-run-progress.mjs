/**
 * **运行进度**的验收（2026-10-26，用户实问："他在执行，我不知道他进行到了哪一步"）。
 *
 * 验的是纯逻辑归约器 `apps/web/js/run-progress.mjs`：把 dsh / codex / claude 三种事件序列
 * 翻译成界面要的那几件事 ——
 *   · 现在什么阶段（准备 / 思考 / 调工具 / 写回话 / 收尾）
 *   · 第几步、最近一次动作是什么（工具名 + 命令/路径，人话）
 *   · 每步的成功/失败/耗时；多久没动静算"可能卡住了"
 * 归约器不碰 DOM，所以这条用例不用浏览器。界面接线（chat.mjs 用了它）另做静态断言。
 *
 * 跑法：node apps/server/src/smoke-run-progress.mjs
 */
import fs from 'node:fs';

import {
  applyRunEvent,
  createRunProgress,
  fmtAgo,
  fmtElapsed,
  fmtStepDur,
  progressView,
  STALL_MS,
  toolSummary,
} from '../../web/js/run-progress.mjs';

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

const T0 = 1_000_000;
/** 造一个"每次事件往后跳 dt 毫秒"的喂事件器 */
function feeder(startedAt = T0) {
  const st = createRunProgress({ startedAt, now: startedAt });
  let t = startedAt;
  return {
    st,
    feed(evt, dt = 1000) {
      t += dt;
      applyRunEvent(st, evt, t);
      return progressView(st, t);
    },
    view(at = t) {
      return progressView(st, at);
    },
    get now() {
      return t;
    },
  };
}

/* --------------------------------------------------- ① dsh：带 step / tool_call / tool_result */
console.log('① dsh 事件序列：turn/step + tool_call → tool_result');
{
  const f = feeder();
  let v = f.feed({ type: 'status', phase: 'turn_start', turn: 1 });
  check('turn_start → 思考中', v.phaseText === '思考中', v.phaseText);

  v = f.feed({ type: 'thinking', text: '先看一眼仓库' });
  check('thinking 不产生步骤', v.stepCount === 0, String(v.stepCount));

  v = f.feed({ type: 'tool_call', callId: 'c1', tool: 'shell', input: { command: 'npm test' } });
  check('tool_call → 第 1 步', v.stepCount === 1, String(v.stepCount));
  check('工具动词是「运行命令」', v.steps[0].verb === '运行命令', v.steps[0].verb);
  check('目标取命令内容', v.steps[0].target === 'npm test', v.steps[0].target);
  check('当前步「进行中」', v.currentStep?.status === 'running', v.currentStep?.status);
  check('最近动作 = 运行命令 npm test', v.lastAction === '运行命令 npm test', v.lastAction);

  v = f.feed({ type: 'tool_result', callId: 'c1', status: 'completed', result: 'ok' }, 2000);
  check('tool_result → 这一步完成', v.steps[0].status === 'done', v.steps[0].status);
  check('这一步耗时 = 2s', v.steps[0].durMs === 2000, String(v.steps[0].durMs));
  check('完成后不再有"进行中"的步骤', v.currentStep === null, String(v.currentStep));

  v = f.feed({ type: 'text', text: '改好了' });
  check('text → 写回话', v.phaseText === '写回话', v.phaseText);

  v = f.feed({ type: 'status', phase: 'turn_end' });
  check('turn_end → 收尾中', v.phaseText === '收尾中', v.phaseText);

  v = f.feed({ type: '__done', status: '完成' });
  check('__done → 已完成', v.done === true && v.status === '完成', `${v.done}/${v.status}`);
  // 1000+1000+1000+2000+1000+1000+1000 = 8s（每一步喂事件都往后跳了时间）
  check('总用时按开始时间算', v.elapsedMs === 8000, String(v.elapsedMs));
}

/* --------------------------------------------------- ② claude：只有 tool（没有结果事件） */
console.log('\n② claude 事件序列：只有 tool，没有 tool_result');
{
  const f = feeder();
  let v = f.feed({ type: 'tool', name: 'Bash', input: { command: 'git add -A' } });
  check('tool → 第 1 步，进行中', v.stepCount === 1 && v.steps[0].status === 'running', v.steps[0].status);
  check('Bash → 运行命令 git add -A', v.steps[0].verb === '运行命令' && v.steps[0].target === 'git add -A', v.lastAction);

  v = f.feed({ type: 'tool', name: 'Read', input: { file_path: 'apps/web/js/chat.mjs' } });
  check('第二步：读文件', v.stepCount === 2 && v.steps[1].verb === '读文件', v.steps[1].verb);
  check('上一步没有结果 → 收成「已发起」，不硬猜成败', v.steps[0].status === 'called', v.steps[0].status);
  check('最新一步才是进行中', v.currentStep?.n === 2, String(v.currentStep?.n));

  v = f.feed({ type: 'text', text: '好了' });
  check('回话一到，最后一步也收成「已发起」', v.steps[1].status === 'called', v.steps[1].status);
}

/* --------------------------------------------------- ③ codex：item.detail 里才有命令/文件 */
console.log('\n③ codex：工具名是 item 类型，目标在 detail 里');
{
  const s1 = toolSummary('command_execution', null, { command: 'npm run check' });
  check('command_execution → 运行命令 + 命令内容', s1.verb === '运行命令' && s1.target === 'npm run check', `${s1.verb} ${s1.target}`);
  const s2 = toolSummary('file_change', { changes: [{ path: 'apps/web/app.mjs' }] });
  check('file_change → 改文件 + 文件路径', s2.verb === '改文件' && s2.target.includes('apps/web/app.mjs'), `${s2.verb} ${s2.target}`);
  const s3 = toolSummary('mcp_tool_call', { server: 'github', tool: 'search' });
  check('mcp 调用 → 调用工具（不硬编动词）', s3.verb === '调用工具', s3.verb);
}

/* --------------------------------------------------- ④ 卡住判定 */
console.log('\n④ 卡住判定：5 分钟没有新事件');
{
  const st = createRunProgress({ startedAt: 0, now: 0 });
  check('刚跑 4 分钟：不算卡住', progressView(st, STALL_MS - 60_000).stalled === false);
  check('满 5 分钟没动静：卡住', progressView(st, STALL_MS).stalled === true);
  check('卡住文案里的"多久以前"可读', fmtAgo(STALL_MS) === '5 分钟前', fmtAgo(STALL_MS));

  // 2026-10-26 实报：卡在 Write 上 20 分钟，卡片同时写"可能卡住了"和"进行中 1237s"。
  // 现在卡住时把最后一步降级成「等结果」，不再假装工具还在跑。
  const st2 = createRunProgress({ startedAt: 0, now: 0 });
  applyRunEvent(st2, { type: 'tool', name: 'Write', input: { file_path: 'C:/Temp/pr-body.md' } }, 0);
  const v2 = progressView(st2, STALL_MS);
  check('卡住时最后一步降级成「等结果」', v2.steps[0]?.status === 'waiting', v2.steps[0]?.status);
  check('卡住时不再有"进行中"步骤', v2.currentStep === null, String(v2.currentStep));
  check('卡住时仍说得出最后动作', /改文件/.test(v2.lastAction), v2.lastAction);
  check('"已等多久"还在（供卡片显示）', v2.steps[0]?.durMs === STALL_MS, String(v2.steps[0]?.durMs));

  applyRunEvent(st, { type: '__done', status: '完成' }, STALL_MS + 1);
  check('跑完以后不再报卡住', progressView(st, STALL_MS * 10).stalled === false);
}

/* --------------------------------------------------- ⑤ 格式与容错 */
console.log('\n⑤ 格式化 / 容错');
{
  check('用时 1 分 5 秒 → 01:05', fmtElapsed(65_000) === '01:05', fmtElapsed(65_000));
  check('用时 1 小时 2 分 → 1:02:05', fmtElapsed(3_725_000) === '1:02:05', fmtElapsed(3_725_000));
  check('单步 200ms 也显示 1s（不写 0s）', fmtStepDur(200) === '1s', fmtStepDur(200));

  const f = feeder();
  f.feed({ type: 'session', sessionId: 'x' });
  f.feed({ type: 'final', text: 'ok' });
  f.feed({ type: 'raw', event: {} });
  check('认不出的事件不造步骤、不乱跳阶段', f.view().stepCount === 0, String(f.view().stepCount));

  const v = f.feed({ type: 'error', message: 'Not logged in · Please run /login' });
  check('error → 阶段「出错了」并记下原因', v.phaseText === '出错了' && /Not logged in/.test(v.error), v.error);
  const v2 = f.feed({ type: '__done', status: '失败' });
  check('__done 失败 → 状态「失败」', v2.done && v2.status === '失败', v2.status);
}

/* --------------------------------------------------- ⑥ 界面接线（静态） */
console.log('\n⑥ 聊天页接线（静态断言，防"归约器写了没人用"）');
{
  const chatSrc = fs.readFileSync(new URL('../../web/js/chat.mjs', import.meta.url), 'utf8');
  // 2026-10-29：画卡片这一层从 chat.mjs 拆成共用组件 run-progress-card.mjs（任务卡讨论区用同一套）。
  // 「停止生成 / 等结果」的落点跟着搬进组件 —— 断言改成两头都钉：组件里有这颗钮/这档状态，
  // chat.mjs 确实把组件接上了并传了 onStop，少一头都算红。
  const cardSrc = fs.readFileSync(new URL('../../web/js/run-progress-card.mjs', import.meta.url), 'utf8');
  check('chat.mjs 引用了 run-progress.mjs', /from '\.\/run-progress\.mjs'/.test(chatSrc));
  check('streamRun 把每个原始事件交给 onEvent', /h\.onEvent\?\.\(evt\)/.test(chatSrc));
  check('attachStream 接收 startAt 并按真实开始时间计时', /attachStream\(runId, whoName = '', startedAt = null\)/.test(chatSrc));
  check('重进会话时把 run.startedAt 带过去', /attachStream\(last\.id, last\.personaName, last\.startedAt\)/.test(chatSrc));
  check('不再用三个点占位', !/class="typing"><i><\/i><i><\/i><i><\/i>/.test(chatSrc));
  check('卡住行里直接给「停止生成」按钮', /class="rp-stop">停止生成/.test(cardSrc) && /createProgressCard\(\{[\s\S]*?onStop/.test(chatSrc));
  check('卡住的步骤有「等结果」状态（不再假装进行中）', /waiting/.test(cardSrc) && /已等/.test(cardSrc));
  /*
   * 2026-10-30 用户："这个我想改成 dsh 回复时候那种模式" —— 工具明细默认折叠成一行，
   * 点开才铺命令。断言钉两头：折叠行存在、明细则默认 hidden（否则等于没折叠）。
   */
  check('工具明细默认折叠成一行', /class="rp-fold"/.test(cardSrc) && /<div class="rp-steps" hidden>/.test(cardSrc));
  check('折叠行点得开（点了只是展开/收起，不碰运行）', /\.rp-fold'\)\.addEventListener\('click'/.test(cardSrc) || /querySelector\('\.rp-fold'\)\.addEventListener/.test(cardSrc));
}

console.log(`\n结论：${failed ? `${failed} 项没过` : '全通过'}`);
process.exit(failed ? 1 : 0);
