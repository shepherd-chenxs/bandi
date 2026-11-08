/**
 * 访问闸 —— **身份认证的唯一起点**（人走中枢，机器走令牌）。
 *
 * **人**（2026-11-07 起）：账号全在身份中枢，本机只渲染一个账号密码框（表单
 * `POST /hub/login` 转给中枢，见 `routes/hub.mjs`），手机走中枢票进门
 * （`GET /hub/enter`）。两条路最后都落到本机会话 `bandi_sid` —— 登录即全权，
 * 本机不再有第二套账号密码、角色或菜单权限（那两套已整体退场）。
 *
 * **机器**：`bandi_token`（operator）与节点/手机令牌，规则多年未变：
 *
 *   · 只监听回环（桌面版 / 单机）→ **API 免鉴权**（脚本/冒烟/CLI 一个字节没变），
 *     但浏览器抓面板 HTML 要先有登录会话 —— API 的闸管机器和脚本，会话的闸管人；
 *   · 监听非回环（服务器）→ 所有请求都要凭据。
 *
 * ⚠️ "本机"不是看 `remoteAddress` 是不是 `127.0.0.1`：反向代理会把来源变成回环。
 * 每次请求都用 `security/source.mjs` 的 `classifySource()` 现算，四条同时成立才算本机：
 * 未设 `BANDI_TRUST_PROXY`、无转发头、监听回环、peer 与 Host 都是本机。
 *
 * 令牌从哪来，按优先级：
 *   1. `BANDI_TOKEN`（显式指定，方便容器/CI）
 *   2. 数据目录里的 `token` 文件（首次启动自动生成，权限 0600）
 *
 * 三种带法都认，各有各的用处：
 *   · **Cookie** `bandi_token` —— 浏览器（历史配对遗留；登录会话走 `bandi_sid`）。
 *   · **头** `X-Bandi-Token` —— 节点与脚本。
 *   · **查询** `?token=` —— 首次进来那一下，随即换成 Cookie 并重定向掉，
 *     免得令牌留在地址栏与历史里。
 *
 * 要找回令牌就一条命令（控制面那台机器上）：
 *   Windows:  `type <数据目录>\token`      例：type E:\02CodeSpace\bandi\data\token
 *   Linux:    `cat  <数据目录>/token`      例：cat ~/bandi-data/token
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
import * as policy from './security/policy.mjs';
import { isRegistered } from './security/route-policy.mjs';
import * as csrf from './security/csrf.mjs';
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
 * 而且「忘掉」踢不掉它（令牌还有效）。现在分三类身份（手机设备令牌 2026-11-07 已退场）：
 *   · `operator` —— 总机那枚（脚本 / CLI / 运维，以及 `?token=` 首次进场；
 *                   **浏览器面板走账号会话**，见 `guard` 的回环分支）；
 *   · `node`     —— 每台机器**自己那枚**（邀请码换来的，见 store.issueNodeToken），
 *                  带 `scope: Set`（`compute` / `panel`）；
 *   · ~~`device`~~ —— 手机设备令牌**已整体退场**（2026-11-07 用户：「老体系去掉」）：
 *                   手机只走中枢账号登录（`/hub/enter` → 本机会话）。老库里那三张
 *                   `mobile_*` 表不再读写，存量 `bd_` 令牌一律认不出来 = 401 E4010。
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
 * **判定只有一处**（设计 §6.1）。`guard()` 里只调这一个函数，别的什么都不判。
 *
 * 判定逻辑本体在 `security/policy.mjs` 的 `authorize()`（**登录用户 = 全权**，
 * 机器身份各有各的边界），这里只负责把本模块的归属判定
 * （节点只认自己的端点 —— 那两条要查库对 nodeId）作为 `rules` 注进去，
 * 顺便避免 security/ ↔ auth.mjs 的 import 环。
 *
 * 三种令牌携带方式（Cookie / `X-Bandi-Token` / `?token=`）走的**都是这里** ——
 * `tokenOf()` 先统一取出令牌，`identify()` 再统一认出"是谁"。
 * 所以"面板令牌换个 Cookie 就变成操作员"这种事不会发生。
 *
 * 返回 `'allow' | 'E4012' | 'E4031' | 'E4032' | 'E4033'`。
 *
 * **不缓存**：每次请求现算，改完对下一次请求立即生效。
 */
