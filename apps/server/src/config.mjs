import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { userDataDir } from './data-dir.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * 服务端默认端口。**高位固定**，桌面壳（`apps/desktop/shell.mjs` 的 `DEFAULT_PORT`）用的是同一个值。
 *
 * 为什么不是 8787：那一带开发工具扎堆，撞车概率高。18787 不在 Windows 的临时端口段
 * （49152+，系统会随手发给 outgoing 连接）里，也不是 IANA 注册的常见服务。
 *
 * ⚠️ 这个值**不是"探测起点"** —— 全局没有"往上找空端口"的逻辑了（2026-11-01 改）。
 * 要换端口：`BANDI_PORT=<n>`，或者把这一处和 `shell.mjs` 的两处一起改掉。
 */
const DEFAULT_PORT = 18787;

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
 * 监听地址。**永远对外**（2026-11-03 用户拍板：手机和节点永远都可以连进来，
 * 让不让进由「分机/总机」和「手机连接」两个开关管，不由监听地址管）。
 *
 * `BANDI_HOST` 仍可显式覆盖（部署要钉具体网卡地址；`127.0.0.1` 只留给调试）。
 * 曾经的 `allowLan` 键与"只听本机"形态已整个删除 —— 配置总会有遗漏，
 * 漏出来的必须是"对外服务且强制鉴权"这一侧，而不是裸听回环的假安全感。
 */

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

/**
 * 监听地址的**合法写法**（2026-11-04）。空 / 认不出来 = null（调用方当"没配"）。
 *
 * 只放行 IP 与两个通配：`0.0.0.0`（所有网卡）、`127.0.0.1`（只听本机）。
 * **不收主机名** —— `listen()` 拿到 `my-box.local` 会去解析，解析结果随网络环境变，
 * 出问题时排查成本远高于收益（要写域名请走反代，那是 `boundDomain` 的事）。
 */
export function normalizeListenHost(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (s === 'localhost') return '127.0.0.1';
  if (s === '0.0.0.0' || s === '::' || s === '::1') return s;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  return m.slice(1).every((n) => Number(n) <= 255) ? s : null;
}

/**
 * 把监听地址**写进数据目录的 `config.json`**（界面「安全 → 监听地址」保存时调）。
 *
 * 为什么落这里、不落 `/etc/systemd/system/bandi.service` 或部署参数：
 * 单元文件每次重装都会被重新生成（`deploy/install.sh` 覆盖写），2026-11-04 的实际事故
 * 就是这么来的 —— 三次升级把 `0.0.0.0` 又写回了 `127.0.0.1`，局域网访问全断。
 * 数据目录（`/var/lib/bandi`）跟库、token 一个待遇：**升级不碰**，所以配置放这儿才"坐得住"。
 *
 * ⚠️ 写完**不立刻生效**：`host` 是本模块求值时算的，`server.listen()` 早就绑过了。
 * 界面拿到 `needRestart` 后要重启控制面（`POST /api/control-plane/restart`）。
 */
export function writeListenHost(v) {
  const h = normalizeListenHost(v);
  if (!h) throw new Error(`监听地址写不对：${v}（给 0.0.0.0 / 127.0.0.1 / 具体 IPv4）`);
  const cfgPath = path.join(dataDir, 'config.json');
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { /* 还没有这个文件 */ }
  if (!cur || typeof cur !== 'object' || Array.isArray(cur)) cur = {};
  cur.listenHost = h;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cur, null, 2), 'utf8');
  return h;
}

/**
 * 把持久化的监听地址**清掉**（`bandi reset-host` 用）：清完回落到 `0.0.0.0`。
 * 与 `writeListenHost` 一样，只改磁盘，重启才生效。
 */
export function clearListenHost() {
  const cfgPath = path.join(dataDir, 'config.json');
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { return false; }
  if (!cur || typeof cur !== 'object' || Array.isArray(cur) || !('listenHost' in cur)) return false;
  delete cur.listenHost;
  fs.writeFileSync(cfgPath, JSON.stringify(cur, null, 2), 'utf8');
  return true;
}

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
 * 监听地址：三层取值（2026-11-04 重做 —— **做进系统**，不再靠部署时传环境变量）。
 *
 *   ① `BANDI_HOST` 环境变量 —— 显式钉（调试 / 特殊部署 / 桌面壳）。最高优先。
 *   ② 数据目录 `config.json` 的 `listenHost` —— **主路**：界面可改、重启生效、
 *      升级重装都不丢（`writeListenHost` / `clearListenHost`）。
 *   ③ 缺省 `0.0.0.0` —— **永远对外**（2026-11-03 用户拍板：手机和节点永远都能连进来，
 *      让不让进由「总机/分机」和「手机连接」两个开关管，不由监听地址管）。
 *
 * 为什么②要落在数据目录：systemd 单元每次重装都会被 `deploy/install.sh` 覆盖写，
 * 11-04 的事故就是三次升级把 `0.0.0.0` 写回了 `127.0.0.1`，外面全连不上。
 * 数据目录跟库、token 一样**升级不碰**，配置放这儿才坐得住。
 *
 * ⚠️ 曾经的 `allowLan` 键与"只听本机"形态已删除 —— 配置总会有遗漏，
 * 漏出来的必须是"对外服务且强制鉴权"这一侧，而不是裸听回环的假安全感。
 */
