// Backtest service (US-034, PRD §15 / §9).
//
// Backs POST /v1/backtest. Runs a detector over (window, games, params) with
// window-scope cache lookup.
//
// AMENDED 2026-05-24 (phase A0c): now a thin wrapper around the shared
// detector runner (services/detector-runner.ts). Live (board.ts) and Backtest
// share one execution path so they cannot drift in params, loading, priors,
// timing, or cache identity. This file owns: per-request timestamp
// canonicalization, BacktestResult API shape mapping, error-code translation
// from RunnerError to BacktestError, and the no-game discovery helper used by
// the route when game_ids is omitted.

import { openGoldDb, v_games } from "@signal-console/db";

import { runDetector, RunnerError, type BoardVolatilityRunner } from "./detector-runner";
import { parseStrictIsoTimestamp } from "./timestamps";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export interface BacktestObservation {
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
  // Set by composite detectors (ensemble-or) so the UI can render board fires
  // and off-price-print fires differently. Single-lane runs leave it undefined.
  readonly lane?: "board" | "offprice";
  // Event-lane discriminator. Off-price prints can share the same timestamp but
  // still be distinct market events.
  readonly sourceMarketId?: string;
}

export interface BacktestStats {
  readonly firesPerGame: number;
  readonly totalFires: number;
  readonly gamesInWindow: number;
}

export interface BacktestResult {
  readonly runId: number;
  readonly stats: BacktestStats;
  readonly observations: readonly BacktestObservation[];
}

export interface RunBacktestArgs {
  readonly goldDbPath: string;
  readonly cacheDbPath: string;
  readonly detectorId: string;
  readonly params: unknown;
  readonly boardVolatilityFetchImpl?: typeof fetch;
  readonly boardVolatilityRunner?: BoardVolatilityRunner;
  readonly boardVolatilitySidecarBaseUrl?: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly gameIds: readonly string[];
  readonly now?: Date;
}

export class BacktestError extends Error {
  public readonly code: "unknown_detector" | "invalid_params";
  public constructor(code: "unknown_detector" | "invalid_params", message: string) {
    super(message);
    this.code = code;
  }
}

function canonicalTimestamp(input: string): string {
  const ms = parseStrictIsoTimestamp(input, { requireExplicitTimezone: true });
  if (ms === null) {
    throw new BacktestError("invalid_params", `invalid window timestamp: ${input}`);
  }
  return new Date(ms).toISOString();
}

function assertKnownDetectorId(
  id: string,
): asserts id is "board-mad" | "off-price-print" | "ensemble-or" {
  if (id !== "board-mad" && id !== "off-price-print" && id !== "ensemble-or") {
    throw new BacktestError("unknown_detector", `unknown detector: ${id}`);
  }
}

