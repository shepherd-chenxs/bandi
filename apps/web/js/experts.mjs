/* experts.mjs —— 专家库、界面插件。
 * 2026-10-22 由 app.js（15537 行单文件）拆出，原生 ESM、无打包器；逻辑逐字搬运。 */
import { esc, savePlace, setRoute, toast } from './shell.mjs';
import { api, failHtml, initial, personaAvatar, post, renderMarkdown } from './ui.mjs';
import { load, setNav } from './state.mjs';
import { breadcrumb, headRow } from './connectors.mjs';
import { askText, confirmDo } from './machine.mjs';
import { openConversationSafe } from './listmenu.mjs';
import { renderList, showView } from './contacts.mjs';
import { openWorkflows, wbCard, workbenchFlowSection } from './workflows.mjs';
import { openProjectsPage, openTaskBoard, workbenchAutoSection, workbenchProjectSection } from './projects.mjs';
import { openFlowRun, setListTitle } from './flowpages.mjs';
import { openSchedules } from './skills.mjs';
import { setBusy, setComposer } from './chat.mjs';
import { gidOf, paintDrawer, paintGroupDetail } from './groups.mjs';
import { $, S } from './core.mjs';
import { applySource, calcVars } from './plugin-data.mjs';



/* -------------------------------------------------------------- 专家库 */

/**
 * 专家库（2026-10-23 改版：左侧一级栏，整页分区卡片墙）：出厂写死的岗位专家（跟随
 * 服务端目录走，当前十四位 —— 前端不写死数量和 key），
 * 点「雇佣」就是造一个现成的数字员工（职责、技能、运行时全都配好），解聘即删。
 *
 * 数据口径：
 *   · 目录从 `GET /api/experts` 拉一次缓存进 `S.experts`（null = 没拉过**或上一次没拉到**），
 *     雇佣/解聘后**整体重拉** —— hired 标记是服务端按库里有没有这个人算的，本地不推算；
 *   · 拉不到**不许装成空目录**（2026-10-21 用户截图实报：旧后端没有这个接口时，
 *     页面把错误画成"两段全空"，看着像专家库被清空了）。目录出厂恒有十四位，
 *     null 一律按「加载失败」渲染错误卡 + 重试，让用户知道是出错了、不是没人。
 *   · 雇佣后他就是个**普通数字员工**（改名/改指令/摘技能都走员工详情那套既有接口），
 *     专家域只管雇与解，别在专家页重做一套员工编辑。
 */
export async function loadExperts() {
  try {
    S.experts = (await api('/api/experts')).experts ?? [];
  } catch {
    S.experts = null; // 拉不到保持 null：paintExperts 按「加载失败」画，不冒充空目录
  }
}



/**
 * 专家库页的搜索词（本会话内记忆：切走再回来还在；刷新即清 —— 目录是每次现拉的，
 * 搜索词没有跨会话保值的必要，不为它动存储）。
 */
let expertQ = '';

/** 专家卡按搜索词过滤：命中**花名 / 岗位 / 一句话介绍 / 技能名**任一处即留（不区分大小写）。
 * 已雇佣的按**他现在的名字**匹配（用户改过名的话，搜新名要能搜到）。 */
function expertMatches(x, q) {
  const name = x.hiredPersona?.name || x.name || '';
  const hay = [name, x.role, x.intro, ...(x.skills ?? []).map((s) => s.name)].join('\n').toLowerCase();
  return hay.includes(q);
}

/**
 * 专家库整页（#expertsView）：跟工作台宫格同一个整页形态 —— 左栏收掉（body.no-list），
 * 页头放标题 + 搜索框（2026-10-23 加：目录十四位了，翻卡片找人不如下一关键字），
 * 无下钻。拉目录这段时间人可能已经点去别的栏了，回来先看 S.nav 再画。
 */
export async function openExperts() {
  setRoute('experts');
  if (S.es) { S.es.close(); S.es = null; S.running = false; setBusy(false); }
  setListTitle('专家库');
  // 兜底：从路由直达（刷新恢复）时 setNav 可能没跑过，整页形态自己摆好
  document.body.classList.add('no-list');
  $('listAction').classList.add('hidden');
  $('search').closest('.list-search')?.classList.add('hidden');
  $('listBody').innerHTML = '';
  savePlace();
  if (S.experts === null) await loadExperts();
  if (S.nav !== 'experts') return; // 拉目录时人走了，别抢别人的主区
  paintExperts();
}



/** 一张专家卡：头像（沿用 avatarStyle 配色）+ 名字/岗位 + 一句话 + 技能 chips + 动作 */
export function expertCard(x) {
  const hired = !!x.hired;
  const name = x.hiredPersona?.name || x.name;
  // 头像（2026-10-22）：已雇佣 → 员工自己的头像（用户可换）；未雇佣 → 目录头像
  // （apps/web/avatars/expert-<key>.png，跟着专家包走）；图 404 时 onerror 退字母，不破相
  const avatar = hired
    ? personaAvatar(x.hiredPersona, '', x.name)
    : personaAvatar({ name: x.name, avatar: `expert-${x.key}.png` }, '', x.name);
  return `<div class="expert-card" data-expert-key="${esc(x.key)}">
    <div class="expert-top">
      ${avatar}
      <div class="expert-who">
        <div class="expert-name"><b>${esc(name)}</b></div>
        <div class="expert-role">${esc(x.role || '')}</div>
      </div>
    </div>
    <div class="expert-intro">${esc(x.intro || '')}</div>
    ${x.skills?.length
      ? `<div class="expert-skills">${x.skills
          .map((s) => `<span class="x-chip" title="${esc(s.description || s.name)}">${esc(s.name)}</span>`)
          .join('')}</div>`
      : ''}
    ${hired
      // 已雇佣（2026-10-23 三改）：胶囊本身可点 = 解聘入口（用户要求"再点击一下解聘，
      // 显示雇佣"）—— 点了先过 confirmDo 确认，解聘完原地退回「雇佣」。
      // 员工详情「⋯」菜单里的解聘入口保留，两处等价。
      ? '<button type="button" class="pill expert-hired expert-fire" data-expert-fire="' + esc(x.key) + '" title="已雇佣 —— 点击解聘">已雇佣</button>'
      // 未雇佣：右上角同一位置的「雇佣」胶囊（2026-10-21 用户要求：跟已雇佣胶囊一样大）
      : '<button type="button" class="pill expert-hired expert-hire" data-expert-hire="' + esc(x.key) + '">雇佣</button>'}
  </div>`;
}



/**
 * 人物详情弹窗（2026-10-25 用户要求：点人物卡，弹出人物详情卡）。
 * 版式（2026-10-25 二改：简介上移常驻、首个页签改名「技能」）：
 *   · 头部＝大头像、花名/岗位/雇佣状态；
 *   · **简介放页签上方**，两个页签都看得见；
 *   · 页签「技能」＝技能清单（名 + 一句话描述）；「岗位说明」＝instructions 全文自然排版
 *     （本来就是 markdown，走 renderMarkdown）。
 * 雇佣/解聘按钮与卡片右上角那枚胶囊**等价**（同一个 hireExpert / fireExpert），
 * 动作完不关弹窗：afterExpertAction 刷新的是墙和 S.experts，这里按新数据原地重画。
 */
function paintExpertDetail(x) {
  const hired = !!x.hired;
  const name = x.hiredPersona?.name || x.name;
  const avatar = hired
    ? personaAvatar(x.hiredPersona, 'big', x.name)
    : personaAvatar({ name: x.name, avatar: `expert-${x.key}.png` }, 'big', x.name);
  $('exdBody').innerHTML = `
    <div class="exd-top">
      ${avatar}
      <div class="exd-who">
        <div class="exd-name-row">
          <span class="exd-name">${esc(name)}</span>
          <span class="exd-role">${esc(x.role || '')} · ${hired ? '<span class="exd-on">已雇佣</span>' : '待雇佣'}</span>
        </div>
        ${x.intro ? `<div class="exd-intro">${esc(x.intro)}</div>` : ''}
      </div>
    </div>
    <div class="tabs exd-tabs">
      <button type="button" class="tab on" data-exd-tab="d">技能</button>
      ${x.instructions ? '<button type="button" class="tab" data-exd-tab="i">岗位说明</button>' : ''}
    </div>
    <div data-exd-panel="d">
      ${x.skills?.length
        ? `<div class="exd-sec"><div class="exd-skills">${x.skills
            .map((s) => `<div class="exd-skill"><b>${esc(s.name)}</b>${s.description ? `<span>${esc(s.description)}</span>` : ''}</div>`)
            .join('')}</div></div>`
        : '<div class="exd-sec"><div class="hint">没有挂技能</div></div>'}
    </div>
    ${x.instructions ? `<div data-exd-panel="i" hidden><div class="md-view exd-instr">${renderMarkdown(x.instructions)}</div></div>` : ''}
    <div class="dlg-actions">
      <button type="button" class="${hired ? 'danger' : 'primary'}" id="exdAct">${hired ? '解聘' : '雇佣'}</button>
      <button type="button" value="cancel">关闭</button>
    </div>`;
  // 页签切换（样式复用设置页/插件面板那套 .tabs）
  $('exdBody').querySelectorAll('[data-exd-tab]').forEach((t) => {
    t.onclick = () => {
      $('exdBody').querySelectorAll('[data-exd-tab]').forEach((b) => b.classList.toggle('on', b === t));
      $('exdBody').querySelectorAll('[data-exd-panel]').forEach((p) => {
        if (p.dataset.exdPanel === t.dataset.exdTab) p.removeAttribute('hidden');
        else p.setAttribute('hidden', '');
      });
    };
  });
  $('exdAct').onclick = async (e) => {
    e.preventDefault();
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      // fireExpert 的返回值：确认框点了取消是 false，成功是 undefined（不是 true！）
      // 所以只能按「 === false」认取消，写成 !ok 会把成功也当成取消、弹窗不重画（实测踩过）
      if (hired) {
        if ((await fireExpert(x.key)) === false) { btn.disabled = false; return; }
      } else {
        await hireExpert(x.key);
      }
      const fresh = (S.experts ?? []).find((it) => it.key === x.key);
      if (fresh) paintExpertDetail(fresh); // S.experts 已被 afterExpertAction 重拉，按新状态原地重画
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
    }
  };
}



