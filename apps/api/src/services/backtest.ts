// Backtest service (US-034, PRD §15 / §9).
//
// Backs POST /v1/backtest. Runs a detector over (window, games, params) with
// window-scope cache lookup. Mirrors services/board.ts's shape: per-window
// source watermark hash keys the detector_runs lookup; cache hit reads
// detector_observations, cache miss runs the detector and persists the run +
// observations in one transaction.
//
// Cache discriminator for window scope:
//   (detector_id, detector_version, params_hash, source_watermark_hash,
//    scope='window', window_start, window_end). The sorted gameIds list is
//   baked into the watermark hash so distinct game-sets at the same window +
//   params produce distinct cache rows (the schema's UNIQUE constraint can't
//   discriminate them via game_id column — that column is NULL for window
//   scope).
//
// Observations are persisted with all buckets (not fires-only) so US-037's
// in-memory Cry Wolf K-sweep can recompute fired flags client-side without
// re-fetching. Off-price-print has no bucketing — its observations are the
// fires themselves, each with fired=1.

import { createHash } from "node:crypto";

import { openCacheDb, openGoldDb, v_games } from "@signal-console/db";
import {
  detector as boardMad,
  Params as BoardMadParams,
} from "@signal-console/detectors/board-mad";
import {
  detector as ensembleOr,
  Params as EnsembleOrParams,
} from "@signal-console/detectors/ensemble-or";
import {
  detector as offPricePrint,
  Params as OffPricePrintParams,
} from "@signal-console/detectors/off-price-print";
import type {
  DetectorResult,
  DetectorWindow,
  MicrostructureEvent,
  Tick,
} from "@signal-console/detectors";
import type Database from "better-sqlite3";

import {
  boardMadDetectorVersion,
  readDetectorDefaults,
  type DetectorDefaults,
} from "./detector-defaults";

type GoldDbHandle = ReturnType<typeof openGoldDb>;

