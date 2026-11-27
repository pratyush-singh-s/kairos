# Phase 7: Focus history

## What we built

- **Every session is saved.** Each focus session (and each break) is written to the database the moment it
  starts and updated when it ends: start and end time, planned length, real focus time (pauses not counted),
  paused time, and how it ended: Completed, Stopped early, or Skipped. Nothing is lost if Focus closes mid-session.
- **History page** (new in the sidebar, under Focus timer):
  - Today's focus time and completed sessions, the last 7 days' total and daily average.
  - A bar for each of the last 7 days.
  - Every session grouped by day (Today, Yesterday, then dates), with its time, length, preset and result.
    A running session shows as "In progress".
  - "Show breaks" to include breaks; "Show older" to go further back.
  - Delete a session from history (the bin icon, then Delete). It asks first.
- **Dashboard "Today's focus"** now shows real numbers and updates the moment a session ends.
- **The timer survives a restart.** If you quit Focus, install an update, or restart the PC during a session:
  - Back within 2 minutes (e.g. an update): the timer just carries on.
  - Away longer: the session comes back **paused** where you left off, so time away doesn't count as focus.
    A notification says "Focus session restored".
- **Blank window fix.** If a screen ever fails, Focus now shows "Something went wrong" with the error and a
  Reload button instead of a blank window, and it reloads itself if the window comes back empty. If you see that
  screen, send me a screenshot of the message so I can fix the real cause.

Statistics with charts over weeks and months come later (Phase 20); this phase is the history they will use.

## Files changed or added

```
crates/focus-timer/src/lib.rs          timer can be saved and restored (long gap → paused); 3 new tests
crates/focus-store/src/
├── sessions.rs                   NEW  begin / finish / list / delete sessions, close leftovers; 5 tests
├── local.rs                      NEW  this-PC-only values (the saved running timer); 1 test
└── lib.rs
apps/desktop/src-tauri/src/
├── history.rs                    NEW  turns timer events into history rows; saves/restores the timer; 3 tests
├── timer.rs                           records + saves on every change, 30 s heartbeat, "restored" notification
├── commands.rs                        list_history, delete_history_session
└── lib.rs                             restores the timer at startup
apps/desktop/src/
├── features/history/HistoryPage.tsx  NEW
├── ipc/history.ts                NEW  + "history-changed" event hook
├── app/ErrorBoundary.tsx         NEW  crash screen with Reload
├── app/routes.ts, App.tsx, components/Icon.tsx   History page in the sidebar
├── features/dashboard/DashboardPage.tsx           live "Today's focus"
├── main.tsx                           crash screen + reload-if-empty
└── styles.css                         history page styles (both themes)
```

## Install and test

1. Right-click the Focus tray icon → **Quit Focus**.
2. Extract `Focus-0.6.0-installer.zip` and run `Focus_0.6.0_x64-setup.exe` (updates in place).

Tip: use a "Test" preset with Focus 1, breaks 1, Sessions 2.

| Try | Expected |
| --- | --- |
| Open History | Empty message the first time ("No focus sessions…") |
| Start a focus session, open History | "In progress" row under Today |
| Let it finish | Row turns "Completed · 1m"; Dashboard's Today's focus shows 1m |
| Start, then Stop | "Stopped early" row with the minutes you did |
| Show breaks | Breaks appear in grey |
| Bin icon → Delete | Row disappears; totals drop |
| Start a 25-min session, Quit Focus from the tray, open Focus again right away | Timer still running, about the same time left; notification "Focus session restored" |
| Start, Quit Focus, wait 3+ minutes, open Focus | Timer is **paused** where you left off; Resume continues it |
| Ctrl + Shift + T on History | Terminal look |

## Checks run before delivery

- Rust: 32 storage tests, 16 timer tests, 6 desktop tests (history recording, restart restore) pass.
- TypeScript: tests pass; typecheck clean; extension lint clean.
- History page and dashboard rendered in both themes with sample data.
- Not testable here: real restart on Windows and notifications. Your test is the first.

## Next: Phase 8

App tracking (opt-in): which apps you use during focus sessions.
