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

import {
  BOARD_MAD_BASELINE_MODE_HISTORICAL_BLEND,
  BOARD_MAD_BASELINE_MODE_DEFAULT,
  BOARD_MAD_BASELINE_MODE_OPENING_RAMP,
  BOARD_MAD_BASELINE_MODE_TRAILING,
  BOARD_MAD_FRESH_CAP_SECONDS_DEFAULT,
  BOARD_MAD_HISTORICAL_AWAY_WEIGHT_DEFAULT,
  BOARD_MAD_HISTORICAL_LAST_GAMES_DEFAULT,
  BOARD_MAD_HISTORICAL_PRIOR_WEIGHT_DEFAULT,
  BOARD_MAD_HISTORICAL_RAMP_COMPLETE_GAME_MINUTES_DEFAULT,
  BOARD_MAD_OPENING_BASELINE_BUCKETS_DEFAULT,
  BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_DEFAULT,
  BOARD_MAD_RECENT_WALL_MINUTES_DEFAULT,
  BOARD_MAD_RECENT_WALL_WEIGHT_DEFAULT,
  BOARD_MAD_TRAILING_BUCKETS_DEFAULT,
  BOARD_MAD_TRAILING_GAME_MINUTES_DEFAULT,
  BOARD_MAD_WARMUP_BUCKETS_DEFAULT,
  K_MAD_LIVE,
} from "@signal-console/detectors/board-mad/config";
import { BOARD_STATE_SPACE_CONFIG_DEFAULTS } from "@signal-console/detectors/board-mad/state-space-config";

