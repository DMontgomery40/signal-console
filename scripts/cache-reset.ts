// pnpm cache:reset — removes the writable detector-cache DB (and its WAL/SHM
// siblings) and reapplies migrations. Never touches the read-only gold DB.

import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";

import { CACHE_DB_PATH, openCacheDb } from "../packages/db/src/cache-migrations/runner";

function removeIfExists(path: string): void {
  rmSync(path, { force: true });
}

function main(): number {
  removeIfExists(CACHE_DB_PATH);
  removeIfExists(`${CACHE_DB_PATH}-wal`);
  removeIfExists(`${CACHE_DB_PATH}-shm`);
  mkdirSync(dirname(CACHE_DB_PATH), { recursive: true });
  const db = openCacheDb(CACHE_DB_PATH);
  db.close();
  process.stdout.write(`cache:reset OK (${CACHE_DB_PATH})\n`);
  return 0;
}

process.exit(main());
