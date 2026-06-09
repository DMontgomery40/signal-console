// TS-OWNED quant-lab snapshot exporter.
//
// Materializes a reproducible, leakage-aware research snapshot from the
// READ-ONLY gold DB plus the committed incident registry, using the SHARED
// @signal-console/research-truth truth functions so the snapshot's truth equals
// the NBA detector bake-off's truth (commit 882621b).
//
// Two distinct truth paths, intentionally NOT merged:
//   - market_outlier_episodes  -> buildMarketOutlierEpisodes(buildGameData(...))
//       on each game's FULL natural window with UNFILTERED pairs. This is the
//       byte-identical bakeoff path; truth parity for nba-0042500222 depends on
//       NOT filtering or sub-windowing it.
//   - board_observations       -> buildLiveBoardObservationsForGame(...), the
//       LIVE board lane shape (buildBoardVolatilityModelRequest), which INCLUDES
//       sourceDisagreement + sourceDominance and is restricted to the
//       snapshot-eligible source set (kalshi/polymarket/bet365/nba).
//
// Outputs land under outputs/nba-quant-lab/snapshots/<snapshot-id>/. Parquet is
// written via @duckdb/node-api (also emits snapshot.duckdb via COPY TO).
//
// Selection (default = FULL CORPUS):
//   With NO selection flag, the exporter selects ALL board-eligible games
//   (every game with at least one non-heartbeat quote tick from a
//   snapshot-eligible source via source_markets), UNION every incident game
//   that has a local window (so the scoreable-incident truth set never
//   regresses). This is the manifest selection.mode == "full-corpus".
//   Sampling is OPT-IN:
//     --games a,b   explicit game ids                  (mode "explicit-games")
//     --sample N    ALL incident games + N sampled      (mode "incident-plus-sample")
//                   deterministic regular-season games
//   --limit / --since / --until still post-filter whatever was selected.
//
// Run:
//   GOLD_DB_PATH=... pnpm tsx scripts/export-quant-snapshot.ts        # full corpus
//   GOLD_DB_PATH=... pnpm tsx scripts/export-quant-snapshot.ts [--games a,b] \
//     [--limit N] [--sample N] [--since DATE|ISO] [--until DATE|ISO] [--seed N] \
//     [--out DIR] [--snapshot-id ID] [--control-ticks N]

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { DuckDBInstance } from "@duckdb/node-api";

import { GOLD_DB_PATH, openGoldDb } from "../packages/db/src/open";
import {
  buildGameData,
  buildLiveBoardObservationsForGame,
  buildMarketOutlierEpisodes,
  CATCH_WINDOW_AFTER_SECONDS,
  CATCH_WINDOW_BEFORE_SECONDS,
  incidentGameIds,
  loadGameWindows,
  normalizeGameId,
  parseIsoSeconds,
  readIncidents,
  SNAPSHOT_ELIGIBLE_SOURCES,
  type GameData,
  type GameWindow,
  type LiveBoardObservationConfig,
  type MarketOutlierEpisode,
} from "../packages/research-truth/src/index";

const SCHEMA_VERSION = "nba-quant-lab/1.0.0";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SAFE_SNAPSHOT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// Sampling is OPT-IN via `--sample N` (ALL incident games + N deterministically
// sampled regular-season games). The DEFAULT (no flag) is the FULL corpus of
// board-eligible games, not a sample, so there is no implicit default sample
// size to carry here.

// LIVE board-mad runtime defaults (BASELINE detector-defaults). The
// board_observations rows depend only on bucketSeconds/freshCapSeconds/
// weighting/timingContext + the buffers used for the effective tick window.
const LIVE_BOARD_CONFIG: LiveBoardObservationConfig = {
  bucketSeconds: 60,
  freshCapSeconds: 300,
  weighting: "volume",
  pbpPreBufferMs: 5 * 60 * 1000,
  pbpPostBufferMs: 60_000,
};

const INCIDENT_REGISTRY_PATH = resolve(
  REPO_ROOT,
  "outputs",
  "nba-detector-bakeoff",
  "research",
  "incident-registry-expanded.json",
);

interface CliOptions {
  readonly games: readonly string[] | null;
  readonly limit: number | null;
  // null == no `--sample` flag (FULL-CORPUS default). A non-null value is the
  // explicit opt-in to the incident-plus-sample path.
  readonly sample: number | null;
  readonly since: string | null;
  readonly until: string | null;
  readonly seed: number;
  readonly outRoot: string;
  readonly snapshotId: string | null;
  // Max number of NON-truth-bearing (assumed-negative) games to include in
  // player_prop_ticks so the attribution re-ranker's false-alarm rate can be
  // calibrated on a real control universe. 0 = truth-bearing games only
  // (the original tight slice). Sampled deterministically from the selected
  // scope by seed; games lacking rebound prop ticks contribute no rows.
  readonly controlTicks: number;
}

const ISO_CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeSinceArg(value: string | null): string | null {
  if (value === null) return null;
  return ISO_CALENDAR_DATE.test(value) ? `${value}T00:00:00Z` : value;
}

function normalizeUntilArg(value: string | null): string | null {
  if (value === null) return null;
  return ISO_CALENDAR_DATE.test(value) ? `${value}T23:59:59Z` : value;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let games: readonly string[] | null = null;
  let limit: number | null = null;
  // Default null = no sampling flag passed -> FULL CORPUS. Sampling is opt-in.
  let sample: number | null = null;
  let since: string | null = null;
  let until: string | null = null;
  let seed = 42;
  let outRoot = resolve(REPO_ROOT, "outputs", "nba-quant-lab", "snapshots");
  let snapshotId: string | null = null;
  let controlTicks = 0;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`missing value for ${String(arg)}`);
      i += 1;
      return v;
    };
    if (arg === "--games")
      games = next()
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "");
    else if (arg === "--limit") limit = Number.parseInt(next(), 10);
    else if (arg === "--sample") sample = Number.parseInt(next(), 10);
    else if (arg === "--since") since = next();
    else if (arg === "--until") until = next();
    else if (arg === "--seed") seed = Number.parseInt(next(), 10);
    else if (arg === "--out") outRoot = resolve(next());
    else if (arg === "--snapshot-id") snapshotId = next();
    else if (arg === "--control-ticks") controlTicks = Number.parseInt(next(), 10);
  }
  return {
    games,
    limit,
    sample,
    since: normalizeSinceArg(since),
    until: normalizeUntilArg(until),
    seed,
    outRoot,
    snapshotId,
    controlTicks,
  };
}

