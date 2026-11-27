# Phase 6: Focus timer

## What we built

- **Circular timer** on the new Focus timer page. The ring fills smoothly as time passes. Inside it shows
  the time left (`24:32`), the phase (FOCUS, SHORT BREAK, LONG BREAK) and `SESSION 1 / 4`. Focus is blue,
  breaks are green, paused is yellow. In the Terminal theme there is also a text bar: `[######----] 60%`.
- **Controls**: Start focus, Pause / Resume, Skip (session or break), and Stop (asks first; a stopped focus
  session counts as interrupted). **Space** starts, pauses and resumes.
- **The run follows your preset**, as in your example: 25 focus, 5 break, 25 focus, 5 break, 25 focus,
  5 break, 25 focus, done. Every Nth break can be a long break.
- **Automatic transitions**: per preset, "Start breaks automatically" and "Start the next focus session
  automatically after a break". If one is off, the timer waits with a "Start break" / "Start focus" button.
- **Presets**: create, edit and delete your own (name, focus, short break, long break, sessions, long break
  every N, the two auto-start options). The built-in four can be edited or deleted too; the last preset
  can't be deleted. Presets are locked while a session runs. Changes are saved and logged for PC-to-PC sync.
  The preset you used last is picked next time.
- **Keeps running when the window is closed or minimized**: the timer lives in the app's native core, not
  in the window. The tray icon's tooltip shows the countdown (hover over the Focus tray icon).
- **Windows notifications**: focus session complete (and break started), break over (and next focus
  started), focus session interrupted, all sessions done.
- **Dashboard**: the Focus card shows the live timer and an "Open timer" button.
- **Sleep-safe**: the timer counts by the clock, so if the PC sleeps through the end of a phase it catches up
  when it wakes.

Honest limits for this phase:
- Sessions are **not saved to history yet**; that is Phase 7 (along with continuing a session after Focus is
  quit or the PC restarts). Quitting Focus from the tray currently ends a running timer.
- "Today's focus" on the dashboard stays at 0 until Phase 7.

## Files changed or added

```
crates/focus-timer/            NEW  the timer as a state machine (no clock inside, so it is fully tested)
└── src/lib.rs                      Plan, phases, start/pause/resume/skip/stop/continue, tick; 13 tests
crates/focus-store/src/
├── presets.rs                      create / update / delete with validation, change log; 3 new tests
└── settings.rs                     "timer.lastPresetId"
apps/desktop/src-tauri/
├── Cargo.toml                      uses focus-timer; 0.5.0
└── src/
    ├── timer.rs               NEW  background ticker (4×/s), tray tooltip, notifications, events to the window
    ├── commands.rs                 preset commands; timer_state/start/pause/resume/skip/stop/continue
    └── lib.rs                      registers the timer and commands
apps/desktop/src/
├── ipc/timer.ts, ipc/presets.ts   NEW
├── features/timer/            NEW
│   ├── TimerPage.tsx               page layout, controls, preset list, Space shortcut
│   ├── TimerRing.tsx               the SVG ring and centre text
│   ├── PresetForm.tsx              create/edit/delete form
│   └── useTimer.ts                 live timer state + smooth countdown
├── features/dashboard/DashboardPage.tsx  live Focus card
├── app/routes.ts, app/App.tsx      timer page is no longer "Soon"
└── styles.css                      timer, preset and form styles (both themes)
package.json                        test script also runs the timer tests; 0.5.0
```

The full code is in `focus-source-0.5.0.zip`.

## Install and test

1. Right-click the Focus tray icon → **Quit Focus**.
2. Extract `Focus-0.5.0-installer.zip` and run `Focus_0.5.0_x64-setup.exe` (updates in place).

Tip for quick testing: make a preset "Test" with Focus 1, Short break 1, Long break 1, Sessions 2.

| Try | Expected |
| --- | --- |
| Open Focus timer | Ring shows `25:00 FOCUS`, presets on the right with Pomodoro selected |
| Start focus | Ring starts filling, `24:59 … SESSION 1 / 4`; Dashboard's Focus card shows the same countdown |
| Pause, wait, Resume | Time freezes while paused (ring turns yellow), continues from the same point |
| New preset "Test" (1/1/1, 2 sessions), select it, Start | After 1 minute: notification "Focus session 1 of 2 complete · Short break started"; ring turns green |
| Wait for the break to end | Notification "Break over"; with auto next off, the button shows "Start focus" |
| Start focus, wait 1 minute | Notification "All focus sessions done"; ring full, "Start again" button |
| Start, then Stop → Yes, stop | Notification "Focus session interrupted"; timer back to idle |
| Start, close the window, hover the tray icon | Tooltip like "Focus · 0:42 focus · 1/2"; notifications still arrive |
| Edit a preset, change minutes, Save | List updates; restart Focus, change is still there |
| Delete a preset | Asks first, then removes it |
| Press Space on the timer page | Starts / pauses / resumes |
| Ctrl + Shift + T | Terminal look: orange time, square ring ends, `[####----]` bar |

