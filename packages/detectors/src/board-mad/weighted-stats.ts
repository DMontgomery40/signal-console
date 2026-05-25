// Weighted-sample median + MAD. Audit-fix #4 (phase A3, 2026-05-25).
//
// Used by combineSidePriors in services/board-mad-context.ts to combine
// away-side and home-side historical-prior samples without:
//   - Linear-averaging the two side medians/MADs (statistically meaningless
//     on nonlinear estimators -- the original bug)
//   - Concatenating raw samples without weighting (the bigger side dominates
//     silently, breaks David's stated 50/50 intent)
//   - Repeating samples to imitate weighting (biases MAD by inflating ties)
//
// Spec:
//   weightedMedian(samples): sort ascending, walk cumulative weight, the
//   median is the value at the first index where cumulative weight strictly
//   exceeds totalWeight/2. Tie convention: if cumulative weight equals
//   totalWeight/2 exactly at some index, return the midpoint of value[i] and
//   value[i+1] (the standard unweighted-median tie convention extended to
//   weighted samples).
//
//   weightedMad: compute weighted median m, then weighted median of
//   |value - m|. Same weights on the inner pass.
//
// Empty input returns 0 (matches median([]) at baseline.ts).

export interface WeightedSample {
  readonly value: number;
  readonly weight: number;
}

export function weightedMedian(samples: readonly WeightedSample[]): number {
  const filtered = samples.filter((s) => s.weight > 0 && Number.isFinite(s.value));
  if (filtered.length === 0) return 0;
  const sorted = filtered.toSorted((a, b) => a.value - b.value);
  const totalWeight = sorted.reduce((acc, s) => acc + s.weight, 0);
  if (totalWeight <= 0) return 0;
  const half = totalWeight / 2;
  // Recursive walk avoids mutable `let cumulative` (functional/no-let). The
  // tail call shape lets V8 reuse the stack frame for the long-running case.
  const walk = (i: number, cumulative: number): number => {
    if (i >= sorted.length) {
      // Floating-point edge: cumulative never strictly crossed half by
      // epsilon. Return the last sorted value.
      const last = sorted[sorted.length - 1];
      return last === undefined ? 0 : last.value;
    }
    const current = sorted[i];
    if (current === undefined) return walk(i + 1, cumulative);
    const next = sorted[i + 1];
    const newCumulative = cumulative + current.weight;
    // Strictly greater than half: this value carries the median weight.
    if (newCumulative > half + EPSILON) return current.value;
    // Exactly half AND there is a next value: midpoint tie convention.
    if (Math.abs(newCumulative - half) <= EPSILON && next !== undefined) {
      return (current.value + next.value) / 2;
    }
    return walk(i + 1, newCumulative);
  };
  return walk(0, 0);
}

export function weightedMad(samples: readonly WeightedSample[]): number {
  const filtered = samples.filter((s) => s.weight > 0 && Number.isFinite(s.value));
  if (filtered.length === 0) return 0;
  const m = weightedMedian(filtered);
  const deviations = filtered.map((s) => ({ value: Math.abs(s.value - m), weight: s.weight }));
  return weightedMedian(deviations);
}

// Floating-point comparison tolerance. Per-sample weights derived from
// awayWeight/awaySampleCount + homeWeight/homeSampleCount can produce ratios
// that don't sum exactly to totalWeight due to representation rounding;
// epsilon protects the tie path from selecting the wrong branch by a
// trillionth-of-a-weight error.
const EPSILON = 1e-12;
