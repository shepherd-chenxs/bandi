/* connectors.mjs —— 插件、界面插件（市场那部分）、连接器：添加 / 修改、运行时：这台机器页。
 * 2026-10-22 由 app.js（15537 行单文件）拆出，原生 ESM、无打包器；逻辑逐字搬运。 */
import { esc, toast } from './shell.mjs';
import { api, failHtml, initial, post } from './ui.mjs';
import { setNav } from './state.mjs';
import { openSettings } from './settings.mjs';
import { mountRemoteAccessCard } from './securityadmin.mjs';
import { confirmDo, paintLocalRuntimes, renderBackupSection, taskTail } from './machine.mjs';
import { renderList } from './contacts.mjs';
import { openProjectsPage, openTaskBoard } from './projects.mjs';
import { openPlugins } from './experts.mjs';
// 「协作」分节 2026-11-02 二十三改搬去 collab.mjs（协作中心页 #clBranchMount）——
// 这边不再 import renderCollabSection / watchCollabSection。与 collab.mjs 的互相 import
// 只剩单向（collab.mjs 引这儿的 headRow / paintModeCard），成环风险反而小了一截。
import { $, LOCAL_BASE, S } from './core.mjs';
// 连接器 JSON 的纯解析（不碰 DOM）—— 2026-11-22 起界面只剩一个 JSON 框，见 connjson.mjs 头注释
import { connJsonText, parseConnJson, toolsBrief } from './connjson.mjs';



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
/* 插件页签（2026-11-22 起只剩界面插件 + 独立软件）：连接器搬去「设置 › 扩展 › 连接器」，
   所以「个人」这个只服务连接器的页签也跟着搬过去（见 CONN_TABS）。 */
export const PLG_TABS = [
  ['installed', '已安装'],
  ['catalog', '公开'],
];

/* 连接器页签：装了的（含本机来源、手工粘的）/ 清单里可装的。
   没有「自定义」那一页 —— 它本来画的也是本机来源的连接器，跟「已安装」重复。 */
