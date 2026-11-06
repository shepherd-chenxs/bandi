/*
 * routes/hub.mjs —— `GET /hub/enter?ticket=…`：手机从身份中枢点进来时**唯一**的入口。
 *
 * 为什么是 GET 一个带票的地址：手机壳（Tauri）里没有"浏览器登录"这一步，它能做的
 * 就是打开一个 URL。所以票走查询参数、主机当场验、验完立刻 302 到 `/` —— 票不会
 * 留在页面上，也不会被页面里的任何脚本读到（票进浏览器历史是已知代价，靠
 * 「一次性 + 5 分钟」对冲，见 bandi-hub/contract.md §六）。
 *
 * 这一步做三件事，顺序不能换：
 *   1. **验票**（hub/verify.mjs）：签名、aud/iss、过期、dev 是不是这台机器、jti 没重放；
 *   2. **查本地授权表**（store/hubLinks.mjs）：这台机器认不认识这个中枢账号；
 *   3. **发本机会话**（与用户名密码登录**同一套** `bandi_sid`）—— 不另造权限模型。
 *
 * 第 2 步是这套设计的安全底座：中枢被攻破、私钥泄露，攻击者能伪造任意账号的票，
 * 但伪造出来的 sub 不在这张表里，最多撞出一行「这台机器还没确认这个账号」。
 *
 * 错误一律给**一张小页面**（不是 JSON）：打开这个地址的是手机 WebView，JSON 在
 * 那里就是一屏看不懂的字。页面只印错误码与一句中文，不回显票内容。
 */

import * as store from '../store.mjs';
import * as auth from '../auth.mjs';
import { readHubConfig, writeHubConfig } from '../hub/config.mjs';
import { VERIFY_ERRORS, verifyTicket } from '../hub/verify.mjs';

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 * @param {{ dataDir: string }} deps
 * @returns {Promise<boolean>} 处理了就 true
 */
