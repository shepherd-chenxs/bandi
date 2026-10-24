//! 桌面薄壳。
//!
//! 它只做三件事：**拉起本地控制面 → 把窗口指过去 → 退出时收摊**。
//! 界面不在这里 —— 用 `apps/web`（`apps/desktop/ui/` 那第二套前端 2026-10-15 已删）。
//!
//! 分工：Rust 只管窗口与进程；"控制面起没起、要不要起、退出收不收"在
//! `apps/desktop/shell.mjs`（Node），与 `start.cmd` 共用 `apps/server/src/lifecycle.mjs`。
//! 详见 `docs/形态决策.md` §十二。
//!
//! `v1.0.0` 那条「SSH 服务器登记」线（`store` / `guide` / `keys` / `ssh` 四个模块、
//! 以及 `~/.bandi/servers.yaml` 那套登记册）已整体删除 —— 它跟"节点"模型相冲。
//! 真要做 SSH 传输时再看 git 历史。
//!
//! 启动防闪这条线（2026-10-22）是三步叠起来的，改之前先看 `pre_stage_geometry`
//! 上面那段长注释：
//!   ① `.visible(false)`：窗口先藏起来，页面加载完再露脸（消灭「建窗到首帧」那段底色）；
//!   ② 隐藏期就把几何摆成**最大化后的样子**（`pre_stage_geometry`）：show 那一刻没有尺寸变化，
//!      也就没有「边角还没画」的底色；
//!   ③ 底色跟着系统深浅色对齐（`align_background_with_theme`）+ 页面加载完再等 ~120ms：
//!      万一 WebView2 第一帧比 show 晚，露出来的也是页面同色。
//!
//! 断线兜底这条线（2026-10-22，用户实报「另一个窗口退出把服务带走，这个窗口裸露
//! `ERR_CONNECTION_REFUSED`」）也在这里：`watch_service` 每 1~2 秒探一次控制面，
//! 探不通就把 WebView 导航到 `offline.html`（`include_str!` 编进 exe）——
//! 服务被误杀导致的断连，**绝不允许再让用户看到 Edge 的原生错误页**。
//! 服务那一头"别被误杀"在 `apps/desktop/shell.mjs`（客户端登记 + 最后一个窗口收摊）。

mod shell;

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::webview::PageLoadEvent;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// 版本真源经 build.rs 注入的编译期常量。标题上的版本号只认它。
const APP_VERSION: &str = env!("APP_VERSION");

/// 「页面加载完后再等多久才露脸」。
///
/// `PageLoadEvent::Finished` = WebView2 的 `NavigationCompleted` = 文档 `onload`，
/// **不等于第一帧已经上屏**。实测（无头 Edge + CDP，2026-10-22）首帧比 load 晚 20~50ms；
/// 这段时间窗口露出来的就是窗口/WebView 的底色。压到 120ms 是给首帧 + 首屏渲染留余量，
/// 代价只是双击后多等这一瞬（总启动 ~1.9s，感知不到）。
const FIRST_PAINT_GRACE: Duration = Duration::from_millis(120);

/// 兜底：窗口建出来之后最多藏这么久。`about:blank` / 奇怪的加载失败可能不产生
/// `NavigationCompleted`（tauri-runtime-wry 对 about:blank 直接跳过导航），
/// 没有它窗口就可能永远不出现 —— 那比闪一下严重得多。
const SHOW_FALLBACK: Duration = Duration::from_secs(6);

/// 窗口只露一次脸。`on_page_load` 可能因为重定向/二次导航来好几次，别重复 show。
static SHOWN: AtomicBool = AtomicBool::new(false);

/* ---------------------------------------------------------------- 健康巡检的节拍 */

/// 服务在的时候多久探一次。一次探活就是"一个 TCP 连接 + 几十字节 HTTP"，
/// 2 秒一次的开销可以忽略；再快也没意义 —— 断连后换页晚 2 秒，用户感觉不到。
const HEALTH_INTERVAL: Duration = Duration::from_secs(2);

/// 已经掉线时多久探一次。这段时间用户正面盯着兜底页，恢复得越快越好，
/// 而且这时候的请求都是"连不上立刻失败"，不会因为间隔变小而变贵。
const HEALTH_INTERVAL_OFFLINE: Duration = Duration::from_secs(1);

/// 单次探活的超时。回环地址上连一个本地服务，800ms 还没反应就是真没反应了
/// —— 比它长只会让"服务死了"这件事晚一点被发现。
const HEALTH_TIMEOUT: Duration = Duration::from_millis(800);