export interface BacktestObservation {
  readonly gameId: string;
  readonly bucketStart: string;
  readonly bucketEnd: string;
  readonly fired: number;
  readonly intensity: number;
  readonly baselineMedian: number;
  readonly baselineMad: number;
  // Set by composite detectors (ensemble-or) so the UI can render board fires
  // and off-price-print fires differently. Single-lane runs leave it undefined.
  readonly lane?: "board" | "offprice";
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

export function runBacktest(args: RunBacktestArgs): BacktestResult {
  const now = args.now ?? new Date();
  const defaults = readDetectorDefaults();
  const dispatch = resolveDispatch(args.detectorId, args.params, defaults);
  const sortedGameIds = args.gameIds.toSorted();
  const paramsJson = canonicalJson(dispatch.params);
  const paramsHash = sha256Hex(paramsJson);

  const cacheDb = openCacheDb(args.cacheDbPath);
  try {
    const goldDb = openGoldDb(args.goldDbPath);
    try {
      const watermarkHash = computeWindowWatermarkHash(
        goldDb,
        sortedGameIds,
        args.windowStart,
        args.windowEnd,
      );
      const hit = lookupRun(cacheDb, {
        detectorId: dispatch.detectorId,
        detectorVersion: dispatch.detectorVersion,
        paramsHash,
        watermarkHash,
        windowStart: args.windowStart,
        windowEnd: args.windowEnd,
      });
      if (hit !== null) {
        const observations = loadObservations(cacheDb, hit.runId);
        return {
          runId: hit.runId,
          stats: buildStats(observations, args.gameIds.length),
          observations,
        };
      }

      const startNs = process.hrtime.bigint();
      const window: DetectorWindow = {
        gameIds: sortedGameIds,
        start: new Date(args.windowStart),
        end: new Date(args.windowEnd),
        ticks:
          dispatch.sources.includes("ticks") && sortedGameIds.length > 0
            ? loadTicks(goldDb, sortedGameIds, args.windowStart, args.windowEnd, defaults)
            : [],
        microstructureEvents:
          dispatch.sources.includes("microstructure") && sortedGameIds.length > 0
            ? loadMicrostructure(goldDb, sortedGameIds, args.windowStart, args.windowEnd)
            : [],
      };
      const result: DetectorResult = dispatch.run(window);
      const computeMs = Number((process.hrtime.bigint() - startNs) / 1_000_000n);

      const observations = buildObservationsFromResult(result);
      const runId = persistRun(cacheDb, {
        detectorId: dispatch.detectorId,
        detectorVersion: dispatch.detectorVersion,
        paramsHash,
        paramsJson,
        sourceDbPath: args.goldDbPath,
        watermarkHash,
        windowStart: args.windowStart,
        windowEnd: args.windowEnd,
        computedAt: now.toISOString(),
        computeMs,
        observations,
      });
      return {
        runId,
        stats: buildStats(observations, args.gameIds.length),
        observations,
      };
    } finally {
      goldDb.close();
    }
  } finally {
    cacheDb.close();
  }
}

interface Dispatch {
  readonly detectorId: string;
  readonly detectorVersion: string;
  readonly params: unknown;
  readonly sources: readonly ("ticks" | "microstructure")[];
  readonly run: (window: DetectorWindow) => DetectorResult;
}

function resolveDispatch(
  detectorId: string,
  rawParams: unknown,
  defaults: DetectorDefaults,
): Dispatch {
  switch (detectorId) {
    case boardMad.id: {
      const parsed = BoardMadParams.safeParse(rawParams);
      if (!parsed.success) {
        throw new BacktestError("invalid_params", parsed.error.message);
      }
      const params = parsed.data;
      return {
        detectorId: boardMad.id,
        detectorVersion: boardMadDetectorVersion(defaults),
        params,
        sources: ["ticks"],
        run: (w) => boardMad.run(w, params),
      };
    }
    case offPricePrint.id: {
      const parsed = OffPricePrintParams.safeParse(rawParams);
      if (!parsed.success) {
        throw new BacktestError("invalid_params", parsed.error.message);
      }
      const params = parsed.data;
      return {
        detectorId: offPricePrint.id,
        detectorVersion: offPricePrint.version,
        params,
        sources: ["microstructure"],
        run: (w) => offPricePrint.run(w, params),
      };
    }
    case ensembleOr.id: {
      const parsed = EnsembleOrParams.safeParse(rawParams);
      if (!parsed.success) {
        throw new BacktestError("invalid_params", parsed.error.message);
      }
      const params = parsed.data;
      // detector_version includes the board-mad version because the board
      // lane's algorithm version is the dominant invalidation axis (the
      // off-price-print lane is a pure threshold filter and changes are
      // captured by params_hash). Mirrors boardMadDetectorVersion() so the
      // cache key invalidates when the live K_MAD setting changes.
      return {
        detectorId: ensembleOr.id,
        detectorVersion: `${ensembleOr.version}+board=${boardMadDetectorVersion(defaults)}+off=${offPricePrint.version}`,
        params,
        sources: ["ticks", "microstructure"],
        run: (w) => ensembleOr.run(w, params),
      };
    }
    default:
      throw new BacktestError("unknown_detector", `unknown detector: ${detectorId}`);
  }
}

interface CacheHit {
  readonly runId: number;
}

interface LookupArgs {
  readonly detectorId: string;
  readonly detectorVersion: string;
  readonly paramsHash: string;
  readonly watermarkHash: string;
  readonly windowStart: string;
  readonly windowEnd: string;
}

function lookupRun(cacheDb: Database.Database, args: LookupArgs): CacheHit | null {
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
      args.windowStart,
      args.windowEnd,
    );
  if (!isRecord(row)) return null;
  const id = row["id"];
  return typeof id === "number" ? { runId: id } : null;
}

function loadObservations(
  cacheDb: Database.Database,
  runId: number,
): readonly BacktestObservation[] {
  const rows = cacheDb
    .prepare(
      `SELECT game_id, bucket_start, bucket_end, fired, intensity, baseline_median, baseline_mad, detail_json
       FROM detector_observations
       WHERE run_id = ?
       ORDER BY game_id, bucket_start`,
    )
    .all(runId);
  return rows.map((row): BacktestObservation => {
    if (!isRecord(row)) throw new Error("observation row not an object");
    const detailJson = row["detail_json"];
    let lane: "board" | "offprice" | undefined;
    if (typeof detailJson === "string" && detailJson.length > 0) {
      try {
        const parsed: unknown = JSON.parse(detailJson);
        if (isRecord(parsed)) {
          const candidate = parsed["lane"];
          if (candidate === "board" || candidate === "offprice") lane = candidate;
        }
      } catch {
        lane = undefined;
      }
    }
    const base = {
      gameId: pickString(row, "game_id"),
      bucketStart: pickString(row, "bucket_start"),
      bucketEnd: pickString(row, "bucket_end"),
      fired: pickNumber(row, "fired"),
      intensity: pickNumber(row, "intensity"),
      baselineMedian: pickNumber(row, "baseline_median"),
      baselineMad: pickNumber(row, "baseline_mad"),
    };
    return lane === undefined ? base : { ...base, lane };
  });
}

