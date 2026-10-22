/**
 * 节点侧：**UDP 广播探测「同一网络里有哪些班底总机」**（2026-10-20，设计 §5.2 / §13.3）。
 *
 * 只做一件事：往广播地址发探测包，把回包聚合成候选清单。零依赖 —— `node:dgram` /
 * `node:crypto` / `node:os`，**不碰 SQLite、不碰 store**（节点进程会 import 本文件，
 * 而 `store.mjs` 一 import 就开库跑迁移，那会让节点进程去写控制面的库 ✗）。
 *
 * 三条容易写错的地方，都是这里必须守住的：
 *   ① **按 `instanceId` 去重** —— 一台总机有多张网卡时，每个网卡都会回一包，
 *      不去重的话候选列表里会出现同一台机器好几行（PRD P0-1 的验收项）。
 *   ② **地址取 `rinfo.address`**，不信应答里自报的 IP —— 多网卡时它报的可能是另一张网卡的地址，
 *      而"能连上的那个地址"就是**这条回包的来源地址**。
 *   ③ **`nonce` 回显** —— 只认自己这一轮发出去的 nonce，把上一轮（比如开关刚关掉之前）
 *      的迟到回包丢掉；否则"关掉开关还能看到一行"（PRD P0-1 的另一条验收项）。
 */
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import os from 'node:os';

/**
 * 发现用的固定 UDP 端口：默认 8788，`BANDI_DISCOVERY_PORT` 可覆盖（PRD P2-2：
 * 端口被占、或跨 VLAN 定向广播的场景）。
 *
 * ⚠️ **这是全仓唯一的读取点**：`lan-announce.mjs`（应答器那侧）从这里 import 它 ——
 * 两处各读一遍环境变量迟早会出现"探测器敲 8788、应答器听 9000"这种谁也发现不了的事故。
 */
export const DISCOVERY_PORT = (() => {
  const n = Number(process.env.BANDI_DISCOVERY_PORT ?? 8788);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : 8788;
})();

/** 一条探测包最多等多久：3 轮 × 1.2 秒 = 3.6 秒，加收尾 < 4 秒（PRD：最多 4 秒） */
const ROUNDS_DEF = 3;
const ROUND_MS_DEF = 1200;
const ROUNDS_MAX = 10;
const ROUND_MS_MIN = 100;
const ROUND_MS_MAX = 3000;

/**
 * 往哪儿广播：`255.255.255.255` ＋ **各网卡的定向广播地址**。
 *
 * 为什么两个都要：
 *   · `255.255.255.255`（受限广播）在多数系统上能出去，但有些路由/防火墙只放行定向广播；
 *   · **定向广播**（`192.168.1.255` 这种，由 `ip & ~mask` 算出来）在 Windows 上更可靠 ——
 *     它明确指着"这条链路"，不用猜默认路由从哪张网卡出去。
 * 两个都发，重复的由 Set 收掉。
 */
export function broadcastTargets() {
  const out = new Set(['255.255.255.255']);
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list ?? []) {
        if (ni.family !== 'IPv4' || ni.internal) continue;
        const b = directedBroadcast(ni.address, ni.netmask);
        if (b) out.add(b);
      }
    }
  } catch {
    /* 拿不到网卡清单就只发受限广播 —— 不能因为这个让"发现"整个不可用 */
  }
  return [...out];
}

/** `192.168.1.9` + `255.255.255.0` → `192.168.1.255`（算不出来就 null） */
function directedBroadcast(address, netmask) {
  const ip = ipToInt(address);
  const mask = ipToInt(netmask);
  if (ip === null || mask === null) return null;
  return intToIp((ip | (~mask >>> 0)) >>> 0);
}

