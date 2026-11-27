//! The blocking lists the browser extensions follow (Phase 12, in the app). The app keeps them
//! as settings; the extensions receive them over the browser link and check them in the browser.
//! The lists are only shape-checked here: the shared rules code in packages/core cleans every
//! entry on both sides (the app's Blocking page and the extension).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::Store;
use crate::error::{Result, StoreError};
use crate::settings;

/// Biggest lists accepted, as JSON. Thousands of sites fit; anything larger is a mistake.
pub const MAX_BYTES: usize = 256 * 1024;

/// Mirrors `BlockingLists` in apps/desktop/src/ipc/blocking.ts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BlockingLists {
    /// `BlockRule[]`: { domain, mode, waitSeconds }.
    pub rules: Value,
    /// `YoutubeRules`, or null for the defaults.
    pub youtube: Value,
    /// Countdown for newly added "wait" sites, in seconds.
    pub default_wait: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Blocking {
    /// False until the lists are first saved in the app or handed over by a browser.
    pub configured: bool,
    #[serde(flatten)]
    pub lists: BlockingLists,
}

pub fn get(store: &Store) -> Result<Blocking> {
    Ok(Blocking {
        configured: settings::get(store, "blocking.configured")?,
        lists: BlockingLists {
            rules: settings::get(store, "blocking.rules")?,
            youtube: settings::get(store, "blocking.youtube")?,
            default_wait: settings::get(store, "blocking.defaultWait")?,
        },
    })
}

/// Checks the shape: an array of objects, an object (or null), a sensible countdown, not huge.
pub fn check(lists: &BlockingLists) -> Result<()> {
    let bad = |m: &str| Err(StoreError::Invalid(m.into()));
    let Some(rules) = lists.rules.as_array() else { return bad("the site list must be a list") };
    if !rules.iter().all(Value::is_object) {
        return bad("each site must be an object");
    }
    if !(lists.youtube.is_object() || lists.youtube.is_null()) {
        return bad("the YouTube choices must be an object");
    }
    if !(1..=86_400).contains(&lists.default_wait) {
        return bad("the countdown must be 1 second to 24 hours");
    }
    if serde_json::to_string(lists).map(|s| s.len()).unwrap_or(usize::MAX) > MAX_BYTES {
        return bad("the lists are too big");
    }
    Ok(())
}

/// Saves the lists from the Blocking page.
pub fn save(store: &mut Store, lists: &BlockingLists) -> Result<()> {
    check(lists)?;
    settings::set(store, "blocking.rules", &lists.rules)?;
    settings::set(store, "blocking.youtube", &lists.youtube)?;
    settings::set(store, "blocking.defaultWait", &lists.default_wait)?;
    settings::set(store, "blocking.configured", &true)
}

/// A browser hands over the lists it had before the app managed them. Only taken while the app
/// has none of its own; returns whether they were taken.
pub fn import(store: &mut Store, lists: &BlockingLists) -> Result<bool> {
    if get(store)?.configured {
        return Ok(false);
    }
    save(store, lists)?;
    Ok(true)
}

/// A browser regrouped the YouTube tags (extension 0.13.1+). Only the groups change: they just
/// tidy the tag list, so the browser may change them while the app manages everything else.
/// Returns false while the app has no lists yet (the browser then keeps its own).
pub fn set_tag_groups(store: &mut Store, groups: &Value) -> Result<bool> {
    let Some(list) = groups.as_array() else { return Err(StoreError::Invalid("the groups must be a list".into())) };
    if !list.iter().all(Value::is_object) {
        return Err(StoreError::Invalid("each group must be an object".into()));
    }
    let mut b = get(store)?;
    if !b.configured {
        return Ok(false);
    }
    if !b.lists.youtube.is_object() {
        b.lists.youtube = Value::Object(Default::default());
    }
    b.lists.youtube["groups"] = groups.clone();
    save(store, &b.lists)?;
    Ok(true)
}

