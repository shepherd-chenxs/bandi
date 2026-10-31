/* roleadmin.mjs —— 设置 › 角色与菜单（2026-10-28 第二刀）。
 *
 * 这一页**只做数据**：角色（名字 + 勾了哪些菜单）存库、可增删改。它**不影响任何界面** ——
 * 谁登录、拿到哪个角色、菜单怎么下发，都是第三/四刀的事。所以页面顶上那句说明必须留着，
 * 否则用户会以为"我取消了某人的会话菜单，他怎么还看得见"。
 *
 * 版式：左侧角色列表 + 右侧编辑器，复用模型设置那套 `.ms-split`（250px + 1fr，窄屏自动单列）。
 * 勾选框复用群成员那套 `.member`（标签 + 说明），外层 `.roles-menus` 只做一件事：
 * 去掉对话框那份 220px 的高度上限。
 *
 * 错误一律「码 + 中文」由服务端给，这里只 toast —— 不用 alert / 原生 confirm。
 */
import { esc, toast } from './shell.mjs';
import { api, failHtml } from './ui.mjs';
import { confirmDo } from './machine.mjs';
import { $ } from './core.mjs';

/* 页面状态：当前选中 / 是否在"新建"草稿 / 服务端给的两份数据 */
let picked = null;
let draft = false;
let menus = [];
let roles = [];

const head = (actions = '') =>
  `<div class="detail-head head-row"><div class="head-title"><b>角色与菜单</b></div>${
    actions ? `<div class="head-actions">${actions}</div>` : ''
  }</div>`;

/** 目录按 group 分块（组顺序取目录里第一次出现的顺序） */
function groups() {
  const out = [];
  for (const m of menus) {
    let g = out.find((x) => x.name === m.group);
    if (!g) out.push((g = { name: m.group, items: [] }));
    g.items.push(m);
  }
  return out;
}

export async function renderRoles() {
  $('settingsView').innerHTML = `${head()}<div class="empty" style="padding:24px 4px">加载中…</div>`;
  try {
    const [m, r] = await Promise.all([api('/api/menus'), api('/api/roles')]);
    menus = Array.isArray(m?.menus) ? m.menus : [];
    roles = Array.isArray(r?.roles) ? r.roles : [];
  } catch (err) {
    $('settingsView').innerHTML = `${head()}<div class="empty">${failHtml(err)}</div>`;
    return;
  }
  draft = roles.length === 0; // 一个角色都没有（理论上 seed 保证不会）：直接进新建态，别画一个空编辑器
  if (!draft && !roles.some((r) => r.id === picked)) picked = roles[0]?.id ?? null;
  paint();
}

function paint() {
  const cur = draft ? null : roles.find((r) => r.id === picked) ?? null;
  const isAdmin = cur?.id === 'admin';

  const side = `
    <div class="ms-side">
      <div class="ms-side-title">角色${roles.length ? `（${roles.length}）` : ''}</div>
      ${roles
        .map(
          (r) => `<div class="ms-item${!draft && r.id === picked ? ' on' : ''}" data-role="${esc(r.id)}">
            <span class="ms-item-name">${esc(r.name)}</span>
            ${r.builtin ? '<span class="set-tag">内置</span>' : ''}
            <span class="ms-item-n">${r.menuKeys.length}</span>
          </div>`,
        )
        .join('')}
      ${draft ? '<div class="ms-item on"><span class="ms-item-name">新角色</span><span class="ms-item-n">未保存</span></div>' : ''}
    </div>`;

  const nameRow = `
    <div class="set-head"><b>名称</b>${cur?.builtin ? '<span class="set-tag">内置</span>' : ''}</div>
    <div class="set-box">
      <div class="set-row">
        ${
          isAdmin
            ? `<span class="set-label">角色名</span><div class="machine-data">${esc(cur.name)}<span class="sub">（内置，不可改名）</span></div>`
            : `<span class="set-label">角色名</span><input id="roleName" value="${esc(cur?.name ?? '')}" maxlength="30" placeholder="比如：运维、只读、项目经理" style="max-width:320px" />`
        }
      </div>
    </div>`;

  const menuBlocks = groups()
    .map((g) => {
      const n = g.items.filter((m) => isAdmin || (cur?.menuKeys ?? []).includes(m.key)).length;
      return `
      <div class="set-head" style="margin-top:16px"><b>${esc(g.name)}</b><span class="set-tag" data-cnt="${esc(g.name)}">${n} / ${g.items.length}</span></div>
      <div class="set-box roles-menus">
        <div class="members">
          ${g.items
            .map((m) => {
              const on = isAdmin || (cur?.menuKeys ?? []).includes(m.key);
              return `<label class="member">
                <input type="checkbox" data-menu="${esc(m.key)}" data-group="${esc(g.name)}" ${on ? 'checked' : ''} ${isAdmin ? 'disabled' : ''} />
                <span>${esc(m.label)}</span><em>${esc(m.key)}</em>
              </label>`;
            })
            .join('')}
        </div>
      </div>`;
    })
    .join('');

  const acts = isAdmin
    ? '<div class="machine-actions"><span class="sub">内置「管理员」的菜单恒等于全部菜单，改不了也删不了（防止把管理员自己关在门外）。</span></div>'
    : `<div class="machine-actions">
         ${cur ? `<button class="btn-sm danger" id="roleDel" ${cur.builtin ? 'disabled title="内置角色不能删（可以改菜单）"' : ''}>删除</button>` : ''}
         ${draft ? '<button class="btn-sm" id="roleCancel">取消</button>' : ''}
         <button class="btn-sm primary" id="roleSave">${draft ? '创建' : '保存'}</button>
       </div>`;

  $('settingsView').innerHTML = `
    ${head('<button class="btn-sm" id="roleNew">新建角色</button>')}
    <div class="detail-body">
      <section class="set-sec">
        <div class="set-box"><div class="set-note">配置先存着；<b>等接入登录后才会影响界面</b>（第三刀）。现在改这里不会改变任何人的菜单。</div></div>
      </section>
      <div class="ms-split">
        ${side}
        <div class="ms-main">
          ${nameRow}
          ${menuBlocks}
          ${acts}
        </div>
      </div>
    </div>`;

  wire();
}

