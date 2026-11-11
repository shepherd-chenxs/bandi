/*
 * hub/client.mjs —— 与中枢说话的唯一出口（契约：bandi-hub/contract.md，v1）。
 *
 * 铁律（新仓建的时候就定下的）：**bandi 只准通过 HTTP 认中枢，不许 import 它的代码。**
 * 于是所有差异都收在这一个文件里：契约升到 /v2 时，改的是这里的 `HUB_API_VERSION`
 * 和下面函数的路径，别的文件一行都不用动。
 *
 * 两个调用点：
 *   · `heartbeat` —— 进程活着时每 60 秒报一次地址（中枢靠它画「在线」）；
 *   · `deviceLogin` —— 本机登录页的账号密码转给中枢（登录即登记机器，2026-11-07 起
 *     这是机器接入的唯一通道，设备码 / `bandi hub join` 已退场）。
 *
 * 网络失败一律抛 `HubError`（带中枢的错误码 / 或 `E7xxx`），由调用方决定是打印还是吞掉。
 * **不重试**：心跳下一轮自然会重来；握手是一次性的，重试只会让用户看到两个码。
 */

import os from 'node:os';

/** 契约版本 —— 中枢破坏性升级（/v2）时改这里，并在 commit 里记一笔 */
export const HUB_API_VERSION = 'v1';

const PATHS = {
  heartbeat: (deviceId) => `/${HUB_API_VERSION}/devices/${encodeURIComponent(deviceId)}/heartbeat`,
  pubkey: `/${HUB_API_VERSION}/pubkey`,
  deviceLogin: `/${HUB_API_VERSION}/auth/device-login`,
  changePassword: `/${HUB_API_VERSION}/auth/password`,
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

/**
 * 账号密码登录（2026-11-07）。
 *
 * 用户在本机登录页输入的账号密码，经这里转给中枢 —— 主机**不存密码、不建账号**，
 * 认人的事一直在中枢。成功时中枢顺手把本机登记进名册，回来的是：
 * 一张票（主机自己验）+ 本机的设备身份（写 hub.json）+ 中枢账号信息（绑本地用户）。
 *
 * @param {string} baseUrl
 * @param {{ username: string, password: string, mode?: 'login'|'register', deviceId?: string|null, deviceToken?: string|null, name?: string, platform?: string, version?: string|null, lanAddrs?: string[], scheme?: 'http'|'https', port?: number }} input
 * @returns {Promise<{ ticket: string, deviceId: string, deviceToken: string, publicKey?: string|null, account: { id: string, login: string, name?: string|null } }>}
 */
export async function deviceLogin(baseUrl, input) {
  return call(baseUrl, PATHS.deviceLogin, {
    method: 'POST',
    headers: input.deviceToken ? { authorization: `Device ${input.deviceToken}` } : {},
    body: {
      username: input.username,
      password: input.password,
      mode: input.mode ?? 'login',
      deviceId: input.deviceId ?? null,
      name: input.name,
      platform: input.platform ?? process.platform,
      version: input.version ?? null,
      lanAddrs: input.lanAddrs ?? lanAddrs(),
      scheme: input.scheme ?? 'http',
      port: input.port,
    },
    // 人正在等这一下，比心跳多给几秒（PBKDF2 + 一次 D1 写）
    timeoutMs: 15_000,
  });
}

/**
 * 改中枢账号的密码（2026-11-10）。
 *
 * 「我的 › 修改密码」转到这里：主机拿自己 0600 落盘的**设备凭据**（deviceId +
 * deviceToken）替绑定的中枢账号办事 —— 中枢验旧密码、写新密码，主机不碰明文以外
 * 的任何东西。会话/票据中枢不吊销：已进门的人不受影响，新登录用新密码。
 *
 * @param {string} baseUrl
 * @param {{ deviceId: string, deviceToken: string, oldPassword: string, newPassword: string }} input
 * @returns {Promise<{ ok: true }>}
 */
export async function changePassword(baseUrl, input) {
  return call(baseUrl, PATHS.changePassword, {
    method: 'POST',
    headers: input.deviceToken ? { authorization: `Device ${input.deviceToken}` } : {},
    body: {
      deviceId: input.deviceId,
      oldPassword: input.oldPassword,
      newPassword: input.newPassword,
    },
    // 人正在等：旧密码一次 PBKDF2 验证 + 新密码一次 PBKDF2 派生 + 一次 D1 写
    timeoutMs: 15_000,
  });
}
