import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getDatabase,
  listAdapterRuns,
  recordGameStateObservation,
  resetDatabase,
  upsertGame,
  upsertGameOutcome,
} from "@signal-console/shared";

import { syncBet365Historical } from "../bet365-historical";

let tempDir = "";

describe("bet365 historical adapter", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "signal-console-bet365-historical-"));
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

  it("backfills settled Bet365 historical odds into canonical quote ticks with UTC-date tolerance", async () => {
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
      scheduledStart: "2026-05-10T00:00:00.000Z",
      sourceGameKeyNba: "0042500301",
      sport: "basketball",
    });

    recordGameStateObservation({
      awayScore: 69,
      capturedAt: "2026-05-10T02:55:00.000Z",
      clock: "00:15",
      finalAt: "2026-05-10T03:00:00.000Z",
      gameId: "nba-0042500301",
      homeScore: 83,
      isFinal: true,
      period: 4,
      startedAt: "2026-05-10T00:02:00.000Z",
      status: "final",
    });
    upsertGameOutcome({
      capturedAt: "2026-05-10T03:05:00.000Z",
      finalAwayScore: 69,
      finalHomeScore: 83,
      gameId: "nba-0042500301",
      winnerKey: "nyk",
    });

    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/historical/events")) {
        return {
          json: async () => [
            {
              away: "Cleveland Cavaliers",
              date: "2026-05-09T19:00:00Z",
              home: "New York Knicks",
              id: 70505048,
              league: { name: "USA - NBA", slug: "usa-nba" },
              sport: { name: "Basketball", slug: "basketball" },
              status: "settled",
            },
          ],
          ok: true,
          status: 200,
        };
      }

      if (url.pathname.endsWith("/historical/odds")) {
        return {
          json: async () => ({
            away: "Cleveland Cavaliers",
            bookmakerIds: { Bet365: "bet365-event-70505048" },
            bookmakers: {
              Bet365: [
                {
                  name: "ML",
                  odds: [{ away: "1.41", home: "2.95" }],
                  updatedAt: "2026-05-09T23:59:03.859Z",
                },
                {
                  name: "Points O/U",
                  odds: [
                    {
                      hdp: 12.5,
                      label: "Jarrett Allen (1) (12.5)",
                      over: "1.90",
                      under: "1.86",
                    },
                    {
                      hdp: 18.5,
                      label: "James Harden (1) (18.5)",
                      over: "1.86",
                      under: "1.90",
                    },
                  ],
                  updatedAt: "2026-05-09T23:59:03.859Z",
                },
              ],
            },
            date: "2026-05-09T19:00:00Z",
            home: "New York Knicks",
            id: 70505048,
            league: { name: "USA - NBA", slug: "usa-nba" },
            sport: { name: "Basketball", slug: "basketball" },
            status: "settled",
            urls: { Bet365: "https://example.com/bet365/event-70505048" },
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

    const summary = await syncBet365Historical({
      apiKey: "odds-key",
      dateFrom: "2026-05-09",
      dateTo: "2026-05-10",
      fetchImpl,
      now: () => new Date("2026-05-20T05:00:00.000Z"),
    });

    expect(summary.ok).toBe(true);
    expect(summary.gamesMatched).toBe(1);
    expect(summary.sourceMarketsObserved).toBeGreaterThan(0);
    expect(summary.quoteObservationsWritten).toBeGreaterThan(0);

    const db = getDatabase();
    const sourceCounts = db
      .prepare(
        `SELECT
           COUNT(*) AS quotes
         FROM quote_ticks qt
         JOIN source_markets sm ON sm.id = qt.source_market_id
         WHERE sm.game_id = ?
           AND sm.source = 'bet365'`
      )
      .get("nba-0042500301") as { quotes: number } | undefined;
    expect(sourceCounts?.quotes ?? 0).toBeGreaterThan(0);

    const markets = db
      .prepare(
        `SELECT raw_label AS rawLabel
         FROM source_markets
         WHERE game_id = ?
           AND source = 'bet365'
         ORDER BY raw_label ASC`
      )
      .all("nba-0042500301") as Array<{ rawLabel: string | null }>;
    expect(markets.map((row) => row.rawLabel)).toEqual(
      expect.arrayContaining([
        "Cleveland Cavaliers",
        "Jarrett Allen (1) (12.5)",
      ])
    );

    const bet365HistoricalRuns = listAdapterRuns() as Array<{
      captureMode?: string;
      source: string;
      status: string;
    }>;
    expect(
      bet365HistoricalRuns.filter(
        (run) => run.source === "bet365" && run.captureMode === "historical"
      )
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "ok",
        }),
      ])
    );
  });
});