/** 勾选框一动就更新分组计数（不重画整页 —— 重画会把焦点和滚动位置都弄丢） */
function wire() {
  const view = $('settingsView');
  view.querySelectorAll('[data-role]').forEach((el) => {
    el.onclick = () => {
      draft = false;
      picked = el.dataset.role;
      paint();
    };
  });

  view.querySelectorAll('[data-menu]').forEach((el) => {
    el.onchange = () => {
      const g = el.dataset.group;
      // 用 dataset 比对而不是拼选择器：组名是中文（面板 / 节点配置），拼 id 很容易踩转义
      const box = [...view.querySelectorAll('[data-cnt]')].find((x) => x.dataset.cnt === g);
      if (!box) return;
      const all = [...view.querySelectorAll('[data-menu]')].filter((x) => x.dataset.group === g);
      box.textContent = `${all.filter((x) => x.checked).length} / ${all.length}`;
    };
  });

  view.querySelector('#roleNew')?.addEventListener('click', () => {
    draft = true;
    paint();
    $('roleName')?.focus();
  });

  view.querySelector('#roleCancel')?.addEventListener('click', () => {
    draft = false;
    paint();
  });

  view.querySelector('#roleSave')?.addEventListener('click', () => void save());
  view.querySelector('#roleDel')?.addEventListener('click', () => void remove());
}

const checkedKeys = () =>
  [...($('settingsView')?.querySelectorAll('[data-menu]') ?? [])].filter((el) => el.checked).map((el) => el.dataset.menu);

async function save() {
  const btn = $('roleSave');
  const name = String($('roleName')?.value ?? '').trim();
  const menuKeys = checkedKeys();
  if (!name) return toast('先给这个角色起个名字');
  btn.disabled = true;
  try {
    if (draft) {
      const r = await api('/api/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, menuKeys }),
      });
      toast(`已建角色「${r?.role?.name ?? name}」`);
      picked = r?.role?.id ?? picked;
    } else {
      await api(`/api/roles/${encodeURIComponent(picked)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, menuKeys }),
      });
      toast('已保存');
    }
    // 服务端是真相：改完重新拉一遍，别拿本地这份猜
    roles = (await api('/api/roles'))?.roles ?? roles;
    draft = false;
    paint();
  } catch (err) {
    btn.disabled = false;
    toast(err.message, 'error');
  }
}

async function remove() {
  const cur = roles.find((r) => r.id === picked);
  if (!cur) return;
  const ok = await confirmDo(
    `删掉角色「${cur.name}」？\n它勾的 ${cur.menuKeys.length} 个菜单一起删掉，删了没法撤销。`,
    { title: `删除「${cur.name}」？`, ok: '删除', danger: true },
  );
  if (!ok) return;
  try {
    await api(`/api/roles/${encodeURIComponent(cur.id)}`, { method: 'DELETE' });
    toast(`已删掉「${cur.name}」`);
    roles = (await api('/api/roles'))?.roles ?? roles;
    picked = roles[0]?.id ?? null;
    paint();
  } catch (err) {
    toast(err.message, 'error');
  }
}
