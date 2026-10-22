/* machine.mjs —— 这台机器。
 * 2026-10-22 由 app.js（15537 行单文件）拆出，原生 ESM、无打包器；逻辑逐字搬运。 */
import { esc, toast } from './shell.mjs';
import { api, cliAvatar, dt, failHtml, initial, post, showFail, wireDialogHead } from './ui.mjs';
import { load } from './state.mjs';
import { breadcrumb, headRow, renderRuntimes, rtLoading } from './connectors.mjs';
import { $, LOCAL_BASE, S } from './core.mjs';



/* --------------------------------------------------------------- 这台机器 */

/**
 * 字节数 → 人话。只在展示层用；**大小一律以服务端 `GET /api/local/status` 报的为准**，
 * 前端不自己 stat（避免"看着 42MB、导出 38MB"这种两套数字）。
 */
export const fmtMb = (bytes) => {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  const mb = n / 1048576;
  // 太小就别写 "0.0 MB" 了 —— 看着像坏了；刚建的库就一两页
  if (mb < 0.1) return '< 0.1 MB';
  return `${mb >= 100 ? String(Math.round(mb)) : mb.toFixed(1)} MB`;
};



/* 「数据管理」分节（2026-10-21 独立成菜单「数据备份」，2026-10-22 改名「数据管理」并补导入）——
   导出 = VACUUM INTO 出一份完整快照，导出时不用停班底。
   导入 = 选一份班底导出的 .db 快照覆盖本机数据：服务端先校验（头 / 完整性 / 班底的表），
   写成待用文件，**重启班底才换库**（换的时候现库自动备份进 backups/导入前-*.db）。
   恢复从此有两条路：直接导入快照，或照老办法手动覆盖 bandi.db。 */
