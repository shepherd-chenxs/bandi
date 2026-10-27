import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { dataDir, repoRoot } from './config.mjs';

/**
 * 连接器（connector）——「外面来的能力」在班底里的登记与接线。
 *
 * 为什么叫连接器、不叫插件：**市场来的能力不进班底进程**。
 * 班底只做两件事：
 *   ① 登记：它从哪来、要什么凭据、给哪些运行时用（这就是"账本"）
 *   ② 接线：把这条登记翻译成每个 agent CLI 能吃的启动参数
 * 代码在它自己的进程里跑，班底既不 import 它、也不监督它 —— 隔离是白捡的。
 * 代价：能力边界取决于 CLI 支持什么（下面 `codexArgs` / `writeDshPatch` 的不对称就是这代价）。
 *
 * 现在只有一种 kind：`mcp`（stdio / streamable-http）。
 * 以后要加别的 kind（比如 codex / dsh 自己的插件包），在这里加一个 resolve 分支，
 * 存储形状和账本格式都不用动。
 */

/** 现在支持的 kind。写在这儿是为了界面能照着列"能装什么" */
export const KINDS = [
  { id: 'mcp', label: 'MCP server', note: '给数字员工接一个外部工具服务器（本地进程或远端 HTTP）' },
];

/**
 * id 规则：dsh 的 serverName 要求 [A-Za-z0-9_-]{1,32}，codex 更宽松 —— 取交集，
 * 这样同一个 id 两个运行时都能用，不会出现"codex 能用、dsh 装不上"。
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,32}$/;
export function isValidId(id) {
  return SAFE_ID.test(String(id ?? ''));
}

/** 账本路径。测试用 BANDI_CONNECTORS 指到临时文件，绝不碰真实账本 */
const bookFile = () => process.env.BANDI_CONNECTORS ?? path.join(dataDir, 'connectors.json');

/** 生成的 dsh 覆盖层放这儿（内容寻址，不是用户数据，可以随时删） */
const patchDir = () => process.env.BANDI_CONNECTORS_DIR ?? path.join(dataDir, 'connectors');

/* ------------------------------------------------------------------ 读写 */

