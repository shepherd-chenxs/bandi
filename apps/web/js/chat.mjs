/* chat.mjs —— 进对话、发消息、输入框里的 @ 选人、员工详情、员工详情 →「任务」、关联技能。
 * 2026-10-22 由 app.js（15537 行单文件）拆出，原生 ESM、无打包器；逻辑逐字搬运。 */
import { esc, mdRender, savePlace, setRoute, toast } from './shell.mjs';
import { TYPING, AVATAR_FILE, api, createCombo, cut, dt, failHtml, initial, personaAvatar, personaByName, post, renderMarkdown, setHeaderBadge, smAvatar } from './ui.mjs';
import { load, setNav } from './state.mjs';
import { confirmDo } from './machine.mjs';
import { convDisplayName, openConversationSafe, toastConvErr } from './listmenu.mjs';
import { detailSave, refreshDeptSuggest, renderList, showView } from './contacts.mjs';
import { COL_STATUS, openProjectDetail, openTaskBoard, openTaskCardDialog, prPillOf } from './projects.mjs';
import { openFlowRun, setListTitle } from './flowpages.mjs';
import { openChatLogDrawer, openGroupDrawer } from './groups.mjs';
import { closeDrawer, fireExpert } from './experts.mjs';
import { $, S } from './core.mjs';
import { SANDBOX_LABEL, sandboxItems } from './misc.mjs';



/* -------------------------------------------------------------- 进对话 */

/**
 * 输入框里的「权限」选择。
 * 注意：班底的权限是**员工级**的字段（跟员工详情里那个是同一个），
 * 不是像 DSH 那样按会话存 —— 所以这里改的是这个员工的所有对话，界面上也说清楚。
 * 群里每个人权限不同，放一个假的没意义，直接不放。
 */
/**
 * 权限下拉的选项：**跟随员工默认** + 运行时支持的那几个权限。
 * 默认项是"收回提权"的入口 —— 提权最怕的就是忘了收回，所以必须有一键还原。
 */
export function permItems(rt) {
  return [{ id: '', label: '跟随员工默认' }, ...sandboxItems(rt)];
}



/**
 * **会话级**权限下拉。
 *
 * 语义：默认跟随员工；在这里选一个具体权限 = **只对这个会话生效**（不动员工本身）。
 * 选回「跟随员工默认」= 收回。
 *
 * 被覆盖时组合框会**高亮 + 标题写明**，因为提权最大的风险是"忘了收回"——
 * 那等于长期敞着一个口子。
 */
export function convPermCombo({ mount, conversationId, runtime, value, personaSandbox, onDone }) {
  mount.innerHTML = '';
  const items = permItems(runtime);
  if (!items.length) return null;
  const labelOf = (id) => (items.find((it) => it.id === id) ?? {}).label ?? String(id ?? '');
  // 员工默认权限的真实名（personaSandbox 为空 = 员工自己也没设，写「未设置」）。
  // 按钮上直接写它 —— "跟随员工默认"这种说法不写出来，是什么就展示什么（用户 2026-10-18）；
  // 清单里「跟随员工默认」那条照旧留着，当收回提权的入口。
  const realLabel = () => (personaSandbox ? labelOf(personaSandbox) || personaSandbox : '未设置');
  const combo = createCombo({
    mount,
    items,
    value: value ?? '',
    search: false,
    buttonText: (id) => (id ? labelOf(id) : realLabel()),
    onChange: async (id) => {
      try {
        await api('/api/conversations/' + encodeURIComponent(conversationId), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sandbox: id || null }),
        });
        paint(id);
        onDone?.();
      } catch (err) {
        toast(err.message, 'error');
        onDone?.();
      }
    },
  });
  const paint = (id) => {
    combo.el.classList.toggle('elevated', !!id);
    combo.el.title = id
      ? `这个会话单独设成了「${labelOf(id)}」——用完点这里选回「跟随员工默认」收回`
      : `员工默认（${realLabel()}）——想单独设就点开选`;
  };
  paint(combo.value());
  combo.el.classList.add('up'); // 往上弹（在输入区底部，往下弹会被切掉）
  return combo;
}



export function renderComposerPerm(d) {
  const mount = $('dPermMount');
  if (!mount) return;
  mount.innerHTML = '';
  if (d.conversation.kind === 'group') return;
  const rt = S.runtimes.find((x) => x.id === d.conversation.runtime) ?? null;
  convPermCombo({
    mount,
    conversationId: d.conversation.id,
    runtime: rt,
    value: d.conversation.sandbox,
    personaSandbox: d.conversation.personaSandbox,
    onDone: () => openConversation(d.conversation.id),
  });
}



/**
 * 把服务端给的模型清单变成下拉项。
 *
 * 显示**显示名**，不是 `id · 显示名`。id 是真正传给 CLI 的那个值没错，但它又长又带
 * 供应商前缀（`opencode-zen-free/longcat-2.5-preview-free` 有 40 个字符），拼上去
 * 浮层里几乎全被它占满 —— 而显示名正是配置里专门给人看的那个。
 *
 * 搜索不受影响：`createCombo` 过滤时**同时匹配 `id` 和 `label`**，按 id 照样搜得到。
 *
 * 唯一要防的是**重名**：不同供应商可能起一样的显示名，那时两条长得一模一样、
 * 选哪个分不出来。所以只在**确实撞名**时，给撞上的那几条补回 id。
 */
/**
 * 取某个运行时的模型清单，**60 秒内复用**。
 *
 * 为什么要缓存：以前只在点开下拉时读一次，现在输入区的按钮上要直接写出
 * "实际跑的是哪个模型"，所以每进一个会话都要读一遍。同一运行时下反复切会话
 * 没必要重复问（服务端那头是读 CLI 的配置文件，快归快，但也没必要每次都读）。
 * 60 秒是为了让"用户在 CLI 那边加了模型"这种事半分钟内能反映到界面上。
 */
export const MODEL_LIST_TTL_MS = 60 * 1000;


export const modelListCache = new Map();

 // runtimeId → { at, data }

export async function readModelList(runtimeId, { fresh = false } = {}) {
  const hit = modelListCache.get(runtimeId);
  if (!fresh && hit && Date.now() - hit.at < MODEL_LIST_TTL_MS) return hit.data;
  const data = await api('/api/runtimes/' + encodeURIComponent(runtimeId) + '/models');
  modelListCache.set(runtimeId, { at: Date.now(), data });
  return data;
}



export function modelItems(models) {
  const list = models ?? [];
  const seen = new Map();
  for (const m of list) {
    const n = String(m.name ?? '').trim();
    if (n) seen.set(n, (seen.get(n) ?? 0) + 1);
  }
  const itemOf = (m) => {
    const name = String(m.name ?? '').trim();
    if (!name) return { id: m.id, label: m.id }; // 配置里没显示名，只能拿 id 顶
    return { id: m.id, label: seen.get(name) > 1 ? `${name} · ${m.id}` : name };
  };

  /*
   * 按 id 的前缀分组（`供应商/模型名` 里那一段）。实测这台机器上正好两组：
   * workbuddy-ai (3) / opencode-zen-free (10)。
   *
   * 只有**一种**前缀时不加标题 —— 一个标题盖住全部条目，纯粹是噪音。
   * 没有斜杠的 id 归到「其他」。
   */
  const groups = new Map();
  for (const m of list) {
    const id = String(m.id ?? '');
    const at = id.indexOf('/');
    // 服务端可以自己指定分组（claude 的别名就是这样：id 是 `sonnet`，不该混进「其他」）
    const g = m.group != null ? String(m.group) : at > 0 ? id.slice(0, at) : '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(m);
  }
  if (groups.size < 2) return list.map(itemOf);

  const out = [];
  for (const [g, arr] of groups) {
    out.push({ header: g || '其他' });
    for (const m of arr) out.push(itemOf(m));
  }
  return out;
}



/**
 * **会话级**模型切换 —— 跟权限那颗一个模式，位置在发送按钮左边。
 *
 * 清单**直接问运行时**（服务端读 CLI 自己那份配置），不查任何本地账本 —— 见 cli-models.mjs。
 * 所以：
 *   · **只读一次**（这次会话里读过就记住；同一运行时下换会话复用缓存，要重读就重开会话）
 *   · **打开就后台读一次**：按钮上要写出"实际是哪个模型"，不能等点开才知道
 *   · **读不到不清空**：至少留着"跟随员工默认"，并把原因写进按钮的 title
 *
 * 语义和权限一样：默认跟随员工（员工没绑就是 CLI 自己的默认），
 * 在这儿选一个 = 只对这个会话生效；选回第一项 = 收回。
 */
export function convModelCombo({ mount, conversationId, runtime, value, personaModel, onDone }) {
  mount.innerHTML = '';
  const FOLLOW = '跟随员工默认';
  let items = [{ id: '', label: FOLLOW }];
  let loaded = false;
  let why = '';
  // CLI 自己的默认模型名（读到才有）：员工没绑模型时，真正跑的就是它
  let cliDefault = null;

  /** id → 人看的名字（清单里有就用它的显示名，没有就拿 id 顶） */
  const labelOfId = (id) => {
    const hit = items.find((it) => it.id === id && it.id);
    return hit && hit.label !== id ? hit.label : id;
  };

  const combo = createCombo({
    mount,
    items,
    value: value ?? '',
    search: true,
    placeholder: '搜模型…（id 或显示名）',
    empty: '没有匹配的模型',
    // 浮层右缘对齐**整个输入框**的右缘：这颗贴着窗口右边（右边只剩发送/停止按钮），
    // 只对齐按钮自己的右缘，和输入框边线之间会空出一截；左对齐更是直接探出窗口被切掉
    // （2026-10-17 用户实报"框被挡住了，右边应该跟框对齐"）。
    alignRightTo: () => mount.closest('.input-wrap'),
    onOpen: () => { void load(); },
    onChange: async (id) => {
      try {
        await api('/api/conversations/' + encodeURIComponent(conversationId), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: id || null }),
        });
        paint(id);
        onDone?.();
      } catch (err) {
        toast(err.message, 'error');
        onDone?.();
      }
    },
  });

  const paint = (id) => {
    /*
     * 按钮上**直接写出实际用哪个模型**（2026-10-17 用户要求）。
     * 以前只写在 title 里（要悬停才看得见），而"我这句话到底是哪个模型答的"
     * 是这个页面最该一眼看清的事。
     * 取值的顺序与实际派活一致：会话覆盖 → 员工绑定 → CLI 默认。
     */
    const effId = id || personaModel || cliDefault || '';
    const followLabel = effId ? `${FOLLOW}：${labelOfId(effId)}` : FOLLOW;
    // 第一项就是"跟随员工默认"，标签换成带模型名的写法（其余项不动）
    if (items[0] && items[0].id === '' && items[0].label !== followLabel) {
      items = [{ id: '', label: followLabel }, ...items.slice(1)];
      combo.setItems(items, true); // 保住当前值，别把人家选的模型冲掉
    }
    combo.el.classList.toggle('elevated', !!id); // 有覆盖时高亮：跟权限那颗一个信号
    combo.el.title = id
      ? `这个会话单独用了「${id}」——点这里可以换，或选回「${FOLLOW}」收回`
      : `${FOLLOW}${effId ? `（现在跑的是 ${effId}）` : '（CLI 自己的默认模型）'}${why ? `。${why}` : ''}`;
  };

  /** 读清单。失败不抛出去 —— 组合框照常能用，只是选项少。 */
  const load = async () => {
    if (loaded || !runtime) return;
    loaded = true;
    try {
      const d = await readModelList(runtime.id);
      const list = d.models ?? [];
      const cur = combo.value();
      const next = [{ id: '', label: FOLLOW }];
      // 当前值不在清单里也要留着 —— 清单可能读不到，不能把人家选着的模型弄丢
      if (cur && !list.some((m) => m.id === cur)) next.push({ id: cur, label: `（清单里没有）${cur}` });
      next.push(...modelItems(list));
      items = next;
      why = list.length ? '' : (d.error ?? '这个运行时的清单是空的');
      cliDefault = d.defaultModel ?? null;
      combo.setItems(items);
    } catch (err) {
      loaded = false; // 失败就当没读过，下次展开再试
      why = `取不到清单（${err.message}）`;
    }
    paint(combo.value());
  };

  paint(combo.value());
  // 不等点开：先把默认模型名读回来，按钮上才写得出来
  void load();
  combo.el.classList.add('up'); // 往上弹（在输入区底部，往下弹会被切掉）
  // 这颗下拉在发送按钮旁边（贴着窗口右边）—— 浮层得**右边缘对齐**，
  // 否则默认的 left:0 会让它在按钮右侧探出窗口
  combo.el.classList.add('right');
  return combo;
}



export function renderComposerModel(d) {
  const mount = $('dModelMount');
  if (!mount) return;
  mount.innerHTML = '';
  // 群里每个人的模型可能不同，放一个"这个会话的模型"没意义 —— 跟权限那颗同一个判断
  if (d.conversation.kind === 'group') return;
  convModelCombo({
    mount,
    conversationId: d.conversation.id,
    runtime: S.runtimes.find((x) => x.id === d.conversation.runtime) ?? null,
    value: d.conversation.model,
    personaModel: d.conversation.personaModel,
    onDone: () => openConversation(d.conversation.id),
  });
}



/**
 * 输入区的显隐。没选会话时收起来 —— 那时候敲字也发不出去，
 * 摆一个能打字、按了没反应的输入框是误导。
 */
export function setComposer(on) {
  const box = document.querySelector('.composer');
  if (box) box.classList.toggle('is-hidden', !on);
  const h = $('hint');
  if (h) {
    h.classList.toggle('is-hidden', !on);
    if (!on) h.textContent = '';
  }
}



