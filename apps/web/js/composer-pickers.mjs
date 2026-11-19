/* composer-pickers.mjs —— 输入框右下角那两颗选择器：**权限**（员工级）与**模型**。
 * 2026-11-19 从 chat.mjs 拆出（那份 3934 行，改一个下拉的文案要翻三千行）。
 *
 * 只负责"选什么、怎么存"，不碰消息渲染与流式：
 *   · 权限是**员工级字段**（与员工详情里那颗是同一个），改一次影响这个员工的所有对话 ——
 *     界面上也得这么说，别让人以为是本会话的临时设置；
 *   · 模型是**会话级覆盖**：没覆盖跟随员工，员工没绑就落回 CLI 自己的默认；
 *   · 模型清单走 60s 缓存（`readModelList`），对话页与任务卡两处共用同一份口径。
 *
 * 依赖很浅（api / createCombo / $ / S / toast / load / SANDBOX_LABEL），没有模块级共享状态。
 * chat.mjs 原样再导出这些名字，调用方 import 路径不用改。
 */
import { toast } from './shell.mjs';
import { api, createCombo } from './ui.mjs';
import { load } from './state.mjs';
import { $, S } from './core.mjs';
import { SANDBOX_LABEL, sandboxItems } from './misc.mjs';
// 选完权限/模型要重画这一屏 —— 复用 chat.mjs 的 openConversation（与 listmenu.mjs 同一种
// 环形依赖，函数声明有提升，调用都发生在函数体内，安全）。2026-11-19 拆文件时漏了这一句。
import { openConversation } from './chat.mjs';

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



/**
 * **群聊**的权限下拉（2026-11-14 用户要求加回来）。
 *
 * 群和 1:1 不一样：成员可能跨运行时，员工详情那套"运行时方言"清单没法共用。
 * 这里给**通用三档**（canonical id，存 conversations.sandbox），派活时 runs 里的
 * `normalizeSandbox` 会按每个成员自己的运行时族换算 —— 完全权限 → codex `danger-full-access` /
 * claude `bypassPermissions`，工作区内读写 → `workspace-write` / `acceptEdits`，
 * 仅可查看 → `read-only` / `plan`。
 *
 * 语义与 1:1 的会话级覆盖同一条路：覆盖的是**这个群里派的活**，不动员工本身；
 * 选回「跟随员工默认」= 收回。程序化的只读约束（讨论模式）优先级更高，不受提权影响。
 */
export function groupPermCombo({ mount, conversationId, value, onDone }) {
  const items = [
    { id: '', label: '跟随员工默认' },
    { id: 'danger-full-access', label: SANDBOX_LABEL['danger-full-access'] },
    { id: 'workspace-write', label: SANDBOX_LABEL['workspace-write'] },
    { id: 'read-only', label: SANDBOX_LABEL['read-only'] },
  ];
  const labelOf = (id) => (items.find((it) => it.id === id) ?? {}).label ?? String(id ?? '');
  const combo = createCombo({
    mount,
    items,
    value: value ?? '',
    search: false,
    buttonText: (id) => (id ? labelOf(id) : '各随员工默认'),
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
      ? `这个群里派活统一按「${labelOf(id)}」跑 —— 用完点这里选回「跟随员工默认」收回`
      : '没覆盖：@ 谁就按谁自己的员工默认权限跑 —— 想统一设就点开选';
  };
  paint(combo.value());
  combo.el.classList.add('up'); // 往上弹（在输入区底部，往下弹会被切掉）
  return combo;
}



export function renderComposerPerm(d) {
  const mount = $('dPermMount');
  if (!mount) return;
  mount.innerHTML = '';
  const conv = d.conversation;
  /*
   * 群聊也放权限下拉（2026-11-14 用户要求；原来"群里每个人权限不同，放个假的没意义"直接不放）。
   * 放的**不是假的**：它写 conversations.sandbox，派活时 dispatch 会拿它盖过每个成员的默认 ——
   * 见 dispatch.startMemberRun 的会话级覆盖。
   */
  if (conv.kind === 'group') {
    groupPermCombo({
      mount,
      conversationId: conv.id,
      value: conv.sandbox,
      onDone: () => openConversation(conv.id),
    });
    return;
  }
  const rt = S.runtimes.find((x) => x.id === conv.runtime) ?? null;
  convPermCombo({
    mount,
    conversationId: conv.id,
    runtime: rt,
    value: conv.sandbox,
    personaSandbox: conv.personaSandbox,
    onDone: () => openConversation(conv.id),
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
