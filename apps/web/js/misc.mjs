/* misc.mjs —— 新建员工、新建群、换群助手、绑定、列表项右键菜单（绑定）、版本提醒。
 * 2026-10-22 由 app.js（15537 行单文件）拆出，原生 ESM、无打包器；逻辑逐字搬运。 */
import { esc, personLabel, personSubtitle, restorePlace, toast } from './shell.mjs';
import { api, createCombo, dt, post } from './ui.mjs';
import { load } from './state.mjs';
import { confirmDo } from './machine.mjs';
import { openPluginForm, pluginFormId } from './experts.mjs';
import { refreshDeptSuggest } from './contacts.mjs';
import { $, LOCAL_BASE, S } from './core.mjs';



/* -------------------------------------------------------------- 新建员工 */

/** 沙箱选项。带 blocked 的那两档实测在 headless 下跑不了命令，必须在界面上说清楚 */
/**
 * 权限的中文名。**id 是给运行时用的，界面上一律显示中文** ——
 * `read-only` 这种裸英文对用户没意义（DSH 里也是"完全权限"这么写的）。
 */
export const SANDBOX_LABEL = {
  // codex / dsh 这套
  'read-only': '仅可查看',
  'workspace-write': '工作区内读写',
  'danger-full-access': '完全权限',
  // claude 那套 id 完全不同，也得给中文名，否则界面上还是裸英文
  default: '默认',
  acceptEdits: '自动接受编辑',
  bypassPermissions: '完全权限',
  plan: '计划模式',
};



export function sandboxItems(runtime) {
  // 标签用中文名，**后面不挂解释**（如"（现在跑不了命令）"）——
  // 名字自己说得清，括号里的补充是噪音；全站统一（主聊天框、员工详情、流程对话栏都走这儿）。
  const list = runtime?.sandboxes ?? ['danger-full-access'];
  return list.map((s) => ({ id: s, label: SANDBOX_LABEL[s] ?? s }));
}



// 新建员工对话框里的两个下拉：实例常驻、选项随运行时变（选项少，不带搜索）
export const pRuntimeCombo = createCombo({ mount: $('pRuntimeMount'), search: false, onChange: () => syncSandboxes() });


export const pSandboxCombo = createCombo({ mount: $('pSandboxMount'), search: false });



export function syncSandboxes() {
  const r = S.runtimes.find((x) => x.id === pRuntimeCombo.value());
  const items = sandboxItems(r);
  const keep = items.some((it) => it.id === pSandboxCombo.value()) ? pSandboxCombo.value() : items[0]?.id ?? '';
  pSandboxCombo.setItems(items, false);
  pSandboxCombo.setValue(keep);
}



export function openPersonaDialog() {
  pRuntimeCombo.setItems(S.runtimes.map((r) => ({ id: r.id, label: r.label })), false);
  pRuntimeCombo.setValue(S.runtimes[0]?.id ?? '');
  $('pCwd').value = S.repoRoot || '';
  $('pDept').value = '';
  refreshDeptSuggest(); // 建议列表跟着库里已用的部门走（contacts.mjs 填的 #deptSuggest）
  syncSandboxes();
  $('personaDlg').showModal();
}



/* ---------------------------------------------------------------- 新建群 */

// 「群助手」下拉：员工可能很多，带搜索
export const gAssistantCombo = createCombo({
  mount: $('gAssistantMount'),
  search: true,
  placeholder: '搜员工…',
  onChange: () => renderGroupMembers(),
});



/** 群成员勾选列表：群助手自动在列（锁住），其他一律不预选 */
export function renderGroupMembers() {
  const assistantId = gAssistantCombo.value();
  $('gMembers').innerHTML = S.personas
    .map((p) => {
      const isAssistant = p.id === assistantId;
      return `<label class="member${isAssistant ? ' locked' : ''}">
        <input type="checkbox" value="${p.id}" ${isAssistant ? 'checked disabled' : ''} />
        <span>${esc(p.name)}${isAssistant ? '<em class="tag-inline">群助手</em>' : ''}</span>
        <em>${esc(personSubtitle(p))}</em>
      </label>`;
    })
    .join('');
}



