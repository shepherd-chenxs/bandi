/* app.mjs —— 入口。2026-10-22 由 app.js（15537 行单文件）拆分而来：本体在 js/*.mjs（原生 ESM，无打包器）。
 * 结构：全部模块先求值（拓扑序），然后才执行这里的 boot 语句 —— 模块间 import 有环也安全。 */
import './js/shell.mjs';
import './js/ui.mjs';
import './js/state.mjs';
import './js/settings.mjs';
import './js/connectors.mjs';
import './js/machine.mjs';
import './js/listmenu.mjs';
import './js/contacts.mjs';
import './js/workflows.mjs';
import './js/projects.mjs';
import './js/flowpages.mjs';
import './js/skills.mjs';
import './js/chat.mjs';
import './js/groups.mjs';
import './js/experts.mjs';
import './js/core.mjs';
import './js/misc.mjs';

import { ROLE_SUGGEST, THEME_KEY, applyTheme, esc, readCollapsed, toast } from './js/shell.mjs';
import { api, closeHelpPop, hideTip, openCombo, post, showTip, tipAnchor, tipTimer, wireDialogHead } from './js/ui.mjs';
import { load, setNav } from './js/state.mjs';
import { openSettings } from './js/settings.mjs';
import { CRUMB_GO, connEditing, connSetTransport, connTransport, parseKeyValues, renderPlugins, renderRuntimes } from './js/connectors.mjs';
import { addRtFamily, testAddRuntimePath } from './js/machine.mjs';
import { closeCtxMenu, hideConversationRow, openCtxMenu, removeConversationForever, wipeScopeOf } from './js/listmenu.mjs';
import { addMenu, addMenuAnchor, closeAddMenu, contactAddItems, detailSave, openAddMenu, renderList } from './js/contacts.mjs';
import { newTemplateDialog } from './js/workflows.mjs';
import { kbRepaint, kbRepaintRows, projectDialog } from './js/projects.mjs';
import { doStartFlow, flowStart, openFlowStart, syncFlowTitle } from './js/flowpages.mjs';
import { importPicked, openSkill, renderSkAssignList, scanImport, skAssignPicked, skAssignSkill } from './js/skills.mjs';
import { closeMentionPop, insertMention, linkPersonaId, linkPicked, mentionPop, openConversation, openDetail, renderLinkList, searchRefreshDetail, send, setBusy, setComposer, stopChatRun, updateMentionPop } from './js/chat.mjs';
import { deleteSessionFromLog, memberPicked, renderMemberCandidates } from './js/groups.mjs';
import { closeDrawer, pluginMust, refreshGroup, renderPluginPanel } from './js/experts.mjs';
import { $, S } from './js/core.mjs';
import { boot, gAssistantCombo, openGroupDialog, openPluginAdd, pRuntimeCombo, pSandboxCombo, startVersionWatch } from './js/misc.mjs';



// 跟随系统时，系统切了也要跟着切
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (S.theme === 'system') applyTheme();
});



// 建议列表只此一份：填进 #roleSuggest（新建对话框与员工详情共用一个 datalist）
{
  const dl = document.getElementById('roleSuggest');
  if (dl) dl.innerHTML = ROLE_SUGGEST.map((r) => `<option value="${esc(r)}"></option>`).join('');
}



// 静态那些（index.html 里写死的 12 个）在加载时一次包完
document.querySelectorAll('dialog > form').forEach(wireDialogHead);



// 点别处 / Esc 一律收起。只装一次（不是每挂一颗「?」装一遍 —— 那会在重绘时攒下一堆）。
document.addEventListener('click', closeHelpPop);


document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeHelpPop();
});



document.addEventListener('mouseover', (e) => {
  const el = e.target.closest?.('[data-tip]');
  if (!el || el === tipAnchor) return;
  hideTip();
  tipAnchor = el;
  tipTimer = setTimeout(() => showTip(el), 100);
});


document.addEventListener('mouseout', (e) => {
  const el = e.target.closest?.('[data-tip]');
  if (!el) return;
  if (e.relatedTarget && el.contains(e.relatedTarget)) return; // 在元素内部挪不算离开
  hideTip();
});


