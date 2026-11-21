import { agentEnv } from './git-repos.mjs';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { runCwd } from './config.mjs';
import { killProcessTree, logCleanup } from './process-tree.mjs';

export const runtimeName = 'codex';

/**
 * Codex 的 npm shim 是 `codex.cmd`，Windows 上过 shell 有引号坑。
 * 但 shim 干的事很简单：`node <node_global>\node_modules\@openai\codex\bin\codex.js %*`。
 * 所以直接起 node ＋ 参数数组，不过 shell。
 *
 * ⚠️ **这里故意不再有字面量默认值**：原来写的是开发那台机器的 node_global 布局，
 * 换台机器就是死路径，而且会被当兜底悄悄用起来（存进运行时、拿去 spawn）。
 * 没有路径就明确报错，由运行时记录负责给。开发时想指定就设 `BANDI_CODEX_JS`。
 */
export const DEFAULT_PATH = process.env.BANDI_CODEX_JS ?? '';

/**
 * 「怎么启动这个 CLI」——探测版本和真跑都走这里，只有一份真相。
 * @returns {{file:string, args:string[], env:object}}
 */
export function launchCommand(pathOverride) {
  const p = pathOverride || DEFAULT_PATH;
  if (!p) throw new Error('没有可执行路径 —— 去「设置 → 运行时」识别并接入一个');
  return { file: process.execPath, args: [p], env: {} };
}

/** 跑一次 `--version`，用来在运行时管理页验路径是否有效 */
export function probe(pathOverride) {
  const p = pathOverride || DEFAULT_PATH;
  if (!p) return Promise.resolve({ ok: false, error: '没有可执行路径' });
  if (!fs.existsSync(p)) return Promise.resolve({ ok: false, error: `找不到这个文件：${p}` });
  return probeCommand(launchCommand(p));
}

