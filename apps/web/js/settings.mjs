/* settings.mjs —— 设置、关于、额度。
 * 2026-10-22 由 app.js（15537 行单文件）拆出，原生 ESM、无打包器；逻辑逐字搬运。 */
import { esc, setRoute, setTheme, toast } from './shell.mjs';
import { api, failHtml, post, showFail } from './ui.mjs';
import { headRow, renderPlugins, renderRuntimes, rtLoading } from './connectors.mjs';
import { renderBackup } from './machine.mjs';
import { renderRemoteConnection, setPluginRerender } from './experts.mjs';
import { renderList, showView } from './contacts.mjs';
import { setListTitle } from './flowpages.mjs';
import { renderGitRepos, renderSkillCards } from './skills.mjs';
import { $, S } from './core.mjs';



/* ---------------------------------------------------------------- 设置 */

/**
 * 设置左侧那一列分节：左栏列表用这一份（顺序 + 标题 + 副标题）。
 * 左栏顶上**只写模块名「设置」**，当前是哪个分节写在**右边**的页头里 ——
 * 跟消息/通讯录同一个主从布局（左列是导航，右面是当前页）。
 */
export const SETTINGS_SECTIONS = [
  ['prefs', '偏好设置', '主题与外观'],
  /* 「这台机器」= 模式页（2026-10-21 用户拍板：与「运行时」合并成一页；同日三改：两档 + 动作按钮）——
     分段控件只有 单机 / 总机；「接入总机…」是动作不是第三档，点了只会展开加入面板。
     「局域网」就是单机⇄总机的切换本体，不再是独立开关；备份独立成「数据管理」分节。 */
  ['runtimes', '这台机器', '模式 · 设备'],
  ['backup', '数据管理', '导入 / 导出本机数据'],
  ['quota', '额度', '每个模型每天最多用多少'],
  ['plugins', '插件', '扩展点'],
  ['skills', '技能', '给数字员工用的能力包'],
  ['code', '代码托管', '连接 GitHub、接入仓库'],
  /* 远程连接（2026-10-26）：原「服务器与密钥」界面插件收编为内置分节（slot=settings.section），
     数字员工的 SSH 工具随它出厂自带 —— 登记表、密钥、员工工具读的是同一本 ~/.bandi/servers.yaml。 */
  ['remote', '远程连接', 'SSH 服务器与密钥'],
  ['aiimage', '生图服务', '数字员工生成图片的通道'],
  ['about', '关于', '版本与说明'],
];



export function openSettings(section) {
  /* 旧路由兼容：合并前「这台机器」是独立分节 'machine'（保存的位置可能还指着它） */
  if (section === 'machine') section = 'runtimes';
  setRoute('settings', { section: section || S.settingsSection || 'prefs' });
  S.settingsSection = section || 'prefs';
  setPluginRerender(null);   // 换分节 = 换宿主：面板表单提交后的重画别再指回上一页
  showView('settings');
  /* 左栏顶上只写「设置」：这一列本身就是设置的分节列表，当前分节是右边的页面标题。
     2026-10-19 用户截图：「这个二级标题应该放在右边」—— 之前写成「设置 › 偏好设置」，
     等于把右边页面的标题挂在左边的列表头上，切换分节时左栏标题跟着跳，列表反而不像导航了。 */
  setListTitle('设置');
  renderList();
  if (S.settingsSection === 'runtimes') return renderRuntimes();
  if (S.settingsSection === 'backup') return renderBackup();
  if (S.settingsSection === 'plugins') return renderPlugins();
  if (S.settingsSection === 'quota') return renderQuota();
  if (S.settingsSection === 'skills') return renderSkillCards();
  if (S.settingsSection === 'code') return renderGitRepos();
  if (S.settingsSection === 'remote') return renderRemoteConnection();
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
  loadReplyStyle().catch(() => {}); // 偏好里唯一要问服务端的一项（存在 config.json，跟设备走）
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
 * 形态照抄代码托管的「居中紧凑簇」（.gr-conn）：标签 | 输入框(≤520px) | 按钮位，
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

  /* 「修改」解锁 Key 框：清掉掩码变可编辑，语义是"这次保存会覆盖旧 Key" */
  $('aiKeyEdit')?.addEventListener('click', () => {
    const k = keyInput();
    k.readOnly = false;
    k.classList.remove('locked');
    k.removeAttribute('data-locked');
    k.value = '';
    k.placeholder = '重新粘贴 API Key（留空则保留原值）';
    k.focus();
    $('aiKeyEdit').textContent = '已解锁';
    $('aiKeyEdit').disabled = true;
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



/* ---------------------------------------------------------------- 关于 */

/**
 * 「关于」页（2026-10-22 用户要求加进设置菜单）：只回答"这是什么、什么版本、跑在哪"。
 *
 * 数据口径：版本 / 实例 / 机器名全部来自 `/api/hello` —— 它是服务端自己的答案，
 * 界面不写死版本字面量（写死一份，升级时就出现"页面 1.1.0、服务 1.2.0"这种自相矛盾）。
 */
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
        <div class="set-box">
          <table class="quota-table" id="quotaTable">
            <thead>
              <tr>
                <th>模型</th>
                <th class="qt-r">今天已用</th>
                <th class="qt-r">上限 token</th>
                <th class="qt-r">上限次数</th>
              </tr>
            </thead>
            <tbody>
              ${
                rows.length
                  ? rows
                      .map(
                        (r) => `<tr data-model="${esc(r.id)}">
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
                        </tr>`,
                      )
                      .join('')
                  : '<tr><td colspan="4" class="dim" style="padding:16px">没读到任何模型 —— 各运行时的清单可能都没取到（看上面的提示），或者确实一个都没有。</td></tr>'
              }
            </tbody>
          </table>
          <div class="set-row">
            <span class="set-label"></span>
            <button class="primary" id="qSave">保存</button>
          </div>
        </div>
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

  $('qSave').onclick = async () => {
    /*
     * **整表提交**：页面上每一行都发出去，留空 = null = 不限制。
     * 只发填了的那些是不行的 —— 那样"把一个上限清空"跟"这次没动它"长得一样，删不掉。
     */
    const limits = {};
    document.querySelectorAll('#quotaTable tr[data-model]').forEach((tr) => {
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
