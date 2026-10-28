/* useradmin.mjs —— 设置 › 用户（2026-10-28 第三刀：账号、登录与角色分配）。
 *
 * 这一页管三件事，都在一块版式里：**账号本身**（名字 / 密码）、**他能干什么**（角色）、
 * **他还能不能进**（禁用 / 删除）。
 *
 * 版式照抄 roleadmin.mjs（左列列表 + 右列编辑器，复用 `.ms-split`）：两页是兄弟，
 * 长得不一样只会让人怀疑"这是不是另一个产品"。
 *
 * 三条必须做成"看得见的约束"（服务端已经拦了，这里别让用户白点一次）：
 *   · 第一个账号 = 内置管理员：角色 / 禁用 / 删除三样都灰掉；
 *   · 最后一个管理员不能降级、不能禁用、不能删（服务端回 E3809，前端先提示原因）；
 *   · 密码**只进不出**：接口从来不回密码，编辑时留空 = 不改。
 *
 * 错误一律「码 + 中文」由服务端给，这里只 toast —— 不用 alert / 原生 confirm。
 */
import { esc, toast } from './shell.mjs';
import { api, failHtml } from './ui.mjs';
import { confirmDo } from './machine.mjs';
import { $, S } from './core.mjs';

let picked = null;
let draft = false;
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
  draft = users.length === 0; // 一个账号都没有 = 直接进新建态（第一个会自动成为管理员）
  if (!draft && !users.some((x) => x.id === picked)) picked = users[0]?.id ?? null;
  paint();
}

function paint() {
  const cur = draft ? null : users.find((x) => x.id === picked) ?? null;
  const builtin = !!cur?.builtin; // 内置管理员：角色 / 禁用 / 删除全锁
  const firstEver = users.length === 0;

  const side = `
    <div class="ms-side">
      <div class="ms-side-title">账号${users.length ? `（${users.length}）` : ''}</div>
      ${users
        .map(
          (u) => `<div class="ms-item${!draft && u.id === picked ? ' on' : ''}" data-user="${esc(u.id)}">
            <span class="ms-item-name">${esc(u.name)}</span>
            ${u.builtin ? '<span class="set-tag">管理员</span>' : ''}
            ${u.disabled ? '<span class="set-tag">已禁用</span>' : ''}
            <span class="ms-item-n">${esc(roleName(u.roleId))}</span>
          </div>`,
        )
        .join('')}
      ${draft ? `<div class="ms-item on"><span class="ms-item-name">新账号</span><span class="ms-item-n">未保存</span></div>` : ''}
    </div>`;

  const roleOpts = roles
    .map(
      (r) =>
        `<option value="${esc(r.id)}" ${r.id === (cur?.roleId ?? 'operator') ? 'selected' : ''}>${esc(r.name)}</option>`,
    )
    .join('');

  $('settingsView').innerHTML = `
    ${head('<button class="btn-sm" id="usNew">新建账号</button>')}
    <div class="detail-body">
      <section class="set-sec">
        <div class="set-box"><div class="set-note">${
          firstEver
            ? '这是<b>第一个账号</b>：它会自动成为<b>内置管理员</b>（不可删、不可改角色、不可禁用）—— 系统里必须永远留着一把能进门的钥匙。'
            : '账号只对<b>非本机的浏览器</b>生效：本机（回环）打开班底仍然免登录、等同操作员。'
        }</div></div>
      </section>
      <div class="ms-split users-form">
        ${side}
        <div class="ms-main">
          <div class="set-head"><b>${draft ? '新账号' : '账号'}</b>${builtin ? '<span class="set-tag">内置管理员</span>' : ''}</div>
          <div class="set-box">
            <div class="set-row">
              <span class="set-label">用户名</span>
              <input id="usName" value="${esc(cur?.name ?? '')}" maxlength="20" placeholder="1–20 字，登录时用" />
            </div>
            <div class="set-row">
              <span class="set-label">密码</span>
              <input id="usPwd" type="password" autocomplete="new-password"
                     placeholder="${draft ? '至少 8 位' : '留空 = 不改密码'}" />
            </div>
            <div class="set-row">
              <span class="set-label">角色</span>
              ${
                builtin
                  ? `<div class="machine-data">${esc(roleName(cur.roleId))}<span class="sub">（内置管理员不可改）</span></div>`
                  : `<select id="usRole" ${firstEver ? 'disabled' : ''}>${roleOpts}</select>`
              }
            </div>
            <div class="set-row">
              <span class="set-label">状态</span>
              ${
                builtin
                  ? `<div class="machine-data">正常<span class="sub">（内置管理员不可禁用）</span></div>`
                  : `<label class="plg-check"><input type="checkbox" id="usDisabled" ${cur?.disabled ? 'checked' : ''} /> 禁用这个账号（禁止登录，已登录的会话立刻作废）</label>`
              }
            </div>
          </div>
          <div class="machine-actions">
            ${cur && !builtin ? '<button class="btn-sm danger" id="usDel">删除</button>' : ''}
            ${draft && users.length ? '<button class="btn-sm" id="usCancel">取消</button>' : ''}
            <button class="btn-sm primary" id="usSave">${draft ? '创建' : '保存'}</button>
          </div>
          ${
            S.isUser
              ? `<div class="set-head" style="margin-top:22px"><b>登录</b></div>
                 <div class="set-box"><div class="set-row">
                   <span class="set-label">当前登录</span>
                   <div class="machine-data">${esc(S.auth?.user?.name ?? '')}<span class="sub">（${esc(S.auth?.role?.name ?? '')}）</span></div>
                 </div></div>
                 <div class="machine-actions"><button class="btn-sm" id="usLogout">退出登录</button></div>`
              : ''
          }
        </div>
      </div>
    </div>`;

  wire();
}

