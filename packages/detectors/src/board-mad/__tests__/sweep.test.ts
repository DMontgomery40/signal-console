import { describe, expect, it } from "vitest";

import {
  BOARD_MAD_BASELINE_MODE_DEFAULT,
  BOARD_MAD_BASELINE_MODE_HISTORICAL_BLEND,
  BOARD_MAD_BASELINE_MODE_OPENING_RAMP,
  BOARD_MAD_BASELINE_MODE_TRAILING,
  BOARD_MAD_BUCKET_SECONDS_DEFAULT,
  BOARD_MAD_FRESH_CAP_SECONDS_DEFAULT,
  BOARD_MAD_HISTORICAL_AWAY_WEIGHT_DEFAULT,
  BOARD_MAD_HISTORICAL_LAST_GAMES_DEFAULT,
  BOARD_MAD_HISTORICAL_PRIOR_WEIGHT_DEFAULT,
  BOARD_MAD_HISTORICAL_RAMP_COMPLETE_GAME_MINUTES_DEFAULT,
  BOARD_MAD_OPENING_BASELINE_BUCKETS_DEFAULT,
  BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_DEFAULT,
  BOARD_MAD_RECENT_WALL_MINUTES_DEFAULT,
  BOARD_MAD_RECENT_WALL_WEIGHT_DEFAULT,
  BOARD_MAD_TRAILING_BUCKETS_DEFAULT,
  BOARD_MAD_TRAILING_GAME_MINUTES_DEFAULT,
  BOARD_MAD_WARMUP_BUCKETS_DEFAULT,
} from "../config";
import type { BucketSeries } from "../prebucket";
import { runForK, runSweep, type SweepParams } from "../sweep";

const DEFAULT_PARAMS: SweepParams = {
  baselineMode: BOARD_MAD_BASELINE_MODE_DEFAULT,
  bucketSeconds: BOARD_MAD_BUCKET_SECONDS_DEFAULT,
  freshCapSeconds: BOARD_MAD_FRESH_CAP_SECONDS_DEFAULT,
  openingBaselineBuckets: BOARD_MAD_OPENING_BASELINE_BUCKETS_DEFAULT,
  openingRampCompleteBuckets: BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_DEFAULT,
  historicalAwayWeight: BOARD_MAD_HISTORICAL_AWAY_WEIGHT_DEFAULT,
  historicalLastGames: BOARD_MAD_HISTORICAL_LAST_GAMES_DEFAULT,
  historicalPriorWeight: BOARD_MAD_HISTORICAL_PRIOR_WEIGHT_DEFAULT,
  historicalRampCompleteGameMinutes: BOARD_MAD_HISTORICAL_RAMP_COMPLETE_GAME_MINUTES_DEFAULT,
  trailingGameMinutes: BOARD_MAD_TRAILING_GAME_MINUTES_DEFAULT,
  recentWallMinutes: BOARD_MAD_RECENT_WALL_MINUTES_DEFAULT,
  recentWallWeight: BOARD_MAD_RECENT_WALL_WEIGHT_DEFAULT,
  trailingBuckets: BOARD_MAD_TRAILING_BUCKETS_DEFAULT,
  warmupBuckets: BOARD_MAD_WARMUP_BUCKETS_DEFAULT,
  weighting: "volume",
};

// Build a synthetic single-game BucketSeries with `n` buckets at 60s spacing.
// The intensity profile is a calm baseline near 0.05 with periodic spikes of
// magnitude 2.0..6.0 every 13 buckets. The spike heights are large enough that
// at K=3 most spikes fire; at K=6 fewer do; at K=12 essentially none should.
const buildSeries = (
  n: number,
  bucketSeconds = BOARD_MAD_BUCKET_SECONDS_DEFAULT,
): BucketSeries => ({
  bucketSeconds,
  weighting: "volume",
  freshCapSeconds: BOARD_MAD_FRESH_CAP_SECONDS_DEFAULT,
  perGame: [
    {
      gameId: "synth",
      buckets: Array.from({ length: n }, (_, i) => ({
        bucket: i * bucketSeconds,
        intensity: i % 13 === 0 ? 2.0 + ((i * 37) % 5) : 0.05 + ((i * 11) % 7) * 0.005,
      })),
    },
  ],
});

