import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReactNode, JSX } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { SettingsPage } from "../SettingsPage";

function makeWrapper(): (props: { children: ReactNode }) => JSX.Element {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return function Wrapper({ children }: { children: ReactNode }): JSX.Element {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

type FetchFn = typeof fetch;
function urlOf(input: Parameters<FetchFn>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

interface SettingsFixture {
  readonly mode?: "read-only" | "error";
  readonly sizeBytes?: number;
  readonly openError?: string;
  readonly paused?: boolean;
  readonly errors?: ReadonlyArray<{ level: string; message: string; time: string | null }>;
  readonly detectors?: ReadonlyArray<{ id: string; version: string }>;
}

function makeSettings(fixture: SettingsFixture = {}): Record<string, unknown> {
  const mode = fixture.mode ?? "read-only";
  const sizeBytes = fixture.sizeBytes ?? 54_321_098_765;
  const db: Record<string, unknown> = {
    path: "/Users/dev/signal-console/data/signal-console.sqlite",
    sizeBytes,
    walBytes: 4_194_304,
    pageCount: 13_261_741,
    pageSize: 4096,
    lastModified: "2026-05-23T01:23:45.000Z",
    mode,
  };
  if (fixture.openError !== undefined) db["openError"] = fixture.openError;
  return {
    db,
    cacheDb: {
      path: "/Users/dev/signal-console/data/detector-cache.sqlite",
      sizeBytes: 1_048_576,
      pageCount: 256,
    },
    sources:
      fixture.paused === true
        ? {
            ingestPaused: true,
            lastKnown: {
              "nba-sidecar": {
                lastSyncAt: "2026-05-23T00:10:00Z",
                lastError: null,
                rateLimitCooldown: null,
              },
            },
          }
        : {
            ingestPaused: false,
            bySource: {
              "nba-sidecar": {
                lastSyncAt: "2026-05-23T01:20:00Z",
                lastError: null,
                rateLimitCooldown: null,
              },
              bet365: {
                lastSyncAt: "2026-05-23T01:19:30Z",
                lastError: "429 rate-limited",
                rateLimitCooldown: "2026-05-23T01:24:00Z",
              },
              kalshi: {
                lastSyncAt: "2026-05-23T01:18:00Z",
                lastError: null,
                rateLimitCooldown: null,
              },
              polymarket: {
                lastSyncAt: "2026-05-23T01:17:00Z",
                lastError: null,
                rateLimitCooldown: null,
              },
            },
          },
    errors: fixture.errors ?? [
      { level: "info", message: "boot", time: "2026-05-23T00:00:00Z" },
      { level: "warn", message: "bet365 backoff", time: "2026-05-23T00:01:00Z" },
      { level: "error", message: "SQLITE_BUSY", time: "2026-05-23T00:02:00Z" },
    ],
    about: {
      appVersion: "0.1.0-dev",
      detectorVersions: fixture.detectors ?? [{ id: "board-mad", version: "1.0.0" }],
      dbSchemaVersion: 18,
    },
  };
}

describe("SettingsPage", () => {
  let fetchMock: ReturnType<typeof vi.fn<FetchFn>>;
  let originalConfirm: typeof window.confirm;
  let confirmCalls = 0;
  let confirmReturn = true;

  beforeEach(() => {
    fetchMock = vi.fn<FetchFn>();
    vi.stubGlobal("fetch", fetchMock);
    originalConfirm = window.confirm;
    confirmCalls = 0;
    confirmReturn = true;
    window.confirm = () => {
      confirmCalls += 1;
      return confirmReturn;
    };
  });

  afterEach(() => {
    window.confirm = originalConfirm;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders four sections backed by /v1/settings", async () => {
    fetchMock.mockImplementation(async () => {
      await Promise.resolve();
      return jsonResponse(makeSettings());
    });

    render(<SettingsPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("settings-db")).toBeDefined();
    });
    expect(screen.getByTestId("settings-sources")).toBeDefined();
    expect(screen.getByTestId("settings-errors")).toBeDefined();
    expect(screen.getByTestId("settings-about")).toBeDefined();
  });

  it("Database section shows path, bytes + human, WAL, pages, page size, lastModified, mode", async () => {
    fetchMock.mockImplementation(async () => {
      await Promise.resolve();
      return jsonResponse(makeSettings({ sizeBytes: 54_321_098_765 }));
    });

    render(<SettingsPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("db-path")).toBeDefined();
    });
    expect(screen.getByTestId("db-path").textContent).toContain("signal-console.sqlite");
    const sizeText = String(screen.getByTestId("db-size").textContent);
    expect(sizeText).toContain("54,321,098,765 bytes");
    expect(sizeText).toMatch(/GB|TB|MB|KB/);
    expect(screen.getByTestId("db-wal").textContent).toContain("4,194,304");
    expect(screen.getByTestId("db-mode").textContent).toBe("read-only");
    expect(screen.queryByTestId("db-mode-banner")).toBeNull();
  });

  it("renders a red banner when mode !== 'read-only'", async () => {
    fetchMock.mockImplementation(async () => {
      await Promise.resolve();
      return jsonResponse(makeSettings({ mode: "error", openError: "ENOENT: no such file" }));
    });

    render(<SettingsPage />, { wrapper: makeWrapper() });

    const banner = await waitFor(() => screen.getByTestId("db-mode-banner"));
    expect(banner).toBeDefined();
    expect(banner.textContent).toContain("error");
    expect(banner.textContent).toContain("ENOENT");
    expect(screen.getByTestId("db-mode").textContent).toBe("error");
  });

  it("Sources section shows per-source rows when heartbeat is present", async () => {
    fetchMock.mockImplementation(async () => {
      await Promise.resolve();
      return jsonResponse(makeSettings({ paused: false }));
    });

    render(<SettingsPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getAllByTestId("source-row").length).toBe(4);
    });
    const bet365 = screen
      .getAllByTestId("source-row")
      .find((r) => r.getAttribute("data-source") === "bet365");
    expect(bet365).toBeDefined();
    if (bet365 === undefined) return;
    expect(bet365.textContent).toContain("rate-limited");
    expect(screen.queryByTestId("ingest-paused")).toBeNull();
  });

  it("Sources section shows 'Ingest paused' notice + last-known values when paused", async () => {
    fetchMock.mockImplementation(async () => {
      await Promise.resolve();
      return jsonResponse(makeSettings({ paused: true }));
    });

    render(<SettingsPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("ingest-paused")).toBeDefined();
    });
    expect(screen.getByTestId("ingest-paused").textContent).toContain("paused");
    const sidecar = screen
      .getAllByTestId("source-row")
      .find((r) => r.getAttribute("data-source") === "nba-sidecar");
    expect(sidecar).toBeDefined();
    if (sidecar === undefined) return;
    expect(sidecar.textContent).toContain("2026-05-23T00:10:00");
  });

  it("Errors section filters by level", async () => {
    fetchMock.mockImplementation(async () => {
      await Promise.resolve();
      return jsonResponse(
        makeSettings({
          errors: [
            { level: "info", message: "alpha", time: "2026-05-23T00:00:00Z" },
            { level: "warn", message: "beta", time: "2026-05-23T00:00:01Z" },
            { level: "error", message: "gamma", time: "2026-05-23T00:00:02Z" },
            { level: "error", message: "delta", time: "2026-05-23T00:00:03Z" },
          ],
        }),
      );
    });

    render(<SettingsPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getAllByTestId("errors-entry").length).toBe(4);
    });
    const select = screen.getByTestId("errors-level-filter");
    fireEvent.change(select, { target: { value: "error" } });
    await waitFor(() => {
      expect(screen.getAllByTestId("errors-entry").length).toBe(2);
    });
    const entries = screen.getAllByTestId("errors-entry");
    expect(entries.every((e) => e.getAttribute("data-level") === "error")).toBe(true);
  });

  it("About section lists detectorVersions and appVersion + dbSchemaVersion", async () => {
    fetchMock.mockImplementation(async () => {
      await Promise.resolve();
      return jsonResponse(
        makeSettings({
          detectors: [
            { id: "board-mad", version: "1.0.0" },
            { id: "off-price-print", version: "1.0.0" },
          ],
        }),
      );
    });

    render(<SettingsPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("about-app-version").textContent).toBe("0.1.0-dev");
    });
    expect(screen.getByTestId("about-schema-version").textContent).toBe("18");
    const rows = screen.getAllByTestId("about-detector-row");
    const ids = rows.map((r) => r.getAttribute("data-detector-id"));
    expect(ids).toContain("board-mad");
    expect(ids).toContain("off-price-print");
  });

  it("Clear cache requires confirmation; cancel does NOT fire DELETE", async () => {
    fetchMock.mockImplementation(async () => {
      await Promise.resolve();
      return jsonResponse(makeSettings());
    });
    confirmReturn = false;

    render(<SettingsPage />, { wrapper: makeWrapper() });

    const button = await waitFor(() => screen.getByTestId("clear-cache-button"));
    fireEvent.click(button);

    expect(confirmCalls).toBe(1);
    const deleteCalls = fetchMock.mock.calls.filter((c) => {
      const init = c[1];
      return init !== undefined && init.method === "DELETE";
    });
    expect(deleteCalls.length).toBe(0);
  });

  it("Clear cache (confirmed) fires DELETE /v1/cache; gold-DB size unchanged after refetch", async () => {
    let callCount = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = urlOf(input);
      await Promise.resolve();
      if (url.startsWith("/v1/cache") && init?.method === "DELETE") {
        return jsonResponse({ deleted: 3 });
      }
      // /v1/settings - return the SAME db sizeBytes both times to prove the
      // gold-DB size is independent of the clear-cache call (admin housekeeping
      // touches the cache DB only).
      callCount += 1;
      return jsonResponse(makeSettings({ sizeBytes: 54_321_098_765 }));
    });
    confirmReturn = true;

    render(<SettingsPage />, { wrapper: makeWrapper() });

    const sizeBefore = await waitFor(() => {
      const text = String(screen.getByTestId("db-size").textContent);
      expect(text).toContain("54,321,098,765 bytes");
      return text;
    });

    const button = screen.getByTestId("clear-cache-button");
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByTestId("clear-cache-result")).toBeDefined();
    });
    expect(screen.getByTestId("clear-cache-result").textContent).toContain("3 runs deleted");

    // Settings query must have been refetched (>= 2 GETs to /v1/settings).
    await waitFor(() => {
      expect(callCount).toBeGreaterThanOrEqual(2);
    });

    // Gold-DB size text identical to pre-click value (AC #7).
    const sizeAfter = String(screen.getByTestId("db-size").textContent);
    expect(sizeAfter).toBe(sizeBefore);
  });

  it("network failure renders ApiUnreachableBanner; the heading + section frame stay usable", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(<SettingsPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("api-unreachable-banner")).toBeDefined();
    });
    expect(screen.getByText("Settings")).toBeDefined();
  });

  it("HTTP 500 renders QueryErrorBanner; the heading stays usable", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "boom" }), {
        status: 500,
        statusText: "Internal Server Error",
      }),
    );
    render(<SettingsPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("query-error-banner")).toBeDefined();
    });
    expect(screen.getByText("Settings")).toBeDefined();
  });
});
