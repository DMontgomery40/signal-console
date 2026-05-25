// Off-price-print live route (phase B2, 2026-05-25).
//
// GET /v1/off-price-print/:gameId — point-event fires from Polymarket trade
// prints for one game, at the live default thresholds. No K override; the
// off-price-print detector emits per-event fires only (no per-bucket
// aggregates), so the response shape is fires-only.
//
// Thin wrapper around runDetector (services/detector-runner.ts). The runner
// owns: PBP-anchored window resolution (or scheduled fallback), data loading,
// cache identity, persistence, observation deserialization. This route only
// owns response-shape mapping.

import { CACHE_DB_PATH, GOLD_DB_PATH } from "@signal-console/db";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { runDetector } from "../services/detector-runner";

export interface OffPricePrintRoutesOptions {
  readonly goldDbPath?: string;
  readonly cacheDbPath?: string;
}

const paramSchema = z.object({ gameId: z.string().min(1) });

const paramsJsonSchema = {
  type: "object",
  required: ["gameId"],
  properties: { gameId: { type: "string", minLength: 1 } },
} as const;

const fireJsonSchema = {
  type: "object",
  required: ["bucketStart", "bucketEnd", "intensity"],
  properties: {
    bucketStart: { type: "string" },
    bucketEnd: { type: "string" },
    intensity: { type: "number" },
    sourceMarketId: { type: "string" },
  },
} as const;

const responseSchema = {
  type: "object",
  required: ["gameId", "runId", "fires"],
  properties: {
    gameId: { type: "string" },
    runId: { type: "integer" },
    fires: { type: "array", items: fireJsonSchema },
  },
} as const;

const errorResponseSchema = {
  type: "object",
  required: ["error"],
  properties: { error: { type: "string" } },
} as const;

const offPricePrintRoutes: FastifyPluginAsync<OffPricePrintRoutesOptions> = (app, opts) => {
  const goldDbPath = opts.goldDbPath ?? GOLD_DB_PATH;
  const cacheDbPath = opts.cacheDbPath ?? CACHE_DB_PATH;

  app.get(
    "/v1/off-price-print/:gameId",
    {
      schema: {
        tags: ["desk-stable"],
        summary: "Off-price-print point-event fires for one game (Polymarket only)",
        description:
          "Returns Polymarket trade-print fires that cross the live default minVolumeShare and minOffPriceDistance thresholds. Cache-backed by per-game source watermark hash (includes the causal off-price-distance subquery's upstream quote_ticks state). Off-price-print emits point events only — no per-bucket aggregates, so this response contains fires-only.",
        params: paramsJsonSchema,
        response: {
          200: responseSchema,
          400: errorResponseSchema,
        },
      },
    },
    (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = paramSchema.safeParse(request.params);
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid params" });
        return;
      }
      // Off-price-print params: B3 will surface minVolumeShare /
      // minOffPriceDistance through detector-defaults; for now the Zod
      // defaults in OffPricePrintParams (0.1 / 0.4) apply.
      const result = runDetector({
        detectorId: "off-price-print",
        params: {},
        scope: { kind: "game", gameId: parsed.data.gameId },
        goldDbPath,
        cacheDbPath,
      });
      reply.send({
        gameId: parsed.data.gameId,
        runId: result.runId,
        fires: result.fires.map((f) => ({
          bucketStart: f.bucketStart.toISOString(),
          bucketEnd: f.bucketEnd.toISOString(),
          intensity: f.intensity,
          ...(f.sourceMarketId === undefined ? {} : { sourceMarketId: f.sourceMarketId }),
        })),
      });
    },
  );

  return Promise.resolve();
};

export default offPricePrintRoutes;
