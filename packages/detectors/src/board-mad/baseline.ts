import type { GameTimingContext } from "../types";
import {
  BOARD_MAD_BASELINE_MODE_DEFAULT,
  BOARD_MAD_BASELINE_MODE_HISTORICAL_BLEND,
  BOARD_MAD_BASELINE_MODE_OPENING_RAMP,
  BOARD_MAD_BASELINE_MODE_TRAILING,
  BOARD_MAD_BUCKET_SECONDS_DEFAULT,
  BOARD_MAD_HISTORICAL_PRIOR_WEIGHT_DEFAULT,
  BOARD_MAD_HISTORICAL_RAMP_COMPLETE_GAME_MINUTES_DEFAULT,
  BOARD_MAD_MAD_FLOOR,
  BOARD_MAD_OPENING_BASELINE_BUCKETS_DEFAULT,
  BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_DEFAULT,
  BOARD_MAD_RECENT_WALL_MINUTES_DEFAULT,
  BOARD_MAD_RECENT_WALL_WEIGHT_DEFAULT,
  BOARD_MAD_TRAILING_BUCKETS_DEFAULT,
  BOARD_MAD_TRAILING_GAME_MINUTES_DEFAULT,
  BOARD_MAD_WARMUP_BUCKETS_DEFAULT,
} from "./config";

export type BoardMadBaselineMode =
  | typeof BOARD_MAD_BASELINE_MODE_TRAILING
  | typeof BOARD_MAD_BASELINE_MODE_OPENING_RAMP
  | typeof BOARD_MAD_BASELINE_MODE_HISTORICAL_BLEND;

export interface BoardMadBaselineEntry {
  readonly bucket: number;
  readonly intensity: number;
  readonly gameElapsedSeconds?: number | null;
}

export interface BoardMadHistoricalPrior {
  readonly median: number;
  readonly mad: number;
  readonly sampleSize: number;
}

export interface BoardMadBaselineTiming {
  readonly baselineMode?: BoardMadBaselineMode;
  readonly bucketSeconds?: number;
  readonly openingBaselineBuckets?: number;
  readonly openingRampCompleteBuckets?: number;
  readonly trailingBuckets?: number;
  readonly warmupBuckets?: number;
  readonly historicalPrior?: BoardMadHistoricalPrior;
  readonly historicalPriorWeight?: number;
  readonly historicalRampCompleteGameMinutes?: number;
  readonly trailingGameMinutes?: number;
  readonly recentWallMinutes?: number;
  readonly recentWallWeight?: number;
  // Per-game timing context resolved by the shared detector runner. When set,
  // the elapsed-seconds fallback (for entries without gameElapsedSeconds)
  // anchors on timingContext.tipoffAnchorUtc instead of "first nonzero
  // bucket." When clockSource === "none", every bucket is treated as
  // unwarmed (fail-closed). When unset (legacy callers / synthetic tests
  // that bypass the runner), the old first-nonzero-bucket fallback is used.
  // Audit-fix #2 (phase A2, 2026-05-25).
  readonly timingContext?: GameTimingContext;
}

export interface BoardMadBaseline {
  readonly median: number;
  readonly mad: number;
  readonly warmedUp: boolean;
}

// timingContext stays optional even in the resolved shape: legacy callers
// and synthetic unit tests bypass the runner and have no per-game timing
// context. Runner-fed code paths always set it.
type ResolvedBoardMadBaselineTiming = Required<Omit<BoardMadBaselineTiming, "timingContext">> & {
  readonly timingContext?: GameTimingContext;
};

export const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0;
  const sorted = xs.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[mid - 1] ?? 0;
  return (lower + upper) / 2;
};

export const medianAbsDev = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0;
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
};

const resolvePositiveInteger = (value: number | undefined, fallback: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.round(value ?? fallback));
};

const resolveNonNegativeNumber = (value: number | undefined, fallback: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, value ?? fallback);
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const isEntrySeries = (
  values: readonly number[] | readonly BoardMadBaselineEntry[],
): values is readonly BoardMadBaselineEntry[] => {
  const first = values[0];
  return first !== undefined && typeof first !== "number";
};

