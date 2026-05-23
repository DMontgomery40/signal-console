import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { ReactNode, JSX } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { RecentPage, participantLabel } from "../RecentPage";

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

function boardResponse(gameId: string, firedCount: number): Response {
  const observations = Array.from({ length: firedCount }, (_unused, i) => ({
    bucketStart: `2026-05-23T00:${String(i).padStart(2, "0")}:00Z`,
    bucketEnd: `2026-05-23T00:${String(i + 1).padStart(2, "0")}:00Z`,
    fired: 1,
    intensity: 1.5,
    baselineMedian: 0.1,
    baselineMad: 0.05,
  }));
  return jsonResponse({ gameId, runId: 1, k: 3.0, observations });
}

const TWO_GAMES = {
  games: [
    {
      id: "nba-0042500313",
      sport: "basketball",
      league: "NBA",
      scheduledStart: "2026-05-23T00:30:00Z",
      homeParticipantJson:
        '{"key":"sas","name":"San Antonio Spurs","shortName":"Spurs","abbreviation":"SAS","side":"home"}',
      awayParticipantJson:
        '{"key":"okc","name":"Oklahoma City Thunder","shortName":"Thunder","abbreviation":"OKC","side":"away"}',
      status: "final",
    },
    {
      id: "nba-0042500303",
      sport: "basketball",
      league: "NBA",
      scheduledStart: "2026-05-24T00:00:00Z",
      homeParticipantJson:
        '{"key":"cle","name":"Cleveland Cavaliers","shortName":"Cavaliers","abbreviation":"CLE","side":"home"}',
      awayParticipantJson:
        '{"key":"nyk","name":"New York Knicks","shortName":"Knicks","abbreviation":"NYK","side":"away"}',
      status: "scheduled",
    },
  ],
} as const;

type FetchFn = typeof fetch;

