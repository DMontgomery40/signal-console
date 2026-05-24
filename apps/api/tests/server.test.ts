import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultApiPort } from "../../../packages/shared/src/ports";

import { buildServer, resolvePort } from "../src/server";

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

function firstServerUrl(v: unknown): string | null {
  if (typeof v !== "object" || v === null) return null;
  if (!("servers" in v) || !Array.isArray(v.servers)) return null;
  const first: unknown = v.servers[0];
  if (typeof first !== "object" || first === null) return null;
  if (!("url" in first) || typeof first.url !== "string") return null;
  return first.url;
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

  it("uses the shared high dev API port for defaults and OpenAPI server metadata", async () => {
    const previousPort = process.env.SIGNAL_CONSOLE_API_PORT;
    try {
      delete process.env.SIGNAL_CONSOLE_API_PORT;
      expect(resolvePort()).toBe(defaultApiPort);

      const res = await getApp().inject({
        method: "GET",
        url: "/openapi.json",
        headers: authHeaders(),
      });
      const body: unknown = res.json();
      expect(firstServerUrl(body)).toBe(`http://localhost:${String(defaultApiPort)}`);
    } finally {
      if (previousPort === undefined) {
        delete process.env.SIGNAL_CONSOLE_API_PORT;
      } else {
        process.env.SIGNAL_CONSOLE_API_PORT = previousPort;
      }
    }
  });

  it("registers @fastify/swagger-ui at /docs/", async () => {
    const res = await getApp().inject({
      method: "GET",
      url: "/docs/",
      headers: authHeaders(),
    });
    expect([200, 302]).toContain(res.statusCode);
  });

  it("rejects non-integer SIGNAL_CONSOLE_API_PORT values before listen()", () => {
    const previousPort = process.env.SIGNAL_CONSOLE_API_PORT;
    try {
      for (const value of ["32140.5", "1e2", "0", "65536"]) {
        process.env.SIGNAL_CONSOLE_API_PORT = value;
        expect(() => resolvePort()).toThrow(`invalid SIGNAL_CONSOLE_API_PORT: ${value}`);
      }
      process.env.SIGNAL_CONSOLE_API_PORT = "32140";
      expect(resolvePort()).toBe(32140);
    } finally {
      if (previousPort === undefined) {
        delete process.env.SIGNAL_CONSOLE_API_PORT;
      } else {
        process.env.SIGNAL_CONSOLE_API_PORT = previousPort;
      }
    }
  });
});
