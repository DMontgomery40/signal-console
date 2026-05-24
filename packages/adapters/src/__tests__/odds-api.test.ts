import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getInstrumentComparison,
  listAdapterRuns,
  listGameMarkets,
  listResearchGames,
  listUnmappedMarkets,
  recordGameStateObservation,
  resetDatabase,
  upsertGame,
} from "@signal-console/shared";

import {
  buildOddsApiSelectionRecords,
  syncOddsApiBet365NbaMarkets,
  syncOddsApiKalshiNbaMarkets,
} from "../odds-api";

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

const oddsApiEventsPayload = [
  {
    away: "Los Angeles Lakers",
    date: "2026-04-24T00:00:00.000Z",
    home: "Houston Rockets",
    id: "evt-1",
    league: {
      name: "NBA",
      slug: "usa-nba",
    },
    sport: {
      name: "Basketball",
      slug: "basketball",
    },
    status: "live",
  },
];

const bet365OddsPayload = [
  {
    ...oddsApiEventsPayload[0],
    bookmakerIds: {
      Bet365: "bet365-event-1",
    },
    bookmakers: {
      Bet365: [
        {
          name: "ML",
          odds: [
            {
              away: "2.60",
              home: "1.55",
            },
          ],
          updatedAt: "2026-04-22T07:25:00.000Z",
        },
        {
          name: "Spread",
          odds: [
            {
              away: "1.95",
              hdp: -6.5,
              home: "1.91",
            },
          ],
          updatedAt: "2026-04-22T07:25:10.000Z",
        },
        {
          name: "Totals",
          odds: [
            {
              max: 221.5,
              over: "1.87",
              under: "1.99",
            },
          ],
          updatedAt: "2026-04-22T07:25:20.000Z",
        },
        {
          name: "Points O/U",
          odds: [
            {
              hdp: 28.5,
              label: "LeBron James (1) (28.5)",
              over: "1.90",
              under: "1.90",
            },
          ],
          updatedAt: "2026-04-22T07:25:30.000Z",
        },
        {
          name: "Player Points Milestones",
          odds: [
            {
              hdp: 30,
              label: "LeBron James",
              over: "2.50",
            },
          ],
          updatedAt: "2026-04-22T07:25:40.000Z",
        },
        {
          name: "Double Double",
          odds: [
            {
              label: "LeBron James (Yes) (1)",
              under: "3.25",
            },
            {
              label: "LeBron James (No) (1)",
              under: "1.30",
            },
          ],
          updatedAt: "2026-04-22T07:25:50.000Z",
        },
      ],
    },
    urls: {
      Bet365: "https://example.com/bet365/event-1",
    },
  },
];

const kalshiOddsPayload = [
  {
    ...oddsApiEventsPayload[0],
    bookmakerIds: {
      Kalshi: "KXNBA-1",
    },
    bookmakers: {
      Kalshi: [
        {
          name: "ML",
          odds: [
            {
              away: "6.25",
              depthAway: "9215",
              depthHome: "2164",
              depthLayAway: "5371",
              depthLayHome: "250",
              home: "1.56",
              layAway: "1.61",
              layHome: "7.14",
            },
          ],
          updatedAt: "2026-04-22T07:26:00.000Z",
        },
        {
          name: "Spread",
          odds: [
            {
              away: "1.94",
              depthAway: "730",
              depthHome: "610",
              depthLayAway: "415",
              depthLayHome: "390",
              hdp: -5.5,
              home: "1.88",
              layAway: "1.99",
              layHome: "2.02",
            },
          ],
          updatedAt: "2026-04-22T07:26:10.000Z",
        },
      ],
    },
    urls: {
      Kalshi: "https://kalshi.com/events/KXNBA-1",
    },
  },
];

function makeOddsApiFetch(bookmaker: "Bet365" | "Kalshi") {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const pathname = url.pathname;
    const requestedBookmaker =
      url.searchParams.get("bookmaker") ?? url.searchParams.get("bookmakers");

    if (pathname.endsWith("/events") && requestedBookmaker === bookmaker) {
      return {
        json: async () => oddsApiEventsPayload,
        ok: true,
        status: 200,
      };
    }

    if (pathname.endsWith("/odds/multi") && requestedBookmaker === bookmaker) {
      return {
        json: async () =>
          bookmaker === "Bet365" ? bet365OddsPayload : kalshiOddsPayload,
        ok: true,
        status: 200,
      };
    }

    return {
      json: async () => ({ error: "not-found" }),
      ok: false,
      status: 404,
    };
  }) as typeof fetch;
}

