# Phase 13: Focus app turns on browser blocking (app 0.13.0, extension 0.10.0)

## What it does
- Start a focus session in the Focus app and Focus Blocker turns blocking on by itself: your sites and YouTube rules apply.
- Breaks, stopping the timer, finishing the run, or closing the app turn blocking off again.
- A paused focus phase keeps blocking on.
- The popup shows "Linked to the Focus app" (green dot) or "Focus app not found". While the app is in charge, the popup's Stop and Try buttons are hidden.
- "Try blocking for 2 minutes" still works when the app isn't in a focus phase.

## How the link works
The app answers on `http://127.0.0.1:47811/v1/focus`, which only this PC can reach. The extension asks, and each request waits up to 25 seconds for a change, so a new phase shows up at once.
Requests from web pages are refused, and the answer only says whether focus is on and when it ends.

The plan was Firefox "native messaging", but Zen 1.22 on Windows currently fails to start native helpers
(zen-browser/desktop issues 15123 and 15432), so this loopback link is used instead. It works in Firefox, Zen and other Firefox-based browsers, and needs no setup.

## Install
1. Unzip `Focus-0.13.0-installer.zip` and run the setup (upgrades in place).
2. Load `focus-blocker-0.10.0.zip` like before. Firefox/Zen may ask to allow "Access your data for 127.0.0.1". Allow it, because that's the link to the app.

## Under the hood
- `src-tauri/src/bridge.rs`: loopback HTTP server, long polling, origin check, 4 tests.
- `apps/extension/src/link.ts`: the loop that follows the app. The background page is now persistent so the link stays open.
