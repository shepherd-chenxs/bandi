/* workflows.mjs —— 工作流、流程：发布 / 发起 / 实例页。
 * 2026-10-22 由 app.js（15537 行单文件）拆出，原生 ESM、无打包器；逻辑逐字搬运。 */
import { esc, setRoute, toast } from './shell.mjs';
import { api } from './ui.mjs';
import { setNav } from './state.mjs';
import { askText, confirmDo } from './machine.mjs';
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
export async function openWorkflows(pickId = null, opts = {}) {
  S.flowMode = 'design'; // 编排模板（run 模式是看发起记录）
  // **先把一级栏落定再画左栏**：左栏的渲染有"只属于当前一级栏"的守卫，
  // 从工作台进来时 S.nav 还是 plugins，不先切过来就会画出一片空白（踩过）。
  // keepView：归档视图里删完模板别把自己弹回主清单（消息模块 keepArchiveView 同款）。
  setNav('workflows', { skipOpen: true, keepFlowArchiveView: !!opts.keepView });
  document.body.classList.remove('no-list');
  // 左栏顶上就是"你在哪儿"：工作台 › 工作流（面包屑从右页头挪过来，见 setListTitle）
  // 2026-10-26 用户拍板：这东西统一叫「工作流」—— 磁贴、面包屑、标题一处不落，
  // 原来磁贴叫「流程编排」、页名也叫「流程编排」，跟"工作流"三个字来回换着说，人才会绕晕。
  setListTitle([{ label: '工作台', to: 'workbench' }, { label: '工作流' }]);
  setRoute('workflows', pickId ? { template: pickId } : {});
  $('listAction').classList.remove('hidden');
  $('listAction').title = '新建流程模板';
  // 顶部搜索框放出来（state.mjs 对 workflows 本来就不藏，是这儿又手动藏了一道）。
  // 输入事件走 app.mjs 的全局委托 → renderList → 按一级栏派发回 renderFlowList，只重画列表不动输入框。
  const searchBox = $('search').closest('.list-search');
  searchBox?.classList.remove('hidden');
  if (searchBox) $('search').placeholder = '搜流程';

  let data = { templates: [] };
  try {
    data = await api('/api/workflows');
  } catch { /* 拿不到就当空的，别白屏 */ }
  S.flowTemplates = data.templates ?? [];

  if (pickId) S.designerId = pickId;
  if (!S.flowTemplates.some((t) => t.id === S.designerId)) {
    // 默认选中**当前视图里看得见**的第一条：主视图别默认选中归档行（它不在列表里，选中了像见鬼）
    const pool = S.flowArchivedView ? archivedOf() : activeOf();
    S.designerId = (pool[0] ?? S.flowTemplates[0])?.id ?? null;
  }

  renderFlowList();
  if (S.designerId) await openDesigner(S.designerId);
  else renderFlowEmpty();
}



const activeOf = () => S.flowTemplates.filter((t) => !t.archivedAt);
const archivedOf = () => S.flowTemplates.filter((t) => t.archivedAt);

