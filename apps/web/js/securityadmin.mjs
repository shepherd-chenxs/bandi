/* securityadmin.mjs —— 设置 › 安全（2026-10-31，IAM §9 / §11.2 Phase 1 收尾）。
 *
 * 三块（2026-11-03 起 admin 端改成 .tabs 页签横排，默认「网络访问」；非 admin 只有会话块）：
 *   · **网络访问**（仅管理员）—— 授权 IP 白名单 / 域名绑定（security/ipallow.mjs 的界面）。
 *   · **我的会话** —— 在哪些设备上登着（指纹 / 时间 / IP），「踢掉其它设备」一键收权；
 *     每个登录账号都能看自己的（服务端只认会话里的 userId，不从参数拿）。
 *   · **审计日志**（仅管理员）—— 谁、什么时候、做了什么、成没成。策略层自动记
 *     （401/403 拒绝、写操作 pending→回填），这里只是查询窗口：按类型筛 + 游标翻页。
 *
 * 版式沿设置页的 set-sec 卡片；错误一律「码 + 中文」toast，不用 alert。
 */
import { esc, toast } from './shell.mjs';
import { api, createCombo, dt, failHtml, post } from './ui.mjs';
import { confirmDo } from './machine.mjs';
import { $, S } from './core.mjs';

const head = (actions = '') =>
  `<div class="detail-head head-row"><div class="head-title"><b>安全</b></div>${
    actions ? `<div class="head-actions">${actions}</div>` : ''
  }</div>`;

/**
 * 等控制面重启回来，再整页刷新（2026-11-04，改监听地址后那一下）。
 *
 * 用裸 `fetch` 而不是 `api()`：重启后会话可能失效，**401 也说明"服务已经活了"**，
 * 而 `api()` 会把 401 当错误抛出去 —— 那就永远等不到。判据只该是"端口能应答"。
 * 45 秒还没回来就如实报错，别无限转圈。
 */
async function waitForRestart() {
  toast('控制面在重启，稍等几秒页面会自己刷新…');
  const t0 = Date.now();
  while (Date.now() - t0 < 45000) {
    await new Promise((r) => setTimeout(r, 1200));
    try {
      const r = await fetch('/api/state', { cache: 'no-store' });
      if (r.ok || r.status === 401 || r.status === 403) {
        location.reload();
        return;
      }
    } catch { /* 还没起来，继续等 */ }
  }
  toast('45 秒还没等到它回来 —— 去终端看 bandi status / journalctl -u bandi -n 40', 'error');
}

/** 审计类型的中文名（与服务端 auditKindOf 同源，查询值直接用英文 kind） */const KIND_LABEL = {
  login: '登录',
  'session.revoke': '退出/踢下线',
  'user.change': '账号变更',
  'machine.local': '本机操作',
  restart: '重启',
  write: '写操作',
  'authz.deny': '拒绝访问',
  'audit.archive': '归档',
  'audit.clear': '清空',
};

const RESULT_LABEL = { ok: '成功', fail: '失败', deny: '已拦截', pending: '进行中' };

/** 结果的小圆点（绿=ok、红=fail/deny、灰=pending）—— 汉字之外一眼能扫的那一位 */
const resultDot = (r) => `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:${
  r === 'ok' ? 'var(--ok, #34a853)' : r === 'pending' ? 'var(--dim)' : '#d93025'
}"></span>`;

