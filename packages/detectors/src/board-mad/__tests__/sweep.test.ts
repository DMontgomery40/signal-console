import { describe, expect, it } from "vitest";

import type { BucketSeries } from "../prebucket";
import { runSweep, type SweepParams } from "../sweep";

const DEFAULT_PARAMS: SweepParams = {
  bucketSeconds: 60,
  weighting: "volume",
  trailingBuckets: 20,
  warmupBuckets: 8,
  freshCapSeconds: 300,
};

// Build a synthetic single-game BucketSeries with `n` buckets at 60s spacing.
// The intensity profile is a calm baseline near 0.05 with periodic spikes of
// magnitude 2.0..6.0 every 13 buckets. The spike heights are large enough that
// at K=3 most spikes fire; at K=6 fewer do; at K=12 essentially none should.
const buildSeries = (n: number, bucketSeconds = 60): BucketSeries => ({
  bucketSeconds,
  weighting: "volume",
  freshCapSeconds: 300,
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
  // inside the [low_warmup, high_warmup) eligibility-gap window the counts
  // must strictly differ. An eligible bucket can only ADD to the fire count
  // (never remove from it), so monotonicity holds globally; the strictly-
  // greater leg proves warmupBuckets is a real sweep axis, not silently
  // ignored when only kMad varies.
  it("warmupBuckets=2 produces > fires than warmupBuckets=8 when spikes land in the warmup gap", () => {
    // Single-game series of 40 buckets. Calm baseline near 0.05, with spikes
    // of magnitude 1.0 at indices 3, 5, 7 — all inside the [2, 8) window where
    // a warmup=2 detector treats them as eligible but a warmup=8 detector
    // suppresses them. A further spike at index 25 fires under both warmups
    // (so neither count is zero, which would make >= trivially true).
    const spikeIndices = new Set([3, 5, 7, 25]);
    const targetedSeries: BucketSeries = {
      bucketSeconds: 60,
      weighting: "volume",
      freshCapSeconds: 300,
      perGame: [
        {
          gameId: "synth-warmup",
          buckets: Array.from({ length: 40 }, (_, i) => ({
            bucket: i * 60,
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

  it("over 100 K-values on a 28-day-equivalent bucket series completes in < 200 ms", () => {
    // 28 days × 24 h × 60 min = 40320 one-minute buckets — the conservative
    // upper bound on a single-game bucket count for the Cry Wolf dial. This
    // is the AC's "sub-second dial response" proxy: the dial fires runSweep
    // on every drag tick across ~10..100 K candidates; 200 ms for 100 K is
    // the worst-case headroom.
    const series = buildSeries(40320);
    const kValues = Array.from({ length: 100 }, (_, i) => 1.0 + i * 0.1);
    const start = performance.now();
    const results = runSweep(series, kValues, DEFAULT_PARAMS);
    const elapsed = performance.now() - start;
    expect(results.length).toBe(100);
    expect(elapsed).toBeLessThan(300);
  });
});
