/* pairing.mjs —— 设置页「手机连接」分节（2026-11 手机端增量）。
 *
 * 三块：
 *   ① 配对入口：先查 /api/lan —— boundLan=false 时手机根本连不进来（回环形态），
 *      给"去协作中心切成对外服务并重启"的引导，不出邀请码（设计 §1.3 前置条件）。
 *      ⚠️ 前提是**对外服务**，不是"总机"：2026-11-01 晚起分机也对外（手机照连），
 *      只是不收节点 —— 这两个维度别混（模式卡在「协作中心」页，2026-11-02 搬过去）。
 *   ② 邀请码卡（2026-11-01 改版）：分节里直接摆 9 位数字（`xxx xxx xxx`）+ 倒计时 +
 *      「换一个」+ 旁边一张小二维码。**打开这一节就发一个新码**（旧码当场作废），
 *      所以不存在"页面上这个码到底还算不算数"的疑虑 —— 看见的就是能用的。
 *      改版前是弹窗里的长链接二维码：手机上要么扫码、要么把一条 70 字符的地址手打进去，
 *      后者根本不是人干的事。这才是"填地址"被推翻的真正原因。
 *   ③ 已配对设备**表**（2026-11-01 五改：卡片行改表格 —— 手机/状态/配对时间/最近活跃/
 *      面板角色/操作，列对齐比一坨点连的小字好读）：断开连接 / 取消配对（PRD P1-2）。
 *   ⓪ 页顶「连接」总开关卡（2026-11-02，用户："加个卡片，标签是连接，右边是开关"）：
 *      关 = 邀请码、已配对两节整个隐藏；服务端断开全部在用手机、拒绝扫码 / 连回来
 *      （POST /api/pair/enabled → pairEnabled 存 netmode.json，E1707）。
 *
 * 两个动作，语义完全不同（2026-11-01 用户定稿，都要 askConfirm —— 绝不 alert/confirm()）：
 *   · **断开连接**：吊销令牌 + 打「已断开」标记，**配对记录留着**。那台手机让出位置
 *     （可能换另一台手机连）；没有别的手机在用的时候，它自己打开班底就能连回来，不用扫码。
 *   · **取消配对**：删掉设备行，下次必须重新扫码 / 填邀请码 —— 不可逆，确认文案要说透。
 */
import { esc, toast } from './shell.mjs';
import { api, copyPlainText, dt, failHtml, post } from './ui.mjs';
import { askConfirm } from './machine.mjs';
import { $, S } from './core.mjs';
import { qrSvg } from './vendor/qrcode.mjs';

/** 倒计时刷新间隔（毫秒） */
const TICK_MS = 1000;

/* ---------------------------------------------------------------- 分节渲染 */

