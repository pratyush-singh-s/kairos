-- Schema version 8: to-do workspaces (0.15.0).
--   A space is either a week board like the main To-do page ('board') or a day-by-day plan
--   ('plan': Day 1, Day 2 ... with steps on each day). Tasks with no space are on the
--   "Everyday" board, so existing to-dos stay where they are.
--   start_date: the plan's Day 1 as a local date (YYYY-MM-DD); NULL = not dated yet.
--   days: how many days the plan has.
CREATE TABLE spaces (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL CHECK (length(trim(name)) > 0),
    kind       TEXT NOT NULL CHECK (kind IN ('board', 'plan')),
    color      TEXT CHECK (color IS NULL OR (length(color) = 7 AND color GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')),
    start_date TEXT,
    days       INTEGER NOT NULL DEFAULT 7 CHECK (days BETWEEN 1 AND 365),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    device_id  TEXT NOT NULL,
    deleted_at INTEGER
) STRICT;

--   space_id: the task's workspace; NULL = Everyday.
--   plan_day: in a plan, which day the step is on (1 = Day 1); NULL = not given a day yet.
ALTER TABLE tasks ADD COLUMN space_id TEXT REFERENCES spaces (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE tasks ADD COLUMN plan_day INTEGER CHECK (plan_day IS NULL OR plan_day BETWEEN 1 AND 365);
CREATE INDEX idx_tasks_space ON tasks (space_id);
