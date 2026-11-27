//! "Why are you here?": before letting you through a block screen during focus (a site, a
//! YouTube video, a Windows program or a phone app), Focus asks for a reason. The answers are
//! kept so Statistics can show what pulls you away most. Kept in the synced setting
//! `distraction.reasons` (newest last, the last `KEPT` only), so every device adds to one list.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::Store;
use crate::error::{Result, StoreError};
use crate::settings;

const KEPT: usize = 400;
pub const MAX_LEN: usize = 120;

/// Mirrored by `Reason` in apps/desktop/src/ipc/reasons.ts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Reason {
    pub at: i64,
    /// What you typed or picked, e.g. "Need it for work".
    pub text: String,
    /// What was blocked: a site ("youtube.com"), a program ("Discord") or a phone app.
    pub what: String,
}

/// One reason and how often it was given in a period.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReasonCount {
    pub text: String,
    pub count: u32,
    /// The things it was given for, most often first (up to three).
    pub what: Vec<String>,
}

pub fn all(store: &Store) -> Result<Vec<Reason>> {
    let raw: serde_json::Value = settings::get(store, "distraction.reasons")?;
    Ok(serde_json::from_value(raw).unwrap_or_default())
}

pub fn add(store: &mut Store, text: &str, what: &str, at: i64) -> Result<()> {
    let text: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return Err(StoreError::Invalid("say why you're opening it".into()));
    }
    let clip = |s: &str| s.chars().take(MAX_LEN).collect::<String>();
    let mut list = all(store)?;
    list.push(Reason { at, text: clip(&text), what: clip(what.trim()) });
    list.sort_by_key(|r| r.at);
    let from = list.len().saturating_sub(KEPT);
    settings::set(store, "distraction.reasons", &list[from..].to_vec())
}

/// The reasons given in `from..to`, most frequent first. Same text in any letter case counts as one.
pub fn top(store: &Store, from: i64, to: i64, limit: usize) -> Result<Vec<ReasonCount>> {
    let mut groups: HashMap<String, (String, u32, HashMap<String, u32>)> = HashMap::new();
    for r in all(store)?.into_iter().filter(|r| r.at >= from && r.at < to) {
        let e = groups.entry(r.text.to_lowercase()).or_insert_with(|| (r.text.clone(), 0, HashMap::new()));
        e.1 += 1;
        if !r.what.is_empty() {
            *e.2.entry(r.what).or_default() += 1;
        }
    }
    let mut out: Vec<ReasonCount> = groups
        .into_values()
        .map(|(text, count, what)| {
            let mut w: Vec<(String, u32)> = what.into_iter().collect();
            w.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
            ReasonCount { text, count, what: w.into_iter().take(3).map(|x| x.0).collect() }
        })
        .collect();
    out.sort_by(|a, b| b.count.cmp(&a.count).then(a.text.cmp(&b.text)));
    out.truncate(limit);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reasons_are_counted_together() {
        let mut store = Store::open_in_memory().unwrap();
        add(&mut store, "Bored", "youtube.com", 10).unwrap();
        add(&mut store, " bored ", "reddit.com", 20).unwrap();
        add(&mut store, "Need it for work", "Discord", 30).unwrap();
        add(&mut store, "Bored", "youtube.com", 40).unwrap();
        assert!(add(&mut store, "   ", "x", 50).is_err());
        let t = top(&store, 0, 100, 5).unwrap();
        assert_eq!(t[0].count, 3);
        assert_eq!(t[0].what, vec!["youtube.com", "reddit.com"]);
        assert_eq!(t[1].text, "Need it for work");
        assert_eq!(top(&store, 25, 100, 5).unwrap().len(), 2);
    }
}
