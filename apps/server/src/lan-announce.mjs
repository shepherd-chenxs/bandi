/**
 * 总机侧：**UDP 8788 应答器**（2026-10-20，设计 §5.5 / §13.3）。
 *
 * 只有一个职责：有人（另一台机器上的班底）广播探测时，回一条"我在这儿、能不能加入"。
 * 它的开关**就是**「允许局域网内的机器加入」那个开关（PRD P0-1：开关仍是唯一总闸）：
 *   · 开关关掉 → **立刻停掉 bind**，于是"关掉之后不再出现在候选里"是立刻成立的（不用重启）；
 *   · 开关打开但进程实际还听着回环（还没点重启）→ 也不应答 —— 因为别的机器**根本连不进来**，
 *     回了它也没用（向导里那条"（未开局域网）"就是靠这个 `joinable`/无应答分辨的）。
 *
 * 端口占用 / 防火墙拦着 → **只 `console.warn`，不抛**：发现服务坏了不该让控制面起不来，
 * 手填地址那条路（PRD 里明确要求能独立走通）也照样可用。
 */
import dgram from 'node:dgram';
import { DISCOVERY_PORT } from './discover.mjs';
import * as localMode from './local-mode.mjs';
import { isJoinable } from './netmode.mjs';

/** 一条应答 ≤ 600 字节（< MTU，不触发分片；设计 §13.3） */
const MAX_PACKET = 600;

/** 当前这个应答器：`null` = 没开（开关关着，或监听在回环上） */
let sock = null;
/** 它代表的那台总机正在监听哪个 HTTP 端口（0 = 还没听） */
let httpPortOfHost = 0;
/**
 * `sync()` 最后一次收到的那组判定参数（2026-10-20 增量 1，设计 §1.2）。
 * `announcePayload()` 算 `joinable` 时用它们调 `netmode.isJoinable()` ——
 * 判定与 `/api/hello` **共源**（socket 还活着本身就保证这组值算出来是 true，
 * 换源不是改行为，是消灭第二份判定逻辑）。
 */
let lastSync = { allowLan: false, explicit: false, boundHost: '127.0.0.1' };

/**
 * 现在开着吗、听在哪个端口、代表哪个 HTTP 端口。
 * 给 `/api/lan` 与启动日志用 —— 状态是"真的在 bind 吗"，不是"开关想开吗"。
 */
export function state() {
  return { on: !!sock, port: sock ? DISCOVERY_PORT : 0, httpPort: httpPortOfHost || null };
}

/**
 * 按当前开关与**实际监听地址**原地启停（**幂等**：同样参数连着调几次，结果一样）。
 *
 * `on = allowLan && !isLoopback(boundHost)` —— 两个条件缺一不可：
 *   · 开关关着 = 用户不想让别人发现；
 *   · 只监听回环 = 就算发现了也连不上（而且此时鉴权是关的，回应答毫无意义）。
 *
 * @param {object} opts
 * @param {boolean} opts.allowLan  `netmode.readNetMode().allowLan`（**开关值**）
 * @param {boolean} opts.explicit  监听地址是否被 `BANDI_HOST` 显式指定（与 `/api/lan` 同口径）
 * @param {string}  opts.boundHost 这个进程**现在**实际监听的地址（`boundHost`，不是配置里的）
 * @param {number}  opts.httpPort  控制面自己的 HTTP 端口
 */
export function sync({ allowLan, explicit, boundHost, httpPort } = {}) {
  const on = !!allowLan && !isLoopback(boundHost);
  // 存下来给 announcePayload 算 joinable 用（isJoinable 的判定输入必须与 hello 同一组）
  lastSync = {
    allowLan: allowLan === true,
    explicit: explicit === true,
    boundHost: typeof boundHost === 'string' && boundHost ? boundHost : '127.0.0.1',
  };
  const port = Number(httpPort) > 0 ? Math.round(Number(httpPort)) : 0;

  if (!on) {
    stop();
    httpPortOfHost = port;
    return state();
  }

  // 已经在跑、而且代表的端口没变 → 什么都不做（幂等）
  if (sock && httpPortOfHost === port) return state();

  stop();
  httpPortOfHost = port;
  bind();
  return state();
}

