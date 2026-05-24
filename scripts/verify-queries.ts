// pnpm exec tsx scripts/verify-queries.ts [-u | --update]
//
// Opens the gold DB via openGoldDb() (read-only, query_only=ON enforced) and
// runs EXPLAIN QUERY PLAN for the 5 hottest queries used by the API layer:
//
//   1. games-last-24h            (v_games CTE, /v1/games)
//   2. ticks-for-one-game-window (quote_ticks + source_markets, /v1/live)
//   3. microstructure-for-one-game (/v1/microstructure)
//   4. board-buckets-for-one-game (board-mad detector input, /v1/board)
//   5. pbp-for-one-game          (NBA PBP overlay)
//
// Default mode: reads each snapshot from
// packages/db/src/queries/__tests__/__snapshots__/<query-name>.plan.txt,
// compares against the freshly-rendered plan, exits 1 on any diff.
//
// `-u` / `--update` mode: rewrites each snapshot from the current plan.
//
// In BOTH modes, every plan row is inspected and the script exits 1 if any
// non-trivial table (quote_ticks, market_microstructure_events, source_markets,
// nba_play_by_play_actions, game_states) appears in a "SCAN" row WITHOUT a
// "USING INDEX" qualifier — i.e. the planner is doing a full table scan on a
// table that should always be hit via an index.
//
// This script is chained into `pnpm verify`, so the standard gate also guards
// query-plan drift. Set GOLD_DB_PATH if the gold DB is not at the default
// post-Phase-0 location (`~/signal-console/data/signal-console.sqlite`).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { GOLD_DB_PATH, openGoldDb } from "../packages/db/src/open";
import { v_games } from "../packages/db/src/sport-views";

// better-sqlite3's `Database.Database` type isn't visible from the scripts/
// tsconfig (its @types live under packages/db). Borrow the handle type from
// openGoldDb's return so we don't need a direct better-sqlite3 import here.
type GoldDbHandle = ReturnType<typeof openGoldDb>;

interface QueryDef {
  readonly name: string;
  readonly sql: string;
  readonly params: ReadonlyArray<string | number>;
  // Alias -> physical table for non-trivial tables referenced in the query.
  // Used to resolve `SCAN qt` style plan rows back to their underlying table.
  readonly aliases: Readonly<Record<string, string>>;
}

interface PlanRow {
  readonly id: number;
  readonly parent: number;
  readonly detail: string;
}

const NON_TRIVIAL_TABLES: readonly string[] = [
  "quote_ticks",
  "market_microstructure_events",
  "source_markets",
  "nba_play_by_play_actions",
  "game_states",
];

const QUERIES: readonly QueryDef[] = [
  {
    name: "games-last-24h",
    sql: `
      WITH v_games AS (${v_games})
      SELECT id, sport, league, scheduled_start, status
      FROM   v_games
      WHERE  scheduled_start >= ?
      ORDER  BY scheduled_start DESC
    `,
    // `g` aliases `games` (small table, full scan OK). `gs` aliases
    // `game_states` (non-trivial, must use idx_game_states_game_captured).
    params: ["2026-05-22T00:00:00Z"],
    aliases: { gs: "game_states" },
  },
  {
    name: "ticks-for-one-game-window",
    sql: `
      SELECT qt.source_market_id, qt.captured_at, qt.implied_probability,
             qt.volume, qt.is_heartbeat
      FROM   quote_ticks qt
      JOIN   source_markets sm ON sm.id = qt.source_market_id
      WHERE  sm.game_id = ?
        AND  qt.captured_at >= ?
        AND  qt.captured_at <= ?
      ORDER  BY qt.captured_at
    `,
    params: ["nba-0042500222", "2026-05-08T03:07:00Z", "2026-05-08T03:12:00Z"],
    aliases: { qt: "quote_ticks", sm: "source_markets" },
  },
  {
    name: "microstructure-for-one-game",
    sql: `
      SELECT id, source_market_id, event_timestamp, volume_share,
             event_type, api_surface
      FROM   market_microstructure_events
      WHERE  game_id = ?
        AND  volume_share >= ?
      ORDER  BY event_timestamp
    `,
    params: ["nba-0042500222", 0.1],
    aliases: {},
  },
  {
    name: "board-buckets-for-one-game",
    sql: `
      SELECT qt.source_market_id, qt.captured_at, qt.implied_probability,
             qt.volume, qt.is_heartbeat
      FROM   quote_ticks qt
      JOIN   source_markets sm ON sm.id = qt.source_market_id
      WHERE  sm.game_id = ?
        AND  qt.captured_at >= ?
      ORDER  BY qt.source_market_id, qt.captured_at
    `,
    params: ["nba-0042500222", "2026-05-08T01:00:00Z"],
    aliases: { qt: "quote_ticks", sm: "source_markets" },
  },
  {
    name: "pbp-for-one-game",
    sql: `
      SELECT action_number, action_type, period, clock, description, time_actual
      FROM   nba_play_by_play_actions
      WHERE  game_id = ?
      ORDER  BY action_number
    `,
    params: ["nba-0042500222"],
    aliases: {},
  },
];

