/**
 * 「这台机器要不要对局域网开」—— 桌面版那个开关（2026-10-16 加的）。
 *
 * 为什么存成一个**文件**、而不是放在界面的设置里：**监听地址只能在进程启动那一刻定** ✗。
 * 所以这个值必须在**起服务之前**就能读到 —— 读它的人有三个，而且都不是浏览器：
 *   · 桌面壳（它拉起控制面）；
 *   · 开机自启那份（`autostart` 装的控制面单元 / 脚本）；
 *   · 命令行手动起的（`node start.mjs`）。
 * 放进数据目录，`config.mjs` 一处读它 → **三种起法都按同一个开关走** ✓（不然开关只在桌面版里灵，
 * 而这台机器上控制面很可能是自启起的 —— 用户会以为"点了没反应" ✗）。
 *
 * 默认**关**：桌面版默认只听回环、免鉴权（单机零配置那条硬约束 ✓）。
 * 打开之后：监听 0.0.0.0 + 鉴权自动开启（"只看监听地址"那条规则）+ 局域网里的机器才能作为节点加入。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir } from './config.mjs';

const FILE = path.join(dataDir, 'netmode.json');

export function readNetMode() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { allowLan: j?.allowLan === true };
  } catch {
    return { allowLan: false };
  }
}

export function writeNetMode(allowLan) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ allowLan: !!allowLan }, null, 2), 'utf8');
  return { allowLan: !!allowLan, file: FILE };
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

/** 监听地址是回环吗（鉴权那条规则的判据，跟 auth.mjs 同一个口径） */
export function isLoopback(host) {
  const h = String(host ?? '').trim().toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

/**
 * 这台总机**能不能被别的机器加入**（2026-10-20 增量 1，设计 §1.1/§1.2 —— 唯一判定）。
 *
 * `joinable = !isLoopback(boundHost) && (allowLan === true || explicit === true)`
 *   · 监听在回环上 → 别人根本连不进来，永远 false；
 *   · 开关开着 → true（桌面版正常路径）；
 *   · `BANDI_HOST` 显式指定（云端部署 `BANDI_HOST=0.0.0.0`，开关在云端页根本不显示）→ true
 *     —— 这正是本次修的 E1091 误报：云端总机明明开放，节点探测却报"没开局域网开关"；
 *   · 显式指定回环（`BANDI_HOST=127.0.0.1`）→ false：它只在本机可达，宣布 joinable=true 是说谎。
 *
 * 两个出口共用本函数、**不许各自再写一份**：`GET /api/hello`（server.mjs）与
 * UDP 应答包（lan-announce.mjs）。`explicit` 由调用方传（恒等 `!!process.env.BANDI_HOST`，
 * 与 `/api/lan` 那处同口径；env 运行期不变，无需缓存）。
 *
 * @param {object} o
 * @param {boolean} o.allowLan   「允许局域网加入」开关值（`netmode.readNetMode().allowLan`）
 * @param {boolean} o.explicit   监听地址是否被 `BANDI_HOST` 显式指定
 * @param {string}  o.boundHost  进程**现在实际**监听的地址（模块级 `boundHost`，现读）
 */
export function isJoinable({ allowLan, explicit, boundHost } = {}) {
  return !isLoopback(boundHost) && (allowLan === true || explicit === true);
}
