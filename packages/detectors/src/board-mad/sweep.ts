// K-sweep step for board-mad. Given a BucketSeries of market observations per
// game, apply the selected causal signal timing mode plus K·MAD threshold per K
// value. K is the only Sensitivity dial knob (US-037) so this is the sub-second
// half of the detector: precompute each observation's baseline (median+MAD over
// the selected prior sample) and {bucketStart, bucketEnd} Dates once — depends
// on signal timing, not K — then per K just iterate and compare
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
  readonly gameElapsedSeconds?: number | null;
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
  // Build the per-game timing slice once; baseline expects it on the
  // BoardMadBaselineTiming object (audit-fix #2, phase A2). historicalPrior
  // remains separate. Both are per-game facts merged into the params object
  // the baseline consumes.
  const perGameParams = {
    ...params,
    ...(game.historicalPrior === undefined ? {} : { historicalPrior: game.historicalPrior }),
    ...(game.timingContext === undefined ? {} : { timingContext: game.timingContext }),
  };
  return entries.map((e, i): Baseline => {
    const bucketStart = new Date(e.bucket * 1000);
    const bucketEnd = new Date((e.bucket + bucketSeconds) * 1000);
    const baseline = resolveBoardMadBaseline(entries, i, perGameParams);
    return {
      gameId: game.gameId,
      bucketStart,
      bucketEnd,
      intensity: e.intensity,
      ...(e.gameElapsedSeconds == null ? {} : { gameElapsedSeconds: e.gameElapsedSeconds }),
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
        ...(b.gameElapsedSeconds == null ? {} : { gameElapsedSeconds: b.gameElapsedSeconds }),
        baselineMedian: 0,
        baselineMad: 0,
        warmedUp: false,
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
      ...(b.gameElapsedSeconds == null ? {} : { gameElapsedSeconds: b.gameElapsedSeconds }),
      baselineMedian: b.median,
      baselineMad: b.mad,
      warmedUp: true,
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
