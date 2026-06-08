import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode, JSX } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  LivePage,
  buildChartData,
  buildTradePrintChartData,
  offPriceMarkersForDomain,
} from "../LivePage";

const GAME_ID = "nba-0042500313";

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

function defaultLiveActivity() {
  return {
    gameState: null,
    playByPlayActionCount: 0,
    recentPlayByPlay: [],
  };
}

function activeGameActivity() {
  return {
    gameState: {
      awayScore: 56,
      capturedAt: "2026-06-06T01:58:05.000Z",
      clock: "PT00M00.00S",
      finalAt: null,
      homeScore: 52,
      isFinal: false,
      period: 2,
      startedAt: "2026-06-06T00:33:00.000Z",
      status: "in-play",
    },
    playByPlayActionCount: 311,
    recentPlayByPlay: [
      {
        actionNumber: 379,
        actionType: "period",
        clock: "PT00M00.00S",
        description: "Period End",
        period: 2,
        personId: null,
        playerName: null,
        scoreAway: "56",
        scoreHome: "52",
        subType: null,
        teamTricode: null,
        timeActual: "2026-06-06T01:56:02.500Z",
      },
    ],
  };
}

function scheduledGameActivity() {
  return {
    gameState: {
      awayScore: null,
      capturedAt: "2026-06-06T01:58:05.000Z",
      clock: null,
      finalAt: null,
      homeScore: null,
      isFinal: false,
      period: 0,
      startedAt: null,
      status: "scheduled",
    },
    playByPlayActionCount: 0,
    recentPlayByPlay: [],
  };
}

type LiveActivityFixture =
  | ReturnType<typeof activeGameActivity>
  | ReturnType<typeof scheduledGameActivity>;

function liveResponse(opts: {
  gameId: string;
  tickCount: number;
  activity?: LiveActivityFixture;
}): Response {
  const ticks = Array.from({ length: opts.tickCount }, (_unused, i) => ({
    sourceMarketId: `sm-${String(i)}`,
    capturedAt: `2026-05-23T03:${String(i).padStart(2, "0")}:00Z`,
    impliedProbability: 0.5 + i * 0.001,
    volume: 100 + i,
    isHeartbeat: 0,
    instrumentId: `inst-${String(i)}`,
    rawFamily: "spread",
    rawLabel: "home -3.5",
  }));
  return jsonResponse({
    activity: opts.activity ?? defaultLiveActivity(),
    gameId: opts.gameId,
    windowStart: "2026-05-23T02:55:00Z",
    windowEnd: "2026-05-23T03:00:00Z",
    ticks,
  });
}

function microstructureResponse(opts: {
  gameId: string;
  eventTimestamps?: readonly string[];
  eventOverrides?: readonly Record<string, unknown>[];
}): Response {
  const events = (opts.eventTimestamps ?? []).map((eventTimestamp, i) => ({
    id: i + 1,
    source: "polymarket",
    sourceMarketId: `poly-${String(i)}`,
    gameId: opts.gameId,
    instrumentId: `nba-${String(i)}-trade-print`,
    eventType: "trade",
    apiSurface: "trades",
    eventTimestamp,
    capturedAt: eventTimestamp,
    price: 0.62 + i * 0.01,
    previousPrice: 0.58,
    tradePrice: 0.62 + i * 0.01,
    size: 100 + i,
    notional: 62 + i,
    volume: 1000,
    finalMarketVolume: 2500,
    volumeShare: 0.4,
    bestBid: null,
    bestAsk: null,
    spread: null,
    depthScore: null,
    ...(opts.eventOverrides?.[i] ?? {}),
  }));
  return jsonResponse({ gameId: opts.gameId, theta: 0.1, events });
}

function offPricePrintResponse(opts: {
  gameId: string;
  fires?: readonly { readonly bucketStart: string; readonly sourceMarketId: string }[];
}): Response {
  return jsonResponse({
    gameId: opts.gameId,
    runId: 1,
    fires: (opts.fires ?? []).map((fire) => ({
      bucketStart: fire.bucketStart,
      bucketEnd: fire.bucketStart,
      intensity: 0.75,
      sourceMarketId: fire.sourceMarketId,
    })),
  });
}

