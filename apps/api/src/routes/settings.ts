// Settings route (US-019, PRD §20).
//
// GET /v1/settings — single-call payload for the Settings UI: gold DB info
// (PRAGMA + fs only, no scans), cache DB info, ingest sources (or
// ingestPaused), errors tail, about block. Tagged 'internal' in /openapi.json.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CACHE_DB_PATH, GOLD_DB_PATH } from "@signal-console/db";
import {
  BOARD_MAD_BASELINE_MODE_HISTORICAL_BLEND,
  BOARD_MAD_BASELINE_MODE_OPENING_RAMP,
  BOARD_MAD_BASELINE_MODE_TRAILING,
  BOARD_MAD_BUCKET_SECONDS_MAX,
  BOARD_MAD_BUCKET_SECONDS_MIN,
  BOARD_MAD_FRESH_CAP_SECONDS_MAX,
  BOARD_MAD_FRESH_CAP_SECONDS_MIN,
  BOARD_MAD_HISTORICAL_AWAY_WEIGHT_MAX,
  BOARD_MAD_HISTORICAL_AWAY_WEIGHT_MIN,
  BOARD_MAD_HISTORICAL_LAST_GAMES_MAX,
  BOARD_MAD_HISTORICAL_LAST_GAMES_MIN,
  BOARD_MAD_HISTORICAL_PRIOR_WEIGHT_MAX,
  BOARD_MAD_HISTORICAL_PRIOR_WEIGHT_MIN,
  BOARD_MAD_HISTORICAL_RAMP_COMPLETE_GAME_MINUTES_MAX,
  BOARD_MAD_HISTORICAL_RAMP_COMPLETE_GAME_MINUTES_MIN,
  BOARD_MAD_K_MAD_MAX,
  BOARD_MAD_K_MAD_MIN,
  BOARD_MAD_OPENING_BASELINE_BUCKETS_MAX,
  BOARD_MAD_OPENING_BASELINE_BUCKETS_MIN,
  BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_MAX,
  BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_MIN,
  BOARD_MAD_RECENT_WALL_MINUTES_MAX,
  BOARD_MAD_RECENT_WALL_MINUTES_MIN,
  BOARD_MAD_RECENT_WALL_WEIGHT_MAX,
  BOARD_MAD_RECENT_WALL_WEIGHT_MIN,
  BOARD_MAD_TRAILING_BUCKETS_MAX,
  BOARD_MAD_TRAILING_BUCKETS_MIN,
  BOARD_MAD_TRAILING_GAME_MINUTES_MAX,
  BOARD_MAD_TRAILING_GAME_MINUTES_MIN,
  BOARD_MAD_WARMUP_BUCKETS_MAX,
  BOARD_MAD_WARMUP_BUCKETS_MIN,
} from "@signal-console/detectors/board-mad/config";
import type { FastifyPluginAsync } from "fastify";

import {
  DetectorDefaultsSchema,
  scheduleDetectorDefaults,
  writeDetectorDefaults,
  type DetectorDefaults,
  type ScheduledDetectorDefaults,
} from "../services/detector-defaults";
import { readSettings, type SettingsResponse } from "../services/settings";

export interface SettingsRoutesOptions {
  readonly goldDbPath?: string;
  readonly cacheDbPath?: string;
  readonly heartbeatPath?: string;
  readonly logPath?: string;
  readonly appVersion?: string;
  readonly maxErrors?: number;
}

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/api/src/routes/settings.ts → apps/api/package.json
const DEFAULT_PACKAGE_JSON = resolve(HERE, "..", "..", "package.json");

const DEFAULT_HEARTBEAT_PATH = join(
  homedir(),
  "signal-console",
  "apps",
  "worker",
  "data",
  "heartbeat.json",
);

