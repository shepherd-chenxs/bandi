/* contacts.mjs —— 二级列表、通讯录：按部门分组、新建选择器、视图切换。
 * 2026-10-22 由 app.js（15537 行单文件）拆出，原生 ESM、无打包器；逻辑逐字搬运。
 * 2026-10-25 起「数字员工」从 A–Z 字母头改为按部门分组（用户口径：部门是给人看的分组）。
 *
 * 2026-10-31 手机端通讯录改成主流手机通讯录形态（用户："通讯录不是手机的风格，改成
 * 手机那种 ABC 的"）：上方一组入口（群聊 / 部门，点进去是各自的列表），下方全部员工
 * 按拼音首字母 A–Z 分组 + 右侧索引条。**只走窄屏**，桌面仍是部门分组。
 * A–Z 的首字母判定沿用 2026-10-20 那版的边界字方案（见 nameInitial 注释）。 */
import { esc, personSubtitle, saveCollapsed, toast } from './shell.mjs';
import { ICON_CLOUD, ICON_FOLDER, cut, hhmm, initial, personaAvatar, plain } from './ui.mjs';
import { openSettings, settingsGroups } from './settings.mjs';
import { archivedEntryHTML, closeCtxMenu, convDisplayName, enterArchiveView, openConversationSafe, renderArchiveList } from './listmenu.mjs';
import { renderFlowList } from './workflows.mjs';
import { renderRunList } from './flowpages.mjs';
import { newSkill, openGitPickDialog, openImportDialog } from './skills.mjs';
import { openConversation, openDetail, openDirectChat } from './chat.mjs';
import { gidOf, openGroupDetail } from './groups.mjs';
import { $, S } from './core.mjs';
import { openProjectsPage, renderProjectList } from './projects.mjs';
import { openGroupDialog, openPersonaDialog } from './misc.mjs';



/* -------------------------------------------------------------- 二级列表 */

/* ---------------------------------------------------- 通讯录：按部门分组 */

/**
 * 中文排序器：拼音序（`zh-Hans-u-co-pinyin`），只依赖浏览器 ICU，不写死"姓氏表"。
 * 2026-10-25 起通讯录「数字员工」**按部门分组**（用户拍板：「部门是给人看的，
 * 把人按部门分组」），替代原 A–Z 字母头 —— 组间按部门名拼音排，组内按人名拼音排，
 * 都走这一个排序器。
 */
export let pinyinCollator = null;


export const zhNameCollator = () => {
  if (!pinyinCollator) {
    try {
      pinyinCollator = new Intl.Collator('zh-Hans-u-co-pinyin');
    } catch {
      // 理论上不会（Chromium/WebView2 都带 ICU）；真不支持就退回中文默认排序，顺序差点但不断页
      pinyinCollator = new Intl.Collator('zh-Hans');
    }
  }
  return pinyinCollator;
};



/**
 * 通讯录「数字员工」按部门分组：[{ dept, rows }]。
 *
 * 部门是 `personas.department` 上的**自由文本**（2026-10-25，跟岗位同待遇 —— 可空、
 * 只用于看人）：有部门的按部门名分组（组间按拼音排），没部门的落「未分配」殿后；
 * 组内按人名拼音排。
 */
export function groupPeopleByDepartment(people) {
  const col = zhNameCollator();
  const UNASSIGNED = '未分配';
  const byDept = new Map();
  for (const p of people) {
    const dept = String(p.department ?? '').trim() || UNASSIGNED;
    if (!byDept.has(dept)) byDept.set(dept, []);
    byDept.get(dept).push(p);
  }
  const groups = [...byDept.entries()].map(([dept, rows]) => ({
    dept,
    unassigned: dept === UNASSIGNED,
    rows: rows.sort((a, b) => col.compare(a.name ?? '', b.name ?? '')),
  }));
  groups.sort((a, b) => (a.unassigned !== b.unassigned ? (a.unassigned ? 1 : -1) : col.compare(a.dept, b.dept)));
  return groups;
}



/* ---------------------------------------------------- 通讯录（手机）：A–Z 分组 */

/**
 * 名字首字母（手机通讯录 ABC 索引用）。
 *
 * 中文不能"取首字" —— 要转拼音首字母，而项目零依赖、不引 pinyin 库。
 * 这里沿用 2026-10-20 那版的边界字方案：给每个字母一个「该字母拼音区最小的字」当界碑，
 * 名字首字落在最后一个 ≤ 它的界碑之后，就属于那个字母 —— 只依赖浏览器 ICU，
 * 不写死姓氏表，生僻姓也能分（只要 ICU 认识这个字）。
 *
 * ⚠️ 界碑必须是**汉字**，不能拿拉丁字母当锚点（`col.compare('张','z')` 会走
 *    script 重排层级，汉字整体排在拉丁之后，A–Z 全落到 '#' —— 实测过）。
 * ⚠️ i / u / v 没有汉语拼音音节，跳过。
 */
const PINYIN_BOUNDS = [
  ['A', '阿'], ['B', '八'], ['C', '擦'], ['D', '搭'], ['E', '蛾'], ['F', '发'],
  ['G', '噶'], ['H', '哈'], ['J', '击'], ['K', '喀'], ['L', '拉'], ['M', '妈'],
  ['N', '拿'], ['O', '哦'], ['P', '啪'], ['Q', '七'], ['R', '燃'], ['S', '撒'],
  ['T', '塌'], ['W', '挖'], ['X', '夕'], ['Y', '压'], ['Z', '匝'],
];

/**
 * 姓氏多音字修正表：ICU 取的是**常用读音**，姓氏用的是另一读。
 * 实测（364 个百家姓样本）只有这几个会判错；表里其余是同类但样本没覆盖到的。
 * 只对"名字第一个字"生效。
 */
const SURNAME_FIX = {
  曾: 'Z', 解: 'X', 单: 'S', 仇: 'Q', 翟: 'Z', 查: 'Z', 区: 'O', 覃: 'Q',
  祭: 'Z', 繁: 'P', 种: 'C', 折: 'S', 乐: 'Y', 长: 'C', 重: 'C', 会: 'K',
  秘: 'B', 么: 'Y', 句: 'G', 员: 'Y', 黑: 'H',
};

const HAN_RE = /^[\u3400-\u9fff\uf900-\ufaff]/;

