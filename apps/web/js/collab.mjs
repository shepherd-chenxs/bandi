/* collab.mjs —— 协作中心（总公司 / 分公司）的前端（2026-10-31 MVP）。
 *
 * 两个半边，同一个文件（任务书 §8：由同一个人顺序做，别让两个人同时改这个文件）：
 *   · **中心**：工作台 → 协作中心（`openCollabPage`）—— 分公司名录 + 我派出去的活；
 *   · **分公司**：设置 → 这台机器 → 协作（`renderCollabSection`）—— 加入 / 状态 / 退出。
 *
 * 两边的口径差别（照任务书 §2.1，别再回头改）：
 *   · 卡的内容归中心：分公司只能改状态、执行人、评论、走流程；
 *   · 中心只握两个终态（验收「已完成」/ 取消「已取消」），过程状态归分公司；
 *   · 破坏性动作一律 `confirmDo`，**不用 alert / 原生 confirm**。
 */
import { esc, toast, savePlace, setRoute } from './shell.mjs';
import { api, post, wireDialogHead } from './ui.mjs';
import { breadcrumb, headRow } from './connectors.mjs';
import { confirmDo } from './machine.mjs';
import { showView } from './contacts.mjs';
import { openProjectDetail } from './projects.mjs';
import { wbCard } from './workflows.mjs';
import { $, S } from './core.mjs';

/* 协作的图标（2026-10-31）：两栋楼之间一条线 —— "把这边的活递给那边的机器"。
   画法与 ui.mjs 里那批磁贴图标一致：只填路径、描边 currentColor。 */
const ICON_WB_COLLAB =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="6.4" height="15" rx="1.4"/><rect x="14.6" y="7.5" width="6.4" height="12" rx="1.4"/><path d="M9.4 12h5.2M12.8 10.2 14.7 12l-1.9 1.8"/></svg>';

