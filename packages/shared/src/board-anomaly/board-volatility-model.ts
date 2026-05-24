import type {
  BoardAnomalyDetectorConfig,
  BoardObservationScored,
  BoardShockEvidence,
  BoardShockMissingNote,
  BoardVolatilityPhaseKind,
  MarketFamily,
  ResearchSourceId,
} from "@signal-console/domain";

import {
  averageContribution,
  averageMicrostructure,
  coverageRatio,
  evidenceFromScored,
  sourceMarketIdsFromScored,
  instrumentIdsFromScored,
  missingDataNotesFromScored,
  h0DriversFromScored,
  averageH0Suppression,
  withinShockWindow,
} from "./alert-metrics";
import { clamp01 } from "./config";

import type {
  BoardVolatilityBaselineResolved,
  BoardVolatilityBaselineLookupInput,
} from "../board-volatility-baselines";

const CORE_GAME_STATE_FAMILIES = new Set<MarketFamily>([
  "moneyline",
  "spread",
  "total",
  "team-prop",
]);

const FAMILY_ORDER: MarketFamily[] = [
  "moneyline",
  "spread",
  "total",
  "team-prop",
  "player-prop",
  "other",
];

export type BoardVolatilityFeatureSnapshot = {
  alertReady: boolean;
  calibratedAbnormality: number;
  coreFamilies: MarketFamily[];
  coreRepresentativeRows: BoardObservationScored[];
  coveragePenalty: number;
  crossSourceConfirmation: number;
  distinctCoreSources: ResearchSourceId[];
  drivers: {
    coreMarkets: BoardShockEvidence[];
    supportingMarkets: BoardShockEvidence[];
  };
  evidence: BoardShockEvidence[];
  families: MarketFamily[];
  gates: {
    criticalEligible: boolean;
    hasCoreBreadth: boolean;
    hasPersistence: boolean;
    hasSourceConfirmation: boolean;
  };
  h0Adjustments: {
    appliedSuppression: number;
    drivers: string[];
  };
  inspect: {
    instrumentIds: string[];
    payloadVersion: 1;
    relationFamilies: string[];
    sourceMarketIds: string[];
  };
  missingDataNotes: BoardShockMissingNote[];
  percentile: number;
  phaseTransitionBonus: number;
  predictionMarketRows: number;
  rawScore: number;
  sampledRows: BoardObservationScored[];
  shockRows: number;
  signals: {
    coreBreadth: number;
    coreLiquidityStress: number;
    corePriceShock: number;
    coveragePenalty: number;
    crossSourceConfirmation: number;
    persistenceSeconds: number;
    phaseTransitionBonus: number;
    supportPropShock: number;
  };
  sourceMarketCount: number;
  sources: ResearchSourceId[];
  state: BoardVolatilityPhaseKind;
};

function freshPredictionMarketRow(item: BoardObservationScored) {
  const observation = item.observation;
  return (
    observation.sourceKind === "prediction-market" &&
    !observation.flags.isHeartbeat &&
    !observation.flags.isStale &&
    !observation.missing.impliedProbability
  );
}

function sortFamilies(families: Set<MarketFamily>) {
  return FAMILY_ORDER.filter((family) => families.has(family));
}

function strongestRowsByFamily(
  rows: BoardObservationScored[],
  families: Set<MarketFamily>
) {
  const bestByFamily = new Map<MarketFamily, BoardObservationScored>();
  for (const row of rows) {
    const family = row.observation.family;
    if (!family || !families.has(family)) continue;
    const previous = bestByFamily.get(family);
    if (!previous || row.contribution > previous.contribution) {
      bestByFamily.set(family, row);
    }
  }
  return sortFamilies(new Set(bestByFamily.keys()))
    .map((family) => bestByFamily.get(family) ?? null)
    .filter((row): row is BoardObservationScored => row != null);
}

function interpolatePercentile(
  value: number,
  baseline: BoardVolatilityBaselineResolved["expectedRange"]
) {
  const safe = {
    p50: Math.max(0.001, baseline.p50),
    p75: Math.max(baseline.p50 + 0.001, baseline.p75),
    p90: Math.max(baseline.p75 + 0.001, baseline.p90),
    p99: Math.max(baseline.p90 + 0.001, baseline.p99),
  };

  if (value <= safe.p50) {
    return clamp01((value / safe.p50) * 0.5);
  }
  if (value <= safe.p75) {
    return 0.5 + ((value - safe.p50) / (safe.p75 - safe.p50)) * 0.25;
  }
  if (value <= safe.p90) {
    return 0.75 + ((value - safe.p75) / (safe.p90 - safe.p75)) * 0.15;
  }
  if (value <= safe.p99) {
    return 0.9 + ((value - safe.p90) / (safe.p99 - safe.p90)) * 0.09;
  }
  return clamp01(
    0.99 + Math.min(0.01, (value - safe.p99) / Math.max(0.1, 1 - safe.p99))
  );
}

