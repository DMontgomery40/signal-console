import { describe, expect, it } from "vitest";

import type { DetectorWindow, Tick } from "../../types";
import {
  BOARD_MAD_BASELINE_MODE_DEFAULT,
  BOARD_MAD_BUCKET_SECONDS_DEFAULT,
  BOARD_MAD_FRESH_CAP_SECONDS_DEFAULT,
  BOARD_MAD_OPENING_BASELINE_BUCKETS_DEFAULT,
  BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_DEFAULT,
  BOARD_MAD_TRAILING_BUCKETS_DEFAULT,
  BOARD_MAD_WARMUP_BUCKETS_DEFAULT,
  BOARD_MAD_WEIGHTING_DEFAULT,
  K_MAD_LIVE,
} from "../config";
import { detector, Params } from "../index";

const defaults = (): ReturnType<typeof Params.parse> => Params.parse({});

const windowOf = (gameIds: readonly string[], ticks: readonly Tick[]): DetectorWindow => ({
  gameIds,
  start: new Date(0),
  end: new Date(60 * 60 * 1000),
  ticks,
});

describe("board-mad detector", () => {
  it("identity matches PRD §10", () => {
    expect(detector.id).toBe("board-mad");
    expect(detector.version).toBe("1.2.0");
    expect(detector.displayName).toBe("Board MAD (whole-board volatility)");
  });

  it("default Params resolves K to live default 3.0 and weighting='volume'", () => {
    const p = defaults();
    expect(p.kMad).toBe(K_MAD_LIVE);
    expect(p.weighting).toBe(BOARD_MAD_WEIGHTING_DEFAULT);
    expect(p.bucketSeconds).toBe(BOARD_MAD_BUCKET_SECONDS_DEFAULT);
    expect(p.trailingBuckets).toBe(BOARD_MAD_TRAILING_BUCKETS_DEFAULT);
    expect(p.warmupBuckets).toBe(BOARD_MAD_WARMUP_BUCKETS_DEFAULT);
    expect(p.baselineMode).toBe(BOARD_MAD_BASELINE_MODE_DEFAULT);
    expect(p.openingBaselineBuckets).toBe(BOARD_MAD_OPENING_BASELINE_BUCKETS_DEFAULT);
    expect(p.openingRampCompleteBuckets).toBe(BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_DEFAULT);
    expect(p.freshCapSeconds).toBe(BOARD_MAD_FRESH_CAP_SECONDS_DEFAULT);
  });

  it("returns empty fires and zero firesPerGame on empty ticks (US-009 AC)", () => {
    const result = detector.run(windowOf([], []), defaults());
    expect(result.fires).toEqual([]);
    expect(result.stats.firesPerGame).toBe(0);
    expect(result.stats.totalFires).toBe(0);
    expect(result.stats.gamesInWindow).toBe(0);
  });

  it("a single market with calm baseline then a large delta fires at the spike bucket", () => {
    // 13 ticks on one market spaced 60 s apart. Pairs 0..10 produce small deltas
    // (0.01) seeding the trailing baseline; pair 11 jumps to IP=0.99 producing
    // a much larger weighted delta in bucket 720 s. K=3 should fire that bucket.
    const baseTime = 30; // seconds; first tick is mid-bucket
    const tick = (i: number, ip: number): Tick => ({
      gameId: "synth-1",
      sourceMarketId: "m1",
      capturedAt: new Date((baseTime + i * 60) * 1000),
      impliedProbability: ip,
      volume: 10,
      isHeartbeat: false,
    });
    const ticks: readonly Tick[] = [
      tick(0, 0.4),
      tick(1, 0.41),
      tick(2, 0.4),
      tick(3, 0.41),
      tick(4, 0.4),
      tick(5, 0.41),
      tick(6, 0.4),
      tick(7, 0.41),
      tick(8, 0.4),
      tick(9, 0.41),
      tick(10, 0.4),
      tick(11, 0.41),
      tick(12, 0.99),
    ];
    const result = detector.run(windowOf(["synth-1"], ticks), defaults());
    expect(result.fires.length).toBeGreaterThanOrEqual(1);
    const spike = result.fires[0];
    expect(spike).toBeDefined();
    // Each pair contributes to the bucket containing the SECOND tick of the pair.
    // Last pair is tick 11 -> tick 12 (t = 30 + 12*60 = 750 s, bucket 720..780).
    expect(spike?.bucketStart.getTime()).toBe(720 * 1000);
    expect(spike?.bucketEnd.getTime()).toBe(780 * 1000);
    expect(spike?.gameId).toBe("synth-1");
    expect(spike?.intensity).toBeGreaterThan(spike?.baselineMedian ?? 0);
    expect(result.stats.gamesInWindow).toBe(1);
    expect(result.stats.totalFires).toBe(result.fires.length);
    expect(result.stats.firesPerGame).toBe(result.fires.length);
  });

  it("treats duplicate gameIds as one game for bucketing and stats", () => {
    const ticks: readonly Tick[] = [
      {
        gameId: "synth-dedupe",
        sourceMarketId: "m1",
        capturedAt: new Date(0),
        impliedProbability: 0.4,
        volume: 10,
        isHeartbeat: false,
      },
      {
        gameId: "synth-dedupe",
        sourceMarketId: "m1",
        capturedAt: new Date(60_000),
        impliedProbability: 0.42,
        volume: 10,
        isHeartbeat: false,
      },
    ];
    const unique = detector.run(windowOf(["synth-dedupe"], ticks), defaults());
    const duplicate = detector.run(windowOf(["synth-dedupe", "synth-dedupe"], ticks), defaults());

    expect(duplicate.buckets).toEqual(unique.buckets);
    expect(duplicate.fires).toEqual(unique.fires);
    expect(duplicate.stats.gamesInWindow).toBe(1);
    expect(duplicate.stats.firesPerGame).toBe(unique.stats.firesPerGame);
  });

  it("is_heartbeat and 0.500 opening-anchor ticks are sanitised", () => {
    // Two heartbeat ticks and two opening-anchor (IP=0.5) ticks. After
    // sanitisation, no qualifying pairs remain, so no fires.
    const ticks: readonly Tick[] = [
      {
        gameId: "synth-2",
        sourceMarketId: "m1",
        capturedAt: new Date(60_000),
        impliedProbability: 0.4,
        volume: 10,
        isHeartbeat: true,
      },
      {
        gameId: "synth-2",
        sourceMarketId: "m1",
        capturedAt: new Date(120_000),
        impliedProbability: 0.5,
        volume: 10,
        isHeartbeat: false,
      },
      {
        gameId: "synth-2",
        sourceMarketId: "m1",
        capturedAt: new Date(180_000),
        impliedProbability: 0.5,
        volume: 10,
        isHeartbeat: false,
      },
      {
        gameId: "synth-2",
        sourceMarketId: "m1",
        capturedAt: new Date(240_000),
        impliedProbability: 0.9,
        volume: 10,
        isHeartbeat: true,
      },
    ];
    const result = detector.run(windowOf(["synth-2"], ticks), defaults());
    expect(result.fires).toEqual([]);
  });

  it("freshCapSeconds drops pairs whose per-market gap exceeds the cap", () => {
    // Two ticks 1 hour apart with cap=300. The single pair must be dropped.
    const ticks: readonly Tick[] = [
      {
        gameId: "synth-3",
        sourceMarketId: "m1",
        capturedAt: new Date(0),
        impliedProbability: 0.4,
        volume: 10,
        isHeartbeat: false,
      },
      {
        gameId: "synth-3",
        sourceMarketId: "m1",
        capturedAt: new Date(3600_000),
        impliedProbability: 0.9,
        volume: 10,
        isHeartbeat: false,
      },
    ];
    const result = detector.run(windowOf(["synth-3"], ticks), defaults());
    expect(result.fires).toEqual([]);
  });
});