// 键盘用户走焦点：立刻出，不等那 100ms
document.addEventListener('focusin', (e) => {
  const el = e.target.closest?.('[data-tip]');
  if (!el) return;
  hideTip();
  tipAnchor = el;
  showTip(el);
});


document.addEventListener('focusout', hideTip);


/* 滚动 / 换页 / 点下去一律立刻收起：提示是 fixed 定位、不会跟着元素走，
   留着它就是一条对不上位置、还指着别处按钮的假信息。 */
window.addEventListener('scroll', hideTip, true);


document.addEventListener('click', hideTip);



/**
 * 「取消」这一类按钮：**只负责关弹窗，不是提交**。
 *
 * 为什么必须显式标 `type="button"`（index.html 里那十几处都标了）：
 * 它排在动作区第一个，而 `<form>` 的"隐式提交"（在输入框里按回车）挑的是
 * **树序第一颗提交按钮** —— 不标 type 它就是那颗，于是粘完 API Key 顺手敲回车
 * 走的是「取消」：弹窗直接关掉、一个请求都不发，看着就是"保存不了"（2026-10-15 实测）。
 * 标了 type="button" 它退出提交按钮的行列，回车才会落到「保存」上。
 *
 * 代价是它不再自动关弹窗（`method="dialog"` 只对提交按钮生效），所以在这里补上。
 * 放在 document 上只挂一次：弹窗是随时重建的，逐个绑定既啰嗦又会漏。
 */
document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[type="button"][value="cancel"]');
  const dlg = btn?.closest('dialog');
  if (!dlg) return;
  e.preventDefault();
  dlg.close('cancel');
});



// 点组件外面收起（只挂一次，组件本身是随时重建的）
document.addEventListener('click', (e) => {
  if (openCombo && !e.target.closest('.combo')) openCombo.close();
});



$('connTransport').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tr]');
  if (b) connSetTransport(b.dataset.tr);
});



