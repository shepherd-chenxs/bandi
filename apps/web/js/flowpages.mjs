/* flowpages.mjs —— 起流程、流程实例页（流转记录）、节点栏（页面里的第二栏）、流程设计器（纵向）、设计器草稿（防意外关闭）。
 * 2026-10-22 由 app.js（15537 行单文件）拆出，原生 ESM、无打包器；逻辑逐字搬运。 */
import { esc, personLabel, savePlace, setRoute, toast } from './shell.mjs';
import { api, createCombo, renderMarkdown } from './ui.mjs';
import { load, setNav } from './state.mjs';
import { headRow } from './connectors.mjs';
import { confirmDo } from './machine.mjs';
import { ICON_FILE, ICON_LINK, showView } from './contacts.mjs';
import { openWorkflows, renderFlowList } from './workflows.mjs';
import { openTaskCardDialog } from './projects.mjs';
import { convPermCombo, streamRun } from './chat.mjs';
import { $, S } from './core.mjs';



/* ---------------------------------------------------------------- 起流程 */

/** 点工作台里的流程 → 填写想法 → 发起 */
export const flowStart = { titleTouched: false };

 // 原 let fsTitleTouched（流程名称是否被用户动过，跨模块写，2026-10-22 拆分时对象化） // 用户自己动过流程名称没有（动过就不再跟着想法预填） // 用户自己动过流程名称没有（动过就不再跟着想法预填）

export function openFlowStart(flowId) {
  const flow = (S.flowPublished ?? []).find((f) => f.id === flowId);
  if (!flow) return toast('这条流程不在工作台上（可能被下架了）');
  S.flowStarting = flow.id;
  flowStart.titleTouched = false;
  $('fsTitle').value = '';
  $('fsIntent').value = '';
  // 项目：默认用上次选的；没有就选内置那个「默认项目」
  const projects = S.projects ?? [];
  const last = projects.some((p) => p.id === S.flowProjectId) ? S.flowProjectId : null;
  if (!last) S.flowProjectId = (projects.find((p) => p.builtIn) ?? projects[0])?.id ?? '';
  // ⚠️ **下拉必须在 showModal 之前插好**：先 show 再插的话，弹窗会先以"少一行"
  // 的样子出现，下一帧长高一下 —— 看着就是"弹窗闪了一下"（用户报的）。
  mountFlowProjectPicker();
  $('flowStartDlg').showModal();
  setTimeout(() => $('fsIntent').focus(), 50);
}



/** 发起对话框里的「项目」下拉：这一步（以及整条流程）在哪个目录里干活。
 *  ⚠️ 它跟工作台那个「项目」是**同一个实体**（projects 表）—— 以前这里叫"工作区"，
 *     于是同一个东西两处两个名字，用户在上面看到"工作区"、去工作台却只能"新建项目"。 */
export function mountFlowProjectPicker() {
  const mount = $('fsProjectMount');
  if (!mount) return;
  const projects = S.projects ?? [];
  mount.innerHTML = '';
  if (!projects.length) {
    mount.innerHTML = '<span class="dim" style="font-size:12.5px">还没有项目，去工作台建一个</span>';
    return;
  }
  if (!projects.some((p) => p.id === S.flowProjectId)) S.flowProjectId = projects[0].id;
  createCombo({
    mount,
    items: projects.map((p) => ({ id: p.id, label: p.name })),
    value: S.flowProjectId,
    search: false,
    onChange: (id) => {
      S.flowProjectId = id;
      const p = projects.find((x) => x.id === id);
      const hint = $('fsProjectPath');
      if (hint && p) hint.textContent = p.root;
    },
  });
  const p = projects.find((x) => x.id === S.flowProjectId);
  const hint = $('fsProjectPath');
  if (hint && p) hint.textContent = p.root;
}



/**
 * 名字跟着想法走：用户没自己动过名字，就拿想法的第一行预填。
 * 预填而不是留空 —— 大多数时候第一行就是最合适的名字，但**用户可以改**。
 */
export function syncFlowTitle() {
  if (flowStart.titleTouched) return;
  const first = ($('fsIntent').value || '').trim().split('\n')[0].trim();
  $('fsTitle').value = first.slice(0, 40);
}



export async function doStartFlow() {
  const flowId = S.flowStarting;
  if (!flowId) return;
  const intent = ($('fsIntent').value || '').trim();
  if (!intent) return toast('先说说要干什么');
  // 名字没填就退回"想法第一行"（服务端也会兜一层）
  const title = ($('fsTitle').value || '').trim();
  // 项目：AI 就在这个目录里干活（整条流程共用）
  const projectId = S.flowProjectId || null;
  try {
    // 没有"在哪儿跑"：流程不建群，派给谁就发到谁那儿
    const r = await api('/api/workflows/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId: flowId, title, intent, projectId }),
    });
    $('flowStartDlg').close();
    S.flowStarting = null;
    await load(); // 会话列表可能要跟上
    // **发起后直接落到实例页**：左边发起记录，右边流转节点记录。
    // skipOpen 是为了别让 setNav 又去开"模板编排"页 —— 两边抢渲染谁后回来谁赢
    setNav('workflows', { skipOpen: true });
    await openFlowRun(flowId, r.id);
  } catch (e) {
    toast(e.message, 'error');
  }
}



/**
 * 左栏顶上的标题：`setListTitle('工作台')` 写名字，
 * `setListTitle([{label:'工作台',to:'workbench'}, {label:'流程编排'}])` 写面包屑。
 *
 * 为什么做成两个入口而不是让调用处拼 HTML（2026-10-19 用户截图：「改成面包屑」）：
 *   · 左栏 `#listTitle` 原来是个 `<b>`，十几处直接写 `textContent`；
 *   · 面包屑是"你在哪儿"，它该长在**左栏列表顶上**（2026-10-19 用户第二次截图：
 *     「面包屑应该是在左边的列表上，右边的不用」）—— 于是右页头那条面包屑全撤了，
 *     统一挪到这儿；页头只留当前这一项的名字 / 操作。
 *
 * 数组的每一段可以是字符串（= 当前这一层，不可点）或 `{label, to, arg?}`：
 *   · 最后一段**永远不可点**（当前位置）；中间段必须给 `to`（`CRUMB_GO` 的键）；
 *   · 点击走全站那一个 document 事件委托（`data-crumb-to`），页面里不写 onclick ——
 *     左栏标题会随页面重画，逐个绑必漏。`to` 用 key 而不是函数，跟页头面包屑同一套。
 *
 * 传数组时全部用 `textContent` 写（流程名/项目名/员工名都来自用户输入，不能进 innerHTML）。
 */
