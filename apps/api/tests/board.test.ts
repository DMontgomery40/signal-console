// Board route contract tests (US-021). Real on-disk SQLite for both gold
// and cache so the read-only enforcement (openGoldDb) and the cache write
// path (openCacheDb + transaction) exercise their production code paths.

import Database from "better-sqlite3";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BOARD_MAD_BASELINE_MODE_OPENING_RAMP } from "@signal-console/detectors/board-mad/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/server";
import {
  BASELINE_DEFAULTS,
  invalidateDetectorDefaultsCache,
  setDetectorDefaultsPath,
  writeDetectorDefaults,
} from "../src/services/detector-defaults";
import { getOrComputeBoard } from "../src/services/board";
import { tsBoardVolatilityRunner } from "./helpers/board-volatility-runner";

type FastifyApp = Awaited<ReturnType<typeof buildServer>>;

const TEST_TOKEN = "board-test-token";

interface TestCtx {
  app: FastifyApp | null;
  tempDir: string;
  tokenPath: string;
  goldDbPath: string;
  cacheDbPath: string;
}

const ctx: TestCtx = {
  app: null,
  tempDir: "",
  tokenPath: "",
  goldDbPath: "",
  cacheDbPath: "",
};

interface SeedGame {
  readonly id: string;
  readonly tickCount: number;
  readonly markets?: number;
  readonly seedPbp?: boolean;
}

