// Health routes (PRD §13 / US-017).
//
// GET /v1/health/live  — always 200 { ok: true }, no DB access. The auth
//                        plugin exempts this path so the Cloudflare tunnel
//                        and external monitors can probe it anonymously.
// GET /v1/health/ready — opens the gold DB via openGoldDb() and verifies the
//                        app's required read schema with zero-row probes.
//                        Returns 200 { ok: true } on success or 503
//                        { ok: false, reason: <error message> } on failure.
//                        Reachable through the auth plugin.

import { GOLD_DB_PATH, openGoldDb } from "@signal-console/db";
import type { FastifyPluginAsync } from "fastify";

export interface HealthRoutesOptions {
  readonly goldDbPath?: string;
}

const liveResponseSchema = {
  type: "object",
  required: ["ok"],
  properties: { ok: { type: "boolean" } },
} as const;

const readyOkResponseSchema = {
  type: "object",
  required: ["ok"],
  properties: { ok: { type: "boolean" } },
} as const;

const readyFailResponseSchema = {
  type: "object",
  required: ["ok", "reason"],
  properties: {
    ok: { type: "boolean" },
    reason: { type: "string" },
  },
} as const;

type GoldDbHandle = ReturnType<typeof openGoldDb>;

function reasonFrom(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "unknown error";
}

const GOLD_READINESS_PROBES = [
  "SELECT id, sport, league, scheduled_start, home_participant_json, away_participant_json FROM games LIMIT 0",
  "SELECT id, source, game_id, instrument_id, raw_family, raw_label FROM source_markets LIMIT 0",
  "SELECT source_market_id, captured_at, implied_probability, volume, is_heartbeat FROM quote_ticks LIMIT 0",
  "SELECT game_id, captured_at, status FROM game_states LIMIT 0",
  `SELECT id,
          source,
          source_market_id,
          game_id,
          instrument_id,
          event_type,
          api_surface,
          event_timestamp,
          captured_at,
          price,
          previous_price,
          trade_price,
          size,
          notional,
          volume,
          final_market_volume,
          volume_share,
          best_bid,
          best_ask,
          spread,
          depth_score
   FROM market_microstructure_events
   LIMIT 0`,
  "SELECT game_id, time_actual FROM nba_play_by_play_actions LIMIT 0",
] as const;

function verifyGoldReadSchema(db: GoldDbHandle): void {
  for (const probe of GOLD_READINESS_PROBES) {
    db.prepare(probe).all();
  }
}

const healthRoutes: FastifyPluginAsync<HealthRoutesOptions> = (app, opts) => {
  const goldDbPath = opts.goldDbPath ?? GOLD_DB_PATH;

  app.get(
    "/v1/health/live",
    {
      schema: {
        tags: ["internal"],
        summary: "Liveness probe",
        description: "Always returns 200 { ok: true }; performs no DB access.",
        response: { 200: liveResponseSchema },
      },
    },
    (_request, reply) => {
      reply.send({ ok: true });
    },
  );

  app.get(
    "/v1/health/ready",
    {
      schema: {
        tags: ["internal"],
        summary: "Readiness probe",
        description:
          "Opens the gold DB read-only and verifies the required read schema. 200 on success, 503 with reason on failure.",
        response: {
          200: readyOkResponseSchema,
          503: readyFailResponseSchema,
        },
      },
    },
    (_request, reply) => {
      try {
        const db = openGoldDb(goldDbPath);
        try {
          verifyGoldReadSchema(db);
        } finally {
          db.close();
        }
        reply.send({ ok: true });
      } catch (err) {
        reply.code(503).send({ ok: false, reason: reasonFrom(err) });
      }
    },
  );

  return Promise.resolve();
};

export default healthRoutes;
