// Weighted-stats helper tests (audit-fix #4, phase A3).
//
// Pins the weighted-median tie convention + the asymmetric-weight case from
// the plan that disambiguates weighted-pooled-median from plain concat
// median and linear-averaged medians.

import { describe, expect, it } from "vitest";

import { weightedMad, weightedMedian, type WeightedSample } from "../weighted-stats";

describe("weightedMedian", () => {
  it("empty input returns 0 (matches unweighted median([]) contract)", () => {
    expect(weightedMedian([])).toBe(0);
  });

  it("single sample returns its value regardless of weight", () => {
    expect(weightedMedian([{ value: 7, weight: 0.3 }])).toBe(7);
    expect(weightedMedian([{ value: 42, weight: 1.0 }])).toBe(42);
  });

  it("equal weights on [1, 3] hits the tie convention -> midpoint = 2", () => {
    // cumW[0] = 0.5 == totalW/2 exactly -> midpoint of value[0]=1, value[1]=3
    // -> (1+3)/2 = 2. This matches the unweighted median([1,3]) = 2.
    expect(
      weightedMedian([
        { value: 1, weight: 0.5 },
        { value: 3, weight: 0.5 },
      ]),
    ).toBe(2);
  });

  it("asymmetric weights — KEY plan disambiguator", () => {
    // From plan amend-2:
    //   away=[5,5,5,5] (4 samples), home=[10,50] (2 samples), awayWeight=0.3
    //   per-sample weights: away each = 0.3/4 = 0.075; home each = 0.7/2 = 0.35
    //   sorted cumulative: 5(0.075→0.075), 5(→0.15), 5(→0.225), 5(→0.3),
    //                       10(0.35→0.65), 50(0.35→1.0)
    //   totalW/2 = 0.5. Cumulative crosses 0.5 strictly inside the 10 entry
    //   (0.3 → 0.65). Weighted median = 10.
    //
    // Disambiguators:
    //   - Plain concat median: sort([5,5,5,5,10,50]) middle pair (5,10) -> 7.5
    //   - Linear-averaged medians: 5*0.3 + 30*0.7 = 22.5
    //   - Weighted median: 10  ← correct
    const awayPerSample = 0.3 / 4;
    const homePerSample = 0.7 / 2;
    const samples: readonly WeightedSample[] = [
      { value: 5, weight: awayPerSample },
      { value: 5, weight: awayPerSample },
      { value: 5, weight: awayPerSample },
      { value: 5, weight: awayPerSample },
      { value: 10, weight: homePerSample },
      { value: 50, weight: homePerSample },
    ];
    expect(weightedMedian(samples)).toBe(10);
  });

  it("zero-weight samples are filtered out before computation", () => {
    // [(7, 0), (10, 1)] should behave as [(10, 1)] -> 10
    expect(
      weightedMedian([
        { value: 7, weight: 0 },
        { value: 10, weight: 1 },
      ]),
    ).toBe(10);
  });

  it("negative-weight samples are filtered out (defensive)", () => {
    expect(
      weightedMedian([
        { value: 7, weight: -1 },
        { value: 10, weight: 1 },
      ]),
    ).toBe(10);
  });

  it("non-finite values are filtered out", () => {
    expect(
      weightedMedian([
        { value: Number.NaN, weight: 1 },
        { value: 5, weight: 1 },
        { value: 9, weight: 1 },
      ]),
    ).toBe(7); // median of [5, 9] = 7 (midpoint of two equal-weighted)
  });

  it("all weights at the same value collapse to that value", () => {
    expect(
      weightedMedian([
        { value: 3, weight: 0.3 },
        { value: 3, weight: 0.5 },
        { value: 3, weight: 0.2 },
      ]),
    ).toBe(3);
  });

  it("matches unweighted median when all weights are equal", () => {
    // [1,2,3,4,5] equal weights -> median = 3
    const samples = [1, 2, 3, 4, 5].map((value) => ({ value, weight: 1 }));
    expect(weightedMedian(samples)).toBe(3);
    // [1,2,3,4] equal weights -> tie convention -> (2+3)/2 = 2.5
    const evenSamples = [1, 2, 3, 4].map((value) => ({ value, weight: 1 }));
    expect(weightedMedian(evenSamples)).toBe(2.5);
  });
});

describe("weightedMad", () => {
  it("empty input returns 0", () => {
    expect(weightedMad([])).toBe(0);
  });

  it("single sample returns 0 (no deviation from itself)", () => {
    expect(weightedMad([{ value: 7, weight: 1 }])).toBe(0);
  });

  it("matches unweighted MAD when all weights are equal", () => {
    // [1, 2, 3, 4, 5]: median = 3, deviations [2,1,0,1,2] sorted [0,1,1,2,2],
    // median = 1. So weightedMad should be 1.
    const samples = [1, 2, 3, 4, 5].map((value) => ({ value, weight: 1 }));
    expect(weightedMad(samples)).toBe(1);
  });

  it("on the asymmetric-weight plan example, MAD is taken on weighted deviations", () => {
    // Same samples as the weighted-median KEY test: weighted median = 10.
    // Deviations: |5-10|=5 (×4 samples with weight 0.075 each),
    //             |10-10|=0 (×1 with weight 0.35),
    //             |50-10|=40 (×1 with weight 0.35).
    // Deviations sorted asc: 0 (0.35), 5 (0.075×4 = 0.3), 40 (0.35)
    // Cumulative: 0→0.35, 5→0.65, 40→1.0
    // totalW/2 = 0.5. Crosses 0.5 strictly inside the 5 entry (0.35 → 0.65).
    // Weighted MAD = 5.
    const awayPerSample = 0.3 / 4;
    const homePerSample = 0.7 / 2;
    const samples: readonly WeightedSample[] = [
      { value: 5, weight: awayPerSample },
      { value: 5, weight: awayPerSample },
      { value: 5, weight: awayPerSample },
      { value: 5, weight: awayPerSample },
      { value: 10, weight: homePerSample },
      { value: 50, weight: homePerSample },
    ];
    expect(weightedMad(samples)).toBe(5);
  });
});