/** 停掉（没开也算成功） */
export function stop() {
  const s = sock;
  sock = null;
  if (!s) return state();
  try {
    s.close();
  } catch {
    /* 已经关了 */
  }
  return state();
}

/** 真去 bind。任何失败都只告警 —— 见文件头。 */
function bind() {
  let s;
  try {
    // `reuseAddr`：控制面被"原地重启"时新旧两个 socket 会短暂并存（server.close 是异步的）
    s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  } catch (e) {
    console.warn(`[发现] 开不了 UDP 套接字：${e?.message ?? e}（不影响控制面；手填地址仍可用）`);
    return;
  }

  let closed = false;
  const shutdown = (why) => {
    if (closed) return;
    closed = true;
    if (sock === s) sock = null;
    try {
      s.close();
    } catch {
      /* 已经关了 */
    }
    if (why) console.warn(`[发现] UDP ${DISCOVERY_PORT} ${why}（不影响控制面；手填地址仍可用）`);
  };

  s.on('error', (e) => shutdown(`出错：${e?.message ?? e}`));

  s.on('message', (buf, rinfo) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString('utf8'));
    } catch {
      return; // 不是 JSON：网段里别的东西
    }
    if (msg?.bandi !== 'discover') return;
    if (msg.v !== 1) return; // 协议版本不认识：宁可不回，也别回一个对面读不懂的包
    const nonce = typeof msg.nonce === 'string' ? msg.nonce : '';
    const payload = announcePayload(nonce);
    s.send(Buffer.from(payload, 'utf8'), 0, Buffer.byteLength(payload), rinfo.port, rinfo.address, () => {
      /* 回不出去就算了（对方可能已经关了套接字） */
    });
  });

  s.once('listening', () => {
    console.log(`[发现] UDP ${DISCOVERY_PORT} 已应答（让局域网里的机器能发现这台总机）`);
  });

  /*
   * ⚠️ `sock` **在 bind 之前就赋值**：bind 是异步的（`listening` 事件要等下一轮循环），
   * 而 `sync()` 的返回值立刻会被 `/api/lan` 读走 —— 晚一个 tick 赋值，界面就会看到
   * "开关开着但 discovery.on:false"，那正是这次要修的谎报。bind 失败时 `shutdown()` 会清掉它。
   */
  sock = s;
  try {
    s.bind(DISCOVERY_PORT);
  } catch (e) {
    shutdown(`bind 失败：${e?.message ?? e}`);
  }
}

/**
 * 应答体（设计 §13.3）。字段与 `GET /api/hello` **同源** —— 这些信息本来就对局域网可见
 * （PRD P0-1 已经这么定），所以这里不带任何秘密。
 */
function announcePayload(nonce) {
  const id = localMode.nodeIdentity();
  const p = {
    bandi: 'announce',
    v: 1,
    nonce,
    instanceId: localMode.instanceId(),
    label: id.label,
    hostname: id.hostname,
    httpPort: httpPortOfHost,
    allowLan: true, // 能应答就说明开关是开的（sync 的门控保证）
    /*
     * joinable 判定与 `/api/hello` **共源**（2026-10-20 增量 1，设计 §1.2）：调同一个
     * `netmode.isJoinable()`。实际值在这里恒为 true —— sync 的门控
     * `allowLan && !isLoopback(boundHost)` 已经保证了 —— 换它不为改行为，
     * 是为了以后只改判定那一处、两份出口不会漂移。
     */
    joinable: isJoinable({ ...lastSync }),
    version: localMode.platformVersion(),
    caps: ['scope'],
    proto: 1,
  };
  let json = JSON.stringify(p);
  if (Buffer.byteLength(json) > MAX_PACKET) {
    // 超了先截短名字，再不行就把两个名字都去掉 —— **宁可少给，也不分片**
    p.label = String(p.label ?? '').slice(0, 40);
    p.hostname = String(p.hostname ?? '').slice(0, 40);
    json = JSON.stringify(p);
  }
  if (Buffer.byteLength(json) > MAX_PACKET) {
    delete p.label;
    delete p.hostname;
    json = JSON.stringify(p);
  }
  return json;
}

/** 监听地址是回环吗（与 `auth.isLoopbackHost` / `netmode.isLoopback` 同一口径） */
function isLoopback(host) {
  const h = String(host ?? '').trim().toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]' || h.startsWith('127.');
}
