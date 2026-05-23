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
    expect(elapsed).toBeLessThan(200);
  });
});
