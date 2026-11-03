/* security/ipallow.mjs —— **网络周界闸**（2026-11-03，对齐 1Panel 安全页的「授权 IP / 域名绑定」）。
 *
 * 为什么要有这个模块：监听改成**永远对外**（2026-11-03）之后，令牌闸就是唯一那道门了 ——
 * 扫描器、网段里的陌生机器、拿域名乱指过来的人，全都能敲到闸上。这两道网络层的闸
 * 在令牌**之前**把它们拒掉（跟 guardHost 同一层），连"摸到登录口"都不给：
 *
 *   · **授权 IP**（E3003）—— 开启后，名单之外的 IP 一律 403。名单支持精确 IP（v4/v6）
 *     与 IPv4 网段（`192.168.5.0/24`，内网名单的常态；IPv6 网段先不做，精确就够）。
 *   · **域名绑定**（E3004）—— 设了之后，非本机来源的 Host 必须是这个名字：
 *     防的是"别人的域名指到我的公网 IP 上也能打开面板"和按 IP 扫出来的直达。
 *
 * **本机直连永远放行**（peer 回环且没经过任何代理）：单机那侧永远给自己留着门，
 * 否则名单填错一个 IP 就把自己锁在面板外面、而且没有任何令牌可以自救 ——
 * 误锁了就走 SSH 隧道 / 上机器改 netmode.json。判定口径见 isDirectLocal。
 *
 * ⚠️ `BANDI_TRUST_PROXY`（IAM §5.2）是这对功能的前置：反代把流量转进来时 peer 全是
 * 回环，只有设了它才按 `X-Forwarded-For` 取真实来源 —— 且反代要**覆写**转发头
 * （nginx `proxy_set_header X-Forwarded-For $remote_addr`），append 配置下客户端可以
 * 伪造第一段。没设 trustProxy 时转发头一概不信（跟 source.mjs 同一口径）。
 *
 * 入口在 server.mjs（guardHost 之后、令牌闸之前）；`/api/lan` 读写这些键（routes/runtime.mjs）。
 */

import { envTrue, normAddr, isLoopbackAddr, hostnameOf } from './source.mjs';
import * as netmode from '../netmode.mjs';

/** 拒绝码：grep 编码就能落到这一行 */
export const CODE_IP = 'E3003';
export const CODE_DOMAIN = 'E3004';

/* --------------------------------------------------------------- 名单条目 */

/** IPv4 → uint32；不认识返回 null */
function ip4ToU32(a) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (!m) return null;
  let out = 0;
  for (let i = 1; i <= 4; i++) {
    const o = Number(m[i]);
    if (o > 255) return null;
    out = out * 256 + o;
  }
  return out >>> 0;
}

/**
 * 解析一条名单条目。认识：精确 IPv4 / IPv6（做 `::ffff:` 归一小写）与 IPv4 网段。
 * 返回 `{ kind, ip?, base?, mask?, text }`，text 是归一化后的写法（回给界面/存库都用它）。
 */
function parseEntry(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return null;
  if (s.includes('/')) {
    const i = s.indexOf('/');
    const ip = normAddr(s.slice(0, i));
    const bits = Number(s.slice(i + 1));
    const base = ip4ToU32(ip);
    if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return { kind: 'cidr4', base: (base & mask) >>> 0, mask, text: `${ip}/${bits}` };
  }
  const ip = normAddr(s);
  if (!ip) return null;
  /*
   * **精确条目必须是真 IP**（2026-11-03 冒烟抓出来的洞）：normAddr 只归一不校验，
   * `999.1.1.1`、`abc` 这种串会原样当"精确 IP"存进名单 —— 名单声称"每行一个 IP
   * 或网段"（E1052 的口径），脏串得在这里就拒掉。v4 用点分十进制校验，其余认带
   * `:` 的（v6 一族）；两者都不是就不是 IP。
   */
  const isV4 = ip4ToU32(ip) !== null;
  if (!isV4 && !ip.includes(':')) return null;
  return { kind: 'exact', ip, text: ip };
}

/**
 * 归一化一份用户提交的名单：去掉空行与重复、统一写法。
 * 返回 `{ ips, bad }` —— `bad` 非空就是有写错的条目，调用方 400（E1052），
 * **一个都不存**（存一半 = 用户以为防住了，其实漏着）。
 */
