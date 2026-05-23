// Games routes (US-018).
//
// GET /v1/games           — list games scheduled within the last `since`
//                           ISO-8601 duration (default PT24H), optional sport
//                           filter. Reads via the v_games CTE.
// GET /v1/games/:gameId   — single game by id, 404 if not found.

import { GOLD_DB_PATH, openGoldDb } from "@signal-console/db";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { getGame, isValidIsoDuration, listGames } from "../services/games";

export interface GamesRoutesOptions {
  readonly goldDbPath?: string;
}

const listQuerySchema = z.object({
  since: z
    .string()
    .default("PT24H")
    .refine(isValidIsoDuration, { message: "invalid ISO 8601 duration" }),
  sport: z.string().optional(),
});

const paramSchema = z.object({ gameId: z.string().min(1) });

const gameRowJsonSchema = {
  type: "object",
  required: [
    "id",
    "sport",
    "league",
    "scheduledStart",
    "homeParticipantJson",
    "awayParticipantJson",
    "status",
  ],
  properties: {
    id: { type: "string" },
    sport: { type: "string" },
    league: { type: "string" },
    scheduledStart: { type: "string" },
    homeParticipantJson: { type: "string" },
    awayParticipantJson: { type: "string" },
    status: { type: ["string", "null"] },
  },
} as const;

const listResponseSchema = {
  type: "object",
  required: ["games"],
  properties: {
    games: { type: "array", items: gameRowJsonSchema },
  },
} as const;

const errorResponseSchema = {
  type: "object",
  required: ["error"],
  properties: { error: { type: "string" } },
} as const;

const listQueryJsonSchema = {
  type: "object",
  properties: {
    since: {
      type: "string",
      description: "ISO 8601 duration (e.g. PT24H, P7D). Default PT24H.",
      default: "PT24H",
    },
    sport: { type: "string", description: "Optional sport filter (e.g. NBA)." },
  },
  additionalProperties: false,
} as const;

const paramsJsonSchema = {
  type: "object",
  required: ["gameId"],
  properties: { gameId: { type: "string", minLength: 1 } },
} as const;

const gamesRoutes: FastifyPluginAsync<GamesRoutesOptions> = (app, opts) => {
  const goldDbPath = opts.goldDbPath ?? GOLD_DB_PATH;

  app.get(
    "/v1/games",
    {
      schema: {
        tags: ["desk-stable"],
        summary:
          "List games scheduled within the last `since` duration, optionally filtered by sport",
        description:
          "Returns games whose scheduled_start falls within `since` (ISO 8601 duration, default PT24H). When the `sport` query parameter is provided (e.g. NBA, NFL), rows are filtered to exact-match that sport; otherwise rows of all sports are returned. Unknown sports return 200 with an empty array rather than 404.",
        querystring: listQueryJsonSchema,
        response: {
          200: listResponseSchema,
          400: errorResponseSchema,
        },
      },
    },
    (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = listQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        reply.code(400).send({ error: `invalid query: ${parsed.error.message}` });
        return;
      }
      const db = openGoldDb(goldDbPath);
      try {
        const games = listGames(db, parsed.data);
        reply.send({ games });
      } finally {
        db.close();
      }
    },
  );

  app.get(
    "/v1/games/:gameId",
    {
      schema: {
        tags: ["desk-stable"],
        summary: "Get a single game by id",
        params: paramsJsonSchema,
        response: {
          200: gameRowJsonSchema,
          404: errorResponseSchema,
        },
      },
    },
    (request: FastifyRequest, reply: FastifyReply) => {
      const parsedParams = paramSchema.safeParse(request.params);
      if (!parsedParams.success) {
        reply.code(400).send({ error: "invalid params" });
        return;
      }
      const db = openGoldDb(goldDbPath);
      try {
        const game = getGame(db, parsedParams.data.gameId);
        if (game === null) {
          reply.code(404).send({ error: "game not found" });
          return;
        }
        reply.send(game);
      } finally {
        db.close();
      }
    },
  );

  return Promise.resolve();
};

export default gamesRoutes;
