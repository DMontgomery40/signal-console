// Fastify server scaffold for the Signal Console API (PRD §13).
// Exports buildServer() so tests can inject() without a real listen,
// and starts the server when this module is the process entrypoint.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyInstance } from "fastify";

const DEFAULT_PORT = 4100;
const DEFAULT_HOST = "localhost";

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: "info" },
  });

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
