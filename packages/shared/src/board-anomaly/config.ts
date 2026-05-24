import {
  defaultBoardAnomalyDetectorConfig,
  type BoardAnomalyDetectorConfig,
} from "@signal-console/domain";

export function resolveBoardAnomalyConfig(
  partial?: Partial<BoardAnomalyDetectorConfig>
): BoardAnomalyDetectorConfig {
  if (!partial) {
    return defaultBoardAnomalyDetectorConfig;
  }
  return {
    ...defaultBoardAnomalyDetectorConfig,
    ...partial,
    thresholds: {
      ...defaultBoardAnomalyDetectorConfig.thresholds,
      ...(partial.thresholds ?? {}),
    },
    weights: {
      ...defaultBoardAnomalyDetectorConfig.weights,
      ...(partial.weights ?? {}),
    },
    fanout: {
      ...defaultBoardAnomalyDetectorConfig.fanout,
      ...(partial.fanout ?? {}),
    },
    classification: {
      ...defaultBoardAnomalyDetectorConfig.classification,
      ...(partial.classification ?? {}),
    },
    gameStateVolatility: {
      ...defaultBoardAnomalyDetectorConfig.gameStateVolatility,
      ...(partial.gameStateVolatility ?? {}),
    },
    suppression: {
      ...defaultBoardAnomalyDetectorConfig.suppression,
      ...(partial.suppression ?? {}),
    },
  };
}

export function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

export function scoreToSeverity(score: number) {
  if (score >= 85) return "critical" as const;
  if (score >= 65) return "high" as const;
  if (score >= 40) return "medium" as const;
  return "low" as const;
}
