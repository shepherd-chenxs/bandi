/* connectors.mjs —— 插件、界面插件（市场那部分）、连接器：添加 / 修改、运行时：设备 → CLI → 详情。
 * 2026-10-22 由 app.js（15537 行单文件）拆出，原生 ESM、无打包器；逻辑逐字搬运。 */
import { esc, toast } from './shell.mjs';
import { api, failHtml, initial, post } from './ui.mjs';
import { setNav } from './state.mjs';
import { openSettings } from './settings.mjs';
import { confirmDo, paintLocalRuntimes, renderBackupSection, renderCliDetail, taskTail } from './machine.mjs';
import { renderList } from './contacts.mjs';
import { openProjectsPage, openTaskBoard } from './projects.mjs';
import { openPlugins } from './experts.mjs';
// 「协作」分节 2026-11-02 二十三改搬去 collab.mjs（协作中心页 #clBranchMount）——
// 这边不再 import renderCollabSection / watchCollabSection。与 collab.mjs 的互相 import
// 只剩单向（collab.mjs 引这儿的 headRow / paintModeCard），成环风险反而小了一截。
import { $, LOCAL_BASE, S } from './core.mjs';



/* ---------------------------------------------------------------- 插件 */

/**
 * 三个页签（2026-10-25 收成三个：界面插件不再单独一页，用户口径「在插件卡上加个
 * 标签就行」—— 卡上的「界面」标签（plgPanelCardHTML）负责认，列表负责放）：
 * · 公开 —— 能装什么：界面插件市场（catalog/plugins/&lt;id&gt;/）+ 连接器推荐清单（apps/server/catalog/connectors.json，不是市场，是一份"能装什么"的清单）；
 * · 已安装 —— 装了的：界面插件（启用/停用/卸载）+ 连接器账本（data/connectors.json：启停、实探、改、卸载）；
 * · 个人 —— 本机来源的（source.kind === 'local'）+ 手工粘一条。
 *
 * 装一条 = 把清单条目落成账本里的一行，班底只**接线**：代码在 codex / dsh 自己的进程里跑。
 */
export const PLG_TABS = [
  ['installed', '已安装'],
  ['catalog', '公开'],
  ['personal', '个人'],
];



export const isPersonalCat = (c) => c.category === '个人';


export const publicCatalog = () => S.catalog.filter((c) => !isPersonalCat(c));


/* 「个人」页签只画**账本里的**（本机来源 + 手工添加）——
   catalog 里 category='个人' 的那条（回声）**不再上界面**（2026-10-26 用户："把这个例子去掉"）。
   为什么条目本身还留在 catalog：`smoke-connectors` / `smoke-plugin-e2e` 拿它当零依赖 fixture，
   验证「装 → 探 → 停 → 卸」整条链路，删了冒烟就没东西可测了。 */


export const localConnectors = () => S.connectors.filter((c) => c.source?.kind === 'local');


export const connectorById = (id) => S.connectors.find((c) => c.id === id) ?? null;



/*
 * 插件/连接器卡的头像图形（2026-10-25 用户要求：文字方块换图形；同日二改：按 17px 重设计）。
 * 描边风格跟左侧导航、contacts 那套 ICON_* 一致（viewBox 24 / stroke 1.7 / round），
 * 颜色继承 .plg-ico 的字色（currentColor），不另配色。
 *
 * 设计约束：.plg-ico svg 最终只有 17px —— 一颗图标**一个主形、最多一处细节**，
 * 笔画再多就糊。六个类别的取舍：
 *   · 开发 = 合体 </>（斜杠把两个括号缝起来，主形完整，不再两笔分离）；
 *   · 生产力 = 闪电修形（下笔更宽、收笔更尖，重心居中）；
 *   · 运维 = 单机柜两层（一个矩形里的层级，替代两个分离矩形的"_eq_"感）；
 *   · 个人 = 钥匙（原人形与左栏通讯录撞形，钥匙的"私人"语义也更准）；
 *   · panel / connector 兜底微调（窗口加内容线，插头出线弯钩代替直垂线）。
 * 连接器按 catalog 的 category 配形，认不出的落「插头」兜底 —— 图形只认**类别**，
 * 不按名字猜（起名千变万化）。
 *
 * 2026-10-25 二轮补充：用户真正要的是「每个连接器自己的品牌图标」，
 * 故新增 CONN_ICONS（按产品 id 认），plgIconFor 优先 id → 类别 → 插头。
 * 类别形保留：给 catalog 之外的自定义连接器兜底。
 */
const IC = (inner) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

export const PLG_ICONS = {
  // 界面插件：浏览器窗口（框 + 顶栏 + 两颗窗钮 + 内容区一条线）
  panel: IC('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9.2h17"/><path d="M6.2 7h.01M8.7 7h.01"/><path d="M6.5 13h7"/>'),
  // 连接器兜底：插头（两脚留出气口 + 半圆罩 + 出线弯钩）
  connector: IC('<path d="M9 7.2V4.6M15 7.2V4.6"/><path d="M6.8 7.2h10.4v3.4a5.2 5.2 0 0 1-10.4 0z"/><path d="M12 16v1.9c0 1.1.9 2 2 2h1.6"/>'),
  // 独立软件（外部件，2026-11-04「软件」商店条目）：双向交换 —— 这类东西（magpie）的本行
  // 就是"两种协议互转"，两根反向箭头一个主形就说明白了
  软件: IC('<path d="M4.5 8.8h13"/><path d="M14.4 5.6l3.1 3.2-3.1 3.2"/><path d="M19.5 15.2h-13"/><path d="M9.6 12l-3.1 3.2 3.1 3.2"/>'),
  开发: IC('<path d="M8.6 7.6 4.4 12l4.2 4.4"/><path d="M15.4 7.6l4.2 4.4-4.2 4.4"/><path d="M13.4 6 10.6 18"/>'),
  生产力: IC('<path d="M13.4 3 6.4 13.2h4.4L10.6 21l7-10.2h-4.4z"/>'),
  运维: IC('<rect x="4.5" y="3.2" width="15" height="6.9" rx="1.6"/><rect x="4.5" y="13.9" width="15" height="6.9" rx="1.6"/><path d="M7.5 6.6h.01M7.5 17.3h.01"/><path d="M13 6.6h3.3M13 17.3h3.3"/>'),
  个人: IC('<circle cx="7.9" cy="8.3" r="3.9"/><path d="M10.7 11.1l8.1 8.2"/><path d="M15.6 16.9l2.1-2.1M17.9 19.2l2.1-2.1"/>'),
};

