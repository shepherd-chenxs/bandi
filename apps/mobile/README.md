# 班底 · 手机壳（Android）

把局域网上的班底控制面装进一个 App。**壳里不含业务** —— 界面仍然是 `apps/web`
那一套，壳只解决 PWA 解决不了的那一段：

| 壳负责 | 不负责 |
|---|---|
| 自动发现局域网里的班底（复用服务端 UDP 8788 应答器） | 任何业务页面、看板、对话渲染 |
| 扫二维码配对（WebView 相机 + vendored jsQR，见「扫码」） | 数据同步、鉴权逻辑（都是 web 的） |
| 连接测试（`GET /api/hello`，认 `platform === 'bandi'`） | 通知推送（未接，见「没做」） |
| 记住地址、把 WebView 指过去 | iOS（要 macOS） |
| 连接页只当"登录页"用：连上后不进 WebView 历史，返回键退出 App | |

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
│   ├── launcher.js       启动页逻辑（读设置 / 扫网 / 探测 / 跳转）
│   ├── scanner.js        扫一扫：getUserMedia + 逐帧解码（见「扫码」）
│   └── vendor/jsQR.js    vendored jsQR@1.4.0（离线铁律，不许 CDN）
├── capabilities/         Tauri 2 权限（没有它 invoke 一律被拒）
├── icons/                tauri icon 生成的全套图标
├── tauri.conf.json
└── gen/android/          tauri android init 生成的 Android Studio 工程（入库）
    └── app/src/main/java/app/local/bandi/mobile/
        └── MainActivity.kt   安全区内边距 + 返回键分流（手改）
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

所以本工程做了三处改动（**重新 `tauri android init` 后要再改一次**）：

- `gen/android/app/build.gradle.kts` 摘掉 `id("rust")` 和 `rust { rootDirRel }`
  —— Gradle 不再回头调 cargo；
- 改由 `build-android.mjs` 预编译并**复制** `.so`；
- `gen/android/app/src/main/AndroidManifest.xml` 补 `CAMERA` 权限（扫码用，见「扫码」）。

### 2. release 包必须允许明文 HTTP

`gen/android/app/build.gradle.kts` 的 `defaultConfig` 里：

```kotlin
manifestPlaceholders["usesCleartextTraffic"] = "true"
```

Tauri 模板默认是 `false`（只给 debug 开 true）。不改的话 debug 包能连、release
包永远连不上 —— 局域网控制面就是 `http://192.168.x.x:18787`，没有 TLS。

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
纯布局（2026-11-03 五改后）：

- **输入只存在于邀请码视图**，而它是顶部对齐的：返回行 30px + 标题 +
  地址框 + 码框 + 连接按钮，底部 ≈340 —— 真机键盘顶在 y≈350，
  **盖不住**（用户实测）；首页没有输入框，怎么排版都安全；
- 因此**键盘弹起时页面完全不动** —— 不位移、不收起头部、不加过渡。
  （中途试过 `body.typing` 整页上移、更早试过藏头部，都被用户否掉了：
  "键鼠盖不住输入框，不需要往上"+"标题突然没了很不舒服"。两条都删干净了，
  别再往回加。）
- ⚠️ 给邀请码视图加东西之前先算高度：标题再大一号、或者多一行说明，
  输入框就可能掉进键盘底下。

改启动页布局时别把输入框推到下半屏（2026-11-01 CDP 实测：hero 竖排时码框
bottom=399，真机上会被键盘盖住）。

## 启动页怎么走（2026-11-03 五改：一个大按钮 + 两个次要入口）

连接有三种方式，**跟部署形态无关**（用户定稿：局域网也填地址，
壳里不做"这是局域网还是云端"的判断）。2026-11-03 用户要求照 WorkBuddy
手机端登录页重排：**扫码做成一个大按钮，其他方式收在下面**，于是把旧的
「已配对 / 扫码 / 邀请码」三张页签（含滑块）整个删掉，改成首页 + 两层视图：

1. **首页**：品牌块（logo + 「班底」+ 一句副标）→ 蓝色大按钮**扫码连接**
   （首屏唯一的主 CTA；取景框四角 + 扫描线是纯 CSS，不用读字也知道这是扫一扫）
   → 「其他方式」分隔线 → 两条列表行：**已配对的电脑**（有记录才出现，副行是
   `3 台 · 2 小时前`）和**输入邀请码** → 页脚一句说明（二维码在哪、码 5 分钟有效）；
2. **扫码**：大按钮整块可点，点开相机遮罩（scanner.js）。电脑「设置 → 手机配对」
   的二维码内容是 `http://<地址>/pair?code=…`（地址 + 码一起带）。扫到后**进
   邀请码视图**、拆成两半填进输入框（用户能核对）再 `open_server`；
   解不出 `code=` 的整条打开，非班底码（WIFI: 等）只提示；
   相机起不来（没权限 / 被占用）→ 自动进邀请码视图，错误条给出路；
