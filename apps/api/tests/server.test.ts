import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/server";

type FastifyApp = Awaited<ReturnType<typeof buildServer>>;

const TEST_TOKEN = "scaffold-test-token";

const ctx: { current: FastifyApp | null; tempDir: string; tokenPath: string } = {
  current: null,
  tempDir: "",
  tokenPath: "",
};

beforeEach(async () => {
  ctx.tempDir = mkdtempSync(join(tmpdir(), "signal-console-server-"));
  ctx.tokenPath = join(ctx.tempDir, "token");
  writeFileSync(ctx.tokenPath, `${TEST_TOKEN}\n`, "utf8");
  const app = await buildServer({
    auth: { tokenPath: ctx.tokenPath, cacheTtlMs: 0 },
  });
  await app.ready();
  ctx.current = app;
});

afterEach(async () => {
  if (ctx.current !== null) {
    await ctx.current.close();
    ctx.current = null;
  }
  rmSync(ctx.tempDir, { recursive: true, force: true });
});

function getApp(): FastifyApp {
  if (ctx.current === null) {
    throw new Error("app not initialised");
  }
  return ctx.current;
}

function authHeaders(): { "x-signal-token": string } {
  return { "x-signal-token": TEST_TOKEN };
}

function isValidOpenApiDoc(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  if (!("openapi" in v) || typeof v.openapi !== "string") return false;
  if (!v.openapi.startsWith("3.")) return false;
  if (!("info" in v) || typeof v.info !== "object" || v.info === null) {
    return false;
  }
  if (!("title" in v.info) || typeof v.info.title !== "string") return false;
  return v.info.title.includes("Signal Console API");
}

describe("Fastify server scaffold (US-015)", () => {
  it("GET /openapi.json returns a valid OpenAPI 3.x document", async () => {
    const res = await getApp().inject({
      method: "GET",
      url: "/openapi.json",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    const body: unknown = res.json();
    expect(isValidOpenApiDoc(body)).toBe(true);
  });

  it("registers @fastify/swagger-ui at /docs/", async () => {
    const res = await getApp().inject({
      method: "GET",
      url: "/docs/",
      headers: authHeaders(),
    });
    expect([200, 302]).toContain(res.statusCode);
  });
});
