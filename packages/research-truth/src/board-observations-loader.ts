// LIVE per-game board-observation builder for the quant-lab snapshot exporter.
//
// This module reproduces the LIVE board lane's path to
// buildBoardVolatilityModelRequest so the snapshot's board_observations rows
// match what the live board lane (apps/api/src/services/detector-runner.ts ->
// runBoardVolatilityViaSidecar) sees: per-game timing context, the effective
// PBP/scheduled tick window, the board-mad tick loader (with per-tick
// gameElapsedSeconds derived from PBP period/clock), then the SHARED
// buildBoardVolatilityModelRequest which INCLUDES sourceDisagreement +
// sourceDominance.
//
// The DB helpers below are ported (not byte-shared) from
// apps/api/src/services/detector-runner.ts (resolveGameTimingContext,
// resolveEffectiveTickWindow game-scope branch, readPbpBounds,
// readScheduledStart) and apps/api/src/services/board-mad-context.ts
// (loadBoardMadTicksForGame, nbaGameElapsedSeconds, parseNbaClockSecondsRemaining,
// rowToTick, column-probe helpers) so the exporter can run from scripts/ without
// dragging the Fastify app into the script typecheck. The SQL is verbatim.

import type { GameTimingContext, Tick } from "@signal-console/detectors";
import { BOARD_STATE_SPACE_CONFIG_DEFAULTS } from "@signal-console/detectors/board-mad/state-space-config";
import type { VolatilityStateSpaceRequest } from "@signal-console/detectors/board-mad/state-space-runtime";

import { buildBoardVolatilityModelRequest } from "./board-volatility-model";
import { openGoldDb } from "@signal-console/db";

type GoldDbHandle = ReturnType<typeof openGoldDb>;

// Live runtime board-mad defaults that shape the observation rows. The
// observation ROW values depend ONLY on bucketSeconds / freshCapSeconds /
// weighting / timingContext (params.kMad/stateSpace pass through unused into the
// returned request). These mirror the BASELINE detector-defaults
// (packages/detectors/src/board-mad/config.ts) that the live lane resolves via
// readDetectorDefaults().
export interface LiveBoardObservationConfig {
  readonly bucketSeconds: number;
  readonly freshCapSeconds: number;
  readonly weighting: "equal" | "volume";
  readonly pbpPreBufferMs: number;
  readonly pbpPostBufferMs: number;
}

