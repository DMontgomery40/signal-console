import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { JSX } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useGames, type GamesList } from "../queries";

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
    expect(call?.[1]).toMatchObject({ headers: { "X-Signal-Token": "dev" } });
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
