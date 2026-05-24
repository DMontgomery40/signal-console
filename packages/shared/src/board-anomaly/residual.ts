import type {
  BoardAnomalyDetectorConfig,
  BoardObservation,
  BoardObservationScored,
  H0Adjustment,
} from "@signal-console/domain";

import { clamp01 } from "./config";

function normalizeOverThreshold(
  value: number | null | undefined,
  threshold: number
) {
  if (value == null || !Number.isFinite(value) || threshold <= 0) return 0;
  return clamp01(Math.abs(value) / threshold);
}

export function scoreObservation(
  observation: BoardObservation,
  h0: H0Adjustment,
  config: BoardAnomalyDetectorConfig
): BoardObservationScored {
  const absLogit = Math.abs(observation.logitMove ?? 0);
  const absLine = Math.abs(observation.lineMove ?? 0);

  const tradeDistance =
    observation.tradePrice != null &&
    observation.previousImpliedProbability != null
      ? Math.abs(
          observation.tradePrice - observation.previousImpliedProbability
        )
      : observation.tradePrice != null && observation.impliedProbability != null
        ? Math.abs(observation.tradePrice - observation.impliedProbability)
        : null;

  const residualLogit = Math.max(0, absLogit - h0.expectedAbsLogitMove);
  const residualLine =
    observation.sourceKind === "sportsbook"
      ? Math.max(0, absLine - h0.expectedAbsLineMove)
      : 0;
  const residualTradeDistance =
    observation.sourceKind === "prediction-market"
      ? Math.max(0, (tradeDistance ?? 0) - h0.expectedAbsTradeDistance)
      : 0;

  const microstructure = {
    crossVenue: 0,
    liquidity: 0,
    offPrice: 0,
    volatility: 0,
    volumeShare: 0,
  };

  if (observation.sourceKind === "prediction-market") {
    microstructure.offPrice = normalizeOverThreshold(
      residualTradeDistance,
      config.thresholds.tradeDistance
    );

    const spreadStress =
      observation.spread != null
        ? Math.max(0, observation.spread - h0.expectedSpreadFloor)
        : 0;
    const depthStress =
      observation.depthScore != null
        ? Math.max(
            0,
            (config.thresholds.depthScoreDrop - observation.depthScore) /
              Math.max(config.thresholds.depthScoreDrop, 0.001)
          )
        : 0;
    microstructure.liquidity = clamp01(
      Math.max(
        spreadStress / Math.max(config.thresholds.spread, 0.001),
        depthStress
      )
    );

    microstructure.volumeShare = normalizeOverThreshold(
      observation.volumeShare,
      config.thresholds.volumeShare
    );

    microstructure.volatility = normalizeOverThreshold(
      residualLogit,
      config.thresholds.logitMove
    );
  } else {
    microstructure.volatility = Math.max(
      normalizeOverThreshold(residualLogit, config.thresholds.logitMove),
      normalizeOverThreshold(residualLine, config.thresholds.lineMove)
    );
    if (observation.flags.isSuspended) {
      microstructure.liquidity = Math.max(microstructure.liquidity, 0.5);
    }
  }

  const suppressionFactor = h0.staleQuoteSuppression >= 1 ? 0.1 : 1;
  microstructure.crossVenue = 0;
  microstructure.offPrice *= suppressionFactor;
  microstructure.volatility *= suppressionFactor;
  microstructure.volumeShare *= suppressionFactor;
  microstructure.liquidity *= suppressionFactor;

  if (observation.missing.impliedProbability) {
    microstructure.volatility *= 0.5;
  }

  const residualContribution = clamp01(
    Math.max(
      normalizeOverThreshold(residualLogit, config.thresholds.logitMove),
      normalizeOverThreshold(residualLine, config.thresholds.lineMove),
      normalizeOverThreshold(
        residualTradeDistance,
        config.thresholds.tradeDistance
      )
    )
  );
  const microstructureContribution = clamp01(
    Math.max(
      microstructure.crossVenue,
      microstructure.offPrice,
      microstructure.volatility,
      microstructure.volumeShare
    )
  );

  const contribution = clamp01(
    Math.max(residualContribution, microstructureContribution)
  );

  const reasonParts: string[] = [];
  if (residualLogit > 0) {
    reasonParts.push(`logit ${residualLogit.toFixed(2)} after H0`);
  }
  if (residualLine > 0) {
    reasonParts.push(`line ${residualLine.toFixed(2)} after H0`);
  }
  if (residualTradeDistance > 0) {
    reasonParts.push(`off-price ${residualTradeDistance.toFixed(2)}`);
  }
  if (microstructure.volumeShare > 0) {
    reasonParts.push(
      `vol-share ${(microstructure.volumeShare * 100).toFixed(0)}%`
    );
  }
  if (microstructure.liquidity > 0.3) {
    reasonParts.push("liquidity stress");
  }
  if (suppressionFactor < 1) {
    reasonParts.push("H0 suppressed (stale)");
  }

  return {
    observation,
    residualLogit,
    residualLine,
    residualTradeDistance: residualTradeDistance,
    microstructure,
    h0Adjustment: h0,
    h0Suppressed: 1 - suppressionFactor,
    contribution,
    reason: reasonParts.length > 0 ? reasonParts.join("; ") : "no residual",
  };
}
