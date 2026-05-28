// Shared detector execution runner. Single execution path for board-mad,
// off-price-print, and ensemble-or across LIVE (single-game) and BACKTEST
// (window-of-games) scopes. Replaces the duplication-by-clone pattern between
// services/board.ts and services/backtest.ts so live and backtest cannot drift
// in params, loading, priors, timing, or cache identity.
//
// AMENDED 2026-05-24 (phase A0): Codex's critique was right — cloning board.ts
// into off-price.ts / ensemble.ts would have created three more places for
// truth to drift. The runner is the consolidation point. Live and backtest may
// differ only in scope (game vs window) and persistence shape; formulas,
// defaults, timing math, and priors are computed exactly once.
//
// Cache invalidation contract: the watermark hash includes per-game
// GameTimingContext (clockSource + tipoffAnchorUtc + scheduledStart) so any
// `scheduled`-anchored run recomputes when PBP arrives later. This closes the
// "8 elapsed minutes when PBP is missing" silent fallback bug.

import { createHash } from "node:crypto";

import { openCacheDb, openGoldDb } from "@signal-console/db";
import {
  Params as BoardMadParams,
  type ParamsResolved as BoardMadParamsResolved,
} from "@signal-console/detectors/board-mad";
import { BOARD_MAD_BASELINE_MODE_HISTORICAL_BLEND } from "@signal-console/detectors/board-mad/config";
import {
  detector as ensembleOr,
  Params as EnsembleOrParams,
} from "@signal-console/detectors/ensemble-or";
import {
  detector as offPricePrint,
  Params as OffPricePrintParams,
} from "@signal-console/detectors/off-price-print";
import type {
  DetectorBucket,
  DetectorFire,
  DetectorResult,
  DetectorStats,
  DetectorWindow,
  GameTimingContext,
  MicrostructureEvent,
  Tick,
} from "@signal-console/detectors";
import type Database from "better-sqlite3";
import { z } from "zod";

import { buildBoardVolatilityModelRequest } from "./board-volatility-model";
import { buildBoardMadHistoricalPriors, loadBoardMadTicksForGame } from "./board-mad-context";
import {
  boardMadDetectorVersion,
  readDetectorDefaults,
  type DetectorDefaults,
} from "./detector-defaults";
import { loadMicrostructureForGames } from "./loaders/microstructure-loader";
import {
  fetchBoardVolatilityStateSpace,
  type VolatilityStateSpaceParams,
  type VolatilityStateSpaceRequest,
  type VolatilityStateSpaceResponse,
} from "./volatility-model-sidecar";

export type { ClockSource, GameTimingContext } from "@signal-console/detectors";

type GoldDbHandle = ReturnType<typeof openGoldDb>;

// --- public types -----------------------------------------------------------

export type DetectorId = "board-mad" | "off-price-print" | "ensemble-or";

export type RunScope =
  | { readonly kind: "game"; readonly gameId: string }
  | {
      readonly kind: "window";
      readonly windowStart: string;
      readonly windowEnd: string;
      readonly gameIds: readonly string[];
    };

type FetchLike = typeof fetch;

export interface BoardVolatilityRunnerArgs {
  readonly fetchImpl?: FetchLike;
  readonly sidecarBaseUrl?: string;
  readonly window: DetectorWindow;
  readonly params: BoardMadParamsResolved;
}

export type BoardVolatilityRunner = (args: BoardVolatilityRunnerArgs) => Promise<DetectorResult>;

export interface RunSpec {
  readonly detectorId: DetectorId;
  // Raw params from caller; validated by the per-detector zod schema inside
  // the runner so each route sends what it has and the runner enforces shape.
  readonly params: unknown;
  readonly scope: RunScope;
  readonly goldDbPath: string;
  readonly cacheDbPath: string;
  readonly boardVolatilityFetchImpl?: FetchLike;
  readonly boardVolatilityRunner?: BoardVolatilityRunner;
  readonly boardVolatilitySidecarBaseUrl?: string;
  readonly now?: Date;
}

// Mirrors DetectorResult (packages/detectors/src/types.ts:112-116). board-mad
// populates `buckets` AND `fires`; off-price-print populates ONLY `fires`
// (point events, no per-bucket aggregates — its detector returns `buckets:[]`
// at off-price-print/index.ts:61); ensemble-or populates both with the `lane`
// tag preserved on each fire so the route can render lanes distinctly. Each
// route maps RunResult to its own response type — the runner never forces a
// shoehorn.
export interface RunResult {
  readonly runId: number;
  readonly detectorId: DetectorId;
  readonly detectorVersion: string;
  readonly paramsHash: string;
  readonly resolvedParams: unknown;
  readonly buckets: readonly DetectorBucket[];
  readonly fires: readonly DetectorFire[];
  readonly stats: DetectorStats;
  readonly timingContexts: readonly GameTimingContext[];
}

export class RunnerError extends Error {
  public readonly code: "unknown_detector" | "invalid_params" | "no_games";
  public constructor(code: "unknown_detector" | "invalid_params" | "no_games", message: string) {
    super(message);
    this.code = code;
  }
}

// --- public API -------------------------------------------------------------

// Single source of tipoff truth. PBP MIN(time_actual) is preferred; falls back
// to games.scheduled_start tagged clockSource="scheduled" so the math has a
// real anchor instead of "first nonzero market bucket." When both are missing,
// clockSource="none" and downstream baseline computation will refuse to warm.
export function resolveGameTimingContext(goldDb: GoldDbHandle, gameId: string): GameTimingContext {
  const pbp = readPbpBounds(goldDb, gameId);
  const scheduled = readScheduledStart(goldDb, gameId);
  const scheduledStartUtc = scheduled ?? null;

  if (pbp !== null) {
    return {
      gameId,
      scheduledStartUtc: scheduledStartUtc ?? pbp.minUtc,
      tipoffAnchorUtc: pbp.minUtc,
      clockSource: "pbp",
      pbpMinUtc: pbp.minUtc,
      pbpMaxUtc: pbp.maxUtc,
    };
  }
  if (scheduledStartUtc !== null) {
    return {
      gameId,
      scheduledStartUtc,
      tipoffAnchorUtc: scheduledStartUtc,
      clockSource: "scheduled",
      pbpMinUtc: null,
      pbpMaxUtc: null,
    };
  }
  // No anchor at all — return a sentinel "none" context. The baseline gate
  // will refuse to warm any bucket since no real elapsed reference exists.
  // This is the fail-closed posture (no fake fires) for unknown games.
  return {
    gameId,
    scheduledStartUtc: new Date(0),
    tipoffAnchorUtc: new Date(0),
    clockSource: "none",
    pbpMinUtc: null,
    pbpMaxUtc: null,
  };
}