export async function renderBackup() {
  $('settingsView').innerHTML = rtLoading('数据管理');
  /* 状态和备份列表并行拉；谁挂了都不拦渲染 —— 状态挂了路径显示 —，列表挂了显示空态，
     点导出/导入都会拿到真实报错。 */
  const [rStatus, rBackups] = await Promise.allSettled([
    api(`${LOCAL_BASE}/status`),
    api(`${LOCAL_BASE}/backups`),
  ]);
  const st = rStatus.status === 'fulfilled' ? rStatus.value : null;
  const bl = rBackups.status === 'fulfilled' ? rBackups.value : null;
  const local = st?.local ?? {};
  const counts = local.counts ?? {};
  const size = fmtMb(local.dbSize);
  const mtime = local.dbMtime ? dt(local.dbMtime) : '';
  /* 2026-10-22 重设计：原来是「标签左、内容右挤」的表单卡 + 两颗小按钮吊在右下，
     说明挤成一坨还分家（「怎么用」同时讲导出和导入）。改成——
     ① 数据总览条：数字大字排一行当主视觉，路径放卡头当副信息；
     ② 导出/导入两张动作卡：各管各的图标、一句话职责、说明与按钮。
     说明跟着动作走（谁的事写在谁的卡里），“重启生效”只跟导入有关，也归位了。 */
  const icoExport =
    '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>';
  const icoImport =
    '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V4"/><path d="m7 9 5-5 5 5"/><path d="M5 20h14"/></svg>';
  /* 右栏：backups/ 里的快照（定时备份 + 导入前自动备份）。来源标注跟命名规则一一对应。 */
  const SRC_LABEL = { scheduled: '定时备份', import: '导入前备份', other: '备份' };
  const bkFiles = Array.isArray(bl?.files) ? bl.files : [];
  const bkList = bkFiles.length
    ? bkFiles.map((f) => `
        <div class="dm-item" title="${esc(`${bl.dir ?? ''}\\${f.name}`)}">
          <div class="machine-path dm-item-name">${esc(f.name)}</div>
          <div class="dm-item-sub">${SRC_LABEL[f.src] ?? SRC_LABEL.other} · ${fmtMb(f.size) || '—'} · ${dt(f.mtime)}</div>
        </div>`).join('')
    : `<div class="dm-empty">还没有备份。导入快照换库、或开了定时备份之后，会自动存进数据目录的 backups/ 里。</div>`;
  $('settingsView').innerHTML = `
    ${headRow('<b>数据管理</b>')}
    <div class="detail-body">
      <div class="dm-cols">
        <div class="dm-left">
          <section class="dm-overview">
          <div class="dm-overview-head">
            <span class="dm-title">本机数据</span>
            <span class="machine-path" title="${esc(local.dbPath ?? '')}">${esc(local.dbPath ?? '—')}</span>
          </div>
          <div class="dm-stats">
            <div class="dm-stat"><b>${size ? esc(size) : '—'}</b><span>库大小</span></div>
            <div class="dm-stat"><b>${Number(counts.personas ?? 0)}</b><span>员工</span></div>
            <div class="dm-stat"><b>${Number(counts.conversations ?? 0)}</b><span>会话</span></div>
            <div class="dm-stat"><b>${Number(counts.projects ?? 0)}</b><span>项目</span></div>
            <div class="dm-stat"><b class="dm-stat-time">${mtime ? esc(mtime) : '—'}</b><span>最后修改</span></div>
          </div>
        </section>
        <div class="dm-cards">
          <div class="dm-card">
            <div class="dm-card-head">
              <span class="dm-ico">${icoExport}</span>
              <div class="dm-card-name"><b>导出快照</b><span>把整份库存成一个 .db 文件</span></div>
              <button class="btn-sm primary" id="backupExport">导出</button>
            </div>
            <div class="dm-card-desc">生成这份库的完整快照（一个 .db 文件），导出时班底照常用，不需要停机。成功后会把文件完整路径告诉你。</div>
          </div>
          <div class="dm-card">
            <div class="dm-card-head">
              <span class="dm-ico">${icoImport}</span>
              <div class="dm-card-name"><b>导入快照</b><span>用一份快照覆盖本机数据</span></div>
              <button class="btn-sm" id="backupImport">导入</button>
            </div>
            <div class="dm-card-desc">选一份班底导出的 .db 快照：会先校验文件，当前数据自动备份进数据目录的 backups/。<b>导入完成后重启班底才生效。</b></div>
          </div>
        </div>
        </div>
        <div class="dm-list">
          <div class="dm-list-head">
            <span class="dm-title">备份快照</span>
            <span class="dm-list-count" title="${esc(bl?.dir ?? '')}">${bkFiles.length ? `${bkFiles.length} 份` : ''}</span>
          </div>
          <div class="dm-list-body">${bkList}</div>
        </div>
      </div>
    </div>
    <input type="file" id="backupImportFile" accept=".db,.sqlite,.sqlite3" hidden />`;
  const btn = $('backupExport');
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      const r = await post(`${LOCAL_BASE}/export`, {});
      toast(`已导出：${r.file}`, 'ok'); // 完整路径 toast 出去，用户去那个目录拿
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  };

  /* 导入：选文件 → 确认（说清"覆盖本机数据 + 重启生效 + 自动备份"）→ 原始字节上传。
     服务端校验失败会回 E1099 的人话；成功也只是"待生效"，别把话说成"已完成"。 */
  const impBtn = $('backupImport');
  const fileInput = $('backupImportFile');
  impBtn.onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const f = fileInput.files?.[0];
    fileInput.value = ''; // 允许同一文件选第二次（onchange 只在变化时触发）
    if (!f) return;
    if (!/\.(db|sqlite|sqlite3)$/i.test(f.name)) {
      toast('请选择班底导出的 .db 快照文件', 'error');
      return;
    }
    const ok = await confirmDo(
      `导入会用「${f.name}」覆盖本机数据（${fmtMb(f.size) || '大小未知'}）。\n` +
        `服务端会先校验文件，并把当前数据自动备份到数据目录的 backups/ 里。\n` +
        `导入完成后需要重启班底才生效。`,
      { title: `导入「${f.name}」？` },
    );
    if (!ok) return;
    impBtn.disabled = true;
    try {
      const buf = await f.arrayBuffer();
      const r = await fetch(`${LOCAL_BASE}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buf,
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `导入失败（HTTP ${r.status}）`);
      toast('已导入，重启班底后生效', 'ok');
      await renderBackup(); // 重画一遍：状态行还是现库的数字，别让人误以为已经换了
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      impBtn.disabled = false;
    }
  };
}



/**
 * 「加入总机」面板（2026-10-20 设计 §9.4，2026-10-21 从弹窗改成**页面内嵌**）：
 * list（主机列表）→ explain（会改变什么 + 邀请码）→ joining → done。
 *
 * 2026-10-21 拍板：**节点只当算力，不做「看总机面板」** —— 原 scope 三选一步骤删除，
 * 加入一律拿 compute 令牌（服务端也写死，不信任前端）。
 *
 * 为什么不再用 dialog：用户实报"弹窗的方式操作有点不舒服"—— 主机列表是这页的主体内容，
 * 塞进 520px 的小弹窗里又要滚动又要等扫描，不如直接长在页面上（跟设置页其它分区同一种列表式）。
 * 与 `openJoinDialog` 语义不同：那个是**总机**发码给别人，这个是**本机**去加入别人。
 *
 * 状态机全部在这个局部对象里（重进设置页 = 整个重来，不往 S 里塞）。
 * 列表页：**不自动扫**（2026-10-21 用户：去掉自动探测，改手动）+ 「发现」按钮扫
 *        + 「添加」（填了就入列）+ 已存的先测试、通过才出「加入」。
 */
export function mountJoinPanel(root) {

  /* 状态机的全部状态都在这个局部对象里 —— 切走设置分区就整个忘掉，不往 S 里塞。
     2026-10-21：scan/pick/manual 三步合并成「主机列表」一页（用户拍板的列表模型）；
     探测改成**纯手动**（进页不扫，点「发现」才扫）+ 添加填了就入列。
     同日再改（用户："加入按钮一直显示，点击加入，打开弹窗"）：加入不再换页 ——
     原来那套 explain/joining/done 步骤机（wiz.step）整个撤掉，改成**一个弹窗**装下
     「会改变什么 + 邀请码 + 加入 + 结果」，列表页永远留在原地。 */
  const wiz = {
    hosts: [],            // 通讯录（/status 透传 + add/remove 的返回刷新）
    candidates: [],       // 本次扫描结果（不入列，刷新会重扫）
    tested: new Map(),    // url → {state:'testing'|'ok'|'fail', host?, code?, msg?}
    scanning: false,
    url: '',              // 上一次点「加入」的目标（弹窗默认值）
    code: '',             // 邀请码：弹窗关掉再开还留着上次填的
    err: '',
    status: null,         // 本机读数：本机员工/会话/项目数（status 透传）
    secs: 0,
    tick: null,
  };

  // 本机读数拉一次就够（弹窗里的本机数据 + 通讯录初值）；拉不到不挡路 —— 列表按空画，扫描照常
  api(`${LOCAL_BASE}/status`).then((st) => {
    wiz.status = st;
    wiz.hosts = Array.isArray(st?.hosts) ? st.hosts : [];
    render(); // 通讯录行补上（列表页是唯一的一页，直接重画）
  }).catch(() => {});

  // 离开这页（设置切到别的分区，root 被整个换掉）就停表 —— 定时器别挂在看不见的节点上空转
  const tickGuard = setInterval(() => {
    if (!root.isConnected) {
      clearInterval(wiz.tick);
      clearInterval(tickGuard);
    }
  }, 1000);

  const errLine = () => (wiz.err ? `<div class="joinwiz-err">${esc(wiz.err)}</div>` : '');

  /* ---------------------------------------------------- 步骤 1 · 主机列表 */
  /* 扫描不再切步骤：原地转圈，结果合并进列表。空结果不是错误 —— 通讯录和「添加」仍在。 */
  const runScan = () => {
    if (wiz.scanning) return;
    wiz.scanning = true;
    wiz.secs = 0;
    clearInterval(wiz.tick);
    // 「已经找了 N 秒」：本地计时（服务端最多 4 秒返回）
    wiz.tick = setInterval(() => {
      wiz.secs += 1;
      const el = root.querySelector('[data-sec]');
      if (el) el.textContent = `已经找了 ${wiz.secs} 秒 · 同一网络里的班底会自动应答`;
    }, 1000);
    render();
    post(`${LOCAL_BASE}/discover`, {})
      .then((r) => {
        clearInterval(wiz.tick);
        wiz.candidates = r?.candidates ?? [];
        wiz.scanning = false;
        render();
      })
      .catch((err) => {
        clearInterval(wiz.tick);
        wiz.scanning = false;
        toast(err.message, 'error'); // 扫描这条路废了也不挡路：通讯录与「添加」必须还能走通
        render();
      });
  };

  /* 通讯录在前（用户明确记住的），扫描结果在后；同一台总机（instanceId 或 url 撞上）
     合并成一行 —— 扫描带来的 joinable/caps 是刚出炉的，盖到通讯录行上刷新状态。 */
  const mergeRows = () => {
    const keyOf = (x) => (x.instanceId ? `i:${x.instanceId}` : `u:${x.url}`);
    const rows = [];
    const seen = new Set();
    for (const h of wiz.hosts) {
      const k = keyOf(h);
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push({ ...h, persisted: true });
    }
    for (const c of wiz.candidates) {
      const k = keyOf(c);
      const exist = rows.find((r) => keyOf(r) === k);
      if (exist) {
        exist.joinable = c.joinable;
        exist.caps = c.caps;
        continue;
      }
      seen.add(k);
      rows.push({ ...c, persisted: false });
    }
    return rows;
  };

  const drawList = (box) => {
    const rowsHtml = mergeRows()
      .map((h) => {
        const t = wiz.tested.get(h.url);
        const stale = Array.isArray(h.caps) && !h.caps.includes('scope');
        let tag = '';
        let sub = '';
        let action = '';
        if (t?.state === 'testing') {
          tag = '<em class="tag-ok">（测试中…）</em>';
        } else if (t?.state === 'ok') {
          // 测试通过 → 只把标签说清楚；「加入」本来就一直在，不用等测试
          tag = '<em class="tag-ok">（可加入）</em>';
          action = `<button type="button" class="mini auto dim" data-test="${esc(h.url)}">测试</button>`;
        } else if (t?.state === 'fail') {
          tag = `<em class="tag-warn">（${esc(t.code ?? 'E1092')}）</em>`;
          sub = `<div class="sub">${esc(t.msg ?? '')}</div>`;
          action = `<button type="button" class="mini auto" data-test="${esc(h.url)}">重试</button>`;
        } else if (!h.persisted) {
          // 扫描来的行：UDP 应答本身就是"活着"的证明，直接可选
          if (h.joinable) {
            tag = '<em class="tag-ok">（可加入）</em>';
          } else if (stale) {
            tag = '<em class="tag-warn">（版本太旧）</em>';
            sub = '<div class="sub">那台班底版本太旧，先升级它再加入</div>';
          } else {
            tag = '<em class="tag-warn">（未开放加入）</em>';
            sub = '<div class="sub">这台班底没有对外开放加入（可能只在本机使用）。去那台机器上打开『允许局域网内的机器加入』→ 点重启</div>';
          }
        } else {
          // 通讯录里还没测过的行（刚「添加」的也在这档）：可以点「测试」验连接，
          // 也可以直接点「加入」—— 行上没说"可加入"不代表点不得，弹窗会把真实原因说清楚
          tag = '<em class="tag-warn">（未测试）</em>';
          action = `<button type="button" class="mini auto" data-test="${esc(h.url)}">测试</button>`;
        }
        /* 「加入」**一直显示**（2026-10-21 用户："加入按钮一直显示，点击加入，打开弹窗"）——
           以前它只在"测试通过/可加入"时才冒出来，用户得先猜哪行能点。现在每行都有，
           能不能加由弹窗里的第一次请求回答（连不上/没开放/版本旧都会把原因写回弹窗） */
        const joinBtn = `<button type="button" class="mini auto primary" data-join="${esc(h.url)}" data-label="${esc(h.label ?? '')}">加入</button>`;
        /* 点行仍可加入，但只对"扫描到且开放加入"的行开放 —— 其余行点一下就是加入弹窗，
           容易误触；行上的「加入」按钮已经够显眼 */
        const clickable = !h.persisted && h.joinable;
        return `<div class="row-item joinwiz-cand ${clickable || t?.state === 'ok' ? '' : 'off'}" ${clickable ? `data-pick="${esc(h.url)}" data-label="${esc(h.label ?? '')}" style="cursor:pointer"` : ''}>
          <div class="avatar">${esc(initial(h.label))}</div>
          <div class="who">
            <b>${esc(h.label)}${tag}</b>
            <div class="sub">${esc(h.hostname ?? '')}${h.hostname ? ' · ' : ''}${esc(h.url)}</div>
            ${sub}
          </div>
          <div class="row-acts">
            ${h.persisted ? `<button type="button" class="mini auto dim" data-remove="${esc(h.url)}">移除</button>` : ''}
            ${action}
            ${joinBtn}
            ${clickable ? '<span class="chev">›</span>' : ''}
          </div>
        </div>`;
      })
      .join('');
    box.innerHTML = `
      <div class="machine-join-head">
        <div class="machine-join-title">可用总机</div>
        <div class="machine-join-actions">
          <button type="button" class="btn-sm" data-w="refresh" ${wiz.scanning ? 'disabled' : ''}>发现</button>
          <button type="button" class="btn-sm primary" data-w="add">添加</button>
        </div>
      </div>
      <div class="joinwiz-cands">${
        rowsHtml ||
        '<div class="dim joinwiz-note">列表还是空的 —— 点「发现」找同一网络里的班底，或点「添加」直接填地址（云端也行）。</div>'
      }</div>
      ${
        wiz.scanning
          ? `<div class="joinwiz-scan">
              <div class="joinwiz-spin"></div>
              <div>正在找同一网络里的班底总机…</div>
              <div class="dim" data-sec>已经找了 0 秒 · 同一网络里的班底会自动应答</div>
              <div class="dim">总机在云端、或不在同一个网络时不会出现在这里 —— 点「添加」直接填它的地址</div>
            </div>`
          : ''
      }
      ${errLine()}`;
  };

  /* 列表页是**唯一的一页**：加入的「会改变什么 / 邀请码 / 加入中 / 成功」全都进了弹窗
     （2026-10-21 用户："加入按钮一直显示，点击加入，打开弹窗"），页面不再被步骤机换来换去。 */
  const render = () => {
    const box = document.createElement('div');
    box.className = 'joinwiz page';
    drawList(box);
    // 只重画内容层：面板挂载点（#joinMount）是常驻元素
    root.querySelector('.joinwiz')?.remove();
    root.appendChild(box);

    /* 统一接线：`data-w` 对到列表页自己的动作（发现 / 添加）。
       行内按钮（data-test / data-join / data-remove / data-pick）走各自的直接接线 ——
       「加入」现在只负责开弹窗，加入本体在弹窗里。 */
    const handlers = {
      refresh: () => { wiz.err = ''; runScan(); },
      add: openAddHostDlg,
    };
    box.querySelectorAll('[data-w]').forEach((el) => {
      const fn = handlers[el.dataset.w];
      if (fn) el.onclick = () => fn();
    });
    // 行内按钮：点行 = 加入弹窗（只对扫描到的、开放加入的行）；「加入」按钮每行都有
    box.querySelectorAll('[data-pick]').forEach((el) => {
      el.onclick = () => openJoinDlg(el.dataset.pick, el.dataset.label);
    });
    box.querySelectorAll('[data-join]').forEach((el) => {
      el.onclick = () => openJoinDlg(el.dataset.join, el.dataset.label);
    });
    box.querySelectorAll('[data-test]').forEach((el) => {
      el.onclick = () => doTest(el.dataset.test, el);
    });
    box.querySelectorAll('[data-remove]').forEach((el) => {
      el.onclick = () => doRemove(el.dataset.remove);
    });
  };

  /* 「测试」一行（通讯录里的行）：原地转圈 → 通过标「可加入」/ 失败显示原因 + 重试。
     它只回答"连得上吗"，【不代表】按钮才出现 —— 「加入」每行常显
     （2026-10-21 用户："加入按钮一直显示"）。 */
  async function doTest(url) {
    wiz.tested.set(url, { state: 'testing' });
    render();
    try {
      const r = await post(`${LOCAL_BASE}/hosts/test`, { url });
      wiz.tested.set(url, { state: 'ok', host: r?.host ?? null });
      render();
    } catch (err) {
      wiz.tested.set(url, { state: 'fail', code: err.code ?? 'E1092', msg: err.message });
      toast(err.message, 'error');
      render();
    }
  }

  /**
   * 「添加」= 一个**小弹窗**（2026-10-21 用户："点击添加，打开弹窗，填写之后，完成添加"）。
   * 为什么这里又用弹窗：它不是页面的主体内容，只是"补一条地址"的一次性输入 ——
   * 填地址 + 两个按钮塞进一行会把列表页撑乱；而加入流程（列表/说明/用途）仍留在页面上。
   *
   * 服务端 `hosts/add` 现在**填了就入列**（不拦探测），所以这里成功后不预设"可加入"：
   * 行按「未测试」画，用户点行上的「测试」验连接 —— 这正是用户要的操作顺序。
   */
  function openAddHostDlg() {
    const dlg = document.createElement('dialog');
    dlg.className = 'joinwiz-dlg';
    const form = document.createElement('form');
    form.method = 'dialog';
    form.innerHTML = `
      <b>添加总机</b>
      <div class="joinwiz">
        <label for="joinAddUrl">总机地址</label>
        <input id="joinAddUrl" spellcheck="false" autocomplete="off" placeholder="http://192.168.1.9:8787 或 https://bandi.example.com" />
        <div class="dim joinwiz-note">局域网或云端都行。添加后用它那行的「测试」验连接。</div>
        <div class="joinwiz-err" id="joinAddErr" hidden></div>
        <div class="dlg-actions">
          <button type="button" value="cancel">取消</button>
          <button type="button" class="primary" id="joinAddOk">完成添加</button>
        </div>
      </div>`;
    dlg.append(form);
    document.body.append(dlg);
    wireDialogHead(form); // 动态建的弹窗自己包一次吸顶头（标题 + ×）
    const input = form.querySelector('#joinAddUrl');
    const errEl = form.querySelector('#joinAddErr');
    const okBtn = form.querySelector('#joinAddOk');

    const submit = async () => {
      const url = input.value.trim();
      if (!url) {
        errEl.hidden = false;
        errEl.textContent = '先填一个地址，例如 http://192.168.1.9:8787';
        input.focus();
        return;
      }
      okBtn.disabled = true;
      errEl.hidden = true;
      try {
        const r = await post(`${LOCAL_BASE}/hosts/add`, { url });
        wiz.hosts = Array.isArray(r?.hosts) ? r.hosts : wiz.hosts;
        wiz.tested.delete(r?.host?.url ?? url); // 入列但没测过 → 行上出「测试」
        dlg.close();
        render();
      } catch (err) {
        errEl.hidden = false;
        errEl.textContent = err.message;
        okBtn.disabled = false;
      }
    };
    okBtn.onclick = submit;
    // 回车 = 完成添加（method=dialog 的默认提交会直接关窗丢输入，必须自己拦）
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
    dlg.addEventListener('close', () => dlg.remove());
    dlg.showModal();
    input.focus();
  }

  /* 从通讯录移除一台（扫描来的临时行没有这个按钮 —— 它们本来就不落盘）。 */
  async function doRemove(url) {
    try {
      const r = await post(`${LOCAL_BASE}/hosts/remove`, { url });
      wiz.hosts = Array.isArray(r?.hosts) ? r.hosts : wiz.hosts.filter((h) => h.url !== url);
      wiz.tested.delete(url);
    } catch (err) {
      toast(err.message, 'error');
    }
    render();
  }

  /* 从列表选中一台（扫描行点选 / 通讯录行「加入」）→ 先探再进 explain。
     这次探测就是加入前的最后一道闸：列表状态和真实状态之间有时间差
     （刚关了开关 / 那台刚关机），在这里被拦下比走到一半失败好。 */
  /**
   * 「加入」= 弹窗（2026-10-21 用户："加入按钮一直显示，点击加入，打开弹窗"）。
   * 为什么进弹窗：加入前得先讲清"会改变什么"、再填邀请码，这是**一次性的确认**；
   * 塞在列表里会把"找哪台机器"这件事挤走，所以整块挪进 dialog，列表页永远原地不动。
   *
   * 为什么不先 probe：能不能加由服务端 `/join` 直接回答（连不上 E1092 / 未开放 E1091 /
   * 版本太旧 E2050 / 邀请码不对 E4011），失败原因写在弹窗里、码留着改就行 ——
   * 多探一次只是多等一次，判定标准却是同一个。名字从行上带过来，不必等 probe 才知道是谁。
   */
  function openJoinDlg(url, label) {
    wiz.url = url;
    const host = label || '那台班底';
    const dlg = document.createElement('dialog');
    dlg.className = 'joinwiz-dlg';
    const form = document.createElement('form');
    form.method = 'dialog';
    form.innerHTML = `
      <b>邀请码（10 分钟内有效，只能用一次）</b>
      <div class="joinwiz">
        <input id="joinCode" spellcheck="false" autocomplete="off" aria-label="邀请码" placeholder="bj_" value="${esc(wiz.code)}" />
        <div class="joinwiz-hint">加入后，这台电脑就是「${esc(host)}」的算力节点：总机把活派过来，在这台电脑上跑。</div>
        <div class="joinwiz-err" id="joinErr" hidden></div>
        <div class="dlg-actions">
          <button type="button" value="cancel">取消</button>
          <button type="button" class="primary" id="joinOk">加入</button>
        </div>
      </div>`;
    dlg.append(form);
    document.body.append(dlg);
    wireDialogHead(form); // 动态建的弹窗自己包一次吸顶头（标题 + ×）

    const codeEl = form.querySelector('#joinCode');
    const errEl = form.querySelector('#joinErr');
    const okBtn = form.querySelector('#joinOk');
    const showErr = (msg) => { errEl.hidden = false; errEl.textContent = msg; };

    okBtn.onclick = async () => {
      wiz.code = codeEl.value;
      if (!wiz.code.trim()) {
        showErr(`先填邀请码 —— 在「${host}」上：设置 → 这台机器 → 添加设备`);
        codeEl.focus();
        return;
      }
      errEl.hidden = true;
      okBtn.disabled = true;
      okBtn.textContent = '加入中…';
      try {
        const r = await post(`${LOCAL_BASE}/join`, { url, code: wiz.code.trim() });
        drawJoined(form, r?.hostLabel || host);
      } catch (err) {
        showErr(err.message); // E4011 码不对 → 就地改码再点，不用关弹窗
        okBtn.disabled = false;
        okBtn.textContent = '加入';
      }
    };

    dlg.addEventListener('close', () => dlg.remove());
    dlg.showModal();
    codeEl.focus();
  }

  /* 加入成功：同一个弹窗换成"落地说明 + 完成"（点完成等它重绑完再刷，别撞上白屏断口） */
  function drawJoined(form, host) {
    const n = Number(wiz.status?.local?.counts?.personas ?? 0);
    form.innerHTML = `
      <b>加入成功</b>
      <div class="joinwiz">
        <div class="joinwiz-text joinwiz-ok">✓ 这台电脑现在是「${esc(host)}」的算力节点了</div>
        <ul class="joinwiz-list">
          <li>总机把活派过来，在这台电脑上跑（节点已在后台常驻）</li>
          <li>这台电脑的班底界面从此只显示节点状态，不显示面板</li>
          <li>本机原来的 ${n} 个员工还在本机，没动过</li>
        </ul>
        <div class="dlg-actions">
          <button type="button" class="primary" id="joinDone">完成</button>
        </div>
      </div>`;
    form.querySelector('#joinDone').onclick = async () => {
      /*
       * 加入成功那一刻服务端会把监听**收回环**（见 `/api/local/join`），重绑有几毫秒断口。
       * 点「完成」先等它答话再刷，别让人正好撞上重绑白屏。
       */
      for (let i = 0; i < 40; i++) {
        try {
          if ((await fetch(`${LOCAL_BASE}/status`, { cache: 'no-store' })).ok) break;
        } catch {
          /* 重绑中 */
        }
        await new Promise((done) => setTimeout(done, 100));
      }
      location.reload();
    };
  }

  render(); // 不自动扫（2026-10-21 用户："去掉自动刷新探测，手动探测"）——
  // 进页只画「通讯录 + 空列表提示」，扫描由「发现」按钮触发，用户点一次才发一次 UDP。
}



/**
 * 远程节点的详情页 —— **一颗能按的按钮都不给**。
 *
 * 为什么不让它走下面那套本机交互：那一页上每颗开关干的都是"改**这台机器**上的运行时配置"
 * （写的是控制面进程所在的 `data/runtimes.json`）。对着一个远程节点按下去，
 * 改的其实是控制面这台机器，而界面上写的是那台机器 —— 语义就错了。
 * 所以这一版只回答两件事：它是什么、它自报装了什么。
 */
/**
 * 设备头那块：**大标题是人给它的名字，小字回真实主机名**。
 *
 * 为什么两个都显示：机器名可以是人随口起的（两台都叫「办公机」很正常），主机名不会重。
 * 改完名还能一眼认出是哪台，靠的就是下面那行小字。
 *
 * 为什么要有「重命名机器」：运行时下拉里显示的是**机器名**（`Codex CLI（我的笔记本）`），
 * 就叫 `DESKTOP-XXXXXXX` 的话，两台机器的条目在员工配置里根本分不出来。
 */
export function devHeadHtml(dev, { badges = '', sub = '', actions = '' } = {}) {
  const host = dev.hostname ?? '';
  return `<div class="dev-head">
    <div class="dev-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
        <rect x="2.5" y="4" width="19" height="13" rx="2" />
        <path d="M8.5 20.5h7M12 17v3.5" stroke-linecap="round" />
      </svg>
    </div>
    <div class="dev-meta">
      <div class="dev-title">${esc(dev.label)}${badges}</div>
      <div class="dev-sub">${host ? esc(host) + (sub ? ' · ' : '') : ''}${sub}</div>
    </div>
    <div class="dev-actions">
      <button class="btn-sm" id="renameDevice" title="给它起个好认的名字 —— 员工选运行时时显示的就是这个">重命名机器</button>
      ${actions}
    </div>
  </div>`;
}



/**
 * 班的「问一句」/「确认一下」—— 替代原生 `prompt()` / `confirm()`。
 *
 * 为什么不用原生的（2026-10-16 用户指着改名那个框说"改成弹窗组件"）：原生框是**浏览器**画的，
 * 标题栏里印着 `127.0.0.1:8787 显示`，跟班底长得不是一个东西；也没法用班底自己的措辞、
 * 说明文字和"破坏性操作"那种红色按钮。
 *
 * 一个 dialog 管两件事：给了 `field` 就要一段文字（有输入框），不给就只要一个是/否。
 * 返回值刻意跟原生对齐，好替换：**取消 = null**；确定 = 输入框里的字符串（确认类则是空串）。
 */
/**
 * 弹窗正文里的 `**强调**` → 粗体。
 *
 * 为什么要有（2026-10-16 截图时发现的）：我在这些正文里写了 `**一次性**` 这种强调，
 * 而它们是按 `textContent` 渲染的 → **星号原样显示出来** ✗（好几处弹窗都这样）。
 * **先转义再替换** —— 正文里会有用户起的名字、路径，不能直接当 HTML 塞进去。
 */
export function rich(s) {
  return esc(String(s ?? '')).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
}



export function askDialog({ title, body = '', field = false, value = '', placeholder = '', check = null, ok = '确定', danger = false }) {
  const dlg = $('askDlg');
  $('askTitle').textContent = title;
  const bodyEl = $('askBody');
  bodyEl.innerHTML = rich(body);
  bodyEl.style.display = body ? '' : 'none';
  const wrap = $('askField');
  wrap.style.display = field ? '' : 'none';
  const input = $('askInput');
  input.value = value;
  input.placeholder = placeholder;
  // 勾选框（可选）：让"要不要走镜像"变成一个勾，而不是让用户去填地址
  // ⚠️ 用 `block` + 左对齐：弹窗那个 <form> 本身是居中的，勾选框要是只顾着 flex
  // 就会被摆到文字上面或右边去（这个位置我调了两次才落对）
  const checkWrap = $('askCheckWrap');
  checkWrap.style.display = check ? 'block' : 'none';
  if (check) {
    $('askCheckLabel').textContent = check.label ?? '';
    $('askCheck').checked = !!check.checked;
  }
  const okBtn = $('askOk');
  okBtn.textContent = ok;
  okBtn.className = `primary${danger ? ' danger' : ''}`;
  return new Promise((resolve) => {
    // Esc 关掉时 returnValue 是空串 → 一律算取消（跟原生一致）
    dlg.onclose = () =>
      resolve(
        dlg.returnValue === 'ok'
          ? { ok: true, text: field ? input.value : '', checked: check ? $('askCheck').checked : false }
          : { ok: false, text: '', checked: false },
      );
    dlg.returnValue = '';
    dlg.showModal();
    if (field) setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}



/** 要一段文字。取消返回 null —— 跟 `prompt()` 对齐 */
export const askText = async (o) => {
  const r = await askDialog({ ...o, field: true });
  return r.ok ? r.text : null;
};



/** 只要一个是/否。返回 true / false —— 跟 `confirm()` 对齐 */
export const askConfirm = async (o) => (await askDialog({ ...o, field: false })).ok;



/**
 * `confirm('一句话')` 的**直接替代**（2026-10-18）：原生 confirm 是浏览器自带弹窗，用户要求不用。
 *
 * 跟 `askConfirm` 的分工：想好了标题和正文的用它；这里只要一句话 —— 正文就是那句话，
 * 标题给个中性的「确认一下」。**调用处记得 `await`**（返回 Promise，不是布尔值）。
 */
export const confirmDo = async (text, opts = {}) =>
  askConfirm({ title: opts.title ?? '确认一下', body: String(text ?? ''), ok: opts.ok ?? '确定', danger: opts.danger ?? true });



/**
 * 一个勾选框 + 一个是/否。返回 `{ok, checked}`。
 *
 * 专门给"走不走镜像"这类**用户只需要表态、不需要知道细节**的选择用
 * （2026-10-16 用户提的：普通用户不知道镜像地址，就不该让他填地址）。
 */
export const askCheckbox = (o) => askDialog({ ...o, field: false });



/**
 * 接上改名。**名字跟主机名是两回事**：这里只改名字，主机名是那台机器自报的事实，动不了。
 * 留空 = 恢复默认（回到主机名）。
 */
export function wireRenameDevice(dev) {
  const btn = $('renameDevice');
  if (!btn) return;
  btn.onclick = async () => {
    const next = await askText({
      title: '给这台机器起个名字',
      body: `主机名：${dev.hostname ?? dev.label}\n（留空 = 恢复成主机名）`,
      value: dev.renamed ? dev.label : '',
      placeholder: '留空就用主机名',
    });
    if (next === null) return; // 取消
    try {
      await post(`/api/devices/${encodeURIComponent(dev.id)}/rename`, { label: next });
      renderRuntimes(); // 重渲染：名字、面包屑、运行时的显示名一起跟上
    } catch {
      /* api() 已经提示过了 */
    }
  };
}



/**
 * 「复制」按钮：文案从 `data-copy` 取，复制完显示「已复制」再还原。
 *
 * 抽出来是因为**两页都要用**（本机设备页、远程节点页）—— 同一段逻辑各写一份，
 * 迟早只修其中一份（前端的"两套"就是这么来的）。
 */
export function wireCopyButtons() {
  $('settingsView').querySelectorAll('[data-copy]').forEach((el) => {
    const label = el.textContent;
    el.onclick = async () => {
      try {
        await navigator.clipboard.writeText(el.dataset.copy);
        el.textContent = '已复制';
        setTimeout(() => { el.textContent = label; }, 1500);
      } catch {
        toast('复制不了，手动选中吧：\n\n' + el.dataset.copy);
      }
    };
  });
}



/**
 * 一个运行时的**健康度** —— Multica 那张表叫「健康度」，这里按机器诚实分：
 *
 *   · **本机**运行时：健康 = **这个 CLI 现在能不能起**（文件在、班底起得来、已接入）。
 *     标签统一走「在线/离线」一套词（2026-10-21 用户："可用改成在线，不可用改成离线"）——
 *     原先"本机没有在线这回事"的讲究让位给词汇一致：状态列只有一套语言最好读。
 *   · **远程**运行时：健康 = **那台机器在不在线**（心跳新鲜）＋ 它自报这个 CLI 能不能用。
 *     这个才是用户真正要看的：选了一个离线节点的运行时，活不会立刻跑，而是排进队列等它回来。
 *
 * `showPath`：**要不要把那行路径摆出来**。只有"路径本身出问题"才摆（2026-10-16 用户提的：
 * 健康时那行长路径是纯噪音）。「已停用 / 还没接入」也不摆 —— 要不要接看的是右边那个开关，
 * 不是路径。平时想看完整路径：悬停有 title，点进名字是 CLI 详情页（那儿本来就摆着路径 + 检测）。
 *
 * ⚠️ 判据一律 `=== false`，不能写 `!field`：旧后端没有这个字段时，`!undefined` 会把
 * 健康的行全染红（这条真踩过，见 git 历史里 rowOfRuntime 那段注释）。
 *
 * ⚠️ 这两个函数必须放在**模块作用域**（2026-10-16 踩到）：我一度把它们插进了
 * `renderDeviceDetail` 的函数体里 —— 本机页能用，**节点页直接 `runtimeHealth is not defined`**，
 * 而页面只是停在"加载中"，从截图上根本看不出抛了什么（`--dump-dom` 里 `<title>` 才看到）。
 */
export function runtimeHealth(r) {
  // 路径本身有问题 —— 这两种**必须**把路径摆出来，否则不知道该改哪个
  if (r.pathExists === false) {
    return { text: '路径失效', cls: 'tag-warn', why: '记的这个位置已经没那个文件了', showPath: true };
  }
  if (r.launchable === false) {
    return {
      text: '班底起不来',
      cls: 'tag-warn',
      why: '文件在，但班底起不动它（.cmd/.bat 那种脚本不能直接启动）',
      showPath: true,
    };
  }
  if (!r.enabled) return { text: '已停用', cls: 'tag-warn', why: '关掉了就不派活给它' };
  if (r.remote) {
    return r.nodeOnline === false
      ? { text: '离线', cls: 'tag-warn', why: '那台机器没有心跳 —— 派给它的活会排队等它回来，不会立刻跑' }
      : { text: '在线', cls: 'tag-ok', why: '那台机器在心跳，派活会立刻被它领走' };
  }
  return { text: '在线', cls: 'tag-ok', why: '文件在、班底起得来 —— 控制面就在这台机器上，本机运行时只有"离线"的反面' };
}



/** 健康度那枚小标（跟在名称后面） */
export function healthTag(r) {
  const h = runtimeHealth(r);
  return `<em class="${h.cls}" title="${esc(h.why)}">${esc(h.text)}</em>`;
}



/**
 * 「路径已自动更正」那枚标。
 *
 * 为什么要有：CLI 升级后路径会变（npm 的 `claude.cmd` → 包里的 `bin\claude.exe`），
 * 而班底记的是"接进来那一刻"的路径 —— 那条就失效了。班底会**自己切到探测到的那个**，
 * 但**改了别人的配置就得说一声**，否则用户只会发现路径被悄悄改了。
 */
export function healedTag(r) {
  if (!r.healedFrom) return '';
  return `<em class="tag-ok" title="${esc(
    `原来记的「${r.healedFrom}」已经不能用了，班底自动切到了现在这个。你自己手工改一次路径，这枚标就消失。`,
  )}">路径已更正</em>`;
}