$('cOk').onclick = async (e) => {
  e.preventDefault();
  const id = $('cId').value.trim();
  const body = {
    id,
    label: $('cLabel').value.trim() || id,
    transport: connTransport,
    command: connTransport === 'stdio' ? $('cCommand').value.trim() : '',
    args: connTransport === 'stdio' ? $('cArgs').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [],
    cwd: connTransport === 'stdio' ? $('cCwd').value.trim() : '',
    url: connTransport === 'streamable-http' ? $('cUrl').value.trim() : '',
    bearerTokenEnv: connTransport === 'streamable-http' ? $('cBearer').value.trim() : '',
    runtimes: [...$('cRuntimes').querySelectorAll('input:checked')].map((el) => el.value),
  };
  // 凭据留空＝不动（新建时留空就是没有）
  const envText = $('cEnv').value.trim();
  if (envText || !connEditing) body.env = parseKeyValues(envText);
  const hdrText = $('cHdr').value.trim();
  if (hdrText || !connEditing) body.headers = parseKeyValues(hdrText);

  try {
    if (connEditing) {
      await api(`/api/connectors/${encodeURIComponent(connEditing.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } else {
      await post('/api/connectors', body);
    }
    $('connDlg').close();
    S.pluginTab = 'installed';
    await renderPlugins();
  } catch (err) {
    toast(err.message, 'error');
  }
};



// 一次委托，管全站所有面包屑。页面重建不用重新绑。
document.addEventListener('click', (e) => {
  const el = e.target.closest?.('[data-crumb-to]');
  if (!el) return;
  const go = CRUMB_GO[el.dataset.crumbTo];
  if (!go) return;
  e.preventDefault();
  Promise.resolve()
    .then(() => go(el.dataset.crumbArg ?? null))
    .catch((err) => toast(err?.message ?? String(err), 'error'));
});


$('addRtTest').onclick = testAddRuntimePath;



$('addRtOk').onclick = async (e) => {
  e.preventDefault();
  const path = $('addRtPath').value.trim();
  if (!path) {
    return toast('先填一个安装目录或可执行文件路径 —— 还没装的话，回列表看「未安装」那一行给的安装命令。');
  }
  try {
    // 不传 label：服务端会默认用协议族名（「Codex CLI」这种）。这类名字够了，
    // 让人先起个名是多余的一步 —— 真想改，详情页里有。
    await post(`/api/devices/${encodeURIComponent(S.rtDevice)}/runtimes`, {
      family: addRtFamily.id,
      path,
    });
    $('addRtDlg').close();
    await load(); // 员工的 Runtime 下拉要跟着多一项
    S.rtLevel = 'device';
    renderRuntimes();
  } catch (err) { toast(err.message, 'error'); }
};


document.addEventListener('click', (e) => {
  if (!addMenu) return;
  if (e.target.closest('.add-menu')) return; // 点在菜单里
  // 点在**打开它的那颗按钮**上就不收 —— 那颗按钮的 onclick 自己会处理（以前只认 #listAction，
  // 于是从主区那颗「＋ 新建技能」打开时，同一次点击冒泡到这儿就把它关掉了）
  if (addMenuAnchor?.contains(e.target)) return;
  closeAddMenu();
});

 // 原 let flushDetailSave（详情自动保存的回调槽，跨模块读写，2026-10-22 拆分时对象化）
window.addEventListener('pagehide', () => { if (detailSave.flush) detailSave.flush({ keepalive: true }); });



/* 点别处就把筛选弹层收起来（点层内不关：多选得能连着点） */
document.addEventListener('click', (e) => {
  if (e.target?.closest?.('.kbf')) return;
  const pop = $('kbFilterPop');
  if (pop && !pop.hidden) pop.hidden = true;
});



/**
 * Esc = 逐级往后退（清搜索词 → 二级退一级 → 收起），跟点「返回」同一条路。
 * 只在弹层开着时接管；层没开就什么都不做，别抢别处对话框的 Esc。
 */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const pop = $('kbFilterPop');
  if (!pop || pop.hidden) return;
  e.stopPropagation();
  if (S.kbSearch) {
    // 搜索词先清（焦点在搜索框时这一下由输入框自己吃掉，走不到这儿）
    S.kbSearch = '';
    kbRepaintRows();
  } else if (S.kbPane) {
    S.kbPane = '';
    kbRepaint();
    $('kbFilterBtn')?.focus();
  } else {
    pop.hidden = true;
  }
});



$('impScan').onclick = (e) => {
  e.preventDefault();
  const root = $('impRoot').value.trim();
  if (root) scanImport(root);
};



$('impOk').onclick = async (e) => {
  e.preventDefault();
  const dirs = [...importPicked];
  if (!dirs.length) return;
  try {
    const r = await post('/api/skills/import', { dirs });
    $('importDlg').close();
    await load();
    openSettings('skills');
    $('impHint').textContent = '';
    toast(`导入 ${r.imported.length} 个${r.skipped.length ? `，跳过 ${r.skipped.length} 个（${r.skipped.map((s) => s.name + '：' + s.reason).join('；')}）` : ''}`);
  } catch (err) { toast(err.message, 'error'); }
};



$('nSkillOk').onclick = async (e) => {
  e.preventDefault();
  const name = $('nSkillName').value.trim();
  if (!name) return toast('skill 需要个名字');
  try {
    const d = await post('/api/skills', {
      name,
      description: $('nSkillDesc').value,
      body: $('nSkillBody').value,
    });
    $('skillDlg').close();
    await load();
    await openSkill(d.skill.name);
  } catch (err) { toast(err.message, 'error'); }
};



$('skAssignSearch').oninput = renderSkAssignList;



$('skAssignOk').onclick = async (e) => {
  e.preventDefault();
  const ids = [...skAssignPicked];
  if (!ids.length) return;
  try {
    await post(`/api/skills/${encodeURIComponent(skAssignSkill)}/personas`, { personaIds: ids });
    $('skAssignDlg').close();
    // 重画技能页：上面那排「挂在哪些员工上」的芯片要跟着变
    await openSkill(skAssignSkill);
  } catch (err) { toast(err.message, 'error'); }
};



$('lkSearch').oninput = renderLinkList;



$('lkOk').onclick = async (e) => {
  e.preventDefault();
  const names = [...linkPicked];
  if (!names.length) return;
  try {
    await post(`/api/personas/${encodeURIComponent(linkPersonaId)}/skills`, { names });
    $('linkSkillDlg').close();
    await searchRefreshDetail();
  } catch (err) { toast(err.message, 'error'); }
};



/** 插件表单弹窗的提交 —— 只注册一次，弹窗里换的是 fields 和 block */
$('plgFormOk').onclick = async (e) => {
  e.preventDefault();
  const d = S.pluginFormDlg;
  if (!d) return;

  const values = {};
  $('plgFormBody').querySelectorAll('[data-field]').forEach((inp) => { values[inp.dataset.field] = inp.value.trim(); });
  const missing = (d.block.fields ?? []).filter((f) => f.required && !values[f.key]);
  if (missing.length) return toast('这几项得填：' + missing.map((f) => f.label).join('、'));

  $('plgFormOk').disabled = true;
  try {
    const sub = d.block.submit ?? {};
    const method = (sub.method || 'POST').toUpperCase();
    pluginMust(d.plugin, method, sub.api);          // 提交前照查白名单
    const opts = { method };
    if (method !== 'GET') {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(values);
    }
    await api(sub.api, opts);
    $('plgFormDlg').close();
    S.pluginFormDlg = null;
    await renderPluginPanel();
  } catch (err) {
    /*
     * 直接用 `err.message`：`api()`（2026-10-21 重设计）对 4xx 已经把服务端原文拼进去了
     * （「E1051：地址不要带端口，端口填在下面那一格。」），5xx 才是「E5005：服务异常」。
     * 这里**不再自己拼一遍 detail** —— 拼了会绕开 `clipLine` 的 160 字截断，
     * 一整段 fs 报错能把 toast 撑爆。完整原文在 err.detail 和控制台里。
     */
    toast(err.message, 'error');
  } finally {
    $('plgFormOk').disabled = false;
  }
};



$('mSearch').oninput = renderMemberCandidates;



$('mOk').onclick = async (e) => {
  e.preventDefault();
  const threadId = $('memberDlg').dataset.thread;
  const personaIds = [...memberPicked];
  if (!personaIds.length) return;
  try {
    await post(`/api/groups/${encodeURIComponent(threadId)}/members`, { personaIds });
    $('memberDlg').close();
    await refreshGroup(threadId);
  } catch (err) { toast(err.message, 'error'); }
};



// （群助手换人 → 重画成员格，由 gAssistantCombo 的 onChange 负责）

$('gOk').onclick = async (e) => {
  e.preventDefault();
  const assistantPersonaId = gAssistantCombo.value();
  const memberIds = [...$('gMembers').querySelectorAll('input:checked')].map((i) => i.value);
  /*
   * 群名**本地先拦**（2026-10-20 用户截图：空名点创建，弹「E1006：服务异常」）。
   * 空名根本不用发请求 —— 服务端对空标题回的是通用错误码，界面上就成了
   * "服务异常"，人只会以为系统坏了。这里是单纯的表单没填完。
   */
  const title = $('gTitle').value.trim();
  if (!title) {
    toast('先给群起个名字');
    $('gTitle').focus();
    return;
  }
  try {
    const d = await post('/api/groups', { title, assistantPersonaId, memberIds });
    $('groupDlg').close();
    await load();
    setNav('messages');
    await openConversation(d.conversation.id);
  } catch (err) { toast(err.message, 'error'); }
};



$('aOk').onclick = async (e) => {
  e.preventDefault();
  const threadId = $('assistantDlg').dataset.thread;
  const picked = $('aList').querySelector('input[name="assistant"]:checked');
  if (!picked) return;
  try {
    await api('/api/groups/' + encodeURIComponent(threadId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assistantPersonaId: picked.value }),
    });
    $('assistantDlg').close();
    await refreshGroup(threadId);
  } catch (err) { toast(err.message, 'error'); }
};



/* ---------------------------------------------------------------- 绑定 */

document.querySelectorAll('.nav-btn').forEach((b) => { b.onclick = () => setNav(b.dataset.nav); });


$('scrim').onclick = closeDrawer;



/* ------------------------------------------------ 列表项右键菜单（绑定） */
/*
 * ⚠️ 这一段**必须放在 boot 区**，不许写进 `renderList()`：列表每次 `innerHTML` 重建，
 *    写进去就会重复绑一次监听 —— 轻则同一个动作执行两遍，重则"删除"被执行两次。
 *
 * 为什么走**事件委托**：`#listBody` 是 index.html 里的常驻节点，行是每次重画的。
 * 右键只认带 `data-conv` 的行；空白处不命中 → 保留浏览器原生菜单（右键复制文字这类操作还得能用）。
 * 右键某行**不会**打开该会话：`contextmenu` 不触发 `click`，无需额外阻止。
 */
$('listBody').addEventListener('contextmenu', (e) => {
  const row = e.target.closest?.('[data-conv]');
  if (!row) return;
  const c =
    (S.conversations ?? []).find((x) => x.id === row.dataset.conv) ??
    (S.hiddenConversations ?? []).find((x) => x.id === row.dataset.conv);
  if (!c) return; // 列表刚重画、数据还没跟上：宁可弹原生菜单，也不要弹一个空菜单
  /*
   * 群也给菜单（2026-10-20 用户要求，跟单聊同一套）：删除 / 不显示。
   * 但群这两项的含义比 1:1 重（群没有聊天记录入口、历史是所有成员共享的），
   * 所以两个动作都带二次确认，文案单独写 —— 见 `dissolveGroup` / `removeConversationForever`。
   */
  e.preventDefault();
  const running = c.status === '跑中';
  /*
   * 「已归档」列表里的行（只在 hiddenConversations 里）：它本来就被收着，
   * 再给「不显示/归档」是废话，所以只留「删除」。
   */
  const alreadyHidden = !(S.conversations ?? []).some((x) => x.id === c.id);
  if (alreadyHidden) {
    /*
     * 「已归档」里只会有两种行（见 `archivedConvs`）：已解散的群、员工已删的单聊 ——
     * 都代表"一整档历史"，删下去是全清，菜单得说实话（`wipeScopeOf` 统一判）。
     */
    const wipe = wipeScopeOf(c);
    openCtxMenu(e.clientX, e.clientY, [
      {
        label: wipe ? '删除并清空聊天记录' : '删除',
        danger: true,
        disabled: running,
        why: running ? '这段还在跑，等它跑完或先终止再删' : '',
        run: () => removeConversationForever(c),
      },
    ]);
    return;
  }
  if (c.kind === 'group') {
    /*
     * 解散的群（2026-10-20 用户定稿）：这一行代表的是"这个群的**全部历史**"，
     * 所以第一项是「删除并清空聊天记录」—— 整群连记录一起清（后端按 dissolvedAt 分派）；
     * 第二项「归档」= 收进「已归档」留着（群都没了，"不显示"的语义不成立）。
     * 没解散的群照旧：「删除」删的是**最新这一段**（群和别的段不动），「不显示」整群暂收。
     */
    const dissolved = !!c.dissolvedAt;
    openCtxMenu(e.clientX, e.clientY, [
      {
        label: dissolved ? '删除并清空聊天记录' : '删除',
        danger: true,
        disabled: running,
        why: running ? '这个群还有一段在跑，等它跑完或先终止再删' : '',
        run: () => removeConversationForever(c),
      },
      dissolved
        ? { label: '归档', run: () => hideConversationRow(c, 'archive') }
        : // 群的「不显示」与单聊**同一个动作、同一个接口**：只写 hiddenAt，
          // 成员关系、群助手、记录全都不动（用户 2026-10-20 明确：不显示≠解散）。
          { label: '不显示', run: () => hideConversationRow(c) },
    ]);
    return;
  }
  /*
   * 单聊两项：
   *   · 员工还在 → 「删除」（删这一段）+「不显示」（不占行，聊天记录里照样看得到）
   *   · 员工已删 → 「删除并清空聊天记录」（这一行 = 这个人的全部历史，只删一段就会
   *                留下"看不见的冗余"：剩下的段还在「已归档」里，而他已经没有任何入口了）
   *               +「归档」（从界面彻底收走，数据留库）
   * 两个动作走同一个接口（`/api/conversations/:id`），后端按"人还在不在"分派。
   */
  const personaGone = !(S.personas ?? []).some((p) => p.id === c.personaId);
  const wipe = wipeScopeOf(c);
  openCtxMenu(e.clientX, e.clientY, [
    {
      label: wipe ? '删除并清空聊天记录' : '删除',
      danger: true,
      disabled: running,
      why: running
        ? wipe === 'persona' ? '他还有一段在跑，等它跑完或先终止再删' : '这段还在跑，等它跑完或先终止再删'
        : '',
      run: () => removeConversationForever(c),
    },
    personaGone
      ? { label: '归档', run: () => hideConversationRow(c, 'archive') }
      : { label: '不显示', run: () => hideConversationRow(c) },
  ]);
});



/*
 * 聊天记录抽屉里的行也能右键「删除」（2026-10-20 用户要求，单聊与群同一套）。
 *
 * 为什么也走**委托**：抽屉每次 `paintChatLogDrawer` 都会 `innerHTML` 重建，
 * 逐个绑定必然漏（跟左栏同一课）。`#drawer` 是常驻节点，挂在它上面一劳永逸。
 * 只认 `[data-log]` 行、且抽屉此时确实是「聊天记录」（群设置里没有这种行，双保险）。
 */
$('drawer').addEventListener('contextmenu', (e) => {
  const row = e.target.closest?.('[data-log]');
  if (!row || S.drawerKind !== 'log') return;
  const c = [...(S.conversations ?? []), ...(S.hiddenConversations ?? [])]
    .find((x) => x.id === row.dataset.log);
  if (!c) return;                       // 数据还没跟上：宁可弹原生菜单，也别弹空菜单
  e.preventDefault();
  const running = c.status === '跑中';
  // 整档清空（已解散的群 / 员工已删的单聊）：抽屉里删任何一段 = 全档清掉，菜单得说实话
  const wipe = wipeScopeOf(c);
  openCtxMenu(e.clientX, e.clientY, [
    {
      label: wipe ? '删除并清空聊天记录' : '删除',
      danger: true,
      disabled: running,
      why: running
        ? wipe === 'persona' ? '他还有一段在跑，等它跑完或先终止再删' : '这段还在跑，等它跑完或先终止再删'
        : '',
      run: () => deleteSessionFromLog(c),
    },
  ]);
});



// 点菜单外面收起。用 `mousedown` 而不是 `click`：项自己的 click 里已经先关了，
// 用 click 会跟它抢顺序（有时先关、有时后关，表现为"点了一下什么都没发生"）
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest?.('#ctxMenu')) closeCtxMenu();
});


// 滚动必须**capture**：列表在 #listBody 内滚，scroll 不冒泡到 window，
// 不 capture 的话菜单会钉在原地、跟着列表"到处跑"
window.addEventListener('scroll', closeCtxMenu, true);


window.addEventListener('blur', closeCtxMenu);


window.addEventListener('resize', closeCtxMenu);


// 键盘可达（P1-4）：上下键在**可用**项之间轮转；Esc 收起；
// Enter / Space 由 <button> 原生负责，不用自己接
$('ctxMenu').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeCtxMenu(); return; }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const items = [...$('ctxMenu').querySelectorAll('.ctx-item:not([disabled])')];
  if (!items.length) return;
  const at = items.indexOf(document.activeElement);
  const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
  items[at === -1 ? 0 : next]?.focus();
});



