// Fastify server scaffold for the Signal Console API (PRD §13).
// Exports buildServer() so tests can inject() without a real listen,
// and starts the server when this module is the process entrypoint.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyInstance } from "fastify";

import authPlugin, { type AuthPluginOptions } from "./plugins/auth";
import boardRoutes, { type BoardRoutesOptions } from "./routes/board";
import cacheRoutes, { type CacheRoutesOptions } from "./routes/cache";
import gamesRoutes, { type GamesRoutesOptions } from "./routes/games";
import healthRoutes, { type HealthRoutesOptions } from "./routes/health";
import settingsRoutes, { type SettingsRoutesOptions } from "./routes/settings";

const DEFAULT_PORT = 4100;
const DEFAULT_HOST = "localhost";

export interface BuildServerOptions {
  readonly auth?: AuthPluginOptions;
  readonly health?: HealthRoutesOptions;
  readonly games?: GamesRoutesOptions;
  readonly settings?: SettingsRoutesOptions;
  readonly cache?: CacheRoutesOptions;
  readonly board?: BoardRoutesOptions;
}

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
  await app.register(settingsRoutes, options.settings ?? {});
  await app.register(cacheRoutes, options.cache ?? {});
  await app.register(boardRoutes, options.board ?? {});

  // Fastify instances are thenable (await app === app.ready()); awaiting here
  // satisfies @typescript-eslint/return-await:always and gives callers a
  // ready-to-inject server.
  return await app;
}

function resolvePort(): number {
  const raw = process.env["SIGNAL_CONSOLE_API_PORT"];
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
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
