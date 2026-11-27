# Focus 0.10.0: To-do list

## What's new
- **To-do page** (sidebar → To-do). Type a task such as `gym` and press Enter or **Add**.
  - **Repeat**: Doesn't repeat, Every day, Weekdays, Weekends, or **Pick days…** (for example Mon, Wed, Fri).
    A repeating task comes back unticked on each of its days, so `gym` every day is a fresh [ ] each morning.
  - **Due**: No date, Today, Tomorrow, or **Pick a date…** (only for tasks that don't repeat).
  - **Priority**: High, Normal or Low. High tasks sit at the top and carry a red **High** tag.
- The page has three sections:
  - **Today**: what's due today, anything overdue (marked **Overdue** in red), tasks with no date, and
    repeating tasks for today. A bar shows how many are done ("2 of 6 done").
  - **Upcoming**: tasks with a later date, and repeating tasks whose next day isn't today.
  - **Done**: one-off tasks you ticked on earlier days. **Clear done** removes them.
- **Edit** (pencil) changes a task in place. **Delete** (×) removes it, with **Undo** for 8 seconds.
  Clear done can be undone the same way.
- **Dashboard → Today's tasks** now has working tick boxes, an **Add for today…** box, and an
  **All tasks** link to the To-do page.

## Install
Quit Focus from the tray, extract `Focus-0.10.0-installer.zip`, and run the installer. It upgrades in
place and keeps your data. Your database is upgraded automatically (schema 2: repeat days for tasks).
The Firefox extension is unchanged (stay on 0.9.3).

| Try | Expected |
| --- | --- |
| To-do: add `gym`, Repeat = Every day | Listed under Today with a ↻ Every day tag |
| Tick gym | Struck through, bar moves; tomorrow it is unticked again |
| Add `dentist`, Due = Pick a date (next week) | Listed under Upcoming with the date |
| Delete a task, then Undo | It comes back |
| Dashboard: type in "Add for today…" and press Enter | It appears in Today's tasks, and on the To-do page |
| Switch to Terminal theme | Tasks show as `[ ]` / `[x]` with bracketed tags |

## Checks
- 8 new storage tests (repeating tasks untick the next day, weekday repeats, today's list, clear done and
  undo, upgrading an older database) and 5 new list tests. 106 tests in all pass, plus typecheck.
- Both themes checked in a browser preview with sample tasks. Not testable here: the real Windows window.
