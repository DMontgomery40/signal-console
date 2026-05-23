// Canonical contract-test fixture loader (US-010). Reads
// packages/detectors/src/board-mad/__tests__/fixtures/<gameId>.json.gz or
// <gameId>.json (transparent gunzip) and returns a typed Tick[] suitable for
// feeding directly into the board-mad detector via DetectorWindow.ticks.
//
// Each fixture file is a JSON blob produced by scripts/extract-fixtures.ts;
// see that script's header for the wire format. Volumes are pre-coalesced to 0
// at extract time (gold DB column is nullable; detector type Tick.volume is
// non-nullable), and isHeartbeat is decoded from the column's INTEGER 0/1.
//
// Validation is per-field (no `as` casts, no `any`) so a malformed fixture
// throws an explicit error rather than silently corrupting detector output.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import type { Tick } from "../../types";

interface FixturePayload {
  readonly gameId: string;
  readonly window: { readonly start: string; readonly end: string };
  readonly ticks: readonly WireTick[];
}

interface WireTick {
  readonly sourceMarketId: string;
  readonly capturedAt: string;
  readonly impliedProbability: number | null;
  readonly volume: number;
  readonly isHeartbeat: boolean;
}

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function pickString(rec: Record<string, unknown>, key: string): string {
  const v = rec[key];
  if (typeof v !== "string") {
    throw new Error(`fixture field ${key}: expected string`);
  }
  return v;
}

function pickNumber(rec: Record<string, unknown>, key: string): number {
  const v = rec[key];
  if (typeof v !== "number") {
    throw new Error(`fixture field ${key}: expected number`);
  }
  return v;
}

function pickNumberOrNull(rec: Record<string, unknown>, key: string): number | null {
  const v = rec[key];
  if (v === null) return null;
  if (typeof v === "number") return v;
  throw new Error(`fixture field ${key}: expected number|null`);
}

function pickBoolean(rec: Record<string, unknown>, key: string): boolean {
  const v = rec[key];
  if (typeof v !== "boolean") {
    throw new Error(`fixture field ${key}: expected boolean`);
  }
  return v;
}

function parseWireTick(raw: unknown): WireTick {
  if (!isRecord(raw)) {
    throw new Error("fixture tick row is not an object");
  }
  return {
    sourceMarketId: pickString(raw, "sourceMarketId"),
    capturedAt: pickString(raw, "capturedAt"),
    impliedProbability: pickNumberOrNull(raw, "impliedProbability"),
    volume: pickNumber(raw, "volume"),
    isHeartbeat: pickBoolean(raw, "isHeartbeat"),
  };
}

function parsePayload(raw: unknown): FixturePayload {
  if (!isRecord(raw)) {
    throw new Error("fixture payload is not an object");
  }
  const ticksRaw = raw.ticks;
  if (!Array.isArray(ticksRaw)) {
    throw new Error("fixture payload.ticks is not an array");
  }
  const windowRaw = raw.window;
  if (!isRecord(windowRaw)) {
    throw new Error("fixture payload.window is not an object");
  }
  return {
    gameId: pickString(raw, "gameId"),
    window: {
      start: pickString(windowRaw, "start"),
      end: pickString(windowRaw, "end"),
    },
    ticks: ticksRaw.map((row): WireTick => parseWireTick(row)),
  };
}

function readPayloadBytes(gameId: string): Buffer {
  const gzPath = resolve(FIXTURES_DIR, `${gameId}.json.gz`);
  if (existsSync(gzPath)) {
    return gunzipSync(readFileSync(gzPath));
  }
  const plainPath = resolve(FIXTURES_DIR, `${gameId}.json`);
  if (existsSync(plainPath)) {
    return readFileSync(plainPath);
  }
  throw new Error(`no fixture for ${gameId} (looked at ${gzPath} and ${plainPath})`);
}

export function loadFixturePayload(gameId: string): FixturePayload {
  const bytes = readPayloadBytes(gameId);
  return parsePayload(JSON.parse(bytes.toString("utf8")));
}

export function loadFixtureTicks(gameId: string): readonly Tick[] {
  const payload = loadFixturePayload(gameId);
  return payload.ticks.map(
    (w): Tick => ({
      gameId: payload.gameId,
      sourceMarketId: w.sourceMarketId,
      capturedAt: new Date(w.capturedAt),
      impliedProbability: w.impliedProbability,
      volume: w.volume,
      isHeartbeat: w.isHeartbeat,
    }),
  );
}
