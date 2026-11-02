/*
 * launcher.js —— 手机壳的启动页（2026-11）。
 *
 * 连接有三种方式，**跟部署形态无关**（2026-11-01：先定扫码/邀请码，同日补「已配对」）：
 *   A. 已配对：这台手机连过的电脑（Rust 侧 shell.json 的 servers），点一下直接连回去 ——
 *      打开 `<origin>/pair?resume=1`，凭远程页 localStorage 的 clientKey 换新令牌，
 *      不用再扫码。没连过任何电脑时这个页签整个不出现。
 *   B. 扫码：二维码里带地址 + 邀请码，扫完直接进 —— 局域网、云端都成立，默认（没记录时）；
 *   C. 邀请码：地址 + 9 位码两栏都填，拼成 `<地址>/pair?code=…` 再进。
 *
 * 三者是同一张页签（`#tabs` 的 data-mode = paired | scan | code），滑块位置由
 * `--seg-n` / `--seg-i` 算 —— 加/减页签不用动 CSS。
 * 为什么不做成"上下几块并列"：并列时填地址那块会把首屏注意力分走，还会把
 * 输入框推到 y>350 —— 键盘弹起时 Android WebView 不滚文档，那就永远点不到。
 *
 * 为什么局域网也要填地址（不再 UDP 自动发现）：广播"猜电脑在哪"会让壳里多出
 * 一条"局域网 / 云端"的分支，两种部署下这条路也就没法共用同一套测试。
 *
 * 探测和跳转交给 Rust（probe / open_server）：本页 origin 是
 * http://tauri.localhost，fetch 到 http://192.168.x.x 会被 CORS 与明文策略拦。
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;

  if (!invoke) {
    showStatus('请通过班底 App 打开这个页面。', 'bad');
    return;
  }

  /** 邀请码位数（与服务端 store/devices.mjs 的 PAIR_CODE_DIGITS 一致） */
  const CODE_LEN = 9;
  // 报错文案尽量压在一行内 —— 错误条两行会把按钮往键盘里多顶 20px
  const CODE_HINT = '电脑上那串 ' + CODE_LEN + ' 位数字';

  /** 连过的电脑（Rust `get_settings().servers`，新的在前） */
  let saved = [];

  let statusTimer = 0;

  function showStatus(text, kind) {
    const el = $('status');
    el.className = 'status ' + (kind || '');
    el.textContent = text;
    el.hidden = false;
    /*
     * 条子钉在**底部**（见 CSS）。键盘要是还开着，底部整块都被盖住 ——
     * 所以报结果之前先把输入框失焦（点「连接」通常已经失焦了，这是兜底）。
     * 代价：极少数情况（码没填满就点连接）键盘会收起，再点一下输入框就回来。
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
   * 以前这里给输入框挂 focus/blur 去加 body.typing、让整页上移 —— 已删，
   * 现在聚焦只是聚焦，布局不动。
   */

  /** ⚠️ 只用来改「连接」这种纯文字按钮：它 replace textContent，带图标的按钮别传。 */
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

  /* ------------------------------------------------------------ 页签 */

  /** 当前可见的页签（`已配对` 在没有记录时是 hidden 的，得跳过它算滑块位置） */
  function visibleModes() {
    return [...$('tabs').querySelectorAll('.seg-btn')]
      .filter((b) => !b.hidden)
      .map((b) => b.dataset.mode);
  }

  /**
   * 切页签。只改 data-mode + 三个 pane 的 hidden —— 输入内容一直留在 DOM 里，
   * 来回切不会丢（用户扫失败后手输，正是靠这一点）。
   */
  function setMode(mode) {
    const vis = visibleModes();
    const next = vis.includes(mode) ? mode : vis.includes('scan') ? 'scan' : vis[0];
    // 滑块：宽度 = 一格，位移 = 第几格（CSS 里用这两个变量算，不再写死 50%）
    $('tabs').style.setProperty('--seg-n', String(vis.length || 1));
    $('tabs').style.setProperty('--seg-i', String(Math.max(0, vis.indexOf(next))));
    $('tabs').dataset.mode = next;
    for (const btn of $('tabs').querySelectorAll('.seg-btn')) {
      const on = btn.dataset.mode === next;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    $('panePaired').hidden = next !== 'paired';
    $('paneScan').hidden = next !== 'scan';
    $('paneCode').hidden = next !== 'code';
    // 切走再回来要落在列表上，别停在上一台的详情里
    if (next !== 'paired' && !$('pairedDetail').hidden) closePairDetail();
  }

  /** 探测 → 跳转。成功时页面会直接离开，不用收尾。 */
  async function connect(input, btn, info) {
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
      await invoke('open_server', {
        input,
        label: (who && who.label) || null,
        hostname: (who && who.hostname) || null,
      });
    } catch (e) {
      showStatus(String(e || '连不上这个地址'), 'bad');
    } finally {
      /*
       * 不管成没成都要把按钮放回来。连上是 `location.replace`（连接页不进历史，
       * 页面会直接走掉），恢复一下没副作用；连不上时这行才是关键 ——
       * 不然按钮永远停在「连接中…」且 disabled（2026-11-01 CDP 实测到了）。
       */
      setBusy(btn, false);
      document.body.classList.remove('connecting');
    }
  }

  /* ------------------------------------------------------------ 两栏输入 */

  /** 地址列：去空白、去尾部斜杠（`https://x.com/` + `/pair?code=` 会长出双斜杠） */
  function readAddr() {
    return $('addrInput').value.trim().replace(/\/+$/, '');
  }

  /** 整条配对链接（粘贴进来的，或老二维码里的 `?token=bp_…`） */
  function looksLikePairUrl(v) {
    return /^https?:\/\/\S+\/pair(\?|$)/i.test(v);
  }

  /** 邀请码列：只认 9 位数字，其余返回 null */
  function readCode() {
    const digits = $('codeInput').value.replace(/\D/g, '');
    return digits.length === CODE_LEN ? digits : null;
  }

  function setCode(digits) {
    const el = $('codeInput');
    el.value = String(digits || '')
      .replace(/\D/g, '')
      .slice(0, CODE_LEN)
      .replace(/(\d{3})(?=\d)/g, '$1 ');
  }

  /**
   * 两栏 → 真正要打开的地址。
   *
   * 地址栏里如果已经是一条完整配对链接（用户从电脑上复制粘贴的），原样用 ——
   * 那是"没有相机"时唯一的活路，不该要求他手工拆成两截。
   */
  function buildTarget(addr, code) {
    if (looksLikePairUrl(addr)) return addr;
    if (!addr) return null;
    // 用户可能只写了域名/IP，也可能顺手粘了带路径的首页地址：只取 origin
    const origin = (addr.match(/^https?:\/\/[^/?#]+/i) || [])[0] || addr;
    return origin + '/pair?code=' + encodeURIComponent(code);
  }

  function submit(btn) {
    const addr = readAddr();
    if (!addr) {
      showStatus('先填电脑地址，如 192.168.1.5:18787', 'bad');
      return;
    }
    // 完整链接直接走（老二维码 / 手抄链接；里面可能带的是 token 而不是 code）
    if (looksLikePairUrl(addr)) return void connect(addr, btn);
    const code = readCode();
    if (!code) {
      showStatus('邀请码还差几位 —— ' + CODE_HINT, 'bad');
      return;
    }
    return void connect(buildTarget(addr, code), btn);
  }

  /* ------------------------------------------------------------ 已配对 */

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** `http://192.168.5.42:18787` → `192.168.5.42:18787`（列表里第二行给人看的） */
  function hostOf(origin) {
    const m = String(origin || '').match(/^https?:\/\/([^/]+)/i);
    return m ? m[1] : String(origin || '');
  }

  function fmtAgo(ms) {
    if (!ms) return '之前连过';
    const d = Date.now() - ms;
    if (d < 0 || d < 60e3) return '刚刚';
    if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前';
    if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前';
    if (d < 30 * 86400e3) return Math.floor(d / 86400e3) + ' 天前';
    return new Date(ms).toLocaleDateString();
  }

  /**
   * 列表重画。名字优先用 `/api/hello` 报的机器名，没有就退回地址。
   * 整行是一个按钮（点哪都进详情），右端那个箭头只是"这里有下一层"的指示。
   */
  function renderPaired() {
    const box = $('pairedList');
    if (!box) return;
    if (!saved.length) {
      box.innerHTML = '<div class="empty">还没有连过任何电脑</div>';
      return;
    }
    box.innerHTML = saved
      .map((s, i) => {
        const name = s.label || s.hostname || hostOf(s.origin);
        const meta = [hostOf(s.origin), fmtAgo(s.lastAt)].filter(Boolean).join(' · ');
        return `
        <button class="paired-row" type="button" data-open="${esc(s.origin)}" aria-label="查看 ${esc(name)} 的连接信息">
          <span class="paired-main">
            <span class="paired-name"><span class="paired-txt">${esc(name)}</span>${i === 0 ? '<span class="paired-tag">最近</span>' : ''}</span>
            <span class="paired-meta">${esc(meta)}</span>
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

  /* ------------------------------------------------------------ 已配对 · 详情 */

  /** 详情页当前看的那台（空 = 没开详情）；`pdPushed` = 往 history 里压过一条（返回键用） */
  let pdOrigin = '';
  let pdPushed = false;
  const detailOpen = () => !$('pairedDetail').hidden;

  /**
   * 进详情。**不连** —— 连接是详情页里那个明确动作（用户 2026-11-01 定：
   * 列表上点一下就秒连太容易误触，先看清是哪台再决定）。
   */
  function openPairDetail(origin) {
    const s = saved.find((x) => x.origin === origin);
    if (!s) return;
    pdOrigin = origin;
    const name = s.label || s.hostname || hostOf(s.origin);
    const host = s.hostname && s.hostname !== name ? s.hostname : '';
    $('pdName').textContent = name;
    $('pdHost').textContent = host;
    $('pdHost').hidden = !host;
    $('pdOrigin').textContent = s.origin;
    $('pdLast').textContent = fmtAgo(s.lastAt);
    $('pairedList').hidden = true;
    $('pairedHint').hidden = true;
    $('pairedDetail').hidden = false;
    clearStatus();
    // 压一条历史：Android 返回键能直接退回列表，而不是退出 App
    if (!pdPushed) {
      try {
        history.pushState({ pd: origin }, '');
        pdPushed = true;
      } catch {
        /* pushState 不可用（file:// 之类）：返回键就退页，认了 */
      }
    }
  }

  function closePairDetail() {
    $('pairedDetail').hidden = true;
    $('pairedList').hidden = false;
    $('pairedHint').hidden = false;
    pdOrigin = '';
    clearStatus();
  }

  /** 重新读一遍记录（Rust 侧已经排好序：新的在前） */
  async function reloadPaired() {
    let s = null;
    try {
      s = await invoke('get_settings');
    } catch {
      /* 读不到就保持原样 */
    }
    if (s) saved = Array.isArray(s.servers) ? s.servers.filter((x) => x && x.origin) : [];
    renderPaired();
    // 记录清空 → 那个页签跟着消失（否则点进去是空列表，没意义）
    const tab = $('tabs').querySelector('[data-mode="paired"]');
    if (tab) tab.hidden = !saved.length;
    setMode($('tabs').dataset.mode || 'scan');
  }

  /* ------------------------------------------------------------ 启动 */

  async function boot() {
    await reloadPaired();
    // 连过就默认停在「已配对」（最常见的动作是一键回去），没连过才落到扫码
    setMode(saved.length ? 'paired' : 'scan');
  }

  /* ------------------------------------------------------------ 事件 */

  $('tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    if (btn.dataset.mode === $('tabs').dataset.mode) return;
    setMode(btn.dataset.mode);
    clearStatus();
  });

  $('connectBtn').addEventListener('click', () => submit($('connectBtn')));

  /*
   * 输入即格式化：只留数字、每三位一个空格（`482 913 665`），跟电脑上显示的
   * 分组一致 —— 抄错一位最常见的形态就是"中间那组少一个数"。粘进来的整条
   * 链接不碰（那种内容放地址栏更合适，见 buildTarget）。
   */
  $('codeInput').addEventListener('input', () => {
    const el = $('codeInput');
    const digits = el.value.replace(/\D/g, '').slice(0, CODE_LEN);
    el.value = digits.replace(/(\d{3})(?=\d)/g, '$1 ');
    if (digits.length === CODE_LEN) clearStatus();
  });

  $('addrInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('codeInput').focus();
    }
  });

  /*
   * 「已配对」：列表 → 详情两级（2026-11-01 四改）。
   *   · 点行 → 进详情（读连接信息），**不直接连** —— 一秒连错电脑比多点一下烦；
   *   · 详情「连接」→ `<origin>/pair?resume=1`：远程页拿 localStorage 的 clientKey
   *     换新令牌，不用邀请码。断开的手机在自己没人在用时就是这么连回来的；
   *   · 详情「取消配对」→ 只清这台手机上的记录，电脑端那条设备记录不动。
   */
  $('pairedList').addEventListener('click', (e) => {
    const row = e.target.closest('[data-open]');
    if (row) openPairDetail(row.dataset.open);
  });

  // 返回：有历史条目就走 back（由 popstate 收尾，返回键和点按钮走同一条路）
  $('pdBack').addEventListener('click', () => {
    if (pdPushed) {
      pdPushed = false;
      history.back();
    } else {
      closePairDetail();
    }
  });

  window.addEventListener('popstate', () => {
    pdPushed = false;
    if (!$('pairedDetail').hidden) closePairDetail();
  });

  $('pdConnect').addEventListener('click', () => {
    if (!pdOrigin) return;
    // 提示条交给 connect 自己发（它开头会 clearStatus，这里先写也会被清掉）
    connect(pdOrigin.replace(/\/+$/, '') + '/pair?resume=1', $('pdConnect'));
  });

  $('pdForget').addEventListener('click', async () => {
    const b = $('pdForget');
    if (!pdOrigin) return;
    const name = $('pdName').textContent || pdOrigin;
    b.disabled = true;
    try {
      await invoke('forget_server', { origin: pdOrigin });
      closePairDetail();
      await reloadPaired();
      showStatus('已取消配对：' + name, 'good');
    } catch (err) {
      b.disabled = false;
      showStatus(String(err || '取消配对失败'), 'bad');
    }
  });

  $('codeInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit($('connectBtn'));
  });

  /*
   * 扫一扫：相机与解码在 scanner.js，这里只管"解到东西之后怎么办"。
   * 二维码内容 = `http://<ip>:<port>/pair?code=…`（地址 + 邀请码一起带），
   * 所以拆成两半填进输入框再连接 —— 用户能看见自己扫到了什么，填错了还能改。
   */
  $('scanBtn').addEventListener('click', async () => {
    if (!window.BandiScan) {
      showStatus('扫码模块没加载上（dist/scanner.js 丢了）', 'bad');
      return;
    }
    clearStatus();
    try {
      await window.BandiScan.open((text) => applyScan(text));
    } catch (e) {
      // 相机起不来（没权限 / 被占用 / 没摄像头）：直接切到邀请码页签，
      // 让人还有路可走。scanner 的文案里已带「切到邀请码手输」，别再拼一遍。
      showStatus(String((e && e.message) || e), 'bad');
      setMode('code');
    }
  });

  /** 扫码结果：能拆就拆成两栏（可核对），拆不了就整条打开 */
  function applyScan(text) {
    const t = String(text || '').trim();
    if (!t) return;
    const origin = (t.match(/^https?:\/\/[^/?#]+/i) || [])[0] || '';
    const code = (t.match(/[?&]code=(\d{6,12})/i) || [])[1] || '';

    if (!origin) {
      showStatus('这不是班底的配对码 —— 回电脑上再扫一次', 'bad');
      return;
    }
    setMode('code');
    $('addrInput').value = origin;
    if (code) setCode(code);
    // ⚠️ 别把 #scanBtn 传给 connect：setBusy 会 replace 它的 textContent，
    // 把取景框那圈标记和两个 span 全抹掉。扫码在手时按钮本来也已经收起。
    // 带 token 的老码 / 没解析出 code 的，整条打开；其余走标准配对地址
    return void connect(code ? buildTarget(origin, code) : t, null);
  }

  /*
   * 键盘适配（2026-11 实测结论，写下来免得下次又踩）：
   *
   * Tauri 的 Android WebView 里，键盘弹起时
   *   · 文档**滚不动**（scrollIntoView / window.scrollTo / 补 padding 全无效）；
   *   · `visualViewport` 不派发 resize（所以 --kb / --vvh 那套兜底也不会生效）。
   * 因此这里不做任何键盘状态判断，改成布局层解决：两个输入框都落在上半屏、
   * 键盘盖不住（用户真机确认）。键盘弹起时页面**一动不动** —— 别再写
   * "聚焦就上移/收头部"那种逻辑，两个版本都被用户否掉了。
   */

  boot();
})();
