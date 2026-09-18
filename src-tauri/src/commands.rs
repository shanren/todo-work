//! IPC 命令层：纯函数（`ops` 模块）+ #[tauri::command] 薄封装。
//!
//! 架构约定：所有状态变更逻辑实现为接受 `&mut State` 的纯函数，便于无 Tauri 依赖地单测；
//! 命令封装层只做：lock Mutex → 调纯函数 → save 到 app_data_dir → 返回。

use crate::store::{Category, Settings, State, Todo};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

// ============================================================
// 纯函数（业务逻辑）
// ============================================================

pub mod ops {
    use super::*;

    /// 添加待办。id 由前端 crypto.randomUUID() 生成（全局约束），
    /// 因此命令签名比计划 §8 多一个 `id` 参数（计划微调，见 Task 4 汇报）。
    pub fn add_todo(
        state: &mut State,
        id: String,
        title: String,
        category_id: Option<String>,
        due_date: Option<String>,
        due_time: Option<String>,
    ) -> Todo {
        let todo = Todo {
            id,
            title,
            category_id,
            color: None,
            due_date,
            due_time,
            done: false,
            done_at: None,
            created_at: chrono::Utc::now().to_rfc3339(),
            order: state.todos.len() as i64,
        };
        state.todos.push(todo.clone());
        todo
    }

    /// 勾选/取消完成。done_at 记录完成时刻，取消时清空。
    pub fn toggle_todo(state: &mut State, id: &str) -> Result<Todo, String> {
        let todo = find_todo_mut(state, id)?;
        todo.done = !todo.done;
        todo.done_at = if todo.done {
            Some(chrono::Utc::now().to_rfc3339())
        } else {
            None
        };
        Ok(todo.clone())
    }

    /// 删除待办。
    pub fn delete_todo(state: &mut State, id: &str) -> Result<(), String> {
        let len_before = state.todos.len();
        state.todos.retain(|t| t.id != id);
        if state.todos.len() == len_before {
            return Err(format!("待办不存在: {id}"));
        }
        Ok(())
    }

    /// 按传入 id 顺序重排 order（0..n）。
    /// 未列出的待办（含已完成项）保持原相对顺序，排在列出项之后。
    pub fn reorder(state: &mut State, ids: &[String]) {
        let pos: HashMap<&str, i64> = ids
            .iter()
            .enumerate()
            .map(|(i, id)| (id.as_str(), i as i64))
            .collect();
        // 未列出项：按原 order 稳定排序后依次续排
        // （先收集为 owned 数据再可变遍历，避免同时不可变/可变借用）
        let mut rest: Vec<(String, i64)> = state
            .todos
            .iter()
            .filter(|t| !pos.contains_key(t.id.as_str()))
            .map(|t| (t.id.clone(), t.order))
            .collect();
        rest.sort_by_key(|(_, order)| *order);
        let tail_seq: HashMap<String, i64> = rest
            .into_iter()
            .enumerate()
            .map(|(i, (id, _))| (id, ids.len() as i64 + i as i64))
            .collect();
        for t in state.todos.iter_mut() {
            t.order = if let Some(i) = pos.get(t.id.as_str()) {
                *i
            } else if let Some(i) = tail_seq.get(&t.id) {
                *i
            } else {
                t.order
            };
        }
    }

    /// 添加分类。
    pub fn add_category(
        state: &mut State,
        id: String,
        name: String,
        color: String,
    ) -> Category {
        let cat = Category {
            id,
            name,
            color,
            order: state.categories.len() as i64,
        };
        state.categories.push(cat.clone());
        cat
    }

    /// 更新分类（重命名/换色；None = 不改）。
    pub fn update_category(
        state: &mut State,
        id: &str,
        name: Option<String>,
        color: Option<String>,
    ) -> Result<Category, String> {
        let cat = state
            .categories
            .iter_mut()
            .find(|c| c.id == id)
            .ok_or_else(|| format!("分类不存在: {id}"))?;
        if let Some(n) = name {
            cat.name = n;
        }
        if let Some(c) = color {
            cat.color = c;
        }
        Ok(cat.clone())
    }

    /// 删除分类，其下所有待办移入收件箱（category_id 置 None）。
    pub fn delete_category(state: &mut State, id: &str) -> Result<(), String> {
        let len_before = state.categories.len();
        state.categories.retain(|c| c.id != id);
        if state.categories.len() == len_before {
            return Err(format!("分类不存在: {id}"));
        }
        for t in state.todos.iter_mut() {
            if t.category_id.as_deref() == Some(id) {
                t.category_id = None;
            }
        }
        Ok(())
    }

