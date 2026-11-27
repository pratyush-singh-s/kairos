-- Focus local database, schema version 1.
-- Conventions:
--   * Times are UTC milliseconds since the Unix epoch (INTEGER).
--   * Synced tables carry: id (UUIDv7 text), created_at, updated_at (hybrid logical clock text,
--     sorts in time order), device_id (the PC that made the last change), deleted_at (tombstone).
--   * Foreign keys are DEFERRABLE so a batch of changes from the other PC can be applied
--     in any order inside one transaction.

-- ---------------------------------------------------------------- local only

CREATE TABLE local_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
) STRICT;

CREATE TABLE account (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    google_sub   TEXT NOT NULL,
    email        TEXT NOT NULL,
    display_name TEXT,
    avatar_url   TEXT,
    time_zone    TEXT,
    week_start   INTEGER CHECK (week_start BETWEEN 0 AND 6),
    signed_in_at INTEGER NOT NULL
) STRICT;

CREATE TABLE peers (
    device_id      TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    public_key     BLOB NOT NULL,
    paired_at      INTEGER NOT NULL,
    last_synced_at INTEGER,
    last_seen_seq  INTEGER NOT NULL DEFAULT 0
) STRICT;

-- ---------------------------------------------------------------- settings (synced, per key)

CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,           -- JSON
    created_at INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    device_id  TEXT NOT NULL,
    deleted_at INTEGER
) STRICT;

-- ---------------------------------------------------------------- blocking

CREATE TABLE blocking_profiles (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL CHECK (length(trim(name)) > 0),
    kind           TEXT NOT NULL CHECK (kind IN ('study', 'work', 'deep_work', 'exam', 'custom')),
    active_when    TEXT NOT NULL DEFAULT 'focus' CHECK (active_when IN ('focus', 'always', 'schedule')),
    schedule       TEXT,                -- JSON, used when active_when = 'schedule'
    default_mode   TEXT NOT NULL DEFAULT 'wait' CHECK (default_mode IN ('wait', 'full')),
    wait_seconds   INTEGER NOT NULL DEFAULT 20 CHECK (wait_seconds BETWEEN 1 AND 3600),
    youtube_options TEXT NOT NULL DEFAULT '{}',  -- JSON
    created_at INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    device_id  TEXT NOT NULL,
    deleted_at INTEGER
) STRICT;
CREATE INDEX idx_blocking_profiles_name ON blocking_profiles (name);

CREATE TABLE blocking_rules (
    id           TEXT PRIMARY KEY,
    profile_id   TEXT NOT NULL REFERENCES blocking_profiles (id) DEFERRABLE INITIALLY DEFERRED,
    action       TEXT NOT NULL CHECK (action IN ('block', 'allow')),
    type         TEXT NOT NULL CHECK (type IN ('domain', 'path', 'pattern', 'keyword', 'yt_channel', 'yt_section')),
    value        TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND 2048),
    normalized   TEXT NOT NULL,
    mode         TEXT CHECK (mode IN ('wait', 'full')),          -- NULL = profile default
    wait_seconds INTEGER CHECK (wait_seconds BETWEEN 1 AND 3600), -- NULL = profile default
    enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_at INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    device_id  TEXT NOT NULL,
    deleted_at INTEGER
) STRICT;
CREATE INDEX idx_blocking_rules_profile ON blocking_rules (profile_id);

-- ---------------------------------------------------------------- focus

CREATE TABLE focus_presets (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL CHECK (length(trim(name)) > 0),
    focus_s             INTEGER NOT NULL CHECK (focus_s BETWEEN 60 AND 86400),
    short_break_s       INTEGER NOT NULL CHECK (short_break_s BETWEEN 0 AND 86400),
    long_break_s        INTEGER NOT NULL CHECK (long_break_s BETWEEN 0 AND 86400),
    sessions_per_cycle  INTEGER NOT NULL CHECK (sessions_per_cycle BETWEEN 1 AND 24),
    long_break_every    INTEGER NOT NULL CHECK (long_break_every BETWEEN 0 AND 24), -- 0 = never
    auto_start_break    INTEGER NOT NULL DEFAULT 1 CHECK (auto_start_break IN (0, 1)),
    auto_start_focus    INTEGER NOT NULL DEFAULT 0 CHECK (auto_start_focus IN (0, 1)),
    blocking_profile_id TEXT REFERENCES blocking_profiles (id) DEFERRABLE INITIALLY DEFERRED,
    sort_order          INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    device_id  TEXT NOT NULL,
    deleted_at INTEGER
) STRICT;
CREATE INDEX idx_focus_presets_order ON focus_presets (sort_order, name);

-- ---------------------------------------------------------------- planning

