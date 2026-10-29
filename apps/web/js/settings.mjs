/* settings.mjs —— 设置、关于、额度。
 * 2026-10-22 由 app.js（15537 行单文件）拆出，原生 ESM、无打包器；逻辑逐字搬运。 */
import { esc, setRoute, setTheme, toast } from './shell.mjs';
import { api, dt, failHtml, post, showFail } from './ui.mjs';
import { headRow, renderPlugins, renderRuntimes, rtLoading } from './connectors.mjs';
import { openRemotePage, setPluginRerender } from './experts.mjs';
import { renderList, showView } from './contacts.mjs';
import { setListTitle } from './flowpages.mjs';
import { openCodeRepoPage, renderSkillCards } from './skills.mjs';
import { renderPairing } from './pairing.mjs';
import { renderRoles } from './roleadmin.mjs';
import { renderUsers } from './useradmin.mjs';
import { $, S } from './core.mjs';



/* ---------------------------------------------------------------- 设置 */

/**
 * 设置左栏那一列分节：**分组版**（2026-10-29 用户定稿："设置页各项乱糟糟的" → 分区）。
 * 十个分节收成五组，顺序 = 左栏顺序；组头在左栏画成灰字分段标题（contacts.mjs 渲染），
 * 每组两件事，扫一眼就知道"哪类东西在哪儿"，不用在一列平铺里从头找到尾。
 *
 * 左栏顶上**只写模块名「设置」**，当前是哪个分节写在**右边**的页头里 ——
 * 跟消息/通讯录同一个主从布局（左列是导航，右面是当前页）。
 */
export const SETTINGS_GROUPS = [
  {
    title: '通用',
    items: [
      ['prefs', '偏好设置', '主题与外观'],
      ['about', '关于', '版本与说明'],
    ],
  },
  {
    /* 「这台机器」= 模式页（2026-10-21 用户拍板：与「运行时」合并成一页；同日三改：两档 + 动作按钮）——
       分段控件只有 单机 / 总机；「接入总机…」是动作不是第三档，点了只会展开加入面板。
       「局域网」就是单机⇄总机的切换本体，不再是独立开关；备份独立成「数据管理」分节。 */
    title: '本机与设备',
    items: [
      ['runtimes', '这台机器', '模式 · 设备'],
      /* 「手机配对」（2026-11 手机端增量）：扫码连接手机 —— 局域网形态才有意义，
         未监听局域网时分节里给引导（见 pairing.mjs renderPairing 的 boundLan 分支） */
      ['pairing', '手机配对', '扫码连接手机'],
    ],
  },
  {
    /* 额度与生图都是"管模型"的事：额度管花销，生图管一条图片通道 —— 放一组。 */
    title: '模型与 AI',
    items: [
      ['quota', '额度', '每个模型每天最多用多少'],
      ['aiimage', '生图服务', '数字员工生成图片的通道'],
    ],
  },
  {
    title: '扩展',
    items: [
      ['plugins', '插件', '扩展点'],
      ['skills', '技能', '给数字员工用的能力包'],
    ],
  },
  {
    /* 「角色与菜单」（2026-10-28 第二刀）：角色 = 名字 + 一组菜单 key，先只存库。
       **设备形态不加进下面的平铺** —— 服务端五个口都要操作员，
       列出来就是"点一下吃一个 403"（那条规矩见 settingsSections 的注释）。 */
    title: '账号与权限',
    items: [
      ['roles', '角色与菜单', '角色能看见哪些菜单'],
      /* 「用户」（2026-10-28 第三刀）：账号 + 登录 + 角色分配。设备形态同样不加 —— 见上面那条。 */
      ['users', '用户', '账号与角色'],
    ],
  },
];