function buildObservationsFromResult(result: DetectorResult): readonly BacktestObservation[] {
  if (result.buckets.length > 0) {
    const out: BacktestObservation[] = result.buckets.map(
      (b): BacktestObservation => ({
        gameId: b.gameId,
        bucketStart: b.bucketStart.toISOString(),
        bucketEnd: b.bucketEnd.toISOString(),
        fired: b.fired ? 1 : 0,
        intensity: b.intensity,
        baselineMedian: b.baselineMedian,
        baselineMad: b.baselineMad,
        lane: "board",
      }),
    );
    // Non-board lane fires (e.g. off-price-print events when running
    // ensemble-or) aren't represented in buckets — they're point-in-time
    // tape prints, not per-minute aggregates. Append them so the response
    // carries both lanes.
    for (const f of result.fires) {
      if (f.lane === "offprice") {
        out.push({
          gameId: f.gameId,
          bucketStart: f.bucketStart.toISOString(),
          bucketEnd: f.bucketEnd.toISOString(),
          fired: 1,
          intensity: f.intensity,
          baselineMedian: f.baselineMedian,
          baselineMad: f.baselineMad,
          lane: "offprice",
        });
      }
    }
    return out;
  }
  // Detectors without per-bucket output (e.g. off-price-print run alone)
  // emit fires directly; persist each fire as a fired=1 observation with
  // the same bucketStart/End so the response shape stays uniform.
  return result.fires.map(
    (f): BacktestObservation => ({
      gameId: f.gameId,
      bucketStart: f.bucketStart.toISOString(),
      bucketEnd: f.bucketEnd.toISOString(),
      fired: 1,
      intensity: f.intensity,
      baselineMedian: f.baselineMedian,
      baselineMad: f.baselineMad,
      ...(f.lane === undefined ? {} : { lane: f.lane }),
    }),
  );
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

interface PersistArgs {
  readonly detectorId: string;
  readonly detectorVersion: string;
  readonly paramsHash: string;
  readonly paramsJson: string;
  readonly sourceDbPath: string;
  readonly watermarkHash: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly computedAt: string;
  readonly computeMs: number;
  readonly observations: readonly BacktestObservation[];
}

function persistRun(cacheDb: Database.Database, args: PersistArgs): number {
  const insertRun = cacheDb.prepare(
    `INSERT INTO detector_runs (
       detector_id, detector_version, params_hash, params_json,
       source_db_path, source_watermark_hash, scope, game_id,
       window_start, window_end, computed_at, compute_ms
     ) VALUES (?, ?, ?, ?, ?, ?, 'window', NULL, ?, ?, ?, ?)`,
  );
  const insertObs = cacheDb.prepare(
    `INSERT INTO detector_observations (
       run_id, game_id, bucket_start, bucket_end, fired,
       intensity, baseline_median, baseline_mad, detail_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = cacheDb.transaction((): number => {
    const result = insertRun.run(
      args.detectorId,
      args.detectorVersion,
      args.paramsHash,
      args.paramsJson,
      args.sourceDbPath,
      args.watermarkHash,
      args.windowStart,
      args.windowEnd,
      args.computedAt,
      args.computeMs,
    );
    const runId = Number(result.lastInsertRowid);
    for (const obs of args.observations) {
      const detail = obs.lane === undefined ? null : JSON.stringify({ lane: obs.lane });
      insertObs.run(
        runId,
        obs.gameId,
        obs.bucketStart,
        obs.bucketEnd,
        obs.fired,
        obs.intensity,
        obs.baselineMedian,
        obs.baselineMad,
        detail,
      );
    }
    return runId;
  });
  return tx();
}

// Per-game PBP-anchored window narrowing. Buffers come from the runtime
// detector-defaults service so the backtest path and the live /v1/board
// path see the same ticks for the same game.
//
// Why this matters: gold-DB quote_ticks for a single game routinely span
// 24+ hours (markets open the day before tipoff and accept low-volume
// pre-game wiggle). If we feed those pre-game ticks to the detector,
// (a) the bucket count balloons ~8x (1206 buckets observed for one game
// instead of ~155), and (b) the trailing median+MAD baseline is trained
// on pre-game noise — which is wrong-domain. In-play activity then
// blasts through the pre-game baseline at game start, producing ~17x
// the contract-test fire count at K=6. Narrowing to PBP MIN..MAX +
// small buffers, the same way board.ts does, fixes both at once. See
// US-021 / US-034 / canonical.test.ts for context.

interface InPlayBound {
  readonly start: string;
  readonly end: string;
}

function resolvePerGameInPlayWindow(
  goldDb: GoldDbHandle,
  gameId: string,
  windowStart: string,
  windowEnd: string,
  pbpPreBufferMs: number,
  pbpPostBufferMs: number,
): InPlayBound | null {
  // Primary: PBP time_actual MIN..MAX (most accurate; tipoff to final).
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
        const pbpStart = new Date(loMs - pbpPreBufferMs).toISOString();
        const pbpEnd = new Date(hiMs + pbpPostBufferMs).toISOString();
        const start = pbpStart > windowStart ? pbpStart : windowStart;
        const end = pbpEnd < windowEnd ? pbpEnd : windowEnd;
        if (start <= end) return { start, end };
        return null;
      }
    }
  }
  // Fallback: per-game quote_ticks captured_at MIN..MAX. Used when PBP is
  // unavailable for this game (e.g. backup predates PBP ingest). Less precise (no
  // pre-tipoff anchor, no after-final cooldown) but still narrows vs the
  // raw requested window because it bounds to "first tick to last tick for
  // THIS game's markets."
  let qt: unknown;
  try {
    qt = goldDb
      .prepare(
        `SELECT MIN(qt.captured_at) AS lo, MAX(qt.captured_at) AS hi
         FROM quote_ticks qt
         JOIN source_markets sm ON sm.id = qt.source_market_id
         WHERE sm.game_id = ?
           AND qt.captured_at >= ?
           AND qt.captured_at <= ?`,
      )
      .get(gameId, windowStart, windowEnd);
  } catch {
    qt = null;
  }
  if (isRecord(qt)) {
    const lo = qt["lo"];
    const hi = qt["hi"];
    if (typeof lo === "string" && typeof hi === "string") {
      const loMs = Date.parse(lo);
      const hiMs = Date.parse(hi);
      if (Number.isFinite(loMs) && Number.isFinite(hiMs)) {
        // No PBP-style buffers — we don't know exactly when tipoff was, so
        // first tick IS the earliest signal and last tick IS the latest.
        // This will still include some pre-warmup ticks from market-open
        // (the same wide-window problem at smaller scale) but bounded by
        // the actual data extent of THIS game.
        return { start: lo, end: hi };
      }
    }
  }
  // Last-ditch: requested window (no narrowing). Only true when the game has
  // no PBP and no ticks — in which case loadTicks finds nothing anyway, so
  // this is a harmless terminal fallback.
  return { start: windowStart, end: windowEnd };
}

function loadTicks(
  goldDb: GoldDbHandle,
  gameIds: readonly string[],
  windowStart: string,
  windowEnd: string,
  defaults: DetectorDefaults,
): readonly Tick[] {
  // Narrow per-game to the PBP-anchored in-play window. Without this, a
  // 4-day requested window over one game produces ~1200 buckets covering
  // 29 hours instead of ~155 buckets covering ~155 min (the actual play
  // time), and the detector fires ~14-17x too many times.
  const allRows = gameIds.flatMap((gameId): readonly unknown[] => {
    const bound = resolvePerGameInPlayWindow(
      goldDb,
      gameId,
      windowStart,
      windowEnd,
      defaults.pbpPreBufferMs,
      defaults.pbpPostBufferMs,
    );
    if (bound === null) return [];
    return goldDb
      .prepare(
        `SELECT sm.game_id AS game_id,
                qt.source_market_id AS source_market_id,
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
      .all(gameId, bound.start, bound.end);
  });
  return allRows.map((row): Tick => {
    if (!isRecord(row)) throw new Error("tick row not an object");
    const ip = row["implied_probability"];
    return {
      gameId: pickString(row, "game_id"),
      sourceMarketId: pickString(row, "source_market_id"),
      capturedAt: new Date(pickString(row, "captured_at")),
      impliedProbability: ip === null ? null : typeof ip === "number" ? ip : null,
      volume: pickNumber(row, "volume"),
      isHeartbeat: pickNumber(row, "is_heartbeat") === 1,
    };
  });
}

