//! Blocking on the phone. The laptop shares whether a focus phase is on (`focus.live`, synced);
//! the phone keeps its own list of blocked phone apps and follows the laptop's site list. The
//! phone's blocking service (BlockService.kt) asks for everything at once with `block_state`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::Store;
use crate::blocking::{self, AppMode};
use crate::error::Result;
use crate::settings;

/// A paused focus phase blocks at most this long after the laptop last said so, in case the
/// laptop was switched off while paused and never says "stopped".
pub const PAUSED_FOR_MS: u64 = 3 * 60 * 60 * 1000;

/// The laptop's focus state, as the browser link shares it (`bridge::FocusState`), plus when
/// it was written. Mirrored by `FocusLive` in apps/mobile/src/ipc/phoneBlocking.ts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FocusLive {
    /// A focus phase is running or paused. Breaks and an idle timer don't block.
    pub active: bool,
    pub paused: bool,
    /// When the running focus phase ends (ms since epoch); None while paused.
    pub ends_at_ms: Option<u64>,
    pub preset_name: Option<String>,
    pub updated_at_ms: u64,
    /// The whole timer (breaks too), so the other device can show it and send Pause or Stop
    /// back (`crate::remote`). None from apps older than 0.21.26.B / 0.24.22, and when idle.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clock: Option<LiveClock>,
}

/// A running timer as another device shows it. Mirrored by `LiveClock` in
/// apps/mobile/src/ipc/phoneBlocking.ts and apps/desktop/src/features/timer/RemoteTimer.tsx.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LiveClock {
    /// The device running it: where Pause and Stop go.
    pub device_id: String,
    /// "focus" or "break".
    pub phase: String,
    /// 1-based.
    pub round: u32,
    pub rounds: u32,
    pub paused: bool,
    /// Time left while paused; None while running (then `ends_at_ms` says).
    pub left_ms: Option<u64>,
    /// When this phase ends, while running.
    pub ends_at_ms: Option<u64>,
}

impl FocusLive {
    /// Whether the other device should show this timer at `now_ms` (a break too). Older apps
    /// send no clock: then only while it blocks.
    pub fn showing_at(&self, now_ms: u64) -> bool {
        match &self.clock {
            None => self.blocks_at(now_ms),
            Some(c) if c.paused => now_ms < self.updated_at_ms.saturating_add(PAUSED_FOR_MS),
            Some(c) => c.ends_at_ms.is_some_and(|end| now_ms < end),
        }
    }

    /// Whether the phone should block at `now_ms`. A running phase ends on time even if the
    /// phone hears nothing more from the laptop.
    pub fn blocks_at(&self, now_ms: u64) -> bool {
        if !self.active {
            return false;
        }
        match self.ends_at_ms {
            Some(end) if !self.paused => now_ms < end,
            _ => now_ms < self.updated_at_ms.saturating_add(PAUSED_FOR_MS),
        }
    }

    /// The same focus phase? Only the timing fields count, not when it was written.
    pub fn same_as(&self, other: &FocusLive) -> bool {
        self.active == other.active
            && self.paused == other.paused
            && self.ends_at_ms == other.ends_at_ms
            && self.preset_name == other.preset_name
            && self.clock == other.clock
    }
}

pub fn get_live(store: &Store) -> Result<Option<FocusLive>> {
    let raw: Value = settings::get(store, "focus.live")?;
    Ok(serde_json::from_value(raw).ok())
}

/// The laptop writes its focus state when it changes; returns whether anything was written.
pub fn publish_live(store: &mut Store, live: &FocusLive) -> Result<bool> {
    if get_live(store)?.is_some_and(|old| old.same_as(live)) {
        return Ok(false);
    }
    settings::set(store, "focus.live", live)?;
    Ok(true)
}

/// Phone apps that can never be blocked, so blocking can't lock you out of your phone: calls,
/// settings, the system screens, app installers and permission screens, and Focus itself. The
/// phone adds its home screen, keyboards and default phone and messages apps (BlockService.kt).
pub const PROTECTED_PACKAGES: &[&str] = &[
    "com.focus.phone",
    "com.focus.launcher",
    "com.focus.island",
    "android",
    "com.android.systemui",
    "com.android.settings",
    "com.android.phone",
    "com.android.server.telecom",
    "com.android.dialer",
    "com.google.android.dialer",
    "com.samsung.android.dialer",
    "com.samsung.android.incallui",
    "com.android.incallui",
    "com.android.emergency",
    "com.google.android.apps.safetyhub",
    "com.android.packageinstaller",
    "com.google.android.packageinstaller",
    "com.android.permissioncontroller",
    "com.google.android.permissioncontroller",
    "com.android.vending",
    "com.android.contacts",
    "com.google.android.contacts",
    "com.samsung.android.app.contacts",
    "com.android.mms",
    "com.google.android.apps.messaging",
    "com.samsung.android.messaging",
    "com.android.launcher3",
    "com.google.android.apps.nexuslauncher",
    "com.sec.android.app.launcher",
    "com.miui.home",
    "com.android.deskclock",
    "com.google.android.deskclock",
    "com.sec.android.app.clockpackage",
];

