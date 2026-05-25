import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode, JSX } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { LivePage, buildChartData, offPriceMarkersForDomain } from "../LivePage";

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

function liveResponse(opts: { gameId: string; tickCount: number }): Response {
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
    gameId: opts.gameId,
    windowStart: "2026-05-23T02:55:00Z",
    windowEnd: "2026-05-23T03:00:00Z",
    ticks,
  });
}

function boardResponse(opts: {
  gameId: string;
  firesCount: number;
  nonFiresCount?: number;
}): Response {
  const nonFires = opts.nonFiresCount ?? 0;
  const observations: unknown[] = [];
  for (let i = 0; i < nonFires; i++) {
    observations.push({
      bucketStart: `2026-05-23T03:${String(i).padStart(2, "0")}:00Z`,
      bucketEnd: `2026-05-23T03:${String(i + 1).padStart(2, "0")}:00Z`,
      fired: 0,
      intensity: 0.1 + i * 0.01,
      baselineMedian: 0.1,
      baselineMad: 0.02,
      warmedUp: true,
    });
  }
  for (let i = 0; i < opts.firesCount; i++) {
    const m = nonFires + i;
    observations.push({
      bucketStart: `2026-05-23T03:${String(m).padStart(2, "0")}:00Z`,
      bucketEnd: `2026-05-23T03:${String(m + 1).padStart(2, "0")}:00Z`,
      fired: 1,
      intensity: 1.5 + i * 0.1,
      baselineMedian: 0.1,
      baselineMad: 0.05,
      warmedUp: true,
    });
  }
  return jsonResponse({ gameId: opts.gameId, runId: 1, k: 3.0, observations });
}

function microstructureResponse(opts: {
  gameId: string;
  eventTimestamps?: readonly string[];
}): Response {
  const events = (opts.eventTimestamps ?? []).map((eventTimestamp, i) => ({
    id: i + 1,
    source: "polymarket",
    sourceMarketId: `poly-${String(i)}`,
    gameId: opts.gameId,
    instrumentId: `inst-${String(i)}`,
    eventType: "trade",
    apiSurface: "trades",
    eventTimestamp,
    capturedAt: eventTimestamp,
    price: 0.62,
    previousPrice: 0.58,
    tradePrice: 0.62,
    size: 100,
    notional: 62,
    volume: 1000,
    finalMarketVolume: 2500,
    volumeShare: 0.4,
    bestBid: null,
    bestAsk: null,
    spread: null,
    depthScore: null,
  }));
  return jsonResponse({ gameId: opts.gameId, theta: 0.1, events });
}

type FetchFn = typeof fetch;