function makeStrictOddsApiFetch(bookmaker: "Bet365" | "Kalshi") {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const pathname = url.pathname;
    const requestedBookmaker =
      url.searchParams.get("bookmaker") ?? url.searchParams.get("bookmakers");

    if (pathname === "/v3/events" && requestedBookmaker === bookmaker) {
      return {
        json: async () => oddsApiEventsPayload,
        ok: true,
        status: 200,
      };
    }

    if (pathname === "/v3/odds/multi" && requestedBookmaker === bookmaker) {
      return {
        json: async () =>
          bookmaker === "Bet365" ? bet365OddsPayload : kalshiOddsPayload,
        ok: true,
        status: 200,
      };
    }

    return {
      json: async () => ({ error: "not-found", pathname }),
      ok: false,
      status: 404,
    };
  }) as typeof fetch;
}

describe("odds-api adapter", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "signal-console-odds-api-"));
    process.env.SIGNAL_CONSOLE_DB_PATH = join(tempDir, "signal-console.sqlite");
    resetDatabase();
  });

  afterEach(() => {
    resetDatabase();
    delete process.env.SIGNAL_CONSOLE_DB_PATH;
    delete process.env.ODDS_API_KEY;

    if (tempDir) {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("builds canonical records for both fixed-odds and exchange-style bookmaker payloads", () => {
    seedUpcomingGame();

    const games = listResearchGames({
      date: "2026-04-24",
      league: "NBA",
      sport: "basketball",
    });

    const bet365Records = buildOddsApiSelectionRecords(
      "Bet365",
      bet365OddsPayload[0],
      games[0]
    );
    const kalshiRecords = buildOddsApiSelectionRecords(
      "Kalshi",
      kalshiOddsPayload[0],
      games[0]
    );

    expect(bet365Records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          displayLabel: "Rockets moneyline",
          oddsRaw: "1.55",
          selection: "hou",
          source: "bet365",
        }),
        expect.objectContaining({
          displayLabel: "Lakers +6.5",
          line: 6.5,
          selection: "lal",
          source: "bet365",
        }),
        expect.objectContaining({
          displayLabel: "Over 221.5 total",
          line: 221.5,
          selection: "over",
          source: "bet365",
        }),
        expect.objectContaining({
          displayLabel: "LeBron James points over 28.5",
          family: "player-prop",
          line: 28.5,
          participantKey: "lebron-james",
          selection: "over",
          source: "bet365",
        }),
        expect.objectContaining({
          displayLabel: "LeBron James points milestone over 30",
          family: "player-prop",
          line: 30,
          selection: "over",
          source: "bet365",
        }),
        expect.objectContaining({
          displayLabel: "LeBron James double double yes 1",
          family: "player-prop",
          selection: "yes",
          source: "bet365",
        }),
      ])
    );

    expect(kalshiRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bestAsk: expect.any(Number),
          bestBid: expect.any(Number),
          depthScore: 250,
          displayLabel: "Rockets moneyline",
          source: "kalshi",
          volume: 2164,
        }),
        expect.objectContaining({
          depthScore: 415,
          displayLabel: "Lakers +5.5",
          line: 5.5,
          source: "kalshi",
          volume: 730,
        }),
      ])
    );
  });

  it("writes Bet365 and Kalshi backup rows into the live research store", async () => {
    seedUpcomingGame();

    const bet365Result = await syncOddsApiBet365NbaMarkets({
      apiKey: "odds-key",
      fetchImpl: makeOddsApiFetch("Bet365"),
      now: () => new Date("2026-04-22T07:25:00.000Z"),
    });
    const kalshiResult = await syncOddsApiKalshiNbaMarkets({
      apiKey: "odds-key",
      fetchImpl: makeOddsApiFetch("Kalshi"),
      now: () => new Date("2026-04-22T07:26:00.000Z"),
    });

    expect(bet365Result.ok).toBe(true);
    expect(bet365Result.gamesMatched).toBe(1);
    expect(bet365Result.sourceMarketsObserved).toBe(11);

    expect(kalshiResult.ok).toBe(true);
    expect(kalshiResult.gamesMatched).toBe(1);
    expect(kalshiResult.sourceMarketsObserved).toBe(4);

    expect(listGameMarkets("nba-0042500173")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          instrument: expect.objectContaining({
            displayLabel: "Rockets moneyline",
          }),
        }),
        expect.objectContaining({
          instrument: expect.objectContaining({
            displayLabel: "Lakers +6.5",
          }),
        }),
        expect.objectContaining({
          instrument: expect.objectContaining({
            displayLabel: "Over 221.5 total",
          }),
        }),
        expect.objectContaining({
          instrument: expect.objectContaining({
            displayLabel: "LeBron James points over 28.5",
            family: "player-prop",
          }),
        }),
      ])
    );

    const comparison = getInstrumentComparison(
      "nba-0042500173",
      "nba-0042500173-moneyline-rockets-moneyline"
    );
    expect(comparison).toMatchObject({
      latestQuotesBySource: expect.arrayContaining([
        expect.objectContaining({
          impliedProbability: 1 / 1.55,
          source: "bet365",
        }),
        expect.objectContaining({
          raw: expect.objectContaining({
            bestAsk: 1 / 7.14,
            bestBid: 1 / 1.56,
            depthScore: 250,
            volume: 2164,
          }),
          source: "kalshi",
        }),
      ]),
    });

    expect(listAdapterRuns(5)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recordsSeen: 11,
          source: "bet365",
          status: "ok",
        }),
        expect.objectContaining({
          recordsSeen: 4,
          source: "kalshi",
          status: "ok",
        }),
      ])
    );
  });

  it("keeps unsupported windowed or scoped markets unmapped instead of mixing them into the full-game instrument", async () => {
    seedUpcomingGame();

    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const pathname = url.pathname;
      const requestedBookmaker =
        url.searchParams.get("bookmaker") ?? url.searchParams.get("bookmakers");

      if (pathname.endsWith("/events") && requestedBookmaker === "Bet365") {
        return {
          json: async () => oddsApiEventsPayload,
          ok: true,
          status: 200,
        };
      }

      if (pathname.endsWith("/odds/multi") && requestedBookmaker === "Bet365") {
        return {
          json: async () => [
            {
              ...bet365OddsPayload[0],
              bookmakers: {
                Bet365: [
                  ...(bet365OddsPayload[0].bookmakers?.Bet365 ?? []),
                  {
                    name: "Spread Q1",
                    odds: [
                      {
                        away: "2.40",
                        hdp: -6.5,
                        home: "1.60",
                      },
                    ],
                    updatedAt: "2026-04-22T07:28:00.000Z",
                  },
                  {
                    name: "Team Totals",
                    odds: [
                      {
                        max: 113.5,
                        over: "1.88",
                        under: "1.94",
                      },
                    ],
                    updatedAt: "2026-04-22T07:29:00.000Z",
                  },
                ],
              },
            },
          ],
          ok: true,
          status: 200,
        };
      }

      return {
        json: async () => ({ error: "not-found" }),
        ok: false,
        status: 404,
      };
    }) as typeof fetch;

    const result = await syncOddsApiBet365NbaMarkets({
      apiKey: "odds-key",
      fetchImpl,
      now: () => new Date("2026-04-22T07:30:00.000Z"),
    });

    expect(result.ok).toBe(true);
    expect(result.sourceMarketsObserved).toBe(15);

    const comparison = getInstrumentComparison(
      "nba-0042500173",
      "nba-0042500173-spreads-rockets-6-5"
    );

    expect(comparison?.latestQuotesBySource).toEqual([
      expect.objectContaining({
        impliedProbability: 1 / 1.91,
        source: "bet365",
      }),
    ]);

    expect(listUnmappedMarkets()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceMarket: expect.objectContaining({
            mappingStatus: "unmapped",
            rawFamily: "Spread Q1",
            source: "bet365",
          }),
        }),
        expect.objectContaining({
          sourceMarket: expect.objectContaining({
            mappingStatus: "unmapped",
            rawFamily: "Team Totals",
            source: "bet365",
          }),
        }),
      ])
    );
  });

  it("preserves the /v3 prefix when building Odds API request URLs", async () => {
    seedUpcomingGame();

    const bet365Result = await syncOddsApiBet365NbaMarkets({
      apiKey: "odds-key",
      fetchImpl: makeStrictOddsApiFetch("Bet365"),
      now: () => new Date("2026-04-22T07:25:00.000Z"),
    });
    const kalshiResult = await syncOddsApiKalshiNbaMarkets({
      apiKey: "odds-key",
      fetchImpl: makeStrictOddsApiFetch("Kalshi"),
      now: () => new Date("2026-04-22T07:26:00.000Z"),
    });

    expect(bet365Result.ok).toBe(true);
    expect(kalshiResult.ok).toBe(true);
  });

  it("only polls odds-api events for the active target slate before requesting odds", async () => {
    seedUpcomingGame();
    upsertGame({
      awayParticipant: {
        abbreviation: "GSW",
        key: "gsw",
        name: "Golden State Warriors",
        shortName: "Warriors",
        side: "away",
      },
      homeParticipant: {
        abbreviation: "DAL",
        key: "dal",
        name: "Dallas Mavericks",
        shortName: "Mavericks",
        side: "home",
      },
      id: "nba-0042500174",
      league: "NBA",
      scheduledStart: "2026-04-24T05:00:00.000Z",
      sourceGameKeyNba: "0042500174",
      sport: "basketball",
    });
    upsertGame({
      awayParticipant: {
        abbreviation: "MIA",
        key: "mia",
        name: "Miami Heat",
        shortName: "Heat",
        side: "away",
      },
      homeParticipant: {
        abbreviation: "BOS",
        key: "bos",
        name: "Boston Celtics",
        shortName: "Celtics",
        side: "home",
      },
      id: "nba-0042500175",
      league: "NBA",
      scheduledStart: "2026-04-25T18:00:00.000Z",
      sourceGameKeyNba: "0042500175",
      sport: "basketball",
    });

    const eventCalls: Array<Record<string, string | null>> = [];
    let requestedEventIds: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const pathname = url.pathname;
      const requestedBookmaker =
        url.searchParams.get("bookmaker") ?? url.searchParams.get("bookmakers");

      if (pathname.endsWith("/events") && requestedBookmaker === "Bet365") {
        eventCalls.push({
          bookmaker: requestedBookmaker,
          from: url.searchParams.get("from"),
          league: url.searchParams.get("league"),
          limit: url.searchParams.get("limit"),
          sport: url.searchParams.get("sport"),
          status: url.searchParams.get("status"),
          to: url.searchParams.get("to"),
        });

        return {
          json: async () => [
            ...oddsApiEventsPayload,
            {
              away: "Golden State Warriors",
              date: "2026-04-24T05:00:00.000Z",
              home: "Dallas Mavericks",
              id: "evt-2",
              league: {
                name: "NBA",
                slug: "usa-nba",
              },
              sport: {
                name: "Basketball",
                slug: "basketball",
              },
              status: "pending",
            },
            {
              away: "Miami Heat",
              date: "2026-04-25T18:00:00.000Z",
              home: "Boston Celtics",
              id: "evt-outside-window",
              league: {
                name: "NBA",
                slug: "usa-nba",
              },
              sport: {
                name: "Basketball",
                slug: "basketball",
              },
              status: "pending",
            },
          ],
          ok: true,
          status: 200,
        };
      }

      if (pathname.endsWith("/odds/multi") && requestedBookmaker === "Bet365") {
        requestedEventIds = (url.searchParams.get("eventIds") ?? "")
          .split(",")
          .filter(Boolean);

        return {
          json: async () =>
            requestedEventIds.flatMap((eventId) => {
              if (eventId === "evt-1") {
                return bet365OddsPayload;
              }

              if (eventId === "evt-2") {
                return [
                  {
                    away: "Golden State Warriors",
                    bookmakerIds: {
                      Bet365: "bet365-event-2",
                    },
                    bookmakers: {
                      Bet365: [
                        {
                          name: "ML",
                          odds: [
                            {
                              away: "2.30",
                              home: "1.70",
                            },
                          ],
                          updatedAt: "2026-04-24T05:01:00.000Z",
                        },
                      ],
                    },
                    date: "2026-04-24T05:00:00.000Z",
                    home: "Dallas Mavericks",
                    id: "evt-2",
                    league: {
                      name: "NBA",
                      slug: "usa-nba",
                    },
                    sport: {
                      name: "Basketball",
                      slug: "basketball",
                    },
                    status: "pending",
                    urls: {
                      Bet365: "https://example.com/bet365/event-2",
                    },
                  },
                ];
              }

              if (eventId === "evt-outside-window") {
                throw new Error("outside-window event should not be requested");
              }

              return [];
            }),
          ok: true,
          status: 200,
        };
      }

      return {
        json: async () => ({ error: "not-found" }),
        ok: false,
        status: 404,
      };
    }) as typeof fetch;

    const result = await syncOddsApiBet365NbaMarkets({
      apiKey: "odds-key",
      fetchImpl,
      now: () => new Date("2026-04-24T02:00:00.000Z"),
    });

    expect(result.ok).toBe(true);
    expect(eventCalls).toEqual([
      {
        bookmaker: "Bet365",
        from: "2026-04-23T22:30:00.000Z",
        league: "usa-nba",
        limit: "100",
        sport: "basketball",
        status: "pending,live",
        to: "2026-04-24T13:00:00.000Z",
      },
    ]);
    expect(requestedEventIds).toEqual(["evt-1", "evt-2"]);
    expect(listGameMarkets("nba-0042500173")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          instrument: expect.objectContaining({
            displayLabel: "Rockets moneyline",
          }),
        }),
      ])
    );
    expect(listGameMarkets("nba-0042500174")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          instrument: expect.objectContaining({
            displayLabel: "Mavericks moneyline",
          }),
        }),
      ])
    );
    expect(listGameMarkets("nba-0042500175")).toHaveLength(0);
  });
});
