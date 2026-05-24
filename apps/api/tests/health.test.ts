// Health route contract tests (US-017).

import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/server";

type FastifyApp = Awaited<ReturnType<typeof buildServer>>;

const TEST_TOKEN = "health-test-token";

interface TestCtx {
  app: FastifyApp | null;
  tempDir: string;
  tokenPath: string;
  goldDbPath: string;
}

const ctx: TestCtx = { app: null, tempDir: "", tokenPath: "", goldDbPath: "" };

function seedReadyGoldDb(path: string): void {
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
      source TEXT NOT NULL,
      game_id TEXT NOT NULL,
      instrument_id TEXT,
      raw_family TEXT,
      raw_label TEXT
    );
    CREATE TABLE IF NOT EXISTS quote_ticks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_market_id TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      implied_probability REAL,
      volume REAL,
      is_heartbeat INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS game_states (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS market_microstructure_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      source_market_id TEXT NOT NULL,
      event_timestamp TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      instrument_id TEXT,
      event_type TEXT NOT NULL,
      api_surface TEXT NOT NULL,
      price REAL,
      previous_price REAL,
      source TEXT NOT NULL,
      volume_share REAL,
      trade_price REAL,
      size REAL,
      notional REAL,
      volume REAL,
      final_market_volume REAL,
      best_bid REAL,
      best_ask REAL,
      spread REAL,
      depth_score REAL
    );
    CREATE TABLE IF NOT EXISTS nba_play_by_play_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      time_actual TEXT
    );
  `);
  db.close();
}

function seedOpenableButNotReadyGoldDb(path: string): void {
  const db = new Database(path);
  db.exec("CREATE TABLE IF NOT EXISTS sentinel (id INTEGER PRIMARY KEY)");
  db.close();
}

function seedGoldDbWithLegacyMicrostructureSchema(path: string): void {
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
      source TEXT NOT NULL,
      game_id TEXT NOT NULL,
      instrument_id TEXT,
      raw_family TEXT,
      raw_label TEXT
    );
    CREATE TABLE IF NOT EXISTS quote_ticks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_market_id TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      implied_probability REAL,
      volume REAL,
      is_heartbeat INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS game_states (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS market_microstructure_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      source_market_id TEXT NOT NULL,
      event_timestamp TEXT NOT NULL,
      source TEXT NOT NULL,
      volume_share REAL,
      trade_price REAL
    );
    CREATE TABLE IF NOT EXISTS nba_play_by_play_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      time_actual TEXT
    );
  `);
  db.close();
}

beforeEach(() => {
  ctx.tempDir = mkdtempSync(join(tmpdir(), "signal-console-health-"));
  ctx.tokenPath = join(ctx.tempDir, "token");
  ctx.goldDbPath = join(ctx.tempDir, "gold.sqlite");
  writeFileSync(ctx.tokenPath, `${TEST_TOKEN}\n`, "utf8");
});

afterEach(async () => {
  if (ctx.app !== null) {
    await ctx.app.close();
    ctx.app = null;
  }
  rmSync(ctx.tempDir, { recursive: true, force: true });
});

async function startApp(goldDbPath: string): Promise<FastifyApp> {
  const app = await buildServer({
    auth: { tokenPath: ctx.tokenPath, cacheTtlMs: 0 },
    health: { goldDbPath },
  });
  ctx.app = app;
  return app;
}