/// 连续几次探不通才翻兜底页（2026-10-22 第三轮）。
///
/// 一次失败就翻页太敏感：服务端事件循环被一次 >800ms 的同步任务（大库操作 / GC /
/// 杀软扫描）卡住时，窗口会闪一下兜底页、SPA 的内存态全丢，1 秒后又跳回来 —— 比不翻更糟。
/// 2 次 = 在线时最坏约 `HEALTH_TIMEOUT + HEALTH_INTERVAL * 2` 才判定断连，用户感知不到，
/// 但毛刺被滤掉了。**恢复侧仍然是一次成功就回去**（断连时宁快勿慢）。
const HEALTH_MISSES: u32 = 2;

/// 兜底页。`include_str!` 进二进制：服务没起来时**不能再依赖任何磁盘上的东西**。
const OFFLINE_HTML: &str = include_str!("offline.html");

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![pick_directory])
        .setup(|app| {
            // 起控制面（最多等 45 秒）。这段时间还没有窗口 —— 用户看到的是"程序正在启动"。
            //
            // 安装包里那份 Node 从**资源目录**拿：`bundle.resources` 把 `binaries/node.exe`
            // 放成了资源，Windows 上它就在 exe 旁边。拿不到也不致命 —— shell::find_node
            // 还有便携布局与 PATH 两条退路（开发机上就是走那两条）。
            let packaged = app
                .path()
                .resolve("node.exe", tauri::path::BaseDirectory::Resource)
                .ok();
            let launch = match shell::find_root() {
                Some(root) => shell::launch(&root, packaged.as_deref()),
                None => shell::Launch::Failed {
                    message: "没找到安装根：往上找了六层，既没看到源码仓库（apps/desktop/shell.mjs + Cargo.toml），\
                              也没看到安装布局（apps/desktop/shell.mjs）。\n\n\
                              用环境变量 BANDI_HOME 指一下目录（仓库根或安装目录都行），再把程序放回去启动。"
                        .to_string(),
                },
            };

            let (target, ready) = match &launch {
                shell::Launch::Ready { url, owned } => {
                    eprintln!(
                        "[壳] 控制面就绪 {url}（{}）",
                        if *owned { "本次由壳启动，退出会收掉" } else {
                            // 2026-10-22 第三轮：收不收已经跟 owned 无关了 —— 按窗口引用计数，
                            // 由「最后一个窗口」决定。这里只说复用，别说"不动它"（那句现在是错的）。
                            "复用已有服务（收不收由最后一个窗口决定）"
                        }
                    );
                    (url.clone(), true)
                }
                shell::Launch::Failed { message } => {
                    eprintln!("[壳] 没起来：{message}");
                    (error_page(message), false)
                }
            };

            let url: tauri::Url = match target.parse() {
                Ok(u) => u,
                Err(e) => {
                    // 到这一步基本只可能是我们自己拼错了 URL；退一张最小错误页，别黑屏
                    error_page(&format!("地址不合法：{e}"))
                        .parse()
                        .unwrap_or_else(|_| tauri::Url::parse("about:blank").expect("about:blank"))
                }
            };

            /*
             * 判断"这次导航是不是我们自己的页面"用的就是它：`http://127.0.0.1:<port>`。
             * 错误页是 `data:`，origin 是 `null`，对不上 —— 正好用来区分「正常页」和「错误页」。
             */
            let app_origin = url.origin().ascii_serialization();
            let target_is_blank = url.as_str() == "about:blank";

            /*
             * 巡检要用的完整地址，**趁 `url` 还没被 Builder 吃掉**先留下：
             * 局域网模式下它带着 `?token=…`，恢复时得原样跳回去，否则会把用户丢到登录页。
             */
            let app_url: tauri::Url = url.clone();

            let title = if ready {
                "班底".to_string()
            } else {
                "班底 · 没起来".to_string()
            };

            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title(title)
                /*
                 * 启动即最大化（2026-10-22：用户要的是"点最大化那个效果"，不是独占全屏）。
                 *
                 * 区别要说清，别再来回改：
                 *   · `.maximized(true)` ← **本条**：铺满工作区，但**保留标题栏 / 窗口按钮 / 任务栏**，
                 *     跟手动点右上角"最大化"一模一样，双击标题栏还能还原；
                 *   · `.fullscreen(true)`：独占式的，连标题栏和任务栏一起吃掉（之前那版是错的，
                 *     用户明确"顶部是要的"）。
                 *
                 * ⚠️ 光靠这一条**不够**：tao 对不可见窗口会跳过 `ShowWindow(SW_MAXIMIZE)`
                 * （tao-0.37.1 `window_state.rs:360-373`，注释写着 "avoid the window from flashing"），
                 * 直到 `show()` 才补最大化 —— 那一下会把窗口从 1024×688 瞬间撑满，
                 * 而 WebView2 还没按新尺寸重画，多出来的边角就是窗口底色（见 `pre_stage_geometry`）。
                 *
                 * 尺寸两条留着，**不是冗余**：用户一旦还原窗口（双击标题栏 / 拖标题栏），
                 * 降落的就是这个 1024×688，最小 880×600 —— 否则会是系统随手给的大小。
                 *
                 * 2026-10-22：还原尺寸从 1280×860 一路等比例缩到 1024×688（×0.8，比例 1.488 不变）。
                 * 用户嫌还原后偏大，先 0.9（1152×774）再 0.8。等比缩小要按同一条比例算两个数，
                 * 只改一个窗口比例就歪了。再小要注意：宽度 880 是下限，高度 688 已贴近 600 的最小值，
                 * 再缩就得同时松动 min_inner_size —— 那要看 UI 在 880 以内还能不能排得下。
                 */
                .maximized(true)
                /*
                 * **先藏起来，等页面画完再露脸。**
                 *
                 * 窗口一创建就可见的话，从创建到 WebView 画出第一帧之间的那一小段，
                 * 露出来的是**窗口/WebView 自己的底色**，浅色主题下就是一道黑边（用户实报）。
                 *
                 * 藏起来的代价是"启动时多等一瞬才出窗"，但这段时间窗口根本不存在，
                 * 用户看到的是双击后正常的那点延迟，不会有任何闪烁。
                 */
                .visible(false)
                /*
                 * 页面加载完 → 再等一小段（`FIRST_PAINT_GRACE`）→ 露脸。
                 *
                 * 为什么不在回调里直接 show：① 这里跑在 WebView2 的事件线程上，show 之前
                 * 睡在这儿会卡事件，所以 sleep 放到新线程；② `Finished` 只是 `onload`，
                 * 第一帧可能还差 20~50ms（实测），等够再 show 才不露底色。
                 *
                 * 三种落地形态：
                 *   · 控制面正常（http://127.0.0.1:<port>/…）→ 等 `FIRST_PAINT_GRACE` 再 show；
                 *   · 没起来（data: URL 错误页）→ 没有"等首帧"的意义，立刻 show；
                 *   · 地址都不合法（about:blank 兜底）→ 它根本不一定有导航事件，靠 `SHOW_FALLBACK`。
                 * 另外初始的 about:blank 文档也可能报一次 Finished，那不是我们的页面，跳过。
                 */
                .on_page_load(move |win, payload| {
                    if let PageLoadEvent::Finished = payload.event() {
                        let page = payload.url().as_str().to_string();
                        if page == "about:blank" && !target_is_blank {
                            return; // 初始空白导航，真正的页面还没来
                        }
                        let win = win.clone();
                        let is_app =
                            !app_origin.is_empty() && app_origin != "null" && page.starts_with(&app_origin);
                        std::thread::spawn(move || {
                            if is_app {
                                std::thread::sleep(FIRST_PAINT_GRACE);
                            }
                            show_once(&win);
                        });
                    }
                })
                /*
                 * 窗口与 WebView 自身的底色，作为**兜底**（2026-10-22）。
                 *
                 * 真正兜住第一帧的是上面的「藏起来 + 等首帧 + 隐藏期先摆好几何」；
                 * 这条只在两种情况下还有用：
                 *   · 万一将来有人把 `.visible(false)` 去掉 / 改成可见建窗；
                 *   · 窗口已经 show 出来之后若发生二次导航 / 局部白屏，WebView 仍会短暂填这个色。
                 *
                 * 这里先写深色（`:root` 默认档），建完窗立刻按系统深浅色改（见
                 * `align_background_with_theme`）—— 因为 Builder 阶段还不知道主题。
                 */
                .background_color(tauri::webview::Color(8, 9, 10, 255))
                .inner_size(1024.0, 688.0)
                .min_inner_size(880.0, 600.0)
                .build()?;

            align_background_with_theme(&win);

            /*
             * 隐藏期就把窗口摆成「最大化后的几何」—— 这是 2026-10-22 修「启动闪一下」的关键一步，
             * 原因写在这条函数自己的注释里。只在 Windows 上做（Win32 调用）。
             */
            #[cfg(windows)]
            pre_stage_geometry(&win);

            // 兜底：迟迟等不到 NavigationCompleted 时，到点也要露脸（见 SHOW_FALLBACK 的注释）
            let fallback = win.clone();
            std::thread::spawn(move || {
                std::thread::sleep(SHOW_FALLBACK);
                show_once(&fallback);
            });

            /*
             * 起健康巡检（`ready == false` 时不用起：那条路已经是本地错误页 `error_page`，
             * 服务压根没起来过，没什么可巡检的，而且那时窗口地址是 data: URL、没有端口）。
             *
             * ⚠️ 先说清**不用重做的那件事**：首次加载不存在"服务还没好就怼 External URL"的竞态 ——
             * `ready` 只在 `shell.mjs` 报 `READY` 之后才成立，而那句是它 `waitHealthy`（探活成功）
             * 之后才写的。所以这里要防的是另一个时序：**页面已经开着，服务后来没了**
             * （2026-10-22 实报：另一个窗口退出时把服务一起收走了）。
             */
            if ready {
                match app_url.port() {
                    Some(port) => watch_service(win.clone(), app_url.clone(), port),
                    None => eprintln!(
                        "[壳] 窗口地址里没有端口，跳过了健康巡检 —— 断线时只能看到 WebView 自己的错误页"
                    ),
                }
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("启动桌面薄壳失败")
        .run(|_app, event| {
            // 关窗 / 退出：让 Node 那半收摊（它按"还有没有别的窗口在用"判断收不收，见 shell.mjs）
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                shell::stop();
            }
        });
}

/// 露脸 + 拿焦点，**只做一次**。
///
/// 由后台线程调用（见调用处注释）：`WebviewWindow` 是 Clone + Send 的，`show()` /
/// `set_focus()` 会被 Tauri 投递到主线程执行，不要求当前就在主线程。
fn show_once(win: &tauri::WebviewWindow) {
    if SHOWN.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = win.show();
    let _ = win.set_focus();
    /*
     * 露脸之后才补「还原尺寸」（见 `fix_restore_size`）。
     *
     * 为什么不能提前补：`SetWindowPlacement(showCmd = SW_SHOWMAXIMIZED)` 会**把隐藏窗口显示出来**
     * ——2026-10-22 真机日志实测 `visible` 从 false 变 true。提前调等于把「藏到首帧」这条
     * 自己拆了（而且那一下正好露在页面还没画的时刻，就是用户看到的那一闪）。
     * 所以顺序只能是：隐藏期只摆几何（`pre_stage_geometry`）→ show →
     * 在这个已经最大化的窗口上把 rcNormalPosition 写回 1024×688（同状态，视觉无变化）。
     */
    #[cfg(windows)]
    fix_restore_size(win);
}

/// 把窗口层与 WebView2 层的默认底色对齐到**页面首帧的实际底色**。
///
/// 为什么：从 show 到页面第一帧上屏之间，露出来的是这两层的底色。原来写死深色 `#08090a`，
/// 浅色主题用户就会看见一下深色闪 —— 页面自己的首帧底色（`apps/web/index.html` 的
/// 内联 style）是 `#f7f8f9`，两者正好相反。
///
/// 取值来源：`win.theme()` 读的是 Windows 系统深浅色（`AppsUseLightTheme`），
/// 与页面内联脚本的 `prefers-color-scheme` **同源**，所以默认 `bandi.theme='system'` 的用户
/// 一定对得上。手动把主题设成与系统相反的用户覆盖不到 —— 那种情况由「隐藏期先摆好几何 +
/// 等 120ms」兜住，不会露底色。
fn align_background_with_theme(win: &tauri::WebviewWindow) {
    let color = match win.theme() {
        Ok(tauri::Theme::Light) => tauri::webview::Color(0xf7, 0xf8, 0xf9, 255),
        _ => tauri::webview::Color(0x08, 0x09, 0x0a, 255),
    };
    let _ = win.set_background_color(Some(color));
}

/// 窗口还藏着的时候，先把它撑成「最大化后的几何」。
///
/// **为什么必须提前摆**：`tao` 对**不可见**窗口刻意跳过 `ShowWindow(SW_MAXIMIZE)`
/// （tao-0.37.1 `window_state.rs:360-373`，注释原话 "This is to avoid the window from
/// flashing"）。于是从建窗到 `show()` 之间，窗口一直是 `inner_size` 的 1024×688，
/// WebView2 也只按这个尺寸布局/绘制。`show()` 里才补 `SW_MAXIMIZE`：窗口几何瞬间变成全屏，
/// 但 WebView2 还没来得及 resize/重绘 —— 多出来的边角露出的是**窗口底色**
/// （浅色主题下就是「黑框一闪」）。2026-10-22 逐帧录屏确认过：show 后头 3~6 帧，
/// 内容还缩在左上角 1024×688 的框里，右边/下边是窗口底色。
///
/// 做法就一句 `SetWindowPos`：把窗口撑到**工作区**大小（隐藏期也生效），WebView2 跟着
/// `WM_SIZE` 重新布局/绘制。这样 `show()` 那一刻「窗口几何 = 最大化后的几何」，
/// 没有尺寸变化，也就没有"边角还没画"。
///
/// ⚠️ **别在这里顺手改「还原尺寸」**：`SetWindowPlacement(showCmd = SW_SHOWMAXIMIZED)`
/// 会把隐藏窗口**直接显示出来**（真机日志实测 可见性 false → true），等于把「藏到首帧」
/// 这条自己拆了。还原尺寸在露脸之后补（见 `fix_restore_size`）。
///
/// 失败就静默放弃（窗口照样能出来，只是回到原来那条「show 时才最大化」的路）。
#[cfg(windows)]
fn pre_stage_geometry(win: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOZORDER,
    };

    let Ok(hwnd) = win.hwnd() else { return };

    // 工作区 = 最大化后窗口能占的那块（要减掉任务栏）。读不到就退回主显示器整块。
    let mut work = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    unsafe {
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(monitor, &mut info).as_bool() {
            work = info.rcWork;
        }
    }
    if work.right <= work.left || work.bottom <= work.top {
        if let Ok(Some(mon)) = win.primary_monitor() {
            let pos = mon.position();
            let size = mon.size();
            work = RECT {
                left: pos.x,
                top: pos.y,
                right: pos.x + size.width as i32,
                bottom: pos.y + size.height as i32,
            };
        } else {
            return;
        }
    }

    let _ = unsafe {
        SetWindowPos(
            hwnd,
            None,
            work.left,
            work.top,
            work.right - work.left,
            work.bottom - work.top,
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
        )
    };
}

