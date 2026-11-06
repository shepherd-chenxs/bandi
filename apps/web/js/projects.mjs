/* projects.mjs —— 项目。
 * 2026-10-22 由 app.js（15537 行单文件）拆出，原生 ESM、无打包器；逻辑逐字搬运。 */
import { esc, mdRender, personLabel, runtimeLabel, savePlace, setRoute, toast } from './shell.mjs';
import { ICON_FOLDER, ICON_WB_BOARD, ICON_WB_CLOCK, ICON_WB_FLOW, api, createCombo, handleCopyPaths, post, personaAvatar, personaByName, renderMarkdown, smAvatar, wireDialogHead } from './ui.mjs';
import { setNav } from './state.mjs';
import { breadcrumb, headRow } from './connectors.mjs';
import { confirmDo, askText } from './machine.mjs';
import { detailSave, showView } from './contacts.mjs';
import { wbCard } from './workflows.mjs';
import { hint, openFlowRun, paintRun, setListTitle } from './flowpages.mjs';
import { attsHtmlOf, firstMeaningfulLine, isNarrowPh, mbOpenPicker, openConversation, openDetail, streamRun, timelineOf } from './chat.mjs';
// 运行进度卡：对话页那一套（阶段/步数/用时/卡住提醒/停止生成）搬进任务卡讨论区 —— 2026-10-29 用户："对话里的那一套搬过来用"
import { createProgressCard } from './run-progress-card.mjs';
import { fmtElapsed } from './run-progress.mjs';
import { $, S } from './core.mjs';



/* ---------------------------------------------------------------- 项目 */

/**
 * 工作台里的「自动化」—— **定时任务 + 工作流**（2026-10-26 用户拍板）。
 *
 * 为什么单开一组、不塞进「项目」：项目是"在哪儿干活"，定时任务是"到点谁去干活"，
 * 工作流是"活儿按什么顺序走" —— 三件事的共同点是**让活自己动起来**，混进项目宫格里
 * 人会以为是某个项目的附属品（定时任务其实可以不关联项目）。以后再加触发器、监控之类，
 * 也落这一组。
 *
 * 「工作流」这颗磁贴原先单列一组（组名叫「工作流」、卡名叫「流程编排」），用户 2026-10-26
 * 截图拍板：**卡名改「工作流」，并进自动化这一组** —— 少一段标题，多一个同类邻居。
 *
 * `schedulesOnly`（2026-11-06 手机端开放定时任务）：窄屏宫格只画「定时任务」一格 ——
 * 工作流设计器（画布拖节点）在窄屏没法用，仍是 PC 独有。调用方见 experts.mjs 的
 * renderWorkbenchGrid：手机形态的功能子集从"全都不给"放开到"给定时任务"这一格。
 */
export function workbenchAutoSection({ schedulesOnly = false } = {}) {
  return `
    <div class="wb-sec">自动化</div>
    <div class="wb-grid">
      ${wbCard('cron', ICON_WB_CLOCK, '定时任务', '到点自动做一件事：干什么、交给谁、多久一次', 'data-schedules')}
      ${schedulesOnly ? '' : wbCard('flow', ICON_WB_FLOW, '工作流', '画流程：节点、指派、发布', 'data-flow-design')}
    </div>`;
}



/**
 * 工作台里的「项目」入口 —— 点进去是项目列表，在那儿增删改查。
 *
 * 为什么要有项目：现在"在哪儿干活"只有 `personas.cwd` 一个字段，
 * 六个员工全指着同一个目录 —— 看着是对的，但一有第二个项目就会**安静地改错地方**。
 * 项目 = 给"在哪儿干活"起个名字、可复用、可写规矩的东西。
 * （以前这里那段话把"工作区"和"项目"当成两个词用 —— 其实是一个东西，现在统一叫项目。）
 *
 * 右边那个「任务看板」（2026-10-15）是**同一张看板，换个范围**：项目里看的是"这个项目的活"，
 * 这里看的是"所有的活"。所以它紧挨着「项目」放 —— 一个是"在哪儿干活"，一个是"都有什么活"。
 */
export function workbenchProjectSection() {
  /* 分组名后面**不再挂计数**（2026-10-19 去掉）：`.wb-sec` 是一行小标题，
     上面写"项目 2"会被读成"有 2 个项目"，而它其实说的是"这一格有 2 块磁贴" ——
     两个意思撞在一个数字上。宫格里的东西一眼数得清，不需要计数。 */
  return `
    <div class="wb-sec">项目</div>
    <div class="wb-grid">
      ${wbCard('proj', ICON_FOLDER, '项目', '名字、目录、规矩都在这儿管', 'data-projects')}
      ${wbCard('board', ICON_WB_BOARD, '任务看板', '所有项目的活，铺在同一张看板上', 'data-task-board')}
    </div>`;
}



/**
 * 项目列表（左栏那一列）。**只画左栏**，不碰右侧详情 —— 所以搜索时能只重画它，
 * 输入框不失焦（跟 renderFlowList / renderPluginMaster 一个路数）。
 *
 * 守卫跟别的左栏渲染一样：这一栏此刻不属于项目页就一个字都别画
 * （`#search` 的输入事件是**挂在全站共用元素上**的，离开这页不会自动摘）。
 */
export function renderProjectList() {
  if (S.nav !== 'plugins' || !S.projectList) return;
  const raw = String(S.filter ?? '').trim();
  const q = raw.toLowerCase();
  // 名字或目录命中都算（目录忽略大小写：Windows 路径本来就不分大小写）
  const rows = (S.projects ?? []).filter(
    (p) => !q || `${p.name ?? ''} ${p.root ?? ''}`.toLowerCase().includes(q),
  );
  const rowHtml = (p) => `<div class="item${p.id === S.projSel ? ' active' : ''}" data-proj-sel="${esc(p.id)}">
              <div class="who">
                <!-- 「内置」角标用通讯录同款 .b-inline 塞进 <b> 里 —— line1 是 space-between，
                     挂在外面会被推到行最右，看着像个时间戳（2026-10-20 收口）。 -->
                <div class="line1"><b>${esc(p.name)}${
                  p.builtIn ? '<i class="b-inline">内置</i>' : ''
                }</b></div>
                <div class="line2" title="AI 会在这个目录里干活">${esc(p.root)}</div>
              </div>
            </div>`;
  $('listBody').innerHTML = rows.length
    ? rows.map(rowHtml).join('')
    : // 「一个项目都没有」和「有，但没搜到」是两件事，文案别混：一个是去新建，一个是关键词不对
      (S.projects ?? []).length
      ? `<div class="empty" style="padding:36px 12px">没有匹配「${esc(raw)}」的项目<br /><span class="dim" style="font-size:12px">也可以试试搜工作目录</span></div>`
      : '<div class="empty" style="padding:36px 12px">还没有项目<br />点右上角 ＋ 新建一个</div>';
  // 左栏选谁，右边看谁（就地换详情，不整页跳）
  $('listBody').querySelectorAll('[data-proj-sel]').forEach((el) => {
    el.onclick = () => openProjectsPage(el.dataset.projSel).catch((e) => toast(e.message, 'error'));
  });
}

/**
 * 项目页：**两个区、中间一条分隔线**（2026-10-18，跟「服务器与密钥」那页同一套布局）：
 * 项目列表住**全局左栏**（跟消息/通讯录同一个位置，主区之间是 app 自带的那条竖分隔线），
 * 右侧主区是选中项目的详情（常驻编辑区 + 任务统计 + 三个动作）。
 * 「＋ 新建项目」也在左栏头上那颗 ＋ 上 —— 跟插件主从页一个路数。
 */
export async function openProjectsPage(selectId) {
  setRoute('projects');
  S.projects = (await api('/api/projects')).projects ?? [];
  const view = $('pluginView');
  view.classList.remove('kb-page'); // 详情按普通长页面滚，不套看板那套满屏布局
  S.projectList = true;             // 位置记忆：刷新回到项目列表
  S.projectId = null;
  S.boardAll = false;               // 离开全局面板（它跟项目列表/看板是三条路）
  savePlace();
  const sel = S.projects.find((x) => x.id === (selectId ?? S.projSel)) ?? S.projects[0] ?? null;
  S.projSel = sel?.id ?? null;

  // 左栏 = 项目列表（左栏让出来：从目录进项目页时它是收着的）。
  // ⚠️ 原来左栏最上面还有一条「‹ 工作台」（照消息页「‹ 返回消息」那套路数加的），
  // 2026-10-19 统一子页页头后撤掉了：**返回只留在页头最左边**。
  // 留着它等于同一件事两个地方能做，而且只有项目页有，别的子页没有 —— 这就是不统一。
  document.body.classList.remove('no-list');
  /* 左栏顶上**只写到二级**「工作台 › 项目」（2026-10-19 用户：「项目这个只要二级目录就可以了，
     不需要三级目录。因为右边的详情区有了」）：项目名就在右侧详情区的 p-head 里，
     面包屑再写一遍是同一件事说两遍；而且左栏列表里当前项目本来就高亮着。
     ⚠️ 右边再没有这一段了，所以项目改名时**不用**同步标题（名字只在详情里变）。 */
  setListTitle([{ label: '工作台', to: 'workbench' }, { label: '项目' }]);
  $('listAction').classList.remove('hidden');
  $('listAction').title = '新建项目';
  /*
   * 顶部搜索（2026-10-29，用户："这个页面也加个搜索"）：跟消息 / 工作流 / 插件主从页同一个框
   * （`#search` + `S.filter`），过滤只看**名字和目录** —— 项目最常被记住的就是这两样，
   * 目录还能粘一段路径进来找（"上次那个 C:\…\docs 的项目叫啥来着"）。
   *
   * 清词时机用 `S.projSearchFor` 记「上次是谁在用这个框」：点项目行会**再走一遍** openProjectsPage
   * （就地换详情），无条件清会把用户正打着的词吞掉。离开工作台那一栏时（setNav）和回宫格时
   * （openPlugins）把这个标记清掉，下次进来重新清一次上个栏目残留的关键词。
   */
  $('search').closest('.list-search')?.classList.remove('hidden');
  $('search').placeholder = '搜项目名 / 目录';
  if (S.projSearchFor !== 'projects') {
    S.projSearchFor = 'projects';
    if (S.filter) {
      S.filter = '';
      $('search').value = '';
    }
  }
  renderProjectList();

  /* 右页头**去掉了**（2026-10-19 用户：「面包屑应该是在左边的列表上，右边的不用」）：
     原来这里只有一段「工作台 › 项目 › 名字」，现在整段挪到了左栏顶上；右侧直接是详情，
     名字/目录/动作都在详情自己的 p-head 里，页头再写一遍纯属重复。
     （左栏顶上那条「‹ 工作台」也不加回来：面包屑的「工作台」段就是回宫格的入口。） */
  view.innerHTML = `
    <div class="detail-body" id="projDetail">${
      sel ? '<div class="dim">加载中…</div>' : '<div class="empty" style="padding:36px 12px">左边选一个项目</div>'
    }</div>`;
  S.view = 'plugin';
  showView('plugin');
  if (sel) await renderProjDetail(sel);
}



/* ------------------------------------------------------------ 项目档案 */
/**
 * **项目档案**（2026-10-23，用户：「研发面板要展示这项目是干什么的、什么时候开始结束、
 * 成员有哪些、项目经理是谁」；2026-10-23 v0.2 收回到**四项**：迭代版本数是软件研发专属概念，
 * 以仓库 `status.yaml` 为前提，按判据归研发面板，通用工作区不展示 —— 见 PRD v0.2 改动 2）。
 *
 * 摆的位置：tabs **上面**、常驻。2026-10-24 用户定的改动：「干什么」（summary）挪进
 * **基础信息** tab（原来「项目说明」的位置，那格是死字段已删）——这卡只剩项目经理 + 起止。
 *
 * 口径跟 PRD 一致：**读不到就说「未填写」**，不猜、不写空。两项分得清：
 *   · `未填写` —— 人没填；
 *   · `未填写（那个人已经不在了）` —— 填过，但那个员工被删了（服务端判，见 status.projectProfile）。
 * 开始时间没填时退回**建档时间**并标出处：两者可能差很远，混成一个数字等于骗人。
 */
function pjPersona(id) {
  return (S.personas ?? []).find((x) => x.id === id) ?? null;
}

/** 项目的成员 id 名单（库里的 JSON 坏了就当没填 —— 跟服务端 status.projectProfile 一个口径） */
function pjMembers(p) {
  try {
    const list = JSON.parse(p?.memberPersonaIds || '[]');
    return Array.isArray(list) ? list.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * 「项目成员」tab 里的一行（2026-10-24 设计稿 v1.0.1）：
 * 头像 + 姓名 + 岗位 pill + 忙闲点 + 运行时；整行可点、右侧「看详情」都进员工详情。
 *
 * 两种行分得清：
 *   · 正常：人还在员工表里 —— 可点；
 *   · 异常：填过、但那个员工已经被删了 —— 灰名「那个人已经不在了」，**整行不可点、没有「看详情」**
 *     （这不是"没配成员"，是"配的那个人没了"，两种意思不能混）。
 *
 * 运行时那格**只认 auto**（`runtimeLabel`）：rt-id / codex / claude 都是技术细节，不上列表 ——
 * 2026-10-23 已拍板的口径，别照设计稿抄回去。
 */
function memberRowHtml(id) {
  const who = pjPersona(id);
  if (!who) {
    return `<div class="mbr-row gone">
      <span class="avatar gone">×</span>
      <div class="mbr-main">
        <span class="mbr-name">那个人已经不在了</span>
        <span class="gone-tag">员工已删除 · 保留当时记录</span>
      </div>
    </div>`;
  }
  const rt = runtimeLabel(who);
  return `<div class="mbr-row" data-pj-open="${esc(who.id)}" title="进员工详情">
    ${personaAvatar(who)}
    <div class="mbr-main">
      <span class="mbr-name">${esc(who.name)}</span>
      <span class="pill role">${esc(String(who.role ?? '').split(' · ')[0].trim() || '—')}</span>
      <span class="dot${who.busy ? ' busy' : ''}" title="${who.busy ? '正在干活' : '现在闲着'}"></span>
      ${rt ? `<span class="pill mbr-runtime">${esc(rt)}</span>` : ''}
    </div>
    <button type="button" class="mbr-act">看详情 ›</button>
  </div>`;
}

/** 起止那行的说明：开始没填先说建档时间兜底，填了再看结束没填＝进行中（设计稿 v1.0.1 口径）。
 *  （2026-10-24：项目经理和起止从顶部档案卡搬进「基础信息」tab —— 档案卡整个撤掉。） */
function pjDatesNote(p) {
  const createdDay = String(p.createdAt ?? '').slice(0, 10);
  return !p.startedAt
    ? `开始时间未填，按建档时间 ${createdDay} 算`
    : p.endedAt
      ? ''
      : '结束日期没填＝进行中';
}



/* ------------------------------------------------ 自绘日历（项目起止日期，2026-10-24） */

const PJ_WEEK = ['一', '二', '三', '四', '五', '六', '日'];
let pjCal = null; // 开着的日历弹层：{ el, input, onDoc }

/** 日期按钮的文案：有值显示 YYYY/MM/DD；结束框没填且已经开始了 → 「进行中」（灰字） */
function pjDateLabel(v, isEnded) {
  if (v) return v.replaceAll('-', '/');
  const started = document.getElementById('pjStarted')?.value;
  return isEnded && started ? '进行中' : 'yyyy/mm/dd';
}

/** 按钮文案跟着真值走 —— 真输入框藏在按钮后面（hidden），只存值、发 input 事件给自动存 */
function paintPjDates() {
  const s = document.getElementById('pjStarted')?.value ?? '';
  const e = document.getElementById('pjEnded')?.value ?? '';
  const sb = document.getElementById('pjStartedBtn');
  const eb = document.getElementById('pjEndedBtn');
  if (sb) sb.textContent = pjDateLabel(s, false);
  if (eb) {
    const live = !!s && !e;
    eb.textContent = pjDateLabel(e, true);
    eb.classList.toggle('is-live', live);
  }
}

function closePjCal() {
  if (!pjCal) return;
  pjCal.el.remove();
  document.removeEventListener('mousedown', pjCal.onDoc, true);
  window.removeEventListener('scroll', closePjCal, true);
  window.removeEventListener('resize', closePjCal);
  pjCal = null;
}

/** 点日期按钮：弹一个**页面里的**日历（原生弹层在 WebView2 里是透明的，CSS 够不着） */
function openPjCal(btn, input) {
  closePjCal();
  const today = new Date();
  const init = input.value ? input.value.split('-').map(Number) : [today.getFullYear(), today.getMonth() + 1];
  let y = init[0];
  let m = init[1] - 1; // 月按 0 计
  const el = document.createElement('div');
  el.className = 'pj-cal';

  const set = (v) => {
    input.value = v;
    input.dispatchEvent(new Event('input', { bubbles: true })); // 自动存的监听挂在这个事件上
    paintPjDates();
    closePjCal();
  };
  const paint = () => {
    const lead = (new Date(y, m, 1).getDay() + 6) % 7;           // 周一开头
    const days = new Date(y, m + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push('<i></i>');
    for (let d = 1; d <= days; d++) {
      const iso = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      cells.push(`<button type="button" data-day="${iso}" class="${iso === input.value ? 'on' : ''}">${d}</button>`);
    }
    el.innerHTML = `
      <div class="pj-cal-head">
        <button type="button" class="pj-cal-nav" data-nav="-1" aria-label="上个月">‹</button>
        <b>${y}年${m + 1}月</b>
        <button type="button" class="pj-cal-nav" data-nav="1" aria-label="下个月">›</button>
      </div>
      <div class="pj-cal-grid">
        ${PJ_WEEK.map((w) => `<i class="pj-cal-w">${w}</i>`).join('')}${cells.join('')}
      </div>
      <div class="pj-cal-foot">
        <button type="button" data-act="clear">清除</button>
        <button type="button" data-act="today">今天</button>
      </div>`;
  };
  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-day], [data-nav], [data-act]');
    if (!t) return;
    if (t.dataset.day) return set(t.dataset.day);
    if (t.dataset.act === 'clear') return set('');
    if (t.dataset.act === 'today') {
      const d = new Date();
      return set(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    }
    m += Number(t.dataset.nav);
    if (m < 0) { m = 11; y -= 1; }
    if (m > 11) { m = 0; y += 1; }
    paint();
  });

  pjCal = {
    el, input,
    // 点外面 / 滚动 / 改窗口尺寸都收起（跟原生弹层同一套礼节）
    onDoc: (e) => { if (!el.contains(e.target) && !btn.contains(e.target)) closePjCal(); },
  };
  document.addEventListener('mousedown', pjCal.onDoc, true);
  window.addEventListener('scroll', closePjCal, true);
  window.addEventListener('resize', closePjCal);
  document.body.append(el);
  paint(); // 先画内容才有高度
  const r = btn.getBoundingClientRect();
  const h = el.offsetHeight || 330;
  // 默认朝下弹；下面放不下（或会被钳到贴底盖住自己那行）就**朝上弹**（2026-10-24 用户：往上一些）
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = r.top - h - 6;
  el.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 264)) + 'px';
  el.style.top = Math.max(8, top) + 'px';
}

/**
 * 右侧详情：
 * 顶部一行 = **固定导航条**（2026-10-27 用户："这个顶部改成同样导航风格"）——
 * 换成 `.detail-head.fixed-head`（同代码托管 / 远程连接的吸顶头：50px 定高 + --side 底 +
 * 底部分隔线），名字 + 内置 pill + 目录 pill 在左、保存回执 + 任务/删除在右。
 * 原来是员工详情那套两行的 .p-head（2026-10-18 骨架），不吸顶。
 * 下面 tabs 两页：**基础信息**（名称/目录/附加目录/说明 + 任务统计）、**项目规章**（＝宪法）。
 * 字段仍是常驻输入区（没有"点编辑"那步）；tabs 一次渲染、切显隐 ——
 * 在基础信息改了一半去规章再回来，改动还在（同员工详情页的做法）。
 */
export async function renderProjDetail(p) {
  const box = $('projDetail');
  if (!box) return;
  /*
   * 只取任务统计（/tasks）。**不再取 /api/status 的版本数**（2026-10-23 v0.2）：
   * 档案回到四项，版本数归研发面板；接口字段 `version_count` 本身保留，
   * 那是插件的数据源，后端不动。
   */
  let data = null;
  let err = '';
  try {
    data = await api(`/api/projects/${encodeURIComponent(p.id)}/tasks`);
  } catch (e) {
    err = e.message;
  }
  const extraText = (() => {
    try { return JSON.parse(p.extraRoots || '[]').join('\n'); } catch { return ''; }
  })();
  const stat = (label, n) => `<span class="kb-stat">${esc(label)} <b>${n ?? 0}</b></span>`;
  box.innerHTML = `
    <div class="detail-head head-row fixed-head">
      <div class="head-title">
        <b>${esc(p.name)}${p.builtIn ? '<span class="pill role">内置</span>' : ''}</b>
        <!-- 目录 pill 整颗可点：点一下复制路径（设计稿 v1.0.1）。
             data-label 记着原始路径 —— 回执把字换成「已复制」之后，2 秒还得能换回来。 -->
        <button type="button" class="pill copy-pill" data-path="${esc(p.root ?? '')}"
                data-label="${esc(p.root ?? '')}" title="点击复制路径">${esc(p.root ?? '')}</button>
      </div>
      <div class="head-actions">
        <!-- 保存状态：改了就自动存，这里是唯一的回执（跟员工详情同一条 .save-state 样式）。
             原来这儿是一颗「保存」按钮 —— 四个字段都要点一次，忘了点就白改。
             ⚠️ 它**不占位**：宽度 0 + 往左溢出，所以"改成已保存"时不推按钮；
                 靠 text-align:right 让它从按钮左边往回长，永远不会被右边界截掉。
                 （样式在 style.css 的 .pj-save） -->
        <span class="save-state pj-save" id="pjSaveState"></span>
        <!-- 2026-10-27 用户："任务和删除按钮改成这种风格" —— 导航条里统一用
             .mini.auto 描边钮（同代码托管的 建 PR / 移除），不再用蓝底/红底大按钮 -->
        <button class="mini auto" id="pjTasks">任务</button>
        ${p.builtIn ? '' : '<button class="mini auto" id="pjDel">删除</button>'}
      </div>
    </div>

    <!-- 任务统计挪到页头正下方（2026-10-24 用户：把任务标签提上去）—— 基础信息 tab 里不再放 -->
    ${err
      ? `<div class="dim" style="margin-top:14px">任务统计取不到：${esc(err)}</div>`
      : `<div class="kb-stats">
          ${stat('任务共', data?.total)}
          ${stat('待验收', data?.waiting_count)}
          ${stat('已阻塞', data?.blocked_count)}
          ${stat('失败', data?.failed_count)}
          ${stat('流程实例', data?.flow_count)}
          ${stat('聊天派活', data?.chat_count)}
        </div>`}

    <div class="tabs">
      <button class="tab on" data-tab="basics">基础信息</button>
      <button class="tab" data-tab="members">项目成员<span class="tab-n" id="pjMemberCount">${pjMembers(p).length}</span></button>
      <button class="tab" data-tab="rules">项目规章</button>
    </div>
    <section class="tab-panel" data-panel="basics">
      <div class="group">
        <div class="form-row">
          <div class="row-label">项目名称</div>
          <div>
            <input id="pjName" value="${esc(p.name ?? '')}" placeholder="例如：班底" />
            <!-- （2026-10-20 用户："这些文案去掉"）原「改了自动保存，不用点按钮。」删 -->
          </div>
        </div>
        <div class="form-row">
          <div class="row-label">工作目录</div>
          <div>
            <div class="row-with-btn">
              <input id="pjRoot" value="${esc(p.root ?? '')}" placeholder="例如：E:\\02CodeSpace\\bandi" />
              <button type="button" id="pjPick" title="选一个本机目录（AI 会在这里干活）">选择</button>
            </div>
            <!-- （2026-10-20 用户："这些文案去掉"）原「AI 就在这个目录里干活。」删 -->
          </div>
        </div>
        <div class="form-row top">
          <div class="row-label">附加目录</div>
          <div>
            <textarea id="pjExtra" style="height:56px" placeholder="一行一个路径，例如 E:\\shared\\docs">${esc(extraText)}</textarea>
            <div class="counter">一行一个，可留空 —— AI 还可以读写的其他目录。</div>
          </div>
        </div>
        <div class="form-row top">
          <div class="row-label">项目简介</div>
          <div>
            <textarea id="pjSummary" style="height:56px" placeholder="一句话说清这个项目是做什么的">${esc(p.summary ?? '')}</textarea>
          </div>
        </div>
        <div class="form-row">
          <div class="row-label">项目负责人</div>
          <div id="pjPmMount"></div>
        </div>
        <div class="form-row">
          <div class="row-label">开始 / 结束</div>
          <div class="pj-dates">
            <!-- 自绘日历（2026-10-24）：原生 <input type=date> 的弹层是浏览器自己画的窗口，
                 页面 CSS 够不着，桌面壳的 WebView2 把它画成了透明（用户截图：日历底下能看见表单）。
                 改成：真输入框藏起来只存值，按钮显示日期、点开**页面里的**日历弹层（见 openPjCal）。 -->
            <span class="pj-date-field">
              <button type="button" class="pj-date-btn" id="pjStartedBtn" title="项目开始日期；不填就按建档时间算"></button>
              <input type="date" id="pjStarted" value="${esc(p.startedAt ?? '')}" hidden />
            </span>
            <span class="pj-dates-sep">至</span>
            <span class="pj-date-field">
              <button type="button" class="pj-date-btn" id="pjEndedBtn" title="结束日期；没填就当作还在进行"></button>
              <input type="date" id="pjEnded" value="${esc(p.endedAt ?? '')}" hidden />
            </span>
            ${pjDatesNote(p) ? `<span class="pj-dates-note">${esc(pjDatesNote(p))}</span>` : ''}
          </div>
        </div>
      </div>

      <div class="kb-tip" style="margin-top:10px">点右上角「任务」进这个项目的看板：流程的每次办理和聊天派活都在那儿，卡片能拖、能点进源头。</div>
    </section>

    <section class="tab-panel" data-panel="members" hidden>
      <div class="group pj-members">
        <div class="pj-members-head">
          <span class="pj-members-title">成员<span class="cnt" id="pjMemberCnt"></span></span>
          <!-- 「＋ 添加成员」（2026-10-24）：点开**弹窗**选人 —— 可搜索、可勾选多人、统一确认。
               原来是 createCombo 下拉（选一个加一个，手一抖就多加了人还没法反悔）。 -->
          <button type="button" class="pj-members-add" id="pjMemberAdd">＋ 添加成员</button>
        </div>
        <div id="pjMemberRows"></div>
      </div>
    </section>

    <section class="tab-panel" data-panel="rules" hidden>
      <div class="group">
        <div class="form-row top">
          <div class="row-label">宪法（本项目特有的硬约束）</div>
          <div>
            <!-- 预览/编辑（2026-10-24）：照「职责与身份设定」那套 —— 规章是 markdown，写少读多，默认预览；
                 预览渲染的是 textarea 现值（当前草稿），切来切去不丢字。自增高：多高内容多高框。 -->
            <div class="instr-wrap">
              <div class="instr-head">
                <div class="counter" id="pjConstCount"></div>
                <div class="seg seg-sm" id="pjConstSeg">
                  <button type="button" data-m="view" class="on">预览</button>
                  <button type="button" data-m="edit">编辑</button>
                </div>
              </div>
              <div id="pjConstView" class="md-view"></div>
              <textarea id="projConstInput" hidden placeholder="只写本项目特有的（共通规矩契约已经管了）：&#10;例如：零依赖，不许引入 npm 包；端口固定 18787；改 store.mjs 的 SQL 必须先问人">${esc(p.constitution ?? '')}</textarea>
            </div>
            <div class="counter">派活时会全文带给 AI，并注明「只许加码，与契约冲突以契约为准」。</div>
          </div>
        </div>
      </div>
    </section>`;

  // 标签：一次渲染、切显隐 —— 不重建 DOM，所以在「基础信息」改了一半去「规章」再回来，改动还在
  // （切之前先 flush：刚敲完就切走，防抖那 700ms 不该把改动吞掉）
  const tabs = box.querySelectorAll('[data-tab]');
  const panels = box.querySelectorAll('[data-panel]');
  const showTab = (key) => {
    tabs.forEach((t) => t.classList.toggle('on', t.dataset.tab === key));
    panels.forEach((sec) => { sec.hidden = sec.dataset.panel !== key; });
  };
  tabs.forEach((t) => { t.onclick = () => { pjSaveNow(); showTab(t.dataset.tab); }; });
  showTab('basics');

  $('pjPick').onclick = () => pickProjectDir('pjPick', 'pjRoot');
  handleCopyPaths(box); // 目录 pill 可点复制（整颗按钮，见 ui.mjs 的 handleCopyPaths）

  /* ---------------- 自动保存（2026-10-19 用户要求：去掉「保存」按钮） ----------------
   * 分寸跟员工详情、任务卡那条一样：
   *   · 输入框防抖 700ms；失焦立刻存；切标签 / 离开页面先 flush。
   *   · **不重画整页**：重画会丢焦点、把标签弹回"基础信息"；
   *     只有名字变了才同步左栏那一行（那是另一个容器，跟焦点无关）。
   *   · 名字 / 目录空着不提交（服务端会拒）：状态直接写清楚，人知道自己少填了什么。
   *   · 保存中又来改动 → 存完补一次（串行；同时打两个 PUT 会互相覆盖）。 */
  const pjState = $('pjSaveState');
  const setPjState = (text, kind = '') => {
    if (!pjState) return;
    pjState.textContent = text;
    pjState.className = 'save-state' + (kind ? ' ' + kind : '');
  };
  /* 档案那几格（简介 / 项目经理 / 成员 / 起止）也是**改了自动存** —— 跟名字目录同一张单。
   * 项目经理和成员是下拉选的，当前值记在 `pjPeople` 里（下拉本身不知道"清空"这个状态：
   * 空串在 createCombo 里是一个普通条目，取值还是得我们自己记一份）。 */
  let pjPeople = {
    pm: p.pmPersonaId || '',
    members: pjMembers(p),
  };
  const collect = () => ({
    name: $('pjName').value.trim(),
    root: $('pjRoot').value.trim(),
    extraRoots: $('pjExtra').value.split('\n').map((s) => s.trim()).filter(Boolean),
    constitution: $('projConstInput').value.trim(),
    summary: $('pjSummary').value.trim(),
    pmPersonaId: pjPeople.pm,
    memberPersonaIds: pjPeople.members,
    // `type=date` 的值本身就是 YYYY-MM-DD；没选是空串 → 服务端清掉
    startedAt: $('pjStarted').value,
    endedAt: $('pjEnded').value,
  });
  let lastSaved = JSON.stringify(collect());
  let pjTimer = null;
  let pjSaving = false;
  let pjQueued = false;

  const pjSaveNow = async ({ keepalive = false } = {}) => {
    if (pjTimer) { clearTimeout(pjTimer); pjTimer = null; }
    if (!box.isConnected) return false; // 页面已经换了，别再往旧项目上写
    const payload = collect();
    if (!payload.name) { setPjState('名字不能空 · 未保存', 'bad'); return false; }
    if (!payload.root) { setPjState('工作目录不能空 · 未保存', 'bad'); return false; }
    const json = JSON.stringify(payload);
    if (json === lastSaved) { setPjState(''); return true; }
    if (pjSaving) { pjQueued = true; return false; }
    pjSaving = true;
    setPjState('保存中…', 'wait');
    try {
      const d = await api('/api/projects/' + encodeURIComponent(p.id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: json,
        ...(keepalive ? { keepalive: true } : {}),
      });
      lastSaved = JSON.stringify(payload);
      // 服务端会归一（比如目录去尾斜杠）：把返回值写回内存，左栏和下次进入都用它
      const saved = d?.project;
      if (saved) {
        const i = (S.projects ?? []).findIndex((x) => x.id === saved.id);
        if (i >= 0) S.projects[i] = { ...S.projects[i], ...saved };
      }
      // 名字 / 目录改了才动左栏那一行 —— 那是另一个容器，重画它不影响输入框焦点
      const items = $('listBody')?.querySelectorAll('[data-proj-sel]') ?? [];
      items.forEach((el) => {
        if (el.dataset.projSel !== p.id) return;
        const b = el.querySelector('.line1 b');
        const sub = el.querySelector('.line2');
        if (b) b.textContent = payload.name;
        if (sub) sub.textContent = payload.root;
      });
      /* 改名同步的是**详情区自己**（固定导航条的标题 / 目录 pill），不碰左栏标题 ——
         左栏面包屑只到「工作台 › 项目」二级，项目名不写在里面（见 openProjectsPage）。
         项目头像 2026-10-19 已按用户要求去掉（.avatar.proj 没有宿主了），这里不用再同步它。 */
      const paintName = (name) => {
        const b = box.querySelector('.fixed-head .head-title > b');
        if (b) {
          b.firstChild.nodeType === 3
            ? (b.firstChild.nodeValue = name)
            : b.insertBefore(document.createTextNode(name), b.firstChild);
        }
        // 目录 pill 不只改字：data-path / data-label 也得跟着走，否则复制的是旧路径、还原也会还原成旧值
        const rootPill = box.querySelector('.fixed-head .copy-pill');
        if (rootPill) {
          const root = $('pjRoot').value.trim();
          rootPill.textContent = root;
          rootPill.dataset.path = root;
          rootPill.dataset.label = root;
        }
      };
      paintName(payload.name);
      setPjState(''); // 存成功不出声（2026-10-24 用户："已保存"提示不要了）—— 保存失败才说话
      return true;
    } catch (e) {
      setPjState('保存失败：' + (e?.message ?? '服务异常'), 'bad');
      console.error('[班底] 项目自动保存失败', e?.detail ?? e);
      return false;
    } finally {
      pjSaving = false;
      if (pjQueued) { pjQueued = false; pjSaveNow(); }
    }
  };
  const schedulePjSave = (ms = 700) => {
    setPjState('未保存…', 'wait');
    if (pjTimer) clearTimeout(pjTimer);
    pjTimer = setTimeout(() => { pjTimer = null; pjSaveNow(); }, ms);
  };
  // 离开这一页（切标签页 / 回列表 / 关窗口）前兜底存一次 —— 走的是全局那条 flush 口子
  const stopFlush = () => { detailSave.flush = null; };
  detailSave.flush = (opts) => { pjSaveNow(opts); };

  for (const id of ['pjName', 'pjRoot', 'pjExtra', 'projConstInput', 'pjSummary', 'pjStarted', 'pjEnded']) {
    $(id)?.addEventListener('input', () => schedulePjSave(700));
    $(id)?.addEventListener('blur', () => pjSaveNow());
  }

  /* 项目规章 预览/编辑（2026-10-24）：照「职责与身份设定」那套 —— markdown 写少读多，默认预览。
     预览渲染的是 textarea **现值**（当前草稿），切来切去不丢字，也不存在"预览回滚"；
     切回预览顺手 pjSaveNow 一次，给自动保存兜底。自增高：多高内容多高框，滚动只留外层页面。 */
  const pjConstEl = $('projConstInput');
  const pjConstView = $('pjConstView');
  let pjConstMode = 'view';
  const pjConstFit = () => {
    if (pjConstEl.hidden) return;
    pjConstEl.style.height = 'auto';
    pjConstEl.style.height = `${pjConstEl.scrollHeight}px`;
  };
  const pjConstSyncCount = () => { $('pjConstCount').textContent = `${pjConstEl.value.trim().length} 字`; };
  const pjConstRenderView = () => {
    const val = pjConstEl.value;
    pjConstView.innerHTML = val.trim()
      ? mdRender(val)
      : '<div class="md-empty">还没写。写本项目特有的硬约束 —— 共通规矩契约已经管了。<button type="button" class="linkish" data-pj-const-edit>写一段</button></div>';
  };
  const pjConstSetMode = (m) => {
    if (m === pjConstMode) return;
    pjConstMode = m;
    if (m === 'view') {
      pjConstRenderView();
      pjConstEl.hidden = true;
      pjConstView.hidden = false;
      pjSaveNow?.(); // 切回预览兜一次保存
    } else {
      pjConstView.hidden = true;
      pjConstEl.hidden = false;
      pjConstFit();
      pjConstEl.focus();
    }
    $('pjConstSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
  };
  $('pjConstSeg')?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-m]');
    if (b) pjConstSetMode(b.dataset.m);
  });
  pjConstView.addEventListener('click', (e) => {
    if (e.target.closest('[data-pj-const-edit]')) pjConstSetMode('edit');
  });
  pjConstEl.addEventListener('input', () => { pjConstSyncCount(); pjConstFit(); });
  pjConstRenderView();
  pjConstSyncCount();

  /* 项目经理：**从项目成员里选**（2026-10-24 用户定的口径）—— 全站公共的可搜索下拉。
     成员加了人要重建下拉（createCombo 是一次性挂载），所以包成 paintPmCombo：
     渲染时调一次，「添加成员」确认后再调一次。
     选完**立刻存**（下拉不是打字，没有"打了一半"的中间态，不必等防抖）。 */
  const paintPmCombo = () => {
    const mount = $('pjPmMount');
    if (!mount) return;
    mount.innerHTML = '';
    // 读**活数据** pjPeople.members，别读渲染时的快照 p —— 加成员后要重建下拉，
    // 快照里还是旧名单，新加的人就"看不到"（2026-10-24 用户踩过：加了喜儿，下拉里没有）
    const memberIds = pjPeople.members;
    const pmList = [
      { id: '', label: '不设' },
      ...(S.personas ?? []).filter((x) => memberIds.includes(x.id)).map((x) => ({ id: x.id, label: personLabel(x) })),
    ];
    // 兜底：现任项目经理不在成员里（老数据）也让他显示出来，别把现任抹成"未填写"
    if (pjPeople.pm && !pmList.some((x) => x.id === pjPeople.pm)) {
      const cur = (S.personas ?? []).find((x) => x.id === pjPeople.pm);
      if (cur) pmList.push({ id: cur.id, label: personLabel(cur) });
    }
    createCombo({
      mount,
      items: pmList,
      value: pjPeople.pm,
      search: true,
      placeholder: '搜数字员工…',
      empty: '没有匹配的人',
      /* 按钮上不写「不设」写「未填写」：清单里那个「不设」是一颗**动作**（点了等于清掉），
         按钮上要显示的是**现状**（现在没有项目经理）。跟 PRD「读不到就写未填写」同口径。
         （光给 `blank` 不管用 —— 清单里有一项 id 是空串，组件会拿它的 label 当按钮文案。） */
      buttonText: (id) => (id ? pmList.find((x) => x.id === id)?.label ?? '未填写（那个人已经不在了）' : '未填写'),
      onChange: (id) => {
        pjPeople.pm = id ?? '';
        schedulePjSave(0);
      },
    });
  };
  paintPmCombo();

  /* 成员（2026-10-24 设计稿 v1.0.1）：从档案那排 chip 改成「项目成员」tab 里一行一个人。
   * 加人走**弹窗**（openAddMembersDialog）：可搜索、可勾选多人、统一确认。
   * 点行 / 「看详情」= 进员工详情（`openDetail`），**不做就地展开**。
   * 重画只换这两块，不重画整页（重画会丢焦点、把标签弹回基础信息）。 */
  const paintMemberRows = () => {
    const host = $('pjMemberRows');
    if (!host) return;
    host.innerHTML = pjPeople.members.length
      ? pjPeople.members.map(memberRowHtml).join('')
      : `<div class="pj-members-empty">
           <div class="big">还没有成员</div>
           <div class="sub">点右上「＋ 添加成员」，从员工里挑人加进来</div>
         </div>`;
    // 只有"人还在"的行带 data-pj-open；已删的那行压根没有这个属性 → 整行不可点
    host.querySelectorAll('[data-pj-open]').forEach((el) => {
      el.onclick = () => openDetail(el.dataset.pjOpen).catch((e) => toast(e.message, 'error'));
    });
    const cnt = $('pjMemberCnt');
    if (cnt) cnt.textContent = `${pjPeople.members.length} 人`;
    const tabN = $('pjMemberCount');
    if (tabN) tabN.textContent = String(pjPeople.members.length);
  };

  /**
   * 「添加成员」弹窗（2026-10-24）：搜索 → 勾选多人 → 「添加」统一入队。
   * 行的样式与交互照**新建项目群**那张弹窗（.members/.member 勾选列表，2026-10-24 用户点名）——
   * 同一个产品里两种选人长相，人会觉得是两套系统。
   * 候选只列**还不在成员里**的人（跟「拉人进群」一个路数：列出来也点不动，不如不列）。
   * 确认才落库 —— 勾错了点「取消」就完了，选人阶段零成本。
   */
  const openAddMembersDialog = () => {
    const candidates = (S.personas ?? []).filter((x) => !pjPeople.members.includes(x.id));
    const picked = new Set();
    const dlg = document.createElement('dialog');
    dlg.className = 'pj-add-dlg';
    dlg.innerHTML = `
      <form method="dialog">
        <b>添加成员</b>
        <label>从员工里挑（可多选）</label>
        <input class="pj-add-search" placeholder="搜数字员工…" />
        <div class="members pj-add-members"></div>
        <div class="dlg-actions">
          <span class="pj-add-count"></span>
          <button type="button" class="pj-add-cancel">取消</button>
          <button class="primary pj-add-ok" disabled>添加</button>
        </div>
      </form>`;
    document.body.append(dlg);
    wireDialogHead(dlg.querySelector('form'));
    const list = dlg.querySelector('.pj-add-members');
    const search = dlg.querySelector('.pj-add-search');
    const count = dlg.querySelector('.pj-add-count');
    const ok = dlg.querySelector('.pj-add-ok');

    const sync = () => {
      count.textContent = `已选 ${picked.size} 人`;
      ok.disabled = !picked.size;
    };
    const paint = () => {
      const q = (search.value || '').trim().toLowerCase();
      const hit = candidates.filter((x) => !q || `${x.name}${x.role ?? ''}`.toLowerCase().includes(q));
      list.innerHTML = hit.length
        ? hit.map((x) => `
            <label class="member">
              <input type="checkbox" value="${esc(x.id)}" ${picked.has(x.id) ? 'checked' : ''} />
              <span>${esc(x.name)}</span>
              <em>${esc(String(x.role ?? '').split(' · ')[0].trim() || '—')}</em>
            </label>`).join('')
        : `<div class="pj-add-empty">${candidates.length ? '没有匹配的人' : '没有可以加的人 —— 员工都在成员里了'}</div>`;
    };
    list.addEventListener('change', (e) => {
      const input = e.target.closest('input[type="checkbox"]');
      if (!input) return;
      if (input.checked) picked.add(input.value); else picked.delete(input.value);
      sync();
    });
    search.addEventListener('input', paint);
    paint();
    sync();
    dlg.querySelector('.pj-add-cancel').onclick = () => dlg.close();
    ok.onclick = () => {
      for (const id of picked) if (!pjPeople.members.includes(id)) pjPeople.members.push(id);
      paintMemberRows();
      paintPmCombo(); // 项目经理从成员里选 —— 成员变了，下拉跟着收敛
      setPjState('未保存…', 'wait');
      schedulePjSave(0); // 成员在档案单里，走同一条自动保存链路
    }; // 提交按钮自己会关掉 method="dialog" 的弹窗，不用再调 dlg.close()
    dlg.addEventListener('close', () => dlg.remove());
    dlg.showModal();
    setTimeout(() => search.focus(), 30);
  };
  $('pjMemberAdd')?.addEventListener('click', openAddMembersDialog);
  paintMemberRows();

  // 起止日期：按钮文案对齐真值 + 点开自绘日历（见 openPjCal）
  paintPjDates();
  for (const [btnId, inpId] of [['pjStartedBtn', 'pjStarted'], ['pjEndedBtn', 'pjEnded']]) {
    $(btnId)?.addEventListener('click', () => {
      if (pjCal?.input?.id === inpId) return closePjCal(); // 再点一下 = 收起
      openPjCal($(btnId), $(inpId));
    });
  }

  $('pjTasks').addEventListener('click', async () => {
    // 先落盘再走：不然刚改的目录/名字带不进看板（看板是另一个页面）
    await pjSaveNow();
    stopFlush();
    openProjectDetail(p.id).catch((e) => toast(e.message, 'error'));
  });
  $('pjDel')?.addEventListener('click', async () => {
    if (!(await confirmDo(`删掉项目「${p.name}」？\n\n绑在它上面的会话会自动解绑（回到员工默认工作目录），会话本身不删。`))) return;
    stopFlush();
    try {
      await api('/api/projects/' + encodeURIComponent(p.id), { method: 'DELETE' });
      S.projSel = null;
      await openProjectsPage();
    } catch (e) {
      toast(e.message, 'error');
    }
  });
}



