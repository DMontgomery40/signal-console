-- Enforce detector-run identity for the production cache shapes.
--
-- Legacy cache DBs created by the original 0001 table constraint are not
-- protected for either production row shape because SQLite UNIQUE constraints
-- treat NULL values as distinct:
--   - scope='game' rows have NULL window_start/window_end
--   - scope='window' rows have NULL game_id
--
-- Keep the newest legacy duplicate, cascade-delete the rest of its
-- observations, then add an expression index that normalizes nullable identity
-- columns. Newest is computed_at DESC with id DESC as a tie-breaker, so an
-- already-backfilled cache keeps the row most likely to reflect latest source
-- data before the normalized unique index prevents future duplicates.

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