/** 时间戳给人看的样子（`2026-10-31T09:44:37.380Z` → `10-31 17:44`） */
function when(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 终态：到了这两个状态，两边都不能再改（任务书 §2.1） */
const TERMINAL = new Set(['已完成', '已取消']);

/**
 * 状态胶囊的配色：终态绿/灰、要人等黄、挂了红。
 * 只用现有变量，不引新色 —— 深色主题下也自动对。
 */
function statusPill(status) {
  const s = String(status ?? '');
  const color =
    s === '已完成' ? 'var(--ok)'
      : s === '已取消' ? 'var(--dim)'
        : s === '失败' ? 'var(--bad)'
          : s === '待验收' || s === '已阻塞' ? 'var(--warn)'
            : 'var(--text)';
  return `<span class="pill" style="color:${color}">${esc(s || '—')}</span>`;
}

/* ============================================================ 工作台磁贴 */

/**
 * 工作台宫格里的一组「协作」。
 *
 * 只有 operator / admin 看得到（判据在 `renderWorkbenchGrid` 里 —— `limitedByRole` 与
 * `devMode` 都不画这一组），与接口层的 `mayManage` 对齐：看得到 = 点得进去。
 */
export function workbenchCollabSection() {
  return `
    <div class="wb-sec">协作</div>
    <div class="wb-grid">
      ${wbCard('collab', ICON_WB_COLLAB, '协作中心', '把活派给分公司，看进度', 'data-wb-collab')}
    </div>`;
}

/* ============================================================== 中心页 */

export async function openCollabPage() {
  setRoute('collab');
  /* 工作台子页：把项目 / 看板 / 插件那几条"恢复位置"的路清掉，
     否则刷新时会被它们抢走（跟 openSchedules 同款）。 */
  S.plugin = null;
  S.projectList = false;
  S.projectId = null;
  S.boardAll = false;
  savePlace();
  $('pluginView').classList.remove('kb-page');
  showView('plugin');
  await renderCollabCenter();
}

/** 中心页：两块表 —— 分公司名录 + 我派出去的活 */
export async function renderCollabCenter() {
  const view = $('pluginView');
  if (!view) return;
  view.innerHTML = '<div class="empty" style="padding:24px 4px">读取中…</div>';

  let branches = [];
  let tasks = [];
  try {
    const [b, t] = await Promise.all([api('/api/collab/branches'), api('/api/collab/tasks')]);
    branches = b.branches ?? [];
    tasks = t.tasks ?? [];
  } catch (e) {
    view.innerHTML = `${headRow(breadcrumb([{ label: '工作台', to: 'workbench' }, { label: '协作中心' }]))}
      <div class="detail-body"><div class="empty">取不到：${esc(e.message)}</div></div>`;
    return;
  }

  const labelOf = (id) => branches.find((b) => b.id === id)?.label ?? '（分公司已移除）';

  const branchRows = branches.length
    ? branches.map((b) => {
      const removed = !!b.revokedAt;
      const state = removed
        ? '<span class="dim">已移除</span>'
        : b.online
          ? '<span style="color:var(--ok)">● 在线</span>'
          : '<span class="dim">○ 离线</span>';
      return `<tr>
        <td>${esc(b.label)}</td>
        <td class="dim">${esc(b.hostname ?? '—')}</td>
        <td>${state}</td>
        <td class="dim">${esc(when(b.lastSeenAt))}</td>
        <td class="dim">${esc(when(b.joinedAt))}</td>
        <td style="white-space:nowrap">
          ${
            removed
              ? ''
              : `<button class="btn-sm primary" data-cl-assign="${esc(b.id)}">派活</button>
                 <button class="btn-sm" data-cl-revoke="${esc(b.id)}" data-label="${esc(b.label)}">移除</button>`
          }
        </td>
      </tr>`;
    }).join('')
    : `<tr><td colspan="6" class="dim" style="padding:18px 10px">
         还没有分公司 —— 点右上角「＋ 新增分公司」，把一台机器接进来。
       </td></tr>`;

  const taskRows = tasks.length
    ? tasks.map((t) => {
      const done = TERMINAL.has(t.status);
      return `<tr>
        <td>${esc(t.title)}<div class="dim" style="font-size:12px">${esc(String(t.description ?? '').slice(0, 60))}</div></td>
        <td class="dim">${esc(t.branchLabel ?? labelOf(t.branchId))}</td>
        <td>${statusPill(t.status)}</td>
        <td class="dim">${esc(when(t.updatedAt))}</td>
        <td style="white-space:nowrap">
          ${t.status === '待验收' ? `<button class="btn-sm primary" data-cl-done="${esc(t.id)}">验收</button>` : ''}
          ${done ? '' : `<button class="btn-sm" data-cl-cancel="${esc(t.id)}" data-title="${esc(t.title)}">取消</button>`}
        </td>
      </tr>`;
    }).join('')
    : `<tr><td colspan="5" class="dim" style="padding:18px 10px">还没有派出去的活。</td></tr>`;

  view.innerHTML = `
    ${headRow(
      breadcrumb([{ label: '工作台', to: 'workbench' }, { label: '协作中心' }]),
      '<button class="primary" id="clNewBranch">＋ 新增分公司</button>',
    )}
    <div class="detail-body">
      <section class="fx">
        <div class="fx-head"><label>分公司 <span class="count">${branches.length}</span></label></div>
        <table class="plg-table">
          <thead><tr><th>名称</th><th>主机名</th><th>状态</th><th>最近联系</th><th>加入时间</th><th></th></tr></thead>
          <tbody>${branchRows}</tbody>
        </table>
      </section>
      <section class="fx">
        <div class="fx-head"><label>我派出去的活 <span class="count">${tasks.length}</span></label></div>
        <table class="plg-table">
          <thead><tr><th>标题</th><th>分公司</th><th>状态</th><th>更新时间</th><th></th></tr></thead>
          <tbody>${taskRows}</tbody>
        </table>
      </section>
    </div>`;

  $('clNewBranch')?.addEventListener('click', () => newBranchDialog());
  view.querySelectorAll('[data-cl-assign]').forEach((el) => {
    el.onclick = () => assignDialog(el.dataset.clAssign);
  });
  view.querySelectorAll('[data-cl-revoke]').forEach((el) => {
    el.onclick = async () => {
      const ok = await confirmDo(
        `移除分公司「${el.dataset.label}」？\n它会立刻停下同步；那台机器上的项目和卡片不会被删（那是它的数据）。`,
        { title: '移除分公司', ok: '移除' },
      );
      if (!ok) return;
      try {
        await post(`/api/collab/branches/${encodeURIComponent(el.dataset.clRevoke)}/revoke`, {});
        toast('已移除', 'ok');
        await renderCollabCenter();
      } catch (e) {
        toast(e.message, 'error');
      }
    };
  });
  view.querySelectorAll('[data-cl-done]').forEach((el) => {
    el.onclick = async () => {
      try {
        await api(`/api/collab/tasks/${encodeURIComponent(el.dataset.clDone)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: '已完成' }),
        });
        toast('已验收', 'ok');
        await renderCollabCenter();
      } catch (e) {
        toast(e.message, 'error');
      }
    };
  });
  view.querySelectorAll('[data-cl-cancel]').forEach((el) => {
    el.onclick = async () => {
      const ok = await confirmDo(
        `取消任务「${el.dataset.title}」？\n取消之后两边都不能再改（分公司那边的卡会变成「已取消」，留着当痕）。`,
        { title: '取消任务', ok: '取消任务' },
      );
      if (!ok) return;
      try {
        await api(`/api/collab/tasks/${encodeURIComponent(el.dataset.clCancel)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: '已取消' }),
        });
        toast('已取消', 'ok');
        await renderCollabCenter();
      } catch (e) {
        toast(e.message, 'error');
      }
    };
  });
}

