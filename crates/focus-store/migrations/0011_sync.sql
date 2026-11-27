-- Schema version 11: syncing with your other devices (Phase 9).
--   sync_rowlog: one line per synced row, renumbered (seq) every time the row is written, here or
--                by a sync. A device asks "everything after seq N", so changes also pass on
--                between three devices (PC, PC, phone). Filled by the triggers below; local only.
--   sync_alias:  when a device sends a row that is the same thing as one here under another ID
--                (the same program in `apps`, a tag with the same name ...), its ID is mapped to
--                ours, and rows that point at it are pointed at ours.
--   peers:       devices paired with this one. received_upto = the other device's seq we have.
--   The triggers delete then insert: INSERT OR REPLACE inside a trigger is overruled by an
--   outer upsert's conflict handling.
CREATE TABLE sync_rowlog (
    seq    INTEGER PRIMARY KEY AUTOINCREMENT,
    entity TEXT NOT NULL,
    row_id TEXT NOT NULL,
    UNIQUE (entity, row_id)
) STRICT;

CREATE TABLE sync_alias (
    entity    TEXT NOT NULL,
    remote_id TEXT NOT NULL,
    local_id  TEXT NOT NULL,
    PRIMARY KEY (entity, remote_id)
) STRICT;

ALTER TABLE peers ADD COLUMN received_upto INTEGER NOT NULL DEFAULT 0;
ALTER TABLE peers ADD COLUMN address TEXT;
ALTER TABLE peers ADD COLUMN kind TEXT NOT NULL DEFAULT 'pc';


INSERT INTO sync_rowlog (entity, row_id) SELECT 'settings', key FROM settings ORDER BY updated_at;
CREATE TRIGGER sync_settings_insert AFTER INSERT ON settings BEGIN
    DELETE FROM sync_rowlog WHERE entity = 'settings' AND row_id = new.key;
    INSERT INTO sync_rowlog (entity, row_id) VALUES ('settings', new.key);
END;
CREATE TRIGGER sync_settings_update AFTER UPDATE ON settings BEGIN
    DELETE FROM sync_rowlog WHERE entity = 'settings' AND row_id = new.key;
    INSERT INTO sync_rowlog (entity, row_id) VALUES ('settings', new.key);
END;

INSERT INTO sync_rowlog (entity, row_id) SELECT 'blocking_profiles', id FROM blocking_profiles ORDER BY updated_at;
CREATE TRIGGER sync_blocking_profiles_insert AFTER INSERT ON blocking_profiles BEGIN
    DELETE FROM sync_rowlog WHERE entity = 'blocking_profiles' AND row_id = new.id;
    INSERT INTO sync_rowlog (entity, row_id) VALUES ('blocking_profiles', new.id);
END;
CREATE TRIGGER sync_blocking_profiles_update AFTER UPDATE ON blocking_profiles BEGIN
    DELETE FROM sync_rowlog WHERE entity = 'blocking_profiles' AND row_id = new.id;
    INSERT INTO sync_rowlog (entity, row_id) VALUES ('blocking_profiles', new.id);
END;

INSERT INTO sync_rowlog (entity, row_id) SELECT 'blocking_rules', id FROM blocking_rules ORDER BY updated_at;
CREATE TRIGGER sync_blocking_rules_insert AFTER INSERT ON blocking_rules BEGIN
    DELETE FROM sync_rowlog WHERE entity = 'blocking_rules' AND row_id = new.id;
    INSERT INTO sync_rowlog (entity, row_id) VALUES ('blocking_rules', new.id);
END;
CREATE TRIGGER sync_blocking_rules_update AFTER UPDATE ON blocking_rules BEGIN
    DELETE FROM sync_rowlog WHERE entity = 'blocking_rules' AND row_id = new.id;
    INSERT INTO sync_rowlog (entity, row_id) VALUES ('blocking_rules', new.id);
END;

INSERT INTO sync_rowlog (entity, row_id) SELECT 'focus_presets', id FROM focus_presets ORDER BY updated_at;
CREATE TRIGGER sync_focus_presets_insert AFTER INSERT ON focus_presets BEGIN
    DELETE FROM sync_rowlog WHERE entity = 'focus_presets' AND row_id = new.id;
    INSERT INTO sync_rowlog (entity, row_id) VALUES ('focus_presets', new.id);
END;
CREATE TRIGGER sync_focus_presets_update AFTER UPDATE ON focus_presets BEGIN
    DELETE FROM sync_rowlog WHERE entity = 'focus_presets' AND row_id = new.id;
    INSERT INTO sync_rowlog (entity, row_id) VALUES ('focus_presets', new.id);