const asEntries = (
  values: readonly number[] | readonly BoardMadBaselineEntry[],
  bucketSeconds: number,
): readonly BoardMadBaselineEntry[] => {
  const first = values[0];
  if (first === undefined) return [];
  if (isEntrySeries(values)) return values;
  return values.map((value, bucketIndex): BoardMadBaselineEntry => {
    return { bucket: bucketIndex * bucketSeconds, intensity: value };
  });
};

const isFiniteNumber = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);

// Per audit-fix #2 (phase A2, 2026-05-25): when a bucket has no per-tick
// gameElapsedSeconds (PBP lag, missing PBP for the game), fall back to a
// tipoff-anchored elapsed time using the per-game GameTimingContext from
// the runner. NEVER fall back to "first nonzero market bucket" when a real
// tipoff anchor is available — that was the original category error this
// audit closes. When NO context is available (legacy callers, synthetic
// unit tests bypassing the runner), the old first-bucket fallback applies.
const elapsedSecondsFromTipoff = (
  bucket: number,
  timing: Pick<BoardMadBaselineTiming, "timingContext">,
): number | null => {
  const ctx = timing.timingContext;
  if (ctx === undefined) return null;
  if (ctx.clockSource === "none") return null;
  return Math.max(0, bucket - ctx.tipoffAnchorUtc.getTime() / 1000);
};

const elapsedSecondsForBucket = (
  entries: readonly BoardMadBaselineEntry[],
  bucketIndex: number,
  timing: Pick<BoardMadBaselineTiming, "timingContext"> = {},
): number => {
  const current = entries[bucketIndex];
  if (current === undefined) return 0;
  if (isFiniteNumber(current.gameElapsedSeconds)) return Math.max(0, current.gameElapsedSeconds);
  const tipoffElapsed = elapsedSecondsFromTipoff(current.bucket, timing);
  if (tipoffElapsed !== null) return tipoffElapsed;
  const first = entries[0];
  if (first === undefined) return 0;
  return Math.max(0, current.bucket - first.bucket);
};

const elapsedSecondsForEntry = (
  entries: readonly BoardMadBaselineEntry[],
  entry: BoardMadBaselineEntry,
  timing: Pick<BoardMadBaselineTiming, "timingContext"> = {},
): number => {
  if (isFiniteNumber(entry.gameElapsedSeconds)) return Math.max(0, entry.gameElapsedSeconds);
  const tipoffElapsed = elapsedSecondsFromTipoff(entry.bucket, timing);
  if (tipoffElapsed !== null) return tipoffElapsed;
  const first = entries[0];
  if (first === undefined) return 0;
  return Math.max(0, entry.bucket - first.bucket);
};

const isWarmedUpBucket = (
  entries: readonly BoardMadBaselineEntry[],
  bucketIndex: number,
  timing: ResolvedBoardMadBaselineTiming,
): boolean => {
  // Fail-closed when clockSource="none": no real anchor → no warmup → no
  // fires. resolveGameTimingContext returns "none" only when both PBP and
  // games.scheduled_start are absent for the game. Legacy callers that
  // don't supply timingContext at all (synthetic tests, pre-A2 code) fall
  // through to the elapsed-time gate as before.
  if (timing.timingContext !== undefined && timing.timingContext.clockSource === "none") {
    return false;
  }
  const warmupSeconds = timing.warmupBuckets * timing.bucketSeconds;
  return elapsedSecondsForBucket(entries, bucketIndex, timing) >= warmupSeconds;
};

const trailingWindowSeconds = (timing: ResolvedBoardMadBaselineTiming): number =>
  timing.trailingBuckets * timing.bucketSeconds;

const priorValuesWithinElapsedWindow = (
  entries: readonly BoardMadBaselineEntry[],
  bucketIndex: number,
  timing: ResolvedBoardMadBaselineTiming,
): readonly number[] => {
  const current = entries[bucketIndex];
  if (current === undefined) return [];
  const windowSeconds = trailingWindowSeconds(timing);
  const currentElapsed = elapsedSecondsForBucket(entries, bucketIndex, timing);
  const collect = (i: number): readonly number[] => {
    const entry = entries[i];
    if (entry === undefined) return [];
    // Prefer per-tick gameElapsedSeconds when both sides have it. Otherwise
    // anchor the entry's elapsed via the same path as currentElapsed (tipoff
    // anchor when available, first-bucket fallback otherwise).
    const entryElapsed =
      isFiniteNumber(current.gameElapsedSeconds) && isFiniteNumber(entry.gameElapsedSeconds)
        ? entry.gameElapsedSeconds
        : elapsedSecondsForEntry(entries, entry, timing);
    if (entryElapsed >= currentElapsed) return collect(i - 1);
    if (entryElapsed < currentElapsed - windowSeconds) return [];
    return [entry.intensity, ...collect(i - 1)];
  };
  return collect(bucketIndex - 1);
};

