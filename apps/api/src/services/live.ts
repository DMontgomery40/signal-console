// Live service (US-028 / PRD §FR-20, §15).
//
// Backs GET /v1/live/:gameId. Reads a bounded quote_ticks window for one
// game joined to source_markets for instrument metadata. Default live calls
// use the last five minutes; historical replay can widen the window within a
// hard cap. The query is shaped to hit idx_source_markets_game_instrument
// (by game_id) and then idx_quote_ticks_unique_observation (by
// source_market_id + captured_at); the verify:queries snapshot at
// ticks-for-one-game-window.plan.txt pins that plan.
//
// Detector fires layer in via the separate /v1/board/:gameId route. This route
// also returns cheap game-activity context (latest game state + recent PBP)
// scoped to the live/replay window end so historical tick replays do not mix
// old market windows with final score/PBP. No baseline-rebuild table is read
// by this module; the US-028 grep guard pins that.

import { openGoldDb } from "@signal-console/db";

type GoldDbHandle = ReturnType<typeof openGoldDb>;

export const LIVE_WINDOW_MS = 5 * 60 * 1000;
export const MAX_LIVE_WINDOW_MS = 15 * 60 * 1000;

export interface LiveTick {
  readonly sourceMarketId: string;
  readonly source: string;
  readonly capturedAt: string;
  readonly impliedProbability: number | null;
  readonly volume: number;
  readonly isHeartbeat: number;
  readonly instrumentId: string | null;
  readonly rawFamily: string | null;
  readonly rawLabel: string | null;
}

export interface LiveGameState {
  readonly awayScore: number | null;
  readonly capturedAt: string;
  readonly clock: string | null;
  readonly finalAt: string | null;
  readonly homeScore: number | null;
  readonly isFinal: boolean;
  readonly period: number | null;
  readonly startedAt: string | null;
  readonly status: string;
}

export interface LivePlayByPlayAction {
  readonly actionNumber: number;
  readonly actionType: string | null;
  readonly clock: string | null;
  readonly description: string | null;
  readonly period: number | null;
  readonly personId: number | null;
  readonly playerName: string | null;
  readonly scoreAway: string | null;
  readonly scoreHome: string | null;
  readonly subType: string | null;
  readonly teamTricode: string | null;
  readonly timeActual: string | null;
}

export interface LiveActivity {
  readonly gameState: LiveGameState | null;
  readonly playByPlayActionCount: number;
  readonly recentPlayByPlay: readonly LivePlayByPlayAction[];
}

export interface LiveResult {
  readonly activity: LiveActivity;
  readonly gameId: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly ticks: readonly LiveTick[];
}

export interface GetLiveArgs {
  readonly goldDbPath: string;
  readonly gameId: string;
  readonly now?: Date;
  readonly windowMs?: number;
}

export function getLive(args: GetLiveArgs): LiveResult {
  const now = args.now ?? new Date();
  const windowMs = args.windowMs ?? LIVE_WINDOW_MS;
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0 || windowMs > MAX_LIVE_WINDOW_MS) {
    throw new Error(`invalid live window: ${String(windowMs)}`);
  }
  const windowStart = new Date(now.getTime() - windowMs);
  const startIso = windowStart.toISOString();
  const endIso = now.toISOString();
  const db = openGoldDb(args.goldDbPath);
  try {
    const ticks = loadTicks(db, args.gameId, startIso, endIso);
    const activity = loadActivity(db, args.gameId, endIso);
    return {
      activity,
      gameId: args.gameId,
      windowStart: startIso,
      windowEnd: endIso,
      ticks,
    };
  } finally {
    db.close();
  }
}

function loadTicks(
  db: GoldDbHandle,
  gameId: string,
  startIso: string,
  endIso: string,
): readonly LiveTick[] {
  // The join order (source_markets first, then quote_ticks bounded by
  // source_market_id + captured_at) lets SQLite use the covering index
  // idx_source_markets_game_instrument followed by the per-market
  // idx_quote_ticks_unique_observation. Both are pinned by the
  // verify:queries snapshot ticks-for-one-game-window.plan.txt.
  const rows = db
    .prepare(
      `SELECT qt.source_market_id AS source_market_id,
              sm.source AS source,
              qt.captured_at AS captured_at,
              qt.implied_probability AS implied_probability,
              COALESCE(qt.volume, 0) AS volume,
              qt.is_heartbeat AS is_heartbeat,
              sm.instrument_id AS instrument_id,
              sm.raw_family AS raw_family,
              sm.raw_label AS raw_label
       FROM quote_ticks qt
       JOIN source_markets sm ON sm.id = qt.source_market_id
       WHERE sm.game_id = ?
         AND qt.captured_at >= ?
         AND qt.captured_at <= ?
       ORDER BY qt.captured_at`,
    )
    .all(gameId, startIso, endIso);
  return rows.map((row): LiveTick => {
    if (!isRecord(row)) throw new Error("live tick row not an object");
    const ip = row["implied_probability"];
    return {
      sourceMarketId: pickString(row, "source_market_id"),
      source: pickString(row, "source"),
      capturedAt: pickString(row, "captured_at"),
      impliedProbability: ip === null ? null : typeof ip === "number" ? ip : null,
      volume: pickNumber(row, "volume"),
      isHeartbeat: pickNumber(row, "is_heartbeat"),
      instrumentId: pickStringOrNull(row, "instrument_id"),
      rawFamily: pickStringOrNull(row, "raw_family"),
      rawLabel: pickStringOrNull(row, "raw_label"),
    };
  });
}

