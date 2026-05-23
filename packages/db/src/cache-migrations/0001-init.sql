-- Cache DB schema (PRD §9). Writable. Detector outputs only.
-- Apply via packages/db/src/cache-migrations/runner.ts.
-- CREATE ... IF NOT EXISTS makes this migration idempotent: re-running adds
-- no rows and raises no error.

CREATE TABLE IF NOT EXISTS detector_runs (
  id INTEGER PRIMARY KEY,
  detector_id TEXT NOT NULL,
  detector_version TEXT NOT NULL,
  params_hash TEXT NOT NULL,
  params_json TEXT NOT NULL,
  source_db_path TEXT NOT NULL,
  source_watermark_hash TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('game','window')),
  game_id TEXT,
  window_start TEXT,
  window_end TEXT,
  computed_at TEXT NOT NULL,
  compute_ms INTEGER NOT NULL,
  UNIQUE (
    detector_id,
    detector_version,
    params_hash,
    source_watermark_hash,
    scope,
    game_id,
    window_start,
    window_end
  )
);

CREATE TABLE IF NOT EXISTS detector_observations (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES detector_runs(id) ON DELETE CASCADE,
  game_id TEXT NOT NULL,
  bucket_start TEXT NOT NULL,
  bucket_end TEXT NOT NULL,
  fired INTEGER NOT NULL,
  intensity REAL,
  baseline_median REAL,
  baseline_mad REAL,
  detail_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_detector_obs_run_game
  ON detector_observations(run_id, game_id, bucket_start);

CREATE INDEX IF NOT EXISTS idx_detector_obs_fired
  ON detector_observations(run_id, fired);
