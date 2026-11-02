/*
 * voice.mjs —— 语音输入（2026-11-01）。
 *
 * 需求原话："像豆包手机版那样，语音输入转换成文字发送出去"。
 *
 * 这个文件只在**手机壳**里起作用：壳在 WebView 上注入了一个原生对象
 * `window.__BandiSpeech`（见 apps/mobile/gen/android/.../SpeechPlugin.kt），
 * 页面调它的 start/stop/cancel，它通过 `window.__bandiSpeechEvent` 回调我们。
 * 桌面浏览器里没有这个对象 —— 所以按钮根本不出现，`style.css` 也不用改。
 *
 * 为什么不让网页自己录音：业务页是 `http://192.168.x.x:18787`，非安全上下文，
 * `navigator.mediaDevices` 直接是 undefined。麦克风只有壳拿得到。
 *
 * 交互定稿（对着豆包抄的，只改了一处）：
 *   · 点麦克风开始，再点结束 —— 不是长按。长按在 WebView 里会撞上文本选择与
 *     长按菜单，而且说话时手指一直按着屏幕很别扭。
 *   · 边说边出字：中间结果直接写进输入框，你能看着它改（错的当场就能看出）。
 *   · 说完**不自动发送**。语音总有错字，直接发出去对方只看到错句 —— 留一次
 *     编辑的机会，这是和"语音条"最大的区别。
 */

import { $ } from './core.mjs';

/** 壳注入的原生对象名，与 SpeechPlugin.kt 的 addJavascriptInterface 一致 */
const BRIDGE = '__BandiSpeech';

const MIC_SVG = `<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor"
  stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/><path d="M12 18v3"/>
</svg>`;

/** idle | starting | listening | stopping —— 只用来说明"现在点一下该干嘛" */
let phase = 'idle';
/** 本次录音开始前输入框里的内容（取消时回退到它，识别时拼在它后面） */
let base = '';
/** 本次已经识别出来的文字（中间结果会反复覆盖它） */
let heard = '';

let btn = null;
let layer = null;
let timer = null;

const bridge = () => (typeof window[BRIDGE]?.start === 'function' ? window[BRIDGE] : null);

/** 点一下就能用；不是手机壳就什么都不做 */
export function mountVoice() {
  const b = bridge();
  if (!b) return;
  const input = $('input');
  const tools = document.querySelector('.input-tools');
  const send = $('send');
  if (!input || !tools || !send || $('voiceBtn')) return;

  btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'voiceBtn';
  btn.className = 'ghost voice-btn';
  btn.title = '语音输入';
  btn.setAttribute('aria-label', '语音输入');
  btn.setAttribute('aria-pressed', 'false');
  btn.innerHTML = MIC_SVG;
  // 放在「发送」左边：说完要点发送，两个拇指落点挨着
  tools.insertBefore(btn, send);
  btn.addEventListener('click', onTap);

  // 壳的回调口：Kotlin 侧 evaluateJavascript 调的就是这个名字
  window.__bandiSpeechEvent = onEvent;

  // 页面要走了（切会话 / 关 App）就别让麦克风继续开着
  window.addEventListener('pagehide', () => {
    if (phase !== 'idle') bridge()?.cancel();
  });
}

/* ---------------------------------------------------------------- 点击 */

function onTap() {
  if (phase === 'idle') begin();
  else if (phase === 'listening') end();
  else if (phase === 'starting') bridge()?.stop(); // 还在起，再点一下当放弃
}

function begin() {
  const b = bridge();
  if (!b) return;
  if (!b.available()) {
    flashError('这台手机没有语音引擎。装一个「语音服务」，或者先用键盘上的麦克风');
    return;
  }
  const input = $('input');
  if (!input) return;

  input.blur(); // 键盘会挡住浮层，也可能抢走音频焦点
  base = input.value;
  heard = '';
  phase = 'starting';
  btn.classList.add('is-on');
  btn.setAttribute('aria-pressed', 'true');
  openLayer();
  paintLayer('正在启动麦克风…');
  b.start();
  // 引擎被别的应用占着时可能既不报错也不回调，别让浮层永远转下去
  arm(6000, () => fail('麦克风没有响应，稍后再试'));
}

function end() {
  phase = 'stopping';
  paintLayer('正在整理…');
  bridge()?.stop();
  // stop 之后等 final；引擎偶尔不回报，5 秒后按已有的中间结果收尾
  arm(5000, () => finish());
}

function onEvent(e) {
  if (!e || !e.type) return;
  switch (e.type) {
    case 'listening':
    case 'ready':
      if (phase !== 'stopping') {
        phase = 'listening';
        arm(0);
        paintLayer(listeningTitle());
      }
      break;

    case 'partial':
      if (typeof e.text === 'string' && e.text) {
        heard = e.text;
        paintText();
        paintLayer(listeningTitle());
        // 波形只跟 rms 走 —— 拿 partial 顺手刷一下会把音量柱打回 1 根
      }
      break;

    case 'rms':
      bumpBars(e.level ?? 0);
      break;

    case 'final':
      if (typeof e.text === 'string' && e.text.trim()) heard = e.text.trim();
      paintText();
      finish();
      break;

    case 'error':
      fail(errorText(e.code));
      break;

    case 'cancelled':
      rollback();
      break;

    case 'permission':
      // 系统权限框已经弹出来了，等 Kotlin 侧轮询到「允许」自己接着开始
      paintLayer('等你在系统弹窗里点「允许」…');
      arm(0);
      break;

    /*
     * 壳判定内嵌识别用不了（国产 ROM 常见：录制权限给着，引擎仍回"权限不足"），
     * 自动改用系统语音输入面板。这一步不打断用户 —— 面板马上会盖上来，
     * 我们只把浮层文案换成实话，并把看门狗去掉（面板里说话可能要好几秒）。
     */
    case 'fallback':
      phase = 'listening';
      arm(0);
      paintLayer('改用系统语音输入…');
      break;

    case 'ui':
      phase = 'listening';
      arm(0);
      paintLayer('在系统面板里说完，文字会回到这里');
      break;

    default:
      break;
  }
}

