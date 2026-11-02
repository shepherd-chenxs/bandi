/* pair-claim.mjs —— 手机连接落地页逻辑（pair.html 专用，不进主应用模块图）。
 *
 * 流程（设计 §4.1）：取 `?code=`（9 位邀请码，2026-11-01 起的主路径）或 `?token=`
 * （旧的 `bp_…` 长令牌，已印出去的二维码还可能在用）→ POST /api/pair/claim
 * （**必须带 X-Bandi: 1**，这里是独立页面，没有主应用 ui.mjs 的 api() 帮忙注入，
 * 只能自己带）→ 成功：localStorage 记一份 deviceId 兜底 → location.replace('/')
 * 带 Cookie 进工作台；失败：一行人话 + 「请在桌面端换一个邀请码」。
 *
 * 为什么只走 Cookie、localStorage 只记 deviceId：长期令牌在 HttpOnly Cookie 里
 * （JS 读不到，XSS 偷不走，设计 §3.2）；localStorage 兜底的是"这台手机配过对、
 * 叫什么"这件事本身，不是令牌 —— 别把能用的凭据放 JS 够得着的地方。
 */

const $ = (id) => document.getElementById(id);

/** 把落地页切成某个状态（校验中 / 成功 / 失败），别用 innerHTML 拼用户输入 —— 这里只有服务端文案 */
function paint(kind, title, sub, code) {
  const box = $('pairState');
  if (!box) return;
  if (kind === 'busy') {
    box.className = '';
    box.innerHTML = '<div class="spin"></div><h1>正在配对…</h1><p>正在向电脑上的班底核验这个邀请码</p>';
    return;
  }
  if (kind === 'ok') {
    box.className = '';
    box.innerHTML = `<h1>✓ 配对成功</h1><p>${escapeHtml(title)}</p>`;
    return;
  }
  box.className = 'state-err';
  box.innerHTML =
    `<h1>配对失败</h1><p>${escapeHtml(title)}</p>` +
    (code ? `<div class="err-code">错误码 ${escapeHtml(code)}</div>` : '') +
    (sub ? `<p style="margin-top:8px">${escapeHtml(sub)}</p>` : '');
}

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * CSRF 双提交的另一半（2026-11-01 补）：bandi_csrf 不是 HttpOnly，JS 读得到。
 * **这台手机以前配对/登录过**的话，jar 里留着旧的 bandi_token —— 那这个 claim
 * POST 就是"带 Cookie 凭据的写请求"，服务端 csrf.check（E4099）要求
 * `X-Bandi-CSRF` 头与 cookie 一致，缺头直接 403（实机踩过：扫码落地页报
 * 「请求缺少有效的 CSRF 凭据 · E4099」）。全新手机没有凭据，服务端不校验，
 * 多带这个头无害。GET /pair 时服务端会自愈补种 csrf cookie（server.mjs
 * 的 wantsHtmlPage 分支），所以页面执行到这里 jar 里一定有值可读。
 */
function csrfValue() {
  for (const part of String(document.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === 'bandi_csrf') {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return part.slice(i + 1).trim();
      }
    }
  }
  return '';
}

/**
 * 这台手机的稳定随机 ID（2026-11-01 一机一刀）。首次生成后一直留在 localStorage，
 * claim 时随 body 上报 —— 服务端拿它认"同一台手机"，重复配对复用同一条设备记录，
 * 不再长出第二条。**不是设备指纹**：清掉 App 数据它就没了，服务端当成一台新手机。
 */
function clientKey() {
  try {
    let k = localStorage.getItem('bandi.clientKey');
    if (!k) {
      k = crypto.randomUUID
        ? crypto.randomUUID().replace(/-/g, '')
        : Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
      localStorage.setItem('bandi.clientKey', k);
    }
    return k;
  } catch {
    return ''; // localStorage 用不了（隐私模式）：服务端按无 clientKey 的老客户端处理
  }
}

/**
 * 从 UA 猜一个设备自报名（claim 的 body.name，PRD P0-3"配对时自报"）。
 * 猜不准没关系 —— 就是个给人看的标签，桌面端设备列表里能对上号即可。
 */
function guessDeviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  const m = /Android[^;)]*;\s*([^;)]+?)\s+Build/i.exec(ua) || /Android[^;)]*;\s*([^;)]+)/i.exec(ua);
  if (m) return `Android · ${m[1].split(/\s+/)[0]}`;
  return '手机设备';
}

