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
// version is the package detector version — pre-existing cache rows stay valid.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { detector as boardMad } from "@signal-console/detectors/board-mad";
import {
  BOARD_MAD_BASELINE_MODE_DEFAULT,
  BOARD_MAD_BASELINE_MODE_HISTORICAL_BLEND,
  BOARD_MAD_BASELINE_MODE_OPENING_RAMP,
  BOARD_MAD_BASELINE_MODE_TRAILING,
  BOARD_MAD_BUCKET_SECONDS_DEFAULT,
  BOARD_MAD_BUCKET_SECONDS_MAX,
  BOARD_MAD_BUCKET_SECONDS_MIN,
  BOARD_MAD_FRESH_CAP_SECONDS_DEFAULT,
  BOARD_MAD_FRESH_CAP_SECONDS_MAX,
  BOARD_MAD_FRESH_CAP_SECONDS_MIN,
  BOARD_MAD_HISTORICAL_AWAY_WEIGHT_DEFAULT,
  BOARD_MAD_HISTORICAL_AWAY_WEIGHT_MAX,
  BOARD_MAD_HISTORICAL_AWAY_WEIGHT_MIN,
  BOARD_MAD_HISTORICAL_LAST_GAMES_DEFAULT,
  BOARD_MAD_HISTORICAL_LAST_GAMES_MAX,
  BOARD_MAD_HISTORICAL_LAST_GAMES_MIN,
  BOARD_MAD_HISTORICAL_PRIOR_WEIGHT_DEFAULT,
  BOARD_MAD_HISTORICAL_PRIOR_WEIGHT_MAX,
  BOARD_MAD_HISTORICAL_PRIOR_WEIGHT_MIN,
  BOARD_MAD_HISTORICAL_RAMP_COMPLETE_GAME_MINUTES_DEFAULT,
  BOARD_MAD_HISTORICAL_RAMP_COMPLETE_GAME_MINUTES_MAX,
  BOARD_MAD_HISTORICAL_RAMP_COMPLETE_GAME_MINUTES_MIN,
  BOARD_MAD_K_MAD_MAX,
  BOARD_MAD_K_MAD_MIN,
  BOARD_MAD_OPENING_BASELINE_BUCKETS_DEFAULT,
  BOARD_MAD_OPENING_BASELINE_BUCKETS_MAX,
  BOARD_MAD_OPENING_BASELINE_BUCKETS_MIN,
  BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_DEFAULT,
  BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_MAX,
  BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_MIN,
  BOARD_MAD_RECENT_WALL_MINUTES_DEFAULT,
  BOARD_MAD_RECENT_WALL_MINUTES_MAX,
  BOARD_MAD_RECENT_WALL_MINUTES_MIN,
  BOARD_MAD_RECENT_WALL_WEIGHT_DEFAULT,
  BOARD_MAD_RECENT_WALL_WEIGHT_MAX,
  BOARD_MAD_RECENT_WALL_WEIGHT_MIN,
  BOARD_MAD_TRAILING_BUCKETS_DEFAULT,
  BOARD_MAD_TRAILING_BUCKETS_MAX,
  BOARD_MAD_TRAILING_BUCKETS_MIN,
  BOARD_MAD_TRAILING_GAME_MINUTES_DEFAULT,
  BOARD_MAD_TRAILING_GAME_MINUTES_MAX,
  BOARD_MAD_TRAILING_GAME_MINUTES_MIN,
  BOARD_MAD_WARMUP_BUCKETS_DEFAULT,
  BOARD_MAD_WARMUP_BUCKETS_MAX,
  BOARD_MAD_WARMUP_BUCKETS_MIN,
  K_MAD_LIVE,
} from "@signal-console/detectors/board-mad/config";
import { z } from "zod";

export const DETECTOR_DEFAULTS_PATH: string = join(
  homedir(),
  "signal-console",
  "data",
  "detector-defaults.json",
);

export const PBP_PRE_BUFFER_MS_DEFAULT = 5 * 60 * 1000;
export const PBP_POST_BUFFER_MS_DEFAULT = 60_000;