function readSaved() {
  try {
    const obj = JSON.parse(fs.readFileSync(bookFile(), 'utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}

function writeSaved(obj) {
  const f = bookFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(obj, null, 2), 'utf8');
}

/** 只要 string/number/boolean 的值；其它类型一律当没写 */
function stringMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[String(k)] = String(v);
  }
  return out;
}

/** 值写成 `env:名字` 表示"引用环境变量"，不是字面量。凭据该走这条 */
const REF = /^env:([A-Za-z_][A-Za-z0-9_]*)$/;
const isRef = (v) => REF.test(String(v ?? ''));
const refName = (v) => REF.exec(String(v))[1];

/** 疑似密钥的键名：字面量写在这儿是要提醒的（见 warnings） */
const SECRET_KEY = /(TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL)/i;

/* -------------------------------------------------------------- 规范化 */

function normalize(id, raw = {}) {
  const transport = raw.transport === 'streamable-http' ? 'streamable-http' : 'stdio';
  const source = raw.source && typeof raw.source === 'object' ? raw.source : {};
  return {
    id,
    kind: 'mcp',
    label: String(raw.label ?? '').trim() || id,
    enabled: raw.enabled !== false,
    source: { kind: String(source.kind ?? 'local'), ref: String(source.ref ?? '') },
    transport,
    command: transport === 'stdio' ? String(raw.command ?? '').trim() : '',
    args: Array.isArray(raw.args) ? raw.args.map(String) : [],
    env: stringMap(raw.env),
    cwd: raw.cwd ? String(raw.cwd) : '',
    url: transport === 'streamable-http' ? String(raw.url ?? '').trim() : '',
    headers: transport === 'streamable-http' ? stringMap(raw.headers) : {},
    bearerTokenEnv: raw.bearerTokenEnv ? String(raw.bearerTokenEnv) : '',
    runtimes: Array.isArray(raw.runtimes) ? raw.runtimes.map(String).filter(Boolean) : [],
    failOnStartup: raw.failOnStartup === true,
    note: String(raw.note ?? ''),
    /* 内置（2026-10-26）：出厂自带的连接器 —— 不进推荐清单、卸不掉（403）。
       走 normalize 是为了 saveEntry 合并时把标记保住（current 里带着就丢不了）。 */
    builtin: raw.builtin === true,
  };
}

/** 校验。返回错误文字（给用户看的一句话），通过则返回 null */
export function validate(entry) {
  if (!isValidId(entry.id)) {
    return '名字只能用字母、数字、下划线、连字符，1–32 位（起点不好看但这是两个 CLI 的交集）';
  }
  if (entry.transport === 'stdio') {
    if (!entry.command) return 'stdio 类型要填「可执行文件」（比如 node / npx / 某个 exe 的绝对路径）';
  } else {
    if (!entry.url) return 'streamable-http 类型要填端点 URL';
    if (!/^https?:\/\//.test(entry.url)) return 'URL 要以 http:// 或 https:// 开头';
  }
  return null;
}

/** 不拦人、但要说出来的事。装之前给用户看 */
export function warnings(entry) {
  const out = [];
  for (const [k, v] of Object.entries({ ...entry.env, ...entry.headers })) {
    if (SECRET_KEY.test(k) && !isRef(v)) {
      out.push(`${k} 看着像密钥，但是字面量：会写进生成的文件（codex 还会进命令行）。建议写成 env:环境变量名`);
    }
  }
  if (entry.transport === 'stdio' && isRef(entry.env?.PATH ?? '')) {
    out.push('PATH 不支持引用，别把整份环境抄进来');
  }
  return out;
}

/* ------------------------------------------------------------------ 账本 */

export function list() {
  const saved = readSaved();
  return Object.entries(saved)
    .filter(([id]) => isValidId(id))
    .map(([id, raw]) => normalize(id, raw))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function get(id) {
  return list().find((e) => e.id === id) ?? null;
}

/** 新增或改一条。返回 { connector } 或 { error, warnings } */
export function saveEntry(id, patch = {}) {
  if (!isValidId(id)) return { error: '名字只能用字母、数字、下划线、连字符，1–32 位' };

  const current = get(id);
  const merged = normalize(id, { ...(current ?? {}), ...patch, id });
  const err = validate(merged);
  if (err) return { error: err };

  const saved = readSaved();
  saved[id] = merged;
  writeSaved(saved);
  return { connector: merged, warnings: warnings(merged) };
}

export function setEnabled(id, enabled) {
  const current = get(id);
  if (!current) return { error: '没有这条连接器' };
  return saveEntry(id, { enabled: !!enabled });
}

export function removeEntry(id) {
  const saved = readSaved();
  if (!(id in saved)) return { removed: false };
  if (saved[id]?.builtin === true) {
    return { error: 'builtin', message: '内置连接器不能卸载（随「工作台 → 研发 → 远程连接」出厂自带）' };
  }
  delete saved[id];
  writeSaved(saved);
  return { removed: true };
}

/** 给界面看的形状：只给 env/headers 的**键**和它是字面量还是引用，不回吐值 */
export function publicList() {
  return list().map((e) => ({
    id: e.id,
    kind: e.kind,
    label: e.label,
    enabled: e.enabled,
    source: e.source,
    transport: e.transport,
    command: e.command,
    args: e.args,
    cwd: e.cwd,
    url: e.url,
    env: Object.entries(e.env).map(([k, v]) => ({ key: k, kind: isRef(v) ? 'ref' : 'literal' })),
    headers: Object.entries(e.headers).map(([k, v]) => ({ key: k, kind: isRef(v) ? 'ref' : 'literal' })),
    bearerTokenEnv: e.bearerTokenEnv,
    runtimes: e.runtimes,
    failOnStartup: e.failOnStartup,
    builtin: !!e.builtin,
    warnings: warnings(e),
  }));
}

/* -------------------------------------------------------- 怎么起这个进程 */

/* ---------------------------------------------------------------- 内置 */

/**
 * 内置连接器（2026-10-26）：随「工作台 → 研发 → 远程连接」出厂自带，**不进推荐清单**。
 *
 * 为什么内置：SSH 工具（列登记 / 取公钥 / 执行命令）和登记页面是一体的 ——
 * 登记表就是 ~/.bandi/servers.yaml，工具读的也是它。拆成"可装的扩展"只会
 * 出现"页面在、工具没装"（清单条目没人装）这种半吊子状态。
 *
 * 口径镜像内置员工（secretary.ensureSecretary）：启动时幂等 seed ——
 * 没有就落一条，有了只补 `builtin: true` 标记，**不改用户改过的其它字段**。
 * 卸载在 removeEntry / DELETE 路由两道闸拦死（403）。
 */
const BUILTIN_CONNECTORS = [
  {
    id: 'ssh',
    /*
     * `builtin: true` 必须写在定义里，不能只靠下面 ensure 的"补标记"分支兜
     * （2026-10-26 实踩）：全新数据目录第一次启动时走的是 `!cur` 那一支，
     * normalize 只看 def 有没有带这个字段 —— 没带就落到 false，于是 SSH 会以
     * "个人连接器"的身份出现在「设置 → 插件 → 个人 → 本机来源」里，
     * 要等**第二次**启动才被补成内置（用户真库因为重启过多次所以看不出来）。
     */
    builtin: true,
    label: '远程连接（SSH）',
    source: { kind: 'local', ref: 'apps/server/mcp/bandi-ssh.mjs' },
    transport: 'stdio',
    command: 'node',
    args: [path.join(repoRoot, 'apps', 'server', 'mcp', 'bandi-ssh.mjs')],
    enabled: true,
    note: '登记表默认只读；要让它自己登记/删除机器，给班底进程加环境变量 BANDI_SSH_ALLOW_WRITE=1。执行默认开着，BANDI_SSH_ALLOW_EXEC=0 可关。',
  },
];

/** 启动时调一次。返回这次动了哪些 id（幂等：都齐了就返回空数组） */
export function ensureBuiltinConnectors() {
  const saved = readSaved();
  const touched = [];
  for (const def of BUILTIN_CONNECTORS) {
    const cur = saved[def.id];
    if (!cur || typeof cur !== 'object') {
      const merged = normalize(def.id, def);
      const err = validate(merged);
      if (err) {
        // 定义是自己写的，写错了是我们的事 —— 说出来但别拦启动
        console.log(`内置连接器 ${def.id} 定义有问题（不影响启动）：${err}`);
        continue;
      }
      // 双保险：定义里忘写 builtin 也照样落成内置（首次启动就该是对的，别指望下一次）
      saved[def.id] = { ...merged, builtin: true };
      touched.push(def.id);
    } else if (cur.builtin !== true) {
      saved[def.id] = { ...cur, builtin: true };
      touched.push(def.id);
    }
  }
  if (touched.length) writeSaved(saved);
  return touched;
}

/**
 * Windows 上 `npx` / `npm` 是 .cmd 垫片：直接起会 ENOENT —— Node 和 CLI 的 MCP 客户端
 * 都不会自己解析 PATHEXT（实测：spawn npx → ENOENT；cmd /c npx → 270ms 起来）。
 * 所以统一在这一处补一层 cmd /c，codex、dsh、实探三条路都走它，不各写一遍。
 *
 * 绝对路径的 .exe 不动 —— 那条是实测最稳的形态。
 */
function launcher(entry) {
  const cmd = entry.command;
  if (process.platform !== 'win32') return { command: cmd, args: entry.args };
  const shell = process.env.ComSpec || 'cmd.exe';
  const ext = path.extname(cmd).toLowerCase();
  if (path.isAbsolute(cmd) && (ext === '.exe' || ext === '.com')) return { command: cmd, args: entry.args };
  return { command: shell, args: ['/c', cmd, ...entry.args] };
}

/* ------------------------------------------------------------ 接线：codex */

/** TOML 字符串：反斜杠要翻倍，否则 Windows 路径会被 TOML 吃掉（与 codex.mjs 同一套写法） */
const tomlString = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

/**
 * codex：一切走 `-c key=value`（它本来就是这么收 writable_roots 的）。
 * 两处不对称，都记进 notes，不假装支持：
 *   · `env` 里 `env:NAME` 这种引用 **没法表达** —— TOML 里没有表达式，硬要支持就得把密钥内联进命令行，
 *     那是拿密钥换功能，不干。等下一步写 CODEX_HOME 的 profile 文件再补。
 *   · `cwd` / `headers` codex 的 MCP 配置不吃。
 */
function codexArgs(entries, notes) {
  const args = [];
  for (const e of entries) {
    const base = `mcp_servers.${e.id}`;
    if (e.transport === 'stdio') {
      const l = launcher(e);
      args.push('-c', `${base}.command=${tomlString(l.command)}`);
      if (l.args.length) args.push('-c', `${base}.args=[${l.args.map(tomlString).join(',')}]`);
      const literal = {};
      const dropped = [];
      for (const [k, v] of Object.entries(e.env)) {
        if (isRef(v)) dropped.push(k);
        else literal[k] = v;
      }
      if (Object.keys(literal).length) {
        args.push(
          '-c',
          `${base}.env={${Object.entries(literal).map(([k, v]) => `${tomlString(k)}=${tomlString(v)}`).join(',')}}`,
        );
      }
      if (dropped.length) {
        notes.push(`${e.id}：codex 不支持环境变量引用（${dropped.join('、')}），这层没接；dsh 那边有`);
      }
      if (e.cwd) notes.push(`${e.id}：codex 的 MCP 配置不吃 cwd，已跳过；dsh 那边有`);
    } else {
      args.push('-c', `${base}.url=${tomlString(e.url)}`);
      if (e.bearerTokenEnv) args.push('-c', `${base}.bearer_token_env_var=${tomlString(e.bearerTokenEnv)}`);
      if (Object.keys(e.headers).length) {
        notes.push(`${e.id}：codex 的 MCP 配置没有 headers，已跳过（用 bearerTokenEnv 或 dsh 那边配）`);
      }
    }
  }
  return args;
}

/* -------------------------------------------------------------- 接线：dsh */

const yamlScalar = (v) =>
  typeof v === 'boolean' || typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;

/** 引用写成 `!!js process.env.NAME` —— 密钥不进文件，与官方 mcp-bundle 模板同一写法 */
const yamlValue = (v) => (isRef(v) ? `!!js process.env.${refName(v)}` : yamlScalar(v));

function renderDshPatch(entries) {
  const lines = [
    '# 由班底生成（apps/server/src/connectors.mjs）—— 别手改，改 data/connectors.json。',
    '# 每次运行用 dsh --patch <本文件> 叠加在 headless profile 之上。',
    '- insert:',
  ];
  for (const e of entries) {
    lines.push(`    - id: mcp-${e.id}`);
    lines.push("      name: '@deepseek-ai/dsh-mcp-client'");
    lines.push('      config:');
    lines.push(`        serverName: ${yamlScalar(e.id)}`);
    lines.push(`        transport: ${yamlScalar(e.transport)}`);
    if (e.transport === 'stdio') {
      const l = launcher(e);
      lines.push(`        command: ${yamlScalar(l.command)}`);
      if (l.args.length) lines.push(`        args: [${l.args.map(yamlScalar).join(', ')}]`);
      if (e.cwd) lines.push(`        cwd: ${yamlScalar(e.cwd)}`);
      const keys = Object.keys(e.env);
      if (keys.length) {
        lines.push('        env:');
        for (const k of keys) lines.push(`          ${yamlScalar(k)}: ${yamlValue(e.env[k])}`);
      }
    } else {
      lines.push(`        url: ${yamlScalar(e.url)}`);
      const keys = Object.keys(e.headers);
      if (keys.length) {
        lines.push('        headers:');
        for (const k of keys) lines.push(`          ${yamlScalar(k)}: ${yamlValue(e.headers[k])}`);
      }
    }
    if (e.failOnStartup) lines.push('        failOnStartupError: true');
  }
  return lines.join('\n') + '\n';
}

/** 内容寻址：同一份配置只写一个文件，运行期不会互相踩；不做清理（几百字节，留着便于排查） */
function writeDshPatch(entries) {
  const yml = renderDshPatch(entries);
  const hash = crypto.createHash('sha1').update(yml).digest('hex').slice(0, 12);
  const dir = patchDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `dsh-mcp-${hash}.patch.yml`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, yml, 'utf8');
  return file;
}

/* ------------------------------------------------------------------ 实探 */

/**
 * 实探一条连接器：真把它拉起来，走一遍 MCP 握手，把工具名单拿回来。
 * 装完能不能用，点一下就知道 —— 跟运行时管理里的「探测版本」是同一个心思。
 *
 * 只做 stdio。http 那条要引第三方 MCP 客户端，先不做，如实报出来。
 */
export function probe(id, { timeoutMs = 20000 } = {}) {
  const e = get(id);
  if (!e) return Promise.resolve({ ok: false, error: '没有这条连接器' });
  if (e.transport !== 'stdio') {
    return Promise.resolve({ ok: false, error: '只探得了 stdio 类型；http 类型的探测还没做' });
  }

  // 引用型凭据：从**本进程**的环境解析（子进程也是这么继承的）。缺了直接说，别等它起不来
  const env = { ...process.env };
  const missing = [];
  for (const [k, v] of Object.entries(e.env)) {
    if (isRef(v)) {
      const name = refName(v);
      if (process.env[name] === undefined) missing.push(name);
      else env[k] = process.env[name];
    } else {
      env[k] = v;
    }
  }
  if (missing.length) return Promise.resolve({ ok: false, error: `缺环境变量：${missing.join('、')}` });

  return new Promise((resolve) => {
    let settled = false;
    let err = '';
    let buf = '';
    const l = launcher(e);
    const child = spawn(l.command, l.args, {
      cwd: e.cwd || undefined,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* 已经退了 */
      }
      resolve({ ...result, command: `${l.command} ${l.args.join(' ')}`.trim() });
    };

    const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
    const timer = setTimeout(() => done({ ok: false, error: `${timeoutMs / 1000}s 没握上手`, stderr: err.trim() }), timeoutMs);

    child.on('error', (e2) => done({ ok: false, error: `起不来：${e2.message}` }));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => (err += c));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1 && msg.result) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
        } else if (msg.id === 1 && msg.error) {
          done({ ok: false, error: `握手被拒：${msg.error.message}` });
        } else if (msg.id === 2) {
          const tools = (msg.result?.tools ?? []).map((t) => t.name);
          done({ ok: true, tools, serverInfo: msg.result?.serverInfo ?? null });
        }
      }
    });

    // 先看它自己报什么版本，我们就回什么版本
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bandi', version: '0.1.0' } },
    });
  });
}

