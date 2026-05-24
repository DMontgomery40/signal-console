// Client-side board-mad recompute (US-035 round-trip-stability prerequisite).
//
// /v1/backtest returns one observation per bucket with the intensity already
// computed. For the board-mad detector, three params can be re-applied to
// those intensities without a new server round-trip:
//
//   - kMad           : changes the fire threshold (intensity >= median + k * mad)
//   - trailingBuckets: changes which prior intensities feed median + MAD
//   - warmupBuckets  : changes the index at which a bucket is allowed to fire
//
// Three params CANNOT be recomputed from observations alone because they
// change which ticks roll into which bucket (i.e. they change the intensity
// values themselves, which the client doesn't have raw inputs for):
//
//   - bucketSeconds  : re-buckets the underlying ticks
//   - weighting      : log(1+v)*|Δp| versus just |Δp| per tick
//   - freshCapSeconds: gap filter at the tick level
//
// Editing those three should mark the result as "stale" so the user knows the
// shown numbers no longer match the current form values.
//
// The recompute mirrors packages/detectors/src/board-mad/sweep.ts. We keep
// the input data in API-shape (BacktestObservation[]) and group by gameId
// so each game's prior-bucket window is local to that game.

import type { BacktestObservation, BacktestResponse, BacktestStats } from "../../data/queries";

export const BOARD_MAD_DETECTOR_ID = "board-mad";
// Stage 1 of the suspend-signal report §8.1 — runs board-mad AND
// off-price-print over the same window and unions their fires. Default
// detector on the Backtest UI per the report's recommendation.
export const ENSEMBLE_OR_DETECTOR_ID = "ensemble-or";

// Subset of the form values needed for the client recompute. We accept extra
// keys (the form holds the full param record) and read only what we need.
export interface BoardMadRecomputeParams {
  readonly kMad: number;
  readonly trailingBuckets: number;
  readonly warmupBuckets: number;
}

// Params that drive prebucket itself — if any of these have drifted from
// what the backtest was run with, the recompute would be misleading.
export const BOARD_MAD_PREBUCKET_PARAMS: readonly string[] = [
  "bucketSeconds",
  "weighting",
  "freshCapSeconds",
];
export const BOARD_MAD_RECOMPUTE_PARAMS: readonly string[] = [
  "kMad",
  "trailingBuckets",
  "warmupBuckets",
];

export function isBoardMadRecomputeField(name: string): boolean {
  return BOARD_MAD_RECOMPUTE_PARAMS.includes(name);
}

export function isBoardMadPrebucketField(name: string): boolean {
  return BOARD_MAD_PREBUCKET_PARAMS.includes(name);
}

const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[mid - 1] ?? 0;
  return (lower + upper) / 2;
};

const medianAbsDev = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0;
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
};

interface GroupedGame {
  readonly gameId: string;
  readonly observations: readonly BacktestObservation[];
}

function groupByGame(observations: readonly BacktestObservation[]): readonly GroupedGame[] {
  const map = new Map<string, BacktestObservation[]>();
  for (const obs of observations) {
    const existing = map.get(obs.gameId);
    if (existing === undefined) {
      map.set(obs.gameId, [obs]);
    } else {
      existing.push(obs);
    }
  }
  const groups: GroupedGame[] = [];
  for (const [gameId, list] of map.entries()) {
    // Sort by bucketStart so the trailing window walks chronologically.
    list.sort((a, b) => a.bucketStart.localeCompare(b.bucketStart));
    groups.push({ gameId, observations: list });
  }
  return groups;
}

// Same shape as BacktestObservation; `fired`, `baselineMedian`, `baselineMad`
// are the recomputed values; `intensity` is preserved from the original
// observation since the client can't recompute it.
export type RecomputedObservation = BacktestObservation;

export interface RecomputeResult {
  readonly stats: BacktestStats;
  readonly observations: readonly RecomputedObservation[];
}

export function recomputeBoardMad(
  response: BacktestResponse,
  params: BoardMadRecomputeParams,
  gamesInWindow: number,
): RecomputeResult {
  const groups = groupByGame(response.observations);
  const totalFires = { count: 0 };
  const out: RecomputedObservation[] = [];
  for (const group of groups) {
    const intensities = group.observations.map((o) => o.intensity);
    for (let i = 0; i < group.observations.length; i++) {
      const obs = group.observations[i];
      if (obs === undefined) continue;
      if (i < params.warmupBuckets) {
        out.push({
          ...obs,
          fired: 0,
          baselineMedian: 0,
          baselineMad: 0,
        });
        continue;
      }
      const trailStart = Math.max(0, i - params.trailingBuckets);
      const prior = intensities.slice(trailStart, i);
      const med = median(prior);
      const madRaw = medianAbsDev(prior);
      const mad = madRaw === 0 ? 1e-9 : madRaw;
      const threshold = med + params.kMad * mad;
      const fired = obs.intensity > 0 && obs.intensity >= threshold ? 1 : 0;
      if (fired === 1) totalFires.count += 1;
      out.push({
        ...obs,
        fired,
        baselineMedian: med,
        baselineMad: mad,
      });
    }
  }
  const denom = gamesInWindow > 0 ? gamesInWindow : 1;
  return {
    stats: {
      totalFires: totalFires.count,
      firesPerGame: totalFires.count / denom,
      gamesInWindow,
    },
    observations: out,
  };
}

// Returns null when client-side recompute is not supported for the detector,
// otherwise re-derives stats + observations from the original API response.
export function applyClientRecompute(
  detectorId: string,
  response: BacktestResponse,
  params: Readonly<Record<string, unknown>>,
): RecomputeResult | null {
  if (detectorId !== BOARD_MAD_DETECTOR_ID) return null;
  const kMad = params["kMad"];
  const trailingBuckets = params["trailingBuckets"];
  const warmupBuckets = params["warmupBuckets"];
  if (typeof kMad !== "number" || !Number.isFinite(kMad)) return null;
  if (typeof trailingBuckets !== "number" || !Number.isInteger(trailingBuckets)) return null;
  if (typeof warmupBuckets !== "number" || !Number.isInteger(warmupBuckets)) return null;
  return recomputeBoardMad(
    response,
    { kMad, trailingBuckets, warmupBuckets },
    response.stats.gamesInWindow,
  );
}