/** 名字 → 分组字母（A–Z / '#'）。'#' 收数字、符号、认不出的字，排最后。 */
export function nameInitial(name) {
  const first = String(name ?? '').trim().charAt(0);
  if (!first) return '#';
  if (/[A-Za-z]/.test(first)) return first.toUpperCase();
  if (!HAN_RE.test(first)) return '#';
  if (SURNAME_FIX[first]) return SURNAME_FIX[first];
  const col = zhNameCollator();
  let letter = '#';
  for (const [L, bound] of PINYIN_BOUNDS) {
    if (col.compare(first, bound) >= 0) letter = L;
    else break;
  }
  return letter;
}

/** 通讯录「数字员工」按首字母分组：[{ letter, rows }]，字母序 + '#' 殿后，组内按拼音排。 */
export function groupPeopleByInitial(people) {
  const col = zhNameCollator();
  const withLetter = people.map((p) => ({ p, letter: nameInitial(p.name) }));
  withLetter.sort((a, b) => {
    if (a.letter !== b.letter) {
      if (a.letter === '#') return 1;
      if (b.letter === '#') return -1;
      return a.letter < b.letter ? -1 : 1;
    }
    return col.compare(a.p.name ?? '', b.p.name ?? '');
  });
  const out = [];
  for (const it of withLetter) {
    const last = out.at(-1);
    if (last && last.letter === it.letter) last.rows.push(it.p);
    else out.push({ letter: it.letter, rows: [it.p] });
  }
  return out;
}



/** 窄屏判据：用 media query 本身（缓存一份，别每次渲染都新建 MediaQueryList）。 */
const MQ_NARROW = window.matchMedia('(max-width: 900px)');
const isNarrowScreen = () => MQ_NARROW.matches;



/**
 * 部门建议列表（#deptSuggest，新建对话框与员工详情共用一个 datalist）：
 * 库里已有哪些部门就建议哪些，按拼音排。
 * 自由文本字段最怕「技术部 / 技术 部」散成两个组 —— 建议列表是唯一的防手滑手段，
 * 每次开对话框 / 开详情前刷一遍（新建员工之后列表就多一个可选项）。
 */
export function refreshDeptSuggest() {
  const dl = $('deptSuggest');
  if (!dl) return;
  const col = zhNameCollator();
  const depts = [...new Set(S.personas.map((p) => String(p.department ?? '').trim()).filter(Boolean))];
  depts.sort((a, b) => col.compare(a, b));
  dl.innerHTML = depts.map((d) => `<option value="${esc(d)}"></option>`).join('');
}