// Deterministic mulberry32 PRNG so the sampled-game set is reproducible from the
// recorded seed.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function deterministicShuffle<T>(items: readonly T[], rng: () => number): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const a = arr[i];
    const b = arr[j];
    if (a !== undefined && b !== undefined) {
      arr[i] = b;
      arr[j] = a;
    }
  }
  return arr;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function gitCommit(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function withinWindow(window: GameWindow, since: string | null, until: string | null): boolean {
  if (since !== null) {
    const sinceSec = parseIsoSeconds(since);
    if (sinceSec !== null && window.endSec < sinceSec) return false;
  }
  if (until !== null) {
    const untilSec = parseIsoSeconds(until);
    if (untilSec !== null && window.startSec > untilSec) return false;
  }
  return true;
}

// --- DuckDB parquet writer -------------------------------------------------

type ColumnType = "VARCHAR" | "INTEGER" | "BIGINT" | "DOUBLE" | "BOOLEAN";

interface ColumnSpec {
  readonly name: string;
  readonly type: ColumnType;
}

type Row = Record<string, string | number | boolean | null>;

interface DuckTarget {
  readonly instance: DuckDBInstance;
  readonly connection: Awaited<ReturnType<DuckDBInstance["connect"]>>;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function writeParquetTable(
  target: DuckTarget,
  tableName: string,
  columns: readonly ColumnSpec[],
  rows: readonly Row[],
  parquetPath: string,
): Promise<void> {
  const conn = target.connection;
  await conn.run(`DROP TABLE IF EXISTS ${quoteIdent(tableName)}`);
  const colDefs = columns.map((c) => `${quoteIdent(c.name)} ${c.type}`).join(", ");
  await conn.run(`CREATE TABLE ${quoteIdent(tableName)} (${colDefs})`);
  if (rows.length > 0) {
    const appender = await conn.createAppender(tableName);
    for (const row of rows) {
      for (const col of columns) {
        const value = row[col.name] ?? null;
        if (value === null) {
          appender.appendNull();
          continue;
        }
        switch (col.type) {
          case "VARCHAR":
            appender.appendVarchar(String(value));
            break;
          case "INTEGER":
            appender.appendInteger(Math.trunc(Number(value)));
            break;
          case "BIGINT":
            appender.appendBigInt(BigInt(Math.trunc(Number(value))));
            break;
          case "DOUBLE":
            appender.appendDouble(Number(value));
            break;
          case "BOOLEAN":
            appender.appendBoolean(Boolean(value));
            break;
        }
      }
      appender.endRow();
    }
    appender.flushSync();
    appender.closeSync();
  }
  await conn.run(
    `COPY ${quoteIdent(tableName)} TO '${parquetPath.replace(/'/g, "''")}' (FORMAT PARQUET)`,
  );
}

// --- main ------------------------------------------------------------------

async function run(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const dbPath = process.env.GOLD_DB_PATH ?? process.env.SIGNAL_CONSOLE_DB_PATH ?? GOLD_DB_PATH;
  const generatedAt = new Date().toISOString();
  const snapshotId = opts.snapshotId ?? generatedAt.replace(/[:.]/g, "-");
  if (!SAFE_SNAPSHOT_ID.test(snapshotId)) {
    throw new Error(
      `invalid --snapshot-id ${JSON.stringify(
        snapshotId,
      )}: use letters, numbers, underscores, or hyphens only`,
    );
  }
  const snapshotDir = resolve(opts.outRoot, snapshotId);
  mkdirSync(snapshotDir, { recursive: true });

  const dbStat = statSync(dbPath);
  const incidents = readIncidents(INCIDENT_REGISTRY_PATH);
  const incidentRegistryHash = sha256File(INCIDENT_REGISTRY_PATH);

  const db = openGoldDb(dbPath);
  try {
    // 1. Load all game windows once (full natural windows; loadGameWindows
    //    applies the standard pre/post buffers — NEVER sub-windowed here).
    const allWindows = loadGameWindows(db);
    const windowById = new Map(allWindows.map((w) => [w.gameId, w]));

    // 2. Resolve incident game ids (normalized) that have a local window.
    const incidentGameIdSet = new Set<string>();
    for (const incident of incidents) {
      for (const gid of incidentGameIds(incident)) {
        if (windowById.has(gid)) incidentGameIdSet.add(gid);
      }
    }

    // 3. Select which games to export. Precedence:
    //      --games            -> explicit ids only        (mode "explicit-games")
    //      --sample N (opt-in) -> ALL incident games + N   (mode "incident-plus-sample")
    //                            deterministic regular games
    //      DEFAULT (no flag)  -> FULL CORPUS: every board-eligible game UNION
    //                            every incident game with a window
    //                            (mode "full-corpus")
    //    Then apply --since/--until (game selection only) and --limit.
    let selectedIds: string[];
    if (opts.games !== null) {
      selectedIds = opts.games.map(normalizeGameId).filter((id) => windowById.has(id));
    } else if (opts.sample !== null) {
      const incidentIds = [...incidentGameIdSet].sort();
      const regularPool = allWindows
        .map((w) => w.gameId)
        .filter((id) => !incidentGameIdSet.has(id))
        .filter((id) => {
          const w = windowById.get(id);
          return w !== undefined && withinWindow(w, opts.since, opts.until);
        })
        .sort();
      const rng = mulberry32(opts.seed);
      const sampled = deterministicShuffle(regularPool, rng).slice(0, Math.max(0, opts.sample));
      selectedIds = [...incidentIds, ...sampled.sort()];
    } else {
      // FULL CORPUS: every board-eligible game (has >=1 non-heartbeat eligible
      // quote tick via source_markets) that also has a local PBP window, UNION
      // every incident game with a window so the scoreable-incident truth set
      // never regresses if an incident game lacks eligible board coverage.
      const eligibleLimit = opts.since === null && opts.until === null ? opts.limit : null;
      const eligibleIds = loadBoardEligibleGameIds(db, eligibleLimit).filter((id) =>
        windowById.has(id),
      );
      selectedIds = [...new Set([...eligibleIds, ...incidentGameIdSet])];
    }
    if (opts.since !== null || opts.until !== null) {
      selectedIds = selectedIds.filter((id) => {
        const w = windowById.get(id);
        return w !== undefined && withinWindow(w, opts.since, opts.until);
      });
    }
    if (opts.limit !== null) selectedIds = selectedIds.slice(0, opts.limit);
    selectedIds = [...new Set(selectedIds)].sort();

    // 4. Build GameData (full window, unfiltered pairs) for each selected game.
    const games = new Map<string, GameData>();
    for (const id of selectedIds) {
      const w = windowById.get(id);
      if (w !== undefined) games.set(id, buildGameData(db, w));
    }

    // 5. games.parquet
    const gameRows: Row[] = selectedIds.flatMap((id): Row[] => {
      const w = windowById.get(id);
      const g = games.get(id);
      if (w === undefined || g === undefined) return [];
      return [
        {
          game_id: id,
          scheduled_start: w.scheduledStart,
          home_key: w.homeKey,
          away_key: w.awayKey,
          window_start_iso: w.startIso,
          window_end_iso: w.endIso,
          window_start_sec: w.startSec,
          window_end_sec: w.endSec,
          pbp_point_count: w.points.length,
          quote_pair_count: g.pairs.length,
          micro_event_count: g.micro.length,
          is_incident_game: incidentGameIdSet.has(id),
        },
      ];
    });

    // 6. board_observations.parquet (LIVE shape, eligible sources only).
    const boardRows: Row[] = [];
    const boardDiag = new Map<
      string,
      { tickCount: number; eligibleTickCount: number; clockSource: string }
    >();
    for (const id of selectedIds) {
      const result = buildLiveBoardObservationsForGame(db, id, LIVE_BOARD_CONFIG);
      boardDiag.set(id, {
        tickCount: result.tickCount,
        eligibleTickCount: result.eligibleTickCount,
        clockSource: result.clockSource,
      });
      for (const obs of result.request?.observations ?? []) {
        boardRows.push({
          game_id: id,
          bucket_start: obs.bucketStart,
          bucket_end: obs.bucketEnd,
          game_elapsed_seconds: obs.gameElapsedSeconds ?? null,
          intensity: obs.intensity,
          active_market_count: obs.activeMarketCount ?? 0,
          source_count: obs.sourceCount ?? 0,
          source_dominance: obs.sourceDominance ?? null,
          source_disagreement: obs.sourceDisagreement ?? null,
        });
      }
    }

    // 7. market_outlier_episodes.parquet (BAKEOFF path; truth parity target).
    const episodesByGame = new Map<string, readonly MarketOutlierEpisode[]>();
    const episodeRows: Row[] = [];
    let episodeSeq = 0;
    for (const id of selectedIds) {
      const g = games.get(id);
      if (g === undefined) continue;
      const episodes = buildMarketOutlierEpisodes(g);
      episodesByGame.set(id, episodes);
      for (const ep of episodes) {
        episodeRows.push({
          episode_id: `${id}:moe:${String(episodeSeq)}`,
          game_id: ep.gameId,
          scheduled_start: ep.scheduledStart,
          matchup: ep.matchup,
          start_sec: ep.startSec,
          end_sec: ep.endSec,
          start_iso: ep.startIso,
          end_iso: ep.endIso,
          bucket_seconds: ep.bucketSeconds,
          bucket_count: ep.bucketCount,
          peak_severity: ep.peakSeverity,
          mean_severity: ep.meanSeverity,
          peak_price_move_z: ep.peakPriceMoveZ,
          peak_breadth_z: ep.peakBreadthZ,
          peak_offprice_z: ep.peakOffpriceZ,
          peak_active_markets: ep.peakActiveMarkets,
          peak_sources: ep.peakSources,
          peak_families: ep.peakFamilies,
          diagnosis: ep.diagnosis,
        });
        episodeSeq += 1;
      }
    }

    // 8. incidents.parquet (keyed on incidents, NOT coverage). Registry ids with
    //    no local window still get a row.
    const incidentRows: Row[] = incidents.map((incident): Row => {
      const gids = incidentGameIds(incident);
      const canonical = gids.find((g) => windowById.has(g)) ?? gids[0] ?? null;
      const eventSec = parseIsoSeconds(incident.utcTime);
      return {
        incident_id: incident.id,
        canonical_game_id: canonical,
        has_local_window: gids.some((g) => windowById.has(g)),
        scoreable: eventSec !== null && gids.some((g) => windowById.has(g)),
        confidence: incident.confidence,
        anchor_type: incident.anchorType,
        utc_time: incident.utcTime === "" ? null : incident.utcTime,
        event_sec: eventSec,
        stat: incident.stat,
        credited_player: incident.creditedPlayer,
        rightful_player: incident.rightfulPlayer === "" ? null : incident.rightfulPlayer,
        official_correction: incident.officialCorrection,
      };
    });

    // 9. score_windows.parquet (materialized incident catch windows).
    const scoreWindowRows: Row[] = incidents.flatMap((incident): Row[] => {
      const eventSec = parseIsoSeconds(incident.utcTime);
      if (eventSec === null) return [];
      const gids = incidentGameIds(incident).filter((g) => windowById.has(g));
      return gids.map(
        (gid): Row => ({
          incident_id: incident.id,
          game_id: gid,
          window_start: new Date((eventSec + CATCH_WINDOW_BEFORE_SECONDS) * 1000).toISOString(),
          window_end: new Date((eventSec + CATCH_WINDOW_AFTER_SECONDS) * 1000).toISOString(),
          window_start_sec: eventSec + CATCH_WINDOW_BEFORE_SECONDS,
          window_end_sec: eventSec + CATCH_WINDOW_AFTER_SECONDS,
        }),
      );
    });

    // 10. source_coverage.parquet — per game x source x market_family x window
    //     with a coverage class. The "window" granularity here is the game's
    //     full natural window (one row per game/source/family). Class taxonomy:
    //       canonical          - eligible source, has live quote ticks in window
    //       snapshot_eligible   - eligible source, source_markets present but no
    //                             ticks landed in window (eligible, not active)
    //       partial             - eligible source/family present but only as a
    //                             single mapped market with no usable quotes
    //       artifact_only       - present only in source_markets with
    //                             mapping_status != 'mapped' (no real coverage)
    //       missing             - eligible source ENTIRELY absent for this game
    //                             (one row per absent eligible source; makes absence
    //                             explicit rather than invisible)
    const coverageRows = buildSourceCoverageRows(db, selectedIds);

    // 11. player_prop_ticks.parquet — per-player rebound-prop microstructure for
    //     the attribution re-ranker. Scoped to truth-bearing games (incident +
    //     tape-episode games) so the re-ranker can window per candidate event
    //     without reading the gold DB. Raw causal ticks.
    const truthBearingIds = selectedIds.filter(
      (id) => incidentGameIdSet.has(id) || (episodesByGame.get(id)?.length ?? 0) > 0,
    );
    // FAR-on-control: also include a deterministic sample of NON-truth-bearing
    // (assumed-negative) games so the re-ranker's false-alarm rate can be
    // calibrated against a real control universe instead of only the incident
    // slice. Capped by --control-ticks (0 = truth-bearing only). Sampled by a
    // seed-offset PRNG; games without rebound prop ticks yield no rows.
    const controlPoolIds =
      opts.controlTicks > 0
        ? selectedIds.filter(
            (id) => !incidentGameIdSet.has(id) && (episodesByGame.get(id)?.length ?? 0) === 0,
          )
        : [];
    const controlSampleIds = deterministicShuffle(controlPoolIds, mulberry32(opts.seed + 7)).slice(
      0,
      opts.controlTicks,
    );
    const playerPropTickGameIds = [...truthBearingIds, ...controlSampleIds];
    const playerPropTickRows = buildPlayerPropTickRows(db, playerPropTickGameIds);
    const controlTickGameCount = new Set(
      playerPropTickRows
        .map((r) => r["game_id"])
        .filter((id): id is string => typeof id === "string" && !truthBearingIds.includes(id)),
    ).size;

    // --- write parquet via duckdb ----------------------------------------
    const instance = await DuckDBInstance.create(resolve(snapshotDir, "snapshot.duckdb"));
    const connection = await instance.connect();
    const target: DuckTarget = { instance, connection };

    await writeParquetTable(
      target,
      "games",
      GAMES_COLUMNS,
      gameRows,
      resolve(snapshotDir, "games.parquet"),
    );
    await writeParquetTable(
      target,
      "board_observations",
      BOARD_OBS_COLUMNS,
      boardRows,
      resolve(snapshotDir, "board_observations.parquet"),
    );
    await writeParquetTable(
      target,
      "incidents",
      INCIDENTS_COLUMNS,
      incidentRows,
      resolve(snapshotDir, "incidents.parquet"),
    );
    await writeParquetTable(
      target,
      "score_windows",
      SCORE_WINDOWS_COLUMNS,
      scoreWindowRows,
      resolve(snapshotDir, "score_windows.parquet"),
    );
    await writeParquetTable(
      target,
      "market_outlier_episodes",
      MARKET_OUTLIER_COLUMNS,
      episodeRows,
      resolve(snapshotDir, "market_outlier_episodes.parquet"),
    );
    await writeParquetTable(
      target,
      "source_coverage",
      SOURCE_COVERAGE_COLUMNS,
      coverageRows,
      resolve(snapshotDir, "source_coverage.parquet"),
    );
    await writeParquetTable(
      target,
      "player_prop_ticks",
      PLAYER_PROP_TICKS_COLUMNS,
      playerPropTickRows,
      resolve(snapshotDir, "player_prop_ticks.parquet"),
    );
    connection.disconnectSync();
    instance.closeSync();

    // --- splits.json (no incident-game split leak) -----------------------
    const splitRng = mulberry32(opts.seed + 1);
    const nonIncidentSelected = selectedIds.filter((id) => !incidentGameIdSet.has(id));
    const incidentSelected = selectedIds.filter((id) => incidentGameIdSet.has(id));
    const shuffledNonIncident = deterministicShuffle(nonIncidentSelected, splitRng);
    const testCount = Math.floor(shuffledNonIncident.length * 0.3);
    const testGames = shuffledNonIncident.slice(0, testCount).sort();
    // ALL incident games go to TRAIN so incident-window/label-derived features
    // can never leak into the held-out test set.
    const trainGames = [...incidentSelected, ...shuffledNonIncident.slice(testCount)].sort();
    const splits = {
      seed: opts.seed,
      strategy:
        "game-level holdout; ALL incident games forced into train so incident " +
        "windows/labels cannot leak into test; 30% of non-incident games sampled into test",
      incidentGamesSide: "train",
      train: trainGames,
      test: testGames,
    };
    writeFileSync(resolve(snapshotDir, "splits.json"), `${JSON.stringify(splits, null, 2)}\n`);

    // --- feature catalog -------------------------------------------------
    writeFileSync(
      resolve(snapshotDir, "feature_catalog.json"),
      `${JSON.stringify(FEATURE_CATALOG, null, 2)}\n`,
    );
    writeFileSync(resolve(snapshotDir, "feature_catalog.md"), buildFeatureCatalogMarkdown());

    // --- manifest --------------------------------------------------------
    const sourceCoverageSummary = summarizeCoverage(coverageRows);
    const manifest = {
      snapshotId,
      schemaVersion: SCHEMA_VERSION,
      generatedAt,
      generationCommand:
        `tsx scripts/export-quant-snapshot.ts ${process.argv.slice(2).join(" ")}`.trim(),
      seed: opts.seed,
      git: { commit: gitCommit() },
      db: {
        path: dbPath,
        sizeBytes: dbStat.size,
        mtime: dbStat.mtime.toISOString(),
      },
      incidentRegistry: {
        path: INCIDENT_REGISTRY_PATH,
        sha256: incidentRegistryHash,
        incidentCount: incidents.length,
      },
      dateRange: {
        since: opts.since,
        until: opts.until,
        observedStart: selectedIds.length === 0 ? null : minIso(selectedIds, windowById),
        observedEnd: selectedIds.length === 0 ? null : maxIso(selectedIds, windowById),
      },
      parquetWriter: {
        kind: "@duckdb/node-api",
        reason:
          "Native @duckdb/node-api installed and smoke-verified (parquet write+readback) " +
          "in the worktree; preferred per task ordering and additionally yields snapshot.duckdb " +
          "via COPY TO. parquetjs/JSONL+pyarrow were the fallbacks but were not needed.",
        snapshotDuckdb: "snapshot.duckdb",
      },
      selection: {
        mode:
          opts.games !== null
            ? "explicit-games"
            : opts.sample !== null
              ? "incident-plus-sample"
              : "full-corpus",
        sampleRequested: opts.sample,
        limit: opts.limit,
        gameCount: selectedIds.length,
        incidentGameCount: incidentSelected.length,
        regularGameCount: nonIncidentSelected.length,
        games: selectedIds,
      },
      // Scope of player_prop_ticks: truth-bearing games always included; a
      // capped deterministic control sample is added when --control-ticks > 0
      // so the re-ranker's false-alarm rate is calibrated on assumed-negatives.
      playerPropTickScope: {
        controlTicksRequested: opts.controlTicks,
        truthBearingGameCount: truthBearingIds.length,
        controlGameCount: controlTickGameCount,
      },
      liveBoardConfig: LIVE_BOARD_CONFIG,
      eligibleSources: [...SNAPSHOT_ELIGIBLE_SOURCES].sort(),
      counts: {
        games: gameRows.length,
        boardObservations: boardRows.length,
        incidents: incidentRows.length,
        scoreWindows: scoreWindowRows.length,
        marketOutlierEpisodes: episodeRows.length,
        sourceCoverage: coverageRows.length,
        playerPropTicks: playerPropTickRows.length,
      },
      boardObservationDiagnostics: Object.fromEntries(boardDiag),
      sourceCoverageSummary,
      files: [
        "manifest.json",
        "games.parquet",
        "board_observations.parquet",
        "incidents.parquet",
        "score_windows.parquet",
        "market_outlier_episodes.parquet",
        "source_coverage.parquet",
        "player_prop_ticks.parquet",
        "splits.json",
        "feature_catalog.md",
        "feature_catalog.json",
        "snapshot.duckdb",
      ],
    };
    writeFileSync(resolve(snapshotDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    process.stdout.write(
      `${JSON.stringify(
        {
          snapshotDir,
          gameCount: selectedIds.length,
          boardObservations: boardRows.length,
          marketOutlierEpisodes: episodeRows.length,
          incidents: incidentRows.length,
          parityGameEpisodes: (episodesByGame.get("nba-0042500222") ?? []).length,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  } finally {
    db.close();
  }
}

// --- board-eligible selection ----------------------------------------------

// Full-corpus selection policy (exporter-local, NOT a shared research-truth
// contract): a game is "board-eligible" iff it has at least one non-heartbeat
// quote tick with a numeric implied probability from a snapshot-eligible source
// (kalshi/polymarket/bet365 -- "nba" is the PBP feed and never contributes
// ticks) joined through source_markets. This is the cheap id-level query used
// for selection; it deliberately does NOT build the heavy per-game board
// observations just to decide membership.
function loadBoardEligibleGameIds(
  db: ReturnType<typeof openGoldDb>,
  limit: number | null = null,
): string[] {
  const eligibleSources = [...SNAPSHOT_ELIGIBLE_SOURCES];
  const placeholders = eligibleSources.map(() => "?").join(", ");
  const boundedLimit = limit === null ? null : Math.max(0, limit);
  const limitClause = boundedLimit === null ? "" : " LIMIT ?";
  const rows: readonly unknown[] = db
    .prepare(
      `SELECT sm.game_id AS gameId
       FROM source_markets sm
       WHERE sm.source IN (${placeholders})
         AND EXISTS (
           SELECT 1
           FROM quote_ticks qt
           WHERE qt.source_market_id = sm.id
             AND qt.is_heartbeat = 0
             AND qt.implied_probability IS NOT NULL
         )
       GROUP BY sm.game_id
       ORDER BY sm.game_id${limitClause}`,
    )
    .all(...eligibleSources, ...(boundedLimit === null ? [] : [boundedLimit]));
  const out: string[] = [];
  for (const rec of rows) {
    if (!isRecord(rec)) continue;
    const gameId = typeof rec["gameId"] === "string" ? rec["gameId"] : null;
    if (gameId !== null && gameId !== "") out.push(normalizeGameId(gameId));
  }
  return out;
}

// --- source coverage --------------------------------------------------------

interface SourceMarketRow {
  readonly source: string;
  readonly rawFamily: string;
  readonly mappingStatus: string;
  readonly marketCount: number;
  readonly tickCount: number;
}

function normalizeMarketFamily(rawFamily: string): string {
  const lower = rawFamily.trim().toLowerCase();
  if (lower === "") return "unknown";
  if (/(^|[^a-z])(ml|moneyline)([^a-z]|$)/.test(lower) || lower.includes("moneyline")) {
    return "moneyline";
  }
  if (lower.includes("spread")) return "spreads";
  if (lower.includes("total")) return "totals";
  if (lower.includes("point")) return "player_points";
  if (lower.includes("rebound")) return "player_rebounds";
  if (lower.includes("assist")) return "player_assists";
  if (
    lower.includes("steal") ||
    lower.includes("block") ||
    lower.includes("triple") ||
    lower.includes("double")
  ) {
    return "player_other";
  }
  return "other";
}

function buildSourceCoverageRows(
  db: ReturnType<typeof openGoldDb>,
  gameIds: readonly string[],
): Row[] {
  const stmt = db.prepare(
    `SELECT sm.source AS source,
            COALESCE(sm.raw_family, '') AS raw_family,
            COALESCE(sm.mapping_status, '') AS mapping_status,
            COUNT(DISTINCT sm.id) AS market_count,
            COUNT(qt.id) AS tick_count
     FROM source_markets sm
     LEFT JOIN quote_ticks qt ON qt.source_market_id = sm.id AND qt.is_heartbeat = 0
     WHERE sm.game_id = ?
     GROUP BY sm.source, sm.raw_family, sm.mapping_status`,
  );
  const rows: Row[] = [];
  for (const gameId of gameIds) {
    const raw: readonly unknown[] = stmt.all(gameId);
    // Aggregate per source x market_family (raw_family normalized).
    const byKey = new Map<string, SourceMarketRow>();
    for (const rec of raw) {
      if (!isRecord(rec)) continue;
      const source = typeof rec["source"] === "string" ? rec["source"] : "";
      const rawFamily = typeof rec["raw_family"] === "string" ? rec["raw_family"] : "";
      const mappingStatus = typeof rec["mapping_status"] === "string" ? rec["mapping_status"] : "";
      const marketCount = typeof rec["market_count"] === "number" ? rec["market_count"] : 0;
      const tickCount = typeof rec["tick_count"] === "number" ? rec["tick_count"] : 0;
      const family = normalizeMarketFamily(rawFamily);
      const key = `${source}|${family}`;
      const prev = byKey.get(key);
      byKey.set(key, {
        source,
        rawFamily: family,
        mappingStatus: prev === undefined ? mappingStatus : prev.mappingStatus,
        marketCount: (prev?.marketCount ?? 0) + marketCount,
        tickCount: (prev?.tickCount ?? 0) + tickCount,
      });
    }
    const presentSources = new Set<string>();
    for (const entry of byKey.values()) {
      presentSources.add(entry.source);
      const eligible = SNAPSHOT_ELIGIBLE_SOURCES.has(entry.source);
      const klass = classifyCoverage(eligible, entry);
      rows.push({
        game_id: gameId,
        source: entry.source,
        market_family: entry.rawFamily,
        window: "full-game",
        class: klass,
        market_count: entry.marketCount,
        tick_count: entry.tickCount,
        eligible,
      });
    }
    // Record eligible sources ENTIRELY absent for this game as explicit `missing`
    // rows. Without this the promised `missing` class never appears — the query
    // groups only source_markets rows that EXIST, so classifyCoverage's missing
    // branch is unreachable and absence is invisible rather than recorded. Driven
    // by the SNAPSHOT_ELIGIBLE_SOURCES config set (not a hardcoded source list).
    for (const source of SNAPSHOT_ELIGIBLE_SOURCES) {
      if (presentSources.has(source)) continue;
      rows.push({
        game_id: gameId,
        source,
        market_family: "",
        window: "full-game",
        class: "missing",
        market_count: 0,
        tick_count: 0,
        eligible: true,
      });
    }
  }
  return rows;
}

function classifyCoverage(eligible: boolean, entry: SourceMarketRow): string {
  if (!eligible) return "artifact_only";
  if (entry.tickCount > 0) return entry.marketCount === 1 ? "partial" : "canonical";
  if (entry.marketCount > 0) return "snapshot_eligible";
  return "missing";
}

function summarizeCoverage(rows: readonly Row[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const klass = String(row["class"]);
    out[klass] = (out[klass] ?? 0) + 1;
  }
  return out;
}

// --- player prop ticks (re-ranker input) ------------------------------------

// Raw per-player rebound-prop ticks for the attribution re-ranker's signed-paired
// legs. Scoped by the caller to truth-bearing games to bound size. Causal (raw
// ticks, no future info); the re-ranker windows them around candidate events and
// never reads the gold DB directly.
function buildPlayerPropTickRows(
  db: ReturnType<typeof openGoldDb>,
  gameIds: readonly string[],
): Row[] {
  const stmt = db.prepare(
    `SELECT mi.participant_key AS player_key,
            sm.source AS source,
            mi.line AS line,
            qt.captured_at AS captured_at,
            qt.implied_probability AS implied_probability,
            qt.volume AS volume
     FROM source_markets sm
     JOIN market_instruments mi ON sm.instrument_id = mi.id
     JOIN quote_ticks qt ON qt.source_market_id = sm.id AND qt.is_heartbeat = 0
     WHERE sm.game_id = ?
       AND mi.family = 'player-prop'
       AND lower(mi.display_label) LIKE '%rebound%'
       AND qt.implied_probability IS NOT NULL
     ORDER BY mi.participant_key, sm.source, mi.line, qt.captured_at`,
  );
  const rows: Row[] = [];
  for (const gameId of gameIds) {
    for (const rec of stmt.all(gameId)) {
      if (!isRecord(rec)) continue;
      const playerKey = typeof rec["player_key"] === "string" ? rec["player_key"] : null;
      const source = typeof rec["source"] === "string" ? rec["source"] : null;
      const capturedAt = typeof rec["captured_at"] === "string" ? rec["captured_at"] : null;
      const impliedProbability =
        typeof rec["implied_probability"] === "number" ? rec["implied_probability"] : null;
      if (
        playerKey === null ||
        source === null ||
        capturedAt === null ||
        impliedProbability === null
      ) {
        continue;
      }
      rows.push({
        game_id: gameId,
        player_key: playerKey,
        source,
        // line distinguishes the over/under threshold (e.g. 5.5 vs 9.5) so the
        // re-ranker can select ONE coherent series per player/source instead of
        // blending levels; null for line-less props.
        line: typeof rec["line"] === "number" ? rec["line"] : null,
        stat: "rebounds",
        captured_at: capturedAt,
        implied_probability: impliedProbability,
        volume: typeof rec["volume"] === "number" ? rec["volume"] : null,
      });
    }
  }
  return rows;
}

function minIso(ids: readonly string[], byId: Map<string, GameWindow>): string | null {
  let best: string | null = null;
  for (const id of ids) {
    const w = byId.get(id);
    if (w === undefined) continue;
    if (best === null || w.scheduledStart < best) best = w.scheduledStart;
  }
  return best;
}

function maxIso(ids: readonly string[], byId: Map<string, GameWindow>): string | null {
  let best: string | null = null;
  for (const id of ids) {
    const w = byId.get(id);
    if (w === undefined) continue;
    if (best === null || w.scheduledStart > best) best = w.scheduledStart;
  }
  return best;
}

// --- parquet column specs ---------------------------------------------------

const GAMES_COLUMNS: readonly ColumnSpec[] = [
  { name: "game_id", type: "VARCHAR" },
  { name: "scheduled_start", type: "VARCHAR" },
  { name: "home_key", type: "VARCHAR" },
  { name: "away_key", type: "VARCHAR" },
  { name: "window_start_iso", type: "VARCHAR" },
  { name: "window_end_iso", type: "VARCHAR" },
  { name: "window_start_sec", type: "BIGINT" },
  { name: "window_end_sec", type: "BIGINT" },
  { name: "pbp_point_count", type: "INTEGER" },
  { name: "quote_pair_count", type: "INTEGER" },
  { name: "micro_event_count", type: "INTEGER" },
  { name: "is_incident_game", type: "BOOLEAN" },
];

const BOARD_OBS_COLUMNS: readonly ColumnSpec[] = [
  { name: "game_id", type: "VARCHAR" },
  { name: "bucket_start", type: "VARCHAR" },
  { name: "bucket_end", type: "VARCHAR" },
  { name: "game_elapsed_seconds", type: "DOUBLE" },
  { name: "intensity", type: "DOUBLE" },
  { name: "active_market_count", type: "INTEGER" },
  { name: "source_count", type: "INTEGER" },
  { name: "source_dominance", type: "DOUBLE" },
  { name: "source_disagreement", type: "DOUBLE" },
];

const INCIDENTS_COLUMNS: readonly ColumnSpec[] = [
  { name: "incident_id", type: "VARCHAR" },
  { name: "canonical_game_id", type: "VARCHAR" },
  { name: "has_local_window", type: "BOOLEAN" },
  { name: "scoreable", type: "BOOLEAN" },
  { name: "confidence", type: "VARCHAR" },
  { name: "anchor_type", type: "VARCHAR" },
  { name: "utc_time", type: "VARCHAR" },
  { name: "event_sec", type: "BIGINT" },
  { name: "stat", type: "VARCHAR" },
  { name: "credited_player", type: "VARCHAR" },
  { name: "rightful_player", type: "VARCHAR" },
  { name: "official_correction", type: "BOOLEAN" },
];

const SCORE_WINDOWS_COLUMNS: readonly ColumnSpec[] = [
  { name: "incident_id", type: "VARCHAR" },
  { name: "game_id", type: "VARCHAR" },
  { name: "window_start", type: "VARCHAR" },
  { name: "window_end", type: "VARCHAR" },
  { name: "window_start_sec", type: "BIGINT" },
  { name: "window_end_sec", type: "BIGINT" },
];

const MARKET_OUTLIER_COLUMNS: readonly ColumnSpec[] = [
  { name: "episode_id", type: "VARCHAR" },
  { name: "game_id", type: "VARCHAR" },
  { name: "scheduled_start", type: "VARCHAR" },
  { name: "matchup", type: "VARCHAR" },
  { name: "start_sec", type: "BIGINT" },
  { name: "end_sec", type: "BIGINT" },
  { name: "start_iso", type: "VARCHAR" },
  { name: "end_iso", type: "VARCHAR" },
  { name: "bucket_seconds", type: "INTEGER" },
  { name: "bucket_count", type: "INTEGER" },
  { name: "peak_severity", type: "DOUBLE" },
  { name: "mean_severity", type: "DOUBLE" },
  { name: "peak_price_move_z", type: "DOUBLE" },
  { name: "peak_breadth_z", type: "DOUBLE" },
  { name: "peak_offprice_z", type: "DOUBLE" },
  { name: "peak_active_markets", type: "INTEGER" },
  { name: "peak_sources", type: "INTEGER" },
  { name: "peak_families", type: "INTEGER" },
  { name: "diagnosis", type: "VARCHAR" },
];

const SOURCE_COVERAGE_COLUMNS: readonly ColumnSpec[] = [
  { name: "game_id", type: "VARCHAR" },
  { name: "source", type: "VARCHAR" },
  { name: "market_family", type: "VARCHAR" },
  { name: "window", type: "VARCHAR" },
  { name: "class", type: "VARCHAR" },
  { name: "market_count", type: "INTEGER" },
  { name: "tick_count", type: "BIGINT" },
  { name: "eligible", type: "BOOLEAN" },
];

// Per-player rebound-prop microstructure — the attribution re-ranker's input.
// Raw causal ticks (no whole-game stats), so it is leakage-safe for online
// scoring; the re-ranker windows these per candidate event.
const PLAYER_PROP_TICKS_COLUMNS: readonly ColumnSpec[] = [
  { name: "game_id", type: "VARCHAR" },
  { name: "player_key", type: "VARCHAR" },
  { name: "source", type: "VARCHAR" },
  { name: "line", type: "DOUBLE" },
  { name: "stat", type: "VARCHAR" },
  { name: "captured_at", type: "VARCHAR" },
  { name: "implied_probability", type: "DOUBLE" },
  { name: "volume", type: "DOUBLE" },
];

// --- feature catalog --------------------------------------------------------

interface FeatureCatalogEntry {
  readonly file: string;
  readonly name: string;
  readonly meaning: string;
  readonly units: string;
  readonly causalOrNoncausal: "causal" | "noncausal";
  readonly leakageSafeForOnlineScoring: boolean;
  readonly derivedFromSourceTables: readonly string[];
}

const FEATURE_CATALOG: readonly FeatureCatalogEntry[] = [
  // board_observations — raw board features, leakage-safe for online scoring.
  {
    file: "board_observations.parquet",
    name: "intensity",
    meaning:
      "Volume-weighted sum of |Δ implied probability| across markets within the bucket (live board lane intensity)",
    units: "weighted probability delta",
    causalOrNoncausal: "causal",
    leakageSafeForOnlineScoring: true,
    derivedFromSourceTables: ["quote_ticks", "source_markets"],
  },
  {
    file: "board_observations.parquet",
    name: "active_market_count",
    meaning: "Distinct source_market_ids contributing a delta in the bucket",
    units: "count",
    causalOrNoncausal: "causal",
    leakageSafeForOnlineScoring: true,
    derivedFromSourceTables: ["quote_ticks", "source_markets"],
  },
  {
    file: "board_observations.parquet",
    name: "source_count",
    meaning: "Distinct sources (book/exchange) contributing in the bucket",
    units: "count",
    causalOrNoncausal: "causal",
    leakageSafeForOnlineScoring: true,
    derivedFromSourceTables: ["quote_ticks", "source_markets"],
  },
  {
    file: "board_observations.parquet",
    name: "source_dominance",
    meaning: "Share of bucket intensity from the single most active source",
    units: "ratio 0..1",
    causalOrNoncausal: "causal",
    leakageSafeForOnlineScoring: true,
    derivedFromSourceTables: ["quote_ticks", "source_markets"],
  },
  {
    file: "board_observations.parquet",
    name: "source_disagreement",
    meaning:
      "1 - |net signed contribution| / total |signed contribution| across sources; high when sources move in opposite directions",
    units: "ratio 0..1",
    causalOrNoncausal: "causal",
    leakageSafeForOnlineScoring: true,
    derivedFromSourceTables: ["quote_ticks", "source_markets"],
  },
  {
    file: "board_observations.parquet",
    name: "game_elapsed_seconds",
    meaning: "NBA game-clock seconds elapsed at bucket, from PBP period/clock",
    units: "seconds",
    causalOrNoncausal: "causal",
    leakageSafeForOnlineScoring: true,
    derivedFromSourceTables: ["nba_play_by_play_actions"],
  },
  // incidents / score_windows / episodes — label/window-derived, NOT leakage-safe.
  {
    file: "incidents.parquet",
    name: "scoreable",
    meaning: "Whether the incident has an exact anchor + local window (label-side)",
    units: "boolean",
    causalOrNoncausal: "noncausal",
    leakageSafeForOnlineScoring: false,
    derivedFromSourceTables: ["incident-registry-expanded.json", "nba_play_by_play_actions"],
  },
  {
    file: "incidents.parquet",
    name: "event_sec",
    meaning: "Truth event timestamp of the misattribution incident (label anchor)",
    units: "unix seconds",
    causalOrNoncausal: "noncausal",
    leakageSafeForOnlineScoring: false,
    derivedFromSourceTables: ["incident-registry-expanded.json"],
  },
  {
    file: "score_windows.parquet",
    name: "window_start_sec",
    meaning: "Incident catch-window start (event + CATCH_WINDOW_BEFORE); label-derived",
    units: "unix seconds",
    causalOrNoncausal: "noncausal",
    leakageSafeForOnlineScoring: false,
    derivedFromSourceTables: ["incident-registry-expanded.json"],
  },
  {
    file: "score_windows.parquet",
    name: "window_end_sec",
    meaning: "Incident catch-window end (event + CATCH_WINDOW_AFTER); label-derived",
    units: "unix seconds",
    causalOrNoncausal: "noncausal",
    leakageSafeForOnlineScoring: false,
    derivedFromSourceTables: ["incident-registry-expanded.json"],
  },
  {
    file: "market_outlier_episodes.parquet",
    name: "peak_severity",
    meaning:
      "Peak tape-outlier severity across episode buckets (robust-z composite over the whole game series)",
    units: "z-score composite",
    causalOrNoncausal: "noncausal",
    leakageSafeForOnlineScoring: false,
    derivedFromSourceTables: ["quote_ticks", "source_markets", "market_microstructure_events"],
  },
  {
    file: "market_outlier_episodes.parquet",
    name: "peak_price_move_z",
    meaning:
      "Peak robust-z of coverage-normalized price-move intensity; uses whole-game robust stats so it is non-causal",
    units: "z-score",
    causalOrNoncausal: "noncausal",
    leakageSafeForOnlineScoring: false,
    derivedFromSourceTables: ["quote_ticks", "source_markets"],
  },
  {
    file: "source_coverage.parquet",
    name: "class",
    meaning:
      "Coverage class for game x source x market_family x window (canonical|snapshot_eligible|partial|artifact_only|missing)",
    units: "categorical",
    causalOrNoncausal: "noncausal",
    leakageSafeForOnlineScoring: false,
    derivedFromSourceTables: ["source_markets", "quote_ticks"],
  },
  {
    file: "games.parquet",
    name: "quote_pair_count",
    meaning: "Count of consecutive same-market quote pairs in the full window (board input volume)",
    units: "count",
    causalOrNoncausal: "noncausal",
    leakageSafeForOnlineScoring: false,
    derivedFromSourceTables: ["quote_ticks", "source_markets"],
  },
  {
    file: "player_prop_ticks.parquet",
    name: "source",
    meaning:
      "Book/exchange for the prop (kalshi/bet365/polymarket); lets the re-ranker pick a per-source series + measure cross-source divergence",
    units: "categorical",
    causalOrNoncausal: "causal",
    leakageSafeForOnlineScoring: true,
    derivedFromSourceTables: ["source_markets", "market_instruments"],
  },
  {
    file: "player_prop_ticks.parquet",
    name: "line",
    meaning:
      "Over/under threshold for the prop (e.g. 5.5, 9.5); lets the re-ranker select ONE coherent line per player/source rather than blending levels",
    units: "rebounds",
    causalOrNoncausal: "causal",
    leakageSafeForOnlineScoring: true,
    derivedFromSourceTables: ["market_instruments"],
  },
  {
    file: "player_prop_ticks.parquet",
    name: "implied_probability",
    meaning:
      "Per-player rebound-prop implied probability per tick (raw causal series the attribution re-ranker windows around candidate events)",
    units: "probability 0..1",
    causalOrNoncausal: "causal",
    leakageSafeForOnlineScoring: true,
    derivedFromSourceTables: ["quote_ticks", "source_markets", "market_instruments"],
  },
  {
    file: "player_prop_ticks.parquet",
    name: "volume",
    meaning: "Per-player rebound-prop traded volume at the tick (for signed-flow / BVC features)",
    units: "contracts/shares (source-native)",
    causalOrNoncausal: "causal",
    leakageSafeForOnlineScoring: true,
    derivedFromSourceTables: ["quote_ticks", "source_markets", "market_instruments"],
  },
];

function buildFeatureCatalogMarkdown(): string {
  const header =
    "# Quant-Lab Snapshot Feature Catalog\n\n" +
    "Per-field provenance for the snapshot parquet outputs. `leakage_safe_for_online_scoring=no` " +
    "marks any field derived from incident labels, catch windows, or whole-game (non-causal) " +
    "statistics that an online scorer would not have at decision time.\n\n" +
    "| file | name | meaning | units | causal_or_noncausal | leakage_safe_for_online_scoring | derived_from_source_tables |\n" +
    "| --- | --- | --- | --- | --- | --- | --- |\n";
  const lines = FEATURE_CATALOG.map(
    (e) =>
      `| ${e.file} | ${e.name} | ${e.meaning} | ${e.units} | ${e.causalOrNoncausal} | ${e.leakageSafeForOnlineScoring ? "yes" : "no"} | ${e.derivedFromSourceTables.join(", ")} |`,
  );
  return `${header}${lines.join("\n")}\n`;
}

run()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  });
