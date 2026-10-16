//! 构建脚本：把版本真源（version.json）编译进程序，并同步到 tauri.conf.json 供打包用。
//!
//! 版本真源唯一：apps/desktop/version.json。
//! 这里不做任何解析兜底——读不到或格式不对就构建失败，避免出现第二个真源。

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

/// 版本真源文件名。相对 Cargo 清单所在目录（apps/desktop/）。
const VERSION_SOURCE_RELATIVE: &str = "version.json";

fn main() {
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR 应由 cargo 提供");
    let manifest_dir = Path::new(&manifest_dir);

    let version = read_version(manifest_dir);
    validate_version(&version);

    // 版本进程序：编译期常量 APP_VERSION。界面显示的唯一取值来源。
    println!("cargo:rustc-env=APP_VERSION={version}");
    // version.json 变了就重跑本脚本。
    println!("cargo:rerun-if-changed={VERSION_SOURCE_RELATIVE}");

    // 同一个真源同步给打包配置：tauri.conf.json 的 version 字段。
    // 打包读的就是这里写进去的值，不另设一处。
    sync_tauri_conf(manifest_dir, &version);

    tauri_build::build();
}

/// 从版本真源读版本号。
fn read_version(manifest_dir: &Path) -> String {
    let path: PathBuf = manifest_dir.join(VERSION_SOURCE_RELATIVE);
    let raw = fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("读版本真源失败：{}（原因：{e}）", path.display()));
    let parsed: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("版本真源不是合法 JSON：{}（原因：{e}）", path.display()));

    let version = parsed
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| panic!("版本真源缺少字符串字段 version：{}", path.display()));

    version.trim().to_string()
}

fn validate_version(version: &str) {
    let parts: Vec<&str> = version.split('.').collect();
    let ok = parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
    assert!(ok, "版本号必须是三段数字（如 1.0.0），实际是：{version}");
}

/// 把版本号写进 tauri.conf.json 的 version 字段（就地改这一个字段，其余内容原样保留）。
fn sync_tauri_conf(manifest_dir: &Path, version: &str) {
    let path = manifest_dir.join("tauri.conf.json");
    let raw = fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("读打包配置失败：{}（原因：{e}）", path.display()));

    let mut parsed: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("打包配置不是合法 JSON：{}（原因：{e}）", path.display()));

    let field = parsed
        .get_mut("version")
        .unwrap_or_else(|| panic!("打包配置缺少 version 字段：{}", path.display()));

    if field.as_str() == Some(version) {
        return; // 已经一致，不重写文件，避免无谓的 mtime 变化。
    }

    *field = serde_json::Value::String(version.to_string());
    let out = serde_json::to_string_pretty(&parsed).expect("序列化打包配置失败");
    fs::write(&path, out).unwrap_or_else(|e| panic!("写回打包配置失败：{}（原因：{e}）", path.display()));
}
