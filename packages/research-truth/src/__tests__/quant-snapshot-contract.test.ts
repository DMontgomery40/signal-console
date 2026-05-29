import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DuckDBInstance } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Contract + truth-parity gate for the TS-owned quant-lab snapshot exporter
// (scripts/export-quant-snapshot.ts). This runs the REAL exporter against the
// read-only gold DB into a temp output dir, then asserts:
//   - all required files exist
//   - board_observations + source_coverage carry the required columns
//   - manifest has every provenance field
//   - splits never leak an incident game into the test side
//   - END-TO-END TRUTH PARITY: market_outlier_episodes for nba-0042500222 match
//     the episodes committed at 882621b (embedded golden below — the committed
//     values are the real golden; recomputing via the same fn would be circular).

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..", "..");
const exporter = resolve(repoRoot, "scripts", "export-quant-snapshot.ts");
const GOLD_DB_PATH = "/Users/davidmontgomery/signal-console/data/signal-console.sqlite";
const PARITY_GAME = "nba-0042500222";

// Golden market_outlier_episodes for nba-0042500222 from the committed bakeoff
// output at commit 882621b (outputs/nba-detector-bakeoff/research/bakeoff-results.json).
const GOLDEN_PARITY_EPISODES = [
  {
    startIso: "2026-05-08T04:17:00.000Z",
    endIso: "2026-05-08T04:17:30.000Z",
    bucketCount: 1,
    peakSeverity: 3.006,
    peakActiveMarkets: 70,
    peakSources: 1,
    peakFamilies: 14,
    diagnosis: "price move outlier; broad market participation",
  },
  {
    startIso: "2026-05-08T04:19:00.000Z",
    endIso: "2026-05-08T04:19:30.000Z",
    bucketCount: 1,
    peakSeverity: 3.255,
    peakActiveMarkets: 49,
    peakSources: 1,
    peakFamilies: 11,
    diagnosis: "price move outlier; broad market participation",
  },
] as const;

const goldDbAvailable = existsSync(GOLD_DB_PATH);
const describeMaybe = goldDbAvailable ? describe : describe.skip;

let snapshotDir = "";
let outRoot = "";

beforeAll(() => {
  if (!goldDbAvailable) return;
  outRoot = mkdtempSync(resolve(tmpdir(), "quant-snapshot-test-"));
  // Restrict to the parity game + one other incident game so the contract test
  // runs fast while still exercising incident-game/splits logic.
  const result = spawnSync(
    "npx",
    [
      "tsx",
      exporter,
      "--games",
      `${PARITY_GAME},nba-0042500224`,
      "--snapshot-id",
      "contract-test",
      "--out",
      outRoot,
      "--seed",
      "7",
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, GOLD_DB_PATH, SIGNAL_CONSOLE_DB_PATH: GOLD_DB_PATH },
      encoding: "utf8",
      timeout: 300_000,
    },
  );
  if (result.status !== 0) {
    throw new Error(`exporter failed: ${result.stderr || result.stdout}`);
  }
  snapshotDir = resolve(outRoot, "contract-test");
}, 320_000);

