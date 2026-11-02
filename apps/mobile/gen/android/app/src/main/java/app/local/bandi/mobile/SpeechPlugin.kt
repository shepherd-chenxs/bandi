package app.local.bandi.mobile

/*
 * SpeechPlugin.kt —— 语音输入（2026-11-01）。
 *
 * 为什么这件事只能壳来做：业务页跑在 `http://192.168.x.x:18787`（远端 origin），
 * 对 Chromium 来说不是安全上下文 —— `navigator.mediaDevices` 是 undefined、
 * WebView 也没有 `webkitSpeechRecognition`。所以麦克风与识别都必须由壳提供，
 * 识别出来的文字再交给页面。
 *
 * 桥怎么搭的（**故意不走 Tauri 的 IPC**）：
 *   · 页面 → 壳：`webView.addJavascriptInterface(..., "__BandiSpeech")`，
 *     页面直接 `window.__BandiSpeech.start()`。这条路不受 Tauri capability / ACL
 *     约束，也不要求 remote url 授权，远端 http 页面上照样能用。
 *   · 壳 → 页面：`evaluateJavascript` 调 `window.__bandiSpeechEvent({...})`。
 *
 * 用系统引擎（`SpeechRecognizer`）而不是自己录音上传：免费、可离线、中文质量在
 * 国产 ROM 上够用，而且 `onPartialResults` 能拿到中间结果 —— 可以边说边出字。
 * 代价是个别机型需要下载语音包（`isRecognitionAvailable()` 为 false 时如实报错）。
 *
 * ⚠️ 这文件在 `gen/android` 里，是**手写**的：重新 `tauri android init` 会丢，
 *    要重新贴回来（同 Manifest 里的相机权限，见 apps/mobile/README.md）。
 */

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.speech.RecognitionListener
import android.speech.RecognitionService
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Plugin
import org.json.JSONObject

@TauriPlugin
class SpeechPlugin(activity: Activity) : Plugin(activity) {

  private val ctx: Activity = activity
  private val main = Handler(Looper.getMainLooper())

  private var webView: WebView? = null
  private var recognizer: SpeechRecognizer? = null

  /**
   * 内嵌识别已经证明用不了（这台 ROM 的引擎不接第三方）—— 之后每次直接走系统面板。
   * 小米就是这种：绑得上 `com.xiaomi.mibrain.speech/.asr.AsrService`，但一 start 就回
   * `ERROR_INSUFFICIENT_PERMISSIONS`（录制权限明明是给着的，是它自己的白名单在拦）。
   */
  private var inlineBroken = false
  /** 系统识别面板正在前台（避免用户连点两次弹出两层） */
  private var uiPending = false
  /** 面板刚拉起的时刻，用来看它是不是"一弹就关" */
  private var uiOpenedAt = 0L

  init {
    current = this
  }

  /** 本次是「取消」结束的（上滑取消）：`onResults` 后不要当成功结果交出去 */
  private var cancelled = false
  /** 上一次发出去的音量档位，用来给 `onRmsChanged` 节流 */
  private var lastRmsSlot = -99
  /** 权限被拒后正在等用户点「允许」——避免重复弹窗 */
  private var waitingPermission = false

  override fun load(webView: WebView) {
    this.webView = webView
    /*
     * 接口名固定 `__BandiSpeech`，页面（apps/web/js/voice.mjs）按名字探测。
     * 注入发生在 WebView 创建时，早于任何页面导航 —— 所以从启动页 replace 到
     * 远端业务页之后这个对象仍在。
     */
    try {
      webView.addJavascriptInterface(Bridge(), "__BandiSpeech")
    } catch (t: Throwable) {
      // 极少数 ROM 上已注入过会抛；同一个 WebView 只 load 一次，正常不会走到这
    }
  }

  /* ------------------------------------------------------------ 页面的入口 */

  private inner class Bridge {
    @JavascriptInterface
    fun available(): Boolean = SpeechRecognizer.isRecognitionAvailable(ctx)

    @JavascriptInterface
    fun hasPermission(): Boolean = granted()

    @JavascriptInterface
    fun start() {
      main.post { startListening() }
    }

    @JavascriptInterface
    fun stop() {
      main.post { stopListening() }
    }

    @JavascriptInterface
    fun cancel() {
      main.post { cancelListening() }
    }
  }

