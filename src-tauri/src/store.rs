use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::Path;

/// 待办条目（字段与 Spec §3 store.json 结构逐一对齐，serde 序列化为 camelCase）
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    pub id: String,
    pub title: String,
    /// null = 收件箱
    pub category_id: Option<String>,
    /// null = 继承分类色；覆盖则存 "#hex"
    pub color: Option<String>,
    /// null = 无到期，格式 "YYYY-MM-DD"
    pub due_date: Option<String>,
    /// null = 全天，格式 "HH:MM"
    pub due_time: Option<String>,
    pub done: bool,
    pub done_at: Option<String>,
    pub created_at: String,
    /// 手动排序键；Rust 侧不生成 id，由前端 crypto.randomUUID() 提供
    pub order: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub id: String,
    pub name: String,
    pub color: String,
    pub order: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// glass | paper | dark | system
    pub theme: String,
    /// 300 | 340 | 380
    pub width: u32,
    /// null = 默认右上角 16px
    pub pos_x: Option<f64>,
    pub pos_y: Option<f64>,
    pub auto_start: bool,
    /// 失焦自动收起（Task 9 仅 UI + 持久化，监听接线在 Task 10）
    #[serde(default)]
    pub auto_collapse: bool,
    /// manual | due | category | created
    pub sort_mode: String,
    pub show_on_boot_only_today: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: "glass".into(),
            width: 340,
            pos_x: None,
            pos_y: None,
            auto_start: true,
            auto_collapse: false,
            sort_mode: "manual".into(),
            show_on_boot_only_today: true,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct State {
    pub version: i32,
    pub categories: Vec<Category>,
    pub todos: Vec<Todo>,
    pub settings: Settings,
}

impl Default for State {
    /// 计划要求：default() 即 version 1 的空状态（与 new() 一致，避免 version=0 的脏默认）
    fn default() -> Self {
        State::new()
    }
}

impl State {
    /// 空状态：version 1 + 默认设置
    pub fn new() -> Self {
        State {
            version: 1,
            categories: Vec::new(),
            todos: Vec::new(),
            settings: Settings::default(),
        }
    }

    const FILE: &'static str = "store.json";
    const BACKUP_COUNT: u32 = 5;

    /// 原子写 + 滚动备份：每次保存前将 store.json → .1 → .2 … → .5（保留最近 BACKUP_COUNT 份）
    pub fn save(&self, dir: &Path) -> io::Result<()> {
        let main = dir.join(Self::FILE);
        if main.exists() {
            for i in (1..Self::BACKUP_COUNT).rev() {
                let from = dir.join(format!("{}.{}", Self::FILE, i));
                if from.exists() {
                    fs::rename(&from, dir.join(format!("{}.{}", Self::FILE, i + 1)))?;
                }
            }
            fs::rename(&main, dir.join(format!("{}.1", Self::FILE)))?;
        }
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        let tmp = dir.join(format!("{}.tmp", Self::FILE));
        fs::write(&tmp, json)?;
        // Windows 上 rename 覆盖已存在目标（MoveFileEx REPLACE_EXISTING）
        fs::rename(&tmp, &main)?;
        Ok(())
    }

    /// 依次尝试主文件与 .1~.5 备份：
    /// - 主文件可用 → (state, None)
    /// - 某备份可用 → 回写主文件，(state, Some("数据已从备份恢复"))
    /// - 全部损坏 → (默认空状态, Some("数据文件损坏，已重置为空"))
    pub fn load(dir: &Path) -> io::Result<(State, Option<String>)> {
        let main = dir.join(Self::FILE);
        let candidates = std::iter::once(main.clone())
            .chain((1..=Self::BACKUP_COUNT).map(|i| dir.join(format!("{}.{}", Self::FILE, i))));
        for path in candidates {
            if let Ok(text) = fs::read_to_string(&path) {
                match serde_json::from_str::<State>(&text) {
                    Ok(state) => {
                        if path != main {
                            // 用良好副本回写主文件（不触发滚动，保留现有备份链）
                            let tmp = dir.join(format!("{}.tmp", Self::FILE));
                            fs::write(&tmp, &text)?;
                            fs::rename(&tmp, &main)?;
                            return Ok((state, Some("数据已从备份恢复".into())));
                        }
                        return Ok((state, None));
                    }
                    Err(_) => continue,
                }
            }
        }
        // 全部候选都不可读：
        // - 主文件不存在 → 全新安装，静默返回空状态
        // - 主文件存在但损坏 → 告警（数据可能丢失，已重置为空）
        if main.exists() {
            Ok((State::new(), Some("数据文件损坏，已重置为空".into())))
        } else {
            Ok((State::new(), None))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmpdir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir()
            .join(format!("todo-test-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn save_then_load_roundtrip() {
        let dir = tmpdir("roundtrip");
        let mut s = State::default();
        s.todos.push(Todo {
            id: "t1".into(),
            title: "测试".into(),
            category_id: None,
            color: None,
            due_date: Some("2026-09-17".into()),
            due_time: None,
            done: false,
            done_at: None,
            created_at: "2026-09-17T00:00:00Z".into(),
            order: 0,
        });
        s.save(&dir).unwrap();
        // 前端契约：键名必须是 camelCase（与 pretty 排版无关）
        let raw = fs::read_to_string(dir.join("store.json")).unwrap();
        assert!(raw.contains("\"dueDate\""), "dueDate 键应为 camelCase");
        assert!(raw.contains("\"categoryId\""), "categoryId 键应为 camelCase");
        assert!(!raw.contains("due_date"), "不应出现 snake_case 键");
        assert!(!raw.contains("category_id"), "不应出现 snake_case 键");
        let (loaded, warn) = State::load(&dir).unwrap();
        assert!(warn.is_none());
        assert_eq!(loaded.todos[0].title, "测试");
        assert_eq!(loaded.todos[0].due_date.as_deref(), Some("2026-09-17"));
    }

    #[test]
    fn corrupt_json_recovers_from_backup() {
        let dir = tmpdir("corrupt");
        let s = State::default();
        s.save(&dir).unwrap();
        // 备份链滚动后 store.json 为损坏内容，.1 为良好副本
        let good = fs::read(dir.join("store.json")).unwrap();
        fs::write(dir.join("store.json.1"), &good).unwrap();
        fs::write(dir.join("store.json"), b"{broken").unwrap();
        let (loaded, warn) = State::load(&dir).unwrap();
        assert!(warn.is_some(), "应返回恢复提示");
        assert_eq!(loaded, s);
    }

    #[test]
    fn rolling_backup_keeps_five() {
        let dir = tmpdir("rolling");
        for i in 0..9 {
            let s = State {
                version: i, // 内容变化触发新备份
                ..State::default()
            };
            s.save(&dir).unwrap();
        }
        let mut n = 0;
        for i in 1..=6 {
            if dir.join(format!("store.json.{i}")).exists() {
                n += 1;
            }
        }
        assert_eq!(n, 5, "只保留 5 份滚动备份");
    }
}