/**
 * 项目详情：**平台的一等功能**（项目 → 任务），不是插件。
 *
 * 只负责路由 + 位置记忆 + "项目不在了就回列表"；看板的渲染与接线在
 * `openBoardPage` 里 —— 跟全局任务看板共用同一份（2026-10-19 重构）。
 */
export async function openProjectDetail(id) {
  setRoute('project', { id });
  const view = $('pluginView');
  view.classList.add('kb-page'); // 这一页要满屏（见 style.css 的 #pluginView.kb-page）
  // 看板是满屏页，左栏收掉 —— 可能是从项目列表（左栏正放着项目清单）进来的
  document.body.classList.add('no-list');
  S.projectId = id;              // 位置记忆：刷新回到这个项目的看板
  S.projectList = false;
  S.boardAll = false;            // 这一页是"一个项目"的看板，不是全局面板
  S.plugin = null;               // 项目看板不是插件，别让插件那条路抢走位置
  savePlace();
  const p = (S.projects ?? []).find((x) => x.id === id) ?? null;
  if (!p) {
    // 项目列表可能是旧的（别处删了这个项目）—— 回列表，不在这儿瞎猜
    await openProjectsPage();
    return;
  }

  await openBoardPage({ project: p });
}



/**
 * **看板页的共用壳**（2026-10-19 重构）：
 *
 * 项目看板与全局看板本来是两份几乎一样的代码（页头、列、卡片、拖拽、筛选、接线全同），
 * 只差四件事，现在收敛成一个 `project` 参数：
 *   · 数据源：全局 `/api/tasks`（还顺带取项目清单，建卡弹窗要按它列项目）；项目 `/api/projects/:id/tasks`
 *   · 面包屑：全局「工作台 › 任务看板」；项目「项目 › 项目名」
 *   · 刷新回调：各自回自己那一页
 *   · 建卡要不要选项目：`wire.taskProject` 返回当前项目（全局返回 null = 弹窗里选）
 *
 * 两个入口（`openProjectDetail` / `openTaskBoard`）只负责"路由 + 状态标记 + 取到项目行"，
 * 剩下的全在这儿 —— 以后改看板只改一处，不会再出现"改了项目看板忘了全局"。
 */
export async function openBoardPage({ project = null } = {}) {
  const view = $('pluginView');
  const isAll = !project;

  let data = null;
  let err = '';
  if (isAll) {
    // 项目清单与看板数据一起取：少一趟来回，也让"刷新后回到看板"更不容易跟宫格渲染抢
    const [projRes, boardRes] = await Promise.allSettled([api('/api/projects'), api('/api/tasks')]);
    if (projRes.status === 'fulfilled') S.projects = projRes.value.projects ?? [];
    if (boardRes.status === 'fulfilled') data = boardRes.value;
    else err = boardRes.reason?.message ?? String(boardRes.reason);
  } else {
    try {
      data = await api(`/api/projects/${encodeURIComponent(project.id)}/tasks`);
    } catch (e) {
      err = e.message;
    }
  }

  /*
   * 窄屏分支（2026-11 用户定案）：手机上看不了任务看板 —— 多列横排 + 拖拽在窄屏没法用。
   * 窄屏（body.mb-narrow，js/mobile.mjs 维护）直接渲染成「状态 tab + 列表」，
   * **不做 web 端形态切换**；桌面（>900px）一行不动。fetch 在上面已经共用完，
   * 这里只分渲染 —— 与员工详情 renderDetailMobile 同一模式。
   *
   * ⚠️ 判据里**没有** `&& !err`（2026-11-05 二版修掉）：带上它，取数失败就掉进桌面分支，
   * 手机上一屏桌面看板 —— 错误态也得是窄屏的模样（顶栏还在 + 一条「重试」）。
   */
  if (document.body.classList.contains('mb-narrow')) {
    renderBoardMobile(view, data, { project, isAll, err });
    return;
  }

  view.innerHTML = `
    ${headRow(isAll
      ? breadcrumb([{ label: '工作台', to: 'workbench' }, { label: '任务看板' }])
      : breadcrumb([
          { label: '工作台', to: 'workbench' },
          { label: '项目', to: 'projects' },
          { label: project.name, to: 'projects', arg: project.id },
          { label: '任务看板' },
        ]),
      `${
      err ? '' : kbFilterBar(data) + kbColsSettingHtml(data) + kbPrRefreshHtml(data)
    }<button data-kb-refresh>刷新</button>`)}
    <div class="detail-body run-wrap">
      ${
        err
          ? `<div class="empty" style="padding:24px 4px">任务取不到：${esc(err)}</div>`
          : `<div class="kb-wrap">
              <div class="kb" id="kbCols">
                ${kbColsHtml(data)}
              </div>
            </div>`
      }
    </div>`;

  S.view = 'plugin';
  showView('plugin');
  // 页头不放开返回按钮（统一去掉）：回到别处靠左栏点那一行
  view.querySelector('[data-kb-refresh]')?.addEventListener('click', () => {
    (isAll ? openTaskBoard() : openProjectDetail(project.id)).catch((e) => toast(e.message, 'error'));
  });
  // 看板那套接线（卡片点进去、手工卡拖动/删除、列头「＋」建卡）两个入口共用
  S.kbLast = {
    data,
    wire: {
      refresh: () => (isAll ? openTaskBoard() : openProjectDetail(project.id)),
      // 项目的看板：建卡不用选项目；全局：null = 弹窗里选
      taskProject: () => project,
    },
  };
  wireBoard(view, S.kbLast.wire);
  wireKbFilter();
  wireKbColsSetting();
}



/* ---------------------------------------------------------------- 看板 · 窄屏列表形态 */

/*
 * 页头上的三颗图标（返回 / ＋ / 刷新）走内联 SVG：与 .mb-backbar、#mbPicker 同一笔语汇
 * （22×22、stroke 2、round cap）。字符「‹ ＋ ↻」的粗细/基线随字体漂，同一个页头上
 * 三颗钮会看起来不是一套。
 */
/* 2026-11-06 起 export：定时任务列表的窄屏导航栏也用这两颗（同一笔语汇，不许各画一份） */
export const KB_ICON_BACK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
export const KB_ICON_PLUS =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const KB_ICON_REFRESH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 4.5V11h-6.5"/></svg>';
/* 讨论气泡（2026-11-05 建，2026-11-06 撤、同日用户要回，恢复）：跟底部 tab 的
   「会话」同一族轮廓，只是不封口、留一条尾巴（评论区那个符号）。 */
const KB_ICON_CHAT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 11.6c0 3.9-3.8 7.1-8.5 7.1a9.7 9.7 0 0 1-2.7-.4L4.5 20l1.1-3.4a6.7 6.7 0 0 1-2.1-4.9C3.5 7.7 7.3 4.5 12 4.5s8.5 3.2 8.5 7.1z"/></svg>';
/* 讨论抽屉的「放大 / 还原」（2026-11-05）：双箭头。图标说的是"点下去会怎样"——
   还没铺满时朝上（铺满整屏），已经铺满时朝下（回到默认的 78%）。 */
const TC_ICON_CHEVRONS_UP =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 11.5l5-5 5 5"/><path d="M7 18l5-5 5 5"/></svg>';
const TC_ICON_CHEVRONS_DOWN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 5.5l5 5 5-5"/><path d="M7 12.5l5 5 5-5"/></svg>';

/**
 * 看板的**窄屏形态**（2026-11 二版，视觉规格 v2）：手机上看不了多列横排 + 拖拽 ——
 * 窄屏（body.mb-narrow）直接渲染成「导航栏 + 状态胶囊条 + 一张分组卡的连续行」，
 * 桌面看板一行不动。数据抓取在 openBoardPage 已共用，这里只管渲染。
 *
 * 三处与一版的差别（都来自定稿规格，不是随手改）：
 *   · 导航栏三槽（‹ / 居中标题 / ＋）：进 App 不进网页 —— 面包屑去掉，
 *     ＋ 与刷新分家（刷新归列表数据，贴着筛选条右端，不占导航栏的对称位）；
 *   · 整个列表是**一张** inset grouped 卡（行间 hairline 内缩 16），不按状态分节 ——
 *     tab 与分节是同一维度，同时上就是两套导航并排；
 *   · 状态用行内 6px 圆点 + 状态词（色弱也读得到），不上色、无 pill、无左色条。
 *
 * 窄屏**不画**：拖拽、列头「＋」、列宽设置、筛选弹层（现有筛选层没为窄屏适配过）。
 * 所以这里也**不应用 S.kbFilter**：筛选层画不出来，还悄悄生效的话，列表会
 * "莫名少任务"且无处可清 —— 宁可全量，也别让看不见的筛选替人做主。
 *
 * `err` 有值时**也走这一支**（2026-11 修）：原来写成 `mb-narrow && !err`，
 * 取数失败就掉进桌面分支，手机上画出一屏桌面看板 —— 错误态也得是窄屏的模样。
 */
function renderBoardMobile(view, data, { project = null, isAll = false, err = '' } = {}) {
  S.view = 'plugin';
  showView('plugin');

  const pageTitle = isAll ? '任务看板' : (project?.name || '任务看板');
  view.innerHTML = `
    <div class="detail-head kb-l-head">
      <button type="button" class="kb-l-navbtn back" data-kb-back aria-label="${
        isAll ? '返回工作台' : '返回项目清单'}">${KB_ICON_BACK}</button>
      <h1 class="kb-l-navtitle">${esc(pageTitle)}</h1>
      <button type="button" class="kb-l-navbtn add" data-kb-new aria-label="新建任务">${KB_ICON_PLUS}</button>
    </div>
    <div class="detail-body">
      ${
        err
          ? ''
          : `<div class="kb-l-filter">
        <nav class="kb-l-tabs" id="kbTabs" aria-label="任务状态"></nav>
        <button type="button" class="kb-l-refresh" data-kb-refresh aria-label="刷新">${KB_ICON_REFRESH}</button>
      </div>`
      }
      <div class="kb-l-list" id="kbList">${
        err ? kbMobileEmpty({ text: '任务没取到', sub: err, cta: '重试', act: 'retry' }) : ''
      }</div>
    </div>`;

  // 与桌面同一个 S.kbLast：卡片详情、建卡回调的口径一点不变
  S.kbLast = {
    data,
    wire: {
      refresh: () => (isAll ? openTaskBoard() : openProjectDetail(project.id)),
      // 项目的看板：建卡不用选项目；全局：null = 创建页里选
      taskProject: () => project,
    },
  };

  // 返回只有一层含义（交互规格 §0.2）：全局看板 → 工作台；项目看板 → 项目清单。
  // 项目那一支**不带 id** —— 带了会在手机上把那个项目的详情又画一遍，等于没退。
  view.querySelector('[data-kb-back]')?.addEventListener('click', () => {
    if (isAll) setNav('plugins');
    else openProjectsPage();
  });

  // 刷新：图标转圈 + 期间禁用（连点只发一次请求）+ 完成后回顶；失败 toast 并复位图标
  let refreshing = false;
  const refresh = async () => {
    if (refreshing) return;      // 连点只发一次请求
    refreshing = true;
    const btn = view.querySelector('[data-kb-refresh]');
    // 转圈只给 svg 加 transform（圆的是图标，不是按钮）—— 动 padding/尺寸会让筛选条抖 1px
    btn?.classList.add('spinning');
    btn?.setAttribute('aria-busy', 'true');
    try {
      // 重画的还是这一页：S.kbMobileTab 是内存态，所以 tab 不会被重置
      await S.kbLast.wire.refresh();
      // 刷新后回顶，不加 smooth —— "跳"一下比滑过去更清楚"列表换了一批"
      $('kbList')?.scrollTo({ top: 0 });
    } catch (e) {
      toast(e.message, 'error');
      // 失败就停在这一页、按钮还是同一颗，得自己复位（成功那条路页面重画，节点已经换了）
      btn?.classList.remove('spinning');
      btn?.removeAttribute('aria-busy');
    } finally {
      refreshing = false;
    }
  };
  view.querySelector('[data-kb-refresh]')?.addEventListener('click', refresh);
  // 空/错三态里那颗按钮：新建 / 看全部 / 重试。用委托而不是逐次绑定 ——
  // 那三块是 paint() 重画的，逐次绑定要跟着重画走一遍
  $('kbList')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-kb-empty-act]');
    if (!btn) return;
    const act = btn.dataset.kbEmptyAct;
    if (act === 'new') openKbNewPage({ project, isAll });
    else if (act === 'all') { curTab = 'all'; S.kbMobileTab = 'all'; paint(); }
    else if (act === 'retry') refresh();
  });

  /*
   * ＋ 新建任务（导航栏右上）：一版直接调 taskDialog，手机上那个弹窗是"桌面弹窗压成全屏"
   * 打补丁打出来的（mobile.css 那三段注释就是补丁史），二版走自己的创建页。
   * 桌面那条路一个字没动 —— taskDialog 还在，只是手机不再调它。
   */
  view.querySelector('[data-kb-new]')?.addEventListener('click', () => openKbNewPage({ project, isAll }));

  if (err) return;

  const cols = data?.columns ?? [];
  const total = kbRows(data).length;

  // 状态 tab：当前值记内存态（S.kbMobileTab），不进路由、不压历史 —— 筛选是视图状态
  // 不是位置，压了历史"返回"就变成"撤筛选"（交互规格 §3）
  let curTab = S.kbMobileTab || 'all';
  const order = Object.keys(COL_STATUS);
  const orderIdx = (k) => (order.indexOf(k) < 0 ? order.length : order.indexOf(k));
  if (curTab !== 'all' && !COL_STATUS[curTab] && !cols.some((c) => c.key === curTab)) curTab = 'all';
  /*
   * tab 集合：'all' + 有卡的列（顺序 = data.columns 的列序，与桌面从左到右一致）。
   * **例外**：正在看的那一列哪怕已经 0 张也留着 —— 唯一一张卡被移走后 tab 凭空消失，
   * 读起来像"筛选被重置了"；留着 0 计数 +「这个状态没有任务」才解释得清。
   */
  const tabs = [{ key: 'all', label: '全部', count: total }];
  for (const c of cols) {
    const count = (c.cards ?? []).length;
    if (count > 0 || c.key === curTab) tabs.push({ key: c.key, label: c.label, count });
  }
  // 当前 tab 是合法列 key、但这一版数据里没有这一列（换了板）：按列序插回去，别让它静默消失
  if (curTab !== 'all' && !tabs.some((t) => t.key === curTab)) {
    const at = tabs.findIndex((t) => t.key !== 'all' && orderIdx(t.key) > orderIdx(curTab));
    tabs.splice(at < 0 ? tabs.length : at, 0, { key: curTab, label: COL_STATUS[curTab] ?? curTab, count: 0 });
  }

  const paint = () => {
    const tabsEl = $('kbTabs');
    const listEl = $('kbList');
    if (!tabsEl || !listEl) return;
    tabsEl.innerHTML = tabs
      .map((t) => `<button type="button" class="kb-l-tab${curTab === t.key ? ' on' : ''}"
        data-kb-m-tab="${esc(t.key)}" aria-pressed="${curTab === t.key}"
        aria-label="${esc(`${t.label} ${t.count} 个`)}">${esc(t.label)}<span class="kb-l-n">${t.count}</span></button>`)
      .join('');
    // 按**列**过滤而不是按状态词：一列可能混两个状态词（「已阻塞」列收已阻塞·已停止、
    // 「待办」列收流程的「待办」）—— 跟桌面"列 = 类"的口径一致；「全部」不过滤。
    const rows = curTab === 'all' ? kbRows(data) : (cols.find((c) => c.key === curTab)?.cards ?? []);
    if (rows.length) {
      listEl.innerHTML = `<div class="kb-l-group">${rows.map((r) => kbMobileRow(r, isAll)).join('')}</div>`;
    } else {
      listEl.innerHTML = total === 0
        ? kbMobileEmpty({ text: '还没有任务', sub: '建一张，手机上也能派活', cta: '新建任务', act: 'new' })
        : kbMobileEmpty({ text: '这个状态没有任务', cta: '看全部', act: 'all' });
    }
    // 刚建出来的那张卡：1.6s 高亮，让人一眼看到"建在哪儿了"（只在建卡后第一遍画时有）
    if (kbFlashId) {
      listEl.querySelector(`[data-kb-open="${CSS.escape(kbFlashId)}"]`)?.classList.add('flash');
      kbFlashId = '';
    }
    tabsEl.querySelectorAll('[data-kb-m-tab]').forEach((b) => {
      b.onclick = () => {
        curTab = b.dataset.kbMTab;
        S.kbMobileTab = curTab;
        paint();
        // 当前项滚进可视区只在**换 tab**时做，不在每次重画时抢滚动
        b.scrollIntoView({ inline: 'center', block: 'nearest' });
      };
    });
    // 点卡片 = 桌面看板**同一条路**：行上带与 kbCard 相同的跳转属性
    // （data-kb-open / data-kb-conv / data-kb-flow），wireBoard 原样认 —— 不另写一份开卡逻辑
    wireBoard(listEl, S.kbLast.wire);
  };
  paint();

  /*
   * 外接键盘 / 读屏：wireBoard 只给 `data-kb-open` 挂了 Enter/Space，流程卡与会话卡没有 ——
   * 这里补一条委托，覆盖那两类。`e.target === row` 守一道：行内按钮（验收/撤销）自己处理。
   */
  $('kbList')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('[data-kb-flow], [data-kb-conv]');
    if (!row || e.target !== row) return;
    e.preventDefault();
    row.click();
  });
}

/**
 * 窄屏的空态 / 错误态：一种版式两个文案（视觉规格 §4）。
 * 按钮是**软底**而不是实心主蓝 —— 空态里的蓝不该和导航栏那颗「＋」抢。
 */
function kbMobileEmpty({ text = '', sub = '', cta = '', act = '' } = {}) {
  return `<div class="kb-l-empty">
    <p>${esc(text)}</p>${sub ? `<p class="kb-l-reason">${esc(sub)}</p>` : ''}
    ${cta ? `<button type="button" class="kb-l-cta" data-kb-empty-act="${esc(act)}">${esc(cta)}</button>` : ''}
  </div>`;
}

/**
 * 窄屏列表的一行（视觉规格 §3.2）：标题（≤2 行）+ 元信息行
 * `[● 状态词] [项目 pill（仅全局面板）] [执行人] ……… [时间]`。
 *
 * 跳转属性与 kbCard 完全同款 —— 「本地卡」（手工/仓库值班/协作）带 data-kb-open 进整页详情，
 * 流程卡带 data-kb-flow、聊天卡带 data-kb-conv，wireBoard 的开卡逻辑原样复用，不复制粘贴。
 * **不画 chevron**：三路跳转里两种是弹窗，箭头会骗人（以为是"推进一层页面"）。
 * 来源 / PR / 设备标签窄屏一律不画 —— 一屏只留一处彩色，那些标签在 390px 下是噪声。
 * **不带**拖拽属性与删除按钮：那两个手势是桌面看板的，窄屏的删改在卡片详情页里做。
 */
export function kbMobileRow(r, isAll) {
  const jump = r.source === 'flow'
    ? `data-kb-flow="${esc(r.flow_id)}" data-kb-tpl="${esc(r.template_id || '')}"`
    : r.conversation_id
      ? `data-kb-conv="${esc(r.conversation_id)}"`
      : '';
  // 协作卡（2026-10-31）与手工/仓库卡同一族：卡本身也在 project_tasks 里，点得开详情
  const open = (r.source === 'manual' || r.source === 'repo' || r.source === 'collab') && r.manual_id
    ? `data-kb-open="${esc(r.manual_id)}" tabindex="0"`
    : '';
  /*
   * 状态色：行上挂 `--st-c`，圆点取它的原值（不混明度 —— --st-* 已按"压在淡底上 ≥4.5"
   * 双主题校准过，再乘个 60~70% 会让浅色档糊在灰底上）。列 key 优先用行自带的 `col`
   * （桌面 kbCard 也用它），老数据没有就按状态词反查 COL_STATUS。
   */
  const colKey = r.col || Object.keys(COL_STATUS).find((k) => COL_STATUS[k] === r.status) || 'other';
  // 全局面板的行才带 project_name（项目看板的行服务端已经摘掉了）
  const proj = isAll && r.project_name
    ? `<span class="kb-l-pill">${esc(r.project_name)}</span>`
    : '';
  const who = r.assignee || '未指派';
  /*
   * 派到分公司的卡（remote）没有跳转属性 = 死行。行尾补上桌面同一口径的动作：
   * 待验收 →「验收」；非终态 →「撤销」；终态不给。data-kb-cl-* 与 wireBoard 里现成的
   * 接线一一对应（含撤销的二次确认），不另写一套请求。
   */
  const act = r.remote && r.collab_task_id
    ? r.status === '待验收'
      ? `<div class="kb-l-acts"><button type="button" class="kb-l-act" data-kb-cl-done="${esc(r.collab_task_id)}">验收</button></div>`
      : r.status !== '已完成' && r.status !== '已取消'
        ? `<div class="kb-l-acts"><button type="button" class="kb-l-act" data-kb-cl-cancel="${esc(r.collab_task_id)}">撤销</button></div>`
        : ''
    : '';
  // `title`（原来放 note）在触屏上永远看不到 —— 换 aria-label，读屏才拿得到同样的信息
  return `<article class="kb-l-row" style="--st-c: var(--st-${esc(colKey)})" ${jump} ${open}
      aria-label="${esc(`${r.task}，${r.status}，${who}`)}">
    <div class="kb-l-title">${esc(r.task)}</div>
    <div class="kb-l-meta">
      <span class="kb-l-dot" aria-hidden="true"></span>
      <span class="kb-l-state">${esc(r.status)}</span>
      ${proj}
      <span class="kb-l-who">${esc(who)}</span>
      <span class="kb-l-time">${esc(r.at ?? '')}</span>
    </div>${act}
  </article>`;
}



/* ---------------------------------------------------------------- 新建任务（手机全屏页） */

/*
 * 为什么是**覆盖层**而不是在同一页里换 innerHTML（交互规格 §5 的原案，本次裁决否掉）：
 * 返回时若重画 #pluginView，就得重跑 openBoardPage —— 重新 fetch、滚回顶部、丢 tab 态；
 * 覆盖层只要摘掉。历史与守卫口径也和 #mbPicker 完全一致（压一格、退一格），
 * 少一套"这一格是谁的、要不要重画"的判定。视觉规格 §6 / `#mbPicker` 同款推入。
 *
 * 历史铁律（与 mbClosePicker 一字不差）：**先 history.back()，画面等 popstate 收**。
 * 反过来先摘画面再 back()，那条 popstate 到时 class 已经没了，mobile.mjs 会把它当
 * "退到根页"再压一格回去 —— 用户要按两次返回才出得去看板。
 */
let kbNewEl = null;
let kbNewState = null;      // 这一次创建页的状态；null = 关着
let kbNewClosing = false;   // 已经在退格（防连点：第二下不能再退一格）
let kbNewAbandon = false;   // 用户已确认放弃 → 下一次 popstate 直接收画面，不再问
let kbFlashId = '';         // 刚建出来的那张卡：下一次画列表时给它 1.6s 高亮

const KB_NEW_IDEA = '想法';

/** 首次开页才建 DOM（懒到真用的时候；桌面永远走不到这里） */
function kbEnsureNew() {
  if (kbNewEl) return kbNewEl;
  const el = document.createElement('div');
  el.className = 'kb-new';
  el.id = 'kbNew';
  el.hidden = true;
  el.innerHTML = `
    <div class="detail-head kb-new-bar">
      <button type="button" class="kb-l-navbtn back" data-kb-new-back aria-label="返回看板">${KB_ICON_BACK}</button>
      <h1 class="kb-new-bartitle">新建任务</h1>
    </div>
    <div class="kb-new-body">
      <!-- ① 无框输入区：靠字号/字重与下面的分组卡分层，不给输入框画框（iOS 新建提醒同款） -->
      <div class="kb-new-draft">
        <input class="kb-new-inputtitle" id="kbNewTitle" placeholder="任务要做什么"
               autocomplete="off" enterkeyhint="done" aria-label="任务标题" />
        <textarea class="kb-new-desc" id="kbNewDesc" rows="1" placeholder="补充说明（可选）"
                  aria-label="补充说明"></textarea>
      </div>
      <div class="kb-new-group" id="kbNewGroup"></div>
    </div>
    <div class="kb-new-foot">
      <button type="button" class="kb-new-submit" id="kbNewOk" aria-disabled="true">创建任务</button>
    </div>`;
  document.body.appendChild(el);
  el.querySelector('[data-kb-new-back]').addEventListener('click', () => { kbTryClose(); });

  /*
   * 行是 paintKbNew() 整段重画的（条件显示会变），所以监听挂在容器上、用委托：
   * 逐行 addEventListener 的话，每选一次值都得重新绑一遍，漏一处那行就"点不动了"。
   */
  el.querySelector('#kbNewGroup').addEventListener('click', (e) => {
    // 大卡尾的 › 箭头：切到这张卡的模式（preventDefault 挡住 label 的默认激活，
    // 模式由这里显式设，不然 radio 的 change 和这里各画一遍），再跳选择页
    const gopick = e.target.closest('[data-kb-gopick]');
    if (gopick && kbNewState) {
      e.preventDefault();
      const which = gopick.dataset.kbGopick ?? '';
      kbNewState.mode = which === 'flow' ? 'flow' : 'person';
      paintKbNew();
      kbNewPick(which);
      return;
    }
    const row = e.target.closest('[data-kb-pick]');
    if (row) { kbNewPick(row.dataset.kbPick); return; }
    const pub = e.target.closest('[data-kb-gopub]');
    if (pub) { e.preventDefault(); kbNewGoPublish(); }
  });
  el.querySelector('#kbNewGroup').addEventListener('change', (e) => {
    const r = e.target;
    if (!kbNewState) return;
    // 执行方式 radio：切模式只换显示，两边已选的值都留着（与桌面 syncMode 同口径）
    if (r?.name === 'kbNewMode') { kbNewState.mode = r.value; paintKbNew(); return; }
    // 「立即开始」勾选框（收在「更多设置」里）：只记用户的意愿；能不能勾、
    // 锁在勾上还是取消，全部由 kbNewSyncStart / paintKbNew 算
    if (r?.id === 'kbNewStart') { kbNewState.startNow = r.checked; paintKbNew(); }
  });

  const titleEl = el.querySelector('#kbNewTitle');
  titleEl.addEventListener('input', () => {
    const ok = el.querySelector('#kbNewOk');
    /*
     * 用 aria-disabled 而不是原生 disabled（2026-11-05 定稿）：原生 disabled 点下去
     * **完全没反应**，比"点了告诉你缺什么"更糟。样式照旧是灰底灰字，点仍然进 kbNewSubmit，
     * 由那里 toast + 把焦点打到标题框。
     */
    ok?.setAttribute('aria-disabled', String(!titleEl.value.trim()));
  });
  // 描述自动长高（min 44 由 CSS 给，>8 行改内部滚动）
  el.querySelector('#kbNewDesc').addEventListener('input', (e) => {
    const t = e.target;
    t.style.height = 'auto';
    t.style.height = `${t.scrollHeight}px`;
  });
  el.querySelector('#kbNewOk').addEventListener('click', () => { kbNewSubmit(); });

  kbNewEl = el;
  return el;
}

