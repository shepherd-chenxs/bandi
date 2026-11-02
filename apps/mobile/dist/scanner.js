/*
 * scanner.js —— 摄像头扫二维码（2026-11）。
 *
 * 只做一件事：开相机 → 逐帧丢给 jsQR 解码 → 解到 http(s) 链接就回调、停流、收工。
 * 拿到的东西不在这里判断"是不是班底"（那是 Rust 侧 probe 的活），这里只滤掉
 * 明显不是链接的码（付款码、名片码之类），免得对着错的码一直没反应。
 *
 * 为什么走 WebView 相机而不是原生插件：
 *   · wry 的 RustWebChromeClient.onPermissionRequest 默认放行 VIDEO_CAPTURE，
 *     并代我们请求 Android 的 CAMERA 运行时权限 —— 原生侧一行不用写；
 *   · 本页 origin 是 http://tauri.localhost，属于 secure context，getUserMedia
 *     在 Android WebView 里可用（远程业务页 http://192.168.x.x 不行，所以扫码
 *     只在这里做，只能在这里做）；
 *   · 代价是解码得自己扛：dist/vendor/jsQR.js（vendored，见该文件头）。
 *
 * 两个坑：
 *   · 一定要在回调之前 stop 掉所有 track —— 回调会 navigate 走，旧文档被销毁，
 *     流不停就一直占着相机（下次打开黑屏、耗电）；
 *   · 解码别每帧跑：720 长边 + 180ms 间隔，够快也不烫手。
 */
(() => {
  const $ = (id) => document.getElementById(id);

  /** 解码间隔（ms）。60fps 全解没必要，二维码不会跑。 */
  const DECODE_EVERY = 180;
  /** 送进解码器的最大边长。手机 1080p 帧直接解要 ~200ms，缩到 720 差不多 40ms。 */
  const MAX_EDGE = 720;
  /** 解到非链接码时的提示节流（同一张错码别每 180ms 闪一次） */
  const MISS_COOLDOWN = 1500;
  const HINT_IDLE = '对准电脑上的二维码';

  let stream = null;
  let timer = 0;
  let running = false;
  let onHit = null;
  let canvas = null;
  let ctx = null;
  let missAt = 0;

  function hint(text, kind) {
    const el = $('scanMsg');
    if (!el) return;
    el.textContent = text;
    el.className = 'scan-msg' + (kind ? ' ' + kind : '');
  }

  function stopStream() {
    if (stream) {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          /* 停不掉也要把引用丢掉，别让它继续持有相机 */
        }
      }
      stream = null;
    }
    const video = $('scanVideo');
    if (video) video.srcObject = null;
  }

  /** 收工：停流 + 停循环 + 收起遮罩。**任何**退出路径都要走这里。 */
  function shutdown() {
    running = false;
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
    stopStream();
    const box = $('scan');
    if (box) box.hidden = true;
  }

  function cameraError(e) {
    const name = e && e.name;
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      return '相机权限被拒绝 —— 到系统设置里允许班底使用相机，或者切到「邀请码」手输';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return '这台设备没有可用的摄像头';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return '相机被别的应用占着，关掉它再试';
    }
    return '相机打不开：' + (name || '') + ' ' + ((e && e.message) || '');
  }

  function decodeOnce() {
    const video = $('scanVideo');
    if (!video || video.readyState < 2 || !video.videoWidth) return;
    if (!canvas) {
      canvas = document.createElement('canvas');
      ctx = canvas.getContext('2d', { willReadFrequently: true });
    }
    if (!ctx) return;

    const scale = Math.min(1, MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
    const w = Math.max(1, Math.round(video.videoWidth * scale));
    const h = Math.max(1, Math.round(video.videoHeight * scale));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    ctx.drawImage(video, 0, 0, w, h);

    const img = ctx.getImageData(0, 0, w, h);
    const found = window.jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
    if (!found || !found.data) return;

    const text = String(found.data).trim();
    if (!text) return;
    // 配对链接就是 `http://<ip>:<port>/pair?token=...`（pairing.mjs 画的码）。
    // 不是链接的码直接忽略，别把用户吓成"扫坏了"。
    if (!/^https?:\/\//i.test(text)) {
      if (Date.now() - missAt > MISS_COOLDOWN) {
        missAt = Date.now();
        hint('这不是班底的配对码，换电脑上那张', 'bad');
      }
      return;
    }

    const cb = onHit;
    onHit = null;
    shutdown();
    if (cb) cb(text);
  }

  function tick() {
    if (!running) return;
    try {
      decodeOnce();
    } catch {
      /* 单帧解不出来不是错（模糊、反光、刚开镜头），下一帧继续 */
    }
    if (!running) return;
    timer = setTimeout(tick, DECODE_EVERY);
  }

  /**
   * 打开扫码。`handler(url)` 在解到 http(s) 链接时调用一次（此时相机已关）。
   * 相机起不来时抛错，由调用方决定怎么提示 —— 这里不碰页面的状态条。
   */
  async function open(handler) {
    if (running) return;
    if (!window.jsQR) throw new Error('解码库没加载（dist/vendor/jsQR.js 丢了）');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('这个 WebView 不支持调用相机');
    }

    const box = $('scan');
    if (!box) throw new Error('扫码界面缺了（dist/index.html 少 #scan）');
    const video = $('scanVideo');

    hint(HINT_IDLE);
    missAt = 0;
    box.hidden = false;

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
    } catch (e) {
      box.hidden = true;
      throw new Error(cameraError(e));
    }

    video.srcObject = stream;
    try {
      await video.play();
    } catch {
      /* 有的 ROM 拒 autoplay，但 muted + 用户手势下一般能播；真不播就等下一帧再说 */
    }

    onHit = handler;
    running = true;
    tick();
  }

  function close() {
    onHit = null;
    shutdown();
  }

  document.addEventListener('DOMContentLoaded', () => {
    const cancel = $('scanCancel');
    if (cancel) cancel.addEventListener('click', close);
  });

  // 页面被顶掉（navigate / 切后台杀掉）时兜底停流
  window.addEventListener('pagehide', close);

  window.BandiScan = { open, close };
})();
