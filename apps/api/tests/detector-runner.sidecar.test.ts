import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runDetector } from "../src/services/detector-runner";

interface TestCtx {
  tempDir: string;
  goldDbPath: string;
  cacheDbPath: string;
}

const ctx: TestCtx = { tempDir: "", goldDbPath: "", cacheDbPath: "" };

function seedGoldDb(path: string): void {
  const db = new Database(path);
  try {
    db.exec(`
      CREATE TABLE games (
        id TEXT PRIMARY KEY,
        sport TEXT,
        scheduled_start TEXT,
        home_participant_json TEXT,
        away_participant_json TEXT
      );
      CREATE TABLE source_markets (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL,
        source TEXT
      );
      CREATE TABLE quote_ticks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_market_id TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        implied_probability REAL,
        volume REAL,
        is_heartbeat INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE nba_play_by_play_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id TEXT NOT NULL,
        time_actual TEXT NOT NULL,
        period INTEGER,
        clock TEXT
      );
      CREATE TABLE market_microstructure_events (
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
    db.prepare(
      `INSERT INTO games (id, sport, scheduled_start, home_participant_json, away_participant_json)
       VALUES ('nba-sidecar-1', 'NBA', '2026-05-23T03:00:00.000Z', '{"key":"home"}', '{"key":"away"}')`,
    ).run();
    db.prepare(`INSERT INTO source_markets (id, game_id, source) VALUES (?, ?, ?)`).run(
      "market-1",
      "nba-sidecar-1",
      "bet365",
    );
    const insertTick = db.prepare(
      `INSERT INTO quote_ticks (source_market_id, captured_at, implied_probability, volume)
       VALUES (?, ?, ?, ?)`,
    );
    insertTick.run("market-1", "2026-05-23T03:00:00.000Z", 0.4, 20);
    insertTick.run("market-1", "2026-05-23T03:01:00.000Z", 0.55, 20);
    insertTick.run("market-1", "2026-05-23T03:02:00.000Z", 0.9, 20);
    const insertPbp = db.prepare(
      `INSERT INTO nba_play_by_play_actions (game_id, time_actual, period, clock)
       VALUES (?, ?, ?, ?)`,
    );
    insertPbp.run("nba-sidecar-1", "2026-05-23T03:00:00.000Z", 1, "PT12M00.00S");
    insertPbp.run("nba-sidecar-1", "2026-05-23T03:01:00.000Z", 1, "PT11M00.00S");
    insertPbp.run("nba-sidecar-1", "2026-05-23T03:02:00.000Z", 1, "PT10M00.00S");
  } finally {
    db.close();
  }
}

beforeEach(() => {
  ctx.tempDir = mkdtempSync(join(tmpdir(), "signal-console-runner-sidecar-"));
  ctx.goldDbPath = join(ctx.tempDir, "gold.sqlite");
  ctx.cacheDbPath = join(ctx.tempDir, "cache.sqlite");
  seedGoldDb(ctx.goldDbPath);
});

afterEach(() => {
  rmSync(ctx.tempDir, { force: true, recursive: true });
});

function readRequestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseRequestBody(body: unknown): {
  readonly observations: readonly { readonly bucketStart: string; readonly bucketEnd: string }[];
} {
  if (typeof body !== "string") {
    throw new Error("expected JSON string request body");
  }
  const parsed: unknown = JSON.parse(body);
  if (!isRecord(parsed)) {
    throw new Error("request body missing observations");
  }
  const observations = "observations" in parsed ? parsed["observations"] : undefined;
  if (!Array.isArray(observations)) {
    throw new Error("request observations are not an array");
  }
  return {
    observations: observations.flatMap((observation) => {
      if (!isRecord(observation)) {
        return [];
      }
      const bucketStart = observation["bucketStart"];
      const bucketEnd = observation["bucketEnd"];
      if (typeof bucketStart !== "string" || typeof bucketEnd !== "string") return [];
      return [
        {
          bucketStart,
          bucketEnd,
        },
      ];
    }),
  };
}

describe("runDetector board-volatility sidecar path", () => {
  it("calls the sidecar once, maps its response, and serves the cache on the second call", async () => {
    const seenUrls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      await Promise.resolve();
      seenUrls.push(readRequestUrl(input));
      const body = parseRequestBody(init?.body);
      return new Response(
        JSON.stringify({
          data: {
            gameId: "nba-sidecar-1",
            generatedAt: "2026-05-27T00:00:00.000Z",
            observations: body.observations.map((observation, index) => ({
              bucketStart: observation.bucketStart,
              bucketEnd: observation.bucketEnd,
              baselineMedian: 10 + index,
              baselineMad: 1,
              threshold: 13 + index,
              standardizedInnovation: index === 0 ? 0.5 : 3.2,
              regimeScore: index === 0 ? 0.1 : 1,
              warmedUp: index > 0,
              fired: index > 0,
            })),
          },
          meta: { source: "python-sidecar" },
        }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      );
    };

    const first = await runDetector({
      detectorId: "board-mad",
      params: {
        baselineMode: "opening-ramp",
        bucketSeconds: 60,
        freshCapSeconds: 300,
        kMad: 3,
        trailingBuckets: 20,
        warmupBuckets: 2,
        weighting: "volume",
      },
      scope: { kind: "game", gameId: "nba-sidecar-1" },
      goldDbPath: ctx.goldDbPath,
      cacheDbPath: ctx.cacheDbPath,
      boardVolatilityFetchImpl: fetchImpl,
      boardVolatilitySidecarBaseUrl: "http://sidecar.test",
    });

    expect(seenUrls).toEqual(["http://sidecar.test/api/v1/models/board-volatility/state-space"]);
    expect(first.buckets).toHaveLength(2);
    expect(first.buckets[0]?.baselineMedian).toBe(10);
    expect(first.buckets[1]?.baselineMedian).toBe(11);
    expect(first.buckets[1]?.threshold).toBe(14);
    expect(first.buckets[1]?.standardizedInnovation).toBe(3.2);
    expect(first.buckets[1]?.regimeScore).toBe(1);
    expect(first.buckets[1]?.gameElapsedSeconds).toBe(120);
    expect(first.fires).toHaveLength(1);
    expect(first.fires[0]?.bucketStart.toISOString()).toBe("2026-05-23T03:02:00.000Z");
    expect(first.fires[0]?.threshold).toBe(14);

    const second = await runDetector({
      detectorId: "board-mad",
      params: {
        baselineMode: "opening-ramp",
        bucketSeconds: 60,
        freshCapSeconds: 300,
        kMad: 3,
        trailingBuckets: 20,
        warmupBuckets: 2,
        weighting: "volume",
      },
      scope: { kind: "game", gameId: "nba-sidecar-1" },
      goldDbPath: ctx.goldDbPath,
      cacheDbPath: ctx.cacheDbPath,
      boardVolatilityFetchImpl: fetchImpl,
      boardVolatilitySidecarBaseUrl: "http://sidecar.test",
    });

    expect(second.runId).toBe(first.runId);
    expect(seenUrls).toHaveLength(1);
    expect(second.buckets.map((bucket) => bucket.baselineMedian)).toEqual([10, 11]);
    expect(second.buckets.map((bucket) => bucket.threshold)).toEqual([13, 14]);
    expect(second.buckets.map((bucket) => bucket.standardizedInnovation)).toEqual([0.5, 3.2]);
  });
});
