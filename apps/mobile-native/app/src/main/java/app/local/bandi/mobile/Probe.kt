/*
 * Probe.kt —— 局域网探活（原生壳版）：裸 TCP + 明文 GET /api/hello。
 *
 * 为什么探：名册里的 lanAddrs 是**候选**，手机当前网段里哪个通只有手机知道；
 * 探到的地址才拿去拼 /hub/enter。口径与 Tauri 壳的 Rust probe 完全一致：
 * 4 秒超时、必须认 platform=="bandi"、https 目标不探（裸 TCP 对 443 必被
 * TLS 挡回来，探了只会误报「未探到」）。
 */
package app.local.bandi.mobile

import org.json.JSONObject
import java.net.InetSocketAddress
import java.net.Socket

data class ProbeInfo(val label: String?, val hostname: String?)

object Probe {

    /** 探一台。失败（不通 / 不是班底 / https）返回 null —— 调用方换下一个候选地址 */
    fun probe(origin: String): ProbeInfo? {
        if (origin.startsWith("https://")) return null
        val m = Regex("^http://([^/]+)").find(origin) ?: return null
        val hostPort = m.groupValues[1]
        val idx = hostPort.lastIndexOf(':')
        val host = if (idx > 0) hostPort.substring(0, idx) else hostPort
        val port = if (idx > 0) hostPort.substring(idx + 1).toIntOrNull() ?: 18787 else 18787

        val sock = Socket()
        try {
            sock.connect(InetSocketAddress(host, port), 4_000)
            sock.soTimeout = 4_000
            val req = "GET /api/hello HTTP/1.1\r\n" +
                "Host: $host:$port\r\n" +
                "User-Agent: bandi-mobile-native\r\n" +
                "Accept: application/json\r\n" +
                "Connection: close\r\n\r\n"
            sock.getOutputStream().write(req.toByteArray(Charsets.UTF_8))
            val text = sock.getInputStream().bufferedReader().readText()
            val status = text.lineSequence().firstOrNull() ?: return null
            if (!status.contains(" 200")) return null
            val body = text.substringAfter("\r\n\r\n", "")
            val json = JSONObject(body)
            if (json.optString("platform") != "bandi") return null
            return ProbeInfo(
                label = json.optString("label", "").ifEmpty { null },
                hostname = json.optString("hostname", "").ifEmpty { null },
            )
        } catch (_: Exception) {
            return null
        } finally {
            try { sock.close() } catch (_: Exception) { }
        }
    }
}
