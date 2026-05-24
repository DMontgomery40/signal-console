// Board service (US-021, PRD §15 / §9).
//
// Backs GET /v1/board/:gameId. Always computes at the live default kMad
// (K_MAD_LIVE) — no K override; Backtest is the override surface.
//
// Cache semantics (PRD §9 freshness model):
//   1. Resolve the same PBP-anchored in-play window the detector will read.
//   2. Compute the per-game source watermark from that effective tick window
//      and quote_ticks in that window.
//   3. Look up detector_runs by (detector_id, detector_version, params_hash,
//      source_watermark_hash, scope='game', game_id).
//   4. Cache hit: SELECT detector_observations for the matched run_id.
//   5. Cache miss: resolve the in-play window (PBP MIN/MAX(time_actual) with
//      a 5-min pre-buffer + 1-min post-buffer; fallback to the game's entire
//      quote_ticks captured_at range when PBP is empty), load ticks for the
//      window, run board-mad, INSERT detector_runs + detector_observations in
//      a single transaction.
//
// Observations are emitted with date fields as ISO strings (not Date objects)
// so the cache-hit and cache-miss code paths return byte-identical payloads:
// the warm path reads TEXT directly from SQLite, and the cold path normalizes
// detector Date outputs to .toISOString() before persisting + returning.

import { createHash } from "node:crypto";

import { openGoldDb } from "@signal-console/db";
import { openCacheDb } from "@signal-console/db";
import {
  detector as boardMad,
  Params as BoardMadParams,
} from "@signal-console/detectors/board-mad";
import type { Tick } from "@signal-console/detectors";
import Database from "better-sqlite3";

import { boardMadDetectorVersion, readDetectorDefaults } from "./detector-defaults";

type GoldDbHandle = ReturnType<typeof openGoldDb>;

export interface BoardObservation {
  readonly bucketStart: string;
  readonly bucketEnd: string;
  readonly fired: number;
  readonly intensity: number;
  readonly baselineMedian: number;
  readonly baselineMad: number;
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
  readonly now?: Date;
}

const DETECTOR_ID = boardMad.id;

export function getOrComputeBoard(args: GetOrComputeBoardArgs): BoardResult {
  const now = args.now ?? new Date();
  const defaults = readDetectorDefaults();
  const detectorVersion = boardMadDetectorVersion(defaults);
  const resolvedParams = BoardMadParams.parse({
    kMad: defaults.kMadLive,
    trailingBuckets: defaults.trailingBuckets,
    warmupBuckets: defaults.warmupBuckets,
    freshCapSeconds: defaults.freshCapSeconds,
  });
  const paramsJson = canonicalJson(resolvedParams);
  const paramsHash = sha256Hex(paramsJson);
  const kValue = resolvedParams.kMad;
  const pbpPreMs = defaults.pbpPreBufferMs;
  const pbpPostMs = defaults.pbpPostBufferMs;

  const cacheDb = openCacheDb(args.cacheDbPath);
  try {
    const goldDb = openGoldDb(args.goldDbPath);
    try {
      const window = resolveInPlayWindow(goldDb, args.gameId, pbpPreMs, pbpPostMs);
      const watermarkHash = computeGameWatermarkHash(goldDb, args.gameId, window);
      const hit = lookupRun(cacheDb, {
        detectorVersion,
        paramsHash,
        gameId: args.gameId,
        watermarkHash,
      });
      if (hit !== null) {
        return {
          gameId: args.gameId,
          runId: hit.runId,
          k: kValue,
          observations: loadObservations(cacheDb, hit.runId),
        };
      }
      const startNs = process.hrtime.bigint();
      const ticks: readonly Tick[] =
        window === null ? [] : loadTicks(goldDb, args.gameId, window.start, window.end);
      const result = boardMad.run(
        { gameIds: [args.gameId], start: window?.start ?? now, end: window?.end ?? now, ticks },
        resolvedParams,
      );
      const computeMs = Number((process.hrtime.bigint() - startNs) / 1_000_000n);
      // Persist ALL bucket observations (fired + non-fired) so US-047's
      // past-alerts drilldown can render the surrounding context of any fire.
      // Pre-US-047 cached runs only stored fired=1; clearing the cache once
      // (DELETE /v1/cache) recomputes from the same gold-DB state.
      const observations: readonly BoardObservation[] = result.buckets.map(
        (b): BoardObservation => ({
          bucketStart: b.bucketStart.toISOString(),
          bucketEnd: b.bucketEnd.toISOString(),
          fired: b.fired ? 1 : 0,
          intensity: b.intensity,
          baselineMedian: b.baselineMedian,
          baselineMad: b.baselineMad,
        }),
      );
      const runId = persistRun(cacheDb, {
        detectorVersion,
        paramsJson,
        paramsHash,
        gameId: args.gameId,
        sourceDbPath: args.goldDbPath,
        watermarkHash,
        computedAt: now.toISOString(),
        computeMs,
        observations,
      });
      return { gameId: args.gameId, runId, k: kValue, observations };
    } finally {
      goldDb.close();
    }
  } finally {
    cacheDb.close();
  }
}

