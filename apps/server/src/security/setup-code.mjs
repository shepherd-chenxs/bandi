/* security/setup-code.mjs —— 「第一个管理员」的引导码（IAM §8.6）。
 *
 * 问题：`POST /api/users` 在**库里没有账号**时是免令牌的（登录页要能建第一个账号），
 * 于是服务器形态下"谁先连上谁就是管理员"—— 公网上这就是一个公开的抢注口。
 *
 * 解法：服务器形态（监听非回环 / 声明了 trustProxy）且**零账号**时，生成一份
 * `<数据目录>/setup_code`（0600，首次启动一次），建号必须带 `X-Bandi-Setup: <内容>`。
 *   · 只有能读到数据目录的人（= 运维、= 本来就是这台机器的主人）才拿得到；
 *   · 建成第一个管理员后**立刻删文件**，避免它变成第二个后门；
 *   · 单机形态（回环）不生成、不校验 —— "开机建账号"的既有体验一个字节没变。
 *   · 运维也可以完全不管这个文件：用 CLI `bandi user create <名字> --admin` 建号（同一套接口）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir, trustProxy } from '../config.mjs';
import * as store from '../store.mjs';
import { isLoopbackHost } from './source.mjs';
import { SERVER } from '../server-state.mjs';

export const HEADER = 'x-bandi-setup';
export const FILE = path.join(dataDir, 'setup_code');

/** 现在是不是"服务器形态且还没有账号"（只有这种状态才需要引导码） */
export function needed() {
  return (trustProxy || !isLoopbackHost(SERVER.boundHost)) && !store.hasUsers();
}

/** 需要就生成；不需要就把残留文件删掉（比如账号已经建好了） */
export function sync() {
  if (!needed()) {
    try {
      fs.rmSync(FILE, { force: true });
    } catch { /* 删不掉不算错 */ }
    return null;
  }
  try {
    const saved = fs.readFileSync(FILE, 'utf8').trim();
    if (saved) return saved;
  } catch { /* 下面生成 */ }
  const v = crypto.randomBytes(18).toString('base64url');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(FILE, `${v}\n`, { encoding: 'utf8', mode: 0o600 });
    return v;
  } catch (e) {
    console.warn(`[安全] 生成 setup_code 失败（服务器形态下将无法建第一个账号，请用 CLI）：${e?.message ?? e}`);
    return null;
  }
}

/** 请求头里的引导码对不对（定长比较） */
export function check(req) {
  const expected = sync() ?? '';
  if (!expected) return false;
  const got = String(req?.headers?.[HEADER] ?? '').trim();
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** 建成之后调用：文件使命结束 */
export function consume() {
  try {
    fs.rmSync(FILE, { force: true });
  } catch { /* 删不掉：下次启动 sync() 也会删（那时已经有账号了） */ }
}
