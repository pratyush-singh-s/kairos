# Phase 3: Local database

## What we built

The local SQLite database that every later feature saves into, created automatically the first time
Focus 0.2.0 starts.

- **New Rust crate `crates/focus-store`** (no Tauri inside, so it is tested on its own):
  - `migrations/0001_initial.sql`: all tables from the architecture (24, counting the notes search index) (presets, sessions, app usage,
    blocking profiles and rules, tasks, deadlines, day marks, notes with full-text search, tags, links,
    calendar cache, YouTube cache, peers, change log, settings).
  - `migrations.rs`: applies schema upgrades in order, each in a transaction. If a database comes from a
    newer Focus, it refuses with a clear message instead of damaging it.
  - `ids.rs`: UUIDv7 row IDs (sortable by time; safe to create offline on two PCs).
  - `clock.rs`: hybrid logical clock stamps that order changes between your PCs, even if a PC clock is wrong.
  - `presets.rs`: built-in presets Pomodoro 25/5, Study 50/10, Deep Work 90/20, Exam 50/10, with fixed IDs so
    both PCs end up with the same four, not eight. A preset you delete stays deleted.
  - `store.rs`: opens the file, turns on write-ahead logging and foreign keys, gives this PC its permanent ID.
- **Desktop app**: opens `focus.db` in your data folder at start-up. If it cannot, the app still opens and
  shows the reason (no silent failure).

### Database rules worth knowing

- Times are stored in UTC milliseconds; calendar dates as `YYYY-MM-DD`.
- Nothing synced is hard-deleted; deletes are marked (`deleted_at`) so the other PC learns about them.
- The database rejects impossible data: a deadline due before it starts, unknown rule types, empty names,
  focus shorter than 1 minute.
- Raw app-activity intervals, the Google tokens (later) and calendar cache never leave this PC.

## Files changed or added

```
crates/focus-store/                    NEW
├── Cargo.toml
├── migrations/0001_initial.sql
└── src/  lib.rs  error.rs  ids.rs  clock.rs  migrations.rs  store.rs  presets.rs
apps/desktop/src-tauri/
├── Cargo.toml                         + focus-store dependency, version 0.2.0
├── tauri.conf.json                    version 0.2.0
└── src/
    ├── lib.rs                         opens the database at start-up; registers 2 new commands
    ├── state.rs                       NEW: holds the database or its error
    └── commands.rs                    + db_status, list_presets
apps/desktop/src/
├── App.tsx                            + "Local database" check, presets table, database file and PC ID
├── useCommand.ts                      NEW: loading / ready / error helper
├── ipc/database.ts                    NEW: typed calls for the two commands
└── styles.css                         + table styles
package.json                           `pnpm test` now also runs the Rust tests
scripts/build-release.sh               copies only the current version's installer
```

The Firefox extension did not change (only its version number).

## Install and test

1. Download `Focus-0.2.0-installer.zip`, extract it, run `Focus_0.2.0_x64-setup.exe`.
   It upgrades 0.1.0 in place; no need to uninstall. Close Focus first if it is open.
2. Open Focus.

**Expected:**

- Four green **OK** checks; the new one reads
  "Local database — Schema version 1, 24 tables, …KB".
- A table "Focus presets saved in the database" with:

  | Preset | Focus | Short break | Long break | Sessions |
  | --- | --- | --- | --- | --- |
  | Pomodoro | 25m | 5m | 15m | 4 |
  | Study | 50m | 10m | 20m | 4 |
  | Deep Work | 1h 30m | 20m | none | 2 |
  | Exam | 50m | 10m | none | 3 |

- "About this install" shows the database file, normally
  `C:\Users\<you>\AppData\Roaming\com.focus.desktop\focus.db`, and this PC's ID.

**Persistence test:** close Focus and open it again. The PC ID must be the same, and there must still be
exactly four presets.

If the database check shows **Failed**, send me the message it shows.

## Checks run before delivery

- 15 Rust tests pass: schema reaches version 1, reopening keeps the PC ID without duplicating presets,
  newer-schema refusal, bad data rejected, foreign keys checked at commit, note search works, clock ordering
  (including a PC clock set backwards), default presets.
- 6 TypeScript tests pass; typecheck clean; `cargo clippy` clean; extension lint clean.
- Installer cross-built for Windows; SQLite is built into `Focus.exe` (no extra DLLs).

## Next: Phase 4 (app shell and UI)

The real window layout: sidebar navigation, dashboard skeleton, tray icon and minimise-to-tray.
