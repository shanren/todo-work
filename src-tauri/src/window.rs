//! 窗口生命周期（Task 9 设计修订：无 hide 态——展示/隐藏即重建/销毁）。
//!
//! - `restore_window`：托盘与命令共用的重建入口；已存在则仅聚焦
//! - `apply_placement`：按 settings.posX/posY 或默认右上角（主屏宽 - 窗宽 - 16, 16）定位
//! - 位置记忆：Moved 事件 → 500ms debounce（Condvar 线程，空闲零轮询）→ 写回 settings 并落盘

use crate::store::State;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, Wry};

pub const MAIN_LABEL: &str = "main";
const EDGE: f64 = 16.0;
const DEFAULT_HEIGHT: f64 = 560.0;
const MOVE_DEBOUNCE: Duration = Duration::from_millis(500);

/// 获取主窗（可能不存在——收起即销毁）。
pub fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN_LABEL)
}

/// 托盘/命令共用的展示入口：窗口存在则聚焦，否则按当前 settings 重建。
pub fn restore_window(app: &AppHandle) -> Result<(), String> {
    use tauri::Manager;
    if let Some(win) = main_window(app) {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    let width = {
        let state = app.state::<Mutex<State>>();
        let guard = state.lock().map_err(|_| "状态锁被占用".to_string())?;
        guard.settings.width
    };
    let win = tauri::WebviewWindowBuilder::new(
        app,
        MAIN_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title("待办")
    .inner_size(f64::from(width), DEFAULT_HEIGHT)
    .decorations(false)
    .transparent(true)
    .skip_taskbar(true)
    .visible(false)
    .build()
    .map_err(|e| format!("重建窗口失败: {e}"))?;
    apply_placement(app, &win)?;
    let _ = win.show();
    let _ = win.set_focus();
    // 重建后让前端拉取最新状态（若窗口已在前端就绪则刷新一次，幂等）
    let _ = win.emit("state-changed", ());
    Ok(())
}

/// 定位：记忆位置优先（仅当仍落在某个现存显示器内），否则主屏右上角。
pub fn apply_placement(app: &AppHandle, win: &WebviewWindow) -> Result<(), String> {
    use tauri::Manager;
    let (pos_x, pos_y, width) = {
        let state = app.state::<Mutex<State>>();
        let s = state.lock().map_err(|_| "状态锁被占用".to_string())?;
        (s.settings.pos_x, s.settings.pos_y, s.settings.width)
    };
    if let (Some(x), Some(y)) = (pos_x, pos_y) {
        let monitors: Vec<(i32, i32, u32, u32)> = app
            .available_monitors()
            .map_err(|e| format!("获取显示器列表失败: {e}"))?
            .iter()
            .map(|m| {
                let p = m.position();
                let s = m.size();
                (p.x, p.y, s.width, s.height)
            })
            .collect();
        if is_position_visible(x, y, &monitors) {
            return win
                .set_position(PhysicalPosition::new(x as i32, y as i32))
                .map_err(|e| format!("应用记忆位置失败: {e}"));
        }
        // 记忆位置已不在任何现存显示器（如拔掉外接屏）→ 清除记忆，回退到主屏右上角
        {
            let state = app.state::<Mutex<State>>();
            let locked = state.lock();
            if let Ok(mut s) = locked {
                s.settings.pos_x = None;
                s.settings.pos_y = None;
                if let Ok(dir) = app.path().app_data_dir() {
                    let _ = s.save(&dir);
                }
            }
        }
    }
    let monitor = app
        .primary_monitor()
        .map_err(|e| format!("获取主显示器失败: {e}"))?
        .ok_or("无主显示器")?;
    let logical_w = monitor.size().to_logical::<f64>(monitor.scale_factor()).width;
    let x = logical_w - f64::from(width) - EDGE;
    win.set_position(tauri::LogicalPosition::new(x, EDGE))
        .map_err(|e| format!("应用右上角定位失败: {e}"))
}

/// 纯函数：左上角坐标是否落在任一显示器的边界内（容差 8px，窗口至少露出一角）。
fn is_position_visible(x: f64, y: f64, monitors: &[(i32, i32, u32, u32)]) -> bool {
    const TOLERANCE: f64 = 8.0;
    monitors.iter().any(|(mx, my, mw, mh)| {
        let right = f64::from(*mx) + f64::from(*mw);
        let bottom = f64::from(*my) + f64::from(*mh);
        x >= f64::from(*mx) - TOLERANCE
            && y >= f64::from(*my) - TOLERANCE
            && x < right
            && y < bottom
    })
}

#[cfg(test)]
mod tests {
    use super::is_position_visible;
    // 主屏 1920x1080 原点 0,0；副屏 2560x1440 位于主屏右侧 1920,0
    const DUAL: [(i32, i32, u32, u32); 2] = [(0, 0, 1920, 1080), (1920, 0, 2560, 1440)];
    const SINGLE: [(i32, i32, u32, u32); 1] = [(0, 0, 1920, 1080)];

    #[test]
    fn dual_screen_saved_pos_ok_while_both_exist() {
        assert!(is_position_visible(3524.0, 16.0, &DUAL));
    }

    #[test]
    fn single_screen_rejects_second_monitor_pos() {
        // 单屏后，原副屏上的记忆位置越界
        assert!(!is_position_visible(3524.0, 16.0, &SINGLE));
    }

    #[test]
    fn primary_corner_still_visible() {
        assert!(is_position_visible(1564.0, 16.0, &SINGLE));
    }

    #[test]
    fn slightly_offscreen_within_tolerance_is_visible() {
        assert!(is_position_visible(-4.0, 16.0, &SINGLE));
    }
}

// ============================================================
// 位置记忆：Moved 事件 → 500ms debounce → settings.posX/posY + 落盘
// ============================================================

struct PendingMove {
    seq: u64,
    pos: Option<(f64, f64)>,
    last: Instant,
}

/// 可克隆的移动事件汇（Moved 回调只能拿 'static 数据，经 Arc 共享）。
#[derive(Clone)]
pub struct MoveSink {
    shared: Arc<(Mutex<PendingMove>, Condvar)>,
}

impl MoveSink {
    pub fn push(&self, x: f64, y: f64) {
        let (lock, _) = &*self.shared;
        let mut p = lock.lock().expect("move sink poisoned");
        p.seq += 1;
        p.pos = Some((x, y));
        p.last = Instant::now();
        drop(p);
        self.shared.1.notify_all();
    }
}

/// 启动 debounce 线程：静默 500ms 后把最后位置写入 settings 并落盘。
/// Condvar 阻塞等待，空闲无轮询 CPU。
pub fn spawn_move_saver(app: AppHandle) -> MoveSink {
    let shared = Arc::new((
        Mutex::new(PendingMove { seq: 0, pos: None, last: Instant::now() }),
        Condvar::new(),
    ));
    let sink = MoveSink { shared: shared.clone() };
    std::thread::Builder::new()
        .name("pos-debounce".into())
        .spawn(move || {
            let (lock, cvar) = &*shared;
            let mut saved_seq: u64 = 0;
            loop {
                let mut p = lock.lock().expect("move sink poisoned");
                // 等待直到：有新位置 且 距最后一次移动已静默 500ms
                loop {
                    let quiet = p.last.elapsed() >= MOVE_DEBOUNCE;
                    if p.pos.is_some() && p.seq != saved_seq && quiet {
                        break;
                    }
                    let wait = MOVE_DEBOUNCE
                        .checked_sub(p.last.elapsed())
                        .unwrap_or(Duration::from_millis(100));
                    let (g, timeout) = cvar
                        .wait_timeout(p, wait)
                        .expect("move sink poisoned");
                    p = g;
                    if timeout.timed_out() && p.pos.is_some() && p.seq != saved_seq {
                        break;
                    }
                }
                if let Some((x, y)) = p.pos {
                    saved_seq = p.seq;
                    drop(p);
                    save_position(&app, x, y);
                }
            }
        })
        .expect("启动位置记忆线程失败");
    sink
}

fn save_position(app: &AppHandle, x: f64, y: f64) {
    use tauri::Manager;
    let state = app.state::<Mutex<State>>();
    let dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[todo] 位置记忆: 数据目录不可用: {e}");
            return;
        }
    };
    let result = (|| -> std::io::Result<()> {
        let mut st = state
            .lock()
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        st.settings.pos_x = Some(x);
        st.settings.pos_y = Some(y);
        st.save(&dir)
    })()
    .map_err(|e| e.to_string());
    if let Err(e) = result {
        eprintln!("[todo] 位置记忆写入失败: {e}");
    }
}