export async function runDetector(spec: RunSpec): Promise<RunResult> {
  const now = spec.now ?? new Date();
  const defaults = readDetectorDefaults();
  const dispatch = resolveDispatch(spec.detectorId, spec.params, defaults, {
    ...(spec.boardVolatilityFetchImpl === undefined
      ? {}
      : { boardVolatilityFetchImpl: spec.boardVolatilityFetchImpl }),
    ...(spec.boardVolatilityRunner === undefined
      ? {}
      : { boardVolatilityRunner: spec.boardVolatilityRunner }),
    ...(spec.boardVolatilitySidecarBaseUrl === undefined
      ? {}
      : { boardVolatilitySidecarBaseUrl: spec.boardVolatilitySidecarBaseUrl }),
  });
  const paramsJson = canonicalJson(dispatch.resolvedParams);
  const paramsHash = sha256Hex(paramsJson);

  const cacheDb = openCacheDb(spec.cacheDbPath);
  try {
    const goldDb = openGoldDb(spec.goldDbPath);
    try {
      const gameIds = uniqueGameIds(scopeGameIds(spec.scope));
      if (gameIds.length === 0 && spec.scope.kind === "window") {
        // Window scope can legitimately have zero games (caller is testing a
        // window with no eligible games). Return an empty result without
        // touching the cache; persistence requires at least one game.
        return emptyResult(
          spec.detectorId,
          dispatch.detectorVersion,
          paramsHash,
          dispatch.resolvedParams,
        );
      }

      // 1. Resolve per-game timing contexts (single source of tipoff truth).
      const timingContexts: readonly GameTimingContext[] = gameIds.map((gameId) =>
        resolveGameTimingContext(goldDb, gameId),
      );

      // 2. Resolve effective per-game tick windows (PBP MIN..MAX + buffers,
      //    intersected with requested window in window-scope). When PBP is
      //    missing but scheduled_start exists, the timing context drives a
      //    scheduled-anchored window so the detector still loads ticks during
      //    PBP lag (cache invalidates when PBP arrives because clockSource +
      //    tipoffAnchor are in the watermark hash).
      const timingByGame = new Map<string, GameTimingContext>(
        timingContexts.map((t) => [t.gameId, t]),
      );
      const tickWindows = new Map<string, EffectiveTickWindow | null>();
      for (const gameId of gameIds) {
        const timing = timingByGame.get(gameId);
        if (timing === undefined) {
          tickWindows.set(gameId, null);
          continue;
        }
        tickWindows.set(
          gameId,
          resolveEffectiveTickWindow(goldDb, gameId, spec.scope, defaults, timing),
        );
      }

      // 3. Historical priors (only for board-mad/ensemble-or in historical-blend).
      const historicalPriors =
        dispatch.boardMadParams !== undefined &&
        dispatch.boardMadParams.baselineMode === BOARD_MAD_BASELINE_MODE_HISTORICAL_BLEND
          ? buildBoardMadHistoricalPriors(goldDb, gameIds, dispatch.boardMadParams)
          : [];

      // 4. Watermark hash includes everything that can change the result:
      //    timing contexts (so PBP-arrival invalidates scheduled-anchored cache),
      //    tick window stats, microstructure event stats (when used), priors,
      //    and scope identity.
      const watermarkHash = computeWatermarkHash({
        goldDb,
        scope: spec.scope,
        gameIds,
        timingContexts,
        tickWindows,
        sources: dispatch.sources,
        defaults,
        historicalPriors,
      });

      // 5. Cache lookup.
      const hit = lookupRun(cacheDb, {
        detectorId: spec.detectorId,
        detectorVersion: dispatch.detectorVersion,
        paramsHash,
        watermarkHash,
        scope: spec.scope,
      });
      if (hit !== null) {
        const observations = loadObservations(cacheDb, hit.runId);
        const { buckets, fires } = splitObservations(observations);
        return {
          runId: hit.runId,
          detectorId: spec.detectorId,
          detectorVersion: dispatch.detectorVersion,
          paramsHash,
          resolvedParams: dispatch.resolvedParams,
          buckets,
          fires,
          stats: buildStats(buckets, fires, gameIds.length),
          timingContexts,
        };
      }

      // 6. Cache miss: load data, dispatch detector, persist.
      const startNs = process.hrtime.bigint();
      const ticks: readonly Tick[] = dispatch.sources.includes("ticks")
        ? loadTicksForGames(goldDb, gameIds, tickWindows)
        : [];
      const microstructureEvents: readonly MicrostructureEvent[] = dispatch.sources.includes(
        "microstructure",
      )
        ? loadMicrostructureForScope(goldDb, spec.scope, gameIds)
        : [];

      const window: DetectorWindow = {
        gameIds,
        start: scopeStart(spec.scope, tickWindows, now),
        end: scopeEnd(spec.scope, tickWindows, now),
        ticks,
        microstructureEvents,
        boardMadHistoricalPriors: historicalPriors,
        timingContexts,
      };

      const rawResult: DetectorResult = await dispatch.run(window);
      // Normalize lane tags so cold-path and warm-path RunResult.fires have
      // the SAME shape. off-price-print emits lane-less fires upstream
      // (off-price-print/index.ts:34-42); ensemble-or wraps and tags them
      // lane="offprice". For the standalone case we tag here so consumers
      // (and the cache-hit reload path) see consistent fires regardless of
      // whether the result came from the cold path or the persisted row.
      const result: DetectorResult =
        spec.detectorId === "off-price-print"
          ? {
              ...rawResult,
              fires: rawResult.fires.map((f) =>
                f.lane === undefined ? { ...f, lane: "offprice" as const } : f,
              ),
            }
          : rawResult;
      const computeMs = Number((process.hrtime.bigint() - startNs) / 1_000_000n);

      const runId = persistRun(cacheDb, {
        detectorId: spec.detectorId,
        detectorVersion: dispatch.detectorVersion,
        paramsHash,
        paramsJson,
        sourceDbPath: spec.goldDbPath,
        watermarkHash,
        computedAt: now.toISOString(),
        computeMs,
        scope: spec.scope,
        buckets: result.buckets,
        fires: result.fires,
      });

      return {
        runId,
        detectorId: spec.detectorId,
        detectorVersion: dispatch.detectorVersion,
        paramsHash,
        resolvedParams: dispatch.resolvedParams,
        buckets: result.buckets,
        fires: result.fires,
        stats: buildStats(result.buckets, result.fires, gameIds.length),
        timingContexts,
      };
    } finally {
      goldDb.close();
    }
  } finally {
    cacheDb.close();
  }
}