export async function renderSecurity() {
  $('settingsView').innerHTML = `${head()}<div class="empty" style="padding:24px 4px">加载中…</div>`;
  const isAdmin = !!S.isAdmin && !S.isDevice;

  /* 会话必加载；审计只有 admin 拉 —— 非 admin 不发那一条请求（发了也是 403 toast）。
     网络访问（2026-11-03）：同样是 admin 的事（POST /api/lan 要 machine:manage），非 admin 不拉。 */
  const [sess, audit, lan] = await Promise.all([
    api('/api/security/sessions').catch(() => null),
    isAdmin ? api('/api/security/audit?limit=50').catch(() => null) : Promise.resolve(null),
    isAdmin ? api('/api/lan').catch(() => null) : Promise.resolve(null),
  ]);

  const sessions = sess?.sessions ?? [];
  const sessionRows = sessions.length
    ? sessions
        .map(
          (s) => `<div class="set-row" style="flex-direction:column;align-items:flex-start;gap:2px">
            <div style="display:flex;gap:8px;align-items:center;width:100%">
              <b>${esc(s.kind === 'hub' ? '中枢登录' : s.kind === 'browser' ? '浏览器' : s.kind)}</b>
              <span style="color:var(--dim);font-size:12px">指纹 ${esc(s.id)}</span>
              ${s.ip ? `<span style="color:var(--dim);font-size:12px">IP ${esc(s.ip)}</span>` : ''}
            </div>
            <span style="color:var(--dim);font-size:12px;word-break:break-all">登录 ${dt(s.createdAt)} · 最近活跃 ${dt(s.lastSeenAt)}${s.ua ? ` · ${esc(String(s.ua).slice(0, 80))}` : ''}</span>
          </div>`,
        )
        .join('')
    : `<div class="set-row"><span class="hint">没有活动会话。</span></div>`;

  const auditHtml = !isAdmin
    ? ''
    : `<section class="set-sec">
        <div class="set-head">
          <b>审计日志</b><span class="set-tag">仅管理员 · 保留 90 天</span>
          <!-- 导出 / 清空（2026-11-03）：导出按当前类型筛选走全量；清空是破坏性动作，二次确认 -->
          <!-- 类型筛选（2026-11-03 用户：放标题行、用公共 createCombo，不再占一整行 set-row） -->
          <span class="sec-head-actions">
            <span id="auditKindMount"></span>
            <button class="btn-sm" type="button" id="auditExport">导出</button>
            <button class="btn-sm" type="button" id="auditClear">清空</button>
          </span>
        </div>
        <div class="set-box">
          <div id="auditList"></div>
          <div class="set-row" style="justify-content:center"><button id="auditMore" style="display:none">加载更早</button></div>
        </div>
      </section>`;

  /*
   * 监听地址（2026-11-04，用户："监听由启动配置决定，界面不改"是实现时自作主张，
   * 要做成 1Panel 那样 —— 面板里能改、改完重启生效、升级重装都不丢）。
   *
   * 真源在数据目录的 `config.json.listenHost`（服务端 `writeListenHost`），**不是** systemd
   * 单元：单元每次重装都会被 `deploy/install.sh` 重写，11-04 就是这么把 0.0.0.0 写回
   * 127.0.0.1、局域网全断的。`BANDI_HOST` 环境变量钉着时这里只读并说清原因。
   */
  const listenHtml = !isAdmin || !lan?.listen
    ? ''
    : (() => {
        const L = lan.listen;
        const locked = L.editable === false;
        const srcText =
          L.source === 'env'
            ? '当前是被启动参数 <code>BANDI_HOST</code> 钉着的 —— 界面改不动它，要去掉那个变量（或终端敲 <code>bandi reset-host</code>）。'
            : L.source === 'config'
              ? '这个值存在数据目录的配置里，升级、重装都不会被改回去。'
              : '还没人改过，用的是缺省值（对外服务 + 强制鉴权）。';
        const pending = L.needRestart
          ? `<div class="set-row"><p class="hint" style="color:var(--warn)">已存成 <b>${esc(L.wanted)}</b>，但当前进程还听着 <b>${esc(L.host)}</b> —— 重启控制面才生效。</p></div>`
          : '';
        return `<section class="set-sec">
          <div class="set-head"><b>监听地址</b><span class="set-tag">改了要重启控制面</span></div>
          <div class="set-box">
            <div class="set-row">
              <span class="set-label">监听</span>
              <input id="netHost" style="flex:1;min-width:120px" value="${esc(L.wanted)}" placeholder="0.0.0.0" autocomplete="off" spellcheck="false" ${locked ? 'disabled' : ''} />
              <div class="seg" id="netHostSeg">
                <button type="button" data-host="0.0.0.0" class="${L.wanted === '0.0.0.0' ? 'on' : ''}" ${locked ? 'disabled' : ''}>所有网卡</button>
                <button type="button" data-host="127.0.0.1" class="${L.wanted === '127.0.0.1' ? 'on' : ''}" ${locked ? 'disabled' : ''}>只听本机</button>
              </div>
            </div>
            ${pending}
            <div class="set-row"><p class="hint">现在实际监听 <b>${esc(L.host)}:${esc(String(L.port ?? ''))}</b>。
            <code>0.0.0.0</code> = 局域网和手机都能连（要登录）；<code>127.0.0.1</code> = 只有这台机器能打开。
            ${srcText}</p></div>
            ${
              locked
                ? '<div class="set-row"><p class="hint">这台改不了 —— 监听地址被启动参数占着。去掉那个变量（或 <code>bandi reset-host</code>）重启后，这里就能改了。</p></div>'
                : `<div class="set-row" style="justify-content:flex-end"><button class="primary" id="netHostSave">保存${L.needRestart ? '并重启' : ''}</button></div>`
            }
            <div class="hint-line" id="netHostMsg"></div>
          </div>
        </section>`;
      })();

  /*
   * 网络访问（2026-11-03，对齐 1Panel 安全页的「授权 IP / 域名绑定」）：
   * 网络周界闸（security/ipallow.mjs，E3003 / E3004）的界面。只做三件事：
   * 把名单和域名摆出来让人改、把"你会被自动加进名单"说清楚、保存即生效。
   * 监听地址不在这张卡里 —— 它在上面单独的「监听地址」卡（2026-11-04 改）。
   */
  const netHtml = !isAdmin
    ? ''
    : !lan
      ? `<section class="set-sec">
          <div class="set-head"><b>网络访问</b><span class="set-tag">仅管理员</span></div>
          <div class="set-box"><div class="empty">拉不到网络状态（/api/lan），稍后再试。</div></div>
        </section>`
      : `<section class="set-sec">
          <div class="set-head"><b>网络访问</b><span class="set-tag">网络周界 · 保存即生效</span></div>
          <div class="set-box">
            <div class="set-row">
              <span class="set-label">可访问地址</span>
              <div class="machine-data machine-addr">${
                lan.boundLan
                  ? (lan.urls ?? []).map(esc).join('<br />') || `${esc(String(lan.host ?? ''))}:${esc(String(lan.port ?? ''))}`
                  : `只有这台机器：<br />http://127.0.0.1:${esc(String(lan.port ?? ''))}`
              }<span class="sub">（监听 ${esc(String(lan.host ?? ''))}，要改看上面那张卡）</span></div>
            </div>
            <div class="set-row">
              <span class="set-label">授权 IP 白名单</span>
              <div class="seg" id="netWlSeg">
                <button data-wl="1" class="${lan.whitelistEnabled ? 'on' : ''}">开启</button>
                <button data-wl="0" class="${!lan.whitelistEnabled ? 'on' : ''}">关闭</button>
              </div>
            </div>
            <div class="set-row" style="flex-direction:column;align-items:flex-start;gap:6px">
              <span class="set-label">名单（每行一个 IP 或网段）</span>
              <textarea id="netWlIps" rows="4" placeholder="192.168.5.9&#10;192.168.5.0/24" style="resize:vertical" spellcheck="false">${esc((lan.whitelistIps ?? []).join('\n'))}</textarea>
            </div>
            <div class="set-row">
              <span class="set-label">域名绑定</span>
              <input id="netDomain" style="flex:1;min-width:120px" value="${esc(lan.boundDomain ?? '')}" placeholder="如 pan.example.com（留空 = 不绑定）" autocomplete="off" spellcheck="false" />
            </div>
            <div class="set-row" style="justify-content:flex-end">
              <button class="primary" id="netSave">保存</button>
            </div>
            <div class="set-row"><p class="hint">开启白名单后，名单之外的 IP 连登录页都摸不到（403）；本机直连永远放行，
            开启时会自动把你现在的 IP（${esc(lan.yourIp || '未知')}）写进名单防锁死。设了域名绑定后，只有本机直连和用这个域名访问能打开面板。
            配了可信反代（BANDI_TRUST_PROXY）时按 X-Forwarded-For 取真实来源，且反代必须覆写转发头。</p></div>
            <div class="hint-line" id="netMsg"></div>
          </div>
        </section>`;

  /*
   * 页签（2026-11-03 用户："右边这个做成tab"）：admin 的三块内容（网络访问 / 我的会话 /
   * 审计日志）竖着摆太长，改成 .tabs 页签横排，一次看一块。默认「网络访问」。
   * 非 admin 只有「我的会话」一块，不铺页签条。
   */
  const tabsHtml = !isAdmin
    ? ''
    : `<div class="tabs" id="secTabs">
        <button class="tab on" data-tab="net" type="button">网络访问</button>
        <button class="tab" data-tab="sess" type="button">我的会话</button>
        <button class="tab" data-tab="audit" type="button">审计日志</button>
      </div>`;

  /*
   * 外壳（2026-11-03 用户："让滚动只发生在日志区，上面的不动"）：页头 + 页签条钉在顶上，
   * 只有下面的内容区（.sec-scroll）滚 —— #settingsView 自己不再出滚动条。
   * 非 admin 没有页签条，但页头照样钉住、内容照样内部滚，行为一致。
   */
  $('settingsView').innerHTML = `
    <div class="sec-shell">
      ${head()}
      ${tabsHtml}
      <div class="detail-body sec-scroll">
        <div id="secPanel-net" ${isAdmin ? '' : 'hidden'}>${isAdmin ? listenHtml + netHtml : ''}</div>
        <div id="secPanel-sess" ${isAdmin ? 'hidden' : ''}>
          <section class="set-sec">
            <div class="set-head"><b>我的会话</b><span class="set-tag">空闲 30 分钟 / 绝对 12 小时自动失效</span></div>
            <div class="set-box">
              ${sessionRows}
              <div class="set-row" style="justify-content:flex-end">
                <button id="kickOthers" ${sessions.length <= 1 ? 'disabled' : ''}>踢掉其它设备</button>
              </div>
              <div class="set-row"><p class="hint">改密码 / 改角色会让所有会话立刻失效；在别的设备上怀疑有异常时，先在这里踢掉，再改密码。</p></div>
            </div>
          </section>
        </div>
        <div id="secPanel-audit" ${isAdmin ? 'hidden' : ''}>${auditHtml}</div>
      </div>
    </div>`;

  /* 页签切换：只翻显示，不重渲染（面板里的数据 / 接线都是现成的） */
  const tabbar = $('secTabs');
  if (tabbar) {
    tabbar.querySelectorAll('.tab').forEach((t) => {
      t.onclick = () => {
        tabbar.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === t));
        ['net', 'sess', 'audit'].forEach((k) => {
          const p = $(`secPanel-${k}`);
          if (p) p.hidden = k !== t.dataset.tab;
        });
      };
    });
  }

  /* 网络访问卡的接线（admin 且拉到 lan 才有这些节点） */
  if (isAdmin && lan) {
    /*
     * ---- 监听地址（2026-11-04）----
     * 保存 → 需要时重启控制面 → 轮询等它回来。重启接口只给被 systemd / 桌面壳
     * 监护的进程放行（E1061），无人看管的情况如实报错，让人用 `bandi restart`。
     */
    const hostInput = $('netHost');
    if (hostInput) {
      const hostSeg = $('netHostSeg');
      const syncSeg = () =>
        hostSeg.querySelectorAll('[data-host]').forEach((x) => x.classList.toggle('on', x.dataset.host === hostInput.value.trim()));
      hostSeg.querySelectorAll('[data-host]').forEach((b) => {
        b.onclick = () => {
          hostInput.value = b.dataset.host;
          syncSeg();
        };
      });
      hostInput.oninput = syncSeg;

      const saveBtn = $('netHostSave'); // 被启动参数钉着时不渲染这个按钮（文案代替），判空
      if (saveBtn) saveBtn.onclick = async () => {
        const want = hostInput.value.trim();
        const msg = $('netHostMsg');
        if (!want) return toast('给一个监听地址：0.0.0.0 / 127.0.0.1 / 具体 IP', 'error');
        /*
         * 防呆：**从别的机器访问面板、又改成只听本机** —— 重启那一下你自己就再也连不上了。
         * 本机直连不拦（那是正常用法），其它来源强确认（1Panel 也有同样的坑）。
         */
        const loopbackSrc = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(lan.yourIp ?? ''));
        if (want === '127.0.0.1' && !loopbackSrc) {
          const ok = await confirmDo(
            `你现在是从 ${lan.yourIp} 远程打开这个页面的。改成「只听本机」并重启后，这个地址就再也打不开了 —— 只能到那台机器上操作（或走 SSH 隧道）。确认？`,
            { ok: '仍然改成只听本机' },
          );
          if (!ok) return;
        }
        saveBtn.disabled = true;
        try {
          const r = await post('/api/lan', { listenHost: want });
          if (!r?.needRestart) {
            toast('保存了 —— 当前就听着这个地址，不用重启');
            saveBtn.disabled = false;
            return;
          }
          msg.textContent = '正在重启控制面…';
          await post('/api/control-plane/restart', {});
          await waitForRestart();
        } catch (e) {
          msg.textContent = '';
          toast(e.message, 'error');
          saveBtn.disabled = false;
        }
      };
    }

    const wlSeg = $('netWlSeg');
    wlSeg.querySelectorAll('[data-wl]').forEach((b) => {
      b.onclick = () => {
        wlSeg.querySelectorAll('[data-wl]').forEach((x) => x.classList.toggle('on', x === b));
      };
    });
    $('netSave').onclick = async () => {
      const enable = wlSeg.querySelector('[data-wl="1"]').classList.contains('on');
      const ips = $('netWlIps').value.split('\n').map((s) => s.trim()).filter(Boolean);
      const domain = $('netDomain').value.trim();
      const msg = $('netMsg');
      /*
       * **首次开启要确认**：白名单是少数"存错了就把所有人关在门外"的开关 ——
       * 服务端虽然会自动把当前 IP 写进名单，但多一次"知道自己在干什么"不过分。
       */
      if (enable && !lan.whitelistEnabled) {
        const ok = await confirmDo(
          `开启后，只有名单里的 IP（会自动加上你现在的 IP ${lan.yourIp || '未知'}）和本机直连能访问面板，其它一律 403。确认开启？`,
          { ok: '开启白名单' },
        );
        if (!ok) return;
      }
      $('netSave').disabled = true;
      try {
        const r = await post('/api/lan', { whitelistEnabled: enable, whitelistIps: ips, boundDomain: domain });
        toast(r?.addedYourIp ? `已保存，自动把你的 IP ${r.addedYourIp} 加进了名单` : '已保存', 'ok');
        renderSecurity(); // 重画：名单归一化后的写法以服务端那份为准
      } catch (e) {
        toast(e.message, 'error');
        $('netSave').disabled = false;
      }
    };
  }


  $('kickOthers').onclick = async () => {
    confirmDo('把其它设备上的登录全部踢下线？当前这台不受影响。', async () => {
      try {
        const r = await api('/api/security/sessions/revoke-others', { method: 'POST' });
        toast(`已踢下 ${r?.kicked ?? 0} 个其它会话`);
        renderSecurity();
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  };

  if (!isAdmin) return;

  /* ---- 审计列表（admin）：拉取 + 渲染 + 类型筛选 + 游标翻页 ---- */
  let curKind = '';
  const listHost = $('auditList');
  const moreBtn = $('auditMore');
  const renderRows = (events, append) => {
    const rows = events.length
      ? events
          .map(
            (e) => `<div class="set-row" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              ${resultDot(e.result)}<b>${esc(KIND_LABEL[e.kind] ?? e.kind)}</b>
              <span style="color:var(--dim);font-size:12px">${esc(e.action ?? '')}</span>
              <span style="color:${e.result === 'ok' ? 'var(--ok, #34a853)' : '#d93025'};font-size:12px">${RESULT_LABEL[e.result] ?? e.result}</span>
              ${e.reason || e.ip ? `<span style="color:var(--dim);font-size:12px">${[e.reason, e.ip].filter(Boolean).map(esc).join(' · ')}</span>` : ''}
              <span style="margin-left:auto;color:var(--dim);font-size:12px;flex-shrink:0">${dt(e.at)}</span>
            </div>`,
          )
          .join('')
      : `<div class="set-row"><span class="hint">${append ? '没有更早的了。' : '还没有记录。'}</span></div>`;
    if (append) listHost.insertAdjacentHTML('beforeend', rows);
    else listHost.innerHTML = rows;
    const last = events[events.length - 1];
    moreBtn.style.display = events.length >= 50 && last ? '' : 'none';
    moreBtn.onclick = () => loadEvents(last?.at);
  };
  const loadEvents = async (before = '') => {
    try {
      const data = await api(`/api/security/audit?limit=50${curKind ? `&kind=${encodeURIComponent(curKind)}` : ''}${before ? `&before=${encodeURIComponent(before)}` : ''}`);
      renderRows(data?.events ?? [], !!before);
    } catch (e) {
      listHost.innerHTML = `<div class="set-row"><div class="empty">${failHtml(e)}</div></div>`;
    }
  };
  /* 类型筛选：公共 createCombo 挂在标题行，选中即刷列表 */
  createCombo({
    mount: $('auditKindMount'),
    items: [{ id: '', label: '全部' }, ...Object.entries(KIND_LABEL).map(([k, label]) => ({ id: k, label }))],
    value: curKind,
    right: true, /* 贴着卡片右缘，浮层往左展开才不会顶出视口 */
    onChange: (id) => {
      curKind = id;
      loadEvents();
    },
  });

  /*
   * 导出（2026-11-03）：按**当前类型筛选**拉全量（服务端上限 5000 行），前端拼 CSV 下载。
   * 放 BOM 是因为 Excel 不认无 BOM 的 UTF-8 —— 中文表头会变乱码。
   */
  $('auditExport').onclick = async () => {
    const btn = $('auditExport');
    btn.disabled = true;
    try {
      const d = await api(`/api/security/audit/export${curKind ? `?kind=${encodeURIComponent(curKind)}` : ''}`);
      const rows = d?.events ?? [];
      if (!rows.length) {
        toast('没有可导出的记录', 'error');
        return;
      }
      const csvCell = (v) => {
        const s = String(v ?? '');
        return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const header = ['时间', '类型', '动作', '结果', '主体', '主体 ID', '资源', 'HTTP', '原因', 'IP'];
      const lines = [
        header.join(','),
        ...rows.map((e) =>
          [
            e.at,
            KIND_LABEL[e.kind] ?? e.kind,
            e.action,
            RESULT_LABEL[e.result] ?? e.result,
            e.actorKind,
            e.actorId,
            e.resource,
            e.httpStatus,
            e.reason,
            e.ip,
          ]
            .map(csvCell)
            .join(','),
        ),
      ];
      const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `审计日志-${new Date().toISOString().slice(0, 10)}${curKind ? `-${KIND_LABEL[curKind] ?? curKind}` : ''}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast(`已导出 ${rows.length} 条`, 'ok');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  };

  /* 清空：服务端先归档再删，主表会留一条「清空」痕迹 —— 刷新后仍能看到这一行，别当成没清掉 */
  $('auditClear').onclick = async () => {
    const ok = await confirmDo(
      '清空全部审计日志？记录会先搬进归档表（仍可事后追溯），主表只留一条「清空」痕迹。',
      { ok: '清空' },
    );
    if (!ok) return;
    $('auditClear').disabled = true;
    try {
      const r = await post('/api/security/audit/clear', {});
      toast(`已清空 ${r?.cleared ?? 0} 条审计日志`, 'ok');
      await loadEvents();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      $('auditClear').disabled = false;
    }
  };

  loadEvents();
}
