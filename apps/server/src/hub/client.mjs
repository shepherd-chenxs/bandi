/*
 * hub/client.mjs —— 与中枢说话的唯一出口（契约：bandi-hub/contract.md，v1）。
 *
 * 铁律（新仓建的时候就定下的）：**bandi 只准通过 HTTP 认中枢，不许 import 它的代码。**
 * 于是所有差异都收在这一个文件里：契约升到 /v2 时，改的是这里的 `HUB_API_VERSION`
 * 和下面四个函数的路径，别的文件一行都不用动。
 *
 * 三个调用点：
 *   · `enroll` / `pollEnroll` —— `bandi hub join` 的一次性握手（主机没有浏览器）；
 *   · `heartbeat` —— 进程活着时每 60 秒报一次地址（中枢靠它画「在线」）；
 *   · `fetchPublicKey` —— 加入时把中枢公钥钉到本地（之后不再联网取钥匙）。
 *
 * 网络失败一律抛 `HubError`（带中枢的错误码 / 或 `E7xxx`），由调用方决定是打印还是吞掉。
 * **不重试**：心跳下一轮自然会重来；握手是一次性的，重试只会让用户看到两个码。
 */

import os from 'node:os';

/** 契约版本 —— 中枢破坏性升级（/v2）时改这里，并在 commit 里记一笔 */
export const HUB_API_VERSION = 'v1';

const PATHS = {
  enroll: `/${HUB_API_VERSION}/devices/enroll`,
  poll: `/${HUB_API_VERSION}/devices/enroll/poll`,
  heartbeat: (deviceId) => `/${HUB_API_VERSION}/devices/${encodeURIComponent(deviceId)}/heartbeat`,
  pubkey: `/${HUB_API_VERSION}/pubkey`,
};

/** 握手与心跳都不该拖住进程：一次请求最长 10 秒 */
const DEFAULT_TIMEOUT_MS = 10_000;