describe("runSweep", () => {
  it("returns one entry per K value in the order supplied", () => {
    const series = buildSeries(500);
    const results = runSweep(series, [3.0, 4.0, 5.0, 6.0], DEFAULT_PARAMS);
    expect(results.length).toBe(4);
    expect(results.map((r) => r.k)).toEqual([3.0, 4.0, 5.0, 6.0]);
  });

  it("over [3, 4, 5, 6] returns monotonically non-increasing fire counts", () => {
    const series = buildSeries(500);
    const results = runSweep(series, [3.0, 4.0, 5.0, 6.0], DEFAULT_PARAMS);
    const counts = results.map((r) => r.fires.length);
    // Higher K = stricter threshold = at most as many fires as a lower K.
    counts.slice(1).forEach((c, i) => {
      const prev = counts[i];
      expect(prev).toBeDefined();
      if (prev !== undefined) expect(c).toBeLessThanOrEqual(prev);
    });
    // Sanity: at K=3 some fires exist; at K=12 essentially none.
    expect(counts[0]).toBeGreaterThan(0);
    const extreme = runSweep(series, [12.0], DEFAULT_PARAMS);
    expect(extreme[0]?.fires.length ?? 0).toBeLessThanOrEqual(counts[counts.length - 1] ?? 0);
  });

  it("matches runForK fires on a single-K sweep (cross-check with the public detector path)", async () => {
    // Importing the detector here keeps prebucket/sweep coverage independent of
    // the public detector test in canonical.test.ts; we still want to assert
    // that a single-element sweep returns the same fires runForK would produce.
    const { runForK } = await import("../sweep");
    const series = buildSeries(200);
    const sweepFires = runSweep(series, [3.0], DEFAULT_PARAMS)[0]?.fires ?? [];
    const oneKFires = runForK(series, 3.0, DEFAULT_PARAMS).fires;
    expect(sweepFires.length).toBe(oneKFires.length);
    expect(sweepFires.map((f) => f.bucketStart.toISOString())).toEqual(
      oneKFires.map((f) => f.bucketStart.toISOString()),
    );
  });

  // US-042 AC #10: runSweep over (kMad, warmupBuckets) pairs must respond to
  // warmupBuckets — specifically a lower warmup gate must produce >= fires
  // than a higher one on the same bucket series, and on a series with spikes
  // inside the [low_warmup, high_warmup) activation-gap window the counts
  // must strictly differ. An active bucket can only ADD to the fire count
  // (never remove from it), so monotonicity holds globally; the strictly-
  // greater leg proves warmupBuckets is a real sweep axis, not silently
  // ignored when only kMad varies.
  it("warmupBuckets=2 produces > fires than warmupBuckets=8 when spikes land in the warmup gap", () => {
    // Single-game series of 40 buckets. Calm baseline near 0.05, with spikes
    // of magnitude 1.0 at indices 3, 5, 7 — all inside the [2, 8) window where
    // a warmup=2 detector treats them as active but a warmup=8 detector
    // suppresses them. A further spike at index 25 fires under both warmups
    // (so neither count is zero, which would make >= trivially true).
    const spikeIndices = new Set([3, 5, 7, 25]);
    const targetedSeries: BucketSeries = {
      bucketSeconds: BOARD_MAD_BUCKET_SECONDS_DEFAULT,
      weighting: "volume",
      freshCapSeconds: BOARD_MAD_FRESH_CAP_SECONDS_DEFAULT,
      perGame: [
        {
          gameId: "synth-warmup",
          buckets: Array.from({ length: 40 }, (_, i) => ({
            bucket: i * BOARD_MAD_BUCKET_SECONDS_DEFAULT,
            intensity: spikeIndices.has(i) ? 1.0 : 0.05,
          })),
        },
      ],
    };
    const lowWarmup = runSweep(targetedSeries, [3.0], { ...DEFAULT_PARAMS, warmupBuckets: 2 });
    const highWarmup = runSweep(targetedSeries, [3.0], { ...DEFAULT_PARAMS, warmupBuckets: 8 });
    const lowCount = lowWarmup[0]?.fires.length ?? 0;
    const highCount = highWarmup[0]?.fires.length ?? 0;
    // Lower warmup must produce at least as many fires (global monotonicity).
    expect(lowCount).toBeGreaterThanOrEqual(highCount);
    // On this targeted series the two counts must strictly differ — proves
    // warmupBuckets is a real sweep axis the runSweep code reads.
    expect(lowCount).toBeGreaterThan(highCount);
  });

  it("warmup gate uses elapsed time from tip-off, not market observation count", () => {
    const sparseEightMinuteSeries: BucketSeries = {
      bucketSeconds: BOARD_MAD_BUCKET_SECONDS_DEFAULT,
      weighting: "volume",
      freshCapSeconds: BOARD_MAD_FRESH_CAP_SECONDS_DEFAULT,
      perGame: [
        {
          gameId: "synth-sparse-warmup",
          buckets: [
            { bucket: 0, intensity: 1 },
            { bucket: 4 * 60, intensity: 1 },
            { bucket: 8 * 60, intensity: 10 },
          ],
        },
      ],
    };

    const result = runForK(sparseEightMinuteSeries, 1.0, {
      ...DEFAULT_PARAMS,
      warmupBuckets: 8,
    });

    expect(result.buckets.map((bucket) => bucket.warmedUp)).toEqual([false, false, true]);
    expect(result.fires.map((fire) => fire.bucketStart.toISOString())).toEqual([
      "1970-01-01T00:08:00.000Z",
    ]);
  });

  it("trailing memory uses elapsed game time, not market observation count", () => {
    const sparseLongGameSeries: BucketSeries = {
      bucketSeconds: BOARD_MAD_BUCKET_SECONDS_DEFAULT,
      weighting: "volume",
      freshCapSeconds: BOARD_MAD_FRESH_CAP_SECONDS_DEFAULT,
      perGame: [
        {
          gameId: "synth-sparse-memory",
          buckets: [
            { bucket: 0, gameElapsedSeconds: 0, intensity: 10 },
            { bucket: 4 * 60, gameElapsedSeconds: 4 * 60, intensity: 11 },
            { bucket: 8 * 60, gameElapsedSeconds: 8 * 60, intensity: 12 },
            { bucket: 32 * 60, gameElapsedSeconds: 32 * 60, intensity: 1 },
            { bucket: 36 * 60, gameElapsedSeconds: 36 * 60, intensity: 2 },
          ],
        },
      ],
    };

    const result = runForK(sparseLongGameSeries, 3.0, {
      ...DEFAULT_PARAMS,
      baselineMode: BOARD_MAD_BASELINE_MODE_TRAILING,
      trailingBuckets: 20,
      warmupBuckets: 8,
    });
    const lateBucket = result.buckets.at(-1);

    expect(lateBucket?.bucketStart.toISOString()).toBe("1970-01-01T00:36:00.000Z");
    expect(lateBucket?.baselineMedian).toBe(1);
    expect(lateBucket?.baselineMad).toBe(1e-9);
    expect(lateBucket?.fired).toBe(true);
  });

  it("opening-ramp baseline can judge the first active alert check against the opening sample", () => {
    const openingRampSeries: BucketSeries = {
      bucketSeconds: BOARD_MAD_BUCKET_SECONDS_DEFAULT,
      weighting: "volume",
      freshCapSeconds: BOARD_MAD_FRESH_CAP_SECONDS_DEFAULT,
      perGame: [
        {
          gameId: "synth-opening-ramp",
          buckets: [1, 1, 1, 1, 100, 100, 100, 100, 2].map((intensity, i) => ({
            bucket: i * BOARD_MAD_BUCKET_SECONDS_DEFAULT,
            intensity,
          })),
        },
      ],
    };
    const trailing = runSweep(openingRampSeries, [1.0], {
      ...DEFAULT_PARAMS,
      baselineMode: BOARD_MAD_BASELINE_MODE_TRAILING,
    });
    const openingRamp = runSweep(openingRampSeries, [1.0], {
      ...DEFAULT_PARAMS,
      baselineMode: BOARD_MAD_BASELINE_MODE_OPENING_RAMP,
      openingBaselineBuckets: BOARD_MAD_OPENING_BASELINE_BUCKETS_DEFAULT,
      openingRampCompleteBuckets: BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_DEFAULT,
    });

    expect(trailing[0]?.fires.length ?? 0).toBe(0);
    expect(openingRamp[0]?.fires.map((fire) => fire.bucketStart.toISOString())).toEqual([
      "1970-01-01T00:08:00.000Z",
    ]);
  });

  it("historical-blend starts from same-side priors then fades by game clock", () => {
    const series: BucketSeries = {
      bucketSeconds: 30,
      weighting: "volume",
      freshCapSeconds: BOARD_MAD_FRESH_CAP_SECONDS_DEFAULT,
      perGame: [
        {
          gameId: "synth-historical",
          historicalPrior: { median: 10, mad: 2, sampleSize: 20 },
          buckets: Array.from({ length: 28 }, (_, i) => ({
            bucket: i * 30,
            gameElapsedSeconds: i === 27 ? 12 * 60 : i * 30,
            intensity: i === 0 ? 1 : 5,
          })),
        },
      ],
    };
    const result = runForK(series, 3.0, {
      ...DEFAULT_PARAMS,
      baselineMode: BOARD_MAD_BASELINE_MODE_HISTORICAL_BLEND,
      bucketSeconds: 30,
      historicalPriorWeight: 1,
      historicalRampCompleteGameMinutes: 12,
      recentWallMinutes: 0,
      trailingGameMinutes: 12,
      warmupBuckets: 1,
    });

    const firstEligible = result.buckets[1];
    const rampedOut = result.buckets[27];
    expect(firstEligible?.baselineMedian).toBeGreaterThan(9);
    expect(firstEligible?.baselineMad).toBeGreaterThan(1);
    expect(rampedOut?.baselineMedian).toBeLessThan(6);
  });

  it("over 100 K-values on a 28-day-equivalent bucket series scales from a shared baseline pass", () => {
    // 28 days × 24 h × 60 min = 40320 one-minute buckets — the conservative
    // upper bound on a single-game bucket count for the Sensitivity dial. This
    // is the AC's "sub-second dial response" proxy. Avoid a brittle absolute
    // wall-clock assertion: loaded CI can make a good O(B + K*B) implementation
    // look slow. Instead compare one K against 100 K; recomputing baselines per
    // K would push the ratio toward 100x, while the intended shared-baseline
    // path stays far below that.
    const series = buildSeries(40320);
    const kValues = Array.from({ length: 100 }, (_, i) => 1.0 + i * 0.1);
    const oneStart = performance.now();
    const single = runSweep(series, [3.0], DEFAULT_PARAMS);
    const oneElapsed = performance.now() - oneStart;

    const manyStart = performance.now();
    const results = runSweep(series, kValues, DEFAULT_PARAMS);
    const manyElapsed = performance.now() - manyStart;

    expect(single.length).toBe(1);
    expect(results.length).toBe(100);
    expect(manyElapsed / Math.max(oneElapsed, 1)).toBeLessThan(35);
  });
});