export const CONN_TABS = [
  ['installed', '已安装'],
  ['catalog', '可添加'],
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
  let plg;
  let ext;
  try {
    [list, cat, plg, ext] = await Promise.all([
      api('/api/connectors'),
      api('/api/connectors/catalog'),
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
  /* 2026-11-22：`/api/runtime-families` 在这里拉过 —— 唯一的读者是连接器弹窗那颗
     「给哪些运行时用」复选框。弹窗改成贴 JSON 后没人读了，请求一起撤掉
     （运行时要限就写在 JSON 里：`"runtimes": ["codex"]`，connjson.mjs 会透传）。 */

  // 旧会话可能还停在已撤掉的「界面插件」页签上 —— 归一到「已安装」（装了的界面插件就在那）
  if (S.pluginTab === 'panels') S.pluginTab = 'installed';
  // 「个人」页签 2026-11-22 随连接器拆页一起撤掉，停在那一档的旧会话归一到「已安装」
  if (S.pluginTab === 'personal') S.pluginTab = 'installed';
  /* 市场卡墙只认 slot='plugins' 的：settings.section 的（远程连接）是内置设置分节，不在这儿摆摊
     （2026-10-26 收编）；内置连接器（builtin）同理 —— 随功能出厂，不进卡墙。 */
  const marketPanels = S.plugins.filter((p) => p.panel?.slot === 'plugins');
  const panelsInstalled = marketPanels.filter((p) => p.installed).length;
  const swInstalled = extSoftware().filter((e) => e.installed).length;

  /* 计数只算**这一页有的东西**（2026-11-22 拆页）：连接器已经搬去「连接器」页，
     它的数字再挂在这里就成了对不上的账。 */
  const counts = {
    installed: panelsInstalled + swInstalled,
    catalog: marketPanels.length + (S.extSoftware?.catalog ?? []).length,
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
    : plgInstalledHTML();
  wirePlugins();
  wirePanelMarket();
  /* 连接器的版本探针（probeConnVersions）跟着连接器搬去 renderConnectors —— 这页已经没有
     MCP 卡，再探一遍只会白白拉起宝螺那种本机进程。 */
}



/* --------------------------------------------------------------- 连接器（独立分节）*/

/**
 * 「设置 › 扩展 › 连接器」（2026-11-22 用户："加个子菜单，连接器。把宝螺移动过去"）。
 *
 * 跟「插件」拆开以后各管各的：
 *   · 插件   = 装进班底里的**界面插件** + 自己管自己的**独立软件**（mappie）
 *   · 连接器 = MCP 来源（宝螺、github、ssh…），装一条 = 账本里多一行，班底只接线
 *
 * 只拉两个接口：`/api/connectors`（账本）和 `/api/connectors/catalog`（清单）。不碰
 * `/api/plugins` 和 `/api/local/externals` —— 那是插件页的账，拉来也没人看。
 */
export async function renderConnectors() {
  $('settingsView').innerHTML = rtLoading('连接器');
  let list;
  let cat;
  try {
    [list, cat] = await Promise.all([api('/api/connectors'), api('/api/connectors/catalog')]);
  } catch (err) {
    $('settingsView').innerHTML = `${headRow('<b>连接器</b>')}<div class="empty">${failHtml(err)}</div>`;
    return;
  }
  S.connectors = list.connectors ?? [];
  S.catalog = cat.catalog ?? [];
  S.catalogError = cat.error ?? null;
  // 旧会话可能停在「自定义」那一页（拆页前的页签）—— 归一到「已安装」
  if (S.connTab !== 'catalog') S.connTab = 'installed';

  const counts = {
    installed: S.connectors.filter((c) => !c.builtin).length,
    catalog: publicCatalog().length,
  };

  $('settingsView').innerHTML = `
    ${headRow(
      '<b>连接器</b>',
      /* 「添加连接器」跟着搬过来：它是连接器页的**主动作**，在所有页签都能粘一条 MCP 配置。
         位置照卡片墙页的老规矩：动作一律页头右上（.expert-search / .sk-search 同款）。 */
      `<button class="btn-sm" data-manual="1">＋ 添加连接器</button>`,
    )}
    <div class="detail-body">
      <div class="seg plg-tabs">
        ${CONN_TABS.map(
          ([key, label]) =>
            `<button data-conntab="${key}" class="${S.connTab === key ? 'on' : ''}">${label}${
              counts[key] ? ` ${counts[key]}` : ''
            }</button>`,
        ).join('')}
      </div>
      <div id="plgBody"></div>
    </div>`;
  paintConnBody();
}

/** 连接器页的卡墙内容（两个页签共用一次拼装，切页签时只换这个） */
function connBodyHTML() {
  if (S.connTab === 'catalog') {
    const err = S.catalogError ? `<div class="plg-warn">${esc(S.catalogError)}</div>` : '';
    const cards = publicCatalog().map(plgCardHTML);
    return cards.length
      ? `${err}<div class="plg-grid">${cards.join('')}</div>`
      : `${err}<div class="empty">清单是空的</div>`;
  }
  const conns = S.connectors.filter((c) => !c.builtin);   // 内置的（远程连接 SSH）随功能出厂，不上卡墙
  if (!conns.length) {
    /* 空态自己承担引导（跟原「自定义」页同一套虚线框）：整页只剩一句话时中间空一大块 */
    return `<div class="plg-empty">还没有连接器<br /><span class="dim">点右上角「＋ 添加连接器」粘一条 MCP 配置；也可以去「可添加」挑现成的。</span></div>`;
  }
  return `<div class="plg-grid">${conns.map(plgConnCardHTML).join('')}</div>`;
}

function paintConnBody() {
  const body = $('plgBody');
  if (!body) return;
  body.innerHTML = connBodyHTML();
  wirePlugins();          // 卡 / 安装钮 / 「添加连接器」都走同一套接线（下面 data-conntab 那份也在里面）
  probeConnVersions();
}

/** 连接器页签切换：只换 #plgBody，不整页重画（同插件页那条"别闪"的经验） */
function switchConnTab(key) {
  S.connTab = key;
  $('settingsView')?.querySelectorAll('[data-conntab]').forEach((el) => el.classList.toggle('on', el.dataset.conntab === key));
  paintConnBody();
}

/**
 * 两个扩展页共用的重画入口：动作（装/卸/删/改）落在哪一页，就重画哪一页。
 * 卡片、详情弹窗、安装轮询里原来都写死 `renderPlugins()`，拆页后必须改走这里。
 */
export function repaintExtensions() {
  return S.settingsSection === 'connectors' ? renderConnectors() : renderPlugins();
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

  return `<div class="plg-card plg-card-click sw-card" data-plgview="panel:${esc(p.id)}" title="点击看详情">
    <div class="sw-head">
      <div class="plg-ico">${PLG_ICONS.panel}</div>
      <div class="plg-title"><b>${esc(p.label)}</b>${p.valid ? '' : '<span class="set-tag" style="color:var(--bad);border-color:var(--bad)">配置有问题</span>'}</div>
      ${act}
    </div>
    <div class="plg-tags">${tags}</div>
    <div class="plg-desc plg-desc-clamp">${esc(p.description || '')}</div>
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
        await repaintExtensions();   // 重新拉市场并重画
        renderList();            // rail 的入口也要跟着变
      } catch (err) {
        toast(err.message, 'error');
        el.disabled = false;
      }
    };
  });
}



/* 凭据键名（`GITHUB_TOKEN（已写死）`）曾经在这里画成芯片。
   2026-11-22 撤：用户是"不懂技术的普通人"，一串大写下划线对他只是噪音；
   密钥配错时由 warnings 兜（那时候才需要看见键名）。 */



/**
 * 装完的提示（2026-11-22 用户："用户是不懂技术的普通人"）。
 *
 * 原来那句是「它要用环境变量：GITHUB_TOKEN\n班底进程里没有的话，运行时会明确报出来」——
 * 「环境变量」「班底进程」「运行时」三个内部词堆在一起，用户读完不知道要去做什么。
 * 现在先说**要干什么**（去配一把访问凭据 + 去哪找），再说**填的时候用哪个名字**。
 * 名字不能整句藏掉：界面上真要填它（设置 → 插件 → 自定义 → 改 → env），
 * 藏了就成了"知道要配、不知道配叫啥"。
 */
function toastConnInstalled(cid, r) {
  const needs = (r?.needs ?? []).filter(Boolean);
  if (!needs.length) return;
  const label = publicCatalog().find((x) => x.id === cid)?.label ?? '这个连接器';
  toast(`装好了。「${label}」还得配一把访问凭据才能用 —— 去它的说明里找申请方式。\n填的时候用这个名字：${needs.join('、')}`);
}

/**
 * 已装连接器卡（2026-10-25 用户：「这个也做成卡片，测和改不要了，改太复杂了，用户操作不了」）：
 * 跟市场小卡同款 —— 图标 / 名称 / 标签 / 两行截断说明。
 * 2026-11-22 用户："这里放一个开关控制启用停用" —— 头行右端加一颗开关，
 * 卡上就这**一个**控件，其余（卸载、看全文）仍进详情弹窗（点卡即出）。
 * 测/改整个撤掉 —— 实探和手编 JSON 是排障用的，日常用户用不上，编辑需求走配置文件。
 * 说明文字优先借 catalog 同款连接器的简介（装的时候本来就从那来），借不到退启动命令行。
 */
/**
 * 卡片第三行 = 一句简述。
 *
 * 2026-11-22 用户："这个改成简述" → "简述 baoluo 接过来的能力"。
 * 所以顺序是「这东西是什么」优先，**启动命令排最后**（它是手段，不是用户关心的东西）：
 *   目录描述 → 自己写的 note → 实探到的工具清单（接过来的能力）→ 连接方式兜底。
 * `tools` 由服务端 probe 后写回账本（`setTools`），是事实，不是文案。
 */
export function plgConnCardHTML(c) {
  const desc = publicCatalog().find((x) => x.id === c.id)?.description || c.note || toolsBrief(c.tools) || (c.transport === 'streamable-http' ? '连到远端服务的连接器' : '装在这台电脑上的连接器');
  const tags = [
    `<span class="set-tag">${c.transport === 'stdio' ? '本机' : '云端'}</span>`,
    // 版本号（2026-11-22 用户："显示宝螺的版本号"）：探针握手拿的 serverInfo.version，
    // renderPlugins/switchPlgTab 之后由 probeConnVersions 后台补进 DOM
    ...(S.connVersion?.[c.id] ? [`<span class="set-tag" data-connver="1">v${esc(String(S.connVersion[c.id]))}</span>`] : []),
    c.enabled ? '' : '<span class="set-tag">已停用</span>',
  ].filter(Boolean).join('');
  const warn = (c.warnings ?? []).map((w) => `<div class="plg-warn">${esc(w)}</div>`).join('');
  return `<div class="plg-card plg-card-click sw-card" data-plgview="conn:${esc(c.id)}" title="点击看详情">
    <div class="sw-head">
      <div class="plg-ico">${plgIconFor(c)}</div>
      <div class="plg-title"><b>${esc(c.label)}</b></div>
      <label class="switch sm" title="${c.enabled ? '启用中 —— 关掉就不再接线' : '已停用 —— 打开就重新接线'}">
        <input type="checkbox" data-conn-toggle="${esc(c.id)}" ${c.enabled ? 'checked' : ''} /><span></span>
      </label>
    </div>
    <div class="plg-tags">${tags}</div>
    <div class="plg-desc plg-desc-clamp">${esc(desc)}</div>
    ${warn}
  </div>`;
}



/**
 * 「已安装」（插件页）：界面插件（启用/停用/卸载）+ 独立软件。
 * 连接器 2026-11-22 搬去「设置 › 扩展 › 连接器」，这页不再画它们。
 */
export function plgInstalledHTML() {
  const panels = S.plugins.filter((p) => p.installed && p.panel?.slot === 'plugins');
  const probed = extSoftware();
  const sw = (S.extSoftware?.catalog ?? []).filter((e) => probed.some((p) => p.id === e.id && p.installed));
  if (!panels.length && !sw.length) {
    return '<div class="empty">还没装任何插件或软件<br />去「公开」挑一个</div>';
  }
  // 2026-11-22 用户："不要区分软件和连接器，都放一起展示"（连接器已拆走，软件和界面插件仍同一面墙）
  const cards = [...sw.map((e) => swCardHTML(e, probed)), ...panels.map(plgPanelCardHTML)];
  return `<div class="plg-grid">${cards.join('')}</div>`;
}



export function plgCardHTML(c) {
  return `<div class="plg-card plg-card-click sw-card" data-plgview="conn:${esc(c.id)}" title="点击看详情">
    <div class="sw-head">
      <div class="plg-ico">${plgIconFor(c)}</div>
      <div class="plg-title"><b>${esc(c.label)}</b></div>
      ${c.installed ? '' : ibtn(`data-install="${esc(c.id)}"`)}
    </div>
    <div class="plg-tags"><span class="set-tag">${esc(c.category)}</span>${c.installed ? '<span class="set-tag">已安装</span>' : ''}</div>
    <div class="plg-desc plg-desc-clamp">${esc(c.description)}</div>
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
    !installed && t?.status === 'failed' ? '<span class="set-tag">上次没装成</span>' : '',
  ]
    .filter(Boolean)
    .join('');
  /* 在装的时候，说明文字那行**就地变成进度**（输出末行），跟「这台机器」页同一套玩法 */
  const desc = busy
    ? `<span data-ext-tail="${esc(e.id)}">${esc(t.running ? `安装中… ${taskTail(t)}` : `排队中… ${taskTail(t) || '（等这台机器空出手）'}`)}</span>`
    : esc(e.note);
  return `<div class="plg-card plg-card-click sw-card" data-plgview="ext:${esc(e.id)}" title="点击看详情">
    <div class="sw-head">
      <div class="plg-ico">${PLG_ICONS.软件}</div>
      <div class="plg-title"><b>${esc(e.label)}</b></div>
      ${installed || busy ? '' : ibtn(`data-ext-install="${esc(e.id)}"`)}
    </div>
    <div class="plg-tags">${tags}</div>
    <div class="plg-desc plg-desc-clamp">${desc}</div>
  </div>`;
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
    const r = await post('/api/install/tasks', { kind: 'external-install', family: id });
    if (!r.task?.id) throw new Error('任务没排上');
    await repaintExtensions(); // 立刻重画：卡片这会儿就该变成「安装中」，不等轮询
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
          await repaintExtensions();
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
    } else if (t?.status === 'failed') {
      bits.push(`<div class="plg-warn">上次安装没成：${esc(taskTail(t) || t.output?.slice(-200) || '（没有输出）')}</div>`);
    } else if (t?.status === 'done' && !p?.installed) {
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
              await post('/api/install/tasks', { kind: 'external-open', family: id });
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
            await post('/api/install/tasks', { kind: 'external-serve', family: id });
            dlg.close();
            toast('在起它的面板了 —— 起好后重新点开这个软件，就能直接打开面板。');
            await repaintExtensions();
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
  const desc = (led ? publicCatalog().find((x) => x.id === c.id)?.description : c.description) ?? '';
  let acts = '';
  let ledgerBits = '';
  if (led) {
    /* 装了的：弹窗里只剩卸载。启停已上卡片右上角的开关（2026-11-22 用户：
       "里面的控制按钮可以去掉了"）—— 同一件事不再摆两处，免得一个入口改了另一个人不知道。 */
    acts = `<button class="danger" data-dlg-act="uninstall">卸载</button>`;
    /* **详情只说人话**（2026-11-22 用户："不要展示技术性或者路径这些，用户是不懂技术的普通人"）。
       原来这里铺了五行技术内部件，全撤：
         · 完整启动命令（`E:\...\electron.exe E:\...\bridge.cjs`）
         · `给：codex、claude`（运行时是内部概念）
         · 工具原始名（`baoluo_parse_link`…，英文+下划线，对用户是乱码）
         · 凭据键名（`ELECTRON_RUN_AS_NODE（已写死）`）
         · source.kind（`local`，纯内部字段）
       能力件数保留 —— 那是用户唯一关心的"它能干什么"。 */
    const nTools = (led.tools ?? []).filter(Boolean).length;
    ledgerBits = `
      ${nTools ? `<div class="plg-meta">${esc(toolsBrief(led.tools))}</div>` : ''}
      ${(led.warnings ?? []).map((w) => `<div class="plg-warn">${esc(w)}</div>`).join('')}
      ${led.enabled ? '' : '<div class="plg-warn">已停用 —— 只是暂时没接给数字员工用；打开卡片右上角的开关就恢复。</div>'}`;
  } else {
    acts = `<button class="primary" data-dlg-act="install">安装</button>`;
  }
  body.innerHTML = `
    <div class="plg-d-head">
      <div class="plg-ico">${plgIconFor(c)}</div>
      <div class="plg-d-who">
        <div class="plg-title"><b>${esc(c.label)}</b></div>
        <div class="plg-tags">${led && !led.enabled ? '<span class="set-tag">已停用</span>' : ''}<span class="set-tag">${c.transport === 'stdio' ? '本机' : '云端'}</span></div>
      </div>
    </div>
    ${desc ? `<div class="plg-desc">${esc(desc)}</div>` : ''}
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
          S.connTab = 'installed';
          await repaintExtensions();
          toastConnInstalled(c.id, r);
          return;
        }
        if (act === 'uninstall') {
          await api(`/api/connectors/${encodeURIComponent(c.id)}`, { method: 'DELETE' });
        }
        dlg.close();
        await repaintExtensions();
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
  const panels = S.plugins.filter((p) => p.panel?.slot === 'plugins');   // settings.section 的不进市场（内置设置分节）
  /* 软件 / 界面插件拼在**同一面卡墙**（2026-11-22 用户："标题去掉，也不要区分…都放一起展示"）。
     连接器不再混进来 —— 它的「可添加」在连接器页，清单来源也是另一个接口。 */
  const probed = extSoftware();
  const cards = [
    ...(S.extSoftware?.catalog ?? []).map((e) => swCardHTML(e, probed)),
    ...panels.map(plgPanelCardHTML),
  ];
  if (!cards.length) return `${err}<div class="empty">清单是空的</div>`;
  return `${err}<div class="plg-grid">${cards.join('')}</div>`;
}



/* 「个人（本机来源）」这一页 2026-11-22 删掉：它画的本来就是账本里 source.kind='local' 的连接器，
   跟「已安装」重复；连接器拆成独立分节后，账本卡全在「连接器 › 已安装」里，
   手工添加的入口是那页页头右上的「＋ 添加连接器」。 */




/**
 * 页签切换（2026-11-22 用户："切换 tab 页面会闪"）：
 * 数据已经在内存里（renderPlugins 刚拉过），换页签只是换 #plgBody 的内容 ——
 * 不再走 renderPlugins 的全量重画（那条路先把整页抹成「加载中…」、再发 5 个
 * 请求重建整页，纯闪）。页签按钮在 #plgBody 外面，不用重建，只翻 on 态。
 */
function switchPlgTab(key) {
  S.pluginTab = key;
  const root = $('settingsView');
  root.querySelectorAll('[data-plgtab]').forEach((el) => el.classList.toggle('on', el.dataset.plgtab === key));
  $('plgBody').innerHTML = S.pluginTab === 'catalog' ? plgCatalogHTML() : plgInstalledHTML();
  wirePlugins(); // 新 body 里的卡/按钮重新接线；页签钮是 onclick 覆盖式绑定，不会叠
}

/**
 * 连接器卡的版本号（2026-11-22 用户："显示宝螺的版本号"）：
 * 版本来自 MCP 握手（initialize 的 serverInfo.version），唯一可靠来源是服务端探针
 * （POST /api/connectors/<id>/probe）。探针会真拉起进程，所以：①后台异步，不挡渲染；
 * ②5 分钟内不重复探（服务端另有 60s 缓存兜底）；③探到的版本就地往 .plg-tags 尾部
 * 补一枚小标签，不打扰布局。公开页没有账本卡，不探。
 */
const CONN_VER_TTL = 5 * 60 * 1000;

export async function probeConnVersions() {
  if (S.connTab === 'catalog') return;   // 清单卡没有账本条目，没得探
  const targets = (S.connectors ?? []).filter((c) => {
    if (c.builtin || c.transport !== 'stdio') return false;   // 内置的不上卡墙；http 探不了
    const at = S.connVersionAt?.[c.id];
    return !at || Date.now() - at > CONN_VER_TTL;
  });
  for (const c of targets) {
    S.connVersionAt = S.connVersionAt ?? {};
    S.connVersionAt[c.id] = Date.now();                       // 先记时间戳，防并发重复探
    post(`/api/connectors/${encodeURIComponent(c.id)}/probe`, {})
      .then((r) => {
        const ver = String(r?.serverInfo?.version ?? '').trim();
        if (!r?.ok || !ver) return;
        S.connVersion = S.connVersion ?? {};
        S.connVersion[c.id] = ver;
        const tags = document.querySelector(`[data-plgview="conn:${c.id}"] .plg-tags`);
        if (tags && !tags.querySelector('[data-connver]')) {
          tags.insertAdjacentHTML('beforeend', `<span class="set-tag" data-connver="1">v${esc(ver)}</span>`);
        }
      })
      .catch(() => {
        delete S.connVersionAt[c.id];                         // 失败放开，下次进页再试
      });
  }
}

export function wirePlugins() {
  const root = $('settingsView');
  root.querySelectorAll('[data-plgtab]').forEach((el) => {
    el.onclick = () => switchPlgTab(el.dataset.plgtab);
  });
  // 连接器页的两枚页签（同一份接线函数给两个页面用，选择器各管各的，不会互相误绑）
  root.querySelectorAll('[data-conntab]').forEach((el) => {
    el.onclick = () => switchConnTab(el.dataset.conntab);
  });

  /* 小卡点开详情；卡内控件（安装钮、启停开关）自己有 handler，不冒泡成「看详情」 */
  root.querySelectorAll('[data-plgview]').forEach((el) => {
    el.onclick = (ev) => {
      if (ev.target.closest('button, .switch')) return;
      const [kind, id] = el.dataset.plgview.split(':');
      openPlgDetail(kind, id);
    };
  });

  /* 连接器卡右上角的启停开关（2026-11-22 用户："这里放一个开关控制启用停用"）。
     只改账本那一行；**不平移整页** —— 成功后就地重画卡墙（跟运行时开关同一条"别闪"的经验）。 */
  root.querySelectorAll('[data-conn-toggle]').forEach((el) => {
    el.onchange = async () => {
      const id = el.dataset.connToggle;
      const enabled = el.checked;
      try {
        await api(`/api/connectors/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled }),
        });
        const c = S.connectors.find((x) => x.id === id);
        if (c) c.enabled = enabled;
        paintConnBody();
      } catch (err) {
        el.checked = !enabled; // 没存上就把开关拨回去，别让人以为真停了
        toast(err.message, 'error');
      }
    };
  });

  root.querySelectorAll('[data-install]').forEach((el) => {
    el.onclick = async () => {
      el.disabled = true;
      try {
        const r = await post('/api/connectors', { from: el.dataset.install });
        // 装完回「已安装」——两个页面各记各的页签
        S.pluginTab = 'installed';
        S.connTab = 'installed';
        await repaintExtensions();
        toastConnInstalled(el.dataset.install, r);
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
        next = (await api(`/api/install/tasks/${encodeURIComponent(t.id)}`)).task;
      } catch {
        continue; // 抖一下等下一轮
      }
      if (!next) continue;
      if (next.done) {
        dirty = true; // 做完/失败 —— 交给整页重画（探针也会跟着更新）
        if (next.status === 'done') S.pluginTab = 'installed';
        else toast(`「${family}」没装成：${taskTail(next) || '看服务端日志'}`, 'error');
      } else {
        const line = `${next.running ? '安装中…' : '排队中…'} ${taskTail(next)}`.trim();
        for (const el of document.querySelectorAll(`[data-ext-tail="${CSS.escape(family)}"]`)) el.textContent = line;
      }
    }
    if (dirty) {
      await repaintExtensions();
      renderList();
    } else {
      watchBusySoftware(); // 接着盯
    }
  }, 1500);
}



