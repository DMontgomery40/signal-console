// Detector-cache DB migration runner (PRD §9). The cache DB is the only
// writable SQLite the API/UI code touches; the 54 GB gold DB stays read-only.
//
// runMigrations(db) applies 0001-init.sql via CREATE ... IF NOT EXISTS, so
// re-running on a populated DB adds no rows and raises no error.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
const INIT_SQL_PATH = join(HERE, "0001-init.sql");

export function runMigrations(db: Database.Database): void {
  const sql = readFileSync(INIT_SQL_PATH, "utf8");
  db.exec(sql);
}

export function openCacheDb(path: string = CACHE_DB_PATH): Database.Database {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}
