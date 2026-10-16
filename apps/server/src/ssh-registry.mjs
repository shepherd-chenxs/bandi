import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 服务器登记表（~/.bandi/servers.yaml）的读写。
 *
 * **为什么单独一个模块**：这份契约有三方在共用（班底平台、MCP server、DSH 插件），
 * 而 MCP 那个文件在**模块顶层就接 stdin 跑循环**——被 import 会抢走 stdin。
 * 所以把读写抽到这里：谁都能 import，且没有任何副作用。
 * （原来这些函数长在 mcp/bandi-ssh.mjs 里，逐字搬过来的，行为不变。）
 */

export const expandHome = (p) =>
  String(p).startsWith('~/') || String(p).startsWith('~\\') ? path.join(os.homedir(), String(p).slice(2)) : String(p);

export const REGISTRY_PATH = expandHome(process.env.BANDI_SSH_REGISTRY || '~/.bandi/servers.yaml');

export const KEYS = [
  'alias', 'host', 'port', 'user', 'key_path', 'key_algorithm', 'key_fingerprint',
  'host_fingerprint', 'host_fingerprint_verified', 'last_checked', 'status', 'purpose',
];

export const stamp = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * 只认契约里那套形状（顶层 `键: 值`、段下 `  - 别名: ...` 的映射列表）。
 * 遇到认不出的顶层内容**报错**，绝不把坏文件当空表 —— 拿半份数据去连服务器更危险。
 */
export function readRegistry(file = REGISTRY_PATH) {
  if (!fs.existsSync(file)) return { version: 1, updated: stamp(), servers: [] };
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return { version: 1, updated: stamp(), servers: [] };

  let version = 1;
  let updated = '';
  const servers = [];
  let cur = null;
  let block = null; // 多行备注（`|-`）
  const flush = () => {
    if (block && cur && block.indent >= 0) cur[block.key] = block.lines.join('\n').replace(/\n+$/, '');
    block = null;
  };

  for (const raw of text.split(/\r?\n/)) {
    if (block) {
      if (raw.trim() === '') { if (block.indent >= 0) block.lines.push(''); continue; }
      const indent = raw.length - raw.trimStart().length;
      if (block.indent < 0) { block.indent = indent; block.lines.push(raw.slice(indent)); continue; }
      if (indent >= block.indent) { block.lines.push(raw.slice(block.indent)); continue; }
      flush();
    }
    if (raw.startsWith('version:')) { version = Number(raw.slice(8).trim()) || 1; continue; }
    if (raw.startsWith('updated:')) { updated = raw.slice(8).trim(); continue; }
    if (raw.startsWith('servers:')) continue;

    const item = /^\s{2}-\s+([A-Za-z_]+):\s?(.*)$/.exec(raw);
    if (item) { cur = {}; servers.push(cur); assign(cur, item[1], item[2]); continue; }

    const kv = /^\s{4}([A-Za-z_]+):\s?(.*)$/.exec(raw);
    if (kv && cur) {
      if (kv[2] === '|' || kv[2] === '|-') { block = { key: kv[1], indent: -1, lines: [] }; continue; }
      assign(cur, kv[1], kv[2]);
      continue;
    }
    if (raw.trim() !== '' && !/^\s/.test(raw)) throw new Error(`登记表里有认不出的顶层内容：${raw.slice(0, 40)}`);
  }
  flush();

  for (const s of servers) {
    if (typeof s.alias !== 'string' || !s.alias) throw new Error('登记表里有条目缺少 alias');
    s.port = Number(s.port) || 22;
    s.host_fingerprint_verified = s.host_fingerprint_verified === true || s.host_fingerprint_verified === 'true';
  }
  return { version, updated, servers };
}

function assign(obj, key, rawValue) {
  if (!KEYS.includes(key)) return; // 认不出的字段忽略，不参与改写
  let v = rawValue;
  if (v === '|' || v === '|-') v = '';
  else if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  obj[key] = v;
}

export function serialize(reg) {
  const out = [`version: ${reg.version}`, `updated: ${reg.updated}`, 'servers:'];
  for (const s of reg.servers) {
    out.push(`  - alias: ${s.alias}`);
    for (const k of ['host', 'port', 'user', 'key_path', 'key_algorithm', 'key_fingerprint', 'host_fingerprint']) {
      out.push(`    ${k}: ${s[k] ?? ''}`);
    }
    out.push(`    host_fingerprint_verified: ${s.host_fingerprint_verified === true}`);
    out.push(`    last_checked: ${s.last_checked ?? ''}`);
    out.push(`    status: ${s.status ?? ''}`);
    const note = String(s.purpose ?? '');
    out.push(`    purpose: ${note.includes('\n') ? '|-\n' + note.split('\n').map((l) => '      ' + l).join('\n') : note}`);
  }
  return out.join('\n') + '\n';
}

