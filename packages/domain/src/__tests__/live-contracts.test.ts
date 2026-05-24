import { describe, expect, it } from "vitest";

import {
  canonicalGameSchema,
  canonicalGameStateSchema,
  instrumentComparisonViewSchema,
  researchGameCardSchema,
} from "../index";

describe("live domain contracts", () => {
  it("validates a canonical game and game state payload", () => {
    expect(
      canonicalGameSchema.parse({
        awayParticipant: {
          abbreviation: "NYK",
          key: "nyk",
          name: "New York Knicks",
          shortName: "Knicks",
          side: "away",
        },
        homeParticipant: {
          abbreviation: "BOS",
          key: "bos",
          name: "Boston Celtics",
          shortName: "Celtics",
          side: "home",
        },
        id: "nba-0022600001",
        league: "NBA",
        scheduledStart: "2026-04-22T02:00:00.000Z",
        sourceGameKeyNba: "0022600001",
        sport: "basketball",
      })
    ).toMatchObject({
      id: "nba-0022600001",
      league: "NBA",
      sport: "basketball",
    });

    expect(
      canonicalGameStateSchema.parse({
        awayScore: 108,
        capturedAt: "2026-04-22T05:55:00.000Z",
        clock: "00:42",
        gameId: "nba-0022600001",
        homeScore: 112,
        id: 1,
        isFinal: false,
        period: 4,
        status: "in-play",
      })
    ).toMatchObject({
      awayScore: 108,
      homeScore: 112,
      status: "in-play",
    });
  });

  it("validates research game cards and instrument comparison views", () => {
    expect(
      researchGameCardSchema.parse({
        activeInstrumentCount: 3,
        coverage: {
          activeSourceCount: 4,
          availableSources: ["bet365", "kalshi", "polymarket", "nba"],
          missingSources: [],
          unmappedSourceMarketCount: 1,
        },
        game: {
          awayParticipant: {
            abbreviation: "NYK",
            key: "nyk",
            name: "New York Knicks",
            shortName: "Knicks",
            side: "away",
          },
          homeParticipant: {
            abbreviation: "BOS",
            key: "bos",
            name: "Boston Celtics",
            shortName: "Celtics",
            side: "home",
          },
          id: "nba-0022600001",
          league: "NBA",
          scheduledStart: "2026-04-22T02:00:00.000Z",
          sourceGameKeyNba: "0022600001",
          sport: "basketball",
        },
        gameState: {
          awayScore: 108,
          capturedAt: "2026-04-22T05:55:00.000Z",
          clock: "00:42",
          gameId: "nba-0022600001",
          homeScore: 112,
          id: 1,
          isFinal: false,
          period: 4,
          status: "in-play",
        },
        hasUnmappedMarkets: true,
        topDivergences: [
          {
            displayLabel: "Boston moneyline",
            family: "moneyline",
            impliedProbabilityGap: 0.07,
            instrumentId: "bos-moneyline",
            lineMismatch: false,
            severity: "high",
          },
        ],
      })
    ).toBeTruthy();

    expect(
      instrumentComparisonViewSchema.parse({
        derivedComparison: {
          comparableState: "comparable",
          impliedProbabilityGap: 0.07,
          lineMismatch: false,
          sourceCount: 3,
        },
        gameState: {
          awayScore: 108,
          capturedAt: "2026-04-22T05:55:00.000Z",
          clock: "00:42",
          gameId: "nba-0022600001",
          homeScore: 112,
          id: 1,
          isFinal: false,
          period: 4,
          status: "in-play",
        },
        instrument: {
          displayLabel: "Boston moneyline",
          family: "moneyline",
          gameId: "nba-0022600001",
          id: "bos-moneyline",
          inPlay: true,
          line: null,
          selection: "bos",
        },
        latestQuotesBySource: [
          {
            capturedAt: "2026-04-22T05:55:00.000Z",
            impliedProbability: 0.61,
            mappingStatus: "auto",
            raw: {
              label: "Boston Celtics",
              line: null,
            },
            source: "bet365",
            sourceMarketId: "sm-bet365-bos-moneyline",
          },
        ],
        latestRawReferences: [],
      })
    ).toBeTruthy();
  });
});
