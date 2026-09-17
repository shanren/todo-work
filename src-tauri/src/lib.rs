// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
pub mod commands;
pub mod store;
pub mod today;

use std::sync::Mutex;
use store::State;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            use tauri::Manager;
            let dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("无法定位数据目录: {e}"))?;
            let (state, warn) = State::load(&dir)?;
            if let Some(w) = warn {
                eprintln!("[todo] {w}"); // 恢复提示，托盘气泡提醒在 Task 9 接入
            }
            app.manage(Mutex::new(state));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_state,
            commands::add_todo,
            commands::toggle_todo,
            commands::update_todo,
            commands::delete_todo,
            commands::reorder,
            commands::add_category,
            commands::update_category,
            commands::delete_category,
            commands::set_settings,
            commands::quick_add,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
