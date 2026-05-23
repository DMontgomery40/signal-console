import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/server";

type FastifyApp = Awaited<ReturnType<typeof buildServer>>;

const ctx: { current: FastifyApp | null } = { current: null };

beforeEach(async () => {
  const app = await buildServer();
  await app.ready();
  ctx.current = app;
});

afterEach(async () => {
  if (ctx.current !== null) {
    await ctx.current.close();
    ctx.current = null;
  }
});

function getApp(): FastifyApp {
  if (ctx.current === null) {
    throw new Error("app not initialised");
  }
  return ctx.current;
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
    const res = await getApp().inject({ method: "GET", url: "/openapi.json" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    const body: unknown = res.json();
    expect(isValidOpenApiDoc(body)).toBe(true);
  });

  it("registers @fastify/swagger-ui at /docs/", async () => {
    const res = await getApp().inject({ method: "GET", url: "/docs/" });
    expect([200, 302]).toContain(res.statusCode);
  });
});