function urlOf(input: Parameters<FetchFn>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

// Per-game board fires keyed by game id. Routes that ask for a missing id get
// an empty observations array. Tests can override fires via `boardFiresByGameId`.
function mockGamesAndBoard(
  fetchMock: ReturnType<typeof vi.fn<FetchFn>>,
  games: unknown,
  boardFiresByGameId: Readonly<Record<string, number>> = {},
): void {
  fetchMock.mockImplementation(async (input) => {
    await Promise.resolve();
    const url = urlOf(input);
    if (url.startsWith("/v1/games")) return jsonResponse(games);
    const boardMatch = /^\/v1\/board\/([^?]+)/.exec(url);
    if (boardMatch !== null) {
      const gameId = decodeURIComponent(String(boardMatch[1]));
      return boardResponse(gameId, boardFiresByGameId[gameId] ?? 0);
    }
    return new Response("not found", { status: 404 });
  });
}

describe("RecentPage", () => {
  let fetchMock: ReturnType<typeof vi.fn<FetchFn>>;

  beforeEach(() => {
    fetchMock = vi.fn<FetchFn>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders one row per game with sport, league, team identifiers, status, and a fires count", async () => {
    mockGamesAndBoard(fetchMock, TWO_GAMES, { "nba-0042500313": 3 });

    render(<RecentPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getAllByTestId("recent-row")).toHaveLength(2);
    });

    const rows = screen.getAllByTestId("recent-row");
    const finalRow = rows.find((r) => r.getAttribute("data-game-id") === "nba-0042500313");
    expect(finalRow).toBeDefined();
    if (finalRow === undefined) return;
    const text = String(finalRow.textContent);
    expect(text).toContain("basketball");
    expect(text).toContain("NBA");
    expect(text).toContain("SAS");
    expect(text).toContain("OKC");
    expect(text).toContain("final");

    await waitFor(() => {
      expect(within(finalRow).getByTestId("fires-count").textContent).toBe("3");
    });
  });

  it("queries /v1/games?since=PT24H and fires one /v1/board call per visible row", async () => {
    mockGamesAndBoard(fetchMock, TWO_GAMES);

    render(<RecentPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getAllByTestId("recent-row")).toHaveLength(2);
    });
    await waitFor(() => {
      expect(screen.getAllByTestId("fires-count")).toHaveLength(2);
    });

    const urls = fetchMock.mock.calls.map((c) => urlOf(c[0]));
    expect(urls).toContain("/v1/games?since=PT24H");
    expect(urls).toContain("/v1/board/nba-0042500313");
    expect(urls).toContain("/v1/board/nba-0042500303");
  });

  it("re-runs the games query when the Refresh button is clicked", async () => {
    mockGamesAndBoard(fetchMock, TWO_GAMES);

    render(<RecentPage />, { wrapper: makeWrapper() });

    // Wait for rows AND for isFetching to settle so the Refresh button is
    // enabled (it's disabled while a fetch is in flight).
    await waitFor(() => {
      expect(screen.getAllByTestId("recent-row")).toHaveLength(2);
    });
    const btn = screen.getByTestId("refresh-button");
    await waitFor(() => {
      expect(btn.hasAttribute("disabled")).toBe(false);
    });

    const gamesCallsBefore = fetchMock.mock.calls.filter((c) =>
      urlOf(c[0]).startsWith("/v1/games"),
    ).length;
    fireEvent.click(btn);

    await waitFor(
      () => {
        const gamesCallsAfter = fetchMock.mock.calls.filter((c) =>
          urlOf(c[0]).startsWith("/v1/games"),
        ).length;
        expect(gamesCallsAfter).toBe(gamesCallsBefore + 1);
      },
      { timeout: 3000 },
    );
  });

  it("renders an empty-state message when /v1/games returns no rows", async () => {
    mockGamesAndBoard(fetchMock, { games: [] });

    render(<RecentPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("recent-empty")).toBeDefined();
    });

    expect(screen.queryAllByTestId("recent-row")).toHaveLength(0);
  });

  it("renders ApiUnreachableBanner on network failure; the page below remains usable", async () => {
    // TypeError === network failure (e.g. browser ERR_CONNECTION_REFUSED).
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    render(<RecentPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("api-unreachable-banner")).toBeDefined();
    });

    // Heading still renders; Refresh button still usable.
    expect(screen.getByText("Recent")).toBeDefined();
    expect(screen.getByTestId("refresh-button")).toBeDefined();
  });

  it("does not claim '0 games' or render the empty-state when the query has errored (honesty)", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    render(<RecentPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("api-unreachable-banner")).toBeDefined();
    });

    // The banner is the source of truth in error state. Meta becomes "—"
    // (not "0 games") and the empty-state message is suppressed.
    const meta = screen.getByTestId("recent-meta");
    expect(meta.textContent).toBe("—");
    expect(screen.queryByTestId("recent-empty")).toBeNull();
  });

  it("renders QueryErrorBanner on non-network errors (e.g. HTTP 500); the page below remains usable", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "boom" }), {
        status: 500,
        statusText: "Internal Server Error",
      }),
    );

    render(<RecentPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("query-error-banner")).toBeDefined();
    });

    expect(screen.getByText("Recent")).toBeDefined();
    expect(screen.getByTestId("refresh-button")).toBeDefined();
  });

  it("shows a spinner in the fires cell while /v1/board is pending, then the count", async () => {
    // Resolve /v1/games immediately, leave /v1/board pending until we release it.
    // Promise constructor runs its executor synchronously, so releaseBoard is
    // populated before any awaiter runs.
    const deferred = (() => {
      const out = { release: (): void => undefined };
      const promise = new Promise<void>((r) => {
        out.release = r;
      });
      return { promise, release: out.release };
    })();

    fetchMock.mockImplementation(async (input) => {
      const url = urlOf(input);
      if (url.startsWith("/v1/games")) {
        await Promise.resolve();
        return jsonResponse(TWO_GAMES);
      }
      await deferred.promise;
      return boardResponse("nba-0042500313", 2);
    });

    render(<RecentPage />, { wrapper: makeWrapper() });

    // Rows render with pending fire cells.
    await waitFor(() => {
      expect(screen.getAllByTestId("recent-row")).toHaveLength(2);
    });
    await waitFor(() => {
      expect(screen.getAllByTestId("fires-pending").length).toBeGreaterThan(0);
    });

    // Release the board fetches; counts replace the spinners.
    deferred.release();
    await waitFor(() => {
      expect(screen.queryAllByTestId("fires-pending")).toHaveLength(0);
    });
    expect(screen.getAllByTestId("fires-count").length).toBe(2);
  });

  it("renders an 'error' chip when /v1/board fails for a row; the tooltip carries the error message", async () => {
    fetchMock.mockImplementation(async (input) => {
      await Promise.resolve();
      const url = urlOf(input);
      if (url.startsWith("/v1/games")) return jsonResponse(TWO_GAMES);
      return new Response(JSON.stringify({ error: "boom" }), {
        status: 500,
        statusText: "Internal Server Error",
      });
    });

    render(<RecentPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getAllByTestId("fires-error")).toHaveLength(2);
    });

    const chip = screen.getAllByTestId("fires-error")[0];
    expect(chip).toBeDefined();
    if (chip === undefined) return;
    expect(chip.textContent).toBe("error");
    const title = chip.getAttribute("title") ?? "";
    expect(title).toContain("500");
    // /v1/games rendered cleanly; the heading + refresh button stay usable.
    expect(screen.getByText("Recent")).toBeDefined();
    expect(screen.getByTestId("refresh-button")).toBeDefined();
  });

  it("caps in-flight /v1/board calls at 20 even when the games list has 30 rows", async () => {
    const many = {
      games: Array.from({ length: 30 }, (_unused, i) => ({
        id: `nba-${String(i).padStart(10, "0")}`,
        sport: "basketball",
        league: "NBA",
        scheduledStart: `2026-05-23T00:${String(i % 60).padStart(2, "0")}:00Z`,
        homeParticipantJson: '{"abbreviation":"AAA"}',
        awayParticipantJson: '{"abbreviation":"BBB"}',
        status: "scheduled",
      })),
    };
    mockGamesAndBoard(fetchMock, many);

    render(<RecentPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getAllByTestId("recent-row")).toHaveLength(30);
    });
    // Wait until the board fetches have all settled.
    await waitFor(() => {
      expect(screen.getAllByTestId("fires-count").length).toBe(20);
    });

    const boardUrls = fetchMock.mock.calls
      .map((c) => urlOf(c[0]))
      .filter((u) => u.startsWith("/v1/board/"));
    expect(boardUrls.length).toBeLessThanOrEqual(20);
    // Rows past the cap render the plain "—" placeholder.
    const lastRow = screen.getAllByTestId("recent-row")[29];
    expect(lastRow).toBeDefined();
    if (lastRow === undefined) return;
    expect(within(lastRow).queryByTestId("fires-count")).toBeNull();
    expect(within(lastRow).queryByTestId("fires-pending")).toBeNull();
    expect(within(lastRow).queryByTestId("fires-error")).toBeNull();
    expect(within(lastRow).getByTestId("fires-cell").textContent).toBe("—");
  });
});

describe("participantLabel", () => {
  it("prefers abbreviation when present (real gold-DB shape)", () => {
    expect(participantLabel('{"key":"sas","name":"Spurs","abbreviation":"SAS"}')).toBe("SAS");
  });

  it("falls back to teamId for the fixture shape used in unit tests", () => {
    expect(participantLabel('{"teamId":"IND"}')).toBe("IND");
  });

  it("returns '?' for malformed JSON without throwing", () => {
    expect(participantLabel("not json")).toBe("?");
  });

  it("returns '?' when no recognised key is present", () => {
    expect(participantLabel('{"foo":"bar"}')).toBe("?");
  });
});
