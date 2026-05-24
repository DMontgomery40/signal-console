import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getDatabase,
  recordGameStateObservation,
  resetDatabase,
  upsertGame,
} from "@signal-console/shared";

import { syncPolymarketNbaHistorical } from "../polymarket-historical";

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

function seedConferenceFinalsGame() {
  upsertGame({
    awayParticipant: {
      abbreviation: "CLE",
      key: "cle",
      name: "Cleveland Cavaliers",
      shortName: "Cavaliers",
      side: "away",
    },
    homeParticipant: {
      abbreviation: "NYK",
      key: "nyk",
      name: "New York Knicks",
      shortName: "Knicks",
      side: "home",
    },
    id: "nba-0042500301",
    league: "NBA",
    scheduledStart: "2026-05-20T00:00:00.000Z",
    sourceGameKeyNba: "0042500301",
    sport: "basketball",
  });

  recordGameStateObservation({
    awayScore: 83,
    capturedAt: "2026-05-20T02:00:00.000Z",
    clock: null,
    finalAt: "2026-05-20T03:00:00.000Z",
    gameId: "nba-0042500301",
    homeScore: 69,
    isFinal: true,
    period: 4,
    startedAt: "2026-05-20T00:00:00.000Z",
    status: "final",
  });
}

const closedEventsPayload = [
  {
    eventDate: "2026-04-22",
    id: "391579",
    markets: [
      {
        clobTokenIds: '["tok-phx","tok-okc"]',
        id: "2012792",
        line: null,
        outcomes: '["Suns","Thunder"]',
        outcomePrices: '["0","1"]',
        question: "Suns vs. Thunder",
        slug: "nba-phx-okc-2026-04-22",
        sportsMarketType: "moneyline",
        volume: "12345",
      },
      {
        clobTokenIds: '["tok-prop-yes","tok-prop-no"]',
        id: "2050555",
        line: 24.5,
        outcomes: '["Yes","No"]',
        outcomePrices: '["0.55","0.45"]',
        question: "Devin Booker: Points O/U 24.5",
        slug: "nba-phx-okc-2026-04-22-points-devin-booker-24pt5",
        sportsMarketType: "points",
      },
    ],
    slug: "nba-phx-okc-2026-04-22",
    startTime: "2026-04-22T23:30:00Z",
    teams: [
      { abbreviation: "phx", id: 100518, name: "Suns" },
      { abbreviation: "okc", id: 100517, name: "Thunder" },
    ],
    title: "Suns vs. Thunder",
  },
];

const pricesHistoryByToken: Record<string, Array<{ t: number; p: number }>> = {
  "tok-phx": [
    { t: 1776816000, p: 0.45 },
    { t: 1776816060, p: 0.38 },
    { t: 1776816120, p: 0.21 },
  ],
  "tok-okc": [
    { t: 1776816000, p: 0.55 },
    { t: 1776816060, p: 0.62 },
    { t: 1776816120, p: 0.79 },
  ],
  "tok-prop-yes": [
    { t: 1776816000, p: 0.55 },
    { t: 1776816060, p: 0.58 },
  ],
  "tok-prop-no": [
    { t: 1776816000, p: 0.45 },
    { t: 1776816060, p: 0.42 },
  ],
};

