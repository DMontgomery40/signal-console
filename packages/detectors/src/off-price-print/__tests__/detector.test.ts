import { describe, expect, it } from "vitest";

import type { DetectorWindow, MicrostructureEvent } from "../../types";
import { detector, Params } from "../index";

const defaults = (): ReturnType<typeof Params.parse> => Params.parse({});

const windowOf = (
  gameIds: readonly string[],
  events: readonly MicrostructureEvent[],
): DetectorWindow => ({
  gameIds,
  start: new Date(0),
  end: new Date(60 * 60 * 1000),
  microstructureEvents: events,
});

const ev = (overrides: Partial<MicrostructureEvent> = {}): MicrostructureEvent => ({
  gameId: "synth-1",
  sourceMarketId: "polymarket-m1",
  eventTimestamp: new Date(60_000),
  source: "polymarket",
  volumeShare: 0.5,
  offPriceDistance: 0.5,
  ...overrides,
});

describe("off-price-print detector", () => {
  it("identity matches PRD §10", () => {
    expect(detector.id).toBe("off-price-print");
    expect(detector.version).toBe("1.0.0");
    expect(detector.displayName).toContain("Polymarket only");
  });

  it("default Params resolves to {0.10, 0.40}", () => {
    const p = defaults();
    expect(p.minVolumeShare).toBe(0.1);
    expect(p.minOffPriceDistance).toBe(0.4);
  });

  it("returns empty fires on empty events (US-027 AC)", () => {
    const result = detector.run(windowOf([], []), defaults());
    expect(result.fires).toEqual([]);
    expect(result.stats.firesPerGame).toBe(0);
    expect(result.stats.totalFires).toBe(0);
    expect(result.stats.gamesInWindow).toBe(0);
    expect(result.buckets).toEqual([]);
  });

  it("returns empty fires when window has games but no events", () => {
    const result = detector.run(windowOf(["synth-1"], []), defaults());
    expect(result.fires).toEqual([]);
    expect(result.stats.gamesInWindow).toBe(1);
    expect(result.stats.firesPerGame).toBe(0);
  });

  it("fires only on events that pass BOTH thresholds", () => {
    const events: readonly MicrostructureEvent[] = [
      ev({ volumeShare: 0.05, offPriceDistance: 0.5 }), // fails volume threshold
      ev({ volumeShare: 0.5, offPriceDistance: 0.3 }), // fails distance threshold
      ev({ volumeShare: 0.5, offPriceDistance: 0.5 }), // passes both
      ev({ volumeShare: 0.1, offPriceDistance: 0.4 }), // boundary — both >=
    ];
    const result = detector.run(windowOf(["synth-1"], events), defaults());
    expect(result.fires).toHaveLength(2);
    expect(result.stats.totalFires).toBe(2);
    expect(result.stats.gamesInWindow).toBe(1);
    expect(result.stats.firesPerGame).toBe(2);
  });

  it("filters events to gameIds in the window", () => {
    const events: readonly MicrostructureEvent[] = [
      ev({ gameId: "synth-1" }),
      ev({ gameId: "other-game" }),
    ];
    const result = detector.run(windowOf(["synth-1"], events), defaults());
    expect(result.fires).toHaveLength(1);
    const fire = result.fires[0];
    expect(fire?.gameId).toBe("synth-1");
  });

  it("treats duplicate gameIds as one game for stats", () => {
    const result = detector.run(windowOf(["synth-1", "synth-1"], [ev()]), defaults());

    expect(result.fires).toHaveLength(1);
    expect(result.stats.gamesInWindow).toBe(1);
    expect(result.stats.firesPerGame).toBe(1);
  });

  it("fire intensity equals event off_price_distance; baseline fields are 0", () => {
    const event = ev({ offPriceDistance: 0.73 });
    const result = detector.run(windowOf(["synth-1"], [event]), defaults());
    const fire = result.fires[0];
    expect(fire).toBeDefined();
    expect(fire?.intensity).toBe(0.73);
    expect(fire?.baselineMedian).toBe(0);
    expect(fire?.baselineMad).toBe(0);
    expect(fire?.bucketStart.getTime()).toBe(event.eventTimestamp.getTime());
    expect(fire?.bucketEnd.getTime()).toBe(event.eventTimestamp.getTime());
  });

  it("custom thresholds tighten the qualifying set", () => {
    const events: readonly MicrostructureEvent[] = [
      ev({ volumeShare: 0.5, offPriceDistance: 0.5 }),
      ev({ volumeShare: 0.5, offPriceDistance: 0.7 }),
    ];
    const result = detector.run(
      windowOf(["synth-1"], events),
      Params.parse({ minVolumeShare: 0.2, minOffPriceDistance: 0.6 }),
    );
    expect(result.fires).toHaveLength(1);
    const fire = result.fires[0];
    expect(fire?.intensity).toBe(0.7);
  });
});
