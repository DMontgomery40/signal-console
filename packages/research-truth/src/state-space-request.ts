import { bucketize, bucketScore } from "./buckets";
import { LOW_SIGNAL_FLOOR, SECONDS_PER_MINUTE } from "./constants";
import { isoFromSeconds, robustStats } from "./stats";
import type {
  AlgoSpec,
  BakeoffStateSpaceHistoricalPrior,
  BakeoffStateSpaceObservation,
  BakeoffStateSpaceRequest,
  GameData,
  HistoricalPrior,
  RuntimeBaselineMode,
  StateSpaceAlgoSpec,
} from "./types";

function combineHistoricalPriors(
  away: HistoricalPrior | null,
  home: HistoricalPrior | null,
  awayWeightRaw: number,
): HistoricalPrior | null {
  if (away === null && home === null) return null;
  if (away === null) return home;
  if (home === null) return away;
  const awayWeight = Math.min(1, Math.max(0, awayWeightRaw));
  const homeWeight = 1 - awayWeight;
  return {
    median: away.median * awayWeight + home.median * homeWeight,
    mad: away.mad * awayWeight + home.mad * homeWeight,
    sampleSize: away.sampleSize + home.sampleSize,
  };
}

function sideHistoricalPrior(
  target: GameData,
  allGames: ReadonlyMap<string, GameData>,
  algo: AlgoSpec,
  side: "away" | "home",
): HistoricalPrior | null {
  const targetKey = side === "away" ? target.window.awayKey : target.window.homeKey;
  if (targetKey === null) return null;
  const lastGames = Math.max(1, Math.round(algo.historicalLastGames ?? 5));
  const openingBuckets = Math.max(1, Math.round(algo.openingBaselineBuckets ?? algo.minPrior));
  const values = [...allGames.values()]
    .filter((candidate) => {
      if (candidate.gameId === target.gameId) return false;
      if (candidate.window.scheduledStart >= target.window.scheduledStart) return false;
      const candidateKey = side === "away" ? candidate.window.awayKey : candidate.window.homeKey;
      return candidateKey === targetKey;
    })
    .toSorted((a, b) => (a.window.scheduledStart > b.window.scheduledStart ? -1 : 1))
    .slice(0, lastGames)
    .flatMap((candidate) =>
      bucketize(candidate, algo.bucketSeconds)
        .slice(0, openingBuckets)
        .map((bucket) => bucketScore(bucket, algo)),
    );
  return robustStats(values);
}

export function historicalPriorForGame(
  game: GameData,
  allGames: ReadonlyMap<string, GameData>,
  algo: AlgoSpec,
): HistoricalPrior | null {
  const away = sideHistoricalPrior(game, allGames, algo, "away");
  const home = sideHistoricalPrior(game, allGames, algo, "home");
  return combineHistoricalPriors(away, home, algo.historicalAwayWeight ?? 0.5);
}

function runtimeBaselineModeForAlgo(algo: AlgoSpec): RuntimeBaselineMode {
  if (algo.runtimeBaselineMode !== undefined) return algo.runtimeBaselineMode;
  if (algo.baselineKind === "mad-historical") return "historical-blend";
  return algo.openingBaselineBuckets !== undefined ? "opening-ramp" : "trailing";
}

function trailingGameMinutesForAlgo(algo: AlgoSpec): number {
  if (algo.gameMemorySeconds !== undefined) {
    return Math.max(
      algo.bucketSeconds / SECONDS_PER_MINUTE,
      algo.gameMemorySeconds / SECONDS_PER_MINUTE,
    );
  }
  return Math.max(
    algo.bucketSeconds / SECONDS_PER_MINUTE,
    (algo.trailingBuckets ?? algo.minPrior) * (algo.bucketSeconds / SECONDS_PER_MINUTE),
  );
}

export function buildStateSpaceRequestForGame(
  game: GameData,
  algo: StateSpaceAlgoSpec,
  allGames: ReadonlyMap<string, GameData>,
): BakeoffStateSpaceRequest {
  const stateSpace = algo.stateSpace;
  const buckets = bucketize(game, algo.bucketSeconds);
  const observations = buckets
    .map((bucket) => ({
      bucket,
      intensity: bucketScore(bucket, algo),
    }))
    .filter((entry) => entry.intensity > LOW_SIGNAL_FLOOR)
    .map(
      ({ bucket, intensity }): BakeoffStateSpaceObservation => ({
        bucketStart: isoFromSeconds(bucket.startSec),
        bucketEnd: isoFromSeconds(bucket.endSec),
        intensity,
        gameElapsedSeconds: bucket.gameElapsedSec,
        activeMarketCount: bucket.activeMarketCount,
        sourceCount: bucket.sourceCount,
        ...(bucket.sourceDominance === null ? {} : { sourceDominance: bucket.sourceDominance }),
      }),
    );
  const baselineMode = runtimeBaselineModeForAlgo(algo);
  const historicalPrior =
    baselineMode === "historical-blend" ? historicalPriorForGame(game, allGames, algo) : null;
  const openingBaselineBuckets = algo.openingBaselineBuckets ?? algo.minPrior;
  const openingRampCompleteBuckets = Number(
    algo.openingRampCompleteBuckets ?? algo.trailingBuckets ?? algo.minPrior,
  );
  const recentWallMinutes =
    algo.recentWallSeconds === undefined ? undefined : algo.recentWallSeconds / SECONDS_PER_MINUTE;
  return {
    gameId: game.gameId,
    observations,
    params: {
      baselineMode,
      bucketSeconds: algo.bucketSeconds,
      kMad: algo.k,
      trailingBuckets: algo.trailingBuckets ?? Math.max(algo.minPrior, 1),
      trailingGameMinutes: trailingGameMinutesForAlgo(algo),
      warmupBuckets: algo.warmupBuckets,
      openingBaselineBuckets,
      openingRampCompleteBuckets,
      ...(historicalPrior === null
        ? {}
        : {
            historicalPrior: {
              mad: historicalPrior.mad,
              median: historicalPrior.median,
              sampleSize: historicalPrior.sampleSize,
            } satisfies BakeoffStateSpaceHistoricalPrior,
          }),
      ...(algo.historicalPriorWeight === undefined
        ? {}
        : { historicalPriorWeight: algo.historicalPriorWeight }),
      ...(algo.historicalRampCompleteGameSeconds === undefined
        ? {}
        : {
            historicalRampCompleteGameMinutes:
              algo.historicalRampCompleteGameSeconds / SECONDS_PER_MINUTE,
          }),
      ...(recentWallMinutes === undefined ? {} : { recentWallMinutes }),
      ...(algo.recentWallWeight === undefined ? {} : { recentWallWeight: algo.recentWallWeight }),
      stateSpace,
    },
  };
}
