import type {
  BoardAnomalyAlert,
  BoardAnomalyDetectorConfig,
  BoardGameStateVolatility,
  BoardGameStateVolatilityBand,
  BoardObservationScored,
  BoardShockEvidence,
  MarketFamily,
  ResearchSourceId,
} from "@signal-console/domain";

import {
  instrumentIdsFromScored,
  missingDataNotesFromScored,
  sourceMarketIdsFromScored,
} from "./alert-metrics";
import { deriveBoardVolatilityPhase } from "./board-volatility-phase";
import { clamp01, scoreToSeverity } from "./config";
import { parseTimestampMs } from "../board-anomaly-support";

import type { GameStateRow } from "../board-anomaly-observation-context";
import type { BoardObservationMaterializationDiagnostics } from "../board-anomaly-observations";

const BOARD_VW_BUCKET_SECONDS = 60;
const BOARD_VW_FRESH_CAP_SECONDS = 300;
const BOARD_VW_TRAILING_BUCKETS = 20;
const BOARD_VW_WARMUP_BUCKETS = 8;
const BOARD_VW_K_MAD = 3;

const DISPLAY_FAMILY_ORDER: MarketFamily[] = [
  "moneyline",
  "spread",
  "total",
  "team-prop",
  "player-prop",
  "other",
];

const DISPLAY_SOURCE_ORDER: ResearchSourceId[] = [
  "bet365",
  "fanduel",
  "draftkings",
  "kalshi",
  "polymarket",
];

type BuildGameStateVolatilityAlertInput = {
  config: BoardAnomalyDetectorConfig;
  detectedAtIso: string;
  gameId: string;
  gameLabel: string;
  gameStates?: GameStateRow[];
  materializationDiagnostics?: BoardObservationMaterializationDiagnostics;
  nowMs: number;
  scheduledStart?: string;
  scored: BoardObservationScored[];
  shockWindowMs: number;
};

type BoardVwContribution = {
  bucketStartMs: number;
  deltaAbs: number;
  row: BoardObservationScored;
  timestampMs: number;
  weightLabel: string;
  weightSource: "quote-volume" | "source-market-volume" | "equal-weight-fallback";
  volumeWeight: number;
  weightedDelta: number;
};

type BoardVwBucket = {
  bucketStartMs: number;
  contributions: BoardVwContribution[];
  intensity: number;
};

type BoardVwThreshold = {
  bucket: BoardVwBucket;
  fire: boolean;
  index: number;
  mad: number;
  median: number;
  priorIntensities: number[];
  threshold: number;
};

type BoardVwMeasurementContext = {
  activeFire: BoardVwThreshold | null;
  activeStreakBucketCount: number;
  availableBucketCount: number;
  latestBucket: BoardVwBucket | null;
  latestEvaluatedBucket: BoardVwThreshold | null;
  phase: ReturnType<typeof deriveBoardVolatilityPhase>;
  ready: boolean;
};

type CurrentBucketView = {
  contributions: BoardVwContribution[];
  coveragePenalty: number;
  evidence: BoardShockEvidence[];
  families: MarketFamily[];
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
  missingDataNotes: ReturnType<typeof missingDataNotesFromScored>;
  predictionMarketRows: number;
  sourceCount: number;
  sourceMarketCount: number;
  sources: ResearchSourceId[];
  supportingEvidence: BoardShockEvidence[];
  weightSources: {
    equalWeightFallback: number;
    sourceMarketVolume: number;
    quoteVolume: number;
  };
};

function isBoardVwInputRow(row: BoardObservationScored) {
  const observation = row.observation;
  if (observation.flags.isHeartbeat) return false;
  if (observation.missing.impliedProbability) return false;
  if (observation.observationId.startsWith("microstructure:")) return false;
  return observation.impliedProbability != null;
}

function sortFamilies(families: Iterable<MarketFamily>) {
  const familySet = new Set(families);
  return DISPLAY_FAMILY_ORDER.filter((family) => familySet.has(family));
}

function sortSources(sources: Iterable<ResearchSourceId>) {
  const sourceSet = new Set(sources);
  return DISPLAY_SOURCE_ORDER.filter((source) => sourceSet.has(source));
}