/* -------------------------------------------------------------- 弹窗：公共件 */

/** 现建一个弹窗（`<dialog><form>`），关掉就整个移除 —— 与 GitHub 连接弹窗同一个做法 */
function makeDialog(className) {
  const dlg = document.createElement('dialog');
  dlg.className = className;
  const form = document.createElement('form');
  form.method = 'dialog';
  dlg.append(form);
  document.body.append(dlg);
  wireDialogHead(form);
  dlg.addEventListener('close', () => dlg.remove());
  return { dlg, form };
}

/**
 * 那台分公司该填的地址：**它连得到的那个**。
 *
 * 与 `openJoinDialog` 同一条判据（`lan.boundLan && lan.urls[0]`）—— 本机 origin 常常是
 * `127.0.0.1`，拿它去别的机器上填，那台机器会连到它自己。
 */
async function centerAddress() {
  try {
    const lan = await api('/api/lan');
    return { url: lan?.boundLan && lan.urls?.length ? lan.urls[0] : location.origin, lan };
  } catch {
    return { url: location.origin, lan: null };
  }
}

/* ---------------------------------------------------------- 弹窗：新增分公司 */

async function newBranchDialog() {
  const { dlg, form } = makeDialog('cl-dlg');
  form.innerHTML = `
    <b>新增分公司</b>
    <div class="plg-field"><div class="plg-field-label">名字</div>
      <input id="clLabel" maxlength="200" placeholder="比如 办公室那台" autocomplete="off" />
    </div>
    <div class="dlg-actions">
      <button type="button" class="btn-sm" id="clNewCancel">取消</button>
      <button type="button" class="primary" id="clNewOk">生成接入码</button>
    </div>`;
  dlg.showModal();
  $('clNewCancel').onclick = () => dlg.close();
  const go = async () => {
    const label = String($('clLabel')?.value ?? '').trim();
    if (!label) {
      toast('先给它起个名字（列表上要认出是谁）', 'error');
      return;
    }
    let inv;
    try {
      inv = await post('/api/collab/invites', { label });
    } catch (e) {
      toast(e.message, 'error');
      return;
    }
    /* 同一个弹窗换成「接入码 + 有效期 + 三步说明」—— 不再开第二个弹窗 */
    const { url, lan } = await centerAddress();
    const at = new Date(inv.expiresAt);
    const hhmm = at.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    form.innerHTML = `
      <b>把「${esc(inv.label)}」接进来</b>
      <div style="margin:10px 0 4px;padding:10px 12px;background:var(--input);border:1px solid var(--line);border-radius:8px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:15px;letter-spacing:1px">${esc(inv.code)}</div>
      <div class="dim" style="margin:6px 0 12px">这个码 <b>${esc(hhmm)}</b> 前有效，<b>只用一次</b>。</div>
      <div class="dim" style="font-size:12.5px;line-height:1.9">
        <div>① 在那台机器上：<b>设置 → 这台机器 → 协作</b></div>
        <div>② 填这台机器的地址：<code>${esc(url)}</code></div>
        <div>③ 粘贴上面这个接入码</div>
      </div>
      ${
        lan && !lan.boundLan
          ? '<div class="machine-warn">这台机器现在只听本机，分公司连不到它 —— 先切到总机模式（设置 → 这台机器 → 模式）或走隧道。</div>'
          : ''
      }
      <div class="dlg-actions">
        <button type="button" class="btn-sm" id="clCopy">复制接入码</button>
        <button type="button" class="primary" id="clDone">知道了</button>
      </div>`;
    wireDialogHead(form);
    $('clCopy').onclick = async () => {
      try {
        await navigator.clipboard.writeText(inv.code);
        $('clCopy').textContent = '已复制';
        setTimeout(() => { if ($('clCopy')) $('clCopy').textContent = '复制接入码'; }, 1500);
      } catch {
        toast(`复制不了，手动抄一下：${inv.code}`, 'error');
      }
    };
    $('clDone').onclick = async () => {
      dlg.close();
      await renderCollabCenter();
    };
  };
  $('clNewOk').onclick = go;
  $('clLabel')?.focus();
}

