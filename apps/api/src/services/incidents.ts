import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openGoldDb } from "@signal-console/db";

type GoldDbHandle = ReturnType<typeof openGoldDb>;

const HERE = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_BAKEOFF_RESULTS_PATH = resolve(
  HERE,
  "../../../../outputs/nba-detector-bakeoff/research/bakeoff-results.json",
);

export const DEFAULT_DESK_INCIDENTS_PATH = resolve(HERE, "../../../../data/desk-incidents.json");

const LIVE_CONTROL_ALGO_ID = "A01_legacy_60_vw_k3";
const TEAM_MATCH_WINDOW_MS = 12 * 60 * 60 * 1000;
const DESK_STORE_SCHEMA_VERSION = 1;
const DESK_STORE_LOCK_POLL_MS = 25;
const DESK_STORE_LOCK_TIMEOUT_MS = 5_000;
const DESK_STORE_LOCK_STALE_MS = 30_000;

export type KnownCaseOrigin = "benchmark" | "desk-entered";

export interface KnownCaseAlgorithmResult {
  readonly algoId: string;
  readonly scoreable: boolean;
  readonly caught: boolean;
  readonly leadSeconds: number | null;
  readonly fireIso: string | null;
  readonly skipReason: string | null;
}

export interface KnownCase {
  readonly id: string;
  readonly origin: KnownCaseOrigin;
  readonly incidentName: string;
  readonly claim: string;
  readonly confidence: string;
  readonly anchorType: string;
  readonly gameDate: string;
  readonly teams: string;
  readonly gameId: string;
  readonly period: string;
  readonly clock: string;
  readonly utcTime: string;
  readonly stat: string;
  readonly creditedPlayer: string;
  readonly rightfulPlayer: string;
  readonly sourceOrigin: string;
  readonly sourceReference: string;
  readonly sourceTextSummary: string;
  readonly notes: string;
  readonly officialCorrection: boolean;
  readonly localBoardGameIds: readonly string[];
  readonly scoreable: boolean;
  readonly liveControl: KnownCaseAlgorithmResult | null;
  readonly bestResult: KnownCaseAlgorithmResult | null;
  readonly createdAt: string | null;
  readonly createdBy: string | null;
}

export interface KnownCasesResult {
  readonly generatedAt: string | null;
  readonly coverage: {
    readonly totalIncidents: number;
    readonly exactAnchorIncidents: number;
    readonly scoreableIncidents: number;
    readonly denominatorGames: number;
  };
  readonly incidents: readonly KnownCase[];
}

export interface DeskIncidentInput {
  readonly incidentName: string;
  readonly claim: string;
  readonly utcTime?: string;
  readonly gameClock?: string;
  readonly period?: string;
  readonly teamOne?: string;
  readonly teamTwo?: string;
  readonly gameId?: string;
  readonly stat?: string;
  readonly creditedPlayer?: string;
  readonly rightfulPlayer?: string;
  readonly notes?: string;
  readonly createdBy?: string;
}

export interface IncidentStorePaths {
  readonly bakeoffResultsPath?: string;
  readonly deskIncidentsPath?: string;
  readonly goldDbPath?: string;
}

interface StoredDeskIncident {
  readonly id: string;
  readonly incidentName: string;
  readonly claim: string;
  readonly utcTime: string;
  readonly gameClock: string;
  readonly period: string;
  readonly teamOne: string;
  readonly teamTwo: string;
  readonly gameId: string;
  readonly stat: string;
  readonly creditedPlayer: string;
  readonly rightfulPlayer: string;
  readonly notes: string;
  readonly createdAt: string;
  readonly createdBy: string;
}

type JsonReadResult =
  | { readonly ok: true; readonly missing: boolean; readonly value: unknown }
  | { readonly ok: false; readonly missing: false; readonly error: unknown };

