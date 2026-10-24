/* projects.mjs —— 项目。
 * 2026-10-22 由 app.js（15537 行单文件）拆出，原生 ESM、无打包器；逻辑逐字搬运。 */
import { esc, mdRender, personLabel, runtimeLabel, savePlace, setRoute, toast } from './shell.mjs';
import { ICON_FOLDER, ICON_WB_BOARD, ICON_WB_CLOCK, api, createCombo, handleCopyPaths, personaAvatar, personaByName, renderMarkdown, smAvatar, wireDialogHead } from './ui.mjs';
import { setNav } from './state.mjs';
import { breadcrumb, headRow } from './connectors.mjs';
import { confirmDo } from './machine.mjs';
import { detailSave, showView } from './contacts.mjs';
import { wbCard } from './workflows.mjs';
import { hint, openFlowRun, paintRun, setListTitle } from './flowpages.mjs';
import { attsHtmlOf, firstMeaningfulLine, openConversation, openDetail, streamRun } from './chat.mjs';
import { $, S } from './core.mjs';



/* ---------------------------------------------------------------- 项目 */

/**
 * 工作台里的「自动化」——现在只有**定时任务**这一项。
 *
 * 为什么单开一组、不塞进「项目」：项目是"在哪儿干活"，定时任务是"到点谁去干活"，
 * 两类东西混在一格宫格里，人会以为定时任务是某个项目的附属品（它其实可以不关联项目）。
 * 以后再加触发器、监控之类的，也落这一组。
 */
