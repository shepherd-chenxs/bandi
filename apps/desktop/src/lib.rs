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

mod shell;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// 版本真源经 build.rs 注入的编译期常量。标题上的版本号只认它。
const APP_VERSION: &str = env!("APP_VERSION");

pub fn run() {
    tauri::Builder::default()
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
                        if *owned { "本次由壳启动，退出会收掉" } else { "复用已有的，退出不动它" }
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

            let title = if ready {
                format!("班底 {APP_VERSION}")
            } else {
                format!("班底 {APP_VERSION} · 没起来")
            };

            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title(title)
                .inner_size(1280.0, 860.0)
                .min_inner_size(880.0, 600.0)
                .build()?;
            let _ = win.set_focus();
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("启动桌面薄壳失败")
        .run(|_app, event| {
            // 关窗 / 退出：让 Node 那半收摊（它自己判断这控制面是不是它起的）
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                shell::stop();
            }
        });
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
         · 端口 8787 可能被别的程序占着（上面那句会写是谁）<br>\
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