export async function renderPairing() {
  S.settingsSection = 'pairing';
  stopTicker();
  const view = $('settingsView');
  view.innerHTML = `${headRow()}<div class="detail-body"><section class="set-sec"><div class="set-box"><div class="empty">读取中…</div></div></section></div>`;

  let lan = null;
  try {
    lan = await api('/api/lan');
  } catch (e) {
    view.innerHTML = `${headRow()}<div class="empty">${failHtml(e)}</div>`;
    return;
  }

  if (!lan?.boundLan) {
    // 回环形态：手机连不进来，配对功能整个不可用 —— 指路「协作中心」当场切成对外服务
    // + 重启（模式卡 2026-11-02 搬去了那边，设计 §1.3 前置条件）
    view.innerHTML = `
      ${headRow()}
      <div class="detail-body">
        <section class="set-sec">
          <div class="set-head"><b>手机连接</b><span class="set-tag">未开局域网</span></div>
          <div class="set-box">
            <div class="set-note">
              这台机器现在<b>只监听本机</b>（回环形态），手机连不进来，所以没法配对。<br />
              去 <b>设置 → 协作中心</b>，在页顶「模式」卡上选<b>分机</b>或<b>总机</b>（都能让手机连），
              再点「重启」让监听生效，重启完成后回到这一页生成邀请码。<br />
              差别只有一个：<b>总机</b>还能收别的机器当节点，<b>分机</b>不收。
            </div>
          </div>
        </section>
      </div>`;
    return;
  }

  /*
   * 「连接」总开关（2026-11-02）：页顶一张卡，左标签右开关。
   * 关 = 这台电脑不接受手机连接：邀请码、已配对列表**两节整个隐藏**，
   * 服务端同时断开所有在用手机、拒绝扫码 / 连回来（E1707）。
   * 老服务没有这个字段时按开着算（向后兼容）。
   */
  const pairEnabled = lan?.pairEnabled !== false;

  if (!pairEnabled) {
    view.innerHTML = `
      ${headRow()}
      <div class="detail-body">
        ${pairSwitchCard(false)}
        <section class="set-sec">
          <div class="set-box"><div class="empty">手机连接已关闭 —— 打开上面的开关后，这里会显示邀请码和已配对的手机。</div></div>
        </section>
      </div>`;
    bindPairSwitch();
    return;
  }

  view.innerHTML = `
    ${headRow()}
    <div class="detail-body">
      ${pairSwitchCard(true)}
      <section class="set-sec">
        <div class="set-head"><b>邀请码</b></div>
        <div class="set-box">
          <div class="mb-invite">
            <div class="mb-invite-col">
              <div class="mb-invite-row">
                <div class="mb-invite-k">电脑地址</div>
                <div class="mb-invite-v">
                  <span class="mb-invite-addr" id="pairAddr" title="点一下复制">…</span>
                  <button class="btn-sm" type="button" id="pairAddrCopy">复制地址</button>
                </div>
              </div>
              <div class="mb-invite-row">
                <div class="mb-invite-k">邀请码<span class="mb-invite-left" id="pairLeft"></span></div>
                <div class="mb-invite-v">
                  <span class="mb-invite-code" id="pairCode" title="点一下复制"><span class="mb-invite-wait">生成中…</span></span>
                  <button class="mb-eye" type="button" id="pairEye" aria-pressed="false" title="遮住 / 露出邀请码"></button>
                  <button class="btn-sm" type="button" id="pairRefresh">换一个</button>
                </div>
              </div>
            </div>
            <div class="mb-invite-side">
              <div class="mb-qr" id="pairQr"></div>
              <div class="mb-invite-side-hint">手机扫码直接连</div>
            </div>
          </div>
          <div class="set-row">
            <p class="hint">邀请码 5 分钟内有效、<b>只能配一台手机</b>。</p>
          </div>
        </div>
      </section>
      <section class="set-sec">
        <div class="set-head"><b>已配对的手机</b><span class="set-tag" id="pairDevCount">…</span></div>
        <div id="pairDevices" class="mb-pair-list"><div class="empty">读取中…</div></div>
        <!-- 2026-11-02 两轮删文案：先从四行策略压成一句判别，后整段删（用户："去掉这个文案"）——
             断开/取消配对两个确认弹窗里各有全文，页面上不留说明 -->
      </section>
    </div>`;

  $('pairRefresh').onclick = () => {
    issueInvite().catch((e) => toast(e.message, 'error'));
  };
  // 码 / 地址本身都可点复制：发给同事 / 粘到手机上，比手抄可靠
  $('pairCode').onclick = async () => {
    const text = $('pairCode')?.dataset.code ?? '';
    if (!text) return;
    if ($('pairCode').classList.contains('expired')) return toast('这个码已过期 —— 点「换一个」', 'error');
    await copyPlainText(text);
    toast('已复制邀请码', 'ok');
  };
  $('pairAddr').onclick = async () => {
    const text = $('pairAddr')?.textContent ?? '';
    if (!text || text === '暂无可用地址') return;
    await copyPlainText(text);
    toast('已复制地址', 'ok');
  };
  /* 「复制地址」：手机手填那栏的来源。地址/码本身也可点复制（发给同事 / 粘到手机） */
  $('pairAddrCopy').onclick = async () => {
    const text = $('pairAddr')?.textContent ?? '';
    if (!text || text === '暂无可用地址') return;
    await copyPlainText(text);
    toast('已复制地址', 'ok');
  };
  /*
   * 小眼睛（2026-11-01 三改，照 ToDesk 的验证码那样）：把码遮成圆点。
   * 演示 / 截屏 / 旁边有人时用得上 —— 遮住只是视觉，复制、倒计时、二维码都照旧。
   */
  $('pairEye').onclick = () => {
    codeHidden = !codeHidden;
    paintEye();
    paintCodeValue();
  };
  paintEye();
  bindPairSwitch();

  issueInvite().catch((e) => {
    const el = $('pairCode');
    if (el) el.innerHTML = `<span class="mb-invite-wait">${esc(failHtml(e))}</span>`;
  });
  renderDeviceList().catch((e) => {
    const box = $('pairDevices');
    if (box) box.innerHTML = `<div class="empty">${failHtml(e)}</div>`;
  });
}

