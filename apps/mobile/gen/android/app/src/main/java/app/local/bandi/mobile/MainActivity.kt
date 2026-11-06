package app.local.bandi.mobile

import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    /*
     * Android 15+（这台是 Android 16）强制 edge-to-edge：WebView 的内容会画到
     * 状态栏和导航栏下面。而 Android WebView 的 env(safe-area-inset-*) 恒为 0，
     * 所以 apps/web 的 mobile.css 里那两条 padding 在安卓上不起作用 ——
     * 表现就是顶部导航栏被状态栏压住、底部 tab 被导航栏压住。
     *
     * 修法：给根内容视图补上"状态栏 + 刘海"的顶部 padding 和"导航栏"的底部
     * padding，让 WebView 整个落在安全区里。这比往 WebView 注入 JS 变量简单，
     * 也不依赖 Tauri 暴露 WebView 引用。
     *
     * 键盘（2026-11-06 用户报「评论框没贴着键盘、页面还能往上滑」的根因）：
     * edge-to-edge 一开，Android 就**不再**按 adjustResize 缩窗口 —— 键盘是直接
     * 盖在 WebView 上的，WebView 高度不变、visualViewport 也不缩。于是页面以为
     * 自己还有一整屏，输入框画在屏幕最底下被键盘盖住，WebView 再把整页（实际是
     * 视觉视口）往上滚一段去露出焦点 —— 用户看到的就是"输入框被顶上去、下面是
     * 空白、还能继续往上滑"。抖音那类 App 没这毛病，因为它们的窗口真的被键盘
     * 缩小了。这里把 ime()（键盘）也算进底部 padding：键盘弹多少，WebView 就矮
     * 多少，输入框自然永远贴着键盘上沿，页面也没有多余可滚的余量。
     * 底部取「导航栏」与「键盘」的较大者 —— 键盘弹起时导航栏 inset 会变 0，
     * 取 max 才不会一开一关底部抖一下。
     */
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val top = insets.getInsets(
        WindowInsetsCompat.Type.statusBars() or WindowInsetsCompat.Type.displayCutout()
      ).top
      val navBottom = insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom
      val imeBottom = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      view.setPadding(0, top, 0, maxOf(navBottom, imeBottom))
      insets
    }

    // 兜底注册（见 hookBack 的时序说明）：万一 onWebViewCreate 比预想来得早，
    // 这里先挂一版按视图树找 WebView 的；onWebViewCreate 里会摘掉重挂。
    hookBack(null)
  }

  /** onWebViewCreate 里捕获的壳内唯一 WebView（返回键分流要用它读当前 URL） */
  private var shellWebView: WebView? = null

  /** 已挂上的返回回调（重挂前先摘，避免叠好几层） */
  private var backCallback: OnBackPressedCallback? = null

  /**
   * 返回键分流（2026-11-05 用户五报「点返回退出到了扫码页」的根治，壳侧这一刀是终判）。
   *
   * Tauri v2 在 Android 上的返回键由内置 AppPlugin 接管（tauri crate 的
   * mobile/android/.../AppPlugin.kt，我们改不了）：`canGoBack → goBack，否则退出
   * Activity`。Web 侧（apps/web/js/mobile.mjs ⑦ 的「根页井」）虽然让栈里永远有得退，
   * 但拦不住三个时间窗 —— 工作台刚加载、井还没压上；连按两下返回的竞态；手机端
   * Service Worker 缓存还没换到新脚本。这几个窗口里 canGoBack=false，AppPlugin 直接
   * 退出 App —— 重开自然落扫码页，看起来就是「按返回被踢回扫码界面」。
   *
   * 修法：注册一个**更晚加入**（OnBackPressedDispatcher 里最后加入的 enabled 回调
   * 优先）的回调，把 AppPlugin 整个挡在后面，按当前 URL 分流：
   *   · 本地启动页（tauri.localhost）→ 照旧：有历史退一层，退无可退退出 App；
   *   · 远程页（工作台 / 配对页）→ **永远不退出**：有历史交给网页退（关详情 / 井
   *     原地弹回），没历史就吞掉。回扫码页只剩「断开连接」和配对失效两条正路，
   *     跟用户要的口径一致。
   *
   * 时序：AppPlugin 的回调在插件构造时挂（WebView 建好之前），onWebViewCreate 在
   * setWebView 尾部调用（必然更晚）—— 所以这里重挂一次保证我们排在最后。
   * ⚠️ gen/android 手改文件：重新 `tauri android init` 后要照此重加。
   */
  private fun hookBack(webView: WebView?) {
    backCallback?.remove()
    backCallback = object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val wv =
          webView
            ?: shellWebView
            ?: findWebView(window.decorView ?: return finish())
            ?: return finish() // 连 WebView 都没有（理论到不了）：照旧退出
        val url = wv.url ?: ""
        val isLocal =
          url.isEmpty() ||
            url.startsWith("http://tauri.localhost") ||
            url.startsWith("https://tauri.localhost") ||
            url.startsWith("tauri://") ||
            url == "about:blank"
        if (isLocal) {
          // 启动页（扫码 / 邀请码 / 已配对）：维持壳原有行为 —— 视图层逐级退，
          // 退无可退退出 App（重开落启动页在这里是正路）。
          if (wv.canGoBack()) wv.goBack() else finish()
        } else {
          /*
           * 工作台 / 配对页分流（2026-11-05 三刀）。启动页的「账号密码登录」入口
           * 保留了历史（launcher.js connect 的 keepBack），好让填错地址、还没登录时
           * 返回键能退回启动页；但登录成功进了工作台之后，返回就**不该**再摸到启动页
           * （用户口径：返回跳回扫码页 = bug）。
           *
           * 二刀用「有没有凭据 Cookie」判，太粗：把工作台**内部**的返回也全吞了
           * （关详情页、关选择页、井回弹都是网页 popstate 收的，吞掉 = 返回键失灵，
           * 用户三报「返回键被禁用」）。三刀改看**上一条历史的 URL**：
           *   · 上一条是远程页 = 网页自己的栈 → goBack，交给网页收（井保证退不到底）；
           *   · 上一条是本机启动页 → 只有还没登录才 goBack 退回启动页，已登录吞掉；
           *   · canGoBack=false（扫码/邀请码路清了历史）→ 吞掉，永不退出 App。
           * 四刀：三刀的"已登录"用 Cookie 判还是错 —— Cookie 登录过就一直在，停在
           * 登录页也会被吞。改由网页自己报：认证通过后网址带 #bandi-app 标记。
           * ⚠️ pushState 的条目也在这张表里，所以详情/选择页那层看得到。
           */
          if (wv.canGoBack()) {
            val list = wv.copyBackForwardList()
            val prev =
              if (list.currentIndex > 0) list.getItemAtIndex(list.currentIndex - 1)?.url else null
            val prevIsLocal =
              prev != null &&
                (
                  prev.startsWith("http://tauri.localhost") ||
                    prev.startsWith("https://tauri.localhost") ||
                    prev.startsWith("tauri://") ||
                    prev == "about:blank"
                  )
            if (!prevIsLocal) {
              wv.goBack()
            } else {
              /*
               * 上一条是本机启动页：只有**此刻不在工作台**才退回去。
               * 「在工作台」由网页自己报（state.mjs markAppUrl：认证通过后把网址打上
               * #bandi-app 标记）—— Cookie 判不了：登录成功过一次 Cookie 就一直留着，
               * 停在登录页也会被误判成已登录、返回键被吞（2026-11-05 用户实报四刀）。
               */
              if (!url.contains("#bandi-app")) wv.goBack()
            }
          }
        }
      }
    }.also { onBackPressedDispatcher.addCallback(this, it) }
  }

  /** 视图树里找 WebView（兜底用：正常路径 onWebViewCreate 已经把引用递过来了） */
  private fun findWebView(root: View): WebView? {
    if (root is WebView) return root
    if (root is ViewGroup) {
      for (i in 0 until root.childCount) {
        findWebView(root.getChildAt(i))?.let { return it }
      }
    }
    return null
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    shellWebView = webView
    // 重挂：保证我们的回调是 dispatcher 里最后加入的 —— 压过 AppPlugin 那个
    hookBack(webView)
  }

}
