/* chat.mjs —— 进对话、发消息、输入框里的 @ 选人、员工详情、员工详情 →「任务」、关联技能。
 * 2026-10-22 由 app.js（15537 行单文件）拆出，原生 ESM、无打包器；逻辑逐字搬运。 */
import { esc, mdRender, savePlace, setRoute, toast } from './shell.mjs';
import { TYPING, api, createCombo, cut, dt, failHtml, initial, personaAvatar, personaByName, post, renderMarkdown, setHeaderBadge, smAvatar } from './ui.mjs';
import { load, setNav } from './state.mjs';
import { confirmDo } from './machine.mjs';
import { convDisplayName, openConversationSafe, toastConvErr } from './listmenu.mjs';
import { detailSave, renderList, showView } from './contacts.mjs';
import { openProjectDetail, prPillOf } from './projects.mjs';
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

  const d = await api('/api/conversations/' + encodeURIComponent(id));
  S.conversation = d.conversation;
  // 这段会话是不是**一个字都没说过**（详情页「发消息」连点复用它，见 toMessages）。
  // 依据是服务端刚给的 messages，不是本地猜测 —— 零额外请求、刷新后结论一致。
  S.convEmpty = (d.messages || []).length === 0;
  savePlace();         // 记下正在看哪个会话，刷新后回到这儿
  setComposer(true);   // 有会话了，输入区才出来
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
      <button class="icon-btn" id="toChatLog" title="聊天记录">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3.6 12a8.4 8.4 0 1 0 2.6-6.1" />
          <path d="M3.6 4.6V10H9" />
          <path d="M12 8v4.4l3 1.8" />
        </svg>
      </button>
      ${dissolved ? '' : `<button class="icon-btn" id="toSettings" title="群设置">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2.6v2.1M12 19.3v2.1M2.6 12h2.1M19.3 12h2.1M5.4 5.4l1.5 1.5M17.1 17.1l1.5 1.5M18.6 5.4l-1.5 1.5M6.9 17.1l-1.5 1.5" />
        </svg>
      </button>`}`;
    if (!dissolved) $('toSettings').onclick = () => openGroupDrawer(d.conversation);
    // 群聊天记录（2026-10-20 用户要求）：抽屉列出这个群的会话（含被「不显示」的那条）
    $('toChatLog').onclick = () => openChatLogDrawer(d.conversation);
  } else {
    /*
     * 名字取法：员工还在 → 用他现在的名字（可能改过，personaName 来自 JOIN）；
     * 员工已删 → personaName 是 NULL，**不能回落到 S.persona**（那是上一个人的名字，
     * 会张冠李戴），退回这段会话自己的标题（convDisplayName 会剥掉「和 」前缀，
     * 不然页头会出现「和 和大梁」这种叠字）；连标题都没有才写「员工已删」。
     * 头像同理：员工没了就别给「点进员工详情」的入口（点开是 404）。
     */
    const name = convDisplayName(d.conversation);
    const pHere = personaGone ? null : ((S.personas ?? []).find((x) => x.id === d.conversation.personaId) ?? null);
    $('chatHead').innerHTML = `
      ${smAvatar(name, personaGone ? '' : `clickable" data-detail="${esc(d.conversation.personaId)}" title="配置他的 agent CLI`, pHere)}
      <div class="meta">
        <div><b>${esc(name)}</b> ${badge}</div>
      </div>
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
  }

  renderComposerPerm(d);
  renderComposerModel(d);

  // 把 `runs` 一起给它：失败的运行在库里**没有消息**，只画 messages 就会"说了句话然后没了"
  drawMessages(d.messages, d.conversation.personaName || '', isGroup, d.runs);
  const last = d.runs[0];
  if (last && last.status === '跑中') attachStream(last.id);
  renderList();
}



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



