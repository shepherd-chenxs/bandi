/* connectors.mjs —— 插件、界面插件（市场那部分）、连接器：添加 / 修改、运行时：设备 → CLI → 详情。
 * 2026-10-22 由 app.js（15537 行单文件）拆出，原生 ESM、无打包器；逻辑逐字搬运。 */
import { esc, toast } from './shell.mjs';
import { api, failHtml, initial, post } from './ui.mjs';
import { setNav } from './state.mjs';
import { openSettings } from './settings.mjs';
import { confirmDo, mountJoinPanel, renderCliDetail, renderDeviceDetail, rich } from './machine.mjs';
import { renderList } from './contacts.mjs';
import { openProjectsPage, openTaskBoard } from './projects.mjs';
import { openPlugins } from './experts.mjs';
import { $, LOCAL_BASE, S } from './core.mjs';



/* ---------------------------------------------------------------- 插件 */

/**
 * 三个页签：
 * · 公开 —— 随仓库走的推荐清单（apps/server/catalog/connectors.json）。不是市场，是一份"能装什么"的清单；
 * · 已安装 —— 账本（data/connectors.json）：启停、实探、改、卸载；
 * · 个人 —— 本机来源的（source.kind === 'local'）+ 手工粘一条。
 *
 * 装一条 = 把清单条目落成账本里的一行，班底只**接线**：代码在 codex / dsh 自己的进程里跑。
 */
export const PLG_TABS = [
  ['installed', '已安装'],
  ['panels', '界面插件'],
  ['catalog', '公开'],
  ['personal', '个人'],
];



export const isPersonalCat = (c) => c.category === '个人';


export const publicCatalog = () => S.catalog.filter((c) => !isPersonalCat(c));


export const personalCatalog = () => S.catalog.filter(isPersonalCat);


export const localConnectors = () => S.connectors.filter((c) => c.source?.kind === 'local');


export const connectorById = (id) => S.connectors.find((c) => c.id === id) ?? null;



export async function renderPlugins() {
  $('settingsView').innerHTML = rtLoading('插件');
  let list;
  let cat;
  let fam;
  let plg;
  try {
    [list, cat, fam, plg] = await Promise.all([
      api('/api/connectors'),
      api('/api/connectors/catalog'),
      api('/api/runtime-families'),
      api('/api/plugins'),
    ]);
  } catch (err) {
    $('settingsView').innerHTML = `${headRow('<b>插件</b>')}<div class="empty">${failHtml(err)}</div>`;
    return;
  }
  S.connectors = list.connectors ?? [];
  S.catalog = cat.catalog ?? [];
  S.plugins = plg.plugins ?? [];
  S.catalogError = cat.error ?? null;
  S.runtimeFamilies = (fam.families ?? []).map((f) => ({ id: f.id, label: f.label }));

  const counts = {
    installed: S.connectors.length,
    catalog: publicCatalog().length,
    personal: personalCatalog().length + localConnectors().length,
  };

  $('settingsView').innerHTML = `
    ${headRow('<b>插件</b>')}
    <div class="detail-body">
      <div class="seg plg-tabs">
        ${PLG_TABS.map(
          ([key, label]) =>
            `<button data-plgtab="${key}" class="${S.pluginTab === key ? 'on' : ''}">${label}${
              counts[key] ? ` ${counts[key]}` : ''
            }</button>`,
        ).join('')}
      </div>
      <div id="plgBody"></div>
    </div>`;

  $('plgBody').innerHTML =
    S.pluginTab === 'catalog' ? plgCatalogHTML()
    : S.pluginTab === 'personal' ? plgPersonalHTML()
    : S.pluginTab === 'panels' ? plgPanelsHTML()
    : plgInstalledHTML();
  wirePlugins();
  wirePanelMarket();
}



/* ------------------------------------------------- 界面插件（市场那部分）*/

/**
 * 市场行：安装 / 停用 / 启用 / 卸载。
 * 和连接器的语义对齐 —— **停用**只是不生效（文件留着），**卸载**是把目录删掉。
 */
export function plgPanelRowHTML(p) {
  const tags = [
    p.installed ? '<span class="set-tag">已安装</span>' : '',
    p.installed && p.enabled ? '<span class="set-tag">启用中</span>' : '',
    p.installed && !p.enabled ? '<span class="set-tag">已停用</span>' : '',
    p.connector ? `<span class="set-tag">工具：${esc(p.connector)}</span>` : '',
    p.valid ? '' : '<span class="set-tag" style="color:var(--bad);border-color:var(--bad)">配置有问题</span>',
  ]
    .filter(Boolean)
    .join('');

  let actions;
  if (!p.valid) {
    actions = `<span class="plg-warn">${esc(p.errors[0])}</span>`;
  } else if (!p.installed) {
    actions = `<button class="primary" data-plg-act="install" data-plg-id="${esc(p.id)}">安装</button>`;
  } else {
    actions =
      `<button data-plg-act="${p.enabled ? 'disable' : 'enable'}" data-plg-id="${esc(p.id)}">${p.enabled ? '停用' : '启用'}</button>` +
      `<button class="danger" data-plg-act="uninstall" data-plg-id="${esc(p.id)}">卸载</button>`;
  }

  return `<div class="set-row plg-row">
    <div class="plg-ico">${esc(initial(p.label))}</div>
    <div class="plg-card-main">
      <div class="plg-title"><b>${esc(p.label)}</b>${tags}</div>
      <div class="plg-desc">${esc(p.description || '')}</div>
      <div class="plg-meta">${esc(p.id)} · v${esc(p.version || '—')}</div>
    </div>
    <div class="plg-row-actions">${actions}</div>
  </div>`;
}