/** 打开人物详情弹窗。S.experts 里找不到（目录刚好被重拉）就不开，别弹一扇空窗 */
export function openExpertDetail(key) {
  const x = (S.experts ?? []).find((e) => e.key === key);
  if (!x) return;
  paintExpertDetail(x);
  $('expertDlg').showModal();
}



/** 卡片墙本体：读 S.experts 现画。null = 目录没拉到 —— 画错误卡 + 重试，不冒充两段空态 */
/**
 * 卡片墙本体：读 S.experts 现画。
 * **一张完整卡片墙、按目录顺序排，不按雇佣状态分段**（2026-10-21 用户拍板：
 * 「不要单独列出来，只要把雇佣按钮改成已雇佣就可以了」）—— 雇佣状态长在卡片上：
 * 右上角一枚「已雇佣」胶囊（2026-10-21 二改：发消息/解聘两颗按钮撤掉，解聘收进
 * 员工详情的「⋯」菜单），未雇佣的保留「雇佣」按钮，卡片在墙上的位置不动。
 */
export function paintExperts() {
  if (S.experts === null) {
    $('expertsView').innerHTML = `
      <div class="detail-head head-row"><div class="head-title"><b>专家库</b></div></div>
      <div class="detail-body">
        <div class="empty" style="padding:36px 12px">
          专家目录没拉到 —— 多半是班底服务还没带上这个接口（旧进程没重启）。<br />
          重启服务或点下面的按钮再试。
        </div>
        <div style="text-align:center"><button class="primary" data-expert-retry="1">重试</button></div>
      </div>`;
    showView('experts');
    $('expertsView').querySelector('[data-expert-retry]').onclick = () => openExperts().catch((e) => toast(e.message, 'error'));
    return;
  }

  $('expertsView').innerHTML = `
    <div class="detail-head head-row"><div class="head-title"><b>专家库</b></div>
      <div class="expert-search"><input id="expertSearch" placeholder="搜花名 / 岗位 / 技能" value="${esc(expertQ)}" /></div>
    </div>
    <div class="detail-body"><div id="expertGrid"></div></div>`;
  showView('experts');

  // 搜索：**只重画卡片墙**（#expertGrid），不整页 innerHTML —— 整页重画会丢输入框焦点，
  // 打一个字框就瞎了，没法连着输入。输入词记进 expertQ，雇佣/解聘后重画也还在。
  const paintGrid = () => {
    const q = expertQ.trim().toLowerCase();
    const list = q ? S.experts.filter((x) => expertMatches(x, q)) : S.experts;
    $('expertGrid').innerHTML = `<div class="expert-grid">${list.map(expertCard).join('')}</div>${
      list.length
        ? ''
        : `<div class="empty" style="padding:36px 12px">没有匹配「${esc(expertQ.trim())}」的专家 —— 试试花名（顾仓）、岗位（运维）或技能名。</div>`
    }`;
    $('expertGrid').querySelectorAll('[data-expert-hire]').forEach((el) => {
      el.onclick = () => hireExpert(el.dataset.expertHire).catch((e) => toast(e.message, 'error'));
    });
    // 已雇佣胶囊可点 = 解聘（2026-10-23）：走 fireExpert 的确认弹窗，解聘完原地退回「雇佣」
    $('expertGrid').querySelectorAll('[data-expert-fire]').forEach((el) => {
      el.onclick = () => fireExpert(el.dataset.expertFire).catch((e) => toast(e.message, 'error'));
    });
    // 点卡片本体 = 弹人物详情卡（2026-10-25）。卡上那两枚胶囊（雇佣 / 已雇佣）各有自己的
    // onclick，先拦一道 closest('button')，点胶囊不弹详情。
    $('expertGrid').querySelectorAll('[data-expert-key]').forEach((el) => {
      el.onclick = (e) => {
        if (e.target.closest('button')) return;
        openExpertDetail(el.dataset.expertKey);
      };
    });
  };
  paintGrid();

  $('expertSearch').oninput = (e) => {
    expertQ = e.target.value;
    paintGrid();
  };
}



/** 雇佣一位专家：成功后目录 + 人员两边重拉，本页重画（卡片原地变「已雇佣」，墙上的位置不动） */
export async function hireExpert(key) {
  const x = (S.experts ?? []).find((e) => e.key === key);
  await post(`/api/experts/${encodeURIComponent(key)}/hire`);
  toast(`已雇佣 ${x?.name ?? key}`);
  await afterExpertAction();
}



/**
 * 解聘一位专家：破坏性动作，先走全站统一的确认弹窗（confirmDo）。
 * 入口在员工详情的「⋯」菜单（2026-10-21 用户要求：卡片上不再摆解聘），
 * 专家库页只管雇佣；解聘完回到通讯录空态，目录重拉让卡片退回「雇佣」。
 */
export async function fireExpert(key, { stayContacts = false, name = null } = {}) {
  const x = (S.experts ?? []).find((e) => e.key === key);
  const nm = x?.hiredPersona?.name || x?.name || name || key;
  const ok = await confirmDo(
    `解聘「${nm}」？\n他会从通讯录移除，聊天记录保留；再雇佣会接上旧会话。`,
    { title: '解聘专家', ok: '解聘' },
  );
  if (!ok) return false;
  await post(`/api/experts/${encodeURIComponent(key)}/fire`);
  toast(`已解聘 ${nm}`);
  await afterExpertAction();
  if (stayContacts) {
    // 从详情页解聘的：别留一个指向已解聘员工的面板（同 dDelete 的收尾）
    S.persona = null;
    S.conversation = null;
    $('chat').innerHTML = '<div class="empty">还没有对话</div>';
    $('chatHead').innerHTML = '<span class="dim" style="padding:6px 0">左边选一个人，开始说话</span>';
    setComposer(false);
  }
}



/**
 * 雇佣/解聘之后的收尾：目录（hired 标记）与通讯录人员两边都要重拉；
 * 专家库还开着就按新数据重画（卡片在两段之间挪）。
 */
export async function afterExpertAction() {
  await Promise.all([loadExperts(), load()]); // load() 刷 personas（通讯录「数字员工」段跟着变）
  if (S.nav === 'experts') paintExperts();
}



/* -------------------------------------------------------------- 界面插件 */

/**
 * 声明式渲染（L1）：**不执行插件一行代码**，宿主按 manifest 里的 blocks 用自己的组件画。
 *
 * 数据源必须在插件的 permissions 白名单里 —— 没声明就取不到。
 * 但要说清：**这是"君子协定"，不是安全边界**。L1 下插件本来就不跑代码，
 * 所以够用；等做 L2（沙箱 iframe）时，真正挡住越权的是 sandbox 的 opaque origin
 * 加上服务端那道 guardWrite。
 */

/** `{字段}` 取值；取不到就渲染成空串（别显示 undefined） */
export function tpl(s, ctx) {
  return String(s ?? '').replace(/\{([A-Za-z0-9_.]+)\}/g, (_, key) => {
    const v = key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), ctx);
    return v == null ? '' : String(v);
  });
}



/** URL 里的 `{字段}`：**必须 encode**，否则一个带斜杠的字段值就能改掉请求路径 */
export function tplUrl(s, ctx) {
  return String(s ?? '').replace(/\{([A-Za-z0-9_.]+)\}/g, (_, key) => {
    const v = key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), ctx);
    return v == null ? '' : encodeURIComponent(String(v));
  });
}



/**
 * 工作台磁贴左上角那个**插件角标**：插接口（插头 + 插座）。
 *
 * 为什么要标：工作台是混排的 —— 「项目 / 任务看板 / 流程」是平台自带的，
 * 「服务器与密钥 / 研发面板」是装进来的插件。光看磁贴长得一样，分不出哪个是一等功能、
 * 哪个是插件。所以插件磁贴的图标左上角挂这个小图（平台自带的那几块不挂）。
 *
 * 为什么是"插接口"而不是四个方块：平台里"装进来的外部能力"就叫**连接器**（connector），
 * ssh 插件本身就是 `"connector": "ssh"` —— 插件 = 往平台里插一个东西，
 * 插头的形状正好说的是这件事。也不加底框、不加边框：就一个小图骑在图标角上，
 * 不抢图标本身（加框试过，浅色下会变成一圈很重的描边）。
 */
export const PLUGIN_BADGE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
  <path d="M15 3v6" />
  <path d="M9 3v6" />
  <path d="M6.5 9h11v3.2a5.5 5.5 0 0 1-11 0z" />
  <path d="M12 17.7V22" />