/**
 * 开页。`project` 有值 = 从项目看板进来的（项目已定）；`isAll` = 全局面板（要自己选项目）。
 *
 * 状态默认值照交互规格 §5.3：只有「想法」「待办」两个 tab 会预填（与桌面"只有这两列给 ＋"
 * 同一口径），其余一律「待办」—— 进行中及之后是**流转的产物**，直接建进去没有语义。
 */
function openKbNewPage({ project = null, isAll = false } = {}) {
  const el = kbEnsureNew();
  const startCol = S.kbMobileTab === 'idea' ? 'idea' : 'todo';
  kbNewState = {
    project: project ?? null,
    isAll: !!isAll,
    colKey: startCol,
    mode: 'person',
    who: '',                                        // '' = 不派活（与 taskDialog 同口径）
    projId: '',                                     // 手机看不见左栏，**不预选**第一个项目
    flowId: (S.flowPublished ?? [])[0]?.id ?? '',
    startNow: false,                                // 「立即开始」的用户意愿（勾选框常显）
    submitting: false,
    onDone: () => S.kbLast?.wire?.refresh?.(),
  };
  // 每次开页都是一张白纸：草稿只存在内存里，关掉即弃（建一张卡是 30 秒内的事，
  // 为它加 storage + 恢复提示不划算 —— 写在这儿免得后面当 bug 修）
  $('kbNewTitle').value = '';
  $('kbNewDesc').value = '';
  $('kbNewDesc').style.height = '';
  // 标题为空 = 主按钮显示禁用态（灰底灰字），但**仍然可点** —— 点了会 toast 说缺什么
  const okBtn = $('kbNewOk');
  okBtn.disabled = false;            // 上一轮提交失败/成功可能把它留成原生禁用
  okBtn.setAttribute('aria-disabled', 'true');
  okBtn.textContent = '创建任务';
  kbNewAbandon = false;
  kbNewClosing = false;
  paintKbNew();

  document.body.classList.add('kb-new-open');
  el.hidden = false;
  // 滑入分两帧：display:none → 可见那一帧浏览器会跳过 transition（与 #mbPicker 同因）
  el.classList.remove('kb-new-in');
  requestAnimationFrame(() => {
    if (el.hidden) return;   // 这一帧里又被收起来了（连点两下返回）—— 别把它滑回来
    el.classList.add('kb-new-in');
  });
  if (!history.state?.kbNew) history.pushState({ kbNew: true }, '');
  // 自动聚焦标题：进页第一件事就是写字。⚠️ 不能直接 focus —— 滑入那 160ms 里聚焦，
  // iOS 会把焦点框滚进视野、把还在屏外的层拽一下，看着像"页面先抖一下再出来"
  setTimeout(() => { if (!el.hidden) $('kbNewTitle')?.focus(); }, 80);
}

/** 执行人清单：与 taskDialog 同口径（`u:` 前缀 = 真人），分组标题让 30+ 个人不至于排成一坨 */
function kbNewWhoItems() {
  return [
    { id: '', label: '不派活' },
    { header: '真人' },
    ...(S.users ?? []).map((u) => ({ id: `u:${u.id}`, label: u.name })),
    { header: '数字员工' },
    ...(S.personas ?? []).map((p) => ({ id: p.id, label: personLabel(p) })),
  ];
}

const kbNewProjItems = () => (S.projects ?? []).map((p) => ({ id: p.id, label: p.name }));
const kbNewFlowItems = () => (S.flowPublished ?? []).map((f) => ({ id: f.id, label: f.name }));
const kbNewItemLabel = (items, id) => items.find((it) => !it.header && it.id === String(id ?? ''))?.label ?? '';

/** 一个 value cell（label 左 · 值右 ›）。`empty` = 还没选（值走 --mb-text-3 灰）。
 *  aria-label 拼当前值（交互规格 §4：读屏不用翻右边的值也能知道这行是什么、现在选了啥） */
function kbNewRowHtml(key, label, value, empty = false) {
  return `<button type="button" class="kb-new-row" data-kb-pick="${esc(key)}" aria-label="${esc(`${label}，当前 ${value}`)}">
    <span class="kb-new-lab">${esc(label)}</span>
    <span class="kb-new-val${empty ? ' is-empty' : ''}"><span>${esc(value)}</span><i class="kb-new-chev"></i></span>
  </button>`;
}

/**
 * 「立即开始」的可用性 —— 纯计算，不做任何 DOM/状态改动（画 HTML 的 kbNewGroupHtml
 * 和摸 DOM 的 kbNewSyncStart 都要用它，一份口径两处消费）。规则与桌面 `syncStart()`
 * **行为完全一致**，只把长解释压成一行。三种"锁死"的来源各自不同：
 *   · 真人执行：卡挂在他名下，没有"开始工作"这件事 → 锁在取消；
 *   · 「想法」：还没决定要不要做，派活/发起都谈不上 → 锁在取消；
 *   · 流程模式选定了流程且不是想法：建卡就**一定**发起 → 锁在勾上（它不是给人改的，
 *     只用来表示"会发生什么"）。
 * 未派活（chips 上的「不派活」是显式选择）的文案不再说"先选执行人"——那是指路到
 * 已被 chips 取代的清单位置；改说这件事现在的实际后果。
 */
function kbStartState(st) {
  const idea = (COL_STATUS[st.colKey] ?? '待办') === KB_NEW_IDEA;
  const isUser = String(st.who).startsWith('u:');
  if (st.mode === 'flow') {
    const picked = !!st.flowId;
    return {
      can: false,
      lockOn: picked && !idea,
      why: !picked ? '先选一条流程（实际不可达：radio 已置灰）'
        : idea ? '「想法」先不发起，拖到「进行中」才发'
          : '选了流程就立即发起；想先挂着就把状态改成「想法」',
    };
  }
  if (isUser) return { can: false, lockOn: false, why: '真人执行：卡挂在他名下，不开会话、不派活' };
  if (!st.who) return { can: false, lockOn: false, why: '未派活：卡先挂着，谁也不会被叫醒' };
  if (idea) return { can: false, lockOn: false, why: '「想法」先不派活，想做的时候拖到「进行中」' };
  return { can: true, lockOn: false, why: '建好就派到他的会话，工作目录是这个项目' };
}

/**
 * 画创建页主体（2026-11-06 再设计，方案 A「卡片预览式重排」）。
 *
 * 信息分层照建卡的思考顺序：**怎么干**（两张大卡二选一，选中的人/流程回显在卡上）
 * → **更多设置**（状态/项目/立即开始，直接铺开 —— 2026-11-06 三改：折叠摘要撤掉，
 * 页面本来就短，收起来反而多一跳）。
 * 原来的「执行配置」一张长表在手机上读起来像填设置；再设计时中段的「派给谁」chips /
 * 「选流程」行也撤了 —— 卡上的 › 箭头是进选择页的唯一入口，选中结果**回显在卡上**。
 */
function kbNewGroupHtml(st, ss) {
  const published = S.flowPublished ?? [];
  const sec = (t) => `<div class="kb-new-sec">${esc(t)}</div>`;
  const card = (inner, cls = '', attrs = '') => `<div class="kb-new-card${cls ? ` ${cls}` : ''}"${attrs ? ` ${attrs}` : ''}>${inner}</div>`;
  /*
   * 卡尾的 › 箭头（2026-11-06 用户要的）：点它**跳到对应的选择页** —— 派给他 → 执行人
   * （带搜索），由流程执行 → 流程。跳之前先把模式切过去（选人这件事本身就声明了
   * "派给他"）。没已发布流程时流程卡置灰，箭头也不画（点了只会进一张空清单，
   * 副标题和「去发布 ›」已经把话说完了）。
   */
  const goPick = (which, label) => `<button type="button" class="kb-new-gopick" data-kb-gopick="${esc(which)}" aria-label="${esc(label)}">
      <i class="kb-new-chev" aria-hidden="true"></i>
    </button>`;
  /*
   * mode() 模板（2026-11-06 视觉规格 §5.4）：撤圆点（它逼出 48 的左缩进，是表单感主因），
   * 回显值从解释之后**挪到标题正下方**（"给了谁"必须比"怎么走"更亮 —— 值的阅读顺序 =
   * 想事的顺序）。radio 的 aria-label 拼回显值（交互规格 §4），label 挂 tabindex="-1"
   * 仅供程序聚焦（提交被挡时把焦点送到流程卡，交互规格 §3.4 D3）。
   */
  const mode = (val, title, sub, echo, echoOn, disabled = false) => `<label class="kb-new-radio is-card" tabindex="-1" data-kb-modecard="${esc(val)}">
      <input type="radio" name="kbNewMode" value="${esc(val)}"${st.mode === val ? ' checked' : ''}${
        disabled ? ' disabled' : ''} aria-label="${esc(echoOn ? `${title}，已选 ${echo}` : title)}" />
      <span class="kb-new-rtxt">
        <span class="kb-new-rtitle">${esc(title)}</span>
        <span class="kb-new-rpick${echoOn ? ' is-on' : ''}">${esc(echo)}</span>
        <span class="kb-new-rsub">${esc(sub)}</span>
      </span>
      ${disabled ? '' : goPick(val === 'person' ? 'who' : 'flow', val === 'person' ? '选执行人' : '选流程')}
    </label>`;

  const parts = [];

  /* ── 怎么干：执行方式两张大卡，选中的人/流程回显在第三行 ── */
  parts.push(sec('怎么干'));
  parts.push(card(
    mode('person', '派给他', '发到他的会话里去做，进展在那条会话里看',
      st.who ? kbNewItemLabel(kbNewWhoItems(), st.who) : '不派活', !!st.who) +
    mode('flow', '由流程执行', published.length ? '卡跟着流程走，按步骤办' : '还没有已发布的流程',
      st.flowId ? kbNewItemLabel(kbNewFlowItems(), st.flowId) : '未选择', !!st.flowId, !published.length),
    'kb-new-modes',
    'role="radiogroup" aria-label="执行方式"',
  ));
  // 无已发布流程：选进去只会看到一张空清单 —— 置灰，并在卡下给一条去发布的路
  if (!published.length) {
    parts.push('<div class="kb-new-pub"><button type="button" class="kb-new-link" data-kb-gopub aria-label="去发布流程">去发布 ›</button></div>');
  }

  /* ── 建好之后：状态 / 项目 / 立即开始 直接铺开（2026-11-06 三改：不再折叠；D1 改名）── */
  const more = [
    // 状态选项带 6px --st-* 圆点：颜色是"是哪一类活"的编码
    kbNewRowHtml('status', '状态', COL_STATUS[st.colKey] ?? '待办'),
  ];
  // 项目行只在全局面板出现（项目看板的项目已经定死了）
  if (st.isAll) {
    const projects = kbNewProjItems();
    more.push(kbNewRowHtml(
      'proj', '项目',
      projects.length ? (kbNewItemLabel(projects, st.projId) || '未选择') : '还没有项目',
      !st.projId || !projects.length,
    ));
  }
  /*
   * 「立即开始」换开关皮（2026-11-06 视觉规格 §5.5）：同一个 `<input type=checkbox>`
   * id/接线不动，视觉交给 .kb-new-sw（46×28 轨道 + 旋钮）；label 吃 flex:1 把开关顶到行尾。
   * aria-describedby → #kbNewHint：说明是"为什么不让勾"的唯一入口（交互规格 §4）。
   */
  more.push(`<label class="kb-new-check" id="kbNewStartWrap" aria-describedby="kbNewHint">
    <input type="checkbox" id="kbNewStart" />
    <span class="kb-new-lab">创建后立即开始</span>
    <span class="kb-new-sw" aria-hidden="true"></span>
  </label>`);
  more.push(`<p class="kb-new-hint" id="kbNewHint" aria-live="polite">${esc(ss.why)}</p>`);
  parts.push(sec('建好之后'));
  parts.push(card(more.join('')));

  return parts.join('');
}

/**
 * 主按钮文案（交互规格 §1.3 D2）：文案随 kbStartState 的结论走，把"点下去会发生什么"
 * 放到按下点上 —— 只表达"会不会立刻叫醒人"这一件事，其余后果仍在「建好之后」说明里。
 *   · 流程模式且锁勾（必然发起）→「创建并发起流程」；
 *   · 派给数字员工且勾了立即开始（可派）→「创建并派活」；
 *   · 其余 →「创建任务」（空表不预支承诺）。
 */
function kbNewBtnLabel(st, ss) {
  if (st.mode === 'flow') return ss.lockOn ? '创建并发起流程' : '创建任务';
  return (ss.can && st.startNow) ? '创建并派活' : '创建任务';
}

/** 重画创建页主体 + 重算「立即开始」+ 刷新主按钮文案。 */
function paintKbNew() {
  const st = kbNewState;
  const group = $('kbNewGroup');
  if (!st || !group) return;
  const ss = kbStartState(st);
  if (!ss.can && !ss.lockOn) st.startNow = false;   // 条件不再满足 → 意愿作废（勾上会真的派活，自动勾 = 自动产生副作用）
  group.innerHTML = kbNewGroupHtml(st, ss);
  kbNewSyncStart(ss);
  // 主按钮文案跟着模式/锁定结论走（提交中不碰 —— 那时是「创建中…」）
  if (!st.submitting) {
    const btn = $('kbNewOk');
    if (btn) btn.textContent = kbNewBtnLabel(st, ss);
  }
}

/**
 * 把 kbStartState 的结论落到 DOM（勾选框收在「更多设置」里，收起时那三个节点不存在，
 * 意愿的清与留已由 paintKbNew 在画之前算完 —— 这里只管"在 DOM 里就把 DOM 摆对"）。
 * 禁用时**只降复选框的透明度**，说明文字一个像素都不降 —— 那句话是用户唯一能看懂
 * "为什么不让勾"的入口，降了就等于不说。
 */
function kbNewSyncStart(ss = null) {
  const st = kbNewState;
  const wrap = $('kbNewStartWrap');
  const box = $('kbNewStart');
  const hint = $('kbNewHint');
  if (!st || !wrap || !box) return;
  const state = ss ?? kbStartState(st);
  box.disabled = !state.can;
  // 锁在勾上时不算"禁用"：它是**确定的陈述**，不是"你不能改的那个空框"
  if (state.lockOn) box.checked = true;
  else box.checked = !!st.startNow;
  wrap.classList.toggle('on', box.checked);
  wrap.setAttribute('aria-disabled', String(!state.can && !state.lockOn));
  if (hint) hint.textContent = state.why;
}

/** 四个选择项一律走全屏选择页（§20.5 mbPicker），不新建组件 */
function kbNewPick(which) {
  const st = kbNewState;
  if (!st) return;
  if (which === 'status') {
    // 只有 8 项 → 不给搜索；行首带状态色圆点
    mbOpenPicker({
      title: '状态',
      items: Object.keys(COL_STATUS).map((k) => ({ id: k, label: COL_STATUS[k], dot: `var(--st-${k})` })),
      value: st.colKey,
      onPick: (v) => { st.colKey = v; paintKbNew(); },
    });
    return;
  }
  if (which === 'who') {
    mbOpenPicker({
      title: '执行人',
      items: kbNewWhoItems(),
      value: st.who,
      search: true,
      searchPlaceholder: '搜名字或岗位…',
      onPick: (v) => { st.who = v; paintKbNew(); },
    });
    return;
  }
  if (which === 'proj') {
    mbOpenPicker({
      title: '项目',
      items: kbNewProjItems(),
      value: st.projId,
      search: true,
      searchPlaceholder: '搜项目名…',
      note: kbNewProjItems().length ? '' : '还没有项目 —— 任务得有地方挂，先去工作台 → 项目 建一个',
      onPick: (v) => { st.projId = v; paintKbNew(); },
    });
    return;
  }
  if (which === 'flow') {
    mbOpenPicker({
      title: '流程',
      items: kbNewFlowItems(),
      value: st.flowId,
      search: true,
      searchPlaceholder: '搜流程名…',
      onPick: (v) => { st.flowId = v; paintKbNew(); },
    });
  }
}

/** 「还没有已发布的流程」时那条文字链：先按"放弃创建"的规矩退出，再去流程清单 */
function kbNewGoPublish() {
  const go = () => {
    kbNewAbandon = true;
    kbCloseNew();
    setNav('workflows');
  };
  if (!kbHasDraft()) return go();
  confirmDo('写下的标题和描述不会保留。', { title: '放弃这次创建？', ok: '放弃' }).then((ok) => { if (ok) go(); });
}

const kbHasDraft = () => !!(String($('kbNewTitle')?.value ?? '').trim() || String($('kbNewDesc')?.value ?? '').trim());

/**
 * 提交（字段口径照 taskDialog，**不复制**那份弹窗代码）：只发标题/描述/状态，
 * 执行方式二选一（流程不带执行人 —— 服务端把"两个都给"当 400 挡），`startNow` 照抄桌面算法
 * `flow ? 状态 !== '想法' : (!isUser && !!执行人 && 勾选)`，不在手机端另算一套。
 */
async function kbNewSubmit() {
  const st = kbNewState;
  if (!st || st.submitting) return;    // 闸：弱网连点会建两张
  const titleEl = $('kbNewTitle');
  const title = String(titleEl?.value ?? '').trim();
  // 标题为空：主按钮只是"看起来禁用"，点得动 —— 点了就说缺什么，并把焦点送过去
  if (!title) {
    toast('任务得有标题');
    titleEl?.focus();
    return;
  }
  const proj = st.project ?? (S.projects ?? []).find((p) => p.id === st.projId);
  // D3（交互规格 §3.4）：被挡要说缺什么，**焦点也要落到缺的那格** —— 读屏与视线同时到位
  if (!proj) {
    toast('先选一个项目，任务才有地方挂');
    kbNewEl?.querySelector('[data-kb-pick="proj"]')?.focus();
    return;
  }
  const flow = st.mode === 'flow';
  if (flow && !st.flowId) {
    toast('先选一条流程 —— 还没有已发布的流程就去工作台 → 流程 里发布一条');
    // 流程卡：radio 已置灰（无已发布流程），焦点落到卡本身（label 挂了 tabindex="-1"）
    kbNewEl?.querySelector('[data-kb-modecard="flow"]')?.focus();
    return;
  }

  const statusText = COL_STATUS[st.colKey] ?? '待办';
  const whoVal = String(st.who);
  const isUser = whoVal.startsWith('u:');
  const startChecked = !!st.startNow;   // 意愿记在状态里（勾选框收起时不在 DOM，不能从 DOM 读）
  const btn = $('kbNewOk');
  const backBtn = kbNewEl?.querySelector('[data-kb-new-back]');
  const onDone = st.onDone;
  const colKey = st.colKey;

  st.submitting = true;
  if (btn) { btn.disabled = true; btn.textContent = '创建中…'; }
  // 提交期间整页禁止返回（弱网下手快按返回会把请求留在半路）
  if (backBtn) backBtn.disabled = true;

  try {
    const res = await api(`/api/projects/${encodeURIComponent(proj.id)}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        description: String($('kbNewDesc')?.value ?? '').trim(),
        status: statusText,
        ...(flow
          ? { flowTemplateId: st.flowId }
          : isUser
            ? { assigneeUserId: whoVal.slice(2) }
            : { personaId: whoVal || null }),
        startNow: flow ? statusText !== KB_NEW_IDEA : (!isUser && !!whoVal && startChecked),
      }),
    });
    /*
     * ⚠️ 顺序不能反：**先**把 tab 切到新卡所在列、**再**刷新看板。
     * renderBoardMobile 只保留"数据里还在"的 tab，先刷新的话 tab 会回落成「全部」，
     * 新建的卡就不在眼前那一屏了（交互规格 §5.5 第一条）。
     */
    S.kbMobileTab = colKey;
    kbFlashId = res?.task?.id ? String(res.task.id) : '';
    // 草稿此刻已经变成卡了 —— 先清空再关层，否则返回守卫会把这张**已建成**的卡
    // 当成"没保存的草稿"，紧接着弹「放弃这次创建？」
    $('kbNewTitle').value = '';
    $('kbNewDesc').value = '';
    kbCloseNew();
    // 成功反馈带结果对象（交互规格 §3.3 D4）：只说"这一次建出来的东西走到了哪"
    if (res?.task?.flowRunId) toast('流程已经起来了 —— 到流程实例里看每一步');
    else if (!flow && !isUser && !!whoVal && startChecked) {
      toast(`已创建，${kbNewItemLabel(kbNewWhoItems(), whoVal)}这就开始`, 'ok');
    } else toast('已创建', 'ok');
    await onDone?.();
    const listEl = $('kbList');
    if (listEl) listEl.scrollTop = 0;   // 只在**提交成功**时滚到顶（返回不动滚动位置）
  } catch (err) {
    // 失败留在创建页，草稿一个不丢：重填一遍标题是最让人放弃的操作
    toast(err.message, 'error');
    st.submitting = false;
    if (btn) {
      btn.disabled = false;
      // 文案按 §1.3 规则**重算**（不是死写回「创建任务」—— 草稿还在，结论可能还是"会派活"）
      btn.textContent = kbNewBtnLabel(st, kbStartState(st));
      // 草稿还在（标题非空），按钮回到"可用"的外观 —— aria-disabled 得跟着回来
      btn.setAttribute('aria-disabled', 'false');
      // D3：刚才按的就是它，失败后从这继续（读屏与视线都落回主按钮）
      btn.focus();
    }
    if (backBtn) backBtn.disabled = false;
  }
}

/** ‹ / 硬件返回 / Esc 的公共出口：有草稿才问，空的一律直接退 */
async function kbTryClose() {
  const st = kbNewState;
  if (!st || st.submitting) return;
  if (!kbHasDraft()) { kbCloseNew(); return; }
  const ok = await confirmDo('写下的标题和描述不会保留。', { title: '放弃这次创建？', ok: '放弃' });
  if (!ok) return;            // 「继续编辑」/ 点蒙层：留在原页，已填内容一个不丢
  kbNewAbandon = true;
  kbCloseNew();
}

/**
 * 收层。`alreadyPopped` = 这格历史已经被浏览器退掉了（popstate 进来的），只收画面不再退格。
 * ⚠️ 顺序与 mbClosePicker 同一条铁律：**先 back()，画面留到 popstate 再收**。
 */
function kbCloseNew(alreadyPopped = false) {
  const el = kbNewEl;
  if (!el || el.hidden) return;
  if (!alreadyPopped && history.state?.kbNew) {
    if (kbNewClosing) return;
    kbNewClosing = true;
    history.back();
    return;
  }
  kbNewClosing = false;
  kbNewAbandon = false;
  kbNewState = null;
  document.body.classList.remove('kb-new-open');
  el.classList.remove('kb-new-in');
  el.hidden = true;
}

/*
 * 返回手势 / 返回键：这一格是创建页自己压的。
 *   ① 收画面推到下一拍 —— 本文件与 mobile.mjs 的 popstate 谁先注册不确定，
 *      当场摘 class 会让它把这次返回当成"退到根页"再压一格回去（与 mbClosePicker 同因）；
 *   ② 有草稿：浏览器已经把画面退走了 —— 先**补一格**把画面钉住，再问要不要放弃，
 *      否则确认框会盖在看板上（交互规格 §5.4）。
 *   ③ 选择页盖在上面时这一格是**它**的（chat.mjs 自己收），这里一律放行。
 */
window.addEventListener('popstate', () => {
  if (document.body.classList.contains('mb-picker-open')) return;
  if (!document.body.classList.contains('kb-new-open')) return;
  setTimeout(() => {
    if (!document.body.classList.contains('kb-new-open')) return;
    if (kbNewAbandon || !kbHasDraft()) { kbCloseNew(true); return; }
    if (!history.state?.kbNew) history.pushState({ kbNew: true }, '');
    kbNewClosing = false;
    kbTryClose();
  }, 0);
});

/*
 * 手机整页的任务卡（openTaskCardPage 压的 {tcCard:true} 那格）退回来了 = 离开这张卡。
 * 两个早退与上面几条监听同一套：
 *   · 落点的 state 还带 tcCard —— 是选择页/别的层收掉自己那格，卡还开着，放行；
 *   · 没开着（tcPageOpen=false）—— 与这张卡无关的一次 popstate，放行。
 * 收画面的 setTimeout 与 kb-new 同因：mobile.mjs 的 popstate 先注册，它会先把
 * "根页井"补上；我们让它先把栈料理完，再画回上一级（看板 / 项目 / 流程）。
 */
window.addEventListener('popstate', () => {
  if (!tcPageOpen) return;
  if (history.state?.tcCard) return;
  tcPageOpen = false;
  setTimeout(() => { try { tcCardLeave?.(); } catch { /* 上一级画不出来就算了 */ } }, 0);
});

/*
 * 任务卡的「讨论抽屉」自己那一格（2026-11-05）：退回来了 = 收抽屉。
 * 与 mb-picker / kb-new 同一套时序 —— 收画面推到下一拍：mobile.mjs 的 popstate 先注册，
 * 当场摘掉 tc-sheet-open 会让它把这次返回当成"该收卡页"，用户按一次返回就掉回看板。
 * 上面那条 tcCard 的监听先跑：此刻 state 已经是 {tcCard:true}，它直接放行。
 */
window.addEventListener('popstate', () => {
  if (!document.body.classList.contains('tc-sheet-open')) return;
  setTimeout(() => { tcSheetClose?.(true); }, 0);
});

// Esc：与 #mbPicker 同一套规矩 —— 选择页/弹窗开着时让它们自己吃
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!document.body.classList.contains('kb-new-open')) return;
  if (document.body.classList.contains('mb-picker-open')) return;
  if (document.querySelector('dialog[open]')) return;
  e.preventDefault();
  kbTryClose();
});

// Esc：讨论抽屉是卡页的下一级 —— 先收它（外接键盘 / 桌面浏览器缩窗口时才有这一路）
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!document.body.classList.contains('tc-sheet-open')) return;
  if (document.querySelector('dialog[open]')) return;
  e.preventDefault();
  tcSheetClose?.();
});



/** 看板列 → 新建任务时的默认状态（点哪一列的「＋」就默认落在哪一列；拖列也用它换算） */
export const COL_STATUS = { idea: '想法', todo: '待办', doing: '进行中', review: '待验收', blocked: '已阻塞', failed: '失败', done: '已完成', cancelled: '已取消' };



/** 全局面板里那张「未归属」的名（服务端 `project-tasks.mjs` 里的 NO_PROJECT，两处同文） */
export const NO_PROJECT_LABEL = '（未归属）';



/* kb-filter:pure:start */
/**
 * 看板的**筛选**（2026-10-15 起是"状态"一维，形状参照同类产品的看板筛选：头上一枚「筛选」+ 弹出的多选层；
 * 2026-10-18 加了"负责人"和"项目"两维，参照同类产品 —— 看板一旦有过几十张卡，
 * "只看某人的"和"只看某个项目的"就是最常用的两个动作，比按状态筛还常用）。
 *
 * 下面这一段**不碰 DOM**（只读 `S.kbFilter`、只把传进来的数据算一遍，外加拼一段字符串），
 * 所以能单独抠出来在 node 里跑一遍 —— 见 `tmp/kb-filter-check.mjs`。
 *
 * 选项**从当前这批行现取**，不写死表：平台有两套状态词（流程六态 / 聊天四态），
 * 人和项目更是随数据长，写死了迟早漏。状态的顺序跟着看板从左到右的列走。
 *
 * 各个维度的语义（跟同类产品一致，别自创）：
 *   · **同一维里选多个 = 任选其一**（"张三 或 李四"）；
 *   · **不同维之间 = 同时满足**（"张三的 + 这个项目的"）；
 *   · 某一维一个都不勾 = 这一维不设限（不是"什么都不匹配"）。
 */
export function kbStatusOptions(data) {
  const seen = new Map();
  for (const c of data?.columns ?? []) {
    for (const card of c.cards) if (card.status) seen.set(card.status, (seen.get(card.status) ?? 0) + 1);
  }
  return [...seen].map(([status, count]) => ({ status, count }));
}



/** 看板的全部行（平的）。老数据没 `rows` 时退回从列里摊平 —— 两处口径必须一样 */
export function kbRows(data) {
  return data?.rows ?? (data?.columns ?? []).flatMap((c) => c.cards ?? []);
}



/**
 * 「负责人」的选项：**从行里现数**，一人一行（`id` 是员工 id，不是名字 —— 改名不跑、撞名不串）。
 * 空 id 合并成一行「未指派」：没人认领的活恰恰是最该被筛出来的那一堆。
 */
export function kbAssigneeOptions(data) {
  const seen = new Map(); // id -> { id, name, count }
  for (const r of kbRows(data)) {
    const id = r.assignee_id ?? '';
    const cur = seen.get(id) ?? { id, name: id ? String(r.assignee ?? '') : '未指派', count: 0 };
    cur.count += 1;
    if (id && r.assignee) cur.name = String(r.assignee); // 同一个 id 名字总一样，取到就用
    seen.set(id, cur);
  }
  return withGhosts(seen, S.kbFilter?.assignees, (id) => (id ? '（已不在本板）' : '未指派'));
}



/** 「项目」的选项：同上，空 id 合并成「（未归属）」—— 没挂项目、也没落在任何项目目录下的那些活 */
export function kbProjectOptions(data) {
  const seen = new Map();
  for (const r of kbRows(data)) {
    const id = r.project_id ?? '';
    const cur = seen.get(id) ?? { id, name: id ? String(r.project_name ?? '') : NO_PROJECT_LABEL, count: 0 };
    cur.count += 1;
    if (id && r.project_name) cur.name = String(r.project_name);
    seen.set(id, cur);
  }
  return withGhosts(seen, S.kbFilter?.projects, () => '（已不在本板）');
}



/**
 * 「来源」的选项（2026-10-28）：卡是手动建的、仓库值班写的、流程派生的还是聊天派活的，
 * 名字就是卡上那枚 pill（`source_text`，服务端给的口径，别在前端另写一份）。
 * 来源就那四个固定值，**不带搜索**（跟状态同理）。
 */
export function kbSourceOptions(data) {
  const seen = new Map();
  for (const r of kbRows(data)) {
    const id = r.source ?? '';
    const cur = seen.get(id) ?? { id, name: String(r.source_text ?? '') || '手动', count: 0 };
    cur.count += 1;
    seen.set(id, cur);
  }
  return withGhosts(seen, S.kbFilter?.sources, () => '（已不在本板）');
}



/**
 * 补上"记着、但这批行里没有"的那些（张数 0）。
 *
 * 少了这一截就会出现：角标写着 1、弹层里一个勾都没有、脚注还说"不勾 = 看全部" ——
 * 看着像筛选坏了，而且找不到地方去掉它（只能靠「清除」）。换看板就会这样：
 * 全局面板勾了某个人，点进一个他没有活的项目看板；人或项目被删了也一样。
 * 补一行让它**看得见、点得掉**，比什么都重要。
 */
export function withGhosts(seen, remembered, nameOf, byName = true) {
  for (const id of remembered ?? []) {
    if (!seen.has(id)) seen.set(id, { id, name: nameOf(id), count: 0 });
  }
  if (!byName) return [...seen.values()]; // 不排：状态那一维要跟着看板从左到右走（调用方插好的顺序就是列序）
  // 「未指派 / 未归属」永远排最后，其余按名字排（按张数排会让顺序随卡片状态飘）
  return [...seen.values()].sort((a, b) => {
    if (!a.id !== !b.id) return a.id ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh');
  });
}



/** 四个维度各自勾了几个（角标上的数字；项目那一维只在全局面板算数） */
export function kbFilterCount(scope) {
  const f = S.kbFilter ?? {};
  const statuses = f.statuses?.length ?? 0;
  const assignees = f.assignees?.length ?? 0;
  const projects = scope === 'all' ? (f.projects?.length ?? 0) : 0;
  const sources = f.sources?.length ?? 0;
  return statuses + assignees + projects + sources;
}



/** 现在有没有在筛（某一维一个都不勾 = 那一维不设限；三维全空 = 看全部） */
export function kbFilterActive(scope) {
  return kbFilterCount(scope) > 0;
}



/**
 * 这张卡会被**哪一维**挡在筛外（没挡返回空串）。`kbMatch` 就是它的反面。
 *
 * 单开一条是为了界面上能说**人话**：建卡前的提醒要说清"是状态不对还是人不在这筛里"，
 * 只说"当前筛选看不到它"等于让人自己去猜。
 *
 * `scope`：项目看板整块板就是一个项目，行上也不都带 `project_id`（流程行/手工卡本来就没有）——
 * 所以那一维**只在全局面板生效**。不这么写的话，在全局面板按项目筛完再点进项目看板，
 * 会一张卡都不剩（行没有 project_id，跟"选了某个项目"永远不匹配）。
 */
export function kbWhyHidden(card, scope) {
  const f = S.kbFilter ?? {};
  if (f.statuses?.length && !f.statuses.includes(card?.status)) return 'status';
  if (f.assignees?.length && !f.assignees.includes(card?.assignee_id ?? '')) return 'who';
  if (scope === 'all' && f.projects?.length && !f.projects.includes(card?.project_id ?? '')) return 'proj';
  if (f.sources?.length && !f.sources.includes(card?.source ?? '')) return 'src';
  return '';
}



/**
 * 这张卡过不过筛。**同一维里是"或"、不同维之间是"且"**（规则见上面那段总说明）。
 */
export function kbMatch(card, scope) {
  return !kbWhyHidden(card, scope);
}



/** 弹层要列的状态：本板有的，加上"记着但本板没有"的那些（张数 0）。顺序跟着列走，**不按名字排** */
export function kbFilterOptions(data) {
  const opts = kbStatusOptions(data).map((o) => ({ id: o.status, name: o.status, count: o.count }));
  return withGhosts(new Map(opts.map((o) => [o.id, o])), S.kbFilter?.statuses, () => '（本板没有）', false);
}



/**
 * 按筛选把看板列过一遍：列内卡片只剩匹配的，列头张数跟着卡片走（不然列头写 5、里面只站 2 张）。
 * **整列都不匹配就不显示那一列**（留着 6、7 个空列只是噪声）——
 * 但只在"这一筛真筛掉了东西"时才裁：全勾跟不勾是一回事（都是看全部），
 * 那时候再裁空列，6 列会塌成 1 列 —— 同一个意思两种形状（用户 2026-10-15 的审查提的）。
 */
export function kbFilterCols(data) {
  const scope = data?.scope;
  // 「列设置」整列藏掉的先摘掉（跟筛选无关，勾没勾筛都藏）；
  // 存的是列 key，服务端哪天加了新列，默认显示，不会被旧名单悄悄吞掉
  const hidden = new Set(S.kbHiddenCols ?? []);
  const cols = (data?.columns ?? [])
    .filter((c) => !hidden.has(c.key))
    .map((c) => {
      const cards = c.cards.filter((x) => kbMatch(x, scope));
      return { ...c, cards, count: cards.length };
    });
  // "真筛掉了东西"：有卡没通过 = 要裁空列。拿**卡**判而不是拿选项判 ——
  // 加了负责人/项目之后，选项里可能全是张数 0 的幽灵，按选项判会误以为筛掉了
  const narrows = kbFilterActive(scope) && kbRows(data).some((x) => !kbMatch(x, scope));
  return narrows ? cols.filter((c) => c.count) : cols;
}



/**
 * 看板工具栏上的「刷新 PR」（2026-10-17）。两块看板共用。
 *
 * 为什么需要这颗按钮：PR 在 GitHub 上被合并，**平台不会自己知道** —— 没人点，
 * 卡片上的「PR #n 开着」就一直开着，也永远不会转「待验收」。
 * 之前只有"点进某张卡的详情 → 刷新状态"这一条路，一次一张；卡一多就没人愿意点。
 *
 * 一张都没关联时按钮留着、禁用：**没有它，人根本不知道有这回事**（"为什么我的卡不动？"）。
 * title 里把话说清楚（"先在某张卡的详情里贴 PR 链接"），比藏起来好。
 */
export function kbPrRefreshHtml(data) {
  const rows = data?.rows ?? (data?.columns ?? []).flatMap((c) => c.cards ?? []);
  const n = rows.filter((r) => r?.pr).length;
  return `<button type="button" data-kb-pr-refresh${n ? '' : ' disabled'} title="${
    n ? `${n} 张卡关联了 PR —— 重新查一遍它们的最新状态` : '还没有卡片关联 PR（先在某张卡的详情里贴 PR 链接）'
  }">刷新 PR${n ? `（${n}）` : ''}</button>`;
}



/**
 * 四个维度 = 一级菜单的四行。顺序就是弹层里的顺序（状态最常用，排头）。
 * `field` 是它在 `S.kbFilter` 里对应的那个数组 —— 两处别各写各的。
 */
export const KB_DIMS = [
  { key: 'status', field: 'statuses', label: '状态' },
  { key: 'who', field: 'assignees', label: '负责人', search: true },
  { key: 'proj', field: 'projects', label: '项目', search: true },
  { key: 'src', field: 'sources', label: '来源' },
];



/** 某一维的选项（二级菜单要铺的那些） */
export function kbDimOptions(data, key) {
  if (key === 'status') return kbFilterOptions(data);
  if (key === 'who') return kbAssigneeOptions(data);
  if (key === 'src') return kbSourceOptions(data);
  return kbProjectOptions(data);
}



/**
 * 二级里按关键词过滤选项（只认名字，不区分大小写；空词 = 不过滤）。
 *
 * 只有负责人和项目带搜索（`KB_DIMS[].search`）：这两维的选项跟着人/项目长，
 * 名单一长滚着找很难受；状态就那几个词，加个搜索框反而要多点一下。
 */
export function kbDimFilter(opts, q) {
  const k = String(q ?? '').trim().toLowerCase();
  if (!k) return opts;
  return opts.filter((o) => String(o.name ?? '').toLowerCase().includes(k));
}



/**
 * 二级选项那一堆行（`kbFilterBar` 与「搜索时只重画列表」共用）。
 * 已勾但被搜索滤掉的行**不画，但选择还在** —— 摘要和角标照旧算它，不会因为搜了一下就悄悄取消。
 */
export function kbDimRowsHtml(data, dim) {
  const all = kbDimOptions(data, dim.key);
  const list = kbDimFilter(all, S.kbSearch);
  if (!list.length) {
    return `<div class="kbf-row dim">${
      all.length ? `没有匹配「${esc(String(S.kbSearch ?? '').trim())}」的${esc(dim.label)}` : '这一组没有可选项'
    }</div>`;
  }
  const has = (id) => (S.kbFilter?.[dim.field] ?? []).includes(id);
  return list
    .map(
      (o) => `<label class="kbf-row${o.count ? '' : ' zero'}${o.id ? '' : ' muted'}">
        <input type="checkbox" data-kbf-key="${esc(dim.key)}:${esc(o.id)}"${has(o.id) ? ' checked' : ''} />
        <span class="kbf-name">${esc(o.name)}</span>
        <span class="kbf-num">${o.count}</span>
      </label>`,
    )
    .join('');
}



/**
 * 一级菜单的数据：四个维度各一行，带「勾了几项」和已选名字的摘要。
 *
 * 为什么收成两级（用户 2026-10-18 提的，之前的做法是把三组平铺在一层里）：
 * 人和项目一多，单层弹层要滚很久才够得到「项目」那组；而且"我到底按什么在筛"
 * 得自己一行行找勾。分两级之后每行自己就把答案写在脸上（几项 + 选了谁），
 * 点进去才铺选项 —— 层高稳定，多加几维也不挤。
 */
export function kbDimList(data) {
  const scope = data?.scope;
  return KB_DIMS.filter((d) => d.key !== 'proj' || scope === 'all').map((d) => {
    const opts = kbDimOptions(data, d.key);
    const chosen = S.kbFilter?.[d.field] ?? [];
    const names = chosen.map((id) => opts.find((o) => o.id === id)?.name ?? id);
    return {
      ...d,
      count: chosen.length,
      total: opts.length,
      // 名字最多摆两个，再多就「+N」：一行摆不下会折成两行，四个维度就不齐了
      summary: names.length > 2 ? `${names.slice(0, 2).join('、')} +${names.length - 2}` : names.join('、'),
    };
  });
}



/**
 * 看板的「筛选」那一块（按钮 + **两级**弹层）。两块看板共用。
 * 里面只有字符串拼接（不碰 DOM），所以也圈进这一段：能跟上面几条一起在 node 里验。
 *
 * 一级 = 维度（状态 / 负责人 / 项目 / 来源），二级 = 那一维的选项多选。
 * 停在哪一级存在 `S.kbPane`（空串 = 一级），**不进 localStorage** ——
 * 下次点开筛选，人想的是"换一维看看"，不是回到上次那一维。
 *
 * 项目那一维**只在全局面板出现**：项目看板整块板就是一个项目，再按项目筛一遍是废话。
 */
export function kbFilterBar(data) {
  const scope = data?.scope;
  const n = kbFilterCount(scope);
  const dims = kbDimList(data);
  const open = dims.find((d) => d.key === S.kbPane) ?? null; // 找不到就是记的那一维在这儿不存在（比如项目看板上的「项目」）

  const head = open
    ? `<div class="kbf-head">
        <button type="button" class="kbf-back" id="kbFilterBack" title="返回上一级（Esc）">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 6.5 9 12l5.5 5.5" /></svg>
        </button>
        <b>${esc(open.label)}</b>
        ${open.count ? '<button type="button" class="kbf-clear" id="kbFilterClearDim">清除本组</button>' : ''}
      </div>`
    : `<div class="kbf-head"><b>筛选</b>${n ? '<button type="button" class="kbf-clear" id="kbFilterClear">清除</button>' : ''}</div>`;

  // ── 二级：这一维的选项（多选，勾着不关层）。负责人 / 项目上面多一个搜索框 ──
  const search = open?.search
    ? `<div class="kbf-search">
        <input type="search" class="kbf-q" id="kbFilterSearch" autocomplete="off" spellcheck="false"
               placeholder="搜索${esc(open.label)}…" value="${esc(S.kbSearch ?? '')}" />
      </div>`
    : '';

  // ── 一级：维度清单（带勾选数与摘要，点一行进二级） ──
  const dimRows = dims.map(
    (d) => `<button type="button" class="kbf-dim${d.count ? ' on' : ''}" data-kbf-dim="${esc(d.key)}"${d.total ? '' : ' disabled'}>
      <span class="kbf-name">${esc(d.label)}</span>
      ${d.count ? `<span class="kbf-tag">${d.count}</span>` : ''}
      ${d.summary ? `<span class="kbf-dim-sum" title="${esc(d.summary)}">${esc(d.summary)}</span>` : ''}
      <svg class="kbf-arrow" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 6l6 6-6 6" /></svg>
    </button>`,
  );

  const body = open
    ? `${search}<div class="kbf-rows" id="kbFilterRows">${kbDimRowsHtml(data, open)}</div>
       <div class="kbf-foot">同一组里选多个 = 任选其一；不勾 = 这一组不设限</div>`
    : `${dims.every((d) => !d.total) ? '<div class="kbf-row dim">这个看板上还没有任务</div>' : dimRows.join('')}
       <div class="kbf-foot">点一行进去选；不同组之间 = 同时满足</div>`;

  return `<div class="kbf" id="kbFilter">
    <span class="kbf-info">${n ? `显示 ${kbFilterCols(data).reduce((a, c) => a + c.count, 0)} / 共 ${data?.total ?? 0}` : ''}</span>
    <button type="button" class="kbf-btn${n ? ' on' : ''}" id="kbFilterBtn" title="按状态 / 负责人 / 项目 / 来源筛选">
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
        <path d="M4 6.5h16M7 12h10M10 17.5h4" />
      </svg>
      筛选${n ? `<b>${n}</b>` : ''}
    </button>
    <div class="kbf-pop" id="kbFilterPop" hidden>
      ${head}
      ${body}
    </div>
  </div>`;
}


/**
 * 「列设置」（2026-10-28）：挑看板上显示哪几列。两块看板共用。
 *
 * 跟「筛选」是两件事：筛选是"这批卡里看哪些"（随点随变），这里是
 * "这块板本来就有哪几列"（用不到的状态整列藏掉，存下来一直生效）。
 * 选项就是服务端给的固定列（`data.columns`），里面只有字符串拼接，跟筛选一块圈进纯段验。
 */
export function kbColsSettingHtml(data) {
  const hidden = new Set(S.kbHiddenCols ?? []);
  return `<div class="kbf">
    <button type="button" class="kbf-btn" id="kbColsSetBtn" title="挑看板上显示哪几列">
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
        <path d="M4 6.5h9.5M17.5 6.5H20M4 12h2.5M10.5 12H20M4 17.5h11M19 17.5h1" />
        <circle cx="15.5" cy="6.5" r="2" /><circle cx="8.5" cy="12" r="2" /><circle cx="17" cy="17.5" r="2" />
      </svg>
      列设置
    </button>
    <div class="kbf-pop" id="kbColsSetPop" hidden>
      ${(data?.columns ?? [])
        .map(
          (c) => `<label class="kbf-row">
        <input type="checkbox" data-kb-col-key="${esc(c.key)}"${hidden.has(c.key) ? '' : ' checked'} />
        <span class="kbf-name">${esc(c.label)}</span>
      </label>`,
        )
        .join('')}
    </div>
  </div>`;
}

/* kb-filter:pure:end */

/**
 * 看板列那一段（含"筛完什么都不剩"的兜底文案）。
 * 首屏渲染（两块看板）与 `kbRepaint()` 三条路**共用这一份** ——
 * 原来只有 kbRepaint 有兜底，筛到空时首屏会整块空白，同页点一下勾选框却是空的另一种样子。
 */
export function kbColsHtml(data) {
  const cols = kbFilterCols(data);
  if (cols.length) return cols.map(kbColumn).join('');
  // 「还没任务」「筛没了」「列被藏光了」是三件事：说错了人会以为看板坏了
  const allCols = data?.columns ?? [];
  const allHidden = allCols.length > 0 && allCols.every((c) => (S.kbHiddenCols ?? []).includes(c.key));
  return `<div class="kb-none">${
    allHidden ? '状态列都藏起来了 —— 「列设置」里可以再打开' : kbFilterActive(data?.scope) ? '没有符合筛选的任务' : '还没有任务'
  }</div>`;
}



/**
 * 二级里那些勾选框的接线（整块重画和「搜索时只换列表」两条路共用）。
 * `data-kbf-key` 形如 `status:待办` / `who:p-xxx` / `proj:prj-xxx`。
 */
export function wireKbChecks(root) {
  root.querySelectorAll('input[data-kbf-key]').forEach((box) => {
    box.onchange = () => {
      const key = box.dataset.kbfKey ?? '';
      const at = key.indexOf(':');
      const dim = at < 0 ? key : key.slice(0, at);
      const id = at < 0 ? '' : key.slice(at + 1);
      const field = dim === 'status' ? 'statuses' : dim === 'who' ? 'assignees' : dim === 'src' ? 'sources' : 'projects';
      const set = new Set(S.kbFilter[field] ?? []);
      box.checked ? set.add(id) : set.delete(id);
      S.kbFilter[field] = [...set];
      kbRepaint();
    };
  });
}



/**
 * 只换二级的选项列表（搜索时用）。
 *
 * 为什么不能走 `kbRepaint()`：那条路把整块工具栏重建，**输入框本身也被换掉** ——
 * 打一个字焦点和光标就没了，第二个字打不进去。所以搜索只重画 `#kbFilterRows`，
 * 输入框原地不动，焦点、光标、输入法都还在。
 */
export function kbRepaintRows() {
  const el = $('kbFilterRows');
  const data = S.kbLast?.data;
  const dim = KB_DIMS.find((d) => d.key === S.kbPane);
  if (!el || !data || !dim) return;
  el.innerHTML = kbDimRowsHtml(data, dim);
  wireKbChecks(el);
}



/**
 * 筛选按钮 / 两级弹层的接线。
 * 变化后走 `kbRepaint()`：**原地重画列，不重抓数据、不关弹层** ——
 * 勾一个就整页重来一遍的话，多选根本没法连着点（弹层会被重画掉）。
 *
 * 两级导航也走同一条重画：一级点维度 → 二级，二级点返回 → 一级。
 * 状态放在 `S.kbPane` 里，所以重画之后还停在原来那一级。
 */
export function wireKbFilter() {
  const btn = $('kbFilterBtn');
  const pop = $('kbFilterPop');
  if (!btn || !pop) return;
  btn.onclick = (e) => {
    e.stopPropagation(); // 别让下面那个"点别处就收起"的全局监听当场把它关掉
    if (pop.hidden) {
      // 每次点开都从一级开始、搜索词也清掉：层的 DOM 可能还停在二级（上次关的时候没收），
      // 先换回一级再露出来
      if (S.kbPane || S.kbSearch) {
        S.kbPane = '';
        S.kbSearch = '';
        kbRepaint();
      }
      const setPop = $('kbColsSetPop');
      if (setPop) setPop.hidden = true; // 两层不同时开
      $('kbFilterPop').hidden = false;
    } else {
      pop.hidden = true;
    }
  };
  // 一级 → 二级
  pop.querySelectorAll('[data-kbf-dim]').forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      S.kbPane = el.dataset.kbfDim ?? '';
      S.kbSearch = ''; // 换一维就是一份新名单，上一个词的过滤不该跟着过来
      kbRepaint();
      // 能搜的那两维直接把光标放进搜索框（进来就是为了找人/找项目）；
      // 状态没搜索框，焦点落「返回」上，键盘用户不会掉回页面顶上
      ($('kbFilterSearch') ?? $('kbFilterBack'))?.focus();
    };
  });
  // 二级 → 一级（回来时焦点落回刚离开的那一行）
  const back = $('kbFilterBack');
  if (back) {
    back.onclick = (e) => {
      e.stopPropagation();
      const from = S.kbPane;
      S.kbPane = '';
      S.kbSearch = '';
      kbRepaint();
      const el = $('kbFilter')?.querySelector(`[data-kbf-dim="${CSS.escape(from)}"]`);
      (el ?? $('kbFilterBtn'))?.focus();
    };
  }
  wireKbChecks(pop);
  // 搜索框：只重画列表，不动自己（见 kbRepaintRows）
  const q = $('kbFilterSearch');
  if (q) {
    q.oninput = () => {
      S.kbSearch = q.value;
      kbRepaintRows();
    };
    q.onkeydown = (e) => {
      // Esc 在搜索框里先清词，再按一下才退一级 —— 跟"清除"的直觉一致
      if (e.key === 'Escape' && S.kbSearch) {
        e.stopPropagation();
        q.value = '';
        S.kbSearch = '';
        kbRepaintRows();
      }
    };
  }
  // 「清除」= 各个维度一起清（分成四个清除按钮只会让人多点三下）
  $('kbFilterClear')?.addEventListener('click', (e) => {
    e.stopPropagation();
    S.kbFilter.statuses = [];
    S.kbFilter.assignees = [];
    S.kbFilter.projects = [];
    S.kbFilter.sources = [];
    kbRepaint();
  });
  // 「清除本组」= 只清二级这一维（在二级里清完留在二级，方便接着改）
  $('kbFilterClearDim')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const field = KB_DIMS.find((d) => d.key === S.kbPane)?.field;
    if (field) S.kbFilter[field] = [];
    kbRepaint();
  });
}

