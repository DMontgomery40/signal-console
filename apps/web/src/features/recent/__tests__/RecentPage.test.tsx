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

  it("renders one row per game with sport, league, team identifiers, status, and a 'fires: —' cell", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(TWO_GAMES));

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

    const fires = within(finalRow).getByTestId("fires-cell");
    expect(fires.textContent).toBe("—");
  });

  it("queries /v1/games?since=PT24H and does not poll on mount (single fetch)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(TWO_GAMES));

    render(<RecentPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getAllByTestId("recent-row")).toHaveLength(2);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0]?.[0];
    expect(url).toBe("/v1/games?since=PT24H");
  });

  it("re-runs the query when the Refresh button is clicked", async () => {
    fetchMock.mockResolvedValue(jsonResponse(TWO_GAMES));

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

    fireEvent.click(btn);

    await waitFor(
      () => {
        expect(fetchMock).toHaveBeenCalledTimes(2);
      },
      { timeout: 3000 },
    );
  });

  it("renders an empty-state message when /v1/games returns no rows", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ games: [] }));

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