export function openGroupDialog() {
  if (!S.personas.length) return toast('先建至少一个数字员工，群里只能放数字员工');
  $('gTitle').value = '';
  gAssistantCombo.setItems(S.personas.map((p) => ({ id: p.id, label: personLabel(p) })), false);
  gAssistantCombo.setValue(S.personas[0]?.id ?? '');
  renderGroupMembers();
  $('groupDlg').showModal();
}



/* ------------------------------------------------------------ 换群助手 */

export function openAssistantDialog(thread) {
  $('aList').innerHTML = thread.members
    .map(
      (m) => `<label class="member">
        <input type="radio" name="assistant" value="${m.personaId}"
               ${m.personaId === thread.assistantPersonaId ? 'checked' : ''} />
        <span>${esc(m.name)}</span><em>${esc(String(m.role ?? '').split(' · ')[0].trim() || '—')}</em>
      </label>`,
    )
    .join('');
  $('assistantDlg').dataset.thread = thread.id;
  $('assistantDlg').showModal();
}



/** 工作台里那个「＋」：打开当前插件的添加表单（manifest 的 split.master.add） */
export function openPluginAdd() {
  const plugin = S.plugins.find((p) => p.id === S.plugin);
  const add = plugin?.panel?.split?.master?.add;
  if (!plugin || !add) return;
  const all = [
    ...(plugin.panel.blocks ?? []),
    ...(plugin.panel.split?.detail?.actions ?? []),
    ...(plugin.panel.split?.detail?.blocks ?? []),
  ];
  const fb = all.find((x) => x.type === 'form' && pluginFormId(x) === add.form);
  if (fb) openPluginForm(plugin, fb, {});
  else toast(`manifest 里找不到表单「${add.form}」`);
}



/**
 * 节点模式页（2026-10-21 拍板：**加入后这台机器只当算力，不做「看总机面板」**）。
 *
 * 已加入总机的机器打开班底，看到的就是这一页 —— 左栏与正常面板整体收起
 * （`body.node-mode` 的 CSS 负责藏，`#nodeView` 长在 `main` 里）。
 * 为什么不是"看自己的面板"：节点不写本机库，"自己的面板"没有内容；
 * 而派给这台机器的活，记录全在总机 —— 本地面板反而看不到自己正在干的活。
 * 所以这里只回答两件事：连着哪台总机、节点进程在不在跑（本机数据/导出在「数据备份」分节，2026-10-21 用户拍板撤掉这一行）。
 *
 * 弹窗（confirmDo 的 #askDlg）是 body 下的常驻节点，没被藏 —— 「退出总机」的确认照常可用。
 */
