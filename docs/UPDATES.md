# In-app updates

Kairos (Windows) checks for a newer version 8 s after it starts and every 3 hours, and from
Settings > App > Check for updates. If one exists it shows "Update available"; Update downloads the
signed installer, runs it with a progress bar only (/P /R) and Kairos reopens.

- Code: src-tauri/src/updates.rs (update_check, update_install), src/features/update/UpdatePopup.tsx.
- Server: plugins.updater.endpoints in tauri.conf.json -> GitHub Releases of the public
  kairos-updates repo: releases/latest/download/latest.json. KAIROS_UPDATE_URL at build time overrides it.
- Signing: plugins.updater.pubkey. The private key must be in TAURI_SIGNING_PRIVATE_KEY (+ empty
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD) when building, or the build fails (createUpdaterArtifacts).
  Losing the key means installed copies can never update again.

## Releasing
1. Build as usual (scripts/build-release.sh) with the updater key env loaded.
2. scripts/publish-update.sh "One short line: what's new"  (needs gh with push access to the repo)
latest.json "notes" = version label on the first line, then the what's-new text.