</svg>`;



/**
 * 插件磁贴的图标配色（v1.0.1 第 3 步）。
 *
 * 为什么是"按分组顺序发色"，而不是按分组名哈希：
 * 哈希看上去更"稳定"（同一个分类永远同色），但**碰撞是随机的** —— 实测哈希把
 * 「研发」和「运维」撞成同一个紫、「开发」和「生产力」撞成同一个青，一眼就看得出。
 * 而实际工作台上同时存在的分组只有 2~4 个（研发面板 / ssh 各自一个分类），
 * 按**首次出现的顺序**发色，同屏的几组必然不同色 —— 这才是这一格要的效果。
 * 代价：新装一个分类可能让后面几组的颜色挪位（分组重排时本来就会重排），可以接受。
 *
 * 色相只在 190°~330° 之间循环（青 → 蓝 → 紫 → 品红）：这一圈里**没有黄**。
 * 白字压在色块上要 ≥ 4.5:1，黄/橙在同样明度上对比度掉得最快（实测 #a86400 只有 4.68，
 * 再亮一点就破线）。绕开这一段，白字就稳。
 * 饱和度 46%、明度 44%/28%：不是没颜色，是"分得开但压得住" ——
 * 主屏上一排高饱和色块会抢注意力，而这些只是入口。
 * ⚠️ **青/绿这一族要单独压暗**：同样的明度下，青绿在 WCAG 的亮度公式里权重大
 * （G 的系数 0.7152），hsl(192 46% 44%) 白字只有 3.70、hsl(172 46% 44%) 只有 3.03 —— 破线。
 * 所以 192 / 172 这两位的起点明度降到 36%（对应 4.9~5.1），其余保持 44%。
 * 改任何一个色位都要重算："相对亮度 → 1.05/(L+0.05)"，白字 ≥ 4.5。
 */
export const PLUGIN_HUES = [262, 192, 322, 214, 292, 172];


/** 少数色位需要不同的明度（见上面的注释）。没列出的走默认 44%/28% */
export const PLUGIN_LIGHT = { 192: 36, 172: 34 };


/** 一次渲染内：分组名 → 色位（每次重画重新发，顺序稳定则颜色稳定） */
export let wbHueTick = 0;


export let wbHueMap = new Map();


export const resetWbHues = () => { wbHueTick = 0; wbHueMap = new Map(); };


export function pluginHue(cat) {
  const key = String(cat || '应用');
  if (!wbHueMap.has(key)) {
    wbHueMap.set(key, PLUGIN_HUES[wbHueTick % PLUGIN_HUES.length]);
    wbHueTick++;
  }
  return wbHueMap.get(key);
}


/** 一个分组一种颜色的内联样式（起点亮、终点暗，同一档的渐变） */
export const wbIcoStyle = (cat) => {
  const h = pluginHue(cat);
  const l1 = PLUGIN_LIGHT[h] ?? 44;
  const l2 = l1 - 16; // 终点固定比起点暗 16 个明度：同一色相的两档，渐变不会脏
  return `style="--wb-1:hsl(${h} 46% ${l1}%);--wb-2:hsl(${h} 52% ${l2}%)"`;
};



/** 从接口返回里取数组：可以是数组本身，也可以 pick 某个键 */
export function pickItems(body, pick) {
  if (Array.isArray(body)) return body;
  if (pick && Array.isArray(body?.[pick])) return body[pick];
  if (!pick) {
    const arr = Object.values(body ?? {}).find(Array.isArray);
    if (arr) return arr;
  }
  return [];
}



/** rail 里能用的：**已装 ＋ 启用 ＋ 合法 ＋ 有界面**。在设置里卸掉或停用，工作台上就没了 */
export const usablePlugins = () =>
  S.plugins.filter((p) => p.installed && p.enabled && p.valid && p.panel?.slot === 'plugins');



/**
 * 渲染时把行数据记在这里，点击行内按钮时按「块:行」回查。
 * 不塞进 DOM 的 data 属性：那样得处理 JSON 转义和引号，很容易出错。
 */
export let pluginRows = {};



/**
 * 这一面板里**被引用到的表单**（list.add / 行内 edit / button.edit 指到的）。
 * 被引用 → 作为弹窗用，按钮画在引用它的那张表的标题行右侧；没人引用 → 就内嵌。
 * 这样 manifest 不用额外声明"我是弹窗还是内嵌"，少一个字段。
 */
export let pluginDialogForms = new Set();



/** code 块要复制的文本，按块下标存（点击时回查，不把长文本塞进 DOM 属性） */
export let pluginCopy = {};



/**
 * button 块的结果（`resultField`）。按「块:选中行」存 ——
 * 结果放在 DOM 里会被下一次重画冲掉，而且换一台机器不该还留着上一台的输出。
 */
export let pluginResult = {};



/**
 * 点一级栏的「工作台」＝ 回工作台首页（不记住上次打开的插件，进来就是宫格）。
 *
 * ⚠️ 「回宫格」这件事（清选中、记位置）**必须在拿插件清单之前同步做完**：
 * 刷新恢复时 `setNav('plugins')` 会先调它，紧接着 `restorePlace` 才去开项目看板 / 全局面板。
 * 原来这几行在 `await api('/api/plugins')` 之后 —— 那边一回来就把刚恢复的页面状态抹掉、
 * 再把宫格盖在看板上（"刷新一下又掉回工作台"就是这么来的）。现在：状态同步清、
 * 回来时若发现页面已被别的路径接管（选中了什么、或停在看板上）就不画宫格了。
 */
export async function openPlugins() {
  setRoute('plugins');
  S.plugin = null;
  S.projectList = false;   // 回宫格 = 离开项目页
  S.projectId = null;
  S.boardAll = false;      // 也离开全局面板
  savePlace();             // 点一级栏 = 回宫格首页，这个位置也要记
  try {
    S.plugins = (await api('/api/plugins')).plugins;
  } catch {
    S.plugins = [];
  }
  // 拿清单这段时间里页面可能已经被接管了（刷新恢复看板就是这种），或者人已经点去别的栏了
  // —— 那就别抢渲染（`S.nav` 也得看：点了一级栏「消息」就说明宫格不再是当前页面）
  if (S.nav !== 'plugins' || S.plugin || S.projectList || S.projectId || S.boardAll) return;
  renderList();
  renderWorkbench();
  // 显式「回工作台」时把**选择也复位**：否则下次重进工作台，renderList 会把上次那个
  // 插件 / 项目看板的位置又画回去（用户在子页里点了返回，结果一刷新又跳回去过 —— 踩过）
  delete S.plugin;
  delete S.pluginRow;
}



/** 工作台：没选应用就是目录，选了就是那个应用的页面 */
export function renderWorkbench() {
  if (S.plugin) return renderPluginPanel();
  renderWorkbenchGrid();
}



/**
 * 工作台首页 = **整页宫格**（2026-10-19 用户明确要求保留：「这个是整体的入口页，不能变」）。
 *
 * ⚠️ 中途我把它改成过"左栏目录 + 右栏空态"，理由是"工作台的子页全是左栏列表 + 右侧内容，
 * 首页也该一样"。那是**从形式倒推**的，回来一看明显不对：
 *   · 首页的职责是**总览**（一屏扫完所有入口、看得见分组），不是"再往里走一层"；
 *   · 换成目录后主区是一大块空白，等于把整个页面浪费掉；
 *   · 入口还被塞进常态收起的左栏 —— 打开 app 第一眼反而什么都看不见。
 * 所以定下来：**首页宫格（左栏收起）、子页才走「标题 + 动作」的页头。**
 * 这是有意的分野：入口页长得像入口，工作页长得像工作页。
 * （页头前面不放按钮 —— 当天加过一枚「← 工作台」，用户说"统一去掉"，见 headRow 的注释。）
 */
export function renderWorkbenchGrid() {
  resetWbHues(); // 每次重画从头发色：分组顺序不变 → 颜色不变；顺序变了 → 颜色跟着重排（不追求跨次稳定）
  const list = usablePlugins();
  // 宫格是整页布局：把左栏收掉（进插件后会由 renderPluginMaster 放回来）
  document.body.classList.add('no-list');
  setListTitle('工作台');
  $('listBody').innerHTML = '';
  $('listAction').classList.add('hidden');
  // 装上了但 manifest 有问题的：提示放在宫格最下面，
  // 否则插件作者只会看到"我装的插件不见了"，不知道哪里错了
  const broken = S.plugins.filter((p) => p.panel?.slot === 'plugins' && p.installed && !p.valid);
  const groups = new Map();
  for (const p of list) {
    const key = p.category || '应用';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  /* 所有分组**共用一个宫格容器**，分组名退化成一行小标题（`.wb-sec`）。
     原来每个分组是 `<section class="fx">`，`.fx + .fx` 自带横分隔线 —— 5 个小组竖着叠成
     5 条横带，每条右侧一片空白，分隔线反而比内容显眼。现在一屏铺不下就换行，不会"一带一块"。 */
  const pluginSections = [...groups]
    .map(
      ([cat, items]) => `<div class="wb-sec">${esc(cat)}</div>
        <div class="wb-grid">
          ${items
            .map(
              (p) => wbCard(
                'has-plug',
                `<i class="wb-badge" title="插件" aria-label="插件">${PLUGIN_BADGE_SVG}</i>${esc(initial(p.label))}`,
                p.label,
                p.description || p.label,
                `data-wb-open="${esc(p.id)}"`,
                wbIcoStyle(cat),
              ),
            )
            .join('')}
        </div>`,
    )
    .join('');

  $('pluginView').classList.remove('kb-page'); // 宫格是长页面，按普通滚动
  $('pluginView').innerHTML = `
    <div class="detail-head head-row"><div class="head-title"><b>工作台</b></div></div>
    <div class="detail-body wb-page">${
      list.length ? pluginSections : '' // 没装应用就不渲染这个区：空态横幅没人需要
    }${workbenchProjectSection()}${workbenchAutoSection()}${workbenchFlowSection()}${
      broken.length
        ? `<div class="wb-sec">装不上台面</div>
           ${broken
             .map((p) => `<div class="plg-err">${esc(p.id)}：${esc(p.errors.join('；'))}</div>`)
             .join('')}`
        : ''
    }</div>`;
  showView('plugin');

  const view = $('pluginView');
  view.querySelectorAll('[data-wb-open]').forEach((el) => {
    el.onclick = () => {
      S.plugin = el.dataset.wbOpen;
      setRoute('plugin', { id: S.plugin });
      S.pluginRow = null;      // 换插件了，上一个的选中行不适用
      S.projectList = false;   // 进插件 = 离开项目页（不然刷新会被项目那条路抢走）
      S.projectId = null;
      S.boardAll = false;
      savePlace();
      renderList();
      renderPluginPanel().catch((e) => toast(e.message, 'error'));
    };
  });
  // 流程编排：画节点、指派、发布（入口原来在 rail 的「工作流」，现在收进工作台）
  view.querySelector('[data-flow-design]')?.addEventListener('click', () => {
    openWorkflows().catch((e) => toast(e.message, 'error'));
  });
  // 流程：点一下先看**这个流程的发起记录**；发起是那个页面上的动作（＋）
  view.querySelectorAll('[data-flow-start]').forEach((el) => {
    el.onclick = () => openFlowRun(el.dataset.flowStart);
  });
  // 项目：点一下进项目列表（增删改查都在那儿）
  view.querySelector('[data-projects]')?.addEventListener('click', () => {
    openProjectsPage().catch((e) => toast(e.message, 'error'));
  });
  // 任务看板：同一张看板，范围是**所有项目**（站在全局看）
  view.querySelector('[data-task-board]')?.addEventListener('click', () => {
    openTaskBoard().catch((e) => toast(e.message, 'error'));
  });
  // 定时任务：入口原来在「设置」里，搬到工作台（2026-10-17 用户要求）
  view.querySelector('[data-schedules]')?.addEventListener('click', () => {
    openSchedules().catch((e) => toast(e.message, 'error'));
  });
}



/**
 * 插件能不能调这个接口 —— **每次调用前都查**，不是只在加载时校验一遍。
 *
 * 声明里允许带占位（`DELETE:/api/ssh/servers/{alias}`），占位匹配**一段非斜杠**。
 * 注意不能只把声明串里的 {x} 换成 *：实际路径里没有占位符，两边形状永远对不上
 * （这个坑踩过 —— 删除按钮会一直报"没声明权限"）。
 */
export function pathMatches(pattern, path) {
  const rx = String(pattern)
    .split(/(\{[^}]*\})/)
    .map((seg) => (/^\{[^}]*\}$/.test(seg) ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp('^' + rx + '$').test(String(path));
}



export function pluginCan(plugin, method, apiPath) {
  const want = String(method || 'GET').toUpperCase();
  return plugin.permissions.some((p) => {
    const i = String(p).indexOf(':');
    if (i < 0) return false;
    return String(p).slice(0, i).toUpperCase() === want && pathMatches(String(p).slice(i + 1), apiPath);
  });
}



export function pluginMust(plugin, method, apiPath) {
  if (!pluginCan(plugin, method, apiPath)) {
    throw new Error(`插件没声明这个权限：${String(method).toUpperCase()} ${apiPath}`);
  }
}



/** 按白名单取数据；同一次进面板内缓存，避免 list/table 各拉一遍 */
export async function pluginApi(plugin, apiPath) {
  pluginMust(plugin, 'GET', apiPath);
  if (!(apiPath in S.pluginData)) S.pluginData[apiPath] = await api(apiPath);
  return S.pluginData[apiPath];
}



/** 表单字段渲染 —— 内嵌表单和弹窗共用这一份，免得两处走样 */
export function pluginFormHTML(b, fid, state = {}) {
  const editing = state.editing ?? null;
  const values = state.values ?? {};
  return `<div class="plg-form" data-form="${esc(fid)}">${(b.fields ?? [])
    .map((f) => {
      const val = values[f.key] ?? f.value ?? '';
      const locked = editing && f.key === 'alias' ? ' readonly' : '';
      const input =
        f.type === 'textarea'
          ? `<textarea data-field="${esc(f.key)}" style="height:56px" placeholder="${esc(f.placeholder || '')}">${esc(val)}</textarea>`
          : `<input data-field="${esc(f.key)}" value="${esc(val)}" placeholder="${esc(f.placeholder || '')}"${locked} />`;
      return `<div class="plg-field">
        <div class="plg-field-label">${esc(f.label)}${f.required ? '<em>*</em>' : ''}</div>
        ${input}
        ${f.hint ? `<div class="plg-field-hint">${esc(f.hint)}</div>` : ''}
      </div>`;
    })
    .join('')}</div>`;
}



export const pluginFormId = (b) => b.formId || 'f' + b.__i;



/** 打开插件表单弹窗。新增和"编辑某一行"走的是同一个弹窗，只是初始值不同 */
export function openPluginForm(plugin, block, state = {}) {
  S.pluginFormDlg = { plugin, block, fid: pluginFormId(block) };
  $('plgFormTitle').textContent = state.editing
    ? `修改「${state.editing}」`
    : block.heading || '填写';
  $('plgFormBody').innerHTML = pluginFormHTML(block, pluginFormId(block), state);
  $('plgFormOk').textContent = block.submit?.label || '保存';
  $('plgFormDlg').showModal();
  setTimeout(() => $('plgFormBody').querySelector('input, textarea')?.focus(), 30);
}



/** 取单个字段（code 块的 pick 用）；没有 pick 就返回整个对象 */
export function pickOne(body, key) {
  if (!key) return body;
  return String(key)
    .split('.')
    .reduce((o, k) => (o == null ? undefined : o[k]), body);
}



/**
 * 按钮的 HTML。**`renderBlock` 和主从布局的标题行都走这里**。
 *
 * 为什么要抽出来：标题行那份原来是手写的，忘了设 `__row` —— 后果不只是"编辑不回填"，
 * 测/删 的 `{alias}` 也会变空，请求打到 `/api/ssh/servers//test` 静默 404。
 * 现在 `__row` 只有这一个赋值点，漏不掉。
 */
