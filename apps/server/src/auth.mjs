/**
 * 访问令牌 —— **把控制面放到公网之后的第一道闸**。
 *
 * 规则只有一条，而且看的是**监听地址**、不是请求来源：
 *
 *   · 只监听回环（桌面版 / 单机）→ **API 免鉴权**。外面根本进不来，加它就是白加，
 *     还会把"单机零配置、不需要 token"这条硬约束毁掉。
 *   · 监听非回环（服务器）→ **所有请求都要令牌**。
 *
 * 2026-10-31 用户拍板补了一层（「不管总机还是分机，都要用用户来登录」）：
 * 回环形态下 **API 照旧免鉴权**（脚本/冒烟/CLI 一个字节没变），但**浏览器抓面板 HTML
 * 要先有登录会话**（有账号而无会话 → 登录页，免密账号点了就进，见 guard 的回环分支）——
 * API 的闸管机器和脚本，登录的闸管人，两层各管各的。
 *
 * 为什么**不按"来源是不是回环"判断**：反向代理会把来源变成回环 ——
 * 那样架一层代理就把闸绕过去了。规则跟着**配置**走，才不会被部署方式偷走。
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
 * ⚠️ **"为什么不做用户名＋密码"** —— 2026-10-16 用户问过三次，最后的结论是**不做** ✓，
 * 这里把理由钉住，免得以后又绕回来：
 *   · 改善的只是"**记得住**"，**不是更安全** ✗ —— 明文 HTTP 下令牌、密码、会话票**一样会被抓包** ✓；
 *     真正要防抓包只有一条路：**把链路加密**（SSH 隧道 / Cloudflare 隧道 / 给控制面挂 TLS ✓）；
 *   · 随机令牌被抓的**影响面最小**（只赔这一个面板 ✓），而且**能一键作废**（删 `token` 文件 + 重启 ✓）；
 *     人设的密码一旦和别处重复，赔的是一串账号 ✗✗；
 *   · 密码模式还额外欠三笔账：**"第一个账号只有本机能设"**（否则局域网里先打开的人就占了 ✗）、
 *     **加盐哈希＋长度下限＋失败限速**、**忘了怎么重置** ✓ —— 而随机令牌＋本机文件天生就没这三笔账 ✓。
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
export function isLoopbackHost(host) {
  const h = String(host ?? '').trim().toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
}

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
 */
