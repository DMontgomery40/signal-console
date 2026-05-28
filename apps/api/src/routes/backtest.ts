// Backtest route (US-034, PRD §15 / §16).
//
// POST /v1/backtest — runs a detector over a window + games + params with
// window-scope cache lookup. Tagged 'internal' (request shape may evolve).
//
// Bounds (PRD §FR-17): window ≤ 28 days; if game_ids is provided, ≤ 20
// entries. If game_ids is omitted, the service discovers up to 20 games whose
// scheduled_start falls in the window (oldest-first, truncating with a 400
// if the window contains more than 20 games — keeps behavior predictable and
// matches the "≤ 20 games per request" cap end-to-end).

import { CACHE_DB_PATH, GOLD_DB_PATH } from "@signal-console/db";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { BacktestError, discoverGameIdsInWindow, runBacktest } from "../services/backtest";
import type { BoardVolatilityRunner } from "../services/detector-runner";
import { parseStrictIsoTimestamp } from "../services/timestamps";

export interface BacktestRoutesOptions {
  readonly goldDbPath?: string;
  readonly cacheDbPath?: string;
  readonly boardVolatilityFetchImpl?: typeof fetch;
  readonly boardVolatilityRunner?: BoardVolatilityRunner;
  readonly boardVolatilitySidecarBaseUrl?: string;
}

const MAX_WINDOW_DAYS = 28;
const MAX_GAMES = 20;
const MAX_WINDOW_MS = MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000;

const windowSchema = z.object({
  start: z.string().min(1),
  end: z.string().min(1),
});

const bodySchema = z.object({
  detector_id: z.string().min(1),
  // Per-detector params shape is validated downstream in the service after
  // the detector_id resolves to a registry entry. Keeping it `unknown` at the
  // route boundary avoids one-of-N branching on the body schema itself.
  params: z.unknown(),
  window: windowSchema,
  game_ids: z.array(z.string()).optional(),
});

const bodyJsonSchema = {
  type: "object",
  required: ["detector_id", "params", "window"],
  properties: {
    detector_id: { type: "string", minLength: 1 },
    params: {},
    window: {
      type: "object",
      required: ["start", "end"],
      properties: {
        start: { type: "string", minLength: 1 },
        end: { type: "string", minLength: 1 },
      },
    },
    game_ids: { type: "array", items: { type: "string", minLength: 1 } },
  },
} as const;

const observationJsonSchema = {
  type: "object",
  required: [
    "gameId",
    "bucketStart",
    "bucketEnd",
    "fired",
    "intensity",
    "baselineMedian",
    "baselineMad",
  ],
  properties: {
    gameId: { type: "string" },
    bucketStart: { type: "string" },
    bucketEnd: { type: "string" },
    fired: { type: "integer" },
    intensity: { type: "number" },
    gameElapsedSeconds: { type: "number" },
    baselineMedian: { type: "number" },
    baselineMad: { type: "number" },
    threshold: { type: "number" },
    standardizedInnovation: { type: "number" },
    regimeScore: { type: "number" },
    // Optional: ensemble-or tags each observation with its lane so the UI
    // can render board fires (intensity-vs-threshold timeline) differently
    // from off-price-print fires (point-in-time tape prints).
    lane: { type: "string", enum: ["board", "offprice"] },
  },
} as const;

const statsJsonSchema = {
  type: "object",
  required: ["firesPerGame", "totalFires", "gamesInWindow"],
  properties: {
    firesPerGame: { type: "number" },
    totalFires: { type: "integer" },
    gamesInWindow: { type: "integer" },
  },
} as const;

const responseSchema = {
  type: "object",
  required: ["runId", "stats", "observations"],
  properties: {
    runId: { type: "integer" },
    stats: statsJsonSchema,
    observations: { type: "array", items: observationJsonSchema },
  },
} as const;

const errorResponseSchema = {
  type: "object",
  required: ["error"],
  properties: { error: { type: "string" } },
} as const;

