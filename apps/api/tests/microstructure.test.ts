// Microstructure route contract tests (US-029 / PRD §15).
//
// Real on-disk SQLite that mirrors the gold-DB shape for
// market_microstructure_events (the only table /v1/microstructure touches).
// The route opens the fixture path read-only via openGoldDb.

import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/server";

type FastifyApp = Awaited<ReturnType<typeof buildServer>>;

const TEST_TOKEN = "microstructure-test-token";

interface TestCtx {
  app: FastifyApp | null;
  tempDir: string;
  tokenPath: string;
  goldDbPath: string;
}

const ctx: TestCtx = { app: null, tempDir: "", tokenPath: "", goldDbPath: "" };

interface SeedEvent {
  readonly source?: string;
  readonly sourceMarketId: string;
  readonly gameId: string;
  readonly instrumentId?: string | null;
  readonly eventType?: string;
  readonly apiSurface?: string;
  readonly eventTimestamp: string;
  readonly capturedAt?: string;
  readonly volumeShare?: number | null;
  readonly tradePrice?: number | null;
  readonly size?: number | null;
}

function seedGoldDb(path: string, events: readonly SeedEvent[]): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS market_microstructure_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      source_market_id TEXT NOT NULL,
      game_id TEXT NOT NULL,
      instrument_id TEXT,
      event_type TEXT NOT NULL,
      api_surface TEXT NOT NULL,
      event_timestamp TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      price REAL,
      previous_price REAL,
      trade_price REAL,
      size REAL,
      notional REAL,
      volume REAL,
      final_market_volume REAL,
      volume_share REAL,
      best_bid REAL,
      best_ask REAL,
      spread REAL,
      depth_score REAL,
      raw_payload_id INTEGER,
      raw_metadata_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_market_microstructure_game_time
      ON market_microstructure_events(game_id, event_timestamp DESC);
  `);
  const insert = db.prepare(
    `INSERT INTO market_microstructure_events
      (source, source_market_id, game_id, instrument_id, event_type, api_surface,
       event_timestamp, captured_at, volume_share, trade_price, size)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const e of events) {
    insert.run(
      e.source ?? "test-source",
      e.sourceMarketId,
      e.gameId,
      e.instrumentId ?? null,
      e.eventType ?? "trade",
      e.apiSurface ?? "rest",
      e.eventTimestamp,
      e.capturedAt ?? e.eventTimestamp,
      e.volumeShare ?? null,
      e.tradePrice ?? null,
      e.size ?? null,
    );
  }
  db.close();
}

