// Fanout route contract tests (US-051). Real on-disk SQLite mirroring
// the gold-DB tables /v1/board/:gameId/fanout reads from. The narrative
// module is exercised via the route so the unit-level narrative output
// is locked in the same place as the API contract.

import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/server";

type FastifyApp = Awaited<ReturnType<typeof buildServer>>;

const TEST_TOKEN = "fanout-test-token";

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

interface SeedMarket {
  readonly id: string;
  readonly gameId: string;
  readonly source?: string;
  readonly rawFamily?: string | null;
  readonly rawLabel?: string | null;
}

interface SeedTick {
  readonly sourceMarketId: string;
  readonly capturedAt: string;
  readonly impliedProbability: number;
  readonly volume?: number;
  readonly isHeartbeat?: number;
}

interface SeedPbp {
  readonly gameId: string;
  readonly timeActual: string;
  readonly actionType: string | null;
  readonly description: string | null;
  readonly period?: number | null;
  readonly clock?: string | null;
}

function seedGoldDb(
  path: string,
  markets: readonly SeedMarket[],
  ticks: readonly SeedTick[],
  pbp: readonly SeedPbp[],
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
    CREATE TABLE IF NOT EXISTS nba_play_by_play_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      action_type TEXT,
      description TEXT,
      time_actual TEXT,
      period INTEGER,
      clock TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_quote_ticks_source_market
      ON quote_ticks(source_market_id, captured_at);
    CREATE INDEX IF NOT EXISTS idx_pbp_game ON nba_play_by_play_actions(game_id, time_actual);
  `);
  const insertMarket = db.prepare(
    `INSERT INTO source_markets (id, source, game_id, raw_family, raw_label)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertTick = db.prepare(
    `INSERT INTO quote_ticks (source_market_id, captured_at, implied_probability, volume, is_heartbeat)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertPbp = db.prepare(
    `INSERT INTO nba_play_by_play_actions (game_id, action_type, description, time_actual, period, clock)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const m of markets) {
    insertMarket.run(
      m.id,
      m.source ?? "polymarket",
      m.gameId,
      m.rawFamily ?? null,
      m.rawLabel ?? null,
    );
  }
  for (const t of ticks) {
    insertTick.run(
      t.sourceMarketId,
      t.capturedAt,
      t.impliedProbability,
      t.volume ?? 0,
      t.isHeartbeat ?? 0,
    );
  }
  for (const e of pbp) {
    insertPbp.run(
      e.gameId,
      e.actionType,
      e.description,
      e.timeActual,
      e.period ?? null,
      e.clock ?? null,
    );
  }
  db.close();
}