/**
 * 只读输入区（2026-10-20）：**员工已删** 或 **群已解散** 的会话只能看历史、不能再聊。
 *
 * 为什么不是"藏起输入区"：藏了之后用户只会以为界面出问题了，还得自己猜为什么发不了。
 * 置灰 + 一句说明最直接。同时把权限/模型那几个工具收起 —— 人都没了，那些设置没有意义。
 *
 * `reason` 决定那句说明：`'gone'`（默认，员工已删）/ `'dissolved'`（群已解散）。
 * 两句话都只说明"为什么发不出去"，不复述记录还在不在 —— 记录就在上面看得见。
 */
export const READONLY_WHY = {
  gone: '这个员工已删除，只能查看聊天记录',
  dissolved: '这个群已解散，只能查看聊天记录',
};


export function setComposerReadonly(on, reason = 'gone') {
  const box = document.querySelector('.composer');
  const input = $('input');
  const send = $('send');
  const h = $('hint');
  if (box) box.classList.toggle('is-readonly', on);
  if (input) {
    input.disabled = on;
    input.placeholder = on ? READONLY_WHY[reason] ?? READONLY_WHY.gone : '说点什么…（Enter 发送，Shift+Enter 换行）';
  }
  if (send) send.disabled = on;
  if (h) {
    if (on) {
      h.classList.remove('is-hidden');
      h.textContent = READONLY_WHY[reason] ?? READONLY_WHY.gone;
    } else if (Object.values(READONLY_WHY).includes(h.textContent)) {
      // 换到一段能聊的会话：把上一次的只读说明擦掉（不然它会一直挂在那儿）。
      // 只认这两句文案 —— hint 还兼职"几秒后自己消失"的临时提示，别把人家的字擦了
      h.textContent = '';
    }
  }
}



export async function openConversation(id) {
  setRoute('conversation', { id });
  // 换会话/刷新视图时，先把上一次的事件流停掉
  closeMentionPop();
  if (S.es) { S.es.close(); S.es = null; }
  S.running = false;
  // 换会话清空没发出去的文字草稿 —— 别把 A 会话说了一半的话带到 B 会话（附件同理，见 resetAtts）。
  // 只在**真换了**会话时才清：同一段会话跑完的自动重开（收尾 300ms 后）不能把人正打着的字抹掉。
  if (S.conversation?.id !== id) $('input').value = '';

  const d = await api('/api/conversations/' + encodeURIComponent(id));
  S.conversation = d.conversation;
  // 这段会话是不是**一个字都没说过**（详情页「发消息」连点复用它，见 toMessages）。
  // 依据是服务端刚给的 messages，不是本地猜测 —— 零额外请求、刷新后结论一致。
  S.convEmpty = (d.messages || []).length === 0;
  savePlace();         // 记下正在看哪个会话，刷新后回到这儿
  setComposer(true);   // 有会话了，输入区才出来
  resetAtts();         // 换会话清掉没发出去的附件 —— 别把 A 会话的图带到 B 会话
  S.persona = S.personas.find((p) => p.id === d.conversation.personaId) || S.persona;
  /*
   * 员工已删的会话：**只能看、不能聊**（2026-10-20 用户要求）。
   * 这类会话不再归档、就留在消息列表里，点进来是只读的历史记录 —— 人没了，
   * 发出去也没人接，所以输入框置灰 + 一句说明，而不是让人敲完才发现发不出去。
   */
  const personaGone =
    d.conversation.kind !== 'group' && !(S.personas ?? []).some((p) => p.id === d.conversation.personaId);
  /*
   * 群已解散（2026-10-20 用户定）：**历史照旧留在消息列表里，点进来只读**。
   * 解散时成员关系与群助手都清了，发出去也没人能接 —— 跟"员工已删"同一个处理：
   * 输入框置灰 + 一句说明，而不是让人敲完才撞 409（E2049）。
   */
  const dissolved = d.conversation.kind === 'group' && !!d.conversation.dissolvedAt;
  setComposerReadonly(personaGone || dissolved, dissolved ? 'dissolved' : 'gone');
  // 换到别的会话时，抽屉里那套群成员设置就不再适用了。
  // 但**同一个群换一段会话**不该关：群设置是群级的，抽屉里看的就是这个群。
  if (S.drawerOpen && S.drawerThreadId !== id && S.drawerThreadId !== d.conversation.groupId) closeDrawer();
  // 进了对话就不算"在看群详情页"了（左侧列表高亮要跟着走）
  S.groupThreadId = null;

  const isGroup = d.conversation.kind === 'group';
  const running = d.conversation.status === '跑中';
  const badge = `<span class="badge ${esc(d.conversation.status)}">${esc(running ? TYPING : d.conversation.status)}</span>`;

  if (isGroup) {
    /*
     * 解散的群：成员名单已经清空（`members` 是空数组），再写 "0 人" 就是噪音；
     * 改标「已解散」，并且**不给群设置入口** —— 成员/群名/助手都没了，点开只能是空抽屉。
     * 「聊天记录」照旧留着：解散后它可能就是唯一能翻历史的入口（列表里只显示这一行）。
     */
    const metaSub = dissolved
      ? '<span class="dim" style="font-size:12px">已解散</span>'
      : `<span class="dim" style="font-size:12px">${d.conversation.members.length} 人</span>`;
    $('chatHead').innerHTML = `
      <div class="avatar grp sm">${esc(initial(d.conversation.title))}</div>
      <div class="meta">
        <div><b>${esc(d.conversation.title)}</b> ${dissolved ? '' : badge} ${metaSub}</div>
      </div>
      <button class="icon-btn" id="toNewConv" title="给这个群开一段新会话（一次任务一段；旧段留在聊天记录里）">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 11.5c0 3.3-3.6 6-8 6-1.2 0-2.3-.2-3.3-.6L4 19l1.2-3.4C4.4 14.6 4 13.1 4 11.5c0-3.3 3.6-6 8-6s8 2.7 8 6z" />
          <path d="M12 9v5M9.5 11.5h5" />
        </svg>
      </button>
      <button class="icon-btn" id="toChatLog" title="聊天记录">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3.6 12a8.4 8.4 0 1 0 2.6-6.1" />
          <path d="M3.6 4.6V10H9" />
          <path d="M12 8v4.4l3 1.8" />
        </svg>
      </button>
      ${dissolved ? '' : `<button class="icon-btn" id="toSettings" title="群设置">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <!-- 跟左栏「设置」同一版圆齿轮（index.html，2026-10-20 用户从候选稿里选的 F）。
               别再用"圆 + 八根短射线"那版 —— 看着就是个太阳（2026-10-24 用户实报）。 -->
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
      </button>`}`;
    if (!dissolved) $('toSettings').onclick = () => openGroupDrawer(d.conversation);
    // 群聊天记录（2026-10-20 用户要求）：抽屉列出这个群的会话（含被「不显示」的那条）
    $('toChatLog').onclick = () => openChatLogDrawer(d.conversation);
    // 新会话（2026-10-24）：解散的群开不了（服务端 E2049），按钮也不给
    if (!dissolved) $('toNewConv').onclick = () => startFreshConversation(d.conversation);
  } else {
    /*
     * 名字取法：员工还在 → 用他现在的名字（可能改过，personaName 来自 JOIN）；
     * 员工已删 → personaName 是 NULL，**不能回落到 S.persona**（那是上一个人的名字，
     * 会张冠李戴），退回这段会话自己的标题（convDisplayName 会剥掉「和 」前缀，
     * 不然页头会出现「和 和贺韬」这种叠字）；连标题都没有才写「员工已删」。
     * 头像同理：员工没了就别给「点进员工详情」的入口（点开是 404）。
     */
    const name = convDisplayName(d.conversation);
    const pHere = personaGone ? null : ((S.personas ?? []).find((x) => x.id === d.conversation.personaId) ?? null);
    $('chatHead').innerHTML = `
      ${smAvatar(name, personaGone ? '' : `clickable" data-detail="${esc(d.conversation.personaId)}" title="配置他的 agent CLI`, pHere)}
      <div class="meta">
        <div><b>${esc(name)}</b> ${badge}</div>
      </div>
      ${personaGone ? '' : `<button class="icon-btn" id="toNewConv" title="和TA另起一段全新会话 —— 不带之前的上下文；旧会话留在聊天记录里">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 11.5c0 3.3-3.6 6-8 6-1.2 0-2.3-.2-3.3-.6L4 19l1.2-3.4C4.4 14.6 4 13.1 4 11.5c0-3.3 3.6-6 8-6s8 2.7 8 6z" />
          <path d="M12 9v5M9.5 11.5h5" />
        </svg>
      </button>`}
      <button class="icon-btn" id="toChatLog" title="聊天记录">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3.6 12a8.4 8.4 0 1 0 2.6-6.1" />
          <path d="M3.6 4.6V10H9" />
          <path d="M12 8v4.4l3 1.8" />
        </svg>
      </button>`;
    // 点头像进员工详情（原来那个「员工详情」按钮去掉了，省地方）
    const detail = $('chatHead').querySelector('[data-detail]');
    if (detail) detail.onclick = () => openDetail(d.conversation.personaId);
    // 聊天记录（2026-10-20 落地）：右侧抽屉列出这个人的全部会话，点一条就回看/续聊
    $('toChatLog').onclick = () => openChatLogDrawer(d.conversation);
    // 新会话（2026-10-24）：员工都没了，开了也没人接 —— 不给按钮
    if (!personaGone) $('toNewConv').onclick = () => startFreshConversation(d.conversation);
  }

  renderComposerPerm(d);
  renderComposerModel(d);

  // 把 `runs` 一起给它：失败的运行在库里**没有消息**，只画 messages 就会"说了句话然后没了"
  drawMessages(d.messages, d.conversation.personaName || '', isGroup, d.runs);
  const last = d.runs[0];
  if (last && last.status === '跑中') attachStream(last.id, last.personaName);
  renderList();
}

/**
 * 聊天页头「新会话」（2026-10-24）：另起一段全新的，旧段留在聊天记录里不删。
 *   · 单聊 → POST /api/conversations（服务端对单聊**总是新建**，复用是前端「回到聊天」自己的逻辑）；
 *   · 群   → POST /api/groups/:id/sessions（群本来就是"一次任务一段"）。
 * 新段对员工是全新上下文：身份与技能会重新注入，他不记得上一段聊过什么 —— 这正是"新会话"的意义。
 * 口径：点列表/回到聊天 = 续旧；这颗按钮 = 起新。
 */
async function startFreshConversation(c) {
  try {
    const conv = c.kind === 'group'
      ? (await post('/api/groups/' + encodeURIComponent(c.groupId) + '/sessions', {})).conversation
      : (await post('/api/conversations', {
          personaId: c.personaId,
          title: '和 ' + ((S.personas ?? []).find((p) => p.id === c.personaId)?.name ?? convDisplayName(c)),
        })).conversation;
    // openConversationSafe：这段可能刚被另一个窗口删掉（E2047）—— 那边会说人话并收拾界面
    await openConversationSafe(conv.id);
    if (S.conversation?.id !== conv.id) return;
    await load();
    $('input').focus();
  } catch (err) { toastConvErr(err); }
}

/* ------------------------------------------------ 立成卡（2026-10-24） */

/*
 * 聊天派活**不进任务看板**（用户定的：不然闲聊一句就派活，看板很快糊掉）。
 * 立卡的唯一转正口在**输入区「＋」菜单的「任务卡」**（2026-10-24 从页头搬过去的）：
 * 把最近一轮活立成一张**真卡**（手工卡）—— 看板上好改状态、加描述、关联 PR，
 * 卡详情页里还能就地讨论；员工详情里聊天投影自动让位（服务端去重），同一件事只出现一次。
 * 工单会话（kind='exec'）自己就是任务卡，入口那层就不给（app.mjs 开菜单时按 kind 收掉这项）。
 */
export async function makeConversationCard(conv) {
  try {
    const out = await post('/api/conversations/' + encodeURIComponent(conv.id) + '/card');
    toast(out?.created ? '已立成任务卡 —— 到项目看板看它（讨论区就接着这场会话）' : '这场会话已经立过卡了');
  } catch (err) {
    toastConvErr(err);
  }
}



/* ------------------------------------------------ 员工报的产出路径 → 可点 */

/*
 * 员工在聊天里报产出只给相对路径（"你打开 design/v1.0.1/06-project-members.html 看一眼"），
 * 人得自己去目录里翻 —— 主理人 2026-10-24 原话："这个很难受"。
 * 这里把消息里**真实存在**的文件路径点亮成可点：点击用系统浏览器打开（本机模式走
 * /api/open；局域网模式服务在别的机器，直接新标签 —— 见 routes/workspace.mjs）。
 *
 * 侦测规则（宁缺毋滥，代码 pill 满天飞）：行内代码（非代码块）、无空格、以扩展名结尾，
 * 且含 / 或属于常见文档扩展名。存在性由服务端裁决（probe=1 只探不拉），结果按
 * (会话, 路径) 缓存 —— 同一路径不反复探。
 */
const FILE_PILL_CACHE = new Map();   // `${convId}|${path}` → true/false
const FILE_EXT_RE = /\.(html?|png|jpe?g|gif|webp|svg|pdf|md|txt|log|csv|xml|ya?ml|css|mjs|js|json)$/i;

function looksLikeFilePath(t) {
  if (!t || t.length > 200 || /\s/.test(t)) return false;
  if (!/\.[A-Za-z0-9]{1,6}$/.test(t)) return false;
  return t.includes('/') || FILE_EXT_RE.test(t);
}

/** 点亮一个 pill：挂点击 + 可点样式 */
function markFilePill(el) {
  el.dataset.file = '1';
  el.title = '点开看（系统浏览器）';
  el.onclick = () => openFilePath(el.textContent.trim());
}