export function buttonHTML(b, row) {
  b.__row = row ?? {};
  return `<button${b.primary ? ' class="primary"' : ''}${
    b.title ? ` title="${esc(tpl(b.title, b.__row))}"` : ''
  } data-plg-act="${b.__i}">${esc(b.label)}</button>`;
}



/**
 * 一个区块：**标题在卡片外面**，卡片（.fx）里只放内容。
 * `extra` 是标题行右侧的东西（比如列表的「添加」按钮），传进来的已是 HTML。
 *
 * 提到模块级是因为主从布局那边的「测试结果」也要用同款包裹 —— 两处各写一遍迟早不一致。
 */
export function pluginSec(title, body, extra = '') {
  const bar =
    title || extra
      ? `<div class="plg-sec-head">${title ? `<label class="plg-sec-title">${esc(title)}</label>` : '<span></span>'}${extra}</div>`
      : '';
  return `<div class="plg-sec">${bar}<section class="fx">${body}</section></div>`;
}



/**
 * 渲染一个块。
 * `row` = 主从布局里**左边选中的那一行**。块里所有 `{字段}`、以及 `source.api` 的占位符，
 * 都拿它当上下文；没有主从布局时就是 `{}`，行为和以前完全一样。
 */
export async function renderBlock(plugin, b, row = {}) {
  // 取值优先级：行字段 > 数据源根对象。这样 detail 里既能写 {alias}，也能用接口返回的字段
  const ctx = (body) => ({ ...(body ?? {}), ...row });
  const titleOf = (body) => (b.heading ? tpl(b.heading, ctx(body)) : '');
  const head = titleOf({});
  const apiOf = (src) => tplUrl(src.api, row);

  const sec = pluginSec;

  if (b.type === 'text') {
    return sec(head, `<div class="plg-text">${esc(b.text)}</div>`);
  }

  if (b.type === 'keyvalue') {
    const body = b.source ? await pluginApi(plugin, apiOf(b.source)) : {};
    const rows = (b.rows ?? [])
      .map((r) => `<div class="info-row"><span>${esc(r.label)}</span><b>${esc(tpl(r.value, ctx(body)))}</b></div>`)
      .join('');
    return sec(titleOf(body), rows);
  }

  /**
   * steps 块：把一组 [{title, note, command}] 铺成**编号步骤**，每步的命令能单独复制。
   * 比一整段脚本好读，也正对"用户是一个个复制命令"这件事 —— 整段脚本本来也没法直接执行。
   */
  if (b.type === 'steps') {
    const src = b.source ? await pluginApi(plugin, apiOf(b.source)) : {};
    const list = pickOne(src, b.source?.pick);
    const steps = Array.isArray(list) ? list : [];
    steps.forEach((s, si) => { pluginCopy[`${b.__i}:${si}`] = String(s.command ?? ''); });
    return sec(
      titleOf(src),
      steps.length
        ? `<div class="plg-steps">${steps
            .map(
              (s, si) => `<div class="plg-step">
                <div class="plg-step-head">
                  <span class="plg-step-n">${si + 1}</span>
                  <b>${esc(tpl(s.title, ctx(src)))}</b>
                  ${s.where ? `<span class="plg-step-where">在${esc(tpl(s.where, ctx(src)))}执行</span>` : ''}
                  <button class="btn-sm" style="margin-left:auto" data-plg-copy="${b.__i}:${si}">复制命令</button>
                </div>
                ${s.note ? `<div class="plg-step-note">${esc(tpl(s.note, ctx(src)))}</div>` : ''}
                <pre class="plg-code">${esc(tpl(s.command, ctx(src)))}</pre>
              </div>`,
            )
            .join('')}</div>`
        : `<div class="hint">${esc(b.empty || '没有步骤')}</div>`,
    );
  }

  /**
   * tabs 块（2026-10-24）：把几组块收进页签（服务器详情：基本信息 / 操作引导）。
   * 子块照常递归 renderBlock —— 取数、复制、兜底一个不少。页签切换走 #plgPanel 上
   * 那一个委托监听（见 renderPluginPanel 尾部），这里只出 HTML。
   */
  if (b.type === 'tabs') {
    const tabs = [];
    const panels = [];
    for (const [ti, t] of (b.tabs ?? []).entries()) {
      const inner = [];
      for (const sub of t.blocks ?? []) {
        try {
          inner.push(await renderBlock(plugin, sub, row));
        } catch (err) {
          inner.push(`<section class="fx"><div class="plg-err">${esc(sub.type)} 块出错：${failHtml(err)}</div></section>`);
        }
      }
      tabs.push(`<button type="button" class="tab${ti === 0 ? ' on' : ''}" data-plg-tab="${ti}">${esc(t.label)}</button>`);
      panels.push(`<div class="tab-panel" data-plg-tab-panel="${ti}"${ti === 0 ? '' : ' hidden'}>${inner.join('')}</div>`);
    }
    return `<div class="plg-tabs"><div class="tabs">${tabs.join('')}</div>${panels.join('')}</div>`;
  }

  /**
   * code 块：把一段文本（公钥、命令、测试输出）摊出来，可整段复制。
   * `plain: true` → **不要框、不要滚动条**，直接铺开（长指引塞进小框里要一直滚，很憋屈）；
   * 默认仍然用带框的 .plg-code（公钥那种一行长文本，有框才好选中）。
   */
  if (b.type === 'code') {
    const src = b.source ? await pluginApi(plugin, apiOf(b.source)) : {};
    const text = String(pickOne(src, b.source?.pick) ?? '');
    pluginCopy[b.__i] = text;
    b.__row = row;
    const hint = b.hint ? tpl(b.hint, ctx(src)) : '';
    const empty = !text && b.emptyAction ? b.emptyAction : null;
    const cls = b.plain ? 'plg-plain' : 'plg-code';
    // 复制 / 生成 这类动作放**标题行右侧**（和列表的「＋」同一个位置），不放卡里
    const action = text && b.copy !== false
      ? `<button class="btn-sm" style="margin-left:auto" data-plg-copy="${b.__i}">${esc(b.copyLabel || '复制')}</button>`
      : empty
        ? `<button class="primary btn-sm" style="margin-left:auto" data-plg-empty="${b.__i}">${esc(empty.label)}</button>`
        : '';
    return sec(
      titleOf(src),
      `${hint ? `<div class="plg-field-hint">${esc(hint)}</div>` : ''}
      ${text ? `<pre class="${cls}">${esc(text)}</pre>` : ''}`,
      action,
    );
  }

  // 表单块：被 list 的 add / 行内 edit 引用到就作为弹窗，别人画按钮；没人引用就内嵌
  if (b.type === 'form') {
    const fid = pluginFormId(b);
    if (pluginDialogForms.has(fid)) return '';
    return sec(head, pluginFormHTML(b, fid, S.pluginForm[fid]));
  }

  /**
   * cards 块（2026-10-24，概览页要的卡片网格）：一行行数据 → 一张张卡。
   * 和 list 的区别只在版式：list 是单列行、cards 是网格（`columns` 列）。
   * `card.href` 只挂 `data-card-href` + 可点样式，**本版不导航**（接进平台是下一步）。
   */
  if (b.type === 'cards') {
    const src = await pluginApi(plugin, apiOf(b.source));
    const { rows, total } = applySource(pickItems(src, b.source.pick), b.source);
    const card = b.card ?? {};
    const builtin = { shown_count: rows.length, total_count: total, count: rows.length };
    const ctxOf = (it) => ({ ...(src ?? {}), ...builtin, ...it });
    /**
     * 一行的值：模板里的**占位符全都取不到**、且写了 `fallback` → 用 fallback。
     * 「还没有已发布的版本」这类**空态文案属于内容**，写在 manifest 里，宿主不替它编。
     * ⚠️ 判"空"看的是**占位符有没有值**，不是渲染结果是不是空串：
     * `"{a} · {b}"` 两边都空时算出来的是 `" · "`，按结果判会当成"有值"
     * （截图里表现为只有标签、右边一个孤零零的圆点，fallback 永远不出现）。
     */
    const lineVal = (r, c) => {
      const raw = String(r.value ?? '');
      const keys = [...raw.matchAll(/\{([A-Za-z0-9_.]+)\}/g)].map((m) => m[1]);
      const empty =
        keys.length > 0 &&
        keys.every((k) => {
          const v = k.split('.').reduce((o, kk) => (o == null ? undefined : o[kk]), c);
          return v == null || String(v).trim() === '';
        });
      if (empty && r.fallback) return tpl(r.fallback, c);
      return tpl(raw, c);
    };
    const lineOf = (r, it) =>
      `<div class="plg-card-line"><span>${esc(tpl(r.label, ctxOf(it)))}</span><b>${esc(lineVal(r, ctxOf(it)))}</b></div>`;
    const body = rows.length
      ? `<div class="plg-cards" style="--plg-cols:${Number(b.columns) || 3}">${rows
          .map((it) => {
            const c = ctxOf(it);
            const href = card.href ? tpl(card.href, c) : '';
            const badge = card.badge ? tpl(card.badge, c) : '';
            const members = card.members ? tpl(card.members, c) : '';
            const lines = (card.lines ?? []).filter((r) => tpl(r.value, c) !== '' || r.label);
            const foot = (card.foot ?? []).filter((r) => tpl(r.value, c) !== '');
            return `<div class="plg-card${href ? ' has-href' : ''}"${href ? ` data-card-href="${esc(href)}"` : ''}${
              href ? ` title="${esc(href)}"` : ''
            }>
              <div class="plg-card-top">
                <div class="plg-card-who">
                  <div class="plg-card-title">${esc(tpl(card.title, c))}</div>
                  ${card.subtitle ? `<div class="plg-card-sub">${esc(tpl(card.subtitle, c))}</div>` : ''}
                </div>
                ${badge ? `<span class="plg-badge ${esc(card.badgeTone || 'neutral')}">${esc(badge)}</span>` : ''}
              </div>
              ${members ? `<div class="plg-card-meta">${esc(members)}</div>` : ''}
              ${lines.length ? `<div class="plg-card-lines">${lines.map((r) => lineOf(r, it)).join('')}</div>` : ''}
              ${foot.length
                ? `<div class="plg-card-foot">${foot
                    .map(
                      (r) =>
                        `<div class="plg-card-line"><span>${esc(tpl(r.label, c))}</span><b>${esc(lineVal(r, c))}</b></div>`,
                    )
                    .join('')}</div>`
                : ''}
            </div>`;
          })
          .join('')}</div>`
      : `<div class="hint">${esc(b.empty || '没有数据')}</div>`;
    /** 标题行：heading 在左，`subheading` 跟着，`more` 贴右（都走模板，`{shown_count}` 可用） */
    const sub = b.subheading ? `<span class="plg-sec-sub">${esc(tpl(b.subheading, builtin))}</span>` : '';
    const more = b.more?.label ? `<span class="plg-sec-more">${esc(tpl(b.more.label, builtin))}</span>` : '';
    const titleBar =
      titleOf({}) || sub || more
        ? `<div class="plg-block-head">${titleOf({}) ? `<b class="plg-block-title">${esc(titleOf({}))}</b>` : ''}${sub}${more}</div>`
        : '';
    return `<div class="plg-block">${titleBar}${body}</div>`;
  }

  /**
   * stats 块（2026-10-24，概览页顶上一行数字）：一项一格，数字大、标签上、脚注下。
   * 每项的取值：先算 `calc`（得到若干变量）→ 再拿它 + 行数据根对象跑 `{字段}` 模板。
   * 所以「项目总数」写 `"value":"{count}"` + `"calc":"count"` 就够了，
   * 宿主里**没有**任何"项目""纳管"这类业务字眼。
   */
  if (b.type === 'stats') {
    const src = b.source ? await pluginApi(plugin, apiOf(b.source)) : {};
    const { rows } = b.source ? applySource(pickItems(src, b.source.pick), b.source) : { rows: [] };
    const items = (b.items ?? []).map((it) => {
      const c = { ...(src ?? {}), ...calcVars(it.calc, rows) };
      return `<div class="plg-stat ${esc(it.tone || '')}">
        <div class="plg-stat-lab">${esc(tpl(it.label, c))}</div>
        <div class="plg-stat-num">${esc(tpl(it.value ?? '{value}', c))}${
          it.unit ? `<small>${esc(tpl(it.unit, c))}</small>` : ''
        }</div>
        ${it.foot ? `<div class="plg-stat-foot">${esc(tpl(it.foot, c))}</div>` : ''}
      </div>`;
    });
    // 列数按项数走（4 项就是 4 列）：声明里没写 columns，稿子也没要 —— 别让作者再写一遍
    return `<div class="plg-block">${
      titleOf({}) ? `<div class="plg-block-head"><b class="plg-block-title">${esc(titleOf({}))}</b></div>` : ''
    }<div class="plg-stats" style="--plg-cols:${items.length || 1}">${items.join('')}</div></div>`;
  }

  if (b.type === 'list') {
    const src = await pluginApi(plugin, apiOf(b.source));
    const items = applySource(pickItems(src, b.source.pick), b.source).rows;
    // 行数据记在内存里，点击时按「块:行」回查 —— 免得把 JSON 塞进 DOM 属性里做转义
    items.forEach((it, ri) => { pluginRows[`${b.__i}:${ri}`] = it; });
    const acts = b.actions ?? [];
    const html = items.length
      ? items
          .map(
            (it, ri) => `<div class="row-item plg-item">
              <div class="who">
                <b>${esc(tpl(b.title, it))}</b>
                <div class="sub">${esc(tpl(b.subtitle, it))}</div>
              </div>
              ${
                acts.length
                  ? `<div class="plg-row-actions">${acts
                      .map(
                        (a, ai) =>
                          `<button class="btn-sm${a.kind === 'delete' ? ' danger' : ''}" data-row-act="${b.__i}:${ri}:${ai}">${esc(a.label)}</button>`,
                      )
                      .join('')}</div>`
                  : ''
              }
            </div>`,
          )
          .join('')
      : `<div class="hint">${esc(b.empty || '没有数据')}</div>`;
    // 标题行右侧可以挂一个「添加」按钮（manifest 里 list.add 声明），
    // 标题行仍然在**卡片外面**，按钮跟着标题走
    const addBtn = b.add
      ? `<button class="primary btn-sm" style="margin-left:auto" data-form-open="${esc(b.add.form)}">${esc(b.add.label)}</button>`
      : '';
    return sec(titleOf(src), html, addBtn);
  }

  if (b.type === 'table') {
    const cols = b.columns ?? [];
    const src = await pluginApi(plugin, apiOf(b.source));
    const items = pickItems(src, b.source.pick);
    const body = items.length
      ? items
          .map(
            (it) => `<tr>${cols.map((c) => `<td>${esc(tpl('{' + c.key + '}', it))}</td>`).join('')}</tr>`,
          )
          .join('')
      : `<tr><td colspan="${cols.length}" class="dim">没有数据</td></tr>`;
    /**
     * 列宽（可选）：任意一列写了 `width` → 整张表切成 `table-layout: fixed`，
     * 写了宽度的按声明，没写的平分剩下的。
     *
     * 为什么非要有这个：`table-layout: auto` 下中文**每个字都能断行**，
     * 于是「要点」「证据」这种长文本列会把「编号」「状态」压到一两个字宽——
     * `T-001` 断成两行、`待部署` 竖排（真踩过）。给插件一个说清列宽的地方，
     * 比让宿主去猜"哪一列看起来短"靠谱。
     */
    const fixed = cols.some((c) => c.width);
    const colgroup = fixed
      ? `<colgroup>${cols.map((c) => `<col${c.width ? ` style="width:${esc(String(c.width))}"` : ''}>`).join('')}</colgroup>`
      : '';
    return sec(titleOf(src), `<table class="plg-table${fixed ? ' fixed' : ''}">${colgroup}
        <thead><tr>${cols.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead>
        <tbody>${body}</tbody>
      </table>`);
  }

  if (b.type === 'button') {
    const res = pluginResult[`${b.__i}:${S.pluginRow ?? ''}`] ?? '';
    return sec(
      head,
      `${buttonHTML(b, row)}${b.resultField ? `<pre class="plg-code"${res ? '' : ' hidden'}>${esc(res)}</pre>` : ''}`,
    );
  }

  return '';
}



