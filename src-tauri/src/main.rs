// 桌面壳入口：只负责起窗口并加载前端产物。
// 前端仍由 Vite 构建（dist/），本文件不持有任何规则或对局状态。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("启动 Tauri 运行时失败");
}