    /// 托盘快速添加：title=text、无到期、无分类，等价 add_todo 便捷入口。
    /// id 同样由前端生成（托盘"快速添加"将唤起窗口走前端路径，保证 ID 语义统一）。
    pub fn quick_add(state: &mut State, id: String, text: String) -> Todo {
        add_todo(state, id, text, None, None, None)
    }

    fn find_todo_mut<'a>(state: &'a mut State, id: &'a str) -> Result<&'a mut Todo, String> {
        state
            .todos
            .iter_mut()
            .find(|t| t.id == id)
            .ok_or_else(|| format!("待办不存在: {id}"))
    }
}

// ============================================================
// patch 结构（三态字段：缺省 = 不改；显式 null = 清空）
// ============================================================

/// 待办字段补丁。`Option<Option<T>>` 三态语义：
/// - 字段缺省（None）→ 不修改
/// - `Some(None)`（前端传 null）→ 清空（如移入收件箱、恢复继承分类色、清除到期日）
/// - `Some(Some(v))` → 设置为 v
#[derive(Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct TodoPatch {
    pub title: Option<String>,
    pub category_id: Option<Option<String>>,
    pub color: Option<Option<String>>,
    pub due_date: Option<Option<String>>,
    pub due_time: Option<Option<String>>,
}

/// 设置补丁（字段缺省 = 不改）。
#[derive(Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct SettingsPatch {
    pub theme: Option<String>,
    pub width: Option<u32>,
    pub pos_x: Option<Option<f64>>,
    pub pos_y: Option<Option<f64>>,
    pub auto_start: Option<bool>,
    pub auto_collapse: Option<bool>,
    pub auto_collapse_minutes: Option<u32>,
    pub sort_mode: Option<String>,
    pub show_on_boot_only_today: Option<bool>,
}

pub mod patch_ops {
    use super::*;

    /// 应用待办补丁，返回更新后的条目。
    pub fn update_todo(
        state: &mut State,
        id: &str,
        patch: TodoPatch,
    ) -> Result<Todo, String> {
        let todo = state
            .todos
            .iter_mut()
            .find(|t| t.id == id)
            .ok_or_else(|| format!("待办不存在: {id}"))?;
        if let Some(title) = patch.title {
            todo.title = title;
        }
        if let Some(category_id) = patch.category_id {
            todo.category_id = category_id;
        }
        if let Some(color) = patch.color {
            todo.color = color;
        }
        if let Some(due_date) = patch.due_date {
            todo.due_date = due_date;
        }
        if let Some(due_time) = patch.due_time {
            todo.due_time = due_time;
        }
        Ok(todo.clone())
    }

    /// 应用设置补丁，返回完整 Settings。
    pub fn set_settings(state: &mut State, patch: SettingsPatch) -> Settings {
        let s = &mut state.settings;
        if let Some(v) = patch.theme {
            s.theme = v;
        }
        if let Some(v) = patch.width {
            s.width = v;
        }
        if let Some(v) = patch.pos_x {
            s.pos_x = v;
        }
        if let Some(v) = patch.pos_y {
            s.pos_y = v;
        }
        if let Some(v) = patch.auto_start {
            s.auto_start = v;
        }
        if let Some(v) = patch.auto_collapse {
            s.auto_collapse = v;
        }
        if let Some(v) = patch.auto_collapse_minutes {
            s.auto_collapse_minutes = v.clamp(1, 120);
        }
        if let Some(v) = patch.sort_mode {
            s.sort_mode = v;
        }
        if let Some(v) = patch.show_on_boot_only_today {
            s.show_on_boot_only_today = v;
        }
        s.clone()
    }
}

// ============================================================
// #[tauri::command] 薄封装
// ============================================================

fn lock_err<T>(_: T) -> String {
    "状态锁被占用（poisoned）".into()
}

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .map_err(|e| format!("无法定位数据目录: {e}"))
}

/// 持久化到 app_data_dir（同步写，失败返回错误并保留内存状态）。
fn persist(state: &Mutex<State>, app: &tauri::AppHandle) -> Result<(), String> {
    let dir = data_dir(app)?;
    state
        .lock()
        .map_err(lock_err)?
        .save(&dir)
        .map_err(|e| format!("写入数据失败: {e}"))
}

#[tauri::command]
pub fn get_state(state: tauri::State<'_, Mutex<State>>) -> Result<State, String> {
    Ok(state.lock().map_err(lock_err)?.clone())
}

#[tauri::command]
pub fn add_todo(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<State>>,
    id: String,
    title: String,
    category_id: Option<String>,
    due_date: Option<String>,
    due_time: Option<String>,
) -> Result<Todo, String> {
    let todo = {
        let mut st = state.lock().map_err(lock_err)?;
        ops::add_todo(&mut st, id, title, category_id, due_date, due_time)
    };
    persist(&state, &app)?;
    crate::window::refresh_badge(&app);
    Ok(todo)
}

