// Detector-cache DB migration runner (PRD §9). The cache DB is the only
// writable SQLite the API/UI code touches; the 54 GB gold DB stays read-only.
//
// runMigrations(db) applies unapplied numbered SQL files in lexical order.
// openCacheDb() remembers successfully migrated DB schemas in-process so request
// paths do not repeatedly reopen the migration ledger after startup.

import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

// Mirror open.ts's URI-mode opt-in so the addon initializes with
// sqlite3_config(SQLITE_CONFIG_URI, 1) regardless of which db-package module
// loads first in a given process. Plain paths (used here) parse identically
// either way; the env var only changes behavior for `file:...?...` URIs.
process.env.SQLITE_USE_URI = "1";

export const CACHE_DB_PATH: string = join(
  homedir(),
  "signal-console",
  "data",
  "detector-cache.sqlite",
);

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION_FILE_RE = /^\d{4}-.*\.sql$/;
const MIGRATION_LEDGER_TABLE = "cache_schema_migrations";
const processMigratedDbKeys = new Set<string>();

interface MigrationFile {
  readonly id: string;
  readonly path: string;
}

function migrationSqlPaths(): readonly MigrationFile[] {
  return readdirSync(HERE)
    .filter((name) => MIGRATION_FILE_RE.test(name))
    .toSorted()
    .map((name) => ({ id: basename(name, ".sql"), path: join(HERE, name) }));
}

function ensureMigrationLedger(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${MIGRATION_LEDGER_TABLE} (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
}

function appliedMigrationIds(db: Database.Database): Set<string> {
  const rows = db.prepare(`SELECT id FROM ${MIGRATION_LEDGER_TABLE}`).all();
  return new Set(
    rows.map((row) => {
      if (typeof row !== "object" || row === null || !("id" in row) || typeof row.id !== "string") {
        throw new Error("cache migration ledger row missing string id");
      }
      return row.id;
    }),
  );
}

function databaseSchemaVersion(db: Database.Database): number {
  const version = db.pragma("schema_version", { simple: true });
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new Error("cache DB schema_version pragma returned a non-integer value");
  }
  return version;
}

function processMigrationKey(db: Database.Database, path: string): string | null {
  if (path === ":memory:" || path.startsWith("file:")) return null;
  const stat = statSync(path);
  return `${path}:${stat.dev}:${stat.ino}:schema:${databaseSchemaVersion(db)}`;
}

function ensureCacheDbParentDirectory(path: string): void {
  if (path === ":memory:" || path.startsWith("file:")) return;
  mkdirSync(dirname(path), { recursive: true });
}

export function runMigrations(db: Database.Database): void {
  db.pragma("foreign_keys = ON");
  ensureMigrationLedger(db);
  const applied = appliedMigrationIds(db);
  const markApplied = db.prepare(
    `INSERT INTO ${MIGRATION_LEDGER_TABLE} (id, applied_at) VALUES (?, ?)`,
  );
  const applyMigration = db.transaction((migration: MigrationFile) => {
    db.exec(readFileSync(migration.path, "utf8"));
    markApplied.run(migration.id, new Date().toISOString());
    applied.add(migration.id);
  });

  for (const migration of migrationSqlPaths()) {
    if (!applied.has(migration.id)) {
      applyMigration(migration);
    }
  }
}

export function openCacheDb(path: string = CACHE_DB_PATH): Database.Database {
  ensureCacheDbParentDirectory(path);
  const db = new Database(path);
  const key = processMigrationKey(db, path);
  if (key === null || !processMigratedDbKeys.has(key)) {
    runMigrations(db);
    const migratedKey = processMigrationKey(db, path);
    if (migratedKey !== null) processMigratedDbKeys.add(migratedKey);
  } else {
    db.pragma("foreign_keys = ON");
  }
  return db;
}
