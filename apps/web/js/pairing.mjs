/* pairing.mjs —— 设置页「手机配对」分节（2026-11 手机端增量）。
 *
 * 三块：
 *   ① 配对入口：先查 /api/lan —— boundLan=false 时手机根本连不进来（回环形态），
 *      给"切总机模式并重启"的引导，不出二维码（设计 §1.3 前置条件）；
 *   ② 二维码弹窗：POST /api/pair/tokens → qrSvg 画码（内容 = urls[0] + /pair?token=…），
 *      带倒计时与「重新生成」；多网卡候选地址全列出来可点复制（首选画码，其余兜底）；
 *   ③ 已配对设备列表：设备名 / 配对时间 / 最近活跃 + 踢出（确认后 revoke，PRD P1-2）。
 *
 * 「踢出」必须二次确认：踢了之后那台手机的下一笔请求就是 401，不可逆 —— 用全站公共的
 * askConfirm（绝不 alert/confirm()，前端骨架既有规矩）。
 */
import { esc, toast } from './shell.mjs';
import { api, copyPlainText, dt, failHtml, post, wireDialogHead } from './ui.mjs';
import { askConfirm } from './machine.mjs';
import { $, S } from './core.mjs';
import { qrSvg } from './vendor/qrcode.mjs';

/** 倒计时/取设备的节流间隔（毫秒） */
const TICK_MS = 1000;

/* ---------------------------------------------------------------- 分节渲染 */

export async function renderPairing() {
  S.settingsSection = 'pairing';
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
    // 回环形态：手机连不进来，配对功能整个不可用 —— 引导去模式页切换（设计 §1.3）
    view.innerHTML = `
      ${headRow()}
      <div class="detail-body">
        <section class="set-sec">
          <div class="set-head"><b>手机配对</b><span class="set-tag">未开局域网</span></div>
          <div class="set-box">
            <div class="set-note">
              这台机器现在<b>只监听本机</b>（回环形态），手机连不进来，所以没法配对。<br />
              先到「设置 → 这台机器」把模式切到<b>总机</b>并点「重启生效」，再回到这里生成二维码。
            </div>
          </div>
        </section>
      </div>`;
    return;
  }

  view.innerHTML = `
    ${headRow()}
    <div class="detail-body">
      <section class="set-sec">
        <div class="set-head"><b>扫码配对</b><span class="set-tag">同一局域网</span></div>
        <div class="set-box">
          <div class="set-row">
            <span class="set-label">二维码</span>
            <button class="primary" id="pairGen">生成配对二维码</button>
          </div>
          <div class="set-row">
            <p class="hint">手机连同一个 Wi-Fi，用相机或浏览器扫码 —— 打开落地页后自动完成配对并进入工作台。
            配对码 5 分钟内有效、只能用一次。</p>
          </div>
        </div>
      </section>
      <section class="set-sec">
        <div class="set-head"><b>已配对的手机</b><span class="set-tag" id="pairDevCount">…</span></div>
        <div class="set-box"><div id="pairDevices" class="members"><div class="empty">读取中…</div></div></div>
      </section>
    </div>`;

  $('pairGen').onclick = () => openQrDialog().catch((e) => toast(e.message, 'error'));
  renderDeviceList().catch((e) => {
    const box = $('pairDevices');
    if (box) box.innerHTML = `<div class="empty">${failHtml(e)}</div>`;
  });
}

const headRow = () => '<div class="detail-head" style="padding:14px 20px 10px"><b style="font-size:var(--t-page)">手机配对</b></div>';

/* ---------------------------------------------------------------- 二维码弹窗 */

/**
 * 弹二维码：先签发一次性码，再把 `urls[0] + /pair?token=…` 画出来。
 * 倒计时按服务端给的 expiresAt 算（别本地自己加 5 分钟 —— 两边时钟可能对不上）。
 * 弹窗是现建的 <dialog>（走全站 dialog 体系 + wireDialogHead），关掉时清掉定时器。
 */
