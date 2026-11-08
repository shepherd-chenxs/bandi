/* securityadmin.mjs —— 设置 › 安全（2026-10-31，IAM §9 / §11.2 Phase 1 收尾）。
 *
 * 两块（2026-11-07 起：远程连接卡迁去「这台机器」页、原「网络访问」卡删掉，只剩这两个）：
 *   · **我的会话** —— 在哪些设备上登着（指纹 / 时间 / IP），「踢掉其它设备」一键收权；
 *     每个登录账号都能看自己的（服务端只认会话里的 userId，不从参数拿）。
 *   · **审计日志**（仅管理员）—— 谁、什么时候、做了什么、成没成。策略层自动记
 *     （401/403 拒绝、写操作 pending→回填），这里只是查询窗口：按类型筛 + 游标翻页。
 * 另导出 mountRemoteAccessCard（远程连接监听开关卡），由 connectors.mjs 的「这台机器」页挂载。
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

/*
 * 远程连接卡（2026-11-07 二迁：原「监听地址」→ 安全页的开关卡 → 「这台机器」页顶。
 * 用户："把远程连接放到这台设备里"）—— 渲染 + 接线都收在这一个入口，谁要挂谁调。
 *
 * 参考是网易UU远程那张「本设备 · 允许他人远程协助 [开关]」（2026-11-08 定稿：
 * 一张单行卡，左标签「允许同账号设备连接」、右侧开关，跟「运行时」区同款；
 * 常显说明文案删掉了，只有待重启 / 被 BANDI_HOST 钉住这两个异常态才追加说明行）。
 * 监听地址本来就只有两个有意义的值，开关二态正好一一映射：
 *   开 = 0.0.0.0（局域网和手机都能连） / 关 = 127.0.0.1（只听本机）。
 * 拨动即保存，不需要单独的「保存」。
 *
 * 真源在数据目录的 `config.json.listenHost`（服务端 `writeListenHost`），**不是** systemd
 * 单元：单元每次重装都会被 `deploy/install.sh` 重写，11-04 就是这么把 0.0.0.0 写回
 * 127.0.0.1、局域网全断的。`BANDI_HOST` 环境变量钉着时开关只读并说清原因。
 *
 * 权限：POST /api/lan 要 machine:manage，非 admin 连 GET 都不保障 —— 拉不到就静默不画。
 */
