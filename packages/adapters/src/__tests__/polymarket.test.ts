import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getInstrumentComparison,
  listAdapterRuns,
  listGameMarkets,
  listResearchGames,
  recordGameStateObservation,
  resetDatabase,
  upsertGame,
} from "@signal-console/shared";

import {
  buildPolymarketSelectionRecords,
  syncPolymarketNbaMarkets,
} from "../polymarket";

let tempDir = "";

function seedUpcomingGame() {
  upsertGame({
    awayParticipant: {
      abbreviation: "LAL",
      key: "lal",
      name: "Los Angeles Lakers",
      shortName: "Lakers",
      side: "away",
    },
    homeParticipant: {
      abbreviation: "HOU",
      key: "hou",
      name: "Houston Rockets",
      shortName: "Rockets",
      side: "home",
    },
    id: "nba-0042500173",
    league: "NBA",
    scheduledStart: "2026-04-24T00:00:00.000Z",
    sourceGameKeyNba: "0042500173",
    sport: "basketball",
  });

  recordGameStateObservation({
    awayScore: 84,
    capturedAt: "2026-04-22T07:20:47.555Z",
    clock: "08:41",
    finalAt: null,
    gameId: "nba-0042500173",
    homeScore: 91,
    isFinal: false,
    period: 3,
    startedAt: "2026-04-24T00:02:00.000Z",
    status: "in-play",
  });
}

const polymarketEventsPayload = [
  {
    eventDate: "2026-04-24",
    id: "391580",
    markets: [
      {
        id: "2012793",
        line: null,
        outcomes: '["Lakers","Rockets"]',
        outcomePrices: '["0.215","0.785"]',
        question: "Lakers vs. Rockets",
        slug: "nba-lal-hou-2026-04-24",
        sportsMarketType: "moneyline",
        volume: "85277.13898099992",
      },
      {
        id: "2050543",
        line: -9.5,
        outcomes: '["Rockets","Lakers"]',
        outcomePrices: '["0.52","0.48"]',
        question: "Spread: Rockets (-9.5)",
        slug: "nba-lal-hou-2026-04-24-spread-home-9pt5",
        sportsMarketType: "spreads",
        volume: "39.215685",
      },
      {
        id: "2050544",
        line: 205.5,
        outcomes: '["Over","Under"]',
        outcomePrices: '["0.505","0.495"]',
        question: "Lakers vs. Rockets: O/U 205.5",
        slug: "nba-lal-hou-2026-04-24-total-205pt5",
        sportsMarketType: "totals",
      },
      {
        id: "2050554",
        line: 24.5,
        outcomes: '["Yes","No"]',
        outcomePrices: '["0.57","0.43"]',
        question: "LeBron James: Points O/U 24.5",
        slug: "nba-lal-hou-2026-04-24-points-lebron-james-24pt5",
        sportsMarketType: "points",
      },
    ],
    slug: "nba-lal-hou-2026-04-24",
    startTime: "2026-04-25T00:00:00Z",
    teams: [
      {
        abbreviation: "lal",
        id: 100515,
        name: "Lakers",
      },
      {
        abbreviation: "hou",
        id: 100503,
        name: "Rockets",
      },
    ],
    title: "Lakers vs. Rockets",
  },
];

describe("polymarket adapter", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "signal-console-polymarket-"));
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

  it("builds canonical selection records for supported Polymarket game markets", () => {
    seedUpcomingGame();

    const games = listResearchGames({
      date: "2026-04-24",
      league: "NBA",
      sport: "basketball",
    });

    const records = buildPolymarketSelectionRecords(
      polymarketEventsPayload[0],
      games[0],
      polymarketEventsPayload[0].markets[1],
      "2026-04-22T07:25:00.000Z"
    );

    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          displayLabel: "Rockets -9.5",
          family: "spread",
          line: -9.5,
          selection: "hou",
        }),
        expect.objectContaining({
          displayLabel: "Lakers +9.5",
          family: "spread",
          line: 9.5,
          selection: "lal",
        }),
      ])
    );

    const propRecords = buildPolymarketSelectionRecords(
      polymarketEventsPayload[0],
      games[0],
      polymarketEventsPayload[0].markets[3],
      "2026-04-22T07:25:00.000Z"
    );

    expect(propRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          displayLabel: "LeBron James points over 24.5",
          family: "player-prop",
          instrumentId:
            "nba-0042500173-player-prop-points-lebron-james-over-24-5",
          line: 24.5,
          participantKey: "lebron-james",
          selection: "over",
        }),
      ])
    );
  });

  it("writes real game-market rows into the live research store", async () => {
    seedUpcomingGame();

    const result = await syncPolymarketNbaMarkets({
      fetchImpl: (async () => ({
        json: async () => polymarketEventsPayload,
        ok: true,
        status: 200,
      })) as never,
      now: () => new Date("2026-04-22T07:25:00.000Z"),
    });

    expect(result.ok).toBe(true);
    expect(result.gamesMatched).toBe(1);
    expect(result.marketsSeen).toBe(4);
    expect(result.sourceMarketsObserved).toBe(8);
    expect(result.rawPayloadsWritten).toBe(8);

    expect(listGameMarkets("nba-0042500173")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          instrument: expect.objectContaining({
            displayLabel: "Lakers moneyline",
          }),
        }),
        expect.objectContaining({
          instrument: expect.objectContaining({
            displayLabel: "Rockets -9.5",
          }),
        }),
        expect.objectContaining({
          instrument: expect.objectContaining({
            displayLabel: "Over 205.5 total",
          }),
        }),
        expect.objectContaining({
          instrument: expect.objectContaining({
            displayLabel: "LeBron James points over 24.5",
          }),
        }),
      ])
    );

    expect(
      getInstrumentComparison(
        "nba-0042500173",
        "nba-0042500173-moneyline-lakers-moneyline"
      )
    ).toMatchObject({
      latestQuotesBySource: expect.arrayContaining([
        expect.objectContaining({
          impliedProbability: 0.215,
          source: "polymarket",
        }),
      ]),
    });

    expect(
      getInstrumentComparison(
        "nba-0042500173",
        "nba-0042500173-player-prop-points-lebron-james-over-24-5"
      )
    ).toMatchObject({
      latestQuotesBySource: expect.arrayContaining([
        expect.objectContaining({
          impliedProbability: 0.57,
          source: "polymarket",
        }),
      ]),
    });

    expect(listAdapterRuns(5)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recordsSeen: 8,
          source: "polymarket",
          status: "ok",
        }),
      ])
    );
  });

  it("matches live playoff events when Polymarket eventDate is local but startTime is next-day UTC", async () => {
    seedUpcomingGame();

    const result = await syncPolymarketNbaMarkets({
      fetchImpl: (async () => ({
        json: async () => [
          {
            ...polymarketEventsPayload[0],
            eventDate: "2026-04-23",
            startTime: "2026-04-24T00:00:00Z",
          },
        ],
        ok: true,
        status: 200,
      })) as never,
      now: () => new Date("2026-04-22T07:25:00.000Z"),
    });

    expect(result.ok).toBe(true);
    expect(result.gamesMatched).toBe(1);
    expect(result.marketsSeen).toBe(4);
    expect(result.sourceMarketsObserved).toBe(8);
  });
});