/* -------------------------------------------------------------- 弹窗：派活 */

async function assignDialog(branchId = null) {
  let branches = [];
  try {
    branches = (await api('/api/collab/branches')).branches.filter((b) => !b.revokedAt);
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  if (!branches.length) {
    toast('还没有可用的分公司', 'error');
    return;
  }
  const { dlg, form } = makeDialog('cl-dlg');
  form.innerHTML = `
    <b>派活</b>
    <div class="plg-field"><div class="plg-field-label">给哪台分公司</div>
      <select id="clBranch">${branches
        .map((b) => `<option value="${esc(b.id)}" ${b.id === branchId ? 'selected' : ''}>${esc(b.label)}</option>`)
        .join('')}</select>
    </div>
    <div class="plg-field"><div class="plg-field-label">标题</div>
      <input id="clTitle" maxlength="200" placeholder="一句话说清要干什么" autocomplete="off" />
    </div>
    <div class="plg-field"><div class="plg-field-label">描述（可空）</div>
      <textarea id="clDesc" rows="4" maxlength="10000" placeholder="背景、验收标准、注意什么"></textarea>
    </div>
    <div class="dlg-actions">
      <button type="button" class="btn-sm" id="clAssignCancel">取消</button>
      <button type="button" class="primary" id="clAssignOk">派出去</button>
    </div>`;
  dlg.showModal();
  $('clAssignCancel').onclick = () => dlg.close();
  $('clTitle')?.focus();
  $('clAssignOk').onclick = async () => {
    const title = String($('clTitle')?.value ?? '').trim();
    if (!title) {
      toast('任务得有标题', 'error');
      return;
    }
    try {
      await post('/api/collab/tasks', {
        branchId: $('clBranch')?.value,
        title,
        description: String($('clDesc')?.value ?? ''),
      });
      dlg.close();
      toast('派出去了 —— 它下一次同步（几秒内）就会出现在那台机器的看板上', 'ok');
      await renderCollabCenter();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
}

/* ==================================================== 分公司：设置里的分节 */

/** 「加入协作中心」的弹窗（地址 + 接入码） */
function joinCollabDialog(onDone) {
  const { dlg, form } = makeDialog('cl-dlg');
  form.innerHTML = `
    <b>加入协作中心</b>
    <div class="plg-field"><div class="plg-field-label">中心地址</div>
      <input id="clUrl" placeholder="http://192.168.1.9:8787" autocomplete="off" />
    </div>
    <div class="plg-field"><div class="plg-field-label">接入码</div>
      <input id="clCode" placeholder="bi_xxxxxxxx" autocomplete="off" />
    </div>
    <div class="dim" style="font-size:12px">
      加入之后这台机器还是一台完整的班底：自己的通讯录、项目、会话都在本地。
      只是多一个本地项目「协作 · 中心名」，中心的活会变成那个项目里的卡。
    </div>
    <div class="dlg-actions">
      <button type="button" class="btn-sm" id="clJoinCancel">取消</button>
      <button type="button" class="primary" id="clJoinOk">加入</button>
    </div>`;
  dlg.showModal();
  $('clJoinCancel').onclick = () => dlg.close();
  $('clUrl')?.focus();
  $('clJoinOk').onclick = async () => {
    const url = String($('clUrl')?.value ?? '').trim();
    const code = String($('clCode')?.value ?? '').trim();
    if (!url || !code) {
      toast('地址和接入码都要填', 'error');
      return;
    }
    const btn = $('clJoinOk');
    if (btn) { btn.disabled = true; btn.textContent = '正在加入…'; }
    try {
      const r = await post('/api/local/collab/join', { url, code });
      dlg.close();
      toast(`已加入「${r.centerLabel}」`, 'ok');
      onDone?.();
    } catch (e) {
      // 失败要把原因留在眼前（码不对 / 连不上 / 对面太旧），别只弹个 toast 就没了现场
      toast(e.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = '加入'; }
    }
  };
}

/**
 * 设置 →「这台机器」页里的「协作」分节（`connectors.mjs` 的 `#collabMount` 调它）。
 *
 * 三种样子：未加入（一句说明 + 按钮）/ 已加入（信息 + 打开项目 + 退出）/ 已被移除
 * （说明 + 退出 —— 不是自动清配置，跟 E4012 同口径：留在盘上，给用户一个明确的出口）。
 */
export async function renderCollabSection(mount) {
  if (!mount) return;
  let st = null;
  try {
    st = await api('/api/local/collab/status');
  } catch (e) {
    mount.innerHTML = `<section class="fx"><div class="fx-head"><label>协作</label></div>
      <div class="dim">读不到协作状态：${esc(e.message)}</div></section>`;
    return;
  }
  if (!mount.isConnected) return; // 页面可能已经切走了

  const head = (extra = '') => `<div class="fx-head"><label>协作</label>${extra}</div>`;

  if (!st.joined) {
    mount.innerHTML = `
      <section class="fx">
        ${head()}
        <div class="dim" style="margin-bottom:10px">
          加入一个协作中心 = 那台机器可以把活派到这台机器的看板上。这台仍然是一台完整的班底，
          自己的数据全在本地；加入不改变监听地址、也不需要重启。
        </div>
        <button class="btn-sm primary" id="clJoin">加入协作中心</button>
      </section>`;
    $('clJoin').onclick = () => joinCollabDialog(() => renderCollabSection(mount));
    return;
  }

  const stateText = st.revoked
    ? '<b style="color:var(--bad)">已被中心移除</b> —— 同步已停，可以退出后重新加入'
    : st.online
      ? '<b style="color:var(--ok)">● 在线</b>'
      : `<span class="dim">○ 离线</span>${st.lastError ? `<span class="dim"> · ${esc(st.lastError)}</span>` : ''}`;

  mount.innerHTML = `
    <section class="fx">
      ${head()}
      <div class="info-row"><span>中心</span><b>${esc(st.centerLabel ?? '—')}</b></div>
      <div class="info-row"><span>地址</span><b>${esc(st.centerUrl ?? '—')}</b></div>
      <div class="info-row"><span>状态</span><b>${stateText}</b></div>
      <div class="info-row"><span>最近同步</span><b>${esc(when(st.lastSyncAt))}</b></div>
      <div class="info-row"><span>加入时间</span><b>${esc(when(st.joinedAt))}</b></div>
      <div class="info-row"><span>本地项目</span><b>
        ${st.projectId ? `<button class="btn-sm" id="clOpenProject">打开项目</button>` : '<span class="dim">还没建</span>'}
      </b></div>
      <div style="margin-top:12px"><button class="btn-sm" id="clLeave">退出协作</button></div>
    </section>`;

  $('clOpenProject')?.addEventListener('click', () => {
    openProjectDetail(st.projectId).catch((e) => toast(e.message, 'error'));
  });
  $('clLeave')?.addEventListener('click', async () => {
    const ok = await confirmDo(
      `退出「${st.centerLabel ?? '这个中心'}」？\n退出后这台机器不再接它的活；**本机的任务和卡片不会删**。`,
      { title: '退出协作', ok: '退出' },
    );
    if (!ok) return;
    try {
      await post('/api/local/collab/leave', {});
      toast('已退出协作', 'ok');
      await renderCollabSection(mount);
    } catch (e) {
      toast(e.message, 'error');
    }
  });
}

/**
 * 设置页里那一节的「自己刷新」：同步状态是服务器在动，页面不主动看就永远是旧的。
 *
 * 只在这个 mount 还挂着的时候refresh（`isConnected` 守卫，与 `mountJoinPanel` 同款）——
 * 每次 `renderBody()` 重建都会换掉节点，旧定时器下一拍自己歇。
 */
export function watchCollabSection(mount) {
  if (!mount || mount.dataset.watching) return;
  mount.dataset.watching = '1';
  const timer = setInterval(() => {
    if (!mount.isConnected) {
      clearInterval(timer);
      return;
    }
    // 用户正在弹窗里填地址/码的时候重画会把输入抹掉 —— 只在「已加入」的样子上刷新
    if (mount.querySelector('#clLeave')) renderCollabSection(mount);
  }, 5000);
  timer.unref?.();
}
