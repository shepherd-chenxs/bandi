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
 * 只画直播 —— 2026-11-08 起不再有"收尾快照"（原来服务端用 summarizeEvents 把摘要
 * 写进回话消息的 meta.progress，历史里画成可展开的收起行；用户实判没啥用，砍了）。
 * 所以这里只服务"正在跑"的那一块，跑完 300ms 整页重画就没了，不需要收尾快照这条路。
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
 * 命令串的"保头保尾"截断（2026-11-05 评鉴）：头是动作，尾常是管道/目标 ——
 * 两头都比中间值钱。普通 clip 从头截，长命令的尾巴（`| wc -l`）正好被切掉。
 */
export function clipEnds(text, max = 80) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const head = Math.max(24, Math.floor(max * 0.6));
  const tail = max - head - 1;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/**
 * 命令串的人话化（2026-11-05 评鉴）：进度卡上"运行命令 …"的目标本来是整条命令，
 * 但解释器的全路径（C:\Windows\...\powershell.exe）是噪音 —— 人知道系统目录在哪，
 * 机器才知道为什么要全路径；而 80 字截断又正好切在唯一有信息量的参数上。剥三层皮：
 *   · 上游事件里的**双层转义**（C:\\Windows）归一成单反斜杠 —— 只影响展示，
 *     原始命令在悬停 title / 展开详情里还是全的；
 *   · 开头的解释器全路径（带引号 / 带盘符 / 裸 powershell.exe）整段剥掉；
 *   · PowerShell 的 -Command / shell 的 -c 参数词剥掉，只留正文。
 */
export function humanizeCommand(raw) {
  let s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  s = s.replace(/\\{2,}/g, '\\');
  s = s
    .replace(/^"([^"]+[\\/][^"]*\.(?:exe|cmd|bat|ps1|py|sh|js|pl))"\s+/i, '')
    .replace(/^(?:[A-Za-z]:)?\S*?[\\/]\S*\.(?:exe|cmd|bat|ps1|py|sh|js|pl)\s+/i, '')
    .replace(/^\S+\.(?:exe|cmd|bat)\s+/i, '');
  // PowerShell 的 -Command、shell/cmd 的 -c / /c：参数词本身不给人看，后面才是正文
  const mc = s.match(/^[-\/](?:Command|c)\s+([\s\S]*)$/i);
  if (mc) s = mc[1];
  else {
    // 不带扩展名的解释器路径（/usr/bin/sh、/bin/bash）：靠"后面跟 -c"认出它是解释器，
    // 路径和参数词一起剥。（要求开头必须是路径 —— 'git -c xxx=true' 的 -c 是配置项，不能剥）
    const mi = s.match(/^\S*[\\/]\S*\s+(?=[-\/](?:Command|c)\s)/i);
    if (mi) s = s.slice(mi[0].length).replace(/^[-\/](?:Command|c)\s+/i, '');
  }
  if (s.length > 1 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  return s.trim();
}

/**
 * MCP 调用的"名字里能读出来的那一段"（2026-11-08）。
 * 两家给的形状不同：
 *   · codex（`mcp_tool_call`）→ item 上有 `server` / `tool` 两个字段；
 *   · claude → 工具名本身写成 `mcp__<server>__<tool>`。
 * 以前这两种都落到"调用工具"四个字（没有目标），一跑十分钟同一句不变 ——
 * 用户看到的就是"这块根本没在动"。读出 tool 名，日志才会一步步往前刷。
 */
function mcpLabel(name, d, p) {
  const srv = String(d.server ?? p.server ?? '').trim();
  const tool = String(d.tool ?? p.tool ?? '').trim();
  if (tool) return srv ? `${srv} · ${tool}` : tool;
  const m = /^mcp__(.+?)__(.+)$/.exec(String(name ?? ''));
  return m ? m[2] : '';
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
    d.query, d.pattern, d.url, d.prompt,
    p.changes, d.changes, d.path,
    // MCP 排最后：它是"名字兜底"，前面那些字段有真东西时不该被工具名顶掉
    mcpLabel(raw, d, p),
  );
  // 命令类目标走人话化（剥解释器全路径 / 双层转义归一）+ 保头保尾截断；
  // 其余（文件路径、搜索词、URL）保持普通截断 —— 路径的头才是信息量所在
  const shown = first(p.command, d.command)
    ? clipEnds(humanizeCommand(target))
    : clip(target);
  return { verb, target: shown, name: raw };
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
    // 意图（2026-11-05 评鉴）：第一件工具之前的回话原文 —— "他要干嘛"的人话，
    // 界面拿它当进度卡标题（"调用工具"这种机器词退居后备）
    intent: '',
    // 工具之间的正文（2026-11-05 评鉴二期）："官方库没有，去社区搜"这种话天然是
    // 下一批工具的**阶段标题**。after = 说这话时已经落了几步（阶段边界）；
    // 同一 after 的分块正文往一条里并（流式 chunk / 同一批前的多段话）。
    speech: [],
    // 服务端 __done 带来的总用时（收尾后时钟冻结用；没有就退回 lastEventAt-startedAt）
    finalElapsedMs: null,
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
    case 'text': {
      state.phase = 'writing';
      const txt = typeof evt.text === 'string' ? evt.text : '';
      // 开场白攒成"意图"：第一件工具之前的正文是"他要干嘛"（"我先看仓库结构，再数代码量"），
      // 工具开跑之后的正文是回话本身，不算意图；但它是**阶段边界**（见 speech）
      if (!state.steps.length) state.intent += txt;
      else if (txt.trim()) {
        const last = state.speech[state.speech.length - 1];
        if (last && last.after === state.steps.length) last.text += txt;
        else state.speech.push({ after: state.steps.length, text: txt });
      }
      break;
    }
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
      state.phase = evt.status === 'failed' ? 'error' : 'done';
      if (Number.isFinite(evt.elapsedMs)) state.finalElapsedMs = evt.elapsedMs;
      closeRunning(state);
      break;
    }
    default:
      break;
  }
  return state;
}