/**
 * 「列设置」的接线：按钮开合 + 勾选框落 `S.kbHiddenCols`（勾上 = 显示）。
 *
 * 勾一下走 `kbRepaint()`：列原地重画（藏掉的列当场消失/回来），筛选弹层跟着对一遍数；
 * 这个弹层不在 `#kbFilter`、`#kbCols` 里，重画碰不到它 —— 勾选框还在原地，
 * 可以连着勾（跟筛选弹层"勾着不关层"同一个道理）。
 */
export function wireKbColsSetting() {
  const btn = $('kbColsSetBtn');
  const pop = $('kbColsSetPop');
  if (!btn || !pop) return;
  btn.onclick = (e) => {
    e.stopPropagation(); // 别让"点别处收起"的全局监听当场把它关掉
    if (pop.hidden) {
      const f = $('kbFilterPop');
      if (f) f.hidden = true; // 两层不同时开
      pop.hidden = false;
    } else {
      pop.hidden = true;
    }
  };
  pop.querySelectorAll('input[data-kb-col-key]').forEach((box) => {
    box.onchange = () => {
      const key = box.dataset.kbColKey ?? '';
      const set = new Set(S.kbHiddenCols ?? []);
      box.checked ? set.delete(key) : set.add(key);
      S.kbHiddenCols = [...set];
      savePlace(); // 跟筛选同一本账：刷新回来还是这套列
      kbRepaint();
    };
  });
}



/**
 * 筛选变了之后重画：只换「列」那一段（`#kbCols`）和筛选那一块（数字、勾选、清除按钮都在里面）。
 * 卡片是新画的，接线得重新绑一遍（`wireBoard` 只认交到它手上的那棵树）。
 * 弹层的开合状态要**跨过重画**留住 —— 否则点第二下就找不着那个层了；
 * 键盘勾选时焦点也得还给同一个勾选框（整块是重建的，不还的话空格只能勾一下）。
 */
export function kbRepaint() {
  const st = S.kbLast;
  const colsEl = $('kbCols');
  if (!st?.data || !colsEl) return;
  const wasOpen = !$('kbFilterPop')?.hidden;
  // 焦点有四处落点：二级的勾选框、一级的维度行、二级的「返回」、二级的搜索框。
  // 整块重建之后要还回去，否则键盘勾一个就掉到页面上，空格只能勾一下（这条是 2026-10-15 就踩过的坑）
  const act = document.activeElement;
  const focusKey = act?.dataset?.kbfKey ?? null;
  const focusDim = act?.dataset?.kbfDim ?? null;
  const focusBack = act?.id === 'kbFilterBack';
  const focusQ = act?.id === 'kbFilterSearch';
  colsEl.innerHTML = kbColsHtml(st.data); // 首屏那两处用的是同一个兜底
  wireBoard(colsEl, st.wire);
  const bar = $('kbFilter');
  if (bar) bar.outerHTML = kbFilterBar(st.data); // 数字、勾选、清除按钮都在这一块里，整块重画最省事
  wireKbFilter();
  const pop = $('kbFilterPop');
  if (pop) pop.hidden = !wasOpen;
  if (focusKey && pop) pop.querySelector(`input[data-kbf-key="${CSS.escape(focusKey)}"]`)?.focus();
  else if (focusDim) $('kbFilter')?.querySelector(`[data-kbf-dim="${CSS.escape(focusDim)}"]`)?.focus();
  else if (focusBack) $('kbFilterBack')?.focus();
  else if (focusQ) {
    // 光标还回到末尾：搜索框重新建过，不设的话选区别扭（下一次输入把整个词顶掉）
    const q = $('kbFilterSearch');
    if (q) {
      q.focus();
      q.setSelectionRange?.(q.value.length, q.value.length);
    }
  }
  savePlace(); // 筛选也记进"上次停在哪"：F5 回来还是筛着的（见 savePlace 里的 kbStatuses）
}



/**
 * 看板页的接线 —— **项目看板与全局任务看板共用这一份**（2026-10-15）。
 *
 * 两页只有两处不同，都在参数里：
 *   · `refresh()`：干完一件事重画哪一页（项目看板重画这个项目，全局面板重画全局）；
 *   · `taskProject(colKey)`：列头「＋」建的卡挂在哪个项目 —— 项目看板直接给那个项目，
 *     全局面板没有"当前项目"，返回 null，弹窗里让人选一个。
 *
 * 接线内容：卡片点得进去（流程卡 → 实例；聊天/手工卡 → 会话）、手工卡拖到别的列 = 改状态、
 * × = 删卡、列头「＋」= 在那一列建卡。
 */
