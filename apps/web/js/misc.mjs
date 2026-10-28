/* misc.mjs —— 新建员工、新建群、换群助手、绑定、列表项右键菜单（绑定）、版本提醒。
 * 2026-10-22 由 app.js（15537 行单文件）拆出，原生 ESM、无打包器；逻辑逐字搬运。 */
import { esc, personLabel, personSubtitle, restorePlace, toast } from './shell.mjs';
import { api, createCombo, dt, post } from './ui.mjs';
import { load } from './state.mjs';
import { confirmDo } from './machine.mjs';
import { openPluginForm, pluginFormId } from './experts.mjs';
import { refreshDeptSuggest } from './contacts.mjs';
import { $, LOCAL_BASE, S } from './core.mjs';
import { MENU_KEYS, canSee, resolveRole } from './roles.mjs';



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



/** 字节数 → 人看得懂的（数据分节用；拿不到就是 —，不编一个 0） */
function sizeText(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 节点模式页 = **本机配置面**（2026-10-28 升级；2026-10-21 的原口径仍在：
 * 加入后这台机器只当算力，不做「看总机面板」）。
 *
 * 已加入总机的机器打开班底，看到的就是这一页 —— 左栏与正常面板整体收起
 * （`body.node-mode` 的 CSS 负责藏，`#nodeView` 长在 `main` 里）。
 * 为什么不是"看自己的面板"：面板（员工、会话、项目）只在总机上，派给这台机器的活
 * 记录也在总机 —— 那本地面板能回答的就只有"这台机器自己怎么配"。
 *
 * 所以这一页按**本机配置面**分节（连接 / 这台机器 / 运行时 / 访问方式 / 数据 / 关于），
 * 版式沿用设置页那套 `set-sec` / `set-box` / `set-row`，不另造视觉。
 * 每节的准入走 `roles.mjs` 的 `canSee(role, key)` —— 本轮恒真，但门必须有：
 * 以后「菜单配置」要改的就是那一处，不该回来重写这页。
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
   * 本机叫什么、跑的是哪个版本、实例标识、机器角色 —— 从 `/api/hello` 拿
   * （它不带秘密，节点身份/版本就是它的内容；`role` 是 2026-10-28 新增的机器角色）。
   * 不等它：先画，回来再重画一次。拉不到就名字位显示"这台电脑"，页面照常。
   */
  const self = { hostname: '', version: '', instanceId: '', role: '', httpPort: null };
  // 运行时清单：null = 还没回来；{ list } = 到了（可能为空）；{ error } = 读不到（不是白屏）
  let rts = null;
  let lastSt = null;
  api('/api/hello')
    .then((h) => {
      self.hostname = String(h?.hostname || h?.label || '');
      self.version = String(h?.version ?? '');
      self.instanceId = String(h?.instanceId ?? '');
      self.role = String(h?.role ?? '');
      self.httpPort = Number(h?.httpPort) || null;
      if (lastSt) draw(lastSt);
    })
    .catch(() => { /* 拿不到就不显示机器名，别白屏 */ });
  api('/api/runtimes')
    .then((r) => {
      // 只要**本机**的：远端节点自报的那些属于总机视野，不是"这台机器装了什么"
      rts = { list: (Array.isArray(r?.runtimes) ? r.runtimes : []).filter((x) => !x?.remote) };
      if (lastSt) draw(lastSt);
    })
    .catch((e) => {
      rts = { error: String(e?.message ?? '读不到') };
      if (lastSt) draw(lastSt);
    });

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
    /*
     * 查看者身份 × 机器角色的组合（roles.mjs）。机器角色优先信 `/api/hello` 的新字段；
     * 它还没回来时按 `/api/local/status` 的 joined 兜底 —— 这页本来就是"已加入"才画的，
     * 所以兜底恒为 node，不会出现"hello 慢半拍，六节先消失再出现"的闪动。
     */
    const machineRole = self.role === 'node' || c.joined ? 'node' : 'operator';
    const role = resolveRole({ isDevice: !!S.isDevice, machineRole });
    /* 明细行的小图标（14px 线性，颜色随 --dim）：给每行一点可扫读的锚点 */
    const ICO = {
      hub: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="7" rx="2"></rect><rect x="3" y="13" width="18" height="7" rx="2"></rect><path d="M7 7.5h.01"></path><path d="M7 16.5h.01"></path></svg>',
      link: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"></path><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"></path></svg>',
      pulse: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 12h-4l-3 9L9 3l-3 9H2"></path></svg>',
      clock: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>',
      chip: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"></rect><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"></path></svg>',
      term: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M7 9l3 3-3 3"></path><path d="M13 15h4"></path></svg>',
      shield: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"></path></svg>',
      db: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="6" rx="7" ry="3"></ellipse><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"></path><path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"></path></svg>',
      info: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v6"></path><path d="M12 7.5h.01"></path></svg>',
    };

    /* 一行「左标签 + 右值」；图标可选 */
    const row = (label, valueHtml, icon) =>
      `<div class="set-row"><span class="set-label">${icon ?? ''}${esc(label)}</span><div class="machine-data">${valueHtml}</div></div>`;

    /**
     * 一个分节。`key` 就是 roles.mjs 的菜单 key —— 准入检查**放在这里**，
     * 六个分节都从这一条路出去，不会有哪一节忘了过门。
     */
    const sec = (key, title, tag, inner, extra = '') =>
      canSee(role, key)
        ? `<section class="set-sec machine-card">
             <div class="set-head"><b>${esc(title)}</b>${tag ? `<span class="set-tag">${esc(tag)}</span>` : ''}</div>
             <div class="set-box">${inner}</div>
             ${extra}
           </section>`
        : '';

    /* —— 运行时那几行：还在拉 / 读不到 / 一个都没装 / 正常 —— */
    const runtimeRows = (() => {
      if (!rts) return row('探测中', '<span class="sub">稍等…</span>', ICO.term);
      if (rts.error) return row('读不到', `<span class="sub">这台机器上的 CLI 清单没取到（${esc(rts.error)}）</span>`, ICO.term);
      if (!rts.list.length) {
        return row('没有可用的 CLI', '<span class="sub">这台机器上一个 agent CLI 都没探到 —— 总机派来的活会跑不起来</span>', ICO.term);
      }
      return rts.list
        .map((r) => {
          const off = r.enabled === false;
          const bad = r.pathExists === false || r.launchable === false;
          const state = off
            ? '<span class="sub">未启用</span>'
            : bad
              ? '<span class="sub">路径不对劲，班底起不来</span>'
              : '<span class="machine-dot"></span><span class="machine-ok">可用</span>';
          const p = r.path ? `<div class="sub machine-addr">${esc(r.path)}</div>` : '';
          return `<div class="set-row"><span class="set-label">${ICO.term}${esc(r.label ?? r.id ?? 'CLI')}</span><div class="machine-data">${state}${p}</div></div>`;
        })
        .join('');
    })();

    const listen = self.httpPort ? `127.0.0.1:${self.httpPort}` : '127.0.0.1';

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
              <div class="node-hero-name" title="${esc(self.hostname)}">${esc(self.hostname || '这台电脑')}</div>
              <div class="node-hero-sub">${self.version ? `班底 v${esc(self.version)} · ` : ''}算力节点</div>
            </div>
            <span class="node-state${running ? ' on' : ''}">${running ? '在线' : '离线'}</span>
          </div>
          <div class="node-linkviz" data-on="${running ? '1' : '0'}" aria-hidden="true">
            <span class="node-link-end"><span class="node-link-dot"></span>这台电脑</span>
            <span class="node-link-line"></span>
            <span class="node-link-end host"><span class="node-link-dot"></span>${esc(host)}</span>
          </div>
          <div class="node-hero-line">这台电脑是「<b>${esc(host)}</b>」的算力节点 —— 总机把活派过来，在这台电脑上跑。班底的面板（员工、会话、项目）只在总机上；这台机器只负责<b>配置</b>和<b>干活</b>。</div>
        </section>

        ${sec(
          MENU_KEYS.NODE_CONNECTION,
          '连接',
          '总机',
          row('总机', esc(host), ICO.hub) +
            (c.controlPlane ? row('地址', `<span class="machine-addr">${esc(c.controlPlane)}</span>`, ICO.link) : '') +
            row(
              '节点进程',
              running
                ? `<span class="machine-dot"></span><span class="machine-ok">在线，等着接活</span>${external ? '<span class="sub">（开机自启）</span>' : ''}`
                : '<span class="machine-dot off"></span><span class="sub">没在跑 —— 重启这台电脑上的班底试试</span>',
              ICO.pulse,
            ) +
            (since ? row('加入时间', esc(since), ICO.clock) : ''),
          warnings +
            `<div class="set-note">面板在总机上，这里只有本机配置。打开总机面板要<b>用总机的访问令牌登录</b>（这台机器的身份帮不上忙）。</div>
             <div class="machine-actions"><button class="btn-sm" id="nodeOpenHost">打开总机面板</button></div>`,
        )}

        ${sec(
          MENU_KEYS.NODE_MACHINE,
          '这台机器',
          '本机',
          row('主机名', esc(self.hostname || '—'), ICO.chip) +
            row('版本', self.version ? esc(`v${self.version}`) : '—', ICO.info) +
            row('实例标识', `<span class="machine-addr">${esc(self.instanceId || s?.instanceId || '—')}</span>`, ICO.shield) +
            row(
              '机器角色',
              machineRole === 'node'
                ? '节点 <span class="sub">已加入总机，只当算力</span>'
                : '单机 <span class="sub">未加入任何总机</span>',
              ICO.hub,
            ),
        )}

        ${sec(
          MENU_KEYS.NODE_RUNTIMES,
          '运行时',
          '本机 CLI',
          runtimeRows,
          `<div class="set-note">只读 —— 这里列的是<b>这台机器</b>装了哪些 agent CLI；总机派活时用的就是它们。要加减请在本机装/卸 CLI。</div>`,
        )}

        ${sec(
          MENU_KEYS.NODE_ACCESS,
          '访问方式',
          '只本机',
          row('当前监听', `<span class="machine-addr">${esc(listen)}</span>`, ICO.link) +
            row('对外开放', '否 <span class="sub">节点机不对局域网 / 公网开放</span>', ICO.shield),
          `<div class="set-note">节点机不对外开放；要远程访问请用隧道（Cloudflare Tunnel / frp 之类），班底自己不提供。</div>`,
        )}

        ${sec(
          MENU_KEYS.NODE_DATA,
          '数据',
          '本机库',
          row('数据目录', `<span class="machine-addr">${esc(local.dataDir ?? '—')}</span>`, ICO.db) +
            row(
              '数据库',
              local.dbPath
                ? `<span class="machine-addr">${esc(local.dbPath)}</span><div class="sub">${esc(sizeText(local.dbSize))}${local.dbMtime ? ` · 最后修改 ${esc(dt(local.dbMtime))}` : ''}</div>`
                : '—',
              ICO.db,
            ) +
            row(
              '条数',
              `<span class="sub">员工 ${Number(counts.personas ?? 0)} · 会话 ${Number(counts.conversations ?? 0)} · 项目 ${Number(counts.projects ?? 0)}</span>`,
              ICO.info,
            ),
          `<div class="set-note">这是这台机器<b>原来的</b>数据 —— 当节点期间没被写过，退出总机就回到它。</div>`,
        )}

        ${sec(
          MENU_KEYS.NODE_ABOUT,
          '关于',
          '',
          row('产品', '班底 <span class="sub">自托管的多 agent 协作平台</span>', ICO.info) +
            row('版本', self.version ? esc(`v${self.version}`) : '—', ICO.info) +
            row(
              '仓库 / 文档',
              '<a href="https://github.com/shepherd-chenxs/bandi" target="_blank" rel="noreferrer">GitHub 仓库</a><span class="sub"> · README 与 docs/ 里有全部说明</span>',
              ICO.link,
            ),
        )}

        <div class="machine-actions">
          <button class="btn-sm danger" id="nodeLeave">退出总机</button>
        </div>
        <footer class="node-foot">${self.version ? `班底 v${esc(self.version)}` : '班底'} · 节点模式</footer>
      </div>`;

    const openBtn = $('nodeOpenHost');
    if (openBtn) {
      openBtn.onclick = () => {
        if (!c.controlPlane) return toast('这台机器没记着总机地址（config.json 里没有 controlPlane）');
        // **不做令牌注入**：跨源写 cookie 免不了，注入也只能是明目张胆的越权
        window.open(c.controlPlane, '_blank', 'noopener');
      };
    }

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
