#!/usr/bin/env node
/**
 * 班底 · 服务器与密钥（MCP server，stdio，零依赖）
 *
 * 它给数字员工的不是"打开 SSH 能力"——同事本来就能在自己 shell 里敲 ssh；
 * 它给的是**知道有哪些机器、每台用哪把钥匙、以及现成的动作**。
 *
 * 读写的是**同一份契约**：~/.bandi/servers.yaml（桌面端与 DSH 插件也读它）。
 * 所以三方共用一本账，不各记一套。
 *
 * 配置全部走环境变量（由连接器那条登记的 env 注入）：
 *   BANDI_SSH_REGISTRY    登记表路径，默认 ~/.bandi/servers.yaml
 *   BANDI_SSH_ALLOW_WRITE 登记/删除开关，默认关（"0"/"" 以外为开）
 *   BANDI_SSH_ALLOW_EXEC  执行/探测开关，默认开
 *   BANDI_SSH_BIN         ssh 可执行文件，默认挑系统 OpenSSH
 *   BANDI_SSH_TIMEOUT_MS  单次连接超时，默认 30000
 *   BANDI_SSH_STRICT      StrictHostKeyChecking，默认 accept-new
 *
 * 私钥永不进对话、不回显：这里只用 -i 把路径交给 ssh，读文件内容的地方只有 .pub。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { expandHome, REGISTRY_PATH as REGISTRY, readRegistry, validateHost, upsertServer, removeServer } from '../src/ssh-registry.mjs';
import { buildGuide } from '../src/ssh-exec.mjs';

/* ------------------------------------------------------------------ 配置 */

const ALLOW_WRITE = /^(1|true|yes|on)$/i.test(process.env.BANDI_SSH_ALLOW_WRITE ?? '');
const ALLOW_EXEC = (process.env.BANDI_SSH_ALLOW_EXEC ?? '1') !== '0';
const TIMEOUT_MS = Number(process.env.BANDI_SSH_TIMEOUT_MS) || 30000;
const STRICT = process.env.BANDI_SSH_STRICT || 'accept-new';

/** ssh 可执行文件：优先环境变量，其次系统 OpenSSH（Windows 上不在 PATH 也能到） */
function sshBin() {
  if (process.env.BANDI_SSH_BIN) return expandHome(process.env.BANDI_SSH_BIN);
  const win = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';
  return process.platform === 'win32' && fs.existsSync(win) ? win : 'ssh';
}

/* ------------------------------------------------------------------ SSH */

function findServer(alias) {
  const reg = readRegistry();
  const s = reg.servers.find((x) => x.alias === alias);
  if (!s) {
    const names = reg.servers.map((x) => x.alias).join('、') || '（一台都没有）';
    throw new Error(`登记表里没有「${alias}」。现有：${names}`);
  }
  return s;
}

export function publicKeyOf(entry) {
  const keyPath = expandHome(entry.key_path);
  for (const candidate of [`${keyPath}.pub`, keyPath]) {
    if (!fs.existsSync(candidate)) continue;
    const text = fs.readFileSync(candidate, 'utf8').trim();
    if (text.startsWith('ssh-') || text.startsWith('ecdsa-')) return text;
  }
  throw new Error(`找不到公钥文件：${keyPath}.pub`);
}

function requireExec() {
  if (!ALLOW_EXEC) throw new Error('执行被关掉了（BANDI_SSH_ALLOW_EXEC=0）');
}

/**
 * 真起一次 ssh。BatchMode=yes 很关键：没配好的话它**立刻失败**，而不是挂在口令提示上等超时。
 */