/**
 * 那台机器上**正在跑**的那件小事（装运行时 / 装外部件），针对某个目标。
 *
 * 为什么从 `dev.task` 读、而不是靠点击时那个闭包（2026-10-16 用户报的"刷新页面，看不到安装进度了"）：
 * 进度原来是**浏览器里的临时状态** —— 一刷新就没了，可那件事其实还在那台机器上跑着。
 * 按这条架构一贯的原则（**状态在服务端**），它得能从服务端读回来：刷新、换台电脑、明天再看，都还是它。
 */
export function runningTaskFor(dev, target) {
  const t = dev.task;
  if (!t || t.done || t.family !== target) return null;
  return t;
}



/** 任务输出的最后一行（界面上就显示这一行，够用又不吵） */
export function taskTail(task) {
  return (task?.output ?? '').trim().split('\n').filter(Boolean).slice(-1)[0] ?? '';
}



/**
 * 失败时该显示哪一行。
 *
 * ⚠️ 不能直接用最后一行（2026-10-16 用户报的："（sh 退出码 1）这个报错重装怎么还有"）：
 * 我让节点在收尾时补了一行 `（退出码 N）` —— 那是**我自己加的**，真正的错因在它**上面**几行
 * （比如 `magpie: could not download …`、`起不来：spawn magpie ENOENT`），
 * 结果界面上只显示了那行没用的，有用的被塞进悬停里 ✗。
 * 所以这里跳过"我自己补的那种行"（整行被括号包住的），挑**最后一行像错因的**。
 */
