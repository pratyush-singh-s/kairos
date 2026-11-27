# Blocking in a browser without the Focus app

Focus Blocker 0.14 (Firefox, Zen, Chrome, Edge, Brave) turns blocking on during focus and off on
breaks. It follows the first of these that is running a focus session:

1. **The Focus app on this PC** (links by itself, nothing to set up).
2. **The Focus phone app** (phone 0.24.12 or newer), once linked as below.
3. **Its own focus timer**, in the toolbar popup.

## The extension's own timer

Click the Focus Blocker button in the toolbar. Pick a ready-made length (25/5 × 4, 50/10 × 2,
90 min) or type focus minutes, break minutes and rounds, then **Start focus**.

- Sites on your list are blocked during focus, also while paused. Breaks are free.
- **Pause / Resume**, **Skip** (ends the current phase now) and **Stop** are in the popup.
- A notification tells you when focus ends, a break ends, and when all rounds are done.
- The timer keeps going if you close the browser; phases that ended meanwhile are skipped over.

## Linking the phone

The phone and the PC must be on the **same Wi-Fi**.

1. On the phone, open Focus, swipe right for the menu, open **Focus**, and tap **Show a code**
   under *Link a browser*. It shows an address (like `192.168.1.23`) and a 6-digit code (valid
   for 5 minutes, works once).
2. On the PC, open Focus Blocker's settings (popup > *Sites, YouTube and phone*). Under
   **Link your phone** type the address and the code, then **Link**. Allow the permission the
   browser asks for (it lets the extension talk to that one address).
3. The settings page then shows *linked at 192.168.1.23*.

Start focus on the phone's **Focus** page (or on your laptop, which the phone follows) and the
browser blocks too. The site lists come with it: they are your laptop's Blocking page lists, and
while linked they are shown read-only in the extension.

### Good to know

- **Same Wi-Fi only.** If the phone's address changes (new router, different network), unlink and
  link again with a new code.
- **When the phone sleeps** Android may pause Focus. A focus phase the phone already started
  keeps blocking in the browser until its planned end; the next round reaches the browser once the
  phone is awake again. Phone blocking (with apps chosen on the Blocking page) keeps Focus running
  in the background, which keeps the link going.
- **Not encrypted.** Only "is focus on, until when" and the site lists travel, guarded by a token
  only linked browsers have. Web pages can't read it. Use it on your home Wi-Fi, not public Wi-Fi.
- On the phone, **Unlink all** forgets every linked browser; in the extension, **Unlink**
  forgets the phone.
