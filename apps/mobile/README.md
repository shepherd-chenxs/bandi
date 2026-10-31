# 班底 · 手机壳（Android）

把局域网上的班底控制面装进一个 App。**壳里不含业务** —— 界面仍然是 `apps/web`
那一套，壳只解决 PWA 解决不了的那一段：

| 壳负责 | 不负责 |
|---|---|
| 自动发现局域网里的班底（复用服务端 UDP 8788 应答器） | 任何业务页面、看板、对话渲染 |
| 连接测试（`GET /api/hello`，认 `platform === 'bandi'`） | 数据同步、鉴权逻辑（都是 web 的） |
| 记住地址、把 WebView 指过去 | 通知推送（未接，见「没做」） |
| Android 返回键天然退回启动页（WebView 历史） | 扫码（未接，见「没做」） |

形态定位见 `docs/mobile/pwa-prd.md`：**PWA 是主形态，壳是可选分发**。同一个
`apps/web` 同时服务两者，改产品页面不需要动这里。

---

## 目录

```
apps/mobile/
├── src/lib.rs            壳的全部逻辑：URL 归一化、探测、UDP 发现、设置落盘
├── src/main.rs           入口（mobile_entry_point 在 lib.rs）
├── dist/                 启动页（本地 asset，tauri:// 加载）
│   ├── index.html
│   ├── launcher.css
│   └── launcher.js
├── capabilities/         Tauri 2 权限（没有它 invoke 一律被拒）
├── icons/                tauri icon 生成的全套图标
├── tauri.conf.json
└── gen/android/          tauri android init 生成的 Android Studio 工程（入库）
```

## 构建前置

| 依赖 | 版本 | 备注 |
|---|---|---|
| Rust targets | `aarch64-linux-android` 等四个 | `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android` |
| JDK | 17 | `JAVA_HOME` |
| Android SDK | `platforms;android-37.0`、`build-tools;37.0.0`、`platform-tools` | `ANDROID_HOME` |
| NDK | `27.2.12479018` | `NDK_HOME` |
| tauri-cli | 2.x | `cargo tauri --version` |

装 SDK 包（Windows，Git Bash）：

```bash
yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager.bat" --sdk_root="$ANDROID_HOME" \
  platform-tools "platforms;android-37.0" "build-tools;37.0.0" "ndk;27.2.12479018"
```

## 构建

**不要用 `cargo tauri android build`** —— Windows 上必挂，原因见下面「坑 1」。用脚本：

```bash
node apps/mobile/build-android.mjs                # debug / arm64
node apps/mobile/build-android.mjs --release      # release（未签名 APK）
node apps/mobile/build-android.mjs --abi x86_64   # 模拟器
node apps/mobile/build-android.mjs --skip-cargo   # 复用已有 .so，只重新打包
```

环境变量：`ANDROID_HOME`（默认 `E:\Android\Sdk`）、`NDK_HOME`（默认取
`ndk/` 下最新）、`JAVA_HOME`。产物在 `gen/android/app/build/outputs/apk/`。

装到手机：

```bash
adb install -r gen/android/app/build/outputs/apk/debug/app-debug.apk
```

脚本做的五步（每一步都在 `build-android.mjs` 顶部注释里）：cargo build
（NDK clang 当 linker、`tauri/custom-protocol` 把前端嵌进 .so）→ 复制 .so 到
jniLibs → 补 `assets/tauri.conf.json` → 补 `local.properties` → `gradlew assembleDebug`。

## 四个必须知道的坑

### 1. Windows 上不能用 tauri CLI 的 Android 构建

Tauri CLI（`cargo-mobile2` 的 `jnilibs.rs`）把 `.so` **符号链接**进
`gen/android/app/src/main/jniLibs/`，普通用户没有
`SeCreateSymbolicLinkPrivilege`，除非开 Windows 开发者模式，否则必然失败，
而且没有回退分支。

所以本工程做了两处改动（**重新 `tauri android init` 后要再改一次**）：

- `gen/android/app/build.gradle.kts` 摘掉 `id("rust")` 和 `rust { rootDirRel }`
  —— Gradle 不再回头调 cargo；
- 改由 `build-android.mjs` 预编译并**复制** `.so`。

### 2. release 包必须允许明文 HTTP

`gen/android/app/build.gradle.kts` 的 `defaultConfig` 里：

```kotlin
manifestPlaceholders["usesCleartextTraffic"] = "true"
```

Tauri 模板默认是 `false`（只给 debug 开 true）。不改的话 debug 包能连、release
包永远连不上 —— 局域网控制面就是 `http://192.168.x.x:8787`，没有 TLS。

### 3. 没有 capabilities 就没有 invoke

`capabilities/default.json` 声明了 `windows: ["main"]` + `core:default`。
启动页的 `discover` / `probe` / `open_server` 全靠它。删掉或改错 label，
启动页会静默停在「正在搜索…」。

另外 `assets/tauri.conf.json` 是运行时 `PluginManager.kt:231` 要读的，
由构建脚本补；缺了 App 启动即崩。

### 4. 启动页的键盘适配只能靠布局，不能靠 JS

Tauri 的 Android WebView 里，键盘弹起时：

- **文档滚不动** —— `scrollIntoView` / `window.scrollTo` / 给底部补 padding
  全试过，页面纹丝不动；
- **`visualViewport` 不派发 resize** —— 拿不到键盘高度，`--kb` / `--vvh`
  那套兜底也不会生效。

所以别写"等键盘状态再调整"的逻辑（实测连试 5 版都失败）。现在的做法是
纯布局：`dist/index.html` 里「填写地址」卡片排在「局域网里的班底」**之前**，
输入框落在 y≈300，键盘顶部在 y≈350，天然不被挡。改启动页布局时别把它挪回去。

## 启动页怎么走

1. 读 `app_config_dir/shell.json` 的 `server`；
2. 有 → 显示「上次连接 / 进入 / 换一台」；没有 → 直接扫描；
3. 扫描 = UDP 8788 广播 `{"bandi":"discover","v":1,"nonce":...}`，收
   `{"bandi":"announce",...}`，地址取回包来源 IP、端口取应答的 `httpPort`
   （与服务端 `discover.mjs` 同一套口径）；
4. 点连接 / 手输地址 → Rust 侧 `GET /api/hello` 探测 → `webview.navigate()`。

配对：在电脑上「设置 → 手机配对」生成二维码，把二维码下面的链接
（`http://<ip>:8787/pair?token=bp_xxx`）粘贴到启动页输入框，一次完成配对。
**token 不落盘** —— `shell.json` 只存 origin。

返回键：远程页由启动页 navigate 过去，WebView 历史里天然有启动页。
Android 返回键在远程页根页时退回启动页，再按一次退出 App（Tauri AppPlugin
的默认行为，没有改 Kotlin）。

## 没做

- **扫码**：需要相机权限 + 扫码库，当前用「粘贴配对链接」代替。
- **通知**：需要 Web Push（VAPID + SW push handler + 服务端订阅表），
  或者原生 NotificationManager 桥接。这是壳相对 PWA 唯一有意义的增量，但没做。
- **iOS**：Tauri 的 iOS 构建要 macOS + Xcode，Windows 上做不了。
  `icons/ios` 已经生成了，到 Mac 上跑 `cargo tauri ios init` 即可。
- **签名**：release 包用 debug 签名能装能跑，但不能上架；要分发得配
  `gen/android/app/build.gradle.kts` 的 signingConfigs。
