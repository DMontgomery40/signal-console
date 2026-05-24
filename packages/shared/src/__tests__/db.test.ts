import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  backupDatabase,
  checkDatabaseHealth,
  getDatabase,
  recordAdapterRun,
  resetDatabase,
  upsertWatchlist,
} from "../db";

let tempDir = "";

describe("shared db", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "signal-console-db-"));
    process.env.SIGNAL_CONSOLE_DB_PATH = join(tempDir, "signal-console.sqlite");
    resetDatabase();
  });

  afterEach(() => {
    resetDatabase();
    delete process.env.SIGNAL_CONSOLE_DB_PATH;
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("persists watchlist and adapter-run rows in sqlite", () => {
    upsertWatchlist({
      eventId: "bos-vs-nyk",
      note: "Research queue",
      priority: 91,
      status: "queued",
    });
    recordAdapterRun({
      finishedAt: "2026-04-22T06:00:05.000Z",
      recordsSeen: 4,
      recordsWritten: 4,
      source: "nba",
      startedAt: "2026-04-22T06:00:00.000Z",
      status: "ok",
    });

    const health = checkDatabaseHealth();

    expect(health).toMatchObject({
      counts: {
        watchlistCount: 1,
      },
      schemaVersion: 14,
      status: "ok",
    });

    const indexes = getDatabase()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .pluck()
      .all();
    expect(indexes).toEqual(
      expect.arrayContaining([
        "idx_games_scheduled_date",
        "idx_quote_ticks_source_market_latest",
        "idx_market_microstructure_game_time",
        "idx_raw_payloads_entity_latest",
        "idx_source_markets_instrument_source",
      ])
    );
  });

  it("can skip the full integrity scan for fast readiness checks", () => {
    upsertWatchlist({
      eventId: "bos-vs-nyk",
      status: "queued",
    });
    const db = getDatabase();
    const firstPayload = db
      .prepare(
        "INSERT INTO raw_payloads (source, captured_at, entity_type, entity_id, payload_json, content_hash) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(
        "polymarket",
        "2026-04-22T06:00:00.000Z",
        "market",
        "poly-1",
        "{}",
        "hash-1"
      );
    const secondPayload = db
      .prepare(
        "INSERT INTO raw_payloads (source, captured_at, entity_type, entity_id, payload_json, content_hash) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(
        "polymarket",
        "2026-04-22T06:00:01.000Z",
        "market",
        "poly-2",
        "{}",
        "hash-2"
      );
    db.prepare("DELETE FROM raw_payloads WHERE id = ?").run(
      firstPayload.lastInsertRowid
    );

    const health = checkDatabaseHealth({ integrityCheck: "skip" });

    expect(health).toMatchObject({
      countAccuracy: "large-table-high-water-mark",
      counts: {
        rawPayloadCount: Number(secondPayload.lastInsertRowid),
        watchlistCount: 1,
      },
      message:
        "SQLite database opened; full integrity check skipped and large table counts use high-water marks for fast readiness.",
      status: "ok",
    });

    const exactHealth = checkDatabaseHealth();

    expect(exactHealth).toMatchObject({
      countAccuracy: "exact",
      counts: {
        rawPayloadCount: 1,
      },
      status: "ok",
    });
  });

  it("migrates live Polymarket player props to cross-provider canonical instrument IDs", () => {
    const dbPath = process.env.SIGNAL_CONSOLE_DB_PATH;
    if (!dbPath) {
      throw new Error("SIGNAL_CONSOLE_DB_PATH is required for this test.");
    }

    const legacy = new Database(dbPath);
    try {
      legacy.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
        INSERT INTO schema_migrations (version, name, applied_at)
        VALUES (5, 'canonical-instrument-consolidation', '2026-05-10T00:00:00.000Z');

        CREATE TABLE market_instruments (
          id TEXT PRIMARY KEY,
          game_id TEXT NOT NULL,
          family TEXT NOT NULL,
          selection TEXT NOT NULL,
          line REAL,
          participant_key TEXT,
          in_play INTEGER NOT NULL DEFAULT 0,
          display_label TEXT NOT NULL
        );

        CREATE TABLE source_markets (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          source_market_key TEXT NOT NULL,
          source_selection_key TEXT,
          game_id TEXT NOT NULL,
          instrument_id TEXT,
          raw_family TEXT,
          raw_label TEXT,
          mapping_status TEXT NOT NULL,
          raw_metadata_json TEXT
        );

        INSERT INTO market_instruments (
          id, game_id, family, selection, line, participant_key, in_play, display_label
        )
        VALUES (
          'nba-0042500173-points-lebron-james-over-24-5',
          'nba-0042500173',
          'player-prop',
          'over',
          24.5,
          'lebron-james',
          0,
          'LeBron James points over 24.5'
        );

        INSERT INTO source_markets (
          id, source, source_market_key, source_selection_key, game_id,
          instrument_id, raw_family, raw_label, mapping_status, raw_metadata_json
        )
        VALUES (
          'pm-2050554-over',
          'polymarket',
          'nba-lal-hou-2026-04-24-points-lebron-james-24pt5',
          'over',
          'nba-0042500173',
          'nba-0042500173-points-lebron-james-over-24-5',
          'points',
          'LeBron James: Points O/U 24.5',
          'auto',
          '{}'
        );
      `);
    } finally {
      legacy.close();
    }

    const db = getDatabase();

    expect(
      db
        .prepare("SELECT instrument_id FROM source_markets WHERE id = ?")
        .pluck()
        .get("pm-2050554-over")
    ).toBe("nba-0042500173-player-prop-points-lebron-james-over-24-5");
    expect(
      db
        .prepare("SELECT COUNT(*) FROM market_instruments WHERE id = ?")
        .pluck()
        .get("nba-0042500173-points-lebron-james-over-24-5")
    ).toBe(0);
    expect(
      db
        .prepare("SELECT COALESCE(MAX(version), 0) FROM schema_migrations")
        .pluck()
        .get()
    ).toBe(14);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('market_microstructure_events', 'market_anomaly_score_configs') ORDER BY name"
        )
        .pluck()
        .all()
    ).toEqual(["market_anomaly_score_configs", "market_microstructure_events"]);
  });

  it("creates a readable SQLite backup that includes WAL writes", async () => {
    upsertWatchlist({
      eventId: "bos-vs-nyk",
      note: "Research queue",
      priority: 91,
      status: "queued",
    });

    const snapshotPath = join(tempDir, "snapshot.sqlite");
    await backupDatabase(snapshotPath);

    const snapshot = new Database(snapshotPath, {
      fileMustExist: true,
      readonly: true,
    });
    try {
      expect(snapshot.prepare("PRAGMA integrity_check").pluck().get()).toBe(
        "ok"
      );
      expect(
        snapshot.prepare("SELECT COUNT(*) FROM watchlist").pluck().get()
      ).toBe(1);
    } finally {
      snapshot.close();
    }
  });

  it("reopens the sqlite handle when the database path changes", () => {
    upsertWatchlist({
      eventId: "bos-vs-nyk",
      status: "queued",
    });

    const firstHealth = checkDatabaseHealth();
    expect(firstHealth.counts.watchlistCount).toBe(1);

    const secondDir = mkdtempSync(join(tmpdir(), "signal-console-db-alt-"));
    process.env.SIGNAL_CONSOLE_DB_PATH = join(
      secondDir,
      "signal-console.sqlite"
    );

    const secondHealth = checkDatabaseHealth();

    expect(secondHealth.counts.watchlistCount).toBe(0);
    expect(secondHealth.counts.gameCount).toBe(0);

    rmSync(secondDir, { recursive: true, force: true });
  });
});
