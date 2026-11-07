/*
 * MainActivity.kt —— 原生壳的三个视图：登录 → 设备列表 → 面板（WebView）。
 *
 * 流程与旧 Tauri 壳的 launcher.js 完全同构：
 *   A. 账号密码登录：POST {中枢}/v1/auth/phone-login → 30 天会话（本机存储）
 *   B. 设备列表：GET {中枢}/v1/devices → 逐台局域网探活（Probe.kt），点亮的才标「可连」
 *   C. 点一台 → POST {中枢}/v1/devices/:id/ticket → WebView 打开
 *      <那台电脑>/hub/enter?ticket=… —— 机器验票（钉着的中枢公钥）后发会话进面板
 *
 * 与旧壳的三处刻意不同：
 *   · 登录在**原生层**完成 —— 不再有「保存 tauri.localhost 的账号密码」这类
 *     系统层弹窗（那是WebView 版壳五轮压不住的根源，也是这次换原生的动因）；
 *   · 面板桥从「导航 hash + 注入全局」换成 addJavascriptInterface（BandiShell.kt），
 *     页面脚本从第一行起就能调，浏览器 / PWA / 旧壳行为不受影响（功能检测式）；
 *   · 换机器时 WebView.clearHistory() —— 返回键不再摸到上一台机器的页面。
 *
 * 返回键口径（沿用既有用户拍板）：面板 → 网页能退就退，退无可退退到后台；
 * 登录 / 设备列表 → 退到后台。**已登录状态下不退回上一屏**，「切换」只走
 * 面板里的「当前设备」菜单。
 */
package app.local.bandi.mobile

