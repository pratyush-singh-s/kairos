# Phase 4: App shell and UI

## What we built

- **Real app layout**: a sidebar with every section (Dashboard, Focus timer, To-do, Deadlines, Notes,
  Calendar, Statistics, Blocking, Settings). Sections not built yet are marked **Soon** and their page says
  which phase brings them. No button pretends to work.
- **Dashboard** with live data from the database: greeting by time of day, today's focus time and sessions,
  upcoming deadlines, today's tasks, pinned notes, your presets, and Firefox blocking status. It refreshes
  every minute and when you come back to the window, so "today" rolls over at midnight. Empty sections say
  so plainly.
- **System tray**: Focus has a tray icon. Left-click opens the window; right-click gives "Open Focus" and
  "Quit Focus".
- **Close to tray**: closing the window keeps Focus running in the tray (needed so timers keep going in
  Phase 6). The first time, a Windows notification tells you where it went. You can switch this off in
  Settings, so the close button quits instead.
- **Single instance**: opening Focus again while it runs brings the existing window to the front instead of
  starting a second copy.
- **Settings page**: the close behaviour (saved in the database, sync-ready), a Quit button, and the
  diagnostics that used to be the start screen.
- **One-step upgrades**: from this version on, installing a newer Focus over an older one no longer asks
  "Uninstall before installing". It just updates.
- **Accessibility**: keyboard navigation (Tab, Enter), a "Skip to content" link, visible focus outlines,
  the current page marked for screen readers, statuses shown with icon + word, not colour alone.
  An automated accessibility scan (axe-core) of the dashboard found no problems.

## Files changed or added

```
crates/focus-store/src/
├── settings.rs          NEW  get/set settings; synced changes go to the change log
├── dashboard.rs         NEW  queries for the dashboard (focus today, deadlines, tasks, notes)
└── store.rs, lib.rs          small additions
packages/core/src/day/   NEW  localDay (today's start/end in your time zone), greeting + tests
apps/desktop/src-tauri/
├── Cargo.toml                tray-icon feature, single-instance and notification plugins; 0.3.0
├── tauri.conf.json           0.3.0; custom installer template
├── windows/installer.nsi NEW Tauri's installer template with one change: upgrades skip the uninstall page
└── src/
    ├── lib.rs                plugins, tray, close-to-tray handling, new commands
    ├── tray.rs          NEW  tray icon, menu, hide-to-tray with one-time notice
    └── commands.rs           + load_dashboard, get/set_close_to_tray, quit_app
apps/desktop/src/
├── main.tsx
├── app/  App.tsx, Sidebar.tsx, routes.ts          NEW layout and navigation
├── features/dashboard/DashboardPage.tsx           NEW
├── features/settings/SettingsPage.tsx             NEW
├── features/upcoming/UpcomingPage.tsx             NEW "not built yet" page
├── components/  Card.tsx, Status.tsx, Icon.tsx    NEW
├── ipc/  dashboard.ts, settings.ts                NEW
├── useCommand.ts                                  + reload and auto-refresh
└── styles.css                                     layout styles (themes come in Phase 5)
```

## Install and test

1. Close Focus (right-click its tray icon → Quit Focus, or just close the window in 0.2.0).
2. Extract `Focus-0.3.0-installer.zip` and run `Focus_0.3.0_x64-setup.exe`.
   - About the uninstall question: the page you saw last time belongs to the **new** installer, and this
     0.3.0 installer already skips it. If you still see it, pick either option; your data is safe.

**Test these:**

| Try | Expected |
| --- | --- |
| Open Focus | Sidebar on the left, Dashboard showing "Good morning/afternoon/evening", your 4 presets, 0s focus today, empty sections with a note on which phase fills them |
| Click each sidebar item | Pages marked Soon show "Not built yet. This page arrives in Phase N." |
| Press Tab from the start | First "Skip to content", then the sidebar items in order, each with a visible outline |
| Close the window (X) | Window disappears; a Windows notification "Focus is still running" appears (first time only); Focus icon stays in the tray (it may be under the ^ arrow) |
| Left-click the tray icon | Window comes back |
| Right-click tray icon → Quit Focus | Focus exits; the tray icon disappears |
| Start Focus twice from the Start menu | Only one window; the second launch brings it to the front |
| Settings → "Quit Focus completely" → close the window | Focus exits instead of hiding. Re-open: the choice is remembered |
| Settings → Diagnostics | Three OK checks and your data folder |

## Checks run before delivery

- Rust: 22 tests pass (7 new: settings defaults, unknown keys refused, synced vs local logging, clock order,
  empty dashboard, focus-today counting, today's-task filtering). `cargo check` for Windows: no warnings.
- TypeScript: 10 tests pass (4 new for local day and greeting); typecheck clean.
- UI rendered in a browser with test data; axe-core accessibility scan: 0 violations.
- Installer cross-built for Windows; the upgrade-in-place change is present in the generated installer.
- Not testable here: the tray, notification and real install/upgrade on Windows. Your test is the first.

## Next: Phase 5 (themes)

The Glass and Terminal themes, switchable instantly, built on shared design tokens.
