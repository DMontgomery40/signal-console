import type {
  BoardAnomalyAlert,
  BoardAnomalyDetectorConfig,
  BoardGameStateVolatility,
  BoardGameStateVolatilityBand,
  BoardObservationScored,
  BoardShockEvidence,
  BoardGameStateVolatilityRuntimeConfig,
  MarketFamily,
  ResearchSourceId,
} from "@signal-console/domain";
import {
  fetchBoardVolatilityStateSpace,
  type VolatilityStateSpaceRequest,
  type VolatilityStateSpaceResultObservation,
} from "@signal-console/detectors/board-mad/state-space-runtime";

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

type FetchLike = typeof fetch;

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
  fetchImpl?: FetchLike;
  gameId: string;
  gameLabel: string;
  gameStates?: GameStateRow[];
  materializationDiagnostics?: BoardObservationMaterializationDiagnostics;
  nowMs: number;
  scheduledStart?: string;
  scored: BoardObservationScored[];
  shockWindowMs: number;
  sidecarBaseUrl?: string;
};

type BoardVwContribution = {
  bucketStartMs: number;
  deltaAbs: number;
  deltaSigned: number;
  row: BoardObservationScored;
  sourceKey: string;
  timestampMs: number;
  weightLabel: string;
  weightSource: "quote-volume" | "source-market-volume" | "equal-weight-fallback";
  volumeWeight: number;
  weightedDelta: number;
  weightedSignedDelta: number;
};

type BoardVwBucket = {
  bucketStartMs: number;
  contributions: BoardVwContribution[];
  intensity: number;
};

type BoardVwEvaluation = {
  bucket: BoardVwBucket;
  index: number;
  observation: VolatilityStateSpaceResultObservation;
};

type BoardVwMeasurementContext = {
  activeFire: BoardVwEvaluation | null;
  activeStreakBucketCount: number;
  availableBucketCount: number;
  latestBucket: BoardVwBucket | null;
  latestEvaluatedBucket: BoardVwEvaluation | null;
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

function resolveBoardVwWeight(
  row: BoardObservationScored,
  runtime: BoardGameStateVolatilityRuntimeConfig,
) {
  if (runtime.weighting === "equal") {
    return {
      label: "weight 1",
      source: "equal-weight-fallback" as const,
      weight: 1,
    };
  }

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

function buildBoardVwBuckets(
  scored: BoardObservationScored[],
  nowMs: number,
  runtime: BoardGameStateVolatilityRuntimeConfig,
): BoardVwBucket[] {
  const bucketMs = runtime.bucketSeconds * 1000;
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
      if (gapSeconds <= 0 || gapSeconds > runtime.freshCapSeconds) {
        continue;
      }

      const deltaSigned = currentProbability - previousProbability;
      const deltaAbs = Math.abs(deltaSigned);
      if (deltaAbs <= 0) continue;

      const bucketStartMs = Math.floor(currentTs / bucketMs) * bucketMs;
      if (bucketStartMs + bucketMs > nowMs) continue;

      const weight = resolveBoardVwWeight(current, runtime);
      const volumeWeight = weight.weight;
      const weightedDelta = deltaAbs * volumeWeight;
      const weightedSignedDelta = deltaSigned * volumeWeight;
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
        deltaSigned,
        row: current,
        sourceKey: current.observation.source ?? current.observation.sourceMarketId,
        timestampMs: currentTs,
        weightLabel: weight.label,
        weightSource: weight.source,
        volumeWeight,
        weightedDelta,
        weightedSignedDelta,
      });
      bucketMap.set(bucketStartMs, bucket);
    }
  }

  return Array.from(bucketMap.values()).sort(
    (left, right) => left.bucketStartMs - right.bucketStartMs,
  );
}

