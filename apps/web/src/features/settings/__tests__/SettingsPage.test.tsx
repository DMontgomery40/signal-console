import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReactNode, JSX } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  BOARD_MAD_BASELINE_MODE_HISTORICAL_BLEND,
  BOARD_MAD_BASELINE_MODE_DEFAULT,
  BOARD_MAD_BASELINE_MODE_OPENING_RAMP,
  BOARD_MAD_BASELINE_MODE_TRAILING,
  BOARD_MAD_BUCKET_SECONDS_DEFAULT,
  BOARD_MAD_FRESH_CAP_SECONDS_DEFAULT,
  BOARD_MAD_HISTORICAL_AWAY_WEIGHT_DEFAULT,
  BOARD_MAD_HISTORICAL_LAST_GAMES_DEFAULT,
  BOARD_MAD_HISTORICAL_PRIOR_WEIGHT_DEFAULT,
  BOARD_MAD_HISTORICAL_RAMP_COMPLETE_GAME_MINUTES_DEFAULT,
  BOARD_MAD_K_MAD_MAX,
  BOARD_MAD_K_MAD_MIN,
  BOARD_MAD_OPENING_BASELINE_BUCKETS_DEFAULT,
  BOARD_MAD_OPENING_BASELINE_BUCKETS_MAX,
  BOARD_MAD_OPENING_BASELINE_BUCKETS_MIN,
  BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_DEFAULT,
  BOARD_MAD_RECENT_WALL_MINUTES_DEFAULT,
  BOARD_MAD_RECENT_WALL_WEIGHT_DEFAULT,
  BOARD_MAD_TRAILING_BUCKETS_DEFAULT,
  BOARD_MAD_TRAILING_GAME_MINUTES_DEFAULT,
  BOARD_MAD_WARMUP_BUCKETS_DEFAULT,
  K_MAD_LIVE,
} from "@signal-console/detectors/board-mad/config";
import { BOARD_STATE_SPACE_CONFIG_DEFAULTS } from "@signal-console/detectors/board-mad/state-space-config";

import { SettingsPage } from "../SettingsPage";
import { STATE_SPACE_GUIDED_FIELDS } from "../../state-space-guided-fields";

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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asRecord(v: unknown, name: string): Record<string, unknown> {
  if (!isRecord(v)) throw new Error(`${name} is not an object`);
  return v;
}

// JSON.parse returns `any` — narrow to `unknown` so subsequent type-guards
// drive shape checking instead of a free cast.
function parseJsonUnknown(s: string): unknown {
  const v: unknown = JSON.parse(s);
  return v;
}

interface DetectorDefaultsFixture {
  readonly kMadLive: number;
  readonly baselineMode:
    | typeof BOARD_MAD_BASELINE_MODE_OPENING_RAMP
    | typeof BOARD_MAD_BASELINE_MODE_TRAILING
    | typeof BOARD_MAD_BASELINE_MODE_HISTORICAL_BLEND;
  readonly bucketSeconds: number;
  readonly openingBaselineBuckets: number;
  readonly openingRampCompleteBuckets: number;
  readonly trailingBuckets: number;
  readonly warmupBuckets: number;
  readonly freshCapSeconds: number;
  readonly historicalLastGames: number;
  readonly historicalAwayWeight: number;
  readonly historicalPriorWeight: number;
  readonly historicalRampCompleteGameMinutes: number;
  readonly trailingGameMinutes: number;
  readonly recentWallMinutes: number;
  readonly recentWallWeight: number;
  readonly pbpPreBufferMs: number;
  readonly pbpPostBufferMs: number;
  readonly stateSpace: Record<string, unknown>;
}

