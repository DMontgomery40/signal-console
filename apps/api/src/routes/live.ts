// Live route (US-028 / PRD §FR-20, §15).
//
// GET /v1/live/:gameId — bounded quote_ticks window for one game, joined to
// source_markets for instrument metadata, plus cheap game-state/PBP context.
// Default live calls use five minutes; historical replay can pass at= plus a
// capped window_ms.
//
// Detector fires layer in via the separate /v1/board/:gameId call. No
// baseline-rebuild table is read by this route; the US-028 grep guard pins
// that.

import { GOLD_DB_PATH } from "@signal-console/db";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { getLive, LIVE_WINDOW_MS, MAX_LIVE_WINDOW_MS } from "../services/live";
import { parseStrictIsoTimestamp } from "../services/timestamps";

export interface LiveRoutesOptions {
  readonly goldDbPath?: string;
}

const paramSchema = z.object({ gameId: z.string().min(1) });
const querySchema = z.object({
  at: z.string().optional(),
  window_ms: z.union([z.string(), z.number()]).optional(),
});

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
        "Optional ISO timestamp with timezone. When set, returns the selected live tick window ending at this historical instant.",
    },
    window_ms: {
      type: "string",
      pattern: "^[0-9]+$",
      description:
        "Optional positive live tick window length in milliseconds, capped at 900000. Defaults to five minutes; Known Cases uses ten minutes for incident ±5 minute replay.",
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

const gameStateJsonSchema = {
  type: "object",
  required: [
    "awayScore",
    "capturedAt",
    "clock",
    "finalAt",
    "homeScore",
    "isFinal",
    "period",
    "startedAt",
    "status",
  ],
  properties: {
    awayScore: { type: ["integer", "null"] },
    capturedAt: { type: "string" },
    clock: { type: ["string", "null"] },
    finalAt: { type: ["string", "null"] },
    homeScore: { type: ["integer", "null"] },
    isFinal: { type: "boolean" },
    period: { type: ["integer", "null"] },
    startedAt: { type: ["string", "null"] },
    status: { type: "string" },
  },
} as const;

const playByPlayActionJsonSchema = {
  type: "object",
  required: [
    "actionNumber",
    "actionType",
    "clock",
    "description",
    "period",
    "personId",
    "playerName",
    "scoreAway",
    "scoreHome",
    "subType",
    "teamTricode",
    "timeActual",
  ],
  properties: {
    actionNumber: { type: "integer" },
    actionType: { type: ["string", "null"] },
    clock: { type: ["string", "null"] },
    description: { type: ["string", "null"] },
    period: { type: ["integer", "null"] },
    personId: { type: ["integer", "null"] },
    playerName: { type: ["string", "null"] },
    scoreAway: { type: ["string", "null"] },
    scoreHome: { type: ["string", "null"] },
    subType: { type: ["string", "null"] },
    teamTricode: { type: ["string", "null"] },
    timeActual: { type: ["string", "null"] },
  },
} as const;

const activityJsonSchema = {
  type: "object",
  required: ["gameState", "playByPlayActionCount", "recentPlayByPlay"],
  properties: {
    gameState: { anyOf: [gameStateJsonSchema, { type: "null" }] },
    playByPlayActionCount: { type: "integer" },
    recentPlayByPlay: { type: "array", items: playByPlayActionJsonSchema },
  },
} as const;

const responseSchema = {
  type: "object",
  required: ["activity", "gameId", "windowStart", "windowEnd", "ticks"],
  properties: {
    activity: activityJsonSchema,
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

function parseWindowMs(raw: string | number | undefined): number | null {
  if (raw === undefined) return LIVE_WINDOW_MS;
  if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw) || raw <= 0 || raw > MAX_LIVE_WINDOW_MS) return null;
    return raw;
  }
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_LIVE_WINDOW_MS) return null;
  return parsed;
}

const liveRoutes: FastifyPluginAsync<LiveRoutesOptions> = (app, opts) => {
  const goldDbPath = opts.goldDbPath ?? GOLD_DB_PATH;

  app.get(
    "/v1/live/:gameId",
    {
      schema: {
        tags: ["desk-stable"],
        summary: "Bounded quote_ticks window for one game",
        description:
          "Returns ticks captured within a bounded time window for the given game, joined to source_markets for instrument metadata, plus game state and official play-by-play context scoped to the window end. Defaults to the last 5 minutes; historical replay may pass at= plus capped window_ms. Bounded by the quote_ticks (source_market_id, captured_at) index.",
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
      const windowMs = parseWindowMs(parsedQuery.data.window_ms);
      if (windowMs === null) {
        reply.code(400).send({ error: "invalid window_ms" });
        return;
      }
      const result = getLive({
        goldDbPath,
        gameId: parsed.data.gameId,
        ...(atMs === null ? {} : { now: new Date(atMs) }),
        windowMs,
      });
      reply.send(result);
    },
  );

  return Promise.resolve();
};

export default liveRoutes;