/// 露脸之后，把「双击标题栏还原」的尺寸写回 1024×688（按 DPI 折算、居中）。
///
/// 为什么只能在 show 之后：见 `pre_stage_geometry` 的 ⚠️ —— 带 `SW_SHOWMAXIMIZED` 的
/// `SetWindowPlacement` 会把隐藏窗口显示出来。此时窗口已经是最大化状态，再写一次同样状态的
/// placement 只改 `rcNormalPosition`，视觉上不该有变化；不写的话 Windows 会把「还原」记成
/// 工作区大小 —— 双击标题栏后窗口还是满屏，等于没有还原。
#[cfg(windows)]
fn fix_restore_size(win: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::{POINT, RECT};
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPlacement, SW_SHOWMAXIMIZED, WINDOWPLACEMENT, WINDOWPLACEMENT_FLAGS,
    };

    let Ok(hwnd) = win.hwnd() else { return };
    let scale = win.scale_factor().unwrap_or(1.0);

    let mut work = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    unsafe {
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(monitor, &mut info).as_bool() {
            work = info.rcWork;
        }
    }
    if work.right <= work.left || work.bottom <= work.top {
        if let Ok(Some(mon)) = win.primary_monitor() {
            let pos = mon.position();
            let size = mon.size();
            work = RECT {
                left: pos.x,
                top: pos.y,
                right: pos.x + size.width as i32,
                bottom: pos.y + size.height as i32,
            };
        } else {
            return;
        }
    }

    // 还原尺寸 = builder 里的 1024×688（逻辑像素）× DPI，摆在工作区正中
    let (nw, nh) = ((1024.0 * scale).round() as i32, (688.0 * scale).round() as i32);
    let nx = work.left + (work.right - work.left - nw) / 2;
    let ny = work.top + (work.bottom - work.top - nh) / 2;
    let placement = WINDOWPLACEMENT {
        length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
        flags: WINDOWPLACEMENT_FLAGS(0),
        showCmd: SW_SHOWMAXIMIZED.0 as u32,
        ptMinPosition: POINT { x: 0, y: 0 },
        ptMaxPosition: POINT { x: 0, y: 0 },
        rcNormalPosition: RECT {
            left: nx,
            top: ny,
            right: nx + nw,
            bottom: ny + nh,
        },
    };
    let _ = unsafe { SetWindowPlacement(hwnd, &placement) };
}