export function taskFailLine(task) {
  const lines = (task?.output ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const mine = /^（.*）$/; // 我自己补的：`（sh 退出码 1）`
  const good = lines.filter((l) => !mine.test(l));
  return (good.length ? good[good.length - 1] : lines[lines.length - 1]) ?? '';
}



/** 失败发生在什么时候（本地时分）—— 让"这次刚失败"和"上次的旧失败"分得出来 */
export function failAt(task) {
  const t = task?.endedAt ? new Date(task.endedAt) : null;
  if (!t || Number.isNaN(t.getTime())) return '';
  const mins = Math.round((Date.now() - t.getTime()) / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  return t.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}



/**
 * 有活在做就**接着盯**，但**只就地改进度那一行** —— 不整页重画。
 *
 * ⚠️ 为什么必须这样（2026-10-16 用户报的"页面在不停刷新"）：第一版我让它在跑的时候每 2 秒
 * 整页重画一次，看着就是"页面不停刷新"，滚动位置、展开状态全被打回去 ✗。
 * 进度是**一小段文字**的事，就只改那一小段文字：`textContent` 换掉，别的一动不动。
 * 只有**做完**那一刻才整页重画一次 —— 因为那一行要从「未安装」挪到「已安装」去。
 */
export function scheduleTaskPoll(dev) {
  const t = dev?.task;
  if (!t || t.done) return;
  if (S.rtLevel !== 'device' || S.rtDevice !== dev.id) return;
  clearTimeout(S.taskPoll);
  S.taskPoll = setTimeout(async () => {
    if (S.rtLevel !== 'device' || S.rtDevice !== dev.id) return;
    let next;
    try {
      // 只取这一件活的进度（一条小请求），不重画整页
      next = (await api(`/api/nodes/${encodeURIComponent(dev.id)}/tasks/${encodeURIComponent(t.id)}`)).task;
    } catch {
      return;
    }
    if (!next) return;
    if (next.done) {
      renderRuntimes(); // 做完才整页重画：那一行要挪位置、按钮要换
      return;
    }
    const text = `${next.running ? '进行中… ' : '排队中… '}${taskTail(next) || '（等那台机器来领）'}`;
    for (const el of document.querySelectorAll(`[data-task-line="${t.id}"]`)) el.textContent = text;
    scheduleTaskPoll({ ...dev, task: next }); // 接着盯
  }, 1500);
}



/**
 * 「外部件」那一段 —— 一台机器上**班底之外还要有的东西**（现在只有 magpie）。
 *
 * 为什么要单独摆出来（2026-10-16 用户提的）：它是"这台机器能不能干活"的**前提**，
 * 之前这个前提是隐形的 —— 装好了没人告诉你，没装 / 网关没起也不会提醒，
 * 只会在派活之后看到一串 502。
 *
 * 判定就三条，**不 import、不解析它的配置文件**（这样它怎么更新都不用动我们）：
 * ① 命令在不在（装了没）② 网关端口通不通 ③ 那台机器能不能一键装（命令表在**节点**那侧）。
 */
export function externalsHtml(dev) {
  const ex = dev.externals;
  if (!ex?.catalog?.length) return '';
  const probed = new Map((ex.probed ?? []).map((p) => [p.id, p]));
  const rows = ex.catalog
    .map((c) => {
      const p = probed.get(c.id) ?? { installed: false, gateway: null, panel: null };
      // 装了但网关没起，是最坑的状态：被它接管的 agent 会全线 502
      const health = !p.installed
        ? { text: '未安装', cls: 'tag-warn', why: '这台机器上还没装上它' }
        : c.gatewayPort && p.gateway === false
          ? { text: `网关没起（${c.gatewayPort}）`, cls: 'tag-warn', why: '装了但网关没在跑 —— 被它接管的 agent 会连不上，报 502' }
          : c.gatewayPort
            ? { text: '在线', cls: 'tag-ok', why: `网关在 ${c.gatewayPort} 上跑着` }
            : { text: '装了', cls: 'tag-ok', why: '命令在' };
      /*
       * 面板：**界面是它自己的，我们只放入口**（2026-10-16 定的）。
       * 所以这里不给"面板内容"，只给"起没起" ＋ 一条从局域网能打开的链接。
       * 面板自己有访问密钥（magpie 生成、跨重启保留），所以链接可能需要再点一次（或在它那边取带密钥的链接）。
       */
      const panelBadge =
        c.panelPort && p.installed
          ? p.panel
            ? `<em class="tag-ok" title="面板在 ${c.panelPort} 上跑着">面板已开</em>`
            : `<em class="tag-warn" title="装了但面板没跑 —— 在那台机器上跑 magpie daemon install --web --lan 就会常驻，开机自己起">面板没起</em>`
          : '';
      const oneClick = c.installCmd && dev.kind === 'node';
      const serve = c.serveCmd && dev.kind === 'node';
      const busy = runningTaskFor(dev, c.id);
      /*
       * 上一次**没成**的那件事 —— 也摆出来。
       *
       * 为什么要有（2026-10-16 用户停了安装、回来重看时发现的）：失败之后那一行原本什么都不说 ✗
       * （按钮回来了，可你不知道上次为什么没成 —— 只能去翻控制面的日志）。
       * 失败是**做过的事**，就该留在那儿：鼠标悬停还有完整输出。
       */
      const lastFail = !busy && dev.task?.done && dev.task.status !== '完成' && dev.task.family === c.id ? dev.task : null;
      return `<div class="row-item ${health.cls === 'tag-ok' ? '' : 'off'}" data-ext-row="${esc(c.id)}">
        ${cliAvatar(c.id, c.label)}
        <div class="who">
          <b>${esc(c.label)}<em class="${health.cls}" title="${esc(health.why)}">${esc(health.text)}</em>${panelBadge}</b>
          ${
            /*
             * 描述那行直接摆**它自己的官网**（2026-10-16 用户提的）：
             * 免得人误以为 magpie 是班底的产品 —— 它是个独立的开源工具，我们只是"认得它、能帮你装它"。
             * 原来那段"把各 agent 的请求转给你配的供应商…"挪到悬停里（想了解的人还能看）。
             */
            c.home
              ? `<div class="sub"><a href="${esc(c.home)}" target="_blank" rel="noreferrer" title="${esc(c.note ?? '')}" style="font-family:ui-monospace,monospace;font-size:11.5px">${esc(
                  c.home,
                )}</a></div>`
              : `<div class="sub">${esc(c.note ?? '')}</div>`
          }
          ${p.installed && p.where ? `<div class="sub" style="font-family:ui-monospace,monospace;font-size:11.5px">装在 ${esc(p.where)}</div>` : ''}
          <div class="sub install-log" style="display:none;font-family:ui-monospace,monospace;font-size:11.5px"></div>
          ${
            /*
             * 刷新页面之后进度也还在：直接读服务端那件正在跑的活。
             * `data-task-line` 是给"接着盯"用的：只**就地改这一行的文字**，不重画整页
             * （2026-10-16 用户报的"页面在不停刷新"就是整页重画闹的）。
             */
            busy
              ? `<div class="sub install-log" data-task-line="${esc(busy.id)}" style="display:block;font-family:ui-monospace,monospace;font-size:11.5px">${
                  busy.running ? '进行中… ' : '排队中… '
                }${esc(taskTail(busy) || '（等那台机器来领）')}</div>`
              : lastFail
                ? `<div class="sub" title="${esc(lastFail.output)}" style="color:var(--bad);font-size:11.5px">上次没成（${esc(
                    failAt(lastFail),
                  )}）：${esc(taskFailLine(lastFail) || '（没输出）')}（悬停看全部）</div>`
                : ''
          }
        </div>
        ${
          // 入口只在**面板真跑着**、而且我们知道一个能连上的地址时才给（不然点开是空白/401）
          c.panelPort && p.panel && p.panelUrl
            ? `<a class="mini auto" href="${esc(p.panelUrl)}" target="_blank" rel="noreferrer" title="在浏览器里打开它自己的面板（${esc(
                p.panelUrl,
              )}）—— 链接里带着访问密钥，点开就是已登录。⚠️ 这条链接等于那台机器上 magpie 的控制权（能改模型、看到密钥），而且是明文 HTTP：别外传；要更稳就在它那边配 --tls-cert/--tls-key。">打开面板</a>`
            : ''
        }
        ${
          /*
           * 外部件那颗按钮 —— **按状态给，只给一颗**（2026-10-16 用户定的）：
           *   · 没装                     → 「安装」：装了**自动**把服务也设好（用户不需要知道"常驻"是什么）
           *   · 装了但没跑起来            → 「重启」：把它拉起来（比"重装"轻，语义也对）
           *   · 上次失败过               → 「重装」：重走一遍安装 + 服务
           *   · 一切正常（网关或面板应答）→ **不给按钮**（装好了还杵着东西，人会以为还有事没做完 ✗）
           * 具体跑什么命令放悬停里：想知道的人能看，普通用户不用看。
           */
          busy
            ? '<span class="dim" style="font-size:11.5px">进行中…</span>'
            : p.installed && (p.gateway === true || p.panel === true)
              ? ''
              : oneClick || serve
                ? lastFail || !p.installed
                  ? `<button class="mini auto primary" data-ext-do="external-setup" data-ext-id="${esc(c.id)}" title="会在那台机器上依次跑：${esc(
                      [!p.installed ? c.installCmd : null, c.serveCmd].filter(Boolean).join('  →  '),
                    )}">${lastFail ? '重装' : '安装'}</button>`
                  : `<button class="mini auto primary" data-ext-do="external-serve" data-ext-id="${esc(c.id)}" title="它装着，但网关和面板都没在跑 —— 点一下把它拉起来（会在那台机器上跑：${esc(
                      c.serveCmd ?? '',
                    )}）">重启</button>`
                : c.installCmd && !p.installed
                  ? `<button class="mini auto" data-copy="${esc(c.installCmd)}">复制安装命令</button>`
                  : /* 已经装了、这个平台又没有"一条命令"（Windows 桌面安装包）—— 什么都不给 */
                    ''
        }
      </div>`;
    })
    .join('');
  return `<section class="fx" style="margin-top:26px">
      <label>外部件 <span class="count">${rows ? ex.catalog.length : 0}</span></label>
      ${rows}
    </section>`;
}



/**
 * 远程节点的详情页 —— 有几颗按钮，但**都是这台机器自己的事**（改名 / 忘掉），
 * 没有一颗会去改那台机器上的运行时配置（路径是那台机器上的事实，改不了，也不该假装能改）。
 *
 * 2026-10-16 起这里也分**已安装 / 未安装**：原来没探到就一句"一个都没探到"，
 * 等于把"该怎么办"藏起来了 —— 用户看到的是一台空机器，而不是"这三个里你一个都还没装，
 * 装上哪条命令在这"。判断依据是**节点自报的清单**（不是控制面本机的探测：那是两台机器）。
 */
export async function renderNodeDetail(dev) {
  // 左栏只写「设置」（在 openSettings 里）；这台机器的名字/状态/动作都在正文的 devHeadHtml 里，
  // 右页头不再重复一遍。
  const rts = dev.runtimes ?? [];
  // 族清单拉不到就不显示"未安装"那一段 —— 但这一页照常渲染，别因为一个附加块白屏
  let families = [];
  try {
    families = (await api('/api/runtime-families')).families ?? [];
  } catch {
    /* 忽略：下面按空处理 */
  }
  const haveFamily = new Set(rts.map((r) => r.family));
  const missing = families.filter((f) => !haveFamily.has(f.id));
  const isWin = /win/i.test(dev.platform ?? '');

  // 工作空间映射清单（2026-10-22）：拉不到就不显示已有条目，表单照常给
  let wsPaths = [];
  try {
    wsPaths = (await api(`/api/nodes/${encodeURIComponent(dev.id)}/paths`)).paths ?? [];
  } catch {
    /* 忽略：老版本服务没有这条路由 */
  }
  /** 映射列表的行（添加/删除后重画用同一份；⚠️ 必须声明在 innerHTML 那句之前 —— 模板串要用它） */
  const wsRowsHtml = (paths) =>
    paths.length
      ? paths
          .map(
            (p) => `<div class="row-item">
              <div class="who">
                <b style="font-family:ui-monospace,monospace;font-size:11.5px">${esc(p.remotePath)}</b>
                <div class="sub" style="font-family:ui-monospace,monospace;font-size:11.5px">→ ${esc(p.localPath)}</div>
              </div>
              <button class="mini auto txt" data-ws-del="${esc(p.remotePath)}">删除</button>
            </div>`,
          )
          .join('')
      : '<div class="empty">还没配映射 —— 需要在这台机器上干非 git 项目时再配</div>';

  const rowOfMissing = (f) => {
    /*
     * dsh 是 Windows 桌面端自带的，Linux/macOS 上根本没有那个形态 ——
     * 摆一条装不了的命令比不摆更糟（他会去试，然后回来问为什么不行）。
     */
    const cmd = f.install?.kind === 'app' && !isWin ? null : (f.install?.cmd ?? null);
    // 只有 npm 那种**能一键装**：dsh 要靠装桌面端，不是一条命令能解决的事，不给按钮
    const oneClick = f.install?.kind === 'npm' && !!cmd;
    const busy = runningTaskFor(dev, f.id);
    // 上次没成的那件（同外部件那行：失败也要留痕，不然用户不知道上次为什么没成）
    const lastFail = !busy && dev.task?.done && dev.task.status !== '完成' && dev.task.family === f.id ? dev.task : null;
    return `<div class="row-item off" data-rt-row="${esc(f.id)}">
      ${cliAvatar(f.id, f.label)}
      <div class="who">
        <b>${esc(f.label)}</b>
        ${
          cmd
            ? `<div class="sub" style="font-family:ui-monospace,monospace;font-size:11.5px">${esc(cmd)}</div>`
            : '<div class="sub">这台机器上装不了（它是 Windows 桌面端自带的）</div>'
        }
        <!-- 安装进度就写在这儿（点击之后才出现），不另开弹窗 -->
        <div class="sub install-log" style="display:none;font-family:ui-monospace,monospace;font-size:11.5px"></div>
        ${
          // 刷新页面之后进度也还在 —— 从服务端那件正在跑的活读回来（见 runningTaskFor）。
          // `data-task-line` 让"接着盯"只需就地改这一行，不用整页重画。
          busy
            ? `<div class="sub" data-task-line="${esc(busy.id)}" style="font-family:ui-monospace,monospace;font-size:11.5px">${
                busy.running ? '进行中… ' : '排队中… '
              }${esc(taskTail(busy) || '（等那台机器来领）')}</div>`
            : lastFail
              ? `<div class="sub" title="${esc(lastFail.output)}" style="color:var(--bad);font-size:11.5px">上次没成（${esc(
                  failAt(lastFail),
                )}）：${esc(taskFailLine(lastFail) || '（没输出）')}（悬停看全部）</div>`
              : ''
        }
      </div>
      ${
        busy
          ? '<span class="dim" style="font-size:11.5px">进行中…</span>'
          : oneClick
            ? `<button class="mini auto primary" data-install-rt="${esc(f.id)}" data-cmd="${esc(cmd)}">在这台机器上安装</button>`
            : ''
      }
      ${cmd ? `<button class="mini auto" data-copy="${esc(cmd)}">复制命令</button>` : ''}
    </div>`;
  };

  $('settingsView').innerHTML = `
    ${headRow(breadcrumb([{ label: '这台机器', to: 'devices' }, { label: dev.label }]))}
    <div class="detail-body">
      ${devHeadHtml(dev, {
        badges: `<span class="${dev.online ? 'pill-ok' : 'pill'}">${dev.online ? '在线' : '离线'}</span><span class="pill">远程节点</span>`,
        sub: `${esc(dev.platform)} · ${dev.runtimeCount} 个 agent CLI`,
        /*
         * 「忘掉这台」放在这儿（跟「重命名机器」并排）——它原来占页面底部一整段 ✗。
         * 说明进悬停：那台机器换过数据目录/身份文件丢了就会用新身份再报到一次，
         * 这一行会永远"离线"躺着，而它的运行时还挂在员工的下拉里。
         */
        actions: `<button class="btn-sm danger" id="forgetNode" title="忘掉这台机器：删掉控制面上这一条记录。那台机器什么都不受影响，而且它下一次心跳（15 秒内）就会自己重新报到 —— 身份、运行时都在，只有你给它起的名字会丢。只有"它永远不会再回来了"（比如你清掉了那台机器的数据目录、或换了一台机器）才需要忘掉它。">忘掉这台机器</button>`,
      })}
      <!--
        ⚠️ 这里原来有一行「上次心跳 …Z —— 每 15 秒一次，超过三个周期没过来就判离线」＋「远程节点（主动连出）」。
        2026-10-16 用户让删掉：**那是开发关心的事，用户不关心** ✓ ——
        用户只需要知道"在线还是离线"（左上角那个标记就是干这个的 ✓），
        心跳间隔、判离线的周期数、连出方向都是实现细节。
        （真要看这些的场合是排查故障 —— 后端日志和 /api/devices 里照样有 ✓。）
      -->
      ${
        /* 权限与「最近使用」（2026-10-20，P1-3 的一半）：两个字段都来自 GET /api/devices
           （runtimes.publicDevice 的节点分支），**没有就不渲染这一行** —— 别给用户看 "undefined"。 */
        dev.scope
          ? `<div class="sub machine-scope-line">${
              String(dev.scope).includes('panel')
                ? '这台能看到面板'
                : '这台看不到面板（总机没给面板权限）'
            }${dev.lastUsedAt ? ` · 最近使用 ${esc(dt(dev.lastUsedAt))}` : ''}</div>`
          : ''
      }

      <section class="fx">
        <!-- 跟本机那页一个词（「已安装」）—— 用户不关心"自报"这套机制 -->
        <label>已安装 <span class="count">${rts.length}</span></label>
        ${
          rts.length
            ? rts
                .map(
                  (r) => {
                    const h = runtimeHealth(r);
                    return `<div class="row-item ${h.cls === 'tag-ok' ? '' : 'off'}">
              ${cliAvatar(r.family ?? r.id, r.label)}
              <div class="who" title="${esc(r.path)}">
                <b>${esc(r.label)}${healthTag(r)}</b>
                ${h.showPath ? `<div class="sub">${esc(r.path)}</div>` : ''}
              </div>
            </div>`;
                  },
                )
                .join('')
            : `<div class="empty">它说本机一个 agent CLI 都没探到${missing.length ? ' —— 看下面「未安装」那段' : ''}</div>`
        }
        <!--
          这里原来还有一段说明（"这些条目能派活…但不能在这儿改：路径是那台机器上的事实…
          控制面也不会在本机起它们 —— 那等于拿着一个只有那台机器才有的路径在这儿 spawn"）。
          2026-10-16 用户让删掉 ✓：那是在解释**我们为什么这么写**，不是在告诉用户**能干什么**。
          用户能看出来的部分（哪些装了什么）已经摆在上面了 ✓。
        -->
      </section>

      ${
        missing.length
          ? `<section class="fx" style="margin-top:26px">
               <label>未安装 <span class="count">${missing.length}</span></label>
               ${missing.map(rowOfMissing).join('')}
               <!--
                 这里原来还有一段说明（"有「在这台机器上安装」的点一下就行……控制面只把族名递过去，
                 所以这条通道递不出任意命令" ＋ "装完不用重启节点：每次心跳都会把清单报上来"）。
                 2026-10-16 用户让删掉 ✓ —— 半句是**我们内部的安全边界**，半句是**实现细节**，
          用户要的只是"这颗按钮能装、那台机器的清单会自己更新"（前者按钮上写着、后者看得见）✓。
                -->
             </section>`
          : ''
      }

      ${
        /* 工作空间（2026-10-22）：派到这台机器的活在它那儿落脚的两条路 ——
           git 仓库自动 clone/pull（不用配）；普通文件夹项目用这张映射表。
           列表拉不到就只显示表单（对面是老版本服务时也不至于白屏）。 */
        `<section class="fx" style="margin-top:26px">
          <label>工作空间${wsPaths.length ? ` <span class="count">${wsPaths.length}</span>` : ''}</label>
          <div class="sub" style="margin-bottom:10px">派到这台机器的活在这儿干活：git 仓库会自动克隆、拉最新（私有仓库在这台机器上 git 登录一次即可）；普通文件夹项目在下面配一条「总机目录 → 这台机器目录」。</div>
          <div id="wsRows">${wsRowsHtml(wsPaths)}</div>
          <div class="row-item" style="gap:8px;align-items:center">
            <input id="wsRemote" placeholder="总机上的目录，如 E:\\02CodeSpace\\proj" style="flex:1;min-width:0" />
            <span style="color:var(--dim)">→</span>
            <input id="wsLocal" placeholder="这台机器上的目录，如 D:\\work\\proj" style="flex:1;min-width:0" />
            <button class="mini auto primary" id="wsAdd">添加映射</button>
          </div>
        </section>`
      }

      ${externalsHtml(dev)}
    </div>`;

  /*
   * 「忘掉这台」挪到**头部**跟「重命名机器」并排（2026-10-16 用户提的：省点空间）。
   * 原来它是页面底部一整段（标题 ＋ 三段说明 ＋ 按钮）✗ —— 一个很少用到的破坏性操作
   * 占了一整块。现在说明挪进**悬停**和**确认框**里（点下去之前照样看得到，包括"身上还压着几个活"）。
   *
   * ⚠️ 这里的话**必须跟代码实际行为对上**（2026-10-16 用户问"能重新连回来吗"时发现的）：
   * 原来写的是"在那台机器上重新起一次节点就行（会得到新身份）" —— 那是**错的** ✗。
   * 实际是：节点下一次心跳/领活会拿到 404，它自己就重新报到了（15 秒内），
   * 而且用的是**同一个 id**（id 存在那台机器的数据目录里）—— 身份、运行时都回来，
   * 只有**名字**会丢（名字存在控制面这一侧）。会"得到新身份"的只有一种情况：
   * 那台机器上的数据目录被清掉/换了（身份文件没了）。
   */
  /* ---- 工作空间映射（2026-10-22）：增删走同一份行渲染，页面随时重画也不怕 ---- */
  const paintWs = (paths) => {
    const box = $('wsRows');
    if (box) box.innerHTML = wsRowsHtml(paths);
  };
  const wsAdd = $('wsAdd');
  if (wsAdd) {
    wsAdd.onclick = async () => {
      const remotePath = $('wsRemote').value.trim();
      const localPath = $('wsLocal').value.trim();
      if (!remotePath || !localPath) return toast('两边路径都要填：总机上的目录 + 这台机器上的目录', 'error');
      try {
        const r = await api(`/api/nodes/${encodeURIComponent(dev.id)}/paths`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ remotePath, localPath }),
        });
        wsPaths = r.paths ?? [];
        $('wsRemote').value = '';
        $('wsLocal').value = '';
        paintWs(wsPaths);
      } catch (err) {
        toast(err.message, 'error');
      }
    };
  }
  const wsRows = $('wsRows');
  if (wsRows) {
    wsRows.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-ws-del]');
      if (!btn) return;
      try {
        const r = await api(`/api/nodes/${encodeURIComponent(dev.id)}/paths`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ remotePath: btn.dataset.wsDel }),
        });
        wsPaths = r.paths ?? [];
        paintWs(wsPaths);
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  $('forgetNode').onclick = async () => {
    const urge = dev.pendingJobs ? `\n\n⚠️ 它身上还压着 ${dev.pendingJobs} 个活，会一并收掉。` : '';
    const ok = await askConfirm({
      title: `忘掉「${dev.label}」？`,
      body: `只删控制面上的这条记录。那台机器不受影响，15 秒内会自己重新报到，只有你给它起的名字会丢。${urge}`,
      ok: '忘掉',
      danger: true,
    });
    if (!ok) return;
    try {
      await api('/api/nodes/' + encodeURIComponent(dev.id), { method: 'DELETE' });
      S.rtLevel = 'devices';
      S.rtDevice = null;
      renderRuntimes();
    } catch { /* api() 已经提示过了 */ }
  };

  wireRenameDevice(dev);
  wireCopyButtons(); // 未安装那段的「复制命令」
  wireInstallRuntime(dev); // 未安装那段的「在这台机器上安装」—— 走节点的领活通道，命令在节点那侧查表
  wireExternalActions(dev); // 外部件那颗按钮：安装 / 重启 / 重装（按状态给，只给一颗）
  // 有活在做就自己刷（进度是服务端的事实，不是点击时记的定时器）
  scheduleTaskPoll(dev);
}



/**
 * 外部件那颗按钮：**安装 / 重启 / 重装**（按状态给，只给一颗）。
 *
 * 跟「在这台机器上安装运行时」是同一条通道（节点的领活），只是命令表不同 ——
 * 控制面照样只发 **id + 哪一步**，命令由那台机器自己查（安全边界一致）。
 */
/**
 * 给那台机器排一件事，然后盯着它做完 —— **「排队 → 轮询 → 出结果」这套只写一遍**。
 *
 * 为什么要有这个函数（2026-10-16）：我先给「装运行时」写了一遍，又给「外部件」抄了一遍，
 * 两处一模一样 —— 正是那种"迟早只改其中一处"的重复。`onLine(text, keep)` 负责写进度。
 * 返回 `{ok, status, tail, reason}`。
 */
export async function runNodeTask(dev, { kind, target, mirror = '', onLine = () => {} }) {
  let task;
  try {
    task = (await post(`/api/nodes/${encodeURIComponent(dev.id)}/tasks`, { kind, family: target, mirror })).task;
  } catch {
    return { ok: false, reason: '排不上' }; // api() 已经提示过了
  }
  onLine('排队中 —— 等那台机器来领（它离线时会一直等着，不会丢）');
  // 上限 10 分钟：免得那台机器一直不来领，这个页面就永远转着
  const deadline = Date.now() + 10 * 60 * 1000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));
    let t;
    try {
      t = (await api(`/api/nodes/${encodeURIComponent(dev.id)}/tasks/${encodeURIComponent(task.id)}`)).task;
    } catch {
      return { ok: false, reason: '查不到进度了' };
    }
    if (!t) return { ok: false, reason: '任务不见了' };
    const tail = (t.output ?? '').trim().split('\n').filter(Boolean).slice(-1)[0] ?? '';
    if (t.status === '执行中') onLine(tail || '正在跑…');
    else if (t.done) return { ok: t.status === '完成', status: t.status, tail, output: t.output ?? '' };
    if (Date.now() > deadline) {
      return { ok: false, reason: '等了 10 分钟还没完 —— 那台机器可能没在领活（离线 / 正忙）。进度不会丢，回来刷新能看到。' };
    }
  }
}



/**
 * 外部件的**一颗**按钮（安装 / 重启 / 重装）。
 *
 * 用户不需要知道"常驻服务"是什么（2026-10-16 用户定的）—— 所以：
 *   · 「安装」（没装）：**自动**两步一起做。①`curl … install.sh | sh` 让它**存在**；
 *     ②`magpie daemon install --web --lan` 让它**一直跑**（网关＋面板、开机自己起）。
 *     顺序不能反（②要①的产物），但这是**我们的事**，不是用户的事。
 *   · 「重启」（装了但没跑起来）：只跑②（幂等 —— 服务丢了也能补上）。
 *   · 「重装」（上次失败过）：重走①＋②。
 * 具体命令放悬停里：想知道的人能看，普通用户不用看。
 */
export function wireExternalActions(dev) {
  $('settingsView').querySelectorAll('[data-ext-do]').forEach((btn) => {
    btn.onclick = async () => {
      const kind = btn.dataset.extDo; // external-setup（安装/重装）| external-serve（重启）
      const extId = btn.dataset.extId;
      const catalog = (dev.externals?.catalog ?? []).find((x) => x.id === extId) ?? {};
      const probed = (dev.externals?.probed ?? []).find((x) => x.id === extId) ?? {};
      const steps =
        kind === 'external-setup'
          ? [
              // 已经装着就别再下一次 48M 了 —— 那种"重装"要的是把服务重新弄好
              probed.installed ? null : { kind: 'external-install', cmd: catalog.installCmd },
              { kind: 'external-serve', cmd: catalog.serveCmd },
            ].filter((s) => s && s.cmd)
          : [{ kind: 'external-serve', cmd: catalog.serveCmd }];
      const row = btn.closest('.row-item');
      const log = row?.querySelector('.install-log');
      const say = (text, keep = false) => {
        if (!log) return;
        log.style.display = '';
        log.textContent = keep ? (log.textContent + text).slice(-600) : text;
      };

      const extLabel = catalog.label ?? extId; // 目录里的名字（原来这里引用了外层 map 的 c，点击必抛 ReferenceError）
      const needDownload = steps.some((s) => s.kind === 'external-install');
      let mirror = '';
      if (needDownload) {
        /*
         * **走不走镜像** —— 一个勾选框，不是让人填地址（2026-10-16 用户提的：
         * 普通用户不知道镜像地址该填什么）。地址由我们内置（见 externals.mjs 的 mirrors），
         * 勾上就按顺序试，谁先通用谁 —— 这类公共镜像会挂，不能只写死一个。
         */
        const mirrors = catalog.mirrors ?? [];
        const r = await askCheckbox({
          title: kind === 'external-setup' && probed.installed ? '重装？' : '安装？',
          body: `会在「${dev.label}」上安装 ${extLabel}。`,
          check: mirrors.length
            ? { label: '走国内镜像下载', checked: true } // 默认勾上：直连在国内基本是等它超时
            : null,
          ok: '开始',
        });
        if (!r.ok) return;
        mirror = r.checked && mirrors.length ? mirrors : '';
      } else {
        const ok = await askConfirm({
          title: '重启？',
          body: `会把「${dev.label}」上的 ${extLabel} 拉起来。`,
          ok: '重启',
        });
        if (!ok) return;
      }

      const label = btn.textContent;
      btn.disabled = true;
      // 勾了镜像就按顺序试：第一个不行就换下一个（每个都有各自的超时，别把用户钉在一个挂掉的镜像上）
      const tries = Array.isArray(mirror) ? (mirror.length ? mirror : ['']) : [mirror];
      let last = null;
      for (let t = 0; t < tries.length; t++) {
        const useMirror = tries[t];
        if (tries.length > 1) say(`试第 ${t + 1} 个镜像：${useMirror}`);
        let failed = false;
        for (const [i, s] of steps.entries()) {
          btn.textContent = steps.length > 1 ? `${i + 1}/${steps.length} 进行中…` : '进行中…';
          const res = await runNodeTask(dev, { kind: s.kind, target: extId, mirror: useMirror, onLine: say });
          last = res;
          if (!res.ok) {
            failed = true;
            break;
          }
        }
        if (!failed) {
          // 不提"两步"：用户不需要知道底下是几步（2026-10-16）
          say('好了 —— 正在刷新…');
          btn.textContent = '好了';
          setTimeout(() => renderRuntimes(), 700);
          return;
        }
        if (t < tries.length - 1) say(`这个镜像没成（${last?.tail || last?.reason || '没输出'}），换下一个…`, true);
      }
      say(`没成：${last?.tail || last?.reason || '（没输出）'}`, true);
      btn.disabled = false;
      btn.textContent = label;
    };
  });
}



/**
 * 「在这台机器上安装」（远程节点）。
 *
 * 流程：确认（把**要跑的命令原样**摆出来）→ 排个任务 → 节点在它自己的领活循环里领走并跑 →
 * 界面轮询任务状态显示进度 → 装完那台机器**立刻重报清单**，这一页自己刷新。
 *
 * 为什么命令要在确认框里原样显示：这是"在**别人的机器**上装东西"。点下去之前得看清楚是什么。
 * 而命令本身**不是这里拼的** —— 这里只发族名，节点自己查表（安全边界）。
 */
export function wireInstallRuntime(dev) {
  $('settingsView').querySelectorAll('[data-install-rt]').forEach((btn) => {
    btn.onclick = async () => {
      const family = btn.dataset.installRt;
      const cmd = btn.dataset.cmd;
      const row = btn.closest('.row-item');
      const log = row?.querySelector('.install-log');
      const say = (text, keep = false) => {
        if (!log) return;
        log.style.display = '';
        log.textContent = keep ? (log.textContent + text).slice(-600) : text;
      };
      const ok = await askConfirm({
        title: '在这台机器上安装？',
        /*
         * 正文只留"会在哪台机器上跑什么" —— 点之前必须看清楚的是**要执行什么** ✓。
         * 原来后面还跟一句"装完不用重启节点 —— 它会自己把新清单报上来"，
         * 2026-10-16 用户让删 ✓（那是实现细节；用户会自己看见清单变了，原理归网站讲）。
         */
        body: `会在「${dev.label}」上跑：\n${cmd}`,
        ok: '开始安装',
      });
      if (!ok) return;

      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = '进行中…';
      // 「排队 → 轮询 → 出结果」那套只用写一遍（见 runNodeTask）
      const r = await runNodeTask(dev, { kind: 'install-runtime', target: family, onLine: say });
      if (r.ok) {
        say('装好了 —— 正在刷新…');
        btn.textContent = '装好了';
        setTimeout(() => renderRuntimes(), 700); // 那台机器已经重报清单了，刷新就能看到
        return;
      }
      say(`装失败了：${r.tail || r.reason || '（没输出）'}`, true);
      btn.disabled = false;
      btn.textContent = label;
    };
  });
}



/* ② 设备详情：这台设备上的 CLI —— 一行一个实例，一个开关决定接不接入 */

/**
 * 这一页是"这台机器上有什么、我要不要用"，**不是"填表加一条"**。
 *
 * 为什么不做成表单：路径是"这台机器上的事实"，不是用户该知道的知识 ——
 * 一个不懂电脑的人不可能知道 `%LOCALAPPDATA%\Programs` 在哪，也不该被要求知道。
 * 所以：
 *   · 分两段：**已安装的在上，没装的在下**（下面每行带一条能直接粘的安装命令）
 *   · 归属看 `publicFamilies().installed`，页面加载就有值（纯 existsSync）
 *   · 已有实例的行：开着的 = 接入中；关掉 = 停用（不删，位置记着）
 *   · 装了但还没接入的族：一行，开关关着，打开就建一条
 *   · 点「识别本机运行时」：只为了补**版本号**（那要 spawn 进程，约 0.5 秒）
 *
 * 「安装」弹窗是唯一还可能出现手填的入口（"我装了、但你没认出来"），正常流程碰不到。
 */
export async function renderDeviceDetail() {
  $('settingsView').innerHTML = rtLoading('这台机器');

  let dev;
  let families;
  try {
    // 族列表**每次都拉**：bandi 只支持这三家，所以"未安装"那一段要一直摆在那儿
    // （各自带安装命令），不能等点了「识别」才出现。
    [dev, families] = await Promise.all([
      api('/api/devices/' + encodeURIComponent(S.rtDevice)).then((d) => d.device),
      api('/api/runtime-families').then((f) => f.families),
    ]);
  } catch (err) {
    $('settingsView').innerHTML = `${headRow('<b>这台机器</b>')}<div class="empty">${failHtml(err)}</div>`;
    return;
  }

  /* 运行时是**多层**的（运行时 › 设备 › CLI）：页头用面包屑，上级能直接点回去
     （2026-10-20 用户截图：「运行时这个功能，下面有多层页面，应该改成面包屑模式」）。
     左栏仍是「设置」的分节列表，所以面包屑从「运行时」这一层起 —— 不再写成"设置 › 运行时 › …"。 */

  // 远程节点：这一版只报到，它的运行时是只读的 —— 别让它掉进下面那套"改本机"的交互里
  // 远程节点：交给它自己那页（那边要拉族清单，所以是异步的）
  if (dev.kind === 'node') return await renderNodeDetail(dev);

  const scan = S.rtScan; // null = 这一轮还没点过「识别本机运行时」
  const haveFamily = new Set(dev.runtimes.map((r) => r.family));
  const verOf = new Map((scan ?? []).map((f) => [f.id, f.version]));
  const pathOf = new Map(
    (scan ?? []).map((f) => [f.id, (f.candidates ?? []).find((c) => c.usable)?.path ?? null]),
  );

  /*
   * 放上面还是下面，看**这台机器上装没装** —— 用族列表里现成的 `installed`
   * （服务端渲染这一页时已经探过了，纯 existsSync，约 8ms）。
   *
   * 为什么不靠「识别本机运行时」才分：那等于**明知故等**。这个字段本来就有值，
   * 却让一个装着的 CLI 先蹲在「未安装」里、还挂着一条安装命令，等人点一下才承认。
   * 那颗按钮现在只干一件事：把**版本号**补上（那才需要 spawn 进程，约 0.5 秒）。
   */
  const notYet = families.filter((f) => f.installed && !haveFamily.has(f.id));
  const absent = families.filter((f) => !f.installed && !haveFamily.has(f.id));

  const rowOfRuntime = (r) => {
    // 健康度用**共用的**那个判据（本机＝这个 CLI 现在能不能起；远程＝那台机器在不在线）。
    // 那条"判据必须 === false、不能用 !field"的教训已经收进 runtimeHealth 的注释里。
    const ver = verOf.get(r.family);
    const h = runtimeHealth(r);
    // 路径只在"路径本身有问题"时摆出来 —— 见 runtimeHealth 的 showPath
    const sub = h.showPath ? `<div class="sub">${esc(r.path)}</div>` : '';
    return `<div class="row-item ${h.cls === 'tag-ok' ? '' : 'off'}">
      ${cliAvatar(r.family ?? r.id, r.label)}
      <div class="who" data-open-cli="${esc(r.id)}" style="cursor:pointer" title="${esc(r.path)}">
        <b>${esc(r.label)}${ver ? `<em class="tag-ok">${esc(ver)}</em>` : ''}${healthTag(r)}${healedTag(r)}</b>
        ${sub}
      </div>
      <label class="switch" title="${r.enabled ? '接入中 —— 关掉就不再派活给它' : '已停用 —— 打开就重新接入'}">
        <input type="checkbox" data-rt-toggle="${esc(r.id)}" ${r.enabled ? 'checked' : ''} /><span></span>
      </label>
    </div>`;
  };

  // 探测到、但这台设备上还没有它的实例 —— 开关关着，打开就建一条
  // 探测到、但这台设备上还没有它的实例 —— 开关关着，打开就建一条
  const rowOfNotYet = (f) => {
    const ver = verOf.get(f.id);
    const p = pathOf.get(f.id) ?? f.detectedPath ?? '';
    return `<div class="row-item">
      ${cliAvatar(f.id, f.label)}
      <div class="who">
        <b>${esc(f.label)}${ver ? `<em class="tag-ok">${esc(ver)}</em>` : ''}</b>
        <div class="sub">还没接入 —— 打开右边的开关</div>
      </div>
      <label class="switch" title="接入：用探测到的位置建一条">
        <input type="checkbox" data-rt-add="${esc(f.id)}" data-rt-path="${esc(p)}" /><span></span>
      </label>
    </div>`;
  };

  /*
   * 这台机器上没有 —— **跟远程节点那一行完全一致**（2026-10-21 用户提的）：
   * 一颗「在这台机器上安装」（点了当场装，进度就地写），外加「复制命令」「按路径接入」。
   * 原来这里只给「复制安装命令」—— 可节点页早就能一键装了，本机反而要人开终端，
   * 两台机器两套动作，没有道理（本机就是控制面自己，更没理由绕不开）。
   * 判据逐条对齐节点页的 rowOfMissing：dsh 是 Windows 桌面端自带的，别处不给那条"命令"。
   */
  const isWinLocal = /win/i.test(dev.platform ?? '');
  const rowOfAbsent = (f) => {
    const cmd = f.install?.kind === 'app' && !isWinLocal ? null : (f.install?.cmd ?? null);
    // 只有 npm 那种能一键装（同节点页：dsh 要靠装桌面端，不是一条命令能解决的事，不给按钮）
    const oneClick = f.install?.kind === 'npm' && !!cmd;
    const busy = runningTaskFor(dev, f.id);
    // 上次没成的那件也摆出来（同节点页：失败是做过的事，就该留在那儿，悬停看完整输出）
    const lastFail = !busy && dev.task?.done && dev.task.status !== '完成' && dev.task.family === f.id ? dev.task : null;
    const sub = cmd
      ? `<div class="sub" style="font-family:ui-monospace,monospace;font-size:11.5px">${esc(cmd)}</div>`
      : '<div class="sub">这台机器上装不了（它是 Windows 桌面端自带的）</div>';
    return `<div class="row-item off">
      ${cliAvatar(f.id, f.label)}
      <div class="who">
        <b>${esc(f.label)}</b>
        ${sub}
        <!-- 安装进度就写在这儿（点击之后才出现），不另开弹窗 -->
        <div class="sub install-log" style="display:none;font-family:ui-monospace,monospace;font-size:11.5px"></div>
        ${
          busy
            ? `<div class="sub" data-task-line="${esc(busy.id)}" style="display:block;font-family:ui-monospace,monospace;font-size:11.5px">${
                busy.running ? '进行中… ' : '排队中… '
              }${esc(taskTail(busy) || '（马上开始）')}</div>`
            : lastFail
              ? `<div class="sub" title="${esc(lastFail.output)}" style="color:var(--bad);font-size:11.5px">上次没成（${esc(
                  failAt(lastFail),
                )}）：${esc(taskFailLine(lastFail) || '（没输出）')}（悬停看全部）</div>`
              : ''
        }
      </div>
      ${
        busy
          ? '<span class="dim" style="font-size:11.5px">进行中…</span>'
          : oneClick
            ? `<button class="mini auto primary" data-install-rt="${esc(f.id)}" data-cmd="${esc(cmd)}">在这台机器上安装</button>`
            : ''
      }
      ${cmd ? `<button class="mini auto" data-copy="${esc(cmd)}">复制命令</button>` : ''}
      <button class="mini auto" data-rt-manual="${esc(f.id)}">按路径接入</button>
    </div>`;
  };

  $('settingsView').innerHTML = `
    ${headRow(breadcrumb([{ label: '这台机器', to: 'devices' }, { label: dev.label }]))}
    <div class="detail-body">
      ${devHeadHtml(dev, {
        badges: '<span class="pill-ok">在线</span><span class="pill">本机</span>',
        sub: `${esc(dev.platform)} · 已接入 ${dev.runtimes.filter((r) => r.enabled).length} 个 agent CLI`,
      })}

      <section class="fx">
        <div class="fx-head">
          <label>已安装 <span class="count">${dev.runtimes.length + notYet.length}</span></label>
          <button class="btn-sm" id="detectRuntime" title="再扫一遍这台机器：补上版本号，也确认没装错">识别本机运行时</button>
        </div>
        ${dev.runtimes.map(rowOfRuntime).join('')}
        ${notYet.map(rowOfNotYet).join('')}
        ${
          !dev.runtimes.length && !notYet.length
            ? '<div class="dim" style="padding:14px 16px">这台机器上还没探测到任何一个 agent CLI —— 看下面「未安装」那一段怎么装。</div>'
            : ''
        }
        ${
          scan === null
            ? '<div class="dim" style="padding:10px 2px;font-size:12px">点「识别本机运行时」可以补上版本号。</div>'
            : ''
        }
      </section>

      ${
        absent.length
          ? `<section class="fx" style="margin-top:26px">
               <div class="fx-head">
                 <label>未安装 <span class="count">${absent.length}</span></label>
                 <span class="dim" style="font-size:12px">安装成功之后，点击【识别本机运行时】按钮进行刷新</span>
               </div>
               ${absent.map(rowOfAbsent).join('')}
             </section>`
          : ''
      }

      ${externalsHtml(dev)}
    </div>`;

  wireRenameDevice(dev);
  wireCopyButtons(); // 外部件那段的「复制安装命令」（本机不给一键：控制面直接跑 curl|sh 不合适，用户在终端里粘一下更清楚）
  wireInstallRuntime(dev); // 未安装那段的「在这台机器上安装」—— 本机由控制面当场执行（见 server.mjs 的 local 分支）
  scheduleTaskPoll(dev); // 有装在跑就接着盯（刷新页面之后进度也能从服务端读回来）

  // 扫描：点了才跑（要 spawn 进程拿版本号，约半秒）
  $('detectRuntime').onclick = async () => {
    const btn = $('detectRuntime');
    btn.disabled = true;
    btn.textContent = '识别中…';
    try {
      S.rtScan = (await api('/api/runtimes/detect')).families;
      await renderDeviceDetail();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = '识别本机运行时';
      toast(err.message, 'error');
    }
  };

  // 已有实例：开关 = 停用/启用
  $('settingsView').querySelectorAll('[data-rt-toggle]').forEach((el) => {
    el.onchange = async () => {
      try {
        await api(`/api/devices/${encodeURIComponent(S.rtDevice)}/runtimes/${encodeURIComponent(el.dataset.rtToggle)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: el.checked }),
        });
        await load();
        await renderDeviceDetail();
      } catch (err) {
        toast(err.message, 'error');
        el.checked = !el.checked;
      }
    };
  });

  // 探测到但还没接入：打开开关 = 用探测到的位置建一条
  $('settingsView').querySelectorAll('[data-rt-add]').forEach((el) => {
    el.onchange = async () => {
      el.disabled = true;
      try {
        await post(`/api/devices/${encodeURIComponent(S.rtDevice)}/runtimes`, {
          family: el.dataset.rtAdd,
          path: el.dataset.rtPath,
        });
        await load();
        await renderDeviceDetail();
      } catch (err) {
        toast(err.message, 'error');
        el.disabled = false;
        el.checked = false;
      }
    };
  });

  wireCopyButtons();

  // 名字带 rt 前缀：插件页那条「粘一条 MCP 配置」的按钮也叫 data-manual，
  // 两边虽然同时只有一个渲染、不会真撞，但同名迟早会咬人
  $('settingsView').querySelectorAll('[data-rt-manual]').forEach((el) => {
    el.onclick = () => {
      // 族可能来自扫描结果（带 candidates）也可能来自族列表（带 detectedPath）
      const f = [...(scan ?? []), ...families].find((x) => x.id === el.dataset.rtManual);
      if (f) openAddRuntime(f);
    };
  });

  $('settingsView').querySelectorAll('[data-open-cli]').forEach((el) => {
    el.onclick = () => {
      S.rtLevel = 'cli';
      S.rtRuntime = el.dataset.openCli;
      renderRuntimes();
    };
  });
}