beforeEach(() => {
  ctx.tempDir = mkdtempSync(join(tmpdir(), "signal-console-fanout-"));
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

function readArray(rec: Record<string, unknown>, key: string): readonly Record<string, unknown>[] {
  const arr = rec[key];
  if (!isUnknownArray(arr)) throw new Error(`${key} not an array`);
  return arr.map((v, i) => asRecord(v, `${key}[${String(i)}]`));
}

const GAME_ID = "nba-fanout-1";
const BUCKET_START = "2026-05-08T03:12:00Z";
const BUCKET_START_NORMALIZED = "2026-05-08T03:12:00.000Z";
const BUCKET_END_NORMALIZED = "2026-05-08T03:13:00.000Z";

// Build a deterministic synthetic Hartenstein-style anchor: bucket
// 03:12:00–03:13:00 with a rebound at +37s and several markets moving.
function seedHartensteinAnchor(): void {
  const markets: SeedMarket[] = [
    {
      id: "pm-smart-reb-over",
      gameId: GAME_ID,
      rawFamily: "rebounds",
      rawLabel: "Marcus Smart: Rebounds O/U 0.5",
    },
    {
      id: "pm-smart-reb-under",
      gameId: GAME_ID,
      rawFamily: "rebounds",
      rawLabel: "Marcus Smart: Rebounds O/U 0.5",
    },
    {
      id: "pm-dort-pts-over",
      gameId: GAME_ID,
      rawFamily: "points",
      rawLabel: "Luguentz Dort: Points O/U 2.5",
    },
    {
      id: "pm-dort-pts-under",
      gameId: GAME_ID,
      rawFamily: "points",
      rawLabel: "Luguentz Dort: Points O/U 2.5",
    },
    { id: "pm-okc-ml", gameId: GAME_ID, rawFamily: "moneyline", rawLabel: "Thunder" },
    { id: "pm-quiet", gameId: GAME_ID, rawFamily: "moneyline", rawLabel: "Lakers" },
  ];
  const ticks: SeedTick[] = [
    // ipBefore anchors (pre-bucket)
    {
      sourceMarketId: "pm-smart-reb-over",
      capturedAt: "2026-05-08T03:11:45.0Z",
      impliedProbability: 0.4,
      volume: 800,
    },
    {
      sourceMarketId: "pm-smart-reb-under",
      capturedAt: "2026-05-08T03:11:45.0Z",
      impliedProbability: 0.6,
      volume: 800,
    },
    {
      sourceMarketId: "pm-dort-pts-over",
      capturedAt: "2026-05-08T03:11:50.0Z",
      impliedProbability: 0.55,
      volume: 400,
    },
    {
      sourceMarketId: "pm-dort-pts-under",
      capturedAt: "2026-05-08T03:11:50.0Z",
      impliedProbability: 0.45,
      volume: 400,
    },
    {
      sourceMarketId: "pm-okc-ml",
      capturedAt: "2026-05-08T03:11:55.0Z",
      impliedProbability: 0.62,
      volume: 5000,
    },
    {
      sourceMarketId: "pm-quiet",
      capturedAt: "2026-05-08T03:11:55.0Z",
      impliedProbability: 0.38,
      volume: 5000,
    },
    // In-bucket ticks (the meaningful deltas)
    {
      sourceMarketId: "pm-smart-reb-over",
      capturedAt: "2026-05-08T03:12:37.0Z",
      impliedProbability: 0.62,
      volume: 900,
    },
    {
      sourceMarketId: "pm-smart-reb-under",
      capturedAt: "2026-05-08T03:12:37.0Z",
      impliedProbability: 0.38,
      volume: 900,
    },
    {
      sourceMarketId: "pm-dort-pts-over",
      capturedAt: "2026-05-08T03:12:40.0Z",
      impliedProbability: 0.62,
      volume: 500,
    },
    {
      sourceMarketId: "pm-dort-pts-under",
      capturedAt: "2026-05-08T03:12:40.0Z",
      impliedProbability: 0.38,
      volume: 500,
    },
    {
      sourceMarketId: "pm-okc-ml",
      capturedAt: "2026-05-08T03:12:55.0Z",
      impliedProbability: 0.66,
      volume: 6000,
    },
    // Note: pm-quiet has no in-bucket tick — should appear with contribution=0 or be filtered out
  ];
  const pbp: SeedPbp[] = [
    // Inside ±5 min, but boring (substitution) — should NOT be the anchor
    {
      gameId: GAME_ID,
      timeActual: "2026-05-08T03:08:44.2Z",
      actionType: "substitution",
      description: "SUB out: S. Gilgeous-Alexander",
    },
    // The intended anchor (closest non-boring): +36.8s
    {
      gameId: GAME_ID,
      timeActual: "2026-05-08T03:12:36.8Z",
      actionType: "rebound",
      description: "I. Hartenstein REBOUND (Off:4 Def:4)",
      period: 3,
      clock: "PT08M19.00S",
    },
    // Inside ±5 min, slightly later (+101s) — not closer than +37s
    {
      gameId: GAME_ID,
      timeActual: "2026-05-08T03:13:41.0Z",
      actionType: "2pt",
      description: "C. Holmgren driving DUNK (10 PTS)",
    },
    // OUTSIDE ±5 min: 06:00 after bucket_start (+360s) — must NOT be returned
    {
      gameId: GAME_ID,
      timeActual: "2026-05-08T03:18:00.0Z",
      actionType: "2pt",
      description: "OUTSIDE WINDOW SHOULD NOT APPEAR",
    },
    // OUTSIDE ±5 min: 06:30 before bucket_start (-390s) — must NOT be returned
    {
      gameId: GAME_ID,
      timeActual: "2026-05-08T03:05:30.0Z",
      actionType: "2pt",
      description: "OUTSIDE BEFORE SHOULD NOT APPEAR",
    },
  ];
  seedGoldDb(ctx.goldDbPath, markets, ticks, pbp);
}

describe("fanout route (US-051)", () => {
  it("returns the bucket shape with bucketStart/bucketEnd, pbp[], movers[], narrative", async () => {
    seedHartensteinAnchor();
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: `/v1/board/${GAME_ID}/fanout?bucket_start=${encodeURIComponent(BUCKET_START)}`,
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = asRecord(res.json(), "body");
    expect(body["bucketStart"]).toBe(BUCKET_START_NORMALIZED);
    expect(body["bucketEnd"]).toBe(BUCKET_END_NORMALIZED);
    expect(isUnknownArray(body["pbp"])).toBe(true);
    expect(isUnknownArray(body["movers"])).toBe(true);
    expect(typeof body["narrative"]).toBe("string");
  });

  it("enforces ±5 min PBP window: events outside ±300s are NOT returned", async () => {
    seedHartensteinAnchor();
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: `/v1/board/${GAME_ID}/fanout?bucket_start=${encodeURIComponent(BUCKET_START)}`,
      headers: authHeaders(),
    });
    const body = asRecord(res.json(), "body");
    const pbp = readArray(body, "pbp");
    for (const e of pbp) {
      const desc = e["description"];
      expect(typeof desc === "string" ? desc.includes("OUTSIDE") : false).toBe(false);
      const delta = e["deltaSecondsFromFire"];
      expect(typeof delta).toBe("number");
      if (typeof delta === "number") {
        expect(Math.abs(delta)).toBeLessThanOrEqual(300);
      }
    }
    // The two outside-window rows MUST be absent.
    const descriptions = pbp
      .map((e) => e["description"])
      .filter((d): d is string => typeof d === "string");
    expect(descriptions.find((d) => d.includes("OUTSIDE"))).toBeUndefined();
  });

  it("sorts pbp by absolute closeness to the fire and returns the Hartenstein rebound at +37s", async () => {
    seedHartensteinAnchor();
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: `/v1/board/${GAME_ID}/fanout?bucket_start=${encodeURIComponent(BUCKET_START)}`,
      headers: authHeaders(),
    });
    const body = asRecord(res.json(), "body");
    const pbp = readArray(body, "pbp");
    expect(pbp.length).toBeGreaterThanOrEqual(2);
    const first = pbp[0]!;
    expect(first["timeActual"]).toBe("2026-05-08T03:12:36.8Z");
    const delta = first["deltaSecondsFromFire"];
    expect(typeof delta).toBe("number");
    if (typeof delta === "number") {
      expect(delta).toBeGreaterThan(36);
      expect(delta).toBeLessThan(38);
    }
    expect(first["actionType"]).toBe("rebound");
    expect(first["playerName"]).toBe("I. Hartenstein");
  });

  it("ranks movers by intensity contribution and returns contributionPct + ipBefore/ipAfter", async () => {
    seedHartensteinAnchor();
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: `/v1/board/${GAME_ID}/fanout?bucket_start=${encodeURIComponent(BUCKET_START)}`,
      headers: authHeaders(),
    });
    const body = asRecord(res.json(), "body");
    const movers = readArray(body, "movers");
    expect(movers.length).toBeGreaterThanOrEqual(3);
    // Top mover should be a Marcus Smart rebound market (volume 900, |Δ|=0.22).
    const top = movers[0]!;
    const instrument = top["instrument"];
    expect(typeof instrument).toBe("string");
    if (typeof instrument === "string") {
      expect(instrument.toLowerCase()).toContain("rebounds");
    }
    expect(typeof top["contributionPct"]).toBe("number");
    expect(typeof top["ipBefore"]).toBe("number");
    expect(typeof top["ipAfter"]).toBe("number");
    // Sum of contributionPct across top-N must be <= 100 (1 decimal rounding).
    const sum = movers.reduce((acc, m) => {
      const v = m["contributionPct"];
      return acc + (typeof v === "number" ? v : 0);
    }, 0);
    expect(sum).toBeLessThanOrEqual(100.5);
    expect(sum).toBeGreaterThan(50);
    // Per AC: at least one mover whose instrument string contains a
    // player-prop identifier (e.g. "points" or a player name).
    const playerPropPresent = movers.some((m) => {
      const inst = m["instrument"];
      return (
        typeof inst === "string" &&
        (inst.toLowerCase().includes("points") ||
          inst.toLowerCase().includes("rebounds") ||
          inst.toLowerCase().includes("hartenstein"))
      );
    });
    expect(playerPropPresent).toBe(true);
  });

  it("narrative cites the closest non-boring anchor relative to alert (bucket_end), names the top mover, and counts other movers >0.15 IP", async () => {
    seedHartensteinAnchor();
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: `/v1/board/${GAME_ID}/fanout?bucket_start=${encodeURIComponent(BUCKET_START)}`,
      headers: authHeaders(),
    });
    const body = asRecord(res.json(), "body");
    const narrative = body["narrative"];
    expect(typeof narrative).toBe("string");
    if (typeof narrative === "string") {
      // The alert confirms at bucket_end (03:13:00), not bucket_start. The
      // previous wording ("Fire at 03:12:00") suggested the desk saw a
      // signal at bucket_start; the honest framing puts the alert at the
      // causal confirmation point — bucket_end.
      expect(narrative).toMatch(/Alert at 03:13:00/);
      expect(narrative).toMatch(/Hartenstein/);
      // Hartenstein PBP @ 03:12:37 vs alert @ 03:13:00 → 23s BEFORE alert.
      // System reacted ~23s after the disputed play landed in the feed.
      expect(narrative).toMatch(/\b2[0-5]s before alert\b/);
      // Game-clock surfaced from the PBP row (period=3, clock="PT08M19.00S")
      // — the trader-readable "Q3 8:19" sits parenthetically with the play
      // description so the desk doesn't have to mentally convert UTC.
      expect(narrative).toMatch(/Q3 8:19/);
      // Top mover line includes ΔIP and percentage with 1 decimal.
      expect(narrative).toMatch(/ΔIP [+-]\d\.\d{3}/);
      expect(narrative).toMatch(/\d+\.\d%/);
      // Should NOT mention substitution (boring action filtered out)
      expect(narrative).not.toMatch(/SUB out/);
    }
  });

  it("narrative falls back to 'no PBP within ±5 min' when window is empty", async () => {
    // Same markets, but PBP rows are all 6+ minutes away.
    const markets: SeedMarket[] = [
      { id: "pm-only", gameId: GAME_ID, rawFamily: "moneyline", rawLabel: "OnlyMarket" },
    ];
    const ticks: SeedTick[] = [
      {
        sourceMarketId: "pm-only",
        capturedAt: "2026-05-08T03:11:45.0Z",
        impliedProbability: 0.5,
        volume: 100,
      },
      {
        sourceMarketId: "pm-only",
        capturedAt: "2026-05-08T03:12:30.0Z",
        impliedProbability: 0.7,
        volume: 100,
      },
    ];
    const pbp: SeedPbp[] = [
      {
        gameId: GAME_ID,
        timeActual: "2026-05-08T03:05:00.0Z",
        actionType: "2pt",
        description: "TOO FAR BEFORE",
      },
      {
        gameId: GAME_ID,
        timeActual: "2026-05-08T03:18:00.0Z",
        actionType: "2pt",
        description: "TOO FAR AFTER",
      },
    ];
    seedGoldDb(ctx.goldDbPath, markets, ticks, pbp);
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: `/v1/board/${GAME_ID}/fanout?bucket_start=${encodeURIComponent(BUCKET_START)}`,
      headers: authHeaders(),
    });
    const body = asRecord(res.json(), "body");
    const pbpOut = readArray(body, "pbp");
    expect(pbpOut).toHaveLength(0);
    const narrative = body["narrative"];
    expect(typeof narrative).toBe("string");
    if (typeof narrative === "string") {
      expect(narrative).toMatch(/no PBP within ±5 min/);
    }
  });

  it("400 on missing or invalid bucket_start", async () => {
    seedHartensteinAnchor();
    const app = await startApp();

    const noQuery = await app.inject({
      method: "GET",
      url: `/v1/board/${GAME_ID}/fanout`,
      headers: authHeaders(),
    });
    expect(noQuery.statusCode).toBe(400);

    const bogus = await app.inject({
      method: "GET",
      url: `/v1/board/${GAME_ID}/fanout?bucket_start=not-a-date`,
      headers: authHeaders(),
    });
    expect(bogus.statusCode).toBe(400);
  });

  it("/openapi.json includes the fanout endpoint tagged 'desk-stable'", async () => {
    seedHartensteinAnchor();
    const app = await startApp();
    const res = await app.inject({ method: "GET", url: "/openapi.json", headers: authHeaders() });
    expect(res.statusCode).toBe(200);
    const spec = asRecord(res.json(), "spec");
    const paths = spec["paths"];
    expect(isRecord(paths)).toBe(true);
    if (isRecord(paths)) {
      const fanoutPath = paths["/v1/board/{gameId}/fanout"];
      expect(isRecord(fanoutPath)).toBe(true);
      if (isRecord(fanoutPath)) {
        const get = fanoutPath["get"];
        expect(isRecord(get)).toBe(true);
        if (isRecord(get)) {
          const tags = get["tags"];
          expect(isUnknownArray(tags)).toBe(true);
          if (isUnknownArray(tags)) {
            expect(tags).toContain("desk-stable");
          }
        }
      }
    }
  });
});
