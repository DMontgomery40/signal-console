// Bridge: turn accumulated nba_pbp_revisions into eval-ready miscredit LABELS.
//
// NBA stat corrections are silent edits with no official feed, so the engine is a
// versioned snapshot-diff harvester: capture-pbp-revisions.ts appends a snapshot of
// each game's PBP on a cadence; an action whose credited person/name CHANGES between
// snapshots is a credited->rightful transition = a label. The collapse-to-net +
// label shaping lives in harvestMiscreditLabels (shared, hermetically tested); this
// script just wires the DB + writes the incident-registry-shaped artifact the
// re-ranker eval consumes (attribution-eval / far-calibration), surfaced at
// GET /v1/research/harvested-labels.
//
//   GOLD_DB_PATH=~/signal-console/data/signal-console.sqlite \
//     pnpm tsx scripts/harvest-incident-labels.ts [--games 0042500312,... ] [--stat rebound]
//
// Until captures accumulate (>=2 snapshots per action with a real correction between
// them), this honestly emits 0 labels — the shadow is append-only and grows over days.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { GOLD_DB_PATH } from "../packages/db/src/open";
import { harvestMiscreditLabels } from "../packages/shared/src/live-repository";

process.env.SIGNAL_CONSOLE_DB_PATH ??= process.env.GOLD_DB_PATH ?? GOLD_DB_PATH;

const OUT_PATH = resolve("outputs", "nba-quant-lab", "harvested_incidents.json");

function parseArgFlag(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const stat = (parseArgFlag("--stat") ?? "rebound").toLowerCase();
  const argGames = parseArgFlag("--games");
  const gameIds = argGames
    ? argGames
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((g) => (g.startsWith("nba-") ? g : `nba-${g}`))
    : undefined;

  const result = harvestMiscreditLabels(gameIds ? { gameIds, stat } : { stat });
  const report = {
    generatedAt: new Date().toISOString(),
    source: "pbp-revision-harvester",
    stat,
    gamesScanned: result.gamesScanned,
    netTransitions: result.netTransitions,
    nonStatTransitions: result.nonStatTransitions,
    incidentCount: result.incidents.length,
    incidents: result.incidents,
  };
  mkdirSync(resolve("outputs", "nba-quant-lab"), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `harvested ${result.incidents.length} ${stat} label(s) from ${result.gamesScanned} game(s) ` +
      `(${result.netTransitions} net transitions, ${result.nonStatTransitions} non-${stat}) -> ${OUT_PATH}`,
  );
  if (result.incidents.length === 0) {
    console.log(
      "0 labels is expected until captures accumulate: the shadow needs >=2 snapshots per action " +
        "with a real correction between them. Re-run capture-pbp-revisions.ts on a cadence, then this.",
    );
  }
}

main();
