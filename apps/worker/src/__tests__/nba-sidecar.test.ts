import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getDatabase,
  getResearchGame,
  listAdapterRuns,
  resetDatabase,
} from "@signal-console/shared";

import {
  buildNbaSidecarDateWindow,
  buildNbaSidecarUrl,
  fetchNbaSidecarScoreboard,
  ingestNbaSidecarScoreboard,
  syncNbaSidecarScoreboard,
  syncNbaSidecarWindow,
} from "../nba-sidecar";

let tempDir = "";

const scoreboardPayload = {
  games: [
    {
      game: {
        awayParticipant: {
          abbreviation: "NYK",
          key: "nyk",
          name: "New York Knicks",
          shortName: "Knicks",
          side: "away" as const,
        },
        homeParticipant: {
          abbreviation: "BOS",
          key: "bos",
          name: "Boston Celtics",
          shortName: "Celtics",
          side: "home" as const,
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
        finalAt: null,
        homeScore: 112,
        isFinal: false,
        period: 4,
        startedAt: "2026-04-22T02:03:00.000Z",
        status: "in-play" as const,
      },
      outcome: null,
    },
  ],
  generatedAt: "2026-04-22T05:55:00.000Z",
  requestedDate: "2026-04-22",
};

describe("nba sidecar worker integration", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "signal-console-worker-"));
    process.env.SIGNAL_CONSOLE_DB_PATH = join(tempDir, "signal-console.sqlite");
    resetDatabase();
  });

  afterEach(() => {
    resetDatabase();
    delete process.env.SIGNAL_CONSOLE_DB_PATH;
    delete process.env.NBA_SIDECAR_BASE_URL;
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("builds a stable sidecar URL with query params", () => {
    expect(
      buildNbaSidecarUrl("http://127.0.0.1:9393/", "/api/v1/scoreboard", {
        date: "2026-04-22",
      })
    ).toBe("http://127.0.0.1:9393/api/v1/scoreboard?date=2026-04-22");
  });

  it("builds a sidecar date window that covers lookback and lookahead days", () => {
    expect(
      buildNbaSidecarDateWindow({
        lookaheadDays: 2,
        lookbackDays: 1,
        now: () => new Date("2026-04-22T06:00:00.000Z"),
      })
    ).toEqual(["2026-04-21", "2026-04-22", "2026-04-23", "2026-04-24"]);
  });

  it("fetches a normalized scoreboard payload from the sidecar", async () => {
    const fetchImpl = vi.fn(async () => ({
      json: async () => ({
        data: scoreboardPayload,
      }),
      ok: true,
      status: 200,
    }));

    const payload = await fetchNbaSidecarScoreboard({
      baseUrl: "http://127.0.0.1:9393",
      fetchImpl: fetchImpl as never,
    });

    expect(payload.games).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:9393/api/v1/scoreboard"
    );
  });

  it("ingests sidecar scoreboard games into the live research store", () => {
    const result = ingestNbaSidecarScoreboard(scoreboardPayload);

    expect(result).toEqual({
      gamesSeen: 1,
      outcomesWritten: 0,
      statesWritten: 1,
    });
    expect(getResearchGame("nba-0022600001")).toMatchObject({
      game: expect.objectContaining({
        id: "nba-0022600001",
      }),
      gameState: expect.objectContaining({
        status: "in-play",
      }),
    });
  });

  it("records adapter runs for successful sidecar syncs", async () => {
    await syncNbaSidecarScoreboard({
      baseUrl: "http://127.0.0.1:9393",
      fetchImpl: (async () => ({
        json: async () => ({
          data: scoreboardPayload,
        }),
        ok: true,
        status: 200,
      })) as never,
      now: () => new Date("2026-04-22T06:00:00.000Z"),
    });

    expect(listAdapterRuns(5)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recordsSeen: 1,
          source: "nba",
          status: "ok",
        }),
      ])
    );
  });

  it("syncs a scoreboard window across recent and upcoming dates", async () => {
    await syncNbaSidecarWindow({
      baseUrl: "http://127.0.0.1:9393",
      fetchImpl: (async (url: string) => {
        if (url.includes("/play-by-play")) {
          return {
            json: async () => ({
              data: {
                actions: [
                  {
                    actionNumber: 1,
                    actionType: "rebound",
                    clock: "PT05M07.00S",
                    description: "TEAM offensive REBOUND",
                    period: 2,
                    scoreAway: "46",
                    scoreHome: "31",
                    teamTricode: "CLE",
                    timeActual: "2026-05-18T01:04:20.400Z",
                  },
                ],
                gameId: "0022600001",
                generatedAt: "2026-04-22T06:00:00.000Z",
              },
            }),
            ok: true,
            status: 200,
          };
        }
        return {
          json: async () => ({
            data: {
              ...scoreboardPayload,
              requestedDate: new URL(url).searchParams.get("date"),
            },
          }),
          ok: true,
          status: 200,
        };
      }) as never,
      lookaheadDays: 1,
      lookbackDays: 1,
      now: () => new Date("2026-04-22T06:00:00.000Z"),
    });

    expect(listAdapterRuns(5)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recordsSeen: 3,
          source: "nba",
          status: "ok",
        }),
      ])
    );

    expect(
      getDatabase()
        .prepare(
          "SELECT COUNT(*) AS count FROM nba_play_by_play_actions WHERE game_id = ?"
        )
        .get("nba-0022600001")
    ).toEqual({ count: 1 });
  });

  it("derives a final game state and outcome from official play-by-play when scoreboard is still scheduled", async () => {
    await syncNbaSidecarWindow({
      baseUrl: "http://127.0.0.1:9393",
      fetchImpl: (async (url: string) => {
        if (url.includes("/play-by-play")) {
          return {
            json: async () => ({
              data: {
                actions: [
                  {
                    actionNumber: 711,
                    actionType: "period",
                    clock: "PT00M00.00S",
                    description: "Period End",
                    period: 4,
                    scoreAway: "109",
                    scoreHome: "116",
                    teamTricode: null,
                    timeActual: "2026-04-30T01:42:41.0Z",
                  },
                  {
                    actionNumber: 712,
                    actionType: "game",
                    clock: "PT00M00.00S",
                    description: "Game End",
                    period: 4,
                    scoreAway: "109",
                    scoreHome: "116",
                    teamTricode: null,
                    timeActual: "2026-04-30T01:42:42.6Z",
                  },
                ],
                gameId: "0022600001",
                generatedAt: "2026-04-30T01:45:00.000Z",
              },
            }),
            ok: true,
            status: 200,
          };
        }
        return {
          json: async () => ({
            data: {
              generatedAt: "2026-04-30T01:45:00.000Z",
              requestedDate: "2026-04-29",
              games: [
                {
                  ...scoreboardPayload.games[0],
                  game: {
                    ...scoreboardPayload.games[0].game,
                    id: "nba-0042500105",
                    sourceGameKeyNba: "0042500105",
                  },
                  gameState: {
                    awayScore: null,
                    capturedAt: "2026-04-30T01:45:00.000Z",
                    clock: null,
                    finalAt: null,
                    homeScore: null,
                    isFinal: false,
                    period: 0,
                    startedAt: null,
                    status: "scheduled",
                  },
                  outcome: null,
                },
              ],
            },
          }),
          ok: true,
          status: 200,
        };
      }) as never,
      lookaheadDays: 0,
      lookbackDays: 0,
      now: () => new Date("2026-04-30T02:00:00.000Z"),
    });

    expect(getResearchGame("nba-0042500105")).toMatchObject({
      gameState: expect.objectContaining({
        awayScore: 109,
        homeScore: 116,
        isFinal: true,
        status: "final",
      }),
      outcome: expect.objectContaining({
        finalAwayScore: 109,
        finalHomeScore: 116,
        winnerKey: "bos",
      }),
    });
  });

  it("reports partial failure when scoreboard sync succeeds but play-by-play hydration fails", async () => {
    const summary = await syncNbaSidecarWindow({
      baseUrl: "http://127.0.0.1:9393",
      fetchImpl: (async (url: string) => {
        if (url.includes("/play-by-play")) {
          return {
            json: async () => ({ error: "offline" }),
            ok: false,
            status: 503,
          };
        }
        return {
          json: async () => ({
            data: {
              ...scoreboardPayload,
              requestedDate: new URL(url).searchParams.get("date"),
            },
          }),
          ok: true,
          status: 200,
        };
      }) as never,
      lookaheadDays: 0,
      lookbackDays: 0,
      now: () => new Date("2026-04-22T06:00:00.000Z"),
    });

    expect(summary.ok).toBe(false);
    expect(summary.dateErrors).toEqual([
      expect.objectContaining({
        date: "2026-04-22",
        error: expect.stringContaining("play-by-play 0022600001"),
      }),
    ]);
    expect(listAdapterRuns(5)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recordsSeen: 1,
          source: "nba",
          status: "error",
        }),
      ])
    );
  });

  it("fails honestly when every sidecar date in the window fails", async () => {
    await expect(
      syncNbaSidecarWindow({
        baseUrl: "http://127.0.0.1:9393",
        fetchImpl: (async () => ({
          json: async () => ({ error: "offline" }),
          ok: false,
          status: 503,
        })) as never,
        lookaheadDays: 0,
        lookbackDays: 0,
        now: () => new Date("2026-04-22T06:00:00.000Z"),
      })
    ).rejects.toThrow("failed for every requested date");

    expect(listAdapterRuns(5)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "nba",
          status: "error",
        }),
      ])
    );
  });
});
