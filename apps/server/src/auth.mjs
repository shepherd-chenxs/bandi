/**
 * 访问闸 —— **身份认证的唯一起点**（人走中枢，一轮活走钥匙）。
 *
 * **身份只剩两种**（2026-11-20 operator 下线后收口）：
 *
 *   · `user` —— **人**。账号全在身份中枢，本机只渲染一个账号密码框（表单
 *     `POST /hub/login` 转给中枢，见 `routes/hub.mjs`），手机走中枢票进门
 *     （`GET /hub/enter`）。两条路最后都落到本机会话 `bandi_sid` —— 登录即全权，
 *     本机不再有第二套账号密码、角色或菜单权限（那两套已整体退场）。
 *   · `run`  —— **一轮活**。数字员工的运行钥匙（`X-Bandi-Run-Token`，run 现发、收尾吊销），
 *     只开放建卡通道与只读台账，见 `security/policy.mjs`。
 *
 * **`bandi_token` 不是第三种身份**（2026-11-20 下线 operator）：它只是**本机钥匙**，
 * 证明"我能读这台机器的 0600 文件"，换出来的是**机主本人**（`localKeyWho()`）。
 * 它当年被设成"操作员"，但那个身份能做的事登录用户都能做、能证明的事 `local_secret`
 * 也能证明、署名前还要映射成第一个用户 —— 多一档身份换不来任何能力，只会让人以为
 * 存在一道"只有总机能过"的闸（那道闸拦的是早已删除的面板令牌）。
 *
 * 形态：
 *
 *   · 只监听回环（桌面版 / 单机）→ **API 免鉴权**（脚本 / 冒烟 / CLI 一个字节没变），
 *     但浏览器抓面板 HTML 要先有登录会话 —— API 的闸管脚本，会话的闸管人；
 *   · 监听非回环（服务器）→ 所有请求都要凭据。
 *
 * ⚠️ "本机"不是看 `remoteAddress` 是不是 `127.0.0.1`：反向代理会把来源变成回环。
 * 每次请求都用 `security/source.mjs` 的 `classifySource()` 现算，四条同时成立才算本机：
 * 未设 `BANDI_TRUST_PROXY`、无转发头、监听回环、peer 与 Host 都是本机。
 *
 * 钥匙从哪来，按优先级：
 *   1. `BANDI_TOKEN`（显式指定，方便容器/CI）
 *   2. 数据目录里的 `token` 文件（首次启动自动生成，权限 0600）
 *
 * 带法只剩两种：
 *   · **头** `X-Bandi-Token` —— 脚本与运维（浏览器不会自动带，天然免疫 CSRF）。
 *   · **查询** `?token=` —— 首次进来那一下，当场换成**会话票**并重定向掉，
 *     免得钥匙留在地址栏与历史里（钥匙本身绝不进浏览器）。
 *
 * 要找回钥匙就一条命令（控制面那台机器上）：
 *   Windows:  `type <数据目录>\token`      例：type E:\02CodeSpace\bandi\data\token
 *   Linux:    `cat  <数据目录>/token`      例：cat ~/bandi-data/token
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as store from './store.mjs';
import { verifyRunCredential } from './agent-auth.mjs';
/*
 * 「这个请求从哪来」的唯一判定点（IAM §5.2）。
 * 2026-10-31 起**本文件不再自己判 remoteAddress** —— 原来那句
 * `if (isLoopbackHost(host)) return { required:false }` 在反代部署下等于全站免登录。
 */
import { classifySource, cfgNow, hostnameOf, isLocalHost, isLoopbackAddr, isLoopbackHost } from './security/source.mjs';
import * as policy from './security/policy.mjs';
import { isRegistered } from './security/route-policy.mjs';
import * as csrf from './security/csrf.mjs';
import * as localSecret from './security/local-secret.mjs';
// 只读 `<数据目录>/hub.json`：登录页据此显示中枢域名与设备名。中枢地址永远有值
// （内置默认），这里不存在"没配中枢"的分支。
import { DEFAULT_HUB_URL, hubBaseUrl, readHubConfig } from './hub/config.mjs';

export { isLoopbackHost };

const COOKIE = 'bandi_token';
const HEADER = 'x-bandi-token';

/*
 * **登录会话 Cookie**（2026-10-28 第三刀：账号、登录与角色分配）。
 *
 * 与 `bandi_token` 是**两条互不相干的路**：
 *   · `bandi_token` = 本机钥匙（换出机主本人）—— 不随登录态变化；
 *   · `bandi_sid`   = 某个**人**登录后的会话票，只对非回环浏览器有意义。
 * 两条同时存在时**钥匙优先**（见 guard 里的注释）：一个陈旧的会话 Cookie 不该
 * 把手握本机钥匙的请求降权成普通账号。
 */
const SID_COOKIE = 'bandi_sid';
/** 会话 Cookie 存活天数 —— 必须与 `store.SESSION_DAYS` 一致（两处一起改） */
const SID_MAX_AGE = 30 * 86400;

/**
 * **壳的 WebView 标记**（2026-11-08）：原生壳在 UA 末尾追加 `BandiShell/<版本>`。
 *
 * 用途只有一个 —— 无会话抓面板 HTML 时区分"人"和"壳"（见 serveLoginOrReenter）。
 * 它不参与任何鉴权判断：伪造它最坏的结果是自己看不到登录页。
 */
const SHELL_UA = /(^|\s)BandiShell\/\S+/;

/**
 * 壳的会话过期改道点。壳的 `shouldOverrideUrlLoading` 认这个路径去**静默重签票**，
 * 不真的加载它；万一没接住，服务端回一张"正在重新连接"的静态页（routes/hub.mjs）。
 */
export const REENTER_PATH = '/hub/expired';

/**
 * **本机壳子自动进门**（2026-11-10）：桌面壳（`apps/desktop/shell.mjs`）启动窗口时
 * 带上数据目录里 `local_secret` 的地址，服务端核过就发一张本机会话（`bandi_sid`），
 * 窗口直接是面板，不再落到登录页。
 *
 * 为什么要有这条路：控制面一旦对外监听（`BANDI_HOST=0.0.0.0`，桌面版默认），
 * **本机请求也要求鉴权**（IAM §5.2 的有意选择）—— 但桌面壳是"这台机器上的应用"，
 * 凭据就是本机文件，不该让人在壳里反复输中枢账号密码。2026-11-10 实报：
 * 壳里放了一晚回来发消息，回的是 E4010「不是从本机直接发起的」。
 *
 * 只认**本机直连**（`isDirectLocalRequest`：peer 回环、无转发头、Host 是本机名）——
 * 反代/局域网里来的请求即使知道 secret 也不认（secret 本来就不该出这台机器）。
 */