export async function runBacktest(args: RunBacktestArgs): Promise<BacktestResult> {
  assertKnownDetectorId(args.detectorId);
  const sortedGameIds = Array.from(
    new Set(args.gameIds.map((id) => id.trim()).filter((id) => id.length > 0)),
  ).toSorted();
  const windowStart = canonicalTimestamp(args.windowStart);
  const windowEnd = canonicalTimestamp(args.windowEnd);

  let result;
  try {
    result = await runDetector({
      detectorId: args.detectorId,
      params: args.params,
      scope: {
        kind: "window",
        windowStart,
        windowEnd,
        gameIds: sortedGameIds,
      },
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
  } catch (err) {
    if (err instanceof RunnerError) {
      if (err.code === "unknown_detector" || err.code === "invalid_params") {
        throw new BacktestError(err.code, err.message);
      }
      // "no_games" is not externally surfaced as a backtest error; surface as
      // an empty-shape result to match the prior contract for empty inputs.
    }
    throw err;
  }

  // Map RunResult (buckets + lane-tagged fires) into the BacktestObservation
  // shape the route expects. Board buckets become one observation each;
  // offprice fires become point-event observations (bucketStart==bucketEnd).
  const observations: BacktestObservation[] = [];
  for (const b of result.buckets) {
    observations.push({
      gameId: b.gameId,
      bucketStart: b.bucketStart.toISOString(),
      bucketEnd: b.bucketEnd.toISOString(),
      fired: b.fired ? 1 : 0,
      intensity: b.intensity,
      ...(b.gameElapsedSeconds == null ? {} : { gameElapsedSeconds: b.gameElapsedSeconds }),
      baselineMedian: b.baselineMedian,
      baselineMad: b.baselineMad,
      ...(b.threshold === undefined ? {} : { threshold: b.threshold }),
      ...(b.standardizedInnovation === undefined
        ? {}
        : { standardizedInnovation: b.standardizedInnovation }),
      ...(b.regimeScore === undefined ? {} : { regimeScore: b.regimeScore }),
      lane: "board",
    });
  }
  for (const f of result.fires) {
    if (f.lane === "offprice") {
      observations.push({
        gameId: f.gameId,
        bucketStart: f.bucketStart.toISOString(),
        bucketEnd: f.bucketEnd.toISOString(),
        fired: 1,
        intensity: f.intensity,
        baselineMedian: f.baselineMedian,
        baselineMad: f.baselineMad,
        lane: "offprice",
        ...(f.sourceMarketId === undefined ? {} : { sourceMarketId: f.sourceMarketId }),
      });
    }
  }
  // When running off-price-print standalone (no board buckets), the result has
  // empty buckets and lane-less fires (off-price-print/index.ts:34-42 doesn't
  // set lane). Surface those as bucketless observations matching the prior
  // contract from buildObservationsFromResult.
  if (result.buckets.length === 0) {
    for (const f of result.fires) {
      if (f.lane !== "offprice") {
        observations.push({
          gameId: f.gameId,
          bucketStart: f.bucketStart.toISOString(),
          bucketEnd: f.bucketEnd.toISOString(),
          fired: 1,
          intensity: f.intensity,
          baselineMedian: f.baselineMedian,
          baselineMad: f.baselineMad,
          ...(f.lane === undefined ? {} : { lane: f.lane }),
          ...(f.sourceMarketId === undefined ? {} : { sourceMarketId: f.sourceMarketId }),
        });
      }
    }
  }

  return {
    runId: result.runId,
    stats: buildStats(observations, sortedGameIds.length),
    observations,
  };
}

function buildStats(
  observations: readonly BacktestObservation[],
  gamesInWindow: number,
): BacktestStats {
  const totalFires = observations.reduce((acc, o) => acc + (o.fired === 1 ? 1 : 0), 0);
  return {
    firesPerGame: gamesInWindow === 0 ? 0 : totalFires / gamesInWindow,
    totalFires,
    gamesInWindow,
  };
}

// Game discovery for the no-game_ids path. Returns up to `limit` games whose
// scheduled_start falls in [windowStart, windowEnd], sorted oldest-first so
// the truncated set is deterministic when the window has more than `limit`
// games. Caller is expected to enforce the count cap (400 if too many).
// Lives here (not in the runner) because it's a pre-runner upstream concern:
// the route uses it to fill in gameIds before calling runBacktest.
export function discoverGameIdsInWindow(
  goldDbPath: string,
  windowStart: string,
  windowEnd: string,
  limit: number,
): readonly string[] {
  const goldDb = openGoldDb(goldDbPath);
  try {
    const rows = goldDb
      .prepare(
        `WITH v_games AS (${v_games})
         SELECT id FROM v_games
         WHERE scheduled_start >= ? AND scheduled_start <= ?
         ORDER BY scheduled_start ASC
         LIMIT ?`,
      )
      .all(windowStart, windowEnd, limit);
    return rows.map((row): string => {
      if (!isRecord(row)) throw new Error("game discovery row not an object");
      const id = row["id"];
      if (typeof id !== "string") throw new Error("game discovery row missing id");
      return id;
    });
  } finally {
    goldDb.close();
  }
}
