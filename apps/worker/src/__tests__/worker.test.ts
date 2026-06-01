import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KALSHI_NBA_HISTORICAL_PERIOD_INTERVAL_MINUTES } from "@signal-console/adapters";
import {
  createAppLogger,
  enqueueMarketBackfill,
  enqueueResearchExport,
  getDatabase,
  resetDatabase,
  upsertGame,
} from "@signal-console/shared";

import {
  buildWorkerHeartbeatSummary,
  calculateBackoffDelay,
  executeResearchExport,
  mapExportArgs,
  runWorkerCycle,
  type SpawnProcessFn,
} from "../index";
import { writeHeartbeatJson } from "../heartbeat-emitter";

/** A minimal fake child process: an EventEmitter with a stderr emitter. */
function makeFakeChild(): EventEmitter & { stderr: EventEmitter } {
  const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
  child.stderr = new EventEmitter();
  return child;
}

let tempDir = "";

describe("worker runtime", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "signal-console-worker-runtime-"));
    process.env.SIGNAL_CONSOLE_DB_PATH = join(tempDir, "signal-console.sqlite");
    resetDatabase();
  });

  afterEach(() => {
    resetDatabase();
    delete process.env.KALSHI_LIVE_LOOKBACK_DAYS;
    delete process.env.KALSHI_LIVE_MAX_EVENTS;
    delete process.env.BET365_RATE_LIMIT_COOLDOWN_MS;
    delete process.env.NBA_SIDECAR_LOOKAHEAD_DAYS;
    delete process.env.NBA_SIDECAR_LOOKBACK_DAYS;
    delete process.env.KALSHI_API_KEY;
    delete process.env.NBA_SIDECAR_BASE_URL;
    delete process.env.ODDS_API_IO_KEY;
    delete process.env.ODDS_API_KEY;
    delete process.env.POLYMARKET_TRADES_LOOKBACK_MINUTES;
    delete process.env.POLYMARKET_TRADES_MAX_MARKETS;
    delete process.env.SIGNAL_CONSOLE_DB_PATH;
    delete process.env.WORKER_INTERVAL_MS;
    delete process.env.WORKER_MAX_BACKOFF_MS;
    if (tempDir) {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("builds a persistence-aware heartbeat summary for the live worker", () => {
    const summary = buildWorkerHeartbeatSummary({
      nbaSidecarConfigured: false,
      now: () => new Date("2026-04-21T19:00:00.000Z"),
    });

    expect(summary.capturedAt).toBe("2026-04-21T19:00:00.000Z");
    expect(summary.bet365GamesMatched).toBe(0);
    expect(summary.bet365SourceMarketsObserved).toBe(0);
    expect(summary.database.status).toBe("ok");
    expect(summary.kalshiGamesMatched).toBe(0);
    expect(summary.kalshiSourceMarketsObserved).toBe(0);
    expect(summary.nbaGamesObserved).toBe(0);
    expect(summary.nbaSidecarConfigured).toBe(false);
    expect(summary.nbaSidecarLastSyncAt).toBeNull();
    expect(summary.polymarketGamesMatched).toBe(0);
    expect(summary.polymarketSourceMarketsObserved).toBe(0);
    expect(summary.providerFailures).toEqual([]);
  });

  it("isolates cycle failures and applies exponential backoff instead of crashing the worker", async () => {
    process.env.NBA_SIDECAR_BASE_URL = "http://127.0.0.1:9393";

    const result = await runWorkerCycle({
      consecutiveFailures: 1,
      intervalMs: 1_000,
      logger: createAppLogger({ test: "worker" }),
      maxBackoffMs: 4_000,
      syncNbaSidecar: (() => {
        throw new Error("boom");
      }) as never,
      syncPolymarket: (async () => ({
        finishedAt: "2026-04-22T06:00:00.000Z",
        gamesMatched: 0,
        marketsSeen: 0,
        ok: true as const,
        quoteObservationsWritten: 0,
        rawPayloadsWritten: 0,
        recordsSeen: 0,
        recordsWritten: 0,
        sourceMarketsObserved: 0,
        startedAt: "2026-04-22T06:00:00.000Z",
      })) as never,
    });

    expect(result.ok).toBe(false);
    expect(result.nextDelayMs).toBe(4_000);
  });

  it("runs the NBA sidecar sync before emitting the heartbeat when configured", async () => {
    process.env.NBA_SIDECAR_BASE_URL = "http://127.0.0.1:9393";
    process.env.ODDS_API_KEY = "odds-key";
    process.env.KALSHI_API_KEY = "kalshi-key";

    const syncNbaSidecar = vi.fn(async () => ({
      dateErrors: [] as Array<{ date: string; error: string }>,
      datesSynced: ["2026-04-21", "2026-04-22", "2026-04-23"],
      finishedAt: "2026-04-22T06:00:00.000Z",
      gamesSeen: 3,
      ok: true as const,
      outcomesWritten: 1,
      playByPlayActionsWritten: 2,
      startedAt: "2026-04-22T06:00:00.000Z",
      statesWritten: 3,
    }));
    const syncBet365 = vi.fn(async () => ({
      bookmaker: "Bet365" as const,
      finishedAt: "2026-04-22T06:00:00.000Z",
      gamesMatched: 2,
      marketsSeen: 3,
      ok: true as const,
      quoteObservationsWritten: 6,
      rawPayloadsWritten: 6,
      recordsSeen: 6,
      recordsWritten: 18,
      source: "bet365" as const,
      sourceMarketsObserved: 6,
      startedAt: "2026-04-22T06:00:00.000Z",
    }));
    const syncKalshi = vi.fn(async () => ({
      bookmaker: "Kalshi" as const,
      eventsFetched: 2,
      eventsSeen: 2,
      finishedAt: "2026-04-22T06:00:00.000Z",
      gamesMatched: 1,
      marketErrors: [],
      marketsSeen: 2,
      milestonesSeen: 1,
      ok: true as const,
      quoteObservationsWritten: 4,
      rawPayloadsWritten: 4,
      recordsSeen: 4,
      recordsWritten: 12,
      source: "kalshi" as const,
      sourceMarketsObserved: 4,
      startedAt: "2026-04-22T06:00:00.000Z",
      unmatchedEventTickers: [],
    }));
    const syncPolymarket = vi.fn(async () => ({
      finishedAt: "2026-04-22T06:00:00.000Z",
      gamesMatched: 2,
      marketsSeen: 6,
      ok: true as const,
      quoteObservationsWritten: 12,
      rawPayloadsWritten: 12,
      recordsSeen: 12,
      recordsWritten: 36,
      sourceMarketsObserved: 12,
      startedAt: "2026-04-22T06:00:00.000Z",
    }));

    const result = await runWorkerCycle({
      logger: createAppLogger({ test: "worker" }),
      now: () => new Date("2026-04-22T06:00:00.000Z"),
      syncBet365,
      syncKalshi,
      syncNbaSidecar,
      syncPolymarket,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.bet365GamesMatched).toBe(2);
      expect(result.summary.bet365SourceMarketsObserved).toBe(6);
      expect(result.summary.kalshiGamesMatched).toBe(1);
      expect(result.summary.kalshiSourceMarketsObserved).toBe(4);
      expect(result.summary.nbaGamesObserved).toBe(3);
      expect(result.summary.nbaSidecarConfigured).toBe(true);
      expect(result.summary.nbaSidecarLastSyncAt).toBe("2026-04-22T06:00:00.000Z");
      expect(result.summary.polymarketGamesMatched).toBe(2);
      expect(result.summary.polymarketSourceMarketsObserved).toBe(12);
    }
    expect(syncBet365).toHaveBeenCalledOnce();
    expect(syncKalshi).toHaveBeenCalledOnce();
    expect(syncKalshi).toHaveBeenCalledWith(
      expect.objectContaining({
        maxEvents: 200,
        minimumStartDate: "2026-04-20",
      }),
    );
    expect(syncNbaSidecar).toHaveBeenCalledOnce();
    expect(syncPolymarket).toHaveBeenCalledOnce();
  });

  it("does not synthesize nba-sidecar freshness when the sidecar is disabled", () => {
    const outPath = join(tempDir, "heartbeat-disabled.json");

    writeHeartbeatJson({
      nbaSidecarConfigured: false,
      outPath,
    });

    const parsed = JSON.parse(readFileSync(outPath, "utf8")) as {
      sources?: Record<string, unknown>;
    };
    expect(parsed.sources?.["nba-sidecar"]).toBeUndefined();
  });

  it("writes nba-sidecar freshness only from the observed sidecar sync time", () => {
    const outPath = join(tempDir, "heartbeat-sidecar.json");

    writeHeartbeatJson({
      nbaSidecarConfigured: true,
      nbaSidecarLastSyncAt: "2026-04-22T06:00:00.000Z",
      outPath,
    });

    const parsed = JSON.parse(readFileSync(outPath, "utf8")) as {
      sources?: Record<string, { lastSyncAt?: string | null }>;
    };
    expect(parsed.sources?.["nba-sidecar"]?.lastSyncAt).toBe("2026-04-22T06:00:00.000Z");
  });

  it("keeps later market providers running when bet365 is rate-limited", async () => {
    process.env.ODDS_API_KEY = "odds-key";
    process.env.KALSHI_API_KEY = "kalshi-key";

    const syncBet365 = vi.fn(async () => {
      throw new Error("Odds-API events request for Bet365 failed with status 429.");
    });
    const syncKalshi = vi.fn(async () => ({
      bookmaker: "Kalshi" as const,
      eventsFetched: 2,
      eventsSeen: 2,
      finishedAt: "2026-04-22T06:00:00.000Z",
      gamesMatched: 1,
      marketErrors: [],
      marketsSeen: 2,
      milestonesSeen: 1,
      ok: true as const,
      quoteObservationsWritten: 4,
      rawPayloadsWritten: 4,
      recordsSeen: 4,
      recordsWritten: 12,
      source: "kalshi" as const,
      sourceMarketsObserved: 4,
      startedAt: "2026-04-22T06:00:00.000Z",
      unmatchedEventTickers: [],
    }));
    const syncPolymarket = vi.fn(async () => ({
      finishedAt: "2026-04-22T06:00:00.000Z",
      gamesMatched: 2,
      marketsSeen: 6,
      ok: true as const,
      quoteObservationsWritten: 12,
      rawPayloadsWritten: 12,
      recordsSeen: 12,
      recordsWritten: 36,
      sourceMarketsObserved: 12,
      startedAt: "2026-04-22T06:00:00.000Z",
    }));

    const result = await runWorkerCycle({
      logger: createAppLogger({ test: "worker" }),
      now: () => new Date("2026-04-22T06:00:00.000Z"),
      syncBet365: syncBet365 as never,
      syncKalshi,
      syncPolymarket,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.providerFailures).toHaveLength(1);
      expect(result.summary.providerFailures[0]?.source).toBe("bet365");
      expect(result.summary.kalshiSourceMarketsObserved).toBe(4);
      expect(result.summary.polymarketSourceMarketsObserved).toBe(12);
    }
    expect(syncBet365).toHaveBeenCalledOnce();
    expect(syncKalshi).toHaveBeenCalledOnce();
    expect(syncKalshi).toHaveBeenCalledWith(
      expect.objectContaining({
        maxEvents: 200,
        minimumStartDate: "2026-04-20",
      }),
    );
    expect(syncPolymarket).toHaveBeenCalledOnce();
  });

  it("backs off Bet365 after a rate limit without stopping other providers", async () => {
    process.env.ODDS_API_KEY = "odds-key";
    process.env.BET365_RATE_LIMIT_COOLDOWN_MS = "120000";
    const providerCooldowns = {};

    const syncBet365 = vi.fn(async () => {
      throw new Error("Odds-API events request for Bet365 failed with status 429.");
    });
    const syncPolymarket = vi.fn(async () => ({
      finishedAt: "2026-04-22T06:00:00.000Z",
      gamesMatched: 2,
      marketsSeen: 6,
      ok: true as const,
      quoteObservationsWritten: 12,
      rawPayloadsWritten: 12,
      recordsSeen: 12,
      recordsWritten: 36,
      sourceMarketsObserved: 12,
      startedAt: "2026-04-22T06:00:00.000Z",
    }));

    const first = await runWorkerCycle({
      logger: createAppLogger({ test: "worker" }),
      now: () => new Date("2026-04-22T06:00:00.000Z"),
      providerCooldowns,
      syncBet365: syncBet365 as never,
      syncPolymarket,
    });
    const second = await runWorkerCycle({
      logger: createAppLogger({ test: "worker" }),
      now: () => new Date("2026-04-22T06:01:00.000Z"),
      providerCooldowns,
      syncBet365: syncBet365 as never,
      syncPolymarket,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.summary.providerFailures).toHaveLength(1);
      expect(second.summary.providerFailures).toEqual([]);
    }
    expect(syncBet365).toHaveBeenCalledOnce();
    expect(syncPolymarket).toHaveBeenCalledTimes(2);
  });

  it("preserves worker backoff when every attempted market provider fails", async () => {
    process.env.ODDS_API_KEY = "odds-key";
    process.env.KALSHI_API_KEY = "kalshi-key";

    const syncBet365 = vi.fn(async () => {
      throw new Error("bet365 unavailable");
    });
    const syncKalshi = vi.fn(async () => {
      throw new Error("kalshi unavailable");
    });
    const syncPolymarket = vi.fn(async () => {
      throw new Error("polymarket unavailable");
    });

    const result = await runWorkerCycle({
      consecutiveFailures: 2,
      intervalMs: 1_000,
      logger: createAppLogger({ test: "worker" }),
      maxBackoffMs: 8_000,
      now: () => new Date("2026-04-22T06:00:00.000Z"),
      syncBet365: syncBet365 as never,
      syncKalshi,
      syncPolymarket,
    });

    expect(result.ok).toBe(false);
    expect(result.nextDelayMs).toBe(8_000);
    expect(syncBet365).toHaveBeenCalledOnce();
    expect(syncKalshi).toHaveBeenCalledOnce();
    expect(syncPolymarket).toHaveBeenCalledOnce();
  });

  it("surfaces Polymarket trade sync failures in the heartbeat", async () => {
    const syncPolymarket = vi.fn(async () => ({
      finishedAt: "2026-04-22T06:00:00.000Z",
      gamesMatched: 1,
      marketsSeen: 1,
      ok: true as const,
      quoteObservationsWritten: 0,
      rawPayloadsWritten: 0,
      recordsSeen: 1,
      recordsWritten: 1,
      sourceMarketsObserved: 2,
      startedAt: "2026-04-22T06:00:00.000Z",
    }));
    const syncPolymarketTrades = vi.fn(async () => {
      throw new Error("data api unavailable");
    });

    const result = await runWorkerCycle({
      intervalMs: 1_000,
      logger: createAppLogger({ test: "worker" }),
      now: () => new Date("2026-04-22T06:00:00.000Z"),
      syncPolymarket,
      syncPolymarketTrades: syncPolymarketTrades as never,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.providerFailures).toEqual([
        expect.objectContaining({
          source: "polymarket",
        }),
      ]);
    }
    expect(syncPolymarketTrades).toHaveBeenCalledOnce();
  });

  it("claims queued market backfills and marks them completed", async () => {
    enqueueMarketBackfill({
      payloadJson: {
        dateFrom: "2026-04-25",
        dateTo: "2026-05-20",
        source: "polymarket",
      },
      scope: "polymarket",
    });

    const executeMarketsBackfill = vi.fn(async () => {});
    const syncPolymarket = vi.fn(async () => ({
      finishedAt: "2026-04-22T06:00:00.000Z",
      gamesMatched: 0,
      marketsSeen: 0,
      ok: true as const,
      quoteObservationsWritten: 0,
      rawPayloadsWritten: 0,
      recordsSeen: 0,
      recordsWritten: 0,
      sourceMarketsObserved: 0,
      startedAt: "2026-04-22T06:00:00.000Z",
    }));
    const syncPolymarketTrades = vi.fn(async () => ({
      errors: [],
      eventsFetched: 0,
      finishedAt: "2026-04-22T06:00:00.000Z",
      marketsScanned: 0,
      ok: true as const,
      source: "polymarket" as const,
      startedAt: "2026-04-22T06:00:00.000Z",
      tradesSeen: 0,
      tradesWritten: 0,
    }));

    const result = await runWorkerCycle({
      executeMarketsBackfill,
      logger: createAppLogger({ test: "worker" }),
      now: () => new Date("2026-04-22T06:00:00.000Z"),
      syncPolymarket,
      syncPolymarketTrades,
    });

    expect(result.ok).toBe(true);
    expect(executeMarketsBackfill).toHaveBeenCalledOnce();
    expect(
      (
        getDatabase().prepare("SELECT status FROM admin_actions WHERE id = 1").get() as {
          status: string;
        }
      ).status,
    ).toBe("completed");
  });

  it("runs queued bet365 market backfills through the historical adapter path", async () => {
    upsertGame({
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
      scheduledStart: "2026-04-29T23:00:00.000Z",
      sourceGameKeyNba: "0022600001",
      sport: "basketball",
    });
    enqueueMarketBackfill({
      payloadJson: {
        dateFrom: "2026-04-29",
        dateTo: "2026-05-20",
        source: "bet365",
      },
      scope: "bet365",
    });

    const syncBet365Historical = vi.fn(async () => ({
      bookmaker: "Bet365" as const,
      eventsFetched: 5,
      finishedAt: "2026-04-22T06:00:00.000Z",
      gamesMatched: 3,
      marketsSeen: 10,
      ok: true as const,
      quoteObservationsWritten: 10,
      rawPayloadsWritten: 10,
      recordsSeen: 10,
      recordsWritten: 30,
      source: "bet365" as const,
      sourceMarketsObserved: 10,
      startedAt: "2026-04-22T06:00:00.000Z",
    }));

    const result = await runWorkerCycle({
      logger: createAppLogger({ test: "worker" }),
      now: () => new Date("2026-04-22T06:00:00.000Z"),
      syncBet365Historical,
      syncPolymarket: vi.fn(async () => ({
        finishedAt: "2026-04-22T06:00:00.000Z",
        gamesMatched: 0,
        marketsSeen: 0,
        ok: true as const,
        quoteObservationsWritten: 0,
        rawPayloadsWritten: 0,
        recordsSeen: 0,
        recordsWritten: 0,
        sourceMarketsObserved: 0,
        startedAt: "2026-04-22T06:00:00.000Z",
      })),
      syncPolymarketTrades: vi.fn(async () => ({
        errors: [],
        eventsFetched: 0,
        finishedAt: "2026-04-22T06:00:00.000Z",
        marketsScanned: 0,
        ok: true as const,
        source: "polymarket" as const,
        startedAt: "2026-04-22T06:00:00.000Z",
        tradesSeen: 0,
        tradesWritten: 0,
      })),
    });

    expect(result.ok).toBe(true);
    expect(syncBet365Historical).toHaveBeenCalledOnce();
    expect(syncBet365Historical).toHaveBeenCalledWith(
      expect.objectContaining({
        dateFrom: "2026-04-29",
        dateTo: "2026-05-20",
        maxEvents: 200,
      }),
    );
    expect(
      (
        getDatabase().prepare("SELECT status FROM admin_actions WHERE id = 1").get() as {
          status: string;
        }
      ).status,
    ).toBe("completed");
  });

  it("runs queued game-specific market backfills through scoped historical adapters", async () => {
    upsertGame({
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
    });
    enqueueMarketBackfill({
      payloadJson: {
        gameId: "nba-0022600001",
        source: "polymarket",
      },
      scope: "nba-0022600001",
    });

    const syncPolymarketHistorical = vi.fn(async () => ({
      eventsSeen: 0,
      finishedAt: "2026-04-22T06:00:00.000Z",
      gamesMatched: 0,
      marketsConsidered: 0,
      ok: true as const,
      pointsFetched: 0,
      rawPayloadsWritten: 0,
      startedAt: "2026-04-22T06:00:00.000Z",
      ticksWritten: 0,
    }));

    const result = await runWorkerCycle({
      logger: createAppLogger({ test: "worker" }),
      now: () => new Date("2026-04-22T06:00:00.000Z"),
      syncPolymarket: vi.fn(async () => ({
        finishedAt: "2026-04-22T06:00:00.000Z",
        gamesMatched: 0,
        marketsSeen: 0,
        ok: true as const,
        quoteObservationsWritten: 0,
        rawPayloadsWritten: 0,
        recordsSeen: 0,
        recordsWritten: 0,
        sourceMarketsObserved: 0,
        startedAt: "2026-04-22T06:00:00.000Z",
      })),
      syncPolymarketHistorical,
      syncPolymarketTrades: vi.fn(async () => ({
        errors: [],
        eventsFetched: 0,
        finishedAt: "2026-04-22T06:00:00.000Z",
        marketsScanned: 0,
        ok: true as const,
        source: "polymarket" as const,
        startedAt: "2026-04-22T06:00:00.000Z",
        tradesSeen: 0,
        tradesWritten: 0,
      })),
    });

    expect(result.ok).toBe(true);
    expect(syncPolymarketHistorical).toHaveBeenCalledOnce();
    expect(syncPolymarketHistorical).toHaveBeenCalledWith(
      expect.objectContaining({
        games: [
          expect.objectContaining({
            game: expect.objectContaining({ id: "nba-0022600001" }),
          }),
        ],
        since: "2026-04-22",
      }),
    );
  });

  it("filters queued date-window market backfills down to the requested games", async () => {
    upsertGame({
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
    });
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
      id: "nba-0022600002",
      league: "NBA",
      scheduledStart: "2026-04-25T02:00:00.000Z",
      sourceGameKeyNba: "0022600002",
      sport: "basketball",
    });
    enqueueMarketBackfill({
      payloadJson: {
        dateFrom: "2026-04-22",
        dateTo: "2026-04-22",
        source: "kalshi",
      },
      scope: "kalshi-window",
    });

    const syncKalshiHistorical = vi.fn(async () => ({
      candlesFetched: 0,
      eventsSeen: 0,
      finishedAt: "2026-04-22T06:00:00.000Z",
      gamesMatched: 0,
      marketErrors: [],
      marketsConsidered: 0,
      ok: true as const,
      rawPayloadsWritten: 0,
      startedAt: "2026-04-22T06:00:00.000Z",
      ticksWritten: 0,
    }));

    const result = await runWorkerCycle({
      logger: createAppLogger({ test: "worker" }),
      now: () => new Date("2026-04-22T06:00:00.000Z"),
      syncKalshiHistorical,
      syncPolymarket: vi.fn(async () => ({
        finishedAt: "2026-04-22T06:00:00.000Z",
        gamesMatched: 0,
        marketsSeen: 0,
        ok: true as const,
        quoteObservationsWritten: 0,
        rawPayloadsWritten: 0,
        recordsSeen: 0,
        recordsWritten: 0,
        sourceMarketsObserved: 0,
        startedAt: "2026-04-22T06:00:00.000Z",
      })),
      syncPolymarketTrades: vi.fn(async () => ({
        errors: [],
        eventsFetched: 0,
        finishedAt: "2026-04-22T06:00:00.000Z",
        marketsScanned: 0,
        ok: true as const,
        source: "polymarket" as const,
        startedAt: "2026-04-22T06:00:00.000Z",
        tradesSeen: 0,
        tradesWritten: 0,
      })),
    });

    expect(result.ok).toBe(true);
    expect(syncKalshiHistorical).toHaveBeenCalledOnce();
    expect(syncKalshiHistorical).toHaveBeenCalledWith(
      expect.objectContaining({
        games: [
          expect.objectContaining({
            game: expect.objectContaining({ id: "nba-0022600001" }),
          }),
        ],
        periodIntervalMinutes: KALSHI_NBA_HISTORICAL_PERIOD_INTERVAL_MINUTES,
      }),
    );
  });

  it("falls back to safe numeric env defaults before scheduling provider work", async () => {
    process.env.WORKER_INTERVAL_MS = "30s";
    process.env.WORKER_MAX_BACKOFF_MS = "0";
    process.env.POLYMARKET_TRADES_LOOKBACK_MINUTES = "soon";
    process.env.POLYMARKET_TRADES_MAX_MARKETS = "0";

    const syncPolymarket = vi.fn(async () => ({
      finishedAt: "2026-04-22T06:00:00.000Z",
      gamesMatched: 0,
      marketsSeen: 0,
      ok: true as const,
      quoteObservationsWritten: 0,
      rawPayloadsWritten: 0,
      recordsSeen: 0,
      recordsWritten: 0,
      sourceMarketsObserved: 0,
      startedAt: "2026-04-22T06:00:00.000Z",
    }));
    const syncPolymarketTrades = vi.fn(async () => ({
      errors: [],
      eventsFetched: 0,
      finishedAt: "2026-04-22T06:00:00.000Z",
      marketsScanned: 0,
      ok: true as const,
      source: "polymarket" as const,
      startedAt: "2026-04-22T06:00:00.000Z",
      tradesSeen: 0,
      tradesWritten: 0,
    }));

    const result = await runWorkerCycle({
      logger: createAppLogger({ test: "worker" }),
      now: () => new Date("2026-04-22T06:00:00.000Z"),
      syncPolymarket,
      syncPolymarketTrades,
    });

    expect(result.ok).toBe(true);
    expect(result.nextDelayMs).toBe(30_000);
    expect(syncPolymarketTrades).toHaveBeenCalledWith(
      expect.objectContaining({
        maxMarkets: 250,
        since: "2026-04-22T04:00:00.000Z",
        until: "2026-04-22T06:00:00.000Z",
      }),
    );
  });

  it("keeps backoff capped at the configured ceiling", () => {
    expect(calculateBackoffDelay(1_000, 0, 4_000)).toBe(1_000);
    expect(calculateBackoffDelay(1_000, 1, 4_000)).toBe(2_000);
    expect(calculateBackoffDelay(1_000, 3, 4_000)).toBe(4_000);
  });

  describe("research-export args mapping (pure)", () => {
    it("maps a full-corpus export to NO --sample (script default)", () => {
      expect(mapExportArgs({ request: { scope: "full" } })).toEqual([]);
    });

    it("maps scope=sample to --sample <n>", () => {
      expect(mapExportArgs({ request: { scope: "sample", sample: 30 } })).toEqual([
        "--sample",
        "30",
      ]);
    });

    it("maps snapshotId / since / until / gameIds to the exporter flags", () => {
      expect(
        mapExportArgs({
          request: {
            scope: "full",
            snapshotId: "snap-x",
            since: "2026-05-01",
            until: "2026-05-25",
            gameIds: ["nba-1", "nba-2"],
          },
        }),
      ).toEqual([
        "--snapshot-id",
        "snap-x",
        "--since",
        "2026-05-01",
        "--until",
        "2026-05-25",
        "--games",
        "nba-1,nba-2",
      ]);
    });

    it("reads args from the payload root when no nested request is present", () => {
      expect(mapExportArgs({ scope: "sample", sample: 5 })).toEqual(["--sample", "5"]);
    });
  });

  describe("research-export child-process executor (mocked spawn)", () => {
    it("spawns pnpm exec tsx with mapped args, repo cwd, and heap NODE_OPTIONS", async () => {
      const child = makeFakeChild();
      const spawnSpy = vi.fn<SpawnProcessFn>(() => {
        // Resolve on the next tick by emitting a clean close.
        queueMicrotask(() => child.emit("close", 0));
        return child as never;
      });

      await executeResearchExport({ request: { scope: "sample", sample: 7 } }, spawnSpy);

      expect(spawnSpy).toHaveBeenCalledOnce();
      const [command, args, options] = spawnSpy.mock.calls[0] ?? [];
      expect(command).toBe("pnpm");
      expect(args).toEqual(["exec", "tsx", "scripts/export-quant-snapshot.ts", "--sample", "7"]);
      expect(options?.cwd.endsWith("signal-console-integration")).toBe(true);
      expect(options?.env?.["NODE_OPTIONS"]).toBe("--max-old-space-size=10240");
    });

    it("rejects with a stderr tail on a nonzero exit", async () => {
      const child = makeFakeChild();
      const spawnSpy = vi.fn<SpawnProcessFn>(() => {
        queueMicrotask(() => {
          child.stderr.emit("data", "boom: export failed\n");
          child.emit("close", 2);
        });
        return child as never;
      });

      await expect(executeResearchExport({ request: { scope: "full" } }, spawnSpy)).rejects.toThrow(
        /boom: export failed/,
      );
    });
  });

  it("claims a queued research-export action and marks it completed via the injected executor", async () => {
    enqueueResearchExport({
      payloadJson: { jobId: "export-1", request: { scope: "full" } },
      requestedBy: "research-api",
      scope: "export-1",
    });

    const executeResearchExportSpy = vi.fn(async () => {});
    const syncPolymarket = vi.fn(async () => ({
      finishedAt: "2026-04-22T06:00:00.000Z",
      gamesMatched: 0,
      marketsSeen: 0,
      ok: true as const,
      quoteObservationsWritten: 0,
      rawPayloadsWritten: 0,
      recordsSeen: 0,
      recordsWritten: 0,
      sourceMarketsObserved: 0,
      startedAt: "2026-04-22T06:00:00.000Z",
    }));
    const syncPolymarketTrades = vi.fn(async () => ({
      errors: [],
      eventsFetched: 0,
      finishedAt: "2026-04-22T06:00:00.000Z",
      marketsScanned: 0,
      ok: true as const,
      source: "polymarket" as const,
      startedAt: "2026-04-22T06:00:00.000Z",
      tradesSeen: 0,
      tradesWritten: 0,
    }));

    const result = await runWorkerCycle({
      executeResearchExport: executeResearchExportSpy,
      logger: createAppLogger({ test: "worker" }),
      now: () => new Date("2026-04-22T06:00:00.000Z"),
      syncPolymarket,
      syncPolymarketTrades,
    });

    expect(result.ok).toBe(true);
    expect(executeResearchExportSpy).toHaveBeenCalledOnce();
    expect(executeResearchExportSpy).toHaveBeenCalledWith(
      expect.objectContaining({ request: expect.objectContaining({ scope: "full" }) }),
    );
    expect(
      (
        getDatabase().prepare("SELECT status FROM admin_actions WHERE id = 1").get() as {
          status: string;
        }
      ).status,
    ).toBe("completed");
  });

  it("marks a research-export action errored when the executor throws", async () => {
    enqueueResearchExport({
      payloadJson: { jobId: "export-2", request: { scope: "full" } },
      requestedBy: "research-api",
      scope: "export-2",
    });

    const executeResearchExportSpy = vi.fn(async () => {
      throw new Error("export-quant-snapshot.ts exited with code 2: boom");
    });

    const result = await runWorkerCycle({
      executeResearchExport: executeResearchExportSpy,
      logger: createAppLogger({ test: "worker" }),
      now: () => new Date("2026-04-22T06:00:00.000Z"),
      syncPolymarket: vi.fn(async () => ({
        finishedAt: "2026-04-22T06:00:00.000Z",
        gamesMatched: 0,
        marketsSeen: 0,
        ok: true as const,
        quoteObservationsWritten: 0,
        rawPayloadsWritten: 0,
        recordsSeen: 0,
        recordsWritten: 0,
        sourceMarketsObserved: 0,
        startedAt: "2026-04-22T06:00:00.000Z",
      })),
      syncPolymarketTrades: vi.fn(async () => ({
        errors: [],
        eventsFetched: 0,
        finishedAt: "2026-04-22T06:00:00.000Z",
        marketsScanned: 0,
        ok: true as const,
        source: "polymarket" as const,
        startedAt: "2026-04-22T06:00:00.000Z",
        tradesSeen: 0,
        tradesWritten: 0,
      })),
    });

    // The cycle itself stays ok (a single admin-action failure is isolated by
    // the drain loop's try/catch), but the action row is marked errored.
    expect(result.ok).toBe(true);
    expect(executeResearchExportSpy).toHaveBeenCalledOnce();
    expect(
      (
        getDatabase().prepare("SELECT status FROM admin_actions WHERE id = 1").get() as {
          status: string;
        }
      ).status,
    ).toBe("error");
  });
});
