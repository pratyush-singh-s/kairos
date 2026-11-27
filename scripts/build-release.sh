#!/usr/bin/env bash
# Builds the Windows installer and the Firefox extension zip into release/<version>/.
# Runs on Linux (cross-compiles with MinGW) or on Windows with Rust + Node installed.
# Linux prerequisites: rustup target add x86_64-pc-windows-gnu; apt install nsis gcc-mingw-w64-x86-64 g++-mingw-w64-x86-64
set -euo pipefail
cd "$(dirname "$0")/.."

version=$(node -p "require('./apps/desktop/src-tauri/tauri.conf.json').version")
ext_version=$(node -p "require('./apps/extension/static/manifest.json').version")
# The version shown to you (e.g. 0.21.4.B); the installer itself keeps the semver above.
label=$(tr -d '[:space:]' < apps/desktop/src-tauri/RELEASE_LABEL)
out="release/$version"
mkdir -p "$out"

pnpm install --frozen-lockfile
pnpm test
pnpm typecheck

pnpm --filter @focus/extension build
pnpm --filter @focus/extension lint
(cd apps/extension && pnpm exec web-ext build --source-dir dist --artifacts-dir "../../$out" --filename "kairos-blocker-$ext_version.zip" --overwrite-dest)
# Chrome: a zip holding the folder to load with "Load unpacked", and the guide to adding it.
rm -rf "$out/kairos-blocker-chrome" && cp -r apps/extension/dist-chrome "$out/kairos-blocker-chrome"
(cd "$out" && rm -f "kairos-blocker-chrome-$ext_version.zip" && cp ../../docs/CHROME.md "HOW TO INSTALL.txt" && zip -qr "kairos-blocker-chrome-$ext_version.zip" "HOW TO INSTALL.txt" kairos-blocker-chrome && rm -rf kairos-blocker-chrome "HOW TO INSTALL.txt")

if [[ "$(uname -s)" == MINGW* || "$(uname -s)" == MSYS* || "${OS:-}" == "Windows_NT" ]]; then
  pnpm --filter @focus/desktop tauri build
  cp "apps/desktop/src-tauri/target/release/bundle/nsis/Kairos_${version}_x64-setup.exe"* "$out/"
else
  pnpm --filter @focus/desktop tauri build --target x86_64-pc-windows-gnu
  cp "apps/desktop/src-tauri/target/x86_64-pc-windows-gnu/release/bundle/nsis/Kairos_${version}_x64-setup.exe"* "$out/"
fi

# Installer files carry the label (Kairos_0.21.4.B_x64-setup.exe).
if [[ "$label" != "$version" ]]; then
  mv "$out/Kairos_${version}_x64-setup.exe" "$out/Kairos_${label}_x64-setup.exe"
  # The update signature (needs TAURI_SIGNING_PRIVATE_KEY, see docs/UPDATES.md) goes with it.
  if [[ -f "$out/Kairos_${version}_x64-setup.exe.sig" ]]; then mv "$out/Kairos_${version}_x64-setup.exe.sig" "$out/Kairos_${label}_x64-setup.exe.sig"; fi
fi

# The installer zip also carries the Google Calendar guide, so it is at hand on each PC.
(cd "$out" && rm -f "kairos_window-${label,,}.zip" && cp ../../docs/CONNECT-GOOGLE-CALENDAR.txt "HOW TO CONNECT GOOGLE CALENDAR.txt" \
  && zip -q "kairos_window-${label,,}.zip" "Kairos_${label}_x64-setup.exe" "HOW TO CONNECT GOOGLE CALENDAR.txt" "kairos-blocker-$ext_version.zip" "kairos-blocker-chrome-$ext_version.zip" && rm "HOW TO CONNECT GOOGLE CALENDAR.txt")

echo "Release files in $out:"
ls -lh "$out"