/**
 * 发起流程弹窗的确认。
 *
 * ⚠️ **必须在这儿绑（全局），不能放进 renderWorkbenchGrid**：
 * 那个函数只有渲染工作台时才跑，而"进流程页 / 在流程页刷新"根本不经过工作台 ——
 * 于是按钮没绑上，点它只会**提交表单把弹窗关掉**，什么都不发生、也不报错
 * （用户实报：点发起左边一点变化没有）。这是从"编排入口搬进工作台"那次留下的。
 */
$('fsOk').onclick = (e) => {
  e.preventDefault();
  doStartFlow();
};


// 流程名称：想法变了就跟着预填（用户自己动过名字之后就不再覆盖）
$('fsIntent').addEventListener('input', () => syncFlowTitle());


$('fsTitle').addEventListener('input', () => {
  flowStart.titleTouched = !!$('fsTitle').value.trim();
});



document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // 右键菜单优先：它压在最上面，Esc 先收它（抽屉开着时两层一起收也无害）
  closeCtxMenu();
  if (S.drawerOpen) closeDrawer();
});


// （下拉的"点别处收起"由公共组件的 click 监听统一处理）
$('search').addEventListener('input', (e) => { S.filter = e.target.value; renderList(); });


$('listAction').onclick = () =>
  S.nav === 'contacts' ? openAddMenu(contactAddItems())
  // 工作台：项目页的 ＋ = 新建项目；插件页的 ＋ = 插件 manifest 里的添加表单
  : S.nav === 'plugins' ? (S.projectList ? projectDialog() : openPluginAdd())
  // 工作流两种模式：编排模板（＋ = 新建模板）/ 看发起记录（＋ = 发起一条）
  : S.nav === 'workflows' ? (S.flowMode === 'run' ? openFlowStart(S.flowTemplate) : newTemplateDialog())
  : openGroupDialog();