/** 换个易读的说法给最常见的几个错（其余直接亮码 + 让人回桌面端重新生成） */
const FRIENDLY = {
  E1701: '邀请码不完整 —— 9 位数字，回电脑上「设置 → 手机连接」再看一眼',
  E1702: '邀请码已过期或无效 —— 在电脑上点「换一个」生成新的',
  E1703: '试错太频繁 —— 等一分钟，或者回电脑上重新看一遍码',
  E1705: '另一台手机正在使用这台电脑 —— 先在电脑上把它「断开连接」，这台就能连回来',
  E1706: '这台手机的配对记录已被取消 —— 请重新扫电脑上的二维码',
  E3001: '电脑上的班底还没允许这台手机动手 —— 去电脑端「模式」页确认已切到总机并点了重启生效',
  E4010: '配对失效了，请在桌面端重新生成邀请码',
  E4099: '手机上留着这台电脑的旧登录凭据 —— 回启动页重新来一次就好',
  E4701: '这个邀请码已经配过一台手机了 —— 一个码只能用一次',
};

/** 配对成功后的统一收尾：记 deviceId、显示成功、进工作台 */
function enterWorkbench(d) {
  try { localStorage.setItem('bandi.pairedDevice', d?.deviceId ?? ''); } catch { /* 存不了就算了 */ }
  paint('ok', '正在进入工作台…');
  // replace：邀请码别留在历史里（同一个码只能用一次，留着也没用，还容易被翻出来）
  location.replace('/');
}

/**
 * 连回来（2026-11-01 二刀）：`?resume=1` 走这条，不消耗邀请码。
 * 凭 localStorage 的 clientKey 换新令牌 —— 手机被电脑端「断开连接」之后，
 * 只要没有别的手机在用，这条路就能让它自己回到工作台，不用重新扫码。
 */
async function resumeAndEnter() {
  const key = clientKey();
  if (!key) {
    paint('err', '这台手机没有配对记录 —— 请扫电脑上的二维码', '', 'E1706');
    return;
  }
  paint('busy');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch('/api/pair/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bandi': '1', 'X-Bandi-CSRF': csrfValue() },
      body: JSON.stringify({ clientKey: key }),
      signal: ctrl.signal,
    });
    const d = await r.json().catch(() => null);
    if (r.ok && d?.ok) return enterWorkbench(d);
    paint('err', FRIENDLY[d?.code] ?? (d?.error || '连不上这台电脑'), '', d?.code ?? String(r.status));
  } catch {
    paint('err', ctrl.signal.aborted ? '等了 8 秒没回应 —— 确认手机和电脑在同一个 WiFi' : '连不上电脑上的班底', '稍后回到扫码页重试', '');
  } finally {
    clearTimeout(timer);
  }
}

async function claimAndEnter() {
  /*
   * 两种凭据：`?code=482913665`（手机手输邀请码，或扫码进来 —— 二维码里带的就是它）
   * 和 `?token=bp_…`（老二维码/书签）。服务端两个都认，这里按内容挑一个发过去。
   */
  const q = new URLSearchParams(location.search);
  /*
   * `?resume=1` = 连回来（2026-11-01 二刀）：不断开、不扫码，凭 clientKey 换新令牌。
   * 手机端 401 急救（mobile.mjs）与启动页「进入」都走这条。
   */
  if (q.get('resume')) return resumeAndEnter();
  const digits = String(q.get('code') ?? '').replace(/\D/g, '');
  const token = String(q.get('token') ?? '').trim();
  const cred = digits.length === 9 ? { code: digits } : token ? { token } : null;
  if (!cred) {
    paint('err', '地址里没有邀请码 —— 请从手机启动页重新输入一次，或者扫桌面端「设置 → 手机连接」的二维码', '', 'E1701');
    return;
  }
  paint('busy');
  /*
   * 8 秒超时（2026-11 加）：网络半通 / 防火墙静默丢包时，没有它 fetch 会一直吊着，
   * 页面永远停在"正在配对…"转圈 —— 用户看到的正是这个。超时后必须 paint('err')，别留 spinner。
   */
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch('/api/pair/claim', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bandi': '1',
        'X-Bandi-CSRF': csrfValue(),
      },
      body: JSON.stringify({ ...cred, name: guessDeviceName(), clientKey: clientKey() || undefined }),
      signal: ctrl.signal,
    });
    const d = await r.json().catch(() => null);
    if (r.ok && d?.ok) {
      enterWorkbench(d);
      return;
    }
    paint('err', FRIENDLY[d?.code] ?? (d?.error || '核验没有通过'), '请在桌面端「设置 → 手机连接」换一个邀请码再试', d?.code ?? String(r.status));
  } catch {
    // 超时和网络错误分开说：超时 = 请求发出去了但 8 秒没回音（多半是防火墙 / 不同网段）；
    // 其它 = 连接根本没建立（地址不通、服务没起）。
    if (ctrl.signal.aborted) {
      // 端口现读 location：写死数字在换端口后就是一句错的提示（18787 → 别的值时尤其误导）
      paint('err', `等了 8 秒没回应 —— 确认手机和电脑在同一个 WiFi，且电脑防火墙放行了 ${location.port || '80'}`, '修好后回到扫码页重新扫一次', '');
    } else {
      paint('err', '连不上电脑上的班底', '确认手机和电脑在同一个网络里，然后重新扫码试试', '');
    }
  } finally {
    clearTimeout(timer);
  }
}

claimAndEnter();
