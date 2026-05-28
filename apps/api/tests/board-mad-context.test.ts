import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadBoardMadTicksForGame } from "../src/services/board-mad-context";

function createDbPath(): string {
  const tempDir = mkdtempSync(join(tmpdir(), "signal-console-board-mad-context-"));
  tempDirs.push(tempDir);
  return join(tempDir, "gold.sqlite");
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir !== undefined) {
      rmSync(tempDir, { force: true, recursive: true });
    }
  }
});

function seedSourceSchema(path: string, options: { readonly includeSourceColumn: boolean }): void {
  const db = new Database(path);
  try {
    db.exec(`
      CREATE TABLE games (
        id TEXT PRIMARY KEY,
        sport TEXT NOT NULL,
        scheduled_start TEXT NOT NULL,
        home_participant_json TEXT NOT NULL,
        away_participant_json TEXT NOT NULL
      );
      CREATE TABLE source_markets (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL${options.includeSourceColumn ? ",\n        source TEXT" : ""}
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
    `);
    db.prepare(
      `INSERT INTO games (id, sport, scheduled_start, home_participant_json, away_participant_json)
       VALUES ('game-1', 'NBA', '2026-05-23T03:00:00.000Z', '{"key":"home"}', '{"key":"away"}')`,
    ).run();
    if (options.includeSourceColumn) {
      db.prepare(`INSERT INTO source_markets (id, game_id, source) VALUES (?, ?, ?)`).run(
        "market-1",
        "game-1",
        "bet365",
      );
    } else {
      db.prepare(`INSERT INTO source_markets (id, game_id) VALUES (?, ?)`).run(
        "market-1",
        "game-1",
      );
    }
    db.prepare(
      `INSERT INTO quote_ticks (source_market_id, captured_at, implied_probability, volume, is_heartbeat)
       VALUES ('market-1', '2026-05-23T03:01:00.000Z', 0.61, 17, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO nba_play_by_play_actions (game_id, time_actual, period, clock)
       VALUES ('game-1', '2026-05-23T03:01:00.000Z', 1, 'PT11M00.00S')`,
    ).run();
  } finally {
    db.close();
  }
}

describe("loadBoardMadTicksForGame", () => {
  it("returns ticks when source_markets.source is absent", () => {
    const dbPath = createDbPath();
    seedSourceSchema(dbPath, { includeSourceColumn: false });
    const db = new Database(dbPath, { readonly: true });
    try {
      const ticks = loadBoardMadTicksForGame(
        db,
        "game-1",
        "2026-05-23T03:00:00.000Z",
        "2026-05-23T03:05:00.000Z",
      );
      expect(ticks).toHaveLength(1);
      expect(ticks[0]?.source).toBeUndefined();
      expect(ticks[0]?.gameElapsedSeconds).toBe(60);
    } finally {
      db.close();
    }
  });

  it("preserves source when source_markets.source exists", () => {
    const dbPath = createDbPath();
    seedSourceSchema(dbPath, { includeSourceColumn: true });
    const db = new Database(dbPath, { readonly: true });
    try {
      const ticks = loadBoardMadTicksForGame(
        db,
        "game-1",
        "2026-05-23T03:00:00.000Z",
        "2026-05-23T03:05:00.000Z",
      );
      expect(ticks).toHaveLength(1);
      expect(ticks[0]?.source).toBe("bet365");
    } finally {
      db.close();
    }
  });
});
