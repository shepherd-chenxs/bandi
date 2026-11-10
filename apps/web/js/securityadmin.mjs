/* securityadmin.mjs —— 设置 › 安全（2026-10-31，IAM §9 / §11.2 Phase 1 收尾）。
 *
 * 两块（2026-11-07 起：远程连接卡迁去「这台机器」页、原「网络访问」卡删掉，只剩这两个）：
 *   · **我的会话** —— 在哪些设备上登着（指纹 / 时间 / IP），「踢掉其它设备」一键收权；
 *     每个登录账号都能看自己的（服务端只认会话里的 userId，不从参数拿）。
 *   · **审计日志**（仅管理员）—— 谁、什么时候、做了什么、成没成。策略层自动记
 *     （401/403 拒绝、写操作 pending→回填），这里只是查询窗口：按类型筛 + 游标翻页。
 *     2026-11-09 降噪：静态资源 401 不再入审计；同 IP+动作的拒绝在 60 秒窗口内只落一行
 *     （窗口过后补一句"另有 N 次"）；归档保留 1 个月（主表 90 天）。
 *     2026-11-10：清空改为**彻底删除**（主表 + 归档一起删、不留 audit.clear 痕迹；确认文案写明不可恢复）。
 * 另导出 mountRemoteAccessCard（远程连接开关卡，2026-11-08 起是**纯运行期开关、不重启**），
 * 由 connectors.mjs 的「这台机器」页挂载。
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
 * 远程连接卡（2026-11-08 三改：从「改 bind 地址 + 重启控制面」降成**纯应用层开关**）。
 *
 * 参考是 WorkBuddy 那张「允许同账号设备远程连接 [开关]」：拨一下立刻生效，不重启。
 * 旧实现把开关映射到 `listen()` 的 bind 地址（0.0.0.0 / 127.0.0.1），bind 是进程启动
 * 时定死的，所以每次都要重启 —— 用户 2026-11-08："这个不划算"。
 *
 * 新语义：bind **永远不动**（缺省 0.0.0.0），开关只控制 `netmode.json` 的
 * `remoteAccess` —— 服务端 `guardNetwork` 在请求入口判这一个布尔：关 = 非本机来源
 * 一律 403（E3005），本机直连永远放行。运行期判定，**立即生效**。
 *
 * 唯一拨不动的形态：进程的 bind 本身就在回环上（`BANDI_HOST=127.0.0.1` 或历史配置
 * 把 listenHost 钉成了 127.0.0.1）—— 远程本来就进不来，开关没有可管的东西，禁用
 * 并说清原因（`bandi reset-host` 或去掉环境变量重启后恢复）。
 *
 * 权限：POST /api/lan 要 machine:manage，非 admin 连 GET 都不保障 —— 拉不到就静默不画。
 */
