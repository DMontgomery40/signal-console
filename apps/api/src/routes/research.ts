// Research artifact routes.
//
// READ-MOSTLY surface over the quant-lab artifact tree under
// outputs/nba-quant-lab/. Every GET is read-only and filesystem-resilient
// (absent / empty / malformed -> clean empty payload, never 500).
//
// The ONLY writer is POST /v1/research/pull: it validates the request via the
// shared @signal-console/research-pull planner+validator, then ENQUEUES a pull
// job to the admin-action queue and returns { job_id }. It does NOT run a
// backfill inline and never mutates detector defaults or live state. The
// enqueue is injected (opts.enqueuePull) so it is testable without a DB and so
// read/write separation is structural, not incidental.

import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";

import { planPullJob } from "@signal-console/research-pull";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import {
  DEFAULT_RESEARCH_OUTPUT_ROOT,
  getLatestLeaderboard,
  getLatestSnapshot,
  getResearchModels,
  getResearchPull,
  getResearchSources,
  listResearchPulls,
  resolveArtifact,
} from "../services/research";

/**
 * Result of enqueueing a pull job to the admin-action queue. The route only
 * needs an opaque id to echo back as job_id.
 */
export interface EnqueuedPull {
  readonly jobId: string;
}

export type EnqueuePullFn = (input: {
  readonly request: unknown;
  readonly jobId: string;
}) => EnqueuedPull | Promise<EnqueuedPull>;

export interface ResearchRoutesOptions {
  readonly outputRoot?: string;
  /**
   * Injectable writer. Defaults to a queue-backed enqueue in server.ts. Tests
   * pass a spy to assert it fires on a valid request and NOT on an invalid one.
   */
  readonly enqueuePull?: EnqueuePullFn;
  /** Injectable id generator so POST responses are deterministic in tests. */
  readonly generateJobId?: () => string;
  /** Injectable clock (unix seconds) for the time-dependent validator. */
  readonly now?: () => number;
}

const sourceSchema = {
  type: "object",
  required: ["id", "class", "supportedModes", "limitations"],
  properties: {
    id: { type: "string" },
    class: { type: "string", enum: ["snapshot-eligible", "artifact-only", "pending"] },
    supportedModes: { type: "array", items: { type: "string" } },
    limitations: { type: "array", items: { type: "string" } },
  },
} as const;

const sourcesResponseSchema = {
  type: "object",
  required: ["sources"],
  properties: {
    sources: { type: "array", items: sourceSchema },
  },
} as const;

const pullsResponseSchema = {
  type: "object",
  required: ["pulls"],
  properties: {
    pulls: { type: "array", items: { type: "object", additionalProperties: true } },
  },
} as const;

const pullResponseSchema = {
  type: "object",
  additionalProperties: true,
} as const;

const snapshotResponseSchema = {
  type: "object",
  required: ["snapshot"],
  properties: {
    snapshot: { type: ["object", "null"], additionalProperties: true },
  },
} as const;

const leaderboardResponseSchema = {
  type: "object",
  required: ["runId", "rows"],
  properties: {
    runId: { type: ["string", "null"] },
    rows: { type: "array", items: { type: "object", additionalProperties: true } },
  },
} as const;

const modelsResponseSchema = {
  type: "object",
  required: ["models"],
  properties: {
    models: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "label", "description", "source"],
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          description: { type: "string" },
          source: { type: "string", enum: ["registry", "static"] },
        },
      },
    },
  },
} as const;

const pullRequestSchema = {
  type: "object",
  required: ["sources", "date_from", "date_to", "capture_mode", "market_scope"],
  properties: {
    sources: { type: "array", items: { type: "string" }, minItems: 1 },
    date_from: { type: "string", description: "ISO calendar date YYYY-MM-DD." },
    date_to: { type: "string", description: "ISO calendar date YYYY-MM-DD." },
    game_ids: { type: "array", items: { type: "string" } },
    capture_mode: { type: "string", enum: ["historical", "repair", "live-capture"] },
    market_scope: { type: "string", enum: ["all", "board", "player-props"] },
    odds_api_io: { type: "object", additionalProperties: true },
  },
  additionalProperties: true,
  description:
    "Pull-job request. Validated by the shared @signal-console/research-pull planner+validator before the job is enqueued; the route does NOT run a backfill inline.",
} as const;

const enqueueResponseSchema = {
  type: "object",
  required: ["job_id"],
  properties: { job_id: { type: "string" } },
} as const;

const errorResponseSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: { type: "string" },
    code: { type: "string" },
    details: { type: "array", items: { type: "object", additionalProperties: true } },
  },
} as const;

