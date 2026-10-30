/* skills.mjs —— 技能、从 GitHub 挑仓库（放进弹窗里）、定时任务、从本地导入、技能 → 发给数字员工（反方向挂载）。
 * 2026-10-22 由 app.js（15537 行单文件）拆出，原生 ESM、无打包器；逻辑逐字搬运。 */
import { esc, mdRender, savePlace, setRoute, toast } from './shell.mjs';
import { ICON_BRANCH, ICON_COMMIT, ICON_EDIT, ICON_GEAR, ICON_PLAY, ICON_PUSH, ICON_SYNC, ICON_TAG, ICON_TRASH, api, createCombo, createDateTimePick, cut, failHtml, initial, openCtxMenu, post, wireDialogHead } from './ui.mjs';
import { load, setNav } from './state.mjs';
import { openSettings } from './settings.mjs';
import { setListTitle } from './flowpages.mjs';
import { breadcrumb, headRow } from './connectors.mjs';
import { confirmDo, askCheckbox } from './machine.mjs';
import { openAddMenu, renderList, showView, skillAddItems } from './contacts.mjs';
import { pickLocalDir, openProjectDetail, openTaskCardDialog } from './projects.mjs';

import { $, S } from './core.mjs';

/* 提交卡两组文件的折叠态（模块级 —— renderGitRepos 每次刷新重建 fillChanges，
 * 状态放这儿才能跨刷新保留；false = 展开，默认全展开） */
const chgFold = { chg: false, untr: false };
/* 勾选提交（2026-10-27，用户："加选择框允许选择提交"）：记**没勾**的路径（缺省全选，
 * 新出现的文件天然勾上）；chgSelRepo 认仓库 —— 换仓库清空。 */
const chgUnsel = new Set();
let chgSelRepo = null;



/* ---------------------------------------------------------------- 技能 */

export async function openSkill(name) {
  setRoute('skill', { name });
  const d = await api('/api/skills/' + encodeURIComponent(name));
  S.skill = d.skill;
  showView('settings'); // 技能现在住在「设置 → 技能」里，主区还是 settingsView
  renderList();
  renderSkillEditor(d.skill, false, d.personas ?? []);
  savePlace();
}



/**
 * 「设置 → 技能」的主区：所有技能铺成卡片。
 *
 * 为什么列表画在**主区**而不是左栏：设置页的左栏固定是分节列表。
 * 要是点「技能」之后把左栏换成技能列表，分节列表就没了 ——
 * 想去别的节只能再点一次左下的齿轮，然后又被 `S.settingsSection` 带回技能，来回绕。
 *
 * 「＋」也在这儿（`#listAction` 那个在设置页是隐藏的，见 setNav）。
 */
/**
 * **手动接入**（2026-10-17）：私有仓库 / 令牌没授权的仓库 / 离线时用。
 *
 * 为什么要它：令牌的 Repository access 没勾的私有仓库**根本不出现在列表里**，
 * 而本地可能早就克隆好了 —— 那就手填 owner/name ＋ 本地目录：
 * 平台只记路径、不联网、不复制代码。
 */
export function openGitManualDialog(onDone) {
  const dlg = document.createElement('dialog');
  dlg.id = 'gitManualDlg';
  dlg.innerHTML = `
    <form method="dialog">
      <b>手动接入仓库</b>
      <label>仓库（owner/name）</label>
      <input id="gitManualName" placeholder="例如：shepherd-chenxs/yuku" autocomplete="off" />
      <label>本地目录（这个仓库已存在的克隆）</label>
      <div class="row-with-btn">
        <input id="gitManualPath" placeholder="例如：E:\\repos\\yuku" />
        <button type="button" id="gitManualPick">选择</button>
      </div>
      <div class="counter left">
        用于私有仓库、令牌没授权的仓库、离线场景。平台**只记路径**：不复制代码、不联网查元数据；
        私有状态显示为未知，「同步」需要该仓库在令牌的 Repository access 里。
      </div>
      <div class="dlg-actions">
        <button type="button" value="cancel">取消</button>
        <button class="primary" id="gitManualOk">接入</button>
      </div>
    </form>`;
  document.body.append(dlg);
  wireDialogHead(dlg.querySelector('form'));
  dlg.addEventListener('close', () => dlg.remove());

  $('gitManualPick').onclick = async () => {
    const input = $('gitManualPath');
    const btn = $('gitManualPick');
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const picked = await pickLocalDir({
        title: '选择这个仓库的本地目录',
        startPath: input.value.trim(),
      });
      if (picked) input.value = picked;
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '选择';
    }
  };
  $('gitManualOk').onclick = async (e) => {
    e.preventDefault();
    const fullName = $('gitManualName').value.trim();
    const localPath = $('gitManualPath').value.trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) return toast('仓库写成 owner/name');
    if (!localPath) return toast('本地目录不能空（手动接入必须指向已有的克隆）');
    const btn = $('gitManualOk');
    btn.disabled = true;
    btn.textContent = '接入中…';
    try {
      const r = await api('/api/git/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullName, localPath }),
      });
      dlg.close();
      await onDone();
      toast(`${fullName} 已接入\n${r.repo.localPath}${r.warning ? '\n\n⚠️ ' + r.warning : ''}`);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = '接入';
      toast(err.message, 'error');
    }
  };
  dlg.showModal();
}



/**
 * 接入一个仓库：**克隆一份** 还是 **用本地已有目录**（2026-10-17 用户实报：
 * 本地明明已经有克隆了，点接入又在别处克隆一份，白占盘）。
 *
 * 选"用本地已有目录"时会核对 origin 指向是不是这个仓库 —— 不一致只提示、不拦
 * （fork / 镜像 / 自己改了 remote 都是合理情况）。
 */
export function openGitAddDialog(fullName, onDone) {
  const dlg = document.createElement('dialog');
  dlg.id = 'gitAddDlg';
  dlg.innerHTML = `
    <form method="dialog">
      <b>接入 ${esc(fullName)}</b>
      <label class="check"><input type="radio" name="gitMode" value="clone" checked />
        <span>克隆到数据目录<em>——平台自己管一份</em></span></label>
      <label class="check"><input type="radio" name="gitMode" value="local" />
        <span>用本地已有目录<em>——不重复克隆、不占第二份盘</em></span></label>
      <div class="row-with-btn">
        <input id="gitLocalPath" placeholder="例如：E:\\02CodeSpace\\github\\bandi" disabled />
        <button type="button" id="gitLocalPick" disabled>选择</button>
      </div>
      <div class="counter left" id="gitAddHint">克隆位置：数据目录 \\ repos \\ &lt;owner&gt;__&lt;name&gt;</div>
      <div class="dlg-actions">
        <button type="button" value="cancel">取消</button>
        <button class="primary" id="gitAddOk">接入</button>
      </div>
    </form>`;
  document.body.append(dlg);
  wireDialogHead(dlg.querySelector('form'));
  dlg.addEventListener('close', () => dlg.remove());

  const syncMode = () => {
    const local = dlg.querySelector('input[name="gitMode"]:checked')?.value === 'local';
    $('gitLocalPath').disabled = !local;
    $('gitLocalPick').disabled = !local;
    $('gitAddHint').textContent = local
      ? '会用这个目录里现成的克隆；平台只记路径，不复制代码。'
      : '克隆位置：数据目录 / repos / <owner>__<name>';
  };
  dlg.querySelectorAll('input[name="gitMode"]').forEach((r) => (r.onchange = syncMode));
  syncMode();

  $('gitLocalPick').onclick = async () => {
    const input = $('gitLocalPath');
    const btn = $('gitLocalPick');
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const picked = await pickLocalDir({
        title: '选择这个仓库已存在的克隆目录',
        startPath: input.value.trim(),
      });
      if (picked) input.value = picked;
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '选择';
    }
  };

  $('gitAddOk').onclick = async (e) => {
    e.preventDefault();
    const local = dlg.querySelector('input[name="gitMode"]:checked')?.value === 'local';
    const localPath = local ? $('gitLocalPath').value.trim() : '';
    if (local && !localPath) return toast('选了"用本地已有目录"，但路径是空的');
    const btn = $('gitAddOk');
    btn.disabled = true;
    btn.textContent = local ? '接入中…' : '克隆中…';
    try {
      const r = await api('/api/git/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullName, ...(localPath ? { localPath } : {}) }),
      });
      dlg.close();
      await onDone();
      const warn = r.warning ? '\n\n⚠️ ' + r.warning : '';
      toast(`${fullName} 已接入（${r.note}）\n${r.repo.localPath}${warn}`);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = '接入';
      toast(err.message, 'error');
    }
  };
  dlg.showModal();
}



/**
 * 「工作台 → 研发 → 代码托管」（2026-10-17）。
 *
 * 用户：我有很多个 git 仓库 —— 所以这里是一张**仓库清单**：
 *   连接 GitHub（fine-grained PAT）→ 从账号里挑仓库接入（克隆到数据目录）→ 数字员工在那个目录里干活。
 * 项目 / 任务卡引用仓库，不把每个仓库硬变成项目。
 *
 * 加仓库只有一个入口：清单标题上的「＋ 添加仓库」→ 选「从 GitHub 添加」或「手动接入」
 * → 各自开弹窗操作（2026-10-17）。
 *
 * 安全：只回显令牌掩码（头 2 + 18 个星号 + 尾 4）；克隆/拉取走请求头带令牌
 * （`.git/config` 里不留带令牌的 URL）。
 */
/* --------------------------------------------- 从 GitHub 挑仓库（放进弹窗里） */
/**
 * 「从 GitHub 添加」：列出**令牌能访问的仓库**，挑一个去接入。
 *
 * 这一段以前是**页面上「从 GitHub 添加」那一整块**（2026-10-17 挪进弹窗的）：
 * 它只在"要加仓库"那一刻才用得上，却常驻在页面底部 —— 平时是噪音，
 * 而且跟上面的「代码仓库」清单是**两处列表**，看着像两个东西。
 * 现在收进「＋ 添加仓库」的菜单里，页面只剩一张清单。
 *
 * `mount` 传进来是给弹窗用的（挂到弹窗的 <form> 里）；传 null 就退回页面上的旧位置。
 *
 * 行是**选中**、不是"点了就接"（2026-10-17 改的）：原来每行一颗「接入」按钮，
 * 点下去立刻开始克隆 —— 在一张几十个仓库的清单里，手一抖点错行就得等它克隆完再删。
 * 现在是"先挑、再确认"：选中哪行，弹窗底部那颗「接入」就作用于哪个。
 */
export async function mountGitAvailPicker(mount, onDone, onSelect = null) {
  const box = mount ?? $('gitAvail');
  if (!box) return;
  box.innerHTML = '<div class="sk-blank">拉取中…</div>';

  let available = [];
  try {
    available = (await api('/api/git/available')).repos ?? [];
  } catch (e) {
    box.innerHTML = `<div class="empty" style="padding:12px 4px">拉不到仓库清单：${esc(e.message)}</div>`;
    return;
  }

  /*
   * `selected` 是**当前选中的仓库全名**（不是按钮）：清单会因为搜索被重绘，
   * 选中态放在 DOM 的 class 上会被 `innerHTML =` 冲掉 —— 存成字符串再拿它重画。
   */
  let selected = null;

  const draw = (q = '') => {
    const kw = q.trim().toLowerCase();
    const list = available.filter((r) => !kw || r.fullName.toLowerCase().includes(kw));
    // 选中的那个被搜没了就别再留着（否则底部按钮会作用在一个看不见的仓库上）
    if (selected && !list.some((r) => r.fullName === selected)) selected = null;
    box.innerHTML = list.length
      ? list
          .map(
            (r) => `<div class="sk-row pickable${r.connected ? ' done' : ''}${
              r.fullName === selected ? ' on' : ''
            }" data-git-pick="${esc(r.fullName)}" role="button" tabindex="0">
              <div class="sk-main">
                <b>${esc(r.fullName)}</b>
                ${r.isPrivate ? '<span class="pill">私有</span>' : ''}
                ${r.canWrite === false ? '<span class="pill" title="能克隆，推代码会被拒（token 没给它写权限）">只读</span>' : '<span class="pill" title="能克隆、也能推代码">可写</span>'}
                ${r.connected ? '<span class="pill" title="已经接进来了 —— 在「代码仓库」清单里">已接入</span>' : ''}
                <div class="sk-desc">${esc(r.description || r.language || '')}</div>
              </div>
            </div>`,
          )
          .join('')
      : '<div class="sk-blank">没有匹配的仓库</div>';

    // 已接入的行不参与选择：再接一次只会得到"这个仓库已经接入了"
    box.querySelectorAll('.sk-row.pickable:not(.done)').forEach((el) => {
      const pick = () => {
        selected = el.dataset.gitPick;
        box.querySelectorAll('.sk-row.on').forEach((x) => x.classList.remove('on'));
        el.classList.add('on');
        onSelect?.(selected);
      };
      el.onclick = (e) => {
        e.preventDefault();
        pick();
      };
      el.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          pick();
        }
      };
    });
    onSelect?.(selected);
  };
  draw();
  // 搜索框是清单的**兄弟**节点（弹窗里、页面上都是），所以从公共父节点上找，别用 $('gitFilter')
  const filter = box.parentElement?.querySelector('#gitFilter');
  if (filter) filter.oninput = () => draw(filter.value);
}



/**
 * 「从 GitHub 添加」这个弹窗。
 *
 * 宽到 560px（默认 480）是因为里面是**一张带徽标和两行说明的清单**，
 * 480 会把 owner/name 挤到换行。
 */
export async function openGitPickDialog(onDone) {
  const dlg = document.createElement('dialog');
  dlg.id = 'gitPickDlg';
  dlg.style.width = '560px';
  dlg.innerHTML = `
    <form method="dialog">
      <b>从 GitHub 添加</b>
      <div class="counter left" style="margin:8px 0 6px">
        这里列的是**令牌能访问的仓库**：公开仓库总是能读；私有仓库要在令牌的
        Repository access 里选中才会出现。标「只读」的能克隆、推代码会被拒（403）。
      </div>
      <input id="gitFilter" placeholder="搜仓库名…（账号下的仓库，按最近更新排）" style="margin:6px 0" />
      <div id="gitAvail" class="git-avail-box"><div class="sk-blank">拉取中…</div></div>
      <div class="dlg-actions">
        <button type="button" value="cancel">取消</button>
        <button class="primary" type="button" id="gitPickOk" disabled>接入</button>
      </div>
    </form>`;
  document.body.append(dlg);
  wireDialogHead(dlg.querySelector('form'));
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();

  /*
   * 从弹窗里接完一个仓库就**把弹窗一起关掉**回到页面看清单 ——
   * 不停在弹窗里：弹窗里那张列表不会自己重绘，留着会显示"还没接入"的旧状态。
   */
  const done = async () => {
    dlg.close();
    await onDone();
  };

  /*
   * 「接入」只在选中了某行时才可点：没选就点，用户不知道自己要接哪个。
   *
   * ⚠️ 这里**不**做"点完置灰、完了再放开"那一套：`openGitAddDialog` 是
   * `showModal()` 完就返回（真正的活在自己那颗按钮里），`await` 等不到结束 ——
   * 那样写会让它刚弹出就把按钮恢复成可点，底下这层还能再被点一次。
   * 所以干脆一层只管一件事：选好 → 开下一层弹窗；这层的事到这儿就完了。
   */
  let picked = null;
  const okBtn = $('gitPickOk');
  okBtn.onclick = (e) => {
    e.preventDefault();
    if (!picked) return;
    openGitAddDialog(picked, done);
  };

  await mountGitAvailPicker(dlg.querySelector('#gitAvail'), done, (fullName) => {
    picked = fullName;
    // 弹窗可能已经关了（接完一个就关）—— 关了就别再去摸按钮
    if (!dlg.isConnected) return;
    okBtn.disabled = !fullName;
    okBtn.textContent = fullName ? `接入 ${fullName}` : '接入';
  });
}



/* 「怎么拿令牌」—— 一段分步骤的说明，就挂在「GitHub 连接」标题旁那颗「?」上。
 *
 * 为什么只在「?」里、不在输入框下面也贴一份（2026-10-17）：原来表单下面确实贴着一份，
 * 但那等于**同一段话在页面上出现两次**（而且连上之后表单没了、只剩「?」，两处还在时才显得多余）。
 * 「?」在**连上与没连上时都在** —— 而"给下一个仓库补授权""令牌 90 天到期要换"
 * 恰恰是**连着的时候**才要照着做，所以放在「?」里是覆盖面更全的那一处。 */
export const GIT_TOKEN_HELP = `
  <div class="gr-help-title">怎么拿令牌</div>
  <ol class="gr-help-steps">
    <li>在 GitHub 建：Settings → Developer settings → Personal access tokens → <b>Fine-grained tokens</b></li>
    <li>权限勾两样 —— <b>两个是独立权限，缺一个就少一块功能</b>：
      <ul class="gr-help-perms">
        <li><b>Contents: Read and write</b><span>克隆、推分支、合并都要它</span></li>
        <li><b>Pull requests: Read and write</b><span>在平台里建 PR 要它</span></li>
      </ul>
      <span class="gr-help-note">只勾 Contents：网页上能手动建 PR，但平台里建会 403；
      只勾 Pull requests：能建 PR 但推不上分支。只想读别人提的 PR（审阅）不勾也能跑。</span>
    </li>
    <li>Repository access：选你要接入的那几个仓库</li>
  </ol>
  <p class="gr-help-foot">令牌只存在本机数据目录，不进日志。
  <a class="help-link" href="https://github.com/settings/personal-access-tokens"
     target="_blank" rel="noreferrer">去 GitHub 建一个 →</a></p>`;



/**
 * 「工作台 → 研发 → 代码托管」整页（2026-10-26 二改）。
 *
 * 为什么要有这个入口函数：这页原来**借设置页的壳**（渲染进 settingsView、走 openSettings('code')），
 * 点工作台磁贴的结果是整页切到「设置」，左栏一列设置分节、当前页在左栏没有对应项 ——
 * 用户看到的第一反应就是"我点错了吗"。现在它跟项目/看板一样是**工作台下的整页**：
 * 左栏收起（整页版式），页头面包屑写「工作台 › 代码托管」。
 */
export async function openCodeRepoPage() {
  setRoute('codeRepos');
  /* 离开设置的分节状态（同 openRemotePage）：不然再点「设置」会被 S.settingsSection 送回这页 */
  S.settingsSection = 'prefs';
  S.plugin = null;          // 离开插件面板（三者共用 #pluginView，位置记忆得分清是谁）
  S.projectList = false;
  S.projectId = null;
  S.boardAll = false;
  showView('plugin');
  /* 主从版式（2026-10-26 三改）：跟「远程连接」同一套 —— 左栏放仓库列表。
     setNav('plugins') 会把 no-list 打开（宫格是整页），这里摘掉，
     列表由 renderGitRepos 画（面包屑、左栏「＋」也在那儿摆）。 */
  document.body.classList.remove('no-list');
  await renderGitRepos($('pluginView'));
}



/**
 * 代码托管页。
 *
 * 2026-10-26 二改：**参数化 root，宿主从设置页换成工作台**。
 * 原来它借设置页的壳（`settingsView`），点工作台的「代码托管」磁贴整页切到「设置」——
 * 左栏变成设置分节列表、当前页在左栏没有对应项，用户看着像"点错了地方"
 * （用户原话："点击远程连接怎么跑到这里来了"，远程连接同病同修）。
 * 现在它是**工作台下的整页**：左栏收起、页头面包屑写「工作台 › 代码托管」。
 * 传入 root 的调用方负责 showView / 左栏，这里只管画。
 */