function loadActivity(db: GoldDbHandle, gameId: string, endIso: string): LiveActivity {
  return {
    gameState: loadLatestGameState(db, gameId, endIso),
    playByPlayActionCount: loadPlayByPlayActionCount(db, gameId, endIso),
    recentPlayByPlay: loadRecentPlayByPlay(db, gameId, endIso),
  };
}

function loadLatestGameState(
  db: GoldDbHandle,
  gameId: string,
  endIso: string,
): LiveGameState | null {
  let row: unknown;
  try {
    row = db
      .prepare(
        `SELECT game_id,
                captured_at,
                status,
                period,
                clock,
                home_score,
                away_score,
                is_final,
                started_at,
                final_at
	         FROM game_states
	         WHERE game_id = ?
             AND captured_at <= ?
	         ORDER BY datetime(captured_at) DESC, id DESC
	         LIMIT 1`,
      )
      .get(gameId, endIso);
  } catch {
    return null;
  }
  if (!isRecord(row)) return null;
  return {
    awayScore: pickNumberOrNull(row, "away_score"),
    capturedAt: pickString(row, "captured_at"),
    clock: pickStringOrNull(row, "clock"),
    finalAt: pickStringOrNull(row, "final_at"),
    homeScore: pickNumberOrNull(row, "home_score"),
    isFinal: pickNumber(row, "is_final") === 1,
    period: pickNumberOrNull(row, "period"),
    startedAt: pickStringOrNull(row, "started_at"),
    status: pickString(row, "status"),
  };
}

function loadPlayByPlayActionCount(db: GoldDbHandle, gameId: string, endIso: string): number {
  let row: unknown;
  try {
    row = db
      .prepare(
        `WITH latest AS (
           SELECT r.*
           FROM nba_pbp_revisions r
           JOIN (
             SELECT action_number, MAX(captured_at) AS captured_at
             FROM nba_pbp_revisions
             WHERE game_id = ?
               AND julianday(captured_at) <= julianday(?)
             GROUP BY action_number
           ) lr
             ON lr.action_number = r.action_number
            AND lr.captured_at = r.captured_at
           WHERE r.game_id = ?
         )
         SELECT COUNT(*) AS count
         FROM latest
         WHERE time_actual IS NOT NULL
           AND julianday(time_actual) <= julianday(?)`,
      )
      .get(gameId, endIso, gameId, endIso);
  } catch {
    return 0;
  }
  if (!isRecord(row)) return 0;
  return pickNumber(row, "count");
}

function loadRecentPlayByPlay(
  db: GoldDbHandle,
  gameId: string,
  endIso: string,
): readonly LivePlayByPlayAction[] {
  let rows: unknown[];
  try {
    rows = db
      .prepare(
        `WITH latest AS (
           SELECT r.*
           FROM nba_pbp_revisions r
           JOIN (
             SELECT action_number, MAX(captured_at) AS captured_at
             FROM nba_pbp_revisions
             WHERE game_id = ?
               AND julianday(captured_at) <= julianday(?)
             GROUP BY action_number
           ) lr
             ON lr.action_number = r.action_number
            AND lr.captured_at = r.captured_at
           WHERE r.game_id = ?
         )
         SELECT action_number,
                action_type,
                sub_type,
                person_id,
                player_name,
                period,
                clock,
                description,
                score_away,
                score_home,
                team_tricode,
	                time_actual
         FROM latest
         WHERE time_actual IS NOT NULL
           AND julianday(time_actual) <= julianday(?)
         ORDER BY action_number DESC
	         LIMIT 8`,
      )
      .all(gameId, endIso, gameId, endIso);
  } catch {
    return [];
  }
  return rows.map((row): LivePlayByPlayAction => {
    if (!isRecord(row)) throw new Error("live PBP row not an object");
    return {
      actionNumber: pickNumber(row, "action_number"),
      actionType: pickStringOrNull(row, "action_type"),
      clock: pickStringOrNull(row, "clock"),
      description: pickStringOrNull(row, "description"),
      period: pickNumberOrNull(row, "period"),
      personId: pickNumberOrNull(row, "person_id"),
      playerName: pickStringOrNull(row, "player_name"),
      scoreAway: pickStringOrNull(row, "score_away"),
      scoreHome: pickStringOrNull(row, "score_home"),
      subType: pickStringOrNull(row, "sub_type"),
      teamTricode: pickStringOrNull(row, "team_tricode"),
      timeActual: pickStringOrNull(row, "time_actual"),
    };
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pickString(rec: Record<string, unknown>, key: string): string {
  const v = rec[key];
  if (typeof v !== "string") throw new Error(`field ${key}: expected string`);
  return v;
}

function pickNumber(rec: Record<string, unknown>, key: string): number {
  const v = rec[key];
  if (typeof v !== "number") throw new Error(`field ${key}: expected number`);
  return v;
}

function pickNumberOrNull(rec: Record<string, unknown>, key: string): number | null {
  const v = rec[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== "number") throw new Error(`field ${key}: expected number or null`);
  return v;
}

function pickStringOrNull(rec: Record<string, unknown>, key: string): string | null {
  const v = rec[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new Error(`field ${key}: expected string or null`);
  return v;
}