export function plgPanelsHTML() {
  if (!S.plugins.length) {
    return '<div class="empty">市场里还没有界面插件<br />把插件放进 catalog/plugins/&lt;id&gt;/ 就会出现</div>';
  }
  return `<div class="set-box">${S.plugins.map(plgPanelRowHTML).join('')}</div>
    <div class="hint-line">「安装」把它拷进 plugins/；「停用」只是不生效，文件留着；「卸载」会把那个目录删掉。</div>
    <div class="hint-line">停用或卸载后，左边一级栏的「插件」入口里就不再有它。</div>`;
}



export function wirePanelMarket() {
  document.querySelectorAll('[data-plg-act]').forEach((el) => {
    el.onclick = async () => {
      const id = el.dataset.plgId;
      const act = el.dataset.plgAct;
      const p = S.plugins.find((x) => x.id === id);
      if (act === 'uninstall') {
        if (!(await confirmDo(`卸载「${p?.label ?? id}」？\n\n这会删掉 plugins/${id}/ 整个目录（市场源还在，可以再装回来）。`))) return;
      }
      el.disabled = true;
      try {
        if (act === 'uninstall') {
          await api(`/api/plugins/${encodeURIComponent(id)}`, { method: 'DELETE' });
        } else {
          await post(`/api/plugins/${encodeURIComponent(id)}/${act}`, {});
        }
        await renderPlugins();   // 重新拉市场并重画
        renderList();            // rail 的入口也要跟着变
      } catch (err) {
        toast(err.message, 'error');
        el.disabled = false;
      }
    };
  });
}



export function plgCredentials(c) {
  const items = [...(c.env ?? []), ...(c.headers ?? [])];
  if (!items.length) return '';
  return `<div class="chips">${items
    .map((it) => `<span class="chip"><span class="chip-label">${esc(it.key)}${it.kind === 'ref' ? '（引用环境变量）' : '（已写死）'}</span></span>`)
    .join('')}</div>`;
}



export function plgRowHTML(c) {
  const where = c.command ? `${c.command} ${(c.args ?? []).join(' ')}`.trim() : c.url;
  const warn = (c.warnings ?? []).map((w) => `<div class="plg-warn">${esc(w)}</div>`).join('');
  return `<div class="set-row plg-row">
    <div class="plg-main">
      <div class="plg-title">
        <b>${esc(c.label)}</b>
        <span class="badge">${c.transport === 'stdio' ? '本地进程' : '远端服务'}</span>
        <span class="badge">${esc(c.source?.kind ?? '手工')}</span>
        ${c.enabled ? '' : '<span class="badge">已停用</span>'}
      </div>
      <div class="plg-meta">${esc(where || '（没写启动方式）')}</div>
      <div class="plg-meta">给：${c.runtimes?.length ? c.runtimes.map(esc).join('、') : '全部运行时'}</div>
      ${plgCredentials(c)}
      ${warn}
      <div class="plg-probe" data-probe-out="${esc(c.id)}"></div>
    </div>
    <div class="plg-actions">
      <button class="mini" data-probe="${esc(c.id)}" title="实探：真把它拉起来，看能不能用">测</button>
      <button class="mini" data-edit="${esc(c.id)}" title="改">改</button>
      <button class="mini" data-toggle="${esc(c.id)}" title="${c.enabled ? '停用' : '启用'}">${c.enabled ? '停' : '启'}</button>
      <button class="mini" data-del="${esc(c.id)}" title="卸载">卸</button>
    </div>
  </div>`;
}



export function plgInstalledHTML() {
  if (!S.connectors.length) {
    return '<div class="empty">还没装任何东西<br />去「公开」挑一个，或在「个人」里手工粘一条</div>';
  }
  return `<div class="set-box">${S.connectors.map(plgRowHTML).join('')}</div>
    <div class="hint-line">「测」是真的把它拉起来走一遍 MCP 握手：能不能用、有哪些工具，点一下就知道。</div>
    <div class="hint-line">走 npm 的那种第一次会下载包，慢一点；之后就有缓存了。</div>
    <div class="hint-line">Codex 把外部工具放在「工具搜索」后面 —— 要让数字员工用上，提示词里先让它 tool_search 找一下（班底随后会把这句写进首轮注入）。</div>`;
}