function percentile(values: number[], p: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * p;
  const floorIndex = Math.floor(index);
  const ceilIndex = Math.ceil(index);
  if (floorIndex === ceilIndex) {
    return sorted[floorIndex] ?? 0;
  }
  const floorValue = sorted[floorIndex] ?? 0;
  const ceilValue = sorted[ceilIndex] ?? floorValue;
  return floorValue + (ceilValue - floorValue) * (index - floorIndex);
}

function median(values: number[]) {
  return percentile(values, 0.5);
}

function mad(values: number[]) {
  if (values.length === 0) return 0;
  const center = median(values);
  return median(values.map((value) => Math.abs(value - center)));
}

function currentObservationGameState(scored: BoardObservationScored[], nowMs: number) {
  const current = scored
    .slice()
    .sort((left, right) => {
      const leftTs =
        parseTimestampMs(left.observation.eventTimestamp) ??
        parseTimestampMs(left.observation.capturedAt) ??
        0;
      const rightTs =
        parseTimestampMs(right.observation.eventTimestamp) ??
        parseTimestampMs(right.observation.capturedAt) ??
        0;
      return rightTs - leftTs;
    })
    .find((row) => {
      const ts =
        parseTimestampMs(row.observation.eventTimestamp) ??
        parseTimestampMs(row.observation.capturedAt);
      return ts != null && ts <= nowMs;
    });
  return current?.observation.gameState ?? null;
}

function buildBoardVwBuckets(scored: BoardObservationScored[], nowMs: number): BoardVwBucket[] {
  const bucketMs = BOARD_VW_BUCKET_SECONDS * 1000;
  const rowsByMarket = new Map<string, BoardObservationScored[]>();

  for (const row of scored) {
    if (!isBoardVwInputRow(row)) continue;
    if (
      row.observation.gameState.status !== "in-play" &&
      row.observation.gameState.status !== "scheduled"
    ) {
      continue;
    }
    const timestampMs =
      parseTimestampMs(row.observation.eventTimestamp) ??
      parseTimestampMs(row.observation.capturedAt);
    if (timestampMs == null || timestampMs > nowMs) continue;
    const impliedProbability = row.observation.impliedProbability;
    if (impliedProbability == null) continue;
    if (Math.abs(impliedProbability - 0.5) < 1e-9) continue;
    const existing = rowsByMarket.get(row.observation.sourceMarketId) ?? [];
    existing.push(row);
    rowsByMarket.set(row.observation.sourceMarketId, existing);
  }

  const bucketMap = new Map<number, BoardVwBucket>();
  for (const rows of rowsByMarket.values()) {
    const orderedRows = rows.slice().sort((left, right) => {
      const leftTs =
        parseTimestampMs(left.observation.eventTimestamp) ??
        parseTimestampMs(left.observation.capturedAt) ??
        0;
      const rightTs =
        parseTimestampMs(right.observation.eventTimestamp) ??
        parseTimestampMs(right.observation.capturedAt) ??
        0;
      return leftTs - rightTs;
    });

    for (let index = 1; index < orderedRows.length; index += 1) {
      const previous = orderedRows[index - 1];
      const current = orderedRows[index];
      const previousTs =
        parseTimestampMs(previous.observation.eventTimestamp) ??
        parseTimestampMs(previous.observation.capturedAt);
      const currentTs =
        parseTimestampMs(current.observation.eventTimestamp) ??
        parseTimestampMs(current.observation.capturedAt);
      const previousProbability = previous.observation.impliedProbability;
      const currentProbability = current.observation.impliedProbability;
      if (
        previousTs == null ||
        currentTs == null ||
        previousProbability == null ||
        currentProbability == null
      ) {
        continue;
      }

      const gapSeconds = (currentTs - previousTs) / 1000;
      if (gapSeconds <= 0 || gapSeconds > BOARD_VW_FRESH_CAP_SECONDS) {
        continue;
      }

      const deltaAbs = Math.abs(currentProbability - previousProbability);
      if (deltaAbs <= 0) continue;

      const bucketStartMs = Math.floor(currentTs / bucketMs) * bucketMs;
      if (bucketStartMs + bucketMs > nowMs) continue;

      const weight = resolveBoardVwWeight(current);
      const volumeWeight = weight.weight;
      const weightedDelta = deltaAbs * volumeWeight;
      if (weightedDelta <= 0) continue;

      const bucket = bucketMap.get(bucketStartMs) ?? {
        bucketStartMs,
        contributions: [],
        intensity: 0,
      };
      bucket.intensity += weightedDelta;
      bucket.contributions.push({
        bucketStartMs,
        deltaAbs,
        row: current,
        timestampMs: currentTs,
        weightLabel: weight.label,
        weightSource: weight.source,
        volumeWeight,
        weightedDelta,
      });
      bucketMap.set(bucketStartMs, bucket);
    }
  }

  return Array.from(bucketMap.values()).sort(
    (left, right) => left.bucketStartMs - right.bucketStartMs,
  );
}

