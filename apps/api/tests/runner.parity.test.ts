// Detector-runner parity tests (audit-fix phase A0, 2026-05-24).
//
// The shared runner exists so live and backtest cannot drift in params,
// loading, priors, or timing math. These tests pin the parity contracts that
// would have caught the historical drift if they had existed earlier:
//
//   1. board-mad game-scope vs window-scope: same game + same params produce
//      byte-identical `buckets`, `fires`, and `stats` regardless of which
//      scope kind invoked the runner. Live (/v1/board/:gameId) and Backtest
//      (/v1/backtest restricted to one game) must agree.
//
//   2. ensemble-or vs standalone board-mad: ensemble.buckets equals standalone
//      board-mad.buckets byte-identical (both reflect the board lane's
//      per-bucket aggregates), and ensemble.fires.filter(lane=="board") equals
//      standalone fires after lane normalization (standalone has no `lane`
//      field; ensemble adds `lane: "board"`). This is the by-construction
//      proof that finding #10 (ensemble silently dropping historical priors)
//      cannot reappear: both calls go through the same runner.

import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  invalidateDetectorDefaultsCache,
  setDetectorDefaultsPath,
} from "../src/services/detector-defaults";
import { runDetector } from "../src/services/detector-runner";
import { tsBoardVolatilityRunner } from "./helpers/board-volatility-runner";

interface TestCtx {
  tempDir: string;
  goldDbPath: string;
  cacheDbPath: string;
}

const ctx: TestCtx = { tempDir: "", goldDbPath: "", cacheDbPath: "" };

const GAME_ID = "nba-parity-test";

