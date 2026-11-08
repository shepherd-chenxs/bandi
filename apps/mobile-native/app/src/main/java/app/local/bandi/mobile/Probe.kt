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

    /** 探一台。失败（不通 / 不是班底 / 证书不过）返回 null —— 调用方换下一个候选地址 */
    fun probe(origin: String, timeoutMs: Int = 4_000): ProbeInfo? {
        val url = runCatching { URL(origin.trimEnd('/') + "/api/hello") }.getOrNull() ?: return null
        val conn = runCatching { url.openConnection() as HttpURLConnection }.getOrNull() ?: return null
        return try {
            conn.connectTimeout = timeoutMs
            conn.readTimeout = timeoutMs
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
