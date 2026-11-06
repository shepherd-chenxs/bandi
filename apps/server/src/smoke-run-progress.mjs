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
  clipEnds,
  createRunProgress,
  fmtAgo,
  fmtElapsed,
  fmtStepDur,
  humanizeCommand,
  progressView,
  STALL_MS,
  summarizeEvents,
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
  // 2026-11-05：过程快照的服务端半边（runs.mjs 收尾时把摘要落进回话消息的 meta.progress）
  const runsSrc = fs.readFileSync(new URL('./runs.mjs', import.meta.url), 'utf8');
  check('chat.mjs 引用了 run-progress.mjs', /from '\.\/run-progress\.mjs'/.test(chatSrc));
  check('streamRun 把每个原始事件交给 onEvent', /h\.onEvent\?\.\(evt\)/.test(chatSrc));
  check('attachStream 接收 startAt 并按真实开始时间计时', /attachStream\(runId, whoName = '', startedAt = null\)/.test(chatSrc));
  check('重进会话时把 run.startedAt 带过去', /attachStream\(last\.id, last\.personaName, last\.startedAt\)/.test(chatSrc));
  check('不再用三个点占位', !/class="typing"><i><\/i><i><\/i><i><\/i>/.test(chatSrc));
  // 2026-11-05 评鉴：停止钮从"卡住才出现"改成**常驻卡头**（收尾才隐掉），打断是第一类操作
  check('停止钮常驻卡头（收尾才隐掉）', /class="rp-stop" title="停止生成" hidden/.test(cardSrc) && /createProgressCard\(\{[\s\S]*?onStop/.test(chatSrc));
  check('卡住的步骤有「等结果」状态（不再假装进行中）', /waiting/.test(cardSrc) && /已等/.test(cardSrc));
  check('进度卡拿意图当标题', /showIntent/.test(cardSrc));
  check('开场白在第一件工具到来时收进标题', /preface\.splice\(0\)/.test(chatSrc));
  check('跑过工具的回话气泡带过程收起行', /progressNoteHtml\(meta\)/.test(chatSrc) && /data-rp-note/.test(chatSrc));
  check('服务端收尾把过程快照落进 meta.progress', /function progressMeta\(/.test(runsSrc) && /replyMeta\(run, \{ stopped, status \}\)/.test(runsSrc));
  // 2026-11-05 二期：阶段分组要两头都接上 —— 实时卡按段画、历史收起行认快照里的 phases
  check('实时进度卡按阶段画步骤', /rp-ph/.test(cardSrc) && /v\.phases/.test(cardSrc));
  check('历史收起行认快照里的 phases（老快照平铺兜底）', /p\.phases/.test(chatSrc));
  // 2026-11-05 实测（用户截图）：display:flex 的作者样式压过 UA 的 [hidden]{display:none}，
  // 收起行明细永远摊开、实时卡收尾收不起来 —— 全局 reset 是这条链路能收起的前提
  const styleSrc = fs.readFileSync(new URL('../../web/style.css', import.meta.url), 'utf8');
  check('全局 [hidden] reset 在（display 类压不过它）', /\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(styleSrc));
}

/* --------------------------------------------------- ⑦ 意图（2026-11-05 评鉴） */
console.log('\n⑦ 意图：第一件工具之前的正文 = "他要干嘛"');
{
  const f = feeder();
  f.feed({ type: 'text', text: '我先看仓库结构，' });
  f.feed({ type: 'text', text: '再数代码量。' });
  check('开场白（分块来）攒成意图', f.view().intent === '我先看仓库结构，再数代码量。', f.view().intent);

  f.feed({ type: 'tool', name: 'Bash', input: { command: 'git ls-files' } });
  check('工具开跑后意图定格', f.view().intent === '我先看仓库结构，再数代码量。', f.view().intent);

  f.feed({ type: 'text', text: '答案是 1.2 万行' });
  check('工具之后的正文不进意图', f.view().intent === '我先看仓库结构，再数代码量。', f.view().intent);

  const f2 = feeder();
  f2.feed({ type: 'text', text: '纯聊天，一次工具都没调' });
  check('纯聊天也攒得出意图（用不用由界面定）', f2.view().intent === '纯聊天，一次工具都没调', f2.view().intent);
}

/* --------------------------------------------------- ⑧ 命令人话化（2026-11-05 评鉴） */
console.log('\n⑧ 命令人话化：剥解释器全路径 / 双层转义归一 / 保头保尾');
{
  // 截图里那条真实的噪声命令：解释器全路径占了 80 字截断的大半，唯一有信息量的参数被切掉
  const noisy = '"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command "Get-ChildItem -Recurse | Measure-Object"';
  check('全路径 + 双层转义 + 引号三层皮都剥掉',
    humanizeCommand(noisy) === 'Get-ChildItem -Recurse | Measure-Object', humanizeCommand(noisy));
  check('裸 powershell.exe 也剥', humanizeCommand('powershell.exe -Command Get-Date') === 'Get-Date', humanizeCommand('powershell.exe -Command Get-Date'));
  check('cmd /c 的参数词也剥', humanizeCommand('C:\\Windows\\System32\\cmd.exe /c echo hi') === 'echo hi', humanizeCommand('C:\\Windows\\System32\\cmd.exe /c echo hi'));
  check('sh -c 剥参数词', humanizeCommand('/usr/bin/sh -c "git ls-files | head"') === 'git ls-files | head', humanizeCommand('/usr/bin/sh -c "git ls-files | head"'));
  check('普通命令原样保留', humanizeCommand('npm test') === 'npm test', humanizeCommand('npm test'));
  check('不把 -compile 之类误当 -c', humanizeCommand('app -compile x') === 'app -compile x', humanizeCommand('app -compile x'));

  const long = clipEnds('x'.repeat(100) + ' | wc -l', 80);
  check('长命令保头保尾：头在', long.startsWith('x'.repeat(48)) && long.includes('…'), long);
  check('长命令保头保尾：尾也在（管道是信息量）', long.endsWith(' | wc -l'), long);
}

/* --------------------------------------------------- ⑨ 收尾快照（2026-11-05 评鉴） */
console.log('\n⑨ 收尾快照：summarizeEvents → 回话消息的 meta.progress');
{
  const rows = [
    { evt: { type: 'text', text: '我先看仓库结构' }, at: '2026-11-05T00:00:00.000Z' },
    { evt: { type: 'tool_call', callId: 'c1', tool: 'shell', input: { command: 'git ls-files' } }, at: '2026-11-05T00:00:02.000Z' },
    { evt: { type: 'tool_result', callId: 'c1', status: 'completed' }, at: '2026-11-05T00:00:04.000Z' },
    { evt: { type: 'tool', name: 'Bash', input: { command: 'powershell.exe -Command "wc -l"' } }, at: '2026-11-05T00:00:05.000Z' },
  ];
  const snap = summarizeEvents(rows, { status: '完成', elapsedMs: 19100 });
  check('纯聊天返回 null（不落收起行）',
    summarizeEvents([{ evt: { type: 'text', text: 'hi' }, at: '2026-11-05T00:00:00.000Z' }]) === null, '');
  check('快照带状态/意图/用时',
    snap.status === '完成' && snap.intent === '我先看仓库结构' && snap.elapsedMs === 19100,
    JSON.stringify({ status: snap.status, intent: snap.intent, elapsedMs: snap.elapsedMs }));
  check('第一步带真实耗时（靠事件落库时刻）', snap.steps[0].ms === 2000 && snap.steps[0].s === 'done', JSON.stringify(snap.steps[0]));
  check('没等到结果的一步收成「已发起」，不硬猜成败', snap.steps[1].s === 'called' && snap.steps[1].ms === null, JSON.stringify(snap.steps[1]));
  check('快照里的命令也是人话', snap.steps[1].t === 'wc -l', snap.steps[1].t);
}

/* --------------------------------------------------- ⑩ 阶段分组（2026-11-05 二期） */
console.log('\n⑩ 阶段分组：工具之间的正文 = 下一批工具的段标题');
{
  const f = feeder();
  f.feed({ type: 'text', text: '我先看看技能安装手册，再去 GitHub 上找。' });
  f.feed({ type: 'tool', name: 'Read', input: { file_path: 'SKILL.md' } });
  f.feed({ type: 'tool', name: 'Bash', input: { command: 'python list-skills.py' } });
  f.feed({ type: 'text', text: '官方库里没有，去社区搜。' });
  f.feed({ type: 'tool', name: 'WebSearch', input: { query: 'concise reply skill' } });
  f.feed({ type: 'text', text: '找到三个候选，逐个核对 README。' });
  f.feed({ type: 'tool', name: 'WebFetch', input: { url: 'https://raw.githubusercontent.com/x/SKILL.md' } });
  f.feed({ type: 'text', text: '结论是这三个都能用，答案在下面。' });
  const v = f.view();
  check('三批工具被正文分成三段', Array.isArray(v.phases) && v.phases.length === 3,
    JSON.stringify(v.phases?.map((g) => [g.title, g.i, g.n])));
  check('第一段标题 = 意图（开场白）', v.phases[0].title.includes('技能安装手册'), v.phases[0].title);
  check('第二段标题来自工具之间的正文', v.phases[1].title === '官方库里没有，去社区搜。', v.phases[1].title);
  check('段与段的步数对得上（2/1/1）', v.phases.map((g) => g.n).join(',') === '2,1,1',
    v.phases.map((g) => g.n).join(','));
  check('收尾正文不当段标题（气泡里已经有了）', v.phases.every((g) => !g.title.includes('结论是')),
    v.phases.map((g) => g.title).join(' | '));

  // 全程没说话 → 不分组，界面走平铺（别硬编故事）
  const f2 = feeder();
  f2.feed({ type: 'tool', name: 'Bash', input: { command: 'npm test' } });
  f2.feed({ type: 'tool', name: 'Bash', input: { command: 'npm run lint' } });
  check('没有中途正文就不分组', f2.view().phases === null, String(f2.view().phases));

  // 同一批工具前的多段/分块正文并成一条段标题
  const f3 = feeder();
  f3.feed({ type: 'tool', name: 'Bash', input: { command: 'git status' } });
  f3.feed({ type: 'text', text: '工作区是脏的，' });
  f3.feed({ type: 'text', text: '先提交再继续。' });
  f3.feed({ type: 'tool', name: 'Bash', input: { command: 'git commit' } });
  check('同一批前的分块正文并成一条段标题',
    f3.view().phases?.length === 2 && f3.view().phases[1].title === '工作区是脏的，先提交再继续。',
    f3.view().phases?.[1]?.title);

  // 收尾快照也带 phases（服务端 progressMeta → meta.progress → 历史收起行按段画）
  const rows = [
    { evt: { type: 'text', text: '我先看仓库结构' }, at: '2026-11-05T00:00:00.000Z' },
    { evt: { type: 'tool_call', callId: 'c1', tool: 'shell', input: { command: 'git ls-files' } }, at: '2026-11-05T00:00:02.000Z' },
    { evt: { type: 'tool_result', callId: 'c1', status: 'completed' }, at: '2026-11-05T00:00:04.000Z' },
    { evt: { type: 'text', text: '结构清楚了，数一下行数。' }, at: '2026-11-05T00:00:05.000Z' },
    { evt: { type: 'tool', name: 'Bash', input: { command: 'powershell.exe -Command "wc -l"' } }, at: '2026-11-05T00:00:06.000Z' },
  ];
  const snap = summarizeEvents(rows, { status: '完成', elapsedMs: 19100 });
  check('快照带阶段（标题 + 步数区间）',
    Array.isArray(snap.phases) && snap.phases.length === 2 &&
    snap.phases[0].t === '我先看仓库结构' && snap.phases[1].t === '结构清楚了，数一下行数。' &&
    snap.phases[0].i === 0 && snap.phases[0].n === 1 && snap.phases[1].i === 1 && snap.phases[1].n === 1,
    JSON.stringify(snap.phases));
  check('超过 30 步的分组快照区间跟着平移（不出负数、不丢段）', (() => {
    const many = [{ evt: { type: 'text', text: '开场' }, at: '2026-11-05T00:00:00.000Z' }];
    for (let i = 0; i < 35; i++) {
      many.push({ evt: { type: 'tool', name: 'Bash', input: { command: `cmd ${i}` } }, at: `2026-11-05T00:00:${String(i + 1).padStart(2, '0')}.000Z` });
      if (i === 20) many.push({ evt: { type: 'text', text: '后半段开始。' }, at: `2026-11-05T00:00:${String(i + 1).padStart(2, '0')}.500Z` });
    }
    const s = summarizeEvents(many, { status: '完成', elapsedMs: 36000 });
    const okShape = s.phases?.length === 2 && s.steps.length === 30 &&
      s.phases.every((g) => g.i >= 0 && g.i + g.n <= 30) &&
      s.phases[0].i + s.phases[0].n === s.phases[1].i;
    return okShape;
  })(), '');
}

console.log(`\n结论：${failed ? `${failed} 项没过` : '全通过'}`);
process.exit(failed ? 1 : 0);