describe("health routes (US-017)", () => {
  it("GET /v1/health/live returns 200 { ok: true } without a token", async () => {
    // /v1/health/live is in the auth plugin's exempt list, so a request
    // missing X-Signal-Token must still reach the route and return 200.
    const app = await startApp(ctx.goldDbPath);
    const res = await app.inject({ method: "GET", url: "/v1/health/live" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("GET /v1/health/live returns 200 { ok: true } even when the gold DB is missing", async () => {
    // Verifies the criterion "performs no DB access": pointing at a path
    // that openGoldDb would refuse must NOT affect /v1/health/live.
    const app = await startApp(join(ctx.tempDir, "does-not-exist.sqlite"));
    const res = await app.inject({ method: "GET", url: "/v1/health/live" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("GET /v1/health/ready returns 200 { ok: true } when the gold DB opens", async () => {
    seedReadyGoldDb(ctx.goldDbPath);
    const app = await startApp(ctx.goldDbPath);
    const res = await app.inject({
      method: "GET",
      url: "/v1/health/ready",
      headers: { "x-signal-token": TEST_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("GET /v1/health/ready returns 503 when an openable DB is missing app tables", async () => {
    seedOpenableButNotReadyGoldDb(ctx.goldDbPath);
    const app = await startApp(ctx.goldDbPath);
    const res = await app.inject({
      method: "GET",
      url: "/v1/health/ready",
      headers: { "x-signal-token": TEST_TOKEN },
    });
    expect(res.statusCode).toBe(503);
    const body: unknown = res.json();
    expect(typeof body).toBe("object");
    expect(body).not.toBeNull();
    if (typeof body !== "object" || body === null) {
      throw new Error("body not an object");
    }
    expect("ok" in body && body.ok === false).toBe(true);
    expect("reason" in body && typeof body.reason === "string").toBe(true);
  });

  it("GET /v1/health/ready returns 503 when microstructure runtime columns are missing", async () => {
    seedGoldDbWithLegacyMicrostructureSchema(ctx.goldDbPath);
    const app = await startApp(ctx.goldDbPath);
    const res = await app.inject({
      method: "GET",
      url: "/v1/health/ready",
      headers: { "x-signal-token": TEST_TOKEN },
    });
    expect(res.statusCode).toBe(503);
    const body: unknown = res.json();
    expect(typeof body).toBe("object");
    expect(body).not.toBeNull();
    if (typeof body !== "object" || body === null) {
      throw new Error("body not an object");
    }
    expect("ok" in body && body.ok === false).toBe(true);
    expect("reason" in body && typeof body.reason === "string" && body.reason).toMatch(
      /instrument_id|event_type|api_surface|captured_at|size|notional/i,
    );
  });

  it("GET /v1/health/ready returns 503 { ok: false, reason } when GOLD_DB_PATH points at a missing file", async () => {
    const app = await startApp(join(ctx.tempDir, "does-not-exist.sqlite"));
    const res = await app.inject({
      method: "GET",
      url: "/v1/health/ready",
      headers: { "x-signal-token": TEST_TOKEN },
    });
    expect(res.statusCode).toBe(503);
    const body: unknown = res.json();
    expect(typeof body).toBe("object");
    expect(body).not.toBeNull();
    if (typeof body !== "object" || body === null) {
      throw new Error("body not an object");
    }
    expect("ok" in body && body.ok === false).toBe(true);
    expect("reason" in body && typeof body.reason === "string" && body.reason.length > 0).toBe(
      true,
    );
  });

  it("both health routes appear in /openapi.json tagged 'internal'", async () => {
    const app = await startApp(ctx.goldDbPath);
    const res = await app.inject({
      method: "GET",
      url: "/openapi.json",
      headers: { "x-signal-token": TEST_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    const body: unknown = res.json();

    function isRecord(v: unknown): v is Record<string, unknown> {
      return typeof v === "object" && v !== null;
    }

    if (!isRecord(body)) throw new Error("openapi body not an object");
    const pathsValue = body["paths"];
    if (!isRecord(pathsValue)) throw new Error("openapi body missing paths");

    function tagsForGet(allPaths: Record<string, unknown>, path: string): readonly string[] {
      const entry = allPaths[path];
      if (!isRecord(entry)) throw new Error(`openapi missing path ${path}`);
      const get = entry["get"];
      if (!isRecord(get)) throw new Error(`openapi missing GET on ${path}`);
      const tags = get["tags"];
      if (!Array.isArray(tags)) return [];
      return tags.filter((t): t is string => typeof t === "string");
    }

    expect(tagsForGet(pathsValue, "/v1/health/live")).toContain("internal");
    expect(tagsForGet(pathsValue, "/v1/health/ready")).toContain("internal");
  });
});