export function renderList() {
  // 列表一重画，原来右键的那一行可能已经不在了 —— 菜单留着就是"点了个寂寞"
  closeCtxMenu();
  /*
   * 手机通讯录的两件挂件（右侧 A–Z 索引条、页头「←」）都挂在 #listBody 外面，
   * 重画 innerHTML 不会连带清掉 —— 每次进来先统一摘一遍，谁需要谁再挂。
   */
  document.querySelectorAll('.list-panel > .mb-az, .list-head > .mb-head-back').forEach((el) => el.remove());
  /* 手机列表的灰底：通讯录首页 `.mb-cv-root`、设置页 `.mb-set` —— 别的页面必须是白底，
     切栏时先摘掉，谁需要谁在自己的分支里加回来。 */
  $('listBody')?.classList.remove('mb-cv-root', 'mb-cv', 'mb-set');
  // 离开通讯录、或窗口拉回桌面宽度，都回首页：下次点回来不该还停在某个部门里
  if (!isNarrowScreen()) mbCv.view = 'home';
  /*
   * 代码托管页（工作台 › 代码托管）让位（2026-10-29）：左栏整栏（仓库清单 + 底部的
   * GitHub 连接条）归 renderGitRepos 管 —— 它还在 #listFoot 上挂了连接按钮。
   * 这儿连底栏都不能清：搜索键入时 app.mjs 的全局委托每个字都会调到这儿，
   * 清一下按钮就没一次。别的分支照旧"先清后画"。
   */
  if (S.nav === 'plugins' && S.route?.view === 'codeRepos') return;
  /*
   * 左栏底部固定条（#listFoot）每次重画都先清空：它挂的是「已归档」这种**跨列表**的入口，
   * 不该跟着某一份数据残留到通讯录/设置页上。哪个分支需要，自己再往里写。
   */
  const foot = $('listFoot');
  if (foot) foot.innerHTML = '';
  const q = S.filter.trim().toLowerCase();
  const match = (name) => !q || String(name || '').toLowerCase().includes(q);

  /* 「已移除的会话」子视图已随归档功能一并删除（2026-10-20，用户要求）：
     「不显示」不再往某个归档列表里放，它的记录只在「聊天记录」抽屉里可见；
     已删员工的会话留在列表里只读，右键「归档」= 从界面收走（数据留库、无入口）。 */

  if (S.nav === 'messages') {
    // 归档子视图：左栏换一份列表（渲染完全走它自己，别在这儿混分支）
    if (S.archivedView) return renderArchiveList();
    /* 工单会话（流程 / 任务卡）**不进消息列表** —— 从工作台 / 任务进去即可。
       所以这里既不平铺也不分组，直接按 kind 过滤掉。 */
    /*
     * **一人一行 / 一群一行**（2026-10-20）：
     *   · 1:1 → 只留这个人的**当前会话**（updatedAt 最大的那条）；
     *   · 群   → 一个群下面可以有多段会话（每次「发消息」一段），列表里只占**一行**，
     *            取这个群最新那段（`groupId` 相同即同一个群）；
     *   · exec → 不进列表。
     * 其余的都在「聊天记录」抽屉里，不占列表行。
     *
     * 收敛放在**前端**：服务端 listConversations 是 /api/state 的热路径，
     * 还喂着工作台、通讯录、任务看板，不能为了这个界面的展示口径去改它的 SQL。
     *
     * 顺序是「先收敛、再按名字过滤」——反过来的话，搜到一个**历史会话的标题**
     * 就会把它单独摆成一行，一个人又出现两行。副作用是搜历史标题搜不到左栏，
     * 可接受：历史归「聊天记录」。
     *
     * 不在这层排序：输入的 S.conversations 已由服务端按 updatedAt DESC 排好，
     * filter 天然保住全局顺序（群与人混在一起按最后活跃时间排，跟以前一样）。
     */
    const currentOf = new Map();  // 人 → 他的代表会话（挑选规则见 prefer）
    const groupOf = new Map();    // 群 id → 这个群的代表会话（同上）
    /*
     * 代表会话怎么挑（2026-10-24）：
     *   ① 你**正在看**的那段永远优先（2026-10-22 用户实报：从聊天记录点开老会话，
     *      行要跟着走，预览和高亮才对得上）；
     *   ② 其次**有消息的**压过空壳 —— 「新会话」开了还没发过字的空壳不该把行抢走，
     *      不然预览没了、点进去是空面板，看着就像聊天记录丢了；
     *   ③ 同档取更新的一段。
     */
    const prefer = (a, b) => {
      if (!a) return b;
      if (!b) return a;
      if (S.conversation?.id === a.id) return a;
      if (S.conversation?.id === b.id) return b;
      const aEmpty = !(a.messageCount > 0);
      const bEmpty = !(b.messageCount > 0);
      if (aEmpty !== bEmpty) return aEmpty ? b : a;
      return String(a.updatedAt) >= String(b.updatedAt) ? a : b;
    };
    for (const c of S.conversations ?? []) {
      if (c.kind === 'exec') continue;
      if (c.kind === 'group') {
        groupOf.set(gidOf(c), prefer(groupOf.get(gidOf(c)), c));
        continue;
      }
      currentOf.set(c.personaId, prefer(currentOf.get(c.personaId), c));
    }
    const rows = (S.conversations ?? [])
      .filter((c) => {
        if (c.kind === 'exec') return false;
        if (c.kind === 'group') return groupOf.get(gidOf(c))?.id === c.id;
        return currentOf.get(c.personaId)?.id === c.id;
      })
      .filter((c) => match(c.personaName) || match(c.title));
    const pById = new Map((S.personas ?? []).map((p) => [p.id, p]));   // 消息行头像要用
    $('listBody').innerHTML =
      (rows.length
        ? rows.map((c) => {
            const isGroup = c.kind === 'group';
            const title = isGroup ? c.title : convDisplayName(c);
            const avatar = isGroup
              ? `<div class="avatar grp">${esc(initial(c.title))}</div>`
              : personaAvatar(pById.get(c.personaId), '', c.personaName ?? title);
            // 没聊过就**留白**（2026-10-20 用户要求）：不再显示「还没聊过」占位
            const preview = esc(cut(plain(c.lastMessage), 34));
            /*
             * 群已解散（2026-10-20 用户定：解散后消息仍留在列表，只读）：
             * 行上标「已解散」。人数不写 —— 解散时成员快照已经清了，写出来是 "0 人"。
             */
            const sub = isGroup
              ? c.dissolvedAt
                ? (preview ? `已解散 · ${preview}` : '已解散')
                : (preview ? `${c.memberCount} 人 · ${preview}` : `${c.memberCount} 人`)
              : preview;
            /*
             * 高亮按**人 / 群**命中，不只按会话 id：正在看某人的一段历史会话、或某个群的
             * 一段老会话时，列表里那一行已经是"这个人的当前会话 / 这个群的最新一段"了，
             * 不亮会显得左栏什么都没选中（跟通讯录 `S.persona.id === p.id` 一个口径）。
             */
            const active =
              (S.conversation && S.conversation.id === c.id) ||
              (isGroup
                ? S.conversation?.groupId === gidOf(c)
                : S.conversation?.kind === 'direct' && S.conversation.personaId === c.personaId);
            return `<div class="item ${active ? 'active' : ''}" data-conv="${c.id}">
              ${avatar}
              <div class="who">
                <div class="line1"><b>${esc(title)}</b><span>${hhmm(c.updatedAt)}</span></div>
                <div class="line2"><span class="dot ${esc(c.status)}"></span>${sub}</div>
              </div>
            </div>`;
          }).join('')
        : '<div class="empty" style="padding:36px 12px">还没有消息<br />先去<strong>通讯录</strong>发起群聊或找个人聊</div>');

    $('listBody').querySelectorAll('[data-conv]').forEach((el) => {
      // 走 openConversationSafe：这段可能刚被另一个窗口删掉（E2047 → 说人话 + 收拾界面）
      el.onclick = () => openConversationSafe(el.dataset.conv);
    });
    /*
     * 「已归档 N」挂在**底部固定条**上（2026-10-20 用户定：固定在底部）：
     * 它是低频收件箱，不该占列表最贵的第一屏；固定条不跟着列表滚，
     * 会话再多也永远看得见。没有归档时 archivedEntryHTML 返回空串 → 整条不占高度。
     */
    if (foot) {
      foot.innerHTML = archivedEntryHTML();
      const archEntry = foot.querySelector('#archEntry');
      if (archEntry) archEntry.onclick = () => enterArchiveView();
    }

    /*
     * 「不显示 / 删除」不在每一行上绑按钮了 —— 2026-10-20 起是**右键菜单**，
     * 走 `#listBody` 上的 contextmenu 委托（boot 区注册一次，见那儿的长注释）。
     * 原来这里那段 `[data-hide]` 逐个绑定连同行内的 × 一起删掉了。
     */
    return;
  }

  if (S.nav === 'plugins') {
    // 工作台首页是整页宫格（左栏被 CSS 收掉）；
    // 进了**有主从布局**的插件，左栏由 renderPluginMaster 负责画 —— 这里别去清它；
    // 项目页（左栏 = 项目列表）同理，但那个框现在是**能用的搜索框**：得把输入转发过去，
    // 只重画左栏那一列（整页重摆会把输入框连人带字一起换掉，打一个字就瞎）。
    if (S.projectList) return renderProjectList();
    if (S.projectId) return;
    const p = S.plugins.find((x) => x.id === S.plugin);
    if (!p?.panel?.split) $('listBody').innerHTML = '';
    return;
  }

  if (S.nav === 'settings') {
    const groups = settingsGroups();
    /* 页头那个搜索框在设置页一直是**死的**（这个分支从来没读过 q）：框在那儿、
       点进去能打字、列表一个都不动。手机上尤其刺眼（2026-10-31 顺手接上）——
       按分节标题过滤，命中为空的组整个不画。桌面左栏共用同一份结果。 */
    const hit = (t) => !q || String(t).toLowerCase().includes(q);
    const shown = groups
      .map((g) => ({ title: g.title, items: g.items.filter(([, t]) => hit(t)) }))
      .filter((g) => g.items.length);
    /*
     * 手机（≤900px）= **微信设置页**版式（2026-10-31 用户："设置这个页面不应该做成折叠，
     * 应该参考微信设置页的做法"）：
     *   一屏五组卡片，组标题是卡片外的一行小灰字 —— **不可点、不收起**；
     *   卡片内是行（右侧 chevron），点行开子页。
     * 旧版把组头做成可折叠的导航树（带 ∨ 箭头、收起后整组消失），那是后台侧边栏的语法，
     * 手机上一屏只有 5 组 10 项、根本不需要收，箭头反而让人以为"这页坏了/点不动"。
     *
     * 桌面左栏同样是**静态**组头（见下面那个分支）：一处行为，两套版式。
     */
    if (isNarrowScreen()) {
      const body = $('listBody');
      body.classList.add('mb-set');
      body.innerHTML = shown.length
        ? shown
            .map((g) => {
              const rows = g.items
                .map(
                  ([key, title]) => `<div class="item" data-set="${key}">
            <div class="who"><div class="line1"><b>${esc(title)}</b></div></div>
          </div>`,
                )
                .join('');
              /* 组标题空了（设备 / 非管理员那种短清单）就不画标题，直接一张卡 */
              return `<div class="mb-set-group">${
                g.title ? `<div class="mb-set-head">${esc(g.title)}</div>` : ''
              }<div class="mb-set-card">${rows}</div></div>`;
            })
            .join('')
        : '<div class="empty" style="padding:40px 16px">没找到相关的设置</div>';
      body.querySelectorAll('[data-set]').forEach((el) => {
        el.onclick = () => openSettings(el.dataset.set);
      });
      return;
    }

    /*
     * 桌面左栏**分区**（2026-10-29 用户定稿："设置页各项乱糟糟的"）：
     * 桌面管理员 = 五组、每组的节挂灰字组头（复用通讯录 `.list-sec` 那套视觉）；
     * 设备 / 非管理员的清单太短，`title: null` 不画组头，照旧平铺。
     * 行照通讯录的规律给组头让位（`.sec-body` 缩进 12px）。
     *
     * 组头**不做折叠**（2026-10-31 用户："设置这个页面不应该做成折叠"）：
     * 原来是 data-sec + ∨ 箭头 + S.secCollapsed['set:xxx'] 那一套，收起后整组消失、
     * 还要在组头右侧补一颗点告诉"你正看的分节收在这里"。一屏十项，收起只是让人多点一下，
     * 两套点法（组头能点、行也能点）反而让"能点哪儿"变含糊 —— 那套分支已删。
     */
    /* 单行（2026-10-29 用户："二级菜单下的说明去掉"）：只画标题，副标题说明不再渲染 ——
       导航树求短求快，说明是阅读负担；数组里的 sub 留着（title 兜底等别处还用得上）。 */
    const row = ([key, title]) => `<div class="item ${S.settingsSection === key ? 'active' : ''}" data-set="${key}" title="${title}">
          <div class="who">
            <div class="line1"><b>${title}</b></div>
          </div>
        </div>`;
    $('listBody').innerHTML = shown.length
      ? shown
          .map((g) =>
            g.title
              ? `<div class="list-sec nav static">${esc(g.title)}</div><div class="sec-body nav">${g.items.map(row).join('')}</div>`
              : g.items.map(row).join(''),
          )
          .join('')
      : '<div class="empty" style="padding:28px 10px">没找到相关的设置</div>';
    $('listBody').querySelectorAll('[data-set]').forEach((el) => {
      el.onclick = () => openSettings(el.dataset.set);
    });
    return;
  }

  // 工作流页的左栏归工作流自己画：**编排 = 模板列表，实例 = 发起记录**。
  // 以前这里是一句「工作流 / 开发中」的占位（功能刚做时的死代码），
  // 后来删掉了占位 —— 但删了之后它会**落到下面的消息分支**，把左栏画成会话列表 ✗
  // 所以这里要显式接管：谁调 renderList、什么顺序调，左栏都是对的。
  if (S.nav === 'workflows') {
    if (S.flowMode === 'run') renderRunList();
    else renderFlowList();
    return;
  }

  // 专家库是整页卡片墙（左栏被 CSS 收掉）：左栏谁都不画，清空兜底。
  // 不显式接管的话会落到下面的通讯录分支，把会话列表画进一面看不见的栏里（白画还留隐患）。
  if (S.nav === 'experts') {
    $('listBody').innerHTML = '';
    return;
  }

  // 我的页同样整页（左栏收掉）：清空兜底，同上
  if (S.nav === 'me') {
    $('listBody').innerHTML = '';
    return;
  }

  // 通讯录 = 群聊 + 数字员工 两段（搜的时候空的段不占地方）
  // 群聊**包含被「不显示」的**（2026-10-20 用户要求）：
  // 「不显示」隐藏的是**这行会话消息**，不是群本身 —— 群、成员、群助手都还在，
  // 所以通讯录里照常列出来（不打任何"已隐藏"标记，那会让人以为群被处理过）。
  // 消息列表里它仍然不出现，直到群里再来新消息。
  //
  // ⚠️ 群的**身份**来自 `S.groups`（groups 表），**不是**从会话推（2026-10-20 用户实报：
  // 「在通讯录里，群为什么也没了」）。以前是按 conversations 里 kind='group' 去重出来的，
  // 于是会话一删光（或一段都没留）群就在通讯录消失 —— 但群是容器，容器不该因片段删光而消失。
  // 会话只用来补"最近说了什么 / 状态"，零段的群照样列出来（副标题写「还没聊过」）。
  const latestConvOfGroup = new Map(); // 群 id → 这个群最近一段（可见优先，其次被隐藏的）
  for (const c of [...S.conversations, ...(S.hiddenConversations ?? [])]) {
    if (c.kind !== 'group') continue;
    const gid = gidOf(c);
    if (!latestConvOfGroup.has(gid)) latestConvOfGroup.set(gid, c);
  }
  const groups = (S.groups ?? [])
    .map((g) => ({ ...g, conv: latestConvOfGroup.get(g.id) ?? null }))
    .filter((g) => match(g.title));
  const people = S.personas.filter((p) => match(p.name) || match(p.department));
  // 真人（2026-10-31 用户概念落地）：设置 → 用户里建的账号，通讯录单独一段，跟数字员工分开
  const users = (S.users ?? []).filter((u) => match(u.name));
  /**
   * 分段标题。收起时**整段内容不渲染**（不是单纯 display:none）——
   * 收起就没有它的 DOM，点了也不会先闪一下再消失。
   * 搜索时强制展开：不然搜到了却看不见，会以为没搜到。
   */
  const collapsed = S.secCollapsed ?? (S.secCollapsed = {});
  const sec = (key, title, n, body) => {
    const shut = !q && !!collapsed[key];
    return (
      `<div class="list-sec ${shut ? 'shut' : ''}" data-sec="${key}" title="${shut ? '展开' : '收起'}">
         <i class="sec-arrow"></i>${title} <span class="sec-n">${n}</span>
       </div>` + (shut ? '' : `<div class="sec-body">${body}</div>`)
    );
  };

  const groupRows = groups.map(groupRowHTML).join('');

  /* 数字员工按部门分组（2026-10-25 用户拍板：部门是给人看的分组，替代原 A–Z 字母头）。
     部门头是**可折叠的子段**（复用 sec 机制，各自的收起状态记住）：人多时把不关心的
     部门收起来，找部门就不用滚长列表；搜索框也匹配部门名（上面 match 那行）——
     搜「技术部」直接出这个部门的人，比滚着找更快。搜索时不画部门头：结果少而散，
     再切开反而碎；且 sec 搜索时强制展开。 */
  const personRows = groupPeopleByDepartment(people)
    .map((g) => (q
      ? g.rows.map(personRowHTML).join('')
      : sec(`dept:${g.dept}`, esc(g.dept), g.rows.length, g.rows.map(personRowHTML).join(''))))
    .join('');

  /*
   * 手机（≤900px）换成手机通讯录形态（2026-10-31 用户："通讯录不是手机的风格，
   * 改成手机那种 ABC 的"）：上面群聊 / 部门入口，下面按拼音首字母 A–Z 分组。
   * 桌面继续走部门分组 —— 下面这一整段一行不动。
   */
  if (S.nav === 'contacts' && isNarrowScreen()) {
    renderMobileContacts({ q, groups, people, users });
    return;
  }

  $('listBody').innerHTML = !groups.length && !people.length && !users.length
    ? '<div class="empty" style="padding:36px 12px">通讯录还是空的<br />点右上角 ＋ 发起群聊或添加员工</div>'
    : (groups.length || !q ? sec('group', '群聊', groups.length, groups.length ? groupRows : '<div class="list-none">还没有群聊</div>') : '') +
      (users.length || !q ? sec('users', '成员', users.length, users.length ? users.map(userRowHTML).join('') : '<div class="list-none">还没有成员 —— 在「设置 → 用户」里创建</div>') : '') +
      (people.length || !q ? sec('person', '数字员工', people.length, people.length ? personRows : '<div class="list-none">还没有数字员工</div>') : '');

  $('listBody').querySelectorAll('[data-sec]').forEach((el) => {
    el.onclick = () => {
      S.secCollapsed[el.dataset.sec] = !S.secCollapsed[el.dataset.sec];
      saveCollapsed();
      renderList();
    };
  });

  bindContactRows();
}



