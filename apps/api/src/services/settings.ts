// Settings service (US-019, PRD §20).
//
// Assembles the `/v1/settings` response from filesystem PRAGMAs and small
// disk reads only — no scans against the 54 GB gold DB. The gold DB handle
// is opened via openGoldDb (read-only, query_only=ON) and the cache DB via
// better-sqlite3 in readonly mode so this code path never widens the
// write surface.

import { existsSync, readFileSync, statSync } from "node:fs";

import Database from "better-sqlite3";
import { openGoldDb } from "@signal-console/db";
import { registry } from "@signal-console/detectors/registry";

export interface DbInfo {
  readonly path: string;
  readonly sizeBytes: number;
  readonly walBytes: number;
  readonly pageCount: number;
  readonly pageSize: number;
  readonly lastModified: string;
  readonly mode: "read-only" | "error";
  readonly openError?: string;
}

export interface CacheDbInfo {
  readonly path: string;
  readonly sizeBytes: number;
  readonly pageCount: number;
}

export interface SourceRow {
  readonly lastSyncAt: string | null;
  readonly lastError: string | null;
  readonly rateLimitCooldown: string | null;
}

export interface SourcesPresent {
  readonly ingestPaused: false;
  readonly bySource: Readonly<Record<string, SourceRow>>;
}

export interface SourcesPaused {
  readonly ingestPaused: true;
  readonly lastKnown: Readonly<Record<string, SourceRow>>;
}

export type Sources = SourcesPresent | SourcesPaused;

export interface LogEntry {
  readonly level: string;
  readonly message: string;
  readonly time: string | null;
}

export interface DetectorVersion {
  readonly id: string;
  readonly version: string;
}

export interface AboutInfo {
  readonly appVersion: string;
  readonly detectorVersions: readonly DetectorVersion[];
  readonly dbSchemaVersion: number;
}

export interface SettingsResponse {
  readonly db: DbInfo;
  readonly cacheDb: CacheDbInfo;
  readonly sources: Sources;
  readonly errors: readonly LogEntry[];
  readonly about: AboutInfo;
}

export interface SettingsOptions {
  readonly goldDbPath: string;
  readonly cacheDbPath: string;
  readonly heartbeatPath: string;
  readonly logPath: string;
  readonly appVersion: string;
  readonly maxErrors?: number;
}

const DEFAULT_MAX_ERRORS = 200;

// Pino level numbers → labels. Anything outside this range is rendered as the
// raw number so an unknown level still shows up in the Settings UI.
const PINO_LEVELS: Readonly<Record<number, string>> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function levelLabel(raw: unknown): string {
  if (typeof raw === "number" && Number.isInteger(raw)) {
    return PINO_LEVELS[raw] ?? String(raw);
  }
  if (typeof raw === "string") return raw;
  return "unknown";
}

function reasonFrom(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "unknown error";
}

function pragmaInt(db: Database.Database, name: string): number {
  const v = db.pragma(name, { simple: true });
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "bigint") return Number(v);
  return 0;
}

