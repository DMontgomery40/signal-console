// Sport-agnostic CTE template strings (PRD §11, FR-26).
//
// Query modules import these and inline them inside `WITH ... AS ( ... )`
// clauses. We never `CREATE TEMP VIEW`: `PRAGMA query_only = ON` (set by the
// gold-DB open path) forbids it, and CTEs keep each query self-contained for
// EXPLAIN QUERY PLAN snapshotting.
//
// Exact column names below are verified by the Phase-0 query-plan smoke
// (`pnpm verify:queries`) running EXPLAIN QUERY PLAN against the moved gold
// DB. Drift in any column name is a one-file fix in this module — callers
// reference the CTE name and the columns it exposes, never the underlying
// physical tables directly.
//
// Sources (read-only):
//   - `games` (cols: id, sport, league, scheduled_start,
//     home_participant_json, away_participant_json)
//   - `game_states` (cols: game_id, captured_at, status; latest row per game
//     supplies the current status via correlated subquery)
//   - `nba_play_by_play_actions` (cols: game_id, action_number, action_type,
//     period, clock, description, time_actual, captured_at)
//
// When football PBP ingest lands, `v_events` grows a `UNION ALL` against the
// football PBP table; `v_games` grows JSON-shape handling if a new sport's
// participant JSON differs from NBA's. Callers do not change.

export const v_games: string = `
  SELECT
    g.id                    AS id,
    g.sport                 AS sport,
    g.league                AS league,
    g.scheduled_start       AS scheduled_start,
    g.home_participant_json AS home_participant_json,
    g.away_participant_json AS away_participant_json,
    (
      SELECT gs.status
      FROM   game_states gs
      WHERE  gs.game_id = g.id
      ORDER  BY gs.captured_at DESC
      LIMIT  1
    )                       AS status
  FROM games g
`;

export const v_events: string = `
  SELECT
    'NBA'             AS sport,
    pbp.game_id       AS game_id,
    pbp.action_number AS action_number,
    pbp.action_type   AS action_type,
    pbp.period        AS period,
    pbp.clock         AS clock,
    pbp.description   AS description,
    pbp.time_actual   AS time_actual,
    pbp.captured_at   AS captured_at
  FROM nba_play_by_play_actions pbp
`;
