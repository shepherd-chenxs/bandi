# 班底 · 原生手机壳（Kotlin）

Tauri 壳（`apps/mobile/`）的替代者。壳只干三件事，全部在原生层完成，
**产品界面仍然由各台电脑现发网页承载**（桌面 / PWA / 壳共用同一份 apps/web）：

```
登录中枢（POST /v1/auth/phone-login）        ← 原生界面 + 原生 HTTP，无 WebView
→ 设备列表（GET /v1/devices + 原生探活）     ← 原生界面
→ 点一台签票（POST /v1/devices/:id/ticket）  ← 原生 HTTP
→ WebView 打开 <机器>/hub/enter?ticket=…     ← 机器验票发会话，面板从这里开始
```

为什么换：WebView 壳的登录页是网页，系统按「网页凭据」对待——Android 16 的
存密码弹窗走凭据管理器，View 层排除标志（importantForAutofill /
setSavePassword）与字段形态改造全部无效（小米密码保险箱 com.miui.passwords
的系统悬浮窗，dumpsys autofill 请求历史可证）。登录搬到原生层后弹窗失去
触发条件。完整决策记录见 `docs/形态决策.md` §十五 ⑤。

## 构建

一次性环境（与 Tauri 壳同一套 SDK）：

1. `local.properties` 写一行 `sdk.dir=E\:\\Android\\Sdk`（指到本机 Android SDK；
   已 gitignore，不入库）
2. JDK 17+；SDK 组件 `platforms;android-37.0` + `build-tools;37.0.0`

出包（在 `apps/mobile-native/` 下）：

```bash
JAVA_HOME=<JDK> cmd /c "gradlew.bat assembleDebug"
```

产物：`app/build/outputs/apk/debug/app-debug.apk`（debug 签名，直接 adb 装机）。
versionCode/Name 从 `apps/desktop/version.json` 生成（major*1e6+minor*1e3+patch），
**版本真源仍是那一份，别在这里另起号**。

## 结构

```
app/src/main/java/app/local/bandi/mobile/
├── MainActivity.kt   单 Activity 三视图（登录 / 设备列表 / 面板）+ 返回键分流
├── HubApi.kt         中枢三条调用（phone-login / devices / ticket），错误统一人话
├── Probe.kt          局域网探活：裸 TCP GET /api/hello，4 秒超时，认 platform=bandi
├── SessionStore.kt   中枢会话与地址的本机存储（密码从不落盘）
└── BandiShell.kt     addJavascriptInterface 桥：面板「当前设备 / 退出登录」回调壳
```

面板侧的桥在 `apps/web/js/settings.mjs`：功能检测 `window.BandiShell`（原生壳）
优先，旧 Tauri 壳的 `__BANDI_SHELL__` hash 流兜底，浏览器 / PWA 走各自原路径。

## 与 Tauri 壳的关系

Tauri 壳（`apps/mobile/`）在原生壳实机验证通过后退役。过渡期两者共存：
同一 applicationId（`app.local.bandi.mobile`），后装的那个生效。
