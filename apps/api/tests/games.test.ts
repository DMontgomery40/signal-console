// Games route contract tests (US-018). Backed by a real on-disk SQLite that
// mirrors the gold-DB shape for `games` + `game_states` (the only tables
// v_games touches). The test creates writable databases via better-sqlite3,
// then the route opens them read-only through openGoldDb().

import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/server";

type FastifyApp = Awaited<ReturnType<typeof buildServer>>;

const TEST_TOKEN = "games-test-token";

interface TestCtx {
  app: FastifyApp | null;
  tempDir: string;
  tokenPath: string;
  goldDbPath: string;
}

const ctx: TestCtx = { app: null, tempDir: "", tokenPath: "", goldDbPath: "" };

interface SeedGame {
  readonly id: string;
  readonly sport: string;
  readonly league: string;
  readonly homeParticipantJson: string;
  readonly awayParticipantJson: string;
  readonly scheduledStart: string;
  readonly status?: string;
}

function seedGoldDb(path: string, games: readonly SeedGame[]): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      sport TEXT NOT NULL,
      league TEXT NOT NULL,
      source_game_key_nba TEXT,
      home_participant_json TEXT NOT NULL,
      away_participant_json TEXT NOT NULL,
      scheduled_start TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS game_states (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_game_states_game_captured
      ON game_states(game_id, captured_at DESC);
  `);
  const insertGame = db.prepare(
    `INSERT INTO games (id, sport, league, home_participant_json, away_participant_json, scheduled_start) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertState = db.prepare(
    `INSERT INTO game_states (game_id, captured_at, status) VALUES (?, ?, ?)`,
  );
  for (const g of games) {
    insertGame.run(
      g.id,
      g.sport,
      g.league,
      g.homeParticipantJson,
      g.awayParticipantJson,
      g.scheduledStart,
    );
    if (g.status !== undefined) {
      insertState.run(g.id, new Date().toISOString(), g.status);
    }
  }
  db.close();
}

beforeEach(() => {
  ctx.tempDir = mkdtempSync(join(tmpdir(), "signal-console-games-"));
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
    games: { goldDbPath: ctx.goldDbPath },
  });
  ctx.app = app;
  return app;
}

function authHeaders(): Record<string, string> {
  return { "x-signal-token": TEST_TOKEN };
}

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isUnknownArray(v: unknown): v is readonly unknown[] {
  // Array.isArray narrows to any[]; this wrapper widens it back to unknown[]
  // so member access doesn't introduce no-unsafe-assignment errors.
  return Array.isArray(v);
}