/** 原子写：先写临时文件再就位，和桌面端同一套纪律 */
export function writeRegistry(reg, file = REGISTRY_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), '.servers.yaml.tmp');
  fs.writeFileSync(tmp, serialize(reg), 'utf8');
  fs.renameSync(tmp, file);
}

/** 地址校验：只收 IPv4 或域名。逐字从 mcp/bandi-ssh.mjs 搬来，两边共用一套规则 */
export function validateHost(host) {
  if (host.includes('://')) throw new Error('地址不要带协议头。');
  if (host.includes('/') || host.includes('\\')) throw new Error('地址不要带路径。');
  if (host.includes(':')) throw new Error('地址不要带端口（端口单独填）。');
  if (/\s/.test(host)) throw new Error('地址不能含空格。');
  const ipv4 = /^(\d{1,3})(\.\d{1,3}){3}$/.test(host) && host.split('.').every((n) => Number(n) <= 255);
  const domain = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*$/.test(host) && host.length <= 253;
  if (!ipv4 && !domain) throw new Error('地址要写成 IPv4 或域名。');
}

export function getServer(alias) {
  const reg = readRegistry();
  const want = String(alias ?? '').toLowerCase();
  return reg.servers.find((s) => String(s.alias).toLowerCase() === want) ?? null;
}

/**
 * 登记或更新一台机器（按 alias 匹配，大小写不敏感）。
 *
 * **MCP 的 server_upsert 工具和 HTTP 接口都调这里** —— 校验规则和默认值只写一份，
 * 否则"界面上能加、agent 加不了"这种不一致迟早出现。
 * 校验失败一律 throw（错误信息直接给用户看）。
 */
export function upsertServer(input = {}) {
  const alias = String(input.alias ?? '').trim();
  const host = String(input.host ?? '').trim();
  const user = String(input.user ?? '').trim();
  if (!alias || !host || !user) throw new Error('别名、地址、登录用户都得填。');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(alias)) {
    throw new Error('别名只能用字母数字点下划线连字符，且以字母数字开头。');
  }
  validateHost(host);
  const port = Number(input.port ?? 22) || 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口要是 1–65535 的整数。');

  const reg = readRegistry();
  const existing = reg.servers.find((s) => String(s.alias).toLowerCase() === alias.toLowerCase());
  const entry = existing ?? { alias };
  Object.assign(entry, {
    host,
    port,
    user,
    key_path: String(input.key_path ?? existing?.key_path ?? `~/.ssh/${alias}`),
    key_algorithm: existing?.key_algorithm ?? 'ed25519',
    key_fingerprint: existing?.key_fingerprint ?? '',
    host_fingerprint: existing?.host_fingerprint ?? '待确认（尚未连接）',
    host_fingerprint_verified: existing?.host_fingerprint_verified ?? false,
    last_checked: existing?.last_checked ?? '',
    status: existing?.status ?? '待确认',
    purpose: String(input.purpose ?? existing?.purpose ?? '待确认（用户未填）'),
  });
  if (!existing) reg.servers.push(entry);
  reg.updated = stamp();
  writeRegistry(reg);
  return { created: !existing, alias: entry.alias, entry };
}

/** 从登记表删掉一台（**只删这一行**，服务器和密钥文件都不动） */
export function removeServer(alias) {
  const reg = readRegistry();
  const want = String(alias ?? '').toLowerCase();
  const i = reg.servers.findIndex((s) => String(s.alias).toLowerCase() === want);
  if (i < 0) return { removed: false };
  const [gone] = reg.servers.splice(i, 1);
  reg.updated = stamp();
  writeRegistry(reg);
  return { removed: true, alias: gone.alias };
}

/**
 * 给界面看的清单：**只出安全字段**。
 * 私钥路径不出（那是本机信息），指纹只给"验没验过"这个布尔。
 */
export function publicServers() {
  let reg;
  try {
    reg = readRegistry();
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e), servers: [] };
  }
  return {
    ok: true,
    path: REGISTRY_PATH,
    updated: reg.updated,
    servers: reg.servers.map((s) => {
      const kp = s.key_path ? expandHome(s.key_path) : '';
      const hasKey = !!kp && [kp, `${kp}.pub`].some((p) => fs.existsSync(p));
      return {
        alias: s.alias,
        host: s.host ?? '',
        port: s.port ?? 22,
        user: s.user ?? '',
        status: s.status ?? '',
        purpose: s.purpose ?? '',
        last_checked: s.last_checked ?? '',
        fingerprint_verified: s.host_fingerprint_verified === true,
        // 有没有密钥 —— 只给"有/没有"，不出**内容**
        has_key: hasKey,
        key_state: hasKey ? '密钥已就绪' : '未生成密钥',
        // 私钥**路径**要给：界面上"改"的表单里能填它，不回传就成了只能写不能读的黑洞。
        // 给的是路径不是内容 —— 私钥正文永不读、永不回显。
        key_path: s.key_path ?? '',
      };
    }),
  };
}