/// 把当前内存状态落盘（托盘自启切换等无命令上下文的调用点用）。
fn persist_state(app: &AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let state = app.state::<Mutex<State>>();
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("数据目录不可用: {e}"))?;
    let guard = state.lock().map_err(|_| "状态锁被占用".to_string())?;
    guard
        .save(&dir)
        .map_err(|e| format!("写入数据失败: {e}"))
}

/// 给窗口挂 Moved 监听（初始窗口与重建窗口都要调用）。
pub fn attach_moved_listener(win: &WebviewWindow, sink: MoveSink) {
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::Moved(pos) = event {
            sink.push(f64::from(pos.x), f64::from(pos.y));
        }
    });
}

// ============================================================
// 托盘（与窗口生命周期同域：菜单事件即窗口事件）
// ============================================================

/// 托盘菜单项 id 常量（与 lib.rs 创建时的 id 一致）。
pub mod menu_id {
    pub const SHOW: &str = "show";
    pub const QUICK_ADD: &str = "quick-add";
    pub const SETTINGS: &str = "open-settings";
    pub const AUTOSTART: &str = "toggle-autostart";
    pub const QUIT: &str = "quit";
}

/// 托盘可变项句柄（勾选态更新用）。
pub struct TrayState {
    pub autostart_item: CheckMenuItem<Wry>,
}

