import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode, JSX } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { LivePage } from "../LivePage";

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
    });
  }
  return jsonResponse({ gameId: opts.gameId, runId: 1, k: 3.0, observations });
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
): void {
  fetchMock.mockImplementation(async (input) => {
    await Promise.resolve();
    const url = urlOf(input);
    if (url.startsWith("/v1/live/")) return live.clone();
    if (url.startsWith("/v1/board/")) return board.clone();
    return new Response("not found", { status: 404 });
  });
}

const GAME_ID = "nba-0042500313";

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

  it("renders the K=3.0 label (live default)", async () => {
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
