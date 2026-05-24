import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getDatabase,
  listAdapterRuns,
  resetDatabase,
  upsertGame,
} from "@signal-console/shared";

import { syncKalshiNbaDirect } from "../kalshi-direct";

let tempDir = "";

function seedGame() {
  upsertGame({
    awayParticipant: {
      abbreviation: "ORL",
      key: "orl",
      name: "Orlando Magic",
      shortName: "Magic",
      side: "away",
    },
    homeParticipant: {
      abbreviation: "DET",
      key: "det",
      name: "Detroit Pistons",
      shortName: "Pistons",
      side: "home",
    },
    id: "nba-0042500300",
    league: "NBA",
    scheduledStart: "2026-05-03T23:00:00.000Z",
    sourceGameKeyNba: "0042500300",
    sport: "basketball",
  });
}

const eventPayloads: Record<string, unknown> = {
  "KXNBAPTS-26MAY03ORLDET": {
    event: {
      category: "Sports",
      event_ticker: "KXNBAPTS-26MAY03ORLDET",
      series_ticker: "KXNBAPTS",
      title: "Orlando at Detroit: Points",
      sub_title: "ORL vs DET (May 3)",
      markets: [
        {
          ticker: "KXNBAPTS-26MAY03ORLDET-DETJDUREN0-20",
          title: "Jalen Duren: 20+ points",
          yes_sub_title: "Jalen Duren: 20+",
          no_sub_title: "Jalen Duren: 20+",
          status: "active",
          last_price_dollars: "0.1300",
          yes_bid_dollars: "0.1200",
          yes_ask_dollars: "0.1600",
          yes_bid_size_fp: "8.25",
          yes_ask_size_fp: "7.75",
          floor_strike: 20,
          liquidity_dollars: "123.45",
          open_interest_fp: "31.00",
          volume_24h: "14",
          volume_fp: "18.00",
          primary_participant_key: "basketball_player",
        },
      ],
    },
  },
  "KXNBATOTAL-26MAY03ORLDET": {
    event: {
      category: "Sports",
      event_ticker: "KXNBATOTAL-26MAY03ORLDET",
      series_ticker: "KXNBATOTAL",
      title: "Game 7: Orlando at Detroit: Total Points",
      sub_title: "ORL at DET (May 3)",
      markets: [
        {
          ticker: "KXNBATOTAL-26MAY03ORLDET-200",
          title: "Game 7: Orlando at Detroit: Total Points",
          yes_sub_title: "Over 200.5 points scored",
          no_sub_title: "Over 200.5 points scored",
          status: "active",
          last_price_dollars: "0.5400",
          yes_bid_dollars: "0.5200",
          yes_ask_dollars: "0.5600",
          floor_strike: 200.5,
          open_interest_fp: "44.00",
          volume_24h_fp: "22.00",
        },
      ],
    },
  },
  "KXNBAREB-26MAY03ORLDET": {
    event: {
      category: "Sports",
      event_ticker: "KXNBAREB-26MAY03ORLDET",
      series_ticker: "KXNBAREB",
      title: "Orlando at Detroit: Rebounds",
      sub_title: "ORL vs DET (May 3)",
      markets: [
        {
          ticker: "KXNBAREB-26MAY03ORLDET-DETJDUREN0-12",
          title: "Jalen Duren: 12+ rebounds",
          yes_sub_title: "Jalen Duren: 12+",
          no_sub_title: "Jalen Duren: 12+",
          status: "active",
          last_price_dollars: "0.4100",
          yes_bid_dollars: "0.3900",
          yes_ask_dollars: "0.4300",
          floor_strike: 12,
          open_interest: "27",
          volume_24h: "9",
        },
      ],
    },
  },
};