function fileSize(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function fileMtimeIso(path: string): string {
  if (!existsSync(path)) return new Date(0).toISOString();
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

interface GoldStats {
  readonly pageCount: number;
  readonly pageSize: number;
  readonly schemaVersion: number;
  readonly openError: string | null;
}

function readGoldStats(path: string): GoldStats {
  try {
    const db = openGoldDb(path);
    try {
      return {
        pageCount: pragmaInt(db, "page_count"),
        pageSize: pragmaInt(db, "page_size"),
        schemaVersion: pragmaInt(db, "user_version"),
        openError: null,
      };
    } finally {
      db.close();
    }
  } catch (err) {
    return { pageCount: 0, pageSize: 0, schemaVersion: 0, openError: reasonFrom(err) };
  }
}

function buildDbInfo(path: string, stats: GoldStats): DbInfo {
  const sizeBytes = fileSize(path);
  const walBytes = fileSize(`${path}-wal`);
  const lastModified = fileMtimeIso(path);
  if (stats.openError !== null) {
    return {
      path,
      sizeBytes,
      walBytes,
      pageCount: 0,
      pageSize: 0,
      lastModified,
      mode: "error",
      openError: stats.openError,
    };
  }
  return {
    path,
    sizeBytes,
    walBytes,
    pageCount: stats.pageCount,
    pageSize: stats.pageSize,
    lastModified,
    mode: "read-only",
  };
}

function readCacheDbInfo(path: string): CacheDbInfo {
  const sizeBytes = fileSize(path);
  if (!existsSync(path)) {
    return { path, sizeBytes, pageCount: 0 };
  }
  try {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      return { path, sizeBytes, pageCount: pragmaInt(db, "page_count") };
    } finally {
      db.close();
    }
  } catch {
    return { path, sizeBytes, pageCount: 0 };
  }
}

function parseSourceRow(v: unknown): SourceRow {
  if (!isRecord(v)) {
    return { lastSyncAt: null, lastError: null, rateLimitCooldown: null };
  }
  return {
    lastSyncAt: asString(v["lastSyncAt"]),
    lastError: asString(v["lastError"]),
    rateLimitCooldown: asString(v["rateLimitCooldown"]),
  };
}

function parseBySource(v: unknown): Readonly<Record<string, SourceRow>> {
  if (!isRecord(v)) return {};
  return Object.fromEntries(
    Object.entries(v).map(([key, value]): [string, SourceRow] => [key, parseSourceRow(value)]),
  );
}

function readSources(heartbeatPath: string): Sources {
  if (!existsSync(heartbeatPath)) {
    return { ingestPaused: true, lastKnown: {} };
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(heartbeatPath, "utf8"));
    if (!isRecord(raw)) {
      return { ingestPaused: true, lastKnown: {} };
    }
    return { ingestPaused: false, bySource: parseBySource(raw["sources"] ?? raw) };
  } catch {
    return { ingestPaused: true, lastKnown: {} };
  }
}

function parseLogLine(line: string): LogEntry | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  try {
    const obj: unknown = JSON.parse(trimmed);
    if (!isRecord(obj)) return null;
    const message = asString(obj["msg"]) ?? asString(obj["message"]) ?? asString(obj["err"]) ?? "";
    return {
      level: levelLabel(obj["level"]),
      message,
      time: asString(obj["time"]),
    };
  } catch {
    return null;
  }
}

function readErrors(logPath: string, max: number): readonly LogEntry[] {
  if (!existsSync(logPath)) return [];
  try {
    const text = readFileSync(logPath, "utf8");
    const parsed = text
      .split("\n")
      .map(parseLogLine)
      .filter((entry): entry is LogEntry => entry !== null);
    // Tail AFTER parsing so blank trailing newlines and any malformed
    // intermixed lines don't eat into the cap.
    return parsed.slice(Math.max(0, parsed.length - max));
  } catch {
    return [];
  }
}

function readDetectorVersions(): readonly DetectorVersion[] {
  return [...registry.values()]
    .map((d): DetectorVersion => ({ id: d.id, version: d.version }))
    .toSorted((a, b) => a.id.localeCompare(b.id));
}

export function readSettings(opts: SettingsOptions): SettingsResponse {
  const max = opts.maxErrors ?? DEFAULT_MAX_ERRORS;
  const goldStats = readGoldStats(opts.goldDbPath);
  return {
    db: buildDbInfo(opts.goldDbPath, goldStats),
    cacheDb: readCacheDbInfo(opts.cacheDbPath),
    sources: readSources(opts.heartbeatPath),
    errors: readErrors(opts.logPath, max),
    about: {
      appVersion: opts.appVersion,
      detectorVersions: readDetectorVersions(),
      dbSchemaVersion: goldStats.schemaVersion,
    },
  };
}
