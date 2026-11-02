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
   大字统计条、两张动作卡、右栏快照列表全部收掉：导出/导入就是节头两颗按钮，
   状态压成一行小字，备份快照是一个矮列表。「重启生效」这类后果话术归导入确认框。 */
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
  const stats = [
    size ? `<b>${esc(size)}</b> 库大小` : '',
    `<b>${Number(counts.personas ?? 0)}</b> 员工`,
    `<b>${Number(counts.conversations ?? 0)}</b> 会话`,
    `<b>${Number(counts.projects ?? 0)}</b> 项目`,
    mtime ? `<b>${esc(mtime)}</b> 最后修改` : '',
  ].filter(Boolean).join('<span class="dm-sep">·</span>');
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
          <span class="machine-path dm-path" title="${esc(local.dbPath ?? '')}">${esc(local.dbPath ?? '—')}</span>
          <button class="btn-sm" id="backupImport">导入快照</button>
          <button class="btn-sm primary" id="backupExport">导出快照</button>
        </div>
      </div>
      <div class="dm-card">
        <div class="dm-line">${stats}</div>
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



/**
 * 那台机器上**正在跑**的那件小事（装运行时），针对某个目标。
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
 * 给那台机器排一件事，然后盯着它做完 —— **「排队 → 轮询 → 出结果」这套只写一遍**。
 *
 * ⚠️ 这段在 app.js → js/ 拆分时被弄丢了（2026-11-02 用户报"点击安装并不能真的安装"）：
 * `wireInstallRuntime` 里 `await runNodeTask(...)` 直接 ReferenceError，
 * async onclick 静默拒绝 —— 确认框点了「开始安装」后按钮卡在「进行中…」，什么都没发生。
 * 这里按 394b0a3 的原实现逐字搬回（`mirror` 参数留着：外部件那套已删，但签名别缩）。
 * 返回 `{ok, status, tail, output}` / 失败 `{ok:false, reason}`。
 */
async function runNodeTask(dev, { kind, target, mirror = '', onLine = () => {} }) {
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



/* 「运行时」区（2026-11-01 七改，用户截图："把运行时放到这个页面的数据管理上面"；
   同日八改：设备节 + 设备详情页整个撤掉 —— 本机详情页的「已安装 / 未安装 / 外部件」
   全部并入这里，这就是这台机器页的一部分了）。
   deviceId = 设备列表里本机那条的 id；开关/接入/识别/安装的语义与原详情页完全一致。
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
  const absent = families.filter((f) => !f.installed && !haveFamily.has(f.id));

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

  /* 「未安装」行 —— 原样搬自 renderDeviceDetail 的 rowOfAbsent（2026-11-01 八改并区）：
     一键安装 / 复制命令 / 按路径接入，语义一个不少 */
  const isWinLocal = /win/i.test(dev.platform ?? '');
  const rowOfAbsent = (f) => {
    const cmd = f.install?.kind === 'app' && !isWinLocal ? null : (f.install?.cmd ?? null);
    // 只有 npm 那种能一键装（dsh 是 Windows 桌面端自带的，不是一条命令能解决的事，不给按钮）
    const oneClick = f.install?.kind === 'npm' && !!cmd;
    const busy = runningTaskFor(dev, f.id);
    // 上次没成的那件也摆出来（失败是做过的事，就该留在那儿，悬停看完整输出）
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

  const render = () => {
    mount.innerHTML = `
      <section class="fx">
        <div class="fx-head">
          <label>运行时 <span class="count">${dev.runtimes.length + notYet.length}</span></label>
          <button class="btn-sm" id="detectRuntime" title="再扫一遍这台机器：补上版本号，也确认没装错">识别本机运行时</button>
        </div>
        ${dev.runtimes.map(rowOf).join('')}
        ${notYet.map(rowOfNotYet).join('')}
        ${
          !dev.runtimes.length && !notYet.length
            ? '<div class="dim" style="padding:14px 16px">这台机器上还没探测到 agent CLI —— 看「未安装」那一段怎么装。</div>'
            : ''
        }
        ${scan === null ? '<div class="dim" style="padding:10px 2px;font-size:12px">点「识别本机运行时」可以补上版本号。</div>' : ''}
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
      }`;

    /* 接线范围限定在 mount 里（querySelector 而非 $('')）；安装/复制/任务轮询那几个
       帮手自己扫 #settingsView —— 页面上只有这一节带这些属性，借用无妨 */
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
    /* 「未安装」段的三个动作（原详情页的接线，一个不少） */
    wireInstallRuntime(dev); // 「在这台机器上安装」—— 本机由控制面当场执行（server.mjs 的 local 分支）
    wireCopyButtons(); // 「复制命令」
    mount.querySelectorAll('[data-rt-manual]').forEach((el) => {
      el.onclick = () => {
        // 族可能来自扫描结果（带 candidates）也可能来自族列表（带 detectedPath）
        const f = [...(scan ?? []), ...families].find((x) => x.id === el.dataset.rtManual);
        if (f) openAddRuntime(f);
      };
    });
    scheduleTaskPoll(dev); // 有安装任务在跑就接着盯（进度是服务端的事实）
  };
  render();
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
