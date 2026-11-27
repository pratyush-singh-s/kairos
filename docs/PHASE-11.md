# Phase 11: Firefox extension (Focus Blocker), plus Blur and Settings-icon fixes

## Fixes from your last test

- **Blur slider now really changes the blur.** Windows doesn't offer a blur *strength*, only a few kinds of
  backdrop, so the slider now has four steps that each look different:
  **Off** (sharp, see-through) · **Light** (light blur of the windows behind) · **Medium** (frosted, Windows
  Acrylic) · **Strong** (only your wallpaper, very soft, Windows Mica). The name of each step and what it does
  are shown under the slider. Transparency still works as before. Your old values carry over
  (Glass was 60 → Medium, Terminal 40 → Light).
- **Settings icon** is now a cog instead of the sun-like shape.

## The Firefox extension

- **Blocked sites list** (right-click the toolbar icon → Manage extension → Options, or "Manage sites" in the
  popup). Add sites by typing or pasting any address (`https://www.youtube.com/watch?v=…` becomes
  `youtube.com`), or click a suggestion. Each site covers its subdomains.
- **Two ways to block, per site:**
  - **Wait, then continue**: a calm "Take a breath" page with a countdown (20 s by default, 3–600 s, set per
    site). The countdown only runs while you're looking at that tab. Then **Continue** lets you in for the rest of
    the session.
  - **Full block**: no way through until the session ends.
- **Toolbar popup**: shows whether blocking is on and how long is left, and lets you put the current site on
  the list with one click (Wait / Full block / Remove).
- **Badge**: `ON` while blocking; nothing when off.
- **Try blocking for 2 minutes**: until the extension is linked to the Windows app (Phase 13), this is how you
  turn blocking on to test it. Tabs already open on a listed site are caught too.
- **Same looks as the app**: Glass or Terminal (Options → Look).
- Nothing leaves your PC; the list is stored in Firefox.

YouTube-specific blocking (channels, tags, Shorts) is Phase 12, and starting blocking automatically from the
Windows app is Phase 13.

## Install and test

### Windows app
1. Right-click the Focus tray icon → **Quit Focus**.
2. Extract `Focus-0.8.0-installer.zip` and run `Focus_0.8.0_x64-setup.exe`.

| Try | Expected |
| --- | --- |
| Settings → Glass look → Blur: Off, Light, Medium, Strong | Four clearly different backgrounds |
| Sidebar | Settings shows a cog |

### Firefox extension (temporary install for now)
1. Extract `focus-blocker-0.8.0.zip` to a folder.
2. In Firefox open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick `manifest.json`
   in that folder. (If the old version is there, click **Remove** on it first.)
3. Pin Focus Blocker from the puzzle-piece menu.

Firefox forgets temporary add-ons when it restarts. A permanent install needs Mozilla to sign the extension;
that needs a free Mozilla add-ons account, and we'll do it in Phase 12.

| Try | Expected |
| --- | --- |
| Popup → Manage sites → add `youtube.com` (Wait 20 s) and `instagram.com` (Full block) | Both listed |
| Popup → Try blocking for 2 minutes | Badge shows ON; popup shows the time left |
| Open youtube.com | "Take a breath" page counting down 20 s; switching tabs pauses it; then Continue opens YouTube |
| Open instagram.com | "Blocked during focus", no Continue |
| Wait 2 minutes | Badge clears; sites open normally |
| Options → Look → Terminal | Pages switch to the Terminal look |

## Checks run before delivery

- Shared blocking rules (`packages/core/src/blocking/rules.ts`): 6 new tests (address cleanup, subdomains,
  most specific rule wins, wait limits).
- Rust and TypeScript tests pass; typecheck clean; `web-ext lint`: 0 errors, 0 warnings.
- Popup, options and blocked pages rendered in both themes; desktop Settings rendered with the new Blur steps.
- Not testable here: Firefox itself and the Windows blur kinds. Your test is the first.