const DEFAULT_LOG_PATH = join(homedir(), "signal-console", "apps", "api", "data", "api.log");

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function readDefaultAppVersion(): string {
  try {
    const raw: unknown = JSON.parse(readFileSync(DEFAULT_PACKAGE_JSON, "utf8"));
    if (isRecord(raw) && typeof raw["version"] === "string") return raw["version"];
    return "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const sourceRowSchema = {
  type: "object",
  required: ["lastSyncAt", "lastError", "rateLimitCooldown"],
  properties: {
    lastSyncAt: { type: ["string", "null"] },
    lastError: { type: ["string", "null"] },
    rateLimitCooldown: { type: ["string", "null"] },
  },
  additionalProperties: false,
} as const;

const sourcesSchema = {
  oneOf: [
    {
      type: "object",
      required: ["ingestPaused", "bySource"],
      properties: {
        ingestPaused: { type: "boolean", enum: [false] },
        bySource: {
          type: "object",
          additionalProperties: sourceRowSchema,
        },
      },
      additionalProperties: false,
    },
    {
      type: "object",
      required: ["ingestPaused", "lastKnown"],
      properties: {
        ingestPaused: { type: "boolean", enum: [true] },
        lastKnown: {
          type: "object",
          additionalProperties: sourceRowSchema,
        },
      },
      additionalProperties: false,
    },
  ],
} as const;

const responseSchema = {
  type: "object",
  required: ["db", "cacheDb", "sources", "errors", "about", "detectorDefaults"],
  properties: {
    db: {
      type: "object",
      required: ["path", "sizeBytes", "walBytes", "pageCount", "pageSize", "lastModified", "mode"],
      properties: {
        path: { type: "string" },
        sizeBytes: { type: "integer" },
        walBytes: { type: "integer" },
        pageCount: { type: "integer" },
        pageSize: { type: "integer" },
        lastModified: { type: "string" },
        mode: { type: "string", enum: ["read-only", "error"] },
        openError: { type: "string" },
      },
    },
    cacheDb: {
      type: "object",
      required: ["path", "sizeBytes", "pageCount"],
      properties: {
        path: { type: "string" },
        sizeBytes: { type: "integer" },
        pageCount: { type: "integer" },
      },
    },
    sources: sourcesSchema,
    errors: {
      type: "array",
      items: {
        type: "object",
        required: ["level", "message", "time"],
        properties: {
          level: { type: "string" },
          message: { type: "string" },
          time: { type: ["string", "null"] },
        },
      },
    },
    about: {
      type: "object",
      required: ["appVersion", "detectorVersions", "dbSchemaVersion"],
      properties: {
        appVersion: { type: "string" },
        detectorVersions: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "version"],
            properties: {
              id: { type: "string" },
              version: { type: "string" },
            },
          },
        },
        dbSchemaVersion: { type: "integer" },
      },
    },
    detectorDefaults: {
      type: "object",
      required: [
        "kMadLive",
        "baselineMode",
        "bucketSeconds",
        "openingBaselineBuckets",
        "openingRampCompleteBuckets",
        "trailingBuckets",
        "warmupBuckets",
        "freshCapSeconds",
        "historicalLastGames",
        "historicalAwayWeight",
        "historicalPriorWeight",
        "historicalRampCompleteGameMinutes",
        "trailingGameMinutes",
        "recentWallMinutes",
        "recentWallWeight",
        "pbpPreBufferMs",
        "pbpPostBufferMs",
        "offPriceMinVolumeShare",
        "offPriceMinOffPriceDistance",
      ],
      properties: {
        kMadLive: {
          type: "number",
          minimum: BOARD_MAD_K_MAD_MIN,
          maximum: BOARD_MAD_K_MAD_MAX,
        },
        baselineMode: {
          type: "string",
          enum: [
            BOARD_MAD_BASELINE_MODE_TRAILING,
            BOARD_MAD_BASELINE_MODE_OPENING_RAMP,
            BOARD_MAD_BASELINE_MODE_HISTORICAL_BLEND,
          ],
        },
        bucketSeconds: {
          type: "integer",
          minimum: BOARD_MAD_BUCKET_SECONDS_MIN,
          maximum: BOARD_MAD_BUCKET_SECONDS_MAX,
        },
        openingBaselineBuckets: {
          type: "integer",
          minimum: BOARD_MAD_OPENING_BASELINE_BUCKETS_MIN,
          maximum: BOARD_MAD_OPENING_BASELINE_BUCKETS_MAX,
        },
        openingRampCompleteBuckets: {
          type: "integer",
          minimum: BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_MIN,
          maximum: BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_MAX,
        },
        trailingBuckets: {
          type: "integer",
          minimum: BOARD_MAD_TRAILING_BUCKETS_MIN,
          maximum: BOARD_MAD_TRAILING_BUCKETS_MAX,
        },
        warmupBuckets: {
          type: "integer",
          minimum: BOARD_MAD_WARMUP_BUCKETS_MIN,
          maximum: BOARD_MAD_WARMUP_BUCKETS_MAX,
        },
        freshCapSeconds: {
          type: "integer",
          minimum: BOARD_MAD_FRESH_CAP_SECONDS_MIN,
          maximum: BOARD_MAD_FRESH_CAP_SECONDS_MAX,
        },
        historicalLastGames: {
          type: "integer",
          minimum: BOARD_MAD_HISTORICAL_LAST_GAMES_MIN,
          maximum: BOARD_MAD_HISTORICAL_LAST_GAMES_MAX,
        },
        historicalAwayWeight: {
          type: "number",
          minimum: BOARD_MAD_HISTORICAL_AWAY_WEIGHT_MIN,
          maximum: BOARD_MAD_HISTORICAL_AWAY_WEIGHT_MAX,
        },
        historicalPriorWeight: {
          type: "number",
          minimum: BOARD_MAD_HISTORICAL_PRIOR_WEIGHT_MIN,
          maximum: BOARD_MAD_HISTORICAL_PRIOR_WEIGHT_MAX,
        },
        historicalRampCompleteGameMinutes: {
          type: "number",
          minimum: BOARD_MAD_HISTORICAL_RAMP_COMPLETE_GAME_MINUTES_MIN,
          maximum: BOARD_MAD_HISTORICAL_RAMP_COMPLETE_GAME_MINUTES_MAX,
        },
        trailingGameMinutes: {
          type: "number",
          minimum: BOARD_MAD_TRAILING_GAME_MINUTES_MIN,
          maximum: BOARD_MAD_TRAILING_GAME_MINUTES_MAX,
        },
        recentWallMinutes: {
          type: "number",
          minimum: BOARD_MAD_RECENT_WALL_MINUTES_MIN,
          maximum: BOARD_MAD_RECENT_WALL_MINUTES_MAX,
        },
        recentWallWeight: {
          type: "number",
          minimum: BOARD_MAD_RECENT_WALL_WEIGHT_MIN,
          maximum: BOARD_MAD_RECENT_WALL_WEIGHT_MAX,
        },
        pbpPreBufferMs: { type: "integer" },
        pbpPostBufferMs: { type: "integer" },
        // Phase B3: off-price-print thresholds, runtime-tunable.
        offPriceMinVolumeShare: { type: "number", minimum: 0, maximum: 1 },
        offPriceMinOffPriceDistance: { type: "number", minimum: 0, maximum: 1 },
      },
      additionalProperties: false,
    },
  },
} as const;