// Sources that are eligible to populate snapshot board_observations. "nba" is
// the PBP/play feed (not a market source) so it never contributes ticks; the
// market sources are the selected-bookmaker spine that lands in the gold DB.
export const SNAPSHOT_ELIGIBLE_SOURCES: ReadonlySet<string> = new Set([
  "kalshi",
  "polymarket",
  "bet365",
  "nba",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickString(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  if (typeof v !== "string") throw new Error(`expected string column ${key}`);
  return v;
}

function pickNumber(row: Record<string, unknown>, key: string): number {
  const v = row[key];
  if (typeof v !== "number") return 0;
  return Number.isFinite(v) ? v : 0;
}

export function parseNbaClockSecondsRemaining(clock: string | null | undefined): number | null {
  if (clock == null || clock.trim() === "") return null;
  const iso = /^PT(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(clock.trim());
  if (iso !== null) {
    const minutes = Number.parseFloat(iso[1] ?? "0");
    const seconds = Number.parseFloat(iso[2] ?? "0");
    const total = minutes * 60 + seconds;
    return Number.isFinite(total) ? total : null;
  }
  const mmss = /^(\d{1,2}):(\d{2})(?:\.\d+)?$/.exec(clock.trim());
  if (mmss !== null) {
    const minutes = Number.parseInt(mmss[1] ?? "0", 10);
    const seconds = Number.parseInt(mmss[2] ?? "0", 10);
    const total = minutes * 60 + seconds;
    return Number.isFinite(total) ? total : null;
  }
  return null;
}

export function nbaGameElapsedSeconds(
  period: number | null | undefined,
  clock: string | null | undefined,
): number | null {
  if (!Number.isFinite(period) || period == null || period < 1) return null;
  const remaining = parseNbaClockSecondsRemaining(clock);
  if (remaining === null) return null;
  const completedRegulationPeriods = Math.min(period - 1, 4);
  const completedOvertimePeriods = Math.max(0, period - 5);
  const currentPeriodLength = period <= 4 ? 12 * 60 : 5 * 60;
  return (
    completedRegulationPeriods * 12 * 60 +
    completedOvertimePeriods * 5 * 60 +
    Math.max(0, currentPeriodLength - remaining)
  );
}

function pbpHasGameClockColumns(goldDb: GoldDbHandle): boolean {
  try {
    const rows = goldDb.prepare("PRAGMA table_info(nba_play_by_play_actions)").all();
    const names = new Set(
      rows.flatMap((row): readonly string[] => {
        if (!isRecord(row)) return [];
        const name = row["name"];
        return typeof name === "string" ? [name] : [];
      }),
    );
    return names.has("period") && names.has("clock");
  } catch {
    return false;
  }
}

function sourceMarketsHaveSourceColumn(goldDb: GoldDbHandle): boolean {
  try {
    const rows = goldDb.prepare("PRAGMA table_info(source_markets)").all();
    const names = new Set(
      rows.flatMap((row): readonly string[] => {
        if (!isRecord(row)) return [];
        const name = row["name"];
        return typeof name === "string" ? [name] : [];
      }),
    );
    return names.has("source");
  } catch {
    return false;
  }
}

function rowToTick(row: unknown): Tick {
  if (!isRecord(row)) throw new Error("tick row not an object");
  const ip = row["implied_probability"];
  const period = row["game_period"];
  return {
    gameId: pickString(row, "game_id"),
    sourceMarketId: pickString(row, "source_market_id"),
    ...(typeof row["source"] === "string" ? { source: row["source"] } : {}),
    capturedAt: new Date(pickString(row, "captured_at")),
    impliedProbability: ip === null ? null : typeof ip === "number" ? ip : null,
    volume: pickNumber(row, "volume"),
    isHeartbeat: pickNumber(row, "is_heartbeat") === 1,
    gameElapsedSeconds: nbaGameElapsedSeconds(
      typeof period === "number" ? period : null,
      typeof row["game_clock"] === "string" ? row["game_clock"] : null,
    ),
  };
}

// Verbatim port of apps/api board-mad-context loadBoardMadTicksForGame.
export function loadBoardMadTicksForGame(
  goldDb: GoldDbHandle,
  gameId: string,
  start: string,
  end: string,
): readonly Tick[] {
  const clockColumns = pbpHasGameClockColumns(goldDb);
  const sourceColumn = sourceMarketsHaveSourceColumn(goldDb)
    ? "sm.source AS source"
    : "NULL AS source";
  const rows = goldDb
    .prepare(
      clockColumns
        ? `SELECT sm.game_id AS game_id,
                  ${sourceColumn},
                  qt.source_market_id AS source_market_id,
                  qt.captured_at AS captured_at,
                  qt.implied_probability AS implied_probability,
                  COALESCE(qt.volume, 0) AS volume,
                  qt.is_heartbeat AS is_heartbeat,
                  (
                    SELECT pbp.period
                    FROM nba_play_by_play_actions pbp
                    WHERE pbp.game_id = sm.game_id
                      AND pbp.time_actual <= qt.captured_at
                      AND pbp.period IS NOT NULL
                      AND pbp.clock IS NOT NULL
                    ORDER BY pbp.time_actual DESC
                    LIMIT 1
                  ) AS game_period,
                  (
                    SELECT pbp.clock
                    FROM nba_play_by_play_actions pbp
                    WHERE pbp.game_id = sm.game_id
                      AND pbp.time_actual <= qt.captured_at
                      AND pbp.period IS NOT NULL
                      AND pbp.clock IS NOT NULL
                    ORDER BY pbp.time_actual DESC
                    LIMIT 1
                  ) AS game_clock
           FROM quote_ticks qt
           JOIN source_markets sm ON sm.id = qt.source_market_id
           WHERE sm.game_id = ?
             AND qt.captured_at >= ?
             AND qt.captured_at <= ?
           ORDER BY qt.source_market_id, qt.captured_at`
        : `SELECT sm.game_id AS game_id,
                  ${sourceColumn},
                  qt.source_market_id AS source_market_id,
                  qt.captured_at AS captured_at,
                  qt.implied_probability AS implied_probability,
                  COALESCE(qt.volume, 0) AS volume,
                  qt.is_heartbeat AS is_heartbeat,
                  NULL AS game_period,
                  NULL AS game_clock
           FROM quote_ticks qt
           JOIN source_markets sm ON sm.id = qt.source_market_id
           WHERE sm.game_id = ?
             AND qt.captured_at >= ?
             AND qt.captured_at <= ?
           ORDER BY qt.source_market_id, qt.captured_at`,
    )
    .all(gameId, start, end);
  return rows.map(rowToTick);
}

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

// Verbatim port of apps/api detector-runner resolveGameTimingContext.
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
  return {
    gameId,
    scheduledStartUtc: new Date(0),
    tipoffAnchorUtc: new Date(0),
    clockSource: "none",
    pbpMinUtc: null,
    pbpMaxUtc: null,
  };
}

const SCHEDULED_GAME_DURATION_MS = 4 * 60 * 60 * 1000;

// Game-scope branch of apps/api detector-runner resolveEffectiveTickWindow.
export function resolveEffectiveTickWindow(
  timing: GameTimingContext,
  config: Pick<LiveBoardObservationConfig, "pbpPreBufferMs" | "pbpPostBufferMs">,
): { readonly start: Date; readonly end: Date } | null {
  if (timing.clockSource === "pbp" && timing.pbpMinUtc !== null && timing.pbpMaxUtc !== null) {
    return {
      start: new Date(timing.pbpMinUtc.getTime() - config.pbpPreBufferMs),
      end: new Date(timing.pbpMaxUtc.getTime() + config.pbpPostBufferMs),
    };
  }
  if (timing.clockSource === "scheduled") {
    return {
      start: new Date(timing.scheduledStartUtc.getTime() - config.pbpPreBufferMs),
      end: new Date(
        timing.scheduledStartUtc.getTime() + SCHEDULED_GAME_DURATION_MS + config.pbpPostBufferMs,
      ),
    };
  }
  return null;
}

export interface BoardObservationGameResult {
  readonly gameId: string;
  readonly clockSource: GameTimingContext["clockSource"];
  readonly tickCount: number;
  readonly eligibleTickCount: number;
  readonly request: VolatilityStateSpaceRequest | null;
}

// Build the LIVE board volatility request for one game, restricted to the
// snapshot-eligible source set. Returns the request (observations carry
// sourceDisagreement + sourceDominance) plus diagnostics. request is null when
// the game has no usable timing anchor (clockSource "none").
export function buildLiveBoardObservationsForGame(
  goldDb: GoldDbHandle,
  gameId: string,
  config: LiveBoardObservationConfig,
): BoardObservationGameResult {
  const timing = resolveGameTimingContext(goldDb, gameId);
  const window = resolveEffectiveTickWindow(timing, config);
  if (window === null) {
    return {
      gameId,
      clockSource: timing.clockSource,
      tickCount: 0,
      eligibleTickCount: 0,
      request: null,
    };
  }
  const ticks = loadBoardMadTicksForGame(
    goldDb,
    gameId,
    window.start.toISOString(),
    window.end.toISOString(),
  );
  const eligibleTicks = ticks.filter(
    (tick) => tick.source === undefined || SNAPSHOT_ELIGIBLE_SOURCES.has(tick.source),
  );
  const request = buildBoardVolatilityModelRequest({
    bucketSeconds: config.bucketSeconds,
    freshCapSeconds: config.freshCapSeconds,
    gameId,
    // params only passes through into the returned request; the observation
    // ROWS depend solely on bucketSeconds / freshCapSeconds / weighting /
    // timingContext. stateSpace is the live BoardStateSpaceConfig shape — we
    // don't run the sidecar here, so the baseline live config defaults stand in.
    params: {
      baselineMode: "trailing",
      bucketSeconds: config.bucketSeconds,
      kMad: 3,
      stateSpace: BOARD_STATE_SPACE_CONFIG_DEFAULTS,
      trailingBuckets: 1,
      warmupBuckets: 0,
    },
    ticks: eligibleTicks,
    timingContext: timing,
    weighting: config.weighting,
  });
  return {
    gameId,
    clockSource: timing.clockSource,
    tickCount: ticks.length,
    eligibleTickCount: eligibleTicks.length,
    request,
  };
}
