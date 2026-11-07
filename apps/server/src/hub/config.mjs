/*
 * hub/config.mjs —— 这台机器「加入了哪个中枢」的本地配置（`<数据目录>/hub.json`，0600）。
 *
 * 只有五样东西，一样都不许多：
 *   baseUrl     中枢地址
 *   deviceId    中枢给这台机器的编号（票据里的 dev，主机必须核对就是自己）
 *   deviceToken 这台机器的长期凭据（只够发心跳，换不出会话）
 *   publicKey   中枢的**签名公钥**，加入时钉进本地 —— 之后不再从网上拉
 *   accountId   这台机器绑定的中枢账号（登录页首次登录时那个人）
 *
 * 为什么公钥要落盘而不是每次去中枢拉：拉一次就等于把「谁能给我发身份证」的
 * 决定权交给了网络对面。落盘 = 第一次握手时信任谁就一直是它，中枢被换掉/域名被
 * 劫持，主机这边验不过票，也不会悄悄改信新钥匙。
 *
 * 写文件走「临时文件 + rename」，避免断电时留半个 JSON（那时这台机器就再也
 * 读不出自己的配置了，比丢配置更难受）。
 */

import fs from 'node:fs';
import path from 'node:path';

/** @param {string} dataDir */
export function hubConfigPath(dataDir) {
  return path.join(dataDir, 'hub.json');
}

/** @param {string} dataDir @returns {null | { baseUrl: string, deviceId: string, deviceToken: string, publicKey: string, accountId?: string|null, claimPending?: boolean, name?: string, joinedAt?: string }} */
export function readHubConfig(dataDir) {
  try {
    const raw = fs.readFileSync(hubConfigPath(dataDir), 'utf8');
    const cfg = JSON.parse(raw);
    if (!cfg?.baseUrl || !cfg?.deviceId) return null;
    return cfg;
  } catch {
    return null;
  }
}

/** @param {string} dataDir @param {object} cfg */
export function writeHubConfig(dataDir, cfg) {
  const file = hubConfigPath(dataDir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* Windows 上 chmod 是尽力而为 */ }
  return file;
}

/** 退出中枢：删掉配置（票据、链接表另算 —— 那边是「谁被允许进来」，与「加没加入」无关） */
export function clearHubConfig(dataDir) {
  try {
    fs.rmSync(hubConfigPath(dataDir), { force: true });
  } catch { /* 没有就算删过了 */ }
}

/** 把用户手输的地址收拾成 `https://host[:port]`（去掉尾斜杠、补协议） */
export function normalizeHubUrl(input) {
  let s = String(input ?? '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

/**
 * 这台机器连哪个中枢（2026-11-07 起**开箱即用，且只有这一条登录路**）。
 *
 * 优先级：`BANDI_HUB` 环境变量 → `<数据目录>/hub.json` 里记的 → 内置默认值。
 * 用户**什么都不用配**：打开桌面 App 就是中枢的账号密码登录页。
 *
 * ⚠️ 没有"关掉中枢"这个选项了（2026-11-07）：本机账号体系已整体退场，
 * 中枢是唯一的登录方式 —— 关掉它等于没人能进这台机器。`BANDI_HUB` 现在
 * 只用来改地址（调试/自建指向）。
 */
export const DEFAULT_HUB_URL = 'https://hub.yuancang.space';

/** @returns {string} 中枢地址（永远非空） */
export function hubBaseUrl(dataDir) {
  const env = String(process.env.BANDI_HUB ?? '').trim();
  if (env) return normalizeHubUrl(env);
  const cfg = readHubConfig(dataDir);
  if (cfg?.baseUrl) return normalizeHubUrl(cfg.baseUrl);
  return DEFAULT_HUB_URL;
}
