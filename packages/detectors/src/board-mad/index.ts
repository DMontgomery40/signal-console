// board-mad detector — TypeScript port of scripts/board_signal_v2.py (nba-predict).
// PRD §8 / §10: the canonical board-state volatility signal. For each game we
// iterate quote_ticks in time order, bucket per-market |delta(impliedProbability)|
// (volume-weighted by log1p(volume) by default), then fire on buckets whose
// intensity exceeds a trailing causal baseline median(prior W) + K · MAD(prior W),
// after an 8-bucket warmup, with a 300 s per-market fresh cap and is_heartbeat /
// 0.500 opening-anchor sanitations. K is a compute parameter, never persisted.

import { z } from "zod";

import type {
  Detector,
  DetectorFire,
  DetectorResult,
  DetectorStats,
  DetectorWindow,
  Tick,
} from "../types";
import { K_MAD_LIVE } from "./config";

export const Params = z.object({
  bucketSeconds: z.number().int().min(10).max(300).default(60),
  kMad: z.number().min(1).max(12).default(K_MAD_LIVE),
  weighting: z.enum(["volume", "equal"]).default("volume"),
  trailingBuckets: z.number().int().min(5).max(60).default(20),
  warmupBuckets: z.number().int().min(2).max(20).default(8),
  freshCapSeconds: z.number().int().min(30).max(3600).default(300),
});

type ParamsResolved = z.infer<typeof Params>;
type Weighting = ParamsResolved["weighting"];
type Contribution = { readonly bucket: number; readonly weighted: number };
type RawFire = {
  readonly bucket: number;
  readonly intensity: number;
  readonly median: number;
  readonly mad: number;
};

const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0;
  const sorted = xs.toSorted((a, b) => a - b);
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

const sanitize = (ticks: readonly Tick[]): readonly Tick[] =>
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
  params: ParamsResolved,
): readonly Contribution[] =>
  sortedTicks.flatMap((cur, i, arr): readonly Contribution[] => {
    const prev = i > 0 ? arr[i - 1] : undefined;
    if (prev === undefined) return [];
    const c = contributionFromPair(
      prev,
      cur,
      params.bucketSeconds,
      params.freshCapSeconds,
      params.weighting,
    );
    return c === null ? [] : [c];
  });

const sumByBucket = (contribs: readonly Contribution[]): ReadonlyMap<number, number> => {
  const uniqueBuckets = Array.from(new Set(contribs.map((c) => c.bucket)));
  return new Map(
    uniqueBuckets.map((b): [number, number] => [
      b,
      contribs.reduce((acc, c) => (c.bucket === b ? acc + c.weighted : acc), 0),
    ]),
  );
};

const detectFires = (
  buckets: ReadonlyMap<number, number>,
  params: ParamsResolved,
): readonly RawFire[] => {
  const sortedKeys = [...buckets.keys()].toSorted((a, b) => a - b);
  if (sortedKeys.length < params.warmupBuckets + 1) return [];
  return sortedKeys.flatMap((bucket, i): readonly RawFire[] => {
    if (i < params.warmupBuckets) return [];
    const trailStart = Math.max(0, i - params.trailingBuckets);
    const priorValues = sortedKeys.slice(trailStart, i).map((k) => buckets.get(k) ?? 0);
    const med = median(priorValues);
    const madRaw = medianAbsDev(priorValues);
    const mad = madRaw === 0 ? 1e-9 : madRaw;
    const threshold = med + params.kMad * mad;
    const intensity = buckets.get(bucket) ?? 0;
    if (intensity >= threshold && intensity > 0) {
      return [{ bucket, intensity, median: med, mad }];
    }
    return [];
  });
};

const runForGame = (
  gameId: string,
  ticks: readonly Tick[],
  params: ParamsResolved,
): readonly DetectorFire[] => {
  const sortedTicks = sortByMarketAndTime(sanitize(ticks));
  if (sortedTicks.length === 0) return [];
  const contribs = contributionsFromSortedTicks(sortedTicks, params);
  const buckets = sumByBucket(contribs);
  return detectFires(buckets, params).map(
    (f): DetectorFire => ({
      gameId,
      bucketStart: new Date(f.bucket * 1000),
      bucketEnd: new Date((f.bucket + params.bucketSeconds) * 1000),
      intensity: f.intensity,
      baselineMedian: f.median,
      baselineMad: f.mad,
    }),
  );
};

const ticksForGame = (allTicks: readonly Tick[], gameId: string): readonly Tick[] =>
  allTicks.filter((t) => t.gameId === gameId);

export const detector: Detector<typeof Params> = {
  id: "board-mad",
  version: "1.0.0",
  displayName: "Board MAD (whole-board volatility)",
  paramsSchema: Params,
  run(window: DetectorWindow, params: ParamsResolved): DetectorResult {
    const allTicks = window.ticks ?? [];
    const fires: readonly DetectorFire[] = window.gameIds.flatMap((gameId) =>
      runForGame(gameId, ticksForGame(allTicks, gameId), params),
    );
    const games = window.gameIds.length;
    const stats: DetectorStats = {
      firesPerGame: games === 0 ? 0 : fires.length / games,
      totalFires: fires.length,
      gamesInWindow: games,
    };
    return { fires, stats };
  },
};
