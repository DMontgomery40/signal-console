// Microstructure-event loader for off-price-print and ensemble-or.
//
// Extracted from services/backtest.ts:594-638 (audit-fix phase A0, 2026-05-24)
// so the new live routes (/v1/off-price-print/:gameId, /v1/ensemble-or/:gameId)
// and the backtest route share the same SQL contract. The off_price_distance
// column is computed at query time as |trade_price - latest_prior_implied_prob|
// via a causal subquery — never reads ticks after event_timestamp — using the
// (source_market_id, captured_at DESC) index for O(log N) per event.

import type { openGoldDb } from "@signal-console/db";
import type { MicrostructureEvent } from "@signal-console/detectors";

type GoldDbHandle = ReturnType<typeof openGoldDb>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const pickString = (rec: Record<string, unknown>, key: string): string => {
  const v = rec[key];
  if (typeof v !== "string") throw new Error(`field ${key}: expected string`);
  return v;
};

const pickNumber = (rec: Record<string, unknown>, key: string): number => {
  const v = rec[key];
  if (typeof v !== "number") throw new Error(`field ${key}: expected number`);
  return v;
};

export function loadMicrostructureForGames(
  goldDb: GoldDbHandle,
  gameIds: readonly string[],
  windowStart: string,
  windowEnd: string,
): readonly MicrostructureEvent[] {
  if (gameIds.length === 0) return [];
  const placeholders = gameIds.map(() => "?").join(",");
  const rows = goldDb
    .prepare(
      `SELECT e.game_id, e.source_market_id, e.event_timestamp, e.source,
              COALESCE(e.volume_share, 0) AS volume_share,
              COALESCE(ABS(e.trade_price - (
                SELECT qt.implied_probability
                FROM quote_ticks qt
                WHERE qt.source_market_id = e.source_market_id
                  AND qt.captured_at <= e.event_timestamp
                ORDER BY qt.captured_at DESC
                LIMIT 1
              )), 0) AS off_price_distance
       FROM market_microstructure_events e
       WHERE e.game_id IN (${placeholders})
         AND e.source = 'polymarket'
         AND e.event_type = 'trade'
         AND e.event_timestamp >= ?
         AND e.event_timestamp <= ?
       ORDER BY e.game_id, e.event_timestamp`,
    )
    .all(...gameIds, windowStart, windowEnd);
  return rows.map((row): MicrostructureEvent => {
    if (!isRecord(row)) throw new Error("microstructure row not an object");
    return {
      gameId: pickString(row, "game_id"),
      sourceMarketId: pickString(row, "source_market_id"),
      eventTimestamp: new Date(pickString(row, "event_timestamp")),
      source: pickString(row, "source"),
      volumeShare: pickNumber(row, "volume_share"),
      offPriceDistance: pickNumber(row, "off_price_distance"),
    };
  });
}
