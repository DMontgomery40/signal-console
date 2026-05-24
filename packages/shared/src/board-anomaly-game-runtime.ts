import type {
  BoardAnomalyAlert,
  BoardAnomalyDetectorConfig,
  BoardAnomalyReplayOutput,
  BoardGameStateVolatility,
} from "@signal-console/domain";

import {
  detectBoardAnomalies as detectBoardAnomaliesPure,
  measureBoardGameStateVolatility as measureBoardGameStateVolatilityPure,
  replayBoardAnomalies as replayBoardAnomaliesPure,
} from "./board-anomaly";
import {
  materializeBoardObservations,
  type MaterializeBoardObservationsInput,
} from "./board-anomaly-observations";
import { parseTimestampMs } from "./board-anomaly-support";

export type { MaterializeBoardObservationsInput };

export type DetectBoardAnomaliesForGameInput = {
  gameId: string;
  now: string;
  contextWindowMinutes?: number;
  config?: Partial<BoardAnomalyDetectorConfig>;
};

export function detectBoardAnomaliesForGame(
  input: DetectBoardAnomaliesForGameInput
): BoardAnomalyAlert[] {
  const nowMs = parseTimestampMs(input.now);
  if (nowMs == null) return [];
  const contextMinutes = input.contextWindowMinutes ?? 30;
  const windowStart = new Date(nowMs - contextMinutes * 60_000).toISOString();
  const materialized = materializeBoardObservations({
    gameId: input.gameId,
    windowStart,
    windowEnd: input.now,
  });
  if (!materialized) return [];
  return detectBoardAnomaliesPure({
    gameId: input.gameId,
    gameLabel: materialized.gameLabel,
    gameStates: materialized.gameStates,
    materializationDiagnostics: materialized.diagnostics,
    observations: materialized.observations,
    now: input.now,
    scheduledStart: materialized.scheduledStart,
    config: input.config,
  });
}

export function measureGameStateVolatilityForGame(
  input: DetectBoardAnomaliesForGameInput
): BoardGameStateVolatility | null {
  const nowMs = parseTimestampMs(input.now);
  if (nowMs == null) return null;
  const contextMinutes = input.contextWindowMinutes ?? 30;
  const windowStart = new Date(nowMs - contextMinutes * 60_000).toISOString();
  const materialized = materializeBoardObservations({
    gameId: input.gameId,
    windowStart,
    windowEnd: input.now,
  });
  if (!materialized) return null;
  return measureBoardGameStateVolatilityPure({
    gameId: input.gameId,
    gameLabel: materialized.gameLabel,
    gameStates: materialized.gameStates,
    materializationDiagnostics: materialized.diagnostics,
    observations: materialized.observations,
    now: input.now,
    scheduledStart: materialized.scheduledStart,
    config: input.config,
  });
}

export type ReplayBoardAnomaliesForGameInput = {
  gameId: string;
  windowStart: string;
  windowEnd: string;
  stepSeconds?: number;
  ingestionLatencyBufferSeconds?: number;
  config?: Partial<BoardAnomalyDetectorConfig>;
};

export function replayBoardAnomaliesForGame(
  input: ReplayBoardAnomaliesForGameInput
): BoardAnomalyReplayOutput | null {
  const materialized = materializeBoardObservations({
    gameId: input.gameId,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
  });
  if (!materialized) return null;
  return replayBoardAnomaliesPure({
    gameId: input.gameId,
    gameLabel: materialized.gameLabel,
    gameStates: materialized.gameStates,
    observations: materialized.observations,
    scheduledStart: materialized.scheduledStart,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    stepSeconds: input.stepSeconds,
    ingestionLatencyBufferSeconds: input.ingestionLatencyBufferSeconds,
    config: input.config,
  });
}