/* -------------------------------------------------- 通讯录行模板（桌面 / 手机共用） */

/** 群行。data-group 必须是**群 id**：点它进的是群详情页，走的是 /api/groups/:id */
const groupRowHTML = (g) => {
  const c = g.conv;                                  // 零段的群没有 conv，别去读 c.xxx
  const preview = cut(plain(c?.lastMessage), 22);
  return `<div class="item ${S.groupThreadId === g.id || S.conversation?.groupId === g.id ? 'active' : ''}" data-group="${esc(g.id)}">
        <div class="avatar grp">${esc(initial(g.title))}</div>
        <div class="who">
          <div class="line1"><b>${esc(g.title)}</b></div>
          <div class="line2"><span class="dot ${esc(c?.status ?? '待跑')}"></span>${g.memberCount} 人 · ${esc(preview || '还没聊过')}</div>
        </div>
      </div>`;
};

const personRowHTML = (p) => `<div class="item ${S.persona && S.persona.id === p.id ? 'active' : ''}" data-persona="${p.id}">
        ${personaAvatar(p)}
        <div class="who">
          <div class="line1"><b>${esc(p.name)}${p.builtin ? '<i class="b-inline" title="出厂就在的员工：名字、职责与技能随平台固定，删不掉">内置</i>' : ''}</b></div>
          <div class="line2">${esc(personSubtitle(p))}</div>
        </div>
        <i class="dot ${p.busy ? 'busy' : ''}" title="${p.busy ? '正在干活' : '现在闲着'}"></i>
      </div>`;

