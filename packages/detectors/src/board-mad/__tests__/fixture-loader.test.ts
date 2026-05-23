// Smoke test for the canonical-fixture loader (US-010). Confirms the three
// PBP-anchored fixtures exist, are gunzipped transparently, and decode into
// valid Tick rows. US-011 builds detector contract assertions on top of this.

import { describe, expect, it } from "vitest";

import { loadFixturePayload, loadFixtureTicks } from "./fixture-loader";

const ANCHOR_GAMES = ["nba-0042500222", "nba-0042500223", "nba-0042500224"] as const;

describe("fixture-loader", () => {
  for (const gameId of ANCHOR_GAMES) {
    it(`loads gzipped fixture for ${gameId}`, () => {
      const ticks = loadFixtureTicks(gameId);
      expect(ticks.length).toBeGreaterThan(0);
      const first = ticks[0];
      expect(first).toBeDefined();
      if (first === undefined) return;
      expect(first.gameId).toBe(gameId);
      expect(typeof first.sourceMarketId).toBe("string");
      expect(first.capturedAt).toBeInstanceOf(Date);
      expect(Number.isFinite(first.capturedAt.getTime())).toBe(true);
      expect(typeof first.volume).toBe("number");
      expect(typeof first.isHeartbeat).toBe("boolean");
    });

    it(`fixture window for ${gameId} brackets all ticks`, () => {
      // The fixture window endpoints are documentation, not a strict invariant:
      // extract-fixtures.ts uses lexicographic SQL comparisons on ISO strings,
      // which include sub-millisecond ticks at the closing second (e.g. a
      // captured_at of '...T04:00:00.000Z' is less than '...T04:00:00Z' as
      // strings). Numerically those resolve to the same ms, so we allow the
      // upper bound to be inclusive.
      const payload = loadFixturePayload(gameId);
      const startMs = new Date(payload.window.start).getTime();
      const endMs = new Date(payload.window.end).getTime();
      const ticks = loadFixtureTicks(gameId);
      for (const t of ticks) {
        const ms = t.capturedAt.getTime();
        expect(ms).toBeGreaterThanOrEqual(startMs);
        expect(ms).toBeLessThanOrEqual(endMs);
      }
    });
  }
});