function urlOf(input: Parameters<FetchFn>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function mockLiveAndBoard(
  fetchMock: ReturnType<typeof vi.fn<FetchFn>>,
  live: Response,
  board: Response,
  micro: Response = microstructureResponse({ gameId: GAME_ID }),
): void {
  fetchMock.mockImplementation(async (input) => {
    await Promise.resolve();
    const url = urlOf(input);
    if (url.startsWith("/v1/live/")) return live.clone();
    if (url.startsWith("/v1/board/")) return board.clone();
    if (url.startsWith("/v1/microstructure/")) return micro.clone();
    return new Response("not found", { status: 404 });
  });
}

const GAME_ID = "nba-0042500313";

describe("offPriceMarkersForDomain", () => {
  it("keeps off-price events inside the visible chart time range even when they are between sparse board buckets", () => {
    const markers = offPriceMarkersForDomain(
      [
        {
          id: 1,
          source: "polymarket",
          sourceMarketId: "poly-1",
          gameId: GAME_ID,
          instrumentId: "inst-1",
          eventType: "trade",
          apiSurface: "trades",
          eventTimestamp: "2026-05-23T03:01:30Z",
          capturedAt: "2026-05-23T03:01:30Z",
          price: 0.62,
          previousPrice: 0.58,
          tradePrice: 0.62,
          size: 100,
          notional: 62,
          volume: 1000,
          finalMarketVolume: 2500,
          volumeShare: 0.4,
          bestBid: null,
          bestAsk: null,
          spread: null,
          depthScore: null,
        },
      ],
      {
        minMs: Date.parse("2026-05-23T03:00:00Z"),
        maxMs: Date.parse("2026-05-23T03:03:00Z"),
      },
    );
    expect(markers).toEqual([{ id: 1, timeMs: Date.parse("2026-05-23T03:01:30Z") }]);
  });

  it("drops off-price events outside the visible chart time range", () => {
    const markers = offPriceMarkersForDomain(
      [
        {
          id: 1,
          source: "polymarket",
          sourceMarketId: "poly-1",
          gameId: GAME_ID,
          instrumentId: "inst-1",
          eventType: "trade",
          apiSurface: "trades",
          eventTimestamp: "2026-05-23T03:05:00Z",
          capturedAt: "2026-05-23T03:05:00Z",
          price: 0.62,
          previousPrice: 0.58,
          tradePrice: 0.62,
          size: 100,
          notional: 62,
          volume: 1000,
          finalMarketVolume: 2500,
          volumeShare: 0.4,
          bestBid: null,
          bestAsk: null,
          spread: null,
          depthScore: null,
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
    mockLiveAndBoard(
      fetchMock,
      liveResponse({ gameId: GAME_ID, tickCount: 4 }),
      boardResponse({ gameId: GAME_ID, firesCount: 1 }),
    );
    render(<LivePage gameId={GAME_ID} />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("live-title").textContent).toBe(GAME_ID);
    });
    expect(screen.getByTestId("live-back-to-recent")).toBeDefined();
  });

  it("fires GET /v1/live/:gameId and GET /v1/board/:gameId on mount", async () => {
    mockLiveAndBoard(
      fetchMock,
      liveResponse({ gameId: GAME_ID, tickCount: 2 }),
      boardResponse({ gameId: GAME_ID, firesCount: 0, nonFiresCount: 3 }),
    );
    render(<LivePage gameId={GAME_ID} />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const calledUrls = fetchMock.mock.calls.map((c) => urlOf(c[0]));
    expect(calledUrls.some((u) => u.startsWith(`/v1/live/${GAME_ID}`))).toBe(true);
    expect(calledUrls.some((u) => u.startsWith(`/v1/board/${GAME_ID}`))).toBe(true);
    expect(calledUrls.some((u) => u.startsWith(`/v1/microstructure/${GAME_ID}`))).toBe(true);
  });

  it("renders the intensity timeline once board data resolves with fires", async () => {
    mockLiveAndBoard(
      fetchMock,
      liveResponse({ gameId: GAME_ID, tickCount: 0 }),
      boardResponse({ gameId: GAME_ID, firesCount: 2, nonFiresCount: 8 }),
    );
    render(<LivePage gameId={GAME_ID} />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.queryByTestId("live-timeline")).not.toBeNull();
    });
    expect(screen.getByTestId("live-fires-count").textContent).toBe("2");
  });

  it("renders the alert threshold line and off-price markers on the live chart", async () => {
    mockLiveAndBoard(
      fetchMock,
      liveResponse({ gameId: GAME_ID, tickCount: 0 }),
      boardResponse({ gameId: GAME_ID, firesCount: 1, nonFiresCount: 4 }),
      microstructureResponse({
        gameId: GAME_ID,
        eventTimestamps: ["2026-05-23T03:02:30Z"],
      }),
    );
    const { container } = render(<LivePage gameId={GAME_ID} />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.queryByTestId("live-timeline")).not.toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByTestId("live-offprice-count").textContent).toBe("1");
    });
    expect(screen.getByTestId("live-threshold-legend").textContent).toContain(
      "active alert threshold",
    );
    expect(container.querySelector("[data-testid='live-timeline']")).not.toBeNull();
  });

  it("shows the empty-state when board observations is empty", async () => {
    mockLiveAndBoard(
      fetchMock,
      liveResponse({ gameId: GAME_ID, tickCount: 0 }),
      boardResponse({ gameId: GAME_ID, firesCount: 0, nonFiresCount: 0 }),
    );
    render(<LivePage gameId={GAME_ID} />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.queryByTestId("live-timeline-empty")).not.toBeNull();
    });
    expect(screen.getByTestId("live-fires-count").textContent).toBe("0");
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

  it("renders the live sensitivity value", async () => {
    mockLiveAndBoard(
      fetchMock,
      liveResponse({ gameId: GAME_ID, tickCount: 0 }),
      boardResponse({ gameId: GAME_ID, firesCount: 1 }),
    );
    render(<LivePage gameId={GAME_ID} />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("live-k").textContent).toBe("3.0");
    });
  });

  it("renders the live meta line with tick count after live data resolves", async () => {
    mockLiveAndBoard(
      fetchMock,
      liveResponse({ gameId: GAME_ID, tickCount: 5 }),
      boardResponse({ gameId: GAME_ID, firesCount: 0, nonFiresCount: 2 }),
    );
    render(<LivePage gameId={GAME_ID} />, { wrapper: makeWrapper() });
    await waitFor(() => {
      const meta = String(screen.getByTestId("live-meta").textContent);
      expect(meta).toContain("5 ticks");
    });
  });
});
