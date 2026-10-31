/* securityadmin.mjs —— 设置 › 安全（2026-10-31，IAM §9 / §11.2 Phase 1 收尾）。
 *
 * 两块：
 *   · **我的会话** —— 在哪些设备上登着（指纹 / 时间 / IP），「踢掉其它设备」一键收权；
 *     每个登录账号都能看自己的（服务端只认会话里的 userId，不从参数拿）。
 *   · **审计日志**（仅管理员）—— 谁、什么时候、做了什么、成没成。策略层自动记
 *     （401/403 拒绝、写操作 pending→回填），这里只是查询窗口：按类型筛 + 游标翻页。
 *
 * 版式沿 useradmin.mjs 的 set-sec 卡片；错误一律「码 + 中文」toast，不用 alert。
 */
import { esc, toast } from './shell.mjs';
import { api, dt, failHtml } from './ui.mjs';
import { confirmDo } from './machine.mjs';
import { $, S } from './core.mjs';

const head = (actions = '') =>
  `<div class="detail-head head-row"><div class="head-title"><b>安全</b></div>${
    actions ? `<div class="head-actions">${actions}</div>` : ''
  }</div>`;

/** 审计类型的中文名（与服务端 auditKindOf 同源，查询值直接用英文 kind） */
const KIND_LABEL = {
  login: '登录',
  'session.revoke': '退出/踢下线',
  'user.change': '账号变更',
  'machine.local': '本机操作',
  collab: '协作',
  restart: '重启',
  write: '写操作',
  'authz.deny': '拒绝访问',
  'audit.archive': '归档',
};

const RESULT_LABEL = { ok: '成功', fail: '失败', deny: '已拦截', pending: '进行中' };

/** 结果的小圆点（绿=ok、红=fail/deny、灰=pending）—— 汉字之外一眼能扫的那一位 */
const resultDot = (r) => `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:${
  r === 'ok' ? 'var(--ok, #34a853)' : r === 'pending' ? 'var(--dim)' : '#d93025'
}"></span>`;

export async function renderSecurity() {
  $('settingsView').innerHTML = `${head()}<div class="empty" style="padding:24px 4px">加载中…</div>`;
  const isAdmin = !!S.isAdmin && !S.isDevice;

  /* 会话必加载；审计只有 admin 拉 —— 非 admin 不发那一条请求（发了也是 403 toast） */
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
              <b>${esc(s.kind === 'browser' ? '浏览器' : s.kind)}</b>
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
        <div class="set-head"><b>审计日志</b><span class="set-tag">仅管理员 · 保留 90 天</span></div>
        <div class="set-box">
          <div class="set-row">
            <span class="set-label">类型</span>
            <select id="auditKind" style="flex:1;max-width:240px">
              <option value="">全部</option>
              ${Object.entries(KIND_LABEL).map(([k, label]) => `<option value="${k}">${label}</option>`).join('')}
            </select>
          </div>
          <div id="auditList"></div>
          <div class="set-row" style="justify-content:center"><button id="auditMore" style="display:none">加载更早</button></div>
        </div>
      </section>`;

  $('settingsView').innerHTML = `
    ${head()}
    <div class="detail-body">
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
      ${auditHtml}
    </div>`;

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
            (e) => `<div class="set-row" style="flex-direction:column;align-items:flex-start;gap:2px">
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                ${resultDot(e.result)}<b>${esc(KIND_LABEL[e.kind] ?? e.kind)}</b>
                <span style="color:var(--dim);font-size:12px">${esc(e.action ?? '')}</span>
              </div>
              <span style="color:var(--dim);font-size:12px">${dt(e.at)} · ${RESULT_LABEL[e.result] ?? e.result}${e.reason ? ` · ${esc(e.reason)}` : ''}${e.ip ? ` · ${esc(e.ip)}` : ''}</span>
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
  $('auditKind').onchange = (el) => {
    curKind = el.target.value;
    loadEvents();
  };
  loadEvents();
}
