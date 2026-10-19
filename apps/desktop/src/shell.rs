//! 薄壳的 **Rust 那一半**：找 Node → 拉起 `shell.mjs` → 读协议行 → 退出时收摊。
//!
//! ⚠️ 这里**不做**"控制面起没起、要不要起、退出收不收"的判断 —— 那是 Node 那半的活，
//! 用的是与 `start.cmd` **同一份** `apps/server/src/lifecycle.mjs`。
//! 两半之间只有三行协议（见 `apps/desktop/shell.mjs` 的注释）；这边多写一句逻辑，
//! 那边就多一个跑偏的机会 —— 前端当初那两套就是这么来的。

use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// 与 `shell.mjs` 约定的协议前缀
const PREFIX: &str = "BANDI_SHELL ";
/// 等就绪的宽限。Node 那半自己会等 30 秒健康检查，这里再宽一点。
const READY_TIMEOUT: Duration = Duration::from_secs(45);
/// 退出时留给 Node 收摊的时间（关掉 stdin 之后）
const STOP_GRACE: Duration = Duration::from_secs(3);

static CHILD: OnceLock<Mutex<Option<Child>>> = OnceLock::new();

fn child_slot() -> &'static Mutex<Option<Child>> {
    CHILD.get_or_init(|| Mutex::new(None))
}

/// 起没起来；起来了的话，控制面是**我们起的**还是复用已有的
pub enum Launch {
    Ready { url: String, owned: bool },
    Failed { message: String },
}

/// 安装/仓库根。
///
/// ⚠️ **两种布局必须用两个判据**。曾经只有一个"有 `apps/desktop/shell.mjs` 就算根"，
/// 结果 `tauri build` 把 `runtime/apps` 摊成 exe 旁边的 `apps/` 之后，exe 自己那一层就满足条件，
/// 开发版当场被冻结副本劫持 —— 仓库里改什么都不会生效，而且没有任何报错。
///
/// 现在分两种：
///   - **源码根** = 有 `apps/desktop/shell.mjs` **且** 有 `apps/desktop/Cargo.toml`（Rust 源码在）
///   - **安装根** = 有 `apps/desktop/shell.mjs`（payload 是摊平的，没有源码）
///
/// 顺序：
///   1. `BANDI_HOME`（显式指定，宽松判据 —— 人说哪儿就是哪儿）
///   2. 往上找**源码根**（开发布局：`<root>/apps/desktop/target/<profile>/bandi-desktop.exe`）
///   3. 往上找**安装根**（安装布局：exe 同级摊着 payload）
pub fn find_root() -> Option<PathBuf> {
    let has_shell = |p: &Path| p.join("apps").join("desktop").join("shell.mjs").is_file();
    // 只有源码检出才有 Cargo.toml，build 产物里没有 —— 这是区分两者的锚点
    let is_source_root =
        |p: &Path| has_shell(p) && p.join("apps").join("desktop").join("Cargo.toml").is_file();

    if let Ok(h) = std::env::var("BANDI_HOME") {
        let p = PathBuf::from(h);
        if has_shell(&p) {
            return Some(p);
        }
    }

    let exe = std::env::current_exe().ok()?;
    let mut chain: Vec<PathBuf> = Vec::new();
    let mut cur = exe.parent().map(Path::to_path_buf);
    for _ in 0..6 {
        let Some(dir) = cur else { break };
        chain.push(dir.clone());
        cur = dir.parent().map(Path::to_path_buf);
    }

    // 先认源码根：哪怕 exe 旁边摊着 build 产物，也会继续往上走到真正的仓库根
    if let Some(root) = chain.iter().find(|d| is_source_root(d)) {
        return Some(root.clone());
    }
    // 再退安装根：安装版没有源码，靠这条活
    chain.into_iter().find(|d| has_shell(d))
}

/// 随包分发的 Node。**正式安装包必须走这条** —— `v1.0.0` 的 B2 就一句话：
/// 不许要求用户自装运行时。
///
/// 顺序（谁在前面谁优先）：
///   1. `BANDI_NODE`（显式指定；测试与救急用）
///   2. 安装包资源目录 —— `tauri.conf.json` 的 `bundle.resources` 把 `binaries/node.exe`
///      放成了资源；Windows 上它就在 exe 旁边
///   3. 便携/开发布局：`<root>/apps/desktop/binaries/`、`<root>/runtime/`
///   4. 都没有 → `None`，退回 PATH 上的 `node`
///      （开发机上够用；**用户机器上不该走到这一步**，走到了就是安装包漏带了）
fn find_node(root: &Path, packaged: Option<&Path>) -> Option<PathBuf> {
    let name = if cfg!(windows) { "node.exe" } else { "node" };

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = std::env::var("BANDI_NODE") {
        candidates.push(PathBuf::from(p));
    }
    if let Some(p) = packaged {
        candidates.push(p.to_path_buf());
    }
    // exe 旁边（NSIS 装出来就是这个形状：node.exe 与 bandi-desktop.exe 同目录）
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(name));
        }
    }
    candidates.push(root.join("apps").join("desktop").join("binaries").join(name));
    candidates.push(root.join("runtime").join(name));

    candidates.into_iter().find(|c| c.is_file())
}