  /* ------------------------------------------------------------ 识别 */

  private fun granted(): Boolean =
    ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) ==
      PackageManager.PERMISSION_GRANTED

  private fun startListening() {
    if (!granted()) {
      // 首次：弹系统权限框，然后轮询等用户点「允许」——点一下就能开始，不必再按一次
      if (!waitingPermission) {
        waitingPermission = true
        ActivityCompat.requestPermissions(ctx, arrayOf(Manifest.permission.RECORD_AUDIO), REQ_AUDIO)
        emit("permission", "asked" to true)
        pollPermission(0)
      }
      return
    }
    if (!SpeechRecognizer.isRecognitionAvailable(ctx)) {
      inlineBroken = true
      openSystemUi()
      return
    }
    if (inlineBroken) {
      openSystemUi()
      return
    }
    cancelled = false
    lastRmsSlot = -99
    if (recognizer == null) {
      recognizer = createRecognizer()
    }
    if (recognizer == null) {
      emit("error", "code" to "noEngine")
      return
    }
    try {
      recognizer?.startListening(intentForSpeech())
      emit("listening")
    } catch (t: Throwable) {
      // 「已经有一个识别在跑」之类的会抛 —— 报上去让页面把浮层收掉
      emit("error", "code" to "busy", "detail" to (t.message ?: "start 失败"))
    }
  }

  /* ------------------------------------------------------------ 系统识别面板 */

  /**
   * 兜底路线：拉起系统的「语音输入」界面，由**它**去调引擎。
   *
   * 为什么需要它：`SpeechRecognizer` 是"应用自己连引擎"，而国产 ROM（小米实测）对
   * 第三方应用连自家 ASR 有白名单，绑得上、一 start 就回 `ERROR_INSUFFICIENT_PERMISSIONS`。
   * 系统面板不一样 —— 识别发生在系统应用里，天然有权限；`RECOGNIZE_SPEECH` 在本机
   * 解析到 `com.xiaomi.mibrain.speech/.asr.AsrActivity`。
   *
   * 代价：拿不到中间结果（文字由系统面板自己滚动显示），松手后才把整句回传。
   * 所以只在"内嵌识别确实用不了"时才走这条，不是主路。
   */
  private fun openSystemUi() {
    if (uiPending) return
    uiPending = true
    cancelled = false
    try {
      ctx.startActivityForResult(intentForSpeech(), REQ_SPEECH_UI)
      uiOpenedAt = SystemClock.elapsedRealtime()
      Log.i(TAG, "改用系统语音输入面板")
      emit("ui")
    } catch (t: Throwable) {
      uiPending = false
      Log.w(TAG, "系统面板也拉不起来", t)
      emit("error", "code" to "noEngine", "detail" to (t.message ?: "没有语音输入界面"))
    }
  }

  /** MainActivity.onActivityResult 转进来的（Tauri 的 Plugin 基类不转发） */
  private fun onSpeechUiResult(requestCode: Int, resultCode: Int, data: Intent?) {
    if (requestCode != REQ_SPEECH_UI) return
    uiPending = false
    if (resultCode != Activity.RESULT_OK) {
      /*
       * 面板"一弹就关"（不到 2 秒）不是用户取消 —— 是它自己也起不来。
       * 实测小米：`com.xiaomi.mibrain.speech` 自身的 RECORD_AUDIO 是 denied，
       * 它录不了音，于是任何调用方都被回成"权限不足"，面板随之立刻 finish。
       * 这种要告诉用户去哪儿开，不然只会看到闪一下什么都没有。
       */
      val quick = SystemClock.elapsedRealtime() - uiOpenedAt < 2000
      Log.i(TAG, "系统面板取消（quick=$quick）")
      if (quick) emit("error", "code" to "engineMic") else emit("cancelled")
      return
    }
    val texts = data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
    val text = texts?.firstOrNull()?.trim().orEmpty()
    Log.i(TAG, "系统面板返回：${text.take(40)}")
    if (text.isEmpty()) emit("error", "code" to "noMatch") else emit("final", "text" to text)
  }

  /* ------------------------------------------------------------ 找识别服务 */

  /**
   * 造一个识别器，**显式绑到具体的服务组件**。
   *
   * 为什么不能只写 `SpeechRecognizer.createSpeechRecognizer(ctx)`：那个重载会去读
   * `Settings.Secure.VOICE_RECOGNITION_SERVICE`。小米 HyperOS 上这个值是 **null**
   * （实测 `adb shell settings get secure voice_recognition_service` 返回 null），
   * 于是它内部打出 `E SpeechRecognizer: no selected voice recognition service`，
   * 之后每次 `startListening()` 都立刻回调 `ERROR_CLIENT(5)` —— 用户看到的就是一句
   * 「识别失败」。而系统里其实装着小爱的 `com.xiaomi.mibrain.speech.asr.AsrService`，
   * 只是没人把这个设置填上。
   *
   * 所以自己找：先看系统设置指定了谁（填了就用它），没填就去查所有声明了
   * `RecognitionService` 的组件，取第一个可用的，用双参重载显式绑定。
   */
  private fun createRecognizer(): SpeechRecognizer? {
    val cn = resolveServiceComponent()
    Log.i(TAG, "识别服务 = ${cn?.flattenToShortString() ?: "(未找到，退回系统默认)"}")
    val r = try {
      if (cn != null) SpeechRecognizer.createSpeechRecognizer(ctx, cn)
      else SpeechRecognizer.createSpeechRecognizer(ctx)
    } catch (t: Throwable) {
      Log.w(TAG, "按组件创建失败，退回默认重载", t)
      try {
        SpeechRecognizer.createSpeechRecognizer(ctx)
      } catch (_: Throwable) {
        null
      }
    }
    return r?.also { it.setRecognitionListener(listener) }
  }

  private fun resolveServiceComponent(): ComponentName? {
    val pm = ctx.packageManager
    // ① 系统设置里填了就用它
    val configured = Settings.Secure.getString(ctx.contentResolver, "voice_recognition_service")
    if (!configured.isNullOrBlank()) {
      val cn = ComponentName.unflattenFromString(configured)
      if (cn != null) {
        try {
          pm.getServiceInfo(cn, 0)
          return cn
        } catch (_: Throwable) {
          Log.w(TAG, "设置里指定的识别服务不存在：$configured")
        }
      }
    }
    // ② 没填（小米就是这种）→ 查所有识别服务，取第一个启用且导出的
    val found = pm.queryIntentServices(Intent(RecognitionService.SERVICE_INTERFACE), 0)
    for (ri in found) {
      val si = ri.serviceInfo ?: continue
      if (!si.enabled) continue
      if (si.applicationInfo?.enabled != true) continue
      return ComponentName(si.packageName, si.name)
    }
    return null
  }

  /** 用户点了「允许」就自动接着开始识别；20 次（约 8 秒）还没给就放弃 */
  private fun pollPermission(tries: Int) {
    if (granted()) {
      waitingPermission = false
      startListening()
      return
    }
    if (tries >= 20) {
      waitingPermission = false
      emit("error", "code" to "permission")
      return
    }
    main.postDelayed({ pollPermission(tries + 1) }, 400)
  }

  private fun stopListening() {
    // stopListening 会让引擎把已经听到的内容当作最终结果回给 onResults
    try {
      recognizer?.stopListening()
    } catch (_: Throwable) {
    }
  }

  private fun cancelListening() {
    cancelled = true
    try {
      recognizer?.cancel()
    } catch (_: Throwable) {
    }
    emit("cancelled")
  }

  private fun intentForSpeech(): Intent =
    Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
      /*
       * FREE_FORM 而不是 WEB_SEARCH：后者会把结果当搜索词改写（"帮我看下" 变成
       * "帮我看一下"这类），聊天输入要的是原话。
       */
      putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
      putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN")
      putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, "zh-CN")
      putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
      putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
      putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, ctx.packageName)
      /*
       * 不强制离线：离线包质量明显差一截，家里 Wi-Fi 又不贵。个别机型没网时
       * 引擎自己会退到离线包，这条留给它自己决定。
       */
      putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, false)
    }

  private val listener = object : RecognitionListener {
    override fun onReadyForSpeech(params: Bundle?) {
      emit("ready")
    }

    override fun onBeginningOfSpeech() {
      emit("speechStart")
    }

    override fun onRmsChanged(rmsdB: Float) {
      /*
       * 音量回调每 20ms 一次，逐条 evaluateJavascript 会把 WebView 压死。
       * 只发"档位变化"（0..7 共 8 档），波形够用，量级降到原来的 1/10。
       */
      val slot = when {
        rmsdB <= 0f -> 0
        rmsdB >= 10f -> 7
        else -> ((rmsdB + 1f) / 1.5f).toInt().coerceIn(1, 7)
      }
      if (slot != lastRmsSlot) {
        lastRmsSlot = slot
        emit("rms", "level" to slot)
      }
    }

    override fun onBufferReceived(buffer: ByteArray?) {}

    override fun onEndOfSpeech() {
      emit("speechEnd")
    }

    override fun onError(error: Int) {
      Log.w(TAG, "onError = $error（${codeName(error)}）")
      if (cancelled) {
        emit("cancelled")
        return
      }
      val code = codeName(error)
      /*
       * permission / client 这两个码在内嵌路线上基本等于"这个引擎不接第三方"
       * （小米实测：录制权限给着，它照样回 9）。不是我们修得好的事，别把
       * 「权限不足」甩给用户看 —— 直接换成系统面板，让这次点击仍然有结果。
       */
      if (code == "permission" || code == "client") {
        inlineBroken = true
        destroyRecognizer()
        emit("fallback")
        openSystemUi()
        return
      }
      if (error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY) destroyRecognizer()
      emit("error", "code" to code)
    }

    override fun onResults(results: Bundle?) {
      val text = firstText(results)
      if (cancelled) {
        emit("cancelled")
        return
      }
      if (text.isEmpty()) {
        emit("error", "code" to "noMatch")
        return
      }
      emit("final", "text" to text)
    }

    override fun onPartialResults(partialResults: Bundle?) {
      val text = firstText(partialResults)
      if (text.isNotEmpty()) emit("partial", "text" to text)
    }

    override fun onEvent(eventType: Int, params: Bundle?) {}
  }

  private fun firstText(b: Bundle?): String =
    b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim().orEmpty()

  private fun codeName(e: Int): String = when (e) {
    SpeechRecognizer.ERROR_AUDIO -> "audio"
    SpeechRecognizer.ERROR_CLIENT -> "client"
    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "permission"
    SpeechRecognizer.ERROR_NETWORK -> "network"
    SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "network"
    SpeechRecognizer.ERROR_NO_MATCH -> "noMatch"
    SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "busy"
    SpeechRecognizer.ERROR_SERVER -> "server"
    SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "silence"
    else -> "unknown"
  }

  /* ------------------------------------------------------------ 回给页面 */

  /**
   * 把事件 eval 进页面。`JSONObject.toString()` 本身就是合法的 JS 字面量，
   * 直接拼进调用括号里，不用手写转义。
   */
  private fun emit(type: String, vararg kv: Pair<String, Any?>) {
    val wv = webView ?: return
    val payload = JSONObject().put("type", type)
    for ((k, v) in kv) {
      if (v != null) payload.put(k, v)
    }
    val js = "window.__bandiSpeechEvent&&window.__bandiSpeechEvent($payload);"
    main.post {
      try {
        wv.evaluateJavascript(js, null)
      } catch (_: Throwable) {
      }
    }
  }

  private fun destroyRecognizer() {
    try {
      recognizer?.destroy()
    } catch (_: Throwable) {
    }
    recognizer = null
  }

  companion object {
    private const val REQ_AUDIO = 4711
    private const val REQ_SPEECH_UI = 4712
    /** logcat 里 grep 这个就能看到识别这条链路的全过程 */
    private const val TAG = "BandiSpeech"

    /** 当前活着的实例 —— MainActivity 拿它回传系统面板的结果 */
    @Volatile
    private var current: SpeechPlugin? = null

    /**
     * `MainActivity.onActivityResult` 转进来。
     *
     * Tauri 的 `Plugin` 基类只开放了 load/onResume/onPause 这些，**没有**
     * `onActivityResult`，所以要自己在 Activity 里接一道再递过来。
     */
    fun deliverResult(requestCode: Int, resultCode: Int, data: Intent?) {
      current?.onSpeechUiResult(requestCode, resultCode, data)
    }
  }
}