If notifications don't appear: Windows Settings → System → Notifications → make sure notifications are on and
Focus is allowed (and Do not disturb is off).

## Checks run before delivery

- Rust: 26 storage tests + 13 timer tests pass (full Pomodoro sequence, long-break spacing, pause, auto-start
  off, skip, stop timing, zero-length break, sleeping through phases, invalid actions).
- TypeScript: 20 tests pass; typecheck clean; extension lint clean.
- Timer page rendered in both themes (running, break, idle, edit form); axe-core: 0 violations.
- Not testable here: real Windows notifications and tray tooltip. Your test is the first.

## Next: Phase 7 (session history)

Save every focus session (start, end, planned, actual, completed or interrupted), show the history, fill
"Today's focus", and resume a running timer after Focus restarts.

## Update 0.5.1 (after your first look)

- **Blue strip removed** from the current page in the Glass sidebar; the selected page is shown by its
  lighter background only.
- **Pop-out mini timer** (like the compact view in Windows Clock): **Pop out** on the timer page opens a small
  timer that stays on top of other windows, in the top-right corner. Drag it anywhere, resize it from its
  edges, and use the round button to pause / resume / start. Hover it to see "open Focus" and close (×).
  It follows your theme and the main window, and it isn't shown in the taskbar.
- **Soft chime**: when a focus session ends (three falling notes), a break ends (three rising notes), or all
  sessions are done (four slow rising notes). The tones are generated by Focus itself: soft bell tones in
  C major with a gentle fade, not a copy of any Microsoft sound. Settings → Sound: on/off, volume, and
  "Listen" buttons to preview. Windows notifications are silent so you only hear the chime.

Files: `src-tauri/src/sound.rs` (new: chime synthesis + Windows PlaySound), `src-tauri/src/timer.rs` (plays the
chime), `src-tauri/src/commands.rs` (sound settings, preview, open/close mini timer, show main window; window
effect now applies to whichever window asks), `capabilities/default.json` (mini window), `Cargo.toml`
(`windows-sys` for PlaySound), `src/features/timer/MiniTimer.tsx` (new), `src/ipc/sound.ts`, `src/ipc/windows.ts`
(new), `main.tsx` (mini window entry), `UiProvider.tsx` (theme changes sync between windows),
`SettingsPage.tsx` (Sound card), `TimerPage.tsx` (Pop out), `styles.css`; settings `timer.soundOn`,
`timer.volume`.

| Try | Expected |
| --- | --- |
| Glass sidebar | No blue line beside the current page |
| Settings → Sound → Listen buttons | Three soft chimes; volume slider changes loudness |
| Timer → Pop out | Small timer top-right, on top of other windows; drag and resize it |
| Mini: round button | Pauses / resumes the same timer as the main window |
| Hover mini → ↗ / × | Opens the main Focus window / closes the mini timer |
| Switch theme in the main window | Mini timer changes theme too |
| Let a 1-minute test focus end | Chime plays (also with the window closed to tray) |

## Update 0.5.2 (mini timer, after your second look)

- **Compact mini timer**, closer to Windows Clock: about 220 × 124, just the time in big digits, one round
  play/pause button and the session count (`2/4`) beside it. No "Focus / Short break / Paused" text and no ring.
  A thin line along the bottom edge fills as the phase goes by: blue for focus, green for a break, yellow when paused.
- **More see-through in Glass**: the mini window's tint is much lighter (Acrylic tint 40 instead of 120, page
  overlay 8% instead of 35%), so the desktop shows through.
- **Icons instead of a button**: the "Pop out" button is now a small pop-out icon (square with an arrow) in the
  top-right corner of the timer card. In the mini timer, the icon in the top-left corner (two arrows pointing in)
  leaves pop-out mode: it closes the mini timer and brings back the main window.

Files: `MiniTimer.tsx`, `TimerPage.tsx`, `ipc/windows.ts` (`exitMiniTimer`), `styles.css` (mini section,
`.icon-button`), `src-tauri/src/commands.rs` (mini size 220×124, lighter Acrylic tint for the mini window).

| Try | Expected |
| --- | --- |
| Timer page | Small pop-out icon in the top-right corner of the timer card; no "Pop out" button |
| Click the pop-out icon | Small timer top-right: time, round button, `1/4` beside it |
| Glass theme | Desktop clearly visible through the mini timer |
| Click the inward-arrows icon in the mini timer | Mini timer closes and the main window comes back |
