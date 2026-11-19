/* misc.mjs —— 新建群、换群助手、绑定、列表项右键菜单（绑定）、版本提醒。
 * 2026-10-22 由 app.js（15537 行单文件）拆出，原生 ESM、无打包器；逻辑逐字搬运。
 * 2026-11-11 起「新建员工」整段撤掉（用户拍板：不保留自建员工，岗位固定、只能从专家库雇佣）。 */
import { esc, personLabel, restorePlace, roleNameOf, toast } from './shell.mjs';
import { api, createCombo } from './ui.mjs';
import { load } from './state.mjs';
import { openPluginForm, pluginFormId, refreshGroup } from './experts.mjs';
import { $, S } from './core.mjs';



/* ------------------------------------------------- 沙箱 / 权限的中文名（员工详情共用） */

/** 沙箱选项。带 blocked 的那两档实测在 headless 下跑不了命令，必须在界面上说清楚 */
/**
 * 权限的中文名。**id 是给运行时用的，界面上一律显示中文** ——
 * `read-only` 这种裸英文对用户没意义（DSH 里也是"完全权限"这么写的）。
 */
export const SANDBOX_LABEL = {
  // codex / dsh 这套
  'read-only': '仅可查看',
  'workspace-write': '工作区内读写',
  'danger-full-access': '完全权限',
  // claude 那套 id 完全不同，也得给中文名，否则界面上还是裸英文
  default: '默认',
  acceptEdits: '自动接受编辑',
  bypassPermissions: '完全权限',
  plan: '计划模式',
};



export function sandboxItems(runtime) {
  // 标签用中文名，**后面不挂解释**（如"（现在跑不了命令）"）——
  // 名字自己说得清，括号里的补充是噪音；全站统一（主聊天框、员工详情、流程对话栏都走这儿）。
  const list = runtime?.sandboxes ?? ['danger-full-access'];
  return list.map((s) => ({ id: s, label: SANDBOX_LABEL[s] ?? s }));
}



/* ---------------------------------------------------------------- 新建群 */

// 「群助手」下拉：员工可能很多，带搜索
// 2026-11-19：发起群聊只留群名 + 群助手，成员勾选去掉 —— 服务端建群时会把群助手
// 自动加进群成员（store.createGroup 把 assistantPersonaId 一并写进 group_members），
// 群里要再加人走聊天页的「拉人进群」。所以这里 onChange 不需要再重画成员格。
export const gAssistantCombo = createCombo({
  mount: $('gAssistantMount'),
  search: true,
  placeholder: '搜员工…',
});



export function openGroupDialog() {
  if (!S.personas.length) return toast('先建至少一个数字员工，群里只能放数字员工');
  $('gTitle').value = '';
  gAssistantCombo.setItems(S.personas.map((p) => ({ id: p.id, label: personLabel(p) })), false);
  gAssistantCombo.setValue(S.personas[0]?.id ?? '');
  $('groupDlg').showModal();
}



/* ------------------------------------------------------------ 换群助手 */

export function openAssistantDialog(thread) {
  /*
   * 说明行换搜索框（2026-11-15 用户实报）：「群助手是…」那句删掉，成员多时直接打字找人。
   * 口径与抽屉的「搜索群成员」一致：只按名字过滤（「拉人进群」的 #mSearch 已扩到姓名 + 岗位，2026-11-19）。
   * 搜索只重画 #aList —— radio 选中态由 assistantPersonaId 现算，重画不丢；
   * 选中的人被滤走也没关系，:checked 不在 DOM 里，提交时「没选 = 取消」的口径不变。
   */
  const paint = () => {
    const q = ($('aSearch').value || '').trim().toLowerCase();
    const rows = thread.members.filter((m) => !q || m.name.toLowerCase().includes(q));
    $('aList').innerHTML = rows.length
      ? rows
          .map(
            (m) => `<label class="member">
              <input type="radio" name="assistant" value="${m.personaId}"
                     ${m.personaId === thread.assistantPersonaId ? 'checked' : ''} />
              <span>${esc(m.name)}</span><em>${esc(roleNameOf(m) || '—')}</em>
            </label>`,
          )
          .join('')
      : '<div class="dim" style="padding:10px 2px">没找到</div>';
  };
  $('aSearch').value = '';
  paint();
  $('aSearch').oninput = paint;
  $('assistantDlg').dataset.thread = thread.id;
  /*
   * **提交接线**（2026-11-15 修的缺口）：以前这个弹窗只有 radios 和关闭 ——
   * 「就他了」点了只是关弹窗，选了等于没选，群助手原地不动（实报）。
   * 现在点他就真把选中的员工 PATCH 成群助手；弹窗由 form method=dialog 自己关。
   */
  $('aOk').onclick = async () => {
    const picked = $('aList').querySelector('input[name="assistant"]:checked')?.value;
    if (!picked) return; // 没选就点 = 取消
    const threadId = $('assistantDlg').dataset.thread;
    try {
      await api('/api/groups/' + encodeURIComponent(threadId), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assistantPersonaId: picked }),
      });
      await refreshGroup(threadId); // load + 重画抽屉 / 群详情，群助手行跟着变
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  $('assistantDlg').showModal();
  $('aSearch').focus(); // 打开就落在搜索框 —— 同 projLinkDlg 的手感，成员多时直接打字
}