/** 连接器卡用哪个图形：先按产品 id 认（品牌形），认不出按类别，再兜底插头 */
export const plgIconFor = (c) => CONN_ICONS[c?.id] ?? PLG_ICONS[c?.category] ?? PLG_ICONS.connector;

/*
 * 每个连接器自己的品牌形（2026-10-25 二轮：用户要的是「产品自己的图标」，
 * 不是类别通配）。仍然 17px 一个主形最多一处细节，描边语言与全局一致。
 */
export const CONN_ICONS = {
  // 浏览器操作 → Chrome 环：外环 + 内环 + 三根辐条（120° 均分）
  'chrome-devtools': IC('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.2"/><path d="M12 8.8V3.5M9.2 13.6l-4.6 2.7M14.8 13.6l4.6 2.7"/>'),
  // GitHub → git 分支：主线两节点 + 分叉线并入
  github: IC('<circle cx="6.5" cy="6" r="2.1"/><circle cx="6.5" cy="18" r="2.1"/><circle cx="17.5" cy="8.5" r="2.1"/><path d="M6.5 8.1v7.8"/><path d="M17.5 10.6c0 3.3-3.3 4.3-8.6 4.6"/>'),
  // 分步思考 → 上台阶 + 前进箭头
  'sequential-thinking': IC('<path d="M3.5 19.5h4.7v-4.7h4.7v-4.7h4.7V5.4h2.9"/><path d="M17.9 3.5l2.6 1.9-2.6 1.9"/>'),
  // 全能测试服务器 → 仪表盘：半弧 + 指针 + 轴心
  everything: IC('<path d="M4.2 15.8a7.8 7.8 0 1 1 15.6 0"/><path d="M12 15.8l3.3-4.3"/><circle cx="12" cy="15.8" r="1.1"/>'),
  // 文件系统 → 文件夹
  filesystem: IC('<path d="M3.5 6.8A1.8 1.8 0 0 1 5.3 5h4.1l2.1 2.4h7.2a1.8 1.8 0 0 1 1.8 1.8v8a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8z"/>'),
  // 长期记忆 → 数据库圆柱（顶面 + 一道中箍 + 底收）
  memory: IC('<ellipse cx="12" cy="6.2" rx="7.5" ry="2.9"/><path d="M4.5 6.2v11.6c0 1.6 3.4 2.9 7.5 2.9s7.5-1.3 7.5-2.9V6.2"/><path d="M4.5 12c0 1.6 3.4 2.9 7.5 2.9s7.5-1.3 7.5-2.9"/>'),
  // SSH → 终端窗口：无标题栏的框 + 提示符 >_
  ssh: IC('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M7 9.6l3.3 2.9L7 15.4"/><path d="M12.6 15.6H17"/>'),
  // 回声 → 声呐：源点 + 两道外扩波（界面不再摆这张示例卡，但手工装过的人还得有图标）
  'echo-local': IC('<path d="M8.6 12h.01"/><path d="M11.7 8.6a4.8 4.8 0 0 1 0 6.8M14.6 6a9 9 0 0 1 0 12"/>'),
};

/*
 * 卡上「安装」钮的图标形（2026-10-25 三轮：文字钮太大，改成图标小方钮）：
 * 下载-入托盘（箭头落下 + 接物的托），描边语言与上面一致。
 */
export const ICO_INSTALL = IC('<path d="M12 4.2v9.4"/><path d="M8.4 10.2l3.6 3.6 3.6-3.6"/><path d="M4.8 15.4v2.4c0 1 .8 1.8 1.8 1.8h10.8c1 0 1.8-.8 1.8-1.8v-2.4"/>');

/* 卡上「安装」图标钮（两路卡共用）：只换壳不换语义，data-plg-act / data-install 照旧走原 handler */
const ibtn = (attrs) =>
  `<button class="plg-ibtn" title="安装" aria-label="安装" ${attrs}>${ICO_INSTALL}</button>`;