/**
 * 真人行（2026-10-31 用户概念落地）：只摆名字 —— 成员没有会话、没有忙闲，
 * 点不出详情页（要管账号去「设置 → 用户」），所以不给 data-* 也不绑点击。
 */
const userRowHTML = (u) => `<div class="item">
        <div class="avatar">${esc(initial(u.name))}</div>
        <div class="who">
          <div class="line1"><b>${esc(u.name)}</b></div>
          ${u.builtin ? '<div class="line2">管理员</div>' : ''}
        </div>
      </div>`;

/** 列表里三类行的点击绑定（桌面 / 手机共用）。 */
function bindContactRows() {
  const body = $('listBody');
  body.querySelectorAll('[data-conv]').forEach((el) => {
    el.onclick = () => openConversation(el.dataset.conv).catch((e) => toast(e.message, 'error'));
  });
  // 通讯录点群聊 = **看群详情**（右侧），不跳对话。
  // 要聊，去详情里点「发消息」。
  body.querySelectorAll('[data-group]').forEach((el) => {
    el.onclick = () => openGroupDetail(el.dataset.group).catch((e) => toast(e.message, 'error'));
  });
  // 通讯录点员工：
  //   · 桌面 = **看详情**（右侧），要聊去详情里点「发消息」——那条路会切到消息模块并把光标放好；
  //   · 手机窄屏 = **直接开聊**（2026-11 移动端增量：手机上多一跳详情反而绕，跟微信一致）。
  //     窄屏判据用 body.mb-narrow（mobile.mjs 维护的状态类）。群聊行不受影响，仍进群详情。
  body.querySelectorAll('[data-persona]').forEach((el) => {
    if (document.body.classList.contains('mb-narrow')) {
      el.onclick = () => {
        // 行和列表是同一批数据画出来的，正常都能找到人；找不到（极端时序）兜底回桌面路径
        const p = S.personas.find((x) => x.id === el.dataset.persona);
        if (p) openDirectChat(p);
        else openDetail(el.dataset.persona).catch((e) => toast(e.message, 'error'));
      };
    } else {
      el.onclick = () => openDetail(el.dataset.persona).catch((e) => toast(e.message, 'error'));
    }
  });
}



/* ---------------------------------------------------- 通讯录（手机）：ABC 索引 */