export function setListTitle(t) {
  const el = $('listTitle');
  if (!el) return;
  if (!Array.isArray(t)) {
    el.innerHTML = `<b title="${esc(t)}">${esc(t)}</b>`;
    return;
  }
  el.innerHTML = '';
  t.forEach((part, i) => {
    const it = typeof part === 'string' ? { label: part } : part;
    if (i) {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = '›';
      el.append(sep);
    }
    if (i === t.length - 1) {
      const b = document.createElement('b');
      b.textContent = it.label;
      b.title = it.label; // 名字长时会被省略号截掉，悬停能看全
      el.append(b);
      return;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'crumb-btn';
    btn.textContent = it.label;
    btn.title = `回${it.label}`;
    if (it.to) {
      btn.dataset.crumbTo = it.to;
      if (it.arg != null) btn.dataset.crumbArg = String(it.arg);
    }
    el.append(btn);
  });
}



/* -------------------------------------------------- 流程实例页（流转记录） */

/**
 * 一条流程的实例页：**左边是发起记录，右边是流转节点记录**。
 * 要一眼看出三件事：走到哪个节点了、谁在干活、卡在哪了。
 */
export async function openFlowRun(templateId, pickRunId) {
  S.flowMode = 'run';
  S.flowTemplate = templateId ?? null;
  if (pickRunId) S.flowRunId = pickRunId;
  // **先把一级栏和"当前位置"落定** —— 从任务卡（看板的流程行）点进来的，不设的话 S.nav 还是
  // "工作台"/"看板"那条路，一刷新就回不去（踩过）
  setNav('workflows', { skipOpen: true });
  document.body.classList.remove('no-list');
  // 左栏这一栏是「发起记录」：面包屑只到**二级**——工作台 › 流程名。
  // 中间不能插「流程编排」（2026-10-19 用户截图：「这个只是个二级标题，没有流程编排」）：
  // 发起记录不是编排页的子页，两者的上一级都只是工作台。
  // 2026-10-26 起工作台上的已发布流程磁贴去掉了，这页主要从任务卡（流程执行的卡）点进来。
  setListTitle([{ label: '工作台', to: 'workbench' }, { label: '发起记录' }]);
  setRoute('flowRun', { template: templateId ?? null, run: pickRunId ?? S.flowRunId ?? null });
  // 左栏顶上的「＋」在这儿是**发起一条**（不是新建模板）
  $('listAction').classList.remove('hidden');
  $('listAction').title = '发起一条';
  $('search').closest('.list-search')?.classList.add('hidden');

  let data = { runs: [], templates: [] };
  try {
    data = await api('/api/workflows');
  } catch { /* 拿不到就当空的 */ }
  S.flowTemplates = data.templates ?? [];
  const tpl = (data.templates ?? []).find((t) => t.id === templateId) ?? null;
  if (tpl) setListTitle([{ label: '工作台', to: 'workbench' }, { label: tpl.name }]);

  S.flowRuns = (data.runs ?? []).filter((r) => !templateId || r.templateId === templateId);
  if (pickRunId) S.flowRunId = pickRunId;
  if (!S.flowRuns.some((r) => r.id === S.flowRunId)) S.flowRunId = S.flowRuns[0]?.id ?? null;

  renderRunList();
  if (S.flowRunId) await paintRun(S.flowRunId);
  else renderRunEmpty();
}



export function runBadge(r) {
  // **先看流程本身结束了没有**：已终止/已完成的任务可能停在「待验收」，
  // 那不代表在等你 —— 之前顺序反了，终止的流程还写着"等你验收"（误导过）
  //
  // 颜色：完成=绿、阻塞=红、终止=灰（灰就是列表里状态字的默认色，见 .item .line1 span；
  // 这里明写一个 gray 只是让读代码的人知道"这个不是漏了"，CSS 里不必再写一条同色规则）。
  if (r.status === '已终止') return { text: '已终止', cls: 'gray' };
  if (r.status === '已完成') return { text: '已完成', cls: 'ok' };
  // 叫「已阻塞」而不是「卡住」：服务端给的 stuck 理由本来就写着「部署」已阻塞，等人处理，
  // 同一个状态在列表上却叫另一个名字。措辞跟服务端对齐。
  if (r.stuck) return { text: '已阻塞', cls: 'bad' };
  if (r.taskStatus === '待验收') return { text: '等你验收', cls: '' };
  return { text: r.taskStatus ?? r.status, cls: '' };
}



export function renderRunList() {
  // **左栏属于当前的一级栏**：人已经切走了就别再画。
  // 流程页有自己的 5 秒轮询（看谁在办、卡没卡），切到通讯录之后它还会醒一次，
  // 于是左栏在「通讯录」和「发起记录」之间来回跳（用户实报）。
  // 与其逐个堵调用方，不如在这儿立规矩：不是工作流页就不许动左栏。
  if (S.nav !== 'workflows') return;
  const runs = S.flowRuns ?? [];
  $('listBody').innerHTML = runs.length
    ? runs
        .map((r) => {
          const b = runBadge(r);
          const sub = [r.nodeName, r.assigneeName, r.stuck].filter(Boolean).join(' · ');
          return `<div class="item ${r.id === S.flowRunId ? 'active' : ''}" data-run="${esc(r.id)}">
            <div class="who">
              <div class="line1"><b>${esc(r.title)}</b><span class="flow-t ${b.cls}">${esc(b.text)}</span></div>
              <div class="line2">${esc(sub || '还没开始')}</div>
            </div>
          </div>`;
        })
        .join('')
    : '<div class="empty" style="padding:24px 12px">还没有发起过<br />去工作台点这个流程</div>';
  $('listBody').querySelectorAll('[data-run]').forEach((el) => {
    el.onclick = () => paintRun(el.dataset.run).catch((e) => toast(e.message, 'error'));
  });
}



export function renderRunEmpty() {
  // 还没发起过：说清楚下一步点哪儿，别给个死页。
  // 没有页头：左栏顶上已经是「工作台 › 模板名」，右页头再写一遍就是重复。
  $('flowView').innerHTML = `
    <div class="detail-body run-wrap">
      <div class="wip">这个流程还没有发起过
        <div style="margin-top:14px"><button class="primary" data-run-new>发起一条</button></div>
      </div>
    </div>`;
  S.view = 'flow';
  showView('flow');
  $('flowView').querySelector('[data-run-new]')?.addEventListener('click', () => openFlowStart(S.flowTemplate));
}



export async function paintRun(id) {
  // **重画整页会连对话栏一起冲掉**：runHTML 里那栏是 is-hidden 的，
  // 于是"发一条消息"或"5 秒轮询"都会把它变成收起状态（回车后自动关闭，踩过）。
  // 所以先把开合状态和草稿记下来，画完再还原。
  const draft = $('ncInput')?.value ?? '';
  const chatOpen = !!ncCtx && !$('ncCol')?.classList.contains('is-hidden');

  // 顶栏那句「今天已用 X」已经去掉了（2026-10-17 用户要求），额度数据不用再跟着流程一起拉。
  const v = await api('/api/workflows/runs/' + encodeURIComponent(id));
  S.flowRunId = id;
  S.flowRun = v;
  S.flowTemplate = v.templateId ?? S.flowTemplate;
  // 左栏面包屑第二段是**模板名**（这一栏就是模板下的发起记录）；换 run 时也刷一遍，
  // 万一这条 run 属于别的模板（理论上不会，但数据是老的时候可能），标题别停在上一份。
  // 只到二级：工作台 › 模板名（中间没有「流程编排」，见 openFlowRun 的注释）。
  const tplNow = (S.flowTemplates ?? []).find((t) => t.id === S.flowTemplate);
  setListTitle([{ label: '工作台', to: 'workbench' }, { label: tplNow?.name ?? '发起记录' }]);
  /*
   * **左栏那一行也要跟着换成这份新的。**
   *
   * `S.flowRuns` 是**进这一页时**拉的快照，而 `renderRunList` 画的就是它。
   * 详情这份 `v` 是刚拉回来的、新的 —— 只重画列表而不把快照里那一行换掉，
   * 列表就会一直显示旧状态。用户实报："列表里记录的状态和详情里顶部的状态不一致"
   *（列表「已阻塞」、详情「已终止」，服务端数据是「已终止」）。
   *
   * 换掉对应那一行就够：一份数据、两处显示，不该各拉各的。
   * （注意只能换这一行 —— 别人的状态这次没拉，不能顺手刷成同一个值。）
   */
  const at = (S.flowRuns ?? []).findIndex((r) => r.id === v.id);
  if (at >= 0) S.flowRuns[at] = v;
  else S.flowRuns = [v, ...(S.flowRuns ?? [])];
  renderRunList();
  $('flowView').innerHTML = runHTML(v);
  S.view = 'flow';
  showView('flow');
  wireRun(v);
  if (chatOpen) {
    $('ncCol')?.classList.remove('is-hidden');
    const inp = $('ncInput');
    if (inp && draft) inp.value = draft;
    await refreshNodeChat();
  }
  savePlace(); // 记下"在看哪条流程"，刷新回到这儿
  watchRunStep(id, v);
}



/**
 * 盯住**当前这一步在跑的那次运行**，跑完再重画一次。
 *
 * 取代了原来的 5 秒轮询。为什么要换：
 *   · 轮询是"缺推送"的替代品 —— 而推送机制（streamRun）早就有了，流程页只是没用
 *   · 每 5 秒整块 `innerHTML` 重建，会透过遮罩看见 → 弹窗"有频率地闪"（用户报的）
 *   · 顺带把"他正在办 → 办完了"从"最多晚 5 秒"变成**实时**
 *
 * 没有在跑的（等审批、卡住、终态）就什么都不订 —— 那种情况本来就不会自己变。
 */
export function watchRunStep(id, v) {
  const cur = (v.tasks ?? [])[v.tasks?.length - 1];
  const runningId = cur?.runningRunId ?? null;
  if (!runningId) {
    // 这一步没在跑 → 收掉连接，别白占着
    if (runStream && runStream.forRun === id) {
      runStream.close();
      runStream = null;
    }
    return;
  }
  if (runStream && runStream.forRun === id && runStream.agentRunId === runningId) return; // 已经订着这条
  runStream?.close();
  runStream = { forRun: id, agentRunId: runningId, close: null };
  const handle = streamRun(runningId, {
    onDone: () => {
      runStream = null;
      // 落库比 __done 稍晚一点：等一小会儿再取，免得拿到半截（跟消息模块一个处理）
      setTimeout(() => {
        if (S.view === 'flow' && S.flowMode === 'run' && S.flowRunId === id) {
          paintRun(id).catch(() => {});
        }
      }, 300);
    },
    // 断线让 EventSource 自己重连；重连后服务端会把这次运行的事件重放一遍（含 __done）
    onReconnect: () => {},
  });
  runStream.close = handle.close;
}


export let runStream = null;



/** 收掉实例页那条实时流（离开工作流页时调） */
export function closeRunStream() {
  runStream?.close?.();
  runStream = null;
}



export function durText(ms) {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} 分 ${s % 60} 秒` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}



/**
 * 这一步**该怎么标**：状态 + 要不要再单独说结局。
 *
 * 为什么要这个函数：`decision` 和 `status` 会互相重复 ——
 * 一条办完的步骤是 `已完成 + 通过`，而「通过」就是「已完成」的默认出路，
 * 两个标签并排等于同一句话说两遍（用户指出"重复了"）。
 *
 * 规则：**默认结局不再重复，例外的才露出来**。
 *   · 已完成 + 通过          → 只留「已完成」
 *   · 已完成 + 驳回 / 终止    → 留（办完了，但结局不是正常那个 —— 不矛盾，能并排）
 *   · **没办完 + 终止**       → **合成一句话**，不并排
 *
 * ⚠️ 最后那条是用户实报改的。终止流程时，那一步如果还没开跑，数据就是
 * `status=待办, decision=终止`（见 workflows.decide：终止不受任务状态限制，
 * 原来是"进行中"才降级成已完成，其余原样保留）。界面上并排出现「待办」「终止」，
 * 读起来像**两个互相打架的状态**（用户问："为什么有两个状态"）。
 * 可它其实是同一件事：**这一步还没办完，流程就被终止了**。
 * 所以合成一句 `「待办」时被终止` —— 措辞统一，不维护一张 status→说法 的映射表。
 */
export function stepOutcome(t) {
  const decision = t.decision ?? null;
  if (decision === '终止' && t.status !== '已完成') {
    return { status: `${t.status}时被终止`, decision: null, terminal: true };
  }
  const implied = t.status === '已完成' && decision === '通过';
  return { status: t.status, decision: implied ? null : decision, terminal: false };
}



/**
 * 执行结果里的一颗**产物**：改动的文件 或 一条链接。
 *
 * 文件点一下复制路径 —— 平台没有"打开这个文件"的通道（产物可能在经办人的机器上），
 * 复制是最小可用的动作；链接点一下直接开。
 * 文案里只放文件名/标题，完整路径进悬停 —— 一屏要能扫完，而不是读一串目录。
 */
export function artChipHtml(a) {
  const isLink = a.kind === 'link';
  const label = a.label || a.target;
  return `<button class="run-art ${isLink ? 'link' : 'file'}" type="button"
    ${isLink ? `data-art-open="${esc(a.target)}"` : `data-art-copy="${esc(a.target)}"`}
    title="${esc(isLink ? a.target : `${a.target}（点击复制路径）`)}">
    ${isLink ? ICON_LINK : ICON_FILE}<span>${esc(label)}</span></button>`;
}



export function runHTML(v) {
  const b = runBadge(v);
  const curNode = (v.nodes ?? []).find((n) => n.id === v.currentNodeId) ?? null;
  // **没执行人 = 停在这儿**，这是要一眼看出来的阻塞
  const blocked = v.status === '进行中' && curNode && !curNode.assigneeName;

  const acts = [];
  if (v.status === '进行中') {
    // （顶部只放"对整条流程"的操作 —— 步骤级的动作都在下面时间轴那一步的行里，
    //   混在一起会点错。用户要求去掉顶部这个。）
    //
    // 措辞带上"流程"：步骤行上也有个结局标签写着「终止」（那是**这一步的结局**，不是按钮）。
    // 两颗东西同名同形，用户实报看混过 —— 所以这颗必须说清它管的是**整条流程**。
    acts.push('<button class="danger" data-run-decide="终止">终止流程</button>');
  }
  // 删除放在最后，任何状态都能删（流程自己的记录而已，不碰别人的会话）
  acts.push('<button class="danger" data-run-del title="删掉这条流程记录（不动各经办人的对话）">删除</button>');

  /*
   * 当前这一步的动作**按频率分两处**。以前是整排摆在流程底部那条 `.run-now` 里，
   * 那条的问题不是审美：时间轴最后一行**本来就是"当前这一步"**，底部再摆一遍
   * 等于同一个东西两个家；而且按钮离它作用的那个节点很远。
   *
   *   · 快乐路径（派活 / 通过 / 驳回）→ 直接长在**当前那一步的行内**，还是 1 次点击
   *   · 收拾类（改指派 / 改状态）→ **也长在"当前这一步"那一行里**：
   *     点「状态」那颗字弹状态、点「经办人」弹人选人。
   *     以前这些在右侧栏的「任务卡」标签里，任务卡**已经撤掉** —— 为了改个状态要先开个面板，
   *     而这块信息本来就属于那一步。历史步骤那几行是纯文本（服务端只认当前任务）。
   */
  const inlineActs = [];
  if (v.status === '进行中' && !blocked) {
    // 「派活，开始这一步」这颗按钮去掉了（2026-10-17 对齐 Multica：待办即执行）——
    // 停在待办的步骤会被调度节拍自动派出（他正忙就 30 秒后再试），人没什么可点的。
    // 留一行说明代替按钮：不解释的话，"这步怎么不动"又得靠猜。
    if (v.taskStatus === '待办') inlineActs.push('<span class="dim">待办 —— 马上自动派活，不用点任何东西（他正忙就 30 秒内再试）</span>');
    if (v.taskStatus === '待验收') {
      if (v.outlets?.approve) {
        inlineActs.push(`<button class="primary" data-run-decide="通过">确认这一步完成 → ${esc(v.outlets.approveTo ?? '')}</button>`);
      }
      if (v.outlets?.reject) inlineActs.push(`<button data-run-decide="驳回">驳回 → ${esc(v.outlets.rejectTo ?? '')}</button>`);
    }
    // 「重跑这一步」已删（2026-10-18 用户要求）：把状态改成「待办」就是重跑
    //（setStepStatus 的语义：待办 = 直接派活），同一件事不留两个入口。
    //
    // **额度拦下的只给「继续一次」**：它走的不是"改回待办"（那会又撞一次额度闸、
    // 又写一遍同样的备注），而是带 force 直接派 —— 这颗没别的路能替代，留着。
    if (v.quotaBlocked) {
      inlineActs.push(
        '<button class="primary" data-run-force title="明确知道这一步会超出今天的额度，就放它过去">继续一次</button>',
      );
    }
  }

  const lastTaskId = (v.tasks ?? [])[v.tasks.length - 1]?.id;
  // 哪些节点勾了「需要人工确认完成」——实例页也要在节点上标出来（用户要求），
  // 不然"这一步干完会不会停下来等人"只能靠记。设计器的节点卡上是同一个标签。
  const manualNodes = new Set((v.nodes ?? []).filter((n) => n.manual).map((n) => n.id));
  /*
   * 提示按"它说的东西属于谁"分三层，不都堆在页面顶上：
   *   ① 状态（进行中/已完成/已终止）        → 顶栏那颗胶囊（已有）
   *   ② 现在怎么样（正在跑/等你确认/已阻塞…）→ **那一步的执行结果里第一行**（见下面 state）
   *   ③ 结束了怎么办                       → **时间轴末尾**（见 endedHint）
   *
   * 这么分的原因：② 原来也挂在页面顶部，而这些文案**自带节点名**
   *（「部署」已阻塞，等人处理）—— 它正下方那一行就写着「部署」，
   * 同一个名字上下挨着说两遍。层级放错了，不是位置偏了几像素。
   *
   * ⚠️ 原来还留了一条顶部横幅：「这一步停住了：流程里找不到当前节点」（数据异常）。
   *    用户要求**也收进执行结果**，所以就挂在时间轴最后那一步上 ——
   *    没有当前节点时，最后那一步就是"当前这一步"。
   */
  /*
   * 数据异常：流程在跑、却**找不到当前节点** —— 典型是模板改过（这一步被删了／重排了），
   * 实例的 currentNodeId 就悬空了。
   *
   * 这条必须排在"等你指派"前面：**指派也没用**，那一步在模板里连出口都没有，
   * 派了人也点不到「通过」。原来它被 v.waiting 盖住，页面只说"没人办，等你指派"，
   * 人就会一直卡在那儿点（用户 2026-10-14 那条「部署」就是这么停住的）。
   */
  const curNodeName = v.tasks?.find((t) => t.id === lastTaskId)?.nodeName ?? '当前这一步';
  const orphan =
    v.status === '进行中' && !curNode
      ? `「${curNodeName}」这一步在流程模板里已经没有了 —— 指派也没用。` +
        '把状态改成「已完成」可以直接收尾（流程完成）；要接着往下走，就去「流程编排」把它补回模板。'
      : '';
  // 终态：它是"到此结束"的结论，属于时间轴尾部，不属于开篇。
  const endedHint =
    v.status === '进行中'
      ? ''
      : `<div class="run-end">这条流程已经「${esc(v.status)}」，不能再流转了。
           要再跑一遍，用左栏顶部的「＋」发起一条新的。</div>`;
  /*
   * 「结束」也是时间轴上的一个节点 —— 和流程图对得上。
   *
   * 用户 2026-10-14：最后一步（部署）的出口就是「结束」，可时间轴走到最后一步就没了，
   * 看着像"流程断在这儿"。所以尾部和「开始」对称地画一个终点：
   *   · **到了**（流程已完成）→ 绿点 + 结果，结果用服务端那句 note（形如「通过「部署」」）；
   *   · **没到** → 灰点 + 写清是**哪几步通过之后**会走到这里（出口声明里 approve === 'end' 的那些）。
   * 「已终止」是"没走到终点就散了"：这时不把它画成已到达，灰着就好（上面 endedHint 会说明原因）。
   */
  const endFrom = (v.nodes ?? []).filter((n) => n.approve === 'end').map((n) => n.name);
  const reachedEnd = v.status === '已完成';
  const endStep = `<div class="run-step end ${reachedEnd ? 'done' : 'ahead'}">
        <span class="run-dot"></span>
        <div class="run-step-head"><b>结束</b>${reachedEnd ? '<span class="run-st">已完成</span>' : ''}</div>
        <div class="run-who"><span><i>${reachedEnd ? '结果' : '怎么走到'}</i>${
          reachedEnd
            ? esc(v.note || '流程已完成')
            : orphan
              ? `当前这一步（「${esc(curNodeName)}」）在模板里已经没有了 —— 把它改「已完成」就直接收尾到这儿`
              : endFrom.length
                ? `${esc(endFrom.join('、'))} 通过后走到这里，流程结束`
                : '<span class="dim">模板里没有节点指向结束</span>'
        }</span></div>
      </div>`;
  const history = (v.tasks ?? [])
    .map((t) => {
      const oc = stepOutcome(t);
      // **没办完就被终止**的那一步单独一档颜色：它不是"在跑"（原来的蓝），也不是失败。
      // 蓝点会让它看着像"还在进行中"，而这条流程早就停了。
      const cls = oc.terminal
        ? 'gone'
        : t.status === '已完成' ? 'done'
        : (t.status === '失败' || t.status === '已阻塞') ? 'fail'
        : t.status === '待验收' ? 'wait'
        : 'run';
      const meta = [t.assigneeName ?? '没人', t.visit > 1 ? `第 ${t.visit} 次` : '', durText(t.elapsedMs)]
        .filter(Boolean)
        .join(' · ');
      // 流程页**不铺对话**：只显示有多少条 + 一个「对话」按钮，点开才是面板。
      // 这样对话被锚定在这一个节点上，时间轴也不会被长对话淹掉。
      const n = (t.messages ?? []).length;
      const canTalk = !!t.conversationId && t.status !== '待办';
      // 能不能通到任务卡：服务端给了「已有卡」或「能现开」之一就行（见 viewTask 的说明）
      const canOpenCard = !!t.projectTaskId || t.canOpenTaskCard === true;
      // 这一步的记录（状态 / 经办人 / 第几次 / 时间 / 耗时）现在全在这一行的属性行里，
      // 不用再开一个面板 —— 任务卡就是为此撤掉的。
      const isCur = t.id === lastTaskId;
      // 改状态 / 改指派就是上面那两行本身（点状态、点经办人），这里不再摆第二套。
      // **任务卡入口长在这儿**（2026-10-21 用户拍板）：原来是经办人后面那颗对话气泡，
      // 但它 2026-10-19 起开的已经是任务卡，气泡图标语义错位。现在收进这行字 ——
      // 「已往来 N 条 / 还没聊过」本身就是入口说明，点它开任务卡；
      // 流程没挂项目（开不了卡）时退回对话栏（三条路的接线共用，见下方 data-run-card）。
      const talkable = canOpenCard || canTalk;
      const talkText = canTalk ? (n ? `已往来 ${n} 条` : '还没聊过') : '还没聊过';
      const talk = `<div class="run-talk">${
        talkable
          ? `<button type="button" class="run-card-link" data-run-card data-task="${esc(t.id)}" title="${canOpenCard
              ? (t.projectTaskId ? '打开这一步的任务卡' : '打开任务卡（第一次点会建一张）')
              : '打开对话'}">${talkText}</button>`
          : '<span class="dim">先派活才能对话</span>'
        }</div>`;
      // 行内**只放快乐路径**（派活 / 通过 / 驳回）；重跑已删 —— 改状态成「待办」就是重跑。
      // 「没人可派」那种不在这儿再摆一颗"指派给谁" —— 上一行「经办人」本身就是入口，
      // 摆两颗是同一个动作两个按钮。
      const inline = isCur && inlineActs.length ? `<div class="run-acts">${inlineActs.join('')}</div>` : '';
      /*
       * 「现在怎么样」**写在这一步上**，不往页面顶上喊（见上面分层的说明）。
       * 文案里不含节点名 —— 服务端已经从理由里去掉了，这一行的标题就是那个节点名。
       *   bad   要你动手：已阻塞 / 失败 / 超时 / 找不到当前节点
       *   quiet 只是告知：正在跑 / 等你确认 / 还没派活 / 没人办
       * 服务端对同一个 run 只会给 stuck 或 waiting 之一，不会两个都有。
       */
      const now = isCur ? orphan || v.stuck || v.waiting || '' : '';
      /*
       * 「现在怎么样」（等人处理 / 正在跑 / 等你确认…）原来单开一个框挂在执行结果**上面**。
       * 现在并进执行结果里 —— 它跟"这一步干出来什么"本来是同一件事的两面
       * （干完了什么 + 现在卡在哪），上下两个框并列看着像两条互不相干的提示（用户要求去掉）。
       */
      /*
       * 这一步"谁办的 / 什么时候办的 / 办了多久"。
       *
       * 原来这三样挤在标题行右侧一小串（`.run-meta`：`波哥 · 第 2 次 · 17 秒`），
       * 而「经办时间」**压根没露出来** —— 要看全得点开任务卡。用户要求摊在每步下面，
       * 现在不用开卡就能读全。
       *
       * 缺的字段用「—」而不是整条藏掉：一眼看得出"这三样本来就该有"，
       * 而不是"这一步少了点什么"。
       */
      // **当前这一步能改，历史步骤不能**（服务端只认"当前任务"，见 setStepStatus/assignCurrentStep）。
      // 能改的做成选择器（点一下弹选项）；不能改的退回纯文本 ——
      // 不做成禁用态：既占地方，又让人以为是坏了。
      const alive = v.status === '进行中';
      const canStatus = isCur && alive && (v.statusChoices ?? []).length > 0;
      const canAssign = isCur && alive && (S.personas ?? []).length > 0;
      // 经办人后面**不再摆按钮**（2026-10-21）：那颗气泡 2026-10-19 起开的是任务卡，
      // 气泡图标语义错位 —— 入口挪到了下面「已往来 N 条」那行字上（见 talk）。
      const who = `<div class="run-who">
          <span><i>经办人</i>${
            canAssign ? '<span class="run-pick" id="runAssigneeMount"></span>' : esc(t.assigneeName ?? '没人')
          }${t.visit > 1 ? ` · 第 ${t.visit} 次` : ''}</span>
          <span><i>经办时间</i>${
            t.startedAt ? esc(new Date(t.startedAt).toLocaleString('zh-CN')) : '—'
          }</span>
          <span><i>耗时</i>${esc(durText(t.elapsedMs) || '—')}</span>
        </div>`;
      /*
       * 「执行结果」—— 标题就用**任务卡里那个字段名**（用户当时定的），
       * 别在这一处改口叫"经办信息"：同一个东西两个名字，是前面刚统一过的毛病。
       *
       * 内容**三选一**（2026-10-18 用户要求：简洁明了）：
       *   ① 有产物 → 只列产物（文件 / 链接）；
       *   ② 没产物 → 一句话"做了什么"；
       *   ③ 失败   → 报错原文。
       * 不再整段贴模型的自述 —— 那段开头多是"我先看了一下…"的铺垫，
       * 真正要看的（改了哪个文件 / 报了什么错）在后面，而 note 早就被截断了；
       * 所以拆分在服务端拿**全文**做完，存进 result（见 resultOf）。
       */
      const r = t.result ?? null;
      const arts = (r?.artifacts ?? []).filter((a) => a?.target);
      // error = 执行失败原文；blocked = 员工自报受阻（2026-10-23）—— 原因必显，
      // 哪怕同时列了产物（"能干的部分干了，卡在 XX" 是两句话都要看的）
      const err = r?.state === 'error'
        ? r.error || '执行失败'
        : r?.state === 'blocked'
          ? `受阻：${r.summary || '经办人报告干不下去，原因没写清'}`
          : '';
      // 有产物就不再补一句话：用户要"有产物展示产物"，两样并排等于又说一遍
      const line = !err && !arts.length ? (r?.summary ?? '') : '';
      const result =
        now || err || arts.length || line
          ? `<div class="run-note-label">执行结果</div><div class="run-note">${
              now
                ? `<div class="run-state ${v.stuck || orphan ? 'bad' : 'quiet'}">${
                    v.stuck || orphan ? '⚠️ ' : ''
                  }${esc(now)}</div>`
                : ''
            }${err ? `<div class="run-err">${esc(err)}</div>` : ''}${
              arts.length ? `<div class="run-arts">${arts.map(artChipHtml).join('')}</div>` : ''
            }${line ? `<div class="run-sum">${esc(line)}</div>` : ''}</div>`
          : '';
      return `<div class="run-step ${cls}${isCur ? ' cur' : ''}">
        <span class="run-dot"></span>
        <div class="run-step-head">
          <b>${esc(t.nodeName)}</b>
          ${/* 勾了「需要人工确认完成」的节点在这儿挂个标签：一眼看出"这步跑完会停下来等人"。
                跟设计器里节点卡上那个是同一个标签、同一套 .tag-inline 药丸。 */ ''}
          ${manualNodes.has(t.nodeId) ? '<em class="tag-inline" title="办完停住，等你确认才往下走">需人工确认</em>' : ''}
          ${
            /* 状态：当前这一步**本身就是选择器**（点它弹选项，选完立刻改）。
               能改哪几个由服务端给（v.statusChoices），前端不自己判断 —— 状态只有一个定义处。
               这原来长在任务卡里，任务卡撤了之后搬回行内。 */
            canStatus
              ? '<span class="run-st run-pick" id="runStatusMount"></span>'
              : `<span class="run-st">${esc(oc.status)}</span>`
          }
          ${oc.decision ? `<span class="run-dec">${esc(oc.decision)}</span>` : ''}
        </div>
        ${who}
        ${result}
        ${talk}
        ${inline}
      </div>`;
    })
    .join('');

  // 还没走到的节点：灰着列出来，好知道后面还有几步
  const done = new Set((v.tasks ?? []).map((t) => t.nodeId));
  const ahead = (v.nodes ?? [])
    .filter((n) => !done.has(n.id))
    .map(
      (n) => `<div class="run-step ahead">
        <span class="run-dot"></span>
        <div class="run-step-head"><b>${esc(n.name)}</b>${
          n.manual ? '<em class="tag-inline" title="办完停住，等你确认才往下走">需人工确认</em>' : ''
        }</div>
        ${/* 还没走到：只有"指定了谁"这一条有内容，时间和耗时留空不写破折号 ——
              这一步还没跑，摆两行「—」是噪音。 */ ''}
        <div class="run-who"><span><i>经办人</i>${esc(n.assigneeName ?? '没人可派')}</span></div>
      </div>`,
    )
    .join('');

  return `
    <div class="run-page">
      <div class="run-left">
        <!-- 顶栏：只属于左边这一栏（右边对话栏自带一条头，两栏等高，见 .run-head 那条规则）。
             左边是推拉列表面板的按钮 + 标题 + 状态徽标，右边是动作。
             返回按钮统一去掉了：回工作台 / 换一条记录都点左栏那一行。 -->
        <div class="detail-head run-head">
          <!-- ⚠️ 顶栏最左边原来有一枚「«」推拉按钮（收起/放出最左侧的列表面板）。
               2026-10-19 用户要求去掉这一页的收缩展开：这一页的左栏是**发起记录**，
               换一条记录全靠点它 —— 收起来等于把自己唯一的路收掉，而省下的那点宽度
               换不来什么（右边还有一整栏对话）。整页统一：**左栏常驻，不推拉**。
               所以这里不再有前置按钮，页头最左边就是标题（跟其它子页一个规矩）。
               面包屑（工作台 › 模板名）在左栏顶上，这里只写**这一条 run 的标题**。 -->
          <div class="head-title"><b>${esc(v.title)}</b>
            <span class="flow-badge ${b.cls}">${esc(b.text)}</span></div>
          <div class="head-actions">${acts.join('')}</div>
        </div>
        <div class="detail-body run-wrap">

      ${/* 「这条流程是什么」：归属项目 / 创建时间 / 想法。
             这三条原来散着、或者根本看不见：
               · 项目：顶栏挂了个小胶囊 —— 就在这块正上方，同一屏里说两遍 → 收到这儿
               · 想法：原来是时间轴「开始」节点里的那段 —— 那块就在这一块正下方，
                 同一句话上下挨着显示两遍 → 也收到这儿
               · 创建时间：以前压根没露出来（viewRun 只给当前任务的 startedAt）
             现在集中成一处；时间轴从「开始」往下就是纯粹的流转记录了。 */ ''}
      <div class="run-facts">
        <div class="rf-row">
          <span class="rf-k">归属项目</span>
          <span class="rf-v">${
            v.projectName
              ? esc(v.projectName)
              : '<span class="dim">没选项目 —— 每一步在各自经办人的工作目录里跑</span>'
          }</span>
        </div>
        <div class="rf-row">
          <span class="rf-k">创建时间</span>
          <span class="rf-v">${v.createdAt ? esc(new Date(v.createdAt).toLocaleString('zh-CN')) : '—'}</span>
        </div>
        <div class="rf-row">
          <span class="rf-k">想法</span>
          <span class="rf-v">${v.intent ? esc(v.intent) : '<span class="dim">（发起时没填）</span>'}</span>
        </div>
      </div>

      <div class="run-steps">
        ${/* 「开始」也是时间轴上的一个节点 —— 和流程图对得上。
              它的内容是"发起时填的想法"，但那段话现在在上面的 .run-facts 里了
              （两块紧挨着，同一句显示两遍是纯重复）—— 所以这里只留节点标记。 */ ''}
        <div class="run-step start">
          <span class="run-dot"></span>
          <div class="run-step-head"><b>开始</b></div>
          ${/* 发起人也走同一套"标签 + 值"，跟下面每一步的「经办人」对齐 */ ''}
          <div class="run-who"><span><i>发起人</i>我</span></div>
        </div>
        ${history || '<div class="wip">还没有流转记录</div>'}
        ${ahead}
        ${endStep}
      </div>
      ${/* 终态提示挂在<b>时间轴末尾</b>：它是"到此结束"的结论，不属于开篇。
             原来在页面最顶上压着流程信息，一眼看去很违和（用户报的）。 */ ''}
      ${endedHint}

      </div>
      </div>
      <!-- 第二栏：点节点上的「对话」才出现（不是浮层，各占各的宽） -->
      <div class="nc-col is-hidden" id="ncCol">
        <div class="nc-head">
          <b id="ncTitle">对话</b>
          ${/* 这里原来是「对话 / 任务卡」两个标签。任务卡撤了（内容全搬进了时间轴各步），
                只剩对话，标签行也就没必要了 —— 留一根一行两个标签的横条只会让人去找另一个。 */ ''}
          <!-- 是"收起这一栏"，不是"关掉弹窗" —— 所以用折叠面板的图标，不用 ✕ -->
          <button class="icon-btn" type="button" data-nc-close title="收起这一栏" aria-label="收起这一栏">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                 stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="2.5" />
              <path d="M15 4v16" />
            </svg>
          </button>
        </div>
        <div class="nc-msgs" id="ncMsgs"></div>
        <div class="nc-say">
          <!-- <b>复用主聊天框那套</b>（.input-wrap + .input-tools）：
               边框、焦点环、textarea 的 padding/字号/resize 全在那儿了。
               自己再写一套 .nc-say-box 的结果是"看着像个裸 textarea"——踩过。 -->
          <div class="input-wrap">
            <textarea id="ncInput" rows="5" placeholder="说点什么…（回车换行）"></textarea>
            <div class="input-tools">
              <div id="ncPermMount"></div>
              <!-- 发送：小圆圈 + 向上箭头 -->
              <button class="primary nc-send" type="button" id="ncSend" title="发送" aria-label="发送">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                     stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 19V6" /><path d="M6 12l6-6 6 6" />
                </svg>
              </button>
            </div>
          </div>
        </div>
        <!-- 任务卡（#ncTask）原来在这儿：当前这一步的状态/经办人/重跑。
             状态和经办人现在全在时间轴那一步的行里（点状态、点经办人），
             重跑也删了（把状态改成「待办」就是重跑），所以这一块连同标签一起撤了。 -->
      </div>
    </div>`;
}



export function wireRun(v) {
  const view = $('flowView');
  // ⚠️ 发送必须在这儿接 —— 从弹窗搬进页面时漏过一次，
  //    结果按钮点了毫无反应（连提示都没有），排查了半天。
  // **回车不发送**：这里写的是长文本（需求、意见），回车应该是换行 ——
  // 想发就点那个圆圈按钮。
  //
  // ⚠️ 一律用 `onclick =` 而不是 addEventListener：**这个函数会被重复调用**
  //    （增量更新之后要重新接按钮），addEventListener 会叠加成"点一次发两条"。
  const send = view.querySelector('#ncSend');
  // 他在办的时候，这颗按钮不是"发送"，是"停止生成" —— 跟 DSH 一样
  //（DSH 运行中那颗按钮的文案就是 input.stop = 停止生成，图标是方块）
  // ⚠️ 按**按钮自己的状态**判断走哪条路，别依赖 ncCtx（那是右侧对话栏的东西，
  //    没开栏时它是 null，点击会掉进 sendNodeChat —— 空输入，看着像"点了没反应"）
  if (send) send.onclick = () => (send.classList.contains('stopping') ? stopNodeRun() : sendNodeChat());
  /*
   * 节点上「已往来 N 条」那行字 → **这一步的任务卡**（2026-10-21 起；再往前是经办人后面的
   * 对话气泡图标，气泡语义错位被挪走了）；没有卡、也不能开卡时退回对话栏。
   *
   * 三条路，顺序不能反：
   *   ① 服务端说"已经有卡" → 直接开弹窗（不写库）；
   *   ② 说"能开" → 让服务端现开一张再开（`POST .../card` 是幂等的，点两次不会两张）；
   *   ③ 都没有（流程没挂项目）→ 退回原来的对话栏 —— 那条路还在，只是不再是首选。
   * 一次点击只该发生一件事，所以用 if/else 串起来而不是各挂各的。
   *
   * ⚠️ ①②落在**弹窗**里（`openTaskCardDialog`），不换页（2026-10-19）：
   *    换页会把人从这条流程里带走，改完还得自己找回来 —— 换来的只是一个"整页"的壳。
   */
  view.querySelectorAll('[data-run-card]').forEach((el) => {
    el.onclick = async () => {
      const taskId = el.dataset.task;
      const step = (v.tasks ?? []).find((x) => x.id === taskId) ?? null;
      if (!step) return;
      // 来路：让弹窗标题写得出「任务卡 · 节点名」，关掉之后也知道该刷哪条流程
      const fromFlow = { runId: v.id, templateId: v.templateId ?? null, runTitle: v.title, nodeName: step.nodeName };
      if (step.projectTaskId) {
        return openTaskCardDialog(step.projectTaskId, { fromFlow }).catch((e) => toast(e.message, 'error'));
      }
      if (step.canOpenTaskCard) {
        el.disabled = true;
        try {
          const d = await api(
            `/api/workflows/runs/${encodeURIComponent(v.id)}/tasks/${encodeURIComponent(taskId)}/card`,
            { method: 'POST' },
          );
          if (d?.task?.id) return await openTaskCardDialog(d.task.id, { fromFlow });
          throw new Error('没拿到卡');
        } catch (e) {
          toast(`开不了卡：${e.message}`, 'error');
        } finally {
          el.disabled = false;
        }
        return;
      }
      openNodeChat(v.id, taskId).catch((e) => toast(e.message, 'error'));
    };
  });
  /*
   * 产物：文件 → 复制路径（贴进编辑器或终端就是"打开"）；链接 → 新窗口。
   * 同样用 onclick 覆盖式接线（这个函数会被增量更新重复调用，见上面那条注释）。
   */
  view.querySelectorAll('[data-art-copy]').forEach((el) => {
    el.onclick = async () => {
      try {
        await navigator.clipboard.writeText(el.dataset.artCopy);
        hint('路径已复制');
      } catch {
        hint(`复制不了，手动选中：${el.dataset.artCopy}`);
      }
    };
  });
  view.querySelectorAll('[data-art-open]').forEach((el) => {
    el.onclick = () => window.open(el.dataset.artOpen, '_blank', 'noopener');
  });
  /*
   * 当前这一步的**状态**和**经办人**：两行本身就是入口（点一下弹选项）。
   * 这原来在右侧栏的任务卡里，任务卡撤了之后接线搬到这儿 —— 逻辑没变，变的是位置。
   *
   * 「经办人」选人即执行：服务端的 assign 是"改完直接派活"，所以有人时等于把这一步
   * 打回「待办」重派 —— 二次确认必须说清楚这件事。
   * 取消确认时要把下拉上的文字**拨回去**（createCombo 在回调前就改了按钮文字），
   * 不然界面上会留着一个"看起来改了、其实没改"的值。
   */
  const cur = (v.tasks ?? [])[v.tasks.length - 1] ?? null;
  const alive = v.status === '进行中';
  const assignMount = view.querySelector('#runAssigneeMount');
  if (assignMount && cur) {
    let assignCombo = null;
    const backTo = cur.assigneePersonaId ?? '';
    assignCombo = createCombo({
      mount: assignMount,
      items: (S.personas ?? []).map((p) => ({ id: p.id, label: personLabel(p) })),
      value: backTo,
      blank: '没人',
      // 人多了就得能搜 —— 用词跟流程设计里那个人选下拉（mountAssigneePicker）保持一致
      search: true,
      placeholder: '搜名字…',
      empty: '没有匹配的人',
      onChange: async (id) => {
        if (!id || id === backTo) return; // 点回原来那个人：什么都没变，别白派一次
        const who = (S.personas ?? []).find((p) => p.id === id)?.name ?? '这个人';
        const ask = cur.assigneeName
          ? `把「${cur.nodeName}」从「${cur.assigneeName}」改派给「${who}」？\n\n这一步会回到「待办」并马上派活（他正忙就 30 秒内自动再试）。`
          : `把「${cur.nodeName}」指派给「${who}」？\n\n会立刻派活。`;
        if (!(await confirmDo(ask))) return assignCombo.setValue(backTo);
        try {
          await api(`/api/workflows/runs/${encodeURIComponent(v.id)}/assign`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ personaId: id }),
          });
          await paintRun(v.id);
        } catch (e) {
          toast(e.message, 'error');
          assignCombo.setValue(backTo);
        }
      },
    });
  }
  /*
   * 「状态」那个字**就是**改状态的入口：点它弹出选项，选完立刻改。
   * 能改哪几个由服务端给（v.statusChoices），前端不自己判断 —— 状态只有一个定义处。
   * value 传**当前状态**：它不在选项里，所以按钮显示的是"现在的状态"、列表里也不会出现它，
   * 一眼就知道"点这儿能改"而不是"这里已经选好了"。
   */
  const statusMount = view.querySelector('#runStatusMount');
  if (statusMount && cur) {
    let statusCombo = null;
    statusCombo = createCombo({
      mount: statusMount,
      items: (v.statusChoices ?? []).map((s) => ({ id: s, label: s })),
      value: cur.status,
      search: false,
      placeholder: '选一个',
      // 这枚状态就贴在页面右边：浮层要**往左展开**，否则顶出视口（用户 2026-10-17 实报）
      right: true,
      onChange: async (picked) => {
        if (!picked) return;
        const hint = {
          待办: '回到「待办」：这一步的往来和执行痕迹会清掉，之后可以重新派活。确定吗？',
          已阻塞: '标成「已阻塞」：出了问题等人拍板，不会再派活。确定吗？',
          已完成: '标成「已完成」：等于「通过」，会按通过出口走到下一步。确定吗？',
        }[picked];
        if (hint && !(await confirmDo(hint))) return statusCombo.setValue(cur.status);
        try {
          await api(`/api/workflows/runs/${encodeURIComponent(v.id)}/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: picked }),
          });
          await paintRun(v.id);
        } catch (e) {
          toast(e.message, 'error');
          statusCombo.setValue(cur.status);
        }
      },
    });
  }
  /*
   * 「继续一次」：这一步被**额度**拦下了，你明确知道要超支，放它过去。
   *
   * 走的是同一个派活接口（/start），只多带一个 force —— 闸在服务端，这里不是绕过它，
   * 是跟它说清楚"这次是我拍的板"。注意**不能走 retry**：retry 会先把这一步改回「待办」，
   * 于是派活时又撞一次额度闸、又写一遍同样的备注（那颗按钮在这会儿是空转）。
   */
  const forceBtn = view.querySelector('[data-run-force]');
  if (forceBtn) {
    forceBtn.onclick = async () => {
      forceBtn.disabled = true;
      try {
        await api(`/api/workflows/runs/${encodeURIComponent(v.id)}/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force: true }),
        });
        await paintRun(v.id);
      } catch (e) {
        toast(e.message, 'error');
        forceBtn.disabled = false;
      }
    };
  }
  // 收起这一栏
  const ncClose = view.querySelector('[data-nc-close]');
  if (ncClose) ncClose.onclick = closeNodeChat;
  // （原来这里还有一颗 [data-run-again]「按同一个流程重新发起」—— 已删，
  //   理由见 runHTML 里 endedHint 那段注释：它跟左栏的「＋」是同一个调用。）
  // 删除这条流程记录（**只删流程，不动各经办人的会话**）
  const del = view.querySelector('[data-run-del]');
  if (del) del.onclick = async () => {
    if (!(await confirmDo(`删掉「${v.title}」这条流程记录？\n\n各经办人的对话不会被删。`))) return;
    try {
      await api('/api/workflows/runs/' + encodeURIComponent(v.id), { method: 'DELETE' });
      S.flowRuns = (S.flowRuns ?? []).filter((r) => r.id !== v.id);
      if (S.flowRunId === v.id) S.flowRunId = null;
      if (S.flowRun?.id === v.id) S.flowRun = null;
      closeNodeChat();
      openFlowRun(v.templateId).catch((e) => toast(e.message, 'error')); // 回到发起记录页
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  // （那枚推拉列表面板的按钮 2026-10-19 撤了 —— 接线跟着删，见 runHTML 里的说明）
  // 「指派」「改状态」现在都长在时间轴"当前这一步"那一行里 —— 任务卡已撤；
  // 「重跑」也删了（改状态成「待办」就是重跑）。行内只剩：通过 / 驳回（快乐路径）。
  view.querySelectorAll('[data-run-decide]').forEach((el) => {
    el.onclick = async () => {
      const decision = el.dataset.runDecide;
      if (decision === '驳回' && !(await confirmDo(`驳回「${v.nodeName}」？\n\n会回到「${v.outlets?.rejectTo ?? '—'}」，那一步要重做。`))) return;
      if (decision === '终止' && !(await confirmDo(`终止「${v.title}」这条流程？\n\n已经办完的步骤保留，后面的不再推进。`))) return;
      el.disabled = true;
      try {
        await api(`/api/workflows/runs/${encodeURIComponent(v.id)}/decide`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision }),
        });
        await paintRun(v.id);
      } catch (e) {
        toast(e.message, 'error');
        el.disabled = false;
      }
    };
  });
}



/* ------------------------------------------------- 节点栏（页面里的第二栏） */

/**
 * 点那一步的对话图标 → 右边**多出一栏**（不是浮层）。
 *
 * 为什么是"栏"不是"弹窗/抽屉"：
 *   · 浮层要么盖住时间轴，要么把左边挤窄还空一大块 —— 两栏各占各的才对
 *   · 左边看走到哪了，右边谈事，宽度各得其所
 *   · 范围锚定在这个节点（发起人 ↔ 这一步的经办人）
 *
 * 这一栏**只有对话**了：原来还有个「任务卡」标签（这一步的记录 + 收拾类操作），
 * 那些内容全搬进了时间轴上那一步的行里 —— 状态/经办人点一下就改、时间与耗时在属性行。
 * 为读一份记录专门开个面板，不值当。
 */
export let ncTimer = null;


export let ncCtx = null;

 // { runId, taskId }
// 这一步正在跑的那次运行（停止按钮要用）。跟 ncCtx 无关 —— 没开对话栏时也要能停。
export let ncRunningId = null;


export let ncStream = null;

 // 这一步正在跑的那次运行的实时流（app.js 里共用的 streamRun）

/** 亮/灭「正在输入中」——**仿微信**：做成左边一个气泡（三个点依次跳），
 *  不是顶栏上的一行字。列表每次重画就被冲掉，所以这里每次重新插。 */
export function setTyping(on) {
  // 他在办 → 发送键变成 DSH 那颗「停止生成」（方块）
  const send = $('ncSend');
  if (send) {
    send.innerHTML = on
      ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>'
      : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V6" /><path d="M6 12l6-6 6 6" /></svg>';
    send.title = on ? '停止生成' : '发送';
    send.setAttribute('aria-label', on ? '停止生成' : '发送');
    send.classList.toggle('stopping', !!on);
  }
  const box = $('ncMsgs');
  if (!box) return;
  box.querySelector('.nc-typing-row')?.remove();
  if (!on) return;
  box.insertAdjacentHTML(
    'beforeend',
    '<div class="nc-msg them nc-typing-row"><div class="nc-text"><i></i><i></i><i></i></div></div>',
  );
  box.scrollTop = box.scrollHeight;
}



/** 停止生成：掐掉这一步正在跑的那次运行（跟 DSH 那颗方块按钮一个意思） */
export async function stopNodeRun() {
  const id = ncRunningId;
  if (!id) return;
  // **先让界面立刻停下来**（点完就见效，不等后端回调）
  setTyping(false);
  ncRunningId = null;
  try {
    await api(`/api/runs/${encodeURIComponent(id)}/abort`, { method: 'POST' });
  } catch (e) {
    toast(e.message, 'error');
  }
  // 再按真实状态刷新一次（跑完的钩子会把这一步收尾）
  if (ncCtx) await refreshNodeChat().catch(() => {});
}



/** 收流：把流式气泡换成库里那份（落库的是完整消息，避免留半截） */
export function closeNodeStream() {
  ncStream?.close();
  ncStream = null;
  setTyping(false);
  if (ncCtx) refreshNodeChat().catch(() => {});
}



/**
 * 订阅这一步的实时输出 —— **复用 app.js 里的 streamRun**，
 * 跟消息模块是同一套（同一个端点、同一份收尾逻辑）。
 *
 * 为什么不能靠轮询：李俊回复时流程里的任务状态还是「待验收」（状态只在推进时变），
 * 按任务状态决定要不要轮询的话根本不会轮询，于是"要刷新页面才看到回复"（踩过）。
 */
export function openNodeStream(runId) {
  if (ncStream || !runId) return;
  setTyping(true);
  ncStream = streamRun(runId, {
    onText: (chunk) => {
      const box = $('ncMsgs');
      if (!box) return;
      // 事件是分块推的：每块追加一个气泡（跟消息模块一样），不自己攒
      const el = document.createElement('div');
      el.className = 'nc-msg them';
      el.innerHTML = `<span class="nc-who">…</span><div class="nc-text">${renderMarkdown(chunk)}</div>`;
      box.append(el);
      box.scrollTop = box.scrollHeight;
    },
    onRunError: (msg) => {
      const box = $('ncMsgs');
      if (box) box.insertAdjacentHTML('beforeend', `<div class="nc-msg them"><div class="nc-text">· ${esc(msg)}</div></div>`);
    },
    onDone: () => closeNodeStream(),
    onReconnect: () => {
      if (ncCtx) refreshNodeChat().catch(() => {});
    },
  });
}



export async function openNodeChat(runId, taskId) {
  ncCtx = { runId, taskId };
  const col = $('ncCol');
  if (col) col.classList.remove('is-hidden');
  await refreshNodeChat();
}




export function closeNodeChat() {
  ncCtx = null;
  clearTimeout(ncTimer);
  $('ncCol')?.classList.add('is-hidden');
  // 关掉之后左边恢复全宽
  if (S.flowRunId) paintRun(S.flowRunId).catch(() => {});
}



export async function refreshNodeChat() {
  if (!ncCtx) return;
  const v = await api('/api/workflows/runs/' + encodeURIComponent(ncCtx.runId));
  const last = (v.tasks ?? []).at(-1) ?? null;
  const t = (v.tasks ?? []).find((x) => x.id === ncCtx.taskId) ?? last;
  if (!t) return;
  ncCtx.taskId = t.id;
  const title = $('ncTitle');
  if (title) title.textContent = `${t.nodeName} · ${t.assigneeName ?? '没人'}`;
  const input = $('ncInput');
  if (input) input.placeholder = t.runningRunId ? '他正在办…也可以再补一句' : '说点什么…';
  // 打开时他正好在跑（比如你刚发完就切走了）→ 接上那条实时流，别等刷新
  if (t.runningRunId) openNodeStream(t.runningRunId);

  const box = $('ncMsgs');
  if (box) {
    const msgs = t.messages ?? [];
    box.innerHTML = msgs.length
      ? msgs
          .map(
            (m) => `<div class="nc-msg ${m.role === 'user' ? 'me' : 'them'}">
              <span class="nc-who">${esc(m.who)}</span>
              <div class="nc-text">${renderMarkdown(m.text)}</div>
            </div>`,
          )
          .join('')
      : '<div class="nc-empty">还没聊过。说一句，他就开始办</div>';
    box.scrollTop = box.scrollHeight; // 新消息在下面
  }
  // **必须放在列表重画之后**（重画会把它冲掉）——「正在输入中」看的是
  // 这次会话有没有在跑，不是任务状态
  setTyping(!!t.runningRunId);
  // ⚠️ 记下"在跑的那次运行"：停止按钮要用它。
  //    以前这里判断的是 ncCtx?.runningRunId，而 ncCtx 是右侧对话栏打开时才建的 ——
  //    按钮在没开对话栏时就点不动（掉进 sendNodeChat，输入框空，什么都不发生）。
  ncRunningId = t.runningRunId ?? null;
  renderNcPerm(t);
  // 收尾靠 SSE 的 __done（见 closeNodeStream），不再按任务状态定时轮询 ——
  // 那样的条件在"他正回复"时是假的，等于不刷新（踩过）
}



export function renderNcPerm(t) {
  const mount = $('ncPermMount');
  if (!mount) return;
  mount.innerHTML = '';
  if (!t.conversationId) return; // 还没派活，没有会话可设
  const p = S.personas.find((x) => x.id === t.assigneePersonaId);
  const rt = S.runtimes.find((x) => x.id === (p?.runtime ?? t.runtime)) ?? null;
  convPermCombo({
    mount,
    conversationId: t.conversationId,
    runtime: rt,
    value: t.conversationSandbox, // 会话上的覆盖值（null = 跟随员工）
    personaSandbox: p?.sandbox ?? t.runtime,
    onDone: () => refreshNodeChat(),
  });
}



export async function sendNodeChat() {
  // **每一步失败都要说出来** —— 之前几处是静默 return，
  // 点了没反应又没有任何提示，只能靠猜（排查了很久）
  if (!ncCtx) return hint('对话栏没打开？关掉重开一次');
  const input = $('ncInput');
  if (!input) return hint('找不到输入框，刷新一下');
  const text = input.value.trim();
  if (!text) return hint('先写点什么');

  const v = await api('/api/workflows/runs/' + encodeURIComponent(ncCtx.runId));
  const t = (v.tasks ?? []).find((x) => x.id === ncCtx.taskId) ?? (v.tasks ?? []).at(-1);
  if (!t?.conversationId) return hint(`「${t?.nodeName ?? '这一步'}」还没有会话，先派活`);

  input.disabled = true;
  try {
    // 走的是发消息那条路：runId 带上，平台就知道这轮属于哪条流程的哪一步（一步多轮）
    const res = await api('/api/conversations/' + encodeURIComponent(t.conversationId) + '/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, runId: ncCtx.runId, taskId: ncCtx.taskId }),
    });
    input.value = '';
    // **马上接上实时流**（跟消息模块一样），不等轮询 —— 他边说你边看
    openNodeStream(res?.runId);
    await refreshNodeChat();
    if (S.flowRunId) paintRun(S.flowRunId).catch(() => {}); // 左边时间轴跟着变
  } catch (e) {
    // 400/409 的原因要原样说出来（比如"他还在跑上一条"）
    hint(`没发出去：${e.message}`);
  } finally {
    input.disabled = false;
    input.focus();
  }
}



/** 一句话提示，几秒后自己消失（沿用现有那条 hint） */
export function hint(text) {
  const el = $('hint');
  if (!el) return;
  el.textContent = text;
  el.classList.remove('is-hidden');
  setTimeout(() => {
    if (el.textContent === text) {
      el.textContent = '';
      el.classList.add('is-hidden');
    }
  }, 4000);
}


/* ---------------------------------------------------------- 流程设计器（纵向） */

/**
 * 纵向顺序设计器：**结构就是顺序**，不用拖节点、不用拉线。
 *
 * 上一版做的是自由画布（拖位置 + 从端口拉线），难用：端口小、落点要准、
 * 还得自己想清楚谁连谁。而 OA 审批流的真相是：
 *   · 「通过 → 下一步」**本来就是顺序**，不需要连
 *   · 只有「驳回去哪」是**真正要配**的东西（回某节点 / 结束 / 不驳回）
 *
 * 所以：节点按数组顺序从上到下排，中间一个「＋」插入，每张卡上配驳回目标。
 * 保存时**把顺序翻译成连线**（approve = 下一个节点），引擎那边完全不用改。
 */

export async function openDesigner(templateId = null) {
  setRoute('designer', { template: templateId ?? null });
  const id = templateId || S.designerId || S.flowTemplates[0]?.id;
  if (!id) return toast('还没有流程模板');
  let tpl;
  try {
    tpl = await api('/api/workflows/templates/' + encodeURIComponent(id));
  } catch (e) {
    return toast(e.message, 'error');
  }
  S.designerId = id;
  S.designerOpen = id;
  S.designerName = tpl.name;
  S.designerPublished = !!tpl.publishedAt; // 发布状态：按钮上要显示"发布"还是"下架"
  S.designerDraft = tpl.nodes.map((n) => ({ ...n }));
  S.designerSel = S.designerDraft[0]?.id ?? null;
  S.designerRestored = false;
  // 面板收起状态记在本地：收起来专心排流程，下次进来还是收着的
  try { S.dzPanelCollapsed = localStorage.getItem(PANEL_KEY) === '1'; } catch { S.dzPanelCollapsed = false; }

  // 上次没保存的草稿：画到一半手滑关了页面，不该白干。
  // **但只有真和模板不一样才算"没保存的改动"** —— 每次重画都会存草稿，
  // 只打开看一眼就退出的话，草稿和模板一模一样，再提示"已恢复"就是假报警。
  const draft = readDraft();
  if (draft && draft.templateId === id && !sameNodes(draft.nodes, tpl.nodes)) {
    S.designerDraft = draft.nodes;
    S.designerName = draft.name ?? S.designerName;
    S.designerSel = S.designerDraft[0]?.id ?? null;
    S.designerRestored = true;
    S.designerDraftAt = draft.savedAt ?? null;
  } else if (draft) {
    clearDraft(); // 和模板一样 → 留着没意义，还会下次误报
  }

  // 左栏顶上：工作台 › 流程编排（当前流程名在页头那个输入框里，不再往面包屑里塞第三段）
  setListTitle([{ label: '工作台', to: 'workbench' }, { label: '流程编排' }]);
  renderFlowList();
  paintDesigner();
}



/* ------------------------------------------- 设计器草稿（防意外关闭） */

export const DRAFT_KEY = 'bandi.designerDraft';


export const PANEL_KEY = 'bandi.dzPanelCollapsed';

 // 属性面板收起状态
export function readDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    return d && Array.isArray(d.nodes) && d.nodes.length ? d : null;
  } catch {
    return null;
  }
}


export function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* 写不了就算了 */ }
}


/** 两份节点是不是一回事（顺序也算在内 —— 挪位置就是改动） */
export function sameNodes(a, b) {
  const norm = (x) => JSON.stringify((x ?? []).map((n) => ({ ...n })));
  return norm(a) === norm(b);
}



/** 「3 分钟前」这种说法，比一串 ISO 时间好读 */
export function whenText(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}


export let draftTimer = null;


export function scheduleDraftSave() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    if (!S.designerId) return;
    try {
      localStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({ templateId: S.designerId, name: S.designerName, nodes: S.designerDraft, savedAt: new Date().toISOString() }),
      );
    } catch { /* 隐私模式下写不了就算了 */ }
  }, 400);
}



/**
 * 把「顺序」翻译成连线：每个节点 approve = 下一个；最后一个 approve = 结束。
 * **驳回不动** —— 那是人配的。
 *
 * 这么做是为了引擎不用改：它照旧按边跳转，只是边的来源从"手工拉"变成"顺序推导"。
 */
export function rewire() {
  const nodes = S.designerDraft ?? [];
  nodes.forEach((n, i) => {
    n.approve = i + 1 < nodes.length ? nodes[i + 1].id : 'end';
  });
}


export function nodeOf(id) {
  return (S.designerDraft ?? []).find((n) => n.id === id) ?? null;
}



/**
 * 「谁来办」显示成什么：
 *   · 点名了人 → 人名
 *   · 没点名 → `未指定`（这一步到站就阻塞，等人指派；**不按技能顶人**）
 *
 * 节点上不再有"技能"这一维：技能是员工身上的能力，不是流程的路由键。
 * 而且不是每个节点都有对应技能 —— 所以这里连提示都不显示。
 */
export function assigneeLabel(n, bare = false) {
  if (!n) return '';
  if (n.personaId) {
    const p = (S.personas ?? []).find((x) => x.id === n.personaId);
    return p ? p.name : bare ? '' : '（点名的人不在了）';
  }
  return bare ? '' : '未指定';
}



/**
 * 「谁来办」用**现成的 createCombo**（带搜索、键盘上下键、✓ 标记、点外面收起）。
 * 我第一版自己手写了个 input+list —— app 里本来就有这个组件，重复造一个既费代码
 * 又少掉键盘操作。
 *
 * **只选人，不按技能顶人**（用户 2026-10-14 定）：值就是 `personaId`，
 * 既不拿"技能解析出来的人"预填，也不从技能反推候选。
 * 没选 = 这一步故意留空，到站即「已阻塞」，等人来指派。
 */
export function mountAssigneePicker(view, sel) {
  const mount = view.querySelector('[data-vd-pick-mount]');
  if (!mount) return;
  createCombo({
    mount,
    search: true,
    placeholder: '搜名字…',
    empty: '没有匹配的人',
    value: sel.personaId || '',
    items: [{ id: '', label: '不指定' }].concat((S.personas ?? []).map((p) => ({ id: p.id, label: personLabel(p) }))),
    onChange: (id) => {
      const n = nodeOf(S.designerSel);
      if (!n) return;
      n.personaId = id || '';
      paintDesigner();
    },
  });
}



export function paintDesigner() {
  const nodes = S.designerDraft ?? [];
  const sel = nodeOf(S.designerSel);

  const rejectOpts = (v) =>
    ['<option value="">（不驳回）</option>', `<option value="end"${v === 'end' ? ' selected' : ''}>结束流程</option>`]
      .concat(
        nodes
          .filter((n) => n.id !== sel?.id)
          .map(
            (n) =>
              `<option value="${esc(n.id)}"${v === n.id ? ' selected' : ''}>回到「${esc(n.name || n.id)}」</option>`,
          ),
      )
      .join('');

  // 节点之间那段：**一条竖线 ＋ 骑在线上的「＋」**
  // 原来是"＋ 和线放在节点之前"，结果最后一个节点和「结束」之间是断的。
  const seg = (idx, hint) =>
    `<div class="vd-seg"><button class="vd-plus" data-vd-add="${idx}" title="${hint}">＋</button></div>`;

  const card = (n, i) => {
    const back = n.reject === 'end' ? '驳回到结束' : n.reject ? `驳回 →「${nodeOf(n.reject)?.name ?? n.reject}」` : '不可驳回';
    const bad = n.reject && n.reject !== 'end' && !nodeOf(n.reject);
    return `
      <div class="vd-node${n.id === S.designerSel ? ' sel' : ''}" data-vd-node="${esc(n.id)}">
        <div class="vd-head">
          <span class="vd-n">${i + 1}</span>
          <b>${esc(n.name || '(未命名)')}</b>
          ${/* 勾了「需要人工确认完成」的节点在这里挂个标签 ——
                一眼看出"这一跑完会停下来等人"，不用逐个点开属性面板去看。
                样式用现成的 .tag-inline（跟「已挂载」「群助手」同一套药丸）。 */ ''}
          ${n.manual ? '<em class="tag-inline" title="办完停住，等你确认才往下走">需人工确认</em>' : ''}
          ${bad ? '<span class="vd-bad" title="驳回目标不存在">!</span>' : ''}
          <button class="mini" data-vd-del="${esc(n.id)}" title="删掉这个节点">×</button>
        </div>
        <div class="vd-sub">${esc(assigneeLabel(n))} · ${esc(back)}</div>
      </div>`;
  };

  // 开始 ─⊕─ 节点1 ─⊕─ 节点2 … ─⊕─ 结束：每两个东西之间都有一段
  const chain = [seg(0, '在最前面插一个节点')]
    .concat(nodes.map((n, i) => card(n, i) + seg(i + 1, `插到「${n.name || n.id}」后面`)))
    .join('');

  $('flowView').innerHTML = `
    ${headRow(
      // 面包屑「工作台 › 流程编排」在**左栏顶上**（2026-10-19 用户要求挪过去），页头这边
      // 只留当前这一项：流程名。**看上去是标题、点上去能改**（不要输入框的样子，见 #dzName 的样式），
      // 再写一遍名字等于同一个东西三处各写一次。
      `<input id="dzName" value="${esc(S.designerName ?? '')}" placeholder="流程名字" spellcheck="false" title="点一下改流程名" />`,
      `<button data-vd-publish>${S.designerPublished ? '已发布 · 下架' : '发布到工作台'}</button>
       <button class="primary" data-vd-save>保存</button>`,
    )}
    <div class="detail-body dz-wrap">
      ${
        S.designerRestored
          ? `<div class="flow-alert warn">
               <b>上次改到一半没保存</b>，已恢复到当时的样子${
                 S.designerDraftAt ? `（${esc(whenText(S.designerDraftAt))}）` : ''
               }—— 看一眼对不对，不对就丢弃
               <button class="btn-sm" style="margin-left:auto" data-dz-drop>丢弃，用模板里的</button>
             </div>`
          : ''
      }
      <div class="dz-body${S.dzPanelCollapsed ? ' collapsed' : ''}" id="dzBody">
        <div class="vd-canvas">
          <div class="vd-start">开始</div>
          ${nodes.length ? chain : `${seg(0, '加第一个节点')}<div class="wip" style="padding:8px 0">还没有节点，点上面的「＋」加一个</div>`}
          <div class="vd-end">结束</div>
        </div>
        <button class="dz-toggle" data-vd-toggle
                title="${S.dzPanelCollapsed ? '展开属性面板' : '收起属性面板'}">${S.dzPanelCollapsed ? '«' : '»'}</button>
        <div class="dz-panel">
          ${
            sel
              ? `<div class="dz-panel-head">节点 ${nodes.findIndex((n) => n.id === sel.id) + 1}</div>
                 <label>名字</label><input data-vd-f="name" value="${esc(sel.name ?? '')}" />
                 <label>谁来办</label>
                 <div data-vd-pick-mount></div>
                 <label>这一步要干什么</label>
                 ${/* 高度 80 → 150（2026-10-19 用户截图要求）：这段是**干活的要求**，
                       正常要写五六行（目标/边界/验收/产出），80px 只露三行，写的时候一大半在框外面，
                       得一边写一边滚。150 约八行，一个节点写清楚不用滚。
                       仍然可拖（resize 是 textarea 默认行为，没关掉）。 */ ''}
                 <textarea data-vd-f="detail" style="height:150px">${esc(sel.detail ?? '')}</textarea>
                 <label>不通过时去哪</label>
                 <select data-vd-f="reject">${rejectOpts(sel.reject)}</select>
                 <!-- 流转开关：默认"做完自动往下走"；打开则停在这儿等人表态 -->
                 <label class="vd-switch">
                   <input type="checkbox" id="vdManual" ${sel.manual ? 'checked' : ''} />
                   <span>需要人工确认完成</span>
                 </label>
                 ${/* 描述就一句（用户给的原文）。不再补"当前：…"—— 开关勾没勾本身就说明了状态。 */ ''}
                 <div class="vd-switch-hint">多用于人机多轮交互，由人工控制是否完成该节点任务。</div>
                 <div class="dz-panel-acts">
                   <button class="danger" data-vd-del="${esc(sel.id)}">删掉这个节点</button>
                 </div>`
              : '<div class="wip">点左边一个节点开始改</div>'
          }
        </div>
      </div>
      <div class="hint" style="margin-top:10px">改动只影响以后新起的流程；在跑的实例用的是起跑那一刻拷下来的节点。</div>
    </div>`;
  S.view = 'flow';
  showView('flow');
  wireDesigner();
  scheduleDraftSave();
}



export function wireDesigner() {
  const view = $('flowView');

  /* 流程名：**看上去是标题、点上去就能改**（输入框的边框/底色在 #dzName 里抹掉了）。
     宽度跟着字数走 —— 它是个标题，不该有一块固定宽的透明点击区伸到右边空白里。
     汉字约 1em 宽：最短 6em（够放 placeholder），最长 26em（再长就省略/滚动，别把页头顶爆）。 */
  const dz = view.querySelector('#dzName');
  if (dz) {
    const fitDz = () => {
      const n = Math.min(26, Math.max(6, [...(dz.value || dz.placeholder)].length + 1));
      dz.style.width = n + 'em';
    };
    dz.addEventListener('input', () => {
      fitDz();
      S.designerName = dz.value;
      scheduleDraftSave();
    });
    fitDz();
  }

  view.querySelectorAll('[data-vd-add]').forEach((el) => {
    el.onclick = () => {
      collectDesigner();
      addNodeAt(Number(el.dataset.vdAdd));
    };
  });
  view.querySelectorAll('[data-vd-node]').forEach((el) => {
    el.onclick = (e) => {
      if (e.target.closest('[data-vd-del]')) return;
      if (S.designerSel === el.dataset.vdNode) return;
      collectDesigner();
      S.designerSel = el.dataset.vdNode;
      paintDesigner();
    };
  });
  view.querySelectorAll('[data-vd-del]').forEach((el) => {
    el.onclick = async (e) => {
      e.stopPropagation();
      collectDesigner();
      await removeNode(el.dataset.vdDel);
    };
  });
  view.querySelectorAll('[data-vd-f]').forEach((el) => {
    el.addEventListener('input', () => {
      const n = nodeOf(S.designerSel);
      if (!n) return;
      n[el.dataset.vdF] = el.value;
      if (el.dataset.vdF === 'name') {
        const b = view.querySelector(`[data-vd-node="${n.id}"] b`);
        if (b) b.textContent = el.value || '(未命名)';
      }
      scheduleDraftSave();
    });
    el.addEventListener('change', () => {
      if (el.dataset.vdF === 'reject') paintDesigner(); // 卡片上的说明要跟着变
    });
  });
  // 流转开关：默认"做完自动往下走"，打开则停在这儿等人确认
  const manual = view.querySelector('#vdManual');
  if (manual) {
    manual.onchange = () => {
      const n = nodeOf(S.designerSel);
      if (!n) return;
      n.manual = manual.checked;
      scheduleDraftSave();
      paintDesigner(); // 下面那行说明要跟着变
    };
  }
  view.querySelector('[data-vd-toggle]')?.addEventListener('click', togglePanel);
  if (nodeOf(S.designerSel)) mountAssigneePicker(view, nodeOf(S.designerSel));
  view.querySelector('[data-dz-drop]')?.addEventListener('click', () => {
    clearDraft();
    S.designerRestored = false;
    openDesigner(S.designerId);
  });
  view.querySelector('[data-vd-publish]')?.addEventListener('click', async () => {
    collectDesigner();
    rewire();
    S.designerName = $('dzName')?.value ?? S.designerName;
    const on = !S.designerPublished;
    try {
      // 先存再发布 —— 否则发出去的是上一次的内容，最容易骗人
      await api('/api/workflows/templates/' + encodeURIComponent(S.designerId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: S.designerName, nodes: S.designerDraft, start: S.designerDraft[0]?.id ?? null }),
      });
      await api('/api/workflows/templates/' + encodeURIComponent(S.designerId) + '/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ on }),
      });
      clearDraft();
      S.designerRestored = false;
      await load(); // 工作台那批已发布流程要跟着变
      await openDesigner(S.designerId);
      hint(on ? '已发布 —— 去工作台点开就能起一条' : '已下架，工作台不再显示');
    } catch (e) {
      toast(e.message, 'error');
    }
  });
  view.querySelector('[data-vd-save]')?.addEventListener('click', async () => {
    collectDesigner();
    rewire(); // 顺序 → 连线，存之前翻译一次
    S.designerName = $('dzName')?.value ?? S.designerName;
    try {
      await api('/api/workflows/templates/' + encodeURIComponent(S.designerId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: S.designerName,
          nodes: S.designerDraft,
          start: S.designerDraft[0]?.id ?? null, // 起步点就是第一个，纵向顺序里它是自明的
        }),
      });
      clearDraft();
      S.designerRestored = false;
      S.designerOpen = null;
      await openWorkflows();
      toast('存好了。以后新起的流程用这份。');
    } catch (e) {
      toast(e.message, 'error'); // 存失败<b>不清草稿</b> —— 改动还在本地
    }
  });
}



/** 收起 / 展开右边的属性面板。不整块重画 —— 只切一个类，输入到一半也不会被打断 */
export function togglePanel() {
  S.dzPanelCollapsed = !S.dzPanelCollapsed;
  try { localStorage.setItem(PANEL_KEY, S.dzPanelCollapsed ? '1' : '0'); } catch { /* 写不了就算了 */ }
  $('dzBody')?.classList.toggle('collapsed', S.dzPanelCollapsed);
  const btn = $('flowView').querySelector('[data-vd-toggle]');
  if (btn) {
    btn.textContent = S.dzPanelCollapsed ? '«' : '»';
    btn.title = S.dzPanelCollapsed ? '展开属性面板' : '收起属性面板';
  }
}



/** 把面板里输入的值收回草稿（切换节点/插入/保存之前都要先收） */
export function collectDesigner() {
  const view = $('flowView');
  if (!view) return;
  const n = nodeOf(S.designerSel);
  if (n) {
    // 流转开关不是 data-vd-f：复选框要读 checked，读 value 只会拿到 "on"
    const m = view.querySelector('#vdManual');
    if (m) n.manual = m.checked;
    view.querySelectorAll('[data-vd-f]').forEach((el) => {
      n[el.dataset.vdF] = el.value;
    });
  }  const named = view.querySelector('#dzName');
  if (named) S.designerName = named.value;
}



/** 在第 index 个位置**插入**一个节点（0 = 插到最前面） */
export function addNodeAt(index) {
  const used = new Set((S.designerDraft ?? []).map((n) => n.id));
  let i = S.designerDraft.length + 1;
  while (used.has('n' + i)) i++;
  const node = { id: 'n' + i, name: '新节点 ' + i, detail: '', reject: '' };
  S.designerDraft.splice(Math.max(0, Math.min(index, S.designerDraft.length)), 0, node);
  rewire();
  S.designerSel = node.id;
  paintDesigner();
}



// async：确认框走应用内的 `confirmDo`（原生 confirm 是浏览器弹窗，用户要求不用）
export async function removeNode(id) {
  const n = nodeOf(id);
  if (!n) return;
  if (!(await confirmDo(`删掉「${n.name || id}」？`))) return;
  S.designerDraft = S.designerDraft.filter((x) => x.id !== id);
  // 别人驳回指向它的要清掉，否则存的时候报"指向不存在的节点"
  for (const x of S.designerDraft) if (x.reject === id) x.reject = '';
  rewire();
  S.designerSel = S.designerDraft[0]?.id ?? null;
  paintDesigner();
}
