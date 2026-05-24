-- Cache DB schema (PRD §9). Writable. Detector outputs only.
-- Apply via packages/db/src/cache-migrations/runner.ts.
-- CREATE ... IF NOT EXISTS plus the duplicate cleanup make this migration
-- idempotent for both empty DBs and no-ledger legacy cache DBs.

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
  compute_ms INTEGER NOT NULL
);

-- SQLite UNIQUE constraints treat NULL values as distinct, so normalize the
-- inactive scope columns used by game-scoped and window-scoped cache rows.
-- No-ledger legacy DBs may already have duplicate logical identities before
-- this index exists; keep the newest row before enforcing the normalized key.
DELETE FROM detector_runs
WHERE EXISTS (
  SELECT 1
  FROM detector_runs newer
  WHERE newer.detector_id = detector_runs.detector_id
    AND newer.detector_version = detector_runs.detector_version
    AND newer.params_hash = detector_runs.params_hash
    AND newer.source_watermark_hash = detector_runs.source_watermark_hash
    AND newer.scope = detector_runs.scope
    AND COALESCE(newer.game_id, char(0)) = COALESCE(detector_runs.game_id, char(0))
    AND COALESCE(newer.window_start, char(0)) = COALESCE(detector_runs.window_start, char(0))
    AND COALESCE(newer.window_end, char(0)) = COALESCE(detector_runs.window_end, char(0))
    AND (
      newer.computed_at > detector_runs.computed_at
      OR (newer.computed_at = detector_runs.computed_at AND newer.id > detector_runs.id)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_detector_runs_identity_normalized
  ON detector_runs (
    detector_id,
    detector_version,
    params_hash,
    source_watermark_hash,
    scope,
    COALESCE(game_id, char(0)),
    COALESCE(window_start, char(0)),
    COALESCE(window_end, char(0))
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