export function renderNodeMode(st) {
  document.body.classList.add('node-mode');
  const main = document.querySelector('main');
  let view = $('nodeView');
  if (!view) {
    view = document.createElement('div');
    view.id = 'nodeView';
    main.appendChild(view);
  }

  /*
   * 本机叫什么、跑的是哪个版本 —— 从 `/api/hello` 拿（它不带秘密，节点身份/版本就是它的内容）。
   * 不等它：先画，回来再重画一次。拉不到就名字位显示"这台电脑"，页面照常。
   */
  let selfName = '';
  let selfVersion = '';
  let lastSt = null;
  api('/api/hello')
    .then((h) => {
      selfName = String(h?.hostname || h?.label || '');
      selfVersion = String(h?.version ?? '');
      if (lastSt) draw(lastSt);
    })
    .catch(() => { /* 拿不到就不显示机器名，别白屏 */ });

  const draw = (s) => {
    lastSt = s;
    const c = s?.client ?? {};
    const local = s?.local ?? {};
    const counts = local.counts ?? {};
    const host = c.hostLabel || c.hostHostname || c.controlPlane || '总机';
    const since = c.since ? dt(c.since) : '';
    const running = !!c.node?.running;
    const external = !!c.node?.external; // autostart 拉起的常驻（退出时要连自启一起收）
    const warnings = (s?.warnings ?? []).map((w) => `<div class="machine-warn">${esc(w)}</div>`).join('');
    /* 明细行的小图标（14px 线性，颜色随 --dim）：给四行明细一点可扫读的锚点 */
    const ICO = {
      hub: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="7" rx="2"></rect><rect x="3" y="13" width="18" height="7" rx="2"></rect><path d="M7 7.5h.01"></path><path d="M7 16.5h.01"></path></svg>',
      link: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"></path><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"></path></svg>',
      pulse: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 12h-4l-3 9L9 3l-3 9H2"></path></svg>',
      clock: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>',
    };
    view.innerHTML = `
      <div class="nodepage">
        <section class="node-hero">
          <div class="node-hero-head">
            <div class="node-hero-ico">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="3" y="4.5" width="18" height="12" rx="2"></rect>
                <path d="M8.5 20h7"></path><path d="M12 16.5V20"></path>
              </svg>
            </div>
            <div class="node-hero-id">
              <div class="node-hero-name" title="${esc(selfName)}">${esc(selfName || '这台电脑')}</div>
              <div class="node-hero-sub">${selfVersion ? `班底 v${esc(selfVersion)} · ` : ''}算力节点</div>
            </div>
            <span class="node-state${running ? ' on' : ''}">${running ? '在线' : '离线'}</span>
          </div>
          <div class="node-linkviz" data-on="${running ? '1' : '0'}" aria-hidden="true">
            <span class="node-link-end"><span class="node-link-dot"></span>这台电脑</span>
            <span class="node-link-line"></span>
            <span class="node-link-end host"><span class="node-link-dot"></span>${esc(host)}</span>
          </div>
          <div class="node-hero-line">这台电脑是「<b>${esc(host)}</b>」的算力节点 —— 总机把活派过来，在这台电脑上跑。班底的面板（员工、会话、项目）只在总机上。</div>
        </section>
        <section class="set-sec machine-card">
          <div class="set-box">
            <div class="set-row">
              <span class="set-label">${ICO.hub}总机</span>
              <div class="machine-data">${esc(host)}</div>
            </div>
            ${c.controlPlane ? `<div class="set-row"><span class="set-label">${ICO.link}地址</span><div class="machine-data machine-addr">${esc(c.controlPlane)}</div></div>` : ''}
            <div class="set-row">
              <span class="set-label">${ICO.pulse}节点进程</span>
              <div class="machine-data">${
                running
                  ? `<span class="machine-dot"></span><span class="machine-ok">在线，等着接活</span>${
                      external ? '<span class="sub">（开机自启）</span>' : ''
                    }`
                  : '<span class="machine-dot off"></span><span class="sub">没在跑 —— 重启这台电脑上的班底试试</span>'
              }</div>
            </div>
            ${since ? `<div class="set-row"><span class="set-label">${ICO.clock}加入时间</span><div class="machine-data">${esc(since)}</div></div>` : ''}
          </div>
          ${warnings}
          <div class="machine-actions">
            <button class="btn-sm danger" id="nodeLeave">退出总机</button>
          </div>
        </section>
        <footer class="node-foot">${selfVersion ? `班底 v${esc(selfVersion)}` : '班底'} · 节点模式</footer>
      </div>`;

    $('nodeLeave').onclick = async () => {
      /* 三句后果 + 建议（PRD §6.4 原文）：破坏性操作走 confirmDo，不用原生 confirm */
      const n = Number(counts.personas ?? 0);
      const ok = await confirmDo(
        `① 这台电脑不再给「${host}」干活；\n` +
          `② 打开班底看到的是这台电脑原来的数据（${n} 个员工，一个没少）；\n` +
          `③ 退出后回到单机；要再加入需要一个新的邀请码。\n` +
          (external ? '④ 它是开机自启拉起的，退出会一并移除自启并停掉节点进程。\n' : '') +
          `建议先在「${host}」的设备页把它「忘掉」，否则那边会留一行永远离线的设备。`,
        { title: `退出「${host}」？`, ok: '退出', danger: true },
      );
      if (!ok) return;
      $('nodeLeave').disabled = true;
      try {
        const r = await post(`${LOCAL_BASE}/leave`, {});
        /*
         * 自启没移除成功 / 进程没停掉时服务端会回 note —— 别装作成功直接刷新，
         * 先让人看见那句话（刷新会把 toast 冲掉）。
         */
        if (r?.note) {
          toast(r.note, 'error');
          await new Promise((done) => setTimeout(done, 2500));
        }
        location.reload(); // 回到单机：本机库原样（加入期间从没写过它）
      } catch (err) {
        $('nodeLeave').disabled = false;
        toast(err.message, 'error');
      }
    };
  };
  draw(st);

  // 5 秒一刷"节点进程在不在"：autostart 拉起的常驻也是 status 里那个开关说了算。
  // 页面被换掉（退出后 reload）就停表 —— 定时器别挂在看不见的节点上空转。
  const guard = setInterval(() => {
    if (!view.isConnected) { clearInterval(guard); return; }
    api(`${LOCAL_BASE}/status`).then(draw).catch(() => {});
  }, 5000);
}