// （Runtime 换值 → 同步沙箱选项，由 pRuntimeCombo 的 onChange 负责）

$('pOk').onclick = async (e) => {
  e.preventDefault();
  try {
    const d = await post('/api/personas', {
      name: $('pName').value, role: $('pRole').value, instructions: $('pInstr').value,
      runtime: pRuntimeCombo.value(), sandbox: pSandboxCombo.value(), cwd: $('pCwd').value,
    });
    $('personaDlg').close();
    $('pName').value = ''; $('pRole').value = ''; $('pInstr').value = '';
    await load();
    // 建完停在详情，好让人接着配他（要聊再点「发消息」）
    await openDetail(d.persona.id);
  } catch (err) { toast(err.message, 'error'); }
};



// ⚠️ 按**按钮自己的状态**判断走哪条路（stopping = 正在跑，点它是"停止生成"）。
//    别去依赖 S.running 那类会滞后于界面的状态：这个仓库里踩过 ——
//    依赖外部状态判断，结果按钮点不动，看着像"点了没反应"。
$('send').onclick = () =>
  ($('send').classList.contains('stopping') ? stopChatRun() : send()).catch((e) => toast(e.message, 'error'));



$('input').addEventListener('input', updateMentionPop);


$('input').addEventListener('click', updateMentionPop);


$('input').addEventListener('blur', () => setTimeout(closeMentionPop, 150));


$('input').addEventListener('keydown', (e) => {
  // 选人列表开着的时候，上下键和回车归它用
  if (mentionPop.open) {
    const n = mentionPop.matches.length;
    if (e.key === 'ArrowDown') { e.preventDefault(); mentionPop.index = (mentionPop.index + 1) % n; updateMentionPop(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); mentionPop.index = (mentionPop.index - 1 + n) % n; updateMentionPop(); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insertMention(mentionPop.index); return; }
    if (e.key === 'Escape') { e.preventDefault(); closeMentionPop(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send().catch((x) => toast(x.message, 'error')); }
});



setBusy(false);


// 主题要在首屏渲染前定下来，否则会闪一下深色再变浅色
try { S.theme = localStorage.getItem(THEME_KEY) || 'system'; } catch { S.theme = 'system'; }


S.secCollapsed = readCollapsed();


setComposer(false);

   // 还没选会话，输入区先收起
applyTheme();


boot();


startVersionWatch();
