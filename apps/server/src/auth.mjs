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
 * 这枚令牌**是谁的**（2026-10-16 加的）。
 *
 * 原来是"一枚令牌走天下"：节点手上的就是总机那枚 master ✗ —— 一台节点被翻 = 整套被翻，
 * 而且「忘掉」踢不掉它（令牌还有效）。现在分两种身份：
 *   · `operator` —— 总机那枚（浏览器登录、脚本、运维）；
 *   · `node`     —— 每台机器**自己那枚**（邀请码换来的，见 store.issueNodeToken）。
 */
export function identify(auth, token) {
  if (!token) return null;
  if (auth.token && timingSafeEqual(token, auth.token)) return { kind: 'operator' };
  const nodeId = store.nodeByToken(token);
  return nodeId ? { kind: 'node', nodeId } : null;
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
 * 闸。返回 `true` = 放行；`false` = **已经回过响应了**，调用方直接 return。
 *
 * 未授权时给什么，看它要什么：
 *   · 浏览器要页面（非 /api/ 的 GET）→ 一张**登录页**（表单），别丢一个 JSON 401 给它；
 *   · 其余（API、脚本、节点）→ 401 JSON，并把 `platform: 'bandi'` 带上 ——
 *     启动器靠这个字段判"是班底、只是要令牌"，不至于把它误当成"平台没起来"而再起一个。
 */
export function guard(auth, req, res, url) {
  /*
   * 加入：这台机器**还没有令牌**，凭一次性的邀请码进来（邀请码就是它的凭据，见 /api/nodes/join）。
   * 这条必须在令牌检查之前放行，否则新机器永远进不来。
   */
  if (req.method === 'POST' && url.pathname === '/api/nodes/join') return true;

  if (!auth.required) return true;

  const got = tokenOf(req, url);
  const who = identify(auth, got);
  if (who) {
    // 节点令牌的权限边界：只管它自己那台的四条路，别的 403
    if (who.kind === 'node' && !nodeMayReach(who.nodeId, req.method, url.pathname)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(
        JSON.stringify({
          error: '这枚是**节点**令牌，只能干节点自己的事（报到/心跳/领活/回执）',
          code: 'E4030',
          platform: 'bandi',
          hint: '要看设备、对话、员工，请用操作员令牌（总机数据目录 token 文件里那枚）。',
        }),
      );
      return false;
    }
    /*
     * 从地址栏进来的令牌：换成 Cookie 并**重定向掉**，免得它留在历史/Referer 里。
     * ⚠️ 只对**操作员**令牌做这件事：节点令牌要是也能换成 Cookie，就等于把 master 发给了浏览器 ✗
     * （那条是提权，正是这次改动要堵的东西）。
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
    req.bandiAuth = who; // 下游（比如"忘掉"）据此知道这枚令牌是谁
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
`;
}