/* --------------------------------------------------- 阶段分组（2026-11-05 评鉴二期） */

/**
 * 把一次运行的步骤按**模型自己说话的时机**分段。
 *
 * 工具之间的正文（"官方库没有，去社区搜"）是模型对"接下来这批工具"的预告 ——
 * 拿它当阶段标题，13 条命令流水账就变成"读手册 → 查官方库 → 搜社区 → 核对候选"。
 * 第一段没有中途正文可标题，用意图（开场白）顶着；都没有就退回机器词。
 *
 * 开头之前（after=0，那进意图）和最后回话之后（没有后续步骤）的话不构成边界 ——
 * 收尾正文是答案本身，气泡里已经有，不重复当标题。
 * 分不出两段（没有中途正文）返回 null，界面走平铺 —— 别为了分组硬编故事。
 *
 * 返回 [{ title, raw, i, n }]：i/n 是 steps 数组里的下标区间。
 */
export function phaseGroups(speech, intent, total) {
  const bounds = [];
  for (const sp of speech ?? []) {
    const text = String(sp?.text ?? '').trim();
    if (!text || !Number.isInteger(sp?.after)) continue;
    if (sp.after <= 0 || sp.after >= total) continue;
    if (bounds.length && bounds[bounds.length - 1].i === sp.after) continue;
    bounds.push({ i: sp.after, text });
  }
  if (!bounds.length) return null;
  const groups = [];
  const push = (title, i, n) => {
    if (n > 0) groups.push({ title: clip(title, 48), raw: clip(title, 200), i, n });
  };
  push(String(intent ?? '').trim(), 0, bounds[0].i);
  for (let k = 0; k < bounds.length; k++) {
    const end = k + 1 < bounds.length ? bounds[k + 1].i : total;
    push(bounds[k].text, bounds[k].i, end - bounds[k].i);
  }
  return groups.length >= 2 ? groups : null;
}

