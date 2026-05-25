// Pre-bucketing step for board-mad. Takes raw quote_ticks, returns one
// {bucket, intensity} series per game — the sensitivity-independent half of the
// detector. Done once per backtest invocation so the Sensitivity dial can
// re-sweep the threshold multiplier in sub-second time without re-walking the
// raw ticks.
//
// Algorithm (unchanged from index.ts pre-refactor; preserves canonical
// contract outcomes):
//   1. Sanitise — drop is_heartbeat and 0.500 opening-anchor rows.
//   2. Sort by (sourceMarketId, capturedAt).
//   3. For each consecutive pair within the same market with a gap in
//      (0, freshCapSeconds], emit a contribution at the bucket containing the
//      later tick: weighted = |delta(impliedProbability)| * w, where w is
//      log1p(volume) for "volume" weighting or 1 for "equal".
//   4. Sum contributions per (gameId, bucket-start). Buckets with zero
//      contribution are absent from the output; downstream baseline windows
//      use elapsed time, not sparse array index count.
//
// The "bucket" value in BucketEntry is unix seconds (the bucket-start). The
// bucketSeconds, weighting, and freshCapSeconds inputs that produced the
// series are stored on BucketSeries so sweep.ts can stamp DetectorFire /
// DetectorBucket timestamps without a second source of truth.

import type { GameTimingContext, Tick } from "../types";
import { BOARD_MAD_FRESH_CAP_SECONDS_DEFAULT, BOARD_MAD_WEIGHTING_DEFAULT } from "./config";
import type { Weighting } from "./params";

export interface BucketEntry {
  readonly bucket: number;
  readonly intensity: number;
  readonly gameElapsedSeconds?: number | null;
}

export interface BucketSeriesGame {
  readonly gameId: string;
  readonly buckets: readonly BucketEntry[];
  readonly historicalPrior?: {
    readonly median: number;
    readonly mad: number;
    readonly sampleSize: number;
  };
  // Per-game timing context resolved by the runner so the baseline can
  // anchor elapsed-seconds fallback on tipoffAnchorUtc when per-tick
  // gameElapsedSeconds is null. Audit-fix #2 (phase A2, 2026-05-25).
  readonly timingContext?: GameTimingContext;
}

export interface BucketSeries {
  readonly bucketSeconds: number;
  readonly weighting: Weighting;
  readonly freshCapSeconds: number;
  readonly perGame: readonly BucketSeriesGame[];
}

export interface PrebucketOptions {
  readonly weighting?: Weighting;
  readonly freshCapSeconds?: number;
  readonly gameIds?: readonly string[];
  readonly historicalPriors?: ReadonlyMap<
    string,
    { readonly median: number; readonly mad: number; readonly sampleSize: number }
  >;
  readonly timingContexts?: ReadonlyMap<string, GameTimingContext>;
}

const DEFAULT_WEIGHTING: Weighting = BOARD_MAD_WEIGHTING_DEFAULT;
const DEFAULT_FRESH_CAP_SECONDS = BOARD_MAD_FRESH_CAP_SECONDS_DEFAULT;

type Contribution = {
  readonly bucket: number;
  readonly weighted: number;
  readonly gameElapsedSeconds?: number | null;
};

const sanitise = (ticks: readonly Tick[]): readonly Tick[] =>
  ticks.filter(
    (t) => !t.isHeartbeat && t.impliedProbability !== null && t.impliedProbability !== 0.5,
  );

const sortByMarketAndTime = (ticks: readonly Tick[]): readonly Tick[] =>
  ticks.toSorted((a, b) => {
    if (a.sourceMarketId !== b.sourceMarketId) {
      return a.sourceMarketId < b.sourceMarketId ? -1 : 1;
    }
    return a.capturedAt.getTime() - b.capturedAt.getTime();
  });

