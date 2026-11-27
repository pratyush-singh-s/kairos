#!/usr/bin/env bash
# Publishes a built release as an in-app update: every installed Kairos then shows "Update available".
# Usage: scripts/publish-update.sh "What's new, one short line"
# Needs: scripts/build-release.sh run first WITH the updater key (installer .sig present),
#        gh signed in with push access to $KAIROS_UPDATES_REPO (default below). See docs/UPDATES.md.
set -euo pipefail
cd "$(dirname "$0")/.."

repo="${KAIROS_UPDATES_REPO:-pratyush-singh-s/kairos}"
notes="${1:-}"
version=$(node -p "require('./apps/desktop/src-tauri/tauri.conf.json').version")
label=$(tr -d '[:space:]' < apps/desktop/src-tauri/RELEASE_LABEL)
out="release/$version"
exe="Kairos_${label}_x64-setup.exe"
[[ -f "$out/$exe" && -f "$out/$exe.sig" ]] || { echo "Missing $out/$exe or its .sig (build with the updater key)"; exit 1; }

tag="v$version"
url="https://github.com/$repo/releases/download/$tag/$exe"
NOTES="$label"$'\n'"$notes" SIG="$(cat "$out/$exe.sig")" URL="$url" VERSION="$version" node -e '
  const j = { version: process.env.VERSION, notes: process.env.NOTES, pub_date: new Date().toISOString(),
    platforms: { "windows-x86_64": { signature: process.env.SIG, url: process.env.URL } } };
  require("fs").writeFileSync(process.argv[1], JSON.stringify(j, null, 2));' "$out/latest.json"

gh release create "$tag" --repo "$repo" --title "Kairos $label" --notes "$notes" --latest \
  "$out/$exe" "$out/latest.json" "$out/kairos_window-${label,,}.zip"
echo "Published $label: https://github.com/$repo/releases/tag/$tag"
