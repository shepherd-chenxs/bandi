/*
 * lib.rs —— 手机薄壳（2026-11）。
 *
 * 壳里**不含任何业务**。它只解决 PWA 解决不了的那一段：
 *   ① 启动页（dist/index.html，本地 asset）：自动发现 / 手输地址 / 粘贴配对链接；
 *   ② 连接测试：Rust 侧手写 HTTP GET /api/hello，认 `platform === 'bandi'`；
 *   ③ 跳转：`webview.navigate(远程地址)` —— 配置页留在 WebView 历史里，Android
 *      返回键在远程页根页时天然退回配置页（Tauri 的 AppPlugin 默认行为，不改 Kotlin）；
 *   ④ 记住地址：`app_config_dir/shell.json`（只存 origin，配对 token 不落盘）。
 *
 * 为什么探测和发现必须在 Rust：配置页 origin 是 `http://tauri.localhost`，fetch 到
 * `http://192.168.x.x` 会被 CORS 与明文策略双重拦；UDP 广播 JS 也发不了。
 * 为什么只依赖 std：一个局域网探测不值得把 tokio/reqwest 拉进 APK。
 */

use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs, UdpSocket};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{Manager, State, Url, Webview};

/// 与服务端 `discover.mjs` 的 DISCOVERY_PORT 一致（UDP）
const DISCOVERY_PORT: u16 = 8788;
/// 用户没写端口时补的默认值（服务端 BANDI_PORT 默认 8787）
const DEFAULT_HTTP_PORT: u16 = 8787;
/// 连接测试打的就是这个免令牌接口（auth.mjs 里在令牌检查之前放行）
const PROBE_PATH: &str = "/api/hello";

#[derive(Default, Serialize, Deserialize, Clone)]
struct ShellSettings {
    /// 上次连上的 origin，如 `http://192.168.1.5:8787`（不带路径与查询）
    server: Option<String>,
}

struct ShellState {
    settings: Mutex<ShellSettings>,
    file: PathBuf,
}

impl ShellState {
    fn save(&self) -> Result<(), String> {
        let json = {
            let s = self.settings.lock().map_err(|_| "设置锁坏了".to_string())?;
            serde_json::to_string_pretty(&*s).map_err(|e| e.to_string())?
        };
        if let Some(dir) = self.file.parent() {
            fs::create_dir_all(dir).map_err(|e| format!("建不了配置目录：{e}"))?;
        }
        fs::write(&self.file, json).map_err(|e| format!("写不了配置：{e}"))
    }
}

/* ---------------------------------------------------------------- 地址 */

/// 用户能输入的东西都收：`192.168.1.5`、`192.168.1.5:8787`、
/// `http://192.168.1.5:8787`、`http://192.168.1.5:8787/pair?token=bp_xxx`。
///
/// 配对链接的路径和查询**必须原样保留** —— 那是 claim 的凭据；补端口只动端口。
fn normalize(input: &str) -> Result<Url, String> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err("地址不能为空".into());
    }
    let with_scheme = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("http://{raw}")
    };
    let mut url = Url::parse(&with_scheme).map_err(|_| format!("看不懂这个地址：{raw}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("只支持 http:// 或 https://".into());
    }
    if url.host_str().unwrap_or("").is_empty() {
        return Err("地址里没有主机".into());
    }
    // 没写端口就补 8787：用户手输 IP 是常态，别让他记端口
    if url.port().is_none() && url.scheme() == "http" {
        url.set_port(Some(DEFAULT_HTTP_PORT))
            .map_err(|_| "端口不合法".to_string())?;
    }
    Ok(url)
}

fn origin_of(url: &Url) -> String {
    let host = url.host_str().unwrap_or("");
    match url.port() {
        Some(p) => format!("{}://{}:{}", url.scheme(), host, p),
        None => format!("{}://{}", url.scheme(), host),
    }
}

/* ---------------------------------------------------------------- 连接测试 */

#[derive(Serialize)]
struct ProbeInfo {
    ok: bool,
    /// 服务端 `localMode.nodeIdentity().label`（人起的名字）
    label: Option<String>,
    hostname: Option<String>,
    version: Option<String>,
    /// 服务端自己报的 HTTP 端口（与用户填的可能不同，界面以这个为准）
    http_port: Option<u16>,
}