const detectorDefaultsResponseSchema = {
  type: "object",
  required: [
    "kMadLive",
    "baselineMode",
    "bucketSeconds",
    "openingBaselineBuckets",
    "openingRampCompleteBuckets",
    "trailingBuckets",
    "warmupBuckets",
    "freshCapSeconds",
    "historicalLastGames",
    "historicalAwayWeight",
    "historicalPriorWeight",
    "historicalRampCompleteGameMinutes",
    "trailingGameMinutes",
    "recentWallMinutes",
    "recentWallWeight",
    "pbpPreBufferMs",
    "pbpPostBufferMs",
    "offPriceMinVolumeShare",
    "offPriceMinOffPriceDistance",
  ],
  properties: {
    kMadLive: {
      type: "number",
      minimum: BOARD_MAD_K_MAD_MIN,
      maximum: BOARD_MAD_K_MAD_MAX,
    },
    baselineMode: {
      type: "string",
      enum: [
        BOARD_MAD_BASELINE_MODE_TRAILING,
        BOARD_MAD_BASELINE_MODE_OPENING_RAMP,
        BOARD_MAD_BASELINE_MODE_HISTORICAL_BLEND,
      ],
    },
    bucketSeconds: {
      type: "integer",
      minimum: BOARD_MAD_BUCKET_SECONDS_MIN,
      maximum: BOARD_MAD_BUCKET_SECONDS_MAX,
    },
    openingBaselineBuckets: {
      type: "integer",
      minimum: BOARD_MAD_OPENING_BASELINE_BUCKETS_MIN,
      maximum: BOARD_MAD_OPENING_BASELINE_BUCKETS_MAX,
    },
    openingRampCompleteBuckets: {
      type: "integer",
      minimum: BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_MIN,
      maximum: BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_MAX,
    },
    trailingBuckets: {
      type: "integer",
      minimum: BOARD_MAD_TRAILING_BUCKETS_MIN,
      maximum: BOARD_MAD_TRAILING_BUCKETS_MAX,
    },
    warmupBuckets: {
      type: "integer",
      minimum: BOARD_MAD_WARMUP_BUCKETS_MIN,
      maximum: BOARD_MAD_WARMUP_BUCKETS_MAX,
    },
    freshCapSeconds: {
      type: "integer",
      minimum: BOARD_MAD_FRESH_CAP_SECONDS_MIN,
      maximum: BOARD_MAD_FRESH_CAP_SECONDS_MAX,
    },
    historicalLastGames: {
      type: "integer",
      minimum: BOARD_MAD_HISTORICAL_LAST_GAMES_MIN,
      maximum: BOARD_MAD_HISTORICAL_LAST_GAMES_MAX,
    },
    historicalAwayWeight: {
      type: "number",
      minimum: BOARD_MAD_HISTORICAL_AWAY_WEIGHT_MIN,
      maximum: BOARD_MAD_HISTORICAL_AWAY_WEIGHT_MAX,
    },
    historicalPriorWeight: {
      type: "number",
      minimum: BOARD_MAD_HISTORICAL_PRIOR_WEIGHT_MIN,
      maximum: BOARD_MAD_HISTORICAL_PRIOR_WEIGHT_MAX,
    },
    historicalRampCompleteGameMinutes: {
      type: "number",
      minimum: BOARD_MAD_HISTORICAL_RAMP_COMPLETE_GAME_MINUTES_MIN,
      maximum: BOARD_MAD_HISTORICAL_RAMP_COMPLETE_GAME_MINUTES_MAX,
    },
    trailingGameMinutes: {
      type: "number",
      minimum: BOARD_MAD_TRAILING_GAME_MINUTES_MIN,
      maximum: BOARD_MAD_TRAILING_GAME_MINUTES_MAX,
    },
    recentWallMinutes: {
      type: "number",
      minimum: BOARD_MAD_RECENT_WALL_MINUTES_MIN,
      maximum: BOARD_MAD_RECENT_WALL_MINUTES_MAX,
    },
    recentWallWeight: {
      type: "number",
      minimum: BOARD_MAD_RECENT_WALL_WEIGHT_MIN,
      maximum: BOARD_MAD_RECENT_WALL_WEIGHT_MAX,
    },
    pbpPreBufferMs: { type: "integer" },
    pbpPostBufferMs: { type: "integer" },
    // Phase B3: off-price-print thresholds, runtime-tunable.
    offPriceMinVolumeShare: { type: "number", minimum: 0, maximum: 1 },
    offPriceMinOffPriceDistance: { type: "number", minimum: 0, maximum: 1 },
  },
  additionalProperties: false,
} as const;

