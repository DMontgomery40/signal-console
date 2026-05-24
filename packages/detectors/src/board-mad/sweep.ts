// K-sweep step for board-mad. Given a pre-bucketed BucketSeries (one
// {bucket, intensity} pair per non-empty bucket per game), apply the selected
// causal signal timing mode plus K·MAD threshold per K value. K is the only
// Sensitivity dial knob (US-037) so this is the sub-second half of the
// detector: precompute the per-bucket baseline (median+MAD over the selected
// prior sample) and the per-bucket {bucketStart, bucketEnd} Dates once —
// depends on signal timing, not K — then per K just iterate and compare
// intensity >= median + K·MAD.
//
// runSweep matches US-033's signature exactly: it returns one entry per K
// containing only the fires array. runForK is the internal helper used by
// the detector's index.ts to also recover the per-bucket DetectorBucket[]
// (fired flag + baseline median/MAD) needed for /v1/board observations and
// the past-alerts drilldown (US-047).

import type { DetectorBucket, DetectorFire } from "../types";
import { resolveBoardMadBaseline } from "./baseline";
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

const baselinesForGame = (
  game: BucketSeriesGame,
  bucketSeconds: number,
  params: SweepParams,
): readonly Baseline[] => {
  const entries = game.buckets;
  // Pre-extract intensities once so the per-bucket trailing-window slice
  // doesn't have to walk through { bucket, intensity } objects via .map.
  const intensities = entries.map((e) => e.intensity);
  return entries.map((e, i): Baseline => {
    const bucketStart = new Date(e.bucket * 1000);
    const bucketEnd = new Date((e.bucket + bucketSeconds) * 1000);
    const baseline = resolveBoardMadBaseline(intensities, i, params);
    return {
      gameId: game.gameId,
      bucketStart,
      bucketEnd,
      intensity: e.intensity,
      median: baseline.median,
      mad: baseline.mad,
      warmedUp: baseline.warmedUp,
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

const computeAllBaselines = (buckets: BucketSeries, params: SweepParams): readonly Baseline[] =>
  buckets.perGame.flatMap((g) => baselinesForGame(g, buckets.bucketSeconds, params));

export function runSweep(
  buckets: BucketSeries,
  kValues: readonly number[],
  params: SweepParams,
): readonly SweepResult[] {
  const baselines = computeAllBaselines(buckets, params);
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
  const baselines = computeAllBaselines(buckets, params);
  return {
    fires: firesFromBaselines(baselines, k),
    buckets: detectorBucketsFromBaselines(baselines, k),
  };
}