function resolveBoardVwWeight(row: BoardObservationScored) {
  const quoteVolume = row.observation.volume;
  if (quoteVolume != null && quoteVolume > 0) {
    const isMetadataVolume = row.observation.volumeSource === "source-market-metadata";
    return {
      label: isMetadataVolume
        ? `log1p(stored vol ${quoteVolume.toFixed(0)})`
        : `log1p(vol ${quoteVolume.toFixed(0)})`,
      source: isMetadataVolume ? ("source-market-volume" as const) : ("quote-volume" as const),
      weight: Math.log1p(quoteVolume),
    };
  }

  return {
    label: "weight 1 (missing volume)",
    source: "equal-weight-fallback" as const,
    weight: 1,
  };
}

function evaluateBoardVwBuckets(buckets: BoardVwBucket[]) {
  const evaluated: BoardVwThreshold[] = [];
  const intensities = buckets.map((bucket) => bucket.intensity);
  for (let index = 0; index < buckets.length; index += 1) {
    const priorIntensities = intensities.slice(
      Math.max(0, index - BOARD_VW_TRAILING_BUCKETS),
      index,
    );
    const priorMedian = median(priorIntensities);
    const priorMad = mad(priorIntensities);
    const safeMad = priorMad || 1e-9;
    const threshold = priorMedian + BOARD_VW_K_MAD * safeMad;
    const ready = priorIntensities.length >= BOARD_VW_WARMUP_BUCKETS;
    evaluated.push({
      bucket: buckets[index],
      fire: ready && buckets[index].intensity >= threshold && buckets[index].intensity > 0,
      index,
      mad: priorMad,
      median: priorMedian,
      priorIntensities,
      threshold,
    });
  }
  return evaluated;
}

function countActiveFireStreak(evaluated: BoardVwThreshold[], activeIndex: number) {
  let count = 1;
  for (let index = activeIndex - 1; index >= 0; index -= 1) {
    const current = evaluated[index];
    const next = evaluated[index + 1];
    if (!current.fire || !next.fire) break;
    if (
      next.bucket.bucketStartMs - current.bucket.bucketStartMs !==
      BOARD_VW_BUCKET_SECONDS * 1000
    ) {
      break;
    }
    count += 1;
  }
  return count;
}

