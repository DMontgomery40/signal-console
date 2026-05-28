// Board service (US-021, PRD §15 / §9).
//
// Backs GET /v1/board/:gameId. Always computes at the live default kMad
// (K_MAD_LIVE) — no K override; Backtest is the override surface.
//
// AMENDED 2026-05-24 (phase A0b): now a thin wrapper around the shared
// detector runner (services/detector-runner.ts). Live and backtest share one
// execution path; this file maps runner output to the existing BoardResult
// API shape. Cache semantics, params resolution, in-play window narrowing,
// historical-prior building, and watermark identity are all owned by the
// runner. Per the plan, the runner's watermark hash includes clockSource +
// tipoffAnchorUtc, so existing cached rows from before phase A0a invalidate
// once — that's the intentional one-time recompute that comes with the
// elapsed-anchor cache-identity change.

import {
  Params as BoardMadParams,
  detector as boardMad,
} from "@signal-console/detectors/board-mad";

import {
  boardMadDetectorVersion,
  readDetectorDefaults,
  type DetectorDefaults,
} from "./detector-defaults";
import { runDetector, type BoardVolatilityRunner } from "./detector-runner";

export interface BoardObservation {
  readonly bucketStart: string;
  readonly bucketEnd: string;
  readonly fired: number;
  readonly intensity: number;
  readonly baselineMedian: number;
  readonly baselineMad: number;
  readonly threshold?: number;
  readonly standardizedInnovation?: number;
  readonly regimeScore?: number;
  readonly warmedUp: boolean;
}

export interface BoardResult {
  readonly gameId: string;
  readonly runId: number;
  readonly k: number;
  readonly observations: readonly BoardObservation[];
}

export interface GetOrComputeBoardArgs {
  readonly goldDbPath: string;
  readonly cacheDbPath: string;
  readonly gameId: string;
  readonly boardVolatilityFetchImpl?: typeof fetch;
  readonly boardVolatilityRunner?: BoardVolatilityRunner;
  readonly boardVolatilitySidecarBaseUrl?: string;
  readonly now?: Date;
}

// Resolve the live runtime params payload from detector defaults. Kept here
// because the live route is locked to defaults; Backtest receives its params
// from the request body and dispatches through the runner separately.
function resolveLiveBoardMadParams(
  defaults: DetectorDefaults,
): ReturnType<typeof BoardMadParams.parse> {
  return BoardMadParams.parse({
    kMad: defaults.kMadLive,
    baselineMode: defaults.baselineMode,
    bucketSeconds: defaults.bucketSeconds,
    historicalAwayWeight: defaults.historicalAwayWeight,
    historicalLastGames: defaults.historicalLastGames,
    historicalPriorWeight: defaults.historicalPriorWeight,
    historicalRampCompleteGameMinutes: defaults.historicalRampCompleteGameMinutes,
    openingBaselineBuckets: defaults.openingBaselineBuckets,
    openingRampCompleteBuckets: defaults.openingRampCompleteBuckets,
    recentWallMinutes: defaults.recentWallMinutes,
    recentWallWeight: defaults.recentWallWeight,
    trailingGameMinutes: defaults.trailingGameMinutes,
    trailingBuckets: defaults.trailingBuckets,
    warmupBuckets: defaults.warmupBuckets,
    freshCapSeconds: defaults.freshCapSeconds,
  });
}

export async function getOrComputeBoard(args: GetOrComputeBoardArgs): Promise<BoardResult> {
  const defaults = readDetectorDefaults();
  const params = resolveLiveBoardMadParams(defaults);

  const result = await runDetector({
    detectorId: "board-mad",
    params,
    scope: { kind: "game", gameId: args.gameId },
    goldDbPath: args.goldDbPath,
    cacheDbPath: args.cacheDbPath,
    ...(args.boardVolatilityFetchImpl === undefined
      ? {}
      : { boardVolatilityFetchImpl: args.boardVolatilityFetchImpl }),
    ...(args.boardVolatilityRunner === undefined
      ? {}
      : { boardVolatilityRunner: args.boardVolatilityRunner }),
    ...(args.boardVolatilitySidecarBaseUrl === undefined
      ? {}
      : { boardVolatilitySidecarBaseUrl: args.boardVolatilitySidecarBaseUrl }),
    ...(args.now === undefined ? {} : { now: args.now }),
  });

  return {
    gameId: args.gameId,
    runId: result.runId,
    k: params.kMad,
    observations: result.buckets.map(
      (b): BoardObservation => ({
        bucketStart: b.bucketStart.toISOString(),
        bucketEnd: b.bucketEnd.toISOString(),
        fired: b.fired ? 1 : 0,
        intensity: b.intensity,
        baselineMedian: b.baselineMedian,
        baselineMad: b.baselineMad,
        ...(b.threshold === undefined ? {} : { threshold: b.threshold }),
        ...(b.standardizedInnovation === undefined
          ? {}
          : { standardizedInnovation: b.standardizedInnovation }),
        ...(b.regimeScore === undefined ? {} : { regimeScore: b.regimeScore }),
        warmedUp: b.warmedUp,
      }),
    ),
  };
}

// Re-export for callers that referenced the literal id; same value as
// runtime detector.id, preserved here so route imports don't have to change.
export const BOARD_DETECTOR_ID = boardMad.id;
export { boardMadDetectorVersion };
