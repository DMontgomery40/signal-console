// Live route contract tests (US-028 / PRD §FR-20, §15).
//
// Real on-disk SQLite that mirrors the gold-DB shape for source_markets +
// quote_ticks (the only tables /v1/live touches). The route opens the
// fixture path read-only via openGoldDb.

import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/server";

type FastifyApp = Awaited<ReturnType<typeof buildServer>>;

const TEST_TOKEN = "live-test-token";

interface TestCtx {
  app: FastifyApp | null;
  tempDir: string;
  tokenPath: string;
  goldDbPath: string;
}

const ctx: TestCtx = { app: null, tempDir: "", tokenPath: "", goldDbPath: "" };

interface SeedMarket {
  readonly id: string;
  readonly gameId: string;
  readonly instrumentId?: string | null;
  readonly rawFamily?: string | null;
  readonly rawLabel?: string | null;
}

interface SeedTick {
  readonly sourceMarketId: string;
  readonly capturedAt: string;
  readonly impliedProbability?: number | null;
  readonly volume?: number | null;
  readonly isHeartbeat?: number;
}

function seedGoldDb(
  path: string,
  markets: readonly SeedMarket[],
  ticks: readonly SeedTick[],
): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_markets (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'test',
      source_market_key TEXT NOT NULL DEFAULT 'key',
      source_selection_key TEXT,
      game_id TEXT NOT NULL,
      instrument_id TEXT,
      raw_family TEXT,
      raw_label TEXT,
      mapping_status TEXT NOT NULL DEFAULT 'mapped',
      raw_metadata_json TEXT
    );
    CREATE TABLE IF NOT EXISTS quote_ticks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_market_id TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      implied_probability REAL,
      volume REAL,
      is_heartbeat INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_quote_ticks_source_market
      ON quote_ticks(source_market_id, captured_at);
  `);
  const insertMarket = db.prepare(
    `INSERT INTO source_markets (id, game_id, instrument_id, raw_family, raw_label)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertTick = db.prepare(
    `INSERT INTO quote_ticks (source_market_id, captured_at, implied_probability, volume, is_heartbeat)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const m of markets) {
    insertMarket.run(
      m.id,
      m.gameId,
      m.instrumentId ?? null,
      m.rawFamily ?? null,
      m.rawLabel ?? null,
    );
  }
  for (const t of ticks) {
    insertTick.run(
      t.sourceMarketId,
      t.capturedAt,
      t.impliedProbability ?? null,
      t.volume ?? null,
      t.isHeartbeat ?? 0,
    );
  }
  db.close();
}

beforeEach(() => {
  ctx.tempDir = mkdtempSync(join(tmpdir(), "signal-console-live-"));
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
    live: { goldDbPath: ctx.goldDbPath },
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

function readTicks(body: unknown): readonly Record<string, unknown>[] {
  const rec = asRecord(body, "body");
  const ticks = rec["ticks"];
  if (!isUnknownArray(ticks)) throw new Error("body.ticks not an array");
  return ticks.map((t, i) => asRecord(t, `tick[${String(i)}]`));
}

function isoFromNow(deltaMs: number): string {
  return new Date(Date.now() + deltaMs).toISOString();
}

describe("live route (US-028)", () => {
  it("GET /v1/live/:gameId returns response with gameId, window, ticks array", async () => {
    seedGoldDb(
      ctx.goldDbPath,
      [
        {
          id: "mkt-A",
          gameId: "nba-live-1",
          instrumentId: "inst-1",
          rawFamily: "moneyline",
          rawLabel: "home_team",
        },
      ],
      [
        {
          sourceMarketId: "mkt-A",
          capturedAt: isoFromNow(-30_000),
          impliedProbability: 0.55,
          volume: 12,
        },
      ],
    );
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/live/nba-live-1",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = asRecord(res.json(), "body");
    expect(body["gameId"]).toBe("nba-live-1");
    expect(typeof body["windowStart"]).toBe("string");
    expect(typeof body["windowEnd"]).toBe("string");
    const ticks = readTicks(body);
    expect(ticks).toHaveLength(1);
    const first = ticks[0]!;
    expect(first["sourceMarketId"]).toBe("mkt-A");
    expect(first["source"]).toBe("test");
    expect(first["impliedProbability"]).toBe(0.55);
    expect(first["volume"]).toBe(12);
    expect(first["instrumentId"]).toBe("inst-1");
    expect(first["rawFamily"]).toBe("moneyline");
    expect(first["rawLabel"]).toBe("home_team");
  });

  it("excludes ticks captured more than 5 minutes ago, includes all ticks inside the window", async () => {
    seedGoldDb(
      ctx.goldDbPath,
      [{ id: "mkt-B", gameId: "nba-window-1" }],
      [
        // Inside the 5-min window.
        { sourceMarketId: "mkt-B", capturedAt: isoFromNow(-10_000), impliedProbability: 0.5 },
        { sourceMarketId: "mkt-B", capturedAt: isoFromNow(-60_000), impliedProbability: 0.51 },
        { sourceMarketId: "mkt-B", capturedAt: isoFromNow(-4 * 60_000), impliedProbability: 0.52 },
        // Outside the 5-min window (>5 min ago).
        {
          sourceMarketId: "mkt-B",
          capturedAt: isoFromNow(-6 * 60_000),
          impliedProbability: 0.6,
        },
        {
          sourceMarketId: "mkt-B",
          capturedAt: isoFromNow(-60 * 60_000),
          impliedProbability: 0.7,
        },
      ],
    );
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/live/nba-window-1",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = asRecord(res.json(), "body");
    const ticks = readTicks(body);
    expect(ticks).toHaveLength(3);
    const windowStart = body["windowStart"];
    const windowEnd = body["windowEnd"];
    if (typeof windowStart !== "string" || typeof windowEnd !== "string") {
      throw new Error("window bounds not strings");
    }
    const startMs = Date.parse(windowStart);
    const endMs = Date.parse(windowEnd);
    expect(endMs - startMs).toBe(5 * 60 * 1000);
    for (const t of ticks) {
      const ts = t["capturedAt"];
      if (typeof ts !== "string") throw new Error("capturedAt not a string");
      const tMs = Date.parse(ts);
      expect(tMs).toBeGreaterThanOrEqual(startMs);
      expect(tMs).toBeLessThanOrEqual(endMs);
    }
  });

  it("can widen a historical replay window without changing the default live window", async () => {
    seedGoldDb(
      ctx.goldDbPath,
      [{ id: "mkt-W", gameId: "nba-window-10" }],
      [
        {
          sourceMarketId: "mkt-W",
          capturedAt: "2026-05-25T00:11:22.399Z",
          impliedProbability: 0.49,
        },
        {
          sourceMarketId: "mkt-W",
          capturedAt: "2026-05-25T00:11:22.400Z",
          impliedProbability: 0.5,
        },
        {
          sourceMarketId: "mkt-W",
          capturedAt: "2026-05-25T00:16:22.400Z",
          impliedProbability: 0.51,
        },
        {
          sourceMarketId: "mkt-W",
          capturedAt: "2026-05-25T00:21:22.400Z",
          impliedProbability: 0.52,
        },
        {
          sourceMarketId: "mkt-W",
          capturedAt: "2026-05-25T00:21:22.401Z",
          impliedProbability: 0.53,
        },
      ],
    );
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: `/v1/live/nba-window-10?at=${encodeURIComponent("2026-05-25T00:21:22.400Z")}&window_ms=600000`,
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = asRecord(res.json(), "body");
    expect(body["windowStart"]).toBe("2026-05-25T00:11:22.400Z");
    expect(body["windowEnd"]).toBe("2026-05-25T00:21:22.400Z");
    expect(readTicks(body).map((tick) => tick["capturedAt"])).toEqual([
      "2026-05-25T00:11:22.400Z",
      "2026-05-25T00:16:22.400Z",
      "2026-05-25T00:21:22.400Z",
    ]);
  });

  it("rejects invalid replay window lengths", async () => {
    seedGoldDb(ctx.goldDbPath, [], []);
    const app = await startApp();
    for (const windowMs of ["0", "900001"] as const) {
      const res = await app.inject({
        method: "GET",
        url: `/v1/live/nba-window-invalid?window_ms=${windowMs}`,
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(400);
      expect(asRecord(res.json(), "body")["error"]).toBe("invalid window_ms");
    }
  });

  it("returns empty ticks array when the game has no recent activity", async () => {
    seedGoldDb(
      ctx.goldDbPath,
      [{ id: "mkt-Q", gameId: "nba-quiet-1" }],
      [
        // Only an old tick — outside the 5-min window.
        { sourceMarketId: "mkt-Q", capturedAt: isoFromNow(-10 * 60_000), impliedProbability: 0.4 },
      ],
    );
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/live/nba-quiet-1",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = asRecord(res.json(), "body");
    expect(readTicks(body)).toEqual([]);
  });

  it("returns empty ticks for an unknown game id without throwing", async () => {
    seedGoldDb(ctx.goldDbPath, [], []);
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/live/nba-missing-9",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = asRecord(res.json(), "body");
    expect(body["gameId"]).toBe("nba-missing-9");
    expect(readTicks(body)).toEqual([]);
  });

  it("excludes ticks from other games sharing no markets", async () => {
    seedGoldDb(
      ctx.goldDbPath,
      [
        { id: "mkt-1A", gameId: "nba-other-A" },
        { id: "mkt-1B", gameId: "nba-other-B" },
      ],
      [
        { sourceMarketId: "mkt-1A", capturedAt: isoFromNow(-30_000), impliedProbability: 0.5 },
        { sourceMarketId: "mkt-1B", capturedAt: isoFromNow(-30_000), impliedProbability: 0.6 },
      ],
    );
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/live/nba-other-A",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = asRecord(res.json(), "body");
    const ticks = readTicks(body);
    expect(ticks).toHaveLength(1);
    expect(ticks[0]!["sourceMarketId"]).toBe("mkt-1A");
  });

  it("preserves null implied_probability and coalesces missing volume to 0", async () => {
    seedGoldDb(
      ctx.goldDbPath,
      [{ id: "mkt-N", gameId: "nba-nulls-1" }],
      [
        {
          sourceMarketId: "mkt-N",
          capturedAt: isoFromNow(-10_000),
          impliedProbability: null,
          volume: null,
        },
      ],
    );
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/live/nba-nulls-1",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = asRecord(res.json(), "body");
    const ticks = readTicks(body);
    expect(ticks).toHaveLength(1);
    expect(ticks[0]!["impliedProbability"]).toBeNull();
    expect(ticks[0]!["volume"]).toBe(0);
  });

  it("is tagged 'desk-stable' in /openapi.json", async () => {
    seedGoldDb(ctx.goldDbPath, [], []);
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: "/openapi.json",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = asRecord(res.json(), "openapi body");
    const paths = asRecord(body["paths"], "openapi.paths");
    const liveEntry = asRecord(paths["/v1/live/{gameId}"], "live path entry");
    const get = asRecord(liveEntry["get"], "live GET");
    const tags = get["tags"];
    if (!isUnknownArray(tags)) throw new Error("tags not an array");
    const tagStrings = tags.filter((t): t is string => typeof t === "string");
    expect(tagStrings).toContain("desk-stable");
  });

  it("routes/live.ts never references board_volatility_baselines (no baseline rebuild)", () => {
    // Grep guard mirrors the US-028 acceptance: Live is raw ticks only; any
    // future addition that pulls in the baseline table would silently trigger
    // detector recompute work this route is forbidden from doing.
    const src = readFileSync(new URL("../src/routes/live.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/board_volatility_baselines/);
    const svc = readFileSync(new URL("../src/services/live.ts", import.meta.url), "utf8");
    expect(svc).not.toMatch(/board_volatility_baselines/);
  });
});