afterAll(() => {
  if (outRoot !== "" && existsSync(outRoot)) rmSync(outRoot, { recursive: true, force: true });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(resolve(snapshotDir, file), "utf8"));
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

async function readParquetRows(file: string): Promise<readonly Record<string, unknown>[]> {
  const inst = await DuckDBInstance.create(":memory:");
  const conn = await inst.connect();
  const path = resolve(snapshotDir, file).replace(/'/g, "''");
  const reader = await conn.runAndReadAll(`SELECT * FROM read_parquet('${path}')`);
  const raw: readonly unknown[] = reader.getRowObjectsJson();
  conn.disconnectSync();
  inst.closeSync();
  return raw.filter(isRecord);
}

describeMaybe("quant-lab snapshot exporter contract", () => {
  const REQUIRED_FILES = [
    "manifest.json",
    "games.parquet",
    "board_observations.parquet",
    "incidents.parquet",
    "score_windows.parquet",
    "market_outlier_episodes.parquet",
    "source_coverage.parquet",
    "splits.json",
    "feature_catalog.md",
    "feature_catalog.json",
    "snapshot.duckdb",
  ];

  it("writes all required snapshot files", () => {
    for (const file of REQUIRED_FILES) {
      expect(existsSync(resolve(snapshotDir, file)), `${file} should exist`).toBe(true);
    }
  });

  it("board_observations has the required LIVE columns (incl. disagreement + dominance)", async () => {
    const rows = await readParquetRows("board_observations.parquet");
    expect(rows.length).toBeGreaterThan(0);
    const cols = new Set(Object.keys(rows[0] ?? {}));
    for (const c of [
      "game_id",
      "bucket_start",
      "bucket_end",
      "game_elapsed_seconds",
      "intensity",
      "active_market_count",
      "source_count",
      "source_dominance",
      "source_disagreement",
    ]) {
      expect(cols.has(c), `board_observations missing ${c}`).toBe(true);
    }
  });

  it("source_coverage has the required columns and uses the allowed class taxonomy", async () => {
    const rows = await readParquetRows("source_coverage.parquet");
    expect(rows.length).toBeGreaterThan(0);
    const cols = new Set(Object.keys(rows[0] ?? {}));
    for (const c of ["game_id", "source", "market_family", "window", "class"]) {
      expect(cols.has(c), `source_coverage missing ${c}`).toBe(true);
    }
    const allowed = new Set([
      "canonical",
      "snapshot_eligible",
      "partial",
      "artifact_only",
      "missing",
    ]);
    for (const row of rows) expect(allowed.has(String(row["class"]))).toBe(true);
  });

  it("manifest carries all provenance fields", () => {
    const manifest = readJson("manifest.json");
    expect(typeof field(manifest, "snapshotId")).toBe("string");
    expect(typeof field(manifest, "schemaVersion")).toBe("string");
    expect(typeof field(manifest, "generatedAt")).toBe("string");
    expect(typeof field(manifest, "generationCommand")).toBe("string");
    expect(typeof field(manifest, "seed")).toBe("number");
    expect(typeof field(field(manifest, "git"), "commit")).toBe("string");
    expect(typeof field(field(manifest, "db"), "path")).toBe("string");
    expect(typeof field(field(manifest, "db"), "sizeBytes")).toBe("number");
    expect(typeof field(field(manifest, "db"), "mtime")).toBe("string");
    expect(typeof field(field(manifest, "incidentRegistry"), "path")).toBe("string");
    expect(typeof field(field(manifest, "incidentRegistry"), "sha256")).toBe("string");
    const dr = field(manifest, "dateRange");
    expect(isRecord(dr)).toBe(true);
    expect(isRecord(dr) && "since" in dr).toBe(true);
    expect(isRecord(dr) && "until" in dr).toBe(true);
    expect(field(field(manifest, "parquetWriter"), "kind")).toBe("@duckdb/node-api");
    expect(typeof field(field(manifest, "parquetWriter"), "reason")).toBe("string");
    expect(Array.isArray(field(manifest, "eligibleSources"))).toBe(true);
    expect(Array.isArray(field(manifest, "files"))).toBe(true);
  });

  it("splits do NOT leak any incident game into the test side", () => {
    const splits = readJson("splits.json");
    const train = field(splits, "train");
    const test = field(splits, "test");
    expect(Array.isArray(train)).toBe(true);
    expect(Array.isArray(test)).toBe(true);
    const trainArr: readonly unknown[] = Array.isArray(train) ? train : [];
    const testArr: readonly unknown[] = Array.isArray(test) ? test : [];
    const trainSet = new Set(trainArr.map(String));
    for (const g of testArr) expect(trainSet.has(String(g))).toBe(false);
    // both selected incident games (PARITY_GAME, nba-0042500224) must be in train
    expect(trainArr.map(String)).toContain(PARITY_GAME);
    expect(testArr.map(String)).not.toContain(PARITY_GAME);
    expect(typeof field(splits, "seed")).toBe("number");
  });

  it("feature_catalog marks incident/label-derived fields leakage_safe=no and raw board fields=yes", () => {
    const catalog = readJson("feature_catalog.json");
    const entries: readonly unknown[] = Array.isArray(catalog) ? catalog : [];
    const intensity = entries.find((e) => field(e, "name") === "intensity");
    expect(field(intensity, "leakageSafeForOnlineScoring")).toBe(true);
    const eventSec = entries.find((e) => field(e, "name") === "event_sec");
    expect(field(eventSec, "leakageSafeForOnlineScoring")).toBe(false);
    const scoreWin = entries.find((e) => field(e, "file") === "score_windows.parquet");
    expect(field(scoreWin, "leakageSafeForOnlineScoring")).toBe(false);
  });

  it("TRUTH PARITY: nba-0042500222 episodes match the committed 882621b bakeoff output", async () => {
    const rows = await readParquetRows("market_outlier_episodes.parquet");
    const parity = rows
      .filter((r) => r["game_id"] === PARITY_GAME)
      .sort((a, b) => Number(a["start_sec"]) - Number(b["start_sec"]));
    expect(parity.length).toBe(GOLDEN_PARITY_EPISODES.length);
    parity.forEach((row, i) => {
      const gold = GOLDEN_PARITY_EPISODES[i];
      expect(row["start_iso"]).toBe(gold?.startIso);
      expect(row["end_iso"]).toBe(gold?.endIso);
      expect(Number(row["bucket_count"])).toBe(gold?.bucketCount);
      expect(Number(row["peak_severity"])).toBeCloseTo(gold?.peakSeverity ?? -1, 3);
      expect(Number(row["peak_active_markets"])).toBe(gold?.peakActiveMarkets);
      expect(Number(row["peak_sources"])).toBe(gold?.peakSources);
      expect(Number(row["peak_families"])).toBe(gold?.peakFamilies);
      expect(row["diagnosis"]).toBe(gold?.diagnosis);
    });
  });
});