function settingsResponse(opts: { readonly offPriceMinVolumeShare?: number } = {}): Response {
  return jsonResponse({
    db: {
      path: "/tmp/signal-console.sqlite",
      sizeBytes: 1,
      walBytes: 0,
      pageCount: 1,
      pageSize: 4096,
      lastModified: "2026-05-23T00:00:00.000Z",
      mode: "read-only",
    },
    cacheDb: {
      path: "/tmp/detector-cache.sqlite",
      sizeBytes: 1,
      pageCount: 1,
    },
    sources: {
      ingestPaused: false,
      bySource: {},
    },
    errors: [],
    about: {
      appVersion: "test",
      detectorVersions: [],
      dbSchemaVersion: 18,
    },
    detectorDefaults: {
      kMadLive: 3,
      baselineMode: "opening-ramp",
      bucketSeconds: 60,
      openingBaselineBuckets: 12,
      openingRampCompleteBuckets: 24,
      trailingBuckets: 60,
      warmupBuckets: 3,
      freshCapSeconds: 90,
      historicalLastGames: 6,
      historicalAwayWeight: 0.35,
      historicalPriorWeight: 0.25,
      historicalRampCompleteGameMinutes: 36,
      trailingGameMinutes: 18,
      recentWallMinutes: 10,
      recentWallWeight: 0.5,
      pbpPreBufferMs: 300000,
      pbpPostBufferMs: 60000,
      stateSpace: {},
      offPriceMinVolumeShare: opts.offPriceMinVolumeShare ?? 0.1,
      offPriceMinOffPriceDistance: 0.4,
    },
  });
}

function ensembleOrResponse(opts: {
  gameId: string;
  boardObservations?: readonly {
    readonly bucketStart: string;
    readonly bucketEnd: string;
    readonly fired: number;
    readonly intensity: number;
  }[];
  fires?: readonly {
    readonly bucketStart: string;
    readonly bucketEnd: string;
    readonly lane: "board" | "offprice";
    readonly sourceMarketId?: string;
  }[];
  k?: number;
}): Response {
  return jsonResponse({
    gameId: opts.gameId,
    runId: 1,
    k: opts.k ?? 3,
    boardObservations: (opts.boardObservations ?? []).map((obs) => ({
      bucketStart: obs.bucketStart,
      bucketEnd: obs.bucketEnd,
      fired: obs.fired,
      intensity: obs.intensity,
      baselineMedian: 0.2,
      baselineMad: 0.1,
      warmedUp: true,
    })),
    fires: (opts.fires ?? []).map((fire) => ({
      bucketStart: fire.bucketStart,
      bucketEnd: fire.bucketEnd,
      intensity: 0.75,
      lane: fire.lane,
      sourceMarketId: fire.sourceMarketId,
    })),
  });
}

type FetchFn = typeof fetch;

