// Ensemble-or live route (phase B2, 2026-05-25).
//
// GET /v1/ensemble-or/:gameId — Stage-1 cascade fires for one game: board-mad
// (board lane, at live default params) UNION off-price-print (offprice lane,
// at live default thresholds). This is a runtime shape contract only; bakeoff
// recall and ranking numbers live in regenerated report artifacts because the
// benchmark corpus changes as new desk cases are added.
//
// Thin wrapper around runDetector. Response shape carries BOTH the board
// lane's per-bucket observations (mirrors /v1/board observation shape so
// UI rendering can reuse) AND the lane-tagged fires (board + offprice).

import { CACHE_DB_PATH, GOLD_DB_PATH } from "@signal-console/db";
import { Params as BoardMadParams } from "@signal-console/detectors/board-mad";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { readDetectorDefaults } from "../services/detector-defaults";
import { runDetector } from "../services/detector-runner";
import { parseStrictIsoTimestamp } from "../services/timestamps";

export interface EnsembleOrRoutesOptions {
  readonly goldDbPath?: string;
  readonly cacheDbPath?: string;
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
        "Optional ISO timestamp with timezone. When set, runs the cascade using only game data available through that historical instant.",
    },
  },
  additionalProperties: false,
} as const;

const boardObservationJsonSchema = {
  type: "object",
  required: [
    "bucketStart",
    "bucketEnd",
    "fired",
    "intensity",
    "baselineMedian",
    "baselineMad",
    "warmedUp",
  ],
  properties: {
    bucketStart: { type: "string" },
    bucketEnd: { type: "string" },
    fired: { type: "integer" },
    intensity: { type: "number" },
    baselineMedian: { type: "number" },
    baselineMad: { type: "number" },
    warmedUp: { type: "boolean" },
  },
} as const;

const fireJsonSchema = {
  type: "object",
  required: ["bucketStart", "bucketEnd", "intensity", "lane"],
  properties: {
    bucketStart: { type: "string" },
    bucketEnd: { type: "string" },
    intensity: { type: "number" },
    baselineMedian: { type: "number" },
    baselineMad: { type: "number" },
    lane: { type: "string", enum: ["board", "offprice"] },
    sourceMarketId: { type: "string" },
  },
} as const;

const responseSchema = {
  type: "object",
  required: ["gameId", "runId", "k", "boardObservations", "fires"],
  properties: {
    gameId: { type: "string" },
    runId: { type: "integer" },
    // AMENDED 2026-05-25 (Codex B-followup review P1): resolved K value the
    // runner actually computed with. LivePage draws the alert threshold from
    // this, NOT from /v1/settings, to eliminate the race where the live
    // threshold line is drawn against a K different from the K that
    // produced the fires (would happen if /v1/settings lags or defaults
    // change between requests).
    k: { type: "number" },
    boardObservations: { type: "array", items: boardObservationJsonSchema },
    fires: { type: "array", items: fireJsonSchema },
  },
} as const;

const errorResponseSchema = {
  type: "object",
  required: ["error"],
  properties: { error: { type: "string" } },
} as const;

const ensembleOrRoutes: FastifyPluginAsync<EnsembleOrRoutesOptions> = (app, opts) => {
  const goldDbPath = opts.goldDbPath ?? GOLD_DB_PATH;
  const cacheDbPath = opts.cacheDbPath ?? CACHE_DB_PATH;

  app.get(
    "/v1/ensemble-or/:gameId",
    {
      schema: {
        tags: ["desk-stable"],
        summary: "Ensemble-OR (board-mad UNION off-price-print) live fires for one game",
        description:
          "Stage-1 cascade: board-mad fires at the live default K_MAD_LIVE plus off-price-print Polymarket trade-print fires at live default thresholds. Returns boardObservations (per-bucket aggregates with warmedUp + fired) and fires (lane-tagged board + offprice). Cache-backed by per-game source watermark hash through the shared detector runner.",
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
      const defaults = readDetectorDefaults();
      // Resolve live board-mad params from detector-defaults so the
      // ensemble's board lane behaves identically to /v1/board/:gameId.
      // Off-price thresholds (offPriceMinVolumeShare,
      // offPriceMinOffPriceDistance) also come from detector-defaults
      // (phase B3 landed). Cache identity covers both lanes via the
      // runner's paramsHash, so changing either invalidates correctly.
      const liveBoardParams = BoardMadParams.parse({
        kMad: defaults.kMadLive,
        baselineMode: defaults.baselineMode,
        bucketSeconds: defaults.bucketSeconds,
        historicalAwayWeight: defaults.historicalAwayWeight,
        historicalLastGames: defaults.historicalLastGames,
        historicalPriorWeight: defaults.historicalPriorWeight,
        historicalRampCompleteGameMinutes: defaults.historicalRampCompleteGameMinutes,
        openingBaselineBuckets: defaults.openingBaselineBuckets,
        openingRampCompleteBuckets: defaults.openingRampCompleteBuckets,
        recentWallMinutes: defaults.recentWallMinutes,
        recentWallWeight: defaults.recentWallWeight,
        trailingGameMinutes: defaults.trailingGameMinutes,
        trailingBuckets: defaults.trailingBuckets,
        warmupBuckets: defaults.warmupBuckets,
        freshCapSeconds: defaults.freshCapSeconds,
      });
      const result = runDetector({
        detectorId: "ensemble-or",
        params: {
          board: liveBoardParams,
          offprice: {
            minVolumeShare: defaults.offPriceMinVolumeShare,
            minOffPriceDistance: defaults.offPriceMinOffPriceDistance,
          },
        },
        scope:
          atMs === null
            ? { kind: "game", gameId: parsed.data.gameId }
            : {
                kind: "window",
                windowStart: new Date(0).toISOString(),
                windowEnd: new Date(atMs).toISOString(),
                gameIds: [parsed.data.gameId],
              },
        goldDbPath,
        cacheDbPath,
        ...(atMs === null ? {} : { now: new Date(atMs) }),
      });
      reply.send({
        gameId: parsed.data.gameId,
        runId: result.runId,
        // Echo back the resolved K so the chart draws threshold lines from
        // the SAME K that produced these fires. LivePage no longer needs
        // a separate /v1/settings round-trip for this number (Codex
        // B-followup review P1, 2026-05-25).
        k: liveBoardParams.kMad,
        boardObservations: result.buckets.map((b) => ({
          bucketStart: b.bucketStart.toISOString(),
          bucketEnd: b.bucketEnd.toISOString(),
          fired: b.fired ? 1 : 0,
          intensity: b.intensity,
          baselineMedian: b.baselineMedian,
          baselineMad: b.baselineMad,
          warmedUp: b.warmedUp,
        })),
        fires: result.fires.map((f) => ({
          bucketStart: f.bucketStart.toISOString(),
          bucketEnd: f.bucketEnd.toISOString(),
          intensity: f.intensity,
          baselineMedian: f.baselineMedian,
          baselineMad: f.baselineMad,
          // Default to "board" for any fire missing a lane (board-mad's run()
          // doesn't set lane; ensemble-or wraps and tags it). The runner's
          // historical-blend normalization at detector-runner.ts:280 also tags
          // standalone off-price-print fires, but ensemble fires from the
          // board lane don't go through that path — explicit default here.
          lane: f.lane ?? "board",
          ...(f.sourceMarketId === undefined ? {} : { sourceMarketId: f.sourceMarketId }),
        })),
      });
    },
  );

  return Promise.resolve();
};

export default ensembleOrRoutes;
