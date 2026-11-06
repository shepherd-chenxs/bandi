/* run-progress-card.mjs —— 运行进度卡（.rp）的 **DOM 这一层**。
 *
 * 背景（2026-10-29 用户在任务卡页实报）："这里只看到嘉辉在跑，看不到是不是卡了。
 * 对话里的那一套搬过来用" —— 聊天页 2026-10-26 就有那块进度卡（阶段 + 第几步 +
 * 总用时 + 最近动作 + 工具卡片 + 卡住时把「停止生成」摆到眼前），但那段画卡片的
 * 代码长在 chat.mjs 的 attachStream 里，任务卡页的讨论区只有三个点。
 *
 * 拆出来 = 两处共用同一份："对话场景只写一遍" 是这个代码库的老规矩，各写一份
 * 迟早走样（改一处漏一处）。纯逻辑仍在 run-progress.mjs（冒烟能在 Node 里测），
 * 这里只管把那份状态画成 DOM。
 *
 * 用法：
 *   const card = createProgressCard({ startedAt, onStop: () => ... });
 *   host.appendChild(card.el);
 *   card.applyEvent(evt);            // 每个原始事件（SSE onEvent）
 *   card.paint();                    // 每秒重画一次（用时/耗时/卡住判定都靠它）
 *   card.finish(status);             // 收尾时定格"完成/停止/失败"
 *   clearInterval(tick);             // 收尾后记得停表
 *
 * 2026-11-05 评鉴落地（把"运行日志的摘要"改成"任务票据"）：
 *   · **意图做标题** —— 模型开场那句"我先看仓库结构，再数代码量"是唯一用户看得懂、
 *     还预告了后面还有几步的信息，拿来当标题；"调用工具"这种机器词退居后备。
 *   · **停止钮常驻右上** —— 不等卡住 5 分钟才出现；打断是第一类操作。
 *   · **"最近动作"行并进步骤列表** —— 那行本来就是最后一步的复读，一步时整行重复。
 *   · **运行中的步骤只转圈不跳秒** —— 秒数每秒跳是注意力黑洞，完成时打点就够。
 *   · **收尾收起成一行** —— "✓ 意图 · N 步 · 用时 ▾"，点开看每步；任务卡页没有
 *     整页重画，以前收尾整卡定格摊开，dead 卡片一直占地方。
 * 2026-11-05 二期（阶段分组）：
 *   · 工具之间的正文是模型对下一批工具的预告（"官方库没有，去社区搜"），拿它当
 *     **阶段标题** —— 步骤列表从命令流水账变成"读手册 → 查官方库 → 搜社区"；
 *     分不出阶段（全程没说话）平铺老路，不为分组硬编故事。分组逻辑在
 *     run-progress.mjs 的 phaseGroups/withPhases（纯逻辑，冒烟能测）。
 */
import { esc } from './shell.mjs';
import { applyRunEvent, clipEnds, createRunProgress, fmtAgo, fmtElapsed, fmtStepDur, progressView } from './run-progress.mjs';