const DEFAULT_DETECTOR_DEFAULTS: DetectorDefaultsFixture = {
  kMadLive: K_MAD_LIVE,
  baselineMode: BOARD_MAD_BASELINE_MODE_DEFAULT,
  bucketSeconds: BOARD_MAD_BUCKET_SECONDS_DEFAULT,
  openingBaselineBuckets: BOARD_MAD_OPENING_BASELINE_BUCKETS_DEFAULT,
  openingRampCompleteBuckets: BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_DEFAULT,
  trailingBuckets: BOARD_MAD_TRAILING_BUCKETS_DEFAULT,
  warmupBuckets: BOARD_MAD_WARMUP_BUCKETS_DEFAULT,
  freshCapSeconds: BOARD_MAD_FRESH_CAP_SECONDS_DEFAULT,
  historicalLastGames: BOARD_MAD_HISTORICAL_LAST_GAMES_DEFAULT,
  historicalAwayWeight: BOARD_MAD_HISTORICAL_AWAY_WEIGHT_DEFAULT,
  historicalPriorWeight: BOARD_MAD_HISTORICAL_PRIOR_WEIGHT_DEFAULT,
  historicalRampCompleteGameMinutes: BOARD_MAD_HISTORICAL_RAMP_COMPLETE_GAME_MINUTES_DEFAULT,
  trailingGameMinutes: BOARD_MAD_TRAILING_GAME_MINUTES_DEFAULT,
  recentWallMinutes: BOARD_MAD_RECENT_WALL_MINUTES_DEFAULT,
  recentWallWeight: BOARD_MAD_RECENT_WALL_WEIGHT_DEFAULT,
  pbpPreBufferMs: 5 * 60 * 1000,
  pbpPostBufferMs: 60_000,
  stateSpace: BOARD_STATE_SPACE_CONFIG_DEFAULTS,
};

interface SettingsFixture {
  readonly mode?: "read-only" | "error";
  readonly sizeBytes?: number;
  readonly openError?: string;
  readonly paused?: boolean;
  readonly errors?: ReadonlyArray<{ level: string; message: string; time: string | null }>;
  readonly detectors?: ReadonlyArray<{ id: string; version: string }>;
  readonly detectorDefaults?: Partial<DetectorDefaultsFixture>;
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
    detectorDefaults: { ...DEFAULT_DETECTOR_DEFAULTS, ...fixture.detectorDefaults },
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

  it("renders five sections backed by /v1/settings (US-053 adds detector-defaults above db)", async () => {
    fetchMock.mockImplementation(async () => {
      await Promise.resolve();
      return jsonResponse(makeSettings());
    });

    render(<SettingsPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("settings-db")).toBeDefined();
    });
    expect(screen.getByTestId("settings-detector-defaults")).toBeDefined();
    expect(screen.getByTestId("settings-sources")).toBeDefined();
    expect(screen.getByTestId("settings-errors")).toBeDefined();
    expect(screen.getByTestId("settings-about")).toBeDefined();
  });

  it("labels the page as live runtime controls instead of a read-only diagnostic surface", async () => {
    fetchMock.mockImplementation(async () => {
      await Promise.resolve();
      return jsonResponse(makeSettings());
    });

    render(<SettingsPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("settings-meta").textContent).toBe("live runtime controls");
    });
    expect(screen.getByText(/Changes apply within a few seconds/)).toBeDefined();
    expect(screen.queryByText(/detector-defaults\.json/)).toBeNull();
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

