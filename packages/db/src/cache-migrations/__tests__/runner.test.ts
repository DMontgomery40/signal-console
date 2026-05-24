import Database from "better-sqlite3";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { openCacheDb, runMigrations } from "../runner";

function newInMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  return db;
}

function countObjects(db: Database.Database, type: "table" | "index", name: string): number {
  const stmt = db.prepare("SELECT COUNT(*) FROM sqlite_master WHERE type = ? AND name = ?");
  stmt.pluck();
  const value = stmt.get(type, name);
  if (typeof value !== "number") {
    throw new Error(`expected number from COUNT(*), got ${typeof value}`);
  }
  return value;
}

interface RunOverrides {
  readonly computed_at?: string;
  readonly params_hash?: string;
  readonly scope?: "game" | "window";
  readonly game_id?: string | null;
  readonly window_start?: string | null;
  readonly window_end?: string | null;
}

function insertRun(db: Database.Database, overrides: RunOverrides = {}): Database.RunResult {
  const stmt = db.prepare(`
    INSERT INTO detector_runs (
      detector_id, detector_version, params_hash, params_json,
      source_db_path, source_watermark_hash, scope, game_id,
      window_start, window_end, computed_at, compute_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(
    "board-mad",
    "1.0.0",
    overrides.params_hash ?? "params-hash-1",
    "{}",
    "/tmp/gold.sqlite",
    "watermark-hash-1",
    overrides.scope ?? "game",
    overrides.game_id === undefined ? "nba-0042500222" : overrides.game_id,
    overrides.window_start === undefined ? null : overrides.window_start,
    overrides.window_end === undefined ? null : overrides.window_end,
    overrides.computed_at ?? "2026-05-23T00:00:00Z",
    10,
  );
}

describe("cache-migrations/runner", () => {
  it("creates detector_runs and detector_observations tables", () => {
    const db = newInMemoryDb();
    runMigrations(db);
    expect(countObjects(db, "table", "detector_runs")).toBe(1);
    expect(countObjects(db, "table", "detector_observations")).toBe(1);
    db.close();
  });

  it("creates idx_detector_obs_run_game and idx_detector_obs_fired indexes", () => {
    const db = newInMemoryDb();
    runMigrations(db);
    expect(countObjects(db, "index", "idx_detector_obs_run_game")).toBe(1);
    expect(countObjects(db, "index", "idx_detector_obs_fired")).toBe(1);
    db.close();
  });

  it("enforces detector_runs identity for production nullable cache shapes", () => {
    const db = newInMemoryDb();
    runMigrations(db);

    const gameScopedRow: RunOverrides = {
      scope: "game",
      game_id: "nba-0042500222",
      window_start: null,
      window_end: null,
    };
    insertRun(db, gameScopedRow);
    expect(() => insertRun(db, gameScopedRow)).toThrow(/UNIQUE/i);

    const windowScopedRow: RunOverrides = {
      scope: "window",
      game_id: null,
      window_start: "2026-05-08T00:00:00Z",
      window_end: "2026-05-09T00:00:00Z",
      params_hash: "params-hash-2",
    };
    insertRun(db, windowScopedRow);
    expect(() => insertRun(db, windowScopedRow)).toThrow(/UNIQUE/i);

    const idxCount = db.prepare(
      "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_detector_runs_identity_normalized'",
    );
    idxCount.pluck();
    expect(idxCount.get()).toBe(1);

    db.close();
  });

  it("initial schema enforces detector_runs identity for nullable cache shapes", () => {
    const db = newInMemoryDb();
    db.exec(readFileSync(new URL("../0001-init.sql", import.meta.url), "utf8"));

    const gameScopedRow: RunOverrides = {
      scope: "game",
      game_id: "nba-0042500222",
      window_start: null,
      window_end: null,
    };
    insertRun(db, gameScopedRow);
    expect(() => insertRun(db, gameScopedRow)).toThrow(/UNIQUE/i);

    const windowScopedRow: RunOverrides = {
      scope: "window",
      game_id: null,
      window_start: "2026-05-08T00:00:00Z",
      window_end: "2026-05-09T00:00:00Z",
      params_hash: "params-hash-2",
    };
    insertRun(db, windowScopedRow);
    expect(() => insertRun(db, windowScopedRow)).toThrow(/UNIQUE/i);
    expect(countObjects(db, "index", "idx_detector_runs_identity_normalized")).toBe(1);
    db.close();
  });

  it("deduplicates legacy rows before adding the normalized identity index", () => {
    const db = newInMemoryDb();
    db.exec(`
      CREATE TABLE detector_runs (
        id INTEGER PRIMARY KEY,
        detector_id TEXT NOT NULL,
        detector_version TEXT NOT NULL,
        params_hash TEXT NOT NULL,
        params_json TEXT NOT NULL,
        source_db_path TEXT NOT NULL,
        source_watermark_hash TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('game','window')),
        game_id TEXT,
        window_start TEXT,
        window_end TEXT,
        computed_at TEXT NOT NULL,
        compute_ms INTEGER NOT NULL
      );
      CREATE TABLE detector_observations (
        id INTEGER PRIMARY KEY,
        run_id INTEGER NOT NULL REFERENCES detector_runs(id) ON DELETE CASCADE,
        game_id TEXT NOT NULL,
        bucket_start TEXT NOT NULL,
        bucket_end TEXT NOT NULL,
        fired INTEGER NOT NULL,
        intensity REAL,
        baseline_median REAL,
        baseline_mad REAL,
        detail_json TEXT
      );
    `);

    const newest = insertRun(db, {
      computed_at: "2026-05-23T02:00:00Z",
      game_id: "nba-legacy-1",
      scope: "game",
    });
    insertRun(db, {
      computed_at: "2026-05-23T01:00:00Z",
      game_id: "nba-legacy-1",
      scope: "game",
    });
    db.prepare(
      `INSERT INTO detector_observations
         (run_id, game_id, bucket_start, bucket_end, fired, intensity)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      Number(newest.lastInsertRowid),
      "nba-legacy-1",
      "2026-05-08T03:12:00Z",
      "2026-05-08T03:13:00Z",
      1,
      1.5,
    );

    runMigrations(db);

    const runs = db.prepare("SELECT id FROM detector_runs ORDER BY id ASC").all();
    expect(runs).toEqual([{ id: Number(newest.lastInsertRowid) }]);
    const obsCount = db.prepare("SELECT COUNT(*) FROM detector_observations");
    obsCount.pluck();
    expect(obsCount.get()).toBe(1);
    expect(() => insertRun(db, { scope: "game", game_id: "nba-legacy-1" })).toThrow(/UNIQUE/i);
    db.close();
  });

  it("cascades observations on run deletion (FK ON DELETE CASCADE)", () => {
    const db = newInMemoryDb();
    runMigrations(db);
    const inserted = insertRun(db);
    const runId = Number(inserted.lastInsertRowid);
    db.prepare(
      `INSERT INTO detector_observations
         (run_id, game_id, bucket_start, bucket_end, fired, intensity)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(runId, "nba-0042500222", "2026-05-08T03:12:00Z", "2026-05-08T03:13:00Z", 1, 1.5);
    db.prepare("DELETE FROM detector_runs WHERE id = ?").run(runId);
    const remaining = db.prepare("SELECT COUNT(*) FROM detector_observations");
    remaining.pluck();
    expect(remaining.get()).toBe(0);
    db.close();
  });

  it("is idempotent: re-running the migration adds no rows and raises no error", () => {
    const db = newInMemoryDb();
    runMigrations(db);
    insertRun(db);
    expect(() => {
      runMigrations(db);
    }).not.toThrow();
    const stmt = db.prepare("SELECT COUNT(*) FROM detector_runs");
    stmt.pluck();
    expect(stmt.get()).toBe(1);
    expect(countObjects(db, "table", "detector_runs")).toBe(1);
    expect(countObjects(db, "table", "detector_observations")).toBe(1);
    expect(countObjects(db, "table", "cache_schema_migrations")).toBe(1);
    expect(countObjects(db, "index", "idx_detector_obs_run_game")).toBe(1);
    expect(countObjects(db, "index", "idx_detector_obs_fired")).toBe(1);
    const migrationCount = db.prepare("SELECT COUNT(*) FROM cache_schema_migrations");
    migrationCount.pluck();
    expect(migrationCount.get()).toBe(2);
    db.close();
  });

  it("openCacheDb skips already recorded migration files on later opens", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "signal-console-cache-migrations-"));
    const dbPath = join(tempDir, "cache.sqlite");
    try {
      openCacheDb(dbPath).close();

      const tampered = new Database(dbPath);
      const firstLedgerAppliedAt = tampered
        .prepare(
          "SELECT applied_at FROM cache_schema_migrations WHERE id = '0002-detector-run-identity'",
        )
        .pluck()
        .get();
      tampered.exec("DROP INDEX idx_detector_runs_identity_normalized");
      insertRun(tampered, { scope: "game", game_id: "nba-ledger-1" });
      insertRun(tampered, { scope: "game", game_id: "nba-ledger-1" });
      tampered.close();

      const reopened = openCacheDb(dbPath);
      const runCount = reopened.prepare("SELECT COUNT(*) FROM detector_runs");
      runCount.pluck();
      expect(runCount.get()).toBe(2);
      expect(countObjects(reopened, "index", "idx_detector_runs_identity_normalized")).toBe(0);
      const migrationCount = reopened.prepare("SELECT COUNT(*) FROM cache_schema_migrations");
      migrationCount.pluck();
      expect(migrationCount.get()).toBe(2);
      const secondLedgerAppliedAt = reopened
        .prepare(
          "SELECT applied_at FROM cache_schema_migrations WHERE id = '0002-detector-run-identity'",
        )
        .pluck()
        .get();
      expect(secondLedgerAppliedAt).toBe(firstLedgerAppliedAt);
      reopened.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("openCacheDb creates missing parent directories before opening a file cache", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "signal-console-cache-migrations-"));
    const dbPath = join(tempDir, "fresh", "nested", "cache.sqlite");
    try {
      const db = openCacheDb(dbPath);
      try {
        expect(existsSync(dbPath)).toBe(true);
        expect(countObjects(db, "table", "detector_runs")).toBe(1);
        expect(countObjects(db, "table", "cache_schema_migrations")).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("openCacheDb reruns migrations when a previously opened file has its schema reset", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "signal-console-cache-migrations-"));
    const dbPath = join(tempDir, "cache.sqlite");
    try {
      openCacheDb(dbPath).close();

      const reset = new Database(dbPath);
      reset.exec(`
        DROP TABLE IF EXISTS detector_observations;
        DROP TABLE IF EXISTS detector_runs;
        DROP TABLE IF EXISTS cache_schema_migrations;
      `);
      reset.close();

      const reopened = openCacheDb(dbPath);
      expect(countObjects(reopened, "table", "detector_runs")).toBe(1);
      expect(countObjects(reopened, "table", "detector_observations")).toBe(1);
      expect(countObjects(reopened, "table", "cache_schema_migrations")).toBe(1);
      const migrationCount = reopened.prepare("SELECT COUNT(*) FROM cache_schema_migrations");
      migrationCount.pluck();
      expect(migrationCount.get()).toBe(2);
      reopened.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects scope values outside ('game','window') via the CHECK constraint", () => {
    const db = newInMemoryDb();
    runMigrations(db);
    const stmt = db.prepare(`
      INSERT INTO detector_runs (
        detector_id, detector_version, params_hash, params_json,
        source_db_path, source_watermark_hash, scope, game_id,
        window_start, window_end, computed_at, compute_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    expect(() =>
      stmt.run(
        "board-mad",
        "1.0.0",
        "ph",
        "{}",
        "/tmp/gold.sqlite",
        "wh",
        "everything",
        "nba-1",
        null,
        null,
        "2026-05-23T00:00:00Z",
        10,
      ),
    ).toThrow(/CHECK/i);
    db.close();
  });
});
