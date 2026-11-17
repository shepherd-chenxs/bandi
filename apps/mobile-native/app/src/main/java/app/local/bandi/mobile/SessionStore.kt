/*
 * SessionStore.kt —— 中枢会话与地址的本机存储。
 *
 * App 私有 SharedPreferences，与旧启动页的 localStorage 同一保密级别：
 * 存的是中枢发的 30 天会话票与登录名；中枢密码**从不落盘**（登录即换会话）。
 * 会话过期由中枢管（30 天），这里不做过期判断——401 时上层清掉回登录页。
 */
package app.local.bandi.mobile

import android.content.Context

object SessionStore {
    private const val FILE = "bandi-shell"
    private const val K_HUB = "hub.base"
    private const val K_SESSION = "hub.session"
    private const val K_ACCOUNT = "hub.account"
    private const val K_THEME_DARK = "panel.theme.dark"

    const val DEFAULT_HUB = "https://hub.yuancang.space"

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    /** 中枢基址：没改过就是官方默认 */
    fun hub(ctx: Context): String = prefs(ctx).getString(K_HUB, null) ?: DEFAULT_HUB

    fun setHub(ctx: Context, base: String?) {
        prefs(ctx).edit().apply {
            if (base.isNullOrBlank()) remove(K_HUB) else putString(K_HUB, base.trim().trimEnd('/'))
            apply()
        }
    }

    fun session(ctx: Context): String? = prefs(ctx).getString(K_SESSION, null)

    fun setSession(ctx: Context, session: String?) {
        prefs(ctx).edit().apply {
            if (session == null) remove(K_SESSION) else putString(K_SESSION, session)
            apply()
        }
    }

    fun account(ctx: Context): String? = prefs(ctx).getString(K_ACCOUNT, null)

    fun setAccount(ctx: Context, account: String?) {
        prefs(ctx).edit().apply {
            if (account == null) remove(K_ACCOUNT) else putString(K_ACCOUNT, account)
            apply()
        }
    }

    /**
     * 面板主题（已解析成深 / 浅）：true=深、false=浅、null=面板还没报过（新装壳）→ 跟系统。
     *
     * 面板 applyTheme 时把解析结果报给壳（BandiShell.setTheme），存这里 —— 原生屏
     * （登录 / 设备列表）按它铺，跟面板不再一深一浅两截。存的是**解析后的布尔**而不是
     * light/dark/system 三态：「跟系统」那一档网页已经用 prefers-color-scheme 解析完了，
     * 壳再猜一遍系统答案只会猜错。主题不是会话数据，退出登录不清（跟中枢地址同等待遇）。
     */
    fun themeDark(ctx: Context): Boolean? = when (prefs(ctx).getString(K_THEME_DARK, null)) {
        "dark" -> true
        "light" -> false
        else -> null
    }

    fun setThemeDark(ctx: Context, dark: Boolean) {
        prefs(ctx).edit().putString(K_THEME_DARK, if (dark) "dark" else "light").apply()
    }

    /** 退出登录：只清会话与账号名（中枢地址留着，下次登录少打一次） */
    fun clearSession(ctx: Context) {
        prefs(ctx).edit().apply {
            remove(K_SESSION)
            remove(K_ACCOUNT)
            apply()
        }
    }
}