export function plgCardHTML(c) {
  const req = (c.requires ?? []).length
    ? `<div class="plg-req">需要：${c.requires
        .map((r) => `${esc(r.key)}${r.present ? '' : '（当前环境里没有）'}`)
        .join('、')}</div>`
    : '';
  return `<div class="plg-card">
    <div class="plg-ico">${esc((c.label || c.id).trim().slice(0, 1) || '?')}</div>
    <div class="plg-card-main">
      <div class="plg-title"><b>${esc(c.label)}</b><span class="set-tag">${esc(c.category)}</span></div>
      <div class="plg-desc">${esc(c.description)}</div>
      <div class="plg-meta">${esc(c.source.kind)} · ${esc(c.source.ref)}</div>
      ${req}
      ${c.note ? `<div class="plg-meta">${esc(c.note)}</div>` : ''}
    </div>
    ${c.installed ? '<span class="badge">已安装</span>' : `<button class="primary" data-install="${esc(c.id)}">安装</button>`}
  </div>`;
}



export function plgCatalogHTML() {
  const list = publicCatalog();
  const err = S.catalogError ? `<div class="plg-warn">${esc(S.catalogError)}</div>` : '';
  if (!list.length) return `${err}<div class="empty">清单是空的</div>`;
  return `${err}<div class="plg-grid">${list.map(plgCardHTML).join('')}</div>
    <div class="hint-line">这份清单随仓库走（apps/server/catalog/connectors.json），不是市场：一条条写清来源和启动方式，装之前你看得见它要什么。</div>`;
}



export function plgPersonalHTML() {
  const mine = localConnectors();
  const sample = personalCatalog();
  return `
    <section class="set-sec">
      <div class="set-head"><b>本机来源</b><span class="set-tag">装的路径在本机</span></div>
      <div class="set-box">
        ${
          mine.length
            ? mine.map(plgRowHTML).join('')
            : '<div class="set-row"><span class="dim">还没有本机来源的连接器</span></div>'
        }
      </div>
    </section>
    ${sample.length ? `<section class="set-sec">
      <div class="set-head"><b>本机示例</b><span class="set-tag">拿来验证链路</span></div>
      <div class="plg-grid">${sample.map(plgCardHTML).join('')}</div>
    </section>` : ''}
    <section class="set-sec">
      <div class="set-head"><b>手工添加</b><span class="set-tag">知道来源就能装</span></div>
      <div class="set-box">
        <div class="set-row">
          <div>
            <div class="set-label">粘一条 MCP 配置</div>
            <div class="dim" style="font-size:12px">本地进程（stdio）或远端服务（http）；装完建议点一次「测」。</div>
          </div>
          <button data-manual="1">添加…</button>
        </div>
      </div>
      <div class="hint-line">技能包（SKILL.md）是另一类个人扩展，在左边「技能」里管。</div>
    </section>`;
}



