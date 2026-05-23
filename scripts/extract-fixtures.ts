// pnpm exec tsx scripts/extract-fixtures.ts
//
// Extracts board-mad detector canonical contract-test fixtures from the gold DB
// for the three PBP-anchored games (US-010). One JSON-gz file per game, written
// to packages/detectors/src/board-mad/__tests__/fixtures/<gameId>.json.gz.
//
// This script is owner-runnable: it reads the gold-DB path from the GOLD_DB_PATH
// env var (defaulting to packages/db's GOLD_DB_PATH constant, i.e. the new
// repo's data/ location). It is NOT required to run in CI; the committed
// fixtures are what tests consume. Re-run if a fixture window needs to change.
//
// Procedure to (re)generate:
//   1. Ensure better-sqlite3 is installed at the repo root (pnpm install).
//   2. Point GOLD_DB_PATH at the live gold DB if it has not yet been moved to
//      the new repo's data/ directory; otherwise the default is used.
//      Example (Phase-0 pre-cutover):
//        GOLD_DB_PATH=/absolute/path/to/signal-console.sqlite \
//          pnpm exec tsx scripts/extract-fixtures.ts
//   3. Commit the regenerated *.json.gz files. Verify size with
//      `du -sh packages/detectors/src/board-mad/__tests__/fixtures/` (cap 5 MB).
//
// Fixture wire format (after gunzip):
//   {
//     "gameId": "<id>",
//     "window": { "start": "<iso>", "end": "<iso>" },
//     "ticks": [
//       { "sourceMarketId": "<id>", "capturedAt": "<iso>",
//         "impliedProbability": <number|null>, "volume": <number>,
//         "isHeartbeat": <boolean> }, ...
//     ]
//   }
// NULL volumes in the gold DB are coalesced to 0 here (the API/route boundary
// would do the same, since the detector's Tick.volume is non-nullable and
// log1p(NaN) silently breaks intensities). isHeartbeat is the column's INTEGER
// 0/1 cast to boolean.

import { gzipSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { GOLD_DB_PATH, openGoldDb } from "../packages/db/src/open";

interface FixtureSpec {
  readonly gameId: string;
  readonly windowStart: string;
  readonly windowEnd: string;
}

const FIXTURES: readonly FixtureSpec[] = [
  // Hartenstein (NBA PBP anchor 2026-05-08T03:12:36.8Z). Bucket-start 03:12:00Z
  // is well inside this 2-hour window; ~72 min of pre-event ticks exceed the
  // 28-bucket warmup + trailing-window budget at bucketSeconds=60.
  {
    gameId: "nba-0042500222",
    windowStart: "2026-05-08T02:00:00Z",
    windowEnd: "2026-05-08T04:00:00Z",
  },
  // Reaves no-fire anchors (NBA PBP event 2026-05-12T04:51:40.2Z). Both games
  // were live at this slot; nba-0042500223's tick density on 5/12 is higher
  // than 5/10's scheduled-start window despite the games table scheduled_start.
  {
    gameId: "nba-0042500223",
    windowStart: "2026-05-12T03:30:00Z",
    windowEnd: "2026-05-12T05:30:00Z",
  },
  {
    gameId: "nba-0042500224",
    windowStart: "2026-05-12T03:30:00Z",
    windowEnd: "2026-05-12T05:30:00Z",
  },
];

interface TickRow {
  readonly sourceMarketId: string;
  readonly capturedAt: string;
  readonly impliedProbability: number | null;
  readonly volume: number;
  readonly isHeartbeat: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function fieldString(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  if (typeof v !== "string") {
    throw new Error(`row ${key}: expected string, got ${typeof v}`);
  }
  return v;
}

function fieldNumber(row: Record<string, unknown>, key: string): number {
  const v = row[key];
  if (typeof v !== "number") {
    throw new Error(`row ${key}: expected number, got ${typeof v}`);
  }
  return v;
}

function fieldNumberOrNull(row: Record<string, unknown>, key: string): number | null {
  const v = row[key];
  if (v === null) return null;
  if (typeof v === "number") return v;
  throw new Error(`row ${key}: expected number|null, got ${typeof v}`);
}

function fieldBitBool(row: Record<string, unknown>, key: string): boolean {
  const v = row[key];
  if (v === 0) return false;
  if (v === 1) return true;
  throw new Error(`row ${key}: expected 0|1, got ${String(v)}`);
}

function toTick(row: unknown): TickRow {
  if (!isRecord(row)) {
    throw new Error("row is not an object");
  }
  return {
    sourceMarketId: fieldString(row, "source_market_id"),
    capturedAt: fieldString(row, "captured_at"),
    impliedProbability: fieldNumberOrNull(row, "implied_probability"),
    volume: fieldNumber(row, "volume"),
    isHeartbeat: fieldBitBool(row, "is_heartbeat"),
  };
}

function extractOne(dbPath: string, spec: FixtureSpec, fixturesDir: string): number {
  const db = openGoldDb(dbPath);
  try {
    const stmt = db.prepare(
      `SELECT qt.source_market_id AS source_market_id,
              qt.captured_at AS captured_at,
              qt.implied_probability AS implied_probability,
              COALESCE(qt.volume, 0) AS volume,
              qt.is_heartbeat AS is_heartbeat
       FROM quote_ticks qt
       JOIN source_markets sm ON sm.id = qt.source_market_id
       WHERE sm.game_id = ?
         AND qt.captured_at >= ?
         AND qt.captured_at <  ?
       ORDER BY qt.source_market_id, qt.captured_at`,
    );
    const rows: readonly unknown[] = stmt.all(spec.gameId, spec.windowStart, spec.windowEnd);
    const ticks: readonly TickRow[] = rows.map((r): TickRow => toTick(r));
    const payload = {
      gameId: spec.gameId,
      window: { start: spec.windowStart, end: spec.windowEnd },
      ticks,
    };
    const json = JSON.stringify(payload);
    const gz = gzipSync(Buffer.from(json, "utf8"), { level: 9 });
    const outPath = resolve(fixturesDir, `${spec.gameId}.json.gz`);
    writeFileSync(outPath, gz);
    process.stdout.write(
      `  ${spec.gameId}: ${String(ticks.length)} ticks → ${outPath} (${String(gz.length)} bytes)\n`,
    );
    return ticks.length;
  } finally {
    db.close();
  }
}

function main(): number {
  const dbPath = process.env.GOLD_DB_PATH ?? GOLD_DB_PATH;
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const fixturesDir = resolve(
    scriptDir,
    "..",
    "packages",
    "detectors",
    "src",
    "board-mad",
    "__tests__",
    "fixtures",
  );
  mkdirSync(fixturesDir, { recursive: true });
  process.stdout.write(`extract-fixtures: reading ${dbPath}\n`);
  for (const spec of FIXTURES) {
    extractOne(dbPath, spec, fixturesDir);
  }
  process.stdout.write("extract-fixtures OK\n");
  return 0;
}

process.exit(main());
