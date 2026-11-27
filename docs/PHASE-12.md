# Phase 12: YouTube blocking, plus Blur by percent and terminal touches

## Fixes and changes in the Windows app

- **Blur by percent.** The Blur slider now goes from 0% to 100% in steps of 1, for each theme.
  Windows can't blur by an amount, so Focus does the blurring itself: it takes your desktop wallpaper, blurs
  it by exactly the amount you set, and lines it up with the real wallpaper so the window still looks
  see-through. It follows the window when you move it.
  - **0%** means no blur: whatever is behind Focus shows through sharp.
  - **Transparency** still sets how much of the blurred picture shows through.
  - **Use Windows' own blur instead** (a checkbox under each theme's sliders) switches to Windows' frosted
    blur of the *windows* behind Focus. That's the "Medium" one that worked for you. Its strength is fixed, so
    the Blur slider is turned off while it's ticked.
  - If Focus can't read your wallpaper (for example with a plain colour background), it
    uses Windows' own blur and says so in Settings.
  - Focus assumes the wallpaper is set to **Fill** (the Windows default). With Fit, Stretch, Tile or Span
    the picture may not line up exactly.
- **The bottom status bar is gone** from the Terminal theme.
- **Terminal touches** from your new references:
  - the panel under your mouse or cursor lights up green, like the focused pane in a TUI
  - the app-usage bars are segmented meters, like the audio mixer
  - group headings in Settings are coloured like table headings, and the chosen option gets a full-row
    highlight
  - sliders are a thin line with a small block
  - the mini timer's progress line is in blocks
  - I left out the bottom key-hint bar, since you asked to remove the bottom bar.

## YouTube blocking (Firefox extension)

There's a new **youtube** section in Focus Blocker's options. It's for when youtube.com itself is *not* on
your blocked sites list, so you can still use YouTube for what you need.

- **Block Shorts.** On by default. Opening a Short goes to the blocked page, and Shorts shelves and the Shorts
  tab are hidden from YouTube's pages during a session.
- **Channels.** Type `@name`, the channel's name, or paste any link to the channel. That channel's videos
  and its channel page are blocked.
- **Topics.** Words or phrases such as `minecraft` or `true crime`. A video whose title or tags contain one is
  blocked. Matching is by whole word, so `game` blocks "Game night" but not "endgame".
- **When something is blocked:** *Wait, then continue* (a countdown, 20 s by default) or *Full block*. One
  setting covers all of YouTube. Continuing lets you watch that one video for the rest of the session. The
  next one asks again.
- The blocked page says why: "Shorts", "a channel you blocked: @name", or "something you blocked: minecraft".
- **Allow on YouTube.** To see which video is playing, the extension needs permission to read YouTube pages.
  If Firefox didn't grant it at install, the options page shows an **Allow on YouTube** button. It only
  reads the title, channel and tags, and nothing leaves your browser. (Blocking Shorts and channel pages
  works without it.)

Tags come from YouTube's own page, so no Google sign-in is needed for this.

## Install and test

### Windows app
1. Right-click the Focus tray icon and choose **Quit Focus**.
2. Extract `Focus-0.9.0-installer.zip` and run `Focus_0.9.0_x64-setup.exe`. It upgrades in place.

| Try | Expected |
| --- | --- |
| Settings → Glass look → Blur at 5%, 24%, 99% | Your wallpaper behind Focus, from slightly to very soft |
| Drag the window around | The blurred wallpaper stays lined up with your real desktop |
| Blur at 0% | Sharp see-through, no blur |
| Tick "Use Windows' own blur instead" | The windows behind Focus are frosted; the Blur slider greys out |
| Terminal theme | No bottom bar; the panel under the mouse turns green; segmented app bars |

### Firefox extension
1. Extract `focus-blocker-0.9.0.zip` to a folder.
2. In Firefox open `about:debugging#/runtime/this-firefox`. If the old version is listed, click **Remove**.
   Then click **Load Temporary Add-on…** and pick `manifest.json` in that folder.
3. Open the options page. If you see **Allow on YouTube**, click it and accept.

| Try | Expected |
| --- | --- |
| Remove youtube.com from blocked sites; add a channel and a topic under youtube; Try blocking for 2 minutes | Badge shows ON |
| Open any Short | "Take a breath", reason "Shorts" |
| YouTube home page | No Shorts shelf, no Shorts tab |
| Open a video from the blocked channel, or with the topic in its title | Video pauses, the blocked page shows the reason |
| Open any other video | Plays normally |

## Making the extension permanent (needs you, about 5 minutes)

Firefox forgets temporary add-ons when it restarts. To keep Focus Blocker for good, Mozilla has to sign it.
That's free, and the extension stays private: it is *not* listed in the add-ons store.

1. Sign in, or create a free account, at <https://addons.mozilla.org/developers/>.
2. Click **Submit a New Add-on**, choose **On your own** (self-distribution), and upload
   `focus-blocker-0.9.0.zip` as it is.
3. Mozilla's automatic check usually signs it within minutes. Download the signed `.xpi` file it gives you.
4. Open that `.xpi` in Firefox (drag it onto a Firefox window) and click **Add**. Remove the temporary copy
   from `about:debugging` first.

Each later version needs the same upload, which can be done from that page's **Upload New Version**. You don't
need to share your account details with me.

## Checks run before delivery

- New YouTube rules (`packages/core/src/blocking/youtube.ts`): 12 tests covering channel and link
  clean-up, whole-word topics, Shorts and channel pages, channel and topic matching, and bad stored data.
- The YouTube page script was run against a simulated YouTube watch page. It blocks by topic, @handle and
  tag, lets other videos play, and does not block when the page still shows the previous video's channel.
- Rust and TypeScript tests pass, typecheck is clean, and `web-ext lint` gives 0 errors and 0 warnings.
- Previews rendered: Blur at 5%, 24% and 100% over a test wallpaper, the Settings sliders, the terminal panel
  highlight and meters, the extension options page, and the YouTube blocked pages.
- Not testable here: real YouTube in Firefox, and your real wallpaper on Windows. Your test is the first.