export function setup({ host, dataDir, envToken }) {
  if (isLoopbackHost(host)) return { required: false, token: '', from: '', created: false };
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
 * 而且「忘掉」踢不掉它（令牌还有效）。现在分三种身份：
 *   · `operator` —— 总机那枚（浏览器登录、脚本、运维）；
 *   · `node`     —— 每台机器**自己那枚**（邀请码换来的，见 store.issueNodeToken），
 *                  带 `scope: Set`（`compute` / `panel`）；
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
   * 走 store.deviceAuthByToken（只存哈希的那张表）；不认识/已过期/被踢出都返回 null，
   * 走下面的 401 E4010 —— **不学节点造 `revoked` 类**：设备被踢出的引导是"重新扫码"，
   * 与"需要令牌"在前端是同一条提示，不值得多一个身份类。
   */
  const dev = store.deviceAuthByToken(token);
  if (dev) return { kind: 'device', deviceId: dev.deviceId };
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
  // 5 重启与局域网开关
  { method: /^POST$/, path: /^\/api\/restart$/ }, //                             server.mjs:1425
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
 * **判定只有一处**（设计 §6.1）。`guard()` 里只调这一个函数，别的什么都不判。
 *
 * 三种令牌携带方式（Cookie / `X-Bandi-Token` / `?token=`）走的**都是这里** ——
 * `tokenOf()` 先统一取出令牌，`identify()` 再统一认出"是谁"。
 * 所以"面板令牌换个 Cookie 就变成操作员"这种事不会发生。
 *
 * 返回 `'allow' | 'E4012' | 'E4031' | 'E4032' | 'E4033'`，规则按序：
 *   1. `operator` → 放行；
 *   2. 有 `compute` 且是"节点自己的活"（`nodeMayReach` + `runMayReach`）→ 放行；
 *   3. 有 `panel` 且**不在**禁止清单里 → 放行（并节流记一次"最近使用"）；
 *   4. 有 `panel` 但命中禁止清单 → `E4032`；其余（只有 compute）→ `E4031`；
 *   5. `device` 且在白名单里 → 放行（并节流记一次"最近活跃"）；白名单外 → `E4033`。
 *
 * **不缓存**（决策 A 规则 2）：每次请求现算，总机那边改完对下一次请求立即生效。
 */
export function decide(who, method, pathname) {
  if (!who) return 'allow'; // 不该发生：guard 只在 identify 到身份之后才问
  if (who.kind === 'operator') return 'allow';
  if (who.kind === 'revoked') return 'E4012';
  // 手机设备：白名单制（判定只有一处，touchDevice 的节流写库也只在这一条路上发生）
  if (who.kind === 'device') {
    return deviceMayReach(method, pathname) ? 'allow' : 'E4033';
  }
  /*
   * **登录用户**（2026-10-28 第三刀）。
   *
   * 只有两种结果，不引入第三套白名单：
   *   · 角色是 `admin` → 全放行（他就是管理员，没有"管理员做不了"这回事）；
   *   · 其余角色 → **复用手机的 `deviceMayReach`**（任务书 §三 硬性要求）。
   *     理由：那张表的口径正好是"看 + 发消息 + 留便签 + 审批 + 停止"，
   *     和"一个普通员工该能干什么"完全对得上；再抄一份新白名单，两边迟早走偏。
   */
  if (who.kind === 'user') {
    if (who.admin) return 'allow';
    /*
     * `/api/me` 必须对**任何已登录账号**成立 —— 它是"我是谁"，登录完第一件事就是问它，
     * 拿不到就等于"登录成功但界面不知道拿哪个菜单"（前端 `load()` 靠它填 `S.menuKeys`）。
     * 这不放进 `deviceMayReach`：那张表是手机的边界，动它等于改 device 的行为（§三 第一条）。
     */
    if (method === 'GET' && pathname === '/api/me') return 'allow';
    /*
     * **改自己的密码**（2026-10-31「我的」页）：任何登录账号都该能改自己的密码，
     * 不该要求"先当上管理员"。普通账号对 /api/users/* 仍是 403 —— 这里只开"改自己"这一条，
     * 而且它只认会话里那个 userId（路由层不从 body 里拿 id），想借它改别人没有入口。
     */
    if (method === 'POST' && pathname === '/api/me/password') return 'allow';
    // 动态验证的自助管理（状态 / 绑定 / 确认 / 解绑）—— 同一条"改自己"的口径
    if (pathname.startsWith('/api/me/otp')) return 'allow';
    /*
     * **分机的本机状态页**（2026-10-31 分机也要登录）：renderNodeMode 还要机器名/版本
     * （/api/runtimes）与本机加入状态（/api/local/status）。后者放得安心 —— 它的 handler
     * 自带**回环来源校验**，局域网里的登录用户照样进不来，等于只对本机屏幕多开了一条。
     */
    if (method === 'GET' && (pathname === '/api/runtimes' || pathname === '/api/local/status')) return 'allow';
    return deviceMayReach(method, pathname) ? 'allow' : 'E4033';
  }

  const scope = who.scope instanceof Set ? who.scope : new Set([store.SCOPE_COMPUTE]);
  if (scope.has(store.SCOPE_COMPUTE) && (nodeMayReach(who.nodeId, method, pathname) || runMayReach(who.nodeId, method, pathname))) {
    return 'allow';
  }
  if (scope.has(store.SCOPE_PANEL)) {
    if (isPanelForbidden(method, pathname)) return 'E4032';
    // 「最近使用」= 真的用了面板（60 秒节流，见 store.touchNodeUsed 的注释）
    store.touchNodeUsed(who.nodeId);
    return 'allow';
  }
  return 'E4031';
}

/**
 * 这次请求的**操作人是谁**（2026-10-31 用户概念落地：消息署名 / 建卡人 / 看"我"是谁）。
 *
 * 三种答案：
 *   · 登录用户 → 他自己（多端各记各的，这是唯一精确的一档）；
 *   · operator（回环 / 共享令牌）→ **第一个用户**（"本机自动登录"：像一台共用电脑，
 *     没人显式登录时活都算机主的）。还没有任何用户 → null，调用方回落到 LOCAL_USER 占位；
 *   · 节点 / 手机设备令牌 → null（机器不是人，不冒充任何人）。
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
 * 2026-10-28 第三刀扩了一条：**登录用户且角色是 admin** 也算。其余角色（哪怕是
 * 内置的「操作员」角色）一律不算 —— 管理动作只认 `admin`，这是任务书 §三 的口径。
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
   * 免令牌的两条：
   *   · 加入：这台机器**还没有令牌**，凭一次性的邀请码进来（邀请码就是它的凭据，见 /api/nodes/join）。
   *   · `GET /api/hello`（2026-10-20）：加入向导"探这个地址"打的就是它。
   *     它**故意不带任何秘密** —— 披露的字段与 UDP 应答完全同源（设计 §5.4）。
   * 这两条必须在令牌检查之前放行，否则新机器永远进不来 / 永远探不到。
   */
  if (req.method === 'POST' && url.pathname === '/api/nodes/join') return true;
  if (req.method === 'GET' && url.pathname === '/api/hello') return true;

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
   * 数字员工的本机 AI 通道（2026-10-23，skills/bandi-avatar）：回环发起的 /api/ai/* 免令牌。
   * 员工跑在 CLI 里，拿不到平台令牌，让技能教它 curl 时无凭据可用 —— 通道自身有
   * 回环来源校验 + CSRF 闸双保险（routes/imageai.mjs），就算 BANDI_HOST=0.0.0.0
   * 强开监听，局域网机器也摸不到。回环判据与 routes/local.mjs 的 isLoopbackRemote 一致。
   */
  if (url.pathname.startsWith('/api/ai/')) {
    const a = String(req.socket?.remoteAddress ?? '').trim().toLowerCase();
    if (a === '::1' || a === 'localhost' || a === '127.0.0.1' || a.startsWith('::ffff:127.') || a.startsWith('127.')) return true;
  }

  if (!auth.required) {
    /*
     * 回环形态（桌面版 / 单机 / 分机本机）—— 2026-10-31 用户拍板升级：
     * 「不管总机还是分机，都要用用户来登录」。落成两条，**API 与面板分开**：
     *
     * · **API 仍是回环信任**：本机脚本 / 冒烟 / CLI 不带凭据照旧 = operator（一个字节没变，
     *   任务书 §三 那条硬约束继续成立）；但**带着有效登录会话的浏览器按登录人算**
     *   （kind:'user'）—— 消息署名、菜单收敛都精确到人。退出登录之后回 operator。
     * · **面板要登录**：已经建过账号而这双手上没有会话票的浏览器，抓 HTML 一律给**登录页**
     *   （账号磁贴，免密账号点了就进）—— 跟电脑开机先选账户一个意思。
     *   还没建过账号 = 首次开机：放行进面板，由首次引导建第一个账号。
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
    if (req.method === 'GET' && !url.pathname.startsWith('/api/') && store.hasUsers()) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      // 回环 = 这台机器自己的屏幕，摆账号磁贴不泄密（局域网那边的登录页仍是"用户名+密码"表单）；
      // 禁用的账号不摆 —— 摆上去也登不进，白给人一个"点不动"的磁贴
      res.end(loginPage({ wrong: false, hasUsers: true, loopback: true, users: store.listUsers().filter((u) => !u.disabled) }));
      return false;
    }
    return true;
  }

  const got = tokenOf(req, url);
  let who = identify(auth, got);

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
            ? '让管理员在「设置 → 用户」里把角色改成「管理员」，或直接在那台机器上用班底（本机免登录、等同操作员）。'
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
    req.bandiAuth = who; // 下游（比如"忘掉"、员工编辑的字段闸）据此知道这枚令牌是谁
    return true;
  }

  const wantsHtml = req.method === 'GET' && !url.pathname.startsWith('/api/');
  if (wantsHtml) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(loginPage({ wrong: !!got, hasUsers: store.hasUsers() }));
    return false;
  }

  res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(
    JSON.stringify({
      error: '需要访问令牌（这个控制面没有监听回环地址）',
      code: 'E4010',
      platform: 'bandi',
      hint: '带 X-Bandi-Token 头，或浏览器打开首页在表单里填。令牌在数据目录的 token 文件里。',
    }),
  );
  return false;
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
 * 给"原地重启"用：开关打开之后鉴权会生效，浏览器手上得先有 Cookie，
 * 否则它自己那个窗口会被自己的登录页挡在外面 ✗（见 server.mjs 的 /api/restart）。
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
 * 登录页（2026-10-28 第三刀建；2026-10-31 用户概念两轮改造）。
 *
 * 五态，别混：
 *   · `hasUsers === false` —— **创建账号**（账号密码直建，第一个自动成为管理员）。
 *     公网服务器上"先令牌后建号"走不通（人不在那台机器旁边）；代价是"谁先到谁占管理员"。
 *     令牌入口仍收在 `<details>` 里（部署/运维的后路不变）。
 *   · `loopback && hasUsers` —— **账号磁贴**（回环 = 这台机器自己的屏幕，摆名单不泄密）：
 *     免密账号点一下就进；设了密码的点了出密码框。电脑开机选账户同款。
 *   · 有用户（非回环）—— 用户名 + 密码主表单（免密账号密码留空直接登录）。
 *     ⚠️ 非回环**不摆磁贴**：那等于把账号名单送给局域网里每一个人。
 *   · 开了动态验证的账号（2026-10-31 二改，仿 yaojian-ruoyi）：密码过了服务端回
 *     `{needOtp:true, otpToken}`，页面**整屏切到第二段**（一个输入框，动态码或恢复码都行，
 *     带「返回上一步」）；凭据 5 分钟、5 次。
 *   · `wrong` —— 令牌填错了（沿用老提示）。
 *
 * 为什么表单靠 inline script 提交而不是原生 `<form method=POST>`：`guardWrite` 要求
 * 写请求带 `X-Bandi: 1` 头，原生表单提交设不了头，必然被 CSRF 闸挡成 403（自己试过）。
 * 所以走 fetch，并把「码 + 中文」原样显示出来 —— 与全站错误口径一致。
 */
function loginPage({ wrong, hasUsers, loopback = false, users = null }) {
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
    <input id="pw" name="password" type="password" placeholder="密码" autofocus autocomplete="current-password" />
    <button type="submit">进入</button>
  </form>
</div>`
      : `
<p class="bad" id="err" hidden></p>
<form id="pwForm" autocomplete="on">
  <input id="nm" name="username" placeholder="用户名" autofocus autocomplete="username" spellcheck="false" />
  <input id="pw" name="password" type="password" placeholder="密码（未设密码就留空）" autocomplete="current-password" />
  <button type="submit">登录</button>
</form>`)
    : `
<p class="bad" id="err" hidden></p>
<form id="signForm" autocomplete="on">
  <input id="nm" placeholder="用户名" autofocus autocomplete="username" spellcheck="false" />
  <input id="pw" type="password" placeholder="密码（可留空 = 免密）" autocomplete="new-password" />
  <input id="pw2" type="password" placeholder="再输一遍密码" autocomplete="new-password" />
  <button type="submit">创建并进入</button>
</form>`;

  /*
   * 两段式登录的第二段（2026-10-31 二改，仿 yaojian-ruoyi）：第一段密码过了、账号又开了
   * 动态验证，卡片整块切到这里 —— 一个输入框同时收 6 位动态码和 8 位恢复码
   * （手机丢了用恢复码），凭据 5 分钟 / 5 次。带「返回上一步」：记错密码/换账号时不用刷新。
   */
  /*
   * 两段式登录的第二段（2026-10-31 三改，仿 yaojian-ruoyi 的布局）：**替换整个卡片内容**，
   * 不是在密码表单下面续一段 —— 两套输入框 + 两个按钮叠在一起，人会不知道自己在哪个步骤。
   * 它的版式就是参考项目那一屏：锁图标 + 标题 + 一行说明 + 一个输入框 + 一个按钮 + 返回链接。
   */
  const otpStepHtml = `
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
    <input id="otpCode" inputmode="numeric" maxlength="8" autocomplete="one-time-code"
           placeholder="动态验证码 / 恢复码" autofocus spellcheck="false" />
    <button type="submit">验证</button>
  </form>
  <p class="hint"><a href="#" id="otpBack">返回重新登录</a></p>
</div>`;

  /*
   * 页面骨架（2026-10-31 重设计）：**居中一张卡片**，Logo + 产品名 + 一句话，下面才是表单。
   * 旧版是贴在左上角的一列输入框，屏幕上大片空白、也看不出这是什么产品。
   * 深色/浅色跟随系统（prefers-color-scheme）—— 班底本身有主题切换，登录页没登录读不到用户偏好，
   * 跟系统走是唯一合理的默认。
   */
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>班底 · ${hasUsers ? '登录' : '创建账号'}</title>
<style>
  :root {
    --bg: #0e1014;
    --glow: rgba(59,110,245,.16);
    --card: #171a20;
    --line: #262b33;
    --text: #e8eaed;
    --dim: #8b93a1;
    --input: #10131a;
    --accent: #3b6ef5;
    --accent-hi: #4f7dfa;
    --bad: #ff8a80;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f3f5fa; --glow: rgba(59,110,245,.10);
      --card: #ffffff; --line: #e4e8f0; --text: #1b1f27; --dim: #6b7280;
      --input: #f7f9fc; --bad: #d93025;
    }
  }
  * { box-sizing: border-box; }
  /*
   * ⚠️ 必须显式兜住 [hidden]（2026-10-31 实报「两个登录框叠在一起」）：
   * UA 的 [hidden]{display:none} 优先级最低，下面 #pwForm{display:flex} 这种 ID 选择器
   * 会把它盖掉 —— 于是"隐藏"的表单照样显示。加 !important 一劳永逸。
   */
  [hidden] { display: none !important; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 18px;
    background: radial-gradient(1100px 560px at 50% -12%, var(--glow), transparent 62%), var(--bg);
    color: var(--text);
    font: 14px/1.6 system-ui, -apple-system, 'Segoe UI', 'Noto Sans SC', 'Microsoft YaHei', sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width: min(392px, 100%);
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 18px;
    padding: 30px 30px 24px;
    box-shadow: 0 24px 60px -22px rgba(0,0,0,.5), 0 2px 10px rgba(0,0,0,.06);
  }
  .brand { display: flex; align-items: center; gap: 13px; margin-bottom: 26px; }
  .logo {
    width: 46px; height: 46px; border-radius: 13px; flex: none; display: grid; place-items: center;
    background: linear-gradient(145deg, #3b6ef5, #6f8cff);
    box-shadow: 0 10px 22px -10px rgba(59,110,245,.8);
  }
  .logo svg { width: 26px; height: 26px; display: block; }
  /* 第二段的锁标（与产品标同尺寸同位，切换时不跳动） */
  .logo.lock { background: linear-gradient(145deg, #2f5ad6, #5b84f7); }
  .logo.lock svg { width: 24px; height: 24px; }
  h1 { font-size: 19px; margin: 0; letter-spacing: .3px; }
  .tag { margin: 2px 0 0; font-size: 12.5px; color: var(--dim); }
  form { margin: 0; }
  #pwForm, #signForm, #otpForm { display: flex; flex-direction: column; gap: 10px; }
  input {
    width: 100%; height: 44px; padding: 0 13px;
    border-radius: 11px; border: 1px solid var(--line);
    background: var(--input); color: var(--text); font: inherit;
    transition: border-color .15s, box-shadow .15s;
  }
  input::placeholder { color: var(--dim); }
  input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(59,110,245,.18); }
  button {
    height: 44px; border-radius: 11px; border: 0; background: var(--accent);
    color: #fff; font: inherit; font-weight: 600; letter-spacing: .4px; cursor: pointer;
    transition: background .15s, transform .05s;
  }
  button:hover { background: var(--accent-hi); }
  button:active { transform: translateY(1px); }
  button[disabled] { opacity: .55; cursor: default; }
  .bad { color: var(--bad); font-size: 12.5px; margin: 0 0 12px; }
  .hint { margin: 14px 0 0; font-size: 12.5px; color: var(--dim); text-align: center; }
  .hint a { color: var(--accent); text-decoration: none; }
  /* 账号磁贴（回环登录页）：电脑开机选账户的版式，放进卡片里当网格 */
  #tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(86px, 1fr)); gap: 10px; margin-bottom: 4px; }
  .tile {
    height: auto; padding: 14px 6px 10px; display: flex; flex-direction: column; align-items: center; gap: 8px;
    background: var(--input); color: var(--text); border: 1px solid var(--line); font-weight: 400;
  }
  .tile:hover { background: var(--input); border-color: var(--accent); }
  .tile-ava { width: 40px; height: 40px; border-radius: 50%; background: var(--accent); color: #fff;
              font-size: 17px; font-weight: 600; line-height: 40px; text-align: center; }
  .tile-name { font-size: 12.5px; }
  .tile-who { margin: 0 0 12px; font-size: 13px; color: var(--dim); }
  .foot { margin-top: 22px; padding-top: 14px; border-top: 1px solid var(--line);
          display: flex; justify-content: space-between; font-size: 11.5px; color: var(--dim); }
</style>
</head>
<body>
  <main class="card">
    <div id="loginPane">
      <header class="brand">
        <div class="logo">
          <svg viewBox="0 0 512 512" aria-hidden="true">
            <defs>
              <mask id="b-hole">
                <rect width="512" height="512" fill="#fff"/>
                <ellipse cx="268" cy="206" rx="36" ry="29" fill="#000"/>
                <ellipse cx="274" cy="340" rx="40" ry="31" fill="#000"/>
              </mask>
            </defs>
            <g mask="url(#b-hole)" fill="#fff">
              <rect x="154" y="138" width="72" height="236" rx="34"/>
              <path d="M194,156 C272,142 338,168 338,208 C338,248 288,268 194,264 Z"/>
              <path d="M194,282 C284,276 348,306 348,340 C348,372 288,388 194,382 Z"/>
              <rect x="172" y="336" width="70" height="52" rx="26"/>
            </g>
          </svg>
        </div>
        <div>
          <h1>班底</h1>
          <p class="tag">${hasUsers ? '登录你的账号' : '创建第一个账号 · 它将自动成为管理员'}</p>
        </div>
      </header>
      ${pwForm}
    </div>
    ${otpStepHtml}
    <div class="foot"><span>bandi</span><span>自托管 · 多 agent 协作</span></div>
  </main>
<script>
(() => {
  const err = document.getElementById('err');
  const say = (t) => { if (err) { err.textContent = t; err.hidden = false; } };
  // 第二段有自己的错误区（第一段的 #err 此刻在隐藏的 loginPane 里，写进去没人看得见）
  const otpErrEl = document.getElementById('otpErr');
  const sayOtp = (t) => { if (otpErrEl) { otpErrEl.textContent = t; otpErrEl.hidden = false; } };
  const msg = (j, dflt) => (j ? (j.code ? j.code + '：' + j.error : j.error) : dflt);
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
        headers: { 'Content-Type': 'application/json', 'X-Bandi': '1' },
        body: JSON.stringify({ name, password }),
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
        headers: { 'Content-Type': 'application/json', 'X-Bandi': '1' },
        body: JSON.stringify({ otpToken, code }),
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
        headers: { 'Content-Type': 'application/json', 'X-Bandi': '1' },
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
})();
</script>
</body>
</html>
`;
}
