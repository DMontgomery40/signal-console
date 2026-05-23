// Backtest route contract tests (US-034). Real on-disk SQLite for both gold
// and cache so the cache write/read path exercises its production code paths.

import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/server";

type FastifyApp = Awaited<ReturnType<typeof buildServer>>;

const TEST_TOKEN = "backtest-test-token";

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
  readonly sport?: string;
  readonly scheduledStart?: string;
}

function seedGoldDb(path: string, games: readonly SeedGame[]): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      sport TEXT NOT NULL,
      league TEXT NOT NULL,
      scheduled_start TEXT NOT NULL,
      home_participant_json TEXT NOT NULL,
      away_participant_json TEXT NOT NULL
    );
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
    CREATE TABLE IF NOT EXISTS market_microstructure_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      source_market_id TEXT NOT NULL,
      event_timestamp TEXT NOT NULL,
      source TEXT NOT NULL,
      volume_share REAL,
      off_price_distance REAL
    );
    CREATE TABLE IF NOT EXISTS game_states (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_quote_ticks_source_market
      ON quote_ticks(source_market_id, captured_at);
  `);

  const insertGame = db.prepare(
    `INSERT INTO games (id, sport, league, scheduled_start, home_participant_json, away_participant_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertMarket = db.prepare(`INSERT INTO source_markets (id, game_id) VALUES (?, ?)`);
  const insertTick = db.prepare(
    `INSERT INTO quote_ticks (source_market_id, captured_at, implied_probability, volume, is_heartbeat)
     VALUES (?, ?, ?, ?, 0)`,
  );

  for (const g of games) {
    insertGame.run(
      g.id,
      g.sport ?? "NBA",
      "NBA",
      g.scheduledStart ?? "2026-05-23T03:00:00Z",
      `{"name":"Home"}`,
      `{"name":"Away"}`,
    );
    const marketCount = g.markets ?? 4;
    for (let m = 0; m < marketCount; m += 1) {
      insertMarket.run(`mkt-${g.id}-${String(m)}`, g.id);
    }
    const baseMs = Date.parse(g.scheduledStart ?? "2026-05-23T03:00:00Z");
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
  }
  db.close();
}

beforeEach(() => {
  ctx.tempDir = mkdtempSync(join(tmpdir(), "signal-console-backtest-"));
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
    backtest: { goldDbPath: ctx.goldDbPath, cacheDbPath: ctx.cacheDbPath },
  });
  ctx.app = app;
  return app;
}

