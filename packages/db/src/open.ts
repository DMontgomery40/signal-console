// Read-only gold-DB open path (PRD §11.1).
// All API/UI/cache code MUST open the gold DB via openGoldDb().
// Four independent guards are applied; the function throws at startup if
// PRAGMA query_only reads back as anything other than 1.

import { homedir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

// better-sqlite3 honors SQLite's `file:...` URI parsing only when
// SQLITE_USE_URI=1 is set before the native addon initializes
// (sqlite3_config(SQLITE_CONFIG_URI, 1) is process-global and called once).
// The addon loads lazily on first `new Database(...)` call, so setting the
// env var at module-evaluation time is in time. This is PRD §11.1 guard #1
// (the `?mode=ro` URI suffix); guard #2 (`readonly: true`) still enforces
// SQLITE_OPEN_READONLY independently if this env tweak ever drifts.
process.env.SQLITE_USE_URI = "1";

export const GOLD_DB_PATH: string = join(
  homedir(),
  "signal-console",
  "data",
  "signal-console.sqlite",
);

export function openGoldDb(path: string): Database.Database {
  const url = `file:${path}?mode=ro`;
  const db = new Database(url, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  db.pragma("query_only = ON");
  const queryOnly = db.pragma("query_only", { simple: true });
  if (queryOnly !== 1) {
    db.close();
    throw new Error("gold DB connection is not query_only");
  }
  return db;
}