export const DetectorDefaultsSchema = z
  .object({
    kMadLive: z.number().min(BOARD_MAD_K_MAD_MIN).max(BOARD_MAD_K_MAD_MAX).default(K_MAD_LIVE),
    bucketSeconds: z
      .number()
      .int()
      .min(BOARD_MAD_BUCKET_SECONDS_MIN)
      .max(BOARD_MAD_BUCKET_SECONDS_MAX)
      .default(BOARD_MAD_BUCKET_SECONDS_DEFAULT),
    baselineMode: z
      .enum([
        BOARD_MAD_BASELINE_MODE_TRAILING,
        BOARD_MAD_BASELINE_MODE_OPENING_RAMP,
        BOARD_MAD_BASELINE_MODE_HISTORICAL_BLEND,
      ])
      .default(BOARD_MAD_BASELINE_MODE_DEFAULT),
    openingBaselineBuckets: z
      .number()
      .int()
      .min(BOARD_MAD_OPENING_BASELINE_BUCKETS_MIN)
      .max(BOARD_MAD_OPENING_BASELINE_BUCKETS_MAX)
      .default(BOARD_MAD_OPENING_BASELINE_BUCKETS_DEFAULT),
    openingRampCompleteBuckets: z
      .number()
      .int()
      .min(BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_MIN)
      .max(BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_MAX)
      .default(BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_DEFAULT),
    trailingBuckets: z
      .number()
      .int()
      .min(BOARD_MAD_TRAILING_BUCKETS_MIN)
      .max(BOARD_MAD_TRAILING_BUCKETS_MAX)
      .default(BOARD_MAD_TRAILING_BUCKETS_DEFAULT),
    warmupBuckets: z
      .number()
      .int()
      .min(BOARD_MAD_WARMUP_BUCKETS_MIN)
      .max(BOARD_MAD_WARMUP_BUCKETS_MAX)
      .default(BOARD_MAD_WARMUP_BUCKETS_DEFAULT),
    freshCapSeconds: z
      .number()
      .int()
      .min(BOARD_MAD_FRESH_CAP_SECONDS_MIN)
      .max(BOARD_MAD_FRESH_CAP_SECONDS_MAX)
      .default(BOARD_MAD_FRESH_CAP_SECONDS_DEFAULT),
    historicalLastGames: z
      .number()
      .int()
      .min(BOARD_MAD_HISTORICAL_LAST_GAMES_MIN)
      .max(BOARD_MAD_HISTORICAL_LAST_GAMES_MAX)
      .default(BOARD_MAD_HISTORICAL_LAST_GAMES_DEFAULT),
    historicalAwayWeight: z
      .number()
      .min(BOARD_MAD_HISTORICAL_AWAY_WEIGHT_MIN)
      .max(BOARD_MAD_HISTORICAL_AWAY_WEIGHT_MAX)
      .default(BOARD_MAD_HISTORICAL_AWAY_WEIGHT_DEFAULT),
    historicalPriorWeight: z
      .number()
      .min(BOARD_MAD_HISTORICAL_PRIOR_WEIGHT_MIN)
      .max(BOARD_MAD_HISTORICAL_PRIOR_WEIGHT_MAX)
      .default(BOARD_MAD_HISTORICAL_PRIOR_WEIGHT_DEFAULT),
    historicalRampCompleteGameMinutes: z
      .number()
      .min(BOARD_MAD_HISTORICAL_RAMP_COMPLETE_GAME_MINUTES_MIN)
      .max(BOARD_MAD_HISTORICAL_RAMP_COMPLETE_GAME_MINUTES_MAX)
      .default(BOARD_MAD_HISTORICAL_RAMP_COMPLETE_GAME_MINUTES_DEFAULT),
    trailingGameMinutes: z
      .number()
      .min(BOARD_MAD_TRAILING_GAME_MINUTES_MIN)
      .max(BOARD_MAD_TRAILING_GAME_MINUTES_MAX)
      .default(BOARD_MAD_TRAILING_GAME_MINUTES_DEFAULT),
    recentWallMinutes: z
      .number()
      .min(BOARD_MAD_RECENT_WALL_MINUTES_MIN)
      .max(BOARD_MAD_RECENT_WALL_MINUTES_MAX)
      .default(BOARD_MAD_RECENT_WALL_MINUTES_DEFAULT),
    recentWallWeight: z
      .number()
      .min(BOARD_MAD_RECENT_WALL_WEIGHT_MIN)
      .max(BOARD_MAD_RECENT_WALL_WEIGHT_MAX)
      .default(BOARD_MAD_RECENT_WALL_WEIGHT_DEFAULT),
    pbpPreBufferMs: z.number().int().min(60_000).max(3_600_000).default(PBP_PRE_BUFFER_MS_DEFAULT),
    pbpPostBufferMs: z.number().int().min(10_000).max(600_000).default(PBP_POST_BUFFER_MS_DEFAULT),
  })
  .strict();

export type DetectorDefaults = z.infer<typeof DetectorDefaultsSchema>;

export const BASELINE_DEFAULTS: DetectorDefaults = DetectorDefaultsSchema.parse({});

export const ScheduledDetectorDefaultsSchema = z
  .object({
    effectiveAt: z.string().datetime(),
    defaults: DetectorDefaultsSchema,
  })
  .strict();

export type ScheduledDetectorDefaults = z.infer<typeof ScheduledDetectorDefaultsSchema>;

const TTL_MS = 5_000;

interface CacheEntry {
  readonly defaults: DetectorDefaults;
  readonly readAt: number;
}

let cache: CacheEntry | null = null;
let activePath: string = DETECTOR_DEFAULTS_PATH;

function schedulePathFor(path: string): string {
  return `${path}.scheduled.json`;
}

