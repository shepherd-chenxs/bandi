/*
 * Probe.kt —— 探活（原生壳版）：GET /api/hello，认 platform=="bandi"。
 *
 * 为什么探：名册里的地址只是**候选**，哪个通只有手机知道自己现在在哪张网上；
 * 探到的地址才拿去拼 /hub/enter。口径：4 秒超时、必须认 platform=="bandi"。
 *
 * 2026-11-08 改过一次实现：以前是裸 Socket + 明文 HTTP/1.0，`https://` 直接回 null
 * （注释里写着"https 目标不探，裸 TCP 对 443 必被 TLS 挡回来"）。那时候选只有局域网
 * 地址，这话没错；现在名册多了中转地址（`https://ddev-xxxx.<域>`，TLS 在 Cloudflare
 * 边缘终止），照旧逻辑会把「在外面唯一能连」的那台一律判成离线。
 * 所以改用 HttpURLConnection：http / https 同一个入口，证书由系统信任库校验
 * （自签证书的机器本来就进不去，也不该被当成"在线"）。
 */
package app.local.bandi.mobile

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

data class ProbeInfo(val label: String?, val hostname: String?)

object Probe {

    /**
     * 中转地址（`https://`，TLS 在 Cloudflare 边缘终止）的超时下限：8 秒。
     *
     * 2026-11-08 实报：手机上一直显示「这台电脑离线了」，可同一个外网地址在本机 curl
     * 是 200。量了一下——中转链路单次往返 **2~4 秒**（同一请求打本机 3 毫秒），而连接
     * 监视给的是 2 秒超时：探活几乎每一轮都超时，界面于是一直判离线。
     * 隧道没坏，是尺子太短。
     *
     * 局域网地址**不吃这个值**：同一个网里 2 秒都探不通，那就是真不通；放宽只会让
     * "断了"这件事晚 6 秒才显示出来。
     */
    private const val RELAY_TIMEOUT_MS = 8_000

    /** 探一台。失败（不通 / 不是班底 / 证书不过）返回 null —— 调用方换下一个候选地址 */
    fun probe(origin: String, timeoutMs: Int = 4_000): ProbeInfo? {
        val url = runCatching { URL(origin.trimEnd('/') + "/api/hello") }.getOrNull() ?: return null
        val conn = runCatching { url.openConnection() as HttpURLConnection }.getOrNull() ?: return null
        // 中转地址按 RELAY_TIMEOUT_MS 兜底，局域网沿用调用方给的短超时（见上面注释）
        val effective = if (origin.trim().startsWith("https://", ignoreCase = true)) {
            maxOf(timeoutMs, RELAY_TIMEOUT_MS)
        } else {
            timeoutMs
        }
        return try {
            conn.connectTimeout = effective
            conn.readTimeout = effective
            // 不跟随跳转：/api/hello 永远不会 302，跟了反而是被别人牵着走
            conn.instanceFollowRedirects = false
            conn.setRequestProperty("User-Agent", "bandi-mobile-native")
            conn.setRequestProperty("Accept", "application/json")
            if (conn.responseCode != 200) return null
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            val json = JSONObject(body)
            if (json.optString("platform") != "bandi") return null
            ProbeInfo(
                label = json.optString("label", "").ifEmpty { null },
                hostname = json.optString("hostname", "").ifEmpty { null },
            )
        } catch (_: Exception) {
            null
        } finally {
            runCatching { conn.disconnect() }
        }
    }
}
