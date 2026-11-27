# Focus Blocker for Chrome (also Edge and Brave)

The same extension as the Firefox one: blocked sites, YouTube Shorts / channels / tags / phrases, the link to
the Focus app, and distraction counts for Statistics. Built for Chrome's Manifest V3.

## Add it (once)

Chrome only installs extensions from its store, except in **Developer mode** from a folder. That is fine for
your own extension.

1. Extract `focus-blocker-chrome-<version>.zip`. You get a folder called `focus-blocker-chrome`.
2. Move that folder somewhere it can stay, for example `Documents\Focus\focus-blocker-chrome`.
   Chrome loads the extension from this folder every time it starts, so **don't delete or move it later**.
3. In Chrome, open `chrome://extensions` (type it in the address bar).
4. Turn on **Developer mode** (switch at the top right).
5. Press **Load unpacked** and choose the `focus-blocker-chrome` folder (the one with `manifest.json` inside).
6. Click the puzzle-piece icon in the toolbar and pin **Focus Blocker**, so its ON badge is visible.
7. Open the extension's **Options** (right-click its icon → Options) and add your sites and YouTube choices.
   Chrome keeps its own list, separate from Firefox / Zen.

Edge: `edge://extensions`, **Developer mode** at the left, then **Load unpacked**. Brave: `brave://extensions`.

## Update it later

1. Extract the new zip and copy its files **over** the old folder (replace everything).
2. Open `chrome://extensions` and press the **reload** arrow on Focus Blocker. Your lists are kept.

## Check it works

- With the Focus app running, the extension's popup says **Linked to the Focus app**.
- Start a focus session in the app: the icon shows **ON**, and a site on your list shows the blocked page.