3. **邀请码**：地址 + 9 位码两栏**都填**才连 —— 拼成
   `<地址>/pair?code=<码>`（地址去尾斜杠、码剥非数字、三位一组实时格式化）。
   地址写 `192.168.1.5:18787` 或 `https://bandi.example.com` 都行，
   归一化（补协议/补 18787 端口）在 Rust `normalize()`；
4. 地址栏粘**一整条配对链接**（`http://…/pair?…`）也直通 —— 没有相机、
   不在同一 Wi-Fi 时唯一的路，桌面端「复制配对链接」一键给它；
5. **已配对**：列表 → 详情两级（2026-11-01 五改）。
   列表一行一台，名字用 `/api/hello` 报的机器名（没有就退回地址），副行是
   地址 + 最近连接时间，右端一个**箭头**（连接不是列表的副作用 —— 点错一下
   就连到别的电脑上，比多点一层烦）。点行进详情：设备卡（名字 + 主机名）+
   信息行（完整地址、最近连接时间）+ 两个按钮 ——
   **「连接」** = `open_server(<origin>/pair?resume=1)`，远程页凭 localStorage
   的 clientKey 换新令牌连回去，**不消耗邀请码、不用重新扫码**（配对被断开
   且没别的手机在用时也能回；有人在用会提示"另一台手机正在使用"）；
   **「取消配对」**（红描边）= 只清这台手机上的记录，电脑端那条设备记录不动。
   视图切换和详情都往 history 里压 state（launcher.js 的 `go` / `back`，state
   即视图状态）：Android 返回键一层层退（详情 → 列表 → 首页），不退 App。
6. `https://` 跳过 probe：Rust 的探测是裸 TCP + 明文 HTTP，对着 443 说话
   必然失败，所以云端地址直接 `open_server`，连不上由 WebView 报错。

**为什么局域网也要求填地址**：上一版用 UDP 广播"拿码找电脑"（discover(code)），
听着省事，但壳里从此分两条路，还要处理"广播被路由器吃掉"的一堆边角。
两栏填满这条路在两种部署下是同一条，程序简单、测试只跑一遍。
`discover` 命令仍在 Rust 里（启动页已不调用），服务端带码 UDP 应答同理保留。

**为什么废掉"只填地址直连"**：知道地址就能连，安全全靠"别人猜不到你的网段"，
不成立。现在凭据永远是邀请码（5 分钟、单次、只存哈希、试错限流 E1703）。

**token / 码都不落盘** —— `shell.json` 只存 origin 和给人看的名字；
设备凭据在远程页的 Cookie 里，壳不碰。

**主题跟随系统**（2026-11-01 三改）：启动页跑在 `http://tauri.localhost`，和业务页
不是一个 origin，读不到那边「设置 → 偏好 → 主题」的值；而且它出现在连接之前，
还没有"某台电脑的偏好"可读。所以深色是默认（CSS 变量本体），浅色整段放在
`@media (prefers-color-scheme: light)` 里覆盖（底 #f2f4f7、卡片 #fff、次要文字
#656a72 ≈ 4.9:1 过 AA）。所有硬编码颜色都收进了 token（--alt-bg / --alt-ico-bg /
--status-bg…），加主题就是加一段覆盖。扫码遮罩 `.scan` 保持深色 ——
那是相机画面，不跟主题走。扫码大按钮（--hero-a/--hero-b）深浅两套
是同一块蓝：它是首屏唯一的强调色，换主题不换主按钮。

返回键（2026-11-01 改）：连接页**不进 WebView 历史** —— `open_server` 用
`location.replace` 而不是 `webview.navigate`（navigate 是"前进一格"，启动页留在
历史里，进工作台一按返回就退回连接页，像"干点事就被踢回登录页"）。replace 顶掉
当前历史项后，返回键在远程页根页没得退，Tauri AppPlugin 把事件交回 Activity，
正常退出 App。

要回连接页只有一条路：配对真的没了（电脑端「断开连接」/「取消配对」/ 换了别的手机）
→ 远程页 401 遮罩上点「重新连接」—— 远程页自己 `location.replace('http://tauri.localhost/')`
（同样是 replace，不推历史）。**不走自定义 command**：Tauri v2 的 ACL 只对本地页开 app 命令，
远程页 invoke 会被 "not allowed" 拒掉（2026-11-01 真机实测）；好在壳的 on_navigation 白名单
放行 http/https，导航不受限。工作台里不提供"返回连接页"的入口 —— 那是登录页，不是上一级。

## 扫码（2026-11）

不碰原生、不加 gradle 依赖：相机走 WebView 的 `getUserMedia`，解码走
`dist/vendor/jsQR.js`（纯 JS，vendored，Apache-2.0）。

为什么不用 Tauri 的 barcode-scanner 插件：它是移动端插件，Android 侧的 Kotlin
类得靠 tauri-cli 把插件工程 include 进 `tauri.settings.gradle` —— 而我们为了
绕开符号链接（坑 1）根本不用 CLI 构建。走 WebView 则原生侧一行不用改。