function buildBucketView(bucket: BoardVwBucket): CurrentBucketView {
  const sortedContributions = bucket.contributions
    .slice()
    .sort((left, right) => right.weightedDelta - left.weightedDelta);
  const families = sortFamilies(
    sortedContributions
      .map((item) => item.row.observation.family)
      .filter((family): family is MarketFamily => family != null),
  );
  const sources = sortSources(sortedContributions.map((item) => item.row.observation.source));
  const uniqueScoredRows = Array.from(
    new Map(
      sortedContributions.map((item) => [item.row.observation.observationId, item.row]),
    ).values(),
  );
  const evidence = sortedContributions.slice(0, 4).map((item) => ({
    observationId: item.row.observation.observationId,
    source: item.row.observation.source,
    sourceKind: item.row.observation.sourceKind,
    family: item.row.observation.family,
    participantKey: item.row.observation.participantKey,
    displayLabel: item.row.observation.displayLabel,
    contribution: Number(item.weightedDelta.toFixed(3)),
    reason: `board-vw ${item.deltaAbs.toFixed(3)} * ${item.weightLabel}`,
    evidenceUnmapped:
      item.row.observation.mappingStatus === "unmapped" || item.row.observation.flags.isUnmapped,
  }));
  const supportingEvidence = sortedContributions.slice(4, 8).map((item) => ({
    observationId: item.row.observation.observationId,
    source: item.row.observation.source,
    sourceKind: item.row.observation.sourceKind,
    family: item.row.observation.family,
    participantKey: item.row.observation.participantKey,
    displayLabel: item.row.observation.displayLabel,
    contribution: Number(item.weightedDelta.toFixed(3)),
    reason: `board-vw ${item.deltaAbs.toFixed(3)} * ${item.weightLabel}`,
    evidenceUnmapped:
      item.row.observation.mappingStatus === "unmapped" || item.row.observation.flags.isUnmapped,
  }));
  const weightSources = sortedContributions.reduce(
    (summary, item) => {
      if (item.weightSource === "quote-volume") {
        summary.quoteVolume += 1;
      } else if (item.weightSource === "source-market-volume") {
        summary.sourceMarketVolume += 1;
      } else {
        summary.equalWeightFallback += 1;
      }
      return summary;
    },
    {
      equalWeightFallback: 0,
      sourceMarketVolume: 0,
      quoteVolume: 0,
    },
  );

  const coveragePenalty =
    uniqueScoredRows.length === 0
      ? 0
      : uniqueScoredRows.filter(
          (row) =>
            row.observation.flags.isStale ||
            row.observation.missing.impliedProbability ||
            row.observation.missing.volume ||
            row.observation.mappingStatus === "unmapped",
        ).length / uniqueScoredRows.length;

  return {
    contributions: sortedContributions,
    coveragePenalty,
    evidence,
    families,
    h0Adjustments: {
      appliedSuppression: 0,
      drivers: [],
    },
    inspect: {
      instrumentIds: instrumentIdsFromScored(uniqueScoredRows),
      payloadVersion: 1,
      relationFamilies: ["game-state-volatility", ...families],
      sourceMarketIds: sourceMarketIdsFromScored(uniqueScoredRows),
    },
    missingDataNotes: missingDataNotesFromScored(uniqueScoredRows),
    predictionMarketRows: uniqueScoredRows.filter(
      (row) => row.observation.sourceKind === "prediction-market",
    ).length,
    sourceCount: sources.length,
    sourceMarketCount: new Set(uniqueScoredRows.map((row) => row.observation.sourceMarketId)).size,
    sources,
    supportingEvidence,
    weightSources,
  };
}

function computePercentileRank(priorIntensities: number[], currentIntensity: number) {
  if (priorIntensities.length === 0) return 0;
  const lessOrEqual = priorIntensities.filter((value) => value <= currentIntensity).length;
  return clamp01(lessOrEqual / priorIntensities.length);
}

function scoreFromBucket(options: {
  activeFire: boolean;
  intensity: number;
  ready: boolean;
  threshold: number;
}) {
  if (!options.ready) return 0;
  const safeThreshold = Math.max(options.threshold, 1e-9);
  const ratio = options.intensity / safeThreshold;
  if (options.activeFire) {
    return Math.min(84, Math.max(55, Math.round(55 + Math.min(29, (ratio - 1) * 20))));
  }
  if (ratio >= 0.8) {
    return Math.min(54, Math.max(40, Math.round(40 + (ratio - 0.8) * 70)));
  }
  return Math.max(0, Math.min(39, Math.round(ratio * 39)));
}

function bandForScore(options: {
  activeFire: boolean;
  ready: boolean;
  score: number;
}): BoardGameStateVolatilityBand {
  if (!options.ready) return "insufficient-data";
  if (options.activeFire) return "alert";
  if (options.score >= 40) return "elevated";
  return "normal";
}