function buildFetchImpl() {
  return (async (input: string | URL) => {
    const url = typeof input === "string" ? new URL(input) : input;
    if (url.pathname.endsWith("/events")) {
      return {
        json: async () => closedEventsPayload,
        ok: true,
        status: 200,
      } as unknown as Response;
    }
    if (url.pathname.endsWith("/prices-history")) {
      const token = url.searchParams.get("market") ?? "";
      return {
        json: async () => ({ history: pricesHistoryByToken[token] ?? [] }),
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

function buildFetchImplWithPayload(
  eventsPayload: unknown,
  pricesHistory: Record<string, Array<{ t: number; p: number }>>
) {
  return (async (input: string | URL) => {
    const url = typeof input === "string" ? new URL(input) : input;
    if (url.pathname.endsWith("/events")) {
      return {
        json: async () => eventsPayload,
        ok: true,
        status: 200,
      } as unknown as Response;
    }
    if (url.pathname.endsWith("/prices-history")) {
      const token = url.searchParams.get("market") ?? "";
      return {
        json: async () => ({ history: pricesHistory[token] ?? [] }),
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

describe("polymarket historical adapter", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "signal-console-pm-hist-"));
    process.env.SIGNAL_CONSOLE_DB_PATH = join(tempDir, "signal-console.sqlite");
    resetDatabase();
  });

  afterEach(() => {
    resetDatabase();
    delete process.env.SIGNAL_CONSOLE_DB_PATH;
    if (tempDir) rmSync(tempDir, { force: true, recursive: true });
  });

  it("ingests both sides of moneyline and player-prop markets", async () => {
    seedPastGame();

    const run = await syncPolymarketNbaHistorical({
      fetchImpl: buildFetchImpl(),
      fidelityMinutes: 1,
      now: () => new Date("2026-04-23T12:00:00.000Z"),
    });

    expect(run.ok).toBe(true);
    expect(run.gamesMatched).toBe(1);
    expect(run.marketsConsidered).toBe(2);
    expect(run.pointsFetched).toBe(10);
    expect(run.ticksWritten).toBe(10);

    const db = getDatabase();
    const rows = db
      .prepare(
        `
          SELECT sm.source_market_key AS sourceMarketKey,
                 sm.source_selection_key AS participantKey,
                 q.captured_at AS capturedAt,
                 q.implied_probability AS p
          FROM quote_ticks q
          JOIN source_markets sm ON sm.id = q.source_market_id
          JOIN market_instruments mi ON mi.id = sm.instrument_id
          WHERE sm.source = 'polymarket'
            AND mi.family = 'moneyline'
          ORDER BY q.captured_at ASC, participantKey ASC
        `
      )
      .all() as Array<{
      capturedAt: string;
      p: number;
      participantKey: string;
      sourceMarketKey: string;
    }>;

    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((row) => row.participantKey))).toEqual(
      new Set(["phx", "okc"])
    );
    const phx = rows.filter((row) => row.participantKey === "phx");
    expect(phx.map((row) => Number(row.p.toFixed(2)))).toEqual([
      0.45, 0.38, 0.21,
    ]);

    const props = db
      .prepare(
        `
          SELECT mi.display_label AS displayLabel,
                 mi.family,
                 mi.line,
                 mi.participant_key AS participantKey,
                 mi.selection,
                 q.implied_probability AS p
          FROM quote_ticks q
          JOIN source_markets sm ON sm.id = q.source_market_id
          JOIN market_instruments mi ON mi.id = sm.instrument_id
          WHERE mi.family = 'player-prop'
          ORDER BY mi.selection ASC, q.captured_at ASC
        `
      )
      .all() as Array<{
      displayLabel: string;
      family: string;
      line: number;
      p: number;
      participantKey: string;
      selection: string;
    }>;

    expect(props).toHaveLength(4);
    expect(props).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          displayLabel: "Devin Booker points over 24.5",
          family: "player-prop",
          line: 24.5,
          participantKey: "devin-booker",
          selection: "over",
        }),
        expect.objectContaining({
          displayLabel: "Devin Booker points under 24.5",
          family: "player-prop",
          line: 24.5,
          participantKey: "devin-booker",
          selection: "under",
        }),
      ])
    );
  });

  it("is idempotent across reruns", async () => {
    seedPastGame();

    await syncPolymarketNbaHistorical({
      fetchImpl: buildFetchImpl(),
      fidelityMinutes: 1,
      now: () => new Date("2026-04-23T12:00:00.000Z"),
    });
    const second = await syncPolymarketNbaHistorical({
      fetchImpl: buildFetchImpl(),
      fidelityMinutes: 1,
      now: () => new Date("2026-04-24T12:00:00.000Z"),
    });

    expect(second.pointsFetched).toBe(10);
    expect(second.ticksWritten).toBe(0);

    const db = getDatabase();
    const total = (
      db
        .prepare(
          `
            SELECT COUNT(*) AS total
            FROM quote_ticks q
            JOIN source_markets sm ON sm.id = q.source_market_id
            WHERE sm.source = 'polymarket'
          `
        )
        .get() as { total: number }
    ).total;
    expect(total).toBe(10);
  });

  it("matches closed events by UTC start date when eventDate is one day earlier", async () => {
    seedConferenceFinalsGame();

    const run = await syncPolymarketNbaHistorical({
      fetchImpl: buildFetchImplWithPayload(
        [
          {
            eventDate: "2026-05-19",
            id: "cle-nyk-closed",
            markets: [
              {
                clobTokenIds: '["tok-cle","tok-nyk"]',
                id: "pm-cle-nyk-moneyline",
                line: null,
                outcomes: '["Cavaliers","Knicks"]',
                question: "Cavaliers vs. Knicks",
                slug: "nba-cle-nyk-2026-05-19",
                sportsMarketType: "moneyline",
                volume: "123456",
              },
            ],
            slug: "nba-cle-nyk-2026-05-19",
            startTime: "2026-05-20T00:00:00Z",
            teams: [
              { abbreviation: "CLE", id: 1, name: "Cavaliers" },
              { abbreviation: "NYK", id: 2, name: "Knicks" },
            ],
            title: "Cavaliers vs. Knicks",
          },
        ],
        {
          "tok-cle": [
            { t: 1779235200, p: 0.74 },
            { t: 1779235260, p: 0.81 },
          ],
          "tok-nyk": [
            { t: 1779235200, p: 0.26 },
            { t: 1779235260, p: 0.19 },
          ],
        }
      ),
      fidelityMinutes: 1,
      now: () => new Date("2026-05-20T12:00:00.000Z"),
      since: "2026-05-20",
    });

    expect(run.gamesMatched).toBe(1);
    expect(run.ticksWritten).toBe(4);

    const total = (
      getDatabase()
        .prepare(
          `
            SELECT COUNT(*) AS total
            FROM quote_ticks q
            JOIN source_markets sm ON sm.id = q.source_market_id
            WHERE sm.source = 'polymarket'
              AND sm.game_id = 'nba-0042500301'
          `
        )
        .get() as { total: number }
    ).total;
    expect(total).toBe(4);
  });
});
