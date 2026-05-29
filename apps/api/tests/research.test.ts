import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { buildServer } from "../src/server";
import type { EnqueueExportFn, EnqueuePullFn } from "../src/routes/research";

type FastifyApp = Awaited<ReturnType<typeof buildServer>>;

const TEST_TOKEN = "research-test-token";

interface TestCtx {
  app: FastifyApp | null;
  tempDir: string;
  tokenPath: string;
  outputRoot: string;
  goldDbPath: string;
  enqueueSpy: Mock<EnqueuePullFn>;
  enqueueExportSpy: Mock<EnqueueExportFn>;
}

const ctx: TestCtx = {
  app: null,
  tempDir: "",
  tokenPath: "",
  outputRoot: "",
  goldDbPath: "",
  enqueueSpy: vi.fn<EnqueuePullFn>(),
  enqueueExportSpy: vi.fn<EnqueueExportFn>(),
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isUnknownArray(v: unknown): v is readonly unknown[] {
  return Array.isArray(v);
}

function authHeaders(): Record<string, string> {
  return { "x-signal-token": TEST_TOKEN };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** Seed a representative artifact tree under outputRoot. */
function seedArtifacts(): void {
  const root = ctx.outputRoot;

  // Two snapshots; the newer generatedAt must win regardless of lexical order.
  const snapOld = join(root, "snapshots", "sample-fixed");
  const snapNew = join(root, "snapshots", "aaa-newer");
  mkdirSync(snapOld, { recursive: true });
  mkdirSync(snapNew, { recursive: true });
  writeJson(join(snapOld, "manifest.json"), {
    snapshotId: "sample-fixed",
    generatedAt: "2026-05-20T00:00:00.000Z",
  });
  writeJson(join(snapNew, "manifest.json"), {
    snapshotId: "aaa-newer",
    generatedAt: "2026-05-29T08:16:00.282Z",
  });

  // Two runs; newer created_utc wins.
  const runOld = join(root, "runs", "OLD-run");
  const runNew = join(root, "runs", "AAA-run");
  mkdirSync(runOld, { recursive: true });
  mkdirSync(runNew, { recursive: true });
  writeJson(join(runOld, "leaderboard.json"), [{ model: "old_model", incident_recall: 0.1 }]);
  writeJson(join(runOld, "run-manifest.json"), { created_utc: "2026-05-20T00:00:00+00:00" });
  writeJson(join(runNew, "leaderboard.json"), [
    { model: "robust_mad", incident_recall: 0.2667 },
    { model: "state_space_current", incident_recall: 0.0 },
  ]);
  // leaderboard.json carries no timestamp, so the run is dated by its sibling
  // run-manifest.json. AAA-run's newer created_utc wins regardless of lexical
  // order or mtime ties.
  writeJson(join(runNew, "run-manifest.json"), { created_utc: "2026-05-29T08:55:01+00:00" });

  // Two pull jobs.
  const pullA = join(root, "pulls", "pull-aaa");
  const pullB = join(root, "pulls", "pull-bbb");
  mkdirSync(pullA, { recursive: true });
  mkdirSync(pullB, { recursive: true });
  writeJson(join(pullA, "job.json"), {
    jobId: "pull-aaa",
    state: "succeeded",
    createdAt: "2026-05-28T00:00:00.000Z",
  });
  writeJson(join(pullB, "job.json"), {
    jobId: "pull-bbb",
    state: "queued",
    createdAt: "2026-05-29T00:00:00.000Z",
  });

  // models.json registry at the root.
  writeJson(join(root, "models.json"), {
    models: [
      { id: "robust_mad", label: "Robust MAD", description: "from registry" },
      { id: "state_space_current", label: "State-space", description: "from registry" },
    ],
  });
}

beforeEach(() => {
  ctx.tempDir = mkdtempSync(join(tmpdir(), "signal-console-research-"));
  ctx.tokenPath = join(ctx.tempDir, "token");
  ctx.outputRoot = join(ctx.tempDir, "nba-quant-lab");
  // Default to an ABSENT gold DB path; the present-DB test seeds its own.
  ctx.goldDbPath = join(ctx.tempDir, "absent-signal-console.sqlite");
  mkdirSync(ctx.outputRoot, { recursive: true });
  writeFileSync(ctx.tokenPath, `${TEST_TOKEN}\n`, "utf8");
  ctx.enqueueSpy = vi.fn<EnqueuePullFn>(({ jobId }) => ({ jobId }));
  ctx.enqueueExportSpy = vi.fn<EnqueueExportFn>(({ jobId }) => ({ jobId }));
});

/** Seed a writable gold DB with a games table and N rows, then close it. */
function seedGoldDb(rowCount: number): string {
  const path = join(ctx.tempDir, "gold-signal-console.sqlite");
  const db = new Database(path);
  db.exec("CREATE TABLE games (id TEXT PRIMARY KEY)");
  const insert = db.prepare("INSERT INTO games (id) VALUES (?)");
  for (let i = 0; i < rowCount; i += 1) {
    insert.run(`game-${i}`);
  }
  db.close();
  return path;
}

afterEach(async () => {
  if (ctx.app !== null) {
    await ctx.app.close();
    ctx.app = null;
  }
  rmSync(ctx.tempDir, { recursive: true, force: true });
});

async function startApp(seed: boolean): Promise<FastifyApp> {
  if (seed) seedArtifacts();
  const enqueuePull: EnqueuePullFn = ctx.enqueueSpy;
  const enqueueExport: EnqueueExportFn = ctx.enqueueExportSpy;
  const app = await buildServer({
    auth: { tokenPath: ctx.tokenPath, cacheTtlMs: 0 },
    research: {
      outputRoot: ctx.outputRoot,
      goldDbPath: ctx.goldDbPath,
      enqueuePull,
      enqueueExport,
      generateJobId: () => "pull-fixed-id",
      generateExportJobId: () => "export-fixed-id",
      now: () => 1_900_000_000,
    },
  });
  ctx.app = app;
  return app;
}

describe("research routes — read endpoints (seeded artifact tree)", () => {
  it("GET /v1/research/sources returns the capability matrix", async () => {
    const app = await startApp(true);
    const res = await app.inject({
      method: "GET",
      url: "/v1/research/sources",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body: unknown = res.json();
    if (!isRecord(body)) throw new Error("body not object");
    const sources = body["sources"];
    if (!isUnknownArray(sources)) throw new Error("sources not array");
    const ids = sources.filter(isRecord).map((s) => s["id"]);
    expect(ids).toContain("odds-api-io");
    expect(ids).toContain("kalshi");
    const oddsApiIo = sources.filter(isRecord).find((s) => s["id"] === "odds-api-io");
    if (!isRecord(oddsApiIo)) throw new Error("odds-api-io row missing");
    expect(oddsApiIo["class"]).toBe("artifact-only");
  });

  it("GET /v1/research/pulls lists every job.json newest-first", async () => {
    const app = await startApp(true);
    const res = await app.inject({
      method: "GET",
      url: "/v1/research/pulls",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body: unknown = res.json();
    if (!isRecord(body)) throw new Error("body not object");
    const pulls = body["pulls"];
    if (!isUnknownArray(pulls)) throw new Error("pulls not array");
    expect(pulls).toHaveLength(2);
    const first = pulls[0];
    if (!isRecord(first)) throw new Error("first pull not object");
    expect(first["jobId"]).toBe("pull-bbb"); // newer createdAt first
  });

  it("GET /v1/research/pulls/:id reads a single job", async () => {
    const app = await startApp(true);
    const res = await app.inject({
      method: "GET",
      url: "/v1/research/pulls/pull-aaa",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body: unknown = res.json();
    if (!isRecord(body)) throw new Error("body not object");
    expect(body["jobId"]).toBe("pull-aaa");
    expect(body["state"]).toBe("succeeded");
  });

  it("GET /v1/research/pulls/:id returns 404 for unknown id (clean, not 500)", async () => {
    const app = await startApp(true);
    const res = await app.inject({
      method: "GET",
      url: "/v1/research/pulls/does-not-exist",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(404);
    const body: unknown = res.json();
    if (!isRecord(body)) throw new Error("body not object");
    expect(body["code"]).toBe("not_found");
  });

  it("GET /v1/research/snapshot/latest returns the newest manifest by timestamp", async () => {
    const app = await startApp(true);
    const res = await app.inject({
      method: "GET",
      url: "/v1/research/snapshot/latest",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body: unknown = res.json();
    if (!isRecord(body)) throw new Error("body not object");
    const snapshot = body["snapshot"];
    if (!isRecord(snapshot)) throw new Error("snapshot not object");
    expect(snapshot["snapshotId"]).toBe("aaa-newer");
  });

  it("GET /v1/research/models prefers the artifact-backed registry", async () => {
    const app = await startApp(true);
    const res = await app.inject({
      method: "GET",
      url: "/v1/research/models",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body: unknown = res.json();
    if (!isRecord(body)) throw new Error("body not object");
    const models = body["models"];
    if (!isUnknownArray(models)) throw new Error("models not array");
    expect(models).toHaveLength(2);
    const first = models[0];
    if (!isRecord(first)) throw new Error("model not object");
    expect(first["source"]).toBe("registry");
  });

  it("GET /v1/research/leaderboard/latest returns rows from the latest run", async () => {
    const app = await startApp(true);
    const res = await app.inject({
      method: "GET",
      url: "/v1/research/leaderboard/latest",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body: unknown = res.json();
    if (!isRecord(body)) throw new Error("body not object");
    expect(body["runId"]).toBe("AAA-run");
    const rows = body["rows"];
    if (!isUnknownArray(rows)) throw new Error("rows not array");
    expect(rows).toHaveLength(2);
  });
});

describe("research routes — empty / absent artifact states (no seed)", () => {
  it("every read endpoint returns a clean empty payload, never 500", async () => {
    const app = await startApp(false);

    const sources = await app.inject({
      method: "GET",
      url: "/v1/research/sources",
      headers: authHeaders(),
    });
    expect(sources.statusCode).toBe(200);

    const pulls = await app.inject({
      method: "GET",
      url: "/v1/research/pulls",
      headers: authHeaders(),
    });
    expect(pulls.statusCode).toBe(200);
    const pullsBody: unknown = pulls.json();
    if (!isRecord(pullsBody)) throw new Error("pulls body not object");
    expect(pullsBody["pulls"]).toEqual([]);

    const snapshot = await app.inject({
      method: "GET",
      url: "/v1/research/snapshot/latest",
      headers: authHeaders(),
    });
    expect(snapshot.statusCode).toBe(200);
    const snapshotBody: unknown = snapshot.json();
    if (!isRecord(snapshotBody)) throw new Error("snapshot body not object");
    expect(snapshotBody["snapshot"]).toBeNull();

    const leaderboard = await app.inject({
      method: "GET",
      url: "/v1/research/leaderboard/latest",
      headers: authHeaders(),
    });
    expect(leaderboard.statusCode).toBe(200);
    const lbBody: unknown = leaderboard.json();
    if (!isRecord(lbBody)) throw new Error("leaderboard body not object");
    expect(lbBody["runId"]).toBeNull();
    expect(lbBody["rows"]).toEqual([]);

    // models falls back to the static list when no models.json exists.
    const models = await app.inject({
      method: "GET",
      url: "/v1/research/models",
      headers: authHeaders(),
    });
    expect(models.statusCode).toBe(200);
    const modelsBody: unknown = models.json();
    if (!isRecord(modelsBody)) throw new Error("models body not object");
    const modelsArr = modelsBody["models"];
    if (!isUnknownArray(modelsArr)) throw new Error("models not array");
    expect(modelsArr.length).toBeGreaterThan(0);
    const firstModel = modelsArr[0];
    if (!isRecord(firstModel)) throw new Error("model not object");
    expect(firstModel["source"]).toBe("static");
  });

  it("malformed job.json is skipped rather than throwing", async () => {
    mkdirSync(join(ctx.outputRoot, "pulls", "pull-bad"), { recursive: true });
    writeFileSync(join(ctx.outputRoot, "pulls", "pull-bad", "job.json"), "{not json", "utf8");
    const app = await startApp(false);
    const res = await app.inject({
      method: "GET",
      url: "/v1/research/pulls",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body: unknown = res.json();
    if (!isRecord(body)) throw new Error("body not object");
    expect(body["pulls"]).toEqual([]);
  });
});

describe("research routes — path-safe artifact download", () => {
  it("serves an allow-listed artifact under the output root", async () => {
    // The "models" allow-list id maps to models.json at the root.
    const app = await startApp(true);
    const res = await app.inject({
      method: "GET",
      url: "/v1/research/artifact?id=models",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const parsed: unknown = JSON.parse(res.body);
    if (!isRecord(parsed)) throw new Error("artifact body not object");
    expect(parsed["models"]).toBeDefined();
  });

  it("rejects an unknown artifact id with 400 (never serves an arbitrary path)", async () => {
    const app = await startApp(true);
    const res = await app.inject({
      method: "GET",
      url: "/v1/research/artifact?id=not-an-artifact",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(400);
    const body: unknown = res.json();
    if (!isRecord(body)) throw new Error("body not object");
    expect(body["code"]).toBe("unknown_id");
  });

  it("rejects relative traversal in the id", async () => {
    const app = await startApp(true);
    const res = await app.inject({
      method: "GET",
      url: `/v1/research/artifact?id=${encodeURIComponent("../../etc/passwd")}`,
      headers: authHeaders(),
    });
    // Not an allow-listed id, so it is rejected before any filesystem access.
    expect(res.statusCode).toBe(400);
    const body: unknown = res.json();
    if (!isRecord(body)) throw new Error("body not object");
    expect(body["code"]).not.toBe("not_found"); // never resolved to a real path
  });

  it("rejects an absolute-path id", async () => {
    const app = await startApp(true);
    const res = await app.inject({
      method: "GET",
      url: `/v1/research/artifact?id=${encodeURIComponent("/etc/passwd")}`,
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an embedded-traversal id", async () => {
    const app = await startApp(true);
    const res = await app.inject({
      method: "GET",
      url: `/v1/research/artifact?id=${encodeURIComponent("snapshots/../../../etc/passwd")}`,
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(400);
  });

  it("requires an id query parameter", async () => {
    const app = await startApp(true);
    const res = await app.inject({
      method: "GET",
      url: "/v1/research/artifact",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("research routes — POST /pull (the only writer)", () => {
  function validBody(): Record<string, unknown> {
    return {
      sources: ["kalshi"],
      date_from: "2026-05-01",
      date_to: "2026-05-25",
      capture_mode: "historical",
      market_scope: "all",
    };
  }

  it("validates and enqueues a valid request, returning { job_id }", async () => {
    const app = await startApp(false);
    const res = await app.inject({
      method: "POST",
      url: "/v1/research/pull",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: validBody(),
    });
    expect(res.statusCode).toBe(202);
    const body: unknown = res.json();
    if (!isRecord(body)) throw new Error("body not object");
    expect(body["job_id"]).toBe("pull-fixed-id");
    expect(ctx.enqueueSpy).toHaveBeenCalledTimes(1);
    const callArg = ctx.enqueueSpy.mock.calls[0]?.[0];
    if (!isRecord(callArg)) throw new Error("enqueue arg not object");
    expect(callArg["jobId"]).toBe("pull-fixed-id");
    expect(isRecord(callArg["request"])).toBe(true);
  });

  it("rejects an empty-sources request with 400 and does NOT enqueue", async () => {
    const app = await startApp(false);
    const res = await app.inject({
      method: "POST",
      url: "/v1/research/pull",
      headers: { ...authHeaders(), "content-type": "application/json" },
      // Empty sources is rejected (by the route's body schema before the
      // handler); the contract that matters is 400 + no enqueue.
      payload: { ...validBody(), sources: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(ctx.enqueueSpy).not.toHaveBeenCalled();
  });

  it("rejects an unknown source via the shared validator without enqueueing", async () => {
    const app = await startApp(false);
    const res = await app.inject({
      method: "POST",
      url: "/v1/research/pull",
      headers: { ...authHeaders(), "content-type": "application/json" },
      // Passes the route body schema but fails the shared planner+validator,
      // exercising the handler's own validation_failed path with coded errors.
      payload: { ...validBody(), sources: ["totally-unknown-source"] },
    });
    expect(res.statusCode).toBe(400);
    const body: unknown = res.json();
    if (!isRecord(body)) throw new Error("body not object");
    expect(body["code"]).toBe("validation_failed");
    const details = body["details"];
    if (!isUnknownArray(details)) throw new Error("details not array");
    const codes = details.filter(isRecord).map((d) => d["code"]);
    expect(codes).toContain("unknown_source");
    expect(ctx.enqueueSpy).not.toHaveBeenCalled();
  });
});

describe("research routes — GET /gold (gold DB status, never throws)", () => {
  it("reports present:false with zeros when the gold DB is absent", async () => {
    const app = await startApp(false);
    const res = await app.inject({
      method: "GET",
      url: "/v1/research/gold",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body: unknown = res.json();
    if (!isRecord(body)) throw new Error("body not object");
    expect(body["present"]).toBe(false);
    expect(body["path"]).toBe(ctx.goldDbPath);
    expect(body["sizeBytes"]).toBe(0);
    expect(body["lastModified"]).toBe("");
    expect(body["gameCount"]).toBeNull();
  });

  it("reports present:true with size/mtime and a games count when present", async () => {
    ctx.goldDbPath = seedGoldDb(3);
    const app = await startApp(false);
    const res = await app.inject({
      method: "GET",
      url: "/v1/research/gold",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body: unknown = res.json();
    if (!isRecord(body)) throw new Error("body not object");
    expect(body["present"]).toBe(true);
    expect(body["path"]).toBe(ctx.goldDbPath);
    const sizeBytes = body["sizeBytes"];
    expect(typeof sizeBytes === "number" && sizeBytes > 0).toBe(true);
    const lastModified = body["lastModified"];
    expect(typeof lastModified === "string" && lastModified.length > 0).toBe(true);
    expect(body["gameCount"]).toBe(3);
  });
});

describe("research routes — POST /export (the SECOND writer)", () => {
  it("validates and enqueues a full-corpus export, returning { jobId }", async () => {
    const app = await startApp(false);
    const res = await app.inject({
      method: "POST",
      url: "/v1/research/export",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: { scope: "full" },
    });
    expect(res.statusCode).toBe(202);
    const body: unknown = res.json();
    if (!isRecord(body)) throw new Error("body not object");
    expect(body["jobId"]).toBe("export-fixed-id");
    expect(ctx.enqueueExportSpy).toHaveBeenCalledTimes(1);
    const callArg = ctx.enqueueExportSpy.mock.calls[0]?.[0];
    if (!isRecord(callArg)) throw new Error("enqueue arg not object");
    expect(callArg["jobId"]).toBe("export-fixed-id");
    if (!isRecord(callArg["request"])) throw new Error("request not object");
    expect(callArg["request"]["scope"]).toBe("full");
  });

  it("validates and enqueues a sample export with explicit args", async () => {
    const app = await startApp(false);
    const res = await app.inject({
      method: "POST",
      url: "/v1/research/export",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: {
        scope: "sample",
        sample: 25,
        snapshotId: "snap-x",
        since: "2026-05-01",
        until: "2026-05-25",
        gameIds: ["nba-1", "nba-2"],
      },
    });
    expect(res.statusCode).toBe(202);
    const body: unknown = res.json();
    if (!isRecord(body)) throw new Error("body not object");
    expect(body["jobId"]).toBe("export-fixed-id");
    expect(ctx.enqueueExportSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects scope=sample without a sample count with 400 and does NOT enqueue", async () => {
    const app = await startApp(false);
    const res = await app.inject({
      method: "POST",
      url: "/v1/research/export",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: { scope: "sample" },
    });
    expect(res.statusCode).toBe(400);
    const body: unknown = res.json();
    if (!isRecord(body)) throw new Error("body not object");
    expect(typeof body["error"]).toBe("string");
    const details = body["details"];
    if (!isUnknownArray(details)) throw new Error("details not array");
    const codes = details.filter(isRecord).map((d) => d["code"]);
    expect(codes).toContain("sample_requires_count");
    expect(ctx.enqueueExportSpy).not.toHaveBeenCalled();
  });

  it("rejects an invalid scope with 400 and does NOT enqueue", async () => {
    const app = await startApp(false);
    const res = await app.inject({
      method: "POST",
      url: "/v1/research/export",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: { scope: "everything" },
    });
    expect(res.statusCode).toBe(400);
    const body: unknown = res.json();
    if (!isRecord(body)) throw new Error("body not object");
    expect(typeof body["error"]).toBe("string");
    expect(ctx.enqueueExportSpy).not.toHaveBeenCalled();
  });
});

describe("research routes — auth and write isolation", () => {
  it("requires the x-signal-token header", async () => {
    const app = await startApp(true);
    const res = await app.inject({ method: "GET", url: "/v1/research/sources" });
    expect(res.statusCode).toBe(401);
  });

  it("no read endpoint mutates: GET /pulls is identical before and after a POST", async () => {
    const app = await startApp(true);
    const before = await app.inject({
      method: "GET",
      url: "/v1/research/pulls",
      headers: authHeaders(),
    });
    await app.inject({
      method: "POST",
      url: "/v1/research/pull",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: {
        sources: ["kalshi"],
        date_from: "2026-05-01",
        date_to: "2026-05-25",
        capture_mode: "historical",
        market_scope: "all",
      },
    });
    const after = await app.inject({
      method: "GET",
      url: "/v1/research/pulls",
      headers: authHeaders(),
    });
    // The POST only enqueues via the injected spy; it writes no artifact, so
    // the on-disk pulls listing is byte-identical (no live/detector mutation).
    expect(after.body).toBe(before.body);
  });
});
