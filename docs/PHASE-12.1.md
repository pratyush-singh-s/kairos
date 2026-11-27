# Focus 0.9.1: one block box, Go back, YouTube covers, real transparency

## Windows app
- **Real see-through transparency.** The wallpaper trick is gone. The window is now truly transparent, so
  you see the programs open behind Focus.
  - **Transparency** (0–100%) sets how much shows through. 0% is solid.
  - **Blur the windows behind Focus** (a checkbox per theme) frosts what's behind, using Windows' own blur.
    It's off by default, so what's behind is sharp. Windows' blur has a fixed strength, so the percent Blur
    slider is removed.

## Firefox extension
- **One box for everything you block on YouTube** (Options → youtube → What to block):
  - `@name`, or a link to a channel, blocks that **channel**
  - `#name` blocks a **tag**: the video's own tags, or a #hashtag in its title
  - anything else, such as `minecraft`, blocks videos with that **word or phrase** in the title or tags
  - while you type, a line under the box says which of the three it will block
  - the list shows each entry with its kind: [channel], [tag] or [phrase]
- **Blocked videos on YouTube's pages** (home, search, Up next, channel pages). Pick one:
  - **Cover the thumbnail and show what matched**: a dark cover with a box saying `minecraft`, `#gaming` or
    `@mrbeast`. Clicking the cover does nothing.
  - **Remove them from the page**: the video disappears from the list.
  - This works from the title and channel. A video's tags only show once you open it, and opening it still
    leads to the blocked page.
- **Go back instead of Close this tab.** The blocked page's main button returns you to the last page in that
  tab that isn't blocked. If the tab was opened just for the blocked page, it closes and takes you back to
  the tab you were on before.

## Install
- **App:** quit Focus from the tray, extract `Focus-0.9.1-installer.zip`, and run the installer. It upgrades in place.
- **Extension:** in `about:debugging#/runtime/this-firefox`, remove the old Focus Blocker. Then use
  **Load Temporary Add-on…** and pick `manifest.json` from the extracted `focus-blocker-0.9.1.zip`. To keep it
  after Firefox restarts, follow "Making the extension permanent" in PHASE-12.md.

| Try | Expected |
| --- | --- |
| Settings → Transparency 70%, Blur unticked | Your other windows are visible, sharp, behind Focus |
| Tick Blur | The same windows, frosted |
| Extension: type `@mrbeast`, `#gaming`, `minecraft` | Each is listed as channel, tag, phrase |
| Try blocking, open YouTube home | Matching videos covered (or gone, with "Remove") |
| Open a blocked video, then Go back | Back on the page you came from |

## Checks
- New tests for the box (telling channels, tags and phrases apart; no duplicates) and for tag matching. That's
  32 shared-rule tests in all, and they pass. Rust tests, typecheck and `web-ext lint` (0 warnings) also pass.
- Covers and removal were tested on a simulated YouTube home page, including a tile that YouTube reuses for
  a different video.
- Not testable here: real YouTube and the real Windows window. Your test is the first.
