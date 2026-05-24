import type {
  BoardAnomalyAlert,
  BoardAnomalyReplayInput,
  BoardAnomalyReplayOutput,
  BoardObservation,
} from "@signal-console/domain";

import { resolveBoardAnomalyConfig } from "./config";
import { detectBoardAnomalies } from "./detector";

function observationTimestampMs(observation: BoardObservation): number {
  const eventTs = Date.parse(observation.eventTimestamp);
  if (Number.isFinite(eventTs)) return eventTs;
  return Date.parse(observation.capturedAt);
}

function dedupeKey(alert: BoardAnomalyAlert): string {
  return `${alert.shockKind}::${alert.primaryEntityKey ?? "no-entity"}`;
}

export function replayBoardAnomalies(
  input: BoardAnomalyReplayInput
): BoardAnomalyReplayOutput {
  const config = resolveBoardAnomalyConfig(input.config);

  const startMs = Date.parse(input.windowStart);
  const endMs = Date.parse(input.windowEnd);
  const bufferMs = (input.ingestionLatencyBufferSeconds ?? 60) * 1000;
  const stepMs = Math.max(1_000, (input.stepSeconds ?? 30) * 1000);

  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    endMs <= startMs
  ) {
    return {
      gameId: input.gameId,
      gameLabel: input.gameLabel,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      alertDeck: [],
    };
  }

  const cappedEndMs = endMs + bufferMs;

  const inOperationalWindow = input.observations
    .filter((observation) => {
      const ts = observationTimestampMs(observation);
      if (!Number.isFinite(ts)) return false;
      return (
        ts >= startMs - config.contextWindowMinutes * 60 * 1000 &&
        ts <= cappedEndMs
      );
    })
    .sort((a, b) => observationTimestampMs(a) - observationTimestampMs(b));

  if (inOperationalWindow.length === 0) {
    return {
      gameId: input.gameId,
      gameLabel: input.gameLabel,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      alertDeck: [],
    };
  }

  const alertDeck: BoardAnomalyAlert[] = [];
  const lastEmittedByKey = new Map<string, BoardAnomalyAlert>();
  const contextWindowMs = config.contextWindowMinutes * 60 * 1000;
  let firstObservationIndex = 0;
  let nextObservationIndex = 0;

  for (let clockMs = startMs; clockMs <= cappedEndMs; clockMs += stepMs) {
    while (
      nextObservationIndex < inOperationalWindow.length &&
      observationTimestampMs(inOperationalWindow[nextObservationIndex]) <=
        clockMs
    ) {
      nextObservationIndex += 1;
    }
    if (nextObservationIndex < 2) continue;
    while (
      firstObservationIndex < nextObservationIndex &&
      observationTimestampMs(inOperationalWindow[firstObservationIndex]) <
        clockMs - contextWindowMs
    ) {
      firstObservationIndex += 1;
    }
    const observationsUpToClock = inOperationalWindow.slice(
      firstObservationIndex,
      nextObservationIndex
    );
    if (observationsUpToClock.length < 2) continue;

    const nowIso = new Date(clockMs).toISOString();
    const alerts = detectBoardAnomalies({
      gameId: input.gameId,
      gameLabel: input.gameLabel,
      gameStates: input.gameStates,
      observations: observationsUpToClock,
      now: nowIso,
      scheduledStart: input.scheduledStart,
      config: input.config,
    });

    for (const alert of alerts) {
      const key = dedupeKey(alert);
      const previous = lastEmittedByKey.get(key);
      if (previous) {
        const isMaterial =
          alert.confidence - previous.confidence >=
            config.suppression.materialConfidenceJump ||
          alert.score - previous.score >= 15 ||
          alert.primaryEntityKey !== previous.primaryEntityKey;
        if (!isMaterial) {
          continue;
        }
      }
      const candidate: BoardAnomalyAlert = {
        ...alert,
        detectedAt: nowIso,
      };
      lastEmittedByKey.set(key, candidate);
      alertDeck.push(candidate);
    }
  }

  alertDeck.sort((a, b) => Date.parse(a.firstPopAt) - Date.parse(b.firstPopAt));

  return {
    gameId: input.gameId,
    gameLabel: input.gameLabel,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    alertDeck,
  };
}
