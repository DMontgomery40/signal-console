import { afterEach, describe, expect, it, vi } from "vitest";

import playwrightConfig from "../../../../apps/web/playwright.config";
import { defaultApiPort, defaultE2eApiPort, defaultWebPort } from "../ports";

const originalSignalConsoleApiTarget = process.env.SIGNAL_CONSOLE_API_TARGET;
const originalViteApiBaseUrl = process.env.VITE_API_BASE_URL;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readNestedNumber(value: unknown, keys: readonly string[]): number | null {
  let cursor: unknown = value;
  for (const key of keys) {
    if (!isRecord(cursor)) return null;
    cursor = cursor[key];
  }
  return typeof cursor === "number" ? cursor : null;
}

function readV1ProxyTarget(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const server = value["server"];
  if (!isRecord(server)) return null;
  const proxy = server["proxy"];
  if (!isRecord(proxy)) return null;
  const v1 = proxy["/v1"];
  if (!isRecord(v1)) return null;
  const target = v1["target"];
  return typeof target === "string" ? target : null;
}

afterEach(() => {
  vi.resetModules();

  if (originalSignalConsoleApiTarget == null) {
    delete process.env.SIGNAL_CONSOLE_API_TARGET;
  } else {
    process.env.SIGNAL_CONSOLE_API_TARGET = originalSignalConsoleApiTarget;
  }

  if (originalViteApiBaseUrl == null) {
    delete process.env.VITE_API_BASE_URL;
  } else {
    process.env.VITE_API_BASE_URL = originalViteApiBaseUrl;
  }
});

describe("dev port contract", () => {
  it("keeps the live dev API port separate from the e2e fixture API port", () => {
    expect(defaultApiPort).toBe(32140);
    expect(defaultWebPort).toBe(32141);
    expect(defaultE2eApiPort).toBe(32142);
    expect(defaultApiPort).not.toBe(defaultE2eApiPort);
    expect(defaultWebPort).not.toBe(defaultE2eApiPort);
  });

  it("points the Playwright web runner at the e2e fixture API target", () => {
    const configuredServers = Array.isArray(playwrightConfig.webServer)
      ? playwrightConfig.webServer
      : [playwrightConfig.webServer];
    const webServer = configuredServers.find((entry) => entry?.name === "web");

    expect(webServer?.env?.SIGNAL_CONSOLE_API_TARGET).toBe(`http://127.0.0.1:${defaultE2eApiPort}`);
  });

  it("exposes SIGNAL_CONSOLE_ env values to the client without mutating VITE_API_BASE_URL", async () => {
    delete process.env.VITE_API_BASE_URL;
    process.env.SIGNAL_CONSOLE_API_TARGET = "http://127.0.0.1:9787";

    const { default: viteConfig } = await import("../../../../apps/web/vite.config");

    expect(viteConfig.envPrefix).toEqual(["VITE_", "SIGNAL_CONSOLE_"]);
    expect(readNestedNumber(viteConfig, ["server", "port"])).toBe(defaultWebPort);
    expect(readNestedNumber(viteConfig, ["preview", "port"])).toBe(defaultWebPort);
    expect(readV1ProxyTarget(viteConfig)).toBe("http://127.0.0.1:9787");
    expect(process.env.VITE_API_BASE_URL).toBeUndefined();
  });
});