/// Programs that can never be blocked, so blocking can't lock you out of your own PC: Windows
/// itself, File Explorer, Task Manager, settings and sign-in screens, and Focus.
pub const PROTECTED_APPS: &[&str] = &[
    "explorer.exe",
    "taskmgr.exe",
    "focus.exe",
    "applicationframehost.exe",
    "consent.exe",
    "credentialuibroker.exe",
    "csrss.exe",
    "ctfmon.exe",
    "dwm.exe",
    "lockapp.exe",
    "logonui.exe",
    "mmc.exe",
    "msiexec.exe",
    "openwith.exe",
    "pickerhost.exe",
    "rundll32.exe",
    "searchapp.exe",
    "searchhost.exe",
    "searchui.exe",
    "securityhealthsystray.exe",
    "sechealthui.exe",
    "shellexperiencehost.exe",
    "shellhost.exe",
    "sihost.exe",
    "smartscreen.exe",
    "startmenuexperiencehost.exe",
    "systemsettings.exe",
    "systemsettingsadminflows.exe",
    "textinputhost.exe",
    "useroobebroker.exe",
    "werfault.exe",
    "winlogon.exe",
    "kairos.exe",
    "control.exe",
];

/// The longest program name kept (Windows file names stop at 255).
const MAX_EXE: usize = 255;
/// More programs than anyone needs; keeps the list small.
pub const MAX_APPS: usize = 300;

/// Whether `exe` (a file name, any case) can never be blocked. Focus's own installer counts too.
pub fn is_protected(exe: &str) -> bool {
    let e = exe.to_ascii_lowercase();
    PROTECTED_APPS.contains(&e.as_str()) || ((e.starts_with("focus") || e.starts_with("kairos")) && e.contains("setup"))
}

/// A program's file name from a full path or a typed name: "C:\\Games\\Steam.exe" -> "steam.exe",
/// "discord" -> "discord.exe". Lowercase, since Windows file names ignore case.
pub fn normalize_exe(input: &str) -> Option<String> {
    let name = input.trim().trim_matches('"').rsplit(['\\', '/']).next()?.trim().to_ascii_lowercase();
    if name.is_empty() || name.len() > MAX_EXE || name.chars().any(|c| c.is_control() || "<>:\"|?*".contains(c)) {
        return None;
    }
    Some(if name.ends_with(".exe") { name } else { format!("{name}.exe") })
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AppMode {
    /// A countdown, then the program may be used until the focus phase ends.
    Wait,
    /// No way through until the break.
    Block,
}

/// One blocked program. Mirrors `AppRule` in apps/desktop/src/ipc/blocking.ts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppRule {
    /// File name, lowercase, e.g. "discord.exe".
    pub exe: String,
    /// What the Blocking page and the blocked screen call it, e.g. "Discord".
    pub name: String,
    pub mode: AppMode,
    pub wait_seconds: u32,
}

/// Keeps the usable rules: real program names, no protected ones, no repeats, sane countdowns.
pub fn clean_apps(rules: Vec<AppRule>) -> Vec<AppRule> {
    let mut out: Vec<AppRule> = Vec::new();
    for r in rules {
        let Some(exe) = normalize_exe(&r.exe) else { continue };
        if is_protected(&exe) || out.iter().any(|o| o.exe == exe) {
            continue;
        }
        let name: String = r.name.trim().chars().take(80).collect();
        let name = if name.is_empty() { exe.trim_end_matches(".exe").to_string() } else { name };
        out.push(AppRule { exe, name, mode: r.mode, wait_seconds: r.wait_seconds.clamp(1, 86_400) });
        if out.len() == MAX_APPS {
            break;
        }
    }
    out
}

/// The blocked programs. Anything unreadable is dropped rather than failing the page.
pub fn get_apps(store: &Store) -> Result<Vec<AppRule>> {
    let raw: Value = settings::get(store, "blocking.apps")?;
    let rules = raw
        .as_array()
        .map(|a| a.iter().filter_map(|v| serde_json::from_value::<AppRule>(v.clone()).ok()).collect())
        .unwrap_or_default();
    Ok(clean_apps(rules))
}