export function wireBoard(view, { refresh, taskProject = () => null }) {
  view.querySelectorAll('[data-kb-flow]').forEach((el) => {
    el.onclick = () => {
      const tpl = el.dataset.kbTpl || null;
      openFlowRun(tpl, el.dataset.kbFlow).catch((e) => toast(e.message, 'error'));
    };
  });
  view.querySelectorAll('[data-kb-conv]').forEach((el) => {
    el.onclick = () => {
      // ⚠️ 必须先切视图：`openConversation()` 只往 #chatHead / #chat 里写，它不切视图。
      // 在看板上直接调它 = 内容写进了隐藏的聊天页，人看着就是"点了没反应"（踩过）。
      // setNav('messages') 里会 showView('chat')，跟其它几个入口的走法一致。
      setNav('messages');
      openConversation(el.dataset.kbConv).catch((e) => toast(e.message, 'error'));
    };
  });
  // 列头「＋」：在那一列新建任务（只有「想法」「待办」两列有这个入口，见 kbColumn 的注释）
  view.querySelectorAll('[data-kb-add]').forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      taskDialog(taskProject(el.dataset.kbAdd), el.dataset.kbAdd);
    };
  });
  // 手工卡：拖到别的列 = 改状态；× = 删掉
  view.querySelectorAll('[data-kb-manual]').forEach((el) => {
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', el.dataset.kbManual);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
  });
  view.querySelectorAll('[data-kb-col]').forEach((colEl) => {
    colEl.addEventListener('dragover', (e) => {
      // 只让手工卡进来：流程/聊天的卡状态归平台管，拖它们没意义
      if (![...(e.dataTransfer?.types ?? [])].includes('text/plain')) return;
      e.preventDefault();
      colEl.classList.add('drop-hot');
    });
    colEl.addEventListener('dragleave', () => colEl.classList.remove('drop-hot'));
    colEl.addEventListener('drop', async (e) => {
      e.preventDefault();
      colEl.classList.remove('drop-hot');
      const taskId = e.dataTransfer.getData('text/plain');
      const card = view.querySelector(`[data-kb-manual="${CSS.escape(taskId)}"]`);
      if (!taskId || !card) return; // 拖的不是手工卡
      const toStatus = COL_STATUS[colEl.dataset.kbCol];
      if (!toStatus || card.dataset.col === colEl.dataset.kbCol) return;
      try {
        const res = await api(`/api/projects/tasks/${encodeURIComponent(taskId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: toStatus }),
        });
        // 拖进「进行中」＝开工（跟同类产品一样：状态到位 + 有执行人就派活）。
        // 派没派出去要说一声：两种结果在看板上一模一样（卡都在「进行中」列），
        // 不吭声的话人会以为已经在跑了。
        const started = !!res?.started;
        // 拖完这张卡可能就不在当前筛选里了：看板一列混两个状态词
        //（「已阻塞」列收已阻塞 · 已停止；「待办」列收流程的「待办」），拖进去落的是**这一列的默认状态**。
        // 不吭声的话卡片会"当场消失"，看着像拖丢了 —— 所以直说一句。
        // 只看**状态**那一维：这张卡原来是看得见的，说明负责人/项目两维它本来就过，
        // 而拖拽只改状态，别把别的维度也算一遍（算错了会误报）。
        const hidden = (S.kbFilter?.statuses?.length ?? 0) > 0 && !S.kbFilter.statuses.includes(toStatus);
        await refresh();
        // 由流程执行的卡（2026-10-26）：拖进「进行中」不是派人，是**发起那条流程实例**——
        // 响应里 `started` 照样是 true，但派给谁由流程当前节点决定，说"派给执行人"会指错地方。
        if (started && res.task?.flowRunId) {
          hint('流程已经起来了 —— 到流程实例里看每一步');
        } else if (started) {
          const who = (S.personas ?? []).find((p) => p.id === res.task?.assigneePersonaId)?.name;
          hint(`已经派给${who ? `「${who}」` : '执行人'}开跑了 —— 进展在他那条会话里看`);
        } else if (toStatus === '进行中') {
          // 真人执行的卡（2026-10-31）：有执行人、但不起会话 —— 别说成"没有执行人"
          hint((S.users ?? []).some((u) => u.id === res.task?.assigneeUserId)
            ? '卡移到「进行中」了；这张卡派给了真人，不起会话也不自动开跑'
            : '卡移到「进行中」了；这张卡没有执行人，所以不会自动开跑');
        }
        if (hidden) toast(`卡已经改成「${toStatus}」了，但当前筛选看不到它 —— 点右上角「清除」就能看见。`);
      } catch (err) {
        // 派不出去时服务端会原样说原因（"没开工：他还在跑上一条…"），状态不会被改掉
        toast(err.message, 'error');
        await refresh();
      }
    });
  });
  view.querySelectorAll('[data-kb-del]').forEach((el) => {
    el.onclick = async (e) => {
      e.stopPropagation();
      if (!(await confirmDo('删掉这张任务卡？'))) return;
      try {
        await api(`/api/projects/tasks/${encodeURIComponent(el.dataset.kbDel)}`, { method: 'DELETE' });
        await refresh();
      } catch (err) {
        toast(err.message, 'error');
      }
    };
  });
  /*
   * 本地卡（手工 / 仓库值班）：**点开卡片详情** —— 看全文、改标题描述、**改执行人**、自动开工、删掉。
   * 看板行是**截断过**的（标题 70 字、描述 90 字），仓库值班写进来的证据与命令根本看不全；
   * 而且建卡之后原来没有改执行人的入口（2026-10-17 用户问"怎么给这个任务指定人物"）。
   */
  view.querySelectorAll('[data-kb-open]').forEach((el) => {
    el.onclick = (e) => {
      if (e.target.closest('[data-kb-del]')) return; // × 自己处理，别把弹窗也带出来
      openTaskCardPage(el.dataset.kbOpen);
    };
    el.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openTaskCardPage(el.dataset.kbOpen);
      }
    };
  });
  /*
   * 派到分公司的卡（2026-11-01 二十改）：**验收 / 撤销**长在卡上 —— 原来这俩动作只在
   * 协作中心的「我派出去的活」表里，那张表撤了（看板上本来就有同样的卡，多一处展示
   * 反而要对两遍状态）。PATCH /api/collab/tasks/:id 与协作中心原来发的是同一个接口。
   */
  view.querySelectorAll('[data-kb-cl-done]').forEach((el) => {
    el.onclick = async (e) => {
      e.stopPropagation();
      try {
        await api(`/api/collab/tasks/${encodeURIComponent(el.dataset.kbClDone)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: '已完成' }),
        });
        toast('已验收', 'ok');
        await refresh();
      } catch (err) {
        toast(err.message, 'error');
      }
    };
  });
  view.querySelectorAll('[data-kb-cl-cancel]').forEach((el) => {
    el.onclick = async (e) => {
      e.stopPropagation();
      const ok = await confirmDo(
        '撤销这个任务？\n取消之后两边都不能再改（分公司那边的卡会变成「已取消」，留着当痕）。',
        { title: '撤销任务', ok: '撤销' },
      );
      if (!ok) return;
      try {
        await api(`/api/collab/tasks/${encodeURIComponent(el.dataset.kbClCancel)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: '已取消' }),
        });
        toast('已撤销', 'ok');
        await refresh();
      } catch (err) {
        toast(err.message, 'error');
      }
    };
  });
  /*
   * 「刷新 PR」：一次把所有关联了 PR 的卡查一遍（服务端 `POST /api/git/prs/refresh`）。
   * 服务端顺手跑 `afterMerged` —— 合并了的「进行中」会变成「待验收」，所以必须 **await refresh()** 重画，
   * 不能只把按钮改回来：卡片列变了人得当场看见。
   * 失败清单不整段吞掉：第一张的原因写出来（多半是令牌过期 / 令牌没那个仓库的权限），
   * 剩下的只报个数 —— 那种情况十有八九是同一个原因，刷十行同样的字只会把人埋了。
   */
  view.querySelector('[data-kb-pr-refresh]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '查询中…';
    try {
      // 项目看板只查本项目的（按钮上的 n 就是这个数）；全局面板 S.projectId 是空的 → 查全部
      const q = S.projectId ? `?projectId=${encodeURIComponent(S.projectId)}` : '';
      const r = await api(`/api/git/prs/refresh${q}`, { method: 'POST' });
      const bad = r.failed ?? [];
      await refresh();
      toast(`已查 ${r.updated ?? 0} 张 PR 的最新状态${bad.length ? `；${bad.length} 张没查到：${bad[0].error}` : ''}`);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = label;
      toast(err.message, 'error');
    }
  });
}



/**
 * **任务卡详情页**（2026-10-17）：看板点开一张本地卡（手工 / 仓库值班）进这里。
 *
 * 为什么做成"页"而不是弹窗：
 *   · 卡上写的是"这件事的来龙去脉"（仓库值班把结论、证据、链接全写进描述），弹窗那点地方不够；
 *   · 看完往往要**接着办** —— 办的过程就是跟执行人说句话，所以这一页要有**往来**。
 *
 * 聊天完全复用既有那套（不另造）：
 *   取消息 `GET /api/conversations/:id`（messages + runs）→ `bubble()` 画；
 *   发消息 `POST /api/conversations/:id/messages` → 拿 runId → `streamRun()` 接实时流；
 *   实时输出跟主聊天页一个写法：**一个气泡里追加分块**，收尾后从库里重画（别留半截）。
 * 「待办 + 已指定执行人」自动开工，跟建卡时那个「立即开始」同一条服务端链路（`startProjectTask`）。
 */
/**
 * 这张任务卡是从**哪个入口**点进来的（决定面包屑和「返回」去哪）：
 *   'all'     = 全局任务看板（工作台 → 任务看板）
 *   'project' = 某个项目的看板
 * 打开时从 S.boardAll 取一次就定下来 —— 之后 S.boardAll 会被清掉，不能再看它。
 */
export let taskCardFromAll = false;



/**
 * 这张卡是**从流程的某一步**点进来的吗（2026-10-19）：`{ runId, taskId, runTitle, nodeName }`，否则 null。
 *
 * 跟上面那个 `taskCardFromAll` 不是一回事，两个都留着：
 *   · `taskCardFromAll` 决定**离开时回哪**（看板 / 项目 / 流程）；
 *   · 这个只决定**页头写不写那行来路**。
 * 合在一起会逼着做二选一 —— 从流程进来的卡，回程本来就该是流程，不冲突。
 */
export let taskCardFromFlow = null;



/*
 * 手机整页开着的一张卡（2026-11-05 任务卡手机版重做）：
 *   · `tcPageOpen` —— 此刻屏幕上是手机整页的卡（弹窗那条路不算，桌面也不算）；
 *   · `tcCardLeave` —— 画回上一级的函数（渲染时赋值 = backTo：看板 / 项目 / 流程）。
 * 手机开卡时压一格 `{tcCard:true}` 历史（openTaskCardPage），返回手势/返回键退掉
 * 这一格 → 下面的 popstate 监听把画面画回上一级 —— 与「新建任务」页同一条路。
 */
let tcPageOpen = false;
let tcCardLeave = null;
/*
 * 手机任务卡上的「讨论抽屉」（2026-11-05）：该由谁来收画面。
 * 渲染时赋值（非手机/弹窗那条路赋 null），模块级的两条监听（popstate / Esc）只认这一个钩子 ——
 * 页面每次重画都挂一遍监听的话，同一屏上会叠出好几份，一次返回关几层。
 */
let tcSheetClose = null;
/*
 * 讨论抽屉是不是铺满整屏了（2026-11-05 用户要的「最大化」）。
 * 存模块级而不是只挂 class：页面重画（换卡 / 跨断点）会整块重建 DOM，
 * 面板得按上次的选择长出来；关掉抽屉再点开也还是上次那个高度 —— 别把人的选择忘掉。
 */
let tcSheetMax = false;

/*
 * 跨过 900px 断点时重画当前这张卡（2026-11-05 讨论抽屉带来的一条收尾）：
 * mbTC（手机整页形态）在**画的时候**定死 —— 讨论流/输入条在手机版进抽屉、桌面版留在页面上。
 * 窗口从窄拖宽（或反向）不重画的话，宽屏上输入条会跟着抽屉一起"消失"。
 * 桌面没有系统返回键这回事，重画也不动历史格；S.route 里就记着当前卡的 id。
 */
window.matchMedia('(max-width: 900px)').addEventListener('change', () => {
  if (!tcPageOpen || S.route?.view !== 'taskCard' || !S.route?.id) return;
  document.body.classList.remove('tc-sheet-open');
  paintTaskCardPage(S.route.id).catch(() => { /* 画不回来就算了，下次进页自愈 */ });
});



export async function openTaskCardPage(taskId, opts = {}) {
  // 来源定死：恢复位置时从 route 里带回来（刷新也还记得），否则看当前的 S.boardAll
  taskCardFromAll = opts.fromAll ?? !!S.boardAll; // 必须在 S.boardAll = false 之前读
  /*
   * ⚠️ 这张卡**只从列表（看板）进整页**（2026-10-26 定）：从会话的卡票、从流程的某一步
   *    点开走的是弹窗（`openTaskCardDialog`）—— 那两种都是"人本来在别处，就手看一眼"。
   *    所以这里没有"从哪场会话来"这种来路了，回程只有看板 / 项目两条。
   */
  /*
   * 从流程那一步点进来的（2026-10-19）：记下"这条卡是哪条流程、哪个节点"。
   * 只为了在页头写一行来路 —— 人刚在流程页看着「写代码」这一步，点进来要还认得出是它。
   * 传 null 就是"不是从流程来的"（从看板点进来的），页头不写那行。
   * ⚠️ 路由里必须带上它：不带的话刷新一下页头那行就没了，看着像"进错页面"。
   */
  taskCardFromFlow = opts.fromFlow ?? null;
  setRoute('taskCard', { id: taskId, fromAll: taskCardFromAll, fromFlow: taskCardFromFlow });
  /*
   * 手机：这一页压一格历史 —— 系统返回键/手势 = 回上一级（与「新建任务」页同一条路，
   * popstate 里画回上一级，不再另外压格）。桌面不压：桌面没有系统返回键这回事，
   * 想回看板点面包屑/左栏。已有这格（刷新恢复）就复用，不重复压。
   */
  tcPageOpen = document.body.classList.contains('mb-narrow');
  if (tcPageOpen && !history.state?.tcCard) history.pushState({ tcCard: true }, '');
  const view = $('pluginView');
  view.classList.add('kb-page'); // 这一页要满屏（见 style.css 的 #pluginView.kb-page）
  S.view = 'plugin';
  showView('plugin'); // 看板点进来时它已经 shown；刷新恢复/直达时它还 hide 着 —— 这里统一打开
  S.plugin = null;               // 任务卡不是插件，别让插件那条路抢走位置
  S.projectList = false;
  S.boardAll = false;
  savePlace();
  await paintTaskCardPage(taskId);
}



/** 弹窗里那张卡接着的实时流（关弹窗时要掐掉 —— 见 openTaskCardDialog） */
export let tcDlgStream = null;



/** 关掉任务卡弹窗（同一时刻只该有一个；开新的之前先收掉旧的） */
export function closeTaskCardDialog() {
  document.getElementById('tcDlg')?.close?.();
}



/**
 * 在**弹窗**里打开一张任务卡（2026-10-19）。
 *
 * 为什么不是整页跳转：人在流程时间轴上看着「写代码」这一步，点「任务」是想看/改这一步的
 * 细节 —— 整页换掉等于把他从那条流程里拽走，改完还得自己找回去（用户原话："操作体验不好"）。
 * 弹窗盖在时间轴上，关掉就还在刚才那一步，顺手把这一页重新拉一遍
 * （这一步刚建出来的卡要认上、经办人/会话跟着刷新）。
 *
 * 形态照定时任务那个两栏大弹窗（`.sch-dlg`）：定高、里面自己滚、右上角有全屏。
 * ⚠️ 不用 `<form>`：任务卡里那些按钮（关联 PR / 刷新 / 取消关联）没标 type，
 *    进 form 就成了提交按钮，一点就把弹窗关了（隐式提交这个坑在别处踩过一次）。
 */
export async function openTaskCardDialog(taskId, opts = {}) {
  closeTaskCardDialog(); // 只留一个
  const dlg = document.createElement('dialog');
  dlg.id = 'tcDlg';
  dlg.className = 'tc-dlg';
  dlg.setAttribute('data-max', ''); // 讨论区一长，占满屏舒服（wireDialogHead 认这个属性）
  /*
   * 弹窗头里**没有「删除」**（2026-10-26 用户截图要求删掉这颗）。
   * 理由是这颗按钮放错了地方：弹窗是"人在别处、就手看一眼、补一句话"的轻界面，
   * 删卡是不可逆动作，只留在整页详情页的页头 —— 那里才是专门处理这张卡的地方。
   */
  dlg.innerHTML = `
    <div class="tc-dlg-wrap">
      <b>任务卡</b>
      <div id="tcDlgBody"></div>
    </div>`;
  document.body.append(dlg);
  wireDialogHead(dlg.querySelector('.tc-dlg-wrap'));
  const head = dlg.querySelector('.dlg-head');
  // 标题带上节点名：不写的话，一张「测试2 · 写代码」摆在弹窗里，得自己回想是哪一步
  const titleEl = head?.querySelector('b');
  if (titleEl && opts.fromFlow?.nodeName) titleEl.textContent = `任务卡 · ${opts.fromFlow.nodeName}`;

  const cleanups = [];
  dlg.addEventListener('close', () => {
    for (const fn of cleanups) { try { fn(); } catch { /* 摘不掉也不影响 */ } }
    tcDlgStream?.close?.();
    tcDlgStream = null;
    dlg.remove();
    /*
     * 刷回流程时间轴（2026-10-19）。
     *
     * 为什么要刷、为什么"看起来没变化"是正常的：
     *   时间轴那一行显示的是 `workflow_tasks` 自己的状态（已阻塞 / 已完成…），
     *   而卡上那个「状态」是 `project_tasks` 的 —— **两份数据，同一个词的两种含义**
     *   （早先定过：流程那一套状态在 workflow_tasks，卡上不改它，两处各记各的）。
     *   所以改卡的状态不会让那一行变字；这里刷的是**别的**：这一步现在有没有卡
     *   （`projectTaskId` 是刚建出来的话要认上）、经办人、以及刚聊出来的会话。
     *   ⚠️ 别为了"看着有变化"去把卡状态反写进 workflow_tasks —— 那会让流程状态机
     *      跟着人改卡而乱走（卡上点「已完成」＝悄悄把流程那一步也办了）。
     *
     * 只在这条流程还开着的时候刷 —— 人已经切走就别抢他的页面。
     */
    const runId = opts.fromFlow?.runId;
    if (runId && S.view === 'flow' && S.flowRunId === runId) paintRun(runId).catch(() => {});
  });

  taskCardFromFlow = opts.fromFlow ?? null; // 删完卡之后 backTo 用得上
  dlg.showModal();
  await paintTaskCardPage(taskId, { dlg, cleanups });
  return dlg;
}



/**
 * 画一张任务卡。**画在哪**由 `opts.dlg` 决定（2026-10-19）：
 *   · 不传 —— 画进 `#pluginView`（整页，看板 / 项目点进来那条路）；
 *   · 传了 dialog —— 画进弹窗里（**流程的某一步**点进来那条路）。
 *
 * 为什么分两条路而不是统一成一种：从**列表**点进详情，换页是自然的（列表就在左栏，
 * 换页只是把主区占满）；从**流程时间轴**点「任务」是"看一眼这一步的细节"，
 * 整页换掉等于把他从那条流程里拽走 —— 那种该弹窗（见 openTaskCardDialog）。
 *
 * 两条路共用这一份内容与这一套接线（全部按 id 取元素，id 在同一时刻只存在于一处），
 * 差别只有：页头那行（弹窗用自己的头部）、「来自流程」那行（弹窗不写）、离开时去哪。
 */
export async function paintTaskCardPage(taskId, opts = {}) {
  const dlg = opts.dlg ?? null;
  const host = dlg ? $('tcDlgBody') : $('pluginView');
  /*
   * 挂在 document 上的那两个"点别处收起"：
   *   · 整页走 `window.__pageCleanups`（换页时统一摘，见 setRoute）；
   *   · 弹窗没有换页这一说，走弹窗自己那一份 —— 关的时候摘。
   *     不分开的话，每开一次弹窗就往 document 上多叠一层监听。
   */
  const cleanups = opts.cleanups ?? (window.__pageCleanups ??= []);
  let task;
  try {
    task = (await api(`/api/projects/tasks/${encodeURIComponent(taskId)}`)).task;
  } catch (e) {
    // 整页那条路还带页头（左栏点别的就走了）；弹窗里就一句话 + 右上角的 ×
    host.innerHTML = `${dlg ? '' : headRow(breadcrumb([
      { label: '工作台', to: 'workbench' },
      { label: '任务看板', to: 'board' },
      { label: '任务卡' },
    ]))}
      <div class="empty" style="padding:24px 4px">任务取不到：${esc(e.message)}</div>`;
    return;
  }
  /*
   * **这张卡由流程执行**（2026-10-26）：卡已经绑上一条流程实例（flowRunId 有值），
   * 详情就是那条实例页 —— 卡的状态/执行人现在都从流程"当前那一步"派生（看板行也一样），
   * 再画一份改不动的旧卡页只会让人以为"这儿能改"，服务端那边也会直接 400 挡回来。
   * 往来同理：发起之后是跟流程当前步骤的经办人进行，卡页这套评论区在这张卡上是空的。
   * 所以先把它带到实例页，后面那套卡页一个字都不画。
   */
  if (task.flowRunId) {
    // 弹窗那条路只从流程时间轴进来，正常情况下不会有"由流程执行"的卡；真撞上先把弹窗收起，
    // 别让实例页被压在一个空弹窗底下（右上角 × 看着像没反应）。
    if (dlg) dlg.close('done');
    try {
      await openFlowRun(task.flowTemplateId ?? null, task.flowRunId);
    } catch (e) {
      // 实例页取不到（网络 / 服务端）也要说一声：不然人点开这张卡只会看到"什么也没发生"
      toast(`这张卡由流程执行，但流程实例没打开：${e.message}`, 'error');
    }
    return;
  }
  /*
   * 还没发起的流程卡（建卡时选了流程、但状态是「想法」→ 先挂着不发起）：
   * 执行人这一格归流程，人不能选；页面上要把"改成进行中就发起"说清楚，
   * 否则这张卡看起来跟普通手工卡一模一样，人不知道它其实绑着一条流程。
   */
  const flowOnly = !!task.flowTemplateId;
  // 模板名从已发布清单里找；找不到（模板后来被删/下架）就退回写 id，总比什么都不写强
  const flowName = flowOnly
    ? ((S.flowPublished ?? []).find((f) => f.id === task.flowTemplateId)?.name ?? task.flowTemplateId)
    : '';
  const proj = (S.projects ?? []).find((p) => p.id === task.projectId) ?? null;
  const isRepo = task.source === 'repo';
  // 协作卡（2026-10-31）：内容是中心派下来的，本地只读标题/描述（改由中心改）
  const isCollab = task.source === 'collab';
  // 流程派生的卡（sourceKey = flow:<runId>:<nodeId>:<visit>，2026-10-19）：身份由流程那一行代表，
  // 删了没意义——看板流程行照旧、下次点流程那步的「任务」还会再建一张。删除键不给它。
  const isFlowCard = !!task.sourceKey;
  const assignee = S.personas.find((p) => p.id === task.assigneePersonaId) ?? null;

  /*
   * 上一屏的讨论抽屉不能带进这一屏（2026-11-05）：下面是整块 innerHTML 重画，抽屉节点一起作废，
   * 但 body 上的 tc-sheet-open 是个全局状态 —— 留着它，遮罩其实已经没了、Esc/返回键的判断
   * 却还当抽屉开着，一次返回就无声吞掉一格。重画前先收干净，历史格也顺手退回卡页那一格。
   */
  if (document.body.classList.contains('tc-sheet-open')) {
    document.body.classList.remove('tc-sheet-open');
    if (history.state?.tcSheet) history.replaceState({ ...(history.state ?? {}), tcSheet: false }, '');
  }

  // 往来：派过活才有会话
  let conv = null;
  if (task.conversationId) {
    try { conv = await api(`/api/conversations/${encodeURIComponent(task.conversationId)}`); } catch { conv = null; }
  }
  const runningRun = (conv?.runs ?? []).find((r) => r.status === '跑中') ?? null;
  // 跑挂了的运行 id 集合：这些轮次的回话/占位行带「重跑一次」按钮（2026-10-30 用户："失败了可以再让它重新跑一次"）。
  // threadsHtml 每次重画会按最新 runs 重算 —— 重跑后新回话属于新 run，旧失败轮的按钮留着无妨（multica 同款）。
  let failedRunIds = new Set((conv?.runs ?? []).filter((r) => r.status === '失败').map((r) => r.id));
  let whoName = conv?.conversation?.personaName ?? assignee?.name ?? '执行人';

  /**
   * 评论区（2026-10-18）：**一条顶层评论 = 一个议题**，回复挂在它下面。
   *
   * 归属规则（为什么这么定）：
   *   · 我发的、没有 parentId → 新开一个议题；
   *   · 我发的、带 parentId → 挂回那个议题（这样"过几天回到第一个议题补一句"不会跑到最新那条下面）；
   *   · 他的回话 → 服务端按触发消息补了 parentId（见 runs.mjs；顶层评论的回复挂到评论本身），
   *     直接挂；老数据没这个字段时退化成"挂当前议题"，会话本身是时序的，紧跟着的就是它。
   */
  const cmtTime = (s) => {
    const t = String(s ?? '').replace('T', ' ');
    return t.length >= 16 ? t.slice(5, 16) : t;
  };
  // 开工时那条派活说明（带着项目契约与任务正文）：不是人写的评论，收成一行可展开
  const isStartNote = (m) => m.role === 'user' && String(m.text ?? '').includes('【任务 · ');

  // 真人署名（2026-10-31 用户概念落地）：消息带 senderUserName 且**不是自己** → 返回名字。
  // 卡评论区谁留的言各归各；没署名（员工/回执）或就是自己 → null，一切照旧。
  const humanOf = (m) =>
    m.role === 'user' && m.senderUserName && m.senderUserName !== (S.me?.name ?? '我') ? m.senderUserName : null;

  // 我自己的评论不再重复写名字 —— 头像上那个「我」就是名字，写两遍是噪声（他的回话仍然带名字）
  // 时间放回复下面（2026-10-29 用户："时间放回复下面"）；自己的评论头一行**整行不画** ——
  // 空着的 meta 行就是正文上面那条留白（用户实测指出）。
  // `replyTopicId`：议题里**最后一条**回复带「回复」按钮（2026-10-29 用户："最后一句加一个回复按钮"），
  // 点了挂回同一条议题 —— 输入框就地停靠在那条下面，接着聊。
  const cmtItem = (m, isNew = false, replyTopicId = null) => {
    const human = humanOf(m);
    const mine = m.role === 'user' && !human;
    const who = mine ? '我' : human ?? (m.run?.personaName || whoName);
    let main;
    if (m.pseudo === 'stop' || m.pseudo === 'fail') {
      // 没跑成的那几轮（见 timelineOf）：库里没有 assistant 消息 —— 不补这条，屏幕上就只剩
      // "我说了一句然后就没了"（2026-10-29 用户："意外终断或者被打断，整条消息都不显示了，这个不对"）
      const r = m.run ?? {};
      const began = Date.parse(String(r.startedAt ?? ''));
      const ended = Date.parse(String(r.endedAt ?? ''));
      const ran = Number.isFinite(began) && Number.isFinite(ended) && ended >= began ? ended - began : null;
      // 几秒就停的别写"跑了 00:00"—— 那不是信息，是噪音；上了 5 秒才值得说
      const dur = ran == null || ran < 5000 ? '' : ` · 跑了 ${fmtElapsed(ran)}`;
      main = m.pseudo === 'stop'
        ? '<div class="step stop">已停止生成' + esc(dur) + '（这一轮没有回话）</div>'
        : `<div class="step bad">没跑成：${esc(firstMeaningfulLine(r.error) || '运行失败（这次没留下原因）')}</div>`;
    } else {
      main = `<div class="tc-cmt-text">${renderMarkdown(m.text)}${attsHtmlOf(m.atts)}</div>`;
    }
    // 「重跑一次」：失败轮的回话（或没落回话的失败占位）脚上带一颗 —— multica 同款（2026-10-30）
    const failedRid = m.pseudo === 'fail' ? m.run?.id : (m.runId && failedRunIds.has(m.runId) ? m.runId : null);
    const rerunBtn = failedRid
      ? `<button type="button" class="tc-rerun" data-rerun="${esc(failedRid)}"
             title="让它带着同样的说明再跑一轮（续同一个会话，不用重发）">↻ 重跑一次</button>`
      : '';
    // data-mid：进度卡落点反查用 —— 拿消息 id 找它所在的议题（attach 的 host 解析链）
    return `<div class="tc-cmt${mine ? ' mine' : ''}${isNew ? ' is-new' : ''}" data-mid="${esc(m.id)}">
      ${mine ? smAvatar('我', 'me') : smAvatar(who, '', personaByName(who))}
      <div class="tc-cmt-main">
        ${mine ? '' : `<div class="tc-cmt-meta"><b>${esc(who)}</b></div>`}
        ${main}
        <div class="tc-topic-foot">
          <time class="tc-cmt-at">${esc(cmtTime(m.createdAt))}</time>
          ${replyTopicId ? `<button type="button" class="tc-reply" data-reply="${esc(replyTopicId)}">回复</button>` : ''}
          ${rerunBtn}
        </div>
      </div>
    </div>`;
  };

  /**
   * 议题分组：吃的是**时间线**（timelineOf 合成：消息 + 没跑成的那几轮运行）。
   * 意外中断 / 被打断的那几轮在库里**没有 assistant 消息**（服务端一个字没流出来就不落），
   * 只画消息的话屏幕上就是"我说了一句然后就没了" —— 把这些轮次补成一条安静的占位
   * （pseudo 消息），跟着时间排进它所在的议题（2026-10-29 用户："整条消息都不显示了，这个不对"）。
   */
  /**
   * 议题分组（2026-10-30 二定稿）：
   *   · 开工说明是**任务全局**的 —— 摘掉，不显示、不占分组；
   *   · 执行人第一条回话当主评论，他后续没带 parentId 的回话按时间挂进这条工作线程；
   *   · **我的评论**：点了「回复」发的（parentId 指向线程里某句话）→ 挂进那条议题；
   *     自己直接发的（无 parentId）→ **新议题、当主评论**（2026-10-30 用户："有的是新发的issue，就是主评论"）。
   * parentId 解析放宽到「议题里任何一条消息」—— 回复按钮带的是消息 id，不是议题头 id。
   */
  const topicsOf = (items) => {
    const topics = [];
    const byId = new Map();    // 议题头 id → 议题
    const inTopic = new Map(); // 线程里**任何**一条消息 id → 它所属的议题（parentId 解析用）
    const anchor = new Map();  // 被摘掉的开工说明 id → 它的回话所在的议题
    const skipped = new Set(); // 被摘掉的开工说明 id（回复它们 = 回到工作线程，见下）
    let cur = null;
    const put = (m, t) => { t.items.push(m); inTopic.set(m.id, t); };
    for (const it of items) {
      const m = it.kind === 'msg'
        ? it.m
        : {
            role: 'assistant',
            pseudo: it.kind,            // 'stop' | 'fail'
            run: it.r,
            id: 'run-' + it.r.id,
            createdAt: it.r.endedAt ?? it.r.startedAt,
            text: it.kind === 'stop' ? '已停止生成（这一轮没有回话）' : '没跑成',
          };
      if (isStartNote(m)) { skipped.add(m.id); continue; } // 全局上下文：不显示、不占分组
      // 明确挂载：回复按钮带的是消息 id，可能是议题头、线程中间某句话，
      // 也可能是**被摘掉的开工说明**（服务端把回复拍平到开工说明名下 —— 它才是底层会话的顶层；
      // 点嘉辉某句回话的「回复」，服务端存的是 hit.parentId = 开工说明 id）。锚点表负责把这层还原。
      const host = m.parentId ? (byId.get(m.parentId) ?? inTopic.get(m.parentId) ?? anchor.get(m.parentId)) : null;
      if (host) {
        cur = host;
        put(m, host);
      } else if (m.role === 'user') {
        // 我直接发的 = 新议题、当主评论
        cur = { id: m.id, head: m, items: [] };
        topics.push(cur);
        byId.set(m.id, cur);
        inTopic.set(m.id, cur);
      } else if (cur) {
        // 他没带 parentId 的回话（含中断占位）＝ 干活还在继续，挂进当前工作线程
        put(m, cur);
      } else {
        // 开头就是他的回话（开工说明被摘掉后通常就是这种）：当主评论
        cur = { id: m.id, head: m, items: [] };
        topics.push(cur);
        byId.set(m.id, cur);
        inTopic.set(m.id, cur);
      }
      // 他的回话挂在被摘掉的开工说明下 → 把那条开工说明记到这个议题名下：
      // 之后"回复开工说明"的消息（服务端拍平的产物）都回这条工作线程
      if (cur && m.parentId && skipped.has(m.parentId) && !anchor.has(m.parentId)) {
        anchor.set(m.parentId, cur);
      }
    }
    return topics;
  };

  // 折叠状态（2026-10-24 重做可见性）：折叠为了整齐，但不能把他的回话藏起来。
  //   · openTopics / collapsedTopics —— 用户手动展开/收起过的议题 id，重画（refreshThread
  //     整块重建 innerHTML）后要还原；手动操作优先于一切自动行为；
  //   · seenReplies —— 画过一遍的回复 id。重画时不在里面的就是**这轮新到的**：
  //     所在议题自动展开、回复本身高亮（Reddit 新评论那套）。首屏全部记"见过"，不乱弹。
  const openTopics = new Set();
  const collapsedTopics = new Set();
  const seenReplies = new Set();

  /**
   * 收工状态条（2026-10-30 用户："用户感知不到活什么时候干完"）：
   * 讨论区顶上一条横幅，一眼回答"他到底干完没有"——
   *   · 待验收  → 绿：干完了，等你验收；
   *   · 失败    → 红：这轮没跑成，消息脚上有重跑钮；
   *   · 已阻塞  → 黄：他停在这等你拿主意；
   *   · 进行中但没在跑的轮次 → 灰：两轮之间/排队（这种"看着停了其实没完"最容易误会）。
   * 他正在跑时不画 —— 那时候进度卡本身就是信号。
   */
  const stateBanner = (d) => {
    const st = task.status;
    const runs = d?.runs ?? [];
    const live = runs.some((r) => r.status === '跑中');
    if (live) return '';
    const last = runs.filter((r) => r.endedAt).sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt)))[0];
    const when = last?.endedAt ? `（${esc(cmtTime(last.endedAt))} 收工）` : '';
    if (st === '待验收')
      return `<div class="tc-statebar ok"><b>✅ 活干完了</b> —— 等你验收${when}。上面他最后一句话就是结论。</div>`;
    if (st === '失败')
      return `<div class="tc-statebar bad"><b>这轮没跑成</b> —— 没干完。他消息脚上有「↻ 重跑一次」，点一下接着来。</div>`;
    if (st === '已阻塞')
      return `<div class="tc-statebar warn"><b>他停在这等你拿主意</b> —— 卡点就是上面最后一条，回他一句或改状态。</div>`;
    if (st === '进行中')
      return `<div class="tc-statebar idle"><b>还没干完</b> —— 他在这两轮之间（上一轮刚收尾，下一轮还没起）。说句话或等他自己继续${when}。</div>`;
    return '';
  };

  const threadsHtml = (d) => {
    const msgs = d?.messages ?? [];
    if (!msgs.length) {
      return `<div class="nc-empty">还没有评论。</div>`;
    }
    const banner = stateBanner(d);
    // 时间线 = 消息 + 没跑成的那几轮运行（中断/停止的占位也按时间排进去，见 topicsOf）
    failedRunIds = new Set((d?.runs ?? []).filter((r) => r.status === '失败').map((r) => r.id));
    const topics = topicsOf(timelineOf(msgs, d?.runs ?? []));
    // 首屏先把库里已有的都记"见过"：高亮只给**这一页打开之后**新到的回话，
    // 不然每次进卡满屏蓝，跟没折一样。
    if (seenReplies.size === 0) {
      for (const t of topics) for (const m of t.items) seenReplies.add(m.id);
    }
    const html = topics
      .map((t) => {
        // 开工说明在 topicsOf 里就被摘掉了（任务全局上下文，不进讨论区），这里的 head 一定是真评论
        const head = t.head
          ? `<div class="tc-topic-title">${renderMarkdown(t.head.text)}${attsHtmlOf(t.head.atts)}</div>`
          : '';
        // 「只留言」的便签给一枚小标记：不然它和普通评论长得一模一样，看不出这条没叫醒他
        const noteTag = t.head?.note
          ? '<span class="tc-tag" title="便签：只给你看，没叫醒他">便签</span>'
          : '';
        // 时间放回复下面（2026-10-29 用户："时间放回复下面"）；上面不留空行 ——
        // 自己的评论头一行什么都不写，名字/时间/回复全收进正文底下那一行（他的回话头一行仍是名字）。
        // 别的真人开的话题同理：头一行写他，别让他的话顶着"我"的名字（2026-10-31）。
        const headHuman = t.head ? humanOf(t.head) : null;
        const meta = t.head && t.head.role !== 'user'
          ? `<div class="tc-topic-meta"><b>${esc(whoName)}</b>${noteTag}</div>`
          : headHuman
            ? `<div class="tc-topic-meta"><b>${esc(headHuman)}</b>${noteTag}</div>`
            : '';
        const foot = t.head
          ? `<div class="tc-topic-foot">
               ${/* 自己的评论没有作者行（名字/时间都在落款），便签标记就落到落款这一行 ——
                   否则"便签"和普通评论在界面上完全分不出来（2026-11-05 手机自测发现） */ ''}
               ${meta ? '' : noteTag}
               <time class="tc-cmt-at">${esc(cmtTime(t.head.createdAt))}</time>
               <button type="button" class="tc-reply" data-reply="${esc(t.head.id)}">回复</button>
             </div>`
          : '';
        // 折叠照旧（全铺开确实杂），但他的回话不再被藏住：
        //   1. 折叠条露最新一条回复的作者+摘要，收着也能扫到他说了什么；
        //   2. 这轮新到的回复让议题自动展开、回复本身高亮 ——
        //      除非用户手动收起过这条（collapsedTopics），手动操作优先。
        // 折叠照旧（全铺开确实杂），但他的回话不再被藏住：这轮新到的回复让议题
        // 自动展开、回复本身高亮 —— 除非用户手动收起过这条（collapsedTopics），
        // 手动操作优先。折叠条本身照抖音（2026-11-06 用户发截图拍板）：只报条数。
        const hasNew = t.items.some((m) => !seenReplies.has(m.id));
        const isOpen = openTopics.has(t.id) || (hasNew && !collapsedTopics.has(t.id));
        let replies = `<div class="tc-replies" data-replies="${esc(t.id)}"></div>`;
        if (t.items.length) {
          const items = t.items.map((m, i) =>
            cmtItem(m, !seenReplies.has(m.id), i === t.items.length - 1 ? t.id : null),
          ).join('');
          // 折叠条两态文案照抖音（2026-11-06 用户发截图拍板）：左一条短灰线，
          // 折叠「展开N条回复 ⌄」/ 展开「收起N条回复 ⌃」—— 不再露最新回复预览
          // （2026-10-24 那版"作者：摘要"撤了；藏话的问题仍由 hasNew 自动展开兜着）。
          replies = `<details class="tc-replies" data-replies="${esc(t.id)}"${isOpen ? ' open' : ''}>
               <summary class="tc-replies-toggle">
                 <span class="tc-replies-fold">展开${t.items.length}条回复</span>
                 <span class="tc-replies-unfold">收起${t.items.length}条回复</span>
                 <svg class="tc-replies-caret" viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5"/></svg>
               </summary>
               <div class="tc-replies-body">${items}</div>
             </details>`;
        }
        // 作者行在**正文上面**（跟普通评论一致）：头像旁边第一行是"我"，再往下才是内容 ——
        // 反过来会让人以为下面又开了一条评论（2026-10-18 用户指出）。时间/回复在正文底下的落款行。
        return `<article class="tc-topic" data-topic="${esc(t.id)}">
          ${t.head ? (t.head.role === 'user'
            ? (headHuman ? smAvatar(headHuman, '', personaByName(headHuman)) : smAvatar('我', 'me'))
            : smAvatar(whoName, '', personaByName(whoName))) : ''}
          <div class="tc-topic-body">
            ${meta}${head}
            ${foot}
            ${replies}
          </div>
        </article>`;
      })
      .join('');
    // 画完统一记"见过"：下次重画时不在 seenReplies 里的才是新到的
    for (const t of topics) for (const m of t.items) seenReplies.add(m.id);
    return banner + html;
  };

  /**
   * 「重跑一次」（2026-10-30 用户："失败了可以再让它重新跑一次，像 multica 那样"）：
   * 失败/阻塞的卡重新派活 —— 走「开始工作」同一条链路（startProjectTask），
   * 开工说明会对着**同一个会话**再发一次，他接着上次的上下文继续干，不用重发现场。
   * 跑着的卡不许重（startProjectTask 自己也会拦，这里先拦是为了给句人话）。
   * ⚠️ 它的点击委托**不能在这里挂** —— 下面 host.innerHTML 才整页重建（#tcThreads 是新的），
   *    提前挂 = 挂在旧节点/null 上，点击永远哑火（2026-10-30 实测：点了没反应）。委托在后面 wireReplyButtons 旁。
   */
  const rerunTask = async (topicId = null) => {
    if (liveRunId) { toast('他正在跑，等这轮结束再说。', 'error'); return; }
    // ⚠️ 必须 PATCH：startNow（保存并开始工作）长在 PATCH 分支里，PUT /tasks/:id 没人接 ——
    // 上一版写成 PUT，点了重跑就是一发哑弹（2026-10-30 用户："点击重跑没有反应"）
    const res = await api(`/api/projects/tasks/${encodeURIComponent(taskId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ startNow: true }),
    });
    if (res?.task) { task = res.task; refreshHeader(); }
    toast(`已重新交给 ${whoName}`);
    // 进度卡落在**点重跑的那条议题**里（不是"最后一个议题"—— 中间插了新评论就会挂错位置）
    if (res?.task?.runId) attach(res.task.runId, topicId); // 直接接上新一轮的实时进度
    else refreshThread(); // 没拿到 runId（比如在排队）就整块重画，跑起来后进度卡会自己出现
  };

  /**
   * 页面形态参照同类产品的任务详情（2026-10-18 用户要求"简洁一些"）：
   *   · 主区从上到下就是这件事本身：大标题 → 描述 → 讨论，别的一概不摆；
   *   · 属性全收进右栏三段：属性（状态/执行人/项目/来源）、Pull Request、详情（创建/更新时间）；
   *   · 页头只有「任务卡 + 删除」（原来的三级面包屑 `工作台 › 任务看板 › 任务卡`
   *     统一去掉返回后一并撤了；回看板靠左栏点那一行 —— 左栏本来就是看板那一列）。
   */
  /*
   * 页头：**从流程进来的，标题下面补一行来路**（2026-10-19）。
   * 人刚才在流程时间轴上看着「写代码」这一步，点进来要还认得出是它 ——
   * 不然一张「测试2-不指定 · 写代码」的卡摆在眼前，得自己回想"这是哪条流程第几步"。
   * 那行**可以点**：直接回那条流程（跟删完卡之后回的是同一个地方）。
   * 从看板进来的没有这一行 —— 来源本来就在左栏上写着，再写一遍是噪音。
   */
  /*
   * 弹窗里**不写**那行来路：流程时间轴就在弹窗背后露着，弹窗自己的标题也已经写了
   * 「任务卡 · 节点名」——再把"你从哪来"写一遍是噪音。整页那条路照旧要写（那边没有上下文）。
   */
  const fromFlowBar = !dlg && taskCardFromFlow?.runId
    ? `<button type="button" class="tc-from" id="tcFromFlow"
         title="回到这条流程的时间轴">
         <span class="tc-from-k">来自流程</span>
         <b>${esc(taskCardFromFlow.runTitle ?? '')}</b>
         ${taskCardFromFlow.nodeName ? `<span class="tc-from-sep">›</span> <span>${esc(taskCardFromFlow.nodeName)}</span>` : ''}
       </button>`
    : '';
  /* 页头右侧那颗「删除」：流程派生的卡不摆（身份由流程行代表，删了没意义 —— 2026-10-23 用户拍板）。
     ⚠️ 先算成常量再插值：这里是**外层模板里再嵌一层模板**，直接写 `${isFlowCard ? '' : '…'}`
        会被外层先吃掉，整段 `headRow(...)` 的调用就被切断了（多行再嵌引号尤其容易踩）。 */
  const delBtn = isFlowCard || isCollab ? '' : '<button class="tc-del" id="tcDel" title="删掉这张卡（＝忽略它）">删除</button>';
  /* PR 状态词（手机行 / 桌面右栏两处用） */
  const prStateText = (state) => (state === 'merged' ? '已合并' : state === 'closed' ? '已关闭' : state === 'open' ? '开着' : '状态未知');
  /*
   * **手机整页形态**（2026-11-05 任务卡手机版）：窄屏不再是"桌面页压小"——
   * 原来标题、描述、讨论、右栏属性表按桌面 grid 压成一列，属性表沉在讨论区底下，
   * 要滚到底才看得到执行人，页头还是三级面包屑。手机版按看板 v2 / 员工详情的同一套语汇：
   *   · 导航栏三槽（‹ / 任务卡）—— 面包屑撤掉，返回键/手势回上一级（见 openTaskCardPage）；
   *   · 状态做成标题上方的一颗**色点胶囊**（点它改状态 → 全屏选择页）；
   *   · 属性收成一张 inset grouped 卡：执行人（点开选择页）/ 项目 / 来源 / PR / 删除；
   *   · 创建/更新时间收成卡下一行脚注；
   *   · **没有 PR 的关联/建 PR**（主理人 2026-11-05 口径：手机端不建 PR，
   *     真要在手机上开 PR 就在对话里说一声让员工办）—— 已关联的只留一行可点进 GitHub。
   * 弹窗那条路（流程步骤 / 会话卡票）不算手机整页：弹窗有自己的头，结构不动。
   */
  const mbTC = !dlg && document.body.classList.contains('mb-narrow');
  const stKey = Object.keys(COL_STATUS).find((k) => COL_STATUS[k] === task.status) ?? 'other';
  const whoLabel = flowOnly
    ? '（由流程执行）'
    : assignee?.name
      ?? (S.users ?? []).find((u) => u.id === task.assigneeUserId)?.name
      ?? '（没派活）';

  /*
   * 讨论条数（2026-11-05）：导航栏那颗气泡上的角标、抽屉标题上的数字。
   * 数的是**议题**（顶层评论）不是消息 —— 一条议题下面挂十句回复，人看到的还是"一件事"。
   * 开工说明在 topicsOf 里就被摘掉了，跟讨论区里画出来的一致。
   */
  const cmtCount = topicsOf(timelineOf(conv?.messages ?? [], conv?.runs ?? [])).length;
  const cmtN = cmtCount > 99 ? '99+' : String(cmtCount);

  /* 讨论流本体：整页（桌面）/ 抽屉（手机）两处共用同一份内容，谁在 DOM 里谁就是 #tcThreads */
  const threadsInner = threadsHtml(conv);

  /*
   * 输入条（附件 / 档位 / 发送 / 停靠横幅）。位置只有两种：
   *   · 桌面 —— 摆在 .tc-main 末尾（点「回复」时整条搬进那条议题下面，见 dockComposer）；
   *   · 手机 —— 常驻讨论抽屉底部（抽屉不开时它也就不在屏幕上）。
   */
  const composerBlock = `
        <div class="tc-composer" id="tcComposer">
          <!-- 回复横幅：输入框停靠到某条议题下面时亮出来，一句话说清"在回哪条"，✕ 取消（2026-10-24 重做） -->
          <div class="tc-reply-banner" id="tcReplyBanner" hidden>
            <span class="tc-reply-banner-text" id="tcReplyBannerText"></span>
            <button type="button" class="tc-reply-undock" id="tcReplyUndock" title="取消回复，回到新议题">✕</button>
          </div>
          <div class="tc-input-box">
            <textarea id="tcInput" rows="3" placeholder="留下评论…（回车换行）"></textarea>
            <div class="att-strip is-hidden" id="tcAttStrip"></div>
            <div class="tc-sendbar"><!-- 工具栏走文档流（2026-10-23）：原来绝对定位浮在 textarea 上，文字一滚动就从按钮后面穿过去 -->
              <button type="button" class="att-add" id="tcAttach" title="上传文件（也可直接粘贴图片）">＋</button>
              <input type="file" id="tcFilePick" multiple hidden />
              <div class="tc-mode-wrap">
                <button type="button" class="tc-mode" id="tcMode" data-mode="discuss"
                        title="这条发出去之后他要怎么处理">
                  <span class="tc-mode-dot"></span><span id="tcModeLabel">讨论</span><span class="tc-caret">▾</span>
                </button>
                <div class="tc-mode-menu" id="tcModeMenu" hidden>
                  <button type="button" data-pick="note">
                    <b>便签</b><span>只记在卡上给你看，不叫醒他</span>
                  </button>
                  <button type="button" data-pick="discuss">
                    <b>讨论</b><span>叫醒他聊、看代码、给方案，不动手改文件</span>
                  </button>
                  <button type="button" data-pick="execute">
                    <b>执行</b><span>叫醒他基于讨论真正干活</span>
                  </button>
                </div>
              </div>
              <button class="primary tc-send" id="tcSend" type="button" title="发送">发送</button>
            </div>
          </div>
          <!-- 档位三颗（2026-11-06 用户口径：键盘唤起后把便签/讨论/执行摊平，摆在
               **输入卡外面** —— 卡片底边与键盘之间那条区域）。只在手机抽屉的展开态
               显示（mobile.css §22b）；桌面还是卡内那颗「讨论 ▾」下拉。 -->
          <div class="tc-mode-chips" id="tcModeChips">
            <button type="button" data-chip="note"><span class="tc-mode-dot"></span>便签</button>
            <button type="button" data-chip="discuss"><span class="tc-mode-dot"></span>讨论</button>
            <button type="button" data-chip="execute"><span class="tc-mode-dot"></span>执行</button>
          </div>
          <div class="tc-composer-foot">
            <!-- 「停止生成」并进发送键了（跑着时发送键原地变身）—— 单摆那颗撤掉（2026-10-29） -->
            <div class="counter left" id="tcHint2"></div>
          </div>
        </div>`;

  host.innerHTML = `
    ${
      mbTC
        ? `<div class="detail-head tc-m-head">
             <button type="button" class="kb-l-navbtn back" data-tc-back aria-label="返回上一级">${KB_ICON_BACK}</button>
             <h1 class="kb-l-navtitle">任务卡</h1>
             <!-- 讨论入口（2026-11-06 定稿）：只留导航栏右上角这颗💬气泡，角标 = 议题数，
                  0 条时不摆。卡页底部那条常驻评论条（.tc-m-cmtbar）是过渡产物，已删。 -->
             <button type="button" class="kb-l-navbtn cmt" id="tcCmtBtn"
                     aria-label="讨论${cmtCount ? `（${cmtCount} 条）` : ''}">${KB_ICON_CHAT}<span class="tc-cmt-n" id="tcCmtN"${cmtCount ? '' : ' hidden'}>${cmtN}</span></button>
           </div>`
        : dlg
          ? ''
          : headRow(
              taskCardFromAll || !proj
                ? breadcrumb([{ label: '工作台', to: 'workbench' }, { label: '任务看板', to: 'board' }, { label: '任务卡' }])
                : breadcrumb([
                    { label: '工作台', to: 'workbench' },
                    { label: '项目', to: 'projects' },
                    { label: proj.name, to: 'projects', arg: proj.id },
                    { label: '任务卡' },
                  ]),
              delBtn,
            )
    }
    <div class="detail-body tc-page${dlg ? ' in-dlg' : ''}${mbTC ? ' tc-m' : ''}">
      <div class="tc-main">
        <div class="tc-main-scroll"${mbTC ? ' id="tcScroll"' : ''}>
          ${
            mbTC
              ? `<div class="tc-m-hero">
                   ${fromFlowBar}
                   <button type="button" class="tc-m-st" id="tcStatusChip" style="--st-c:var(--st-${esc(stKey)})" title="改状态">
                     <i aria-hidden="true"></i><span id="tcStatusText">${esc(task.status)}</span>
                   </button>
                   <!-- 手机标题/描述只读：device 身份的 PATCH 只收 {status, note}（E3702），
                        让人改了存不上比不让改更糟。要改内容去桌面，或在对话里让员工改。 -->
                   <h1 class="tc-title" id="tcTitleText">${esc(task.title)}</h1>
                   ${flowOnly
                     ? `<div class="tc-m-flownote">由流程「${esc(flowName)}」执行 —— 把状态改成「进行中」就发起；发起后往来在流程实例里看。</div>`
                     : ''}
                   <div class="tc-desc${task.description ? '' : ' empty'}" id="tcDescView">${task.description ? renderMarkdown(task.description) : '<span class="dim">添加描述…</span>'}</div>
                 </div>
                 <div class="tc-m-card">
                   ${
                     /* 执行人行手机上**只读**：服务端字段级闸（routes/project.mjs）对 device 身份
                        只放 {status, note}（E3702），改执行人是桌面端的事 —— 摆一行展示即可。 */
                     `<div class="tc-m-row"><span class="tc-m-k">执行人</span><span class="tc-m-v${flowOnly ? ' is-dim' : ''}">${esc(whoLabel)}</span></div>`
                   }
                   <div class="tc-m-row"><span class="tc-m-k">项目</span><span class="tc-m-v">${esc(proj?.name ?? '（项目已不在）')}</span></div>
                   <div class="tc-m-row"><span class="tc-m-k">来源</span><span class="tc-m-v">${isFlowCard ? '流程' : isCollab ? '总公司' : isRepo ? '仓库值班' : '手动建卡'}</span></div>
                   ${
                     /* 手机只留「已关联的 PR」一行可点进 GitHub：关联/建 PR/合并都不上手机
                        —— 主理人 2026-11-05 口径：手机端不建 PR，要开就在对话里让员工办。 */
                     task.prRepo && task.prNumber
                       ? `<a class="tc-m-row" href="https://github.com/${esc(task.prRepo)}/pull/${task.prNumber}" target="_blank" rel="noreferrer">
                            <span class="tc-m-k">Pull Request</span>
                            <span class="tc-m-v">#${task.prNumber} · ${esc(prStateText(task.prState))}</span><i class="tc-m-chev" aria-hidden="true"></i>
                          </a>`
                       : ''
                   }
                   ${
                     /* 删除行不摆：card.delete 没给 device 放行（route-policy），点了只会吃 403。
                        手机上废弃一张卡 = 在对话里说一声，或在桌面看板删。 */
                     ''
                   }
                 </div>
                 <p class="tc-m-foot">创建 ${esc(String(task.createdAt ?? '').replace('T', ' ').slice(0, 16))} · 更新 <span id="tcAt">${esc(String(task.updatedAt ?? '').replace('T', ' ').slice(0, 16))}</span></p>`
              : `<div class="tc-headblock">
                   ${fromFlowBar}
                   <h1 class="tc-title" id="tcTitleText" contenteditable="plaintext-only" spellcheck="false">${esc(task.title)}</h1>
                   ${flowOnly
                     ? `<div class="dim" style="font-size:12.5px;margin:-6px 0 12px">由流程「${esc(flowName)}」执行 —— 把状态改成「进行中」（或拖到「进行中」）就发起；发起后往来在流程实例里看。</div>`
                     : ''}
                   <div class="tc-desc${task.description ? '' : ' empty'}" id="tcDescView">${task.description ? renderMarkdown(task.description) : '<span class="dim">添加描述…</span>'}</div>
                 </div>`
          }

          ${
            /* 手机不摆讨论（2026-11-05）：它整体收进下面那张抽屉 —— 卡页只留"这件事本身" */
            mbTC
              ? ''
              : `<section class="group tc-comments">
            <div class="group-title">讨论</div>
            <div class="tc-threads" id="tcThreads">${threadsInner}</div>
          </section>`
          }
        </div>

        ${mbTC ? '' : composerBlock}
        <!-- 输入框停靠到议题下面期间，底部这颗幽灵按钮就是"开新话题"的回路（2026-10-24） -->
        <button type="button" class="tc-new-topic" id="tcNewTopic" hidden
                title="不回复谁，开一条新议题（输入框回到底部）">＋ 新议题</button>
      </div>

      ${
        mbTC
          ? `<aside class="tc-side tc-m-side" aria-hidden="true">
               <!-- 手机：两个 combo 只当"值与联动"的仓库（上面 .tc-m-card 的行才是界面），
                    整个 aside 不显示。删了它 createCombo 就没地方挂了。 -->
               <div id="tcStatusMount"></div>
               <div id="tcWhoMount"></div>
             </aside>`
          : `<aside class="tc-side">
        <h3>属性</h3>
        <div class="tc-prop"><span class="tc-prop-k">状态</span><div id="tcStatusMount"></div></div>
        <div class="tc-prop"><span class="tc-prop-k">执行人</span><div id="tcWhoMount"></div></div>
        ${flowOnly
          ? `<div class="tc-prop"><span class="tc-prop-k">流程</span><span class="tc-prop-v">${esc(flowName)} <span class="dim">· 还没发起</span></span></div>`
          : ''}
        <div class="tc-prop"><span class="tc-prop-k">项目</span><span class="tc-prop-v">${esc(proj?.name ?? '（项目已不在）')}</span></div>
        <div class="tc-prop"><span class="tc-prop-k">来源</span><span class="tc-prop-v">${isFlowCard ? '流程' : isCollab ? '总公司' : isRepo ? '仓库值班' : '手动建卡'}</span></div>

        <h3>Pull Request</h3>
        ${
          task.prRepo && task.prNumber
            ? `<div class="tc-prop"><span class="tc-prop-k">关联的 PR</span><div class="tc-prop-v">
                 <a href="https://github.com/${esc(task.prRepo)}/pull/${task.prNumber}" target="_blank" rel="noreferrer"
                    style="color:var(--accent)">${esc(task.prRepo)}#${task.prNumber}</a>
                 <span class="pill">${
                   task.prState === 'merged' ? '已合并' : task.prState === 'closed' ? '已关闭' : task.prState === 'open' ? '开着' : '状态未知'
                 }</span>
                 ${task.prTitle ? `<div class="dim" style="font-size:12px;margin-top:4px">${esc(task.prTitle)}</div>` : ''}
                 ${task.prCheckedAt ? `<div class="dim" style="font-size:11.5px;margin-top:2px">上次查：${esc(String(task.prCheckedAt).replace('T', ' ').slice(0, 16))}</div>` : ''}
               </div></div>
               <div class="dlg-actions">
                 <button id="tcPrRefresh">刷新状态</button>
                 ${task.prState === 'open' ? '<button id="tcPrMerge">合并</button>' : ''}
                 <button id="tcPrUnlink">取消关联</button>
               </div>`
            : `<div class="tc-pr-add">
                 <input id="tcPrUrl" placeholder="PR 链接 或 owner/name#123" />
                 <button class="primary" id="tcPrLink">关联</button>
                  <button id="tcPrCreate" title="把项目目录里的改动提交成新分支并开 PR（前提：这个目录是已接入仓库的克隆）">建 PR</button>
               </div>
               <div class="counter left">合并后这张卡会转到「待验收」——不自动「已完成」，等你点头。</div>`
        }

        <h3>详情</h3>
        ${task.createdBy ? `<div class="tc-prop"><span class="tc-prop-k">创建人</span><span class="tc-prop-v">${esc(pjPersona(task.createdBy)?.name ?? '那个人已经不在了')}（员工建卡）</span></div>` : ''}
        <div class="tc-prop"><span class="tc-prop-k">创建时间</span><span class="tc-prop-v">${esc(String(task.createdAt ?? '').replace('T', ' ').slice(0, 16))}</span></div>
        <div class="tc-prop"><span class="tc-prop-k">更新时间</span><span class="tc-prop-v" id="tcAt">${esc(String(task.updatedAt ?? '').replace('T', ' ').slice(0, 16))}</span></div>
        ${
          /* 状态改动归因（2026-11-03）：谁最后一次由人改的状态、什么时候。
             只在**人**改过状态后才有（系统收状态不冒充人）；老卡两列是 NULL 就不显示这行。 */
          task.statusByUserId
            ? `<div class="tc-prop"><span class="tc-prop-k">状态改动</span><span class="tc-prop-v">${esc((S.users ?? []).find((u) => u.id === task.statusByUserId)?.name ?? '那个人已经不在了')}<span class="dim"> · ${esc(String(task.statusAt ?? '').replace('T', ' ').slice(0, 16))}</span></span></div>`
            : ''
        }
      </aside>`
      }

      ${
        /* 讨论抽屉（2026-11-05 用户口径）：讨论不摊在卡页上，收进一张抽屉 ——
           入口是导航栏右上角那颗💬气泡（#tcCmtBtn，2026-11-06 定稿：卡页底部那条
           常驻评论条是过渡产物，已删；入口只留一处）。
           点开是抖音评论区那套：底部升起一张面板，上面遮罩压住整页，里面只有"讨论流 + 输入条"。
           它挂在 .tc-page 里面（position:fixed，不参与 flex 布局），为的是继续吃到
           `.tc-page.tc-m .tc-composer` 那一套玻璃输入条样式；页面重画时跟着一起换新。
           历史栈与「手机全屏选择页」同一套：开抽屉压一格，返回手势/返回键只收这一格。
           ⚠️ 抽屉里必须有 #tcThreads / #tcComposer 这两个 id —— 下面所有接线都按 id 找节点。 */
        mbTC
          ? `
      <div class="tc-sheet${tcSheetMax ? ' max' : ''}" id="tcSheet" role="dialog" aria-modal="true" aria-label="讨论">
        <div class="tc-sheet-mask" data-tc-sheet-close></div>
        <div class="tc-sheet-panel">
          <div class="tc-sheet-grip" aria-hidden="true"></div>
          <div class="tc-sheet-head">
            <b>讨论<span class="tc-sheet-n" id="tcSheetN">${cmtN}</span></b>
            <!-- 最大化（2026-11-05）：78% 的默认高度看不全长讨论，给一颗就地铺满整屏的键，
                 再点一下还原。图标画的是"点下去会怎样"：朝上＝展开，朝下＝收起。 -->
            <button type="button" class="tc-sheet-ic tc-sheet-max" id="tcSheetMax"
                    aria-label="${tcSheetMax ? '还原讨论面板' : '放大讨论面板'}"
                    aria-pressed="${tcSheetMax ? 'true' : 'false'}"
                    title="${tcSheetMax ? '还原' : '铺满整屏'}">${tcSheetMax ? TC_ICON_CHEVRONS_DOWN : TC_ICON_CHEVRONS_UP}</button>
            <button type="button" class="tc-sheet-ic tc-sheet-x" data-tc-sheet-close aria-label="收起讨论">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
            </button>
          </div>
          <div class="tc-sheet-body" id="tcSheetBody">
            <div class="tc-threads" id="tcThreads">${threadsInner}</div>
          </div>
          ${composerBlock}
        </div>
      </div>`
          : ''
      }
    </div>`;

  /*
   * 从哪来回哪去：**从流程那一步进来的就回那条流程**（2026-10-19）。
   * 这是这轮改造的重点之一 —— 人是在流程时间轴上点「任务」过来的，
   * 删完卡 / 干完事却落回看板，等于把他从上下文里拽走了，还得自己找回去。
   * 其余照旧：全局看板 → 全局看板，项目看板 → 那个项目。
   * （从会话卡票进来的那条已经改走弹窗了，弹窗这一路的 backTo 就是 close —— 见 2026-10-26。）
   */
  const backTo = dlg
    ? () => { dlg.close('done'); } // 弹窗这条路：**关掉就是回去**（底下的页面一直在，没走过）
    : taskCardFromFlow?.runId
      ? () => openFlowRun(taskCardFromFlow.templateId ?? null, taskCardFromFlow.runId)
      : taskCardFromAll
        ? () => openTaskBoard()
        : proj ? () => openProjectDetail(proj.id) : () => openProjectsPage();
  /*
   * 离开这张卡（手机整页）：有自己压的那格历史就走 history.back() —— popstate 监听里
   * 会画回上一级，返回键/手势/‹ 按钮走的是同一条路，栈不会攒出幽灵格。
   * 没有那格（桌面、或状态被别的层换掉了）就直接画回上一级。
   * 离开就把位置记忆的"开着"标记放下：否则下一次刷新又会被拽回这张卡。
   */
  const leaveTo = async () => {
    // 手机整页：**先退格再收场** —— popstate 监听里画回上一级（tcPageOpen 在那儿才置 false）。
    // 反过来先摘标记再 back()，popstate 进来一看"没开着"就什么都不画，屏幕会停在卡上（实测踩过）。
    if (mbTC && history.state?.tcCard) { history.back(); return; }
    tcPageOpen = false;
    await backTo();
  };
  // popstate 监听要用"画回上一级"：渲染时记下来（手机整页才会被用到）
  tcCardLeave = backTo;
  // 手机导航栏那颗 ‹：与系统返回键同一条路（有自己压的那格就退格，popstate 统一画回上一级）
  host.querySelector('[data-tc-back]')?.addEventListener('click', () => { leaveTo().catch((e) => toast(e.message, 'error')); });

  // 「来自流程」那行：点一下回那条流程的时间轴（跟删完卡之后回的是同一个地方）
  $('tcFromFlow')?.addEventListener('click', () => { leaveTo().catch((e) => toast(e.message, 'error')); });

  /* ---------------- 讨论抽屉（手机，2026-11-05 用户口径） ----------------
   *
   * 「讨论别摊在卡页上，收进一颗气泡按钮，点开像抖音评论区」——
   * 卡页因此只剩：状态 → 标题 → 描述 → 属性卡 → 脚注；讨论流和输入条整体搬进抽屉。
   *
   * 历史栈与「手机全屏选择页」（chat.mjs 的 mbPicker）/「新建任务」页同一套：
   *   开抽屉压一格 {tcSheet:true}；返回手势/返回键退掉这格 → 本文件尾的 popstate 收画面；
   *   「✕」/点遮罩 → **先 history.back()、画面留到 popstate 再收**。
   *   顺序反了会怎样：popstate 到时 class 已经被摘掉，mobile.mjs 会把这次返回当成
   *   "该收卡页了" —— 用户按一次返回，从抽屉直接掉回看板（mbClosePicker 踩过同一个坑）。
   *   mobile.mjs 的 popstate / Esc 各有一行 `tc-sheet-open` 守卫，给这里让路。
   */
  const sheet = mbTC ? $('tcSheet') : null;
  let sheetClosing = false;

  const sheetIsOpen = () => !!sheet && document.body.classList.contains('tc-sheet-open');
  const sheetMaxBtn = $('tcSheetMax');

  /*
   * 铺满整屏 / 还原（2026-11-05）：只切 .max 一枚 class，高度、圆角、顶部安全区全交给 CSS。
   * 高度不用 transform 做（面板得缩起 22% 才轮到输入条露出来，只能动 height）—— 见 mobile.css。
   * 滚动位置**不**强行拉到底：浏览器布局后会自己把越界的 scrollTop 夹回去，
   * 原本在翻历史中间的人也不会被一巴掌打回最新一条。
   */
  const paintSheetMax = () => {
    if (!sheet) return;
    sheet.classList.toggle('max', tcSheetMax);
    if (!sheetMaxBtn) return;
    sheetMaxBtn.innerHTML = tcSheetMax ? TC_ICON_CHEVRONS_DOWN : TC_ICON_CHEVRONS_UP;
    sheetMaxBtn.setAttribute('aria-label', tcSheetMax ? '还原讨论面板' : '放大讨论面板');
    sheetMaxBtn.setAttribute('aria-pressed', tcSheetMax ? 'true' : 'false');
    sheetMaxBtn.title = tcSheetMax ? '还原' : '铺满整屏';
  };
  const scrollSheetBottom = () => {
    const b = $('tcSheetBody');
    if (b) b.scrollTop = b.scrollHeight;
  };

  /*
   * 输入条两态（2026-11-06 用户发抖音截图拍板）：抽屉底部平时是**一条单行评论条**
   * （工具栏整条藏掉、textarea 压成药丸、placeholder 换成抖音那句）—— 键盘没起来
   * 就该长这样；点它（或点某条评论的「回复」）才展开成完整输入区，键盘跟着起来；
   * 输入框失焦（键盘收了）120ms 后收回单行 —— 延迟是给「点发送」让路的：
   * mousedown 先 blur，click 还没落，立刻收会把发送键藏没了。
   * 状态只挂在 .tc-sheet 的 .expanded 一枚 class 上，样式全在 mobile.css §22b。
   * 注意手机 placeholder 平时是空串（2026-11-04 口径），单行态在这里单独填那句。
   */
  const MB_COMPACT_PH = '留下你的友善评论吧';
  /*
   * 抽屉顶边钉住（2026-11-06 用户口径：键盘唤起后抽屉**别往上走**）。
   * 面板高度是 78%，而 .tc-sheet 的高度 = 可见视口 —— 键盘一起来视口变矮，
   * 78% 跟着变矮，面板顶边就自己往上跳一格（约 0.22 × 键盘高）。抖音那种手感
   * 是"抽屉待在原地、键盘从下面吃掉一截"。所以展开态把顶边钉成固定 px
   * （mobile.css 的 .tc-sheet.expanded .tc-sheet-panel 用 --tc-panel-top + bottom:0
   * 定高），这里负责在键盘还没起来时把这个位置记下来。
   * 只在非 expanded 时量 —— 已经缩过的视口量出来就偏了。
   */
  const pinSheetTop = () => {
    if (!sheet) return;
    if (sheet.classList.contains('expanded')) return;
    const h = sheet.getBoundingClientRect().height;
    const top = sheet.classList.contains('max') ? 0 : Math.round(h * 0.22);
    sheet.style.setProperty('--tc-panel-top', `${top}px`);
  };
  const tcCompact = () => {
    sheet.classList.remove('expanded');
    const input = $('tcInput');
    if (input) input.placeholder = MB_COMPACT_PH;
  };
  const tcExpand = () => {
    sheet.classList.add('expanded');
  };

  function openSheet() {
    if (!sheet || sheetIsOpen()) return;
    document.body.classList.add('tc-sheet-open');
    sheet.classList.add('in');
    tcCompact();   // 每次拉开都从单行态起步（草稿文字还在，展开即见）
    pinSheetTop(); // 键盘还没起来：记下此刻面板顶边，展开时钉住它（别让抽屉往上跳）
    // 进来先落到最新一条（评论区都这样：最新的在最下面）
    requestAnimationFrame(scrollSheetBottom);
    if (history.state?.tcSheet) return;   // 重画后重开：这格已经压过了
    /*
     * 卡页那格没打 tcCard 标记的（宽屏开卡 → 缩窄这种）：先给**当前这格**补上标记再压抽屉格。
     * 补不上就会出"关抽屉把卡页一起退掉"—— 关抽屉的 back() 退到的那格若不是卡页，
     * 本文件尾的 tcCard popstate 就会把画面画回上一级。
     */
    if (!history.state?.tcCard) history.replaceState({ ...(history.state ?? {}), tcCard: true }, '');
    history.pushState({ tcCard: true, tcSheet: true }, '');
  }

  /** @param {boolean} alreadyPopped 这格历史已被浏览器退掉（popstate 进来）—— 只收画面、不再退格 */
  function closeSheet(alreadyPopped = false) {
    if (!sheet || !sheetIsOpen()) return;
    if (!alreadyPopped && history.state?.tcSheet) {
      if (sheetClosing) return;   // 连点「✕」：第二下不能再退一格
      sheetClosing = true;
      history.back();
      return;
    }
    sheetClosing = false;
    // 收键盘：输入框还挂着焦点的话，抽屉收起来了键盘还杵在屏幕上
    if (sheet.contains(document.activeElement)) document.activeElement.blur();
    document.body.classList.remove('tc-sheet-open');
    sheet.classList.remove('in');
    tcCompact();   // 下次拉开从单行态起步（与 openSheet 的口径一致）
  }
  // 模块级 popstate / Esc 用它收画面（本文件头那段监听只认这一个钩子，不在每次渲染时叠监听）
  tcSheetClose = mbTC ? closeSheet : null;

  if (sheet) {
    $('tcCmtBtn')?.addEventListener('click', openSheet);
    /* 两态切换：聚焦/点输入条 → 展开；失焦（且焦点不在抽屉里）→ 收回单行 */
    const tcInput = $('tcInput');
    tcInput?.addEventListener('focus', tcExpand);
    tcInput?.addEventListener('blur', () => {
      setTimeout(() => {
        if (!sheet.classList.contains('expanded')) return;
        const act = document.activeElement;
        if (act && sheet.contains(act) && act !== document.body) return; // 焦点还在抽屉里（发送/＋/档位）
        tcCompact();
      }, 120);
    });
    sheet.addEventListener('click', (e) => {
      if (sheet.classList.contains('expanded')) return;
      if (!e.target.closest('.tc-composer')) return;
      tcExpand();
      tcInput?.focus();   // 点单行条就是想打字：键盘跟着起来（抖音同款）
    });
    sheetMaxBtn?.addEventListener('click', () => {
      tcSheetMax = !tcSheetMax;
      paintSheetMax();
      pinSheetTop();   // 顶边基准跟着放大/还原重记（展开态里这条会自己跳过）
    });
    sheet.querySelectorAll('[data-tc-sheet-close]').forEach((el) => {
      el.addEventListener('click', () => closeSheet());
    });
  }

  /** 讨论条数刷新（发完 / 他回完 / 重跑完都会走到）：导航气泡角标 + 抽屉标题数字 */
  const paintCmtBadge = (d) => {
    const n = topicsOf(timelineOf(d?.messages ?? [], d?.runs ?? [])).length;
    const badge = $('tcCmtN');
    if (badge) {
      badge.textContent = n > 99 ? '99+' : String(n);
      badge.hidden = !n;
    }
    const btn = $('tcCmtBtn');
    if (btn) btn.setAttribute('aria-label', n ? `讨论（${n} 条）` : '讨论');
    const label = $('tcSheetN');
    if (label) label.textContent = String(n);
  };

  /* ---------------- 标题 / 描述：就地编辑（2026-10-18 用户要求：没有编辑按钮，点了就改，改完自动存）
     做法跟同类产品一致：标题、描述平时就是"读"的样子，点上去原地变成输入框；
     敲字防抖自动存，失焦立刻存；Enter 提交，Escape 放弃本次改动。 ---------------- */
  let titleVal = task.title;
  let descVal = task.description || '';

  /* 标题：h1 本身就可写（contenteditable）。**不换元素、不加边框** ——
     换 input 会改字号/行高/盒模型，页面会抖一下（2026-10-18 用户实报）。 */
  const titleEl = $('tcTitleText');
  /*
   * 协作卡（2026-10-31）：标题/描述**只读** —— 内容归中心（后端也会用 E4046 拦，
   * 这里只是别让人白改一遍再被拒）。状态、执行人、评论照常能动。
   * 手机整页（mbTC）同样只读：device 身份的 PATCH 只收 {status, note}（E3702）。
   */
  if (isCollab || mbTC) {
    titleEl.removeAttribute('contenteditable');
    if (isCollab) titleEl.title = '总公司派的任务，标题由中心改';
  }
  titleEl.addEventListener('input', () => { titleVal = titleEl.textContent; scheduleSave(700); });
  titleEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); } // 单行标题：回车＝改完
    if (e.key === 'Escape') { titleVal = task.title; titleEl.textContent = task.title; titleEl.blur(); }
  });
  titleEl.addEventListener('blur', () => {
    titleVal = (titleEl.textContent || '').trim();
    if (!titleVal) titleVal = task.title;   // 空标题不收，退回原值
    titleEl.textContent = titleVal;
    scheduleSave(0);                        // 失焦立刻存
  });

  /* 描述：平时是渲染好的 Markdown；点上去就地变成**原文编辑器**（同一块地方、无边框），
     失焦存回原文并重新渲染。这样链接/加粗照旧能看，也不会把 Markdown 弄丢。 */
  const descHost = $('tcDescView');
  const renderDesc = () => {
    descHost.classList.remove('editing');
    descHost.removeAttribute('contenteditable');
    descHost.classList.toggle('empty', !descVal);
    descHost.innerHTML = descVal ? renderMarkdown(descVal) : '<span class="dim">添加描述…</span>';
  };
  const startDescEdit = () => {
    if (isCollab || mbTC) return; // 协作卡的描述由中心写；手机端 device 只能改状态（E3702），点了也存不上
    if (descHost.classList.contains('editing')) return;
    descHost.classList.add('editing');
    descHost.setAttribute('contenteditable', 'plaintext-only'); // 不给边框，只给可写
    descHost.textContent = descVal; // 编辑时给的是 Markdown 原文
    descHost.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(descHost);
    range.collapse(false);           // 光标落末尾：接着往下写
    sel.removeAllRanges();
    sel.addRange(range);
  };
  descHost.addEventListener('click', (e) => {
    if (e.target.closest('a') || descHost.classList.contains('editing')) return; // 点链接照旧跳
    startDescEdit();
  });
  descHost.addEventListener('input', () => { descVal = descHost.innerText; scheduleSave(800); });
  descHost.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { descVal = task.description || ''; descHost.blur(); }
  });
  descHost.addEventListener('blur', () => {
    descVal = (descHost.innerText || '').replace(/\u00a0/g, ' ').trim();
    renderDesc();
    scheduleSave(0);
  });

  /* ---------------- 自动保存（2026-10-18 用户要求：没有「保存」「开始工作」） ---------------- */
  const saveStateEl = $('tcSaveState');
  const setSaveState = (text, kind = '') => {
    if (!saveStateEl) return;
    saveStateEl.textContent = text;
    saveStateEl.className = 'save-state' + (kind ? ' ' + kind : '');
  };
  let saveTimer = null;
  let saveNow = null;      // combos 建好后赋值（它要读状态 / 执行人）
  let saveQueued = false;
  const scheduleSave = (ms = 700) => {
    setSaveState('未保存…', 'wait');
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; saveNow?.(); }, ms);
  };

  /**
   * 评论输入区的状态。**输入框始终可写**（原来没指定执行人就 disabled，人以为是页面坏了），
   * 只在发送时要求先选人 —— 选完立刻就能发，不用先点「保存」。
   */
  const syncComposer = () => {
    const hint2 = $('tcHint2');
    if (!hint2) return;
    // 选完人就把常驻提示撤掉（那句"发送＝叫醒他讨论…"是废话，2026-10-19 用户要去掉）；
    // 只有还没选执行人时才留一句必要的引导。
    // 还没发起的流程卡没有"选人"这回事（执行人由流程当前步骤定），提示得换说法，
    // 不然右边明明只有「（由流程执行）」、底下却叫着"快选执行人"，两句话打架。
    hint2.textContent = whoCombo.value()
      ? ''
      : flowOnly
        ? `这张卡由流程「${flowName}」执行 —— 发起后在流程实例里跟当前经办人往来。`
        : isNarrowPh()
          ? '先指定执行人，再发送。'
          : '先在右边选执行人，再发送。';
  };

  /* 手机行上的状态展示（#tcStatusChip/#tcStatusText；桌面没有这两个节点，函数空转） */
  const syncMobileStatus = (st = task.status) => {
    const el = $('tcStatusText');
    if (!el) return;
    el.textContent = st;
    const k = Object.keys(COL_STATUS).find((x) => COL_STATUS[x] === st);
    $('tcStatusChip')?.style.setProperty('--st-c', `var(--st-${k ?? 'other'})`);
  };

  const statusCombo = createCombo({
    mount: $('tcStatusMount'),
    items: ['想法', '待办', '进行中', '待验收', '已阻塞', '失败', '已完成', '已取消'].map((s) => ({ id: s, label: s })),
    value: task.status,
    onChange: (st) => { syncMobileStatus(st); scheduleSave(0); }, // 改状态立刻存：待办+人 = 开工（服务端负责）
  });
  /*
   * 执行人那一格：还没发起的流程卡**只留「（由流程执行）」一项**。
   * 为什么不是藏掉、而是留一个不能选的项：藏掉的话右栏这一行会凭空消失，
   * 人只会觉得"执行人怎么没了"；留一项写着「由流程执行」，等于把这张卡的执行方式摆明。
   * 也**不能**让人选：服务端明确拒绝改派（见 project-tasks.mjs 的 400），选了也存不上。
   */
  /*
   * 选人的共用回调：combo（桌面）与手机的全屏选择页走同一个。
   * 选人**立刻**反映到评论区与行上（原来要点了「保存」重画才生效，看着就像"输入框点不动"）。
   */
  const onWhoChange = (id) => {
    const isUser = String(id).startsWith('u:');
    const p = isUser ? null : (S.personas ?? []).find((x) => x.id === id) ?? null;
    const u = isUser ? (S.users ?? []).find((x) => x.id === id.slice(2)) : null;
    if (p || u) whoName = p?.name ?? u?.name;
    const whoText = $('tcWhoText');
    if (whoText) whoText.textContent = p?.name ?? u?.name ?? '（没派活）';
    syncComposer();
    scheduleSave(0); // 指定人立刻存：卡在「待办」时这一下就会自动开工（真人执行不开工，见服务端）
  };
  const whoCombo = flowOnly
    ? createCombo({
        mount: $('tcWhoMount'),
        items: [{ id: '', label: '（由流程执行）' }],
        value: '',
      })
    : createCombo({
        mount: $('tcWhoMount'),
        /*
         * 执行人一格二选一（2026-10-31 用户概念落地）：数字员工（会派活起会话）或
         * **真人**（挂名负责，不起会话）——真人的选项 id 带 `u:` 前缀，提交时换成
         * assigneeUserId（员工的 id 都是 `p-` 系，前缀撞不了车）。
         */
        items: [
          { id: '', label: '（不指定）' },
          ...(S.users ?? []).map((u) => ({ id: `u:${u.id}`, label: u.name })),
          ...(S.personas ?? []).map((p) => ({ id: p.id, label: personLabel(p) })),
        ],
        value: task.assigneePersonaId || (task.assigneeUserId ? `u:${task.assigneeUserId}` : ''),
        search: true,
        placeholder: '搜名字或岗位…',
        empty: '没有匹配的人',
        onChange: onWhoChange,
      });
  syncComposer();

  /*
   * 手机：状态点开**全屏选择页**（mbOpenPicker，与员工详情的运行时/模型、
   * 新建任务的状态同一套 —— 开页压一格历史、返回收画面、防连点都 inside）。
   * 值的落地复用 statusCombo：setValue 存值，保存走 scheduleSave（手机 snapshot 只有 status）。
   * 执行人不上选择页：device 身份改不了执行人（E3702），那行是只读展示。
   */
  if (mbTC) {
    $('tcStatusChip')?.addEventListener('click', () => {
      mbOpenPicker({
        title: '状态',
        items: Object.keys(COL_STATUS).map((k) => ({ id: k, label: COL_STATUS[k], dot: `var(--st-${k})` })),
        value: Object.keys(COL_STATUS).find((k) => COL_STATUS[k] === statusCombo.value()) ?? '',
        onPick: (k) => {
          const label = COL_STATUS[k] ?? k;
          statusCombo.setValue(label);
          syncMobileStatus(label);
          scheduleSave(0);
        },
      });
    });
  }

  const snapshot = () => ({
    // 手机整页（device 身份）：服务端字段级闸只收 {status, note}（E3702），所以
    // snapshot 只带状态 —— 标题/描述/执行人都不在手机上改（界面也是只读的）。
    // 桌面照旧：改了什么就存什么。
    ...(mbTC
      ? { status: statusCombo.value() }
      : {
          title: titleVal,
          description: descVal,
          status: statusCombo.value(),
          // 还没发起的流程卡**不能带执行人**：服务端看到"流程卡改执行人"会把整个 PATCH 400 掉
          // （连改标题/描述都一起被挡），而这张卡本来就没有人选。
          // 执行人二选一：`u:` 前缀 = 真人（assigneeUserId），否则 = 数字员工（personaId）。
          ...(flowOnly
            ? {}
            : String(whoCombo.value()).startsWith('u:')
              ? { assigneeUserId: String(whoCombo.value()).slice(2) }
              : { personaId: whoCombo.value() }),
        }),
  });
  let lastSaved = JSON.stringify(snapshot());
  let saving = false;

  /** 存完只更新页头/描述，不重画整页（免得丢正在写的评论）。
   *  状态/执行人的实时展示在右栏 combo 上（页头不再摆 pill，参照同类产品收进属性栏）。 */
  const refreshHeader = () => {
    if (document.activeElement !== titleEl) {
      titleVal = task.title;
      titleEl.textContent = task.title;
    }
    const p = (S.personas ?? []).find((x) => x.id === task.assigneePersonaId) ?? null;
    if (p) whoName = p.name;
    statusCombo?.setValue(task.status);
    syncMobileStatus(task.status);
    const wv = task.assigneePersonaId || (task.assigneeUserId ? `u:${task.assigneeUserId}` : '');
    whoCombo?.setValue(wv);
    // 手机行上的执行人名跟着刷（combo.setValue 不走 onChange，行不会自己动）
    if (mbTC) {
      const isUser = String(wv).startsWith('u:');
      const wp = isUser ? null : (S.personas ?? []).find((x) => x.id === wv) ?? null;
      const wu = isUser ? (S.users ?? []).find((x) => x.id === String(wv).slice(2)) : null;
      const wt = $('tcWhoText');
      if (wt) wt.textContent = wp?.name ?? wu?.name ?? (flowOnly ? '（由流程执行）' : '（没派活）');
    }
    if (document.activeElement !== descHost) {
      descVal = task.description || '';
      renderDesc();
    }
    const at = $('tcAt');
    if (at && task.updatedAt) at.textContent = String(task.updatedAt).replace('T', ' ').slice(0, 16);
  };

  /**
   * 自动开工之后要重画：状态变「进行中」、往来区这时才有会话。
   * 重画会把正在写的评论清掉，所以先把草稿和"回复哪个议题"记下来，画完放回去。
   */
  const repaintKeepingDraft = async () => {
    const draft = $('tcInput')?.value ?? '';
    const topicId = replyTo;
    await paintTaskCardPage(taskId, opts);
    if (draft) {
      const el = $('tcInput');
      if (el) el.value = draft;
    }
    if (topicId) $('tcThreads')?.querySelector(`[data-reply="${CSS.escape(topicId)}"]`)?.click();
  };

  saveNow = async ({ keepalive = false } = {}) => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    const payload = snapshot();
    // 手机端只发 `{status}`（服务端给设备的白名单就这一个键），没有 title 可校验 —— 别在这里炸。
    if (!mbTC && !String(payload.title ?? '').trim()) { setSaveState('标题不能空 · 未保存', 'bad'); return false; }
    const json = JSON.stringify(payload);
    if (json === lastSaved) { setSaveState('已保存', 'ok'); return true; }
    if (saving) { saveQueued = true; return false; }
    saving = true;
    setSaveState('保存中…', 'wait');
    try {
      const res = await api(`/api/projects/tasks/${encodeURIComponent(taskId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: json,
        ...(keepalive ? { keepalive: true } : {}),
      });
      lastSaved = json;
      if (res.task) { task = res.task; refreshHeader(); }
      setSaveState('已保存', 'ok');
      // 真的派活了（待办+人 / 状态改成进行中）→ 重画，把「进行中」和往来区摆出来
      if (res.started) {
        // 由流程执行的卡：这一下"开工"其实是**把流程发起起来**（服务端建完实例把 flowRunId 写回卡），
        // 派给谁由流程当前节点决定，所以不能说"派给他跑去了"。重画时页面会直接带去实例页。
        if (res.task?.flowRunId) {
          toast('流程已经起来了 —— 到流程实例里看每一步');
        } else {
          toast('已自动开工：派给他跑这一条去了');
        }
        await repaintKeepingDraft();
      }
      return true;
    } catch (err) {
      // `err.message` 自带「码：原因」（4xx 是服务端原文，5xx 是「服务异常」）。
      // 不能再用 `err.detail || err.message` —— 那会在 5xx 时把内部原文顶到界面上。
      const why = String(err?.message || '服务异常').split('\n')[0];
      setSaveState('没开工：' + why, 'bad');
      // 状态可能已经改成「待办」但没派出去（忙/运行时不可用）：重取一次，让界面说实话
      try {
        const d = await api(`/api/projects/tasks/${encodeURIComponent(taskId)}`);
        if (d.task) { task = d.task; refreshHeader(); }
      } catch { /* 取不到就算了 */ }
      toast(`没存上/没开工：${why}`);
      return false;
    } finally {
      saving = false;
      if (saveQueued) { saveQueued = false; saveNow?.(); }
    }
  };

  /*
   * 关弹窗 / 换页之前，**先把没落库的改动存掉**（2026-10-19）。
   * 原来的排版是"敲完字马上失焦（弹窗里就关掉）"，靠 blur 触发存；现在改完状态可能
   * 直接按 Esc —— 不补这一下，那一下改动就没了，人还以为存上了。
   * 放在这里（PR 那几块上面）：下面所有交互都可能在存完之前关窗。
   */
  cleanups.push(() => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (JSON.stringify(snapshot()) !== lastSaved) saveNow?.({ keepalive: true });
  });

  // 弹窗这条路**不摆「删除」**（2026-10-26 用户截图要求）：轻界面不承载不可逆动作；
  // 整页那条路在页头；流程派生的卡也不摆（身份由流程行代表，删了没意义 —— 2026-10-23 用户拍板）
  const delEl = dlg ? null : $('tcDel');
  if (delEl && (isFlowCard || isCollab)) delEl.remove();
  if (delEl) {
    delEl.onclick = async () => {
      if (!(await confirmDo('删掉这张任务卡？（＝忽略它，以后不再提）'))) return;
      try {
        await api(`/api/projects/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
        await leaveTo();
      } catch (e) { toast(e.message, 'error'); }
    };
  }

  /* ---------------- PR 联动（卡片 ↔ GitHub PR） ---------------- */
  // （prStateText 在上面画模板之前就定义了 —— 手机行/桌面右栏两处都用它）

  $('tcPrLink')?.addEventListener('click', async (e) => {
    e.preventDefault();
    const url = $('tcPrUrl').value.trim();
    if (!url) return toast('先贴 PR 链接（或 owner/name#123）');
    const btn = $('tcPrLink');
    btn.disabled = true;
    btn.textContent = '查询中…';
    try {
      const r = await api(`/api/projects/tasks/${encodeURIComponent(taskId)}/pr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      await paintTaskCardPage(taskId, opts);
      toast(`已关联：${r.pr.repo}#${r.pr.number} —— ${prStateText(r.pr.state)}`);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = '关联';
      toast(err.message, 'error');
    }
  });
  $('tcPrRefresh')?.addEventListener('click', async (e) => {
    e.preventDefault();
    const btn = $('tcPrRefresh');
    btn.disabled = true;
    btn.textContent = '查询中…';
    try {
      const r = await api(`/api/projects/tasks/${encodeURIComponent(taskId)}/pr/refresh`, { method: 'POST' });
      await paintTaskCardPage(taskId, opts);
      toast(`PR 现在：${prStateText(r.pr.state)}${r.task?.status === '待验收' ? '（卡已转到「待验收」）' : ''}`);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = '刷新状态';
      toast(err.message, 'error');
    }
  });
  $('tcPrUnlink')?.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!(await confirmDo('取消这张卡和 PR 的关联？（不会动 GitHub 上的 PR）'))) return;
    try {
      await api(`/api/projects/tasks/${encodeURIComponent(taskId)}/pr`, { method: 'DELETE' });
      await paintTaskCardPage(taskId, opts);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  /*
   * 卡上「建 PR」（2026-10-25）：只问一句标题，剩下的交给服务端 ——
   * 项目目录 → 已接入仓库 → 提交、推分支、开 PR、挂回这张卡，一条链在服务端跑完
   * （`routes/git.mjs` 的 `/pr/create`，冒烟 ⑦ 钉的就是这条路）。
   *
   * ⚠️ 这里**故意不做**"看到改动再提交"那一屏：卡上没有仓库上下文，摆一半功能
   * 比不摆更容易让人以为已经看过了。要看改动、挑文件、处理凭据那类拦截，
   * 用「工作台 → 研发 → 代码托管」里那颗「建 PR」（完整弹窗）。撞到凭据拦截时下面会把这条指出来。
   */
  $('tcPrCreate')?.addEventListener('click', async (e) => {
    e.preventDefault();
    const title = await askText({
      title: `给这张卡建一个 PR`,
      body: `项目目录里的改动会被收成一个提交、推到一条新分支，并开成 PR。base 用仓库的默认分支。\n\n（要挑文件、看改动、处理"看着像凭据的文件"，去「工作台 → 研发 → 代码托管」那一行的「建 PR」。）`,
      value: task.title,
      placeholder: 'PR 标题：一句话说清这个 PR 干了什么',
      ok: '提交并建 PR',
    });
    if (title === null) return;
    if (!title.trim()) return toast('标题不能是空的');
    const btn = $('tcPrCreate');
    btn.disabled = true;
    btn.textContent = '提交中…';
    try {
      const r = await api(`/api/projects/tasks/${encodeURIComponent(taskId)}/pr/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), body: `来自班底任务卡：${task.title}\n\n${task.description ?? ''}`.trim() }),
      });
      await paintTaskCardPage(taskId, opts);
      toast(r.created ? `PR #${r.pr.number} 已建好（分支 ${r.branch}）` : `这个分支已经有 open PR：#${r.pr.number}，已挂回这张卡`);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = '建 PR';
      const m = String(err.message ?? err);
      toast(/凭据|就是要提交/.test(m) ? `${m}\n\n要强行提交这些文件：去「工作台 → 研发 → 代码托管」那一行的「建 PR」，那里有勾选。` : m, 'error');
    }
  });

  /*
   * 卡上「合并」（2026-10-25）：人在这儿点一下就是授权合这个 PR。
   * 与流程里那颗的差别只在**谁放行**：这条是人在场、当场点的，所以不锁 SHA
   * （锁了会把人锁死：失败→重试→拿的还是那次审阅的旧 sha→永远 409）。
   * 合完服务端会把「进行中」转成「待验收」——合并 ≠ 验收通过，这条规矩没变。
   */
  $('tcPrMerge')?.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!(await confirmDo(`合并 ${task.prRepo}#${task.prNumber}？\n\n这一步会在 GitHub 上真的合进去，合完不能撤销。`))) return;
    const btn = $('tcPrMerge');
    btn.disabled = true;
    btn.textContent = '合并中…';
    try {
      const r = await api(`/api/projects/tasks/${encodeURIComponent(taskId)}/pr/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      await paintTaskCardPage(taskId, opts);
      toast(r.merged ? `PR #${task.prNumber} 已合并${r.note ? `\n${r.note}` : ''}` : r.note ?? '没合');
    } catch (err) {
      btn.disabled = false;
      btn.textContent = '合并';
      toast(err.message, 'error');
    }
  });

  /* ---------------- 评论区：发评论 / 回复 / 实时流 ---------------- */

  let convId = task.conversationId ?? null;
  let stream = null;
  let liveRunId = null;   // 正在跑的那一轮（有它 → 发送键变成「停止生成」，跟对话页一个做法）
  let liveTick = null;    // 进度卡的每秒重画；掐掉运行 / 收尾时都要停表，别留着空转
  let liveEl = null;      // 进度卡气泡的 DOM —— 讨论区重画会把它冲掉，要用它挂回去（不然他明明在跑、界面"停了"）
  let replyTo = null; // 正在回复哪个议题（null = 新开一条）
  let pendingAtts = []; // 还没发出的附件 { file, name, size, mime, localUrl }
  let attSending = false;

  const paintTcAtts = () => {
    const strip = $('tcAttStrip');
    if (!strip) return;
    strip.classList.toggle('is-hidden', !pendingAtts.length);
    strip.innerHTML = pendingAtts
      .map((a, i) => {
        const kb = a.size >= 1048576 ? `${(a.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(a.size / 1024))} KB`;
        const img = (a.mime || '').startsWith('image/')
          ? `<img class="att-thumb" src="${esc(a.localUrl)}" alt="">`
          : '';
        return `<span class="att-chip" title="${esc(a.name)}">${img}<span class="att-name">${esc(a.name)}</span><span class="att-size">${kb}</span><button type="button" class="att-x" data-tc-att-x="${i}" title="移除">×</button></span>`;
      })
      .join('');
    strip.querySelectorAll('[data-tc-att-x]').forEach((b) => {
      b.onclick = () => {
        const [gone] = pendingAtts.splice(Number(b.dataset.tcAttX), 1);
        try { URL.revokeObjectURL(gone?.localUrl); } catch { /* 已失效 */ }
        paintTcAtts();
      };
    });
  };

  const addTcAtts = (fileList) => {
    const files = [...(fileList ?? [])];
    if (!files.length) return;
    for (const f of files) {
      if (pendingAtts.length >= 8) { toast('一次最多带 8 个附件', 'error'); break; }
      pendingAtts.push({ file: f, name: f.name || '图片.png', size: f.size, mime: f.type || '', localUrl: URL.createObjectURL(f) });
    }
    paintTcAtts();
  };

  const clearTcAtts = () => {
    for (const a of pendingAtts) { try { URL.revokeObjectURL(a.localUrl); } catch { /* 已失效 */ } }
    pendingAtts = [];
    paintTcAtts();
  };

  $('tcAttach')?.addEventListener('click', () => $('tcFilePick').click());
  $('tcFilePick')?.addEventListener('change', () => { addTcAtts($('tcFilePick').files); $('tcFilePick').value = ''; });
  $('tcInput')?.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length) {
      e.preventDefault();
      addTcAtts(files);
    }
  });

  /**
   * 这条发出去之后他要怎么处理（2026-10-19 用户定，三档）：
   *   · note    便签 —— 只记在卡上给你看，不叫醒他、agent 不读；
   *   · discuss 讨论 —— 叫醒他聊、看代码、给方案，但只读不动手（服务端沙箱盖成 plan）；
   *   · execute 执行 —— 叫醒他基于讨论真正干活，用员工默认沙箱。
   * 桌面默认「讨论」：用户的痛点是"需求没聊清就动手"，先聊才符合直觉。
   * 手机也默认「讨论」（2026-11-05 用户改口径，同一天先定的便签作废）：讨论/执行既然放开了，
   * 默认就照桌面的算法 —— 记一句不叫人的话自己切「便签」，一档之遥。
   */
  const DEFAULT_MODE = 'discuss';
  let sendMode = DEFAULT_MODE;
  const MODE_TIP = {
    note: '便签：只记在卡上给你看，不叫醒他',
    discuss: '讨论：叫醒他聊、看代码、给方案，不动手改文件',
    execute: '执行：叫醒他基于讨论真正干活',
  };
  const MODE_LABEL = { note: '便签', discuss: '讨论', execute: '执行' };
  const placeholderFor = (mode) =>
    mode === 'note' ? '留个便签…（不会叫醒他）'
    : mode === 'discuss' ? '跟他讨论…（只聊不动手）'
    : '让他干活…（回车换行）';
  // 输入框提示语：选了回复目标就说"回复这个议题…"，否则按三档说。
  // 手机上不显示（跟主聊天框同一把尺子，2026-11-04 用户要求：屏幕小，提示词难看）。
  const placeholderText = () => (isNarrowPh() ? ''
    : !replyTo ? placeholderFor(sendMode)
    : sendMode === 'note' ? '回复这个议题…（便签）'
    : sendMode === 'discuss' ? '回复这个议题…（只聊不动手）'
    : '回复这个议题…（回车换行）');

  const paintMode = () => {
    const btn = $('tcMode');
    const label = $('tcModeLabel');
    if (btn) {
      btn.dataset.mode = sendMode;
      btn.title = MODE_TIP[sendMode];
    }
    if (label) label.textContent = MODE_LABEL[sendMode];
    const input = $('tcInput');
    // 他在跑的时候提示语让位给"要打断就点停止生成"（跟对话页 setBusy 一个道理）
    if (input) input.placeholder = liveRunId
      ? (isNarrowPh() ? '' : '他还在说…（要打断就点「停止生成」）')
      : placeholderText();
    const menu = $('tcModeMenu');
    if (menu) {
      menu.querySelectorAll('[data-pick]').forEach((b) => {
        b.classList.toggle('on', b.dataset.pick === sendMode);
      });
    }
    /* 手机展开态那三颗（便签/讨论/执行）：选中态与档位色都跟着 sendMode 走 */
    const chips = $('tcModeChips');
    if (chips) {
      chips.dataset.mode = sendMode;
      chips.querySelectorAll('[data-chip]').forEach((b) => {
        const on = b.dataset.chip === sendMode;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }
  };
  const closeModeMenu = () => { const m = $('tcModeMenu'); if (m) m.hidden = true; };
  $('tcMode')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const m = $('tcModeMenu');
    if (m) m.hidden = !m.hidden;
  });
  $('tcModeMenu')?.querySelectorAll('[data-pick]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      sendMode = ['note', 'discuss', 'execute'].includes(b.dataset.pick) ? b.dataset.pick : 'discuss';
      closeModeMenu();
      paintMode();
      $('tcInput')?.focus();
    });
  });
  /* 手机展开态的三颗（便签/讨论/执行）：点一下切档位，焦点留在输入框（键盘别收） */
  $('tcModeChips')?.querySelectorAll('[data-chip]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      sendMode = ['note', 'discuss', 'execute'].includes(b.dataset.chip) ? b.dataset.chip : 'discuss';
      paintMode();
      $('tcInput')?.focus();
    });
  });
  // 点别处收起（只挂这一次；tcModeMenu 是随页面重建的，用冒泡判断当前节点）
  const onDocClick = (e) => { if (!e.target.closest?.('.tc-mode-wrap')) closeModeMenu(); };
  document.addEventListener('click', onDocClick);
  paintMode();

  /**
   * 回复 = **输入框原地停靠**（2026-10-24 重做，照 GitHub 会话 / YouTube / Discord 的规矩）：
   * 点哪条议题的「回复」，整个输入框（附件、档位、发送一起）就搬进那条议题下面 ——
   * 在哪回复就在哪输入，"在回哪条"这件事靠位置本身表达。
   * 原来的「回复到」下拉整个废了：议题一多，条目全是"时间 + 截断的一行字"，认不出哪条是哪条（用户实测）。
   * 停靠期间底部留一颗「＋ 新议题」幽灵按钮当回路；横幅上的 ✕ 或 Esc 取消回复，输入框回到底部。
   */
  const topicTitleOf = (id) => {
    const m = (conv?.messages ?? []).find((x) => x.id === id);
    return String(m?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  };

  // 输入框回到底部（"新议题"位）：搬回 .tc-main 末尾（幽灵按钮之前），摘掉停靠样式与高亮
  const homeComposer = () => {
    const composer = $('tcComposer');
    const ghost = $('tcNewTopic');
    if (!composer) return;
    const main = composer.closest('.tc-main');
    if (main && ghost && composer.parentElement !== main) main.insertBefore(composer, ghost);
    composer.classList.remove('inline');
    if (ghost) ghost.hidden = true;
    const banner = $('tcReplyBanner');
    if (banner) banner.hidden = true;
    $('tcThreads')?.querySelectorAll('.tc-topic.is-replying').forEach((el) => el.classList.remove('is-replying'));
  };

  // 输入框停靠到正在回复的议题下面：回复区先展开、搬家、亮横幅、把目标滚进视野
  const dockComposer = () => {
    const composer = $('tcComposer');
    if (!composer) return;
    const threads = $('tcThreads');
    const topicEl = replyTo ? threads?.querySelector(`[data-topic="${CSS.escape(replyTo)}"]`) : null;
    if (!replyTo || !topicEl) { homeComposer(); return; }
    // 点了「回复」就是想接着聊这条：手动收起过的也弹开，并记住展开态（重画后还原靠 openTopics）
    openTopics.add(replyTo);
    collapsedTopics.delete(replyTo);
    const det = topicEl.querySelector('details.tc-replies');
    if (det) det.open = true;
    if (mbTC) {
      /*
       * 手机**不搬家**：输入框吸在底部（拇指够得着），搬进议题里的话键盘一弹、
       * 那条议题顶到屏幕外，输入框也被顶得看不见。"在回哪条"交给横幅 + 议题高亮。
       */
      const banner = $('tcReplyBanner');
      if (banner) {
        banner.hidden = false;
        const t = $('tcReplyBannerText');
        if (t) t.textContent = `回复：${topicTitleOf(replyTo) || '这个议题'}`;
      }
    } else {
      const body = topicEl.querySelector('.tc-topic-body');
      if (body && composer.parentElement !== body) body.appendChild(composer);
      composer.classList.add('inline');
      const ghost = $('tcNewTopic');
      if (ghost) ghost.hidden = false;
      const banner = $('tcReplyBanner');
      if (banner) {
        banner.hidden = false;
        const t = $('tcReplyBannerText');
        if (t) t.textContent = `回复：${topicTitleOf(replyTo) || '这个议题'}`;
      }
    }
    threads?.querySelectorAll('.tc-topic.is-replying').forEach((el) => el.classList.remove('is-replying'));
    topicEl.classList.add('is-replying');
    topicEl.scrollIntoView({ block: 'nearest' }); // 已在视野内就不动
  };
  const syncReplyDock = () => { replyTo ? dockComposer() : homeComposer(); };

  const scrollThreads = () => {
    // 手机：讨论流在抽屉里，要滚的是抽屉的滚动区（#tcThreads 自己不滚，scrollTop 设了也不动）；
    // 桌面：讨论区就在页面流里，滚它自己。
    const box = (mbTC ? $('tcSheetBody') : null) ?? $('tcThreads');
    if (box) box.scrollTop = box.scrollHeight;
  };

  const setReplyPlaceholder = () => {
    const input = $('tcInput');
    if (input) input.placeholder = placeholderText();
  };

  const wireReplyButtons = () => {
    $('tcThreads')?.querySelectorAll('[data-reply]').forEach((btn) => {
      btn.onclick = () => {
        replyTo = btn.dataset.reply;
        syncReplyDock();
        setReplyPlaceholder();
        $('tcInput')?.focus();
      };
    });
  };

  const clearReply = () => {
    replyTo = null;
    syncReplyDock();
    setReplyPlaceholder();
  };
  $('tcReplyUndock')?.addEventListener('click', () => {
    clearReply();
    $('tcInput')?.focus();
  });
  // Esc 取消回复（Discord 那套）：草稿留着，只是不再挂在哪条议题下
  $('tcInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && replyTo) { e.stopPropagation(); clearReply(); }
  });
  $('tcNewTopic')?.addEventListener('click', () => {
    clearReply();
    $('tcInput')?.focus();
  });
  syncReplyDock();
  wireReplyButtons(); // 首屏那批「回复」按钮也要接上 —— 漏了这行，点了没反应（2026-10-18 实测踩过）

  /* ↓↓↓ 这些委托**必须挂在 host.innerHTML 之后**（上面才把新 #tcThreads 放进文档）。
     提前挂 = 挂在旧节点/null 上，页面怎么点都没反应 —— 2026-10-30 重跑哑弹的根因。 */
  // 折叠开关：点击 summary 后 details.open 已被浏览器切换，这里同步记下"用户展开/收起过哪些议题"，
  // 供下一次重画还原（收起过的不再被自动展开抢回去）。用 click 委托（details 的 toggle 事件不冒泡，得靠 click）。
  $('tcThreads')?.addEventListener('click', (e) => {
    const d = e.target.closest?.('details.tc-replies');
    if (!d) return;
    const id = d.dataset.replies;
    if (d.open) { openTopics.add(id); collapsedTopics.delete(id); }
    else { openTopics.delete(id); collapsedTopics.add(id); }
  });
  // 重跑按钮是画在讨论区行里的，页面随时重画 —— 委托到容器上，别逐个绑
  $('tcThreads')?.addEventListener('click', (e) => {
    const btn = e.target.closest?.('[data-rerun]');
    if (!btn) return;
    e.preventDefault();
    const topicId = btn.closest('.tc-topic')?.dataset.topic ?? null;
    rerunTask(topicId).catch((err) => toast(err.message, 'error'));
  });

  const refreshThread = async () => {
    if (!convId) return;
    try {
      const d = await api(`/api/conversations/${encodeURIComponent(convId)}`);
      conv = d;
      paintCmtBadge(d);   // 新到的议论要反映到导航栏角标上（抽屉可能正好收着）
      const box = $('tcThreads');
      if (!box) return;
      // 输入框若停靠在议题里，先搬回底部 —— 不然下面的 innerHTML 重建会把它连草稿一起销毁
      homeComposer();
      box.innerHTML = threadsHtml(d);
      wireReplyButtons();
      syncReplyDock(); // 再停靠回去（回复横幅、议题高亮一起补上）
      // 他还在跑 → 把进度卡挂回去（2026-10-30 用户："他停下来了" —— 其实是重画把它冲掉了，
      // stream 还活着、一直在往那块（已脱文档的）DOM 里写，挂回去内容一条不少）
      if (liveRunId && liveEl && !liveEl.isConnected) {
        const topics = box.querySelectorAll('.tc-topic');
        const host = topics.length
          ? topics[topics.length - 1].querySelector('[data-replies]') ?? box
          : box;
        host.appendChild(liveEl);
        const det = liveEl.closest?.('details.tc-replies');
        if (det) det.open = true;
      }
    } catch { /* 拉不到就保持原样，别把页面弄炸 */ }
  };

  /**
   * 发送键 ↔ 停止生成（2026-10-29 用户："在生成时，发送变成停止生成。就像是对话面板输入框那样"）：
   * 原来「停止生成」单摆在输入框下面一颗，发送键还在 —— 人一眼扫到两个按钮，不知道点哪个。
   * 现在照对话页 setBusy 的规矩：跑着 → 发送键原地变成「停止生成」，跑完自动变回来。
   */
  const syncStop = () => {
    const send = $('tcSend');
    if (send) {
      send.classList.toggle('stopping', !!liveRunId);
      send.textContent = liveRunId ? '停止生成' : '发送';
      send.title = liveRunId ? '掐掉这一轮（他已经说出来的话会留着）' : '发送';
    }
    const input = $('tcInput');
    if (input && input !== document.activeElement) {
      // 不抢正在打字的焦点框：只在没在打字时换提示语（打字中的草稿不受影响）
      paintMode();
    }
    const hint = $('tcHint2');
    // 跑着才说"一次只跑一条"；跑完必须收回 —— 不然这句话一直挂着，人以为还在跑（2026-10-24 用户实感）。
    // 手机上这行也不显示（2026-11-05 用户要求：输入框下面不要挂说明）。
    if (hint) hint.textContent = liveRunId && !isNarrowPh() ? '一次只跑一条。要打断就点「停止生成」。' : '';
  };

  /**
   * 这一轮运行（停止按钮要用它的 id —— 光知道"忙不忙"是停不掉的，跟主聊天页的 chatRunningId 一个道理）。
   *
   * ⚠️ 是"停止"，不是"暂停"：底层 runtime 都是一次性子进程，没有暂停/续跑这回事。
   *    停掉的是**这一轮**，不是这个人 —— 会话、上下文、卡片都还在，再说一句就能接着办。
   */
  const abortRun = async () => {
    const rid = liveRunId;
    if (!rid) return;
    // 先让界面立刻停下（点完就见效，不等后端回调）—— 跟主聊天页 stopChatRun 一个做法
    liveRunId = null;
    syncStop();
    if ($('tcHint2')) $('tcHint2').textContent = '已停下（他说过的话留着）。';
    stream?.close?.();
    stream = null;
    if (liveTick) { clearInterval(liveTick); liveTick = null; }
    try {
      await api(`/api/runs/${encodeURIComponent(rid)}/abort`, { method: 'POST' });
    } catch (e) {
      toast(e.message, 'error');
    }
    await refreshThread();
    // 收尾后卡片状态会落到「已阻塞」那一档 —— 右栏和页头跟着刷一次
    api(`/api/projects/tasks/${encodeURIComponent(taskId)}`)
      .then((d) => { if (d?.task) { task = d.task; refreshHeader(); } })
      .catch(() => { /* 取不到就等下次刷新 */ });
  };

  /**
   * 接实时流：**一个气泡里追加分块**（跟主聊天页 `attachStream` 一个写法），
   * 收尾后从库里重画 —— 流式气泡是临时的，库里那份才是完整的。
   * 落点：正在回复的那个议题的回复区里；不知道是哪个议题（比如改状态开的工、或刷新后接上）就落在
   * **最后一条议题**下面 —— 绝不能落到列表末尾，那样看着像他另开了一条新评论（2026-10-18 用户指出）。
   *
   * 2026-10-29 用户："这里只看到嘉辉在跑，看不到是不是卡了。对话里的那一套搬过来用" ——
   * 原来讨论区只有一个三个点的 typing 气泡；现在换成和对话页**同一块运行进度卡**
   * （run-progress-card.mjs）：阶段 + 第几步 + 总用时、最近动作、卡住了把「停止生成」摆到眼前。
   */
  const attach = (runId, topicId = replyTo, startedAt = null) => {
    if (!runId || stream) return;
    liveRunId = runId; // 有这一轮在跑 → 露出「停止生成」
    syncStop();
    const id = 'tcLive-' + runId;
    // 落点三查（2026-10-30 用户："回复挂载在另外一个位置"）：
    //   ① topicId 正好是议题头 → [data-replies] 直接命中；
    //   ② topicId 是议题里某条消息（或被服务端拍平前的原话）→ 按 data-mid 反查所在议题；
    //   ③ 都查不到（开工说明这种被摘掉的锚）→ 兜底最后一个议题。
    let host = null;
    if (topicId) {
      const threads = $('tcThreads');
      host = threads?.querySelector(`[data-replies="${CSS.escape(topicId)}"]`) ?? null;
      if (!host) {
        const mid = threads?.querySelector(`[data-mid="${CSS.escape(topicId)}"]`);
        host = mid?.closest('.tc-topic')?.querySelector('[data-replies]') ?? null;
      }
    }
    if (!host) {
      const topics = $('tcThreads')?.querySelectorAll('.tc-topic');
      host = topics?.length ? topics[topics.length - 1].querySelector('[data-replies]') : null;
    }
    // 回复区是折叠的 details 时，先展开 —— 不然 live 气泡塞进折叠区里看不见
    if (host?.matches?.('details.tc-replies') && !host.open) {
      host.open = true;
      if (topicId) openTopics.add(topicId);
    }
    host = host || $('tcThreads');
    host?.insertAdjacentHTML(
      'beforeend',
      `<div class="tc-cmt live" id="${id}">
        ${smAvatar(whoName, '', personaByName(whoName))}
        <div class="tc-cmt-main"><div class="tc-cmt-meta"><b>${esc(whoName)}</b><span class="dim">工作中…</span></div>
        <div class="tc-cmt-text"></div></div></div>`,
    );
    liveEl = document.getElementById(id); // 记住这块气泡：讨论区每次重画都要靠它挂回去
    scrollThreads();
    const body = document.querySelector('#' + id + ' .tc-cmt-text');
    // 进度卡和对话页同一套；卡上的「停止生成」掐的是这一轮（abortRun 在上面，含界面立即停 + 服务端 abort）
    const card = createProgressCard({ startedAt, onStop: () => abortRun() });
    body?.appendChild(card.el);
    scrollThreads();
    const add = (cls, text, asHtml = false) => {
      const d = document.createElement('div');
      d.className = 'step ' + cls;
      if (asHtml) d.innerHTML = text; else d.textContent = text;
      body?.appendChild(d);
      scrollThreads();
    };
    const finishUp = () => {
      if (liveTick) { clearInterval(liveTick); liveTick = null; }
      stream?.close?.();
      stream = null;
      liveRunId = null; // 这一轮结束了 → 收起「停止生成」
      liveEl = null;    // 气泡跟着这一轮作废（下一轮 attach 会造新的）
      syncStop();
      refreshThread();
      // 跑完卡片状态会收成「待验收」—— 页头那颗 pill 跟着刷一下（不重画整页，评论草稿不丢）
      api(`/api/projects/tasks/${encodeURIComponent(taskId)}`)
        .then((d) => { if (d?.task) { task = d.task; refreshHeader(); } })
        .catch(() => { /* 取不到就等下次刷新 */ });
    };
    liveTick = setInterval(() => card.paint(), 1000);
    stream = streamRun(runId, {
      // 每个原始事件喂给进度卡：走到哪一步、多久没动静、是不是卡住了，全靠它
      onEvent: (evt) => card.applyEvent(evt),
      onText: (chunk) => add('text', renderMarkdown(chunk), true),
      onRunError: (msg) => { add('bad', '· ' + firstMeaningfulLine(msg)); card.paint(); },
      onDone: (evt) => {
        // 先把"完成/停止/失败 + 总用时"定格一帧，再由 refreshThread 从库里重画
        card.finish(evt.status);
        finishUp();
      },
      onReconnect: () => refreshThread(),
    });
    // 弹窗那条路：记到模块级，openTaskCardDialog 关弹窗时掐掉
    // （不掐的话它还在后台收消息，往一个已经从文档里摘掉的 DOM 里写）
    if (dlg) tcDlgStream = stream;
  };
  if (runningRun) attach(runningRun.id, null, runningRun.startedAt); // 打开时正好在跑 → 接上，不等刷新

  const sendText = async () => {
    const text = $('tcInput').value.trim();
    if (!text && !pendingAtts.length) return;
    if (attSending) return;
    if (!whoCombo.value()) {
      // 还没发起的流程卡没有执行人可讨论（右边只有「（由流程执行）」一项）——
      // 照着老文案叫他"选执行人"等于指路指到死胡同。
      toast(flowOnly
        ? `这张卡由流程「${flowName}」执行 —— 等它发起后，去流程实例里跟当前经办人往来`
        : isNarrowPh()
          ? '先指定一个执行人 —— 评论区是跟他讨论的'
          : '先在右边选一个执行人 —— 评论区是跟他讨论的');
      return;
    }
    const mode = sendMode; // note | discuss | execute
    const parentId = replyTo;
    // 真人执行的卡（2026-10-31）：没有员工会话，评论区这条链路走不通 —— 直说，别让服务端的报错来代言
    const whoVal = String(whoCombo.value());
    if (whoVal.startsWith('u:')) {
      toast('这张卡派给了真人 —— 评论区是跟数字员工讨论的；要让员工接手，把执行人改成他');
      return;
    }
    let sent = false;   // 真发出去了没有：决定收尾是"收键盘"还是"留着改"
    $('tcInput').disabled = true;
    $('tcSend').disabled = true;
    try {
      // 刚在右边选的人可能还没点「保存」：先落库，否则服务端会说"先指定执行人"。
      if (task.assigneePersonaId !== whoVal) {
        const saved = await api(`/api/projects/tasks/${encodeURIComponent(taskId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ personaId: whoVal }),
        });
        task.assigneePersonaId = saved?.task?.assigneePersonaId ?? whoVal;
      }
      // 附件先逐个上传：第一次会懒建工单会话，返回的 conversationId 之后直接复用
      let atts = null;
      const pending = pendingAtts;
      if (pending.length) {
        attSending = true;
        try {
          atts = [];
          for (const a of pending) {
            const d = await api(`/api/projects/tasks/${encodeURIComponent(taskId)}/files?name=${encodeURIComponent(a.name)}`, {
              method: 'POST',
              headers: { 'Content-Type': a.mime || 'application/octet-stream' },
              body: a.file,
            });
            convId = d.conversationId ?? convId;
            atts.push({ name: d.file.name, stored: d.file.stored, size: d.file.size, mime: d.file.mime });
          }
        } catch (err) {
          toast(`附件没传上去：${err.message}`, 'error');
          return;
        } finally {
          attSending = false;
        }
      }
      const r = await api(`/api/projects/tasks/${encodeURIComponent(taskId)}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, parentId, mode, atts }),
      });
      convId = r.conversationId ?? convId;
      $('tcInput').value = '';
      clearTcAtts();
      // 发完就退出回复态、回到底部（2026-10-24 用户拍板：发完还挂着"回复：xxx"看着像出了问题；
      // X / YouTube / Reddit / Discord 发完回复也都回到默认态）。想接着聊就再点那条的「回复」——
      // 折叠条带着最新回复预览、点开自动展开，回去的成本很低。
      clearReply();
      await refreshThread();
      // 新开的议题：他这次的回复要落进**我刚发的那条**下面（服务端也是这么挂 parentId 的）。
      // 落点优先用新评论自己的 id —— 分组可能把它归进已有线程（回复被服务端拍平到开工说明时），
      // attach 会按 data-mid 反查它实际落在哪个议题，进度卡就跟到哪（2026-10-30 用户："回复挂载在另外一个位置"）
      if (r.runId) attach(r.runId, r.message?.id ?? parentId ?? null);
      else if ($('tcHint2')) {
        $('tcHint2').textContent = '已记下 —— 便签只给你看，没叫醒他。';
      }
      sent = true;
    } catch (e) {
      // 400/409 的原因要原样说出来（比如"他还在跑上一条"）
      toast(`没发出去：${e.message}`);
    } finally {
      $('tcInput').disabled = false;
      $('tcSend').disabled = false;
      // 发完回到默认档「讨论」（手机桌面同一算法）——别把上一把的选择留到下一句
      if (sendMode !== DEFAULT_MODE) { sendMode = DEFAULT_MODE; paintMode(); }
      if (sent) {
        /* 发完就收键盘、回单行态（2026-11-06 用户口径）：评论发出后画面该是评论区本体，
           不该还支着键盘跟一张展开的输入卡。先 blur 收键盘，再显式回单行（blur 那条
           120ms 的兜底看到 !expanded 会自己跳过，不会打架）。 */
        $('tcInput').blur();
        tcCompact();
        // 收起后抽屉变回 78% 高、列表换了尺寸 —— 滚到最新一条，刚发的那句就在眼前
        requestAnimationFrame(scrollSheetBottom);
      } else {
        // 没发出去（校验没过 / 接口报错）：焦点留在输入框，改完能直接再发
        $('tcInput').focus();
      }
    }
  };
  // 发送键身兼两职（对话页同款）：闲时是「发送」，他跑着时是「停止生成」
  $('tcSend').onclick = () => ($('tcSend').classList.contains('stopping') ? abortRun() : sendText());

  // 页面要被换掉 / 弹窗要关时，把挂在 document 上的收起监听摘掉（否则会一层层堆起来，见 setRoute）
  cleanups.push(() => document.removeEventListener('click', onDocClick));
}