/*
 * 「代码托管」「远程连接」**不再列在设置左栏**（2026-10-26 用户："设置里的代码托管和远程连接入口去掉"），
 * 入口统一在「工作台 → 研发」区（见 experts.mjs 的 DEV_TILES）。
 * ⚠️ 同日二改：它们**连渲染也搬走了**（各自成了工作台的整页，`openRemotePage` /
 *    `openCodeRepoPage`），这里只是"不再列出"—— 老位置 `openSettings('code' / 'remote')`
 *    在函数开头一律转发，别在这儿再加渲染分支（会画出第二个宿主）。
 *
 * 已搬走、不再出现在这里的：数据管理（2026-10-29 起 = 「这台机器」页底部的一个区，machine.mjs
 * renderBackupSection）、飞书（2026-10-29 起 = 员工详情 › 配置 tab › 「飞书」子页，chat.mjs
 * mountFeishuPanel）。`openSettings` 里留着对应 section 的旧路由转发，别删。

/*
 * 手机设备（受限视图）的「我的」= 设备信息 + 可用设置（2026-10-28，设计 T04 第 1 条）。
 *
 * 为什么单独一份而不是在渲染里逐条 `if`：服务端白名单已经决定设备碰不到
 * 技能/连接器/插件/飞书/额度/数据管理/这台机器/手机配对 —— 左栏还把它们列出来，
 * 用户点一个吃一个 E4033 toast，等于把「没权限」包装成「这东西坏了」。
 * 设备端只留**真能用**的三节；`/api/pair/me` 就是「这台手机」那节的数据源。
 */
export const DEVICE_SETTINGS_SECTIONS = [
  ['device', '这台手机', '配对与连接'],
  ['prefs', '偏好设置', '主题与外观'],
  ['about', '关于', '版本与说明'],
];

/**
 * 当前身份能看到的设置分节（**平铺**）：openSettings 的兜底判断用这一份。
 * 桌面管理员 = 分组拍平；设备 / 非管理员 = 各自的小清单。
 */
export function settingsSections() {
  if (S.isDevice) return DEVICE_SETTINGS_SECTIONS;
  /*
   * 非管理员的登录账号（2026-10-28 第三刀）：**只留「偏好设置」与「关于」**。
   *
   * 为什么硬编码两条而不是"按菜单 key 拆设置小节"：设置里的每一节对应的是
   * **这台机器的管理动作**（改模型路由、装卸插件、管账号…），逐节做权限就是
   * 给每节再配一份权限表，本刀明确不做（任务书 §八 非目标）。而"能看设置"这件事
   * 本身对这些账号仍然成立 —— 主题、关于是可以看的。
   */
  if (S.isUser && !S.isAdmin) {
    return SETTINGS_GROUPS.flatMap((g) => g.items).filter(([k]) => k === 'prefs' || k === 'about');
  }
  return SETTINGS_GROUPS.flatMap((g) => g.items);
}

/**
 * 左栏分组渲染用（2026-10-29 分区）：`[{title, items}]`。
 *
 * **只有桌面管理员画组头** —— 设备形态 3 节、非管理员 2 节，本来就短，
 * 再切一组反而是给短列表加噪音；这两种形态 `title: null` = 渲染时不画组头。
 * 组内顺序即左栏顺序，`settingsSections()` 就是把它拍平的，两份永远同源。
 */
export function settingsGroups() {
  if (S.isDevice) return [{ title: null, items: DEVICE_SETTINGS_SECTIONS }];
  if (S.isUser && !S.isAdmin) return [{ title: null, items: settingsSections() }];
  return SETTINGS_GROUPS;
}