import android.annotation.SuppressLint
import android.os.Bundle
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import app.local.bandi.mobile.databinding.ActivityMainBinding
import org.json.JSONObject
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private val pool = Executors.newFixedThreadPool(6)

    /** 名册（原样解析）与探活结果：reach[id] = 探通的 origin */
    private data class DeviceRow(
        val id: String,
        val name: String,
        val platform: String,
        val version: String,
        val scheme: String,
        val port: Int,
        val lanAddrs: List<String>,
    ) {
        /** 候选地址：第一优先就是名册里的顺序（与旧壳 originsOf 同口径） */
        fun origins(): List<String> {
            val scheme = if (scheme == "https") "https" else "http"
            val portPart = if (port > 0) ":$port" else ""
            return lanAddrs.filter { it.isNotBlank() }.map { "$scheme://$it$portPart" }
        }
    }

    private var devices: List<DeviceRow> = emptyList()
    private val reach = mutableMapOf<String, String>()
    private val probeRound = java.util.concurrent.atomic.AtomicInteger(0)
    /** 进面板那一刻置位：onPageFinished 里清一次 WebView 历史，返回键不再摸到上一台 */
    private var pendingClearHistory = false

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        /*
         * Android 15+（本机是 Android 16）强制 edge-to-edge：WebView 的内容会画到
         * 状态栏和导航栏下面，而 Android WebView 的 env(safe-area-inset-*) 恒为 0，
         * 网页自己的安全区 padding 不起作用 —— 面板里底部固定的按钮（抽屉 / 弹窗）
         * 会被系统导航栏挡住（用户实报）。修法与 Tauri 壳同款：给根内容视图补上
         * 「状态栏 + 刘海」的顶部 padding，「导航栏」与「键盘」取较大者的底部 padding
         * （键盘弹起时导航栏 inset 变 0，取 max 才不会一开一关抖一下）—— WebView
         * 整个落在安全区里，网页以为的高度就是真实可用高度。
         */
        val content = findViewById<View>(android.R.id.content)
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
            val top = insets.getInsets(
                androidx.core.view.WindowInsetsCompat.Type.statusBars()
                    or androidx.core.view.WindowInsetsCompat.Type.displayCutout(),
            ).top
            val navBottom = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.navigationBars()).bottom
            val imeBottom = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.ime()).bottom
            view.setPadding(0, top, 0, maxOf(navBottom, imeBottom))
            insets
        }

        setupWebView()
        setupBackHandler()
        setupLoginView()
        setupDevicesView()

        // 有会话就直接进列表（30 天有效，重开 App 不该再让人输一遍密码）
        if (SessionStore.session(this) != null) {
            showDevices()
            loadDevices()
        } else {
            showLogin()
        }
    }

    /* ------------------------------------------------------------ 视图切换 */

    private fun showLogin() {
        binding.viewLogin.visibility = View.VISIBLE
        binding.viewDevices.visibility = View.GONE
        binding.viewPanel.visibility = View.GONE
        binding.phoneInput.setText(SessionStore.account(this) ?: "")
        binding.hubInput.setText(SessionStore.hub(this).let { if (it == SessionStore.DEFAULT_HUB) "" else it })
    }

    fun showDevices() {
        binding.viewLogin.visibility = View.GONE
        binding.viewDevices.visibility = View.VISIBLE
        binding.viewPanel.visibility = View.GONE
        loadDevices()
    }

    private fun showPanel() {
        binding.viewLogin.visibility = View.GONE
        binding.viewDevices.visibility = View.GONE
        binding.viewPanel.visibility = View.VISIBLE
    }

    /* ------------------------------------------------------------ ① 登录 */

    private fun setupLoginView() {
        binding.passInput.setOnEditorActionListener { _, actionId, event ->
            val go = actionId == android.view.inputmethod.EditorInfo.IME_ACTION_GO ||
                (event != null && event.keyCode == android.view.KeyEvent.KEYCODE_ENTER)
            if (go) { doLogin(); true } else false
        }
        binding.loginBtn.setOnClickListener { doLogin() }
    }

    private fun doLogin() {
        val phone = binding.phoneInput.text?.toString()?.filter { it.isDigit() } ?: ""
        val password = binding.passInput.text?.toString() ?: ""
        if (!Regex("^1\\d{10}$").matches(phone)) {
            loginStatus("手机号填 11 位")
            return
        }
        if (password.length < 8) {
            loginStatus("密码至少 8 位")
            return
        }
        val hub = binding.hubInput.text?.toString()?.trim().takeUnless { it.isNullOrEmpty() }
        SessionStore.setHub(this, hub)
        val hubBase = SessionStore.hub(this)
        loginStatus(null)
        setLoginBusy(true)
        pool.execute {
            try {
                val (session, account) = HubApi.phoneLogin(hubBase, phone, password)
                SessionStore.setSession(this, session)
                SessionStore.setAccount(this, account.optString("login", phone))
                runOnUiThread {
                    setLoginBusy(false)
                    binding.passInput.setText("")
                    showDevices()
                }
            } catch (e: Exception) {
                runOnUiThread {
                    setLoginBusy(false)
                    loginStatus(e.message ?: "出错了")
                }
            }
        }
    }

    private fun setLoginBusy(busy: Boolean) {
        binding.loginBtn.isEnabled = !busy
        binding.loginBtn.text = if (busy) "登录中…" else "登录"
    }

    private fun loginStatus(text: String?) {
        if (text == null) {
            binding.loginStatus.visibility = View.GONE
        } else {
            binding.loginStatus.visibility = View.VISIBLE
            binding.loginStatus.text = text
        }
    }

    /* ------------------------------------------------------------ ② 设备列表 */

    private fun setupDevicesView() {
        binding.refreshBtn.setOnClickListener { loadDevices() }
    }

    private fun loadDevices() {
        val session = SessionStore.session(this) ?: run {
            showLogin()
            return
        }
        val hub = SessionStore.hub(this)
        binding.devSub.text = "正在读取名册…"
        binding.deviceList.removeAllViews()
        val round = probeRound.incrementAndGet()
        pool.execute {
            try {
                val arr = HubApi.devices(hub, session)
                val rows = (0 until arr.length()).mapNotNull { i ->
                    val d = arr.optJSONObject(i) ?: return@mapNotNull null
                    DeviceRow(
                        id = d.optString("id"),
                        name = d.optString("name", "").ifEmpty { d.optString("id") },
                        platform = d.optString("platform", ""),
                        version = d.optString("version", ""),
                        scheme = d.optString("scheme", "http"),
                        port = d.optInt("port", 0),
                        lanAddrs = d.optJSONArray("lanAddrs")?.let { a -> (0 until a.length()).mapNotNull { a.optString(it) } } ?: emptyList(),
                    )
                }.filter { it.id.isNotBlank() }
                devices = rows
                runOnUiThread {
                    if (round != probeRound.get()) return@runOnUiThread
                    binding.devSub.text = if (rows.isEmpty()) "这个账号名下还没有电脑 —— 先在电脑上打开班底，用同一个手机号登录一次" else "点一台进去"
                    renderDevices(round)
                    probeDevices(round)
                }
            } catch (e: Exception) {
                runOnUiThread {
                    if (round != probeRound.get()) return@runOnUiThread
                    binding.devSub.text = "读取名册失败"
                    binding.deviceList.removeAllViews()
                    binding.deviceList.addView(emptyNote(e.message ?: "出错了"))
                    if ((e as? HubException)?.status == 401) backToLogin("登录已过期，请重新登录")
                }
            }
        }
    }

    /** 逐台并行探活（每台最多试前三个候选地址），探通的才标「可连」 */
    private fun probeDevices(round: Int) {
        for (d in devices) {
            pool.execute {
                var found: String? = null
                for (origin in d.origins().take(3)) {
                    if (probeRound.get() != round) return@execute
                    if (Probe.probe(origin) != null) { found = origin; break }
                }
                if (probeRound.get() != round) return@execute
                if (found != null) {
                    reach[d.id] = found
                    runOnUiThread {
                        if (probeRound.get() == round) renderDevices(round)
                    }
                }
            }
        }
    }

    private fun renderDevices(round: Int) {
        if (probeRound.get() != round) return
        binding.deviceList.removeAllViews()
        for (d in devices) {
            val r = reach[d.id]
            binding.deviceList.addView(deviceCard(d, r))
        }
    }

    private fun deviceCard(d: DeviceRow, reachedOrigin: String?): View {
        val card = com.google.android.material.card.MaterialCardView(this)
        card.layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT,
        ).apply { setMargins(0, 8, 0, 8) }
        card.strokeWidth = 0
        card.radius = resources.displayMetrics.density * 16
        card.isClickable = true
        card.isFocusable = true
        card.setOnClickListener { enterDevice(d.id) }

        val box = LinearLayout(this)
        box.orientation = LinearLayout.VERTICAL
        box.setPadding(40, 28, 40, 28)

        val nameLine = LinearLayout(this)
        nameLine.orientation = LinearLayout.HORIZONTAL
        nameLine.gravity = android.view.Gravity.CENTER_VERTICAL

        val name = TextView(this)
        name.text = d.name
        name.textSize = 17f
        name.setTextColor(ContextCompat.getColor(this, android.R.color.primary_text_light))
        name.layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)

        val badge = TextView(this)
        badge.text = if (reachedOrigin != null) "可连" else "未探到"
        badge.textSize = 12f
        badge.setPadding(16, 4, 16, 4)
        if (reachedOrigin != null) {
            badge.setBackgroundResource(android.R.color.holo_green_light)
            badge.setTextColor(ContextCompat.getColor(this, android.R.color.white))
        } else {
            badge.setBackgroundResource(android.R.color.darker_gray)
            badge.setTextColor(ContextCompat.getColor(this, android.R.color.white))
        }
        nameLine.addView(name)
        nameLine.addView(badge)

        val meta = TextView(this)
        meta.textSize = 13f
        meta.setTextColor(ContextCompat.getColor(this, android.R.color.secondary_text_light))
        meta.text = reachedOrigin ?: run {
            val ver = if (d.version.isNotEmpty()) "v${d.version}" else ""
            listOf(d.platform, ver).filter { it.isNotEmpty() }.joinToString(" · ").ifEmpty { "—" }
        }
        meta.setPadding(0, 8, 0, 0)

        box.addView(nameLine)
        box.addView(meta)
        card.addView(box)
        return card
    }

    private fun emptyNote(text: String): TextView {
        val t = TextView(this)
        t.text = text
        t.textSize = 14f
        t.setTextColor(ContextCompat.getColor(this, android.R.color.secondary_text_light))
        t.setPadding(16, 32, 16, 32)
        return t
    }

    /* ------------------------------------------------------------ ③ 签票进面板 */

    private fun enterDevice(id: String) {
        val d = devices.find { it.id == id } ?: return
        val session = SessionStore.session(this) ?: run { backToLogin(null); return }
        val hub = SessionStore.hub(this)
        binding.devSub.text = "正在进入…"
        pool.execute {
            try {
                val ticket = HubApi.ticket(hub, session, id)
                val dev = devices.find { it.id == id } ?: d
                val origin = reach[id] ?: dev.origins().firstOrNull()
                if (origin == null) {
                    runOnUiThread { binding.devSub.text = "这台电脑还没上报地址，先在它上面打开班底" }
                    return@execute
                }
                runOnUiThread {
                    binding.devSub.text = "点一台进去"
                    /*
                     * 进门前清一遍 Cookie（2026-11-07 用户实报「我的页有两条设备卡」）：
                     * 旧配对时代留下的 bd_ 设备令牌还在 Cookie 罐里，机器闸是「令牌优先、
                     * 会话兜底」—— 旧令牌会把刚发的中枢会话压下去，人就以设备身份进了面板
                     * （新代码的 /hub/enter 会顺手清 bd_，但旧版本机器进程没有这步）。
                     * 每次进门都是一张新鲜票，旧 Cookie 没有存活价值：全清，落进来的
                     * 一定是干净的中枢身份，「这台设备」配对卡随之消失。
                     */
                    CookieManager.getInstance().removeAllCookies(null)
                    CookieManager.getInstance().flush()
                    pendingClearHistory = true
                    showPanel()
                    // 机器验票后 302 到 / 并发会话 Cookie；CookieManager 默认接收，
                    // 后续面板请求自动带上
                    binding.panelWebView.loadUrl("$origin/hub/enter?ticket=${android.net.Uri.encode(ticket)}")
                }
            } catch (e: Exception) {
                runOnUiThread {
                    binding.devSub.text = e.message ?: "签票失败"
                    if ((e as? HubException)?.status == 401) backToLogin("登录已过期，请重新登录")
                }
            }
        }
    }

    /* ------------------------------------------------------------ 面板 WebView */

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        val wv = binding.panelWebView
        CookieManager.getInstance().setAcceptCookie(true)
        wv.settings.javaScriptEnabled = true
        wv.settings.domStorageEnabled = true
        wv.addJavascriptInterface(BandiShell(this), "BandiShell")
        wv.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                // 只在「刚进一台机器」的边界清一次历史：面板内部的 pushState 导航不受影响，
                // 返回键从此不会摸到上一台机器的页面
                if (pendingClearHistory) {
                    pendingClearHistory = false
                    view.clearHistory()
                }
            }
        }
    }

    /** 面板里的「当前设备」→ 回原生设备列表（WebView 实例留着，切机器时复用） */
    fun showDevicesFromPanel() {
        showDevices()
    }

    /** 面板里的「退出登录」→ 清中枢会话与机器 Cookie，落回登录页 */
    fun onPanelLoggedOut() {
        SessionStore.clearSession(this)
        CookieManager.getInstance().removeAllCookies(null)
        devices = emptyList()
        reach.clear()
        binding.panelWebView.loadUrl("about:blank")
        showLogin()
        Toast.makeText(this, "已退出登录", Toast.LENGTH_SHORT).show()
    }

    private fun backToLogin(toast: String?) {
        SessionStore.clearSession(this)
        devices = emptyList()
        reach.clear()
        showLogin()
        if (toast != null) Toast.makeText(this, toast, Toast.LENGTH_SHORT).show()
    }

    /* ------------------------------------------------------------ 返回键 */

    private fun setupBackHandler() {
        onBackPressedDispatcher.addCallback(this, object : androidx.activity.OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    binding.viewPanel.visibility == View.VISIBLE -> {
                        // 面板：网页自己的栈先退（看板详情等），退无可退退到后台 ——
                        // 不回设备列表（「切换」只走面板里的「当前设备」菜单）
                        if (binding.panelWebView.canGoBack()) binding.panelWebView.goBack()
                        else moveTaskToBack(true)
                    }
                    else -> moveTaskToBack(true)
                }
            }
        })
    }
}