/// 拉起 `shell.mjs`，等它给一句协议。
///
/// `packaged` 是安装包资源目录里那份 Node（`lib.rs` 用 Tauri 的资源解析拿到的）。
pub fn launch(root: &Path, packaged: Option<&Path>) -> Launch {
    let script = root.join("apps").join("desktop").join("shell.mjs");
    let mut cmd = match find_node(root, packaged) {
        Some(n) => Command::new(n),
        None => Command::new("node"),
    };
    cmd.arg(&script)
        .current_dir(root)
        .stdin(Stdio::piped()) // 退出时**关掉它**就是收摊信号
        .stdout(Stdio::piped())
        .stderr(Stdio::piped()); // 接着读（不能 inherit，见下）

    /*
     * Windows：**别让它弹出一块控制台**。
     *
     * 壳自己（bandi-desktop.exe）是 GUI 子系统（`main.rs` 的 `windows_subsystem`），
     * 本来就没有控制台；而 `node.exe` 是**控制台程序**。从 GUI 进程起它、又不带
     * `CREATE_NO_WINDOW`，Windows 会**新分配一个控制台窗口** ——
     * Win11 上就是一个 Windows Terminal 窗口，标题还是 node.exe 的完整路径。
     * 用户看到的就是这个"莫名其妙的命令行"（2026-10-15 实报）。
     *
     * 顺带：原来这里是 `.stderr(Stdio::inherit())`，那既接不住任何东西（父进程没控制台），
     * 也**没有任何人读**子进程的 stderr。改成管道 + 下面那个线程接着读：
     * 万一壳写日志把管道写满了，子进程会**卡死在 write 上**，整个就绪流程跟着吊住。
     */
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return Launch::Failed {
                message: format!(
                    "起不来 Node：{e}\n\n要么把 Node 装好并加进 PATH，要么随包分发一份\
                     （见 deploy/README.md）。"
                ),
            }
        }
    };

    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        return Launch::Failed {
            message: "读不到壳进程的输出（stdout 没接上）".to_string(),
        };
    };

    // 读行放另一个线程：主线程要能按 deadline 放弃，而不是被一次 read 卡死
    let (tx, rx) = mpsc::channel::<Option<String>>();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => {
                    let _ = tx.send(None);
                    break;
                }
                Ok(_) => {
                    if tx.send(Some(line.trim_end().to_string())).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let deadline = Instant::now() + READY_TIMEOUT;

    /*
     * stderr 也得有人接着读（上面已经改成管道了）：壳把"人话"写在这儿 ——
     * 数据目录、选中哪个端口、为什么起不来。留最近 40 行，失败时摆到错误页上，
     * 省得用户为了看一句原因去翻 `%APPDATA%\bandi\shell.log`。
     */
    let tail = Arc::new(Mutex::new(VecDeque::<String>::new()));
    if let Some(stderr) = child.stderr.take() {
        let tail = Arc::clone(&tail);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let s = line.trim_end().to_string();
                        if s.is_empty() {
                            continue;
                        }
                        let mut t = tail.lock().unwrap_or_else(|e| e.into_inner());
                        t.push_back(s);
                        while t.len() > 40 {
                            t.pop_front();
                        }
                    }
                }
            }
        });
    }
    let tail_text = || -> String {
        let t = tail.lock().unwrap_or_else(|e| e.into_inner());
        if t.is_empty() {
            String::new()
        } else {
            format!("\n\n壳最后说了这些：\n{}", t.iter().cloned().collect::<Vec<_>>().join("\n"))
        }
    };

    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            let _ = child.kill();
            return Launch::Failed {
                message: format!("等了 {} 秒还没就绪{}", READY_TIMEOUT.as_secs(), tail_text()),
            };
        }
        match rx.recv_timeout(left) {
            Ok(Some(line)) => {
                let Some(rest) = line.strip_prefix(PREFIX) else {
                    continue; // 不是协议行（人话都走 stderr）—— 忽略
                };
                if let Some(args) = rest.strip_prefix("READY ") {
                    let (url, owned) = match args.rsplit_once(' ') {
                        Some((u, f)) => (u.to_string(), f == "1"),
                        None => (args.to_string(), false),
                    };
                    *child_slot().lock().unwrap_or_else(|e| e.into_inner()) = Some(child);
                    return Launch::Ready { url, owned };
                }
                let bad = rest
                    .strip_prefix("FAILED ")
                    .or_else(|| rest.strip_prefix("ALIEN "));
                if let Some(m) = bad {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Launch::Failed {
                        message: format!("{m}{}", tail_text()),
                    };
                }
            }
            // 壳进程自己没了（EOF）
            Ok(None) => {
                let _ = child.wait();
                return Launch::Failed {
                    message: format!("壳进程提前退出了，没给出就绪信息{}", tail_text()),
                };
            }
            Err(mpsc::RecvTimeoutError::Timeout) => { /* 回到上面再判一次 deadline */ }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = child.kill();
                return Launch::Failed {
                    message: format!("壳进程的输出断了{}", tail_text()),
                };
            }
        }
    }
}

/// 退出时收摊：**关掉 stdin**（Node 那半收到 EOF 就把它**自己起的**控制面收掉），再等一会儿；不走就掐。
///
/// 为什么不直接 kill：`shell.mjs` 得有时间判断"这控制面是不是我起的"再收干净。
/// 直接掐会把控制面留成孤儿 —— 界面关了、后台还在跑（而且用户命令行开的那个也会被误杀，
/// 如果 kill 传给了整棵进程树）。
pub fn stop() {
    let mut guard = child_slot().lock().unwrap_or_else(|e| e.into_inner());
    let Some(mut child) = guard.take() else {
        return;
    };
    drop(child.stdin.take()); // 关掉管道 = 告诉 Node"该收摊了"

    let deadline = Instant::now() + STOP_GRACE;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(60)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return;
            }
        }
    }
}
