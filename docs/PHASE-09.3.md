# Focus 0.21.4 + Focus Blocker 0.13.1: group # tags in the extension

Update Focus Blocker in each browser: `focus-blocker-0.13.1.zip` for Zen / Firefox (same way as before) and
`focus-blocker-chrome-0.13.1.zip` for Chrome, Edge or Brave. Install `Focus-0.21.4-installer.zip` over your
current Focus so grouping in the extension can save to the app.

## What was wrong

Tag groups only existed on the app's Blocking page. The extension's settings page listed every `#tag` in one
flat list with no way to group them, and while the app manages the lists the whole page was read-only.

## What's new

- The extension's settings page (Focus Blocker > Preferences / Options) now has a **Tags** section, grouped like
  the app: drag a tag onto another to make a group (named after the tag you dropped on, ready to rename), drag
  onto a group to add it, drag into **No group** to take it out. Each tag also has a menu (No group, a group,
  New group…). Rename a group by clicking its name; **Ungroup** keeps the tags blocked.
- While Focus is open and linked, grouping in the extension is saved in the app, which sends it to every
  browser (and to the Blocking page). Sites, channels and tags themselves are still added and removed in the app.
- If Focus is closed while it manages the lists, the tags are shown grouped with a note to open Focus.
- With app 0.21.3 or older the extension says to update the app.
- Fixed: the "Allow on YouTube" notice showed on the settings page even when access was already granted.

## Try it

| Try | Expected |
| --- | --- |
| Focus open, extension settings, drag #sologaming onto #gaming | Group "gaming" appears with both, name selected; type Gaming, Enter |
| Look at Focus > Blocking | Same Gaming group within a second or two |
| Tag menu > No group | Tag moves to No group in the extension and the app |
| Close Focus, open extension settings | Groups shown, menus greyed, "Open the Focus app…" note |