const headRow = () => '<div class="detail-head" style="padding:14px 20px 10px"><b style="font-size:var(--t-page)">手机连接</b></div>';

/**
 * 页顶「连接」卡（2026-11-02）：左标签 + 一句说明，右边总开关。
 * 开 = 手机可以连；关 = 服务端断开全部在用手机 + 拒绝扫码 / 连回来（E1707），
 * 前端随之把邀请码、已配对两节藏掉。切完**整节重画**（renderPairing）——
 * 邀请码的倒计时 / 码值都是状态，局部抠 DOM 容易留残尸。
 */
const pairSwitchCard = (on) => `
  <section class="set-sec">
    <div class="set-box pair-switch-box">
      <div class="pair-switch-txt">
        <b>连接</b>
        <p class="hint">${on ? '打开后，手机才能通过邀请码或扫码连接这台电脑。' : '已关闭 —— 手机连不上这台电脑，已连接的也已全部断开。'}</p>
      </div>
      <label class="switch" title="${on ? '关闭手机连接' : '打开手机连接'}"><input type="checkbox" id="pairSwitch" ${on ? 'checked' : ''} /><span></span></label>
    </div>
  </section>`;

/** 给当页那颗总开关接线（开 / 关两种页面都会画它） */
function bindPairSwitch() {
  const sw = $('pairSwitch');
  if (!sw) return;
  sw.onchange = async () => {
    const want = sw.checked;
    sw.disabled = true;
    try {
      await post('/api/pair/enabled', { enabled: want });
      toast(want ? '已打开 —— 手机可以连接了' : '已关闭 —— 手机连接已全部断开，邀请码停发', 'ok');
    } catch (e) {
      toast(e.message, 'error');
      sw.checked = !want; // 失败回滚，别让界面说谎
      sw.disabled = false;
      return;
    }
    await renderPairing();
  };
}

/* ---------------------------------------------------------------- 邀请码 */

/** 码当前是不是被小眼睛遮住了（跨重绘保留：换码 / 倒计时刷新都不该把它露出来） */
let codeHidden = false;

const EYE_OPEN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.6 12S6 5.8 12 5.8 21.4 12 21.4 12 18 18.2 12 18.2 2.6 12 2.6 12Z"/><circle cx="12" cy="12" r="2.7"/></svg>`;
/* 遮住态（2026-11-02 用户："这个图标换成闭上的眼睛"）：闭目 —— 下弯眼睑 + 三根睫毛，
   不用"斜杠划掉"那版（划掉语义是"禁止"，闭眼语义才是"看不见了"） */
const EYE_SHUT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.8 11.2c2.6 3.4 5.7 5 9.2 5s6.6-1.6 9.2-5"/><path d="M6.2 15.4l-1.5 2.3"/><path d="M12 16.4v2.8"/><path d="M17.8 15.4l1.5 2.3"/></svg>`;