export const SHELL_ENTER_PATH = '/shell/enter';


/** 这个监听地址算不算"只有本机能访问" */
// isLoopbackHost 现在住在 security/source.mjs（本文件上面 import 并原样导出，对外 API 不变）

/**
 * 取令牌：显式环境变量优先，否则数据目录里那个文件（没有就生成一个）。
 * **生成后落在数据目录里**，所以重启不变 —— 否则每次重启用户都得重新登录一次。
 */
export function ensureToken(dataDir, envToken) {
  const given = String(envToken ?? '').trim();
  if (given) return { token: given, from: 'BANDI_TOKEN' };

  const file = path.join(dataDir, 'token');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved) return { token: saved, from: file };
  } catch { /* 没有就生成 */ }

  const token = crypto.randomBytes(24).toString('base64url');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
    return { token, from: file, created: true };
  } catch (e) {
    // 写不下去也得能用：至少这次运行有个令牌，日志里会打出来
    return { token, from: `(生成失败，仅本次有效：${e?.message ?? e})`, created: true };
  }
}

/**
 * 一把装好：**要不要闸、令牌是什么**。
 *
 * ⚠️ 免鉴权时**连令牌文件都不碰** —— 单机该是零安全痕迹的，
 * 否则数据目录里会平白多出一个 `token`，让人猜"这是干嘛的"。
 * 真开成非回环了，下次启动自己会生成（也不丢已登录的会话，因为那时才需要）。
 *
 * **2026-10-31 修（IAM §5.3，P0）**：`required` 还要看 `trustProxy` ——
 * `BANDI_TRUST_PROXY=1 + 监听回环` 时，`guard()` 逐请求要求认证（回环不再可信），
 * 但进程若还按"回环 = 免鉴权"不生成令牌，根令牌 / CLI / break-glass 就全断了：
 * 会话能登进来，脚本和应急入口却无凭据可用。所以两个条件一起决定，并且
 * required 为真时**必须**加载/生成 token。
 */