#[tauri::command]
pub fn toggle_todo(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<State>>,
    id: String,
) -> Result<Todo, String> {
    let todo = {
        let mut st = state.lock().map_err(lock_err)?;
        ops::toggle_todo(&mut st, &id)?
    };
    persist(&state, &app)?;
    crate::window::refresh_badge(&app);
    Ok(todo)
}

#[tauri::command]
pub fn update_todo(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<State>>,
    id: String,
    patch: TodoPatch,
) -> Result<Todo, String> {
    let todo = {
        let mut st = state.lock().map_err(lock_err)?;
        patch_ops::update_todo(&mut st, &id, patch)?
    };
    persist(&state, &app)?;
    crate::window::refresh_badge(&app);
    Ok(todo)
}

#[tauri::command]
pub fn delete_todo(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<State>>,
    id: String,
) -> Result<(), String> {
    {
        let mut st = state.lock().map_err(lock_err)?;
        ops::delete_todo(&mut st, &id)?;
    }
    persist(&state, &app)?;
    crate::window::refresh_badge(&app);
    Ok(())
}

#[tauri::command]
pub fn reorder(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<State>>,
    ids: Vec<String>,
) -> Result<(), String> {
    {
        let mut st = state.lock().map_err(lock_err)?;
        ops::reorder(&mut st, &ids);
    }
    persist(&state, &app)?;
    crate::window::refresh_badge(&app);
    Ok(())
}

#[tauri::command]
pub fn add_category(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<State>>,
    id: String,
    name: String,
    color: String,
) -> Result<Category, String> {
    let cat = {
        let mut st = state.lock().map_err(lock_err)?;
        ops::add_category(&mut st, id, name, color)
    };
    persist(&state, &app)?;
    Ok(cat)
}

#[tauri::command]
pub fn update_category(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<State>>,
    id: String,
    name: Option<String>,
    color: Option<String>,
) -> Result<Category, String> {
    let cat = {
        let mut st = state.lock().map_err(lock_err)?;
        ops::update_category(&mut st, &id, name, color)?
    };
    persist(&state, &app)?;
    Ok(cat)
}

#[tauri::command]
pub fn delete_category(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<State>>,
    id: String,
) -> Result<(), String> {
    {
        let mut st = state.lock().map_err(lock_err)?;
        ops::delete_category(&mut st, &id)?;
    }
    persist(&state, &app)
}

#[tauri::command]
pub fn set_settings(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<State>>,
    patch: SettingsPatch,
) -> Result<Settings, String> {
    let sync_autostart = patch.auto_start;
    let settings = {
        let mut st = state.lock().map_err(lock_err)?;
        patch_ops::set_settings(&mut st, patch)
    };
    persist(&state, &app)?;
    if let Some(on) = sync_autostart {
        crate::window::sync_autostart(&app, on)?;
    }
    Ok(settings)
}

/// 收起 = 销毁窗口（Task 9 设计修订：无 hide 态，展示/隐藏即重建/销毁）。
#[tauri::command]
pub fn collapse(window: tauri::WebviewWindow) -> Result<(), String> {
    window
        .destroy()
        .map_err(|e| format!("收起窗口失败: {e}"))
}

#[tauri::command]
pub fn quick_add(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<State>>,
    id: String,
    text: String,
) -> Result<Todo, String> {
    let todo = {
        let mut st = state.lock().map_err(lock_err)?;
        ops::quick_add(&mut st, id, text)
    };
    persist(&state, &app)?;
    crate::window::refresh_badge(&app);
    Ok(todo)
}