function loadMicrostructure(
  goldDb: GoldDbHandle,
  gameIds: readonly string[],
  windowStart: string,
  windowEnd: string,
): readonly MicrostructureEvent[] {
  // off_price_distance is computed at query time (report §5.3 / §7.1: the
  // absolute distance between trade_price and the most recent sampled
  // implied_probability on the same source_market at or before the trade).
  // Causal subquery — never reads ticks after event_timestamp — and uses
  // the (source_market_id, captured_at DESC) index for O(log N) per event.
  const placeholders = gameIds.map(() => "?").join(",");
  const rows = goldDb
    .prepare(
      `SELECT e.game_id, e.source_market_id, e.event_timestamp, e.source,
              COALESCE(e.volume_share, 0) AS volume_share,
              COALESCE(ABS(e.trade_price - (
                SELECT qt.implied_probability
                FROM quote_ticks qt
                WHERE qt.source_market_id = e.source_market_id
                  AND qt.captured_at <= e.event_timestamp
                ORDER BY qt.captured_at DESC
                LIMIT 1
              )), 0) AS off_price_distance
       FROM market_microstructure_events e
       WHERE e.game_id IN (${placeholders})
         AND e.event_timestamp >= ?
         AND e.event_timestamp <= ?
       ORDER BY e.game_id, e.event_timestamp`,
    )
    .all(...gameIds, windowStart, windowEnd);
  return rows.map((row): MicrostructureEvent => {
    if (!isRecord(row)) throw new Error("microstructure row not an object");
    return {
      gameId: pickString(row, "game_id"),
      sourceMarketId: pickString(row, "source_market_id"),
      eventTimestamp: new Date(pickString(row, "event_timestamp")),
      source: pickString(row, "source"),
      volumeShare: pickNumber(row, "volume_share"),
      offPriceDistance: pickNumber(row, "off_price_distance"),
    };
  });
}

