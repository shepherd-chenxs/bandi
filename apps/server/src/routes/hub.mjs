/*
 * routes/hub.mjs —— 主机这边与中枢有关的两件事，都只有**一个入口**：
 *
 *   · `POST /hub/login`  —— 本机登录页上的账号密码，转给中枢认人（新，2026-11-07）
 *   · `GET  /hub/enter`  —— 手机上从名册点进来时带票进门（2026-11-06）
 *
 * 两条最后都落到同一件事上：**发一张本机会话**（`bandi_sid`），不另造权限模型。
 * 区别只在"凭据从哪来"：一个来自用户刚输入的密码，一个来自中枢签的票。
 *
 * `GET /hub/enter` 这一步做三件事，顺序不能换：
 *   1. **验票**（hub/verify.mjs）：签名、aud/iss、过期、dev 是不是这台机器、jti 没重放；
 *   2. **绑影子账号**（bindHubAccount）：中枢账号在本机落一个本地用户（首次自动建）；
 *   3. **发本机会话**（与用户名密码登录**同一套** `bandi_sid`）—— 不另造权限模型。
 *
 * 错误一律给**一张小页面**（不是 JSON）：打开这个地址的是手机 WebView，JSON 在
 * 那里就是一屏看不懂的字。页面只印错误码与一句中文，不回显票内容。
 */

import * as store from '../store.mjs';
import * as auth from '../auth.mjs';
import * as csrf from '../security/csrf.mjs';
import { readHubConfig } from '../hub/config.mjs';
import { loginThroughHub } from '../hub/login.mjs';
import { HubError } from '../hub/client.mjs';
import { VERIFY_ERRORS, verifyTicket } from '../hub/verify.mjs';
import { poke as pokeHeartbeat } from '../hub/join.mjs';

/*
 * 中枢账号 → 本机影子账号（2026-11-07 三改：**登录即放行**）。
 *
 * 口径沿革：§二十五「认领只此一次 + `bandi hub allow` 放行」是协作时代的第二道闸，
 * 与 §二十六 定下的「能过中枢登录这一关，本机就不再有第二道分级」自相矛盾；
 * 用户实报一锤定音：「用户不会给你执行这个命令」—— 家里人走到电脑前用自己的
 * 中枢账号登录，被要求在主机上跑命令，这不是产品该有的样子。所以：
 *
 *   · 中枢验过票 / 密码 = 授权完成，本机不再有第二道闸（E7003 与 allow/revoke 退场）；
 *   · 本机还没有任何账号 → 建出来的就是**内置账号**（防锁死锚，E3808 保护不变）；
 *   · 之后的每个中枢账号自动建**自己的**影子账号 —— 署名按人分（actorUser 认本地
 *     userId，全家收敛到一个影子就分不清谁说的了）；
 *   · 影子名取中枢登录名（手机号，全局唯一），撞了已有名字就缀上中枢账号 id。
 *
 * 安全取舍（用户拍板接受）：中枢被攻破 / 签发私钥泄露时，伪造的票不再撞「没认过」
 * 一道，而是直接进门 —— 防换钥匙那道还在（钉公钥不符即 E7113，见 hub/login.mjs）。
 *
 * @param {string} accountId 中枢账号 id（票的 sub / device-login 回的 account.id）
 * @param {string|null} login 中枢登录名（手机号；票里没有时退回账号 id）
 */
