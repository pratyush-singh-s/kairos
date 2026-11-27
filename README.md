# Kairos

## About
Kairos is a focus app for Windows, with an Android phone app. It has a focus timer, stopwatch and countdown, and blocks distracting apps and websites during focus or on a schedule. It also has to-dos, deadlines, notes, a calendar and screen time stats.

Kairos is still being worked on, so new features and fixes come often.

## Download
- **Windows:** get the setup file from **Releases** on the right. The app updates itself after that.
- **Phone:** download the .apk from Releases and open it on your Android phone.

## Installing
The installer isn't code-signed yet, so Windows may show "Windows protected your PC". Click **More info**, then **Run anyway**.

## Source layout
- `apps/desktop`: Windows app (Tauri 2, Rust + React)
- `apps/extension`: browser extension
- `packages/core`: shared TypeScript code
- `crates/`: local database and device sync