export function setup({ host, dataDir, envToken, trustProxy = false }) {
  const required = !isLoopbackHost(host) || !!trustProxy;
  // dataDir 一起带出去：登录页要读 `<数据目录>/hub.json` 才知道这台机器有没有加入中枢
  //（只是读一个本地文件，中枢不在、没加入，都返回 null —— 不构成对中枢的依赖）
  if (!required) return { required: false, token: '', from: '', created: false, dataDir };
  return { required: true, ...ensureToken(dataDir, envToken), dataDir };
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * 这次请求带的**本机钥匙**（头优先，其次是地址栏那一下）。
 *
 * 2026-11-20 起**不认 `bandi_token` Cookie**：钥匙不是身份，不该在浏览器里长住；
 * 地址栏那一次会当场换成会话票（见 guard），Cookie 那条路只剩"顺手清掉"。
 */
export function tokenOf(req, url) {
  const header = req.headers[HEADER];
  const query = url.searchParams.get('token');
  return String(header || query || '');
}

/** 这次请求带的**登录会话**票（`bandi_sid`；没有就是空串） */
export function sessionTokenOf(req) {
  return String(parseCookies(req.headers.cookie)[SID_COOKIE] || '');
}

/** 给登录成功用：`Set-Cookie` 的值（HttpOnly：JS 读不到，XSS 偷不走）
 * `maxAge` 秒：缺省跟浏览器侧的会话 Cookie 保存期；本机壳子用更长的（见 SHELL_ENTER_PATH）。 */
export function sessionCookie(token, maxAge = SID_MAX_AGE) {
  return `${SID_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

/** 给退出登录用：让浏览器立刻丢掉这张票（Max-Age=0） */
export function clearedSessionCookie() {
  return `${SID_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/**
 * 让浏览器丢掉**访问令牌**票（Max-Age=0）。退出登录时和会话票一起清 ——
 * 否则一个曾经填过令牌的浏览器（令牌 Cookie 一年有效）永远被"令牌优先"放进面板，
 * 永远走不到登录页（2026-10-31 实报：总机上开了局域网，老板的浏览器就是进不了登录页）。
 * 只影响浏览器：脚本用头/查询参数带令牌，不受 Cookie 影响。
 */
export function clearedTokenCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}


/**
 * 这枚**运行钥匙**是谁（`X-Bandi-Run-Token`，2026-11-08 补）。
 *
 * ⚠️ 2026-11-20 起**只剩它一种**。原先的 `operator`（总机那枚 `bandi_token`）已下线：
 * 它作为身份是多余的 —— 能做的事登录用户都能做，能证明的事 `local_secret` 也能证明，
 * 最后署名前还要映射成第一个用户。现在平台令牌只是**本机钥匙**，作用是"以机主身份行事"，
 * 由 `guard` 的 `localKeyWho()` 直接合成 `kind:'user'`，不在这里判。
 *
 * 运行钥匙**不走 tokenOf 的三路**（Cookie / 头 / 查询）—— 它是 agent 进程环境里的
 * 一次性钥匙，走独立的 `X-Bandi-Run-Token` 头。验不过 → 当没认出来（外层按"带了但
 * 无效"回 E2056）。
 */
export function identify(runToken = '') {
  if (runToken) {
    const hit = verifyRunCredential(runToken);
    if (hit) return { kind: 'run', runId: hit.runId, personaId: hit.personaId };
  }
  return null;
}

/**
 * 握着**本机钥匙**（`bandi_token`）的这次请求，在这台机器上算谁。
 *
 * 口径（2026-11-20 用户拍板下线 operator）：钥匙不是身份，它只证明"我能读这台机器的
 * 0600 文件"—— 与 `local_secret` 同一档信任。所以它换不出更高的权力，只换一个"谁"：
 * **本机第一个账号（机主）**。没有账号就先留空（`userId:null`），下游 `actorUser`
 * 回落到占位名；这与过去 operator 的行为逐字等价，但不再多出一种身份。
 */
function localKeyWho(via = 'local-key') {
  const owner = store.firstUser();
  return { kind: 'user', userId: owner?.id ?? null, via };
}

/**
 * 运行钥匙**从哪来才算数**（2026-11-08，全员群 401 实报的修法之一）。
 *
 * 数字员工是控制面在本机起的子进程，连的是 `127.0.0.1`；但服务器形态监听 `0.0.0.0`
 * —— `classifySource()` 会把"监听非回环"一律判成 network，拿它当门槛，这条通道在
 * 真机上永远不通（这正是实报的病根：冒烟一直在回环免鉴权模式下跑，从没测过）。
 *
 * 这里要回答的其实只有"**请求有没有经过反代**"，判据与 source.mjs §5.2 同一套证据：
 * peer 是回环 + 没带任何转发头 + Host 指向本机名 —— 只是不要求进程监听在回环上。
 * 经过反代的请求带转发头、或 Host 是公网域名，一律不认（钥匙泄到外部也用不了）。
 */
function isDirectLocalRequest(req) {
  const h = req?.headers ?? {};
  if (h['x-forwarded-for'] || h['x-real-ip'] || h['forwarded']) return false;
  if (!isLoopbackAddr(req?.socket?.remoteAddress)) return false;
  return isLocalHost(h.host);
}

/*
 * 2026-11-20 删：`PANEL_FORBIDDEN` / `isPanelForbidden()` 整个退场。
 *
 * 它拦的是**面板令牌**（瘦客户端那台机器），而那个体系 2026-11-09 已随多机节点子系统
 * 一起删除 —— 之后两个函数一个调用方都没有，`route-policy` 里配套的 `noPanel` 标记
 * 也没有任何消费方。它不是"权限边界没生效"，而是**对象已经不存在了**。
 *
 * 顺手记下教训：一段写着"只有总机能做"的注释，即使代码已经死了，也会让人（包括写它
 * 的人）以为那道闸还在。死代码要删，别留成"看起来在守门"的化石。
 */

/**
 * **判定只有一处**（设计 §6.1）。`guard()` 里只调这一个函数，别的什么都不判。
 *
 * 判定逻辑本体在 `security/policy.mjs` 的 `authorize()`（**登录用户 = 全权**，
 * 机器身份各有各的边界）。本函数只是 PDP 包装：判定只有这一个入口，
 * import 保持单向（auth → policy），security/ ↔ auth.mjs 不成环。
 * （原经 `rules` 注入的节点归属判定随多机子系统 2026-11-09 整体删除。）
 *
 * 令牌从哪来（`X-Bandi-Token` 头 / `?token=` 查询）也走的**都是这里** ——
 * `tokenOf()` 先统一取出，`guard` 再把它认成**机主本人**（`localKeyWho()`），
 * 所以"同一枚钥匙换个携带方式就换出一套权限"不可能发生。
 *
 * 返回 `'allow' | 'E4031' | 'E4033' | 'E4034'`。
 *
 * **不缓存**：每次请求现算，改完对下一次请求立即生效。
 */
export function decide(who, method, pathname) {
  return policy.authorize({ who, method, pathname });
}

/**
 * 这次请求的**操作人是谁**（2026-10-31 用户概念落地：消息署名 / 建卡人 / 看"我"是谁）。
 *
 * 只有一种答案：**这个人自己**。本机钥匙 / 回环信任在 guard 里已经被合成成
 * `kind:'user'` + 机主的 userId（2026-11-20 operator 下线），所以这里不再有
 * "机器身份映射成人"的特例；`userId` 为空（这台机器还没有任何账号）→ null，
 * 调用方回落到 LOCAL_USER 占位。
 *
 * 只用于**落数据**（署名），绝不用于鉴权 —— 权限判定仍然只看 `decide()`，两码事别混。
 */
export function actorUser(req) {
  const a = req?.bandiAuth;
  if (!a) return null;
  if (a.kind === 'user' && a.userId) return store.getUser(a.userId);
  return null;
}

/**
 * 这次请求是不是**一个能动管理设置的人**在做（handler 判字段级权限用）。
 *
 * 存在的理由：`PUT /api/personas/:id` 里"body 带 model / runtime"这件事
 * `auth.mjs` 看不见（要 `readBody`），所以那一条必须落在 handler 里，一行判断即可。
 *
 * 2026-11-07 起登录即全权；2026-11-20 起本机钥匙也合成成 `user`，
 * 所以这里只剩一个判据（运行钥匙不算）。**它不再是"只有机器才有的特权"**。
 */
export function mayManage(req) {
  const a = req?.bandiAuth;
  if (!a) return false;
  return a.kind === 'user';
}


/**
 * 闸。返回 `true` = 放行；`false` = **已经回过响应了**，调用方直接 return。
 *
 * 未授权时给什么，看它要什么：
 *   · 浏览器要页面（非 /api/ 的 GET）→ 一张**登录页**（表单），别丢一个 JSON 401 给它；
 *   · 其余（API、脚本、节点）→ 401 JSON，并把 `platform: 'bandi'` 带上 ——
 *     启动器靠这个字段判"是班底、只是要令牌"，不至于把它误当成"平台没起来"而再起一个。
 */
export function guard(auth, req, res, url) {
  /*
   * **先判这次请求从哪来**（IAM §5.2 / §5.3）。
   *
   * 这条必须在所有豁免之前：下面每一条"免令牌"都只对**真·本机**成立，
   * 而 `remoteAddress` 在反代后面一律是 127.0.0.1 —— 拿它当"本机证明"等于没有闸。
   * 判完挂在 `req.bandiSource` 上，下游（本机接口策略、/api/state 的显隐）读它，别再各判一遍。
   */
  const source = classifySource(req, cfgNow());
  req.bandiSource = source;

  /*
   * **路由清单默认拒绝**（IAM §8.3，Phase 2 落地）：没登记的 `/api/*` 路径
   * 一律 404 E4090 —— 排在认证之前，"服务里有但清单上没有"的接口对**所有人**
   * 都不存在（连"探测它要不要凭据"这个信息都不给）。新加路由必须先去
   * `security/route-policy.mjs` 登记，smoke 的覆盖率扫描会逼着两端同步。
   */
  if (url.pathname.startsWith('/api/') && !isRegistered(url.pathname, req.method)) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(
      JSON.stringify({
        error: '没有这个接口',
        code: 'E4090',
        platform: 'bandi',
        hint: '路径没在路由权限清单里登记（默认拒绝）。若这是新接口，先在 security/route-policy.mjs 登记。',
      }),
    );
    return false;
  }

  /*
   * 免令牌的一条：`GET /api/hello`（2026-10-20）—— 本机自检"探这个地址"打的就是它。
   * 它**故意不带任何秘密**。必须在令牌检查之前放行。
   * （原来并排的 `/api/nodes/join` 豁免随多机节点子系统 2026-11-09 整体删除。）
   */
  if (req.method === 'GET' && url.pathname === '/api/hello') return true;

  /*
   * **版本指纹也免令牌**（2026-11-09）：`GET /api/web-version` 只回一个前端文件指纹
   * （`{v:'js-<mtime+size 之和>'}`），零敏感 —— 但它会被**没登录的旧页面**每 60 秒
   * 轮询一次，每次都吃 401，审计里刷成一串「拒绝访问」（用户截图问"这是什么"）。
   * 跟 `/api/ping` 同一类"探活"口径：故意无秘密，放行在令牌检查之前。
   */
  if (req.method === 'GET' && url.pathname === '/api/web-version') return true;

  /*
   * **身份中枢进门**（2026-11-06）：`GET /hub/enter?ticket=…`。
   *
   * 此刻请求手上**只有一张中枢签的票** —— 那就是它的凭据（手机壳里没有"登录表单"
   * 这一步，它只会打开一个 URL）。guard 只负责放它进来，
   * 验票、查本地授权表、发本机会话全在 `routes/hub.mjs` 里 —— 别在这里提前判，
   * 也别让这里"看起来像"在做认证。
   *
   * ⚠️ 它**不削弱**任何东西：票验不过就是 400，票有效但本地没认过这个账号就是 403。
   */
  if (req.method === 'GET' && url.pathname === '/hub/enter') return true;
  /*
   * **壳的会话过期改道点**（2026-11-08）：面板 HTML 请求没会话时，带壳标记的请求会被
   * 302 到这里（serveLoginOrReenter）。壳本该在 `shouldOverrideUrlLoading` 里接住、
   * 不真加载；接不住时这一页只是"正在重新连接"的静态说明 —— 放行它，别让它掉进
   * 登录页（那就又绕回原地了）。
   */
  if (req.method === 'GET' && url.pathname === REENTER_PATH) return true;
  /*
   * **中枢账号登录**（2026-11-07）：`POST /hub/login`。
   * 此刻请求手上什么都没有（这正是它的作用），密码就是要验的东西 ——
   * guard 只管放行，认人在 handler（routes/hub.mjs → 中枢）。
   */
  if (url.pathname === '/hub/login' && (req.method === 'GET' || req.method === 'POST')) return true;
  /*
   * 退出登录：它的凭据就是 `bandi_sid` 本身（handler 自己删那张票 + 清 Cookie），
   * 拿令牌来退一个不存在的登录没有任何意义。
   */
  if (req.method === 'POST' && url.pathname === '/api/logout') return true;
  /*
   * 图标是公开静态资源（登录页上就用着它们）：非 /api GET 若被挡成登录页 HTML，
   * 浏览器拿到的是 `text/html`，图就裂了。与上面那条同一模式，只放行图标目录。
   */
  if (req.method === 'GET' && url.pathname.startsWith('/icons/')) return true;

  /*
   * **本机壳子自动进门**（2026-11-10）：桌面壳启动时把窗口开到 `SHELL_ENTER_PATH?secret=…`，
   * 这里核 `local_secret` + 本机直连，发一张本机会话后 302 回面板。
   * 接不住（没 secret / 不是本机直连 / 还没有任何账号）就照常往下走：
   * 要页面 → 登录页；要 API → 401。
   */
  if (req.method === 'GET' && url.pathname === SHELL_ENTER_PATH) {
    if (handleShellEnter(req, res, auth, url)) return false;
  }

  /* 2026-11-16 生图通道整体退场：原 /api/ai/* 回环免令牌特例随之删除。 */

  if (!auth.required && source === 'loopback') {
    /*
     * 回环形态（桌面版 / 单机）—— **API 与面板分开**：
     *
     * · **API 仍是回环信任**：本机脚本 / 冒烟 / CLI 不带凭据照旧能干活；但**带有效
     *   登录会话的浏览器按登录人算**，没会话就按机主算（消息署名精确到人）。
     *   2026-11-20 起不再标成 `operator` —— 它直接就是**机主本人**（`localKeyWho`）。
     * · **面板要登录**：抓 HTML 一律给**中枢账号登录页**（2026-11-07 起只有这一张）。
     */
    const sid = sessionTokenOf(req);
    if (sid) {
      const hit = store.userBySession(sid);
      if (hit) {
        req.bandiAuth = {
          kind: 'user',
          userId: hit.user.id,
          via: 'session-loopback',
        };
        return true;
      }
    }
    req.bandiAuth = localKeyWho('loopback');
    /*
     * **面板只给"人"**：回环信任不是"我"—— 它没有会话，「我的」页画不出登录态，
     * 退出登录按了也没用。所以门前移：没会话就给登录页。
     */
    if (wantsPanelHtml(req, url)) return serveLoginOrReenter(req, res, auth);
    return true;
  }

  const got = tokenOf(req, url);
  /*
   * **运行钥匙**（2026-11-08，全员群 401 实报的修法）：数字员工进程调平台专用口时带
   * `X-Bandi-Run-Token`（runs.mjs 注入进程环境，一次 run 一把、收尾吊销）。只从
   * "本机直连"认（见 isDirectLocalRequest 的说明）；反代进来的请求不认。
   */
  const runTok = isDirectLocalRequest(req) ? String(req.headers['x-bandi-run-token'] ?? '') : '';
  let who = identify(runTok);

  /*
   * **本机钥匙 → 机主**（2026-11-20，operator 下线）。钥匙（`X-Bandi-Token` 头或
   * `?token=`）不再是一种身份，它只证明"我能读这台机器的 0600 文件"，换出来的是
   * **本机第一个账号**。所以脚本 / CLI / 运维的行为一个字节没变，但身份表里少了一档。
   */
  if (!who && got && auth.token && timingSafeEqual(got, auth.token)) who = localKeyWho();

  /*
   * **登录会话兜底**（2026-10-28 第三刀）。
   *
   * 顺序是**钥匙优先、会话兜底**，不是反过来：手里握着本机钥匙的请求（运维 / 脚本）
   * 不该被浏览器里一张陈旧的会话票降权到某个普通账号。两条路互不覆盖。
   *
   * 回环分支在更上面已经 return 了，所以桌面端永远走不到这里（免登录）。
   */
  if (!who) {
    const sid = sessionTokenOf(req);
    if (sid) {
      const hit = store.userBySession(sid);
      if (hit) {
        who = {
          kind: 'user',
          userId: hit.user.id,
          via: hit.kind === 'hub' ? 'hub' : 'session',
        };
      }
    }
  }

  if (who) {
    /*
     * **判定只有一处**：Cookie / 头 / 查询参数三路都走到同一个 `decide()`，
     * 于是"同一个身份换个携带方式就换出一套权限"不可能发生（决策 A 规则 3）。
     */
    const decision = decide(who, req.method, url.pathname);

    /*
     * E4031 保留为 policy 的**兜底拒绝**（未知身份落这里）：现实中 identify() 只认
     * `run`，其余都是 `user`（会话或本机钥匙合成），这个分支不该被走到 —— 留着它，
     * 万一将来多出一种身份，默认是拒而不是放。
     */
    if (decision === 'E4031') {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(
        JSON.stringify({
          error: '这台机器只有算力权限，看不了面板',
          code: 'E4031',
          platform: 'bandi',
          hint: '要看设备、对话、员工，请用账号登录，或带本机钥匙（数据目录 token 文件里那枚）。',
        }),
      );
      return false;
    }

    if (decision === 'E4033') {
      /*
       * 只有手机设备令牌会走到这里（登录用户已全权，见 policy.mjs）：
       * 手机端只开放白名单那批接口。
       */
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(
        JSON.stringify({
          error: '手机端只开放看状态、审卡票和给员工发消息，这个操作在手机上做不了',
          code: 'E4033',
          platform: 'bandi',
          hint: '请在桌面端操作。',
        }),
      );
      return false;
    }

    if (decision === 'E4034') {
      /*
       * 运行钥匙（数字员工的"工作证"）只开放建卡通道与只读台账 —— 见 policy.mjs 的
       * run 分支与 route-policy 的 `run: true` 标记（2026-11-08 实报修复）。
       */
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(
        JSON.stringify({
          error: '运行钥匙只开放建卡通道与只读台账（状态 / 任务 / 项目 / 运行时），这个操作不归它管',
          code: 'E4034',
          platform: 'bandi',
          hint: '要立项就建卡（POST /api/agent/cards）；要动别的东西，请让雇主在面板上操作。',
        }),
      );
      return false;
    }

    /*
     * 地址栏里的**本机钥匙**（`?token=`）：换一张**会话票**再 302，把它从历史 / Referer
     * 里摘掉。
     *
     * 2026-11-20 改：以前换的是 `bandi_token` Cookie —— 等于把根钥匙塞进浏览器（比 URL
     * 更长寿、更难收回）。现在钥匙不进浏览器：换出来的是**机主本人的会话**，之后浏览器
     * 只带 `bandi_sid`。没有账号（全新库）就只把 token 从地址里摘掉，落到登录页。
     */
    if (who.via === 'local-key' && url.searchParams.get('token')) {
      const rest = url.pathname + (stripToken(url.searchParams) || '');
      const owner = store.firstUser();
      if (!owner || owner.disabled) {
        res.writeHead(302, { Location: rest, 'Cache-Control': 'no-store' });
        res.end();
        return false;
      }
      const { token } = store.createSession(owner.id, {
        ip: req.socket?.remoteAddress ?? null,
        ua: req.headers['user-agent'] ?? '',
        kind: 'local-key',
      });
      res.writeHead(302, {
        'Set-Cookie': sessionCookie(token),
        Location: rest,
        'Cache-Control': 'no-store',
      });
      res.end();
      return false;
    }
    /*
     * **钥匙不是登录态**（2026-11-01 的规矩，2026-11-20 之后更明确）：面板 HTML 只给会话。
     * 拿钥匙抓首页（脚本 / 手工带头的浏览器）一律给登录页 —— 否则「我的」页会以一个
     * 没有会话的身份渲染，退出登录按了也没用。API 照旧认这把钥匙。
     */
    if (who.via === 'local-key' && wantsPanelHtml(req, url)) {
      // 陈年 `bandi_token` Cookie 已经没有用了（tokenOf 不再读它），顺手清掉，别让它在
      // 浏览器里躺一年。
      const stale = String(parseCookies(req.headers.cookie)[COOKIE] || '');
      return serveLoginOrReenter(req, res, auth, stale ? [clearedTokenCookie()] : []);
    }
    req.bandiAuth = who; // 下游（署名、员工编辑的字段闸）据此知道这是谁
    return true;
  }

  /*
   * ⚠️ **必须是 `wantsPanelHtml`，不能是一刀切的"GET 且非 /api/"**（2026-11-02 三十三改）。
   *
   * 老写法让 `/sw.js` 这类静态文件在**没带任何凭据**时也吃到登录页 HTML
   * （`200 + text/html`）：浏览器那边是 MIME/语法错误，命令行那边更阴 —— `curl … | grep`
   * 拿到一张登录页去数关键词，得到的是"没找到"，看上去和"文件没部署上"一模一样
   * （2026-11-02 实踩：验线上静态模块就是这么被误导的）。
   * 上面两处（回环分支 / 令牌分支）早就换成同一个判据，唯独这里漏了；
   * 静态资源现在走下面的 401 JSON（`E4010`），页面照旧给登录页。
   */
  /*
   * 带了运行钥匙却没认出来（run 已收尾吊销 / 伪造 / 抄错）：给一句能自己判断的话。
   * 2026-11-08 全员群实报：两个员工都被笼统的 E4010 带到"重置 BANDI_RUN_TOKEN"这条死路 ——
   * 那枚钥匙是**每次 run 现发**的，不存在可重置的长期值。
   */
  if (runTok) {
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(
      JSON.stringify({
        error: '运行钥匙无效或已过期（每次 run 现发、run 收尾即作废；不是权限问题）',
        code: 'E2056',
        platform: 'bandi',
        hint: '用本进程环境变量 BANDI_RUN_TOKEN 现取重试（PowerShell 写 $env:BANDI_RUN_TOKEN）；别复制历史命令里的值——那多半是上一轮的旧钥匙。不需要、也没法"重置 token"。',
      }),
    );
    return false;
  }

  const wantsHtml = wantsPanelHtml(req, url);
  if (wantsHtml) {
    /*
     * 顺手扫掉**没法用的**访问令牌 Cookie（2026-11-01）：认不出来的根令牌、早已退场的
     * `bd_` 配对令牌、`bn_` 节点令牌（2026-11-09 随多机子系统删除），留在浏览器里只会
     * 在每次请求上添一次 401，还挡在"令牌优先"那条路上。到这一步说明它已经认不出来了，
     * 清掉是安全的。
     */
    const staleTok = String(parseCookies(req.headers.cookie)[COOKIE] || '');
    return serveLoginOrReenter(req, res, auth, staleTok ? [clearedTokenCookie()] : []);
  }

  /*
   * 文案要分清"从哪来"：`source === 'network'` 包含**本机直连但控制面在对外监听**
   * （2026-11-03 起本机也要鉴权）—— 这时再说"不是从本机直接发起的"是假话
   * （2026-11-10 用户实拍本机壳子发消息收到这句，以为被当成外部请求）。
   */
  const localPeer = isDirectLocalRequest(req);
  res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(
    JSON.stringify({
      error: localPeer
        ? '需要登录（本机请求也要账号会话；桌面壳会自动重新进门）'
        : source === 'network'
          ? '需要登录或访问令牌（这个请求不是从本机直接发起的）'
          : '需要访问令牌（这个控制面没有监听回环地址）',
      code: 'E4010',
      platform: 'bandi',
      hint: '带 X-Bandi-Token 头，或浏览器打开首页用账号登录。令牌在数据目录的 token 文件里。',
    }),
  );
  return false;
}

/**
 * 这次请求是不是在要**面板页面**（不是 API、不是静态资源）。
 *
 * 只认真正会渲染成文档的那几种：根路径 / `*.html` / `Accept: text/html`。
 * 不这么收窄的话，`/app.mjs`、`/style.css` 也会被当成"要页面"而吃到登录页 HTML
 * （浏览器那边表现成"脚本语法错误"，比登录页还难查）。
 */
function wantsPanelHtml(req, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const p = url.pathname;
  if (p.startsWith('/api/')) return false;
  if (p === '/' || p.endsWith('.html')) return true;
  return String(req.headers.accept ?? '').includes('text/html');
}

/**
 * 本机壳子进门（`SHELL_ENTER_PATH`）：核 `local_secret` + 本机直连 → 发一张本机会话。
 *
 * 返回 `true` = 已经回过响应；`false` = 没接住，交给 guard 后面的常规路径。
 * 注意**不是**"有 secret 就登"：必须同时满足本机直连（反代后面 peer 也是 127.0.0.1，
 * 但会带转发头 / Host 不是本机名 —— `isDirectLocalRequest` 那三道就是干这个的）。
 */
function handleShellEnter(req, res, auth, url) {
  // 回环免鉴权形态：壳不会走这条路（它探测到 200 就直开原地址），别在"本来就不用登录"的机器上多发一张会话
  if (!auth?.required) return false;
  if (!isDirectLocalRequest(req)) return false;
  // Host 收紧到回环字面量：壳在 127.0.0.1 上开窗口；本机网卡名/Host 改写不认（缩小隧道+改 Host 的组合面）
  if (!isLoopbackHost(hostnameOf(req.headers.host))) return false;
  const got = String(url.searchParams.get('secret') ?? '').trim();
  if (!got) return false;
  const expected = localSecret.ensure();
  if (!expected) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const owner = store.firstUser();
  if (!owner || owner.disabled) return false;
  /*
   * 进门后去哪（2026-11-14）：默认回面板 `/`；带 `to` 就直接送去那 ——
   * 「聊天里点文件 pill → 系统浏览器没有会话票」的修法：`/api/open` 把目标包进
   * 进门链（见 routes/workspace.mjs），进门签票后 302 直达文件。
   * `to` 只认**本站相对路径**（/ 开头、且不是 //）—— 别的形态一律回落 `/`，
   * 这条 302 绝不往站外送（开放重定向闸）；也不能绕回进门路径自己（死循环）。
   */
  let to = String(url.searchParams.get('to') ?? '/');
  if (!/^\/(?!\/)/.test(to) || to.split('?')[0] === SHELL_ENTER_PATH) to = '/';
  /*
   * **已经带票的浏览器不再重复签发**（2026-11-14）：`/api/open` 的"先进门再看"每次点击
   * 都会走这条链 —— 浏览器里已经躺着有效的 `bandi_sid` 时，再发一张 180 天会话只会把
   * 会话表灌爆。有票 → 直接 302 去目标。
   */
  const sidIn = sessionTokenOf(req);
  if (sidIn) {
    const hit = store.userBySession(sidIn);
    if (hit) {
      res.writeHead(302, { Location: to, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      res.end();
      return true;
    }
  }
  const { token } = store.createSession(owner.id, {
    ip: req.socket?.remoteAddress ?? null,
    ua: req.headers['user-agent'] ?? '',
    kind: 'shell',
  });
  res.writeHead(302, {
    // Cookie 寿命与 store 里这张会话一致（180 天）；壳重开也会再进一次，这里只是兜底
    'Set-Cookie': sessionCookie(token, store.SHELL_SESSION_DAYS * 86400),
    Location: to,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  });
  res.end();
  return true;
}

/**
 * 无会话抓面板 HTML 的出口：**人对登录页，壳对 302**（2026-11-08）。
 *
 * 壳（UA 带 `BandiShell/`）出现在这里，说明它手里那张**本机会话**过期了 —— 壳的
 * 凭据在中枢（30 天），本机会话只有 12 小时绝对 / 30 分钟空闲（`store/users.mjs`），
 * 两者本来就不该同步过期。这时把登录页画给壳，等于让用户用"浏览器的方式"解决
 * "壳的问题"：他要的只是回到面板，而壳随时能用中枢会话重签一张票（`/hub/enter`）。
 *
 * 所以壳改道 {@link REENTER_PATH} 由壳静默重进；人照旧拿登录页 —— 浏览器没有签票
 * 能力，输账号密码是它唯一能走的路。
 *
 * @param {string[]} extraCookies 调用方要顺手清掉的 Cookie（陈旧的访问令牌）
 */
function serveLoginOrReenter(req, res, auth, extraCookies = []) {
  // 登录页顺手种 CSRF 双提交值：登录成功后所有带 Cookie 的写请求都要带上它。
  // 值同时给到页面（中枢登录表单的隐藏域）：桌面壳的表单 POST 会带 Origin: null
  // （2026-11-07 实报 E7006），/hub/login 的同源闸拿这对值兜底（routes/hub.mjs）。
  const hadCsrf = csrf.valuesOf(req).cookie;
  const csrfVal = hadCsrf || csrf.mint();
  const setCookies = [...extraCookies];
  if (!hadCsrf) setCookies.push(csrf.cookieFor(csrfVal));

  if (SHELL_UA.test(String(req.headers['user-agent'] ?? ''))) {
    const headers = { Location: REENTER_PATH, 'Cache-Control': 'no-store' };
    if (setCookies.length) headers['Set-Cookie'] = setCookies;
    res.writeHead(302, headers);
    res.end();
    return false;
  }

  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
  if (setCookies.length) headers['Set-Cookie'] = setCookies;
  res.writeHead(200, headers);
  res.end(loginPage({ mobile: isMobileUA(req), hub: hubOf(auth), csrf: csrfVal }));
  return false;
}

function stripToken(params) {
  const rest = new URLSearchParams(params);
  rest.delete('token');
  const s = rest.toString();
  return s ? `?${s}` : '';
}

/*
 * 2026-11-20 删：`cookieHeader()` / `cookieValue()`。
 * 它们只服务"把根钥匙塞进浏览器 Cookie"那条路 —— 那条路已经换成发会话票，
 * 钥匙不再进浏览器。留着就是又一段"看起来还能用"的死代码。
 */

/** 定长比较，别让"比到第几个字符不同"泄漏出去 */
function timingSafeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

/** 登录页内联 HTML 的转义（用户名/域名是用户输入，别让它把页面写成 XSS） */
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const esc = escapeHtml;

/**
 * 登录页（2026-11-07 定稿）：**只有一张** —— 中枢账号密码框，桌面/手机同一份标记，
 * 按 isMobileUA 出两套版式。本机的账号磁贴/建号页/OTP 二段已随本地账号体系整体退场。
 */

/**
 * 品牌标「分玉」（design/logo/bandi-brand.md v2.1）：圆沿竖直直径切成两片、两片贴合、
 * 右片下沉 —— 「分而后成班」。
 *
 * 三条口径，抄的是 `design/logo/bandi-icon-favicon.svg`，不是自己画的：
 *   · 登录页是**门面**（与启动页、关于页同档），按 §三 主用「墨底反白」；
 *   · 这里渲染成 40px，落在 §六「≤48px 一律用 favicon 光学版」档 —— 错位 22、放大 1.15、
 *     单色无缝。**不要拿 icon-light 缩放**：全版 12 单位的缝在 20px mark 上只有 2px，一糊就是实心圆；
 *   · §八 禁用清单：不渐变、不投影、不描边。标识的高级感来自克制，不是发光。
 *
 * 为什么内联而不是 `<img src>`：这一页零外部依赖、零脚本（脚本挂了人也得能登进来），
 * 一个内联 svg 不必为它开静态路由。
 *
 * @param {'hub'} key 仅用于表达"这是门面位置"，目前只有一处；将来多处实例时靠它区分。
 */
function bandiMark(key = 'hub') {
  return `<svg viewBox="0 0 512 512" role="img" aria-label="班底" data-mark="${key}">
  <title>班底</title>
  <rect width="512" height="512" rx="110" fill="#12161A"/>
  <g transform="translate(256 256) scale(3.737) translate(-50 -54.8)" fill="#F2F1ED">
    <path d="M50 4 A40 40 0 0 0 50 84 Z"/>
    <path d="M50 4 A40 40 0 0 1 50 84 Z" transform="translate(0 22)"/>
  </g>
</svg>`;
}

/**
 * 登录页分发器（2026-11-07 起只剩一张）：中枢账号密码框，桌面/手机同一份标记。
 * mobile 位由 guard 的发放点按 isMobileUA(req) 传入，只影响版式不影响内容。
 */
function loginPage(args) {
  return loginHubPage({ hub: args.hub, mobile: args.mobile, csrf: args.csrf });
}

/**
 * 这台机器连哪个中枢 —— 只看配置，**不联网、不探活**。
 *
 * 开箱即用：地址默认内置，`hub.json` 没写过也照样有值，登录页永远是中枢账号页。
 */
function hubOf(auth) {
  try {
    const dataDir = auth && auth.dataDir;
    const baseUrl = hubBaseUrl(dataDir);
    const cfg = readHubConfig(dataDir);
    return {
      baseUrl,
      host: new URL(baseUrl).host,
      deviceId: cfg?.deviceId ?? null,
      name: cfg?.name || null,
      accountId: cfg?.accountId ?? null,
    };
  } catch {
    return { baseUrl: DEFAULT_HUB_URL, host: new URL(DEFAULT_HUB_URL).host, deviceId: null, name: null, accountId: null };
  }
}

/**
 * 登录页（2026-11-07 定稿）：**手机号 + 密码，一个框一个按钮**。
 *
 *   · 提交到本机 `POST /hub/login`，由主机转给中枢（不跳域，桌面壳里不白屏）；
 *   · **登录即注册**：手机号没注册过就当场创建（中枢说了算），不用找"注册页"；
 *   · 页面**没有一行脚本**：脚本挂了人也得能登进来；
 *   · 失败原地回到这里并带上原因，不把人丢到一屏错误码上。
 *
 * @param {{ hub: { host: string, name?: string|null }, error?: string|null, username?: string, mobile?: boolean }} args
 */
function loginHubPage({ hub, error = null, username = '', mobile = false, csrf = '' }) {
  // hub 现在没有落点：品牌区只留标 + 「班底」，「登录 xxx 上的账号」那行副标题已删。
  // 形参留着是为了调用方（renderHubLoginPage / guard）不用跟着改 —— 要恢复那行，用它就是。
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
<title>班底 · 登录</title>
<style>
  :root {
    --bg: #0f1116;
    --card: #16191f;
    --line: rgba(255,255,255,.10);
    --line-strong: rgba(255,255,255,.14);
    --text: #e9ecf2;
    --dim: #8d94a5;
    --label: #c9cfdc;
    --input: rgba(255,255,255,.04);
    --accent: #0a84ff;
    --btn: #0071e3;
    --bad: #ff8a80;
    --bad-bg: rgba(255,90,80,.10);
    color-scheme: dark;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f4f6f9;
      --card: #ffffff;
      --line: #e8ebf0;
      --line-strong: #d9dee7;
      --text: #101828;
      --dim: #667085;
      --label: #344054;
      --input: #ffffff;
      --accent: #0066cc;
      --btn: #0066cc;
      --bad: #c0392b;
      --bad-bg: #fdf0ee;
      color-scheme: light;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100dvh; background: var(--bg); color: var(--text);
    display: flex; flex-direction: column; align-items: center;
    padding: 28px 20px calc(28px + env(safe-area-inset-bottom));
    font: 14.5px/1.6 system-ui, -apple-system, 'Segoe UI', 'Noto Sans SC', 'Microsoft YaHei', sans-serif;
    -webkit-text-size-adjust: 100%;
  }
  /* 一张卡：372px 的内容不再漂在底色上，脚注也才有归属。
     垂直居中用 margin:auto 而不是 justify-content:center —— 内容比视口高时（手机键盘弹起）
     auto 边距会收成 0、卡片从顶部开始，还能往下滚；justify-content 会把上下一起溢出，
     标题被顶出屏幕后滚不回来。 */
  .card {
    width: 100%; max-width: 372px; margin: auto 0; padding: 24px 24px 20px;
    background: var(--card); border: 1px solid var(--line); border-radius: 14px;
  }
  .brand { display: flex; align-items: center; gap: 11px; margin-bottom: 20px; }
  /* 标识自带墨底与 21.5% 圆角（画在 svg 里），CSS 不再加底色/投影 —— VI §八 */
  .logo { width: 40px; height: 40px; flex: none; }
  .logo svg { display: block; width: 100%; height: 100%; }
  /* 标题照 bandi-lockup-light.svg 的口径：34/80 字号比 → 40px 标识配 17~18px，700、字距 1（按比例 0.5px）。
     别自创更细的字重：lockup 里的字标就是 700，改细了就不是同一套组合了。 */
  h1 { margin: 0; font-size: 18px; font-weight: 700; letter-spacing: .5px; line-height: 1.3; }
  form { margin: 0; display: flex; flex-direction: column; gap: 18px; }
  /* 标签行：左 label 右提示。「11 位」这种约束放在框里当 placeholder，会跟 label 抢同一层灰 ——
     一个框里两个灰字，人分不清哪个是名字哪个是说明。 */
  .row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
  label { display: block; font-size: 12px; font-weight: 500; color: var(--label); }
  .hint { font-size: 11px; color: var(--dim); }
  input {
    width: 100%; height: 44px; padding: 0 12px; border-radius: 9px;
    border: 1px solid var(--line-strong); background: var(--input); color: var(--text);
    font: inherit; outline: none; transition: border-color .15s, box-shadow .15s;
  }
  input::placeholder { color: var(--dim); opacity: .8; }
  input:hover { border-color: color-mix(in srgb, var(--text) 24%, transparent); }
  /* 焦点靠"边框加粗"表达，不用外扩的 glow 环：3.5px 的外环会左右各顶出去，
     一进页面（autofocus）就把唯一的那条左对齐线弄歪。inset 阴影长在盒子里，尺寸不变。 */
  input:focus { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
  input:-webkit-autofill, input:-webkit-autofill:hover, input:-webkit-autofill:focus {
    -webkit-text-fill-color: var(--text);
    -webkit-box-shadow: 0 0 0 100px var(--card) inset;
    caret-color: var(--text);
    transition: background-color 9999s ease-out;
  }
  .err {
    margin: 0 0 16px; padding: 10px 12px; border-radius: 9px;
    font-size: 12.5px; line-height: 1.5; color: var(--bad);
    background: var(--bad-bg); border: 1px solid color-mix(in srgb, var(--bad) 28%, transparent);
  }
  /* 按钮是终点，不是第五个字段：比输入框高 2px、再拉开 6px；投影去掉（VI §八 禁发光） */
  button {
    height: 46px; border-radius: 9px; border: 0; cursor: pointer; margin-top: 6px;
    background: var(--btn); color: #fff; font: inherit; font-weight: 500; letter-spacing: 0;
    transition: filter .15s, transform .12s;
  }
  button:hover { filter: brightness(1.08); }
  button:active { transform: translateY(1px); filter: brightness(.97); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button:disabled { opacity: .55; cursor: not-allowed; filter: none; transform: none; }
  /* 脚注跟表单同一条左边界。"提交就自动创建"是这页最该被读到的一句，不能是唯一居中又最小的一行 */
  .foot { margin: 14px 0 0; font-size: 12.5px; color: var(--dim); line-height: 1.6; }
  .foot strong { font-weight: 500; color: var(--text); }
  code { font-family: ui-monospace, Consolas, monospace; font-size: .92em; letter-spacing: 0; }
</style>
</head>
<body>
  <div class="card">
    <div class="brand">
      <div class="logo">${bandiMark('hub')}</div>
      <div>
        <h1>班底</h1>
      </div>
    </div>
    ${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}
    <form method="post" action="/hub/login" autocomplete="on">
      <!-- _csrf 与 bandi_csrf Cookie 成对：提交端在 Origin 缺失/为 null 时靠它兜底（routes/hub.mjs） -->
      ${csrf ? `<input type="hidden" name="_csrf" value="${esc(csrf)}" />` : ''}
      <div>
        <div class="row">
          <label for="u">手机号</label>
          <span class="hint" id="u-hint">11 位</span>
        </div>
        <input id="u" name="username" value="${esc(username)}" type="tel" inputmode="tel"
               autocomplete="tel" maxlength="11" aria-describedby="u-hint"
               autocapitalize="off" spellcheck="false" required ${mobile ? '' : 'autofocus'} />
      </div>
      <div>
        <div class="row">
          <label for="p">密码</label>
        </div>
        <input id="p" name="password" type="password" autocomplete="current-password" required />
      </div>
      <button type="submit">登录</button>
    </form>
    <p class="foot">没注册过？<strong>提交就自动创建</strong></p>
  </div>
</body>
</html>`;
}

/** 给路由层复用：登录失败时原地回到这一页（带原因与已填的手机号） */
export function renderHubLoginPage({ error = null, username = '', csrf = '' } = {}) {
  return loginHubPage({ hub: { host: '' }, error, username, csrf });
}

/** 明文 TLS 告警条（IAM §10.1.1）：两端的登录页都顶在表单跟前，两端各调样式 */
/*
 * 这台设备是不是手机/平板（2026-11-06 双端分设计的分叉点）。两个信号任一命中即算：
 *   · Sec-CH-UA-Mobile: ?1 —— Chromium 系默认随每个请求发的低熵客户端提示，最可靠；
 *   · UA 正则 —— Safari（不发客户端提示）与 Android WebView 兜底。
 * 误判代价可控：手机被判成 PC 会拿到分栏页（≤960px 自动收成单列，仍可用）；
 * PC 被判成手机几乎不可能（桌面 UA 不含这些词）。桌面 Tauri 壳（Windows）走 PC 页。
 */
function isMobileUA(req) {
  if (String(req.headers['sec-ch-ua-mobile'] ?? '').trim() === '?1') return true;
  return /Android|iPhone|iPod|iPad|Mobi|Phone/i.test(String(req.headers['user-agent'] ?? ''));
}