async function openQrDialog() {
  const d = await post('/api/pair/tokens', {});
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `
    <form method="dialog">
      <b>用手机扫码配对</b>
      <div class="mb-qr-wrap">
        <div class="mb-qr" id="pairQr"></div>
        <div class="dim" style="font-size:12px;margin-top:10px">
          有效期至 ${esc(dt(d.expiresAt))} · <b id="pairLeft" style="color:var(--accent)">…</b>
        </div>
        <div class="dim" style="font-size:12px;margin-top:6px">扫不上？下面是候选地址，点一下复制，粘到手机浏览器打开：</div>
        <div class="mb-urls" id="pairUrls"></div>
      </div>
      <div class="dlg-actions">
        <button type="button" value="cancel">关闭</button>
        <button type="button" class="primary" id="pairRefresh">重新生成</button>
      </div>
    </form>`;
  document.body.append(dlg);
  wireDialogHead(dlg.querySelector('form'));

  const paint = (issued) => {
    const base = (issued.urls ?? [])[0];
    if (!base) {
      $('pairQr').innerHTML = '<div class="empty">没找到局域网地址 —— 检查网卡后重试</div>';
      return;
    }
    $('pairQr').innerHTML = qrSvg(`${base}/pair?token=${encodeURIComponent(issued.token)}`);
    // 候选地址：首选之外的全列出来（多网卡选错 IP 是扫码最常见翻车点，设计 §7-4）
    $('pairUrls').innerHTML = (issued.urls ?? [])
      .map((u, i) => `<button type="button" class="mb-url${i === 0 ? ' primary' : ''}" data-url="${esc(u)}">${esc(u)}${i === 0 ? '（首选）' : ''}</button>`)
      .join('');
    $('pairUrls').querySelectorAll('[data-url]').forEach((b) => {
      b.onclick = async () => {
        await copyPlainText(`${b.dataset.url}/pair?token=${encodeURIComponent(issued.token)}`);
        toast('已复制完整配对地址', 'ok');
      };
    });
  };
  paint(d);

  // 倒计时：到 0 提示过期（码还在库里，但 claim 会回 E1702）；「重新生成」就地换新码
  const until = Date.parse(d.expiresAt);
  const timer = setInterval(() => {
    const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    const el = $('pairLeft');
    if (!el) { clearInterval(timer); return; } // 弹窗关了
    el.textContent = left > 0 ? `剩 ${Math.floor(left / 60)} 分 ${left % 60} 秒` : '已过期，请重新生成';
  }, TICK_MS);
  dlg.addEventListener('close', () => clearInterval(timer), { once: true });

  $('pairRefresh').onclick = async () => {
    try {
      paint(await post('/api/pair/tokens', {}));
      toast('已生成新码（旧码作废）', 'ok');
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  dlg.showModal();
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
   * 踢出只删令牌、设备行留着当记录（store/devices.mjs）。所以这里必须看 `tokenCount`：
   * 0 = 已经踢掉或令牌过期 —— 显示成「已踢出」并撤掉按钮，否则用户踢完看到它原样
   * 还在列表里，会以为没生效（2026-10-28 修）。
   */
  const active = devices.filter((d) => (d.tokenCount ?? 0) > 0);
  const count = $('pairDevCount');
  if (count) count.textContent = active.length ? `${active.length} 台在用` : '还没有';
  if (!devices.length) {
    box.innerHTML = '<div class="empty">还没有手机配对过 —— 点上面「生成配对二维码」开始</div>';
    return;
  }
  box.innerHTML = devices
    .map((d) => {
      const off = (d.tokenCount ?? 0) <= 0;
      return `
      <div class="mb-pair-dev${off ? ' off' : ''}" data-dev="${esc(d.id)}">
        <div class="mb-pair-dev-main">
          <b>${esc(d.name)}</b>
          <div class="dim" style="font-size:12px">配对于 ${esc(dt(d.pairedAt))} · 最近活跃 ${esc(dt(d.lastSeenAt))}${d.lastIp ? ` · ${esc(d.lastIp)}` : ''}</div>
          ${
            /* 面板角色：这台手机下一次打开班底就按它画底部导航；未分配 = 默认「手机」 */
            roles.length
              ? `<select class="mb-pair-role" data-dev-role="${esc(d.id)}"${off ? ' disabled' : ''}>
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
              : ''
          }
        </div>
        ${off ? '<span class="mb-pair-off">已踢出</span>' : `<button type="button" class="mb-pair-kick" data-kick="${esc(d.id)}" data-name="${esc(d.name)}">踢出</button>`}
      </div>`;
    })
    .join('');
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
        title: `踢出「${b.dataset.name}」？`,
        body: '它保存的配对令牌会立刻作废，那台手机下一次操作就会被要求重新扫码配对。',
        ok: '踢出',
      });
      if (!ok) return;
      try {
        await post(`/api/pair/devices/${encodeURIComponent(b.dataset.kick)}/revoke`, {});
        toast('已踢出', 'ok');
        await renderDeviceList();
      } catch (e) {
        toast(e.message, 'error');
      }
    };
  });
}
