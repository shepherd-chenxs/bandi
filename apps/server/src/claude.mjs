import { agentEnv } from './git-repos.mjs';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { runCwd } from './config.mjs';

/**
 * Claude Code 适配器（headless）。
 *
 * 实测（Claude Code 2.1.296）：
 * - 任务文本走 **stdin**，配 `-p`（不带 prompt 参数）——和 codex 同一个约定
 * - `--output-format stream-json --verbose` 每行一个 JSON 事件
 * - 结算事件是 `{"type":"result","subtype":"success","result":"..."}`；
 *   **注意 `type` 键排在对象末尾**，只扫开头会以为它不是 result
 * - `--resume <session_id>` 能续接记忆（实测第二轮答出了第一轮让它记的词）
 * - `system/thinking_tokens` 极其密集（一个小任务 ~75 条），本适配器**直接丢弃**，
 *   否则会把 SSE 和界面冲爆
 * - stderr 上会混非 JSON 的告警行（如 `[claude-code:unrecognized_model]`），解析要跳过
 */
/**
 * claude 的可执行文件位置。
 *
 * ⚠️ **这里故意不再有字面量默认值。** 原来写的是开发那台机器的路径
 * （`D:\AppData\nodejs\...\claude-code\bin\claude.exe`）—— 换台机器就是个死路径，
 * 而它还会被当兜底悄悄用起来：建运行时的时候存进去、启动时拿去 spawn。
 * 现在没有路径就**明确报错**，由运行时记录（`runtimes.json` 里的 path）负责给。
 * 开发时想指定就设 `BANDI_CLAUDE_EXE`。
 */
export const DEFAULT_PATH = process.env.BANDI_CLAUDE_EXE ?? '';

/** `--permission-mode` 的合法取值。超出这个集合的值不传给 CLI，免得它直接报错退出 */
export const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];

export function launchCommand(pathOverride) {
  const p = pathOverride || DEFAULT_PATH;
  if (!p) throw new Error('没有可执行路径 —— 去「设置 → 运行时」识别并接入一个');
  return { file: p, args: [], env: {} };
}

export function buildArgs({ sessionId = null, model = null, sandbox = null, roots = [] } = {}) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (sessionId) args.push('--resume', sessionId);
  if (model) args.push('--model', model);
  // 员工的 sandbox 是从别的 runtime 带过来的值时（比如 codex 的 danger-full-access），
  // 不认识的模式就不传，让 Claude 用它自己的设置，别把任务打挂
  if (sandbox && PERMISSION_MODES.includes(sandbox)) args.push('--permission-mode', sandbox);
  // --add-dir 是变参，放最后，避免把后面的参数吃掉
  if (roots.length) args.push('--add-dir', ...roots);
  return args;
}

/** 错误原因只留一句能读完的：CLI 的 result 有时是整段输出 */
const clip = (s, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * 失败原因取"人话"，别拿 subtype 顶（2026-10-26 实踩）。
 *
 * 未登录时 CLI 回的是 `{ is_error: true, subtype: "success", result: "Not logged in · Please run /login" }`
 * —— 原来的 `api_error_status || subtype` 就把 "success" 当成了原因，界面上显示
 * 「没跑成：success」：一句把"成功"和"没跑成"焊在一起的话，用户拿着它什么也做不了。
 *
 * 取值顺序：认证错误（最常见，翻成能照做的中文）→ 接口状态码 → CLI 给的 result 原文
 * → terminal_reason → 非 success 的 subtype → stderr 尾行。
 */
function explainError({ result, cliError, apiErrorStatus, terminalReason, subtype, stderr }) {
  const said = typeof result === 'string' ? result.trim() : '';
  if (cliError === 'authentication_failed' || /not logged in|please run \/login|invalid api key|unauthorized/i.test(said)) {
    return 'Claude Code 没登录 —— 在终端跑 `claude`，输入 /login 登录后再试';
  }
  if (apiErrorStatus) return `接口报错 ${apiErrorStatus}${said ? `：${clip(said)}` : ''}`;
  if (said) return clip(said);
  if (terminalReason && terminalReason !== 'success') return terminalReason;
  if (subtype && subtype !== 'success') return subtype;
  const tail = String(stderr ?? '').trim().split(/\r?\n/).filter(Boolean).slice(-1)[0];
  return tail ? clip(tail) : '运行出错';
}

export function probe(pathOverride) {
  const p = pathOverride || DEFAULT_PATH;
  if (!p) return Promise.resolve({ ok: false, error: '没有可执行路径' });
  if (!fs.existsSync(p)) return Promise.resolve({ ok: false, error: `找不到这个文件：${p}` });
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(p, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      // spawn 在同步阶段抛（Node 22 起 spawn 一个 .cmd 就是 EINVAL）。
      // 在 Promise executor 里抛 = reject，会让整个 HTTP 请求变 500 —— 必须接住。
      resolve({ ok: false, error: `起不来：${[e?.code, e?.message].filter(Boolean).join(' ')}` });
      return;
    }
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', (e) => resolve({ ok: false, error: `起不来：${e.message}` }));
    child.on('close', (code) => {
      const first = (s) => String(s).trim().split('\n').map((x) => x.trim()).filter(Boolean)[0] ?? '';
      resolve(
        code === 0
          ? { ok: true, version: first(out) || first(err) }
          : { ok: false, error: `路径不可用：${first(err) || first(out) || `退出码 ${code}`}` },
      );
    });
  });
}