describe("SettingsPage > Detector defaults (US-053)", () => {
  let fetchMock: ReturnType<typeof vi.fn<FetchFn>>;
  beforeEach(() => {
    fetchMock = vi.fn<FetchFn>();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders one editable row per field with current server value", async () => {
    fetchMock.mockImplementation(async () => {
      await Promise.resolve();
      return jsonResponse(
        makeSettings({
          detectorDefaults: {
            kMadLive: 4.5,
            trailingBuckets: 30,
            warmupBuckets: 8,
            freshCapSeconds: 300,
            pbpPreBufferMs: 5 * 60 * 1000,
            pbpPostBufferMs: 60_000,
          },
        }),
      );
    });

    render(<SettingsPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("settings-detector-defaults")).toBeDefined();
    });
    const rows = screen.getAllByTestId("detector-default-row");
    // Off-price thresholds and the advanced state-space JSON editor are now
    // surfaced in Settings. Was 18, then 20, now 21.
    expect(rows.length).toBe(21);
    const baselineMode = screen.getByTestId("detector-default-input-baselineMode");
    if (!(baselineMode instanceof HTMLSelectElement)) throw new Error("not select");
    expect(baselineMode.value).toBe(BOARD_MAD_BASELINE_MODE_DEFAULT);
    const k = screen.getByTestId("detector-default-input-kMadLive");
    if (!(k instanceof HTMLInputElement)) throw new Error("not input");
    expect(k.value).toBe("4.5");
    expect(k.getAttribute("min")).toBe(String(BOARD_MAD_K_MAD_MIN));
    expect(k.getAttribute("max")).toBe(String(BOARD_MAD_K_MAD_MAX));
    const opening = screen.getByTestId("detector-default-input-openingBaselineBuckets");
    if (!(opening instanceof HTMLInputElement)) throw new Error("not input");
    expect(opening.value).toBe(String(BOARD_MAD_OPENING_BASELINE_BUCKETS_DEFAULT));
    expect(opening.getAttribute("min")).toBe(String(BOARD_MAD_OPENING_BASELINE_BUCKETS_MIN));
    expect(opening.getAttribute("max")).toBe(String(BOARD_MAD_OPENING_BASELINE_BUCKETS_MAX));
    const trail = screen.getByTestId("detector-default-input-trailingBuckets");
    if (!(trail instanceof HTMLInputElement)) throw new Error("not input");
    expect(trail.value).toBe("30");
  });

  it("POSTs /v1/settings/detector-defaults on blur with the full payload", async () => {
    const responses = [
      makeSettings(),
      // After write, the API echoes the full settings; reflect the new K.
      makeSettings({
        detectorDefaults: {
          kMadLive: 5.5,
          trailingBuckets: 20,
          warmupBuckets: 8,
          freshCapSeconds: 300,
          pbpPreBufferMs: 5 * 60 * 1000,
          pbpPostBufferMs: 60_000,
        },
      }),
    ];
    let getCount = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = urlOf(input);
      await Promise.resolve();
      if (url.startsWith("/v1/settings/detector-defaults") && init?.method === "POST") {
        return jsonResponse({
          ...DEFAULT_DETECTOR_DEFAULTS,
          kMadLive: 5.5,
        });
      }
      const body = responses[Math.min(getCount, responses.length - 1)];
      getCount += 1;
      return jsonResponse(body);
    });

    render(<SettingsPage />, { wrapper: makeWrapper() });

    const k = await waitFor(() => screen.getByTestId("detector-default-input-kMadLive"));
    if (!(k instanceof HTMLInputElement)) throw new Error("not input");
    fireEvent.change(k, { target: { value: "5.5" } });
    fireEvent.blur(k);

    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter((c) => {
        const url = urlOf(c[0]);
        return url.startsWith("/v1/settings/detector-defaults") && c[1]?.method === "POST";
      });
      expect(posts.length).toBe(1);
    });
    const post = fetchMock.mock.calls.find((c) => {
      const url = urlOf(c[0]);
      return url.startsWith("/v1/settings/detector-defaults") && c[1]?.method === "POST";
    });
    if (post === undefined) throw new Error("missing POST");
    const body = post[1]?.body;
    if (typeof body !== "string") throw new Error("body not string");
    const parsed = parseJsonUnknown(body);
    const obj = asRecord(parsed, "body");
    expect(obj["kMadLive"]).toBe(5.5);
    expect(obj["baselineMode"]).toBe(BOARD_MAD_BASELINE_MODE_DEFAULT);
    expect(obj["bucketSeconds"]).toBe(BOARD_MAD_BUCKET_SECONDS_DEFAULT);
    expect(obj["openingBaselineBuckets"]).toBe(BOARD_MAD_OPENING_BASELINE_BUCKETS_DEFAULT);
    expect(obj["openingRampCompleteBuckets"]).toBe(BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_DEFAULT);
    expect(obj["trailingBuckets"]).toBe(BOARD_MAD_TRAILING_BUCKETS_DEFAULT);
    expect(obj["warmupBuckets"]).toBe(BOARD_MAD_WARMUP_BUCKETS_DEFAULT);
    expect(obj["historicalLastGames"]).toBe(BOARD_MAD_HISTORICAL_LAST_GAMES_DEFAULT);
    expect(obj["historicalAwayWeight"]).toBe(BOARD_MAD_HISTORICAL_AWAY_WEIGHT_DEFAULT);
    expect(obj["historicalPriorWeight"]).toBe(BOARD_MAD_HISTORICAL_PRIOR_WEIGHT_DEFAULT);
    expect(obj["historicalRampCompleteGameMinutes"]).toBe(
      BOARD_MAD_HISTORICAL_RAMP_COMPLETE_GAME_MINUTES_DEFAULT,
    );
    expect(obj["trailingGameMinutes"]).toBe(BOARD_MAD_TRAILING_GAME_MINUTES_DEFAULT);
    expect(obj["recentWallMinutes"]).toBe(BOARD_MAD_RECENT_WALL_MINUTES_DEFAULT);
    expect(obj["recentWallWeight"]).toBe(BOARD_MAD_RECENT_WALL_WEIGHT_DEFAULT);
    expect(obj["stateSpace"]).toEqual(BOARD_STATE_SPACE_CONFIG_DEFAULTS);
  });

  it("POSTs the nested stateSpace object when a guided model control changes", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = urlOf(input);
      await Promise.resolve();
      if (url.startsWith("/v1/settings/detector-defaults") && init?.method === "POST") {
        return jsonResponse({
          ...DEFAULT_DETECTOR_DEFAULTS,
          stateSpace: {
            ...BOARD_STATE_SPACE_CONFIG_DEFAULTS,
            trigger: {
              ...BOARD_STATE_SPACE_CONFIG_DEFAULTS.trigger,
              enterOffset: 1.4,
            },
          },
        });
      }
      return jsonResponse(makeSettings());
    });

    render(<SettingsPage />, { wrapper: makeWrapper() });

    const input = await waitFor(() =>
      screen.getByTestId("detector-default-input-stateSpace-trigger-enterOffset"),
    );
    if (!(input instanceof HTMLInputElement)) throw new Error("not input");
    fireEvent.change(input, { target: { value: "1.4" } });
    fireEvent.blur(input);

    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter((c) => {
        const url = urlOf(c[0]);
        return url.startsWith("/v1/settings/detector-defaults") && c[1]?.method === "POST";
      });
      expect(posts.length).toBe(1);
    });
    const post = fetchMock.mock.calls.find((c) => {
      const url = urlOf(c[0]);
      return url.startsWith("/v1/settings/detector-defaults") && c[1]?.method === "POST";
    });
    if (post === undefined) throw new Error("missing POST");
    const body = post[1]?.body;
    if (typeof body !== "string") throw new Error("body not string");
    const obj = asRecord(parseJsonUnknown(body), "body");
    const stateSpace = asRecord(obj["stateSpace"], "stateSpace");
    const trigger = asRecord(stateSpace["trigger"], "trigger");
    expect(trigger["enterOffset"]).toBe(1.4);
  });

  it("renders a direct numeric control for every state-space field", async () => {
    fetchMock.mockImplementation(async () => {
      await Promise.resolve();
      return jsonResponse(makeSettings());
    });

    render(<SettingsPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getAllByTestId(/^detector-default-input-stateSpace-/)).toHaveLength(
        STATE_SPACE_GUIDED_FIELDS.length,
      );
    });
    expect(
      screen.getByTestId("detector-default-input-stateSpace-sourceTrust-sourceCountExponent"),
    ).toBeDefined();
    expect(screen.getByTestId("detector-default-input-stateSpace-scale-madScale")).toBeDefined();
  });

  it("profile promotion opens a confirmation and schedules the historical defaults", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = urlOf(input);
      await Promise.resolve();
      if (url.startsWith("/v1/settings/detector-defaults/schedule") && init?.method === "POST") {
        return jsonResponse({ scheduled: true });
      }
      return jsonResponse(makeSettings());
    });

    render(<SettingsPage />, { wrapper: makeWrapper() });

    const profile = await waitFor(() => screen.getByTestId("detector-default-profile"));
    if (!(profile instanceof HTMLSelectElement)) throw new Error("not select");
    fireEvent.change(profile, { target: { value: "historical-blend" } });

    const dialog = await waitFor(() => screen.getByTestId("detector-profile-confirmation"));
    expect(dialog.textContent).toContain("Recent and Live");
    expect(dialog.textContent).toContain("Rollback");
    expect(dialog.textContent).toContain("live defaults store");
    expect(dialog.textContent).not.toContain("detector-defaults.json");
    fireEvent.click(screen.getByTestId("detector-profile-schedule"));

    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter((c) => {
        const url = urlOf(c[0]);
        return url.startsWith("/v1/settings/detector-defaults/schedule") && c[1]?.method === "POST";
      });
      expect(posts.length).toBe(1);
    });
    const post = fetchMock.mock.calls.find((c) => {
      const url = urlOf(c[0]);
      return url.startsWith("/v1/settings/detector-defaults/schedule") && c[1]?.method === "POST";
    });
    if (post === undefined) throw new Error("missing schedule POST");
    const body = post[1]?.body;
    if (typeof body !== "string") throw new Error("body not string");
    const obj = asRecord(parseJsonUnknown(body), "body");
    const defaults = asRecord(obj["defaults"], "defaults");
    expect(obj["effectiveAt"]).toMatch(/T09:00:00\.000Z$/);
    expect(defaults["baselineMode"]).toBe(BOARD_MAD_BASELINE_MODE_HISTORICAL_BLEND);
    expect(defaults["bucketSeconds"]).toBe(30);
    expect(defaults["openingBaselineBuckets"]).toBe(3);
    expect(defaults["openingRampCompleteBuckets"]).toBe(16);
    expect(defaults["trailingBuckets"]).toBe(24);
    expect(defaults["warmupBuckets"]).toBe(4);
    expect(defaults["historicalLastGames"]).toBe(BOARD_MAD_HISTORICAL_LAST_GAMES_DEFAULT);
    expect(defaults["historicalAwayWeight"]).toBe(BOARD_MAD_HISTORICAL_AWAY_WEIGHT_DEFAULT);
    expect(defaults["historicalPriorWeight"]).toBe(BOARD_MAD_HISTORICAL_PRIOR_WEIGHT_DEFAULT);
    expect(defaults["historicalRampCompleteGameMinutes"]).toBe(
      BOARD_MAD_HISTORICAL_RAMP_COMPLETE_GAME_MINUTES_DEFAULT,
    );
    expect(defaults["trailingGameMinutes"]).toBe(BOARD_MAD_TRAILING_GAME_MINUTES_DEFAULT);
    expect(defaults["recentWallMinutes"]).toBe(BOARD_MAD_RECENT_WALL_MINUTES_DEFAULT);
    expect(defaults["recentWallWeight"]).toBe(BOARD_MAD_RECENT_WALL_WEIGHT_DEFAULT);
  });

  it("POSTs the full detector-default payload when prior sample changes", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = urlOf(input);
      await Promise.resolve();
      if (url.startsWith("/v1/settings/detector-defaults") && init?.method === "POST") {
        return jsonResponse({
          ...DEFAULT_DETECTOR_DEFAULTS,
          baselineMode: BOARD_MAD_BASELINE_MODE_TRAILING,
        });
      }
      return jsonResponse(makeSettings());
    });

    render(<SettingsPage />, { wrapper: makeWrapper() });

    const baselineMode = await waitFor(() =>
      screen.getByTestId("detector-default-input-baselineMode"),
    );
    if (!(baselineMode instanceof HTMLSelectElement)) throw new Error("not select");
    fireEvent.change(baselineMode, { target: { value: BOARD_MAD_BASELINE_MODE_TRAILING } });

    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter((c) => {
        const url = urlOf(c[0]);
        return url.startsWith("/v1/settings/detector-defaults") && c[1]?.method === "POST";
      });
      expect(posts.length).toBe(1);
    });
    const post = fetchMock.mock.calls.find((c) => {
      const url = urlOf(c[0]);
      return url.startsWith("/v1/settings/detector-defaults") && c[1]?.method === "POST";
    });
    if (post === undefined) throw new Error("missing POST");
    const body = post[1]?.body;
    if (typeof body !== "string") throw new Error("body not string");
    const obj = asRecord(parseJsonUnknown(body), "body");
    expect(obj["baselineMode"]).toBe(BOARD_MAD_BASELINE_MODE_TRAILING);
    expect(obj["openingBaselineBuckets"]).toBe(BOARD_MAD_OPENING_BASELINE_BUCKETS_DEFAULT);
    expect(obj["openingRampCompleteBuckets"]).toBe(BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_DEFAULT);
    expect(obj["trailingBuckets"]).toBe(BOARD_MAD_TRAILING_BUCKETS_DEFAULT);
  });

  it("Reset to default appears only when value differs from baseline + restores it on click", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = urlOf(input);
      await Promise.resolve();
      if (url.startsWith("/v1/settings/detector-defaults") && init?.method === "POST") {
        return jsonResponse({
          ...DEFAULT_DETECTOR_DEFAULTS,
        });
      }
      return jsonResponse(
        makeSettings({
          detectorDefaults: {
            kMadLive: 4.5,
            trailingBuckets: 20,
            warmupBuckets: 8,
            freshCapSeconds: 300,
            pbpPreBufferMs: 5 * 60 * 1000,
            pbpPostBufferMs: 60_000,
          },
        }),
      );
    });

    render(<SettingsPage />, { wrapper: makeWrapper() });

    // K=4.5 differs from baseline 3.0 → Reset appears.
    const resetK = await waitFor(() => screen.getByTestId("detector-default-reset-kMadLive"));
    expect(resetK).toBeDefined();
    // trailingBuckets=20 matches baseline → no Reset link.
    expect(screen.queryByTestId("detector-default-reset-trailingBuckets")).toBeNull();

    fireEvent.click(resetK);
    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter((c) => {
        const url = urlOf(c[0]);
        return url.startsWith("/v1/settings/detector-defaults") && c[1]?.method === "POST";
      });
      expect(posts.length).toBe(1);
    });
    const post = fetchMock.mock.calls.find((c) => {
      const url = urlOf(c[0]);
      return url.startsWith("/v1/settings/detector-defaults") && c[1]?.method === "POST";
    });
    if (post === undefined) throw new Error("missing POST");
    const body = post[1]?.body;
    if (typeof body !== "string") throw new Error("body not string");
    const parsed = parseJsonUnknown(body);
    const obj = asRecord(parsed, "body");
    expect(obj["kMadLive"]).toBe(K_MAD_LIVE);
  });

  it("renders ExplainerCard wrappers for every Detector defaults field label", async () => {
    fetchMock.mockImplementation(async () => {
      await Promise.resolve();
      return jsonResponse(makeSettings());
    });
    render(<SettingsPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("settings-detector-defaults")).toBeDefined();
    });
    // ExplainerCard renders a trigger; under jsdom the wrapper places the
    // child inside an interactive span. Probe presence by walking the DOM
    // of each label cell and asserting an explainer-trigger span exists.
    const rows = screen.getAllByTestId("detector-default-row");
    for (const row of rows) {
      const dt = row.querySelector("dt");
      if (dt === null) throw new Error("missing dt");
      const trigger = dt.querySelector("[data-explainer-id]");
      // The ExplainerCard primitive marks its trigger with
      // data-explainer-id; if the wrapper changes, this assertion
      // catches that the label is no longer wrapped.
      expect(trigger).not.toBeNull();
    }
  });
});
