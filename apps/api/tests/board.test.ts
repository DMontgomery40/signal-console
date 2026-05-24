// Board route contract tests (US-021). Real on-disk SQLite for both gold
// and cache so the read-only enforcement (openGoldDb) and the cache write
// path (openCacheDb + transaction) exercise their production code paths.

import Database from "better-sqlite3";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/server";
import { getOrComputeBoard } from "../src/services/board";

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

beforeEach(() => {
  ctx.tempDir = mkdtempSync(join(tmpdir(), "signal-console-board-"));
  ctx.tokenPath = join(ctx.tempDir, "token");
  ctx.goldDbPath = join(ctx.tempDir, "gold.sqlite");
  ctx.cacheDbPath = join(ctx.tempDir, "cache.sqlite");
  writeFileSync(ctx.tokenPath, `${TEST_TOKEN}\n`, "utf8");
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
    board: { goldDbPath: ctx.goldDbPath, cacheDbPath: ctx.cacheDbPath },
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

async function timedInject(app: FastifyApp, url: string): Promise<{ res: unknown; ms: number }> {
  const start = process.hrtime.bigint();
  const res = await app.inject({ method: "GET", url, headers: authHeaders() });
  const ms = Number(process.hrtime.bigint() - start) / 1_000_000;
  return { res, ms };
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

  it("falls back to quote ticks when the PBP table is missing", async () => {
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
    expect(readObservations(firstBody).length).toBeGreaterThan(0);
    expect(countRunsForGame(ctx.cacheDbPath, "nba-no-pbp-table-1")).toBe(1);
  });

  it("warm call is at least 5x faster than the cold call (proxy for cache hit vs compute)", async () => {
    // Wide-enough seed that cold compute (sort + bucket sweep + transaction)
    // is well above ms quantization noise. 8000 ticks across 6 markets keeps
    // the detector input meaningful while the cache lookup stays trivial.
    seedGoldDb(ctx.goldDbPath, [{ id: "nba-timed-1", tickCount: 8000, markets: 6 }]);
    const app = await startApp();

    const cold = await timedInject(app, "/v1/board/nba-timed-1");
    const warm = await timedInject(app, "/v1/board/nba-timed-1");

    // Both calls must succeed.
    if (!isRecord(cold.res) || !("statusCode" in cold.res)) throw new Error("cold response shape");
    if (!isRecord(warm.res) || !("statusCode" in warm.res)) throw new Error("warm response shape");
    expect(cold.res["statusCode"]).toBe(200);
    expect(warm.res["statusCode"]).toBe(200);

    // Soft assertion: cold must take a non-trivial amount of time (otherwise
    // the ratio is meaningless), and warm must be at least 5x faster.
    expect(cold.ms).toBeGreaterThan(10);
    expect(cold.ms).toBeGreaterThanOrEqual(warm.ms * 5);
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

  it("paramsHash + watermarkHash discipline: rerunning preserves a single cache row", () => {
    // Direct service invocation shows we do not insert duplicate detector_runs
    // rows on identical inputs. The UNIQUE constraint would throw if we did.
    seedGoldDb(ctx.goldDbPath, [{ id: "nba-unique-1", tickCount: 100 }]);
    const r1 = getOrComputeBoard({
      goldDbPath: ctx.goldDbPath,
      cacheDbPath: ctx.cacheDbPath,
      gameId: "nba-unique-1",
    });
    const r2 = getOrComputeBoard({
      goldDbPath: ctx.goldDbPath,
      cacheDbPath: ctx.cacheDbPath,
      gameId: "nba-unique-1",
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
});
