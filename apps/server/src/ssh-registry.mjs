import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

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

/**
 * 没填 key_path 时的默认私钥路径 —— **单一来源**：界面展示、key_state 判断、
 * ssh-keygen 落盘（ssh-exec.keyPathOf）都走它，谁也别自己再拼一遍。
 */
export const defaultKeyPath = (alias) => `~/.ssh/${alias}`;

/**
 * 用户输入不合法（**这条 message 是写给用户看的**，如「地址不要带协议头。」）。
 *
 * 为什么要带 `status`/`code`：以前这类 throw 到 HTTP 层被统一包成 `400 E1001`，
 * 前端只显示「E1001：服务异常」—— 人看不出是哪个字段写错了（2026-10-21 用户截图）。
 * 带上状态码后，HTTP 层才能区分「校验失败（可以照原文提示）」和「写盘失败（内部错）」。
 * MCP 侧只读 `message`，行为不变。
 */
function badInput(message) {
  return Object.assign(new Error(message), { code: 'E1051', status: 400 });
}

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
    if (raw.trim() !== '' && !/^\s/.test(raw)) throw badInput(`登记表 ${file} 里有认不出的内容：${raw.slice(0, 40)}（手工改过这个文件？把那一行改回 \`键: 值\` 或者删掉）`);
  }
  flush();

  for (const s of servers) {
    if (typeof s.alias !== 'string' || !s.alias) throw badInput(`登记表 ${file} 里有条目缺少 alias —— 每条都要有一个别名`);
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
  if (host.includes('://')) throw badInput('地址不要带协议头（https:// 那种前缀去掉，只填主机名或 IP）。');
  if (host.includes('/') || host.includes('\\')) throw badInput('地址不要带路径（只填主机名或 IP，路径单独在命令里给）。');
  if (host.includes(':')) throw badInput('地址不要带端口，端口填在下面那一格。');
  if (/\s/.test(host)) throw badInput('地址不能含空格。');
  const ipv4 = /^(\d{1,3})(\.\d{1,3}){3}$/.test(host) && host.split('.').every((n) => Number(n) <= 255);
  const domain = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*$/.test(host) && host.length <= 253;
  if (!ipv4 && !domain) throw badInput('地址要写成 IPv4（如 10.0.0.8）或域名（如 example.com）。');
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
/**
 * 别名当**文件名**用是否安全（`~/.ssh/<别名>` 是 key_path 的老默认）。
 * 只认 ASCII —— ssh-keygen / ssh -i 的参数在 Windows 上过 cmd/GBK，中文名就是
 * `.cmd 必须GBK+CRLF` 同一类编码坑。**显示名放开中文，文件名另取**，见 upsertServer。
 */
const keyFileSafe = (alias) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(alias);

/** 非 ASCII 别名 → 稳定的英文密钥文件名（同一别名永远同一个名字，重存不漂移） */
const derivedKeyPath = (alias) =>
  `~/.ssh/bandi-${crypto.createHash('sha256').update(alias).digest('hex').slice(0, 8)}`;

export function upsertServer(input = {}) {
  const alias = String(input.alias ?? '').trim();
  const host = String(input.host ?? '').trim();
  const user = String(input.user ?? '').trim();
  if (!alias || !host || !user) throw badInput('别名、地址、登录用户三格都得填。');
  // 别名是**显示名**，用户自然会用中文（服务器就叫"火山引擎服务器"）—— 放开 Unicode，
  // 只挡文件名/URL/这份简易 YAML 里会出问题的字符（空格、冒号、引号、#/斜杠都不在允许集里）。
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u.test(alias)) {
    throw badInput('别名要用汉字、字母或数字开头，可以带点、下划线、连字符，最长 64 个字符（不能有空格）。');
  }
  validateHost(host);
  const port = Number(input.port ?? 22) || 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw badInput('端口要填 1–65535 之间的整数，SSH 默认是 22。');

  const reg = readRegistry();
  const existing = reg.servers.find((s) => String(s.alias).toLowerCase() === alias.toLowerCase());
  const entry = existing ?? { alias };
  Object.assign(entry, {
    host,
    port,
    user,
    // key_path 一旦定下就随条目存住（existing 优先），改名重存不会换文件；
    // 非 ASCII 别名用哈希名 —— 别名是给人看的，密钥文件名是给 ssh-keygen 用的，两回事。
    key_path: String(input.key_path ?? existing?.key_path ?? (keyFileSafe(alias) ? `~/.ssh/${alias}` : derivedKeyPath(alias))),
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
 * 私钥路径不出（那是本机信息）—— 例外见下面 key_path 那条注释。
 *
 * `status` / `last_checked` / `host_fingerprint_verified` **不再回传**（2026-10-26）：
 * 这三个字段从首个提交起就没有任何写入点（`testConnection` 只把结果给弹窗，不落盘），
 * 界面上那个「状态」永远停在登记时的「待确认」——一个假状态比没有状态更误导。yaml 里
 * 老数据仍原样保留（serialize 会写回去），将来真要做「上次核对」再从这里接出来。
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
      /* key_path 留空 = 用默认的 `~/.ssh/<别名>`（跟 ssh-exec 的 keyPathOf 同一条规矩）。
       * 早先这里只认**显式**写下的 key_path，留空的一律算"未生成密钥" —— 可公钥块
       * （GET /key 走 tryPublicKeyOf → keyPathOf）又读得到内容，同一页上自相矛盾：
       * 上面写"未生成密钥"，下面却把公钥整行贴出来了（2026-10-26 用户截图）。 */
      const kp = expandHome(s.key_path || defaultKeyPath(s.alias));
      const hasKey = [kp, `${kp}.pub`].some((p) => fs.existsSync(p));
      return {
        alias: s.alias,
        host: s.host ?? '',
        port: s.port ?? 22,
        user: s.user ?? '',
        purpose: s.purpose ?? '',
        // 有没有密钥 —— 只给"有/没有"，不出**内容**
        has_key: hasKey,
        key_state: hasKey ? '密钥已就绪' : '未生成密钥',
        // 私钥**路径**要给：界面上"改"的表单里能填它，不回传就成了只能写不能读的黑洞。
        // 给的是路径不是内容 —— 私钥正文永不读、永不回显。
        // 登记时没填的，这里补上默认路径（否则界面那行是空白，用户不知道密钥落在哪）。
        key_path: s.key_path || defaultKeyPath(s.alias),
      };
    }),
  };
}
