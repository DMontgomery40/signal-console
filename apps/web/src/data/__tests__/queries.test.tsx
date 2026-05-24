import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { JSX } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useGames, useMicrostructure, type GamesList, type Microstructure } from "../queries";

function makeWrapper(): (props: { children: ReactNode }) => JSX.Element {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
    },
  });
  return function Wrapper({ children }: { children: ReactNode }): JSX.Element {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const VALID_GAMES_PAYLOAD = {
  games: [
    {
      id: "nba-0042500222",
      sport: "NBA",
      league: "NBA",
      scheduledStart: "2026-05-08T02:30:00Z",
      homeParticipantJson: '{"teamId":"IND"}',
      awayParticipantJson: '{"teamId":"NYK"}',
      status: "FINAL",
    },
  ],
} as const;

type FetchFn = typeof fetch;

function expectedSignalToken(): string {
  return typeof import.meta.env.VITE_SIGNAL_TOKEN === "string" &&
    import.meta.env.VITE_SIGNAL_TOKEN.length > 0
    ? import.meta.env.VITE_SIGNAL_TOKEN
    : "dev";
}

describe("useGames", () => {
  let fetchMock: ReturnType<typeof vi.fn<FetchFn>>;

  beforeEach(() => {
    fetchMock = vi.fn<FetchFn>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns the typed GamesList shape parsed from /v1/games", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(VALID_GAMES_PAYLOAD));

    const wrapper = makeWrapper();
    const { result } = renderHook(() => useGames(), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const data: GamesList | undefined = result.current.data;
    expect(data).toBeDefined();
    expect(Array.isArray(data?.games)).toBe(true);
    expect(data?.games).toHaveLength(1);
    const row = data?.games[0];
    expect(row?.id).toBe("nba-0042500222");
    expect(row?.sport).toBe("NBA");
    expect(row?.scheduledStart).toBe("2026-05-08T02:30:00Z");
    expect(row?.status).toBe("FINAL");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe("/v1/games");
    // X-Signal-Token header sourced from VITE_SIGNAL_TOKEN with 'dev' fallback.
    expect(call?.[1]).toMatchObject({
      headers: { "X-Signal-Token": expectedSignalToken() },
    });
  });

  it("appends the since query param when provided", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(VALID_GAMES_PAYLOAD));

    const wrapper = makeWrapper();
    const { result } = renderHook(() => useGames("P7D"), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe("/v1/games?since=P7D");
  });

  it("rejects malformed payloads via Zod (schema is load-bearing, not decorative)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ games: [{ id: 123, sport: "NBA" }] }),
    );

    const wrapper = makeWrapper();
    const { result } = renderHook(() => useGames(), { wrapper });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.data).toBeUndefined();
  });

  it("surfaces non-2xx HTTP responses as errors", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "boom" }), {
        status: 500,
        statusText: "Internal Server Error",
      }),
    );

    const wrapper = makeWrapper();
    const { result } = renderHook(() => useGames(), { wrapper });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toContain("HTTP 500");
  });
});

describe("useMicrostructure", () => {
  let fetchMock: ReturnType<typeof vi.fn<FetchFn>>;

  beforeEach(() => {
    fetchMock = vi.fn<FetchFn>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("parses the current API payload with numeric ids and nullable event fields", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        gameId: "nba-0042500222",
        theta: 0.1,
        events: [
          {
            id: 42,
            source: "polymarket",
            sourceMarketId: "pm-market-1",
            gameId: "nba-0042500222",
            instrumentId: null,
            eventType: "trade",
            apiSurface: "markets",
            eventTimestamp: "2026-05-08T03:12:30.000Z",
            capturedAt: "2026-05-08T03:12:31.000Z",
            price: null,
            previousPrice: null,
            tradePrice: 0.91,
            size: null,
            notional: null,
            volume: null,
            finalMarketVolume: null,
            volumeShare: 0.2,
            bestBid: null,
            bestAsk: null,
            spread: null,
            depthScore: null,
          },
        ],
      }),
    );

    const wrapper = makeWrapper();
    const { result } = renderHook(() => useMicrostructure("nba-0042500222"), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const data: Microstructure | undefined = result.current.data;
    expect(data?.events).toHaveLength(1);
    expect(data?.events[0]?.id).toBe(42);
    expect(data?.events[0]?.price).toBeNull();
    expect(data?.events[0]?.tradePrice).toBe(0.91);

    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe("/v1/microstructure/nba-0042500222");
    expect(call?.[1]).toMatchObject({
      headers: { "X-Signal-Token": expectedSignalToken() },
    });
  });
});