// ============================================================
// 单测（纯函数层，无 Tauri 依赖）
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn t(id: &str, order: i64) -> Todo {
        Todo {
            id: id.into(),
            title: format!("待办{id}"),
            category_id: None,
            color: None,
            due_date: None,
            due_time: None,
            done: false,
            done_at: None,
            created_at: String::new(),
            order,
        }
    }

    #[test]
    fn add_todo_appends_with_increasing_order() {
        let mut s = State::default();
        let a = ops::add_todo(&mut s, "t1".into(), "一".into(), None, None, None);
        let b = ops::add_todo(&mut s, "t2".into(), "二".into(), None, None, None);
        assert_eq!(a.order, 0);
        assert_eq!(b.order, 1);
        assert_eq!(s.todos.len(), 2);
        assert!(!a.done && a.done_at.is_none());
    }

    #[test]
    fn toggle_roundtrip_sets_and_clears_done_at() {
        let mut s = State::default();
        ops::add_todo(&mut s, "t1".into(), "一".into(), None, None, None);
        let done = ops::toggle_todo(&mut s, "t1").unwrap();
        assert!(done.done && done.done_at.is_some());
        let undone = ops::toggle_todo(&mut s, "t1").unwrap();
        assert!(!undone.done && undone.done_at.is_none());
        assert!(ops::toggle_todo(&mut s, "不存在").is_err());
    }

    #[test]
    fn delete_todo_removes_only_target() {
        let mut s = State::default();
        ops::add_todo(&mut s, "t1".into(), "一".into(), None, None, None);
        ops::add_todo(&mut s, "t2".into(), "二".into(), None, None, None);
        ops::delete_todo(&mut s, "t1").unwrap();
        assert_eq!(s.todos.len(), 1);
        assert_eq!(s.todos[0].id, "t2");
        assert!(ops::delete_todo(&mut s, "t1").is_err());
    }

    #[test]
    fn update_todo_patch_only_touches_provided_fields() {
        let mut s = State::default();
        s.categories.push(Category {
            id: "c1".into(),
            name: "工作".into(),
            color: "#3b82f6".into(),
            order: 0,
        });
        let t = ops::add_todo(&mut s, "t1".into(), "一".into(), Some("c1".into()), None, None);
        let original = t.clone();

        // 只改 title
        let updated = patch_ops::update_todo(
            &mut s,
            "t1",
            TodoPatch { title: Some("新标题".into()), ..Default::default() },
        )
        .unwrap();
        assert_eq!(updated.title, "新标题");
        assert_eq!(updated.category_id, original.category_id);
        assert_eq!(updated.due_date, None);

        // 显式 null：移入收件箱
        let updated = patch_ops::update_todo(
            &mut s,
            "t1",
            TodoPatch {
                category_id: Some(None),
                due_date: Some(Some("2026-09-20".into())),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(updated.category_id, None);
        assert_eq!(updated.due_date.as_deref(), Some("2026-09-20"));

        assert!(patch_ops::update_todo(&mut s, "不存在", TodoPatch::default()).is_err());
    }

    #[test]
    fn delete_category_moves_todos_to_inbox() {
        let mut s = State::default();
        ops::add_category(&mut s, "c1".into(), "工作".into(), "#3b82f6".into());
        ops::add_todo(&mut s, "t1".into(), "一".into(), Some("c1".into()), None, None);
        ops::add_todo(&mut s, "t2".into(), "二".into(), None, None, None);
        ops::delete_category(&mut s, "c1").unwrap();
        assert!(s.categories.is_empty());
        assert_eq!(s.todos[0].category_id, None);
        assert_eq!(s.todos[1].category_id, None);
        assert!(ops::delete_category(&mut s, "c1").is_err());
    }

    #[test]
    fn reorder_respects_ids_and_appends_unlisted() {
        let mut s = State::default();
        for (i, id) in ["a", "b", "c", "d"].iter().enumerate() {
            let mut todo = t(id, 99);
            todo.order = i as i64;
            s.todos.push(todo);
        }
        // d 提到最前，b 未列出 → b,c 保持原相对顺序排在 a,d 之后
        ops::reorder(&mut s, &["d".into(), "a".into()]);
        let mut orders: Vec<(&str, i64)> =
            s.todos.iter().map(|t| (t.id.as_str(), t.order)).collect();
        orders.sort_by_key(|(_, o)| *o);
        assert_eq!(
            orders,
            vec![("d", 0), ("a", 1), ("b", 2), ("c", 3)]
        );
    }

    #[test]
    fn quick_add_equivalent_to_plain_add_todo() {
        let mut s1 = State::default();
        let mut s2 = State::default();
        let q = ops::quick_add(&mut s1, "t1".into(), "快速事项".into());
        let a = ops::add_todo(&mut s2, "t1".into(), "快速事项".into(), None, None, None);
        assert_eq!(q.title, "快速事项");
        assert_eq!(q.category_id, None);
        assert_eq!(q.due_date, None);
        assert_eq!(q.due_time, None);
        assert_eq!(q.order, a.order);
    }

    #[test]
    fn set_settings_patches_and_returns_full() {
        let mut s = State::default();
        let settings = patch_ops::set_settings(
            &mut s,
            SettingsPatch {
                theme: Some("dark".into()),
                width: Some(380),
                ..Default::default()
            },
        );
        assert_eq!(settings.theme, "dark");
        assert_eq!(settings.width, 380);
        assert_eq!(settings.sort_mode, "manual"); // 未触及字段保持默认
        assert!(settings.auto_start);
    }
}
