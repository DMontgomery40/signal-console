import { readFileSync } from "node:fs";

import type { IncidentRegistryPayload, RawIncident } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readJsonRecord(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  return isRecord(parsed) ? parsed : {};
}

// Casing-tolerant field readers. The live incident registry is camelCase
// (gameId, utcTime, ...); some legacy/source registries use snake_case
// (game_id, utc_time, ...). We accept BOTH (camelCase first, snake fallback) so
// the canonical reader never silently returns empty ids/anchors because of a
// key-casing mismatch. (Latent bug found 2026-05-29: the original reader read
// only snake_case and produced empty gameId/utcTime against the camelCase
// registry — breaking every incident match downstream.)
function stringField(row: Record<string, unknown>, ...keys: readonly string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return "";
}

function boolField(row: Record<string, unknown>, ...keys: readonly string[]): boolean {
  return keys.some((key) => row[key] === true);
}

function stringArrayField(
  row: Record<string, unknown>,
  ...keys: readonly string[]
): readonly string[] {
  for (const key of keys) {
    const value = row[key];
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === "string");
    }
  }
  return [];
}

export const ARCHIVE_ONLY_INCIDENTS: readonly RawIncident[] = [
  {
    id: "archive_sasser_rebound",
    confidence: "medium",
    anchorType: "archive-only",
    gameDate: "2026-05-07/14",
    teams: "",
    gameId: "",
    period: "Q2",
    clock: "07:32",
    utcTime: "",
    stat: "rebound",
    creditedPlayer: "Marcus Sasser",
    rightfulPlayer: "",
    sourceOrigin: "archive_only",
    sourceReference:
      "nba-predict/.docs-archive/2026-05-repo-audit/outputs/innovation-team-suspend-signal-report/research/03b-external-research-verified.md",
    sourceTextSummary:
      "Archive-only rebound misattribution candidate not carried into current registry.",
    notes: "No exact UTC anchor recovered in current generated registry.",
    officialCorrection: false,
    localBoardGameIds: [],
  },
  {
    id: "archive_levert_jenkins_assist",
    confidence: "medium",
    anchorType: "archive-only",
    gameDate: "2026-05-07/14",
    teams: "",
    gameId: "",
    period: "Q3",
    clock: "04:13",
    utcTime: "",
    stat: "assist",
    creditedPlayer: "Cade LeVert / Daniss Jenkins",
    rightfulPlayer: "",
    sourceOrigin: "archive_only",
    sourceReference:
      "nba-predict/.docs-archive/2026-05-repo-audit/outputs/innovation-team-suspend-signal-report/research/03b-external-research-verified.md",
    sourceTextSummary: "Archive-only missing-assist candidate not carried into current registry.",
    notes: "No exact UTC anchor recovered in current generated registry.",
    officialCorrection: false,
    localBoardGameIds: [],
  },
  {
    id: "archive_sarr_trae_rebound",
    confidence: "medium",
    anchorType: "archive-only",
    gameDate: "2026-03-09",
    teams: "",
    gameId: "",
    period: "",
    clock: "",
    utcTime: "",
    stat: "rebound",
    creditedPlayer: "Alexandre Sarr",
    rightfulPlayer: "Trae Young",
    sourceOrigin: "archive_only",
    sourceReference:
      "nba-predict/.docs-archive/2026-05-repo-audit/outputs/innovation-team-suspend-signal-report/research/03b-external-research-verified.md",
    sourceTextSummary:
      "Archive-only regular-season rebound candidate outside the local playoff window.",
    notes: "Outside current local quote/PBP coverage.",
    officialCorrection: false,
    localBoardGameIds: [],
  },
];

export function normalizeIncident(raw: unknown): RawIncident | null {
  if (!isRecord(raw)) return null;
  const id = stringField(raw, "id");
  if (id === "") return null;
  return {
    id,
    confidence: stringField(raw, "confidence"),
    anchorType: stringField(raw, "anchorType", "anchor_type"),
    gameDate: stringField(raw, "gameDate", "game_date"),
    teams: stringField(raw, "teams"),
    gameId: stringField(raw, "gameId", "game_id"),
    period: stringField(raw, "period"),
    clock: stringField(raw, "clock"),
    utcTime: stringField(raw, "utcTime", "utc_time"),
    stat: stringField(raw, "stat"),
    creditedPlayer: stringField(raw, "creditedPlayer", "credited_player"),
    rightfulPlayer: stringField(raw, "rightfulPlayer", "rightful_player"),
    sourceOrigin: stringField(raw, "sourceOrigin", "source_origin"),
    sourceReference: stringField(raw, "sourceReference", "source_reference"),
    sourceTextSummary: stringField(raw, "sourceTextSummary", "source_text_summary"),
    notes: stringField(raw, "notes"),
    officialCorrection: boolField(raw, "officialCorrection", "official_correction"),
    localBoardGameIds: stringArrayField(raw, "localBoardGameIds", "local_board_game_ids"),
  };
}

export function readIncidents(sourceRegistryPath: string): readonly RawIncident[] {
  const payload: IncidentRegistryPayload = readJsonRecord(sourceRegistryPath);
  const incidents = (payload.incidents ?? []).flatMap((item): readonly RawIncident[] => {
    const incident = normalizeIncident(item);
    return incident === null ? [] : [incident];
  });
  const seen = new Set(incidents.map((incident) => incident.id));
  const extras = ARCHIVE_ONLY_INCIDENTS.filter((incident) => !seen.has(incident.id));
  return [...incidents, ...extras];
}
