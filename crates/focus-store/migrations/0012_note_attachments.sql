-- Schema version 12: files attached to notes (zip, pdf, pptx, anything).
--   The row (name, size, SHA-256) syncs like any other row. The file itself is kept once per
--   content, named by its SHA-256, in the "attachments" folder next to the database, and is
--   sent to the other devices after the rows (see focus-sync).
CREATE TABLE note_attachments (
    id         TEXT PRIMARY KEY,
    note_id    TEXT NOT NULL REFERENCES notes (id) DEFERRABLE INITIALLY DEFERRED,
    name       TEXT NOT NULL CHECK (length(trim(name)) > 0),
    mime       TEXT NOT NULL DEFAULT '',
    size       INTEGER NOT NULL CHECK (size >= 0),
    sha256     TEXT NOT NULL CHECK (length(sha256) = 64),
    created_at INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    device_id  TEXT NOT NULL,
    deleted_at INTEGER
) STRICT;
CREATE INDEX idx_note_attachments_note ON note_attachments (note_id);
CREATE INDEX idx_note_attachments_sha ON note_attachments (sha256);

CREATE TRIGGER sync_note_attachments_insert AFTER INSERT ON note_attachments BEGIN
    DELETE FROM sync_rowlog WHERE entity = 'note_attachments' AND row_id = new.id;
    INSERT INTO sync_rowlog (entity, row_id) VALUES ('note_attachments', new.id);
END;
CREATE TRIGGER sync_note_attachments_update AFTER UPDATE ON note_attachments BEGIN
    DELETE FROM sync_rowlog WHERE entity = 'note_attachments' AND row_id = new.id;
    INSERT INTO sync_rowlog (entity, row_id) VALUES ('note_attachments', new.id);
END;
