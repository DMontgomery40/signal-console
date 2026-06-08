import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { JSX, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KnownCasesPage } from "../KnownCasesPage";

type FetchFn = typeof fetch;

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

function urlOf(input: Parameters<FetchFn>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function benchmarkIncident() {
  return {
    id: "wembanyama_team_rebound_foul_20260524",
    origin: "benchmark",
    incidentName: "V. Wembanyama rebound from TEAM defensive rebound",
    claim: "Public prop complaint asks whether a Spurs team rebound belonged to Wembanyama.",
    confidence: "medium",
    anchorType: "second",
    gameDate: "2026-05-24",
    teams: "Oklahoma City Thunder at San Antonio Spurs",
    gameId: "nba-0042500314",
    period: "Q1",
    clock: "09:08",
    utcTime: "2026-05-25T00:16:22.400Z",
    stat: "rebound",
    creditedPlayer: "TEAM defensive rebound",
    rightfulPlayer: "V. Wembanyama",
    sourceOrigin: "reddit_research_local_pbp",
    sourceReference: "fixture",
    sourceTextSummary: "Fixture summary",
    notes: "",
    officialCorrection: false,
    localBoardGameIds: ["nba-0042500314"],
    scoreable: true,
    liveControl: {
      algoId: "A01_legacy_60_vw_k3",
      scoreable: true,
      caught: true,
      leadSeconds: 83.2,
      fireIso: "2026-05-25T00:17:45.600Z",
      skipReason: null,
    },
    bestResult: {
      algoId: "A16_rv_bv_jump",
      scoreable: true,
      caught: true,
      leadSeconds: 247.6,
      fireIso: "2026-05-25T00:20:30.000Z",
      skipReason: null,
    },
    createdAt: null,
    createdBy: null,
  };
}

function gameBody() {
  return {
    id: "nba-0042500314",
    sport: "NBA",
    league: "national",
    scheduledStart: "2026-05-25T00:00:00.000Z",
    homeParticipantJson: '{"abbreviation":"SAS","name":"San Antonio Spurs"}',
    awayParticipantJson: '{"abbreviation":"OKC","name":"Oklahoma City Thunder"}',
    status: "final",
  };
}

function casesBody(incidents: readonly unknown[]) {
  return {
    generatedAt: "2026-05-25T09:26:41.228Z",
    coverage: {
      totalIncidents: 25,
      exactAnchorIncidents: 15,
      scoreableIncidents: 12,
      denominatorGames: 62,
    },
    incidents,
  };
}

function liveBody() {
  return {
    activity: {
      gameState: null,
      playByPlayActionCount: 0,
      recentPlayByPlay: [],
    },
    gameId: "nba-0042500314",
    windowStart: "2026-05-25T00:11:22.400Z",
    windowEnd: "2026-05-25T00:21:22.400Z",
    ticks: [
      {
        sourceMarketId: "sm-1",
        source: "polymarket",
        capturedAt: "2026-05-25T00:12:00.000Z",
        impliedProbability: 0.55,
        volume: 100,
        isHeartbeat: 0,
        instrumentId: "inst-1",
        rawFamily: "player_points",
        rawLabel: "SGA over",
      },
      {
        sourceMarketId: "ks-1",
        source: "kalshi",
        capturedAt: "2026-05-25T00:20:02.000Z",
        impliedProbability: 0.58,
        volume: 40,
        isHeartbeat: 0,
        instrumentId: "inst-2",
        rawFamily: "player_rebounds",
        rawLabel: "Wembanyama over",
      },
    ],
  };
}

function ensembleBody() {
  return {
    gameId: "nba-0042500314",
    runId: 7,
    k: 3,
    boardObservations: [
      {
        bucketStart: "2026-05-25T00:16:00.000Z",
        bucketEnd: "2026-05-25T00:17:00.000Z",
        fired: 0,
        intensity: 1.5,
        baselineMedian: 3.2,
        baselineMad: 0.9,
        warmedUp: true,
      },
    ],
    fires: [],
  };
}

function fanoutBody() {
  return {
    bucketStart: "2026-05-25T00:16:00.000Z",
    bucketEnd: "2026-05-25T00:17:00.000Z",
    narrative: "Alert window around V. Wembanyama rebound dispute; PBP and movers shown.",
    pbp: [
      {
        timeActual: "2026-05-25T00:16:22.400Z",
        actionType: "rebound",
        playerName: "V. Wembanyama",
        description: "V. Wembanyama REBOUND",
        deltaSecondsFromFire: 22.4,
        deltaSecondsFromAlert: -37.6,
        period: 1,
        clock: "PT09M08.00S",
      },
    ],
    movers: [
      {
        sourceMarketId: "kalshi-reb-over",
        instrument: "kalshi: rebounds · Wembanyama over",
        ipBefore: 0.44,
        ipAfter: 0.61,
        ipDelta: 0.17,
        contributionPct: 64.2,
        deltaSecondsFromFire: 23,
        bucketVolume: 6200,
      },
      {
        sourceMarketId: "poly-reb-over",
        instrument: "polymarket: rebounds · Wembanyama over",
        ipBefore: 0.45,
        ipAfter: 0.53,
        ipDelta: 0.08,
        contributionPct: 31.1,
        deltaSecondsFromFire: 28,
        bucketVolume: 1800,
      },
    ],
    microstructureEvents: [
      {
        eventTimestamp: "2026-05-25T00:16:25.000Z",
        sourceMarketId: "poly-reb-over",
        instrument: "polymarket: rebounds · Wembanyama over",
        tradePrice: 0.87,
        size: 100,
        notional: 87,
        volumeShare: 0.22,
        offPriceDistance: 0.42,
        deltaSecondsFromAlert: -35,
      },
    ],
  };
}

describe("KnownCasesPage", () => {
  let fetchMock: ReturnType<typeof vi.fn<FetchFn>>;
  let incidents: unknown[];
  let lastPost: unknown = null;

  beforeEach(() => {
    incidents = [benchmarkIncident()];
    lastPost = null;
    fetchMock = vi.fn<FetchFn>();
    fetchMock.mockImplementation(async (input, init) => {
      await Promise.resolve();
      const url = urlOf(input);
      if (url === "/v1/incidents" && init?.method === "POST") {
        lastPost = typeof init.body === "string" ? JSON.parse(init.body) : null;
        const created = {
          ...benchmarkIncident(),
          id: "desk_sga_317",
          origin: "desk-entered",
          incidentName: "SGA impossible points claim",
          claim: "SGA scored 317 points tonight",
          confidence: "desk",
          sourceOrigin: "desk_entered",
          sourceReference: "bet365 trading desk form",
          scoreable: false,
          liveControl: null,
          bestResult: null,
          createdAt: "2026-05-25T10:00:00.000Z",
          createdBy: "bet365 trading desk",
        };
        incidents = [...incidents, created];
        return jsonResponse(created, { status: 201 });
      }
      if (url === "/v1/incidents") return jsonResponse(casesBody(incidents));
      if (url === "/v1/games/nba-0042500314") return jsonResponse(gameBody());
      if (url.startsWith("/v1/live/nba-0042500314")) return jsonResponse(liveBody());
      if (url.startsWith("/v1/ensemble-or/nba-0042500314")) return jsonResponse(ensembleBody());
      if (url.startsWith("/v1/board/nba-0042500314/fanout")) return jsonResponse(fanoutBody());
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("lists every known case and replays the selected case through live-style endpoints", async () => {
    render(<KnownCasesPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getAllByTestId("known-case-row")).toHaveLength(1);
    });

    expect(screen.getByTestId("known-case-title").textContent).toContain("Wembanyama");

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((call) => urlOf(call[0]));
      expect(urls).toContain(
        "/v1/live/nba-0042500314?at=2026-05-25T00%3A21%3A22.400Z&window_ms=600000",
      );
      expect(urls).toContain("/v1/ensemble-or/nba-0042500314?at=2026-05-25T00%3A21%3A22.400Z");
      expect(
        urls.some((u) =>
          u.startsWith("/v1/board/nba-0042500314/fanout?bucket_start=2026-05-25T00%3A16%3A00.000Z"),
        ),
      ).toBe(true);
    });

    expect(screen.getByTestId("known-case-claim").textContent).toContain("Spurs team rebound");
    expect(screen.getByTestId("known-case-row").textContent).not.toContain("caught");
    expect(screen.getByTestId("known-case-current-status").textContent).toContain(
      "no board/off-price fire",
    );
    expect(screen.getByTestId("known-case-source-counts").textContent).toContain("kalshi 1");
    expect(screen.getByTestId("known-case-source-counts").textContent).toContain("polymarket 1");
    expect(screen.getByTestId("known-case-live-window").textContent).toContain("→");
    expect(screen.getByTestId("known-case-live-window").textContent).not.toContain(
      "incident ±5 min",
    );
    expect(screen.getByTestId("known-case-anchor-bucket").textContent).toContain(
      "2026-05-25T00:16:00.000Z",
    );
    await waitFor(() => {
      expect(screen.getByTestId("fanout-panel")).toBeDefined();
    });
    expect(screen.getByTestId("fanout-narrative").textContent).toContain("PBP and movers");
    expect(screen.getByTestId("fanout-movers-table").textContent).toContain("kalshi: rebounds");
    expect(screen.getByTestId("fanout-microstructure-table").textContent).toContain(
      "polymarket: rebounds",
    );
  });

  it("accepts an impossible trader assertion instead of validating it against official stats", async () => {
    render(<KnownCasesPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getAllByTestId("known-case-row")).toHaveLength(1);
    });

    fireEvent.change(screen.getByLabelText(/Incident name/), {
      target: { value: "SGA impossible points claim" },
    });
    fireEvent.change(screen.getByLabelText(/Desk claim/), {
      target: { value: "SGA scored 317 points tonight" },
    });
    fireEvent.change(screen.getByPlaceholderText("2026-05-25T00:16:22Z"), {
      target: { value: "2026-05-25T00:16:22Z" },
    });
    fireEvent.change(screen.getByPlaceholderText("OKC"), {
      target: { value: "OKC" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Add case" }));

    await waitFor(() => {
      expect(lastPost).toEqual(
        expect.objectContaining({
          incidentName: "SGA impossible points claim",
          claim: "SGA scored 317 points tonight",
          teamOne: "OKC",
        }),
      );
    });
    await waitFor(() => {
      expect(screen.getAllByTestId("known-case-row")).toHaveLength(2);
    });
    expect(screen.getByTestId("known-case-title").textContent).toContain(
      "SGA impossible points claim",
    );
    expect(screen.getByTestId("known-case-claim").textContent).toContain("317 points");
  });

  it("keeps the desk form field limits aligned with the API contract", async () => {
    render(<KnownCasesPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getAllByTestId("known-case-row")).toHaveLength(1);
    });

    const incidentName = screen.getByLabelText(/Incident name/);
    const claim = screen.getByLabelText(/Desk claim/);
    const teamOne = screen.getByPlaceholderText("OKC");
    if (!(incidentName instanceof HTMLInputElement)) throw new Error("incidentName input shape");
    if (!(claim instanceof HTMLTextAreaElement)) throw new Error("claim textarea shape");
    if (!(teamOne instanceof HTMLInputElement)) throw new Error("teamOne input shape");
    expect(incidentName.maxLength).toBe(240);
    expect(claim.maxLength).toBe(4000);
    expect(teamOne.maxLength).toBe(2000);
  });

  it("does not call live replay endpoints for a game-matched case without a UTC anchor", async () => {
    incidents = [
      {
        ...benchmarkIncident(),
        id: "desk_clock_only",
        origin: "desk-entered",
        incidentName: "Clock-only desk case",
        confidence: "desk",
        utcTime: "",
        gameId: "nba-0042500314",
        localBoardGameIds: ["nba-0042500314"],
        scoreable: false,
        liveControl: null,
        bestResult: null,
      },
    ];

    render(<KnownCasesPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("known-case-no-anchor").textContent).toContain("UTC anchor");
    });
    expect(screen.getByTestId("known-case-current-status").textContent).toContain("waiting");
    expect(screen.getByTestId("known-case-current-status").textContent).not.toContain(
      "no board/off-price fire",
    );
    expect(screen.getByTestId("known-case-fire-counts").textContent).toBe("—");
    const urls = fetchMock.mock.calls.map((call) => urlOf(call[0]));
    expect(urls).toContain("/v1/games/nba-0042500314");
    expect(urls.some((url) => url.startsWith("/v1/live/nba-0042500314"))).toBe(false);
    expect(urls.some((url) => url.startsWith("/v1/ensemble-or/nba-0042500314"))).toBe(false);
  });

  it("does not report no-fire when the replay endpoint fails", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      await Promise.resolve();
      const url = urlOf(input);
      if (url === "/v1/incidents") return jsonResponse(casesBody(incidents));
      if (url === "/v1/games/nba-0042500314") return jsonResponse(gameBody());
      if (url.startsWith("/v1/live/nba-0042500314")) {
        return jsonResponse({ error: "failed" }, { status: 500, statusText: "Server Error" });
      }
      if (url.startsWith("/v1/ensemble-or/nba-0042500314")) return jsonResponse(ensembleBody());
      if (url.startsWith("/v1/board/nba-0042500314/fanout")) return jsonResponse(fanoutBody());
      if (url === "/v1/incidents" && init?.method === "POST") {
        return jsonResponse(benchmarkIncident(), { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    render(<KnownCasesPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("known-case-current-status").textContent).toContain("unavailable");
    });
    expect(screen.getByTestId("known-case-current-status").textContent).not.toContain(
      "no board/off-price fire",
    );
    expect(screen.getByTestId("known-case-fire-counts").textContent).toBe("—");
  });
});
