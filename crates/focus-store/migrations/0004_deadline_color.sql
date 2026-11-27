-- Schema version 4: a colour per deadline, like tasks ("#rrggbb"; NULL = none).
ALTER TABLE deadlines ADD COLUMN color TEXT
    CHECK (color IS NULL OR (length(color) = 7 AND color GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'));