/// 桌面壳提供的**原生目录选择框**，页面通过 IPC 调用（项目「工作目录」等处的「选择」按钮）。
///
/// 为什么放在壳里、不放在服务端（2026-10-22 用户实报「点了选择没反应」）：
/// Windows 的目录框必须有**属主窗口**才会压在它上面、并跟着窗口激活；服务端是没有窗口的
/// 后台进程，它 spawn 的 PowerShell 弹的框没有属主 —— 实测窗口 `IsWindowVisible=false`，
/// 用户只看到按钮一直转「…」。壳手里有 HWND，`IFileOpenDialog` 带着 owner 弹，
/// 就是系统标准的那个「选择文件夹」对话框。
///
/// 返回：选中的绝对路径；用户取消返回 `None`；出问题返回 `Err`（前端会退回页内浏览）。
#[tauri::command]
async fn pick_directory(
    window: tauri::WebviewWindow,
    title: Option<String>,
    default_path: Option<String>,
) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|e| format!("拿不到窗口句柄：{e}"))?;
        // HWND 不是 Send：跨线程只传裸值，进了线程再组回去
        let hwnd_raw = hwnd.0 as isize;
        tauri::async_runtime::spawn_blocking(move || {
            // 单独开线程：目录框要求 STA 套间，tokio 的工作线程可能已经被初始化成 MTA
            std::thread::spawn(move || {
                let hwnd = windows::Win32::Foundation::HWND(
                    hwnd_raw as *mut std::ffi::c_void,
                );
                pick_folder_blocking(hwnd, title, default_path)
            })
            .join()
            .map_err(|_| "选择目录的线程异常退出".to_string())?
        })
        .await
        .map_err(|e| format!("选择目录失败：{e}"))?
    }
    #[cfg(not(windows))]
    {
        let _ = (window, title, default_path);
        Err("这个系统上还没做原生目录选择框".to_string())
    }
}