/**
 * 主从布局的「主」：把列表画到**全局左栏**（和消息/通讯录同一个位置），
 * 而不是在右侧自己再画一列 —— 这样跟整个 app 的布局一致。
 * 返回选中的那一行。
 */
export async function renderPluginMaster(plugin, split) {
  const m = split.master ?? {};
  const keyField = m.keyField || 'id';
  const src = await pluginApi(plugin, m.source.api);
  const rows = pickItems(src, m.source.pick);
  const keyOf = (r) => String(r[keyField] ?? '');

  if (!rows.some((r) => keyOf(r) === String(S.pluginRow))) S.pluginRow = rows.length ? keyOf(rows[0]) : null;
  const sel = rows.find((r) => keyOf(r) === String(S.pluginRow)) ?? null;

  // 左栏顶上：工作台 › 插件名（面包屑从右页头挪过来；页头整条已去掉）
  // 不用 m.heading（「项目」「登记表」）—— 那是"这一列是什么"，面包屑要回答的是"你在哪儿"。
  setListTitle([{ label: '工作台', to: 'workbench' }, { label: plugin.label }]);
  $('listAction').classList.toggle('hidden', !m.add);
  $('listAction').title = m.add?.label || '';
  $('listBody').innerHTML = rows.length
    ? rows
        .map(
          (r) => `<div class="item${sel && keyOf(r) === keyOf(sel) ? ' active' : ''}" data-master="${esc(keyOf(r))}">
            <div class="who">
              <!-- 2026-10-20 收口：原来直接 b + div.sub（没有规则，标题 16px 粗体、副标题全色折行），
                   跟「项目」页的 .line1/.line2 长得不是一套。现在所有主从列表都用标准行结构。 -->
              <div class="line1"><b>${esc(tpl(m.title, r))}</b></div>
              ${m.subtitle ? `<div class="line2" title="${esc(tpl(m.subtitle, r))}">${esc(tpl(m.subtitle, r))}</div>` : ''}
            </div>
          </div>`,
        )
        .join('')
    : `<div class="empty" style="padding:32px 12px">${esc(m.empty || '还没有数据')}</div>`;

  $('listBody').querySelectorAll('[data-master]').forEach((el) => {
    el.onclick = () => {
      S.pluginRow = el.dataset.master;
      S.pluginData = {};   // 换了机器，缓存的数据不能再用
      savePlace();
      renderPluginPanel().catch((e) => toast(e.message, 'error'));
    };
  });

  return sel;
}



