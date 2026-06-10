import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { DuckDBInstance } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// HERMETIC exporter test for pbp_actions.parquet (no operator gold DB): seeds
// a tiny gold-shaped DB via the REAL shared migrations
// (scripts/dev/seed-pbp-fixture-gold-db.ts — run as a subprocess so this
// package's stricter tsconfig does not have to compile @signal-console/shared),
// with one game whose rebound was silently corrected (actions table upserted
// to the corrected player; nba_pbp_revisions holds the original credit), runs
// the REAL exporter with --games, and asserts the snapshot carries the
// EARLIEST-OBSERVED (pre-correction) credit. Exporting the corrected row would
// reverse the paired-drift signature and suppress exactly the miscredits the
// composite producer hunts.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..", "..");
const exporter = resolve(repoRoot, "scripts", "export-quant-snapshot.ts");
const seeder = resolve(repoRoot, "scripts", "dev", "seed-pbp-fixture-gold-db.ts");

// Mirror the seeder's fixture constants (scripts/dev/seed-pbp-fixture-gold-db.ts).
const GAME_ID = "nba-0049900001";
const ORIGINAL_PERSON = 101; // credited at capture time (pre-correction)

const execFileAsync = promisify(execFile);

let workDir = "";
let snapshotDir = "";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

beforeAll(async () => {
  workDir = mkdtempSync(resolve(tmpdir(), "pbp-actions-export-test-"));
  const dbPath = resolve(workDir, "fixture-gold.sqlite");
  const env = { ...process.env, GOLD_DB_PATH: dbPath, SIGNAL_CONSOLE_DB_PATH: dbPath };
  await execFileAsync("npx", ["tsx", seeder], {
    cwd: repoRoot,
    env,
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  await execFileAsync(
    "npx",
    ["tsx", exporter, "--games", GAME_ID, "--out", workDir, "--snapshot-id", "pbp-fixture"],
    { cwd: repoRoot, env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
  );
  snapshotDir = resolve(workDir, "pbp-fixture");
}, 300_000);

afterAll(() => {
  if (workDir !== "" && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

async function readPbpActions(): Promise<readonly Record<string, unknown>[]> {
  const inst = await DuckDBInstance.create(":memory:");
  const conn = await inst.connect();
  const path = resolve(snapshotDir, "pbp_actions.parquet").replace(/'/g, "''");
  const reader = await conn.runAndReadAll(
    `SELECT * FROM read_parquet('${path}') ORDER BY action_number`,
  );
  const raw: readonly unknown[] = reader.getRowObjectsJson();
  conn.disconnectSync();
  inst.closeSync();
  return raw.filter(isRecord);
}

describe("pbp_actions export (hermetic fixture gold DB)", () => {
  it("writes pbp_actions.parquet with one row per action", async () => {
    expect(existsSync(resolve(snapshotDir, "pbp_actions.parquet"))).toBe(true);
    const rows = await readPbpActions();
    expect(rows.map((r) => Number(r["action_number"]))).toEqual([1, 2, 3, 4]);
  });

  it("exports the EARLIEST-observed (pre-correction) credit for a revised rebound", async () => {
    const rows = await readPbpActions();
    const revised = rows.find((r) => Number(r["action_number"]) === 3);
    // The actions table holds the corrected player; the snapshot must carry the
    // original credit from the earliest revision capture.
    expect(Number(revised?.["person_id"])).toBe(ORIGINAL_PERSON);
    expect(revised?.["player_name"]).toBe("Original Player");
  });

  it("falls back to the current action row when no revision exists", async () => {
    const rows = await readPbpActions();
    const control = rows.find((r) => Number(r["action_number"]) === 4);
    expect(Number(control?.["person_id"])).toBe(ORIGINAL_PERSON);
    expect(control?.["player_name"]).toBe("Original Player");
  });
});