function seedGoldDb(path: string, games: readonly SeedGame[]): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_markets (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS quote_ticks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_market_id TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      implied_probability REAL,
      volume REAL,
      is_heartbeat INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS nba_play_by_play_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      time_actual TEXT
    );
    CREATE TABLE IF NOT EXISTS market_microstructure_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      event_timestamp TEXT
    );
    CREATE TABLE IF NOT EXISTS game_states (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_quote_ticks_source_market
      ON quote_ticks(source_market_id, captured_at);
    CREATE INDEX IF NOT EXISTS idx_pbp_game ON nba_play_by_play_actions(game_id);
    CREATE INDEX IF NOT EXISTS idx_mme_game ON market_microstructure_events(game_id);
    CREATE INDEX IF NOT EXISTS idx_gs_game ON game_states(game_id);
  `);

  const insertMarket = db.prepare(`INSERT INTO source_markets (id, game_id) VALUES (?, ?)`);
  const insertTick = db.prepare(
    `INSERT INTO quote_ticks (source_market_id, captured_at, implied_probability, volume, is_heartbeat)
     VALUES (?, ?, ?, ?, 0)`,
  );
  const insertPbp = db.prepare(
    `INSERT INTO nba_play_by_play_actions (game_id, time_actual) VALUES (?, ?)`,
  );

  for (const g of games) {
    const marketCount = g.markets ?? 4;
    for (let m = 0; m < marketCount; m += 1) {
      insertMarket.run(`mkt-${g.id}-${String(m)}`, g.id);
    }
    // Spread `tickCount` ticks across markets at 5-second intervals so the
    // 60-second bucketer has ~12 ticks per bucket per market. The implied
    // probability walks deterministically so neither cold nor warm path
    // are sensitive to seed-time randomness.
    const baseMs = Date.parse("2026-05-23T03:00:00Z");
    for (let i = 0; i < g.tickCount; i += 1) {
      const market = i % marketCount;
      const tMs = baseMs + i * 5_000;
      const ip = 0.4 + ((i * 0.013) % 0.2);
      insertTick.run(
        `mkt-${g.id}-${String(market)}`,
        new Date(tMs).toISOString(),
        ip,
        Math.max(1, i % 50),
      );
    }
    if (g.seedPbp !== false) {
      // PBP MIN/MAX defines the in-play window (with pre/post buffers).
      const firstMs = baseMs;
      const lastMs = baseMs + g.tickCount * 5_000;
      insertPbp.run(g.id, new Date(firstMs).toISOString());
      insertPbp.run(g.id, new Date(lastMs).toISOString());
    }
  }
  db.close();
}

function seedSparseElapsedWarmupGoldDb(path: string, gameId: string): void {
  seedGoldDb(path, [{ id: gameId, markets: 1, seedPbp: false, tickCount: 0 }]);
  const db = new Database(path);
  try {
    const insertTick = db.prepare(
      `INSERT INTO quote_ticks (
         source_market_id, captured_at, implied_probability, volume, is_heartbeat
       ) VALUES (?, ?, ?, ?, 0)`,
    );
    const insertPbp = db.prepare(
      `INSERT INTO nba_play_by_play_actions (game_id, time_actual) VALUES (?, ?)`,
    );
    const marketId = `mkt-${gameId}-0`;
    insertTick.run(marketId, "2026-05-23T02:59:30.000Z", 0.4, 10);
    insertTick.run(marketId, "2026-05-23T03:00:00.000Z", 0.41, 10);
    insertTick.run(marketId, "2026-05-23T03:04:00.000Z", 0.42, 10);
    insertTick.run(marketId, "2026-05-23T03:08:00.000Z", 0.92, 10);
    insertPbp.run(gameId, "2026-05-23T03:00:00.000Z");
    insertPbp.run(gameId, "2026-05-23T03:10:00.000Z");
  } finally {
    db.close();
  }
}

function seedSparseElapsedMemoryGoldDb(path: string, gameId: string): void {
  seedGoldDb(path, [{ id: gameId, markets: 1, seedPbp: false, tickCount: 0 }]);
  const db = new Database(path);
  try {
    db.exec(`
      ALTER TABLE nba_play_by_play_actions ADD COLUMN period INTEGER;
      ALTER TABLE nba_play_by_play_actions ADD COLUMN clock TEXT;
    `);
    const insertTick = db.prepare(
      `INSERT INTO quote_ticks (
         source_market_id, captured_at, implied_probability, volume, is_heartbeat
       ) VALUES (?, ?, ?, ?, 0)`,
    );
    const insertPbp = db.prepare(
      `INSERT INTO nba_play_by_play_actions (game_id, time_actual, period, clock)
       VALUES (?, ?, ?, ?)`,
    );
    const marketId = `mkt-${gameId}-0`;
    const tick = (iso: string, ip: number): void => {
      insertTick.run(marketId, iso, ip, 10);
    };
    const pbp = (iso: string, period: number, clock: string): void => {
      insertPbp.run(gameId, iso, period, clock);
    };

    tick("2026-05-23T02:59:30.000Z", 0.4);
    tick("2026-05-23T03:00:00.000Z", 0.9);
    tick("2026-05-23T03:04:00.000Z", 0.41);
    tick("2026-05-23T03:08:00.000Z", 0.91);
    tick("2026-05-23T03:12:00.000Z", 0.91);
    tick("2026-05-23T03:16:00.000Z", 0.91);
    tick("2026-05-23T03:20:00.000Z", 0.91);
    tick("2026-05-23T03:24:00.000Z", 0.91);
    tick("2026-05-23T03:28:00.000Z", 0.91);
    tick("2026-05-23T03:32:00.000Z", 0.93);
    tick("2026-05-23T03:36:00.000Z", 0.96);

    pbp("2026-05-23T03:00:00.000Z", 1, "PT12M00.00S");
    pbp("2026-05-23T03:04:00.000Z", 1, "PT08M00.00S");
    pbp("2026-05-23T03:08:00.000Z", 1, "PT04M00.00S");
    pbp("2026-05-23T03:32:00.000Z", 3, "PT04M00.00S");
    pbp("2026-05-23T03:36:00.000Z", 4, "PT12M00.00S");
  } finally {
    db.close();
  }
}

beforeEach(() => {
  ctx.tempDir = mkdtempSync(join(tmpdir(), "signal-console-board-"));
  ctx.tokenPath = join(ctx.tempDir, "token");
  ctx.goldDbPath = join(ctx.tempDir, "gold.sqlite");
  ctx.cacheDbPath = join(ctx.tempDir, "cache.sqlite");
  writeFileSync(ctx.tokenPath, `${TEST_TOKEN}\n`, "utf8");
  setDetectorDefaultsPath(join(ctx.tempDir, "detector-defaults.json"));
  invalidateDetectorDefaultsCache();
});

afterEach(async () => {
  if (ctx.app !== null) {
    await ctx.app.close();
    ctx.app = null;
  }
  rmSync(ctx.tempDir, { recursive: true, force: true });
});

async function startApp(): Promise<FastifyApp> {
  const app = await buildServer({
    auth: { tokenPath: ctx.tokenPath, cacheTtlMs: 0 },
    board: {
      goldDbPath: ctx.goldDbPath,
      cacheDbPath: ctx.cacheDbPath,
      boardVolatilityRunner: tsBoardVolatilityRunner,
    },
    cache: { cacheDbPath: ctx.cacheDbPath },
  });
  ctx.app = app;
  return app;
}

function authHeaders(): Record<string, string> {
  return { "x-signal-token": TEST_TOKEN };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isUnknownArray(v: unknown): v is readonly unknown[] {
  return Array.isArray(v);
}

function asRecord(v: unknown, name: string): Record<string, unknown> {
  if (!isRecord(v)) throw new Error(`${name} not an object`);
  return v;
}

function readObservations(body: unknown): readonly unknown[] {
  const rec = asRecord(body, "body");
  const obs = rec["observations"];
  if (!isUnknownArray(obs)) throw new Error("body.observations not an array");
  return obs;
}

function countRunsForGame(cacheDbPath: string, gameId: string): number {
  const cacheDb = new Database(cacheDbPath, { readonly: true, fileMustExist: false });
  try {
    const row = cacheDb
      .prepare(`SELECT COUNT(*) AS n FROM detector_runs WHERE game_id = ?`)
      .get(gameId);
    if (!isRecord(row)) return 0;
    const n = row["n"];
    return typeof n === "number" ? n : 0;
  } finally {
    cacheDb.close();
  }
}

function guardAgainstDetectorRunInsert(cacheDbPath: string): void {
  const cacheDb = new Database(cacheDbPath);
  try {
    cacheDb.exec(`
      CREATE TRIGGER fail_unexpected_detector_run_insert
      BEFORE INSERT ON detector_runs
      BEGIN
        SELECT RAISE(ABORT, 'warm board path attempted detector_runs insert');
      END;
    `);
  } finally {
    cacheDb.close();
  }
}

function updateEarliestPbp(path: string, gameId: string, nextTimeActual: string): void {
  const db = new Database(path);
  try {
    db.prepare(
      `UPDATE nba_play_by_play_actions
       SET time_actual = ?
       WHERE id = (
         SELECT id FROM nba_play_by_play_actions
         WHERE game_id = ?
         ORDER BY time_actual ASC
         LIMIT 1
       )`,
    ).run(nextTimeActual, gameId);
  } finally {
    db.close();
  }
}

function seedBoardIrrelevantRows(path: string, gameId: string): void {
  const db = new Database(path);
  try {
    db.prepare(
      `INSERT INTO market_microstructure_events (game_id, event_timestamp)
       VALUES (?, ?)`,
    ).run(gameId, "2026-05-23T03:42:00.000Z");
    db.prepare(
      `INSERT INTO game_states (game_id, captured_at, status)
       VALUES (?, ?, ?)`,
    ).run(gameId, "2026-05-23T03:42:00.000Z", "in_progress");
  } finally {
    db.close();
  }
}

function dropPbpTable(path: string): void {
  const db = new Database(path);
  try {
    db.exec(`DROP TABLE nba_play_by_play_actions`);
  } finally {
    db.close();
  }
}

describe("board route (US-021)", () => {
  it("GET /v1/board/:gameId returns a stable shape with observations + runId + k", async () => {
    seedGoldDb(ctx.goldDbPath, [{ id: "nba-spike-1", tickCount: 1200 }]);
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/board/nba-spike-1",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = asRecord(res.json(), "body");
    expect(body["gameId"]).toBe("nba-spike-1");
    expect(body["k"]).toBe(3.0);
    expect(typeof body["runId"]).toBe("number");
    expect(isUnknownArray(body["observations"])).toBe(true);
    const observations = readObservations(body);
    expect(observations.some((o) => asRecord(o, "observation")["warmedUp"] === false)).toBe(true);
    expect(observations.some((o) => asRecord(o, "observation")["warmedUp"] === true)).toBe(true);
  });

  it("GET /v1/board/:gameId returns identical observations on a second (warm) call", async () => {
    seedGoldDb(ctx.goldDbPath, [{ id: "nba-warm-1", tickCount: 2000 }]);
    const app = await startApp();
    const first = await app.inject({
      method: "GET",
      url: "/v1/board/nba-warm-1",
      headers: authHeaders(),
    });
    const second = await app.inject({
      method: "GET",
      url: "/v1/board/nba-warm-1",
      headers: authHeaders(),
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const firstBody = asRecord(first.json(), "first body");
    const secondBody = asRecord(second.json(), "second body");
    expect(secondBody["runId"]).toBe(firstBody["runId"]);
    expect(readObservations(secondBody)).toEqual(readObservations(firstBody));
  });

  it("GET /v1/board/:gameId activates after 8 elapsed minutes even when only three sparse board buckets exist", async () => {
    seedSparseElapsedWarmupGoldDb(ctx.goldDbPath, "nba-sparse-warmup-1");
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/board/nba-sparse-warmup-1",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const observations = readObservations(res.json()).map((o) => asRecord(o, "observation"));
    expect(
      observations.map((o) => ({
        bucketStart: o["bucketStart"],
        warmedUp: o["warmedUp"],
        fired: o["fired"],
      })),
    ).toEqual([
      { bucketStart: "2026-05-23T03:00:00.000Z", warmedUp: false, fired: 0 },
      { bucketStart: "2026-05-23T03:04:00.000Z", warmedUp: false, fired: 0 },
      { bucketStart: "2026-05-23T03:08:00.000Z", warmedUp: true, fired: 1 },
    ]);
  });

  it("GET /v1/board/:gameId uses elapsed game minutes for trailing memory, not sparse activity count", async () => {
    seedSparseElapsedMemoryGoldDb(ctx.goldDbPath, "nba-sparse-memory-1");
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/board/nba-sparse-memory-1",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const observations = readObservations(res.json()).map((o) => asRecord(o, "observation"));
    const late = observations.find((o) => o["bucketStart"] === "2026-05-23T03:36:00.000Z");
    expect(late).toBeDefined();
    expect(late?.["warmedUp"]).toBe(true);
    expect(late?.["fired"]).toBe(1);
    expect(late?.["baselineMedian"]).toBeCloseTo(0.02 * Math.log1p(10), 8);
    expect(late?.["baselineMad"]).toBeCloseTo(1e-9, 12);
  });

  it("persists warmedUp in detail_json so warm calls do not confuse warmup with a zero threshold", async () => {
    seedGoldDb(ctx.goldDbPath, [{ id: "nba-warmed-contract-1", tickCount: 1200 }]);
    const app = await startApp();
    const first = await app.inject({
      method: "GET",
      url: "/v1/board/nba-warmed-contract-1",
      headers: authHeaders(),
    });
    expect(first.statusCode).toBe(200);
    const firstBody = asRecord(first.json(), "first body");
    const runId = firstBody["runId"];
    if (typeof runId !== "number") throw new Error("runId not a number");
    const firstObs = readObservations(firstBody).map((o) => asRecord(o, "observation"));
    expect(firstObs[0]?.["warmedUp"]).toBe(false);
    expect(firstObs.some((o) => o["warmedUp"] === true)).toBe(true);

    const cacheDb = new Database(ctx.cacheDbPath, { readonly: true });
    try {
      const detailRows = cacheDb
        .prepare(
          `SELECT detail_json
           FROM detector_observations
           WHERE run_id = ?
           ORDER BY bucket_start`,
        )
        .all(runId);
      expect(detailRows.some((row) => asRecord(row, "detail row")["detail_json"] !== null)).toBe(
        true,
      );
    } finally {
      cacheDb.close();
    }

    const second = await app.inject({
      method: "GET",
      url: "/v1/board/nba-warmed-contract-1",
      headers: authHeaders(),
    });
    expect(second.statusCode).toBe(200);
    expect(readObservations(second.json())).toEqual(readObservations(firstBody));
  });

  it("invalidates cached board runs when the PBP minimum bound changes", async () => {
    seedGoldDb(ctx.goldDbPath, [{ id: "nba-pbp-min-1", tickCount: 1200 }]);
    const app = await startApp();
    const first = await app.inject({
      method: "GET",
      url: "/v1/board/nba-pbp-min-1",
      headers: authHeaders(),
    });
    expect(first.statusCode).toBe(200);
    const firstBody = asRecord(first.json(), "first body");

    updateEarliestPbp(ctx.goldDbPath, "nba-pbp-min-1", "2026-05-23T03:30:00.000Z");

    const second = await app.inject({
      method: "GET",
      url: "/v1/board/nba-pbp-min-1",
      headers: authHeaders(),
    });
    expect(second.statusCode).toBe(200);
    const secondBody = asRecord(second.json(), "second body");
    expect(secondBody["runId"]).not.toBe(firstBody["runId"]);
    expect(countRunsForGame(ctx.cacheDbPath, "nba-pbp-min-1")).toBe(2);
  });

  it("keeps cached board runs when non-tick context rows change", async () => {
    seedGoldDb(ctx.goldDbPath, [{ id: "nba-board-input-1", tickCount: 1200 }]);
    const app = await startApp();
    const first = await app.inject({
      method: "GET",
      url: "/v1/board/nba-board-input-1",
      headers: authHeaders(),
    });
    expect(first.statusCode).toBe(200);
    const firstBody = asRecord(first.json(), "first body");

    seedBoardIrrelevantRows(ctx.goldDbPath, "nba-board-input-1");

    const second = await app.inject({
      method: "GET",
      url: "/v1/board/nba-board-input-1",
      headers: authHeaders(),
    });
    expect(second.statusCode).toBe(200);
    const secondBody = asRecord(second.json(), "second body");
    expect(secondBody["runId"]).toBe(firstBody["runId"]);
    expect(countRunsForGame(ctx.cacheDbPath, "nba-board-input-1")).toBe(1);
  });

  it("fails closed when the PBP table is missing instead of using quote ticks", async () => {
    seedGoldDb(ctx.goldDbPath, [{ id: "nba-no-pbp-table-1", seedPbp: false, tickCount: 1200 }]);
    dropPbpTable(ctx.goldDbPath);
    const app = await startApp();

    const first = await app.inject({
      method: "GET",
      url: "/v1/board/nba-no-pbp-table-1",
      headers: authHeaders(),
    });
    const second = await app.inject({
      method: "GET",
      url: "/v1/board/nba-no-pbp-table-1",
      headers: authHeaders(),
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const firstBody = asRecord(first.json(), "first body");
    const secondBody = asRecord(second.json(), "second body");
    expect(secondBody["runId"]).toBe(firstBody["runId"]);
    expect(readObservations(firstBody)).toEqual([]);
    expect(countRunsForGame(ctx.cacheDbPath, "nba-no-pbp-table-1")).toBe(1);
  });

  it("warm call reuses the cached detector run without attempting a second insert", async () => {
    seedGoldDb(ctx.goldDbPath, [{ id: "nba-timed-1", tickCount: 1200 }]);
    const app = await startApp();

    const cold = await app.inject({
      method: "GET",
      url: "/v1/board/nba-timed-1",
      headers: authHeaders(),
    });
    expect(cold.statusCode).toBe(200);
    const coldBody = asRecord(cold.json(), "cold body");
    expect(countRunsForGame(ctx.cacheDbPath, "nba-timed-1")).toBe(1);

    guardAgainstDetectorRunInsert(ctx.cacheDbPath);

    const warm = await app.inject({
      method: "GET",
      url: "/v1/board/nba-timed-1",
      headers: authHeaders(),
    });
    expect(warm.statusCode).toBe(200);
    const warmBody = asRecord(warm.json(), "warm body");
    expect(warmBody["runId"]).toBe(coldBody["runId"]);
    expect(countRunsForGame(ctx.cacheDbPath, "nba-timed-1")).toBe(1);
  });

  it("DELETE /v1/cache then GET /v1/board recomputes (cache miss path is real)", async () => {
    seedGoldDb(ctx.goldDbPath, [{ id: "nba-recompute-1", tickCount: 1000 }]);
    const app = await startApp();

    const first = await app.inject({
      method: "GET",
      url: "/v1/board/nba-recompute-1",
      headers: authHeaders(),
    });
    expect(first.statusCode).toBe(200);
    const firstBody = asRecord(first.json(), "first body");
    expect(countRunsForGame(ctx.cacheDbPath, "nba-recompute-1")).toBe(1);

    const clear = await app.inject({
      method: "DELETE",
      url: "/v1/cache",
      headers: authHeaders(),
    });
    expect(clear.statusCode).toBe(200);
    expect(countRunsForGame(ctx.cacheDbPath, "nba-recompute-1")).toBe(0);

    const second = await app.inject({
      method: "GET",
      url: "/v1/board/nba-recompute-1",
      headers: authHeaders(),
    });
    expect(second.statusCode).toBe(200);
    const secondBody = asRecord(second.json(), "second body");
    // Recompute proof: a fresh detector_runs row exists post-DELETE.
    expect(countRunsForGame(ctx.cacheDbPath, "nba-recompute-1")).toBe(1);
    // And observations are deterministic across the cache rebuild.
    expect(readObservations(secondBody)).toEqual(readObservations(firstBody));
  });

  it("game with no ticks and no PBP returns empty observations and still caches", async () => {
    seedGoldDb(ctx.goldDbPath, []);
    const app = await startApp();
    const first = await app.inject({
      method: "GET",
      url: "/v1/board/nba-missing-9",
      headers: authHeaders(),
    });
    expect(first.statusCode).toBe(200);
    const firstBody = asRecord(first.json(), "first body");
    expect(readObservations(firstBody)).toEqual([]);

    const second = await app.inject({
      method: "GET",
      url: "/v1/board/nba-missing-9",
      headers: authHeaders(),
    });
    expect(second.statusCode).toBe(200);
    const secondBody = asRecord(second.json(), "second body");
    expect(secondBody["runId"]).toBe(firstBody["runId"]);
  });

  it("leaves the gold DB byte-identical (size + mtime) across compute + cache-hit", async () => {
    seedGoldDb(ctx.goldDbPath, [{ id: "nba-bytecheck-1", tickCount: 500 }]);
    const goldStatBefore = statSync(ctx.goldDbPath);
    const sizeBefore = goldStatBefore.size;
    const mtimeBefore = goldStatBefore.mtimeMs;

    const app = await startApp();
    await app.inject({
      method: "GET",
      url: "/v1/board/nba-bytecheck-1",
      headers: authHeaders(),
    });
    await app.inject({
      method: "GET",
      url: "/v1/board/nba-bytecheck-1",
      headers: authHeaders(),
    });

    const goldStatAfter = statSync(ctx.goldDbPath);
    expect(goldStatAfter.size).toBe(sizeBefore);
    expect(goldStatAfter.mtimeMs).toBe(mtimeBefore);
  });

  it("is tagged 'desk-stable' in /openapi.json and does NOT advertise a kMad query param", async () => {
    seedGoldDb(ctx.goldDbPath, []);
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: "/openapi.json",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = asRecord(res.json(), "openapi body");
    const paths = asRecord(body["paths"], "openapi.paths");
    const boardEntry = asRecord(paths["/v1/board/{gameId}"], "board path entry");
    const get = asRecord(boardEntry["get"], "board GET");
    const tags = get["tags"];
    if (!isUnknownArray(tags)) throw new Error("tags not an array");
    const tagStrings = tags.filter((t): t is string => typeof t === "string");
    expect(tagStrings).toContain("desk-stable");

    // No `parameters` entry should declare `kMad` (route is K_MAD_LIVE-only).
    const params = get["parameters"];
    if (isUnknownArray(params)) {
      for (const p of params) {
        if (!isRecord(p)) continue;
        expect(p["name"]).not.toBe("kMad");
      }
    }
  });

  it("paramsHash + watermarkHash discipline: rerunning preserves a single cache row", async () => {
    // Direct service invocation shows we do not insert duplicate detector_runs
    // rows on identical inputs. The UNIQUE constraint would throw if we did.
    seedGoldDb(ctx.goldDbPath, [{ id: "nba-unique-1", tickCount: 100 }]);
    const r1 = await getOrComputeBoard({
      goldDbPath: ctx.goldDbPath,
      cacheDbPath: ctx.cacheDbPath,
      gameId: "nba-unique-1",
      boardVolatilityRunner: tsBoardVolatilityRunner,
    });
    const r2 = await getOrComputeBoard({
      goldDbPath: ctx.goldDbPath,
      cacheDbPath: ctx.cacheDbPath,
      gameId: "nba-unique-1",
      boardVolatilityRunner: tsBoardVolatilityRunner,
    });
    expect(r2.runId).toBe(r1.runId);

    const cacheDb = new Database(ctx.cacheDbPath, { readonly: true });
    try {
      const row = cacheDb
        .prepare(`SELECT COUNT(*) AS n FROM detector_runs WHERE game_id = ?`)
        .get("nba-unique-1");
      if (!isRecord(row)) throw new Error("count row not a record");
      expect(row["n"]).toBe(1);
    } finally {
      cacheDb.close();
    }
  });

  it("live board params include signal timing defaults in cache identity", async () => {
    seedGoldDb(ctx.goldDbPath, [{ id: "nba-baseline-defaults-1", tickCount: 100 }]);
    writeDetectorDefaults({
      ...BASELINE_DEFAULTS,
      baselineMode: BOARD_MAD_BASELINE_MODE_OPENING_RAMP,
      openingRampCompleteBuckets: 12,
    });

    await getOrComputeBoard({
      goldDbPath: ctx.goldDbPath,
      cacheDbPath: ctx.cacheDbPath,
      gameId: "nba-baseline-defaults-1",
      boardVolatilityRunner: tsBoardVolatilityRunner,
    });

    const cacheDb = new Database(ctx.cacheDbPath, { readonly: true });
    try {
      const row = cacheDb
        .prepare(
          `SELECT detector_version, params_json
           FROM detector_runs
           WHERE game_id = ?`,
        )
        .get("nba-baseline-defaults-1");
      if (!isRecord(row)) throw new Error("run row not a record");
      expect(String(row["detector_version"])).toMatch(/\+def\.[0-9a-f]{8}$/);
      const params = asRecord(JSON.parse(String(row["params_json"])), "params_json");
      expect(params["baselineMode"]).toBe(BOARD_MAD_BASELINE_MODE_OPENING_RAMP);
      expect(params["openingBaselineBuckets"]).toBe(BASELINE_DEFAULTS.openingBaselineBuckets);
      expect(params["openingRampCompleteBuckets"]).toBe(12);
      expect(params["trailingBuckets"]).toBe(BASELINE_DEFAULTS.trailingBuckets);
      expect(params["warmupBuckets"]).toBe(BASELINE_DEFAULTS.warmupBuckets);
    } finally {
      cacheDb.close();
    }
  });
});
