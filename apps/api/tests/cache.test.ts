// Cache route contract tests (US-020). Seeds a real cache DB with rows
// in detector_runs + detector_observations, fires DELETE /v1/cache, and
// asserts the gold DB file size is byte-identical before and after.

import Database from "better-sqlite3";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runMigrations } from "@signal-console/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/server";

type FastifyApp = Awaited<ReturnType<typeof buildServer>>;

const TEST_TOKEN = "cache-test-token";

interface SeedRun {
  readonly detectorId: string;
  readonly detectorVersion: string;
  readonly paramsHash: string;
  readonly sourceWatermarkHash: string;
  readonly scope: "game" | "window";
  readonly gameId: string | null;
  readonly windowStart: string | null;
  readonly windowEnd: string | null;
  readonly computedAt: string;
  readonly observationCount: number;
}

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
  db.exec(`
    CREATE TABLE IF NOT EXISTS sentinel (
      id INTEGER PRIMARY KEY,
      note TEXT NOT NULL
    );
    INSERT INTO sentinel (note) VALUES ('gold-untouched');
  `);
  db.close();
}

function seedCacheDb(path: string, runs: readonly SeedRun[]): void {
  const db = new Database(path);
  runMigrations(db);
  db.pragma("foreign_keys = ON");
  const insertRun = db.prepare(`
    INSERT INTO detector_runs (
      detector_id, detector_version, params_hash, params_json,
      source_db_path, source_watermark_hash, scope, game_id,
      window_start, window_end, computed_at, compute_ms
    ) VALUES (?, ?, ?, '{}', '/tmp/gold.sqlite', ?, ?, ?, ?, ?, ?, 0)
  `);
  const insertObs = db.prepare(`
    INSERT INTO detector_observations (
      run_id, game_id, bucket_start, bucket_end, fired,
      intensity, baseline_median, baseline_mad, detail_json
    ) VALUES (?, ?, ?, ?, 0, 0.0, 0.0, 0.0, NULL)
  `);
  for (const r of runs) {
    const result = insertRun.run(
      r.detectorId,
      r.detectorVersion,
      r.paramsHash,
      r.sourceWatermarkHash,
      r.scope,
      r.gameId,
      r.windowStart,
      r.windowEnd,
      r.computedAt,
    );
    const runId = Number(result.lastInsertRowid);
    for (let i = 0; i < r.observationCount; i += 1) {
      insertObs.run(
        runId,
        r.gameId ?? "nba-test",
        `2026-05-23T10:${String(i).padStart(2, "0")}:00Z`,
        `2026-05-23T10:${String(i + 1).padStart(2, "0")}:00Z`,
      );
    }
  }
  db.close();
}

function rowCounts(path: string): { runs: number; observations: number } {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const runs = db.prepare("SELECT COUNT(*) AS n FROM detector_runs").get();
    const obs = db.prepare("SELECT COUNT(*) AS n FROM detector_observations").get();
    return {
      runs: extractCount(runs),
      observations: extractCount(obs),
    };
  } finally {
    db.close();
  }
}

function extractCount(row: unknown): number {
  if (!isRecord(row)) return 0;
  const n = row["n"];
  return typeof n === "number" ? n : 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function asRecord(v: unknown, name: string): Record<string, unknown> {
  if (!isRecord(v)) throw new Error(`${name} is not an object`);
  return v;
}

beforeEach(() => {
  ctx.tempDir = mkdtempSync(join(tmpdir(), "signal-console-cache-"));
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
    cache: { cacheDbPath: ctx.cacheDbPath },
  });
  ctx.app = app;
  return app;
}

function authHeaders(): Record<string, string> {
  return { "x-signal-token": TEST_TOKEN };
}

const defaultRuns: SeedRun[] = [
  {
    detectorId: "board-mad",
    detectorVersion: "1.1.0",
    paramsHash: "h-a",
    sourceWatermarkHash: "w-1",
    scope: "game",
    gameId: "nba-0042500222",
    windowStart: null,
    windowEnd: null,
    computedAt: "2026-05-20T12:00:00Z",
    observationCount: 3,
  },
  {
    detectorId: "board-mad",
    detectorVersion: "1.1.0",
    paramsHash: "h-b",
    sourceWatermarkHash: "w-2",
    scope: "game",
    gameId: "nba-0042500223",
    windowStart: null,
    windowEnd: null,
    computedAt: "2026-05-22T12:00:00Z",
    observationCount: 2,
  },
  {
    detectorId: "off-price-print",
    detectorVersion: "1.1.0",
    paramsHash: "h-c",
    sourceWatermarkHash: "w-3",
    scope: "game",
    gameId: "nba-0042500224",
    windowStart: null,
    windowEnd: null,
    computedAt: "2026-05-23T08:00:00Z",
    observationCount: 4,
  },
];