export function createProgressCard({ startedAt = Date.now(), onStop = null } = {}) {
  const progress = createRunProgress({ startedAt: Number.isFinite(startedAt) ? startedAt : Date.now() });

  const el = document.createElement('div');
  el.className = 'rp';
  el.dataset.rp = '';
  el.innerHTML = `
    <div class="rp-head">
      <span class="rp-dot"></span><span class="rp-phase">准备中</span>
      <span class="rp-meta"></span><span class="rp-time">00:00</span>
      <button type="button" class="rp-stop" title="停止生成" hidden>■ 停止</button>
    </div>
    <div class="rp-last" hidden></div>
    <div class="rp-steps"></div>`;

  /** 一张工具卡片：第几步、干了什么、多久/成败 */
  const stepHtml = (s, grouped = false) => {
    const ic = s.status === 'done' ? '✓' : s.status === 'error' ? '✗' : s.status === 'running' ? '◌' : s.status === 'waiting' ? '◌' : '·';
    // waiting = 整条运行已经卡住了：不再写"进行中 1237s"，改成"已等 N 分钟"（配合头顶的"可能卡住了"）
    const fmtWait = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)} 分钟` : `${Math.max(1, Math.round(ms / 1000))} 秒`);
    // 运行中不显示秒数：◌ 的脉冲本身就是状态，"进行中 Ns"每秒往上跳是注意力黑洞（2026-11-05 评鉴）
    const dur = s.durMs == null
      ? ''
      : s.status === 'running' ? ''
      : s.status === 'waiting' ? `<span class="rp-dur">已等 ${fmtWait(s.durMs)}</span>`
      : `<span class="rp-dur">${fmtStepDur(s.durMs)}</span>`;
    const err = s.error ? `<span class="rp-err">${esc(s.error)}</span>` : '';
    // 卡片里那行会被截断（长命令），title 留全量 —— 悬停能看全，不占版面
    const act = `${s.verb}${s.target ? ` ${s.target}` : ''}`;
    // 按阶段分组时（2026-11-05 二期）不摆"第 N 步"—— 段头的"N 步"已经给了量级，
    // 全局序号在分段视图里反而是要人换算的负担
    const n = grouped ? '' : `<span class="rp-n">第 ${s.n} 步</span>`;
    return `<div class="rp-step ${esc(s.status)}">
      <span class="rp-ic">${ic}</span>
      ${n}
      <span class="rp-act" title="${esc(act)}">${esc(s.verb)}${s.target ? ` <code>${esc(s.target)}</code>` : ''}</span>
      ${dur}${err}
    </div>`;
  };

  /**
   * 步骤列表的 HTML（进行中和收尾展开共用同一份画法）。
   * 分得出来阶段（模型在工具之间说过话）就按段画：段头一句人话 + "N 步"，
   * 13 条命令流水账变成"读手册 → 查官方库 → 搜社区"能念的顺序；分不出来平铺老路。
   */
  const stepsHtml = (v) => {
    if (v.phases && v.phases.length >= 2) {
      return v.phases
        .map((g) => {
          const t = g.title || '调用工具';
          const rows = v.steps.slice(g.i, g.i + g.n).map((s) => stepHtml(s, true)).join('');
          return `<div class="rp-ph"><span class="rp-ph-t" title="${esc(g.raw || t)}">${esc(t)}</span><span class="rp-ph-n">${g.n} 步</span></div>${rows}`;
        })
        .join('');
    }
    const shown = v.steps.slice(-8);
    return (
      (v.steps.length > 8 ? `<div class="rp-more">…前 ${v.steps.length - 8} 步已折叠</div>` : '') +
      shown.map((s) => stepHtml(s)).join('')
    );
  };

  /** 画一帧（调用方每秒也走一次：总用时、单步耗时、"多久没动静"都靠它） */
  let finishedPainted = false;
  const paint = () => {
    const v = progressView(progress, Date.now());
    if (v.done) {
      // 收尾画过一帧就冻结 —— 每秒重画会把人点开的明细又收回去
      if (finishedPainted) return;
      finishedPainted = true;
      return paintFinished(v);
    }
    finishedPainted = false;
    el.classList.toggle('warn', v.stalled);
    el.classList.toggle('done', false);

    const phaseEl = el.querySelector('.rp-phase');
    /*
     * 意图做标题（2026-11-05）：有意图且已经开跑工具才顶替机器词 ——
     * 纯聊天（还没调工具）时正文正在下面流，标题再念一遍就是同一句话说两遍。
     */
    const showIntent = !!(v.intent && v.stepCount);
    phaseEl.textContent = showIntent ? v.intent : v.stalled ? '可能卡住了' : v.phaseText;
    phaseEl.title = showIntent ? v.intent : '';
    el.querySelector('.rp-time').textContent = fmtElapsed(v.elapsedMs);
    // 停止钮常驻（收尾才隐掉）：打断是第一类操作，不等卡住 5 分钟才给
    el.querySelector('.rp-stop').hidden = false;
    const meta = [];
    if (v.stepCount) {
      // 分得出来阶段时连段数一起报 —— "3 阶段 · 13 步"比光秃秃的"13 步"更像在说一件事
      const phased = v.phases && v.phases.length >= 2;
      meta.push(phased ? `${v.phases.length} 阶段 · ${v.stepCount} 步` : `${v.stepCount} 步`);
    }
    if (v.stalled) meta.push(`最后动静 ${fmtAgo(v.idleMs)}`);
    el.querySelector('.rp-meta').textContent = meta.join(' · ');

    const lastEl = el.querySelector('.rp-last');
    let lastText = '';
    /*
     * "最近动作"行撤了（2026-11-05）：那行拼的就是最后一步（progressView 的 lastAction），
     * 下面步骤列表里就有它 —— 只有一步时整行复读。留三个真正有信息量的分支：
     * 卡住 / 出错 / 一分钟没动静。
     */
    if (v.stalled) {
      // 停止钮已经在右上常驻，这里只把话说到：可以再等等
      lastText = `可能卡住了：最后动静 ${fmtAgo(v.idleMs)}${v.lastAction ? `（${v.lastAction}）` : ''} —— 可以再等等，要停就点右上角`;
    } else if (v.error) {
      lastText = esc(v.error);
    } else if (v.info) {
      lastText = esc(v.info);
    } else if (v.elapsedMs > 60000) {
      // 一分多钟还没任何输出：模型首包本来就慢，但得让人知道不是界面坏了
      lastText = '还没有任何输出（模型还在想，或者运行时在排队）';
    }
    lastEl.hidden = !lastText;
    lastEl.innerHTML = lastText;
    lastEl.classList.toggle('warn', v.stalled);

    const stepsEl = el.querySelector('.rp-steps');
    stepsEl.hidden = false;
    stepsEl.innerHTML = stepsHtml(v);
  };

  /**
   * 收尾 = 收起成一行（2026-11-05）："✓ 意图 · N 步 · 用时 ▾"，点开看每步。
   * 以前收尾把整卡定格摊开 —— 聊天页 300ms 后整页重画把它抹掉还好，
   * 任务卡页没有重画，dead 卡片就一直占地方。收起行跟聊天记录里持久化的
   * 那一行（meta.progress，见 chat.mjs 的 progressNoteHtml）是同一个形状。
   */
  const paintFinished = (v) => {
    el.classList.toggle('warn', false);
    el.classList.toggle('done', true);
    const phaseEl = el.querySelector('.rp-phase');
    phaseEl.textContent = v.status || '已结束';
    phaseEl.title = '';
    el.querySelector('.rp-time').textContent = fmtElapsed(v.elapsedMs);
    el.querySelector('.rp-stop').hidden = true;
    el.querySelector('.rp-meta').textContent = '';

    const lastEl = el.querySelector('.rp-last');
    const n = v.steps.length;
    const ico = v.phase === 'error' ? '✗' : v.status === '已停止' ? '⏹' : '✓';
    const label = v.intent && n ? clipEnds(v.intent, 48) : v.status || '已结束';
    const phCount = v.phases && v.phases.length >= 2 ? `${v.phases.length} 阶段 · ` : '';
    lastEl.innerHTML =
      `<button type="button" class="rp-fold" data-rp-fold>${ico} ${esc(label)}` +
      // "· N 步 · 用时 ▾"包成一个不拆行的尾巴（2026-11-05）：标签可以换行，
      // 步数/用时断在 token 中间是挤竖的另一种丑法 —— 跟头部 rp-meta/rp-time 同一条纪律
      `<span class="rp-fold-tail">${n ? ` · ${phCount}${n} 步` : ''} · ${fmtElapsed(v.elapsedMs)}<span class="rp-fold-arrow"></span></span></button>`;
    lastEl.hidden = false;
    lastEl.classList.toggle('warn', false);

    const stepsEl = el.querySelector('.rp-steps');
    // 步骤按**收尾时刻**重画一遍再收起来 —— 上一帧可能还没等到最后一步的结果
    stepsEl.innerHTML =
      (v.error ? `<div class="rp-err">${esc(v.error)}</div>` : '') + stepsHtml(v);
    stepsEl.hidden = true;
  };

  // 两类点击：右上那颗常驻「停止」走 onStop；收尾那行折叠头管展开/收起明细
  el.addEventListener('click', (e) => {
    if (e.target.closest('.rp-stop')) {
      e.preventDefault();
      onStop?.();
      return;
    }
    const fold = e.target.closest('[data-rp-fold]');
    if (!fold) return;
    const stepsEl = el.querySelector('.rp-steps');
    stepsEl.hidden = !stepsEl.hidden;
    // 箭头只切类：CSS 里 mask 的 chevron 转 -90°=收起朝右 / 0°=展开朝下（2026-11-05 用户拍板方向）
    const arrow = fold.querySelector('.rp-fold-arrow');
    if (arrow) arrow.classList.toggle('is-open', !stepsEl.hidden);
  });

  /** 每个原始事件喂进来（SSE 的 onEvent 原样转发即可） */
  const applyEvent = (evt) => { applyRunEvent(progress, evt); paint(); };

  /** 收尾定格："完成 / 已停止 / 失败 + 状态"，之后调用方自己停表 */
  const finish = (status) => {
    progress.done = true;
    progress.status = status;
    progress.phase = status === '失败' ? 'error' : 'done';
    paint();
  };

  paint();
  return { el, paint, applyEvent, finish };
}