/* ---------------------------------------------------------------- 对外接口 */

/** 这次能给某个协议族用的连接器（只看开关和 runtimes 过滤，不生成参数） */
export function activeFor(family) {
  return list().filter((e) => e.enabled && (!e.runtimes.length || e.runtimes.includes(family)));
}

/**
 * 首轮注入给模型的那几行。
 *
 * 为什么必须有一段提示词：codex 把外部工具放在 **tool_search 后面**，不在预置工具列表里 ——
 * 实测里模型会直接说"没有 echo 工具"。不告诉它去搜，"装上了"就只是账本上的一行。
 * dsh 那边工具是直接列出来的，命名是 mcp__<连接器>__<工具>，所以只提一句。
 */
export function promptLines(family) {
  const active = activeFor(family);
  if (!active.length) return [];
  const example = active[0].id;
  const how =
    family === 'codex'
      ? `要用它们时，先用 tool_search 按关键字搜（比如 \`${example}\`），找到再调用 —— 没搜到之前，不要说"没有这个工具"。`
      : '工具名形如 mcp__<连接器名>__<工具名>；参数照工具自己的定义填。';
  return [...active.map((e) => `- ${e.id}：${e.label}`), how];
}

/**
 * 给一次运行算出"要往 CLI 参数里加什么"。
 *
 * @param family 协议族（codex / claude / dsh）—— 按族算，因为同一族的多个实例共用一套命令行
 * @returns {{args:string[], files:string[], active:string[], notes:string[]}}
 *   失败不抛：接不上就记 notes，运行照跑（连接器坏了不该让人连话都说不了）
 */
