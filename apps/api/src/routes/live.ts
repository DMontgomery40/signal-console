// Live route (US-028 / PRD §FR-20, §15).
//
// GET /v1/live/:gameId — last 5 minutes of quote_ticks for one game,
// joined to source_markets for instrument metadata.
//
// Live is raw ticks only — detector fires layer in via the separate
// /v1/board/:gameId call. No baseline-rebuild table is read by this
// route; the US-028 grep guard pins that.

import { GOLD_DB_PATH } from "@signal-console/db";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { getLive } from "../services/live";
import { parseStrictIsoTimestamp } from "../services/timestamps";

export interface LiveRoutesOptions {
  readonly goldDbPath?: string;
}

const paramSchema = z.object({ gameId: z.string().min(1) });
const querySchema = z.object({ at: z.string().optional() });

const paramsJsonSchema = {
  type: "object",
  required: ["gameId"],
  properties: { gameId: { type: "string", minLength: 1 } },
} as const;

const queryJsonSchema = {
  type: "object",
  properties: {
    at: {
      type: "string",
      description:
        "Optional ISO timestamp with timezone. When set, returns the five-minute live tick window ending at this historical instant.",
    },
  },
  additionalProperties: false,
} as const;

const tickJsonSchema = {
  type: "object",
  required: [
    "sourceMarketId",
    "source",
    "capturedAt",
    "impliedProbability",
    "volume",
    "isHeartbeat",
    "instrumentId",
    "rawFamily",
    "rawLabel",
  ],
  properties: {
    sourceMarketId: { type: "string" },
    source: { type: "string" },
    capturedAt: { type: "string" },
    impliedProbability: { type: ["number", "null"] },
    volume: { type: "number" },
    isHeartbeat: { type: "integer" },
    instrumentId: { type: ["string", "null"] },
    rawFamily: { type: ["string", "null"] },
    rawLabel: { type: ["string", "null"] },
  },
} as const;

const responseSchema = {
  type: "object",
  required: ["gameId", "windowStart", "windowEnd", "ticks"],
  properties: {
    gameId: { type: "string" },
    windowStart: { type: "string" },
    windowEnd: { type: "string" },
    ticks: { type: "array", items: tickJsonSchema },
  },
} as const;

const errorResponseSchema = {
  type: "object",
  required: ["error"],
  properties: { error: { type: "string" } },
} as const;

const liveRoutes: FastifyPluginAsync<LiveRoutesOptions> = (app, opts) => {
  const goldDbPath = opts.goldDbPath ?? GOLD_DB_PATH;

  app.get(
    "/v1/live/:gameId",
    {
      schema: {
        tags: ["desk-stable"],
        summary: "Last 5 minutes of quote_ticks for one game",
        description:
          "Returns ticks captured within the last 5 minutes for the given game, joined to source_markets for instrument metadata. Bounded by the quote_ticks (source_market_id, captured_at) index.",
        params: paramsJsonSchema,
        querystring: queryJsonSchema,
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
      const parsedQuery = querySchema.safeParse(request.query);
      if (!parsedQuery.success) {
        reply.code(400).send({ error: "invalid query" });
        return;
      }
      const at = parsedQuery.data.at;
      const atMs =
        at === undefined ? null : parseStrictIsoTimestamp(at, { requireExplicitTimezone: true });
      if (at !== undefined && atMs === null) {
        reply.code(400).send({ error: "invalid at timestamp" });
        return;
      }
      const result = getLive({
        goldDbPath,
        gameId: parsed.data.gameId,
        ...(atMs === null ? {} : { now: new Date(atMs) }),
      });
      reply.send(result);
    },
  );

  return Promise.resolve();
};

export default liveRoutes;