END;

INSERT INTO sync_rowlog (entity, row_id) SELECT 'deadlines', id FROM deadlines ORDER BY updated_at;
CREATE TRIGGER sync_deadlines_insert AFTER INSERT ON deadlines BEGIN
    DELETE FROM sync_rowlog WHERE entity = 'deadlines' AND row_id = new.id;
    INSERT INTO sync_rowlog (entity, row_id) VALUES ('deadlines', new.id);
END;
CREATE TRIGGER sync_deadlines_update AFTER UPDATE ON deadlines BEGIN
    DELETE FROM sync_rowlog WHERE entity = 'deadlines' AND row_id = new.id;
    INSERT INTO sync_rowlog (entity, row_id) VALUES ('deadlines', new.id);
END;

INSERT INTO sync_rowlog (entity, row_id) SELECT 'deadline_day_marks', id FROM deadline_day_marks ORDER BY updated_at;
CREATE TRIGGER sync_deadline_day_marks_insert AFTER INSERT ON deadline_day_marks BEGIN
    DELETE FROM sync_rowlog WHERE entity = 'deadline_day_marks' AND row_id = new.id;
    INSERT INTO sync_rowlog (entity, row_id) VALUES ('deadline_day_marks', new.id);
END;
CREATE TRIGGER sync_deadline_day_marks_update AFTER UPDATE ON deadline_day_marks BEGIN
    DELETE FROM sync_rowlog WHERE entity = 'deadline_day_marks' AND row_id = new.id;
    INSERT INTO sync_rowlog (entity, row_id) VALUES ('deadline_day_marks', new.id);
END;

INSERT INTO sync_rowlog (entity, row_id) SELECT 'spaces', id FROM spaces ORDER BY updated_at;
CREATE TRIGGER sync_spaces_insert AFTER INSERT ON spaces BEGIN
    DELETE FROM sync_rowlog WHERE entity = 'spaces' AND row_id = new.id;
    INSERT INTO sync_rowlog (entity, row_id) VALUES ('spaces', new.id);
END;
CREATE TRIGGER sync_spaces_update AFTER UPDATE ON spaces BEGIN
    DELETE FROM sync_rowlog WHERE entity = 'spaces' AND row_id = new.id;
    INSERT INTO sync_rowlog (entity, row_id) VALUES ('spaces', new.id);
END;

INSERT INTO sync_rowlog (entity, row_id) SELECT 'tasks', id FROM tasks ORDER BY updated_at;
CREATE TRIGGER sync_tasks_insert AFTER INSERT ON tasks BEGIN
    DELETE FROM sync_rowlog WHERE entity = 'tasks' AND row_id = new.id;
    INSERT INTO sync_rowlog (entity, row_id) VALUES ('tasks', new.id);
END;
CREATE TRIGGER sync_tasks_update AFTER UPDATE ON tasks BEGIN
    DELETE FROM sync_rowlog WHERE entity = 'tasks' AND row_id = new.id;
    INSERT INTO sync_rowlog (entity, row_id) VALUES ('tasks', new.id);
END;

INSERT INTO sync_rowlog (entity, row_id) SELECT 'focus_sessions', id FROM focus_sessions ORDER BY updated_at;
CREATE TRIGGER sync_focus_sessions_insert AFTER INSERT ON focus_sessions BEGIN
    DELETE FROM sync_rowlog WHERE entity = 'focus_sessions' AND row_id = new.id;
    INSERT INTO sync_rowlog (entity, row_id) VALUES ('focus_sessions', new.id);
END;
CREATE TRIGGER sync_focus_sessions_update AFTER UPDATE ON focus_sessions BEGIN
    DELETE FROM sync_rowlog WHERE entity = 'focus_sessions' AND row_id = new.id;
    INSERT INTO sync_rowlog (entity, row_id) VALUES ('focus_sessions', new.id);
END;

INSERT INTO sync_rowlog (entity, row_id) SELECT 'apps', id FROM apps ORDER BY updated_at;
CREATE TRIGGER sync_apps_insert AFTER INSERT ON apps BEGIN
    DELETE FROM sync_rowlog WHERE entity = 'apps' AND row_id = new.id;
    INSERT INTO sync_rowlog (entity, row_id) VALUES ('apps', new.id);
END;
CREATE TRIGGER sync_apps_update AFTER UPDATE ON apps BEGIN
    DELETE FROM sync_rowlog WHERE entity = 'apps' AND row_id = new.id;
    INSERT INTO sync_rowlog (entity, row_id) VALUES ('apps', new.id);
