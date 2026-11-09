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
        host.runOnUiThread { host.showDevices() }
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
}
