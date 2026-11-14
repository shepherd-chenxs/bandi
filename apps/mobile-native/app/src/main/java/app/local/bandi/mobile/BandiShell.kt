/*
 * BandiShell.kt —— 面板（机器网页）→ 原生壳的桥。
 *
 * addJavascriptInterface 挂上之后，壳内加载的**任何页面**都能调用 window.BandiShell.*
 * （能进到这个 WebView 的页面只有各台机器自己的面板，信任域一致）。
 * 消费方：apps/web/js/settings.mjs 的「当前设备」行与「退出登录」——
 * 功能检测到 window.BandiShell 就调方法，检测不到（桌面 / PWA / 旧 Tauri 壳）
 * 走各自原有路径，行为一个字节不变。
 *
 *   · openDeviceList()  面板「当前设备」→ 回原生设备列表，选另一台即切换
 *   · onLoggedOut()     面板「退出登录」（机器会话已由面板自己 /api/logout 清掉）
 *                       → 原生清中枢会话 + 机器 Cookie，落回登录页
 *   · sessionExpired()  面板发现本机会话过期（API 回 E4010/E4012）→ 壳用中枢会话
 *                       重新签票进门（2026-11-08）。**这不是退出登录**：中枢会话还在，
 *                       换的只是这台机器的那张票
 */
package app.local.bandi.mobile

import android.webkit.JavascriptInterface

class BandiShell(private val host: MainActivity) {

    @JavascriptInterface
    fun openDeviceList() {
        // 从面板进来的设备列表是「下级」：左上角给「返回」、不画退出（2026-11-11）。
        // 不能直接调 showDevices() —— 那是登录后进来的根页形态。
        host.runOnUiThread { host.showDevicesFromPanel() }
    }

    @JavascriptInterface
    fun onLoggedOut() {
        host.runOnUiThread { host.onPanelLoggedOut() }
    }

    /**
     * 本机会话过期（12 小时绝对 / 30 分钟空闲）—— 静默换一张票，别把登录页画给人。
     *
     * 与服务端那条 302 `/hub/expired` 是**同一件事的两个触发点**：页面还没加载完就被
     * 401 打回来时，走这条；整页加载时没有会话，走那条。
     */
    @JavascriptInterface
    fun sessionExpired() {
        host.runOnUiThread { host.reenter() }
    }

    /**
     * 底部那条栏的颜色 → 系统导航栏那条带（2026-11-11 用户："底部导航栏跟系统导航栏
     * 改成一个颜色"）。
     *
     * 传 CSS 里 `--mb-chrome` 的实色（`#RRGGBB`）；传空串表示当前页没有底栏
     * （详情 / 聊天页），壳收起色块、恢复成窗口背景。
     * 壳只做两件事：画一条导航键区那么高的色块（edge-to-edge 下那条带露的是窗口背景，
     * 网页画不到），再按亮度调导航键的明暗（深底画深色键等于没有键）。
     * 网页那边在 applyTheme + body class 变化时报（shell.mjs syncShellBar）。
     */
    @JavascriptInterface
    fun setSystemBarColor(css: String) {
        host.runOnUiThread { host.applySystemBarColor(css) }
    }

    /**
     * 顶栏的颜色 → **状态栏**那条带（2026-11-12 用户截图："这两个统一一下颜色"：
     * 状态栏一行浅灰、紧挨着的「工作台」标题栏是白的）。
     *
     * 跟底部同一个病根、同一套解法：WebView 被壳的 top padding 压到状态栏下面，
     * 那条带露窗口背景（= 页面底色）。网页报来"贴着视口顶上的那条栏"的实色，
     * 壳在 DecorView 顶上贴一条状态栏那么高的色块。
     * 传空串 = 收起（页面顶部自己铺，谁也不用补）。
     */
    @JavascriptInterface
    fun setTopBarColor(css: String) {
        host.runOnUiThread { host.applyTopBarColor(css) }
    }
}