export async function renderPlugins() {
  $('settingsView').innerHTML = rtLoading('插件');
  let list;
  let cat;
  let fam;
  let plg;
  let ext;
  try {
    [list, cat, fam, plg, ext] = await Promise.all([
      api('/api/connectors'),
      api('/api/connectors/catalog'),
      api('/api/runtime-families'),
      api('/api/plugins'),
      // 「软件」商店条目（2026-11-04）：本机外部件的现状 + 清单。拉不到就整段不画，
      // 不挡插件/连接器 —— 老服务端没有这个接口时页面照常
      api('/api/local/externals').catch(() => null),
    ]);
  } catch (err) {
    $('settingsView').innerHTML = `${headRow('<b>插件</b>')}<div class="empty">${failHtml(err)}</div>`;
    return;
  }
  S.connectors = list.connectors ?? [];
  S.catalog = cat.catalog ?? [];
  S.plugins = plg.plugins ?? [];
  S.catalogError = cat.error ?? null;
  S.extSoftware = ext;   // { externals: 现状(probed), catalog: 清单 } 或 null
  S.runtimeFamilies = (fam.families ?? []).map((f) => ({ id: f.id, label: f.label }));

  // 旧会话可能还停在已撤掉的「界面插件」页签上 —— 归一到「已安装」（装了的界面插件就在那）
  if (S.pluginTab === 'panels') S.pluginTab = 'installed';
  /* 市场卡墙只认 slot='plugins' 的：settings.section 的（远程连接）是内置设置分节，不在这儿摆摊
     （2026-10-26 收编）；内置连接器（builtin）同理 —— 随功能出厂，不进卡墙。 */
  const marketPanels = S.plugins.filter((p) => p.panel?.slot === 'plugins');
  const panelsInstalled = marketPanels.filter((p) => p.installed).length;
  const userConns = S.connectors.filter((c) => !c.builtin);
  const swInstalled = extSoftware().filter((e) => e.installed).length;

  const counts = {
    installed: userConns.length + panelsInstalled + swInstalled,
    catalog: publicCatalog().length + marketPanels.length + (S.extSoftware?.catalog ?? []).length,
    personal: localConnectors().filter((c) => !c.builtin).length,   // 「个人」＝你自己的本机来源（示例已不再摆）
  };

  $('settingsView').innerHTML = `
    ${headRow(
      '<b>插件</b>',
      /* 「添加连接器」从「个人」页里那块「手工添加」搬到了页头右上（2026-10-26 用户：
         "添加按钮单独提出来，手工添加这个区没啥用"）。放在页头是因为它是**全局动作**
         —— 在哪个页签都能粘一条 MCP 配置，不必先切到「个人」。
         位置照卡片墙页的老规矩：动作/搜索一律页头右上（.expert-search / .sk-search 同款位置）。 */
      `<button class="btn-sm" data-manual="1">＋ 添加连接器</button>`,
    )}
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
    : plgInstalledHTML();
  wirePlugins();
  wirePanelMarket();
}



/* ------------------------------------------------- 界面插件（卡片 + 「界面」标签）*/

/**
 * 市场卡：安装 / 停用 / 启用 / 卸载。
 * 和连接器的语义对齐 —— **停用**只是不生效（文件留着），**卸载**是把目录删掉。
 *
 * 2026-10-25 用户拍板的两条口径：
 *   · 不单独占页签 —— 混在「已安装」/「公开」里，靠卡上的**「界面」标签**认；
 *   · **用连接器那种网格卡片**（.plg-grid + .plg-card），跟「公开」里的连接器卡同一个样子，
 *     不再是行式条目。
 */
/**
 * 市场卡（2026-10-25 二轮：卡片改小，点击弹详情）：
 * 卡上只留 名称 / 标签 / 两行简介 +（未装时的）安装钮；
 * 全文、版本、配置错误、启停卸载都在 plgDlg 弹窗里 —— 点卡即出。
 * 和连接器的语义对齐 —— **停用**只是不生效（文件留着），**卸载**是把目录删掉。
 * 不单独占页签，混在「已安装」/「公开」里，靠卡上的**「界面」标签**认。
 */
export function plgPanelCardHTML(p) {
  const tags = [
    '<span class="set-tag">界面</span>',
    p.installed ? '<span class="set-tag">已安装</span>' : '',
    p.installed && p.enabled ? '<span class="set-tag">启用中</span>' : '',
    p.installed && !p.enabled ? '<span class="set-tag">已停用</span>' : '',
    p.connector ? `<span class="set-tag">工具：${esc(p.connector)}</span>` : '',
  ]
    .filter(Boolean)
    .join('');

  const act = !p.valid
    ? ''
    : p.installed
      ? ''
      : ibtn(`data-plg-act="install" data-plg-id="${esc(p.id)}"`);

  return `<div class="plg-card plg-card-click" data-plgview="panel:${esc(p.id)}" title="点击看详情">
    <div class="plg-ico">${PLG_ICONS.panel}</div>
    <div class="plg-card-main">
      <div class="plg-title"><b>${esc(p.label)}</b>${p.valid ? '' : '<span class="set-tag" style="color:var(--bad);border-color:var(--bad)">配置有问题</span>'}</div>
      <div class="plg-tags">${tags}</div>
      <div class="plg-desc plg-desc-clamp">${esc(p.description || '')}</div>
    </div>
    ${act}
  </div>`;
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



/**
 * 已装连接器卡（2026-10-25 用户：「这个也做成卡片，测和改不要了，改太复杂了，用户操作不了」）：
 * 跟市场小卡同款 —— 图标 / 名称 / 标签 / 两行截断说明，卡上**没有任何按钮**；
 * 停用/启用、卸载都进详情弹窗（点卡即出）。测/改整个撤掉 —— 实探和手编 JSON 是排障用的，
 * 日常用户用不上，编辑需求走配置文件。
 * 说明文字优先借 catalog 同款连接器的简介（装的时候本来就从那来），借不到退启动命令行。
 */
export function plgConnCardHTML(c) {
  const where = c.command ? `${c.command} ${(c.args ?? []).join(' ')}`.trim() : c.url;
  const desc = publicCatalog().find((x) => x.id === c.id)?.description ?? where ?? '';
  const tags = [
    `<span class="set-tag">${c.transport === 'stdio' ? '本地进程' : '远端服务'}</span>`,
    `<span class="set-tag">${esc(c.source?.kind ?? '手工')}</span>`,
    c.enabled ? '' : '<span class="set-tag">已停用</span>',
  ].filter(Boolean).join('');
  const warn = (c.warnings ?? []).map((w) => `<div class="plg-warn">${esc(w)}</div>`).join('');
  return `<div class="plg-card plg-card-click" data-plgview="conn:${esc(c.id)}" title="点击看详情">
    <div class="plg-ico">${plgIconFor(c)}</div>
    <div class="plg-card-main">
      <div class="plg-title"><b>${esc(c.label)}</b></div>
      <div class="plg-tags">${tags}</div>
      <div class="plg-desc plg-desc-clamp">${esc(desc)}</div>
      ${warn}
    </div>
  </div>`;
}



/**
 * 「已安装」：装了的都在这 —— 界面插件（启用/停用/卸载）+ 连接器（测/改/停/卸）。
 * 界面插件和连接器各一段（段头说清是什么），卡上的「界面」标签负责逐卡认。
 */
export function plgInstalledHTML() {
  const panels = S.plugins.filter((p) => p.installed && p.panel?.slot === 'plugins');
  const conns = S.connectors.filter((c) => !c.builtin);
  const swSec = swSectionHTML({ onlyInstalled: true });
  if (!panels.length && !conns.length && !swSec) {
    return '<div class="empty">还没装任何东西<br />去「公开」挑一个，或在「个人」里手工粘一条</div>';
  }
  const panelsSec = panels.length
    ? `<section class="set-sec">
        <div class="set-head"><b>界面插件</b><span class="set-tag">带界面的扩展</span></div>
        <div class="plg-grid">${panels.map(plgPanelCardHTML).join('')}</div>
      </section>`
    : '';
  const connSec = conns.length
    ? `<section class="set-sec">
        <div class="set-head"><b>连接器</b><span class="set-tag">接进运行时的外部工具</span></div>
        <div class="plg-grid">${conns.map(plgConnCardHTML).join('')}</div>
        <div class="hint-line">点卡看详情：来源、启动方式、给哪些运行时，停用和卸载也在里面。</div>
        <div class="hint-line">走 npm 的那种第一次会下载包，慢一点；之后就有缓存了。</div>
        <div class="hint-line">Codex 把外部工具放在「工具搜索」后面 —— 要让数字员工用上，提示词里先让它 tool_search 找一下（班底随后会把这句写进首轮注入）。</div>
      </section>`
    : '';
  return swSec + panelsSec + connSec;
}



export function plgCardHTML(c) {
  return `<div class="plg-card plg-card-click" data-plgview="conn:${esc(c.id)}" title="点击看详情">
    <div class="plg-ico">${plgIconFor(c)}</div>
    <div class="plg-card-main">
      <div class="plg-title"><b>${esc(c.label)}</b></div>
      <div class="plg-tags"><span class="set-tag">${esc(c.category)}</span>${c.installed ? '<span class="set-tag">已安装</span>' : ''}</div>
      <div class="plg-desc plg-desc-clamp">${esc(c.description)}</div>
    </div>
    ${c.installed ? '' : ibtn(`data-install="${esc(c.id)}"`)}
  </div>`;
}

/* ------------------------------------------------- 软件（独立软件的商店条目，2026-11-04） */

/*
 * 「软件」= 独立软件的**商店条目**（magpie 是第一个）。用户原话：
 * "他不需要装到bandi里。他原来是什么样就什么样，这里只是为了不浪费时间去找安装包。"
 * 所以这里的全部职责：认得它、点一下帮你装它、看得见它跑没跑 —— 装上之后它自己管自己，
 * 没有"停用/卸载"（那是插件和连接器的语义，独立软件去它自己的安装器里卸）。
 */

/** 本机外部件现状（probed）；接口没拉到就空 —— 整段不画，别挡插件/连接器 */
export const extSoftware = () => S.extSoftware?.externals ?? [];

/** 清单条目 + 现状 + 最近任务 合成一张软件卡（「公开」「已安装」两处共用同一个样子） */
function swCardHTML(e, probedList) {
  const p = (probedList ?? []).find((x) => x.id === e.id);
  const installed = !!p?.installed;
  const t = S.extSoftware?.tasks?.[e.id] ?? null;   // 最近一次装/起任务 —— 服务端存的，刷新照样在
  const busy = !installed && !!t && !t.done;        // 排队/执行中：按钮收起来，别让人重复点
  const tags = [
    '<span class="set-tag">独立软件</span>',
    installed ? '<span class="set-tag">已安装</span>' : '',
    installed && p.gateway ? '<span class="set-tag">网关在跑</span>' : '',
    busy ? `<span class="set-tag">${t.running ? '安装中…' : '排队中…'}</span>` : '',
    !installed && t?.status === '失败' ? '<span class="set-tag">上次没装成</span>' : '',
  ]
    .filter(Boolean)
    .join('');
  /* 在装的时候，说明文字那行**就地变成进度**（输出末行），跟「这台机器」页同一套玩法 */
  const desc = busy
    ? `<span data-ext-tail="${esc(e.id)}">${esc(t.running ? `安装中… ${taskTail(t)}` : `排队中… ${taskTail(t) || '（等这台机器空出手）'}`)}</span>`
    : esc(e.note);
  return `<div class="plg-card plg-card-click" data-plgview="ext:${esc(e.id)}" title="点击看详情">
    <div class="plg-ico">${PLG_ICONS.软件}</div>
    <div class="plg-card-main">
      <div class="plg-title"><b>${esc(e.label)}</b></div>
      <div class="plg-tags">${tags}</div>
      <div class="plg-desc plg-desc-clamp">${desc}</div>
    </div>
    ${installed || busy ? '' : ibtn(`data-ext-install="${esc(e.id)}"`)}
  </div>`;
}

/** 「软件」分节。公开页画全清单（装了的打标），已安装页只画装了的 */
export function swSectionHTML({ onlyInstalled = false } = {}) {
  const cat = S.extSoftware?.catalog ?? [];
  const probed = extSoftware();
  const shown = onlyInstalled ? cat.filter((e) => probed.some((p) => p.id === e.id && p.installed)) : cat;
  if (!shown.length) return '';
  const foot = onlyInstalled
    ? '<div class="hint-line">它们独立运行、自己管自己 —— 班底只认得它、看得见它跑没跑。</div>'
    : '<div class="hint-line">点「安装」= 拿官方安装包、起它自己的安装程序；软件本身不装进班底，也不归班底卸。</div>';
  return `<section class="set-sec">
    <div class="set-head"><b>软件</b><span class="set-tag">独立软件 · 装在这台机器上</span></div>
    <div class="plg-grid">${shown.map((e) => swCardHTML(e, probed)).join('')}</div>
    ${foot}
  </section>`;
}

/**
 * 装一个「软件」条目：排一个 external-install 给本机（本机就地执行，命令出自服务端那张表），
 * 然后重画 —— 卡片立刻变「安装中」，进度和终态由 watchBusySoftware() 盯
 * （刷新页面也一样接得上，状态在服务端任务表里）。
 * Windows 上那一步是"下载官方安装包 + 启动安装程序" —— 任务"完成"
 * 指的是**安装程序已经启动**，真正的安装界面是软件自己的，用户自己点完。
 */
async function installSoftware(id, btn) {
  if (btn) btn.disabled = true;
  toast('在装了 —— 安装窗口弹出来后，按它的界面点完就行。');
  try {
    const r = await post('/api/nodes/local/tasks', { kind: 'external-install', family: id });
    if (!r.task?.id) throw new Error('任务没排上');
    await renderPlugins(); // 立刻重画：卡片这会儿就该变成「安装中」，不等轮询
    renderList();
  } catch (err) {
    if (btn) btn.disabled = false;
    toast(err.message, 'error');
  }
}

/**
 * 插件/连接器详情弹窗（2026-10-25）：卡改小后全文都搬到这里。
 * kind: 'panel' 界面插件 / 'conn' 连接器。动作做完关弹窗、重画列表。
 */
export function openPlgDetail(kind, id) {
  const dlg = $('plgDlg'), body = $('plgDlgBody');
  /* 定高弹窗（2026-10-25 "详情卡大小要一致"）：form 是 flex 列 —— 头条钉住、正文自己滚、
     动作条吸底。动作条因此必须在 form 层（正文外），每次打开先清掉上回搬上去的。 */
  const form = dlg.querySelector('form');
  form.querySelector(':scope > .dlg-actions')?.remove();

  if (kind === 'panel') {
    const p = S.plugins.find((x) => x.id === id);
    if (!p) return;
    $('plgDlgTitle').textContent = '界面插件详情';
    const tags = [
      '<span class="set-tag">界面</span>',
      p.installed ? '<span class="set-tag">已安装</span>' : '',
      p.installed && p.enabled ? '<span class="set-tag">启用中</span>' : '',
      p.installed && !p.enabled ? '<span class="set-tag">已停用</span>' : '',
      p.connector ? `<span class="set-tag">工具：${esc(p.connector)}</span>` : '',
    ].filter(Boolean).join('');
    let acts = '';
    if (p.valid && !p.installed) acts = `<button class="primary" data-dlg-act="install">安装</button>`;
    else if (p.valid && p.installed) {
      acts =
        `<button data-dlg-act="${p.enabled ? 'disable' : 'enable'}">${p.enabled ? '停用' : '启用'}</button>` +
        `<button class="danger" data-dlg-act="uninstall">卸载</button>`;
    }
    body.innerHTML = `
      <div class="plg-d-head">
        <div class="plg-ico">${PLG_ICONS.panel}</div>
        <div class="plg-d-who">
          <div class="plg-title"><b>${esc(p.label)}</b></div>
          <div class="plg-tags">${tags}</div>
        </div>
      </div>
      <div class="plg-desc">${esc(p.description || '（没有说明）')}</div>
      <div class="plg-meta">${esc(p.id)} · v${esc(p.version || '—')}</div>
      ${p.connector ? `<div class="plg-meta">给数字员工带的连接器：${esc(p.connector)}</div>` : ''}
      ${p.valid ? '' : (p.errors ?? []).map((e) => `<div class="plg-warn">${esc(e)}</div>`).join('')}
      ${acts ? `<div class="dlg-actions">${acts}</div>` : ''}
    `;
    /* 动作条一旦搬进 form，就不再是 body 的后代了 —— 事件必须挂到**搬走后的那个节点**上。
       2026-10-26 用户报「点击停用和卸载没有效果」：原按 body 查，一个按钮也查不到，
       onclick 全没绑上，按钮看着能点、点了什么也不发生（不报错、不请求、不关窗）。 */
    const bar = body.querySelector('.dlg-actions');
    if (bar) form.appendChild(bar);
    bar?.querySelectorAll('[data-dlg-act]').forEach((el) => {
      el.onclick = async () => {
        const act = el.dataset.dlgAct;
        if (act === 'uninstall') {
          if (!(await confirmDo(`卸载「${p.label}」？\n\n这会删掉 plugins/${p.id}/ 整个目录（市场源还在，可以再装回来）。`))) return;
        }
        el.disabled = true;
        try {
          if (act === 'uninstall') await api(`/api/plugins/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
          else await post(`/api/plugins/${encodeURIComponent(p.id)}/${act}`, {});
          dlg.close();
          await renderPlugins();
          renderList();
        } catch (err) {
          el.disabled = false;
          toast(err.message, 'error');
        }
      };
    });
    dlg.showModal();
    return;
  }

  /* 软件条目（2026-11-04）：现状 + 装法 + 它自己的入口（官网 / 面板） */
  if (kind === 'ext') {
    const e = (S.extSoftware?.catalog ?? []).find((x) => x.id === id);
    if (!e) return;
    const p = extSoftware().find((x) => x.id === id);
    $('plgDlgTitle').textContent = '软件详情';
    const tags = [
      '<span class="set-tag">独立软件</span>',
      p?.installed ? '<span class="set-tag">已安装</span>' : '<span class="set-tag">未安装</span>',
    ].join('');
    const bits = [];
    if (p?.where) bits.push(`<div class="plg-meta">装在：${esc(p.where)}</div>`);
    if (p?.gatewayPort) bits.push(`<div class="plg-meta">网关（127.0.0.1:${p.gatewayPort}）：${p.gateway ? '在应答 ✓' : '没起'}</div>`);
    /* 面板分两种形态（2026-11-04 用户纠正）：Windows 上 magpie 是桌面软件，面板是它自己的窗口（不是网页）；
       Linux 上才是网页（端口 3430）。别在 Windows 上报"端口 3430 没起"——那是拿网页的尺子量窗口。 */
    if (p?.panelKind === 'app') bits.push('<div class="plg-meta">它的面板：桌面软件自己的窗口（不是网页，点下面的按钮拉起来）</div>');
    else if (p?.panelPort) {
      /* 网页形态（Linux）没起时不要说半句 —— 下面有「把它的面板起起来」那颗按钮，
         别让人点一个打不开的链接（2026-11-04 thinkpad 实测：面板没起、链接照样给，点了是死页）。 */
      bits.push(
        `<div class="plg-meta">它自己的面板（端口 ${p.panelPort}）：${
          p.panel ? '起着' : e.serveCmd ? '没起 —— 点下面的按钮起它' : '没起'
        }</div>`,
      );
    }
    /* 装了但网关没起是最坑的状态 —— 被它接管的 agent 会全线 502，得喊出来 */
    const warn =
      p?.installed && p.gatewayPort && !p.gateway
        ? '<div class="plg-warn">装了但网关没起 —— 被它接管的 agent 会全线 502。去它自己的面板看看。</div>'
        : '';
    /* 最近一次安装任务（2026-11-04 用户："点击之后显示安装状态"）—— 状态在服务端，
       刷新/改天看都在。在装就不给安装按钮（重复点只会再排一个任务）。 */
    const t = S.extSoftware?.tasks?.[id] ?? null;
    const busy = !p?.installed && !!t && !t.done;
    if (busy) {
      bits.push(`<div class="plg-meta" data-ext-tail="${esc(id)}">${t.running ? '安装中…' : '排队中…'} ${esc(taskTail(t))}</div>`);
    } else if (t?.status === '失败') {
      bits.push(`<div class="plg-warn">上次安装没成：${esc(taskTail(t) || t.output?.slice(-200) || '（没有输出）')}</div>`);
    } else if (t?.status === '完成' && !p?.installed) {
      bits.push('<div class="plg-warn">上次任务报了「完成」，但这台机器上没认出它装好了 —— 点安装可以再来一遍。</div>');
    }
    /* 打开面板：桌面形态（Windows）→ 拉起它自己的窗口；网页形态（Linux）→ **只在面板起着时**
       给链接（没起就给死页，2026-11-04 thinkpad 实测踩到）；没起但表里有常驻命令 → 给它起起来。
       两条命令都在服务端那张表里，这里只发 id 与步骤（external-open / external-serve），边界不变。 */
    const panelUp = p?.panelKind === 'web' && !!p?.panel;
    let acts = '';
    if (!p?.installed && !busy) acts = `<button class="primary" data-dlg-act="ext-install">安装</button>`;
    else if (p?.installed && p.panelKind === 'app') acts = `<button class="primary" data-dlg-act="ext-panel">打开它的面板</button>`;
    else if (p?.installed && panelUp) acts = `<button class="primary" data-dlg-act="ext-panel">打开它的面板</button>`;
    else if (p?.installed && p.panelKind === 'web' && e.serveCmd) acts = `<button class="primary" data-dlg-act="ext-serve">把它的面板起起来</button>`;
    if (e.home) acts += `<button data-dlg-act="ext-home">打开官网</button>`;
    body.innerHTML = `
      <div class="plg-d-head">
        <div class="plg-ico">${PLG_ICONS.软件}</div>
        <div class="plg-d-who">
          <div class="plg-title"><b>${esc(e.label)}</b></div>
          <div class="plg-tags">${tags}</div>
        </div>
      </div>
      <div class="plg-desc">${esc(e.note || '（没有说明）')}</div>
      ${e.installCmd ? `<div class="plg-meta">装它这件事，实际做的是：${esc(e.installCmd)}</div>` : ''}
      ${e.downloadUrl ? `<div class="plg-meta">官方下载口：<a href="${esc(e.downloadUrl)}" target="_blank" rel="noopener">${esc(e.downloadUrl)}</a></div>` : ''}
      ${bits.join('')}
      ${warn}
      <div class="dlg-actions">${acts}</div>
    `;
    const bar = body.querySelector('.dlg-actions');
    if (bar) form.appendChild(bar);
    bar?.querySelectorAll('[data-dlg-act]').forEach((el) => {
      el.onclick = async () => {
        const act = el.dataset.dlgAct;
        if (act === 'ext-install') {
          dlg.close();
          await installSoftware(id, null);
        } else if (act === 'ext-panel') {
          if (p.panelKind === 'web') {
            // 网页形态：面板起着才有链接（没起的那条路径由「把它的面板起起来」那颗按钮兜住）
            window.open(p.panelUrl || `http://127.0.0.1:${p.panelPort}`, '_blank', 'noopener');
          } else {
            // 桌面软件的面板是它自己的窗口（Windows 上的 magpie）—— 排个 external-open，
            // 让这台机器自己把 exe 拉起来（命令出自服务端那张表，这里只发 id 与步骤）
            el.disabled = true;
            try {
              await post('/api/nodes/local/tasks', { kind: 'external-open', family: id });
              dlg.close();
              toast('打开了 —— 它的面板窗口应该已经弹出来（没看见就去任务栏找）。');
            } catch (err) {
              el.disabled = false;
              toast(err.message, 'error');
            }
          }
        } else if (act === 'ext-serve') {
          /* 网页形态的面板没起：让那台机器按表里那条常驻命令起它（`magpie daemon install --web --lan`）。
             起完面板端口就在了 —— 重新点开这里就能直接打开。 */
          el.disabled = true;
          try {
            await post('/api/nodes/local/tasks', { kind: 'external-serve', family: id });
            dlg.close();
            toast('在起它的面板了 —— 起好后重新点开这个软件，就能直接打开面板。');
            await renderPlugins();
            renderList();
          } catch (err) {
            el.disabled = false;
            toast(err.message, 'error');
          }
        } else if (act === 'ext-home') {
          window.open(e.home, '_blank', 'noopener');
        }
      };
    });
    dlg.showModal();
    return;
  }

  /* 先认账本（装了的），再退市场/本机清单（没装的）—— 同一 id 两边都有时以账本为准 */
  const led = S.connectors.find((x) => x.id === id) ?? null;
  const c = led ?? publicCatalog().find((x) => x.id === id) ?? localConnectors().find((x) => x.id === id);
  if (!c) return;
  $('plgDlgTitle').textContent = '连接器详情';
  const req = (c.requires ?? []).length
    ? `<div class="plg-req">需要：${c.requires
        .map((r) => `${esc(r.key)}${r.present ? '' : '（当前环境里没有）'}`)
        .join('、')}</div>`
    : '';
  const where = c.command ? `${c.command} ${(c.args ?? []).join(' ')}`.trim() : c.url;
  const desc = (led ? publicCatalog().find((x) => x.id === c.id)?.description : c.description) ?? '';
  let acts = '';
  let ledgerBits = '';
  if (led) {
    /* 装了的：停用/启用 + 卸载都收进弹窗（卡上无钮，测/改已撤 —— 2026-10-25 用户口径） */
    acts =
      `<button data-dlg-act="toggle">${led.enabled ? '停用' : '启用'}</button>` +
      `<button class="danger" data-dlg-act="uninstall">卸载</button>`;
    ledgerBits = `
      <div class="plg-meta">${esc(where || '（没写启动方式）')}</div>
      <div class="plg-meta">给：${led.runtimes?.length ? led.runtimes.map(esc).join('、') : '全部运行时'}</div>
      ${plgCredentials(led)}
      ${(led.warnings ?? []).map((w) => `<div class="plg-warn">${esc(w)}</div>`).join('')}
      ${led.enabled ? '' : '<div class="plg-warn">已停用 —— 只是没接进运行时，文件还在；启用即恢复。</div>'}`;
  } else {
    acts = `<button class="primary" data-dlg-act="install">安装</button>`;
  }
  body.innerHTML = `
    <div class="plg-d-head">
      <div class="plg-ico">${plgIconFor(c)}</div>
      <div class="plg-d-who">
        <div class="plg-title"><b>${esc(c.label)}</b></div>
        <div class="plg-tags">${led && !led.enabled ? '<span class="set-tag">已停用</span>' : ''}<span class="set-tag">${c.transport === 'stdio' ? '本地进程' : '远端服务'}</span><span class="set-tag">${esc(c.source?.kind ?? '手工')}</span></div>
      </div>
    </div>
    ${desc ? `<div class="plg-desc">${esc(desc)}</div>` : ''}
    <div class="plg-meta">${esc(c.source?.kind ?? '')}${c.source?.ref ? ' · ' + esc(c.source.ref) : ''}</div>
    ${req}
    ${c.note ? `<div class="plg-meta">${esc(c.note)}</div>` : ''}
    ${ledgerBits}
    ${led ? '' : (c.warnings ?? []).map((w) => `<div class="plg-warn">${esc(w)}</div>`).join('')}
    <div class="dlg-actions">${acts}</div>
  `;
  /* 同上：动作条搬进 form 后要在 bar 上查，不能在 body 上查（否则按钮没监听） */
  const bar = body.querySelector('.dlg-actions');
  if (bar) form.appendChild(bar);
  bar?.querySelectorAll('[data-dlg-act]').forEach((el) => {
    el.onclick = async () => {
      const act = el.dataset.dlgAct;
      if (act === 'uninstall') {
        if (!(await confirmDo(`卸载「${c.label}」？数字员工下次运行就用不到它了。`))) return;
      }
      el.disabled = true;
      try {
        if (act === 'install') {
          const r = await post('/api/connectors', { from: c.id });
          dlg.close();
          S.pluginTab = 'installed';
          await renderPlugins();
          const needs = (r.needs ?? []).filter((k) => k);
          if (needs.length) {
            toast(`装好了。它要用环境变量：${needs.join('、')}\n班底进程里没有的话，运行时会明确报出来。`);
          }
          return;
        }
        if (act === 'toggle') {
          await api(`/api/connectors/${encodeURIComponent(c.id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: !led.enabled }),
          });
        } else if (act === 'uninstall') {
          await api(`/api/connectors/${encodeURIComponent(c.id)}`, { method: 'DELETE' });
        }
        dlg.close();
        await renderPlugins();
      } catch (err) {
        el.disabled = false;
        toast(err.message, 'error');
      }
    };
  });
  dlg.showModal();
}



export function plgCatalogHTML() {
  const err = S.catalogError ? `<div class="plg-warn">${esc(S.catalogError)}</div>` : '';
  const list = publicCatalog();
  const panels = S.plugins.filter((p) => p.panel?.slot === 'plugins');   // settings.section 的不进市场（内置设置分节）
  const swSec = swSectionHTML();
  const panelsSec = panels.length
    ? `<section class="set-sec">
        <div class="set-head"><b>界面插件</b><span class="set-tag">带界面的扩展</span></div>
        <div class="plg-grid">${panels.map(plgPanelCardHTML).join('')}</div>
      </section>`
    : '';
  const connSec = list.length
    ? `<section class="set-sec">
        <div class="set-head"><b>连接器</b><span class="set-tag">随仓库走的清单</span></div>
        <div class="plg-grid">${list.map(plgCardHTML).join('')}</div>
      </section>`
    : (!panels.length && !swSec ? '<div class="empty">清单是空的</div>' : '');
  return `${err}${swSec}${panelsSec}${connSec}`;
}



export function plgPersonalHTML() {
  const mine = localConnectors().filter((c) => !c.builtin);   // 内置的不算"个人"（远程连接 SSH 随功能出厂）
  return `
    <section class="set-sec">
      <div class="set-head"><b>本机来源</b><span class="set-tag">装的路径在本机</span></div>
      ${
        mine.length
          ? `<div class="plg-grid">${mine.map(plgConnCardHTML).join('')}</div>`
          /* 空态自己承担引导（原来的「手工添加」区块已经撤掉，按钮在页头右上）：
             全局 `.empty` 是 60px 上下内边距，整页只剩这一段时中间空一大块，
             所以这里用虚线框 ——「这里还没有东西，加上就在右上」比一句话更像个位置。 */
          : `<div class="plg-empty">还没有本机来源的连接器<br /><span class="dim">点右上角「＋ 添加连接器」，粘一条 MCP 配置就能装。</span></div>`
      }
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

  /* 小卡点开详情；卡内按钮（安装）自己有 handler，不冒泡成「看详情」 */
  root.querySelectorAll('[data-plgview]').forEach((el) => {
    el.onclick = (ev) => {
      if (ev.target.closest('button')) return;
      const [kind, id] = el.dataset.plgview.split(':');
      openPlgDetail(kind, id);
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

  /* 2026-10-25 用户口径：测/改撤掉、停/卸进详情弹窗 —— 行式条目的 data-probe/
     data-toggle/data-edit/data-del 接线随之移除（弹窗里自己绑 data-dlg-act）。 */

  root.querySelectorAll('[data-ext-install]').forEach((el) => {
    el.onclick = async (ev) => {
      ev.stopPropagation(); // 别冒泡成"点卡看详情"
      await installSoftware(el.dataset.extInstall, el);
    };
  });

  watchBusySoftware();

  root.querySelectorAll('[data-manual]').forEach((el) => {
    el.onclick = () => openConnDialog(null);
  });
}

/**
 * 有「软件」条目正装着就**接着盯**（2026-11-04 用户："点击之后显示安装状态"）。
 *
 * 为什么独立于 installSoftware 的轮询：那份定时器活在点击那次渲染里 —— 用户一刷新
 * 页面它就没了，而任务在那台机器上**还在跑**。进度该跟「这台机器」页同一原则：
 * 状态在服务端，界面只负责接上（scheduleTaskPoll 同款思路）。做完才整页重画一次；
 * 跑的时候只就地改进度那行（2026-10-16 "页面不停刷新"的教训）。
 */
function watchBusySoftware() {
  clearTimeout(S.extWatchTimer);
  const busy = Object.entries(S.extSoftware?.tasks ?? {}).filter(([, t]) => t && !t.done);
  if (!busy.length) return;
  S.extWatchTimer = setTimeout(async () => {
    let dirty = false;
    for (const [family, t] of busy) {
      let next = null;
      try {
        next = (await api(`/api/nodes/local/tasks/${encodeURIComponent(t.id)}`)).task;
      } catch {
        continue; // 抖一下等下一轮
      }
      if (!next) continue;
      if (next.done) {
        dirty = true; // 做完/失败 —— 交给整页重画（探针也会跟着更新）
        if (next.status === '完成') S.pluginTab = 'installed';
        else toast(`「${family}」没装成：${taskTail(next) || '看服务端日志'}`, 'error');
      } else {
        const line = `${next.running ? '安装中…' : '排队中…'} ${taskTail(next)}`.trim();
        for (const el of document.querySelectorAll(`[data-ext-tail="${CSS.escape(family)}"]`)) el.textContent = line;
      }
    }
    if (dirty) {
      await renderPlugins();
      renderList();
    } else {
      watchBusySoftware(); // 接着盯
    }
  }, 1500);
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
 *   · 工作流 / 流程记录 —— 左栏是流程模板 / 发起记录清单
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
  // 2026-11-01 设备详情页撤了：旧的 device 面包屑目标归到这台机器页
  device: () => { S.rtLevel = 'devices'; S.rtDevice = null; S.rtRuntime = null; return renderRuntimes(); },
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
  return renderDeviceList();
}



/* ① 模式页 —— **2026-10-21 五改：模式卡收成一行**（用户："上面那一块可以简化。
   一个开关，一个重启按钮就可以了"）——
   单机/总机分段 + 说明行 + 连接行全部收掉，只剩「总机」开关（开=总机、关=单机）+ 常显重启按钮。
   真加入成功之后整站换成节点页（renderNodeMode），那台机器上这页都进不去了，没有"模式"可切。
   「接入总机」原是页面最底一节 —— **2026-11-01 晚整节撤掉**（用户："这个是干嘛的？历史遗留？"）：
   本机加入别的总机当算力节点的 UI 不再画，命令行 bandi nodes join 顶上；后端全留。
   备份/导出导入 2026-10-29 起也长回这页底下（「数据管理」区，见 dmMount）。 */

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
  // 网络现状 2026-11-01 晚不再读：模式卡搬去了「手机连接」页、「多机协同」节也撤了，
  // 这页没有再关心 lan 的地方（要加回来先想清楚谁消费）。

  /*
   * 形态的事实源（2026-11-03 终稿）：只剩 `netmode.acceptNodes` 一个运行期开关 ——
   * 角色：总机（收别的机器当节点）/ 分机（不收）。监听永远对外（`BANDI_HOST` 可钉
   * 具体地址），是启动配置的事，界面上没有开关（`allowLan` 已删）。
   * 收过的设备不算模式。
   */

  /*
   * ⚠️ 2026-11-01 撤掉「添加设备」（用户："总机-节点就算有的话，我也没办法让它干活"）：
   * 发邀请码改走命令行 `bandi nodes invite`；后端 `POST /api/nodes/invites` 与领活通道保留。
   *
   * ⚠️ 同日八改撤掉「设备」节 + 设备详情页（用户截图圈红"去掉这个模块和对应的页面"）：
   * 单机常态下那节只有「本机」一行，点进去的详情页（已安装/未安装/外部件）已全部并入
   * 下面的「运行时」区（paintLocalRuntimes）—— 模块和页面都成了多余的中间层。
   * 远程节点的详情页（renderNodeDetail）随之删除：设备节是它唯一的入口。
   * （节点态走的是另一套整页 renderNodeMode，不受影响。）
   */
  const localDev = list.find((d) => d.kind === 'local');

  $('settingsView').innerHTML = `
    ${headRow('<b>这台机器</b>')}
    <div class="detail-body">
      <!-- 2026-11-01 八改：设备节撤了；同日晚「多机协同」节也撤（用户："这个是干嘛的？历史遗留？"）——
           2026-11-02 二十三改：「协作」分节也搬去「协作中心」页（用户："把这个协作移到协作中心，
           通过分机和总机开关控制显示和隐藏"）—— 这页 = 运行时 / 数据管理。加入算力节点只剩
           命令行（bandi nodes join，总机发码 bandi nodes invite）。 -->
      <!-- 「运行时」区（2026-11-01 七改，用户："把运行时放到这个页面的数据管理上面"）：
           本机的「已安装」长在这页，看运行时不用再点进本机详情（paintLocalRuntimes）。 -->
      <div id="rtMount"></div>
      <!-- 「数据管理」区（2026-10-29 从设置独立分节降级成这页的一个区，用户："把数据管理
           作为这台机器的一个区域"）：不跟模式走 —— 模式切换只重画上面两块，这里原地不动。
           数据自己拉（状态 + backups 列表），拉完才画，失败各有兜底。 -->
      <div id="dmMount"></div>
    </div>`;

  /* 「多机协同」节 2026-11-01 晚整节撤掉（用户："这个是干嘛的？现在还在用吗，还是历史遗留？"）：
     本机加入别的总机当算力节点的 UI 不再画 —— 线上没一个节点登记过，用户跨机走的是协作中心。
     与设备详情页同口径：只撤界面，后端 /api/local/hosts/*、discover、nodes join/leave 全留，
     要用走命令行 bandi nodes join <总机地址> <邀请码>。 */

  /* 「协作」分节 2026-11-02 二十三改搬去「协作中心」页（collab.mjs renderCollabCenter
     的 #clBranchMount）—— 这页不再挂它，renderCollabSection / watchCollabSection 的
     import 一并撤了（collab.mjs 自己用，不再外借）。 */

  /* 「运行时」区（2026-11-01 七改）：本机的「已安装」长在这页 —— 数据管理上面。
     不 await：区块自己拉数据自己画，别挡着数据管理区先出来 */
  if (localDev) paintLocalRuntimes($('rtMount'), localDev.id).catch(() => {});
  /* 数据管理区：进页挂一次（里面的导出/导入按钮和快照列表跟模式无关，重挂反而白拉一遍接口） */
  renderBackupSection($('dmMount'));
}



/*
 * 2026-11-01 删除「让一台新机器加入」弹窗（原 openJoinDialog）：
 * 它只发邀请码、不发活 —— 收进来的机器没有派活入口（节点态整页见 renderNodeMode）。
 * 发码改命令行 `bandi nodes invite`；后端 `POST /api/nodes/invites` 不动。
 */