interface CacheHit {
  readonly runId: number;
}

interface LookupArgs {
  readonly detectorVersion: string;
  readonly paramsHash: string;
  readonly gameId: string;
  readonly watermarkHash: string;
}

function lookupRun(cacheDb: Database.Database, args: LookupArgs): CacheHit | null {
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
    .get(DETECTOR_ID, args.detectorVersion, args.paramsHash, args.watermarkHash, args.gameId);
  if (!isRecord(row)) return null;
  const id = row["id"];
  if (typeof id !== "number") return null;
  return { runId: id };
}

function loadObservations(cacheDb: Database.Database, runId: number): readonly BoardObservation[] {
  const rows = cacheDb
    .prepare(
      `SELECT bucket_start, bucket_end, fired, intensity, baseline_median, baseline_mad
       FROM detector_observations
       WHERE run_id = ?
       ORDER BY bucket_start`,
    )
    .all(runId);
  return rows.map((row): BoardObservation => {
    if (!isRecord(row)) throw new Error("observation row not an object");
    return {
      bucketStart: pickString(row, "bucket_start"),
      bucketEnd: pickString(row, "bucket_end"),
      fired: pickNumber(row, "fired"),
      intensity: pickNumber(row, "intensity"),
      baselineMedian: pickNumber(row, "baseline_median"),
      baselineMad: pickNumber(row, "baseline_mad"),
    };
  });
}

interface PersistArgs {
  readonly detectorVersion: string;
  readonly paramsJson: string;
  readonly paramsHash: string;
  readonly gameId: string;
  readonly sourceDbPath: string;
  readonly watermarkHash: string;
  readonly computedAt: string;
  readonly computeMs: number;
  readonly observations: readonly BoardObservation[];
}

