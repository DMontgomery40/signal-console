// combineSidePriors regression test (audit-fix #4, phase A3).
//
// Pins the weighted-median behavior that disambiguates from the two wrong
// alternatives Codex called out:
//   - plain concat median (lets the bigger side dominate silently)
//   - linear-averaged side medians (statistically meaningless on nonlinear
//     estimators — the original bug)
//
// See packages/detectors/src/board-mad/weighted-stats.ts for the spec and
// tie convention; this test exercises the integration in board-mad-context.

import { describe, expect, it } from "vitest";

import { combineSidePriors, selectOpeningWindowValues } from "../src/services/board-mad-context";

describe("combineSidePriors weighted pooling (audit-fix #4)", () => {
  it("plan disambiguator: away=[5×4] home=[10,50] awayWeight=0.3 → weighted median 10", () => {
    // From plan amend-2. Per-sample weights:
    //   away each = 0.3/4 = 0.075; home each = 0.7/2 = 0.35
    //   sorted cumulative: 5(0.075→0.075→0.15→0.225→0.3), 10(0.65), 50(1.0)
    //   crosses totalW/2=0.5 strictly inside 10 → weighted median = 10
    //
    // Wrong alternatives:
    //   plain concat median of [5,5,5,5,10,50] → (5+10)/2 = 7.5  ✗
    //   linear-averaged medians: 5*0.3 + 30*0.7 = 22.5  ✗
    //   correct weighted median: 10  ✓
    const combined = combineSidePriors(
      { values: [5, 5, 5, 5], sampleSize: 4 },
      { values: [10, 50], sampleSize: 2 },
      0.3,
    );
    expect(combined?.median).toBe(10);
    // Deviations from 10 with same weights: 5 (away each = 0.075, ×4 → 0.3),
    // 0 (home 10, weight 0.35), 40 (home 50, weight 0.35).
    // Sorted deviations cumulative: 0(0.35→0.35), 5(0.075→0.65), 40(1.0)
    // Crosses 0.5 strictly inside 5 → weighted MAD = 5.
    expect(combined?.mad).toBe(5);
    expect(combined?.sampleSize).toBe(6);
  });

  it("equal awayWeight=0.5 with imbalanced sample sizes still honors 50/50 weighting", () => {
    // away=[1,1,1,1,1,1,1,1] (8 samples), home=[100,100] (2 samples), awayWeight=0.5
    // Per-sample: away each = 0.5/8 = 0.0625; home each = 0.5/2 = 0.25
    // Sorted cumulative: 1(0.0625→0.125→...→0.5), 100(0.75→1.0)
    // Crosses 0.5 EXACTLY at last 1 → tie convention midpoint of (1, 100) = 50.5
    //
    // Plain concat median of [1×8, 100×2] = (1+1)/2 = 1 (bigger side dominates)
    // Linear-averaged: 1*0.5 + 100*0.5 = 50.5
    // Weighted median: 50.5 (tie midpoint)
    const combined = combineSidePriors(
      { values: [1, 1, 1, 1, 1, 1, 1, 1], sampleSize: 8 },
      { values: [100, 100], sampleSize: 2 },
      0.5,
    );
    expect(combined?.median).toBe(50.5);
  });

  it("one side null returns the present side's raw median+MAD (no weighting needed)", () => {
    const awayOnly = combineSidePriors({ values: [1, 2, 3, 4, 5], sampleSize: 5 }, null, 0.5);
    expect(awayOnly?.median).toBe(3);
    expect(awayOnly?.mad).toBe(1);
    expect(awayOnly?.sampleSize).toBe(5);
  });

  it("both sides null returns null", () => {
    expect(combineSidePriors(null, null, 0.5)).toBeNull();
  });

  it("awayWeight=0 drops away samples entirely; weight collapses to home", () => {
    const combined = combineSidePriors(
      { values: [1, 1, 1, 1], sampleSize: 4 },
      { values: [10, 20, 30], sampleSize: 3 },
      0,
    );
    // All weight on home → weighted median of [10,20,30] equal weights → 20
    expect(combined?.median).toBe(20);
  });

  it("awayWeight=1 drops home samples entirely; weight collapses to away", () => {
    const combined = combineSidePriors(
      { values: [1, 2, 3, 4, 5], sampleSize: 5 },
      { values: [100, 200], sampleSize: 2 },
      1,
    );
    expect(combined?.median).toBe(3);
  });
});

