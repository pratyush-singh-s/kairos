-- Schema version 13: two more kinds of to-do space (0.21.27.B).
--   'free': a free board of lists with cards on them, moved around as you like.
--   'case': a case board: cards and sticky notes pinned anywhere, joined by coloured strings.
--   The old CHECK on spaces.kind only allowed 'board' and 'plan', and SQLite cannot change a
--   CHECK, so the table is rebuilt the way SQLite's docs describe: make the new table, copy,
--   drop the old one, rename. migrations.rs runs this one with foreign keys off, so tasks keep
--   pointing at "spaces".
CREATE TABLE spaces_13 (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL CHECK (length(trim(name)) > 0),
    kind       TEXT NOT NULL CHECK (kind IN ('board', 'plan', 'free', 'case')),
    color      TEXT CHECK (color IS NULL OR (length(color) = 7 AND color GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')),
    start_date TEXT,
    days       INTEGER NOT NULL DEFAULT 7 CHECK (days BETWEEN 1 AND 365),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    device_id  TEXT NOT NULL,
    deleted_at INTEGER
) STRICT;
INSERT INTO spaces_13 (id, name, kind, color, start_date, days, sort_order, created_at, updated_at, device_id, deleted_at)
    SELECT id, name, kind, color, start_date, days, sort_order, created_at, updated_at, device_id, deleted_at FROM spaces;
DROP TABLE spaces;
ALTER TABLE spaces_13 RENAME TO spaces;
CREATE TRIGGER sync_spaces_insert AFTER INSERT ON spaces BEGIN
    DELETE FROM sync_rowlog WHERE entity = 'spaces' AND row_id = new.id;
    INSERT INTO sync_rowlog (entity, row_id) VALUES ('spaces', new.id);
END;
CREATE TRIGGER sync_spaces_update AFTER UPDATE ON spaces BEGIN
    DELETE FROM sync_rowlog WHERE entity = 'spaces' AND row_id = new.id;
    INSERT INTO sync_rowlog (entity, row_id) VALUES ('spaces', new.id);
END;

-- Everything on a free board or a case board, one row per thing so each syncs on its own:
--   kind 'list' (a free board column), 'card' (on a list), 'pin' (a card on a case board),
--   'sticky' (a sticky note on a case board), 'string' (joins two pins or sticky notes).
--   data: the thing's fields as JSON (title, text, colour, position ...), see src/boards.rs.
CREATE TABLE board_items (
    id         TEXT PRIMARY KEY,
    space_id   TEXT NOT NULL REFERENCES spaces (id) DEFERRABLE INITIALLY DEFERRED,
    kind       TEXT NOT NULL CHECK (length(kind) > 0),
    data       TEXT NOT NULL CHECK (json_valid(data)),
    created_at INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    device_id  TEXT NOT NULL,
    deleted_at INTEGER
) STRICT;
CREATE INDEX idx_board_items_space ON board_items (space_id);

CREATE TRIGGER sync_board_items_insert AFTER INSERT ON board_items BEGIN
    DELETE FROM sync_rowlog WHERE entity = 'board_items' AND row_id = new.id;
    INSERT INTO sync_rowlog (entity, row_id) VALUES ('board_items', new.id);
END;
CREATE TRIGGER sync_board_items_update AFTER UPDATE ON board_items BEGIN
    DELETE FROM sync_rowlog WHERE entity = 'board_items' AND row_id = new.id;
    INSERT INTO sync_rowlog (entity, row_id) VALUES ('board_items', new.id);
END;