const openingRampWindowSeconds = (
  entries: readonly BoardMadBaselineEntry[],
  bucketIndex: number,
  timing: ResolvedBoardMadBaselineTiming,
): number => {
  const currentElapsed = elapsedSecondsForBucket(entries, bucketIndex, timing);
  const warmupSeconds = timing.warmupBuckets * timing.bucketSeconds;
  const openingSeconds = timing.openingBaselineBuckets * timing.bucketSeconds;
  const rampCompleteSeconds = timing.openingRampCompleteBuckets * timing.bucketSeconds;
  const targetSeconds = trailingWindowSeconds(timing);
  if (currentElapsed <= warmupSeconds) return Math.min(currentElapsed, openingSeconds);
  const rampSpan = Math.max(1, rampCompleteSeconds - warmupSeconds);
  const progress = Math.min(1, Math.max(0, (currentElapsed - warmupSeconds) / rampSpan));
  return Math.min(currentElapsed, openingSeconds + progress * (targetSeconds - openingSeconds));
};

const openingValuesFromGameStart = (
  entries: readonly BoardMadBaselineEntry[],
  bucketIndex: number,
  timing: ResolvedBoardMadBaselineTiming,
): readonly number[] => {
  const currentElapsed = elapsedSecondsForBucket(entries, bucketIndex, timing);
  const windowSeconds = openingRampWindowSeconds(entries, bucketIndex, timing);
  return entries
    .slice(0, bucketIndex)
    .filter((entry) => {
      const elapsed = elapsedSecondsForEntry(entries, entry, timing);
      return elapsed < currentElapsed && elapsed <= windowSeconds;
    })
    .map((e) => e.intensity);
};

function priorValuesForBucket(
  entries: readonly BoardMadBaselineEntry[],
  bucketIndex: number,
  timing: ResolvedBoardMadBaselineTiming,
): readonly number[] {
  if (timing.baselineMode === BOARD_MAD_BASELINE_MODE_OPENING_RAMP) {
    const currentElapsed = elapsedSecondsForBucket(entries, bucketIndex, timing);
    const rampCompleteSeconds = timing.openingRampCompleteBuckets * timing.bucketSeconds;
    if (currentElapsed < rampCompleteSeconds) {
      return openingValuesFromGameStart(entries, bucketIndex, timing);
    }
    return priorValuesWithinElapsedWindow(entries, bucketIndex, timing);
  }
  return priorValuesWithinElapsedWindow(entries, bucketIndex, timing);
}

const weightedAverage = (a: number, weightA: number, b: number, weightB: number): number => {
  const totalWeight = weightA + weightB;
  if (totalWeight <= 0) return a;
  return (a * weightA + b * weightB) / totalWeight;
};

// AMENDED 2026-05-25 (audit-fix #5, phase A4): returns a typed { median, mad }
// estimator instead of a synthetic [med-mad, med, med+mad] 3-tuple. The
// previous tuple was statistical theater — downstream code would compute
// median()/medianAbsDev() on it and recover m + mad arithmetically by the
// median-of-three property, but the actual underlying sample distribution
// was already gone. Returning the estimator directly is honest about what
// the blended baseline IS (a weighted combination of two summary stats from
// disjoint windows) and removes a fragile arithmetic trick.
//
// Returns null when both windows are empty so resolveBoardMadBaseline can
// fall through to the trailing/opening-ramp baseline as the live-data
// fallback (same shape as before; just typed instead of length-checked).
interface BlendedEstimator {
  readonly median: number;
  readonly mad: number;
}

