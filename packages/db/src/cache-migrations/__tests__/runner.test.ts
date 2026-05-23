import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { runMigrations } from "../runner";

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
    "2026-05-23T00:00:00Z",
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

  it("enforces the UNIQUE constraint on detector_runs", () => {
    const db = newInMemoryDb();
    runMigrations(db);
    // SQLite treats NULLs as distinct under UNIQUE, so the collision must use
    // a row where every key column is non-NULL. Filling both game_id and the
    // window bounds (despite scope='window') is enough to prove the
    // constraint actually exists and fires.
    const collidingRow: RunOverrides = {
      scope: "window",
      game_id: "nba-0042500222",
      window_start: "2026-05-08T00:00:00Z",
      window_end: "2026-05-09T00:00:00Z",
    };
    insertRun(db, collidingRow);
    expect(() => insertRun(db, collidingRow)).toThrow(/UNIQUE/i);

    // Also assert the constraint surface schema-side: SQLite auto-creates an
    // index for every UNIQUE constraint declared on a table.
    const idxCount = db.prepare(
      "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND tbl_name = 'detector_runs' AND sql IS NULL",
    );
    idxCount.pluck();
    expect(idxCount.get()).toBe(1);

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
    expect(countObjects(db, "index", "idx_detector_obs_run_game")).toBe(1);
    expect(countObjects(db, "index", "idx_detector_obs_fired")).toBe(1);
    db.close();
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