function writeJsonAtomic(path: string, value: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp.${String(process.pid)}.${String(Date.now())}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

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

function applyDueScheduledDefaults(path: string, now: number): DetectorDefaults | null {
  const schedulePath = schedulePathFor(path);
  let raw: string;
  try {
    raw = readFileSync(schedulePath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = ScheduledDetectorDefaultsSchema.safeParse(parsed);
  if (!result.success) return null;
  const effectiveMs = Date.parse(result.data.effectiveAt);
  if (!Number.isFinite(effectiveMs) || effectiveMs > now) return null;
  writeJsonAtomic(path, result.data.defaults);
  try {
    unlinkSync(schedulePath);
  } catch {
    // The defaults were already promoted; a stale schedule file is harmless and
    // will be overwritten by the next schedule request.
  }
  return result.data.defaults;
}

// Read the current defaults, honoring the 5 s TTL. The active path may be
// changed by setDetectorDefaultsPath() for tests; callers that don't override
// it use ~/signal-console/data/detector-defaults.json.
export function readDetectorDefaults(now: number = Date.now()): DetectorDefaults {
  if (cache !== null && now - cache.readAt < TTL_MS) {
    return cache.defaults;
  }
  const defaults = applyDueScheduledDefaults(activePath, now) ?? readFromDisk(activePath);
  cache = { defaults, readAt: now };
  return defaults;
}

// Atomic write: serialize → write .tmp → rename. SHARED FS rename is atomic
// on POSIX (single inode swap). Cache is invalidated immediately so the next
// readDetectorDefaults() call sees the new value without waiting on the TTL.
export function writeDetectorDefaults(next: unknown): DetectorDefaults {
  const validated = DetectorDefaultsSchema.parse(next);
  writeJsonAtomic(activePath, validated);
  cache = { defaults: validated, readAt: Date.now() };
  return validated;
}

export function scheduleDetectorDefaults(
  next: unknown,
  effectiveAt: string,
): ScheduledDetectorDefaults {
  const scheduled = ScheduledDetectorDefaultsSchema.parse({
    defaults: DetectorDefaultsSchema.parse(next),
    effectiveAt,
  });
  writeJsonAtomic(schedulePathFor(activePath), scheduled);
  cache = null;
  return scheduled;
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

function orderedDefaults(d: DetectorDefaults): Record<string, number | string> {
  return {
    baselineMode: d.baselineMode,
    bucketSeconds: d.bucketSeconds,
    freshCapSeconds: d.freshCapSeconds,
    historicalAwayWeight: d.historicalAwayWeight,
    historicalLastGames: d.historicalLastGames,
    historicalPriorWeight: d.historicalPriorWeight,
    historicalRampCompleteGameMinutes: d.historicalRampCompleteGameMinutes,
    kMadLive: d.kMadLive,
    openingBaselineBuckets: d.openingBaselineBuckets,
    openingRampCompleteBuckets: d.openingRampCompleteBuckets,
    pbpPostBufferMs: d.pbpPostBufferMs,
    pbpPreBufferMs: d.pbpPreBufferMs,
    recentWallMinutes: d.recentWallMinutes,
    recentWallWeight: d.recentWallWeight,
    trailingGameMinutes: d.trailingGameMinutes,
    trailingBuckets: d.trailingBuckets,
    warmupBuckets: d.warmupBuckets,
  };
}

function isBaselineDefaults(d: DetectorDefaults): boolean {
  return (
    d.kMadLive === BASELINE_DEFAULTS.kMadLive &&
    d.baselineMode === BASELINE_DEFAULTS.baselineMode &&
    d.bucketSeconds === BASELINE_DEFAULTS.bucketSeconds &&
    d.openingBaselineBuckets === BASELINE_DEFAULTS.openingBaselineBuckets &&
    d.openingRampCompleteBuckets === BASELINE_DEFAULTS.openingRampCompleteBuckets &&
    d.trailingBuckets === BASELINE_DEFAULTS.trailingBuckets &&
    d.warmupBuckets === BASELINE_DEFAULTS.warmupBuckets &&
    d.freshCapSeconds === BASELINE_DEFAULTS.freshCapSeconds &&
    d.historicalLastGames === BASELINE_DEFAULTS.historicalLastGames &&
    d.historicalAwayWeight === BASELINE_DEFAULTS.historicalAwayWeight &&
    d.historicalPriorWeight === BASELINE_DEFAULTS.historicalPriorWeight &&
    d.historicalRampCompleteGameMinutes === BASELINE_DEFAULTS.historicalRampCompleteGameMinutes &&
    d.trailingGameMinutes === BASELINE_DEFAULTS.trailingGameMinutes &&
    d.recentWallMinutes === BASELINE_DEFAULTS.recentWallMinutes &&
    d.recentWallWeight === BASELINE_DEFAULTS.recentWallWeight &&
    d.pbpPreBufferMs === BASELINE_DEFAULTS.pbpPreBufferMs &&
    d.pbpPostBufferMs === BASELINE_DEFAULTS.pbpPostBufferMs
  );
}
