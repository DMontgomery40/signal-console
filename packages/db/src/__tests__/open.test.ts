import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GOLD_DB_PATH, openGoldDb } from "../open";

interface TestContext {
  readonly tmpDir: string;
  readonly dbPath: string;
}

function seedFixtureDb(): TestContext {
  const tmpDir = mkdtempSync(join(tmpdir(), "signal-console-db-test-"));
  const dbPath = join(tmpDir, "fixture.sqlite");
  const writable = new Database(dbPath);
  writable.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  writable.exec("INSERT INTO t (v) VALUES ('seed')");
  writable.close();
  return { tmpDir, dbPath };
}

describe("openGoldDb", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = seedFixtureDb();
  });

  afterEach(() => {
    rmSync(ctx.tmpDir, { recursive: true, force: true });
  });

  it("returns a handle with query_only = 1", () => {
    const db = openGoldDb(ctx.dbPath);
    try {
      expect(db.pragma("query_only", { simple: true })).toBe(1);
    } finally {
      db.close();
    }
  });

  it("can still SELECT from the seeded fixture", () => {
    const db = openGoldDb(ctx.dbPath);
    try {
      const rows = db.prepare("SELECT v FROM t").all();
      expect(rows).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("throws on INSERT", () => {
    const db = openGoldDb(ctx.dbPath);
    try {
      expect(() => db.exec("INSERT INTO t (v) VALUES ('x')")).toThrow();
    } finally {
      db.close();
    }
  });

  it("throws on UPDATE", () => {
    const db = openGoldDb(ctx.dbPath);
    try {
      expect(() => db.exec("UPDATE t SET v = 'y' WHERE id = 1")).toThrow();
    } finally {
      db.close();
    }
  });

  it("throws on DELETE", () => {
    const db = openGoldDb(ctx.dbPath);
    try {
      expect(() => db.exec("DELETE FROM t")).toThrow();
    } finally {
      db.close();
    }
  });

  it("throws on CREATE TEMP VIEW (blocked by query_only)", () => {
    const db = openGoldDb(ctx.dbPath);
    try {
      expect(() => db.exec("CREATE TEMP VIEW vv AS SELECT 1")).toThrow();
    } finally {
      db.close();
    }
  });

  it("throws on PRAGMA journal_mode mutation", () => {
    const db = openGoldDb(ctx.dbPath);
    try {
      expect(() => db.exec("PRAGMA journal_mode = WAL")).toThrow(/readonly|query_only/i);
    } finally {
      db.close();
    }
  });

  it("throws if the file does not exist (fileMustExist guard)", () => {
    expect(() => openGoldDb(join(ctx.tmpDir, "missing.sqlite"))).toThrow();
  });

  it("GOLD_DB_PATH points at ~/signal-console/data/signal-console.sqlite", () => {
    const expected = join(homedir(), "signal-console", "data", "signal-console.sqlite");
    expect(GOLD_DB_PATH).toBe(expected);
    expect(GOLD_DB_PATH).not.toContain("nba-predict");
  });
});
