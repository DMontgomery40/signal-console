import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { openGoldDb } from "@signal-console/db";

import { buildGameData, loadGameWindows } from "../index";

// Smoke/parity gate for the extraction of the gold-DB GameData loaders out of
// scripts/run-nba-detector-bakeoff.ts into ./game-data.ts. The loader bodies
// (loadGameWindows/loadPairs/loadMicro/buildGameData + their helpers) were moved
// BYTE-IDENTICALLY (verified textually). This test proves the moved loaders
// still run their original SQL against the real gold DB and return a populated
// GameData for the representative NBA game, so the move can't silently break the
// loaders' DB contract. The lib takes a handle; the caller owns open/close.
const GOLD_DB_PATH = "/Users/davidmontgomery/signal-console/data/signal-console.sqlite";
const REPRESENTATIVE_GAME_ID = "nba-0042500222";

describe("research-truth game-data loaders against the real gold DB", () => {
  it("loads a non-empty GameData (pbp points + quote pairs) for the representative game", () => {
    if (!existsSync(GOLD_DB_PATH)) {
      throw new Error(
        `gold DB not found at ${GOLD_DB_PATH}; this smoke test requires the read-only gold DB`,
      );
    }
    const db = openGoldDb(GOLD_DB_PATH);
    try {
      const windows = loadGameWindows(db);
      const window = windows.find((w) => w.gameId === REPRESENTATIVE_GAME_ID);
      expect(window).toBeDefined();
      if (window === undefined) return;

      // pbp lives on window.points
      expect(window.points.length).toBeGreaterThan(0);

      const gameData = buildGameData(db, window);
      expect(gameData.gameId).toBe(REPRESENTATIVE_GAME_ID);
      expect(gameData.window.points.length).toBeGreaterThan(0);
      expect(gameData.pairs.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});