// --- dispatch ---------------------------------------------------------------

interface Dispatch {
  readonly detectorVersion: string;
  readonly resolvedParams: unknown;
  readonly boardMadParams?: BoardMadParamsResolved;
  readonly sources: readonly SourceKind[];
  readonly run: (window: DetectorWindow) => Promise<DetectorResult> | DetectorResult;
}

type SourceKind = "ticks" | "microstructure";

interface BoardVolatilityRuntimeOptions {
  readonly boardVolatilityFetchImpl?: FetchLike;
  readonly boardVolatilityRunner?: BoardVolatilityRunner;
  readonly boardVolatilitySidecarBaseUrl?: string;
}

function resolveDispatch(
  detectorId: DetectorId,
  rawParams: unknown,
  defaults: DetectorDefaults,
  runtime: BoardVolatilityRuntimeOptions,
): Dispatch {
  switch (detectorId) {
    case "board-mad": {
      const parsed = BoardMadParams.safeParse(rawParams);
      if (!parsed.success) throw new RunnerError("invalid_params", parsed.error.message);
      const params = parsed.data;
      return {
        detectorVersion: boardMadDetectorVersion(defaults),
        resolvedParams: params,
        boardMadParams: params,
        sources: ["ticks"],
        run: (w) => runBoardVolatilityDetector(w, params, runtime),
      };
    }
    case "off-price-print": {
      const parsed = OffPricePrintParams.safeParse(rawParams);
      if (!parsed.success) throw new RunnerError("invalid_params", parsed.error.message);
      const params = parsed.data;
      return {
        detectorVersion: offPricePrint.version,
        resolvedParams: params,
        sources: ["microstructure"],
        run: (w) => Promise.resolve(offPricePrint.run(w, params)),
      };
    }
    case "ensemble-or": {
      const parsed = EnsembleOrParams.safeParse(rawParams);
      if (!parsed.success) throw new RunnerError("invalid_params", parsed.error.message);
      const params = parsed.data;
      // Closes finding #10 by construction: ensemble historical-blend priors
      // are now built whenever params.board.baselineMode requests them, exactly
      // the same way as the standalone board-mad case.
      return {
        detectorVersion: `${ensembleOr.version}+board=${boardMadDetectorVersion(defaults)}+off=${offPricePrint.version}`,
        resolvedParams: params,
        boardMadParams: params.board,
        sources: ["ticks", "microstructure"],
        run: (w) => runEnsembleOrDetector(w, params, runtime),
      };
    }
    default: {
      const exhaustive: never = detectorId;
      throw new RunnerError("unknown_detector", `unknown detector: ${String(exhaustive)}`);
    }
  }
}

function boardVolatilityParams(
  params: BoardMadParamsResolved,
  historicalPrior?: VolatilityStateSpaceRequest["params"]["historicalPrior"],
): VolatilityStateSpaceParams {
  return {
    baselineMode: params.baselineMode,
    bucketSeconds: params.bucketSeconds,
    ...(historicalPrior === undefined ? {} : { historicalPrior }),
    historicalPriorWeight: params.historicalPriorWeight,
    historicalRampCompleteGameMinutes: params.historicalRampCompleteGameMinutes,
    kMad: params.kMad,
    openingBaselineBuckets: params.openingBaselineBuckets,
    openingRampCompleteBuckets: params.openingRampCompleteBuckets,
    recentWallMinutes: params.recentWallMinutes,
    recentWallWeight: params.recentWallWeight,
    stateSpace: params.stateSpace,
    trailingBuckets: params.trailingBuckets,
    trailingGameMinutes: params.trailingGameMinutes,
    warmupBuckets: params.warmupBuckets,
  };
}

function detectorBucketsFromSidecarResponse(
  request: VolatilityStateSpaceRequest,
  response: VolatilityStateSpaceResponse,
): readonly DetectorBucket[] {
  if (response.observations.length !== request.observations.length) {
    throw new Error(
      `Board volatility sidecar returned ${String(response.observations.length)} observations for ${request.gameId ?? "unknown"} but ${String(request.observations.length)} were requested.`,
    );
  }
  if (
    response.gameId !== undefined &&
    request.gameId !== undefined &&
    response.gameId !== request.gameId
  ) {
    throw new Error(
      `Board volatility sidecar gameId mismatch: expected ${request.gameId}, received ${response.gameId}.`,
    );
  }
  return response.observations.map((observation, index): DetectorBucket => {
    const input = request.observations[index];
    if (input === undefined) {
      throw new Error("board volatility sidecar response index is out of bounds");
    }
    return {
      gameId: request.gameId ?? "",
      bucketStart: new Date(observation.bucketStart),
      bucketEnd: new Date(observation.bucketEnd),
      intensity: input.intensity,
      ...(input.gameElapsedSeconds == null ? {} : { gameElapsedSeconds: input.gameElapsedSeconds }),
      baselineMedian: observation.baselineMedian,
      baselineMad: observation.baselineMad,
      threshold: observation.threshold,
      standardizedInnovation: observation.standardizedInnovation,
      regimeScore: observation.regimeScore,
      warmedUp: observation.warmedUp,
      fired: observation.fired,
    };
  });
}

function boardFiresFromBuckets(buckets: readonly DetectorBucket[]): readonly DetectorFire[] {
  return buckets.flatMap((bucket): readonly DetectorFire[] =>
    bucket.fired && bucket.warmedUp
      ? [
          {
            gameId: bucket.gameId,
            bucketStart: bucket.bucketStart,
            bucketEnd: bucket.bucketEnd,
            intensity: bucket.intensity,
            baselineMedian: bucket.baselineMedian,
            baselineMad: bucket.baselineMad,
            ...(bucket.threshold === undefined ? {} : { threshold: bucket.threshold }),
            ...(bucket.standardizedInnovation === undefined
              ? {}
              : { standardizedInnovation: bucket.standardizedInnovation }),
            ...(bucket.regimeScore === undefined ? {} : { regimeScore: bucket.regimeScore }),
          },
        ]
      : [],
  );
}

