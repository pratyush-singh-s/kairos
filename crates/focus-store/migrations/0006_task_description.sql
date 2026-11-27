-- Schema version 6: a to-do card can carry a free-text description (0.12.1).
ALTER TABLE tasks ADD COLUMN description TEXT NOT NULL DEFAULT '';
