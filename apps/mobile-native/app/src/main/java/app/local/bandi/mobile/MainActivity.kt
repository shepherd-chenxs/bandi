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

    private fun showLogin() {
        binding.viewLogin.visibility = View.VISIBLE
        binding.viewDevices.visibility = View.GONE
        binding.viewPanel.visibility = View.GONE
        stopConnWatch()
        binding.phoneInput.setText(SessionStore.account(this) ?: "")
        binding.hubInput.setText(SessionStore.hub(this).let { if (it == SessionStore.DEFAULT_HUB) "" else it })
    }

    fun showDevices() {
        binding.viewLogin.visibility = View.GONE
        binding.viewDevices.visibility = View.VISIBLE
        binding.viewPanel.visibility = View.GONE
        stopConnWatch()   // 离开面板就停探活，别在后台白耗流量
        loadDevices()
    }

    private fun showPanel(origin: String? = null) {
        binding.viewLogin.visibility = View.GONE
        binding.viewDevices.visibility = View.GONE
        binding.viewPanel.visibility = View.VISIBLE
        if (origin != null) startConnWatch(origin) else stopConnWatch()
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
        binding.logoutBtn.setOnClickListener { onPanelLoggedOut() }
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
                    hidePanelError()   // 换一台机器是全新加载：上一台留下的错误层不跟着进门
                    showPanel(origin)  // 顺带盯着这台电脑在不在（离线时顶部出提示条）
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
                panelErrorThisPage = true
                val failing = request.url.toString()
                // 细节按项目口径只落日志，界面只给错误码 + 人话（E0001 同 ui.mjs 口径）
                android.util.Log.w("BandiPanel", "E0001 main-frame ${error.errorCode} ${error.description} $failing")
                showPanelError(failing)
            }

            override fun onPageFinished(view: WebView, url: String) {
                // 只在「刚进一台机器」的边界清一次历史：面板内部的 pushState 导航不受影响，
                // 返回键从此不会摸到上一台机器的页面
                if (pendingClearHistory) {
                    pendingClearHistory = false
                    view.clearHistory()
                }
                // 加载成功收掉错误层；失败收场的那次留着（重试成功后自然走到这里收掉）
                if (!panelErrorThisPage) {
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

    /** 面板里的「当前设备」→ 回原生设备列表（WebView 实例留着，切机器时复用） */
    fun showDevicesFromPanel() {
        showDevices()
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

    private companion object {
        /** 健康时的探测间隔：10 秒（一次往返几百字节，正常在面板里挂着一天也不心疼） */
        const val CONN_INTERVAL_OK = 10_000L
        /** 头一次失败后的复核间隔：1 秒内就能澄清这次抖动是不是真的 */
        const val CONN_INTERVAL_FAST = 1_000L
        /** 已判离线后的间隔：5 秒一问，电脑回来几秒内就变绿 */
        const val CONN_INTERVAL_OFFLINE = 5_000L
        /** 单次探测超时：必须短于所有间隔，否则一次没回来就会拖住下一轮 */
        const val CONN_TIMEOUT_MS = 2_000
        /** 连续几次不通才算离线：1 会把偶发丢包、息屏瞬间都报成掉线 */
        const val CONN_FAILS_TO_OFFLINE = 2
    }
}