export async function renderGitRepos(root = $('pluginView')) {
  const view = root;
  view.innerHTML = '<div class="empty" style="padding:24px 4px">取代码托管状态…</div>';

  let st;
  try {
    st = await api('/api/git/status');
  } catch (e) {
    view.innerHTML = `<div class="empty" style="padding:24px 4px">取不到：${esc(e.message)}</div>`;
    return;
  }
  const repos = st.repos ?? [];

  /*
   * 主从版式（2026-10-26 三改，跟「远程连接」同一天定成一套）：
   * 左栏 = 仓库登记表（标准行结构，选中记 `S.gitSel`），右栏 = GitHub 连接 + 选中仓库的详情。
   * 原来的整页表格版（两段白卡 + 横向大表）是借设置页当宿主那阵子的旧观感 ——
   * 跟工作台其它子页（项目 / 远程连接）不是一个版式，5 颗行内按钮挤一列也重。
   * 现在动作收进详情标题行右侧（同 ssh 详情），仓库信息一行一条（.info-row）。
   */
  if (!repos.some((r) => r.id === S.gitSel)) S.gitSel = repos.length ? repos[0].id : null;
  const sel = repos.find((r) => r.id === S.gitSel) ?? null;

  /*
   * GitHub 连接 + 仓库搜索（2026-10-29 六改，用户："固定在底部，这里换成搜索框"）：
   *   · 连接状态按钮从清单顶上挪进**底部固定条 #listFoot** —— 跟消息/工作流的「已归档」
   *     同一个位置语义：低频、跨清单的入口钉在页底永远看得见；
   *   · 原位换成搜索框（全站共用的 #search，S.filter 已由 app.mjs 的输入委托维护），
   *     按仓库名 / 本地路径过滤，只重画行、不动输入框。
   * 注意：renderList 的 plugins 分支对本页整栏让位（见 contacts.mjs）——
   * 不然键入一次 #search，renderList 就把 #listFoot 清一次，按钮闪没。
   */
  const searchBox = $('search').closest('.list-search');
  searchBox?.classList.remove('hidden');
  if (searchBox) $('search').placeholder = '搜仓库名 / 路径';
  // 进页清掉上个栏留下的旧关键词 —— **只在进页那一次**清（S.pluginSearchFor 记着上次画的是谁）：
  // 本函数每次选中仓库 / 刷新状态都会重跑，无条件清的话选个仓库搜索词就没了（原来就是这么丢的）。
  if (S.pluginSearchFor !== 'codeRepos') {
    S.pluginSearchFor = 'codeRepos';
    if (S.filter) { S.filter = ''; $('search').value = ''; }
  }

  const foot = $('listFoot');
  if (foot) {
    foot.innerHTML = `
    <div class="gr-side">
      <button type="button" class="gr-side-btn" id="gitConnOpen"
              title="${st.connected ? 'GitHub 连接设置：令牌、断开' : '连接 GitHub（令牌只存本机）'}">
        <span class="gr-dot${st.connected ? ' ok' : ''}"></span>
        <span class="gr-side-btn-label">${
          st.connected ? `GitHub 已连接${st.login ? ` · @${esc(st.login)}` : ''}` : 'GitHub 未连接 · 点击连接'
        }</span>
      </button>
    </div>`;
    foot.querySelector('#gitConnOpen')?.addEventListener('click', openGitConnDlg);
  }

  // 左栏：面包屑照主从页的规矩画在列表顶上（renderPluginMaster 同款）
  setListTitle([{ label: '工作台', to: 'workbench' }, { label: '代码托管' }]);
  $('listAction').classList.remove('hidden');
  $('listAction').title = '添加仓库';
  const paintRows = () => {
    // 已经切走了就别画（#search 的 oninput 还挂着这一页 —— 不加这道闸，去消息页打字
    // 会把仓库行画进会话列表里）
    if (S.route?.view !== 'codeRepos') return;
    const q = String(S.filter ?? '').trim().toLowerCase();
    const hit = (r) =>
      !q || String(r.fullName).toLowerCase().includes(q) || String(r.localPath ?? '').toLowerCase().includes(q);
    const shown = repos.filter(hit);
    const emptyHTML = repos.length
      ? (q
          ? `<div class="empty" style="padding:32px 12px">没有匹配「${esc(S.filter.trim())}」的仓库</div>`
          : '')
      : '<div class="empty" style="padding:32px 12px">还没有仓库，点左上角「＋」添加</div>';
    $('listBody').innerHTML =
      shown
        .map(
          (r) => `<div class="item${sel && r.id === sel.id ? ' active' : ''}" data-git-sel="${esc(r.id)}">
            <div class="who">
              <div class="line1"><b>${esc(r.fullName)}</b></div>
              <div class="line2" title="${esc(r.localPath)}">${esc(r.localPath)}</div>
            </div>
          </div>`,
        )
        .join('') + emptyHTML;
    $('listBody').querySelectorAll('[data-git-sel]').forEach((el) => {
      el.onclick = () => {
        S.gitSel = el.dataset.gitSel;
        renderGitRepos(root).catch((e) => toast(e.message, 'error'));
      };
    });
  };
  paintRows();
  // 搜索框只重画行（输入框在 listBody 外面，怎么画都不失焦）；S.filter 由 app.mjs 的委托维护，
  // 这里用 oninput 赋值而不是 addEventListener —— renderGitRepos 每次选中仓库都会重跑，别叠监听
  const sb = $('search');
  if (sb) sb.oninput = paintRows;

  const keeperName = (id) => (S.personas ?? []).find((p) => p.id === id)?.name ?? '';
  const syncAt = (t) => (t ? esc(String(t).replace('T', ' ').slice(0, 16)) : '从未');

  /*
   * 选中仓库的详情（2026-10-27 二改：PR 独立成一级区域）。
   * 用户："把 PR 作为一个区域进行展示，然后有那些 PR 待合并；现在有提交和推送，建 PR 或许也不用一个按钮了"。
   * 所以导航条只剩「仓库名 + 分支 pill + 路径 + 齿轮」，动作按状态落在各区域里：
   *   · 提交区：有改动才亮；
   *   · 「拉取请求」区：待合并的 PR 都在这儿（含合并按钮）；当前分支还没 PR 时那儿出现「建 PR」；
   *   · 低频的「从清单移除」收进齿轮弹窗（破坏性动作不放在首屏）。
   */
  const repoDetail = sel
    ? `<div class="plg-detail-head fixed-head">
         <b>${esc(sel.fullName)}</b>${sel.isPrivate ? '<span class="pill">私有</span>' : ''}
         <span class="gr-branch" id="grBranchMount"></span>
         <!-- 本地路径 2026-10-27 应用户要求从导航条摘掉 —— 左栏列表和齿轮弹窗里都还有，不丢信息 -->
         <div class="head-actions">
           <button class="mini gr-set-btn" data-git-settings="${esc(sel.id)}"
                   title="仓库设置：管理员 / 自动合并 / 巡检 / 默认分支 / 上次同步" aria-label="仓库设置">${ICON_GEAR}</button>
         </div>
       </div>
       <div class="plg-sec">
         <div class="plg-sec-head"><label class="plg-sec-title">提交</label><span class="dim" id="grChgHead"></span></div>
         <section class="fx"><div id="grChanges"><div class="sk-blank">读工作区…</div></div></section>
       </div>
       <!--
         推送独立成一块（2026-10-29 三改，用户："推送单独作为一个卡片"）。
         推和交是两件事：未推提交挤在「提交」卡里，会让人以为推送要跟着提交走。
         版式对齐「拉取请求」：动作（推送）钉在分节标题行右侧。
       -->
       <div class="plg-sec">
         <div class="plg-sec-head">
           <label class="plg-sec-title">推送</label><span class="dim" id="grPushHead"></span>
           <button type="button" class="mini auto" id="grPushNow">推送</button>
         </div>
         <section class="fx"><div id="grPush"><div class="sk-blank">读推送状态…</div></div></section>
       </div>
      <div class="plg-sec">
        <div class="plg-sec-head">
          <label class="plg-sec-title">拉取请求</label><span class="dim" id="grPullsHead"></span>
          <button type="button" class="mini auto gr-pulls-refresh" id="grPullsRefresh" title="从 GitHub 重新取一次">刷新</button>
        </div>
        <section class="fx"><div id="grPulls"><div class="sk-blank">取 PR…</div></div></section>
      </div>
      <!--
        PR 列表（2026-10-30 定稿，用户："再加一个通过状态，是不是合并区就可以去掉了"）：
        状态列（未开始/进行中/未通过/已通过）+ 行尾合并按钮 = 一张表说完所有 PR，
        原「审核」「合并」两块不再分家 —— 能不能合看状态、合并按钮自己亮。
      -->
      <div class="plg-sec">
        <div class="plg-sec-head">
          <label class="plg-sec-title">PR 列表</label><span class="dim" id="grReviewHead"></span>
          <button type="button" class="mini auto" id="grReviewRefresh" title="从 GitHub 重新取一次">刷新</button>
        </div>
        <section class="fx"><div id="grReview"><div class="sk-blank">取 PR…</div></div></section>
      </div>
       <div class="plg-sec">
         <div class="plg-sec-head"><label class="plg-sec-title">历史</label></div>
         <section class="fx"><div id="grLog"><div class="sk-blank">读提交记录…</div></div></section>
       </div>`
    : `<div class="wip">${
        repos.length
          ? '左边选一个仓库'
          : '还没有仓库。点左上角「＋」添加：连了 GitHub 就从账号里挑，没连就手动接一个本地已有的克隆。'
      }</div>`;

  view.innerHTML = `<div class="detail-body"><div class="plg-detail">${repoDetail}</div></div>`;

  const refresh = () => renderGitRepos(root);   // 重画回**同一个宿主**（设置页 / 工作台各画各的）

  /*
   * GitHub 连接弹窗（2026-10-26 五改）：连接相关的所有东西都收进来 —— 令牌表单 /
   * 掩码 + 状态 + 断开、「?」帮助、whoami 补字。左栏只剩那颗状态按钮。
   * 动态建 dialog（machine.mjs openAddHostDlg 同款）：建完 wireDialogHead 包吸顶头，
   * close 即 remove —— 控件 id 每开一次都是新的，不存在重画冲绑定的老问题。
   * whoami 仍然**开了弹窗再问**：不挡渲染，回来只补「@login」一小段。
   */
  function openGitConnDlg() {
    const dlg = document.createElement('dialog');
    dlg.className = 'gr-conn-dlg';
    const form = document.createElement('form');
    form.method = 'dialog';
    form.innerHTML = `
      <b>GitHub 连接</b>
      <div class="gr-dlg-body">
        ${
          st.connected
            ? `<div class="gr-dlg-row">
                 <span class="row-label">令牌</span>
                 <input class="locked" value="${esc(st.hint || '******')}" readonly
                        aria-label="已保存的令牌，只显示头 2 位和尾 4 位" />
                 <button type="button" class="mini auto" id="gitDisconnect"
                         title="断开 GitHub（已接入的仓库记录和本地克隆都保留）">断开连接</button>
               </div>
               <div class="gr-dlg-row">
                 <span class="row-label gr-dlg-pad" aria-hidden="true">令牌</span>
                 <span class="gr-dlg-status"><b style="color:var(--ok)">已连接</b><span id="gitWho">${
                   st.login ? ` —— @${esc(st.login)}` : ''
                 }</span></span>
               </div>`
            : `<div class="gr-dlg-row">
                 <span class="row-label">令牌</span>
                 <input id="gitToken" type="password" placeholder="粘贴 fine-grained PAT" autocomplete="off" />
                 <button type="button" class="primary" id="gitConnect">连接 GitHub</button>
               </div>`
        }
        ${/* 怎么拿令牌直接铺开（2026-10-26 六改，用户："把怎么拿令牌显示出来"），不再藏帮助按钮里 */ ''}
        <div class="gr-dlg-help">${GIT_TOKEN_HELP}</div>
      </div>`;
    dlg.append(form);
    document.body.append(dlg);
    wireDialogHead(form); // 动态建的弹窗自己包一次吸顶头（标题 + ×）
    dlg.addEventListener('close', () => dlg.remove());

    if (st.connected) {
      api('/api/git/whoami')
        .then((w) => {
          const el = form.querySelector('#gitWho');
          if (!el) return;
          if (w?.login) el.textContent = ` —— @${w.login}`;
          else if (w?.error) el.textContent = ' · 连接状态没验上（网络没通）';
        })
        .catch(() => {
          const el = form.querySelector('#gitWho');
          if (el) el.textContent = ' · 连接状态没验上（网络没通）';
        });
    }

    form.querySelector('#gitConnect')?.addEventListener('click', async () => {
      const token = form.querySelector('#gitToken').value.trim();
      if (!token) return toast('先把令牌粘进来');
      const btn = form.querySelector('#gitConnect');
      btn.disabled = true;
      btn.textContent = '验证中…';
      try {
        const r = await api('/api/git/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        toast(`已连接：@${r.login}`);
        dlg.close();
        await refresh();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = '连接 GitHub';
        toast(err.message, 'error');
      }
    });
    form.querySelector('#gitDisconnect')?.addEventListener('click', async () => {
      if (!(await confirmDo('断开 GitHub？已接入的仓库记录和本地克隆都保留。'))) return;
      try {
        await api('/api/git/token', { method: 'DELETE' });
        dlg.close();
        await refresh();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    dlg.showModal();
  }

  /*
   * 「添加仓库」：入口在**左栏顶上的「＋」**（主从页的规矩，同 renderPluginMaster 的
   * add 表单）。一个入口两条路：点＋ → 选「手动接入」或「从 GitHub 添加」→ 各自开弹窗。
   * 点击处理在 app.mjs 的 listAction 全局分发里（按 S.route?.view === 'codeRepos' 认）——
   * 不能绑在页面元素上：页面重画会把它冲掉，而全局那颗「＋」一直在左栏。
   */

  /*
   * 值班设置：**改了就存**，不弹确认（可逆、影响面单仓库）。
   * 存失败才整页重绘 —— 成功时重绘会把刚选的项闪一下，人以为没存上。
   */
  const saveRepoSettings = async (id, patch) => {
    try {
      await post(`/api/git/repos/${encodeURIComponent(id)}/settings`, patch);
      toast('已保存');
    } catch (err) {
      toast(err.message, 'error');
      await refresh(); // 失败要把界面拉回真实值，别让假状态留在屏幕上
    }
  };
  /*
   * 仓库设置弹窗（2026-10-27，用户："仓库设置区太占地方 → 右上角设置按钮，点开展示"）：
   * 原来占详情一整块卡的信息（管理员 / 自动合并 / 默认分支 / 上次同步 / 本地目录）收进这里。
   * 动态建 dialog（openGitConnDlg 同款），close 即 remove；改动即时保存、弹窗不关。
   *
   * 2026-10-29：**巡检节拍也收进来了**（用户："这个功能放到代码托管是不是更好"）。
   * 它背后仍是「定时任务」里一条 `pr-scan`（`config.repo` = 这个仓库），不是第二套调度 ——
   * 仓库行只负责"选一个预设 + 看上次结果 + 现在跑一次"这三件窄事，
   * 「每周 / 每月 / 单次」那些完整表单仍去「定时任务」页（那边会把它标成「随仓库」）。
   */
  const paintKeeperBtns = (repoId, kid) => {
    document.querySelectorAll('.gr-keeper-btn[data-k-cur]').forEach((b) => {
      b.dataset.kCur = kid ?? '';
      b.innerHTML = kid ? esc(keeperName(kid) || '未设置') : '<span class="dim">未设置</span>';
    });
    const repo = repos.find((r) => r.id === repoId);
    if (repo) repo.keeperPersonaId = kid || null;
  };
  const patrolPresets = () => (st.patrolPresets?.length ? st.patrolPresets : [{ id: 'off', label: '关闭' }]);
  const patrolLastText = (p) => {
    if (!p?.jobId) return '还没配节拍 —— 也可以先点「立即巡检」跑一次';
    if (!p.lastStatus) return '还没跑过';
    const body = p.lastStatus === 'ok' ? `✓ ${p.lastSummary || '完成'}` : `✗ ${p.lastError || '失败了（没有原因）'}`;
    const when = p.lastRunAt ? String(p.lastRunAt).replace('T', ' ').slice(0, 16) : '';
    return when ? `${when} · ${body}` : body;
  };
  const paintPatrolLast = (repo) => {
    const el = $('grPatrolLast');
    if (!el) return;
    const text = patrolLastText(repo.patrol);
    el.textContent = text;
    el.title = text;
  };
  const openGitSettingsDlg = (repo) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'gr-set-dlg';
    const form = document.createElement('form');
    form.method = 'dialog';
    const p = repo.patrol ?? { preset: 'off' };
    /*
     * 巡检节拍用全站 `.combo`（2026-10-29 用户："巡检使用公共组件"）。
     * 原生 <select> 的弹出层是浏览器画的 —— 高度、配色、圆角跟站内其它下拉是两套东西。
     * 「自定义（每周一）」不是**可选**的档：它只用来照实显示现状（人手工建过），选它等于什么都没做。
     */
    const patrolItems = patrolPresets().map((x) => ({ id: x.id, label: x.label }));
    if (p.preset === 'custom') patrolItems.push({ id: 'custom', label: `自定义（${p.text || '当前节拍'}）` });
    form.innerHTML = `
      <b>仓库设置</b>
      <div class="gr-dlg-body gr-set-body">
        <div class="info-row"><span>管理员</span><b>
          <button type="button" class="gr-keeper-btn" data-k-cur="${esc(repo.keeperPersonaId ?? '')}"
                  title="别人提了 PR，替你审的那个人。点击选择">${
                    repo.keeperPersonaId ? esc(keeperName(repo.keeperPersonaId) || '未设置') : '<span class="dim">未设置</span>'
                  }</button>
        </b></div>
        <div class="info-row"><span>自动合并</span><b>
          <label class="switch sm" title="开：审阅通过且闸门全过的 PR 自动合并；关：停在「待验收」等你点">
            <input type="checkbox" data-automerge ${repo.autoMerge ? 'checked' : ''} aria-label="自动合并" /><span></span>
          </label>
        </b></div>
        <div class="info-row"><span>巡检</span><b class="gr-patrol-cell">
          <div class="gr-patrol-combo" id="grPatrolSel"
               title="到点自动拉这个仓库的 open PR / issue，写成看板上的值班卡"></div>
        </b></div>
        <div class="info-row"><span>上次巡检</span><b id="grPatrolLast" class="gr-patrol-last"></b></div>
        <div class="info-row"><span>默认分支</span><b>${esc(repo.defaultBranch || '—')}</b></div>
        <div class="info-row"><span>上次同步</span><b>${syncAt(repo.lastSyncAt)}</b></div>
        <div class="info-row"><span>本地目录</span><b class="gr-set-path" title="${esc(repo.localPath)}">${esc(repo.localPath)}</b></div>
      </div>
      <div class="dlg-actions">
        <button type="button" class="mini auto" id="grPatrolRun"
                title="现在就跑一次这个仓库的巡检（开没开节拍都能跑）">立即巡检</button>
        <button type="button" class="mini auto gr-set-remove" id="grSetRemove"
                title="只移除记录，本地目录保留（低频、破坏性动作，收在设置里）">从清单移除…</button>
      </div>`;
    dlg.append(form);
    document.body.append(dlg);
    wireDialogHead(form);
    dlg.addEventListener('close', () => dlg.remove());
    paintPatrolLast(repo);

    form.querySelector('.gr-keeper-btn').onclick = (e) => openKeeperDlg(repo.id, e.currentTarget.dataset.kCur ?? '');
    form.querySelector('[data-automerge]').onchange = (e) => {
      repo.autoMerge = e.currentTarget.checked ? 1 : 0;
      saveRepoSettings(repo.id, { autoMerge: e.currentTarget.checked });
    };
    const patrolMount = form.querySelector('#grPatrolSel');
    let patrolSaving = false;
    const patrolCombo = createCombo({
      mount: patrolMount,
      items: patrolItems,
      value: p.preset ?? 'off',
      onChange: async (preset) => {
        if (preset === 'custom' || patrolSaving) return; // 「自定义」只是现状展示，不是可选的档
        patrolSaving = true;
        patrolMount.classList.add('is-saving');
        try {
          const r = await post(`/api/git/repos/${encodeURIComponent(repo.id)}/patrol`, { preset });
          repo.patrol = r.patrol;
          // 存成预设之后，「自定义（…）」那条不再代表现状 —— 摘掉，免得还能选回一个不存在的档
          patrolCombo.setItems(patrolItems.filter((x) => x.id !== 'custom'));
          patrolCombo.setValue(r.patrol?.preset ?? preset);
          toast('已保存');
          paintPatrolLast(repo);
          await refresh(); // 页面上的状态跟着库走（弹窗挂在 body 上，不受重画影响）
        } catch (err) {
          toast(err.message, 'error');
          // 存失败要把按钮拉回真实值：combo 是"先画选中、再回调"的，不拉回来屏幕上就挂着一条假节拍
          patrolCombo.setValue(repo.patrol?.preset ?? 'off');
          await refresh();
        } finally {
          patrolSaving = false;
          patrolMount.classList.remove('is-saving');
        }
      },
    });
    form.querySelector('#grPatrolRun').onclick = async (e) => {
      const btn = e.currentTarget;
      if (btn.disabled) return;
      btn.disabled = true;
      btn.classList.add('busy');
      try {
        const r = await post(`/api/git/repos/${encodeURIComponent(repo.id)}/patrol/run`, {});
        toast(r.ok ? `巡检跑完了：${r.summary ?? '完成'}` : `这次没跑成：${r.error ?? '没有原因'}`);
        // 上一次结果记在对应任务上：重新取一次，弹窗里那行才不是旧的
        const st2 = await api('/api/git/status');
        const fresh = (st2.repos ?? []).find((x) => x.id === repo.id);
        if (fresh) repo.patrol = fresh.patrol;
        paintPatrolLast(repo);
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.classList.remove('busy');
      }
    };
    // 移除入口（2026-10-27 从导航条搬进来）：确认后只删记录，本地克隆目录不动
    form.querySelector('#grSetRemove').onclick = async () => {
      if (!(await confirmDo('从清单移除这个仓库？（只删记录，本地克隆目录保留，里面可能有你没推的东西）'))) return;
      try {
        const r = await api(`/api/git/repos/${encodeURIComponent(repo.id)}`, { method: 'DELETE' });
        dlg.close();
        toast(`已移除。本地目录还在：${r.keptPath}`);
        await refresh();
      } catch (e) {
        toast(e.message, 'error');
      }
    };
    dlg.showModal();
  };
  view.querySelectorAll('[data-git-settings]').forEach((el) => {
    el.onclick = (e) => {
      e.preventDefault();
      const repo = repos.find((r) => r.id === el.dataset.gitSettings);
      if (repo) openGitSettingsDlg(repo);
    };
  });

  /*
   * 管理员弹窗（keeperDlg，2026-10-23）：搜索过滤、**点哪行选哪行、选完即关**——
   * 没有确认按钮，选错再点一次就行，比「选中 + 确定」少一步。
   * 「不值班（不审阅）」只在没搜索时出现在首行（它是清空入口，不是搜索结果）。
   */
  let keeperRepoId = null;
  let keeperCur = '';
  const renderKeeperList = () => {
    const q = ($('kSearch').value || '').trim().toLowerCase();
    const rows = (S.personas ?? []).filter((p) => !q || p.name.toLowerCase().includes(q));
    const row = (kid, name, em, picked) => `
      <button type="button" class="k-row${picked ? ' on' : ''}" data-kid="${esc(kid)}">
        <span>${esc(name)}</span>${em ? `<em>${esc(em)}</em>` : ''}${picked ? '<span class="k-ok">✓</span>' : ''}
      </button>`;
    $('kList').innerHTML = [
      q ? '' : row('', '不值班（不审阅）', '', !keeperCur),
      ...rows.map((p) => row(p.id, p.name, `${p.runtime ?? ''}${p.sandbox ? ` · ${p.sandbox}` : ''}`, keeperCur === p.id)),
    ].filter(Boolean).join('') || '<div class="dim" style="padding:10px 2px">没找到</div>';
    $('kList').querySelectorAll('.k-row').forEach((b) => {
      b.onclick = async () => {
        $('keeperDlg').close();
        if (b.dataset.kid !== keeperCur) {
          keeperCur = b.dataset.kid;
          // 设置弹窗还开着的话就地改标签（refresh 只重画页面，弹窗是挂在 body 上的）
          paintKeeperBtns(keeperRepoId, keeperCur);
          await saveRepoSettings(keeperRepoId, { keeperPersonaId: b.dataset.kid });
          await refresh();
        }
      };
    });
  };
  const openKeeperDlg = (repoId, curId) => {
    keeperRepoId = repoId;
    keeperCur = curId ?? '';
    $('kSearch').value = '';
    renderKeeperList();
    $('kSearch').oninput = renderKeeperList;
    $('keeperDlg').showModal();
  };
  // 页面里的入口没了（2026-10-27 收进齿轮弹窗），弹窗自己绑 —— 这里只留一个兜底，
  // 万一以后又往页面上放 keeper 按钮，照旧能用。
  view.querySelectorAll('[data-git-keeper-pick]').forEach((el) => {
    el.onclick = () => openKeeperDlg(el.dataset.gitKeeperPick, el.dataset.kCur ?? '');
  });

  /*
   * IDE 式一站式（2026-10-27）：分支 pill +「改动」卡 +「拉取请求」区 +「历史」卡。
   * 前三块里 改动/历史 吃的全是**本地 git**（/changes /branches /log /diff 不联网），点下去就该有反应；
   * PR 区要连 GitHub，单独异步拉，谁先回来谁先补上。异步回来时页面可能已经切走或重画 ——
   * 一律先看节点还连不连着 DOM（建 PR 弹窗 paintState 同款防抖）。
   */
  if (sel) {
    fillChanges(sel);
    fillPulls(sel);
    fillLog(sel);
    // PR 区右上那颗「刷新」：只重取 PR（合并/建 PR 之外，比如在 GitHub 上手动关了 PR 时用）
    $('grPullsRefresh')?.addEventListener('click', () => {
      fillPulls(sel).catch((e) => toast(e.message, 'error'));
    });
    $('grReviewRefresh')?.addEventListener('click', () => {
      fillPulls(sel).catch((e) => toast(e.message, 'error'));
    });
  }

  /* ---------------------------------------------------------------- 拉取请求区（2026-10-27） */

  /**
   * PR 区：待合并的 PR 都摆在这儿，合并按钮跟着行走。
   *
   * 为什么从"弹窗下半屏"搬出来（用户："把 PR 作为一个区域进行展示，然后有那些 PR 待合并"）：
   * 人关心的是"我的改动进 main 了没"，这件事不该藏在点开「建 PR」之后才看得见；
   * 而且建与合本来就该在同一张清单上 —— 建完立刻在下面出现，合完立刻消失。
   *
   * 行上的三个状态各有来源：
   *   · 草稿 / 冲突 / 落后 base → GitHub 的 `draft` / `mergeable` / `mergeable_state`；
   *   · gate → 服务端按 headSha 查 check-runs 归约成的 `checks.state`（main 有分支保护，不绿合不了）；
   *   · 关联任务卡 → taskId（建 PR 那条链会回写）。
   */
  async function fillPulls(repo) {
    const box = $('grPulls');
    const reviewBox = $('grReview');
    const head = $('grPullsHead');
    const reviewHead = $('grReviewHead');
    if (!box) return;
    let prs = [];
    let state = null;
    try {
      const d = await api(`/api/git/repos/${encodeURIComponent(repo.id)}/prs`);
      prs = d.prs ?? [];
    } catch (e) {
      const msg = `<div class="sk-blank">取不到 PR：${esc(e.message)}</div>`;
      if (box.isConnected) box.innerHTML = msg;
      if (reviewBox?.isConnected) reviewBox.innerHTML = msg;
      return;
    }
    try {
      state = (await api(`/api/git/repos/${encodeURIComponent(repo.id)}/changes`)).state;
    } catch {
      /* 读不到本地状态就不画 CTA，PR 列表照常显示 */
    }
    if (!box.isConnected) return;

    const base = state?.base || repo.defaultBranch || 'main';
    const cur = state?.branch || '';
    const mine = prs.find((p) => p.headRef && p.headRef === cur);

    /*
     * gate 一句话（2026-10-30 用户："检查改成状态。有未开始、进行中、未通过"）：
     * 未通过时操作区多一颗「处理」—— 点开就是建卡修复弹窗（选人 → 确定），见 openGateDlg。
     */
    const checkPill = (p) => {
      const c = p.checks;
      const s = c?.state;
      /*
       * 有冲突优先说（2026-10-30 用户看着 PR #49 的 GitHub 页问"卡住了吗"）：
       * 分支和 base 有冲突时 GitHub **根本不启动**必需检查 —— 那两条 gate 会一直挂在
       * "进行中/未开始"，看着像跑不动。这里直说"有冲突"，别让人误以为在等检查。
       */
      if (p.mergeable === false || p.mergeableState === 'dirty') {
        return '<span class="gr-pr-check bad" title="这条分支和 base 有冲突 —— GitHub 不会启动必需检查，先把 base 合进分支、解掉冲突再推">有冲突</span>';
      }
      if (s === 'success') return '<span class="gr-pr-check ok" title="检查全绿">已通过</span>';
      if (s === 'failure') return '<span class="gr-pr-check bad" title="自动检查没过 —— 操作区那颗「处理」可以建卡去修">未通过</span>';
      if (s === 'pending') return '<span class="gr-pr-check wait" title="还在跑">进行中</span>';
      /*
       * `none` = 这条 head 上**还没有任何检查结果**（刚建 PR、workflow 还没起，或仓库没配 CI）。
       * 不能当"可以合"：main 有分支保护，没检查一样会被 GitHub 拒 —— 见 blockReason。
       */
      if (s === 'none') return '<span class="gr-pr-check none" title="这条提交上还没有检查结果 —— 刚建的 PR 等 gate 起来">未开始</span>';
      return `<button type="button" class="gr-pr-check none" data-pr-gate="${p.number}"
                title="没查到检查状态（网络/权限）—— 点开看明细">未知</button>`;
    };
    /* 合并为什么按不了：返回 null = 能合 */
    const blockReason = (p) => {
      if (p.draft) return '草稿不能合 —— 先去 GitHub 上标为可审阅';
      if (p.mergeable === false || p.mergeableState === 'dirty') return '有冲突，合不了 —— 先把 base 合进分支或在本地解决';
      if (p.mergeableState === 'behind') return '分支落后 base —— 先合并 base 再合（或等 GitHub 自动更新）';
      if (p.mergeableState === 'blocked') return '被分支保护规则挡着';
      if (p.checks?.state === 'pending') return '检查还在跑，等 gate 绿了再合';
      if (p.checks?.state === 'failure') return '检查没过（gate 红了），合并会被 GitHub 拒绝';
      /*
       * 2026-10-30 用户实报（#48 刚建完就出现在「合并」区）：`none` 不是"能合"，是"检查还没起来"。
       * 刚建的 PR 会先落在这一档（gate 起跑前有几秒到几十秒），归进「审核」等它；
       * 没配 CI 的仓库同理 —— 那本来就该去 GitHub 上看着合，不该在「可以合」里假装就绪。
       */
      if (p.checks?.state === 'none') return '这条提交上还没有检查结果 —— 等 gate 起来（刚建的 PR 一般几十秒）';
      if (p.checks?.state === 'unknown') return null; // 没拿到检查状态不拦 —— 由 GitHub 自己判，失败原话带回
      return null;
    };

    /*
     * PR 清单用**表格**（2026-10-30 用户："做成表格的方式，人多了会有很多个 PR"）。
     * 一行一条、五列（PR / 分支 / 作者 / 检查 / 合并），表头吸顶、条数多了表内滚动 ——
     * 不再一条一张卡把页面撑得老长；列宽固定，扫一眼就能对齐着比。
     */
    const rowHtml = (p) => {
      const why = blockReason(p);
      const isMine = p.headRef && p.headRef === cur;
      return `<div class="gr-pr-tr">
          <div class="gr-pr-c1">
            <div class="gr-pr-title"><b>#${p.number}</b> <a class="gr-pr-title-link" href="${esc(p.url)}"
                  target="_blank" rel="noreferrer" title="在 GitHub 上打开这个 PR">${esc(p.title)}</a>
              ${p.draft ? '<span class="pill">草稿</span>' : ''}
              ${isMine ? '<span class="pill">当前分支</span>' : ''}
              ${/* 已关联卡 = 能点的（2026-10-29 用户："既然关联了任务卡，要能跳转过去"）*/ ''}
              ${p.taskId ? `<button type="button" class="pill gr-pr-task" data-pr-task="${esc(p.taskId)}"
                    title="打开关联的任务卡">已关联卡</button>` : ''}
              ${p.mergeableState === 'dirty' ? '<span class="pill bad">有冲突</span>' : ''}
            </div>
          </div>
          <div class="gr-pr-refs">${esc(p.headRef || '?')} → ${esc(p.baseRef || '?')}</div>
          <div class="gr-pr-who">${esc(p.author || '?')}</div>
          <div class="gr-pr-c4">${checkPill(p)}</div>
          <div class="gr-pr-c5">
            <!-- 合并按钮钉在最后一列（2026-10-29 用户："按钮放右边"）；
                 检查未通过时左边多一颗「处理」（2026-10-30 用户："加一个处理按钮，点击建卡修复"）——
                 走同一个 data-pr-gate：点开建卡弹窗（选处理人 → 确定建卡） -->
            ${p.checks?.state === 'failure'
              ? `<button type="button" class="mini auto" data-pr-gate="${p.number}" title="检查没过 —— 选个处理人，建一张任务卡去修">处理</button>`
              : ''}
            <button type="button" class="mini auto" data-pr-merge="${p.number}"
                    ${why ? `disabled title="${esc(why)}"` : 'title="合并进 base（走平台令牌；本地会自动收尾）"'}>合并</button>
          </div>
        </div>`;
    };
    const tableHead = `<div class="gr-pr-tr gr-pr-th">
        <span>PR</span><span>分支</span><span>作者</span><span>状态</span><span>操作</span>
      </div>`;

    /*
     * 2026-10-30 定稿（用户："再加一个通过状态，是不是合并区就可以去掉了"）：
     * 不再按"能不能合"分卡 —— 状态列自己会说（未开始/进行中/未通过/已通过），
     * 合并按钮在能合的行上自己亮。原「审核」「合并」两块合成一张「PR 列表」表。
     */
    const groupHtml = (title, inner, count) =>
      count
        ? `<div class="gr-pr-group">
        <div class="gr-pr-group-head">${esc(title)}<span class="gr-pr-group-count">${count}</span></div>
        ${inner}
      </div>`
        : '';

    /*
     * 当前分支还没有 PR 时给一行 CTA：这是「建 PR」按钮的新家（导航条那颗去掉了）。
     *
     * 门槛只有一条（2026-10-29 用户："提交和建 PR 一起，说不清也不好控制"）：**有领先 base 的提交**。
     * 建 PR 只推已提交的东西，不再顺手提交脏文件 —— 提交是「提交」那一栏的事。
     * 所以：有提交 → 给按钮（脏文件只是明说"不会进这条 PR"）；没提交只有脏文件 → 引导先提交。
     */
    let cta = '';
    if (!mine) {
      if (cur && cur !== base) {
        const ahead = state?.ahead;
        if ((ahead ?? 0) > 0) {
          /*
           * 没推送时不给按钮（2026-10-30 用户："还没有推送，要这个建PR按钮干啥？"）——
           * 建出来也是被服务端"先推送"顶回来，白点一下。推送是「推送」卡的事，推完这里再亮。
           * 文案只说一件事（2026-10-30 用户："去掉这两条，没有啥用"）：去推送，推完能建。
           */
          const unpushed = Number(state?.unpushed ?? 0);
          if (unpushed > 0 || !state?.upstream) {
            cta = `<div class="gr-pr-cta">当前分支 <b>${esc(cur)}</b> 还没有 PR —— 先去上面「推送」卡推送，推完这里就能建 PR。</div>`;
          } else {
            const n = ahead === null ? '' : `（领先 ${esc(base)} ${ahead} 个提交）`;
            const extra = state?.dirtyCount
              ? `；未提交的 ${state.dirtyCount} 个改动不会进这条 PR`
              : '';
            cta = `<div class="gr-pr-cta">
              <span>当前分支 <b>${esc(cur)}</b> 还没有 PR ${n}${extra}</span>
              <button type="button" class="mini auto" id="grPrCreate">建 PR</button>
            </div>`;
          }
        } else if (state?.dirtyCount) {
          cta = `<div class="gr-pr-cta">当前分支 <b>${esc(cur)}</b> 有 ${state.dirtyCount} 个未提交改动 —— 先在「提交」里提交，提交完这里就能建 PR。</div>`;
        } else {
          cta = `<div class="gr-pr-cta dim">当前分支 <b>${esc(cur)}</b> 和 base（${esc(base)}）没有差异 —— 没有可建的 PR。</div>`;
        }
      } else if (cur === base && (state?.ahead ?? 0) > 0) {
        /*
         * 人在 base 上提交了但推不上去（2026-10-29 用户实报："手动提交了但不能推送，没看到建 PR 的按钮"）：
         * 后端接得住 —— 建 PR 会从当前 HEAD 拉一条新分支推上去（base 不动）。
         * 只在 base 上「有脏改动、没提交」时不给按钮：PR 里没东西可装，先去「提交」。
         */
        const extra = state?.dirtyCount ? `；未提交的 ${state.dirtyCount} 个改动不会进这条 PR` : '';
        cta = `<div class="gr-pr-cta">
            <span>当前就在 base（<b>${esc(base)}</b>）上，有 ${state.ahead} 个已提交还没推上去${extra} —— 直接推主干多半会被保护拒收，建 PR 会从当前 HEAD 拉一条新分支推上去</span>
            <button type="button" class="mini auto" id="grPrCreate">建 PR</button>
          </div>`;
      } else if (cur === base && state?.dirtyCount) {
        cta = `<div class="gr-pr-cta">当前就在 base（<b>${esc(base)}</b>）上，有 ${state.dirtyCount} 个未提交改动 —— 先在「提交」里提交，提交完这里就能建 PR。</div>`;
      }
    }

    const ctaGroup = cta ? groupHtml('待建 PR', cta, 1) : '';
    /* PR 列表套上表头；空态给一句话（不再是"一个 PR 一张卡"） */
    const listHtml = (prsIn, emptyText) =>
      prsIn.length
        ? `<div class="gr-pr-table">${tableHead}${prsIn.map(rowHtml).join('')}</div>`
        : `<div class="sk-blank">${emptyText}</div>`;
    if (head?.isConnected) head.textContent = prs.length ? `${prs.length} 条 PR` : '';
    if (reviewHead?.isConnected) reviewHead.textContent = prs.length ? `${prs.length} 条 PR` : '暂无';

    /* 两张卡各管一段：拉取请求 = 待建 CTA；PR 列表 = 全部 PR（能不能合看状态列 + 合并按钮） */
    box.innerHTML =
      ctaGroup ||
      `<div class="sk-blank">${prs.length ? '当前分支没有待建的 PR —— 有新提交时这里会出现「建 PR」' : '没有进行中的 PR —— 建 PR 后会出现在这里'}</div>`;
    if (reviewBox?.isConnected) {
      reviewBox.innerHTML = listHtml(prs, '还没有 PR —— 在「拉取请求」卡建第一个 PR');
    }

    /*
     * 绑定：「刷新」重取一次；行上的动作（建 PR / gate 明细 / 合并）在两块卡里都有，
     * 用同一个 scope 列表跑一遍 —— 漏绑就是"点了没反应"。
     */
    $('grPrCreate')?.addEventListener('click', () => openRepoPrDialog(repo, refresh));
    const scopes = [box, reviewBox].filter((el) => el?.isConnected);
    scopes.forEach((scope) => {
      scope.querySelectorAll('[data-pr-gate]').forEach((b) => {
        b.onclick = () => {
          const one = prs.find((x) => x.number === Number(b.dataset.prGate));
          if (one) openGateDlg(repo, one);
        };
      });
      // 「已关联卡」：就手看一眼 → 开弹窗（人本来在代码托管页，整页跳走反而丢位置）
      scope.querySelectorAll('[data-pr-task]').forEach((b) => {
        b.onclick = () => openTaskCardDialog(b.dataset.prTask).catch((e) => toast(e.message, 'error'));
      });
    });
    scopes.forEach((scope) => scope.querySelectorAll('[data-pr-merge]').forEach((b) => {
      b.onclick = async () => {
        const n = Number(b.dataset.prMerge);
        const one = prs.find((x) => x.number === n);
        const why = one ? blockReason(one) : null;
        if (why) return toast(why, 'error');
        /*
         * 「合完删源分支」做成一个勾，不默认勾上：分支是别人可能还在用的东西。
         * 服务端只删 `bandi/` 开头的 —— 勾上也不会误删人自己开的分支。
         */
        const ask = await askCheckbox({
          title: `合并 PR #${n}？`,
          body: `${one?.title ?? ''}\n\n这一步会在 GitHub 上真的合进去，合完不能撤销。`,
          check: { label: '合完删掉源分支（只删平台建的 bandi/ 分支，别的删不动）', checked: false },
          ok: '合并',
        });
        if (!ask.ok) return;
        b.disabled = true;
        b.textContent = '合并中…';
        try {
          const r = await post(`/api/git/repos/${encodeURIComponent(repo.id)}/prs/${n}/merge`, {
            method: 'merge',
            deleteBranch: ask.checked,
          });
          toast(r.merged ? `PR #${n} 已合并${r.branchDeleted ? `，源分支 ${r.branchDeleted} 也删了` : ''}${r.note ? `\n${r.note}` : ''}` : r.note ?? '没合');
          // 合并会触发本地收尾（切回 base、删本地分支），整页重画才跟得上
          await refresh();
        } catch (e) {
          b.disabled = false;
          b.textContent = '合并';
          toast(e.message, 'error');
        }
      };
    }));
  }

  /* ---------------- 检查没过 → 选处理人，建任务卡去修 ----------------
   *
   * 2026-10-29 一路收敛到这一版（用户三次原话）：
   *   "作为用户，代码不是我写的……我只要一个按钮，点了 agent 帮我去修"；
   *   "这些去掉，这些都不是我关心的。这里放一个处理人，选择之后点击确定，就开始修复"；
   *   "这一步是建任务卡修复"。
   * 所以弹窗只剩三样：**结果标题、处理人下拉、确定**。
   * 技术细节（runs / job / step）、修复指引、重跑按钮全部撤掉 —— 那些是工程师看的，
   * 真要查去 GitHub 更快。确定 = 服务端建一张任务卡派给这个人（卡在看板上可追、可改人、留痕）。
   */
  function openGateDlg(repo, pr) {
    document.getElementById('repoGateDlg')?.close();
    const dlg = document.createElement('dialog');
    dlg.id = 'repoGateDlg';
    dlg.className = 'gr-gate-dlg';

    /* 处理人排序：研发 → 测试 → 运维 → 其它，能修代码的排最上面（默认就选它） */
    const rank = (role) => {
      const s = String(role ?? '');
      return s.startsWith('研发') ? 0 : s.startsWith('测试') ? 1 : s.startsWith('运维') ? 2 : 3;
    };
    const people = [...(S.personas ?? [])].sort((a, b) => rank(a.role) - rank(b.role));
    const opts = people
      .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}${p.role ? ` · ${esc(String(p.role).split(' · ')[0])}` : ''}</option>`)
      .join('');

    dlg.innerHTML = `
      <form method="dialog">
        <b>检查没过 · #${pr.number}</b>
        <div class="gr-meta gr-gate-refs">${esc(pr.headRef ?? '?')} → ${esc(pr.baseRef ?? '?')}</div>
        <div id="gateBody">
          <label class="gr-gate-pick-label" for="gateWho">处理人</label>
          <select id="gateWho" ${people.length ? '' : 'disabled'}>${opts || '<option>还没有员工</option>'}</select>
          <div class="gr-gate-hint">确定后建一张任务卡交给他（只建卡、不开对话）；修好会把改动推上去，检查自动重跑。</div>
        </div>
        <div class="dlg-actions">
          <button type="button" value="cancel">关闭</button>
          <button class="primary" id="gateGo" ${people.length ? '' : 'disabled'}>确定</button>
        </div>
      </form>`;
    document.body.append(dlg);
    wireDialogHead(dlg.querySelector('form'));
    dlg.addEventListener('close', () => dlg.remove());
    dlg.showModal();

    const body = $('gateBody');
    const go = $('gateGo');
    let handoff = null;

    /** 「去看卡片」：跳到那个项目的看板 —— 卡在那儿，开不开工看板上说了算（2026-10-29 用户定稿：不开对话） */
    const goWatch = () => {
      if (!handoff?.projectId) return;
      dlg.close();
      openProjectDetail(handoff.projectId).catch((err) => toast(err.message, 'error'));
    };

    go?.addEventListener('click', async (e) => {
      e.preventDefault();
      if (handoff) return goWatch();   // 已经建完了，这颗钮改叫「去看进展」
      const personaId = $('gateWho')?.value ?? null;
      go.disabled = true;
      go.textContent = '建卡中…';
      try {
        handoff = await post(`/api/git/repos/${encodeURIComponent(repo.id)}/prs/${pr.number}/fix`, { personaId });
        if (body?.isConnected) {
          body.innerHTML = `<div class="gr-gate-done">任务卡已建：<b>修 PR #${pr.number} 的自动检查</b>，交给 <b>${esc(handoff.personaName)}</b> 了。</div>`;
        }
        go.disabled = false;
        go.textContent = handoff.projectId ? '去看卡片' : '知道了';
        if (!handoff.projectId) go.onclick = () => dlg.close();
        toast(`任务卡已建，交给 ${handoff.personaName}`);
        // 行上的徽标随后会被这轮修复改写（推上去 → 检查重跑），刷一次列表让状态跟上
        renderGitRepos().catch(() => {});
      } catch (err) {
        /* 失败原因就地显示（toast 会飘走），按钮恢复可再点 */
        go.disabled = false;
        go.textContent = '确定';
        body?.querySelector('.gr-gate-err')?.remove();
        body?.insertAdjacentHTML('beforeend', `<div class="gr-gate-err">没建起来：${esc(err.message)}</div>`);
      }
    });
  }


  /* porcelain 的 X 列 → 展示用的一类：增 / 删 / 改 / 移（未跟踪算增） */
  const chgKind = (xy) => {
    const s = String(xy ?? '');
    if (s === '??') return 'add';
    if (s[0] === 'R' || s[1] === 'R' || s[0] === 'C' || s[1] === 'C') return 'ren';
    if (s[0] === 'A' || s[1] === 'A') return 'add';
    if (s[0] === 'D' || s[1] === 'D') return 'del';
    return 'mod';
  };
  const chgBadge = (xy) => ({ add: '增', del: '删', ren: '移', mod: '改' })[chgKind(xy)];

  /* unified diff 上色：+/− 行与 @@ 行各给一色，文件头降灰；超长截短（人看个大概，全文去 git） */
  const diffHtml = (text) => {
    const lines = String(text ?? '').split('\n');
    const MAX = 1200;
    const body = lines
      .slice(0, MAX)
      .map((ln) => {
        const cls = /^@@/.test(ln) ? 'hunk' : /^\+/.test(ln) ? 'add' : /^-/.test(ln) ? 'del' : /^(diff |index |--- |\+\+\+ )/.test(ln) ? 'meta' : '';
        return `<span class="${cls}">${esc(ln) || ' '}</span>`;
      })
      .join('\n');
    return `<pre class="gr-diff-pre">${body}${lines.length > MAX ? `\n…（后面还有 ${lines.length - MAX} 行）` : ''}</pre>`;
  };

  /*
   * 把 `前缀/名字` 的分支收进「前缀」文件夹（IDE 分支树同款，2026-10-27 用户指着截图要的）：
   * bandi/x、bandi/y → 可折叠文件夹「bandi」装着 x、y；无前缀的（main）直接排在组里。
   * 文件夹的折叠键带 keyPrefix，本地/远程同名前缀（都有 bandi/）互不串门。
   * 排序：文件夹在前（按名），无前缀的在后（按名）。
   * 每片叶子（含无前缀的）都带分支图标 —— IDEA 里文件夹装的是分支，不是普通条目。
   *
   * `keep: true` 时不排序、按传入顺序输出（「最近」用：IDEA 的最近是"当前分支打头 + 最近切过的顺序"，
   * 排序会把这个含义弄丢）。叶子上的 badge（↗1/↙2）、hint（origin/main）和 menu（行尾那颗 `›`）
   * 都要原样带过去 —— 漏一个，下拉里就少一样东西，而且不报错。
   */
  const folderize = (items, keyPrefix, { keep = false } = {}) => {
    const leafOf = (it, label, sub = false) => ({
      id: it.id,
      label,
      ...(sub ? { sub: true } : {}),
      icon: ICON_BRANCH,
      cls: 'br',
      ...(it.badge ? { badge: it.badge } : {}),
      ...(it.hint ? { hint: it.hint } : {}),
      // 2026-10-30：行尾的二级菜单箭头。这里不带上，分支行就只剩名字 —— 箭头会静默消失。
      ...(it.menu ? { menu: true } : {}),
    });
    const folders = new Map();
    const plain = [];
    const seen = []; // 首见顺序：'f:<folder>' 或 'p:<id>'
    for (const it of items) {
      const i = it.name.indexOf('/');
      if (i > 0 && i < it.name.length - 1) {
        const k = it.name.slice(0, i);
        if (!folders.has(k)) {
          folders.set(k, []);
          seen.push(`f:${k}`);
        }
        folders.get(k).push(leafOf(it, it.name.slice(i + 1), true));
      } else {
        plain.push(leafOf(it, it.name));
        seen.push(`p:${it.id}`);
      }
    }
    if (keep) {
      const out = [];
      const emitted = new Set();
      for (const key of seen) {
        if (key.startsWith('f:')) {
          const k = key.slice(2);
          if (emitted.has(k)) continue;
          emitted.add(k);
          out.push({ folder: k, foldKey: `${keyPrefix}/${k}` });
          out.push(...folders.get(k));
        } else {
          const id = key.slice(2);
          out.push(plain.find((p) => p.id === id));
        }
      }
      return out;
    }
    const out = [];
    for (const [k, list] of [...folders.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      out.push({ folder: k, foldKey: `${keyPrefix}/${k}` });
      out.push(...list.sort((a, b) => a.label.localeCompare(b.label)));
    }
    out.push(...plain.sort((a, b) => a.label.localeCompare(b.label)));
    return out;
  };

  /*
   * 分支清单 → 下拉条目（2026-10-27，参照 IDE 的分支弹窗）：
   * 顶部是常用操作（更新项目=同步、提交、推送、新建分支 —— 搜索框搜"推"也能命中操作），
   * 下面分组：最近（当前分支打头 + reflog 派生）/ 本地 / 远程 / 标签，三组都按 `/` 前缀分文件夹。
   *
   * 2026-10-27 二改（用户指 IDEA 截图："改成 idea 这种"）：
   *   · 每行右边写**上游**（`origin/main`）—— 吃服务端 listBranches 的 localUpstreams；
   *   · 分支名后面跟 **↑N / ↓N**（git 的 upstream track，当前分支的 ↑1 就是"未推送"）；
   *   · 「最近」也分文件夹（feat → frontend-esm-split），顺序按"当前分支打头、然后最近切过的顺序"。
   *
   * 十三改（用户指 IDEA 截图："补充图标和缩进"）：操作条目各配语义图标
   * （同步/提交/推送/分支），分支叶子统一分支图标，标签用标签图标 —— 图标是灰的，
   * 名字才是主角；文件夹叶子的缩进由 sub: true（folderize）+ .combo-item.sub 管。
   * 标签 id 带 `tag:` 前缀，防止和同名分支混淆；切标签会进游离 HEAD，确认框里说清。
   * 旧的「拉取更新」（纯 fetch）被「更新项目」（pull）取代 —— 两个"拉"并存只会让人选错。
   */
  const branchMeta = (b, name) => {
    const u = b.localUpstreams?.[name];
    if (!u?.upstream) return {};
    // 2026-10-27 用户："不要数字，箭头颜色使用绿色"——只留箭头（↑/↓），个数不写在这里
    //（个数在提交卡「N 个提交还没推送」里已经有了；多写一遍反而吵）。
    const arrows = `${u.ahead ? '↑' : ''}${u.behind ? '↓' : ''}`;
    return { ...(arrows ? { badge: arrows } : {}), hint: `${u.upstream}${u.gone ? '（gone）' : ''}` };
  };
  const branchItems = (b) => [
    { id: '__op-sync__', label: '更新项目', icon: ICON_SYNC },
    { id: '__op-commit__', label: '提交…', icon: ICON_COMMIT },
    { id: '__op-push__', label: '推送…', icon: ICON_PUSH },
    { id: '__op-new__', label: '新建分支…', icon: ICON_BRANCH },
    ...(b.recent?.length
      ? [
          { header: '最近', foldable: true },
          ...folderize(
            b.recent.map((n) => ({ id: n, name: n, menu: true, ...branchMeta(b, n) })),
            '最近',
            { keep: true },
          ),
        ]
      : []),
    { header: '本地分支', foldable: true },
    ...folderize((b.local ?? []).map((n) => ({ id: n, name: n, menu: true, ...branchMeta(b, n) })), '本地'),
    ...(b.remote?.length ? [{ header: '远程分支', foldable: true }, ...folderize((b.remote ?? []).map((n) => ({ id: n, name: n.replace(/^origin\//, ''), menu: true })), '远程')] : []),
    ...(b.tags?.length ? [{ header: '标签', foldable: true }, ...b.tags.map((n) => ({ id: `tag:${n}`, label: n, icon: ICON_TAG, cls: 'br' }))] : []),
  ];

  async function fillChanges(repo) {
    const box = $('grChanges');
    const pillMount = $('grBranchMount');
    let state = null;
    try {
      state = (await api(`/api/git/repos/${encodeURIComponent(repo.id)}/changes`)).state;
    } catch (e) {
      if (box?.isConnected) box.innerHTML = `<div class="sk-blank">读不到工作区：${esc(e.message)}</div>`;
      return;
    }
    if (!box?.isConnected || !pillMount?.isConnected) return;

    /*
     * 分支 pill（2026-10-27，样式参照同类编辑器的分支切换器、条目参参照 IDE 的分支弹窗）：
     * 按钮上写当前分支，点开才取清单（onOpen），当前分支由 ✓ 表示；切分支的确认
     * 先读一次本地状态，把「当前 → 目标」和 ahead / 脏工作区摆进确认框。
     */
    const combo = createCombo({
      mount: pillMount,
      items: branchItems({ local: [state.branch ?? '游离 HEAD'], remote: [] }),
      value: state.branch ?? '',
      search: true,
      placeholder: '搜索分支和操作',
      // 一打开先看操作项 +「最近」：本地 / 远程 / 标签三组默认收起（2026-10-27 用户：
      // "本地、远程、标签改成默认折叠"）—— 分支多的时候展开着会一屏铺满，还得先滚。
      defaultFolded: ['本地分支', '远程分支', '标签'],
      /*
       * 按钮上的角标（2026-10-27 用户："已提交，但是没有推送，是不是应该显示一下"）：
       * ↑ = 本地有提交还没推到上游；↓ = 上游有新的还没拉下来。
       * 同日二调（用户："不要数字，箭头颜色使用绿色"）：只画箭头、不带个数（个数在提交卡里），
       * 单独一个绿 span —— buttonText 是纯文本，上不了色。
       */
      buttonText: (v) => v || '游离 HEAD',
      // 按钮文案前的分支图标（2026-10-30 用户："左边加图标，像是idea那样"；边框同日去掉，见 style.css）
      buttonIcon: ICON_BRANCH,
      buttonBadge: () => {
        const up = Number(state.unpushed ?? 0);
        const down = Number(state.unpulled ?? 0);
        return `${up > 0 ? '↑' : ''}${down > 0 ? '↓' : ''}`;
      },
      onChange: (id) => onBranchPick(repo, id, state.branch ?? '', combo),
      onOpen: async () => {
        try {
          combo.setItems(branchItems(await api(`/api/git/repos/${encodeURIComponent(repo.id)}/branches`)));
        } catch (e) {
          toast(e.message, 'error');
        }
      },
    });

    /*
     * 分支行的二级菜单（2026-10-30 用户："不使用右键了，直接加小箭头，点击展示二级菜单，就是 IDEA 的这种效果"）：
     * 行尾那颗 `›` 由 combo 自己画（item.menu），点了只开菜单，不选分支 —— 事件从 ui.mjs 的
     * `combo-menu` 事件过来，这里只管"哪条分支、开在哪儿"。
     */
    combo.el.addEventListener('combo-menu', (ev) => {
      const id = ev.detail?.id ?? '';
      if (!id) return;
      const remote = id.startsWith('origin/');
      const name = remote ? id.slice('origin/'.length) : id;
      // 整颗浮到**面板外面**（2026-10-30 用户二调："我要的是在弹窗外"）：
      // x 锚在面板（.combo-pop）右缘外 —— 菜单不压面板边；y 锚在**那一行**（.combo-item）
      // 的顶上（菜单自带 4px 内边距，减 4 正好让菜单第一项和行顶对齐；
      // 之前锚的是行尾 `›` 按钮，按钮在行内垂直居中，菜单整体矮了一截）。
      const rowRect = ev.detail?.el?.closest?.('.combo-item')?.getBoundingClientRect?.();
      const popRect = ev.detail?.el?.closest?.('.combo-pop')?.getBoundingClientRect?.();
      openBranchMenu(
        repo,
        { x: popRect ? popRect.right : 0, y: rowRect ? rowRect.top - 4 : 0 },
        { name, remote, cur: state.branch ?? '' },
        // 签出收进二级菜单第一位（2026-10-30 用户："点击选项就打开，改成二级窗口的一个选项，放在第一位"）：
        // 复用 onBranchPick 的切分支路径 —— 确认框（ahead / 脏工作区提醒）原样保留。
        { checkout: () => onBranchPick(repo, id, state.branch ?? '', combo) },
      );
    });

    const dirty = state.dirty ?? [];
    const head = $('grChgHead');
    if (head?.isConnected) head.textContent = dirty.length ? `${dirty.length} 个未提交` : '';

    /*
     * 推送卡（2026-10-29 三改，用户："推送单独作为一个卡片"）：
     * 独立成一块，不再长在「提交」卡屁股上 —— 交是交、推是推。
     * 未推提交逐条摆出来（历史卡同款行：sha + 说明 + 作者·时间），按钮在分节标题行右侧。
     * 三种形态：有未推 / 没推过（无上游，首次推会设上游）/ 齐平（没得推，按钮收起来）。
     * 上游有新的（unpulled）单独一行 —— 动作在分支下拉的「更新项目」里。
     */
    const fillPushCard = () => {
      const pbox = $('grPush');
      if (!pbox?.isConnected) return;
      const up = state.upstream;
      const n = Number(state.unpushed ?? 0);
      const list = state.unpushedCommits ?? [];
      const down = Number(state.unpulled ?? 0);
      const phead = $('grPushHead');
      const pbtn = $('grPushNow');
      if (phead) phead.textContent = n > 0 ? `${n} 个提交还没推` : up ? '已同步' : '还没推过';
      if (pbtn) {
        pbtn.classList.toggle('hidden', n === 0 && !!up);   // 齐平就没得推（`.mini.hidden` 才有 display:none）
        pbtn.disabled = false;
        pbtn.textContent = '推送';
        pbtn.title = up ? '把本地提交推到上游' : '这条分支还没推过 —— 推送会顺手把上游设成同名分支';
        /* 用 onclick 赋值而非 addEventListener：这块每次刷新都重画，赋值天然幂等，不会叠绑定 */
        pbtn.onclick = async () => {
          pbtn.disabled = true;
          pbtn.textContent = '推送中…';
          try {
            const r = await post(`/api/git/repos/${encodeURIComponent(repo.id)}/push`, {});
            toast(`已推送 ${r.pushed}`);
            await refresh();
          } catch (err) {
            pbtn.disabled = false;
            pbtn.textContent = '推送';
            toast(err.message, 'error');
          }
        };
      }
      const behind = down > 0
        ? `<div class="sk-blank">上游还有 ${down} 个新提交 —— 分支下拉里点「更新项目」拉下来</div>`
        : '';
      const row = (c) => `<div class="gr-log-row" title="${esc(c.sha)} ${esc(c.subject)}">
          <span class="gr-log-sha">${esc(c.sha)}</span>
          <span class="gr-log-sub">${esc(c.subject)}</span>
          <span class="gr-log-who">${esc(c.author)} · ${esc(String(c.date ?? '').slice(5, 16))}</span>
        </div>`;
      if (n > 0 && list.length) {
        pbox.innerHTML = behind + list.map(row).join('')
          + (n > list.length ? `<div class="gr-log-row"><span class="dim">…另有 ${n - list.length} 个</span></div>` : '');
      } else if (n > 0) {
        pbox.innerHTML = behind + `<div class="sk-blank">当前分支有 <b>${n}</b> 个提交还没推送</div>`;
      } else if (!up) {
        pbox.innerHTML = behind + '<div class="sk-blank">这条分支还没有上游（还没推过，或远端分支已删）</div>';
      } else {
        pbox.innerHTML = `<div class="sk-blank">本地和上游 <b>${esc(up)}</b> 一致 —— 都同步完了</div>`;
      }
    };

    if (!dirty.length) {
      box.innerHTML = '<div class="sk-blank">工作区是干净的 —— 没有未提交的改动</div>';
      fillPushCard();
      return;
    }
    /* 两组折叠（2026-10-27，用户指 VS Code 源代码管理截图："加两个可以折叠的标题"）：
       「更改」= 已跟踪文件的改动；「未版本管理的文件」= porcelain 的 ?? 。空组不画。 */
    if (chgSelRepo !== repo.id) { chgSelRepo = repo.id; chgUnsel.clear(); }   // 换仓库：勾选态清零
    const tracked = dirty.filter((f) => String(f.status) !== '??');
    const untracked = dirty.filter((f) => String(f.status) === '??');
    const rowHtml = (f) => `<div class="gr-chg-row" data-chg-path="${esc(f.path)}">
          <input type="checkbox" class="gr-chg-sel" data-chg-sel="${esc(f.path)}" ${chgUnsel.has(f.path) ? '' : 'checked'} aria-label="选择 ${esc(f.path)}" />
          <span class="gr-chg-x gr-x-${chgKind(f.status)}">${esc(chgBadge(f.status))}</span>
          <span class="gr-chg-path" title="${esc(f.path)}">${esc(f.path)}</span>
        </div>
        <div class="gr-diff" hidden></div>`;
    const groupHtml = (key, label, items) =>
      items.length
        ? `<div class="gr-chg-group${chgFold[key] ? ' folded' : ''}">
        <div class="gr-chg-group-head" data-fold-head="${key}">
          <button type="button" class="gr-chg-fold-btn" tabindex="-1" aria-label="折叠/展开">
            <span class="gr-chev" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 6.5 8 10l3.5-3.5"/></svg></span>
          </button>
          <input type="checkbox" class="gr-chg-all" data-chg-all="${key}" aria-label="全选${esc(label)}" />
          <span class="gr-chg-label">${esc(label)}</span>
          <span class="gr-chg-cnt">${items.length} 个文件</span>
        </div>
        <div class="gr-chg-group-body"${chgFold[key] ? ' hidden' : ''}>${items.map(rowHtml).join('')}</div>
      </div>`
        : '';
    /*
     * 主分支提示（2026-10-29 用户："main 不应该直接提交 —— 提交时就该检查，在 main 上就提示新建分支"）。
     * 站在 base 上时把"会先建一条分支"摆到提交说明上面，名字预填服务端的建议名、可改。
     * 服务端也挡（不传名字它自己建一条）—— 这里是让"提交到哪儿"显式可见，不是唯一防线。
     */
    const onBase = !!state.onBase;
    const branchRow = onBase
      ? `<div class="gr-commit-base">
          <div class="gr-cb-tip">你在主分支 <b>${esc(state.base)}</b> 上 —— <span class="gr-cb-warn">主分支不收本地提交</span>。这次会先建一条分支，改动落在它上面：</div>
          <input id="grCommitBranch" value="${esc(state.suggest ?? '')}" autocomplete="off" spellcheck="false" aria-label="新分支名" placeholder="例如：fix/v1.4.1-pr-gate-smoke" />
          <div class="gr-cb-hint">命名：<code>&lt;type&gt;/v&lt;版本&gt;-&lt;短描述&gt;</code>，type 用 feat / fix / chore / docs / refactor / test / perf；版本取当前版本（服务端按这条校验）</div>
        </div>`
      : '';
    box.innerHTML = `
      <div class="gr-chg-split">
        <div class="gr-chg-list">${groupHtml('chg', '更改', tracked) + groupHtml('untr', '未版本管理的文件', untracked)}</div>
        <div class="gr-commit-side">
          ${branchRow}
          <textarea id="grCommitMsg" placeholder="提交说明（Ctrl+Enter 提交）" rows="9"></textarea>
          <div class="gr-commit-acts">
            <button type="button" class="btn-sm gr-suggest" id="grSuggestBtn"
                    title="按勾选的改动生成一行说明（不满意就改，或再点一次）">生成说明</button>
            <button type="button" class="primary" id="grCommitBtn">${onBase ? '建分支并提交' : '提交'}</button>
          </div>
        </div>
      </div>`;
    fillPushCard();

    /* 组头选择框 = 三态全选（全勾 / 全不勾 / 半选）；行选择框记进 chgUnsel。
       状态以 DOM 为准算，别自己记账 —— 刷新后重画，勾选只存「没勾」的那一半。 */
    const syncGroupBox = (key) => {
      const g = box.querySelector(`[data-chg-all="${key}"]`)?.closest('.gr-chg-group');
      if (!g) return;
      const boxes = [...g.querySelectorAll('.gr-chg-sel')];
      const cb = g.querySelector('.gr-chg-all');
      const off = boxes.filter((b) => !b.checked).length;
      cb.checked = off === 0;
      cb.indeterminate = off > 0 && off < boxes.length;
    };
    box.querySelectorAll('.gr-chg-group').forEach((g) => {
      const key = g.querySelector('[data-chg-all]')?.dataset.chgAll;
      if (key) syncGroupBox(key);
    });
    box.addEventListener('change', (e) => {
      const sel = e.target.closest('.gr-chg-sel');
      if (sel) {
        if (sel.checked) chgUnsel.delete(sel.dataset.chgSel);
        else chgUnsel.add(sel.dataset.chgSel);
        syncGroupBox(sel.closest('.gr-chg-group')?.querySelector('[data-chg-all]')?.dataset.chgAll);
        return;
      }
      const all = e.target.closest('.gr-chg-all');
      if (all) {
        const g = all.closest('.gr-chg-group');
        g.querySelectorAll('.gr-chg-sel').forEach((b) => {
          b.checked = all.checked;
          if (all.checked) chgUnsel.delete(b.dataset.chgSel);
          else chgUnsel.add(b.dataset.chgSel);
        });
        all.indeterminate = false;
      }
    });

    /* 组标题折叠/展开：状态写回模块级 chgFold，刷新后不丢；点选择框不算折叠 */
    box.querySelectorAll('[data-fold-head]').forEach((h) => {
      h.onclick = (e) => {
        if (e.target.closest('input')) return;
        const key = h.dataset.foldHead;
        chgFold[key] = !chgFold[key];
        const g = h.closest('.gr-chg-group');
        g.classList.toggle('folded', chgFold[key]);
        g.querySelector('.gr-chg-group-body').hidden = chgFold[key];
      };
    });

    /* 行点击开/收 diff：diff 懒取（点开才拉一次），收起不销毁、再点不再拉 */
    box.querySelectorAll('.gr-chg-row').forEach((row) => {
      row.onclick = async (e) => {
        if (e.target.closest('.gr-chg-sel')) return;   // 勾选框自己管自己，别顺手把 diff 拉开
        const dbox = row.nextElementSibling;
        if (!dbox) return;
        if (!dbox.hidden) {
          dbox.hidden = true;
          return;
        }
        dbox.hidden = false;
        dbox.innerHTML = '<div class="sk-blank">读 diff…</div>';
        try {
          const d = await api(`/api/git/repos/${encodeURIComponent(repo.id)}/diff?path=${encodeURIComponent(row.dataset.chgPath)}`);
          if (dbox.isConnected && !dbox.hidden) dbox.innerHTML = diffHtml(d.diff);
        } catch (err) {
          if (dbox.isConnected) dbox.innerHTML = `<div class="sk-blank">${esc(err.message)}</div>`;
        }
      };
    });

    /* 生成说明（2026-10-29）：一句话的活不开对话 —— 服务端只读 git、模型只负责措辞，
       拿回来填进框里，人再改再提。框里已经有字就先问一句，别把人写了一半的话冲掉。 */
    const suggestBtn = $('grSuggestBtn');
    // 自己取框（别借下面那个 msgInput）—— 它在后面才声明，这里先用会踩 TDZ
    const msgBox = $('grCommitMsg');
    if (suggestBtn && msgBox) {
      suggestBtn.onclick = async () => {
        const rows = [...($('grChanges')?.querySelectorAll('.gr-chg-row') ?? [])];
        if (!rows.length) return toast('没有可提交的改动', 'error');
        const checked = rows.map((r) => r.dataset.chgPath).filter((p) => !chgUnsel.has(p));
        if (!checked.length) return toast('先勾选要提交的文件', 'error');
        if ((msgBox.value ?? '').trim() && !(await confirmDo('框里已经有说明了，用新生成的覆盖掉？', { ok: '覆盖' }))) return;
        // 跟提交同口径：全勾就不传 paths（服务端按整片工作区算），否则只算勾选的
        const payload = checked.length < rows.length ? { paths: checked } : {};
        const label = suggestBtn.textContent;
        suggestBtn.disabled = true;
        suggestBtn.textContent = '生成中…';
        try {
          const r = await post(`/api/git/repos/${encodeURIComponent(repo.id)}/suggest-commit`, payload);
          msgBox.value = r.message ?? '';
          msgBox.focus();
          if (r.source === 'rule') toast(`模型没参与，这是按改动推的草稿：${r.note ?? ''}`, 'error');
        } catch (e) {
          toast(e.message, 'error');
        } finally {
          suggestBtn.disabled = false;
          suggestBtn.textContent = label;
        }
      };
    }

    /* 提交（不建 PR）：回车或按钮都行；服务端拦疑似凭据时弹一次危险确认，带 allowSecrets 重发。
       推送在分支下拉的「推送…」里 —— 提交和推送分两步，跟 git 的语义一致（IDE 也分开）。 */
    const commitBtn = $('grCommitBtn');
    const msgInput = $('grCommitMsg');
    const doCommit = async (allowSecrets = false) => {
      const msg = (msgInput?.value ?? '').trim();
      if (!msg) return toast('先写一句提交说明', 'error');
      // 勾选提交：没勾的不带；全勾就不传 paths（整提，服务端原路径）
      const rows = [...($('grChanges')?.querySelectorAll('.gr-chg-row') ?? [])];
      const checked = rows.map((r) => r.dataset.chgPath).filter((p) => !chgUnsel.has(p));
      if (rows.length && !checked.length) return toast('先勾选要提交的文件', 'error');
      const payload = { message: msg, allowSecrets };
      if (rows.length && checked.length < rows.length) payload.paths = checked;
      if (onBase) {
        const bn = ($('grCommitBranch')?.value ?? '').trim();
        if (!bn) return toast('给这条分支起个名字 —— 主分支不收本地提交', 'error');
        payload.branch = bn;
      }
      commitBtn.disabled = true;
      try {
        const r = await post(`/api/git/repos/${encodeURIComponent(repo.id)}/commit`, payload);
        const moved = r.autoBranch ? `（从 ${r.autoBranch.from} 新建）` : '';
        toast(`已提交 ${(r.committed?.sha ?? '').slice(0, 7)} 到 ${r.branch}${moved}（${r.files} 个文件）`);
        await refresh();
      } catch (e) {
        commitBtn.disabled = false;
        if (!allowSecrets && /凭据/.test(String(e.message ?? e))) {
          if (await confirmDo(String(e.message ?? e), { ok: '就是要提交', danger: true })) await doCommit(true);
        } else {
          toast(e.message, 'error');
        }
      }
    };
    if (commitBtn && msgInput) {
      commitBtn.onclick = () => doCommit();
      msgInput.onkeydown = (e) => {
        // textarea：Enter 换行，Ctrl/⌘+Enter 才提交
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          doCommit();
        }
      };
    }
  }

  async function onBranchPick(repo, id, fallbackBranch, combo) {
    const apiRepo = (p) => `/api/git/repos/${encodeURIComponent(repo.id)}${p}`;

    /* ---- 顶部操作区（IDE 式：更新项目 / 提交 / 推送 / 新建分支）---- */
    if (id === '__op-sync__') {
      try {
        await api(apiRepo('/sync'), { method: 'POST' });
        toast('已拉取最新');
        await refresh();
      } catch (e) {
        toast(e.message, 'error');
        combo.setValue(fallbackBranch);
      }
      return;
    }
    if (id === '__op-push__') {
      try {
        toast('推送中…');
        const r = await post(apiRepo('/push'), {});
        toast(`已推送 ${r.pushed}`);
        await refresh();
      } catch (e) {
        toast(e.message, 'error');
        combo.setValue(fallbackBranch);
      }
      return;
    }
    if (id === '__op-commit__') {
      combo.setValue(fallbackBranch);
      let st = null;
      try {
        st = (await api(apiRepo('/changes'))).state;
      } catch { /* 读不到按干净处理 */ }
      if (!st?.dirtyCount) {
        return toast(st?.canShip ? '工作区是干净的 —— 有没推的提交用分支下拉的「推送…」' : '工作区是干净的，没有可提交的改动');
      }
      const inp = document.getElementById('grCommitMsg');
      if (!inp?.isConnected) return toast('改动卡不在页面上（工作区刚变干净？）');
      inp.scrollIntoView({ block: 'center' });
      inp.focus();
      return;
    }
    if (id === '__op-new__') {
      combo.setValue(fallbackBranch);
      openBranchNewDlg(repo);
      return;
    }

    /* ---- 切分支 / 标签 ---- */
    const isTag = String(id).startsWith('tag:');
    const target = isTag ? String(id).slice(4) : String(id).replace(/^origin\//, '');
    if (!target) return;
    // 确认前现读一次本地状态（不联网、秒回）—— pill 上那份可能已经旧了
    let st = null;
    try {
      st = (await api(apiRepo('/changes'))).state;
    } catch { /* 读不到就按没有状态处理，下面的文案照走 */ }
    const cur = st?.branch ?? fallbackBranch ?? '';
    if (!isTag && target === cur) {
      combo.setValue(cur);
      return;
    }
    const dirty = Number(st?.dirtyCount ?? 0);
    const ahead = Number(st?.ahead ?? 0);
    const isRemote = !isTag && String(id).startsWith('origin/');
    const lines = [
      `当前分支：${cur || '游离 HEAD（不在任何分支上）'}`,
      isTag
        ? `会切到标签：${target}（游离 HEAD —— 不在任何分支上，提交/推送会停用，切回任意分支即恢复）`
        : `会切到：${target}${isRemote ? '（远程分支 —— 本地没有时会在本地建一条同名分支并跟踪它）' : ''}`,
      '',
    ];
    if (ahead > 0) lines.push(`⚠️ 当前分支有 ${ahead} 个提交还没在 base 上 —— 提交不会丢，但切走后工作区里看不到它们。`);
    if (dirty > 0) lines.push(`本地有 ${dirty} 个未提交改动：服务端不会动工作区（会拒绝切换）。`);
    if (!(await confirmDo(lines.join('\n'), { ok: '切换', danger: ahead > 0 }))) {
      combo.setValue(cur);
      return;
    }
    try {
      const r = await post(apiRepo('/checkout'), { branch: target });
      toast(r.switched === false ? r.note || `已在 ${r.branch}` : `已切到 ${r.branch}`);
      await refresh();
    } catch (e) {
      toast(e.message, 'error');
      combo.setValue(cur);
    }
  }

  /* 新建分支小弹窗（IDE「新建分支」）：从当前 HEAD 拉出并切过去；脏工作区不拦（checkout -b 不动文件） */
  function openBranchNewDlg(repo) {
    document.getElementById('grBranchNewDlg')?.close();
    const dlg = document.createElement('dialog');
    dlg.id = 'grBranchNewDlg';
    dlg.innerHTML = `
      <form method="dialog">
        <b>新建分支</b>
        <label>分支名（从当前所在位置拉出）：<code>&lt;type&gt;/v&lt;版本&gt;-&lt;短描述&gt;</code></label>
        <input id="grNewBranchName" placeholder="例如：feat/v1.5.0-search、fix/v1.4.1-pr-gate-smoke" autocomplete="off" />
        <div class="gr-cb-hint">type 只能是 feat / fix / chore / docs / refactor / test / perf；版本写 x.y.z；短描述用小写英文、数字、点或横线。</div>
        <div class="dlg-actions">
          <button type="button" value="cancel">取消</button>
          <button class="primary" id="grNewBranchGo">建并切过去</button>
        </div>
      </form>`;
    document.body.append(dlg);
    wireDialogHead(dlg.querySelector('form'));
    dlg.addEventListener('close', () => dlg.remove());
    dlg.showModal();
    const inp = $('grNewBranchName');
    inp.focus();
    const go = $('grNewBranchGo');
    go.onclick = async (e) => {
      e.preventDefault();
      const name = (inp.value ?? '').trim();
      if (!name) return toast('先起个分支名', 'error');
      go.disabled = true;
      try {
        const r = await post(`/api/git/repos/${encodeURIComponent(repo.id)}/branch`, { name });
        toast(`已建并切到 ${r.created}`);
        dlg.close();
        await refresh();
      } catch (err) {
        go.disabled = false;
        toast(err.message, 'error');
      }
    };
  }

  /**
   * 与 base 比较：从分支行尾那颗 `›` 的二级菜单进来。
   * 文件清单点一行懒取该文件 diff，收起不销毁、再点不再拉。
   */
  function openBranchCompareDlg(repo, branch) {
    document.getElementById('grBrCmpDlg')?.close();
    const apiRepo = (p) => `/api/git/repos/${encodeURIComponent(repo.id)}${p}`;
    const kindOf = (st) => ({ A: 'add', D: 'del', R: 'ren' })[st] || 'mod';
    const badgeOf = (st) => ({ A: '增', D: '删', R: '移', C: '拷', T: '型' })[st] || '改';
    const dlg = document.createElement('dialog');
    dlg.id = 'grBrCmpDlg';
    dlg.style.width = '720px';
    dlg.innerHTML = `
      <form method="dialog">
        <b>与 base 比较 · ${esc(branch)}</b>
        <div id="grBrCmpBody"><div class="sk-blank">对比中…</div></div>
        <div class="dlg-actions"><button type="button" value="cancel">关闭</button></div>
      </form>`;
    document.body.append(dlg);
    wireDialogHead(dlg.querySelector('form'));
    dlg.addEventListener('close', () => dlg.remove());
    dlg.showModal();
    const body = $('grBrCmpBody');

    (async () => {
      let cmp;
      try {
        cmp = await api(apiRepo(`/branch-diff?branch=${encodeURIComponent(branch)}`));
      } catch (e) {
        body.innerHTML = `<div class="sk-blank">对比没成：${esc(e.message)}</div>`;
        return;
      }
      if (!body.isConnected) return; // 弹窗已关
      const rows = (cmp.files ?? [])
        .map(
          (f) => `<div class="gr-chg-row gr-br-file" data-cmp-file="${esc(f.path)}">
            <span class="gr-chg-x gr-x-${kindOf(f.status)}">${esc(badgeOf(f.status))}</span>
            <span class="gr-chg-path" title="${esc(f.path)}">${esc(f.path)}${
              f.from ? ` <span class="dim">← ${esc(f.from)}</span>` : ''
            }</span>
          </div>
          <div class="gr-diff" hidden></div>`,
        )
        .join('');
      const head = `<div class="gr-meta" style="margin:2px 0 10px">
          <b>${esc(cmp.branch)}</b> 与 base <b>${esc(cmp.base)}</b> 比较（base...分支）${
            cmp.shortstat ? ` ｜ ${esc(cmp.shortstat)}` : ''
          }
        </div>`;
      body.innerHTML =
        head +
        (rows
          ? `<div class="gr-br-cmp">${rows}</div>`
          : '<div class="sk-blank">没有差异 —— 这条分支和 base 一样</div>');
      body.querySelectorAll('[data-cmp-file]').forEach((row) => {
        row.onclick = async () => {
          const box = row.nextElementSibling;
          if (!box) return;
          if (!box.hidden) {
            box.hidden = true;
            return;
          }
          box.hidden = false;
          box.innerHTML = '<div class="sk-blank">读 diff…</div>';
          try {
            const d = await api(
              apiRepo(
                `/branch-diff/file?branch=${encodeURIComponent(branch)}&path=${encodeURIComponent(row.dataset.cmpFile)}`,
              ),
            );
            if (box.isConnected && !box.hidden) box.innerHTML = diffHtml(d.diff);
          } catch (e) {
            if (box.isConnected) box.innerHTML = `<div class="sk-blank">${esc(e.message)}</div>`;
          }
        };
      });
    })();
  }

  /** 删一条分支（分支行尾 `›` 菜单里的动作）：确认里把"为什么可能被拒"说清，失败原话带回 */
  async function deleteBranchByMenu(repo, name, remote) {
    const base = repos.find((r) => r.id === repo.id)?.defaultBranch || 'main';
    const ok = await confirmDo(
      `删${remote ? '远端' : '本地'}分支 ${name}？\n\n` +
        (remote
          ? `还有开着的 PR、或还有没合并进 base 的提交，服务端会拒绝。`
          : `必须已经合并进 base（${base}），不然服务端会拒绝 —— 平台不靠删分支丢代码。`),
      { ok: '删除', danger: true },
    );
    if (!ok) return;
    try {
      await post(`/api/git/repos/${encodeURIComponent(repo.id)}/branch-delete`, { branch: name, remote });
      toast(`已删${remote ? '远端' : '本地'}分支 ${name}`);
      await refresh();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  /**
   * 分支的二级菜单（2026-10-30 用户："加个小箭头，点击展示二级菜单，就是 IDEA 的这种效果"）。
   * 里面只放"对这条分支做的事"：签出（第一位，当前分支不给）、比较（base 自己不用比）、
   * 删除（当前 / base 不给；远端只给平台建的分支）。
   * 一个能点的都没有就不弹 —— 空白菜单比没有菜单更让人困惑。
   */
  function openBranchMenu(repo, pos, { name, remote, cur }, { checkout } = {}) {
    const base = repos.find((r) => r.id === repo.id)?.defaultBranch || 'main';
    const isBase = name === base;
    const isCur = !remote && name === cur;
    // 与 service 端同一条判据：老前缀 bandi/ 或新规范 <type>/<短描述>
    const isPlatform =
      /^bandi\//.test(name) || /^(feat|fix|chore|docs|refactor|test|perf)\/[a-z0-9][a-z0-9.-]*$/.test(name);
    const items = [];
    if (checkout && !isCur) {
      items.push({ label: remote ? '签出…' : '签出', run: checkout });
    }
    if (!isBase) items.push({ label: '与 base 比较…', run: () => openBranchCompareDlg(repo, name) });
    if (!remote && !isCur && !isBase) {
      items.push({ label: '删除分支…', danger: true, run: () => deleteBranchByMenu(repo, name, false) });
    }
    if (remote && isPlatform) {
      items.push({ label: '删除远端分支…', danger: true, run: () => deleteBranchByMenu(repo, name, true) });
    }
    if (!items.length) return; // 一个动作都没有就不弹 —— 空白菜单更让人困惑
    openCtxMenu(pos.x, pos.y, items);
  }

  async function fillLog(repo) {
    const box = $('grLog');
    if (!box) return;
    try {
      const d = await api(`/api/git/repos/${encodeURIComponent(repo.id)}/log`);
      if (!box.isConnected) return;
      if (!d.commits?.length) {
        box.innerHTML = `<div class="sk-blank">${esc(d.note || '还没有提交')}</div>`;
        return;
      }
      box.innerHTML = d.commits
        .map(
          (c) => `<div class="gr-log-row" title="${esc(c.sha)} ${esc(c.subject)}">
            <span class="gr-log-sha">${esc(c.sha)}</span>
            <span class="gr-log-sub">${esc(c.subject)}</span>
            <span class="gr-log-who">${esc(c.author)} · ${esc(String(c.date ?? '').slice(5, 16))}</span>
          </div>`,
        )
        .join('');
    } catch (e) {
      if (box.isConnected) box.innerHTML = `<div class="sk-blank">读不到提交记录：${esc(e.message)}</div>`;
    }
  }

  // 「从 GitHub 添加」那张清单已经收进弹窗了（openGitPickDialog），页面上不再常驻一块。
}



/* ---------------------------------------------------------------- 建 PR / 合并 PR（2026-10-25） */

/**
 * 「建 PR」弹窗（2026-10-25；2026-10-27 瘦成纯表单）：把本地改动收成一个提交、推一条新分支、开一个 PR。
 *
 * 原来这颗弹窗下半屏还列着"开着的 PR"顺带让人合并 —— 2026-10-27 用户要求 PR 独立成区域后，
 * 那半屏搬去了详情页的「拉取请求」区（建完立刻在下面出现，合完立刻消失），所以这里只剩表单。
 *
 * 为什么提交这一步必须由平台做、不给员工挂个"会建 PR 的技能"（2026-10-25 用户问过有没有现成的）：
 *   · 令牌只在服务端 —— `agentEnv()` 把 `GIT_*`/`GH_TOKEN` 全清了（2026-10-17 事故后的规矩），
 *     让员工拿 `gh`/MCP 建 PR 等于把凭据发回去，还绕开合并四闸与 `tools/check-pr.mjs`；
 *   · 推上去收不回来 —— 所以这里三道闸摆在界面上：只往**新分支**提（不碰 base）、
 *     看着像凭据的文件先拦一次（`.env` / 私钥 / `*token*`，`.env.example` 那类放过）、
 *     推不上去**绝不强推**（远端同名分支多半是别人的活）。
 *   沿用上游技能的**交互**（收尾分支先确认 base、别默认强推），不是它的实现。
 *
 * 状态显示只读本地 git（`/changes` 不联网），点开就该有反应；建完 `onDone` 让宿主整页重画。
 */
export function openRepoPrDialog(repo, onDone) {
  /*
   * 这颗弹窗里的控件全靠 id 定位（`$('prTitle')` 这种）。同一个仓库连点两次「建 PR」
   * 会留下面板里第一颗还没关的弹窗，那份 id 也还在 DOM 里 —— id 查询只回第一个，
   * 人就会在**看不见的那一份**上敲字。所以开窗前先把旧的收掉。
   */
  document.getElementById('repoPrDlg')?.close();
  const dlg = document.createElement('dialog');
  dlg.id = 'repoPrDlg';
  /* 尺寸全交给 style.css 的 dialog#repoPrDlg（660 × min(720px, 92vh) 定高）：
     这里再写 inline 宽高的话会压过那条规则，两边改一处忘一处。 */
  /*
   * 2026-10-29 重设计：
   *   · 内容按「先写什么 → 再往哪推」排：标题、描述在前，base 在后；
   *   · 推送和建 PR 拆开（用户："这里只是建 PR 就可以，前面的推送已经做了"）：
   *     没有「新分支名」栏了 —— head 就是当前分支；没推完的提交弹窗建不了，指路推送区。
   *   · 长说明从 placeholder 挪进 label 的 <em> —— 填之前就该看见要求，填完才看得见提示没用。
   * 控件 id（prTitle/prBody/prBase/prDraft/prFillBtn/prSubmit）不变，
   * 行为契约不变：「建 PR」不标 type="button"（回车即提交），其余钮必须标。
   */
  dlg.innerHTML = `
    <form method="dialog">
      <b>建 PR · ${esc(repo.fullName)}</b>
      <div class="gr-meta pr-path">${esc(repo.localPath)}</div>

      <div id="prState"><div class="sk-blank">读工作区…</div></div>

      <div id="prForm" hidden>
        <div class="pr-fill-row">
          <label style="flex:1">PR 标题<em>一句话说清这个 PR 干了什么</em></label>
          <button type="button" class="btn-sm" id="prFillBtn" title="按这条分支领先 base 的提交，自动填标题和描述">自动填充</button>
        </div>
        <input id="prTitle" placeholder="例如：代码托管：加建 PR 与手动合并" autocomplete="off" />
        <label>PR 描述<em>改了什么 + 怎么验的；没跑过验证就写「未验证」—— 别写「安全」「已修复」</em></label>
        <textarea id="prBody" rows="4" placeholder="改了什么 + 怎么验的。"></textarea>
        <label>合进哪个分支（base）<em>base 不动</em></label>
        <input id="prBase" autocomplete="off" />
        <label class="check"><input type="checkbox" id="prDraft" />
          <span>先建成草稿<em>——草稿不会被自动合并，等你在 GitHub 上标为可审阅</em></span></label>
      </div>

      <div class="dlg-actions">
        <button type="button" value="cancel">关闭</button>
        <button class="primary" id="prSubmit" disabled>建 PR</button>
      </div>
    </form>`;
  document.body.append(dlg);
  wireDialogHead(dlg.querySelector('form'));
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();

  /*
   * 「推送并建 PR」是这颗弹窗唯一的动作按钮（不标 type="button"）：
   * 人敲完标题按回车就该走推送 —— 这是 `app.mjs:115-130` 那套约定的另一半，
   * 也是为什么「换一个」「自动填充」这些**必须**标 type="button"（否则回车会点到它们身上）。
   * handler 里 preventDefault，不然 `method="dialog"` 会把窗关掉、失败后就看不到原因了。
   */
  const setErr = (msg) => {
    const box = $('prErrPop');
    if (box) box.textContent = msg;
  };

  /* ---------------- 上半屏：本地工作区（不联网，点下去就该有反应） ---------------- */
  let state = null;
  const paintState = () => {
    const box = $('prState');
    // 异步回来时弹窗可能已经被关掉（节点都没了）—— 摸下去只会抛一个和真实问题无关的错
    if (!box || !state) return;
    if (!state.hasRemote) {
      box.innerHTML = `<div class="sk-blank">这个目录没有 origin —— 手动接入的本地克隆要先把 origin 指回 GitHub，不然推不上去。</div>`;
      $('prSubmit').disabled = true;
      return;
    }
    if (state.detached) {
      box.innerHTML = `<div class="sk-blank">当前不在任何分支上（detached HEAD）—— 先在那个目录 <code>git checkout</code> 回一个分支再来。</div>`;
      $('prSubmit').disabled = true;
      return;
    }
    const dirty = state.dirtyCount;
    /* base 没记录时不能说 "origin/null"（那是假话，也看不出该做什么） */
    const ahead = !state.base
      ? '不知道（没记录 base 分支）'
      : state.ahead === null
        ? `不知道（本地还没有 origin/${state.base}，先点「同步」）`
        : `${state.ahead} 个提交`;
    /* 推送状态（推送和建 PR 拆开后弹窗要管的第一件事）：没推完 = 现在建不了，指路推送区 */
    const unpushedN = Number(state.unpushed ?? 0);
    const pushChip = !state.upstream
      ? '<div class="pr-sum-item"><span class="pr-sum-k">推送</span><span class="pr-sum-v">没推过（还没有上游）</span></div>'
      : unpushedN > 0
        ? `<div class="pr-sum-item"><span class="pr-sum-k">推送</span><span class="pr-sum-v">还有 ${unpushedN} 个没推</span></div>`
        : '<div class="pr-sum-item"><span class="pr-sum-k">推送</span><span class="pr-sum-v">已推到远端</span></div>';
    /*
     * 这个窗只讲**这条 PR 会装什么**（2026-10-29 用户："应该是这个 PR 相关的内容，没推送的讲他干嘛？"）：
     * 已提交、还没推的就是全部内容；没提交的东西跟这颗按钮无关，不摆进来占地方。
     */
    /*
     * 概览重设计（2026-10-29）：「当前分支 / base / 领先」从竖线串成的长句改成 chip ——
     * 数字和分支名是要被扫到的，不是被读的；提交清单收进浅底卡片，跟下面的表单区分开。
     */
    box.innerHTML = `
      <div class="pr-sum">
        <div class="pr-sum-item"><span class="pr-sum-k">当前分支</span><span class="pr-sum-v" title="${esc(state.branch)}">${esc(state.branch)}</span></div>
        <div class="pr-sum-item"><span class="pr-sum-k">base</span><span class="pr-sum-v" title="${esc(state.base || '未记录')}">${esc(state.base || '未记录')}</span></div>
        <div class="pr-sum-item"><span class="pr-sum-k">领先 base</span><span class="pr-sum-v">${esc(String(ahead))}</span></div>
        ${pushChip}
      </div>
      ${
        state.aheadCommits?.length
          ? `<div class="pr-commits">
          <div class="pr-commits-head">这条 PR 会装 <b>${state.aheadCommits.length}</b> 条提交<span class="pr-commits-note">${unpushedN > 0 ? '已提交、还没推' : '已推到远端'}</span></div>
          <ul class="pr-commit-list">
            ${state.aheadCommits.slice(0, 6).map((c) => `<li><code>${esc(c.sha)}</code><span title="${esc(c.subject)}">${esc(c.subject)}</span></li>`).join('')}
            ${state.aheadCommits.length > 6 ? `<li class="dim">…另有 ${state.aheadCommits.length - 6} 条</li>` : ''}
          </ul></div>`
          : ''
      }
      ${state.canPr ? '' : '<div class="pr-warn">当前分支没有领先 base 的提交 —— 没有东西可以进 PR：先在「提交」里提交，再来建。</div>'}
      ${state.canPr && !state.canPrNow ? '<div class="pr-warn">这条分支还有没推送的提交 —— 建不了 PR。先关掉这个窗，在「提交」卡的推送区点「推送」，推完再回来。</div>' : ''}`;
    const form = $('prForm');
    form.hidden = !state.canPrNow;
    $('prSubmit').disabled = !state.canPrNow;
    if (!$('prBase').value) $('prBase').value = state.base ?? '';
  };

  api(`/api/git/repos/${encodeURIComponent(repo.id)}/changes`)
    .then((d) => {
      state = d.state;
      paintState();
    })
    .catch((e) => {
      const box = $('prState');
      if (!box) return; // 弹窗已关
      box.innerHTML = `<div class="sk-blank">读不到工作区：${esc(e.message)}</div>`;
    });

  /* 自动填充（2026-10-29）：标题、描述一起填。框里已经有字就先问一句；
     填完焦点落在标题上，人顺着往下检查——自动填的是草稿，不是结论。 */
  $('prFillBtn')?.addEventListener('click', async (e) => {
    e.preventDefault();
    const btn = $('prFillBtn');
    if (!btn || btn.disabled) return;
    if ((($('prTitle').value ?? '').trim() || ($('prBody').value ?? '').trim())
      && !(await confirmDo('标题或描述已经有字了，用自动填充的覆盖掉？', { ok: '覆盖' }))) return;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '填充中…';
    try {
      const r = await post(`/api/git/repos/${encodeURIComponent(repo.id)}/suggest-pr`, {});
      if (!r || (!r.title && !r.body)) { toast('没有可填的东西：工作区干净、分支也不领先 base', 'error'); return; }
      if (r.title) $('prTitle').value = r.title;
      if (r.body) $('prBody').value = r.body;
      if (r.source === 'rule') toast(`模型没参与，这是按提交记录推的摘要草稿，发送前过一遍：${r.note ?? ''}`);
      $('prTitle').focus();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      if ($('prFillBtn')) { btn.disabled = false; btn.textContent = label; }
    }
  });

  /* ---------------- 提交（唯一的提交按钮；下半屏的 PR 列表 2026-10-27 已搬去详情页 PR 区） ---------------- */
  $('prSubmit')?.addEventListener('click', async (e) => {
    e.preventDefault();
    const title = $('prTitle').value.trim();
    if (!title) return toast('标题写一句 —— PR 标题是别人（和三个月后的你）唯一会看到的那句话');
    const btn = $('prSubmit');
    btn.disabled = true;
    btn.textContent = '建 PR 中…';
    try {
      const r = await api(`/api/git/repos/${encodeURIComponent(repo.id)}/prs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          body: $('prBody').value,
          base: $('prBase').value.trim() || null,
          draft: $('prDraft').checked,
        }),
      });
      toast(r.created ? `PR #${r.pr.number} 建好了：${r.pr.url}` : `这个分支已经有一个 open PR：#${r.pr.number}（没新建）`);
      /*
       * 建完就关窗 + 整页重画（2026-10-27）：PR 现在常驻在详情的「拉取请求」区，
       * 新 PR 应该立刻出现在那张清单上；留着一颗停在「建 PR 中…」的弹窗只会让人以为卡死。
       */
      dlg.close();
      if (onDone) await onDone();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = '建 PR';
      // 失败原话摆在这一屏上（不弹走了事）：这一步多半是"权限没勾"或"分支撞名"，人要照着改
      setErr(String(err.message ?? err));
      toast(err.message, 'error');
    }
  });

  // 失败原因就近显示（不在页面上乱弹）：在提交按钮上面补一小段红字
  const errWrap = document.createElement('div');
  errWrap.id = 'prErrPop';
  errWrap.className = 'counter left';
  errWrap.style.color = 'var(--bad)';
  dlg.querySelector('.dlg-actions')?.before(errWrap);
}



/* ---------------------------------------------------------------- 定时任务 */

/**
 * 定时任务页（2026-10-17，入口在**工作台** —— 跟项目/任务看板/流程并列）。
 *
 * 以前挂在「设置」里，但它不是"配置"，是"让谁到点去干活"：跟看板同一类东西。
 * 放在设置里还有个副作用 —— 人得先想到"去设置找"，才找得到。
 */
export async function openSchedules() {
  setRoute('schedules');
  // 它是工作台里的页面，不是插件也不是某个项目的看板 —— 清掉那几条路，
  // 否则刷新时会被它们抢走（项目列表 / 全局面板各自都有"恢复位置"的优先级）
  S.plugin = null;
  S.projectList = false;
  S.projectId = null;
  S.boardAll = false;
  savePlace();
  $('pluginView').classList.remove('kb-page'); // 列表页按普通长页面滚
  showView('plugin');
  await renderSchedules();
}



/**
 * 定时任务列表。
 *
 * 一屏只回答三个问题：**有哪些任务、多久跑一次、上次跑成没跑成。**
 * 节拍（间隔）与开关都在这张卡上，不在代码里 —— 所以"什么时候巡检 PR"是配置项，不是发版项。
 *
 * 结果那一行必须显示**原话**（成功是结论，失败是原因）：定时任务最怕的就是"它好像没跑"，
 * 而人无从判断。真话写在行上，比藏在日志里强。
 */
export async function renderSchedules() {
  const view = $('pluginView');
  view.innerHTML = '<div class="empty" style="padding:24px 4px">读取中…</div>';
  let data;
  try {
    data = await api('/api/schedules');
  } catch (e) {
    view.innerHTML = `<div class="empty" style="padding:24px 4px">取不到：${esc(e.message)}</div>`;
    return;
  }
  const jobs = data.jobs ?? [];
  // 列表里要写清"它到底要干什么、在哪个项目里干" —— 那句话由**动作自己**拼好下发（`lead`），
  // 卡片不再按字段名猜（加第二个通用动作时那段 if 就得重写）。
  const actionOf = (id) => (data.actions ?? []).find((a) => a.id === id);
  const when = (iso) => (iso ? String(iso).replace('T', ' ').slice(0, 16) : '还没跑过');

  const resultOf = (j) => {
    if (!j.lastStatus) return '<span class="dim">还没跑过</span>';
    if (j.lastStatus === 'ok') return `<span style="color:var(--ok)">✓</span> ${esc(j.lastSummary || '完成')}`;
    return `<span style="color:var(--bad)">✗</span> ${esc(j.lastError || '失败了（没有原因）')}`;
  };

  const card = (j) => {
    // 「交给数字员工」/「交给流程」这类任务，卡上最该看到的是**它到底要干什么**，不是动作名 ——
    // 五条任务都写着「交给数字员工」等于没写。所以服务端把这句话拼好（动作自己的 describe），
    // 这里照抄；老数据没有 lead 就不写这一行。
    const lead = String(j.lead ?? '').trim();
    /* 卡片形态（2026-10-20 用户要求"做成卡片"）：整行横条改成一格一格的卡。
       结构：第一行 名字+状态 → 第二行 要干什么+节拍 → 第三行 上次结果（原话）→ 底部动作。
       margin-top:auto 把动作压到卡底，多张卡并排时按钮齐平。 */
    return `
    <article class="sch-card">
      <div class="sch-card-top">
        <b>${esc(j.name)}</b>
        <span class="pill">${esc(actionOf(j.action)?.label ?? j.action)}</span>
        ${j.ownedByRepo ? `<span class="pill" title="节拍跟着仓库走：工作台 › 代码托管 › 仓库设置">随仓库</span>` : ''}
        ${(j.repeat === 'once' && j.lastStatus === 'ok') ? '<span class="pill" style="color:var(--ok)">已完成</span>' : ''}
        ${j.running ? '<span class="pill" style="color:var(--warn)">在跑</span>' : ''}
        <!-- 动作在**右上角**（2026-10-20 用户照参考截图要求）：启停开关在最右，跟名字同一行。
             三颗动作是**图标按钮**（同日用户："这三个改成图标按钮"）：文字版三块边框比任务名还重，
             图标 + 提示就够；删除那颗常态红，危险操作不用 hover 才认得出。
             提示走自建 data-tip（2026-10-20 用户："提示框改成圆角"）：原生 title 的方角改不了，
             aria-label 留着给读屏 —— 两个一起写会冒双重提示 -->
        <div class="sch-acts">
          <button class="sch-ic" data-sch-run="${esc(j.id)}" data-tip="立即执行" aria-label="立即执行">${ICON_PLAY}</button>
          <button class="sch-ic" data-sch-edit="${esc(j.id)}" data-tip="编辑" aria-label="编辑">${ICON_EDIT}</button>
          <button class="sch-ic danger" data-sch-del="${esc(j.id)}" data-tip="删除" aria-label="删除">${ICON_TRASH}</button>
          <!-- 启停是**开关**不是按钮：开关本身就是状态，卡上不再多挂「已停用」胶囊。
               提示**只说当前状态**（2026-10-20 用户定）：写成「点击后怎样」会被读成现状，
               状态 + 动作混在一起也嫌长。点了会怎样，开关本身就是答案 -->
          <label class="switch sm" data-tip="${j.enabled ? '已启用（到点就跑）' : '已停用（到点也不跑）'}">
            <input type="checkbox" data-sch-toggle="${esc(j.id)}" ${j.enabled ? 'checked' : ''} /><span></span>
          </label>
        </div>
      </div>
      ${lead ? `<div class="sch-desc">${esc(lead)}</div>` : ''}
      ${
        j.ownedByRepo
          ? `<div class="sch-desc dim">这条巡检跟着仓库「${esc(j.ownedByRepo)}」走 —— 节拍在「工作台 › 代码托管 › 仓库设置」里改</div>`
          : ''
      }
      ${
        /* 结果原话独占一行（2026-10-20 用户："上次执行时间放右下角"）：
           原来时间和结果拼在底行右侧，结果一长整行被占满、时间就吊在中间。
           拆开后底行只剩「节拍（左）+ 上次时间（右）」，两个都短，一行放得下 */
        j.lastStatus ? `<div class="sch-result">${resultOf(j)}</div>` : ''
      }
      <!-- 底行：定时方式在左下角，上次执行时间在**右下角** -->
      <div class="sch-foot">
        <span class="sch-when">${esc(j.text ?? `每 ${j.everyMinutes} 分钟`)}</span>
        <span class="sch-last">${j.lastRunAt ? `上次 ${esc(when(j.lastRunAt))}` : '还没跑过'}</span>
      </div>
    </article>`;
  };

  view.innerHTML = `
    ${headRow(
      breadcrumb([{ label: '工作台', to: 'workbench' }, { label: '定时任务' }]),
      '<button class="primary" id="schNew">＋ 新建任务</button>',
    )}
    <div class="detail-body">
      <div class="group-title">任务 <span class="dim" style="font-weight:400">${jobs.length} 个</span></div>
      ${
        jobs.length
          ? `<div class="sch-grid">${jobs.map(card).join('')}</div>`
          : `<div class="sk-blank">还没有定时任务。最常用的做法是「交给数字员工」：写一句要它干什么、选一个人，
             到点这句话就发进它自己的一条会话里（标题写着任务名，结果在那儿看）。
             要让流水线自己跑一遍就选「交给流程」—— 写清这次办什么事、挑一条**已发布**的流程，
             到点发起一条实例，按模板节点往下走（进度去工作台 › 工作流看）。
             内置动作里还有「数据库备份」—— 把 bandi.db 导出一份到数据目录的 backups/，只留最近 N 份。
             「PR / Issue 巡检」现在**按仓库配**（2026-10-29）：去「工作台 › 代码托管 › 仓库设置」选节拍，
             这里照样会列出来、标着「随仓库」（留空仓库的那种是"扫所有仓库"的全局任务）。
             动作是可插拔的，以后加新动作不用改调度核心。</div>`
      }
    </div>`;

  $('schNew')?.addEventListener('click', () => scheduleDialog(null));
  view.querySelectorAll('[data-sch-run]').forEach((el) => {
    el.onclick = async () => {
      const id = el.dataset.schRun;
      if (el.disabled) return; // 按钮变图标后没有「跑中…」文案了，连点两下要自己挡
      el.disabled = true;
      /* 图标按钮没有字可改：在跑的时候让三角换成一圈转的环（.busy 那条 CSS），
         这是「点了、在跑、别急」的唯一可见反馈 —— 少了它，慢任务点下去像没反应 */
      el.classList.add('busy');
      try {
        const r = await api(`/api/schedules/${encodeURIComponent(id)}/run`, { method: 'POST' });
        await renderSchedules(); // 成功就整页重画，busy 态跟着节点一起没了
        toast(r.ok ? `跑完了：${r.summary ?? '完成'}` : `这次没跑成：${r.error ?? '没有原因'}`);
      } catch (e) {
        el.disabled = false;
        el.classList.remove('busy');
        toast(e.message, 'error');
      }
    };
  });
  view.querySelectorAll('[data-sch-edit]').forEach((el) => {
    el.onclick = () => scheduleDialog(jobs.find((j) => j.id === el.dataset.schEdit) ?? null);
  });
  /* 启停开关：点下去就存（不确认），失败要把开关拨回去 —— 否则界面说的和库里存的是两回事 */
  view.querySelectorAll('[data-sch-toggle]').forEach((el) => {
    el.onchange = async () => {
      const j = jobs.find((x) => x.id === el.dataset.schToggle);
      if (!j) return;
      try {
        await api(`/api/schedules/${encodeURIComponent(j.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: el.checked }),
        });
        await renderSchedules();
      } catch (e) {
        el.checked = !el.checked; // 拨回去
        toast(e.message, 'error');
      }
    };
  });
  view.querySelectorAll('[data-sch-del]').forEach((el) => {
    el.onclick = async () => {
      if (!(await confirmDo('删掉这个定时任务？（已经写在看板上的卡不会删）'))) return;
      try {
        await api(`/api/schedules/${encodeURIComponent(el.dataset.schDel)}`, { method: 'DELETE' });
        await renderSchedules();
      } catch (e) {
        toast(e.message, 'error');
      }
    };
  });
}



/**
 * 「重复」右边那块动态字段（对齐 WorkBuddy 定时任务的弹窗）：
 * 不是竖着堆「标签 + 控件」，而是**横排的框** —— 每个框自带前缀（「时间：」「日期：」），
 * 跟原生控件拼在同一个边框里。间隔 → 间隔分钟；单次 → 日期时间；每天 → 时间；
 * 每周/每双周 → 星期 + 时间；每月 → 日期 + 时间；每年 → 月份 + 日期 + 时间。
 */
export function schRepeatBody(mode, job, min) {
  /*
   * ⚠️ 用 `<span>` 而不是 `<label>`：这些框里现在装的是 `.combo` 组件，而 label 会把
   * 「框内任意位置」的点击**转发给框里的第一个控件** —— 点下拉里的某一项时，
   * 转发的那一下会把刚收起的浮层又打开一次（看着像"选了又弹回去"）。span 没有这个行为。
   */
  const box = (k, inner) => `<span class="dlg-box"><span class="dlg-box-k">${k}</span>${inner}</span>`;
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(job?.atTime ?? '') ? job.atTime : '09:00';
  const timeBox = box('时间：', `<input id="schAt" type="time" value="${esc(time)}" />`);
  if (mode === 'interval') {
    return box('间隔：', `<input id="schEvery" type="number" min="${min}" step="1" value="${job?.everyMinutes ?? 30}" /><span class="dlg-box-u">分钟</span>`);
  }
  if (mode === 'once') {
    let v = '';
    const ts = Date.parse(job?.runAt ?? '');
    if (Number.isFinite(ts)) {
      const d = new Date(ts);
      const p = (n) => String(n).padStart(2, '0');
      v = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
    }
    /* 原生 datetime-local 换成自建选择器（2026-10-20 用户："跑到弹窗外面了"）：
       那个日历是浏览器画的、位置改不了。值仍走同名 hidden input ——
       保存那段代码（$('schRunAt').value）一行都不用动，取值格式也一样。 */
    return box('时间：', `<input id="schRunAt" type="hidden" value="${esc(v)}" /><span class="dlg-combo" id="schDtMount"></span>`);
  }
  if (mode === 'daily') return timeBox;
  const wd = Number.isInteger(job?.weekday) ? job.weekday : 1;
  if (mode === 'weekly' || mode === 'biweekly') {
    // 下拉只留挂载点，控件由 mountSchRepeatCombos() 装（全站 .combo 公共组件）
    return box('星期：', '<span class="dlg-combo" id="schWdMount"></span>') + timeBox;
  }
  const dom = Number.isInteger(job?.dayOfMonth) ? job.dayOfMonth : 1;
  const domBox = box('日期：', `<input id="schDom" type="number" min="1" max="31" step="1" value="${dom}" /><span class="dlg-box-u">号</span>`);
  if (mode === 'monthly') return domBox + timeBox;
  const mo = Number.isInteger(job?.month) ? job.month : 1;
  const moBox = box('月份：', '<span class="dlg-combo" id="schMoMount"></span>');
  return moBox + domBox + timeBox;
}



/**
 * 重复那一排里的两个下拉（星期 / 月份）—— 同样是 `.combo` 公共组件。
 * 它们在弹窗**最下面**，一律 `up`（往上弹），否则开出来就被窗口底边切掉。
 * 返回 `{ wd, mo }`，读值走它们；当前模式没有的那颗是 null。
 */
export function mountSchRepeatCombos(mode, job) {
  const wdMount = $('schWdMount');
  const moMount = $('schMoMount');
  const dtMount = $('schDtMount'); // 「单次」的日期时间（自建选择器，见 createDateTimePick）
  const out = { wd: null, mo: null };
  if (wdMount) {
    const cur = String(Number.isInteger(job?.weekday) ? job.weekday : 1);
    out.wd = createCombo({
      mount: wdMount,
      items: '日一二三四五六'.split('').map((c, i) => ({ id: String(i), label: `星期${c}` })),
      value: cur,
    });
    out.wd.el.classList.add('up');
  }
  if (moMount) {
    const cur = String(Number.isInteger(job?.month) ? job.month : 1);
    out.mo = createCombo({
      mount: moMount,
      items: Array.from({ length: 12 }, (_, i) => ({ id: String(i + 1), label: `${i + 1} 月` })),
      value: cur,
    });
    out.mo.el.classList.add('up');
  }
  if (dtMount) {
    const dt = createDateTimePick({
      mount: dtMount,
      value: $('schRunAt')?.value ?? '',
      // 值写回同名 hidden input —— 保存那段照旧读 $('schRunAt').value，一行不用改
      onChange: (v) => {
        const h = $('schRunAt');
        if (h) h.value = v;
      },
    });
    // 这颗在弹窗右下角：往下开会顶出底边（.up 往上弹）、往左对齐会探出右边（.right 右缘对齐）
    dt.el.classList.add('up', 'right');
  }
  return out;
}



/** 这几种字段是下拉，值由 .combo 组件持有（不是 DOM 里的原生 <select>） */
export const SCH_COMBO_TYPES = ['repo', 'project', 'persona', 'flow'];



/**
 * 照**动作自己声明的字段**渲染参数区 —— 这里不写死任何动作的字段名。
 * 现在支持的字段类型：repo（已接入仓库）/ project（项目）/ persona（数字员工）/ number / text / textarea。
 * 「留空 = 不传这个参数」，由动作自己兜默认值（PR 巡检留空就是"所有仓库、自动对项目"）。
 *
 * 布局照「元舱的新建自动化」（2026-10-17 用户要求）：**左边输入、右边配置** ——
 *   · 左 = 要写的东西：textarea / 单行 text（做什么、名字这一类）；
 *   · 右 = 要选的东西：下拉 / 数字（交给谁、在哪个项目、保留几份这一类）。
 * 所以这里返回 `{ left, right }` 两段 HTML，弹窗把各自塞进左右两栏。
 *
 * 三个下拉只吐一个**挂载点**（`.sch-cfg`）：全站下拉统一用 `.combo` 公共组件
 * （原生 select 的弹出层不可控、也塞不进搜索框），而组件是 DOM 实例，拼不进 HTML 串。
 * 真正的控件由 mountSchConfigCombos() 在写进 DOM 之后装上去。
 */
export function schConfigFields(action, cfg) {
  const left = [];
  const right = [];
  for (const f of action?.fields ?? []) {
    const v = cfg?.[f.key];
    const key = esc(f.key);
    if (SCH_COMBO_TYPES.includes(f.type)) {
      // 选人**不给自动兜底**（写「选一个人」再拦必填）：定时派活悄悄落到某个默认员工身上，
      // 比报错难查得多 —— 半夜跑了、那个人不对、结果也没人看。
      // 必填的下拉（人 / 流程）也不加"（可留空 = …）"：那是句假话。
      // 提示文案动作自己可以改（`hint`）：仓库/项目那种"可留空"的默认说法不一定贴切。
      const hint =
        f.hint != null
          ? esc(f.hint)
          : f.required
            ? ''
            : `（可留空 = ${esc(f.empty ?? (f.type === 'repo' ? '全部' : '自动'))}）`;
      right.push(`<label>${esc(f.label)}${hint}</label><div class="sch-cfg" data-cfg="${key}"></div>`);
      continue;
    }
    if (f.type === 'number') {
      right.push(`<label>${esc(f.label)}</label>
        <div class="dlg-box" style="max-width:none">
          <input data-cfg="${key}" type="number" ${f.min != null ? `min="${f.min}"` : ''} ${f.max != null ? `max="${f.max}"` : ''} step="1" value="${esc(v ?? f.def ?? '')}" />
          ${f.suffix ? `<span class="dlg-box-u">${esc(f.suffix)}</span>` : ''}
        </div>`);
      continue;
    }
    // 自由文字：定时任务的主输入区，放**左边**。rows 由动作自己声明（4 行起，CSS 会再撑高）。
    if (f.type === 'textarea') {
      left.push(`<label>${esc(f.label)}</label>
        <textarea data-cfg="${key}" rows="${Number(f.rows) || 3}" placeholder="${esc(f.placeholder ?? '')}">${esc(v ?? '')}</textarea>`);
      continue;
    }
    left.push(`<label>${esc(f.label)}</label><input data-cfg="${key}" value="${esc(v ?? '')}" />`);
  }
  return { left: left.join(''), right: right.join('') };
}



/**
 * 把参数区里的下拉装成 `.combo`（全站公共组件）。
 * 返回 `Map<字段key, combo>` —— 读值也走这张表：原生控件没了，DOM 上读不到值。
 *
 * `flows` 只装**已发布**的流程模板（定时任务只跑已发布的，跟看板建卡同一口径）。
 */
export function mountSchConfigCombos(action, cfg, repos, projects, personas, flows) {
  const map = new Map();
  for (const f of action?.fields ?? []) {
    if (!SCH_COMBO_TYPES.includes(f.type)) continue;
    // ⚠️ 只找挂载点 `.sch-cfg`：`[data-cfg]` 也挂在输入框上，直接选会选错元素
    const mount = document.querySelector(`#schFields .sch-cfg[data-cfg="${f.key}"]`);
    if (!mount) continue;
    const items =
      f.type === 'repo'
        ? [{ id: '', label: f.empty ?? '全部' }, ...(repos ?? []).map((r) => ({ id: r.fullName, label: r.fullName }))]
        : f.type === 'project'
          ? [{ id: '', label: f.empty ?? '自动' }, ...(projects ?? []).map((p) => ({ id: p.id, label: p.name }))]
          : f.type === 'flow'
            // 一条都没发布时给一行**说明**（禁用不住的下拉会像"坏了"）：去工作台 › 工作流里发布
            ? (flows ?? []).length
              ? [{ id: '', label: f.empty ?? '选一条流程' }, ...(flows ?? []).map((x) => ({ id: x.id, label: x.name }))]
              : [{ id: '', label: '还没有已发布的流程' }]
            : [{ id: '', label: f.empty ?? '选一个人' }, ...(personas ?? []).map((p) => ({ id: p.id, label: p.name }))];
    map.set(
      f.key,
      createCombo({
        mount,
        items,
        value: String(cfg?.[f.key] ?? ''),
        // 仓库可能有几十个，给个搜索框；人和项目一般几个，不用
        search: f.type === 'repo' && items.length > 12,
        placeholder: f.type === 'repo' ? '找仓库…' : '搜…',
      }),
    );
  }
  return map;
}



/**
 * 从参数区收集 config：空值不传（让动作用自己的默认），数字字段转成数字。
 * 下拉读 `combos`（组件持有值），其余读 DOM。
 */
export function readSchConfig(fields, combos) {
  const out = {};
  for (const f of fields ?? []) {
    if (combos?.has(f.key)) {
      const v = combos.get(f.key).value();
      if (v !== '' && v != null) out[f.key] = v;
      continue;
    }
    const el = document.querySelector(`#schFields [data-cfg="${f.key}"]`);
    if (!el) continue;
    const raw = el.value;
    if (raw === '' || raw == null) continue;
    out[f.key] = f.type === 'number' ? Math.round(Number(raw)) : raw;
  }
  return out;
}



/**
 * 新建 / 编辑一个定时任务。
 *
 * **这个弹窗不认识任何具体动作**：动作清单、名字默认值、参数区全部来自注册表的声明。
 * 所以 PR 巡检的「仓库 / 项目」只是它自己的两个参数，不是弹窗里写死的下拉；
 * 备份动作只有「保留份数」，换个动作这两行就没了。
 */
export async function scheduleDialog(job) {
  let meta;
  try {
    meta = await api('/api/schedules');
  } catch (e) {
    return toast(e.message, 'error');
  }
  const repos = (await api('/api/git/repos').catch(() => ({ repos: [] }))).repos ?? [];
  const projects = (S.projects ?? []).length ? S.projects : (S.projects = (await api('/api/projects').catch(() => ({ projects: [] }))).projects ?? []);
  const cfg = job?.config ?? {};
  /*
   * 流程模板：只装**已发布**的（定时任务只跑已发布的，跟看板建卡同一口径）。
   * 走轻量清单而不是 `/api/workflows`：后者连带 100 条实例视图，只为一份名字不值。
   * 拿不到就当没有（下拉会说"还没有已发布的流程"）。
   */
  const allFlows = (await api('/api/workflows/templates').catch(() => ({ templates: [] }))).templates ?? [];
  const flows = allFlows.filter((t) => t.publishedAt);
  /*
   * 编辑老任务时它选的那条**可能已经下架**：照样列出来（名字后面标「未发布」），
   * 否则下拉会显示一串内部 id —— 人只会以为"坏了"。真去保存时服务端会拦下并说清原因。
   * 被**归档**的（2026-10-29 起）与下架是两回事：归档顺带清了 publishedAt，但栏上写「已归档」
   * 才说得清该去哪儿找它（工作台 › 工作流 › 底下那段）。
   */
  if (cfg.templateId && !flows.some((t) => t.id === cfg.templateId)) {
    const stale = allFlows.find((t) => t.id === cfg.templateId);
    if (stale) flows.push({ ...stale, name: `${stale.name}（${stale.archivedAt ? '已归档' : '未发布'}）` });
  }
  const min = meta.minMinutes ?? 5;
  const repeat0 = job?.repeat ?? 'interval';
  let curAction = (meta.actions ?? []).find((a) => a.id === (job?.action ?? meta.actions?.[0]?.id)) ?? null;

  const REPEAT_ITEMS = [
    { id: 'interval', label: '间隔' },
    { id: 'once', label: '单次' },
    { id: 'daily', label: '每天' },
    { id: 'weekly', label: '每周' },
    { id: 'biweekly', label: '每双周' },
    { id: 'monthly', label: '每月' },
    { id: 'yearly', label: '每年' },
  ];

  const dlg = document.createElement('dialog');
  dlg.className = 'sch-dlg';
  /*
   * 布局照「元舱的新建自动化」（2026-10-17 用户截图要求）：**左边输入、右边配置**。
   *   · 左 = 名字 + 动作声明的输入区（textarea/text），textarea 撑满高度；
   *   · 右 = 做法（换动作）+ 动作声明的下拉/数字 + 重复方式 + 启用。
   * 动作没声明输入区（PR 巡检 / 备份）时左边就只有名字，弹窗自然变矮。
   */
  const f0 = schConfigFields(curAction, cfg);
  dlg.innerHTML = `
    <form method="dialog">
      <b>${job ? '编辑定时任务' : '新建定时任务'}</b>
      <div class="dim" id="schActionHint" style="font-size:12px;margin:2px 0 2px">${esc(curAction?.hint ?? '')}</div>
      <div class="sch-cols" id="schFields">
        <div class="sch-left">
          <label>名字</label>
          <input id="schName" value="${esc(job?.name ?? curAction?.defaultName ?? '定时任务')}" placeholder="给它起个名字" />
          <div class="sch-left-fields" id="schLeftFields">${f0.left}</div>
        </div>
        <div class="sch-right" id="schRight">
          <!-- 「做法」是个小开关：绝大多数任务就是「说一句话交给谁」，
               换内置动作（PR 巡检 / 备份）的人才需要碰它。下拉用全站 .combo 组件。 -->
          <label>做法</label>
          <span id="schActionMount" title="换一种做法"></span>
          <div id="schRightFields">${f0.right}</div>
          <div class="dlg-row">
            <span class="dlg-box"><span class="dlg-box-k">重复：</span><span class="dlg-combo" id="schRepeatMount"></span></span>
            <span class="dlg-row-rest" id="schRepeatBody">${schRepeatBody(repeat0, job, min)}</span>
          </div>
          <label class="check sch-enable">
            <input id="schEnabled" type="checkbox" ${job ? (job.enabled ? 'checked' : '') : 'checked'} />
            <span>启用（到点就跑）</span>
          </label>
        </div>
      </div>
      <div class="dlg-actions">
        <span class="dim" style="flex:1;font-size:12px;align-self:center">保存后就生效，到点自动跑；列表里可以随时停用、改时间或改内容。</span>
        <button type="button" value="cancel">取消</button>
        <button class="primary" id="schOk" value="ok">${job ? '保存' : '创建'}</button>
      </div>
    </form>`;
  document.body.append(dlg);
  wireDialogHead(dlg.querySelector('form'));
  dlg.addEventListener('close', () => dlg.remove());

  // 参数区里的下拉（仓库 / 项目 / 选人 / 流程）—— 公共组件，值存在 combo 里，读值靠这张表
  let cfgCombos = mountSchConfigCombos(curAction, cfg, repos, projects, S.personas ?? [], flows);
  let repeatCombos = mountSchRepeatCombos(repeat0, job);

  // 「方式」：换动作 → 参数跟着换
  const actionCombo = createCombo({
    mount: $('schActionMount'),
    items: (meta.actions ?? []).map((a) => ({ id: a.id, label: a.label })),
    value: curAction?.id ?? '',
    onChange: (id) => {
      const prevDefault = curAction?.defaultName;
      curAction = (meta.actions ?? []).find((a) => a.id === id) ?? null;
      $('schActionHint').textContent = curAction?.hint ?? '';
      // 名字还是上一个动作的默认名（人没改过）→ 跟着换；改过就尊重人
      const nameEl = $('schName');
      if (!nameEl.value.trim() || nameEl.value.trim() === prevDefault) nameEl.value = curAction?.defaultName ?? '';
      const f1 = schConfigFields(curAction, cfg);
      $('schLeftFields').innerHTML = f1.left;
      $('schRightFields').innerHTML = f1.right;
      cfgCombos = mountSchConfigCombos(curAction, cfg, repos, projects, S.personas ?? [], flows);
    },
  });
  actionCombo.el.classList.add('sch-mode');

  // 「重复」：换方式 → 右边那块字段跟着换（间隔给分钟数，单次给日期时间，每天给几点…）
  const repeatCombo = createCombo({
    mount: $('schRepeatMount'),
    items: REPEAT_ITEMS,
    value: repeat0,
    onChange: (mode) => {
      $('schRepeatBody').innerHTML = schRepeatBody(mode, job, min);
      repeatCombos = mountSchRepeatCombos(mode, job);
    },
  });
  // 这一排在弹窗最下面，**往上弹**，否则开出来就被窗口底边切掉
  repeatCombo.el.classList.add('up');

  $('schOk').onclick = async (e) => {
    e.preventDefault();
    const name = $('schName').value.trim();
    if (!name) return toast('给它起个名字');
    const repeat = repeatCombo.value();
    const config = readSchConfig(curAction?.fields, cfgCombos);
    // 动作自己声明了必填（`required`）的，先在这儿拦一道 —— 服务端还会再拦一次，
    // 这里拦是为了"别让人填完时间才发现上面空着"，不用等一次往返。
    for (const f of curAction?.fields ?? []) {
      if (f.required && !String(config[f.key] ?? '').trim()) return toast(f.requiredText ?? `「${f.label}」还没填`);
    }
    const body = {
      name,
      action: actionCombo.value(),
      repeat,
      enabled: $('schEnabled').checked,
      config,
    };
    if (repeat === 'interval') {
      const everyMinutes = Math.round(Number($('schEvery').value));
      if (!Number.isFinite(everyMinutes) || everyMinutes < min) return toast(`间隔至少要 ${min} 分钟`);
      body.everyMinutes = everyMinutes;
    } else if (repeat === 'once') {
      const v = $('schRunAt').value;
      const t = Date.parse(v);
      if (!v || !Number.isFinite(t)) return toast('给一个有效的日期时间');
      body.runAt = new Date(t).toISOString();
    } else {
      body.atTime = $('schAt').value;
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(body.atTime)) return toast('时间要写成 HH:MM（比如 09:00）');
      if (repeat === 'weekly' || repeat === 'biweekly') body.weekday = Number(repeatCombos.wd.value());
      if (repeat === 'monthly' || repeat === 'yearly') body.dayOfMonth = Math.round(Number($('schDom').value));
      if (repeat === 'yearly') body.month = Number(repeatCombos.mo.value());
    }
    try {
      await api(job ? `/api/schedules/${encodeURIComponent(job.id)}` : '/api/schedules', {
        method: job ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      dlg.close();
      await renderSchedules();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  dlg.showModal();
  setTimeout(() => $('schName').focus(), 50);
}



/* 技能卡片墙的搜索词（2026-10-26 用户要求："加个搜索" —— 28 个技能靠滚找不着）。
   **不放进 S**：它只对这一页有意义，重进就清空；放全局状态里会被位置记忆之类的序列化
   顺手带走，也没人需要它跨页活着。 */
let skQ = '';

/**
 * 技能按搜索词过滤：命中**技能名 / 描述**任一处即留（不区分大小写）。
 * 正文（SKILL.md 的 Markdown）**不参与** —— 28 份方法论里"流程""代码"遍地都是，
 * 搜出来一大片命中，那不叫搜索。要翻正文就在详情页里找。
 */
function skillMatches(s, q) {
  return `${s.name}\n${s.description ?? ''}`.toLowerCase().includes(q);
}

export function renderSkillCards() {
  S.skill = null;
  skQ = ''; // 每次进这一页都从"看全部"开始，别把上次的词带进来
  showView('settings');
  const rows = S.skills ?? [];
  $('settingsView').innerHTML = `
    ${headRow('<b>技能</b>', `<div class="sk-search"><input id="skSearch" type="search" autocomplete="off" spellcheck="false" placeholder="搜技能名 / 描述" /></div>`)}
    <div class="detail-body">
      <section class="fx">
        <div class="fx-head">
          <label>全部技能 <span class="count" id="skCount">${rows.length}</span></label>
          <button class="btn-sm" id="skNew">＋ 新建技能</button>
        </div>
        <div id="skGrid"></div>
      </section>
    </div>`;
  $('skNew').onclick = (e) => openAddMenu(skillAddItems(), e.currentTarget);
  // 搜索：**只重画卡片墙**（#skGrid 与计数），不整页 innerHTML —— 整页重画输入框会失焦，
  // 打一个字框就瞎了、没法连着输（专家库那条踩过同一个坑）。
  $('skSearch').oninput = () => {
    skQ = $('skSearch').value;
    paintSkillGrid();
  };
  paintSkillGrid();
}

/** 技能卡片墙本体：读 S.skills 现画（首屏和搜索共用这一份）。筛选时计数显示「命中 / 总数」。 */
function paintSkillGrid() {
  const rows = S.skills ?? [];
  const q = skQ.trim().toLowerCase();
  const list = q ? rows.filter((s) => skillMatches(s, q)) : rows;
  $('skCount').textContent = q ? `${list.length} / ${rows.length}` : String(rows.length);
  $('skGrid').innerHTML = !rows.length
    ? '<div class="dim" style="padding:14px 16px">还没有技能 —— 点右上角「＋ 新建技能」，或从本地导入一个 SKILL.md。</div>'
    : list.length
      ? `<div class="sk-grid">${list
          .map(
            (s) => `<div class="sk-card${s.builtin ? ' builtin' : ''}" data-sk="${esc(s.name)}">
                    <div class="avatar skill">${esc(initial(s.name))}</div>
                    <div class="who">
                      <b>${esc(s.name)}${s.builtin ? '<em class="tag-dim" title="内置技能：只允许用，不许改（不能编辑、不能删、不能覆盖导入）">内置</em>' : ''}</b>
                      <div class="sub">${esc((s.description || '').trim() || '（还没写描述 —— 模型靠这一句决定什么时候用它）')}</div>
                    </div>
                  </div>`,
          )
          .join('')}</div>`
      : `<div class="empty" style="padding:36px 12px">没有匹配「${esc(skQ.trim())}」的技能 —— 试试技能名或描述里的词。</div>`;
  $('skGrid').querySelectorAll('[data-sk]').forEach((el) => {
    el.onclick = () => openSkill(el.dataset.sk).catch((e) => toast(e.message, 'error'));
  });
}



/* ＋ 的选择改成了浮层菜单（见 openAddMenu / skillAddItems） */

/** 新建：弹窗填三个字段 */
export function newSkill() {
  $('nSkillName').value = '';
  $('nSkillDesc').value = '';
  $('nSkillBody').value = '';
  $('skillDlg').showModal();
  setTimeout(() => $('nSkillName').focus(), 30);
}



/* ---------------------------------------------------------- 从本地导入 */

export let importFound = [];


export const importPicked = new Set();



export function renderImportList() {
  if (!importFound.length) {
    $('impList').innerHTML = '<div class="dim" style="padding:12px 2px">没扫到 SKILL.md</div>';
    return;
  }
  $('impList').innerHTML = importFound
    .map(
      (s, i) => `<label class="member">
        <input type="checkbox" value="${i}" ${importPicked.has(s.dir) ? 'checked' : ''} ${s.alreadyInPool ? 'disabled' : ''} />
        <span>${esc(s.name)}${s.alreadyInPool ? '<em class="tag-inline">库里已有</em>' : ''}</span>
        <em title="${esc(s.dir)}">${esc(cut(s.dir, 34))}</em>
      </label>`,
    )
    .join('');
  $('impList').querySelectorAll('input[type=checkbox]').forEach((el) => {
    el.onchange = () => {
      const s = importFound[Number(el.value)];
      if (el.checked) importPicked.add(s.dir);
      else importPicked.delete(s.dir);
    };
  });
}



export async function scanImport(root) {
  $('impHint').textContent = '扫描中…';
  try {
    const d = await post('/api/skills/discover', { root });
    importFound = d.found;
    importPicked.clear();
    for (const s of importFound) if (!s.alreadyInPool) importPicked.add(s.dir);
    const fresh = importFound.filter((s) => !s.alreadyInPool).length;
    $('impHint').textContent = `扫到 ${importFound.length} 个，其中 ${fresh} 个还没进库（已默认勾上）。`;
    renderImportList();
  } catch (err) {
    $('impHint').textContent = '';
    $('impList').innerHTML = `<div class="dim" style="padding:12px 2px">${failHtml(err)}</div>`;
  }
}



export function openImportDialog() {
  $('impRoot').value = S.repoRoot || '';
  $('impList').innerHTML = '';
  $('importDlg').showModal();
  scanImport($('impRoot').value);
}



export function renderSkillEditor(skill, isNew, linkedPersonas) {
  const filePath = `${S.skillsRoot || 'skills'}\\${skill.name}\\SKILL.md`;
  /* 内置技能 = 只读态（2026-10-22 用户拍板）：字段照常看得全，但改不了、删不了。
     闸真正在服务端（PUT/DELETE/覆盖导入都会 403），这里只是不摆按钮 —— 两边都要有。 */
  const ro = !!skill.builtin;
  // 左栏只写「设置」；页头是面包屑「设置 › 技能 › 名字」（2026-10-20 用户要求：
  // 点进详情页后顶部要面包屑），名字/描述/文件路径都在正文 hero 里，页头不重复。
  // 布局照**员工详情页**：hero（头像 + 名字 + 一句话 + 操作按钮）+ 分组卡片 + 左标签右内容。
  // 保存/删除从底部搬到了 hero 右侧的 .hero-actions —— 跟员工详情同一个位置（用户要求）。
  $('settingsView').innerHTML = `
    ${headRow(breadcrumb([{ label: '技能', to: 'skills' }, { label: skill.name }]))}
    <div class="detail-body">
      <div class="p-head">
        <div class="avatar">${esc(initial(skill.name))}</div>
        <div class="p-head-main">
          <h2>${esc(skill.name)}</h2>
          <div class="p-desc">${esc((skill.description || '').trim() || '（还没写描述 —— 模型靠这一句决定什么时候用它）')}</div>
          <div class="p-meta">
            <span class="pill">${
              linkedPersonas.length ? `${linkedPersonas.length} 个员工在用` : '还没挂给任何人'
            }</span>
            ${ro ? '<span class="pill builtin">内置 · 只读</span>' : ''}
          </div>
          <div class="dim" style="font-size:11.5px;margin-top:2px">${esc(filePath)}</div>
        </div>
        <div class="hero-actions">
          ${
            ro
              ? /* 只读态不摆「保存 / 删除」—— 闸在服务端，这里只是别给按不动的按钮 */ ''
              : '<button id="sSave">保存</button>\n          <button class="danger" id="sDelete">删除</button>'
          }
        </div>
      </div>

      <div class="group-title">内容</div>
      <div class="group">
        <div class="form-row">
          <div class="row-label">名字</div>
          <input value="${esc(skill.name)}" readonly />
        </div>
        <div class="form-row top">
          <div class="row-label" title="决定「什么时候该用它」—— 模型先看这一句">描述</div>
          <div>
            <textarea id="sDesc" style="height:76px" ${ro ? 'readonly' : ''}>${esc(skill.description)}</textarea>
            <div class="dim" style="font-size:11.5px;margin-top:6px">
              只存一行：敲了回车会被并成空格（它要进 SKILL.md 的 description 字段，也要在列表里显示成一行）。
            </div>
          </div>
        </div>
        <div class="form-row top">
          <div class="row-label" title="什么时候用、做什么、做完长什么样。别写长 —— 贵在少而准">正文（Markdown）</div>
          <div>
            <!-- 预览/编辑（2026-10-22 用户实报："这里还是 markdown 格式"）：跟人物详情页
                 「职责与身份设定」同一套框 —— markdown 写少读多，默认预览；编辑才出源码。
                 只读技能（内置）不给切段，只预览（textarea 也 readonly）。 -->
            <div class="instr-wrap">
              <div class="instr-head">
                <div class="counter" id="sBodyCount"></div>
                ${ro ? '' : `<div class="seg seg-sm" id="sBodySeg">
                  <button type="button" data-m="view" class="on">预览</button>
                  <button type="button" data-m="edit">编辑</button>
                </div>`}
              </div>
              <div id="sBodyView" class="md-view"></div>
              <textarea id="sBody" hidden ${ro ? 'readonly' : ''}>${esc(skill.body)}</textarea>
            </div>
          </div>
        </div>
      </div>

      <div class="fx-head" style="margin-top:22px">
        <div class="group-title" style="margin:0">挂载</div>
        <button class="btn-sm" id="sAssign">＋ 添加到数字员工</button>
      </div>
      <div class="group">
        <div class="form-row top">
          <div class="row-label">挂在哪些员工上</div>
          <div>
            <div class="chips">
              ${linkedPersonas.length
                ? linkedPersonas.map((p) => `<span class="chip" style="padding:1px 10px">${esc(p.name)}</span>`).join('')
                : '<span class="dim" style="font-size:12px">还没挂给任何人</span>'}
            </div>
          </div>
        </div>
      </div>
    </div>`;

  /*
   * 正文预览/编辑（2026-10-22）：跟人物详情页「职责与身份设定」同一套做法。
   *   · 预览渲染的是 textarea **现值**（当前草稿）—— 编辑一半切过去看到的就是刚写的，
   *     切回编辑一个字不少；
   *   · 编辑态随内容撑高（fitSBody），内层不出滚动条，滚动只留外层页面一条；
   *   · 只读技能（内置）：没有 #sBodySeg，监听带 ?. 兜底，停在预览。
   */
  const sBodyEl = $('sBody');
  const sBodyViewEl = $('sBodyView');
  const fitSBody = () => {
    if (!sBodyEl || sBodyEl.hidden) return;
    sBodyEl.style.height = 'auto';
    sBodyEl.style.height = `${sBodyEl.scrollHeight}px`;
  };
  const syncSBodyCount = () => {
    const c = $('sBodyCount');
    if (c) c.textContent = (sBodyEl?.value ?? '').trim().length + ' 字';
  };
  const renderSBodyView = () => {
    const val = sBodyEl?.value ?? '';
    sBodyViewEl.innerHTML = val.trim() ? mdRender(val) : '<div class="md-empty">还没写正文。</div>';
  };
  const setSBodyMode = (m) => {
    if (m === 'edit' && ro) return; // 内置技能只读，切不过去
    sBodyViewEl.hidden = m === 'edit';
    sBodyEl.hidden = m !== 'edit';
    if (m === 'edit') {
      fitSBody();
      sBodyEl.focus();
    } else {
      renderSBodyView();
    }
    $('sBodySeg')?.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
  };
  $('sBodySeg')?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-m]');
    if (b) setSBodyMode(b.dataset.m);
  });
  sBodyEl?.addEventListener('input', () => {
    syncSBodyCount();
    fitSBody();
  });
  syncSBodyCount();
  renderSBodyView();

  if ($('sSave')) $('sSave').onclick = async () => {
    try {
      await api('/api/skills/' + encodeURIComponent(skill.name), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: $('sDesc').value, body: $('sBody').value }),
      });
      await load();
      await openSkill(skill.name);
    } catch (err) { toast(err.message, 'error'); }
  };

  if ($('sDelete')) $('sDelete').onclick = async () => {
    if (!(await confirmDo(`删掉技能「${skill.name}」？\n文件会被删除，所有挂载一并解除。`))) return;
    try {
      await api('/api/skills/' + encodeURIComponent(skill.name), { method: 'DELETE' });
      S.skill = null;
      await load();
      openSettings('skills'); // 删完回卡片列表
    } catch (err) { toast(err.message, 'error'); }
  };


  $('sAssign').onclick = () => openSkillAssignDialog(skill.name, linkedPersonas.map((p) => p.id));
}



/* ------------------------------------ 技能 → 发给数字员工（反方向挂载） */

/**
 * 把一个**技能**发给若干个数字员工。
 *
 * 跟员工详情里的「关联技能」是**同一件事的反方向**（那张表的两个视角）：
 *   · 员工详情：给这个人挑几个技能
 *   · 这里：  把这个技能发给几个人
 * 两边落的是同一张表 persona_skills，所以页面上的名单天然一致 ——
 * 别把"方向"当成两套数据去做。
 *
 * 已经挂上的那些**列出来但点不动**（locked + 「已挂载」标签）：看得见现状，
 * 又不会让人重复点一遍；要解除去员工详情（那边才有 × 的入口）。
 */
export let skAssignSkill = null;


export let skAssignLinked = [];


export const skAssignPicked = new Set();



export function renderSkAssignList() {
  const q = ($('skAssignSearch').value || '').trim().toLowerCase();
  // 被锁员工不进名单（2026-10-23；2026-10-22 扩到内置员工）：专家包雇来的 + 出厂的喜儿，
  // 技能都随出厂定义固定，这里列出来也点不了（服务端同判据：experts.lockKindOf）
  const rows = (S.personas ?? [])
    .filter((p) => !String(p.id || '').startsWith('p-expert-') && !p.builtin)
    .filter((p) => !q || p.name.toLowerCase().includes(q));
  $('skAssignList').innerHTML = rows.length
    ? rows
        .map((p) => {
          const has = skAssignLinked.includes(p.id);
          return `<label class="member${has ? ' locked' : ''}">
            <input type="checkbox" value="${esc(p.id)}" ${has ? 'checked disabled' : skAssignPicked.has(p.id) ? 'checked' : ''} />
            <span>${esc(p.name)}${has ? '<em class="tag-inline">已挂载</em>' : ''}</span>
          </label>`;
        })
        .join('')
    : '<div class="dim" style="padding:10px 2px">没找到</div>';
  $('skAssignList').querySelectorAll('input:not([disabled])').forEach((el) => {
    el.onchange = () => {
      if (el.checked) skAssignPicked.add(el.value);
      else skAssignPicked.delete(el.value);
      paintSkAssignOk();
    };
  });
}



/** 底栏那颗按钮上的数字就是"这一次要加几个"（已在位的那些不算） */
export function paintSkAssignOk() {
  const n = skAssignPicked.size;
  const btn = $('skAssignOk');
  btn.textContent = n ? `添加（${n}）` : '添加';
  btn.disabled = !n;
}



export function openSkillAssignDialog(skillName, linkedIds) {
  skAssignSkill = skillName;
  skAssignLinked = linkedIds;
  skAssignPicked.clear();
  $('skAssignName').textContent = skillName;
  $('skAssignSearch').value = '';
  renderSkAssignList();
  paintSkAssignOk();
  $('skAssignDlg').showModal();
  setTimeout(() => $('skAssignSearch').focus(), 30);
}