/** 工作台里那个「＋」：打开当前插件的添加表单（manifest 的 split.master.add） */
export function openPluginAdd() {
  const plugin = S.plugins.find((p) => p.id === S.plugin);
  const add = plugin?.panel?.split?.master?.add;
  if (!plugin || !add) return;
  const all = [
    ...(plugin.panel.blocks ?? []),
    ...(plugin.panel.split?.detail?.actions ?? []),
    ...(plugin.panel.split?.detail?.blocks ?? []),
  ];
  const fb = all.find((x) => x.type === 'form' && pluginFormId(x) === add.form);
  if (fb) openPluginForm(plugin, fb, {});
  else toast(`manifest 里找不到表单「${add.form}」`);
}



/**
 * 启动：拉数据 → 回到上次的位置。
 * 多机节点子系统删除后不再有「已加入总机 → 节点状态页」的分岔，所有机器都走正常面板。
 */
export async function boot() {
  // 回到上次的位置（以前是写死 setNav('messages')：在哪个页面按 F5 都会被弹回消息页）
  load()
    .then(() => restorePlace())
    .catch((e) => { $('chat').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  startVersionWatch();
}



/* ---------------------------------------------------------------- 版本提醒 */
/*
 * 前端是**长活 SPA**：磁盘上的 app.js 换了，开着的页面不会自己换 JS ——
 * 2026-10-17 一天里踩了两回「点了没反应 / 看到的还是旧页面」，全是它：
 * 页面是几小时前加载的，点到的入口在新代码里有渲染分支、在旧代码里没有，于是原地不动。
 * 这里每 60 秒对一次 app.js 的指纹（mtime+size），变了就在右下角亮「刷新页面」提示条。
 * 为什么不自动 reload：人可能正打着一半字，自动刷新会把输入清掉 —— 提醒，让人自己挑时机。
 */
export function startVersionWatch() {
  let known = null;
  let told = false; // 同一轮变更只提醒一次，别每 60 秒都弹
  let timer = null;
  const check = async () => {
    let v;
    try {
      v = (await api('/api/web-version')).v;
    } catch (e) {
      /*
       * 401/403 = 这个页面的会话已经没了（被踢 / 过期）：它已经是"死页面"，
       * 再轮询只会每分钟往审计里留一条 401（2026-11-09 用户实拍：本机旧标签页
       * 一直开着就是这么刷的）。停掉，别让一个没人看的页面持续制造噪音；
       * 其它错误（服务没起来 / 正在重启）继续下轮再说，不打扰人。
       */
      if (e?.status === 401 || e?.status === 403) {
        if (timer) clearInterval(timer);
        timer = null;
        return;
      }
      return;
    }
    if (v == null) return;
    if (known === null) {
      known = v; // 首次只记账不比较：页面刚加载，谈不上"变没变"
      return;
    }
    if (v !== known && !told) {
      told = true;
      const bar = document.createElement('div');
      bar.id = 'verBanner';
      bar.style.cssText =
        'position:fixed;right:18px;bottom:18px;z-index:999;display:flex;gap:10px;align-items:center;' +
        'padding:10px 14px;border:1px solid var(--line);border-radius:10px;background:var(--panel);' +
        'box-shadow:0 6px 24px rgba(0,0,0,.14);font-size:13px;color:inherit';
      bar.innerHTML =
        '代码有更新，这个页面还是旧的。<button class="mini auto" id="verReload">刷新页面</button>';
      bar.querySelector('#verReload').onclick = () => location.reload();
      document.body.append(bar);
    }
  };
  check();
  timer = setInterval(check, 60000);
}