async function runBoardVolatilityViaSidecar(
  window: DetectorWindow,
  params: BoardMadParamsResolved,
  runtime: BoardVolatilityRuntimeOptions,
): Promise<DetectorResult> {
  const ticks = window.ticks ?? [];
  const historicalPriorByGame = new Map(
    (window.boardMadHistoricalPriors ?? []).map((prior) => [prior.gameId, prior]),
  );
  const timingByGame = new Map((window.timingContexts ?? []).map((ctx) => [ctx.gameId, ctx]));
  const perGameBuckets = await Promise.all(
    uniqueGameIds(window.gameIds).map(async (gameId) => {
      const request = buildBoardVolatilityModelRequest({
        bucketSeconds: params.bucketSeconds,
        freshCapSeconds: params.freshCapSeconds,
        gameId,
        ...(historicalPriorByGame.get(gameId) === undefined
          ? {}
          : { historicalPrior: historicalPriorByGame.get(gameId) }),
        params: boardVolatilityParams(params, historicalPriorByGame.get(gameId)),
        ticks: ticks.filter((tick) => tick.gameId === gameId),
        ...(timingByGame.get(gameId) === undefined
          ? {}
          : { timingContext: timingByGame.get(gameId) }),
        weighting: params.weighting,
      });
      if (request.observations.length === 0) return [] as const;
      const response = await fetchBoardVolatilityStateSpace({
        ...(runtime.boardVolatilityFetchImpl === undefined
          ? {}
          : { fetchImpl: runtime.boardVolatilityFetchImpl }),
        ...(runtime.boardVolatilitySidecarBaseUrl === undefined
          ? {}
          : { baseUrl: runtime.boardVolatilitySidecarBaseUrl }),
        request,
      });
      return detectorBucketsFromSidecarResponse(request, response);
    }),
  );
  const buckets = perGameBuckets.flat();
  const fires = boardFiresFromBuckets(buckets);
  const games = uniqueGameIds(window.gameIds).length;
  return {
    buckets,
    fires,
    stats: {
      firesPerGame: games === 0 ? 0 : fires.length / games,
      totalFires: fires.length,
      gamesInWindow: games,
    },
  };
}

async function runBoardVolatilityDetector(
  window: DetectorWindow,
  params: BoardMadParamsResolved,
  runtime: BoardVolatilityRuntimeOptions,
): Promise<DetectorResult> {
  if (runtime.boardVolatilityRunner !== undefined) {
    return await runtime.boardVolatilityRunner({
      ...(runtime.boardVolatilityFetchImpl === undefined
        ? {}
        : { fetchImpl: runtime.boardVolatilityFetchImpl }),
      ...(runtime.boardVolatilitySidecarBaseUrl === undefined
        ? {}
        : { sidecarBaseUrl: runtime.boardVolatilitySidecarBaseUrl }),
      window,
      params,
    });
  }
  return await runBoardVolatilityViaSidecar(window, params, runtime);
}

function fireDedupKey(fire: DetectorFire): string {
  return [
    fire.gameId,
    fire.bucketStart.toISOString(),
    fire.bucketEnd.toISOString(),
    fire.lane ?? "",
    fire.sourceMarketId ?? "",
  ].join("|");
}

async function runEnsembleOrDetector(
  window: DetectorWindow,
  params: z.infer<typeof EnsembleOrParams>,
  runtime: BoardVolatilityRuntimeOptions,
): Promise<DetectorResult> {
  const [boardResult, offResult] = await Promise.all([
    runBoardVolatilityDetector(window, params.board, runtime),
    Promise.resolve(offPricePrint.run(window, params.offprice)),
  ]);
  const boardFires = boardResult.fires.map((fire) => ({ ...fire, lane: "board" as const }));
  const offFires = offResult.fires.map((fire) => ({ ...fire, lane: "offprice" as const }));
  const fires = [...boardFires, ...offFires].reduce<DetectorFire[]>((acc, fire) => {
    const key = fireDedupKey(fire);
    if (acc.some((existing) => fireDedupKey(existing) === key)) return acc;
    acc.push(fire);
    return acc;
  }, []);
  const games = uniqueGameIds(window.gameIds).length;
  return {
    buckets: boardResult.buckets,
    fires,
    stats: {
      firesPerGame: games === 0 ? 0 : fires.length / games,
      totalFires: fires.length,
      gamesInWindow: games,
    },
  };
}

// --- window resolution ------------------------------------------------------

interface EffectiveTickWindow {
  readonly start: Date;
  readonly end: Date;
}

// Estimate for a scheduled-fallback game's duration when PBP MAX(time_actual)
// isn't available. NBA regulation is 48 min + halftime + commercial breaks
// (~2h30m wall), plus possible OT(s). 4 hours is the conservative bound that
// covers multi-OT games without pulling in next-day quote traffic. Cache
// identity carries clockSource="scheduled", so the recompute on PBP arrival
// uses the real PBP window and this estimate doesn't outlive the lag period.
const SCHEDULED_GAME_DURATION_MS = 4 * 60 * 60 * 1000;

