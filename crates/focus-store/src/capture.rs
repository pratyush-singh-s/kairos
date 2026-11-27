//! Quick capture: one line typed into the laptop's hotkey box or the launcher's "+" becomes a
//! to-do for today, or a note when it starts with "n " (or "note:"). Same rules everywhere.

use serde::Serialize;

use crate::Store;
use crate::error::{Result, StoreError};
use crate::{notes, tasks};

/// What a captured line became.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Captured {
    /// "task" or "note".
    pub kind: String,
    pub id: String,
    pub title: String,
}

/// The text of a note line ("n buy milk" → "buy milk"), or None for a to-do.
fn note_text(line: &str) -> Option<&str> {
    let t = line.trim_start();
    let lower = t.get(..5).map(str::to_ascii_lowercase).unwrap_or_default();
    if lower == "note:" {
        return Some(t[5..].trim());
    }
    let mut chars = t.chars();
    match (chars.next(), chars.next()) {
        (Some('n' | 'N'), Some(' ')) => Some(t[2..].trim()),
        _ => None,
    }
}

/// Saves `line` as a to-do due `today` (local "YYYY-MM-DD") or as a note.
pub fn capture(store: &mut Store, line: &str, today: &str) -> Result<Captured> {
    if let Some(text) = note_text(line) {
        if text.is_empty() {
            return Err(StoreError::Invalid("type the note after \"n \"".into()));
        }
        let title: String = text.lines().next().unwrap_or("").chars().take(200).collect();
        let body = serde_json::json!({
            "type": "doc",
            "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": text }] }],
        });
        let note = notes::create(store)?;
        let note = notes::save(store, &note.id, &title, &body.to_string(), text)?;
        return Ok(Captured { kind: "note".into(), id: note.id, title: note.title });
    }
    let line = line.trim();
    if line.is_empty() {
        return Err(StoreError::Invalid("type something to add".into()));
    }
    let input = tasks::TaskInput {
        title: line.chars().take(200).collect(),
        due_date: Some(today.to_string()),
        priority: "normal".into(),
        repeat_days: 0,
        color: None,
        deadline_id: None,
        start_time: None,
        end_time: None,
        duration_min: None,
        category: None,
        description: String::new(),
        space_id: None,
        plan_day: None,
    };
    let task = tasks::create(store, input, today)?;
    Ok(Captured { kind: "task".into(), id: task.id, title: task.title })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_becomes_a_task_for_today() {
        let mut store = Store::open_in_memory().unwrap();
        let c = capture(&mut store, "  Call the bank ", "2026-10-27").unwrap();
        assert_eq!((c.kind.as_str(), c.title.as_str()), ("task", "Call the bank"));
        let t = tasks::get(store.conn(), &c.id, "2026-10-27").unwrap().unwrap();
        assert_eq!(t.due_date.as_deref(), Some("2026-10-27"));
    }

    #[test]
    fn n_space_or_note_colon_makes_a_note() {
        let mut store = Store::open_in_memory().unwrap();
        let c = capture(&mut store, "n idea for the essay", "2026-10-27").unwrap();
        assert_eq!((c.kind.as_str(), c.title.as_str()), ("note", "idea for the essay"));
        assert!(notes::get(store.conn(), &c.id).unwrap().unwrap().body.contains("\"doc\""));
        assert_eq!(capture(&mut store, "Note: x", "2026-10-27").unwrap().kind, "note");
        assert_eq!(capture(&mut store, "nap", "2026-10-27").unwrap().kind, "task");
        assert!(capture(&mut store, "n ", "2026-10-27").is_err());
        assert!(capture(&mut store, "   ", "2026-10-27").is_err());
    }
}