/// Saves the blocked programs and returns them as kept.
pub fn save_apps(store: &mut Store, rules: Vec<AppRule>) -> Result<Vec<AppRule>> {
    let rules = clean_apps(rules);
    settings::set(store, "blocking.apps", &rules)?;
    Ok(rules)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn lists(domain: &str) -> BlockingLists {
        BlockingLists {
            rules: json!([{ "domain": domain, "mode": "wait", "waitSeconds": 20 }]),
            youtube: json!({ "blockShorts": true, "channels": ["@x"] }),
            default_wait: 20,
        }
    }

    #[test]
    fn starts_empty_then_saves() {
        let mut store = Store::open_in_memory().unwrap();
        let b = get(&store).unwrap();
        assert!(!b.configured);
        assert_eq!(b.lists.rules, json!([]));
        assert!(b.lists.youtube.is_null());
        save(&mut store, &lists("reddit.com")).unwrap();
        let b = get(&store).unwrap();
        assert!(b.configured);
        assert_eq!(b.lists, lists("reddit.com"));
    }

    #[test]
    fn a_browser_hands_over_its_lists_only_once() {
        let mut store = Store::open_in_memory().unwrap();
        assert!(import(&mut store, &lists("youtube.com")).unwrap());
        assert!(!import(&mut store, &lists("x.com")).unwrap(), "the app's lists win from now on");
        assert_eq!(get(&store).unwrap().lists.rules[0]["domain"], "youtube.com");
    }

    #[test]
    fn bad_shapes_are_refused() {
        let mut store = Store::open_in_memory().unwrap();
        let mut l = lists("a.com");
        l.rules = json!({ "domain": "a.com" });
        assert!(save(&mut store, &l).is_err());
        let mut l = lists("a.com");
        l.default_wait = 0;
        assert!(save(&mut store, &l).is_err());
        let mut l = lists("a.com");
        l.rules = json!([{ "domain": "x".repeat(MAX_BYTES) }]);
        assert!(save(&mut store, &l).is_err());
    }

    #[test]
    fn a_browser_changes_only_the_tag_groups() {
        let mut store = Store::open_in_memory().unwrap();
        let groups = json!([{ "name": "Gaming", "tags": ["gaming", "sologaming"] }]);
        assert!(!set_tag_groups(&mut store, &groups).unwrap(), "nothing to group before the app has lists");
        save(&mut store, &lists("reddit.com")).unwrap();
        assert!(set_tag_groups(&mut store, &groups).unwrap());
        let b = get(&store).unwrap();
        assert_eq!(b.lists.youtube["groups"], groups);
        assert_eq!(b.lists.youtube["channels"], json!(["@x"]), "the rest of the YouTube choices stay");
        assert_eq!(b.lists.rules[0]["domain"], "reddit.com");
        assert!(set_tag_groups(&mut store, &json!({ "name": "x" })).is_err());
        assert!(set_tag_groups(&mut store, &json!([1])).is_err());
    }

    fn app(exe: &str, mode: AppMode) -> AppRule {
        AppRule { exe: exe.into(), name: String::new(), mode, wait_seconds: 20 }
    }

    #[test]
    fn program_names_are_tidied() {
        assert_eq!(normalize_exe(r"C:\Program Files\Steam\Steam.exe").as_deref(), Some("steam.exe"));
        assert_eq!(normalize_exe("  Discord ").as_deref(), Some("discord.exe"));
        assert_eq!(normalize_exe("\"D:/Games/x.EXE\"").as_deref(), Some("x.exe"));
        assert_eq!(normalize_exe(""), None);
        assert_eq!(normalize_exe("a|b"), None);
    }

    #[test]
    fn windows_essentials_and_focus_can_never_be_blocked() {
        for exe in ["explorer.exe", "Taskmgr.exe", "Focus.exe", "SystemSettings.exe", "Focus_0.21.15_x64-setup.exe"] {
            assert!(is_protected(exe), "{exe}");
        }
        assert!(!is_protected("discord.exe"));
        let mut store = Store::open_in_memory().unwrap();
        let kept = save_apps(
            &mut store,
            vec![app("Discord.exe", AppMode::Wait), app("explorer.exe", AppMode::Block), app("taskmgr", AppMode::Block), app("discord", AppMode::Block)],
        )
        .unwrap();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].exe, "discord.exe");
        assert_eq!(kept[0].name, "discord");
        assert_eq!(get_apps(&store).unwrap(), kept);
    }
}