function persistRun(cacheDb: Database.Database, args: PersistArgs): number {
  const insertRun = cacheDb.prepare(
    `INSERT OR IGNORE INTO detector_runs (
       detector_id, detector_version, params_hash, params_json,
       source_db_path, source_watermark_hash, scope, game_id,
       window_start, window_end, computed_at, compute_ms
     ) VALUES (?, ?, ?, ?, ?, ?, 'game', ?, NULL, NULL, ?, ?)`,
  );
  const insertObs = cacheDb.prepare(
    `INSERT INTO detector_observations (
       run_id, game_id, bucket_start, bucket_end, fired,
       intensity, baseline_median, baseline_mad, detail_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  );
  const tx = cacheDb.transaction((): number => {
    const result = insertRun.run(
      DETECTOR_ID,
      args.detectorVersion,
      args.paramsHash,
      args.paramsJson,
      args.sourceDbPath,
      args.watermarkHash,
      args.gameId,
      args.computedAt,
      args.computeMs,
    );
    if (result.changes === 0) {
      const existing = lookupRun(cacheDb, {
        detectorVersion: args.detectorVersion,
        gameId: args.gameId,
        paramsHash: args.paramsHash,
        watermarkHash: args.watermarkHash,
      });
      if (existing === null) {
        throw new Error("detector run insert was ignored but no cache row was found");
      }
      return existing.runId;
    }
    const runId = Number(result.lastInsertRowid);
    for (const obs of args.observations) {
      insertObs.run(
        runId,
        args.gameId,
        obs.bucketStart,
        obs.bucketEnd,
        obs.fired,
        obs.intensity,
        obs.baselineMedian,
        obs.baselineMad,
      );
    }
    return runId;
  });
  return tx();
}

interface InPlayWindow {
  readonly start: Date;
  readonly end: Date;
}

function resolveInPlayWindow(
  goldDb: GoldDbHandle,
  gameId: string,
  pbpPreBufferMs: number,
  pbpPostBufferMs: number,
): InPlayWindow | null {
  // Primary path: PBP MIN/MAX(time_actual). Pre-buffer seeds the warmup
  // trailing baseline; post-buffer captures the watcher confirmation tail.
  let pbp: unknown;
  try {
    pbp = goldDb
      .prepare(
        `SELECT MIN(time_actual) AS lo, MAX(time_actual) AS hi
         FROM nba_play_by_play_actions
         WHERE game_id = ?`,
      )
      .get(gameId);
  } catch {
    pbp = null;
  }
  if (isRecord(pbp)) {
    const lo = pbp["lo"];
    const hi = pbp["hi"];
    if (typeof lo === "string" && typeof hi === "string") {
      const loMs = Date.parse(lo);
      const hiMs = Date.parse(hi);
      if (Number.isFinite(loMs) && Number.isFinite(hiMs)) {
        return {
          start: new Date(loMs - pbpPreBufferMs),
          end: new Date(hiMs + pbpPostBufferMs),
        };
      }
    }
  }
  // Fallback: entire quote_ticks captured_at range for the game.
  // Last-ditch for games with neither PBP nor scheduled_start. Wide window
  // (~25h) but bounded to this game's actual data extent. If quote_ticks
  // is also empty, return null and the caller persists an empty-observations
  // run so the next call hits cache.
  const qt = goldDb
    .prepare(
      `SELECT MIN(qt.captured_at) AS lo, MAX(qt.captured_at) AS hi
       FROM quote_ticks qt
       JOIN source_markets sm ON sm.id = qt.source_market_id
       WHERE sm.game_id = ?`,
    )
    .get(gameId);
  if (!isRecord(qt)) return null;
  const lo = qt["lo"];
  const hi = qt["hi"];
  if (typeof lo !== "string" || typeof hi !== "string") return null;
  return { start: new Date(lo), end: new Date(hi) };
}

function loadTicks(goldDb: GoldDbHandle, gameId: string, start: Date, end: Date): readonly Tick[] {
  const rows = goldDb
    .prepare(
      `SELECT qt.source_market_id AS source_market_id,
              qt.captured_at AS captured_at,
              qt.implied_probability AS implied_probability,
              COALESCE(qt.volume, 0) AS volume,
              qt.is_heartbeat AS is_heartbeat
       FROM quote_ticks qt
       JOIN source_markets sm ON sm.id = qt.source_market_id
       WHERE sm.game_id = ?
         AND qt.captured_at >= ?
         AND qt.captured_at <= ?
       ORDER BY qt.source_market_id, qt.captured_at`,
    )
    .all(gameId, start.toISOString(), end.toISOString());
  return rows.map((row): Tick => {
    if (!isRecord(row)) throw new Error("tick row not an object");
    const ip = row["implied_probability"];
    return {
      gameId,
      sourceMarketId: pickString(row, "source_market_id"),
      capturedAt: new Date(pickString(row, "captured_at")),
      impliedProbability: ip === null ? null : typeof ip === "number" ? ip : null,
      volume: pickNumber(row, "volume"),
      isHeartbeat: pickNumber(row, "is_heartbeat") === 1,
    };
  });
}

function computeGameWatermarkHash(
  goldDb: GoldDbHandle,
  gameId: string,
  tickWindow: InPlayWindow | null,
): string {
  const qt =
    tickWindow === null
      ? null
      : goldDb
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
  const pbp = readPbpBounds(goldDb, gameId);
  const tuple = {
    in_play_window:
      tickWindow === null
        ? null
        : { end: tickWindow.end.toISOString(), start: tickWindow.start.toISOString() },
    nba_play_by_play_actions: {
      max_time_actual: getString(pbp, "max_time_actual"),
      min_time_actual: getString(pbp, "min_time_actual"),
    },
    quote_ticks: {
      cnt: getNumber(qt, "cnt"),
      max_captured_at: getString(qt, "max_captured_at"),
      max_id: getNumber(qt, "max_id"),
    },
  };
  return sha256Hex(canonicalJson(tuple));
}

function readPbpBounds(
  goldDb: GoldDbHandle,
  gameId: string,
): { readonly max_time_actual: string; readonly min_time_actual: string } {
  let row: unknown;
  try {
    row = goldDb
      .prepare(
        `SELECT COALESCE(MIN(time_actual), '') AS min_time_actual,
                COALESCE(MAX(time_actual), '') AS max_time_actual
         FROM nba_play_by_play_actions
         WHERE game_id = ?`,
      )
      .get(gameId);
  } catch {
    row = null;
  }

  return {
    max_time_actual: getString(row, "max_time_actual"),
    min_time_actual: getString(row, "min_time_actual"),
  };
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (isUnknownArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  throw new Error(`canonicalJson: unsupported value type ${typeof value}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isUnknownArray(v: unknown): v is readonly unknown[] {
  return Array.isArray(v);
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
