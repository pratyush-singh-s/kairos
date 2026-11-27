# Focus for Android 0.24.0 (with Focus for Windows 0.21.12.B)

## New in 0.24.0

- **Files in notes.** Paperclip in an open note: pick files (zip, PDF, slides, anything) with Android's picker. Tap a
  file to open it in an app on the phone; the arrow saves a copy (Downloads, Drive …). Files sync with the laptop over
  Wi-Fi, with progress on Link to PC. Needs Focus 0.21.12.B on the laptop. Details in ATTACHMENTS.md.

## New in 0.23.0

- **Syncs while the app is closed.** About every 15 minutes on Wi-Fi (and soon after the phone joins Wi-Fi), the phone
  wakes up for a few seconds, finds the laptop, syncs both ways and goes back to sleep. The laptop needs Focus open.
  Open the app once after installing to start it.
- Some phones (Realme, Oppo, Xiaomi, Vivo, OnePlus) stop apps from working in the background. If changes only arrive
  when you open Focus: Settings → Apps → Focus → Battery → **Allow background activity** (or "No restrictions").

## New in 0.22.2

- Custom colours use a colour wheel: tap Background, Accent, Done, Numbers or Text, then drag on the wheel
  (brightness slider and hex code below it). The app changes colour as you drag.
- Fixed: the New note / New deadline button touched the box under it; the notes list is no longer cut short.

## New in 0.22.1

- **Colours** (in the menu): pick a Glass palette or make Custom colours for the phone. They stay on the phone; the laptop
  keeps its own look. "Use the laptop's colours" goes back to following the laptop.

## New in 0.22.0

- **Dashboard** (the page the app opens on): New note in one tap, today's tasks with tick boxes and "Add for today",
  upcoming deadlines, today's calendar, pinned notes.
- **Calendar**: your Google Calendar as Focus on the laptop last read it (a month with a dot per event, the day's list,
  tap an event for its details). Read-only on the phone: add or change Google events on the laptop. A dated to-do or a
  deadline added on the phone goes into Google Calendar through the laptop.
- Needs **Focus 0.21.3 on the laptop** (`Focus-0.21.3-installer.zip`): it copies the calendar to the phone with each sync.
  Older laptops still sync notes, to-dos and deadlines; the phone's Calendar then explains what to update.


The phone app holds what you jot down on the go: **Notes** (with text colours), **Deadlines** and **To-do**.
Everything you add on the phone shows up in Focus on your laptop, and the other way round.
It uses the Glass theme only. It has no focus timer, History or Statistics; those stay on the PC.

## Install

1. Download `Focus-android-0.23.0.zip` on the phone and open it (Files app), or copy `Focus-0.23.0.apk` to the phone.
2. Tap `Focus-0.23.0.apk`. Android asks to allow installs from that app (Files or Chrome): tap **Settings**, turn on
   **Allow from this source**, go back and tap **Install**.
3. If Play Protect warns about an unknown app, tap **More details → Install anyway**. It warns because the app isn't from the Play Store.

Newer phone builds install over this one and keep your data, because they're signed with the same key.

## Link it to your laptop (once)

Both need to be on the same Wi-Fi, and the laptop needs Focus **0.21.0 or newer** (`phase-09/` or `phase-09.1/`).

1. On the laptop: open Focus → **Sync** → **Show a code**. A 6-digit code appears for a few minutes.
2. On the phone: open Focus, swipe right (or tap ☰) → **Link to PC**. Your laptop appears under
   **Pair with a device nearby**: tap **Pair**, type the code, tap **Pair** again.
   If the laptop isn't listed, type the laptop's address under **Not listed?**: it's on the laptop's Sync page under
   **This device** (like `192.168.1.20`).
3. Windows may ask whether Focus can use the network: allow **Private networks**.

The top bar then says **"<laptop> nearby"** whenever the laptop is on the same Wi-Fi with Focus open.

## Everyday use

- Swipe right anywhere on a page (or tap ☰) to open the menu; swipe left or tap beside it to close.
- Back closes the menu, then the open note, then returns to the Dashboard.
- Not on the same Wi-Fi? Nothing is lost: it syncs the next time they are. To sync sooner, turn on the phone's hotspot
  and connect the laptop to it.
- Changes travel within a few seconds while both apps are open, and every 15 minutes or so while the phone app is closed. Anything added while the laptop is off
  syncs the next time both are open on the same Wi-Fi (opening the phone app syncs straight away).
- To-do shows the week's days one under another, starting at today. Tap a card to edit it; change its date to move it.
- Rename the phone under **Link to PC → This device**.

## Build notes

- Source: `apps/mobile` (React shell + `src-tauri` Rust side). Pages are the PC's own `apps/desktop/src/features/*`.
- Needs Android SDK (platform 37, build-tools, NDK 28), JDK 21, Rust targets `aarch64-linux-android armv7-linux-androideabi`.
- `FOCUS_KEYSTORE=/path/keystore.properties pnpm --filter @focus/mobile tauri android build --apk --target aarch64 --target armv7`
- The release key is in the project files under `focus/android-signing/`. Keep it: a different key can't update the installed app.
