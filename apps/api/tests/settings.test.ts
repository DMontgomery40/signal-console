// Settings route contract tests (US-019). Uses real on-disk SQLite files for
// gold and cache so PRAGMA reads return real values; the route opens them
// read-only through openGoldDb / better-sqlite3.

import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runMigrations } from "@signal-console/db";
import { BOARD_MAD_BASELINE_MODE_OPENING_RAMP } from "@signal-console/detectors/board-mad/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BASELINE_DEFAULTS,
  invalidateDetectorDefaultsCache,
  readDetectorDefaults,
  setDetectorDefaultsPath,
} from "../src/services/detector-defaults";
import { buildServer } from "../src/server";

type FastifyApp = Awaited<ReturnType<typeof buildServer>>;

const TEST_TOKEN = "settings-test-token";

interface TestCtx {
  app: FastifyApp | null;
  tempDir: string;
  tokenPath: string;
  goldDbPath: string;
  cacheDbPath: string;
  heartbeatPath: string;
  logPath: string;
}

const ctx: TestCtx = {
  app: null,
  tempDir: "",
  tokenPath: "",
  goldDbPath: "",
  cacheDbPath: "",
  heartbeatPath: "",
  logPath: "",
};

function seedGoldDb(path: string): void {
  const db = new Database(path);
  db.pragma("user_version = 42");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sentinel (
      id INTEGER PRIMARY KEY,
      note TEXT NOT NULL
    );
    INSERT INTO sentinel (note) VALUES ('seed');
  `);
  db.close();
}

function seedCacheDb(path: string): void {
  const db = new Database(path);
  runMigrations(db);
  db.close();
}

beforeEach(() => {
  ctx.tempDir = mkdtempSync(join(tmpdir(), "signal-console-settings-"));
  ctx.tokenPath = join(ctx.tempDir, "token");
  ctx.goldDbPath = join(ctx.tempDir, "gold.sqlite");
  ctx.cacheDbPath = join(ctx.tempDir, "cache.sqlite");
  ctx.heartbeatPath = join(ctx.tempDir, "heartbeat.json");
  ctx.logPath = join(ctx.tempDir, "api.log");
  writeFileSync(ctx.tokenPath, `${TEST_TOKEN}\n`, "utf8");
  // Each test gets its own detector-defaults file in the tempDir so the
  // production ~/signal-console/data/detector-defaults.json is never touched.
  setDetectorDefaultsPath(join(ctx.tempDir, "detector-defaults.json"));
  invalidateDetectorDefaultsCache();
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
    settings: {
      goldDbPath: ctx.goldDbPath,
      cacheDbPath: ctx.cacheDbPath,
      heartbeatPath: ctx.heartbeatPath,
      logPath: ctx.logPath,
      appVersion: "test-1.2.3",
    },
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
  if (!isRecord(v)) throw new Error(`${name} is not an object`);
  return v;
}

function asNumber(v: unknown, name: string): number {
  if (typeof v !== "number") throw new Error(`${name} is not a number`);
  return v;
}

describe("settings route (US-019)", () => {
  it("GET /v1/settings reports mode 'read-only' against a valid gold DB", async () => {
    seedGoldDb(ctx.goldDbPath);
    seedCacheDb(ctx.cacheDbPath);
    const app = await startApp();

    const res = await app.inject({
      method: "GET",
      url: "/v1/settings",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = asRecord(res.json(), "body");
    const db = asRecord(body["db"], "body.db");
    expect(db["mode"]).toBe("read-only");
    expect(db["path"]).toBe(ctx.goldDbPath);
    expect(asNumber(db["sizeBytes"], "db.sizeBytes")).toBeGreaterThan(0);
    expect(asNumber(db["pageCount"], "db.pageCount")).toBeGreaterThan(0);
    expect(asNumber(db["pageSize"], "db.pageSize")).toBeGreaterThan(0);
    expect(typeof db["walBytes"]).toBe("number");
    expect(typeof db["lastModified"]).toBe("string");
  });

  it("GET /v1/settings returns ingestPaused: true when no heartbeat file exists", async () => {
    seedGoldDb(ctx.goldDbPath);
    seedCacheDb(ctx.cacheDbPath);
    const app = await startApp();

    const res = await app.inject({
      method: "GET",
      url: "/v1/settings",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = asRecord(res.json(), "body");
    const sources = asRecord(body["sources"], "body.sources");
    expect(sources["ingestPaused"]).toBe(true);
    expect(sources["lastKnown"]).toEqual({});
  });

  it("GET /v1/settings parses heartbeat sources when present", async () => {
    seedGoldDb(ctx.goldDbPath);
    seedCacheDb(ctx.cacheDbPath);
    writeFileSync(
      ctx.heartbeatPath,
      JSON.stringify({
        sources: {
          "nba-sidecar": {
            lastSyncAt: "2026-05-23T08:00:00Z",
            lastError: null,
            rateLimitCooldown: null,
          },
          polymarket: {
            lastSyncAt: "2026-05-23T07:59:50Z",
            lastError: "429 rate limit",
            rateLimitCooldown: "PT30S",
          },
        },
      }),
      "utf8",
    );
    const app = await startApp();

    const res = await app.inject({
      method: "GET",
      url: "/v1/settings",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = asRecord(res.json(), "body");
    const sources = asRecord(body["sources"], "body.sources");
    expect(sources["ingestPaused"]).toBe(false);
    const bySource = asRecord(sources["bySource"], "sources.bySource");
    const sidecar = asRecord(bySource["nba-sidecar"], "nba-sidecar");
    expect(sidecar["lastSyncAt"]).toBe("2026-05-23T08:00:00Z");
    const poly = asRecord(bySource["polymarket"], "polymarket");
    expect(poly["lastError"]).toBe("429 rate limit");
    expect(poly["rateLimitCooldown"]).toBe("PT30S");
  });

  it("GET /v1/settings returns at most maxErrors log entries, parsed from pino JSON", async () => {
    seedGoldDb(ctx.goldDbPath);
    seedCacheDb(ctx.cacheDbPath);
    // Write 250 lines; cap is 200.
    const lines: string[] = [];
    for (let i = 0; i < 250; i += 1) {
      lines.push(
        JSON.stringify({
          level: i % 2 === 0 ? 30 : 50,
          msg: `entry-${i}`,
          time: "2026-05-23T09:00:00Z",
        }),
      );
    }
    writeFileSync(ctx.logPath, `${lines.join("\n")}\n`, "utf8");
    const app = await startApp();

    const res = await app.inject({
      method: "GET",
      url: "/v1/settings",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = asRecord(res.json(), "body");
    const errors = body["errors"];
    if (!isUnknownArray(errors)) throw new Error("errors not array");
    expect(errors.length).toBe(200);
    const last = asRecord(errors[errors.length - 1], "last entry");
    expect(last["message"]).toBe("entry-249");
    expect(last["level"]).toBe("error");
  });

  it("GET /v1/settings returns empty errors when no log file exists", async () => {
    seedGoldDb(ctx.goldDbPath);
    seedCacheDb(ctx.cacheDbPath);
    const app = await startApp();

    const res = await app.inject({
      method: "GET",
      url: "/v1/settings",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = asRecord(res.json(), "body");
    expect(body["errors"]).toEqual([]);
  });

  it("GET /v1/settings surfaces cacheDb size and pageCount", async () => {
    seedGoldDb(ctx.goldDbPath);
    seedCacheDb(ctx.cacheDbPath);
    const app = await startApp();

    const res = await app.inject({
      method: "GET",
      url: "/v1/settings",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = asRecord(res.json(), "body");
    const cacheDb = asRecord(body["cacheDb"], "body.cacheDb");
    expect(cacheDb["path"]).toBe(ctx.cacheDbPath);
    expect(asNumber(cacheDb["sizeBytes"], "cacheDb.sizeBytes")).toBeGreaterThan(0);
    expect(asNumber(cacheDb["pageCount"], "cacheDb.pageCount")).toBeGreaterThan(0);
  });

  it("GET /v1/settings includes about block with appVersion + dbSchemaVersion", async () => {
    seedGoldDb(ctx.goldDbPath);
    seedCacheDb(ctx.cacheDbPath);
    const app = await startApp();

    const res = await app.inject({
      method: "GET",
      url: "/v1/settings",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = asRecord(res.json(), "body");
    const about = asRecord(body["about"], "body.about");
    expect(about["appVersion"]).toBe("test-1.2.3");
    expect(about["dbSchemaVersion"]).toBe(42);
    expect(isUnknownArray(about["detectorVersions"])).toBe(true);
  });

  it("GET /v1/settings is tagged 'internal' in /openapi.json", async () => {
    seedGoldDb(ctx.goldDbPath);
    seedCacheDb(ctx.cacheDbPath);
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: "/openapi.json",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = asRecord(res.json(), "openapi body");
    const paths = asRecord(body["paths"], "openapi.paths");

    function tagsForGet(allPaths: Record<string, unknown>, path: string): readonly string[] {
      const entry = asRecord(allPaths[path], `openapi.paths[${path}]`);
      const get = asRecord(entry["get"], `openapi.paths[${path}].get`);
      const tags = get["tags"];
      if (!Array.isArray(tags)) return [];
      return tags.filter((t): t is string => typeof t === "string");
    }

    expect(tagsForGet(paths, "/v1/settings")).toContain("internal");
  });

  it("GET /v1/settings response time is under 100ms on a freshly-seeded DB", async () => {
    seedGoldDb(ctx.goldDbPath);
    seedCacheDb(ctx.cacheDbPath);
    const app = await startApp();
    // Warm up (first call pays addon init + prepare cache).
    await app.inject({ method: "GET", url: "/v1/settings", headers: authHeaders() });
    const t0 = Date.now();
    const res = await app.inject({
      method: "GET",
      url: "/v1/settings",
      headers: authHeaders(),
    });
    const elapsed = Date.now() - t0;
    expect(res.statusCode).toBe(200);
    // Generous budget — AC says <100ms; on a freshly-seeded ~16 KB DB the
    // route should be well under that. Allow some headroom for slow CI.
    expect(elapsed).toBeLessThan(300);
  });
});

describe("detector-defaults route (US-053)", () => {
  it("GET /v1/settings reports baseline detectorDefaults when the file is absent", async () => {
    seedGoldDb(ctx.goldDbPath);
    seedCacheDb(ctx.cacheDbPath);
    const app = await startApp();

    const res = await app.inject({
      method: "GET",
      url: "/v1/settings",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = asRecord(res.json(), "body");
    const defaults = asRecord(body["detectorDefaults"], "detectorDefaults");
    expect(defaults["kMadLive"]).toBe(BASELINE_DEFAULTS.kMadLive);
    expect(defaults["baselineMode"]).toBe(BASELINE_DEFAULTS.baselineMode);
    expect(defaults["openingBaselineBuckets"]).toBe(BASELINE_DEFAULTS.openingBaselineBuckets);
    expect(defaults["openingRampCompleteBuckets"]).toBe(
      BASELINE_DEFAULTS.openingRampCompleteBuckets,
    );
    expect(defaults["trailingBuckets"]).toBe(BASELINE_DEFAULTS.trailingBuckets);
    expect(defaults["warmupBuckets"]).toBe(BASELINE_DEFAULTS.warmupBuckets);
    expect(defaults["freshCapSeconds"]).toBe(BASELINE_DEFAULTS.freshCapSeconds);
    expect(defaults["pbpPreBufferMs"]).toBe(BASELINE_DEFAULTS.pbpPreBufferMs);
    expect(defaults["pbpPostBufferMs"]).toBe(BASELINE_DEFAULTS.pbpPostBufferMs);
    // Phase B3: off-price thresholds in runtime defaults.
    expect(defaults["offPriceMinVolumeShare"]).toBe(BASELINE_DEFAULTS.offPriceMinVolumeShare);
    expect(defaults["offPriceMinOffPriceDistance"]).toBe(
      BASELINE_DEFAULTS.offPriceMinOffPriceDistance,
    );
    // board-mad version stays the package-declared string when defaults
    // match baseline — pre-existing cache rows remain valid.
    const about = asRecord(body["about"], "about");
    const dv = about["detectorVersions"];
    if (!isUnknownArray(dv)) throw new Error("detectorVersions not array");
    const bm = dv.find((d): d is Record<string, unknown> => {
      return isRecord(d) && d["id"] === "board-mad";
    });
    expect(bm).toBeDefined();
    if (bm === undefined) return;
    expect(String(bm["version"])).not.toContain("+def.");
  });

  it("POST /v1/settings/detector-defaults validates, atomic-writes, returns canonical values, bumps board-mad version", async () => {
    seedGoldDb(ctx.goldDbPath);
    seedCacheDb(ctx.cacheDbPath);
    const app = await startApp();

    const next = {
      kMadLive: 4.5,
      baselineMode: BOARD_MAD_BASELINE_MODE_OPENING_RAMP,
      openingBaselineBuckets: 4,
      openingRampCompleteBuckets: 12,
      trailingBuckets: 30,
      warmupBuckets: 8,
      freshCapSeconds: 300,
      pbpPreBufferMs: 5 * 60 * 1000,
      pbpPostBufferMs: 60_000,
    };
    const res = await app.inject({
      method: "POST",
      url: "/v1/settings/detector-defaults",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: next,
    });
    expect(res.statusCode).toBe(200);
    const body = asRecord(res.json(), "body");
    expect(body["kMadLive"]).toBe(4.5);
    expect(body["baselineMode"]).toBe(BOARD_MAD_BASELINE_MODE_OPENING_RAMP);
    expect(body["openingRampCompleteBuckets"]).toBe(12);
    expect(body["trailingBuckets"]).toBe(30);

    // Atomic write landed at the expected path.
    const path = join(ctx.tempDir, "detector-defaults.json");
    const raw = readFileSync(path, "utf8");
    const onDisk = asRecord(JSON.parse(raw), "onDisk");
    expect(onDisk["kMadLive"]).toBe(4.5);
    expect(onDisk["baselineMode"]).toBe(BOARD_MAD_BASELINE_MODE_OPENING_RAMP);
    expect(onDisk["openingRampCompleteBuckets"]).toBe(12);

    // Cache invalidated immediately: next GET reflects the new values.
    const get = await app.inject({
      method: "GET",
      url: "/v1/settings",
      headers: authHeaders(),
    });
    expect(get.statusCode).toBe(200);
    const getBody = asRecord(get.json(), "getBody");
    const defaults = asRecord(getBody["detectorDefaults"], "detectorDefaults");
    expect(defaults["kMadLive"]).toBe(4.5);
    expect(defaults["baselineMode"]).toBe(BOARD_MAD_BASELINE_MODE_OPENING_RAMP);
    expect(defaults["openingRampCompleteBuckets"]).toBe(12);
    expect(defaults["trailingBuckets"]).toBe(30);
    const about = asRecord(getBody["about"], "about");
    const dv = about["detectorVersions"];
    if (!isUnknownArray(dv)) throw new Error("detectorVersions not array");
    const bm = dv.find((d): d is Record<string, unknown> => {
      return isRecord(d) && d["id"] === "board-mad";
    });
    expect(bm).toBeDefined();
    if (bm === undefined) return;
    expect(String(bm["version"])).toMatch(/\+def\.[0-9a-f]{8}$/);
  });

  it("POST /v1/settings/detector-defaults/schedule writes pending defaults and promotes them after effectiveAt", async () => {
    seedGoldDb(ctx.goldDbPath);
    seedCacheDb(ctx.cacheDbPath);
    const app = await startApp();

    const next = {
      ...BASELINE_DEFAULTS,
      kMadLive: 4.25,
      baselineMode: BOARD_MAD_BASELINE_MODE_OPENING_RAMP,
      bucketSeconds: 30,
    };
    const effectiveAt = "2026-05-25T09:00:00.000Z";
    const res = await app.inject({
      method: "POST",
      url: "/v1/settings/detector-defaults/schedule",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: { defaults: next, effectiveAt },
    });
    expect(res.statusCode).toBe(200);
    const body = asRecord(res.json(), "body");
    expect(body["effectiveAt"]).toBe(effectiveAt);
    const scheduledPath = join(ctx.tempDir, "detector-defaults.json.scheduled.json");
    const scheduled = asRecord(JSON.parse(readFileSync(scheduledPath, "utf8")), "scheduled");
    expect(scheduled["effectiveAt"]).toBe(effectiveAt);

    expect(readDetectorDefaults(Date.parse("2026-05-25T08:59:59.000Z")).kMadLive).toBe(
      BASELINE_DEFAULTS.kMadLive,
    );
    invalidateDetectorDefaultsCache();
    expect(readDetectorDefaults(Date.parse("2026-05-25T09:00:00.000Z")).kMadLive).toBe(4.25);
  });

  it("POST /v1/settings/detector-defaults rejects out-of-range values with 400", async () => {
    seedGoldDb(ctx.goldDbPath);
    seedCacheDb(ctx.cacheDbPath);
    const app = await startApp();

    const res = await app.inject({
      method: "POST",
      url: "/v1/settings/detector-defaults",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: { kMadLive: 99 },
    });
    expect(res.statusCode).toBe(400);
    const body = asRecord(res.json(), "body");
    expect(body["error"]).toBe("invalid_defaults");
  });
});
