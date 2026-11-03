/**
 * 这台机器的**形态**（2026-11-03 用户拍板，"对外服务"这一维**整个删除**）：
 *
 *   · 监听地址 —— **永远对外**（默认 `0.0.0.0`，`BANDI_HOST` 可覆盖成具体地址）。
 *     手机 / 浏览器永远连得进来；这是启动配置（部署 / 桌面壳）的事，界面上没有开关、
 *     没有「重启生效」、没有「只在本机使用」—— 曾经的 `allowLan` 键连同那套
 *     "改了还没生效"机制一起删掉了（配置总会有遗漏，漏出来的必须是安全的那边）。
 *   · `acceptNodes` —— **角色**：收不收别的机器作为算力节点加入（总机 / 分机）。
 *     纯运行期判定，**改完立刻生效**。总机 = 收节点、发邀请码；分机 = 手机照连、
 *     不收节点。
 *   · `pairEnabled` —— **手机连接**总开关（「设置 → 手机连接」页顶那颗）。
 *
 * `acceptNodes` 没显式写过时回退看一眼老的 `allowLan`（true = 当年开过对外服务的总机）
 * —— 只为了升级那一刻：老配置文件（只有 allowLan:true）继续当总机，在跑的机器不降级。
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
    st = null; // 没这个文件 = 默认（分机、手机可配对）
  }
  if (cache && st && cache.mtimeMs === st.mtimeMs) return cache.value;
  let j = {};
  try {
    j = JSON.parse(fs.readFileSync(FILE, 'utf8')) ?? {};
  } catch {
    j = {}; // 坏了 = 默认，口径与"没有文件"一致
  }
  const acceptNodes =
    typeof j?.acceptNodes === 'boolean' ? j.acceptNodes : j?.allowLan === true;
  /*
   * `pairEnabled`（2026-11-02）：**手机连接**总开关 —— 「设置 → 手机连接」页顶那颗。
   * 没写过 = 开（老配置文件升级后行为不变：手机照连）。关掉后：不发邀请码、
   * 手机 claim / resume 一律拒绝、已配对的手机当场全部断开（routes/pair.mjs）。
   */
  const pairEnabled = j?.pairEnabled !== false;
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
  const value = { acceptNodes, pairEnabled, whitelistEnabled, whitelistIps, boundDomain };
  if (st) cache = { mtimeMs: st.mtimeMs, value };
  return value;
}

/**
 * 写形态。只改显式给了的键（**部分更新**）—— 界面切角色只 POST `acceptNodes`、
 * 手机连接页只 POST `pairEnabled`、安全页只 POST 白名单/域名那几个键，
 * 谁也不许顺手动别人的键。
 */
export function writeNetMode(patch) {
  const cur = readNetMode();
  const next = {
    acceptNodes: typeof patch?.acceptNodes === 'boolean' ? patch.acceptNodes : cur.acceptNodes,
    pairEnabled: typeof patch?.pairEnabled === 'boolean' ? patch.pairEnabled : cur.pairEnabled,
    whitelistEnabled:
      typeof patch?.whitelistEnabled === 'boolean' ? patch.whitelistEnabled : cur.whitelistEnabled,
    whitelistIps: Array.isArray(patch?.whitelistIps) ? patch.whitelistIps : cur.whitelistIps,
    boundDomain: typeof patch?.boundDomain === 'string' ? patch.boundDomain : cur.boundDomain,
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

/**
 * 这台机器**能不能被别的机器加入**（2026-10-20 增量 1；2026-11-01 晚改为角色驱动 —— 唯一判定）。
 *
 * `joinable = acceptNodes && !isLoopback(boundHost)`
 *
 *   · **角色**（`acceptNodes`）是主动的那一半：分机形态下不论监听什么地址，一律 false ——
 *     这台自己不收徒弟（不发邀请码、探测回来也是"不开放加入"），但照样对外服务、
 *     手机照样能连 ✓（用户 2026-11-01 定的形态）；
 *   · **可达**（`!isLoopback`）只是必要条件：监听被 `BANDI_HOST=127.0.0.1` 钉在回环上时
 *     别人根本连不进来，宣布可加入是说谎 ✗（调试场景才有的形态，2026-11-03 起默认就是 0.0.0.0）。
 *
 * 两个出口共用本函数、**不许各自再写一份**：`GET /api/hello`（server.mjs）与
 * `/api/lan`/模式卡（前端）。UDP 应答器已下线（2026-11-02，lan-announce.mjs 只剩状态存根）。
 *
 * @param {object} o
 * @param {boolean} o.acceptNodes 角色位（`netmode.readNetMode().acceptNodes`）：true=总机
 * @param {string}  o.boundHost   进程**现在实际**监听的地址（模块级 `boundHost`，现读）
 */
export function isJoinable({ acceptNodes, boundHost } = {}) {
  return acceptNodes === true && !isLoopback(boundHost);
}