export function sshRun(entry, command, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const args = [
      '-i', expandHome(entry.key_path),
      '-p', String(entry.port || 22),
      '-o', 'BatchMode=yes',
      '-o', `StrictHostKeyChecking=${STRICT}`,
      '-o', `ConnectTimeout=${Math.max(3, Math.round(timeoutMs / 1000))}`,
      `${entry.user}@${entry.host}`,
      '--',
      command,
    ];
    const child = spawn(sshBin(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let done = false;
    const finish = (result) => { if (!done) { done = true; clearTimeout(timer); try { child.kill(); } catch { /* 已退 */ } resolve(result); } };
    const timer = setTimeout(() => finish({ ok: false, code: null, out, err, error: `${Math.round(timeoutMs / 1000)}s 没连上` }), timeoutMs + 5000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', (e) => finish({ ok: false, code: null, out, err, error: `起不来：${e.message}` }));
    child.on('close', (code) => {
      const text = (err + out).slice(0, 4000);
      finish({ ok: code === 0, code, out: out.trim(), err: err.trim(), error: code === 0 ? null : text || `ssh 退出码 ${code}` });
    });
  });
}

/* ------------------------------------------------------------- 工具实现 */

const TOOLS = [
  {
    name: 'servers_list',
    description: '列出登记表里的服务器（名称、账号@地址:端口、状态、密钥路径与指纹）。要连服务器前先看这个。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'server_public_key',
    description: '取某台服务器的公钥全文（读 ~/.ssh/<名称>.pub）。私钥不读、不回显。',
    inputSchema: { type: 'object', properties: { alias: { type: 'string', description: '登记表里的名称' } }, required: ['alias'], additionalProperties: false },
  },
  {
    name: 'ssh_guide',
    description: '生成「把公钥装到这台服务器」的可复制指引（账号与公钥已替换成真实值）。',
    inputSchema: { type: 'object', properties: { alias: { type: 'string' } }, required: ['alias'], additionalProperties: false },
  },
  {
    name: 'ssh_run',
    description: '在一台已登记的服务器上执行一条命令，返回 stdout/stderr 与退出码。命令跑在对方的 shell 里，请一次一条、可复核。',
    inputSchema: {
      type: 'object',
      properties: {
        alias: { type: 'string', description: '登记表里的名称' },
        command: { type: 'string', description: '要执行的命令（原样交给远端 shell）' },
        timeoutMs: { type: 'number', description: '超时毫秒，默认 30000' },
      },
      required: ['alias', 'command'],
      additionalProperties: false,
    },
  },
  {
    name: 'ssh_test',
    description: '连通性与身份探测：连上去跑 hostname / whoami / uname，确认钥匙和账号都对。',
    inputSchema: { type: 'object', properties: { alias: { type: 'string' } }, required: ['alias'], additionalProperties: false },
  },
  {
    name: 'server_upsert',
    description: '登记或修改一台服务器（写 ~/.bandi/servers.yaml，默认关闭写）。',
    inputSchema: {
      type: 'object',
      properties: {
        alias: { type: 'string', description: '名称，文件内唯一' },
        host: { type: 'string', description: 'IPv4 或域名，不带端口/协议头/路径' },
        port: { type: 'number', description: '1–65535，默认 22' },
        user: { type: 'string', description: '服务器登录用户名' },
        key_path: { type: 'string', description: '私钥路径，默认 ~/.ssh/<名称>' },
        purpose: { type: 'string', description: '备注：这台机器干什么用' },
      },
      required: ['alias', 'host', 'user'],
      additionalProperties: false,
    },
  },
  {
    name: 'server_remove',
    description: '从登记表里删掉一台服务器（只删这一行，不碰服务器、不删密钥文件）。默认关闭写。',
    inputSchema: { type: 'object', properties: { alias: { type: 'string' } }, required: ['alias'], additionalProperties: false },
  },
];

function view(s) {
  return {
    alias: s.alias,
    address: `${s.user}@${s.host}:${s.port}`,
    status: s.status || '',
    keyPath: s.key_path,
    keyFingerprint: s.key_fingerprint || '',
    hostFingerprintVerified: s.host_fingerprint_verified === true,
    lastChecked: s.last_checked || '',
    purpose: s.purpose || '',
  };
}

async function callTool(name, args = {}) {
  switch (name) {
    case 'servers_list': {
      const reg = readRegistry();
      if (!reg.servers.length) return `登记表是空的（${REGISTRY}）。先登记一台，或让用户用桌面端登记。`;
      return reg.servers
        .map((s) => {
          const v = view(s);
          return [
            `${v.alias}`,
            `  地址：${v.address}`,
            `  状态：${v.status || '（未记）'}${v.lastChecked ? `（最近核对 ${v.lastChecked}）` : ''}`,
            `  密钥：${v.keyPath}${v.keyFingerprint ? `\n  指纹：${v.keyFingerprint}` : ''}`,
            v.purpose ? `  备注：${v.purpose}` : '',
          ].filter(Boolean).join('\n');
        })
        .join('\n\n');
    }

    case 'server_public_key': {
      const s = findServer(String(args.alias ?? ''));
      return `${s.alias} 的公钥：\n${publicKeyOf(s)}`;
    }

    case 'ssh_guide': {
      const s = findServer(String(args.alias ?? ''));
      // **引导文案别再手写一份**：步骤在 src/ssh-exec.mjs 的 buildGuide 里，
      // 界面上那个"把公钥装到服务器"用的是同一份。这里原来自己抄了一套，
      // 结果同一处顺序错误存了两份（第 1 步写成 ssh 运维账号 —— 账号还没建，必然失败）。
      // 注意共享的只是**文案**：sshRun 两边仍旧各写各的（见两个文件顶部的定位说明）。
      return buildGuide(s, publicKeyOf(s));
    }

    case 'ssh_run': {
      requireExec();
      const s = findServer(String(args.alias ?? ''));
      const command = String(args.command ?? '').trim();
      if (!command) throw new Error('要跑什么命令？');
      const r = await sshRun(s, command, Number(args.timeoutMs) || TIMEOUT_MS);
      const head = r.ok ? `✅ ${s.alias} 上执行成功（退出码 0）` : `❌ ${s.alias} 执行失败`;
      return [head, `$ ${command}`, '', r.out || '（无输出）', r.err ? `\n[stderr]\n${r.err}` : '', r.error && !r.err ? `\n[错误] ${r.error}` : '']
        .filter((x) => x !== '')
        .join('\n');
    }

    case 'ssh_test': {
      requireExec();
      const s = findServer(String(args.alias ?? ''));
      const r = await sshRun(s, 'hostname; whoami; uname -a', TIMEOUT_MS);
      if (!r.ok) {
        return [
          `❌ 连不上 ${s.alias}（${s.user}@${s.host}:${s.port}）`,
          r.out ? `输出：\n${r.out}` : '',
          `错误：${r.error ?? r.err ?? '未知'}`,
          '',
          '常见原因：公钥没装到服务器 / 私钥路径不对 / 端口或安全组没开 / 首次连接的主机指纹没接受。',
          '先把公钥装上去：让我跑 ssh_guide 给你一份可复制的指引。',
        ].filter(Boolean).join('\n');
      }
      return `✅ ${s.alias} 连上了（${s.user}@${s.host}:${s.port}）\n\n${r.out}`;
    }

    case 'server_upsert': {
      if (!ALLOW_WRITE) throw new Error(`写操作默认关闭（改这条连接器的 env：BANDI_SSH_ALLOW_WRITE=1）。目标文件：${REGISTRY}`);
      // 校验与写入都在共享模块里 —— 界面那边的 HTTP 接口调的是同一份，规则不会走样
      const r = upsertServer(args);
      return `${r.created ? '已登记' : '已更新'}：${r.alias} → ${r.entry.user}@${r.entry.host}:${r.entry.port}\n写进：${REGISTRY}`;
    }

    case 'server_remove': {
      if (!ALLOW_WRITE) throw new Error(`写操作默认关闭（改这条连接器的 env：BANDI_SSH_ALLOW_WRITE=1）。目标文件：${REGISTRY}`);
      const r = removeServer(String(args.alias ?? '').trim());
      return r.removed
        ? `已从登记表删掉「${r.alias}」（只删了这一行，服务器和密钥文件都没动）`
        : `登记表里本来就没有「${String(args.alias ?? '').trim()}」`;
    }

    default:
      throw new Error(`未实现的工具：${name}`);
  }
}

/* ----------------------------------------------------------- MCP 传输层 */

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (id === undefined) return;

  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'bandi-ssh', version: '0.1.0' },
        instructions:
          '这台服务器管的是「服务器与密钥」：先 servers_list 看登记了哪些机器，再 ssh_run 干活。' +
          '连不上就用 ssh_guide 生成装公钥的指引。私钥不读、不回显。',
      });
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: TOOLS });
    case 'tools/call': {
      const name = params?.name;
      if (!TOOLS.some((t) => t.name === name)) return fail(id, -32602, `未知工具：${name}`);
      try {
        const text = await callTool(name, params?.arguments ?? {});
        return ok(id, { content: [{ type: 'text', text: String(text) }], isError: false });
      } catch (err) {
        return ok(id, { content: [{ type: 'text', text: String(err?.message ?? err) }], isError: true });
      }
    }
    case 'resources/list':
      return ok(id, { resources: [] });
    case 'resources/templates/list':
      return ok(id, { resourceTemplates: [] });
    case 'prompts/list':
      return ok(id, { prompts: [] });
    default:
      return fail(id, -32601, `未实现的方法：${method}`);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      process.stderr.write(`[bandi-ssh] 解析不了的一行：${String(err?.message ?? err)}\n`);
      continue;
    }
    handle(msg).catch((err) => {
      if (msg?.id !== undefined) fail(msg.id, -32603, String(err?.message ?? err));
    });
  }
});
process.stdin.on('end', () => process.exit(0));