export function decide(who, method, pathname) {
  return policy.authorize({
    who,
    method,
    pathname,
    rules: { nodeMayReach, runMayReach, touchNodeUsed: store.touchNodeUsed },
  });
}

/**
 * 这次请求的**操作人是谁**（2026-10-31 用户概念落地：消息署名 / 建卡人 / 看"我"是谁）。
 *
 * 四种答案：
 *   · 登录用户 → 他自己（多端各记各的，这是唯一精确的一档）；
 *   · operator（回环 / 共享令牌）→ **第一个用户**（"本机自动登录"：像一台共用电脑，
 *     没人显式登录时活都算机主的）。还没有任何用户 → null，调用方回落到 LOCAL_USER 占位；
 *   · 节点令牌 → null（机器不是人，不冒充任何人）。
 *
 * 只用于**落数据**（署名），绝不用于鉴权 —— 权限判定仍然只看 `decide()`，两码事别混。
 */
export function actorUser(req) {
  const a = req?.bandiAuth;
  if (!a) return null;
  if (a.kind === 'user' && a.userId) return store.getUser(a.userId);
  if (a.kind === 'operator') return store.firstUser();
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
 * 2026-11-07 起登录即全权，operator 与登录用户**都算**；node / device 令牌不算。
 */
export function mayManage(req) {
  const a = req?.bandiAuth;
  if (!a) return false;
  return a.kind === 'operator' || a.kind === 'user';
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
   * **身份中枢进门**（2026-11-06）：`GET /hub/enter?ticket=…`。
   *
   * 此刻请求手上**只有一张中枢签的票** —— 那就是它的凭据（手机壳里没有"登录表单"
   * 这一步，它只会打开一个 URL）。与 `/api/nodes/join` 同一个模式：guard 只负责放它进来，
   * 验票、查本地授权表、发本机会话全在 `routes/hub.mjs` 里 —— 别在这里提前判，
   * 也别让这里"看起来像"在做认证。
   *
   * ⚠️ 它**不削弱**任何东西：票验不过就是 400，票有效但本地没认过这个账号就是 403。
   */
  if (req.method === 'GET' && url.pathname === '/hub/enter') return true;
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
     * 回环形态（桌面版 / 单机）—— **API 与面板分开**：
     *
     * · **API 仍是回环信任**：本机脚本 / 冒烟 / CLI 不带凭据照旧 = operator（一个字节没变）；
     *   但**带着有效登录会话的浏览器按登录人算**（kind:'user'）—— 消息署名精确到人。
     *   退出登录之后回 operator。
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
    req.bandiAuth = { kind: 'operator', via: 'loopback' };
    /*
     * **面板只给"人"**：operator 是**机器凭据**（回环免登录 / 令牌），不是一个可以在
     * 界面上当"我"的身份 —— 它没有 users 行，「我的」页画不出名字，用户看到的就是
     * 一个空页 + 一段解释。所以门前移：没会话就给登录页。
     */
    if (wantsPanelHtml(req, url)) {
      // 登录页顺手种 CSRF 双提交值：登录成功后所有带 Cookie 的写请求都要带上它。
      // 值同时给到页面（中枢登录表单的隐藏域）：桌面壳的表单 POST 会带 Origin: null
      // （2026-11-07 实报 E7006），/hub/login 的同源闸拿这对值兜底（routes/hub.mjs）。
      const hadCsrf = csrf.valuesOf(req).cookie;
      const csrfVal = hadCsrf || csrf.mint();
      const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
      if (!hadCsrf) headers['Set-Cookie'] = csrf.cookieFor(csrfVal);
      res.writeHead(200, headers);
      res.end(loginPage({ mobile: isMobileUA(req), hub: hubOf(auth), csrf: csrfVal }));
      return false;
    }
    return true;
  }

  const got = tokenOf(req, url);
  let who = identify(auth, got);

  /*
   * **登录会话兜底**（2026-10-28 第三刀）。
   *
   * 顺序是**令牌优先、会话兜底**，不是反过来：一个浏览器里同时躺着 `bandi_token`
   * （root）和 `bandi_sid`（某次登录）时，握 root 令牌的请求不该被一个陈旧的会话票
   * 降权。两条路都保留、互不覆盖，语义才最不容易出意外。
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
     * 手机也一样走这条（2026-11-07 设备令牌退场）：手机浏览器打开面板 = 登录页，
     * App 里是 WebView 带中枢会话进来，两种都不是"令牌当登录"。
     */
    if (who.kind === 'operator' && wantsPanelHtml(req, url)) {
      const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
      /*
       * **顺手清掉这枚令牌 Cookie**（2026-11-01 实报：点了登录，输入框被刷空、还在登录页）。
       * 面板不再认令牌，而 `令牌优先于会话` 会让这枚陈年 Cookie 把刚登录的人一直压回
       * operator → 又挡回登录页 → 登录永远"没反应"。浏览器以会话为准，令牌只走请求头。
       * 只清"确实是根令牌"的那枚（同名 Cookie 可能是别的东西，别误伤）。
       */
      const staleTok = String(parseCookies(req.headers.cookie)[COOKIE] || '');
      const dropToken = !!staleTok && !!auth.token && timingSafeEqual(staleTok, auth.token);
      const hadCsrf = csrf.valuesOf(req).cookie;
      const csrfVal = hadCsrf || csrf.mint();
      const setCookies = [];
      if (!hadCsrf) setCookies.push(csrf.cookieFor(csrfVal));
      if (dropToken) setCookies.push(clearedTokenCookie());
      if (setCookies.length) headers['Set-Cookie'] = setCookies;
      res.writeHead(200, headers);
      res.end(loginPage({ mobile: isMobileUA(req), hub: hubOf(auth), csrf: csrfVal }));
      return false;
    }
    req.bandiAuth = who; // 下游（比如"忘掉"、员工编辑的字段闸）据此知道这枚令牌是谁
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
  const wantsHtml = wantsPanelHtml(req, url);
  if (wantsHtml) {
    // 同上：服务器形态的登录页也种 CSRF 值（登录成功后的写请求要带；值同样给到隐藏域）
    const hadCsrf = csrf.valuesOf(req).cookie;
    const csrfVal = hadCsrf || csrf.mint();
    const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
    const setCookies = [];
    if (!hadCsrf) setCookies.push(csrf.cookieFor(csrfVal));
    /*
     * 顺手扫掉**没法用的**访问令牌 Cookie（2026-11-01）：认不出来的根令牌 / 被吊销的
     * 节点令牌 / 早已退场的 `bd_` 配对令牌，留在浏览器里只会在每次请求上添一次 401，
     * 还挡在"令牌优先"那条路上。到这一步说明它已经认不出来了，清掉是安全的。
     */
    const staleTok = String(parseCookies(req.headers.cookie)[COOKIE] || '');
    if (staleTok) setCookies.push(clearedTokenCookie());
    if (setCookies.length) headers['Set-Cookie'] = setCookies;
    res.writeHead(200, headers);
    res.end(loginPage({ mobile: isMobileUA(req), hub: hubOf(auth), csrf: csrfVal }));
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
 */
function wantsPanelHtml(req, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const p = url.pathname;
  if (p.startsWith('/api/')) return false;
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
  const host = esc(hub?.host || '中枢');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
<title>班底 · 登录</title>
<style>
  :root {
    --bg: #101216;
    --card: #171a20;
    --line: rgba(255,255,255,.10);
    --line-strong: rgba(255,255,255,.20);
    --text: #e9ecf2;
    --dim: #8d94a5;
    --input: rgba(255,255,255,.045);
    --accent: #0a84ff;
    --btn: #0071e3;
    --bad: #ff8a80;
    --bad-bg: rgba(255,90,80,.10);
    color-scheme: dark;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f7f8fb;
      --card: #ffffff;
      --line: rgba(15,23,42,.10);
      --line-strong: rgba(15,23,42,.20);
      --text: #1a1f2a;
      --dim: #67718a;
      --input: #f4f6fa;
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
    display: grid; place-items: center; padding: 28px 20px calc(28px + env(safe-area-inset-bottom));
    font: 14.5px/1.6 system-ui, -apple-system, 'Segoe UI', 'Noto Sans SC', 'Microsoft YaHei', sans-serif;
    -webkit-text-size-adjust: 100%;
  }
  .card { width: 100%; max-width: 372px; }
  .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 26px; }
  .logo {
    width: 40px; height: 40px; border-radius: 11px; flex: none; display: grid; place-items: center;
    background: linear-gradient(150deg, #4b6cb7, #182848);
    box-shadow: 0 10px 22px -12px rgba(24,40,72,.85);
  }
  .logo svg { width: 22px; height: 22px; }
  h1 { margin: 0; font-size: 19px; font-weight: 650; letter-spacing: .2px; }
  .tag { margin: 2px 0 0; font-size: 12.5px; color: var(--dim); }
  form { margin: 0; display: flex; flex-direction: column; gap: 10px; }
  label { display: block; font-size: 12.5px; color: var(--dim); margin-bottom: 6px; }
  input {
    width: 100%; height: 44px; padding: 0 13px; border-radius: 10px;
    border: 1px solid var(--line); background: var(--input); color: var(--text);
    font: inherit; outline: none; transition: border-color .15s, box-shadow .15s;
  }
  input::placeholder { color: var(--dim); }
  input:hover { border-color: var(--line-strong); }
  input:focus { border-color: var(--accent); box-shadow: 0 0 0 3.5px color-mix(in srgb, var(--accent) 22%, transparent); }
  input:-webkit-autofill, input:-webkit-autofill:hover, input:-webkit-autofill:focus {
    -webkit-text-fill-color: var(--text);
    -webkit-box-shadow: 0 0 0 100px var(--card) inset;
    caret-color: var(--text);
    transition: background-color 9999s ease-out;
  }
  .err {
    margin: 0 0 14px; padding: 10px 12px; border-radius: 10px;
    font-size: 12.5px; line-height: 1.5; color: var(--bad);
    background: var(--bad-bg); border: 1px solid color-mix(in srgb, var(--bad) 28%, transparent);
  }
  button {
    height: 44px; border-radius: 10px; border: 0; cursor: pointer;
    background: var(--btn); color: #fff; font: inherit; font-weight: 600; letter-spacing: .3px;
    box-shadow: 0 10px 22px -12px rgba(0,86,214,.75);
    transition: filter .15s, transform .12s;
  }
  button:hover { filter: brightness(1.08); }
  button:active { transform: translateY(1px); filter: brightness(.96); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button.link {
    height: auto; background: none; box-shadow: none; color: var(--dim);
    font-weight: 400; letter-spacing: 0; padding: 6px; margin-top: 2px;
  }
  button.link:hover { color: var(--text); filter: none; }
  button.link:active { transform: none; }
  .foot { margin: 22px 0 0; font-size: 12px; color: var(--dim); text-align: center; }
  .foot code { font: 11.5px/1 ui-monospace, Consolas, monospace; opacity: .8; }
</style>
</head>
<body>
  <div class="card">
    <div class="brand">
      <div class="logo">${brandSvg('hub')}</div>
      <div>
        <h1>班底</h1>
        <p class="tag">登录 <code>${host}</code> 上的账号</p>
      </div>
    </div>
    ${error ? `<p class="err">${esc(error)}</p>` : ''}
    <form method="post" action="/hub/login" autocomplete="on">
      <!-- _csrf 与 bandi_csrf Cookie 成对：提交端在 Origin 缺失/为 null 时靠它兜底（routes/hub.mjs） -->
      ${csrf ? `<input type="hidden" name="_csrf" value="${esc(csrf)}" />` : ''}
      <div>
        <label for="u">手机号</label>
        <input id="u" name="username" value="${esc(username)}" type="tel" inputmode="tel"
               autocomplete="tel" maxlength="11" placeholder="11 位手机号"
               autocapitalize="off" spellcheck="false" required ${mobile ? '' : 'autofocus'} />
      </div>
      <div>
        <label for="p">密码</label>
        <input id="p" name="password" type="password" autocomplete="current-password" required />
      </div>
      <button type="submit">登录</button>
    </form>
    <p class="foot">没注册过？提交就自动创建 · 账号在中枢上，每台机器共用</p>
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
