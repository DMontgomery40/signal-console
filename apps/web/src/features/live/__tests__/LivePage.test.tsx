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

// AMENDED 2026-05-25 (Codex review P1): some tests need the response body
// synchronously inside the fetch mock handler (the legacy `boardResponse`
// + `microstructureResponse` fixtures get adapted into the new ensemble-or
// shape on the fly). Response.json() is async; the adapter looks up the
// pre-computed body via a WeakMap keyed on the Response itself.
const responseBodyText = new WeakMap<Response, string>();

// Per-mock K override. mockLiveAndBoard sets this when the test wants the
// ensemble adapter to echo a specific K back (e.g. to prove the chart K
// comes from the ensemble response, not from any fallback). Default 3.0.
const adapterEnsembleKByGame = new Map<string, number>();

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  const text = JSON.stringify(body);
  const res = new Response(text, {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  responseBodyText.set(res, text);
  return res;
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
  // AMENDED 2026-05-25 (Codex review P1, then B-followup #2 P1): LivePage
  // consumes /v1/ensemble-or instead of /v1/board + /v1/microstructure, and
  // reads K from the ensemble response itself (NOT from /v1/settings).
  // We still accept the legacy `board` + `micro` params so existing call
  // sites (e.g., the offPriceTimestamps in `renders the alert threshold
  // line...` test) continue to seed the chart by adapting both into an
  // ensemble-or response shape on the fly. /v1/settings is no longer
  // fetched at all by LivePage.
  fetchMock.mockImplementation(async (input) => {
    await Promise.resolve();
    const url = urlOf(input);
    if (url.startsWith("/v1/live/")) return live.clone();
    if (url.startsWith("/v1/ensemble-or/")) {
      return adaptBoardAndMicroToEnsemble(board, micro).clone();
    }
    // Defensive: legacy paths still get served so any test that explicitly
    // mocks /v1/board or /v1/microstructure doesn't break (none should
    // remain post-P1, but no need to delete the safety net).
    if (url.startsWith("/v1/board/")) return board.clone();
    if (url.startsWith("/v1/microstructure/")) return micro.clone();
    return new Response("not found", { status: 404 });
  });
}

// Adapt the legacy board + micro test fixtures into the ensemble-or shape.
// Reads board observations from `board.json()`, micro events from
// `micro.json()`, and re-emits as { gameId, runId, boardObservations, fires }.
interface BoardJsonShape {
  readonly gameId: string;
  readonly observations: readonly {
    readonly fired: number;
    readonly bucketStart: string;
    readonly bucketEnd: string;
    readonly intensity: number;
    readonly baselineMedian: number;
    readonly baselineMad: number;
    readonly warmedUp: boolean;
  }[];
}
interface MicroJsonShape {
  readonly events: readonly { readonly eventTimestamp: string; readonly sourceMarketId: string }[];
}

function parseBoardJson(text: string): BoardJsonShape {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) throw new Error("board json shape");
  return parsed as BoardJsonShape; // eslint-disable-line @typescript-eslint/consistent-type-assertions
}
function parseMicroJson(text: string): MicroJsonShape {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) throw new Error("micro json shape");
  return parsed as MicroJsonShape; // eslint-disable-line @typescript-eslint/consistent-type-assertions
}

function adaptBoardAndMicroToEnsemble(board: Response, micro: Response): Response {
  const boardJson = parseBoardJson(readSyncBody(board));
  const microJson = parseMicroJson(readSyncBody(micro));
  const boardFires = boardJson.observations
    .filter((o) => o.fired === 1)
    .map((o) => ({
      bucketStart: o.bucketStart,
      bucketEnd: o.bucketEnd,
      intensity: o.intensity,
      baselineMedian: o.baselineMedian,
      baselineMad: o.baselineMad,
      lane: "board",
    }));
  const offpriceFires = microJson.events.map((e) => ({
    bucketStart: e.eventTimestamp,
    bucketEnd: e.eventTimestamp,
    intensity: 0.5,
    lane: "offprice",
    sourceMarketId: e.sourceMarketId,
  }));
  return jsonResponse({
    gameId: boardJson.gameId,
    runId: 1,
    // Echo back the per-game K override set via mockLiveAndBoard so tests
    // can prove the Live chart reads K from the ensemble response. Default
    // 3.0 mirrors the production fallback in LivePage; legacy tests that
    // don't set an override still see "3.0".
    k: adapterEnsembleKByGame.get(boardJson.gameId) ?? 3.0,
    boardObservations: boardJson.observations,
    fires: [...boardFires, ...offpriceFires],
  });
}

// Synchronously read a cloneable Response body that was built via jsonResponse.
// Pulls from the WeakMap-side-channel because Response.json() is async and
// the adapter runs inside the synchronous fetch mock handler.
function readSyncBody(res: Response): string {
  const text = responseBodyText.get(res);
  if (text === undefined) {
    throw new Error("response was not built via jsonResponse — no body in WeakMap");
  }
  return text;
}

const GAME_ID = "nba-0042500313";

describe("offPriceMarkersForDomain", () => {
  it("keeps off-price events inside the visible chart time range even when they are between sparse board buckets", () => {
    // OffPriceMarkerSource shape (post-B-followup) is minimal: just id +
    // eventTimestamp. Numeric ids from the legacy /v1/microstructure route
    // get stringified at the call site; ensemble-or fires use
    // `${bucketStart}|${sourceMarketId}` composite keys.
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
    // AMENDED 2026-05-25 (Codex B-followup review P1): K now comes from the
    // ensemble route, not from /v1/settings, so LivePage makes NO requests
    // at all when gameId is null. All game-scoped queries gate on
    // non-empty id.
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

  it("fires GET /v1/live/:gameId and GET /v1/ensemble-or/:gameId on mount", async () => {
    // AMENDED 2026-05-25 (Codex review P1): LivePage now consumes the
    // ensemble-or live route as the unified board + offprice surface.
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
    expect(calledUrls.some((u) => u.startsWith(`/v1/ensemble-or/${GAME_ID}`))).toBe(true);
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

  it("renders the state-space threshold line and off-price markers on the live chart", async () => {
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
      "active state-space threshold",
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

  it("renders the live trigger value from the ensemble response (not from any fallback)", async () => {
    // Codex B-followup review P1 (2026-05-25): the rendered K must come
    // from /v1/ensemble-or's `k` field, NOT from a separate /v1/settings
    // round-trip or any fallback. Set a NON-default K (4.5) via the
    // adapter override so passing the assertion requires the chart to
    // have actually read ensemble.data.k — the production fallback
    // (3.0) would fail this assertion.
    adapterEnsembleKByGame.set(GAME_ID, 4.5);
    mockLiveAndBoard(
      fetchMock,
      liveResponse({ gameId: GAME_ID, tickCount: 0 }),
      boardResponse({ gameId: GAME_ID, firesCount: 1 }),
    );
    render(<LivePage gameId={GAME_ID} />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("live-k").textContent).toBe("4.5");
    });
    adapterEnsembleKByGame.delete(GAME_ID);
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
