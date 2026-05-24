import type {
  BoardAnomalyAlert,
  BoardAnomalyDetectorConfig,
  BoardAnomalyDetectorInput,
  BoardGameStateVolatility,
  BoardAnomalyShockKind,
  BoardObservationScored,
} from "@signal-console/domain";

import {
  averageContribution,
  averageH0Suppression,
  averageMicrostructure,
  coverageRatio,
  evidenceFromScored,
  firstPopAtFromScored,
  h0DriversFromScored,
  instrumentIdsFromScored,
  missingDataNotesFromScored,
  observationTimestampMs,
  sourceMarketIdsFromScored,
  unmappedRatio,
  withinShockWindow,
} from "./alert-metrics";
import { classifyShock } from "./classifier";
import { clamp01, resolveBoardAnomalyConfig, scoreToSeverity } from "./config";
import { buildCoherenceClusters, type CoherenceCluster } from "./fanout";
import {
  buildGameStateVolatilityAlert,
  measureGameStateVolatility,
} from "./game-state-volatility";
import { computeH0Adjustment } from "./h0";
import { scoreObservation } from "./residual";

const ALERT_KIND_PRIORITY: Record<BoardAnomalyShockKind, number> = {
  "game-state-volatility": 60,
  "near-tip-availability": 50,
  "pregame-availability": 45,
  "attribution-shaped": 40,
  "cross-surface-disagreement": 35,
  "market-structure": 30,
  "coverage-gap": 20,
};

function trustedLiveStateWindow(scored: BoardObservationScored[]) {
  if (scored.length < 20) return false;
  const inPlayCount = scored.filter(
    (item) => item.observation.gameState.status === "in-play"
  ).length;
  return inPlayCount / scored.length >= 0.8;
}

export function compareBoardAnomalyAlerts(
  a: BoardAnomalyAlert,
  b: BoardAnomalyAlert
): number {
  const priorityDelta =
    ALERT_KIND_PRIORITY[b.shockKind] - ALERT_KIND_PRIORITY[a.shockKind];
  if (priorityDelta !== 0) return priorityDelta;
  return b.score - a.score;
}

function isWholeBoardTripwire(alert: BoardAnomalyAlert) {
  return (
    alert.shockKind === "game-state-volatility" ||
    alert.shockKind === "near-tip-availability" ||
    alert.shockKind === "pregame-availability" ||
    alert.primaryEntityKey == null
  );
}

function suppressForWholeGameTripwire(
  alert: BoardAnomalyAlert,
  gameStateVolatilityAlert: BoardAnomalyAlert | undefined,
  shockWindowMs: number
): boolean {
  if (!gameStateVolatilityAlert) return false;
  if (alert.shockKind === "game-state-volatility") return false;

  const alertFirstPopMs = Date.parse(alert.firstPopAt);
  const wholeGameFirstPopMs = Date.parse(gameStateVolatilityAlert.firstPopAt);
  if (
    !Number.isFinite(alertFirstPopMs) ||
    !Number.isFinite(wholeGameFirstPopMs)
  )
    return false;

  if (alertFirstPopMs < wholeGameFirstPopMs) return false;
  return alertFirstPopMs - wholeGameFirstPopMs <= shockWindowMs;
}

function clusterToAlert(
  cluster: CoherenceCluster,
  config: BoardAnomalyDetectorConfig,
  gameId: string,
  gameLabel: string,
  detectedAtIso: string
): BoardAnomalyAlert | null {
  if (cluster.participants.length < 2) return null;

  const classification = classifyShock(cluster, config);
  const firstPopParticipants =
    classification.primaryEntityKey == null
      ? cluster.participants
      : cluster.participants.filter((participant) => {
          const key =
            participant.observation.participantKey ??
            participant.observation.labels.participantHints[0] ??
            null;
          return key === classification.primaryEntityKey;
        });
  const baseContribution = averageContribution(cluster.participants);
  const nParticipants = cluster.participants.length;
  const nPairs = Math.max(1, (nParticipants * (nParticipants - 1)) / 2);
  const coherence = clamp01(cluster.coherenceScore / nPairs);
  const microstructureAverage = averageMicrostructure(cluster.participants);
  const coverage = clamp01(coverageRatio(cluster.participants));

  const sportsbookPredictionBoost =
    cluster.sportsbookContribution > 0 &&
    cluster.predictionMarketContribution > 0
      ? config.fanout.sportsbookPredictionDisagreementBoost
      : 0;

  const weightedScore =
    baseContribution * config.weights.residual +
    microstructureAverage * config.weights.microstructure +
    coherence * config.weights.coherence +
    sportsbookPredictionBoost * 0.1;

  const score = Math.round(clamp01(weightedScore) * 100);

  const confidenceBase = Math.min(
    0.95,
    0.55 + coherence * 0.25 + Math.min(0.15, cluster.participants.length * 0.03)
  );
  const confidence = Math.max(
    0,
    confidenceBase - unmappedRatio(cluster.participants) * 0.2 - coverage * 0.3
  );

  if (score < config.minScore || confidence < config.minConfidence) {
    return null;
  }

  const firstPopAt = firstPopAtFromScored(
    firstPopParticipants.length > 0
      ? firstPopParticipants
      : cluster.participants,
    detectedAtIso
  );
  const evidence = evidenceFromScored(cluster.participants);
  const missingDataNotes = missingDataNotesFromScored(cluster.participants);

  return {
    id: [
      "board-alert",
      gameId,
      classification.kind,
      classification.primaryEntityKey ?? "no-entity",
      firstPopAt,
    ].join(":"),
    gameId,
    gameLabel,
    shockKind: classification.kind,
    firstPopAt,
    detectedAt: detectedAtIso,
    score,
    confidence: Number(confidence.toFixed(3)),
    severity: scoreToSeverity(score),
    reason: classification.reason,
    primaryEntityKey: classification.primaryEntityKey,
    primaryFamily:
      cluster.participants.find((participant) => participant.observation.family)
        ?.observation.family ?? null,
    components: {
      residual: Number(baseContribution.toFixed(3)),
      microstructure: Number(microstructureAverage.toFixed(3)),
      coherence: Number(coherence.toFixed(3)),
      coverage: Number(coverage.toFixed(3)),
    },
    h0Adjustments: {
      appliedSuppression: Number(
        averageH0Suppression(cluster.participants).toFixed(3)
      ),
      drivers: h0DriversFromScored(cluster.participants),
    },
    evidence,
    missingDataNotes,
    inspect: {
      payloadVersion: 1,
      instrumentIds: instrumentIdsFromScored(cluster.participants),
      sourceMarketIds: sourceMarketIdsFromScored(cluster.participants),
      relationFamilies: cluster.relationFamilies,
    },
  };
}