/**
 * **全局任务看板**：所有项目的活铺在同一张看板上（入口：工作台 → 任务看板）。
 *
 * 它跟项目看板是**同一张看板**（共用 `openBoardPage`），只是 `project = null`：
 * 数据取 `/api/tasks`、卡片上多一枚「哪个项目」的标签、列头「＋」建卡时要选项目。
 * 服务端那边 `allTasks()` 与 `projectTasks()` 也共用 `board()` —— 同一套行、同一套列。
 */
export async function openTaskBoard() {
  setRoute('taskBoard');
  const view = $('pluginView');
  view.classList.add('kb-page'); // 跟项目看板一样满屏（同一套 CSS）
  document.body.classList.add('no-list'); // 看板是满屏页，左栏收掉（直接调进来时 setNav 不一定跑过）
  S.boardAll = true;             // 位置记忆：刷新回到全局面板
  S.projectId = null;
  S.projectList = false;
  S.plugin = null;               // 它不是插件，别让插件那条路抢走位置
  savePlace();

  await openBoardPage({ project: null });
}



/** 看板的一列：列头（名字 + 张数 + ＋）+ 卡片；空列也画出来，写「无任务」 */
export function kbColumn(col) {
  /*
   * 只有「想法」「待办」两列的列头给「＋」建卡（2026-10-27 用户："每个面板都能创建任务，
   * 是不是改成只有想法能创建任务更好一些" → 定成想法 + 待办）：
   *   · 想法 = 收集箱（默认落点，不派活）；
   *   · 待办 = 决定做了的排队区（指派人就开跑，所以要人明确选这一列）；
   *   · 进行中及之后的列（进行中 / 待验收 / 已阻塞 / 失败 / 已完成 / 已取消）里的卡都是
   *     **状态流转的产物**，直接在那儿建卡没有语义，还容易建出"已完成"的新卡。
   * 流程卡、仓库值班卡、员工建的卡不走这个入口，照常生成。
   */
  const canAdd = col.key === 'idea' || col.key === 'todo';
  return `<section class="kb-col ${esc(col.key)}" data-kb-col="${esc(col.key)}">
    <header class="kb-col-head">
      <span class="kb-dot"></span><b>${esc(col.label)}</b>
      <span class="kb-count">${col.count}</span>
      ${col.hint ? `<span class="kb-hint">${esc(col.hint)}</span>` : ''}
      ${canAdd ? `<button class="kb-add" type="button" data-kb-add="${esc(col.key)}" title="在这一列新建任务">＋</button>` : ''}
    </header>
    <div class="kb-cards">
      ${col.cards.length ? col.cards.map(kbCard).join('') : '<div class="kb-empty">无任务</div>'}
    </div>
  </section>`;
}