export function wirePlugins() {
  const root = $('settingsView');
  root.querySelectorAll('[data-plgtab]').forEach((el) => {
    el.onclick = () => {
      S.pluginTab = el.dataset.plgtab;
      renderPlugins();
    };
  });

  root.querySelectorAll('[data-install]').forEach((el) => {
    el.onclick = async () => {
      el.disabled = true;
      try {
        const r = await post('/api/connectors', { from: el.dataset.install });
        S.pluginTab = 'installed';
        await renderPlugins();
        const needs = (r.needs ?? []).filter((k) => k);
        if (needs.length) {
          toast(`装好了。它要用环境变量：${needs.join('、')}\n班底进程里没有的话，运行时会明确报出来。`);
        }
      } catch (err) {
        el.disabled = false;
        toast(err.message, 'error');
      }
    };
  });

  root.querySelectorAll('[data-probe]').forEach((el) => {
    el.onclick = async () => {
      const out = root.querySelector(`[data-probe-out="${el.dataset.probe}"]`);
      const show = (text, cls) => {
        if (!out) return;
        out.textContent = text;
        out.className = 'plg-probe' + (cls ? ' ' + cls : '');
      };
      el.disabled = true;
      show('探测中…（真起进程，慢的话十几秒）');
      try {
        const r = await post(`/api/connectors/${encodeURIComponent(el.dataset.probe)}/probe`);
        show(r.ok ? `可以用了。工具：${(r.tools ?? []).join('、') || '（它没报工具）'}` : `用不了：${r.error ?? '未知原因'}`, r.ok ? 'ok' : 'bad');
      } catch (err) {
        show('探测失败：' + err.message, 'bad');
      } finally {
        el.disabled = false;
      }
    };
  });

  root.querySelectorAll('[data-toggle]').forEach((el) => {
    el.onclick = async () => {
      const c = connectorById(el.dataset.toggle);
      if (!c) return;
      try {
        await api(`/api/connectors/${encodeURIComponent(c.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: !c.enabled }),
        });
        await renderPlugins();
      } catch (err) {
        toast(err.message, 'error');
      }
    };
  });

  root.querySelectorAll('[data-edit]').forEach((el) => {
    el.onclick = () => openConnDialog(connectorById(el.dataset.edit));
  });

  root.querySelectorAll('[data-del]').forEach((el) => {
    el.onclick = async () => {
      const c = connectorById(el.dataset.del);
      if (!c) return;
      if (!(await confirmDo(`卸载「${c.label}」？数字员工下次运行就用不到它了。`))) return;
      try {
        await api(`/api/connectors/${encodeURIComponent(c.id)}`, { method: 'DELETE' });
        await renderPlugins();
      } catch (err) {
        toast(err.message, 'error');
      }
    };
  });

  root.querySelectorAll('[data-manual]').forEach((el) => {
    el.onclick = () => openConnDialog(null);
  });
}



/* ------------------------------------------------- 连接器：添加 / 修改 */

export let connEditing = null;


export let connTransport = 'stdio';



export function connSetTransport(t) {
  connTransport = t === 'streamable-http' ? 'streamable-http' : 'stdio';
  $('connTransport')
    .querySelectorAll('[data-tr]')
    .forEach((b) => b.classList.toggle('on', b.dataset.tr === connTransport));
  $('cStdio').classList.toggle('plg-hidden', connTransport !== 'stdio');
  $('cHttp').classList.toggle('plg-hidden', connTransport !== 'streamable-http');
}



/** 一行一条 KEY=值 —— 值写成 env:名字 表示引用环境变量（凭据该走这条） */
export function parseKeyValues(text) {
  const out = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i <= 0) continue;
    out[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  }
  return out;
}



export function openConnDialog(entry) {
  connEditing = entry ?? null;
  $('connDlgTitle').textContent = entry ? `改连接器：${entry.label}` : '添加连接器';
  $('cId').value = entry?.id ?? '';
  $('cId').disabled = !!entry; // 名字是账本的键，装完不改
  $('cLabel').value = entry?.label ?? '';
  $('cCommand').value = entry?.command ?? '';
  $('cArgs').value = (entry?.args ?? []).join('\n');
  $('cCwd').value = entry?.cwd ?? '';
  $('cUrl').value = entry?.url ?? '';
  $('cBearer').value = entry?.bearerTokenEnv ?? '';
  $('cEnv').value = '';
  $('cHdr').value = '';
  // 凭据值不回吐（账本只给键），所以「改」时不预填 —— 留空=不动
  const envKeys = (entry?.env ?? []).map((e) => e.key);
  const hdrKeys = (entry?.headers ?? []).map((e) => e.key);
  $('cEnvKeys').textContent = envKeys.length ? `现有：${envKeys.join('、')}（留空＝不动）` : '目前没有环境变量';
  $('cHdrKeys').textContent = hdrKeys.length ? `现有：${hdrKeys.join('、')}（留空＝不动）` : '目前没有请求头';
  $('cRuntimes').innerHTML = (S.runtimeFamilies.length ? S.runtimeFamilies : [{ id: 'codex', label: 'codex' }, { id: 'dsh', label: 'dsh' }])
    .map(
      (f) =>
        `<label class="plg-rt"><input type="checkbox" value="${esc(f.id)}" ${
          entry?.runtimes?.includes(f.id) ? 'checked' : ''
        } /> ${esc(f.label)}</label>`,
    )
    .join('');
  connSetTransport(entry?.transport ?? 'stdio');
  $('connDlg').showModal();
  setTimeout(() => $('cLabel').focus(), 30);
}



/* ----------------------------------------------------- 运行时：设备 → CLI → 详情 */

// 加载态：右页头先写当前页标题（左栏只写「设置」），正文里说一声
export const rtLoading = (title) => `${headRow(`<b>${esc(title)}</b>`)}<div class="empty" style="padding:24px 4px">加载中…</div>`;



/**
 * 页头的「← 工作台」—— **2026-10-19 起不再调用**（用户要求统一去掉，见 headRow 的注释）。
 *
 * 当初加它的理由记在这儿，免得以后有人"发现"它没被用就删掉、过了半年又想不明白为什么要加：
 * 这些页的左栏一进来就换成了自己的列表，原来左栏顶上那条「‹ 工作台」就没了，
 * 只能靠页头那段灰面包屑点回去 —— 而面包屑第一段是灰的，一眼看不出能点。
 * 后来验证下来：**左栏那几行本身就够用**，按钮是重复入口。所以撤掉按钮，只留这份实现。
 */
export function backToWorkbench(label = '工作台') {
  return `<button class="icon-btn head-back" data-back-wb title="回${esc(label)}">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 6l-6 6 6 6" />
            </svg>
            <span>${esc(label)}</span>
          </button>`;
}



/**
 * 页头统一结构：左边标题（可以是一段 HTML，比如带徽标 / 输入框），右边按钮组。
 *
 * **不要返回按钮**（2026-10-19 用户第二次指着它说「统一去掉这个按钮」）。
 * 理由跟项目页那次一样，只是现在推广到全部子页：**每一页的左栏都已经写着"上一级"**
 *   · 项目 / 看板 —— 左栏是项目清单
 *   · 流程编排 / 流程记录 —— 左栏是流程模板 / 发起记录清单
 *   · 定时任务 / 插件面板 —— 左栏是工具清单
 * 想回哪儿都能直接点那一行，页头再放一枚「← 工作台」就是同一件事的第二个入口，
 * 还白占页头最左边、把标题推得比别处靠右。
 *
 * 因此 `backToWorkbench` / `wireBackWb` 一对**保留但不再调用** ——
 * 留着是因为它们把"哪一页该回哪"这条知识写下来了（任务卡回看板、看板回项目），
 * 哪天要重新加回按钮，接线不用再猜一遍。
 */
export function headRow(titleHtml, actionsHtml = '') {
  return `<div class="detail-head head-row"><div class="head-title">${titleHtml || ''}</div>${
    actionsHtml ? `<div class="head-actions">${actionsHtml}</div>` : ''
  }</div>`;
}



/**
 * 接线页头那枚「← 上级」—— **2026-10-19 起不再调用**（按钮已从 headRow 里撤掉）。
 * 留着它是因为它把"哪一页回哪里"这条知识写下来了：任务卡回看板、看板回项目、
 * 其余回工作台。哪天要把按钮加回来，直接接这一根，不用每页重猜一遍。
 */
export function wireBackWb(root, back = () => openPlugins()) {
  root.querySelector('[data-back-wb]')?.addEventListener('click', () => {
    Promise.resolve()
      .then(back)
      .catch((e) => toast(e.message, 'error'));
  });
}



/**
 * 「上一级」点下去做什么 —— 面包屑的跳转表。
 *
 * 为什么要一张表 + 一次事件委托，而不是每处 `el.onclick = …`：
 *   · 页面是随时重建的（十几处 innerHTML），逐个绑定既啰嗦又会漏；
 *   · 页面里不该知道"怎么回项目/怎么回工作台"这些路由细节，写在这儿才好一起看。
 *
 * 值收一个 arg（比如「项目清单里选中它」）。指向的必须是**上一层**，不是"往回退一步"。
 *
 * ⚠️ 2026-10-19 设置 / 流程模块的面包屑撤掉之后，`settings` / `skills` / `flows`
 *    三个键没有宿主了，已删。`devices` / `device` 2026-10-20 又加回来了：
 *    运行时是多层页面（运行时 › 设备 › CLI），页头要用面包屑导航。
 *    以后要在别处用，照原样加回来即可：settings→openSettings('prefs')、
 *    skills→openSettings('skills')、flows→openWorkflows()。
 */
export const CRUMB_GO = {
  workbench: () => setNav('plugins'),   // 工作台宫格首页（点一级栏那条路，顺带收左栏）
  contacts: () => setNav('contacts'),
  // 消息：从「已归档」子视图的面包屑回主列表（setNav 默认就会清掉 archivedView）
  messages: () => setNav('messages'),
  // 工作台里的几处
  // 带 arg 就是"项目清单里选中它"（面包屑里点某个项目的名字回到它的详情页）
  projects: (id) => openProjectsPage(id ?? undefined),
  board: () => openTaskBoard(),
  // 运行时那两级：不是"分节"而是状态 —— 得先把 S.rtLevel 摆好，renderRuntimes 按它分发
  devices: () => { S.rtLevel = 'devices'; S.rtDevice = null; S.rtRuntime = null; return renderRuntimes(); },
  device: () => { S.rtLevel = 'device'; S.rtRuntime = null; return renderRuntimes(); },
  // 设置子页（技能等）的面包屑回设置首页
  settings: () => openSettings('prefs'),
  // 技能详情的面包屑回技能列表
  skills: () => openSettings('skills'),
};



/**
 * 可点的面包屑（2026-10-19 起全站子页页头都用它）。
 *
 * items: `[{ label, to?, arg? }]` —— 最后一段**不传 to**（那是当前位置，不该点）。
 *   · `to` 是 `CRUMB_GO` 里的键，不是 URL；
 *   · `arg` 给需要 id 的那种（比如回某个项目）。
 *
 * 层级只表达"我在哪一层"，不承担"后退"——所以别把上一级的上一级也塞进来凑数，
 * 三层以内最好读；四层以上先想想是不是层级设计本身有问题。
 */
export function breadcrumb(items) {
  return `<nav class="crumb">${items
    .map((it, i) => {
      const sep = i ? '<span class="crumb-sep">›</span>' : '';
      if (!it.to) return `${sep}<span class="crumb-cur">${esc(it.label)}</span>`;
      return (
        `${sep}<button type="button" class="crumb-btn" data-crumb-to="${esc(it.to)}"` +
        `${it.arg != null ? ` data-crumb-arg="${esc(it.arg)}"` : ''}>${esc(it.label)}</button>`
      );
    })
    .join('')}</nav>`;
}



/**
 * 「局域网」那一行的状态话术已经不要了（2026-10-20 用户圈掉「已经开着 ✓」）：
 * 开/关由开关本身表达，"改了要点重启"由上面那句说明承担 —— 卡上不再有第三句话。
 */

export async function renderRuntimes() {
  if (S.rtLevel === 'cli' && S.rtDevice && S.rtRuntime) return renderCliDetail();
  if (S.rtLevel === 'device' && S.rtDevice) return renderDeviceDetail();
  return renderDeviceList();
}



/* ① 模式页 —— **2026-10-21 五改：模式卡收成一行**（用户："上面那一块可以简化。
   一个开关，一个重启按钮就可以了"）——
   单机/总机分段 + 说明行 + 连接行全部收掉，只剩「总机」开关（开=总机、关=单机）+ 常显重启按钮。
   真加入成功之后整站换成节点页（renderNodeMode），那台机器上这页都进不去了，没有"模式"可切。
   「接入总机」是页面最底一节（只在单机档出现，常开、无标题，面板自己带「可用总机」）；
   备份挪去独立的「数据备份」分节，这页不再摆本机数据和导出。 */

/* 设备行（总机的设备区）：远程节点多一枚「在线/离线」+ 排队数 —— 行的骨架与本地完全一致 */
export const deviceRowHtml = (dev) => {
  const isNode = dev.kind === 'node';
  /* 「本机」身份标签（2026-10-21 用户：节标题固定叫「设备」，本机这条用标签标出来 ——
     开关总机不再牵动标题）。颜色中性：它不是状态，只是身份。 */
  const self = dev.kind === 'local' ? '<em class="tag-dim">本机</em>' : '';
  const flag = isNode
    ? `<em class="${dev.online ? 'tag-ok' : 'tag-warn'}">${dev.online ? '在线' : '离线'}</em>`
    : '';
  // 队列里压着几个活 —— 节点离线时这个数会一直涨，那就是"离线排队"看得见的样子
  const queued = isNode && dev.pendingJobs ? ` · 排队 <b>${dev.pendingJobs}</b>` : '';
  const tail = isNode ? '（远程节点）' : '';
  return `<div class="row-item" data-open-device="${esc(dev.id)}">
    <div class="avatar">${esc(initial(dev.label))}</div>
    <div class="who">
      <b>${esc(dev.label)}${self}${flag}</b>
      <div class="sub">${esc(dev.platform)} · ${dev.runtimeCount} 个 agent CLI${queued}${tail}</div>
    </div>
    <span class="chev">›</span>
  </div>`;
};



export async function renderDeviceList() {
  S.rtLevel = 'devices';
  S.rtDevice = null;
  S.rtRuntime = null;
  // 左栏只写「设置」（在 openSettings 里），这一页的标题「这台机器」在右页头
  $('settingsView').innerHTML = rtLoading('这台机器');

  let list = [];
  try {
    list = (await api('/api/devices')).devices;
  } catch (err) {
    $('settingsView').innerHTML = `${headRow('<b>这台机器</b>')}<div class="empty">${failHtml(err)}</div>`;
    return;
  }
  // 网络现状（旧后端没这条路由 → 按默认画，页面不能因此白屏 ✗）
  let lan = { allowLan: false, boundLan: false, restartNeeded: false, urls: [], explicit: false };
  try {
    lan = await api('/api/lan');
  } catch { /* 忽略：按默认画 */ }
  // 模式卡附带的预警（如「另一个数据目录里也有节点常驻」）：拉不到不挡模式卡
  let local = null;
  try {
    local = await api(`${LOCAL_BASE}/status`);
  } catch { local = null; }

  /*
   * 模式只有一个事实源：netmode.allowLan（+ 启动参数 explicit）。
   * 「总机」不是又一个开关 —— 允许局域网连入 = 当总机，关掉 = 回单机
   * （用户 2026-10-21：「被局域网探测这个说法不对，开了之后也不是总机，不开是单机模式」）。
   * 收过的设备不算模式：单机也可能留着设备记录（重开总机就回来）。
   * explicit（BANDI_HOST 指定监听）的服务端总机：模式锁死，不给切。
   */
  /* 总机不接入别的总机（2026-10-21 截图反馈）：「接入总机」整条路只在**单机档**存在 ——
     收设备的机器不该同时摆着"去给别人当算力"的面板。分节只在单机档渲染，无需手动收。 */

  /*
   * 只有两档：单机 / 总机，开关就是切换本体（开=总机、关=单机 —— 2026-10-21 五改收成一行）。
   * 「接入总机」不是第三档模式，是页面最底一节（六改：常开不折叠；七改：连节标题也去掉）。
   * 真加入成功后整站换成节点页，那时这台已经没有"模式"可切了。
   */

  /*
   * 设备区**单机/总机都显示**（2026-10-21 用户：单机也要能进本机管运行时），
   * 但只有总机态给「添加设备」—— 单机不收设备，不派活给别人。
   * 单机态只列本机：手上留着的远程节点记录这时候连不上，摆出来反而误导。
   * （节点态走的是另一套整页 renderNodeMode，压根不渲染这页。）
   */

  $('settingsView').innerHTML = `
    ${headRow('<b>这台机器</b>')}
    <div class="detail-body">
      <!-- 模式节走 renderMode() 单独渲染（2026-10-21 十改，用户："切换的时候画面有点闪"）：
           切换只重画这一小块，设备/可用总机列表原地不动，不再整页 innerHTML 重写闪一下。
           （十一改：设备节 + 接入总机节也抽成 renderBody() —— 它们的显隐/过滤跟着模式走，
           切换**成功**后要连着重画，否则页面纹丝不动 —— 十改只顾模式卡，漏了下面。 -->
      <div id="modeMount"></div>
      <div id="devMount"></div>
      <div id="joinSlot"></div>
    </div>`;

  /* 模式节单独渲染：只重画 #modeMount 这一小块（整页重写是切换闪烁的根源）。
     lan 是闭包里的活对象 —— 切换成功后改它再重画，高亮/待重启标记/状态行都跟着走 */
  const modeNow = () => (lan.explicit || lan.allowLan ? 'host' : 'standalone');
  const renderMode = () => {
    const m = modeNow();
    const pd = !!lan.restartNeeded || (m === 'host' && !lan.boundLan);
    const mount = $('modeMount');
    if (!mount) return;
    /* 服务端总机（BANDI_HOST 指定监听，2026-10-21 截图反馈）：没有"模式"可言 ——
       这台锁死当总机，单机/总机切换、待重启标记、重启按钮全是摆设。
       整张模式卡不画，只留预警（如有）。 */
    if (lan.explicit) {
      mount.innerHTML = (local?.warnings ?? []).length
        ? `<section class="set-sec mode-sec">${(local?.warnings ?? []).map((w) => `<div class="machine-warn">${esc(w)}</div>`).join('')}</section>`
        : '';
      return;
    }
    mount.innerHTML = `
      <section class="set-sec mode-sec">
        <div class="set-head">
          <b>模式</b>${pd ? '<span class="set-tag">改了还没生效 —— 点「重启」生效</span>' : ''}
          <div class="mode-ctl">
            <div class="seg" id="modeSeg">
              <button data-mode="standalone" class="${m === 'standalone' ? 'on' : ''}">单机</button>
              <button data-mode="host" class="${m === 'host' ? 'on' : ''}" ${
                lan.explicit ? 'disabled title="监听地址由启动参数指定（BANDI_HOST），这台常驻当总机"' : ''
              }>总机</button>
            </div>
            <button class="btn-sm ${pd ? 'primary' : ''}" id="lanRestart">重启</button>
          </div>
        </div>
        <div class="mode-state">${
          m === 'host'
            ? '总机 —— 同一网络里的设备可以连到这台、领活干'
            : '单机 —— 只在这台电脑上用；切到「总机」，同一网络里的设备就能连进来领活'
        }</div>
        ${(local?.warnings ?? []).map((w) => `<div class="machine-warn">${esc(w)}</div>`).join('')}
      </section>`;
    wireModeCard({ lan, mode: m, refresh });
  };

  /* 模式之下的一切（设备节 + 接入总机节，2026-10-21 十一改）：显隐与过滤都跟着模式走 ——
     切换**成功**后跟着 renderMode 一起重画（十改只重画模式卡，下面纹丝不动是 bug）。
     「接入总机」节不要标题（用户连着两次删）——面板自己带「可用总机 + 发现/添加」。 */
  const renderBody = () => {
    const m = modeNow();
    const rows = m === 'host' ? list : list.filter((d) => d.kind !== 'node');
    const dev = $('devMount');
    const slot = $('joinSlot');
    if (!dev || !slot) return;
    dev.innerHTML = `
      <section class="fx">
        <div class="fx-head">
          <label>设备 <span class="count">${rows.length}</span></label>
          ${m === 'host' ? '<button class="btn-sm primary" id="joinNode">添加设备</button>' : ''}
        </div>
        ${rows.map(deviceRowHtml).join('')}
      </section>`;
    slot.innerHTML = m === 'standalone' ? '<section class="fx"><div id="joinMount"></div></section>' : '';
    const jn = $('joinNode');
    if (jn) jn.onclick = () => openJoinDialog(lan);
    if (m === 'standalone') mountJoinPanel($('joinMount'));
    /* 设备行点进去（本机 / 远程节点同一个入口，详情页自己分叉） */
    dev.querySelectorAll('[data-open-device]').forEach((el) => {
      el.onclick = () => {
        S.rtLevel = 'device';
        S.rtDevice = el.dataset.openDevice;
        renderRuntimes();
      };
    });
  };

  /* refresh(deep)：确认取消/请求失败只回拨模式卡高亮；切换**成功**传 deep=true，
     连着重画设备节与接入总机节（它们的显隐跟模式走） */
  const refresh = (deep) => {
    renderMode();
    if (deep) renderBody();
  };
  renderMode();
  renderBody();
}



/**
 * 模式卡的接线：单机⇄总机 = 改 allowLan + 重启生效（确认框把后果说全）。
 * 「接入总机」那节没有折叠态（面板常挂），这里不再管它；真加入成功后整站变节点页。
 */
export function wireModeCard({ lan, mode, refresh }) {
  const restart = $('lanRestart');
  if (restart) {
    restart.onclick = async () => {
      restart.disabled = true;
      restart.textContent = '重启中…';
      try {
        await post('/api/restart', {});
      } catch {
        restart.disabled = false;
        restart.textContent = '重启';
        return; // api() 已经提示过了
      }
      const t0 = Date.now();
      for (;;) {
        await new Promise((r) => setTimeout(r, 400));
        try {
          const r = await fetch('/api/state', { cache: 'no-store' });
          // 401 也算"起来了"（那说明它开始要令牌了 —— 刷新之后会看到登录页 ✓）
          if (r.ok || r.status === 401) break;
        } catch { /* 还没回来 */ }
        if (Date.now() - t0 > 20000) {
          restart.disabled = false;
          restart.textContent = '重启后没连上，刷新看看';
          return;
        }
      }
      location.reload();
    };
  }

  /* 选项卡即模式：点哪档切哪档，**不弹确认**（2026-10-21 用户："切换不要弹窗"）——
     切换本来就可逆（再点一下切回来），后果由状态行 + 「重启」按钮承担，不用对话框拦一道。
     请求失败 refresh() 把高亮拨回真实模式 —— 否则界面说的和库里存的是两回事。
     成功后改闭包里的 lan（allowLan + restartNeeded）再 refresh(true) ——
     deep=true 连着重画设备节/接入总机节（显隐跟模式走），模式卡本身原地重画不闪整页 */
  const modeSeg = $('modeSeg');
  if (modeSeg) {
    modeSeg.querySelectorAll('[data-mode]').forEach((btn) => {
      btn.onclick = async () => {
        const toHost = btn.dataset.mode === 'host';
        if (toHost === (mode === 'host')) return;
        try {
          await post('/api/lan', { allowLan: toHost });
        } catch {
          refresh();
          return; // api() 已经提示过了
        }
        lan.allowLan = toHost;
        lan.restartNeeded = true;
        refresh(true);
      };
    });
  }
}



/**
 * 「让一台新机器加入」：发一个**一次性邀请码**，把能直接粘的整条命令摆出来。
 *
 * 为什么要有这一步（2026-10-16）：节点原来用总机那枚 master 令牌 ✗ —— 一台被翻等于整套被翻，
 * 而且「忘掉」踢不掉它（令牌还有效）。现在换成"邀请码 → 每节点一枚自己的令牌"。
 *
 * ⚠️ 命令里的地址用 `location.origin`（**浏览器眼里**的控制面地址）——
 * 这正是那台新机器要连的地址 ✓；`BANDI_DATA` 必须跟那台机器上服务用的是同一个 ✗
 * （我迁移时就漏了这句，配置写到了别处，节点直接哑了）。
 */
export async function openJoinDialog(lan = null) {
  const dlg = $('joinDlg');
  const pre = $('joinCmd');
  const foot = $('joinFoot');
  pre.textContent = '正在生成邀请码…';
  foot.textContent = '';
  dlg.showModal();
  let inv;
  try {
    inv = await api('/api/nodes/invites', { method: 'POST' });
  } catch (err) {
    pre.textContent = '生成失败：' + err.message;
    return;
  }
  /*
   * 命令里的地址得是**那台新机器能连到的**那个 ✗ —— 不能一律用 `location.origin`：
   * 如果控制面已经开在局域网上，用户在**本机**打开这一页时 origin 是 `127.0.0.1` ✗，
   * 拿这条命令去别的机器上粘，那台机器会连到它**自己**的 127.0.0.1 ✗（然后一头雾水）。
   */
  const base =
    lan?.boundLan && lan.urls?.length ? lan.urls[0] : location.origin;
  const cmd = [
    '# 在那台新机器上跑（它得先有 Node 和这份代码 —— 见 deploy/README）',
    'export BANDI_DATA="$HOME/.bandi-node"',
    `node apps/server/src/node.mjs --join ${base} --code ${inv.code}`,
    '',
    '# 它换回自己的令牌之后，把它起成常驻（开机自己起）：',
    'BANDI_DATA="$HOME/.bandi-node" node apps/server/src/autostart.mjs install node',
  ].join('\n');
  pre.textContent = cmd;
  const at = new Date(inv.expiresAt);
  foot.innerHTML = rich(
    `这个码 ${at.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 前有效，**只用一次**。换来的令牌只能干它自己那台的事，随时可以在设备页把它忘掉（= 吊销）。` +
      (lan?.boundLan ? '' : '⚠️ 现在这台机器只听本机 —— 别的机器连不到它，得先在下面把「局域网」打开并重启。'),
  );
  $('joinCopy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      $('joinCopy').textContent = '已复制';
      setTimeout(() => { $('joinCopy').textContent = '复制命令'; }, 1500);
    } catch {
      toast('复制不了，手动选中吧：\n\n' + cmd);
    }
  };
}
