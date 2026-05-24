import type { BoardObservation } from "@signal-console/domain";

import { loadGameContext } from "./board-anomaly-observation-context";
import {
  microstructureRowToObservation,
  quoteRowToObservation,
  type MicrostructureRow,
  type QuoteRow,
} from "./board-anomaly-observation-converters";
import { parseTimestampMs } from "./board-anomaly-support";
import { executeDatabaseOperation, getDatabase } from "./db-core";

import type { GameStateRow } from "./board-anomaly-observation-context";

const STALE_QUOTE_AGE_MS = 10 * 60_000;

export type MaterializeBoardObservationsInput = {
  gameId: string;
  windowStart: string;
  windowEnd: string;
};

export type BoardObservationMaterializationDiagnostics = {
  filteredReasonCounts: Record<string, number>;
  latestQuoteAt: string | null;
  materializedObservationRows: number;
  rawMicrostructureRows: number;
  rawQuoteRows: number;
};

export function materializeBoardObservations(
  input: MaterializeBoardObservationsInput
): {
  diagnostics: BoardObservationMaterializationDiagnostics;
  gameLabel: string;
  observations: BoardObservation[];
  gameStates: GameStateRow[];
  scheduledStart: string;
} | null {
  return executeDatabaseOperation(
    "board-anomaly.materializeBoardObservations",
    () => {
      const context = loadGameContext(input.gameId);
      if (!context) return null;
      const db = getDatabase();
      const scheduledStartMs =
        parseTimestampMs(context.game.scheduledStart) ?? Number.NaN;

      const quoteRows = db
        .prepare(
          `SELECT
             qt.id AS observationId,
             qt.source_market_id AS sourceMarketId,
             sm.source AS source,
             sm.instrument_id AS instrumentId,
             sm.raw_family AS rawFamily,
             sm.raw_label AS rawLabel,
             sm.mapping_status AS mappingStatus,
             mi.family AS family,
             mi.selection AS selection,
             mi.participant_key AS participantKey,
             mi.line AS line,
             mi.display_label AS displayLabel,
             qt.captured_at AS capturedAt,
             COALESCE(
               qt.implied_probability,
               CASE WHEN qt.price_raw BETWEEN 0 AND 1 THEN qt.price_raw END
             ) AS impliedProbability,
             qt.line_raw AS lineRaw,
             qt.best_bid AS bestBid,
             qt.best_ask AS bestAsk,
             CAST(
               COALESCE(
                 qt.volume,
                 json_extract(sm.raw_metadata_json, '$.volumeFp'),
                 json_extract(sm.raw_metadata_json, '$.volume24hFp')
               ) AS REAL
             ) AS volume,
             CASE
               WHEN qt.volume IS NOT NULL THEN 'quote-tick'
               WHEN COALESCE(
                 json_extract(sm.raw_metadata_json, '$.volumeFp'),
                 json_extract(sm.raw_metadata_json, '$.volume24hFp')
               ) IS NOT NULL THEN 'source-market-metadata'
               ELSE NULL
             END AS volumeSource,
             qt.depth_score AS depthScore,
             qt.is_heartbeat AS isHeartbeat
           FROM quote_ticks qt
           JOIN source_markets sm ON sm.id = qt.source_market_id
           LEFT JOIN market_instruments mi ON mi.id = sm.instrument_id
           WHERE sm.game_id = ?
             AND qt.captured_at >= ?
             AND qt.captured_at <= ?
             AND qt.is_heartbeat = 0
             AND COALESCE(
               qt.implied_probability,
               CASE WHEN qt.price_raw BETWEEN 0 AND 1 THEN qt.price_raw END
             ) IS NOT NULL
           ORDER BY qt.captured_at ASC, qt.id ASC`
        )
        .all(input.gameId, input.windowStart, input.windowEnd) as Omit<
        QuoteRow,
        "observationKind"
      >[];

      const latestQuoteAt =
        quoteRows.reduce<string | null>((latest, row) => {
          if (!latest) return row.capturedAt;
          return row.capturedAt > latest ? row.capturedAt : latest;
        }, null) ?? null;

      const microRows = db
        .prepare(
          `SELECT
             mme.id AS observationId,
             mme.source_market_id AS sourceMarketId,
             mme.source AS source,
             mme.instrument_id AS instrumentId,
             sm.raw_family AS rawFamily,
             sm.raw_label AS rawLabel,
             sm.mapping_status AS mappingStatus,
             mi.family AS family,
             mi.selection AS selection,
             mi.participant_key AS participantKey,
             mi.line AS line,
             mi.display_label AS displayLabel,
             mme.event_type AS eventType,
             mme.api_surface AS apiSurface,
             mme.event_timestamp AS eventTimestamp,
             mme.captured_at AS capturedAt,
             mme.price AS price,
             mme.previous_price AS previousPrice,
             mme.trade_price AS tradePrice,
             mme.size AS size,
             mme.notional AS notional,
             mme.volume AS volume,
             mme.final_market_volume AS finalMarketVolume,
             CASE
               WHEN mme.volume_share >= 0 AND mme.volume_share <= 1 THEN mme.volume_share
               ELSE NULL
             END AS volumeShare,
             mme.best_bid AS bestBid,
             mme.best_ask AS bestAsk,
             mme.spread AS spread,
             mme.depth_score AS depthScore
           FROM market_microstructure_events mme
           JOIN source_markets sm ON sm.id = mme.source_market_id
           LEFT JOIN market_instruments mi ON mi.id = mme.instrument_id
           WHERE mme.game_id = ?
             AND mme.event_timestamp >= ?
             AND mme.event_timestamp <= ?
           ORDER BY mme.event_timestamp ASC, mme.id ASC`
        )
        .all(input.gameId, input.windowStart, input.windowEnd) as Omit<
        MicrostructureRow,
        "observationKind"
      >[];

      const previousProbabilityByMarket = new Map<string, number | null>();
      const observations: BoardObservation[] = [];
      const filteredReasonCounts: Record<string, number> = {};
      const incrementFiltered = (reason: string) => {
        filteredReasonCounts[reason] = (filteredReasonCounts[reason] ?? 0) + 1;
      };

      for (const row of quoteRows) {
        const observation = quoteRowToObservation(
          { ...row, observationKind: "quote" } as QuoteRow,
          context.gameStates,
          scheduledStartMs,
          previousProbabilityByMarket
        );
        if (!observation) {
          incrementFiltered("invalid-quote-row");
          continue;
        }
        if (
          Math.abs(observation.logitMove ?? 0) < 1e-6 &&
          Math.abs(observation.lineMove ?? 0) < 1e-6 &&
          observation.sourceKind !== "prediction-market"
        ) {
          incrementFiltered("unchanged-sportsbook-quote");
          continue;
        }
        observation.gameId = input.gameId;
        observations.push(observation);
      }

      for (const row of microRows) {
        const observation = microstructureRowToObservation(
          { ...row, observationKind: "microstructure" } as MicrostructureRow,
          context.gameStates,
          scheduledStartMs
        );
        if (!observation) {
          incrementFiltered("invalid-microstructure-row");
          continue;
        }
        observation.gameId = input.gameId;
        observations.push(observation);
      }

      const windowEndMs = parseTimestampMs(input.windowEnd);
      if (windowEndMs != null) {
        for (const observation of observations) {
          const eventMs =
            parseTimestampMs(observation.eventTimestamp) ??
            parseTimestampMs(observation.capturedAt);
          if (eventMs == null) continue;
          const age = windowEndMs - eventMs;
          observation.quoteAgeMs = Math.max(0, age);
          if (age >= STALE_QUOTE_AGE_MS) {
            observation.flags = { ...observation.flags, isStale: true };
          }
        }
      }

      const gameLabel = `${context.game.awayName} @ ${context.game.homeName}`;
      return {
        diagnostics: {
          filteredReasonCounts,
          latestQuoteAt,
          materializedObservationRows: observations.length,
          rawMicrostructureRows: microRows.length,
          rawQuoteRows: quoteRows.length,
        },
        gameLabel,
        observations,
        gameStates: context.gameStates,
        scheduledStart: context.game.scheduledStart,
      };
    },
    input
  );
}
