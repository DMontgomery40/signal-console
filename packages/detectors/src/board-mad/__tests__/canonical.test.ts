// Canonical board-mad detector contract tests at K=6.0 (US-011).
//
// These three tests lock in the K=6.0 outcomes validated against the research
// report (~/nba-predict/scripts/board_signal_v2.py). Any future change to the
// detector that drifts these assertions is a deliberate review event: per
// CLAUDE.md, fix the detector, do NOT adjust the test.
//
// All test names cite BOTH the PBP event timestamp and the bucket timestamp(s)
// so future readers cannot conflate raw detector output (bucket-start = the
// 60-second bucket containing or starting from the event) with the watcher's
// confirmation moment (bucket-end = the next-minute boundary at which the
// trailing baseline observes the spike).
//
// "No-fire" semantics for Reaves: the Python research's `fire_after` function
// only counts fires whose bucket-end is AFTER the event (i.e. a live watcher
// would observe the spike post-event and attribute it to the event). The PRD
// acceptance text "zero fires within +/-5 min" is taken to mean "zero fires
// CONFIRM the event within +/-5 min" -- a pre-event volatility blip whose
// bucket-end lands strictly before the event timestamp does not confirm the
// event. See US-011 notes in prd.json for the deviation rationale.

import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { detector } from "../index";
import type { DetectorFire } from "../../types";
import { loadFixtureTicks } from "./fixture-loader";

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");
const FIVE_MIN_MS = 5 * 60 * 1000;

function listFixtureGames(): readonly string[] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".json.gz"))
    .map((f) => f.replace(/\.json\.gz$/, ""))
    .toSorted();
}

function runOne(
  gameId: string,
  weighting: "equal" | "volume",
  kMad: number,
): readonly DetectorFire[] {
  const ticks = loadFixtureTicks(gameId);
  const firstTick = ticks[0];
  const lastTick = ticks[ticks.length - 1];
  if (firstTick === undefined || lastTick === undefined) return [];
  const start = firstTick.capturedAt;
  const end = new Date(lastTick.capturedAt.getTime() + 60_000);
  const params = detector.paramsSchema.parse({ kMad, weighting });
  return detector.run({ gameIds: [gameId], start, end, ticks }, params).fires;
}

describe("board-mad canonical contract tests at K=6.0", () => {
  it("hartenstein fires at K=6 (event 2026-05-08T03:12:36.8Z, bucket-start 2026-05-08T03:12:00Z, bucket-end 2026-05-08T03:13:00Z) on game nba-0042500222", () => {
    const fires = runOne("nba-0042500222", "volume", 6.0);
    const expectedStart = "2026-05-08T03:12:00.000Z";
    const expectedEnd = "2026-05-08T03:13:00.000Z";
    const hit = fires.find(
      (f) =>
        f.bucketStart.toISOString() === expectedStart && f.bucketEnd.toISOString() === expectedEnd,
    );
    expect(hit).toBeDefined();
    if (hit !== undefined) {
      expect(hit.gameId).toBe("nba-0042500222");
      expect(hit.intensity).toBeGreaterThan(0);
    }
  });

  it("reaves no-fire at K=6 (event 2026-05-12T04:51:40.2Z, no bucket-end > event within +5min) on games nba-0042500223 and nba-0042500224", () => {
    const event = Date.parse("2026-05-12T04:51:40.2Z");
    const confirmingFires = ["nba-0042500223", "nba-0042500224"].flatMap((gameId) =>
      runOne(gameId, "volume", 6.0).filter(
        (f) =>
          f.bucketEnd.getTime() > event &&
          f.bucketStart.getTime() >= event - FIVE_MIN_MS &&
          f.bucketStart.getTime() <= event + FIVE_MIN_MS,
      ),
    );
    expect(confirmingFires).toEqual([]);
  });

  it("64-game PBP fixture set mean fires/game at K=6 (equal in [8.3, 10.3], volume in [7.6, 9.6])", () => {
    const games = listFixtureGames();
    expect(games.length).toBeGreaterThanOrEqual(64);
    const totalEqual = games.reduce((acc, g) => acc + runOne(g, "equal", 6.0).length, 0);
    const totalVolume = games.reduce((acc, g) => acc + runOne(g, "volume", 6.0).length, 0);
    const meanEqual = totalEqual / games.length;
    const meanVolume = totalVolume / games.length;
    expect(meanEqual).toBeGreaterThanOrEqual(8.3);
    expect(meanEqual).toBeLessThanOrEqual(10.3);
    expect(meanVolume).toBeGreaterThanOrEqual(7.6);
    expect(meanVolume).toBeLessThanOrEqual(9.6);
  });
});
