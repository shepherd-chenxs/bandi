import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { userDataDir } from './data-dir.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 仓库根：apps/server/src -> 上三级 */
export const repoRoot = path.resolve(here, '..', '..', '..');

/**
 * 运行时数据目录（SQLite、`runtimes.json`、`plugins.json`、`connectors.json`、
 * `node.json`、`model-routes/` …—— 有 7 处从它派生）。
 *
 * **默认只有一个：本机用户数据目录**（`userDataDir()`；Windows 是 `%APPDATA%\bandi`）。
 * 命令行、桌面壳（开发版与安装版）走的是**同一个默认** —— 2026-10-18 收敛掉了原先
 * "命令行落 `<仓库>/data`、桌面壳落用户目录"的两套默认（同一台机器两个库，最容易看错库）。
 *
 * 为什么不能默认就地放 `<仓库>/data`：安装版装到用户机上时"仓库目录"就是**安装目录**，
 * 往里写要么要管理员权限（撞 `v1.0.0` 的 B5「不要求管理员权限」），要么升级时被覆盖。
 * `<仓库>/data` 仍可显式指（`BANDI_DATA=<仓库>/data`）—— 那是**沙盒/隔离**用途。
 *
 * 其它形态一律显式指：服务器部署（systemd）指 `/var/lib/bandi`，smoke 用例指临时目录。
 *
 * 为什么不做「写不进去就自动换个家」的兜底：那会在权限一抖动时**悄悄换成一个空库**，
 * 用户看到的是"东西全没了" —— 比启动直接失败糟得多。指错了就让它失败，别猜。
 */
export const dataDir = process.env.BANDI_DATA
  ? path.resolve(process.env.BANDI_DATA)
  : userDataDir();
export const dbPath = process.env.BANDI_DB ?? path.join(dataDir, 'bandi.db');

/**
 * 监听地址。**默认只听本机。**
 *
 * 这个服务端**还没有鉴权**（`LOCAL_USER` 是写死的，来源守卫只挡"借浏览器使坏"，
 * 不认证任何调用方）。所以 `0.0.0.0` 等于把 agent 的控制权交出去。
 * 要远程访问，二选一：
 *   · 走 SSH 隧道 —— 不用改任何配置，也不用开端口（**推荐先这么用**）；
 *   · 设 `BANDI_HOST=0.0.0.0`，同时把访问来源加进 `BANDI_ORIGINS`，并且**自己确保外面有保护**
 *     （防火墙 / 反向代理的鉴权 / 只在内网）。
 */
/*
 * 桌面版那个「允许局域网内的机器加入」开关（2026-10-16）。
 *
 * ⚠️ 为什么在这儿读、而不是在桌面壳里读：**监听地址只能在进程启动那一刻定** ✗，
 * 而拉起控制面的有三个入口（桌面壳 / 开机自启 / 命令行）—— 只在壳里读的话，
 * 这台机器上如果是自启起的控制面，用户点了开关会"没反应" ✗。
 * 放在这里，三种起法都按同一个开关走 ✓。
 *
 * 默认关。`BANDI_HOST` 显式给了就以它为准（脚本 / 部署仍能压过去 ✓）。
 */
const netMode = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'netmode.json'), 'utf8'));
  } catch {
    return {}; // 没这个文件 = 默认（只听回环）
  }
})();

export const lanAllowed = netMode?.allowLan === true;

/*
 * **这台机器已经加入某台总机了吗**（2026-10-20，设计 §4.4）。
 *
 * 判据就是 `node.mjs` 读的那份 `<数据目录>/config.json` 里有没有 `controlPlane` ——
 * 有 = 它是某台总机的节点（也就是"瘦客户端"）。
 *
 * 为什么**就地读 JSON、不 import `local-mode`**：
 *   · `store.mjs` import 了本文件，而 `local-mode` 若要 import `store`（它不 import，但这条链很容易被
 *     后来的人接上）就成环 —— 启动时就炸；
 *   · 而且本文件在**任何模块之前**被求值，import 一个会读配置的模块只会把初始化顺序搞乱。
 * 读失败（没有文件 / 坏了 / 不是 JSON 对象）一律当"没加入" —— 那是最保守的形态（只听回环）。
 */
const clientCfg = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
})();

export const clientJoined = typeof clientCfg.controlPlane === 'string' && clientCfg.controlPlane.trim() !== '';

/*
 * 回复风格（2026-10-24 用户的设计：偏好设置里一项，改了**全体数字员工**生效）。
 *
 *   · 'default' 默认 —— 不加任何约束；
 *   · 其他风格 = 注册表里登记的一个**技能**，派活时把技能正文追加进任务
 *     （见 dispatch.stylePrefBlock —— 每轮都带、不走 firstTime，切换立即生效）。
 * 注册表写死在代码（同专家目录的口径：跟代码一起审）；存在 config.json 的
 * `replyStyle` 键里，跟控制面/生图那套共用一个文件。
 */
