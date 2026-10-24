import { agentEnv } from './git-repos.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { dataDir, dshProfile, runCwd } from './config.mjs';

/* ------------------------------------------------ 账本 → 「这一次怎么走」的补丁层 */

/** 生成的覆盖层放这儿（内容寻址，不是用户数据，可以随时删） */
const routeDir = () => process.env.BANDI_ROUTES_DIR ?? path.join(dataDir, 'model-routes');

/** YAML 标量：直接借 JSON 的双引号形式 —— 它是合法 YAML，转义规则也够用 */
const yScalar = (s) => JSON.stringify(String(s));

/**
 * 把"这一步用哪个模型"渲染成 dsh 的补丁层。
 *
 * 为什么非得用 `--patch`：headless app **没有** `--model` 参数
 * （实测 `dsh --profile headless --help` 只有 `--json` / `--session-id`），
 * 模型只能从 profile 配置来；`--patch` 是官方给的"在 profile 之上再叠一层"
 * 的入口，正好干这个 —— 而且**不动用户自己的 profile 文件**。
 *
 * ⚠️ 只写 `agent-default-model` 这一条，**绝不写 `llm-pi-ai`**。
 * 原来这里还会往下压一段 `providers.<id>.baseURL / api / apiKey`，
 * 拿班底账本里的供应商去覆盖 dsh 自己的 profile。去掉了：地址和凭据是 dsh
 * （或 magpie 这类网关替它）维护的，班底压一份下去等于多出一处会打架的真相。
 *
 * ⚠️ `provider` 这一句**必须带**，但它不是班底的配置 —— 是把 CLI 自己写的那句
 * 原样读回来再写回去（见 cli-models.mjs 的 `cliProviderOf`）。
 * 原因是实测出来的：dsh 的补丁层**整块替换 `config`**，不是逐字段合并 ——
 * `dsh --profile headless --patch <只写 model 的文件> --dump-config` 打出来是
 *   config:
 *     model: workbuddy/hy3
 * 原本的 `provider: magpie` 直接没了。所以省略它不是"不改"，是**改坏了**。
 */
function renderRoutePatch({ model = null, provider = null } = {}) {
  if (!model) return null;
  const lines = ['- id: agent-default-model', '  config:'];
  if (provider) lines.push(`    provider: ${yScalar(provider)}`);
  lines.push(`    model: ${yScalar(model)}`);
  return lines.join('\n') + '\n';
}

/**
 * 把覆盖层落成一个文件，返回路径（没东西可覆盖就返回 null）。
 *
 * **导出**是为了能被验证：`dsh --profile headless --patch <文件> --dump-config`
 * 会把合成后的配置整棵树打出来 —— 于是"这一层到底改到了哪"可以在**不真跑**的情况下看死。
 */
export function writeRoutePatch({ model = null, provider = null } = {}) {
  const yml = renderRoutePatch({ model, provider });
  if (!yml) return null;
  const hash = crypto.createHash('sha1').update(yml).digest('hex').slice(0, 12);
  const dir = routeDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `dsh-route-${hash}.patch.yml`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, yml, 'utf8');
  return file;
}

/**
 * 解析启动方式。
 *
 * `dsh.cmd` 干的事其实只有一件：
 *   set ELECTRON_RUN_AS_NODE=1
 *   "<install>\DeepSeek Harness.exe" --expose-internals
 *     "<resources>\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" %*
 *
 * 我们照做，但**直接起 exe ＋ 参数数组**，不过 shell。
 * 理由：Windows 上 .cmd 只能经 cmd.exe，而带空格的路径在 cmd 的引号规则里
 * 怎么拼都不稳（实测报 `'D:\AppData\Local\Programs\DeepSeek' 不是内部或外部命令`）。
 * 参数数组没有这个问题，而且子进程能被干净地杀掉。
 */
function resolveLauncher(cmdPath) {
  const resourcesDir = path.resolve(path.dirname(cmdPath), '..', '..', '..');
  const exe = path.join(path.resolve(resourcesDir, '..'), 'DeepSeek Harness.exe');
  const cliJs = path.join(
    resourcesDir,
    'app.asar',
    'dsh',
    'node_modules',
    '@deepseek-ai',
    'dsh-desktop-host',
    'lib',
    'cli.js',
  );
  if (fs.existsSync(exe)) {
    return { kind: 'electron', file: exe, prefix: ['--expose-internals', cliJs], env: { ELECTRON_RUN_AS_NODE: '1' } };
  }
  // 兜底：直接起 .cmd（调用方需确保路径不含空格）
  return { kind: 'cmd', file: cmdPath, prefix: [], env: {} };
}

/**
 * dsh 的启动器位置。
 *
 * ⚠️ **这里故意不再有字面量默认值**：原来写的是开发那台机器的桌面包路径，
 * 换台机器就是死路径，而且会被当兜底悄悄用起来（存进运行时、拿去 spawn）。
 * 没有路径就明确报错，由运行时记录负责给。开发时想指定就设 `BANDI_DSH_CLI`。
 */
export const DEFAULT_PATH = process.env.BANDI_DSH_CLI ?? '';