export async function mountRemoteAccessCard(mount) {
  if (!mount || !S.isAdmin) return;
  const lan = await api('/api/lan').catch(() => null);
  if (!lan?.listen) return;
  const open = lan.remoteAccess !== false;
  /* bind 在回环上 = 远程物理上进不来，开关是摆设（调试场景才有，见上） */
  const loopbackOnly = !lan.boundLan;
  /* 2026-11-08 用户："就只是一个开关，像 WorkBuddy 那样"；同日："这个标签去掉" ——
     卡头只剩「远程连接」四个字，平时卡里就一行 */
  mount.innerHTML = `<section class="set-sec">
    <div class="set-head"><b>远程连接</b></div>
    <div class="set-box">
      <div class="set-row">
        <span class="set-label">允许同账号设备连接</span>
        <label class="switch" style="margin:0" title="${loopbackOnly ? '这个进程只听本机，远程本来就进不来' : open ? '开着：局域网和手机都能连' : '关着：只有这台机器能打开'}">
          <input type="checkbox" id="netRemoteSw" ${open ? 'checked' : ''} ${loopbackOnly ? 'disabled' : ''} />
          <span></span>
        </label>
      </div>
      ${
        loopbackOnly
          ? '<div class="set-row"><p class="hint">这个拨不动 —— 进程的监听地址被钉在了本机（<code>BANDI_HOST=127.0.0.1</code> 或历史配置），别的设备物理上进不来。去掉那个变量（或 <code>bandi reset-host</code>）重启后，这里就能管了。</p></div>'
          : ''
      }
      <div class="hint-line" id="netHostMsg" style="display:none"></div>
    </div>
  </section>`;

  const remoteSw = $('netRemoteSw');
  if (!remoteSw) return;
  /* 提示行平时不占位（空 hint-line 的 margin 会把行顶得偏上） */
  const showMsg = (t) => {
    const el = $('netHostMsg');
    if (!el) return;
    el.textContent = t;
    el.style.display = t ? '' : 'none';
  };
  remoteSw.onchange = async () => {
    const want = remoteSw.checked;
    if (want === (lan.remoteAccess !== false)) return; // 拨回原位，没有实际变化
    /*
     * 防呆（旧实现就有，新语义下更得留）：**从别的机器访问面板、又把开关关掉** ——
     * 保存成功那一刻你自己就被 E3005 拒之门外。本机直连不拦，其它来源强确认。
     */
    const loopbackSrc = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(lan.yourIp ?? ''));
    if (!want && !loopbackSrc) {
      const ok = await confirmDo(
        `你现在是从 ${lan.yourIp} 远程打开这个页面的。关掉后这个地址立刻就连不上了 —— 只能到那台机器上操作（或走 SSH 隧道）。确认？`,
        { ok: '仍然关掉' },
      );
      if (!ok) {
        remoteSw.checked = true; // 取消：开关弹回「开」
        return;
      }
    }
    remoteSw.disabled = true;
    try {
      await post('/api/lan', { remoteAccess: want });
      lan.remoteAccess = want;
      toast(want ? '已打开 —— 别的设备现在就能连' : '已关闭 —— 现在只有这台机器能访问', 'ok');
    } catch (e) {
      toast(e.message, 'error');
      remoteSw.checked = !remoteSw.checked; // 失败：开关拨回去
    } finally {
      if (!loopbackOnly) remoteSw.disabled = false;
      showMsg('');
    }
  };
}

/** 审计类型的中文名（与服务端 auditKindOf / store/audit.mjs 同源，查询值直接用英文 kind） */const KIND_LABEL = {
  login: '登录',
  'session.revoke': '退出/踢下线',
  'user.change': '账号变更',
  'machine.local': '本机操作',
  restart: '重启',
  write: '写操作',
  'authz.deny': '拒绝访问',
  'audit.archive': '归档',
  'audit.prune': '归档清理',
  'audit.clear': '清空',
};

const RESULT_LABEL = { ok: '成功', fail: '失败', deny: '已拦截', pending: '进行中' };

/** 结果的小圆点（绿=ok、红=fail/deny、灰=pending）—— 汉字之外一眼能扫的那一位 */
const resultDot = (r) => `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:${
  r === 'ok' ? 'var(--ok, #34a853)' : r === 'pending' ? 'var(--dim)' : '#d93025'
}"></span>`;

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
          <b>审计日志</b><span class="set-tag">仅管理员 · 主表 90 天 / 归档 1 个月 · 清空=彻底删除</span>
          <!-- 导出 / 清空（2026-11-03；2026-11-10 清空改为真删除）：导出按当前类型筛选走全量；清空是破坏性动作，二次确认 -->
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

  /*
   * 清空（2026-11-10 用户口径：真清空、不留备份）：
   * 二次确认 → 服务端把主表 + 归档表一起删（不留 audit.clear 痕迹），
   * 再 WAL checkpoint + VACUUM 回收旧页。确认文案必须把"不可恢复"说清楚。
   */
  $('auditClear').onclick = async () => {
    const ok = await confirmDo(
      '彻底清空全部审计日志？\n\n主表和归档会一起删除，' +
        '删除后不可恢复、也不留「清空」痕迹。',
      { ok: '彻底清空' },
    );
    if (!ok) return;
    $('auditClear').disabled = true;
    try {
      const r = await post('/api/security/audit/clear', {});
      toast(`已彻底清空 ${r?.cleared ?? 0} 条（含归档 ${r?.archived ?? 0} 条）`, 'ok');
      await loadEvents();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      $('auditClear').disabled = false;
    }
  };

  loadEvents();
}