const liveEstimatorForHistoricalBucket = (
  entries: readonly BoardMadBaselineEntry[],
  bucketIndex: number,
  timing: ResolvedBoardMadBaselineTiming,
): BlendedEstimator | null => {
  const current = entries[bucketIndex];
  if (current === undefined) return null;
  const priorEntries = entries.slice(0, bucketIndex);
  const currentElapsed = current.gameElapsedSeconds;
  const gameWindowSeconds = timing.trailingGameMinutes * 60;
  const gameValues =
    isFiniteNumber(currentElapsed) && gameWindowSeconds > 0
      ? priorEntries
          .filter(
            (e) =>
              isFiniteNumber(e.gameElapsedSeconds) &&
              e.gameElapsedSeconds < currentElapsed &&
              e.gameElapsedSeconds >= currentElapsed - gameWindowSeconds,
          )
          .map((e) => e.intensity)
      : [];

  const recentWallSeconds = timing.recentWallMinutes * 60;
  const recentValues =
    recentWallSeconds > 0 && timing.recentWallWeight > 0
      ? priorEntries
          .filter(
            (e) => e.bucket < current.bucket && e.bucket >= current.bucket - recentWallSeconds,
          )
          .map((e) => e.intensity)
      : [];

  if (gameValues.length === 0 && recentValues.length === 0) return null;
  if (gameValues.length === 0) {
    return { median: median(recentValues), mad: medianAbsDev(recentValues) };
  }
  if (recentValues.length === 0) {
    return { median: median(gameValues), mad: medianAbsDev(gameValues) };
  }

  // Both windows populated: weighted average of the two summary stats.
  // recentWallWeight is the weight assigned to the recent-wall window
  // relative to the game-clock window (1). See config.ts:53 for the
  // tunable default (1.5 → recent gets 1.5x the game window's influence).
  const gameMed = median(gameValues);
  const gameMad = medianAbsDev(gameValues);
  const recentMed = median(recentValues);
  const recentMad = medianAbsDev(recentValues);
  return {
    median: weightedAverage(gameMed, 1, recentMed, timing.recentWallWeight),
    mad: weightedAverage(gameMad, 1, recentMad, timing.recentWallWeight),
  };
};

const historicalShareForBucket = (
  entries: readonly BoardMadBaselineEntry[],
  bucketIndex: number,
  timing: ResolvedBoardMadBaselineTiming,
): number => {
  const current = entries[bucketIndex];
  if (current === undefined) return 0;
  const rampSeconds = Math.max(1, timing.historicalRampCompleteGameMinutes * 60);
  // Per audit-fix #2 (phase A2): replace the sparse-index-times-bucketSeconds
  // fallback (which conflated array position with elapsed time) with a
  // tipoff-anchored elapsed. elapsedSecondsForBucket prefers per-tick
  // gameElapsedSeconds, then GameTimingContext.tipoffAnchorUtc, then the
  // legacy first-bucket fallback as a last resort.
  const elapsedSeconds = elapsedSecondsForBucket(entries, bucketIndex, timing);
  const remaining = Math.max(0, 1 - elapsedSeconds / rampSeconds);
  return clamp01(timing.historicalPriorWeight) * remaining;
};