// Seed a small but realistic gold DB. One market, 30 ticks at 30-second
// intervals over 15 minutes, predictable IP walk. PBP MIN..MAX covers the
// tick window so resolveGameTimingContext returns clockSource="pbp".
function seedGoldDb(path: string): void {
  const db = new Database(path);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY,
        sport TEXT,
        scheduled_start TEXT,
        home_participant_json TEXT,
        away_participant_json TEXT
      );
      CREATE TABLE IF NOT EXISTS source_markets (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL,
        instrument_id TEXT,
        raw_family TEXT,
        raw_label TEXT
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
        time_actual TEXT,
        period INTEGER,
        clock TEXT
      );
      CREATE TABLE IF NOT EXISTS market_microstructure_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id TEXT NOT NULL,
        source_market_id TEXT NOT NULL,
        event_timestamp TEXT NOT NULL,
        source TEXT NOT NULL,
        event_type TEXT NOT NULL,
        trade_price REAL,
        volume_share REAL
      );
      CREATE INDEX IF NOT EXISTS idx_qt_market ON quote_ticks(source_market_id, captured_at);
    `);

    const insertGame = db.prepare(
      `INSERT INTO games (id, sport, scheduled_start, home_participant_json, away_participant_json)
       VALUES (?, 'NBA', ?, ?, ?)`,
    );
    const insertMarket = db.prepare(`INSERT INTO source_markets (id, game_id) VALUES (?, ?)`);
    const insertTick = db.prepare(
      `INSERT INTO quote_ticks (source_market_id, captured_at, implied_probability, volume)
       VALUES (?, ?, ?, ?)`,
    );
    const insertPbp = db.prepare(
      `INSERT INTO nba_play_by_play_actions (game_id, time_actual, period, clock)
       VALUES (?, ?, ?, ?)`,
    );
    const insertMme = db.prepare(
      `INSERT INTO market_microstructure_events
        (game_id, source_market_id, event_timestamp, source, event_type, trade_price, volume_share)
       VALUES (?, ?, ?, 'polymarket', 'trade', ?, ?)`,
    );

    const TIPOFF_MS = Date.parse("2026-05-23T03:00:00.000Z");
    const HOME_JSON = `{"key":"home"}`;
    const AWAY_JSON = `{"key":"away"}`;
    insertGame.run(GAME_ID, "2026-05-23T03:00:00.000Z", HOME_JSON, AWAY_JSON);
    insertMarket.run(`mkt-${GAME_ID}`, GAME_ID);

    // 30 ticks over 15 minutes (every 30s). One spike at minute 11.
    for (let i = 0; i < 30; i += 1) {
      const tMs = TIPOFF_MS + i * 30_000;
      const ip = i === 22 ? 0.95 : 0.4 + ((i * 0.013) % 0.2);
      insertTick.run(`mkt-${GAME_ID}`, new Date(tMs).toISOString(), ip, 10 + (i % 5));
    }

    // PBP rows every 30s with period+clock so gameElapsedSeconds is populated.
    for (let i = 0; i < 30; i += 1) {
      const tMs = TIPOFF_MS + i * 30_000;
      const elapsedSec = i * 30;
      const periodElapsed = elapsedSec % (12 * 60);
      const minutesRemaining = Math.floor((12 * 60 - periodElapsed) / 60);
      const secondsRemaining = (12 * 60 - periodElapsed) % 60;
      const clock = `PT${String(minutesRemaining).padStart(2, "0")}M${String(secondsRemaining).padStart(2, "0")}.00S`;
      insertPbp.run(GAME_ID, new Date(tMs).toISOString(), 1, clock);
    }

    // Prior game with the same home/away team keys, scheduled the day before.
    // Used by historical-blend mode tests to populate buildBoardMadHistoricalPriors.
    const PRIOR_GAME_ID = "nba-parity-prior";
    const PRIOR_TIPOFF_MS = TIPOFF_MS - 24 * 60 * 60 * 1000;
    insertGame.run(PRIOR_GAME_ID, new Date(PRIOR_TIPOFF_MS).toISOString(), HOME_JSON, AWAY_JSON);
    insertMarket.run(`mkt-${PRIOR_GAME_ID}`, PRIOR_GAME_ID);
    for (let i = 0; i < 20; i += 1) {
      const tMs = PRIOR_TIPOFF_MS + i * 60_000;
      const ip = 0.45 + ((i * 0.011) % 0.1);
      insertTick.run(`mkt-${PRIOR_GAME_ID}`, new Date(tMs).toISOString(), ip, 12);
    }
    for (let i = 0; i < 20; i += 1) {
      const tMs = PRIOR_TIPOFF_MS + i * 60_000;
      const elapsedSec = i * 60;
      const periodElapsed = elapsedSec % (12 * 60);
      const minutesRemaining = Math.floor((12 * 60 - periodElapsed) / 60);
      const secondsRemaining = (12 * 60 - periodElapsed) % 60;
      const clock = `PT${String(minutesRemaining).padStart(2, "0")}M${String(secondsRemaining).padStart(2, "0")}.00S`;
      insertPbp.run(PRIOR_GAME_ID, new Date(tMs).toISOString(), 1, clock);
    }

    // 5 microstructure trade prints scattered in the game window. Two cross
    // the off-price threshold (volume_share >= 0.1 AND |trade_price - latest_ip| >= 0.4).
    insertMme.run(GAME_ID, `mkt-${GAME_ID}`, "2026-05-23T03:03:00.000Z", 0.1, 0.05);
    insertMme.run(GAME_ID, `mkt-${GAME_ID}`, "2026-05-23T03:06:00.000Z", 0.95, 0.3); // off-price
    insertMme.run(GAME_ID, `mkt-${GAME_ID}`, "2026-05-23T03:09:00.000Z", 0.45, 0.15);
    insertMme.run(GAME_ID, `mkt-${GAME_ID}`, "2026-05-23T03:12:00.000Z", 0.02, 0.25); // off-price
    insertMme.run(GAME_ID, `mkt-${GAME_ID}`, "2026-05-23T03:14:00.000Z", 0.5, 0.02);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  ctx.tempDir = mkdtempSync(join(tmpdir(), "signal-console-runner-parity-"));
  ctx.goldDbPath = join(ctx.tempDir, "gold.sqlite");
  ctx.cacheDbPath = join(ctx.tempDir, "cache.sqlite");
  writeFileSync(join(ctx.tempDir, "detector-defaults.json"), "{}", "utf8");
  setDetectorDefaultsPath(join(ctx.tempDir, "detector-defaults.json"));
  invalidateDetectorDefaultsCache();
  seedGoldDb(ctx.goldDbPath);
});

afterEach(() => {
  rmSync(ctx.tempDir, { recursive: true, force: true });
});

const DEFAULT_BOARD_PARAMS = {
  bucketSeconds: 60,
  kMad: 3,
  weighting: "volume" as const,
  warmupBuckets: 8,
  trailingBuckets: 20,
  freshCapSeconds: 300,
};

// Compare two bucket arrays for byte-equal math. The runId is normalized out
// because cache-write order isn't part of the math contract; everything else
// (bucketStart/end, intensity, baseline, warmedUp, fired) is.
function bucketKey(b: {
  gameId: string;
  bucketStart: Date;
  bucketEnd: Date;
  intensity: number;
  baselineMedian: number;
  baselineMad: number;
  warmedUp: boolean;
  fired: boolean;
}): string {
  return [
    b.gameId,
    b.bucketStart.toISOString(),
    b.bucketEnd.toISOString(),
    b.intensity,
    b.baselineMedian,
    b.baselineMad,
    b.warmedUp,
    b.fired,
  ].join("|");
}

describe("detector-runner parity (audit-fix phase A0)", () => {
  it("board-mad: game-scope and window-scope produce identical buckets and fires", async () => {
    const gameResult = await runDetector({
      detectorId: "board-mad",
      params: DEFAULT_BOARD_PARAMS,
      scope: { kind: "game", gameId: GAME_ID },
      goldDbPath: ctx.goldDbPath,
      cacheDbPath: ctx.cacheDbPath,
      boardVolatilityRunner: tsBoardVolatilityRunner,
    });
    const windowResult = await runDetector({
      detectorId: "board-mad",
      params: DEFAULT_BOARD_PARAMS,
      scope: {
        kind: "window",
        windowStart: "2026-05-22T00:00:00.000Z",
        windowEnd: "2026-05-24T00:00:00.000Z",
        gameIds: [GAME_ID],
      },
      goldDbPath: ctx.goldDbPath,
      cacheDbPath: ctx.cacheDbPath,
      boardVolatilityRunner: tsBoardVolatilityRunner,
    });

    expect(gameResult.buckets.length).toBeGreaterThan(0);
    expect(gameResult.buckets.length).toBe(windowResult.buckets.length);

    const gameKeys = gameResult.buckets.map(bucketKey).toSorted();
    const windowKeys = windowResult.buckets.map(bucketKey).toSorted();
    expect(windowKeys).toEqual(gameKeys);

    expect(gameResult.fires.length).toBe(windowResult.fires.length);
    expect(gameResult.stats.totalFires).toBe(windowResult.stats.totalFires);
    expect(gameResult.stats.firesPerGame).toBeCloseTo(windowResult.stats.firesPerGame, 9);
  });

  it("ensemble-or board lane equals standalone board-mad (byte-identical buckets)", async () => {
    const standalone = await runDetector({
      detectorId: "board-mad",
      params: DEFAULT_BOARD_PARAMS,
      scope: { kind: "game", gameId: GAME_ID },
      goldDbPath: ctx.goldDbPath,
      cacheDbPath: ctx.cacheDbPath,
      boardVolatilityRunner: tsBoardVolatilityRunner,
    });
    const ensemble = await runDetector({
      detectorId: "ensemble-or",
      params: { board: DEFAULT_BOARD_PARAMS },
      scope: { kind: "game", gameId: GAME_ID },
      goldDbPath: ctx.goldDbPath,
      cacheDbPath: ctx.cacheDbPath,
      boardVolatilityRunner: tsBoardVolatilityRunner,
    });

    // ensemble.buckets and standalone.buckets are both the board lane's
    // per-bucket aggregates; they must be byte-identical (same math, same
    // priors, same window — by construction since both go through the runner).
    const standaloneKeys = standalone.buckets.map(bucketKey).toSorted();
    const ensembleKeys = ensemble.buckets.map(bucketKey).toSorted();
    expect(ensembleKeys).toEqual(standaloneKeys);

    // ensemble.fires contains both lanes; the board-lane subset must equal
    // standalone fires after lane normalization (standalone fires have no
    // lane field; ensemble adds lane: "board" via the ensemble-or detector).
    const standaloneFireKeys = standalone.fires
      .map((f) => `${f.gameId}|${f.bucketStart.toISOString()}|${f.intensity}`)
      .toSorted();
    const ensembleBoardFireKeys = ensemble.fires
      .filter((f) => f.lane === "board")
      .map((f) => `${f.gameId}|${f.bucketStart.toISOString()}|${f.intensity}`)
      .toSorted();
    expect(ensembleBoardFireKeys).toEqual(standaloneFireKeys);

    // ensemble.fires.filter(lane="offprice") should also be non-empty for the
    // seeded data — proves the runner is actually exercising the offprice lane.
    const ensembleOffpriceFires = ensemble.fires.filter((f) => f.lane === "offprice");
    expect(ensembleOffpriceFires.length).toBeGreaterThan(0);
  });

  it("resolveGameTimingContext returns clockSource=pbp when PBP exists", async () => {
    // Indirect: the runner uses resolveGameTimingContext internally. We
    // inspect timingContexts on the result.
    const result = await runDetector({
      detectorId: "board-mad",
      params: DEFAULT_BOARD_PARAMS,
      scope: { kind: "game", gameId: GAME_ID },
      goldDbPath: ctx.goldDbPath,
      cacheDbPath: ctx.cacheDbPath,
      boardVolatilityRunner: tsBoardVolatilityRunner,
    });
    expect(result.timingContexts).toHaveLength(1);
    const timing = result.timingContexts[0];
    expect(timing?.gameId).toBe(GAME_ID);
    expect(timing?.clockSource).toBe("pbp");
    expect(timing?.tipoffAnchorUtc.toISOString()).toBe("2026-05-23T03:00:00.000Z");
  });

  // Phase B1 regression (2026-05-25): ensemble-or with historical-blend nested
  // board params must produce byte-identical board-lane buckets to standalone
  // board-mad with the same params. This is closed-by-construction in A0a
  // because both dispatches route through the same runner code path that
  // builds historicalPriors when boardMadParams.baselineMode === HISTORICAL_BLEND.
  // This test pins that the historical-prior pipeline reaches BOTH dispatches
  // (the pre-runner bug at backtest.ts:128-131 only built priors for the
  // standalone case; ensemble silently got priors=[]).
  it("ensemble-or historical-blend board lane equals standalone board-mad historical-blend", async () => {
    const boardParamsBlend = {
      ...DEFAULT_BOARD_PARAMS,
      baselineMode: "historical-blend" as const,
    };
    const standalone = await runDetector({
      detectorId: "board-mad",
      params: boardParamsBlend,
      scope: { kind: "game", gameId: GAME_ID },
      goldDbPath: ctx.goldDbPath,
      cacheDbPath: ctx.cacheDbPath,
      boardVolatilityRunner: tsBoardVolatilityRunner,
    });
    const ensemble = await runDetector({
      detectorId: "ensemble-or",
      params: { board: boardParamsBlend },
      scope: { kind: "game", gameId: GAME_ID },
      goldDbPath: ctx.goldDbPath,
      cacheDbPath: ctx.cacheDbPath,
      boardVolatilityRunner: tsBoardVolatilityRunner,
    });

    // Both dispatches must have invoked buildBoardMadHistoricalPriors and
    // produced identical board-lane math from the prior game seeded in
    // seedGoldDb. Byte-identical buckets is the contract.
    const standaloneKeys = standalone.buckets.map(bucketKey).toSorted();
    const ensembleKeys = ensemble.buckets.map(bucketKey).toSorted();
    expect(ensembleKeys).toEqual(standaloneKeys);
  });

  it("cache hit on second call returns identical result without re-running detector", async () => {
    const first = await runDetector({
      detectorId: "board-mad",
      params: DEFAULT_BOARD_PARAMS,
      scope: { kind: "game", gameId: GAME_ID },
      goldDbPath: ctx.goldDbPath,
      cacheDbPath: ctx.cacheDbPath,
      boardVolatilityRunner: tsBoardVolatilityRunner,
    });
    const second = await runDetector({
      detectorId: "board-mad",
      params: DEFAULT_BOARD_PARAMS,
      scope: { kind: "game", gameId: GAME_ID },
      goldDbPath: ctx.goldDbPath,
      cacheDbPath: ctx.cacheDbPath,
      boardVolatilityRunner: tsBoardVolatilityRunner,
    });
    expect(second.runId).toBe(first.runId);
    expect(second.buckets.map(bucketKey).toSorted()).toEqual(
      first.buckets.map(bucketKey).toSorted(),
    );
  });
});
