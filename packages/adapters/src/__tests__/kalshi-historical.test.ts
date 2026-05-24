import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ResearchGameCard } from "@signal-console/domain";
import {
  getDatabase,
  listAdapterRuns,
  recordGameStateObservation,
  resetDatabase,
  upsertGame,
  upsertMarketInstrument,
  upsertSourceMarket,
} from "@signal-console/shared";

import { syncKalshiNbaHistorical } from "../kalshi-historical";

let tempDir = "";

function seedPastGame() {
  upsertGame({
    awayParticipant: {
      abbreviation: "PHX",
      key: "phx",
      name: "Phoenix Suns",
      shortName: "Suns",
      side: "away",
    },
    homeParticipant: {
      abbreviation: "OKC",
      key: "okc",
      name: "Oklahoma City Thunder",
      shortName: "Thunder",
      side: "home",
    },
    id: "nba-0042500200",
    league: "NBA",
    scheduledStart: "2026-04-22T23:30:00.000Z",
    sourceGameKeyNba: "0042500200",
    sport: "basketball",
  });

  recordGameStateObservation({
    awayScore: 98,
    capturedAt: "2026-04-23T02:30:00.000Z",
    clock: null,
    finalAt: "2026-04-23T02:30:00.000Z",
    gameId: "nba-0042500200",
    homeScore: 115,
    isFinal: true,
    period: 4,
    startedAt: "2026-04-22T23:30:00.000Z",
    status: "final",
  });
}

const kalshiEventsPayload = {
  cursor: "",
  events: [
    {
      event_ticker: "KXNBAGAME-26APR22PHXOKC",
      title: "Game 2: Phoenix at Oklahoma City",
      sub_title: "PHX at OKC (Apr 22)",
      series_ticker: "KXNBAGAME",
      markets: [
        {
          ticker: "KXNBAGAME-26APR22PHXOKC-OKC",
          status: "finalized",
          open_time: "2026-04-18T20:57:00Z",
          close_time: "2026-04-23T04:23:18Z",
          yes_sub_title: "Oklahoma City",
          no_sub_title: "No",
          result: "yes",
        },
        {
          ticker: "KXNBAGAME-26APR22PHXOKC-PHX",
          status: "finalized",
          open_time: "2026-04-18T20:57:00Z",
          close_time: "2026-04-23T04:23:18Z",
          yes_sub_title: "Phoenix",
          no_sub_title: "No",
          result: "no",
        },
      ],
    },
  ],
};

const kalshiCandlesticksByMarket: Record<string, unknown> = {
  "KXNBAGAME-26APR22PHXOKC-OKC": {
    ticker: "KXNBAGAME-26APR22PHXOKC-OKC",
    candlesticks: [
      {
        end_period_ts: 1776556800,
        open_interest_fp: "42.00",
        volume_fp: "10.00",
        price: {
          close_dollars: "0.8200",
          high_dollars: "0.8500",
          low_dollars: "0.8100",
          mean_dollars: "0.8300",
          open_dollars: "0.8100",
        },
        yes_bid: { close_dollars: "0.8100" },
        yes_ask: { close_dollars: "0.8300" },
      },
      {
        end_period_ts: 1776560400,
        open_interest_fp: "48.00",
        volume_fp: "3.00",
        price: {
          close_dollars: "0.9100",
          high_dollars: "0.9200",
          low_dollars: "0.8200",
          mean_dollars: "0.8750",
          open_dollars: "0.8200",
        },
        yes_bid: { close_dollars: "0.9000" },
        yes_ask: { close_dollars: "0.9100" },
      },
    ],
  },
  "KXNBAGAME-26APR22PHXOKC-PHX": {
    ticker: "KXNBAGAME-26APR22PHXOKC-PHX",
    candlesticks: [
      {
        end_period_ts: 1776556800,
        open_interest_fp: "42.00",
        volume_fp: "10.00",
        price: {
          close_dollars: "0.1800",
          high_dollars: "0.1900",
          low_dollars: "0.1500",
          mean_dollars: "0.1700",
          open_dollars: "0.1900",
        },
        yes_bid: { close_dollars: "0.1700" },
        yes_ask: { close_dollars: "0.1900" },
      },
    ],
  },
};