function resolveEffectiveTickWindow(
  _goldDb: GoldDbHandle,
  _gameId: string,
  scope: RunScope,
  defaults: DetectorDefaults,
  timing: GameTimingContext,
): EffectiveTickWindow | null {
  // Per audit-fix A0-followup #1 (Codex review 2026-05-25): when PBP is
  // missing but scheduled_start exists, do NOT fail closed. Load ticks using
  // the scheduled anchor with a conservative game-duration estimate so live
  // PBP lag and offline backtests over scheduled-only games both produce
  // observations. Cache identity already includes clockSource + tipoffAnchor
  // (computeWatermarkHash), so the cache invalidates and recomputes when real
  // PBP arrives — no stale "scheduled" result lingering after PBP catches up.
  const baseWindow: { start: Date; end: Date } | null = (() => {
    if (timing.clockSource === "pbp" && timing.pbpMinUtc !== null && timing.pbpMaxUtc !== null) {
      return {
        start: new Date(timing.pbpMinUtc.getTime() - defaults.pbpPreBufferMs),
        end: new Date(timing.pbpMaxUtc.getTime() + defaults.pbpPostBufferMs),
      };
    }
    if (timing.clockSource === "scheduled") {
      // PBP missing → scheduled fallback bounds the wall window.
      return {
        start: new Date(timing.scheduledStartUtc.getTime() - defaults.pbpPreBufferMs),
        end: new Date(
          timing.scheduledStartUtc.getTime() +
            SCHEDULED_GAME_DURATION_MS +
            defaults.pbpPostBufferMs,
        ),
      };
    }
    // clockSource === "none" → genuinely no anchor → fail closed (no fake
    // fires). resolveGameTimingContext returns "none" only when both PBP and
    // scheduled are absent.
    return null;
  })();
  if (baseWindow === null) return null;
  if (scope.kind === "game") return baseWindow;
  // Window scope: intersect with requested window.
  const reqStart = new Date(scope.windowStart);
  const reqEnd = new Date(scope.windowEnd);
  const start = baseWindow.start.getTime() > reqStart.getTime() ? baseWindow.start : reqStart;
  const end = baseWindow.end.getTime() < reqEnd.getTime() ? baseWindow.end : reqEnd;
  if (start.getTime() > end.getTime()) return null;
  return { start, end };
}

function scopeGameIds(scope: RunScope): readonly string[] {
  return scope.kind === "game" ? [scope.gameId] : scope.gameIds;
}

function scopeStart(
  scope: RunScope,
  windows: Map<string, EffectiveTickWindow | null>,
  now: Date,
): Date {
  if (scope.kind === "window") return new Date(scope.windowStart);
  const w = windows.get(scope.gameId);
  return w?.start ?? now;
}

function scopeEnd(
  scope: RunScope,
  windows: Map<string, EffectiveTickWindow | null>,
  now: Date,
): Date {
  if (scope.kind === "window") return new Date(scope.windowEnd);
  const w = windows.get(scope.gameId);
  return w?.end ?? now;
}

// --- data loading -----------------------------------------------------------

function loadTicksForGames(
  goldDb: GoldDbHandle,
  gameIds: readonly string[],
  windows: Map<string, EffectiveTickWindow | null>,
): readonly Tick[] {
  return gameIds.flatMap((gameId): readonly Tick[] => {
    const w = windows.get(gameId);
    if (w === undefined || w === null) return [];
    return loadBoardMadTicksForGame(goldDb, gameId, w.start.toISOString(), w.end.toISOString());
  });
}

function loadMicrostructureForScope(
  goldDb: GoldDbHandle,
  scope: RunScope,
  gameIds: readonly string[],
): readonly MicrostructureEvent[] {
  if (scope.kind === "window") {
    return loadMicrostructureForGames(goldDb, gameIds, scope.windowStart, scope.windowEnd);
  }
  // Game scope: load all microstructure events for the game using a wide
  // window. The PBP-derived effective tick window doesn't apply to
  // microstructure-event timestamps directly (those are trade prints, not
  // quote ticks); we still need a window. Use the game's PBP MIN..MAX without
  // buffers since trade prints outside game time are not actionable.
  const pbp = readPbpBounds(goldDb, scope.gameId);
  if (pbp === null) return [];
  return loadMicrostructureForGames(
    goldDb,
    [scope.gameId],
    pbp.minUtc.toISOString(),
    pbp.maxUtc.toISOString(),
  );
}

// --- watermark hash ---------------------------------------------------------

interface WatermarkArgs {
  readonly goldDb: GoldDbHandle;
  readonly scope: RunScope;
  readonly gameIds: readonly string[];
  readonly timingContexts: readonly GameTimingContext[];
  readonly tickWindows: Map<string, EffectiveTickWindow | null>;
  readonly sources: readonly SourceKind[];
  readonly defaults: DetectorDefaults;
  readonly historicalPriors: readonly unknown[];
}

