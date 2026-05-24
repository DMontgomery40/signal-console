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
import type { FastifyPluginAsync } from "fastify";

import {
  DetectorDefaultsSchema,
  writeDetectorDefaults,
  type DetectorDefaults,
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
  required: ["db", "cacheDb", "sources", "errors", "about"],
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
        "trailingBuckets",
        "warmupBuckets",
        "freshCapSeconds",
        "pbpPreBufferMs",
        "pbpPostBufferMs",
      ],
      properties: {
        kMadLive: { type: "number" },
        trailingBuckets: { type: "integer" },
        warmupBuckets: { type: "integer" },
        freshCapSeconds: { type: "integer" },
        pbpPreBufferMs: { type: "integer" },
        pbpPostBufferMs: { type: "integer" },
      },
      additionalProperties: false,
    },
  },
} as const;

const detectorDefaultsResponseSchema = {
  type: "object",
  required: [
    "kMadLive",
    "trailingBuckets",
    "warmupBuckets",
    "freshCapSeconds",
    "pbpPreBufferMs",
    "pbpPostBufferMs",
  ],
  properties: {
    kMadLive: { type: "number" },
    trailingBuckets: { type: "integer" },
    warmupBuckets: { type: "integer" },
    freshCapSeconds: { type: "integer" },
    pbpPreBufferMs: { type: "integer" },
    pbpPostBufferMs: { type: "integer" },
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

  return Promise.resolve();
};

export default settingsRoutes;
