/*
 * hub/relay.mjs —— 「这台机器从外网怎么被访问」的那份配置。**只读，不写。**
 *
 * 两个来源，一个形状（2026-11-07 外网访问方案）：
 *
 *   ① `<数据目录>/hub.json` 的 `relay` —— 中枢下发（登录时给，或心跳里换/撤）。
 *      这是**产品路径**：用户在界面上什么都不用填。
 *   ② `<数据目录>/tunnel.json` —— 手工文件，给 Spike / 自建 frps 用。
 *      中枢那份没有时才看它；它不进任何界面，也不写进文档的"用户操作"。
 *
 * 为什么单拆一个文件：`http.mjs` 的两道闸（Host 守卫、写来源白名单）也要读它，
 * 而 `tunnel.mjs` 要起进程。两边都 import `tunnel.mjs` 的话，`http.mjs` 会被
 * 拖去加载 `child_process` 与 `lifecycle`（那里还会去装 CLI）—— 一个只做字符串
 * 比对的模块不该有这些副作用。
 *
 * 校验口径：**缺一项就当没有**。宁可退化成"外网连不上、本机照常用"，
 * 也不要拿半份配置去 spawn 一个会连错服务器、或把 token 发到别人的 frps 上的进程。
 */

import fs from 'node:fs';
import path from 'node:path';
import { readHubConfig } from './config.mjs';

/** 手工配置落点（Spike 用；不是产品入口） */
export function relayConfigPath(dataDir) {
  return path.join(dataDir, 'tunnel.json');
}

/** 子域名的形状：frps 的 subdomain 只吃这些字符，别放中文/大写以外的怪东西进去 */
const SUBDOMAIN_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * 把一份原始对象收拾成可信形状；不合格返回 null。
 * @param {any} raw
 * @returns {null | { enabled: true, serverAddr: string, serverPort: number, subdomain: string, token: string, serverToken: string, publicUrl: string, expiresAt: string|null }}
 */
function normalize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.enabled === false) return null;

  const serverAddr = String(raw.serverAddr ?? '').trim();
  const subdomain = String(raw.subdomain ?? '').trim().toLowerCase();
  const token = String(raw.token ?? '').trim();
  const serverPort = Number(raw.serverPort ?? 7000);

  if (!serverAddr || !token) return null;
  if (!SUBDOMAIN_RE.test(subdomain)) return null;
  if (!Number.isInteger(serverPort) || serverPort <= 0 || serverPort > 65535) return null;

  // publicUrl 允许缺：中枢没给就由 subdomain 那一侧自己拼，界面上少一行字而已
  const publicUrl = String(raw.publicUrl ?? '').trim().replace(/\/+$/, '');
  return {
    enabled: true,
    serverAddr,
    serverPort,
    subdomain,
    token,
    // frps 那一层的共享门槛（`auth.token`）。缺省空 = frps 也没配，两边一致才连得上。
    serverToken: String(raw.serverToken ?? '').trim(),
    // 接入协议：空 = 直连 tcp（自建 frps 开 7000）；"websocket" = 明文 ws；
    // "wss" = TLS 之上的 ws。**藏在 Cloudflare 后面时必须用 "wss"**：
    //   · `websocket` + `tls.enable = true` 是先发明文 ws 请求再做 TLS（frp 的 hook 优先级），
    //     443 端口收到明文 HTTP 直接拒（frpc 报 "bad status"），请求根本到不了隧道；
    //   · `wss` 才是"先 TLS 再 ws"，与 Cloudflare 的正常对话方式一致。
    protocol: String(raw.protocol ?? '').trim().toLowerCase(),
    publicUrl,
    expiresAt: raw.expiresAt ? String(raw.expiresAt) : null,
  };
}

/**
 * 这台机器现在该不该有隧道、连哪儿。
 * @param {string} dataDir
 * @returns {ReturnType<typeof normalize>}
 */
export function readRelay(dataDir) {
  const hub = readHubConfig(dataDir);
  const fromHub = normalize(hub?.relay);
  // 中枢这套认人靠 `user = <deviceId>`（frps 的 Login 回调据此知道该比哪台设备的 token）
  if (fromHub) return { ...fromHub, deviceId: String(hub.deviceId ?? '') || null };
  if (hub?.relay) return null; // 中枢明确说了没有（null / enabled:false）

  try {
    const manual = JSON.parse(fs.readFileSync(relayConfigPath(dataDir), 'utf8'));
    const cfg = normalize(manual);
    return cfg ? { ...cfg, deviceId: manual?.deviceId ? String(manual.deviceId) : null } : null;
  } catch {
    return null;
  }
}

/**
 * 隧道域名要进**两道闸**：Host 守卫（DNS rebinding）与写来源白名单（CSRF）。
 *
 * 为什么必须自动放行，而不是让用户设 `BANDI_ORIGINS`：环境变量只跟着"启动它的那个终端"
 * 走，开机自启的脚本不会带 —— 结果就是"今天能用、重启一次就 403"。域名是中枢下发的、
 * 精确的、可撤销的，比人手敲的环境变量更可信。
 *
 * @param {string} dataDir
 * @returns {{ hosts: string[], origins: string[] }}
 */
export function relayTrust(dataDir) {
  const cfg = readRelay(dataDir);
  if (!cfg) return { hosts: [], origins: [] };
  /** @type {string[]} */
  const hosts = [];
  /** @type {string[]} */
  const origins = [];
  try {
    const u = new URL(cfg.publicUrl);
    hosts.push(u.hostname.toLowerCase());
    origins.push(`${u.protocol}//${u.host}`);
  } catch {
    /*
     * 没给 publicUrl：**什么都不放行**。
     * 早先这里写的是 `hosts.push(\`${cfg.subdomain}.\`)` —— 拼出来的是一个带尾点的
     * 裸子域名（`ddev-x.`），既不是任何真实 Host，写来源那边还留空：等于记了一条
     * 永远匹配不上、却让人以为"已经放行了"的东西。宁可继续走局域网 + 用户自己设
     * `BANDI_ORIGINS`，也不要留一条假放行。
     */
  }
  return { hosts, origins };
}

/** Host 守卫用（`http.localAddresses()` 现算，别缓存到别处） */
export function relayHosts(dataDir) {
  return relayTrust(dataDir).hosts;
}

/** 写来源白名单用 */
export function relayOrigins(dataDir) {
  return relayTrust(dataDir).origins;
}
