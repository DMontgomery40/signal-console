import {
  BOARD_MAD_BASELINE_MODE_OPENING_RAMP,
  BOARD_MAD_BASELINE_MODE_TRAILING,
  BOARD_MAD_MAD_FLOOR,
  BOARD_MAD_OPENING_BASELINE_BUCKETS_DEFAULT,
  BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_DEFAULT,
  BOARD_MAD_TRAILING_BUCKETS_DEFAULT,
  BOARD_MAD_WARMUP_BUCKETS_DEFAULT,
} from "./config";

export type BoardMadBaselineMode =
  | typeof BOARD_MAD_BASELINE_MODE_TRAILING
  | typeof BOARD_MAD_BASELINE_MODE_OPENING_RAMP;

export interface BoardMadBaselineTiming {
  readonly baselineMode?: BoardMadBaselineMode;
  readonly openingBaselineBuckets?: number;
  readonly openingRampCompleteBuckets?: number;
  readonly trailingBuckets?: number;
  readonly warmupBuckets?: number;
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

const openingRampWindowSize = (
  bucketIndex: number,
  warmupBuckets: number,
  trailingBuckets: number,
  openingBaselineBuckets: number,
  openingRampCompleteBuckets: number,
): number => {
  if (bucketIndex <= warmupBuckets) return Math.min(bucketIndex, openingBaselineBuckets);
  const rampSpan = Math.max(1, openingRampCompleteBuckets - warmupBuckets);
  const progress = Math.min(1, Math.max(0, (bucketIndex - warmupBuckets) / rampSpan));
  const rawWindow = openingBaselineBuckets + progress * (trailingBuckets - openingBaselineBuckets);
  return Math.min(bucketIndex, trailingBuckets, Math.max(1, Math.round(rawWindow)));
};

function priorValuesForBucket(
  intensities: readonly number[],
  bucketIndex: number,
  timing: Required<BoardMadBaselineTiming>,
): readonly number[] {
  if (timing.baselineMode === BOARD_MAD_BASELINE_MODE_OPENING_RAMP) {
    const windowSize = openingRampWindowSize(
      bucketIndex,
      timing.warmupBuckets,
      timing.trailingBuckets,
      timing.openingBaselineBuckets,
      timing.openingRampCompleteBuckets,
    );
    if (bucketIndex < timing.openingRampCompleteBuckets) {
      return intensities.slice(0, windowSize);
    }
    return intensities.slice(Math.max(0, bucketIndex - timing.trailingBuckets), bucketIndex);
  }
  return intensities.slice(Math.max(0, bucketIndex - timing.trailingBuckets), bucketIndex);
}

export function resolveBoardMadBaseline(
  intensities: readonly number[],
  bucketIndex: number,
  timing: BoardMadBaselineTiming,
): BoardMadBaseline {
  const resolvedTiming: Required<BoardMadBaselineTiming> = {
    baselineMode: timing.baselineMode ?? BOARD_MAD_BASELINE_MODE_TRAILING,
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
  };
  if (bucketIndex < resolvedTiming.warmupBuckets) {
    return { median: 0, mad: 0, warmedUp: false };
  }
  const priorValues = priorValuesForBucket(intensities, bucketIndex, resolvedTiming);
  const med = median(priorValues);
  const madRaw = medianAbsDev(priorValues);
  return {
    median: med,
    mad: madRaw === 0 ? BOARD_MAD_MAD_FLOOR : madRaw,
    warmedUp: true,
  };
}
