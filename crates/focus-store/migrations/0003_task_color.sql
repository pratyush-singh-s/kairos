-- Schema version 3: a colour per to-do (the dot before its name), as lowercase "#rrggbb"; NULL = none.
ALTER TABLE tasks ADD COLUMN color TEXT
    CHECK (color IS NULL OR (length(color) = 7 AND color GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'));
