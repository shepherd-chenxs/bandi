/* useradmin.mjs —— 设置 › 用户（2026-10-28 第三刀：账号、登录与角色分配）。
 *
 * 这一页管三件事，都在一块版式里：**账号本身**（名字 / 密码）、**他能干什么**（角色）、
 * **他还能不能进**（禁用 / 删除）。
 *
 * 版式（2026-10-31 列表化，用户拍板）：一行一个账号的**列表**，新建 / 修改（含删除）走**弹窗** ——
 * 原来的"左列列表 + 右列编辑器"（.ms-split）只在账号多出一大截编辑区时才划算，团队就几个账号，
 * 列表一屏扫完、点谁改谁更直接。
 *
 * 三条必须做成"看得见的约束"（服务端已经拦了，这里别让用户白点一次）：
 *   · 第一个账号 = 内置管理员：角色 / 禁用 / 删除三样都灰掉；
 *   · 最后一个管理员不能降级、不能禁用、不能删（服务端回 E3809，前端先提示原因）；
 *   · 密码**只进不出**：接口从来不回密码，编辑时留空 = 不改。
 *
 * 错误一律「码 + 中文」由服务端给，这里只 toast —— 不用 alert / 原生 confirm。
 */
import { esc, toast } from './shell.mjs';
import { api, failHtml, initial, wireDialogHead } from './ui.mjs';
import { confirmDo } from './machine.mjs';
import { load } from './state.mjs';
import { $, S } from './core.mjs';

let users = [];
let roles = [];

const head = (actions = '') =>
  `<div class="detail-head head-row"><div class="head-title"><b>用户</b></div>${
    actions ? `<div class="head-actions">${actions}</div>` : ''
  }</div>`;

const roleName = (id) => roles.find((r) => r.id === id)?.name ?? id ?? '—';

export async function renderUsers() {
  $('settingsView').innerHTML = `${head()}<div class="empty" style="padding:24px 4px">加载中…</div>`;
  try {
    const [u, r] = await Promise.all([api('/api/users'), api('/api/roles')]);
    users = Array.isArray(u?.users) ? u.users : [];
    roles = Array.isArray(r?.roles) ? r.roles : [];
  } catch (err) {
    $('settingsView').innerHTML = `${head()}<div class="empty">${failHtml(err)}</div>`;
    return;
  }
  paint();
}

function paint() {
  const firstEver = users.length === 0;
  const rows = users
    .map((u) => {
      const tags = [
        u.builtin ? '<span class="set-tag">内置管理员</span>' : '',
        u.hasPassword === false ? '<span class="set-tag">免密</span>' : '',
        u.disabled ? '<span class="set-tag">已禁用</span>' : '',
      ]
        .filter(Boolean)
        .join('');
      return `<div class="set-row usr-row" data-user="${esc(u.id)}">
        <div class="usr-l">
          <span class="usr-ava">${esc(initial(u.name))}</span>
          <b>${esc(u.name)}</b>
          ${tags}
        </div>
        <div class="usr-r">
          <span class="usr-role">${esc(roleName(u.roleId))}</span>
          <button class="btn-sm" data-edit="${esc(u.id)}">修改</button>
        </div>
      </div>`;
    })
    .join('');

  $('settingsView').innerHTML = `
    ${head('<button class="btn-sm" id="usNew">新建账号</button>')}
    <div class="detail-body">
      <section class="set-sec">
        <div class="set-box"><div class="set-note">${
          firstEver
            ? '这是<b>第一个账号</b>：它会自动成为<b>内置管理员</b>（不可删、不可改角色、不可禁用）—— 系统里必须永远留着一把能进门的钥匙。'
            : '每台机器（总机和分机）打开班底都要先用这里的账号登录；免密账号登录时密码留空直接进。本机的脚本 / 命令行仍走免鉴权，不经账号。'
        }</div></div>
      </section>
      <section class="set-sec">
        <div class="set-head"><b>账号</b>${users.length ? `<span class="set-tag">${users.length}</span>` : ''}</div>
        <div class="set-box">
          ${rows || '<div class="set-row"><span class="usr-role">还没有账号 —— 点右上角「新建账号」创建第一个。</span></div>'}
        </div>
      </section>
    </div>`;

  wire();
}

