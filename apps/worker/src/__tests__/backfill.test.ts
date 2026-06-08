import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const adapterMocks = vi.hoisted(() => ({
  syncBet365DirectLive: vi.fn(),
  syncBet365Historical: vi.fn(),
  syncBet365InternalDump: vi.fn(),
  syncKalshiNbaDirect: vi.fn(),
  syncKalshiNbaHistorical: vi.fn(),
  syncKalshiNbaTrades: vi.fn(),
  syncPolymarketNbaHistorical: vi.fn(),
  syncPolymarketNbaTrades: vi.fn(),
}));

const loggerMocks = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
}));

const sharedMocks = vi.hoisted(() => ({
  closeDatabase: vi.fn(),
  loadRuntimeEnv: vi.fn(),
  serializeErrorForLog: vi.fn((error: unknown) => ({
    message: error instanceof Error ? error.message : String(error),
  })),
}));

const nbaSidecarMocks = vi.hoisted(() => ({
  syncNbaSidecarWindow: vi.fn(),
}));

vi.mock("@signal-console/adapters", () => ({
  KALSHI_NBA_HISTORICAL_PERIOD_INTERVAL_MINUTES: 1,
  syncBet365DirectLive: adapterMocks.syncBet365DirectLive,
  syncBet365Historical: adapterMocks.syncBet365Historical,
  syncBet365InternalDump: adapterMocks.syncBet365InternalDump,
  syncKalshiNbaDirect: adapterMocks.syncKalshiNbaDirect,
  syncKalshiNbaHistorical: adapterMocks.syncKalshiNbaHistorical,
  syncKalshiNbaTrades: adapterMocks.syncKalshiNbaTrades,
  syncPolymarketNbaHistorical: adapterMocks.syncPolymarketNbaHistorical,
  syncPolymarketNbaTrades: adapterMocks.syncPolymarketNbaTrades,
}));

vi.mock("@signal-console/shared", () => ({
  closeDatabase: sharedMocks.closeDatabase,
  createAppLogger: () => loggerMocks,
  loadRuntimeEnv: sharedMocks.loadRuntimeEnv,
  serializeErrorForLog: sharedMocks.serializeErrorForLog,
}));

vi.mock("../nba-sidecar", () => ({
  syncNbaSidecarWindow: nbaSidecarMocks.syncNbaSidecarWindow,
}));

import { runBackfill } from "../backfill";

describe("backfill CLI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    adapterMocks.syncKalshiNbaDirect.mockResolvedValue({ ok: true });
    adapterMocks.syncKalshiNbaHistorical.mockResolvedValue({ ok: true });
    adapterMocks.syncPolymarketNbaHistorical.mockResolvedValue({ ok: true });
    adapterMocks.syncBet365Historical.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    process.exitCode = undefined;
  });

  it("continues the all-source NBA history repair after one source step fails", async () => {
    nbaSidecarMocks.syncNbaSidecarWindow.mockResolvedValue({
      dateErrors: [
        {
          date: "2026-05-24",
          error:
            "play-by-play 0042500314: NBA sidecar play-by-play request failed with status 424.",
        },
      ],
      ok: false,
    });

    await runBackfill([
      "nba-history",
      "--since",
      "2026-04-22",
      "--until",
      "2026-04-23",
      "--maxEvents",
      "7",
      "--maxTickers",
      "2",
    ]);

    expect(nbaSidecarMocks.syncNbaSidecarWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        captureMode: "historical",
        lookaheadDays: 0,
        lookbackDays: 1,
        skipFutureScheduledGames: false,
      }),
    );
    const sidecarOptions = nbaSidecarMocks.syncNbaSidecarWindow.mock.calls[0]?.[0] as
      | { now?: () => Date }
      | undefined;
    expect(sidecarOptions?.now?.().toISOString()).toBe("2026-04-23T12:00:00.000Z");
    expect(adapterMocks.syncKalshiNbaDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        maxEvents: 7,
        minimumStartDate: "2026-04-22",
      }),
    );
    expect(adapterMocks.syncKalshiNbaHistorical).toHaveBeenCalledWith({
      dateFrom: "2026-04-22",
      dateTo: "2026-04-23",
      maxEvents: 7,
      maxMarkets: 2,
      periodIntervalMinutes: 1,
    });
    expect(adapterMocks.syncPolymarketNbaHistorical).toHaveBeenCalledWith({
      fidelityMinutes: 1,
      maxEvents: 7,
      since: "2026-04-22",
    });
    expect(adapterMocks.syncBet365Historical).toHaveBeenCalledWith({
      dateFrom: "2026-04-22",
      dateTo: "2026-04-23",
      maxEvents: 7,
    });
    expect(loggerMocks.error).toHaveBeenCalledWith(
      expect.objectContaining({ label: "nba-sidecar" }),
      "NBA all-source historical backfill step failed.",
    );
    expect(process.exitCode).toBe(1);
  });

  it("keeps future scheduled-game PBP suppression for current-day NBA backfills", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-06T15:00:00.000Z"));
    nbaSidecarMocks.syncNbaSidecarWindow.mockResolvedValue({
      dateErrors: [],
      ok: true,
    });

    await runBackfill(["nba"]);

    expect(nbaSidecarMocks.syncNbaSidecarWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        captureMode: "historical",
        lookaheadDays: 0,
        lookbackDays: 30,
        playByPlayReferenceNow: expect.any(Function),
        skipFutureScheduledGames: true,
      }),
    );
    const sidecarOptions = nbaSidecarMocks.syncNbaSidecarWindow.mock.calls[0]?.[0] as
      | { playByPlayReferenceNow?: () => Date }
      | undefined;
    expect(sidecarOptions?.playByPlayReferenceNow?.().toISOString()).toBe(
      "2026-06-06T15:00:00.000Z",
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("keeps future scheduled-game PBP suppression for default nba-history through today", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-06T15:00:00.000Z"));
    nbaSidecarMocks.syncNbaSidecarWindow.mockResolvedValue({
      dateErrors: [],
      ok: true,
    });

    await runBackfill(["nba-history"]);

    expect(nbaSidecarMocks.syncNbaSidecarWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        captureMode: "historical",
        lookaheadDays: 0,
        playByPlayReferenceNow: expect.any(Function),
        skipFutureScheduledGames: true,
      }),
    );
    const sidecarOptions = nbaSidecarMocks.syncNbaSidecarWindow.mock.calls[0]?.[0] as
      | { now?: () => Date; playByPlayReferenceNow?: () => Date }
      | undefined;
    expect(sidecarOptions?.now?.().toISOString()).toBe("2026-06-06T12:00:00.000Z");
    expect(sidecarOptions?.playByPlayReferenceNow?.().toISOString()).toBe(
      "2026-06-06T15:00:00.000Z",
    );
    expect(process.exitCode).toBeUndefined();
  });
});