CREATE TABLE deadlines (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL CHECK (length(trim(title)) > 0),
    description     TEXT NOT NULL DEFAULT '',
    start_at        INTEGER NOT NULL,
    due_at          INTEGER NOT NULL,
    all_day         INTEGER NOT NULL DEFAULT 0 CHECK (all_day IN (0, 1)),
    viz             TEXT NOT NULL DEFAULT 'both' CHECK (viz IN ('ring', 'grid', 'both')),
    completed_at    INTEGER,
    gcal_event_id   TEXT,
    source_event_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    device_id  TEXT NOT NULL,
    deleted_at INTEGER,
    CHECK (due_at > start_at)
) STRICT;
CREATE INDEX idx_deadlines_due ON deadlines (due_at);

CREATE TABLE deadline_day_marks (
    id          TEXT PRIMARY KEY,
    deadline_id TEXT NOT NULL REFERENCES deadlines (id) DEFERRABLE INITIALLY DEFERRED,
    day_index   INTEGER NOT NULL CHECK (day_index >= 0),
    done        INTEGER NOT NULL CHECK (done IN (0, 1)),
    created_at INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    device_id  TEXT NOT NULL,
    deleted_at INTEGER,
    UNIQUE (deadline_id, day_index)
) STRICT;

CREATE TABLE tasks (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL CHECK (length(trim(title)) > 0),
    done          INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
    done_at       INTEGER,
    due_date      TEXT,                 -- local calendar date, YYYY-MM-DD
    priority      TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
    category      TEXT,
    deadline_id   TEXT REFERENCES deadlines (id) DEFERRABLE INITIALLY DEFERRED,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    gcal_event_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    device_id  TEXT NOT NULL,
    deleted_at INTEGER
) STRICT;
CREATE INDEX idx_tasks_open ON tasks (done, due_date);
CREATE INDEX idx_tasks_deadline ON tasks (deadline_id);

-- ---------------------------------------------------------------- focus sessions and tracking

CREATE TABLE focus_sessions (
    id             TEXT PRIMARY KEY,
    cycle_id       TEXT NOT NULL,
    session_number INTEGER NOT NULL CHECK (session_number >= 1),
    phase          TEXT NOT NULL CHECK (phase IN ('focus', 'short_break', 'long_break')),
    started_at     INTEGER NOT NULL,
    ended_at       INTEGER,
    planned_s      INTEGER NOT NULL CHECK (planned_s > 0),
    actual_s       INTEGER CHECK (actual_s >= 0),
    paused_s       INTEGER NOT NULL DEFAULT 0 CHECK (paused_s >= 0),
    outcome        TEXT CHECK (outcome IN ('completed', 'interrupted', 'skipped', 'cancelled')),
    preset_id      TEXT REFERENCES focus_presets (id) DEFERRABLE INITIALLY DEFERRED,
    profile_id     TEXT REFERENCES blocking_profiles (id) DEFERRABLE INITIALLY DEFERRED,
    deadline_id    TEXT REFERENCES deadlines (id) DEFERRABLE INITIALLY DEFERRED,
    created_at INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    device_id  TEXT NOT NULL,
    deleted_at INTEGER
) STRICT;
CREATE INDEX idx_focus_sessions_started ON focus_sessions (started_at);
CREATE INDEX idx_focus_sessions_cycle ON focus_sessions (cycle_id);

CREATE TABLE apps (
    id           TEXT PRIMARY KEY,
    exe_name     TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    device_id  TEXT NOT NULL,
    deleted_at INTEGER
) STRICT;

CREATE TABLE app_usage (
    id              TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL REFERENCES focus_sessions (id) DEFERRABLE INITIALLY DEFERRED,
    app_id          TEXT NOT NULL REFERENCES apps (id) DEFERRABLE INITIALLY DEFERRED,
    active_s        INTEGER NOT NULL CHECK (active_s >= 0),
    activations     INTEGER NOT NULL CHECK (activations >= 0),
    first_active_at INTEGER NOT NULL,
    last_active_at  INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    device_id  TEXT NOT NULL,
    deleted_at INTEGER,
    UNIQUE (session_id, app_id)
) STRICT;
CREATE INDEX idx_app_usage_app ON app_usage (app_id);

-- Raw foreground intervals; never leave this PC; pruned after 30 days.
CREATE TABLE activity_spans (
    id         INTEGER PRIMARY KEY,
    app_id     TEXT NOT NULL REFERENCES apps (id) DEFERRABLE INITIALLY DEFERRED,
    started_at INTEGER NOT NULL,
    ended_at   INTEGER NOT NULL,
    CHECK (ended_at >= started_at)
) STRICT;
CREATE INDEX idx_activity_spans_started ON activity_spans (started_at);

CREATE TABLE distraction_events (
    id         TEXT PRIMARY KEY,
    session_id TEXT REFERENCES focus_sessions (id) DEFERRABLE INITIALLY DEFERRED,
    kind       TEXT NOT NULL CHECK (kind IN ('blocked_hit', 'continued', 'extension_disconnected')),
    domain     TEXT,                    -- domain only, never a full URL
    at         INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    device_id  TEXT NOT NULL,
    deleted_at INTEGER
) STRICT;
CREATE INDEX idx_distraction_events_at ON distraction_events (at);
CREATE INDEX idx_distraction_events_session ON distraction_events (session_id);

