// X-Signal-Token auth plugin (PRD §13 / US-016).
//
// Validates the X-Signal-Token header against the contents of a token file
// (default ~/.signal-console/token). The token file is the source of truth;
// editing it takes effect at the next request (after a small TTL window),
// so token rotation does NOT require restarting Fastify.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

export interface AuthPluginOptions {
  readonly tokenPath?: string;
  readonly exemptPaths?: readonly string[];
  readonly cacheTtlMs?: number;
}

const DEFAULT_TOKEN_PATH = join(homedir(), ".signal-console", "token");
// /v1/research/guide serves public researcher docs (markdown) and is opened in a
// plain new browser tab that cannot carry the X-Signal-Token header, so it is
// exempt like the liveness probe.
const DEFAULT_EXEMPT_PATHS: readonly string[] = ["/v1/health/live", "/v1/research/guide"];
const DEFAULT_CACHE_TTL_MS = 1000;

interface TokenCache {
  readonly token: string;
  readonly fetchedAt: number;
}

function pathFromUrl(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

const authPlugin: FastifyPluginAsync<AuthPluginOptions> = (app, opts) => {
  const tokenPath = opts.tokenPath ?? DEFAULT_TOKEN_PATH;
  const exemptPaths = opts.exemptPaths ?? DEFAULT_EXEMPT_PATHS;
  const cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

  let cache: TokenCache | null = null;

  async function readExpectedToken(): Promise<string | null> {
    const now = Date.now();
    if (cache !== null && now - cache.fetchedAt < cacheTtlMs) {
      return cache.token;
    }
    try {
      const raw = await readFile(tokenPath, "utf8");
      const token = raw.trim();
      cache = { token, fetchedAt: now };
      return token;
    } catch {
      cache = null;
      return null;
    }
  }

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const path = pathFromUrl(request.url);
    if (exemptPaths.includes(path)) {
      return;
    }

    const provided = request.headers["x-signal-token"];
    const hasProvided = typeof provided === "string" && provided.length > 0;
    const expected = hasProvided ? await readExpectedToken() : null;
    const tokenValid =
      hasProvided && expected !== null && expected.length > 0 && expected === provided;

    if (!tokenValid) {
      await reply.code(401).send({ error: "unauthorized" });
    }
  });

  return Promise.resolve();
};

export default fp(authPlugin, { name: "signal-console-auth" });