/** 打开：本机模式让服务端拉系统浏览器；局域网模式自己开新标签 */
async function openFilePath(p) {
  const convId = S.conversation?.id;
  const url = location.origin + '/api/workspace/file?path=' + encodeURIComponent(p)
    + (convId ? '&conv=' + encodeURIComponent(convId) : '');
  const local = location.hostname === '127.0.0.1' || location.hostname === 'localhost';
  try {
    if (local) await post('/api/open', { url });
    else window.open(url, '_blank', 'noopener');
  } catch (e) { toast(e.message, 'error'); }
}

/** 扫一遍聊天里还没检查过的行内代码，把真实文件路径点亮 */
function linkifyFilePaths() {
  const convId = S.conversation?.id;
  if (!convId) return;
  for (const el of document.querySelectorAll('#chat code:not([data-file-checked])')) {
    el.dataset.fileChecked = '1';
    if (el.closest('pre')) continue;                       // 代码块里的不是路径
    const text = el.textContent.trim();
    if (!looksLikeFilePath(text)) continue;
    const key = convId + '|' + text;
    if (FILE_PILL_CACHE.get(key)) { markFilePill(el); continue; }
    if (FILE_PILL_CACHE.has(key)) continue;                // 已探过：不存在
    api(`/api/workspace/file?path=${encodeURIComponent(text)}&conv=${encodeURIComponent(convId)}&probe=1`)
      .then(() => { FILE_PILL_CACHE.set(key, true); markFilePill(el); })
      .catch(() => FILE_PILL_CACHE.set(key, false));
  }
}

// 消息一动就扫一遍：发消息插入、重画、流式收尾全走 #chat 的 childList —— 一个观察者全兜住。
// 只挂 childList（markFilePill 改的是属性），扫描自身不会触发自己。
new MutationObserver(() => linkifyFilePaths())
  .observe(document.getElementById('chat'), { childList: true, subtree: true });



/** 消息时间戳：`2026-10-19 14:42`（带年月日 —— 2026-10-19 用户要求；聊天可能跨天，只有时分看不出哪天） */
export function stampOf(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch {
    return '';
  }
}



export function bubble(role, text, name, who, showName = false, at = '', atts = null, meta = null) {
  const mine = role === 'user';
  const label = mine ? '我' : (who || name || '数字员工');
  // 头像带图（2026-10-22）：优先按名字找员工；群聊消息有 personaName 直接命中，
  // 1:1 改过名时名字可能对不上，再兜一层会话的 personaId
  const p = mine ? null
    : (personaByName(label)
      ?? (S.conversation?.personaId ? S.personas.find((x) => x.id === S.conversation.personaId) ?? null : null));
  // 时间放在气泡**外面**的下方（2026-10-19 用户要求，别塞在气泡里）：绝对定位，不占布局
  const t = at ? stampOf(at) : '';
  // 群聊显示名字时，名字放气泡**上面**（2026-10-23 用户要求，别挤在气泡里）：
  // 名字行 + 气泡包进一个纵向列，其余消息保持原结构不动
  const nameLine = showName && !mine ? `<div class="who-line">${esc(label)}</div>` : '';
  // 附件（2026-10-23）：图片直接画缩略图，其余文件给一颗可点的 chip（新标签页打开）
  const attsHtml = attsHtmlOf(atts);
  // 卡票（2026-10-24）：PM 建卡 / 卡片回执这类消息带 meta，气泡顶上画一张可点的票
  const ticket = cardTicketHtml(meta);
    return `<div class="row ${mine ? 'me' : ''}">
    ${mine ? smAvatar('我', 'me') : smAvatar(label, '', p)}
    ${nameLine
      ? `<div class="msg-main">${nameLine}<div class="bubble">${ticket}${renderMarkdown(text)}${attsHtml}</div></div>`
      : `<div class="bubble">${ticket}${renderMarkdown(text)}${attsHtml}</div>`}
    ${t ? `<div class="btime">${esc(t)}</div>` : ''}
  </div>`;
}

/*
 * 卡票（2026-10-24）：`meta = {type:'card', cardId, title, status, assignee}` 的消息，
 * 气泡顶上画一张票 —— 状态色点 + 标题 + 执行人，点它在**弹窗里**看卡（不离开这段对话）；
 * 角落那颗「看板」小按钮去任务看板（次入口，别抢主点击）。
 *
 * 票上的字段是**消息时刻的快照**（服务端落 meta 时写死的），不回查实时状态：
 * 聊天一屏可能好几张票，逐张回查太贵；点进详情页看的是实时的。
 * 状态色复用看板那套 --st-* 变量（COL_STATUS 反查列 key，class 同名）。
 *
 * ⚠️ 反查表必须**惰性建**：chat.mjs 和 projects.mjs 互相 import（循环依赖），
 * app.mjs 先加载 projects —— 它回头拉 chat 时 COL_STATUS 还在 TDZ 里，
 * 顶层一取整个模块图就炸（2026-10-24 实测：侧边栏全灭）。别的引用都在函数体内，
 * 求值晚于两个模块初始化完，没事；只有"模块顶层就要值"的写法会踩。
 */
let _colOfStatus = null;
const colOfStatus = () => (_colOfStatus ??= Object.fromEntries(Object.entries(COL_STATUS).map(([k, v]) => [v, k])));

export function cardTicketHtml(meta) {
  if (!meta || meta.type !== 'card' || !meta.cardId) return '';
  const col = colOfStatus()[meta.status] ?? 'other';
  return `<div class="card-ticket" data-card-ticket="${esc(meta.cardId)}" title="打开任务卡详情">
    <i class="ct-spine ${esc(col)}"></i>
    <div class="ct-head">
      <span class="ct-ico">📋</span><span class="ct-kind">任务卡</span><span class="ct-sep">·</span><span class="ct-status ${esc(col)}">${esc(meta.status || '')}</span>${meta.assignee ? `<span class="ct-sep">·</span><span class="ct-assignee">@${esc(meta.assignee)}</span>` : ''}
      <button type="button" class="ct-board" data-card-board="${esc(meta.cardId)}" title="在任务看板里看它">看板 ↗</button>
    </div>
    <div class="ct-row">
      <div class="ct-title">${esc(meta.title || '任务卡')}</div>
      <span class="ct-open">打开 →</span>
    </div>
  </div>`;
}

/** 给画出来的卡票接上点击：主点击**在弹窗里**打开卡，「看板」进任务看板 */
export function wireCardTickets(root) {
  (root ?? $('chat')).querySelectorAll('[data-card-ticket]').forEach((el) => {
    /*
     * 弹窗而不是整页（2026-10-26 用户拍板"不要嵌在这里"）：
     * 人在跟某人聊着，看见气泡顶上这张票，点它是"就手看一眼 / 补一句"。
     * 整页换掉等于把他从这段对话里拽走 —— 跟流程时间轴点「任务」是同一种处境，
     * 那边 2026-10-19 已经定成弹窗了（见 openTaskCardDialog 的说明），这里对齐。
     * 弹窗有全屏按钮（data-max），要看长描述/长讨论可以放大，不算憋。
     */
    el.onclick = () => {
      openTaskCardDialog(el.dataset.cardTicket).catch((e) => toast(e.message, 'error'));
    };
  });
  (root ?? $('chat')).querySelectorAll('[data-card-board]').forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      openTaskBoard().catch((err) => toast(err.message, 'error'));
    };
  });
}