// Per-window watermark hash. Includes the sorted gameIds list and, per game,
// the in-window counts + max ids/timestamps over quote_ticks and
// market_microstructure_events. Restricting the watermark queries to the
// requested window means data outside the window does not invalidate cache.
function computeWindowWatermarkHash(
  goldDb: GoldDbHandle,
  sortedGameIds: readonly string[],
  windowStart: string,
  windowEnd: string,
): string {
  const perGame = sortedGameIds.map((gameId) => {
    const qt = goldDb
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
      .get(gameId, windowStart, windowEnd);
    const mme = goldDb
      .prepare(
        `SELECT COUNT(*) AS cnt,
                COALESCE(MAX(id), 0) AS max_id,
                COALESCE(MAX(event_timestamp), '') AS max_event_timestamp
         FROM market_microstructure_events
         WHERE game_id = ?
           AND event_timestamp >= ?
           AND event_timestamp <= ?`,
      )
      .get(gameId, windowStart, windowEnd);
    return {
      gameId,
      market_microstructure_events: {
        cnt: getNumber(mme, "cnt"),
        max_event_timestamp: getString(mme, "max_event_timestamp"),
        max_id: getNumber(mme, "max_id"),
      },
      quote_ticks: {
        cnt: getNumber(qt, "cnt"),
        max_captured_at: getString(qt, "max_captured_at"),
        max_id: getNumber(qt, "max_id"),
      },
    };
  });
  return sha256Hex(
    canonicalJson({
      gameIds: sortedGameIds,
      perGame,
      windowEnd,
      windowStart,
    }),
  );
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

// Game discovery for the no-game_ids path. Returns up to `limit` games whose
// scheduled_start falls in [windowStart, windowEnd], sorted oldest-first so
// the truncated set is deterministic when the window has more than `limit`
// games. Caller is expected to enforce the count cap (400 if too many).
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
    return rows.map((row) => {
      if (!isRecord(row)) throw new Error("game discovery row not an object");
      return pickString(row, "id");
    });
  } finally {
    goldDb.close();
  }
}