const researchRoutes: FastifyPluginAsync<ResearchRoutesOptions> = (app, opts) => {
  const outputRoot = opts.outputRoot ?? DEFAULT_RESEARCH_OUTPUT_ROOT;
  const generateJobId = opts.generateJobId ?? (() => `pull-${randomUUID()}`);
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  // No-op default keeps the route safe to mount without a writer wired; the
  // real queue-backed enqueue is injected in server.ts.
  const enqueuePull: EnqueuePullFn = opts.enqueuePull ?? (({ jobId }) => ({ jobId }));

  app.get(
    "/v1/research/sources",
    {
      schema: {
        tags: ["research"],
        summary: "Source capability matrix",
        description:
          "Read-only. Returns the shared research-pull capability matrix (snapshot-eligible / artifact-only / pending) with supported capture modes and limitations.",
        response: { 200: sourcesResponseSchema },
      },
    },
    (_request: FastifyRequest, reply: FastifyReply) => {
      reply.send(getResearchSources());
    },
  );

  app.get(
    "/v1/research/pulls",
    {
      schema: {
        tags: ["research"],
        summary: "List pull-job states",
        description:
          "Read-only. Returns every pull job.json under outputs/nba-quant-lab/pulls/<id>/, newest first. Absent or malformed artifacts yield an empty list, never an error.",
        response: { 200: pullsResponseSchema },
      },
    },
    (_request: FastifyRequest, reply: FastifyReply) => {
      reply.send(listResearchPulls({ outputRoot }));
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/research/pulls/:id",
    {
      schema: {
        tags: ["research"],
        summary: "Read one pull-job state",
        description:
          "Read-only. Returns the job.json for a single pull id. Unknown or malformed id returns 404 with a clean error, never a 500.",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: { 200: pullResponseSchema, 404: errorResponseSchema },
      },
    },
    (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const job = getResearchPull(request.params.id, { outputRoot });
      if (job === undefined) {
        reply.code(404).send({ error: "pull not found", code: "not_found" });
        return;
      }
      reply.send(job);
    },
  );

  app.get(
    "/v1/research/snapshot/latest",
    {
      schema: {
        tags: ["research"],
        summary: "Latest snapshot manifest",
        description:
          "Read-only. Returns the latest outputs/nba-quant-lab/snapshots/<id>/manifest.json, chosen by manifest timestamp then mtime. Absent returns { snapshot: null }.",
        response: { 200: snapshotResponseSchema },
      },
    },
    (_request: FastifyRequest, reply: FastifyReply) => {
      reply.send(getLatestSnapshot({ outputRoot }));
    },
  );

  app.get(
    "/v1/research/models",
    {
      schema: {
        tags: ["research"],
        summary: "Registered models",
        description:
          "Read-only. Returns the artifact-backed models.json registry if the python CLI emitted one, otherwise a static fallback list.",
        response: { 200: modelsResponseSchema },
      },
    },
    (_request: FastifyRequest, reply: FastifyReply) => {
      reply.send(getResearchModels({ outputRoot }));
    },
  );

  app.get(
    "/v1/research/leaderboard/latest",
    {
      schema: {
        tags: ["research"],
        summary: "Latest run leaderboard",
        description:
          "Read-only. Returns the latest outputs/nba-quant-lab/runs/<id>/leaderboard.json rows. Absent returns { runId: null, rows: [] }.",
        response: { 200: leaderboardResponseSchema },
      },
    },
    (_request: FastifyRequest, reply: FastifyReply) => {
      reply.send(getLatestLeaderboard({ outputRoot }));
    },
  );

  app.get<{ Querystring: { id?: string } }>(
    "/v1/research/artifact",
    {
      schema: {
        tags: ["research"],
        summary: "Download an allow-listed artifact",
        description:
          "Read-only, PATH-SAFE. Resolves only allow-listed artifact ids to files strictly under outputs/nba-quant-lab/. Rejects absolute paths, traversal (..), and arbitrary request paths with 400; unknown id with 400; missing file with 404.",
        querystring: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: { 400: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    (request: FastifyRequest<{ Querystring: { id?: string } }>, reply: FastifyReply) => {
      const id = request.query.id;
      if (typeof id !== "string" || id.length === 0) {
        reply.code(400).send({ error: "id is required", code: "missing_id" });
        return;
      }
      const resolved = resolveArtifact(id, { outputRoot });
      if (!resolved.ok) {
        if (resolved.reason === "not_found") {
          reply.code(404).send({ error: "artifact not found", code: "not_found" });
          return;
        }
        reply.code(400).send({
          error:
            resolved.reason === "unknown_id"
              ? "unknown artifact id"
              : "rejected unsafe artifact path",
          code: resolved.reason,
        });
        return;
      }
      reply.header("content-type", "application/octet-stream");
      reply.send(createReadStream(resolved.path));
    },
  );

  app.post(
    "/v1/research/pull",
    {
      schema: {
        tags: ["research"],
        summary: "Validate and enqueue a research pull job",
        description:
          "The only writer. Validates the request via the shared research-pull planner+validator, then ENQUEUES a pull job to the admin-action queue and returns { job_id }. Does NOT run a backfill inline and never mutates detector defaults or live state. Invalid requests return 400 and are NOT enqueued.",
        body: pullRequestSchema,
        response: {
          202: enqueueResponseSchema,
          400: errorResponseSchema,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const plan = planPullJob(request.body, { now: now() });
      if (!plan.ok) {
        // Invalid: return coded errors and DO NOT enqueue.
        await reply.code(400).send({
          error: "invalid pull request",
          code: "validation_failed",
          details: plan.errors.map((e) => ({
            code: e.code,
            message: e.message,
            ...(e.path === undefined ? {} : { path: e.path }),
          })),
        });
        return;
      }
      const jobId = generateJobId();
      const enqueued = await enqueuePull({ request: request.body, jobId });
      await reply.code(202).send({ job_id: enqueued.jobId });
    },
  );

  return Promise.resolve();
};

export default researchRoutes;
