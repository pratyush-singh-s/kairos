-- Schema version 14: handwritten notes (0.21.34.B).
--   kind: 'text' (rich text, the editor's JSON document in `body`) or 'ink' (drawn with a pen on
--   a drawing board; `body` holds the strokes as JSON, see src/notes.rs). Notes made before
--   this version are all text.
ALTER TABLE notes ADD COLUMN kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'ink'));