export function resolveBoardMadBaseline(
  values: readonly number[] | readonly BoardMadBaselineEntry[],
  bucketIndex: number,
  timing: BoardMadBaselineTiming,
): BoardMadBaseline {
  const resolvedTiming: ResolvedBoardMadBaselineTiming = {
    baselineMode: timing.baselineMode ?? BOARD_MAD_BASELINE_MODE_DEFAULT,
    bucketSeconds: resolvePositiveInteger(timing.bucketSeconds, BOARD_MAD_BUCKET_SECONDS_DEFAULT),
    openingBaselineBuckets: resolvePositiveInteger(
      timing.openingBaselineBuckets,
      BOARD_MAD_OPENING_BASELINE_BUCKETS_DEFAULT,
    ),
    openingRampCompleteBuckets: resolvePositiveInteger(
      timing.openingRampCompleteBuckets,
      BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_DEFAULT,
    ),
    trailingBuckets: resolvePositiveInteger(
      timing.trailingBuckets,
      BOARD_MAD_TRAILING_BUCKETS_DEFAULT,
    ),
    warmupBuckets: resolvePositiveInteger(timing.warmupBuckets, BOARD_MAD_WARMUP_BUCKETS_DEFAULT),
    historicalPrior: timing.historicalPrior ?? { median: 0, mad: 0, sampleSize: 0 },
    historicalPriorWeight: clamp01(
      timing.historicalPriorWeight ?? BOARD_MAD_HISTORICAL_PRIOR_WEIGHT_DEFAULT,
    ),
    historicalRampCompleteGameMinutes: resolveNonNegativeNumber(
      timing.historicalRampCompleteGameMinutes,
      BOARD_MAD_HISTORICAL_RAMP_COMPLETE_GAME_MINUTES_DEFAULT,
    ),
    trailingGameMinutes: resolveNonNegativeNumber(
      timing.trailingGameMinutes,
      BOARD_MAD_TRAILING_GAME_MINUTES_DEFAULT,
    ),
    recentWallMinutes: resolveNonNegativeNumber(
      timing.recentWallMinutes,
      BOARD_MAD_RECENT_WALL_MINUTES_DEFAULT,
    ),
    recentWallWeight: resolveNonNegativeNumber(
      timing.recentWallWeight,
      BOARD_MAD_RECENT_WALL_WEIGHT_DEFAULT,
    ),
    // timingContext stays optional in the resolved shape. Three states:
    // - undefined: legacy callers (synthetic tests, pre-A2 code) → fall back
    //   to first-bucket wall-elapsed (backward compatible)
    // - { clockSource: "pbp" | "scheduled", ... }: runner-fed → anchor elapsed
    //   on tipoffAnchorUtc when per-tick gameElapsedSeconds is null
    // - { clockSource: "none", ... }: runner-fed but no anchor exists →
    //   isWarmedUpBucket returns false (fail-closed; no fake fires)
    ...(timing.timingContext === undefined ? {} : { timingContext: timing.timingContext }),
  };
  const entries = asEntries(values, resolvedTiming.bucketSeconds);
  if (!isWarmedUpBucket(entries, bucketIndex, resolvedTiming)) {
    return { median: 0, mad: 0, warmedUp: false };
  }
  // AMENDED 2026-05-25 (audit-fix #5, phase A4): historical-blend mode now
  // gets a typed {median, mad} estimator directly from
  // liveEstimatorForHistoricalBucket instead of a synthetic [m-mad, m, m+mad]
  // sample array. When the blended estimator is null (both windows empty),
  // fall through to the trailing/opening-ramp baseline. For non-blend modes,
  // compute median/MAD from the prior-values sample as before.
  const blendedEstimator =
    resolvedTiming.baselineMode === BOARD_MAD_BASELINE_MODE_HISTORICAL_BLEND
      ? liveEstimatorForHistoricalBucket(entries, bucketIndex, resolvedTiming)
      : null;
  const fallbackValues =
    blendedEstimator === null ? priorValuesForBucket(entries, bucketIndex, resolvedTiming) : [];
  const liveMedian = blendedEstimator === null ? median(fallbackValues) : blendedEstimator.median;
  const liveMadRaw =
    blendedEstimator === null ? medianAbsDev(fallbackValues) : blendedEstimator.mad;
  const historicalPrior = resolvedTiming.historicalPrior;
  const historicalShare =
    resolvedTiming.baselineMode === BOARD_MAD_BASELINE_MODE_HISTORICAL_BLEND &&
    historicalPrior.sampleSize > 0
      ? historicalShareForBucket(entries, bucketIndex, resolvedTiming)
      : 0;
  const med =
    historicalShare > 0
      ? weightedAverage(liveMedian, 1 - historicalShare, historicalPrior.median, historicalShare)
      : liveMedian;
  const madRaw =
    historicalShare > 0
      ? weightedAverage(
          liveMadRaw,
          1 - historicalShare,
          historicalPrior.mad === 0 ? BOARD_MAD_MAD_FLOOR : historicalPrior.mad,
          historicalShare,
        )
      : liveMadRaw;
  return {
    median: med,
    mad: madRaw === 0 ? BOARD_MAD_MAD_FLOOR : madRaw,
    warmedUp: true,
  };
}
