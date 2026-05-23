// Cache service (US-020).
//
// clearCache opens the detector-cache DB writable, deletes matching
// detector_runs rows (cascading detector_observations via FK ON DELETE
// CASCADE), and returns the number of run rows deleted. The gold DB is
// not touched.

import { openCacheDb } from "@signal-console/db";

export interface ClearCacheArgs {
  readonly detectorId?: string;
  readonly before?: string;
}

export interface ClearCacheResult {
  readonly deleted: number;
}

export function clearCache(cacheDbPath: string, args: ClearCacheArgs): ClearCacheResult {
  const db = openCacheDb(cacheDbPath);
  try {
    const clauses: string[] = [];
    const params: string[] = [];
    if (args.detectorId !== undefined) {
      clauses.push("detector_id = ?");
      params.push(args.detectorId);
    }
    if (args.before !== undefined) {
      clauses.push("computed_at < ?");
      params.push(args.before);
    }
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    const stmt = db.prepare(`DELETE FROM detector_runs ${where}`);
    const result = stmt.run(...params);
    const changes = typeof result.changes === "number" ? result.changes : 0;
    return { deleted: changes };
  } finally {
    db.close();
  }
}