/**
 * 一张任务卡：来源标出来、执行人写清楚。
 *   · 流程卡 → 那条实例；聊天卡 → 那个会话；手工卡 → 那个会话（没派活就没地方可去）
 *   · **手工卡可以拖到别的列**（改状态）—— 看板上最自然的手势，跟同类产品一致
 */
/** PR 联动（2026-10-17）：卡片上那枚「PR #n 开着/已合并」小标签；没关联 PR 就什么都不画 */
export function prPillOf(r) {
  if (!r?.pr) return '';
  const text = r.pr.state === 'merged' ? '已合并' : r.pr.state === 'closed' ? '已关闭' : '开着';
  return `<span class="kb-tag pr" title="关联的 Pull Request">PR #${r.pr.number} ${text}</span>`;
}



export function kbCard(r) {
  /*
   * 「本地卡」= 存在 project_tasks 里的那些：手工建的（`manual`）与**仓库值班写进来的**（`repo`）。
   * 同一族：都能拖（**拖到哪一列就是人给的指令**）、都能删（＝忽略）。
   * 流程卡与聊天卡的状态归平台管，拖不动。
   */
  // 协作卡（2026-10-31）也算"本地卡"：能拖（拖到哪一列就是告诉中心'我干到哪一步了'）。
  // 三条判据必须一起认 —— 漏一处卡就点不开、筛选也错（任务书 §十五 第 7 条）
  // `remote`（2026-11-01）：中心这边**派到分公司**的活 —— 数据归那台机器，这儿只读
  // （拖不动、删不掉：改状态要到那台机器上改，或者以后在协作中心撤单）。
  const local = !r.remote && (r.source === 'manual' || r.source === 'repo' || r.source === 'collab');
  const jump = r.source === 'flow'
    ? `data-kb-flow="${esc(r.flow_id)}" data-kb-tpl="${esc(r.template_id || '')}"`
    : r.conversation_id
      ? `data-kb-conv="${esc(r.conversation_id)}"`
      : '';
  const drag = local
    ? `draggable="true" data-kb-manual="${esc(r.manual_id)}"`
    : '';
  // 本地卡多一颗删除（拖错了、建错了、不想管了要能撤）
  const del = local ? `<button class="kb-del" type="button" data-kb-del="${esc(r.manual_id)}" title="删掉这张卡">×</button>` : '';
  // 全局面板的行才带 project_name（项目看板的行服务端已经摘掉了）——
  // 站在全局看，第一眼要知道的就是"这是哪个项目的活"
  // 派到分公司的卡不画它：`协作 · 设备` 跟右边的设备标签是同一句话，画两遍反而吵
  const proj = r.project_name && !r.remote
    ? `<span class="kb-tag proj" title="属于哪个项目">${esc(r.project_name)}</span>`
    : '';
  const srcCls = r.source === 'chat' ? ' chat' : r.source === 'repo' ? ' repo' : local ? ' manual' : '';
  /* 派到分公司的卡（2026-11-01）：多一枚设备标签，鼠标悬停说清楚"改状态得去那台机器"。
     二十改：验收/撤销直接长在卡上（原来在协作中心的表里，那张表撤了 —— 展示和动作
     都归任务面板）：待验收 → 「验收」；没到终态 → 「撤销」；终态不给动作。 */
  const clAct = r.remote && r.collab_task_id
    ? r.status === '待验收'
      ? `<button class="kb-act" type="button" data-kb-cl-done="${esc(r.collab_task_id)}" title="验收：这活干完了，收下">验收</button>`
      : r.status !== '已完成' && r.status !== '已取消'
        ? `<button class="kb-act" type="button" data-kb-cl-cancel="${esc(r.collab_task_id)}" title="撤销：不干了，两边一起停">撤销</button>`
        : ''
    : '';
  const devTag = r.remote && r.device
    ? `<span class="kb-tag dev" title="这张卡在「${esc(r.device)}」上跑 —— 状态由那台机器报回来">${esc(r.device)}</span>`
    : '';
  const remoteAttrs = r.remote ? `data-kb-collab="${esc(r.collab_task_id || '')}"` : '';
  return `<article class="kb-card ${local ? 'manual' : ''}${r.remote ? ' remote' : ''}" ${jump} ${drag}${local ? ` data-kb-open="${esc(r.manual_id)}" tabindex="0"` : remoteAttrs} data-col="${esc(r.col)}" title="${esc(r.note || '')}">
    <div class="kb-card-top">
      ${proj}<span class="kb-tag${srcCls}">${esc(r.source_text)}</span>${devTag}${prPillOf(r)}
      <span class="kb-state">${esc(r.status)}</span>
      ${clAct}${del}
    </div>
    <div class="kb-card-title">${esc(r.task)}</div>
    <div class="kb-card-foot"><span class="kb-who">${esc(r.assignee)}</span><span>${esc(r.at)}</span></div>
  </article>`;
}



