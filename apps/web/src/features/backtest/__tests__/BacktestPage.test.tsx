// BacktestPage tests (US-035).
//
// Covers the scaffold: form rendering, validation (window span / game id
// cap), POST /v1/backtest submission, results panel population, and the
// round-trip-stability smoke (in-memory recompute on a non-K param).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode, JSX } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { z } from "zod";

import { BacktestPage } from "../BacktestPage";

const postBodySchema = z.object({
  detector_id: z.string(),
  params: z.record(z.unknown()),
  window: z.object({ start: z.string(), end: z.string() }),
  game_ids: z.array(z.string()).optional(),
});

function parsePostBody(body: BodyInit | null | undefined): z.infer<typeof postBodySchema> {
  if (typeof body !== "string") throw new Error("post body is not a string");
  const json: unknown = JSON.parse(body);
  return postBodySchema.parse(json);
}

function makeWrapper(): (props: { children: ReactNode }) => JSX.Element {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
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

const DETECTORS_RESPONSE = {
  detectors: [
    {
      id: "board-mad",
      version: "1.0.0",
      displayName: "Board MAD (whole-board volatility)",
      sources: ["bet365", "kalshi", "polymarket"],
      paramsSchema: {
        type: "object",
        properties: {
          bucketSeconds: { type: "integer", minimum: 10, maximum: 300, default: 60 },
          kMad: { type: "number", minimum: 1, maximum: 12, default: 3 },
          weighting: { type: "string", enum: ["volume", "equal"], default: "volume" },
          trailingBuckets: { type: "integer", minimum: 5, maximum: 60, default: 20 },
          warmupBuckets: { type: "integer", minimum: 2, maximum: 20, default: 8 },
          freshCapSeconds: { type: "integer", minimum: 30, maximum: 3600, default: 300 },
        },
      },
    },
    {
      id: "off-price-print",
      version: "1.0.0",
      displayName: "Off-price print (Polymarket only)",
      sources: ["polymarket"],
      paramsSchema: {
        type: "object",
        properties: {
          minVolumeShare: { type: "number", minimum: 0, maximum: 1, default: 0.1 },
          minOffPriceDistance: { type: "number", minimum: 0, maximum: 1, default: 0.4 },
        },
      },
    },
  ],
};

// Synthetic observations that mimic the prebucket+sweep contract: per-game
// chronological intensity series with baseline median + mad. We can predict
// what the client recompute will produce for a given (kMad, warmupBuckets,
// trailingBuckets) because the algorithm is the same as sweep.ts. For the
// test we build 30 buckets with a steady 1.0 baseline punctuated by a 5.0
// spike at bucket 25, so the spike fires at K=3 with the default
// trailingBuckets=20.
function buildSyntheticBacktest(): {
  readonly runId: number;
  readonly stats: { firesPerGame: number; totalFires: number; gamesInWindow: number };
  readonly observations: readonly {
    gameId: string;
    bucketStart: string;
    bucketEnd: string;
    fired: number;
    intensity: number;
    baselineMedian: number;
    baselineMad: number;
  }[];
} {
  const observations: {
    gameId: string;
    bucketStart: string;
    bucketEnd: string;
    fired: number;
    intensity: number;
    baselineMedian: number;
    baselineMad: number;
  }[] = [];
  for (let i = 0; i < 30; i++) {
    const t = new Date(Date.UTC(2026, 4, 8, 3, i, 0));
    const bucketStart = t.toISOString();
    const bucketEnd = new Date(t.getTime() + 60_000).toISOString();
    const intensity = i === 25 ? 5.0 : 1.0;
    // The shipped backtest sets fired/baseline using the SERVER's params.
    // Echo the K=3 default: trailing 20 buckets of all-1.0 intensities have
    // median 1.0, MAD 0 (clamped to 1e-9), so threshold ~= 1.0 — any value
    // above 1.0 fires after warmup (i >= 8). i==25 has intensity 5 -> fires.
    const fired = i === 25 ? 1 : 0;
    observations.push({
      gameId: "nba-0042500222",
      bucketStart,
      bucketEnd,
      fired,
      intensity,
      baselineMedian: i >= 8 ? 1.0 : 0,
      baselineMad: i >= 8 ? 1e-9 : 0,
    });
  }
  return {
    runId: 42,
    stats: { firesPerGame: 1, totalFires: 1, gamesInWindow: 1 },
    observations,
  };
}

describe("BacktestPage", () => {
  let fetchMock: ReturnType<typeof vi.fn<FetchFn>>;

  beforeEach(() => {
    fetchMock = vi.fn<FetchFn>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function mockDetectors(body: unknown = DETECTORS_RESPONSE): void {
    fetchMock.mockImplementation(async (input) => {
      await Promise.resolve();
      const url = urlOf(input);
      if (url.startsWith("/v1/detectors")) return jsonResponse(body);
      return new Response("not found", { status: 404 });
    });
  }

  function mockDetectorsAndBacktest(backtestBody: unknown): void {
    fetchMock.mockImplementation(async (input, init) => {
      await Promise.resolve();
      const url = urlOf(input);
      if (url.startsWith("/v1/detectors")) return jsonResponse(DETECTORS_RESPONSE);
      if (url.startsWith("/v1/backtest") && init?.method === "POST") {
        return jsonResponse(backtestBody);
      }
      return new Response("not found", { status: 404 });
    });
  }

  it("renders the form scaffold with window, scope, detector, and empty results", async () => {
    mockDetectors();
    render(<BacktestPage />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("backtest-window")).not.toBeNull();
    });
    expect(screen.getByTestId("backtest-scope")).not.toBeNull();
    expect(screen.getByTestId("backtest-detector")).not.toBeNull();
    expect(screen.getByTestId("backtest-results-empty")).not.toBeNull();
    expect(screen.queryByTestId("backtest-run-id")).toBeNull();
  });

  it("defaults the detector selector to board-mad and seeds its param defaults", async () => {
    mockDetectors();
    render(<BacktestPage />, { wrapper: makeWrapper() });
    await waitFor(() => {
      const sel = screen.getByTestId("backtest-detector-select");
      if (!(sel instanceof HTMLSelectElement)) throw new Error("not a select");
      expect(sel.value).toBe("board-mad");
    });
    const k = screen.getByTestId("backtest-param-kMad");
    if (!(k instanceof HTMLInputElement)) throw new Error("kMad is not an input");
    expect(k.value).toBe("3");
    const weighting = screen.getByTestId("backtest-param-weighting");
    if (!(weighting instanceof HTMLSelectElement)) throw new Error("weighting not a select");
    expect(weighting.value).toBe("volume");
  });

  it("blocks the Run button when window exceeds 28 days", async () => {
    mockDetectors();
    render(<BacktestPage />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("backtest-detector-select")).not.toBeNull();
    });
    const startInput = screen.getByTestId("backtest-window-start");
    const endInput = screen.getByTestId("backtest-window-end");
    if (!(startInput instanceof HTMLInputElement)) throw new Error("not an input");
    if (!(endInput instanceof HTMLInputElement)) throw new Error("not an input");
    fireEvent.change(startInput, { target: { value: "2026-01-01" } });
    fireEvent.change(endInput, { target: { value: "2026-03-01" } });
    expect(screen.getByTestId("backtest-window-error").textContent).toMatch(/28 days/);
    const button = screen.getByTestId("backtest-run-button");
    if (!(button instanceof HTMLButtonElement)) throw new Error("not a button");
    expect(button.disabled).toBe(true);
  });

  it("blocks the Run button when more than 20 game ids are pasted", async () => {
    mockDetectors();
    render(<BacktestPage />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("backtest-detector-select")).not.toBeNull();
    });
    const specific = screen.getByTestId("backtest-scope-specific");
    fireEvent.click(specific);
    const ids = Array.from({ length: 21 }, (_, i) => `nba-${String(i).padStart(10, "0")}`).join(
      "\n",
    );
    const ta = screen.getByTestId("backtest-game-ids");
    if (!(ta instanceof HTMLTextAreaElement)) throw new Error("not a textarea");
    fireEvent.change(ta, { target: { value: ids } });
    expect(screen.getByTestId("backtest-scope-error").textContent).toMatch(/21/);
    const button = screen.getByTestId("backtest-run-button");
    if (!(button instanceof HTMLButtonElement)) throw new Error("not a button");
    expect(button.disabled).toBe(true);
  });

  it("POSTs /v1/backtest on Run and renders the response in the results panel", async () => {
    const backtest = buildSyntheticBacktest();
    mockDetectorsAndBacktest(backtest);
    render(<BacktestPage />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("backtest-detector-select")).not.toBeNull();
    });

    fireEvent.click(screen.getByTestId("backtest-run-button"));

    await waitFor(() => {
      expect(screen.getByTestId("backtest-run-id").textContent).toBe("42");
    });
    expect(screen.getByTestId("backtest-stat-fires-per-game").textContent).toBe("1.00");
    expect(screen.getByTestId("backtest-stat-total-fires").textContent).toBe("1");

    const postCalls = fetchMock.mock.calls.filter(([input, init]) => {
      const url = urlOf(input);
      return url.startsWith("/v1/backtest") && init?.method === "POST";
    });
    expect(postCalls.length).toBe(1);
    const [, init] = postCalls[0]!;
    const body = parsePostBody(init?.body);
    expect(body.detector_id).toBe("board-mad");
    expect(body.params["kMad"]).toBe(3);
    expect(body.window.start.startsWith("20")).toBe(true);
    expect(body.window.end.startsWith("20")).toBe(true);
  });

  it("round-trip stability: editing trailingBuckets re-derives fires/game without an API call", async () => {
    const backtest = buildSyntheticBacktest();
    mockDetectorsAndBacktest(backtest);
    render(<BacktestPage />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("backtest-detector-select")).not.toBeNull();
    });

    fireEvent.click(screen.getByTestId("backtest-run-button"));
    await waitFor(() => {
      expect(screen.getByTestId("backtest-run-id").textContent).toBe("42");
    });

    const baseline = screen.getByTestId("backtest-stat-fires-per-game").textContent;
    const postCountBefore = fetchMock.mock.calls.filter(([input, init]) => {
      const url = urlOf(input);
      return url.startsWith("/v1/backtest") && init?.method === "POST";
    }).length;
    expect(postCountBefore).toBe(1);

    // Bump trailingBuckets 20 -> 30 (in-memory recompute path).
    const trailing = screen.getByTestId("backtest-param-trailingBuckets");
    if (!(trailing instanceof HTMLInputElement)) throw new Error("not an input");
    act(() => {
      fireEvent.change(trailing, { target: { value: "30" } });
    });

    // No new POST.
    const postCountAfterEdit = fetchMock.mock.calls.filter(([input, init]) => {
      const url = urlOf(input);
      return url.startsWith("/v1/backtest") && init?.method === "POST";
    }).length;
    expect(postCountAfterEdit).toBe(1);
    // Metric still resolves (the spike still fires above the wider baseline
    // window). The exact value depends on the synthetic series, but it must
    // remain a finite number, which is the round-trip stability check.
    const afterEdit = screen.getByTestId("backtest-stat-fires-per-game").textContent;
    expect(afterEdit).not.toBe("NaN");

    // Revert to 20 — recompute should round-trip back to the baseline value.
    act(() => {
      fireEvent.change(trailing, { target: { value: "20" } });
    });
    const afterRevert = screen.getByTestId("backtest-stat-fires-per-game").textContent;
    expect(afterRevert).toBe(baseline);
  });

  it("marks bucketSeconds / weighting / freshCapSeconds as re-run required and flags stale results", async () => {
    const backtest = buildSyntheticBacktest();
    mockDetectorsAndBacktest(backtest);
    render(<BacktestPage />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("backtest-detector-select")).not.toBeNull();
    });
    expect(screen.getByTestId("backtest-rerun-hint-bucketSeconds")).not.toBeNull();
    expect(screen.getByTestId("backtest-rerun-hint-weighting")).not.toBeNull();
    expect(screen.getByTestId("backtest-rerun-hint-freshCapSeconds")).not.toBeNull();
    expect(screen.queryByTestId("backtest-rerun-hint-kMad")).toBeNull();
    expect(screen.queryByTestId("backtest-rerun-hint-trailingBuckets")).toBeNull();

    fireEvent.click(screen.getByTestId("backtest-run-button"));
    await waitFor(() => {
      expect(screen.getByTestId("backtest-run-id").textContent).toBe("42");
    });

    const weighting = screen.getByTestId("backtest-param-weighting");
    if (!(weighting instanceof HTMLSelectElement)) throw new Error("weighting not a select");
    act(() => {
      fireEvent.change(weighting, { target: { value: "equal" } });
    });

    await waitFor(() => {
      expect(screen.getByTestId("backtest-stale-warning")).not.toBeNull();
    });
  });
});
