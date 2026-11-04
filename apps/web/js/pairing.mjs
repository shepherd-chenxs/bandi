/* pairing.mjs —— 设置页「手机连接」分节（2026-11 手机端增量）。
 *
 * 三块：
 *   ① 配对入口：先查 /api/lan —— boundLan=false 时手机连不进来（监听被启动参数
 *      BANDI_HOST=127.0.0.1 钉在回环上的调试形态，2026-11-03 起默认就是对外监听），
 *      给"改部署配置重起"的引导，不出邀请码（设计 §1.3 前置条件）。
 *   ② 连接卡（2026-11-01 改版）：分节里直接摆 9 位数字（`xxx xxx xxx`）+ 倒计时 +
 *      「换一个」+ 旁边一张小二维码。**打开这一节就发一个新码**（旧码当场作废），
 *      所以不存在"页面上这个码到底还算不算数"的疑虑 —— 看见的就是能用的。
 *      改版前是弹窗里的长链接二维码：手机上要么扫码、要么把一条 70 字符的地址手打进去，
 *      后者根本不是人干的事。这才是"填地址"被推翻的真正原因。
 *   ③ 已配对设备**表**（2026-11-01 五改：卡片行改表格 —— 手机/状态/配对时间/最近活跃/
 *      面板角色/操作，列对齐比一坨点连的小字好读）：断开连接 / 取消配对（PRD P1-2）。
 *   ⓪ 分节头的「连接」总开关（2026-11-02 加，2026-11-03 收进标题行）：
 *      关 = 邀请码卡整个换成一句提示、服务端断开全部在用手机、拒绝扫码 / 连回来
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
    // 监听被启动参数钉在回环上（调试形态）：手机连不进来，配对功能整个不可用 ——
    // 指路部署配置（2026-11-03 起没有"切对外 + 重启"这个界面动作了）
    view.innerHTML = `
      ${headRow()}
      <div class="detail-body">
        <section class="set-sec">
          <div class="set-head"><b>手机连接</b><span class="set-tag">只听本机</span></div>
          <div class="set-box">
            <div class="set-note">
              这台机器的监听地址被启动参数（<code>BANDI_HOST=127.0.0.1</code>）钉在了本机，
              手机连不进来，所以没法配对。<br />
              改部署配置里的 <code>BANDI_HOST</code>（缺省就是对外）重新起，再回到这一页生成邀请码。
            </div>
          </div>
        </section>
      </div>`;
    return;
  }

  /*
   * 「连接」总开关（2026-11-02 加，2026-11-03 收进分节头）：
   * 用户："邀请码改成连接，右边加开关，上面的可以去掉了" —— 页顶那张独立开关卡删掉，
   * 开关贴到分节标题右边，标题从「邀请码」改成「连接」。
   * 关 = 这台电脑不接受手机连接：卡片体（电脑地址 / 邀请码 / 二维码）换成一句提示，
   * 服务端同时断开所有在用手机、拒绝扫码 / 连回来（E1707）。
   * 已配对的手机整个分节也不画（2026-11-03 用户：关闭连接的时候不要显示已配对手机）——
   * 关闭态下设备管理没有意义，要取消配对先打开连接。
   * 老服务没有这个字段时按开着算（向后兼容）。
   */
  const pairEnabled = lan?.pairEnabled !== false;
  pairOn = pairEnabled;

  view.innerHTML = `
    ${headRow()}
    <div class="detail-body">
      <section class="set-sec pair-sec">
        <div class="set-head pair-head">
          <b>连接</b>
          <span class="set-tag pair-state${pairEnabled ? ' on' : ''}">${pairEnabled ? '已开启' : '已关闭'}</span>
          ${pairSwitch(pairEnabled)}
        </div>
        <div class="set-box">
          ${pairEnabled ? inviteCard() : pairOffCard()}
        </div>
      </section>
      ${
        /* 已配对的手机只在开着的时候画（2026-11-03 用户：关闭连接的时候不要显示已配对手机）——
           关闭态手机本来就连不上，管理设备没有意义；要取消配对先打开连接。
           （2026-11-04 试过"0 台整节不显示"，用户当天回退 —— 空状态卡留着） */
        pairEnabled
          ? `
      <section class="set-sec">
        <div class="set-head"><b>已配对的手机</b><span class="set-tag" id="pairDevCount">…</span></div>
        <div id="pairDevices" class="mb-pair-list"><div class="empty">读取中…</div></div>
        <!-- 2026-11-02 两轮删文案：先从四行策略压成一句判别，后整段删（用户："去掉这个文案"）——
             断开/取消配对两个确认弹窗里各有全文，页面上不留说明 -->
      </section>`
          : ''
      }
    </div>`;

  bindPairSwitch();

  if (pairEnabled) {
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

    issueInvite().catch((e) => {
      const el = $('pairCode');
      if (el) el.innerHTML = `<span class="mb-invite-wait">${esc(failHtml(e))}</span>`;
    });
  }
  renderDeviceList().catch((e) => {
    const box = $('pairDevices');
    if (box) box.innerHTML = `<div class="empty">${failHtml(e)}</div>`;
  });
}

