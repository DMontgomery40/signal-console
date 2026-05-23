// Auth plugin contract tests (US-016).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/server";

type FastifyApp = Awaited<ReturnType<typeof buildServer>>;

interface TestCtx {
  app: FastifyApp | null;
  tempDir: string;
  tokenPath: string;
}

const ctx: TestCtx = { app: null, tempDir: "", tokenPath: "" };

beforeEach(() => {
  ctx.tempDir = mkdtempSync(join(tmpdir(), "signal-console-auth-"));
  ctx.tokenPath = join(ctx.tempDir, "token");
  writeFileSync(ctx.tokenPath, "expected-token-v1\n", "utf8");
});

afterEach(async () => {
  if (ctx.app !== null) {
    await ctx.app.close();
    ctx.app = null;
  }
  rmSync(ctx.tempDir, { recursive: true, force: true });
});

async function startApp(): Promise<FastifyApp> {
  const app = await buildServer({
    auth: { tokenPath: ctx.tokenPath, cacheTtlMs: 0 },
  });
  ctx.app = app;
  return app;
}

describe("auth plugin (US-016)", () => {
  it("returns 401 with { error: 'unauthorized' } when X-Signal-Token is missing", async () => {
    const app = await startApp();
    const res = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthorized" });
  });

  it("returns 401 with { error: 'unauthorized' } when X-Signal-Token is wrong", async () => {
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: "/openapi.json",
      headers: { "x-signal-token": "definitely-not-the-token" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthorized" });
  });

  it("returns 200 with the correct X-Signal-Token", async () => {
    const app = await startApp();
    const res = await app.inject({
      method: "GET",
      url: "/openapi.json",
      headers: { "x-signal-token": "expected-token-v1" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("exempts /v1/health/live from the token check", async () => {
    const app = await startApp();
    // /v1/health/live does not exist as a route yet (US-017 owns that),
    // but the exempt list should still allow the request through to the
    // router. We assert the auth plugin did NOT short-circuit with 401:
    // an unregistered exempt path returns 404 (router) rather than 401 (auth).
    const res = await app.inject({ method: "GET", url: "/v1/health/live" });
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).toBe(404);
  });

  it("picks up a new token after the file is edited (no server restart)", async () => {
    const app = await startApp();

    const before = await app.inject({
      method: "GET",
      url: "/openapi.json",
      headers: { "x-signal-token": "expected-token-v1" },
    });
    expect(before.statusCode).toBe(200);

    // Rotate the on-disk token mid-test.
    writeFileSync(ctx.tokenPath, "rotated-token-v2\n", "utf8");

    // Old token now rejected.
    const stale = await app.inject({
      method: "GET",
      url: "/openapi.json",
      headers: { "x-signal-token": "expected-token-v1" },
    });
    expect(stale.statusCode).toBe(401);

    // New token accepted, without ever restarting the server.
    const fresh = await app.inject({
      method: "GET",
      url: "/openapi.json",
      headers: { "x-signal-token": "rotated-token-v2" },
    });
    expect(fresh.statusCode).toBe(200);
  });

  it("returns 401 when the token file is missing", async () => {
    const missingPath = join(ctx.tempDir, "does-not-exist");
    const app = await buildServer({
      auth: { tokenPath: missingPath, cacheTtlMs: 0 },
    });
    ctx.app = app;
    const res = await app.inject({
      method: "GET",
      url: "/openapi.json",
      headers: { "x-signal-token": "anything" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthorized" });
  });
});