beforeEach(() => {
  ctx.tempDir = mkdtempSync(join(tmpdir(), "signal-console-microstructure-"));
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

async function startApp(): Promise<FastifyApp> {
  const app = await buildServer({
    auth: { tokenPath: ctx.tokenPath, cacheTtlMs: 0 },
    microstructure: { goldDbPath: ctx.goldDbPath },
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

function readEvents(body: unknown): readonly Record<string, unknown>[] {
  const rec = asRecord(body, "body");
  const events = rec["events"];
  if (!isUnknownArray(events)) throw new Error("body.events not an array");
  return events.map((e, i) => asRecord(e, `event[${String(i)}]`));
}

describe("microstructure route (US-029)", () => {
  it("theta=0.5 filters out events with volume_share=0.3", async () => {
    seedGoldDb(ctx.goldDbPath, [
      {
        sourceMarketId: "mkt-A",
        gameId: "nba-theta-1",
        eventTimestamp: "2026-05-23T10:00:00.000Z",
        volumeShare: 0.3,
      },
      {
        sourceMarketId: "mkt-A",
        gameId: "nba-theta-1",
        eventTimestamp: "2026-05-23T10:00:01.000Z",
        volumeShare: 0.7,
      },
      {
        sourceMarketId: "mkt-A",
        gameId: "nba-theta-1",
        eventTimestamp: "2026-05-23T10:00:02.000Z",
        volumeShare: 0.5,
      },
    ]);
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/microstructure/nba-theta-1?theta=0.5",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = asRecord(res.json(), "body");
    expect(body["gameId"]).toBe("nba-theta-1");
    expect(body["theta"]).toBe(0.5);
    const events = readEvents(body);
    expect(events).toHaveLength(2);
    for (const e of events) {
      const v = e["volumeShare"];
      if (typeof v !== "number") throw new Error("volumeShare not a number");
      expect(v).toBeGreaterThanOrEqual(0.5);
    }
  });

  it("default theta is 0.10 (includes events at 0.10, excludes events below)", async () => {
    seedGoldDb(ctx.goldDbPath, [
      {
        sourceMarketId: "mkt-D",
        gameId: "nba-default-1",
        eventTimestamp: "2026-05-23T10:00:00.000Z",
        volumeShare: 0.05,
      },
      {
        sourceMarketId: "mkt-D",
        gameId: "nba-default-1",
        eventTimestamp: "2026-05-23T10:00:01.000Z",
        volumeShare: 0.1,
      },
      {
        sourceMarketId: "mkt-D",
        gameId: "nba-default-1",
        eventTimestamp: "2026-05-23T10:00:02.000Z",
        volumeShare: 0.42,
      },
    ]);
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/microstructure/nba-default-1",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = asRecord(res.json(), "body");
    expect(body["theta"]).toBe(0.1);
    const events = readEvents(body);
    expect(events).toHaveLength(2);
  });

  it("excludes rows where volume_share IS NULL even when theta=0", async () => {
    seedGoldDb(ctx.goldDbPath, [
      {
        sourceMarketId: "mkt-N",
        gameId: "nba-null-1",
        eventTimestamp: "2026-05-23T10:00:00.000Z",
        volumeShare: null,
      },
      {
        sourceMarketId: "mkt-N",
        gameId: "nba-null-1",
        eventTimestamp: "2026-05-23T10:00:01.000Z",
        volumeShare: 0.0,
      },
    ]);
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/microstructure/nba-null-1?theta=0",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = asRecord(res.json(), "body");
    const events = readEvents(body);
    expect(events).toHaveLength(1);
    expect(events[0]?.["volumeShare"]).toBe(0);
  });

  it("excludes events from other games", async () => {
    seedGoldDb(ctx.goldDbPath, [
      {
        sourceMarketId: "mkt-A",
        gameId: "nba-cross-A",
        eventTimestamp: "2026-05-23T10:00:00.000Z",
        volumeShare: 0.9,
      },
      {
        sourceMarketId: "mkt-B",
        gameId: "nba-cross-B",
        eventTimestamp: "2026-05-23T10:00:00.000Z",
        volumeShare: 0.9,
      },
    ]);
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/microstructure/nba-cross-A?theta=0",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = asRecord(res.json(), "body");
    const events = readEvents(body);
    expect(events).toHaveLength(1);
    expect(events[0]?.["gameId"]).toBe("nba-cross-A");
  });

  it("returns empty events array for an unknown game id without throwing", async () => {
    seedGoldDb(ctx.goldDbPath, []);
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/microstructure/nba-missing-9",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = asRecord(res.json(), "body");
    expect(body["gameId"]).toBe("nba-missing-9");
    expect(readEvents(body)).toEqual([]);
  });

  it("rejects theta out of [0,1] with 400", async () => {
    seedGoldDb(ctx.goldDbPath, []);
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/microstructure/nba-bad-1?theta=1.5",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(400);
  });

  it("is tagged 'desk-stable' in /openapi.json", async () => {
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
    const entry = asRecord(paths["/v1/microstructure/{gameId}"], "microstructure entry");
    const get = asRecord(entry["get"], "microstructure GET");
    const tags = get["tags"];
    if (!isUnknownArray(tags)) throw new Error("tags not an array");
    const tagStrings = tags.filter((t): t is string => typeof t === "string");
    expect(tagStrings).toContain("desk-stable");
  });
});