END;

INSERT INTO sync_rowlog (entity, row_id) SELECT 'app_usage', id FROM app_usage ORDER BY updated_at;
CREATE TRIGGER sync_app_usage_insert AFTER INSERT ON app_usage BEGIN
    DELETE FROM sync_rowlog WHERE entity = 'app_usage' AND row_id = new.id;
    INSERT INTO sync_rowlog (entity, row_id) VALUES ('app_usage', new.id);
END;
CREATE TRIGGER sync_app_usage_update AFTER UPDATE ON app_usage BEGIN
    DELETE FROM sync_rowlog WHERE entity = 'app_usage' AND row_id = new.id;
    INSERT INTO sync_rowlog (entity, row_id) VALUES ('app_usage', new.id);
END;

INSERT INTO sync_rowlog (entity, row_id) SELECT 'distraction_events', id FROM distraction_events ORDER BY updated_at;
CREATE TRIGGER sync_distraction_events_insert AFTER INSERT ON distraction_events BEGIN
    DELETE FROM sync_rowlog WHERE entity = 'distraction_events' AND row_id = new.id;
    INSERT INTO sync_rowlog (entity, row_id) VALUES ('distraction_events', new.id);
END;
CREATE TRIGGER sync_distraction_events_update AFTER UPDATE ON distraction_events BEGIN
    DELETE FROM sync_rowlog WHERE entity = 'distraction_events' AND row_id = new.id;
    INSERT INTO sync_rowlog (entity, row_id) VALUES ('distraction_events', new.id);
END;

INSERT INTO sync_rowlog (entity, row_id) SELECT 'notes', id FROM notes ORDER BY updated_at;
CREATE TRIGGER sync_notes_insert AFTER INSERT ON notes BEGIN
    DELETE FROM sync_rowlog WHERE entity = 'notes' AND row_id = new.id;
    INSERT INTO sync_rowlog (entity, row_id) VALUES ('notes', new.id);
END;
CREATE TRIGGER sync_notes_update AFTER UPDATE ON notes BEGIN
    DELETE FROM sync_rowlog WHERE entity = 'notes' AND row_id = new.id;
    INSERT INTO sync_rowlog (entity, row_id) VALUES ('notes', new.id);
END;

INSERT INTO sync_rowlog (entity, row_id) SELECT 'tags', id FROM tags ORDER BY updated_at;
CREATE TRIGGER sync_tags_insert AFTER INSERT ON tags BEGIN
    DELETE FROM sync_rowlog WHERE entity = 'tags' AND row_id = new.id;
    INSERT INTO sync_rowlog (entity, row_id) VALUES ('tags', new.id);
END;
CREATE TRIGGER sync_tags_update AFTER UPDATE ON tags BEGIN
    DELETE FROM sync_rowlog WHERE entity = 'tags' AND row_id = new.id;
    INSERT INTO sync_rowlog (entity, row_id) VALUES ('tags', new.id);
END;

INSERT INTO sync_rowlog (entity, row_id) SELECT 'note_tags', id FROM note_tags ORDER BY updated_at;
CREATE TRIGGER sync_note_tags_insert AFTER INSERT ON note_tags BEGIN
    DELETE FROM sync_rowlog WHERE entity = 'note_tags' AND row_id = new.id;
    INSERT INTO sync_rowlog (entity, row_id) VALUES ('note_tags', new.id);
END;
CREATE TRIGGER sync_note_tags_update AFTER UPDATE ON note_tags BEGIN
    DELETE FROM sync_rowlog WHERE entity = 'note_tags' AND row_id = new.id;
    INSERT INTO sync_rowlog (entity, row_id) VALUES ('note_tags', new.id);
END;

INSERT INTO sync_rowlog (entity, row_id) SELECT 'note_links', id FROM note_links ORDER BY updated_at;
CREATE TRIGGER sync_note_links_insert AFTER INSERT ON note_links BEGIN
    DELETE FROM sync_rowlog WHERE entity = 'note_links' AND row_id = new.id;
    INSERT INTO sync_rowlog (entity, row_id) VALUES ('note_links', new.id);
END;
CREATE TRIGGER sync_note_links_update AFTER UPDATE ON note_links BEGIN
    DELETE FROM sync_rowlog WHERE entity = 'note_links' AND row_id = new.id;
    INSERT INTO sync_rowlog (entity, row_id) VALUES ('note_links', new.id);
END;
