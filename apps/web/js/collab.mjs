/* collab.mjs —— 协作中心（总公司 / 分公司）的前端（2026-10-31 MVP）。
 *
 * 两个半边，同一个文件（任务书 §8：由同一个人顺序做，别让两个人同时改这个文件）：
 *   · **中心**：设置 → 协作中心（2026-11-01 用户拍板从工作台搬进设置，`renderCollabCenter`
 *     直接长在 #settingsView 里，跟其它设置分节同款主从版式）—— 设备名录；
 *     「我派出去的活」2026-11-01 二十改撤掉了（任务面板的看板本来就有同样的卡，
 *     验收/撤销也搬到了那张卡上），中心页只剩设备名录；
 *   · **分公司**：加入/退出走命令行（2026-11-01 撤掉设置页的「协作」分节，见文件尾说明）。
 *
 * 两边的口径差别（照任务书 §2.1，别再回头改）：
 *   · 卡的内容归中心：分公司只能改状态、执行人、评论、走流程；
 *   · 中心只握两个终态（验收「已完成」/ 取消「已取消」），过程状态归分公司；
 *   · 破坏性动作一律 `confirmDo`，**不用 alert / 原生 confirm**。
 */
import { esc, openRoute, toast } from './shell.mjs';
import { api, post, wireDialogHead } from './ui.mjs';
import { headRow, paintModeCard } from './connectors.mjs';
import { askText, confirmDo } from './machine.mjs';
import { $, S } from './core.mjs';

