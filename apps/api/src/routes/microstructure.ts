// Microstructure route (US-029 / PRD §15).
//
// GET /v1/microstructure/:gameId — market_microstructure_events for one game
// filtered by a volume_share threshold (theta, default 0.10).

import { GOLD_DB_PATH } from "@signal-console/db";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { DEFAULT_THETA, getMicrostructure } from "../services/microstructure";

export interface MicrostructureRoutesOptions {
  readonly goldDbPath?: string;
}

const paramSchema = z.object({ gameId: z.string().min(1) });

function parseRequiredQueryNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return value;
  if (typeof value !== "string") return Number.NaN;
  const trimmed = value.trim();
  if (trimmed.length === 0) return Number.NaN;
  return Number(trimmed);
}

const querySchema = z.object({
  theta: z
    .preprocess(parseRequiredQueryNumber, z.number().finite().min(0).max(1))
    .default(DEFAULT_THETA),
});

const paramsJsonSchema = {
  type: "object",
  required: ["gameId"],
  properties: { gameId: { type: "string", minLength: 1 } },
} as const;

const queryJsonSchema = {
  type: "object",
  properties: {
    theta: { type: "number", minimum: 0, maximum: 1, default: DEFAULT_THETA },
  },
} as const;

const eventJsonSchema = {
  type: "object",
  required: [
    "id",
    "source",
    "sourceMarketId",
    "gameId",
    "instrumentId",
    "eventType",
    "apiSurface",
    "eventTimestamp",
    "capturedAt",
    "price",
    "previousPrice",
    "tradePrice",
    "size",
    "notional",
    "volume",
    "finalMarketVolume",
    "volumeShare",
    "bestBid",
    "bestAsk",
    "spread",
    "depthScore",
  ],
  properties: {
    id: { type: "integer" },
    source: { type: "string" },
    sourceMarketId: { type: "string" },
    gameId: { type: "string" },
    instrumentId: { type: ["string", "null"] },
    eventType: { type: "string" },
    apiSurface: { type: "string" },
    eventTimestamp: { type: "string" },
    capturedAt: { type: "string" },
    price: { type: ["number", "null"] },
    previousPrice: { type: ["number", "null"] },
    tradePrice: { type: ["number", "null"] },
    size: { type: ["number", "null"] },
    notional: { type: ["number", "null"] },
    volume: { type: ["number", "null"] },
    finalMarketVolume: { type: ["number", "null"] },
    volumeShare: { type: ["number", "null"] },
    bestBid: { type: ["number", "null"] },
    bestAsk: { type: ["number", "null"] },
    spread: { type: ["number", "null"] },
    depthScore: { type: ["number", "null"] },
  },
} as const;

const responseSchema = {
  type: "object",
  required: ["gameId", "theta", "events"],
  properties: {
    gameId: { type: "string" },
    theta: { type: "number" },
    events: { type: "array", items: eventJsonSchema },
  },
} as const;

const errorResponseSchema = {
  type: "object",
  required: ["error"],
  properties: { error: { type: "string" } },
} as const;

function hasBlankRawQueryParam(request: FastifyRequest, name: string): boolean {
  const rawUrl = request.raw.url;
  if (rawUrl === undefined) return false;
  const queryStart = rawUrl.indexOf("?");
  if (queryStart === -1) return false;
  const params = new URLSearchParams(rawUrl.slice(queryStart + 1));
  return params.getAll(name).some((value) => value.trim().length === 0);
}

const microstructureRoutes: FastifyPluginAsync<MicrostructureRoutesOptions> = (app, opts) => {
  const goldDbPath = opts.goldDbPath ?? GOLD_DB_PATH;

  app.get(
    "/v1/microstructure/:gameId",
    {
      schema: {
        tags: ["desk-stable"],
        summary: "Microstructure events for one game filtered by volume_share threshold",
        description:
          "Returns market_microstructure_events for the given game where volume_share >= theta. Hits idx_market_microstructure_game_time.",
        params: paramsJsonSchema,
        querystring: queryJsonSchema,
        response: {
          200: responseSchema,
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
      if (hasBlankRawQueryParam(request, "theta")) {
        reply.code(400).send({ error: "invalid query" });
        return;
      }
      const parsedQuery = querySchema.safeParse(request.query);
      if (!parsedQuery.success) {
        reply.code(400).send({ error: parsedQuery.error.issues[0]?.message ?? "invalid query" });
        return;
      }
      const result = getMicrostructure({
        goldDbPath,
        gameId: parsedParams.data.gameId,
        theta: parsedQuery.data.theta,
      });
      reply.send(result);
    },
  );

  return Promise.resolve();
};

export default microstructureRoutes;
