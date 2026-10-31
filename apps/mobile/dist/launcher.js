/*
 * launcher.js —— 手机壳的启动页（2026-11）。
 *
 * 只干三件事：读上次的地址、扫局域网、把手输/粘贴的地址交给 Rust 去探测和跳转。
 * 探测为什么不在 JS 里做：本页 origin 是 http://tauri.localhost，fetch 到
 * http://192.168.x.x 会被 CORS 与明文策略拦；UDP 广播 JS 也发不了。
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;

  if (!invoke) {
    showStatus('请通过班底 App 打开这个页面。', 'bad');
    return;
  }

  function showStatus(text, kind) {
    const el = $('status');
    el.hidden = false;
    el.className = 'status ' + (kind || '');
    el.textContent = text;
  }

  function clearStatus() {
    const el = $('status');
    el.hidden = true;
    el.textContent = '';
  }

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

  /** 探测 → 跳转。成功时页面会直接离开，不用收尾。 */
  async function connect(input, btn) {
    clearStatus();
    setBusy(btn, true);
    try {
      const info = await invoke('probe', { input });
      const who = [info.label, info.hostname].filter(Boolean).join(' · ');
      if (who) showStatus('找到「' + who + '」，正在进入…', 'good');
      await invoke('open_server', { input });
    } catch (e) {
      showStatus(String(e || '连不上这个地址'), 'bad');
      setBusy(btn, false);
    }
  }

  function renderCandidates(list) {
    const box = $('candidates');
    box.innerHTML = '';
    if (!list || !list.length) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent =
        '没扫到。确认电脑上的班底已开启「允许局域网访问」，或者直接填地址。';
      box.append(p);
      return;
    }
    for (const c of list) {
      const row = document.createElement('div');
      row.className = 'cand';

      const main = document.createElement('div');
      main.className = 'cand-main';
      const name = document.createElement('div');
      name.className = 'cand-name';
      name.textContent = c.label || c.hostname || c.address;
      const meta = document.createElement('div');
      meta.className = 'cand-meta';
      const extra = c.hostname && c.hostname !== name.textContent ? c.hostname : null;
      meta.textContent = [extra, c.address + ':' + c.port].filter(Boolean).join(' · ');
      main.append(name, meta);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn small';
      btn.textContent = '连接';
      btn.addEventListener('click', () => connect(c.url, btn));

      row.append(main, btn);
      box.append(row);
    }
  }

  async function scan() {
    $('found').hidden = false;
    $('candidates').innerHTML = '<p class="empty">正在搜索局域网里的班底…</p>';
    try {
      const list = await invoke('discover', { timeout: 1800 });
      renderCandidates(list);
    } catch {
      renderCandidates([]);
    }
  }

  async function boot() {
    let settings = { server: null };
    try {
      settings = await invoke('get_settings');
    } catch {
      /* 读不到就当没连过 */
    }

    if (settings.server) {
      $('connectedUrl').textContent = settings.server;
      $('connected').hidden = false;
      $('manual').hidden = true;

      $('enterBtn').addEventListener('click', () => connect(settings.server, $('enterBtn')));
      $('switchBtn').addEventListener('click', async () => {
        try {
          await invoke('forget_server');
        } catch {
          /* 清不掉也不挡换地址 */
        }
        $('connected').hidden = true;
        $('manual').hidden = false;
        $('addrInput').value = '';
        clearStatus();
        scan();
      });
      return;
    }

    // 没连过：扫描 + 手动填
    scan();
  }

  $('connectBtn').addEventListener('click', () => {
    const v = $('addrInput').value.trim();
    if (!v) {
      showStatus('先填一个地址，比如 192.168.1.5:8787', 'bad');
      return;
    }
    connect(v, $('connectBtn'));
  });

  $('addrInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('connectBtn').click();
  });

  /*
   * 键盘适配（2026-11 实测结论，写下来免得下次又踩）：
   *
   * Tauri 的 Android WebView 里，键盘弹起时
   *   · 文档**滚不动**（scrollIntoView / window.scrollTo / 补 padding 全无效）；
   *   · `visualViewport` 不派发 resize（所以 --kb / --vvh 那套兜底也不会生效）。
   * 因此这里不做任何键盘状态判断，改成布局层解决：输入卡片排在发现列表
   * **前面**（见 index.html），永远落在上半屏、键盘上方。
   */

  boot();
})();
