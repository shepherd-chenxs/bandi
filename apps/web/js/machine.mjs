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



/* 「数据管理」区（2026-10-29 起是「这台机器」页底下的一个区，不再是设置里的独立分节）——
   导出 = VACUUM INTO 出一份完整快照，导出时不用停班底。
   导入 = 选一份班底导出的 .db 快照覆盖本机数据：服务端先校验（头 / 完整性 / 班底的表），
   写成待用文件，**重启班底才换库**（换的时候现库自动备份进 backups/导入前-*.db）。
   恢复从此有两条路：直接导入快照，或照老办法手动覆盖 bandi.db。
   降成区之后 UI 跟着收（用户："导入导出做成按钮就行，没必要占据那么大的位置"）——
   导出/导入就是节头两颗按钮。「重启生效」这类后果话术归导入确认框。
   2026-11-04 重设计：库路径从节头挪到卡上面一行小字（不再跟按钮挤一行）；
   点隔的一行统计改成等宽分格的统计块（数字大、标签小，一眼可比）；
   快照条目压成单行 —— 文件名居左、来源·大小·时间右对齐。 */
export async function renderBackupSection(mount) {
  /* 状态和备份列表并行拉；谁挂了都不拦渲染 —— 状态挂了数字显示 —，列表挂了显示空态，
     点导出/导入都会拿到真实报错。 */
  const [rStatus, rBackups] = await Promise.allSettled([
    api(`${LOCAL_BASE}/status`),
    api(`${LOCAL_BASE}/backups`),
  ]);
  if (!mount?.isConnected) return; // 拉数据期间页面被切走了，别往已摘下的节点上画
  const st = rStatus.status === 'fulfilled' ? rStatus.value : null;
  const bl = rBackups.status === 'fulfilled' ? rBackups.value : null;
  const local = st?.local ?? {};
  const counts = local.counts ?? {};
  const size = fmtMb(local.dbSize);
  const mtime = local.dbMtime ? dt(local.dbMtime) : '';
  /* backups/ 里的快照（定时备份 + 导入前自动备份）。来源标注跟命名规则一一对应。 */
  const SRC_LABEL = { scheduled: '定时备份', import: '导入前备份', other: '备份' };
  const bkFiles = Array.isArray(bl?.files) ? bl.files : [];
  const bkList = bkFiles.length
    ? bkFiles.map((f) => `
        <div class="dm-item" title="${esc(`${bl.dir ?? ''}\\${f.name}`)}">
          <div class="machine-path dm-item-name">${esc(f.name)}</div>
          <div class="dm-item-sub">${SRC_LABEL[f.src] ?? SRC_LABEL.other} · ${fmtMb(f.size) || '—'} · ${dt(f.mtime)}</div>
        </div>`).join('')
    : `<div class="dm-empty">还没有备份。导入快照换库、或开了定时备份之后，会自动存进数据目录的 backups/ 里。</div>`;
  /* 统计块：数字当主信息、标签当辅信息；拉不到的（比如状态接口挂了）整块不画，别摆空格子 */
  const tiles = [
    size ? { v: size, l: '库大小' } : null,
    { v: Number(counts.personas ?? 0), l: '员工' },
    { v: Number(counts.conversations ?? 0), l: '会话' },
    { v: Number(counts.projects ?? 0), l: '项目' },
    mtime ? { v: mtime, l: '最后修改', time: true } : null,
  ].filter(Boolean)
    .map((s) => `<div class="dm-stat${s.time ? ' dm-stat-time' : ''}"><b>${esc(s.v)}</b><span>${s.l}</span></div>`)
    .join('');
  /*
   * 导出/导入按钮**任何形态都显示**（2026-11-01 用户："不管是不是总机分机，
   * 这个导入导出都要一直显示"）—— 原来服务器形态（局域网访问）藏按钮只留 CLI 指路，
   * 但桌面壳走的是 127.0.0.1 回环，服务端本来就直接放行；真从别的机器开网页点下去，
   * 也会拿到 E4097 的人话报错，不会误伤。藏按钮属于过度防御。
   */
  mount.innerHTML = `
    <section class="fx dm-sec">
      <div class="fx-head">
        <label>数据管理</label>
        <div class="dm-actions">
          <button class="btn-sm" id="backupImport">导入快照</button>
          <button class="btn-sm primary" id="backupExport">导出快照</button>
        </div>
      </div>
      <div class="dm-pathline" title="${esc(local.dbPath ?? '')}">库文件<span class="machine-path">${esc(local.dbPath ?? '—')}</span></div>
      <div class="dm-card">
        <div class="dm-stats">${tiles}</div>
        <div class="dm-snaps">
          <div class="dm-snaps-head">备份快照<span class="dm-list-count">${bkFiles.length ? `${bkFiles.length} 份 · 定时备份与导入前自动备份都存在数据目录的 backups/ 里` : ''}</span></div>
          <div class="dm-snaps-body">${bkList}</div>
        </div>
      </div>
    </section>
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
      await renderBackupSection(mount); // 重画一遍：状态行还是现库的数字，别让人误以为已经换了
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      impBtn.disabled = false;
    }
  };
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
 * 班的「问一句」/「确认一下」—— 替代原生 `prompt()` / `confirm()`。
 *
 * 为什么不用原生的（2026-10-16 用户指着改名那个框说"改成弹窗组件"）：原生框是**浏览器**画的，
 * 标题栏里印着 `127.0.0.1:18787 显示`，跟班底长得不是一个东西；也没法用班底自己的措辞、
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



export function askDialog({ title, body = '', field = false, value = '', placeholder = '', check = null, ok = '确定', danger = false, big = false }) {
  const dlg = $('askDlg');
  /*
   * 大按钮档（2026-11-07 手机实机截图：「取消和退出按钮做大一些」）。
   *
   * 加在 dialog 上而不是给两颗按钮改内联样式：样式归 style.css，这里只挂一个开关，
   * 以后别的"只有一个动作要人拍板"的确认框想变大，传 `big: true` 就够。
   */
  dlg.classList.toggle('ask-big', !!big);
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
  askConfirm({ title: opts.title ?? '确认一下', body: String(text ?? ''), ok: opts.ok ?? '确定', danger: opts.danger ?? true, big: opts.big ?? false });



/**
 * 一个勾选框 + 一个是/否。返回 `{ok, checked}`。
 *
 * 专门给"走不走镜像"这类**用户只需要表态、不需要知道细节**的选择用
 * （2026-10-16 用户提的：普通用户不知道镜像地址，就不该让他填地址）。
 */
export const askCheckbox = (o) => askDialog({ ...o, field: false });



/**
 * 一个运行时的**健康度** —— 同类产品那张表叫「健康度」，这里按机器诚实分：
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



/** 任务输出的最后一行（界面上就显示这一行，够用又不吵） */
export function taskTail(task) {
  return (task?.output ?? '').trim().split('\n').filter(Boolean).slice(-1)[0] ?? '';
}



/**
 * 有活在做就**接着盯**，但**只就地改进度那一行** —— 不整页重画。
 *
 * ⚠️ 为什么必须这样（2026-10-16 用户报的"页面在不停刷新"）：第一版我让它在跑的时候每 2 秒
 * 整页重画一次，看着就是"页面不停刷新"，滚动位置、展开状态全被打回去 ✗。
 * 进度是**一小段文字**的事，就只改那一小段文字：`textContent` 换掉，别的一动不动。
 * 只有**做完**那一刻才整页重画一次。安装入口已撤（2026-11-04 用户定：班底只识别、不代装，
 * 因为"替用户装东西"遇到的坑太多），这里只剩兜底：升级前留下的旧任务还在跑时，进度照样能接上。
 */
export function scheduleTaskPoll(dev) {
  const t = dev?.task;
  if (!t || t.done) return;
  // 2026-11-01 设备详情页撤了：安装任务长在「这台机器」页（devices 层、无 rtDevice）
  if (S.rtLevel !== 'devices' || S.rtDevice) return;
  clearTimeout(S.taskPoll);
  S.taskPoll = setTimeout(async () => {
    if (S.rtLevel !== 'devices' || S.rtDevice) return;
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



/* 「外部件」段已删（2026-11-01 用户定：没啥用）。它只剩 magpie 一个条目、
   又只在「这台机器」页露面 —— 拆掉后 dev.externals 无人消费，
   服务端 externals.mjs / 节点上报那套就闲置着（节点侧老客户端还在报，接口兼容收下即存）。
   要找回这段从 git 找：本文件历史里的 externalsHtml()。 */



/* 「在这台机器上安装」已撤（2026-11-04 用户定：班底**只识别，不代装** ——
   替用户跑安装命令遇到的坑太多：npm 不在 PATH、spawn ENOENT、装完路径对不上…）。
   一键安装 / 复制命令 / 安装任务排队那套（wireInstallRuntime / runNodeTask）整体删除；
   同日下午：服务端的 install-runtime 通路（runtimes 的安装命令表、本机/节点两个执行器、
   POST /api/nodes/:id/tasks 的分支）也一并清了 —— 界面、协议、执行三层都不留残骸。
   magpie 的安装不走这里：那是外部件（externals.commandFor），在插件页「软件」条目。
   要找回从 git 找：本文件历史里的 wireInstallRuntime()。 */



/* 「运行时」区（2026-11-01 七改，用户截图："把运行时放到这个页面的数据管理上面"；
   同日八改：设备节 + 设备详情页整个撤掉 —— 本机详情页的「已安装 / 未安装 / 外部件」
   全部并入这里，这就是这台机器页的一部分了。
   2026-11-04：安装入口整段撤掉（「未安装」→「未识别」）；同日再撤：用户拍板
   "只要识别功能" —— 「未识别」段和「按路径接入」弹窗也整个去掉，这一区只剩
   识别（「识别本机运行时」）+ 接入（已识别列表上的开关）。
   deviceId = 设备列表里本机那条的 id；开关/识别的语义与原详情页完全一致。
   onChange：改动成功后的回调 —— 不传就整页 renderRuntimes()。 */
export async function paintLocalRuntimes(mount, deviceId, { onChange } = {}) {
  if (!mount || !deviceId) return;
  let dev = null;
  let families = [];
  try {
    [dev, families] = await Promise.all([
      api('/api/devices/' + encodeURIComponent(deviceId)).then((d) => d.device),
      api('/api/runtime-families').then((f) => f.families).catch(() => []),
    ]);
  } catch { mount.innerHTML = ''; return; } // 拉不到就空着，别把整页拖白
  const scan = S.rtScan; // null = 这一轮还没点过「识别本机运行时」
  const verOf = new Map((scan ?? []).map((f) => [f.id, f.version]));
  const pathOf = new Map((scan ?? []).map((f) => [f.id, (f.candidates ?? []).find((c) => c.usable)?.path ?? null]));
  const haveFamily = new Set(dev.runtimes.map((r) => r.family));
  const notYet = families.filter((f) => f.installed && !haveFamily.has(f.id));

  /* 行骨架沿用原详情页的 rowOf —— 改样式连这里一起改 */
  const rowOf = (r) => {
    const ver = verOf.get(r.family);
    const h = runtimeHealth(r);
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

  const render = () => {
    /* 空态（一条都没有）用引导卡：原来两行灰字看着像页面坏了，
       现在给出「去哪点、点了会发生什么」；有内容时 scan===null 才留一行补版本号的提示 */
    const nAny = dev.runtimes.length + notYet.length;
    mount.innerHTML = `
      <section class="fx">
        <div class="fx-head">
          <label>运行时 <span class="count">${nAny}</span></label>
          <button class="btn-sm" id="detectRuntime" title="再扫一遍这台机器：补上版本号，也确认没装错">识别本机运行时</button>
        </div>
        ${dev.runtimes.map(rowOf).join('')}
        ${notYet.map(rowOfNotYet).join('')}
        ${
          nAny
            ? scan === null
              ? '<div class="rt-hint">点「识别本机运行时」可以补上版本号。</div>'
              : ''
            : `<div class="rt-empty">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m21 21-4.3-4.3"></path></svg>
                <b>这台机器上还没识别到 agent CLI</b>
                <span>点右上角的「识别本机运行时」扫一遍 —— 识别到的会列在这里，用右边的开关逐个接入。</span>
              </div>`
        }
      </section>`;

    /* 接线全部限定在 mount 里（querySelector，不扫全局） */
    const detect = mount.querySelector('#detectRuntime');
    if (detect) {
      detect.onclick = async () => {
        detect.disabled = true;
        detect.textContent = '识别中…';
        try {
          S.rtScan = (await api('/api/runtimes/detect')).families;
          await paintLocalRuntimes(mount, deviceId, { onChange }); // 重画这一节：版本号上标签
        } catch (err) {
          detect.disabled = false;
          detect.textContent = '识别本机运行时';
          toast(err.message, 'error');
        }
      };
    }
    mount.querySelectorAll('[data-rt-toggle]').forEach((el) => {
      el.onchange = async () => {
        try {
          await api(`/api/devices/${encodeURIComponent(deviceId)}/runtimes/${encodeURIComponent(el.dataset.rtToggle)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: el.checked }),
          });
          await load();
          if (onChange) onChange(); else await renderRuntimes();
        } catch (err) {
          toast(err.message, 'error');
          el.checked = !el.checked;
        }
      };
    });
    mount.querySelectorAll('[data-rt-add]').forEach((el) => {
      el.onchange = async () => {
        el.disabled = true;
        try {
          await post(`/api/devices/${encodeURIComponent(deviceId)}/runtimes`, {
            family: el.dataset.rtAdd,
            path: el.dataset.rtPath,
          });
          await load();
          if (onChange) onChange(); else await renderRuntimes();
        } catch (err) {
          toast(err.message, 'error');
          el.disabled = false;
          el.checked = false;
        }
      };
    });
    mount.querySelectorAll('[data-open-cli]').forEach((el) => {
      el.onclick = () => {
        S.rtDevice = deviceId;
        S.rtLevel = 'cli';
        S.rtRuntime = el.dataset.openCli;
        renderRuntimes();
      };
    });
    scheduleTaskPoll(dev); // 升级前留下的旧安装任务若还在跑，进度照样接上（新任务已无处可发起）
  };
  render();
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

  /* 运行时是**多层**的（运行时 › 这个 CLI）：页头用面包屑，上级能点回去。
     左栏仍是「设置」的分节列表，所以面包屑从「运行时」这一层起。
     （2026-11-01 设备详情页撤了 —— 中间那级「本机」没了，CLI 详情直接挂在这台机器下。） */
  $('settingsView').innerHTML = `
    ${headRow(breadcrumb([
      { label: '这台机器', to: 'devices' },
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
        S.rtLevel = 'devices';
        S.rtDevice = null;
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