-- ---------------------------------------------------------------- notes

CREATE TABLE notes (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL DEFAULT '',
    pinned     INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    folder     TEXT,
    ydoc       BLOB,                    -- Yjs document state (merged between PCs)
    plain_text TEXT NOT NULL DEFAULT '',-- for search
    created_at INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    device_id  TEXT NOT NULL,
    deleted_at INTEGER
) STRICT;
CREATE INDEX idx_notes_pinned ON notes (pinned, updated_at);

CREATE VIRTUAL TABLE notes_fts USING fts5 (title, plain_text, content = 'notes', content_rowid = 'rowid');
CREATE TRIGGER notes_fts_insert AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts (rowid, title, plain_text) VALUES (new.rowid, new.title, new.plain_text);
END;
CREATE TRIGGER notes_fts_delete AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts (notes_fts, rowid, title, plain_text) VALUES ('delete', old.rowid, old.title, old.plain_text);
END;
CREATE TRIGGER notes_fts_update AFTER UPDATE ON notes BEGIN
    INSERT INTO notes_fts (notes_fts, rowid, title, plain_text) VALUES ('delete', old.rowid, old.title, old.plain_text);
    INSERT INTO notes_fts (rowid, title, plain_text) VALUES (new.rowid, new.title, new.plain_text);
END;

CREATE TABLE tags (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(trim(name)) > 0),
    created_at INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    device_id  TEXT NOT NULL,
    deleted_at INTEGER
) STRICT;

CREATE TABLE note_tags (
    id      TEXT PRIMARY KEY,
    note_id TEXT NOT NULL REFERENCES notes (id) DEFERRABLE INITIALLY DEFERRED,
    tag_id  TEXT NOT NULL REFERENCES tags (id) DEFERRABLE INITIALLY DEFERRED,
    created_at INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    device_id  TEXT NOT NULL,
    deleted_at INTEGER,
    UNIQUE (note_id, tag_id)
) STRICT;

CREATE TABLE note_links (
    id          TEXT PRIMARY KEY,
    note_id     TEXT NOT NULL REFERENCES notes (id) DEFERRABLE INITIALLY DEFERRED,
    target_type TEXT NOT NULL CHECK (target_type IN ('task', 'deadline', 'session')),
    target_id   TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    device_id  TEXT NOT NULL,
    deleted_at INTEGER,
    UNIQUE (note_id, target_type, target_id)
) STRICT;
CREATE INDEX idx_note_links_target ON note_links (target_type, target_id);

-- ---------------------------------------------------------------- Google (local caches)

CREATE TABLE calendar_sources (
    id                 TEXT PRIMARY KEY,
    google_calendar_id TEXT NOT NULL UNIQUE,
    summary            TEXT NOT NULL,
    is_holiday         INTEGER NOT NULL DEFAULT 0 CHECK (is_holiday IN (0, 1)),
    selected           INTEGER NOT NULL DEFAULT 1 CHECK (selected IN (0, 1)),
    sync_token         TEXT,
    last_synced_at     INTEGER
) STRICT;

CREATE TABLE calendar_events (
    id              TEXT PRIMARY KEY,
    source_id       TEXT NOT NULL REFERENCES calendar_sources (id) ON DELETE CASCADE,
    google_event_id TEXT NOT NULL,
    etag            TEXT,
    summary         TEXT NOT NULL DEFAULT '',
    start_at        INTEGER,            -- timed events (UTC ms)
    end_at          INTEGER,
    start_date      TEXT,               -- all-day events (YYYY-MM-DD)
    end_date        TEXT,
    all_day         INTEGER NOT NULL CHECK (all_day IN (0, 1)),
    time_zone       TEXT,
    status          TEXT NOT NULL DEFAULT 'confirmed',
    UNIQUE (source_id, google_event_id)
) STRICT;
CREATE INDEX idx_calendar_events_start ON calendar_events (start_at);
CREATE INDEX idx_calendar_events_start_date ON calendar_events (start_date);

CREATE TABLE youtube_cache (
    video_id    TEXT PRIMARY KEY,
    channel_id  TEXT,
    tags        TEXT NOT NULL DEFAULT '[]', -- JSON array
    category_id TEXT,
    fetched_at  INTEGER NOT NULL
) STRICT;

-- ---------------------------------------------------------------- sync

-- Every local change to a synced table, in order. Pruned once all paired PCs have it.
CREATE TABLE change_log (
    seq       INTEGER PRIMARY KEY AUTOINCREMENT,
    entity    TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    fields    TEXT NOT NULL,            -- JSON object of changed fields
    hlc       TEXT NOT NULL,
    device_id TEXT NOT NULL
) STRICT;
CREATE INDEX idx_change_log_entity ON change_log (entity, entity_id);
