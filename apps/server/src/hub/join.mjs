/*
 * hub/join.mjs —— 「活着时每 60 秒向中枢报一次到」+ 授权（allow/revoke）与状态。
 *
 * 机器接入（2026-11-07 起）只有一条路：**在本机登录页输中枢手机号密码**（登录即注册），
 * 设备当场登记进名册（hub/login.mjs → device-login）。曾经的 `bandi hub join` 设备码
 * 通道随中枢侧 enroll 端点一起退场 —— 它是为"主机没有浏览器"设计的，而登录页恰恰
 * 就是主机开着的页面。
 *
 * 这份文件剩下的都是**长活**：心跳、状态快照、授权表的放行/收回。
 */

import os from 'node:os';
import * as client from './client.mjs';
import { HubError } from './client.mjs';
import { clearHubConfig, readHubConfig, writeHubConfig } from './config.mjs';
import * as store from '../store.mjs';

/* ------------------------------------------------------------------ 心跳 */

/** @type {{ timer: NodeJS.Timeout|null, warned: boolean, revokedWarned: boolean, tick: (() => Promise<void>)|null }} */
const beat = { timer: null, warned: false, revokedWarned: false, tick: null };

/**
 * 启动心跳（幂等）。**失败了不拦启动** —— 中枢挂了、断网了，这台机器照样是一台完整的班底。
 *
 * 每轮都**重新读一次** `hub.json`，而不是启动时读一次常驻内存。两个原因：
 *   · 本机登录页写的 hub.json，服务进程原来还不知道 —— 60 秒内自己就跟上了，
 *     不用为了"刚加入"去重启一次服务；
 *   · `bandi hub leave` 删掉配置后，这边自然停下，不会往一个不认识自己的中枢白打请求。
 *
 * @param {{ dataDir: string, port?: number, version?: string|null, intervalMs?: number }} input
 * @returns {{ joined: boolean }}
 */
export function startHeartbeat({ dataDir, port, version = null, intervalMs = 60_000 }) {
  const joined = !!readHubConfig(dataDir);
  if (beat.timer) return { joined };

  const tick = async () => {
    const cfg = readHubConfig(dataDir);
    if (!cfg?.deviceId || !cfg?.deviceToken) return; // 还没在这台机器上登录过：这一轮什么都不做
    try {
      await client.heartbeat(cfg.baseUrl, {
        deviceId: cfg.deviceId,
        deviceToken: cfg.deviceToken,
        lanAddrs: client.lanAddrs(),
        port: port ?? cfg.port ?? undefined,
        version: version ?? undefined,
      });
      beat.warned = false;
      beat.revokedWarned = false;
    } catch (e) {
      const code = e instanceof HubError ? e.code : '';
      // 401 H2004 = 中枢那边已经把这台机器忘了（或者换了凭据）：重试一辈子也没用，说一次就够
      if (code === 'H2004' || code === 'H2003') {
        if (!beat.revokedWarned) {
          beat.revokedWarned = true;
          console.warn(`[中枢] 这台机器在中枢那边已经不存在了（${code}）。要重新接入：在本机登录页用中枢账号重新登录一次`);
        }
        return;
      }
      if (!beat.warned) {
        beat.warned = true;
        console.warn(`[中枢] 心跳没发出去（不影响本机使用，下一轮再试）：${e?.message ?? e}`);
      }
      return;
    }
  };

  // 先立刻报一次：刚重启的那 60 秒里，手机上看到的应该是"在线"，而不是等一分钟
  beat.tick = tick;
  void tick();
  beat.timer = setInterval(() => void tick(), intervalMs);
  // 不让心跳把进程钉在事件循环里（命令行里跑完就该能退出）
  beat.timer.unref?.();
  return { joined };
}

/**
 * 立刻报一次（不等下一个 60 秒）。
 * 刚登录绑定完设备身份时调一次 —— 用户下一秒就会去手机上看名册，
 * 让他对着「在线/离线」猜一分钟是没有意义的。
 */
export function poke() {
  if (beat.tick) void beat.tick();
}

export function stopHeartbeat() {
  if (beat.timer) clearInterval(beat.timer);
  beat.timer = null;
}

/* ------------------------------------------------------------------ 状态 */

/** `bandi hub status` 用的快照 */
export function hubStatus(dataDir) {
  const cfg = readHubConfig(dataDir);
  const links = store.listHubLinks();
  if (!cfg) return { joined: false, links };
  return {
    joined: true,
    baseUrl: cfg.baseUrl,
    deviceId: cfg.deviceId,
    name: cfg.name ?? null,
    accountId: cfg.accountId ?? null,
    claimPending: !!cfg.claimPending,
    joinedAt: cfg.joinedAt ?? null,
    port: cfg.port ?? null,
    publicKey: cfg.publicKey,
    links,
  };
}

/** 退出中枢：只删「加入」这件事，**不动授权表**（谁被允许进来是另一件事） */
export function leave(dataDir) {
  const had = !!readHubConfig(dataDir);
  clearHubConfig(dataDir);
  stopHeartbeat();
  return had;
}

/* -------------------------------------------------------------- 授权表 */

/**
 * 放行一个中枢账号进这台机器（`bandi hub allow`）。
 *
 * 为什么这条必须是**本机命令**而不是中枢上的一个开关：中枢被攻破时，攻击者已经能
 * 伪造任意账号的票；如果"谁能进这台机器"也由中枢说了算，那道闸就等于不存在。
 * 所以放行只能在这台机器的 shell 里做（能跑命令的人 = 已经能碰这台机器的人）。
 *
 * @param {{ accountId: string, userId?: string|null }} input
 * @returns {{ accountId: string, userId: string, userName: string }}
 */
export function allowAccount({ accountId, userId = null }) {
  const id = String(accountId ?? '').trim();
  if (!id) throw new HubError('E7120', '要指定中枢账号 id（`bandi hub status` 里能看到待确认的那个）');
  const user = userId ? store.getUser(String(userId)) : store.firstUser();
  if (!user) {
    throw new HubError(
      'E7121',
      userId ? `这台机器上没有这个用户：${userId}` : '这台机器还没有任何账号，先用中枢账号登录一次（会自动建），或 bandi user create <名字> 预占',
    );
  }
  store.linkHubAccount({ accountId: id, userId: user.id });
  return { accountId: id, userId: user.id, userName: user.name };
}

/** @param {string} accountId */
export function revokeAccount(accountId) {
  return store.removeHubLink(String(accountId ?? '').trim());
}