interface ParsedWindow {
  readonly start: string;
  readonly end: string;
  readonly startMs: number;
  readonly endMs: number;
}

function parseTimestamp(input: string): number | null {
  return parseStrictIsoTimestamp(input, { requireExplicitTimezone: true });
}

function parseWindow(window: { start: string; end: string }): ParsedWindow | null {
  const startMs = parseTimestamp(window.start);
  const endMs = parseTimestamp(window.end);
  if (startMs === null || endMs === null) return null;
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    startMs,
    endMs,
  };
}

function normalizeGameIds(gameIds: readonly string[]): readonly string[] | null {
  const trimmed = gameIds.map((id) => id.trim());
  if (trimmed.some((id) => id.length === 0)) return null;
  return Array.from(new Set(trimmed));
}

const backtestRoutes: FastifyPluginAsync<BacktestRoutesOptions> = (app, opts) => {
  const goldDbPath = opts.goldDbPath ?? GOLD_DB_PATH;
  const cacheDbPath = opts.cacheDbPath ?? CACHE_DB_PATH;

  app.post(
    "/v1/backtest",
    {
      schema: {
        tags: ["internal"],
        summary: "Run a detector over (window, games, params); window-scope cached",
        description:
          "Runs a detector_id from the registry over the requested window and game set. Cached by params_hash + per-window source watermark hash; same body returns the cached run_id on the second call. Bounds: window ≤ 28 days, ≤ 20 games. Tagged internal — the request shape may evolve.",
        body: bodyJsonSchema,
        response: {
          200: responseSchema,
          400: errorResponseSchema,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid request body" });
        return;
      }
      const body = parsed.data;

      const win = parseWindow(body.window);
      if (win === null) {
        reply.code(400).send({ error: "invalid window timestamps" });
        return;
      }
      const windowMs = win.endMs - win.startMs;
      if (windowMs <= 0) {
        reply.code(400).send({ error: "window end must be after window start" });
        return;
      }
      if (windowMs > MAX_WINDOW_MS) {
        reply.code(400).send({ error: "window exceeds 28 days" });
        return;
      }
      let gameIds: readonly string[];
      if (body.game_ids !== undefined) {
        const normalized = normalizeGameIds(body.game_ids);
        if (normalized === null) {
          reply.code(400).send({ error: "invalid game_ids" });
          return;
        }
        if (normalized.length > MAX_GAMES) {
          reply.code(400).send({ error: "too many games" });
          return;
        }
        gameIds = normalized;
      } else {
        // Discovery: pull up to MAX_GAMES+1 games — if the window has more
        // than the cap, we 400 rather than silently truncating, matching the
        // explicit-list path.
        const discovered = discoverGameIdsInWindow(goldDbPath, win.start, win.end, MAX_GAMES + 1);
        if (discovered.length > MAX_GAMES) {
          reply.code(400).send({ error: "too many games" });
          return;
        }
        gameIds = discovered;
      }

      try {
        const result = await runBacktest({
          goldDbPath,
          cacheDbPath,
          detectorId: body.detector_id,
          params: body.params,
          ...(opts.boardVolatilityFetchImpl === undefined
            ? {}
            : { boardVolatilityFetchImpl: opts.boardVolatilityFetchImpl }),
          ...(opts.boardVolatilityRunner === undefined
            ? {}
            : { boardVolatilityRunner: opts.boardVolatilityRunner }),
          ...(opts.boardVolatilitySidecarBaseUrl === undefined
            ? {}
            : { boardVolatilitySidecarBaseUrl: opts.boardVolatilitySidecarBaseUrl }),
          windowStart: win.start,
          windowEnd: win.end,
          gameIds,
        });
        reply.send(result);
      } catch (err) {
        if (err instanceof BacktestError) {
          reply.code(400).send({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  return Promise.resolve();
};

export default backtestRoutes;