/// 真正弹 `IFileOpenDialog`（只选文件夹）。跑在一条自己初始化的 STA 线程上。
#[cfg(windows)]
fn pick_folder_blocking(
    hwnd: windows::Win32::Foundation::HWND,
    title: Option<String>,
    default_path: Option<String>,
) -> Result<Option<String>, String> {
    use windows::core::{HRESULT, HSTRING, IUnknown};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, IBindCtx, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{
        FileOpenDialog, IFileOpenDialog, IShellItem, SHCreateItemFromParsingName,
        FOS_FORCEFILESYSTEM, FOS_PATHMUSTEXIST, FOS_PICKFOLDERS, SIGDN_FILESYSPATH,
    };

    // 用户点「取消」时 IFileOpenDialog::Show 返回 HRESULT_FROM_WIN32(ERROR_CANCELLED=1223)
    let cancelled = HRESULT::from_win32(1223);

    let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    if hr.is_err() {
        return Err(format!("COM 初始化失败：{}", hr.message()));
    }

    let result = (|| -> Result<Option<String>, String> {
        unsafe {
            let dialog: IFileOpenDialog =
                CoCreateInstance(&FileOpenDialog, None::<&IUnknown>, CLSCTX_INPROC_SERVER)
                    .map_err(|e| format!("创建目录选择框失败：{}", e.message()))?;
            dialog
                .SetOptions(FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST)
                .map_err(|e| format!("设置目录选择框失败：{}", e.message()))?;
            let _ = dialog.SetTitle(&HSTRING::from(title.unwrap_or_else(|| "选择目录".into())));
            let _ = dialog.SetOkButtonLabel(&HSTRING::from("选这个目录"));
            if let Some(start) = default_path.as_deref().filter(|s| !s.is_empty()) {
                if let Ok(item) = SHCreateItemFromParsingName::<_, _, IShellItem>(
                    &HSTRING::from(start),
                    None::<&IBindCtx>,
                ) {
                    let _ = dialog.SetFolder(&item);
                }
            }
            match dialog.Show(Some(hwnd)) {
                Ok(()) => {}
                Err(e) if e.code() == cancelled => return Ok(None),
                Err(e) => return Err(format!("目录选择框打不开：{}", e.message())),
            }
            let item = dialog
                .GetResult()
                .map_err(|e| format!("没拿到选择结果：{}", e.message()))?;
            let name = item
                .GetDisplayName(SIGDN_FILESYSPATH)
                .map_err(|e| format!("没拿到路径：{}", e.message()))?;
            let path = name
                .to_string()
                .map_err(|e| format!("路径转不成文本：{e}"))?;
            if path.is_empty() {
                return Ok(None);
            }
            Ok(Some(path))
        }
    })();

    unsafe { CoUninitialize() };
    result
}

