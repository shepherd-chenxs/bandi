/*
 * routes/pair.mjs —— 手机配对与设备管理路由（2026-11 手机端增量）。
 *
 * 六个端点（docs/mobile/pwa-design.md §3.2）：
 *   POST /api/pair/tokens              操作员发**一次性邀请码**（9 位数字，5 分钟、单次用）
 *   POST /api/pair/claim               **免令牌**（guard 豁免）：手机凭邀请码换长期设备令牌
 *   POST /api/pair/resume              **免令牌**：断开的手机凭 clientKey 连回来（2026-11-01）
 *   GET  /api/pair/me                  任意已登录：我是操作员还是哪台设备
 *   POST /api/pair/leave               手机自己：断开与这台电脑的连接（行留着，能连回来，2026-11-02）
 *   GET  /api/pair/devices             操作员：已配对设备列表
 *   POST /api/pair/devices/:id/disconnect  操作员：断开连接（吊销令牌，**行留着**，能连回来）
 *   POST /api/pair/devices/:id/revoke  操作员：同上（老接口，保留兼容；语义 = 断开）
 *   POST /api/pair/devices/:id/forget  操作员：取消配对（吊销令牌 + 删设备行）
 *   POST /api/pair/devices/:id/role    操作员：给一部手机分配面板角色（2026-10-28 第四刀）
 *   POST /api/pair/enabled             操作员：手机连接总开关（2026-11-02，关 = 断开全部 + 拒绝配对）
 *   （GET /pair 落地页在 server.mjs 的非 /api 分支里，不归本文件管）
 *
 * 错误码用设计分配的 x7xx 子段：E1701/E1702（邀请码缺失/无效或过期）、E1703（试错太频繁）、
 * E1705（另一台手机正在用，连不回来）、E1706（这台手机没配对记录）、E2701（设备不存在）、
 * E2702（leave 只给手机身份，操作员走 devices/:id/disconnect）、
 * E3701（非操作员）、E4701（码已用）。写请求照过 guardWrite（CSRF 闸）——
 * 手机落地页的 fetch 自己带 X-Bandi: 1，别在这条链路上绕过它。
 *
 * 一机一刀（2026-11-01 二刀）：一台电脑同一时间只允许一台手机**在用**。
 * claim 落定时其它手机转「已断开」（不删行）；断开的手机凭 clientKey 走 resume 连回来
 * （有人在用时 409 E1705）；同一台手机（`clientKey`）重配复用同一行。
 */

import { sendJson, fail, readBody } from '../http.mjs';
import { port } from '../config.mjs';
import * as netmode from '../netmode.mjs';
import * as store from '../store.mjs';
import * as auth from '../auth.mjs';
import * as csrf from '../security/csrf.mjs';

/* ---------------------------------------------------------------- 试错闸 */

/*
 * 9 位数字只有 1e9 个，5 分钟窗口里必须挡住字典式穷举 —— 否则"邀请码"比长令牌
 * 弱了 15 个数量级。按来源 IP 数**失败**次数：60 秒内第 13 次起直接 E1703。
 *
 * 三条口径：
 *   · **只数失败** —— 正常用户第一次就过；把手滑三次的人锁在门外一分钟是逗自己玩；
 *   · 成功后不清零，但窗口只有 60 秒，成功的人不会再撞上来；
 *   · 纯内存、重启即清、多进程不共享 —— 它挡的是"局域网里有人扫"，不是配额系统，
 *     别把它当有状态的安全设施（真要挡得住得靠防火墙/WAF）。
 */
const FAIL_WINDOW_MS = 60 * 1000;
const FAIL_MAX = 12;
/** ip → 窗口内的失败时间戳数组 */
const failLog = new Map();

function failKey(req) {
  return String(req.socket?.remoteAddress ?? '?');
}

function tooManyTries(req) {
  const list = failLog.get(failKey(req));
  if (!list || !list.length) return false;
  const since = Date.now() - FAIL_WINDOW_MS;
  while (list.length && list[0] < since) list.shift();
  return list.length >= FAIL_MAX;
}

function noteFail(req) {
  const k = failKey(req);
  const list = failLog.get(k) ?? [];
  list.push(Date.now());
  failLog.set(k, list);
  // 别让这张表跟着端口扫描一起长：超了 500 个来源就清掉全空的旧条目
  if (failLog.size > 500) {
    const since = Date.now() - FAIL_WINDOW_MS;
    for (const [ip, v] of failLog) if (!v.some((t) => t >= since)) failLog.delete(ip);
  }
}