function wire() {
  const view = $('settingsView');
  view.querySelector('#usNew')?.addEventListener('click', () => openUserDlg(null));
  // 整行可点（行里的「修改」按钮点了冒泡到行 —— 同一个弹窗，不用分开绑）
  view.querySelectorAll('[data-user]').forEach((el) => {
    el.onclick = () => openUserDlg(users.find((x) => x.id === el.dataset.user) ?? null);
  });
}

/**
 * 新建 / 修改账号的弹窗（2026-10-31 列表化）：一个弹窗两用 —— user 为 null = 新建。
 * 三样保护做成"看不见的约束"（服务端反正回 E3808，前端别让人白点）：
 * 内置管理员不渲染 角色 / 禁用 / 删除；第一个账号不渲染角色下拉（服务端强制它是管理员）。
 */
function openUserDlg(user) {
  const draft = !user;
  const builtin = !!user?.builtin;
  const firstEver = users.length === 0;
  const dlg = document.createElement('dialog');
  dlg.id = 'userDlg';
  const roleOpts = roles
    .map((r) => `<option value="${esc(r.id)}" ${r.id === (user?.roleId ?? 'operator') ? 'selected' : ''}>${esc(r.name)}</option>`)
    .join('');
  dlg.innerHTML = `
    <form method="dialog">
      <b>${draft ? '新建账号' : `修改「${esc(user.name)}」`}</b>
      <input id="udName" value="${esc(user?.name ?? '')}" maxlength="20" placeholder="用户名（登录时用）" spellcheck="false" style="margin-top:12px" />
      <input id="udPwd" type="password" autocomplete="new-password"
             placeholder="${draft ? '密码可留空；要设就 8 位以上' : '留空 = 不改密码'}" style="margin-top:8px" />
      ${
        !builtin && !(draft && firstEver)
          ? `<select id="udRole" style="margin-top:8px">${roleOpts}</select>
             <label class="plg-check" style="display:flex;align-items:center;gap:8px;margin-top:8px"><input type="checkbox" id="udDisabled" ${user?.disabled ? 'checked' : ''} /> 禁用这个账号（禁止登录，已登录的会话立刻作废）</label>`
          : ''
      }
      ${
        draft && firstEver
          ? '<div class="dim" style="margin-top:8px;font-size:12.5px">第一个账号自动成为内置管理员。</div>'
          : ''
      }
      <div id="udErr" style="color:#ff8a80;font-size:12.5px;margin-top:8px" hidden></div>
      <div class="dlg-actions">
        ${!draft && !builtin ? '<button type="button" class="danger" id="udDel">删除</button>' : ''}
        <button type="button" value="cancel">取消</button>
        <button class="primary" id="udOk" value="ok">保存</button>
      </div>
    </form>`;
  document.body.append(dlg);
  wireDialogHead(dlg.querySelector('form'));
  dlg.addEventListener('close', () => dlg.remove());
  const err = dlg.querySelector('#udErr');
  const bad = (t) => { err.textContent = t; err.hidden = false; };
  dlg.querySelector('button[value="cancel"]').onclick = () => dlg.close();

  const refresh = async () => {
    // 服务端是真相：改完重新拉一遍（角色名、免密/禁用标签都在列表上，别拿本地这份猜）
    users = (await api('/api/users'))?.users ?? users;
    paint();
  };

  dlg.querySelector('#udOk').onclick = async (e) => {
    e.preventDefault();
    err.hidden = true;
    const name = String(dlg.querySelector('#udName').value ?? '').trim();
    const pwd = String(dlg.querySelector('#udPwd').value ?? '');
    if (!name) return bad('先填用户名');
    // 密码可空（2026-10-31）：空 = 不设（新建） / 不改（编辑）；非空才查长度
    if (pwd && pwd.length < 8) return bad('密码要 8 位以上（或者留空）');
    const body = { name };
    if (pwd) body.password = pwd;
    const roleSel = dlg.querySelector('#udRole');
    const disChk = dlg.querySelector('#udDisabled');
    if (roleSel) body.roleId = roleSel.value;
    if (disChk) body.disabled = disChk.checked;
    const btn = dlg.querySelector('#udOk');
    btn.disabled = true;
    try {
      if (draft) {
        const r = await api('/api/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        toast(r?.first ? `已建账号「${name}」（内置管理员）` : `已建账号「${name}」`);
      } else {
        await api(`/api/users/${encodeURIComponent(user.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        toast('已保存');
      }
      dlg.close();
      await refresh();
    } catch (e2) {
      btn.disabled = false;
      bad(e2.message);
    }
  };

  dlg.querySelector('#udDel')?.addEventListener('click', async () => {
    const ok = await confirmDo(
      `删掉账号「${user.name}」？\n他手上的登录会立刻失效，删了没法撤销。`,
      { title: `删除「${user.name}」？`, ok: '删除', danger: true },
    );
    if (!ok) return;
    try {
      await api(`/api/users/${encodeURIComponent(user.id)}`, { method: 'DELETE' });
      toast(`已删掉「${user.name}」`);
      dlg.close();
      await refresh();
    } catch (e2) {
      toast(e2.message, 'error');
    }
  });

  dlg.showModal();
  dlg.querySelector('#udName').focus();
}

/**
 * 退出登录：删掉服务端那张会话票 + **清掉两张 Cookie（登录票与访问令牌）**，然后整页重载。
 *
 * 为什么要连令牌一起清（2026-10-31 实报）：令牌 Cookie 一年有效，握着它的浏览器被
 * "令牌优先"永远放进面板 —— 退出登录只清会话票的话退了个寂寞，也永远走不到登录页。
 *
 * 为什么是 `location.reload()` 而不是"就地回登录页"：重载会走服务端的闸，
 * 由它决定给登录页还是面板 —— 前端自己画一个登录页就等于把认证逻辑抄了第二份。
 * 「我的」页（settings.mjs openMe）也用这一份 —— 退出登录只此一家，别处再写就是两套口径。
 */
export async function logout() {
  const ok = await confirmDo('退出登录？这台浏览器上的登录票和访问令牌都会清掉，下次进来走登录页。', {
    title: '退出登录',
    ok: '退出',
  });
  if (!ok) return;
  try {
    await api('/api/logout', { method: 'POST' });
  } catch {
    /* 服务端已经认不出这张票了也没关系：清 Cookie 是浏览器的事，下面照做 */
  }
  location.reload();
}

/* ------------------------------------------------------------ 首次引导 */

/**
 * **首次引导**（2026-10-31 用户概念落地，参照电脑的开机设置）：
 * 一个账号都还没有时，启动完就弹「创建用户」。谁该弹：
 *   · 只有 **operator**（回环桌面 / 握着令牌的浏览器）—— 手机设备与登录用户不用引导；
 *   · `/api/users` 探到 `hasUsers === false`。探不到（没权限 / 接口挂了）就当不用引导。
 * 「跳过」不是"不再问"：下次启动还没有用户就还会弹。建完 `load()` 重拉一遍全量状态，
 * 通讯录的「成员」段立刻就有这个人。
 */
export async function maybeFirstUser() {
  if (S.auth?.kind !== 'operator') return;
  try {
    const u = await api('/api/users');
    if (u?.hasUsers) return;
  } catch {
    return; // 探不到就别弹 —— 引导是 convenience，不能反过来挡人用
  }
  const dlg = $('firstUserDlg');
  if (!dlg || dlg.open) return;
  const err = $('fuErr');
  // type="button" 不会自己关弹窗（form method=dialog 只认 submit）—— 跳过要自己接
  dlg.querySelector('button[value="cancel"]')?.addEventListener('click', () => dlg.close());
  const submit = async () => {
    const name = String($('fuName')?.value ?? '').trim();
    const pwd = String($('fuPwd')?.value ?? '');
    err.hidden = true;
    if (!name) {
      err.textContent = '先填用户名';
      err.hidden = false;
      return;
    }
    if (pwd && pwd.length < 8) {
      err.textContent = '密码要 8 位以上（或者留空不设密码）';
      err.hidden = false;
      return;
    }
    const btn = $('fuOk');
    btn.disabled = true;
    try {
      await api('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, ...(pwd ? { password: pwd } : {}) }),
      });
      dlg.close();
      toast(`已创建用户「${name}」`);
      await load(); // 全量状态重拉：通讯录成员段 / 看板选真人立刻生效
    } catch (e2) {
      err.textContent = e2?.message ?? '没建成，再试一次';
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  };
  $('fuOk').onclick = (e) => {
    e.preventDefault();
    void submit();
  };
  $('fuPwd').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void submit();
    }
  });
  dlg.showModal();
  setTimeout(() => $('fuName')?.focus(), 50);
}