function calculateBoardVwMeasurement(input: BuildGameStateVolatilityAlertInput): {
  context: BoardVwMeasurementContext;
  firstPopAt: string;
  measurement: BoardGameStateVolatility;
} {
  const currentGameState = currentObservationGameState(input.scored, input.nowMs);
  const phase = deriveBoardVolatilityPhase({
    clock: currentGameState?.clock,
    minutesToTip: currentGameState?.minutesToTip,
    nowIso: input.detectedAtIso,
    period: currentGameState?.period,
    scheduledStart: input.scheduledStart,
    scoreMargin: currentGameState?.scoreMargin,
    status: currentGameState?.status ?? "scheduled",
    timeline: input.gameStates,
  });

  const buckets = buildBoardVwBuckets(input.scored, input.nowMs);
  const evaluated = evaluateBoardVwBuckets(buckets);
  const latestBucket = buckets[buckets.length - 1] ?? null;
  const latestEvaluatedBucket = evaluated[evaluated.length - 1] ?? null;
  let activeFireIndex = -1;
  for (let index = evaluated.length - 1; index >= 0; index -= 1) {
    const bucket = evaluated[index];
    if (
      bucket?.fire &&
      input.nowMs - (bucket.bucket.bucketStartMs + BOARD_VW_BUCKET_SECONDS * 1000) <=
        input.shockWindowMs
    ) {
      activeFireIndex = index;
      break;
    }
  }
  const phaseAllowsActionableFire = phase.kind !== "pregame";
  const activeFire =
    activeFireIndex >= 0 && phaseAllowsActionableFire ? (evaluated[activeFireIndex] ?? null) : null;
  const activeStreakBucketCount =
    activeFireIndex >= 0 ? countActiveFireStreak(evaluated, activeFireIndex) : 0;
  const selectedBucket = activeFire ?? latestEvaluatedBucket;
  const ready = selectedBucket?.priorIntensities.length >= BOARD_VW_WARMUP_BUCKETS;
  const view = selectedBucket
    ? buildBucketView(selectedBucket.bucket)
    : {
        contributions: [],
        coveragePenalty: 0,
        evidence: [],
        families: [] as MarketFamily[],
        h0Adjustments: {
          appliedSuppression: 0,
          drivers: [],
        },
        inspect: {
          instrumentIds: [],
          payloadVersion: 1 as const,
          relationFamilies: ["game-state-volatility"],
          sourceMarketIds: [],
        },
        missingDataNotes: [],
        predictionMarketRows: 0,
        sourceCount: 0,
        sourceMarketCount: 0,
        sources: [] as ResearchSourceId[],
        supportingEvidence: [],
        weightSources: {
          equalWeightFallback: 0,
          sourceMarketVolume: 0,
          quoteVolume: 0,
        },
      };

  const currentIntensity = selectedBucket?.bucket.intensity ?? 0;
  const baselineWindow = selectedBucket?.priorIntensities ?? [];
  const threshold = selectedBucket?.threshold ?? 0;
  const currentPercentile = computePercentileRank(baselineWindow, currentIntensity);
  let streakStartMs: number | null = null;
  if (activeFireIndex >= 0) {
    const streakStartIndex = activeFireIndex - activeStreakBucketCount + 1;
    const streakStartBucket = evaluated[streakStartIndex]?.bucket;
    if (streakStartBucket) {
      streakStartMs = streakStartBucket.bucketStartMs + BOARD_VW_BUCKET_SECONDS * 1000;
    }
  }
  const score = scoreFromBucket({
    activeFire: activeFire != null,
    intensity: currentIntensity,
    ready,
    threshold,
  });
  const band = bandForScore({
    activeFire: activeFire != null,
    ready,
    score,
  });
  const selectedFamilies = view.families;
  const familyBreadth = clamp01(selectedFamilies.length / DISPLAY_FAMILY_ORDER.length);
  const sourceBreadth = clamp01(Math.max(0, view.sourceCount - 1) / 2);
  const meanLogVolume =
    view.contributions.length === 0
      ? 0
      : view.contributions.reduce((sum, item) => sum + item.volumeWeight, 0) /
        view.contributions.length;
  const coreLiquidityStress = clamp01(meanLogVolume / 8);
  const calibratedAbnormality = ready
    ? clamp01(currentIntensity / Math.max(threshold || currentIntensity, 1e-9))
    : 0;
  const confidence = ready
    ? Math.max(
        0.25,
        Math.min(
          0.95,
          0.35 +
            (activeFire ? 0.2 : 0) +
            familyBreadth * 0.2 +
            sourceBreadth * 0.15 +
            currentPercentile * 0.1 -
            view.coveragePenalty * 0.15,
        ),
      )
    : 0.2;

  const baselineExpectedRange = {
    p50: Number(percentile(baselineWindow, 0.5).toFixed(3)),
    p75: Number(percentile(baselineWindow, 0.75).toFixed(3)),
    p90: Number(percentile(baselineWindow, 0.9).toFixed(3)),
    p99: Number(percentile(baselineWindow, 0.99).toFixed(3)),
  };

  const firstPopAt =
    streakStartMs != null ? new Date(streakStartMs).toISOString() : input.detectedAtIso;
  const materializationDiagnostics = input.materializationDiagnostics ?? {
    filteredReasonCounts: {},
    latestQuoteAt: null,
    materializedObservationRows: input.scored.length,
    rawMicrostructureRows: 0,
    rawQuoteRows: input.scored.length,
  };
  const detectorStatus =
    materializationDiagnostics.rawQuoteRows > 0 &&
    materializationDiagnostics.materializedObservationRows === 0
      ? ("degraded" as const)
      : activeFire != null
        ? ("firing" as const)
        : ready && phaseAllowsActionableFire
          ? ("armed" as const)
          : ready
            ? ("prewarmed" as const)
            : ("warming" as const);

  const measurement: BoardGameStateVolatility = {
    alertId:
      activeFire != null
        ? ["board-alert", input.gameId, "game-state-volatility", "no-entity", firstPopAt].join(":")
        : null,
    band,
    baseline: {
      cohortKey: `board-vw|bucket-${BOARD_VW_BUCKET_SECONDS}|k-${BOARD_VW_K_MAD}|w-${BOARD_VW_TRAILING_BUCKETS}|warmup-${BOARD_VW_WARMUP_BUCKETS}`,
      expectedRange: baselineExpectedRange,
      percentile: Number(currentPercentile.toFixed(3)),
      sampleSize: baselineWindow.length,
      source: "fallback",
    },
    components: {
      coherence: Number(familyBreadth.toFixed(3)),
      coverage: Number(view.coveragePenalty.toFixed(3)),
      microstructure: Number(coreLiquidityStress.toFixed(3)),
      residual: Number(calibratedAbnormality.toFixed(3)),
    },
    confidence: Number(confidence.toFixed(3)),
    diagnostics: {
      detectorStatus,
      filteredReasonCounts: materializationDiagnostics.filteredReasonCounts,
      coreFamilies: selectedFamilies,
      families: selectedFamilies,
      latestQuoteAt: materializationDiagnostics.latestQuoteAt,
      materializedObservationRows: materializationDiagnostics.materializedObservationRows,
      predictionMarketRows: view.predictionMarketRows,
      rawQuoteRows: materializationDiagnostics.rawQuoteRows,
      ready,
      shockRows: view.contributions.length,
      sourceMarketCount: view.sourceMarketCount,
      sources: view.sources,
    },
    drivers: {
      coreMarkets: view.evidence,
      supportingMarkets: view.supportingEvidence,
    },
    evidence: [...view.evidence, ...view.supportingEvidence],
    filter: {
      bucketSeconds: BOARD_VW_BUCKET_SECONDS,
      decayRegime: phase.kind,
      innovation: Number(
        (ready ? (currentIntensity - threshold) / Math.max(threshold, 1e-9) : 0).toFixed(3),
      ),
      observationCount: buckets.length,
      stressLevel: Number(calibratedAbnormality.toFixed(3)),
      stressVelocity: Number(
        (selectedBucket != null && selectedBucket.index > 0
          ? (selectedBucket.bucket.intensity -
              (evaluated[selectedBucket.index - 1]?.bucket.intensity ?? 0)) /
            Math.max(threshold || 1, 1)
          : 0
        ).toFixed(3),
      ),
    },
    gameId: input.gameId,
    gameLabel: input.gameLabel,
    gates: {
      criticalEligible: false,
      hasCoreBreadth: selectedFamilies.length >= 2,
      hasPersistence: activeStreakBucketCount >= 2,
      hasSourceConfirmation: view.sourceCount >= 2,
    },
    h0Adjustments: view.h0Adjustments,
    headlineScore: score,
    inspect: view.inspect,
    measuredAt: input.detectedAtIso,
    missingDataNotes: view.missingDataNotes,
    phase,
    sample: {
      coreFamilies: selectedFamilies,
      families: selectedFamilies,
      predictionMarketRows: view.predictionMarketRows,
      ready,
      shockRows: view.contributions.length,
      sourceMarketCount: view.sourceMarketCount,
      sources: view.sources,
    },
    score,
    signals: {
      calibratedAbnormality: Number(calibratedAbnormality.toFixed(3)),
      coreBreadth: Number(familyBreadth.toFixed(3)),
      coreLiquidityStress: Number(coreLiquidityStress.toFixed(3)),
      corePriceShock: Number(currentIntensity.toFixed(3)),
      coveragePenalty: Number(view.coveragePenalty.toFixed(3)),
      crossSourceConfirmation: Number(sourceBreadth.toFixed(3)),
      persistenceSeconds: activeStreakBucketCount * BOARD_VW_BUCKET_SECONDS,
      phaseTransitionBonus: 0,
      supportPropShock: Number(
        clamp01(
          view.contributions.length === 0
            ? 0
            : view.contributions
                .filter((item) => item.row.observation.family === "player-prop")
                .reduce((sum, item) => sum + item.weightedDelta, 0) /
                Math.max(currentIntensity, 1e-9),
        ).toFixed(3),
      ),
    },
    state: band,
    thresholds: {
      alertMinScore: 55,
      criticalMinScore: 85,
      elevatedMinScore: 40,
      normalMaxScore: 39,
    },
  };

  return {
    context: {
      activeFire,
      activeStreakBucketCount,
      availableBucketCount: buckets.length,
      latestBucket,
      latestEvaluatedBucket,
      phase,
      ready,
    },
    firstPopAt,
    measurement,
  };
}