/*
 * 形态（2026-10-31，对着手机系统通讯录 / 微信通讯录做的）：
 *
 *   ┌ 群聊   2  › ┐      ← 容器入口：点进去是各自的列表（列表内换页，不是详情态）
 *   ┌ 部门   3  › ┐
 *   A                     ← 字母条吸顶
 *   [头像] 安宁   岗位
 *   B
 *   ...                   ← 右侧一条 A–Z 索引，点或滑直接跳
 *
 * 页面状态只有本模块知道（`mbCv`）：home / groups / depts / dept。不做 URL 路由，
 * 切走一级栏就回 home（renderList 顶部会重置）。
 */
const mbCv = { view: 'home', dept: '' };

/*
 * 底部 tab 点「通讯录」= 明确要回一级页（事件由 mobile.mjs 派发）。
 * 这里只重置视图、不自己重画：紧接着的 setNav 会把左栏整体重画一遍。
 */
document.addEventListener('mb-cv-home', () => {
  mbCv.view = 'home';
  mbCv.dept = '';
});

const CV_TITLE = { home: '通讯录', groups: '群聊', depts: '部门', users: '成员' };

/** 入口行 / 部门行的图标（40px 圆角方块里的线性图标，跟底部 tab 同一套笔画） */
const CV_ICON_GROUP = '<div class="mb-cv-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19.5c.9-3.2 3-5 5.5-5s4.6 1.8 5.5 5"/><circle cx="16.8" cy="9.4" r="2.5"/><path d="M15.7 14.9c2.4.3 4.2 1.9 4.9 4.6"/></svg></div>';
const CV_ICON_DEPT = '<div class="mb-cv-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="8.5" width="7" height="12" rx="1"/><rect x="13.5" y="3.5" width="7" height="17" rx="1"/><path d="M6 12h1M6 15.5h1M16 7h1M16 10.5h1M16 14h1"/></svg></div>';
// 成员 = 单人（与 ICON_PERSON 同一套笔画，包上入口卡的壳）
const CV_ICON_USER = '<div class="mb-cv-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="8" r="3.2"/><path d="M4 19.5c0-3.4 2.7-5.6 6-5.6s6 2.2 6 5.6"/></svg></div>';

/**
 * 列表页头：子页把标题换成子页名，并在左边补一颗「←」——
 * 手机上"从哪儿来回哪儿去"必须有个实体按钮，光靠手势返回不够。
 * 直接写 DOM 而不用 flowpages 的 setListTitle：那边反过来 import 本模块，会成环。
 */
function paintCvHead() {
  const head = document.querySelector('.list-head');
  head?.querySelector('.mb-head-back')?.remove();
  const title = mbCv.view === 'dept' ? (mbCv.dept || '部门') : (CV_TITLE[mbCv.view] ?? '通讯录');
  const el = $('listTitle');
  if (el) el.innerHTML = `<b title="${esc(title)}">${esc(title)}</b>`;
  if (mbCv.view === 'home' || !head) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mb-head-back';
  btn.setAttribute('aria-label', '返回通讯录');
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>';
  btn.addEventListener('click', goCvHome);
  head.prepend(btn);
}

function goCvHome() {
  mbCv.view = 'home';
  mbCv.dept = '';
  renderList();
}

/** 右侧 A–Z 索引条：点一下跳，按住上下滑一路扫（手机通讯录的核心手势）。 */
let azScrollHandler = null;

function mountAzIndex(letters) {
  const panel = document.querySelector('.list-panel');
  const body = $('listBody');
  if (!panel || !body) return;

  const idx = document.createElement('div');
  idx.className = 'mb-az';
  idx.setAttribute('aria-hidden', 'true');
  idx.innerHTML = letters.map((l) => `<span data-letter="${l}">${l}</span>`).join('');
  panel.append(idx);

  const jump = (letter) => {
    const head = [...body.querySelectorAll('.mb-az-head')].find((h) => h.dataset.letter === letter);
    if (head) {
      // 相对滚动容器算，别用 scrollIntoView（那会把外层一起滚，页面抖一下）
      const b = body.getBoundingClientRect();
      body.scrollTop += head.getBoundingClientRect().top - b.top;
    }
    idx.querySelectorAll('span').forEach((s) => s.classList.toggle('on', s.dataset.letter === letter));
  };

  const pick = (clientY) => {
    const r = idx.getBoundingClientRect();
    const n = letters.length;
    if (!n || !r.height) return;
    const i = Math.min(n - 1, Math.max(0, Math.floor(((clientY - r.top) / r.height) * n)));
    jump(letters[i]);
  };

  let dragging = false;
  idx.addEventListener('touchstart', (e) => { dragging = true; pick(e.touches[0].clientY); e.preventDefault(); }, { passive: false });
  idx.addEventListener('touchmove', (e) => { if (dragging) { pick(e.touches[0].clientY); e.preventDefault(); } }, { passive: false });
  idx.addEventListener('touchend', () => { dragging = false; });
  idx.addEventListener('click', (e) => {
    const s = e.target.closest('[data-letter]');
    if (s) jump(s.dataset.letter);
  });

  // 滚动时同步高亮：顶部压过 40px 的最后一个字母条 = 当前所在组
  if (azScrollHandler) body.removeEventListener('scroll', azScrollHandler);
  let raf = 0;
  azScrollHandler = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const top = body.getBoundingClientRect().top;
      let cur = letters[0];
      for (const h of body.querySelectorAll('.mb-az-head')) {
        if (h.getBoundingClientRect().top - top <= 42) cur = h.dataset.letter;
        else break;
      }
      idx.querySelectorAll('span').forEach((s) => s.classList.toggle('on', s.dataset.letter === cur));
    });
  };
  body.addEventListener('scroll', azScrollHandler, { passive: true });
  idx.querySelector('span')?.classList.add('on');
}