export function detectBoardAnomalies(
  input: BoardAnomalyDetectorInput
): BoardAnomalyAlert[] {
  const config = resolveBoardAnomalyConfig(input.config);
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(nowMs)) {
    throw new Error(`Invalid "now" timestamp: ${input.now}`);
  }

  const shockWindowMs = config.shockWindowSeconds * 1000;
  const contextWindowMs = config.contextWindowMinutes * 60 * 1000;

  const inWindow = input.observations.filter((observation) => {
    const ts = observationTimestampMs(observation);
    if (!Number.isFinite(ts)) return false;
    if (ts > nowMs) return false;
    return nowMs - ts <= contextWindowMs;
  });

  if (inWindow.length === 0) return [];

  const scored: BoardObservationScored[] = inWindow.map((observation) =>
    scoreObservation(
      observation,
      computeH0Adjustment(observation, config),
      config
    )
  );

  const shockSet = scored.filter(
    (item) =>
      withinShockWindow(item.observation, nowMs, shockWindowMs) ||
      item.contribution > 0 ||
      item.observation.flags.isStale ||
      item.observation.missing.impliedProbability
  );

  if (shockSet.length < 2) {
    return [];
  }

  const clusters = buildCoherenceClusters(shockSet, config);
  const alerts: BoardAnomalyAlert[] = [];
  const trustedStateGate = trustedLiveStateWindow(shockSet);
  const gameStateVolatilityAlert = buildGameStateVolatilityAlert({
    scored,
    config,
    gameId: input.gameId,
    gameLabel: input.gameLabel,
    detectedAtIso: input.now,
    gameStates: input.gameStates,
    nowMs,
    scheduledStart: input.scheduledStart,
    shockWindowMs,
  });
  if (gameStateVolatilityAlert) {
    alerts.push(gameStateVolatilityAlert);
  }
  for (const cluster of clusters) {
    const alert = clusterToAlert(
      cluster,
      config,
      input.gameId,
      input.gameLabel,
      input.now
    );
    if (alert) {
      if (!isWholeBoardTripwire(alert) && !trustedStateGate) {
        continue;
      }
      if (
        gameStateVolatilityAlert &&
        alert.shockKind === "market-structure" &&
        alert.primaryEntityKey == null
      ) {
        continue;
      }
      alerts.push(alert);
    }
  }

  const dedupedByKind = new Map<string, BoardAnomalyAlert>();
  for (const alert of alerts) {
    const key = `${alert.shockKind}::${alert.primaryEntityKey ?? "no-entity"}`;
    const previous = dedupedByKind.get(key);
    if (!previous || alert.score > previous.score) {
      dedupedByKind.set(key, alert);
    }
  }
  const result = Array.from(dedupedByKind.values());
  const gameStateVolatilityTripwire = result.find(
    (alert) => alert.shockKind === "game-state-volatility"
  );
  const filtered = result.filter(
    (alert) =>
      !suppressForWholeGameTripwire(
        alert,
        gameStateVolatilityTripwire,
        shockWindowMs
      )
  );
  filtered.sort(compareBoardAnomalyAlerts);
  return filtered;
}

export function measureBoardGameStateVolatility(
  input: BoardAnomalyDetectorInput
): BoardGameStateVolatility | null {
  const config = resolveBoardAnomalyConfig(input.config);
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(nowMs)) {
    throw new Error(`Invalid "now" timestamp: ${input.now}`);
  }

  const shockWindowMs = config.shockWindowSeconds * 1000;
  const contextWindowMs = config.contextWindowMinutes * 60 * 1000;
  const inWindow = input.observations.filter((observation) => {
    const ts = observationTimestampMs(observation);
    if (!Number.isFinite(ts)) return false;
    if (ts > nowMs) return false;
    return nowMs - ts <= contextWindowMs;
  });

  const scored: BoardObservationScored[] = inWindow.map((observation) =>
    scoreObservation(
      observation,
      computeH0Adjustment(observation, config),
      config
    )
  );

  return measureGameStateVolatility({
    config,
    detectedAtIso: input.now,
    gameId: input.gameId,
    gameLabel: input.gameLabel,
    gameStates: input.gameStates,
    materializationDiagnostics: input.materializationDiagnostics,
    nowMs,
    scheduledStart: input.scheduledStart,
    scored,
    shockWindowMs,
  });
}
