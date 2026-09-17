//! 今日/过期分组判定（纯函数，规则见 Spec §4）
//!
//! `bucket(todo, today)`:
//! - 已完成 → Done（无论到期日）
//! - dueDate == today → Today
//! - dueDate > today → Later
//! - dueDate < today 且未完成 → Overdue
//! - dueDate == null 且未完成 → Today（无到期未完成视为"今日待清理"）
//! - dueDate == null 且已完成 → Done

use crate::store::{State, Todo};
use chrono::NaiveDate;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bucket {
    Overdue,
    Today,
    Later,
    Done,
}

pub fn bucket(todo: &Todo, today: NaiveDate) -> Bucket {
    if todo.done {
        return Bucket::Done;
    }
    match todo
        .due_date
        .as_deref()
        .and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
    {
        Some(due) if due < today => Bucket::Overdue,
        Some(due) if due > today => Bucket::Later,
        Some(_) => Bucket::Today,
        // 无到期未完成 → 今日待清理
        None => Bucket::Today,
    }
}

pub fn has_today(state: &State, today: NaiveDate) -> bool {
    state
        .todos
        .iter()
        .any(|todo| matches!(bucket(todo, today), Bucket::Today | Bucket::Overdue))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Todo;

    fn t(due: Option<&str>, done: bool) -> Todo {
        Todo {
            id: "x".into(),
            title: "x".into(),
            category_id: None,
            color: None,
            due_date: due.map(String::from),
            due_time: None,
            done,
            done_at: None,
            created_at: String::new(),
            order: 0,
        }
    }

    #[test]
    fn due_today_is_today() {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 9, 17).unwrap();
        assert!(matches!(bucket(&t(Some("2026-09-17"), false), today), Bucket::Today));
    }

    #[test]
    fn due_future_is_later() {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 9, 17).unwrap();
        assert!(matches!(bucket(&t(Some("2026-09-18"), false), today), Bucket::Later));
    }

    #[test]
    fn due_past_is_overdue() {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 9, 17).unwrap();
        assert!(matches!(bucket(&t(Some("2026-09-16"), false), today), Bucket::Overdue));
    }

    #[test]
    fn no_due_undone_is_today() {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 9, 17).unwrap();
        assert!(matches!(bucket(&t(None, false), today), Bucket::Today));
    }

    #[test]
    fn done_is_done() {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 9, 17).unwrap();
        assert!(matches!(bucket(&t(Some("2026-09-17"), true), today), Bucket::Done));
    }

    #[test]
    fn has_today_detects() {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 9, 17).unwrap();
        let mut s = crate::store::State::default();
        s.todos.push(t(Some("2026-09-17"), false));
        assert!(has_today(&s, today));
        s.todos[0].due_date = Some("2026-09-18".into());
        assert!(!has_today(&s, today));
    }
}