/** 手机通讯录的全部四种视图。groups / people 已按搜索词过滤过。 */
function renderMobileContacts({ q, groups, people, users = [] }) {
  const body = $('listBody');
  /*
   * 灰底只给**首页**：那里有入口卡要"浮起来"，ABC 名单也需要灰底衬托白行。
   * 子页（群聊 / 部门 / 某部门）没有卡，通栏白底才是列表的正常样子 ——
   * 灰底会让半屏的部门列表看起来像"白块没画完"（改版时截到的）。
   * 搜索态同理：结果就是一行行白的，没有卡可浮。
   */
  body.classList.toggle('mb-cv-root', mbCv.view === 'home' && !q);
  /* 通讯录四种视图共用「行矮一档」这套尺寸（.mb-cv 挂 padding/头像压缩），
     灰底只首页那份是上面那条 —— 两个类各管一件事，别混。 */
  body.classList.add('mb-cv');
  paintCvHead();

  /* 搜索：不画入口区、不画字母头 —— 结果本来就只有几条，再按字母切碎反而难扫。 */
  if (q) {
    const rows = groups.map(groupRowHTML).join('') + users.map(userRowHTML).join('') + people.map(personRowHTML).join('');
    body.innerHTML = rows || '<div class="empty" style="padding:36px 12px">没找到匹配的人或群</div>';
    bindContactRows();
    return;
  }

  if (mbCv.view === 'users') {
    body.innerHTML = users.length
      ? users.map(userRowHTML).join('')
      : '<div class="empty" style="padding:36px 12px">还没有成员<br />到「设置 → 用户」里创建</div>';
    return;
  }

  if (mbCv.view === 'groups') {
    body.innerHTML = groups.length
      ? groups.map(groupRowHTML).join('')
      : '<div class="empty" style="padding:36px 12px">还没有群聊<br />点右上角 ＋ 发起群聊</div>';
    bindContactRows();
    return;
  }

  const depts = groupPeopleByDepartment(people);

  if (mbCv.view === 'depts') {
    body.innerHTML = depts.length
      ? depts.map((g) => `<div class="item mb-cv-row" data-cv-dept="${esc(g.dept)}">
          ${CV_ICON_DEPT}
          <div class="who"><div class="line1"><b>${esc(g.dept)}</b></div></div>
          <span class="mb-cv-n">${g.rows.length}</span>
        </div>`).join('')
      : '<div class="empty" style="padding:36px 12px">还没有部门<br />部门在员工资料里填</div>';
    body.querySelectorAll('[data-cv-dept]').forEach((el) => {
      el.onclick = () => {
        mbCv.view = 'dept';
        mbCv.dept = el.dataset.cvDept;
        renderList();
      };
    });
    return;
  }

  if (mbCv.view === 'dept') {
    const g = depts.find((x) => x.dept === mbCv.dept);
    body.innerHTML = g && g.rows.length
      ? g.rows.map(personRowHTML).join('')
      : '<div class="empty" style="padding:36px 12px">这个部门还没有人</div>';
    bindContactRows();
    return;
  }

  // 首页：入口卡 + A–Z 名单
  const az = groupPeopleByInitial(people);
  const entry = `<div class="mb-cv-entry">
      <div class="item mb-cv-row" data-cv="groups">
        ${CV_ICON_GROUP}
        <div class="who"><div class="line1"><b>群聊</b></div></div>
        <span class="mb-cv-n">${groups.length}</span>
      </div>
      <div class="item mb-cv-row" data-cv="depts">
        ${CV_ICON_DEPT}
        <div class="who"><div class="line1"><b>部门</b></div></div>
        <span class="mb-cv-n">${depts.length}</span>
      </div>
      <div class="item mb-cv-row" data-cv="users">
        ${CV_ICON_USER}
        <div class="who"><div class="line1"><b>成员</b></div></div>
        <span class="mb-cv-n">${users.length}</span>
      </div>
    </div>`;
  const list = az
    .map((g) => `<div class="mb-az-head" data-letter="${g.letter}">${g.letter}</div>${g.rows.map(personRowHTML).join('')}`)
    .join('');
  body.innerHTML =
    entry +
    (list || '<div class="empty" style="padding:36px 12px">通讯录还是空的<br />点右上角 ＋ 添加员工</div>');

  bindContactRows();
  body.querySelectorAll('[data-cv]').forEach((el) => {
    el.onclick = () => {
      mbCv.view = el.dataset.cv;
      renderList();
    };
  });
  if (az.length) mountAzIndex(az.map((g) => g.letter));
}



/* ------------------------------------------------------------ 新建选择器 */

/** 「＋」菜单里的图标（描边风格，跟左侧导航一致） */
export const ICON_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11.5c0 3.3-3.6 6-8 6-1.2 0-2.3-.2-3.3-.6L4 19l1.2-3.4C4.4 14.6 4 13.1 4 11.5c0-3.3 3.6-6 8-6s8 2.7 8 6z"/></svg>';


export const ICON_PERSON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="8" r="3.2"/><path d="M4 19.5c0-3.4 2.7-5.6 6-5.6"/><path d="M17.5 13.5v7M14 17h7"/></svg>';


export const ICON_NOTE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4.5h9l5 5v10H5z"/><path d="M14 4.5v5h5"/><path d="M8.5 13h7M8.5 16h4"/></svg>';


export const ICON_IMPORT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v9"/><path d="M8.5 10.5 12 14l3.5-3.5"/><path d="M5 16.5v3h14v-3"/></svg>';


/** 执行结果里的产物图标：文件 / 链接（跟上面同一套描边风格） */
export const ICON_FILE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4.5h9l5 5v10H5z"/><path d="M14 4.5v5h5"/></svg>';


export const ICON_LINK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 13.5a3.5 3.5 0 0 0 5 0l2.5-2.5a3.5 3.5 0 0 0-5-5L11.8 7"/><path d="M13.5 10.5a3.5 3.5 0 0 0-5 0L6 13a3.5 3.5 0 0 0 5 5l1.2-1.2"/></svg>';



/**
 * 「＋」拉出来的选择菜单：一个入口，几种结果。
 * 菜单项形如 { label, hint, icon, run }。通讯录和技能共用这一套样式。
 */
export let addMenu = null;


/** 打开菜单的那颗按钮 —— 定位和"点别处收起"都靠它，别再写死 `#listAction` */
export let addMenuAnchor = null;


export function closeAddMenu() {
  if (addMenu) { addMenu.remove(); addMenu = null; }
  addMenuAnchor = null;
}