/**
 * 主从布局的「详情」：画在主区。
 * 选中项记在 `S.pluginRow`（键取 `master.keyField`，默认 `id`），重画后还在。
 * 详情块拿到选中行当上下文，所以 `{alias}`、`/api/ssh/servers/{alias}/key` 都直接写。
 */
export async function renderSplitDetail(plugin, split, m, sel) {
  const detail = [];
  if (sel) {
    for (const b of split.detail?.blocks ?? []) {
      // 逐块兜底：一块取数失败，别把整个详情拖成白屏
      try {
        detail.push(await renderBlock(plugin, b, sel));
      } catch (err) {
        detail.push(`<section class="fx"><div class="plg-err">${esc(b.type)} 块出错：${failHtml(err)}</div></section>`);
      }
    }
  }

  // 动作按钮在标题行右侧（测/改/删这类），结果跟在标题下面 —— 点完当场看得到
  // 走 buttonHTML：它负责把这一行塞进 __row，编辑回填和 URL 取值全靠这个
  const acts = (split.detail?.actions ?? []).map((b) => buttonHTML(b, sel)).join('');
  // 动作按钮的结果（连通性测试这种）用**悬浮提示**：
  // 原来是张卡插在详情顶部，把下面的内容整套往下推 —— 一次性输出不该占版面，而且要能关掉
  const toasts = sel
    ? (split.detail?.actions ?? [])
        .filter((b) => b.resultField)
        .map((b) => {
          const key = `${b.__i}:${S.pluginRow ?? ''}`;
          const out = pluginResult[key] ?? '';
          if (!out) return '';
          return `<div class="plg-toast">
            <div class="plg-toast-head">
              <b>${esc(tpl(b.resultTitle || b.label, sel))}</b>
              <button class="mini sm" data-toast-x="${esc(key)}" title="关闭">×</button>
            </div>
            <pre class="plg-code">${esc(out)}</pre>
          </div>`;
        })
        .join('')
    : '';

  return `<div class="plg-detail">${
    sel
      ? `<div class="plg-detail-head">
           <b>${esc(tpl(split.detail?.title || m.title, sel))}</b>
           ${split.detail?.subtitle ? `<span class="dim">${esc(tpl(split.detail.subtitle, sel))}</span>` : ''}
           ${acts ? `<div class="head-actions">${acts}</div>` : ''}
         </div>${detail.join('')}`
      : `<div class="wip">${esc(split.detail?.empty || '左边选一个')}</div>`
  }</div>${toasts}`;
}



