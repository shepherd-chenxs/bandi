/**
 * 访问令牌 —— **把控制面放到公网之后的第一道闸**。
 *
 * 规则只有一条，而且看的是**监听地址**、不是请求来源：
 *
 *   · 只监听回环（桌面版 / 单机）→ **免鉴权**。外面根本进不来，加它就是白加，
 *     还会把"单机零配置、不需要 token"这条硬约束毁掉。
 *   · 监听非回环（服务器）→ **所有请求都要令牌**。
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
 * **判定只有一处**（设计 §6.1）。`guard()` 里只调这一个函数，别的什么都不判。
 *
 * 三种令牌携带方式（Cookie / `X-Bandi-Token` / `?token=`）走的**都是这里** ——
 * `tokenOf()` 先统一取出令牌，`identify()` 再统一认出"是谁"。
 * 所以"面板令牌换个 Cookie 就变成操作员"这种事不会发生。
 *
 * 返回 `'allow' | 'E4012' | 'E4031' | 'E4032'`，规则按序：
 *   1. `operator` → 放行；
 *   2. 有 `compute` 且是"节点自己的活"（`nodeMayReach` + `runMayReach`）→ 放行；
 *   3. 有 `panel` 且**不在**禁止清单里 → 放行（并节流记一次"最近使用"）；
 *   4. 有 `panel` 但命中禁止清单 → `E4032`；其余（只有 compute）→ `E4031`。
 *
 * **不缓存**（决策 A 规则 2）：每次请求现算，总机那边改完对下一次请求立即生效。
 */
export function decide(who, method, pathname) {
  if (!who) return 'allow'; // 不该发生：guard 只在 identify 到身份之后才问
  if (who.kind === 'operator') return 'allow';
  if (who.kind === 'revoked') return 'E4012';

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
 * 这次请求是不是**这台机器的操作员**在做（handler 判字段级权限用）。
 *
 * 存在的理由：`PUT /api/personas/:id` 里"body 带 model / runtime"这件事
 * `auth.mjs` 看不见（要 `readBody`），所以那一条必须落在 handler 里，一行判断即可。
 *
 * ⚠️ 回环形态（单机 / 桌面版）下 `guard` 会把身份标成 operator（见下面那段），
 * 否则单机上点「改模型」会被自己的闸挡掉。
 */
export function mayManage(req) {
  return req?.bandiAuth?.kind === 'operator';
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
     * 回环形态（桌面版 / 单机）免鉴权 —— 但**身份要标出来**。
     *
     * 为什么（2026-10-20）：下游用 `mayManage(req)` 判"这次能不能做管理动作"
     * （改 scope、改员工的 model/runtime），而那个函数只看 `req.bandiAuth`。
     * 不标的话，单机上自己点「改模型」会被自己的字段闸挡成 403 `E4032` ✗。
     * 回环 = 就是这台机器的操作员，这与"闸只看监听地址"那条规则是同一个口径。
     */
    req.bandiAuth = { kind: 'operator', via: 'loopback' };
    return true;
  }

  const got = tokenOf(req, url);
  const who = identify(auth, got);
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
    res.end(loginPage({ wrong: !!got }));
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

function loginPage({ wrong }) {
  return `<!doctype html>
<meta charset="utf-8" />
<title>班底 · 需要访问令牌</title>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
  body { font: 14px/1.8 system-ui,-apple-system,'Segoe UI',sans-serif; margin: 0; padding: 44px;
         background: #1b1d21; color: #e7e7e7; }
  h1 { font-size: 19px; margin: 0 0 8px; }
  p { color: #9aa0a6; margin: 0 0 18px; }
  form { display: flex; gap: 8px; max-width: 420px; }
  input { flex: 1; padding: 9px 11px; border-radius: 7px; border: 1px solid #3a3f45;
          background: #24272c; color: #e7e7e7; font: inherit; }
  button { padding: 9px 16px; border-radius: 7px; border: 0; background: #3b6ef5; color: #fff;
           font: inherit; cursor: pointer; }
  .bad { color: #ff8a80; margin: 0 0 14px; }
  code { background: #24272c; padding: 1px 5px; border-radius: 4px; }
  .hint { margin-top: 20px; font-size: 12.5px; color: #7c8288; }
</style>
<h1>班底</h1>
<p>这个控制面没有监听回环地址，所以每个请求都要访问令牌。</p>
${wrong ? '<p class="bad">令牌不对，再试一次。</p>' : ''}
<form method="GET" action="/">
  <input name="token" placeholder="访问令牌" autofocus autocomplete="off" spellcheck="false" />
  <button>进入</button>
</form>
<p class="hint">
  令牌在控制面数据目录的 <code>token</code> 文件里（那台机器上：<code>type &lt;数据目录&gt;\token</code>
  或 <code>cat &lt;数据目录&gt;/token</code>）。
  <!--
    ⚠️ 这里原来还跟着一句"启动日志也会打出来一次" —— 2026-10-16 已经**不打了** ✓（日志会被贴、被备份，
    而那枚令牌等于整套控制权）。这句话留着就是把人往错地方指 ✗，所以删掉 ✓。
  -->
  填对之后会记在 Cookie 里，不用每次填。
</p>
<!--
  P1-6（2026-10-20）：瘦客户端那条路走的是**反代**（本机 127.0.0.1:端口 上那台服务），
  目标是"浏览器直连总机地址"—— 那样既进不去（没有令牌），也解释不清为什么。
  这一句就是给那个人看的：双击班底，不要在这个地址上折腾。
-->
<p class="hint">这台机器如果已经加入过某台班底，请<strong>双击班底</strong>打开，不要用浏览器直接开这个地址。</p>
`;
}