/** 时间戳给人看的样子（`2026-10-31T09:44:37.380Z` → `10-31 17:44`） */
function when(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ============================================================== 中心页 */

/*
 * 中心页的自动刷新（2026-10-31 验收补）：分公司 5 秒一拍把状态报回来，中心页不主动看
 * 就永远是旧的 —— 而"看进度"正是这一页的用途。
 *
 * 只在**这一页还开着**的时候刷：`#collabPage` 是这一页的根，别的页面一渲染就把它换掉；
 * 有弹窗没关、或上一拍还没画完时跳过，别把用户正在点的按钮/正在看的行抽走。
 * 设备表没变同样跳过（靠 centerSig 比在线状态）——避免每 5 秒白重画一次。
 */
let centerTimer = null;
let centerRendering = false;
let centerSig = '';

function stopCenterAutoRefresh() {
  if (centerTimer) clearInterval(centerTimer);
  centerTimer = null;
}

function startCenterAutoRefresh() {
  stopCenterAutoRefresh();
  centerTimer = setInterval(() => {
    const mount = $('collabPage');
    // 页面切走了 / 换了别的页面 → 停表。不靠路由名判断：设置里还有别的分节也长在 #settingsView 里。
    if (!mount?.isConnected || !$('settingsView')?.classList.contains('shown')) {
      stopCenterAutoRefresh();
      return;
    }
    if (document.querySelector('dialog[open]')) return; // 有弹窗在填东西，别动它背后的页
    if (centerRendering) return;
    renderCollabCenter({ silent: true }).catch(() => { /* 静默刷新失败就等下一拍 */ });
  }, 5000);
  centerTimer.unref?.(); // 浏览器里是数字，没有 unref；这行只是沿用服务端定时器的写法不报错
}

/** 设置分节的页头：标题 +（可选）右侧动作。动作位 2026-11-01 起空着 ——
    「添加设备」挪进了设备节标题行尾（用户："添加设备按钮放下面"）。 */
const clHead = (actionsHtml) => headRow('<b>协作中心</b>', actionsHtml);

/** 中心页：设备名录（派出去的活在任务面板看，2026-11-01 二十改） */
export async function renderCollabCenter({ silent = false } = {}) {
  if (centerRendering) return; // 上一拍还没画完，别叠
  const view = $('settingsView');
  if (!view) return;
  centerRendering = true;
  try {
    if (!silent) view.innerHTML = `${clHead('')}<div class="detail-body"><div class="empty" style="padding:24px 4px">读取中…</div></div>`;

    let branches = [];
    try {
      branches = (await api('/api/collab/branches')).branches ?? [];
    } catch (e) {
      // 静默刷新失败（比如刚好在重启）→ 保留眼前这一屏，不把页面换成错误页
      if (silent) return;
      view.innerHTML = `<div id="collabPage">${clHead('')}<div class="detail-body"><div class="empty">取不到：${esc(e.message)}</div></div></div>`;
      return;
    }

    // 同一份数据（在线状态没变）→ 不重画；lastSeenAt 每 5 秒都在变，不进签名
    const sig = JSON.stringify({
      b: branches.map((b) => [b.id, b.label, b.status, b.online, b.joinedAt]),
    });
    if (silent && sig === centerSig) return;
    centerSig = sig;

  /* 设备节按角色显隐（2026-11-02 用户："分机模式隐藏这个区域"）：总机才管设备名录，
     分机自己就是被管的，不给这张表。拉不到 /api/lan 就照旧画（别因为一次网络抖动把表藏了）。 */
  let lanState = null;
  try { lanState = await api('/api/lan'); } catch { /* 拉不到按总机画 */ }
  const isHub = lanState ? !!lanState.acceptNodes : true;

  const branchRows = branches.length
    ? branches.map((b) => {
      /* 三档状态（服务端算好 b.status，前端不猜）：待接入 / 已接入（看在线）/ 已移除 */
      const st = b.status ?? (b.revokedAt ? 'revoked' : b.joinedAt ? 'active' : 'pending');
      const state =
        st === 'revoked'
          ? '<span class="dim">已移除</span>'
          : st === 'pending'
            ? '<span class="tag-warn">待接入</span>'
            : b.online
              ? '<span style="color:var(--ok)">● 在线</span>'
              : '<span class="dim">○ 离线</span>';
      /* 行上动作按状态给：待接入 = 发码 / 删除（真删，不留痕 —— 2026-11-01 用户：
         「丢弃留痕再删是多此一举」）；已接入 = 派活 / 移除；
         已移除 = 重新接入 / 删除（2026-11-01 用户问「已移除的还能重新邀请吗」） */
      const acts =
        st === 'revoked'
          ? `<button class="btn-sm primary" data-cl-invite="${esc(b.id)}" data-label="${esc(b.label)}">重新接入</button>
             <button class="btn-sm" data-cl-delete="${esc(b.id)}" data-label="${esc(b.label)}" data-joined="${b.joinedAt ? 1 : 0}">删除</button>`
          : st === 'pending'
            ? `<button class="btn-sm primary" data-cl-invite="${esc(b.id)}" data-label="${esc(b.label)}">接入码</button>
               <button class="btn-sm" data-cl-delete="${esc(b.id)}" data-label="${esc(b.label)}" data-joined="0">删除</button>`
            : `<button class="btn-sm primary" data-cl-assign="${esc(b.id)}">派活</button>
               <button class="btn-sm" data-cl-revoke="${esc(b.id)}" data-label="${esc(b.label)}">移除</button>`;
      return `<tr>
        <td><span data-cl-rename="${esc(b.id)}" data-label="${esc(b.label)}"
                  title="点一下改名（不影响那台机器本身）"
                  style="cursor:pointer;border-bottom:1px dashed var(--line)">${esc(b.label)}</span></td>
        <td class="dim">${esc(b.hostname ?? '—')}</td>
        <td>${state}</td>
        <td class="dim">${esc(when(b.lastSeenAt))}</td>
        <td class="dim">${esc(b.joinedAt ? when(b.joinedAt) : '—')}</td>
        <td style="white-space:nowrap">${acts}</td>
      </tr>`;
    }).join('')
    : `<tr><td colspan="6" class="dim" style="padding:18px 10px">
         还没有分机 —— 点右上「＋ 添加分机」建一条，再发接入码把那台机器接进来。
       </td></tr>`;

  /* 「我派出去的活」2026-11-01 二十改撤掉（用户："任务面板已经有了"）——
     派出去的活在任务面板看板上是只读协作卡，验收/撤销也长在那张卡上（projects.mjs
     的 data-kb-cl-done / data-kb-cl-cancel）。这页只管设备。 */

  view.innerHTML = `<div id="collabPage">
    ${clHead('')}
    <div class="detail-body">
      <!-- 模式卡（2026-11-02 用户："放到协作中心更合适" —— 从「手机连接」页搬来）：
           总机/分机本来就是"这台机器在协作里当什么角色"的问题，长在设备名录上面才对 -->
      <div id="clModeMount"></div>
      <!-- 「协作」分节（2026-11-02 二十三改从「这台机器」页搬来，用户："把这个协作移到
           协作中心，通过分机和总机开关控制显示和隐藏"）：分公司侧的加入/状态/退出。
           分机一档才给加入入口；未加入的总机整节不画（2026-11-02 用户："总机不需要这个"）；
           已加入任何角色都显示状态卡（退出有地方点）。 -->
      <div id="clBranchMount"></div>
      <section class="fx" id="clDevicesSec" style="${isHub ? '' : 'display:none'}">
        <!-- 「添加分机」在**有分机时**才钉在标题行尾（2026-11-01 用户："添加设备按钮放下面"）；
             0 行时整块换成空状态卡，按钮进卡里 —— 空表头 + 指路"点右上"那种写法已废
             （2026-11-02 二十七改，UI 评审）。分机角色整节藏（style 内联，别用 .hidden
             —— 只有 .mini.hidden 有 display:none） -->
        ${branches.length
          ? `<div class="fx-head"><label>我的分机 <span class="count">${branches.length}</span></label>
          <button class="primary" id="clNewBranch">＋ 添加分机</button></div>
        <div class="mb-pair-wrap"><table class="plg-table">
          <thead><tr><th>名称</th><th>主机名</th><th>状态</th><th>最近联系</th><th>加入时间</th><th>操作</th></tr></thead>
          <tbody>${branchRows}</tbody>
        </table></div>`
          : `<div class="cl-empty cl-empty-sm">
          <div class="cl-empty-ico" aria-hidden="true">
            <svg viewBox="0 0 40 40" width="40" height="40" fill="none">
              <rect x="4.5" y="12.5" width="13" height="13" rx="3.5" fill="var(--accent)" fill-opacity=".1"
                    stroke="var(--accent)" stroke-width="1.4"/>
              <rect x="22.5" y="12.5" width="13" height="13" rx="3.5"
                    stroke="var(--accent)" stroke-opacity=".45" stroke-width="1.4" stroke-dasharray="3 3"/>
              <path d="M17.5 19h5" stroke="var(--accent)" stroke-opacity=".45" stroke-width="1.4" stroke-linecap="round"/>
            </svg>
          </div>
          <div class="cl-empty-title">还没有分机</div>
          <div class="cl-empty-desc">生成接入码，把局域网里的班底接进来领活</div>
          <button class="primary cl-empty-btn" id="clNewBranch">＋ 添加分机</button>
        </div>`}
      </section>
    </div></div>`;

  /* 模式卡（见上注释）：拉不到状态就不画，别把设备表拖没。onChange 只在**对外服务翻面**
     （回环 ⇄ 对外）时整页重画 —— 卡内部自己判（切总机/分机不动监听，轻更新不闪）。
     onRoleChange：切分机/总机成功 → 只重画下面的「协作」分节（显隐跟着角色走），不整页闪。 */
  paintModeCard($('clModeMount'), {
    onChange: () => { renderCollabCenter().catch(() => {}); },
    onRoleChange: (lanNow) => {
      const m = $('clBranchMount');
      if (m) renderCollabSection(m).catch(() => { /* 拉不到就维持原样 */ });
      /* 轻更新只切了角色不重画整页 —— 设备节显隐得跟手一起翻（分机藏 / 总机显）。
         lanNow 是模式卡就地更新过的同一份状态，acceptNodes 已是切换后的值 */
      const sec = $('clDevicesSec');
      if (sec && lanNow) sec.style.display = lanNow.acceptNodes ? '' : 'none';
    },
  }).catch(() => { /* 拉不到就不画卡 */ });

  /* 「协作」分节（分公司侧）：进来挂一次，区块自己拉状态自己画；
     已加入时 watch 每 5 秒同步在线/最近同步时间（未加入不刷，免得把填到一半的弹窗顶掉） */
  {
    const bm = $('clBranchMount');
    if (bm) {
      renderCollabSection(bm).catch(() => { /* 拉不到就空着 */ });
      watchCollabSection(bm);
    }
  }

  $('clNewBranch')?.addEventListener('click', () => addDevice());
  view.querySelectorAll('[data-cl-invite]').forEach((el) => {
    el.onclick = () => inviteDialog(el.dataset.clInvite);
  });
  view.querySelectorAll('[data-cl-rename]').forEach((el) => {
    el.onclick = () => renameDevice(el.dataset.clRename, el.dataset.label);
  });
  view.querySelectorAll('[data-cl-assign]').forEach((el) => {
    el.onclick = () => assignDialog(el.dataset.clAssign);
  });
  view.querySelectorAll('[data-cl-revoke]').forEach((el) => {
    el.onclick = async () => {
      const ok = await confirmDo(
        `移除「${el.dataset.label}」？\n它会立刻停下同步；那台机器上的项目和卡片不会被删（那是它的数据）。移除后这条留痕还能点「删除」清掉。`,
        { title: '移除分机', ok: '移除' },
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
  view.querySelectorAll('[data-cl-delete]').forEach((el) => {
    el.onclick = async () => {
      const joined = el.dataset.joined === '1';
      const ok = await confirmDo(
        joined
          ? `删除「${el.dataset.label}」的记录？\n这条已移除的留痕和它名下的任务记录会**一起删掉**，找不回来；那台机器本身的数据不受影响。`
          : `删除「${el.dataset.label}」的记录？\n它还没接入过，删了就当没建过。`,
        { title: '删除记录', ok: '删除' },
      );
      if (!ok) return;
      try {
        await api(`/api/collab/branches/${encodeURIComponent(el.dataset.clDelete)}`, { method: 'DELETE' });
        toast('已删除', 'ok');
        await renderCollabCenter();
      } catch (e) {
        toast(e.message, 'error');
      }
    };
  });
  } finally {
    centerRendering = false;
    /*
     * 5 秒自动刷新（2026-11-01 晚七改补的一个漏）：`startCenterAutoRefresh` 一直是**死代码** ——
     * 定义在、没人调。结果就是「分机接入了、中心这页还显示待接入」，非得手点一下别的分节再回来。
     * 放在 finally 里（画失败也照样起表，下一拍自会重试），函数自己带幂等（先 stop 再 start）。
     */
    startCenterAutoRefresh();
  }
}

/* -------------------------------------------------------------- 弹窗：公共件 */

/** 现建一个弹窗（`<dialog><form>`），关掉就整个移除 —— 与 GitHub 连接弹窗同一个做法。
    ⚠️ 头部（吸顶标题 + ×）要等 `form.innerHTML` 填完内容**之后**再 `wireDialogHead(form)`
    包一次 —— 建的时候表单是空的，先包了也会被 innerHTML 冲掉。 */
function makeDialog(className) {
  const dlg = document.createElement('dialog');
  dlg.className = className;
  const form = document.createElement('form');
  form.method = 'dialog';
  dlg.append(form);
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  return { dlg, form };
}

/**
 * 那台分公司该填的地址：**它连得到的那个**。
 *
 * 与「发邀请码」同一条判据（`lan.boundLan && lan.urls[0]`；那段现在只在 `bandi nodes invite`
 * 的提示里出现）—— 本机 origin 常常是 `127.0.0.1`，拿它去别的机器上填，那台机器会连到它自己。
 */
async function centerAddress() {
  try {
    const lan = await api('/api/lan');
    return { url: lan?.boundLan && lan.urls?.length ? lan.urls[0] : location.origin, lan };
  } catch {
    return { url: location.origin, lan: null };
  }
}

/* ------------------------------------------- 添加设备（2026-11-01 晚七改：分步走） */

/*
 * 用户定的流程，三步分开：
 *   ① 「＋ 添加设备」→ **直接落一条记录**（状态「待接入」），不问名字、不当场发码
 *   ② 这条记录带「接入码」按钮 → 点了才生成码（10 分钟、一次性），并给出填法
 *   ③ 分公司填地址 + 码接入 → 这行变「已接入」
 *
 * 为什么不再"发码时才建行"：码有有效期，早发早过期；而且"记录先存在"让列表一眼看出
 * 版图 —— 哪几台还等着接、哪几台已经接上了。
 */
async function addDevice() {
  try {
    const r = await post('/api/collab/branches', {});
    const label = r?.branch?.label ?? '分机';
    toast(`已添加「${label}」—— 点这一行的「接入码」把那台机器接进来`, 'ok');
    await renderCollabCenter();
  } catch (e) {
    toast(e.message, 'error');
  }
}

/** 改名（待接入时最常改：先落行、再接之前起个正经名字） */
async function renameDevice(branchId, label) {
  const given = await askText({ title: '分机名字', value: label, placeholder: '比如 办公室那台', ok: '保存' });
  if (given == null) return;
  const next = String(given).trim();
  if (!next || next === label) return;
  try {
    await post(`/api/collab/branches/${encodeURIComponent(branchId)}/rename`, { label: next });
    toast('改好了', 'ok');
    await renderCollabCenter();
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* -------------------------------------------------------- 弹窗：接入码 */

/** 点「接入码」→ 现发一张码（绑在这一行上）→ 弹窗给出码 + 填法 */
async function inviteDialog(branchId) {
  let inv;
  try {
    inv = await post(`/api/collab/branches/${encodeURIComponent(branchId)}/invite`, {});
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  /* 展示型弹窗（2026-11-03 用户："只要两个就可以，一个是地址，一个是接入码。其他的说明不要"；
     同日再改："标签放框外面"）—— 标签在框上方，框里只有可点复制的值，其余说明全撤。
     头部仍走共用的 wireDialogHead（内容填完再包，否则吸顶标题和 × 会被 innerHTML 冲掉）。 */
  const { dlg, form } = makeDialog('cl-dlg');
  const { url } = await centerAddress();
  form.innerHTML = `
    <b>把「${esc(inv.label)}」接进来</b>
    <div class="cl-inv">
      <div class="cl-inv-field">
        <span class="cl-inv-label">地址</span>
        <button type="button" class="cl-inv-box" id="clCopyUrl" title="点击复制">
          <code class="cl-inv-value">${esc(url)}</code>
        </button>
      </div>
      <div class="cl-inv-field">
        <span class="cl-inv-label">接入码</span>
        <button type="button" class="cl-inv-box" id="clCopyCode" title="点击复制">
          <code class="cl-inv-value">${esc(inv.code)}</code>
        </button>
      </div>
    </div>
    <div class="dlg-actions">
      <button type="button" class="primary" id="clDone">知道了</button>
    </div>`;
  wireDialogHead(form); // 内容填完再包：才有吸顶标题和右上角 ×
  dlg.showModal();
  const copyField = async (btn, text) => {
    const label = btn.closest('.cl-inv-field')?.querySelector('.cl-inv-label');
    try {
      await navigator.clipboard.writeText(text);
      if (!label) return;
      const old = label.textContent;
      label.textContent = '已复制';
      setTimeout(() => {
        if ($('clCopyUrl') && $('clCopyCode')) label.textContent = old;
      }, 1500);
    } catch {
      toast(`复制不了，手动抄一下：${text}`, 'error');
    }
  };
  $('clCopyUrl').onclick = (el) => copyField(el.currentTarget, url);
  $('clCopyCode').onclick = (el) => copyField(el.currentTarget, inv.code);
  $('clDone').onclick = async () => {
    dlg.close();
    await renderCollabCenter();
  };
}

/* -------------------------------------------------------------- 弹窗：派活 */

async function assignDialog(branchId = null) {
  let branches = [];
  try {
    // 只有**已接入**的能派活：待接入的行点了也会被服务端拒（E4046），别在这儿给个假按钮
    branches = (await api('/api/collab/branches')).branches.filter((b) => (b.status ?? '') === 'active');
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  if (!branches.length) {
    toast('还没有已接入的分机 —— 先在上方列表点「接入码」把机器接进来', 'error');
    return;
  }
  const { dlg, form } = makeDialog('cl-dlg');
  form.innerHTML = `
    <b>派活</b>
    <div class="plg-field"><div class="plg-field-label">给哪台设备</div>
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
  wireDialogHead(form); // 内容换过之后重新包一次：否则没有吸顶标题和右上角 ×
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
      toast('派出去了 —— 任务面板的看板上会多一张带设备名的协作卡，验收/撤销都在那张卡上', 'ok');
      await renderCollabCenter();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
}

/* ==================================================== 分公司：设置里的分节 */

/*
 * 2026-11-01 晚回滚：上午按用户要求把「这台机器」页的协作分节整块撤了（改成 CLI 口径），
 * 晚上用户看了看说「我有界面，为什么要用命令行？」—— 界面捡回来，CLI 保留当备选
 * （服务器形态 / 无头机器仍然只有 CLI 一条路）。
 * 2026-11-02 三十一改：加入也放宽成 never（local-policy.mjs，用户："这里应该是连接"）——
 * 界面里点「连接总机」就是真加入，CLI 只服务无头机器。
 */

/** 「连接总机」的弹窗（地址 + 接入码） */
function joinCollabDialog(onDone) {
  const dlg = document.createElement('dialog');
  dlg.className = 'cl-dlg';
  const form = document.createElement('form');
  form.method = 'dialog';
  dlg.append(form);
  document.body.append(dlg);
  form.innerHTML = `
    <b>连接总机</b>
    <div class="plg-field"><div class="plg-field-label">中心地址</div>
      <input id="clUrl" placeholder="http://192.168.1.9:8787" autocomplete="off" />
    </div>
    <div class="plg-field"><div class="plg-field-label">接入码</div>
      <input id="clCode" placeholder="bi_xxxxxxxx" autocomplete="off" />
    </div>
    <div class="dlg-actions">
      <button type="button" class="btn-sm" id="clJoinCancel">取消</button>
      <button type="button" class="primary" id="clJoinOk">加入</button>
    </div>`;
  wireDialogHead(form); // 内容填完再包：才有吸顶标题和右上角 ×
  dlg.addEventListener('close', () => dlg.remove());
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
      // 失败要把原因留在眼前（码不对 / 连不上 / 对面太旧 / 已是算力节点），别只弹个 toast 就没了现场
      toast(e.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = '加入'; }
    }
  };
}

/**
 * 设置 →「协作中心」页里的「协作」（分公司侧）分节 —— 2026-11-02 二十三改从「这台机器」页
 * 搬进来（用户："把这个协作移到协作中心"），跟模式卡同页：**分机/总机就是这台机器在协作里
 * 当什么角色**，加入入口只在分机一档出现（用户："通过分机和总机开关控制显示和隐藏"）。
 *
 * 四种样子：未加入+分机（说明 + 加入入口）/ 总机（整节不画 —— 不管加没加入，
 * 2026-11-04 用户："协作这个是分机模式的内容，不应该显示在总机模式里"；
 * 此前的口径是"已加入任何角色都显示、给退出留地方"，作废）/
 * 分机已加入（状态卡 + 打开项目 + 退出）/ 已被移除（状态卡 + 退出 —— 不是自动清配置，
 * 跟 E4012 同口径：留在盘上，给用户一个明确的出口）。
 */
export async function renderCollabSection(mount, { hub } = {}) {
  if (!mount) return;
  let st = null;
  try {
    /* 状态与角色两路并行拉：hub 传了（模式卡切换的轻重画）就不用再问 /api/lan */
    const [status, lan] = await Promise.all([
      api('/api/local/collab/status'),
      hub === undefined ? api('/api/lan').catch(() => null) : Promise.resolve(null),
    ]);
    st = status;
    if (hub === undefined) hub = lan ? !!lan.acceptNodes : false;
  } catch (e) {
    mount.innerHTML = `<section class="fx"><div class="fx-head"><label>协作</label></div>
      <div class="dim">读不到协作状态：${esc(e.message)}</div></section>`;
    return;
  }
  if (!mount.isConnected) return; // 页面可能已经切走了

  const head = (extra = '') => `<div class="fx-head"><label>协作</label>${extra}</div>`;

  if (hub) {
    /* 总机：协作分节整节不画（2026-11-04 用户："协作这个是分机模式的内容，不应该显示在
       总机模式里"）。原口径只在「未加入」时藏、已加入仍给状态卡（"退出总得有地方点"）——
       但那样切到总机后还挂着一张外人的协作卡，两头不是。现在总机一档彻底不画；
       真要退出协作，切回分机再退（模式卡就在这页上面，一步的事）。 */
    mount.innerHTML = '';
    return;
  }

  if (!st.joined) {
    /*
     * 2026-11-02 三十一改：join 放宽成 `secret:'never'`（local-policy.mjs，用户："这里应该是
     * 连接"）—— 任何形态下界面里点「连接总机」都是真加入，不再有"终端执行"变体。
     * **退出** 2026-11-01 二十改续起就是 `secret:'never'`，所以已加入的卡片上按钮任何形态都在
     * —— 见下面 joined 分支。
     */
    /*
     * 空状态卡（2026-11-02 二十六改，UI 评审后）：这一态整页只有一个任务 —— 连总机。
     * 原来是一颗 btn-sm 钉在整宽空卡的左上角，权重比任务低、也没有上下文；改成
     * 图标 + 状态 + 一句说明 + 标准尺寸主按钮，垂直居中。分节标题「协作」也一起去掉
     * —— 卡片自己说清了是什么，再顶一个标题就是重复。
     */
    mount.innerHTML = `
      <section class="fx">
        <div class="cl-empty">
          <div class="cl-empty-ico" aria-hidden="true">
            <svg viewBox="0 0 44 44" width="44" height="44" fill="none">
              <rect x="3.75" y="15.25" width="14.5" height="14.5" rx="4" stroke="var(--accent)" stroke-width="1.5"/>
              <rect x="25.75" y="15.25" width="14.5" height="14.5" rx="4" fill="var(--accent)" fill-opacity=".1"
                    stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="3 3"/>
              <path d="M18.5 22.5h7" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round"/>
              <circle cx="22" cy="22.5" r="1.6" fill="var(--accent)"/>
            </svg>
          </div>
          <div class="cl-empty-title">未连接总机</div>
          <div class="cl-empty-desc">连接后可接收总机派发的任务</div>
          <button class="primary cl-empty-btn" id="clJoin">连接总机</button>
        </div>
      </section>`;
    $('clJoin').onclick = () => joinCollabDialog(() => renderCollabSection(mount));
    return;
  }

  /*
   * 「已加入」画成**一张卡片**（2026-11-01 用户截图：「做成一个卡片」）——
   * 与下面的运行时行同款 row-item 语汇：图标 + 标题行（带状态标签）+ 灰字细节，动作在行尾。
   * 原来那种「中心 / 地址 / 状态 …」一行一个 info-row 的表格相，和这页其它内容根本不像一家人。
   */
  const badge = st.revoked
    ? '<em class="tag-warn">已被移除</em>'
    : st.online
      ? '<em class="tag-ok">在线</em>'
      : '<em class="tag-warn">离线</em>';
  const errSub = st.revoked
    ? '<div class="sub">同步已停 —— 退出后可以重新加入</div>'
    : !st.online && st.lastError
      ? `<div class="sub" style="color:var(--bad)">${esc(st.lastError)}</div>`
      : '';
  const joinedCard = `<div class="row-item ${st.revoked || !st.online ? 'off' : ''}">
    <div class="avatar cli" title="协作中心"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
      <circle cx="12" cy="5" r="2.4"/><circle cx="5" cy="18" r="2.4"/><circle cx="19" cy="18" r="2.4"/>
      <path d="M10.7 6.9 6.3 16.1M13.3 6.9l4.4 9.2M7.4 18h9.2"/>
    </svg></div>
    <div class="who">
      <b>协作 · ${esc(st.centerLabel ?? '未知中心')}${badge}</b>
      <div class="sub" style="font-family:ui-monospace,monospace;font-size:11.5px">${esc(st.centerUrl ?? '—')}</div>
      <div class="sub">最近同步 ${esc(when(st.lastSyncAt))} · 加入于 ${esc(when(st.joinedAt))}${st.projectId ? '' : ' · 本地项目还没建'}</div>
      ${errSub}
    </div>
    ${st.projectId ? '<button class="mini auto" id="clOpenProject">打开项目</button>' : ''}
    <button class="mini auto" id="clLeave">退出协作</button>
  </div>`;

  mount.innerHTML = `
    <section class="fx">
      ${head()}
      ${joinedCard}
    </section>`;

  /* 打开项目走路由表（不 import projects.mjs —— 那边经 state → settings → collab 会成环） */
  $('clOpenProject')?.addEventListener('click', () => {
    Promise.resolve(openRoute({ view: 'project', id: st.projectId })).catch((e) => toast(e.message, 'error'));
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
 * 只在这个 mount 还挂着的时候刷（`isConnected` 守卫）——
 * 每次 renderBody 重建都会换掉节点，旧定时器下一拍自己歇。
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
