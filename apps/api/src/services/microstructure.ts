// Microstructure service (US-029 / PRD §15).
//
// Backs GET /v1/microstructure/:gameId. Reads market_microstructure_events
// filtered by game_id and a volume_share threshold. The query hits
// idx_market_microstructure_game_time (game_id, event_timestamp DESC), per
// the verify:queries snapshot at
// packages/db/src/queries/__tests__/__snapshots__/microstructure-for-one-game.plan.txt.

import { openGoldDb } from "@signal-console/db";

type GoldDbHandle = ReturnType<typeof openGoldDb>;

export const DEFAULT_THETA = 0.1;

export interface MicrostructureEvent {
  readonly id: number;
  readonly source: string;
  readonly sourceMarketId: string;
  readonly gameId: string;
  readonly instrumentId: string | null;
  readonly eventType: string;
  readonly apiSurface: string;
  readonly eventTimestamp: string;
  readonly capturedAt: string;
  readonly price: number | null;
  readonly previousPrice: number | null;
  readonly tradePrice: number | null;
  readonly size: number | null;
  readonly notional: number | null;
  readonly volume: number | null;
  readonly finalMarketVolume: number | null;
  readonly volumeShare: number | null;
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
  readonly spread: number | null;
  readonly depthScore: number | null;
}

export interface MicrostructureResult {
  readonly gameId: string;
  readonly theta: number;
  readonly events: readonly MicrostructureEvent[];
}

export interface GetMicrostructureArgs {
  readonly goldDbPath: string;
  readonly gameId: string;
  readonly theta: number;
}

export function getMicrostructure(args: GetMicrostructureArgs): MicrostructureResult {
  const db = openGoldDb(args.goldDbPath);
  try {
    const events = loadEvents(db, args.gameId, args.theta);
    return {
      gameId: args.gameId,
      theta: args.theta,
      events,
    };
  } finally {
    db.close();
  }
}

function loadEvents(
  db: GoldDbHandle,
  gameId: string,
  theta: number,
): readonly MicrostructureEvent[] {
  const rows = db
    .prepare(
      `SELECT id,
              source,
              source_market_id,
              game_id,
              instrument_id,
              event_type,
              api_surface,
              event_timestamp,
              captured_at,
              price,
              previous_price,
              trade_price,
              size,
              notional,
              volume,
              final_market_volume,
              volume_share,
              best_bid,
              best_ask,
              spread,
              depth_score
       FROM market_microstructure_events
       WHERE game_id = ?
         AND volume_share IS NOT NULL
         AND volume_share >= ?
       ORDER BY event_timestamp`,
    )
    .all(gameId, theta);
  return rows.map((row): MicrostructureEvent => {
    if (!isRecord(row)) throw new Error("microstructure row not an object");
    return {
      id: pickNumber(row, "id"),
      source: pickString(row, "source"),
      sourceMarketId: pickString(row, "source_market_id"),
      gameId: pickString(row, "game_id"),
      instrumentId: pickStringOrNull(row, "instrument_id"),
      eventType: pickString(row, "event_type"),
      apiSurface: pickString(row, "api_surface"),
      eventTimestamp: pickString(row, "event_timestamp"),
      capturedAt: pickString(row, "captured_at"),
      price: pickNumberOrNull(row, "price"),
      previousPrice: pickNumberOrNull(row, "previous_price"),
      tradePrice: pickNumberOrNull(row, "trade_price"),
      size: pickNumberOrNull(row, "size"),
      notional: pickNumberOrNull(row, "notional"),
      volume: pickNumberOrNull(row, "volume"),
      finalMarketVolume: pickNumberOrNull(row, "final_market_volume"),
      volumeShare: pickNumberOrNull(row, "volume_share"),
      bestBid: pickNumberOrNull(row, "best_bid"),
      bestAsk: pickNumberOrNull(row, "best_ask"),
      spread: pickNumberOrNull(row, "spread"),
      depthScore: pickNumberOrNull(row, "depth_score"),
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

function pickNumberOrNull(rec: Record<string, unknown>, key: string): number | null {
  const v = rec[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== "number") throw new Error(`field ${key}: expected number or null`);
  return v;
}
