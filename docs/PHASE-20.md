# Focus 0.19.0 + Focus Blocker 0.11.0: Statistics (Phase 20)

Install `Focus-0.19.0-installer.zip` over your current Focus. Everything else is kept.
Update the browser extension with `focus-blocker-0.11.0.zip` (same way as before) so it can count distractions.

## Statistics page

Open **Statistics** in the sidebar. Pick **Week**, **Month** or **Year** at the top, and use the arrows to go
back or forward (**This week / This month / This year** jumps back to now). Weeks start on Monday, like the
To-do board.

- **Focus time**: what the timer counted, pauses not included, and the average per day. Days before your
  first session don't pull the average down. Month and year also show your best day or month.
- **Sessions**: finished sessions, how many you stopped early, the share you finished, and the average length.
- **Active computer time**: time at the keyboard (2 minutes without input doesn't count), and how much of it
  was focus. Needs **App tracking** in Settings. "During focus sessions" only counts time in focus;
  "All the time" counts your whole day.
- **Streak**: days in a row with at least one finished session. Today doesn't break it until it's over.
- **Focus by day / by month**: a bar per day (or month). Blue is focus time, grey is active computer time.
  Hover a bar for the exact numbers.
- **When you focus**: weekdays down, hours across; the brighter the square, the more focus at that hour.
- **Top apps**: the programs you used most, with the blue part of each bar showing how much was during focus.
- **Distractions**: how many blocked pages or videos you opened during focus, how often you pressed
  **Continue anyway**, and which sites were hit most.

Focus time, active computer time and app time are three separate numbers on purpose: they measure
different things and aren't added together.

## What changed behind it

- App activity (which program was in front) is now kept for **a year** instead of 30 days, so the month
  and year views have it. It still stays on this PC only, and **Settings → Delete recorded activity** removes it.
- Focus Blocker 0.11.0 tells the Focus app when a blocked page opens and when you press Continue anyway.
  Only the site's name is sent (for example `youtube.com`), never the full address. It is counted only
  during a focus phase and only while the Focus app is running.

## Try it

| Try | Expected |
| --- | --- |
| Open Statistics | This week's numbers, your sessions in the chart |
| Month, then the left arrow | Last month |
| Year | One bar per month |
| Turn on App tracking, work for a few minutes | Active computer time and Top apps fill in |
| Start a focus session, open a blocked site in the browser | Distractions goes up by 1 and the site is listed |
| Wait out the countdown, press Continue anyway | "continued anyway once" |
| Ctrl + Shift + T | Terminal look: dotted bars and ░▒▓█ hour grid |

## Checks run before delivery

- Rust: storage tests (4 new for statistics), desktop tests (new: the extension's distraction report, web pages refused).
- TypeScript: 9 new tests for periods, averages, the hour grid and streaks (also in a time zone with clock changes);
  typecheck clean; extension lint clean.
- Statistics page checked in a preview, both themes, with sample data. Not tried on Windows or with the real
  extension yet: your test is the first.