/// 手写一个最小 HTTP/1.1 GET。只打 `/api/hello`。
///
/// 两个必须处理的细节（2026-11 实测踩过）：
///   · 服务端 `sendJson` 走的是 **chunked**（`Transfer-Encoding: chunked`，
///     没有 Content-Length），body 里带 `<十六进制长度>\r\n<内容>\r\n` 分块，
///     直接当 JSON 解析必失败 —— 必须解块；
///   · 请求头带 `Connection: close`，`read_to_end` 才能读到 EOF 返回。
fn http_get_hello(url: &Url) -> Result<(u16, String), String> {
    let host = url.host_str().ok_or("地址里没有主机")?.to_string();
    let port = url.port_or_known_default().unwrap_or(DEFAULT_HTTP_PORT);
    let addrs: Vec<SocketAddr> = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|e| format!("解析不了 {host}：{e}"))?
        .collect();
    let sa = *addrs.first().ok_or("解析不到 IP")?;
    let mut sock = TcpStream::connect_timeout(&sa, Duration::from_secs(4))
        .map_err(|e| format!("连不上 {host}:{port} —— {e}"))?;
    sock.set_read_timeout(Some(Duration::from_secs(4))).ok();
    sock.set_write_timeout(Some(Duration::from_secs(4))).ok();
    let req = format!(
        "GET {PROBE_PATH} HTTP/1.1\r\nHost: {host}:{port}\r\nUser-Agent: bandi-mobile-shell\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    sock.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    sock.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&buf);
    let status = text.lines().next().unwrap_or("");
    if !status.contains(" 200") {
        return Err(format!("服务回了：{status}"));
    }
    let head_end = text.find("\r\n\r\n").ok_or("响应没有头尾分隔")?;
    let head = &text[..head_end];
    let raw_body = &text[head_end + 4..];
    let chunked = head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked");
    let body = if chunked {
        decode_chunked(raw_body)
    } else {
        raw_body.to_string()
    };
    Ok((port, body))
}

/// 解 chunked：`<hex 长度>\r\n<数据>\r\n` 重复，`0\r\n\r\n` 结束。
fn decode_chunked(body: &str) -> String {
    let mut out = String::new();
    let mut rest = body;
    loop {
        let Some(pos) = rest.find("\r\n") else { break };
        // 分块长度后面可能跟 `;ext=...`，取分号前那截
        let size_str = rest[..pos].split(';').next().unwrap_or("").trim();
        let Ok(size) = usize::from_str_radix(size_str, 16) else {
            break;
        };
        if size == 0 {
            break;
        }
        let start = pos + 2;
        let end = (start + size).min(rest.len());
        out.push_str(&rest[start..end]);
        rest = &rest[(end + 2).min(rest.len())..];
    }
    out
}

#[tauri::command]
fn probe(input: String) -> Result<ProbeInfo, String> {
    let url = normalize(&input)?;
    let (port, body) = http_get_hello(&url)?;
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|_| {
        let peek: String = body.chars().take(80).collect();
        format!(
            "这个地址回的不是班底（{}）",
            if peek.is_empty() {
                "空响应".to_string()
            } else {
                peek
            }
        )
    })?;
    if v.get("platform").and_then(|x| x.as_str()) != Some("bandi") {
        return Err("这个地址不是班底（platform 对不上）".into());
    }
    Ok(ProbeInfo {
        ok: true,
        label: v.get("label").and_then(|x| x.as_str()).map(str::to_string),
        hostname: v.get("hostname").and_then(|x| x.as_str()).map(str::to_string),
        version: v.get("version").and_then(|x| x.as_str()).map(str::to_string),
        http_port: v
            .get("httpPort")
            .and_then(|x| x.as_u64())
            .map(|n| n as u16)
            .or(Some(port)),
    })
}

/* ---------------------------------------------------------------- UDP 发现 */

/// 与 `discover.mjs` 的 `candidateOf` 同一套字段口径：
/// **地址只取回包的来源 IP**（多网卡时应答里的 url 可能是别的网卡），端口取应答的 httpPort。
#[derive(Serialize)]
struct Candidate {
    label: Option<String>,
    hostname: Option<String>,
    address: String,
    port: u16,
    url: String,
    joinable: bool,
    version: Option<String>,
}

fn nonce_hex() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}{:x}", std::process::id())
}