pub fn is_protected_package(package: &str) -> bool {
    PROTECTED_PACKAGES.contains(&package)
}

/// An Android package name: "com.instagram.android".
fn normalize_package(input: &str) -> Option<String> {
    let p = input.trim();
    let ok = (3..=255).contains(&p.len())
        && p.contains('.')
        && p.split('.').all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
    ok.then(|| p.to_string())
}

/// One blocked phone app. Mirrors `PhoneAppRule` in apps/mobile/src/ipc/phoneBlocking.ts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PhoneAppRule {
    /// "com.instagram.android".
    pub package: String,
    /// What the Blocking page and the block screen call it, e.g. "Instagram".
    pub name: String,
    pub mode: AppMode,
    pub wait_seconds: u32,
}

/// The phone's own blocking choices (never synced). Mirrors `PhoneBlocking` in phoneBlocking.ts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PhoneBlocking {
    pub apps: Vec<PhoneAppRule>,
    /// Block the laptop's blocked sites in the phone's browsers.
    pub block_sites: bool,
    /// Block YouTube Shorts in the YouTube app.
    pub block_shorts: bool,
}

/// Keeps the usable rules: real package names, no protected apps, no repeats, sane countdowns.
pub fn clean_phone_apps(rules: Vec<PhoneAppRule>) -> Vec<PhoneAppRule> {
    let mut out: Vec<PhoneAppRule> = Vec::new();
    for r in rules {
        let Some(package) = normalize_package(&r.package) else { continue };
        if is_protected_package(&package) || out.iter().any(|o| o.package == package) {
            continue;
        }
        let name: String = r.name.trim().chars().take(80).collect();
        let name = if name.is_empty() { package.rsplit('.').next().unwrap_or(&package).to_string() } else { name };
        out.push(PhoneAppRule { package, name, mode: r.mode, wait_seconds: r.wait_seconds.clamp(1, 86_400) });
        if out.len() == blocking::MAX_APPS {
            break;
        }
    }
    out
}

pub fn get_phone(store: &Store) -> Result<PhoneBlocking> {
    let raw: Value = settings::get(store, "phone.blockApps")?;
    let apps = raw
        .as_array()
        .map(|a| a.iter().filter_map(|v| serde_json::from_value::<PhoneAppRule>(v.clone()).ok()).collect())
        .unwrap_or_default();
    Ok(PhoneBlocking {
        apps: clean_phone_apps(apps),
        block_sites: settings::get(store, "phone.blockSites")?,
        block_shorts: settings::get(store, "phone.blockShorts")?,
    })
}

/// Saves the phone's choices and returns them as kept.
pub fn save_phone(store: &mut Store, choices: PhoneBlocking) -> Result<PhoneBlocking> {
    let apps = clean_phone_apps(choices.apps);
    settings::set(store, "phone.blockApps", &apps)?;
    settings::set(store, "phone.blockSites", &choices.block_sites)?;
    settings::set(store, "phone.blockShorts", &choices.block_shorts)?;
    get_phone(store)
}

/// A countdown or a full block, for sites and Shorts.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShortsRule {
    pub mode: AppMode,
    pub wait_seconds: u32,
}

/// Everything the phone's blocking service needs, read in one go. Mirrored by `BlockState` in
/// BlockService.kt (and phoneBlocking.ts).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BlockState {
    /// The laptop's focus state; None until it has shared one.
    pub live: Option<FocusLive>,
    /// Block right now.
    pub blocking_now: bool,
    pub apps: Vec<PhoneAppRule>,
    /// The laptop's sites (`BlockRule[]`), or [] when sites aren't blocked on the phone.
    pub sites: Value,
    /// None = Shorts not blocked.
    pub shorts: Option<ShortsRule>,
}

