import { afterEach, describe, expect, it, vi } from "vitest";

import playwrightConfig from "../../../../apps/web/playwright.config";
import { defaultApiPort, defaultE2eApiPort, defaultWebPort } from "../ports";

const originalSignalConsoleApiTarget = process.env.SIGNAL_CONSOLE_API_TARGET;
const originalViteApiBaseUrl = process.env.VITE_API_BASE_URL;

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
    expect(defaultApiPort).toBe(8788);
    expect(defaultE2eApiPort).toBe(8787);
    expect(defaultApiPort).not.toBe(defaultE2eApiPort);
    expect(defaultWebPort).toBe(4120);
  });

  it("points the Playwright web runner at the e2e fixture API target", () => {
    const configuredServers = Array.isArray(playwrightConfig.webServer)
      ? playwrightConfig.webServer
      : [playwrightConfig.webServer];
    const webServer = configuredServers.find((entry) => entry?.name === "web");

    expect(webServer?.env?.SIGNAL_CONSOLE_API_TARGET).toBe(
      `http://127.0.0.1:${defaultE2eApiPort}`
    );
  });

  it("exposes SIGNAL_CONSOLE_ env values to the client without mutating VITE_API_BASE_URL", async () => {
    delete process.env.VITE_API_BASE_URL;
    process.env.SIGNAL_CONSOLE_API_TARGET = "http://127.0.0.1:9787";

    const { default: viteConfig } =
      await import("../../../../apps/web/vite.config");

    expect(viteConfig.envPrefix).toEqual(["VITE_", "SIGNAL_CONSOLE_"]);
    expect(process.env.VITE_API_BASE_URL).toBeUndefined();
  });
});
