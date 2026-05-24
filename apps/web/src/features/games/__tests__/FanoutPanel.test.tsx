// FanoutPanel unit tests (US-051). Mocks /v1/board/:gameId/fanout via
// the same fetch-stub pattern the rest of the web tests use.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import type { JSX, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { FanoutPanel } from "../FanoutPanel";

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

const GAME_ID = "nba-fanout-1";
const BUCKET_START = "2026-05-08T03:12:00.000Z";

const REAL_FANOUT = {
  bucketStart: BUCKET_START,
  bucketEnd: "2026-05-08T03:13:00.000Z",
  pbp: [
    {
      timeActual: "2026-05-08T03:12:36.8Z",
      actionType: "rebound",
      playerName: "I. Hartenstein",
      description: "I. Hartenstein REBOUND (Off:4 Def:4)",
      deltaSecondsFromFire: 36.8,
    },
    {
      timeActual: "2026-05-08T03:09:53.5Z",
      actionType: "2pt",
      playerName: "L. James",
      description: "MISS L. James 10' turnaround fadeaway Shot",
      deltaSecondsFromFire: -126.5,
    },
  ],
  movers: [
    {
      sourceMarketId: "pm-2174662-under",
      instrument: "polymarket: rebounds · Marcus Smart: Rebounds O/U 0.5",
      ipBefore: 0.6,
      ipAfter: 0.38,
      ipDelta: -0.22,
      contributionPct: 31.2,
      deltaSecondsFromFire: 37.0,
    },
    {
      sourceMarketId: "pm-okc-ml",
      instrument: "polymarket: moneyline · Thunder",
      ipBefore: 0.62,
      ipAfter: 0.66,
      ipDelta: 0.04,
      contributionPct: 12.5,
      deltaSecondsFromFire: 55.0,
    },
  ],
  narrative:
    "Alert at 03:13:00 — I. Hartenstein REBOUND (Off:4 Def:4) 23s before alert — top mover polymarket: rebounds · Marcus Smart: Rebounds O/U 0.5 (ΔIP -0.220, 31.2%).",
};

describe("FanoutPanel (US-051)", () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders narrative, PBP timeline, and movers table when the API resolves", async () => {
    fetchMock.mockImplementation(async () => {
      await Promise.resolve();
      return jsonResponse(REAL_FANOUT);
    });

    render(<FanoutPanel gameId={GAME_ID} bucketStart={BUCKET_START} />, {
      wrapper: makeWrapper(),
    });

    await waitFor(() => {
      expect(screen.getByTestId("fanout-panel")).toBeDefined();
    });
    expect(screen.getByTestId("fanout-narrative").textContent).toContain("Alert at 03:13:00");
    expect(screen.getByTestId("fanout-narrative").textContent).toContain("I. Hartenstein REBOUND");
    expect(screen.getByTestId("fanout-narrative").textContent).toMatch(/before alert/);
    expect(screen.getByTestId("fanout-pbp-timeline")).toBeDefined();
    expect(screen.getByTestId("fanout-movers-table")).toBeDefined();
  });

  it("shows the gold-tier (accent-yellow) class on PBP events within 60s of the fire", async () => {
    fetchMock.mockImplementation(async () => {
      await Promise.resolve();
      return jsonResponse(REAL_FANOUT);
    });
    render(<FanoutPanel gameId={GAME_ID} bucketStart={BUCKET_START} />, {
      wrapper: makeWrapper(),
    });
    await waitFor(() => {
      expect(screen.getByTestId("fanout-panel")).toBeDefined();
    });
    // Movers table seconds-from-fire chip should carry the recency tier
    // class. The first mover is +37s → tier yellow; the second is +55s →
    // also tier yellow (<60s).
    const rows = screen.getAllByTestId("fanout-mover-row");
    expect(rows).toHaveLength(2);
    const firstDelta = within(rows[0]!).getByTestId("fanout-mover-delta");
    expect(firstDelta.className).toContain("text-accent-yellow");
  });

  it("shows the empty PBP message when the API returns an empty pbp[] array", async () => {
    fetchMock.mockImplementation(async () => {
      await Promise.resolve();
      return jsonResponse({
        ...REAL_FANOUT,
        pbp: [],
        narrative:
          "Alert at 03:13:00 — no PBP within ±5 min — no qualifying market movers in bucket.",
        movers: [],
      });
    });
    render(<FanoutPanel gameId={GAME_ID} bucketStart={BUCKET_START} />, {
      wrapper: makeWrapper(),
    });
    await waitFor(() => {
      expect(screen.getByTestId("fanout-pbp-empty")).toBeDefined();
    });
    expect(screen.getByTestId("fanout-pbp-empty").textContent).toContain(
      "No play-by-play within ±5 min of this fire",
    );
  });

  it("renders the error state when the API fails", async () => {
    fetchMock.mockImplementation(async () => {
      await Promise.resolve();
      return new Response("nope", { status: 500 });
    });
    render(<FanoutPanel gameId={GAME_ID} bucketStart={BUCKET_START} />, {
      wrapper: makeWrapper(),
    });
    await waitFor(() => {
      expect(screen.getByTestId("fanout-panel-error")).toBeDefined();
    });
  });
});
