import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getDatabase,
  resetDatabase,
  upsertGame,
  upsertMarketInstrument,
  upsertSourceMarket,
} from "@signal-console/shared";

import { syncPolymarketNbaTrades } from "../polymarket-trades";

let tempDir = "";

function seedGameAndMarkets() {
  upsertGame({
    awayParticipant: {
      abbreviation: "CLE",
      key: "cle",
      name: "Cleveland Cavaliers",
      shortName: "Cavaliers",
      side: "away",
    },
    homeParticipant: {
      abbreviation: "DET",
      key: "det",
      name: "Detroit Pistons",
      shortName: "Pistons",
      side: "home",
    },
    id: "nba-0042500207",
    league: "NBA",
    scheduledStart: "2026-05-18T00:00:00.000Z",
    sourceGameKeyNba: "0042500207",
    sport: "basketball",
  });

  upsertMarketInstrument({
    displayLabel: "Jarrett Allen rebounds over 1.5",
    family: "player-prop",
    gameId: "nba-0042500207",
    id: "nba-0042500207-player-prop-rebounds-jarrett-allen-over-1-5",
    inPlay: true,
    line: 1.5,
    participantKey: "jarrett-allen",
    selection: "over",
  });

  upsertSourceMarket({
    gameId: "nba-0042500207",
    id: "pm-2277370-over",
    instrumentId: "nba-0042500207-player-prop-rebounds-jarrett-allen-over-1-5",
    mappingStatus: "auto",
    rawFamily: "rebounds",
    rawLabel: "Jarrett Allen: Rebounds O/U 1.5",
    rawMetadata: {
      eventSlug: "nba-cle-det-2026-05-17",
      marketId: "2277370",
      sportsMarketType: "rebounds",
    },
    source: "polymarket",
    sourceMarketKey: "nba-cle-det-2026-05-17-rebounds-jarrett-allen-1pt5",
    sourceSelectionKey: "over",
  });

  upsertSourceMarket({
    gameId: "nba-0042500207",
    id: "pm-2277370-under",
    instrumentId: null,
    mappingStatus: "auto",
    rawFamily: "rebounds",
    rawLabel: "Jarrett Allen: Rebounds O/U 1.5",
    rawMetadata: {
      eventSlug: "nba-cle-det-2026-05-17",
      marketId: "2277370",
      sportsMarketType: "rebounds",
    },
    source: "polymarket",
    sourceMarketKey: "nba-cle-det-2026-05-17-rebounds-jarrett-allen-1pt5",
    sourceSelectionKey: "under",
  });
}

