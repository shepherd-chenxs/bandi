/*
 * HubApi.kt —— 与身份中枢（将军令）说话的唯一出口（原生壳版）。
 *
 * 三条调用，契约与 bandi-hub/contract.md §三 一致：
 *   · POST /v1/auth/phone-login   手机号 + 密码 → role='user' 的 30 天会话
 *   · GET  /v1/devices            名册（user 只看自己名下那几台）
 *   · POST /v1/devices/:id/ticket 签一张一次性票（5 分钟），拿去 <机器>/hub/enter 进门
 *
 * 错误统一成「人话」挂进 HubException，UI 原样展示：
 *   · 网络层失败 → 连不上中枢（host）—— DNS / 断网 / 超时
 *   · 中枢回 JSON 错误 → H 码 · 消息（如「H1004 · 手机号或密码不对」）
 *   · 中枢回非 JSON → 中枢回的不是 JSON（HTTP xxx）
 */
package app.local.bandi.mobile

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

class HubException(val status: Int, message: String) : Exception(message)

object HubApi {

    private fun normalizeHub(base: String): String = base.trim().trimEnd('/')

    private fun shortHost(hub: String): String =
        normalizeHub(hub).removePrefix("https://").removePrefix("http://")

    /** 单次 HTTP。返回 (状态码, 正文)；网络层异常向上抛，由调用方转成人话 */
    private fun request(url: String, method: String, session: String?, body: JSONObject?): Pair<Int, String?> {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = method
            conn.connectTimeout = 10_000
            conn.readTimeout = 15_000
            if (session != null) conn.setRequestProperty("authorization", "Bearer $session")
            if (body != null) {
                conn.setRequestProperty("content-type", "application/json")
                conn.doOutput = true
                conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
            val status = conn.responseCode
            val text = try {
                conn.inputStream.bufferedReader().readText()
            } catch (_: Exception) {
                try { conn.errorStream?.bufferedReader()?.readText() } catch (_: Exception) { null }
            }
            return status to text
        } finally {
            conn.disconnect()
        }
    }

    private fun netError(e: Exception, hub: String): HubException =
        HubException(0, "连不上中枢（${shortHost(hub)}）")

    private fun parseError(status: Int, text: String?): HubException {
        if (text != null) {
            try {
                val err = JSONObject(text).optJSONObject("error")
                if (err != null) {
                    val code = err.optString("code", "")
                    val msg = err.optString("message", "中枢拒绝了这次请求（HTTP $status）")
                    return HubException(status, if (code.isNotEmpty()) "$code · $msg" else msg)
                }
            } catch (_: Exception) {
                /* 回的不是 JSON */
            }
        }
        return HubException(status, "中枢回的不是 JSON（HTTP $status）")
    }

    /** 登录 → (session, account 对象) */
    fun phoneLogin(hub: String, phone: String, password: String): Pair<String, JSONObject> {
        val base = normalizeHub(hub)
        val body = try {
            JSONObject().put("username", phone).put("password", password)
        } catch (_: Exception) { JSONObject() }
        val (status, text) = try {
            request("$base/v1/auth/phone-login", "POST", null, body)
        } catch (e: Exception) {
            throw netError(e, hub)
        }
        if (status != 200) throw parseError(status, text)
        val json = try { JSONObject(text ?: "{}") } catch (_: Exception) { throw parseError(status, text) }
        return json.getString("session") to json.getJSONObject("account")
    }

    /** 名册 → 设备数组（原样；user 会话只看得到自己名下那几台） */
    fun devices(hub: String, session: String): JSONArray {
        val base = normalizeHub(hub)
        val (status, text) = try {
            request("$base/v1/devices", "GET", session, null)
        } catch (e: Exception) {
            throw netError(e, hub)
        }
        if (status == 401) throw HubException(401, "登录已过期，请重新登录")
        if (status != 200) throw parseError(status, text)
        return try { JSONObject(text ?: "{}").getJSONArray("devices") } catch (_: Exception) { throw parseError(status, text) }
    }

    /** 签票 → ticket 字符串（一次性，5 分钟） */
    fun ticket(hub: String, session: String, deviceId: String): String {
        val base = normalizeHub(hub)
        val (status, text) = try {
            request("$base/v1/devices/$deviceId/ticket", "POST", session, JSONObject())
        } catch (e: Exception) {
            throw netError(e, hub)
        }
        if (status == 401) throw HubException(401, "登录已过期，请重新登录")
        if (status != 200) throw parseError(status, text)
        return try { JSONObject(text ?: "{}").getString("ticket") } catch (_: Exception) { throw parseError(status, text) }
    }
}