export async function renderPluginPanel() {
  const plugin = S.plugins.find((p) => p.id === S.plugin);

  // 没选应用（或选的那个被卸掉了）→ 回工作台首页
  if (!plugin || !usablePlugins().some((p) => p.id === plugin.id)) {
    S.plugin = null;
    renderWorkbenchGrid();
    return;
  }

  // 有主从布局 → 用**全局左栏**放列表（和消息/通讯录同一位置）；
  // 没有 → 整页布局，把左栏收掉（见 CSS 的 body.no-list）。
  // ⚠️ 2026-10-19 用户：「面包屑应该是在左边的列表上，右边的不用」——
  //    有左栏时面包屑画在左栏顶上（renderPluginMaster 里），页头整条不要；
  //    没左栏时（整页插件面板）页头仍是面包屑，否则页面上没有任何"你在哪"。
  const split = plugin.panel.split ?? null;
  $('pluginView').classList.remove('kb-page'); // 插件面板是长页面（块会很长），按普通滚动
  // 进插件面板 = 离开项目页（两条路都写在 pluginView 里，位置记忆得分清是谁）
  S.projectList = false;
  S.projectId = null;
  $('pluginView').innerHTML = `
    ${split ? '' : headRow(breadcrumb([{ label: '工作台', to: 'workbench' }, { label: plugin.label }]))}
    <div class="detail-body" id="plgPanel"><div class="dim">加载中…</div></div>`;
  showView('plugin');

  S.pluginData = {};
  pluginRows = {};
  pluginCopy = {};

  // 顶部块 + 详情动作 + 详情块合成一张表：下标统一，按钮回查才不会串
  const allBlocks = [
    ...(plugin.panel.blocks ?? []),
    ...(split?.detail?.actions ?? []),
    ...(split?.detail?.blocks ?? []),
  ];
  allBlocks.forEach((b, i) => { b.__i = i; });
  // tabs 块里的子块也要有下标 —— 复制按钮按 `__i` 回查正文，缺了就复制不到东西
  for (const b of allBlocks) {
    (b.tabs ?? []).forEach((t, ti) => (t.blocks ?? []).forEach((sub, si) => { sub.__i = `${b.__i}.${ti}.${si}`; }));
  }

  // 先扫一遍：哪些表单被 add / 行内 edit 引用了 —— 被引用的走弹窗形态
  pluginDialogForms = new Set();
  for (const b of allBlocks) {
    if (b.type === 'list') {
      if (b.add?.form) pluginDialogForms.add(b.add.form);
      for (const a of b.actions ?? []) if (a.kind === 'edit' && a.form) pluginDialogForms.add(a.form);
    }
    if (b.type === 'button' && b.edit) pluginDialogForms.add(b.edit);
  }

  // 有主从布局 → 用**全局左栏**放列表（和消息/通讯录同一位置）；
  // 没有 → 整页布局，把左栏收掉（见 CSS 的 body.no-list）
  document.body.classList.toggle('no-list', !split);
  let sel = null;
  if (split) sel = await renderPluginMaster(plugin, split);
  else {
    setListTitle(plugin.label);
    $('listBody').innerHTML = '';
  }

  const blocks = plugin.panel.blocks ?? [];
  /**
   * `aside: true` 的块（cards / list）挂到右栏 `.plg-aside`，其余挂主列，整页两列栅格
   * （主列 1fr + 右栏 340px，照概览稿）。**只在单页面板生效**：主从布局的主列已经是
   * 全局左栏了，再切两列会挤成三条。
   *
   * 分区规则：开头**连续**的 `text` / `stats` 块（页头说明、KPI 行）通栏铺满整页，
   * 其余块进两列栅格（`aside: true` → 右栏，其它 → 主列）。照稿就是这样：
   * KPI 横跨整页，下面才分主列 / 右栏。不这么分的话 KPI 会被关进主列，
   * 右边 340px 那一溜从顶上就空着。
   * 判据是「开头连续」而不是「第一个 aside 之前」：主列的卡片网格也在 aside 之前，
   * 按后者它会被顶到通栏去（实现时踩过，主列只剩一条空线）。
   */
  const BANNER_TYPES = ['text', 'stats'];
  const bannerLen = split
    ? 0
    : (() => {
        let n = 0;
        while (n < blocks.length && BANNER_TYPES.includes(blocks[n].type) && !blocks[n].aside) n++;
        return n;
      })();
  const asideOn = !split && blocks.some((b) => b.aside);
  const render = async (b) => {
    // 逐块兜底：一块取数失败，别把整个面板拖成白屏
    try {
      return await renderBlock(plugin, b);
    } catch (err) {
      return `<section class="fx"><div class="plg-err">${esc(b.type)} 块出错：${failHtml(err)}</div></section>`;
    }
  };

  const above = [];    // 通栏（开头连续的 text / stats）
  const mainCol = [];  // 两列里的主列
  const asideCol = []; // 两列里的右栏
  for (const [i, b] of blocks.entries()) {
    const html = await render(b);
    if (asideOn && i >= bannerLen) (b.aside ? asideCol : mainCol).push(html);
    else above.push(html);
  }
  // 没有 aside 块、也没通栏块时，上面这个循环会把所有东西都塞进 above —— 那是老行为（顺排），对的

  // 详情画在主区（选中项的字段、公钥、交付指引、连通性结果都在这里）
  if (split) mainCol.push(await renderSplitDetail(plugin, split, split.master ?? {}, sel));

  $('plgPanel').innerHTML = asideOn
    ? `${above.join('')}<div class="plg-layout"><div class="plg-main-col">${mainCol.join(
        '',
      )}</div><aside class="plg-aside">${asideCol.join('')}</aside></div>`
    : [...above, ...mainCol].join('');
  return finishPluginPanel(plugin, allBlocks);
}

/**
 * 面板 DOM 铺好之后的接线（页签切换 / 表单 / 复制 / 行内动作…）。
 * 从 `renderPluginPanel` 尾部原样抽出来：两列版式那条路要提前 return，抽出来才不会漏接线。
 */
function finishPluginPanel(plugin, allBlocks) {
  // tabs 块的页签切换：委托在 #plgPanel 上一个监听管全部（面板重建时这里也重建，不会叠）
  $('plgPanel').addEventListener('click', (e) => {
    const t = e.target.closest('[data-plg-tab]');
    if (!t) return;
    const wrap = t.closest('.plg-tabs');
    if (!wrap) return;
    const i = t.dataset.plgTab;
    wrap.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.plgTab === i));
    wrap.querySelectorAll('[data-plg-tab-panel]').forEach((p) => p.toggleAttribute('hidden', p.dataset.plgTabPanel !== i));
  });

  // 标题行右侧的「添加」按钮（以及任何 data-form-open）→ 开表单弹窗
  $('plgPanel').querySelectorAll('[data-form-open]').forEach((el) => {
    const fb = allBlocks.find((x) => x.type === 'form' && pluginFormId(x) === el.dataset.formOpen);
    if (fb) el.onclick = () => openPluginForm(plugin, fb, {});
  });

  // 悬浮提示的关闭：清掉那份结果，并把浮层移掉（不用整页重画）
  $('plgPanel').querySelectorAll('[data-toast-x]').forEach((el) => {
    el.onclick = () => {
      delete pluginResult[el.dataset.toastX];
      el.closest('.plg-toast')?.remove();
    };
  });

  // code / steps 块的复制：按钮在标题行或步骤行、正文在卡里或步骤块里 —— 所以两种容器都找
  $('plgPanel').querySelectorAll('[data-plg-copy]').forEach((el) => {
    el.onclick = () =>
      copyText(
        el,
        pluginCopy[el.dataset.plgCopy] ?? '',
        el.closest('.plg-step, .plg-sec')?.querySelector('.plg-code, .plg-plain'),
      );
  });

  // code 块：内容为空时的那个按钮（「还没生成密钥 → 生成密钥对」）
  $('plgPanel').querySelectorAll('[data-plg-empty]').forEach((el) => {
    const b = allBlocks[Number(el.dataset.plgEmpty)];
    const act = b?.emptyAction;
    if (!act) return;
    el.onclick = async () => {
      const method = (act.method || 'POST').toUpperCase();
      const target = tplUrl(act.api, b.__row ?? {});
      if (act.confirm && !(await confirmDo(tpl(act.confirm, b.__row ?? {})))) return;
      el.disabled = true;
      try {
        pluginMust(plugin, method, target);
        const opts = { method };
        if (method !== 'GET') {
          opts.headers = { 'Content-Type': 'application/json' };
          opts.body = JSON.stringify(act.body ?? {});
        }
        const res = await api(target, opts);
        if (res.warning) toast(res.warning);
        S.pluginData = {};
        await renderPluginPanel();
      } catch (err) {
        toast(err.message, 'error');
        el.disabled = false;
      }
    };
  });

  $('plgPanel').querySelectorAll('[data-plg-act]').forEach((el) => {
    el.onclick = async () => {
      const b = allBlocks[Number(el.dataset.plgAct)];
      if (!b) return;

      // button.edit：打开表单弹窗，先把这一行灌进去
      if (b.edit) {
        const fb = allBlocks.find((x) => x.type === 'form' && pluginFormId(x) === b.edit);
        if (!fb) return toast(`manifest 里找不到表单「${b.edit}」`);
        openPluginForm(plugin, fb, { values: { ...(b.__row ?? {}) }, editing: (b.__row ?? {}).alias ?? '这一行' });
        return;
      }

      if (b.confirm && !(await confirmDo(tpl(b.confirm, b.__row ?? {})))) return;
      el.disabled = true;
      try {
        const a = b.action ?? {};
        const method = (a.method || 'POST').toUpperCase();
        const target = tplUrl(a.api, b.__row ?? {});
        pluginMust(plugin, method, target);           // 每次调用前都查白名单
        const opts = { method };
        if (method !== 'GET') {
          opts.headers = { 'Content-Type': 'application/json' };
          opts.body = JSON.stringify(a.body ?? {});
        }
        const res = await api(target, opts);
        // resultField：结果记在 state 里（不是 DOM），重画后还在；换机器会显示各自的那份
        if (b.resultField) pluginResult[`${b.__i}:${S.pluginRow ?? ''}`] = String(res?.[b.resultField] ?? '');
        S.pluginData = {};
        await renderPluginPanel();   // 重新取数并重画
      } catch (err) {
        toast(err.message, 'error');
        el.disabled = false;
      }
    };
  });

  // 表单提交：读 DOM 里的值 → 校验必填 → 打接口 → 清掉编辑态、重画
  $('plgPanel').querySelectorAll('[data-form-submit]').forEach((el) => {
    el.onclick = async () => {
      const fid = el.dataset.formSubmit;
      const b = allBlocks.find((x) => x.type === 'form' && (x.formId || 'f' + x.__i) === fid);
      const box = el.closest('.plg-form');
      const values = {};
      box.querySelectorAll('[data-field]').forEach((inp) => { values[inp.dataset.field] = inp.value.trim(); });

      const missing = (b.fields ?? []).filter((f) => f.required && !values[f.key]);
      if (missing.length) return toast('这几项得填：' + missing.map((f) => f.label).join('、'));

      el.disabled = true;
      try {
        const sub = b.submit ?? {};
        const method = (sub.method || 'POST').toUpperCase();
        pluginMust(plugin, method, sub.api);          // 每次提交前都查白名单
        const opts = { method };
        if (method !== 'GET') {
          opts.headers = { 'Content-Type': 'application/json' };
          opts.body = JSON.stringify(values);
        }
        await api(sub.api, opts);
        delete S.pluginForm[fid];
        await renderPluginPanel();
      } catch (err) {
        toast(err.message, 'error');
        el.disabled = false;
      }
    };
  });

  $('plgPanel').querySelectorAll('[data-form-cancel]').forEach((el) => {
    el.onclick = () => {
      delete S.pluginForm[el.dataset.formCancel];
      renderPluginPanel().catch((e) => toast(e.message, 'error'));
    };
  });

  // 行内操作：编辑（把这一行灌进表单）/ 调用接口（一般是删除）
  $('plgPanel').querySelectorAll('[data-row-act]').forEach((el) => {
    const [bi, ri, ai] = el.dataset.rowAct.split(':').map(Number);
    const b = plugin.panel.blocks[bi];
    const a = (b.actions ?? [])[ai];
    const row = pluginRows[`${bi}:${ri}`];
    if (!a || !row) return;

    el.onclick = async () => {
      if (a.kind === 'edit') {
        // 编辑走的是"添加"那个弹窗，只是先把这一行灌进去
        const fb = plugin.panel.blocks.find((x) => x.type === 'form' && pluginFormId(x) === (a.form || 'f' + bi));
        if (!fb) return toast(`manifest 里找不到表单「${a.form}」`);
        openPluginForm(plugin, fb, { values: { ...row }, editing: row.alias ?? '这一行' });
        return;
      }
      if (a.confirm && !(await confirmDo(tpl(a.confirm, row)))) return;
      el.disabled = true;
      try {
        const method = (a.method || 'POST').toUpperCase();
        const target = tplUrl(a.api, row);
        pluginMust(plugin, method, target);           // 每次调用前都查白名单
        const opts = { method };
        if (method !== 'GET') {
          opts.headers = { 'Content-Type': 'application/json' };
          opts.body = JSON.stringify(a.body ?? {});
        }
        await api(target, opts);
        await renderPluginPanel();
      } catch (err) {
        toast(err.message, 'error');
        el.disabled = false;
      }
    };
  });
}



