-- Schema version 2: repeating to-dos (Phase 14).
--   repeat_days: weekdays the task comes back on, as bits (1 = Sunday, 2 = Monday ... 64 = Saturday);
--                0 = a one-off task, 127 = every day.
--   done_date:   the local date (YYYY-MM-DD) the task was last ticked. A repeating task counts as
--                done only on that date, so it is unticked again the next day it repeats.
ALTER TABLE tasks ADD COLUMN repeat_days INTEGER NOT NULL DEFAULT 0 CHECK (repeat_days BETWEEN 0 AND 127);
ALTER TABLE tasks ADD COLUMN done_date TEXT;
