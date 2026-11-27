# Focus 0.12.0: To-do as a week board

The To-do page is now a week board, like your reference picture.

- **A column for each day**, Monday to Sunday. Today's column is underlined. Each column header shows the date
  and the total planned time for that day ("7h 30m"). Use the arrows to move a week back or forward, and
  **This week** to come back.
- **Tasks are cards** tinted with their colour. A card shows:
  - its time (◷ 09:30 – 10:30), if it has one
  - its name
  - a small **label** under the name (e.g. "Website")
  - how long it takes (1:30h)
  - tags such as ↻ Every day, High, or Overdue
- **Tick** the box in a card's corner. Repeating tasks can only be ticked in today's column.
- **Click a card** to edit it. You can set the time (start and end), the length (`45` or `1:30`), the
  label, the colour, the repeat, the priority and the day, or delete the card (with Undo).
- **+ Add task** at the bottom of a column adds a task on that day. **New task** at the top opens the full form.
- **Drag a card** to another day to move it, or into **No date** to unplan it. Repeating tasks stay on
  their days.
- **Unfinished tasks from earlier days move into today's column**, marked Overdue.
- **No date**, under the board, holds tasks without a day.
- **Clear done** deletes every ticked one-off task, with Undo.
- The dashboard's Today's tasks and the deadlines' checklists work as before.

Install: run the installer from `Focus-0.12.0-installer.zip`. It closes Focus by itself and upgrades in
place (database schema 5: a time, a length and a label for tasks). The extension is unchanged.

Checks: new tests for the week and day columns, the overdue roll-over, lengths, and checking times
(125 tests pass, plus typecheck). Both themes were checked in a preview.
