/* skills.mjs —— 技能、从 GitHub 挑仓库（放进弹窗里）、定时任务、从本地导入、技能 → 发给数字员工（反方向挂载）。
 * 2026-10-22 由 app.js（15537 行单文件）拆出，原生 ESM、无打包器；逻辑逐字搬运。 */
import { esc, mdRender, savePlace, setRoute, toast } from './shell.mjs';
import { ICON_BRANCH, ICON_COMMIT, ICON_EDIT, ICON_GEAR, ICON_PLAY, ICON_PUSH, ICON_SYNC, ICON_TAG, ICON_TRASH, api, createCombo, createDateTimePick, cut, failHtml, initial, post, wireDialogHead } from './ui.mjs';
import { load } from './state.mjs';
import { openSettings } from './settings.mjs';
import { setListTitle } from './flowpages.mjs';
import { breadcrumb, headRow } from './connectors.mjs';
import { confirmDo, askCheckbox } from './machine.mjs';
import { openAddMenu, renderList, showView, skillAddItems } from './contacts.mjs';
import { pickLocalDir } from './projects.mjs';
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
   * GitHub 连接：左栏只留**一个状态按钮**（2026-10-26 五改，用户："做成一个按钮区就行，
   * 点击打开弹窗，不要展示这么多"）。点开 openGitConnDlg 弹窗里才见令牌表单 / 断开。
   * 按钮跟着 listBody 一起重画，离开页面自动消失，不用挂清理钩子。
   */
  const connSide = `
    <div class="gr-side">
      <button type="button" class="gr-side-btn" id="gitConnOpen"
              title="${st.connected ? 'GitHub 连接设置：令牌、断开' : '连接 GitHub（令牌只存本机）'}">
        <span class="gr-dot${st.connected ? ' ok' : ''}"></span>
        <span class="gr-side-btn-label">${
          st.connected ? `GitHub 已连接${st.login ? ` · @${esc(st.login)}` : ''}` : 'GitHub 未连接 · 点击连接'
        }</span>
      </button>
    </div>`;

  // 左栏：面包屑照主从页的规矩画在列表顶上（renderPluginMaster 同款）
  setListTitle([{ label: '工作台', to: 'workbench' }, { label: '代码托管' }]);
  $('listAction').classList.remove('hidden');
  $('listAction').title = '添加仓库';
  $('listBody').innerHTML =
    connSide +
    (repos.length
      ? repos
          .map(
            (r) => `<div class="item${sel && r.id === sel.id ? ' active' : ''}" data-git-sel="${esc(r.id)}">
            <div class="who">
              <div class="line1"><b>${esc(r.fullName)}</b></div>
              <div class="line2" title="${esc(r.localPath)}">${esc(r.localPath)}</div>
            </div>
          </div>`,
          )
          .join('')
      : '<div class="empty" style="padding:32px 12px">还没有仓库，点左上角「＋」添加</div>');
  $('listBody').querySelectorAll('[data-git-sel]').forEach((el) => {
    el.onclick = () => {
      S.gitSel = el.dataset.gitSel;
      renderGitRepos(root).catch((e) => toast(e.message, 'error'));
    };
  });
  $('gitConnOpen')?.addEventListener('click', openGitConnDlg);

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
         <span class="dim" title="${esc(sel.localPath)}">${esc(sel.localPath)}</span>
         <div class="head-actions">
           <button class="mini gr-set-btn" data-git-settings="${esc(sel.id)}"
                   title="仓库设置：管理员 / 自动合并 / 默认分支 / 上次同步" aria-label="仓库设置">${ICON_GEAR}</button>
         </div>
       </div>
       <div class="plg-sec">
         <div class="plg-sec-head"><label class="plg-sec-title">提交</label><span class="dim" id="grChgHead"></span></div>
         <section class="fx"><div id="grChanges"><div class="sk-blank">读工作区…</div></div></section>
       </div>
       <div class="plg-sec">
         <div class="plg-sec-head">
           <label class="plg-sec-title">拉取请求</label><span class="dim" id="grPullsHead"></span>
           <button type="button" class="mini auto gr-pulls-refresh" id="grPullsRefresh" title="从 GitHub 重新取一次">刷新</button>
         </div>
         <section class="fx"><div id="grPulls"><div class="sk-blank">取 PR…</div></div></section>
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
   */
  const paintKeeperBtns = (repoId, kid) => {
    document.querySelectorAll('.gr-keeper-btn[data-k-cur]').forEach((b) => {
      b.dataset.kCur = kid ?? '';
      b.innerHTML = kid ? esc(keeperName(kid) || '未设置') : '<span class="dim">未设置</span>';
    });
    const repo = repos.find((r) => r.id === repoId);
    if (repo) repo.keeperPersonaId = kid || null;
  };
  const openGitSettingsDlg = (repo) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'gr-set-dlg';
    const form = document.createElement('form');
    form.method = 'dialog';
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
        <div class="info-row"><span>默认分支</span><b>${esc(repo.defaultBranch || '—')}</b></div>
        <div class="info-row"><span>上次同步</span><b>${syncAt(repo.lastSyncAt)}</b></div>
        <div class="info-row"><span>本地目录</span><b class="gr-set-path" title="${esc(repo.localPath)}">${esc(repo.localPath)}</b></div>
      </div>
      <div class="dlg-actions">
        <button type="button" class="mini auto gr-set-remove" id="grSetRemove"
                title="只移除记录，本地目录保留（低频、破坏性动作，收在设置里）">从清单移除…</button>
      </div>`;
    dlg.append(form);
    document.body.append(dlg);
    wireDialogHead(form);
    dlg.addEventListener('close', () => dlg.remove());

    form.querySelector('.gr-keeper-btn').onclick = (e) => openKeeperDlg(repo.id, e.currentTarget.dataset.kCur ?? '');
    form.querySelector('[data-automerge]').onchange = (e) => {
      repo.autoMerge = e.currentTarget.checked ? 1 : 0;
      saveRepoSettings(repo.id, { autoMerge: e.currentTarget.checked });
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
    const head = $('grPullsHead');
    if (!box) return;
    let prs = [];
    let state = null;
    try {
      const d = await api(`/api/git/repos/${encodeURIComponent(repo.id)}/prs`);
      prs = d.prs ?? [];
    } catch (e) {
      if (box.isConnected) box.innerHTML = `<div class="sk-blank">取不到 PR：${esc(e.message)}</div>`;
      return;
    }
    try {
      state = (await api(`/api/git/repos/${encodeURIComponent(repo.id)}/changes`)).state;
    } catch {
      /* 读不到本地状态就不画 CTA，PR 列表照常显示 */
    }
    if (!box.isConnected) return;
    if (head?.isConnected) head.textContent = prs.length ? `${prs.length} 条待合并` : '';

    const base = state?.base || repo.defaultBranch || 'main';
    const cur = state?.branch || '';
    const mine = prs.find((p) => p.headRef && p.headRef === cur);

    /* gate 一句话：绿/红/跑着/没有/没拿到 —— 合并按钮的可用性主要看它 */
    const checkPill = (c) => {
      const s = c?.state;
      if (s === 'success') return '<span class="gr-pr-check ok" title="检查全绿">gate ✓</span>';
      if (s === 'failure')
        return `<span class="gr-pr-check bad" title="红的是：${esc((c.failed ?? []).join('、') || '未命名检查')}">gate ✗</span>`;
      if (s === 'pending') return '<span class="gr-pr-check wait" title="还在跑">gate 运行中</span>';
      if (s === 'none') return '<span class="gr-pr-check none" title="这条提交没有检查">无检查</span>';
      return '<span class="gr-pr-check none" title="没查到检查状态（网络/权限）">检查未知</span>';
    };
    /* 合并为什么按不了：返回 null = 能合 */
    const blockReason = (p) => {
      if (p.draft) return '草稿不能合 —— 先去 GitHub 上标为可审阅';
      if (p.mergeable === false || p.mergeableState === 'dirty') return '有冲突，合不了 —— 先把 base 合进分支或在本地解决';
      if (p.mergeableState === 'behind') return '分支落后 base —— 先合并 base 再合（或等 GitHub 自动更新）';
      if (p.mergeableState === 'blocked') return '被分支保护规则挡着';
      if (p.checks?.state === 'pending') return '检查还在跑，等 gate 绿了再合';
      if (p.checks?.state === 'failure') return '检查没过（gate 红了），合并会被 GitHub 拒绝';
      if (p.checks?.state === 'unknown') return null; // 没拿到检查状态不拦 —— 由 GitHub 自己判，失败原话带回
      return null;
    };

    const rows = prs
      .map((p) => {
        const why = blockReason(p);
        const isMine = p.headRef && p.headRef === cur;
        return `<div class="gr-pr-row">
          <div class="gr-pr-main">
            <div class="gr-pr-title"><b>#${p.number}</b> ${esc(p.title)}
              ${p.draft ? '<span class="pill">草稿</span>' : ''}
              ${isMine ? '<span class="pill">当前分支</span>' : ''}
              ${p.taskId ? '<span class="pill" title="已经挂在一张任务卡上">已关联卡</span>' : ''}
              ${p.mergeableState === 'dirty' ? '<span class="pill bad">有冲突</span>' : ''}
            </div>
            <div class="gr-pr-sub">
              <span class="gr-pr-refs">${esc(p.headRef || '?')} → ${esc(p.baseRef || '?')}</span>
              <span class="dim">· ${esc(p.author || '?')}</span>
              ${checkPill(p.checks)}
              <a href="${esc(p.url)}" target="_blank" rel="noreferrer">去 GitHub 看</a>
            </div>
          </div>
          <div class="gr-cell-ops">
            <button type="button" class="mini auto" data-pr-merge="${p.number}"
                    ${why ? `disabled title="${esc(why)}"` : 'title="合并进 base（走平台令牌；本地会自动收尾）"'}>合并</button>
          </div>
        </div>`;
      })
      .join('');

    /*
     * 当前分支还没有 PR 时给一行 CTA：这是「建 PR」按钮的新家（导航条那颗去掉了）。
     * 条件都写清楚：在 base 上 / 工作区还脏 / 没有领先提交 → 不摆"建 PR"，只说明下一步。
     */
    let cta = '';
    if (!mine) {
      if (cur && cur !== base) {
        const ahead = state?.ahead;
        if (state?.dirtyCount) {
          cta = `<div class="gr-pr-cta">当前分支 <b>${esc(cur)}</b> 还有 ${state.dirtyCount} 个未提交改动 —— 先在「提交」里提交，再来建 PR。</div>`;
        } else if (ahead === 0) {
          cta = `<div class="gr-pr-cta dim">当前分支 <b>${esc(cur)}</b> 和 base（${esc(base)}）没有差异 —— 没有可建的 PR。</div>`;
        } else {
          const n = ahead === null ? '' : `（领先 ${esc(base)} ${ahead} 个提交）`;
          cta = `<div class="gr-pr-cta">
            <span>当前分支 <b>${esc(cur)}</b> 还没有 PR ${n}</span>
            <button type="button" class="mini auto" id="grPrCreate">建 PR</button>
          </div>`;
        }
      }
    }

    box.innerHTML =
      (rows || `<div class="sk-blank">没有待合并的 PR${cur && cur !== base ? '' : ''}</div>`) + cta;

    $('grPrCreate')?.addEventListener('click', () => openRepoPrDialog(repo, refresh));
    box.querySelectorAll('[data-pr-merge]').forEach((b) => {
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
   */
  const folderize = (items, keyPrefix) => {
    const folders = new Map();
    const plain = [];
    for (const it of items) {
      const i = it.name.indexOf('/');
      if (i > 0 && i < it.name.length - 1) {
        const k = it.name.slice(0, i);
        if (!folders.has(k)) folders.set(k, []);
        folders.get(k).push({ id: it.id, label: it.name.slice(i + 1), sub: true, icon: ICON_BRANCH, cls: 'br' });
      } else {
        plain.push({ id: it.id, label: it.name, icon: ICON_BRANCH, cls: 'br' });
      }
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
   * 下面分组：最近（reflog 派生）/ 本地 / 远程 / 标签，本地/远程里再按 `/` 前缀分文件夹。
   * 十三改（用户指 IDEA 截图："补充图标和缩进"）：操作条目各配语义图标
   * （同步/提交/推送/分支），分支叶子统一分支图标，标签用标签图标 —— 图标是灰的，
   * 名字才是主角；文件夹叶子的缩进由 sub: true（folderize）+ .combo-item.sub 管。
   * 标签 id 带 `tag:` 前缀，防止和同名分支混淆；切标签会进游离 HEAD，确认框里说清。
   * 旧的「拉取更新」（纯 fetch）被「更新项目」（pull）取代 —— 两个"拉"并存只会让人选错。
   */
  const branchItems = (b) => [
    { id: '__op-sync__', label: '更新项目', icon: ICON_SYNC },
    { id: '__op-commit__', label: '提交…', icon: ICON_COMMIT },
    { id: '__op-push__', label: '推送…', icon: ICON_PUSH },
    { id: '__op-new__', label: '新建分支…', icon: ICON_BRANCH },
    { id: '__op-manage__', label: '分支管理…', icon: ICON_BRANCH },
    ...(b.recent?.length ? [{ header: '最近', foldable: true }, ...b.recent.map((n) => ({ id: n, label: n, icon: ICON_BRANCH, cls: 'br' }))] : []),
    { header: '本地分支', foldable: true },
    ...folderize((b.local ?? []).map((n) => ({ id: n, name: n })), '本地'),
    ...(b.remote?.length ? [{ header: '远程分支', foldable: true }, ...folderize((b.remote ?? []).map((n) => ({ id: n, name: n.replace(/^origin\//, '') })), '远程')] : []),
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
      buttonText: (v) => v || '游离 HEAD',
      onChange: (id) => onBranchPick(repo, id, state.branch ?? '', combo),
      onOpen: async () => {
        try {
          combo.setItems(branchItems(await api(`/api/git/repos/${encodeURIComponent(repo.id)}/branches`)));
        } catch (e) {
          toast(e.message, 'error');
        }
      },
    });

    const dirty = state.dirty ?? [];
    const head = $('grChgHead');
    if (head?.isConnected) head.textContent = dirty.length ? `${dirty.length} 个未提交` : '';
    if (!dirty.length) {
      box.innerHTML = '<div class="sk-blank">工作区是干净的 —— 没有未提交的改动</div>';
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
    box.innerHTML = `
      <div class="gr-chg-split">
        <div class="gr-chg-list">${groupHtml('chg', '更改', tracked) + groupHtml('untr', '未版本管理的文件', untracked)}</div>
        <div class="gr-commit-side">
          <textarea id="grCommitMsg" placeholder="提交说明（Ctrl+Enter 提交）" rows="4"></textarea>
          <button type="button" class="primary" id="grCommitBtn">提交</button>
        </div>
      </div>`;

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
      commitBtn.disabled = true;
      try {
        const r = await post(`/api/git/repos/${encodeURIComponent(repo.id)}/commit`, payload);
        toast(`已提交 ${(r.committed?.sha ?? '').slice(0, 7)} 到 ${r.branch}（${r.files} 个文件）`);
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
    if (id === '__op-manage__') {
      combo.setValue(fallbackBranch);
      openBranchManageDlg(repo);
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
        <label>分支名（从当前所在位置拉出）</label>
        <input id="grNewBranchName" placeholder="例如：feat/search" autocomplete="off" />
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
   * 分支管理弹窗（2026-10-27）：把 IDEA 右击菜单里**对班底真有价值的两条**单独放一处 ——
   * 「与 base 比较」（只读）和「删分支」（本地 / 远端）。
   *
   * 为什么不做右击菜单：Web 里右击是浏览器/系统的（复制、检查…），抢它要拦 contextmenu，
   * 还跟"文本可选中"打架；也不把「删」塞进分支下拉的每一行 —— 那里点一下就是切分支，
   * 误点的代价完全不对称。所以收进一颗「分支管理…」：列表 → 每条两个动作，删除单独二次确认。
   *
   * 两条动作的护栏都在服务端（这里只是把话说清楚）：
   *   · 比较：三点 diff（base...分支），只读；
   *   · 删除：不能删 base / 当前分支；必须已合并进 base；远端只删 bandi/ 开头且没有开着的 PR。
   */
  function openBranchManageDlg(repo) {
    document.getElementById('grBranchMgrDlg')?.close();
    const apiRepo = (p) => `/api/git/repos/${encodeURIComponent(repo.id)}${p}`;
    const dlg = document.createElement('dialog');
    dlg.id = 'grBranchMgrDlg';
    dlg.style.width = '720px';
    dlg.innerHTML = `
      <form method="dialog">
        <b>分支管理 · ${esc(repo.fullName)}</b>
        <div id="grBrmBody"><div class="sk-blank">读分支…</div></div>
        <div class="dlg-actions"><button type="button" value="cancel">关闭</button></div>
      </form>`;
    document.body.append(dlg);
    wireDialogHead(dlg.querySelector('form'));
    dlg.addEventListener('close', () => dlg.remove());
    dlg.showModal();

    const body = $('grBrmBody');
    const baseName = () => repos.find((r) => r.id === repo.id)?.defaultBranch || 'main';
    const kindOf = (st) => ({ A: 'add', D: 'del', R: 'ren' })[st] || 'mod';
    const badgeOf = (st) => ({ A: '增', D: '删', R: '移', C: '拷', T: '型' })[st] || '改';

    const renderList = async () => {
      body.innerHTML = '<div class="sk-blank">读分支…</div>';
      let b;
      try {
        b = await api(apiRepo('/branches'));
      } catch (e) {
        body.innerHTML = `<div class="sk-blank">读不到分支：${esc(e.message)}</div>`;
        return;
      }
      if (!body.isConnected) return; // 弹窗已关
      const cur = b.current ?? '';
      const base = baseName();
      const row = (name, { remote = false } = {}) => {
        const short = name.replace(/^origin\//, '');
        const isCur = !remote && name === cur;
        const isBase = short === base;
        // 本地：当前分支 / base 不画删除；远端：只有 bandi/ 开头才有删除（服务端同口径）
        const canDel = remote ? /^bandi\//.test(short) : !isCur && !isBase;
        return `<div class="sk-row gr-br-row">
          <div class="sk-main"><b>${esc(name)}</b>${
            isCur ? ' <span class="pill">当前</span>' : ''
          }${isBase ? ' <span class="pill">base</span>' : ''}</div>
          <div class="gr-cell-ops">
            ${isBase ? '' : `<button type="button" class="mini auto" data-brm-compare="${esc(name)}">比较</button>`}
            ${
              canDel
                ? `<button type="button" class="mini auto" data-brm-del="${esc(name)}" data-brm-remote="${remote ? '1' : '0'}">删除</button>`
                : ''
            }
          </div>
        </div>`;
      };
      body.innerHTML = `
        <div class="gr-meta" style="margin:2px 0 6px">本地分支 · 当前 <b>${esc(cur || '游离 HEAD')}</b> · base <b>${esc(base)}</b></div>
        ${(b.local ?? []).map((n) => row(n)).join('') || '<div class="sk-blank">没有本地分支</div>'}
        <div class="gr-meta" style="margin:14px 0 6px">远程分支</div>
        ${
          (b.remote ?? []).map((n) => row(n, { remote: true })).join('') ||
          '<div class="sk-blank">没有远程分支（点「更新项目」拉一次）</div>'
        }`;
      body.querySelectorAll('[data-brm-compare]').forEach((btn) => {
        btn.onclick = () => showCompare(btn.dataset.brmCompare);
      });
      body.querySelectorAll('[data-brm-del]').forEach((btn) => {
        btn.onclick = async () => {
          const name = btn.dataset.brmDel;
          const remote = btn.dataset.brmRemote === '1';
          const ok = await confirmDo(
            `删${remote ? '远端' : '本地'}分支 ${name}？\n\n` +
              (remote
                ? `只删 bandi/ 开头的平台分支；还有开着的 PR、或还有没合并进 base 的提交，服务端会拒绝。`
                : `必须已经合并进 base（${baseName()}），不然服务端会拒绝 —— 平台不靠删分支丢代码。`),
            { ok: '删除', danger: true },
          );
          if (!ok) return;
          btn.disabled = true;
          btn.textContent = '删除中…';
          try {
            await post(apiRepo('/branch-delete'), { branch: name, remote });
            toast(`已删${remote ? '远端' : '本地'}分支 ${name}`);
            await renderList();
            await refresh();
          } catch (e) {
            btn.disabled = false;
            btn.textContent = '删除';
            toast(e.message, 'error');
          }
        };
      });
    };

    /* 与 base 比较：文件清单 → 点一行看该文件 diff（懒取，收起不销毁、再点不再拉） */
    const showCompare = async (name) => {
      body.innerHTML = '<div class="sk-blank">对比中…</div>';
      let cmp;
      try {
        cmp = await api(apiRepo(`/branch-diff?branch=${encodeURIComponent(name)}`));
      } catch (e) {
        body.innerHTML = `<div class="sk-blank">对比没成：${esc(e.message)}</div>`;
        return;
      }
      if (!body.isConnected) return;
      const rows = (cmp.files ?? [])
        .map(
          (f) => `<div class="gr-chg-row gr-br-file" data-brm-file="${esc(f.path)}">
            <span class="gr-chg-x gr-x-${kindOf(f.status)}">${esc(badgeOf(f.status))}</span>
            <span class="gr-chg-path" title="${esc(f.path)}">${esc(f.path)}${
              f.from ? ` <span class="dim">← ${esc(f.from)}</span>` : ''
            }</span>
          </div>
          <div class="gr-diff" hidden></div>`,
        )
        .join('');
      body.innerHTML = `
        <div class="gr-meta" style="margin:2px 0 10px">
          <b>${esc(cmp.branch)}</b> 与 base <b>${esc(cmp.base)}</b> 比较（base...分支）${
            cmp.shortstat ? ` ｜ ${esc(cmp.shortstat)}` : ''
          }
        </div>
        ${
          rows
            ? `<div class="gr-br-cmp">${rows}</div>`
            : '<div class="sk-blank">没有差异 —— 这条分支和 base 一样</div>'
        }
        <div class="dlg-actions" style="margin-top:12px">
          <button type="button" class="mini auto" id="grBrmBack">← 返回分支列表</button>
        </div>`;
      $('grBrmBack').onclick = () => renderList();
      body.querySelectorAll('[data-brm-file]').forEach((row) => {
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
                `/branch-diff/file?branch=${encodeURIComponent(name)}&path=${encodeURIComponent(row.dataset.brmFile)}`,
              ),
            );
            if (box.isConnected && !box.hidden) box.innerHTML = diffHtml(d.diff);
          } catch (e) {
            if (box.isConnected) box.innerHTML = `<div class="sk-blank">${esc(e.message)}</div>`;
          }
        };
      });
    };

    renderList();
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
  dlg.style.width = '620px';
  dlg.innerHTML = `
    <form method="dialog">
      <b>建 PR · ${esc(repo.fullName)}</b>
      <div class="gr-meta" style="margin:6px 0 10px">${esc(repo.localPath)}</div>

      <div id="prState"><div class="sk-blank">读工作区…</div></div>

      <div id="prForm" hidden>
        <label>PR 标题（一句话说清这个 PR 干了什么）</label>
        <input id="prTitle" placeholder="例如：代码托管：加建 PR 与手动合并" autocomplete="off" />
        <label>新分支名（改动只会落到这条新分支，base 不动）</label>
        <div class="row-with-btn">
          <input id="prBranch" autocomplete="off" />
          <button type="button" id="prBranchAgain" title="换一个带时间戳的名字（撞名时用）">换一个</button>
        </div>
        <label>合进哪个分支（base）</label>
        <input id="prBase" autocomplete="off" />
        <label>PR 描述</label>
        <textarea id="prBody" rows="3" placeholder="改了什么 + 怎么验的。没跑过验证就写「未验证」—— 别写「安全」「已修复」。"></textarea>
        <label class="check"><input type="checkbox" id="prDraft" />
          <span>先建成草稿<em>——草稿不会被自动合并，等你在 GitHub 上标为可审阅</em></span></label>
        <label class="check" id="prSecretWrap" hidden><input type="checkbox" id="prAllowSecrets" />
          <span>就是要提交这些文件<em>——推上去收不回来（git 历史里的凭据只能强推抹，公开仓库抹不掉）</em></span></label>
      </div>

      <div class="dlg-actions">
        <button type="button" value="cancel">关闭</button>
        <button class="primary" id="prSubmit" disabled>提交并建 PR</button>
      </div>
    </form>`;
  document.body.append(dlg);
  wireDialogHead(dlg.querySelector('form'));
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();

  /*
   * 「提交并建 PR」是这颗弹窗里唯一的提交按钮（不标 type="button"）：
   * 人敲完标题按回车就该走提交 —— 这是 `app.mjs:115-130` 那套约定的另一半，
   * 也是为什么「换一个」「合并」这些**必须**标 type="button"（否则回车会点到它们身上）。
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
    box.innerHTML = `
      <div class="gr-meta" style="margin:0 0 4px">
        当前分支 <b>${esc(state.branch)}</b> ｜ base <b>${esc(state.base || '未记录')}</b>
        ｜ 未提交 <b>${dirty}</b> 个文件 ｜ 领先 base <b>${esc(String(ahead))}</b>
      </div>
      ${
        dirty
          ? `<div class="counter left">要提交的 ${dirty} 个文件（含未跟踪的）：${esc(state.dirty.slice(0, 12).map((f) => f.path).join('、'))}${dirty > 12 ? ` 等 ${dirty} 个` : ''}</div>`
          : `<div class="counter left">工作区是干净的 —— 那就用当前分支上已提交、还没推的那些提交${state.aheadCommits?.length ? `：${esc(state.aheadCommits.slice(0, 5).map((c) => c.subject).join('；'))}` : ''}</div>`
      }
      ${
        state.secrets.length
          ? `<div class="counter left" style="color:var(--bad)">看着像凭据的文件：${esc(state.secrets.slice(0, 4).join('、'))}${state.secrets.length > 4 ? ` 等 ${state.secrets.length} 个` : ''}</div>`
          : ''
      }
      ${state.canShip ? '' : '<div class="counter left" style="color:var(--warn)">没有可提交的东西：工作区干净、当前分支也不领先 base。</div>'}`;
    $('prSecretWrap').hidden = !state.secrets.length;
    const form = $('prForm');
    form.hidden = !state.canShip;
    $('prSubmit').disabled = !state.canShip;
    if (!$('prBranch').value) $('prBranch').value = state.suggest ?? '';
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

  $('prBranchAgain')?.addEventListener('click', (e) => {
    e.preventDefault();
    const stamp = Date.now().toString(36).slice(-5);
    $('prBranch').value = `bandi/${String(repo.name ?? 'pr').replace(/[^\w.-]+/g, '-')}-${stamp}`;
  });

  /* ---------------- 提交（唯一的提交按钮；下半屏的 PR 列表 2026-10-27 已搬去详情页 PR 区） ---------------- */
  $('prSubmit')?.addEventListener('click', async (e) => {
    e.preventDefault();
    const title = $('prTitle').value.trim();
    if (!title) return toast('标题写一句 —— PR 标题是别人（和三个月后的你）唯一会看到的那句话');
    const btn = $('prSubmit');
    btn.disabled = true;
    btn.textContent = '提交推送中…';
    try {
      const r = await api(`/api/git/repos/${encodeURIComponent(repo.id)}/prs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          body: $('prBody').value,
          branch: $('prBranch').value.trim() || null,
          base: $('prBase').value.trim() || null,
          draft: $('prDraft').checked,
          allowSecrets: $('prAllowSecrets')?.checked === true,
        }),
      });
      toast(r.created ? `PR #${r.pr.number} 建好了：${r.pr.url}` : `这个分支已经有一个 open PR：#${r.pr.number}（没新建）`);
      /*
       * 建完就关窗 + 整页重画（2026-10-27）：PR 现在常驻在详情的「拉取请求」区，
       * 新 PR 应该立刻出现在那张清单上；留着一颗停在「提交推送中…」的弹窗只会让人以为卡死。
       */
      dlg.close();
      if (onDone) await onDone();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = '提交并建 PR';
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
  // 列表里要写清"在哪个项目里干"，得知道项目名（没加载过就补一次，失败不影响列表）
  const projects = (S.projects ?? []).length
    ? S.projects
    : (S.projects = (await api('/api/projects').catch(() => ({ projects: [] }))).projects ?? []);
  const actionOf = (id) => (data.actions ?? []).find((a) => a.id === id);
  const when = (iso) => (iso ? String(iso).replace('T', ' ').slice(0, 16) : '还没跑过');

  const resultOf = (j) => {
    if (!j.lastStatus) return '<span class="dim">还没跑过</span>';
    if (j.lastStatus === 'ok') return `<span style="color:var(--ok)">✓</span> ${esc(j.lastSummary || '完成')}`;
    return `<span style="color:var(--bad)">✗</span> ${esc(j.lastError || '失败了（没有原因）')}`;
  };

  const card = (j) => {
    // 「交给数字员工」这类任务，卡上最该看到的是**它到底要干什么**，不是动作名 ——
    // 五条任务都写着「交给数字员工」等于没写。所以把那句话（和交给谁、在哪个项目里）提到描述行最前面。
    const instr = String(j.config?.instruction ?? '').replace(/\s+/g, ' ').trim();
    const who = j.config?.personaId ? (S.personas ?? []).find((p) => p.id === j.config.personaId)?.name : null;
    // 项目 = 这次派活的工作空间。没选就不写（那时候他用的是自己的默认目录）
    const proj = j.config?.projectId ? (projects ?? []).find((p) => p.id === j.config.projectId)?.name : null;
    const lead = instr
      ? `交给${who ? `「${who}」` : '员工'}${proj ? `（在「${proj}」）` : ''}：${instr.length > 44 ? instr.slice(0, 43) + '…' : instr}`
      : '';
    /* 卡片形态（2026-10-20 用户要求"做成卡片"）：整行横条改成一格一格的卡。
       结构：第一行 名字+状态 → 第二行 要干什么+节拍 → 第三行 上次结果（原话）→ 底部动作。
       margin-top:auto 把动作压到卡底，多张卡并排时按钮齐平。 */
    return `
    <article class="sch-card">
      <div class="sch-card-top">
        <b>${esc(j.name)}</b>
        <span class="pill">${esc(actionOf(j.action)?.label ?? j.action)}</span>
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
             另外两个内置动作：「PR / Issue 巡检」—— 去 GitHub 看有没有人提 PR / issue，写成看板上的卡，
             顺手把已合并的收成「待验收」；「数据库备份」—— 把 bandi.db 导出一份到数据目录的 backups/，
             只留最近 N 份。动作是可插拔的，以后加新动作不用改调度核心。</div>`
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



/** 这三种字段是下拉，值由 .combo 组件持有（不是 DOM 里的原生 <select>） */
export const SCH_COMBO_TYPES = ['repo', 'project', 'persona'];



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
      // 提示文案动作自己可以改（`hint`）：仓库/项目那种"可留空"的默认说法不一定贴切。
      const hint =
        f.hint != null
          ? esc(f.hint)
          : f.type === 'persona'
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
 */
export function mountSchConfigCombos(action, cfg, repos, projects, personas) {
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

  // 参数区里的下拉（仓库 / 项目 / 选人）—— 公共组件，值存在 combo 里，读值靠这张表
  let cfgCombos = mountSchConfigCombos(curAction, cfg, repos, projects, S.personas ?? []);
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
      cfgCombos = mountSchConfigCombos(curAction, cfg, repos, projects, S.personas ?? []);
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