describe("cache route (US-020)", () => {
  it("DELETE /v1/cache with no filters deletes every detector_runs row", async () => {
    seedGoldDb(ctx.goldDbPath);
    seedCacheDb(ctx.cacheDbPath, defaultRuns);
    const goldBefore = statSync(ctx.goldDbPath).size;
    const before = rowCounts(ctx.cacheDbPath);
    expect(before.runs).toBe(3);
    expect(before.observations).toBe(9);

    const app = await startApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/cache",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = asRecord(res.json(), "body");
    expect(body["deleted"]).toBe(3);

    const after = rowCounts(ctx.cacheDbPath);
    expect(after.runs).toBe(0);
    expect(after.observations).toBe(0);
    expect(statSync(ctx.goldDbPath).size).toBe(goldBefore);
  });

  it("DELETE /v1/cache filters by detector_id", async () => {
    seedGoldDb(ctx.goldDbPath);
    seedCacheDb(ctx.cacheDbPath, defaultRuns);
    const app = await startApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/cache?detector_id=board-mad",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = asRecord(res.json(), "body");
    expect(body["deleted"]).toBe(2);

    const after = rowCounts(ctx.cacheDbPath);
    expect(after.runs).toBe(1);
    expect(after.observations).toBe(4);
  });

  it("DELETE /v1/cache filters by before (ISO timestamp)", async () => {
    seedGoldDb(ctx.goldDbPath);
    seedCacheDb(ctx.cacheDbPath, defaultRuns);
    const app = await startApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/cache?before=2026-05-23T00:00:00Z",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = asRecord(res.json(), "body");
    expect(body["deleted"]).toBe(2);

    const after = rowCounts(ctx.cacheDbPath);
    expect(after.runs).toBe(1);
    expect(after.observations).toBe(4);
  });

  it("DELETE /v1/cache combines detector_id AND before", async () => {
    seedGoldDb(ctx.goldDbPath);
    seedCacheDb(ctx.cacheDbPath, defaultRuns);
    const app = await startApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/cache?detector_id=board-mad&before=2026-05-21T00:00:00Z",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = asRecord(res.json(), "body");
    expect(body["deleted"]).toBe(1);

    const after = rowCounts(ctx.cacheDbPath);
    expect(after.runs).toBe(2);
    expect(after.observations).toBe(6);
  });

  it("DELETE /v1/cache leaves the gold DB byte-identical", async () => {
    seedGoldDb(ctx.goldDbPath);
    seedCacheDb(ctx.cacheDbPath, defaultRuns);
    const goldStatBefore = statSync(ctx.goldDbPath);
    const goldSizeBefore = goldStatBefore.size;
    const goldMtimeBefore = goldStatBefore.mtimeMs;

    const app = await startApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/cache",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);

    const goldStatAfter = statSync(ctx.goldDbPath);
    expect(goldStatAfter.size).toBe(goldSizeBefore);
    expect(goldStatAfter.mtimeMs).toBe(goldMtimeBefore);
  });

  it("DELETE /v1/cache against an empty (auto-created) cache DB returns deleted: 0", async () => {
    seedGoldDb(ctx.goldDbPath);
    // Do NOT seed the cache DB — openCacheDb creates it on demand.
    const app = await startApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/cache",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = asRecord(res.json(), "body");
    expect(body["deleted"]).toBe(0);
  });

  it("DELETE /v1/cache is tagged 'internal' in /openapi.json", async () => {
    seedGoldDb(ctx.goldDbPath);
    seedCacheDb(ctx.cacheDbPath, defaultRuns);
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: "/openapi.json",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = asRecord(res.json(), "openapi body");
    const paths = asRecord(body["paths"], "openapi.paths");

    function tagsForDelete(allPaths: Record<string, unknown>, path: string): readonly string[] {
      const entry = asRecord(allPaths[path], `openapi.paths[${path}]`);
      const del = asRecord(entry["delete"], `openapi.paths[${path}].delete`);
      const tags = del["tags"];
      if (!Array.isArray(tags)) return [];
      return tags.filter((t): t is string => typeof t === "string");
    }

    expect(tagsForDelete(paths, "/v1/cache")).toContain("internal");
  });
});
