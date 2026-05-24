import type {
  BoardAnomalyDetectorConfig,
  BoardAnomalyShockKind,
  BoardObservationScored,
} from "@signal-console/domain";

import type { CoherenceCluster } from "./fanout";

export type ShockClassification = {
  kind: BoardAnomalyShockKind;
  reason: string;
  primaryEntityKey: string | null;
};

function gameStatusSummary(participants: BoardObservationScored[]): {
  hasPregame: boolean;
  hasInPlay: boolean;
  minMinutesToTip: number | null;
  closeMargin: boolean;
} {
  let hasPregame = false;
  let hasInPlay = false;
  let minMinutesToTip: number | null = null;
  let closeMargin = false;
  for (const participant of participants) {
    const state = participant.observation.gameState;
    if (state.status === "scheduled") hasPregame = true;
    if (state.status === "in-play") hasInPlay = true;
    if (state.minutesToTip != null) {
      if (minMinutesToTip == null || state.minutesToTip < minMinutesToTip) {
        minMinutesToTip = state.minutesToTip;
      }
    }
    if (Math.abs(state.scoreMargin ?? 0) <= 5 && state.status === "in-play") {
      closeMargin = true;
    }
  }
  return { hasPregame, hasInPlay, minMinutesToTip, closeMargin };
}

function dominantParticipantKey(cluster: CoherenceCluster): string | null {
  const tally = new Map<string, number>();
  for (const participant of cluster.participants) {
    const key =
      participant.observation.participantKey ??
      participant.observation.labels.participantHints[0] ??
      null;
    if (!key) continue;
    tally.set(key, (tally.get(key) ?? 0) + participant.contribution);
  }
  if (tally.size === 0) return null;
  let best: [string, number] | null = null;
  for (const entry of tally.entries()) {
    if (!best || entry[1] > best[1]) best = entry;
  }
  return best ? best[0] : null;
}

function hasCompoundFanout(cluster: CoherenceCluster): boolean {
  const families = new Set(
    cluster.participants
      .map((participant) => participant.observation.family)
      .filter((value): value is NonNullable<typeof value> => value != null)
  );
  if (families.size >= 2) return true;
  const statFamilies = new Set(
    cluster.participants
      .flatMap((participant) => participant.observation.labels.statFamilyHints)
      .filter((value) => value.length > 0)
  );
  return statFamilies.size >= 2;
}

function hasCrossSurfaceDisagreement(cluster: CoherenceCluster): boolean {
  if (cluster.sportsbookContribution <= 0) return false;
  if (cluster.predictionMarketContribution <= 0) return false;
  const ratio =
    Math.min(
      cluster.sportsbookContribution,
      cluster.predictionMarketContribution
    ) /
    Math.max(
      cluster.sportsbookContribution,
      cluster.predictionMarketContribution
    );
  return ratio >= 0.4;
}

function hasMissingExpectedSource(
  participants: BoardObservationScored[]
): boolean {
  return participants.some(
    (participant) =>
      participant.observation.flags.isStale ||
      participant.observation.missing.impliedProbability
  );
}

export function classifyShock(
  cluster: CoherenceCluster,
  config: BoardAnomalyDetectorConfig
): ShockClassification {
  const status = gameStatusSummary(cluster.participants);
  const primaryEntityKey = dominantParticipantKey(cluster);
  const reasonParts: string[] = [];

  if (status.hasPregame && !status.hasInPlay) {
    const isNearTip =
      status.minMinutesToTip != null &&
      status.minMinutesToTip <= config.classification.nearTipMinutesToTip;
    if (isNearTip) {
      reasonParts.push(
        `near-tip board repricing across ${cluster.relationFamilies.join(", ")}`
      );
      if (primaryEntityKey)
        reasonParts.push(`primary entity ${primaryEntityKey}`);
      return {
        kind: "near-tip-availability",
        reason: reasonParts.join("; "),
        primaryEntityKey,
      };
    }
    reasonParts.push(
      `pregame board repricing across ${cluster.relationFamilies.join(", ")}`
    );
    if (primaryEntityKey)
      reasonParts.push(`primary entity ${primaryEntityKey}`);
    return {
      kind: "pregame-availability",
      reason: reasonParts.join("; "),
      primaryEntityKey,
    };
  }

  if (
    status.hasInPlay &&
    primaryEntityKey &&
    hasCompoundFanout(cluster) &&
    cluster.participants.length >=
      config.classification.attributionMinComponents
  ) {
    reasonParts.push(
      `attribution-shaped fanout on ${primaryEntityKey} across ${cluster.relationFamilies.join(", ")}`
    );
    if (status.closeMargin) reasonParts.push("close margin context");
    return {
      kind: "attribution-shaped",
      reason: reasonParts.join("; "),
      primaryEntityKey,
    };
  }

  if (hasCrossSurfaceDisagreement(cluster)) {
    reasonParts.push(
      `sportsbook vs prediction-market disagreement (sportsbook ${cluster.sportsbookContribution.toFixed(2)}, prediction-market ${cluster.predictionMarketContribution.toFixed(2)})`
    );
    return {
      kind: "cross-surface-disagreement",
      reason: reasonParts.join("; "),
      primaryEntityKey,
    };
  }

  if (hasMissingExpectedSource(cluster.participants)) {
    reasonParts.push("peers moving while expected source is stale or missing");
    return {
      kind: "coverage-gap",
      reason: reasonParts.join("; "),
      primaryEntityKey,
    };
  }

  const microstructureTotal = cluster.participants.reduce(
    (sum, participant) => {
      return (
        sum +
        participant.microstructure.offPrice +
        participant.microstructure.volumeShare +
        participant.microstructure.liquidity
      );
    },
    0
  );
  reasonParts.push(
    `market-structure activity (microstructure total ${microstructureTotal.toFixed(2)})`
  );
  return {
    kind: "market-structure",
    reason: reasonParts.join("; "),
    primaryEntityKey,
  };
}