export function workbenchAutoSection() {
  return `
    <div class="wb-sec">自动化</div>
    <div class="wb-grid">
      ${wbCard('cron', ICON_WB_CLOCK, '定时任务', '到点自动做一件事：干什么、交给谁、多久一次', 'data-schedules')}
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
  $('listBody').innerHTML =
    (S.projects.length
      ? S.projects
          .map(
            (p) => `<div class="item${p.id === S.projSel ? ' active' : ''}" data-proj-sel="${esc(p.id)}">
              <div class="who">
                <!-- 「内置」角标用通讯录同款 .b-inline 塞进 <b> 里 —— line1 是 space-between，
                     挂在外面会被推到行最右，看着像个时间戳（2026-10-20 收口）。 -->
                <div class="line1"><b>${esc(p.name)}${
                  p.builtIn ? '<i class="b-inline">内置</i>' : ''
                }</b></div>
                <div class="line2" title="AI 会在这个目录里干活">${esc(p.root)}</div>
              </div>
            </div>`,
          )
          .join('')
      : '<div class="empty" style="padding:36px 12px">还没有项目<br />点右上角 ＋ 新建一个</div>');
  // 左栏选谁，右边看谁（就地换详情，不整页跳）
  $('listBody').querySelectorAll('[data-proj-sel]').forEach((el) => {
    el.onclick = () => openProjectsPage(el.dataset.projSel).catch((e) => toast(e.message, 'error'));
  });

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
 * 右侧详情 = 照**员工详情页**的骨架改（2026-10-18 用户定的）：
 * 顶部 p-head 一行 = 项目概览信息（名字 + 目录 pill）+ 右侧动作按钮；
 * ⚠️ 2026-10-19 用户截图圈掉左侧那枚蓝色「班」字方块（`.avatar.proj`）：去掉，
 *    项目名本身就是页面标题，头像那个色块在这儿只是多一块颜色，没有"这是谁"的信息量
 *    （员工头像不一样——它是"人"，项目是"地方"）。
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
    <div class="p-head">
      <div class="p-head-main">
        <h2>${esc(p.name)}${p.builtIn ? '<span class="pill role">内置</span>' : ''}</h2>
        <div class="p-meta">
          <!-- 目录 pill 整颗可点：点一下复制路径（设计稿 v1.0.1）。
               data-label 记着原始路径 —— 回执把字换成「已复制」之后，2 秒还得能换回来。 -->
          <button type="button" class="pill copy-pill" data-path="${esc(p.root ?? '')}"
                  data-label="${esc(p.root ?? '')}" title="点击复制路径">${esc(p.root ?? '')}</button>
        </div>
      </div>
      <div class="hero-actions">
        <!-- 保存状态：改了就自动存，这里是唯一的回执（跟员工详情同一条 .save-state 样式）。
             原来这儿是一颗「保存」按钮 —— 四个字段都要点一次，忘了点就白改。
             ⚠️ 它**不占位**：宽度 0 + 往左溢出，所以"改成已保存"时不推按钮；
                 靠 text-align:right 让它从按钮左边往回长，永远不会被右边界截掉。
                 （样式在 style.css 的 .pj-save） -->
        <span class="save-state pj-save" id="pjSaveState"></span>
        <button class="primary" id="pjTasks">任务</button>
        ${p.builtIn ? '' : '<button class="danger" id="pjDel">删除</button>'}
      </div>
    </div>

    <!-- 任务统计挪到页头正下方（2026-10-24 用户：把任务标签提上去）—— 基础信息 tab 里不再放 -->
    ${err
      ? `<div class="dim" style="margin-top:14px">任务统计取不到：${esc(err)}</div>`
      : `<div class="kb-stats" style="margin-top:14px">
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
              <textarea id="projConstInput" hidden placeholder="只写本项目特有的（共通规矩契约已经管了）：&#10;例如：零依赖，不许引入 npm 包；端口固定 8787；改 store.mjs 的 SQL 必须先问人">${esc(p.constitution ?? '')}</textarea>
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
      /* 改名同步的是**详情区自己**（p-head 的 h2 / 目录 pill），不碰左栏标题 ——
         左栏面包屑只到「工作台 › 项目」二级，项目名不写在里面（见 openProjectsPage）。
         项目头像 2026-10-19 已按用户要求去掉（.avatar.proj 没有宿主了），这里不用再同步它。 */
      const paintName = (name) => {
        const h2 = box.querySelector('.p-head h2');
        if (h2) {
          h2.firstChild.nodeType === 3
            ? (h2.firstChild.nodeValue = name)
            : h2.insertBefore(document.createTextNode(name), h2.firstChild);
        }
        // 目录 pill 不只改字：data-path / data-label 也得跟着走，否则复制的是旧路径、还原也会还原成旧值
        const rootPill = box.querySelector('.p-meta .pill');
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
      err ? '' : kbFilterBar(data) + kbPrRefreshHtml(data)
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
}



/** 看板列 → 新建任务时的默认状态（点哪一列的「＋」就默认落在哪一列；拖列也用它换算） */
export const COL_STATUS = { idea: '想法', todo: '待办', doing: '进行中', review: '待验收', blocked: '已阻塞', failed: '失败', done: '已完成', cancelled: '已取消' };



/** 全局面板里那张「未归属」的名（服务端 `project-tasks.mjs` 里的 NO_PROJECT，两处同文） */
export const NO_PROJECT_LABEL = '（未归属）';



/* kb-filter:pure:start */
/**
 * 看板的**筛选**（2026-10-15 起是"状态"一维，形状参照用户给的 Linear 那张：头上一枚「筛选」+ 弹出的多选层；
 * 2026-10-18 加了"负责人"和"项目"两维，参照 Multica —— 看板一旦有过几十张卡，
 * "只看某人的"和"只看某个项目的"就是最常用的两个动作，比按状态筛还常用）。
 *
 * 下面这一段**不碰 DOM**（只读 `S.kbFilter`、只把传进来的数据算一遍，外加拼一段字符串），
 * 所以能单独抠出来在 node 里跑一遍 —— 见 `tmp/kb-filter-check.mjs`。
 *
 * 选项**从当前这批行现取**，不写死表：平台有两套状态词（流程六态 / 聊天四态），
 * 人和项目更是随数据长，写死了迟早漏。状态的顺序跟着看板从左到右的列走。
 *
 * 三个维度的语义（跟 Multica / Linear 一致，别自创）：
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



/** 三个维度各自勾了几个（角标上的数字；项目那一维只在全局面板算数） */
export function kbFilterCount(scope) {
  const f = S.kbFilter ?? {};
  const statuses = f.statuses?.length ?? 0;
  const assignees = f.assignees?.length ?? 0;
  const projects = scope === 'all' ? (f.projects?.length ?? 0) : 0;
  return statuses + assignees + projects;
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
  const cols = (data?.columns ?? []).map((c) => {
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
 * 三个维度 = 一级菜单的三行。顺序就是弹层里的顺序（状态最常用，排头）。
 * `field` 是它在 `S.kbFilter` 里对应的那个数组 —— 两处别各写各的。
 */
export const KB_DIMS = [
  { key: 'status', field: 'statuses', label: '状态' },
  { key: 'who', field: 'assignees', label: '负责人', search: true },
  { key: 'proj', field: 'projects', label: '项目', search: true },
];



/** 某一维的选项（二级菜单要铺的那些） */
export function kbDimOptions(data, key) {
  if (key === 'status') return kbFilterOptions(data);
  if (key === 'who') return kbAssigneeOptions(data);
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
 * 一级菜单的数据：三个维度各一行，带「勾了几项」和已选名字的摘要。
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
      // 名字最多摆两个，再多就「+N」：一行摆不下会折成两行，三个维度就不齐了
      summary: names.length > 2 ? `${names.slice(0, 2).join('、')} +${names.length - 2}` : names.join('、'),
    };
  });
}



/**
 * 看板的「筛选」那一块（按钮 + **两级**弹层）。两块看板共用。
 * 里面只有字符串拼接（不碰 DOM），所以也圈进这一段：能跟上面几条一起在 node 里验。
 *
 * 一级 = 维度（状态 / 负责人 / 项目），二级 = 那一维的选项多选。
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
    <button type="button" class="kbf-btn${n ? ' on' : ''}" id="kbFilterBtn" title="按状态 / 负责人 / 项目筛选">
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


/* kb-filter:pure:end */

/**
 * 看板列那一段（含"筛完什么都不剩"的兜底文案）。
 * 首屏渲染（两块看板）与 `kbRepaint()` 三条路**共用这一份** ——
 * 原来只有 kbRepaint 有兜底，筛到空时首屏会整块空白，同页点一下勾选框却是空的另一种样子。
 */
export function kbColsHtml(data) {
  const cols = kbFilterCols(data);
  if (cols.length) return cols.map(kbColumn).join('');
  // 「还没任务」和「筛没了」是两件事：说错了人会以为看板坏了
  return `<div class="kb-none">${kbFilterActive(data?.scope) ? '没有符合筛选的任务' : '还没有任务'}</div>`;
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
      const field = dim === 'status' ? 'statuses' : dim === 'who' ? 'assignees' : 'projects';
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
  // 「清除」= 三个维度一起清（分成三个清除按钮只会让人多点两下）
  $('kbFilterClear')?.addEventListener('click', (e) => {
    e.stopPropagation();
    S.kbFilter.statuses = [];
    S.kbFilter.assignees = [];
    S.kbFilter.projects = [];
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
  // 列头「＋」：在那一列新建任务（参照 Multica：建在哪一列就落在哪一列）
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
        // 拖进「进行中」＝开工（跟 Multica 一样：状态到位 + 有执行人就派活）。
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
        if (started) {
          const who = (S.personas ?? []).find((p) => p.id === res.task?.assigneePersonaId)?.name;
          hint(`已经派给${who ? `「${who}」` : '执行人'}开跑了 —— 进展在他那条会话里看`);
        } else if (toStatus === '进行中') {
          hint('卡移到「进行中」了；这张卡没有执行人，所以不会自动开跑');
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
 * 这张卡是从**哪场会话**点进来的（2026-10-24 卡票）：会话 id，否则 null。
 * 聊天气泡里的卡票点进来时记下 —— 离开卡页回那场会话，跟"从流程来回流程"同一个道理：
 * 人是在跟 PM 聊着天点过来的，回去落回看板等于把他从上下文里拽走了。
 */
export let taskCardFromConv = null;



/**
 * 这张卡是**从流程的某一步**点进来的吗（2026-10-19）：`{ runId, taskId, runTitle, nodeName }`，否则 null。
 *
 * 跟上面那个 `taskCardFromAll` 不是一回事，两个都留着：
 *   · `taskCardFromAll` 决定**离开时回哪**（看板 / 项目 / 流程）；
 *   · 这个只决定**页头写不写那行来路**。
 * 合在一起会逼着做二选一 —— 从流程进来的卡，回程本来就该是流程，不冲突。
 */
export let taskCardFromFlow = null;



export async function openTaskCardPage(taskId, opts = {}) {
  // 来源定死：恢复位置时从 route 里带回来（刷新也还记得），否则看当前的 S.boardAll
  taskCardFromAll = opts.fromAll ?? !!S.boardAll; // 必须在 S.boardAll = false 之前读
  // 从聊天气泡的卡票点进来的（2026-10-24）：记下那场会话，离开时回去
  taskCardFromConv = opts.fromConv ?? null;
  /*
   * 从流程那一步点进来的（2026-10-19）：记下"这条卡是哪条流程、哪个节点"。
   * 只为了在页头写一行来路 —— 人刚在流程页看着「写代码」这一步，点进来要还认得出是它。
   * 传 null 就是"不是从流程来的"（从看板点进来的），页头不写那行。
   * ⚠️ 路由里必须带上它：不带的话刷新一下页头那行就没了，看着像"进错页面"。
   */
  taskCardFromFlow = opts.fromFlow ?? null;
  setRoute('taskCard', { id: taskId, fromAll: taskCardFromAll, fromFlow: taskCardFromFlow, fromConv: taskCardFromConv });
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
  // 「删除」先放在这儿，建完头部再搬进去（头部是 wireDialogHead 现建的）
  dlg.innerHTML = `
    <div class="tc-dlg-wrap">
      <b>任务卡</b>
      <button type="button" class="tc-dlg-del" id="tcDlgDel" title="删掉这张卡（＝忽略它，以后不再提）">删除</button>
      <div id="tcDlgBody"></div>
    </div>`;
  document.body.append(dlg);
  wireDialogHead(dlg.querySelector('.tc-dlg-wrap'));
  const head = dlg.querySelector('.dlg-head');
  // 「删除」排到 × 左边（头部第一个 button 会被 CSS 推到右边，见 .dlg-head）
  head?.insertBefore($('tcDlgDel'), head.querySelector('.dlg-close:not(.dlg-max)') ?? null);
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
  const proj = (S.projects ?? []).find((p) => p.id === task.projectId) ?? null;
  const isRepo = task.source === 'repo';
  // 流程派生的卡（sourceKey = flow:<runId>:<nodeId>:<visit>，2026-10-19）：身份由流程那一行代表，
  // 删了没意义——看板流程行照旧、下次点流程那步的「任务」还会再建一张。删除键不给它。
  const isFlowCard = !!task.sourceKey;
  const assignee = S.personas.find((p) => p.id === task.assigneePersonaId) ?? null;

  // 往来：派过活才有会话
  let conv = null;
  if (task.conversationId) {
    try { conv = await api(`/api/conversations/${encodeURIComponent(task.conversationId)}`); } catch { conv = null; }
  }
  const runningRun = (conv?.runs ?? []).find((r) => r.status === '跑中') ?? null;
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

  // 我自己的评论不再重复写名字 —— 头像上那个「我」就是名字，写两遍是噪声（他的回话仍然带名字）
  const cmtItem = (m, isNew = false) => {
    const mine = m.role === 'user';
    return `<div class="tc-cmt${mine ? ' mine' : ''}${isNew ? ' is-new' : ''}">
      ${mine ? smAvatar('我', 'me') : smAvatar(whoName, '', personaByName(whoName))}
      <div class="tc-cmt-main">
        <div class="tc-cmt-meta">${mine ? '' : `<b>${esc(whoName)}</b>`}<time>${esc(cmtTime(m.createdAt))}</time></div>
        <div class="tc-cmt-text">${renderMarkdown(m.text)}${attsHtmlOf(m.atts)}</div>
      </div>
    </div>`;
  };

  const topicsOf = (msgs) => {
    const topics = [];
    const byId = new Map();
    let cur = null;
    for (const m of msgs) {
      if (m.role === 'user' && !m.parentId) {
        cur = { id: m.id, head: m, items: [] };
        topics.push(cur);
        byId.set(m.id, cur);
      } else if (m.parentId && byId.has(m.parentId)) {
        // 我的回复、他的回话都认 parentId（他的回话现在也带着议题 id，见 runs.mjs）
        cur = byId.get(m.parentId);
        cur.items.push(m);
      } else {
        if (!cur) {
          cur = { id: 'pre-' + m.id, head: null, items: [] };
          topics.push(cur);
        }
        cur.items.push(m);
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

  // 折叠条上露的那一眼：最新回复去 markdown 记号、压成一行（B站/微博的"共 N 条回复"带预览的套路）
  const replySnippet = (m) =>
    String(m.text ?? '').replace(/[#*`>~[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60)
      || (m.atts?.length ? '（附件）' : '…');

  const threadsHtml = (d) => {
    const msgs = d?.messages ?? [];
    if (!msgs.length) {
      return `<div class="nc-empty">还没有评论。</div>`;
    }
    const topics = topicsOf(msgs);
    // 首屏先把库里已有的都记"见过"：高亮只给**这一页打开之后**新到的回话，
    // 不然每次进卡满屏蓝，跟没折一样。
    if (seenReplies.size === 0) {
      for (const t of topics) for (const m of t.items) seenReplies.add(m.id);
    }
    const html = topics
      .map((t) => {
        const startNote = t.head && isStartNote(t.head);
        const head = !t.head
          ? ''
          : startNote
            ? `<details class="tc-event"><summary>开工说明 · ${esc(cmtTime(t.head.createdAt))}</summary>
                 <div class="tc-cmt-text">${renderMarkdown(t.head.text)}${attsHtmlOf(t.head.atts)}</div>
               </details>`
            : `<div class="tc-topic-title">${renderMarkdown(t.head.text)}${attsHtmlOf(t.head.atts)}</div>`;
        // 「开工说明」不是人写的评论：不出头像、不出作者行，只留一条可展开的流水
        // 「只留言」的便签给一枚小标记：不然它和普通评论长得一模一样，看不出这条没叫醒他
        const noteTag = t.head?.note
          ? '<span class="tc-tag" title="便签：只给你看，没叫醒他">便签</span>'
          : '';
        const meta = t.head && !startNote
          ? `<div class="tc-topic-meta">
               ${t.head.role === 'user' ? '' : `<b>${esc(whoName)}</b>`}
               ${noteTag}
               <time>${esc(cmtTime(t.head.createdAt))}</time>
               <button type="button" class="tc-reply" data-reply="${esc(t.head.id)}">回复</button>
             </div>`
          : '';
        // 折叠照旧（全铺开确实杂），但他的回话不再被藏住：
        //   1. 折叠条露最新一条回复的作者+摘要，收着也能扫到他说了什么；
        //   2. 这轮新到的回复让议题自动展开、回复本身高亮 ——
        //      除非用户手动收起过这条（collapsedTopics），手动操作优先。
        const hasNew = t.items.some((m) => !seenReplies.has(m.id));
        const isOpen = openTopics.has(t.id) || (hasNew && !collapsedTopics.has(t.id));
        let replies = `<div class="tc-replies" data-replies="${esc(t.id)}"></div>`;
        if (t.items.length) {
          const last = t.items[t.items.length - 1];
          const author = last.role === 'user' ? '我' : whoName;
          const items = t.items.map((m) => cmtItem(m, !seenReplies.has(m.id))).join('');
          replies = `<details class="tc-replies" data-replies="${esc(t.id)}"${isOpen ? ' open' : ''}>
               <summary class="tc-replies-toggle">
                 <span class="tc-replies-fold">${t.items.length} 条回复 · <i>${esc(author)}</i>：${esc(replySnippet(last))}</span>
                 <span class="tc-replies-unfold">收起回复</span>
               </summary>
               <div class="tc-replies-body">${items}</div>
             </details>`;
        }
        // 作者行在**正文上面**（跟普通评论一致）：头像旁边第一行就是"我 + 时间"，
        // 再往下才是内容 —— 反过来会让人以为下面又开了一条评论（2026-10-18 用户指出）
        return `<article class="tc-topic${t.head ? '' : ' pre'}" data-topic="${esc(t.id)}">
          ${t.head && !startNote ? (t.head.role === 'user' ? smAvatar('我', 'me') : smAvatar(whoName, '', personaByName(whoName))) : ''}
          <div class="tc-topic-body">
            ${meta}${head}
            ${replies}
          </div>
        </article>`;
      })
      .join('');
    // 画完统一记"见过"：下次重画时不在 seenReplies 里的才是新到的
    for (const t of topics) for (const m of t.items) seenReplies.add(m.id);
    return html;
  };

  // 折叠开关：点击 summary 后 details.open 已被浏览器切换，这里同步记下"用户展开/收起过哪些议题"，
  // 供下一次重画还原（收起过的不再被自动展开抢回去）。用 click 委托（details 的 toggle 事件不冒泡，得靠 click）。
  $('tcThreads')?.addEventListener('click', (e) => {
    const d = e.target.closest?.('details.tc-replies');
    if (!d) return;
    const id = d.dataset.replies;
    if (d.open) { openTopics.add(id); collapsedTopics.delete(id); }
    else { openTopics.delete(id); collapsedTopics.add(id); }
  });

  /**
   * 页面形态照 Multica 的任务详情（2026-10-18 用户要求"简洁一些"）：
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
  const delBtn = isFlowCard ? '' : '<button class="tc-del" id="tcDel" title="删掉这张卡（＝忽略它）">删除</button>';
  host.innerHTML = `
    ${dlg ? '' : headRow(
      taskCardFromAll || !proj
        ? breadcrumb([{ label: '工作台', to: 'workbench' }, { label: '任务看板', to: 'board' }, { label: '任务卡' }])
        : breadcrumb([
            { label: '工作台', to: 'workbench' },
            { label: '项目', to: 'projects' },
            { label: proj.name, to: 'projects', arg: proj.id },
            { label: '任务卡' },
          ]),
      delBtn,
    )}
    <div class="detail-body tc-page${dlg ? ' in-dlg' : ''}">
      <div class="tc-main">
        <div class="tc-main-scroll">
          <div class="tc-headblock">
            ${fromFlowBar}
            <h1 class="tc-title" id="tcTitleText" contenteditable="plaintext-only" spellcheck="false">${esc(task.title)}</h1>
            <div class="tc-desc${task.description ? '' : ' empty'}" id="tcDescView">${task.description ? renderMarkdown(task.description) : '<span class="dim">添加描述…</span>'}</div>
          </div>

          <section class="group tc-comments">
            <div class="group-title">讨论</div>
            <div class="tc-threads" id="tcThreads">${threadsHtml(conv)}</div>
          </section>
        </div>

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
          <div class="tc-composer-foot">
            <button type="button" class="tc-stop" id="tcStop" hidden
                    title="掐掉这一轮（他已经说出来的话会留着；会话和上下文都还在，随时可以接着说）">■ 停止生成</button>
            <div class="counter left" id="tcHint2"></div>
          </div>
        </div>
        <!-- 输入框停靠到议题下面期间，底部这颗幽灵按钮就是"开新话题"的回路（2026-10-24） -->
        <button type="button" class="tc-new-topic" id="tcNewTopic" hidden
                title="不回复谁，开一条新议题（输入框回到底部）">＋ 新议题</button>
      </div>

      <aside class="tc-side">
        <h3>属性</h3>
        <div class="tc-prop"><span class="tc-prop-k">状态</span><div id="tcStatusMount"></div></div>
        <div class="tc-prop"><span class="tc-prop-k">执行人</span><div id="tcWhoMount"></div></div>
        <div class="tc-prop"><span class="tc-prop-k">项目</span><span class="tc-prop-v">${esc(proj?.name ?? '（项目已不在）')}</span></div>
        <div class="tc-prop"><span class="tc-prop-k">来源</span><span class="tc-prop-v">${isFlowCard ? '流程' : isRepo ? '仓库值班' : '手动建卡'}</span></div>

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
                 <button id="tcPrUnlink">取消关联</button>
               </div>`
            : `<div class="tc-pr-add">
                 <input id="tcPrUrl" placeholder="PR 链接 或 owner/name#123" />
                 <button class="primary" id="tcPrLink">关联</button>
               </div>
               <div class="counter left">合并后这张卡会转到「待验收」——不自动「已完成」，等你点头。</div>`
        }

        <h3>详情</h3>
        ${task.createdBy ? `<div class="tc-prop"><span class="tc-prop-k">创建人</span><span class="tc-prop-v">${esc(pjPersona(task.createdBy)?.name ?? '那个人已经不在了')}（员工建卡）</span></div>` : ''}
        <div class="tc-prop"><span class="tc-prop-k">创建时间</span><span class="tc-prop-v">${esc(String(task.createdAt ?? '').replace('T', ' ').slice(0, 16))}</span></div>
        <div class="tc-prop"><span class="tc-prop-k">更新时间</span><span class="tc-prop-v" id="tcAt">${esc(String(task.updatedAt ?? '').replace('T', ' ').slice(0, 16))}</span></div>
      </aside>
    </div>`;

  /*
   * 从哪来回哪去：**从流程那一步进来的就回那条流程**（2026-10-19）。
   * 这是这轮改造的重点之一 —— 人是在流程时间轴上点「任务」过来的，
   * 删完卡 / 干完事却落回看板，等于把他从上下文里拽走了，还得自己找回去。
   * 其余照旧：全局看板 → 全局看板，项目看板 → 那个项目。
   */
  const backTo = dlg
    ? () => { dlg.close('done'); } // 弹窗这条路：**关掉就是回去**（流程页一直在底下，没走过）
    : taskCardFromFlow?.runId
      ? () => openFlowRun(taskCardFromFlow.templateId ?? null, taskCardFromFlow.runId)
      : taskCardFromConv
        ? () => openConversation(taskCardFromConv) // 从聊天气泡的卡票进来的：回那场会话
        : taskCardFromAll
          ? () => openTaskBoard()
          : proj ? () => openProjectDetail(proj.id) : () => openProjectsPage();
  // 离开这张卡就把位置记忆清掉：否则下一次刷新又会被拽回这张卡
  const leaveTo = async () => { await backTo(); };
  // （页头不再有返回按钮；backTo 只剩 leaveTo 和下面那行「来自流程」在用）

  // 「来自流程」那行：点一下回那条流程的时间轴（跟删完卡之后回的是同一个地方）
  $('tcFromFlow')?.addEventListener('click', () => { backTo().catch((e) => toast(e.message, 'error')); });

  /* ---------------- 标题 / 描述：就地编辑（2026-10-18 用户要求：没有编辑按钮，点了就改，改完自动存）
     做法跟 Multica 一致：标题、描述平时就是"读"的样子，点上去原地变成输入框；
     敲字防抖自动存，失焦立刻存；Enter 提交，Escape 放弃本次改动。 ---------------- */
  let titleVal = task.title;
  let descVal = task.description || '';

  /* 标题：h1 本身就可写（contenteditable）。**不换元素、不加边框** ——
     换 input 会改字号/行高/盒模型，页面会抖一下（2026-10-18 用户实报）。 */
  const titleEl = $('tcTitleText');
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
    hint2.textContent = whoCombo.value() ? '' : '先在右边选执行人，再发送。';
  };

  const statusCombo = createCombo({
    mount: $('tcStatusMount'),
    items: ['想法', '待办', '进行中', '待验收', '已阻塞', '失败', '已完成', '已取消'].map((s) => ({ id: s, label: s })),
    value: task.status,
    onChange: () => scheduleSave(0), // 改状态立刻存：待办+人 = 开工（服务端负责）
  });
  const whoCombo = createCombo({
    mount: $('tcWhoMount'),
    items: [{ id: '', label: '（不指定）' }, ...(S.personas ?? []).map((p) => ({ id: p.id, label: personLabel(p) }))],
    value: task.assigneePersonaId || '',
    search: true,
    placeholder: '搜名字或岗位…',
    empty: '没有匹配的人',
    onChange: (id) => {
      // 选人**立刻**反映到评论区与页头（原来要点了「保存」重画才生效，看着就像"输入框点不动"）
      const p = (S.personas ?? []).find((x) => x.id === id) ?? null;
      if (p) whoName = p.name;
      const whoText = $('tcWhoText');
      if (whoText) whoText.textContent = p?.name ?? '（没派活）';
      syncComposer();
      scheduleSave(0); // 指定人立刻存：卡在「待办」时这一下就会自动开工
    },
  });
  syncComposer();

  const snapshot = () => ({
    title: titleVal,
    description: descVal,
    status: statusCombo.value(),
    personaId: whoCombo.value(),
  });
  let lastSaved = JSON.stringify(snapshot());
  let saving = false;

  /** 存完只更新页头/描述，不重画整页（免得丢正在写的评论）。
   *  状态/执行人的实时展示在右栏 combo 上（页头不再摆 pill，照 Multica 收进属性栏）。 */
  const refreshHeader = () => {
    if (document.activeElement !== titleEl) {
      titleVal = task.title;
      titleEl.textContent = task.title;
    }
    const p = (S.personas ?? []).find((x) => x.id === task.assigneePersonaId) ?? null;
    if (p) whoName = p.name;
    statusCombo?.setValue(task.status);
    whoCombo?.setValue(task.assigneePersonaId || '');
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
    if (!payload.title.trim()) { setSaveState('标题不能空 · 未保存', 'bad'); return false; }
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
        toast('已自动开工：派给他跑这一条去了');
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

  // 弹窗那条路的「删除」在弹窗自己头上（静态的 #tcDlgDel），整页那条路在页头；
  // 流程派生的卡不摆删除（身份由流程行代表，删了没意义 —— 2026-10-23 用户拍板）
  const delEl = dlg ? $('tcDlgDel') : $('tcDel');
  if (delEl && isFlowCard) delEl.remove();
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
  const prStateText = (state) => (state === 'merged' ? '已合并' : state === 'closed' ? '已关闭' : state === 'open' ? '开着' : '未知');

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

  /* ---------------- 评论区：发评论 / 回复 / 实时流 ---------------- */

  let convId = task.conversationId ?? null;
  let stream = null;
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
   * 默认「讨论」：用户的痛点是"需求没聊清就动手"，先聊才符合直觉。
   */
  let sendMode = 'discuss';
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
  // 输入框提示语：选了回复目标就说"回复这个议题…"，否则按三档说
  const placeholderText = () => (!replyTo ? placeholderFor(sendMode)
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
    if (input) input.placeholder = placeholderText();
    const menu = $('tcModeMenu');
    if (menu) {
      menu.querySelectorAll('[data-pick]').forEach((b) => {
        b.classList.toggle('on', b.dataset.pick === sendMode);
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
    threads?.querySelectorAll('.tc-topic.is-replying').forEach((el) => el.classList.remove('is-replying'));
    topicEl.classList.add('is-replying');
    topicEl.scrollIntoView({ block: 'nearest' }); // 已在视野内就不动
  };
  const syncReplyDock = () => { replyTo ? dockComposer() : homeComposer(); };

  const scrollThreads = () => {
    const box = $('tcThreads');
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

  const refreshThread = async () => {
    if (!convId) return;
    try {
      const d = await api(`/api/conversations/${encodeURIComponent(convId)}`);
      conv = d;
      const box = $('tcThreads');
      if (!box) return;
      // 输入框若停靠在议题里，先搬回底部 —— 不然下面的 innerHTML 重建会把它连草稿一起销毁
      homeComposer();
      box.innerHTML = threadsHtml(d);
      wireReplyButtons();
      syncReplyDock(); // 再停靠回去（回复横幅、议题高亮一起补上）
    } catch { /* 拉不到就保持原样，别把页面弄炸 */ }
  };

  /**
   * 这一轮运行（停止按钮要用它的 id —— 光知道"忙不忙"是停不掉的，跟主聊天页的 chatRunningId 一个道理）。
   *
   * ⚠️ 是"停止"，不是"暂停"：底层 runtime 都是一次性子进程，没有暂停/续跑这回事。
   *    停掉的是**这一轮**，不是这个人 —— 会话、上下文、卡片都还在，再说一句就能接着办。
   */
  let liveRunId = null;
  const syncStop = () => {
    const btn = $('tcStop');
    if (btn) btn.hidden = !liveRunId;
    const hint = $('tcHint2');
    // 跑着才说"随时可以掐掉"；跑完必须收回 —— 不然这句话一直挂着，人以为还在跑（2026-10-24 用户实感）
    if (hint) hint.textContent = liveRunId ? '随时可以掐掉这一轮 —— 说过的话留着。' : '';
  };
  const abortRun = async () => {
    const rid = liveRunId;
    if (!rid) return;
    // 先让界面立刻停下（点完就见效，不等后端回调）—— 跟主聊天页 stopChatRun 一个做法
    liveRunId = null;
    syncStop();
    if ($('tcHint2')) $('tcHint2').textContent = '已停下（他说过的话留着）。';
    stream?.close?.();
    stream = null;
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
  if ($('tcStop')) $('tcStop').onclick = abortRun;

  /**
   * 接实时流：**一个气泡里追加分块**（跟主聊天页 `attachStream` 一个写法），
   * 收尾后从库里重画 —— 流式气泡是临时的，库里那份才是完整的。
   * 落点：正在回复的那个议题的回复区里；不知道是哪个议题（比如改状态开的工、或刷新后接上）就落在
   * **最后一条议题**下面 —— 绝不能落到列表末尾，那样看着像他另开了一条新评论（2026-10-18 用户指出）。
   */
  const attach = (runId, topicId = replyTo) => {
    if (!runId || stream) return;
    liveRunId = runId; // 有这一轮在跑 → 露出「停止生成」
    syncStop();
    const id = 'tcLive-' + runId;
    let host = topicId
      ? $('tcThreads')?.querySelector(`[data-replies="${CSS.escape(topicId)}"]`) ?? null
      : null;
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
        <div class="tc-cmt-text"><div class="typing"><i></i><i></i><i></i></div></div></div></div>`,
    );
    scrollThreads();
    const body = document.querySelector('#' + id + ' .tc-cmt-text');
    const add = (cls, text, asHtml = false) => {
      body?.querySelector('.typing')?.remove();
      const d = document.createElement('div');
      d.className = 'step ' + cls;
      if (asHtml) d.innerHTML = text; else d.textContent = text;
      body?.appendChild(d);
      scrollThreads();
    };
    stream = streamRun(runId, {
      onText: (chunk) => add('text', renderMarkdown(chunk), true),
      onRunError: (msg) => add('bad', '· ' + firstMeaningfulLine(msg)),
      onDone: () => {
        stream?.close?.();
        stream = null;
        liveRunId = null; // 这一轮结束了 → 收起「停止生成」
        syncStop();
        refreshThread();
        // 跑完卡片状态会收成「待验收」—— 页头那颗 pill 跟着刷一下（不重画整页，评论草稿不丢）
        api(`/api/projects/tasks/${encodeURIComponent(taskId)}`)
          .then((d) => { if (d?.task) { task = d.task; refreshHeader(); } })
          .catch(() => { /* 取不到就等下次刷新 */ });
      },
      onReconnect: () => refreshThread(),
    });
    // 弹窗那条路：记到模块级，openTaskCardDialog 关弹窗时掐掉
    // （不掐的话它还在后台收消息，往一个已经从文档里摘掉的 DOM 里写）
    if (dlg) tcDlgStream = stream;
  };
  if (runningRun) attach(runningRun.id, null); // 打开时正好在跑 → 接上，不等刷新

  const sendText = async () => {
    const text = $('tcInput').value.trim();
    if (!text && !pendingAtts.length) return;
    if (attSending) return;
    if (!whoCombo.value()) { toast('先在右边选一个执行人 —— 评论区是跟他讨论的'); return; }
    const mode = sendMode; // note | discuss | execute
    const parentId = replyTo;
    $('tcInput').disabled = true;
    $('tcSend').disabled = true;
    try {
      // 刚在右边选的人可能还没点「保存」：先落库，否则服务端会说"先指定执行人"。
      if (task.assigneePersonaId !== whoCombo.value()) {
        const saved = await api(`/api/projects/tasks/${encodeURIComponent(taskId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ personaId: whoCombo.value() }),
        });
        task.assigneePersonaId = saved?.task?.assigneePersonaId ?? whoCombo.value();
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
      // 新开的议题：他这次的回复要落进**我刚发的那条**下面（服务端也是这么挂 parentId 的），
      // 所以气泡的落点用新评论的 id，而不是 null
      if (r.runId) attach(r.runId, parentId ?? r.message?.id ?? null);
      else if ($('tcHint2')) {
        $('tcHint2').textContent = '已记下 —— 便签只给你看，没叫醒他。';
      }
    } catch (e) {
      // 400/409 的原因要原样说出来（比如"他还在跑上一条"）
      toast(`没发出去：${e.message}`);
    } finally {
      $('tcInput').disabled = false;
      $('tcSend').disabled = false;
      // 便签是刻意选的：发完回到默认「讨论」（下一次多半是要跟他聊）
      if (mode === 'note') { sendMode = 'discuss'; paintMode(); }
      $('tcInput').focus();
    }
  };
  $('tcSend').onclick = sendText;

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
  return `<section class="kb-col ${esc(col.key)}" data-kb-col="${esc(col.key)}">
    <header class="kb-col-head">
      <span class="kb-dot"></span><b>${esc(col.label)}</b>
      <span class="kb-count">${col.count}</span>
      ${col.hint ? `<span class="kb-hint">${esc(col.hint)}</span>` : ''}
      <button class="kb-add" type="button" data-kb-add="${esc(col.key)}" title="在这一列新建任务">＋</button>
    </header>
    <div class="kb-cards">
      ${col.cards.length ? col.cards.map(kbCard).join('') : '<div class="kb-empty">无任务</div>'}
    </div>
  </section>`;
}



/**
 * 一张任务卡：来源标出来、执行人写清楚。
 *   · 流程卡 → 那条实例；聊天卡 → 那个会话；手工卡 → 那个会话（没派活就没地方可去）
 *   · **手工卡可以拖到别的列**（改状态）—— 看板上最自然的手势，跟 Multica 一致
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
  const local = r.source === 'manual' || r.source === 'repo';
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
  const proj = r.project_name
    ? `<span class="kb-tag proj" title="属于哪个项目">${esc(r.project_name)}</span>`
    : '';
  const srcCls = r.source === 'chat' ? ' chat' : r.source === 'repo' ? ' repo' : local ? ' manual' : '';
  return `<article class="kb-card ${local ? 'manual' : ''}" ${jump} ${drag}${local ? ` data-kb-open="${esc(r.manual_id)}" tabindex="0"` : ''} data-col="${esc(r.col)}" title="${esc(r.note || '')}">
    <div class="kb-card-top">
      ${proj}<span class="kb-tag${srcCls}">${esc(r.source_text)}</span>${prPillOf(r)}
      <span class="kb-state">${esc(r.status)}</span>
      ${del}
    </div>
    <div class="kb-card-title">${esc(r.task)}</div>
    <div class="kb-card-foot"><span class="kb-who">${esc(r.assignee)}</span><span>${esc(r.at)}</span></div>
  </article>`;
}



/**
 * 新建手工任务的弹窗（参照 Multica 的「＋」那个框）。
 *
 * 只有标题是必填。选了执行人就能勾「创建后立即开始工作」——那会**真的派活**
 * （发到他的 1:1 会话，工作目录是这个项目），所以框里明写出来，别让人意外。
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
  const pick = !project
    ? `<label>项目（这张卡挂在哪个项目下）</label><div id="tkProjMount"></div>`
    : '';
  dlg.innerHTML = `
    <form method="dialog">
      <b>新建任务</b>
      ${pick}
      <label>标题</label>
      <input id="tkTitle" placeholder="一句话说清要做什么" />
      <label>描述（可留空）</label>
      <textarea id="tkDesc" rows="3" placeholder="边界、验收标准、参照哪个文件…"></textarea>
      <div class="grid2">
        <div>
          <label>放到哪一列</label>
          <div id="tkStatusMount"></div>
        </div>
        <div>
          <label>执行人（可留空 = 先挂着）</label>
          <div id="tkWhoMount"></div>
        </div>
      </div>
      <label class="kb-check"><input type="checkbox" id="tkStart" checked /> 创建后立即开始工作（派到他的会话，工作目录就是这个项目）</label>
      <div class="dim" id="tkFilterHint" style="font-size:12px;margin-top:8px" hidden></div>
      ${project ? `<div class="kb-proj-hint">项目：${esc(project.name)} · ${esc(project.root)}</div>` : ''}
      <div class="dlg-actions">
        <button type="button" value="cancel">取消</button>
        <button class="primary" id="tkOk" value="ok">创建任务</button>
      </div>
    </form>`;
  document.body.append(dlg);
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
        // 换项目 = 可能换成"筛选之外的项目"，那句提醒要跟着重算
        onChange: () => syncFilterHint(),
      });
  const whoCombo = createCombo({
    mount: $('tkWhoMount'),
    items: [{ id: '', label: '不派活' }, ...(S.personas ?? []).map((p) => ({ id: p.id, label: personLabel(p) }))],
    value: '',
    search: true,
    placeholder: '搜数字员工…',
    empty: '没有匹配的人',
    // 这个箭头只在**点选时**才跑，那时下面的 syncStart / syncFilterHint 早就定义好了 —— 顺序是有意的
    onChange: () => {
      syncStart();
      syncFilterHint(); // 选了个人 → 可能这个人不在当前筛选里，提醒要跟着变
    },
  });

  /*
   * 「立即开始」什么时候不该给勾：
   *   · 没选执行人 —— 勾了也没人可派
   *   · 状态是「想法」—— 那是"还没决定要不要做"，谈不上开始；勾了的话卡刚建完就
   *     被转到「进行中」，那一列等于白建（服务端也拦了这一条，见 project-tasks.mjs）
   * 这里是让人**别以为勾了个空**：不可用时灰掉、取消勾选、并说明原因。
   */
  const syncStart = () => {
    const has = !!whoCombo.value();
    const idea = statusCombo.value() === '想法';
    const on = has && !idea;
    const box = $('tkStart').closest('.kb-check');
    $('tkStart').disabled = !on;
    if (!on) $('tkStart').checked = false;
    box.style.opacity = on ? '1' : '.5';
    box.title = idea ? '「想法」是还没决定要不要做，先不派活' : has ? '' : '先选一个执行人';
  };
  syncStart();
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
    // 拿一张"将要建出来的卡"去试：状态是选的那个，人是选的那个人，项目是这一页定的那个
    const why = kbWhyHidden(
      { status: st, assignee_id: whoCombo.value() || '', project_id: project?.id ?? projCombo?.value() ?? '' },
      S.boardAll ? 'all' : undefined,
    );
    el.hidden = !why;
    el.textContent = !why
      ? ''
      : why === 'status'
        ? `注意：当前筛选不含「${st}」，建完这张卡会留在看板外面（点「清除」能看到）。`
        : why === 'who'
          ? '注意：当前筛选只看别人 —— 这张卡派给他之后会留在看板外面（点「清除」能看到）。'
          : '注意：当前筛选只看别的项目 —— 这张卡建完会留在看板外面（点「清除」能看到）。';
  };
  // 状态变了这两件事都要跟着算 —— 挂在 statusCombo 的 onChange 上（见上面创建处）
  syncFilterHint();
  $('tkOk').onclick = async (e) => {
    e.preventDefault();
    const title = $('tkTitle').value.trim();
    if (!title) return toast('任务得有标题');
    const chosen = project ?? projects.find((x) => x.id === projCombo?.value());
    if (!chosen) return toast('先建一个项目，任务才有地方挂');
    try {
      await api(`/api/projects/${encodeURIComponent(chosen.id)}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          description: $('tkDesc').value.trim(),
          status: statusCombo.value(),
          personaId: whoCombo.value() || null,
          startNow: !!whoCombo.value() && $('tkStart').checked,
        }),
      });
      dlg.close();
      // 在哪儿建的就在哪儿重画：全局面板回全局面板（刚建的卡会带项目标签出现在那一列）
      await (S.boardAll ? openTaskBoard() : openProjectDetail(chosen.id));
    } catch (err) {
      toast(err.message, 'error');
    }
  };
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