function ipToInt(s) {
  const parts = String(s ?? '').split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

function intToIp(n) {
  return [24, 16, 8, 0].map((sh) => (n >>> sh) & 255).join('.');
}

/**
 * 扫一轮（最多 `rounds × roundMs` 毫秒）。
 *
 * @param {object} [opts]
 * @param {number} [opts.port]   发现端口（默认 `DISCOVERY_PORT`）
 * @param {number} [opts.rounds] 发几轮（默认 3）
 * @param {number} [opts.roundMs] 每轮间隔（默认 1200）
 * @param {string[]} [opts.targets] 目的地（**可注入**：用例走 `['127.0.0.1']`，不依赖真网卡）
 * @returns {Promise<object[]>} 候选清单；**空数组不是错误**（PRD 步骤 3 的兜底页就是它）
 */
export function discover(opts = {}) {
  const port = Number(opts.port) > 0 ? Math.min(65535, Math.round(Number(opts.port))) : DISCOVERY_PORT;
  const rounds = clamp(Math.round(Number(opts.rounds) || ROUNDS_DEF), 1, ROUNDS_MAX);
  const roundMs = clamp(Math.round(Number(opts.roundMs) || ROUND_MS_DEF), ROUND_MS_MIN, ROUND_MS_MAX);
  const targets =
    Array.isArray(opts.targets) && opts.targets.length ? opts.targets.map((t) => String(t).trim()).filter(Boolean) : broadcastTargets();

  const nonce = crypto.randomBytes(8).toString('hex');
  const probe = Buffer.from(JSON.stringify({ bandi: 'discover', v: 1, nonce }), 'utf8');
  /** `instanceId` → 候选（同一台总机只留一行；后到的覆盖先到的，`seenAt` 更晚） */
  const seen = new Map();

  return new Promise((resolve) => {
    let sock;
    try {
      sock = dgram.createSocket('udp4');
    } catch (e) {
      console.warn(`[发现] 开不了 UDP 套接字：${e?.message ?? e} —— 这次扫不到任何总机`);
      return resolve([]);
    }

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        sock.close();
      } catch {
        /* 已经关了 */
      }
      resolve(sortCandidates([...seen.values()]));
    };

    sock.on('error', (e) => {
      // 广播发不出去（防火墙 / 没有网卡）不该让整个向导炸掉：如实回"一台都没扫到"
      console.warn(`[发现] UDP 出错：${e?.message ?? e}`);
      finish();
    });

    sock.on('message', (buf, rinfo) => {
      let msg;
      try {
        msg = JSON.parse(buf.toString('utf8'));
      } catch {
        return; // 不是 JSON —— 网段里别的东西，忽略
      }
      if (msg?.bandi !== 'announce') return;
      // ③ 只认自己这一轮发出去的那个 nonce（迟到包丢掉）
      if (msg.nonce !== nonce) return;
      const cand = candidateOf(msg, rinfo);
      if (!cand) return;
      seen.set(cand.instanceId, cand); // ① 按 instanceId 去重
    });

    sock.bind(() => {
      try {
        sock.setBroadcast(true);
      } catch (e) {
        console.warn(`[发现] 打不开广播权限：${e?.message ?? e}（多半是防火墙/权限，手填地址那条路仍然可用）`);
      }
      let left = rounds;
      const sendRound = () => {
        for (const t of targets) {
          try {
            sock.send(probe, 0, probe.length, port, t, () => {
              /* 单个目的地发不出去就算了（比如那张网卡没有网关），别的目的地继续 */
            });
          } catch {
            /* 同上 */
          }
        }
        left -= 1;
        if (left > 0 && !done) setTimeout(sendRound, roundMs);
        else setTimeout(finish, Math.min(roundMs, 400)); // 最后一轮再等一小会儿收尾
      };
      sendRound();
    });
  });
}

/**
 * 一条回包 → 一个候选。
 *
 * `address` **只取 `rinfo.address`**（回包的来源），端口取应答里的 `httpPort` ——
 * 这正是设计 §5.2 那条："不用应答里的 url（多网卡时它可能是别的网卡）"。
 */
function candidateOf(msg, rinfo) {
  const httpPort = Number(msg?.httpPort);
  const address = String(rinfo?.address ?? '').trim();
  if (!address) return null;
  if (!Number.isInteger(httpPort) || httpPort <= 0 || httpPort > 65535) return null;
  const instanceId = typeof msg?.instanceId === 'string' && msg.instanceId ? msg.instanceId : `addr:${address}:${httpPort}`;
  return {
    instanceId,
    label: msg?.label ? String(msg.label) : null, // 人起的名字（可能重名）
    hostname: msg?.hostname ? String(msg.hostname) : null, // 主机名（不重，界面上要三样都给）
    address,
    port: httpPort,
    url: `http://${address}:${httpPort}`,
    // 老总机不报 joinable：它既然在应答，就说明开关是开的 → 默认"可加入"
    joinable: msg?.joinable !== false,
    version: msg?.version ?? null,
    caps: Array.isArray(msg?.caps) ? msg.caps.map(String) : null,
    seenAt: new Date().toISOString(),
  };
}

/** 可加入的排前面；同组内按 url 稳定排序（界面上不会每次扫描都换顺序） */
function sortCandidates(list) {
  return list.sort((a, b) => Number(b.joinable) - Number(a.joinable) || String(a.url).localeCompare(String(b.url)));
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));
}
