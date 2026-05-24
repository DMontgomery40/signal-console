// Ensemble-OR contract tests. The detector is a thin union of board-mad and
// off-price-print — we verify the lane tagging, dedup, and stats math.
// Full numerical equivalence to the report's BAKEOFF lead times is exercised
// at the integration level by apps/api/tests/backtest.test.ts and the
// production six-incident HTTP backtest.

import { describe, expect, it } from "vitest";

import { detector as boardMad } from "../../board-mad";
import { detector as offPricePrint } from "../../off-price-print";
import { detector as ensembleOr, Params } from "../index";
import type { DetectorWindow, MicrostructureEvent, Tick } from "../../types";

const baseTime = new Date("2026-05-08T03:00:00.000Z");

function ticksWithJump(): readonly Tick[] {
  // Two markets on the same game; baseline 0.40/0.60 with small noise so the
  // trailing baseline is non-zero, then a coordinated outsized jump at minute
  // 30 that beats median+K*MAD on the prior 20 buckets.
  // Note: board-mad strips 0.500 opening-anchor ticks, so we deliberately
  // pick 0.40/0.60 as the baselines.
  const market = (mid: string, basePrice: number, jumpAt: number, jumpTo: number) => {
    return Array.from({ length: 60 }, (_, i): Tick => {
      // small +/- 0.005 noise so the baseline isn't degenerate-zero
      const noise = i % 2 === 0 ? 0.005 : -0.005;
      const price = i < jumpAt ? basePrice + noise : jumpTo;
      return {
        gameId: "nba-test-1",
        sourceMarketId: mid,
        capturedAt: new Date(baseTime.getTime() + i * 60_000),
        impliedProbability: price,
        volume: 1000,
        isHeartbeat: false,
      };
    });
  };
  return [...market("mkt-a", 0.4, 30, 0.95), ...market("mkt-b", 0.6, 30, 0.05)];
}

function offPriceEvent(): MicrostructureEvent {
  // Trade ~10 minutes into the window: 0.99 vs sampled 0.50 → distance 0.49,
  // volume share 0.30 → both thresholds exceeded.
  return {
    gameId: "nba-test-1",
    sourceMarketId: "mkt-a",
    eventTimestamp: new Date(baseTime.getTime() + 10 * 60_000),
    source: "polymarket",
    volumeShare: 0.3,
    offPriceDistance: 0.49,
  };
}

function buildWindow(): DetectorWindow {
  return {
    gameIds: ["nba-test-1"],
    start: baseTime,
    end: new Date(baseTime.getTime() + 60 * 60_000),
    ticks: ticksWithJump(),
    microstructureEvents: [offPriceEvent()],
  };
}

describe("ensemble-or detector", () => {
  it("unions board-mad and off-price-print fires", () => {
    const window = buildWindow();
    const result = ensembleOr.run(window, Params.parse({}));
    const lanes = new Set(result.fires.map((f) => f.lane));
    expect(lanes.has("board")).toBe(true);
    expect(lanes.has("offprice")).toBe(true);
  });

  it("tags board fires lane='board' and off-price fires lane='offprice'", () => {
    const window = buildWindow();
    const result = ensembleOr.run(window, Params.parse({}));
    for (const fire of result.fires) {
      expect(fire.lane === "board" || fire.lane === "offprice").toBe(true);
    }
  });

  it("totalFires equals the sum of the two lanes' fires (no double-count)", () => {
    const window = buildWindow();
    const boardOnly = boardMad.run(
      window,
      boardMad.paramsSchema.parse({
        bucketSeconds: 60,
        kMad: 3,
        weighting: "volume",
        trailingBuckets: 20,
        warmupBuckets: 8,
        freshCapSeconds: 300,
      }),
    );
    const offOnly = offPricePrint.run(window, {
      minVolumeShare: 0.1,
      minOffPriceDistance: 0.4,
    });
    const ensemble = ensembleOr.run(window, Params.parse({}));
    expect(ensemble.stats.totalFires).toBe(boardOnly.fires.length + offOnly.fires.length);
  });

  it("keeps simultaneous off-price fires from distinct source markets", () => {
    const eventAt = new Date(baseTime.getTime() + 10 * 60_000);
    const microstructureEvents: readonly MicrostructureEvent[] = [
      {
        ...offPriceEvent(),
        eventTimestamp: eventAt,
        sourceMarketId: "mkt-a",
      },
      {
        ...offPriceEvent(),
        eventTimestamp: eventAt,
        sourceMarketId: "mkt-b",
      },
    ];
    const window: DetectorWindow = {
      gameIds: ["nba-test-1"],
      start: baseTime,
      end: new Date(baseTime.getTime() + 60 * 60_000),
      ticks: [],
      microstructureEvents,
    };

    const offOnly = offPricePrint.run(window, {
      minVolumeShare: 0.1,
      minOffPriceDistance: 0.4,
    });
    const ensemble = ensembleOr.run(window, Params.parse({}));
    const offpriceFires = ensemble.fires.filter((f) => f.lane === "offprice");

    expect(offOnly.fires).toHaveLength(2);
    expect(offpriceFires).toHaveLength(2);
    expect(ensemble.stats.totalFires).toBe(2);
  });

  it("emits buckets from the board lane (off-price has no per-bucket aggregate)", () => {
    const window = buildWindow();
    const ensemble = ensembleOr.run(window, Params.parse({}));
    expect(ensemble.buckets.length).toBeGreaterThan(0);
  });

  it("returns no fires when both lanes find nothing", () => {
    const window: DetectorWindow = {
      gameIds: ["nba-test-2"],
      start: baseTime,
      end: new Date(baseTime.getTime() + 60 * 60_000),
      ticks: [],
      microstructureEvents: [],
    };
    const ensemble = ensembleOr.run(window, Params.parse({}));
    expect(ensemble.stats.totalFires).toBe(0);
  });

  it("treats duplicate gameIds as one game for combined stats", () => {
    const window = { ...buildWindow(), gameIds: ["nba-test-1", "nba-test-1"] };
    const ensemble = ensembleOr.run(window, Params.parse({}));

    expect(ensemble.stats.gamesInWindow).toBe(1);
    expect(ensemble.stats.firesPerGame).toBe(ensemble.stats.totalFires);
  });
});