describe("selectOpeningWindowValues (audit-fix #6, phase A5)", () => {
  // openingBaselineBuckets=4 with bucketSeconds=60 → openingWindowSeconds=240.
  const OPENING_WINDOW_SECONDS = 4 * 60;
  // PBP MIN at a known unix-second anchor. Bucket times below are relative
  // to this anchor so per-bucket elapsed = bucket - anchor.
  const PBP_MIN_UNIX_SEC = 1_779_500_000;

  it("includes only buckets with elapsed < openingWindowSeconds (PBP-anchored)", () => {
    // 6 buckets at elapsed 0, 60, 120, 180, 240, 300 sec. The 240s bucket is
    // EXACTLY at the boundary (strictly less than 240 means excluded). 0/60/
    // 120/180 are included (4 values). Integer intensities avoid float-rep
    // drift in toEqual.
    const buckets = [0, 60, 120, 180, 240, 300].map((elapsed, i) => ({
      bucket: PBP_MIN_UNIX_SEC + elapsed,
      intensity: i + 1, // 1, 2, 3, 4, 5, 6
      gameElapsedSeconds: elapsed,
    }));
    const values = selectOpeningWindowValues(buckets, OPENING_WINDOW_SECONDS, PBP_MIN_UNIX_SEC);
    expect(values).toEqual([1, 2, 3, 4]);
  });

  it("KEY: prior game with one early sparse bucket and 10 quiet min contributes ONE value", () => {
    // The bug scenario: one bucket at elapsed=60s, then nothing else nonzero
    // until elapsed=10min (the rest of the opening is quiet, the next
    // observation lands mid-game). The OLD code did .slice(0, 4) and pulled
    // the next 3 mid-game buckets into the "opening" prior, biasing it. The
    // NEW code filters by elapsed time and contributes ONLY the one early
    // bucket.
    const buckets = [
      { bucket: PBP_MIN_UNIX_SEC + 60, intensity: 0.05, gameElapsedSeconds: 60 },
      { bucket: PBP_MIN_UNIX_SEC + 10 * 60, intensity: 5.0, gameElapsedSeconds: 10 * 60 },
      { bucket: PBP_MIN_UNIX_SEC + 15 * 60, intensity: 4.5, gameElapsedSeconds: 15 * 60 },
      { bucket: PBP_MIN_UNIX_SEC + 20 * 60, intensity: 6.0, gameElapsedSeconds: 20 * 60 },
    ];
    const values = selectOpeningWindowValues(buckets, OPENING_WINDOW_SECONDS, PBP_MIN_UNIX_SEC);
    expect(values).toEqual([0.05]);
  });

  it("falls back to wall-elapsed from PBP MIN when gameElapsedSeconds is null", () => {
    // Defensive: if some bucket lacks per-tick gameElapsedSeconds (PBP row
    // missing for that interval), use bucket.bucket - pbpMinUnixSec.
    const buckets = [
      { bucket: PBP_MIN_UNIX_SEC + 30, intensity: 0.1, gameElapsedSeconds: null },
      { bucket: PBP_MIN_UNIX_SEC + 90, intensity: 0.2, gameElapsedSeconds: null },
      { bucket: PBP_MIN_UNIX_SEC + 600, intensity: 0.3, gameElapsedSeconds: null },
    ];
    const values = selectOpeningWindowValues(buckets, OPENING_WINDOW_SECONDS, PBP_MIN_UNIX_SEC);
    // 30s and 90s are inside 240s window; 600s is past it.
    expect(values).toEqual([0.1, 0.2]);
  });

  it("empty buckets array returns empty result", () => {
    expect(selectOpeningWindowValues([], OPENING_WINDOW_SECONDS, PBP_MIN_UNIX_SEC)).toEqual([]);
  });
});
