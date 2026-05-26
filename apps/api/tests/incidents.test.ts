import Database from "better-sqlite3";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/server";

type FastifyApp = Awaited<ReturnType<typeof buildServer>>;

const TEST_TOKEN = "incidents-test-token";

interface TestCtx {
  app: FastifyApp | null;
  tempDir: string;
  tokenPath: string;
  goldDbPath: string;
  bakeoffPath: string;
  deskPath: string;
}

const ctx: TestCtx = {
  app: null,
  tempDir: "",
  tokenPath: "",
  goldDbPath: "",
  bakeoffPath: "",
  deskPath: "",
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isUnknownArray(v: unknown): v is readonly unknown[] {
  return Array.isArray(v);
}

function authHeaders(): Record<string, string> {
  return { "x-signal-token": TEST_TOKEN };
}

function seedGoldDb(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      sport TEXT NOT NULL,
      league TEXT NOT NULL,
      home_participant_json TEXT NOT NULL,
      away_participant_json TEXT NOT NULL,
      scheduled_start TEXT NOT NULL
    );
  `);
  db.prepare(
    `INSERT INTO games (id, sport, league, home_participant_json, away_participant_json, scheduled_start)
     VALUES (?, 'NBA', 'national', ?, ?, ?)`,
  ).run(
    "nba-operator-1",
    '{"abbreviation":"SAS","name":"San Antonio Spurs"}',
    '{"abbreviation":"OKC","name":"Oklahoma City Thunder"}',
    "2026-05-25T00:00:00.000Z",
  );
  db.prepare(
    `INSERT INTO games (id, sport, league, home_participant_json, away_participant_json, scheduled_start)
     VALUES (?, 'NBA', 'national', ?, ?, ?)`,
  ).run(
    "nba-operator-2",
    '{"abbreviation":"DEN","name":"Denver Nuggets"}',
    '{"abbreviation":"OKC","name":"Oklahoma City Thunder"}',
    "2026-05-25T08:00:00.000Z",
  );
  db.close();
}

function writeBakeoff(path: string): void {
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        generatedAt: "2026-05-25T09:26:41.228Z",
        coverage: {
          totalIncidents: 1,
          exactAnchorIncidents: 1,
          scoreableIncidents: 1,
          denominatorGames: 1,
        },
        bestSummary: { algoId: "A16_rv_bv_jump" },
        incidents: [
          {
            id: "benchmark_case",
            confidence: "high",
            anchorType: "second",
            gameDate: "2026-05-24",
            teams: "Oklahoma City Thunder at San Antonio Spurs",
            gameId: "nba-operator-1",
            period: "Q1",
            clock: "09:08",
            utcTime: "2026-05-25T00:16:22.400Z",
            stat: "rebound",
            creditedPlayer: "TEAM defensive rebound",
            rightfulPlayer: "V. Wembanyama",
            sourceOrigin: "fixture",
            sourceReference: "test",
            sourceTextSummary: "Fixture benchmark case",
            notes: "",
            officialCorrection: false,
            localBoardGameIds: ["nba-operator-1"],
          },
        ],
        incidentResults: [
          {
            incidentId: "benchmark_case",
            algoId: "A01_legacy_60_vw_k3",
            scoreable: true,
            caught: true,
            leadSeconds: 7.6,
            fireIso: "2026-05-25T00:16:30.000Z",
            skipReason: null,
          },
          {
            incidentId: "benchmark_case",
            algoId: "A16_rv_bv_jump",
            scoreable: true,
            caught: true,
            leadSeconds: 7.6,
            fireIso: "2026-05-25T00:16:30.000Z",
            skipReason: null,
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

beforeEach(() => {
  ctx.tempDir = mkdtempSync(join(tmpdir(), "signal-console-incidents-"));
  ctx.tokenPath = join(ctx.tempDir, "token");
  ctx.goldDbPath = join(ctx.tempDir, "gold.sqlite");
  ctx.bakeoffPath = join(ctx.tempDir, "bakeoff-results.json");
  ctx.deskPath = join(ctx.tempDir, "desk-incidents.json");
  writeFileSync(ctx.tokenPath, `${TEST_TOKEN}\n`, "utf8");
  seedGoldDb(ctx.goldDbPath);
  writeBakeoff(ctx.bakeoffPath);
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
    incidents: {
      bakeoffResultsPath: ctx.bakeoffPath,
      deskIncidentsPath: ctx.deskPath,
      goldDbPath: ctx.goldDbPath,
    },
  });
  ctx.app = app;
  return app;
}

describe("incidents routes", () => {
  it("GET /v1/incidents lists generated benchmark cases with live-control scoring", async () => {
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/incidents",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body: unknown = res.json();
    if (!isRecord(body)) throw new Error("body not object");
    const incidents = body["incidents"];
    if (!isUnknownArray(incidents)) throw new Error("incidents not array");
    expect(incidents).toHaveLength(1);
    const first = incidents[0];
    if (!isRecord(first)) throw new Error("incident not object");
    expect(first["id"]).toBe("benchmark_case");
    expect(first["origin"]).toBe("benchmark");
    expect(first["scoreable"]).toBe(true);
    const liveControl = first["liveControl"];
    if (!isRecord(liveControl)) throw new Error("liveControl not object");
    expect(liveControl["caught"]).toBe(true);
    expect(liveControl["leadSeconds"]).toBe(7.6);
  });

  it("POST /v1/incidents accepts impossible desk claims and resolves a local game when hints match", async () => {
    const app = await startApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/incidents",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: {
        incidentName: "SGA impossible points claim",
        claim: "SGA scored 317 points tonight",
        utcTime: "2026-05-25T00:16:22Z",
        teamOne: "OKC",
        stat: "points",
        rightfulPlayer: "SGA",
      },
    });
    expect(res.statusCode).toBe(201);
    const created: unknown = res.json();
    if (!isRecord(created)) throw new Error("created not object");
    expect(created["origin"]).toBe("desk-entered");
    expect(created["claim"]).toBe("SGA scored 317 points tonight");
    expect(created["gameId"]).toBe("nba-operator-1");
    expect(created["scoreable"]).toBe(false);

    const list = await app.inject({
      method: "GET",
      url: "/v1/incidents",
      headers: authHeaders(),
    });
    const body: unknown = list.json();
    if (!isRecord(body)) throw new Error("list body not object");
    const incidents = body["incidents"];
    if (!isUnknownArray(incidents)) throw new Error("list incidents not array");
    expect(incidents).toHaveLength(2);
  });

  it("POST /v1/incidents accepts a clock-plus-team desk assertion even when no feed match exists", async () => {
    const app = await startApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/incidents",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: {
        incidentName: "Manual clock-only claim",
        claim: "Trader says the live stat was wrong at this clock",
        gameClock: "Q3 04:50",
        teamOne: "MIA",
      },
    });
    expect(res.statusCode).toBe(201);
    const created: unknown = res.json();
    if (!isRecord(created)) throw new Error("created not object");
    expect(created["origin"]).toBe("desk-entered");
    expect(created["gameId"]).toBe("");
    expect(created["clock"]).toBe("Q3 04:50");
  });

  it("does not resolve a game from only one matching team when the desk supplied two team hints", async () => {
    const app = await startApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/incidents",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: {
        incidentName: "Wrong second team should not attach",
        claim: "Desk needs this stored without a misleading local game match",
        utcTime: "2026-05-25T00:16:22Z",
        teamOne: "OKC",
        teamTwo: "MIA",
      },
    });
    expect(res.statusCode).toBe(201);
    const created: unknown = res.json();
    if (!isRecord(created)) throw new Error("created not object");
    expect(created["gameId"]).toBe("");
  });

  it("keeps benchmark cases available when the desk assertion store is malformed", async () => {
    writeFileSync(ctx.deskPath, "{not valid json", "utf8");
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/incidents",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body: unknown = res.json();
    if (!isRecord(body)) throw new Error("body not object");
    const incidents = body["incidents"];
    if (!isUnknownArray(incidents)) throw new Error("incidents not array");
    expect(incidents).toHaveLength(1);
    const first = incidents[0];
    if (!isRecord(first)) throw new Error("incident not object");
    expect(first["origin"]).toBe("benchmark");
  });

  it("quarantines a malformed desk store before accepting a new desk assertion", async () => {
    writeFileSync(ctx.deskPath, "{not valid json", "utf8");
    const app = await startApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/incidents",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: {
        incidentName: "Recover after partial write",
        claim: "Trader entered case after the JSON file was malformed",
        gameClock: "Q2 08:11",
        teamOne: "OKC",
      },
    });
    expect(res.statusCode).toBe(201);
    const store: unknown = JSON.parse(readFileSync(ctx.deskPath, "utf8"));
    if (!isRecord(store)) throw new Error("desk store not object");
    expect(store["schemaVersion"]).toBe(1);
    const incidents = store["incidents"];
    if (!isUnknownArray(incidents)) throw new Error("desk incidents not array");
    expect(incidents).toHaveLength(1);
    expect(
      readdirSync(ctx.tempDir).some((name) => name.startsWith("desk-incidents.json.corrupt-")),
    ).toBe(true);
  });

  it("documents the same length limits in OpenAPI that the runtime enforces after trimming", async () => {
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: "/openapi.json",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body: unknown = res.json();
    if (!isRecord(body)) throw new Error("openapi body not object");
    const paths = body["paths"];
    if (!isRecord(paths)) throw new Error("paths not object");
    const incidents = paths["/v1/incidents"];
    if (!isRecord(incidents)) throw new Error("incidents path not object");
    const post = incidents["post"];
    if (!isRecord(post)) throw new Error("post not object");
    const requestBody = post["requestBody"];
    if (!isRecord(requestBody)) throw new Error("requestBody not object");
    const content = requestBody["content"];
    if (!isRecord(content)) throw new Error("content not object");
    const json = content["application/json"];
    if (!isRecord(json)) throw new Error("json body not object");
    const schema = json["schema"];
    if (!isRecord(schema)) throw new Error("schema not object");
    const properties = schema["properties"];
    if (!isRecord(properties)) throw new Error("properties not object");
    const incidentName = properties["incidentName"];
    const claim = properties["claim"];
    const teamOne = properties["teamOne"];
    if (!isRecord(incidentName) || !isRecord(claim) || !isRecord(teamOne)) {
      throw new Error("expected property schemas");
    }
    expect(incidentName["maxLength"]).toBe(240);
    expect(claim["maxLength"]).toBe(4000);
    expect(teamOne["maxLength"]).toBe(2000);
    expect(schema["description"]).toContain("one time anchor");
  });
});