/* ------------------------------------------------- 连接器：添加 / 修改
 *
 * **2026-11-22 用户拍板：不做界面化的字段翻译。**
 *   「这个是有技术含量的。即便你做成界面化，用户也不会用的。那不如省事一点，不做这个界面化的翻译。」
 * 弹窗里只剩一个 JSON 框，贴一段 `mcpServers`（形状与 Claude Desktop / Cursor / 本仓导出的
 * claude 配置一致，导出即导入）。纯解析在 ./connjson.mjs（不碰 DOM，能被 node 直接跑），
 * 这里只管提交和弹窗。
 */

export let connEditing = null;

/**
 * 提交。一次可能多条 —— 后端只有单条接口（POST / PATCH），这里逐条发，
 * 失败的收起来一次说完：**不做预览，但也不许静默吞掉**。
 * 改的时候 id 以账本那条为准（id 是账本键 + 工具名前缀，框里看得见、但不许顺手改）。
 */
export async function commitConnJson(text, editing) {
  const { list, ignored } = parseConnJson(text);
  const inPlace = !!editing && list.length === 1;
  const ids = [];
  const failed = [];
  for (const [id, body] of list) {
    try {
      if (inPlace) {
        await api(`/api/connectors/${encodeURIComponent(editing.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, id: editing.id }),
        });
        ids.push(editing.id);
      } else {
        await post('/api/connectors', body);
        ids.push(id);
      }
    } catch (err) {
      failed.push(`${id}：${err.message}`);
    }
  }
  return { ids, failed, ignored };
}

export function openConnDialog(entry) {
  connEditing = entry ?? null;
  $('connDlgTitle').textContent = entry ? `改连接器：${entry.id}` : '添加连接器';
  $('connJson').value = connJsonText(entry);
  /* 凭据只把**键名**说出来：值不下发（publicList 的安全口径），所以框里不写 env ——
     不写＝服务端 merge 保留原值。这行是给"我知道有个 token，但不想动它"的人看的。 */
  const keys = [...(entry?.env ?? []), ...(entry?.headers ?? [])].map((x) => x.key);
  $('connKeys').innerHTML = keys.length
    ? `<br>现有凭据键：${keys.map(esc).join('、')}。不动就别写，原值保留；要换才写进 env / headers。`
    : '';
  $('connDlg').showModal();
  setTimeout(() => $('connJson').focus(), 30);
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
 *    这台机器页是单层页面，两个键都回到这里（CLI 详情页 2026-11-16 撤了）。
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
  // 这台机器页（旧的设备详情页 / CLI 详情页已撤，都回到这里）
  devices: () => renderRuntimes(),
  device: () => renderRuntimes(),
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
  return renderDeviceList();
}



/* 「这台机器」页 —— 运行时（识别 / 接入）+ 远程连接 + 数据管理。
   设备详情页与多机协同节都已撤掉，这页不再有设备清单或节点入口。 */

export async function renderDeviceList() {
  // 左栏只写「设置」（在 openSettings 里），这一页的标题「这台机器」在右页头
  $('settingsView').innerHTML = rtLoading('这台机器');

  let list = [];
  try {
    list = (await api('/api/devices')).devices;
  } catch (err) {
    $('settingsView').innerHTML = `${headRow('<b>这台机器</b>')}<div class="empty">${failHtml(err)}</div>`;
    return;
  }
  // 这页不直接读 /api/lan：网络现状归「远程连接」卡（securityadmin.mjs）自己管。
  const localDev = list.find((d) => d.kind === 'local');

  $('settingsView').innerHTML = `
    ${headRow('<b>这台机器</b>')}
    <div class="detail-body">
      <!-- 「运行时」区（2026-11-01 七改，用户："把运行时放到这个页面的数据管理上面"）：
           本机的「已安装」长在这页，看运行时不用再点进本机详情（paintLocalRuntimes）。 -->
      <!-- 「远程连接」卡（2026-11-07 从安全页迁来；2026-11-08 起改**纯运行期开关**：
           开/关 = netmode 的 remoteAccess 闸，立即生效不重启，渲染+接线都在
           securityadmin.mjs 的 mountRemoteAccessCard 里；非 admin 静默不画。
           不 await：自己拉 /api/lan 自己画，别挡着下面两块先出来。 -->
      <div id="remoteMount"></div>
      <div id="rtMount"></div>
      <!-- 「数据管理」区（2026-10-29 从设置独立分节降级成这页的一个区，用户："把数据管理
           作为这台机器的一个区域"）：不跟模式走，数据自己拉（状态 + backups 列表），
           拉完才画，失败各有兜底。 -->
      <div id="dmMount"></div>
    </div>`;

  /* 「远程连接」卡（2026-11-07 从安全页迁来）：页头下面第一块，不 await */
  mountRemoteAccessCard($('remoteMount'));
  /* 「运行时」区（2026-11-01 七改）：本机的「已安装」长在这页 —— 数据管理上面。
     不 await：区块自己拉数据自己画，别挡着数据管理区先出来 */
  if (localDev) paintLocalRuntimes($('rtMount'), localDev.id).catch(() => {});
  /* 数据管理区：进页挂一次（里面的导出/导入按钮和快照列表跟模式无关，重挂反而白拉一遍接口） */
  renderBackupSection($('dmMount'));
}
