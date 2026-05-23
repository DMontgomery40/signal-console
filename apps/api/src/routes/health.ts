// Health routes (PRD §13 / US-017).
//
// GET /v1/health/live  — always 200 { ok: true }, no DB access. The auth
//                        plugin exempts this path so the Cloudflare tunnel
//                        and external monitors can probe it anonymously.
// GET /v1/health/ready — opens the gold DB via openGoldDb() and runs
//                        SELECT 1. Returns 200 { ok: true } on success or
//                        503 { ok: false, reason: <error message> } on
//                        failure. Reachable through the auth plugin.

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

function reasonFrom(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "unknown error";
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
          "Opens the gold DB read-only and runs SELECT 1. 200 on success, 503 with reason on failure.",
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
          db.prepare("SELECT 1").get();
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
