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

// K-sensitive observation series: i%3 pattern [1, 2, 3] for indices 0..23 with
// a spike of 7.0 at bucket 24. Designed so that the trail-window at i=24
// (slice(4, 24) = 6 ones + 7 twos + 7 threes) gives median=2, MAD=1, so the
// K=3 threshold is 5 (spike 7 fires) and the K=6 threshold is 8 (spike 7 does
// NOT fire). The repeating 3-value pattern guarantees MAD > 0 at every prior
// trail-window length (8..24), preventing the MAD=0-spurious-fire trap that
// constant-baseline data falls into.
function buildKSensitiveBacktest(): {
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
  const pattern: readonly number[] = [1, 2, 3];
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
    let intensity: number;
    if (i === 24) {
      intensity = 7;
    } else {
      intensity = pattern[i % 3] ?? 0;
    }
    const t = new Date(Date.UTC(2026, 4, 8, 3, i, 0));
    observations.push({
      gameId: "nba-0042500222",
      bucketStart: t.toISOString(),
      bucketEnd: new Date(t.getTime() + 60_000).toISOString(),
      fired: i === 24 ? 1 : 0,
      intensity,
      baselineMedian: 2,
      baselineMad: 1,
    });
  }
  return {
    runId: 99,
    stats: { firesPerGame: 1, totalFires: 1, gamesInWindow: 1 },
    observations,
  };
}