function buildFetchImpl() {
  return (async (input: string | URL) => {
    const url = typeof input === "string" ? new URL(input) : input;
    if (url.pathname.endsWith("/events")) {
      return {
        json: async () => kalshiEventsPayload,
        ok: true,
        status: 200,
      } as unknown as Response;
    }

    const match = url.pathname.match(/\/markets\/([^/]+)\/candlesticks$/);
    if (match) {
      const payload = kalshiCandlesticksByMarket[match[1]] ?? {
        candlesticks: [],
        ticker: match[1],
      };
      return {
        json: async () => payload,
        ok: true,
        status: 200,
      } as unknown as Response;
    }

    return {
      json: async () => ({}),
      ok: false,
      status: 404,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("kalshi historical adapter", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "signal-console-kalshi-hist-"));
    process.env.SIGNAL_CONSOLE_DB_PATH = join(tempDir, "signal-console.sqlite");
    resetDatabase();
  });

  afterEach(() => {
    resetDatabase();
    delete process.env.SIGNAL_CONSOLE_DB_PATH;
    if (tempDir) {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("writes historical ticks for a settled Kalshi NBA event and dedupes on re-run", async () => {
    seedPastGame();

    const run1 = await syncKalshiNbaHistorical({
      fetchImpl: buildFetchImpl(),
      now: () => new Date("2026-04-23T12:00:00.000Z"),
      periodIntervalMinutes: 60,
    });

    expect(run1.ok).toBe(true);
    expect(run1.gamesMatched).toBe(1);
    expect(run1.marketsConsidered).toBe(2);
    expect(run1.candlesFetched).toBe(3);
    expect(run1.ticksWritten).toBe(3);

    const run2 = await syncKalshiNbaHistorical({
      fetchImpl: buildFetchImpl(),
      now: () => new Date("2026-04-24T12:00:00.000Z"),
      periodIntervalMinutes: 60,
    });

    expect(run2.ticksWritten).toBe(0);
    expect(run2.candlesFetched).toBe(3);

    const db = getDatabase();
    const tickRows = db
      .prepare(
        `
          SELECT source_market_id AS sourceMarketId,
                 captured_at AS capturedAt,
                 implied_probability AS impliedProbability,
                 best_bid AS bestBid,
                 best_ask AS bestAsk
          FROM quote_ticks
          ORDER BY captured_at ASC, source_market_id ASC
        `
      )
      .all() as Array<{
      bestAsk: number | null;
      bestBid: number | null;
      capturedAt: string;
      impliedProbability: number | null;
      sourceMarketId: string;
    }>;

    expect(tickRows).toHaveLength(3);
    expect(
      tickRows.every((row) => row.sourceMarketId.startsWith("kalshi-"))
    ).toBe(true);
    const okc = tickRows.find(
      (row) => row.sourceMarketId === "kalshi-kxnbagame-26apr22phxokc-okc"
    );
    expect(okc?.impliedProbability).toBeCloseTo(0.82);

    const runs = listAdapterRuns(10) as Array<{
      captureMode: string;
      source: string;
      status: string;
    }>;
    const historicalRuns = runs.filter(
      (run) => run.source === "kalshi" && run.captureMode === "historical"
    );
    expect(historicalRuns).toHaveLength(2);
    expect(historicalRuns.every((run) => run.status === "ok")).toBe(true);
  });

  it("ignores Kalshi events that cannot be matched to a canonical game", async () => {
    const result = await syncKalshiNbaHistorical({
      fetchImpl: buildFetchImpl(),
      now: () => new Date("2026-04-23T12:00:00.000Z"),
      periodIntervalMinutes: 60,
    });

    expect(result.gamesMatched).toBe(0);
    expect(result.ticksWritten).toBe(0);
  });

  it("backfills persisted Kalshi player-prop series, not only KXNBAGAME moneyline markets", async () => {
    seedPastGame();

    upsertMarketInstrument({
      displayLabel: "Devin Booker over 24.5 points",
      family: "player-prop",
      gameId: "nba-0042500200",
      id: "booker-points-over",
      inPlay: false,
      line: 24.5,
      participantKey: "devin-booker",
      selection: "over",
    });
    upsertSourceMarket({
      gameId: "nba-0042500200",
      id: "kalshi-kxnbapts-26apr22phxokc-phxbooker245-25",
      instrumentId: "booker-points-over",
      mappingStatus: "auto",
      rawFamily: "points",
      rawLabel: "Devin Booker over 24.5 points",
      rawMetadata: {
        eventTicker: "KXNBAPTS-26APR22PHXOKC",
        seriesTicker: "KXNBAPTS",
      },
      source: "kalshi",
      sourceMarketKey: "KXNBAPTS-26APR22PHXOKC-PHXBOOKER245-25",
      sourceSelectionKey: "over",
    });

    const fetchImpl = (async (input: string | URL) => {
      const url = typeof input === "string" ? new URL(input) : input;
      if (url.pathname.endsWith("/events")) {
        return {
          json: async () => kalshiEventsPayload,
          ok: true,
          status: 200,
        } as unknown as Response;
      }

      const match = url.pathname.match(
        /\/series\/([^/]+)\/markets\/([^/]+)\/candlesticks$/
      );
      if (
        match?.[1] === "KXNBAPTS" &&
        match[2] === "KXNBAPTS-26APR22PHXOKC-PHXBOOKER245-25"
      ) {
        return {
          json: async () => ({
            candlesticks: [
              {
                end_period_ts: 1776556800,
                open_interest_fp: "10.00",
                volume_fp: "4.00",
                price: { close_dollars: "0.6600" },
                yes_bid: { close_dollars: "0.6500" },
                yes_ask: { close_dollars: "0.6700" },
              },
              {
                end_period_ts: 1776560400,
                open_interest_fp: "12.00",
                volume_fp: "2.00",
                price: { close_dollars: "0.8200" },
                yes_bid: { close_dollars: "0.8100" },
                yes_ask: { close_dollars: "0.8300" },
              },
            ],
          }),
          ok: true,
          status: 200,
        } as unknown as Response;
      }

      const marketMatch = url.pathname.match(
        /\/markets\/([^/]+)\/candlesticks$/
      );
      if (marketMatch) {
        const payload = kalshiCandlesticksByMarket[marketMatch[1]] ?? {
          candlesticks: [],
          ticker: marketMatch[1],
        };
        return {
          json: async () => payload,
          ok: true,
          status: 200,
        } as unknown as Response;
      }

      return {
        json: async () => ({}),
        ok: false,
        status: 404,
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const run = await syncKalshiNbaHistorical({
      fetchImpl,
      now: () => new Date("2026-04-23T12:00:00.000Z"),
      periodIntervalMinutes: 60,
    });

    expect(run.gamesMatched).toBe(1);

    const propRows = getDatabase()
      .prepare(
        `
          SELECT q.captured_at AS capturedAt, q.implied_probability AS impliedProbability
          FROM quote_ticks q
          WHERE q.source_market_id = 'kalshi-kxnbapts-26apr22phxokc-phxbooker245-25'
          ORDER BY q.captured_at ASC
        `
      )
      .all() as Array<{ capturedAt: string; impliedProbability: number }>;

    expect(propRows).toHaveLength(2);
    expect(
      propRows.map((row) => Number(row.impliedProbability.toFixed(2)))
    ).toEqual([0.66, 0.82]);
  });

  it("backfills persisted Kalshi source markets for an explicitly requested game even before settlement", async () => {
    seedPastGame();

    upsertMarketInstrument({
      displayLabel: "Devin Booker over 24.5 points",
      family: "player-prop",
      gameId: "nba-0042500200",
      id: "booker-points-over-explicit",
      inPlay: false,
      line: 24.5,
      participantKey: "devin-booker",
      selection: "over",
    });
    upsertSourceMarket({
      gameId: "nba-0042500200",
      id: "kalshi-kxnbapts-explicit",
      instrumentId: "booker-points-over-explicit",
      mappingStatus: "auto",
      rawFamily: "points",
      rawLabel: "Devin Booker over 24.5 points",
      rawMetadata: {
        eventTicker: "KXNBAPTS-26APR22PHXOKC",
        seriesTicker: "KXNBAPTS",
      },
      source: "kalshi",
      sourceMarketKey: "KXNBAPTS-26APR22PHXOKC-PHXBOOKER245-25",
      sourceSelectionKey: "over",
    });

    const fetchImpl = (async (input: string | URL) => {
      const url = typeof input === "string" ? new URL(input) : input;
      if (url.pathname.endsWith("/events")) {
        return {
          json: async () => ({ cursor: "", events: [] }),
          ok: true,
          status: 200,
        } as unknown as Response;
      }

      const match = url.pathname.match(
        /\/series\/([^/]+)\/markets\/([^/]+)\/candlesticks$/
      );
      if (
        match?.[1] === "KXNBAPTS" &&
        match[2] === "KXNBAPTS-26APR22PHXOKC-PHXBOOKER245-25"
      ) {
        return {
          json: async () => ({
            candlesticks: [
              {
                end_period_ts: 1776556800,
                open_interest_fp: "10.00",
                volume_fp: "4.00",
                price: { close_dollars: "0.6600" },
                yes_bid: { close_dollars: "0.6500" },
                yes_ask: { close_dollars: "0.6700" },
              },
            ],
          }),
          ok: true,
          status: 200,
        } as unknown as Response;
      }

      return {
        json: async () => ({}),
        ok: false,
        status: 404,
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const games = [
      {
        game: {
          awayParticipant: {
            abbreviation: "PHX",
            key: "phx",
            name: "Phoenix Suns",
            shortName: "Suns",
            side: "away",
          },
          homeParticipant: {
            abbreviation: "OKC",
            key: "okc",
            name: "Oklahoma City Thunder",
            shortName: "Thunder",
            side: "home",
          },
          id: "nba-0042500200",
          league: "NBA",
          scheduledStart: "2026-04-22T23:30:00.000Z",
          sourceGameKeyNba: "0042500200",
          sport: "basketball",
        },
      },
    ] as unknown as ResearchGameCard[];

    const run = await syncKalshiNbaHistorical({
      fetchImpl,
      games,
      now: () => new Date("2026-04-23T12:00:00.000Z"),
      periodIntervalMinutes: 60,
    });

    expect(run.gamesMatched).toBe(0);
    expect(run.ticksWritten).toBe(1);
  });
});
