# 桌面薄壳

**它只做三件事**：拉起本地控制面 → 把窗口指过去 → 退出时收掉**自己起的**那个。

界面不在这里 —— 用 `apps/web`（`apps/desktop/ui/` 那第二套前端已于 2026-10-15 删除）。
"控制面起没起、要不要起、退出收不收"的判断也**不在这里** —— 在 `shell.mjs`（Node），
与 `start.cmd` 共用 `apps/server/src/lifecycle.mjs`。理由见 [形态决策](../../docs/形态决策.md) §十二：
同一件事各写一份，必然两边跑偏。

## 结构

| 文件 | 管什么 |
| --- | --- |
| `src/lib.rs` | 起控制面、把窗口指过去、收摊 —— 就这三件。起不来时给一张本地错误页（原样摆出原因） |
| `src/shell.rs` | 找安装根、找 Node、拉起 `shell.mjs`、读协议行、退出时关掉它的 stdin |
| `shell.mjs` | 数据目录（用户目录）、**端口自选**、起/复用/停的分寸 |
| `src/main.rs` | 入口（release 下不挂控制台） |
| `smoke-shell.mjs` | 壳的协议与分寸（26 项） |
| `fetch-node.mjs` | 取一份 Node 运行时放进 `binaries/` —— **打包前必跑** |
| `stage-runtime.mjs` | 把运行时摊到 `runtime/` —— **打包前必跑**（见下） |

**两半之间只有三行协议**（stdout；人看的话都走 stderr，免得解析被搅）：

```
BANDI_SHELL READY <url> <0|1>   1 = 是我们起的（退出要收），0 = 本来就在跑（退出不动）
BANDI_SHELL ALIEN <说明>        端口被别的程序占着，我们没动它
BANDI_SHELL FAILED <说明>       起不来
```

多写一处判断，就多一个跑偏的机会 —— 所以**判断只在 Node 那一侧**。

## 数据与端口

- **数据目录进用户目录**，绝不塞安装目录（否则用户机器上要么要管理员权限、要么升级被覆盖）：
  Windows `%APPDATA%\bandi`、macOS `~/Library/Application Support/bandi`、Linux `$XDG_DATA_HOME/bandi`。
  里面有 `bandi.db`、`server.log`、`shell.log`（**正式安装包没有控制台**，这份日志是唯一能看"壳当时说了什么"的地方）、`port`。
- **端口自己挑**：从 8787 往上 —— 空着就用、是我们自己的实例就**复用**、是**别人的程序就跳过**。
  选中的记进 `port`，下次据此复用自己那个。命令行的 8787 是"给人用的约定"，桌面版没这个约定；
  硬编码端口的桌面版，在用户机器上撞端口时只剩一张错误页。

## 打包

```sh
node apps/desktop/fetch-node.mjs      # 1) 取 Node 运行时 ＋ 它的 LICENSE（82 MB，不进版本控制）
node apps/desktop/stage-runtime.mjs   # 2) 把运行时与许可文本摊到 runtime/（安装包要带它们）
cd apps/desktop
npx --yes @tauri-apps/cli@2 build     # 3) 出安装包
```

产物：`target/release/bundle/nsis/班底_<版本>_x64-setup.exe`（约 22 MB；装完约 86 MB，其中 82 MB 是 node.exe）。

**安装包里的许可文本（已打通，别删那几条映射）**：随包分发必须带三份文件 —— `stage-runtime.mjs`
把它们摊进 `runtime/`，`tauri.conf.json` 的 `bundle.resources` 各有映射，装完落在**安装目录根**上：

| 文件 | 为什么 |
| --- | --- |
| `LICENSE` | Apache-2.0 第 4 条（a）：随分发给用户一份许可副本 |
| `NOTICE` | 同条（d）：保留 NOTICE（署名与第三方说明） |
| `node-LICENSE.txt` | 安装包把 `node.exe` 一起分发 —— 再分发 Node 就得带它的许可声明（那份里含它自己的一串第三方：OpenSSL / V8 / npm / ICU…） |

`node-LICENSE.txt` 由第 1 步从 Node 压缩包里取（**只取 `node.exe` 就漏了它**），另两份从仓库根拷；
两个脚本都是**缺文件即失败**，不做"少一个也能装"的兜底 —— 那种兜底正是缺口被漏过去的方式。
**验收不看配置看产物**：装完打开安装目录，这三个文件都在。
（`resources` 的源路径跳不出 `apps/desktop/`，所以只能走摊平这条路。）

**第 1 步为什么必须**：`v1.0.0` 的 B2 —— 不许要求用户自装运行时，安装包必须自带 Node。
`node.exe` 有 81 MB，不能进 git（`.gitignore` 已挡），所以"怎么拿到它"只有这一个入口。
**顺带也把 Node 的 `LICENSE` 取出来**（存成 `node-LICENSE.txt`）：自带运行时 = 再分发 Node，
声明得跟着走，只取 `node.exe` 就漏了。

