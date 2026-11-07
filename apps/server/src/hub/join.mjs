/*
 * hub/join.mjs —— 「活着时每 60 秒向中枢报一次到」+ 状态快照与退出。
 *
 * 机器接入（2026-11-07 起）只有一条路：**在本机登录页输中枢手机号密码**（登录即注册），
 * 设备当场登记进名册（hub/login.mjs → device-login）。曾经的 `bandi hub join` 设备码
 * 通道随中枢侧 enroll 端点一起退场 —— 它是为"主机没有浏览器"设计的，而登录页恰恰
 * 就是主机开着的页面。
 *
 * 曾经的「授权表」allow/revoke（bandi hub allow 放行账号进本机）随「登录即放行」
 * 一起退场（2026-11-07 用户拍板：用户不会去主机上跑命令）—— 中枢验过人，本机就认，
 * 每个中枢账号首次进门自动建自己的影子账号（见 routes/hub.mjs 的 bindHubAccount）。
 *
 * 这份文件剩下的都是**长活**：心跳、状态快照、退出。
 */

import os from 'node:os';
import * as client from './client.mjs';
import { HubError } from './client.mjs';
import { clearHubConfig, readHubConfig, writeHubConfig } from './config.mjs';
import * as store from '../store.mjs';

/* ------------------------------------------------------------------ 心跳 */

/** @type {{ timer: NodeJS.Timeout|null, warned: boolean, revokedWarned: boolean, tick: (() => Promise<void>)|null, onBeat: ((dataDir: string) => void)|null }} */
const beat = { timer: null, warned: false, revokedWarned: false, tick: null, onBeat: null };

/**
 * 启动心跳（幂等）。**失败了不拦启动** —— 中枢挂了、断网了，这台机器照样是一台完整的班底。
 *
 * 每轮都**重新读一次** `hub.json`，而不是启动时读一次常驻内存。两个原因：
 *   · 本机登录页写的 hub.json，服务进程原来还不知道 —— 60 秒内自己就跟上了，
 *     不用为了"刚加入"去重启一次服务；
 *   · `bandi hub leave` 删掉配置后，这边自然停下，不会往一个不认识自己的中枢白打请求。
 *
 * @param {{ dataDir: string, port?: number, version?: string|null, intervalMs?: number, onBeat?: ((dataDir: string) => void)|null }} input
 * @returns {{ joined: boolean }}
 */
export function startHeartbeat({ dataDir, port, version = null, intervalMs = 60_000, onBeat = null }) {
  const joined = !!readHubConfig(dataDir);
  beat.onBeat = onBeat ?? null;
  if (beat.timer) return { joined };

  const tick = async () => {
    const cfg = readHubConfig(dataDir);
    if (!cfg?.deviceId || !cfg?.deviceToken) return; // 还没在这台机器上登录过：这一轮什么都不做
    try {
      const res = await client.heartbeat(cfg.baseUrl, {
        deviceId: cfg.deviceId,
        deviceToken: cfg.deviceToken,
        lanAddrs: client.lanAddrs(),
        port: port ?? cfg.port ?? undefined,
        version: version ?? undefined,
      });
      /*
       * 顺带收下中枢改派的 relay（2026-11-07 外网访问）：开通、换子域名、吊销，
       * 都走这一条已经存在的通道 —— 不新增轮询、不要求用户重启。
       *
       * 「有这个字段」和「字段是 null」是两件事：前者=中枢在管这件事，后者=**撤销**。
       * 所以判据是 `hasOwnProperty`，不是 `if (res.relay)`。
       */
      if (res && Object.prototype.hasOwnProperty.call(res, 'relay')) {
        const fresh = readHubConfig(dataDir); // 这一轮里登录页可能刚写过，别拿旧快照盖回去
        const next = res.relay ?? null;
        if (fresh && JSON.stringify(fresh.relay ?? null) !== JSON.stringify(next)) {
          try {
            writeHubConfig(dataDir, { ...fresh, relay: next });
          } catch { /* 写不进去：这一轮仍旧用旧配置，下一轮再来 */ }
        }
      }
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
    // 心跳成功 = 手里这份 relay 是最新的：让隧道那边收敛一次（没变化时是空转）
    try {
      beat.onBeat?.(dataDir);
    } catch (e) {
      console.warn(`[外网] 隧道收敛失败（不影响本机使用）：${e?.message ?? e}`);
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

/** 退出中枢：只删「加入」这件事（配置与心跳），不动影子账号与已发的会话 */
export function leave(dataDir) {
  const had = !!readHubConfig(dataDir);
  clearHubConfig(dataDir);
  stopHeartbeat();
  return had;
}
