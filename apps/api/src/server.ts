// Fastify server scaffold for the Signal Console API (PRD §13).
// Exports buildServer() so tests can inject() without a real listen,
// and starts the server when this module is the process entrypoint.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyInstance } from "fastify";

import { defaultApiPort } from "../../../packages/shared/src/ports";

import authPlugin, { type AuthPluginOptions } from "./plugins/auth";
import backtestRoutes, { type BacktestRoutesOptions } from "./routes/backtest";
import boardRoutes, { type BoardRoutesOptions } from "./routes/board";
import cacheRoutes, { type CacheRoutesOptions } from "./routes/cache";
import detectorsRoutes, { type DetectorsRoutesOptions } from "./routes/detectors";
import ensembleOrRoutes, { type EnsembleOrRoutesOptions } from "./routes/ensemble-or";
import gamesRoutes, { type GamesRoutesOptions } from "./routes/games";
import healthRoutes, { type HealthRoutesOptions } from "./routes/health";
import incidentsRoutes, { type IncidentsRoutesOptions } from "./routes/incidents";
import liveRoutes, { type LiveRoutesOptions } from "./routes/live";
import microstructureRoutes, { type MicrostructureRoutesOptions } from "./routes/microstructure";
import offPricePrintRoutes, { type OffPricePrintRoutesOptions } from "./routes/off-price-print";
import researchRoutes, { type ResearchRoutesOptions } from "./routes/research";
import settingsRoutes, { type SettingsRoutesOptions } from "./routes/settings";

const DEFAULT_PORT = defaultApiPort;
const DEFAULT_HOST = "localhost";

export interface BuildServerOptions {
  readonly auth?: AuthPluginOptions;
  readonly health?: HealthRoutesOptions;
  readonly games?: GamesRoutesOptions;
  readonly incidents?: IncidentsRoutesOptions;
  readonly settings?: SettingsRoutesOptions;
  readonly cache?: CacheRoutesOptions;
  readonly board?: BoardRoutesOptions;
  readonly backtest?: BacktestRoutesOptions;
  readonly live?: LiveRoutesOptions;
  readonly microstructure?: MicrostructureRoutesOptions;
  readonly detectors?: DetectorsRoutesOptions;
  readonly offPricePrint?: OffPricePrintRoutesOptions;
  readonly ensembleOr?: EnsembleOrRoutesOptions;
  readonly research?: ResearchRoutesOptions;
}

/**
 * Default queue-backed enqueue for research pull jobs. Dynamically imports the
 * shared live-repository so the API does not pay the gold-DB-init side effects
 * at module load and so the route module itself stays DB-free. The job_id we
 * echo back is the generated pull id (the pulls/<id>/ folder namespace); the
 * admin-action queue row carries it in its payload for the worker to claim.
 */
interface SharedAdminQueue {
  readonly enqueueResearchPull: (payload: {
    readonly scope: string;
    readonly requestedBy?: string;
    readonly payloadJson: Record<string, unknown>;
  }) => unknown;
}

interface SharedExportQueue {
  readonly enqueueResearchExport: (payload: {
    readonly scope: string;
    readonly requestedBy?: string;
    readonly payloadJson: Record<string, unknown>;
  }) => unknown;
}

function isSharedAdminQueue(m: unknown): m is SharedAdminQueue {
  return (
    typeof m === "object" &&
    m !== null &&
    "enqueueResearchPull" in m &&
    typeof m.enqueueResearchPull === "function"
  );
}

function isSharedExportQueue(m: unknown): m is SharedExportQueue {
  return (
    typeof m === "object" &&
    m !== null &&
    "enqueueResearchExport" in m &&
    typeof m.enqueueResearchExport === "function"
  );
}

const defaultEnqueuePull: NonNullable<ResearchRoutesOptions["enqueuePull"]> = async ({
  request,
  jobId,
}) => {
  // Non-literal specifier: keeps @signal-console/shared's TS source out of the
  // API tsc program (shared is strict-clean only under its own relaxed
  // tsconfig). Resolved at runtime; the API's own files stay strictly checked.
  const spec: string = "@signal-console/shared";
  const mod: unknown = await import(spec);
  if (!isSharedAdminQueue(mod)) {
    throw new Error("@signal-console/shared does not expose enqueueResearchPull");
  }
  mod.enqueueResearchPull({
    scope: jobId,
    requestedBy: "research-api",
    payloadJson: { jobId, request },
  });
  return { jobId };
};

const defaultEnqueueExport: NonNullable<ResearchRoutesOptions["enqueueExport"]> = async ({
  request,
  jobId,
}) => {
  // Mirrors defaultEnqueuePull: non-literal specifier keeps shared's TS source
  // out of the API tsc program. The admin-action queue row carries the export
  // args in its payload for the worker to claim and run the exporter against the
  // persisted gold corpus.
  const spec: string = "@signal-console/shared";
  const mod: unknown = await import(spec);
  if (!isSharedExportQueue(mod)) {
    throw new Error("@signal-console/shared does not expose enqueueResearchExport");
  }
  mod.enqueueResearchExport({
    scope: jobId,
    requestedBy: "research-api",
    payloadJson: { jobId, request },
  });
  return { jobId };
};

export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: "info" },
  });

  await app.register(authPlugin, options.auth ?? {});

  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Signal Console API",
        version: "0.0.0",
        description: "Read-only API for Signal Console v2 (Recent / Live / Backtest).",
      },
      servers: [{ url: `http://${DEFAULT_HOST}:${DEFAULT_PORT}` }],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
  });

  app.get("/openapi.json", (_request, reply) => {
    reply.send(app.swagger());
  });

  await app.register(healthRoutes, options.health ?? {});
  await app.register(gamesRoutes, options.games ?? {});
  await app.register(incidentsRoutes, options.incidents ?? {});
  await app.register(settingsRoutes, options.settings ?? {});
  await app.register(cacheRoutes, options.cache ?? {});
  await app.register(boardRoutes, options.board ?? {});
  await app.register(backtestRoutes, options.backtest ?? {});
  await app.register(liveRoutes, options.live ?? {});
  await app.register(microstructureRoutes, options.microstructure ?? {});
  await app.register(detectorsRoutes, options.detectors ?? {});
  await app.register(offPricePrintRoutes, options.offPricePrint ?? {});
  await app.register(ensembleOrRoutes, options.ensembleOr ?? {});
  await app.register(researchRoutes, {
    enqueuePull: defaultEnqueuePull,
    enqueueExport: defaultEnqueueExport,
    ...(options.research ?? {}),
  });

  // Fastify instances are thenable (await app === app.ready()); awaiting here
  // satisfies @typescript-eslint/return-await:always and gives callers a
  // ready-to-inject server.
  return await app;
}

export function resolvePort(): number {
  const raw = process.env["SIGNAL_CONSOLE_API_PORT"];
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`invalid SIGNAL_CONSOLE_API_PORT: ${raw}`);
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`invalid SIGNAL_CONSOLE_API_PORT: ${raw}`);
  }
  return parsed;
}

function resolveHost(): string {
  const raw = process.env["SIGNAL_CONSOLE_API_HOST"];
  return raw === undefined || raw === "" ? DEFAULT_HOST : raw;
}

async function start(): Promise<void> {
  const host = resolveHost();
  const port = resolvePort();
  const app = await buildServer();
  await app.listen({ host, port });
  app.log.info({ host, port }, "ready");
}

const argv1 = process.argv[1];
const isMain = argv1 !== undefined && fileURLToPath(import.meta.url) === resolve(argv1);
if (isMain) {
  await start();
}
