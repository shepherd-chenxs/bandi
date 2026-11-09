/**
 * 这台机器的**形态**（2026-11-03 用户拍板，"对外服务"这一维**整个删除**）：
 *
 *   · 监听地址 —— **永远对外**（默认 `0.0.0.0`，`BANDI_HOST` 可覆盖成具体地址）。
 *     手机 / 浏览器永远连得进来；这是启动配置（部署 / 桌面壳）的事，界面上没有开关、
 *     没有「重启生效」、没有「只在本机使用」—— 曾经的 `allowLan` 键连同那套
 *     "改了还没生效"机制一起删掉了（配置总会有遗漏，漏出来的必须是安全的那边）。
 *   · `pairEnabled` —— 已随手机配对体系整体退场（2026-11-07），老配置里留着也忽略。
 *
 * 多机节点子系统（`acceptNodes` 总机/分机角色）已于 2026-11-09 整体删除 ——
 * 老配置文件里若还留着 `acceptNodes` 键，读的时候直接忽略。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir } from './config.mjs';

const FILE = path.join(dataDir, 'netmode.json');

/*
 * mtime 缓存（2026-11-03）：网络周界闸（security/ipallow.mjs）挂在**每个请求**的入口上，
 * 每请求 readFileSync 一遍太奢侈 —— 按 mtime 缓存，文件没动就不重读；
 * `writeNetMode` 写完顺手把缓存种上（同毫秒内写后读也不会拿到旧值）。
 * 外部直接改文件（手救现场 / smoke 种配置）靠 mtime 变化自动失效 ✓。
 */
let cache = null; // { mtimeMs, value }

export function readNetMode() {
  let st = null;
  try {
    st = fs.statSync(FILE);
  } catch {
    st = null; // 没这个文件 = 默认
  }
  if (cache && st && cache.mtimeMs === st.mtimeMs) return cache.value;
  let j = {};
  try {
    j = JSON.parse(fs.readFileSync(FILE, 'utf8')) ?? {};
  } catch {
    j = {}; // 坏了 = 默认，口径与"没有文件"一致
  }
  /*
   * `whitelistEnabled` / `whitelistIps`（2026-11-03，对齐 1Panel 安全页的「授权 IP」）：
   * **网络周界闸** —— 开启后名单之外的 IP 连不上（security/ipallow.mjs 的 E3003）。
   * 监听改成**永远对外**之后，这是令牌闸外面那道网络层的门。没写过 = 关（行为不变）。
   * 名单条目的解析与匹配都在 ipallow.mjs，这里只管存取 —— 读取口全仓就这一处。
   * `boundDomain`（同日，对齐「域名绑定」）：非空时非本机来源只能用这个域名访问（E3004）。
   */
  const whitelistEnabled = j?.whitelistEnabled === true;
  const whitelistIps = Array.isArray(j?.whitelistIps) ? j.whitelistIps.map((x) => String(x)) : [];
  const boundDomain = typeof j?.boundDomain === 'string' ? j.boundDomain : '';
  /*
   * `remoteAccess`（2026-11-08）：「允许同账号设备连接」开关的**真源**。
   * 关 = 非本机来源一律 403（E3005，guardNetwork 第一道），本机直连永远放行。
   * **纯运行期判定，改完立刻生效** —— 这是它和 listenHost（bind 地址，重启才生效）
   * 的本质区别：端口永远对外听着，放不放行是请求入口上一句话的事。
   * 没写过 = true（行为不变，老配置文件里没有这个键）。
   */
  const remoteAccess = j?.remoteAccess !== false;
  const value = { whitelistEnabled, whitelistIps, boundDomain, remoteAccess };
  if (st) cache = { mtimeMs: st.mtimeMs, value };
  return value;
}

/**
 * 写形态。只改显式给了的键（**部分更新**）—— 安全页只 POST 白名单/域名/远程连接那几个键，
 * 谁也不许顺手动别人的键。
 * （`pairEnabled` / `acceptNodes` 已退场：老配置文件里若还留着这些键，读的时候直接忽略。）
 */
export function writeNetMode(patch) {
  const cur = readNetMode();
  const next = {
    whitelistEnabled:
      typeof patch?.whitelistEnabled === 'boolean' ? patch.whitelistEnabled : cur.whitelistEnabled,
    whitelistIps: Array.isArray(patch?.whitelistIps) ? patch.whitelistIps : cur.whitelistIps,
    boundDomain: typeof patch?.boundDomain === 'string' ? patch.boundDomain : cur.boundDomain,
    remoteAccess:
      typeof patch?.remoteAccess === 'boolean' ? patch.remoteAccess : cur.remoteAccess,
  };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), 'utf8');
  cache = { mtimeMs: fs.statSync(FILE).mtimeMs, value: next }; // 写完种上，读方不用再 stat 一轮
  return { ...next, file: FILE };
}

/**
 * 这台机器在局域网里的地址 → `http://<ip>:<port>`。
 *
 * 用途有两个：塞进 `BANDI_ORIGINS`（不然远端浏览器能看不能动 ✗）、
 * 以及摆给用户看"让别的机器连这个地址" ✓。
 * 排序：`192.168.` 最常见排最前（docker 的 172.x 不是你要给别人的那个 ✓）。
 */
export function lanUrls(port) {
  const out = [];
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list ?? []) {
        if (ni.family !== 'IPv4' || ni.internal) continue;
        out.push(ni.address);
      }
    }
  } catch { /* 拿不到就算了 */ }
  const rank = (a) => (/^192\.168\./.test(a) ? 0 : /^10\./.test(a) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(a) ? 2 : 3);
  return out.sort((a, b) => rank(a) - rank(b)).map((ip) => `http://${ip}:${port}`);
}

/**
 * 这台机器**对外**的地址 —— 二维码 / 配对链接要印的那一个（2026-11-01 云端）。
 *
 * 为什么需要它：`lanUrls()` 只看网卡，云端部署（容器 / 反代 + 域名）拿到的会是
 * `172.17.0.2:18787` 这种手机根本连不上的地址，二维码扫了必然白屏。
 *
 * 三级取值，**只信前两级**：
 *   ① `BANDI_PUBLIC_URL`（部署者显式声明，反代场景唯一可靠来源）；
 *   ② 反代头 `X-Forwarded-Proto` + `X-Forwarded-Host`（nginx/caddy 默认会加）；
 *   ③ 都没有 → `null`，调用方退回 `lanUrls()`。
 *
 * ⚠️ **绝不能拿 `Host` 头兜底**：本机浏览器打开配对页时 Host 是 `127.0.0.1:18787`，
 * 印进二维码手机就直奔它自己，扫码永远连不上。宁可退回局域网地址。
 */
export function publicOrigin(req) {
  const env = String(process.env.BANDI_PUBLIC_URL ?? '').trim();
  if (env) return env.replace(/\/+$/, '');

  const h = req?.headers ?? {};
  const host = String(h['x-forwarded-host'] ?? '').split(',')[0].trim().replace(/\/+$/, '');
  if (!host) return null;
  const proto = String(h['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase();
  return `${proto === 'https' ? 'https' : 'http'}://${host}`;
}

/** 监听地址是回环吗（鉴权那条规则的判据，跟 auth.mjs 同一个口径） */
export function isLoopback(host) {
  const h = String(host ?? '').trim().toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}