/// 广播探测 + 收应答。总时长默认 1.8s、每 500ms 重发一轮（对齐服务端探测的节奏）。
#[tauri::command]
fn discover(timeout: Option<u64>) -> Vec<Candidate> {
    let total = timeout.unwrap_or(1800).clamp(400, 6000);
    let nonce = nonce_hex();
    let probe = format!(r#"{{"bandi":"discover","v":1,"nonce":"{nonce}"}}"#);

    let sock = match UdpSocket::bind("0.0.0.0:0") {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    // 广播权限拿不到（某些 ROM / 没开网卡）就当"一台没扫到"：手输地址那条路照样能走
    if sock.set_broadcast(true).is_err() {
        return vec![];
    }
    sock.set_read_timeout(Some(Duration::from_millis(120))).ok();

    let deadline = Instant::now() + Duration::from_millis(total);
    let mut seen: Vec<Candidate> = Vec::new();
    let mut last_send = Instant::now() - Duration::from_secs(1);
    let mut buf = [0u8; 2048];

    while Instant::now() < deadline {
        if last_send.elapsed() >= Duration::from_millis(500) {
            let _ = sock.send_to(probe.as_bytes(), ("255.255.255.255", DISCOVERY_PORT));
            last_send = Instant::now();
        }
        let Ok((n, from)) = sock.recv_from(&mut buf) else {
            continue; // 读超时：继续循环（下一轮重发/等收尾）
        };
        let text = String::from_utf8_lossy(&buf[..n]);
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue; // 网段里别的东西
        };
        if v.get("bandi").and_then(|x| x.as_str()) != Some("announce") {
            continue;
        }
        // 只认自己这一轮发出去的 nonce（迟到包丢掉）
        if v.get("nonce").and_then(|x| x.as_str()) != Some(nonce.as_str()) {
            continue;
        }
        let port = v.get("httpPort").and_then(|x| x.as_u64()).unwrap_or(0);
        if port == 0 || port > 65535 {
            continue;
        }
        let port = port as u16;
        let address = from.ip().to_string();
        let url = format!("http://{address}:{port}");
        if seen.iter().any(|c| c.url == url) {
            continue;
        }
        seen.push(Candidate {
            label: v.get("label").and_then(|x| x.as_str()).map(str::to_string),
            hostname: v.get("hostname").and_then(|x| x.as_str()).map(str::to_string),
            address,
            port,
            url,
            // 老总机不报 joinable：既然在应答就说明开关是开的
            joinable: v.get("joinable").and_then(|x| x.as_bool()).unwrap_or(true),
            version: v.get("version").and_then(|x| x.as_str()).map(str::to_string),
        });
    }
    seen.sort_by(|a, b| {
        b.joinable
            .cmp(&a.joinable)
            .then_with(|| a.url.cmp(&b.url))
    });
    seen
}

/* ---------------------------------------------------------------- 设置与跳转 */

#[derive(Serialize)]
struct SettingsView {
    server: Option<String>,
    default_port: u16,
}

#[tauri::command]
fn get_settings(state: State<ShellState>) -> SettingsView {
    let server = state
        .settings
        .lock()
        .ok()
        .and_then(|s| s.server.clone());
    SettingsView {
        server,
        default_port: DEFAULT_HTTP_PORT,
    }
}

/// 跳过去。`input` 可以是完整配对链接 —— 路径与查询原样用，
/// 但**落盘只存 origin**，一次性 token 不留在手机里。
#[tauri::command]
fn open_server(webview: Webview, input: String, state: State<ShellState>) -> Result<(), String> {
    let url = normalize(&input)?;
    {
        let mut s = state.settings.lock().map_err(|_| "设置锁坏了".to_string())?;
        s.server = Some(origin_of(&url));
    }
    state.save()?;
    webview
        .navigate(url)
        .map_err(|e| format!("跳转失败：{e}"))
}

#[tauri::command]
fn forget_server(state: State<ShellState>) -> Result<(), String> {
    {
        let mut s = state.settings.lock().map_err(|_| "设置锁坏了".to_string())?;
        s.server = None;
    }
    state.save()
}

/* ---------------------------------------------------------------- 入口 */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            let file = dir.join("shell.json");
            let settings = fs::read_to_string(&file)
                .ok()
                .and_then(|t| serde_json::from_str::<ShellSettings>(&t).ok())
                .unwrap_or_default();
            app.manage(ShellState {
                settings: Mutex::new(settings),
                file,
            });
            /*
             * 窗口必须在这里建（而不是 tauri.conf.json 的 app.windows）：
             * `on_navigation` 是 WebviewWindowBuilder 的方法，Builder 上没有。
             *
             * 导航白名单：本地配置页（tauri://localhost 或 http://tauri.localhost）+
             * 任意 http/https（局域网 IP、隧道域名）。file/javascript/data 一律不放。
             * 这个壳是个人局域网工具，不做域名白名单 —— 白名单会让"用户换了 IP"变成改代码。
             */
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("班底")
            .on_navigation(|url| matches!(url.scheme(), "tauri" | "http" | "https"))
            .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            open_server,
            forget_server,
            discover,
            probe
        ])
        .run(tauri::generate_context!())
        .expect("班底手机壳启动失败");
}