export const REPLY_STYLES = [
  { id: 'default', label: '默认', skill: null },
  { id: 'concise', label: '言简意赅', skill: 'my-adhd-caveman' },
];

export function replyStyle() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    return REPLY_STYLES.some((x) => x.id === j.replyStyle) ? j.replyStyle : 'default';
  } catch {
    return 'default';
  }
}

export function writeReplyStyle(id) {
  const hit = REPLY_STYLES.find((x) => x.id === id);
  if (!hit) throw new Error(`不认识的回复风格：${id}`);
  const cfgPath = path.join(dataDir, 'config.json');
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { /* 还没有这个文件 */ }
  if (!cur || typeof cur !== 'object' || Array.isArray(cur)) cur = {};
  cur.replyStyle = hit.id;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cur, null, 2), 'utf8');
  return hit.id;
}


/**
 * 监听地址。
 *
 * ⚠️ **已加入 = 瘦客户端，必须只监听回环**（2026-10-20，设计 §4.4）：
 * 否则一台昨天开过局域网的机器（`netmode.json` 里 `allowLan:true`）今天变成瘦客户端，
 * 会以 `0.0.0.0` + **强制鉴权**起来 —— 等于把**总机的面板令牌**敞给整个网段。
 *
 * `BANDI_HOST` 仍然最优先（部署 / 调试要能压过去）。
 */
export const host = process.env.BANDI_HOST ?? (clientJoined ? '127.0.0.1' : lanAllowed ? '0.0.0.0' : '127.0.0.1');

/**
 * 允许的**来源**（写请求的来源白名单，CSRF 那道闸）。
 * 默认只有本机自己；逗号分隔，例如：
 *   `BANDI_ORIGINS=http://192.168.1.9:8787,https://bandi.example.com`
 *
 * ⚠️ 不配这个、只改 `BANDI_HOST`，远端浏览器打开页面会**能看不能动**（写请求全 403）。
 * 节点不受影响：它用脚本调接口，浏览器不带 Origin，走的是放行那条路。
 *
 * 开了「允许局域网加入」时，**本机的局域网地址自动放行** ✓ —— 不然用户还以为开关坏了
 * （页面在 `http://192.168.x.x:8787` 上打得开、却什么都改不了 ✗）。
 */
function selfLanOrigins() {
  if (!lanAllowed) return [];
  /*
   * ⚠️ 这里**不能**用下面那个 `port`：它是 `const`，在这个位置还在 TDZ 里 ✗
   * （第一次写就是这么炸的）。自己算一遍就好 —— 它们读的是同一个环境变量。
   */
  const p = Number(process.env.BANDI_PORT ?? 8787);
  const out = [];
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list ?? []) {
        if (ni.family !== 'IPv4' || ni.internal) continue;
        out.push(`http://${ni.address}:${p}`);
      }
    }
  } catch { /* 拿不到就算了 */ }
  return out;
}

export const extraOrigins = [
  ...(process.env.BANDI_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean),
  ...selfLanOrigins(),
];

/**
 * 这里原来有个 `dshCli`（`BANDI_DSH_CLI ?? 'D:\AppData\Local\Programs\...\dsh.cmd'`）。
 * 已经删掉了，两个原因：
 *   ① 它**没有任何地方在用** —— 死代码
 *   ② 那个字面量是开发那台机器的布局，留着就是把人往死路径上带
 * dsh 的可执行文件现在由「设置 → 运行时」探测决定，存在 runtimes.json 里。
 */

/** 我们自己的 profile（不共用 desktop，那个被 Electron 独占） */
export const dshProfile = process.env.BANDI_DSH_PROFILE ?? 'headless';

/*
 * 这里原来有一对 `gatewayKeyEnv` / `gatewayKey`，spawn dsh 子进程时注入
 * `MAGPIE_GATEWAY_KEY`。去掉了 —— 它属于"平台替 CLI 配供应商凭据"那一类事，
 * 而凭据是 CLI 自己的：profile 里写 `apiKeyEnv: MAGPIE_GATEWAY_KEY`，
 * 值由 dsh 自己从 `$DSH_HOME/.env` 读（实测：清掉 bandi 的注入，
 * `dsh --profile headless --json -` 照样跑通）。
 */

/** 服务端端口 */
export const port = Number(process.env.BANDI_PORT ?? 8787);

/** dsh 跑任务时的工作目录：agent 在这个目录里干活 */
export const runCwd = process.env.BANDI_RUN_CWD ?? repoRoot;
