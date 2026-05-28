import type { GameTimingContext, Tick } from "@signal-console/detectors";

import type {
  VolatilityStateSpaceObservation,
  VolatilityStateSpaceRequest,
} from "./volatility-model-sidecar";

export interface BuildBoardVolatilityModelRequestArgs {
  readonly bucketSeconds: number;
  readonly freshCapSeconds: number;
  readonly gameId: string;
  readonly historicalPrior?: VolatilityStateSpaceRequest["params"]["historicalPrior"] | undefined;
  readonly params: VolatilityStateSpaceRequest["params"];
  readonly timingContext?: GameTimingContext | undefined;
  readonly ticks: readonly Tick[];
  readonly weighting: "equal" | "volume";
}

interface MutableBucket {
  readonly activeMarkets: Set<string>;
  gameElapsedSeconds: number | null;
  intensity: number;
  readonly sourceContribution: Map<string, number>;
  readonly sourceMarkets: Set<string>;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function bucketKey(capturedAt: Date, bucketSeconds: number): number {
  return Math.floor(capturedAt.getTime() / 1000 / bucketSeconds) * bucketSeconds;
}

function sanitizeTicks(ticks: readonly Tick[]): readonly Tick[] {
  return ticks
    .filter(
      (tick) =>
        !tick.isHeartbeat &&
        tick.impliedProbability !== null &&
        tick.impliedProbability !== 0.5 &&
        isFiniteNumber(tick.volume),
    )
    .toSorted((left, right) => {
      if (left.sourceMarketId !== right.sourceMarketId) {
        return left.sourceMarketId < right.sourceMarketId ? -1 : 1;
      }
      return left.capturedAt.getTime() - right.capturedAt.getTime();
    });
}

function contributionWeight(tick: Tick, weighting: "equal" | "volume"): number {
  return weighting === "equal" ? 1 : Math.log1p(Math.max(0, tick.volume));
}

function tickSourceKey(tick: Tick): string {
  return tick.source ?? tick.sourceMarketId;
}

function fallbackElapsedSeconds(
  tick: Tick,
  timingContext: GameTimingContext | undefined,
): number | null {
  if (isFiniteNumber(tick.gameElapsedSeconds)) return tick.gameElapsedSeconds;
  if (timingContext === undefined || timingContext.clockSource === "none") return null;
  const tipoffSec = timingContext.tipoffAnchorUtc.getTime() / 1000;
  return Math.max(0, tick.capturedAt.getTime() / 1000 - tipoffSec);
}

export function buildBoardVolatilityModelRequest(
  args: BuildBoardVolatilityModelRequestArgs,
): VolatilityStateSpaceRequest {
  const byBucket = new Map<number, MutableBucket>();
  const ticks = sanitizeTicks(args.ticks);

  for (let index = 1; index < ticks.length; index += 1) {
    const previous = ticks[index - 1];
    const current = ticks[index];
    if (previous === undefined || current === undefined) continue;
    if (previous.sourceMarketId !== current.sourceMarketId) continue;
    const gapSeconds = (current.capturedAt.getTime() - previous.capturedAt.getTime()) / 1000;
    if (gapSeconds <= 0 || gapSeconds > args.freshCapSeconds) continue;
    const previousIp = previous.impliedProbability;
    const currentIp = current.impliedProbability;
    if (!isFiniteNumber(previousIp) || !isFiniteNumber(currentIp)) continue;
    const delta = Math.abs(currentIp - previousIp);
    if (delta <= 0) continue;
    const key = bucketKey(current.capturedAt, args.bucketSeconds);
    const bucket = byBucket.get(key) ?? {
      activeMarkets: new Set<string>(),
      gameElapsedSeconds: null,
      intensity: 0,
      sourceContribution: new Map<string, number>(),
      sourceMarkets: new Set<string>(),
    };
    const weightedDelta = delta * contributionWeight(current, args.weighting);
    const sourceKey = tickSourceKey(current);
    bucket.intensity += weightedDelta;
    bucket.activeMarkets.add(current.sourceMarketId);
    bucket.sourceMarkets.add(sourceKey);
    bucket.sourceContribution.set(
      sourceKey,
      (bucket.sourceContribution.get(sourceKey) ?? 0) + weightedDelta,
    );
    const elapsedSeconds = fallbackElapsedSeconds(current, args.timingContext);
    if (elapsedSeconds !== null) {
      bucket.gameElapsedSeconds =
        bucket.gameElapsedSeconds == null
          ? elapsedSeconds
          : Math.max(bucket.gameElapsedSeconds, elapsedSeconds);
    }
    byBucket.set(key, bucket);
  }

  const observations: VolatilityStateSpaceObservation[] = Array.from(byBucket.entries())
    .toSorted(([left], [right]) => left - right)
    .map(([startSec, bucket]) => {
      const sourceValues = Array.from(bucket.sourceContribution.values()).sort((a, b) => b - a);
      const dominantShare =
        bucket.intensity <= 0 || sourceValues.length === 0
          ? 1
          : (sourceValues[0] ?? bucket.intensity) / bucket.intensity;
      return {
        activeMarketCount: bucket.activeMarkets.size,
        bucketEnd: new Date((startSec + args.bucketSeconds) * 1000).toISOString(),
        bucketStart: new Date(startSec * 1000).toISOString(),
        ...(bucket.gameElapsedSeconds == null
          ? {}
          : { gameElapsedSeconds: bucket.gameElapsedSeconds }),
        intensity: bucket.intensity,
        sourceCount: bucket.sourceMarkets.size,
        sourceDominance: dominantShare,
      };
    });

  return {
    gameId: args.gameId,
    observations,
    params: {
      ...args.params,
      ...(args.historicalPrior === undefined ? {} : { historicalPrior: args.historicalPrior }),
    },
  };
}
