# Phase 5: Themes (Glass and Terminal)

## What we built

- **Shared design tokens** (`packages/ui`): every colour, font, corner radius, shadow, blur and animation
  speed lives in one place per theme. The app reads them as CSS variables, so every later screen (timer,
  notes, deadlines...) gets both themes for free.
- **Glass theme** (default): translucent cards with a soft blur, rounded corners, gentle shadows, Segoe UI
  Variable. On Windows 11 the window uses the **Mica** backdrop (your wallpaper's colour softly shows
  through). Focus asks Windows for Mica and only goes see-through if Windows says yes; on Windows 10 or if
  Mica fails it keeps a solid dark background, so text is never hard to read.
- **Terminal theme**: Cascadia Code everywhere, square bracketed panels (`┌─[ TODAY'S FOCUS ]`), a `$` before
  page titles, lowercase menu with `>` on the current page and `[soon]` tags, orange numbers, green/red/yellow
  status colours like a code editor, no animations. Today's focus is shown as `focus_time / completed /
  interrupted`.
- **Switching is instant**, three ways: Settings → Appearance, the button at the bottom of the sidebar, or
  **Ctrl + Shift + T** anywhere. The choice is saved in the database (and will sync to your other PC later)
  and also remembered for the very first frame, so Focus doesn't flash the wrong theme on start.
- **Readability tests**: automated checks that normal and muted text meet the WCAG AA contrast ratio
  (4.5:1) on every card in both themes, including Glass over light and dark Mica backdrops.
- If Windows has "Reduce animations" turned on (Settings → Accessibility → Visual effects → Animation
  effects off), Glass animations are switched off too.
- The Windows title bar is now dark in both themes.

## Files changed or added

```
packages/ui/                       NEW  @focus/ui
└── src/themes/
    ├── tokens.ts                  the list of design tokens every theme must fill in
    ├── glass.ts, terminal.ts      the two themes
    ├── apply.ts                   tokens → CSS variables on the page
    ├── contrast.ts                WCAG contrast maths
    └── themes.test.ts             10 tests (contrast in both themes, same variables in both)
crates/focus-store/src/settings.rs "ui.theme" setting (default glass, synced) + test
apps/desktop/src-tauri/
├── Cargo.toml                     window-vibrancy 0.8 (Mica); 0.4.0
├── tauri.conf.json                window is transparent so Mica can show; 0.4.0
└── src/commands.rs, lib.rs        get_theme, set_theme (only glass/terminal accepted), set_window_effect
apps/desktop/src/
├── theme/ThemeProvider.tsx   NEW  applies the theme, asks for Mica, Ctrl+Shift+T, saves the choice
├── ipc/theme.ts              NEW
├── main.tsx                       paints the remembered theme before the first frame
├── styles.css                     everything uses theme variables; terminal-only touches at the end
├── app/Sidebar.tsx                theme button
├── features/settings/SettingsPage.tsx   Appearance card
└── features/dashboard/DashboardPage.tsx terminal key/value view of today's focus
```

The full code is in `focus-source-0.4.0.zip`.

## Install and test

1. Right-click the Focus tray icon → **Quit Focus**.
2. Extract `Focus-0.4.0-installer.zip` and run `Focus_0.4.0_x64-setup.exe`. It updates 0.3.0 in place.

| Try | Expected |
| --- | --- |
| Open Focus | Glass theme: see-through dark cards; the window background picks up a faint tint of your wallpaper (Mica) |
| Settings → Appearance | "Window backdrop: Mica is on." (on Windows 11) |
| Press Ctrl + Shift + T | Switches to Terminal at once: monospace, `$ Good afternoon`, `┌─[ FOCUS ]` panels, `[soon]` tags |
| Press Ctrl + Shift + T again | Back to Glass |
| Click the theme button at the bottom of the sidebar | Same switch |
| Choose Terminal, quit Focus from the tray, open it again | Opens straight in Terminal, no flash of Glass |
| Settings → Diagnostics | Still three OK checks; data folder unchanged |
| Everything from Phase 4 (tray, close to tray, single window) | Still works |

## Checks run before delivery

- Rust: 23 tests pass (1 new: theme setting). TypeScript: 20 tests pass (10 new theme/contrast tests);
  typecheck clean; extension lint clean.
- Both themes rendered in a browser with sample data; axe-core accessibility scan: 0 violations in each.
- Not testable here: Mica itself (it needs real Windows 11). If Mica can't be applied, the app tells you in
  Settings and keeps a solid background.

## Next: Phase 6 (focus timer)

The circular Pomodoro timer with presets, start/pause/skip, and sessions saved to the database.

## Update 0.4.1 (after your first test)

- **See-through Glass**: the Glass window now uses **Acrylic** by default, so the windows behind Focus show
  through, blurred. Settings → Appearance → "Glass window background" lets you pick See-through (Acrylic),
  Wallpaper tint (Mica) or Solid.
  - Windows itself makes Acrylic solid while Focus is not the active window. That is how Windows 11 draws
    it, not a bug in Focus.
- **Hidden title bar** (like Zen Browser's compact mode): the Windows title bar is replaced by Focus's own.
  It stays hidden and slides down when your cursor touches the top edge of the window, and hides again
  shortly after you move away. It has drag-to-move, double-click to maximize, minimize, maximize and close.
  Settings → Appearance → "Title bar" → "Always show" if you prefer it visible.
  - Windows 11's snap-layout popup (hovering the maximize button) is not available with a custom title bar;
    Win + Z and Win + arrow keys still snap the window.
- **Collapsible sidebar**: the button next to "Focus" (or **Ctrl + B**) shrinks the sidebar to icons.
  Hover an icon to see its name. The choice is remembered.

Files: `src/app/TitleBar.tsx` (new), `src/theme/UiProvider.tsx` (replaces ThemeProvider), `src/ipc/ui.ts`
(replaces theme.ts), `Sidebar.tsx`, `SettingsPage.tsx`, `styles.css`, `src-tauri/src/commands.rs`
(`get_ui_settings`, `set_ui_setting`, `set_window_effect` with acrylic/mica/none), `capabilities/default.json`
(window move/minimize/maximize/close permissions), `tauri.conf.json` (no Windows frame), settings defaults.

| Try | Expected |
| --- | --- |
| Open Focus (Glass) | Open windows behind Focus are visible, blurred |
| Click another window | Focus's background turns solid until you click back (Windows behaviour) |
| Move the cursor to the very top of the window | The title bar slides down; move away and it hides |
| Drag the title bar / double-click it | Moves the window / maximizes and restores |
| Drag a window edge | Resizes |
| Click the sidebar button next to "Focus", or press Ctrl + B | Sidebar shrinks to icons; again to expand |
| Close button in the title bar | Same as before: hides to the tray |

## Update 0.4.2

- Smoother motion: the title bar slide and sidebar collapse now take 0.45 s with an ease-in-out curve
  (slow start, slow finish). Hover and colour changes in Glass use a gentler ease-in-out too (0.28 s).
- Terminal keeps colour changes instant, but its title bar and sidebar also glide (0.3 s, ease-in-out).
- New theme tokens: `layoutDuration` and `layoutEasing` (`packages/ui`). With Windows "Animation effects"
  off, all motion is turned off.