describe("polymarket trade adapter", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "signal-console-polymarket-trades-"));
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

  it("hydrates Data API trades through Gamma condition ids and records live-to-date volume share", async () => {
    seedGameAndMarkets();

    const result = await syncPolymarketNbaTrades({
      dataApiBaseUrl: "https://data.example.test",
      fetchImpl: (async (url: string) => {
        const parsed = new URL(url);
        if (parsed.hostname === "gamma.example.test") {
          return {
            json: async () => [
              {
                active: true,
                closed: false,
                id: "472500",
                markets: [
                  {
                    conditionId: "0xallen-rebounds",
                    id: "2277370",
                    outcomes: '["Yes","No"]',
                    question: "Jarrett Allen: Rebounds O/U 1.5",
                    slug: "nba-cle-det-2026-05-17-rebounds-jarrett-allen-1pt5",
                    sportsMarketType: "rebounds",
                    volume: "74.880458",
                  },
                ],
                slug: "nba-cle-det-2026-05-17",
                teams: [
                  { abbreviation: "CLE", name: "Cavaliers" },
                  { abbreviation: "DET", name: "Pistons" },
                ],
              },
            ],
            ok: true,
            status: 200,
          };
        }
        expect(parsed.pathname).toBe("/trades");
        expect(parsed.searchParams.get("market")).toBe("0xallen-rebounds");
        return {
          json: async () => [
            {
              eventSlug: "nba-cle-det-2026-05-17",
              outcome: "Yes",
              price: 0.99,
              side: "BUY",
              size: 20.202,
              timestamp: 1779063777,
              transactionHash: "0xallen",
            },
          ],
          ok: true,
          status: 200,
        };
      }) as never,
      gammaBaseUrl: "https://gamma.example.test",
      gameId: "nba-0042500207",
      interRequestMs: 0,
      since: "2026-05-18T00:00:00.000Z",
      until: "2026-05-18T02:00:00.000Z",
    });

    expect(result).toMatchObject({
      eventsFetched: 1,
      marketsScanned: 1,
      tradesSeen: 1,
      tradesWritten: 1,
    });

    const row = getDatabase()
      .prepare(
        `SELECT
           source_market_id AS sourceMarketId,
           event_timestamp AS eventTimestamp,
           trade_price AS tradePrice,
           size,
           notional,
           volume,
           final_market_volume AS finalMarketVolume,
           volume_share AS volumeShare,
           raw_metadata_json AS rawMetadataJson
         FROM market_microstructure_events`
      )
      .get() as Record<string, unknown>;

    expect(row).toMatchObject({
      eventTimestamp: "2026-05-18T00:22:57.000Z",
      finalMarketVolume: null,
      notional: expect.closeTo(19.99998, 6),
      size: 20.202,
      sourceMarketId: "pm-2277370-over",
      tradePrice: 0.99,
      volume: 74.880458,
      volumeShare: expect.closeTo(20.202 / 74.880458, 6),
    });
    expect(JSON.parse(String(row.rawMetadataJson))).toMatchObject({
      conditionId: "0xallen-rebounds",
      reportedVolumeBasis: "live-to-date",
      transactionHash: "0xallen",
    });

    const sourceMarket = getDatabase()
      .prepare(
        `SELECT raw_metadata_json AS rawMetadataJson
         FROM source_markets
         WHERE id = 'pm-2277370-over'`
      )
      .get() as Record<string, unknown>;
    expect(JSON.parse(String(sourceMarket.rawMetadataJson))).toMatchObject({
      clobTokenIds: [],
      conditionId: "0xallen-rebounds",
      eventId: "472500",
      marketId: "2277370",
      marketVolume: 74.880458,
      outcomes: ["Yes", "No"],
      sportsMarketType: "rebounds",
    });
  });

  it("keeps trade backfill idempotent across raw payloads and microstructure rows", async () => {
    seedGameAndMarkets();
    const fetchImpl = (async (url: string) => {
      const parsed = new URL(url);
      if (parsed.hostname === "gamma.example.test") {
        return {
          json: async () => [
            {
              active: true,
              closed: false,
              id: "472500",
              markets: [
                {
                  conditionId: "0xallen-rebounds",
                  id: "2277370",
                  outcomes: '["Yes","No"]',
                  question: "Jarrett Allen: Rebounds O/U 1.5",
                  slug: "nba-cle-det-2026-05-17-rebounds-jarrett-allen-1pt5",
                  sportsMarketType: "rebounds",
                  volume: "74.880458",
                },
              ],
              slug: "nba-cle-det-2026-05-17",
            },
          ],
          ok: true,
          status: 200,
        };
      }
      return {
        json: async () => [
          {
            outcome: "Yes",
            price: 0.99,
            side: "BUY",
            size: 20.202,
            timestamp: 1779063777,
            transactionHash: "0xallen",
          },
        ],
        ok: true,
        status: 200,
      };
    }) as never;

    const options = {
      dataApiBaseUrl: "https://data.example.test",
      fetchImpl,
      gammaBaseUrl: "https://gamma.example.test",
      gameId: "nba-0042500207",
      interRequestMs: 0,
      since: "2026-05-18T00:00:00.000Z",
      until: "2026-05-18T02:00:00.000Z",
    };
    const first = await syncPolymarketNbaTrades(options);
    const second = await syncPolymarketNbaTrades(options);

    expect(first.tradesWritten).toBe(1);
    expect(second.tradesWritten).toBe(0);
    expect(
      getDatabase()
        .prepare("SELECT COUNT(*) AS count FROM market_microstructure_events")
        .get()
    ).toEqual({ count: 1 });
    expect(
      getDatabase()
        .prepare(
          "SELECT COUNT(*) AS count FROM raw_payloads WHERE entity_type = 'polymarket-data-api-trade'"
        )
        .get()
    ).toEqual({ count: 1 });
  });

  it("limits distinct Gamma markets without dropping the opposite selection row", async () => {
    seedGameAndMarkets();

    const result = await syncPolymarketNbaTrades({
      dataApiBaseUrl: "https://data.example.test",
      fetchImpl: (async (url: string) => {
        const parsed = new URL(url);
        if (parsed.hostname === "gamma.example.test") {
          return {
            json: async () => [
              {
                active: true,
                closed: false,
                id: "472500",
                markets: [
                  {
                    conditionId: "0xallen-rebounds",
                    id: "2277370",
                    outcomes: '["Yes","No"]',
                    question: "Jarrett Allen: Rebounds O/U 1.5",
                    slug: "nba-cle-det-2026-05-17-rebounds-jarrett-allen-1pt5",
                    sportsMarketType: "rebounds",
                    volume: "100",
                  },
                ],
                slug: "nba-cle-det-2026-05-17",
              },
            ],
            ok: true,
            status: 200,
          };
        }
        return {
          json: async () => [
            {
              outcome: "No",
              price: 0.44,
              side: "BUY",
              size: 9,
              timestamp: 1779063777,
              transactionHash: "0xallen-under",
            },
          ],
          ok: true,
          status: 200,
        };
      }) as never,
      gammaBaseUrl: "https://gamma.example.test",
      gameId: "nba-0042500207",
      interRequestMs: 0,
      maxMarkets: 1,
      since: "2026-05-18T00:00:00.000Z",
      until: "2026-05-18T02:00:00.000Z",
    });

    expect(result.tradesSeen).toBe(1);
    expect(result.tradesWritten).toBe(1);
    expect(
      getDatabase()
        .prepare(
          "SELECT source_market_id AS sourceMarketId FROM market_microstructure_events"
        )
        .get()
    ).toEqual({ sourceMarketId: "pm-2277370-under" });
  });
});