function buildFetchImpl() {
  return (async (input: string | URL) => {
    const url = typeof input === "string" ? new URL(input) : input;
    const match = url.pathname.match(/\/events\/([^/]+)$/);
    if (match && eventPayloads[match[1]]) {
      return {
        json: async () => eventPayloads[match[1]],
        ok: true,
        status: 200,
      } as unknown as Response;
    }

    return {
      json: async () => ({ error: { message: "not found" } }),
      ok: false,
      status: 404,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("kalshi direct adapter", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "signal-console-kalshi-direct-"));
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

  it("writes direct Kalshi NBA totals and player props into canonical market exports", async () => {
    seedGame();

    const result = await syncKalshiNbaDirect({
      eventTickers: ["KXNBAPTS-26MAY03ORLDET", "KXNBATOTAL-26MAY03ORLDET"],
      fetchImpl: buildFetchImpl(),
      now: () => new Date("2026-05-02T20:00:00.000Z"),
    });

    expect(result.ok).toBe(true);
    expect(result.gamesMatched).toBe(1);
    expect(result.eventsFetched).toBe(2);
    expect(result.sourceMarketsObserved).toBe(2);
    expect(result.quoteObservationsWritten).toBe(2);

    const rows = getDatabase()
      .prepare(
        `
          SELECT mi.family AS family,
                 mi.display_label AS displayLabel,
                 mi.participant_key AS participantKey,
                 mi.selection AS selection,
                 mi.line AS line,
                 sm.raw_family AS rawFamily,
                 qt.implied_probability AS impliedProbability,
                 qt.volume AS volume,
                 json_extract(sm.raw_metadata_json, '$.quoteVolumeSource') AS quoteVolumeSource
          FROM market_instruments mi
          JOIN source_markets sm ON sm.instrument_id = mi.id
          JOIN quote_ticks qt ON qt.source_market_id = sm.id
          ORDER BY mi.family ASC, mi.display_label ASC
        `
      )
      .all() as Array<{
      displayLabel: string;
      family: string;
      impliedProbability: number;
      line: number | null;
      participantKey: string | null;
      quoteVolumeSource: string | null;
      rawFamily: string;
      selection: string;
      volume: number | null;
    }>;

    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          family: "player-prop",
          line: 20,
          participantKey: "jalen-duren",
          quoteVolumeSource: "volume_fp",
          rawFamily: "points",
          selection: "over",
          volume: 18,
        }),
        expect.objectContaining({
          family: "total",
          line: 200.5,
          quoteVolumeSource: "volume_24h_fp",
          rawFamily: "total",
          selection: "over",
          volume: 22,
        }),
      ])
    );
    expect(rows[0]?.impliedProbability).toBeGreaterThan(0);

    const runs = listAdapterRuns(5) as Array<{
      captureMode: string;
      source: string;
      status: string;
    }>;
    expect(runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          captureMode: "live",
          source: "kalshi",
          status: "ok",
        }),
      ])
    );
  });

  it("records historical capture mode when direct Kalshi is run from backfill", async () => {
    seedGame();

    const result = await syncKalshiNbaDirect({
      captureMode: "historical",
      eventTickers: ["KXNBATOTAL-26MAY03ORLDET"],
      fetchImpl: buildFetchImpl(),
      now: () => new Date("2026-05-02T20:00:00.000Z"),
    });

    expect(result.ok).toBe(true);
    const runs = listAdapterRuns(5) as Array<{
      captureMode: string;
      source: string;
      status: string;
    }>;
    expect(runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          captureMode: "historical",
          source: "kalshi",
          status: "ok",
        }),
      ])
    );
  });

  it("falls back to legacy Kalshi volume fields when fixed-point fields are absent", async () => {
    seedGame();

    const result = await syncKalshiNbaDirect({
      eventTickers: ["KXNBAREB-26MAY03ORLDET"],
      fetchImpl: buildFetchImpl(),
      now: () => new Date("2026-05-02T20:00:00.000Z"),
    });

    expect(result.ok).toBe(true);
    const row = getDatabase()
      .prepare(
        `
          SELECT
            qt.volume AS volume,
            json_extract(sm.raw_metadata_json, '$.quoteVolumeSource') AS quoteVolumeSource
          FROM source_markets sm
          JOIN quote_ticks qt ON qt.source_market_id = sm.id
          WHERE sm.source_market_key = 'KXNBAREB-26MAY03ORLDET-DETJDUREN0-12'
        `
      )
      .get() as
      | {
          quoteVolumeSource: string | null;
          volume: number | null;
        }
      | undefined;

    expect(row).toMatchObject({
      quoteVolumeSource: "volume_24h",
      volume: 9,
    });
  });
});
