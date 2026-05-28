// Ensemble-or live route contract tests (phase B2, 2026-05-25).
//
// Verifies the bet365-demo critical-path live surface. The math is exercised
// by runner.parity.test.ts (board-lane byte-equal vs standalone board-mad);
// here we just prove the route exists, returns the right shape with both
// lanes, and goes through the shared runner cache.

import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/server";
import {
  BASELINE_DEFAULTS,
  invalidateDetectorDefaultsCache,
  setDetectorDefaultsPath,
  writeDetectorDefaults,
} from "../src/services/detector-defaults";
import { tsBoardVolatilityRunner } from "./helpers/board-volatility-runner";

type FastifyApp = Awaited<ReturnType<typeof buildServer>>;

const TEST_TOKEN = "ensemble-or-test-token";
const GAME_ID = "nba-ens-route-1";

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

function seedGoldDb(path: string): void {
  const db = new Database(path);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY,
        sport TEXT,
        scheduled_start TEXT
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
      CREATE TABLE IF NOT EXISTS nba_play_by_play_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id TEXT NOT NULL,
        time_actual TEXT,
        period INTEGER,
        clock TEXT
      );
      CREATE TABLE IF NOT EXISTS market_microstructure_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id TEXT NOT NULL,
        source_market_id TEXT NOT NULL,
        event_timestamp TEXT NOT NULL,
        source TEXT NOT NULL,
        event_type TEXT NOT NULL,
        trade_price REAL,
        volume_share REAL
      );
    `);
    const TIPOFF_MS = Date.parse("2026-05-23T03:00:00.000Z");
    db.prepare(`INSERT INTO games (id, sport, scheduled_start) VALUES (?, 'NBA', ?)`).run(
      GAME_ID,
      "2026-05-23T03:00:00.000Z",
    );
    db.prepare(`INSERT INTO source_markets (id, game_id) VALUES (?, ?)`).run(
      `mkt-${GAME_ID}`,
      GAME_ID,
    );
    // 30 ticks across 15 game minutes (every 30s). Reaves-shape pattern
    // with a sharp swing at minute 11 — enough activity to populate the
    // board lane's bucket series.
    const insertTick = db.prepare(
      `INSERT INTO quote_ticks (source_market_id, captured_at, implied_probability, volume)
       VALUES (?, ?, ?, ?)`,
    );
    for (let i = 0; i < 30; i += 1) {
      const tMs = TIPOFF_MS + i * 30_000;
      const ip = i === 22 ? 0.95 : 0.4 + ((i * 0.013) % 0.2);
      insertTick.run(`mkt-${GAME_ID}`, new Date(tMs).toISOString(), ip, 10 + (i % 5));
    }
    const insertPbp = db.prepare(
      `INSERT INTO nba_play_by_play_actions (game_id, time_actual, period, clock)
       VALUES (?, ?, ?, ?)`,
    );
    for (let i = 0; i < 30; i += 1) {
      const tMs = TIPOFF_MS + i * 30_000;
      const elapsedSec = i * 30;
      const periodElapsed = elapsedSec % (12 * 60);
      const minutesRemaining = Math.floor((12 * 60 - periodElapsed) / 60);
      const secondsRemaining = (12 * 60 - periodElapsed) % 60;
      const clock = `PT${String(minutesRemaining).padStart(2, "0")}M${String(secondsRemaining).padStart(2, "0")}.00S`;
      insertPbp.run(GAME_ID, new Date(tMs).toISOString(), 1, clock);
    }
    // One Polymarket off-price print that crosses thresholds. trade_price
    // 0.99 vs the seeded prior tick at i=12 (ip≈0.556) gives off-price-
    // distance ≈ 0.434 > 0.4 default threshold, and volume_share 0.3 > 0.1.
    db.prepare(
      `INSERT INTO market_microstructure_events
        (game_id, source_market_id, event_timestamp, source, event_type, trade_price, volume_share)
       VALUES (?, ?, ?, 'polymarket', 'trade', ?, ?)`,
    ).run(GAME_ID, `mkt-${GAME_ID}`, "2026-05-23T03:06:00.000Z", 0.99, 0.3);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  ctx.tempDir = mkdtempSync(join(tmpdir(), "signal-console-ens-route-"));
  ctx.tokenPath = join(ctx.tempDir, "token");
  ctx.goldDbPath = join(ctx.tempDir, "gold.sqlite");
  ctx.cacheDbPath = join(ctx.tempDir, "cache.sqlite");
  writeFileSync(ctx.tokenPath, `${TEST_TOKEN}\n`, "utf8");
  setDetectorDefaultsPath(join(ctx.tempDir, "detector-defaults.json"));
  invalidateDetectorDefaultsCache();
  seedGoldDb(ctx.goldDbPath);
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
    ensembleOr: {
      goldDbPath: ctx.goldDbPath,
      cacheDbPath: ctx.cacheDbPath,
      boardVolatilityRunner: tsBoardVolatilityRunner,
    },
  });
  ctx.app = app;
  return app;
}

function authHeaders(): Record<string, string> {
  return { "x-signal-token": TEST_TOKEN };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

describe("ensemble-or live route (phase B2)", () => {
  it("GET /v1/ensemble-or/:gameId returns { gameId, runId, boardObservations, fires }", async () => {
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: `/v1/ensemble-or/${GAME_ID}`,
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body: unknown = res.json();
    if (!isRecord(body)) throw new Error("body not an object");
    expect(body["gameId"]).toBe(GAME_ID);
    expect(typeof body["runId"]).toBe("number");
    const boardObs = body["boardObservations"];
    if (!Array.isArray(boardObs)) throw new Error("boardObservations not an array");
    // Board lane must have observations from the seeded ticks.
    expect(boardObs.length).toBeGreaterThan(0);
    // Each observation has the board shape.
    for (const obs of boardObs) {
      if (!isRecord(obs)) throw new Error("obs shape");
      expect(typeof obs["bucketStart"]).toBe("string");
      expect(typeof obs["intensity"]).toBe("number");
      expect(typeof obs["warmedUp"]).toBe("boolean");
    }
    const fires = body["fires"];
    if (!Array.isArray(fires)) throw new Error("fires not an array");
    // At least the off-price fire from the seeded MME event.
    const lanes = new Set(
      fires.map((f) => (isRecord(f) && typeof f["lane"] === "string" ? f["lane"] : "?")),
    );
    expect(lanes.has("offprice")).toBe(true);
  });

  it("second call hits the cache (same runId)", async () => {
    const app = await startApp();
    const first = await app.inject({
      method: "GET",
      url: `/v1/ensemble-or/${GAME_ID}`,
      headers: authHeaders(),
    });
    const second = await app.inject({
      method: "GET",
      url: `/v1/ensemble-or/${GAME_ID}`,
      headers: authHeaders(),
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const firstBody: unknown = first.json();
    const secondBody: unknown = second.json();
    if (!isRecord(firstBody) || !isRecord(secondBody)) throw new Error("body shape");
    expect(secondBody["runId"]).toBe(firstBody["runId"]);
  });

  it("at= historical replay uses only data available through that instant", async () => {
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: `/v1/ensemble-or/${GAME_ID}?at=${encodeURIComponent("2026-05-23T03:05:00.000Z")}`,
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body: unknown = res.json();
    if (!isRecord(body)) throw new Error("body not an object");
    const fires = body["fires"];
    if (!Array.isArray(fires)) throw new Error("fires not an array");
    const hasFutureOffprice = fires.some(
      (fire) =>
        isRecord(fire) &&
        fire["lane"] === "offprice" &&
        fire["bucketStart"] === "2026-05-23T03:06:00.000Z",
    );
    expect(hasFutureOffprice).toBe(false);
  });

  it("requires auth token", async () => {
    const app = await startApp();
    const res = await app.inject({ method: "GET", url: `/v1/ensemble-or/${GAME_ID}` });
    expect(res.statusCode).toBe(401);
  });

  // Codex B-followup #3 review P2 (2026-05-25): the route's `k` field must
  // be the EXACT resolved kMadLive the runner computed with. The web client
  // schema is now strict (no default) so any drift between the runtime
  // default and the echoed value would surface as a Zod parse error in
  // the browser; this server-side test pins the contract from the API side
  // so a future refactor can't silently break the echo.
  it("response k field echoes the exact runtime kMadLive (non-default value)", async () => {
    // Tighten kMadLive to a non-default value via the runtime settings file.
    writeDetectorDefaults({ ...BASELINE_DEFAULTS, kMadLive: 7.25 });
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: `/v1/ensemble-or/${GAME_ID}`,
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body: unknown = res.json();
    if (!isRecord(body)) throw new Error("body not an object");
    // The K we get back MUST be the K we set. If it were the K_MAD_LIVE
    // default (3.0) we'd know the route is reading from somewhere other
    // than the resolved live params.
    expect(body["k"]).toBe(7.25);
  });
});