function authHeaders(): Record<string, string> {
  return { "x-signal-token": TEST_TOKEN, "content-type": "application/json" };
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

function defaultBoardMadParams(kMad: number): Record<string, unknown> {
  return {
    bucketSeconds: 60,
    freshCapSeconds: 300,
    kMad,
    trailingBuckets: 20,
    warmupBuckets: 8,
    weighting: "volume",
  };
}

describe("backtest route (US-034)", () => {
  it("POST /v1/backtest returns { runId, stats, observations } with explicit game_ids", async () => {
    seedGoldDb(ctx.goldDbPath, [{ id: "nba-bt-1", tickCount: 1500 }]);
    const app = await startApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/backtest",
      headers: authHeaders(),
      payload: {
        detector_id: "board-mad",
        params: defaultBoardMadParams(3.0),
        window: { start: "2026-05-23T02:30:00Z", end: "2026-05-23T05:00:00Z" },
        game_ids: ["nba-bt-1"],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = asRecord(res.json(), "body");
    expect(typeof body["runId"]).toBe("number");
    const stats = asRecord(body["stats"], "stats");
    expect(stats["gamesInWindow"]).toBe(1);
    expect(typeof stats["totalFires"]).toBe("number");
    expect(typeof stats["firesPerGame"]).toBe("number");
    const observations = body["observations"];
    expect(isUnknownArray(observations)).toBe(true);
  });

  it("identical body twice returns the same runId (cache hit on second call)", async () => {
    seedGoldDb(ctx.goldDbPath, [{ id: "nba-cache-1", tickCount: 1200 }]);
    const app = await startApp();
    const payload = {
      detector_id: "board-mad",
      params: defaultBoardMadParams(3.0),
      window: { start: "2026-05-23T02:30:00Z", end: "2026-05-23T05:00:00Z" },
      game_ids: ["nba-cache-1"],
    };
    const first = await app.inject({
      method: "POST",
      url: "/v1/backtest",
      headers: authHeaders(),
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/backtest",
      headers: authHeaders(),
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const firstBody = asRecord(first.json(), "first");
    const secondBody = asRecord(second.json(), "second");
    expect(secondBody["runId"]).toBe(firstBody["runId"]);
    expect(secondBody["observations"]).toEqual(firstBody["observations"]);
  });

  it("returns 400 with 'window exceeds 28 days' when end-start > 28 days", async () => {
    seedGoldDb(ctx.goldDbPath, []);
    const app = await startApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/backtest",
      headers: authHeaders(),
      payload: {
        detector_id: "board-mad",
        params: defaultBoardMadParams(3.0),
        window: { start: "2026-04-01T00:00:00Z", end: "2026-05-02T00:00:01Z" },
        game_ids: ["nba-x"],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(asRecord(res.json(), "err")["error"]).toBe("window exceeds 28 days");
  });

  it("returns 400 with 'too many games' when game_ids.length > 20", async () => {
    seedGoldDb(ctx.goldDbPath, []);
    const app = await startApp();
    const tooMany = Array.from({ length: 21 }, (_, i) => `nba-${String(i)}`);
    const res = await app.inject({
      method: "POST",
      url: "/v1/backtest",
      headers: authHeaders(),
      payload: {
        detector_id: "board-mad",
        params: defaultBoardMadParams(3.0),
        window: { start: "2026-05-23T00:00:00Z", end: "2026-05-23T06:00:00Z" },
        game_ids: tooMany,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(asRecord(res.json(), "err")["error"]).toBe("too many games");
  });

  it("returns 400 for an unknown detector_id", async () => {
    seedGoldDb(ctx.goldDbPath, [{ id: "nba-bt-1", tickCount: 100 }]);
    const app = await startApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/backtest",
      headers: authHeaders(),
      payload: {
        detector_id: "nope",
        params: {},
        window: { start: "2026-05-23T00:00:00Z", end: "2026-05-23T06:00:00Z" },
        game_ids: ["nba-bt-1"],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(asRecord(res.json(), "err")["error"]).toContain("unknown detector");
  });

  it("returns 400 for malformed params (e.g. kMad out of range)", async () => {
    seedGoldDb(ctx.goldDbPath, [{ id: "nba-bt-1", tickCount: 100 }]);
    const app = await startApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/backtest",
      headers: authHeaders(),
      payload: {
        detector_id: "board-mad",
        params: { ...defaultBoardMadParams(3.0), kMad: 99 },
        window: { start: "2026-05-23T00:00:00Z", end: "2026-05-23T06:00:00Z" },
        game_ids: ["nba-bt-1"],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("discovers game_ids from v_games when game_ids omitted", async () => {
    seedGoldDb(ctx.goldDbPath, [
      { id: "nba-disc-1", scheduledStart: "2026-05-23T03:00:00Z", tickCount: 200 },
      { id: "nba-disc-2", scheduledStart: "2026-05-23T03:30:00Z", tickCount: 200 },
    ]);
    const app = await startApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/backtest",
      headers: authHeaders(),
      payload: {
        detector_id: "board-mad",
        params: defaultBoardMadParams(3.0),
        window: { start: "2026-05-23T00:00:00Z", end: "2026-05-23T06:00:00Z" },
      },
    });
    expect(res.statusCode).toBe(200);
    const stats = asRecord(asRecord(res.json(), "body")["stats"], "stats");
    expect(stats["gamesInWindow"]).toBe(2);
  });

  it("is tagged 'internal' in /openapi.json", async () => {
    seedGoldDb(ctx.goldDbPath, []);
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: "/openapi.json",
      headers: { "x-signal-token": TEST_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    const body = asRecord(res.json(), "openapi");
    const paths = asRecord(body["paths"], "paths");
    const backtestPath = asRecord(paths["/v1/backtest"], "/v1/backtest entry");
    const post = asRecord(backtestPath["post"], "POST");
    const tags = post["tags"];
    if (!isUnknownArray(tags)) throw new Error("tags not an array");
    const tagStrings = tags.filter((t): t is string => typeof t === "string");
    expect(tagStrings).toContain("internal");
  });

  it("leaves only one detector_runs row after two identical POSTs (UNIQUE preserved)", async () => {
    seedGoldDb(ctx.goldDbPath, [{ id: "nba-once-1", tickCount: 300 }]);
    const app = await startApp();
    const payload = {
      detector_id: "board-mad",
      params: defaultBoardMadParams(3.0),
      window: { start: "2026-05-23T02:30:00Z", end: "2026-05-23T05:00:00Z" },
      game_ids: ["nba-once-1"],
    };
    await app.inject({
      method: "POST",
      url: "/v1/backtest",
      headers: authHeaders(),
      payload,
    });
    await app.inject({
      method: "POST",
      url: "/v1/backtest",
      headers: authHeaders(),
      payload,
    });
    const cacheDb = new Database(ctx.cacheDbPath, { readonly: true });
    try {
      const row = cacheDb
        .prepare(`SELECT COUNT(*) AS n FROM detector_runs WHERE scope = 'window'`)
        .get();
      expect(isRecord(row) ? row["n"] : null).toBe(1);
    } finally {
      cacheDb.close();
    }
  });

  it("changing kMad creates a distinct run (params_hash differs)", async () => {
    seedGoldDb(ctx.goldDbPath, [{ id: "nba-k-1", tickCount: 1000 }]);
    const app = await startApp();
    const k3 = await app.inject({
      method: "POST",
      url: "/v1/backtest",
      headers: authHeaders(),
      payload: {
        detector_id: "board-mad",
        params: defaultBoardMadParams(3.0),
        window: { start: "2026-05-23T02:30:00Z", end: "2026-05-23T05:00:00Z" },
        game_ids: ["nba-k-1"],
      },
    });
    const k6 = await app.inject({
      method: "POST",
      url: "/v1/backtest",
      headers: authHeaders(),
      payload: {
        detector_id: "board-mad",
        params: defaultBoardMadParams(6.0),
        window: { start: "2026-05-23T02:30:00Z", end: "2026-05-23T05:00:00Z" },
        game_ids: ["nba-k-1"],
      },
    });
    expect(k3.statusCode).toBe(200);
    expect(k6.statusCode).toBe(200);
    const k3Id = asRecord(k3.json(), "k3")["runId"];
    const k6Id = asRecord(k6.json(), "k6")["runId"];
    expect(k6Id).not.toBe(k3Id);
  });
});
