// Off-price-print live route contract tests (phase B2, 2026-05-25).
//
// Thin smoke around GET /v1/off-price-print/:gameId. The math is exercised
// by detectors + runner parity tests; here we just prove the route exists,
// returns the right shape, and goes through the shared runner cache.

import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/server";
import {
  invalidateDetectorDefaultsCache,
  setDetectorDefaultsPath,
  writeDetectorDefaults,
  BASELINE_DEFAULTS,
} from "../src/services/detector-defaults";

type FastifyApp = Awaited<ReturnType<typeof buildServer>>;

const TEST_TOKEN = "off-price-print-test-token";
const GAME_ID = "nba-opp-route-1";

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
        time_actual TEXT
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
    db.prepare(`INSERT INTO games (id, sport, scheduled_start) VALUES (?, 'NBA', ?)`).run(
      GAME_ID,
      "2026-05-12T01:30:00.000Z",
    );
    db.prepare(`INSERT INTO source_markets (id, game_id) VALUES (?, ?)`).run(
      `mkt-${GAME_ID}`,
      GAME_ID,
    );
    // Seed a prior quote tick so the causal off-price-distance subquery
    // has a sampled IP to compare against.
    db.prepare(
      `INSERT INTO quote_ticks (source_market_id, captured_at, implied_probability, volume)
       VALUES (?, ?, ?, ?)`,
    ).run(`mkt-${GAME_ID}`, "2026-05-12T04:52:05.000Z", 0.495, 10);
    // PBP so resolveGameTimingContext returns clockSource="pbp" and the
    // runner's tick-window resolver finds an in-play boundary.
    db.prepare(`INSERT INTO nba_play_by_play_actions (game_id, time_actual) VALUES (?, ?)`).run(
      GAME_ID,
      "2026-05-12T04:00:00.000Z",
    );
    db.prepare(`INSERT INTO nba_play_by_play_actions (game_id, time_actual) VALUES (?, ?)`).run(
      GAME_ID,
      "2026-05-12T06:00:00.000Z",
    );
    // One Polymarket trade-print that crosses both default thresholds:
    // volumeShare=0.246 >= 0.1 AND |0.9894 - 0.495| ≈ 0.494 >= 0.4.
    db.prepare(
      `INSERT INTO market_microstructure_events
        (game_id, source_market_id, event_timestamp, source, event_type, trade_price, volume_share)
       VALUES (?, ?, ?, 'polymarket', 'trade', ?, ?)`,
    ).run(GAME_ID, `mkt-${GAME_ID}`, "2026-05-12T04:52:18.000Z", 0.9894, 0.246);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  ctx.tempDir = mkdtempSync(join(tmpdir(), "signal-console-opp-route-"));
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
    offPricePrint: { goldDbPath: ctx.goldDbPath, cacheDbPath: ctx.cacheDbPath },
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

describe("off-price-print live route (phase B2)", () => {
  it("GET /v1/off-price-print/:gameId returns { gameId, runId, fires } with the seeded fire", async () => {
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: `/v1/off-price-print/${GAME_ID}`,
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body: unknown = res.json();
    if (!isRecord(body)) throw new Error("body not an object");
    expect(body["gameId"]).toBe(GAME_ID);
    expect(typeof body["runId"]).toBe("number");
    const fires = body["fires"];
    if (!Array.isArray(fires)) throw new Error("fires not an array");
    expect(fires).toHaveLength(1);
    const fire: unknown = fires[0];
    if (!isRecord(fire)) throw new Error("fire not an object");
    expect(fire["bucketStart"]).toBe(fire["bucketEnd"]); // point event
    const intensity = fire["intensity"];
    if (typeof intensity !== "number") throw new Error("intensity not numeric");
    // intensity = off_price_distance = |0.9894 - 0.495| ≈ 0.4944
    expect(Math.abs(intensity - 0.4944)).toBeLessThan(0.005);
  });

  it("second call hits the cache (same runId)", async () => {
    const app = await startApp();
    const first = await app.inject({
      method: "GET",
      url: `/v1/off-price-print/${GAME_ID}`,
      headers: authHeaders(),
    });
    const second = await app.inject({
      method: "GET",
      url: `/v1/off-price-print/${GAME_ID}`,
      headers: authHeaders(),
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const firstBody: unknown = first.json();
    const secondBody: unknown = second.json();
    if (!isRecord(firstBody) || !isRecord(secondBody)) throw new Error("body shape");
    expect(secondBody["runId"]).toBe(firstBody["runId"]);
    // Critical: cache hit must return the same fires (Codex review A0-followup
    // #2 — lane-less off-price fires used to be dropped on cache reload).
    const firstFires = firstBody["fires"];
    const secondFires = secondBody["fires"];
    if (!Array.isArray(firstFires) || !Array.isArray(secondFires)) throw new Error("fires shape");
    expect(secondFires.length).toBe(firstFires.length);
  });

  it("phase B3: raising minOffPriceDistance via detector-defaults suppresses the fire", async () => {
    // The seeded MME event has off-price-distance ≈ 0.4944. At the baseline
    // default threshold 0.4 it fires (proven in the first test). Raise the
    // threshold to 0.7 via /v1/settings/detector-defaults → cache key changes
    // → recompute → no fire.
    const app = await startApp();
    const first = await app.inject({
      method: "GET",
      url: `/v1/off-price-print/${GAME_ID}`,
      headers: authHeaders(),
    });
    const firstJson: unknown = first.json();
    if (!isRecord(firstJson)) throw new Error("first body shape");
    const firstBody = firstJson;
    const firstFires = firstBody["fires"];
    if (!Array.isArray(firstFires)) throw new Error("first fires shape");
    expect(firstFires.length).toBe(1);

    // Tighten the threshold above the seeded event's distance.
    writeDetectorDefaults({
      ...BASELINE_DEFAULTS,
      offPriceMinOffPriceDistance: 0.7,
    });

    const second = await app.inject({
      method: "GET",
      url: `/v1/off-price-print/${GAME_ID}`,
      headers: authHeaders(),
    });
    expect(second.statusCode).toBe(200);
    const secondJson: unknown = second.json();
    if (!isRecord(secondJson)) throw new Error("second body shape");
    const secondFires = secondJson["fires"];
    if (!Array.isArray(secondFires)) throw new Error("second fires shape");
    expect(secondFires.length).toBe(0);
    // runId differs because params changed → paramsHash changed → cache miss.
    expect(secondJson["runId"]).not.toBe(firstBody["runId"]);
  });

  it("returns 400 for invalid params shape", async () => {
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/off-price-print/",
      headers: authHeaders(),
    });
    expect([400, 404]).toContain(res.statusCode);
  });
});
