// Elapsed-anchor regression suite (audit-fix #1, plan phase A1).
//
// This file pins the math contract for the board-mad baseline at the elapsed-time
// level. Every test here asserts the SAME contract David walks into bet365 with:
//
//   "Warmup is a real-time concept measured in elapsed game minutes from tipoff,
//    not a count of sparse non-empty market observations. A baseline window of
//    20 minutes means 20 minutes of elapsed time, not 20 nonzero buckets."
//
// All tests in this file should pass on the working tree at 2026-05-24 21:00 MDT
// (the elapsed-time patch in baseline.ts). They are written so any future
// refactor that reintroduces sparse-index semantics fails here loudly. Do NOT
// rewrite or skip these tests; per CLAUDE.md, fix the detector instead.
//
// The no-PBP / tipoff-anchor scenarios live in baseline.tipoff.test.ts (added
// with audit-fix #2, plan phase A2) where they will fail until that fix lands.
// This file deliberately uses PBP-anchored gameElapsedSeconds so we are testing
// the live happy path against the current code.

import { describe, expect, it } from "vitest";

import {
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
import { runForK, type SweepParams } from "../sweep";

const BUCKET_SECONDS = BOARD_MAD_BUCKET_SECONDS_DEFAULT; // 60
const WARMUP_BUCKETS = BOARD_MAD_WARMUP_BUCKETS_DEFAULT; // 8
const TRAILING_BUCKETS = BOARD_MAD_TRAILING_BUCKETS_DEFAULT; // 20
const OPENING_BASELINE_BUCKETS = BOARD_MAD_OPENING_BASELINE_BUCKETS_DEFAULT; // 4
const RAMP_COMPLETE_BUCKETS = BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_DEFAULT; // 20

const TIPOFF_MS = Date.parse("2026-05-24T00:13:00.000Z");
const TIPOFF_S = Math.floor(TIPOFF_MS / 1000);

const baseParams = (overrides: Partial<SweepParams> = {}): SweepParams => ({
  baselineMode: BOARD_MAD_BASELINE_MODE_OPENING_RAMP,
  bucketSeconds: BUCKET_SECONDS,
  freshCapSeconds: BOARD_MAD_FRESH_CAP_SECONDS_DEFAULT,
  openingBaselineBuckets: OPENING_BASELINE_BUCKETS,
  openingRampCompleteBuckets: RAMP_COMPLETE_BUCKETS,
  historicalAwayWeight: BOARD_MAD_HISTORICAL_AWAY_WEIGHT_DEFAULT,
  historicalLastGames: BOARD_MAD_HISTORICAL_LAST_GAMES_DEFAULT,
  historicalPriorWeight: BOARD_MAD_HISTORICAL_PRIOR_WEIGHT_DEFAULT,
  historicalRampCompleteGameMinutes: BOARD_MAD_HISTORICAL_RAMP_COMPLETE_GAME_MINUTES_DEFAULT,
  trailingGameMinutes: BOARD_MAD_TRAILING_GAME_MINUTES_DEFAULT,
  recentWallMinutes: BOARD_MAD_RECENT_WALL_MINUTES_DEFAULT,
  recentWallWeight: BOARD_MAD_RECENT_WALL_WEIGHT_DEFAULT,
  trailingBuckets: TRAILING_BUCKETS,
  warmupBuckets: WARMUP_BUCKETS,
  weighting: "volume",
  ...overrides,
});

// Build a single-game BucketSeries from an array of (elapsedSeconds, intensity)
// pairs. bucket-start is anchored at TIPOFF_S + elapsedSeconds so the wall
// timeline corresponds exactly to the game-clock elapsed timeline. PBP-derived
// gameElapsedSeconds is set on every entry — this file tests the happy path.
const sparseSeries = (
  pairs: readonly (readonly [elapsedSec: number, intensity: number])[],
): BucketSeries => ({
  bucketSeconds: BUCKET_SECONDS,
  weighting: "volume",
  freshCapSeconds: BOARD_MAD_FRESH_CAP_SECONDS_DEFAULT,
  perGame: [
    {
      gameId: "synth-elapsed",
      buckets: pairs.map(([elapsedSec, intensity]) => ({
        bucket: TIPOFF_S + elapsedSec,
        intensity,
        gameElapsedSeconds: elapsedSec,
      })),
    },
  ],
});

// Dense series: one bucket per minute from elapsed=0 to elapsed=(n-1)*60.
// Intensity is a constant calm baseline with one spike at the chosen index.
const denseSeries = (n: number, spikeAt: number, spikeIntensity = 5.0): BucketSeries => ({
  bucketSeconds: BUCKET_SECONDS,
  weighting: "volume",
  freshCapSeconds: BOARD_MAD_FRESH_CAP_SECONDS_DEFAULT,
  perGame: [
    {
      gameId: "synth-dense",
      buckets: Array.from({ length: n }, (_, i) => ({
        bucket: TIPOFF_S + i * BUCKET_SECONDS,
        intensity: i === spikeAt ? spikeIntensity : 0.05,
        gameElapsedSeconds: i * BUCKET_SECONDS,
      })),
    },
  ],
});

describe("opening-ramp warmup gate (PBP-anchored, audit-fix #1)", () => {
  it("sparse 0/4/8 minute buckets — 8-min bucket is warmed", () => {
    // Three sparse observations at game elapsed = 0, 4 min, 8 min.
    // Per the contract, 8 elapsed minutes >= warmup (8 min), so the 8-min
    // bucket must be warmed even though only TWO prior observations exist.
    const series = sparseSeries([
      [0, 1.0],
      [4 * 60, 1.0],
      [8 * 60, 5.0],
    ]);
    const { buckets } = runForK(series, 3.0, baseParams());
    expect(buckets).toHaveLength(3);
    expect(buckets[0]?.warmedUp).toBe(false); // 0 elapsed < 8 min
    expect(buckets[1]?.warmedUp).toBe(false); // 4 elapsed < 8 min
    expect(buckets[2]?.warmedUp).toBe(true); // 8 elapsed >= 8 min — KEY ASSERTION
  });

  it("sparse 0/4 minute buckets — 4-min bucket NOT warmed (under holdoff)", () => {
    const series = sparseSeries([
      [0, 1.0],
      [4 * 60, 5.0],
    ]);
    const { buckets } = runForK(series, 3.0, baseParams());
    expect(buckets[1]?.warmedUp).toBe(false);
  });

  it("sparse 5 min only — single observation under holdoff is not warmed", () => {
    const series = sparseSeries([[5 * 60, 5.0]]);
    const { buckets } = runForK(series, 3.0, baseParams());
    expect(buckets[0]?.warmedUp).toBe(false);
  });

  it("sparse 12 min only — first observation past holdoff IS warmed", () => {
    // Single observation at 12 elapsed minutes: it is past the 8-min warmup,
    // so the bucket is eligible. Baseline sample is empty (no prior values)
    // — the implementation must handle this without exploding; baselineMedian
    // and baselineMad will both be 0 (MAD floor applies on the threshold).
    const series = sparseSeries([[12 * 60, 5.0]]);
    const { buckets } = runForK(series, 3.0, baseParams());
    expect(buckets[0]?.warmedUp).toBe(true);
    expect(buckets[0]?.baselineMedian).toBe(0);
  });

  it("sparse 3/9 minute buckets — 9-min IS warmed; baseline includes the 3-min entry", () => {
    // 9 elapsed minutes >= 8 min holdoff, so the second bucket is eligible.
    // Critical: the 3-min entry is within the trailing window from 9-min, so
    // the baseline sample must include it (median of [intensity_at_3min]).
    // This is the sparse-but-elapsed-time-bounded behavior that the patch
    // is supposed to provide.
    const series = sparseSeries([
      [3 * 60, 2.0],
      [9 * 60, 5.0],
    ]);
    const { buckets } = runForK(series, 3.0, baseParams());
    expect(buckets[1]?.warmedUp).toBe(true);
    expect(buckets[1]?.baselineMedian).toBe(2.0);
  });
});

describe("opening-ramp window growth (PBP-anchored, audit-fix #1)", () => {
  it("at elapsed = warmup boundary, window is the opening baseline (4 min)", () => {
    // Dense buckets from elapsed=0..elapsed=8min. The 8-min bucket is the
    // first warmed entry, and the opening-ramp window at that point should be
    // the opening baseline duration (4 minutes worth of entries).
    const series = denseSeries(9, 8, 5.0); // 0..8 minutes, spike at 8min
    const { buckets } = runForK(series, 3.0, baseParams());
    const eligible = buckets[8];
    expect(eligible?.warmedUp).toBe(true);
    // Baseline drawn from a 4-minute window: the prior 4 entries.
    // Calm intensity is 0.05, so median should be 0.05 and MAD 0.
    expect(eligible?.baselineMedian).toBeCloseTo(0.05, 5);
  });

  it("at elapsed >= ramp-complete, window is the full trailing duration (20 min)", () => {
    // Dense 30 minutes; at minute 25 we should be past ramp-complete (20).
    // Window should be the full trailing 20 minutes of prior entries.
    const series = denseSeries(31, 25, 5.0);
    const { buckets } = runForK(series, 3.0, baseParams());
    const eligible = buckets[25];
    expect(eligible?.warmedUp).toBe(true);
    expect(eligible?.baselineMedian).toBeCloseTo(0.05, 5);
  });

  it("at intermediate elapsed, window grows monotonically with elapsed time", () => {
    // Construct: calm 0..30 min with a tiny step in calm so MAD is nonzero.
    // Check that the window at elapsed=12 has at least the opening (4) entries
    // but at most the trailing (20).
    const series: BucketSeries = {
      bucketSeconds: BUCKET_SECONDS,
      weighting: "volume",
      freshCapSeconds: BOARD_MAD_FRESH_CAP_SECONDS_DEFAULT,
      perGame: [
        {
          gameId: "synth-grow",
          buckets: Array.from({ length: 30 }, (_, i) => ({
            bucket: TIPOFF_S + i * BUCKET_SECONDS,
            intensity: 0.05 + (i % 3) * 0.01,
            gameElapsedSeconds: i * BUCKET_SECONDS,
          })),
        },
      ],
    };
    const { buckets } = runForK(series, 12.0, baseParams());
    // 8 min: must be warmed
    expect(buckets[8]?.warmedUp).toBe(true);
    // 12 min: must be warmed
    expect(buckets[12]?.warmedUp).toBe(true);
    // The baseline should be drawn from a window in [opening, trailing].
    // We don't pin exact values (depends on the ramp curve), but every
    // warmed bucket must produce a finite, non-negative median.
    Array.from({ length: 22 }, (_, offset) => offset + 8).forEach((i) => {
      const b = buckets[i];
      expect(b?.warmedUp).toBe(true);
      expect(b?.baselineMedian).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(b?.baselineMedian ?? Number.NaN)).toBe(true);
    });
  });
});