/* ------------------------------------------------- 断连兜底（健康巡检 + 离线页） */

/// 探一下控制面还在不在：往 `127.0.0.1:<port>` 写一句最小 HTTP GET，看有没有人回话。
///
/// **为什么不用 reqwest**：为探一个回环地址引入一整套异步 HTTP（连带 tokio / hyper / TLS）
/// 不值当 —— 编译体积、依赖面、构建时间都要付账，而这里需要的只有"端口上有个 HTTP 服务
/// 在回话吗"这一个比特。std 的 `TcpStream` 写一行请求就够。
///
/// **判定标准故意宽松**：只要回来的是个像样的 HTTP 响应就算"在"。理由是
///   ① 200 / 401 / 403 都是班底（后者是开了鉴权或只当算力节点，见 lifecycle.mjs 的 `isUp`）；
///   ② 500 之类也说明端口上有个真服务在回话 —— 它能渲染出自己的错误页，
///      而不是 WebView 那张"连不上"；
///   ③ 我们唯一要拦的是"端口上没人"（连接被拒 / 超时 / 一个字都不回），那种情况
///      一定会让 WebView2 渲染 `ERR_CONNECTION_REFUSED`，也就是用户实报的那个画面。
fn service_alive(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, HEALTH_TIMEOUT) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(HEALTH_TIMEOUT));
    let _ = stream.set_write_timeout(Some(HEALTH_TIMEOUT));

    let request = format!(
        "GET /api/state HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\
         User-Agent: bandi-desktop\r\nAccept: */*\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }

    // 只要状态行就够了 —— 读一小块，别把 /api/state 的正文（可能几十 KB）拽进壳里
    let mut buf = [0u8; 256];
    match stream.read(&mut buf) {
        // 连上了却一句话不说：不是能给人看的服务，照"不可达"处理
        Ok(0) => false,
        Ok(n) => String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1."),
        Err(_) => false,
    }
}

