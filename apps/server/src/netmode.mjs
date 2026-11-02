/**
 * 这台机器的**形态**：分两个互不干扰的键（2026-11-01 晚，用户拍板）。
 *
 *   · `allowLan`    —— **对外服务**（监听 0.0.0.0）。只在进程启动那一刻能定，
 *                      所以在起服务之前就得读到；桌面壳 / 自启 / 命令行三种起法共用它。
 *   · `acceptNodes` —— **角色**：收不收别的机器作为算力节点加入（总机 / 分机）。
 *                      纯运行期判定，**改完立刻生效、不用重启**（监听地址没动）。
 *
 * 为什么必须拆开（这次改的起因，用户原话："一台机器难道就不能一直处于不监听回环的
 * 模式吗？……把 thinkpad-p15 开分机模式。界面照样显示，手机照样可以连。但是不提供
 * 邀请码，其他的机器也加不上去"）：
 *
 *   原来只有 `allowLan` 一个键，`joinable` 是由**监听地址**反推的
 *   （`!isLoopback(boundHost) && (allowLan || explicit)`）—— 于是"对外服务"和"当总机"
 *   被焊死：只要手机能连，就必然宣称"我能被加入、快来发码"，中间没有第三种状态 ✗。
 *   而实际上这是两件事：
 *     · 对外服务 = 手机 / 浏览器能不能连进来；
 *     · 当总机   = 别的**机器**能不能挂到这台下面领活。
 *   分机就是「对外服务 ✓、当总机 ✗」—— 现在能表达了。
 *
 * 默认：`allowLan` 关（桌面版只听回环、免鉴权，单机零配置那条硬约束不变）；
 * `acceptNodes` 缺省跟随 `allowLan` —— **老配置文件（只有 allowLan:true）继续当总机**，
 * 升级不改变任何一台在跑的机器的行为。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir } from './config.mjs';

const FILE = path.join(dataDir, 'netmode.json');

export function readNetMode() {
  let j = {};
  try {
    j = JSON.parse(fs.readFileSync(FILE, 'utf8')) ?? {};
  } catch {
    j = {}; // 没这个文件 / 坏了 = 默认（只听回环、不当总机）
  }
  const allowLan = j?.allowLan === true;
  /*
   * `acceptNodes` 只在**显式写过**时才算数；没写过就跟随 allowLan（老口径）。
   * 不能用 `?? allowLan` 之外的兜底：用户把总机切成分机后，allowLan 是 true、
   * acceptNodes 是 false —— 这一对必须能同时存在。
   */
  const acceptNodes = typeof j?.acceptNodes === 'boolean' ? j.acceptNodes : allowLan;
  /*
   * `pairEnabled`（2026-11-02）：**手机连接**总开关 —— 「设置 → 手机连接」页顶那颗。
   * 没写过 = 开（老配置文件升级后行为不变：手机照连）。关掉后：不发邀请码、
   * 手机 claim / resume 一律拒绝、已配对的手机当场全部断开（routes/pair.mjs）。
   */
  const pairEnabled = j?.pairEnabled !== false;
  return { allowLan, acceptNodes, pairEnabled };
}

/**
 * 写形态。两种调用都认：
 *   · `writeNetMode(true/false)`   —— 老签名，只改 `allowLan`（routes/local.mjs 加入 / 退出总机时用）；
 *   · `writeNetMode({ allowLan?, acceptNodes? })` —— 只改显式给了的键（**部分更新**）。
 *
 * ⚠️ 必须是**部分更新**：界面切角色时只 POST `acceptNodes`，老写法会把 `allowLan` 一起冲成
 * false —— 那台正对外服务的总机切一下角色就"下次重启变回只听本机"，等于静默掉线 ✗。
 */
export function writeNetMode(patch) {
  const cur = readNetMode();
  const next =
    typeof patch === 'boolean'
      ? { allowLan: patch, acceptNodes: cur.acceptNodes }
      : {
          allowLan: typeof patch?.allowLan === 'boolean' ? patch.allowLan : cur.allowLan,
          acceptNodes: typeof patch?.acceptNodes === 'boolean' ? patch.acceptNodes : cur.acceptNodes,
          pairEnabled: typeof patch?.pairEnabled === 'boolean' ? patch.pairEnabled : cur.pairEnabled,
        };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), 'utf8');
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
 *   · **可达**（`!isLoopback`）只是必要条件：只听回环时别人根本连不进来，宣布可加入是说谎 ✗。
 *
 * ⚠️ 与旧口径的区别（别再改回去）：原来是 `!isLoopback && (allowLan || explicit)`，
 * 意思是"只要对外听就算总机" —— 于是显式部署（`BANDI_HOST=0.0.0.0`）的机器**无法**当分机，
 * 界面上的模式卡也被 `explicit` 整张藏掉。现在 `BANDI_HOST` 只决定**监听地址**，
 * 收不收节点由 `acceptNodes` 说了算，两者正交。
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
