# Phase 8: App tracking, new Terminal look, Blur and Transparency sliders

## What's new

### Terminal theme, redesigned (from your btop / LazyVim references)
- Panels are drawn with thin lines, and the **title sits in the top border** with a small panel number
  (`¹focus`, `²today's focus`), as in btop.
- Square corners everywhere, monospace text, lowercase titles.
- The sidebar is a **file tree** (`├─ dashboard`, `└─ settings`); the current page is a full-row highlight.
- Buttons are boxed text; the main action is filled, like a selected row.
- A **vim-style status line** along the bottom: mode (`NORMAL`, `FOCUS`, `BREAK`, `PAUSED`), page, time left
  and session (`17:22 · 2/4`), and the clock.
- The week chart and app bars use btop's dotted meters; the timer ring has a tick-mark track.

### Blur and Transparency sliders (Settings → Appearance)
- One pair for Glass and one for Terminal; each theme remembers its own.
- **Transparency** (0 = solid … 100 = almost clear) sets how much of your desktop shows through.
- **Blur**: 0 = off (the desktop shows through sharp, like a see-through terminal); above 0 Windows blurs what's
  behind the window, and higher values also frost the panels more.
- Changes show while you drag and are saved when you let go.
- Honest limit: Windows doesn't let apps choose how *strong* its background blur is, so the desktop blur itself
  is on or off; the slider's strength applies to Focus's own panels.
- Defaults: Glass blur 60 / transparency 65; Terminal blur 40 / transparency 25.
- The "Glass window background" (See-through / Wallpaper tint / Solid) choice is replaced by these sliders.

### App tracking (Phase 8), opt-in
- Settings → **App tracking**: Off (default), During focus sessions, or All the time.
- Once a second Focus notes which program is in front. Only the program's name is kept ("VS Code", "Firefox"),
  never window titles, web pages or typing. Time away from the keyboard (2 minutes without input) or with the
  screen locked isn't counted.
- **Dashboard → Today's activity**: your top 5 programs today with time bars.
- **History**: each focus session shows the programs used in it ("VS Code 18m · Firefox 6m").
- Detailed activity stays on this PC and is deleted after 30 days; per-session totals will sync with your other
  PC later. "Delete recorded activity…" in Settings removes it all.

## Files changed or added

```
crates/focus-store/src/activity.rs     NEW  apps, activity spans, per-session usage, totals, prune, clear; 3 tests
crates/focus-store/src/sessions.rs           history rows carry their top apps
crates/focus-store/src/dashboard.rs          today's top apps
crates/focus-store/src/settings.rs           tracking.mode (this PC only), 4 look sliders
apps/desktop/src-tauri/src/tracking.rs NEW  foreground-program sampler (Windows), idle detection; 4 tests
apps/desktop/src-tauri/src/commands.rs       tracking mode, clear activity, look sliders, acrylic tint
apps/desktop/src-tauri/Cargo.toml            Windows API features for the tracker
apps/desktop/src/app/StatusLine.tsx    NEW  terminal status line
apps/desktop/src/ipc/tracking.ts       NEW
apps/desktop/src/theme/UiProvider.tsx        sliders drive transparency, blur and the Windows effect
apps/desktop/src/features/settings/SettingsPage.tsx   sliders, App tracking card
apps/desktop/src/features/dashboard/DashboardPage.tsx Today's activity
apps/desktop/src/features/history/HistoryPage.tsx     apps per session
apps/desktop/src/components/Card.tsx         title text wrapped for the terminal border title
apps/desktop/src/styles.css                  terminal theme rewritten; app bars; sliders
packages/ui/src/themes/terminal.ts           new terminal colours and shapes
```

## Install and test

1. Right-click the Focus tray icon → **Quit Focus**.
2. Extract `Focus-0.7.0-installer.zip` and run `Focus_0.7.0_x64-setup.exe` (updates in place).

| Try | Expected |
| --- | --- |
| Ctrl + Shift + T | Terminal look: boxed panels with titles in the border, tree sidebar, status line at the bottom |
| Start a focus session in Terminal | Status line shows `FOCUS` and the countdown |
| Settings → Terminal look → Transparency to 70 | Desktop shows through behind the window |
| Terminal Blur to 0 | Desktop shows through sharp (no blur); above 0 it's blurred |
| Glass sliders | Same, for the Glass theme only |
| Settings → App tracking → During focus sessions, start a 1-min session, use a couple of programs | Dashboard's Today's activity lists them; History shows them under the session |
| Leave the PC alone 3+ minutes during a session | That idle time is not added |
| Delete recorded activity… → Delete | Today's activity is empty again |

## Checks run before delivery

- Rust: 35 storage tests, 16 timer tests, 10 desktop tests (history, restore, tracker) pass; Windows build checked.
- TypeScript: tests pass; typecheck clean; extension lint clean.
- Dashboard, History, Timer and Settings rendered in both themes, including over a coloured "desktop".
- Not testable here: real foreground-program detection, Windows blur and transparency. Your test is the first.

## Next: Phase 9

The next phase from the architecture plan, once you have tried this one.