/**
 * 这个路径 bandi 能不能真的起得来。
 *
 * 为什么非得单独判一下：`resolveLauncher` 对**非桌面包布局**会退化成"直接 spawn 那个 .cmd"，
 * 而 Node 22 起 spawn 一个 `.cmd`（不挂 shell）**当场抛 EINVAL** —— 实测：
 *   spawn('D:\\...\\node_global\\dsh.cmd') → Error: spawn EINVAL
 * 所以"文件在"不等于"能用"：npm 装的 dsh shim 属于"装了但班底起不来"那一类。
 * 探测时必须把这种路径排除（或至少标出来），否则用户选了它，派活必挂。
 */
export function isLaunchable(cmdPath) {
  try {
    return resolveLauncher(cmdPath).kind === 'electron';
  } catch {
    return false;
  }
}

/** 「怎么启动这个 CLI」——探测版本和真跑都走这里 */
export function launchCommand(pathOverride) {
  const p = pathOverride || DEFAULT_PATH;
  if (!p) throw new Error('没有可执行路径 —— 去「设置 → 运行时」识别并接入一个');
  const l = resolveLauncher(p);
  return { file: l.file, args: l.prefix, env: l.env };
}

/** 跑一次 `--version`，用来在运行时管理页验路径是否有效 */
export function probe(pathOverride) {
  const p = pathOverride || DEFAULT_PATH;
  if (!p) return Promise.resolve({ ok: false, error: '没有可执行路径' });
  if (!fs.existsSync(p)) return Promise.resolve({ ok: false, error: `找不到这个文件：${p}` });
  return new Promise((resolve) => {
    let l;
    let child;
    try {
      l = launchCommand(pathOverride);
      child = spawn(l.file, [...l.args, '--version'], {
        windowsHide: true,
        env: { ...agentEnv(), ...l.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      /*
       * ⚠️ spawn 会在**同步阶段**抛（不是 error 事件）：Node 22 起 spawn 一个
       * `.cmd`（不挂 shell）直接是 `EINVAL`。而 `new Promise` 的 executor 里抛异常
       * = promise 变 reject → 调用方 await 到异常 → 整个 HTTP 请求 500。
       * 「文件在、但班底起不来」恰恰是这里最该说清楚的一种情况，不能让它变成 500。
       */
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

/**
 * 跑一次 dsh headless。
 *
 * - 任务文本走 **stdin**，命令行上永远不出现用户输入
 * - stdout 是按行 JSON（官方契约），逐行解析并回调
 * - 不传 sessionId 就是新会话；`session` 事件会告知分配到的 id
 */
export function runDsh({
  task,
  sessionId = null,
  cwd = runCwd,
  cliPath = null,
  connectorArgs = [],
  model = null,
  provider = null,
  env = {},
  onEvent = () => {},
  signal = null,
}) {
  return new Promise((resolve, reject) => {
    const args = ['--profile', dshProfile];
    // 覆盖层要排在 app 参数（--json 等）之前：`--patch` 是 dsh **自己**的选项，
    // 排在 app 参数之后的会被当成 app 的参数。
    const patches = [...connectorArgs];
    const routePatch = writeRoutePatch({ model, provider });
    if (routePatch) patches.push('--patch', routePatch);
    const routeNote = routePatch ? path.basename(routePatch) : null;
    if (patches.length) args.push(...patches);
    args.push('--json');
    if (sessionId) args.push('--session-id', sessionId);
    args.push('-'); // 唯一的 stdin 标记：任务从管道读

    const l = launchCommand(cliPath);
    const child = spawn(l.file, [...l.args, ...args], {
      cwd,
      windowsHide: true,
      env: { ...agentEnv(), ...l.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (routeNote) console.log(`[模型] dsh 这一步用覆盖层 ${routeNote}`);

    let buf = '';
    const events = [];
    let finalText = '';
    let resolvedSessionId = sessionId;
    let usage = null;
    let turnReason = null;
    let stderr = '';

    const handle = (line) => {
      const s = line.trim();
      if (!s) return;
      let evt;
      try {
        evt = JSON.parse(s);
      } catch {
        return; // 非 JSON 行不属于事件流
      }
      events.push(evt);
      if (evt.type === 'session') resolvedSessionId = evt.sessionId;
      else if (evt.type === 'final') finalText = evt.text ?? '';
      else if (evt.type === 'status' && evt.phase === 'step_end' && evt.usage) usage = evt.usage;
      else if (evt.type === 'status' && evt.phase === 'turn_end') turnReason = evt.reason ?? null;
      onEvent(evt);
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
      resolve({ sessionId: resolvedSessionId, finalText, exitCode: code, events, usage, turnReason, stderr });
    });

    if (signal) {
      signal.addEventListener('abort', () => {
        try { child.kill(); } catch { /* ignore */ }
        // 只杀直接子进程不够：CLI 自己起的命令子进程（powershell/cmd/构建脚本）活着的话
        // 会占着 stdout 管道的写端，这边的 'close' 永远不来（2026-10-23 实报，会话被
        // "他还在跑上一条"闸死）。Windows 上用 taskkill /T 连树一起拔。
        if (process.platform === 'win32' && child.pid) {
          try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* ignore */ }
        }
      }, { once: true });
    }

    child.stdin.end(task);
  });
}

export { launchCommand as dshLauncher };