export function openAddMenu(items, anchor = null) {
  closeAddMenu();
  const box = document.createElement('div');
  box.className = 'add-menu';
  box.innerHTML = items
    .map(
      (it, i) => `<button data-add="${i}" title="${esc(it.hint)}">
        <i class="ico">${it.icon ?? ''}</i>
        <span class="txt"><b>${esc(it.label)}</b><em>${esc(it.hint)}</em></span>
      </button>`,
    )
    .join('');
  /*
   * 挂哪儿：左栏**真的显示着**才挂 `.list-head`，否则挂 body。
   *
   * 2026-10-26 用户报「＋ 添加仓库 打不开」：代码托管是工作台下的整页，`body.no-list`
   * 把整个 `.list-panel` 设成 `display:none` —— 菜单 append 进去了，元素在、事件也绑上了，
   * 但量出来 0×0、坐标 0,0，永远看不见（不是"没反应"，是"渲染在一个不显示的地方"）。
   * 挂 body 时改用 `position:fixed` 直接按按钮的视口坐标摆，不再需要左栏当坐标原点。
   */
  const head = document.querySelector('.list-head');
  const inList = !!head && head.getClientRects().length > 0;
  (inList ? head : document.body).append(box);
  /*
   * 让「＋」落在菜单的中线上：按**打开它的那颗按钮**算，不写死像素。
   *
   * ⚠️ 以前这里写死 `#listAction`。技能搬进「设置 → 技能」之后，那颗 ＋ 在主区
   * （`#skNew`），而 `#listAction` 在设置页是**隐藏的** —— 隐藏元素的 getBoundingClientRect()
   * 全是 0，菜单会跑到左上角去。
   */
  const anchorEl = anchor ?? document.querySelector('#listAction');
  const btn = anchorEl.getBoundingClientRect();
  const w = box.getBoundingClientRect().width || 268; // 刚 append 就量，宽度可能还是 0（样式没落地）
  let left = btn.left + btn.width / 2 - w / 2;
  left = Math.min(Math.max(left, 8), window.innerWidth - w - 8); // 别探出视口
  if (inList) {
    const hb = head.getBoundingClientRect();
    box.style.left = Math.round(left - hb.left) + 'px';
    box.style.right = 'auto';
    /*
     * 竖直位置：**打开菜单的那颗按钮不在左栏头部里**时（主区那颗「＋」，
     * 比如「代码仓库 → ＋ 添加仓库」），菜单得跟着按钮走。
     *
     * CSS 里写的是 `top: calc(100% - 4px)` —— 那是"紧贴左栏页头下面"，
     * 对页头里那颗 ＋ 正好；但主区那颗 ＋ 在页面几十到几百像素以下，
     * 菜单会**浮在按钮上方老远**，看着像从别处冒出来的。
     */
    if (!head.contains(anchorEl)) {
      box.style.top = Math.round(btn.bottom - hb.top + 6) + 'px';
    }
  } else {
    // 挂在 body 上：没有左栏可以当坐标原点，直接固定在按钮正下方
    box.style.position = 'fixed';
    box.style.left = Math.round(left) + 'px';
    box.style.right = 'auto';
    box.style.top = Math.round(btn.bottom + 6) + 'px';
  }
  box.querySelectorAll('[data-add]').forEach((b) => {
    b.onclick = () => { closeAddMenu(); items[Number(b.dataset.add)].run(); };
  });
  addMenuAnchor = anchorEl;
  addMenu = box;
}



/** 通讯录的「＋」：建群还是建员工 */
export const contactAddItems = () => [
  { label: '发起群聊', hint: '拉几个人组个项目群，@ 谁谁接话', icon: ICON_CHAT, run: openGroupDialog },
  { label: '添加数字员工', hint: '配一个 agent CLI 当同事', icon: ICON_PERSON, run: openPersonaDialog },
];



/** 技能的「＋」：手写一个还是从本地导入 */
export const skillAddItems = () => [
  { label: '新建技能', hint: '从空白 SKILL.md 开始写', icon: ICON_NOTE, run: newSkill },
  { label: '从本地导入', hint: '把本机已有的 SKILL.md 拷进库里', icon: ICON_IMPORT, run: openImportDialog },
];



/**
 * 「代码仓库」的「＋ 添加仓库」：手动接入 还是 从 GitHub 挑。
 *
 * 两条路**一直都在**（不像原来那样：没连 GitHub 时压根没有"从 GitHub 挑"）——
 * 没连就让它点下去，弹窗里会把"拉不到清单"的原因说出来，那比"这个入口不存在"清楚。
 * 顺序上把「从 GitHub 添加」放前面：连了 GitHub 的话它是主路。
 */
/**
 * 「代码仓库」的「＋ 添加仓库」：一条路（2026-10-30 用户："这个界面改成参考图这种"）——
 * 弹窗里左边挑来源（GitHub / 本地代码托管），不再让用户在菜单里先选一次。
 */
export const gitAddRepoItems = (onDone) => [
  {
    label: '添加仓库…',
    hint: '从 GitHub 挑一个，或把本地代码托管进来',
    icon: ICON_CLOUD,
    run: () => openGitPickDialog(onDone),
  },
];



/* ------------------------------------------------------------ 视图切换 */

/**
 * 员工详情的**自动保存**：模块级一个引用，由 renderDetail 挂上。
 *
 * 为什么要有：保存从"点按钮"改成"改了就算"之后，最后那次输入还在防抖队列里，
 * 这时切视图 / 打开别的员工 / 关窗口，不先 flush 就丢了 —— 用户会以为"我明明改了"。
 */
export const detailSave = { flush: null };



export function showView(which) {
  if (which !== 'detail' && detailSave.flush) detailSave.flush(); // 离开详情前先落盘（自动保存的兜底）
  const on = (id, cond) => $(id)?.classList.toggle('shown', cond);
  $('chatView')?.classList.toggle('hidden', which !== 'chat');
  // 2026-10-22：全部改可选链 —— 某个 view 容器万一缺了（expertsView 就漏建过），
  // 只损失那一页，不该把整个 showView 炸掉连累所有页面白屏
  on('detailView', which === 'detail');
  on('settingsView', which === 'settings');
  on('groupView', which === 'group');
  on('expertsView', which === 'experts');
  on('pluginView', which === 'plugin');
  on('flowView', which === 'flow');
  on('placeholderView', which === 'placeholder');
}



/** 还没做的东西：先说好是"开发中"，别做成点不动的空壳 */
export function showPlaceholder(title) {  $('placeholderView').innerHTML = `
    <div class="detail-head"><b>${esc(title)}</b></div>
    <div class="detail-body"><div class="wip">开发中</div></div>`;
  showView('placeholder');
}

/**
 * 通讯录的主区空态（2026-10-24 对齐微信）：切到通讯录但还没选人时，
 * 右边不残留上一段聊天 —— 摆一个安静的占位。点左栏的群/员工才进详情。
 */
export function showContactsHome() {
  $('placeholderView').innerHTML = `
    <div class="contacts-home">
      <div>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="8" r="3.6"/><path d="M4.5 20c1.2-3.6 4.1-5.6 7.5-5.6s6.3 2 7.5 5.6"/>
        </svg>
        <div class="hint">在左侧选一个群或数字员工，看Ta的资料</div>
      </div>
    </div>`;
  showView('placeholder');
}