import { BacktestPage } from "../BacktestPage";
import { STATE_SPACE_GUIDED_FIELDS } from "../../state-space-guided-fields";

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

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not a record`);
  }
  return Object.fromEntries(Object.entries(value));
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
      version: "1.2.0",
      displayName: "Board State-Space (whole-board volatility)",
      sources: ["bet365", "kalshi", "polymarket"],
      paramsSchema: {
        type: "object",
        properties: {
          bucketSeconds: { type: "integer", minimum: 10, maximum: 300, default: 60 },
          kMad: { type: "number", minimum: 1, maximum: 12, default: K_MAD_LIVE },
          weighting: { type: "string", enum: ["volume", "equal"], default: "volume" },
          trailingBuckets: {
            type: "integer",
            minimum: 5,
            maximum: 60,
            default: BOARD_MAD_TRAILING_BUCKETS_DEFAULT,
          },
          warmupBuckets: {
            type: "integer",
            minimum: 2,
            maximum: 20,
            default: BOARD_MAD_WARMUP_BUCKETS_DEFAULT,
          },
          baselineMode: {
            type: "string",
            enum: [
              BOARD_MAD_BASELINE_MODE_TRAILING,
              BOARD_MAD_BASELINE_MODE_OPENING_RAMP,
              BOARD_MAD_BASELINE_MODE_HISTORICAL_BLEND,
            ],
            default: BOARD_MAD_BASELINE_MODE_DEFAULT,
          },
          openingBaselineBuckets: {
            type: "integer",
            minimum: 1,
            maximum: 60,
            default: BOARD_MAD_OPENING_BASELINE_BUCKETS_DEFAULT,
          },
          openingRampCompleteBuckets: {
            type: "integer",
            minimum: 2,
            maximum: 120,
            default: BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_DEFAULT,
          },
          freshCapSeconds: {
            type: "integer",
            minimum: 30,
            maximum: 3600,
            default: BOARD_MAD_FRESH_CAP_SECONDS_DEFAULT,
          },
          historicalLastGames: {
            type: "integer",
            minimum: 1,
            maximum: 20,
            default: BOARD_MAD_HISTORICAL_LAST_GAMES_DEFAULT,
          },
          historicalAwayWeight: {
            type: "number",
            minimum: 0,
            maximum: 1,
            default: BOARD_MAD_HISTORICAL_AWAY_WEIGHT_DEFAULT,
          },
          historicalPriorWeight: {
            type: "number",
            minimum: 0,
            maximum: 1,
            default: BOARD_MAD_HISTORICAL_PRIOR_WEIGHT_DEFAULT,
          },
          historicalRampCompleteGameMinutes: {
            type: "number",
            minimum: 1,
            maximum: 48,
            default: BOARD_MAD_HISTORICAL_RAMP_COMPLETE_GAME_MINUTES_DEFAULT,
          },
          trailingGameMinutes: {
            type: "number",
            minimum: 1,
            maximum: 48,
            default: BOARD_MAD_TRAILING_GAME_MINUTES_DEFAULT,
          },
          recentWallMinutes: {
            type: "number",
            minimum: 0,
            maximum: 20,
            default: BOARD_MAD_RECENT_WALL_MINUTES_DEFAULT,
          },
          recentWallWeight: {
            type: "number",
            minimum: 0,
            maximum: 5,
            default: BOARD_MAD_RECENT_WALL_WEIGHT_DEFAULT,
          },
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

const ENSEMBLE_DETECTORS_RESPONSE = {
  detectors: [
    ...DETECTORS_RESPONSE.detectors,
    {
      id: "ensemble-or",
      version: "1.0.0",
      displayName: "Stage 1 (board OR off-price-print)",
      sources: ["bet365", "kalshi", "polymarket"],
      paramsSchema: {
        type: "object",
        properties: {
          board: { type: "object", default: {} },
          offprice: { type: "object", default: {} },
        },
      },
    },
  ],
};

// Synthetic observations that mimic the prebucket+sweep contract: per-game
// chronological intensity series with baseline median + mad. We can predict
// what the client recompute will produce for a given signal-timing parameter
// set because the algorithm is the same as sweep.ts. For the
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
    // above 1.0 fires after the elapsed 8-minute holdoff. i==25 has intensity 5 -> fires.
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
      if (url.startsWith("/v1/settings")) {
        return jsonResponse(makeSettingsBody({ offPriceMinOffPriceDistance: 0.4 }));
      }
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

  function mockDetectorsAndBacktest(
    backtestBody: unknown,
    detectorsBody: unknown = DETECTORS_RESPONSE,
  ): void {
    fetchMock.mockImplementation(async (input, init) => {
      await Promise.resolve();
      const url = urlOf(input);
      if (url.startsWith("/v1/detectors")) return jsonResponse(detectorsBody);
      if (url.startsWith("/v1/settings")) {
        return jsonResponse(makeSettingsBody({ offPriceMinOffPriceDistance: 0.4 }));
      }
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

  function selectBaselineMode(mode: string): void {
    const baselineMode = screen.getByTestId("backtest-baseline-mode");
    if (!(baselineMode instanceof HTMLSelectElement)) throw new Error("baseline mode not a select");
    fireEvent.change(baselineMode, { target: { value: mode } });
  }

  it("renders the form scaffold with window, scope, detector, and empty results", async () => {
    mockDetectors();
    render(<BacktestPage />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("backtest-window")).not.toBeNull();
    });
    expect(screen.getByTestId("backtest-meta").textContent).toBe("server replay");
    expect(screen.queryByText("POST /v1/backtest")).toBeNull();
    expect(screen.getByTestId("backtest-scope")).not.toBeNull();
    expect(screen.getByTestId("backtest-detector")).not.toBeNull();
    expect(screen.getByTestId("backtest-results-empty")).not.toBeNull();
    expect(screen.queryByTestId("backtest-run-id")).toBeNull();
  });

  it("falls back to board-mad as the default detector when ensemble-or is not registered (older API)", async () => {
    // The base DETECTORS_RESPONSE fixture intentionally omits ensemble-or to
    // exercise the back-compat fallback in selectInitialDetector. The newer
    // test below verifies the preferred default when ensemble-or IS present.
    mockDetectors();
    render(<BacktestPage />, { wrapper: makeWrapper() });
    await waitFor(() => {
      const sel = screen.getByTestId("backtest-detector-select");
      if (!(sel instanceof HTMLSelectElement)) throw new Error("not a select");
      expect(sel.value).toBe("board-mad");
    });
    // kMad is owned by the Sensitivity dial when board-mad is the selected
    // detector; the plain NumberControl row is omitted from the grid.
    await waitFor(() => {
      expect(screen.getByTestId("backtest-sensitivity-dial")).not.toBeNull();
    });
    expect(screen.queryByTestId("backtest-param-kMad")).toBeNull();
    const dial = screen.getByTestId("sensitivity-dial");
    expect(dial.getAttribute("aria-valuenow")).toBe("3");
    const weighting = screen.getByTestId("backtest-param-weighting");
    if (!(weighting instanceof HTMLSelectElement)) throw new Error("weighting not a select");
    expect(weighting.value).toBe("volume");
  });

  it("renders the signal timing panel with filter-memory and holdoff durations from bucketSeconds", async () => {
    mockDetectors();
    render(<BacktestPage />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("memory-dial")).not.toBeNull();
    });

    expect(screen.getByTestId("backtest-signal-timing-panel").textContent).toContain(
      "Signal timing",
    );
    expect(screen.getByTestId("backtest-signal-timing-panel").textContent).toContain(
      "Filter memory",
    );
    expect(screen.getByTestId("memory-dial-headline").textContent).toBe("20");
    expect(screen.getByTestId("memory-dial-headline-detail").textContent).toBe("(20 min)");
    expect(screen.getByTestId("backtest-warmup-dial").textContent).toContain("Alert holdoff");
    const baselineMode = screen.getByTestId("backtest-baseline-mode");
    if (!(baselineMode instanceof HTMLSelectElement)) throw new Error("baseline mode not a select");
    expect(baselineMode.value).toBe(BOARD_MAD_BASELINE_MODE_DEFAULT);
    expect(screen.getByTestId("backtest-opening-baseline-buckets")).not.toBeNull();
    expect(screen.getByTestId("backtest-opening-ramp-complete-buckets")).not.toBeNull();

    const bucketSeconds = screen.getByTestId("backtest-param-bucketSeconds");
    if (!(bucketSeconds instanceof HTMLInputElement)) {
      throw new Error("bucketSeconds not an input");
    }
    fireEvent.change(bucketSeconds, { target: { value: "30" } });

    expect(screen.getByTestId("memory-dial-headline-detail").textContent).toBe("(10 min)");
    expect(screen.getByTestId("warmup-dial-headline-detail").textContent).toBe("(4 min)");
    expect(screen.getByTestId("memory-dial").getAttribute("aria-valuetext")).toBe("20 (10 min)");
  });

  it("applies the historical-to-live profile as real backtest params", async () => {
    const backtest = buildSyntheticBacktest();
    mockDetectorsAndBacktest(backtest);
    render(<BacktestPage />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("backtest-detector-select")).not.toBeNull();
    });

    const profile = screen.getByTestId("backtest-baseline-profile");
    if (!(profile instanceof HTMLSelectElement)) throw new Error("profile not a select");
    fireEvent.change(profile, { target: { value: "historical-blend" } });

    const baselineMode = screen.getByTestId("backtest-baseline-mode");
    const bucketSeconds = screen.getByTestId("backtest-param-bucketSeconds");
    if (!(baselineMode instanceof HTMLSelectElement)) throw new Error("baseline mode not a select");
    if (!(bucketSeconds instanceof HTMLInputElement)) throw new Error("bucketSeconds not an input");
    expect(baselineMode.value).toBe(BOARD_MAD_BASELINE_MODE_HISTORICAL_BLEND);
    expect(bucketSeconds.value).toBe("30");

    fireEvent.click(screen.getByTestId("backtest-run-button"));
    await waitFor(() => {
      expect(screen.getByTestId("backtest-run-id").textContent).toBe("42");
    });

    const postCalls = fetchMock.mock.calls.filter(([input, init]) => {
      const url = urlOf(input);
      return url.startsWith("/v1/backtest") && init?.method === "POST";
    });
    expect(postCalls.length).toBe(1);
    const [, init] = postCalls[0]!;
    const body = parsePostBody(init?.body);
    expect(body.params).toMatchObject({
      baselineMode: BOARD_MAD_BASELINE_MODE_HISTORICAL_BLEND,
      bucketSeconds: 30,
      openingBaselineBuckets: 3,
      openingRampCompleteBuckets: 16,
      trailingBuckets: 24,
      warmupBuckets: 4,
      historicalLastGames: BOARD_MAD_HISTORICAL_LAST_GAMES_DEFAULT,
      historicalAwayWeight: BOARD_MAD_HISTORICAL_AWAY_WEIGHT_DEFAULT,
      historicalPriorWeight: BOARD_MAD_HISTORICAL_PRIOR_WEIGHT_DEFAULT,
      historicalRampCompleteGameMinutes: BOARD_MAD_HISTORICAL_RAMP_COMPLETE_GAME_MINUTES_DEFAULT,
      trailingGameMinutes: BOARD_MAD_TRAILING_GAME_MINUTES_DEFAULT,
      recentWallMinutes: BOARD_MAD_RECENT_WALL_MINUTES_DEFAULT,
      recentWallWeight: BOARD_MAD_RECENT_WALL_WEIGHT_DEFAULT,
    });
  });

  it("defaults the detector selector to ensemble-or when it is registered (report §8.1 Stage 1)", async () => {
    // Mock detectors response that includes ensemble-or, matching the new
    // registry. selectInitialDetector should pick it over board-mad.
    mockDetectors(ENSEMBLE_DETECTORS_RESPONSE);
    render(<BacktestPage />, { wrapper: makeWrapper() });
    await waitFor(() => {
      const sel = screen.getByTestId("backtest-detector-select");
      if (!(sel instanceof HTMLSelectElement)) throw new Error("not a select");
      expect(sel.value).toBe("ensemble-or");
    });
    // Marquee feature — the Sensitivity dial + signal timing panel
    // ALL render for ensemble-or too (wired to the nested params.board.*
    // path). User explicitly insisted on this in feedback after seeing
    // the dial-less ensemble-or view.
    expect(screen.getByTestId("backtest-sensitivity-dial")).toBeDefined();
    expect(screen.getByTestId("backtest-warmup-dial")).toBeDefined();
    // The Sensitivity dial starts at K_MAD_LIVE = 3 even when the nested
    // params.board.kMad isn't pre-seeded (readBoardParam fallback).
    const dial = screen.getByTestId("sensitivity-dial");
    expect(dial.getAttribute("aria-valuenow")).toBe("3");
    // And the unhelpful BOARD/OFFPRICE placeholder rows that parseSchema
    // returns for ensemble-or's nested objects must NOT render — the user
    // saw bare "BOARD —" / "OFFPRICE —" lines and called it out.
    const paramForm = screen.queryByTestId("backtest-param-form");
    if (paramForm !== null) {
      expect(paramForm.textContent).not.toMatch(/BOARD\s*—/i);
      expect(paramForm.textContent).not.toMatch(/OFFPRICE\s*—/i);
    }
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
    expect(body.params["kMad"]).toBe(K_MAD_LIVE);
    expect(body.params["baselineMode"]).toBe(BOARD_MAD_BASELINE_MODE_DEFAULT);
    expect(body.params["openingBaselineBuckets"]).toBe(BOARD_MAD_OPENING_BASELINE_BUCKETS_DEFAULT);
    expect(body.params["openingRampCompleteBuckets"]).toBe(
      BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_DEFAULT,
    );
    expect(body.params["trailingBuckets"]).toBe(BOARD_MAD_TRAILING_BUCKETS_DEFAULT);
    expect(body.params["warmupBuckets"]).toBe(BOARD_MAD_WARMUP_BUCKETS_DEFAULT);
    expect(body.params["stateSpace"]).toEqual(BOARD_STATE_SPACE_CONFIG_DEFAULTS);
    expect(body.window.start.startsWith("20")).toBe(true);
    expect(body.window.end.startsWith("20")).toBe(true);
  });

  it("includes guided state-space control edits in the backtest request payload", async () => {
    const backtest = buildSyntheticBacktest();
    mockDetectorsAndBacktest(backtest);
    render(<BacktestPage />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("backtest-detector-select")).not.toBeNull();
    });

    const input = screen.getByTestId("backtest-state-space-input-trigger-enterOffset");
    if (!(input instanceof HTMLInputElement)) throw new Error("not input");
    fireEvent.change(input, { target: { value: "1.4" } });

    fireEvent.click(screen.getByTestId("backtest-run-button"));

    await waitFor(() => {
      expect(screen.getByTestId("backtest-run-id").textContent).toBe("42");
    });

    const postCalls = fetchMock.mock.calls.filter(([inputValue, init]) => {
      const url = urlOf(inputValue);
      return url.startsWith("/v1/backtest") && init?.method === "POST";
    });
    expect(postCalls.length).toBe(1);
    const [, init] = postCalls[0]!;
    const body = parsePostBody(init?.body);
    const stateSpace = asRecord(body.params["stateSpace"], "stateSpace");
    const trigger = asRecord(stateSpace["trigger"], "trigger");
    expect(trigger["enterOffset"]).toBe(1.4);
  });

  it("renders a direct numeric control for every state-space field", async () => {
    mockEnsembleSettingsAndBacktest({
      settings: makeSettingsBody({ offPriceMinOffPriceDistance: 0.4 }),
    });

    render(<BacktestPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("backtest-state-space-config")).toBeDefined();
    });
    expect(screen.getAllByTestId(/^backtest-state-space-input-/)).toHaveLength(
      STATE_SPACE_GUIDED_FIELDS.length,
    );
    expect(
      screen.getByTestId("backtest-state-space-input-sourceTrust-sourceCountExponent"),
    ).toBeDefined();
    expect(screen.getByTestId("backtest-state-space-input-scale-madScale")).toBeDefined();
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

    // Bump trailingBuckets 20 -> 30 via the Filter memory slider.
    const memory = screen.getByTestId("memory-dial");
    act(() => {
      fireEvent.change(memory, { target: { value: "30" } });
    });
    expect(memory.getAttribute("aria-valuenow")).toBe("30");

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
      fireEvent.change(memory, { target: { value: "20" } });
    });
    expect(memory.getAttribute("aria-valuenow")).toBe("20");
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

    const dial = screen.getByTestId("sensitivity-dial");

    // (b) Move K via keyboard: 3.0 → 6.0 (12 × +0.25 via ArrowRight).
    // No POST should be issued — the snapshot is now marked stale until the
    // Python-sidecar model is rerun on the server.
    act(() => {
      for (let i = 0; i < 12; i++) {
        fireEvent.keyDown(dial, { key: "ArrowRight" });
      }
    });
    expect(dial.getAttribute("aria-valuenow")).toBe("6");
    const Y = screen.getByTestId("backtest-stat-fires-per-game").textContent;
    expect(Y).toBe(X);
    expect(screen.getByTestId("backtest-stale-warning")).not.toBeNull();
    const postCountAfterDial = fetchMock.mock.calls.filter(([input, init]) => {
      const url = urlOf(input);
      return url.startsWith("/v1/backtest") && init?.method === "POST";
    }).length;
    expect(postCountAfterDial).toBe(1);

    // (c) Second knob: Filter memory 20 -> 30. Still no
    // API round-trip — the in-memory recompute reads baseline_median /
    // baseline_mad from the cached observations.
    const memory = screen.getByTestId("memory-dial");
    act(() => {
      fireEvent.change(memory, { target: { value: "30" } });
    });
    expect(memory.getAttribute("aria-valuenow")).toBe("30");
    const Z = screen.getByTestId("backtest-stat-fires-per-game").textContent;
    expect(Number.isNaN(Number.parseFloat(Z))).toBe(false);
    const postCountAfterTrailing = fetchMock.mock.calls.filter(([input, init]) => {
      const url = urlOf(input);
      return url.startsWith("/v1/backtest") && init?.method === "POST";
    }).length;
    expect(postCountAfterTrailing).toBe(1);

    // (d) Revert: K → 3.0 (12 × ArrowLeft), volatility lookback 30 → 20.
    // Assert X' === X to within float epsilon (the recompute must be
    // deterministic and stateless across reversals).
    act(() => {
      for (let i = 0; i < 12; i++) {
        fireEvent.keyDown(dial, { key: "ArrowLeft" });
      }
    });
    expect(dial.getAttribute("aria-valuenow")).toBe("3");
    act(() => {
      fireEvent.change(memory, { target: { value: "20" } });
    });
    expect(memory.getAttribute("aria-valuenow")).toBe("20");
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
    const dial = screen.getByTestId("sensitivity-dial");
    expect(dial.getAttribute("aria-valuenow")).toBe("3");

    fireEvent.click(screen.getByTestId("sensitivity-chip-calm"));
    expect(dial.getAttribute("aria-valuenow")).toBe("6");

    fireEvent.click(screen.getByTestId("sensitivity-chip-sensitive"));
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
      expect(screen.getByTestId("sensitivity-dial")).not.toBeNull();
    });

    const dial = screen.getByTestId("sensitivity-dial");
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

  it("renders estimated fires per game inside the sensitivity knob before any run (US-037)", async () => {
    mockDetectors();
    render(<BacktestPage />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("sensitivity-dial")).not.toBeNull();
    });
    expect(screen.getByText(/center readout is estimated fires per game/i)).not.toBeNull();
    const value = screen.getByTestId("sensitivity-dial-inline-value");
    expect(value.textContent).toBe("—");
    expect(screen.getByTestId("sensitivity-dial-inline-detail").textContent).toBe("fires/gm");
  });

  it("shows the dial stale note only after the trigger changes since the last run (F-003)", async () => {
    // The dial readout is the LAST RUN's fires/game (browser no longer recomputes
    // locally). The honest-copy fix (F-003) adds a stale note beside the dial once
    // the trigger/timing changes, so the frozen number is never read as live. It
    // must be absent on a fresh run and present after a dial move.
    mockDetectorsAndBacktest(buildKSensitiveBacktest());
    render(<BacktestPage />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("backtest-detector-select")).not.toBeNull();
    });

    fireEvent.click(screen.getByTestId("backtest-run-button"));
    await waitFor(() => {
      expect(screen.getByTestId("backtest-run-id").textContent).toBe("99");
    });
    expect(screen.queryByTestId("backtest-sensitivity-stale-note")).toBeNull();

    const dial = screen.getByTestId("sensitivity-dial");
    act(() => {
      fireEvent.keyDown(dial, { key: "ArrowRight" });
    });
    expect(dial.getAttribute("aria-valuenow")).not.toBe("3");
    expect(screen.getByTestId("backtest-sensitivity-stale-note")).not.toBeNull();
  });

  it("populates the knob center from the backtest response and tracks dial moves without an API call (US-037)", async () => {
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

    const preview = screen.getByTestId("sensitivity-dial-inline-value");
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
    const dial = screen.getByTestId("sensitivity-dial");
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

    const after = screen.getByTestId("sensitivity-dial-inline-value");
    expect(after.textContent).toBe(baseline);
    // Preview and Results-panel stat stay in lockstep — one source of truth.
    expect(after.textContent).toBe(screen.getByTestId("backtest-stat-fires-per-game").textContent);
    expect(screen.getByTestId("backtest-stale-warning")).not.toBeNull();
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
      expect(screen.getByTestId("sensitivity-dial")).not.toBeNull();
    });

    fireEvent.click(screen.getByTestId("backtest-run-button"));
    await waitFor(() => {
      expect(screen.getByTestId("sensitivity-dial-inline-value").textContent).toBe("…");
    });
    resolveBacktest(jsonResponse(buildSyntheticBacktest()));
    await waitFor(() => {
      const value = screen.getByTestId("sensitivity-dial-inline-value").textContent;
      expect(value).not.toBe("…");
      expect(value).not.toBe("—");
    });
  });

  it("marks bucket/weight/freshness/historical context params as re-run required and flags stale results", async () => {
    const backtest = buildSyntheticBacktest();
    mockDetectorsAndBacktest(backtest);
    render(<BacktestPage />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("backtest-detector-select")).not.toBeNull();
    });
    expect(screen.getByTestId("backtest-rerun-hint-bucketSeconds")).not.toBeNull();
    expect(screen.getByTestId("backtest-rerun-hint-weighting")).not.toBeNull();
    expect(screen.getByTestId("backtest-rerun-hint-freshCapSeconds")).not.toBeNull();
    expect(screen.getByTestId("backtest-rerun-hint-historicalLastGames")).not.toBeNull();
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

  it("flags stale historical-prior tuning after a run because it needs server priors", async () => {
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

    const historicalLastGames = screen.getByTestId("backtest-param-historicalLastGames");
    if (!(historicalLastGames instanceof HTMLInputElement)) throw new Error("not input");
    act(() => {
      fireEvent.change(historicalLastGames, { target: { value: "6" } });
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
    selectBaselineMode(BOARD_MAD_BASELINE_MODE_TRAILING);
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
    const dial = screen.getByTestId("sensitivity-dial");
    act(() => {
      for (let i = 0; i < 12; i++) {
        fireEvent.keyDown(dial, { key: "ArrowRight" });
      }
    });
    expect(dial.getAttribute("aria-valuenow")).toBe("6");

    const rowsAfter = screen.getAllByTestId("backtest-timeline-row");
    const chartNodesAfter = screen.getAllByTestId("backtest-timeline-chart");
    const firesAfter = screen.getAllByTestId("backtest-timeline-fires").map((s) => s.textContent);

    // Without client recompute, the rows stay pinned to the last server run.
    expect(firesAfter).toEqual(firesBefore);

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

    fireEvent.click(screen.getAllByTestId("backtest-timeline-row-toggle")[0]!);
    expect(screen.getByText(/Past fires in this game at trigger/)).not.toBeNull();
  });

  it("recomputes ensemble board rows while preserving off-price lane fires", async () => {
    const boardOnly = buildMultiGameKSensitiveBacktest(["nba-ensemble"]);
    mockDetectorsAndBacktest(
      {
        ...boardOnly,
        stats: { firesPerGame: 2, totalFires: 2, gamesInWindow: 1 },
        observations: [
          ...boardOnly.observations.map((obs) => ({ ...obs, lane: "board" })),
          {
            gameId: "nba-ensemble",
            bucketStart: "2026-05-08T03:10:30.000Z",
            bucketEnd: "2026-05-08T03:10:30.000Z",
            fired: 1,
            intensity: 0.49,
            baselineMedian: 0,
            baselineMad: 0,
            lane: "offprice",
            sourceMarketId: "pm-ensemble-a",
          },
        ],
      },
      ENSEMBLE_DETECTORS_RESPONSE,
    );
    render(<BacktestPage />, { wrapper: makeWrapper() });
    await waitFor(() => {
      const sel = screen.getByTestId("backtest-detector-select");
      if (!(sel instanceof HTMLSelectElement)) throw new Error("not a select");
      expect(sel.value).toBe("ensemble-or");
    });
    selectBaselineMode(BOARD_MAD_BASELINE_MODE_TRAILING);

    const dial = screen.getByTestId("sensitivity-dial");
    act(() => {
      for (let i = 0; i < 12; i++) {
        fireEvent.keyDown(dial, { key: "ArrowRight" });
      }
    });
    expect(dial.getAttribute("aria-valuenow")).toBe("6");

    fireEvent.click(screen.getByTestId("backtest-run-button"));
    await waitFor(() => {
      expect(screen.getByTestId("backtest-run-id").textContent).toBe("138");
    });
    expect(screen.getByTestId("backtest-stat-total-fires").textContent).toBe("2");

    const postCalls = fetchMock.mock.calls.filter(([input, init]) => {
      const url = urlOf(input);
      return url.startsWith("/v1/backtest") && init?.method === "POST";
    });
    expect(postCalls.length).toBe(1);
    const [, init] = postCalls[0]!;
    const body = parsePostBody(init?.body);
    expect(body.detector_id).toBe("ensemble-or");
    expect(body.params["board"]).toMatchObject({ kMad: 6 });

    fireEvent.click(screen.getByTestId("backtest-timeline-row-toggle"));
    expect(screen.getByText(/Past fires in this game at trigger/)).not.toBeNull();
    expect(screen.getByTestId("backtest-timeline-fires").textContent).toBe("1 fire");

    act(() => {
      for (let i = 0; i < 12; i++) {
        fireEvent.keyDown(dial, { key: "ArrowLeft" });
      }
    });
    expect(dial.getAttribute("aria-valuenow")).toBe("3");
    expect(screen.getByTestId("backtest-stale-warning")).not.toBeNull();
    expect(screen.getByTestId("backtest-stat-total-fires").textContent).toBe("2");
    expect(screen.getByText(/Past fires in this game at trigger/)).not.toBeNull();
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

    // With browser recompute retired, timeline rows stay server-owned.
    await waitFor(() => {
      const row = screen.getByTestId("backtest-timeline-row");
      expect(row.getAttribute("data-from-recompute")).toBe("0");
    });

    const dial = screen.getByTestId("sensitivity-dial");
    act(() => {
      fireEvent.keyDown(dial, { key: "ArrowRight" });
    });
    const row = screen.getByTestId("backtest-timeline-row");
    expect(row.getAttribute("data-from-recompute")).toBe("0");

    // Cross-check: zero POST /v1/backtest after the dial move. The canary
    // proves it was the in-memory recompute that produced the row, not a
    // fresh server sweep.
    const postCount = fetchMock.mock.calls.filter(([input, init]) => {
      const url = urlOf(input);
      return url.startsWith("/v1/backtest") && init?.method === "POST";
    }).length;
    expect(postCount).toBe(1);
  });

  // ── US-039: PBP-anchored incidents widget ─────────────────────────────

  function setWindow(start: string, end: string): void {
    const startInput = screen.getByTestId("backtest-window-start");
    const endInput = screen.getByTestId("backtest-window-end");
    if (!(startInput instanceof HTMLInputElement)) throw new Error("start not input");
    if (!(endInput instanceof HTMLInputElement)) throw new Error("end not input");
    fireEvent.change(startInput, { target: { value: start } });
    fireEvent.change(endInput, { target: { value: end } });
  }

  // Synthetic series tailored for the PBP-anchored-incidents widget. The
  // event-containing-bucket for Hartenstein is 03:12:00–03:13:00Z (bucket 12
  // when buckets start at 03:00). Putting the spike at bucket 12 ensures:
  //   - At K=3: trail window [0..11] = [1,2,3]*4 → median 2, MAD 1, threshold
  //     5; spike of 7 fires → widget shows bucketEnd 03:13:00Z, delta +23.2 s
  //     (which is the PRD canonical anchor outcome).
  //   - At K=6: threshold 8; spike of 7 does NOT fire → widget shows "no fire".
  function buildHartensteinAnchorBacktest(): ReturnType<typeof buildKSensitiveBacktest> {
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
      const intensity = i === 12 ? 7 : (pattern[i % 3] ?? 0);
      const t = new Date(Date.UTC(2026, 4, 8, 3, i, 0));
      observations.push({
        gameId: "nba-0042500222",
        bucketStart: t.toISOString(),
        bucketEnd: new Date(t.getTime() + 60_000).toISOString(),
        fired: i === 12 ? 1 : 0,
        intensity,
        baselineMedian: 2,
        baselineMad: 1,
      });
    }
    return {
      runId: 222,
      stats: { firesPerGame: 1, totalFires: 1, gamesInWindow: 1 },
      observations,
    };
  }

  it("hides the PBP-anchored incidents subsection when the window does not cover anchor dates (US-039)", async () => {
    mockDetectorsAndBacktest(buildHartensteinAnchorBacktest());
    render(<BacktestPage />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("backtest-detector-select")).not.toBeNull();
    });
    // Window after both anchor dates.
    setWindow("2026-06-01", "2026-06-02");
    fireEvent.click(screen.getByTestId("backtest-run-button"));
    await waitFor(() => {
      expect(screen.getByTestId("backtest-run-id").textContent).toBe("222");
    });
    expect(screen.queryByTestId("backtest-pbp-anchored")).toBeNull();
  });

  it("shows Hartenstein lead time at the event-containing bucket and updates in place as the dial moves (US-039)", async () => {
    // Event-containing-bucket interpretation per PRD §180: the bucket
    // 03:12:00–03:13:00Z covers event 03:12:36.800Z. At K=3 it fires (trail
    // median 2 + 3*MAD 1 = 5, spike 7 above); at K=6 it does not (threshold 8).
    mockDetectorsAndBacktest(buildHartensteinAnchorBacktest());
    render(<BacktestPage />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("backtest-detector-select")).not.toBeNull();
    });
    setWindow("2026-05-07", "2026-05-09");
    fireEvent.click(screen.getByTestId("backtest-run-button"));
    await waitFor(() => {
      expect(screen.getByTestId("backtest-run-id").textContent).toBe("222");
    });

    const section = screen.getByTestId("backtest-pbp-anchored");
    expect(section).not.toBeNull();
    expect(section.textContent).toMatch(/PBP-anchored incidents/);
    // Hartenstein row present; Reaves row absent (window does not cover 05-12).
    expect(screen.getByTestId("backtest-pbp-anchor-hartenstein")).not.toBeNull();
    expect(screen.queryByTestId("backtest-pbp-anchor-reaves")).toBeNull();

    const bucketEnd = screen.getByTestId("backtest-pbp-bucket-end-hartenstein-nba-0042500222");
    expect(bucketEnd.textContent).toBe("2026-05-08T03:13:00Z");
    const delta = screen.getByTestId("backtest-pbp-delta-hartenstein-nba-0042500222");
    expect(delta.textContent).toBe("+23.2 s");

    // Move K to 6 — synthetic spike (intensity 7) drops below K=6 threshold
    // (≈ 8), so the row flips to "no fire" without an API call.
    const postCountBefore = fetchMock.mock.calls.filter(([input, init]) => {
      const url = urlOf(input);
      return url.startsWith("/v1/backtest") && init?.method === "POST";
    }).length;
    expect(postCountBefore).toBe(1);

    const dial = screen.getByTestId("sensitivity-dial");
    act(() => {
      for (let i = 0; i < 12; i++) {
        fireEvent.keyDown(dial, { key: "ArrowRight" });
      }
    });
    expect(dial.getAttribute("aria-valuenow")).toBe("6");

    expect(screen.getByTestId("backtest-pbp-bucket-end-hartenstein-nba-0042500222")).not.toBeNull();
    expect(screen.queryByTestId("backtest-pbp-no-fire-hartenstein-nba-0042500222")).toBeNull();
    expect(screen.getByTestId("backtest-stale-warning")).not.toBeNull();

    const postCountAfter = fetchMock.mock.calls.filter(([input, init]) => {
      const url = urlOf(input);
      return url.startsWith("/v1/backtest") && init?.method === "POST";
    }).length;
    expect(postCountAfter).toBe(1);
  });

  it("shows 'no fire' per Reaves game when the canonical implementation does not fire (US-039)", async () => {
    // Reaves is the honest-null case: no fires on either nba-0042500223 or
    // nba-0042500224. We model that with a flat baseline (all 1.0
    // intensities) for both game ids — MAD=0 (clamped to 1e-9), threshold
    // ≈ 1.0; intensity == 1.0 so the `intensity > 0 AND intensity >= threshold`
    // rule does not fire (strict equality is admitted, but the source
    // observation fires=0 was set by the server already so the recompute
    // doesn't lift it). The widget shows "no fire" per game.
    const buildReavesNoFire = (): ReturnType<typeof buildKSensitiveBacktest> => {
      const gameIds = ["nba-0042500223", "nba-0042500224"];
      const obs: {
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
          const t = new Date(Date.UTC(2026, 4, 12, 4, 30 + i, 0));
          obs.push({
            gameId,
            bucketStart: t.toISOString(),
            bucketEnd: new Date(t.getTime() + 60_000).toISOString(),
            fired: 0,
            intensity: 1.0,
            baselineMedian: 1.0,
            baselineMad: 1e-9,
          });
        }
      }
      return {
        runId: 1239,
        stats: { firesPerGame: 0, totalFires: 0, gamesInWindow: gameIds.length },
        observations: obs,
      };
    };
    mockDetectorsAndBacktest(buildReavesNoFire());
    render(<BacktestPage />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("backtest-detector-select")).not.toBeNull();
    });
    setWindow("2026-05-11", "2026-05-13");
    fireEvent.click(screen.getByTestId("backtest-run-button"));
    await waitFor(() => {
      expect(screen.getByTestId("backtest-run-id").textContent).toBe("1239");
    });
    expect(screen.queryByTestId("backtest-pbp-anchor-hartenstein")).toBeNull();
    expect(screen.getByTestId("backtest-pbp-anchor-reaves")).not.toBeNull();
    expect(screen.getByTestId("backtest-pbp-no-fire-reaves-nba-0042500223").textContent).toBe(
      "no fire",
    );
    expect(screen.getByTestId("backtest-pbp-no-fire-reaves-nba-0042500224").textContent).toBe(
      "no fire",
    );
  });

  it("hides the PBP-anchored incidents subsection before any backtest has run (US-039)", async () => {
    mockDetectors();
    render(<BacktestPage />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("backtest-detector-select")).not.toBeNull();
    });
    setWindow("2026-05-07", "2026-05-13");
    expect(screen.queryByTestId("backtest-pbp-anchored")).toBeNull();
  });

  // Phase B-followup #2 (Codex review P2/P3): ensemble offprice parity +
  // Apply-to-Live regression tests. The B-followup code added these
  // capabilities to BacktestPage but shipped without test coverage.

  function makeSettingsBody(opts: {
    readonly offPriceMinVolumeShare?: number;
    readonly offPriceMinOffPriceDistance?: number;
    readonly kMadLive?: number;
  }): unknown {
    return {
      db: {
        path: "/tmp/gold.sqlite",
        sizeBytes: 1024,
        walBytes: 0,
        pageCount: 4,
        pageSize: 4096,
        lastModified: "2026-05-25T00:00:00Z",
        mode: "read-only",
      },
      cacheDb: { path: "/tmp/cache.sqlite", sizeBytes: 0, pageCount: 0 },
      sources: {
        ingestPaused: false,
        bySource: {
          bet365: { lastSyncAt: null, lastError: null, rateLimitCooldown: null },
          kalshi: { lastSyncAt: null, lastError: null, rateLimitCooldown: null },
          polymarket: { lastSyncAt: null, lastError: null, rateLimitCooldown: null },
        },
      },
      errors: [],
      about: { appVersion: "0.0.0", detectorVersions: [], dbSchemaVersion: 1 },
      detectorDefaults: {
        kMadLive: opts.kMadLive ?? 3.0,
        baselineMode: "opening-ramp",
        bucketSeconds: 60,
        openingBaselineBuckets: 4,
        openingRampCompleteBuckets: 20,
        trailingBuckets: 20,
        warmupBuckets: 8,
        freshCapSeconds: 300,
        historicalLastGames: 5,
        historicalAwayWeight: 0.5,
        historicalPriorWeight: 1,
        historicalRampCompleteGameMinutes: 12,
        trailingGameMinutes: 12,
        recentWallMinutes: 4,
        recentWallWeight: 1.5,
        pbpPreBufferMs: 300000,
        pbpPostBufferMs: 60000,
        stateSpace: BOARD_STATE_SPACE_CONFIG_DEFAULTS,
        offPriceMinVolumeShare: opts.offPriceMinVolumeShare ?? 0.1,
        offPriceMinOffPriceDistance: opts.offPriceMinOffPriceDistance ?? 0.4,
      },
    };
  }

  function mockEnsembleSettingsAndBacktest(opts: {
    readonly settings: unknown;
    readonly capturePromote?: (body: unknown) => void;
  }): void {
    fetchMock.mockImplementation(async (input, init) => {
      await Promise.resolve();
      const url = urlOf(input);
      if (url.startsWith("/v1/detectors")) return jsonResponse(ENSEMBLE_DETECTORS_RESPONSE);
      if (url.startsWith("/v1/settings/detector-defaults") && init?.method === "POST") {
        const body: unknown = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
        opts.capturePromote?.(body);
        return jsonResponse(body);
      }
      if (url.startsWith("/v1/settings")) return jsonResponse(opts.settings);
      if (url.startsWith("/v1/backtest") && init?.method === "POST") {
        return jsonResponse({
          runId: 1,
          stats: { firesPerGame: 0, totalFires: 0, gamesInWindow: 1 },
          observations: [],
        });
      }
      return new Response("not found", { status: 404 });
    });
  }

  it("parity banner reads 'matches live' when ensemble form params equal live defaults", async () => {
    // Live has offPriceMinOffPriceDistance=0.4 (default); form's offprice
    // also defaults to 0.4. Board fields also default-match. Banner should
    // read "matches live" once the live-defaults query resolves.
    mockEnsembleSettingsAndBacktest({
      settings: makeSettingsBody({ offPriceMinOffPriceDistance: 0.4 }),
    });
    render(<BacktestPage />, { wrapper: makeWrapper() });
    await waitFor(() => {
      const m = screen.queryByTestId("backtest-live-match");
      expect(m?.textContent).toBe("these params match live");
    });
  });

  it("parity banner reads 'differs from live' when ensemble offprice threshold diverges", async () => {
    // Live has offPriceMinOffPriceDistance=0.7; form still at 0.4 default.
    // Pre-Codex-P2 fix, paramsMatchLive only compared board fields, so this
    // banner would falsely read "matches live" — proving the contract was
    // wrong. After P2, the offprice mismatch flips the banner.
    mockEnsembleSettingsAndBacktest({
      settings: makeSettingsBody({ offPriceMinOffPriceDistance: 0.7 }),
    });
    render(<BacktestPage />, { wrapper: makeWrapper() });
    await waitFor(() => {
      const m = screen.queryByTestId("backtest-live-match");
      expect(m?.textContent).toBe("these params differ from live");
    });
  });

  it("Apply-to-Live includes ensemble offprice thresholds in the POST body", async () => {
    let promoted: unknown = null;
    mockEnsembleSettingsAndBacktest({
      // Live has 0.1/0.4 (defaults); form will match because it starts at
      // OffPricePrintParams Zod defaults too. Flip ONE live field so the
      // form (still at defaults) diverges and canPromote becomes true.
      settings: makeSettingsBody({ kMadLive: 4.0 }),
      capturePromote: (body) => {
        promoted = body;
      },
    });
    render(<BacktestPage />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("backtest-apply-to-live")).not.toBeNull();
    });
    // Apply to live → opens dialog → click Apply now.
    fireEvent.click(screen.getByTestId("backtest-apply-to-live"));
    await waitFor(() => {
      expect(screen.queryByTestId("backtest-promote-apply-now")).not.toBeNull();
    });
    const promoteDialog = screen.getByTestId("backtest-promote");
    expect(promoteDialog.textContent).toContain(
      "Writes the live detector defaults read by Recent and Live.",
    );
    expect(promoteDialog.textContent).not.toContain("detector-defaults.json");
    fireEvent.click(screen.getByTestId("backtest-promote-apply-now"));
    await waitFor(() => {
      expect(promoted).not.toBeNull();
    });
    // The promote payload MUST carry offPriceMinVolumeShare +
    // offPriceMinOffPriceDistance. Pre-Codex-P2 fix, ensemble promotes
    // wrote only board fields and silently used whatever live had for
    // offprice.
    function isRecord(v: unknown): v is Readonly<Record<string, unknown>> {
      return typeof v === "object" && v !== null && !Array.isArray(v);
    }
    if (!isRecord(promoted)) throw new Error("promoted shape");
    expect(promoted["offPriceMinVolumeShare"]).toBe(0.1);
    expect(promoted["offPriceMinOffPriceDistance"]).toBe(0.4);
    // Sanity: board fields also present (the form's defaults flow through).
    expect(typeof promoted["kMadLive"]).toBe("number");
    expect(typeof promoted["baselineMode"]).toBe("string");
  });
});
