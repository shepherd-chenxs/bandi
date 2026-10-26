/**
 * run-progress.mjs —— 把一次运行的**事件流**翻译成"他现在走到哪一步了"。
 *
 * 背景（2026-10-26 用户实问）：数字员工在跑的时候，聊天页只有三个点 ——
 * 不知道他在想、在调工具、还是已经卡住了。底层其实一直有事件
 * （dsh headless 的 JSONL、codex/claude 的适配事件都原样落在 `run_events`，
 * SSE 重连还会重放），缺的是"事件 → 人话"这一层。
 *
 * 这一层**不碰 DOM**（纯逻辑），好处有两个：
 *   · 聊天页用它画实时状态；流程实例页的节点对话将来可以共用同一份；
 *   · 冒烟用例直接 import 它、喂真实事件序列断言，不需要浏览器。
 *
 * 四家 runtime 的词不一样，这里收敛成三种语义：
 *   · 阶段：status(phase) / thinking / text / error / __done
 *   · **一步 = 一次工具调用**（dsh: `tool_call` → `tool_result`；codex/claude 只有 `tool`）
 *   · 收尾：`__done`（带最终状态）
 * dsh 那边还有 `step_start`/`step_end` 的"步"边界，但那是模型的一步里可能调多个工具；
 * 对用户来说"调了一次工具"才是看得见的一步，所以计数按工具调用走。
 */

/** 多久没有任何新事件就算"可能卡住了"（用户 2026-10-26 定 5 分钟） */
export const STALL_MS = 5 * 60 * 1000;

/** 阶段 → 人话。界面只认这几个词，别在别处再翻译一遍 */
export const PHASE_TEXT = {
  starting: '准备中',
  thinking: '思考中',
  writing: '写回话',
  tool: '调用工具',
  wrapping: '收尾中',
  done: '已完成',
  error: '出错了',
};

/**
 * 工具名 → 人话动词。四家 runtime 用的名字不一样（Bash / shell / command_execution…），
 * 认不出就原样显示名字 —— 宁可写个裸名字，也别编一个错的动词。
 */
const TOOL_VERBS = [
  [/^(bash|shell|command|exec|terminal|command_execution|process)/i, '运行命令'],
  [/^(read|read_file|view|cat)/i, '读文件'],
  [/^(edit|write|apply_patch|str_replace|file_change|patch)/i, '改文件'],
  [/^(grep|search|find|query)/i, '搜索'],
  [/^(glob|ls|list|dir)/i, '找文件'],
  [/^(webfetch|fetch|http|curl)/i, '抓网页'],
  [/^(websearch|web_search)/i, '搜网页'],
  [/^(mcp|tool)/i, '调用工具'],
];

function clip(text, max = 80) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * 把一次工具调用压成"动词 + 目标"。
 *
 * 目标从各 runtime 的输入字段里按优先级捡（命令 > 文件路径 > 搜索词 > URL > 描述）；
 * codex 的 `tool` 事件还带一份原始 `detail`（item 对象），所以也一起看。
 * 只取**人能一眼认出的那一个**，不把整个 input JSON 摊出来（那是日志，不是状态）。
 */