export function runTask({
  task,
  sessionId = null,
  cwd = runCwd,
  roots = [],
  sandbox = null,
  model = null,
  cliPath = null,
  env = {},
  onEvent = () => {},
  signal = null,
}) {
  return new Promise((resolve, reject) => {
    const args = buildArgs({ sessionId, model, sandbox, roots });
    const launch = launchCommand(cliPath);

    const child = spawn(launch.file, [...launch.args, ...args], {
      cwd,
      windowsHide: true,
      env: { ...agentEnv(), ...launch.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let buf = '';
    const events = [];
    let text = '';
    let resolvedSessionId = sessionId;
    let usage = null;
    let settled = false;
    let thinkingTicks = 0;
    let stderr = '';
    let sawError = null;
    /*
     * CLI 在 assistant 消息上标出的错误类别（2026-10-26）：未登录时是 "authentication_failed"，
     * 比 result 里的字段精确得多 —— 那种情况下 result 的 subtype 还写着 "success"。
     */
    let cliError = null;

    const emit = (ev) => {
      events.push(ev);
      onEvent(ev);
    };

    const finish = (extra) => {
      if (settled) return;
      settled = true;
      resolve({ text, sessionId: resolvedSessionId, usage, events, thinkingTicks, ...extra });
    };

    const handle = (j) => {
      if (j.type === 'system') {
        if (j.subtype === 'init') {
          resolvedSessionId = j.session_id ?? resolvedSessionId;
          emit({ type: 'session', sessionId: resolvedSessionId, model: j.model, permissionMode: j.permissionMode });
        } else if (j.subtype === 'thinking_tokens') {
          // 太密了，只记数不转发
          thinkingTicks++;
        } else if (j.subtype === 'informational') {
          emit({ type: 'status', text: j.content });
        }
        return;
      }

      if (j.type === 'assistant') {
        if (j.error) cliError = j.error; // 例：authentication_failed
        for (const block of j.message?.content ?? []) {
          if (block.type === 'thinking' && block.thinking) {
            emit({ type: 'thinking', text: block.thinking });
          } else if (block.type === 'text' && block.text) {
            text += block.text;
            emit({ type: 'text', text: block.text });
          } else if (block.type === 'tool_use') {
            emit({ type: 'tool', name: block.name, input: block.input });
          }
        }
        return;
      }

      if (j.type === 'result') {
        if (j.session_id) resolvedSessionId = j.session_id;
        const u = j.usage ?? {};
        usage = {
          inputTokens: u.input_tokens,
          outputTokens: u.output_tokens,
          cacheReadTokens: u.cache_read_input_tokens,
          totalTokens:
            (u.input_tokens ?? 0) +
            (u.output_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0),
          costUsd: j.total_cost_usd,
          turns: j.num_turns,
        };
        if (typeof j.result === 'string' && j.result) text = j.result;
        if (j.is_error) {
          sawError = explainError({
            result: j.result,
            cliError,
            apiErrorStatus: j.api_error_status,
            terminalReason: j.terminal_reason,
            subtype: j.subtype,
            stderr,
          });
          emit({ type: 'error', text: String(sawError) });
        }
        emit({ type: 'final', text, usage });
        finish({ isError: j.is_error, error: sawError, stopReason: j.stop_reason });
      }
      // user / tool_result 事件忽略：工具调用已经在上面的 tool_use 里报过了
    };

    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let j;
        try {
          j = JSON.parse(line);
        } catch {
          continue; // 非 JSON 行（告警之类）直接跳过
        }
        handle(j);
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    });

    child.on('close', (code) => {
      if (settled) return;
      // 没等到 result 就退出了：把 stderr 带回去，别交了白卷还说成功
      const tail = stderr.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
      settled = true;
      resolve({
        text,
        sessionId: resolvedSessionId,
        usage,
        events,
        thinkingTicks,
        isError: true,
        exitCode: code,
        error: tail || `进程退出码 ${code}，且没有收到 result 事件`,
      });
    });

    if (signal) {
      signal.addEventListener('abort', () => {
        try { child.kill(); } catch { /* ignore */ }
        // 只杀直接子进程不够：孙进程占着 stdout 管道会让 'close' 永远不来（见 dsh.mjs 同款注释）
        if (process.platform === 'win32' && child.pid) {
          try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* ignore */ }
        }
      }, { once: true });
    }

    child.stdin.on('error', () => {}); // 进程提前退出时 stdin 可能报 EPIPE，忽略
    child.stdin.end(task);
  });
}