interface DeskStoreRead {
  readonly incidents: readonly StoredDeskIncident[];
  readonly corrupt: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readJson(path: string): JsonReadResult {
  if (!existsSync(path)) return { ok: true, missing: true, value: null };
  try {
    return { ok: true, missing: false, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    return { ok: false, missing: false, error };
  }
}

function readString(r: Record<string, unknown>, key: string): string {
  const v = r[key];
  return typeof v === "string" ? v : "";
}

function readBool(r: Record<string, unknown>, key: string): boolean {
  return r[key] === true;
}

function readNumberOrNull(r: Record<string, unknown>, key: string): number | null {
  const v = r[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function readStringOrNull(r: Record<string, unknown>, key: string): string | null {
  const v = r[key];
  return typeof v === "string" ? v : null;
}

function readStringArray(r: Record<string, unknown>, key: string): readonly string[] {
  const v = r[key];
  if (!Array.isArray(v)) return [];
  return v.flatMap((item): readonly string[] => (typeof item === "string" ? [item] : []));
}

function incidentNameFrom(id: string, stat: string, rightful: string, credited: string): string {
  const parts = [rightful, stat, credited === "" ? "" : `from ${credited}`].filter(
    (p) => p.length > 0,
  );
  return parts.length > 0 ? parts.join(" ") : id;
}

function readAlgorithmResult(v: unknown): KnownCaseAlgorithmResult | null {
  if (!isRecord(v)) return null;
  return {
    algoId: readString(v, "algoId"),
    scoreable: readBool(v, "scoreable"),
    caught: readBool(v, "caught"),
    leadSeconds: readNumberOrNull(v, "leadSeconds"),
    fireIso: readStringOrNull(v, "fireIso"),
    skipReason: readStringOrNull(v, "skipReason"),
  };
}

function bestAlgoId(payload: Record<string, unknown>): string {
  const best = payload["bestSummary"];
  return isRecord(best) ? readString(best, "algoId") : "";
}

function coverageFrom(payload: Record<string, unknown>): KnownCasesResult["coverage"] {
  const coverage = payload["coverage"];
  const source = isRecord(coverage) ? coverage : payload;
  const read = (key: string): number => {
    const value = source[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  return {
    totalIncidents: read("totalIncidents"),
    exactAnchorIncidents: read("exactAnchorIncidents"),
    scoreableIncidents: read("scoreableIncidents"),
    denominatorGames: read("denominatorGames"),
  };
}

function resultForIncident(
  rawResults: readonly unknown[],
  incidentId: string,
  algoId: string,
): KnownCaseAlgorithmResult | null {
  for (const raw of rawResults) {
    if (!isRecord(raw)) continue;
    if (readString(raw, "incidentId") !== incidentId) continue;
    if (readString(raw, "algoId") !== algoId) continue;
    return readAlgorithmResult(raw);
  }
  return null;
}

function isScoreable(rawResults: readonly unknown[], incidentId: string): boolean {
  return rawResults.some((raw) => {
    if (!isRecord(raw)) return false;
    return readString(raw, "incidentId") === incidentId && readBool(raw, "scoreable");
  });
}

function benchmarkCaseFrom(
  raw: unknown,
  rawResults: readonly unknown[],
  bestId: string,
): KnownCase | null {
  if (!isRecord(raw)) return null;
  const id = readString(raw, "id");
  if (id.length === 0) return null;
  const stat = readString(raw, "stat");
  const credited = readString(raw, "creditedPlayer");
  const rightful = readString(raw, "rightfulPlayer");
  return {
    id,
    origin: "benchmark",
    incidentName: incidentNameFrom(id, stat, rightful, credited),
    claim: readString(raw, "sourceTextSummary") || readString(raw, "notes") || id,
    confidence: readString(raw, "confidence"),
    anchorType: readString(raw, "anchorType"),
    gameDate: readString(raw, "gameDate"),
    teams: readString(raw, "teams"),
    gameId: readString(raw, "gameId"),
    period: readString(raw, "period"),
    clock: readString(raw, "clock"),
    utcTime: readString(raw, "utcTime"),
    stat,
    creditedPlayer: credited,
    rightfulPlayer: rightful,
    sourceOrigin: readString(raw, "sourceOrigin"),
    sourceReference: readString(raw, "sourceReference"),
    sourceTextSummary: readString(raw, "sourceTextSummary"),
    notes: readString(raw, "notes"),
    officialCorrection: readBool(raw, "officialCorrection"),
    localBoardGameIds: readStringArray(raw, "localBoardGameIds"),
    scoreable: isScoreable(rawResults, id),
    liveControl: resultForIncident(rawResults, id, LIVE_CONTROL_ALGO_ID),
    bestResult: bestId.length === 0 ? null : resultForIncident(rawResults, id, bestId),
    createdAt: null,
    createdBy: null,
  };
}

function readBenchmarkedCases(path: string): {
  readonly generatedAt: string | null;
  readonly coverage: KnownCasesResult["coverage"];
  readonly incidents: readonly KnownCase[];
} {
  const payload = readJson(path);
  if (!payload.ok || !isRecord(payload.value)) {
    return {
      generatedAt: null,
      coverage: {
        totalIncidents: 0,
        exactAnchorIncidents: 0,
        scoreableIncidents: 0,
        denominatorGames: 0,
      },
      incidents: [],
    };
  }
  const rawIncidents = payload.value["incidents"];
  const rawResults = Array.isArray(payload.value["incidentResults"])
    ? payload.value["incidentResults"]
    : [];
  const bestId = bestAlgoId(payload.value);
  const incidents = Array.isArray(rawIncidents)
    ? rawIncidents.flatMap((item): readonly KnownCase[] => {
        const incident = benchmarkCaseFrom(item, rawResults, bestId);
        return incident === null ? [] : [incident];
      })
    : [];
  return {
    generatedAt: readStringOrNull(payload.value, "generatedAt"),
    coverage: coverageFrom(payload.value),
    incidents,
  };
}

function readStoredDeskIncident(raw: unknown): StoredDeskIncident | null {
  if (!isRecord(raw)) return null;
  const id = readString(raw, "id");
  const incidentName = readString(raw, "incidentName");
  const claim = readString(raw, "claim");
  if (id.length === 0 || incidentName.length === 0 || claim.length === 0) return null;
  return {
    id,
    incidentName,
    claim,
    utcTime: readString(raw, "utcTime"),
    gameClock: readString(raw, "gameClock"),
    period: readString(raw, "period"),
    teamOne: readString(raw, "teamOne"),
    teamTwo: readString(raw, "teamTwo"),
    gameId: readString(raw, "gameId"),
    stat: readString(raw, "stat"),
    creditedPlayer: readString(raw, "creditedPlayer"),
    rightfulPlayer: readString(raw, "rightfulPlayer"),
    notes: readString(raw, "notes"),
    createdAt: readString(raw, "createdAt"),
    createdBy: readString(raw, "createdBy"),
  };
}

function readDeskStoreDetailed(path: string): DeskStoreRead {
  const payload = readJson(path);
  if (!payload.ok) return { incidents: [], corrupt: true };
  if (!isRecord(payload.value)) return { incidents: [], corrupt: false };
  const incidents = payload.value["incidents"];
  if (!Array.isArray(incidents)) return { incidents: [], corrupt: false };
  return {
    corrupt: false,
    incidents: incidents.flatMap((item): readonly StoredDeskIncident[] => {
      const incident = readStoredDeskIncident(item);
      return incident === null ? [] : [incident];
    }),
  };
}

function readDeskStore(path: string): readonly StoredDeskIncident[] {
  return readDeskStoreDetailed(path).incidents;
}

function deskCaseFrom(stored: StoredDeskIncident): KnownCase {
  const teams = [stored.teamOne, stored.teamTwo].filter((v) => v.length > 0).join(" / ");
  return {
    id: stored.id,
    origin: "desk-entered",
    incidentName: stored.incidentName,
    claim: stored.claim,
    confidence: "desk",
    anchorType: stored.utcTime.length > 0 ? "second" : "desk-clock",
    gameDate: stored.utcTime.length >= 10 ? stored.utcTime.slice(0, 10) : "",
    teams,
    gameId: stored.gameId,
    period: stored.period,
    clock: stored.gameClock,
    utcTime: stored.utcTime,
    stat: stored.stat,
    creditedPlayer: stored.creditedPlayer,
    rightfulPlayer: stored.rightfulPlayer,
    sourceOrigin: "desk_entered",
    sourceReference: "bet365 trading desk form",
    sourceTextSummary: stored.claim,
    notes: stored.notes,
    officialCorrection: false,
    localBoardGameIds: stored.gameId.length > 0 ? [stored.gameId] : [],
    scoreable: false,
    liveControl: null,
    bestResult: null,
    createdAt: stored.createdAt,
    createdBy: stored.createdBy,
  };
}

export function listKnownCases(paths: IncidentStorePaths = {}): KnownCasesResult {
  const benchmark = readBenchmarkedCases(paths.bakeoffResultsPath ?? DEFAULT_BAKEOFF_RESULTS_PATH);
  const desk = readDeskStore(paths.deskIncidentsPath ?? DEFAULT_DESK_INCIDENTS_PATH).map(
    deskCaseFrom,
  );
  return {
    generatedAt: benchmark.generatedAt,
    coverage: benchmark.coverage,
    incidents: [...benchmark.incidents, ...desk],
  };
}

function cleanSlug(input: string): string {
  const lower = input.trim().toLowerCase();
  const collapsed = lower.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return collapsed.length > 0 ? collapsed.slice(0, 64) : "desk_case";
}

function optional(input: string | undefined): string {
  return input?.trim() ?? "";
}

function writeDeskStore(path: string, incidents: readonly StoredDeskIncident[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(
    tmp,
    `${JSON.stringify({ schemaVersion: DESK_STORE_SCHEMA_VERSION, incidents }, null, 2)}\n`,
    "utf8",
  );
  renameSync(tmp, path);
}

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function withDeskStoreLock<T>(path: string, fn: () => T): T {
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  const startedAt = Date.now();
  for (;;) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "EEXIST") throw error;
      try {
        const ageMs = Date.now() - statSync(lockPath).mtimeMs;
        if (ageMs > DESK_STORE_LOCK_STALE_MS) {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if (!isErrnoException(statError) || statError.code !== "ENOENT") throw statError;
        continue;
      }
      if (Date.now() - startedAt > DESK_STORE_LOCK_TIMEOUT_MS) {
        throw new Error(`timed out waiting for desk incident store lock: ${lockPath}`);
      }
      sleepSync(DESK_STORE_LOCK_POLL_MS);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

function quarantineCorruptDeskStore(path: string): void {
  if (!existsSync(path)) return;
  const suffix = new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);
  renameSync(path, `${path}.corrupt-${suffix}`);
}

function fieldContainsTeam(row: Record<string, unknown>, hint: string): boolean {
  const needle = hint.trim().toLowerCase();
  if (needle.length === 0) return true;
  return (
    readString(row, "home_participant_json").toLowerCase().includes(needle) ||
    readString(row, "away_participant_json").toLowerCase().includes(needle)
  );
}

function resolveGameIdFromHints(
  db: GoldDbHandle,
  utcTime: string,
  teamHints: readonly string[],
): string {
  const anchorMs = Date.parse(utcTime);
  if (!Number.isFinite(anchorMs) || teamHints.length === 0) return "";
  const lower = new Date(anchorMs - TEAM_MATCH_WINDOW_MS).toISOString();
  const upper = new Date(anchorMs + TEAM_MATCH_WINDOW_MS).toISOString();
  const rows = db
    .prepare(
      `SELECT id, scheduled_start, home_participant_json, away_participant_json
       FROM games
       WHERE scheduled_start >= ? AND scheduled_start <= ?
       ORDER BY scheduled_start`,
    )
    .all(lower, upper);
  const records = rows.filter((row): row is Record<string, unknown> => isRecord(row));
  const exactMatches = records.filter((row) =>
    teamHints.every((hint) => fieldContainsTeam(row, hint)),
  );
  const eligible =
    exactMatches.length > 0
      ? exactMatches
      : teamHints.length === 1
        ? records.filter((row) => fieldContainsTeam(row, teamHints[0] ?? ""))
        : [];
  if (eligible.length === 0) return "";
  return closestGameIdByStart(anchorMs, eligible);
}

function closestGameIdByStart(anchorMs: number, rows: readonly Record<string, unknown>[]): string {
  const ranked = rows
    .map((row) => {
      const scheduledMs = Date.parse(readString(row, "scheduled_start"));
      return {
        id: readString(row, "id"),
        distance: Number.isFinite(scheduledMs) ? Math.abs(scheduledMs - anchorMs) : Infinity,
      };
    })
    .filter((row) => row.id.length > 0)
    .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
  return ranked[0]?.id ?? "";
}

function resolveGameId(input: DeskIncidentInput, goldDbPath: string | undefined): string {
  const explicit = optional(input.gameId);
  if (explicit.length > 0) return explicit;
  const utcTime = optional(input.utcTime);
  if (utcTime.length === 0 || goldDbPath === undefined) return "";
  const teamHints = [optional(input.teamOne), optional(input.teamTwo)].filter((v) => v.length > 0);
  if (teamHints.length === 0) return "";
  try {
    const db = openGoldDb(goldDbPath);
    try {
      return resolveGameIdFromHints(db, utcTime, teamHints);
    } finally {
      db.close();
    }
  } catch {
    return "";
  }
}

export function appendDeskIncident(
  input: DeskIncidentInput,
  paths: IncidentStorePaths = {},
): KnownCase {
  const deskPath = paths.deskIncidentsPath ?? DEFAULT_DESK_INCIDENTS_PATH;
  return withDeskStoreLock(deskPath, () => {
    const existing = readDeskStoreDetailed(deskPath);
    if (existing.corrupt) {
      quarantineCorruptDeskStore(deskPath);
    }
    const createdAt = new Date().toISOString();
    const id = `desk_${createdAt.replace(/[^0-9]/g, "").slice(0, 14)}_${cleanSlug(
      input.incidentName,
    )}_${randomUUID().slice(0, 8)}`;
    const stored: StoredDeskIncident = {
      id,
      incidentName: input.incidentName.trim(),
      claim: input.claim.trim(),
      utcTime: optional(input.utcTime),
      gameClock: optional(input.gameClock),
      period: optional(input.period),
      teamOne: optional(input.teamOne),
      teamTwo: optional(input.teamTwo),
      gameId: resolveGameId(input, paths.goldDbPath),
      stat: optional(input.stat),
      creditedPlayer: optional(input.creditedPlayer),
      rightfulPlayer: optional(input.rightfulPlayer),
      notes: optional(input.notes),
      createdAt,
      createdBy: optional(input.createdBy) || "bet365 trading desk",
    };
    writeDeskStore(deskPath, [...existing.incidents, stored]);
    return deskCaseFrom(stored);
  });
}
