# Focus

A personal focus timer, planner and distraction blocker for Windows 11, with a companion Firefox extension.
No server: each PC keeps its own data and syncs directly with your other PC.

Architecture: see the Focus architecture proposal (Claude Doc) and `docs/`.

## Layout

```
apps/desktop      Windows app (Tauri 2: Rust core + React UI)
apps/extension    Firefox extension (Manifest V3)
packages/core     Shared TypeScript logic (time formatting now; timer, deadlines, rules later)
crates/focus-store  Local SQLite database (and what syncing sends and merges)
crates/focus-sync   Syncing between your devices: discovery, pairing, encrypted sessions
docs/             Phase notes and guides
scripts/          Build scripts
```

## Using it

Download the installer for each phase and run it. Updating = running the newer installer;
your data in `%APPDATA%\com.focus.desktop` is kept.

## Building from source (optional)

See `docs/DEVELOPING.md`.