export function normalizeIpList(list) {
  const ips = [];
  const bad = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    if (!String(raw ?? '').trim()) continue; // 空行：直接丢，不算写错（textarea 里多敲的回车是常态）
    const e = parseEntry(raw);
    if (!e) {
      bad.push(String(raw).trim());
      continue;
    }
    if (!seen.has(e.text)) {
      seen.add(e.text);
      ips.push(e.text);
    }
  }
  return { ips, bad };
}

/** 一个（归一化过的）IP 有没有命中名单 */
export function ipAllowed(ip, list) {
  const a = normAddr(ip);
  if (!a) return false;
  for (const raw of list ?? []) {
    const e = parseEntry(raw);
    if (!e) continue; // 库里混进了脏数据就跳过，别把整条闸卡死
    if (e.kind === 'exact') {
      if (a === e.ip) return true;
    } else {
      const u = ip4ToU32(a);
      if (u !== null && ((u & e.mask) >>> 0) === e.base) return true;
    }
  }
  return false;
}

/**
 * 域名绑定的归一化：去 scheme / 路径 / 端口 / 结尾的点，小写。空串 = 清除绑定。
 * 只留主机名 —— 绑定的是"用哪个名字访问"，不是"哪个端口"。
 */
export function normalizeDomain(raw) {
  let s = String(raw ?? '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  s = s.split('/')[0].split(':')[0]; // 路径、端口
  while (s.endsWith('.')) s = s.slice(0, -1);
  return s;
}

/* ------------------------------------------------------------------- 闸 */

/**
 * 这条请求的**真实来源 IP**：可信反代 + 带转发头 → 取 `X-Forwarded-For` 第一段；
 * 否则 socket peer（归一化，剥 `::ffff:` 前缀）。
 */
export function clientIpOf(req) {
  if (envTrue(process.env.BANDI_TRUST_PROXY)) {
    const xff = String(req?.headers?.['x-forwarded-for'] ?? '').trim();
    if (xff) return normAddr(xff.split(',')[0]);
  }
  return normAddr(req?.socket?.remoteAddress);
}

/**
 * 是不是**本机直连**（peer 回环、没经过任何代理）—— 两道闸都放行的那种。
 *
 * ⚠️ 设了 `BANDI_TRUST_PROXY` 就没有"本机直连"可言：回环 peer 是代理自己，
 * 不是人（source.mjs §① 的同一套逻辑）。这种部署下本机请求请走反代或按名单放行。
 */
function isDirectLocal(req) {
  if (envTrue(process.env.BANDI_TRUST_PROXY)) return false;
  const h = req?.headers ?? {};
  if (h['x-forwarded-for'] || h['x-real-ip'] || h['forwarded']) return false; // 带转发头 = 过了代理
  return isLoopbackAddr(req?.socket?.remoteAddress);
}

/**
 * 网络周界闸：返回 `null` 放行，否则 `{ code, message }`（server.mjs 映成 403 + 审计）。
 *
 * 白名单开着（**哪怕名单是空的**）= 名单之外一律拦，本机直连除外 —— 空名单只在
 * 手改文件时出现（界面保存时会把你的 IP 自动写进名单），这时候"开着却谁都不放"
 * 恰恰是对的手感：是用户自己关掉了门，别替他悄悄敞开。
 * 域名绑定开着时，Host 必须精确等于绑定名（大小写/结尾点归一化后比较）。
 */
export function guardNetwork(req) {
  const nm = netmode.readNetMode();
  const local = isDirectLocal(req);
  if (nm.whitelistEnabled && !local) {
    const ip = clientIpOf(req);
    if (!ipAllowed(ip, nm.whitelistIps)) {
      return { code: CODE_IP, message: `IP 不在授权名单：${ip || '未知来源'}` };
    }
  }
  const bound = String(nm.boundDomain ?? '').trim().toLowerCase();
  if (bound && !local) {
    const host = hostnameOf(req?.headers?.host);
    if (host !== bound && host !== `${bound}.`) {
      return { code: CODE_DOMAIN, message: `域名绑定后仅能通过 ${bound} 访问` };
    }
  }
  return null;
}
