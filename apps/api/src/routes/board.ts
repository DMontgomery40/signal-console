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
import { getFanout } from "../services/fanout";

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

  const fanoutQuerySchema = z.object({ bucket_start: z.string().min(1) });
  const fanoutQueryJsonSchema = {
    type: "object",
    required: ["bucket_start"],
    properties: { bucket_start: { type: "string", minLength: 1 } },
  } as const;
  const fanoutPbpJsonSchema = {
    type: "object",
    required: [
      "timeActual",
      "actionType",
      "playerName",
      "description",
      "deltaSecondsFromFire",
      "deltaSecondsFromAlert",
      "period",
      "clock",
    ],
    properties: {
      timeActual: { type: "string" },
      actionType: { type: ["string", "null"] },
      playerName: { type: ["string", "null"] },
      description: { type: ["string", "null"] },
      deltaSecondsFromFire: { type: "number" },
      // Signed against bucket_end (alert confirmation). Negative = play
      // happened before alert (system reacted N seconds after the play).
      deltaSecondsFromAlert: { type: "number" },
      // NBA period (1-4 = quarters, 5+ = overtimes).
      period: { type: ["integer", "null"] },
      // ISO 8601 duration ("PT08M19.00S") for game-clock display ("Q3 8:19").
      clock: { type: ["string", "null"] },
    },
  } as const;
  const fanoutMoverJsonSchema = {
    type: "object",
    required: [
      "sourceMarketId",
      "instrument",
      "ipBefore",
      "ipAfter",
      "ipDelta",
      "contributionPct",
      "deltaSecondsFromFire",
    ],
    properties: {
      sourceMarketId: { type: "string" },
      instrument: { type: "string" },
      ipBefore: { type: ["number", "null"] },
      ipAfter: { type: ["number", "null"] },
      ipDelta: { type: ["number", "null"] },
      contributionPct: { type: "number" },
      deltaSecondsFromFire: { type: "number" },
    },
  } as const;
  const fanoutResponseSchema = {
    type: "object",
    required: ["bucketStart", "bucketEnd", "pbp", "movers", "narrative"],
    properties: {
      bucketStart: { type: "string" },
      bucketEnd: { type: "string" },
      pbp: { type: "array", items: fanoutPbpJsonSchema },
      movers: { type: "array", items: fanoutMoverJsonSchema },
      narrative: { type: "string" },
    },
  } as const;

  app.get(
    "/v1/board/:gameId/fanout",
    {
      schema: {
        tags: ["desk-stable"],
        summary: "PBP + top market movers within ±5 min of one fired bucket",
        description:
          "Strict ±5 min PBP window (the owner's research cap; >5 min is worthless) plus top movers ranked by the detector's intensity decomposition (Σ log(1+v)·|Δp| with freshCapSeconds=300 sanitation) over the 60-second bucket window. Returns a templated one-line narrative tying anchor event to top mover.",
        params: paramsJsonSchema,
        querystring: fanoutQueryJsonSchema,
        response: {
          200: fanoutResponseSchema,
          400: errorResponseSchema,
        },
      },
    },
    (request: FastifyRequest, reply: FastifyReply) => {
      const parsedParams = paramSchema.safeParse(request.params);
      if (!parsedParams.success) {
        reply.code(400).send({ error: "invalid params" });
        return;
      }
      const parsedQuery = fanoutQuerySchema.safeParse(request.query);
      if (!parsedQuery.success) {
        reply.code(400).send({ error: "invalid query" });
        return;
      }
      if (!Number.isFinite(Date.parse(parsedQuery.data.bucket_start))) {
        reply.code(400).send({ error: "invalid bucket_start" });
        return;
      }
      const result = getFanout({
        goldDbPath,
        gameId: parsedParams.data.gameId,
        bucketStart: parsedQuery.data.bucket_start,
      });
      reply.send(result);
    },
  );

  return Promise.resolve();
};

export default boardRoutes;