function bindHubAccount(accountId, login) {
  const existing = store.hubLinkOf(accountId);
  if (existing) return existing;
  const base = String(login ?? '').trim() || accountId;
  const name = store.hasUsers() && store.nameTaken(base) ? `${base}·${accountId}` : base;
  const user = store.createUser({ name });
  return store.linkHubAccount({ accountId, userId: user.id, login: login ?? null });
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 * @param {{ dataDir: string, port?: number }} deps
 * @returns {Promise<boolean>} 处理了就 true
 */
export async function handleHub(req, res, url, { dataDir, port }) {
  if (url.pathname === '/hub/login') {
    // 老链接（按钮时代留下的书签）：直接回首页，登录页就在那儿
    if (req.method === 'GET' || req.method === 'HEAD') {
      res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
      res.end();
      return true;
    }
    if (req.method === 'POST') return handleLocalLogin(req, res, { dataDir, port });
    res.writeHead(405, { Allow: 'GET, POST', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('只用 GET 或 POST');
    return true;
  }

  /*
   * **壳的会话过期改道点**（2026-11-08）。正常情况下壳在 `shouldOverrideUrlLoading`
   * 里就把它接住了，这个页面根本不会渲染 —— 它不是给人看的入口，是**兜底**：
   * 万一壳没接住（旧壳、拦截没生效），也得让人看到"正在重新连接"而不是登录页。
   *
   * 页面**没有一行脚本**：这条路径的意义就是"什么都别做，等壳来接管"；自动跳转
   * 只会让人在两个页面之间来回弹。文案也不提"登录"—— 用户不该在这里输密码。
   */
  if (url.pathname === '/hub/expired') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET', 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('只用 GET');
      return true;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(`<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>正在重新连接 · 班底</title>
<style>
  :root{color-scheme:light dark}
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:32px 22px;
       font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  .box{max-width:340px;text-align:center;opacity:.75}
  b{display:block;font-size:17px;margin-bottom:8px;opacity:.95}
</style>
</head><body>
  <div class="box">
    <b>正在重新连接…</b>
    <p>这台手机上的会话到期了，正在自动换一张新的。</p>
    <p>如果一直停在这一屏，回到设备列表重新点一次这台电脑。</p>
  </div>
</body></html>`);
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
  if (!cfg?.deviceId || !cfg?.publicKey) {
    return errorPage(res, 400, 'E7001', '这台机器还没在中枢上登录过', '在本机打开首页，用中枢账号登录一次');
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
   * 绑影子账号：登录即放行（2026-11-07 三改，见 bindHubAccount 的口径说明）。
   * 票里现在带 `login` 声明（中枢签票时写入，2026-11-07 起）—— 老票没有就退回
   * 账号 id 当名字，那个人下次在登录页输一次密码就会对齐（名条随中枢对齐那步）。
   */
  const link = bindHubAccount(accountId, v.payload.login ?? null);

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
   * 一个陈旧的会话不该把握着令牌的请求降权），所以浏览器里若还躺着旧版手机配对留下的
   * `bd_` 设备令牌，它会压过刚发的会话，用户点进来却看到 403（甚至认不出是谁）。
   * 设备令牌体系 2026-11-07 已退场，这枚 Cookie 只会是历史遗留 —— 一律清掉。
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
 * 登录页表单：`POST /hub/login`（2026-11-07）。
 *
 * 用户看到的是**本机页面上的一个登录框**，不会跳去别的域名 —— 这一支只是把同一次输入
 * 转给中枢。成功之后中枢会顺手把本机登记进名册，返回票与本机设备身份，这里验票、
 * 落 `hub.json`、发本机会话，然后 302 回首页。
 *
 * 失败一律**回到登录页**（不是一张错误页）：输错密码是常态，人应该站在原地重输，
 * 而不是被丢到一个只有错误码的屏幕上。
 */
async function handleLocalLogin(req, res, { dataDir, port }) {
  /** @type {Record<string,string>} */
  let form = {};
  try {
    const text = await readRaw(req);
    const ct = String(req.headers['content-type'] ?? '');
    if (ct.includes('application/json')) {
      const j = JSON.parse(text || '{}');
      if (j && typeof j === 'object') form = j;
    } else {
      form = parseForm(text);
    }
  } catch {
    form = {};
  }

  const username = String(form.username ?? '').trim();
  const password = String(form.password ?? '');
  // mode 不再有区别（2026-11-07 登录即注册）：中枢按"手机号存不存在"自己决定登录还是创建

  const fail = (message, status = 401) => {
    // 重渲染的登录页带一枚**新** csrf 值（Set-Cookie 与隐藏域成对）：人要能站在原地重试
    const csrfVal = csrf.mint();
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Set-Cookie': csrf.cookieFor(csrfVal),
    });
    res.end(auth.renderHubLoginPage({ error: message, username, csrf: csrfVal }));
    return true;
  };

  /*
   * 同源检查：这是本机页面的表单，正常提交一定带 Origin / Referer。
   * 别的网站没法替你提交一个跨站表单再读结果（读不到），但"能不能提交"本身就该拒 ——
   * 登录请求里带着明文密码，不该有任何一处代码需要容忍它从别处飞来。
   *
   * **Origin: null 的兜底**（2026-11-07 实报 E7006）：桌面壳的 WebView2 表单 POST
   * 有时会带 `Origin: null`（尤其从一次 POST 响应渲染出的页面上再提交时 —— 用户
   * 第一次输错密码拿到 H3004 页，第二次提交就撞上了）。null ≠ 跨站，不能一刀切，
   * 但也不能白白放行（沙箱 iframe 一样发得出 Origin: null，那是真的攻击面）。
   * 所以退到 **CSRF 双提交**：登录页渲染时种下的 `bandi_csrf` Cookie 与表单隐藏域
   * 必须成对 —— 跨站伪造者读不到别域的 Cookie，凑不齐这对值；本机页面怎么都拿得到。
   */
  const origin = String(req.headers.origin ?? '');
  let originOk = false;
  if (origin) {
    try {
      originOk = new URL(origin).host === String(req.headers.host ?? '');
    } catch { originOk = false; }
  }
  if (!originOk) {
    const pair = csrf.valuesOf(req);
    const field = String(form._csrf ?? '');
    // 值是本次页面渲染刚生成、随页面一起发出去的，明文比较即可（不是长寿密钥）
    if (!pair.cookie || !field || pair.cookie !== field) {
      return fail('E7006 来源不对 —— 刷新页面后重试', 403);
    }
  }

  if (!username || !password) return fail('请填写用户名和密码', 400);

  /** @type {any} */
  let out;
  try {
    out = await loginThroughHub({ dataDir, username, password, port });
  } catch (e) {
    if (e instanceof HubError) return fail(`${e.code} ${e.message}`, 401);
    return fail(`E7100 ${e?.message ?? '登录没成功'}`, 500);
  }

  /*
   * 登录即放行（2026-11-07 三改，见文件头 bindHubAccount 的口径说明）：
   * 中枢验过密码 = 授权完成。首个进门的人建内置账号，后来的自动建**自己的**影子。
   */
  const link = bindHubAccount(out.account.id, out.account.login ?? null);
  const user = store.getUser(link.userId);
  if (!user || user.disabled) return fail('E7004 这个账号在这台机器上被停用了', 403);

  /*
   * 本机名条的名字**随中枢对齐**（2026-11-07）：本地账号是老黄历 —— 署名、通讯录成员、
   * 「我的」页显示的名字就是这个中枢账号（手机号）。老库里遗留的旧名字（本地账号时代
   * 建的）在这一次登录后自动消失。幂等：同名就什么都不做。
   */
  const hubName = out.account.login || out.account.id;
  if (user.name !== hubName) store.renameUser(user.id, hubName);

  const { token } = store.createSession(user.id, {
    ip: req.socket?.remoteAddress ?? null,
    ua: req.headers['user-agent'] ?? '',
    kind: 'hub',
  });
  store.touchHubLink(out.account.id);
  // 刚绑上设备身份：立刻报一次心跳，手机上马上就能看到「在线」，不用等下一轮 60 秒
  pokeHeartbeat();

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
 * 读原始请求体（登录表单是 urlencoded，`http.readBody` 只认 JSON）。
 * 64KB 上限：登录表单再大也没有道理，超出就断。
 * @param {import('node:http').IncomingMessage} req
 */
function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * `application/x-www-form-urlencoded` → 对象。
 * （登录页不该有脚本：脚本一挂人就登不进来，所以走浏览器原生表单提交。）
 * @param {string} text
 */
function parseForm(text) {
  const out = {};
  for (const pair of String(text ?? '').split('&')) {
    if (!pair) continue;
    const i = pair.indexOf('=');
    const k = decodeURIComponent((i < 0 ? pair : pair.slice(0, i)).replace(/\+/g, ' '));
    const v = i < 0 ? '' : decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
    out[k] = v;
  }
  return out;
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
