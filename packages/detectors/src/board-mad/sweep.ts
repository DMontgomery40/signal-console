// K-sweep step for board-mad. Given a pre-bucketed BucketSeries (one
// {bucket, intensity} pair per non-empty bucket per game), apply the trailing
// median + K·MAD threshold per K value. K is the only Cry Wolf dial knob
// (US-037) so this is the sub-second half of the detector: precompute the
// per-bucket baseline (median+MAD over the prior trailing window) and the
// per-bucket {bucketStart, bucketEnd} Dates once — depends only on warmup
// and trailing window sizes, not K — then per K just iterate and compare
// intensity >= median + K·MAD.
//
// runSweep matches US-033's signature exactly: it returns one entry per K
// containing only the fires array. runForK is the internal helper used by
// the detector's index.ts to also recover the per-bucket DetectorBucket[]
// (fired flag + baseline median/MAD) needed for /v1/board observations and
// the past-alerts drilldown (US-047).

import type { DetectorBucket, DetectorFire } from "../types";
import type { ParamsResolved } from "./params";
import type { BucketSeries, BucketSeriesGame } from "./prebucket";

export type SweepParams = Omit<ParamsResolved, "kMad">;

export interface SweepResult {
  readonly k: number;
  readonly fires: readonly DetectorFire[];
}

interface Baseline {
  readonly gameId: string;
  readonly bucketStart: Date;
  readonly bucketEnd: Date;
  readonly intensity: number;
  readonly median: number;
  readonly mad: number;
  readonly warmedUp: boolean;
}

const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0;
  const sorted = xs.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[mid - 1] ?? 0;
  return (lower + upper) / 2;
};

const medianAbsDev = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0;
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
};

const baselinesForGame = (
  game: BucketSeriesGame,
  bucketSeconds: number,
  warmupBuckets: number,
  trailingBuckets: number,
): readonly Baseline[] => {
  const entries = game.buckets;
  // Pre-extract intensities once so the per-bucket trailing-window slice
  // doesn't have to walk through { bucket, intensity } objects via .map.
  const intensities = entries.map((e) => e.intensity);
  return entries.map((e, i): Baseline => {
    const bucketStart = new Date(e.bucket * 1000);
    const bucketEnd = new Date((e.bucket + bucketSeconds) * 1000);
    if (i < warmupBuckets) {
      return {
        gameId: game.gameId,
        bucketStart,
        bucketEnd,
        intensity: e.intensity,
        median: 0,
        mad: 0,
        warmedUp: false,
      };
    }
    const trailStart = Math.max(0, i - trailingBuckets);
    const priorValues = intensities.slice(trailStart, i);
    const med = median(priorValues);
    const madRaw = medianAbsDev(priorValues);
    const mad = madRaw === 0 ? 1e-9 : madRaw;
    return {
      gameId: game.gameId,
      bucketStart,
      bucketEnd,
      intensity: e.intensity,
      median: med,
      mad,
      warmedUp: true,
    };
  });
};

const firesFromBaselines = (baselines: readonly Baseline[], k: number): readonly DetectorFire[] =>
  // Single-pass filter+map. The flatMap-of-empty-arrays alternative allocates
  // an empty array per non-fire bucket, which dominates time on a 28-day
  // (40k+ bucket) series.
  baselines
    .filter((b) => b.warmedUp && b.intensity > 0 && b.intensity >= b.median + k * b.mad)
    .map(
      (b): DetectorFire => ({
        gameId: b.gameId,
        bucketStart: b.bucketStart,
        bucketEnd: b.bucketEnd,
        intensity: b.intensity,
        baselineMedian: b.median,
        baselineMad: b.mad,
      }),
    );

const detectorBucketsFromBaselines = (
  baselines: readonly Baseline[],
  k: number,
): readonly DetectorBucket[] =>
  baselines.map((b): DetectorBucket => {
    if (!b.warmedUp) {
      return {
        gameId: b.gameId,
        bucketStart: b.bucketStart,
        bucketEnd: b.bucketEnd,
        intensity: b.intensity,
        baselineMedian: 0,
        baselineMad: 0,
        fired: false,
      };
    }
    const threshold = b.median + k * b.mad;
    const fired = b.intensity >= threshold && b.intensity > 0;
    return {
      gameId: b.gameId,
      bucketStart: b.bucketStart,
      bucketEnd: b.bucketEnd,
      intensity: b.intensity,
      baselineMedian: b.median,
      baselineMad: b.mad,
      fired,
    };
  });

const computeAllBaselines = (
  buckets: BucketSeries,
  warmupBuckets: number,
  trailingBuckets: number,
): readonly Baseline[] =>
  buckets.perGame.flatMap((g) =>
    baselinesForGame(g, buckets.bucketSeconds, warmupBuckets, trailingBuckets),
  );

export function runSweep(
  buckets: BucketSeries,
  kValues: readonly number[],
  params: SweepParams,
): readonly SweepResult[] {
  const baselines = computeAllBaselines(buckets, params.warmupBuckets, params.trailingBuckets);
  return kValues.map(
    (k): SweepResult => ({
      k,
      fires: firesFromBaselines(baselines, k),
    }),
  );
}

export function runForK(
  buckets: BucketSeries,
  k: number,
  params: SweepParams,
): { readonly fires: readonly DetectorFire[]; readonly buckets: readonly DetectorBucket[] } {
  const baselines = computeAllBaselines(buckets, params.warmupBuckets, params.trailingBuckets);
  return {
    fires: firesFromBaselines(baselines, k),
    buckets: detectorBucketsFromBaselines(baselines, k),
  };
}