export class HubError extends Error {
  /** @param {string} code @param {string} message @param {any} [detail] */
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'HubError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * 发一个 JSON 请求。中枢的错误形状是 `{ error: { code, message } }`（契约 §三）。
 * @param {string} baseUrl
 * @param {string} path
 * @param {{ method?: string, body?: any, headers?: Record<string,string>, timeoutMs?: number }} [opts]
 */
async function call(baseUrl, path, opts = {}) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}${path}`;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  /** @type {any} */
  let res;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(opts.headers ?? {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const why = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? '超时' : '连不上';
    throw new HubError('E7101', `${why}中枢（${new URL(url).host}）`, { url, cause: String(e?.message ?? e) });
  }

  const text = await res.text();
  /** @type {any} */
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new HubError('E7102', `中枢返回的不是 JSON（HTTP ${res.status}）`, { url, body: text.slice(0, 200) });
  }
  if (!res.ok) {
    const code = data?.error?.code ?? `E71${String(res.status).padStart(2, '0')}`;
    const message = data?.error?.message ?? `中枢拒绝了这次请求（HTTP ${res.status}）`;
    throw new HubError(code, message, { url, status: res.status });
  }
  return data;
}

/**
 * 这台机器能被人从局域网访问的候选地址。
 *
 * 契约 §七 的口径：`lanAddrs` 是**候选列表**，手机侧会并发探测，探到的才可点。
 * 所以宁多勿少 —— 但要把「探了也白探」的排除掉，否则手机上会出现一排点不动的地址：
 *   · 127.0.0.0/8        回环，手机永远不是"本机"；
 *   · 169.254.0.0/16     DHCP 没拿到地址时的自留地；
 *   · 虚拟网卡            WSL / Hyper-V / Docker / VPN 隧道 —— 这些地址主机自己都未必路由得通。
 *
 * IPv4 优先、最多 8 个（契约上限，再多就是让手机白扫）。
 */
export function lanAddrs() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const [name, list] of Object.entries(ifaces)) {
    if (isVirtualIface(name)) continue;
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      const ip = String(a.address ?? '');
      if (!ip || a.internal) continue;
      if (ip.startsWith('127.') || ip.startsWith('169.254.')) continue;
      if (!out.includes(ip)) out.push(ip);
    }
  }
  return out.slice(0, 8);
}

/**
 * 这块网卡是不是「主机上的虚拟机/隧道」。
 * 按**网卡名**判，而不是按网段：`172.16/12` 既可能是 Docker，也可能是真局域网，
 * 按段砍会误伤；网卡名虽然因系统而异，但这里只是"尽量少报几个废地址"，
 * 漏一个的代价（手机多探一次）远小于砍错一个（手机永远连不上）。
 */
function isVirtualIface(name) {
  return /^(docker|br-|veth|virbr|vmnet|vboxnet|vEthernet|Loopback|Tailscale|zt|utun|tun|tap|wg|Hyper-V|WSL|本地连接\*)/i.test(name);
}

/**
 * 主机取设备码（中枢存 10 分钟，一次性）。
 * @param {string} baseUrl
 * @param {{ name: string, platform?: string, version?: string|null, lanAddrs?: string[], scheme?: 'http'|'https', port?: number }} meta
 * @returns {Promise<{ code: string, pollToken: string, expiresAt: number, hint?: string }>}
 */
export async function enroll(baseUrl, meta) {
  return call(baseUrl, PATHS.enroll, {
    method: 'POST',
    body: {
      name: meta.name,
      platform: meta.platform ?? process.platform,
      version: meta.version ?? null,
      lanAddrs: meta.lanAddrs ?? lanAddrs(),
      scheme: meta.scheme ?? 'http',
      port: meta.port,
    },
  });
}

/**
 * 轮询：`pending` 或 `approved`。
 * @param {string} baseUrl
 * @param {{ code: string, pollToken: string }} input
 * @returns {Promise<{ status: 'pending' } | { status: 'approved', deviceId: string, deviceToken: string, accountId?: string|null }>}
 */
export async function pollEnroll(baseUrl, { code, pollToken }) {
  return call(baseUrl, PATHS.poll, { method: 'POST', body: { code, pollToken } });
}

/**
 * 心跳：60 秒一次，把最新地址与端口报上去。
 * 中枢不知道地址，名册上就只有一台"在线但点不动"的机器 —— 这才是中枢存在的理由。
 * @param {string} baseUrl
 * @param {{ deviceId: string, deviceToken: string, lanAddrs?: string[], port?: number, version?: string|null }} input
 */
export async function heartbeat(baseUrl, { deviceId, deviceToken, lanAddrs: addrs, port, version }) {
  return call(baseUrl, PATHS.heartbeat(deviceId), {
    method: 'POST',
    headers: { authorization: `Device ${deviceToken}` },
    body: {
      ...(addrs === undefined ? {} : { lanAddrs: addrs }),
      ...(port === undefined ? {} : { port }),
      ...(version === undefined ? {} : { version }),
    },
    // 心跳不许拖：10 秒没回就当这轮丢了，下一轮再来
    timeoutMs: 8000,
  });
}

/**
 * 取中枢的签名公钥（**只在 join 时调一次**，之后钉在本地 —— 见 hub/config.mjs）。
 * @param {string} baseUrl
 * @returns {Promise<string>} base64url(raw Ed25519)
 */
export async function fetchPublicKey(baseUrl) {
  /** @type {any} */
  let data;
  try {
    data = await call(baseUrl, PATHS.pubkey);
  } catch (e) {
    // 老版本中枢没有这个端点（H3004 404），或者没配 TICKET_PUBLIC_KEY（H9001）
    throw new HubError(
      'E7103',
      `取不到中枢公钥（${e?.code ?? ''} ${e?.message ?? e}）—— 用 --pubkey 手动指定（keygen 打出来的第三个值）`,
      { cause: e },
    );
  }
  const key = String(data?.publicKey ?? '').trim();
  if (!key) throw new HubError('E7103', '中枢没有配置签名公钥（TICKET_PUBLIC_KEY），请用 --pubkey 手动指定');
  return key;
}
