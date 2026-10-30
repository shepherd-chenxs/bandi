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
 */
import { esc } from './shell.mjs';
import { applyRunEvent, createRunProgress, fmtAgo, fmtElapsed, fmtStepDur, progressView } from './run-progress.mjs';

export function createProgressCard({ startedAt = Date.now(), onStop = null } = {}) {
  const progress = createRunProgress({ startedAt: Number.isFinite(startedAt) ? startedAt : Date.now() });

  const el = document.createElement('div');
  el.className = 'rp';
  el.dataset.rp = '';
  el.innerHTML = `
    <div class="rp-head">
      <span class="rp-dot"></span><span class="rp-phase">准备中</span>
      <span class="rp-meta"></span><span class="rp-time">00:00</span>
    </div>
    <div class="rp-last" hidden></div>
    <div class="rp-steps"></div>`;

  /** 一张工具卡片：第几步、干了什么、多久/成败 */
  const stepHtml = (s) => {
    const ic = s.status === 'done' ? '✓' : s.status === 'error' ? '✗' : s.status === 'running' ? '◌' : s.status === 'waiting' ? '◌' : '·';
    // waiting = 整条运行已经卡住了：不再写"进行中 1237s"，改成"已等 N 分钟"（配合头顶的"可能卡住了"）
    const fmtWait = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)} 分钟` : `${Math.max(1, Math.round(ms / 1000))} 秒`);
    const dur = s.durMs == null
      ? ''
      : s.status === 'running' ? `<span class="rp-dur">进行中 ${fmtStepDur(s.durMs)}</span>`
      : s.status === 'waiting' ? `<span class="rp-dur">已等 ${fmtWait(s.durMs)}</span>`
      : `<span class="rp-dur">${fmtStepDur(s.durMs)}</span>`;
    const err = s.error ? `<span class="rp-err">${esc(s.error)}</span>` : '';
    // 卡片里那行会被截断（长命令），title 留全量 —— 悬停能看全，不占版面
    const act = `${s.verb}${s.target ? ` ${s.target}` : ''}`;
    return `<div class="rp-step ${esc(s.status)}">
      <span class="rp-ic">${ic}</span>
      <span class="rp-n">第 ${s.n} 步</span>
      <span class="rp-act" title="${esc(act)}">${esc(s.verb)}${s.target ? ` <code>${esc(s.target)}</code>` : ''}</span>
      ${dur}${err}
    </div>`;
  };

  /** 画一帧（调用方每秒也走一次：总用时、单步耗时、"多久没动静"都靠它） */
  const paint = () => {
    const v = progressView(progress, Date.now());
    el.classList.toggle('warn', v.stalled);
    el.classList.toggle('done', v.done);
    el.querySelector('.rp-phase').textContent =
      v.stalled ? '可能卡住了' : v.done ? (v.status || '已结束') : v.phaseText;
    el.querySelector('.rp-time').textContent = fmtElapsed(v.elapsedMs);
    const meta = [];
    if (v.stepCount) meta.push(`${v.stepCount} 步`);
    if (v.stalled && !v.done) meta.push(`最后动静 ${fmtAgo(v.idleMs)}`);
    else if (v.currentStep) meta.push('进行中');
    el.querySelector('.rp-meta').textContent = meta.join(' · ');

    const lastEl = el.querySelector('.rp-last');
    let lastText = '';
    if (v.stalled && !v.done) {
      // 卡住时把"停止生成"直接摆在眼前（顶部提示 + 底部按钮都要滚才能看到，人第一反应找不到）
      lastText = `可能卡住了：最后动静 ${fmtAgo(v.idleMs)}${v.lastAction ? `（${v.lastAction}）` : ''} —— 可以再等等，或 <button type="button" class="rp-stop">停止生成</button>`;
    } else if (v.error) {
      lastText = esc(v.error);
    } else if (v.lastAction) {
      lastText = esc(`最近动作：${v.lastAction}（${fmtAgo(v.lastAgoMs)}）`);
    } else if (v.info) {
      lastText = esc(v.info);
    } else if (!v.done && v.elapsedMs > 60000) {
      // 一分多钟还没任何输出：模型首包本来就慢，但得让人知道不是界面坏了
      lastText = '还没有任何输出（模型还在想，或者运行时在排队）';
    }
    lastEl.hidden = !lastText;
    lastEl.innerHTML = lastText;
    lastEl.classList.toggle('warn', v.stalled && !v.done);

    const stepsEl = el.querySelector('.rp-steps');
    const shown = v.steps.slice(-8);
    stepsEl.innerHTML =
      (v.steps.length > 8 ? `<div class="rp-more">…前 ${v.steps.length - 8} 步已折叠</div>` : '') +
      shown.map(stepHtml).join('');
  };

  // 卡住行里那颗「停止生成」：调用方传 onStop，这颗钮就走哪个接口
  el.addEventListener('click', (e) => {
    if (!e.target.closest('.rp-stop')) return;
    e.preventDefault();
    onStop?.();
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
