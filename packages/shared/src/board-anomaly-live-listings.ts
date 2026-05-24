import type {
  BoardAnomalyAlert,
  BoardAnomalyDetectorConfig,
  BoardGameStateVolatility,
} from "@signal-console/domain";

import { compareBoardAnomalyAlerts } from "./board-anomaly";
import {
  detectBoardAnomaliesForGame,
  measureGameStateVolatilityForGame,
} from "./board-anomaly-game-runtime";
import { parseTimestampMs } from "./board-anomaly-support";
import { executeDatabaseOperation, getDatabase } from "./db-core";

export type ListBoardAnomaliesAcrossGamesInput = {
  now: string;
  contextWindowMinutes?: number;
  candidateGameLimit?: number;
  gameIds?: string[];
  limit?: number;
  config?: Partial<BoardAnomalyDetectorConfig>;
};

export function listBoardAnomaliesAcrossGames(
  input: ListBoardAnomaliesAcrossGamesInput
): BoardAnomalyAlert[] {
  return executeDatabaseOperation(
    "board-anomaly.listAcrossGames",
    () => {
      const db = getDatabase();
      const nowMs = parseTimestampMs(input.now);
      if (nowMs == null) return [];
      const lookbackMs = (input.contextWindowMinutes ?? 30) * 60_000;
      const sinceIso = new Date(nowMs - lookbackMs).toISOString();
      let gameIds = input.gameIds;
      if (!gameIds || gameIds.length === 0) {
        const alertLimit = Math.max(1, Math.min(50, input.limit ?? 10));
        const candidateGameLimit = Math.max(
          1,
          Math.min(25, input.candidateGameLimit ?? alertLimit * 4)
        );
        gameIds = db
          .prepare(
            `SELECT id
             FROM (
               SELECT
                 sm.game_id AS id,
                 MAX(qt.captured_at) AS latestAt
               FROM quote_ticks qt
               JOIN source_markets sm ON sm.id = qt.source_market_id
               WHERE qt.is_heartbeat = 0
                 AND qt.captured_at >= ?
                 AND (qt.implied_probability IS NOT NULL OR qt.price_raw IS NOT NULL)
               GROUP BY sm.game_id
               UNION ALL
               SELECT
                 mme.game_id AS id,
                 MAX(mme.event_timestamp) AS latestAt
               FROM market_microstructure_events mme
               WHERE mme.event_timestamp >= ?
               GROUP BY mme.game_id
             )
             GROUP BY id
             ORDER BY MAX(latestAt) DESC
             LIMIT ?`
          )
          .all(sinceIso, sinceIso, candidateGameLimit)
          .map((row) => (row as { id: string }).id);
      }
      const alerts: BoardAnomalyAlert[] = [];
      for (const gameId of gameIds) {
        const gameAlerts = detectBoardAnomaliesForGame({
          gameId,
          now: input.now,
          contextWindowMinutes: input.contextWindowMinutes,
          config: input.config,
        });
        alerts.push(...gameAlerts);
      }
      alerts.sort(compareBoardAnomalyAlerts);
      const limit = Math.max(1, Math.min(50, input.limit ?? 10));
      return alerts.slice(0, limit);
    },
    input
  );
}

export function listGameStateVolatilityAcrossGames(
  input: ListBoardAnomaliesAcrossGamesInput
): BoardGameStateVolatility[] {
  return executeDatabaseOperation(
    "board-anomaly.listGameStateVolatility",
    () => {
      const db = getDatabase();
      const nowMs = parseTimestampMs(input.now);
      if (nowMs == null) return [];
      const lookbackMs = (input.contextWindowMinutes ?? 30) * 60_000;
      const sinceIso = new Date(nowMs - lookbackMs).toISOString();
      let gameIds = input.gameIds;
      if (!gameIds || gameIds.length === 0) {
        const alertLimit = Math.max(1, Math.min(50, input.limit ?? 10));
        const candidateGameLimit = Math.max(
          1,
          Math.min(25, input.candidateGameLimit ?? alertLimit * 4)
        );
        gameIds = db
          .prepare(
            `SELECT id
             FROM (
               SELECT
                 sm.game_id AS id,
                 MAX(qt.captured_at) AS latestAt
               FROM quote_ticks qt
               JOIN source_markets sm ON sm.id = qt.source_market_id
               WHERE qt.is_heartbeat = 0
                 AND qt.captured_at >= ?
                 AND sm.source IN ('kalshi', 'polymarket')
                 AND (qt.implied_probability IS NOT NULL OR qt.price_raw IS NOT NULL)
               GROUP BY sm.game_id
               UNION ALL
               SELECT
                 mme.game_id AS id,
                 MAX(mme.event_timestamp) AS latestAt
               FROM market_microstructure_events mme
               WHERE mme.event_timestamp >= ?
                 AND mme.source IN ('kalshi', 'polymarket')
               GROUP BY mme.game_id
             )
             GROUP BY id
             ORDER BY MAX(latestAt) DESC
             LIMIT ?`
          )
          .all(sinceIso, sinceIso, candidateGameLimit)
          .map((row) => (row as { id: string }).id);
      }

      const rows = gameIds
        .map((gameId) =>
          measureGameStateVolatilityForGame({
            gameId,
            now: input.now,
            contextWindowMinutes: input.contextWindowMinutes,
            config: input.config,
          })
        )
        .filter((row): row is BoardGameStateVolatility => row != null)
        .sort((left, right) => {
          const readyDelta =
            Number(right.sample.ready) - Number(left.sample.ready);
          if (readyDelta !== 0) return readyDelta;
          const stateRank = (row: BoardGameStateVolatility) => {
            switch (row.state) {
              case "critical":
                return 4;
              case "alert":
                return 3;
              case "elevated":
                return 2;
              case "normal":
                return 1;
              case "insufficient-data":
              default:
                return 0;
            }
          };
          const stateDelta = stateRank(right) - stateRank(left);
          if (stateDelta !== 0) return stateDelta;
          if (right.score !== left.score) return right.score - left.score;
          return (
            right.sample.predictionMarketRows - left.sample.predictionMarketRows
          );
        });
      const limit = Math.max(1, Math.min(50, input.limit ?? 10));
      return rows.slice(0, limit);
    },
    input
  );
}
