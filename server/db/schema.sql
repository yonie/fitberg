-- Fitberg schema.
--
-- IMPORTANT MENTAL MODEL: this database is a DERIVED CACHE.
-- The source of truth is data/originals/ — content-addressed, never-modified
-- copies of every file ever imported. `npm run reindex` throws this database
-- away and rebuilds every row below from those originals. Design accordingly:
-- never store something here that cannot be recomputed or that did not come
-- from an original file (the exceptions are explicitly marked USER-AUTHORED).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ─── users ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT    NOT NULL UNIQUE,
  password_hash TEXT,                     -- scrypt; NULL when open-access
  display_name  TEXT,
  created_at    INTEGER NOT NULL,
  -- USER-AUTHORED: physiology + preferences. Backed up via /api/export.
  settings_json TEXT    NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ─── the durable original-file ledger ─────────────────────────────────────────
-- One row per distinct byte-sequence we have ever been given. This is the index
-- over data/originals/. Rebuilt by walking that directory.
CREATE TABLE IF NOT EXISTS originals (
  hash          TEXT PRIMARY KEY,          -- sha256 of raw bytes
  rel_path      TEXT NOT NULL,             -- path within originals/
  bytes         INTEGER NOT NULL,
  kind          TEXT,                      -- fit|gpx|tcx|nike_json|apple_health|strava_csv|...
  source        TEXT,                      -- strava|nike|wahoo|garmin|file|api
  original_name TEXT,                      -- filename as the user gave it to us
  container     TEXT,                      -- hash of the archive it came from, if any
  imported_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_originals_container ON originals(container);

-- ─── activities ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activities (
  id               INTEGER PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  source           TEXT    NOT NULL,       -- strava|nike|wahoo|garmin|file|api|manual
  source_id        TEXT,                   -- id within that source, when known
  dedupe_key       TEXT    NOT NULL,       -- sport + rounded start time + rounded distance

  name             TEXT,
  sport            TEXT    NOT NULL DEFAULT 'other',
  sub_sport        TEXT,
  device           TEXT,                   -- what recorded it, when the file says

  start_time       INTEGER NOT NULL,       -- epoch ms, UTC
  utc_offset_s     INTEGER NOT NULL DEFAULT 0,
  timezone         TEXT,

  elapsed_s        INTEGER,
  moving_s         INTEGER,

  distance_m       REAL,
  elev_gain_m      REAL,
  elev_loss_m      REAL,
  elev_min_m       REAL,
  elev_max_m       REAL,

  avg_speed_ms     REAL,
  max_speed_ms     REAL,
  avg_hr           REAL,
  max_hr           REAL,
  avg_cadence      REAL,
  max_cadence      REAL,
  avg_power        REAL,
  max_power        REAL,
  normalized_power REAL,
  work_kj          REAL,
  calories         REAL,
  avg_temp_c       REAL,

  trainer          INTEGER NOT NULL DEFAULT 0,
  commute          INTEGER NOT NULL DEFAULT 0,
  manual           INTEGER NOT NULL DEFAULT 0,

  polyline         TEXT,                   -- encoded polyline, ~5m precision, for lists/maps
  start_lat        REAL,
  start_lng        REAL,
  bbox_json        TEXT,

  -- derived training metrics (see server/metrics/)
  load             REAL,                   -- TSS-equivalent
  load_method      TEXT,                   -- power|hr|pace|duration
  intensity_factor REAL,
  variability_index REAL,
  decoupling_pct   REAL,
  efficiency_factor REAL,
  vo2max_estimate  REAL,
  aerobic_pct      REAL,                   -- share of moving time below threshold

  -- USER-AUTHORED annotations
  perceived_exertion INTEGER,              -- 1..10 RPE
  feeling            INTEGER,              -- 1..5
  notes              TEXT,
  -- The crop currently in force, mirrored from activity_edits so that reading the
  -- activity is enough to render it. activity_edits is the authority, because it is
  -- the copy reindex does not delete.
  crop_start_s       INTEGER,
  crop_end_s         INTEGER,

  original_hash    TEXT REFERENCES originals(hash),
  summary_json     TEXT,                   -- source's own summary payload, verbatim
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,

  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_act_user_start ON activities(user_id, start_time DESC);
CREATE INDEX IF NOT EXISTS idx_act_sport      ON activities(user_id, sport, start_time DESC);
CREATE INDEX IF NOT EXISTS idx_act_source     ON activities(user_id, source, source_id);
CREATE INDEX IF NOT EXISTS idx_act_original   ON activities(original_hash);

-- Time-series, stored as typed-array blobs (see server/lib/codec.js). One row
-- per channel keeps reads cheap: a map needs lat/lng, a chart needs one channel.
CREATE TABLE IF NOT EXISTS streams (
  activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  channel     TEXT    NOT NULL,            -- t|lat|lng|alt|hr|cad|power|speed|dist|temp|grade
  n           INTEGER NOT NULL,
  dtype       TEXT    NOT NULL,            -- f32|f64|i32|u16|u8
  data        BLOB    NOT NULL,
  PRIMARY KEY (activity_id, channel)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS laps (
  activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  start_time  INTEGER,
  elapsed_s   INTEGER,
  moving_s    INTEGER,
  distance_m  REAL,
  avg_hr      REAL,
  max_hr      REAL,
  avg_power   REAL,
  avg_speed_ms REAL,
  avg_cadence REAL,
  elev_gain_m REAL,
  PRIMARY KEY (activity_id, idx)
) WITHOUT ROWID;

-- Mean-max power curve points and fastest-distance splits.
CREATE TABLE IF NOT EXISTS best_efforts (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  sport       TEXT    NOT NULL,
  kind        TEXT    NOT NULL,            -- peak_power | peak_hr | fastest_distance
  bucket      REAL    NOT NULL,            -- seconds (peak_*) or metres (fastest_*)
  value       REAL    NOT NULL,            -- watts / bpm / seconds-elapsed
  start_idx   INTEGER,
  start_time  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_be_lookup ON best_efforts(user_id, sport, kind, bucket, value);
CREATE INDEX IF NOT EXISTS idx_be_act    ON best_efforts(activity_id);

-- ─── daily rollup ─────────────────────────────────────────────────────────────
-- Fully derived: one row per day, recomputed by the metrics engine.
CREATE TABLE IF NOT EXISTS daily (
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day            TEXT    NOT NULL,         -- YYYY-MM-DD, local
  load           REAL    NOT NULL DEFAULT 0,
  duration_s     INTEGER NOT NULL DEFAULT 0,
  distance_m     REAL    NOT NULL DEFAULT 0,
  elev_gain_m    REAL    NOT NULL DEFAULT 0,
  activity_count INTEGER NOT NULL DEFAULT 0,
  ctl            REAL,                     -- fitness  (42d EWMA of load)
  atl            REAL,                     -- fatigue  (7d  EWMA of load)
  tsb            REAL,                     -- form     (ctl - atl)
  monotony       REAL,                     -- Foster: 7d mean load / 7d sd
  strain         REAL,                     -- Foster: 7d total load * monotony
  ramp_rate      REAL,                     -- ctl change over trailing 7d
  vo2max         REAL,
  PRIMARY KEY (user_id, day)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS imports (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source      TEXT,
  filename    TEXT,
  bytes       INTEGER,
  status      TEXT    NOT NULL,            -- running|done|failed
  found       INTEGER NOT NULL DEFAULT 0,
  imported    INTEGER NOT NULL DEFAULT 0,
  duplicates  INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  log_json    TEXT,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_imports_user ON imports(user_id, started_at DESC);

-- Things you typed, as opposed to things Fitberg worked out.
--
-- Keyed by the physical dedupe key rather than the activity id, because ids are handed
-- out fresh on every reindex while the dedupe key (sport + start time + distance) is a
-- property of the ride itself. That is what lets an edit survive the database being
-- thrown away and rebuilt from your files.
--
-- This table is NOT derived, so `truncateDerived` must never include it.
CREATE TABLE IF NOT EXISTS activity_edits (
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dedupe_key         TEXT    NOT NULL,
  -- Non-destructive crop, in seconds from the start of the recording. The original file
  -- is never touched; these bounds are re-applied when the activity is re-derived.
  crop_start_s       INTEGER,
  crop_end_s         INTEGER,
  name               TEXT,
  notes              TEXT,
  perceived_exertion REAL,
  feeling            TEXT,
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (user_id, dedupe_key)
) WITHOUT ROWID;

-- Settings changed in the app rather than in the environment. Not user-scoped: these
-- describe the instance, and there is one instance.
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS ai_insights (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT    NOT NULL,             -- weekly|activity|answer
  ref        TEXT,                         -- week key or activity id
  content    TEXT    NOT NULL,
  model      TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_lookup ON ai_insights(user_id, kind, ref);
