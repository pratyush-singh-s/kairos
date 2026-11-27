# Focus 0.18.0: Google Calendar (Phase 19)

Install `Focus-0.18.0-installer.zip` over your current Focus. Everything else is kept.

## Connect it (once)

1. Open **Calendar** in the sidebar (or **Settings → Google account**) and press **Connect Google Calendar**.
2. Google's page opens. If it says **Google hasn't verified this app**, press **Continue**: the app is your own.
3. **Tick every box** Google shows (see and edit events, see your calendars, see your settings, make calendars), then **Continue**.

Before that, it is worth doing the optional step in `GOOGLE-SETUP.md` (step 3, **Publish app**). While the
Google app is in "Testing", Google ends Calendar access after 7 days and you would have to press Reconnect
every week.

## Calendar page

- A month of your calendars, starting the week on the day you chose in Google Calendar. Today is marked;
  click a day to see its events on the right.
- **Add event** (or double-click a day) adds an event to one of your own calendars: name, day, times or
  all day, place and notes. Click an event to change or delete it. Ending before it starts (22:00 to 01:00)
  means it ends the next day.
- Holidays and calendars shared with you to look at only open as details, not as a form.
- **Sync now** fetches changes straight away; otherwise Focus checks Google every 5 minutes and soon after
  you change a to-do or deadline.
- If Google stops accepting the sign-in, a **Reconnect** bar appears; your events stay visible meanwhile.

## Your to-dos and deadlines in Google Calendar

Focus makes a calendar called **Focus** in your Google account and keeps it in step with:

- to-dos with a date (all day, or at their time if they have one),
- repeating to-dos (as a weekly repeating event),
- steps of a day-by-day plan that has a start date,
- deadlines ("Due: Physics essay"; ✓ in front once completed).

Ticked to-dos get a ✓. Deleted ones disappear from Google. These events have no Google reminders. They are
changed from Focus, not in Google: change them on the To-do or Deadlines page. Both PCs can do this at the
same time without making doubles.

Turn it off in **Settings → Google account → Put dated to-dos… in a "Focus" calendar**; Focus then removes
the events it made.

## Settings → Google account

- Which calendars show in Focus (your own, Focus, holidays, shared ones).
- Sync status, **Sync now**, and how many to-dos are not yet in Google (e.g. while offline).
- To add holidays: in Google Calendar, **Other calendars → + → Browse calendars of interest → Holidays**.

## Dashboard

A new **Today's calendar** card lists today's events and holidays (your to-dos stay in Today's tasks).