function evidenceLimit(rows: BoardObservationScored[], limit: number) {
  return evidenceFromScored(rows, limit);
}

export function buildBoardVolatilityBaselineLookupInput(options: {
  coreFamilyCount: number;
  margin: number | null;
  period: number | null;
  phaseKind: BoardVolatilityPhaseKind;
  secondsFromTip: number | null;
  sourceCount: number;
}): BoardVolatilityBaselineLookupInput {
  return {
    coreFamilyCount: options.coreFamilyCount,
    margin: options.margin,
    period: options.period,
    phaseKind: options.phaseKind,
    secondsFromTip: options.secondsFromTip,
    sourceCount: options.sourceCount,
  };
}

export function buildBoardVolatilityFeatureSnapshot(input: {
  baseline: BoardVolatilityBaselineResolved;
  config: BoardAnomalyDetectorConfig;
  persistenceSeconds: number;
  phaseKind: BoardVolatilityPhaseKind;
  scored: BoardObservationScored[];
  shockWindowMs: number;
  topEvidenceRows: number;
  transitionBoost: number;
}): BoardVolatilityFeatureSnapshot {
  const sampleRows = input.scored.filter(freshPredictionMarketRow);
  const candidates = sampleRows.filter((item) => item.contribution > 0);
  const sourceMarketIds = sourceMarketIdsFromScored(sampleRows);
  const nowMs = sampleRows.reduce((max, row) => {
    const ts = Date.parse(row.observation.eventTimestamp);
    return Number.isFinite(ts) ? Math.max(max, ts) : max;
  }, 0);
  const shockRows = candidates.filter((item) =>
    withinShockWindow(item.observation, nowMs, input.shockWindowMs)
  );
  const families = new Set(
    sampleRows
      .map((item) => item.observation.family)
      .filter((family): family is MarketFamily => family != null)
  );
  const coreFamilies = new Set(
    Array.from(families).filter((family) =>
      CORE_GAME_STATE_FAMILIES.has(family)
    )
  );
  const coreRows = candidates.filter((item) => {
    const family = item.observation.family;
    return family != null && CORE_GAME_STATE_FAMILIES.has(family);
  });
  const coreRepresentativeRows = strongestRowsByFamily(coreRows, coreFamilies);
  const supportingRows = candidates
    .slice()
    .sort((left, right) => right.contribution - left.contribution)
    .filter(
      (item) =>
        !coreRepresentativeRows.some(
          (core) =>
            core.observation.observationId === item.observation.observationId
        )
    );
  const topRows = [...coreRepresentativeRows, ...supportingRows].slice(
    0,
    input.topEvidenceRows
  );
  const distinctCoreSources = Array.from(
    new Set<ResearchSourceId>(
      coreRepresentativeRows.map((row) => row.observation.source)
    )
  ).sort();
  const distinctSources = Array.from(
    new Set<ResearchSourceId>(sampleRows.map((row) => row.observation.source))
  ).sort();
  const corePriceShock = averageContribution(coreRepresentativeRows);
  const coreLiquidityStress = averageMicrostructure(coreRepresentativeRows);
  const coreBreadth = clamp01(coreFamilies.size / 4);
  const crossSourceConfirmation = clamp01(
    distinctCoreSources.length <= 1
      ? distinctCoreSources.length * 0.35
      : 0.55 + Math.min(0.45, (distinctCoreSources.length - 1) * 0.25)
  );
  const supportPropShock = averageContribution(
    supportingRows.filter((row) => row.observation.family === "player-prop")
  );
  const coveragePenalty = clamp01(coverageRatio(candidates));
  const phaseTransitionBonus = clamp01(input.transitionBoost);
  const coreShock = clamp01(corePriceShock * 0.7 + coreLiquidityStress * 0.3);
  const supportMultiplier =
    0.65 + coreBreadth * 0.2 + crossSourceConfirmation * 0.15;

  const rawScore = clamp01(
    coreShock * supportMultiplier +
      Math.min(1, input.persistenceSeconds / 90) * 0.12 +
      supportPropShock * 0.05 +
      phaseTransitionBonus * 0.08 -
      coveragePenalty * 0.1
  );
  const percentile = interpolatePercentile(
    rawScore,
    input.baseline.expectedRange
  );
  const calibratedAbnormality = clamp01(rawScore * 0.45 + percentile * 0.55);

  const hasCoreBreadth = coreFamilies.size >= 2;
  const hasSourceConfirmation = distinctCoreSources.length >= 2;
  const hasPersistence = input.persistenceSeconds >= 30;
  const criticalEligible =
    coreFamilies.size >= 3 &&
    hasSourceConfirmation &&
    hasPersistence &&
    percentile >= 0.99;

  return {
    alertReady:
      calibratedAbnormality >= 0.55 &&
      percentile >= 0.9 &&
      (hasCoreBreadth || hasSourceConfirmation),
    calibratedAbnormality,
    coreFamilies: sortFamilies(coreFamilies),
    coreRepresentativeRows,
    coveragePenalty,
    crossSourceConfirmation,
    distinctCoreSources,
    drivers: {
      coreMarkets: evidenceLimit(coreRepresentativeRows, 4),
      supportingMarkets: evidenceLimit(
        supportingRows,
        Math.max(0, input.topEvidenceRows - 4)
      ),
    },
    evidence: evidenceLimit(topRows, input.topEvidenceRows),
    families: sortFamilies(families),
    gates: {
      criticalEligible,
      hasCoreBreadth,
      hasPersistence,
      hasSourceConfirmation,
    },
    h0Adjustments: {
      appliedSuppression: Number(averageH0Suppression(candidates).toFixed(3)),
      drivers: h0DriversFromScored(candidates),
    },
    inspect: {
      instrumentIds: instrumentIdsFromScored(candidates),
      payloadVersion: 1,
      relationFamilies: [
        "game-state-volatility",
        ...sortFamilies(families).map((family) => family.replace(/-/g, " ")),
      ],
      sourceMarketIds,
    },
    missingDataNotes: missingDataNotesFromScored(candidates),
    percentile,
    phaseTransitionBonus,
    predictionMarketRows: sampleRows.length,
    rawScore,
    sampledRows: sampleRows,
    shockRows: shockRows.length,
    signals: {
      coreBreadth,
      coreLiquidityStress,
      corePriceShock,
      coveragePenalty,
      crossSourceConfirmation,
      persistenceSeconds: input.persistenceSeconds,
      phaseTransitionBonus,
      supportPropShock,
    },
    sourceMarketCount: sourceMarketIds.length,
    sources: distinctSources,
    state: input.phaseKind,
  };
}

