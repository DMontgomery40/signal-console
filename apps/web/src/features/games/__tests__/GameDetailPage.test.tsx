import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { ReactNode, JSX } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { GameDetailPage } from "../GameDetailPage";

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

const REAL_GAME = {
  id: "nba-0042500313",
  sport: "basketball",
  league: "NBA",
  scheduledStart: "2026-05-23T00:30:00Z",
  homeParticipantJson:
    '{"key":"sas","name":"San Antonio Spurs","shortName":"Spurs","abbreviation":"SAS","side":"home"}',
  awayParticipantJson:
    '{"key":"okc","name":"Oklahoma City Thunder","shortName":"Thunder","abbreviation":"OKC","side":"away"}',
  status: "final",
};

function boardResponse(opts: {
  gameId: string;
  firesCount: number;
  priorBucketsCount?: number;
}): Response {
  const firesCount = opts.firesCount;
  const priorBucketsCount = opts.priorBucketsCount ?? 0;
  // Prior non-fired buckets (oldest first), then fired buckets after.
  const observations: unknown[] = [];
  for (let i = 0; i < priorBucketsCount; i++) {
    observations.push({
      bucketStart: `2026-05-23T03:${String(i).padStart(2, "0")}:00Z`,
      bucketEnd: `2026-05-23T03:${String(i + 1).padStart(2, "0")}:00Z`,
      fired: 0,
      intensity: 0.1 + i * 0.01,
      baselineMedian: 0.1,
      baselineMad: 0.02,
    });
  }
  for (let i = 0; i < firesCount; i++) {
    const m = priorBucketsCount + i;
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

function mockGameAndBoard(
  fetchMock: ReturnType<typeof vi.fn<FetchFn>>,
  game: unknown,
  board: Response,
): void {
  fetchMock.mockImplementation(async (input) => {
    await Promise.resolve();
    const url = urlOf(input);
    if (url.startsWith("/v1/games/")) return jsonResponse(game);
    if (url.startsWith("/v1/board/")) return board.clone();
    return new Response("not found", { status: 404 });
  });
}

describe("GameDetailPage", () => {
  let fetchMock: ReturnType<typeof vi.fn<FetchFn>>;

  beforeEach(() => {
    fetchMock = vi.fn<FetchFn>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders one fired-bucket row per fired observation", async () => {
    mockGameAndBoard(fetchMock, REAL_GAME, boardResponse({ gameId: REAL_GAME.id, firesCount: 3 }));

    render(<GameDetailPage gameId={REAL_GAME.id} />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getAllByTestId("fired-bucket-row")).toHaveLength(3);
    });
  });

  it("does not render context panel by default; clicking a row expands its panel", async () => {
    mockGameAndBoard(
      fetchMock,
      REAL_GAME,
      boardResponse({ gameId: REAL_GAME.id, firesCount: 3, priorBucketsCount: 20 }),
    );

    render(<GameDetailPage gameId={REAL_GAME.id} />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getAllByTestId("fired-bucket-row")).toHaveLength(3);
    });
    expect(screen.queryAllByTestId("context-panel")).toHaveLength(0);

    const rows = screen.getAllByTestId("fired-bucket-row");
    const secondRow = rows[1];
    expect(secondRow).toBeDefined();
    if (secondRow === undefined) return;
    const toggle = within(secondRow).getByTestId("fired-bucket-toggle");
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(within(secondRow).getByTestId("context-panel")).toBeDefined();
    });
    // Only this row's panel is open; others remain closed.
    expect(screen.getAllByTestId("context-panel")).toHaveLength(1);
  });

  it("clicking the same row twice collapses the context panel (toggle semantics)", async () => {
    mockGameAndBoard(fetchMock, REAL_GAME, boardResponse({ gameId: REAL_GAME.id, firesCount: 2 }));

    render(<GameDetailPage gameId={REAL_GAME.id} />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getAllByTestId("fired-bucket-row")).toHaveLength(2);
    });

    const firstRow = screen.getAllByTestId("fired-bucket-row")[0];
    expect(firstRow).toBeDefined();
    if (firstRow === undefined) return;
    const toggle = within(firstRow).getByTestId("fired-bucket-toggle");
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(within(firstRow).queryByTestId("context-panel")).not.toBeNull();
    });
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(within(firstRow).queryByTestId("context-panel")).toBeNull();
    });
  });

  it("renders the empty-state message when /v1/board returns zero fires", async () => {
    mockGameAndBoard(
      fetchMock,
      REAL_GAME,
      boardResponse({ gameId: REAL_GAME.id, firesCount: 0, priorBucketsCount: 5 }),
    );

    render(<GameDetailPage gameId={REAL_GAME.id} />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("no-fires-empty-state")).toBeDefined();
    });
    const text = String(screen.getByTestId("no-fires-empty-state").textContent);
    expect(text).toContain("No fires recorded");
    expect(text).toContain("K=3.0");
    expect(text).toContain("live default");
  });

  it("each fired bucket row exposes bucket_start, intensity, baseline_median, baseline_mad, and the 'why this fired' explainer trigger", async () => {
    mockGameAndBoard(fetchMock, REAL_GAME, boardResponse({ gameId: REAL_GAME.id, firesCount: 1 }));

    render(<GameDetailPage gameId={REAL_GAME.id} />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getAllByTestId("fired-bucket-row")).toHaveLength(1);
    });

    const row = screen.getAllByTestId("fired-bucket-row")[0];
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(within(row).getByTestId("bucket-start").textContent).toBeTruthy();
    expect(within(row).getByTestId("bucket-intensity").textContent).toBeTruthy();
    expect(within(row).getByTestId("bucket-baseline-median").textContent).toBeTruthy();
    expect(within(row).getByTestId("bucket-baseline-mad").textContent).toBeTruthy();
    expect(within(row).getByTestId("bucket-explainer-trigger").textContent).toBe("why this fired");
  });

  it("renders the game metadata heading and team line", async () => {
    mockGameAndBoard(fetchMock, REAL_GAME, boardResponse({ gameId: REAL_GAME.id, firesCount: 1 }));

    render(<GameDetailPage gameId={REAL_GAME.id} />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("game-detail-title").textContent).toBe(REAL_GAME.id);
    });
    await waitFor(() => {
      const teams = String(screen.getByTestId("game-detail-teams").textContent);
      expect(teams).toContain("SAS");
      expect(teams).toContain("OKC");
    });
  });

  it("renders an invalid-id fallback when gameId is null", () => {
    render(<GameDetailPage gameId={null} />, { wrapper: makeWrapper() });
    expect(screen.getByTestId("invalid-game-id")).toBeDefined();
  });
});