const contributionFromPair = (
  prev: Tick,
  cur: Tick,
  bucketSeconds: number,
  freshCapSeconds: number,
  weighting: Weighting,
): Contribution | null => {
  if (prev.sourceMarketId !== cur.sourceMarketId) return null;
  const gapSec = (cur.capturedAt.getTime() - prev.capturedAt.getTime()) / 1000;
  if (gapSec <= 0 || gapSec > freshCapSeconds) return null;
  const prevIp = prev.impliedProbability;
  const curIp = cur.impliedProbability;
  if (prevIp === null || curIp === null) return null;
  const delta = Math.abs(curIp - prevIp);
  if (delta === 0) return null;
  const curSec = cur.capturedAt.getTime() / 1000;
  const bucket = Math.floor(curSec / bucketSeconds) * bucketSeconds;
  const weight = weighting === "equal" ? 1 : Math.log1p(cur.volume);
  return { bucket, gameElapsedSeconds: cur.gameElapsedSeconds ?? null, weighted: delta * weight };
};

const contributionsFromSortedTicks = (
  sortedTicks: readonly Tick[],
  bucketSeconds: number,
  freshCapSeconds: number,
  weighting: Weighting,
): readonly Contribution[] =>
  sortedTicks.flatMap((cur, i, arr): readonly Contribution[] => {
    const prev = i > 0 ? arr[i - 1] : undefined;
    if (prev === undefined) return [];
    const c = contributionFromPair(prev, cur, bucketSeconds, freshCapSeconds, weighting);
    return c === null ? [] : [c];
  });

const sumByBucket = (contribs: readonly Contribution[]): readonly BucketEntry[] => {
  const uniqueBuckets = Array.from(new Set(contribs.map((c) => c.bucket))).toSorted(
    (a, b) => a - b,
  );
  return uniqueBuckets.map((b): BucketEntry => {
    const bucketContribs = contribs.filter((c) => c.bucket === b);
    const elapsedValues = bucketContribs
      .map((c) => c.gameElapsedSeconds)
      .filter((value): value is number => Number.isFinite(value));
    return {
      bucket: b,
      gameElapsedSeconds: elapsedValues.length === 0 ? null : Math.max(...elapsedValues),
      intensity: bucketContribs.reduce((acc, c) => acc + c.weighted, 0),
    };
  });
};

const buildGameSeries = (
  gameId: string,
  gameTicks: readonly Tick[],
  bucketSeconds: number,
  freshCapSeconds: number,
  weighting: Weighting,
): BucketSeriesGame => {
  const sorted = sortByMarketAndTime(sanitise(gameTicks));
  const contribs = contributionsFromSortedTicks(sorted, bucketSeconds, freshCapSeconds, weighting);
  return { gameId, buckets: sumByBucket(contribs) };
};

const discoverGameIds = (ticks: readonly Tick[]): readonly string[] =>
  Array.from(new Set(ticks.map((t) => t.gameId))).toSorted();

const uniqueGameIds = (gameIds: readonly string[]): readonly string[] =>
  Array.from(new Set(gameIds));

export function prebucket(
  ticks: readonly Tick[],
  bucketSeconds: number,
  options?: PrebucketOptions,
): BucketSeries {
  const weighting: Weighting = options?.weighting ?? DEFAULT_WEIGHTING;
  const freshCapSeconds = options?.freshCapSeconds ?? DEFAULT_FRESH_CAP_SECONDS;
  const gameIds = uniqueGameIds(options?.gameIds ?? discoverGameIds(ticks));
  const perGame: readonly BucketSeriesGame[] = gameIds.map((gameId) => {
    const gameTicks = ticks.filter((t) => t.gameId === gameId);
    const series = buildGameSeries(gameId, gameTicks, bucketSeconds, freshCapSeconds, weighting);
    const historicalPrior = options?.historicalPriors?.get(gameId);
    const timingContext = options?.timingContexts?.get(gameId);
    return {
      ...series,
      ...(historicalPrior === undefined ? {} : { historicalPrior }),
      ...(timingContext === undefined ? {} : { timingContext }),
    };
  });
  return { bucketSeconds, weighting, freshCapSeconds, perGame };
}