pub fn block_state(store: &Store, now_ms: u64) -> Result<BlockState> {
    // The laptop's focus phase, or else the phone's own timer.
    let live = crate::phone_focus::effective_live(store, now_ms)?;
    let phone = get_phone(store)?;
    let lists = blocking::get(store)?.lists;
    let sites = if phone.block_sites && lists.rules.is_array() { lists.rules } else { Value::Array(Vec::new()) };
    // Shorts use the laptop's YouTube choice: a countdown or no way through.
    let yt = &lists.youtube;
    let mode = if yt.get("mode").and_then(Value::as_str) == Some("block") { AppMode::Block } else { AppMode::Wait };
    let wait = yt.get("waitSeconds").and_then(Value::as_u64).unwrap_or(lists.default_wait as u64).clamp(1, 86_400) as u32;
    Ok(BlockState {
        blocking_now: live.as_ref().is_some_and(|l| l.blocks_at(now_ms)),
        live,
        apps: phone.apps,
        sites,
        shorts: phone.block_shorts.then_some(ShortsRule { mode, wait_seconds: wait }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn live(active: bool, paused: bool, ends: Option<u64>) -> FocusLive {
        FocusLive { active, paused, ends_at_ms: ends, preset_name: Some("Classic".into()), updated_at_ms: 1_000, clock: None }
    }

    fn app(package: &str, mode: AppMode) -> PhoneAppRule {
        PhoneAppRule { package: package.into(), name: String::new(), mode, wait_seconds: 20 }
    }

    #[test]
    fn a_running_phase_blocks_until_it_ends() {
        let l = live(true, false, Some(60_000));
        assert!(l.blocks_at(59_999));
        assert!(!l.blocks_at(60_000), "the phone stops on time even if it hears nothing more");
        assert!(!live(false, false, None).blocks_at(2_000), "breaks and an idle timer don't block");
    }

    #[test]
    fn a_paused_phase_blocks_for_a_few_hours_at_most() {
        let l = live(true, true, None);
        assert!(l.blocks_at(1_000 + PAUSED_FOR_MS - 1));
        assert!(!l.blocks_at(1_000 + PAUSED_FOR_MS));
    }

    #[test]
    fn the_laptop_writes_only_changes() {
        let mut store = Store::open_in_memory().unwrap();
        assert_eq!(get_live(&store).unwrap(), None);
        assert!(publish_live(&mut store, &live(true, false, Some(60_000))).unwrap());
        let mut later = live(true, false, Some(60_000));
        later.updated_at_ms = 5_000;
        assert!(!publish_live(&mut store, &later).unwrap(), "same phase: nothing to sync");
        assert!(publish_live(&mut store, &live(true, true, None)).unwrap());
        assert_eq!(get_live(&store).unwrap(), Some(live(true, true, None)));
    }

    #[test]
    fn phone_essentials_and_focus_can_never_be_blocked() {
        let mut store = Store::open_in_memory().unwrap();
        let kept = save_phone(
            &mut store,
            PhoneBlocking {
                apps: vec![
                    app("com.instagram.android", AppMode::Wait),
                    app("com.android.settings", AppMode::Block),
                    app("com.focus.phone", AppMode::Block),
                    app("com.google.android.dialer", AppMode::Block),
                    app("not a package", AppMode::Block),
                    app("com.instagram.android", AppMode::Block),
                ],
                block_sites: false,
                block_shorts: true,
            },
        )
        .unwrap();
        assert_eq!(kept.apps.len(), 1);
        assert_eq!(kept.apps[0].package, "com.instagram.android");
        assert_eq!(kept.apps[0].name, "android");
        assert!(!kept.block_sites);
        assert_eq!(get_phone(&store).unwrap(), kept);
    }

    #[test]
    fn the_phone_follows_the_laptops_sites_and_youtube_choice() {
        let mut store = Store::open_in_memory().unwrap();
        let fresh = block_state(&store, 0).unwrap();
        assert!(!fresh.blocking_now && fresh.live.is_none());
        assert_eq!(fresh.sites, json!([]));
        assert_eq!(fresh.shorts, Some(ShortsRule { mode: AppMode::Wait, wait_seconds: 20 }), "Shorts are blocked by default");

        blocking::save(
            &mut store,
            &blocking::BlockingLists {
                rules: json!([{ "domain": "reddit.com", "mode": "block", "waitSeconds": 20 }]),
                youtube: json!({ "mode": "block", "waitSeconds": 45 }),
                default_wait: 20,
            },
        )
        .unwrap();
        publish_live(&mut store, &live(true, false, Some(60_000))).unwrap();
        let s = block_state(&store, 30_000).unwrap();
        assert!(s.blocking_now);
        assert_eq!(s.sites[0]["domain"], "reddit.com");
        assert_eq!(s.shorts, Some(ShortsRule { mode: AppMode::Block, wait_seconds: 45 }));

        save_phone(&mut store, PhoneBlocking { apps: vec![], block_sites: false, block_shorts: false }).unwrap();
        let s = block_state(&store, 30_000).unwrap();
        assert_eq!(s.sites, json!([]));
        assert_eq!(s.shorts, None);
    }

    #[test]
    fn the_focus_state_syncs_but_the_phones_choices_stay_on_the_phone() {
        assert!(!settings::LOCAL_ONLY.contains(&"focus.live"));
        for key in ["phone.blockApps", "phone.blockSites", "phone.blockShorts"] {
            assert!(settings::LOCAL_ONLY.contains(&key), "{key}");
        }
    }
}