export function bubble(role, text, name, who, showName = false, at = '') {
  const mine = role === 'user';
  const label = mine ? '我' : (who || name || '数字员工');
  // 头像带图（2026-10-22）：优先按名字找员工；群聊消息有 personaName 直接命中，
  // 1:1 改过名时名字可能对不上，再兜一层会话的 personaId
  const p = mine ? null
    : (personaByName(label)
      ?? (S.conversation?.personaId ? S.personas.find((x) => x.id === S.conversation.personaId) ?? null : null));
  // 时间放在气泡**外面**的下方（2026-10-19 用户要求，别塞在气泡里）：绝对定位，不占布局
  const t = at ? stampOf(at) : '';
    return `<div class="row ${mine ? 'me' : ''}">
    ${mine ? smAvatar('我', 'me') : smAvatar(label, '', p)}
    <div class="bubble">${showName && !mine ? `<div class="who-line">${esc(label)}</div>` : ''}${renderMarkdown(text)}</div>
    ${t ? `<div class="btime">${esc(t)}</div>` : ''}
  </div>`;
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



/** 没跑成那一块。复用 `.step.bad` —— 跟实时气泡里那行是同一个样式 */
export function failBlock(r) {
  const full = String(r.error ?? '').trim();
  const why = firstMeaningfulLine(full) || '运行失败（这次没留下原因）';
  const code = r.exitCode == null ? '' : `（退出码 ${r.exitCode}）`;
  // 只有"藏着更多东西"时才给折叠入口：短报错摊开就好，别多一颗要点开的东西
  const more =
    full.length > why.length + 20
      ? `<details class="fail-more"><summary>完整报错</summary><pre>${esc(full)}</pre></details>`
      : '';
  return `<div class="row">
    <div class="avatar sm" data-tone="a">!</div>
    <div class="bubble"><div class="step bad">没跑成：${esc(why)}${esc(code)}</div>${more}</div>
  </div>`;
}



export function drawMessages(msgs, name, isGroup = false, runs = []) {
  const items = timelineOf(msgs, runs);
  /*
   * 空会话**什么都不画**（2026-10-20 用户要求）：「和 X 还没有对话 / 在下面说第一句吧」
   * 这两行提示去掉了 —— 输入框就在下面，不需要再教一遍。
   */
  $('chat').innerHTML = items.length
    ? items
        .map((it) =>
          it.kind === 'msg'
            ? bubble(it.m.role, it.m.text, name, it.m.personaName, isGroup, it.m.createdAt)
            : failBlock(it.r),
        )
        .join('')
    : '';
  scrollDown();
}


export const scrollDown = () => { $('chat').scrollTop = $('chat').scrollHeight; };



/* ---------------------------------------------------------------- 发消息 */

export async function send() {
  const text = $('input').value.trim();
  if (!text || !S.conversation || S.running) return;
  // 说出第一句就不再是"空会话"了 —— 详情页「发消息」的连点复用靠它判断
  S.convEmpty = false;
  $('input').value = '';
  closeMentionPop();
  const name = S.conversation.personaName || S.persona?.name || '数字员工';

  $('chat').querySelector('.empty')?.remove();
  $('chat').insertAdjacentHTML('beforeend', bubble('user', text, name, undefined, false, new Date().toISOString()));
  scrollDown();

  try {
    // 流程走的是 issue：在实例页里说话，不在这儿。这里就是普通聊天
    const d = await post('/api/conversations/' + encodeURIComponent(S.conversation.id) + '/messages', { text });
    attachStream(d.runId);
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



export function attachStream(runId) {
  if (S.es) S.es.close();
  S.running = true;
  chatRunningId = runId;
  setBusy(true);
  setHeaderBadge('跑中', TYPING);

  const name = S.conversation.personaName || S.persona?.name || '数字员工';
  const convId = S.conversation.id;
  const id = 'live-' + runId;
  $('chat').insertAdjacentHTML('beforeend',
    `<div class="row" id="${id}">
       ${smAvatar(name, '', personaByName(name))}
       <div class="bubble"><div class="typing"><i></i><i></i><i></i></div></div>
     </div>`);
  scrollDown();

  const body = document.querySelector('#' + id + ' .bubble');
  const showThinking = S.conversation?.showThinking === 1;
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
        return `<div class="mp-item${i === mentionPop.index ? ' active' : ''}" data-i="${i}">
          <div class="mp-avatar">${esc(initial(m.name))}</div>
          <div class="mp-name">${esc(m.name)}</div>
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
  { label: '要人管', hint: '停下等人 · 失败 · 待人确认', cols: ['blocked', 'failed', 'confirm'] },
  { label: '进行中', cols: ['doing'] },
  { label: '还没开跑', hint: '待办 · 想法', cols: ['todo', 'idea'] },
  { label: '已完成', cols: ['done'] },
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
  const rt = runtimes.find((r) => r.id === persona.runtime);
  // 身份/技能锁定（2026-10-23；2026-10-22 用户定：内置员工喜儿按专家团那个模式收编）
  // 两种来源同一套语义，判据与服务端 experts.lockKindOf 对齐：
  //   expert  = 专家库雇来的（固定 id 前缀 p-expert-），随专家包固定，出路是解聘后自建；
  //   builtin = 出厂的（喜儿），随平台固定，出路是另建一个员工。
  // 锁的只是「他是谁 + 他会什么」；运行时/沙箱/工作目录/模型/头像仍旧可改。
  const expertLocked = String(persona.id || '').startsWith('p-expert-');
  const builtinLocked = !expertLocked && !!persona.builtin;
  const identityLocked = expertLocked || builtinLocked;
  const lockHint = expertLocked
    ? '雇佣员工的名字、岗位与职责身份随专家包固定，不能修改 —— 想定制就解聘后自建一个员工。'
    : '喜儿是内置员工，名字、岗位与职责身份随平台固定，不能修改 —— 想按自己的需要定制，就另建一个员工。';
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
          <button class="primary" id="dMsg">发消息</button>
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
                  <input id="dName" value="${esc(persona.name)}" ${identityLocked ? `readonly title="${expertLocked ? '雇佣员工的名字随专家包固定' : '喜儿的名字随平台固定'}"` : ''} />
                </div>
                <div class="form-row">
                  <div class="row-label">岗位</div>
                  <div>
                    <input id="dRole" list="roleSuggest" placeholder="比如：研发（留空也行）" value="${esc(persona.role || '')}" ${identityLocked ? `readonly title="${expertLocked ? '雇佣员工的岗位随专家包固定' : '喜儿的岗位随平台固定'}"` : ''} />
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
                          /* 身份锁定：被锁员工（雇佣专家 / 内置喜儿）不画预览/编辑切换 —— 只读预览，下面的监听都带 ?. 兜底 */
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
                  ? '喜儿的技能随平台固定，不能添加、解绑或停用；想挂别的技能就另建一个员工。'
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
   * 运行时清单。内置员工多一条「自动」—— 她的 runtime 是 'auto'（换机器、换 CLI 都不用改她），
   * 不给这一条，下拉里就没有当前值，看着像"没配"，一保存还会落到第一个运行时上。
   * 普通员工不给：对他们来说"用哪个引擎"是要自己决定的，不该有个含糊的自动选项。
   */
  const rtItems = runtimes.map((r) => ({ id: r.id, label: r.label }));
  if (persona.builtin) rtItems.unshift({ id: 'auto', label: '自动（挑一个能用的）' });

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
   * 「发消息」= **开一段新的 1:1 会话**（2026-10-20，PRD P0-4）。
   * 一次任务一段，上下文不串味 —— 不再复用这个人最近那段（那是 `POST /api/personas/:id/open`
   * 的语义，服务端实现保留不动，只是详情页不再走它）。
   *
   * 连点保护（P1-2，主理人已拍板"复用"）：当前就停在这个人一段**一条消息都没有**的会话上
   * → 直接复用它，不再堆空壳。判断依据是 openConversation 本来就取到的 `d.messages`
   * （见 S.convEmpty）—— 零额外请求、零新字段。
   */
  const toMessages = async () => {
    try {
      /*
       * 复用判据末尾多一个"这段还在列表里"：被「不显示」收着的空会话**不复用** ——
       * 复用既不新建也不发消息，这段就永远没有回列表的机会（用户实报，
       * 群那侧先踩到：发起会话后列表里一直不出现，见 toGroupMessages）。
       * 不复用就会走下面的新建，新会话不带 hiddenAt，行自然回来。
       */
      const reuse =
        !!S.conversation &&
        S.conversation.kind === 'direct' &&
        S.conversation.personaId === persona.id &&
        S.convEmpty &&
        (S.conversations ?? []).some((c) => c.id === S.conversation.id);
      const convId = reuse
        ? S.conversation.id
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
    instructions: $('dInstr').value,
    runtime: rtCombo.value(),
    sandbox: sbCombo.value(),
    model: modelCombo.value(),
    cwd: $('dCwd').value,
    rootDirs: $('dRoots').value.split('\n').map((s) => s.trim()).filter(Boolean),
    showThinking: $('dThink').checked,
  });
  let lastSaved = JSON.stringify(collect());
  let saving = false;

  saveNow = async ({ keepalive = false } = {}) => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    const payload = collect();
    if (!payload.name.trim()) { setSaveState('名字不能空 · 未保存', 'bad'); return false; }
    const json = JSON.stringify(payload);
    if (json === lastSaved) { setSaveState('已保存', 'ok'); return true; }
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
        // 页头（名字 / 岗位 / 头像）与左栏名字同步 —— 不重画整页
        const nameEl = $('dNameText');
        if (nameEl) nameEl.textContent = p.name;
        const roleEl = $('dRolePill');
        if (roleEl) { roleEl.textContent = p.role || ''; roleEl.style.display = p.role ? '' : 'none'; }
        const av = $('detailView')?.querySelector('.p-head .avatar');
        if (av) av.textContent = initial(p.name);
        // 左栏 / 会话里的名字也跟着变（只跟内存和左栏打交道，不重画详情页）
        (S.conversations || []).forEach((c) => { if (c.personaId === p.id) c.personaName = p.name; });
        if (S.conversation?.personaId === p.id) S.conversation.personaName = p.name;
        if (S.nav === 'contacts' || S.nav === 'messages') {
          // 左栏标题固定「通讯录」（不做面包屑，2026-10-20）—— 改名不用再同步标题，
          // 只有左栏真是通讯录时才要管；在消息页那一栏是会话（从聊天页头点进资料会停在这条路）。
          renderList();
        }
      }
      setSaveState('已保存', 'ok');
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
  for (const id of ['dName', 'dRole', 'dInstr', 'dCwd', 'dRoots']) {
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