/** 按当前遮/显状态画那串数字（三组三位的分组与手机端输入框一致） */
function paintCodeValue() {
  const el = $('pairCode');
  if (!el) return;
  const code = el.dataset.code ?? '';
  if (!code) return;
  el.classList.toggle('is-masked', codeHidden);
  el.innerHTML = codeHidden
    ? `<span class="mb-invite-code-row">••• ••• •••</span>`
    : `<span class="mb-invite-code-row">${esc(code.replace(/(\d{3})(?=\d)/g, '$1 '))}</span>`;
}

function paintEye() {
  const b = $('pairEye');
  if (!b) return;
  b.innerHTML = codeHidden ? EYE_SHUT : EYE_OPEN;
  b.setAttribute('aria-pressed', codeHidden ? 'true' : 'false');
  b.setAttribute('aria-label', codeHidden ? '显示邀请码' : '遮住邀请码');
  b.title = codeHidden ? '显示邀请码' : '遮住邀请码';
}

/**
 * 分节里的倒计时。换码 / 离开分节都要清掉 —— 否则 interval 会一直往已经拆掉的 DOM 上写，
 * 而且 `$('pairLeft')` 在新页面上可能是 null（构造函数里没有它），看着就是"倒计时不动了"。
 */
let ticker = null;
let tickingFor = ''; // 当前倒计时对应的那枚码（同一枚不重复开 interval）

function stopTicker() {
  if (ticker) clearInterval(ticker);
  ticker = null;
  tickingFor = '';
}

/** 发一个新码并画上去（**服务端同时作废旧码**，这里不必自己维护作废逻辑） */
async function issueInvite() {
  const d = await post('/api/pair/tokens', {});
  paintInvite(d);
}