/**
 * 启动分岔（2026-10-21）：已加入总机 → 节点状态页（不加载面板数据）；
 * 未加入 → 正常面板。判据是 `/api/local/status` —— 服务端的答案，本机答、必然可达。
 */
export async function boot() {
  try {
    const st = await api(`${LOCAL_BASE}/status`);
    if (st?.client?.joined) {
      renderNodeMode(st);
      startVersionWatch();
      return;
    }
  } catch {
    /* status 拉不到不当"没加入" —— 往下走，load() 自己会把连不上的错报出来 */
  }
  // 回到上次的位置（以前是写死 setNav('messages')：在哪个页面按 F5 都会被弹回消息页）
  load()
    .then(() => restorePlace())
    .catch((e) => { $('chat').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  startVersionWatch();
}



/* ---------------------------------------------------------------- 版本提醒 */

/*
 * 前端是**长活 SPA**：磁盘上的 app.js 换了，开着的页面不会自己换 JS ——
 * 2026-10-17 一天里踩了两回「点了没反应 / 看到的还是旧页面」，全是它：
 * 页面是几小时前加载的，点到的入口在新代码里有渲染分支、在旧代码里没有，于是原地不动。
 * 这里每 60 秒对一次 app.js 的指纹（mtime+size），变了就在右下角亮「刷新页面」提示条。
 * 为什么不自动 reload：人可能正打着一半字，自动刷新会把输入清掉 —— 提醒，让人自己挑时机。
 */
export function startVersionWatch() {
  let known = null;
  let told = false; // 同一轮变更只提醒一次，别每 60 秒都弹
  const check = async () => {
    let v;
    try {
      v = (await api('/api/web-version')).v;
    } catch {
      return; // 服务没起来 / 正在重启：下轮再说，别报错打扰人
    }
    if (v == null) return;
    if (known === null) {
      known = v; // 首次只记账不比较：页面刚加载，谈不上"变没变"
      return;
    }
    if (v !== known && !told) {
      told = true;
      const bar = document.createElement('div');
      bar.id = 'verBanner';
      bar.style.cssText =
        'position:fixed;right:18px;bottom:18px;z-index:999;display:flex;gap:10px;align-items:center;' +
        'padding:10px 14px;border:1px solid var(--line);border-radius:10px;background:var(--panel);' +
        'box-shadow:0 6px 24px rgba(0,0,0,.14);font-size:13px;color:inherit';
      bar.innerHTML =
        '代码有更新，这个页面还是旧的。<button class="mini auto" id="verReload">刷新页面</button>';
      bar.querySelector('#verReload').onclick = () => location.reload();
      document.body.append(bar);
    }
  };
  check();
  setInterval(check, 60000);
}