const SNAPSHOT_DIR = resolve(
  import.meta.dirname,
  "..",
  "packages",
  "db",
  "src",
  "queries",
  "__tests__",
  "__snapshots__",
);

function asPlanRow(value: unknown): PlanRow {
  if (value === null || typeof value !== "object") {
    throw new Error("EXPLAIN QUERY PLAN row is not an object");
  }
  if (!("id" in value) || typeof value.id !== "number") {
    throw new Error("EXPLAIN QUERY PLAN row missing numeric id");
  }
  if (!("parent" in value) || typeof value.parent !== "number") {
    throw new Error("EXPLAIN QUERY PLAN row missing numeric parent");
  }
  if (!("detail" in value) || typeof value.detail !== "string") {
    throw new Error("EXPLAIN QUERY PLAN row missing string detail");
  }
  return { id: value.id, parent: value.parent, detail: value.detail };
}

function explainQueryPlan(db: GoldDbHandle, q: QueryDef): readonly PlanRow[] {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.params);
  return rows.map(asPlanRow);
}

function renderPlan(rows: readonly PlanRow[]): string {
  const depthById = new Map<number, number>();
  const lines: string[] = ["QUERY PLAN"];
  for (const row of rows) {
    const parentDepth = row.parent === 0 ? -1 : (depthById.get(row.parent) ?? 0);
    const depth = parentDepth + 1;
    depthById.set(row.id, depth);
    lines.push(`${"  ".repeat(depth)}${row.detail}`);
  }
  return lines.join("\n") + "\n";
}

function scannedIdentifier(detail: string): string | null {
  const tokens = detail.split(/\s+/u);
  if (tokens[0] !== "SCAN") return null;
  if (tokens[1] === "TABLE") return tokens[2] ?? null;
  return tokens[1] ?? null;
}

export function offendingScans(
  rows: readonly PlanRow[],
  aliases: Readonly<Record<string, string>>,
): string[] {
  const offenders: string[] = [];
  for (const row of rows) {
    const detail = row.detail;
    if (!detail.startsWith("SCAN ")) continue;
    if (detail.includes("USING ")) continue;
    const firstToken = scannedIdentifier(detail);
    if (firstToken === null) continue;
    const resolved = aliases[firstToken] ?? firstToken;
    if (NON_TRIVIAL_TABLES.includes(resolved)) {
      offenders.push(`full SCAN of '${resolved}' — plan row: "${detail}"`);
    }
  }
  return offenders;
}

function isUpdateMode(argv: readonly string[]): boolean {
  return argv.some((a) => a === "-u" || a === "--update");
}

function snapshotPath(name: string): string {
  return resolve(SNAPSHOT_DIR, `${name}.plan.txt`);
}

interface QueryOutcome {
  readonly name: string;
  readonly status: "ok" | "diff" | "missing" | "scan-fail";
  readonly message?: string;
}

function processQuery(db: GoldDbHandle, q: QueryDef, update: boolean): QueryOutcome {
  const rows = explainQueryPlan(db, q);
  const offenders = offendingScans(rows, q.aliases);
  if (offenders.length > 0) {
    return {
      name: q.name,
      status: "scan-fail",
      message: offenders.join("\n  "),
    };
  }
  const rendered = renderPlan(rows);
  const path = snapshotPath(q.name);
  if (update) {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    writeFileSync(path, rendered, "utf8");
    return { name: q.name, status: "ok", message: `wrote ${path}` };
  }
  if (!existsSync(path)) {
    return {
      name: q.name,
      status: "missing",
      message: `no snapshot at ${path}; run \`pnpm verify:queries -u\` to create it`,
    };
  }
  const existing = readFileSync(path, "utf8");
  if (existing !== rendered) {
    return {
      name: q.name,
      status: "diff",
      message: `snapshot drift in ${path}; run \`pnpm verify:queries -u\` after review`,
    };
  }
  return { name: q.name, status: "ok" };
}

function main(): number {
  const update = isUpdateMode(process.argv.slice(2));
  const dbPath = process.env.GOLD_DB_PATH ?? GOLD_DB_PATH;
  if (!existsSync(dbPath)) {
    process.stderr.write(
      `verify:queries FAILED: gold DB not found at ${dbPath}.\n` +
        `Set GOLD_DB_PATH or move the DB into place (see docs/gold-db-relocation.md).\n`,
    );
    return 1;
  }
  const db = openGoldDb(dbPath);
  const outcomes: QueryOutcome[] = [];
  try {
    for (const q of QUERIES) {
      outcomes.push(processQuery(db, q, update));
    }
  } finally {
    db.close();
  }
  const failed = outcomes.filter((o) => o.status !== "ok");
  if (failed.length === 0) {
    const action = update ? "wrote" : "matched";
    process.stdout.write(
      `verify:queries OK (${action} ${String(outcomes.length)} snapshot(s) against ${dbPath})\n`,
    );
    return 0;
  }
  process.stderr.write(
    `verify:queries FAILED: ${String(failed.length)} of ${String(outcomes.length)} queries\n`,
  );
  for (const f of failed) {
    process.stderr.write(`  [${f.status}] ${f.name}: ${f.message ?? ""}\n`);
  }
  return 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