/// 创建托盘：默认图标 + 菜单（显示/快速添加/设置/开机自启✓/退出），左键点击 = 显示窗口。
pub fn create_tray(app: &tauri::App) -> Result<(), String> {
    use tauri::Manager;
    let autostart_checked = {
        let state = app.state::<Mutex<State>>();
        let guard = state.lock().map_err(|_| "状态锁被占用")?;
        guard.settings.auto_start
    };
    let show = MenuItem::with_id(app, menu_id::SHOW, "显示待办", true, None::<&str>)
        .map_err(tmenu)?;
    let quick = MenuItem::with_id(app, menu_id::QUICK_ADD, "快速添加", true, None::<&str>)
        .map_err(tmenu)?;
    let settings_item =
        MenuItem::with_id(app, menu_id::SETTINGS, "设置", true, None::<&str>).map_err(tmenu)?;
    let autostart = CheckMenuItem::with_id(
        app,
        menu_id::AUTOSTART,
        "开机自启",
        true,
        autostart_checked,
        None::<&str>,
    )
    .map_err(tmenu)?;
    let quit = MenuItem::with_id(app, menu_id::QUIT, "退出", true, None::<&str>).map_err(tmenu)?;
    let sep1 = PredefinedMenuItem::separator(app).map_err(tmenu)?;
    let sep2 = PredefinedMenuItem::separator(app).map_err(tmenu)?;
    let menu = Menu::with_items(
        app,
        &[&show, &quick, &settings_item, &sep1, &autostart, &sep2, &quit],
    )
    .map_err(tmenu)?;

    let icon = app
        .default_window_icon()
        .ok_or("缺少应用图标")?
        .clone();

    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("待办")
        .on_tray_icon_event(|tray: &tauri::tray::TrayIcon<Wry>, event| {
            // 左键抬起 = 显示/聚焦主窗
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Err(e) = restore_window(tray.app_handle()) {
                    eprintln!("[todo] 托盘唤起失败: {e}");
                }
            }
        })
        .on_menu_event(|app: &AppHandle, event| match event.id().as_ref() {
            menu_id::SHOW => {
                if let Err(e) = restore_window(app) {
                    eprintln!("[todo] {e}");
                }
            }
            menu_id::QUICK_ADD => show_with_event(app, "focus-add"),
            menu_id::SETTINGS => show_with_event(app, "open-settings"),
            menu_id::AUTOSTART => {
                // 托盘切换勾选 → 与设置面板同一同步路径
                let on = {
                    let state = app.state::<Mutex<State>>();
                    let mut guard = match state.lock() {
                        Ok(s) => s,
                        Err(_) => return,
                    };
                    guard.settings.auto_start = !guard.settings.auto_start;
                    guard.settings.auto_start
                };
                if let Err(e) = persist_state(app) {
                    eprintln!("[todo] 自启设置落盘失败: {e}");
                }
                if let Err(e) = sync_autostart(app, on) {
                    eprintln!("[todo] 自启切换失败: {e}");
                }
            }
            menu_id::QUIT => app.exit(0),
            _ => {}
        })
        .build(app)
        .map_err(tmenu)?;

    app.manage(TrayState { autostart_item: autostart });
    refresh_badge(app.handle());
    Ok(())
}

fn tmenu<E: std::fmt::Display>(e: E) -> String {
    format!("托盘构建失败: {e}")
}

/// 展示窗口并向前端发事件（快速添加 → 聚焦添加栏；设置 → 打开设置面板）。
fn show_with_event(app: &AppHandle, event: &str) {
    if let Err(e) = restore_window(app) {
        eprintln!("[todo] {e}");
        return;
    }
    if let Some(win) = main_window(app) {
        let _ = win.emit(event, ());
    }
}

/// 角标（tooltip）= 今日剩余数（Today + Overdue 未完成项）。
pub fn refresh_badge(app: &AppHandle) {
    use tauri::Manager;
    let n = {
        let state = app.state::<Mutex<State>>();
        let st = match state.lock() {
            Ok(s) => s,
            Err(_) => return,
        };
        let today = chrono::Local::now().date_naive();
        st.todos
            .iter()
            .filter(|t| matches!(crate::today::bucket(t, today), crate::today::Bucket::Today | crate::today::Bucket::Overdue))
            .count()
    };
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_tooltip(Some(format!("待办 · 今日剩余 {n}")));
    }
}

/// 自启同步：更新托盘勾选态；release 构建同时写系统自启项（dev 只改 UI，避免注册调试路径）。
pub fn sync_autostart(app: &AppHandle, on: bool) -> Result<(), String> {
    use tauri::Manager;
    if let Some(ts) = app.try_state::<TrayState>() {
        ts.autostart_item.set_checked(on).map_err(tmenu)?;
    }
    #[cfg(not(debug_assertions))]
    {
        // ManagerExt：autolaunch() 返回 State<AutoLaunchManager>（非 Result，勿再加 map_err）。
        // 仅 release 编译写系统自启，dev 下不触发注册表写入。
        use tauri_plugin_autostart::ManagerExt;
        let al = app.autolaunch();
        let r = if on { al.enable() } else { al.disable() };
        r.map_err(|e| format!("写系统自启失败: {e}"))?;
    }
    #[cfg(debug_assertions)]
    let _ = (app, on);
    Ok(())
}
