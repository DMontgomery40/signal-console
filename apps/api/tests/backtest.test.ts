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
  readonly pbpTimes?: readonly string[];
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
      event_type TEXT NOT NULL DEFAULT 'trade',
      volume_share REAL,
      trade_price REAL
    );
    CREATE TABLE IF NOT EXISTS game_states (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS nba_play_by_play_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      time_actual TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_quote_ticks_source_market
      ON quote_ticks(source_market_id, captured_at);
    CREATE INDEX IF NOT EXISTS idx_pbp_game_time
      ON nba_play_by_play_actions(game_id, time_actual);
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
  const insertPbp = db.prepare(
    `INSERT INTO nba_play_by_play_actions (game_id, time_actual) VALUES (?, ?)`,
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
    for (const t of g.pbpTimes ?? []) {
      insertPbp.run(g.id, t);
    }
  }
  db.close();
}

interface SeedMicroEvent {
  readonly gameId: string;
  readonly sourceMarketId: string;
  readonly eventTimestamp: string;
  readonly tradePrice: number;
  readonly volumeShare: number;
  readonly source?: string;
  readonly eventType?: string;
  readonly sampledPriceAt?: string;
  readonly sampledImpliedProbability?: number;
}

function seedMicrostructure(path: string, events: readonly SeedMicroEvent[]): void {
  const db = new Database(path);
  const insertEvent = db.prepare(
    `INSERT INTO market_microstructure_events
       (game_id, source_market_id, event_timestamp, source, event_type, volume_share, trade_price)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertTick = db.prepare(
    `INSERT INTO quote_ticks (source_market_id, captured_at, implied_probability, volume, is_heartbeat)
     VALUES (?, ?, ?, ?, 0)`,
  );
  for (const e of events) {
    insertEvent.run(
      e.gameId,
      e.sourceMarketId,
      e.eventTimestamp,
      e.source ?? "polymarket",
      e.eventType ?? "trade",
      e.volumeShare,
      e.tradePrice,
    );
    if (e.sampledImpliedProbability !== undefined && e.sampledPriceAt !== undefined) {
      insertTick.run(e.sourceMarketId, e.sampledPriceAt, e.sampledImpliedProbability, 100);
    }
  }
  db.close();
}

function seedPbp(path: string, gameId: string, times: readonly string[]): void {
  const db = new Database(path);
  try {
    const insert = db.prepare(
      `INSERT INTO nba_play_by_play_actions (game_id, time_actual) VALUES (?, ?)`,
    );
    for (const t of times) insert.run(gameId, t);
  } finally {
    db.close();
  }
}

function seedQuoteTick(
  path: string,
  sourceMarketId: string,
  capturedAt: string,
  impliedProbability: number,
): void {
  const db = new Database(path);
  try {
    db.prepare(
      `INSERT INTO quote_ticks (source_market_id, captured_at, implied_probability, volume, is_heartbeat)
       VALUES (?, ?, ?, 1, 0)`,
    ).run(sourceMarketId, capturedAt, impliedProbability);
  } finally {
    db.close();
  }
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

  // AMENDED 2026-05-25 (audit-fix A0-followup #1, Codex review P1):
  // The runner loads ticks via the scheduled-start anchor when PBP is
  // missing (clockSource="scheduled"). Cache identity includes clockSource +
  // tipoffAnchorUtc, so the scheduled-anchored result invalidates when PBP
  // arrives. The OLD "fails closed even when ticks exist" behavior is now
  // preserved only for games with NEITHER PBP NOR scheduled_start — see
  // the next test.
  it("loads ticks via scheduled-start fallback when PBP is missing, then invalidates when PBP arrives", async () => {
    seedGoldDb(ctx.goldDbPath, [{ id: "nba-no-pbp-backtest-1", tickCount: 1200 }]);
    const app = await startApp();
    const payload = {
      detector_id: "board-mad",
      params: defaultBoardMadParams(3.0),
      window: { start: "2026-05-23T02:30:00Z", end: "2026-05-23T05:00:00Z" },
      game_ids: ["nba-no-pbp-backtest-1"],
    };

    // PBP is missing but games.scheduled_start exists (default 2026-05-23T03:00:00Z
    // from seedGoldDb). Detector sees ticks via the scheduled-anchored window.
    const first = await app.inject({
      method: "POST",
      url: "/v1/backtest",
      headers: authHeaders(),
      payload,
    });
    expect(first.statusCode).toBe(200);
    const firstBody = asRecord(first.json(), "first scheduled-anchored");
    const firstObs = firstBody["observations"];
    if (!Array.isArray(firstObs)) throw new Error("observations not array");
    expect(firstObs.length).toBeGreaterThan(0);

    // Same payload again → cache hit, same runId.
    const cached = await app.inject({
      method: "POST",
      url: "/v1/backtest",
      headers: authHeaders(),
      payload,
    });
    expect(cached.statusCode).toBe(200);
    const cachedBody = asRecord(cached.json(), "scheduled cache hit");
    expect(cachedBody["runId"]).toBe(firstBody["runId"]);

    // PBP arrives → clockSource flips to "pbp" → watermark hash changes →
    // new runId. This is the cache-invalidation contract that closes the
    // "scheduled fallback silently lingering after PBP catches up" gap.
    const goldDb = new Database(ctx.goldDbPath);
    try {
      const insertPbp = goldDb.prepare(
        `INSERT INTO nba_play_by_play_actions (game_id, time_actual) VALUES (?, ?)`,
      );
      insertPbp.run("nba-no-pbp-backtest-1", "2026-05-23T03:00:00.000Z");
      insertPbp.run("nba-no-pbp-backtest-1", "2026-05-23T04:30:00.000Z");
    } finally {
      goldDb.close();
    }

    const afterPbp = await app.inject({
      method: "POST",
      url: "/v1/backtest",
      headers: authHeaders(),
      payload,
    });
    expect(afterPbp.statusCode).toBe(200);
    const afterPbpBody = asRecord(afterPbp.json(), "after-pbp");
    expect(afterPbpBody["runId"]).not.toBe(firstBody["runId"]);
  });

  it("fails closed when neither PBP nor scheduled_start exists for the game", async () => {
    // Seed an empty schema (tables created, no games row inserted) so the
    // gold DB exists but resolveGameTimingContext returns clockSource="none"
    // for the requested gameId. resolveEffectiveTickWindow returns null →
    // ticks = [] → no observations. This is the genuine no-anchor case.
    seedGoldDb(ctx.goldDbPath, []);
    const app = await startApp();
    const payload = {
      detector_id: "board-mad",
      params: defaultBoardMadParams(3.0),
      window: { start: "2026-05-23T02:30:00Z", end: "2026-05-23T05:00:00Z" },
      game_ids: ["nba-no-anchor-at-all"],
    };

    const first = await app.inject({
      method: "POST",
      url: "/v1/backtest",
      headers: authHeaders(),
      payload,
    });
    expect(first.statusCode).toBe(200);
    const firstBody = asRecord(first.json(), "no-anchor first");
    expect(firstBody["observations"]).toEqual([]);
  });

  it("treats explicit game_ids as a canonical set for cache and stats", async () => {
    seedGoldDb(ctx.goldDbPath, [{ id: "nba-canon-1", tickCount: 1200 }]);
    const app = await startApp();
    const uniquePayload = {
      detector_id: "board-mad",
      params: defaultBoardMadParams(3.0),
      window: { start: "2026-05-23T02:30:00Z", end: "2026-05-23T05:00:00Z" },
      game_ids: ["nba-canon-1"],
    };
    const duplicatePayload = {
      ...uniquePayload,
      game_ids: [" nba-canon-1 ", "nba-canon-1"],
    };

    const first = await app.inject({
      method: "POST",
      url: "/v1/backtest",
      headers: authHeaders(),
      payload: uniquePayload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/backtest",
      headers: authHeaders(),
      payload: duplicatePayload,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const firstBody = asRecord(first.json(), "first");
    const secondBody = asRecord(second.json(), "second");
    expect(secondBody["runId"]).toBe(firstBody["runId"]);
    const stats = asRecord(secondBody["stats"], "stats");
    expect(stats["gamesInWindow"]).toBe(1);

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

  it("canonicalizes equivalent window timestamps before SQL filtering and cache identity", async () => {
    seedGoldDb(ctx.goldDbPath, [{ id: "nba-window-canon-1", tickCount: 1200 }]);
    const app = await startApp();
    const utcPayload = {
      detector_id: "board-mad",
      params: defaultBoardMadParams(3.0),
      window: {
        start: "2026-05-23T02:30:00.000Z",
        end: "2026-05-23T05:00:00.000Z",
      },
      game_ids: ["nba-window-canon-1"],
    };
    const offsetPayload = {
      ...utcPayload,
      window: {
        start: "2026-05-22T20:30:00-06:00",
        end: "2026-05-22T23:00:00-06:00",
      },
    };

    const first = await app.inject({
      method: "POST",
      url: "/v1/backtest",
      headers: authHeaders(),
      payload: utcPayload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/backtest",
      headers: authHeaders(),
      payload: offsetPayload,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const firstBody = asRecord(first.json(), "first");
    const secondBody = asRecord(second.json(), "second");
    expect(secondBody["runId"]).toBe(firstBody["runId"]);

    const cacheDb = new Database(ctx.cacheDbPath, { readonly: true });
    try {
      const rows = cacheDb
        .prepare(
          `SELECT window_start, window_end FROM detector_runs
           WHERE scope = 'window'
           ORDER BY id`,
        )
        .all();
      expect(rows).toHaveLength(1);
      const row = asRecord(rows[0], "detector_runs row");
      expect(row["window_start"]).toBe("2026-05-23T02:30:00.000Z");
      expect(row["window_end"]).toBe("2026-05-23T05:00:00.000Z");
    } finally {
      cacheDb.close();
    }
  });

  it("canonicalizes equivalent window timestamps before game discovery", async () => {
    seedGoldDb(ctx.goldDbPath, [
      { id: "nba-discovery-canon-1", scheduledStart: "2026-05-23T03:00:00Z", tickCount: 200 },
    ]);
    const app = await startApp();
    const utcPayload = {
      detector_id: "board-mad",
      params: defaultBoardMadParams(3.0),
      window: {
        start: "2026-05-23T02:30:00.000Z",
        end: "2026-05-23T05:00:00.000Z",
      },
    };
    const offsetPayload = {
      ...utcPayload,
      window: {
        start: "2026-05-22T20:30:00-06:00",
        end: "2026-05-22T23:00:00-06:00",
      },
    };

    const first = await app.inject({
      method: "POST",
      url: "/v1/backtest",
      headers: authHeaders(),
      payload: utcPayload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/backtest",
      headers: authHeaders(),
      payload: offsetPayload,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const firstBody = asRecord(first.json(), "first");
    const secondBody = asRecord(second.json(), "second");
    expect(secondBody["runId"]).toBe(firstBody["runId"]);
    expect(asRecord(secondBody["stats"], "stats")["gamesInWindow"]).toBe(1);
  });

  it("rejects timezone-less and calendar-overflow backtest window timestamps before normalization", async () => {
    seedGoldDb(ctx.goldDbPath, [{ id: "nba-window-localtime-1", tickCount: 0 }]);
    const app = await startApp();
    const cases = [
      { start: "2026-05-23T02:30:00", end: "2026-05-23T05:00:00Z" },
      { start: "2026-05-23T02:30:00Z", end: "2026-05-23T05:00:00" },
      { start: "2026-02-30T02:30:00Z", end: "2026-05-23T05:00:00Z" },
      { start: "2026-05-23T02:30:00Z", end: "2026-04-31T05:00:00Z" },
    ];

    for (const window of cases) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/backtest",
        headers: authHeaders(),
        payload: {
          detector_id: "board-mad",
          params: defaultBoardMadParams(3.0),
          window,
          game_ids: ["nba-window-localtime-1"],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(asRecord(res.json(), "err")["error"]).toBe("invalid window timestamps");
    }
  });

  it("invalidates cached backtests when PBP-derived tick bounds change", async () => {
    seedGoldDb(ctx.goldDbPath, [{ id: "nba-pbp-watermark-1", tickCount: 1200 }]);
    const app = await startApp();
    const payload = {
      detector_id: "board-mad",
      params: defaultBoardMadParams(3.0),
      window: {
        start: "2026-05-23T02:30:00.000Z",
        end: "2026-05-23T05:00:00.000Z",
      },
      game_ids: ["nba-pbp-watermark-1"],
    };

    const first = await app.inject({
      method: "POST",
      url: "/v1/backtest",
      headers: authHeaders(),
      payload,
    });
    expect(first.statusCode).toBe(200);
    const firstBody = asRecord(first.json(), "first");

    seedPbp(ctx.goldDbPath, "nba-pbp-watermark-1", [
      "2026-05-23T03:25:00.000Z",
      "2026-05-23T04:10:00.000Z",
    ]);

    const second = await app.inject({
      method: "POST",
      url: "/v1/backtest",
      headers: authHeaders(),
      payload,
    });
    expect(second.statusCode).toBe(200);
    const secondBody = asRecord(second.json(), "second");
    expect(secondBody["runId"]).not.toBe(firstBody["runId"]);

    const cacheDb = new Database(ctx.cacheDbPath, { readonly: true });
    try {
      const row = cacheDb
        .prepare(`SELECT COUNT(*) AS n FROM detector_runs WHERE scope = 'window'`)
        .get();
      expect(isRecord(row) ? row["n"] : null).toBe(2);
    } finally {
      cacheDb.close();
    }
  });

  it("keeps cached backtests when quote ticks change outside PBP-derived tick bounds", async () => {
    seedGoldDb(ctx.goldDbPath, [
      {
        id: "nba-pbp-relevance-1",
        pbpTimes: ["2026-05-23T03:30:00.000Z", "2026-05-23T04:00:00.000Z"],
        tickCount: 1200,
      },
    ]);
    const app = await startApp();
    const payload = {
      detector_id: "board-mad",
      params: defaultBoardMadParams(3.0),
      window: {
        start: "2026-05-23T02:30:00.000Z",
        end: "2026-05-23T05:00:00.000Z",
      },
      game_ids: ["nba-pbp-relevance-1"],
    };

    const first = await app.inject({
      method: "POST",
      url: "/v1/backtest",
      headers: authHeaders(),
      payload,
    });
    expect(first.statusCode).toBe(200);
    const firstBody = asRecord(first.json(), "first");

    seedQuoteTick(ctx.goldDbPath, "mkt-nba-pbp-relevance-1-0", "2026-05-23T03:10:00.000Z", 0.99);

    const second = await app.inject({
      method: "POST",
      url: "/v1/backtest",
      headers: authHeaders(),
      payload,
    });
    expect(second.statusCode).toBe(200);
    const secondBody = asRecord(second.json(), "second");
    expect(secondBody["runId"]).toBe(firstBody["runId"]);

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

  it("keeps cached board-mad backtests when microstructure rows change", async () => {
    seedGoldDb(ctx.goldDbPath, [{ id: "nba-board-mme-irrelevant-1", tickCount: 1200 }]);
    const app = await startApp();
    const payload = {
      detector_id: "board-mad",
      params: defaultBoardMadParams(3.0),
      window: {
        start: "2026-05-23T02:30:00.000Z",
        end: "2026-05-23T05:00:00.000Z",
      },
      game_ids: ["nba-board-mme-irrelevant-1"],
    };

    const first = await app.inject({
      method: "POST",
      url: "/v1/backtest",
      headers: authHeaders(),
      payload,
    });
    expect(first.statusCode).toBe(200);
    const firstBody = asRecord(first.json(), "first");

    seedMicrostructure(ctx.goldDbPath, [
      {
        eventTimestamp: "2026-05-23T03:42:00.000Z",
        gameId: "nba-board-mme-irrelevant-1",
        sourceMarketId: "pm-board-mme-irrelevant-1",
        tradePrice: 0.99,
        volumeShare: 0.5,
      },
    ]);

    const second = await app.inject({
      method: "POST",
      url: "/v1/backtest",
      headers: authHeaders(),
      payload,
    });
    expect(second.statusCode).toBe(200);
    const secondBody = asRecord(second.json(), "second");
    expect(secondBody["runId"]).toBe(firstBody["runId"]);

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

  it("returns 400 when explicit game_ids contain a blank id", async () => {
    seedGoldDb(ctx.goldDbPath, []);
    const app = await startApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/backtest",
      headers: authHeaders(),
      payload: {
        detector_id: "board-mad",
        params: defaultBoardMadParams(3.0),
        window: { start: "2026-05-23T00:00:00Z", end: "2026-05-23T06:00:00Z" },
        game_ids: [" "],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(asRecord(res.json(), "err")["error"]).toBe("invalid game_ids");
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

  // Regression for the production-schema mismatch where backtest.ts queried a
  // non-existent off_price_distance column on market_microstructure_events.
  // off_price_distance is computed at query time: |trade_price - latest
  // pre-event sampled implied_probability for the same source_market|. This
  // test asserts the off-price-print detector fires on a Reaves-shaped trade
  // (trade ≈ 0.99, surrounding sampled price ≈ 0.50, volume_share ≥ 0.10).
  it("off-price-print fires when trade_price is far from the latest pre-event sampled price", async () => {
    seedGoldDb(ctx.goldDbPath, [
      { id: "nba-opp-1", scheduledStart: "2026-05-12T01:30:00Z", tickCount: 0 },
    ]);
    seedMicrostructure(ctx.goldDbPath, [
      {
        gameId: "nba-opp-1",
        sourceMarketId: "pm-opp-1-over",
        eventTimestamp: "2026-05-12T04:52:18.000Z",
        tradePrice: 0.9894,
        volumeShare: 0.246,
        sampledPriceAt: "2026-05-12T04:52:05.000Z",
        sampledImpliedProbability: 0.495,
      },
    ]);
    const app = await startApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/backtest",
      headers: authHeaders(),
      payload: {
        detector_id: "off-price-print",
        params: { minVolumeShare: 0.1, minOffPriceDistance: 0.4 },
        window: { start: "2026-05-12T04:00:00Z", end: "2026-05-12T05:00:00Z" },
        game_ids: ["nba-opp-1"],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = asRecord(res.json(), "off-price body");
    const stats = asRecord(body["stats"], "stats");
    expect(stats["totalFires"]).toBe(1);
    const observations = body["observations"];
    if (!isUnknownArray(observations)) throw new Error("observations not array");
    const fired = observations.map((o) => asRecord(o, "obs")).filter((o) => o["fired"] === 1);
    expect(fired).toHaveLength(1);
    // intensity = off_price_distance = |0.9894 - 0.495| ≈ 0.494
    const intensity = fired[0]?.["intensity"];
    if (typeof intensity !== "number") throw new Error("intensity not numeric");
    expect(Math.abs(intensity - 0.4944)).toBeLessThan(0.005);
  });

  it("keeps cached off-price-print backtests when non-Polymarket trade rows change", async () => {
    seedGoldDb(ctx.goldDbPath, [
      { id: "nba-opp-kalshi-1", scheduledStart: "2026-05-12T01:30:00Z", tickCount: 0 },
    ]);
    const app = await startApp();
    const payload = {
      detector_id: "off-price-print",
      params: { minVolumeShare: 0.1, minOffPriceDistance: 0.4 },
      window: { start: "2026-05-12T04:00:00Z", end: "2026-05-12T05:00:00Z" },
      game_ids: ["nba-opp-kalshi-1"],
    };

    const first = await app.inject({
      method: "POST",
      url: "/v1/backtest",
      headers: authHeaders(),
      payload,
    });
    expect(first.statusCode).toBe(200);
    const firstBody = asRecord(first.json(), "first kalshi");

    seedMicrostructure(ctx.goldDbPath, [
      {
        eventTimestamp: "2026-05-12T04:52:18.000Z",
        gameId: "nba-opp-kalshi-1",
        sampledImpliedProbability: 0.495,
        sampledPriceAt: "2026-05-12T04:52:05.000Z",
        source: "kalshi",
        sourceMarketId: "mkt-nba-opp-kalshi-1-0",
        tradePrice: 0.9894,
        volumeShare: 0.246,
      },
    ]);

    const second = await app.inject({
      method: "POST",
      url: "/v1/backtest",
      headers: authHeaders(),
      payload,
    });
    expect(second.statusCode).toBe(200);
    const secondBody = asRecord(second.json(), "second kalshi");
    expect(secondBody["runId"]).toBe(firstBody["runId"]);
    const stats = asRecord(secondBody["stats"], "second stats");
    expect(stats["totalFires"]).toBe(0);
  });

  it("invalidates off-price-print backtests when prior sampled quote ticks change", async () => {
    seedGoldDb(ctx.goldDbPath, [
      { id: "nba-opp-quote-cache-1", scheduledStart: "2026-05-12T01:30:00Z", tickCount: 0 },
    ]);
    seedMicrostructure(ctx.goldDbPath, [
      {
        eventTimestamp: "2026-05-12T04:52:18.000Z",
        gameId: "nba-opp-quote-cache-1",
        sampledImpliedProbability: 0.495,
        sampledPriceAt: "2026-05-12T04:52:05.000Z",
        sourceMarketId: "mkt-nba-opp-quote-cache-1-0",
        tradePrice: 0.9894,
        volumeShare: 0.246,
      },
    ]);
    const app = await startApp();
    const payload = {
      detector_id: "off-price-print",
      params: { minOffPriceDistance: 0.4, minVolumeShare: 0.1 },
      window: { end: "2026-05-12T05:00:00Z", start: "2026-05-12T04:00:00Z" },
      game_ids: ["nba-opp-quote-cache-1"],
    };

    const first = await app.inject({
      method: "POST",
      url: "/v1/backtest",
      headers: authHeaders(),
      payload,
    });
    expect(first.statusCode).toBe(200);
    const firstBody = asRecord(first.json(), "first");

    seedQuoteTick(ctx.goldDbPath, "mkt-nba-opp-quote-cache-1-0", "2026-05-12T04:52:10.000Z", 0.2);

    const second = await app.inject({
      method: "POST",
      url: "/v1/backtest",
      headers: authHeaders(),
      payload,
    });
    expect(second.statusCode).toBe(200);
    const secondBody = asRecord(second.json(), "second");
    expect(secondBody["runId"]).not.toBe(firstBody["runId"]);

    const cacheDb = new Database(ctx.cacheDbPath, { readonly: true });
    try {
      const row = cacheDb
        .prepare(`SELECT COUNT(*) AS n FROM detector_runs WHERE scope = 'window'`)
        .get();
      expect(isRecord(row) ? row["n"] : null).toBe(2);
    } finally {
      cacheDb.close();
    }
  });

  // Companion guard: when there is no surrounding quote_tick (subquery returns
  // NULL → COALESCE → 0), the detector must NOT fire, even on a 0.99 trade
  // with high volume_share. This is the failure mode the broken column query
  // hid: every event silently had off_price_distance=0 instead of 500-ing or
  // computing it, so no Polymarket print could ever fire.
  it("off-price-print does NOT fire when there is no prior sampled price (no ghost-zero leak)", async () => {
    seedGoldDb(ctx.goldDbPath, [
      { id: "nba-opp-2", scheduledStart: "2026-05-12T01:30:00Z", tickCount: 0 },
    ]);
    seedMicrostructure(ctx.goldDbPath, [
      {
        gameId: "nba-opp-2",
        sourceMarketId: "pm-opp-2-over",
        eventTimestamp: "2026-05-12T04:52:18.000Z",
        tradePrice: 0.9894,
        volumeShare: 0.246,
        // no sampled tick — subquery returns NULL → distance is COALESCEd to 0
      },
    ]);
    const app = await startApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/backtest",
      headers: authHeaders(),
      payload: {
        detector_id: "off-price-print",
        params: { minVolumeShare: 0.1, minOffPriceDistance: 0.4 },
        window: { start: "2026-05-12T04:00:00Z", end: "2026-05-12T05:00:00Z" },
        game_ids: ["nba-opp-2"],
      },
    });
    expect(res.statusCode).toBe(200);
    const stats = asRecord(asRecord(res.json(), "no-prior body")["stats"], "stats");
    expect(stats["totalFires"]).toBe(0);
  });
});
