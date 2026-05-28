// Detectors route (PRD §13 / US-030).
//
// GET /v1/detectors — returns the detector registry. One row per detector:
// { id, version, displayName, paramsSchema }. The paramsSchema is a JSON
// Schema produced from the detector's Zod schema via zod-to-json-schema, so
// the UI in US-032 can auto-render parameter controls (number -> slider,
// enum -> select, etc.). Zero DB reads — the route is metadata-only.

import { registry, type RegisteredDetector } from "@signal-console/detectors";
import type { FastifyPluginAsync } from "fastify";
import { zodToJsonSchema } from "zod-to-json-schema";

import { boardMadDetectorVersion, readDetectorDefaults } from "../services/detector-defaults";

export interface DetectorsRoutesOptions {
  // Tests can inject a smaller registry without rebuilding the module graph.
  // Keys must mirror the live registry shape (id -> RegisteredDetector).
  readonly registry?: ReadonlyMap<string, RegisteredDetector>;
}

interface DetectorRow {
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly sources: readonly string[];
  readonly paramsSchema: Record<string, unknown>;
}

const detectorRowJsonSchema = {
  type: "object",
  required: ["id", "version", "displayName", "sources", "paramsSchema"],
  properties: {
    id: { type: "string" },
    version: { type: "string" },
    displayName: { type: "string" },
    // US-048: closed-set upstream sources the detector reads from. The UI
    // renders a SOURCES chip on every detector card from this field.
    sources: {
      type: "array",
      items: { type: "string", enum: ["bet365", "kalshi", "polymarket"] },
    },
    // paramsSchema is a generic JSON Schema document; leaving it open
    // (additionalProperties: true, no required) so fast-json-stringify
    // does not strip the per-detector keys (e.g. "properties", "type",
    // "required", "$schema") produced by zod-to-json-schema.
    paramsSchema: { type: "object", additionalProperties: true },
  },
} as const;

const responseSchema = {
  type: "object",
  required: ["detectors"],
  properties: {
    detectors: { type: "array", items: detectorRowJsonSchema },
  },
} as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toJsonSchemaObject(d: RegisteredDetector): Record<string, unknown> {
  const schema: unknown = zodToJsonSchema(d.paramsSchema, {
    // Inline ($refStrategy: "none") so the consuming UI does not have to
    // resolve $ref pointers; each detector's schema is small and self-contained.
    $refStrategy: "none",
  });
  return isPlainObject(schema) ? schema : {};
}

function buildRows(reg: ReadonlyMap<string, RegisteredDetector>): readonly DetectorRow[] {
  const defaults = readDetectorDefaults();
  const runtimeBoardVersion = boardMadDetectorVersion(defaults);
  return Array.from(reg.values()).map((d) => ({
    id: d.id,
    version:
      d.id === "board-mad"
        ? runtimeBoardVersion
        : d.id === "ensemble-or"
          ? `${d.version}+board=${runtimeBoardVersion}+off=${reg.get("off-price-print")?.version ?? "1.0.0"}`
          : d.version,
    displayName: d.displayName,
    sources: d.sources,
    paramsSchema: toJsonSchemaObject(d),
  }));
}

const detectorsRoutes: FastifyPluginAsync<DetectorsRoutesOptions> = (app, opts) => {
  const activeRegistry = opts.registry ?? registry;

  app.get(
    "/v1/detectors",
    {
      schema: {
        tags: ["desk-stable"],
        summary: "List registered detectors with JSON-Schema-typed params",
        description:
          "Returns the detector registry as { id, version, displayName, paramsSchema } rows. paramsSchema is a JSON Schema derived from each detector's Zod schema. No DB reads.",
        response: {
          200: responseSchema,
        },
      },
    },
    (_request, reply) => {
      reply.send({ detectors: buildRows(activeRegistry) });
    },
  );

  return Promise.resolve();
};

export default detectorsRoutes;