/// 健康巡检：断了换兜底页，回来了自动跳回去。
///
/// 跑在一条后台线程上，和 `show_once` / `fix_restore_size` 同一套路数 ——
/// `WebviewWindow` 是 Clone + Send 的，`navigate` / `set_title` 会被投递到主线程执行，
/// 不要求自己在主线程（也不能在主线程：那会卡住事件循环）。
///
/// 状态机只有两个状态（在线 / 离线），靠 `offline` 这个局部布尔记着 —— **只在状态翻转时
/// 才导航**，否则每 2 秒都会把页面重刷一遍，用户正在填的东西全丢。
///
/// 两处 2026-10-22 第三轮的加固（都写在对应分支的注释里）：
///   · **去抖**：连续 `HEALTH_MISSES` 次探不通才翻页（一次 >800ms 的卡顿不该把页面刷掉）；
///   · **导航失败要重试**：`navigate` 失败时**不翻转状态**，下一轮接着试 ——
///     旧版是把 `offline` 先置了再导航，失败一次就再也回不来（注释写着"下一轮还会再试"，其实没有）。
///
/// ⚠️ **这条巡检是唯一的恢复路径**，别指望兜底页自己能做什么：它是 `data:` URL，
/// origin 是 opaque(`null`)，从那一页发起的网络请求和 IPC 全被浏览器/ACL 拒掉
/// （2026-10-22 QA 实测，原因写在 `offline.html` 文件头）。所以兜底页里没有「重试」按钮，
/// 只在 flip 时导航。
fn watch_service(win: tauri::WebviewWindow, app_url: tauri::Url, port: u16) {
    let target = app_url.as_str().to_string();
    eprintln!("[壳] 健康巡检开始：每 {}s 探一次 127.0.0.1:{port}", HEALTH_INTERVAL.as_secs());

    std::thread::spawn(move || {
        let mut offline = false;
        // 连续探不通的次数（恢复一次就清零）—— 见 HEALTH_MISSES 的注释
        let mut misses: u32 = 0;
        loop {
            std::thread::sleep(if offline {
                HEALTH_INTERVAL_OFFLINE
            } else {
                HEALTH_INTERVAL
            });

            let alive = service_alive(port);

            if alive {
                misses = 0;
                if offline {
                    /*
                     * 恢复：**导航成功才算真的回去了**。失败就保持 offline = true，
                     * 下一轮（1 秒后）接着试 —— 否则一次瞬时失败会让窗口永远停在兜底页。
                     */
                    eprintln!("[壳] 控制面回来了 —— 导航回控制面");
                    match win.navigate(app_url.clone()) {
                        Ok(()) => {
                            offline = false;
                            let _ = win.set_title("班底");
                        }
                        Err(e) => eprintln!("[壳] 导航回控制面失败：{e} —— 巡检下一轮再试"),
                    }
                }
                continue;
            }

            misses = misses.saturating_add(1);
            if offline {
                continue; // 已经在兜底页上了：别每秒再导航一遍
            }
            if misses < HEALTH_MISSES {
                continue; // 去抖：一次探不通不算数
            }

            eprintln!(
                "[壳] 控制面连续 {} 次探不通（127.0.0.1:{port}）—— 换成本地兜底页，开始自动恢复",
                misses
            );
            let url = match offline_page(&target).parse::<tauri::Url>() {
                Ok(url) => url,
                // 拼不出来基本只可能是 percent-encoding 出了问题；窗口保持原状，下一轮重新累计再试
                Err(e) => {
                    eprintln!("[壳] 兜底页地址不合法：{e}");
                    misses = 0;
                    continue;
                }
            };
            match win.navigate(url) {
                Ok(()) => {
                    offline = true;
                    let _ = win.set_title("班底 · 正在恢复连接");
                    eprintln!("[壳] 已切到兜底页，等服务恢复（巡检每 {}s 一次）", HEALTH_INTERVAL_OFFLINE.as_secs());
                }
                // **不翻状态**：没导航成功就当没发生，下一轮重来（旧版在这里把用户永久卡在错误页）
                Err(e) => {
                    eprintln!("[壳] 兜底页导航失败：{e} —— 巡检下一轮再试");
                    misses = 0;
                }
            }
        }
    });
}