export async function handleHub(req, res, url, { dataDir }) {
  /*
   * **桌面端的「用中枢登录」**（2026-11-06）。
   *
   * 桌面 App 打开的是本机面板，登录页不再让人挑本机账号，而是直接把浏览器送到中枢；
   * 中枢认完人、签一张票，再 302 回 `/hub/enter` —— 走的和手机是同一条路，主机这边
   * 只有一个入口要维护（第 3 步之后完全一样）。
   *
   * `return` 带自己的 origin：桌面端是 `http://127.0.0.1:18787`。中枢只接受「这台设备
   * 上报过的地址」或「本机回环 + 同一端口」，所以这张票不会被引到别人域名上。
   */
  if (url.pathname === '/hub/login') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET', 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('只用 GET');
      return true;
    }
    const joined = readHubConfig(dataDir);
    if (!joined) {
      return errorPage(
        res,
        400,
        'E7001',
        '这台机器还没加入中枢',
        '先在主机上跑一次：bandi hub join <中枢地址>',
        { href: '/', label: '改用本机账号登录' },
      );
    }
    const origin = `http://${req.headers.host || '127.0.0.1'}`;
    const target =
      `${joined.baseUrl}/v1/devices/${encodeURIComponent(joined.deviceId)}/enter` +
      `?return=${encodeURIComponent(origin)}`;
    res.writeHead(302, {
      Location: target,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    });
    res.end();
    return true;
  }

  if (url.pathname !== '/hub/enter') return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    // 票只在地址里出现一次，没有"提交"这回事
    res.writeHead(405, { Allow: 'GET', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('只用 GET');
    return true;
  }

  const cfg = readHubConfig(dataDir);
  if (!cfg) {
    return errorPage(res, 400, 'E7001', '这台机器还没加入中枢', '在主机上跑一次：bandi hub join <中枢地址>');
  }

  const ticket = url.searchParams.get('ticket');
  if (!ticket) {
    return errorPage(res, 400, 'E7002', '这个地址少了连接凭据', '从手机设备列表里重新点一次这台机器');
  }

  const v = verifyTicket(ticket, cfg.publicKey, { deviceId: cfg.deviceId });
  if (!v.ok) {
    const e = VERIFY_ERRORS[v.reason] ?? { code: 'E7001', message: '连接凭据无效' };
    const status = v.reason === 'expired' || v.reason === 'replayed' ? 410 : 400;
    return errorPage(res, status, e.code, e.message, '回到设备列表，重新点一次这台机器');
  }

  const accountId = String(v.payload.sub);
  /*
   * 本地授权表：中枢只说了"他是谁"，这里才回答"他能不能进这台机器"。
   *
   * 「首次认领」只在**表还是空的时候**成立一次：那是机器主人自己跑 `bandi hub join`
   * 刚批准完的那一下 —— 人就在机器跟前。之后任何新账号都要在这台机器上显式放行
   * （`bandi hub allow <账号 id>`），否则中枢侧的账号再多也进不来。
   */
  let link = store.hubLinkOf(accountId);
  if (!link && cfg.claimPending && store.countHubLinks() === 0) {
    const owner = store.firstUser();
    if (owner) {
      link = store.linkHubAccount({ accountId, userId: owner.id });
      // 认领一次就完事：改回 false，别让"空表"这条路一直敞着
      try {
        writeHubConfig(dataDir, { ...cfg, claimPending: false });
      } catch { /* 写不进去也不影响这次进门，下次还会走到同一个分支 */ }
    }
  }

  if (!link) {
    return errorPage(
      res,
      403,
      'E7003',
      '这台机器还没确认这个账号',
      `在主机上跑一次：bandi hub allow ${accountId}`,
    );
  }

  const user = store.getUser(link.userId);
  if (!user || user.disabled) {
    return errorPage(res, 403, 'E7004', '这个账号在这台机器上被停用了', '让这台机器的管理员在「设置 → 用户」里恢复，或换一个账号');
  }

  const { token } = store.createSession(user.id, {
    ip: req.socket?.remoteAddress ?? null,
    ua: req.headers['user-agent'] ?? '',
    // 标记来源：`kind='hub'` 的会话在 auth.guard 里不受「免密账号 = 受限会话」那条限制
    // （中枢票据的证明力不低于本地密码，见 auth.mjs 那段注释）
    kind: 'hub',
  });
  store.touchHubLink(accountId);

  /*
   * 顺手清掉访问令牌 Cookie。guard 的顺序是**令牌优先、会话兜底**（那条不能动：
   * 一个陈旧的会话不该把握着令牌的请求降权），所以浏览器里若还躺着上一次配对的
   * `bd_` 设备令牌，它会压过刚发的会话，用户点进来却看到 403。
   * 清掉只影响这一个源 —— 手机下次走老路扫码配对时会重新种一枚。
   */
  const cookies = [auth.sessionCookie(token)];
  if (String(req.headers.cookie ?? '').includes('bandi_token=')) cookies.push(auth.clearedTokenCookie());

  res.writeHead(302, {
    'Set-Cookie': cookies,
    Location: '/',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  });
  res.end();
  return true;
}

/**
 * 一张只有错误码的小页面。**不印票、不印堆栈、不印地址** —— 手机屏幕就这么大，
 * 能做的动作只有"回去再点一次"，多余的字只会让人以为坏了。
 *
 * `link` 是可选的第二步动作（桌面端"未加入中枢"时给一条回本机账号的路）。
 */
function errorPage(res, status, code, message, hint, link = null) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const html = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>进不来 · ${esc(code)}</title>
<style>
  :root{color-scheme:light dark}
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:32px 22px;
       font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  .box{max-width:420px;text-align:center}
  .code{font:600 13px/1 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.14em;opacity:.55}
  h1{font-size:19px;font-weight:600;margin:14px 0 8px}
  p{opacity:.7;font-size:14px;margin:0}
  a{display:inline-block;margin-top:18px;color:inherit;font-size:13.5px;opacity:.75}
</style></head>
<body><div class="box">
  <div class="code">${esc(code)}</div>
  <h1>${esc(message)}</h1>
  <p>${esc(hint)}</p>
  ${link ? `<a href="${esc(link.href)}">${esc(link.label)}</a>` : ''}
</div></body></html>`;
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(html);
  return true;
}
