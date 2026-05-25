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
}

export interface BoardMadBaseline {
  readonly median: number;
  readonly mad: number;
  readonly warmedUp: boolean;
}

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

const elapsedSecondsForBucket = (
  entries: readonly BoardMadBaselineEntry[],
  bucketIndex: number,
): number => {
  const current = entries[bucketIndex];
  if (current === undefined) return 0;
  if (isFiniteNumber(current.gameElapsedSeconds)) return Math.max(0, current.gameElapsedSeconds);
  const first = entries[0];
  if (first === undefined) return 0;
  return Math.max(0, current.bucket - first.bucket);
};

const elapsedSecondsForEntry = (
  entries: readonly BoardMadBaselineEntry[],
  entry: BoardMadBaselineEntry,
): number => {
  if (isFiniteNumber(entry.gameElapsedSeconds)) return Math.max(0, entry.gameElapsedSeconds);
  const first = entries[0];
  if (first === undefined) return 0;
  return Math.max(0, entry.bucket - first.bucket);
};

const isWarmedUpBucket = (
  entries: readonly BoardMadBaselineEntry[],
  bucketIndex: number,
  timing: Required<BoardMadBaselineTiming>,
): boolean => {
  const warmupSeconds = timing.warmupBuckets * timing.bucketSeconds;
  return elapsedSecondsForBucket(entries, bucketIndex) >= warmupSeconds;
};

const trailingWindowSeconds = (timing: Required<BoardMadBaselineTiming>): number =>
  timing.trailingBuckets * timing.bucketSeconds;

const priorValuesWithinElapsedWindow = (
  entries: readonly BoardMadBaselineEntry[],
  bucketIndex: number,
  timing: Required<BoardMadBaselineTiming>,
): readonly number[] => {
  const current = entries[bucketIndex];
  if (current === undefined) return [];
  const windowSeconds = trailingWindowSeconds(timing);
  const currentElapsed = elapsedSecondsForBucket(entries, bucketIndex);
  const collect = (i: number): readonly number[] => {
    const entry = entries[i];
    if (entry === undefined) return [];
    const entryElapsed =
      isFiniteNumber(current.gameElapsedSeconds) && isFiniteNumber(entry.gameElapsedSeconds)
        ? entry.gameElapsedSeconds
        : entry.bucket - current.bucket + currentElapsed;
    if (entryElapsed >= currentElapsed) return collect(i - 1);
    if (entryElapsed < currentElapsed - windowSeconds) return [];
    return [entry.intensity, ...collect(i - 1)];
  };
  return collect(bucketIndex - 1);
};

const openingRampWindowSeconds = (
  entries: readonly BoardMadBaselineEntry[],
  bucketIndex: number,
  timing: Required<BoardMadBaselineTiming>,
): number => {
  const currentElapsed = elapsedSecondsForBucket(entries, bucketIndex);
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
  timing: Required<BoardMadBaselineTiming>,
): readonly number[] => {
  const currentElapsed = elapsedSecondsForBucket(entries, bucketIndex);
  const windowSeconds = openingRampWindowSeconds(entries, bucketIndex, timing);
  return entries
    .slice(0, bucketIndex)
    .filter((entry) => {
      const elapsed = elapsedSecondsForEntry(entries, entry);
      return elapsed < currentElapsed && elapsed <= windowSeconds;
    })
    .map((e) => e.intensity);
};

function priorValuesForBucket(
  entries: readonly BoardMadBaselineEntry[],
  bucketIndex: number,
  timing: Required<BoardMadBaselineTiming>,
): readonly number[] {
  if (timing.baselineMode === BOARD_MAD_BASELINE_MODE_OPENING_RAMP) {
    const currentElapsed = elapsedSecondsForBucket(entries, bucketIndex);
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

const liveValuesForHistoricalBucket = (
  entries: readonly BoardMadBaselineEntry[],
  bucketIndex: number,
  timing: Required<BoardMadBaselineTiming>,
): readonly number[] => {
  const current = entries[bucketIndex];
  if (current === undefined) return [];
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

  if (gameValues.length === 0) return recentValues;
  if (recentValues.length === 0) return gameValues;

  const gameMed = median(gameValues);
  const gameMad = medianAbsDev(gameValues);
  const recentMed = median(recentValues);
  const recentMad = medianAbsDev(recentValues);
  const med = weightedAverage(gameMed, 1, recentMed, timing.recentWallWeight);
  const mad = weightedAverage(gameMad, 1, recentMad, timing.recentWallWeight);
  return [med - mad, med, med + mad];
};

const historicalShareForBucket = (
  entries: readonly BoardMadBaselineEntry[],
  bucketIndex: number,
  timing: Required<BoardMadBaselineTiming>,
): number => {
  const current = entries[bucketIndex];
  if (current === undefined) return 0;
  const rampSeconds = Math.max(1, timing.historicalRampCompleteGameMinutes * 60);
  const elapsedSeconds = isFiniteNumber(current.gameElapsedSeconds)
    ? current.gameElapsedSeconds
    : bucketIndex * timing.bucketSeconds;
  const remaining = Math.max(0, 1 - elapsedSeconds / rampSeconds);
  return clamp01(timing.historicalPriorWeight) * remaining;
};

export function resolveBoardMadBaseline(
  values: readonly number[] | readonly BoardMadBaselineEntry[],
  bucketIndex: number,
  timing: BoardMadBaselineTiming,
): BoardMadBaseline {
  const resolvedTiming: Required<BoardMadBaselineTiming> = {
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
  };
  const entries = asEntries(values, resolvedTiming.bucketSeconds);
  if (!isWarmedUpBucket(entries, bucketIndex, resolvedTiming)) {
    return { median: 0, mad: 0, warmedUp: false };
  }
  const priorValues =
    resolvedTiming.baselineMode === BOARD_MAD_BASELINE_MODE_HISTORICAL_BLEND
      ? liveValuesForHistoricalBucket(entries, bucketIndex, resolvedTiming)
      : priorValuesForBucket(entries, bucketIndex, resolvedTiming);
  const fallbackValues =
    priorValues.length === 0 ? priorValuesForBucket(entries, bucketIndex, resolvedTiming) : [];
  const liveValues = priorValues.length === 0 ? fallbackValues : priorValues;
  const liveMedian = median(liveValues);
  const liveMadRaw = medianAbsDev(liveValues);
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