function computeWatermarkHash(args: WatermarkArgs): string {
  const usesTicks = args.sources.includes("ticks");
  const usesMicrostructure = args.sources.includes("microstructure");
  const perGame = args.gameIds.map((gameId) => {
    const tickWindow = usesTicks ? (args.tickWindows.get(gameId) ?? null) : null;
    const timing = args.timingContexts.find((t) => t.gameId === gameId);
    const qt =
      !usesTicks || tickWindow === null
        ? null
        : args.goldDb
            .prepare(
              `SELECT COUNT(*) AS cnt,
                      COALESCE(MAX(qt.id), 0) AS max_id,
                      COALESCE(MAX(qt.captured_at), '') AS max_captured_at
               FROM quote_ticks qt
               JOIN source_markets sm ON sm.id = qt.source_market_id
               WHERE sm.game_id = ?
                 AND qt.captured_at >= ?
                 AND qt.captured_at <= ?`,
            )
            .get(gameId, tickWindow.start.toISOString(), tickWindow.end.toISOString());
    const mmeWindowStart =
      usesMicrostructure && args.scope.kind === "window"
        ? args.scope.windowStart
        : usesMicrostructure
          ? new Date(0).toISOString()
          : null;
    const mmeWindowEnd =
      usesMicrostructure && args.scope.kind === "window"
        ? args.scope.windowEnd
        : usesMicrostructure
          ? new Date(8640000000000000).toISOString()
          : null;
    const mme =
      usesMicrostructure && mmeWindowStart !== null && mmeWindowEnd !== null
        ? args.goldDb
            .prepare(
              `SELECT COUNT(*) AS cnt,
                      COALESCE(MAX(id), 0) AS max_id,
                      COALESCE(MAX(event_timestamp), '') AS max_event_timestamp
               FROM market_microstructure_events
               WHERE game_id = ?
                 AND source = 'polymarket'
                 AND event_type = 'trade'
                 AND event_timestamp >= ?
                 AND event_timestamp <= ?`,
            )
            .get(gameId, mmeWindowStart, mmeWindowEnd)
        : null;
    // off-price-distance is derived from the LATEST prior quote tick (causal
    // subquery in loadMicrostructureForGames). Track upstream quote_ticks
    // state for the source_markets referenced by microstructure events so a
    // cached off-price run invalidates when those priors change.
    const mmeQt =
      usesMicrostructure && mmeWindowStart !== null && mmeWindowEnd !== null
        ? args.goldDb
            .prepare(
              `SELECT COUNT(*) AS cnt,
                      COALESCE(MAX(qt.id), 0) AS max_id,
                      COALESCE(MAX(qt.captured_at), '') AS max_captured_at
               FROM quote_ticks qt
               WHERE qt.captured_at <= ?
                 AND qt.source_market_id IN (
                   SELECT DISTINCT source_market_id
                   FROM market_microstructure_events
                   WHERE game_id = ?
                     AND source = 'polymarket'
                     AND event_type = 'trade'
                     AND event_timestamp >= ?
                     AND event_timestamp <= ?
                 )`,
            )
            .get(mmeWindowEnd, gameId, mmeWindowStart, mmeWindowEnd)
        : null;
    const pbp = readPbpBounds(args.goldDb, gameId);
    return {
      effective_tick_window: tickWindow
        ? { start: tickWindow.start.toISOString(), end: tickWindow.end.toISOString() }
        : null,
      gameId,
      // Per amend-1: clockSource + tipoffAnchorUtc + scheduledStart are in the
      // hash so a `scheduled`-anchored cache row invalidates when PBP arrives.
      game_timing: timing
        ? {
            clockSource: timing.clockSource,
            tipoffAnchorUtc: timing.tipoffAnchorUtc.toISOString(),
            scheduledStartUtc: timing.scheduledStartUtc.toISOString(),
          }
        : null,
      market_microstructure_events:
        mme === null
          ? null
          : {
              cnt: getNumber(mme, "cnt"),
              max_event_timestamp: getString(mme, "max_event_timestamp"),
              max_id: getNumber(mme, "max_id"),
            },
      microstructure_quote_ticks:
        mmeQt === null
          ? null
          : {
              cnt: getNumber(mmeQt, "cnt"),
              max_captured_at: getString(mmeQt, "max_captured_at"),
              max_id: getNumber(mmeQt, "max_id"),
            },
      nba_play_by_play_actions: pbp
        ? {
            max_time_actual: pbp.maxUtc.toISOString(),
            min_time_actual: pbp.minUtc.toISOString(),
          }
        : { max_time_actual: "", min_time_actual: "" },
      quote_ticks: usesTicks
        ? {
            cnt: getNumber(qt, "cnt"),
            max_captured_at: getString(qt, "max_captured_at"),
            max_id: getNumber(qt, "max_id"),
          }
        : null,
    };
  });
  const tuple = {
    board_mad_historical_priors: args.historicalPriors,
    pbpPostBufferMs: usesTicks ? args.defaults.pbpPostBufferMs : null,
    pbpPreBufferMs: usesTicks ? args.defaults.pbpPreBufferMs : null,
    perGame,
    scope_kind: args.scope.kind,
    sources: args.sources,
    window_start: args.scope.kind === "window" ? args.scope.windowStart : null,
    window_end: args.scope.kind === "window" ? args.scope.windowEnd : null,
  };
  return sha256Hex(canonicalJson(tuple));
}

// --- cache layer ------------------------------------------------------------

interface LookupArgs {
  readonly detectorId: DetectorId;
  readonly detectorVersion: string;
  readonly paramsHash: string;
  readonly watermarkHash: string;
  readonly scope: RunScope;
}

interface CacheHit {
  readonly runId: number;
}

function lookupRun(cacheDb: Database.Database, args: LookupArgs): CacheHit | null {
  if (args.scope.kind === "game") {
    const row = cacheDb
      .prepare(
        `SELECT id FROM detector_runs
         WHERE detector_id = ?
           AND detector_version = ?
           AND params_hash = ?
           AND source_watermark_hash = ?
           AND scope = 'game'
           AND game_id = ?
           AND window_start IS NULL
           AND window_end IS NULL
         LIMIT 1`,
      )
      .get(
        args.detectorId,
        args.detectorVersion,
        args.paramsHash,
        args.watermarkHash,
        args.scope.gameId,
      );
    if (!isRecord(row)) return null;
    const id = row["id"];
    return typeof id === "number" ? { runId: id } : null;
  }
  const row = cacheDb
    .prepare(
      `SELECT id FROM detector_runs
       WHERE detector_id = ?
         AND detector_version = ?
         AND params_hash = ?
         AND source_watermark_hash = ?
         AND scope = 'window'
         AND game_id IS NULL
         AND window_start = ?
         AND window_end = ?
       LIMIT 1`,
    )
    .get(
      args.detectorId,
      args.detectorVersion,
      args.paramsHash,
      args.watermarkHash,
      args.scope.windowStart,
      args.scope.windowEnd,
    );
  if (!isRecord(row)) return null;
  const id = row["id"];
  return typeof id === "number" ? { runId: id } : null;
}

interface PersistArgs {
  readonly detectorId: DetectorId;
  readonly detectorVersion: string;
  readonly paramsHash: string;
  readonly paramsJson: string;
  readonly sourceDbPath: string;
  readonly watermarkHash: string;
  readonly computedAt: string;
  readonly computeMs: number;
  readonly scope: RunScope;
  readonly buckets: readonly DetectorBucket[];
  readonly fires: readonly DetectorFire[];
}

