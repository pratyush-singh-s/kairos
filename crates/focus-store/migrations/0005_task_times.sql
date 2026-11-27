-- Schema version 5: to-dos on the week board can have a time and a length (Phase 15.1).
--   start_time / end_time: local "HH:MM" on the task's day; NULL = no time.
--   duration_min: planned minutes (also shown when there is no time).
--   The existing `category` column is the card's small label (e.g. "Website").
ALTER TABLE tasks ADD COLUMN start_time TEXT CHECK (start_time IS NULL OR start_time GLOB '[0-2][0-9]:[0-5][0-9]');
ALTER TABLE tasks ADD COLUMN end_time TEXT CHECK (end_time IS NULL OR end_time GLOB '[0-2][0-9]:[0-5][0-9]');
ALTER TABLE tasks ADD COLUMN duration_min INTEGER CHECK (duration_min IS NULL OR duration_min BETWEEN 1 AND 1440);
