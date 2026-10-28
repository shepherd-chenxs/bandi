/* pair-claim.mjs —— 手机配对落地页逻辑（pair.html 专用，不进主应用模块图）。
 *
 * 流程（设计 §4.1）：取 ?token= → POST /api/pair/claim（**必须带 X-Bandi: 1**，
 * 这里是独立页面，没有主应用 ui.mjs 的 api() 帮忙注入，只能自己带）→
 * 成功：localStorage 记一份 deviceId 兜底 → location.replace('/') 带 Cookie 进工作台；
 * 失败：一行人话 + 「请在桌面端重新生成二维码」。
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
    box.innerHTML = '<div class="spin"></div><h1>正在配对…</h1><p>正在向电脑上的班底核验这个二维码</p>';
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
  E1701: '二维码不完整 —— 请用相机或浏览器重新扫一遍',
  E1702: '二维码已过期或无效',
  E3001: '电脑上的班底还没允许这台手机动手 —— 去电脑端「模式」页确认已切到总机并点了重启生效',
  E4010: '配对失效了，请在桌面端重新生成二维码',
  E4701: '这个二维码已经被别的手机用过了',
};

async function claimAndEnter() {
  const token = new URLSearchParams(location.search).get('token');
  if (!token) {
    paint('err', '地址里没有配对码 —— 请扫桌面端「设置 → 手机配对」生成的二维码', '', 'E1701');
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
      headers: { 'Content-Type': 'application/json', 'X-Bandi': '1' },
      body: JSON.stringify({ token, name: guessDeviceName() }),
      signal: ctrl.signal,
    });
    const d = await r.json().catch(() => null);
    if (r.ok && d?.ok) {
      try { localStorage.setItem('bandi.pairedDevice', d.deviceId ?? ''); } catch { /* 存不了就算了 */ }
      paint('ok', '正在进入工作台…');
      // replace：二维码的 token 别留在历史里（与桌面端 ?token= 的处理同一口径）
      location.replace('/');
      return;
    }
    paint('err', FRIENDLY[d?.code] ?? (d?.error || '核验没有通过'), '请在桌面端「设置 → 手机配对」重新生成二维码再扫一次', d?.code ?? String(r.status));
  } catch {
    // 超时和网络错误分开说：超时 = 请求发出去了但 8 秒没回音（多半是防火墙 / 不同网段）；
    // 其它 = 连接根本没建立（地址不通、服务没起）。
    if (ctrl.signal.aborted) {
      paint('err', '等了 8 秒没回应 —— 确认手机和电脑在同一个 WiFi，且电脑防火墙放行了 8787', '修好后回到扫码页重新扫一次', '');
    } else {
      paint('err', '连不上电脑上的班底', '确认手机和电脑在同一个网络里，然后重新扫码试试', '');
    }
  } finally {
    clearTimeout(timer);
  }
}

claimAndEnter();
