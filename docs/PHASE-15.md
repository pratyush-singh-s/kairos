# Focus 0.11.0: Deadlines

## What's new
- **Deadlines page** (sidebar → Deadlines). **New deadline** asks for:
  - a name and an optional colour (the small circle) and notes
  - **Due**: a date, either at the end of that day or at a time you pick
  - **Starts**: now, or **Pick a start** for something that begins later
  - **Show**: Ring + day grid, Ring only, or Day grid only
- **The ring** shows how much of the time is left. It starts full and shrinks clockwise as time passes,
  with the time left in the middle (`5d 18h`). Before the start it's dashed, when overdue it turns into a
  dashed red outline, and when you mark the deadline finished it fills in green. Terminal draws it as 60 segments.
- **Countdown**: "8 days left", "4 days 12 hours", "31 hours left", "42 minutes left", then seconds in the
  last minute. Times always round down, and seconds only tick in the last minute.
- **State tag**, always an icon plus a word: ○ Starts 30 Oct, ● In progress, » Urgent (under 48 hours, or
  under 15% of the time left), ◷ Due today 17:00, ⚠ Overdue by 2h, ✓ Done.
- **Day grid**: one box per day from the start day to the due day. Past days are filled, today has an
  outline, and the due day has a ⚑. **Click a day to mark it done** (✓). That only changes the box; the
  ring always follows the clock. Hover a box for "Day 7 · 28 October · today · 5 days remaining". Arrow
  keys move between boxes. More than 2 weeks wraps into labelled weeks; over 120 days shows one box per week.
  Terminal draws `[■] [▣] [□]`.
- **Checklist**: each deadline has an "Add a step…" box for its own steps. These stay on the deadline and
  don't appear on the To-do page.
- **Mark finished / Reopen**, **Edit** (pencil), **Delete** (×) with Undo.
- **Dashboard → Upcoming deadlines**: each open deadline with a small ring and its countdown.

## Install
Run the installer from `Focus-0.11.0-installer.zip`. It closes Focus itself and upgrades in place
(database schema 4: a colour per deadline). The extension is unchanged (0.9.3).

| Try | Expected |
| --- | --- |
| New deadline "Project", due in 5 days | Ring nearly full, "5 days … " countdown, 6 day boxes with today outlined |
| Click today's box | It turns green with ✓; the ring doesn't change |
| Add steps under the deadline, tick one | "1 of 2 done" |
| Edit: due time 10 minutes from now | ◷ Due today, countdown in minutes, updates every 10 s |
| Mark finished | ✓ Done, moves to "Finished" at the bottom, leaves the dashboard |

## Checks
- 5 new storage tests (create/edit/finish/delete/undo, start-before-due rule, day marks, checklists stay
  off the To-do page, ordering) and 6 new countdown tests, including the design's worked example
  (22 Oct 18:00 → 2 Nov 23:59 at 28 Oct 12:00 = 12 day boxes, ring at 176°). 120 tests pass, plus typecheck.
- Both themes checked in a browser preview. Not testable here: the real Windows window.
