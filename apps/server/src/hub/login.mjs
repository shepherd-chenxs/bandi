/*
 * hub/login.mjs —— 本机登录页上那一次「账号密码 → 中枢」的转发（2026-11-07）。
 *
 * 快速开发阶段的口径：**用户只看见一个登录框**，不跳转、不印设备码、不跑终端命令。
 * 页面由主机自己渲染，表单 POST 到本机 `/hub/login`，这里再把它转给中枢：
 *
 *   本机登录页 → POST /hub/login → 中枢 POST /v1/auth/device-login
 *                                  ← 票 + 本机设备身份 + 账号信息
 *              ← 验票（本地钉住的公钥）→ 写 hub.json → 发本机会话 → 进面板
 *
 * 主机不存密码、不建账号：认人这件事一直只有中枢一个地方做。这里得到的票当场验、
 * 当场用掉（jti 一次性），不落盘 —— 落了盘就等于在主机上又养一份凭据。
 */

import os from 'node:os';
import * as client from './client.mjs';
import { HubError } from './client.mjs';
import { hubBaseUrl, readHubConfig, writeHubConfig } from './config.mjs';
import { verifyTicket, VERIFY_ERRORS } from './verify.mjs';

/**
 * @param {object} input
 * @param {string} input.dataDir
 * @param {string} input.username
 * @param {string} input.password
 * @param {'login'|'register'} [input.mode]
 * @param {number} [input.port]
 * @param {string|null} [input.version]
 * @returns {Promise<{ account: { id: string, login: string, name: string|null }, cfg: any, payload: any }>}
 */
export async function loginThroughHub({ dataDir, username, password, mode = 'login', port, version = null }) {
  const cfg = readHubConfig(dataDir);
  const baseUrl = hubBaseUrl(dataDir);

  const name = String(cfg?.name || os.hostname() || 'bandi').slice(0, 60);
  const res = await client.deviceLogin(baseUrl, {
    username,
    password,
    mode,
    // 第二次之后的登录把设备身份带上：中枢据此复用同一行名册，而不是每次多一台机器
    deviceId: cfg?.deviceId ?? null,
    deviceToken: cfg?.deviceToken ?? null,
    name,
    version,
    port,
    scheme: 'http',
  });

  /*
   * 公钥：**已经钉过的一律以本地为准**。
   * 如果中枢这次返回的公钥和本地不一样，说明它换了签名密钥（或者我们连错了中枢）——
   * 这时候默默改信新钥匙，等于把「谁能给我发身份证」的决定权交给了网络对面。
   * 换钥匙的正确做法是人为确认一次：`bandi hub leave` 再登录。
   */
  const pinned = String(cfg?.publicKey ?? '').trim();
  const fetched = String(res?.publicKey ?? '').trim();
  if (pinned && fetched && pinned !== fetched) {
    throw new HubError('E7113', '中枢的签名密钥变了（重新登录前先确认这次换钥匙是你做的：bandi hub leave）');
  }
  const publicKey = pinned || fetched || (await client.fetchPublicKey(baseUrl));

  const v = verifyTicket(res.ticket, publicKey, { deviceId: res.deviceId });
  if (!v.ok) {
    const e = VERIFY_ERRORS[v.reason] ?? { code: 'E7001', message: '中枢签的连接凭据无效' };
    throw new HubError(e.code, `${e.message}（${v.reason}）`);
  }

  const next = {
    ...(cfg ?? {}),
    baseUrl,
    deviceId: String(res.deviceId),
    deviceToken: String(res.deviceToken),
    publicKey,
    accountId: res.account?.id ?? null,
    name,
    port: port ?? cfg?.port ?? null,
    joinedAt: cfg?.joinedAt ?? new Date().toISOString(),
  };
  writeHubConfig(dataDir, next);

  return {
    account: { id: String(res.account.id), login: String(res.account.login), name: res.account.name ?? null },
    cfg: next,
    payload: v.payload,
  };
}
