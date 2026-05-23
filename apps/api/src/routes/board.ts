// Board route (US-021 / PRD §15).
//
// GET /v1/board/:gameId — board-mad fires for one game at K_MAD_LIVE.
// No K override is accepted (Backtest is the override surface).
//
// Cache semantics live in services/board.ts: per-game source watermark hash
// keys the detector_runs lookup; cache hit reads detector_observations,
// cache miss runs the detector and persists the run + observations.

import { CACHE_DB_PATH, GOLD_DB_PATH } from "@signal-console/db";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { getOrComputeBoard } from "../services/board";

export interface BoardRoutesOptions {
  readonly goldDbPath?: string;
  readonly cacheDbPath?: string;
}

const paramSchema = z.object({ gameId: z.string().min(1) });

const paramsJsonSchema = {
  type: "object",
  required: ["gameId"],
  properties: { gameId: { type: "string", minLength: 1 } },
} as const;

const observationJsonSchema = {
  type: "object",
  required: ["bucketStart", "bucketEnd", "fired", "intensity", "baselineMedian", "baselineMad"],
  properties: {
    bucketStart: { type: "string" },
    bucketEnd: { type: "string" },
    fired: { type: "integer" },
    intensity: { type: "number" },
    baselineMedian: { type: "number" },
    baselineMad: { type: "number" },
  },
} as const;

const responseSchema = {
  type: "object",
  required: ["gameId", "runId", "k", "observations"],
  properties: {
    gameId: { type: "string" },
    runId: { type: "integer" },
    k: { type: "number" },
    observations: { type: "array", items: observationJsonSchema },
  },
} as const;

const errorResponseSchema = {
  type: "object",
  required: ["error"],
  properties: { error: { type: "string" } },
} as const;

const boardRoutes: FastifyPluginAsync<BoardRoutesOptions> = (app, opts) => {
  const goldDbPath = opts.goldDbPath ?? GOLD_DB_PATH;
  const cacheDbPath = opts.cacheDbPath ?? CACHE_DB_PATH;

  app.get(
    "/v1/board/:gameId",
    {
      schema: {
        tags: ["desk-stable"],
        summary: "Board-MAD fires for one game at the live default K (K_MAD_LIVE)",
        description:
          "Returns detector_observations for board-mad at K_MAD_LIVE. Cache-backed by per-game source watermark hash; first call computes and persists, subsequent calls read the cache.",
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
      const result = getOrComputeBoard({
        goldDbPath,
        cacheDbPath,
        gameId: parsed.data.gameId,
      });
      reply.send(result);
    },
  );

  return Promise.resolve();
};

export default boardRoutes;
