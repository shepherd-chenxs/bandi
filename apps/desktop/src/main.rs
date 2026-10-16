// 桌面外壳入口。
//
// 下面这条属性是 Windows 专有行为（release 下不挂控制台窗口），但它不是唯一路径：
// 用 `target_os` 限定后，macOS / Linux 编译期两段差异 Attributes 整体不生效，
// 走的是各自平台默认的 GUI 行为，不需要这个文件为「非 Windows」提供另一套实现。
#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

fn main() {
    bandi_desktop::run()
}
