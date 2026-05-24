// Live service (US-028 / PRD §FR-20, §15).
//
// Backs GET /v1/live/:gameId. Reads the last 5 minutes of quote_ticks for
// one game joined to source_markets for instrument metadata. The query is
// shaped to hit idx_source_markets_game_instrument (by game_id) and then
// idx_quote_ticks_unique_observation (by source_market_id + captured_at);
// the verify:queries snapshot at ticks-for-one-game-window.plan.txt pins
// that plan.
//
// Live is "raw ticks only" — detector fires layer in via the separate
// /v1/board/:gameId call. No baseline-rebuild table is read by this
// module; the US-028 grep guard pins that.

import { openGoldDb } from "@signal-console/db";

type GoldDbHandle = ReturnType<typeof openGoldDb>;

export const LIVE_WINDOW_MS = 5 * 60 * 1000;

export interface LiveTick {
  readonly sourceMarketId: string;
  readonly capturedAt: string;
  readonly impliedProbability: number | null;
  readonly volume: number;
  readonly isHeartbeat: number;
  readonly instrumentId: string | null;
  readonly rawFamily: string | null;
  readonly rawLabel: string | null;
}

export interface LiveResult {
  readonly gameId: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly ticks: readonly LiveTick[];
}

export interface GetLiveArgs {
  readonly goldDbPath: string;
  readonly gameId: string;
  readonly now?: Date;
}

export function getLive(args: GetLiveArgs): LiveResult {
  const now = args.now ?? new Date();
  const windowStart = new Date(now.getTime() - LIVE_WINDOW_MS);
  const startIso = windowStart.toISOString();
  const endIso = now.toISOString();
  const db = openGoldDb(args.goldDbPath);
  try {
    const ticks = loadTicks(db, args.gameId, startIso, endIso);
    return {
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

function pickStringOrNull(rec: Record<string, unknown>, key: string): string | null {
  const v = rec[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new Error(`field ${key}: expected string or null`);
  return v;
}