export function openSettings(section) {
  /* 旧路由兼容：合并前「这台机器」是独立分节 'machine'（保存的位置可能还指着它） */
  if (section === 'machine') section = 'runtimes';
  /* 旧路由兼容：「数据管理」2026-10-29 起是「这台机器」页底部的一个区，不再是分节 */
  if (section === 'backup') section = 'runtimes';
  /*
   * 「代码托管」「远程连接」已经搬成**工作台研发区的独立整页**（2026-10-26 二改）：
   * 它们不再是设置的分节，直接转发过去。
   * 这里必须**在切设置页之前**拦：老位置（历史深链接、刷新恢复存下的 section、
   * 别处残留的 openSettings('remote')）先画一遍设置页再跳，会闪一下、且左栏乱。
   */
  if (section === 'code') return openCodeRepoPage();
  if (section === 'remote') return openRemotePage();
  /*
   * 分节收敛（2026-10-28）：深链接、刷新恢复存下的 `S.settingsSection`、或别处残留的
   * openSettings('skills') 都可能指到**当前身份碰不到**的分节。设备形态不收敛的话，
   * 会画出一个每行都 403 的设置页 —— 所以按 `settingsSections()` 兜到第一个可用分节。
   */
  const allowed = settingsSections();
  const want = section || S.settingsSection || 'prefs';
  section = allowed.some(([k]) => k === want) ? want : allowed[0][0];
  setRoute('settings', { section });
  S.settingsSection = section;
  setPluginRerender(null);   // 换分节 = 换宿主：面板表单提交后的重画别再指回上一页
  showView('settings');
  /* 左栏顶上只写「设置」：这一列本身就是设置的分节列表，当前分节是右边的页面标题。
     2026-10-19 用户截图：「这个二级标题应该放在右边」—— 之前写成「设置 › 偏好设置」，
     等于把右边页面的标题挂在左边的列表头上，切换分节时左栏标题跟着跳，列表反而不像导航了。 */
  setListTitle('设置');
  renderList();
  if (S.settingsSection === 'device') return renderDeviceInfo();
  if (S.settingsSection === 'runtimes') return renderRuntimes();
  if (S.settingsSection === 'pairing') return renderPairing();
  if (S.settingsSection === 'plugins') return renderPlugins();
  if (S.settingsSection === 'quota') return renderQuota();
  if (S.settingsSection === 'skills') return renderSkillCards();
  if (S.settingsSection === 'roles') return renderRoles();
  if (S.settingsSection === 'users') return renderUsers();
  if (S.settingsSection === 'aiimage') return renderImageAi();
  if (S.settingsSection === 'about') return renderAbout();
  if (S.settingsSection !== 'prefs') return;

  const opts = [
    ['light', '浅色'],
    ['dark', '深色'],
    ['system', '跟随系统'],
  ];
  $('settingsView').innerHTML = `
    ${headRow('<b>偏好设置</b>')}
    <div class="detail-body">
      <section class="set-sec">
        <div class="set-head"><b>外观</b><span class="set-tag">仅本设备</span></div>
        <div class="set-box">
          <div class="set-row">
            <span class="set-label">主题</span>
            <div class="seg" id="themeSeg">
              ${opts
                .map(
                  ([v, label]) =>
                    `<button data-theme-opt="${v}" class="${S.theme === v ? 'on' : ''}">${label}</button>`,
                )
                .join('')}
            </div>
          </div>
        </div>
      </section>
      <div id="styleSecHost"></div>
    </div>`;

  $('themeSeg').querySelectorAll('[data-theme-opt]').forEach((el) => {
    el.onclick = () => setTheme(el.dataset.themeOpt);
  });
  // 回复风格是「全体数字员工」的写设置（PUT 对设备 403）—— 设备形态不渲染那一节
  if (!S.isDevice) loadReplyStyle().catch(() => {}); // 偏好里唯一要问服务端的一项（存在 config.json，跟设备走）
}

/*
 * 回复风格（2026-10-24 用户设计）：**雇主的沟通偏好**，一处设置、全体数字员工生效 ——
 * 跟上面那个「仅本设备」的主题是两码事，所以单独一节、标清"全体数字员工"。
 * 「言简意赅」= 派活时全员注入 my-adhd-caveman 技能（每轮都带，切换立即生效）。
 */