/* 「安装」弹窗 —— 正常流程碰不到它（打开开关就自动建好了） */

export let addRtFamily = null;



/**
 * 「安装」弹窗：只干一件事 —— 你说你装了、可班底没认出来，那把位置告诉它。
 *
 * 为什么这儿**不再放安装命令**：列表里「未安装」那一行已经给了命令 + 复制按钮，
 * 弹窗里再来一份是重复的（用户实报）。
 *
 * 输入可以是**安装目录**也可以是可执行文件路径：服务端会往里找到真正的可执行文件
 * （见 runtimes.mjs 的 resolveCliPath）。
 */
export function openAddRuntime(family) {
  addRtFamily = family;
  const usable = (family.candidates ?? []).filter((c) => c.usable);
  /*
   * 预填**只认探测结果**。
   *
   * 以前这里还会退回 `family.defaultPath`，而那是各个适配器里**写死的**路径
   * （值来自开发那台机器的布局）。能走到这个弹窗的族，按定义就是"没探测到"的 ——
   * 那个写死的路径极可能根本不存在。预填进去等于递给他一个看着合理、
   * 点下去必然得一个「路径已失效」的值，他还不知道哪儿错了。
   * 空着 + placeholder 才是诚实的。（写死的兜底已经从服务端整条去掉了。）
   */
  const preset = usable[0]?.path || family.detectedPath || '';

  /*
   * 标题跟列表里那颗按钮一致（都叫「按路径接入」）。
   *
   * 为什么**不叫「安装」**（2026-10-16 用户提的）：这个弹窗干的事是
   * "告诉我它装在哪（目录或可执行文件都行）→ 检测 → 接进来"，**它不装任何东西**。
   * 叫「安装」会让人以为点了就会帮他装一个 —— 于是真没装的人点进来、填了个猜的路径、
   * 得到一个「路径已失效」，还不知道问题出在哪。
   * 也不用「路径配置」：那是**名词**（像个设置项），按钮该是动词，而且它确实**当场完成接入**。
   * 同一行那个「复制安装命令」才是真安装（`npm install -g …`），那个词是对的。
   */
  $('addRtTitle').textContent = `按路径接入 ${family.label}`;
  $('addRtPath').value = preset;
  $('addRtPath').placeholder = `它的位置：安装目录或可执行文件，例如 ${EXAMPLE_DIR[family.id] ?? 'D:\\Tools\\xxx'}`;
  // 底部那一行先放常驻提示；点「检测」之后会被结果替换掉（同一块地方，不占两处）
  $('addRtFoot').innerHTML = `如果<b>已经装了、但没被认出来</b>，把它的位置填进来 —— 目录或可执行文件都行（如：${esc(
    EXAMPLE_DIR[family.id] ?? 'D:\\Tools\\xxx',
  )}）。`;
  $('addRtDlg').showModal();
  setTimeout(() => $('addRtPath').focus(), 30);
}



