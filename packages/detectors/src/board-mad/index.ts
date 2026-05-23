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
  DetectorBucket,
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
type RawBucket = {
  readonly bucket: number;
  readonly intensity: number;
  readonly median: number;
  readonly mad: number;
  readonly fired: boolean;
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

const computeBuckets = (
  buckets: ReadonlyMap<number, number>,
  params: ParamsResolved,
): readonly RawBucket[] => {
  const sortedKeys = [...buckets.keys()].toSorted((a, b) => a - b);
  return sortedKeys.map((bucket, i): RawBucket => {
    const intensity = buckets.get(bucket) ?? 0;
    if (i < params.warmupBuckets) {
      return { bucket, intensity, median: 0, mad: 0, fired: false };
    }
    const trailStart = Math.max(0, i - params.trailingBuckets);
    const priorValues = sortedKeys.slice(trailStart, i).map((k) => buckets.get(k) ?? 0);
    const med = median(priorValues);
    const madRaw = medianAbsDev(priorValues);
    const mad = madRaw === 0 ? 1e-9 : madRaw;
    const threshold = med + params.kMad * mad;
    const fired = intensity >= threshold && intensity > 0;
    return { bucket, intensity, median: med, mad, fired };
  });
};

const toDetectorBucket = (
  gameId: string,
  raw: RawBucket,
  bucketSeconds: number,
): DetectorBucket => ({
  gameId,
  bucketStart: new Date(raw.bucket * 1000),
  bucketEnd: new Date((raw.bucket + bucketSeconds) * 1000),
  intensity: raw.intensity,
  baselineMedian: raw.median,
  baselineMad: raw.mad,
  fired: raw.fired,
});

const runForGame = (
  gameId: string,
  ticks: readonly Tick[],
  params: ParamsResolved,
): { readonly fires: readonly DetectorFire[]; readonly buckets: readonly DetectorBucket[] } => {
  const sortedTicks = sortByMarketAndTime(sanitize(ticks));
  if (sortedTicks.length === 0) return { fires: [], buckets: [] };
  const contribs = contributionsFromSortedTicks(sortedTicks, params);
  const bucketSums = sumByBucket(contribs);
  const rawBuckets = computeBuckets(bucketSums, params);
  const buckets = rawBuckets.map((b) => toDetectorBucket(gameId, b, params.bucketSeconds));
  const fires = buckets
    .filter((b) => b.fired)
    .map(
      (b): DetectorFire => ({
        gameId: b.gameId,
        bucketStart: b.bucketStart,
        bucketEnd: b.bucketEnd,
        intensity: b.intensity,
        baselineMedian: b.baselineMedian,
        baselineMad: b.baselineMad,
      }),
    );
  return { fires, buckets };
};

const ticksForGame = (allTicks: readonly Tick[], gameId: string): readonly Tick[] =>
  allTicks.filter((t) => t.gameId === gameId);

export const detector: Detector<typeof Params> = {
  id: "board-mad",
  version: "1.0.0",
  displayName: "Board MAD (whole-board volatility)",
  sources: ["bet365", "kalshi", "polymarket"],
  paramsSchema: Params,
  run(window: DetectorWindow, params: ParamsResolved): DetectorResult {
    const allTicks = window.ticks ?? [];
    const perGame = window.gameIds.map((gameId) =>
      runForGame(gameId, ticksForGame(allTicks, gameId), params),
    );
    const fires: readonly DetectorFire[] = perGame.flatMap((r) => r.fires);
    const buckets: readonly DetectorBucket[] = perGame.flatMap((r) => r.buckets);
    const games = window.gameIds.length;
    const stats: DetectorStats = {
      firesPerGame: games === 0 ? 0 : fires.length / games,
      totalFires: fires.length,
      gamesInWindow: games,
    };
    return { fires, stats, buckets };
  },
};