/* ---------------------------------------------------------------- 文字 */

/** 中间结果实时写进输入框 —— 说话的人当场就能看出识别错没错 */
function paintText() {
  const input = $('input');
  if (!input) return;
  const sep = base && heard && !/\s$/.test(base) ? ' ' : '';
  input.value = heard ? base + sep + heard : base;
  // 走一遍 input 事件：自动高度、发送按钮可用态、@ 解析都挂在这上面
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function rollback() {
  const input = $('input');
  if (input) {
    input.value = base;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  close();
}

/** 正常收尾：文字留在输入框，**不自动发**，也不抢焦点（抢焦点会突然弹键盘） */
function finish() {
  const input = $('input');
  if (input && heard) {
    const sep = base && !/\s$/.test(base) ? ' ' : '';
    input.value = base + sep + heard;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  close();
}

function fail(msg) {
  rollback(); // 已经听到的半句也别留在框里，免得跟下一句拼在一起
  flashError(msg);
}

function close() {
  phase = 'idle';
  arm(0);
  heard = '';
  if (btn) {
    btn.classList.remove('is-on');
    btn.setAttribute('aria-pressed', 'false');
  }
  closeLayer();
}

/* ---------------------------------------------------------------- 浮层 */

function openLayer() {
  if (layer) return;
  layer = document.createElement('div');
  layer.className = 'voice-layer';
  layer.innerHTML = `
    <div class="voice-card" role="status">
      <span class="voice-dot" aria-hidden="true"></span>
      <div class="voice-bars" aria-hidden="true">
        <i></i><i></i><i></i><i></i><i></i>
      </div>
      <div class="voice-msg"></div>
      <button type="button" class="voice-x" aria-label="取消语音输入">取消</button>
    </div>`;
  layer.querySelector('.voice-x').addEventListener('click', () => {
    if (phase === 'idle') {
      closeLayer();
      return;
    }
    phase = 'stopping';
    bridge()?.cancel();
    close();
  });
  document.body.appendChild(layer);
  // 贴在输入条正上方：多行输入时输入条会变高，写死一个 bottom 会被盖住
  const composer = document.querySelector('.composer');
  const rect = composer?.getBoundingClientRect();
  const gap = window.innerHeight - (rect?.top ?? window.innerHeight - 80) + 10;
  layer.style.bottom = `${Math.max(12, gap)}px`;
  requestAnimationFrame(() => layer?.classList.add('is-open'));
}

function paintLayer(msg) {
  if (!layer) return;
  const el = layer.querySelector('.voice-msg');
  if (el && msg) el.textContent = msg;
}

function closeLayer() {
  const el = layer;
  layer = null;
  if (!el) return;
  el.classList.remove('is-open');
  el.classList.add('is-closing');
  setTimeout(() => el.remove(), 180);
}

/** 波形：按引擎报的音量档位（0..7）亮几根柱，够表达"在听、有声音" */
function bumpBars(level) {
  if (!layer) return;
  const bars = layer.querySelectorAll('.voice-bars i');
  const on = Math.max(1, Math.min(bars.length, Math.round((Number(level) / 7) * bars.length)));
  bars.forEach((b, i) => b.classList.toggle('on', i < on));
}

/** 出错时不需要波形和「取消」，换成一条能看懂的说明，2.6 秒自己收 */
function flashError(msg) {
  openLayer();
  layer?.classList.add('is-error');
  paintLayer(msg);
  arm(2600, () => closeLayer());
}

const listeningTitle = () =>
  heard ? '正在听…（说完点麦克风结束）' : '正在听…说完点麦克风结束';

/** 错误码 → 人话。码表见 SpeechPlugin.kt 的 codeName() */
function errorText(code) {
  switch (code) {
    case 'noEngine':
      return '这台手机没有语音引擎。装一个「语音服务」，或者先用键盘上的麦克风';
    case 'permission':
      return '没拿到麦克风权限 —— 到系统设置里给班底打开「麦克风」';
    case 'network':
      return '语音服务连不上网，检查一下 Wi-Fi';
    case 'noMatch':
      return '没听清，再说一次';
    case 'silence':
      return '没听到声音，靠近一点再说';
    case 'audio':
      return '麦克风被别的应用占着，关掉录音/通话再试';
    case 'busy':
      return '上一句还没结束，等一下再点';
    case 'client':
      // 壳里连着报 client 通常是系统的语音服务没被绑上（小米把「语音输入」关掉时就这样）
      return '系统的语音服务没响应 —— 到手机设置里开启「语音输入」再试';
    case 'engineMic':
      /*
       * 这是实测出来的真实故障：手机的语音引擎（小米是"语音引擎/小爱语音"）自己
       * 没有麦克风权限，于是任何应用调它都被回"权限不足"，系统面板一弹就关。
       * 不给出去哪儿开，用户只会看到闪一下 —— 所以这条文案必须写具体的路径。
       */
      return '手机的语音引擎没有麦克风权限 —— 到系统设置里给它打开';
    case 'server':
      return '语音服务出错了，稍后再试';
    default:
      return '识别失败，再说一次';
  }
}

/* ---------------------------------------------------------------- 超时 */

function arm(ms, fn) {
  if (timer) clearTimeout(timer);
  timer = null;
  if (ms > 0 && fn) timer = setTimeout(fn, ms);
}