function urlOf(input: Parameters<FetchFn>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function mockLiveAndModel(
  fetchMock: ReturnType<typeof vi.fn<FetchFn>>,
  live: Response,
  micro: Response,
  offPrice: Response = offPricePrintResponse({ gameId: GAME_ID }),
  ensemble: Response = ensembleOrResponse({ gameId: GAME_ID }),
  settings: Response = settingsResponse(),
): void {
  fetchMock.mockImplementation(async (input) => {
    await Promise.resolve();
    const url = urlOf(input);
    if (url.startsWith("/v1/settings")) return settings.clone();
    if (url.startsWith("/v1/live/")) return live.clone();
    if (url.startsWith("/v1/ensemble-or/")) return ensemble.clone();
    if (url.startsWith("/v1/microstructure/")) return micro.clone();
    if (url.startsWith("/v1/off-price-print/")) return offPrice.clone();
    return new Response("not found", { status: 404 });
  });
}

describe("offPriceMarkersForDomain", () => {
  it("keeps off-price events inside the visible chart time range even when they are between sparse board buckets", () => {
    const markers = offPriceMarkersForDomain(
      [
        {
          id: "1",
          eventTimestamp: "2026-05-23T03:01:30Z",
        },
      ],
      {
        minMs: Date.parse("2026-05-23T03:00:00Z"),
        maxMs: Date.parse("2026-05-23T03:03:00Z"),
      },
    );
    expect(markers).toEqual([{ id: "1", timeMs: Date.parse("2026-05-23T03:01:30Z") }]);
  });

  it("drops off-price events outside the visible chart time range", () => {
    const markers = offPriceMarkersForDomain(
      [
        {
          id: "1",
          eventTimestamp: "2026-05-23T03:05:00Z",
        },
      ],
      {
        minMs: Date.parse("2026-05-23T03:00:00Z"),
        maxMs: Date.parse("2026-05-23T03:03:00Z"),
      },
    );
    expect(markers).toEqual([]);
  });
});

describe("buildChartData", () => {
  it("puts the visible alert threshold on every chart point as baseline median plus K times MAD", () => {
    const data = buildChartData(
      [
        {
          bucketStart: "2026-05-23T03:00:00Z",
          bucketEnd: "2026-05-23T03:01:00Z",
          fired: 0,
          intensity: 0.22,
          baselineMedian: 0.1,
          baselineMad: 0.03,
          warmedUp: true,
        },
      ],
      3,
    );
    expect(data).toEqual([
      {
        timeMs: Date.parse("2026-05-23T03:00:00Z"),
        bucketStart: "2026-05-23T03:00:00Z",
        bucketEnd: "2026-05-23T03:01:00Z",
        intensity: 0.22,
        threshold: 0.19,
        fired: 0,
      },
    ]);
  });

  it("does not draw warmup sentinel zeros as an alert threshold", () => {
    const data = buildChartData(
      [
        {
          bucketStart: "2026-05-23T03:00:00Z",
          bucketEnd: "2026-05-23T03:01:00Z",
          fired: 0,
          intensity: 42,
          baselineMedian: 0,
          baselineMad: 0,
          warmedUp: false,
        },
        {
          bucketStart: "2026-05-23T03:01:00Z",
          bucketEnd: "2026-05-23T03:02:00Z",
          fired: 0,
          intensity: 45,
          baselineMedian: 40,
          baselineMad: 5,
          warmedUp: true,
        },
      ],
      3,
    );
    expect(data.map((d) => d.threshold)).toEqual([null, 55]);
  });
});

describe("buildTradePrintChartData", () => {
  it("sorts trade prints by event time and maps price points without buckets", () => {
    const data = buildTradePrintChartData([
      {
        id: 2,
        source: "polymarket",
        sourceMarketId: "poly-2",
        gameId: GAME_ID,
        instrumentId: "inst-2",
        eventType: "trade",
        apiSurface: "trades",
        eventTimestamp: "2026-05-23T03:02:30Z",
        capturedAt: "2026-05-23T03:02:31Z",
        price: 0.63,
        previousPrice: null,
        tradePrice: 0.63,
        size: 101,
        notional: 63,
        volume: 1000,
        finalMarketVolume: null,
        volumeShare: 0.4,
        bestBid: null,
        bestAsk: null,
        spread: null,
        depthScore: null,
      },
      {
        id: 1,
        source: "polymarket",
        sourceMarketId: "poly-1",
        gameId: GAME_ID,
        instrumentId: "inst-1",
        eventType: "trade",
        apiSurface: "trades",
        eventTimestamp: "2026-05-23T03:01:30Z",
        capturedAt: "2026-05-23T03:01:31Z",
        price: 0.62,
        previousPrice: null,
        tradePrice: 0.62,
        size: 100,
        notional: 62,
        volume: 1000,
        finalMarketVolume: null,
        volumeShare: 0.35,
        bestBid: null,
        bestAsk: null,
        spread: null,
        depthScore: null,
      },
    ]);
    expect(data.map((point) => point.eventTimestamp)).toEqual([
      "2026-05-23T03:01:30Z",
      "2026-05-23T03:02:30Z",
    ]);
    expect(data.map((point) => point.price)).toEqual([0.62, 0.63]);
  });
});

describe("LivePage", () => {
  let fetchMock: ReturnType<typeof vi.fn<FetchFn>>;

  beforeEach(() => {
    fetchMock = vi.fn<FetchFn>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the no-game placeholder when gameId is null and fires no requests", () => {
    render(<LivePage gameId={null} />, { wrapper: makeWrapper() });
    expect(screen.getByTestId("live-no-game")).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders the gameId in the title and a back-to-recent link", async () => {
    mockLiveAndModel(
      fetchMock,
      liveResponse({ gameId: GAME_ID, tickCount: 4 }),
      microstructureResponse({ gameId: GAME_ID }),
    );
    render(<LivePage gameId={GAME_ID} />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("live-title").textContent).toBe(GAME_ID);
    });
    expect(screen.getByTestId("live-back-to-recent")).toBeDefined();
  });

  it("fires live, ensemble, microstructure, and off-price model requests on mount", async () => {
    mockLiveAndModel(
      fetchMock,
      liveResponse({ gameId: GAME_ID, tickCount: 2 }),
      microstructureResponse({ gameId: GAME_ID }),
      offPricePrintResponse({ gameId: GAME_ID }),
      ensembleOrResponse({ gameId: GAME_ID }),
      settingsResponse({ offPriceMinVolumeShare: 0.04 }),
    );
    render(<LivePage gameId={GAME_ID} />, { wrapper: makeWrapper() });
    await waitFor(() => {
      const calledUrls = fetchMock.mock.calls.map((c) => urlOf(c[0]));
      expect(calledUrls.some((u) => u.startsWith(`/v1/settings`))).toBe(true);
      expect(calledUrls.some((u) => u.startsWith(`/v1/live/${GAME_ID}`))).toBe(true);
      expect(calledUrls.some((u) => u.startsWith(`/v1/ensemble-or/${GAME_ID}`))).toBe(true);
      expect(calledUrls.some((u) => u === `/v1/microstructure/${GAME_ID}?theta=0.04`)).toBe(true);
      expect(calledUrls.some((u) => u.startsWith(`/v1/off-price-print/${GAME_ID}`))).toBe(true);
    });
  });

  it("renders the ensemble board lane alongside point-event trade prints", async () => {
    mockLiveAndModel(
      fetchMock,
      liveResponse({ gameId: GAME_ID, tickCount: 0 }),
      microstructureResponse({
        gameId: GAME_ID,
        eventTimestamps: ["2026-05-23T03:02:30Z"],
      }),
      offPricePrintResponse({
        gameId: GAME_ID,
        fires: [{ bucketStart: "2026-05-23T03:02:30Z", sourceMarketId: "poly-0" }],
      }),
      ensembleOrResponse({
        gameId: GAME_ID,
        k: 3,
        boardObservations: [
          {
            bucketStart: "2026-05-23T03:01:00Z",
            bucketEnd: "2026-05-23T03:02:00Z",
            fired: 1,
            intensity: 0.74,
          },
          {
            bucketStart: "2026-05-23T03:02:00Z",
            bucketEnd: "2026-05-23T03:03:00Z",
            fired: 0,
            intensity: 0.38,
          },
        ],
        fires: [
          {
            bucketStart: "2026-05-23T03:01:00Z",
            bucketEnd: "2026-05-23T03:02:00Z",
            lane: "board",
          },
          {
            bucketStart: "2026-05-23T03:02:30Z",
            bucketEnd: "2026-05-23T03:03:00Z",
            lane: "offprice",
            sourceMarketId: "poly-0",
          },
        ],
      }),
    );
    render(<LivePage gameId={GAME_ID} />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("live-fires-count").textContent).toBe("1");
    });
    expect(screen.getByTestId("live-k").textContent).toBe("3.0");
    expect(screen.getByTestId("live-offprice-count").textContent).toBe("1");
    expect(screen.getByTestId("live-timeline")).toBeDefined();
    await waitFor(() => {
      expect(screen.getByTestId("live-trade-count").textContent).toBe("1");
    });
  });

  it("renders point-event trade prints and strict off-price fires", async () => {
    mockLiveAndModel(
      fetchMock,
      liveResponse({ gameId: GAME_ID, tickCount: 0 }),
      microstructureResponse({
        gameId: GAME_ID,
        eventTimestamps: ["2026-05-23T03:01:30Z", "2026-05-23T03:02:30Z"],
      }),
      offPricePrintResponse({
        gameId: GAME_ID,
        fires: [{ bucketStart: "2026-05-23T03:02:30Z", sourceMarketId: "poly-1" }],
      }),
    );
    render(<LivePage gameId={GAME_ID} />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("live-trade-count").textContent).toBe("1");
    });
    expect(screen.getByTestId("live-trade-offprice-count").textContent).toBe("1");
    expect(screen.getByTestId("live-trade-timeline")).toBeDefined();
    expect(screen.getByTestId("live-trade-table").textContent).toContain("nba-1-trade-print");
    expect(screen.getByTestId("live-offprice-fire-list").textContent).toContain("poly-1");
  });

  it("filters the trade-print model to Polymarket trade events", async () => {
    mockLiveAndModel(
      fetchMock,
      liveResponse({ gameId: GAME_ID, tickCount: 0 }),
      microstructureResponse({
        gameId: GAME_ID,
        eventTimestamps: ["2026-05-23T03:01:30Z", "2026-05-23T03:02:30Z", "2026-05-23T03:03:30Z"],
        eventOverrides: [
          {},
          {
            source: "kalshi",
            sourceMarketId: "kalshi-1",
            instrumentId: "kalshi-event",
          },
          {
            eventType: "quote",
            sourceMarketId: "poly-quote",
            instrumentId: "polymarket-quote",
          },
        ],
      }),
      offPricePrintResponse({
        gameId: GAME_ID,
        fires: [{ bucketStart: "2026-05-23T03:01:30Z", sourceMarketId: "poly-0" }],
      }),
    );
    render(<LivePage gameId={GAME_ID} />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("live-trade-count").textContent).toBe("1");
    });
    const tableText = screen.getByTestId("live-trade-table").textContent;
    expect(tableText).toContain("nba-0-trade-print");
    expect(tableText).not.toContain("kalshi-event");
    expect(tableText).not.toContain("polymarket-quote");
  });

  it("does not render model query failures as zero-event trade-print data", async () => {
    mockLiveAndModel(
      fetchMock,
      liveResponse({ gameId: GAME_ID, tickCount: 0 }),
      new Response("upstream down", { status: 503, statusText: "Service Unavailable" }),
    );
    render(<LivePage gameId={GAME_ID} />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("query-error-banner").textContent).toContain(
        "Failed to load trade-print events",
      );
    });
    expect(screen.getByTestId("live-model-status").textContent).toContain("unavailable");
    expect(screen.getByTestId("live-model-unavailable")).toBeDefined();
    expect(screen.queryByTestId("live-trade-count")).toBeNull();
    expect(screen.queryByTestId("live-model-empty")).toBeNull();
  });

  it("renders official game activity separately from the point-event model and does not show market buckets as game minutes", async () => {
    mockLiveAndModel(
      fetchMock,
      liveResponse({ gameId: GAME_ID, tickCount: 5, activity: activeGameActivity() }),
      microstructureResponse({
        gameId: GAME_ID,
        eventTimestamps: ["2026-05-23T03:01:30Z", "2026-05-23T03:02:30Z"],
      }),
      offPricePrintResponse({
        gameId: GAME_ID,
        fires: [
          { bucketStart: "2026-05-23T03:01:30Z", sourceMarketId: "poly-0" },
          { bucketStart: "2026-05-23T03:02:30Z", sourceMarketId: "poly-1" },
        ],
      }),
    );
    render(<LivePage gameId={GAME_ID} />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("live-game-state").textContent).toContain("Q2 0:00");
    });
    expect(screen.getByTestId("live-score").textContent).toBe("56-52");
    expect(screen.getByTestId("live-pbp-count").textContent).toBe("311 actions");
    expect(screen.getByTestId("live-pbp-list").textContent).toContain("Period End");
    await waitFor(() => {
      expect(screen.getByTestId("live-model-panel").textContent).toContain("2 trade prints");
    });
    expect(screen.getByTestId("live-board-panel")).toBeDefined();
    expect(screen.queryByText(/wall-clock market bucket/i)).toBeNull();
  });

  it("renders scheduled game activity as pregame instead of a Q0 period", async () => {
    mockLiveAndModel(
      fetchMock,
      liveResponse({ gameId: GAME_ID, tickCount: 0, activity: scheduledGameActivity() }),
      microstructureResponse({ gameId: GAME_ID }),
    );
    render(<LivePage gameId={GAME_ID} />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("live-game-state").textContent).toContain("pregame");
    });
    expect(screen.getByTestId("live-game-state").textContent).not.toContain("Q0");
  });

  it("shows the empty-state when the trade-print model has no point events", async () => {
    mockLiveAndModel(
      fetchMock,
      liveResponse({ gameId: GAME_ID, tickCount: 0 }),
      microstructureResponse({ gameId: GAME_ID }),
    );
    render(<LivePage gameId={GAME_ID} />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.queryByTestId("live-model-empty")).not.toBeNull();
    });
    expect(screen.getByTestId("live-trade-count").textContent).toBe("0");
  });

  it("shows the API-unreachable banner when fetch throws a TypeError", async () => {
    fetchMock.mockImplementation(async () => {
      await Promise.resolve();
      throw new TypeError("Failed to fetch");
    });
    render(<LivePage gameId={GAME_ID} />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.queryByTestId("api-unreachable-banner")).not.toBeNull();
    });
  });
});