export function resolve(family) {
  const out = { args: [], files: [], active: [], notes: [] };
  const entries = list().filter((e) => e.enabled && (!e.runtimes.length || e.runtimes.includes(family)));
  if (!entries.length) return out;

  out.active = entries.map((e) => e.id);

  // 引用型凭据要由**本进程**的环境提供（子进程继承它）。缺了的话 dsh 会整条激活失败，
  // 报的是 "invalid config" —— 在这儿先说清楚，别让人对着一条莫名的警告猜。
  for (const e of entries) {
    for (const [k, v] of Object.entries({ ...e.env, ...e.headers })) {
      if (isRef(v) && process.env[refName(v)] === undefined) {
        out.notes.push(`${e.id}：${k} 引用了环境变量 ${refName(v)}，但当前进程环境里没有它`);
      }
    }
  }

  try {
    if (family === 'codex') {
      out.args = codexArgs(entries, out.notes);
    } else if (family === 'dsh') {
      const file = writeDshPatch(entries);
      out.files = [file];
      out.args = ['--patch', file];
    } else {
      out.notes.push(`协议族 ${family} 还没接连接器，${entries.length} 条登记这次没生效`);
    }
  } catch (err) {
    out.args = [];
    out.files = [];
    out.notes.push(`连接器接线失败：${String(err?.message ?? err)}`);
  }
  return out;
}
