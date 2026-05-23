// Detectors route contract tests (US-030). Verifies the registry-only
// route returns the two shipped detectors (board-mad, off-price-print)
// with version + displayName and a JSON Schema for paramsSchema, and that
// the route performs zero DB reads.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/server";

type FastifyApp = Awaited<ReturnType<typeof buildServer>>;

const TEST_TOKEN = "detectors-test-token";

interface TestCtx {
  app: FastifyApp | null;
  tempDir: string;
  tokenPath: string;
}

const ctx: TestCtx = { app: null, tempDir: "", tokenPath: "" };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asRecord(v: unknown, name: string): Record<string, unknown> {
  if (!isRecord(v)) throw new Error(`${name} is not an object`);
  return v;
}

function isUnknownArray(v: unknown): v is readonly unknown[] {
  return Array.isArray(v);
}

beforeEach(() => {
  ctx.tempDir = mkdtempSync(join(tmpdir(), "signal-console-detectors-"));
  ctx.tokenPath = join(ctx.tempDir, "token");
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
  // The route reads no DB; we still build the full server (and pass an
  // unreachable goldDbPath to prove the route works without DB access).
  const app = await buildServer({
    auth: { tokenPath: ctx.tokenPath, cacheTtlMs: 0 },
    health: { goldDbPath: join(ctx.tempDir, "no-such-gold.sqlite") },
    games: { goldDbPath: join(ctx.tempDir, "no-such-gold.sqlite") },
    settings: {
      goldDbPath: join(ctx.tempDir, "no-such-gold.sqlite"),
      cacheDbPath: join(ctx.tempDir, "no-such-cache.sqlite"),
      logPath: join(ctx.tempDir, "no-such-log.log"),
      heartbeatPath: join(ctx.tempDir, "no-such-heartbeat.json"),
    },
    cache: { cacheDbPath: join(ctx.tempDir, "no-such-cache.sqlite") },
    board: { goldDbPath: join(ctx.tempDir, "no-such-gold.sqlite") },
    live: { goldDbPath: join(ctx.tempDir, "no-such-gold.sqlite") },
    microstructure: { goldDbPath: join(ctx.tempDir, "no-such-gold.sqlite") },
  });
  ctx.app = app;
  return app;
}

function authHeaders(): Record<string, string> {
  return { "x-signal-token": TEST_TOKEN };
}

function fetchDetectorRows(body: unknown): readonly Record<string, unknown>[] {
  const top = asRecord(body, "body");
  const list = top["detectors"];
  if (!isUnknownArray(list)) throw new Error("body.detectors is not an array");
  return list.map((row, i) => asRecord(row, `detectors[${String(i)}]`));
}

function findById(
  rows: readonly Record<string, unknown>[],
  id: string,
): Record<string, unknown> | undefined {
  return rows.find((r) => r["id"] === id);
}

describe("detectors route (US-030)", () => {
  it("GET /v1/detectors returns 401 without an auth token", async () => {
    const app = await startApp();
    const res = await app.inject({ method: "GET", url: "/v1/detectors" });
    expect(res.statusCode).toBe(401);
  });

  it("GET /v1/detectors returns board-mad and off-price-print", async () => {
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/detectors",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const rows = fetchDetectorRows(res.json());
    const ids = rows.map((r) => r["id"]);
    expect(ids).toContain("board-mad");
    expect(ids).toContain("off-price-print");
  });

  it("each detector row includes id, version, displayName, paramsSchema", async () => {
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/detectors",
      headers: authHeaders(),
    });
    const rows = fetchDetectorRows(res.json());
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      expect(typeof row["id"]).toBe("string");
      expect(typeof row["version"]).toBe("string");
      expect(typeof row["displayName"]).toBe("string");
      expect(isRecord(row["paramsSchema"])).toBe(true);
    }
  });

  it("board-mad row exposes expected version and a JSON-Schema params object", async () => {
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/detectors",
      headers: authHeaders(),
    });
    const rows = fetchDetectorRows(res.json());
    const boardMad = findById(rows, "board-mad");
    expect(boardMad).toBeDefined();
    if (boardMad === undefined) return;
    expect(boardMad["version"]).toBe("1.0.0");
    expect(boardMad["displayName"]).toBe("Board MAD (whole-board volatility)");

    const schema = asRecord(boardMad["paramsSchema"], "board-mad.paramsSchema");
    expect(schema["type"]).toBe("object");
    const props = asRecord(schema["properties"], "board-mad.paramsSchema.properties");
    // Every Zod field on board-mad's Params schema should round-trip.
    expect(props["bucketSeconds"]).toBeDefined();
    expect(props["kMad"]).toBeDefined();
    expect(props["weighting"]).toBeDefined();
    expect(props["trailingBuckets"]).toBeDefined();
    expect(props["warmupBuckets"]).toBeDefined();
    expect(props["freshCapSeconds"]).toBeDefined();
  });

  it("off-price-print row exposes expected version and JSON-Schema params", async () => {
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/detectors",
      headers: authHeaders(),
    });
    const rows = fetchDetectorRows(res.json());
    const opp = findById(rows, "off-price-print");
    expect(opp).toBeDefined();
    if (opp === undefined) return;
    expect(opp["version"]).toBe("1.0.0");
    expect(opp["displayName"]).toContain("Off-price print");
    const schema = asRecord(opp["paramsSchema"], "off-price-print.paramsSchema");
    const props = asRecord(schema["properties"], "off-price-print.paramsSchema.properties");
    expect(props["minVolumeShare"]).toBeDefined();
    expect(props["minOffPriceDistance"]).toBeDefined();
  });

  it("GET /v1/detectors performs no DB reads (succeeds with unreachable gold + cache paths)", async () => {
    // The startApp helper above wires every other route to non-existent
    // paths. If /v1/detectors silently opened any DB handle the call below
    // would throw inside the handler and return 500; 200 proves the route
    // does not touch a DB.
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/detectors",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
  });

  it("GET /v1/detectors is tagged 'desk-stable' in /openapi.json", async () => {
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
      if (!isUnknownArray(tags)) return [];
      return tags.filter((t): t is string => typeof t === "string");
    }

    expect(tagsForGet(paths, "/v1/detectors")).toContain("desk-stable");
  });
});
