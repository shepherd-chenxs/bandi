/*
 * launcher.js —— 手机壳的启动页（2026-11-07 改版：登录 → 设备列表 → 进一台）。
 *
 * 主路径（用户 2026-11-07 定稿；同日再拍板「撤掉扫码，hub 唯一入口」——
 * 曾经的兜底三条「扫码 / 邀请码 / 已配对」整场退场，扫码时代的视图、
 * scanner.js 与 vendored jsQR 一并删除）：
 *   A. 账号密码登录：手机号 + 密码 → POST <中枢>/v1/auth/phone-login，换一枚
 *      `role:'user'` 的会话（30 天，存 localStorage）。手机号就是电脑上登录用的那个。
 *   B. 设备列表：GET <中枢>/v1/devices（Bearer 会话）→ 你名下那几台机器；
 *      逐台在**局域网里探活**（Rust probe，裸 TCP 打 /api/hello），探到的才点亮"可连"。
 *   C. 点一台 → POST <中枢>/v1/devices/:id/ticket 签一张一次性票（5 分钟）→
 *      打开 `<那台电脑>/hub/enter?ticket=…`，电脑验票（它本地钉着中枢公钥）后发会话。
 *      **这一路不用输码**：票就是进门凭据（契约 §五/§六）。
 *
 * 视图与 history：home / devices 两层，切换一律 pushState，
 * Android 返回键一层层退（详见 squashHistory 的注释）。
 *
 * 探测和跳转交给 Rust（probe / open_server）：本页 origin 是 http://tauri.localhost，
 * fetch 到 http://192.168.x.x 会被 CORS 与明文策略拦。**但中枢是 https**，可以直连。
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;

  if (!invoke) {
    showStatus('请通过班底 App 打开这个页面。', 'bad');
    return;
  }

  let statusTimer = 0;

  function showStatus(text, kind) {
    const el = $('status');
    el.className = 'status ' + (kind || '');
    el.textContent = text;
    el.hidden = false;
    /*
     * 条子钉在**底部**（见 CSS）。键盘要是还开着，底部整块都被盖住 ——
     * 所以报结果之前先把输入框失焦（点「连接」通常已经失焦了，这是兜底）。
     */
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) ae.blur();
    // 两帧后再加 .on：让 opacity 过渡跑起来，不然一出来就是终态
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('on')));
  }

  function clearStatus() {
    const el = $('status');
    if (el.hidden) return;
    el.classList.remove('on');
    clearTimeout(statusTimer);
    // 等淡出动画走完再真藏；这期间如果又来了新条子（.on 会被重新加回），别动它
    statusTimer = setTimeout(() => {
      if (!el.classList.contains('on')) {
        el.hidden = true;
        el.textContent = '';
      }
    }, 220);
  }

  /*
   * 键盘弹起时页面**不做任何位移**（用户 2026-11-01 实测定稿：键盘盖不住输入框）。
   * 聚焦只是聚焦，布局不动 —— 登录视图与邀请码视图都靠顶部对齐把输入框留在上半屏。
   */

  /** ⚠️ 只用来改「连接 / 登录」这种纯文字按钮：它 replace textContent，带图标的按钮别传。 */
  function setBusy(btn, busy, label) {
    if (!btn) return;
    if (busy) {
      btn.dataset.label = btn.textContent;
      btn.disabled = true;
      btn.textContent = label || '连接中…';
    } else {
      btn.disabled = false;
      if (btn.dataset.label) btn.textContent = btn.dataset.label;
    }
  }

  /* ------------------------------------------------------------ 中枢（身份） */

  /** 官方中枢；自建/调试时在登录页「中枢地址」里改，存本机。 */
  const HUB_DEFAULT = 'https://hub.yuancang.space';
  const K_HUB = 'bandi.hub.base';
  const K_SESSION = 'bandi.hub.session';
  const K_ACCOUNT = 'bandi.hub.account';

  const lsGet = (k) => {
    try {
      return window.localStorage.getItem(k);
    } catch {
      return null;
    }
  };
  const lsSet = (k, v) => {
    try {
      if (v == null) window.localStorage.removeItem(k);
      else window.localStorage.setItem(k, v);
    } catch {
      /* 隐私模式 / 存储被禁：会话只活这一次，认了 */
    }
  };

  function hubBase() {
    return String(lsGet(K_HUB) || HUB_DEFAULT).trim().replace(/\/+$/, '');
  }

  /**
   * 打一次中枢。错误统一成 `{code, status}` 挂在 Error 上，文案里带中枢的 H 码
   * （与主站同规矩：UI 只显示「H1004 · 手机号或密码不对」这种人话）。
   */
  async function hubFetch(path, opts = {}) {
    const { method = 'GET', body, session } = opts;
    let res;
    try {
      res = await fetch(hubBase() + path, {
        method,
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(session ? { authorization: 'Bearer ' + session } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      // 网络层失败（DNS / 明文策略 / CORS 预检被拒）都落在这里
      const err = new Error('连不上中枢（' + hubBase().replace(/^https?:\/\//, '') + '）');
      err.status = 0;
      throw err;
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      const err = new Error('中枢回的不是 JSON（HTTP ' + res.status + '）');
      err.status = res.status;
      throw err;
    }
    if (!res.ok) {
      const code = data && data.error && data.error.code ? data.error.code : '';
      const msg = (data && data.error && data.error.message) || '中枢拒绝了这次请求（HTTP ' + res.status + '）';
      const err = new Error(code ? code + ' · ' + msg : msg);
      err.code = code;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function errText(e) {
    const s = String((e && e.message) || e || '出错了');
    return s.length > 90 ? s.slice(0, 88) + '…' : s;
  }

  /* ------------------------------------------------------------ 视图 */

  /*
   * 状态就两个字段：view = home | devices。渲染是纯函数式的（apply 只读 state 摆 DOM），
   * history 里存的也是同一份 state —— 返回键因此走同一条路，不用各写一遍。
   */
  const HOME = { view: 'home', detail: false };
  let state = HOME;
  /** 我们自己往 history 里压了几层（只用来判断"还有没有上一层可退"） */
  let depth = 0;
  /** 压过的每一层（最老的在前）。连接失败时要照着补回去 —— 见 squashHistory */
  let trail = [];
  /** 正在离开启动页（连接跳转中）：这几步 popstate 只退历史，不重画 */
  let leaving = false;
  /** 被 squashHistory 退掉的层（失败时补回来用） */
  let squashed = [];

  function apply(next) {
    state = next && next.view ? next : HOME;
    const v = state.view;
    $('viewHome').hidden = v !== 'home';
    $('viewDevices').hidden = v !== 'devices';
    document.body.dataset.view = v;
  }

  /** 进下一层：先摆 DOM，再往 history 压一条（压不进去就退化成"返回键退 App"） */
  function go(next) {
    clearStatus();
    apply(next);
    try {
      history.pushState(state, '');
      depth += 1;
      trail.push(state);
    } catch {
      /* pushState 不可用（file:// 之类）：返回键就退页，认了 */
    }
  }

  /*
   * 连接前把启动页**自己压出来的历史退干净**（2026-11-03 用户反馈）。
   *
   * 现象：连上之后在工作台按 Android 返回键，会先退回「已配对」那层，再退一次就
   * 回到登录页 —— 像是干了点事就被踢回登录页。
   *
   * 原因：视图切换是 pushState 进来的（首页 → 邀请码 / 已配对 / 设备列表），而跳转用的是
   * `location.replace` —— 它只顶掉**最上面那一条**，下面几条还留在 WebView 的历史里。
   *
   * 所以跳转前 `history.go(-depth)` 一路退到最初那条（首页），再让 Rust 去 replace：
   * 登录页连人带层一起没了，返回键在远程页根页没得退，直接退出 App。
   * 退的过程 `leaving` 把 popstate 的重画按住 —— 屏幕上是「正在进入…」，看不出闪。
   * 连接**失败**时 restoreHistory 把退掉的那几层照原样压回去（不然这一趟白退，
   * 返回键就成"直接退 App"了）。
   *
   * ⚠️ 例外 —— keepBack=true：设备点选这条**地址靠猜**的路不清历史，
   *   连错时 WebView 停在错误页/陌生页，返回键是唯一的退路：history 里留着
   *   「首页 → 设备列表」这条栈，replace 顶掉最上面那层之后，远程页按返回正好退回上一层。
   */
  async function squashHistory(keepBack) {
    if (keepBack) return;
    leaving = true;
    squashed = trail.slice();
    if (depth <= 0) return;
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        window.removeEventListener('popstate', finish);
        resolve();
      };
      window.addEventListener('popstate', finish);
      // 兜底：万一这版 WebView 连退多格不派 popstate，别把连接卡在这儿
      setTimeout(finish, 300);
      history.go(-depth);
    });
    depth = 0;
    trail = [];
  }

  /** 连接失败：把 squash 退掉的层压回去，返回键仍旧一层层退 */
  function restoreHistory() {
    for (const s of squashed) {
      try {
        history.pushState(s, '');
        depth += 1;
        trail.push(s);
      } catch {
        /* 压不回去就算了，反正是失败兜底 */
      }
    }
    squashed = [];
    leaving = false;
    apply(state);
  }

  window.addEventListener('popstate', (e) => {
    depth = Math.max(0, depth - 1);
    trail.pop();
    // 正在连走（squashHistory 退历史）：别重画，屏幕要停在「正在进入…」
    if (leaving) return;
    apply(e.state);
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) ae.blur();
  });

  /* ------------------------------------------------------------ 连接 */

  /**
   * 探测 → 跳转。成功时页面会直接离开，不用收尾。
   * @param {boolean} [keepBack] 见 squashHistory 的例外说明（地址靠猜的路要留着历史）
   */
  async function connect(input, btn, info, keepBack) {
    clearStatus();
    setBusy(btn, true);
    document.body.classList.add('connecting');
    /*
     * `https://` 跳过 probe：Rust 侧的 walk 是裸 TCP + 明文 HTTP（http_get_hello），
     * 对着 443 说话会被 TLS 握手挡回来，必然报"服务回了：（空）"。云端部署就是 https，
     * 这条不能靠探测，直接交给 WebView —— 连不上时它会显示自己的错误页，比一句
     * 假报错误导人强。
     */
    const plain = !/^https:\/\//i.test(input);
    try {
      let who = info || null;
      if (plain) {
        who = await invoke('probe', { input });
        const line = [who.label, who.hostname].filter(Boolean).join(' · ');
        if (line) showStatus('找到「' + line + '」，正在进入…', 'good');
      } else {
        showStatus('正在进入…', 'good');
      }
      // label/hostname 只为了让「已配对」列表显示成人话，落盘的是 origin（见 lib.rs）
      // 跳转前先把启动页从历史里退干净 —— 连上之后返回键不该还能摸到它
      await squashHistory(keepBack);
      await invoke('open_server', {
        input,
        label: (who && who.label) || null,
        hostname: (who && who.hostname) || null,
      });
    } catch (e) {
      restoreHistory();
      showStatus(String(e || '连不上这个地址'), 'bad');
    } finally {
      /*
       * 不管成没成都要把按钮放回来。连上是 `location.replace`（连接页不进历史，
       * 页面会直接走掉），恢复一下没副作用；连不上时这行才是关键 ——
       * 不然按钮永远停在「连接中…」且 disabled。
       */
      setBusy(btn, false);
      document.body.classList.remove('connecting');
    }
  }

  /* ------------------------------------------------------------ 登录 / 设备列表 */

  /** 名册（原样）与探活结果：`reach[id] = { origin, label }` */
  let devices = [];
  let reach = {};
  /** 正在探活的那一轮的编号：重新加载时旧的一轮自己收手 */
  let probeRound = 0;

  /** `{scheme, port, lanAddrs}` → 候选地址（第一优先的就是名册里的顺序） */
  function originsOf(dev) {
    const scheme = dev && dev.scheme === 'https' ? 'https' : 'http';
    const port = dev && dev.port ? ':' + dev.port : '';
    const addrs = (dev && Array.isArray(dev.lanAddrs) ? dev.lanAddrs : []).filter((a) => typeof a === 'string' && a);
    return addrs.map((a) => scheme + '://' + a + port);
  }

  function renderDevices() {
    const box = $('deviceList');
    if (!box) return;
    if (!devices.length) {
      box.innerHTML = '<div class="empty">这个账号名下还没有电脑<br/>先在电脑上打开班底，用同一个手机号登录一次</div>';
      return;
    }
    box.innerHTML = devices
      .map((d) => {
        const r = reach[d.id];
        const badge = r && r.origin ? '<span class="dev-badge ok">可连</span>' : '<span class="dev-badge">未探到</span>';
        const meta = [d.platform || '', d.version ? 'v' + d.version : ''].filter(Boolean).join(' · ');
        return `
        <button class="paired-row" type="button" data-dev="${esc(d.id)}" aria-label="进入 ${esc(d.name || d.id)}">
          <span class="paired-main">
            <span class="paired-name"><span class="paired-txt">${esc(d.name || d.id)}</span>${badge}</span>
            <span class="paired-meta">${esc(r && r.origin ? hostOf(r.origin) : meta || '—')}</span>
          </span>
          <span class="paired-chev" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M9 5l7 7-7 7" />
            </svg>
          </span>
        </button>`;
      })
      .join('');
  }

  /**
   * 逐台探活（并行，每台最多试前三个地址）。
   *
   * 为什么探：名册里的 `lanAddrs` 是**候选**，手机现在网段里哪个通只有手机知道。
   * 探到的那个地址才拿去拼 `/hub/enter` —— 拼错了用户看到的是浏览器的错误页。
   */
  async function probeDevices() {
    const round = ++probeRound;
    reach = {};
    renderDevices();
    await Promise.all(
      devices.map(async (d) => {
        for (const origin of originsOf(d).slice(0, 3)) {
          if (round !== probeRound) return;
          try {
            const info = await invoke('probe', { input: origin });
            if (round !== probeRound) return;
            reach[d.id] = { origin, label: (info && (info.label || info.hostname)) || null };
            renderDevices();
            return;
          } catch {
            /* 这个地址不通，试下一个 */
          }
        }
      }),
    );
    if (round === probeRound) {
      const anyOk = Object.keys(reach).length > 0;
      $('devSub').textContent = anyOk
        ? '点一台进去'
        : '一台都没探到 —— 确认手机和电脑在同一个网络里，或者先在电脑上打开班底';
    }
  }

  /** 拉名册（会话失效会抛 401，由调用方决定回登录页） */
  async function loadDevices() {
    const session = lsGet(K_SESSION);
    if (!session) throw Object.assign(new Error('还没有登录'), { status: 401 });
    $('devSub').textContent = '正在读取名册…';
    $('deviceList').innerHTML = '<div class="empty">读取中…</div>';
    const r = await hubFetch('/v1/devices', { session });
    devices = Array.isArray(r.devices) ? r.devices : [];
    $('devSub').textContent = devices.length ? '点一台进去' : '';
    renderDevices();
    probeDevices();
  }

  /** 退出登录：只清本机的会话（中枢不存会话，登出就是丢掉这张票） */
  function signOut(say) {
    lsSet(K_SESSION, null);
    lsSet(K_ACCOUNT, null);
    devices = [];
    reach = {};
    $('passInput').value = '';
    apply(HOME);
    if (say) showStatus(say, 'good');
  }

  async function doLogin(btn) {
    const phone = ($('phoneInput').value || '').replace(/\D/g, '');
    const password = $('passInput').value || '';
    if (!/^1\d{10}$/.test(phone)) {
      showStatus('手机号填 11 位', 'bad');
      return;
    }
    if (password.length < 8) {
      showStatus('密码至少 8 位', 'bad');
      return;
    }
    clearStatus();
    setBusy(btn, true, '登录中…');
    document.body.classList.add('connecting');
    try {
      const r = await hubFetch('/v1/auth/phone-login', { method: 'POST', body: { username: phone, password } });
      lsSet(K_SESSION, r.session);
      lsSet(K_ACCOUNT, (r.account && r.account.login) || phone);
      $('passInput').value = '';
      go({ view: 'devices', detail: false });
      await loadDevices();
    } catch (e) {
      showStatus(errText(e), 'bad');
    } finally {
      setBusy(btn, false);
      document.body.classList.remove('connecting');
    }
  }

  /** 点一台：签票 → 打开那台电脑的 /hub/enter。票是一次性的（5 分钟）。 */
  async function enterDevice(id) {
    const d = devices.find((x) => x.id === id);
    if (!d) return;
    const session = lsGet(K_SESSION);
    if (!session) {
      signOut();
      return;
    }
    clearStatus();
    document.body.classList.add('connecting');
    try {
      const t = await hubFetch('/v1/devices/' + encodeURIComponent(id) + '/ticket', { method: 'POST', session });
      const dev = (t && t.device) || d;
      const origin = (reach[id] && reach[id].origin) || originsOf(dev)[0];
      if (!origin) {
        showStatus('这台电脑还没上报地址，先在它上面打开班底', 'bad');
        return;
      }
      showStatus('正在进入…', 'good');
      // keepBack=true：进不去时按返回能退回列表，不至于困在外面
      await connect(origin + '/hub/enter?ticket=' + encodeURIComponent(t.ticket), null, null, true);
    } catch (e) {
      // 401 = 会话过期（中枢换了 SESSION_SECRET 或 30 天到了）
      if (e && e.status === 401) signOut('登录已过期，请重新登录');
      else showStatus(errText(e), 'bad');
    } finally {
      document.body.classList.remove('connecting');
    }
  }

  /* ------------------------------------------------------------ 已配对 */

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** `http://192.168.5.42:18787` → `192.168.5.42:18787`（列表里第二行给人看的） */
  function hostOf(origin) {
    const m = String(origin || '').match(/^https?:\/\/([^/]+)/i);
    return m ? m[1] : String(origin || '');
  }

  /* ------------------------------------------------------------ 事件 */

  $('loginBtn').addEventListener('click', () => doLogin($('loginBtn')));
  $('passInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doLogin($('loginBtn'));
    }
  });
  $('phoneInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('passInput').focus();
    }
  });

  // 中枢地址：改一次存一次（不回车也能生效，下次开会话就用新地址）
  $('hubInput').addEventListener('change', () => {
    const v = $('hubInput').value.trim().replace(/\/+$/, '');
    lsSet(K_HUB, v || null);
  });

  $('deviceList').addEventListener('click', (e) => {
    const row = e.target.closest('[data-dev]');
    if (row) enterDevice(row.dataset.dev);
  });

  $('devRefresh').addEventListener('click', async () => {
    clearStatus();
    try {
      await loadDevices();
      showStatus('已刷新', 'good');
    } catch (e) {
      if (e && e.status === 401) signOut('登录已过期，请重新登录');
      else showStatus(errText(e), 'bad');
    }
  });

  // devLogout（列表页的退出登录）2026-11-07 随按钮一起撤：退出的正路只剩
  // 面板「我的 → 退出登录」（#bandi-bye 闭环），signOut 留给 401 过期与 boot 用。

  /*
   * 键盘适配（2026-11 实测结论，写下来免得下次又踩）：
   *
   * Tauri 的 Android WebView 里，键盘弹起时
   *   · 文档**滚不动**（scrollIntoView / window.scrollTo / 补 padding 全无效）；
   *   · `visualViewport` 不派发 resize（所以 --kb / --vvh 那套兜底也不会生效）。
   * 因此这里不做任何键盘状态判断，改成布局层解决：登录/邀请码视图顶部对齐，
   * 输入框都落在上半屏、键盘盖不住（用户真机确认）。键盘弹起时页面
   * **一动不动** —— 别再写"聚焦就上移/收头部"那种逻辑，两个版本都被用户否掉了。
   */

  boot();
})();