export function toolSummary(name, input, detail = null) {
  const raw = String(name ?? '工具');
  const verb = (TOOL_VERBS.find(([re]) => re.test(raw)) ?? [null, raw])[1];
  const p = input && typeof input === 'object' ? input : {};
  const d = detail && typeof detail === 'object' ? detail : {};
  const first = (...vals) => {
    for (const v of vals) {
      if (Array.isArray(v)) {
        const joined = v
          .map((x) => (typeof x === 'string' ? x : (x?.path ?? x?.file_path ?? '')))
          .filter(Boolean)
          .join(', ');
        if (joined) return joined;
      }
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };
  const target = first(
    p.command, d.command,
    p.file_path, p.path, p.notebook_path, d.file_path,
    p.pattern, p.query, p.url, p.description, p.prompt,
    p.changes, d.changes, d.path,
  );
  return { verb, target: clip(target), name: raw };
}

/**
 * 一次运行的进度状态（纯数据）。
 * `startedAt`：这次运行真正开始的时间（从服务端 run 行带过来；拿不到就用现在）。
 */
export function createRunProgress({ startedAt = Date.now(), now = Date.now() } = {}) {
  return {
    startedAt: Number.isFinite(startedAt) ? startedAt : now,
    lastEventAt: now,
    phase: 'starting',
    turns: 0,
    steps: [],
    byCall: new Map(),
    error: '',
    info: '',
    done: false,
    status: '',
  };
}

/** 新动作开始时，把上一个"还在跑"的收成「已发起」—— codex/claude 没有结果事件，不硬猜成败 */
function closeRunning(state) {
  for (const s of state.steps) if (s.status === 'running') s.status = 'called';
}

/**
 * 吃一个事件。**原地改 state 并返回它**（调用方拿着同一个引用就行）。
 *
 * ⚠️ 事件类型对不上就**忽略**：`session` / `final` / `raw` 这些不影响"到哪一步"，
 *    硬猜反而会画出假步骤。认不出的事件保持当前状态，比乱跳强。
 */
export function applyRunEvent(state, evt, now = Date.now()) {
  if (!state || !evt || typeof evt !== 'object') return state;
  state.lastEventAt = now;
  const type = String(evt.type ?? '');

  // 除了"结果事件"，任何新动静都意味着上一个还在跑的动作已经有下文了
  if (type !== 'tool_result') closeRunning(state);

  switch (type) {
    case 'status': {
      if (evt.phase === 'turn_start') {
        state.turns += 1;
        state.phase = 'thinking';
      } else if (evt.phase === 'step_start') {
        state.phase = 'thinking';
      } else if (evt.phase === 'step_end') {
        if (state.phase === 'tool') state.phase = 'thinking';
      } else if (evt.phase === 'turn_end') {
        state.phase = 'wrapping';
      }
      // claude 的 informational 也是 status：它带一句人话（例："正在压缩上下文"）
      if (typeof evt.text === 'string' && evt.text.trim()) state.info = clip(evt.text, 120);
      break;
    }
    case 'thinking':
      state.phase = 'thinking';
      break;
    case 'text':
      state.phase = 'writing';
      break;
    case 'tool': {
      // codex / claude / 平台统一词汇：只有"开始"，没有结果
      state.steps.push({
        callId: null,
        name: evt.name ?? '工具',
        input: evt.input ?? null,
        detail: evt.detail ?? null,
        status: 'running',
        at: now,
        endedAt: null,
        error: '',
      });
      state.phase = 'tool';
      break;
    }
    case 'tool_call': {
      // dsh：有 id、有输入，后面会跟一条 tool_result
      const step = {
        callId: evt.callId ?? null,
        name: evt.tool ?? evt.name ?? '工具',
        input: evt.input ?? null,
        detail: null,
        status: 'running',
        at: now,
        endedAt: null,
        error: '',
      };
      state.steps.push(step);
      if (step.callId) state.byCall.set(step.callId, step);
      state.phase = 'tool';
      break;
    }
    case 'tool_result': {
      const step = evt.callId
        ? state.byCall.get(evt.callId)
        : [...state.steps].reverse().find((s) => s.status === 'running');
      if (step) {
        step.status = evt.status === 'error' ? 'error' : 'done';
        step.endedAt = now;
        if (step.status === 'error') step.error = clip(evt.result, 120);
      }
      state.phase = 'tool';
      break;
    }
    case 'error':
      state.phase = 'error';
      state.error = clip(String(evt.message ?? evt.text ?? '').split('\n')[0] || '运行失败', 160);
      break;
    case '__done': {
      state.done = true;
      state.status = String(evt.status ?? '');
      state.phase = evt.status === '失败' ? 'error' : 'done';
      closeRunning(state);
      break;
    }
    default:
      break;
  }
  return state;
}

/**
 * 画界面用的一份只读视图（含"卡住"判定与每步的人话）。
 * `now` 由调用方传（每秒重画时用它算用时，不要在纯函数里摸 Date.now 再测不过）。
 */
export function progressView(state, now = Date.now()) {
  const steps = state.steps.map((s, i) => {
    const { verb, target } = toolSummary(s.name, s.input, s.detail);
    const durMs =
      s.endedAt != null ? s.endedAt - s.at
      : s.status === 'running' ? Math.max(0, now - s.at)
      : null;
    return {
      n: i + 1,
      status: s.status, // running | called | done | error
      name: s.name,
      verb,
      target,
      durMs,
      error: s.error,
    };
  });
  const idleMs = Math.max(0, now - state.lastEventAt);
  const lastRaw = state.steps[state.steps.length - 1] ?? null;
  const current = [...steps].reverse().find((s) => s.status === 'running') ?? null;
  const last = steps[steps.length - 1] ?? null;
  return {
    phase: state.phase,
    phaseText: PHASE_TEXT[state.phase] ?? '进行中',
    elapsedMs: Math.max(0, now - state.startedAt),
    idleMs,
    stalled: !state.done && idleMs >= STALL_MS,
    done: state.done,
    status: state.status,
    error: state.error,
    info: state.info,
    stepCount: steps.length,
    steps,
    currentStep: current,
    lastStep: last,
    lastAgoMs: lastRaw ? Math.max(0, now - lastRaw.at) : null,
    lastAction: last ? `${last.verb}${last.target ? ` ${last.target}` : ''}` : '',
  };
}

/* ---------------------------------------------------------------- 格式化 */

/** 总用时：mm:ss；超过一小时给 h:mm:ss */
export function fmtElapsed(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

/** "多久以前"：刚刚 / N 秒前 / N 分钟前 / N 小时前 */
export function fmtAgo(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 3) return '刚刚';
  if (total < 60) return `${total} 秒前`;
  if (total < 3600) return `${Math.floor(total / 60)} 分钟前`;
  return `${Math.floor(total / 3600)} 小时前`;
}

/** 单步耗时：不到一秒也显示 1s（"0s"看着像没耗时） */
export function fmtStepDur(ms) {
  return `${Math.max(1, Math.round(ms / 1000))}s`;
}