/** 复制一段文本；剪贴板不可用就退而求其次：选中它，让用户自己 Ctrl+C */
export async function copyText(btn, text, bodyEl) {
  try {
    await navigator.clipboard.writeText(text ?? '');   // http://127.0.0.1 算安全上下文，能用
  } catch {
    if (!bodyEl) return;
    const r = document.createRange();
    r.selectNodeContents(bodyEl);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }
  const was = btn.textContent;
  btn.textContent = '已复制';
  setTimeout(() => { btn.textContent = was; }, 1200);
}



export function closeDrawer() {
  S.drawerOpen = false;
  S.drawerThreadId = null;
  S.drawerThread = null;
  S.removeMode = false;
  // 分流状态也要清：不清的话下次开群设置会被当成"上次是聊天记录"，
  // 画出的是别人的会话列表（同一个 DOM 两种内容的代价，必须成对清）
  S.drawerKind = null;
  S.logPersonaId = null;
  S.logGroupId = null;
  S.logGroupTitle = null;
  S.logLoading = false;
  $('drawer').classList.remove('open');
  // 清空：抽屉和群详情页渲染的是同一批 id（drawerSearch/mgrid…），留着旧 DOM 会打架
  $('drawer').innerHTML = '';
  $('scrim').classList.remove('open');
}



/**
 * 群设置改完之后刷新（改名 / 换群助手 / 加人 / 踢人）。
 *
 * 群的数据在**三个地方**同时显示，改一处三处都得跟上，否则会出现
 * "详情里叫 A、聊天头部还叫 B"：
 *   ① 通讯录的群详情页（`S.groupThreadId === groupId`）
 *   ② 群设置抽屉（`S.drawerKind === 'group' && S.drawerThreadId === groupId`）
 *   ③ 正在聊的这段群会话（`S.conversation.groupId === groupId`）—— 标题/群助手在会话上是镜像字段
 *
 * 用 `openConversationSafe` 重开 ③ 而不是就地改字段：头部、成员数、消息区是一起画的，
 * 拼字段迟早漏一处；重开一次的数据来自服务端，天然一致。
 */
export async function refreshGroup(groupId) {
  await load();
  const d = await api('/api/groups/' + encodeURIComponent(groupId));
  const group = d.group;

  if (S.groupThreadId === groupId) paintGroupDetail(group);
  if (S.drawerOpen && S.drawerKind === 'group' && S.drawerThreadId === groupId) {
    S.drawerThread = group;
    paintDrawer();
  }
  if (S.groupThreadId === groupId) { renderList(); return; }
  if (S.conversation?.groupId === groupId) { await openConversationSafe(S.conversation.id); return; }
  renderList();
}



export async function kickMember(thread, personaId, name) {
  if (!(await confirmDo(`把 ${name || '他'} 移出群？\n他之前说过的话会留着；再拉回来是干净的开始。`))) return;
  try {
    await api(`/api/groups/${encodeURIComponent(gidOf(thread))}/members/${encodeURIComponent(personaId)}`, {
      method: 'DELETE',
    });
    await refreshGroup(gidOf(thread));
  } catch (err) { toast(err.message, 'error'); }
}



/**
 * 解散群聊。
 *
 * **不抹聊天记录** —— 服务端只做三件事：解除成员关系、清掉各成员在这个群里的会话状态、
 * 给群和每段会话打 `dissolvedAt`（见 store.dissolveGroup）。
 *
 * 2026-10-20 用户定：解散后**消息仍留在消息列表里、只读**（以前是整群连着记录一起从界面收走，
 * 记录在库里却没有入口 = 等于删档）。所以解散完不把用户踢回空态：停在原地重画成只读，
 * 列表里那行的副标题变成「已解散」；通讯录里的群则消失（那边只列还能用的群）。
 * 发消息由后端兜底拒绝（E2049）—— 成员关系已清，不拦的话就是"点了没反应"。
 */
export async function dissolveGroup(thread) {
  /*
   * 成员数两种来源：群详情 / 群设置抽屉给的是 `members` 数组；
   * **消息列表右键**给的是 `S.conversations` 里那一行（只有 `memberCount`）。
   * 别写成 `thread.members.length` —— 从列表进来时那是 undefined，直接抛错。
   */
  const n = thread.members?.length ?? thread.memberCount ?? 0;
  // 消息列表右键给的是**群会话**（id 是会话 id），群详情/群设置给的是**群**。
  // 解散的永远是群，所以一律换算成 groupId —— 否则会拿着会话 id 去解散，404。
  const groupId = gidOf(thread);
  const ok = await confirmDo(
    `解散「${thread.title}」？\n\n` +
      `· ${n} 位成员的群关系会解除，这个群不能再 @ 人派活\n` +
      `· 群从通讯录移除；**聊天记录仍留在消息列表里**（只读，翻得到）\n\n` +
      `解散后恢复不了，确定吗？`,
  );
  if (!ok) return;
  try {
    const r = await api(`/api/groups/${encodeURIComponent(groupId)}`, { method: 'DELETE' });
    S.conversations = r.conversations;
    if (r.hiddenConversations) S.hiddenConversations = r.hiddenConversations;
    // 通讯录的群行读 S.groups（groups 表）：解散 = dissolvedAt 打上，本地先摘掉再重画
    S.groups = (S.groups ?? []).filter((g) => g.id !== groupId);
    closeDrawer();
    // 抽屉得关（成员都没了，那套设置已经没有意义）；群详情页也不能停在那儿
    if (S.groupThreadId === groupId) {
      S.groupThread = null;
      S.groupThreadId = null;
    }
    /*
     * 2026-10-20 用户定：解散后**消息仍留在列表里、只读**。
     * 所以"正在看这个群的一段会话"不该被踢回空态 —— 留在原地重画一次（输入框会自动置灰），
     * 用户刚才读到哪儿还在哪儿。只有从通讯录群详情页解散、手上没有这段会话时，才回消息列表。
     */
    const stillHere = S.conversation?.groupId === groupId ? S.conversation.id : null;
    setNav('messages'); // 内部会重画左栏列表（群行还在，副标题变成「已解散」）
    if (stillHere) await openConversationSafe(stillHere); // 重画成只读
  } catch (err) {
    toast(err.message, 'error');
  }
}



export async function renameGroup(thread) {
  const title = await askText({ title: '新的群名称', value: thread.title });
  if (title === null || !title.trim() || title === thread.title) return;
  try {
    await api('/api/groups/' + encodeURIComponent(gidOf(thread)), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title.trim() }),
    });
    await refreshGroup(gidOf(thread));
  } catch (err) { toast(err.message, 'error'); }
}