/**
 * 把设备令牌 + CSRF 双提交值种进 Cookie（claim 与 resume 共用，2026-11-01 抽出）。
 * Cookie 名沿用 bandi_token：EventSource 设不了自定义头，设备令牌靠它走 SSE（设计 §1.1）。
 * 与登录响应对齐一并种 CSRF（§10.2）—— 设备凭据在 Cookie 里，写请求要过 E4099 闸。
 */
function setDeviceCookies(res, deviceToken) {
  res.setHeader(
    'Set-Cookie',
    [
      `bandi_token=${encodeURIComponent(deviceToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
      csrf.cookieFor(csrf.mint()),
    ],
  );
}

export async function handlePair(req, res, url) {
  const method = req.method;
  const p = url.pathname;

  /*
   * **手机连接总开关**（2026-11-02，页顶「连接」卡那颗）：
   * 关 = 这台电脑不接受任何手机连接 —— 发码、扫码配对、断线连回来全部拒绝，
   * 且关的那一瞬把所有在用手机一起踢下去（吊销令牌 + 打「已断开」）。
   * 真值存 `netmode.json` 的 `pairEnabled`（重启也保持）；设备行不动，
   * 重开后各台手机凭 clientKey 自己连回来，不用重新扫码。
   */
  const pairOff = () => !netmode.readNetMode().pairEnabled;

  /* -------------------------------------------- 操作员：手机连接总开关 */
  if (method === 'POST' && p === '/api/pair/enabled') {
    // 闸已收编 PDP：pair.enabled = perm:'device:manage'
    const body = await readBody(req);
    const want = body?.enabled === true;
    netmode.writeNetMode({ pairEnabled: want });
    if (!want) {
      const r = store.disconnectAllDevices();
      const codes = store.invalidateAllPairCodes();
      console.log(`[配对] 手机连接已关闭（断开 ${r.disconnected} 台，吊销 ${r.revoked} 枚令牌，作废 ${codes} 个邀请码）`);
    } else {
      console.log('[配对] 手机连接已打开');
    }
    return sendJson(res, 200, { pairEnabled: want });
  }

  /* -------------------------------------------- 操作员：发邀请码 */
  if (method === 'POST' && p === '/api/pair/tokens') {
    // 闸已收编 PDP：pair.tokens = perm:'device:manage'（perm ⇒ noPanel），未授权身份在 guard 层被判（§8.4）
    if (pairOff()) {
      return fail(res, 409, 'E1707', '手机连接已关闭 —— 打开「手机连接」页顶的「连接」开关后再生成邀请码');
    }

    let issued;
    try {
      issued = store.createPairCode();
    } catch (err) {
      // 落库失败（库被锁 / 磁盘满）按设计 §3.2 回配对模块自己的 500 码，别落进顶层 catch 的通用 E5004
      console.error('[配对] E5701 · 邀请码落库失败', err);
      return fail(res, 500, 'E5701', '邀请码生成失败，请重试');
    }
    const { code, expiresAt } = issued;
    /*
     * urls：二维码 / 配对链接的候选地址，**对外地址优先**（2026-11-01 云端）。
     *   · 部署在云端（`BANDI_PUBLIC_URL` 或反代头）→ 只给对外那一个：
     *     局域网 IP 对手机没用，列出来只会让用户点错；
     *   · 部署在局域网（都没配）→ 本机全部 IPv4（192.168 > 10 > 172 排序），
     *     前端拿 urls[0] 画码、其余列出来可复制（多网卡 IP 选取最容易翻车，PRD §5-4）。
     */
    const pub = netmode.publicOrigin(req);
    return sendJson(res, 200, { code, expiresAt, urls: pub ? [pub] : netmode.lanUrls(port) });
  }

  /* -------------------------------------------- 手机：凭邀请码换令牌（免令牌端点） */
  if (method === 'POST' && p === '/api/pair/claim') {
    if (pairOff()) {
      return fail(res, 403, 'E1707', '这台电脑已关闭手机连接 —— 请在电脑上打开「连接」开关后再试');
    }
    if (tooManyTries(req)) {
      return fail(res, 429, 'E1703', '邀请码试错太频繁 —— 等一分钟再试，或者回电脑上重新看一遍码');
    }
    const body = await readBody(req);
    const raw = body?.code ?? body?.token;
    /*
     * 两种凭据都认：
     *   · `code` —— 9 位数字邀请码（2026-11-01 起的正路，手机手输 / 扫码都走它）；
     *   · `token` —— 旧的 `bp_…` 长令牌（已印出去/已存书签的二维码还可能在用）。
     * 格式不对 → E1701；格式对但库里没有/已过期 → E1702；格式对但已被用 → E4701。
     */
    const code = store.normalizePairCode(raw);
    const legacy = String(raw ?? '').trim();
    const secret = code ?? (/^bp_[A-Za-z0-9_-]{10,}$/.test(legacy) ? legacy : null);
    if (!secret) {
      noteFail(req);
      return fail(res, 400, 'E1701', '邀请码是 9 位数字 —— 请看电脑上「设置 → 手机连接」那一串');
    }
    const row = store.getPairToken(secret);
    if (!row) {
      noteFail(req);
      return fail(res, 400, 'E1702', '邀请码无效或已过期 —— 请在电脑上重新生成');
    }
    if (row.usedAt) {
      noteFail(req);
      return fail(res, 409, 'E4701', '邀请码已被使用 —— 一个码只能配一台设备');
    }
    if (row.expiresAt <= new Date().toISOString()) {
      noteFail(req);
      return fail(res, 400, 'E1702', '邀请码已过期（5 分钟）—— 请在电脑上重新生成');
    }
    const name = String(body?.name ?? '').trim().slice(0, 60) || '手机设备';
    /*
     * 时序（设计 §4.1，2026-11-01 二刀改）：
     *   1. 按 `clientKey` 落设备行 —— 同一台手机（localStorage 的随机 ID）复用同一行，
     *      不再长出第二条记录；
     *   2. 原子核销邀请码（usedByDeviceId 记下是谁用的）。失败（并发抢码）就回滚：
     *      新建的行删掉，复用的行原样留着 —— 别把人家的真设备行清了；
     *   3. **顶替**：其它手机一律转成「已断开」（吊销令牌 + 打标记，**不删行**）——
     *      一台电脑同一时间只允许一台手机在用；被断开的那台以后还能凭 clientKey
     *      连回来（`/api/pair/resume`），要彻底清掉是操作员点「取消配对」；
     *   4. 自己名下的旧令牌也清了再发新的（复用行的场景）。
     */
    const { device, reused } = store.createDevice(name, body?.clientKey);
    if (!store.consumePairToken(secret, device.id)) {
      if (!reused) store.forgetDevice(device.id);
      noteFail(req);
      return fail(res, 409, 'E4701', '邀请码已被使用 —— 一个码只能配一台设备');
    }
    store.revokeDeviceTokens(device.id);
    store.markConnected(device.id);
    const others = store.disconnectOtherDevices(device.id);
    if (others.disconnected > 0) console.log(`[配对] 其它 ${others.disconnected} 台手机转为「已断开」（吊销 ${others.revoked} 枚令牌）`);
    const deviceToken = store.issueDeviceToken(device.id);
    // Cookie 名沿用 bandi_token：EventSource 设不了自定义头，设备令牌靠它走 SSE（设计 §1.1）。
    // v2.8：与登录响应对齐，一并种 CSRF 双提交值（§10.2）—— 设备凭据在 Cookie 里，
    // 写请求要过 E4099 闸，没有 csrf 值手机落地页的写操作全会被挡。
    setDeviceCookies(res, deviceToken);
    console.log(`[配对] 手机「${device.name}」已配对（${device.id}${reused ? '，同一台手机复用原记录' : ''}）`);
    return sendJson(res, 200, { ok: true, deviceId: device.id, name: device.name });
  }

  /* -------------------------------------------- 手机：连回来（免令牌端点） */
  /**
   * `POST /api/pair/resume { clientKey }`（2026-11-01 二刀）。
   *
   * "断开连接"之后那台手机怎么回到工作台：凭 localStorage 里的 clientKey 换一张新令牌，
   * **不需要重新扫码**。三条规则（store/resumeDevice）：
   *   · 自己在用 → 换新令牌（顺手续期，等于"健康检查"）；
   *   · 自己已断开、没有别的手机在用 → 恢复，清掉「已断开」标记；
   *   · 自己已断开、**别的手机正在用** → 409 `E1705`（一台电脑同时只允许一台手机）。
   *
   * 免令牌（guard 豁免，与 claim 同一模式）：clientKey 就是这台手机的凭据。
   * 它不是强凭据，但它只在那一台手机的 localStorage 里，等于一张"记住我"的票。
   */
  if (method === 'POST' && p === '/api/pair/resume') {
    if (pairOff()) {
      return fail(res, 403, 'E1707', '这台电脑已关闭手机连接 —— 请在电脑上打开「连接」开关后再试');
    }
    const body = await readBody(req);
    const device = store.findDeviceByClientKey(body?.clientKey);
    if (!device) {
      // 没有这台手机的记录 = 没配过对，或者已经被「取消配对」删掉了 → 只能重新扫码
      return fail(res, 404, 'E1706', '这台手机还没配对过 —— 请扫电脑上的二维码，或填 9 位邀请码');
    }
    const r = store.resumeDevice(device.id);
    if (!r.ok) {
      if (r.reason === 'busy') {
        return fail(res, 409, 'E1705', `另一台手机「${r.busyName || '手机'}」正在使用这台电脑 —— 先在电脑上把它断开，这台就能连回来`);
      }
      return fail(res, 404, 'E1706', '这台手机的配对记录没了 —— 请重新扫码');
    }
    setDeviceCookies(res, r.token);
    console.log(`[配对] 手机「${r.device.name}」连回来了（${r.device.id}）`);
    return sendJson(res, 200, { ok: true, deviceId: r.device.id, name: r.device.name });
  }

  /* -------------------------------------------- 任意已登录：我是谁 */
  if (method === 'GET' && p === '/api/pair/me') {
    const a = req.bandiAuth;
    if (a?.kind === 'device') {
      const d = store.getDevice(a.deviceId);
      return sendJson(res, 200, { kind: 'device', device: d ? { id: d.id, name: d.name, pairedAt: d.pairedAt } : null });
    }
    /*
     * 登录用户（2026-10-28 第三刀）：**必须单独认出来**。
     * 这一句原来只有 device / operator 两种结果 —— 一个普通村民登录后问"我是谁"，
     * 会被回成 `operator`（"我是这台机器的操作员"），谁拿它判权限谁就错了。
     * 本刀前端已统一改用 `/api/me`，这里补上是给旧调用方兜底。
     */
    if (a?.kind === 'user') {
      const u = store.getUser(a.userId);
      return sendJson(res, 200, { kind: 'user', user: u ? { id: u.id, name: u.name } : null, roleId: a.roleId });
    }
    // operator（含回环免鉴权形态标出来的 operator）
    return sendJson(res, 200, { kind: 'operator' });
  }

  /* -------------------------------------------- 手机自己：断开与这台电脑的连接 */
  /**
   * `POST /api/pair/leave`（2026-11-02 用户："手机端连接之后需要一个入口能够断开连接"）。
   *
   * 语义与操作员那两条**完全同源**，只是发起人换成了手机自己：
   *   · 这个口 = 断开（`disconnectDevice`：收钥匙 + 打「已断开」，行和 clientKey 都留着）——
   *     手机下次打开 App 点「连接」就能回来（`/api/pair/resume`），不用重新扫码；
   *   · 不提供"取消配对"给手机：删记录的权力留在电脑上（手机丢了才走那条）。
   *
   * 只认 device 身份（`auth:'session', device:true`）：操作员/登录账号走
   * `/api/pair/devices/:id/disconnect`，别让它替某台手机"自己断开"。
   */
  if (method === 'POST' && p === '/api/pair/leave') {
    const a = req.bandiAuth;
    if (a?.kind !== 'device' || !a.deviceId) {
      return fail(res, 403, 'E2702', '这个接口只给配对过的手机用');
    }
    if (!store.getDevice(a.deviceId)) return fail(res, 404, 'E2701', '没有这台设备');
    const r = store.disconnectDevice(a.deviceId);
    console.log(`[配对] 手机自己断开 ${a.deviceId}（吊销 ${r.revoked} 枚令牌，记录留着）`);
    return sendJson(res, 200, { ok: true, revoked: r.revoked });
  }

  /* -------------------------------------------- 操作员：设备管理 */
  if (method === 'GET' && p === '/api/pair/devices') {
    // 闸已收编 PDP：pair.devices = perm:'device:read'

    return sendJson(res, 200, { devices: store.listDevices() });
  }

  /* -------------------------------------------- 操作员：断开连接（行保留） */
  /**
   * `POST /api/pair/devices/:id/disconnect`（2026-11-01 二刀）。
   *
   * **断开连接 ≠ 取消配对**（用户定稿）：
   *   · 断开 = 收走钥匙 + 打上「已断开」标记，**设备行和 clientKey 都留着** ——
   *     这台手机让出"在用"的位置（可能要用另一台手机连），等没人连的时候
   *     它自己打开 App 就能连回来（`POST /api/pair/resume`），不用重新扫码；
   *   · 取消配对 = `forget`，删行，下次必须重新扫码 / 填邀请码。
   */
  const disconnect1 = /^\/api\/pair\/devices\/([^/]+)\/disconnect$/.exec(p);
  if (method === 'POST' && disconnect1) {
    // 闸已收编 PDP：pair.device.disconnect = perm:'device:manage'
    const id = decodeURIComponent(disconnect1[1]);
    if (!store.getDevice(id)) return fail(res, 404, 'E2701', '没有这台设备');
    const r = store.disconnectDevice(id);
    console.log(`[配对] 断开设备 ${id}（吊销 ${r.revoked} 枚令牌，记录留着）`);
    return sendJson(res, 200, { ok: true, revoked: r.revoked });
  }

  const revoke = /^\/api\/pair\/devices\/([^/]+)\/revoke$/.exec(p);
  if (method === 'POST' && revoke) {
    // 闸已收编 PDP：pair.device.revoke = perm:'device:manage'

    const id = decodeURIComponent(revoke[1]);
    if (!store.getDevice(id)) return fail(res, 404, 'E2701', '没有这台设备');
    const n = store.revokeDeviceTokens(id);
    console.log(`[配对] 踢出设备 ${id}（吊销 ${n} 枚令牌）`);
    return sendJson(res, 200, { ok: true, revoked: n });
  }

  /* -------------------------------------------- 操作员：取消配对（删设备行） */
  /**
   * `POST /api/pair/devices/:id/forget`（2026-11-01）。
   *
   * 与 revoke 的分界：踢出只收钥匙、行留着当记录；这个是蓝牙式"取消配对" ——
   * 吊销令牌 + 删设备行，列表里从此没有它。前端对已踢出（令牌数为 0）的行
   * 显示「取消配对」，点击直接调这里，不走确认（删掉的只是本机留的一行记录）。
   */
  const forget = /^\/api\/pair\/devices\/([^/]+)\/forget$/.exec(p);
  if (method === 'POST' && forget) {
    // 闸已收编 PDP：pair.device.forget = perm:'device:manage'

    const id = decodeURIComponent(forget[1]);
    if (!store.getDevice(id)) return fail(res, 404, 'E2701', '没有这台设备');
    const r = store.unpairDevice(id);
    console.log(`[配对] 取消配对 ${id}（吊销 ${r.revoked} 枚令牌，设备行已删）`);
    return sendJson(res, 200, { ok: true, revoked: r.revoked });
  }

  /* -------------------------------------------- 操作员：给手机分配面板角色 */
  /**
   * `POST /api/pair/devices/:id/role {roleId|null}`（2026-10-28 第四刀）。
   *
   * 与节点那条同构：只存总机侧一行，**下发发生在设备的下一次请求**（手机每次打开都问
   * `/api/me`，那里带 `role.menuKeys`）。所以这里同样只说"存好了"。
   * `roleId: null / ''` = 恢复默认（`mobile`：手机底部那四个 tab）。
   */
  const roleOf = /^\/api\/pair\/devices\/([^/]+)\/role$/.exec(p);
  if (method === 'POST' && roleOf) {
    // 闸已收编 PDP：pair.device.role = perm:'device:manage'

    const id = decodeURIComponent(roleOf[1]);
    if (!store.getDevice(id)) return fail(res, 404, 'E2701', '没有这台设备');
    const body = await readBody(req);
    const want = body?.roleId === undefined || body?.roleId === null ? '' : String(body.roleId).trim();
    if (want && !store.getRole(want)) return fail(res, 400, 'E2072', `没有这个角色：${want}`);
    const next = store.setDeviceRole(id, want || null);
    console.log(`[配对] 手机 ${id} 的面板角色改成 ${want || `默认（${store.DEFAULT_PHONE_ROLE}）`}`);
    return sendJson(res, 200, { deviceId: id, roleId: next?.roleId ?? null, role: store.roleOrDefault(next?.roleId, store.DEFAULT_PHONE_ROLE) });
  }

  return false;
}