function persistRun(cacheDb: Database.Database, args: PersistArgs): number {
  const insertRun = cacheDb.prepare(
    `INSERT OR IGNORE INTO detector_runs (
       detector_id, detector_version, params_hash, params_json,
       source_db_path, source_watermark_hash, scope, game_id,
       window_start, window_end, computed_at, compute_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertObs = cacheDb.prepare(
    `INSERT INTO detector_observations (
       run_id, game_id, bucket_start, bucket_end, fired,
       intensity, baseline_median, baseline_mad, detail_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = cacheDb.transaction((): number => {
    const scopeKind = args.scope.kind;
    const gameIdArg = scopeKind === "game" ? args.scope.gameId : null;
    const windowStartArg = scopeKind === "window" ? args.scope.windowStart : null;
    const windowEndArg = scopeKind === "window" ? args.scope.windowEnd : null;
    const insertResult = insertRun.run(
      args.detectorId,
      args.detectorVersion,
      args.paramsHash,
      args.paramsJson,
      args.sourceDbPath,
      args.watermarkHash,
      scopeKind,
      gameIdArg,
      windowStartArg,
      windowEndArg,
      args.computedAt,
      args.computeMs,
    );
    if (insertResult.changes === 0) {
      const existing = lookupRun(cacheDb, {
        detectorId: args.detectorId,
        detectorVersion: args.detectorVersion,
        paramsHash: args.paramsHash,
        watermarkHash: args.watermarkHash,
        scope: args.scope,
      });
      if (existing === null) {
        throw new Error("detector run insert was ignored but no cache row was found");
      }
      return existing.runId;
    }
    const runId = Number(insertResult.lastInsertRowid);
    // Persist board-style per-bucket observations (warmedUp + fired). Each row
    // carries warmedUp in detail_json so the live chart can render "no active
    // threshold yet" without faking a zero baseline.
    for (const b of args.buckets) {
      const detail: Record<string, boolean | number | string> = {
        warmedUp: b.warmedUp,
        lane: "board",
      };
      if (typeof b.gameElapsedSeconds === "number" && Number.isFinite(b.gameElapsedSeconds)) {
        detail.gameElapsedSeconds = b.gameElapsedSeconds;
      }
      if (typeof b.threshold === "number" && Number.isFinite(b.threshold)) {
        detail.threshold = b.threshold;
      }
      if (
        typeof b.standardizedInnovation === "number" &&
        Number.isFinite(b.standardizedInnovation)
      ) {
        detail.standardizedInnovation = b.standardizedInnovation;
      }
      if (typeof b.regimeScore === "number" && Number.isFinite(b.regimeScore)) {
        detail.regimeScore = b.regimeScore;
      }
      insertObs.run(
        runId,
        b.gameId,
        b.bucketStart.toISOString(),
        b.bucketEnd.toISOString(),
        b.fired ? 1 : 0,
        b.intensity,
        b.baselineMedian,
        b.baselineMad,
        JSON.stringify(detail),
      );
    }
    // Persist non-bucket fires as standalone observations. These are point-in-
    // time tape prints, not aggregates: bucketStart === bucketEnd is the event
    // instant. Two cases produce them, with different fire-tagging conventions
    // upstream:
    //   - ensemble-or: each off-price lane fire is tagged f.lane === "offprice"
    //     by ensemble-or/index.ts:68-71 (board fires are correlated with the
    //     persisted buckets above, so we skip lane === "board" here).
    //   - off-price-print standalone: the detector emits LANE-LESS fires
    //     (off-price-print/index.ts:34-42 doesn't set lane). Without the
    //     detector-context check below, those fires would be silently dropped
    //     from cache, breaking cache-hit parity (Codex review P1, audit-fix
    //     A0-followup #2). Persist them all and tag lane="offprice" so the
    //     splitObservations reload puts them in `fires`, not `buckets`.
    const treatLanelessAsOffprice = args.detectorId === "off-price-print";
    for (const f of args.fires) {
      const isOffprice = f.lane === "offprice" || (treatLanelessAsOffprice && f.lane === undefined);
      if (!isOffprice) continue;
      const detail: Record<string, string> = { lane: "offprice" };
      if (f.sourceMarketId !== undefined) detail.sourceMarketId = f.sourceMarketId;
      insertObs.run(
        runId,
        f.gameId,
        f.bucketStart.toISOString(),
        f.bucketEnd.toISOString(),
        1,
        f.intensity,
        f.baselineMedian,
        f.baselineMad,
        JSON.stringify(detail),
      );
    }
    return runId;
  });
  return tx();
}

interface PersistedObservation {
  readonly gameId: string;
  readonly bucketStart: string;
  readonly bucketEnd: string;
  readonly fired: number;
  readonly intensity: number;
  readonly gameElapsedSeconds?: number | null;
  readonly baselineMedian: number;
  readonly baselineMad: number;
  readonly threshold?: number;
  readonly standardizedInnovation?: number;
  readonly regimeScore?: number;
  readonly lane: "board" | "offprice";
  readonly warmedUp: boolean;
  readonly sourceMarketId?: string;
}

function loadObservations(
  cacheDb: Database.Database,
  runId: number,
): readonly PersistedObservation[] {
  const rows = cacheDb
    .prepare(
      `SELECT game_id, bucket_start, bucket_end, fired, intensity,
              baseline_median, baseline_mad, detail_json
       FROM detector_observations
       WHERE run_id = ?
       ORDER BY game_id, bucket_start`,
    )
    .all(runId);
  return rows.map((row): PersistedObservation => {
    if (!isRecord(row)) throw new Error("observation row not an object");
    const detailJson = row["detail_json"];
    let lane: "board" | "offprice" = "board";
    let warmedUp =
      pickNumber(row, "fired") > 0 ||
      pickNumber(row, "baseline_median") !== 0 ||
      pickNumber(row, "baseline_mad") !== 0;
    let sourceMarketId: string | undefined;
    let gameElapsedSeconds: number | null | undefined;
    let threshold: number | undefined;
    let standardizedInnovation: number | undefined;
    let regimeScore: number | undefined;
    if (typeof detailJson === "string" && detailJson.length > 0) {
      try {
        const parsed: unknown = JSON.parse(detailJson);
        if (isRecord(parsed)) {
          const candidate = parsed["lane"];
          if (candidate === "offprice") lane = "offprice";
          if (typeof parsed["warmedUp"] === "boolean") warmedUp = parsed["warmedUp"];
          const sm = parsed["sourceMarketId"];
          if (typeof sm === "string" && sm.length > 0) sourceMarketId = sm;
          const elapsed = parsed["gameElapsedSeconds"];
          if (typeof elapsed === "number" && Number.isFinite(elapsed)) {
            gameElapsedSeconds = elapsed;
          }
          const parsedThreshold = parsed["threshold"];
          if (typeof parsedThreshold === "number" && Number.isFinite(parsedThreshold)) {
            threshold = parsedThreshold;
          }
          const parsedInnovation = parsed["standardizedInnovation"];
          if (typeof parsedInnovation === "number" && Number.isFinite(parsedInnovation)) {
            standardizedInnovation = parsedInnovation;
          }
          const parsedRegimeScore = parsed["regimeScore"];
          if (typeof parsedRegimeScore === "number" && Number.isFinite(parsedRegimeScore)) {
            regimeScore = parsedRegimeScore;
          }
        }
      } catch {
        // Older cache rows fall back to the derived warmedUp heuristic above.
      }
    }
    return {
      gameId: pickString(row, "game_id"),
      bucketStart: pickString(row, "bucket_start"),
      bucketEnd: pickString(row, "bucket_end"),
      fired: pickNumber(row, "fired"),
      intensity: pickNumber(row, "intensity"),
      ...(gameElapsedSeconds == null ? {} : { gameElapsedSeconds }),
      baselineMedian: pickNumber(row, "baseline_median"),
      baselineMad: pickNumber(row, "baseline_mad"),
      ...(threshold === undefined ? {} : { threshold }),
      ...(standardizedInnovation === undefined ? {} : { standardizedInnovation }),
      ...(regimeScore === undefined ? {} : { regimeScore }),
      lane,
      warmedUp,
      ...(sourceMarketId === undefined ? {} : { sourceMarketId }),
    };
  });
}

function splitObservations(observations: readonly PersistedObservation[]): {
  readonly buckets: readonly DetectorBucket[];
  readonly fires: readonly DetectorFire[];
} {
  const buckets: DetectorBucket[] = [];
  const fires: DetectorFire[] = [];
  for (const o of observations) {
    if (o.lane === "board") {
      buckets.push({
        gameId: o.gameId,
        bucketStart: new Date(o.bucketStart),
        bucketEnd: new Date(o.bucketEnd),
        intensity: o.intensity,
        ...(o.gameElapsedSeconds == null ? {} : { gameElapsedSeconds: o.gameElapsedSeconds }),
        baselineMedian: o.baselineMedian,
        baselineMad: o.baselineMad,
        ...(o.threshold === undefined ? {} : { threshold: o.threshold }),
        ...(o.standardizedInnovation === undefined
          ? {}
          : { standardizedInnovation: o.standardizedInnovation }),
        ...(o.regimeScore === undefined ? {} : { regimeScore: o.regimeScore }),
        warmedUp: o.warmedUp,
        fired: o.fired === 1,
      });
      if (o.fired === 1 && o.warmedUp) {
        fires.push({
          gameId: o.gameId,
          bucketStart: new Date(o.bucketStart),
          bucketEnd: new Date(o.bucketEnd),
          intensity: o.intensity,
          baselineMedian: o.baselineMedian,
          baselineMad: o.baselineMad,
          ...(o.threshold === undefined ? {} : { threshold: o.threshold }),
          ...(o.standardizedInnovation === undefined
            ? {}
            : { standardizedInnovation: o.standardizedInnovation }),
          ...(o.regimeScore === undefined ? {} : { regimeScore: o.regimeScore }),
          lane: "board",
        });
      }
    } else {
      fires.push({
        gameId: o.gameId,
        bucketStart: new Date(o.bucketStart),
        bucketEnd: new Date(o.bucketEnd),
        intensity: o.intensity,
        baselineMedian: o.baselineMedian,
        baselineMad: o.baselineMad,
        lane: "offprice",
        ...(o.sourceMarketId === undefined ? {} : { sourceMarketId: o.sourceMarketId }),
      });
    }
  }
  return { buckets, fires };
}

function buildStats(
  _buckets: readonly DetectorBucket[],
  fires: readonly DetectorFire[],
  gamesInWindow: number,
): DetectorStats {
  return {
    firesPerGame: gamesInWindow === 0 ? 0 : fires.length / gamesInWindow,
    totalFires: fires.length,
    gamesInWindow,
  };
}

function emptyResult(
  detectorId: DetectorId,
  detectorVersion: string,
  paramsHash: string,
  resolvedParams: unknown,
): RunResult {
  return {
    runId: -1,
    detectorId,
    detectorVersion,
    paramsHash,
    resolvedParams,
    buckets: [],
    fires: [],
    stats: { firesPerGame: 0, totalFires: 0, gamesInWindow: 0 },
    timingContexts: [],
  };
}

// --- shared SQL helpers -----------------------------------------------------

function readPbpBounds(
  goldDb: GoldDbHandle,
  gameId: string,
): { readonly minUtc: Date; readonly maxUtc: Date } | null {
  let row: unknown;
  try {
    row = goldDb
      .prepare(
        `SELECT MIN(time_actual) AS lo, MAX(time_actual) AS hi
         FROM nba_play_by_play_actions
         WHERE game_id = ?`,
      )
      .get(gameId);
  } catch {
    return null;
  }
  if (!isRecord(row)) return null;
  const lo = row["lo"];
  const hi = row["hi"];
  if (typeof lo !== "string" || typeof hi !== "string") return null;
  const loMs = Date.parse(lo);
  const hiMs = Date.parse(hi);
  if (!Number.isFinite(loMs) || !Number.isFinite(hiMs)) return null;
  return { minUtc: new Date(loMs), maxUtc: new Date(hiMs) };
}

function readScheduledStart(goldDb: GoldDbHandle, gameId: string): Date | null {
  let row: unknown;
  try {
    row = goldDb.prepare(`SELECT scheduled_start FROM games WHERE id = ? LIMIT 1`).get(gameId);
  } catch {
    return null;
  }
  if (!isRecord(row)) return null;
  const v = row["scheduled_start"];
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
}

// --- pure helpers -----------------------------------------------------------

function uniqueGameIds(gameIds: readonly string[]): readonly string[] {
  return Array.from(
    new Set(gameIds.map((id) => id.trim()).filter((id) => id.length > 0)),
  ).toSorted();
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  if (value === undefined) return "null";
  throw new Error(`canonicalJson: unsupported value type ${typeof value}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pickString(rec: Record<string, unknown>, key: string): string {
  const v = rec[key];
  if (typeof v !== "string") throw new Error(`field ${key}: expected string`);
  return v;
}

function pickNumber(rec: Record<string, unknown>, key: string): number {
  const v = rec[key];
  if (typeof v !== "number") throw new Error(`field ${key}: expected number`);
  return v;
}

function getString(row: unknown, key: string): string {
  if (!isRecord(row)) return "";
  const v = row[key];
  return typeof v === "string" ? v : "";
}

function getNumber(row: unknown, key: string): number {
  if (!isRecord(row)) return 0;
  const v = row[key];
  return typeof v === "number" ? v : 0;
}