const scheduledDetectorDefaultsResponseSchema = {
  type: "object",
  required: ["effectiveAt", "defaults"],
  properties: {
    effectiveAt: { type: "string" },
    defaults: detectorDefaultsResponseSchema,
  },
  additionalProperties: false,
} as const;

const settingsRoutes: FastifyPluginAsync<SettingsRoutesOptions> = (app, opts) => {
  const goldDbPath = opts.goldDbPath ?? GOLD_DB_PATH;
  const cacheDbPath = opts.cacheDbPath ?? CACHE_DB_PATH;
  const heartbeatPath = opts.heartbeatPath ?? DEFAULT_HEARTBEAT_PATH;
  const logPath = opts.logPath ?? DEFAULT_LOG_PATH;
  const appVersion = opts.appVersion ?? readDefaultAppVersion();
  const maxErrors = opts.maxErrors;

  app.get(
    "/v1/settings",
    {
      schema: {
        tags: ["internal"],
        summary: "Settings: DB diagnostics, sources, errors, about",
        description:
          "Assembled from PRAGMA reads + fs.stat; no full scans against the gold DB. Returns ingestPaused: true when no heartbeat file is present.",
        response: { 200: responseSchema },
      },
    },
    (_request, reply) => {
      const body: SettingsResponse = readSettings({
        goldDbPath,
        cacheDbPath,
        heartbeatPath,
        logPath,
        appVersion,
        ...(maxErrors !== undefined ? { maxErrors } : {}),
      });
      reply.send(body);
    },
  );

  app.post(
    "/v1/settings/detector-defaults",
    {
      schema: {
        tags: ["internal"],
        summary: "Update detector defaults (atomic write + cache invalidate)",
        description:
          "Validates the body against the runtime-editable defaults schema, atomically writes ~/signal-console/data/detector-defaults.json (.tmp + rename), and returns the canonical resolved values. The board-mad runtime detector_version reflects the new defaults on next /v1/settings or /v1/board call so cache rows naturally invalidate.",
        response: {
          200: detectorDefaultsResponseSchema,
          400: {
            type: "object",
            required: ["error"],
            properties: {
              error: { type: "string" },
              detail: { type: "string" },
            },
          },
        },
      },
    },
    (request, reply) => {
      const parsed = DetectorDefaultsSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid_defaults", detail: parsed.error.message });
        return;
      }
      const written: DetectorDefaults = writeDetectorDefaults(parsed.data);
      reply.send(written);
    },
  );

  app.post(
    "/v1/settings/detector-defaults/schedule",
    {
      schema: {
        tags: ["internal"],
        summary: "Schedule detector defaults",
        description:
          "Validates the detector-defaults payload and writes a pending schedule file. readDetectorDefaults promotes it atomically on the first request at or after effectiveAt.",
        response: {
          200: scheduledDetectorDefaultsResponseSchema,
          400: {
            type: "object",
            required: ["error"],
            properties: {
              error: { type: "string" },
              detail: { type: "string" },
            },
          },
        },
      },
    },
    (request, reply) => {
      const body = isRecord(request.body) ? request.body : {};
      const effectiveAt = body["effectiveAt"];
      const defaults = body["defaults"];
      if (typeof effectiveAt !== "string") {
        reply.code(400).send({ error: "invalid_schedule", detail: "effectiveAt is required" });
        return;
      }
      const parsed = DetectorDefaultsSchema.safeParse(defaults);
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid_defaults", detail: parsed.error.message });
        return;
      }
      try {
        const scheduled: ScheduledDetectorDefaults = scheduleDetectorDefaults(
          parsed.data,
          effectiveAt,
        );
        reply.send(scheduled);
      } catch (error) {
        reply.code(400).send({
          error: "invalid_schedule",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  return Promise.resolve();
};

export default settingsRoutes;