export function renderFlowList() {
  // 同 renderRunList：左栏属于当前的一级栏，切走了就不许画
  if (S.nav !== 'workflows') return;
  /*
   * 归档走**消息模块同款**（2026-10-29 用户："已归档固定在底部，参照消息模块"）：
   * 滚动列表里不放归档行 —— 底部固定条（#listFoot）上一行紧凑的「📦 已归档 N」，
   * 点开左栏整个换成归档清单、同位置变「← 返回流程」。没有归档就不渲染，一行高度都不占。
   * 为什么放底部固定条而不是清单尾：清单长了要滚才看得到，归档是"收起来的东西"的入口，
   * 得永远看得见（跟消息列表「已归档 N」同一理）。
   */
  const foot = $('listFoot');
  if (foot) foot.innerHTML = ''; // 固定条每次重画先清空：别把「已归档」带到别的页去（同 contacts.renderList）
  // 顶部搜索框（2026-10-29）：吃全站共用的 `S.filter`（app.mjs 输入事件 → renderList → 这儿）。
  // 只重画 listBody/listFoot、不整页 innerHTML —— 输入框不失焦，打一个字出一版。
  const q = String(S.filter ?? '').trim().toLowerCase();
  const hit = (t) => !q || String(t.name || '').toLowerCase().includes(q);
  const archived = S.flowTemplates.filter((t) => t.archivedAt);
  const noneHTML = q
    ? `<div class="empty" style="padding:24px 12px">没有名字带「${esc(S.filter.trim())}」的流程</div>`
    : null;
  const row = (t, dim) => `<div class="item ${t.id === S.designerId ? 'active' : ''}${dim ? ' archived' : ''}" data-tpl="${esc(t.id)}">
            <div class="who">
              <div class="line1"><b>${esc(t.name)}</b>${t.builtIn ? '<span>内置</span>' : ''}</div>
              <div class="line2">${[
                `${(t.nodes ?? []).length} 个节点`,
                t.builtIn ? null : '自建',
                // 跑过几次：数字由服务端 GROUP BY 算出（数列表会少，列表有上限）
                t.runCount ? `跑过 ${t.runCount} 次` : null,
              ]
                .filter(Boolean)
                .join(' · ')}</div>
            </div>
          </div>`;
  const wire = () =>
    $('listBody').querySelectorAll('[data-tpl]').forEach((el) => {
      el.onclick = () => openDesigner(el.dataset.tpl).catch((e) => toast(e.message, 'error'));
    });

  if (S.flowArchivedView) {
    // 归档子视图：左栏就是归档清单（照常右键「取消归档 / 删除」—— 菜单按 archivedAt 分支，自动成立）
    const shown = archived.filter(hit);
    $('listBody').innerHTML = shown.length
      ? shown.map((t) => row(t)).join('')
      : noneHTML ??
        '<div class="empty" style="padding:24px 12px">还没有归档的流程<br /><span class="dim" style="font-size:12px">在主清单里右键「归档」可以收进来</span></div>';
    if (foot) {
      // 「← 返回流程」跟入口在同一个位置（底部固定条）：进出一眼都看得见
      foot.innerHTML = `<div class="arch-entry" id="archBack" title="回到工作流清单">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
             stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 6l-6 6 6 6" /></svg>
        返回流程
      </div>`;
      foot.querySelector('#archBack').onclick = () => {
        S.flowArchivedView = false;
        renderFlowList();
      };
    }
  } else {
    const active = activeOf().filter(hit);
    $('listBody').innerHTML = active.length
      ? active.map((t) => row(t)).join('')
      : noneHTML ??
        (archived.length
          ? '<div class="empty" style="padding:24px 12px">现役流程都归档了<br /><span class="dim" style="font-size:12px">点底下的「已归档」翻看</span></div>'
          : '<div class="empty" style="padding:24px 12px">还没有流程模板<br />点右上角「＋」新建一个</div>');
    if (foot && archived.length) {
      foot.innerHTML = `<div class="arch-entry" id="archEntry" title="归档收起来的流程，点开能翻看、右键可取消归档">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
             stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3.5 7.5h17v11.2a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8z" />
          <path d="M2.6 4.2h18.8v3.3H2.6z" />
          <path d="M9.4 12h5.2" />
        </svg>
        已归档<span class="arch-n">${archived.length}</span>
      </div>`;
      foot.querySelector('#archEntry').onclick = () => {
        S.flowArchivedView = true;
        renderFlowList();
      };
    }
  }
  wire();
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

/**
 * 归档 / 取消归档（右键菜单，2026-10-29）。归档 = 从主清单收进底下的「已归档」段，
 * **历史实例一条不动**（发起记录、设计器的历史记录都还看得到）；
 * 归档会顺带下架（工作台不能再起它），取消归档回成草稿、要发布重新点。
 */
export async function archiveFlowTemplate(t, on) {
  try {
    await api(`/api/workflows/templates/${encodeURIComponent(t.id)}/archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on }),
    });
    toast(on ? '已归档 —— 它的历史实例都还在' : '已取消归档，要再跑先发布');
    // 取消归档 → 回主清单（消息模块同款：在归档视图里捞出来的东西回它原来的地方）
    if (!on) S.flowArchivedView = false;
    await openWorkflows(on ? null : t.id);
  } catch (e) {
    toast(e.message, 'error');
  }
}

/**
 * 删除模板：**实例跟着一起删**（用户 2026-10-29 定的口径，跟归档正好相反）。
 * 内置模板服务端会拦（删了启动还会被补回来），菜单里直接禁用并说明。
 */
export async function deleteFlowTemplate(t) {
  const n = t.runCount ? `它跑过的 ${t.runCount} 条实例会一起删掉` : '它还没跑过实例';
  if (!(await confirmDo(`删除流程「${t.name}」？${n}，删了就找不回来了。`))) return;
  try {
    await api(`/api/workflows/templates/${encodeURIComponent(t.id)}`, { method: 'DELETE' });
    toast('已删除');
    await openWorkflows(null, { keepView: true }); // 在归档视图里删的，留在归档视图
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
