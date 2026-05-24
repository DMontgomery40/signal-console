import { describe, expect, it } from "vitest";

import type { Tick } from "../../types";
import { prebucket } from "../prebucket";

const tick = (
  gameId: string,
  marketId: string,
  unixSec: number,
  ip: number | null,
  volume = 10,
  isHeartbeat = false,
): Tick => ({
  gameId,
  sourceMarketId: marketId,
  capturedAt: new Date(unixSec * 1000),
  impliedProbability: ip,
  volume,
  isHeartbeat,
});

describe("prebucket", () => {
  it("returns an empty BucketSeries when given no ticks", () => {
    const series = prebucket([], 60);
    expect(series.bucketSeconds).toBe(60);
    expect(series.weighting).toBe("volume");
    expect(series.freshCapSeconds).toBe(300);
    expect(series.perGame).toEqual([]);
  });

  it("groups by gameId and emits per-bucket summed weighted deltas", () => {
    // Two ticks per game in the same market 60s apart. With volume weighting
    // (default), each pair contributes log1p(volume) * |delta|. IPs avoid the
    // 0.500 opening-anchor (sanitisation drops those).
    const t = [
      tick("g1", "m1", 60, 0.4),
      tick("g1", "m1", 120, 0.6),
      tick("g2", "m1", 60, 0.4),
      tick("g2", "m1", 120, 0.45),
    ];
    const series = prebucket(t, 60);
    expect(series.perGame.length).toBe(2);
    const g1 = series.perGame.find((g) => g.gameId === "g1");
    const g2 = series.perGame.find((g) => g.gameId === "g2");
    expect(g1).toBeDefined();
    expect(g2).toBeDefined();
    if (g1 === undefined || g2 === undefined) return;
    // Each game has 1 contribution at bucket-start 120.
    expect(g1.buckets.length).toBe(1);
    expect(g1.buckets[0]?.bucket).toBe(120);
    expect(g1.buckets[0]?.intensity).toBeCloseTo(0.2 * Math.log1p(10), 9);
    expect(g2.buckets.length).toBe(1);
    expect(g2.buckets[0]?.intensity).toBeCloseTo(0.05 * Math.log1p(10), 9);
  });

  it("respects equal weighting (no log1p volume factor)", () => {
    const t = [tick("g1", "m1", 60, 0.4), tick("g1", "m1", 120, 0.6)];
    const series = prebucket(t, 60, { weighting: "equal" });
    expect(series.weighting).toBe("equal");
    expect(series.perGame[0]?.buckets[0]?.intensity).toBeCloseTo(0.2, 9);
  });

  it("drops pairs whose per-market gap exceeds freshCapSeconds", () => {
    const t = [tick("g1", "m1", 0, 0.4), tick("g1", "m1", 3600, 0.9)];
    const series = prebucket(t, 60);
    expect(series.perGame[0]?.buckets).toEqual([]);
  });

  it("sanitises is_heartbeat and 0.500 anchor ticks", () => {
    const t = [
      tick("g1", "m1", 60, 0.4, 10, true),
      tick("g1", "m1", 120, 0.5),
      tick("g1", "m1", 180, 0.5),
      tick("g1", "m1", 240, 0.9, 10, true),
    ];
    const series = prebucket(t, 60);
    expect(series.perGame[0]?.buckets).toEqual([]);
  });

  it("retains gameIds when explicitly listed even with zero contributing ticks", () => {
    const series = prebucket([], 60, { gameIds: ["g1", "g2"] });
    expect(series.perGame.length).toBe(2);
    expect(series.perGame.map((g) => g.gameId).toSorted()).toEqual(["g1", "g2"]);
    expect(series.perGame.every((g) => g.buckets.length === 0)).toBe(true);
  });
});
