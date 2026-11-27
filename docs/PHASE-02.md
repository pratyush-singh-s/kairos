# Phase 2: Project setup

## What we built

The empty-but-working skeleton every later phase builds on:

- **Monorepo** (pnpm workspaces) with shared TypeScript settings.
- **Windows app** (`apps/desktop`): Tauri 2 with a Rust core and a React UI. It opens a
  "Setup check" screen that proves the React UI, the Rust core and the shared package talk to each other.
- **Shared logic** (`packages/core`): time formatting used by the timer later (`25:00`, `2h 35m`), with 6 unit tests.
- **Firefox extension** (`apps/extension`): installs, shows an `OFF` badge and a popup that says
  plainly that blocking and the link to the Windows app are not built yet.
- **Installer**: a per-user Windows installer (no admin needed) that upgrades in place.

Nothing in this phase pretends to work: the screens list exactly what exists.

## Folder structure after this phase

```
focus/
├── package.json, pnpm-workspace.yaml, tsconfig.base.json, .gitignore, .editorconfig, .nvmrc
├── apps/
│   ├── desktop/
│   │   ├── index.html
│   │   ├── src/
│   │   │   ├── main.tsx            React entry
│   │   │   ├── App.tsx             Setup check screen
│   │   │   ├── styles.css
│   │   │   └── ipc/appInfo.ts      typed call to the Rust core
│   │   └── src-tauri/
│   │       ├── Cargo.toml
│   │       ├── tauri.conf.json     window, security policy, installer settings
│   │       ├── capabilities/default.json
│   │       ├── icons/
│   │       └── src/
│   │           ├── main.rs
│   │           ├── lib.rs          app startup
│   │           └── commands.rs     app_info command
│   └── extension/
│       ├── static/                 manifest.json, popup.html, popup.css, icons
│       ├── src/background.ts       OFF badge
│       ├── src/popup/popup.ts
│       └── scripts/build.mjs
├── packages/core/src/time/         format.ts + format.test.ts
├── docs/                           this file, DEVELOPING.md
└── scripts/build-release.sh
```

## Install and test (Windows 11)

### Desktop app

1. Download `Focus_0.1.0_x64-setup.exe` and run it.
2. Windows SmartScreen may say "Windows protected your PC" because the installer is not code-signed
   (a certificate costs money; fine for personal use). Click **More info** → **Run anyway**.
3. Finish the installer. Focus opens from the Start menu.

**Expected:** a dark window titled "Focus" with three checks, each showing a green check mark and "OK":

| Check | Detail shown |
| --- | --- |
| Interface (React) | This window is rendering. |
| Native core (Rust) | Responded: Focus 0.1.0 |
| Shared logic (@focus/core) | 25 min shows as 25:00; 9,342 s shows as 2h 35m |

Below, "About this install" shows version 0.1.0, Tauri version, `windows (x86_64)` and your data folder,
normally `C:\Users\<you>\AppData\Roaming\com.focus.desktop`.

If the Rust check shows **Failed**, copy the message and send it to me.

### Firefox extension (temporary install for now)

1. Download `focus-blocker-0.1.0.zip`.
2. In Firefox, open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…** and pick the zip file.

**Expected:** a Focus icon with a grey **OFF** badge in the toolbar (it may be inside the puzzle-piece
extensions menu; pin it). Clicking it shows "Blocking is not active" and the list of what is not built yet.

Temporary add-ons are removed when Firefox restarts. A permanent install needs Mozilla to sign the
extension (free); we do that when blocking exists (Phase 12), so you are not re-installing an empty add-on.

### Updating later

Run the newer `Focus_<version>_x64-setup.exe`. It replaces the program files and keeps your data folder.
Uninstalling also keeps your data unless you tick "Delete the application data".

## Checks run before delivery

- `pnpm test`: 6 of 6 unit tests pass.
- `pnpm typecheck`: no errors in all three packages.
- `web-ext lint`: 0 errors, 0 warnings, 0 notices.
- The installer was built on Linux by cross-compiling for Windows (MinGW toolchain). It contains `Focus.exe`
  and `WebView2Loader.dll`. It has **not** been run on a real Windows machine yet; your test is the first.

## Next: Phase 3 (data model)

The local SQLite database with all tables from the architecture, migrations, and tests, so every later
feature has somewhere real to save data.