export async function mountRemoteAccessCard(mount) {
  if (!mount || !S.isAdmin) return;
  const lan = await api('/api/lan').catch(() => null);
  if (!lan?.listen) return;
  const L = lan.listen;
  const locked = L.editable === false;
  const open = L.wanted !== '127.0.0.1'; // 开 = 对外；存过自定义 IP 也算开
  const pending = L.needRestart
    ? `<div class="set-row"><p class="hint" style="color:var(--warn)">已存成 <b>${esc(L.wanted)}</b>，但当前进程还听着 <b>${esc(L.host)}</b> —— 重启控制面才生效。</p></div>`
    : '';
  /* 2026-11-08 用户："左侧显示：允许同账号设备连接，开关放入卡片"，常显说明文案删掉 ——
     跟下面「运行时」区同款：一张单行卡，左标签右开关。只有异常态（待重启 / 被 BANDI_HOST
     钉住）才追加说明行，平时卡里就一行。 */
  mount.innerHTML = `<section class="set-sec">
    <div class="set-head"><b>远程连接</b><span class="set-tag">改了要重启控制面</span></div>
    <div class="set-box">
      <div class="set-row">
        <span class="set-label">允许同账号设备连接</span>
        <label class="switch" style="margin:0" title="${locked ? '被 BANDI_HOST 钉着，拨不动' : open ? '开着：局域网和手机都能连' : '关着：只有这台机器能打开'}">
          <input type="checkbox" id="netRemoteSw" ${open ? 'checked' : ''} ${locked ? 'disabled' : ''} />
          <span></span>
        </label>
      </div>
      ${pending}
      ${
        locked
          ? '<div class="set-row"><p class="hint">这台拨不动 —— 监听地址被启动参数 <code>BANDI_HOST</code> 占着。去掉那个变量（或 <code>bandi reset-host</code>）重启后，这里就能改了。</p></div>'
          : ''
      }
      <div class="hint-line" id="netHostMsg" style="display:none"></div>
    </div>
  </section>`;

  /*
   * 接线：拨动即保存 → 需要时重启控制面 → 轮询等它回来。重启接口只给被 systemd / 桌面壳
   * 监护的进程放行（E1061），无人看管的情况如实报错，让人用 `bandi restart`。
   */
  const remoteSw = $('netRemoteSw');
  if (!remoteSw) return;
  /* 提示行平时不占位（2026-11-08 用户："垂直居中"—— 空 hint-line 的 margin 会把行顶得偏上） */
  const showMsg = (t) => {
    const el = $('netHostMsg');
    if (!el) return;
    el.textContent = t;
    el.style.display = t ? '' : 'none';
  };
  remoteSw.onchange = async () => {
    const want = remoteSw.checked ? '0.0.0.0' : '127.0.0.1';
    if (want === String(lan.listen?.wanted ?? '')) return; // 拨回原位，没有实际变化
    /*
     * 防呆：**从别的机器访问面板、又把开关关掉（只听本机）** —— 重启那一下你自己就
     * 再也连不上了。本机直连不拦（那是正常用法），其它来源强确认（1Panel 也有同样的坑）。
     */
    const loopbackSrc = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(lan.yourIp ?? ''));
    if (!remoteSw.checked && !loopbackSrc) {
      const ok = await confirmDo(
        `你现在是从 ${lan.yourIp} 远程打开这个页面的。关掉远程连接并重启后，这个地址就再也打不开了 —— 只能到那台机器上操作（或走 SSH 隧道）。确认？`,
        { ok: '仍然关掉' },
      );
      if (!ok) {
        remoteSw.checked = true; // 取消：开关弹回「开」
        return;
      }
    }
    remoteSw.disabled = true;
    try {
      const r = await post('/api/lan', { listenHost: want });
      if (!r?.needRestart) {
        toast('保存了 —— 当前就听着这个地址，不用重启');
        remoteSw.disabled = false;
        return;
      }
      showMsg('正在重启控制面…');
      await post('/api/control-plane/restart', {});
      await waitForRestart();
    } catch (e) {
      showMsg('');
      toast(e.message, 'error');
      remoteSw.checked = !remoteSw.checked; // 失败：开关拨回去
      remoteSw.disabled = false;
    }
  };
}

export async function renderSecurity() {
  $('settingsView').innerHTML = `${head()}<div class="empty" style="padding:24px 4px">加载中…</div>`;
  const isAdmin = !!S.isAdmin;

  /* 会话必加载；审计只有 admin 拉 —— 非 admin 不发那一条请求（发了也是 403 toast）。
     远程连接卡 2026-11-07 迁去「这台机器」页（mountRemoteAccessCard），安全页不再拉 /api/lan。 */
  const [sess, audit] = await Promise.all([
    api('/api/security/sessions').catch(() => null),
    isAdmin ? api('/api/security/audit?limit=50').catch(() => null) : Promise.resolve(null),
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
   * 页签（2026-11-03 用户："右边这个做成tab"）：admin 的内容竖着摆太长，
   * 改成 .tabs 页签横排，一次看一块。默认「我的会话」。
   * （2026-11-07 用户："这个没啥用可以删掉了"—— 原「网络访问」卡（IP 白名单 / 域名绑定）
   * 整张撤掉；同日「远程连接」卡迁去「这台机器」页（mountRemoteAccessCard）——
   * 两张卡都走了，这里只剩「我的会话 / 审计日志」。服务端 ipallow 周界闸没动，只是没了界面。）
   * 非 admin 只有「我的会话」一块，不铺页签条。
   */
  const tabsHtml = !isAdmin
    ? ''
    : `<div class="tabs" id="secTabs">
        <button class="tab on" data-tab="sess" type="button">我的会话</button>
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
        <div id="secPanel-sess">
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
        ['sess', 'audit'].forEach((k) => {
          const p = $(`secPanel-${k}`);
          if (p) p.hidden = k !== t.dataset.tab;
        });
      };
    });
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
