/* workflows.mjs —— 工作流、流程：发布 / 发起 / 实例页。
 * 2026-10-22 由 app.js（15537 行单文件）拆出，原生 ESM、无打包器；逻辑逐字搬运。 */
import { esc, setRoute, toast } from './shell.mjs';
import { ICON_WB_FLOW, api } from './ui.mjs';
import { setNav } from './state.mjs';
import { askText } from './machine.mjs';
import { showView } from './contacts.mjs';
import { openDesigner, setListTitle } from './flowpages.mjs';
import { $, S } from './core.mjs';



/* -------------------------------------------------------------- 工作流 */

/**
 * 工作流模块 = **编排模板**。
 *
 * 左栏列模板，点一个直接进设计器。
 * 跑起来的实例**不在这儿** —— "模板怎么编"和"这一单走到哪了"是两件事，
 * 混在一起左栏就成了流水账（试过，不对）。
 */
export async function openWorkflows(pickId = null) {
  S.flowMode = 'design'; // 编排模板（run 模式是看发起记录）
  // **先把一级栏落定再画左栏**：左栏的渲染有"只属于当前一级栏"的守卫，
  // 从工作台进来时 S.nav 还是 plugins，不先切过来就会画出一片空白（踩过）。
  setNav('workflows', { skipOpen: true });
  document.body.classList.remove('no-list');
  // 左栏顶上就是"你在哪儿"：工作台 › 流程编排（面包屑从右页头挪过来，见 setListTitle）
  // 二级叫「流程编排」而不是「工作流」：这一页是编排模板的地方，跟工作台那颗
  // 「流程编排」磁贴同名（2026-10-19 用户截图指出）。
  setListTitle([{ label: '工作台', to: 'workbench' }, { label: '流程编排' }]);
  setRoute('workflows', pickId ? { template: pickId } : {});
  $('listAction').classList.remove('hidden');
  $('listAction').title = '新建流程模板';
  $('search').closest('.list-search')?.classList.add('hidden');

  let data = { templates: [] };
  try {
    data = await api('/api/workflows');
  } catch { /* 拿不到就当空的，别白屏 */ }
  S.flowTemplates = data.templates ?? [];

  if (pickId) S.designerId = pickId;
  if (!S.flowTemplates.some((t) => t.id === S.designerId)) S.designerId = S.flowTemplates[0]?.id ?? null;

  renderFlowList();
  if (S.designerId) await openDesigner(S.designerId);
  else renderFlowEmpty();
}



export function renderFlowList() {
  // 同 renderRunList：左栏属于当前的一级栏，切走了就不许画
  if (S.nav !== 'workflows') return;
  $('listBody').innerHTML = S.flowTemplates.length
    ? S.flowTemplates
        .map(
          (t) => `<div class="item ${t.id === S.designerId ? 'active' : ''}" data-tpl="${esc(t.id)}">
            <div class="who">
              <div class="line1"><b>${esc(t.name)}</b>${t.builtIn ? '<span>内置</span>' : ''}</div>
              <div class="line2">${(t.nodes ?? []).length} 个节点${t.builtIn ? '' : ' · 自建'}</div>
            </div>
          </div>`,
        )
        .join('')
    : '<div class="empty" style="padding:24px 12px">还没有流程模板<br />点右上角「＋」新建一个</div>';

  $('listBody').querySelectorAll('[data-tpl]').forEach((el) => {
    el.onclick = () => openDesigner(el.dataset.tpl).catch((e) => toast(e.message, 'error'));
  });
}



export function renderFlowEmpty() {
  // 没有页头：左栏顶上已经是「工作台 › 流程编排」，右页头再写一遍就是同一件事写两处
  $('flowView').innerHTML = `
    <div class="detail-body"><div class="wip">还没有流程模板 —— 点左栏右上角的「＋」新建一个</div></div>`;
  S.view = 'flow';
  showView('flow');
}



/** 新建模板：先给一个起点节点，进去再改 */
export async function newTemplateDialog() {
  const name = await askText({ title: '新流程叫什么名字？', placeholder: '例如：发文流程' });
  if (name === null) return;
  try {
    const t = await api('/api/workflows/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name.trim() || '未命名流程',
        nodes: [{ id: 'n1', name: '第一步', detail: '', approve: 'end', reject: '' }],
      }),
    });
    await openWorkflows(t.id);
  } catch (e) {
    toast(e.message, 'error');
  }
}



/* ---------------------------------------------- 流程：发布 / 发起 / 实例页 */

/**
 * 工作台里的「流程」分组：**只有发布过的才在这儿**。
 * 点进去是**这个流程的发起记录页**，发起是那个页面上的动作（不在工作台直接发起）。
 */
/* 工作台磁贴的卡片结构（2026-10-20 重设计）：图标 + 名字 + **一句说明**。
   说明直接把原来 title 里的那句话亮出来 —— 磁贴光秃秃一个名字，用户得悬停才知道去哪儿；
   一句话摆在卡上，入口页才有"总览"的样子。统一走 wbCard() 拼，三段不各写一遍。 */
export const wbCard = (cls, icon, name, desc, attr, icoStyle = '') => `
  <button class="wb-tile" ${attr} title="${esc(desc)}">
    <span class="wb-ico ${cls}" ${icoStyle}>${icon}</span>
    <span class="wb-tx"><span class="wb-name">${esc(name)}</span><span class="wb-desc">${esc(desc)}</span></span>
  </button>`;



export function workbenchFlowSection() {
  const list = S.flowPublished ?? [];
  /* ⚠️ 工作台的三段（项目 / 自动化 / 流程）**不再用 `<section class="fx">`**（2026-10-19）：
     `.fx + .fx` 自带一条横分隔线，几段竖着一叠就是几条横带、每带右侧一场空。
     统一用 `.wb-sec`（一行小标题）+ `.wb-grid`，跟插件那几段接在同一条流里。 */
  return `
    <div class="wb-sec">流程</div>
    <div class="wb-grid">
      <!-- 编排入口：原来在左边 rail 的「工作流」那一项，现在收进工作台 -->
      ${wbCard('flow', ICON_WB_FLOW, '流程编排', '画流程：节点、指派、发布', 'data-flow-design')}
      ${list
        .map(
          (f) => wbCard('flow', ICON_WB_FLOW, f.name, '点开看这个流程的发起记录', `data-flow-start="${esc(f.id)}"`),
        )
        .join('')}
    </div>`;
}
