/*
 * MainActivity.kt —— 原生壳的三个视图：登录 → 设备列表 → 面板（WebView）。
 *
 * 流程与旧 Tauri 壳的 launcher.js 完全同构：
 *   A. 账号密码登录：POST {中枢}/v1/auth/phone-login → 30 天会话（本机存储）
 *   B. 设备列表：GET {中枢}/v1/devices → 逐台局域网探活（Probe.kt），按结果标「在线 / 离线」
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
import android.graphics.drawable.GradientDrawable
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
        /**
         * 中转地址（2026-11-08）：中枢下发的外网入口 `https://ddev-xxxx.<域>`。
         * 没开通外网访问、或被中枢吊销时为 null —— 与「这台机器名册里没有它」同义。
         */
        val publicUrl: String?,
    ) {
        /**
         * 候选地址：**中转优先**，再按名册顺序试局域网（2026-11-08）。
         *
         * 为什么要改顺序：以前只有局域网地址，人一旦离开家/公司（4G、别人家网），
         * 整张列表一律"离线"—— 而外网其实只有中转这条通。反过来在家时中转也能用
         * （绕一圈 Cloudflare，慢几十毫秒），所以不必判断"现在是不是在内网"，
         * 直接先试中转、不通再回落到局域网即可。
         */
        fun origins(): List<String> {
            val scheme = if (scheme == "https") "https" else "http"
            val portPart = if (port > 0) ":$port" else ""
            val relay = publicUrl?.trim()?.takeIf { it.startsWith("http://") || it.startsWith("https://") }
            val lan = lanAddrs.filter { it.isNotBlank() }.map { "$scheme://$it$portPart" }
            return (listOfNotNull(relay) + lan).distinct()
        }
    }

    private var devices: List<DeviceRow> = emptyList()
    private val reach = mutableMapOf<String, String>()
    /**
     * 探活**已出结果**的设备 id（无论通不通）。没有它就没法区分"还在探"和"探完不通" ——
     * 两者都表现为 reach 里没值，早先的界面只能一律写「未探到」，等于一进页面就先
     * 冤枉所有电脑离线一次，随后逐台"变绿"（2026-11-07 改「在线 / 离线」时顺手补上）。
     * 跨线程读写（后台探活线程 → UI 线程重绘），所以用并发集合而不是 HashSet。
     */
    private val probed: MutableSet<String> = java.util.concurrent.ConcurrentHashMap.newKeySet()
    private val probeRound = java.util.concurrent.atomic.AtomicInteger(0)
    /** 进面板那一刻置位：onPageFinished 里清一次 WebView 历史，返回键不再摸到上一台 */
    private var pendingClearHistory = false

    /*
     * **会话过期的静默重进**（2026-11-08）。
     *
     * 本机会话只有 12 小时绝对 / 30 分钟空闲（服务端 store/users.mjs），而壳自己的
     * 中枢会话是 30 天 —— 两者不可能同步过期。过期后服务端对面板 HTML 只给登录页，
     * 人就对着手机号输入框发呆（用户实报"遇到过好几次"）。
     *
     * 壳本来就有重进的钥匙（中枢会话 → /hub/enter），只是**没人叫它**。现在两条触发：
     *   · 服务端在 UA 里认出壳 → 302 /hub/expired（shouldOverrideUrlLoading 接住）；
     *   · 面板 JS 收到 E4010/E4012 → BandiShell.sessionExpired()。
     * 两条都走 reenter()。
     */
    private var currentDeviceId: String? = null
    /** 正在重进：/hub/expired 可能被连打，防重入 */
    private var reentering = false
    /** 连续失败次数：票签不出来说明中枢/账号那边真有事，两次就回列表 */
    private var reenterFails = 0
    /**
     * 设备列表是从面板进来的（2026-11-11）：左上角「返回」回面板，右上角不画退出。
     * 从登录页 / 冷启动进来时为 false —— 那一页是根，没有可回的地方。
     */
    private var devicesFromPanel = false
    /**
     * 上一次进面板的 origin：设备列表的「返回」靠它切回 WebView。
     * showDevices() 会 stopConnWatch() 把 connOrigin 清掉（离开面板就停探活），
     * 所以这两份不能是同一个字段 —— 一个是"正在盯着谁"，一个是"刚才在谁那儿"。
     */
    private var lastPanelOrigin: String? = null

    /*
     * 面板连不上机器（2026-11-08）：机器掉线/睡眠时 WebView 会画系统错误页
     * （"网页无法打开 net::ERR_…"），那是 Android 的默认行为，不能露给用户 ——
     * 主框架加载失败时盖一层原生兜底页（layout 的 viewPanelError）。
     *
     *   panelErrorShown     错误层此刻是否盖着（重试 / 回列表时收掉）
     *   panelErrorThisPage  本次页面加载是否以主框架错误收场 —— onPageFinished
     *                       靠它区分"加载成功要收层"和"加载失败要留着"
     */
    private var panelErrorShown = false
    private var panelErrorThisPage = false

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        /*
         * 关掉系统给导航栏加的那层"对比度保护"scrim（2026-11-12）。
         *
         * 3-button 模式下系统会在导航键区盖一层半透明白，把下面画的东西往白里拉：
         * 页面底 #F7F8F9 会被抬成 #FEFEFE —— 于是原生页最底下永远比上面亮一档，
         * 我们用 DecorView 贴的色块也被它盖住（v237 那套"网页报色、壳画条"看着像生效了，
         * 其实只是白色底本来就接近 scrim 的结果）。
         *
         * 关掉之后导航键区画什么就是什么：色块（面板页报来的 --mb-chrome）和页面底色
         * （原生页的 @color/bandi_page）都能一路通到底。导航键的明暗我们自己按亮度调，
         * 不靠系统这层保护。
         */
        window.isNavigationBarContrastEnforced = false

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
            navInset = navBottom
            applySysBarStrip()
            statusInset = top
            applyTopBarStrip()
            insets
        }

        setupWebView()
        setupBackHandler()
        setupLoginView()
        setupDevicesView()
        setupOfflineActions()

        // 有会话就直接进列表（30 天有效，重开 App 不该再让人输一遍密码）
        if (SessionStore.session(this) != null) {
            showDevices()
            loadDevices()
        } else {
            showLogin()
        }

        startNetWatch()
    }

    /* ------------------------------------------------ 探测的开关（前后台 / 网络） */

    /*
     * 只靠定时是笨的：手机换网、App 回前台、面板刚加载完，都是"状态可能已经变了"的时刻。
     * 这三个触发源各自补一次立即探测，把"等下一个周期"的时间省掉 ——
     * 既比缩短定时间隔省流量，又比纯定时反应快。
     */
    private var netCallback: android.net.ConnectivityManager.NetworkCallback? = null

    private fun startNetWatch() {
        if (netCallback != null) return
        val cm = getSystemService(android.net.ConnectivityManager::class.java) ?: return
        val cb = object : android.net.ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: android.net.Network) = pokeConnWatch(600)

            override fun onLost(network: android.net.Network) {
                // 不在这里标红：手机断网时探测自己会失败（一次失败只是复核，两次才出条）。
                // 更关键的是换网时 onLost 常紧跟 onAvailable，提前出条等于闪一下"假离线"。
            }
        }
        runCatching { cm.registerDefaultNetworkCallback(cb) }.onSuccess { netCallback = cb }
    }

    private fun stopNetWatch() {
        val cb = netCallback ?: return
        netCallback = null
        val cm = getSystemService(android.net.ConnectivityManager::class.java) ?: return
        runCatching { cm.unregisterNetworkCallback(cb) }
    }

    override fun onPause() {
        super.onPause()
        // 退到后台就停探（不丢 origin，回前台续上）—— 后台每 10 秒打一次电脑纯属浪费
        if (connOrigin != null) {
            connPaused = true
            connHandler.removeCallbacks(connTick)
            android.util.Log.i("BandiConn", "pause: 退到后台，停止探测")
        }
    }

    override fun onResume() {
        super.onResume()
        if (connPaused) {
            connPaused = false
            android.util.Log.i("BandiConn", "resume: 回前台，补一次探测")
            pokeConnWatch(600) // 回前台立刻确认一次，别让用户对着"可能已经过时"的状态发呆
        }
    }

    override fun onDestroy() {
        stopNetWatch()
        connHandler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    /* ------------------------------------------------------------ 视图切换 */

    /*
     * 系统导航栏那条带跟着网页 tab 栏一个色（2026-11-11 用户截图："底部导航栏跟系统
     * 导航栏改成一个颜色"）。
     *
     * 为什么会有那条带：Android 15+ 强制 edge-to-edge，系统导航键区露的是**窗口背景**，
     * 网页画不到（WebView 被 padding 抬到它上面）。窗口背景只有主题给的纯白/纯黑，
     * 而 tab 栏是一层带灰的栏 —— 屏幕最底部永远一道色差。
     *
     * 做法：不去改窗口背景（那会把顶部状态栏那条带也染色，hero 渐变上会多一条灰边），
     * 而是在 DecorView 上贴一条只有导航键区那么高的色块，高度跟 insets 走（键盘弹起时
     * navBottom=0，条自己收起）。颜色由网页给 —— CSS 的 `--mb-chrome`，主题一变就重报
     * （shell.mjs applyTheme → BandiShell.setSystemBarColor）。导航键的明暗按亮度反着调，
     * 否则深底上画深色键等于没有键。
     *
     * 原生页（登录 / 设备列表 / 兜底）没有网页来报色，由 paintSystemBarPage() 把它
     * 设成页面底色 `@color/bandi_page`（2026-11-12 修正：原来直接 GONE，露出的是系统
     * 导航栏自己那层 97% 白的 scrim，比页面底亮一档，底部还是一道 #FEFEFE 的缝）。
     */
    private var sysBarStrip: View? = null
    private var sysBarColor: Int? = null
    private var navInset = 0

    /*
     * 顶部同理（2026-11-12 用户截图："这两个统一一下颜色"）：状态栏那一行是浅灰
     * （窗口背景 = 页面底色 #F7F8F9），紧挨着的「工作台」标题栏是白的（v241 拍白），
     * 一条明显的两截。
     *
     * 照底部的解法再画一条：DecorView 顶上贴一条状态栏那么高的色块，颜色由网页报 ——
     * 报的是"贴着视口顶上的那条栏"的实色（shell.mjs topBarColor），所以工作台的
     * 白顶栏、详情页的白返回栏、深色下的 #1C1C1E 都对得上。原生页刷页面底色。
     */
    private var topBarStrip: View? = null
    private var topBarColor: Int? = null
    private var statusInset = 0

    fun applySystemBarColor(css: String) {
        val c = runCatching { android.graphics.Color.parseColor(css.trim()) }.getOrNull()
        if (c == null) { resetSystemBarColor(); return }   // 空串 = 当前页没有底栏，收起
        sysBarColor = c
        applySysBarStrip()
        val luma = (0.299 * android.graphics.Color.red(c) +
            0.587 * android.graphics.Color.green(c) +
            0.114 * android.graphics.Color.blue(c)) / 255.0
        androidx.core.view.WindowInsetsControllerCompat(window, window.decorView)
            .isAppearanceLightNavigationBars = luma > 0.6
    }

    /** 网页报空串时用：页面自己铺到底（详情 / 聊天），别在底下垫一条灰 */
    fun resetSystemBarColor() {
        sysBarColor = null
        sysBarStrip?.visibility = View.GONE
        val night = (resources.configuration.uiMode and
            android.content.res.Configuration.UI_MODE_NIGHT_MASK) ==
            android.content.res.Configuration.UI_MODE_NIGHT_YES
        androidx.core.view.WindowInsetsControllerCompat(window, window.decorView)
            .isAppearanceLightNavigationBars = !night
    }

    /** 原生页用：导航键区 + 状态栏都刷成页面底色，跟内容连成一片 */
    private fun paintSystemBarPage() {
        val page = androidx.core.content.ContextCompat.getColor(this, R.color.bandi_page)
        sysBarColor = page
        applySysBarStrip()
        androidx.core.view.WindowInsetsControllerCompat(window, window.decorView)
            .isAppearanceLightNavigationBars = true
        topBarColor = page
        applyTopBarStrip()
        androidx.core.view.WindowInsetsControllerCompat(window, window.decorView)
            .isAppearanceLightStatusBars = true
    }

    /*
     * 接缝盖布（2026-11-12 用户截图红框："这个线能去掉吗"）。
     *
     * 实测（截图逐像素采样）：WebView 底边与色带顶边的交界处有一整行 ~#FAFAFA 的
     * 淡灰线 —— WebView 是独立 surface，边缘合成时和窗口背景 #F7F8F9 混出 1~2px 的缝。
     * 色带颜色本来就是网页报的、和贴着它的那条栏同色，所以向上多盖 2dp 把缝压住，
     * 多盖的部分盖的也是同色栏，肉眼不可见。顶部色带对称处理（向下多盖 2dp）。
     */

    /** 把色块贴上/更新高度。没颜色（网页页自己没有底栏）或导航键区为 0（键盘弹起）时收起 */
    private fun applySysBarStrip() {
        val c = sysBarColor ?: return
        val v = sysBarStrip ?: View(this).also {
            (window.decorView as android.view.ViewGroup).addView(
                it,
                android.widget.FrameLayout.LayoutParams(
                    android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                    0,
                    android.view.Gravity.BOTTOM,
                ),
            )
            sysBarStrip = it
        }
        val lp = v.layoutParams as android.widget.FrameLayout.LayoutParams
        val h = navInset + dp(2)
        if (lp.height != h) {
            lp.height = h
            v.layoutParams = lp
        }
        v.setBackgroundColor(c)
        v.visibility = if (navInset > 0) View.VISIBLE else View.GONE
    }

    /* ---------------- 顶部状态栏那条带（网页报"贴着顶上的那条栏"的实色） ---------------- */

    fun applyTopBarColor(css: String) {
        val c = runCatching { android.graphics.Color.parseColor(css.trim()) }.getOrNull()
        if (c == null) { topBarColor = null; topBarStrip?.visibility = View.GONE; return }
        topBarColor = c
        applyTopBarStrip()
        val luma = (0.299 * android.graphics.Color.red(c) +
            0.587 * android.graphics.Color.green(c) +
            0.114 * android.graphics.Color.blue(c)) / 255.0
        androidx.core.view.WindowInsetsControllerCompat(window, window.decorView)
            .isAppearanceLightStatusBars = luma > 0.6
    }

    private fun applyTopBarStrip() {
        val c = topBarColor ?: return
        val v = topBarStrip ?: View(this).also {
            (window.decorView as android.view.ViewGroup).addView(
                it,
                android.widget.FrameLayout.LayoutParams(
                    android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                    0,
                    android.view.Gravity.TOP,
                ),
            )
            topBarStrip = it
        }
        val lp = v.layoutParams as android.widget.FrameLayout.LayoutParams
        val h = statusInset + dp(2)
        if (lp.height != h) {
            lp.height = h
            v.layoutParams = lp
        }
        v.setBackgroundColor(c)
        v.visibility = if (statusInset > 0) View.VISIBLE else View.GONE
    }

    private fun showLogin() {
        paintSystemBarPage()
        binding.viewLogin.visibility = View.VISIBLE
        binding.viewDevices.visibility = View.GONE
        binding.viewPanel.visibility = View.GONE
        stopConnWatch()
        binding.phoneInput.setText(SessionStore.account(this) ?: "")
        binding.hubInput.setText(SessionStore.hub(this).let { if (it == SessionStore.DEFAULT_HUB) "" else it })
    }

    /**
     * 设备列表。
     *
     * `fromPanel = true` 表示这一页是**面板的下级**（面板里点「当前设备」进来的）：
     * 左上角给「返回」回面板，右上角的退出图标不画 —— 站在这里退出登录意味着
     * "我看完列表顺手把号退了"，不是这个动作的语义（2026-11-11 用户拍板：
     * "这个页面切换设备，不需要退出按钮，但是需要一个返回按钮"）。
     *
     * 登录后 / 冷启动进来（默认）时它是**根页面**：没有"回来"的地方，所以不画返回，
     * 保留右上角退出 —— 这时退出是唯一能换账号的出口。
     */
    fun showDevices(fromPanel: Boolean = false) {
        paintSystemBarPage()
        devicesFromPanel = fromPanel
        binding.viewLogin.visibility = View.GONE
        binding.viewDevices.visibility = View.VISIBLE
        binding.viewPanel.visibility = View.GONE
        binding.devBackBtn.visibility = if (fromPanel) View.VISIBLE else View.GONE
        binding.logoutBtn.visibility = if (fromPanel) View.GONE else View.VISIBLE
        // 返回钮出现时标题不跟着右移：把标题左内边距收掉（40 钮 + 8 边距已给出左沿）
        binding.devTitle.setPadding(if (fromPanel) 0 else dp(24), 0, dp(24), 0)
        stopConnWatch()   // 离开面板就停探活，别在后台白耗流量
        loadDevices()
    }

    private fun showPanel(origin: String? = null) {
        // 面板是网页画的，两条系统栏带都交给它报色 —— 先把原生页留下的底色条清掉，
        // 页面加载完（ShellBar 上报）再画回去。别让人在半路看到原生的灰。
        topBarColor = null
        topBarStrip?.visibility = View.GONE
        sysBarColor = null
        sysBarStrip?.visibility = View.GONE
        binding.viewLogin.visibility = View.GONE
        binding.viewDevices.visibility = View.GONE
        binding.viewPanel.visibility = View.VISIBLE
        if (origin != null) {
            lastPanelOrigin = origin
            startConnWatch(origin)
        } else stopConnWatch()
    }

    /** 设备列表的「返回」：回面板。WebView 里的页面一直没卸载，切回来即原样（不重载） */
    private fun backToPanel() {
        showPanel(lastPanelOrigin)
    }

    /* -------------------------------------------------- 面板在线状态（connBar） */

    /*
     * 电脑下线时，WebView 里**正在跑的页面不会自己报错**：SSE 静默重连、按钮点了没反应，
     * 用户看到的是"页面活着但什么都不响应"（2026-11-08 用户："不够优雅"）。
     *
     * 这一层只有壳能画：探进面板时那个 origin 的 /api/hello（2 秒超时），
     *   · 连续 2 次不通 → 顶上滑出琥珀色条「这台电脑已离线 · 正在重连…」+「返回列表」；
     *   · 再探通 → 变绿「已恢复连接」，1.4 秒后自己收起（不打断用户手上的事）。
     *
     * 为什么坚持**探**而不是挂长连接（2026-11-08 讨论结论，参考 WorkBuddy 的 WS 心跳模型）：
     * frps 转发下"新连接"比"旧连接超时"更快暴露真相 —— 电脑正常关机时 frps 立刻拒新连接，
     * 断电时新请求掉进黑洞、2 秒超时即失败；而一条已建立的长连接要等 frps 自己超时才知道
     * 对面死了（几十秒），还会出现"连接在、通道死"的假在线。探测每次都是新请求，骗不了自己。
     *
     * 节奏改成「该快时快、平时省」（2026-11-08）：
     *   · 健康 10 秒一问；头一次失败 1 秒后复核（防一次抖动就出条）；已判离线 5 秒一问
     *   · 触发源不只定时：网络切换/恢复、App 回前台、面板加载完成，都立刻补一次，不等周期
     *   · App 退到后台停探（不在后台白耗电和流量），回前台立刻补一次
     * 串行探测（一次没回来不排下一次），不会在网络差时堆一堆线程。
     */
    private enum class ConnState { HIDDEN, OFFLINE, RECOVERED }

    private var connOrigin: String? = null
    private var connFails = 0
    private var connState = ConnState.HIDDEN
    /** 退到后台时置位：只停探、不丢 origin —— 回前台按原地址续上 */
    private var connPaused = false
    private val connHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private val connTick = object : Runnable {
        override fun run() {
            val origin = connOrigin ?: return
            pool.execute {
                val ok = Probe.probe(origin, timeoutMs = CONN_TIMEOUT_MS) != null
                runOnUiThread {
                    if (connOrigin != origin) return@runOnUiThread // 已换机器 / 已离开面板
                    renderConn(ok)
                    scheduleConn(nextConnDelay())
                }
            }
        }
    }

    private fun startConnWatch(origin: String) {
        stopConnWatch()
        connOrigin = origin
        connFails = 0
        connState = ConnState.HIDDEN
        connPaused = false
        scheduleConn(CONN_INTERVAL_OK) // 刚进门先让页面加载，别立刻判离线
    }

    private fun stopConnWatch() {
        connOrigin = null
        connFails = 0
        connState = ConnState.HIDDEN
        connPaused = false
        connHandler.removeCallbacks(connTick)
        binding.connBar.visibility = View.GONE
        binding.viewOffline.visibility = View.GONE
    }

    /**
     * 排下一次探测 —— **唯一排程入口**。
     * 全部走它，才不会出现"暂停后又被某个回调偷偷唤醒一头探测"这种失控。
     */
    private fun scheduleConn(delayMs: Long) {
        connHandler.removeCallbacks(connTick)
        if (connPaused || connOrigin == null) return
        connHandler.postDelayed(connTick, delayMs)
    }

    /** 事件触发的那一路：网络变了 / 回前台 / 页面刚加载完，立刻补一次，不等周期 */
    private fun pokeConnWatch(delayMs: Long = 400L) = scheduleConn(delayMs)

    private fun nextConnDelay(): Long = when {
        connFails <= 0 -> CONN_INTERVAL_OK        // 健康：10 秒一问，省流量
        connFails == 1 -> CONN_INTERVAL_FAST      // 头一次失败：1 秒后复核，别为一次抖动出条
        else -> CONN_INTERVAL_OFFLINE             // 已判离线：5 秒一问，恢复几秒内就能看到
    }

    private fun renderConn(ok: Boolean) {
        if (ok) {
            connFails = 0
            if (connState != ConnState.OFFLINE) return // 本来就没提示条：不必闪一下"已恢复"
            connState = ConnState.RECOVERED
            // 状态切换才落日志（每 10 秒一条会淹没 logcat）；排查"为什么显示离线"看这一行
            android.util.Log.i("BandiConn", "recovered: $connOrigin 探通了")
            paintConnBar(recovered = true)
            /*
             * 被蒙版挡住的这段时间，页面很可能已经"死"了（如果它本来就是加载失败收场）。
             * 已经画着错误层的，恢复后替用户重发一次 —— 不然蒙版一收，露出的是旧的错误页，
             * 用户得自己再点一次"重试"，那这层自动化就白做了。
             */
            if (panelErrorShown) binding.panelWebView.reload()
            connHandler.postDelayed({
                if (connState == ConnState.RECOVERED) {
                    connState = ConnState.HIDDEN
                    binding.connBar.visibility = View.GONE
                }
            }, 1_400)
            return
        }
        connFails++
        if (connFails < CONN_FAILS_TO_OFFLINE || connState == ConnState.OFFLINE) return // 偶发抖动不算离线
        connState = ConnState.OFFLINE
        android.util.Log.i("BandiConn", "offline: $connOrigin 连续 $connFails 次探不通")
        paintConnBar(recovered = false)
    }

    /**
     * 两个方向各画一个东西：
     *   · 离线 → **整页蒙版**（用户 2026-11-08 拍板）：页面已经死透，在上面点来点去没有意义，
     *     与其让用户对着不响应的界面猜，不如把"不能操作"直接说清，再给两条出路。
     *     蒙版是盖在 WebView 上的**同一页**（不是跳转到白页），页面本体留在原地 ——
     *     恢复时只要收掉蒙版就接着用，不重新加载、不丢滚动位置和输入。
     *   · 恢复 → 收起蒙版，顶部闪一条绿色「已恢复连接」，1.4 秒后自己消失。
     */
    private fun paintConnBar(recovered: Boolean) {
        if (recovered) {
            binding.viewOffline.visibility = View.GONE
            binding.connBar.visibility = View.VISIBLE
            binding.connBar.setBackgroundColor(0xFFE7F6EA.toInt())
            binding.connText.setTextColor(0xFF1F6E33.toInt())
            binding.connText.text = "已恢复连接"
            binding.connAction.visibility = View.GONE
        } else {
            binding.connBar.visibility = View.GONE
            binding.offlineAddr.text = connOrigin?.substringBefore('?') ?: ""
            binding.offlineAddr.visibility = if (connOrigin != null) View.VISIBLE else View.GONE
            binding.viewOffline.visibility = View.VISIBLE
        }
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
        // 右上角的退出图标：与面板里的「退出登录」同一条路（清中枢会话 + 机器 Cookie → 落登录页）
        // 只在"从登录页进来的这一页"上出现（见 showDevices 的 fromPanel）。
        binding.logoutBtn.setOnClickListener { onPanelLoggedOut() }
        // 左上角的返回：面板里点「当前设备」进来时才出现，回面板（WebView 原样，不重载）
        binding.devBackBtn.setOnClickListener { backToPanel() }
    }

    private fun loadDevices() {
        val session = SessionStore.session(this) ?: run {
            showLogin()
            return
        }
        val hub = SessionStore.hub(this)
        binding.devSub.text = "正在读取名册…"
        binding.deviceList.removeAllViews()
        probed.clear()          // 新一轮探活：整表先回到「检测中」，别把上一轮的结果顶在屏幕上
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
                        /*
                         * `optString` 对 JSON 里的 null 会回字符串 "null"（不是空串），
                         * 所以判据放在 startsWith("http")，别用 isEmpty —— 否则没开通
                         * 外网访问的机器会拼出一个 "null" 的候选地址去探。
                         */
                        publicUrl = d.optString("publicUrl", "").trim().takeIf { it.startsWith("http") },
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

    /** 逐台并行探活（每台最多试前四个候选地址），通不通都算"有结果" → 标「在线 / 离线」 */
    private fun probeDevices(round: Int) {
        for (d in devices) {
            pool.execute {
                var found: String? = null
                /*
                 * 4 个而不是 3 个：候选里的第一个现在可能是中转地址（见 DeviceRow.origins），
                 * 它探不通时要还剩下三个局域网地址可试 —— 否则少试一台的局域网，
                 * 出现的会是"明明在家却显示离线"。
                 */
                for (origin in d.origins().take(4)) {
                    if (probeRound.get() != round) return@execute
                    if (Probe.probe(origin) != null) { found = origin; break }
                }
                if (probeRound.get() != round) return@execute
                if (found != null) reach[d.id] = found
                /*
                 * 只有**这台第一次出结果**时才重绘：探通与探不通都要落一个明确的
                 * 「在线 / 离线」，不能像原来那样"探不通就什么都不做"（那样界面永远
                 * 停在检测中）。`add` 的返回值天然去重，避免同一台反复重建整张表。
                 */
                if (probed.add(d.id)) {
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
            binding.deviceList.addView(deviceCard(d, r, probing = !probed.contains(d.id)))
        }
    }

    private fun deviceCard(d: DeviceRow, reachedOrigin: String?, probing: Boolean): View {
        val card = com.google.android.material.card.MaterialCardView(this)
        card.layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT,
        ).apply { setMargins(0, 8, 0, 8) }
        /*
         * 卡片**自己指定白底 + 1dp 发丝边**，不再吃主题的 colorSurface（2026-11-07 实机
         * 装机发现）：Material3 的 colorSurface 与窗口底色是同一个值（本机实测都是
         * #FEF7FF），卡片和页面糊成一片，只剩 1dp elevation 的阴影 —— 换台机器就完全
         * 看不见"这是一个能点的卡"。白底 + #14000000 的边在任何浅色板上都立得住，
         * 也和本壳写死的 primary_text_light 正文色是同一套假设（壳本来就只做了浅色）。
         */
        card.setCardBackgroundColor(0xFFFFFFFF.toInt())
        card.strokeWidth = dp(1)
        card.strokeColor = 0x14000000
        card.cardElevation = dp(1).toFloat()
        card.radius = resources.displayMetrics.density * 16
        /*
         * 只有「在线」的卡能点进去（2026-11-07 用户：「在线才能点进去，检测中和离线则不可点击」）。
         *
         * 以前三态都可点：离线那台点下去，enterDevice 会先从 reach 里取不到地址、退回
         * origins().firstOrNull()，于是发一张票、Cookie 全清、切到 WebView，再等一个必然
         * 超时的白屏才退回来 —— 用户看到的是"点了一下，进去一片空，又弹回来"。
         * 探活已经把结论摆在卡上了，就不该再让人凭这个结论去撞一次墙。
         *
         * 不可点时只收掉「能点」这件事本身，**不把卡片调灰**（2026-11-07 用户：「卡片不要
         * 变成灰色，不好看」）：整张卡 alpha 0.6 虽然一眼看出"点不动"，但连名字和地址都
         * 一起淡了，一排机器看着像整页失效。状态已经由右边的胶囊说清楚了（离线/检测中），
         * 卡片保持原样反而更像一张"清单"，而不是一排坏掉的按钮。
         *   1. isClickable / isFocusable = false —— 水波纹和按下态没了，点了确实没反应；
         *   2. isEnabled = false —— 只给无障碍用：TalkBack 会报"已停用"，不再承诺可操作。
         * 检测中也走这一支：它此刻确实进不去，等结果回来重绘时才变成可点。
         */
        val online = !probing && reachedOrigin != null
        card.isClickable = online
        card.isFocusable = online
        card.isEnabled = online
        if (online) {
            card.setOnClickListener { enterDevice(d.id) }
        } else {
            card.contentDescription = "${d.name}，${if (probing) "正在检测" else "离线"}，暂时无法进入"
        }

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

        /*
         * 状态章（2026-11-07 用户：「可连」改成在线 / 离线，要那种在线离线图标）。
         *
         * 原来的 `holo_green_light`(#99CC00) 配白字对比度只有 ~1.9:1 —— 远低于 WCAG AA
         * 的 4.5:1，白字在亮黄绿上基本糊成一片，也没法和卡片白底拉开层次。现在统一成
         * 「7dp 圆点 + 两个字」的小胶囊：圆点给"一眼看到状态"的信息，文字给准确语义。
         *   在线   #15803D on #ECFDF5（绿 700/50）≈5.0:1
         *   离线   #64748B on #F1F5F9（slate 500/100）≈4.6:1
         *   检测中 同上字色、不画底（见下）
         * 三种状态都吃同一个 minWidth：字数是 2 / 2 / 3，不固定宽度的话探活结果
         * 陆续回来时右侧标签会左右跳。
         */
        val badge = when {
            /*
             * 检测中**不画胶囊**（底色透明）：胶囊＝"已经有结论"，这是这套状态语言里
             * 唯一的形状规则。刚进页面时整表都是两三百毫秒的检测中，一堆灰胶囊反而比
             * 一个素字更吵；等结果回来，它才"长出"底色，状态变化也更显眼。
             */
            probing -> statusChip("检测中", 0xFF64748B.toInt(), 0x00000000, 0xFFCBD5E1.toInt())
            reachedOrigin != null -> statusChip("在线", 0xFF15803D.toInt(), 0xFFECFDF5.toInt(), 0xFF22C55E.toInt())
            else -> statusChip("离线", 0xFF64748B.toInt(), 0xFFF1F5F9.toInt(), 0xFF94A3B8.toInt())
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

    /**
     * 「在线 / 离线 / 检测中」状态章：**圆点 + 文字**的小胶囊。
     *
     * 为什么是"圆点 + 字"而不是只有字：颜色单独撑不起语义（色弱用户 / 强光下偏色时，
     * 深浅两档灰绿很难分），只有字又太"表格"。两者并置 —— 圆点负责扫一眼，
     * 文字负责不误解，这也是各家「在线状态」的通行做法。
     *
     * 走 compound drawable（不是再套一层 LinearLayout）：一个 TextView 解决，
     * 列表里几十个节点也省得膨胀；圆点的 dp 尺寸写进 GradientDrawable#setSize，
     * 这样 intrinsic size 就是我们要的直径，不用额外 setBounds。
     */
    private fun statusChip(label: String, textColor: Int, bgColor: Int, dotColor: Int): TextView {
        val tv = TextView(this)
        tv.text = label
        tv.textSize = 12f
        tv.gravity = android.view.Gravity.CENTER
        tv.minWidth = dp(62)
        tv.setTextColor(textColor)
        tv.setPadding(dp(9), dp(4), dp(11), dp(4))
        tv.background = GradientDrawable().apply {
            cornerRadius = dp(99).toFloat()   // 足够大 → 胶囊形，不随高度变化失真
            setColor(bgColor)
        }
        val dot = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(dotColor)
            setSize(dp(7), dp(7))
        }
        tv.setCompoundDrawablesRelativeWithIntrinsicBounds(dot, null, null, null)
        tv.compoundDrawablePadding = dp(6)
        return tv
    }

    /** dp → px（这个壳的排版全按 dp 写，代码里现算的地方统一走它） */
    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

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
        val session = SessionStore.session(this) ?: run { reentering = false; backToLogin(null); return }
        val hub = SessionStore.hub(this)
        currentDeviceId = id   // 会话过期时靠它重新签票（reenter）
        binding.devSub.text = "正在进入…"
        pool.execute {
            try {
                val ticket = HubApi.ticket(hub, session, id)
                val dev = devices.find { it.id == id } ?: d
                val origin = reach[id] ?: dev.origins().firstOrNull()
                if (origin == null) {
                    runOnUiThread {
                        reentering = false
                        binding.devSub.text = "这台电脑还没上报地址，先在它上面打开班底"
                    }
                    return@execute
                }
                runOnUiThread {
                    binding.devSub.text = "点一台进去"
                    /*
                     * **只精确清掉已退场的那枚令牌，不再整罐清**（2026-11-08 改）。
                     *
                     * 原来这里每次进门都 `removeAllCookies(null)`：那是**异步**任务，可能
                     * 排在 /hub/enter 的 Set-Cookie 之后落地，把刚拿到的 bandi_sid 一起删掉
                     * —— 表现就是"点进去直接是登录页"，且时灵时不灵（用户实报好几次）。
                     *
                     * 现在只删 bandi_token：设备令牌体系 2026-11-07 已退场，这枚只可能是
                     * 升级前的残留；它和本次要发的会话是两个 key，先后顺序再怎么变都不会
                     * 误删。服务端 /hub/enter 里也有同样的清理，这里只是兜住旧机器进程。
                     */
                    CookieManager.getInstance().setCookie(origin, "bandi_token=; Max-Age=0; Path=/")
                    pendingClearHistory = true
                    hidePanelError()   // 换一台机器是全新加载：上一台留下的错误层不跟着进门
                    showPanel(origin)  // 顺带盯着这台电脑在不在（离线时顶部出提示条）
                    // 机器验票后 302 到 / 并发会话 Cookie；CookieManager 默认接收，
                    // 后续面板请求自动带上
                    binding.panelWebView.loadUrl("$origin/hub/enter?ticket=${android.net.Uri.encode(ticket)}")
                    // 注意：reentering 要等页面真的加载完（onPageFinished）再复位 ——
                    // 这中间 WebView 若又被 302 到 /hub/expired，正是要拦掉的那种连打。
                }
            } catch (e: Exception) {
                runOnUiThread {
                    reentering = false
                    binding.devSub.text = e.message ?: "签票失败"
                    if ((e as? HubException)?.status == 401) backToLogin("登录已过期，请重新登录")
                }
            }
        }
    }

    /**
     * 静默重进：用中枢会话重新签一张票，重新加载这台的 /hub/enter。
     *
     * 不弹任何东西、不经过设备列表 —— 用户手上的事还在 WebView 里，换张票就回来。
     * 两次签不出来就不硬试了（中枢/账号那边真有事），回列表并把原因写在副标题上。
     */
    fun reenter() {
        if (reentering) return
        val id = currentDeviceId
        // 名单里已经没有这台（人刚删掉/换了账号）：回列表比空转有用
        if (id == null || devices.none { it.id == id }) { showDevicesFromPanel(); return }
        if (reenterFails >= 2) {
            reenterFails = 0
            showDevicesFromPanel()
            binding.devSub.text = "会话过期了，重新点一次这台电脑"
            return
        }
        reenterFails++
        reentering = true
        enterDevice(id)
    }

    /* ------------------------------------------------------------ 面板 WebView */

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        val wv = binding.panelWebView
        /*
         * 调试包开 WebView 远程调试（2026-11-12）：这台手机 `adb shell input` 被系统禁掉
         * （INJECT_EVENTS），点不动卡片就进不了面板 —— 只能靠临时代码改一遍、编一遍
         * （27 秒一轮）再去截图。开了之后：
         *   adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
         * 就能从电脑端 CDP 进壳里的网页，点按钮、切页面、读计算样式。
         * 只在 DEBUG 包里开：release 包不带调试端口。
         */
        if ((applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            android.webkit.WebView.setWebContentsDebuggingEnabled(true)
        }
        CookieManager.getInstance().setAcceptCookie(true)
        /*
         * **壳标记**（2026-11-08）：服务端靠 UA 末尾的 `BandiShell/<版本>` 分辨"人"和"壳" ——
         * 面板请求没有会话时，浏览器给登录页，壳给 302 /hub/expired 让它静默重签票
         * （server 的 auth.mjs → serveLoginOrReenter）。没有这一行，壳里会话一过期就必然
         * 弹出中枢账号密码框，而壳其实随时能自己换一张票。
         *
         * 版本号取自 AndroidManifest 的 versionName（不引 BuildConfig：AGP 8 默认关着它，
         * 为一个字符串去改构建配置不划算）。
         */
        @Suppress("DEPRECATION")
        val appVer = runCatching { packageManager.getPackageInfo(packageName, 0).versionName }
            .getOrNull() ?: "0"
        val baseUa = wv.settings.userAgentString ?: ""
        if (!baseUa.contains("BandiShell/")) {
            wv.settings.userAgentString = "$baseUa BandiShell/$appVer"
        }
        wv.settings.javaScriptEnabled = true
        wv.settings.domStorageEnabled = true
        wv.addJavascriptInterface(BandiShell(this), "BandiShell")
        wv.webViewClient = object : WebViewClient() {
            /*
             * **会话过期的改道点**（2026-11-08）：服务端认出壳、又没有会话，就 302 到这里。
             * 接住它、不真加载 —— 用中枢会话重新签一张票进门，人看不到任何登录页。
             * 返回 true 才是"我处理了"；别的 URL 一律交回 WebView。
             */
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: android.webkit.WebResourceRequest,
            ): Boolean {
                if (request.url.path == "/hub/expired") {
                    reenter()
                    return true
                }
                return false
            }

            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                // 新一次加载开始：先当它没失败。真失败时 onReceivedError 随后会把标记翻回来
                panelErrorThisPage = false
            }

            override fun onReceivedError(
                view: WebView,
                request: android.webkit.WebResourceRequest,
                error: android.webkit.WebResourceError,
            ) {
                // 只拦主框架：面板里某个子资源（图标/图片）挂了不该把整页换成错误层
                if (!request.isForMainFrame) return
                // 主框架都没起来：这次重进到此为止（别把防重入卡死在 true 上）
                reentering = false
                panelErrorThisPage = true
                val failing = request.url.toString()
                // 细节按项目口径只落日志，界面只给错误码 + 人话（E0001 同 ui.mjs 口径）
                android.util.Log.w("BandiPanel", "E0001 main-frame ${error.errorCode} ${error.description} $failing")
                showPanelError(failing)
            }

            override fun onPageFinished(view: WebView, url: String) {
                // 这次加载收了尾：静默重进的防重入放开（换票后的那次加载到这里结束）
                reentering = false
                // 只在「刚进一台机器」的边界清一次历史：面板内部的 pushState 导航不受影响，
                // 返回键从此不会摸到上一台机器的页面
                if (pendingClearHistory) {
                    pendingClearHistory = false
                    view.clearHistory()
                }
                // 加载成功收掉错误层；失败收场的那次留着（重试成功后自然走到这里收掉）
                if (!panelErrorThisPage) {
                    reenterFails = 0   // 面板真的出来了 = 票换成功，连败计数归零
                    hidePanelError()
                    /*
                     * 主框架加载成功 = 这台机器此刻确实活着。顺手把状态归位：
                     * 清掉失败计数、收掉可能残留的离线条、按健康节奏续上探测
                     * （不复用这次加载当探测，免得进门瞬间多打一次往返）。
                     */
                    connFails = 0
                    if (connState != ConnState.HIDDEN) {
                        connState = ConnState.HIDDEN
                        binding.connBar.visibility = View.GONE
                    }
                    binding.viewOffline.visibility = View.GONE   // 页面都加载出来了，蒙版没有理由留着
                    scheduleConn(CONN_INTERVAL_OK)
                }
            }
        }
        setupPanelErrorActions()
    }

    /**
     * 面板里的「当前设备」→ 回原生设备列表（WebView 实例留着，切机器时复用）。
     * 传 true：这一页此刻是面板的下级 —— 左上角给「返回」，不给退出。
     */
    fun showDevicesFromPanel() {
        showDevices(fromPanel = true)
    }

    /* -------------------------------------------------------- 离线蒙版的动作 */

    private fun setupOfflineActions() {
        // 立即重试：绕过 5 秒的离线节奏，马上探一次；通了就自动收起（走"已恢复"那条路）
        binding.offlineRetryBtn.setOnClickListener {
            android.util.Log.i("BandiConn", "retry: 用户点了立即重试")
            pokeConnWatch(0)
        }
        binding.offlineBackBtn.setOnClickListener { showDevicesFromPanel() }
        // 蒙版只是盖着，底下的 WebView 仍会吃触摸 —— 明确拦一下，别出现"点蒙版把页面点动了"
        binding.viewOffline.setOnClickListener { /* 吃掉 */ }
    }

    /* ------------------------------------------------------ 面板兜底层（连不上） */

    /**
     * 盖上「连不上这台机器」。failingUrl 只取 `?` 前面的部分亮在页面上：
     * /hub/enter 的 query 里是**签票**（凭据），不能显示在屏幕上；
     * 地址本身（哪台机、哪个口）是排查要用的，保留。
     */
    private fun showPanelError(failingUrl: String) {
        panelErrorShown = true
        binding.panelErrAddr.text = failingUrl.substringBefore('?')
        binding.panelErrAddr.visibility = View.VISIBLE
        binding.viewPanelError.visibility = View.VISIBLE
    }

    private fun hidePanelError() {
        panelErrorShown = false
        binding.viewPanelError.visibility = View.GONE
    }

    private fun setupPanelErrorActions() {
        /*
         * 重试：reload 原样重发当前（失败的）URL —— 不重新签票。票还在 Cookie/会话里，
         * 真过期了机器侧会自己引导登录；多数场景（电脑被唤醒、网络恢复）reload 就够。
         * 成功 → onPageFinished(!panelErrorThisPage) 收层；再失败 → onReceivedError 重新盖上。
         */
        binding.panelRetryBtn.setOnClickListener { binding.panelWebView.reload() }
        binding.panelBackBtn.setOnClickListener {
            hidePanelError()
            showDevicesFromPanel()
        }
        // 连接状态条上的「返回列表」：离线时不去死等，直接给一条出路
        binding.connAction.setOnClickListener {
            hidePanelError()
            showDevicesFromPanel()
        }
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
                    // 蒙版挡着时，页面本身没法操作（返回键改页面用户也看不见），
                    // 所以返回 = 蒙版上「返回设备列表」那颗按钮，语义一致、不会"按了没反应"
                    binding.viewOffline.visibility == View.VISIBLE -> showDevicesFromPanel()
                    // 设备列表是面板的下级（面板里点「当前设备」进来的）→ 返回键回面板，
                    // 跟左上角那颗「返回」一个语义（2026-11-11）。从登录页进来的列表是根，
                    // 落到下面的 else（退回桌面），别把人莫名其妙丢回一个面板。
                    binding.viewDevices.visibility == View.VISIBLE && devicesFromPanel -> backToPanel()
                    binding.viewPanel.visibility == View.VISIBLE -> {
                        // 面板：先问网页「还有上一层吗」（2026-11-11）—— 不再问 canGoBack
                        webBack()
                    }
                    else -> moveTaskToBack(true)
                }
            }
        })
    }

    /**
     * 面板返回（2026-11-11 用户实报「定时任务页按返回直接退出 APP」）。
     *
     * 以前这里问 `canGoBack()` —— 那是**浏览器历史**，不是 App 的层级：
     *   · 换机器时 onPageFinished 会 clearHistory()，把网页开机种的那格「井」一起抹掉，
     *     从此 canGoBack 恒 false，**任何页面**按返回都退后台；
     *   · 反过来，有些页面压根不压格，按返回也只是"没反应"。
     * 现在问网页自己：`bandiCanGoUp()`（navstack.mjs 给的唯一真源）。
     *   true  → `bandiBack()` 退一层（浮层 → 下钻页 → 非首页 tab 回工作台）
     *   false → 已经在根页，退到桌面（Android 标准，腾讯系 App 也是这个手感）
     *   legacy（旧缓存脚本没这两个钩子）→ 退回老逻辑，别把旧页面卡死。
     * 注意结果要 trim 引号：字符串 'legacy' 回包是带引号的，布尔是裸的 true/false。
     */
    private fun webBack() {
        val web = binding.panelWebView
        web.evaluateJavascript("(typeof bandiCanGoUp === 'function') ? bandiCanGoUp() : 'legacy'") { raw ->
            when (raw?.trim()?.trim('"')) {
                "true" -> web.evaluateJavascript("bandiBack()", null)
                "legacy" -> if (web.canGoBack()) web.goBack() else moveTaskToBack(true)
                else -> moveTaskToBack(true)
            }
        }
    }

    private companion object {
        /** 健康时的探测间隔：10 秒（一次往返几百字节，正常在面板里挂着一天也不心疼） */
        const val CONN_INTERVAL_OK = 10_000L
        /** 头一次失败后的复核间隔：1 秒内就能澄清这次抖动是不是真的 */
        const val CONN_INTERVAL_FAST = 1_000L
        /** 已判离线后的间隔：5 秒一问，电脑回来几秒内就变绿 */
        const val CONN_INTERVAL_OFFLINE = 5_000L
        /**
         * 单次探测超时：局域网地址用这一档（快了才判得出"真断了"）。
         *
         * ⚠️ 中转地址（https://）不吃这个值 —— `Probe` 内部会按 RELAY_TIMEOUT_MS（8 秒）
         * 兜底。2026-11-08 实报：中转链路往返 2~4 秒，用 2 秒判断会一直显示离线。
         * 探测是串行的（一次没回来不排下一次），所以超时变长不会堆积请求，
         * 代价只是"真断了"要多等几秒才显示出来。
         */
        const val CONN_TIMEOUT_MS = 2_000
        /** 连续几次不通才算离线：1 会把偶发丢包、息屏瞬间都报成掉线 */
        const val CONN_FAILS_TO_OFFLINE = 2
    }
}