async function loadReplyStyle() {
  const host = $('styleSecHost');
  if (!host) return;
  let data = null;
  try {
    data = await api('/api/prefs');
  } catch (e) {
    host.innerHTML = `<section class="set-sec"><div class="set-head"><b>对话</b><span class="set-tag">全体数字员工</span></div>
      <div class="set-box"><div class="empty">${failHtml(e)}</div></div></section>`;
    return;
  }
  const styles = Array.isArray(data?.styles) && data.styles.length ? data.styles : [{ id: 'default', label: '默认' }];
  const cur = data?.replyStyle ?? 'default';
  host.innerHTML = `
    <section class="set-sec">
      <div class="set-head"><b>对话</b><span class="set-tag">全体数字员工</span></div>
      <div class="set-box">
        <div class="set-row">
          <span class="set-label">回复风格</span>
          <div class="seg" id="styleSeg">
            ${styles.map((s) => `<button data-style-opt="${esc(s.id)}" class="${s.id === cur ? 'on' : ''}">${esc(s.label)}</button>`).join('')}
          </div>
        </div>
        <div class="set-row">
          <p class="hint">「言简意赅」：动作先行、最多五步、一次只问一件事 —— 只管对话里的汇报，文档/稿子/结论表这些交付物不受影响。切换后下一轮对话就生效。</p>
        </div>
      </div>
    </section>`;
  $('styleSeg')?.querySelectorAll('[data-style-opt]').forEach((el) => {
    el.onclick = async () => {
      const id = el.dataset.styleOpt;
      try {
        await api('/api/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ replyStyle: id }) });
        $('styleSeg').querySelectorAll('[data-style-opt]').forEach((b) => b.classList.toggle('on', b.dataset.styleOpt === id));
        toast('已对全体数字员工生效');
      } catch (err) {
        toast(err.message, 'error');
      }
    };
  });
}



/* ---------------------------------------------------------------- 生图服务 */

/**
 * 生图服务（2026-10-23）：数字员工生成图片的通道，技能「班底 · 头像生成手册」教员工 curl 它。
 *
 * 形态沿用代码托管的「居中紧凑簇」（.gr-conn）：标签 | 输入框(≤520px) | 按钮位，
 * 状态行压在输入框正下方 —— 这里是三行（地址 / Key / 模型），所以加了 .stack 修饰类拉开行距。
 * Key 的口径与 GitHub 令牌一致：保存后只回显掩码，点「修改」才解锁重填；
 * 保存时 Key 留空 = 保留原值（服务端 writeConfig 的语义），改个模型名不用重贴 Key。
 */
export async function renderImageAi() {
  S.settingsSection = 'aiimage';
  const view = $('settingsView');
  view.innerHTML = rtLoading('生图服务');
  let cfg = null;
  try {
    cfg = await api('/api/ai/image-config');
  } catch (e) {
    view.innerHTML = `${headRow('<b>生图服务</b>')}<div class="empty">${failHtml(e)}</div>`;
    return;
  }
  const configured = !!cfg?.configured;

  view.innerHTML = `
    ${headRow('<b>生图服务</b>')}
    <div class="detail-body">
      <section class="set-sec">
        <div class="set-head"><b>生图通道</b><span class="set-tag">OpenAI 兼容 images API</span></div>
        <div class="set-box">
          <div class="gr-conn stack">
            <div class="gr-conn-row">
              <span class="row-label">接口地址</span>
              <input id="aiBase" value="${esc(cfg?.baseUrl ?? '')}" autocomplete="off" spellcheck="false"
                     placeholder="https://api.example.com/v1（填到 /v1 这级）" />
              <span></span>
            </div>
            <div class="gr-conn-row">
              <span class="row-label">API Key</span>
              ${
                configured
                  ? `<input id="aiKey" class="locked" type="password" value="${esc(cfg?.keyHint ?? '')}" readonly data-locked="1"
                          aria-label="已保存的 Key，只显示掩码" autocomplete="off" />
                     <button id="aiKeyEdit">修改</button>`
                  : `<input id="aiKey" type="password" placeholder="粘贴 API Key（保存后只显示掩码）" autocomplete="off" />
                     <span></span>`
              }
            </div>
            <div class="gr-conn-row">
              <span class="row-label">模型</span>
              <input id="aiModel" value="${esc(cfg?.model ?? '')}" autocomplete="off" spellcheck="false"
                     placeholder="如 Kwai-Kolors/Kolors" />
              <span></span>
            </div>
            <div class="gr-conn-actions">
              <button class="primary" id="aiSave">保存配置</button>
              <button id="aiTest">测试连接</button>
            </div>
            <div class="gr-conn-status" id="aiStatus">${
              configured
                ? `<b style="color:var(--ok)">已配置</b> —— 数字员工可生成图片，点「测试连接」验证`
                : '未配置 —— 数字员工生成图片会失败（技能会提示用户来填）'
            }</div>
          </div>
          <p class="set-hint">填任意 OpenAI 兼容的生图服务（SiliconFlow / 火山方舟 / 混元 / 自建中转）。
          Key 存在本机数据目录，不上传、不进日志；数字员工通过技能「班底 · 头像生成手册」调用它生成头像等图片。</p>
        </div>
      </section>
    </div>`;

  const status = (html) => { $('aiStatus').innerHTML = html; };
  const keyInput = () => $('aiKey');

  /* 「修改」解锁 Key 框：清掉掩码变可编辑，语义是"这次保存会覆盖旧 Key"；
     解锁后按钮变「取消」，点它退回掩码锁定态（飞书 Secret 同款） */
  const aiKeyHint = cfg?.keyHint ?? '';
  $('aiKeyEdit')?.addEventListener('click', () => {
    const k = keyInput();
    if (!k.dataset.locked) {
      k.readOnly = true;
      k.classList.add('locked');
      k.dataset.locked = '1';
      k.value = aiKeyHint;
      k.placeholder = '';
      $('aiKeyEdit').textContent = '修改';
      return;
    }
    k.readOnly = false;
    k.classList.remove('locked');
    k.removeAttribute('data-locked');
    k.value = '';
    k.placeholder = '重新粘贴 API Key（留空则保留原值）';
    k.focus();
    $('aiKeyEdit').textContent = '取消';
  });

  $('aiSave')?.addEventListener('click', async () => {
    const body = { baseUrl: $('aiBase').value.trim(), model: $('aiModel').value.trim() };
    const k = keyInput();
    /* 掩码态（data-locked=1）说明用户没动 Key —— 不传，服务端保留原值 */
    if (!k.dataset.locked) body.apiKey = k.value.trim();
    try {
      await api('/api/ai/image-config', { method: 'PUT', body: JSON.stringify(body) });
      toast('已保存', 'ok');
      renderImageAi();
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  $('aiTest')?.addEventListener('click', async () => {
    status('<span style="color:var(--dim)">测试中…</span>');
    try {
      const r = await api('/api/ai/image-test', { method: 'POST', body: '{}' });
      status(
        `<b style="color:var(--ok)">连接正常</b>` +
          (r.modelListed === null ? '（服务未提供模型清单）' : r.modelListed ? ` —— 模型在服务清单里（共 ${r.models} 个）` : ` —— <b style="color:var(--warn,#c77d2e)">注意：模型「${esc(cfg?.model ?? '')}」不在服务清单（${r.models} 个）里，请核对拼写</b>`),
      );
    } catch (e) {
      status(`<b style="color:var(--bad,#c0504d)">连不上</b> —— ${esc(e.message)}`);
    }
  });
}



/* ---------------------------------------------------------------- 飞书（已迁走） */

/* 2026-10-29 用户定稿：飞书从「设置」搬进员工详情 › 配置 tab › 「飞书」子页，
 * 改成员工级 —— 一个数字员工对应一个飞书自建应用（自己的 App ID / Secret、
 * 自己的长连接通道、自己的白名单）。表单渲染在 chat.mjs 的 mountFeishuPanel。 */

/* ---------------------------------------------------------------- 关于 */

/**
 * 「关于」页（2026-10-22 用户要求加进设置菜单）：只回答"这是什么、什么版本、跑在哪"。
 *
 * 数据口径：版本 / 实例 / 机器名全部来自 `/api/hello` —— 它是服务端自己的答案，
 * 界面不写死版本字面量（写死一份，升级时就出现"页面 1.1.0、服务 1.2.0"这种自相矛盾）。
 */
/* ---------------------------------------------------------------- 这台手机（设备形态） */

/**
 * 手机设备的「我的」页首节（2026-10-28）：配对信息只读。
 *
 * 数据来自 `/api/pair/me`（`load()` 里取过一次，存在 `S.device`）—— 不再打
 * `/api/pair/devices`：那是**操作员**的设备清单（含别的手机），设备令牌碰它 403。
 * 「解除配对」只给指路：踢出是电脑端动作（白名单里没有 revoke，也不该有）。
 */
export function renderDeviceInfo() {
  const d = S.device ?? {};
  $('settingsView').innerHTML = `
    ${headRow('<b>这台手机</b>')}
    <div class="detail-body">
      <section class="set-sec">
        <div class="set-head"><b>配对信息</b><span class="set-tag">设备令牌</span></div>
        <div class="set-box">
          <div class="set-row">
            <span class="set-label">名称</span>
            <div class="machine-data">${esc(d.name ?? '手机设备')}</div>
          </div>
          <div class="set-row">
            <span class="set-label">配对于</span>
            <div class="machine-data">${esc(d.pairedAt ? dt(d.pairedAt) : '—')}</div>
          </div>
          <div class="set-row">
            <span class="set-label">解除配对</span>
            <div class="machine-data">在电脑上打开「设置 → 手机配对」，把这台设备踢出即可；踢出后本机下一次操作会提示重新扫码。</div>
          </div>
        </div>
      </section>
    </div>`;
}

export async function renderAbout() {
  $('settingsView').innerHTML = rtLoading('关于');
  let h = null;
  try {
    h = await api('/api/hello');
  } catch { /* 拉不到照常渲染：版本显示 —，别白屏 */ }
  $('settingsView').innerHTML = `
    ${headRow('<b>关于</b>')}
    <div class="detail-body">
      <section class="set-sec">
        <div class="set-box">
          <div class="set-row">
            <span class="set-label">产品</span>
            <div class="machine-data">班底 <span class="sub">自托管的多 agent 协作平台</span></div>
          </div>
          <div class="set-row">
            <span class="set-label">版本</span>
            <div class="machine-data">${h?.version ? esc(`v${h.version}`) : '—'}</div>
          </div>
          <div class="set-row">
            <span class="set-label">这台机器</span>
            <div class="machine-data">${esc(h?.hostname ?? '—')}</div>
          </div>
          <div class="set-row">
            <span class="set-label">实例标识</span>
            <div class="machine-data machine-addr">${esc(h?.instanceId ?? '—')}</div>
          </div>
          <div class="set-row">
            <span class="set-label">服务地址</span>
            <div class="machine-data machine-addr">${esc(location.origin)}</div>
          </div>
        </div>
      </section>
    </div>`;
}



/* ---------------------------------------------------------------- 额度 */

/**
 * 额度：**每个模型**每天最多用多少 token。
 *
 * 为什么按模型不按供应商：贵/便宜的分界线在**模型 id** 上，不在供应商上 ——
 * 本机 codex / dsh 只配了一个供应商（magpie 网关），
 * `group/auto-deepseek-v4-1-flash` 和 `opencode-zen-free/*` 都是它名下的模型。
 * 按供应商设额度 = 给 magpie 设一个数，会把免费的和收费的一起管住。
 *
 * 这一页是**开关**，闸本身在服务端（workflows.startCurrentStep 派活前拦一道）——
 * 所以这里只干三件事：把今天各模型的用量说清楚、让人逐行设上限、把口径写明白。
 *
 * 「已用多少」和「超没超」都来自服务端那一次读数（GET /api/quota），
 * 界面不自己再算一遍 —— 否则会出现"设置页看着没超、派活却被拦下"这种事。
 */
export async function renderQuota() {
  S.settingsSection = 'quota';
  $('settingsView').innerHTML = rtLoading('额度');
  let st;
  try {
    st = await api('/api/quota');
  } catch (err) {
    $('settingsView').innerHTML =
      `${headRow('<b>额度</b>')}<div class="empty">${failHtml(err)}</div>`;
    return;
  }
  paintQuota(st);
}



export function paintQuota(st) {
  const today = st.today ?? { tokens: 0, runs: 0, tokensText: '0' };
  const rows = st.models ?? [];
  const un = st.unattributed ?? { tokens: 0, runs: 0 };
  // 上限：null / 0 都是"不限制"。输入框留空就是它 —— 不摆一个"0"在里面，
  // 那看着像"配额 0"，跟"不限制"正好是反的。
  const cap = (v) => (v ? String(v) : '');
  const withLimit = rows.filter((r) => r.limitTokens || r.limitRuns).length;

  /*
   * 分组版式（2026-10-29 用户定稿："左边是组列表，右边是这个组的模型"）：
   * 组 = 模型 id 里第一个「/」前面那段（auto/…、group/…、opencode-zen-free/…），
   * 没有斜杠的是别名 / 独立模型（haiku 这类），收进「未分组」垫底。
   * 组只是**前端看的**：服务端 /api/quota 没有"组"这个概念，额度仍按模型一条条设，
   * 保存也仍是整表提交（每一组一张表，全部留在 DOM 里，qSave 一把全收）。
   * 选中组记在 S.quotaGroupPick（'*' = 全部），保存后重画时不丢。
   */
  const buckets = new Map();
  for (const r of rows) {
    const key = r.id.includes('/') ? r.id.slice(0, r.id.indexOf('/')) : '';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }
  const groups = [...buckets.keys()]
    .sort((a, b) => (a === '') - (b === '') || a.localeCompare(b))
    .map((key) => ({ key, rows: buckets.get(key) }));
  const pick = S.quotaGroupPick === '*' || buckets.has(S.quotaGroupPick) ? S.quotaGroupPick : '*';

  const sideItem = (key, label, n, warn) =>
    `<div class="ms-item${key === pick ? ' on' : ''}" data-qgroup="${esc(key)}">
      <span class="ms-item-name">${esc(label)}</span>
      ${warn ? '<span class="ms-dot-bad" title="这一组里有模型超了上限"></span>' : ''}
      <span class="ms-item-n">${n}</span>
    </div>`;

  const rowHtml = (r) => `<tr data-model="${esc(r.id)}">
      <td class="qt-id">
        ${esc(r.id)}
        <div class="qt-sub">${
          r.over
            ? `<span class="q-over">${esc(r.over)}</span>`
            : r.available
              ? esc(r.label)
              : '<span class="q-warn">现在各运行时里都没有这个模型了（今天还跑过）</span>'
        }</div>
      </td>
      <td class="qt-r ${r.over ? 'q-over' : ''}">${esc(r.usedText)}${
        r.usedRuns ? `<div class="qt-sub">${r.usedRuns} 次</div>` : ''
      }</td>
      <td class="qt-r"><input class="num" data-q="tokens" type="number" min="0"
        step="1000" placeholder="不限" value="${esc(cap(r.limitTokens))}" /></td>
      <td class="qt-r"><input class="num" data-q="runs" type="number" min="0"
        step="1" placeholder="不限" value="${esc(cap(r.limitRuns))}" /></td>
    </tr>`;

  $('settingsView').innerHTML = `
    ${headRow('<b>额度</b>')}
    <div class="detail-body">
      <section class="set-sec">
        <div class="set-head"><b>今天</b><span class="set-tag">本机时区 00:00 起算</span></div>
        <div class="set-box">
          <div class="set-row">
            <span class="set-label">全部模型合计</span>
            <span>${esc(today.tokensText)}<span class="dim"> · ${today.runs ?? 0} 次运行</span></span>
          </div>
          <div class="set-row">
            <span class="set-label">已经设了上限的模型</span>
            <span>${withLimit} 个<span class="dim"> / 共 ${rows.length} 个</span></span>
          </div>
          ${
            /* 认不出模型的那批**必须单独摆出来**：它们算不进任何模型的额度，
               藏着的话用户会以为"这些用量也在管着"，其实没有。 */
            un.runs
              ? `<div class="set-row">
                   <span class="set-label">认不出模型的</span>
                   <span class="q-warn">${esc(un.tokensText)} · ${un.runs} 次 —— 算不进任何模型的额度</span>
                 </div>`
              : ''
          }
        </div>
        ${
          un.runs
            ? `<div class="hint-line">那 ${un.runs} 次是这次升级之前跑的：那时候还没记"用的是哪个模型"。
                 从现在起新跑的都能认出模型。</div>`
            : ''
        }
      </section>

      <section class="set-sec">
        <div class="set-head"><b>每个模型每天的上限</b><span class="set-tag">留空＝不限制</span></div>
        ${
          rows.length
            ? `<div class="ms-split">
                 <div class="ms-side" id="qtSide">
                   <div class="ms-side-title">分组</div>
                   ${sideItem('*', '全部', rows.length, rows.some((r) => r.over))}
                   ${groups
                     .map((g) => sideItem(g.key, g.key || '未分组', g.rows.length, g.rows.some((r) => r.over)))
                     .join('')}
                 </div>
                 <div class="ms-main" id="qtTables">
                   ${groups
                     .map(
                       (g) => `<div class="qt-group-head" ${pick === '*' ? '' : 'hidden'}>${esc(g.key || '未分组')}</div>
                     <table class="quota-table" data-gtable="${esc(g.key)}" ${
                       pick === '*' || pick === g.key ? '' : 'hidden'
                     }>
                       <thead>
                         <tr>
                           <th>模型</th>
                           <th class="qt-r">今天已用</th>
                           <th class="qt-r">上限 token</th>
                           <th class="qt-r">上限次数</th>
                         </tr>
                       </thead>
                       <tbody>
                         ${g.rows.map(rowHtml).join('')}
                       </tbody>
                     </table>`,
                     )
                     .join('')}
                   <div class="qt-save"><button class="primary" id="qSave">保存</button></div>
                 </div>
               </div>`
            : `<div class="set-box"><div class="set-note">没读到任何模型 —— 各运行时的清单可能都没取到（看上面的提示），或者确实一个都没有。</div></div>`
        }
        <div class="hint-line" id="qMsg"></div>
      </section>

      <section class="set-sec">
        <div class="set-head"><b>这个数字是怎么来的</b></div>
        <div class="set-box">
          <div class="set-note">
            用量 = 每次运行自己报的 <code>totalTokens</code>，按<b>实际用的模型</b>分类加起来
            （员工绑了模型就是它；没绑就是那个 CLI 自己的默认模型）。四条要知道的偏差：<br />
            ① <b>只有约 80% 的运行有用量记录</b>（失败 / 被中途杀的那批没有）——
               所以另配一道<b>次数</b>兜底闸，次数是 100% 准的；<br />
            ② <b>缓存读占大头</b>（一次 12.5 万里，8.5 万是缓存读），按 totalTokens 一刀切会
               <b>高估成本</b> —— 这一版不做分项加权，当趋势看，别当账单；<br />
            ③ <b>归因不到就不拦</b>：认不出模型的运行（上面那一条）算不进任何额度，
               也不会因为额度被拦 —— 拿一个猜出来的模型去拦人比不拦更糟；<br />
            ④ 超了<b>不会静默拒绝派活</b>：那一步会标成「已阻塞」并写清是哪个模型超的，
               在实例页点「继续一次」可以放一步过去。
          </div>
        </div>
      </section>
    </div>`;

  /* 切组：只翻各表的 hidden / 左栏 .on，**不重画** —— 重画会把没保存的输入冲掉。
     「全部」= 每张表都露出来（组名小标题跟着露），选某一组就只留那一组。 */
  document.querySelectorAll('#qtSide .ms-item').forEach((el) => {
    el.onclick = () => {
      const key = el.dataset.qgroup ?? '*';
      S.quotaGroupPick = key;
      document.querySelectorAll('#qtSide .ms-item').forEach((x) => x.classList.toggle('on', x === el));
      document.querySelectorAll('#qtTables [data-gtable]').forEach((t) => {
        t.hidden = key !== '*' && t.dataset.gtable !== key;
      });
      document.querySelectorAll('#qtTables .qt-group-head').forEach((h) => {
        h.hidden = key !== '*';
      });
    };
  });

  $('qSave').onclick = async () => {
    /*
     * **整表提交**：页面上每一行都发出去，留空 = null = 不限制。
     * 只发填了的那些是不行的 —— 那样"把一个上限清空"跟"这次没动它"长得一样，删不掉。
     * 分组版式下当前组之外的表是 hidden 的，但**都还在 DOM 里**，
     * 所以照旧一表不落全收（这也正是"每组一张表都留在 DOM"的原因）。
     */
    const limits = {};
    document.querySelectorAll('.quota-table tr[data-model]').forEach((tr) => {
      const num = (k) => {
        const raw = tr.querySelector(`[data-q="${k}"]`)?.value.trim() ?? '';
        return raw === '' ? null : Number(raw);
      };
      limits[tr.dataset.model] = { dailyTokens: num('tokens'), dailyRuns: num('runs') };
    });
    $('qSave').disabled = true;
    try {
      const saved = await post('/api/quota', { limits });
      // 存完用服务端返回的那一份重画：顺带把"今天已用"刷成最新的
      paintQuota(saved);
      $('qMsg').textContent = '已保存。';
      $('qMsg').style.color = 'var(--ok)';
    } catch (err) {
      showFail($('qMsg'), err);
      $('qMsg').style.color = 'var(--bad)';
      $('qSave').disabled = false;
    }
  };
}
