/**
 * 访问令牌 —— **把控制面放到公网之后的第一道闸**（账号管"人"，令牌管"机器"，两层并存）。
 *
 * 2026-10-15 的原始规则只看**监听地址**、不看请求来源：
 *
 *   · 只监听回环（桌面版 / 单机）→ **API 免鉴权**。外面根本进不来，加它就是白加，
 *     还会把"单机零配置、不需要 token"这条硬约束毁掉。
 *   · 监听非回环（服务器）→ **所有请求都要令牌**。
 *
 * ⚠️ **2026-10-31 补丁（IAM §5.3，P0）**：上面这条只说了"进程听哪儿"，但**免鉴权是按请求给的**
 * —— 反向代理把流量转进 `127.0.0.1:18787` 之后，外部请求在服务端看就是"回环来源"，
 * 于是整套面板、会话、导出全部免登录（这是本设计里最严重的一个洞）。
 * 现在每次请求都用 `security/source.mjs` 的 `classifySource()` 现算，四条同时成立才算本机：
 * 未设 `BANDI_TRUST_PROXY`、无转发头、监听回环、peer 与 Host 都是本机。
 * 判出来不是本机 → 照常走认证（`auth.required` 只决定"进程有没有令牌可用"，
 * 不再决定"这个请求要不要认证"）。
 *
 * 2026-10-31 用户拍板补了一层（「不管总机还是分机，都要用用户来登录」）：
 * 回环形态下 **API 照旧免鉴权**（脚本/冒烟/CLI 一个字节没变），但**浏览器抓面板 HTML
 * 要先有登录会话**（有账号而无会话 → 登录页，免密账号点了就进，见 guard 的回环分支）——
 * API 的闸管机器和脚本，登录的闸管人，两层各管各的。
 *
 * 为什么**不只看 `remoteAddress` 是不是 `127.0.0.1`**：反向代理会把来源变成回环 ——
 * 那样架一层代理就把闸绕过去了。所以判的是 `classifySource()` 的**四条同时成立**
 * （没开 trust-proxy、无转发头、监听回环、peer 与 Host 都是本机），不是单看一个字段。
 *
 * 令牌从哪来，按优先级：
 *   1. `BANDI_TOKEN`（显式指定，方便容器/CI）
 *   2. 数据目录里的 `token` 文件（首次启动自动生成，权限 0600）
 *
 * 三种带法都认，各有各的用处：
 *   · **Cookie** `bandi_token` —— 浏览器。登录页设上之后，`fetch` 与 `EventSource`
 *     同源请求都会自动带上（EventSource **没法自己设头**，这是它唯一的活路）。
 *   · **头** `X-Bandi-Token` —— 节点与脚本。
 *   · **查询** `?token=` —— 首次进来那一下，随即换成 Cookie 并重定向掉，
 *     免得令牌留在地址栏与历史里。
 *
 * ⚠️ **"为什么不做用户名＋密码"（2026-10-16 的结论，已被 2026-10-31 推翻 —— 留档防绕回，别再当现行口径）**
 * 当时用户问过三次，结论是"不做"，理由有两条：
 *   · 明文 HTTP 下令牌、密码、会话票**一样会被抓包** —— 真正要防抓包只有一条路：**把链路加密**
 *     （SSH 隧道 / Cloudflare 隧道 / 给控制面挂 TLS）—— 这条**至今成立**；
 *   · 随机令牌影响面小、能一键作废（删 `token` 文件 + 重启）—— 这条也**至今成立**（机器凭据那一层没变）。
 * **2026-10-31 用户拍板改做账号体系**（「不管总机还是分机，都要用用户来登录」，见上面那层）。
 * 当时列的"三笔账"后来都还了：
 *   · 第一个账号只有本机能设 → 零账号时建号页只在回环形态出现（guard 回环分支，第一个账号 = 内置管理员）；
 *   · 加盐哈希＋长度下限＋失败限速 → `store/users.mjs`（scrypt）＋登录限速；
 *   · 忘了怎么重置 → 两段式登录（TOTP 动态码 / 恢复码，`/api/login/otp`）。
 * 结论不是当年的二选一：**账号管"人"（浏览器面板），令牌管"机器"（脚本 / CLI / 节点），两层并存**。
 *
 * 要找回令牌就一条命令（控制面那台机器上）：
 *   Windows:  `type <数据目录>\token`      例：type E:\02CodeSpace\bandi\data\token
 *   Linux:    `cat  <数据目录>/token`      例：cat ~/bandi-data/token
 * 登录页上也写着同一句话 ✓（那才是"翻找"时人会看的地方）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// 每节点令牌存在库里（只存哈希）—— 认证层要能认出来"这是哪台机器的令牌"
import * as store from './store.mjs';
/*
 * 「这个请求从哪来」的唯一判定点（IAM §5.2）。
 * 2026-10-31 起**本文件不再自己判 remoteAddress** —— 原来那句
 * `if (isLoopbackHost(host)) return { required:false }` 在反代部署下等于全站免登录。
 */
import { classifySource, cfgNow, isLoopbackHost } from './security/source.mjs';
import { warning as tlsWarning } from './security/tls-check.mjs';
import * as tokens from './security/tokens.mjs'; // Bearer at_ 短票（§7.1，Phase 3）
import * as policy from './security/policy.mjs';
import { isRegistered } from './security/route-policy.mjs';
import * as csrf from './security/csrf.mjs';

export { isLoopbackHost };

const COOKIE = 'bandi_token';
const HEADER = 'x-bandi-token';

/*
 * **登录会话 Cookie**（2026-10-28 第三刀：账号、登录与角色分配）。
 *
 * 与 `bandi_token` 是**两条互不相干的路**：
 *   · `bandi_token` = 共享令牌（root / 节点 / 手机）—— 本刀一个字节没动；
 *   · `bandi_sid`   = 某个**人**登录后的会话票，只对非回环浏览器有意义。
 * 两条同时存在时**令牌优先**（见 guard 里的注释）：一个陈旧的会话 Cookie 不该
 * 把握着 root 令牌的请求降权成普通用户。
 */
const SID_COOKIE = 'bandi_sid';
/** 会话 Cookie 存活天数 —— 必须与 `store.SESSION_DAYS` 一致（两处一起改） */
const SID_MAX_AGE = 30 * 86400;


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
  if (!required) return { required: false, token: '', from: '', created: false };
  return { required: true, ...ensureToken(dataDir, envToken) };
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

/** 这次请求带的令牌（三路取第一个非空的） */
export function tokenOf(req, url) {
  const cookie = parseCookies(req.headers.cookie)[COOKIE];
  const header = req.headers[HEADER];
  const query = url.searchParams.get('token');
  return String(cookie || header || query || '');
}

/** 这次请求带的**登录会话**票（`bandi_sid`；没有就是空串） */
export function sessionTokenOf(req) {
  return String(parseCookies(req.headers.cookie)[SID_COOKIE] || '');
}

