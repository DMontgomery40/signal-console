// Detector defaults service (US-053, PRD §20).
//
// Runtime-editable detector configuration backing the Live + Backtest paths.
// Source of truth: ~/signal-console/data/detector-defaults.json. When the file
// is missing or malformed, the in-package defaults (board-mad/config.ts +
// board-mad/params.ts) seed the response.
//
// Both apps/api/src/services/board.ts and backtest.ts read these defaults at
// request time. A 5-second in-process TTL cache absorbs the per-request file
// hit; edits via POST /v1/settings/detector-defaults take effect within 5 s
// without restarting Fastify.
//
// Cache invalidation: the board-mad runtime detector_version is derived from
// the hash of the resolved defaults (boardMadDetectorVersion). Any change to
// the file shifts the version suffix; detector_runs rows from the old
// configuration become cache misses on the next access and are recomputed.
// When the file matches baseline defaults, the suffix is dropped and the
// version is the unchanged "1.1.0" — pre-existing cache rows stay valid.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { detector as boardMad } from "@signal-console/detectors/board-mad";
import { K_MAD_LIVE } from "@signal-console/detectors/board-mad/config";
import { z } from "zod";

export const DETECTOR_DEFAULTS_PATH: string = join(
  homedir(),
  "signal-console",
  "data",
  "detector-defaults.json",
);

export const DetectorDefaultsSchema = z
  .object({
    kMadLive: z.number().min(1).max(12).default(K_MAD_LIVE),
    trailingBuckets: z.number().int().min(5).max(60).default(20),
    warmupBuckets: z.number().int().min(2).max(20).default(8),
    freshCapSeconds: z.number().int().min(30).max(3600).default(300),
    pbpPreBufferMs: z
      .number()
      .int()
      .min(60_000)
      .max(3_600_000)
      .default(5 * 60 * 1000),
    pbpPostBufferMs: z.number().int().min(10_000).max(600_000).default(60_000),
  })
  .strict();

export type DetectorDefaults = z.infer<typeof DetectorDefaultsSchema>;

export const BASELINE_DEFAULTS: DetectorDefaults = DetectorDefaultsSchema.parse({});

const TTL_MS = 5_000;

interface CacheEntry {
  readonly defaults: DetectorDefaults;
  readonly readAt: number;
}

let cache: CacheEntry | null = null;
let activePath: string = DETECTOR_DEFAULTS_PATH;

function readFromDisk(path: string): DetectorDefaults {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return BASELINE_DEFAULTS;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return BASELINE_DEFAULTS;
  }
  const result = DetectorDefaultsSchema.safeParse(parsed);
  if (!result.success) return BASELINE_DEFAULTS;
  return result.data;
}

// Read the current defaults, honoring the 5 s TTL. The active path may be
// changed by setDetectorDefaultsPath() for tests; callers that don't override
// it use ~/signal-console/data/detector-defaults.json.
export function readDetectorDefaults(now: number = Date.now()): DetectorDefaults {
  if (cache !== null && now - cache.readAt < TTL_MS) {
    return cache.defaults;
  }
  const defaults = readFromDisk(activePath);
  cache = { defaults, readAt: now };
  return defaults;
}

// Atomic write: serialize → write .tmp → rename. SHARED FS rename is atomic
// on POSIX (single inode swap). Cache is invalidated immediately so the next
// readDetectorDefaults() call sees the new value without waiting on the TTL.
export function writeDetectorDefaults(next: unknown): DetectorDefaults {
  const validated = DetectorDefaultsSchema.parse(next);
  const dir = dirname(activePath);
  mkdirSync(dir, { recursive: true });
  const tmp = `${activePath}.tmp.${String(process.pid)}.${String(Date.now())}`;
  writeFileSync(tmp, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  renameSync(tmp, activePath);
  cache = { defaults: validated, readAt: Date.now() };
  return validated;
}

export function invalidateDetectorDefaultsCache(): void {
  cache = null;
}

// Test-only hook. Production code always uses DETECTOR_DEFAULTS_PATH.
export function setDetectorDefaultsPath(path: string): void {
  activePath = path;
  cache = null;
}

// Stable runtime version for board-mad. When defaults match baseline the
// version is the package-declared string (so existing cache rows remain
// valid); when defaults differ, a `+def.<8-hex>` suffix discriminates the
// cache so Recent/Live/Backtest all recompute against the new defaults on
// next access. SemVer build-metadata syntax — ignored by version comparators
// but visible to the cache discriminator.
export function boardMadDetectorVersion(defaults: DetectorDefaults): string {
  if (isBaselineDefaults(defaults)) return boardMad.version;
  const hash = createHash("sha256")
    .update(JSON.stringify(orderedDefaults(defaults)))
    .digest("hex")
    .slice(0, 8);
  return `${boardMad.version}+def.${hash}`;
}

function orderedDefaults(d: DetectorDefaults): Record<string, number> {
  return {
    freshCapSeconds: d.freshCapSeconds,
    kMadLive: d.kMadLive,
    pbpPostBufferMs: d.pbpPostBufferMs,
    pbpPreBufferMs: d.pbpPreBufferMs,
    trailingBuckets: d.trailingBuckets,
    warmupBuckets: d.warmupBuckets,
  };
}

function isBaselineDefaults(d: DetectorDefaults): boolean {
  return (
    d.kMadLive === BASELINE_DEFAULTS.kMadLive &&
    d.trailingBuckets === BASELINE_DEFAULTS.trailingBuckets &&
    d.warmupBuckets === BASELINE_DEFAULTS.warmupBuckets &&
    d.freshCapSeconds === BASELINE_DEFAULTS.freshCapSeconds &&
    d.pbpPreBufferMs === BASELINE_DEFAULTS.pbpPreBufferMs &&
    d.pbpPostBufferMs === BASELINE_DEFAULTS.pbpPostBufferMs
  );
}