function paintInvite(issued) {
  const codeEl = $('pairCode');
  if (!codeEl) return; // 分节已经被换掉（用户切走了）
  const code = String(issued?.code ?? '');
  codeEl.dataset.code = code;
  /* 新码 = 全新的倒计时：上一枚的过期妆（灰化划线 / 主色换码钮）全部卸掉 */
  codeEl.classList.remove('expired');
  $('pairRefresh')?.classList.remove('primary');
  // 三组三位的视觉分组（`482 913 665`）：与手机上那个输入框的格式一致，抄的时候不会串行。
  // 画的时候要服从小眼睛的状态（遮着就画圆点）
  paintCodeValue();

  const base = (issued?.urls ?? [])[0];
  const qr = $('pairQr');
  if (qr) {
    qr.innerHTML = base
      ? qrSvg(`${base}/pair?code=${encodeURIComponent(code)}`)
      : '<div class="empty" style="font-size:12px">没找到局域网地址</div>';
  }

  /*
   * 地址（2026-11-01 ToDesk 式改版）：卡片左格就是「电脑地址」，大字明写 ——
   * 手机要「地址 + 邀请码」两栏都填，这里抄下来就能用，不是装饰。
   *
   * 标签按地址形态分流（分节头的 set-tag）：域名（公网部署 / 反代）说"公网可访问"，
   * 局域网 IP 说"同一局域网"。这只是**文案**，不参与任何逻辑 ——
   * 手机侧两条路完全一样，没有部署形态分支。
   */
  const addrEl = $('pairAddr');
  if (addrEl) addrEl.textContent = base ? base.replace(/^https?:\/\//, '') : '暂无可用地址';
  $('pairCode').dataset.link = base ? `${base}/pair?code=${encodeURIComponent(code)}` : '';
  /* 分节头那个「同一局域网 / 公网可访问」小标签（2026-11-02 用户："这个标签去掉"）已删 ——
     地址是不是局域网 IP 一眼能看出来，标签是重复信息 */

  startCountdown(issued?.expiresAt, code);
}

/**
 * 倒计时。**过期不自动续**：这一节开着的时候悄悄换码，会让"我已经抄下来/正在输"的那个码
 * 半路失效，人根本反应不过来。过期就明说，让人点「换一个」。
 * 时间按服务端给的 expiresAt 算（别本地 +5 分钟 —— 两边时钟可能对不上）。
 */
function startCountdown(expiresAt, code) {
  const until = Date.parse(expiresAt ?? '');
  if (!Number.isFinite(until)) return;
  if (tickingFor === code) return;
  stopTicker();
  tickingFor = code;

  const tick = () => {
    const el = $('pairLeft');
    if (!el) return stopTicker(); // 分节被换掉
    const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    if (left <= 0) {
      el.textContent = '已过期';
      el.classList.add('expired');
      /* 过期态（2026-11-02 评审）：码灰化划线（别再像能抄的样子）+「换一个」升主色 ——
         过期后页面上唯一活的动作就是换码，把视线交给它 */
      $('pairCode')?.classList.add('expired');
      $('pairRefresh')?.classList.add('primary');
      stopTicker();
      return;
    }
    el.classList.remove('expired');
    /* 最后 60 秒转红（2026-11-02 评审）：紧迫感长在数字颜色上，不用读秒 */
    el.classList.toggle('soon', left <= 60);
    el.textContent = `剩 ${Math.floor(left / 60)} 分 ${String(left % 60).padStart(2, '0')} 秒`;
  };
  tick();
  ticker = setInterval(tick, TICK_MS);
}

/* ---------------------------------------------------------------- 设备列表 */

/** 已配对设备：名字 / 配对时间 / 最近活跃 / 面板角色 + 踢出。踢出前 askConfirm（不可逆动作） */
export async function renderDeviceList() {
  const box = $('pairDevices');
  if (!box) return;
  /*
   * 角色清单（2026-10-28 第四刀）：给每行的「面板角色」下拉用。
   * 读不到（非操作员 / 老服务）就只画设备行 —— 别让一个附加控件把整段弄挂。
   */
  const [devicesRes, rolesRes] = await Promise.all([
    api('/api/pair/devices'),
    api('/api/roles').catch(() => ({ roles: [] })),
  ]);
  const { devices = [] } = devicesRes;
  const roles = rolesRes?.roles ?? [];
  /*
   * 「在用 / 已断开」判据（2026-11-01 二刀）：`disconnectedAt` 有值 = 已断开。
   * 与「取消配对」（删行）区分：断开的行留着，那台手机还能凭 clientKey 连回来。
   * 老库/老服务没有这一列时退回看 `tokenCount`（0 = 被踢过，当作已断开处理）。
   */
  const isOff = (d) => !!d.disconnectedAt || (d.tokenCount ?? 0) <= 0;
  const active = devices.filter((d) => !isOff(d));
  const off = devices.length - active.length;
  const count = $('pairDevCount');
  if (count) {
    count.textContent = active.length
      ? `${active.length} 台在用${off ? ` · ${off} 台已断开` : ''}`
      : off
        ? `${off} 台已断开`
        : '还没有';
  }
  if (!devices.length) {
    box.innerHTML = '<div class="empty">还没有手机连接过 —— 把上面的邀请码填到手机里就行</div>';
    return;
  }
  box.innerHTML = `
    <div class="mb-pair-wrap">
      <table class="plg-table pair-table">
        <thead><tr><th>手机</th><th>状态</th><th>配对时间</th><th>最近活跃</th><th>面板角色</th><th></th></tr></thead>
        <tbody>
          ${devices
            .map((d) => {
              const isDisconnected = isOff(d);
              return `
              <tr data-dev="${esc(d.id)}"${isDisconnected ? ' class="off"' : ''}>
                <td><b>${esc(d.name)}</b></td>
                <td>${
                  isDisconnected
                    ? '<span class="mb-pair-offtag">已断开</span>'
                    : '<span class="pair-ontag">在用</span>'
                }</td>
                <td class="dim">${esc(dt(d.pairedAt))}</td>
                <td class="dim">${esc(dt(d.lastSeenAt))}${d.lastIp ? ` · ${esc(d.lastIp)}` : ''}</td>
                <td>${
                  /* 面板角色：这台手机下一次打开班底就按它画底部导航；未分配 = 默认「手机」 */
                  roles.length
                    ? `<select class="mb-pair-role" data-dev-role="${esc(d.id)}"${isDisconnected ? ' disabled' : ''}>
                         <option value=""${d.roleId ? '' : ' selected'}>默认（手机）</option>
                         ${roles
                           .map(
                             (r) =>
                               `<option value="${esc(r.id)}"${d.roleId === r.id ? ' selected' : ''}>${esc(r.name)}${
                                 r.builtin ? '' : '（自建）'
                               }</option>`,
                           )
                           .join('')}
                       </select>`
                    : '<span class="dim">默认（手机）</span>'
                }</td>
                <td class="pair-act">${
                  isDisconnected
                    ? `<button type="button" class="mb-pair-forget" data-forget="${esc(d.id)}" data-name="${esc(d.name)}">取消配对</button>`
                    : `<button type="button" class="mb-pair-kick" data-kick="${esc(d.id)}" data-name="${esc(d.name)}">断开连接</button>`
                }</td>
              </tr>`;
            })
            .join('')}
        </tbody>
      </table>
    </div>`;
  box.querySelectorAll('[data-dev-role]').forEach((sel) => {
    sel.onchange = async () => {
      sel.disabled = true;
      try {
        await post(`/api/pair/devices/${encodeURIComponent(sel.dataset.devRole)}/role`, { roleId: sel.value || null });
        /*
         * 成功就把本地这份也更新掉：失败回滚用的是 `d.roleId`，不更新的话
         * "改 A 成功 → 再改 B 失败"会回滚到最初那个角色，而不是刚存的 A。
         */
        const d = devices.find((x) => x.id === sel.dataset.devRole);
        if (d) d.roleId = sel.value || null;
        toast(sel.value ? '已分配 —— 那台手机下一次打开班底就按新角色显示' : '已改回默认 —— 那台手机下一次打开班底就是四个 tab', 'ok');
      } catch (e) {
        toast(e.message, 'error');
        const d = devices.find((x) => x.id === sel.dataset.devRole);
        sel.value = d?.roleId ?? ''; // 回滚到改动前的选择
      } finally {
        sel.disabled = false;
      }
    };
  });
  box.querySelectorAll('[data-kick]').forEach((b) => {
    b.onclick = async () => {
      const ok = await askConfirm({
        title: `断开「${b.dataset.name}」的连接？`,
        body: '这台手机会立刻掉线（下一次操作要求重新连），但配对记录留着 —— 电脑上没有别的手机在用的时候，它自己打开班底就能连回来，不用重新扫码。要彻底清掉记录请用「取消配对」。',
        ok: '断开连接',
      });
      if (!ok) return;
      try {
        await post(`/api/pair/devices/${encodeURIComponent(b.dataset.kick)}/disconnect`, {});
        toast('已断开连接 —— 那台手机下次打开会自己连回来（除非另有手机在用）', 'ok');
        await renderDeviceList();
      } catch (e) {
        toast(e.message, 'error');
      }
    };
  });
  /*
   * 取消配对（2026-11-01）：只出现在已断开的行上。蓝牙式 —— 点了直接删，不弹确认：
   * 删掉的是记录本身，之后那台手机必须重新扫码 / 填邀请码才能回来（这是与「断开连接」
   * 的全部区别），所以这里给一次确认，别让人一点就再也连不上。
   */
  box.querySelectorAll('[data-forget]').forEach((b) => {
    b.onclick = async () => {
      const ok = await askConfirm({
        title: `取消与「${b.dataset.name}」的配对？`,
        body: '这台手机的配对记录会被删掉 —— 它下一次要用，必须重新扫上面的二维码（或填邀请码）。只想让它暂时不连，用「断开连接」就够了。',
        ok: '取消配对',
      });
      if (!ok) return;
      b.disabled = true;
      try {
        await post(`/api/pair/devices/${encodeURIComponent(b.dataset.forget)}/forget`, {});
        toast(`已取消配对：${b.dataset.name} —— 下次要重新扫码`, 'ok');
        await renderDeviceList();
      } catch (e) {
        toast(e.message, 'error');
        b.disabled = false;
      }
    };
  });
}
