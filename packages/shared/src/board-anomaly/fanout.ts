import type {
  BoardAnomalyDetectorConfig,
  BoardObservationScored,
} from "@signal-console/domain";

import { tokenizeBoardText } from "../board-anomaly-support";

const SCORING_STAT_FAMILIES = new Set([
  "points",
  "threes",
  "made-shot",
  "scoring",
]);

const POSSESSION_STAT_FAMILIES = new Set([
  "rebounds",
  "assists",
  "blocks",
  "steals",
  "turnovers",
]);

const COMPOUND_PARENTS: Record<string, string[]> = {
  rebounds: ["pra", "ra", "double-double", "triple-double"],
  assists: ["pra", "pa", "double-double", "triple-double"],
  points: [
    "pra",
    "pa",
    "double-double",
    "triple-double",
    "team-total",
    "race-to-x",
  ],
  threes: ["points", "team-total", "race-to-x"],
};

export type RelationKey =
  | { kind: "game"; key: string }
  | { kind: "participant"; key: string }
  | { kind: "paired-participant"; key: string }
  | { kind: "team"; key: string }
  | { kind: "stat-family"; key: string }
  | { kind: "compound-stat"; key: string }
  | { kind: "market-family"; key: string }
  | { kind: "label-token"; key: string };

function tokenize(label: string | null | undefined): string[] {
  return tokenizeBoardText(label);
}

function statFamilyFromTokens(tokens: string[]): string | null {
  for (const token of tokens) {
    if (token.startsWith("rebound")) return "rebounds";
    if (token.startsWith("assist")) return "assists";
    if (token.startsWith("steal")) return "steals";
    if (token.startsWith("block")) return "blocks";
    if (token.startsWith("three") || token === "3pt" || token === "3s")
      return "threes";
    if (token === "pts" || token.startsWith("point")) return "points";
    if (token === "pra") return "pra";
    if (token === "ra") return "ra";
    if (token === "pa") return "pa";
    if (token.includes("double")) return "double-double";
  }
  return null;
}

export function deriveRelationKeys(
  scored: BoardObservationScored
): RelationKey[] {
  const observation = scored.observation;
  const tokens = [
    ...observation.labels.normalizedTokens,
    ...tokenize(observation.labels.rawLabel),
    ...tokenize(observation.displayLabel),
  ];

  const keys: RelationKey[] = [];
  keys.push({ kind: "game", key: observation.gameId });

  if (observation.participantKey) {
    keys.push({ kind: "participant", key: observation.participantKey });
  } else if (observation.labels.participantHints.length > 0) {
    for (const hint of observation.labels.participantHints) {
      keys.push({
        kind: "label-token",
        key: `participant:${hint.toLowerCase()}`,
      });
    }
  }

  const statFamily =
    statFamilyFromTokens(observation.labels.statFamilyHints) ??
    statFamilyFromTokens(tokens);
  if (statFamily) {
    keys.push({ kind: "stat-family", key: statFamily });
    const parents = COMPOUND_PARENTS[statFamily];
    if (parents) {
      for (const parent of parents) {
        keys.push({ kind: "stat-family", key: parent });
      }
    }
    if (SCORING_STAT_FAMILIES.has(statFamily)) {
      keys.push({ kind: "stat-family", key: "team-total" });
      keys.push({ kind: "stat-family", key: "race-to-x" });
    }
    if (POSSESSION_STAT_FAMILIES.has(statFamily)) {
      keys.push({ kind: "stat-family", key: "double-double" });
    }
  }

  if (observation.family) {
    keys.push({ kind: "market-family", key: observation.family });
  }

  for (const token of tokens) {
    keys.push({ kind: "label-token", key: token });
  }

  return keys;
}

export type CoherenceCluster = {
  primaryKey: string;
  participants: BoardObservationScored[];
  coherenceScore: number;
  sportsbookContribution: number;
  predictionMarketContribution: number;
  hasUnmappedEvidence: boolean;
  relationFamilies: string[];
};