/** 气泡里的附件区：图片铺缩略图，文件给 chip。空 = 什么也不画。 */
export function attsHtmlOf(atts) {
  if (!Array.isArray(atts) || !atts.length) return '';
  const isImg = (a) => (a.mime || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(a.name || '');
  const imgs = atts.filter(isImg);
  const files = atts.filter((a) => !isImg(a));
  const imgHtml = imgs.length
    ? `<div class="att-imgs">${imgs
        .map((a) => `<a href="${esc(a.url)}" target="_blank" rel="noopener"><img class="att-img" src="${esc(a.url)}" alt="${esc(a.name)}" title="${esc(a.name)}" loading="lazy"></a>`)
        .join('')}</div>`
    : '';
  const fileHtml = files.length
    ? `<div class="att-files">${files
        .map((a) => `<a class="att-file" href="${esc(a.url)}" target="_blank" rel="noopener" title="${esc(a.name)}">📄 ${esc(a.name)}</a>`)
        .join('')}</div>`
    : '';
  return imgHtml + fileHtml;
}



/**
 * 把**消息**和**没跑成的那几次运行**按时间合成一条时间线。
 *
 * 为什么要合：**失败的运行在库里没有 assistant 消息** —— 只画 messages 的话，
 * 用户看到的就是"我说了一句话，然后就没了"。失败原因只出现在那个实时气泡上，
 * 而它 300ms 后就被"从库里重画"冲掉了 —— 用户的原话是「报错信息一闪而逝」（2026-10-16 实报）。
 *
 * 为什么按**时间**而不是按 runId 配对：1:1 聊天派活时，**用户那条消息没有 runId**
 * （运行是派活之后才建的，见 dispatch.mjs 的 trigger）。配不上，时间线是这里唯一可靠的依据。
 */
export function timelineOf(msgs, runs) {
  const items = [];
  for (const m of msgs) items.push({ at: String(m.createdAt ?? ''), kind: 'msg', m });
  for (const r of runs ?? []) {
    // 只有**不是人主动停的**才值得留一条：点了停止是有意为之，不必在记录里再喊一声
    if (r.status !== '失败' && r.status !== '中断') continue;
    items.push({ at: String(r.endedAt ?? r.startedAt ?? ''), kind: 'fail', r });
  }
  // 同一时刻（同一毫秒落库）时消息排前面：失败是"那条消息之后"发生的事
  items.sort((a, b) => (a.at === b.at ? (a.kind === 'msg' ? -1 : 1) : a.at < b.at ? -1 : 1));
  return items;
}



/**
 * 从一大段报错里挑出**那句人话**。
 *
 * 为什么不能整段倒出来：起不来的那次，`error` 是子进程的 stderr —— 十几行 Node 堆栈，
 * 头三行是 `node:internal/...` / `throw err;` / `^`。整段贴在对话里，
 * 用户看到的是"一堵墙"，而真正有用的那句（`Error: Cannot find module '...'`）淹没在中间。
 * 全量不删，折在「完整报错」里 —— 要排查的人点一下就有。
 */
export function firstMeaningfulLine(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const noise = /^(throw err;?|\^|at\s|node:internal\/)/;
  const pick = lines.find((l) => !noise.test(l)) ?? lines[0] ?? '';
  return pick.length > 160 ? pick.slice(0, 160) + '…' : pick;
}



/**
 * 没跑成那一块。复用 `.step.bad` —— 跟实时气泡里那行是同一个样式。
 *
 * 头像（2026-10-26 修）：原来这里写死一个「!」方块，用户截图报「失败的时候员工头像没了」。
 * 一屏里全是同一个人的头像，突然换成符号，看着像另起一个系统号在说话，认不出是谁的活失败了。
 * 现在跟正常气泡走**同一个** `smAvatar` —— 头像图/配色都跟着人走；
 * 谁是执行者用 `r.personaName`（`listRuns` 已经 JOIN 出名字），1:1 老库兜会话那个人。
 * 「失败」这件事由气泡里的红字和页头徽标说，不需要头像再喊一遍。
 */
export function failBlock(r, showName = false) {
  const full = String(r.error ?? '').trim();
  const why = firstMeaningfulLine(full) || '运行失败（这次没留下原因）';
  // 原因本身就是退出码时**别再补一句**「（退出码 1）」—— 2026-10-26 用户截图里看到的是
  // 「没跑成：退出码 1（退出码 1）」，同一件事说了两遍，还是最没信息量的那件事。
  const code = r.exitCode == null || /退出码/.test(why) ? '' : `（退出码 ${r.exitCode}）`;
  // 只有"藏着更多东西"时才给折叠入口：短报错摊开就好，别多一颗要点开的东西
  const more =
    full.length > why.length + 20
      ? `<details class="fail-more"><summary>完整报错</summary><pre>${esc(full)}</pre></details>`
      : '';
  // 干活的那个人：群聊靠 run 自己的 personaName（一场里可能有几个人先后跑），1:1 兜会话的人
  const label = r?.personaName || S.conversation?.personaName || '数字员工';
  const p =
    personaByName(r?.personaName) ??
    (S.conversation?.personaId ? S.personas.find((x) => x.id === S.conversation.personaId) ?? null : null);
  // 群聊里的失败也要认得出是谁（跟气泡的 who-line 同一个位置、同一套样式）
  const nameLine = showName ? `<div class="who-line">${esc(label)}</div>` : '';
  return `<div class="row">
    ${smAvatar(label, '', p)}
    ${nameLine
      ? `<div class="msg-main">${nameLine}<div class="bubble"><div class="step bad">没跑成：${esc(why)}${esc(code)}</div>${more}</div></div>`
      : `<div class="bubble"><div class="step bad">没跑成：${esc(why)}${esc(code)}</div>${more}</div>`}
  </div>`;
}



export function drawMessages(msgs, name, isGroup = false, runs = []) {
  /*
   * `meta.silent` 的消息**不画**（2026-10-24）：那是平台给 agent 的唤醒指令
   * （卡片回执里 @建卡人"去跟进"那条）—— 它是 run 的触发器，得落库、agent 得读到，
   * 但它不是人说的话，摊在对话里就成了右边一条"我"没说过的系统话。
   * 给人看的回执是另一条：执行人名义的汇报，带卡票（见 notifyCardOwner 的注释）。
   */
  const items = timelineOf(msgs, runs).filter((it) => it.kind !== 'msg' || !it.m.meta?.silent);
  /*
   * 空会话**什么都不画**（2026-10-20 用户要求）：「和 X 还没有对话 / 在下面说第一句吧」
   * 这两行提示去掉了 —— 输入框就在下面，不需要再教一遍。
   */
  $('chat').innerHTML = items.length
    ? items
        .map((it) =>
          it.kind === 'msg'
            ? bubble(it.m.role, it.m.text, name, it.m.personaName, isGroup, it.m.createdAt, it.m.atts, it.m.meta)
            : failBlock(it.r, isGroup),
        )
        .join('')
    : '';
  wireCardTickets(); // 画完顺手接上卡票的点击（票是 innerHTML 画出来的，得逐张绑）
  scrollDown();
}


export const scrollDown = () => { $('chat').scrollTop = $('chat').scrollHeight; };



/* ---------------------------------------------------------------- 发消息 */

/* ------------------------------------------------------- 附件（2026-10-23） */

/** 还没发出去的附件：{file, name, size, mime}。换会话就清空 —— 别把 A 会话的图带到 B 会话 */
let pendingAtts = [];
let attSending = false;

const MAX_ATTS = 8;

export function addAtts(fileList) {
  const files = [...fileList ?? []];
  if (!files.length) return;
  for (const f of files) {
    if (pendingAtts.length >= MAX_ATTS) { toast(`一次最多带 ${MAX_ATTS} 个附件`, 'error'); break; }
    pendingAtts.push({ file: f, name: f.name || '图片.png', size: f.size, mime: f.type || '', localUrl: URL.createObjectURL(f) });
  }
  paintAtts();
}

export function clearAtts() {
  for (const a of pendingAtts) { try { URL.revokeObjectURL(a.localUrl); } catch { /* 已失效 */ } }
  pendingAtts = [];
  paintAtts();
}

/** 输入框上方的附件条：文件名 + 大小 + ✕。图片顺便给个小缩略图，让人知道贴了哪张 */
export function paintAtts() {
  const strip = $('attStrip');
  if (!strip) return;
  strip.classList.toggle('is-hidden', !pendingAtts.length);
  strip.innerHTML = pendingAtts
    .map((a, i) => {
      const kb = a.size >= 1048576 ? `${(a.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(a.size / 1024))} KB`;
      const img = (a.mime || '').startsWith('image/')
        ? `<img class="att-thumb" src="${esc(a.localUrl)}" alt="">`
        : '';
      return `<span class="att-chip" title="${esc(a.name)}">${img}<span class="att-name">${esc(a.name)}</span><span class="att-size">${kb}</span><button type="button" class="att-x" data-att-x="${i}" title="移除">×</button></span>`;
    })
    .join('');
  strip.querySelectorAll('[data-att-x]').forEach((b) => {
    b.onclick = () => {
      const [gone] = pendingAtts.splice(Number(b.dataset.attX), 1);
      try { URL.revokeObjectURL(gone?.localUrl); } catch { /* 已失效 */ }
      paintAtts();
    };
  });
}

/** 选文件 / 粘贴的公共入口。换会话时清空（openConversation 里调） */
export function resetAtts() {
  clearAtts();
}

export async function send() {
  const text = $('input').value.trim();
  // 光贴图不说话也能发（IM 的常识）；两者都没有才不动作
  if ((!text && !pendingAtts.length) || !S.conversation || S.running) return;
  // 附件还在上传中就别重复触发（上传是 send 里顺序做的，SENDING 只是防抖）
  if (attSending) return;
  // 说出第一句就不再是"空会话"了 —— 详情页「发消息」的连点复用靠它判断
  S.convEmpty = false;
  $('input').value = '';
  closeMentionPop();
  const name = S.conversation.personaName || S.persona?.name || '数字员工';
  const convId = S.conversation.id;

  // 附件先传（2026-10-23）：一次一个文件 POST 原始二进制，全成清单才发消息。
  // 失败就把原话放回输入框 —— 别让人打了半天字因为一张图传挂了全丢。
  let atts = null;
  const pending = pendingAtts;
  if (pending.length) {
    attSending = true;
    try {
      atts = [];
      for (const a of pending) {
        const d = await api(`/api/conversations/${encodeURIComponent(convId)}/files?name=${encodeURIComponent(a.name)}`, {
          method: 'POST',
          headers: { 'Content-Type': a.mime || 'application/octet-stream' },
          body: a.file,
        });
        atts.push({ name: d.file.name, stored: d.file.stored, size: d.file.size, mime: d.file.mime, url: d.file.url });
      }
    } catch (err) {
      toast(`附件没传上去：${err.message}`, 'error');
      $('input').value = text;
      return;
    } finally {
      attSending = false;
    }
  }

  $('chat').querySelector('.empty')?.remove();
  $('chat').insertAdjacentHTML('beforeend', bubble('user', text, name, undefined, false, new Date().toISOString(), atts));
  scrollDown();
  clearAtts();

  try {
    // 流程走的是 issue：在实例页里说话，不在这儿。这里就是普通聊天
    const d = await post('/api/conversations/' + encodeURIComponent(convId) + '/messages', { text, atts });
    attachStream(d.runId, d.personaName);
    // 群里 @ 多人（2026-10-24）：只有第一个当场开跑，其余排队 —— 说一声，别让人以为漏派了。
    // 前一个跑完服务端自动补派下一个，聊天页重开会话时会自己接上那条 run 的实时流。
    if (Array.isArray(d.queued) && d.queued.length) {
      toast(`已派给 ${d.personaName}；排队中：${d.queued.join('、')}（前一个跑完自动接上）`);
    }
    // 立刻刷一次左侧列表。
    // 服务端在写入这条消息时就会把它从"已从列表移除"里恢复（钉钉也是这个语义：
    // 删掉会话后只要有新消息，会话就回到列表）。但列表数据是前端缓存的，
    // 不主动刷就得等运行结束才更新 —— 那几十秒里会让人以为"消息发出去了却没记录"。
    await load();
  } catch (err) { toast(err.message, 'error'); load(); }
}



// 主对话里"正在跑的那次运行"（停止生成要用它）。
// 跟节点对话栏的 ncRunningId 是一个道理：S.running 只说明"忙不忙"，
// 点不到具体哪一条运行 —— 光有布尔量是停不掉的。
export let chatRunningId = null;



/**
 * 停止生成：掐掉这个会话里正在跑的那次运行。
 *
 * 走的是跟节点对话栏那颗方块按钮**同一个后端接口**（POST /api/runs/:id/abort）——
 * 服务端会先把这次标成"人停的"，再杀子进程，所以收尾时**不会记成失败**
 * （这两件事的先后顺序有讲究，见 server.mjs 里 abort 那段注释）。
 *
 * ⚠️ 这是"停止"，不是"暂停"：底层 runtime 都是一次性子进程，没有暂停/续跑这回事。
 *    停掉的是**这一轮运行**，不是这个人 —— 会话和上下文都还在，随时可以再说一句接着办。
 */
export async function stopChatRun() {
  const id = chatRunningId;
  if (!id) return;
  // 先让界面立刻停下来（点完就见效，不等后端回调）—— 跟节点对话栏一个做法
  S.running = false;
  chatRunningId = null;
  setBusy(false);
  setHeaderBadge('已停止');
  try {
    await api(`/api/runs/${encodeURIComponent(id)}/abort`, { method: 'POST' });
  } catch (e) {
    toast(e.message, 'error');
  }
  // 再按真实状态刷一次：收尾的钩子会把这次运行的产出/状态落库
  if (S.conversation) await openConversation(S.conversation.id).catch(() => {});
}



export function attachStream(runId, whoName = '') {
  if (S.es) S.es.close();
  S.running = true;
  chatRunningId = runId;
  setBusy(true);
  setHeaderBadge('跑中', TYPING);

  // 打字气泡的头像按名字找人（2026-10-23 修正）：群聊会话上没有 personaName，
  // 得用这次运行自己的执行者（POST 回体 / 运行记录 join 出来的 personaName），
  // 否则兜底成「数字员工」→ 头像显示成「数」字块
  const name = whoName || S.conversation.personaName || S.persona?.name || '数字员工';
  const convId = S.conversation.id;
  const id = 'live-' + runId;
  $('chat').insertAdjacentHTML('beforeend',
    `<div class="row" id="${id}">
       ${smAvatar(name, '', personaByName(name))}
       <div class="bubble"><div class="typing"><i></i><i></i><i></i></div></div>
     </div>`);
  scrollDown();

  const body = document.querySelector('#' + id + ' .bubble');
  // 思考过程开关跟随**这轮的执行者**（2026-10-24 修群聊失效）：
  // 会话上的 showThinking 是拿 conversations.personaId JOIN 员工表带出来的 ——
  // 单聊有值；群建会话时 personaId 故意置空（见 store/conversations.mjs），JOIN 出来是
  // NULL，以前这里就恒为 false，群里永远不显示。现在 NULL 时按正在干活的那个人的开关来。
  const showThinking = (S.conversation?.showThinking ?? personaByName(name)?.showThinking) === 1;
  const add = (cls, text, asHtml = false) => {
    body.querySelector('.typing')?.remove();
    const d = document.createElement('div');
    d.className = 'step ' + cls;
    if (asHtml) d.innerHTML = text; else d.textContent = text;
    body.appendChild(d);
    scrollDown();
  };

  let stopped = false;
  /**
   * 收尾唯一出口。
   * 状态永远以**服务端**为准，不靠客户端自己猜。
   */
  const stop = (status) => {
    if (stopped) return;
    stopped = true;
    if (S.es) { S.es.close(); S.es = null; }
    S.running = false;
    chatRunningId = null;
    setBusy(false);
    setHeaderBadge(status);
    setTimeout(() => openConversation(convId).then(load).catch(() => {}), 300);
  };

  // 实时输出走**共用**的 streamRun（流程实例页的节点对话也是它）
  S.es = streamRun(runId, {
    onText: (chunk) => add('text', renderMarkdown(chunk), true),
    onRunError: (msg) => add('bad', '· ' + firstMeaningfulLine(msg)),
    onThinking: (t) => showThinking && add('', '· 思考：' + t),
    onTool: (name) => showThinking && add('', '· 工具：' + name),
    onDone: (evt) => {
      // 这一行只是"立刻给你一句"；跑完 300ms 后整页从库里重画，
      // 那时由 failBlock 把它**留在回话里**（见 timelineOf 的注释）
      if (evt.status !== '完成') {
        const why = firstMeaningfulLine(evt.error) || '运行失败';
        add('bad', `${why}（退出码 ${evt.exitCode}）`);
      }
      stop(evt.status);
    },
    // 出错**不关连接**：EventSource 自带断线重连，而服务端 subscribe() 会把这次运行
    // 缓存过的事件重放一遍（含 __done），所以重连本身就能把状态补齐。
    // 这里只补一次状态查询，兜「服务重启 → 运行已不在内存里 → 重连拿到 404」这一种情况。
    onReconnect: async () => {
      if (stopped) return;
      try {
        const d = await api('/api/conversations/' + encodeURIComponent(convId));
        if (d.conversation.status !== '跑中') stop(d.conversation.status);
      } catch { /* 服务不可达：让 EventSource 自己继续重试 */ }
    },
  });
}



/**
 * 订阅一次运行的实时输出 —— **对话场景只写一遍**。
 *
 * 现在有两处对话：消息模块的会话、流程实例页的节点对话。两边都要
 * "边跑边看、跑完收尾"，以前各写一份，于是改一处漏一处
 * （「正在输入中」不亮、要刷新才看到回复，都是这么来的）。
 *
 * 事件是**分块**推的（不是逐 token），所以文本块按顺序追加即可，不用自己攒。
 *
 * @param {string} runId
 * @param {object} h
 *   onText(chunk)        他的回话（追加）
 *   onRunError(message)  运行报错
 *   onThinking(text)     思考（调用方自己决定显不显示）
 *   onTool(name)         工具调用
 *   onDone(evt)          **唯一收尾出口**：{ status, error, exitCode }
 *   onReconnect()        断线（EventSource 自己会重连，这里问一次服务端兜底）
 * @returns {{ close: () => void }}
 */
export function streamRun(runId, h = {}) {
  let closed = false;
  const es = new EventSource('/api/runs/' + encodeURIComponent(runId) + '/stream');
  const close = () => {
    if (closed) return;
    closed = true;
    es.close();
  };
  es.onmessage = (e) => {
    let evt;
    try {
      evt = JSON.parse(e.data);
    } catch {
      return;
    }
    if (evt.type === '__done') {
      close();
      return h.onDone?.(evt);
    }
    if (evt.type === 'text') return h.onText?.(evt.text);
    if (evt.type === 'error') return h.onRunError?.(evt.message);
    if (evt.type === 'thinking') return h.onThinking?.(evt.text);
    if (evt.type === 'tool') return h.onTool?.(evt.name);
  };
  es.onerror = () => {
    if (!closed) h.onReconnect?.();
  };
  return { close };
}



export function setBusy(busy) {
  const isGroup = S.conversation?.kind === 'group';
  // **忙的时候不是"把发送禁用"，是"换成停止生成"** ——
  // 以前只写 `disabled = true`，于是"他还在说…"的时候除了干等没有任何出路（用户实报）。
  // 跟节点对话栏那颗方块按钮同一个语义，判断方式也一样（看按钮自己的 class，不依赖外部状态）。
  const btn = $('send');
  btn.disabled = false;
  btn.textContent = busy ? '停止生成' : '发送';
  btn.classList.toggle('stopping', !!busy);
  btn.title = busy ? '掐掉这一轮（他已经说出来的话会留着）' : '发送';
  $('input').placeholder = busy
    ? '他还在说…（要打断就点「停止生成」）'
    : isGroup
      ? '说点什么…（@某人 让他干活；不 @ 就找群主）'
      : '说点什么…（Enter 发送，Shift+Enter 换行）';
  $('hint').textContent = busy
    ? '一次只跑一条。要打断就点「停止生成」。'
    : isGroup
      ? '在输入框里打 @ 就会弹出群成员；不 @ 就找群助手。'
      : '';
}



/* ---------------------------------------------------- 输入框里的 @ 选人 */

export const mentionPop = { open: false, start: 0, index: 0, matches: [] };



export function mentionCandidates() {
  const c = S.conversation;
  return c && c.kind === 'group' ? c.members : [];
}



/** 光标前如果是一个还没写完的 @词，就弹出成员列表 */
export function updateMentionPop() {
  const el = $('input');
  const members = mentionCandidates();
  if (!members.length) return closeMentionPop();

  const caret = el.selectionStart ?? el.value.length;
  const before = el.value.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return closeMentionPop();

  const token = before.slice(at + 1);
  if (/\s/.test(token)) return closeMentionPop(); // @ 后面出现空白，说明这句不是在提人

  const q = token.toLowerCase();
  const matches = members.filter((m) => m.name.toLowerCase().includes(q));
  if (!matches.length) return closeMentionPop();

  mentionPop.open = true;
  mentionPop.start = at;
  mentionPop.matches = matches;
  if (mentionPop.index >= matches.length) mentionPop.index = 0;

  $('mentionPop').innerHTML = `
    <div class="mp-head"><span>选择提醒的人</span><span>↑↓ 选择 · Enter 确认</span></div>
    <div class="mp-list">${matches
      .map((m, i) => {
        const isAssistant = S.conversation?.assistantPersonaId === m.personaId;
        /*
         * 头像（2026-10-23 用户实报「@ 选人弹层还是字母头像」）：按 personaId 从
         * S.personas 查头像文件，有图就把图铺在字母上面 —— 跟群成员磁贴（groups.mjs）
         * 同一套哲学：图盖字母、加载失败 onerror 自删露字母，永远不破相。
         * mp-avatar 需要相对定位才能铺 img，CSS 里单独补了这条。
         */
        const p = (S.personas ?? []).find((x) => x.id === m.personaId);
        const img =
          p?.avatar && AVATAR_FILE.test(String(p.avatar))
            ? `<img class="av-img" src="/avatars/${encodeURIComponent(String(p.avatar))}" alt="" onerror="this.remove()">`
            : '';
        return `<div class="mp-item${i === mentionPop.index ? ' active' : ''}" data-i="${i}">
          <div class="mp-avatar">${esc(initial(m.name))}${img}</div>
          <div class="mp-name">${esc(m.name)}${p?.role ? `<span class="mp-role">${esc(String(p.role).split(' · ')[0].trim())}</span>` : ''}</div>
          ${isAssistant ? '<span class="mp-tag">群助手</span>' : ''}
        </div>`;
      })
      .join('')}</div>`;
  $('mentionPop').classList.add('open');
  $('mentionPop').querySelectorAll('[data-i]').forEach((node) => {
    // mousedown 而不是 click：避免 textarea 先失焦把列表关掉
    node.onmousedown = (e) => { e.preventDefault(); insertMention(Number(node.dataset.i)); };
  });
}



export function closeMentionPop() {
  mentionPop.open = false;
  mentionPop.matches = [];
  $('mentionPop').classList.remove('open');
}



export function insertMention(i) {
  const m = mentionPop.matches[i];
  if (!m) return;
  const el = $('input');
  const caret = el.selectionStart ?? el.value.length;
  const head = el.value.slice(0, mentionPop.start);
  const tail = el.value.slice(caret);
  const inserted = '@' + m.name + ' ';
  el.value = head + inserted + tail;
  const pos = head.length + inserted.length;
  el.setSelectionRange(pos, pos);
  el.focus();
  closeMentionPop();
}



/* -------------------------------------------------------------- 员工详情 */

export async function openDetail(personaId) {
  // 上一页可能还有没落盘的改动（自动保存是防抖的）—— 先存完再画新页
  if (detailSave.flush) {
    const f = detailSave.flush;
    detailSave.flush = null;
    try { await f(); } catch { /* 存不上也别挡着开页面 */ }
  }
  // 从哪儿进的详情（2026-10-24）：消息页进来按钮叫「回到聊天」，通讯录进来叫「发消息」——
  // 行为相同（都接着最近那段聊），文案按用户的心智分开说。
  S.detailFrom = S.nav;
  setRoute('persona', { id: personaId });
  if (S.es) { S.es.close(); S.es = null; S.running = false; setBusy(false); }
  /*
   * 任务那条路**单独取、并行取**：
   *   · 它要扫全部会话与流程，比"配置"重；
   *   · 取不到（老版本服务端、路子断了）只该让「任务」那一页说一声，
   *     不该把整个员工详情拖黑 —— 配置还得能改。
   */
  const [d, tasks] = await Promise.all([
    api('/api/personas/' + encodeURIComponent(personaId)),
    api('/api/personas/' + encodeURIComponent(personaId) + '/tasks').catch((e) => ({ error: e.message })),
  ]);
  S.persona = d.persona;
  showView('detail');
  renderList();
  renderDetail(d, tasks);
}



/** 技能图标（书本）——两处列表共用 */
export const SKILL_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6.6C10.4 5.2 8.4 4.6 5.8 4.6H4.2v13.2h2c2.3 0 4.2.6 5.8 2 1.6-1.4 3.5-2 5.8-2h2V4.6h-1.6C15.6 4.6 13.6 5.2 12 6.6z"/><path d="M12 6.6v13.2"/></svg>';



/* ------------------------------------------------ 员工详情 →「任务」 */

/**
 * 员工详情里的任务页：**只读**，数据跟任务看板**同一批行**（服务端 `personaTasks` 按人筛过）。
 *
 * 为什么不照看板那样横着铺六列：这一页是主区的一栏，宽度放不下；
 * 所以竖着分成几堆，但**堆的顺序照看板的生命周期**（要人管在前、已完成在后）——
 * 人在这页要回答的问题就一句："他现在手上有什么、哪件卡着"。
 */
export const PERSONA_TASK_GROUPS = [
  { label: '要人管', hint: '已阻塞 · 失败 · 待验收', cols: ['blocked', 'failed', 'review'] },
  { label: '进行中', cols: ['doing'] },
  { label: '还没开跑', hint: '待办 · 想法', cols: ['todo', 'idea'] },
  { label: '收场', hint: '已完成 · 已取消', cols: ['done', 'cancelled'] },
  { label: '其他', cols: ['other'] },
];



/**
 * 一张卡：长相跟看板那张**一样**（同一套 `.kb-card` 样式），但**不给拖、不给删**。
 * 员工详情回答的是"他手上有什么"，改状态、删卡该回看板去做 —— 两处都能改就会互相打脸。
 *
 * 卡片上不写执行人：这一页里的每一张都是他的。
 */
export function personaTaskCard(r) {
  const local = r.source === 'manual' || r.source === 'repo';
  const srcCls = r.source === 'chat' ? ' chat' : r.source === 'repo' ? ' repo' : local ? ' manual' : '';
  // 点卡片去哪儿：流程 → 那条实例；有会话 → 那场对话；手工卡没派活 → 它所在项目的看板
  const attr = r.source === 'flow'
    ? ` data-pt-flow="${esc(r.flow_id)}" data-pt-tpl="${esc(r.template_id || '')}"`
    : r.conversation_id
      ? ` data-pt-conv="${esc(r.conversation_id)}"`
      : r.project_id
        ? ` data-pt-proj="${esc(r.project_id)}"`
        : '';
  // 站在一个人的页面上，"这是哪个项目的活"比"哪来的"更该先看见 —— 所以项目标签在最前
  const proj = r.project_id
    ? `<span class="kb-tag proj" title="属于哪个项目">${esc(r.project_name)}</span>`
    : '<span class="kb-tag" title="没挂项目也没落在任何项目目录下">未归属</span>';
  return `<article class="kb-card${local ? ' manual' : ''}"${attr} title="${esc(r.note || '')}">
    <div class="kb-card-top">${proj}<span class="kb-tag${srcCls}">${esc(r.source_text)}</span>${prPillOf(r)}
      <span class="kb-state">${esc(r.status)}</span></div>
    <div class="kb-card-title">${esc(r.task)}</div>
    <div class="kb-card-foot"><span>${esc(r.at)}</span></div>
  </article>`;
}



/**
 * 任务页的正文（不含合计那行）。`b` = `/api/personas/:id/tasks` 的返回，
 * 形状跟任务看板一模一样（`board()` 的产物），所以这里只做"重新分堆"这一件事。
 */
export function personaTasksHtml(b) {
  if (!b) return '<div class="empty" style="padding:26px 4px">任务取不到</div>';
  if (b.error) return `<div class="empty" style="padding:26px 4px">任务取不到：${esc(b.error)}</div>`;
  if (!b.total) {
    return `<div class="empty" style="padding:30px 4px;line-height:1.9">
      ${esc(b.persona_name || '他')}手上还没有任务<br />
      <span class="dim">看板上建的卡指定他做、流程走到点他名的节点、或者他直接在会话里接了活 —— 都会算在这里。</span>
    </div>`;
  }
  const cols = new Map((b.columns ?? []).map((c) => [c.key, c]));
  const blocks = PERSONA_TASK_GROUPS.map((g) => {
    const cards = g.cols.flatMap((k) => cols.get(k)?.cards ?? []);
    if (!cards.length) return '';
    return `<div class="group-title">${esc(g.label)}<span class="pt-num">${cards.length}</span>${
      g.hint ? `<span class="pt-hint">${esc(g.hint)}</span>` : ''
    }</div>
    <div class="group pt-group"><div class="pt-cards">${cards.map(personaTaskCard).join('')}</div></div>`;
  }).join('');
  return `${blocks}
    <div class="pt-note">跟任务看板同源：<b>流程的每次办理</b> + <b>聊天最近一轮</b> + <b>一张手工卡</b>，各算一件。
      聊天派活不进看板 —— 想让某轮活进看板，在聊天页头把它<b>立成卡</b>（这一页照收）。
      点卡片能跳到它本身（流程实例 / 会话 / 项目看板）。</div>`;
}



/** 任务卡片的点击：三种去向，跟看板上那套走的是同一批入口 */
export function wirePersonaTaskLinks() {
  const view = $('detailView');
  if (!view) return;
  view.querySelectorAll('[data-pt-flow]').forEach((el) => {
    el.onclick = () => openFlowRun(el.dataset.ptTpl || null, el.dataset.ptFlow).catch((e) => toast(e.message, 'error'));
  });
  view.querySelectorAll('[data-pt-conv]').forEach((el) => {
    el.onclick = () => {
      // 先切视图：openConversation 只往 #chat 里写，不切视图的话内容写进隐藏页（看板上踩过）
      setNav('messages');
      openConversation(el.dataset.ptConv).catch((e) => toast(e.message, 'error'));
    };
  });
  view.querySelectorAll('[data-pt-proj]').forEach((el) => {
    el.onclick = () => openProjectDetail(el.dataset.ptProj).catch((e) => toast(e.message, 'error'));
  });
}




export function renderDetail({ persona, runtimes, runs, platformRoot, skills: personaSkills = [], allSkills = [] }, taskBoard = null) {
  // 左栏顶上写「通讯录」（右页头已去掉；名字/岗位/头像/动作都在正文的 p-head 里）。
  // 只在"左栏就是通讯录"时写 —— 从聊天页头点「查看资料」进来时 S.nav 还是 messages，
  // 那一栏里是会话，标题写上「通讯录」会跟下面的列表对不上。
  // 2026-10-20 用户要求：通讯录详情**不做面包屑**，标题就固定「通讯录」。
  if (S.nav === 'contacts') setListTitle('通讯录');
  refreshDeptSuggest(); // 部门建议列表跟着库里已用的部门走（#deptSuggest，下面 dDept 用）
  const rt = runtimes.find((r) => r.id === persona.runtime);
  // 身份/技能锁定（2026-10-23；2026-10-22 用户定：内置员工按专家团那个模式收编）
  // 两种来源同一套语义，判据与服务端 experts.lockKindOf 对齐：
  //   expert  = 专家库雇来的（固定 id 前缀 p-expert-），随专家包固定，出路是解聘后自建；
  //   builtin = 出厂的（现在是崔老三），随平台固定，出路是另建一个员工。
  // 锁的只是「他是谁 + 他会什么」；运行时/沙箱/工作目录/模型/头像仍旧可改。
  const expertLocked = String(persona.id || '').startsWith('p-expert-');
  const builtinLocked = !expertLocked && !!persona.builtin;
  const identityLocked = expertLocked || builtinLocked;
  const lockHint = expertLocked
    ? '雇佣员工的名字、岗位与职责身份随专家包固定，不能修改 —— 想定制就解聘后自建一个员工。'
    : '内置员工的名字、岗位与职责身份随平台固定，不能修改 —— 想按自己的需要定制，就另建一个员工。';
  let extraRoots = [];
  try { extraRoots = JSON.parse(persona.rootDirs || '[]'); } catch { extraRoots = []; }
  const runRows = runs.length
    ? runs.map((r) => `<tr>
        <td>${dt(r.startedAt)}</td>
        <td class="st-${esc(r.status)}">${esc(r.status)}</td>
        <td>${r.exitCode ?? '—'}</td>
        <td>${r.usage ? (r.usage.totalTokens ?? '—') : '—'}</td>
        <td>${r.endedAt ? Math.round((new Date(r.endedAt) - new Date(r.startedAt)) / 1000) + 's' : '—'}</td>
        <td class="dim">${esc(r.error || '')}</td>
      </tr>`).join('')
    : '<tr><td colspan="6" class="dim" style="padding-top:8px">还没有运行记录</td></tr>';

    $('detailView').innerHTML = `
    <div class="detail-body">
      <div class="p-head">
        ${personaAvatar(persona)}
        <div class="p-head-main">
          <h2><span id="dNameText">${esc(persona.name)}</span>${persona.builtin ? '<span class="pill builtin" title="出厂就在的员工：名字、岗位与职责身份随平台固定，不能删">内置</span>' : ''}<span class="pill role" id="dRolePill"${persona.role ? '' : ' style="display:none"'}>${esc(persona.role || '')}</span>${
            persona.busy
              ? `<span class="pill busy" id="dBusy" title="${esc(persona.busyLabel ?? '正在干活')}">${
                  persona.busyLabel ? '工作中·' + esc(persona.busyLabel) : '工作中'
                }</span>`
              : '<span class="pill" id="dBusy">空闲</span>'
          }</h2>
          <!-- 顶部那段职责描述（p-desc）按用户要求去掉了：下面「资料」里本来就有完整的「职责与身份设定」 -->
          <!-- 运行时放第二行（2026-10-17 用户要求）：名字旁边只留岗位和忙闲，引擎属于"配置"不是"身份" -->
          <div class="p-meta">
            <span class="pill">${esc(rt ? rt.label : persona.runtime === 'auto' ? '自动' : persona.runtime)}</span>
            <span class="pill">${esc(SANDBOX_LABEL[persona.sandbox] ?? persona.sandbox)}</span>
            <span class="pill">${personaSkills.length} 个技能</span>
            <span class="pill">最近运行 ${runs[0] ? dt(runs[0].startedAt) : '—'}</span>
          </div>
        </div>
        <div class="hero-actions">
          <button class="primary" id="dMsg" title="打开和TA的聊天 —— 有会话就接着最近那段聊，不会另开新会话">${S.detailFrom === 'messages' && (S.conversations ?? []).some((c) => c.kind === 'direct' && c.personaId === persona.id) ? '回到聊天' : '发消息'}</button>
          <div class="hero-more">
            <button type="button" class="hero-more-btn" id="dMore" title="更多操作">⋯</button>
            <div class="hero-more-menu" id="dMoreMenu" hidden>
              ${persona.builtin
                ? '<button class="danger" id="dDelete" disabled title="内置员工不能删（名字/职责/技能随平台固定）">内置 · 不可删</button>'
                : persona.id.startsWith('p-expert-')
                  ? // 专家库雇来的（固定 id p-expert-<key>）：走「解聘」—— 服务端同一条
                    // fire 路由（群助手占用会给 409 人话），再雇佣同一个 id 接上旧会话
                    '<button class="danger" id="dFire">解聘这个数字员工</button>'
                  : '<button class="danger" id="dDelete">删除这个数字员工</button>'}
            </div>
          </div>
        </div>
      </div>

      <div class="tabs">
        <button class="tab on" data-tab="overview">概览</button>
        <button class="tab" data-tab="tasks">任务<span class="tab-n" id="dTasksN">${taskBoard?.total ?? 0}</span></button>
        <button class="tab" data-tab="capability">能力<span class="tab-n">${personaSkills.length}</span></button>
        <button class="tab" data-tab="runs">运行记录<span class="tab-n">${runs.length}</span></button>
      </div>

      <section class="tab-panel" data-panel="overview">
        <div class="ov-layout">
          <nav class="ov-nav" aria-label="概览分区">
            <button type="button" class="on" data-ov="profile">资料</button>
            <button type="button" data-ov="exec">执行配置</button>
          </nav>
          <div class="ov-body">
            <section class="ov-panel" data-ov-panel="profile">
              <div class="group">
                ${
                  identityLocked
                    ? `<div class="hint-line">${lockHint}</div>`
                    : ''
                }
                <div class="form-row">
                  <div class="row-label">名字</div>
                  <input id="dName" value="${esc(persona.name)}" ${identityLocked ? `readonly title="${expertLocked ? '雇佣员工的名字随专家包固定' : '内置员工的名字随平台固定'}"` : ''} />
                </div>
                <div class="form-row">
                  <div class="row-label">岗位</div>
                  <div>
                    <input id="dRole" list="roleSuggest" placeholder="比如：研发（留空也行）" value="${esc(persona.role || '')}" ${identityLocked ? `readonly title="${expertLocked ? '雇佣员工的岗位随专家包固定' : '内置员工的岗位随平台固定'}"` : ''} />
                  </div>
                </div>
                <div class="form-row">
                  <div class="row-label">部门</div>
                  <div>
                    <!-- 部门**不进身份锁**（2026-10-25）：锁的是"他是谁/他会什么"，组织归属是用户的权 ——
                         雇佣专家只带出厂默认（技术部/内容部/行政部），之后随便调、也能清空落「未分配」 -->
                    <input id="dDept" list="deptSuggest" placeholder="比如：技术部（留空 = 未分配）" value="${esc(persona.department || '')}" />
                  </div>
                </div>
                <div class="form-row top">
                  <div class="row-label">职责与身份设定</div>
                  <div>
                    <!-- 预览/编辑（2026-10-21）：这个字段写少读多，默认预览。
                         预览渲染的是 textarea 现值（当前草稿），不是存库值 —— 编辑一半切过去不丢字 -->
                    <!-- 框头合成（2026-10-22 用户定稿）：字数 + 预览/编辑切段贴在框上沿当"框头"，
                         不再悬空一行 —— 右边不孤零零飘按钮，左边由字数补位不显空 -->
                    <div class="instr-wrap">
                      <div class="instr-head">
                        <div class="counter" id="dInstrCount"></div>
                        ${
                          /* 身份锁定：被锁员工（雇佣专家 / 内置员工）不画预览/编辑切换 —— 只读预览，下面的监听都带 ?. 兜底 */
                          identityLocked
                            ? ''
                            : `<div class="seg seg-sm" id="dInstrSeg">
                                <button type="button" data-m="view" class="on">预览</button>
                                <button type="button" data-m="edit">编辑</button>
                              </div>`
                        }
                      </div>
                      <div id="dInstrView" class="md-view"></div>
                      <!-- 高度不写死（2026-10-21）：随内容撑开（fitInstr），滚动只留外层页面 -->
                      <textarea id="dInstr" hidden ${identityLocked ? 'readonly' : ''}>${esc(persona.instructions)}</textarea>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <section class="ov-panel" data-ov-panel="exec" hidden>
              <div class="group">
                <div class="form-row">
                  <div class="row-label">Runtime</div>
                  <div id="dRuntimeMount"></div>
                </div>
                <div class="form-row">
                  <div class="row-label">权限（沙箱）</div>
                  <div id="dSandboxMount"></div>
                </div>
                <div class="form-row">
                  <div class="row-label">模型</div>
                  <div>
                    <div class="row-with-btn">
                      <div id="dModelComboMount" style="flex:1;min-width:0"></div>
                      <button type="button" id="dModelRefresh" title="重新向运行时取一次模型列表（CLI 那边清单变了就点它）">刷新</button>
                    </div>
                    <div class="counter left" id="dModelNote"></div>
                  </div>
                </div>
                <div class="form-row">
                  <div class="row-label">工作目录（主）</div>
                  <input id="dCwd" value="${esc(persona.cwd || '')}" />
                </div>
                <div class="form-row top">
                  <div class="row-label">附加目录</div>
                  <div>
                    <textarea id="dRoots" style="height:56px" placeholder="一行一个路径，例如 E:\\CodeSpace\\myproj">${esc(extraRoots.join('\n'))}</textarea>
                    <div class="counter">平台根自动附加，不用写：<code>${esc(platformRoot || '')}</code>；只有切回沙箱模式后这几行才真的有约束力。</div>
                  </div>
                </div>
                <div class="form-row">
                  <div class="row-label">并发数</div>
                  <!-- 并发数（2026-10-24，对标 Multica）：这一个人名下同时最多几个活在跑。
                       空着 = 默认 6；服务端钳到 [1, 20]，手滑填坏也不会打断保存。 -->
                  <input id="dMaxParallel" type="number" min="1" max="20" step="1"
                         style="width:120px;text-align:center" value="${persona.maxParallel ?? ''}"
                         placeholder="6" />
                </div>
                <div class="form-row">
                  <div class="row-label">思考过程</div>
                  <!-- 开关（2026-10-20 用户："改成开关，文案不要"；"鼠标悬停提示去掉"）：
                       开关本身就是状态，卡面与悬停都不留说明文字 -->
                  <label class="switch sm">
                    <input type="checkbox" id="dThink" ${persona.showThinking ? 'checked' : ''} /><span></span>
                  </label>
                </div>
              </div>
            </section>
          </div>
        </div>
      </section>

      <section class="tab-panel" data-panel="tasks" hidden>
        <div class="pt-head">
          <span class="pt-sum" id="dTasksSum"></span>
          <!-- 不用 .mini：那是 26×26 的单字方钮（测/改/停/卸），两个字放进去必折行（2026-10-20 截图） -->
          <button id="dTasksRefresh" title="重新取一次 —— 任务在别处变了（派了活、跑完一步）就点它">刷新</button>
        </div>
        <div id="dTasksBody"></div>
      </section>

      <section class="tab-panel" data-panel="capability" hidden>
        <div class="sk-head">
          <div>
            <b>分配给智能体</b>
            <div class="sk-hint">${
              expertLocked
                ? '雇佣员工的技能随专家包固定，不能添加、解绑或停用；不合适就解聘换人，想定制就自建一个员工。'
                : builtinLocked
                  ? '内置员工的技能随平台固定，不能添加、解绑或停用；想挂别的技能就另建一个员工。'
                  : '关闭＝暂停使用（仍保留分配）；解绑＝取消分配（技能还在库里）。'
            }</div>
          </div>
          ${identityLocked ? '' : '<button class="mini auto" id="linkSkill">＋ 添加技能</button>'}
        </div>
        <div class="sk-list" id="dSkills">
          ${
            personaSkills.length
              ? personaSkills
                  .map(
                    (l) => `<div class="sk-row">
                      <div class="sk-ico">${SKILL_ICON}</div>
                      <div class="sk-main">
                        <b>${esc(l.name)}</b>
                        <div class="sk-desc">${esc(descOf(l.name) || '（技能库里已经没有这个文件了）')}</div>
                      </div>
                      ${
                        /* 2026-10-22 用户要求去掉「随平台固定/随专家包固定」标签：锁定这件事
                           sk-head 的提示语已经说清楚了，每行再挂一个标签是重复 —— 锁定的行
                           什么都不挂（没有开关/解绑按钮，本身就是"动不了"的意思） */
                        identityLocked
                          ? ''
                          : `<label class="switch sm" title="${l.enabled ? '暂停使用（保留分配）' : '恢复使用'}">
                              <input type="checkbox" data-skill-toggle="${esc(l.name)}" ${l.enabled ? 'checked' : ''} /><span></span>
                            </label>
                            <button class="mini sm txt" data-unlink="${esc(l.name)}" title="解绑：只是不再分配给他，技能本身还在库里">解绑</button>`
                      }
                    </div>`,
                  )
                  .join('')
              : `<div class="sk-blank">${SKILL_ICON} ${
                  expertLocked
                    ? '专家包清单里的技能都被删了才会空 —— 解聘再雇佣会重新挂上。'
                    : builtinLocked
                      ? '内置技能目录丢了才会空 —— 技能库恢复后重启服务会重新挂上。'
                      : '还没分配技能。点右上角「＋ 添加技能」从库里挑。'
                }</div>`
          }
        </div>

        <!-- 从运行时继承：可折叠面板（默认折叠）。折叠时不扫描，展开第一次才去要列表，
             省得每个员工详情都白跑一遍 runtime-skills。状态记在 data-open 上，不进持久化 ——
             这种"列表长又低频看"的区块不值得占路由。 -->
        <div class="sk-fold" id="dInheritFold" data-open="0" style="margin-top:26px">
          <div class="sk-fold-head" id="dInheritHead" role="button" tabindex="0">
            <span class="fold-arrow" aria-hidden="true">▸</span>
            <span class="fold-title">
              <b>从运行时继承</b>
              <div class="sk-hint">自动从 <strong>${esc(rt ? rt.label : persona.runtime)}</strong> 发现；只要该智能体在这个运行时执行，就可以直接使用。</div>
            </span>
            <button class="mini auto" id="skRefresh" title="重新扫描运行时的技能目录">刷新</button>
          </div>
          <div class="sk-fold-body" id="dInheritBody" hidden>
            <div class="sk-list" id="dInherit"></div>
          </div>
        </div>
        ${
          personaSkills.length > 8
            ? '<div class="rm-hint">挂了 8 个以上：首轮清单会变长，模型「选得准」也会下降。建议改成"换"而不是"堆"。</div>'
            : ''
        }
      </section>

      <section class="tab-panel" data-panel="runs" hidden>
        <div class="group-title">最近运行</div>
        <div class="group">
          <table class="runs"><thead><tr>
            <th>时间</th><th>状态</th><th>退出码</th><th>tokens</th><th>耗时</th><th>错误</th>
          </tr></thead><tbody>${runRows}</tbody></table>
        </div>
      </section>
    </div>`;
  // 标签：一次渲染、切显隐 —— 不重建 DOM，所以在「概览」改了一半去「能力」再回来，改动还在
  const tabs = $('detailView').querySelectorAll('[data-tab]');
  const panels = $('detailView').querySelectorAll('[data-panel]');
  const showTab = (key) => {
    tabs.forEach((t) => t.classList.toggle('on', t.dataset.tab === key));
    panels.forEach((p) => { p.hidden = p.dataset.panel !== key; });
  };
  tabs.forEach((t) => {
    t.onclick = () => {
      if (t.dataset.tab !== 'overview') saveNow?.(); // 去别的标签前先把概览的改动落盘
      showTab(t.dataset.tab);
    };
  });
  showTab('overview');

  /*
   * 任务页：数据是**打开这一页那一刻**取的快照（跟「运行记录」一样）。
   * 「刷新」只换这一页里的三块（合计 / 列表 / 标签上的数），**不重画整页** ——
   * 重画会把标签弹回「概览」，人刚翻到任务页就被弹走，比不刷新更烦。
   */
  let tasksData = taskBoard;
  const paintTasks = () => {
    const sum = $('dTasksSum');
    if (sum) {
      sum.innerHTML = !tasksData || tasksData.error
        ? `任务取不到${tasksData?.error ? `：${esc(tasksData.error)}` : ''}`
        : `共 <b>${tasksData.total ?? 0}</b> 件${tasksData.project_count ? ` · 分布在 ${tasksData.project_count} 个项目` : ''}`;
    }
    const body = $('dTasksBody');
    if (body) body.innerHTML = personaTasksHtml(tasksData);
    const n = $('dTasksN');
    if (n) n.textContent = String(tasksData?.error ? '—' : (tasksData?.total ?? 0));
    wirePersonaTaskLinks();
  };
  paintTasks();

  $('dTasksRefresh')?.addEventListener('click', async (e) => {
    e.preventDefault();
    const btn = $('dTasksRefresh');
    btn.disabled = true;
    btn.textContent = '刷新中…';
    try {
      tasksData = await api('/api/personas/' + encodeURIComponent(persona.id) + '/tasks');
    } catch (err) {
      tasksData = { error: err.message };
    } finally {
      btn.disabled = false;
      btn.textContent = '刷新';
      paintTasks();
    }
  });

  /* ---------------- 自动保存（2026-10-18 用户要求：不再点「保存」） ----------------
   * 这里只放骨架：真正的 saveNow 在 combos 建好后再赋值（它要读三个下拉的当前值）。
   * 输入框防抖 700ms；下拉选完 300ms；失焦 / 切分区 / 切标签 / 离开页面立刻 flush。 */
  const saveStateEl = $('dSaveState');
  const setSaveState = (text, kind = '') => {
    if (!saveStateEl) return;
    saveStateEl.textContent = text;
    saveStateEl.className = 'save-state' + (kind ? ' ' + kind : '');
  };
  let saveTimer = null;
  let saveNow = null;      // combos 建好后赋值
  let saveQueued = false;  // 保存中又来一次改动 → 存完再补一次（串行，不并发打 PUT）
  const scheduleSave = (ms = 700) => {
    setSaveState('未保存…', 'wait');
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; saveNow?.(); }, ms);
  };

  // 模型：带搜索（23 个起步，不搜找不到）；Runtime / 权限选项少，不带搜索
  const modelCombo = createCombo({
    mount: $('dModelComboMount'),
    items: [{ id: '', label: '（用 CLI 默认）' }],
    value: String(persona.model ?? '').trim(),
    search: true,
    placeholder: '搜模型…（id 或显示名）',
    empty: '没有匹配的模型',
    onChange: () => scheduleSave(300),
  });

  /**
   * 模型下拉的清单 —— **直接问运行时**（服务端去读 CLI 自己那份配置），不再走账本。
   *
   * 为什么按运行时问：模型列表在 CLI 背后的服务端手里，不在班底手里。
   * 每个族问法不同（codex 读本地目录文件、dsh 发一次 HTTP、claude 只有几个别名），
   * 这些差异由服务端的 cli-models 收拾掉。
   *
   * ⚠️ 读不到时**不能把下拉清空**：那样连原来绑着的模型都不见了，人只看到一个空框。
   * 降级成"保留当前值 + 一句说明"，并且允许手工填名字。
   *
   * `align`：**用户主动换运行时**时要"自动对齐"（2026-10-17 用户要求）。
   *   · 新运行时的清单里也有原来那个模型（codex 和 claude 接的是同一台 magpie，
   *     `workbuddy/hy3` 两边都有）→ 留着，什么都没变；
   *   · 没有 → 退回「用 CLI 默认」，**不**沿用原来那条「（清单里没有）xxx」：
   *     那种值一旦被静默保存下去，CLI 收到一个它不认识的模型名，跑起来才报错，
   *     人根本猜不到是"换运行时"留下的。
   * 打开页面时（align=false）仍然一律"不清空" —— 那是保护已在用的绑定，两回事。
   */
  const fillModels = async (runtimeId, { align = false } = {}) => {
    const note = $('dModelNote');
    if (note) note.textContent = ''; // 静默取，不在界面上写"正在取…"（见下方成功分支的注释）
    try {
      // fresh：这里可能是用户按了「刷新」，别吃 60 秒缓存
      const d = await readModelList(runtimeId, { fresh: true });
      const list = d.models ?? [];
      const cur = modelCombo.value();
      const known = list.some((m) => m.id === cur);
      // 换运行时、而新清单里没有它 → 对齐到"用 CLI 默认"
      const dropped = align && !!cur && !known;
      const keep = dropped ? '' : cur;
      // 「用 CLI 默认」后面带上**真实**的默认模型名（2026-10-17）：只写"默认"的话，
      // 人根本不知道它落到哪个模型上 —— 用户就问过"claude code 现在的真实模型是什么"。
      const items = [{ id: '', label: d.defaultModel ? `（用 CLI 默认：${d.defaultModel}）` : '（用 CLI 默认）' }];
      // 当前值不在清单里也要留着 —— 清单可能读不到，不能把人家绑着的模型弄丢
      if (keep && !known) items.push({ id: keep, label: `（清单里没有）${keep}` });
      items.push(...modelItems(list));
      // 第二个参数是 keepValue：对齐时要真的把值换成 ''，所以只在没对齐时才保留
      modelCombo.setItems(items, keep === cur);
      if (note) {
        // 成功时**不留任何说明文字**（2026-10-17 用户要求去掉）：
        // 「N 个可选，点开可以搜 / 原来选的 X 这个运行时没有 / （codex 自己的模型目录（provider：magpie））」
        // 这些都属于解释性描述，下拉自己会说话。只在取不到清单时才提示，那是真需要人知道的事。
        note.textContent = list.length ? '' : (d.error ?? '这个运行时的清单是空的') + ' —— 模型名也可以直接填';
      }
    } catch (err) {
      // 读不到就降级：别清空下拉，让人至少还能看见当前值、还能手工填
      if (note) {
        note.textContent = `取不到模型列表（${err.message}）—— 模型名可以手工填`;
        note.title = err.explained ? '' : (err.detail || '');
      }
    }
  };

  const sbCombo = createCombo({
    mount: $('dSandboxMount'),
    items: sandboxItems(rt),
    value: persona.sandbox,
    search: false,
    onChange: () => scheduleSave(300),
  });
  /*
   * 运行时清单。内置员工与**专家库雇来的员工**（p-expert-*）都多一条「自动」——
   * 他们出厂 runtime 就是 'auto'（换机器、换 CLI 都不用改），下拉里必须有当前值：
   * 缺了它按钮会退化成显示原始 id（用户实报：专家详情里赫然一个 "auto"），清单里也没有 ✓，
   * 而且一旦改成具体运行时就**再也选不回「自动」**。
   * 普通员工仍不给：对他们来说"用哪个引擎"是要自己决定的，不该有个含糊的自动选项。
   */
  const rtItems = runtimes.map((r) => ({ id: r.id, label: r.label }));
  if (persona.builtin || String(persona.id ?? '').startsWith('p-expert-'))
    rtItems.unshift({ id: 'auto', label: '自动（挑一个能用的）' });

  const rtCombo = createCombo({
    mount: $('dRuntimeMount'),
    items: rtItems,
    value: persona.runtime,
    search: false,
    onChange: (id) => {
      const r = runtimes.find((x) => x.id === id);
      const items = sandboxItems(r);
      const keep = items.some((it) => it.id === sbCombo.value()) ? sbCombo.value() : items[0]?.id ?? '';
      sbCombo.setItems(items, false);
      sbCombo.setValue(keep);
      // 换了运行时：清单跟着换，对不上的模型顺带对齐；**对齐完再存** —— 否则会把旧模型名存给新运行时
      fillModels(id, { align: true }).finally(() => scheduleSave(300));
    },
  });
  // auto 没有自己的模型清单 —— 问它只会拿到一个 404，在界面上写成"取不到模型列表"纯属误导
  if (persona.runtime === 'auto') {
    const note = $('dModelNote');
    if (note) note.textContent = '运行时是自动挑的，模型跟着它自己的默认走';
  } else {
    fillModels(persona.runtime);
  }

  /*
   * 「刷新」：清单是**打开页面那一刻**取的，运行时那边后来加了模型这边不知道 —— 点一下重新问一次。
   * 复用 `fillModels`（它自己就带着"取不到不清空"的降级），只是把按钮按住防连点。
   */
  $('dModelRefresh')?.addEventListener('click', async (e) => {
    e.preventDefault();
    const btn = $('dModelRefresh');
    btn.disabled = true;
    btn.textContent = '刷新中…';
    try {
      await fillModels(rtCombo.value());
    } finally {
      btn.disabled = false;
      btn.textContent = '刷新';
    }
  });

  const instrCount = $('dInstrCount');
  const dInstrTA = $('dInstr');
  /*
   * 自增高（2026-10-21 用户要求）：textarea 有多高显示多高，不给自己滚 ——
   * 滚动条只留外层页面一条。hidden 时 scrollHeight 是 0，跳过（切进编辑态时会再算）。
   */
  const fitInstr = () => {
    if (dInstrTA.hidden) return;
    dInstrTA.style.height = 'auto';
    dInstrTA.style.height = `${dInstrTA.scrollHeight}px`;
  };
  const syncCount = () => { if (instrCount) instrCount.textContent = dInstrTA.value.trim().length + ' 字'; };
  dInstrTA.addEventListener('input', () => { syncCount(); fitInstr(); });
  syncCount();

  /*
   * 「职责与身份设定」预览/编辑（2026-10-21）：人设这类 markdown **写少读多**，默认预览。
   *   · 预览渲染的是 textarea **现值**（当前草稿）—— 编辑一半切过去看到的就是刚写的，
   *     切回编辑一个字不少；不读存库值，就不存在"预览回滚"的坑。
   *   · 切回预览顺手 saveNow 一次：自动保存靠失焦/防抖，切换这个动作兜个底。
   *   · 空内容给占位 +「写一段」直达编辑，不留一块白板让人猜。
   */
  const dInstrEl = $('dInstr');
  const dInstrViewEl = $('dInstrView');
  let instrMode = 'view';
  const renderInstrView = () => {
    const val = dInstrEl.value;
    dInstrViewEl.innerHTML = val.trim()
      ? mdRender(val)
      : /* 身份锁定：雇佣员工不给「写一段」入口（本来也不该走到空值这一支） */
        expertLocked
        ? '<div class="md-empty">暂无设定。</div>'
        : '<div class="md-empty">暂无设定。<button type="button" class="linkish" data-edit-instr>写一段</button></div>';
  };
  const setInstrMode = (m) => {
    if (m === instrMode) return;
    instrMode = m;
    if (m === 'view') {
      renderInstrView();
      dInstrEl.hidden = true;
      dInstrViewEl.hidden = false;
      saveNow?.();
    } else {
      dInstrViewEl.hidden = true;
      dInstrEl.hidden = false;
      fitInstr();
      dInstrEl.focus();
    }
    $('dInstrSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
  };
  // 身份锁定：雇佣员工没有 #dInstrSeg（上面不画），监听挂不上就跳过
  $('dInstrSeg')?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-m]');
    if (b) setInstrMode(b.dataset.m);
  });
  dInstrViewEl.addEventListener('click', (e) => {
    if (e.target.closest('[data-edit-instr]')) setInstrMode('edit');
  });
  renderInstrView();

  /*
   * 「回到聊天 / 发消息」= **接着最近那段继续聊**（2026-10-24 用户拍板，改掉 2026-10-20
   * "每次新开一段"的旧口径 —— 那个决定的动机是"想另起一段没入口"，现在聊天页头有
   * 「新会话」按钮专管另起，这里的口径随之归位，跟微信一致：名片「发消息」进的就是
   * 现有聊天）。有这个人的会话 → 打开**最近那段**（服务端按 updatedAt DESC 排好）；
   * 一段都没有（第一次找TA，或只剩被「不显示」收着的）→ 新建第一段。
   * 按钮文案跟着入口走：消息页点进详情 = 「回到聊天」，通讯录进来 = 「发消息」，行为相同。
   */
  const toMessages = async () => {
    try {
      // 回到哪段（2026-10-24 用户实报：聊天中途进详情再回来，落到了后来留下的空壳上）：
      //   ① 你**正在聊的那段**最优先 —— "回到"就是回到刚才那儿；
      //   ② 否则最近**真聊过**的一段（空壳让位，和左栏代表会话同一个口径）；
      //   ③ 一段都没有（第一次找TA，或只剩被「不显示」收着的）→ 新建第一段。
      const mine = (S.conversations ?? []).filter((c) => c.kind === 'direct' && c.personaId === persona.id);
      const current = S.conversation?.kind === 'direct' && S.conversation.personaId === persona.id ? S.conversation : null;
      const target = current
        ?? [...mine].sort((a, b) => {
          const ae = !(a.messageCount > 0);
          const be = !(b.messageCount > 0);
          if (ae !== be) return ae ? 1 : -1;
          return String(b.updatedAt).localeCompare(String(a.updatedAt));
        })[0];
      const convId = target
        ? target.id
        : (await post('/api/conversations', { personaId: persona.id, title: `和 ${persona.name}` })).conversation.id;
      setNav('messages');
      showView('chat');
      /*
       * 走 `openConversationSafe`：复用分支打开的那段，可能刚好被**另一个窗口**删掉了
       * （E2047）—— 那里会关抽屉、清右栏、刷列表，还会说人话。
       * 之后要按"真的打开了没"决定收尾：没打开就别把光标扔进一个已经收起的输入区。
       */
      await openConversationSafe(convId);
      if (S.conversation?.id !== convId) return;
      await load();
      $('input').focus();
    } catch (err) { toastConvErr(err); }   // 建会话（POST）失败也走同一张人话表
  };
  $('dMsg').onclick = async () => { await saveNow?.(); toMessages(); };

  /**
   * 自动保存：**改了就算保存**，不再有「保存」按钮（2026-10-18 用户要求）。
   *
   * 分寸：
   *   · 输入框防抖 700ms；下拉选完 300ms；失焦立刻存；
   *     切分区 / 切标签 / 点「发消息」/ 打开别的员工 / 关页面 都先 flush（见 flushDetailSave）。
   *   · **不重画整页**：重画会丢焦点、把标签弹回概览；只把名字/岗位在页头和左栏同步一下。
   *   · 名字空着不提交（服务端 E1011 会拒），状态直接写"名字不能空"。
   *   · 保存中又来改动 → 存完补一次（串行；同时打两个 PUT 会互相覆盖）。
   */
  const collect = () => ({
    name: $('dName').value,
    role: $('dRole').value,
    department: $('dDept').value,
    instructions: $('dInstr').value,
    runtime: rtCombo.value(),
    sandbox: sbCombo.value(),
    model: modelCombo.value(),
    cwd: $('dCwd').value,
    rootDirs: $('dRoots').value.split('\n').map((s) => s.trim()).filter(Boolean),
    showThinking: $('dThink').checked,
    // 空着 = 恢复默认（null）；数字服务端会钳位，这里只管传
    maxParallel: $('dMaxParallel').value.trim() === '' ? null : Number($('dMaxParallel').value),
  });
  let lastSaved = JSON.stringify(collect());
  let saving = false;

  saveNow = async ({ keepalive = false } = {}) => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    const payload = collect();
    if (!payload.name.trim()) { setSaveState('名字不能空 · 未保存', 'bad'); return false; }
    const json = JSON.stringify(payload);
    if (json === lastSaved) { setSaveState(''); return true; }
    if (saving) { saveQueued = true; return false; }
    saving = true;
    setSaveState('保存中…', 'wait');
    try {
      const d = await api('/api/personas/' + encodeURIComponent(persona.id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: json,
        ...(keepalive ? { keepalive: true } : {}),
      });
      lastSaved = JSON.stringify(payload);
      const p = d?.persona;
      if (p) {
        S.persona = { ...(S.persona || {}), ...p };
        // 左栏那份也要合回去（S.persona 是独立对象）：改部门后通讯录分组要**立刻**跟着挪，
        // 改名字同理 —— 只重画不合并的话，画出来的还是旧值。
        const row = (S.personas || []).find((x) => x.id === p.id);
        if (row) Object.assign(row, p);
        // 页头（名字 / 岗位 / 头像）与左栏名字同步 —— 不重画整页
        const nameEl = $('dNameText');
        if (nameEl) nameEl.textContent = p.name;
        const roleEl = $('dRolePill');
        if (roleEl) { roleEl.textContent = p.role || ''; roleEl.style.display = p.role ? '' : 'none'; }
        const av = $('detailView')?.querySelector('.p-head .avatar');
        // 整体重建而不是改 textContent：头像里除了字母还有**图片层**（<img class="av-img">，
        // 2026-10-22 加），`textContent =` 会把子节点全清掉 —— 切运行时触发自动保存，
        // 保存一下头像图片就没了（2026-10-24 实报）。重建顺带把色系（名字哈希）一起刷新。
        if (av) av.outerHTML = personaAvatar(p);
        // 左栏 / 会话里的名字也跟着变（只跟内存和左栏打交道，不重画详情页）
        (S.conversations || []).forEach((c) => { if (c.personaId === p.id) c.personaName = p.name; });
        if (S.conversation?.personaId === p.id) S.conversation.personaName = p.name;
        if (S.nav === 'contacts' || S.nav === 'messages') {
          // 左栏标题固定「通讯录」（不做面包屑，2026-10-20）—— 改名不用再同步标题，
          // 只有左栏真是通讯录时才要管；在消息页那一栏是会话（从聊天页头点进资料会停在这条路）。
          renderList();
        }
      }
      setSaveState(''); // 存成功不出声（2026-10-24 用户："已保存"提示不要了）—— 保存失败才说话
      return true;
    } catch (err) {
      setSaveState('保存失败：' + (err?.message ?? '服务异常'), 'bad');
      console.error('[班底] 员工自动保存失败', err?.detail ?? err);
      return false;
    } finally {
      saving = false;
      if (saveQueued) { saveQueued = false; saveNow?.(); }
    }
  };
  // 离开这一页（切视图 / 打开别的员工 / 关窗口）前兜底存一次
  detailSave.flush = (opts) => saveNow(opts);

  // 输入框：敲字防抖；失焦立刻存（没改动时 saveNow 按 lastSaved 直接跳过）
  for (const id of ['dName', 'dRole', 'dDept', 'dInstr', 'dCwd', 'dRoots', 'dMaxParallel']) {
    $(id)?.addEventListener('input', () => scheduleSave(700));
    $(id)?.addEventListener('blur', () => saveNow?.());
  }
  $('dThink')?.addEventListener('change', () => scheduleSave(200));

  // 概览左侧分区：资料 / 执行配置（切之前先 flush —— 藏起来的那一栏也得先落盘）
  const ovBtns = $('detailView').querySelectorAll('[data-ov]');
  const ovPanels = $('detailView').querySelectorAll('[data-ov-panel]');
  const showOv = (key) => {
    ovBtns.forEach((b) => b.classList.toggle('on', b.dataset.ov === key));
    ovPanels.forEach((p) => { p.hidden = p.dataset.ovPanel !== key; });
  };
  ovBtns.forEach((b) => { b.onclick = () => { saveNow?.(); showOv(b.dataset.ov); }; });
  showOv('profile');

  /* 更多操作（⋯）：点开才露删除。删除是破坏性动作，平时收起来，别让它跟「发消息」平起平坐 */
  $('dMore')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const m = $('dMoreMenu');
    if (m) m.hidden = !m.hidden;
  });
  document.addEventListener('click', dMoreOutside);
  (window.__pageCleanups ??= []).push(() => {
    document.removeEventListener('click', dMoreOutside);
  });
  function dMoreOutside(e) {
    if (!e.target.closest?.('.hero-more')) { const m = $('dMoreMenu'); if (m) m.hidden = true; }
  }

  /**
   * 删员工。**破坏性**，所以先把要发生的事说清楚，再问。
   * 服务端还会拦一道：他是某个群的群助手就删不掉（得先换人）。
   *
   * 正文三行是 2026-10-20 用户逐字定稿的（原话「整段改成：…」），别再自己加/减：
   *   · 只说结果，不罗列"他的 N 段对话"—— 段数会变，数字一变文案就显得在哄人；
   *   · 第三行带括号，是"可能删不掉"的前置条件，语气上是备注而不是步骤。
   * 「删掉数字员工「X」？」从正文提到了**标题**：正文被定稿成三行后，
   * 不点明删谁的破坏性弹窗只剩一句「该操作」，用户得自己回想刚才点了什么。
   */
  /**
   * 解聘（专家库雇来的员工，⋯菜单里那项）。走专家域的 fire 路由（群助手占用、
   * 固定 id 再雇佣接旧会话都是它管），收尾跟删除一样：别留指向已解聘员工的面板。
   */
  $('dFire')?.addEventListener('click', async () => {
    const key = String(persona.id).slice('p-expert-'.length);
    const ok = await fireExpert(key, { stayContacts: true, name: persona.name });
    if (ok === false) return;
    setNav('contacts');
  });

  $('dDelete') && ($('dDelete').onclick = async () => {
    const ok = await confirmDo(
      `该操作将清空其配置、技能、群关联。\n` +
        `已有对话仅可读，不能继续聊天；会话可后续删除或归档。\n` +
        `（当其作为群助手时无法直接删除，需先更换群助手。）`,
      { title: `删掉数字员工「${persona.name}」？` },
    );
    if (!ok) return;
    try {
      await api('/api/personas/' + encodeURIComponent(persona.id), { method: 'DELETE' });
      // 别留一个指向已删员工的面板：会话、光标、输入区全部复位
      S.persona = null;
      S.conversation = null;
      await load();
      $('chat').innerHTML = '<div class="empty">还没有对话</div>';
      $('chatHead').innerHTML = '<span class="dim" style="padding:6px 0">左边选一个人，开始说话</span>';
      setComposer(false);
      setNav('contacts');
    } catch (err) { toast(err.message, 'error'); }
  });

  /** 技能说明：从库里查（挂在员工上的可能已经不在库里了）。
   *  写成函数声明：上面的模板就会用到它，const 会有 TDZ 问题 */
  function descOf(name) {
    return (allSkills.find((s) => s.name === name) ?? {}).description ?? '';
  }

  // 技能关联是**独立动作**，点完立刻生效，不跟"保存"混在一起
  // （挂载关系跟群成员一样是张多对多表，用"改完再保存"反而容易互相覆盖）
  $('dSkills').querySelectorAll('[data-unlink]').forEach((el) => {
    el.onclick = async () => {
      try {
        await api(
          `/api/personas/${encodeURIComponent(persona.id)}/skills/${encodeURIComponent(el.dataset.unlink)}`,
          { method: 'DELETE' },
        );
        await openDetail(persona.id);
      } catch (err) { toast(err.message, 'error'); }
    };
  });
  $('dSkills').querySelectorAll('[data-skill-toggle]').forEach((el) => {
    el.onchange = async () => {
      try {
        await api(
          `/api/personas/${encodeURIComponent(persona.id)}/skills/${encodeURIComponent(el.dataset.skillToggle)}`,
          { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: el.checked }) },
        );
        await openDetail(persona.id);
      } catch (err) { toast(err.message, 'error'); el.checked = !el.checked; }
    };
  });
  const linkBtn = $('linkSkill');
  if (linkBtn) linkBtn.onclick = () => openLinkSkillDialog(persona, allSkills, personaSkills.map((l) => l.name));

  // 从运行时继承：只发现、不改 CLI 的文件；"导入"才是把它拷进班底的库。
  // 折叠面板默认收起 —— 展开那一刻才扫描（懒加载），折叠状态下不发请求；
  // 「刷新」只在面板已展开时触发扫描，收起状态点它先展开再扫。
  const fold = $('dInheritFold');
  const body = $('dInheritBody');
  const loadInherited = async () => {
    const box = $('dInherit');
    if (!box) return;
    box.innerHTML = '<div class="sk-empty" style="border-style:solid">正在扫描…</div>';
    try {
      const d = await api('/api/personas/' + encodeURIComponent(persona.id) + '/runtime-skills');
      const found = d.found ?? [];
      box.innerHTML = found.length
        ? found
            .map(
              (s) => `<div class="sk-row">
                <div class="sk-ico">${SKILL_ICON}</div>
                <div class="sk-main">
                  <b>${esc(s.name)}</b>
                  <div class="sk-desc">${esc(cut(s.description, 90) || '（没写描述）')}</div>
                </div>
                <button class="mini auto" data-inherit="${esc(s.name)}" data-dir="${esc(s.dir)}"
                        title="拷进班底的技能库，之后就能分配给员工、也能改">导入</button>
              </div>`,
            )
            .join('')
        : `<div class="sk-empty">${SKILL_ICON} 该运行时中没有发现本地 skill。` +
          (d.dirs?.length ? `（找过 ${esc(d.dirs.join('、'))}）` : '（这个运行时没有已知的技能目录）') +
          '</div>';
      box.querySelectorAll('[data-inherit]').forEach((el) => {
        el.onclick = async () => {
          el.disabled = true;
          el.textContent = '导入中…';
          try {
            await post('/api/skills/import', { dirs: [el.dataset.dir + '\\' + el.dataset.inherit], overwrite: false });
            await load();
            await openDetail(persona.id);
          } catch (err) { el.disabled = false; el.textContent = '导入'; toast(err.message, 'error'); }
        };
      });
    } catch (err) {
      box.innerHTML = '<div class="sk-empty">扫描失败：' + failHtml(err) + '</div>';
    }
  };
  const setFold = (open) => {
    fold.dataset.open = open ? '1' : '0';
    body.hidden = !open;
    $('dInheritHead').querySelector('.fold-arrow').textContent = open ? '▾' : '▸';
    if (open && !body.dataset.loaded) {
      body.dataset.loaded = '1';
      loadInherited();
    }
  };
  $('dInheritHead').onclick = (e) => {
    if (e.target.closest('#skRefresh')) return; // 刷新是独立动作，别顺带折叠
    setFold(fold.dataset.open !== '1');
  };
  $('dInheritHead').onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFold(fold.dataset.open !== '1'); }
  };
  const refresh = $('skRefresh');
  if (refresh)
    refresh.onclick = () => {
      setFold(true); // 收着就点刷新 = 展开并重扫
      loadInherited();
    };
}




