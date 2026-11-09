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
 * 2026-11-08 单行气泡（用户："这个看着不好看，改成单行气泡刷日志更好看 ——
 *   重要的不是显示的是什么，是在动"）：
 *   · 多行卡（标题 + 阶段/步数 + 用时 + 摊开的步骤行）压成**一行**：日志写"此刻正在做
 *     的那件事"，新动作到了上滑换掉 —— 视觉重心从"读信息"换回"他还在动"；
 *   · 步数/用时/停止收到这一行的右端；卡住的原话（"最后动静 N 分钟前"）直接写进日志，
 *     不再另起一行；
 *   · 步骤明细没删：收尾后点这一行展开（任务卡页没有整页重画，那里还要能回看）。
 * 2026-11-08 二版（用户实拍："我的是这个效果，跟你的图不一样"）：
 *   · 一版只改皮、不换 DOM，卡片还 append 在正文气泡**里** —— 回话一长，那行就成了
 *     "小字标题"。二版曾把卡片挂在 `.bubble` **前面**（`.live-col` 下两颗兄弟泡），
 *     卡片自己才真的是一颗单行气泡；三版又收回同一颗泡里（见下）；
 *   · 日志不再无条件挂"最后一步"：只有真在跑、或 20 秒内刚落下去的工具才占这一行，
 *     否则报阶段（写回话 / 思考中）—— 以前模型早转去写回话了，这行还挂着上一个工具名。
 * 2026-11-08 三版（用户："单行气泡刷日志…真正的回复出来后代替这个单行日志气泡"）：
 *   · 胶囊就是**那颗泡**：chat.mjs 把它放进唯一一颗 `.bubble.live-line` 里，泡自己不画框；
 *     真正的回复一到，chat.mjs 移除胶囊、摘掉 .live-line —— 同一个元素原地变回话泡；
 *   · 日志内容优先级：报错/卡住 > 思考片段 > 正在跑的工具 > 阶段。思考不再另开灰字块，
 *     就刷这一行（原来的思考直播块随之退场）；2026-11-08 晚「思考过程」开关也退场了 ——
 *     这一行显示什么不重要、在动就行，不再留"内容显不显示"的配置给用户配。
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
      <span class="rp-dot"></span>
      <span class="rp-log"><span class="rp-phase">准备中</span></span>
      <span class="rp-meta"></span><span class="rp-time">00:00</span>
      <button type="button" class="rp-stop" title="停止生成" hidden>停止</button>
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
  /**
   * 日志行：只有**文字真变了**才换（2026-11-08）。
   * 每秒重画一次是给计时用的，不是刷新文案 —— 同一句话重放动画，看着像界面在抽。
   * 换的时候给新文字一个上滑淡入（.rp-roll）：胶囊高 32px、日志槽 overflow:hidden，
   * 文字从下往上钻出来，就是"日志又刷了一行"的体感；这比多写两行信息有用得多。
   */
  let lastLogText = '';
  /** 思考片段（三版）：thinking 事件到了就顶到日志行上，直到下一个工具/正文来把它换掉 */
  let note = '';
  const setLog = (text) => {
    // 收尾那一帧把日志槽换成了折叠按钮；万一又要画回运行态（重连重放之类的边角），
    // 把日志节点补回来，别让日志行整个消失
    const wrap = el.querySelector('.rp-log');
    if (wrap && !wrap.querySelector('.rp-phase')) {
      wrap.innerHTML = '<span class="rp-phase"></span>';
      lastLogText = '';
    }
    if (text === lastLogText) return;
    lastLogText = text;
    const n = el.querySelector('.rp-phase');
    if (!n) return;
    n.textContent = text;
    n.classList.remove('rp-roll');
    void n.offsetWidth; // 强制回流：同名类重加不会重播动画
    n.classList.add('rp-roll');
  };

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
    el.classList.toggle('error', !!v.error);

    /*
     * 只有"真的在跑"的工具有资格占这一行（2026-11-08 二版）：
     *   · currentStep = 有工具在跑，直接写它；
     *   · 没有在跑的工具时，最后一步必须在**20 秒内**落下去过 —— 否则模型已经转去写回话、
     *     想下一步了，这行还挂着上一个工具名，整块就像死在那儿
     *     （用户实拍：日志写着"调用工具"廿四秒不动，下面正文早就在一行行流了）。
     *     这时改报阶段（写回话 / 思考中），"在动"交给下面正在流的正文和呼吸点。
     * 卡住时把判断直接写进这一行（旧版它单独占一行，胶囊里没那个地方）。
     */
    const fresh = v.lastAgoMs == null || v.lastAgoMs < 20000;
    const live = v.currentStep || (v.phase === 'tool' && fresh ? v.lastStep : null);
    const actOf = (s) => `${s.verb}${s.target ? ` ${s.target}` : ''}`;
    /*
     * 这一行的内容优先级（2026-11-08 三版）：报错/卡住 > 思考片段 > 正在跑的工具 > 阶段词。
     * 用户口径："不一定是日志，可以是思考过程，可以是执行过程，显示什么不重要，在动就行" ——
     * 所以哪个最新就报哪个，不存在"该显示哪一个"的纠结。
     */
    let logText;
    if (v.stalled) logText = `可能卡住了 · 最后动静 ${fmtAgo(v.idleMs)}`;
    else if (note) logText = note;
    else if (live) logText = actOf(live);
    else if (v.elapsedMs > 60000) logText = '还没有输出，模型可能还在排队';
    else logText = v.phaseText;
    setLog(logText);
    // 意图（开场白）从标题降级成悬停提示：单行里它比"正在做的那件事"更长也更旧
    el.querySelector('.rp-phase').title = v.intent || logText;
    el.querySelector('.rp-time').textContent = fmtElapsed(v.elapsedMs);
    // 停止钮常驻（收尾才隐掉）：打断是第一类操作，不等卡住 5 分钟才给
    el.querySelector('.rp-stop').hidden = false;
    el.querySelector('.rp-meta').textContent = v.stepCount ? `${v.stepCount} 步` : '';

    const lastEl = el.querySelector('.rp-last');
    /*
     * 第二行只留给"说不清就不该丢"的两种：出错原因 / 运行时给的原话。
     * "最近动作"、"可能卡住了"、"一分钟没输出" 三个分支都进了上面那行日志 ——
     * 正常跑动时整块**恒为一行**，这是这次改版的本体。
     */
    let lastText = '';
    if (v.error) lastText = esc(v.error);
    else if (v.info) lastText = esc(v.info);
    lastEl.hidden = !lastText;
    lastEl.innerHTML = lastText;
    lastEl.classList.toggle('warn', v.stalled);

    // 明细运行中一律收起（2026-11-08 单行气泡）：胶囊只报"此刻在做什么"，
    // 想回看每步是收尾之后点胶囊的事 —— 也省掉每秒重画 8 行 DOM
    const stepsEl = el.querySelector('.rp-steps');
    stepsEl.hidden = true;
  };

  /**
   * 收尾 = 胶囊原地定格成「✓ 意图 · N 步 ⌄」，用时留在右侧，点展开每步。
   * 这一步只活在收尾到重画之间的那一瞬（聊天记录里**不再**持久化过程行，2026-11-08 v183）。
   */
  const paintFinished = (v) => {
    el.classList.remove('warn');
    el.classList.add('done');
    const bad = v.phase === 'error';
    el.classList.toggle('error', bad);
    const n = v.steps.length;
    const ico = bad ? '✗' : v.status === '已停止' ? '⏹' : '✓';
    const label = bad ? '出错了' : (v.intent && n ? clipEnds(v.intent, 30) : v.status || '已结束');
    const phCount = v.phases && v.phases.length >= 2 ? `${v.phases.length} 阶段 · ` : '';
    /*
     * 折叠头直接占日志槽（2026-11-08）：胶囊里没有第二行的位置。
     * 箭头留在尾巴里不拆行（跟卡片时代同一条纪律：标签可以省，步数/箭头必须完整）。
     */
    el.querySelector('.rp-log').innerHTML =
      `<button type="button" class="rp-fold" data-rp-fold><span class="rp-ic-t">${ico}</span>` +
      `<span class="rp-fold-t">${esc(label)}</span>` +
      `<span class="rp-fold-tail">${n ? `· ${phCount}${n} 步` : ''}<span class="rp-fold-arrow"></span></span></button>`;
    lastLogText = '';
    el.querySelector('.rp-time').textContent = fmtElapsed(v.elapsedMs);
    el.querySelector('.rp-stop').hidden = true;
    el.querySelector('.rp-meta').textContent = '';

    /*
     * 失败时错误原文**要露在明面上**（2026-11-08）：胶囊只有"✗ 出错了"五个字，
     * 原因折在明细里等于没说 —— 这条第二行是仅剩的例外，异常才破一次"恒为一行"。
     * 两级来源都认：运行级 error 事件，或者某一步自己的报错（codex 系多半只有后者）。
     */
    const errText = v.error || (v.steps.find((s) => s.error)?.error ?? '');
    const lastEl = el.querySelector('.rp-last');
    lastEl.innerHTML = errText ? `出错：${esc(errText)}` : '';
    lastEl.hidden = !errText;
    lastEl.classList.toggle('bad', !!errText);

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
  const applyEvent = (evt) => {
    applyRunEvent(progress, evt);
    /*
     * 思考片段进日志行（2026-11-08）：固定进 —— 这一行的职责是"看得见在动"，不挑内容。
     * 工具/正文一到就把这个临时覆盖清掉，回到执行过程。原始思维流也就活在这一行里，
     * 不再单独占版面（思考直播块与「思考过程」开关都已退场）。
     */
    if (evt && evt.type === 'thinking') {
      const t = String(evt.text ?? '').replace(/\s+/g, ' ').trim();
      if (t) note = '思考：' + clipEnds(t, 88);
    } else if (evt && (evt.type === 'tool' || evt.type === 'tool_call' || evt.type === 'text')) {
      note = '';
    }
    paint();
  };

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
