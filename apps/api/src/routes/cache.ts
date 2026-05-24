// Cache route (US-020 / PRD §15).
//
// DELETE /v1/cache — clears the writable detector-cache DB. Optional
// query params `detector_id` and `before` (ISO timestamp) narrow the
// delete; with no filters every detector_runs row is removed (with
// matching detector_observations cascade-deleted by FK). The gold DB
// is never opened by this route.

import { CACHE_DB_PATH } from "@signal-console/db";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { CacheError, clearCache } from "../services/cache";

export interface CacheRoutesOptions {
  readonly cacheDbPath?: string;
}

const querySchema = z.object({
  detector_id: z.string().min(1).optional(),
  before: z.string().min(1).optional(),
});

const queryJsonSchema = {
  type: "object",
  properties: {
    detector_id: {
      type: "string",
      description: "Optional detector id to scope the delete (e.g. board-mad).",
    },
    before: {
      type: "string",
      description: "Optional ISO 8601 timestamp; only rows with computed_at < before are deleted.",
    },
  },
  additionalProperties: false,
} as const;

const responseSchema = {
  type: "object",
  required: ["deleted"],
  properties: {
    deleted: { type: "integer", minimum: 0 },
  },
} as const;

const errorResponseSchema = {
  type: "object",
  required: ["error"],
  properties: { error: { type: "string" } },
} as const;

const cacheRoutes: FastifyPluginAsync<CacheRoutesOptions> = (app, opts) => {
  const cacheDbPath = opts.cacheDbPath ?? CACHE_DB_PATH;

  app.delete(
    "/v1/cache",
    {
      schema: {
        tags: ["internal"],
        summary: "Clear detector-cache rows (gold DB untouched)",
        description:
          "Deletes detector_runs rows (and cascades detector_observations). Optional filters: detector_id, before (ISO timestamp).",
        querystring: queryJsonSchema,
        response: {
          200: responseSchema,
          400: errorResponseSchema,
        },
      },
    },
    (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = querySchema.safeParse(request.query);
      if (!parsed.success) {
        reply.code(400).send({ error: `invalid query: ${parsed.error.message}` });
        return;
      }
      const { detector_id, before } = parsed.data;
      try {
        const result = clearCache(cacheDbPath, {
          ...(detector_id !== undefined ? { detectorId: detector_id } : {}),
          ...(before !== undefined ? { before } : {}),
        });
        reply.send(result);
      } catch (err) {
        if (err instanceof CacheError) {
          reply.code(400).send({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  return Promise.resolve();
};

export default cacheRoutes;