/* ------------------------------------------------------------ 关联技能 */

export let linkCandidates = [];


export const linkPicked = new Set();


export let linkPersonaId = null;



export function renderLinkList() {
  const q = ($('lkSearch').value || '').trim().toLowerCase();
  const rows = linkCandidates.filter(
    (s) => !q || s.name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q),
  );
  $('lkList').innerHTML = rows.length
    ? rows
        .map(
          (s) => `<label class="member">
            <input type="checkbox" value="${esc(s.name)}" ${linkPicked.has(s.name) ? 'checked' : ''} />
            <span>${esc(s.name)}</span><em>${esc(cut(s.description, 44) || '（未写描述）')}</em>
          </label>`,
        )
        .join('')
    : '<div class="dim" style="padding:10px 2px">没找到</div>';
  $('lkList').querySelectorAll('input').forEach((el) => {
    el.onchange = () => { if (el.checked) linkPicked.add(el.value); else linkPicked.delete(el.value); };
  });
}



export function openLinkSkillDialog(persona, allSkills, attached) {
  const have = new Set(attached);
  linkCandidates = allSkills.filter((s) => !have.has(s.name));
  if (!linkCandidates.length) return toast('库里的技能都已经关联了');
  linkPersonaId = persona.id;
  linkPicked.clear();
  $('lkSearch').value = '';
  renderLinkList();
  $('linkSkillDlg').showModal();
  setTimeout(() => $('lkSearch').focus(), 30);
}



/** 关联改完：刷新列表 + 重画详情 */
export async function searchRefreshDetail() {
  const id = linkPersonaId;
  await load();
  if (id) await openDetail(id);
}