/**
 * 分组 + 截断一步到位：有阶段时步骤留最后 maxSteps 步（区间跟着平移，空段丢掉），
 * 没阶段时原样返回 —— 平铺的老路（聊天页实时卡"…前 N 步已折叠"）不受影响。
 */
export function withPhases(steps, speech, intent, maxSteps = 30) {
  let phases = phaseGroups(speech, intent, steps.length);
  let list = steps;
  if (phases && steps.length > maxSteps) {
    const off = steps.length - maxSteps;
    list = steps.slice(off);
    phases = phases
      .map((g) => {
        // 头尾都要平移：只移头不移尾的话，截断点两侧的段会重叠
        const start = Math.max(0, g.i - off);
        const end = Math.min(g.i + g.n - off, list.length);
        return { ...g, i: start, n: Math.max(0, end - start) };
      })
      .filter((g) => g.n > 0);
    if (phases.length < 2) phases = null;
  }
  return { steps: list, phases };
}

/**
 * 画界面用的一份只读视图（含"卡住"判定与每步的人话）。
 * `now` 由调用方传（每秒重画时用它算用时，不要在纯函数里摸 Date.now 再测不过）。
 */
export function progressView(state, now = Date.now()) {
  const idleMs = Math.max(0, now - state.lastEventAt);
  /*
   * **卡住以后，把"进行中"降级成"等结果"**（2026-10-26 实报：一次运行卡在 Write 上 20 分钟，
   * 卡片同时写着"可能卡住了"和"进行中 1237s"，自相矛盾）。
   * 没有结果事件的 runtime（codex/claude 的 `tool`）本来就有这个歧义 —— 到底是工具还在跑、
   * 还是上游模型请求挂了，客户端分不出来；既然整条运行已经 5 分钟没动静，就当"等结果"，
   * "可能卡住"的判断交给头顶那行，别在步骤上再假装它还在动。
   */
  const stalled = !state.done && idleMs >= STALL_MS;
  const steps = state.steps.map((s, i) => {
    const { verb, target } = toolSummary(s.name, s.input, s.detail);
    const running = s.status === 'running' && !stalled;
    const waiting = s.status === 'running' && stalled;
    const durMs =
      s.endedAt != null ? s.endedAt - s.at
      : running || waiting ? Math.max(0, now - s.at)
      : null;
    return {
      n: i + 1,
      // running | waiting（卡住了，等回执）| called | done | error
      status: stalled && s.status === 'running' ? 'waiting' : s.status,
      name: s.name,
      verb,
      target,
      durMs,
      error: s.error,
    };
  });
  const lastRaw = state.steps[state.steps.length - 1] ?? null;
  const current = [...steps].reverse().find((s) => s.status === 'running') ?? null;
  const last = steps[steps.length - 1] ?? null;
  // 阶段分组：分得出来就给 phases（界面按段画），分不出来 null（平铺老路）
  const grouped = withPhases(steps, state.speech, (state.intent || '').trim());
  return {
    phase: state.phase,
    phaseText: PHASE_TEXT[state.phase] ?? '进行中',
    // 收尾后时钟冻结：服务端 __done 带了总用时就用它，没有就用"最后一个事件"的时刻，
    // 别让每秒重画把"已完成"的用时继续往上跳
    elapsedMs:
      state.done && state.finalElapsedMs != null ? state.finalElapsedMs
      : state.done ? Math.max(0, state.lastEventAt - state.startedAt)
      : Math.max(0, now - state.startedAt),
    idleMs,
    stalled,
    done: state.done,
    status: state.status,
    error: state.error,
    info: state.info,
    intent: (state.intent || '').trim(),
    stepCount: steps.length,
    steps: grouped.steps,
    phases: grouped.phases,
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
