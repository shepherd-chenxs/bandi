package app.local.bandi.mobile

import android.os.Bundle
import android.view.View
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
     */
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val top = insets.getInsets(
        WindowInsetsCompat.Type.statusBars() or WindowInsetsCompat.Type.displayCutout()
      ).top
      val bottom = insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom
      view.setPadding(0, top, 0, bottom)
      insets
    }
  }
}
