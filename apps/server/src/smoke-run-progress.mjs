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

  v = f.feed({ type: '__done', status: 'done' });
  check('__done → 已完成', v.done === true && v.status === 'done', `${v.done}/${v.status}`);
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
  /*
   * MCP（2026-11-08 二版）：以前只出"调用工具"四个字、没有目标 —— 一跑几分钟同一句不变，
   * 用户看到的就是"这块根本没在动"。现在从 item 的 server/tool（codex）或
   * `mcp__server__tool` 名字里（claude）把工具名读出来当目标。
   */
  const s3 = toolSummary('mcp_tool_call', null, { server: 'github', tool: 'search' });
  check('mcp 调用 → 调用工具 + server·tool', s3.verb === '调用工具' && s3.target === 'github · search', `${s3.verb} ${s3.target}`);
  const s4 = toolSummary('mcp__aliyun__DescribeInstances', null);
  check('claude 的 mcp__server__tool → 目标取工具名', s4.target === 'DescribeInstances', s4.target);
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

  applyRunEvent(st, { type: '__done', status: 'done' }, STALL_MS + 1);
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
  const v2 = f.feed({ type: '__done', status: 'failed' });
  check('__done 失败 → 状态「失败」', v2.done && v2.status === 'failed', v2.status);
}

/* --------------------------------------------------- ⑥ 界面接线（静态） */
console.log('\n⑥ 聊天页接线（静态断言，防"归约器写了没人用"）');
{
  const chatSrc = fs.readFileSync(new URL('../../web/js/chat.mjs', import.meta.url), 'utf8');
  // 2026-10-29：画卡片这一层从 chat.mjs 拆成共用组件 run-progress-card.mjs（任务卡讨论区用同一套）。
  // 「停止生成 / 等结果」的落点跟着搬进组件 —— 断言改成两头都钉：组件里有这颗钮/这档状态，
  // chat.mjs 确实把组件接上了并传了 onStop，少一头都算红。
  const cardSrc = fs.readFileSync(new URL('../../web/js/run-progress-card.mjs', import.meta.url), 'utf8');
  const liveSrc = fs.readFileSync(new URL('../../web/js/run-live.mjs', import.meta.url), 'utf8');
  const projSrc = fs.readFileSync(new URL('../../web/js/projects.mjs', import.meta.url), 'utf8');
  const runsSrc = fs.readFileSync(new URL('./runs.mjs', import.meta.url), 'utf8');
  check('chat.mjs 引用了 run-progress.mjs', /from '\.\/run-progress\.mjs'/.test(chatSrc));
  check('streamRun 把每个原始事件交给 onEvent', /h\.onEvent\?\.\(evt\)/.test(chatSrc));
  check('attachStream 接收 startAt 并按真实开始时间计时', /attachStream\(runId, whoName = '', startedAt = null\)/.test(chatSrc));
  check('重进会话时把 run.startedAt 带过去', /attachStream\(last\.id, last\.personaName, last\.startedAt\)/.test(chatSrc));
  check('不再用三个点占位', !/class="typing"><i><\/i><i><\/i><i><\/i>/.test(chatSrc));
  // 2026-11-05 评鉴：停止钮从"卡住才出现"改成**常驻卡头**（收尾才隐掉），打断是第一类操作
  check('停止钮常驻卡头（收尾才隐掉）', /class="rp-stop" title="停止生成" hidden/.test(cardSrc) && /createProgressCard\(\{[\s\S]*?onStop/.test(chatSrc));
  check('卡住的步骤有「等结果」状态（不再假装进行中）', /waiting/.test(cardSrc) && /已等/.test(cardSrc));
  /*
   * 2026-11-08 改成**单行气泡**（用户："重要的不是显示的是什么，是在动"）：
   * 标题不再是"意图"那句人话（太长、也太旧），而是**此刻正在做的那件事**——
   * 意图降级成悬停提示；步骤明细运行中也不再摊开（收尾点这一行才展开回看）。
   * 二版钉过"日志只认真在跑/刚落地 20 秒内的工具"：否则模型转去写回话了，这行还挂着旧工具名。
   */
  check('日志行写当前动作，意图只做 title',
    /const live = v\.currentStep \|\| \(v\.phase === 'tool' && fresh \? v\.lastStep : null\)/.test(cardSrc) &&
    /\.rp-phase'\)\.title = v\.intent/.test(cardSrc));
  /*
   * 2026-11-08 三版 + 2026-11-09 收口（用户："单行气泡刷日志…真正的回复出来后代替这个
   * 单行日志气泡"；英文运行实拍："单气泡刷进行时的设计不管用了"）：
   *   · 一轮只占**一颗** .bubble：跑着时挂 .live-line、里面只有进度胶囊；
   *   · 直播回话状态机收在 **run-live.mjs**，chat.mjs 与任务卡讨论区（projects.mjs）共用：
   *     text 一律不直播（先攒），后面来了工具事件就作废（中间话），turn_end/收尾时才顶掉
   *     日志行落成回复 —— 英文 agent"每调一次工具解说一句"不再铺成段落；
   *   · 钉"共用"这件事：讨论区漏接是 2026-11-09 实拍，别再各写一套。
   */
  check('单行日志泡 = 那颗 .bubble（不再是两颗泡）',
    /class="bubble live-line"/.test(chatSrc) && /body\.appendChild\(card\.el\)/.test(chatSrc) && !/live-col/.test(chatSrc));
  check('直播回话状态机收在共用模块（聊天页 + 任务卡讨论区共用）',
    /from '\.\/run-live\.mjs'/.test(chatSrc) && /from '\.\/run-live\.mjs'/.test(projSrc) &&
    /createLiveAnswer/.test(liveSrc) && !/pendingText/.test(chatSrc));
  check('真正的回复顶掉日志行（enterAnswer 移除胶囊）',
    /const enterAnswer = \(\) => \{/.test(liveSrc) && /card\?\.el\?\.remove/.test(liveSrc) &&
    /body\.classList\.remove\('live-line'\)/.test(chatSrc));
  check('text 不直播：中间话见工具就作废、收尾才落成回复',
    /pending \+= chunk/.test(liveSrc) && /pending = ''/.test(liveSrc) && /flushPending/.test(liveSrc) &&
    /live\.pushText\(chunk\)/.test(projSrc) && /live\.flushPending\(\)/.test(projSrc));
  check('思考片段固定刷在这一行（「思考过程」开关已退场）',
    /note = '思考：'/.test(cardSrc) && !/showThinking/.test(cardSrc) && !/dThink/.test(chatSrc));
  check('步骤明细运行中收起', /stepsEl\.hidden = true/.test(cardSrc));
  /*
   * 2026-11-08 **砍掉历史过程收起行**（用户实判"没啥用"）：实时卡保留，但不再给回话
   * 消息摘快照（codex 系不发工具结果事件，快照里步骤全是「已发起」、没有成败与耗时）。
   * 这里钉两头：前端不再渲染、服务端不再落库 —— 谁想加回来，先看这条用例和理由。
   */
  check('历史回话不再画过程收起行', !/progressNoteHtml|data-rp-note/.test(chatSrc));
  check('服务端收尾不再写过程快照', !/progressMeta|summarizeEvents/.test(runsSrc));
  // 2026-11-05 二期：阶段分组要两头都接上 —— 实时卡按段画（历史快照那条腿已随收起行砍掉）
  check('实时进度卡按阶段画步骤', /rp-ph/.test(cardSrc) && /v\.phases/.test(cardSrc));
  // 2026-11-05 实测（用户截图）：display:flex 的作者样式压过 UA 的 [hidden]{display:none}，
  // 折叠明细永远摊开、实时卡收尾收不起来 —— 全局 reset 是这条链路能收起的前提
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

/* --------------------------------------------------- ⑨ 阶段分组（2026-11-05 二期） */
console.log('\n⑨ 阶段分组：工具之间的正文 = 下一批工具的段标题');
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
}

console.log(`\n结论：${failed ? `${failed} 项没过` : '全通过'}`);
process.exit(failed ? 1 : 0);
