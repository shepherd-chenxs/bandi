/* security/local-secret.mjs —— 「我在这台机器的本机终端上」的**文件证明**（IAM §5.2 / §10.1.3）。
 *
 * 为什么不能用 IP 证明：反代（nginx / cloudflared / frp）一转，服务端看到的所有 peer
 * 都是 127.0.0.1，来源 IP 就不再是证据（那正是 v2 评审抓到的 P0）。
 * 换成"读得到这个文件" —— 数据目录下 `local_secret`（0600，首次启动生成）：
 *   · 能读到它的进程，本来就能改数据库，授权上没有额外损失；
 *   · 反代转发**携带不了**这个头（除非运维主动配置，那时审计里会留痕）。
 *
 * 三条口径（与 IAM §8.3 的 `secret` 三档对应）：
 *   · `'loopback'` 来源**不要**这个头（单机形态零摩擦，本机脚本一个字节不用改）；
 *   · `'network'` 来源**要**（服务器形态由 CLI 读文件带头，浏览器不渲染破坏性按钮）；
 *   · `BANDI_LOCAL_SECRET=off` 关掉整套（只给"反代已 deny 破坏性路径"的部署用，启动打 warning）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir, localSecretDisabled } from '../config.mjs';
import { isLoopbackHost } from './source.mjs';
import { SERVER } from '../server-state.mjs';

export const HEADER = 'x-bandi-local';
export const FILE = path.join(dataDir, 'local_secret');

let cached = '';

/**
 * 读 / 生成。幂等：文件在就用它（重启后旧脚本带来的头继续有效）。
 * 写不下去（只读文件系统 / 权限）**不抛**：只是这台机器上没人能证明"我在本机"，
 * 破坏性动作一律 `E4097` —— 比启动不了好，也比静默放行好。
 */
export function ensure() {
  if (localSecretDisabled) return '';
  if (cached) return cached;
  try {
    const saved = fs.readFileSync(FILE, 'utf8').trim();
    if (saved) {
      cached = saved;
      return cached;
    }
  } catch { /* 还没有这个文件 —— 下面生成 */ }
  const v = crypto.randomBytes(32).toString('base64url');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(FILE, `${v}\n`, { encoding: 'utf8', mode: 0o600 });
    cached = v;
    return cached;
  } catch (e) {
    console.warn(`[安全] 生成 local_secret 失败（破坏性本机动作将一律拒绝）：${e?.message ?? e}`);
    return '';
  }
}

/** 已经在内存里的值（没 ensure 过就是空串） */
export function value() {
  return cached;
}

/** 这套机制现在要不要生效（给 `/api/state` 与前端显隐用） */
export function mode() {
  if (localSecretDisabled) return 'off';
  return !isLoopbackHost(SERVER.boundHost) ? 'required' : 'not-required';
}

/** 请求头里的秘密对不对（定长比较，别泄漏"比到第几个字符不同"） */
export function check(req) {
  if (localSecretDisabled) return true; // 逃生口：整套关掉，调用方按"有秘密"处理
  const expected = ensure();
  if (!expected) return false;
  const got = String(req?.headers?.[HEADER] ?? '').trim();
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