export function measureGameStateVolatility(
  input: BuildGameStateVolatilityAlertInput,
): BoardGameStateVolatility | null {
  return calculateBoardVwMeasurement(input).measurement;
}

export function buildGameStateVolatilityAlert(
  input: BuildGameStateVolatilityAlertInput,
): BoardAnomalyAlert | null {
  const calculation = calculateBoardVwMeasurement(input);
  const { context, firstPopAt, measurement } = calculation;
  if (context.activeFire == null) {
    return null;
  }

  const activeBucket = context.activeFire.bucket;
  const threshold = context.activeFire.threshold;
  const medianValue = context.activeFire.median;
  const madValue = context.activeFire.mad;
  const families = measurement.sample.families.join(", ") || "no families";
  const sources = measurement.sample.sources.join(", ") || "no sources";
  const weightSources = activeBucket.contributions.reduce(
    (summary, contribution) => {
      if (contribution.weightSource === "quote-volume") {
        summary.quoteVolume += 1;
      } else if (contribution.weightSource === "source-market-volume") {
        summary.sourceMarketVolume += 1;
      } else {
        summary.equalWeightFallback += 1;
      }
      return summary;
    },
    {
      equalWeightFallback: 0,
      sourceMarketVolume: 0,
      quoteVolume: 0,
    },
  );
  const weightSummary = `${weightSources.quoteVolume} quote vol / ${weightSources.sourceMarketVolume} stored vol / ${weightSources.equalWeightFallback} fallback`;

  return {
    id:
      measurement.alertId ??
      ["board-alert", input.gameId, "game-state-volatility", "no-entity", firstPopAt].join(":"),
    gameId: input.gameId,
    gameLabel: input.gameLabel,
    shockKind: "game-state-volatility",
    firstPopAt,
    detectedAt: input.detectedAtIso,
    score: measurement.headlineScore,
    confidence: measurement.confidence,
    severity: scoreToSeverity(measurement.headlineScore),
    reason: `board-vw 60s bucket fired at ${new Date(
      activeBucket.bucketStartMs + BOARD_VW_BUCKET_SECONDS * 1000,
    ).toISOString()}: ${activeBucket.intensity.toFixed(3)} vs ${threshold.toFixed(
      3,
    )} (${medianValue.toFixed(3)} + ${BOARD_VW_K_MAD}*MAD ${madValue.toFixed(
      3,
    )}); ${families}; ${sources}; weights ${weightSummary}`,
    primaryEntityKey: null,
    primaryFamily: null,
    components: measurement.components,
    h0Adjustments: measurement.h0Adjustments,
    evidence: measurement.evidence,
    missingDataNotes: measurement.missingDataNotes,
    inspect: measurement.inspect,
  };
}