链路：`scanner.js` 开 `facingMode: environment` → 每 180ms 把一帧（最长边缩到
720）画进 canvas → `jsQR(imageData)` → 解到 `http(s)://…` 就停流、收遮罩 →
交给 `launcher.js` 的 `connect()`。

三个必须知道的约束：

1. **只能在本页扫码**。`getUserMedia` 要 secure context：`http://tauri.localhost`
   算（`.localhost` 是可信来源），业务页 `http://192.168.x.x:18787` **不算** ——
   一旦 navigate 过去，那边的页面上 `getUserMedia` 直接用不了。所以扫码入口只在
   启动页，别想着在业务页加"扫一扫"。
2. **`CAMERA` 权限必须写进 manifest**（见坑 1 第三条）。wry 的
   `RustWebChromeClient.onPermissionRequest` 会替我们弹系统授权框，但前提是
   manifest 声明过；没声明就是 `NotAllowedError`，看着像"用户拒了权限"。
3. **回调前必须 stop 掉所有 track**。回调会 navigate，旧文档销毁，流不停就一直
   占着相机（下次打开黑屏 + 后台耗电）。

解到非链接的码（付款码、名片码）只提示不退出，用户换一张继续扫；同一张错码
1.5 秒内不重复闪提示。

## 语音输入（2026-11-01 加，2026-11-05 整个拆除）

曾经做过"像豆包那样：说话 → 文字 → 发出去"：壳里一个 Kotlin 的 `SpeechPlugin`
（`addJavascriptInterface` 桥，不走 Tauri IPC），页面侧 `apps/web/js/voice.mjs`，
内嵌识别失败时降级拉系统语音输入面板。2026-11-05 用户拍板**整个机制拆除**
（不是藏入口，是不留代码尸体），后续要换别的识别方案再重做。拆掉的东西：

- 壳：`SpeechPlugin.kt`、`MainActivity.onActivityResult` 转发、
  `lib.rs` 的 `speech_plugin` 注册、Manifest 的 `RECORD_AUDIO` +
  `RecognitionService` queries（本次会话截图里的"正在倾听/说完了"灰条面板
  就是降级路线拉起的系统公版面板，UI 改不了）；
- 页面：`apps/web/js/voice.mjs`、`app.mjs` 的挂载、`mobile.css` 的 `.voice-*`。

没拆的：CAMERA 权限（扫码还要用）、锁竖屏（与语音无关）。

### gen/android 里的手改（重新 `tauri android init` 会丢，要重贴）

| 文件 | 改了什么 | 为什么 |
|---|---|---|
| `app/src/main/AndroidManifest.xml` | `CAMERA`（扫码，旧） | 不声明则 `getUserMedia` 直接 `NotAllowedError` |
| 同上 | `<activity android:screenOrientation="portrait">` | **锁竖屏**（2026-11-03）：界面全是单列，横过来只是把列表压扁。这是 Activity 的硬约束，CSS/JS 锁不了方向（`screen.orientation.lock()` 要全屏）。丢了的表现：手机一横，整个界面跟着转 |
| `MainActivity.kt` | 安全区内边距（旧）+ 返回键分流（2026-11-05） | Android 15 edge-to-edge；返回键分流见 MainActivity.kt 注释 |
| `app/build.gradle.kts` | dependencies 里加 `implementation(project(":tauri-android"))` | 否则 app 编译 `Unresolved reference 'TauriActivity'`。别放到 `tauri.build.gradle.kts` 里 —— 那个文件是 `apply(from=…)` 进来的，拿不到 `implementation` 访问器 |
| `app/tauri.build.gradle.kts` | 必须有这个文件（空壳即可） | `app/build.gradle.kts` 末尾 apply 它；被 gitignore，缺失时 gradle 直接 `Could not read script`。`build-android.mjs` 会自动补 |
| `app/src/main/java/<包名>/generated/` | `TauriActivity.kt` 等 | **不是源码**，是 cargo 编译 tauri/wry 时 build.rs 生成的，前提是 `WRY_ANDROID_PACKAGE` / `WRY_ANDROID_LIBRARY` / `WRY_ANDROID_KOTLIN_FILES_OUT_DIR` 等环境变量（`build-android.mjs` 已设）。tauri 的 build.rs **没声明** `rerun-if-env-changed`，所以曾经裸编过就得 `cargo clean -p tauri --target <triple>` 再来一次 |

## 没做

- **通知**：需要 Web Push（VAPID + SW push handler + 服务端订阅表），
  或者原生 NotificationManager 桥接。这是壳相对 PWA 唯一有意义的增量，但没做。
- **iOS**：Tauri 的 iOS 构建要 macOS + Xcode，Windows 上做不了。
  `icons/ios` 已经生成了，到 Mac 上跑 `cargo tauri ios init` 即可。
- **签名**：release 包用 debug 签名能装能跑，但不能上架；要分发得配
  `gen/android/app/build.gradle.kts` 的 signingConfigs。
