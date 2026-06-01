import { COVERAGE_NORMALIZATION_MARKET_FLOOR } from "./constants";
import type { AlgoSpec, Bucket, GameData, GameWindow, PbpPoint } from "./types";

export function contextAt(window: GameWindow, timeSec: number): PbpPoint | null {
  let lo = 0;
  let hi = window.points.length - 1;
  let best: PbpPoint | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const point = window.points[mid];
    if (point === undefined) break;
    if (point.timeSec <= timeSec) {
      best = point;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

interface MutableBucket {
  startSec: number;
  endSec: number;
  gameElapsedSec: number | null;
  period: number | null;
  secondsRemaining: number | null;
  scoreMarginAbs: number | null;
  eqIntensity: number;
  vwIntensity: number;
  logitVwIntensity: number;
  volumeHeavyIntensity: number;
  activeMarkets: Set<string>;
  sourceContribution: Map<string, number>;
  sources: Set<string>;
  families: Set<string>;
  offpriceSeverity: number;
  offpriceMarkets: Set<string>;
  offpriceSources: Set<string>;
}

export function bucketize(game: GameData, bucketSeconds: number): readonly Bucket[] {
  const cached = game.bucketCache.get(bucketSeconds);
  if (cached !== undefined) return cached;

  const buckets = new Map<number, MutableBucket>();
  const getBucket = (timeSec: number): MutableBucket => {
    const startSec = Math.floor(timeSec / bucketSeconds) * bucketSeconds;
    const existing = buckets.get(startSec);
    if (existing !== undefined) return existing;
    const context = contextAt(game.window, startSec + bucketSeconds);
    const created: MutableBucket = {
      startSec,
      endSec: startSec + bucketSeconds,
      gameElapsedSec: context?.gameElapsedSec ?? null,
      period: context?.period ?? null,
      secondsRemaining: context?.secondsRemaining ?? null,
      scoreMarginAbs: context?.scoreMarginAbs ?? null,
      eqIntensity: 0,
      vwIntensity: 0,
      logitVwIntensity: 0,
      volumeHeavyIntensity: 0,
      activeMarkets: new Set<string>(),
      sourceContribution: new Map<string, number>(),
      sources: new Set<string>(),
      families: new Set<string>(),
      offpriceSeverity: 0,
      offpriceMarkets: new Set<string>(),
      offpriceSources: new Set<string>(),
    };
    buckets.set(startSec, created);
    return created;
  };

  for (const pair of game.pairs) {
    const bucket = getBucket(pair.timeSec);
    const volumeWeight = Math.log1p(pair.volume);
    const weightedDelta = pair.deltaP * volumeWeight;
    bucket.eqIntensity += pair.deltaP;
    bucket.vwIntensity += weightedDelta;
    bucket.logitVwIntensity += pair.deltaLogit * volumeWeight;
    bucket.volumeHeavyIntensity += pair.deltaLogit * volumeWeight ** 1.5;
    bucket.activeMarkets.add(pair.sourceMarketId);
    bucket.sources.add(pair.source);
    bucket.families.add(pair.family);
    bucket.sourceContribution.set(
      pair.source,
      (bucket.sourceContribution.get(pair.source) ?? 0) + weightedDelta,
    );
  }

  for (const event of game.micro) {
    const bucket = getBucket(event.timeSec);
    bucket.offpriceSeverity += event.severity;
    bucket.offpriceMarkets.add(event.sourceMarketId);
    bucket.offpriceSources.add(event.source);
  }

  const result = [...buckets.values()]
    .sort((a, b) => a.startSec - b.startSec)
    .map((bucket): Bucket => {
      const topSourceContribution = Math.max(0, ...bucket.sourceContribution.values());
      const sourceDominance =
        bucket.vwIntensity <= 0 || bucket.sourceContribution.size === 0
          ? null
          : topSourceContribution / bucket.vwIntensity;
      return {
        startSec: bucket.startSec,
        endSec: bucket.endSec,
        gameElapsedSec: bucket.gameElapsedSec,
        period: bucket.period,
        secondsRemaining: bucket.secondsRemaining,
        scoreMarginAbs: bucket.scoreMarginAbs,
        eqIntensity: bucket.eqIntensity,
        vwIntensity: bucket.vwIntensity,
        logitVwIntensity: bucket.logitVwIntensity,
        volumeHeavyIntensity: bucket.volumeHeavyIntensity,
        activeMarketCount: bucket.activeMarkets.size,
        sourceCount: bucket.sources.size,
        sourceDominance,
        familyCount: bucket.families.size,
        offpriceSeverity: bucket.offpriceSeverity,
        offpriceFanout: bucket.offpriceMarkets.size,
        offpriceSourceCount: bucket.offpriceSources.size,
      };
    });
  game.bucketCache.set(bucketSeconds, result);
  return result;
}

export function bucketScore(bucket: Bucket, algo: AlgoSpec): number {
  if (algo.scoreKind === "board-eq") return bucket.eqIntensity;
  if (algo.scoreKind === "board-vw") return bucket.vwIntensity;
  if (algo.scoreKind === "coverage-normalized-vw") {
    const marketBreadth = Math.max(COVERAGE_NORMALIZATION_MARKET_FLOOR, bucket.activeMarketCount);
    return bucket.vwIntensity / Math.sqrt(marketBreadth);
  }
  if (algo.scoreKind === "logit-vw") return bucket.logitVwIntensity;
  if (algo.scoreKind === "volume-heavy") return bucket.volumeHeavyIntensity;
  if (algo.scoreKind === "offprice") return bucket.offpriceSeverity;
  return bucket.vwIntensity + bucket.offpriceSeverity * 0.25;
}

export function coverageNormalizedIntensity(bucket: Bucket): number {
  const marketBreadth = Math.max(COVERAGE_NORMALIZATION_MARKET_FLOOR, bucket.activeMarketCount);
  return bucket.vwIntensity / Math.sqrt(marketBreadth);
}

export function matchupLabel(window: GameWindow): string {
  const away = window.awayKey ?? "away";
  const home = window.homeKey ?? "home";
  return `${away.toUpperCase()} @ ${home.toUpperCase()}`;
}
