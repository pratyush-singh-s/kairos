-- Schema version 10: Google Calendar (Phase 19). Both tables are local caches of Google; the
-- other PC reads Google for itself, so nothing here is synced PC-to-PC.
--   calendar_sources: colour and access from Google's calendar list; is_focus marks the "Focus"
--                     calendar the app writes dated to-dos and deadlines into.
--   calendar_events:  location, description, link to the event in Google, and whether it is one
--                     time of a repeating event.
--   calendar_pushes:  what this PC last wrote to the Focus calendar for each to-do or deadline
--                     ("task:<id>" / "deadline:<id>"), so only changes are sent again.
ALTER TABLE calendar_sources ADD COLUMN color TEXT;
ALTER TABLE calendar_sources ADD COLUMN access_role TEXT NOT NULL DEFAULT 'reader';
ALTER TABLE calendar_sources ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1));
ALTER TABLE calendar_sources ADD COLUMN is_focus INTEGER NOT NULL DEFAULT 0 CHECK (is_focus IN (0, 1));
ALTER TABLE calendar_events ADD COLUMN location TEXT NOT NULL DEFAULT '';
ALTER TABLE calendar_events ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE calendar_events ADD COLUMN html_link TEXT;
ALTER TABLE calendar_events ADD COLUMN recurring INTEGER NOT NULL DEFAULT 0 CHECK (recurring IN (0, 1));
CREATE INDEX idx_calendar_events_end ON calendar_events (end_at);
CREATE INDEX idx_calendar_events_end_date ON calendar_events (end_date);

CREATE TABLE calendar_pushes (
    key       TEXT PRIMARY KEY,
    event_id  TEXT NOT NULL,
    hash      TEXT NOT NULL,
    pushed_at INTEGER NOT NULL
) STRICT;