function buildStateSpaceRequest(
  input: BuildGameStateVolatilityAlertInput,
  buckets: BoardVwBucket[],
): VolatilityStateSpaceRequest {
  const runtime = input.config.gameStateVolatility.runtime;
  return {
    gameId: input.gameId,
    observations: buckets.map((bucket) => {
      const sourceContribution = new Map<string, number>();
      const sourceSignedContribution = new Map<string, number>();
      const activeMarkets = new Set<string>();
      for (const contribution of bucket.contributions) {
        activeMarkets.add(contribution.row.observation.sourceMarketId);
        sourceContribution.set(
          contribution.sourceKey,
          (sourceContribution.get(contribution.sourceKey) ?? 0) + contribution.weightedDelta,
        );
        sourceSignedContribution.set(
          contribution.sourceKey,
          (sourceSignedContribution.get(contribution.sourceKey) ?? 0) +
            contribution.weightedSignedDelta,
        );
      }
      const sourceValues = Array.from(sourceContribution.values()).sort((a, b) => b - a);
      const signedSourceValues = Array.from(sourceSignedContribution.values());
      const dominantShare =
        bucket.intensity <= 0 || sourceValues.length === 0
          ? 1
          : (sourceValues[0] ?? bucket.intensity) / bucket.intensity;
      const totalSignedAbs = signedSourceValues.reduce((sum, value) => sum + Math.abs(value), 0);
      const netSigned = signedSourceValues.reduce((sum, value) => sum + value, 0);
      const sourceDisagreement =
        signedSourceValues.length <= 1 || totalSignedAbs <= 0
          ? 0
          : 1 - Math.abs(netSigned) / totalSignedAbs;
      return {
        activeMarketCount: activeMarkets.size,
        bucketEnd: new Date(bucket.bucketStartMs + runtime.bucketSeconds * 1000).toISOString(),
        bucketStart: new Date(bucket.bucketStartMs).toISOString(),
        intensity: bucket.intensity,
        sourceCount: sourceContribution.size,
        sourceDisagreement,
        sourceDominance: dominantShare,
      };
    }),
    params: {
      baselineMode: runtime.baselineMode,
      bucketSeconds: runtime.bucketSeconds,
      kMad: runtime.kMad,
      openingBaselineBuckets: runtime.openingBaselineBuckets,
      openingRampCompleteBuckets: runtime.openingRampCompleteBuckets,
      stateSpace: runtime.stateSpace,
      trailingBuckets: runtime.trailingBuckets,
      warmupBuckets: runtime.warmupBuckets,
    },
  };
}

async function evaluateBoardVwBuckets(
  input: BuildGameStateVolatilityAlertInput,
  buckets: BoardVwBucket[],
): Promise<BoardVwEvaluation[]> {
  const response = await fetchBoardVolatilityStateSpace({
    baseUrl: input.sidecarBaseUrl,
    fetchImpl: input.fetchImpl,
    request: buildStateSpaceRequest(input, buckets),
  });
  const bucketByStart = new Map(
    buckets.map((bucket) => [new Date(bucket.bucketStartMs).toISOString(), bucket] as const),
  );
  if (response.observations.length !== buckets.length) {
    throw new Error(
      `Board volatility sidecar returned ${String(response.observations.length)} rows for ${String(
        buckets.length,
      )} buckets.`,
    );
  }
  return response.observations.map((observation, index) => {
    const bucket = bucketByStart.get(observation.bucketStart);
    if (bucket == null) {
      throw new Error(
        `Board volatility sidecar returned unknown bucketStart ${observation.bucketStart}.`,
      );
    }
    return {
      bucket,
      index,
      observation,
    };
  });
}