/** 提示里那个"例如"用的目录。**只是举例**，不会被当成默认值填进去 */
export const EXAMPLE_DIR = {
  codex: 'D:\\Tools\\codex',
  claude: 'D:\\Tools\\Claude',
  dsh: 'D:\\AppData\\Local\\Programs\\DeepSeek Harness',
};



/**
 * 「检测」：跑一次 `--version`，看这个路径到底行不行。
 *
 * 为什么要有：手填路径最容易出的错是"看着对、其实跑不起来"（填了个目录、
 * 填了个 .cmd shim、版本不对）。让人在**接入之前**就知道结果，比接进去之后
 * 在列表里看到一个「路径已失效」强得多。
 *
 * 服务端会先过 `resolveCliPath`：填目录的话解析成里面的可执行文件，
 * 并把解析结果回给这里 —— 所以解析结果要**写回输入框**，让人看见实际用哪个文件。
 *
 * 结果写进底部的 `addRtFoot`（**和常驻提示共用那一行**），不是另开一块：
 * 另开一块就得为它预留高度，弹窗中间会出现一个空洞。
 */
export async function testAddRuntimePath() {
  const btn = $('addRtTest');
  const out = $('addRtFoot');
  const given = $('addRtPath').value.trim();
  if (!given) {
    out.innerHTML = '<em class="tag-warn">先填一个路径</em>';
    return;
  }
  btn.disabled = true;
  btn.textContent = '检测中…';
  out.textContent = '';
  try {
    const r = await post('/api/runtimes/test', { family: addRtFamily.id, path: given });
    if (r.ok) {
      out.innerHTML = `<em class="tag-ok">${esc(r.version || '能跑')}</em> 可以接入`;
      if (r.path && r.path !== given) {
        // 填的是目录 → 服务端解析出了真身，写回去让人看见
        $('addRtPath').value = r.path;
        out.innerHTML += '<span class="dim" style="font-size:11.5px">（已定位到可执行文件）</span>';
      }
    } else {
      let msg = r.error || '';
      /*
       * 最常见的坑：填的是 Windows 的 `.cmd` / `.bat` shim（比如 npm 全局装完留下的那个）。
       * 文件确实在，但 Node 22 起 spawn 一个 .cmd（不挂 shell）直接 EINVAL ——
       * 报出来的原文 "起不来：EINVAL spawn EINVAL" 对用户毫无意义，换成人话。
       */
      if (/EINVAL/i.test(msg) && /\.(cmd|bat)$/i.test(given)) {
        // 短一点：结果区只预留了两行，太长会把弹窗撑高
        msg = '班底不能直接启动 .cmd/.bat —— 请指向它背后的 .exe 或 .js';
      }
      out.innerHTML = `<em class="tag-warn">跑不起来</em> <span class="dim">${esc(msg)}</span>`;
    }
  } catch (err) {
    out.innerHTML = `<em class="tag-warn">${failHtml(err)}</em>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '检测';
  }
}



/* ③ CLI 详情 */
export async function renderCliDetail() {
  $('settingsView').innerHTML = rtLoading('这台机器');

  let dev;
  let rt;
  try {
    dev = (await api('/api/devices/' + encodeURIComponent(S.rtDevice))).device;
    rt = dev.runtimes.find((r) => r.id === S.rtRuntime);
    if (!rt) throw new Error('这台设备上没有这个 CLI');
  } catch (err) {
    $('settingsView').innerHTML = `${headRow('<b>这台机器</b>')}<div class="empty">${failHtml(err)}</div>`;
    return;
  }

  /* 运行时是**多层**的（运行时 › 设备 › 这个 CLI）：页头用面包屑，两级上级都能点回去。
     左栏仍是「设置」的分节列表，所以面包屑从「运行时」这一层起。 */
  $('settingsView').innerHTML = `
    ${headRow(breadcrumb([
      { label: '这台机器', to: 'devices' },
      { label: dev.label, to: 'device' },
      { label: rt.label },
    ]))}
    <div class="detail-body">
      <!--
        这里原来有个「启用」勾选框。删掉了 —— 列表页那一行已经有开关（点一下立刻生效），
        同一个状态在两处改是坏事：这页的勾选框还得配合下面的「保存」才生效，
        两边的值还可能不一致。
      -->

      <section class="fx">
        <label>可执行路径</label>
        <div class="row-inline">
          <input id="rtPath" value="${esc(rt.path)}" spellcheck="false" />
          <button id="rtProbe">检测</button>
        </div>
        <div class="hint" id="rtResult" style="margin-top:8px"></div>
      </section>

      <section class="fx">
        <label>沙箱模式</label>
        <input id="rtSandboxes" value="${esc(rt.sandboxes.join(', '))}" spellcheck="false" />
        <label class="sub-label">其中「跑不了命令」的（逗号分隔）</label>
        <input id="rtBlocked" value="${esc(rt.blocked.join(', '))}" spellcheck="false" />
      </section>

      <div class="fx-actions">
        <button class="primary" id="rtSave">保存</button>
        ${rt.builtIn ? '' : '<button class="danger" id="rtDelete">删除这个运行时</button>'}
      </div>
    </div>`;

  const p = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
  const payload = () => ({
    // 不带 enabled：启停归列表页那颗开关管，这一页不该动它。
    // 服务端 `patch.enabled === undefined` 时会保留原值，所以这里不发就安全。
    path: $('rtPath').value.trim(),
    sandboxes: p($('rtSandboxes').value),
    blocked: p($('rtBlocked').value),
  });
  const url = `/api/devices/${encodeURIComponent(S.rtDevice)}/runtimes/${encodeURIComponent(S.rtRuntime)}`;


  const delBtn = $('rtDelete');
  if (delBtn) {
    delBtn.onclick = async () => {
      if (!(await confirmDo(`删掉运行时「${rt.label}」？\n绑了它的员工需要改绑，否则会跑不起来。`))) return;
      try {
        await api(url, { method: 'DELETE' });
        await load();
        S.rtLevel = 'device';
        S.rtRuntime = null;
        renderRuntimes();
      } catch (err) { toast(err.message, 'error'); }
    };
  }

  $('rtSave').onclick = async () => {
    try {
      await api(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload()) });
      $('rtResult').textContent = '已保存。';
      $('rtResult').style.color = 'var(--ok)';
      await load(); // 员工的权限下拉要跟着更新
    } catch (err) {
      showFail($('rtResult'), err);
      $('rtResult').style.color = 'var(--bad)';
    }
  };

  $('rtProbe').onclick = async () => {
    $('rtResult').textContent = '检测中…';
    $('rtResult').style.color = '';
    try {
      // 先存再探：探测走的就是这份路径
      await api(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload()) });
      const r = await post(url + '/probe', {});
      $('rtResult').innerHTML = r.ok
        ? `在线，版本：<code>${esc(r.version || '(没报版本号)')}</code>`
        : `离线 —— ${esc(r.error || '未知原因')}`;
      $('rtResult').style.color = r.ok ? 'var(--ok)' : 'var(--bad)';
      await load();
    } catch (err) {
      showFail($('rtResult'), err);
      $('rtResult').style.color = 'var(--bad)';
    }
  };
}
