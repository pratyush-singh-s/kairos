# Focus 0.21.0: Sync between your devices (Phase 9)

## What's new

- **Sync page** (new, in the menu). You can pair your other PC now, and your phone once the Android app is ready. After that your
  to-dos, deadlines, notes, focus presets, blocking lists, history and look stay the same on every paired device.
  - The devices talk directly over your Wi-Fi. Everything is encrypted and nothing goes to a server.
  - Changes travel a few seconds after you make them, while Focus is open on both devices. They also sync once a
    minute, and whenever you press **Sync now**.
  - A bar shows each sync as it runs: how many changes are being sent or received, and how much data.
  - If the same note was changed on both devices before they synced, nothing is lost. The newer version wins, and the
    other version is kept as a note ending in "(conflict copy)".
  - These stay separate on each PC: Google sign-in and calendar settings, app tracking on/off, and the tray notice.
- **Full-screen pages.** The menu button (or Ctrl+B) now hides the menu completely, so the page you're on fills the
  window. To bring the menu back, swipe left to right with two fingers on the touchpad, swipe in from the left edge on
  a touch screen, or rest the mouse on the left edge. Picking a page, pressing Esc or clicking the page hides it again.
- **Terminal theme: bold is bold.** The theme's font is now built into Focus with its real bold, so bold words in notes
  stand out (they're also brighter).
- **YouTube tag groups.** On the Blocking page, drag one tag onto another to group them, for example #gaming and
  #sologaming under "Gaming". Click the group's name to rename it. Drag a tag onto a group to add it, or onto
  "No group" to take it out. Each tag also has a menu that does the same. Every tag is still blocked on its own, and
  the label covering a blocked video on YouTube's pages now names the group too.
- **Focus Blocker 0.13.0** for Firefox/Zen and Chrome. It keeps the tag groups and names them on the label that covers a blocked video.

## Install

1. Unzip **Focus-0.21.0-installer.zip** and run **Focus_0.21.0_x64-setup.exe**. It upgrades in place and keeps your data.
2. Install the same version on your other PC. Devices with different versions won't sync, and the Sync page tells you
   which one to update.
3. Optional: update Focus Blocker the same way as before (`focus-blocker-0.13.0.zip` for Zen/Firefox,
   `focus-blocker-chrome-0.13.0.zip` for Chrome).

## Pair two PCs (once)

1. Open Focus on both PCs, on the same Wi-Fi.
2. The first time, Windows may ask whether Focus can use the network. Click **Allow** (private networks).
3. On PC 1: **Sync → Show a code**. A 6-digit code appears. It works for 5 minutes.
4. On PC 2: **Sync**. PC 1 shows under "Pair with a device nearby". Click **Pair**, type the code, then press **Pair**.
   - If PC 1 isn't listed, type the address shown at the bottom of PC 1's Sync page (for example 192.168.1.20) in
     "Not listed? Type its address".
5. Both PCs now show each other under "Your devices", and the first sync starts straight away.

If it doesn't connect:

- Make sure Windows sees your Wi-Fi as a **Private** network: Settings → Network & internet → Wi-Fi → your network →
  Network profile type: Private. Windows blocks devices from finding each other on Public networks.
- If you clicked "Cancel" on the Windows network prompt, open "Allow an app through Windows Firewall", find Focus and
  tick **Private**.
- The clocks on both PCs should be set automatically. The Sync page warns you if they're more than 2 minutes apart.

## How it works (for the curious)

- Discovery: UDP port 47812 ("here I am" broadcasts and "who's there?" replies). Syncing: TCP port 47813.
- Pairing: the code goes through SPAKE2, which makes a strong key without the code ever crossing the network. That key
  locks a Noise handshake that swaps the two devices' long-term keys. A wrong code fails, and three wrong tries end the code.
- Each sync: a Noise XX handshake proves both devices hold the keys saved at pairing. Everything after that is encrypted
  with ChaCha20-Poly1305. A device that isn't paired is turned away.
- Merging: each change carries a clock stamp, and the latest change to each item wins. Deletions sync too.
- Code: `crates/focus-sync` (network) and `crates/focus-store/src/sync.rs` (what's sent and how it's merged), plus
  database migration 0011.