function wire() {
  const view = $('settingsView');

  view.querySelectorAll('[data-user]').forEach((el) => {
    el.onclick = () => {
      draft = false;
      picked = el.dataset.user;
      paint();
    };
  });

  view.querySelector('#usNew')?.addEventListener('click', () => {
    draft = true;
    paint();
    $('usName')?.focus();
  });

  view.querySelector('#usCancel')?.addEventListener('click', () => {
    draft = false;
    paint();
  });

  view.querySelector('#usSave')?.addEventListener('click', () => void save());
  view.querySelector('#usDel')?.addEventListener('click', () => void remove());
  view.querySelector('#usLogout')?.addEventListener('click', () => void logout());
}

async function save() {
  const btn = $('usSave');
  const cur = draft ? null : users.find((x) => x.id === picked);
  const builtin = !!cur?.builtin;
  const name = String($('usName')?.value ?? '').trim();
  const pwd = String($('usPwd')?.value ?? '');
  if (!name) return toast('先填用户名');
  if (draft && pwd.length < 8) return toast('密码至少 8 位');
  if (!draft && pwd && pwd.length < 8) return toast('密码至少 8 位');

  const body = { name };
  if (pwd) body.password = pwd;
  if (!builtin) {
    // 内置管理员不动这两样：服务端会回 E3808，前端别去试
    body.roleId = $('usRole')?.value ?? cur?.roleId;
    body.disabled = !!$('usDisabled')?.checked;
  }

  btn.disabled = true;
  try {
    if (draft) {
      const r = await api('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      toast(r?.first ? `已建第一个账号「${name}」，它是内置管理员` : `已建账号「${name}」`);
      picked = r?.user?.id ?? picked;
    } else {
      await api(`/api/users/${encodeURIComponent(picked)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      toast('已保存');
    }
    // 服务端是真相：改完重新拉一遍（角色名、禁用标签都在列表上，别拿本地这份猜）
    users = (await api('/api/users'))?.users ?? users;
    draft = false;
    paint();
  } catch (err) {
    btn.disabled = false;
    toast(err.message, 'error');
  }
}

async function remove() {
  const cur = users.find((x) => x.id === picked);
  if (!cur) return;
  const ok = await confirmDo(
    `删掉账号「${cur.name}」？\n他手上的登录会立刻失效，删了没法撤销。`,
    { title: `删除「${cur.name}」？`, ok: '删除', danger: true },
  );
  if (!ok) return;
  try {
    await api(`/api/users/${encodeURIComponent(cur.id)}`, { method: 'DELETE' });
    toast(`已删掉「${cur.name}」`);
    users = (await api('/api/users'))?.users ?? users;
    picked = users[0]?.id ?? null;
    paint();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/**
 * 退出登录：删掉服务端那张票 + 清 Cookie，然后整页重载。
 *
 * 为什么是 `location.reload()` 而不是"就地回登录页"：重载会走服务端的闸，
 * 由它决定给登录页还是面板 —— 前端自己画一个登录页就等于把认证逻辑抄了第二份。
 */
async function logout() {
  const ok = await confirmDo('退出登录？下次进来要重新填用户名和密码。', {
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