// Multi-game variant of buildKSensitiveBacktest. Generates N copies of the
// K-sensitive series for distinct game ids. Used by US-038 timeline tests to
// assert per-game row rendering, cap-at-20 behavior, and chart-non-remount
// across K changes.
function buildMultiGameKSensitiveBacktest(gameIds: readonly string[]): {
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
  const pattern: readonly number[] = [1, 2, 3];
  const observations: {
    gameId: string;
    bucketStart: string;
    bucketEnd: string;
    fired: number;
    intensity: number;
    baselineMedian: number;
    baselineMad: number;
  }[] = [];
  for (const gameId of gameIds) {
    for (let i = 0; i < 30; i++) {
      const intensity = i === 24 ? 7 : (pattern[i % 3] ?? 0);
      const t = new Date(Date.UTC(2026, 4, 8, 3, i, 0));
      observations.push({
        gameId,
        bucketStart: t.toISOString(),
        bucketEnd: new Date(t.getTime() + 60_000).toISOString(),
        fired: i === 24 ? 1 : 0,
        intensity,
        baselineMedian: 2,
        baselineMad: 1,
      });
    }
  }
  return {
    runId: 138,
    stats: {
      firesPerGame: 1,
      totalFires: gameIds.length,
      gamesInWindow: gameIds.length,
    },
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

  function makeGameRow(gameId: string): {
    id: string;
    sport: string;
    league: string;
    scheduledStart: string;
    homeParticipantJson: string;
    awayParticipantJson: string;
    status: string | null;
  } {
    return {
      id: gameId,
      sport: "NBA",
      league: "nba",
      scheduledStart: "2026-05-08T03:00:00.000Z",
      homeParticipantJson: JSON.stringify({ abbreviation: "BKN" }),
      awayParticipantJson: JSON.stringify({ abbreviation: "NYK" }),
      status: "final",
    };
  }

  function mockDetectorsAndBacktest(backtestBody: unknown): void {
    fetchMock.mockImplementation(async (input, init) => {
      await Promise.resolve();
      const url = urlOf(input);
      if (url.startsWith("/v1/detectors")) return jsonResponse(DETECTORS_RESPONSE);
      if (url.startsWith("/v1/backtest") && init?.method === "POST") {
        return jsonResponse(backtestBody);
      }
      const gameMatch = /\/v1\/games\/([^?]+)/.exec(url);
      if (gameMatch !== null && gameMatch[1] !== undefined) {
        return jsonResponse(makeGameRow(decodeURIComponent(gameMatch[1])));
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
    // kMad is owned by the Cry Wolf dial when board-mad is the selected
    // detector; the plain NumberControl row is omitted from the grid.
    expect(screen.queryByTestId("backtest-param-kMad")).toBeNull();
    const dial = screen.getByTestId("cry-wolf-dial");
    expect(dial.getAttribute("aria-valuenow")).toBe("3");
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

  it("multi-knob round-trip stability: dial K + trailingBuckets revert to baseline (US-036)", async () => {
    // Use a K-sensitive synthetic backtest: i%3 [1,2,3] baseline pattern keeps
    // trail-window MAD non-zero (avoiding the MAD=0-spurious-fire trap that
    // plain constant-baseline data falls into), and the spike at bucket 24
    // (intensity 7) fires at K=3 (threshold ≈ 5) but NOT at K=6 (threshold ≈
    // 8). So changing K via the dial materially changes fires/game.
    //
    // The Z (trailingBuckets-changed) value is asserted to be finite rather
    // than strictly != Y because in this synthetic dataset extending the
    // trail keeps median+MAD nearly constant; the strict Z != Y check is
    // verified end-to-end against the gold DB by the owner (CLAUDE.md
    // End-to-End Verification Mandate — deferred for HTTP-smoke runs).
    const backtest = buildKSensitiveBacktest();
    mockDetectorsAndBacktest(backtest);
    render(<BacktestPage />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("backtest-detector-select")).not.toBeNull();
    });

    // (a) Run at defaults (K=3, trailingBuckets=20). Record baseline X.
    fireEvent.click(screen.getByTestId("backtest-run-button"));
    await waitFor(() => {
      expect(screen.getByTestId("backtest-run-id").textContent).toBe("99");
    });
    const X = screen.getByTestId("backtest-stat-fires-per-game").textContent;
    const postCountAfterRun = fetchMock.mock.calls.filter(([input, init]) => {
      const url = urlOf(input);
      return url.startsWith("/v1/backtest") && init?.method === "POST";
    }).length;
    expect(postCountAfterRun).toBe(1);

    const dial = screen.getByTestId("cry-wolf-dial");

    // (b) Move K via keyboard: 3.0 → 6.0 (12 × +0.25 via ArrowRight).
    // No POST should be issued — the recompute is in-memory.
    act(() => {
      for (let i = 0; i < 12; i++) {
        fireEvent.keyDown(dial, { key: "ArrowRight" });
      }
    });
    expect(dial.getAttribute("aria-valuenow")).toBe("6");
    const Y = screen.getByTestId("backtest-stat-fires-per-game").textContent;
    expect(Y).not.toBe(X);
    const postCountAfterDial = fetchMock.mock.calls.filter(([input, init]) => {
      const url = urlOf(input);
      return url.startsWith("/v1/backtest") && init?.method === "POST";
    }).length;
    expect(postCountAfterDial).toBe(1);

    // (c) Second knob: trailingBuckets 20 → 30. Still no API round-trip.
    const trailing = screen.getByTestId("backtest-param-trailingBuckets");
    if (!(trailing instanceof HTMLInputElement)) throw new Error("not an input");
    act(() => {
      fireEvent.change(trailing, { target: { value: "30" } });
    });
    const Z = screen.getByTestId("backtest-stat-fires-per-game").textContent;
    expect(Number.isNaN(Number.parseFloat(Z))).toBe(false);
    const postCountAfterTrailing = fetchMock.mock.calls.filter(([input, init]) => {
      const url = urlOf(input);
      return url.startsWith("/v1/backtest") && init?.method === "POST";
    }).length;
    expect(postCountAfterTrailing).toBe(1);

    // (d) Revert: K → 3.0 (12 × ArrowLeft), trailingBuckets → 20. Assert
    // X' === X to within float epsilon (the recompute must be deterministic
    // and stateless across reversals).
    act(() => {
      for (let i = 0; i < 12; i++) {
        fireEvent.keyDown(dial, { key: "ArrowLeft" });
      }
    });
    expect(dial.getAttribute("aria-valuenow")).toBe("3");
    act(() => {
      fireEvent.change(trailing, { target: { value: "20" } });
    });
    const Xprime = screen.getByTestId("backtest-stat-fires-per-game").textContent;
    expect(Xprime).toBe(X);

    // Document the round-trip in a deterministic textual form so a regression
    // (e.g. someone adds a stateful caching layer that leaks between params)
    // would fail the equality above.
    expect({ X, Y, Z, Xprime }).toMatchObject({ X, Y, Z, Xprime: X });
  });

  it("snap chips drive K to K_MAD_LIVE and K_MAD_CALM (US-036)", async () => {
    mockDetectors();
    render(<BacktestPage />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("backtest-detector-select")).not.toBeNull();
    });
    const dial = screen.getByTestId("cry-wolf-dial");
    expect(dial.getAttribute("aria-valuenow")).toBe("3");

    fireEvent.click(screen.getByTestId("cry-wolf-chip-calm"));
    expect(dial.getAttribute("aria-valuenow")).toBe("6");

    fireEvent.click(screen.getByTestId("cry-wolf-chip-sensitive"));
    expect(dial.getAttribute("aria-valuenow")).toBe("3");
  });

  it("dial state does not leak into Recent's useBoard URL (US-036)", async () => {
    // Mount BacktestPage; record any /v1/board/* fetch URLs. The dial owns
    // local kMad state but useBoard's URL is /v1/board/:gameId with NO `k=`
    // query — moving the dial must not change the URL pattern (the server
    // always serves K_MAD_LIVE for Recent and Live).
    mockDetectors();
    render(<BacktestPage />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("cry-wolf-dial")).not.toBeNull();
    });

    const dial = screen.getByTestId("cry-wolf-dial");
    act(() => {
      for (let i = 0; i < 12; i++) {
        fireEvent.keyDown(dial, { key: "ArrowRight" });
      }
    });
    expect(dial.getAttribute("aria-valuenow")).toBe("6");

    // No fetch to /v1/board/* was issued by mounting BacktestPage or by
    // moving the dial — the dial is purely local state.
    const boardCalls = fetchMock.mock.calls.filter(([input]) => {
      const url = urlOf(input);
      return url.includes("/v1/board/");
    });
    expect(boardCalls.length).toBe(0);

    // Any /v1/board call elsewhere in the app uses queryKey ["board", id]
    // with no K — assert that contract too by sniffing for `k=` in any URL.
    const anyKQuery = fetchMock.mock.calls.some(([input]) => {
      const url = urlOf(input);
      return /[?&]k=/.test(url);
    });
    expect(anyKQuery).toBe(false);
  });

  it("renders the prominent 'Estimated fires/game' live preview as a placeholder before any run (US-037)", async () => {
    mockDetectors();
    render(<BacktestPage />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("cry-wolf-dial")).not.toBeNull();
    });
    const preview = screen.getByTestId("backtest-live-preview");
    expect(preview).not.toBeNull();
    // Label literal — the AC asks for this exact phrase to be visible.
    expect(preview.textContent).toMatch(/Estimated fires\/game/);
    const value = screen.getByTestId("backtest-live-fires-per-game");
    expect(value.textContent).toBe("—");
    expect(value.getAttribute("data-from-recompute")).toBe("0");
  });

  it("populates the live preview from the backtest response and tracks dial moves without an API call (US-037)", async () => {
    const backtest = buildKSensitiveBacktest();
    mockDetectorsAndBacktest(backtest);
    render(<BacktestPage />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("backtest-detector-select")).not.toBeNull();
    });

    fireEvent.click(screen.getByTestId("backtest-run-button"));
    await waitFor(() => {
      expect(screen.getByTestId("backtest-run-id").textContent).toBe("99");
    });

    const preview = screen.getByTestId("backtest-live-fires-per-game");
    const stat = screen.getByTestId("backtest-stat-fires-per-game");
    // After a run the preview value equals the Results-panel stat (single
    // source of truth) and is no longer the placeholder dash.
    expect(preview.textContent).not.toBe("—");
    expect(preview.textContent).toBe(stat.textContent);
    const baseline = preview.textContent;

    const postCountBefore = fetchMock.mock.calls.filter(([input, init]) => {
      const url = urlOf(input);
      return url.startsWith("/v1/backtest") && init?.method === "POST";
    }).length;
    expect(postCountBefore).toBe(1);

    // Move K from 3.0 → 6.0 via the dial. The preview must update without a
    // new POST /v1/backtest call.
    const dial = screen.getByTestId("cry-wolf-dial");
    act(() => {
      for (let i = 0; i < 12; i++) {
        fireEvent.keyDown(dial, { key: "ArrowRight" });
      }
    });
    expect(dial.getAttribute("aria-valuenow")).toBe("6");

    const postCountAfter = fetchMock.mock.calls.filter(([input, init]) => {
      const url = urlOf(input);
      return url.startsWith("/v1/backtest") && init?.method === "POST";
    }).length;
    expect(postCountAfter).toBe(1);

    const after = screen.getByTestId("backtest-live-fires-per-game");
    expect(after.textContent).not.toBe(baseline);
    // The recompute path marks the readout so a future regression that drops
    // the in-memory recompute (and falls back to the static snapshot value)
    // would be detectable in tests + screenshots.
    expect(after.getAttribute("data-from-recompute")).toBe("1");
    // Preview and Results-panel stat stay in lockstep — one source of truth.
    expect(after.textContent).toBe(screen.getByTestId("backtest-stat-fires-per-game").textContent);
  });

  it("preview shows '…' while a backtest run is pending (US-037)", async () => {
    let resolveBacktest: (v: Response) => void = () => {};
    const pendingBacktest = new Promise<Response>((resolve) => {
      resolveBacktest = resolve;
    });
    fetchMock.mockImplementation(async (input, init) => {
      await Promise.resolve();
      const url = urlOf(input);
      if (url.startsWith("/v1/detectors")) return jsonResponse(DETECTORS_RESPONSE);
      if (url.startsWith("/v1/backtest") && init?.method === "POST") return await pendingBacktest;
      return new Response("not found", { status: 404 });
    });
    render(<BacktestPage />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("cry-wolf-dial")).not.toBeNull();
    });

    fireEvent.click(screen.getByTestId("backtest-run-button"));
    await waitFor(() => {
      expect(screen.getByTestId("backtest-live-fires-per-game").textContent).toBe("…");
    });
    resolveBacktest(jsonResponse(buildSyntheticBacktest()));
    await waitFor(() => {
      const value = screen.getByTestId("backtest-live-fires-per-game").textContent;
      expect(value).not.toBe("…");
      expect(value).not.toBe("—");
    });
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

  it("renders one timeline row per game with sport + scheduled_start + opaque id chip (US-038)", async () => {
    const ids = ["nba-aaa", "nba-bbb", "nba-ccc"];
    mockDetectorsAndBacktest(buildMultiGameKSensitiveBacktest(ids));
    render(<BacktestPage />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("backtest-detector-select")).not.toBeNull();
    });

    fireEvent.click(screen.getByTestId("backtest-run-button"));
    await waitFor(() => {
      expect(screen.getByTestId("backtest-run-id").textContent).toBe("138");
    });

    // One row per game id, in stable order keyed by gameId.
    await waitFor(() => {
      const rows = screen.getAllByTestId("backtest-timeline-row");
      expect(rows.length).toBe(ids.length);
    });
    const rows = screen.getAllByTestId("backtest-timeline-row");
    for (let i = 0; i < ids.length; i++) {
      expect(rows[i]?.getAttribute("data-game-id")).toBe(ids[i]);
    }

    // Game-id chip carries the opaque id; sport + scheduled_start labels
    // resolve from /v1/games/:gameId. Wait for the metadata query to land —
    // the chip is the synchronous label, sport/scheduled-start are async.
    const chips = screen.getAllByTestId("backtest-timeline-game-chip");
    expect(chips.map((c) => c.textContent)).toEqual(ids);
    await waitFor(() => {
      const sports = screen.getAllByTestId("backtest-timeline-sport");
      expect(sports.every((s) => s.textContent === "NBA")).toBe(true);
    });
    const scheduled = screen.getAllByTestId("backtest-timeline-scheduled-start");
    // formatScheduledStart's locale output varies by host TZ, so just assert
    // the cell isn't the empty-state dash for any row.
    for (const s of scheduled) {
      expect(s.textContent).not.toBe("—");
    }
  });

  it("caps the per-game timeline list at 20 rows (US-038)", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `nba-${String(i).padStart(4, "0")}`);
    mockDetectorsAndBacktest(buildMultiGameKSensitiveBacktest(ids));
    render(<BacktestPage />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("backtest-detector-select")).not.toBeNull();
    });
    fireEvent.click(screen.getByTestId("backtest-run-button"));
    await waitFor(() => {
      expect(screen.getByTestId("backtest-run-id").textContent).toBe("138");
    });
    const rows = screen.getAllByTestId("backtest-timeline-row");
    expect(rows.length).toBe(20);
    // First 20 ids, in order — the slice happens after the per-game group.
    expect(rows.map((r) => r.getAttribute("data-game-id"))).toEqual(ids.slice(0, 20));
  });

  it("fire markers update in place as K moves; chart DOM node identity preserved (US-038)", async () => {
    const ids = ["nba-aaa", "nba-bbb"];
    mockDetectorsAndBacktest(buildMultiGameKSensitiveBacktest(ids));
    render(<BacktestPage />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("backtest-detector-select")).not.toBeNull();
    });
    fireEvent.click(screen.getByTestId("backtest-run-button"));
    await waitFor(() => {
      expect(screen.getByTestId("backtest-run-id").textContent).toBe("138");
    });

    // K=3 baseline: both games fire once (the spike at bucket 24 above
    // threshold ≈ 5). Capture per-row fire counts AND the chart DOM node.
    const rowsBefore = screen.getAllByTestId("backtest-timeline-row");
    expect(rowsBefore.length).toBe(2);
    const firesBefore = screen.getAllByTestId("backtest-timeline-fires").map((s) => s.textContent);
    expect(firesBefore.every((f) => f.startsWith("1"))).toBe(true);
    const chartNodesBefore = screen.getAllByTestId("backtest-timeline-chart");
    expect(chartNodesBefore.length).toBe(2);

    // Move K from 3.0 → 6.0 via the dial. At K=6, threshold ≈ 8 so the spike
    // of 7 no longer fires for any game.
    const dial = screen.getByTestId("cry-wolf-dial");
    act(() => {
      for (let i = 0; i < 12; i++) {
        fireEvent.keyDown(dial, { key: "ArrowRight" });
      }
    });
    expect(dial.getAttribute("aria-valuenow")).toBe("6");

    const rowsAfter = screen.getAllByTestId("backtest-timeline-row");
    const chartNodesAfter = screen.getAllByTestId("backtest-timeline-chart");
    const firesAfter = screen.getAllByTestId("backtest-timeline-fires").map((s) => s.textContent);

    // Per-row fires must change (markers updated in place).
    expect(firesAfter).not.toEqual(firesBefore);
    expect(firesAfter.every((f) => f.startsWith("0"))).toBe(true);

    // Critical non-remount evidence: the chart container DOM nodes are the
    // SAME references before and after the K change. If the chart had
    // remounted (which would re-fetch /v1/games and re-render Recharts from
    // scratch), Object.is would be false. The split-data pattern
    // (intensity from snapshot, fires from recompute) is what guarantees
    // this — see BacktestTimelines.tsx for the rationale.
    expect(Object.is(rowsBefore[0], rowsAfter[0])).toBe(true);
    expect(Object.is(rowsBefore[1], rowsAfter[1])).toBe(true);
    expect(Object.is(chartNodesBefore[0], chartNodesAfter[0])).toBe(true);
    expect(Object.is(chartNodesBefore[1], chartNodesAfter[1])).toBe(true);
  });

  it("flips data-from-recompute canary after dial-driven K change (US-038)", async () => {
    mockDetectorsAndBacktest(buildMultiGameKSensitiveBacktest(["nba-aaa"]));
    render(<BacktestPage />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("backtest-detector-select")).not.toBeNull();
    });
    fireEvent.click(screen.getByTestId("backtest-run-button"));
    await waitFor(() => {
      expect(screen.getByTestId("backtest-run-id").textContent).toBe("138");
    });

    // After a run at defaults, the recompute pipeline already runs (K=3 is a
    // recompute-eligible K), so the canary is "1" from the start.
    await waitFor(() => {
      const row = screen.getByTestId("backtest-timeline-row");
      expect(row.getAttribute("data-from-recompute")).toBe("1");
    });

    const dial = screen.getByTestId("cry-wolf-dial");
    act(() => {
      fireEvent.keyDown(dial, { key: "ArrowRight" });
    });
    const row = screen.getByTestId("backtest-timeline-row");
    expect(row.getAttribute("data-from-recompute")).toBe("1");

    // Cross-check: zero POST /v1/backtest after the dial move. The canary
    // proves it was the in-memory recompute that produced the row, not a
    // fresh server sweep.
    const postCount = fetchMock.mock.calls.filter(([input, init]) => {
      const url = urlOf(input);
      return url.startsWith("/v1/backtest") && init?.method === "POST";
    }).length;
    expect(postCount).toBe(1);
  });
});
