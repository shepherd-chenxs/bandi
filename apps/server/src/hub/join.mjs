/*
 * hub/join.mjs —— 「这台机器加入中枢」与「活着时每 60 秒报一次到」。
 *
 * 加入为什么这么绕：**主机没有浏览器**。它不能开一个 OAuth 页面让人扫（那要屏幕），
 * 也不能把账号密码拿过来存（那等于在中枢之外又养一份密码）。契约 §四 的解法是设备码：
 *
 *   主机取码 → 终端印出来 → 人在手机/电脑上（已经登录中枢）输入 → 主机轮询拿到凭据
 *
 * 所以 `join()` 是个**会停在那儿等人**的函数：打印码、每 2 秒问一次、5 分钟没批就放弃。
 * 这中间用户随时 Ctrl+C，不留半份配置（配置只在批准之后才落盘）。
 *
 * 批准之后还要做一件事：把批准这次加入的**中枢账号**绑到本机的一个用户上（`hub_links`）。
 * 那是「授权在主机」这条规则的起点 —— 之后别人拿有效票据进来，还得这张表里也有他。
 */

import os from 'node:os';
import * as client from './client.mjs';
import { HubError } from './client.mjs';
import { clearHubConfig, normalizeHubUrl, readHubConfig, writeHubConfig } from './config.mjs';
import { isValidPublicKey } from './verify.mjs';
import * as store from '../store.mjs';

const POLL_INTERVAL_MS = 2000;
const DEFAULT_WAIT_MS = 5 * 60_000;

/**
 * 加入中枢。
 *
 * @param {object} input
 * @param {string} input.dataDir
 * @param {string} input.hubUrl            中枢地址（`https://hub.example.com`）
 * @param {string} [input.name]            名册上显示的名字，默认主机名
 * @param {string} [input.pubkey]          手输公钥（不填就从中枢取一次）
 * @param {number} [input.port]            本机 HTTP 端口（手机点进来用的那个）
 * @param {string|null} [input.version]
 * @param {number} [input.waitMs]
 * @param {(info: { code: string, hubUrl: string, expiresAt: number, hint?: string }) => void} [input.onCode]
 * @param {(ms: number) => Promise<void>} [input.sleep]  测试用
 * @returns {Promise<{ deviceId: string, accountId: string|null, baseUrl: string, name: string, linkedUser: string|null, claimPending: boolean, publicKeySource: 'given'|'fetched' }>}
 */
export async function join({
  dataDir,
  hubUrl,
  name,
  pubkey,
  port,
  version = null,
  waitMs = DEFAULT_WAIT_MS,
  onCode,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const baseUrl = normalizeHubUrl(hubUrl);
  if (!baseUrl) throw new HubError('E7110', `中枢地址不对：${hubUrl ?? '(空)'}（要给 https://… 或 http://…）`);

  const deviceName = String(name || os.hostname() || 'bandi').slice(0, 60);
  const addrs = client.lanAddrs();

  const got = await client.enroll(baseUrl, {
    name: deviceName,
    platform: process.platform,
    version,
    lanAddrs: addrs,
    scheme: 'http',
    port,
  });

  onCode?.({ code: got.code, hubUrl: baseUrl, expiresAt: got.expiresAt, hint: got.hint });

  const deadline = Date.now() + Math.min(waitMs, Math.max(0, (got.expiresAt ?? 0) * 1000 - Date.now() || waitMs));
  /** @type {any} */
  let approved = null;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    let r;
    try {
      r = await client.pollEnroll(baseUrl, { code: got.code, pollToken: got.pollToken });
    } catch (e) {
      // 码过期 / 被别的账号抢走：这两种没有重试的意义，原样往上抛
      if (e instanceof HubError && (e.code === 'H2001' || e.code === 'H2002')) throw e;
      // 网络抖一下：接着等，人还在输码
      continue;
    }
    if (r?.status === 'approved') {
      approved = r;
      break;
    }
  }
  if (!approved) throw new HubError('E7111', '等太久了：设备码没人确认（回到中枢页面重新来一次）');

  // 公钥：给了就用给的（离线/自签场景），否则**只在这一次**从中枢取，之后钉在本地
  let publicKey = String(pubkey ?? '').trim();
  let publicKeySource = 'given';
  if (!publicKey) {
    publicKey = await client.fetchPublicKey(baseUrl);
    publicKeySource = 'fetched';
  }
  if (!isValidPublicKey(publicKey)) {
    throw new HubError('E7112', '中枢公钥格式不对（要是 base64url 的 32 字节 Ed25519 公钥）');
  }

  const cfg = {
    baseUrl,
    deviceId: String(approved.deviceId),
    deviceToken: String(approved.deviceToken),
    publicKey,
    accountId: approved.accountId ?? null,
    // 中枢没告诉我们是谁批的（老版本 /v1），那第一次进门时认领 —— 见 routes/hub.mjs
    claimPending: !approved.accountId,
    name: deviceName,
    port: port ?? null,
    joinedAt: new Date().toISOString(),
  };
  writeHubConfig(dataDir, cfg);

  // 把批准人绑到本机主人：**只有存在本地用户时才绑**，零账号的机器先留空
  let linkedUser = null;
  if (cfg.accountId) {
    const owner = store.firstUser();
    if (owner) {
      store.linkHubAccount({ accountId: cfg.accountId, userId: owner.id, login: approved.login ?? null });
      linkedUser = owner.id;
    }
  }

  return {
    deviceId: cfg.deviceId,
    accountId: cfg.accountId,
    baseUrl,
    name: deviceName,
    linkedUser,
    claimPending: cfg.claimPending,
    publicKeySource,
  };
}

/* ------------------------------------------------------------------ 心跳 */

/** @type {{ timer: NodeJS.Timeout|null, warned: boolean, revokedWarned: boolean }} */
const beat = { timer: null, warned: false, revokedWarned: false };

/**
 * 启动心跳（幂等）。**失败了不拦启动** —— 中枢挂了、断网了，这台机器照样是一台完整的班底。
 *
 * 每轮都**重新读一次** `hub.json`，而不是启动时读一次常驻内存。两个原因：
 *   · `bandi hub join` 是 CLI 写的配置，服务进程还不知道 —— 60 秒内自己就跟上了，
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
    if (!cfg) return; // 没加入（或刚退出）：这一轮什么都不做
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
          console.warn(`[中枢] 这台机器在中枢那边已经不存在了（${code}）。要重新加入：bandi hub join <地址>`);
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
  void tick();
  beat.timer = setInterval(() => void tick(), intervalMs);
  // 不让心跳把进程钉在事件循环里（命令行里跑完就该能退出）
  beat.timer.unref?.();
  return { joined };
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
      userId ? `这台机器上没有这个用户：${userId}` : '这台机器还没有任何账号，先建一个：bandi user create <名字> --admin',
    );
  }
  store.linkHubAccount({ accountId: id, userId: user.id });
  return { accountId: id, userId: user.id, userName: user.name };
}

/** @param {string} accountId */
export function revokeAccount(accountId) {
  return store.removeHubLink(String(accountId ?? '').trim());
}