const cfgHost = normalizeListenHost(clientCfg.listenHost);
export const host = process.env.BANDI_HOST ?? cfgHost ?? '0.0.0.0';

/**
 * 现在这个监听地址是谁定的：`env` / `config` / `default`。
 * 界面拿它说清"为什么这里改不了"（env 钉着时是只读的），别让人白点。
 */
export const hostSource = process.env.BANDI_HOST ? 'env' : cfgHost ? 'config' : 'default';

/**
 * **声明「我在可信反代 / 隧道后面」**（IAM §5.2 / §5.3，2026-10-31 新增）。
 *
 * 为什么要这个开关：反代把流量转进 `127.0.0.1:18787`，服务端看到的所有 peer 都是回环 ——
 * 只按来源 IP 判"本机"，等于把整站（面板、会话、导出）对全网开放。
 * 设了它 = 承认"回环来源不可信"，于是：
 *   · 整站**强制认证**（哪怕监听的是回环）；
 *   · 破坏性本机动作改由 `X-Bandi-Local`（数据目录 `local_secret`）证明"我在本机"。
 *
 * ⚠️ 与反代的 `proxy_set_header X-Forwarded-For` 是**一对**：配了转发头必须同时设这个，
 * 否则请求会被判成网络来源（更严的一侧，出错只会更安全）。
 */
export const trustProxy = /^(1|on|true|yes)$/i.test(String(process.env.BANDI_TRUST_PROXY ?? '').trim());

/**
 * `BANDI_LOCAL_SECRET=off` —— **逃生口**，只给"反代已经 deny 掉破坏性本机路径"的部署用。
 * 关掉后破坏性动作不再要求 `X-Bandi-Local`，启动时会打一条 warning 并写审计。
 */
export const localSecretDisabled = /^(0|off|false|no)$/i.test(String(process.env.BANDI_LOCAL_SECRET ?? '').trim());

/**
 * 允许的**来源**（写请求的来源白名单，CSRF 那道闸）。
 * 固定部分是 `BANDI_ORIGINS` 声明的（服务器部署时明确给出来的），逗号分隔，例如：
 *   `BANDI_ORIGINS=http://192.168.1.9:18787,https://bandi.example.com`
 *
 * 本机的局域网地址**不用配**：监听永远对外（2026-11-03），`lanOrigins()` 恒把它们
 * 放进白名单 —— 不然页面在 `http://192.168.x.x:18787` 上打得开、却什么都改不了
 * （2026-11 修的"手机扫码卡正在配对"就是这条的病根，别再退回"导入时冻结"的写法）。
 *
 * 节点不受影响：它用脚本调接口，浏览器不带 Origin，走的是放行那条路。
 */

let lanNicsAt = 0;
let lanNics = [];
export function lanOrigins() {
  const now = Date.now();
  if (now - lanNicsAt > 60_000) {
    lanNics = [];
    try {
      for (const list of Object.values(os.networkInterfaces())) {
        for (const ni of list ?? []) {
          if (ni.family !== 'IPv4' || ni.internal) continue;
          lanNics.push(ni.address);
        }
      }
    } catch { /* 拿不到就算了 */ }
    lanNicsAt = now;
  }
  /*
   * ⚠️ 这里**不能**用下面那个 `port`：它是 `const`，在这个位置还在 TDZ 里 ✗
   * （第一次写就是这么炸的）。自己读一遍环境变量就好 —— 它们读的是同一个。
   */
  const p = Number(process.env.BANDI_PORT ?? DEFAULT_PORT);
  return lanNics.map((ip) => `http://${ip}:${p}`);
}

/**
 * 来源白名单里**固定**的那部分：`BANDI_ORIGINS` 声明的（服务器部署时明确给出来的）。
 * 局域网本机地址**不在这里** —— 那是动态的，由 `http.allowedOrigins()` 每次调
 * `lanOrigins()` 现算，别再塞回来（塞回来就又变回"导入时冻结"的老毛病 ✗）。
 */
export const extraOrigins = (process.env.BANDI_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);

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

/** 服务端端口（`BANDI_PORT` 优先，默认见上面 `DEFAULT_PORT`） */
export const port = Number(process.env.BANDI_PORT ?? DEFAULT_PORT);

/** dsh 跑任务时的工作目录：agent 在这个目录里干活 */
export const runCwd = process.env.BANDI_RUN_CWD ?? repoRoot;
