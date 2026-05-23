// Pre-bucketing step for board-mad. Takes raw quote_ticks, returns one
// {bucket, intensity} series per game — the K-independent half of the
// detector. Done once per backtest invocation so the Cry Wolf dial (US-037)
// can re-sweep K via runSweep() in sub-second time without re-walking the
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
//      contribution are absent from the output — preserves the sparse-series
//      semantics the trailing-baseline window depends on.
//
// The "bucket" value in BucketEntry is unix seconds (the bucket-start). The
// bucketSeconds, weighting, and freshCapSeconds inputs that produced the
// series are stored on BucketSeries so sweep.ts can stamp DetectorFire /
// DetectorBucket timestamps without a second source of truth.

import type { Tick } from "../types";
import type { Weighting } from "./params";

export interface BucketEntry {
  readonly bucket: number;
  readonly intensity: number;
}

export interface BucketSeriesGame {
  readonly gameId: string;
  readonly buckets: readonly BucketEntry[];
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
}

const DEFAULT_WEIGHTING: Weighting = "volume";
const DEFAULT_FRESH_CAP_SECONDS = 300;

type Contribution = { readonly bucket: number; readonly weighted: number };

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
  return { bucket, weighted: delta * weight };
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
  return uniqueBuckets.map(
    (b): BucketEntry => ({
      bucket: b,
      intensity: contribs.reduce((acc, c) => (c.bucket === b ? acc + c.weighted : acc), 0),
    }),
  );
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

export function prebucket(
  ticks: readonly Tick[],
  bucketSeconds: number,
  options?: PrebucketOptions,
): BucketSeries {
  const weighting: Weighting = options?.weighting ?? DEFAULT_WEIGHTING;
  const freshCapSeconds = options?.freshCapSeconds ?? DEFAULT_FRESH_CAP_SECONDS;
  const gameIds = options?.gameIds ?? discoverGameIds(ticks);
  const perGame: readonly BucketSeriesGame[] = gameIds.map((gameId) => {
    const gameTicks = ticks.filter((t) => t.gameId === gameId);
    return buildGameSeries(gameId, gameTicks, bucketSeconds, freshCapSeconds, weighting);
  });
  return { bucketSeconds, weighting, freshCapSeconds, perGame };
}