/**
 * 新建手工任务的弹窗（参照同类产品 的「＋」那个框）。
 *
 * 只有标题是必填。执行方式二选一（2026-10-26）：
 *   · 派给人：选了执行人就能勾「创建后立即开始工作」——那会**真的派活**
 *     （发到他的 1:1 会话，工作目录是这个项目），所以框里明写出来，别让人意外；
 *   · 由流程执行：选一条**已发布**的流程，卡建完立刻发起一条实例、卡绑住它（flowRunId）。
 *     这种情况下状态不是「想法」就一定会发起，所以那个勾是锁死的（见 syncStart 的注释）。
 *
 * `project` 为 null = **从全局面板点的「＋」**：那一页没有"当前项目"，
 * 手工卡又必须挂在某个项目下（服务端 `createProjectTask` 要 project），
 * 所以弹窗里多一个项目下拉，让人先挑一个。
 */
export function taskDialog(project, colKey) {
  const dlg = document.createElement('dialog');
  dlg.id = 'taskDlg';
  const status = COL_STATUS[colKey] ?? '待办';
  const projects = S.projects ?? [];
  /*
   * 项目 / 执行人**都换成可搜索的下拉**（全站公共组件 createCombo）——
   * 项目一多、数字员工一多，原生 select 只能一格一格翻，搜不了。
   * 状态那格只有 6 个固定值，继续用原生 select。
   */
  /*
   * 轻快风（2026-10-26 用户给了截图「我想要这种效果」）：左上角一条小面包屑，
   * 下面直接就是大标题输入框和描述（都没有边框），所有字段收成底部一排胶囊，
   * 动作条（继续创建 / 创建任务 Ctrl+Enter）压在最底下。
   * 胶囊里只有值没有字段名 —— 状态/执行方式/人名/项目名各自能看懂自己是谁。
   */
  const pick = !project ? '<span class="tk-chip" id="tkProjMount"></span>' : '';
  dlg.innerHTML = `
    <form method="dialog">
      <b class="tk-crumb">${project ? `${esc(project.name)} › ` : ''}手动创建</b>
      <input id="tkTitle" placeholder="任务标题" />
      <textarea id="tkDesc" rows="7" placeholder="添加描述..."></textarea>
      <!-- 执行人 / 流程**二选一显示**（服务端也是二选一，见 routes/project.mjs 的 400）：
           两个都摆出来会让人以为"人再挂条流程"也能行。 -->
      <div class="tk-meta-row">
        <span class="tk-chip" id="tkStatusMount"></span>
        <span class="tk-chip" id="tkModeMount"></span>
        <span class="tk-chip" id="tkWhoMount"></span>
        <span class="tk-chip" id="tkFlowMount" hidden></span>
        <!-- 执行设备（2026-11-01 用户："派活这一步加进任务面板，指定设备"）：
             只有本机 = 只有「本设备」；接了分公司（协作中心）就多几项，选了就派到那台机器上跑。 -->
        <span class="tk-chip" id="tkDevMount"></span>
        ${pick}
      </div>
      <div class="dim" id="tkDevHint" style="font-size:12px" hidden>派到分公司：卡建在<b>那台机器</b>上，状态由它报回来（看板上那张卡只读）。</div>
      <div class="dim" id="tkFlowEmpty" style="font-size:12px" hidden>还没有已发布的流程 —— 先去工作台 → 流程 里发布一条</div>
      <div class="dim" id="tkFilterHint" style="font-size:12px" hidden></div>
      <div class="tk-foot">
        <label class="kb-check"><input type="checkbox" id="tkStart" checked /> <span id="tkStartText">创建后立即开始工作</span></label>
        <div class="tk-foot-actions">
          <!-- 继续创建：建完不关弹窗，清空标题描述接着建下一张（看板在后台刷新） -->
          <label class="kb-check"><input type="checkbox" id="tkAgain" /> <span>继续创建</span></label>
          <button class="primary" id="tkOk" value="ok">创建任务 <kbd>Ctrl ↵</kbd></button>
        </div>
      </div>
    </form>`;
  document.body.append(dlg);
  // 轻快风截图右上角有「放大成抽屉」的角 —— data-max 让 wireDialogHead 顺手补上那颗按钮
  dlg.setAttribute('data-max', '');
  // 动态建的对话框**得自己包一次头部** —— 页面加载时那一遍它还不存在（见 wireDialogHead）
  wireDialogHead(dlg.querySelector('form'));
  dlg.addEventListener('close', () => dlg.remove());

  // 状态那格：只有 6 个固定值，**不传 search**（组件的约定是选项多的才给搜索）
  const statusCombo = createCombo({
    mount: $('tkStatusMount'),
    items: ['想法', '待办', '进行中', '待验收', '已阻塞', '失败', '已完成', '已取消'].map((s) => ({ id: s, label: s })),
    value: status,
    // 这两件事都定义在下面 —— 点选时才跑，那时它们早就绪了（顺序是有意的）
    onChange: () => {
      syncStart();
      syncFilterHint();
    },
  });
  // 项目下拉：不固定项目时才有（点某一列的「＋」时，项目已经定了）
  const projCombo = project
    ? null
    : createCombo({
        mount: $('tkProjMount'),
        items: projects.map((p) => ({ id: p.id, label: `${p.name} · ${p.root}` })),
        value: projects[0]?.id ?? '',
        search: true,
        placeholder: '搜项目名或目录…',
        empty: '没有匹配的项目',
        // 胶囊上只放项目名（`名字 · 路径` 太长会把胶囊撑爆）；清单里照旧带路径
        buttonText: (id) => projects.find((x) => x.id === id)?.name ?? '选项目',
        blank: '选项目',
        // 换项目 = 可能换成"筛选之外的项目"，那句提醒要跟着重算
        onChange: () => syncFilterHint(),
      });
  const whoCombo = createCombo({
    mount: $('tkWhoMount'),
    /*
     * 执行人一格二选一（2026-10-31 用户概念落地）：数字员工（会派活）或**真人**（挂名负责，
     * 不起会话不派活）——真人选项 id 带 `u:` 前缀，提交时换成 assigneeUserId。
     */
    items: [
      { id: '', label: '不派活' },
      ...(S.users ?? []).map((u) => ({ id: `u:${u.id}`, label: u.name })),
      ...(S.personas ?? []).map((p) => ({ id: p.id, label: personLabel(p) })),
    ],
    value: '',
    search: true,
    placeholder: '搜名字或岗位…',
    empty: '没有匹配的人',
    // 这个箭头只在**点选时**才跑，那时下面的 syncStart / syncFilterHint 早就定义好了 —— 顺序是有意的
    onChange: () => {
      syncStart();
      syncFilterHint(); // 选了个人 → 可能这个人不在当前筛选里，提醒要跟着变
    },
  });

  /*
   * 执行方式：**派给人 / 由流程执行**（2026-10-26 用户定）。
   * 为什么做成显式的两选一、而不是"执行人下拉里多一项流程"：
   * 这两条路后面发生的事完全不同（一个是派活到会话，一个是发起一整条流程、卡跟着流程走），
   * 塞进同一个下拉里，人选完才知道"哦这不是一个人"。
   * 选项只有两个 → 不传 search（组件的约定：选项多的才给搜索）。
   */
  const modeCombo = createCombo({
    mount: $('tkModeMount'),
    items: [{ id: 'person', label: '派给人' }, { id: 'flow', label: '由流程执行' }],
    value: 'person',
    onChange: () => syncMode(),
  });
  const flowMode = () => modeCombo.value() === 'flow';
  /*
   * 流程那格只列**已发布**的（`S.flowPublished`，项目启动时 load() 就取回来了）：
   * 草稿态的流程发不起来，列出来只会让人选了再吃一个 400（服务端 `assertRunnableFlow` 也这么挡）。
   */
  const published = S.flowPublished ?? [];
  const flowCombo = createCombo({
    mount: $('tkFlowMount'),
    items: published.map((f) => ({ id: f.id, label: f.name })),
    value: published[0]?.id ?? '',
    blank: '选流程',
    empty: '还没有已发布的流程 —— 先去工作台 → 流程 里发布一条',
    onChange: () => {
      syncStart();
      syncFilterHint();
    },
  });

  /**
   * **执行设备**（2026-11-01 用户："派活这一步加进任务面板，指定设备"）。
   *
   * 只有本机 = 只有「本设备」一项（默认，行为跟从前一字不差）；
   * 接了分公司（协作中心）就多几项，选了以后这张活**派到那台机器上跑**：
   *   · 卡建在那台机器上（它的本地项目「协作 · 中心名」），由它执行、它报状态；
   *   · 中心的看板上出现的是一张**只读**卡（`source: 'collab'`，带设备标签），
   *     不能拖、不能删 —— 要改去那台机器上改，或者在协作中心撤销。
   * 为什么不双写一张本地卡：同一个状态两个来源，迟早出现"这边进行中、那边已完成"。
   *
   * 清单是**打开弹窗后现拉**的：分公司会随时加入/被移除，缓存一份只会显示过期的。
   */
  const devCombo = createCombo({
    mount: $('tkDevMount'),
    items: [{ id: '', label: '本设备' }],
    value: '',
    blank: '本设备',
    onChange: () => syncDevice(),
  });
  api('/api/collab/branches')
    .then((r) => {
      // 只有**已接入**的能收活（待接入的派过去没人领，服务端也会拒 E4046）
      const list = (r?.branches ?? []).filter((b) => b.status === 'active');
      if (!list.length || !devCombo) return;
      devCombo.setItems([
        { id: '', label: '本设备' },
        ...list.map((b) => ({ id: b.id, label: `${b.label}${b.online ? '' : '（离线）'}` })),
      ]);
    })
    .catch(() => { /* 没有协作表 / 读不到 —— 就当没接分公司，只有本设备 */ });

  /*
   * 「立即开始」什么时候不该给勾 / 什么时候不给改：
   *   · 派给人：没选执行人 = 勾了也没人可派；状态是「想法」= 还没决定要不要做，谈不上开始。
   *   · 由流程执行：选了流程、状态又不是「想法」，建卡就**一定**发起（见下面 POST 的 startNow）——
   *     所以这个勾在流程模式下是**锁死的**：它不是给人改的，只用来表示"会发生什么"。
   *     想先挂着就放到「想法」列（那一列不发起，之后拖进「进行中」再发起）。
   * 不可用时灰掉、把原因写在文案和 title 上 —— 让人**别以为勾了个空**。
   */
  const syncStart = () => {
    const box = $('tkStart');
    const wrap = box.closest('.kb-check');
    const text = $('tkStartText');
    const idea = statusCombo.value() === '想法';
    // 真人执行（2026-10-31）：挂名负责，没有"开始工作"这件事 —— 勾锁死在取消上
    if (String(whoCombo.value()).startsWith('u:')) {
      box.disabled = true;
      box.checked = false;
      wrap.style.opacity = '.5';
      text.textContent = '真人执行 —— 卡挂在他名下，不起会话也不派活';
      wrap.title = '真人执行的卡不会自动开跑；要让员工干，执行人选数字员工';
      return;
    }
    if (flowMode()) {
      const picked = !!flowCombo.value();
      const on = picked && !idea; // 定了流程且不是「想法」→ 锁在勾上；否则锁在取消
      box.disabled = !on;
      box.checked = on;
      wrap.style.opacity = on ? '1' : '.5';
      text.textContent = !picked
        ? '创建后立即发起流程（先选一条流程）'
        : idea
          ? '先不发起 —— 状态是「想法」；拖到「进行中」才发起流程'
          : '创建后立即发起流程 —— 选了流程就立即发起；想先挂着就放到「想法」';
      wrap.title = !picked
        ? '先选一条流程'
        : idea
          ? '「想法」列先挂着，等拖到「进行中」再发起流程'
          : '选了流程就立即发起；想先挂着就放到「想法」';
      return;
    }
    const has = !!whoCombo.value();
    const on = has && !idea;
    box.disabled = !on;
    if (!on) box.checked = false;
    wrap.style.opacity = on ? '1' : '.5';
    text.textContent = '创建后立即开始工作（派到他的会话，工作目录就是这个项目）';
    wrap.title = idea ? '「想法」是还没决定要不要做，先不派活' : has ? '' : '先选一个执行人';
  };
  /*
   * 看板上有筛选时，先说清楚"这张卡建完会不会被挡住"：
   * 挡在筛外的东西不止状态了（还有负责人、项目），所以要把**是哪一维**说出来 ——
   * 只说"看不到它"，人就得自己去猜是哪一条筛掉的。
   * 这比事后让人怀疑"我是不是没建成"强。
   */
  const syncFilterHint = () => {
    const el = $('tkFilterHint');
    if (!el) return;
    const st = statusCombo.value();
    /*
     * 流程模式只判**状态**那一维（这是任务上定下的口径）：这张卡派给谁，是流程发起后
     * "当前那一步的经办人"定的，建卡这一刻根本不知道（流程模式也没有选人这一步）——
     * 拿 who 去判必然是误报，而状态是建卡时人自己就能定、也最容易被筛掉的那一维。
     */
    const why = flowMode()
      ? ((S.kbFilter?.statuses?.length ?? 0) > 0 && !S.kbFilter.statuses.includes(st) ? 'status' : '')
      // 派给人：拿一张"将要建出来的卡"去试 —— 状态是选的那个，人是选的那个人，项目是这一页定的那个；
      // 来历就是"手动建卡"（这个弹窗只能建出这种卡）
      : kbWhyHidden(
          { status: st, assignee_id: whoCombo.value() || '', project_id: project?.id ?? projCombo?.value() ?? '', source: 'manual' },
          S.boardAll ? 'all' : undefined,
        );
    el.hidden = !why;
    el.textContent = !why
      ? ''
      : why === 'status'
        ? `注意：当前筛选不含「${st}」，建完这张卡会留在看板外面（点「清除」能看到）。`
        : why === 'who'
          ? '注意：当前筛选只看别人 —— 这张卡派给他之后会留在看板外面（点「清除」能看到）。'
          : why === 'src'
            ? '注意：当前筛选不含手动建的卡 —— 这张卡建完会留在看板外面（点「清除」能看到）。'
            : '注意：当前筛选只看别的项目 —— 这张卡建完会留在看板外面（点「清除」能看到）。';
  };
  /*
   * 切执行方式只换**显示**：两边已经选好的值（人 / 流程）都留着 ——
   * 来回切多半是"看看有没有能用的流程"，切回来还得重选一遍人就很烦。
   */
  const syncMode = () => {
    const flow = flowMode();
    // 轻快风：执行人 / 流程是两颗胶囊，切显隐（两边选好的值都留着 —— 来回切不用重选）
    $('tkWhoMount').hidden = flow;
    $('tkFlowMount').hidden = !flow;
    $('tkFlowEmpty').hidden = !flow || published.length > 0;
    syncDevice();
    syncStart();
    syncFilterHint();
  };

  /**
   * 选了分公司 = 这活交给**那台机器**：执行人 / 执行方式 / 项目 / 状态 / 立即开始
   * 在这儿都没有意义（卡建在那边，状态由它流转），全部收起来，只留标题、描述和一句说明。
   * 选回「本设备」就原样放回来 —— 上面几颗胶囊选好的值不丢。
   */
  function syncDevice() {
    const remote = !!devCombo?.value();
    $('tkWhoMount').hidden = remote || flowMode();
    $('tkModeMount').hidden = remote;
    $('tkFlowMount').hidden = remote || !flowMode();
    $('tkFlowEmpty').hidden = remote || !flowMode() || published.length > 0;
    if (projCombo) $('tkProjMount').hidden = remote; // 派到分公司不挂在中心的项目下
    $('tkStatusMount').hidden = remote;              // 那边从「待办」起，状态在它那边流转
    const hint = $('tkDevHint');
    if (hint) hint.hidden = !remote;
    const start = $('tkStart')?.closest('.kb-check');
    if (start) start.style.visibility = remote ? 'hidden' : '';
  }

  // 状态 / 执行方式 / 流程变了，这几件事都要跟着算 —— 挂在各自 combo 的 onChange 上（见上面创建处）
  syncMode();
  $('tkOk').onclick = async (e) => {
    e.preventDefault();
    const title = $('tkTitle').value.trim();
    if (!title) return toast('任务得有标题');
    /*
     * 派到分公司（2026-11-01）：只发标题 + 描述，其余一律不掺和 ——
     * 卡建在那台机器的本地项目里，状态从「待办」起、由它流转，中心这边只留一张只读卡。
     */
    const devBranch = String(devCombo?.value() ?? '');
    if (devBranch) {
      try {
        await post('/api/collab/tasks', { branchId: devBranch, title, description: $('tkDesc').value.trim() });
        const again = $('tkAgain').checked;
        if (!again) dlg.close();
        else { $('tkTitle').value = ''; $('tkDesc').value = ''; $('tkTitle').focus(); }
        toast('派出去了 —— 它下一次同步（几秒内）就会出现在那台机器的看板上', 'ok');
        await (S.boardAll ? openTaskBoard() : openProjectDetail(project?.id ?? projects[0]?.id));
      } catch (err) {
        toast(err.message, 'error');
      }
      return;
    }
    const chosen = project ?? projects.find((x) => x.id === projCombo?.value());
    if (!chosen) return toast('先建一个项目，任务才有地方挂');
    const flow = flowMode();
    const flowId = flow ? flowCombo.value() : '';
    if (flow && !flowId) {
      return toast('先选一条流程 —— 还没有已发布的流程就去工作台 → 流程 里发布一条');
    }
    const st = statusCombo.value();
    // 执行人二选一的提交形态：`u:` 前缀 = 真人（assigneeUserId，绝不 startNow），否则 = 员工
    const whoVal = String(whoCombo.value());
    const isUser = whoVal.startsWith('u:');
    try {
      const res = await api(`/api/projects/${encodeURIComponent(chosen.id)}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          description: $('tkDesc').value.trim(),
          status: st,
          // 执行方式二选一：流程模式**不带执行人**（服务端把"两个都给"当 400 挡，见 routes/project.mjs）
          ...(flow
            ? { flowTemplateId: flowId }
            : isUser
              ? { assigneeUserId: whoVal.slice(2) }
              : { personaId: whoVal || null }),
          // 流程模式：状态不是「想法」就发起（跟 syncStart 锁死的那个勾是同一份口径）
          startNow: flow ? st !== '想法' : (!isUser && !!whoVal && $('tkStart').checked),
        }),
      });
      const again = $('tkAgain').checked;
      if (!again) dlg.close();
      else {
        // 继续创建：弹窗留着、清掉标题描述接着建；其余选择（状态/执行人/项目）原样保留
        $('tkTitle').value = '';
        $('tkDesc').value = '';
        $('tkTitle').focus();
      }
      // 建完就有实例了 → 明说一句：不然人看着建卡弹窗关掉、看板上一张卡，会以为"流程还没开始"
      if (res?.task?.flowRunId) toast('流程已经起来了 —— 到流程实例里看每一步');
      else if (again) toast('建好了，接着建下一张');
      // 在哪儿建的就在哪儿重画：全局面板回全局面板（刚建的卡会带项目标签出现在那一列）
      await (S.boardAll ? openTaskBoard() : openProjectDetail(chosen.id));
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  // Ctrl（⌘）+ Enter 直接创建 —— 轻快风截图右下角那个 Ctrl↵ 角标就是这个
  dlg.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      $('tkOk').click();
    }
  });
  dlg.showModal();
  setTimeout(() => $('tkTitle')?.focus(), 50);
}



/**
 * 页内浏览目录（浏览器那条路的兜底）：走**服务端**列子目录。
 *
 * 浏览器出于安全不给绝对路径（`webkitdirectory` 只给假路径），
 * 所以只能这样点着往下走；路径也可以直接粘进来（2026-10-22 加，深目录不用一路点）。
 * 返回选中的绝对路径；取消返回 null。
 */
export function browseDirectory(startPath) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.id = 'dirDlg';
    dlg.innerHTML = `
      <form method="dialog">
        <b>选目录</b>
        <div class="row-inline">
          <input id="dirPath" spellcheck="false" placeholder="路径（可以直接粘贴，回车前往）" />
          <button type="button" id="dirGo">前往</button>
        </div>
        <div class="dir-list" id="dirList"></div>
        <div class="dlg-actions">
          <button type="button" value="cancel">取消</button>
          <button class="primary" id="dirOk" value="ok">就选这个目录</button>
        </div>
      </form>`;
    document.body.append(dlg);
    // 动态建的对话框**得自己包一次头部** —— 页面加载时那一遍它还不存在（见 wireDialogHead）
    wireDialogHead(dlg.querySelector('form'));
    let cur = startPath || '';
    let settled = false;
    const settle = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
      dlg.close();
    };
    dlg.addEventListener('close', () => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
      dlg.remove();
    });

    const paint = async () => {
      try {
        const d = await api('/api/fs/dirs' + (cur ? '?path=' + encodeURIComponent(cur) : ''));
        cur = d.path;
        $('dirPath').value = d.path;
        $('dirList').innerHTML =
          (d.parent ? `<div class="dir-row up" data-go="${esc(d.parent)}">↰ 上一层</div>` : '') +
          (d.dirs.length
            ? d.dirs.map((x) => `<div class="dir-row" data-go="${esc(x.path)}">${esc(x.name)}</div>`).join('')
            : '<div class="dir-row none">（没有子目录）</div>');
        $('dirList').querySelectorAll('[data-go]').forEach((el) => {
          el.onclick = () => {
            cur = el.dataset.go;
            paint();
          };
        });
      } catch (e) {
        $('dirList').innerHTML = `<div class="dir-row none">${esc(e.message)}</div>`;
      }
    };
    const go = () => {
      const v = $('dirPath').value.trim();
      if (!v) return;
      cur = v;
      paint();
    };

    $('dirGo').onclick = (e) => {
      e.preventDefault();
      go();
    };
    $('dirPath').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      go();
    });
    $('dirOk').onclick = (e) => {
      e.preventDefault();
      if (!cur) return;
      settle(cur);
    };
    dlg.showModal();
    paint();
  });
}



/**
 * 选**本机**目录的统一入口（项目「工作目录」、仓库本地目录等处共用）。
 *
 * 桌面壳里优先走**壳的原生目录框**：`pick_directory` 命令用 `IFileOpenDialog`，
 * 带主窗口当 owner —— 对话框一定压在这个窗口上、系统标准样式、能一路点到任意盘。
 * 浏览器（`start.cmd` 那条）没有原生框，退回页内浏览（服务端列目录）。
 *
 * ⚠️ 2026-10-22 用户实报「点选择没反应」的根因就是原来那条「服务端弹原生框」：
 * 服务端是没有窗口的后台进程，它 spawn 的 PowerShell 弹的框没有属主，
 * 实测窗口 `IsWindowVisible=false` —— 被最大化的壳窗口整个盖住，按钮一直转「…」。
 * 原生框归壳管，服务端那条已经删掉（见 apps/server/src/server.mjs 的说明）。
 *
 * 返回选中的绝对路径；取消返回 null（不会抛，最差也是页内浏览）。
 */
export async function pickLocalDir({ title = '选择本机目录', startPath = '' } = {}) {
  const invoke = window.__TAURI_INTERNALS__?.invoke || window.__TAURI__?.core?.invoke;
  if (typeof invoke === 'function') {
    try {
      const picked = await invoke('pick_directory', { title, defaultPath: startPath || null });
      return picked || null;
    } catch (e) {
      // 壳里命令不在 / 权限没给 / 系统不支持 —— 退回页内浏览，别让人卡在按钮上
      console.warn('[选目录] 原生目录框不可用，退回页内浏览：', e);
    }
  }
  return browseDirectory(startPath);
}



/**
 * 「选择」目录按钮的公共逻辑（新建弹窗和详情就地编辑共用）。
 */
export async function pickProjectDir(btnId, inputId) {
  // ⚠️ id 必须成对传入：详情表单和新建弹窗**同时在线**，两边若用同名 id，
  // `$('pjName')` 会取到文档里前一个 —— 踩过：新建弹窗实际创建出了
  // "当前选中项目的复制品"（2026-10-18 实测）。
  const btn = $(btnId);
  const el = $(inputId);
  /* 填值必须补发一次 `input`（2026-10-22 修"选择没生效"）：详情页的自动保存只认
     input/blur 事件，代码直接赋 value 什么都不触发 —— 目录看着填上了，其实从没存过。 */
  const apply = (v) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  // 目录框开着时按钮只禁用、**不改字**（2026-10-24 用户：选择按钮不要变成"…"）——
  // 原生框本来就把主窗口压在后面，闪省略号只会让人以为按钮坏了
  btn.disabled = true;
  try {
    const picked = await pickLocalDir({
      title: '选择项目目录（AI 会在这里干活）',
      startPath: el.value.trim(),
    });
    if (picked) apply(picked);
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false; // 字没动过，不用恢复
  }
}



/**
 * 新建项目的小弹窗（2026-10-18 用户定的分工）：**弹窗只问名字和路径**，
 * 附加根 / 说明 / 宪法这些都在右侧详情里编辑（renderProjDetail 的就地编辑）。
 * 只管新建 —— 编辑走详情页，不再有「编辑弹窗」。
 */
export function projectDialog() {
  const dlg = document.createElement('dialog');
  dlg.id = 'projDlg';
  // ⚠️ 这里的 id 全部带 np 前缀（new project）：弹窗打开时详情表单就在背后，
  // 两边同 id 的话 $() 会取到详情那份 —— 实测创建出了"当前项目的复制品"。
  dlg.innerHTML = `
    <form method="dialog">
      <b>新建项目</b>
      <label>名字</label><input id="npName" placeholder="例如：班底" />
      <label>项目目录（AI 就在这儿干活）</label>
      <div class="row-with-btn">
        <input id="npRoot" placeholder="例如：E:\\02CodeSpace\\bandi" />
        <button type="button" id="npPick" title="选一个本机目录（AI 会在这里干活）">选择</button>
      </div>
      <div class="dlg-actions">
        <button type="button" value="cancel">取消</button>
        <button class="primary" id="npOk" value="ok">创建</button>
      </div>
    </form>`;
  document.body.append(dlg);
  // 动态建的对话框**得自己包一次头部** —— 页面加载时那一遍它还不存在（见 wireDialogHead）
  wireDialogHead(dlg.querySelector('form'));
  dlg.addEventListener('close', () => dlg.remove());
  $('npPick').onclick = () => pickProjectDir('npPick', 'npRoot');
  $('npOk').onclick = async (e) => {
    e.preventDefault();
    const name = $('npName').value.trim();
    const root = $('npRoot').value.trim();
    if (!name) return toast('给项目起个名字');
    if (!root) return toast('项目目录不能空 —— AI 要在这儿干活');
    try {
      const saved = await api('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, root, extraRoots: [] }),
      });
      dlg.close();
      // 存完回项目页并选中刚那个：附加根/干什么/宪法都在详情里补
      await openProjectsPage(saved?.project?.id);
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  dlg.showModal();
  setTimeout(() => $('npName').focus(), 50);
}