function probeCommand({ file, args, env }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, [...args, '--version'], {
        windowsHide: true,
        env: { ...agentEnv(), ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      // 同 dsh.mjs：spawn 会同步抛，在 Promise executor 里抛就是 reject → HTTP 500
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

/** TOML 字符串转义：反斜杠要翻倍，否则 Windows 路径会被 TOML 吃掉 */
const tomlString = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

/**
 * 拼参数。注意一个实测出来的不对称：
 * - `codex exec` 收 `-C <dir>`（工作根）与 `-s <sandbox>`（沙箱策略），还有 `--add-dir`
 * - `codex exec resume <id>` **不收** `-C` / `-s` / `--add-dir`，只收 `--json` / `-m` / `-c`
 *
 * 所以"多个工作根"不能用 `--add-dir`（resume 上不存在），而要用配置键
 * `sandbox_workspace_write.writable_roots` —— `-c` 在 exec 与 resume 两边都收。
 *
 * ⚠️ **沙箱也一样**：resume 不收 `-s`，所以恢复会话那一轮必须用
 * `-c sandbox_mode=…` 传 —— 否则从第二轮起沙箱就退回 codex 的默认值，
 * 界面上改权限"没生效、必须重开会话"就是这么来的（用户实测踩到过）。
 * 工作根不用补：resume 会按会话里记录的 cwd 走。
 */
/**
 * 模型只传一个 `-m`，**不下发供应商**。
 *
 * 原来这里有一整套 `-c model_providers.<id>.base_url / wire_api / experimental_bearer_token`，
 * 拿班底账本里的供应商去覆盖 codex 的 `~/.codex/config.toml`。去掉了，理由：
 *   · 地址和凭据是 codex 自己的配置，而且 magpie 这类网关本来就在替用户维护它；
 *     班底再下发一份，同一件事就有两处真相，还会把用户在别处配好的悄悄顶掉。
 *   · `-c` 是增量覆盖，看着无害 —— 但"无害"的前提是班底那份更新得更勤，实际正相反。
 * 于是班底只管**选哪个模型**，走哪条路由完全交给 codex 自己的配置。
 */
export function buildArgs({ sessionId, cwd, sandbox, model, roots, connectorArgs = [] }) {
  const args = sessionId
    ? ['exec', 'resume', sessionId, '--json']
    : ['exec', '--json', '-C', cwd, '-s', sandbox];

  // 权限在两边都要传得上（resume 只能用 -c 这一种写法）
  if (sessionId && sandbox) args.push('-c', `sandbox_mode=${tomlString(sandbox)}`);

  if (roots?.length) {
    args.push('-c', `sandbox_workspace_write.writable_roots=[${roots.map(tomlString).join(',')}]`);
  }
  // 只传模型名；走哪条路由由 codex 自己的 config.toml 决定
  if (model) args.push('-m', model);
  // 连接器（MCP 等）由 connectors.mjs 算成 `-c mcp_servers.*`，这里只负责放进命令行
  if (connectorArgs.length) args.push(...connectorArgs);
  // Codex 默认拒绝在非 git 目录里跑，而且失败时**静默**只给空回答。
  // 工作目录是用户显式选的，这里不替他把关，免得拿到一片空白还不知道为什么。
  args.push('--skip-git-repo-check');
  args.push('-'); // 提示词从 stdin 读，命令行上不出现用户输入
  return args;
}

function mapUsage(u) {
  if (!u) return null;
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
    cacheReadTokens: u.cached_input_tokens ?? 0,
    reasoningTokens: u.reasoning_output_tokens ?? 0,
  };
}

/** 把 Codex 的事件词汇翻译成平台统一的词汇（与 dsh 适配器一致） */
export function normalize(evt) {
  switch (evt.type) {
    case 'thread.started':
      return { type: 'session', sessionId: evt.thread_id };
    case 'turn.started':
      return { type: 'status', phase: 'turn_start' };
    case 'turn.completed':
      return {
        type: 'status',
        phase: 'turn_end',
        reason: { kind: 'completed' },
        usage: mapUsage(evt.usage),
      };
    case 'turn.failed':
      return { type: 'error', message: evt.error?.message ?? 'turn failed' };
    case 'item.completed': {
      const it = evt.item ?? {};
      if (it.type === 'reasoning') return { type: 'thinking', text: it.text ?? '' };
      if (it.type === 'agent_message') return { type: 'text', text: it.text ?? '' };
      // 命令执行、文件改动、MCP 调用…统一当"工具动作"，UI 先按通用条目显示
      return { type: 'tool', name: it.type ?? 'item', detail: it };
    }
    case 'error':
      return { type: 'error', message: evt.message ?? String(evt.error ?? 'error') };
    default:
      return { type: 'raw', event: evt };
  }
}

/**
 * 「按进程名全量清杀」的典型写法（2026-11-20）。
 * 只认"按名字"的那几种，针对具体 PID 的 Stop-Process 不算（那是允许的清理方式）。
 */
const SELF_KILL_RE = /Get-Process\s+node[^\n]*Stop-Process|taskkill[^\n]*\/IM\s+node|killall\s+node|pkill[^\n]*\bnode\b/i;

/**
 * 跑一次 Codex，契约与 dsh 适配器一致：
 * 任务走 stdin，stdout 按行 JSON，回调统一词汇的事件。
 *
 * @returns {Promise<{sessionId:string|null, finalText:string, exitCode:number|null,
 *                    events:object[], usage:object|null, turnReason:object|null, stderr:string,
 *                    cleanup?:{ok:boolean,killed:number[],method:string}}>}
 */
export function runTask({
  task,
  sessionId = null,
  cwd = runCwd,
  roots = [],
  sandbox = 'danger-full-access',
  model = null,
  cliPath = null,
  connectorArgs = [],
  env = {},
  onEvent = () => {},
  signal = null,
}) {
  return new Promise((resolve, reject) => {
    const args = buildArgs({ sessionId, cwd, sandbox, model, roots, connectorArgs });
    const launch = launchCommand(cliPath);

    const child = spawn(launch.file, [...launch.args, ...args], {
      cwd,
      windowsHide: true,
      env: { ...agentEnv(), ...launch.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let buf = '';
    const events = [];
    const normalized = [];
    let finalText = '';
    let resolvedSessionId = sessionId;
    let usage = null;
    let turnReason = null;
    let stderr = '';
    /** 最后一条命令的原文（失败归因用：见 settle 里的 selfKilled） */
    let lastCommand = '';

    let settled = false;
    let cleanup = null;
    const settle = (code, { clean = false } = {}) => {
      if (settled) return;
      settled = true;
      /*
       * **自杀归因**（2026-11-20 用户实报）：研发员工为了"清理残留 node 进程"跑了
       * `Get-Process node | Stop-Process -Force`，把 codex（本身就是 node 起的）一起杀了，
       * 三轮都以退出码 -1（4294967295）结束，界面只剩一句天书，人和 agent 都只能往网络 /
       * 模型上猜。这里直接说破原因，写进 res.error，卡片上读的就是这句话。
       */
      const selfKilled = (code === -1 || code === 4294967295) && SELF_KILL_RE.test(lastCommand);
      const done = () => resolve({
        sessionId: resolvedSessionId,
        finalText,
        exitCode: code,
        events: normalized,
        rawEvents: events,
        usage,
        turnReason,
        stderr,
        cleanup,
        ...(selfKilled
          ? {
              error: {
                message: `这一轮是被自己的清理命令杀掉的：${lastCommand.slice(0, 140)} —— codex 本身就是 node 起的，按进程名全杀会把运行时一起终止。测试像卡住时先看超时和 tmp/smoke-fail-*.log，别清进程。`,
              },
            }
          : {}),
      });
      /*
       * 失败收尾先收进程树（2026-11-20 用户实报："子进程在跑，然后告诉我任务失败了"）：
       * codex 失败时它起的命令子进程可能还活着 —— 不清理，重跑就会和残留进程打架。
       * 成功（turn.completed）不清理：CLI 还要落盘会话文件，杀了会毁掉 --resume。
       */
      if (!clean || !child.pid) return done();
      killProcessTree(child.pid).then((r) => {
        cleanup = r;
        logCleanup('codex', r);
        done();
      });
    };

    const handle = (line) => {
      const s = line.trim();
      if (!s) return;
      let raw;
      try {
        raw = JSON.parse(s);
      } catch {
        return;
      }
      events.push(raw);

      // 记下最后一条命令（失败归因用）：codex 的 item.command 可能是字符串，也可能是 argv 数组
      const cmd = raw?.item?.command;
      if (cmd) lastCommand = Array.isArray(cmd) ? cmd.join(' ') : String(cmd);

      const evt = normalize(raw);
      if (evt.type === 'session') resolvedSessionId = evt.sessionId;
      else if (evt.type === 'text') finalText = evt.text;
      else if (evt.type === 'status' && evt.phase === 'turn_end') {
        turnReason = evt.reason ?? null;
        if (evt.usage) usage = evt.usage;
      }
      normalized.push(evt);
      onEvent(evt);

      // 实测：Codex 在 turn.completed 之后还会赖活约 10 秒（turn_end 2.96s → 进程退出 13.02s）。
      // 这一轮在 turn 结束时就真的结束了，界面不必陪着等。
      // 注意**不杀进程**：它可能还在落盘会话文件，杀了会毁掉 --resume。
      // 只是不再等它，让它在后台自己退干净。
      if (raw.type === 'turn.completed' || raw.type === 'turn.failed') {
        const failedTurn = raw.type === 'turn.failed';
        setImmediate(() => settle(failedTurn ? 1 : 0, { clean: failedTurn }));
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        handle(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => {
      stderr += c;
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (buf.trim()) handle(buf);
      settle(code, { clean: code !== 0 }); // 已经因 turn_end 收尾过的话，这里是空操作
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

    child.stdin.end(task);
  });
}