/// 兜底页的地址：一个 `data:` URL。
///
/// **为什么是 `data:` 而不是自定义协议 origin**（这是本次唯一一处路线取舍，写清楚免得后人重走）：
///   · `data:` URL 不依赖任何协议注册、也不依赖磁盘文件（HTML 已 `include_str!` 编进 exe），
///     而且是这个壳里**已经被验证过**的一条路 —— 起不来时的 `error_page` 就是 `data:` URL；
///   · 代价：`data:` 的 origin 是 opaque（`null`）—— 页面里**发不了 IPC**（capability 的
///     `remote.urls` 匹配不了 `null`），也**发不了网络请求**（Local Network Access 直接拒）。
///     所以兜底页只陈述状态，不提供任何"手动操作"：一个点不动、或者会骗人的按钮，
///     比没有按钮更糟。恢复全靠上面那条巡检。
///   · 换成自定义协议 origin 能救回交互能力，但要引入协议注册 + ACL + 一条只有真机才能
///     验证的加载路径。为一个按钮换来一份没人验证过的机制，不划算。
///
/// 占位符替换不做 HTML 转义：`target` 是我们自己拼的 `http://127.0.0.1:<port>`
/// （局域网模式下多一个 `?token=<百分号编码>`），不含引号与尖括号。
fn offline_page(target: &str) -> String {
    let html = OFFLINE_HTML
        .replace("__BANDI_TARGET__", target)
        .replace("__BANDI_VERSION__", APP_VERSION);
    format!("data:text/html;charset=utf-8,{}", pct(&html))
}

/// 起不来时给一张**本地**错误页（不依赖任何服务）。
///
/// 为什么要它：最终用户是双击进来的，起不来时如果只是一片空白或浏览器错误页，
/// 他既不知道发生了什么、也不知道去哪儿看。这里把原因原样摆出来。
///
/// data: URL 里不能出现非 ASCII，所以逐个字节做百分号编码。
fn error_page(message: &str) -> String {
    let html = format!(
        "<!doctype html><meta charset=utf-8><title>班底没起来</title>\
         <style>\
           body{{font:14px/1.8 system-ui,-apple-system,'Segoe UI',sans-serif;margin:0;padding:44px;background:#1b1d21;color:#e7e7e7}}\
           h1{{font-size:19px;margin:0 0 14px}}\
           pre{{white-space:pre-wrap;word-break:break-word;background:#24272c;border:1px solid #33373d;padding:14px 16px;border-radius:8px;font-size:13px}}\
           p{{color:#9aa0a6}}\
           code{{background:#24272c;padding:1px 5px;border-radius:4px}}\
         </style>\
         <h1>班底没起来</h1><pre>{}</pre>\
         <p>去哪儿看：<br>\
         · 控制面的日志：数据目录下的 <code>server.log</code><br>\
         · 它想用的端口可能被别的程序占着（上面那句会写是谁；桌面壳会自己往上找一个空端口）<br>\
         · 装法与排查：仓库里的 <code>deploy/README.md</code></p>",
        esc(message)
    );
    format!("data:text/html;charset=utf-8,{}", pct(&html))
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// 除了 URL 里的"无保留字符"，其余一律百分号编码 —— 最省心也最不容易出错。
fn pct(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