export function runBoardStressKalmanFilter(input: {
  bucketSeconds: number;
  observations: number[];
  phaseKind: BoardVolatilityPhaseKind;
}) {
  const decay =
    input.phaseKind === "tip-burst" || input.phaseKind === "restart-burst"
      ? 0.65
      : input.phaseKind === "crunch-time" ||
          input.phaseKind === "final-minute" ||
          input.phaseKind === "final"
        ? 0.88
        : 0.8;
  const processNoise =
    input.phaseKind === "tip-burst" || input.phaseKind === "restart-burst"
      ? 0.035
      : 0.02;
  const measurementNoise =
    input.phaseKind === "settled-live" || input.phaseKind === "final"
      ? 0.08
      : 0.06;

  let stress = 0;
  let velocity = 0;
  let p00 = 1;
  let p01 = 0;
  let p10 = 0;
  let p11 = 1;
  let innovation = 0;

  const dt = input.bucketSeconds / 60;
  for (const z of input.observations) {
    const predStress = clamp01(stress + velocity * dt);
    const predVelocity = velocity * decay;

    const predP00 = p00 + dt * (p10 + p01) + dt * dt * p11 + processNoise;
    const predP01 = decay * (p01 + dt * p11);
    const predP10 = decay * (p10 + dt * p11);
    const predP11 = decay * decay * p11 + processNoise;

    const s = predP00 + measurementNoise;
    const k0 = predP00 / s;
    const k1 = predP10 / s;
    innovation = z - predStress;

    stress = clamp01(predStress + k0 * innovation);
    velocity = predVelocity + k1 * innovation;

    p00 = (1 - k0) * predP00;
    p01 = (1 - k0) * predP01;
    p10 = predP10 - k1 * predP00;
    p11 = predP11 - k1 * predP01;
  }

  return {
    bucketSeconds: input.bucketSeconds,
    decayRegime: input.phaseKind,
    innovation: Number(innovation.toFixed(3)),
    observationCount: input.observations.length,
    stressLevel: Number(stress.toFixed(3)),
    stressVelocity: Number(velocity.toFixed(3)),
  };
}
