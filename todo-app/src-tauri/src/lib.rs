// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
pub mod commands;
pub mod store;
pub mod today;
pub mod window;

use std::sync::Mutex;
use store::State;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // single-instance 必须最先注册；二次启动时唤起已有窗口
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Err(e) = window::restore_window(app) {
                eprintln!("[todo] 二次启动唤起失败: {e}");
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            use tauri::Manager;
            let dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("无法定位数据目录: {e}"))?;
            let (state, warn) = State::load(&dir)?;
            if let Some(w) = warn {
                eprintln!("[todo] {w}");
            }
            app.manage(Mutex::new(state));

            // 托盘常驻（菜单/角标/事件见 window.rs）
            window::create_tray(app)?;

            // 自启插件按 settings 同步（release 才写系统项；dev 仅保持 UI 勾选态一致）
            {
                let state = app.state::<Mutex<State>>();
                let on = state.lock().map_err(|_| "状态锁被占用")?.settings.auto_start;
                window::sync_autostart(app.handle(), on)?;
            }

            // 位置记忆：debounce 线程 + 初始窗口挂 Moved 监听
            let sink = window::spawn_move_saver(app.handle().clone());
            if let Some(win) = window::main_window(app.handle()) {
                window::apply_placement(app.handle(), &win)?;
                window::attach_moved_listener(&win, sink);
            }

            // 开机判定：有今日/过期待办（或开关关闭）才显示主窗，否则销毁仅留托盘
            // （tauri.conf.json 初始窗口 visible:false，避免无待办时的窗口闪烁）
            {
                let state = app.state::<Mutex<State>>();
                let show = {
                    let st = state.lock().map_err(|_| "状态锁被占用")?;
                    today::should_show_on_boot(&st, chrono::Local::now().date_naive())
                };
                if let Some(win) = window::main_window(app.handle()) {
                    if show {
                        let _ = win.show();
                        let _ = win.set_focus();
                    } else {
                        let _ = win.close();
                    }
                }
            }
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
            commands::collapse,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, event| {
            // 收起/开机无待办会销毁窗口；最后一个窗口关闭时默认退出会连带托盘，
            // 故仅拦截"无退出码"的退出请求（app.exit(0) 带码，托盘退出不受影响）
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