**第 2 步为什么必须**：`bundle.resources` 的源路径**不能跳出 `apps/desktop/`**，而运行时散在
`apps/server`、`apps/web`、`shell.mjs`。所以先把它们摊成 `runtime/apps/...`，
再用 `"runtime/apps" → "apps"` 映射进去 —— 装出来的目录形状**与仓库一模一样**，
于是 `find_root()` 和 `shell.mjs` 里那些相对 import **一行都不用改**。
（漏了这一步的后果实测过：装出来只有 exe + node.exe + version.json，双击就是一张
"没找到安装根"的错误页。）

**几个环境上的坑（本机实测）**：

- **npm 源**：`registry.npmjs.org` 在这台机器上不通，要指镜像：
  `npm_config_registry=https://registry.npmmirror.com npx --yes @tauri-apps/cli@2 build`
- **NSIS**：Tauri 要 `nsis-3.13.zip`，从 GitHub release 资产域下（`objects.githubusercontent.com`，
  这边**超时**）。它会**先把旧缓存删掉再下**，于是卡死在下载上。解法是手工把缓存备好：
  用加速通道下 `nsis-3.13.zip` 与 `nsis_tauri_utils.dll`（v0.5.3），
  解到 `%LOCALAPPDATA%\tauri\`，把 `nsis-3.13` 改名成 `NSIS`，
  DLL 放到 `NSIS\Plugins\x86-unicode\additional\`。
  判断备好没有：Tauri 要求的那 13 个文件一个不缺，且 DLL 的 SHA1 = `75197FEE3C6A814FE035788D1C34EAD39349B860`。
- **只打 NSIS**：`tauri.conf.json` 里 `bundle.targets` 显式写成 `["nsis"]`。
  留空会连 MSI 一起试，而那要下 WiX（同样走 GitHub 的 objects 域）。
- `cargo` 会警告 bin 与 lib 输出同名 pdb（`bandi-desktop` / `bandi_desktop`）——
  `v1.0.0` 时就有的命名遗留，只是警告，不影响产物。

## 图标

任务栏、窗口、exe、安装包都用同一份：`icons/icon.png`（512，窗口/关于页）＋ `icons/icon.ico`
（多尺寸 16…256，Windows 用）。**两份都由脚本生成**，别手工替换 —— 换字是常事，得有唯一入口：

```sh
python apps/desktop/make-icon.py             # 出「班」
python apps/desktop/make-icon.py --glyph 本   # 换字
python apps/desktop/make-icon.py --preview    # 额外出 16/32/64 预览，看小尺寸糊不糊
```

**为什么是 Python**：把一个汉字画进位图要**字体光栅化**（Pillow，平台自带）。Node 那边手写 PNG/ICO 容易，
但把字形轮廓栅格化不是几百行的事。风格值（底色 `#202228`、字色 `#6EA8FE`、字形墨迹高度 256px）
**冻在脚本里**，量自 `v1.0.0` 那个图标 —— `--sample <旧图标.png>` 可以复核这几个数从哪来。
（第一版是每次去"读当前图标"再推尺寸的，于是基准变成自己的上次输出、跑一次漂一两像素；冻住才对。）

⚠️ **改完图标要重跑一遍 build，而且光换文件不够**：Windows 上 exe 的图标是 `build.rs`
（`tauri_build::build()`）跑的时候生成 `resource.rc` 再嵌进去的，而它的 `rerun-if-changed`
**不盯 `icon.ico`** —— 只换图标文件、不动 `build.rs` 与 `tauri.conf.json`，cargo 就认为
build 脚本没变、不重跑，于是 exe 里**还是旧图标**。
（2026-10-15 实测：图标文件 23:49 换好，`.rc` 还是 23:42 那份，把嵌入图标抽出来一看仍是「本」。）
所以 `make-icon.py` 写完会**顶一下 `build.rs` 的 mtime**，强制它重跑。

**安装包**的图标要单独指，不指就是 NSIS 那个默认图标（一个蓝色方块）：
`tauri.conf.json` 里的 `bundle.windows.nsis.installerIcon` / `uninstallerIcon`。

**怎么验证真的换了**（别只看文件时间戳）：把 exe 里嵌入的那份抽出来看 ——

```powershell
Add-Type -AssemblyName System.Drawing
[System.Drawing.Icon]::ExtractAssociatedIcon("apps\desktop\target\release\bandi-desktop.exe").ToBitmap().Save("tmp\ico.png")
```

## 装完是什么样

实测（静默安装 + **把 node 从 PATH 里剥掉**再运行）：

- 装出来的目录：`bandi-desktop.exe`、`node.exe`、`apps/**`（控制面 + 界面 + `shell.mjs`）、`skills/`、`plugins/`
- 双击 → 窗口标题「班底 <版本>」（版本真源 `version.json`）、里面就是平台界面
- **PATH 上没有 node，照样跑** —— 用的是安装目录里那份 `node.exe`（控制面的 `repoRoot` 就是安装目录）
- 关掉窗口 → 它起的控制面被收掉；卸载 → 目录与注册表都干净
