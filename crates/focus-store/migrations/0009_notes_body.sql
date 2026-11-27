-- Schema version 9: notes (Phase 18).
--   body:      the note's rich text as the editor's JSON document ("" = empty note). The `ydoc`
--              column stays for PC-to-PC merging, which arrives with sync.
--   edited_at: when the note was last changed (UTC ms), for sorting and "Edited 5 min ago".
ALTER TABLE notes ADD COLUMN body TEXT NOT NULL DEFAULT '';
ALTER TABLE notes ADD COLUMN edited_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_notes_edited ON notes (edited_at);