function relationBoost(
  key: RelationKey,
  config: BoardAnomalyDetectorConfig
): number {
  switch (key.kind) {
    case "game":
      return 0.7;
    case "participant":
      return config.fanout.sameParticipantBoost;
    case "paired-participant":
      return config.fanout.pairedParticipantBoost;
    case "team":
      return config.fanout.sameTeamBoost;
    case "stat-family":
      return config.fanout.sameStatFamilyBoost;
    case "compound-stat":
      return config.fanout.sameStatFamilyBoost * 0.6;
    case "market-family":
      return config.fanout.sameFamilyBoost;
    case "label-token":
      return config.fanout.unmappedTokenBoost;
  }
}

export function buildCoherenceClusters(
  scoredObservations: BoardObservationScored[],
  config: BoardAnomalyDetectorConfig
): CoherenceCluster[] {
  const observationKeys = new Map<string, RelationKey[]>();
  for (const scored of scoredObservations) {
    observationKeys.set(
      scored.observation.observationId,
      deriveRelationKeys(scored)
    );
  }

  const groupByKey = new Map<
    string,
    { items: Set<string>; boost: number; kind: RelationKey["kind"] }
  >();
  for (const [observationId, keys] of observationKeys.entries()) {
    for (const key of keys) {
      const groupId = `${key.kind}:${key.key}`;
      const entry = groupByKey.get(groupId);
      if (entry) {
        entry.items.add(observationId);
      } else {
        groupByKey.set(groupId, {
          items: new Set([observationId]),
          boost: relationBoost(key, config),
          kind: key.kind,
        });
      }
    }
  }

  const scoredById = new Map(
    scoredObservations.map((scored) => [
      scored.observation.observationId,
      scored,
    ])
  );

  const clusters: CoherenceCluster[] = [];
  const seen = new Set<string>();

  const sortedGroups = Array.from(groupByKey.entries()).sort((a, b) => {
    const sizeDiff = b[1].items.size - a[1].items.size;
    if (sizeDiff !== 0) return sizeDiff;
    return b[1].boost - a[1].boost;
  });

  for (const [groupId, group] of sortedGroups) {
    if (group.items.size < 2) {
      continue;
    }
    if (
      group.kind === "label-token" &&
      Array.from(group.items).every((id) => seen.has(id))
    ) {
      continue;
    }

    const participants = Array.from(group.items)
      .map((id) => scoredById.get(id))
      .filter((entry): entry is BoardObservationScored => entry != null);

    if (participants.length < 2) {
      continue;
    }

    const totalContribution = participants.reduce(
      (sum, item) => sum + item.contribution,
      0
    );
    if (totalContribution === 0) {
      continue;
    }

    const pairwiseScore = participants.reduce((sum, item, index) => {
      let pairSum = 0;
      for (let j = index + 1; j < participants.length; j += 1) {
        pairSum += Math.min(item.contribution, participants[j].contribution);
      }
      return sum + pairSum;
    }, 0);

    const coherenceScore = group.boost * pairwiseScore;

    const sportsbookContribution = participants
      .filter((item) => item.observation.sourceKind === "sportsbook")
      .reduce((sum, item) => sum + item.contribution, 0);
    const predictionMarketContribution = participants
      .filter((item) => item.observation.sourceKind === "prediction-market")
      .reduce((sum, item) => sum + item.contribution, 0);

    const hasUnmappedEvidence = participants.some(
      (item) =>
        item.observation.mappingStatus === "unmapped" ||
        item.observation.flags.isUnmapped
    );

    const relationFamilies = participants
      .map((item) => item.observation.family ?? "other")
      .filter((value, index, array) => array.indexOf(value) === index);

    clusters.push({
      primaryKey: groupId,
      participants,
      coherenceScore,
      sportsbookContribution,
      predictionMarketContribution,
      hasUnmappedEvidence,
      relationFamilies,
    });

    for (const item of participants) {
      seen.add(item.observation.observationId);
    }
  }

  clusters.sort((a, b) => b.coherenceScore - a.coherenceScore);
  return clusters;
}
