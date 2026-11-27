# Focus 0.10.1: task colours

- Every task has a **small circle before its name**. Click it to pick a colour:
  - **Colour wheel**: click or drag; the slider under it sets brightness.
  - **Hex box**: type a colour such as `#4f8cff` (or `4f8cff`, `#48f`) and press Enter.
  - **Recent**: your last 5 colours, one click to reuse.
  - **Done** saves, **No colour** removes it, Esc closes without changing anything.
    Clicking away after changing the colour also saves it.
- The New task box has the same circle, so a task can get its colour as you add it (and in Edit).
- Colours show on the dashboard's Today's tasks too, and the circle works there.
- An empty circle (dashed) means no colour.

Install: quit Focus from the tray, extract `Focus-0.10.1-installer.zip`, run it. Upgrades in place; the
database moves to schema 3 (a colour per task). Extension unchanged (0.9.3).

Checks: new tests for colour checking, hex handling and the 5-colour recent list (all 109 tests pass).
Both themes checked in a browser preview.