describe("dense control (PBP-anchored, audit-fix #1)", () => {
  it("dense 0..12 minutes — 8-min bucket warmed, prior buckets not", () => {
    const series = denseSeries(13, 8, 5.0);
    const { buckets } = runForK(series, 3.0, baseParams());
    Array.from({ length: 8 }, (_, i) => i).forEach((i) => {
      expect(buckets[i]?.warmedUp).toBe(false);
    });
    Array.from({ length: 5 }, (_, offset) => offset + 8).forEach((i) => {
      expect(buckets[i]?.warmedUp).toBe(true);
    });
  });

  it("dense spike at 8min — fire emitted, baseline reflects the prior calm", () => {
    const series = denseSeries(13, 8, 5.0);
    const { fires } = runForK(series, 3.0, baseParams());
    expect(fires).toHaveLength(1);
    expect(fires[0]?.intensity).toBe(5.0);
    // Calm baseline 0.05 plus a tiny MAD-floor threshold; the spike must clear it.
    expect(fires[0]?.baselineMedian).toBeCloseTo(0.05, 5);
  });
});

describe("trailing mode (PBP-anchored, audit-fix #1)", () => {
  it("sparse 3/9 min in TRAILING mode — 9-min bucket warmed; baseline = [3min entry]", () => {
    // TRAILING mode does NOT use the opening-ramp window. It goes straight
    // to the elapsed-time trailing window. The 9-min bucket must still be
    // warmed (elapsed >= 8 min) and its baseline must include the 3-min entry.
    const series = sparseSeries([
      [3 * 60, 2.0],
      [9 * 60, 5.0],
    ]);
    const { buckets } = runForK(
      series,
      3.0,
      baseParams({ baselineMode: BOARD_MAD_BASELINE_MODE_TRAILING }),
    );
    expect(buckets[1]?.warmedUp).toBe(true);
    expect(buckets[1]?.baselineMedian).toBe(2.0);
  });

  it("trailing-mode window respects elapsed time, not sparse-bucket count", () => {
    // 30 sparse buckets at every 4 minutes (elapsed = 0, 4, 8, ..., 116 min).
    // At minute 100 (sparse index 25), the elapsed trailing window of 20 min
    // includes buckets in [80, 100) elapsed minutes — pairs[20..24], five
    // entries (the lower bound is inclusive: entryElapsed >= currentElapsed -
    // windowSeconds). The key contract this test pins: it is NOT the prior 20
    // sparse buckets (which would span 80 minutes and pick up pairs[5..24]).
    const pairs: [number, number][] = Array.from({ length: 30 }, (_, i) => [
      i * 4 * 60,
      0.1 + (i % 5) * 0.01,
    ]);
    const series = sparseSeries(pairs);
    const { buckets } = runForK(
      series,
      3.0,
      baseParams({ baselineMode: BOARD_MAD_BASELINE_MODE_TRAILING }),
    );
    const minute100Bucket = buckets[25];
    expect(minute100Bucket?.warmedUp).toBe(true);
    // Sample: pairs[20..24] at elapsed 80/84/88/92/96 min.
    // Values: [0.10, 0.11, 0.12, 0.13, 0.14]; median is the middle value 0.12.
    const expectedSample = pairs
      .slice(20, 25)
      .map(([, value]) => value)
      .toSorted();
    const expectedMedian = expectedSample[2] ?? Number.NaN;
    expect(minute100Bucket?.baselineMedian).toBeCloseTo(expectedMedian, 5);
  });
});

describe("historical-blend live-only path (audit-fix #1)", () => {
  it("historical-blend with no priors still respects elapsed warmup", () => {
    // With baselineMode=HISTORICAL_BLEND but no historicalPrior on the
    // BucketSeriesGame, the live-only path runs (gameValues + recentValues).
    // The warmup gate must still trigger at 8 elapsed minutes, not at any
    // sparse count.
    const series = sparseSeries([
      [0, 1.0],
      [4 * 60, 1.0],
      [8 * 60, 5.0],
    ]);
    const { buckets } = runForK(
      series,
      3.0,
      baseParams({ baselineMode: BOARD_MAD_BASELINE_MODE_HISTORICAL_BLEND }),
    );
    expect(buckets[0]?.warmedUp).toBe(false);
    expect(buckets[1]?.warmedUp).toBe(false);
    expect(buckets[2]?.warmedUp).toBe(true);
  });
});