describe("games routes (US-018)", () => {
  it("GET /v1/games returns games scheduled within the last `since` window", async () => {
    seedGoldDb(ctx.goldDbPath, [
      {
        id: "nba-recent-1",
        sport: "NBA",
        league: "national",
        homeParticipantJson: '{"abbreviation":"NYK","displayName":"New York Knicks"}',
        awayParticipantJson: '{"abbreviation":"LAL","displayName":"Los Angeles Lakers"}',
        scheduledStart: isoMinutesAgo(60),
        status: "in_play",
      },
      {
        id: "nba-old-1",
        sport: "NBA",
        league: "national",
        homeParticipantJson: '{"abbreviation":"CHI"}',
        awayParticipantJson: '{"abbreviation":"MIA"}',
        scheduledStart: isoDaysAgo(5),
      },
      {
        id: "nfl-recent-1",
        sport: "NFL",
        league: "national",
        homeParticipantJson: '{"abbreviation":"SF"}',
        awayParticipantJson: '{"abbreviation":"BUF"}',
        scheduledStart: isoMinutesAgo(120),
      },
    ]);
    const app = await startApp();

    const res = await app.inject({
      method: "GET",
      url: "/v1/games",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body: unknown = res.json();
    if (!isRecord(body)) throw new Error("body not an object");
    const games = body["games"];
    if (!isUnknownArray(games)) throw new Error("body.games not an array");
    const ids = games.map((g): string => {
      if (!isRecord(g)) throw new Error("game not an object");
      const id = g["id"];
      if (typeof id !== "string") throw new Error("game.id not a string");
      return id;
    });
    expect(ids).toContain("nba-recent-1");
    expect(ids).toContain("nfl-recent-1");
    expect(ids).not.toContain("nba-old-1");
  });

  it("GET /v1/games?sport=NBA filters out other sports", async () => {
    seedGoldDb(ctx.goldDbPath, [
      {
        id: "nba-recent-1",
        sport: "NBA",
        league: "national",
        homeParticipantJson: '{"abbreviation":"NYK"}',
        awayParticipantJson: '{"abbreviation":"LAL"}',
        scheduledStart: isoMinutesAgo(60),
      },
      {
        id: "nfl-recent-1",
        sport: "NFL",
        league: "national",
        homeParticipantJson: '{"abbreviation":"SF"}',
        awayParticipantJson: '{"abbreviation":"BUF"}',
        scheduledStart: isoMinutesAgo(60),
      },
    ]);
    const app = await startApp();

    const res = await app.inject({
      method: "GET",
      url: "/v1/games?sport=NBA",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body: unknown = res.json();
    if (!isRecord(body)) throw new Error("body not an object");
    const games = body["games"];
    if (!isUnknownArray(games)) throw new Error("body.games not an array");
    expect(games).toHaveLength(1);
    const first = games[0];
    if (!isRecord(first)) throw new Error("first game not an object");
    expect(first["id"]).toBe("nba-recent-1");
    expect(first["sport"]).toBe("NBA");
  });

  it("GET /v1/games?sport=NFL returns 200 with an empty array (not 404) when no NFL games exist (US-040)", async () => {
    // US-040 AC #4: future NFL/NCAA-football consumers can probe the endpoint
    // without it pretending the route is missing. Seed only NBA rows, query
    // sport=NFL, expect 200 and games=[].
    seedGoldDb(ctx.goldDbPath, [
      {
        id: "nba-only-1",
        sport: "NBA",
        league: "national",
        homeParticipantJson: '{"abbreviation":"BOS"}',
        awayParticipantJson: '{"abbreviation":"PHI"}',
        scheduledStart: isoMinutesAgo(45),
      },
      {
        id: "nba-only-2",
        sport: "NBA",
        league: "national",
        homeParticipantJson: '{"abbreviation":"GSW"}',
        awayParticipantJson: '{"abbreviation":"DEN"}',
        scheduledStart: isoMinutesAgo(90),
      },
    ]);
    const app = await startApp();

    const res = await app.inject({
      method: "GET",
      url: "/v1/games?sport=NFL",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body: unknown = res.json();
    if (!isRecord(body)) throw new Error("body not an object");
    const games = body["games"];
    if (!isUnknownArray(games)) throw new Error("body.games not an array");
    expect(games).toHaveLength(0);
    expect(games).toEqual([]);
  });

  it("GET /v1/games (sport omitted) returns rows of every sport (US-040)", async () => {
    // US-040 AC #3 + AC #6: when sport is omitted, no filter is applied.
    // Both NBA and NFL rows must appear.
    seedGoldDb(ctx.goldDbPath, [
      {
        id: "nba-mix-1",
        sport: "NBA",
        league: "national",
        homeParticipantJson: '{"abbreviation":"OKC"}',
        awayParticipantJson: '{"abbreviation":"LAL"}',
        scheduledStart: isoMinutesAgo(30),
      },
      {
        id: "nfl-mix-1",
        sport: "NFL",
        league: "national",
        homeParticipantJson: '{"abbreviation":"KC"}',
        awayParticipantJson: '{"abbreviation":"BUF"}',
        scheduledStart: isoMinutesAgo(60),
      },
    ]);
    const app = await startApp();

    const res = await app.inject({
      method: "GET",
      url: "/v1/games",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body: unknown = res.json();
    if (!isRecord(body)) throw new Error("body not an object");
    const games = body["games"];
    if (!isUnknownArray(games)) throw new Error("body.games not an array");
    const sports = games.map((g): string => {
      if (!isRecord(g)) throw new Error("game not an object");
      const s = g["sport"];
      if (typeof s !== "string") throw new Error("game.sport not a string");
      return s;
    });
    expect(sports).toContain("NBA");
    expect(sports).toContain("NFL");
    expect(games).toHaveLength(2);
  });

  it("GET /v1/games surfaces the latest game_states status via v_games", async () => {
    seedGoldDb(ctx.goldDbPath, [
      {
        id: "nba-status-1",
        sport: "NBA",
        league: "national",
        homeParticipantJson: '{"a":"H"}',
        awayParticipantJson: '{"a":"A"}',
        scheduledStart: isoMinutesAgo(30),
        status: "in_play",
      },
    ]);
    const app = await startApp();

    const res = await app.inject({
      method: "GET",
      url: "/v1/games",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body: unknown = res.json();
    if (!isRecord(body)) throw new Error("body not an object");
    const games = body["games"];
    if (!isUnknownArray(games)) throw new Error("body.games not an array");
    expect(games).toHaveLength(1);
    const first = games[0];
    if (!isRecord(first)) throw new Error("first game not an object");
    expect(first["status"]).toBe("in_play");
  });

  it("GET /v1/games/:gameId returns the row when the id exists", async () => {
    seedGoldDb(ctx.goldDbPath, [
      {
        id: "nba-single-1",
        sport: "NBA",
        league: "national",
        homeParticipantJson: '{"abbreviation":"BOS"}',
        awayParticipantJson: '{"abbreviation":"PHI"}',
        scheduledStart: isoMinutesAgo(45),
      },
    ]);
    const app = await startApp();

    const res = await app.inject({
      method: "GET",
      url: "/v1/games/nba-single-1",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body: unknown = res.json();
    if (!isRecord(body)) throw new Error("body not an object");
    expect(body["id"]).toBe("nba-single-1");
    expect(body["sport"]).toBe("NBA");
    expect(body["homeParticipantJson"]).toBe('{"abbreviation":"BOS"}');
  });

  it("GET /v1/games/:gameId returns 404 { error: 'game not found' } when the id has no row", async () => {
    seedGoldDb(ctx.goldDbPath, []);
    const app = await startApp();

    const res = await app.inject({
      method: "GET",
      url: "/v1/games/nba-missing-9999",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(404);
    const body: unknown = res.json();
    expect(body).toEqual({ error: "game not found" });
  });

  it("GET /v1/games returns 400 on an invalid `since` duration", async () => {
    seedGoldDb(ctx.goldDbPath, []);
    const app = await startApp();

    const res = await app.inject({
      method: "GET",
      url: "/v1/games?since=not-a-duration",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(400);
    const body: unknown = res.json();
    if (!isRecord(body)) throw new Error("body not an object");
    expect(body["error"]).toBeDefined();
  });

  it("both games routes appear in /openapi.json tagged 'desk-stable'", async () => {
    seedGoldDb(ctx.goldDbPath, []);
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: "/openapi.json",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body: unknown = res.json();

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

    expect(tagsForGet(pathsValue, "/v1/games")).toContain("desk-stable");
    expect(tagsForGet(pathsValue, "/v1/games/{gameId}")).toContain("desk-stable");
  });
});
