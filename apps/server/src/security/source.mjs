/* security/source.mjs —— 「这个请求从哪来」的**唯一判定点**（IAM §5.2 / §5.3）。
 *
 * 为什么必须有这个模块：原来全仓有四处各判各的回环
 *   `auth.mjs`（整站免鉴权）、`auth.mjs`（/api/ai 免令牌）、`routes/local.mjs`、`routes/imageai.mjs`，
 * 判据都是 `req.socket.remoteAddress`。而 nginx / cloudflared / frp 反向代理到本机时，
 * **所有外部请求的 remoteAddress 都是 127.0.0.1** —— 一上反代，`/api/local/export` 与
 * 整个面板就等于是挂在公网上的（IAM §5.3 的 P0）。
 *
 * 所以判定收敛到这里，四条同时成立才算 `loopback`：
 *   ① 没有配 `BANDI_TRUST_PROXY`（配了 = "我知道前面有代理"，回环不再可信）
 *   ② 请求没带任何转发头（X-Forwarded-For / X-Real-IP / Forwarded）
 *   ③ 进程监听的是回环地址（`SERVER.boundHost`，原地重启后会变，不能读 config.host）
 *   ④ peer 是回环 **且** Host 是本机名（反代漏配转发头时，Host 是最后一道信号）
 *
 * ⚠️ `routes/` 里不许再出现 `req.socket.remoteAddress` 做安全判断（记录用途可以）。
 * ⚠️ 这个文件**不 import auth.mjs**（auth 要 import 它，反过来就成环）—— 所以
 *    `isLoopbackHost` 挪到这里，auth.mjs 原样再导出一次，对外 API 不变。
 */
import os from 'node:os';
import { SERVER } from '../server-state.mjs';

/** 环境变量里的布尔（`1 / on / true / yes` 都算真） */
export function envTrue(v) {
  return /^(1|on|true|yes)$/i.test(String(v ?? '').trim());
}

/** 去掉 IPv4-mapped 前缀并小写 —— Node 在双栈 socket 上会把 127.0.0.1 报成 ::ffff:127.0.0.1 */
export function normAddr(v) {
  let a = String(v ?? '').trim().toLowerCase();
  if (a.startsWith('::ffff:')) a = a.slice(7);
  return a;
}

/** 一个 peer 地址是不是回环 */
export function isLoopbackAddr(v) {
  const a = normAddr(v);
  if (!a) return false;
  return a === '::1' || a === '127.0.0.1' || a === 'localhost' || a.startsWith('127.');
}

/** 监听地址是不是回环（只认字面量，与 netmode.isLoopback 同口径） */
export function isLoopbackHost(host) {
  const h = String(host ?? '').trim().toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
}

/** 从 Host 头里剥出主机名（去端口；IPv6 去方括号） */
export function hostnameOf(raw) {
  const h = String(raw ?? '').trim().toLowerCase();
  if (!h) return '';
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end === -1 ? h.slice(1) : h.slice(1, end);
  }
  const i = h.lastIndexOf(':');
  return i === -1 ? h : h.slice(0, i);
}

/*
 * 「本机名」的集合：回环 + 本机网卡地址 + `os.hostname()`。
 *
 * ⚠️ **故意不含 `BANDI_ORIGINS` 里的域名**（`http.localAddresses()` 为了放行 Host 守卫是含的）：
 * 那正是公网部署用的域名，把它算成"本机"就等于把这条兜底自己废掉。
 * 缓存 60 秒（DHCP 换 IP 一分钟内自愈），与 http.mjs 的网卡缓存同节奏。
 */
let localNames = null;
let localNamesAt = 0;
function localHostNames() {
  const now = Date.now();
  if (localNames && now - localNamesAt < 60_000) return localNames;
  const set = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list ?? []) if (ni?.address) set.add(String(ni.address).toLowerCase());
    }
  } catch { /* 拿不到网卡就不加，回环那几条仍然在 */ }
  try {
    const hn = String(os.hostname() ?? '').toLowerCase();
    if (hn) {
      set.add(hn);
      // Windows 上浏览器常用 `主机名` 直连；带 .local 的 mDNS 名字也认一份
      set.add(`${hn}.local`);
    }
  } catch { /* 同上 */ }
  localNames = set;
  localNamesAt = now;
  return set;
}

/** Host 头是不是指向本机（不代表"请求就来自本机" —— 那只由 classifySource 回答） */
export function isLocalHost(raw) {
  const h = hostnameOf(raw);
  return !!h && localHostNames().has(h);
}

/**
 * 这次的判定上下文。
 * `listeningOnLoopback` 读 `SERVER.boundHost`（进程**现在**听的是什么）——
 * `/api/restart` 会原地换监听，读启动期的 `config.host` 会滞后一拍。
 */
export function cfgNow() {
  return {
    trustProxy: envTrue(process.env.BANDI_TRUST_PROXY),
    listeningOnLoopback: isLoopbackHost(SERVER.boundHost),
  };
}

/**
 * → `'loopback'` | `'network'`。**全仓唯一判定点。**
 * 顺序不是随意的：先排除"声明了代理"，再看转发头，最后才看 peer —— 越靠前的证据越硬。
 */
export function classifySource(req, cfg = cfgNow()) {
  if (cfg.trustProxy) return 'network'; // ① 声明了可信代理 → 回环一律不作数
  const h = req?.headers ?? {};
  if (h['x-forwarded-for'] || h['x-real-ip'] || h['forwarded']) return 'network'; // ② 有转发头
  if (!cfg.listeningOnLoopback) return 'network'; // ③ 监听 0.0.0.0/:: 时不认回环
  if (!isLoopbackAddr(req?.socket?.remoteAddress)) return 'network'; // ④ peer 必须是回环
  if (!isLocalHost(h.host)) return 'network'; // ⑤ Host 兜底：反代漏配转发头也不认
  return 'loopback';
}

/** 这次请求的来源（guard 会把它挂在 `req.bandiSource` 上；下游别再自己判一遍） */
export function sourceOf(req) {
  if (req?.bandiSource === 'loopback' || req?.bandiSource === 'network') return req.bandiSource;
  return classifySource(req);
}