const headRow = () =>
  `<div class="detail-head" style="padding:14px 20px 10px"><b style="font-size:var(--t-page)">手机连接</b></div>`;

/** 分节总开关的当前状态（空列表 / 卡片体文案据此换一句） */
let pairOn = true;

/** 关闭态图标（描线手机，随 .pair-off-ico 的 accent 淡底变色） */
const PHONE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="2" width="10" height="20" rx="2.5"/><path d="M11 18.5h2"/></svg>`;

/**
 * 关闭态引导卡（2026-11-03 评审改版）：原来是 60px 高的一行灰字套个空框 ——
 * 边框让它看着像"加载失败的容器"，而且页面上没有任何活的动作。
 * 图标 + 标题 + 一句后果说明；开关就在分节头右上角，不另设按钮
 * （2026-11-03 用户："去掉这个按钮"）。
 */
const pairOffCard = () => `
  <div class="pair-off">
    <div class="pair-off-ico">${PHONE_SVG}</div>
    <b>手机连接已关闭</b>
    <p>打开后，这里会显示电脑地址、邀请码和二维码，手机扫码即可连接。</p>
  </div>`;

/**
 * 「连接」分节头右边那颗总开关（2026-11-03 从页顶卡搬进来）。
 * 开 = 手机可以连；关 = 服务端断开全部在用手机 + 拒绝扫码 / 连回来（E1707），
 * 前端随之把卡片体换成一句提示。切完**整节重画**（renderPairing）——
 * 邀请码的倒计时 / 码值都是状态，局部抠 DOM 容易留残尸。
 */
const pairSwitch = (on) => `
  <label class="switch" title="${on ? '关闭手机连接' : '打开手机连接'}"><input type="checkbox" id="pairSwitch" ${
    on ? 'checked' : ''
  } /><span></span></label>`;

/** 手机能连时的那张卡：电脑地址 + 邀请码（倒计时 / 小眼睛 / 换一个）+ 二维码
 *  2026-11-04 重设计（用户："邀请码和地址太大了"）：21px 地址 / 30px 大码收成
 *  「标签 | 值 | 动作」的紧凑单行 —— 值还是等宽字体、可点复制，动作靠右；
 *  倒计时从标签里挪到码后面（紧迫感贴着数字看），标签列定宽对齐。 */
const inviteCard = () => `
  <div class="mb-invite">
    <div class="mb-invite-col">
      <div class="mb-invite-row">
        <span class="mb-invite-k">电脑地址</span>
        <span class="mb-invite-addr" id="pairAddr" title="点一下复制">…</span>
        <button class="btn-sm" type="button" id="pairAddrCopy">复制地址</button>
      </div>
      <div class="mb-invite-row">
        <span class="mb-invite-k">邀请码</span>
        <span class="mb-invite-code" id="pairCode" title="点一下复制"><span class="mb-invite-wait">生成中…</span></span>
        <span class="mb-invite-left" id="pairLeft"></span>
        <button class="mb-eye" type="button" id="pairEye" aria-pressed="false" title="遮住 / 露出邀请码"></button>
        <button class="btn-sm" type="button" id="pairRefresh">换一个</button>
      </div>
    </div>
    <div class="mb-invite-side">
      <div class="mb-qr" id="pairQr"></div>
      <div class="mb-invite-side-hint">手机扫码直接连</div>
    </div>
  </div>`;

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
        : '0 台'; /* 「还没有」（2026-11-03 评审）：描边小标签是筛选器的视觉语言，表数量用「0 台」直给 */
  }
  if (!devices.length) {
    /* 关闭态只说事实（2026-11-03 评审）：上面引导卡已经有「打开手机连接」的动作和说明，
       这里再来一句"打开上面的开关……"就是同一件事说两遍。开着态的提示保留 —— 那时它是唯一指引。 */
    box.innerHTML = pairOn
      ? '<div class="empty">还没有手机连接过 —— 把上面的邀请码填到手机里就行</div>'
      : '<div class="empty">暂无配对设备</div>';
    return;
  }
  box.innerHTML = `
    <div class="mb-pair-wrap">
      <table class="plg-table pair-table">
        <thead><tr><th>手机</th><th>使用者</th><th>状态</th><th>配对时间</th><th>最近活跃</th><th>面板角色</th><th>操作</th></tr></thead>
        <tbody>
          ${devices
            .map((d) => {
              const isDisconnected = isOff(d);
              return `
              <tr data-dev="${esc(d.id)}"${isDisconnected ? ' class="off"' : ''}>
                <td><b>${esc(d.name)}</b></td>
                ${
                  /* 使用者（2026-11-03 设备绑人）：这部手机的操作算谁的。
                     绑人之前这里根本没有"人"，手机批的卡票在记录里只有一台设备 ——
                     一眼看不出"这是谁批的"。未绑定 = 零账号形态的老设备（或发码时还没有账号）。 */
                  `<td>${d.ownerName ? esc(d.ownerName) : '<span class="dim">未绑定</span>'}</td>`
                }
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
