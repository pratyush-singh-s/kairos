# Focus 0.20.0 + Focus Blocker 0.12.0: Blocking page in the app (Phase 12)

Install `Focus-0.20.0-installer.zip` over your current Focus, then update Focus Blocker in each browser:
`focus-blocker-0.12.0.zip` for Zen / Firefox (same way as before) and `focus-blocker-chrome-0.12.0.zip` for
Chrome, Edge or Brave (copy over the old folder, then press reload on `chrome://extensions`).

## What's new

- **Blocking** in the sidebar is no longer "Soon". It holds everything your browsers block during focus:
  - **Blocked sites**: add a site, pick **Wait, then continue** (a countdown) or **Full block**, and the
    countdown length. Suggestions for common sites. Change or remove any site in the list.
  - **YouTube**: block Shorts; one box for channels (`@name` or a channel link), tags (`#name`) and phrases;
    covered or removed videos on YouTube's pages; and how YouTube blocks behave (countdown or full block).
  - **Browsers**: whether a browser with Focus Blocker is connected, and the countdown for new "Wait" sites.
- **Every browser follows the app.** Changes reach Zen and Chrome at once. If Focus is closed, each browser
  keeps the last lists it got.
- **Your current lists move over by themselves.** The first time a browser with its own lists links to Focus
  0.20, the app takes those lists (only while the app has none of its own). After that the app's list wins.
- The extension's options page now shows the lists read-only, with a note to change them in the app. Its theme
  follows the app's theme.
- The dashboard card is now called **Browser blocking**.

## Try it

| Try | Expected |
| --- | --- |
| Install both, open Focus with Zen running | Blocking page shows your Zen sites and YouTube choices |
| Add `x.com` as Full block | Zen's Focus Blocker options list x.com within a second or two |
| Start a focus session, open x.com | Blocked page, no Continue button |
| Chrome with Focus Blocker 0.12 | Same lists as Zen |
| Switch Focus to Terminal (Ctrl + Shift + T) | The browser's blocked page uses the Terminal look too |

## Checks run before delivery

- Rust: storage tests (lists saved, handed over only once, bad shapes refused) and link tests (lists go out,
  same lists don't wake browsers again, hand-over accepted once, bad or huge bodies refused).
- TypeScript: list cleaning tests; typecheck clean; extension lint clean.
- Chrome build tested in Chromium against a stand-in for the app: it handed over its list, received the app's
  lists and theme, and showed the read-only note. Blocking page checked in a preview, both themes.
- Not tried on Windows or in Zen yet: your test is the first.