/** 给登录成功用：`Set-Cookie` 的值（HttpOnly：JS 读不到，XSS 偷不走） */
export function sessionCookie(token) {
  return `${SID_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SID_MAX_AGE}`;
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
 * 这枚令牌**是谁的**（2026-10-16 加的，2026-10-20 带上 scope）。
 *
 * 原来是"一枚令牌走天下"：节点手上的就是总机那枚 master ✗ —— 一台节点被翻 = 整套被翻，
 * 而且「忘掉」踢不掉它（令牌还有效）。现在分四类身份（2026-11 手机端增量补了第三类）：
 *   · `operator` —— 总机那枚（脚本 / CLI / 运维，以及 `?token=` 首次进场；
 *                   **浏览器面板走账号会话**，见 `guard` 的回环分支）；
 *   · `node`     —— 每台机器**自己那枚**（邀请码换来的，见 store.issueNodeToken），
 *                  带 `scope: Set`（`compute` / `panel`）；
 *   · `device`   —— 手机设备令牌（`bd_` 前缀，2026-11 手机端增量；见下面 identify 里的注释），
 *                   2026-11-03 起带 `userId`（这部手机属于谁），但**权限仍是 device 白名单**；
 *   · `revoked`  —— **曾经是节点令牌、现在库里没有这行哈希**（唯一会删它的是
 *                  `store.revokeNodeTokens`，也就是总机上的「忘掉」）。
 *
 * ⚠️ `revoked` 只在令牌以 `bn_` 开头时才判（设计 §5.10）：那个前缀是节点令牌自己带的，
 * 于是"查不到"能确定是**被吊销**而不是"抄错了/操作员令牌删了"——
 * 后者必须还是 `E4010`（需要令牌），不能骗人说"你被撤销了"。
 */
export function identify(auth, token) {
  if (!token) return null;
  if (auth.token && timingSafeEqual(token, auth.token)) return { kind: 'operator' };
  const hit = store.nodeAuthByToken(token);
  if (hit) return { kind: 'node', nodeId: hit.nodeId, scope: hit.scope };
  /*
   * 第四类身份：手机设备令牌（`bd_` 前缀，2026-11 手机端增量）。
   * 走 store.deviceAuthByToken（只存哈希的那张表）；不认识/已过期/被踢出/归属人被禁用
   * 都返回 null，走下面的 401 E4010 —— **不学节点造 `revoked` 类**：设备被踢出的引导是
   * "重新扫码"，与"需要令牌"在前端是同一条提示，不值得多一个身份类。
   *
   * `userId`（2026-11-03 设备绑人）：这部手机**属于谁**。以前设备是孤儿 —— 有身份
   * （deviceId + 设备名）但不挂在任何人名下，于是手机上审批/发消息在事件流里只记
   * 「一台设备」。现在把归属人一起带出来，`actorUser` 才能把它记到人头上。
   * ⚠️ 带 userId ≠ 提权：`kind` 仍是 `device`，PDP 照走 device 白名单
   * （security/policy.mjs），手机看不到比白名单更多的东西。
   */
  const dev = store.deviceAuthByToken(token);
  if (dev) return { kind: 'device', deviceId: dev.deviceId, userId: dev.userId ?? null };
  if (String(token).startsWith('bn_')) return { kind: 'revoked' };
  return null;
}

/**
 * **权限边界**：节点令牌只许碰"它自己那台"的节点接口。
 *
 * 往里加路径之前先回答一句：节点**凭什么**需要它？现在这四条是它干活的最小集合 ——
 * 报到 / 心跳 / 领活 / 回执。别的一律 403，尤其是 /api/devices、对话、员工、删机器：
 * 那些是**操作员**的事，节点碰不到，一台被翻也就只丢它自己。
 */
function nodeMayReach(nodeId, method, pathname) {
  if (method !== 'POST') return false;
  /*
   * 报到是**共享**端点 —— id 在 **body** 里、不在路径里（`POST /api/nodes/register`）。
   * 所以路径这一层挡不住"拿自己的令牌、报到成别人的 id" ✗ ——
   * 那一条在 register 处理器里按 `req.bandiAuth` 判（见 server.mjs）。
   *
   * ⚠️ 这条是**真机迁移时才发现漏的**（2026-10-16）：白名单里我写的路径是
   * `/api/nodes/<id>/register` —— 那个端点**根本不存在** ✗，于是节点连报到都过不去。
   * 用例当时只测了心跳和领活，没测报到，所以没拦住 —— 现在补上了。
   */
  if (pathname === '/api/nodes/register') return true;
  const id = String(nodeId);
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const own = ['/heartbeat', '/claim'].flatMap((tail) => [
    `/api/nodes/${id}${tail}`,
    `/api/nodes/${encodeURIComponent(id)}${tail}`,
  ]);
  return own.includes(pathname) || new RegExp(`^/api/nodes/(?:${esc}|${encodeURIComponent(id)})/tasks/[^/]+/report$`).test(pathname);
}

/**
 * **修正 2（设计 §2）：节点干活还会打这两条，今天在局域网总机上必然 403。**
 *
 * `POST /api/runs/:runId/events`（`node.mjs:199`，过程回传）与
 * `POST /api/runs/:runId/finish`（`node.mjs:332`，回执）**不在** `nodeMayReach` 的白名单里 ✗。
 * 今天没暴露，只是因为回环形态下 `auth.required === false`、整套节点越权检查根本不执行；
 * 而唯一的节点用例恰好是回环形态。**一旦总机开了局域网（鉴权开），远端节点的"过程回传"
 * 和"回执"全部 403** —— 而本需求的主场景正是"局域网总机 + 远端节点"。
 *
 * 判据是**这次运行是谁的活**：`store.getNodeJobByRun(runId).nodeId === who.nodeId`。
 * 协议一个字节不改，只补判定。
 */
function runMayReach(nodeId, method, pathname) {
  if (method !== 'POST') return false;
  const m = /^\/api\/runs\/([^/]+)\/(?:events|finish)$/.exec(pathname);
  if (!m) return false;
  let runId = m[1];
  try {
    runId = decodeURIComponent(runId);
  } catch { /* 编码坏了就按原样查，查不到自然拒绝 */ }
  const job = store.getNodeJobByRun(runId);
  return !!job && job.nodeId === nodeId;
}

/**
 * **`panel` 禁止清单**（设计 §6.3 那张表，逐条翻译成精确正则）。
 *
 * 口径：`panel` = 「看 + 用」；下列五类**管理动作**只有握着总机 `token` 文件的那台
 * （`operator`）能做。理由：一台被翻的瘦客户端不该能再拉别的机器进来、
 * 也不该能把别人家的连接器密钥翻出来。
 *
 * ⚠️ 一条不许漏（漏了等于给管理权），一条不许扩（扩了会把"用"也挡掉）。
 * 下面这张"明确允许"的单子跟禁止清单是**一对**，改任何一边都要回头看一眼另一边：
 *   员工增删改（下表中 model/runtime **字段级**那条除外，它落在 server.mjs 的 handler 里）、
 *   会话/消息、群、任务/项目、工作流、定时任务、技能、额度**读**、连接器**读**、
 *   设备**读**、`GET /api/lan`、`GET /api/state`、`/api/runs/<id>/stream`（SSE）。
 */
const PANEL_FORBIDDEN = [
  // 1 发邀请码                                        server.mjs:1188
  { method: /^POST$/, path: /^\/api\/nodes\/invites$/ },
  // 2 删 / 改设备
  { method: /^DELETE$/, path: /^\/api\/nodes\/[^/]+$/ }, // 忘掉 = 吊销   server.mjs:1017
  { method: /^POST$/, path: /^\/api\/devices\/[^/]+\/rename$/ }, //             server.mjs:1496
  { method: /^POST$/, path: /^\/api\/devices\/[^/]+\/runtimes$/ }, //            server.mjs:1525
  { method: /^(PUT|PATCH)$/, path: /^\/api\/devices\/[^/]+\/runtimes\/[^/]+$/ }, // server.mjs:1534
  { method: /^DELETE$/, path: /^\/api\/devices\/[^/]+\/runtimes\/[^/]+$/ }, //    server.mjs:1546
  //   让**别的机器**装东西（在别人机器上落代码，与"改设备"同级）   server.mjs:1117
  { method: /^POST$/, path: /^\/api\/nodes\/[^/]+\/tasks$/ },
  // 3 改连接器与凭据
  { method: /^POST$/, path: /^\/api\/connectors$/ }, //                          server.mjs:939
  { method: /^(PUT|PATCH)$/, path: /^\/api\/connectors\/[^/]+$/ }, //            server.mjs:973
  { method: /^DELETE$/, path: /^\/api\/connectors\/[^/]+$/ }, //                 server.mjs:980
  { method: /^POST$/, path: /^\/api\/ssh\/servers$/ }, //（含私钥路径）           server.mjs:258
  { method: /^POST$/, path: /^\/api\/git\/token$/ }, //                          server.mjs:2208
  { method: /^DELETE$/, path: /^\/api\/git\/token$/ }, //                        server.mjs:2223
  // 4 改模型路由（每模型限额就是路由约束）                                     server.mjs:392
  { method: /^POST$/, path: /^\/api\/quota$/ },
  //   第 15 条 `PUT|PATCH /api/personas/:id` **且 body 带 model 或 runtime**
  //   是**字段级**的（readBody 只有 handler 里有）→ 落在 server.mjs 的 handler（用 mayManage）
  // 5 局域网开关（角色 / 手机连接；监听地址不是可切的了，2026-11-03）
  { method: /^POST$/, path: /^\/api\/lan$/ }, //（GET 允许 —— 只读）              server.mjs:1452
  // — 权限本身：scope 只能总机侧改（决策 A 规则 2）                             本次新增
  { method: /^POST$/, path: /^\/api\/nodes\/[^/]+\/scope$/ },
  /*
   * — **架构补充**：插件装卸 = 在总机上落代码，风险与"改连接器"同级
   *   （设计 §6.3 最后一行，别漏）                          server.mjs:1565 / 1578
   */
  { method: /^POST$/, path: /^\/api\/plugins\/[^/]+\/(?:install|enable|disable)$/ },
  { method: /^DELETE$/, path: /^\/api\/plugins\/[^/]+$/ },
  /*
   * — panel 只许「看 + 用」，这两条 GET 越界（设计口径：panel 的 SSE 只许
   *   `/api/runs/<id>/stream`，不许订阅全局事件流；全盘目录列举更是越权读）
   */
  { method: /^GET$/, path: /^\/api\/events$/ }, // 全局 SSE：所有会话的运行事件
  { method: /^GET$/, path: /^\/api\/fs\/dirs$/ }, // 任意目录列举：等于摸操作员整块磁盘
  /*
   * — 技能 discover/import：body 里 root/dirs/srcDir 是**任意本机路径**，导入的
   *   SKILL.md 会整篇注入数字员工的首轮 prompt —— 与"插件装卸 = 落代码"同风险级
   *   （供应链投毒面，panel 收）                                 server.mjs:273 / 280
   */
  { method: /^POST$/, path: /^\/api\/skills\/(?:discover|import)$/ },
];

/** 这个动作算不算"管理动作"（`panel` 令牌碰不得） */
export function isPanelForbidden(method, pathname) {
  const m = String(method ?? '').toUpperCase();
  const p = String(pathname ?? '');
  return PANEL_FORBIDDEN.some((r) => r.method.test(m) && r.path.test(p));
}

/**
 * **设备令牌的权限边界**（2026-11 手机端增量，设计 §3.3 + **§3.3.1 增量修订优先**）：
 * /api 走**白名单制**（不在名单 = `E4033`），**同源静态无条件放行**。
 *
 * 口径（用户已确认）：手机端写操作只有"审卡票 + 给员工发消息"两类，其余只读 ——
 *   · 看：状态 / 技能 / 流程 / 项目与看板 / 卡详情与评论 / 会话 / 员工与群信息 / 我是谁 / 版本指纹；
 *   · 写：发消息（POST 会话消息）、留便签（POST 卡评论，仅 mode:'note' —— body 只有
 *     handler 看得见，字段级闸落在 routes/project.mjs）、审批（PATCH 卡，仅 {status, note}，
 *     字段级闸同样落在 routes/project.mjs）。
 *
 * 往里加路径之前先回答一句：手机**凭什么**需要它？白名单外的都是操作员的事 ——
 * 删任务、改员工、动连接器、踢设备，一台被翻的手机不该碰得到。
 *
 * ⚠️ **这个函数已经没有调用方了**（2026-11-03 核实）：Phase 2 PDP 收编后，设备能到哪儿
 * 由 `security/route-policy.mjs` 清单里的 `device: true` 标记说了算（policy.mjs 判定），
 * 这里的口径被逐条搬了过去。留着只为对照 v2.5 的历史口径 ——
 * **要改手机能干什么，去 route-policy 加 `device: true`，改这里一行用都没有**
 * （2026-11-03 手机建卡 403 排查时在这里白改了一轮，才发见判定根本不经过它）。
 */
function deviceMayReach(method, pathname) {
  /*
   * 规则一（设计 §3.3.1.1）：白名单**只管 /api** —— 同源静态（HTML/JS/CSS/manifest/图标/SW，
   * 也就是 server.mjs 里 serveStatic 覆盖的那些非 /api 路径）与 panel 同权、无条件放行。
   * 理由：静态资源是公开代码，白名单管的是**数据**不是代码；把代码也管起来只会造成
   * "扫上码但页面加载不出来"（QA 第 1 轮 P0 白屏）。GET/HEAD 之外的非 /api 请求仍被闸住
   * （serveStatic 本身也只吃 GET，双保险）。
   */
  if (!pathname.startsWith('/api/')) return method === 'GET' || method === 'HEAD';

  if (method === 'GET') {
    /*
     * 规则二（设计 §3.3.1.2）：受限视图**浏览**口径的完整 GET 表。
     * 加一条之前先回答：手机**凭什么**需要它？表外的都是操作员的事（§3.3.1.2 的 403 清单）。
     */
    if (
      [
        '/api/state', // 工作台/会话/通讯录总览（启动必需）
        '/api/skills', // 启动 load() 的 Promise.all 另一半 —— 缺了整页挂
        '/api/workflows', // 工作台流程磁贴
        '/api/projects', // 项目列表
        '/api/tasks', // 全局任务 / 看板
        '/api/pair/me', // 我是谁（设备名）
        /*
         * `/api/me`（2026-10-28 第三刀）：前端 `state.mjs` 用它一次问清"我是哪种身份 +
         * 我该看哪些菜单"。手机也要问 —— 它回 `{kind:'device'}`（只读、零敏感），
         * 设备端由此可以走同一条前端路径，不必为身份再分一套 if。
         */
        '/api/me',
        '/api/web-version', // 60 秒版本指纹轮询（只回 mtime，零敏感）
        '/api/prefs', // 「我的」页回复风格**读**（PUT 仍 403：那是改全体员工的沟通偏好）
        /*
         * 全局 SSE（2026-10-28 修）：`app.mjs` 的 `startEvents()` 是**每个页面**都会开的
         * 一条订阅，它推的只是「哪个会话动了」的 `{type:'conv', id}`；设备已经能读全部
         * 会话正文（`/api/conversations/:id`），这条通知不超出同一个读范围。
         * 不放行的话手机端每页都挂一条 403 订阅，后台刷新也是死的。
         */
        '/api/events',
      ].includes(pathname)
    ) {
      return true;
    }
    /*
     * ⚠️ 这几条必须**按路径段精确匹配**，不能用前缀匹配：
     * `/api/personas/:id` 前缀式会把 `/api/personas/:id/runtime-skills`（技能**编辑**视图）
     * 一起放行 —— 那是 §3.3.1.2 明确要保持 403 的脸。
     */
    return (
      /^\/api\/projects\/tasks\/[^/]+(\/comments)?$/.test(pathname) // 卡详情 / 卡评论
      || /^\/api\/projects\/[^/]+\/tasks$/.test(pathname) // 项目看板
      || /^\/api\/conversations\/[^/]+$/.test(pathname) // 会话详情 / 消息
      || /^\/api\/personas\/[^/]+$/.test(pathname) // 员工详情（浏览口径）
      || /^\/api\/personas\/[^/]+\/tasks$/.test(pathname) // 员工详情里的任务页签
      || /^\/api\/groups\/[^/]+$/.test(pathname) // 群信息（成员列表）
      /*
       * 单运行的实时事件流（2026-10-28 修）：前端 `streamRun()` 靠它把「边跑边看」
       * 画出来。设备既然能读这条会话（上一条 `/api/conversations/:id`）并能派活
       * （POST messages），这条流的**内容就是那条会话的正文**，不额外扩读范围。
       * 不放行的话：发完消息界面一直停在「正在输入」，回复要刷新才看得到。
       */
      || /^\/api\/runs\/[^/]+\/stream$/.test(pathname)
    );
  }
  if (method === 'POST') {
    return /^\/api\/conversations\/[^/]+\/messages$/.test(pathname)
      || /^\/api\/projects\/tasks\/[^/]+\/comments$/.test(pathname)
      /*
       * 停止生成（2026-10-28 修）：与「发消息」是一对 —— 能派不能停，手机上那轮
       * 会话就永远挂着「正在输入」（`chat.mjs` 的停止按钮走的就是这条）。
       */
      || /^\/api\/runs\/[^/]+\/abort$/.test(pathname);
  }
  if (method === 'PATCH') return /^\/api\/projects\/tasks\/[^/]+$/.test(pathname);
  return false;
}

/**
 * **判定只有一处**（设计 §6.1 / IAM §8.4）。`guard()` 里只调这一个函数，别的什么都不判。
 *
 * **Phase 2 起 `decide()` 是 PDP 的兼容包装**：判定逻辑本体在
 * `security/policy.mjs` 的 `authorize()`（路由清单默认拒绝 + 权限词表 +
 * 成员基线 ∪ role_permissions），这里只负责把本模块的归属判定
 * （节点只认自己的端点 —— 那两条要查库对 nodeId）作为 `rules` 注进去，
 * 顺便避免 security/ ↔ auth.mjs 的 import 环。
 *
 * 三种令牌携带方式（Cookie / `X-Bandi-Token` / `?token=`）走的**都是这里** ——
 * `tokenOf()` 先统一取出令牌，`identify()` 再统一认出"是谁"。
 * 所以"面板令牌换个 Cookie 就变成操作员"这种事不会发生。
 *
 * 返回 `'allow' | 'E4012' | 'E4031' | 'E4032' | 'E4033' | 'E4098'`。
 *
 * **不缓存**（决策 A 规则 2）：每次请求现算，总机那边改完对下一次请求立即生效。
 */
export function decide(who, method, pathname) {
  return policy.authorize({
    who,
    method,
    pathname,
    rules: { nodeMayReach, runMayReach, touchNodeUsed: store.touchNodeUsed },
    roleHasPerm: store.roleHasPerm,
  });
}

/**
 * 这次请求的**操作人是谁**（2026-10-31 用户概念落地：消息署名 / 建卡人 / 看"我"是谁）。
 *
 * 四种答案：
 *   · 登录用户 → 他自己（多端各记各的，这是唯一精确的一档）；
 *   · operator（回环 / 共享令牌）→ **第一个用户**（"本机自动登录"：像一台共用电脑，
 *     没人显式登录时活都算机主的）。还没有任何用户 → null，调用方回落到 LOCAL_USER 占位；
 *   · 手机设备令牌 → **它归属的那个人**（2026-11-03 设备绑人）。在此之前这里返回 null，
 *     于是手机上批的卡、说的话在事件流里只有一个设备 id —— 和"人"是两套语义。
 *     没绑人（零账号形态的老设备）才回 null；
 *   · 节点令牌 → null（机器不是人，不冒充任何人）。
 *
 * 只用于**落数据**（署名），绝不用于鉴权 —— 权限判定仍然只看 `decide()`，两码事别混。
 * 手机也不因为带上了 userId 就拿到那个人的权限：它走的是 device 白名单。
 */
export function actorUser(req) {
  const a = req?.bandiAuth;
  if (!a) return null;
  if (a.kind === 'user' && a.userId) return store.getUser(a.userId);
  if (a.kind === 'operator') return store.firstUser();
  if (a.kind === 'device' && a.userId) return store.getUser(a.userId);
  return null;
}

/**
 * 这次请求是不是**这台机器的操作员**在做（handler 判字段级权限用）。
 *
 * 存在的理由：`PUT /api/personas/:id` 里"body 带 model / runtime"这件事
 * `auth.mjs` 看不见（要 `readBody`），所以那一条必须落在 handler 里，一行判断即可。
 *
 * ⚠️ 回环形态（单机 / 桌面版）下 `guard` 会把身份标成 operator（见下面那段），
 * 否则单机上点「改模型」会被自己的闸挡掉。
 *
 * 2026-10-28 第三刀扩了一条：**登录用户且角色是 admin** 也算。其余角色（哪怕是
 * 内置的「操作员」角色）一律不算 —— 管理动作只认 `admin`，这是任务书 §三 的口径。
 *
 * ⚠️ 2026-10-31 Phase 3 收编后，路由层的身份闸已全部归 PDP（route-policy +
 * policy.authorize），handler **不再**用本函数判身份；仅剩 persona.mjs 一处
 * —— 那里判的是"body 里的模型/运行时字段有没有被改"，是内容判断不是身份判断。
 * 保留导出是给那条业务规则和存量测试用。
 */
export function mayManage(req) {
  const a = req?.bandiAuth;
  if (!a) return false;
  if (a.kind === 'operator') return true;
  return a.kind === 'user' && a.admin === true;
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
   * 免令牌的两条：
   *   · 加入：这台机器**还没有令牌**，凭一次性的邀请码进来（邀请码就是它的凭据，见 /api/nodes/join）。
   *   · `GET /api/hello`（2026-10-20）：加入向导"探这个地址"打的就是它。
   *     它**故意不带任何秘密** —— 披露的字段与 UDP 应答完全同源（设计 §5.4）。
   * 这两条必须在令牌检查之前放行，否则新机器永远进不来 / 永远探不到。
   */
  if (req.method === 'POST' && url.pathname === '/api/nodes/join') return true;
  if (req.method === 'GET' && url.pathname === '/api/hello') return true;

  /*
   * **协作中心的分公司通道**（2026-10-31 MVP，任务书 §6.2）：这四条**免操作员令牌**。
   *
   * 凭据不是 `bandi_token`：`join` 凭一次性接入码，其余三条凭 `X-Bandi-Token: bc_…`
   * （**分公司令牌，不是操作员令牌**）。校验全在 `routes/collab.mjs` 的 handler 里 ——
   * `identify()` 不认识 `bc_`，别去改它（任务书 §十五 第 3 条）。
   *
   * 为什么必须放行：中心一开局域网（`BANDI_HOST=0.0.0.0` → 鉴权开），分公司就来不了，
   * 而它手上永远不会有中心的操作员令牌 —— 不放行等于协作不可用。
   * ⚠️ 只放这四条，**别的 `/api/collab/*` 照常走 `mayManage`**；
   *    CSRF 闸照常生效（分公司请求不带 Origin，天然放行）。
   */
  if (req.method === 'POST' && url.pathname === '/api/collab/join') return true;
  if (req.method === 'POST' && url.pathname === '/api/collab/poll') return true;
  if (req.method === 'POST' && url.pathname === '/api/collab/leave') return true;
  if (req.method === 'POST' && /^\/api\/collab\/tasks\/[^/]+\/report$/.test(url.pathname)) return true;

  /*
   * 手机配对（2026-11 手机端增量，设计 §2）：落地页与换码接口必须免令牌 ——
   * 手机此刻还**没有任何凭据**，配对码本身就是它的凭据（对齐上面 /api/nodes/join 的既有写法）。
   * · `GET /pair`（及 `/pair.html`）＝ 扫码落地页：服务端不校验 token，校验在 claim；
   * · `POST /api/pair/claim` ＝ 凭一次性码换长期设备令牌（guardWrite 的 CSRF 闸照常生效，
   *   落地页的 fetch 自己带 X-Bandi: 1）。
   */
  if (req.method === 'GET' && (url.pathname === '/pair' || url.pathname === '/pair.html')) return true;
  if (req.method === 'POST' && url.pathname === '/api/pair/claim') return true;
  /*
   * `POST /api/pair/resume`（2026-11-01 二刀）也免令牌：手机被「断开连接」后手里没有
   * 能用的凭据了（令牌已吊销），它能出示的只有 localStorage 里的 clientKey ——
   * 这正是它要干的事（换一张新令牌回来）。校验在 handler，与 claim 同一模式。
   */
  if (req.method === 'POST' && url.pathname === '/api/pair/resume') return true;
  /*
   * 登录 / 退出（2026-10-28 第三刀）：此刻请求还没带任何凭据（这就是它要干的事），
   * 所以必须免令牌。**CSRF 闸照过**（server.mjs 里的 guardWrite 在 guard 之后）——
   * 登录页自己的 fetch 带 `X-Bandi: 1`，别在这条链路上绕开它。
   * 退出为什么也豁免：它的凭据就是 `bandi_sid` 本身（handler 自己删那张票 + 清 Cookie），
   * 拿令牌来退一个不存在的登录没有任何意义。
   */
  if (req.method === 'POST' && (url.pathname === '/api/login' || url.pathname === '/api/logout')) return true;
  /*
   * 两段式登录的第二段（2026-10-31 二改）：此刻手上只有一张 `otpToken`（一次性、5 分钟），
   * 浏览器还没有任何会话 —— 与第一段同一个道理，必须免令牌。凭据校验在 handler 里。
   */
  if (req.method === 'POST' && url.pathname === '/api/login/otp') return true;
  /*
   * 换票链（IAM §6.2，Phase 3）：`/api/auth/token` / `refresh` / `revoke`。
   * 这三个口的**输入本身就是凭据**（密码+otp / rf_ 刷新票 / at_ 短票 / 根令牌头），
   * 校验全在 handler（routes/auth-token.mjs）—— 与 /api/login 同一个模式。
   * Bearer 短票在 guard 里的识别照常生效：带 at_ 票来 revoke 也认得出人。
   */
  if (req.method === 'POST' && url.pathname.startsWith('/api/auth/')) return true;
  /*
   * **首次引导直建**（2026-10-31）：一个账号都没有时，登录页的「创建账号」表单打的就是
   * `POST /api/users` —— 此刻浏览器没有任何凭据（这正是它要干的事）。豁免只对
   * **零账号**成立，第一个账号落地后这条路立刻关死；路由层自己也按 hasUsers 判一遍
   * （两层缺一不可，与 /api/pair/claim 的"码即凭据"同一模式）。CSRF 闸照过。
   */
  if (req.method === 'POST' && url.pathname === '/api/users' && !store.hasUsers()) return true;
  /*
   * 落地页的**静态依赖**也要免令牌（2026-10-28 修）：手机此刻没有任何凭据，
   * `/js/pair-claim.mjs` 和图标走的是非 /api GET —— 不豁免时 guard 会回**登录页 HTML**
   * （`Content-Type: text/html`），浏览器按 module 执行必然失败，页面就永远停在
   * 「正在配对…」那一屏（实测复现）。这些是公开代码，不含任何数据或凭据。
   */
  if (req.method === 'GET' && (url.pathname === '/js/pair-claim.mjs' || url.pathname.startsWith('/icons/'))) return true;

  /*
   * 数字员工的本机 AI 通道（2026-10-23，skills/bandi-avatar）：**真·回环**发起的 /api/ai/* 免令牌。
   * 员工跑在 CLI 里，拿不到平台令牌，让技能教它 curl 时无凭据可用 —— 通道自身有
   * 来源校验 + CSRF 闸双保险（routes/imageai.mjs）。
   *
   * 2026-10-31 修（IAM §5.3 第 2 条）：原来这里自己判 `req.socket.remoteAddress`，
   * 反代后面外部请求也是 127.0.0.1 → 直接免令牌。现在统一用 `classifySource`：
   * 只有 `loopback` 才豁免，`network` 一律走认证。
   */
  if (url.pathname.startsWith('/api/ai/') && source === 'loopback') return true;

  if (!auth.required && source === 'loopback') {
    /*
     * 回环形态（桌面版 / 单机 / 分机本机）—— 2026-10-31 用户拍板升级：
     * 「不管总机还是分机，都要用用户来登录」。落成两条，**API 与面板分开**：
     *
     * · **API 仍是回环信任**：本机脚本 / 冒烟 / CLI 不带凭据照旧 = operator（一个字节没变，
     *   任务书 §三 那条硬约束继续成立）；但**带着有效登录会话的浏览器按登录人算**
     *   （kind:'user'）—— 消息署名、菜单收敛都精确到人。退出登录之后回 operator。
     * · **面板要登录**：抓 HTML 一律给**登录页** —— 有账号是账号磁贴（免密账号点了就进，
     *   跟电脑开机先选账户一个意思），零账号是建号页（第一个账号 = 内置管理员）。
     *   2026-11-01 改：零账号**不再**放行进面板，见下面那段注释。
     */
    const sid = sessionTokenOf(req);
    if (sid) {
      const hit = store.userBySession(sid);
      if (hit) {
        req.bandiAuth = {
          kind: 'user',
          userId: hit.user.id,
          roleId: hit.user.roleId,
          admin: hit.user.roleId === 'admin',
          via: 'session-loopback',
        };
        return true;
      }
    }
    req.bandiAuth = { kind: 'operator', via: 'loopback' };
    /*
     * **面板只给"人"**（2026-11-01 口径统一，用户：「每个用户都要登录，操作员只是一个身份」）。
     *
     * operator 是**机器凭据**（回环免登录 / 令牌），不是一个可以在界面上当"我"的身份：
     * 它没有 users 行，所以「我的」页画不出密码和动态验证 —— 从前零账号时"直接放行进面板
     * 当操作员"，用户看到的就是一个空页 + 一段解释（2026-11-01 实报）。
     * 现在门前移：**零账号 → 建号页**（第一个账号 = 内置管理员，建完服务端顺手发会话票），
     * **有账号 → 账号磁贴**。两条路都进来才是 user，operator 不再出现在界面里。
     * API 一个字节没变：本机脚本 / 冒烟 / CLI 不带凭据照旧 = operator（任务书 §三 硬约束）。
     */
    if (wantsPanelHtml(req, url)) {
      const hasUsers = store.hasUsers();
      // 登录页顺手种 CSRF 双提交值（§10.2）：登录成功后所有带 Cookie 的写请求都要带上它
      const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
      if (!csrf.valuesOf(req).cookie) headers['Set-Cookie'] = csrf.cookieFor(csrf.mint());
      res.writeHead(200, headers);
      // 回环 = 这台机器自己的屏幕，摆账号磁贴不泄密（局域网那边的登录页仍是"用户名+密码"表单）；
      // 禁用的账号不摆 —— 摆上去也登不进，白给人一个"点不动"的磁贴
      res.end(loginPage({
        hasUsers,
        loopback: hasUsers,
        users: hasUsers ? store.listUsers().filter((u) => !u.disabled) : null,
        mobile: isMobileUA(req),
      }));
      return false;
    }
    return true;
  }

  const got = tokenOf(req, url);
  let who = identify(auth, got);

  /*
   * **Bearer 短票**（IAM §7.1，Phase 3）：`Authorization: Bearer at_...`。
   * 人类票 → 与 Cookie 会话同形状的 user Principal（PDP 一个入口判定）；
   * `scopes='*'` 的机器票 = 根令牌换来的 break-glass 票（§6.4）→ operator 待遇。
   * 票无效/过期就当没带 —— 落到下面的会话兜底，最后统一 401 E4010。
   */
  if (!who) {
    const bearer = String(req.headers.authorization ?? '').match(/^Bearer\s+(at_\S+)$/i)?.[1];
    if (bearer) {
      const row = tokens.verify(bearer);
      if (row) {
        if (row.subjectKind === 'user') {
          const u = store.getUser(row.subjectId);
          if (u && !u.disabled) {
            who = { kind: 'user', userId: u.id, roleId: u.roleId, admin: u.roleId === 'admin', restricted: false, via: 'bearer' };
          }
        } else if (String(row.scopes).split(',').map((s) => s.trim()).includes('*')) {
          who = { kind: 'operator', via: 'bearer-root' };
        }
      }
    }
  }

  /*
   * **登录会话兜底**（2026-10-28 第三刀）。
   *
   * 顺序是**令牌优先、会话兜底**，不是反过来。任务书 §五 写的是"先看 Cookie"，
   * 但 §三 第一条是硬约束："operator / node / device / revoked 的行为一个字节都不许变"。
   * 若先看 Cookie，一个浏览器里同时躺着 `bandi_token`（root）和 `bandi_sid`（某次登录）时，
   * 握 root 令牌的请求会被一个陈旧的会话票**降权**成普通用户 —— 那是行为变更，也是坑。
   * 两条路都保留、互不覆盖，语义才最不容易出意外。
   *
   * 回环分支在更上面已经 return 了，所以桌面端永远走不到这里（免登录，任务书 §二 第 2 条）。
   */
  if (!who) {
    const sid = sessionTokenOf(req);
    if (sid) {
      const hit = store.userBySession(sid);
      if (hit) {
        who = {
          kind: 'user',
          userId: hit.user.id,
          roleId: hit.user.roleId,
          admin: hit.user.roleId === 'admin',
          // 免密 + 服务器形态 = 受限会话（见 decide 里的那段，IAM §8.6）
          restricted: !hit.user.hasPassword && source === 'network',
          via: 'session',
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

    if (decision === 'E4012') {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(
        JSON.stringify({
          error: '这台机器的授权已被总机撤销（面板上「忘掉」了），退出总机后重新加入',
          code: 'E4012',
          platform: 'bandi',
          hint: '在总机上重新发一个邀请码；在这台机器上：设置 →「这台机器」→ 退出总机 → 再加入。',
        }),
      );
      return false;
    }

    if (decision === 'E4098') {
      /*
       * 免密账号在服务器形态下的受限会话（IAM §8.6）：能登录、能改密码，别的都不给。
       * 文案要指路，否则用户只会看到"什么都没权限"。
       */
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(
        JSON.stringify({
          error: '这个账号还没设密码，在服务器形态下只能先设密码（其余操作一律拒绝）',
          code: 'E4098',
          platform: 'bandi',
          hint: '在「我的」页设置密码，或在服务器终端跑 `bandi user create` / 让管理员重置密码。设完密码重新登录即可正常使用。',
        }),
      );
      return false;
    }

    if (decision === 'E4031') {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(
        JSON.stringify({
          error: '这台机器只有算力权限，看不了面板',
          code: 'E4031',
          platform: 'bandi',
          hint: '要看设备、对话、员工，请用操作员令牌（总机数据目录 token 文件里那枚），或让总机在设备详情里给这台机器开面板权限。',
        }),
      );
      return false;
    }

    if (decision === 'E4032') {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(
        JSON.stringify({
          error: '面板权限不能做管理动作（发邀请码 / 删改设备 / 改连接器与凭据 / 改模型路由 / 重启与局域网开关）',
          code: 'E4032',
          platform: 'bandi',
          hint: '这些要在总机那台机器上做（它握着 token 文件里的那枚操作员令牌）。',
        }),
      );
      return false;
    }

    if (decision === 'E4033') {      /*
       * 两条不同的路走到同一个码，文案必须分开 —— 手机用户看到"手机端只开放…"
       * 会莫名其妙，登录用户看到"手机端"更莫名其妙（2026-10-28 第三刀）。
       */
      const isUser = who.kind === 'user';
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(
        JSON.stringify({
          error: isUser
            ? '这个账号没有这个权限（只有管理员能看全部面板与做管理动作）'
            : '手机端只开放看状态、审卡票和给员工发消息，这个操作在手机上做不了',
          code: 'E4033',
          platform: 'bandi',
          hint: isUser
            ? '让管理员在「设置 → 用户」里把角色改成「管理员」，或在那台机器上用管理员账号登录（本机也要先选账号，2026-10-31 起）。'
            : '请在桌面端操作。',
        }),
      );
      return false;
    }

    // 手机设备放行了才记"最近活跃"（60 秒节流，见 store.touchDevice 的注释）
    if (who.kind === 'device') {
      store.touchDevice(who.deviceId, req.socket?.remoteAddress ?? null);
    }

    /*
     * 从地址栏进来的令牌：换成 Cookie 并**重定向掉**，免得它留在历史/Referer 里。
     * ⚠️ 只对**操作员**令牌做这件事：节点令牌要是也能换成 Cookie，就等于把 master 发给了浏览器 ✗
     * （那条是提权，正是这次改动要堵的东西）。
     *
     * `panel` 令牌**刻意不开这条路**（设计 §6.2）：瘦客户端走反代，浏览器根本拿不到令牌
     * （令牌在反代的头里）；而一旦给 panel 开 Cookie，总机令牌就落进了那台机器的浏览器
     * Cookie 里 —— 比 URL 更长寿、更容易被同机进程读走，正好和决策 A 想收的口子相反。
     */
    if (who.kind === 'operator' && url.searchParams.get('token')) {
      res.writeHead(302, {
        'Set-Cookie': cookieHeader(auth.token),
        Location: url.pathname + (stripToken(url.searchParams) || ''),
        'Cache-Control': 'no-store',
      });
      res.end();
      return false;
    }
    /*
     * **令牌不是人**（2026-11-01）：面板 HTML 只给登录账号。
     * 带令牌抓首页（`?token=` 换完 Cookie 再进来、或手工填了 bandi_token）以前会直接
     * 进面板当"操作员"，于是「我的」页永远没有密码/动态验证。现在统一给登录/建号页；
     * 令牌继续管 **API**（脚本、CLI、节点、运维照旧 `X-Bandi-Token`，一个字没变）。
     * 手机设备（device）不走这条：配对令牌就是它的登录。
     */
    if (who.kind === 'operator' && wantsPanelHtml(req, url)) {
      const hasUsers = store.hasUsers();
      const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
      /*
       * **顺手清掉这枚令牌 Cookie**（2026-11-01 实报：点了登录，输入框被刷空、还在登录页）。
       * 面板不再认令牌，而 `令牌优先于会话` 会让这枚陈年 Cookie 把刚登录的人一直压回
       * operator → 又挡回登录页 → 登录永远"没反应"。浏览器以会话为准，令牌只走请求头。
       * 只清"确实是根令牌"的那枚：手机配对用的是同一个 Cookie 名（bd_），别误伤。
       */
      const staleTok = String(parseCookies(req.headers.cookie)[COOKIE] || '');
      const dropToken = !!staleTok && !!auth.token && timingSafeEqual(staleTok, auth.token);
      const setCookies = [];
      if (!csrf.valuesOf(req).cookie) setCookies.push(csrf.cookieFor(csrf.mint()));
      if (dropToken) setCookies.push(clearedTokenCookie());
      if (setCookies.length) headers['Set-Cookie'] = setCookies;
      res.writeHead(200, headers);
      res.end(loginPage({
        hasUsers,
        loopback: source === 'loopback' && hasUsers,
        users: hasUsers ? store.listUsers().filter((u) => !u.disabled) : null,
        mobile: isMobileUA(req),
      }));
      return false;
    }
    req.bandiAuth = who; // 下游（比如"忘掉"、员工编辑的字段闸）据此知道这枚令牌是谁
    return true;
  }

  /*
   * ⚠️ **必须是 `wantsPanelHtml`，不能是一刀切的"GET 且非 /api/"**（2026-11-02 三十三改）。
   *
   * 老写法让 `/js/collab.mjs`、`/sw.js` 这类静态文件在**没带任何凭据**时也吃到登录页 HTML
   * （`200 + text/html`）：浏览器那边是 MIME/语法错误，命令行那边更阴 —— `curl … | grep`
   * 拿到一张登录页去数关键词，得到的是"没找到"，看上去和"文件没部署上"一模一样
   * （2026-11-02 实踩：验线上 collab.mjs 就是这么被误导的）。
   * 上面两处（回环分支 / 令牌分支）早就换成同一个判据，唯独这里漏了；
   * 静态资源现在走下面的 401 JSON（`E4010`），页面照旧给登录页。
   */
  const wantsHtml = wantsPanelHtml(req, url);
  if (wantsHtml) {
    // 同上：服务器形态的登录页也种 CSRF 值（登录成功后的写请求要带）
    const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
    const setCookies = [];
    if (!csrf.valuesOf(req).cookie) setCookies.push(csrf.cookieFor(csrf.mint()));
    /*
     * 顺手扫掉**没法用的**访问令牌 Cookie（2026-11-01）：认不出来的根令牌 / 被吊销的
     * 节点令牌留在浏览器里，只会在每次请求上添一次 401，还挡在"令牌优先"那条路上。
     * 手机配对（bd_）不清 —— 那是它唯一的凭据。
     */
    const staleTok = String(parseCookies(req.headers.cookie)[COOKIE] || '');
    if (staleTok && !staleTok.startsWith('bd_')) setCookies.push(clearedTokenCookie());
    if (setCookies.length) headers['Set-Cookie'] = setCookies;
    res.writeHead(200, headers);
    res.end(loginPage({ hasUsers: store.hasUsers(), loopback: source === 'loopback', mobile: isMobileUA(req) }));
    return false;
  }

  res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(
    JSON.stringify({
      error:
        source === 'network'
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
 * `/pair` 是扫码落地页，自己带令牌校验，别挡。
 */
function wantsPanelHtml(req, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const p = url.pathname;
  if (p.startsWith('/api/')) return false;
  if (p === '/pair' || p === '/pair.html') return false;
  if (p === '/' || p.endsWith('.html')) return true;
  return String(req.headers.accept ?? '').includes('text/html');
}

function stripToken(params) {
  const rest = new URLSearchParams(params);
  rest.delete('token');
  const s = rest.toString();
  return s ? `?${s}` : '';
}

function cookieHeader(token) {
  // HttpOnly：JS 读不到，XSS 也偷不走；SameSite=Lax：跨站 POST 不带它（配合来源闸双保险）
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
}

/**
 * 登录页 / ?token= 换 Cookie 用：把令牌包成 `bandi_token=…; HttpOnly; …` 那一行。
 */
export function cookieValue(token) {
  return cookieHeader(token);
}

/** 定长比较，别让"比到第几个字符不同"泄漏出去 */
function timingSafeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

/** 登录页内联 HTML 的转义（账号名是用户输入的，别让它把磁贴页写成 XSS） */
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const esc = escapeHtml;

/**
 * 登录页（2026-10-28 第三刀建；2026-10-31 四态定型；2026-11-06 起**双端分设计**）。
 *
 * ┌ 架构（2026-11-06，用户：「同一个页面在两个地方显示，那就必定不好看」）─────────
 * │ loginPage() 只是分发器：按请求里的手机信号（isMobileUA）出**两份完全独立的页面**：
 * │   · loginDesktopPage() —— PC：左右分栏（左品牌大区 + 右表单面），只为宽屏设计；
 * │   · loginMobilePage() —— 手机：对齐壳启动页（apps/mobile/dist/launcher.css）的 iOS 语汇。
 * │ 两页共用下面的四态表单标记（loginFormHtml）、OTP 第二段（OTP_PANE_HTML）和内联脚本
 * │ （LOGIN_SCRIPT）—— 逻辑只写一份；各自的 <style>/<body> 各画各的。元素 ID 两端一致
 * │ （smoke 契约和脚本都靠它们，别改）。
 * └────────────────────────────────────────────────────────────────────────
 *
 * 四态，别混（2026-10-31 删掉令牌表单后从五态变四态）：
 *   · `hasUsers === false` —— **创建账号**（账号密码直建，第一个自动成为管理员）。
 *     公网服务器上"先令牌后建号"走不通（人不在那台机器旁边）；代价是"谁先到谁占管理员"。
 *     ⚠️ 页面上**没有令牌入口**了（2026-10-31 用户定：登录页就是登录页）——部署/运维用
 *     `X-Bandi-Token` 头或 `?token=`，那条路是给脚本的，不经界面（见 guard 的 operator 分支）。
 *   · `loopback && hasUsers` —— **账号磁贴**（回环 = 这台机器自己的屏幕，摆名单不泄密）：
 *     免密账号点一下就进；设了密码的点了出密码框。电脑开机选账户同款。
 *   · 有用户（非回环）—— 用户名 + 密码主表单（免密账号密码留空直接登录）。
 *     ⚠️ 非回环**不摆磁贴**：那等于把账号名单送给局域网里每一个人。
 *   · 开了动态验证的账号（2026-10-31 二改，仿 yaojian-ruoyi）：密码过了服务端回
 *     `{needOtp:true, otpToken}`，页面**整屏切到第二段**（一个输入框，动态码或恢复码都行，
 *     带「返回上一步」）；凭据 5 分钟、5 次。
 *
 * 为什么表单靠 inline script 提交而不是原生 `<form method=POST>`：`guardWrite` 要求
 * 写请求带 `X-Bandi: 1` 头，原生表单提交设不了头，必然被 CSRF 闸挡成 403（自己试过）。
 * 所以走 fetch，并把「码 + 中文」原样显示出来 —— 与全站错误口径一致。
 */

/**
 * B 字母标（与 apps/web/index.html 同源的双椭圆镂空 B）。
 * key 用来区分同一页上的多处实例 —— mask 的 id 在文档里必须唯一。
 */
function brandSvg(key) {
  const id = `b-hole-${key}`;
  return `<svg viewBox="0 0 512 512" aria-hidden="true">
  <defs>
    <mask id="${id}">
      <rect width="512" height="512" fill="#fff"/>
      <ellipse cx="268" cy="206" rx="36" ry="29" fill="#000"/>
      <ellipse cx="274" cy="340" rx="40" ry="31" fill="#000"/>
    </mask>
  </defs>
  <g mask="url(#${id})" fill="#fff">
    <rect x="154" y="138" width="72" height="236" rx="34"/>
    <path d="M194,156 C272,142 338,168 338,208 C338,248 288,268 194,264 Z"/>
    <path d="M194,282 C284,276 348,306 348,340 C348,372 288,388 194,382 Z"/>
    <rect x="172" y="336" width="70" height="52" rx="26"/>
  </g>
</svg>`;
}

/** 四态表单标记（建号 / 账号磁贴 / 用户名密码；#err 一并在这里）—— 只这一份，两端页面共用 */
function loginFormHtml({ hasUsers, loopback = false, users = null }) {
  const pwForm = hasUsers
    ? (loopback && Array.isArray(users) && users.length
      ? `
<p class="bad" id="err" hidden></p>
<div id="tiles">
  ${users
    .map(
      (u) => `<button type="button" class="tile" data-name="${esc(u.name)}" data-haspw="${u.hasPassword ? 1 : 0}">
    <span class="tile-ava">${esc((u.name || '?').slice(0, 1))}</span>
    <span class="tile-name">${esc(u.name)}</span>
  </button>`,
    )
    .join('')}
</div>
<div id="pwRow" hidden>
  <p class="tile-who" id="pwWho"></p>
  <form id="pwForm" autocomplete="on">
    <label class="field">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="10.2" width="15" height="10.3" rx="2.6"/><path d="M8.3 10.2V7.6a3.7 3.7 0 0 1 7.4 0v2.6"/></svg>
      <input id="pw" name="password" type="password" placeholder="密码" autofocus autocomplete="current-password" />
    </label>
    <button type="submit">进入</button>
  </form>
</div>`
      : `
<p class="bad" id="err" hidden></p>
<form id="pwForm" autocomplete="on">
  <label class="field">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8" r="3.6"/><path d="M5 19.4c.8-3.4 3.6-5.2 7-5.2s6.2 1.8 7 5.2"/></svg>
    <input id="nm" name="username" placeholder="用户名" autofocus autocomplete="username" spellcheck="false" />
  </label>
  <label class="field">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="10.2" width="15" height="10.3" rx="2.6"/><path d="M8.3 10.2V7.6a3.7 3.7 0 0 1 7.4 0v2.6"/></svg>
    <input id="pw" name="password" type="password" placeholder="密码（未设密码就留空）" autocomplete="current-password" />
  </label>
  <button type="submit">登录</button>
</form>`)
    : `
<p class="bad" id="err" hidden></p>
<form id="signForm" autocomplete="on">
  <label class="field">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8" r="3.6"/><path d="M5 19.4c.8-3.4 3.6-5.2 7-5.2s6.2 1.8 7 5.2"/></svg>
    <input id="nm" placeholder="用户名" autofocus autocomplete="username" spellcheck="false" />
  </label>
  <label class="field">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="10.2" width="15" height="10.3" rx="2.6"/><path d="M8.3 10.2V7.6a3.7 3.7 0 0 1 7.4 0v2.6"/></svg>
    <input id="pw" type="password" placeholder="密码（可留空 = 免密）" autocomplete="new-password" />
  </label>
  <label class="field">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="10.2" width="15" height="10.3" rx="2.6"/><path d="M8.3 10.2V7.6a3.7 3.7 0 0 1 7.4 0v2.6"/><path d="M9 15.4l2 2 3.6-3.8"/></svg>
    <input id="pw2" type="password" placeholder="再输一遍密码" autocomplete="new-password" />
  </label>
  <button type="submit">创建并进入</button>
</form>`;

  return pwForm;
}

/*
 * 两段式登录的第二段（2026-10-31 二改三改，仿 yaojian-ruoyi 的布局）：第一段密码过了、
 * 账号又开了动态验证，**替换整个表单区**（第一段整块 hidden，见脚本 showOtpStep）——
 * 两套输入框 + 两个按钮叠在一起，人会不知道自己在哪个步骤。版式：锁图标 + 标题 +
 * 一行说明 + 一个输入框 + 一个按钮 + 返回链接；一个输入框同时收 6 位动态码和 8 位恢复码
 * （手机丢了用恢复码），凭据 5 分钟 / 5 次。两端页面共用这份标记。
 */
const OTP_PANE_HTML = `
<div id="otpPane" hidden>
  <header class="brand">
    <div class="logo lock">
      <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
        <rect x="4.5" y="10.2" width="15" height="10.3" rx="2.6"/>
        <path d="M8.3 10.2V7.6a3.7 3.7 0 0 1 7.4 0v2.6"/>
        <circle cx="12" cy="15.3" r="1.15" fill="#fff" stroke="none"/>
      </svg>
    </div>
    <div>
      <h1>动态验证</h1>
      <p class="tag" id="otpWho">请输入 6 位动态码，或 8 位恢复码</p>
    </div>
  </header>
  <form id="otpForm" autocomplete="off">
    <p class="bad" id="otpErr" hidden></p>
    <label class="field">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.4 19 6.2v5.2c0 4.3-2.9 7.6-7 9.2-4.1-1.6-7-4.9-7-9.2V6.2Z"/><path d="M9.2 12.1l2 2 3.6-3.8"/></svg>
      <input id="otpCode" inputmode="numeric" maxlength="8" autocomplete="one-time-code"
             placeholder="动态验证码 / 恢复码" autofocus spellcheck="false" />
    </label>
    <button type="submit">验证</button>
  </form>
  <p class="hint"><a href="#" id="otpBack">返回重新登录</a></p>
</div>`;

/*
 * 内联脚本 —— 两端页面共用同一份（四态表单 / OTP / 手机补卡），一个字节不差。
 * ⚠️ 别引入反引号：它本身躺在模板字面量里。元素 ID 与两端页面的标记一一对应。
 */
const LOGIN_SCRIPT = `<script>
(() => {
  const err = document.getElementById('err');
  const say = (t) => { if (err) { err.textContent = t; err.hidden = false; } };
  // 第二段有自己的错误区（第一段的 #err 此刻在隐藏的 loginPane 里，写进去没人看得见）
  const otpErrEl = document.getElementById('otpErr');
  const sayOtp = (t) => { if (otpErrEl) { otpErrEl.textContent = t; otpErrEl.hidden = false; } };
  const msg = (j, dflt) => (j ? (j.code ? j.code + '：' + j.error : j.error) : dflt);
  /*
   * CSRF 双提交（§10.2）：浏览器里只要躺着一枚 bandi_sid / bandi_token（旧令牌、
   * 上一个账号的陈年会话），登录/建号这种写请求也要过 CSRF 闸 —— 只发 X-Bandi: 1
   * 会吃 403 E4099（2026-11-01 实报：令牌被门前挡到登录页之后，这条必现）。
   * bandi_csrf 是非 HttpOnly 的（JS 就是要读它），登录页响应顺手种过了。
   */
  const csrfVal = () => {
    const m = document.cookie.match(/(?:^|;\\s*)bandi_csrf=([^;]+)/);
    try { return m ? decodeURIComponent(m[1]) : ''; } catch { return m ? m[1] : ''; }
  };
  const csrfHeader = () => ({ 'X-Bandi': '1', 'X-Bandi-CSRF': csrfVal() });
  /*
   * 手机端身份统一（2026-11-05 用户：「手机端设备身份和账号密码应该统一起来」）。
   *
   * 这台手机如果配过对，localStorage 里就有一枚 clientKey（与 pair-claim.mjs 同一个键）。
   * 有它说明"这台手机是登记过的"，于是登录页做两件事，都是围着**设备身份**转：
   *   1. 先拿它去 /api/pair/resume 换一张新设备卡 —— 卡只是丢了（WebView 清缓存、
   *      升级、被系统回收），配对记录还在，压根不该让人输密码；
   *   2. 真要输密码（设备记录被「取消配对」删了 / 从没配过对），把 clientKey 一起提交 ——
   *      服务端认出来后按**设备身份**回（绑归属人 + 发设备卡；没有记录就当场建一台），
   *      不再发第二套会话身份。见 routes/users.mjs 的 claimPhoneIdentity。
   * 桌面浏览器没有这枚键、也不会生成，两条都不发生，登录页一位字节不变。
   */
  const IS_PHONE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  let ck = (() => { try { return localStorage.getItem('bandi.clientKey') || ''; } catch { return ''; } })();
  /*
   * 从没配过对的手机：这里**现造一枚**（与 pair-claim.mjs 同样的键、同样的形状）。
   * 服务端据此把这台手机落成一台设备 —— 于是"用密码登录"和"扫码配对"进去以后是
   * 同一种身份、同一套「我的」页（2026-11-05 用户选的口径 A）。
   * 只在手机 UA 下生成：桌面浏览器不带 clientKey，登录仍旧是账号会话。
   */
  const ensureCk = () => {
    if (ck || !IS_PHONE) return ck;
    ck = crypto.randomUUID
      ? crypto.randomUUID().replace(/-/g, '')
      : Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
    try { localStorage.setItem('bandi.clientKey', ck); } catch { /* 隐私模式：存不下，这次拿不到设备身份 */ }
    return ck;
  };
  /** 设备自报名（电脑端「设备」列表里那一行）：与 pair-claim.mjs 的 guessDeviceName 同款 */
  const devName = () => {
    const ua = navigator.userAgent;
    if (/iPhone/i.test(ua)) return 'iPhone';
    if (/iPad/i.test(ua)) return 'iPad';
    const m = /Android[^;)]*;\\s*([^;)]+?)\\s+Build/i.exec(ua) || /Android[^;)]*;\\s*([^;)]+)/i.exec(ua);
    return m ? 'Android · ' + m[1].split(/\\s+/)[0] : '';
  };
  const withCk = (o) => {
    const k = ensureCk();
    return k ? { ...o, clientKey: k, deviceName: devName() } : o;
  };
  /** 第二段的凭据（内存里，不落任何存储） */
  let otpToken = '';
  let otpWho = '';
  const showOtpStep = (who) => {
    otpWho = who;
    // 整块切换：第一段（品牌 + 登录表单）整体让位给第二段那一屏，别让它俩叠在卡片里
    const login = document.getElementById('loginPane');
    if (login) login.hidden = true;
    const step = document.getElementById('otpPane');
    if (!step) return;
    step.hidden = false;
    const tip = document.getElementById('otpWho');
    // 内联脚本里**不能用模板字符串**：整页本身是 JS 模板字面量，反引号会把它提前闭合
    if (tip) tip.textContent = who + ' · 请输入 6 位动态码，或 8 位恢复码';
    const box = document.getElementById('otpCode');
    box.value = '';
    box.focus();
  };
  // 第一段：用户名 + 密码 → 要么直接进，要么拿 otpToken 走第二段
  const go = async (name, password) => {
    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: csrfHeader(),
        body: JSON.stringify(withCk({ name, password })),
      });
      const j = await r.json().catch(() => null);
      if (r.ok && j?.needOtp) { otpToken = j.otpToken; showOtpStep(name); return true; }
      if (r.ok) { location.replace('/'); return true; }
      say(msg(j, '登录失败，再试一次'));
    } catch {
      say('连不上这台机器，检查网络后重试');
    }
    return false;
  };
  // 账号磁贴：免密的点了就进；设了密码的出密码框
  document.querySelectorAll('.tile').forEach((t) => {
    t.addEventListener('click', async () => {
      if (t.dataset.haspw !== '1') { void go(t.dataset.name, ''); return; }
      document.getElementById('tiles').hidden = true;
      const row = document.getElementById('pwRow');
      row.hidden = false;
      document.getElementById('pwWho').textContent = t.dataset.name;
      document.getElementById('pw').focus();
    });
  });
  const f = document.getElementById('pwForm');
  if (f) f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const nm = document.getElementById('nm');
    const name = nm ? nm.value : (document.getElementById('pwWho')?.textContent ?? '');
    const btn = f.querySelector('button');
    btn.disabled = true;
    try { await go(name, document.getElementById('pw').value); }
    finally { btn.disabled = false; }
  });
  // 第二段：动态码 / 恢复码 → 发正式会话
  const of = document.getElementById('otpForm');
  if (of) of.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (otpErrEl) otpErrEl.hidden = true;
    const code = document.getElementById('otpCode').value.trim();
    if (!code) { sayOtp('请输入验证码'); return; }
    const btn = of.querySelector('button');
    btn.disabled = true;
    try {
      const r = await fetch('/api/login/otp', {
        method: 'POST',
        headers: csrfHeader(),
        body: JSON.stringify(withCk({ otpToken, code })),
      });
      if (r.ok) { location.replace('/'); return; }
      const j = await r.json().catch(() => null);
      sayOtp(msg(j, '验证失败，请重新登录'));
      // 凭据过期/次数用完：服务端会回 E3823/E3824 —— 整页重来（回到第一段）
      if (j?.code === 'E3823' || j?.code === 'E3824') location.reload();
    } catch {
      sayOtp('连不上这台机器，检查网络后重试');
    } finally {
      btn.disabled = false;
    }
  });
  document.getElementById('otpBack')?.addEventListener('click', (e) => {
    e.preventDefault();
    otpToken = '';
    // 整页重来最省事：磁贴/表单的显隐状态都回到初始
    location.reload();
  });
  // 还没有账号：创建第一个（自动成为管理员），建完服务端直接发登录票
  const sf = document.getElementById('signForm');
  if (sf) sf.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const name = document.getElementById('nm').value.trim();
    const pw = document.getElementById('pw').value;
    if (!name) { say('先填用户名'); return; }
    if (pw !== document.getElementById('pw2').value) { say('两次输入的密码不一样'); return; }
    const btn = sf.querySelector('button');
    btn.disabled = true;
    try {
      const r = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body: JSON.stringify({ name, ...(pw ? { password: pw } : {}) }),
      });
      if (r.ok) { location.replace('/'); return; }
      const j = await r.json().catch(() => null);
      say(j ? (j.code ? j.code + '：' + j.error : j.error) : '没建成，再试一次');
    } catch {
      say('连不上这台机器，检查网络后重试');
    } finally {
      btn.disabled = false;
    }
  });
  /*
   * 掉卡先自动补卡（只对配过对的手机成立，见上面 clientKey 那段）：
   * 成功就地跳进工作台，连密码框都不用看。失败（设备记录被删 / 被别的手机占着）就留在
   * 这一页让人登录 —— 登录时 clientKey 会跟着提交，身份仍是设备。
   * bandi.ck-tried 保证一个标签页只试一次：否则"补卡失败 → 页面还在登录页 →
   * 又触发补卡"会来回打接口。
   */
  if (ck) {
    let tried = false;
    try { tried = sessionStorage.getItem('bandi.ck-tried') === '1'; } catch { /* 隐私模式：当没试过 */ }
    if (!tried) {
      fetch('/api/pair/resume', {
        method: 'POST',
        headers: { ...csrfHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: ck }),
      })
        .then((r) => {
          try { sessionStorage.setItem('bandi.ck-tried', '1'); } catch { /* 存不下就算了 */ }
          if (r.ok) location.replace('/');
        })
        .catch(() => { /* 连不上：留在登录页，人还能手输 */ });
    }
  }
})();
</script>`;

/** 分发器：mobile 位由 guard 的三个发放点按 isMobileUA(req) 传入（2026-11-06 双端分设计） */
function loginPage(args) {
  return args.mobile ? loginMobilePage(args) : loginDesktopPage(args);
}

/** 明文 TLS 告警条（IAM §10.1.1）：两端的登录页都顶在表单跟前，两端各调样式 */
function warnbarHtml() {
  const t = tlsWarning();
  return t
    ? `<p class="warnbar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.6 21.4 20H2.6Z"/><path d="M12 10v4.2"/><circle cx="12" cy="17.1" r=".4" fill="currentColor"/></svg><span>${esc(t)}</span></p>`
    : '';
}

/**
 * PC 登录页（2026-11-06 重设计：**左右分栏**）。
 *
 * 2026-10-31 起是"居中一张卡片"，2026-11-05 给它铺过色斑与毛玻璃 —— 但它一直同时
 * 服务电脑和手机，两头将就。用户拍板分端设计后，这页从此**只为宽屏设计**：
 *   · 左侧品牌大区：永远深色（不随系统反转），深海军蓝底 + 两团色斑 + 渐隐网格，
 *     logo / 产品名 / 一句话 / 三条产品特性。品牌大区是"为什么用它"，不是表单的装饰。
 *   · 右侧表单面：跟随系统深浅（登录前读不到用户主题偏好，跟系统走是唯一合理默认）。
 * 配色与主站同源：交互蓝 #0a84ff（浅色 #0066cc）、实心主按钮 #0071e3、logo 渐变
 * #4b6cb7→#182848（style.css 的 --logo-1/--logo-2）；圆角收成 10px（主站"面"档）。
 * ≤960px 是**兜底不是设计目标**：左栏收成顶部横向品牌条（特性列表藏掉），表单照常可用
 * —— 手机不该落到这页（isMobileUA 分流），落到这档的只有桌面窄窗口 / 桌面模式的浏览器。
 */
function loginDesktopPage({ hasUsers, loopback = false, users = null }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>班底 · ${hasUsers ? '登录' : '创建账号'}</title>
<style>
  :root {
    --bg: #101216;
    --glow: rgba(10,132,255,.07);
    --line: rgba(255,255,255,.09);
    --line-strong: rgba(255,255,255,.17);
    --text: #e9ecf2;
    --dim: #8d94a5;
    --input: rgba(255,255,255,.045);
    --input-solid: #15171c;
    --accent: #0a84ff;
    --btn: #0071e3;
    --accent-hi: #409cff;
    --bad: #ff8a80;
    --logo1: #4b6cb7;
    --logo2: #182848;
    color-scheme: dark;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f7f8fb;
      --glow: rgba(10,132,255,.06);
      --line: rgba(15,23,42,.10);
      --line-strong: rgba(15,23,42,.18);
      --text: #1a1f2a;
      --dim: #67718a;
      --input: rgba(15,23,42,.028);
      --input-solid: #ffffff;
      --accent: #0066cc;
      --btn: #0066cc;
      --accent-hi: #0a84ff;
      --bad: #d93025;
      color-scheme: light;
    }
  }
  * { box-sizing: border-box; }
  /*
   * ⚠️ 必须显式兜住 [hidden]（2026-10-31 实报「两个登录框叠在一起」）：
   * UA 的 [hidden]{display:none} 优先级最低，下面表单的 display:flex 这类选择器
   * 会把它盖掉 —— 于是"隐藏"的表单照样显示。加 !important 一劳永逸。
   */
  [hidden] { display: none !important; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.6 system-ui, -apple-system, 'Segoe UI', 'Noto Sans SC', 'Microsoft YaHei', sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .split { display: grid; grid-template-columns: minmax(0, 1fr) clamp(400px, 36vw, 480px); min-height: 100vh; }

  /* ---------- 左：品牌大区（永远深色） ---------- */
  .brandpane {
    position: relative; overflow: hidden; display: flex; flex-direction: column;
    padding: 56px 60px 40px;
    background: linear-gradient(158deg, #0e1424 0%, #0a0e18 58%, #080a10 100%);
    color: #eef2f8;
  }
  .brandpane::before {
    content: ""; position: absolute; inset: 0; pointer-events: none;
    background: radial-gradient(900px 520px at 18% -8%, rgba(59,110,245,.16), transparent 62%);
  }
  .brandpane::after {
    content: ""; position: absolute; inset: 0; pointer-events: none;
    background-image:
      linear-gradient(rgba(255,255,255,.045) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,.045) 1px, transparent 1px);
    background-size: 34px 34px;
    -webkit-mask-image: radial-gradient(ellipse 90% 80% at 30% 30%, #000 20%, transparent 72%);
    mask-image: radial-gradient(ellipse 90% 80% at 30% 30%, #000 20%, transparent 72%);
  }
  .orb { position: absolute; border-radius: 50%; pointer-events: none; }
  .o1 { width: 48vmax; height: 48vmax; left: -14vmax; top: -16vmax;
        background: radial-gradient(closest-side, rgba(59,110,245,.20), transparent 72%);
        animation: drift1 28s ease-in-out infinite alternate; }
  .o2 { width: 40vmax; height: 40vmax; left: 18vw; bottom: -18vmax;
        background: radial-gradient(closest-side, rgba(45,175,235,.12), transparent 72%);
        animation: drift2 36s ease-in-out infinite alternate; }
  @keyframes drift1 { to { transform: translate(6vmax, 5vmax) scale(1.08); } }
  @keyframes drift2 { to { transform: translate(-5vmax, -6vmax) scale(1.1); } }
  @keyframes fade-in { from { opacity: 0; } }
  .bp-brand { position: relative; z-index: 1; display: flex; align-items: center; gap: 16px; animation: fade-in .7s ease both; }
  .bp-logo {
    width: 58px; height: 58px; border-radius: 16px; flex: none; display: grid; place-items: center;
    background: linear-gradient(150deg, var(--logo1) 10%, var(--logo2) 95%);
    box-shadow: 0 16px 34px -14px rgba(35,64,140,.9), inset 0 1px 0 rgba(255,255,255,.22);
  }
  .bp-logo svg { width: 32px; height: 32px; display: block; }
  .bp-name { margin: 0; font-size: 27px; font-weight: 700; letter-spacing: .3px; }
  .bp-tag { margin: 4px 0 0; font-size: 13.5px; color: #93a0b8; }
  .bp-feats {
    position: relative; z-index: 1; margin: clamp(40px, 9vh, 96px) 0 0; padding: 0; list-style: none;
    display: flex; flex-direction: column; gap: 26px; animation: fade-in .7s .12s ease both;
  }
  .bp-feats li { display: flex; align-items: flex-start; gap: 14px; max-width: 420px; }
  .bp-ico { flex: none; width: 38px; height: 38px; border-radius: 11px; display: grid; place-items: center;
            background: rgba(59,110,245,.15); color: #7ea6ff; }
  .bp-ico svg { width: 19px; height: 19px; }
  .bp-feats b { display: block; font-size: 14.5px; font-weight: 600; color: #dfe6f2; }
  .bp-feats span { display: block; margin-top: 2px; font-size: 13px; line-height: 1.55; color: #8b97ad; }
  .bp-foot { position: relative; z-index: 1; margin: auto 0 0; padding-top: 28px;
             font-size: 12px; color: #5f6b80; letter-spacing: .2px; animation: fade-in .7s .2s ease both; }

  /* ---------- 右：表单面（跟随系统深浅） ---------- */
  .formpane { position: relative; display: flex; padding: 44px 48px; background: var(--bg); color: var(--text); }
  .formpane::before {
    content: ""; position: absolute; inset: 0; pointer-events: none;
    background: radial-gradient(700px 380px at 50% -10%, var(--glow), transparent 65%);
  }
  .fp-inner { position: relative; z-index: 1; width: min(360px, 100%); margin: auto; padding: 20px 0; }
  .fp-brand { display: flex; align-items: center; gap: 13px; margin-bottom: 26px; }
  .fp-logo { width: 40px; height: 40px; border-radius: 11px; flex: none; display: grid; place-items: center;
             background: linear-gradient(150deg, var(--logo1) 10%, var(--logo2) 95%);
             box-shadow: 0 10px 22px -10px rgba(35,64,140,.8), inset 0 1px 0 rgba(255,255,255,.2); }
  .fp-logo svg { width: 22px; height: 22px; display: block; }
  h1 { margin: 0; font-size: 18px; font-weight: 700; letter-spacing: .2px; }
  .tag { margin: 2px 0 0; font-size: 12.5px; color: var(--dim); }
  form { margin: 0; }
  #pwForm, #signForm, #otpForm { display: flex; flex-direction: column; gap: 10px; }
  /* 带图标的输入框：图标绝对定位在左，input 让出 38px；focus 时图标跟着点亮 */
  .field { position: relative; display: block; }
  .field > svg {
    position: absolute; left: 13px; top: 50%; width: 16px; height: 16px;
    transform: translateY(-50%); color: var(--dim); pointer-events: none; transition: color .15s;
  }
  .field:focus-within > svg { color: var(--accent); }
  input {
    width: 100%; height: 44px; padding: 0 13px 0 38px;
    border-radius: 10px; border: 1px solid var(--line);
    background: var(--input); color: var(--text); font: inherit;
    transition: border-color .15s, box-shadow .15s, background .15s;
  }
  input::placeholder { color: var(--dim); }
  input:hover { border-color: var(--line-strong); }
  input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3.5px rgba(10,132,255,.18); }
  /* 浏览器自动填充会把自己的淡黄底刷进输入框（深色下尤其突兀），压回主题色 */
  input:-webkit-autofill, input:-webkit-autofill:hover, input:-webkit-autofill:focus {
    -webkit-text-fill-color: var(--text);
    -webkit-box-shadow: 0 0 0 100px var(--input-solid) inset;
    caret-color: var(--text);
    transition: background-color 9999s ease-out;
  }
  button {
    height: 44px; border-radius: 10px; border: 0; cursor: pointer;
    background: var(--btn); color: #fff; font: inherit; font-weight: 600; letter-spacing: .4px;
    box-shadow: 0 10px 22px -10px rgba(0,86,214,.55);
    transition: filter .15s, transform .12s, box-shadow .15s;
  }
  button:hover { filter: brightness(1.08); }
  button:active { transform: translateY(1px); filter: brightness(.96); }
  button:focus-visible { outline: 2px solid var(--accent-hi); outline-offset: 2px; }
  button[disabled] { opacity: .55; cursor: default; transform: none; filter: none; }
  .bad { color: var(--bad); font-size: 12.5px; margin: 0 0 12px; }
  /* 每次从 hidden 里放出来都抖一下：让"这条就是为你响的"可感知（display 切换会重放动画） */
  .bad:not([hidden]) { animation: shake .32s ease; }
  @keyframes shake { 20% { transform: translateX(-4px); } 45% { transform: translateX(3px); } 70% { transform: translateX(-2px); } }
  /* 明文告警条（IAM §10.1.1）：监听非回环又没声明反代时，登录页顶上一条黄的 ——
     这是"人一定会看到"的位置；只写日志的话，部署的人永远不知道密码在明文里跑。 */
  .warnbar {
    display: flex; gap: 9px; align-items: flex-start;
    margin: 0 0 18px; padding: 10px 12px; border-radius: 10px; font-size: 12px; line-height: 1.55;
    color: #7a4b00; background: #fff4d6; border: 1px solid #f0d089;
  }
  .warnbar svg { flex: none; width: 15px; height: 15px; margin-top: 1px; }
  @media (prefers-color-scheme: dark) {
    .warnbar { color: #ffd993; background: rgba(58,44,18,.82); border-color: #6b5220; }
  }
  .hint { margin: 14px 0 0; font-size: 12.5px; color: var(--dim); text-align: center; }
  .hint a { color: var(--accent); text-decoration: none; font-weight: 500; }
  .hint a:hover { text-decoration: underline; }
  /* OTP 第二段（共享标记用的 .brand/.logo/.tag 结构在这里定样）：锁标压成主站蓝系 */
  #otpPane .brand { display: flex; align-items: center; gap: 13px; margin-bottom: 26px; }
  #otpPane .logo { width: 40px; height: 40px; border-radius: 11px; flex: none; display: grid; place-items: center;
                   background: linear-gradient(150deg, #2f7cf6, #0a5bd8);
                   box-shadow: 0 10px 22px -10px rgba(0,86,214,.7); }
  #otpPane .logo svg { width: 21px; height: 21px; }
  /* 账号磁贴（回环登录页）：电脑开机选账户的版式。
     .tile 是 button —— 上面主按钮的实心底/白字要在它身上压回去 */
  #tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 10px; margin-bottom: 4px; }
  .tile {
    height: auto; margin: 0; padding: 15px 6px 11px; border-radius: 12px; letter-spacing: 0;
    display: flex; flex-direction: column; align-items: center; gap: 8px;
    background: var(--input); color: var(--text); border: 1px solid var(--line);
    font-weight: 400; box-shadow: none;
    transition: border-color .15s, transform .15s, box-shadow .15s;
  }
  .tile:hover {
    background: var(--input); border-color: var(--accent); filter: none; transform: translateY(-2px);
    box-shadow: 0 10px 22px -12px rgba(10,132,255,.45);
  }
  .tile:active { transform: translateY(0); filter: none; }
  .tile-ava { width: 42px; height: 42px; border-radius: 50%; color: #fff;
              background: linear-gradient(145deg, var(--accent), var(--logo1));
              box-shadow: 0 8px 18px -8px rgba(10,132,255,.6), inset 0 1px 0 rgba(255,255,255,.3);
              font-size: 17px; font-weight: 600; line-height: 42px; text-align: center; }
  .tile-name { font-size: 12.5px; }
  .tile-who { margin: 0 0 12px; font-size: 13px; color: var(--dim); }
  ::selection { background: rgba(10,132,255,.32); }
  @media (prefers-reduced-motion: reduce) {
    .orb, .bad:not([hidden]), .bp-brand, .bp-feats, .bp-foot { animation: none !important; }
    button, input, .tile, .field > svg { transition: none !important; }
  }
  /*
   * 兜底，不是设计目标（手机另有专页）：窄窗口下左栏收成顶部横向品牌条。
   */
  @media (max-width: 960px) {
    .split { grid-template-columns: 1fr; }
    .brandpane { padding: 24px 28px 20px; }
    .bp-feats, .bp-foot { display: none; }
    .bp-logo { width: 42px; height: 42px; border-radius: 12px; }
    .bp-logo svg { width: 24px; height: 24px; }
    .bp-name { font-size: 20px; }
    .bp-tag { font-size: 12.5px; }
    .formpane { padding: 26px 24px 34px; }
  }
</style>
</head>
<body>
  <div class="split">
    <aside class="brandpane">
      <!-- 色斑是纯装饰：aria-hidden 且不接事件，读屏当它不存在 -->
      <div class="bg" aria-hidden="true" style="position:absolute;inset:0;overflow:hidden;pointer-events:none"><i class="orb o1"></i><i class="orb o2"></i></div>
      <header class="bp-brand">
        <div class="bp-logo">${brandSvg('bp')}</div>
        <div>
          <p class="bp-name">班底</p>
          <p class="bp-tag">自托管 · 多 agent 协作平台</p>
        </div>
      </header>
      <ul class="bp-feats">
        <li>
          <i class="bp-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg></i>
          <div><b>消息协作</b><span>人和数字员工在同一个会话里干活</span></div>
        </li>
        <li>
          <i class="bp-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg></i>
          <div><b>专家库</b><span>把常用能力沉淀成随取随用的专家</span></div>
        </li>
        <li>
          <i class="bp-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 7h3v9H7z"/><path d="M14 7h3v5h-3z"/></svg></i>
          <div><b>任务看板</b><span>任务从想法到落地，全程可追</span></div>
        </li>
      </ul>
      <p class="bp-foot">bandi · self-hosted</p>
    </aside>
    <main class="formpane">
      <div class="fp-inner">
        ${warnbarHtml()}
        <div id="loginPane">
          <header class="fp-brand">
            <div class="fp-logo">${brandSvg('fp')}</div>
            <div>
              <h1>班底</h1>
              <p class="tag">${hasUsers ? '登录你的账号' : '创建第一个账号 · 它将自动成为管理员'}</p>
            </div>
          </header>
          ${loginFormHtml({ hasUsers, loopback, users })}
        </div>
        ${OTP_PANE_HTML}
      </div>
    </main>
  </div>
${LOGIN_SCRIPT}
</body>
</html>
`;
}

/**
 * 手机登录页（2026-11-06 新增：与 PC **分端设计**，用户：「手机端的账号密码登录页
 * 不必和 PC 端的一样」）。这页照壳启动页（apps/mobile/dist/launcher.css）的 iOS 语汇画：
 *   · 纯色系统底（深 #0a0b0d / 浅 iOS grouped #f2f3f7），不加光晕，靠 filled 卡片 + hairline 分层；
 *   · 品牌区 = iOS 大标题式一行、左对齐（居中 hero 是落地页的排法），与启动页首页同款；
 *   · 输入框 48px filled、主按钮 50px 实心 accent、去字距 —— token 与 launcher.css 同名同值；
 *   · 报错 = **底部浮出横幅**（launcher 的 .status 同款）：#err/#otpErr 是共享标记里的
 *     同一些元素，这里只用 CSS 改样，脚本一个字节不动；
 *   · 内容顶部对齐、输入框落上半屏，键盘盖不住（launcher「别垂直居中、别加大段留白」的教训）；
 *     body 不加 overflow-y：移动 WebView 的滚动容器是文档本身。
 * 逻辑（四态表单 / OTP / 补卡）与 PC 页共用同一份。磁贴态手机实际到不了（回环才摆磁贴），
 * 样式补全只为共享标记完整。
 */
function loginMobilePage({ hasUsers, loopback = false, users = null }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
<title>班底 · ${hasUsers ? '登录' : '创建账号'}</title>
<style>
  :root {
    --bg: #0a0b0d;
    --card: #16181c;
    --card-2: #1e2126;
    --hairline: rgba(255,255,255,.08);
    --line: rgba(255,255,255,.1);
    --text: #f1f2f4;
    --dim: #9aa1a9;
    --strong: #d5d9de;
    --accent: #3d76f6;
    --accent-2: #6d95ff;
    --bad: #c0504d;
    --err-ink: #f0b3b1;
    --err-bg: color-mix(in srgb, var(--bad) 22%, #1d2025);
    --placeholder: #575d65;
    --r-card: 18px;
    --r-ctl: 12px;
    --r-btn: 14px;
    color-scheme: dark;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f2f3f7;
      --card: #ffffff;
      --card-2: #f5f6f9;
      --hairline: rgba(60,60,67,.13);
      --line: rgba(60,60,67,.16);
      --text: #14161a;
      --dim: #6d727b;
      --strong: #2c3037;
      --accent: #2f62e8;
      --accent-2: #3b6ef5;
      --bad: #a4262c;
      --err-ink: #a4262c;
      --err-bg: color-mix(in srgb, var(--bad) 10%, #ffffff);
      --placeholder: #9aa0a6;
      color-scheme: light;
    }
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html { min-height: 100%; }
  body {
    margin: 0; min-height: 100dvh; background: var(--bg); color: var(--text);
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif;
    -webkit-text-size-adjust: 100%; -webkit-tap-highlight-color: transparent; -webkit-font-smoothing: antialiased;
  }
  .wrap {
    min-height: 100dvh; max-width: 480px; margin: 0 auto;
    display: flex; flex-direction: column;
    padding: calc(20px + env(safe-area-inset-top)) 20px calc(20px + env(safe-area-inset-bottom));
  }
  /* 品牌区：iOS 大标题式一行、左对齐（launcher 同款） */
  .brand { display: flex; align-items: center; gap: 13px; margin-top: clamp(6px, 4vh, 30px); }
  .logo { flex: none; width: 46px; height: 46px; display: grid; place-items: center; border-radius: 13px;
          background: linear-gradient(150deg, #5b86ff, #2b52c9);
          box-shadow: 0 6px 16px rgba(59,110,245,.32); }
  .logo svg { width: 26px; height: 26px; }
  /* 第二段的锁标（与产品标同尺寸同位，切换时不跳动） */
  .logo.lock { background: linear-gradient(150deg, #4d80f7, #2b52c9); }
  h1 { margin: 0; font-size: 22px; line-height: 1.2; font-weight: 700; }
  .tag { margin: 3px 0 0; font-size: 13px; color: var(--dim); }
  .warnbar { display: flex; gap: 9px; align-items: flex-start; margin: 16px 0 0; padding: 12px 14px;
             border-radius: var(--r-ctl); font-size: 12.5px; line-height: 1.55;
             color: #7a4b00; background: #fff4d6; border: 1px solid #f0d089; }
  .warnbar svg { flex: none; width: 15px; height: 15px; margin-top: 1px; }
  @media (prefers-color-scheme: dark) {
    .warnbar { color: #ffd993; background: rgba(58,44,18,.82); border-color: #6b5220; }
  }
  form { margin: 0; }
  #pwForm, #signForm, #otpForm { display: flex; flex-direction: column; gap: 10px; margin-top: clamp(18px, 4.5vh, 32px); }
  /* 左侧图标是 PC 版共享标记带来的；手机按 launcher 的纯 filled 输入框来 —— 藏掉 */
  .field { display: block; }
  .field > svg { display: none; }
  input { width: 100%; height: 48px; padding: 0 14px; border: 1px solid var(--line); border-radius: var(--r-ctl);
          background: var(--card); color: var(--text); font: inherit; outline: none;
          transition: border-color .16s ease, box-shadow .16s ease; }
  input::placeholder { color: var(--placeholder); }
  input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(61,118,246,.18); }
  input:-webkit-autofill, input:-webkit-autofill:hover, input:-webkit-autofill:focus {
    -webkit-text-fill-color: var(--text);
    -webkit-box-shadow: 0 0 0 100px var(--card) inset;
    caret-color: var(--text);
    transition: background-color 9999s ease-out;
  }
  button { appearance: none; width: 100%; height: 50px; margin-top: 6px; border: none; border-radius: var(--r-btn);
           background: var(--accent); color: #fff; font-family: inherit; font-size: 16px; font-weight: 600; cursor: pointer;
           transition: transform .08s ease, filter .15s ease, opacity .15s ease; }
  button:active { transform: scale(.98); filter: brightness(.92); }
  button:focus-visible { outline: 2px solid var(--accent-2); outline-offset: 2px; }
  button[disabled] { opacity: .55; cursor: default; transform: none; filter: none; }
  /*
   * 报错 = 底部浮出横幅（launcher .status 同款）。display 切换不触发 transition，
   * 入场动画用 animation；左下的阴影别太重，别抢表单的戏。
   */
  .bad { position: fixed; left: 14px; right: 14px; bottom: calc(16px + env(safe-area-inset-bottom)); z-index: 30;
         margin: 0; padding: 12px 14px; border-radius: 14px;
         background: var(--err-bg); color: var(--err-ink);
         font-size: 13px; line-height: 1.55; word-break: break-word;
         box-shadow: 0 16px 36px rgba(0,0,0,.35); }
  .bad:not([hidden]) { animation: rise .22s ease both; }
  @keyframes rise { from { opacity: 0; transform: translateY(10px); } }
  .hint { margin: 16px 2px 0; font-size: 13px; color: var(--dim); }
  .hint a { color: var(--accent); text-decoration: none; font-weight: 500; }
  /* 账号磁贴：手机到不了这个态（回环才摆磁贴），样式补全只为共享标记完整 */
  #tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 10px; margin-top: 2px; }
  .tile { appearance: none; height: auto; margin: 0; padding: 14px 6px 11px; border-radius: var(--r-ctl); letter-spacing: 0;
          display: flex; flex-direction: column; align-items: center; gap: 8px;
          background: var(--card); color: var(--text); border: 1px solid var(--line);
          font-family: inherit; font-size: 12.5px; font-weight: 400; box-shadow: none; }
  .tile:active { background: var(--card-2); transform: none; filter: none; }
  .tile-ava { width: 44px; height: 44px; border-radius: 50%; color: #fff;
              background: linear-gradient(150deg, #5b86ff, #2b52c9);
              font-size: 17px; font-weight: 600; line-height: 44px; text-align: center; }
  .tile-name { font-size: 12.5px; }
  .tile-who { margin: 0; font-size: 13px; color: var(--dim); }
  #pwRow { margin-top: 14px; }
  .foot { margin: auto 0 0; padding-top: 24px; font-size: 12px; color: var(--dim); }
  @media (prefers-reduced-motion: reduce) {
    .bad:not([hidden]) { animation: none; }
    button, input { transition: none; }
  }
</style>
</head>
<body>
  <div class="wrap">
    ${warnbarHtml()}
    <div id="loginPane">
      <header class="brand">
        <div class="logo">${brandSvg('m')}</div>
        <div>
          <h1>班底</h1>
          <p class="tag">${hasUsers ? '登录你的账号' : '创建第一个账号 · 它将自动成为管理员'}</p>
        </div>
      </header>
      ${loginFormHtml({ hasUsers, loopback, users })}
    </div>
    ${OTP_PANE_HTML}
    <p class="foot">bandi · 自托管 · 多 agent 协作</p>
  </div>
${LOGIN_SCRIPT}
</body>
</html>
`;
}

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
