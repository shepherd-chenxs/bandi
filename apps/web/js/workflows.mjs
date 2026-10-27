/* workflows.mjs —— 工作流、流程：发布 / 发起 / 实例页。
 * 2026-10-22 由 app.js（15537 行单文件）拆出，原生 ESM、无打包器；逻辑逐字搬运。 */
import { esc, setRoute, toast } from './shell.mjs';
import { api } from './ui.mjs';
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
  // 左栏顶上就是"你在哪儿"：工作台 › 工作流（面包屑从右页头挪过来，见 setListTitle）
  // 2026-10-26 用户拍板：这东西统一叫「工作流」—— 磁贴、面包屑、标题一处不落，
  // 原来磁贴叫「流程编排」、页名也叫「流程编排」，跟"工作流"三个字来回换着说，人才会绕晕。
  setListTitle([{ label: '工作台', to: 'workbench' }, { label: '工作流' }]);
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
  // 没有页头：左栏顶上已经是「工作台 › 工作流」，右页头再写一遍就是同一件事写两处
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

/* 工作台磁贴的卡片结构（2026-10-20 重设计）：图标 + 名字 + **一句说明**。
   说明直接把原来 title 里的那句话亮出来 —— 磁贴光秃秃一个名字，用户得悬停才知道去哪儿；
   一句话摆在卡上，入口页才有"总览"的样子。统一走 wbCard() 拼，三段不各写一遍。 */
export const wbCard = (cls, icon, name, desc, attr, icoStyle = '') => `
  <button class="wb-tile" ${attr} title="${esc(desc)}">
    <span class="wb-ico ${cls}" ${icoStyle}>${icon}</span>
    <span class="wb-tx"><span class="wb-name">${esc(name)}</span><span class="wb-desc">${esc(desc)}</span></span>
  </button>`;



/**
 * 工作台磁贴的入口**已经不在这个文件**（2026-10-26 用户拍板）：
 * 「流程编排」改名「工作流」并进「自动化」那一组，磁贴由 `projects.mjs` 的
 * `workbenchAutoSection()` 一起画 —— 它本来就该跟定时任务做邻居（都是"让活自己动起来"）。
 * 原来这里有个 `workbenchFlowSection()` 单列一段，删掉时连 `<div class="wb-sec">工作流</div>`
 * 一起没了，工作台少一段标题。
 */