function countActiveFireStreak(
  evaluated: BoardVwEvaluation[],
  activeIndex: number,
  bucketSeconds: number,
) {
  let count = 1;
  for (let index = activeIndex - 1; index >= 0; index -= 1) {
    const current = evaluated[index];
    const next = evaluated[index + 1];
    if (!current.observation.fired || !next.observation.fired) break;
    if (next.bucket.bucketStartMs - current.bucket.bucketStartMs !== bucketSeconds * 1000) {
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
    reason: `board-state-space ${item.deltaAbs.toFixed(3)} * ${item.weightLabel}`,
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
    reason: `board-state-space ${item.deltaAbs.toFixed(3)} * ${item.weightLabel}`,
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

function emptyBucketView(): CurrentBucketView {
  return {
    contributions: [],
    coveragePenalty: 0,
    evidence: [],
    families: [],
    h0Adjustments: {
      appliedSuppression: 0,
      drivers: [],
    },
    inspect: {
      instrumentIds: [],
      payloadVersion: 1,
      relationFamilies: ["game-state-volatility"],
      sourceMarketIds: [],
    },
    missingDataNotes: [],
    predictionMarketRows: 0,
    sourceCount: 0,
    sourceMarketCount: 0,
    sources: [],
    supportingEvidence: [],
    weightSources: {
      equalWeightFallback: 0,
      sourceMarketVolume: 0,
      quoteVolume: 0,
    },
  };
}

function standardNormalCdf(value: number) {
  const sign = value < 0 ? -1 : 1;
  const scaled = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * scaled);
  const polynomial =
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
    t *
    Math.exp(-(scaled * scaled));
  const erf = 1 - polynomial;
  return clamp01(0.5 * (1 + sign * erf));
}

function expectedRangeFromObservation(observation: VolatilityStateSpaceResultObservation) {
  const p50 = Math.max(0, observation.baselineMedian);
  const unit = Math.max(0, observation.baselineMad);
  return {
    p50: Number(p50.toFixed(3)),
    p75: Number((p50 + unit).toFixed(3)),
    p90: Number((p50 + unit * 1.9).toFixed(3)),
    p99: Number((p50 + unit * 3.45).toFixed(3)),
  };
}

function scoreFromStateSpace(percentileValue: number, ready: boolean, activeFire: boolean) {
  if (!ready) return 0;
  const percentileScore = Math.max(0, Math.min(100, Math.round(percentileValue * 100)));
  return activeFire ? Math.max(55, percentileScore) : Math.min(54, percentileScore);
}

function bandForScore(options: {
  activeFire: boolean;
  criticalEligible: boolean;
  ready: boolean;
  score: number;
}): BoardGameStateVolatilityBand {
  if (!options.ready) return "insufficient-data";
  if (options.criticalEligible && options.score >= 85) return "critical";
  if (options.activeFire) return "alert";
  if (options.score >= 40) return "elevated";
  return "normal";
}

async function calculateBoardVwMeasurement(input: BuildGameStateVolatilityAlertInput): Promise<{
  context: BoardVwMeasurementContext;
  firstPopAt: string;
  measurement: BoardGameStateVolatility;
}> {
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
  const runtime = input.config.gameStateVolatility.runtime;
  const buckets = buildBoardVwBuckets(input.scored, input.nowMs, runtime);
  const evaluated = buckets.length === 0 ? [] : await evaluateBoardVwBuckets(input, buckets);
  const latestBucket = buckets[buckets.length - 1] ?? null;
  const latestEvaluatedBucket = evaluated[evaluated.length - 1] ?? null;
  let activeFireIndex = -1;
  for (let index = evaluated.length - 1; index >= 0; index -= 1) {
    const candidate = evaluated[index];
    if (
      candidate?.observation.fired &&
      input.nowMs - candidate.bucket.bucketStartMs - runtime.bucketSeconds * 1000 <=
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
    activeFireIndex >= 0
      ? countActiveFireStreak(evaluated, activeFireIndex, runtime.bucketSeconds)
      : 0;
  const selectedEvaluation = activeFire ?? latestEvaluatedBucket;
  const ready = selectedEvaluation?.observation.warmedUp ?? false;
  const view = selectedEvaluation ? buildBucketView(selectedEvaluation.bucket) : emptyBucketView();
  const currentIntensity = selectedEvaluation?.bucket.intensity ?? 0;
  const threshold = selectedEvaluation?.observation.threshold ?? 0;
  const standardizedInnovation = selectedEvaluation?.observation.standardizedInnovation ?? 0;
  const regimeScore = selectedEvaluation?.observation.regimeScore ?? 0;
  const percentileValue = ready ? standardNormalCdf(standardizedInnovation) : 0;
  let streakStartMs: number | null = null;
  if (activeFireIndex >= 0) {
    const streakStartIndex = activeFireIndex - activeStreakBucketCount + 1;
    const streakStartBucket = evaluated[streakStartIndex]?.bucket;
    if (streakStartBucket) {
      streakStartMs = streakStartBucket.bucketStartMs + runtime.bucketSeconds * 1000;
    }
  }
  const selectedFamilies = view.families;
  const familyBreadth = clamp01(selectedFamilies.length / DISPLAY_FAMILY_ORDER.length);
  const sourceBreadth = clamp01(Math.max(0, view.sourceCount - 1) / 2);
  const meanLogVolume =
    view.contributions.length === 0
      ? 0
      : view.contributions.reduce((sum, item) => sum + item.volumeWeight, 0) /
        view.contributions.length;
  const coreLiquidityStress = clamp01(meanLogVolume / 8);
  const calibratedAbnormality =
    ready && threshold > 0 ? clamp01(currentIntensity / Math.max(threshold, currentIntensity)) : 0;
  const confidence = ready
    ? Math.max(
        0.25,
        Math.min(
          0.95,
          0.35 +
            (activeFire ? 0.2 : 0) +
            familyBreadth * 0.2 +
            sourceBreadth * 0.15 +
            percentileValue * 0.1 -
            view.coveragePenalty * 0.15,
        ),
      )
    : 0.2;
  const criticalEligible =
    selectedFamilies.length >= 3 && activeStreakBucketCount >= 2 && view.sourceCount >= 2;
  const score = scoreFromStateSpace(percentileValue, ready, activeFire != null);
  const band = bandForScore({
    activeFire: activeFire != null,
    criticalEligible,
    ready,
    score,
  });

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
  const previousRegimeScore =
    selectedEvaluation != null && selectedEvaluation.index > 0
      ? (evaluated[selectedEvaluation.index - 1]?.observation.regimeScore ?? 0)
      : 0;

  const measurement: BoardGameStateVolatility = {
    alertId:
      activeFire != null
        ? ["board-alert", input.gameId, "game-state-volatility", "no-entity", firstPopAt].join(":")
        : null,
    band,
    baseline: {
      cohortKey: [
        "board-state-space",
        `mode-${runtime.baselineMode}`,
        `bucket-${runtime.bucketSeconds}`,
        `k-${runtime.kMad}`,
        `trail-${runtime.trailingBuckets}`,
        `warmup-${runtime.warmupBuckets}`,
      ].join("|"),
      expectedRange:
        selectedEvaluation == null
          ? { p50: 0, p75: 0, p90: 0, p99: 0 }
          : expectedRangeFromObservation(selectedEvaluation.observation),
      percentile: Number(percentileValue.toFixed(3)),
      sampleSize: selectedEvaluation?.index ?? 0,
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
      bucketSeconds: runtime.bucketSeconds,
      decayRegime: phase.kind,
      innovation: Number(standardizedInnovation.toFixed(3)),
      observationCount: evaluated.length,
      stressLevel: Number(regimeScore.toFixed(3)),
      stressVelocity: Number((regimeScore - previousRegimeScore).toFixed(3)),
    },
    gameId: input.gameId,
    gameLabel: input.gameLabel,
    gates: {
      criticalEligible,
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
      persistenceSeconds: activeStreakBucketCount * runtime.bucketSeconds,
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

export async function measureGameStateVolatility(
  input: BuildGameStateVolatilityAlertInput,
): Promise<BoardGameStateVolatility | null> {
  return (await calculateBoardVwMeasurement(input)).measurement;
}

export async function buildGameStateVolatilityAlert(
  input: BuildGameStateVolatilityAlertInput,
): Promise<BoardAnomalyAlert | null> {
  const calculation = await calculateBoardVwMeasurement(input);
  const { context, firstPopAt, measurement } = calculation;
  if (context.activeFire == null) {
    return null;
  }

  const activeBucket = context.activeFire.bucket;
  const activeObservation = context.activeFire.observation;
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
    reason: `board state-space ${input.config.gameStateVolatility.runtime.bucketSeconds}s bucket fired at ${new Date(
      activeBucket.bucketStartMs + input.config.gameStateVolatility.runtime.bucketSeconds * 1000,
    ).toISOString()}: ${activeBucket.intensity.toFixed(3)} vs threshold ${activeObservation.threshold.toFixed(
      3,
    )} (baseline med ${activeObservation.baselineMedian.toFixed(3)}, regime ${activeObservation.regimeScore.toFixed(
      3,
    )}, z ${activeObservation.standardizedInnovation.toFixed(3)}); ${families}; ${sources}; weights ${weightSummary}`,
    primaryEntityKey: null,
    primaryFamily: null,
    components: measurement.components,
    h0Adjustments: measurement.h0Adjustments,
    evidence: measurement.evidence,
    missingDataNotes: measurement.missingDataNotes,
    inspect: measurement.inspect,
  };
}
